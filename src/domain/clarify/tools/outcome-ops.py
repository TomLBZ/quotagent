#!/usr/bin/env python3
"""src/domain/clarify/tools/outcome-ops.py —— 「中标 / 落标 / PO」这四种**结果类**回话的唯一落账本者（DEF-022）。

**要解决的问题（逐条）**：全仓 `grep 落标` 零命中 —— "本次未中选"这个概念在代码里不存在，于是供应商侧
的中标/落标结果只能靠猜：中了看不到确认入口，没中则**默默消失**（29 §4「失败时给出可复制的下一步」被违反）。

本脚本提供四个动作（每个动作 = 界面上一个真能点的按钮）：

  · `declare-outcome`（**承包商侧**，人签）：「告知结果」——落 `award/lost`（本次未中选）或
    `po/notified`（PO 已签发），**并把结果写进投递信封** `<ui-shared>/exchange/award-outcomes.json`
    （`delivered_to` 含对方 realm ⇒ 供应商侧看得见）；落标正文只含**一句话 + 原因类别**，
    **不含**其它供应商的代号/报价/比价基准（规则 4 数据主权）。
  · `confirm-award`（**供应商侧**，人签）：「确认中标（并说明能否按期）」——`can_meet_due=false`
    时**备注必填**（避免"确认了又交不了货"）；落 `award/confirmed` + 承包商侧同名镜像 ⇒ 承包商侧的
    授标轨道 `supplier_confirmed` 才有据可依（`commitments.commit_award` 的硬前置）。
  · `confirm-po`（**供应商侧**，人签）：「确认收到 PO」——落 `po/confirmed` + 承包商侧镜像。
  · `ack-lost`（**供应商侧**，人签）：「知道了（落标）」——落 `award/lost-acknowledged`；
    承包商侧据此知道"告知已送达"，落标不再是一条单向通知。

纪律（与 `package-ops.py` / `quote-sign.py` 同规格）：宿主只落 **0600 待办件**（账本零新增）；
本脚本做权限门 → 形状门 → 重算校验 → 业务前置（对象真的在本视角可见）→ 落账 → 待办件进 `applied/`；
**拒绝时零写账本**；`--now` 必填；stdout 恰一行 JSON；退出码 0/1/2。
人签动作（`confirm-award`/`confirm-po`/`ack-lost`/`declare-outcome`）的发言人必须 `human:*`，`agent:*` 一律拒。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
MAX_FILE_BYTES = 262144

SCHEMA = "quotagent/pending/v1"
KIND = "outcome-ops"
ACTIONS = ("declare-outcome", "confirm-award", "confirm-po", "ack-lost")
OUTCOMES = ("lost", "po-issued")
REASON_CATEGORIES = ("price", "lead-time", "scope", "compliance", "terms", "other")
LOST_EVENT = "award/lost"
PO_NOTIFIED_EVENT = "po/notified"
CONFIRMED_EVENT = "award/confirmed"
PO_CONFIRMED_EVENT = "po/confirmed"
LOST_ACK_EVENT = "award/lost-acknowledged"
ARCHIVE_DIR = "applied"
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
HUMAN_ONLY = ("declare-outcome", "confirm-award", "confirm-po", "ack-lost")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def digest_of(text: object) -> str:
    return "sha256:" + hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def hex_of(text: object) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def canonical(record: dict) -> str:
    payload = {key: value for key, value in record.items() if key not in IGNORED_KEYS}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_rows(path: Path) -> tuple[list[dict] | None, str | None]:
    if not path.exists():
        return [], None
    rows: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            return None, f"{path}:{lineno} 不是合法 JSON：{exc}"
        if not isinstance(record, dict):
            return None, f"{path}:{lineno} 不是对象"
        rows.append(record)
    return rows, None


def realm_of(rows: list[dict], fallback: str) -> str:
    for row in rows:
        value = str(row.get("realm") or "").strip()
        if value:
            return value
    return fallback


def read_pending(path: Path) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（页面上的按钮会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "只接受宿主落的普通文件")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600",
                             "chmod 600 待办件再消费（宿主落盘时就是 0600）")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限 {MAX_FILE_BYTES}",
                             "把内容拆小后重提")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA:
        return None, refusal("pending-schema-unknown", f"schema 不是 {SCHEMA}", "让宿主按 schema 重落待办件")
    if record.get("kind") != KIND:
        return None, refusal("pending-kind-unknown", f"kind 不是 {KIND}：{record.get('kind')!r}",
                             "这份待办件不是「结果类回话」的载荷")
    action = str(record.get("action") or "")
    if action not in ACTIONS:
        return None, refusal("action-not-supported", f"action 必须是 {'/'.join(ACTIONS)} 之一：{action!r}",
                             "用界面上对应按钮落的待办件")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件（改了载荷要重算哈希）")
    note = str(record.get("note") or "")
    if norm_digest(str(record.get("note_sha256") or "")) != hex_of(note):
        return None, refusal("pending-tampered", "note_sha256 与重算的原话哈希不一致（自述不可信）",
                             "文件被改过或不是提交面写的：丢掉它、重新提交")
    size = record.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与备注正文长度不一致", "让宿主重落待办件")
    return record, None


def norm_digest(value: object) -> str:
    text = str(value or "")
    return text.split(":", 1)[1] if text.startswith("sha256:") else text


def archive(inbox: Path, path: Path) -> Path:
    target_dir = inbox / ARCHIVE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(target_dir, 0o700)
    except OSError:
        pass
    stem = path.name[: -len(".json")]
    target = target_dir / path.name
    index = 1
    while target.exists():
        target = target_dir / f"{stem}.{index}.json"
        index += 1
    shutil.move(str(path), str(target))
    return target


# ---------------------------------------------------------------------------
# 投递信封（结果告知的通道；**只读**读取、**追加式**写入，均在 <ui-shared>/exchange/）
# ---------------------------------------------------------------------------
def read_envelope(path: Path) -> list[dict]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict) and isinstance(raw.get("outcomes"), list):
        return [item for item in raw["outcomes"] if isinstance(item, dict)]
    return []


def append_envelope(path: Path, entry: dict) -> tuple[bool, str]:
    """追加一条结果告知（**幂等**：同 (outcome_id) 已存在则不重复写）。"""
    items = read_envelope(path)
    if any(str(item.get("outcome_id")) == str(entry.get("outcome_id")) for item in items):
        return True, "duplicate"
    items.append(entry)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError as exc:
        return False, str(exc)[:200]
    return True, "written"


def winner_index(envelopes: list[dict], realm: str) -> dict[str, dict]:
    """投递给**我的**授标意向：`attempt_own_quote` 之外再按"报价归我"判定（见 `confirm-award`）。"""
    out: dict[str, dict] = {}
    for envelope in envelopes:
        intent_id = str(envelope.get("intent_id") or "")
        if REF_RE.match(intent_id):
            out[intent_id] = envelope
    return out


def own_quotes(rows: list[dict]) -> set[str]:
    """我**自己提交过**的报价 id（本侧 `quote/submitted` 事实）——判定"这份意向是不是冲我来的"。"""
    out: set[str] = set()
    for row in rows:
        if str(row.get("type") or "") != "quote/submitted":
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        quote_id = str(body.get("quote_id") or "")
        if REF_RE.match(quote_id):
            out.add(quote_id)
    return out



def outcome_index(envelopes: list[dict], realm: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for envelope in envelopes:
        delivered = [str(item) for item in (envelope.get("delivered_to") or [])]
        if delivered and realm and realm not in delivered:
            continue
        outcome_id = str(envelope.get("outcome_id") or "")
        if REF_RE.match(outcome_id):
            out[outcome_id] = envelope
    return out


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="outcome-ops", add_help=False,
                                     description="中标/落标/PO 结果类待办件的唯一落账本者")
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--action", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--view", default="")
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--intent-out", default="", help="授标意向信封（默认 <ui-shared>/exchange/award-intents.json）")
    parser.add_argument("--outcome-out", default="", help="结果告知信封（默认 <ui-shared>/exchange/award-outcomes.json）")
    parser.add_argument("--now", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = _parser()
    try:
        args, unknown = parser.parse_known_args(argv)
    except SystemExit:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [refusal("usage", "参数无法解析", "见 --help")]}, 2)
    if unknown:
        return usage_error("usage-unknown-flag", f"不认识的参数：{unknown}", "去掉不认识的参数后重试")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601",
                           "显式给时间：--now 2026-09-22T10:00:00Z（本脚本不读墙钟）")
    if args.action and args.action not in ACTIONS:
        return usage_error("usage-action", f"--action 只能是 {'/'.join(ACTIONS)}：{args.action}",
                           "用界面上对应按钮落的待办件")
    if not args.request and not args.inbox:
        return usage_error("usage-request", "既没有 --request 也没有 --inbox", "给一条待办件路径或一个目录")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.request).parent if args.request else Path(args.inbox)
    ledger_contractor = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    ledger_supplier = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    intent_path = Path(args.intent_out) if args.intent_out else ui_shared / "exchange" / "award-intents.json"
    outcome_path = Path(args.outcome_out) if args.outcome_out else ui_shared / "exchange" / "award-outcomes.json"

    contractor_rows, error_c = load_rows(ledger_contractor)
    supplier_rows, error_s = load_rows(ledger_supplier)
    if error_c is not None or error_s is not None:
        return usage_error("ledger-unreadable", error_c or error_s, "先修账本（本脚本不往坏账本追加）")
    assert contractor_rows is not None and supplier_rows is not None
    views = {"contractor": (ledger_contractor, contractor_rows), "supplier": (ledger_supplier, supplier_rows)}
    intents = winner_index(read_envelope(intent_path), realm_of(supplier_rows, ""))
    outcomes = outcome_index(read_envelope(outcome_path), realm_of(supplier_rows, ""))
    my_quotes = own_quotes(supplier_rows)

    pending: list[Path] = [Path(args.request)] if args.request \
        else [item for item in sorted(inbox.glob("*.json")) if item.is_file()]

    refused: list[dict] = []
    applied: list[dict] = []
    duplicates: list[dict] = []
    ledger_added = 0
    for path in pending:
        record, problem = read_pending(path)
        if problem is not None:
            problem.update({"file": path.name})
            refused.append(problem)
            continue
        assert record is not None
        action = str(record.get("action") or "")
        if args.action and action != args.action:
            continue
        view = str(record.get("view") or "")
        if view not in views:
            refused.append(refusal("view-unknown", f"view={view!r} 不是已知视角",
                                   "重提一次（视角名由页面提交）") | {"file": path.name})
            continue
        if args.view and view != args.view:
            continue
        speaker = str(record.get("actor") or args.actor or "").strip()
        if action in HUMAN_ONLY and not HUMAN_RE.match(speaker):
            refused.append(refusal("human-required",
                                   f"{action} 是人的动作：署名必须以 human: 开头（收到 {speaker!r}）",
                                   "agent 不得代人答复结果：写 human:<你的名字>") | {"file": path.name})
            continue
        note = str(record.get("note") or "")
        ledger_path, ledger_rows = views[view]
        mirror_view = "supplier" if view == "contractor" else "contractor"
        mirror_path, mirror_rows = views[mirror_view]
        my_realm = realm_of(ledger_rows, f"{view}:unknown")
        mirror_realm = realm_of(mirror_rows, f"{mirror_view}:outcome-ops")

        if action == "declare-outcome":
            kind = str(record.get("outcome_kind") or "")
            package_id = str(record.get("package_id") or "").strip()
            supplier = str(record.get("supplier") or "").strip()
            if kind not in OUTCOMES:
                refused.append(refusal("outcome-kind-unknown", f"outcome_kind 必须是 {'/'.join(OUTCOMES)}：{kind!r}",
                                       "落标用 lost、PO 已签发用 po-issued") | {"file": path.name})
                continue
            if not REF_RE.match(package_id) or not REF_RE.match(supplier):
                refused.append(refusal("package-or-supplier-malformed",
                                       f"package_id={package_id!r} / supplier={supplier!r} 形状非法",
                                       "包与对象都要给：告知必须指名道姓") | {"file": path.name})
                continue
            reason = str(record.get("reason_category") or "")
            if kind == "lost":
                if reason not in REASON_CATEGORIES:
                    refused.append(refusal("reason-category-unknown",
                                           f"落标原因类别必须是 {list(REASON_CATEGORIES)} 之一：{reason!r}",
                                           "给一个原因类别（不含其它供应商的报价信息）") | {"file": path.name})
                    continue
                if not note.strip():
                    refused.append(refusal("notice-required", "落标告知必须有一句话（不能只给类别）",
                                           "写清一句话：例如「本次未中选：价格超出预算」") | {"file": path.name})
                    continue
            po_id = str(record.get("po_id") or "").strip()
            award_id = str(record.get("award_id") or "").strip()
            if kind == "po-issued" and not REF_RE.match(po_id):
                refused.append(refusal("po-id-malformed", f"po-issued 必须给 po_id：{po_id!r}",
                                       "从承包商侧的 PO 列表里取 po_id") | {"file": path.name})
                continue
            outcome_id = f"out-{note_short(package_id, supplier, kind)}"
            event = LOST_EVENT if kind == "lost" else PO_NOTIFIED_EVENT
            key = (view, outcome_id)
            already = any(str((row.get("body") or {}).get("outcome_id")) == outcome_id
                          for row in ledger_rows if row.get("type") == event)
            if already:
                duplicates.append({"file": path.name, "action": action, "outcome_id": outcome_id,
                                   "reason": "already-declared"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            body = {"outcome_id": outcome_id, "kind": kind, "package_id": package_id, "supplier": supplier,
                    "reason_category": reason or None, "notice_sha256": digest_of(note), "ok": True,
                    "view": view, "at": args.now}
            envelope = {"outcome_id": outcome_id, "kind": kind, "package_id": package_id, "supplier": supplier,
                        "reason_category": reason or None, "notice": note, "delivered_to": [supplier],
                        "declared_by": speaker, "at": args.now}
            if kind == "po-issued":
                envelope.update({"po_id": po_id, "award_id": award_id or None})
            written, detail = (True, "dry-run")
            if not args.dry_run:
                written, detail = append_envelope(outcome_path, envelope)
                if not written:
                    return usage_error("envelope-write-failed", detail,
                                       "先修 exchange 目录权限（结果告知必须留痕：写不了就不落账）")
                try:
                    Ledger(ledger_path, realm=my_realm).append(event, body, correlation_id=package_id,
                                                               actor=speaker, ts=args.now, event_class="commitment",
                                                               refs={"package_id": package_id})
                    # 供应商侧同名登记：**明确告知**（不是默默消失）；不含其它供应商信息
                    Ledger(mirror_path, realm=mirror_realm).append(
                        event, {**body, "view": mirror_view, "supplier": supplier}, correlation_id=package_id,
                        actor=speaker, ts=args.now, event_class="fact", refs={"package_id": package_id})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200],
                                       "先修账本（本脚本不往校验不过的账本追加任何行）")
                ledger_added += 2
            applied.append({"file": path.name, "action": action, "event": event, "outcome_id": outcome_id,
                            "kind": kind, "package_id": package_id, "supplier": supplier,
                            "envelope": str(outcome_path), "envelope_status": detail, "notified": mirror_view})
        elif action in ("confirm-award", "ack-lost"):
            award_id = str(record.get("award_id") or "").strip()
            intent_id = str(record.get("intent_id") or "").strip()
            outcome_id = str(record.get("outcome_id") or "").strip()
            if action == "confirm-award":
                if outcome_id and not intent_id:
                    refused.append(refusal("outcome-is-not-award",
                                           f"{outcome_id} 是落标告知（kind={outcomes.get(outcome_id, {}).get('kind')}），"
                                           "不能用「确认中标」回应；落标要问的是『我知道了』",
                                           "落标用 ack-lost（按钮：「我知道了」）") | {"file": path.name})
                    continue
                if not intent_id or intent_id not in intents:
                    seen = sorted(intents)[:6]
                    refused.append(refusal("award-not-found",
                                           f"授标意向 {intent_id or '（空）'} 不在发给我的意向信封里（已读到 {seen or '（无）'}）",
                                           "等承包商提出授标意向（意向不产生义务），或核对投递名单") | {"file": path.name})
                    continue
                intent = intents[intent_id]
                intent_quote = str(intent.get("quote_id") or "")
                delivered = [str(item) for item in (intent.get("delivered_to") or [])]
                if intent_quote not in my_quotes:
                    refused.append(refusal("award-not-mine",
                                           f"意向 {intent_id} 引用报价 {intent_quote or '（空）'}，"
                                           f"而这份报价**不在我提交过的报价**里（我提交过 {sorted(my_quotes)[:6] or '（无）'}）",
                                           "只能确认自己报价那份意向（别人的意向不出、也不给你确认）")
                               | {"file": path.name})
                    continue
                delivered_to_me = bool(delivered) and bool(my_realm) and my_realm in delivered
                can_meet_due = record.get("can_meet_due")
                if not isinstance(can_meet_due, bool):
                    refused.append(refusal("can-meet-due-required",
                                           f"can_meet_due 必须是 true/false（收到 {can_meet_due!r}）："
                                           "确认中标必须声明能否按期",
                                           "勾选能否按期后重提") | {"file": path.name})
                    continue
                if can_meet_due is False and not note.strip():
                    refused.append(refusal("note-required-when-cannot-meet-due",
                                           "can_meet_due=false 时必须给备注（避免『确认了又交不了货』）",
                                           "写一句为什么交不了、最早能什么时候交") | {"file": path.name})
                    continue
                award_id = award_id or intent_id
                key = (view, award_id)
                done = any(str((row.get("body") or {}).get("award_id")) == award_id
                           and str((row.get("body") or {}).get("view")) == view for row in ledger_rows
                           if str(row.get("type")) == CONFIRMED_EVENT)
                if done:
                    duplicates.append({"file": path.name, "action": action, "award_id": award_id,
                                       "reason": "already-confirmed"})
                    if not args.dry_run:
                        archive(inbox, path)
                    continue
                body = {"award_id": award_id, "intent_id": intent_id,
                        "package_id": str(intent.get("package_id") or ""), "quote_id": str(intent.get("quote_id") or ""),
                        "supplier": my_realm, "confirmed_by": speaker, "can_meet_due": can_meet_due,
                        "note_sha256": digest_of(note), "confirmed_at": args.now, "ok": True, "view": view,
                        "delivered_to_me": delivered_to_me}
                if not args.dry_run:
                    try:
                        Ledger(ledger_path, realm=my_realm).append(CONFIRMED_EVENT, body, correlation_id=award_id,
                                                                   actor=speaker, ts=args.now, event_class="fact",
                                                                   refs={"package_id": body["package_id"]})
                        Ledger(mirror_path, realm=mirror_realm).append(
                            CONFIRMED_EVENT, {**body, "view": mirror_view}, correlation_id=award_id,
                            actor=speaker, ts=args.now, event_class="fact",
                            refs={"package_id": body["package_id"]})
                    except LedgerError as exc:
                        return usage_error("ledger-frozen", str(exc)[0:200],
                                           "先修账本（本脚本不往校验不过的账本追加任何行）")
                    ledger_added += 2
                applied.append({"file": path.name, "action": action, "event": CONFIRMED_EVENT,
                                "award_id": award_id, "intent_id": intent_id, "can_meet_due": can_meet_due,
                                "notified": mirror_view})
            else:
                if not outcome_id or outcome_id not in outcomes:
                    seen = sorted(outcomes)[:6]
                    refused.append(refusal("outcome-not-found",
                                           f"结果告知 {outcome_id or '（空）'} 不在发给我的结果信封里（已读到 {seen or '（无）'}）",
                                           "等承包商在 APP 里「告知结果」（落标必须有明确告知）") | {"file": path.name})
                    continue
                if str(outcomes[outcome_id].get("kind")) != "lost":
                    refused.append(refusal("outcome-kind-mismatch",
                                           f"{outcome_id} 的类别是 {outcomes[outcome_id].get('kind')}，"
                                           "「我知道了（落标）」只针对落标告知",
                                           "PO 类结果请用「确认收到 PO」") | {"file": path.name})
                    continue
                done = any(str((row.get("body") or {}).get("outcome_id")) == outcome_id
                           and str((row.get("body") or {}).get("view")) == view for row in ledger_rows
                           if str(row.get("type")) == LOST_ACK_EVENT)
                if done:
                    duplicates.append({"file": path.name, "action": action, "outcome_id": outcome_id,
                                       "reason": "already-acknowledged"})
                    if not args.dry_run:
                        archive(inbox, path)
                    continue
                body = {"outcome_id": outcome_id, "package_id": str(outcomes[outcome_id].get("package_id") or ""),
                        "supplier": my_realm, "acknowledged_by": speaker, "acknowledged_at": args.now,
                        "ok": True, "view": view}
                if not args.dry_run:
                    try:
                        Ledger(ledger_path, realm=my_realm).append(LOST_ACK_EVENT, body, correlation_id=outcome_id,
                                                                   actor=speaker, ts=args.now, event_class="fact",
                                                                   refs={"package_id": body["package_id"]})
                        Ledger(mirror_path, realm=mirror_realm).append(
                            LOST_ACK_EVENT, {**body, "view": mirror_view}, correlation_id=outcome_id,
                            actor=speaker, ts=args.now, event_class="fact",
                            refs={"package_id": body["package_id"]})
                    except LedgerError as exc:
                        return usage_error("ledger-frozen", str(exc)[0:200],
                                           "先修账本（本脚本不往校验不过的账本追加任何行）")
                    ledger_added += 2
                applied.append({"file": path.name, "action": action, "event": LOST_ACK_EVENT,
                                "outcome_id": outcome_id, "notified": mirror_view})
        else:  # confirm-po
            po_id = str(record.get("po_id") or "").strip()
            if not REF_RE.match(po_id):
                refused.append(refusal("po-id-malformed", f"po_id 缺或形状非法：{po_id!r}",
                                       "从「我的 PO」表里复制 po_id") | {"file": path.name})
                continue
            visible = [item for item in outcomes.values()
                       if str(item.get("kind")) == "po-issued" and str(item.get("po_id")) == po_id]
            if not visible:
                seen = sorted({str(item.get("po_id")) for item in outcomes.values() if item.get("po_id")})[:6]
                refused.append(refusal("po-not-found",
                                       f"PO {po_id} 不在发给我的结果信封里（已读到 {seen or '（无）'}）",
                                       "等承包商在 APP 里「告知结果（PO 已签发）」，或核对 po_id") | {"file": path.name})
                continue
            done = any(str((row.get("body") or {}).get("po_id")) == po_id
                       and str((row.get("body") or {}).get("view")) == view for row in ledger_rows
                       if str(row.get("type")) == PO_CONFIRMED_EVENT)
            if done:
                duplicates.append({"file": path.name, "action": action, "po_id": po_id, "reason": "already-confirmed"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            item = visible[0]
            body = {"po_id": po_id, "award_id": item.get("award_id") or "", "package_id": item.get("package_id") or "",
                    "supplier": my_realm, "confirmed_by": speaker, "note_sha256": digest_of(note),
                    "confirmed_at": args.now, "ok": True, "view": view}
            if not args.dry_run:
                try:
                    Ledger(ledger_path, realm=my_realm).append(PO_CONFIRMED_EVENT, body, correlation_id=po_id,
                                                               actor=speaker, ts=args.now, event_class="fact",
                                                               refs={"package_id": str(body["package_id"])})
                    Ledger(mirror_path, realm=mirror_realm).append(
                        PO_CONFIRMED_EVENT, {**body, "view": mirror_view}, correlation_id=po_id,
                        actor=speaker, ts=args.now, event_class="fact",
                        refs={"package_id": str(body["package_id"])})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200],
                                       "先修账本（本脚本不往校验不过的账本追加任何行）")
                ledger_added += 2
            applied.append({"file": path.name, "action": action, "event": PO_CONFIRMED_EVENT, "po_id": po_id,
                            "notified": mirror_view})
        if not args.dry_run:
            archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件", "先在页面上点一次动作")
    return emit({"ok": not refused, "event": "outcome-ops", "now": args.now, "applied": applied,
                 "duplicates": duplicates, "ledger_added": ledger_added, "refused": refused,
                 "inbox": str(inbox), "outcome_envelope": str(outcome_path),
                 "note": "落标落 award/lost 并写结果信封（明确告知，不默默消失）；中标确认落 award/confirmed 且"
                         "can_meet_due=false 时要求备注；PO 确认落 po/confirmed；每种都在对方账本留一条同名登记",
                 }, 1 if refused else 0)


def note_short(package_id: str, supplier: str, kind: str) -> str:
    return hashlib.sha256(f"{package_id}|{supplier}|{kind}".encode("utf-8")).hexdigest()[:12]


if __name__ == "__main__":
    raise SystemExit(main())
