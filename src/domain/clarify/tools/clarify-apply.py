#!/usr/bin/env python3
"""src/domain/clarify/tools/clarify-apply.py —— 「澄清工单：提问 / 作答」的**唯一落账本者**（DEF-015 / DEF-014 的写面一半）。

要解决的问题（逐条）：
  · DEF-015（P1）：供应商**看得到历史、问不出去**（`POST /supplier/clarifications/ask` 404）。本写者把
    「提问」变成真事实：`clarification/asked` 落**供应商账本**（我自己的工单），并在**承包商账本**留一条
    同名登记（`view=contractor` + `awaiting_answer`）⇒ 承包商侧的「待你回答」队列有据可依（双向可断言）。
  · DEF-014（P1，承包商侧那一页根本不存在）：作答也走同一个写者 —— `answer` 落承包商账本
    `clarification/answered` 并镜像到供应商账本 ⇒ 供应商侧**看得到答复正文**（"问答串"是双向的一条）。

业务规则**不在这里重写**：本脚本调用**既有服务** `ClarificationService`（`src/domain/clarify/code/clarify.py`）：
  · 缺 `rfq_rev` 或缺条目引用 ⇒ `ask` 拒绝（FR-CLARIFY-001）；
  · 作答者必须 `human:*`（解答责任在人）；
  · 工单状态来自**账本重放**（服务实例是无状态的，事实只在 append-only 账本里）——本脚本按账本重建工单后
    再调 `answer()`，所以"同一工单答两次"这类状态判断与账本一致，不会靠内存里的偶然状态。

宿主只落 **0600 待办件**（`<ui-shared>/clarify-apply/`，账本零新增）；本脚本：权限门 → 形状门 → 重算校验 →
业务前置（包/条目/工单必须在**本视角可见**）→ 调既有服务落账 → 镜像到对方账本 → 待办件进 `applied/`。
拒绝一律 `code` + `next_action`，且**引用/字段检查在调用服务之前完成 ⇒ 拒绝时账本零新增**。
`--now` 必填（不读墙钟）；stdout 恰一行 JSON；退出码 0/1/2。
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
from quotagent.services.clarify import ClarificationService, ClarifyError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
MAX_FILE_BYTES = 262144
QUESTION_MAX = 500
PACKAGE_EVENTS = ("rfq/published", "rfq/distributed", "rfq/amended")

SCHEMA = "quotagent/pending/v1"
KIND = "clarify-apply"
ACTIONS = ("ask", "answer")
ASKED_EVENT = "clarification/asked"
ANSWERED_EVENT = "clarification/answered"
REOPENED_EVENT = "clarification/reopened"
ARCHIVE_DIR = "applied"
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def hex_of(text: object) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def digest_of(text: object) -> str:
    return "sha256:" + hex_of(text)


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
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限 {MAX_FILE_BYTES}", "拆小后重提")
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
                             "这份待办件不是「澄清工单」的载荷")
    if str(record.get("action") or "") not in ACTIONS:
        return None, refusal("action-not-supported", f"action 必须是 {'/'.join(ACTIONS)} 之一",
                             "提问用 ask、作答用 answer（广播/关闭不在本脚本能力面里）")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件（改了载荷要重算哈希）")
    note = str(record.get("note") or "")
    if str(record.get("note_sha256") or "").split(":", 1)[-1] != hex_of(note):
        return None, refusal("pending-tampered", "note_sha256 与重算的原话哈希不一致（自述不可信）",
                             "文件被改过或不是提交面写的：丢掉它、重新提交")
    size = record.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与备注正文长度不一致", "让宿主重落待办件")
    return record, None


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
# 包 / 条目 / 工单：一律**从账本读**（判定权在账本，不在请求体）
# ---------------------------------------------------------------------------
def package_index(rows: list[dict]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for row in rows:
        kind = str(row.get("type") or "")
        if kind not in PACKAGE_EVENTS:
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        refs = row.get("refs") if isinstance(row.get("refs"), dict) else {}
        package_id = str(body.get("package_id") or refs.get("package_id") or row.get("correlation_id") or "")
        if not REF_RE.match(package_id):
            continue
        entry = index.setdefault(package_id, {"revs": set(), "items": {}})
        rev = body.get("rev", refs.get("rfq_rev"))
        if isinstance(rev, int):
            entry["revs"].add(rev)
        for item in body.get("items") or []:
            if isinstance(item, dict) and str(item.get("item_id") or ""):
                entry["items"][str(item["item_id"])] = item
        spec = body.get("spec") if isinstance(body.get("spec"), dict) else {}
        for item in spec.get("items") or []:
            if isinstance(item, dict) and str(item.get("item_id") or ""):
                entry["items"][str(item["item_id"])] = item
    return index


def envelope_index(target: str, realm: str) -> dict[str, dict]:
    if not str(target or "").strip():
        return {}
    base = Path(target)
    files = sorted(base.glob("*.json")) if base.is_dir() else ([base] if base.is_file() else [])
    index: dict[str, dict] = {}
    for path in files:
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(envelope, dict):
            continue
        spec = envelope.get("spec") if isinstance(envelope.get("spec"), dict) else {}
        package_id = str(spec.get("package_id") or "")
        if not REF_RE.match(package_id):
            continue
        delivered = [str(item) for item in (envelope.get("delivered_to") or [])]
        if delivered and realm and realm not in delivered:
            continue
        entry = index.setdefault(package_id, {"revs": set(), "items": {}})
        if isinstance(envelope.get("rev"), int):
            entry["revs"].add(envelope["rev"])
        for item in spec.get("items") or []:
            if isinstance(item, dict) and str(item.get("item_id") or ""):
                entry["items"][str(item["item_id"])] = item
    return index


def package_visible(package_id: str, rows: list[dict], delivery: str, realm: str) -> dict | None:
    for source in (package_index(rows), envelope_index(delivery, realm)):
        if package_id in source:
            return source[package_id]
    return None


def tickets_from_ledger(rows: list[dict]) -> dict[str, dict]:
    """按账本重放工单状态（服务实例无状态；事实只在账本里）。"""
    tickets: dict[str, dict] = {}
    for row in rows:
        kind = str(row.get("type") or "")
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        ticket_id = str(body.get("ticket_id") or "")
        if not ticket_id:
            continue
        if kind == ASKED_EVENT:
            entry = tickets.setdefault(ticket_id, {"ticket_id": ticket_id, "package_id": body.get("package_id"),
                                                   "rfq_rev": body.get("rfq_rev"), "refs": body.get("refs") or {},
                                                   "question": body.get("question") or "",
                                                   "asker_realm": body.get("asker_realm"),
                                                   "status": "open", "answer": None, "broadcast": None,
                                                   "reopened": [], "created_at": row.get("ts")})
            if str(body.get("status") or "") == "closed":
                entry["status"] = "closed"
        elif kind == ANSWERED_EVENT:
            entry = tickets.setdefault(ticket_id, {"ticket_id": ticket_id, "package_id": body.get("package_id"),
                                                   "rfq_rev": body.get("rfq_rev"), "refs": {}, "question": "",
                                                   "asker_realm": None, "status": "open", "answer": None,
                                                   "broadcast": None, "reopened": [], "created_at": row.get("ts")})
            if body.get("by"):
                entry["status"] = "answered"
                entry["answer"] = {"text": body.get("text"), "by": body.get("by"), "at": row.get("ts"),
                                   "rfq_rev": body.get("rfq_rev"), "stale": False}
        elif kind == REOPENED_EVENT:
            entry = tickets.setdefault(ticket_id, {"ticket_id": ticket_id, "package_id": body.get("package_id"),
                                                   "rfq_rev": body.get("to_rev"), "refs": {}, "question": "",
                                                   "asker_realm": None, "status": "open", "answer": None,
                                                   "broadcast": None, "reopened": [], "created_at": row.get("ts")})
            entry["status"] = "open"
    return tickets


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clarify-apply", add_help=False,
                                     description="澄清工单（提问/作答）待办件的唯一落账本者")
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--action", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--delivery", default="", help="投递信封（文件或目录；与首页同一个源）")
    parser.add_argument("--now", default="")
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
        return usage_error("usage-action", f"--action 只能是 {'/'.join(ACTIONS)}：{args.action}", "ask 或 answer")
    if not args.request and not args.inbox:
        return usage_error("usage-request", "既没有 --request 也没有 --inbox", "给一条待办件路径或一个目录")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.request).parent if args.request else Path(args.inbox)
    ledger_contractor = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    ledger_supplier = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"

    contractor_rows, error_c = load_rows(ledger_contractor)
    supplier_rows, error_s = load_rows(ledger_supplier)
    if error_c is not None or error_s is not None:
        return usage_error("ledger-unreadable", error_c or error_s, "先修账本（本脚本不往坏账本追加）")
    assert contractor_rows is not None and supplier_rows is not None
    views = {"contractor": (ledger_contractor, contractor_rows), "supplier": (ledger_supplier, supplier_rows)}

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
            refused.append(refusal("view-unknown", f"view={view!r} 不是已知视角", "重提一次（视角名由页面提交）")
                           | {"file": path.name})
            continue
        ledger_path, ledger_rows = views[view]
        mirror_view = "supplier" if view == "contractor" else "contractor"
        mirror_path, mirror_rows = views[mirror_view]
        my_realm = realm_of(ledger_rows, f"{view}:unknown")
        mirror_realm = realm_of(mirror_rows, f"{mirror_view}:clarify-apply")

        if action == "ask":
            if view != "supplier":
                refused.append(refusal("ask-is-supplier-action",
                                       f"提问是**供应商侧**的动作（收到 view={view!r}）",
                                       "承包商侧的对应动作是作答（answer）") | {"file": path.name})
                continue
            package_id = str(record.get("package_id") or "").strip()
            rfq_rev = record.get("rfq_rev")
            raw_refs = record.get("item_ids")
            item_ids = [str(item).strip() for item in raw_refs if str(item).strip()] \
                if isinstance(raw_refs, list) else []
            question = str(record.get("question") or "").strip()
            if not REF_RE.match(package_id):
                refused.append(refusal("package-id-malformed", f"package_id 缺或形状非法：{package_id!r}",
                                       "重提一次：包 id 由页面从**本视角可见的包**里取") | {"file": path.name})
                continue
            visible = package_visible(package_id, ledger_rows, args.delivery, my_realm)
            if visible is None:
                seen = sorted(package_index(ledger_rows))[:8]
                refused.append(refusal("rfq-not-found",
                                       f"包 {package_id} 不在本视角可见范围里（本人账本的 rfq/* 事实 ∪ 投递信封"
                                       f"{args.delivery or '（未配置）'}）；已读到：{seen or '（无）'}",
                                       "刷新页面重读；提工单必须针对**我收到的那个包**") | {"file": path.name})
                continue
            if isinstance(rfq_rev, bool) or not isinstance(rfq_rev, int) or rfq_rev < 1:
                refused.append(refusal("rev-required",
                                       f"缺 rfq_rev（收到 {rfq_rev!r}）：工单必须绑定包版本（FR-CLARIFY-001）",
                                       "填上你提问时看到的版本号（页面表格里有）") | {"file": path.name})
                continue
            known = sorted(visible.get("revs") or set())
            if known and rfq_rev not in known:
                refused.append(refusal("rev-out-of-range", f"rfq_rev={rfq_rev} 不在已知版本 {known}（不猜、不夹取）",
                                       f"按页面上的版本号重填（当前已知：{known}）") | {"file": path.name})
                continue
            if not item_ids:
                refused.append(refusal("clarify-ref-missing",
                                       "缺条目引用 item_ids：无引用的工单不得建立（FR-CLARIFY-001）",
                                       "在页面上勾选至少一条行项目（可多选）") | {"file": path.name})
                continue
            bad = [item for item in item_ids if not ITEM_RE.match(item)]
            if bad:
                refused.append(refusal("item-id-malformed", f"条目引用形状非法：{bad}",
                                       "行项目 id 由页面从**本视角行项目**里取") | {"file": path.name})
                continue
            catalogue = visible.get("items") or {}
            unknown_items = [item for item in item_ids if catalogue and item not in catalogue]
            if unknown_items:
                refused.append(refusal("item-not-found",
                                       f"条目 {unknown_items} 不在本视角可见的行项目里（已读到 "
                                       f"{sorted(catalogue)[:8]}）",
                                       "只对包里的条目提问（页面的行项目表格上勾选）") | {"file": path.name})
                continue
            if question == "":
                refused.append(refusal("question-required", "问题为空", "写清要问什么（≤500 字）") | {"file": path.name})
                continue
            if len(question) > QUESTION_MAX:
                refused.append(refusal("question-too-long", f"问题 {len(question)} 字超过上限 {QUESTION_MAX}",
                                       "本脚本**不截断**（截断会合成另一句话）：请重提一份更短的问题")
                               | {"file": path.name})
                continue
            ticket_id = "cl-" + hex_of(f"{view}|{package_id}|{rfq_rev}|{question}")[:12]
            existing = {str((row.get("body") or {}).get("ticket_id")) for row in ledger_rows
                        if row.get("type") == ASKED_EVENT and str((row.get("body") or {}).get("ticket_id"))}
            if ticket_id in existing:
                duplicates.append({"file": path.name, "action": action, "ticket_id": ticket_id,
                                   "reason": "already-asked"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            if not args.dry_run:
                try:
                    service = ClarificationService(participant=my_realm, realm=my_realm,
                                                   ledger=Ledger(ledger_path, realm=my_realm), events=None)
                    ticket = service.ask(package_id=package_id, rfq_rev=rfq_rev,
                                         refs={"item_ids": item_ids}, question=question,
                                         asker_realm=my_realm, ticket_id=ticket_id)
                    # 承包商侧同名登记：承包商侧的「待答」队列据此工作（双向可断言）
                    Ledger(mirror_path, realm=mirror_realm).append(
                        ASKED_EVENT, {"ticket_id": ticket_id, "package_id": package_id, "rfq_rev": rfq_rev,
                                      "refs": {"item_ids": item_ids}, "question": question,
                                      "asker_realm": my_realm, "status": "open", "awaiting_answer": True,
                                      "view": mirror_view},
                        correlation_id=ticket_id, actor=my_realm, ts=args.now, event_class="fact",
                        refs={"package_id": package_id, "rfq_rev": rfq_rev})
                except ClarifyError as exc:
                    refused.append(refusal("clarify-refused", str(exc),
                                           "按服务的拒绝原因改入参后重提（拒绝时账本零新增）") | {"file": path.name})
                    continue
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（不往校验不过的账本追加）")
                ledger_added += 2
            applied.append({"file": path.name, "action": action, "event": ASKED_EVENT, "ticket_id": ticket_id,
                            "package_id": package_id, "rfq_rev": rfq_rev, "item_ids": item_ids,
                            "question_chars": len(question), "notified": mirror_view,
                            "status": ticket.get("status") if not args.dry_run else "dry-run"})
        else:  # answer（承包商侧；供应商侧看答复正文）
            ticket_id = str(record.get("ticket_id") or "").strip()
            text = str(record.get("answer_text") or "").strip()
            by = str(record.get("actor") or "").strip()
            if not REF_RE.match(ticket_id):
                refused.append(refusal("ticket-id-malformed", f"ticket_id 缺或形状非法：{ticket_id!r}",
                                       "从「待答工单」表里复制 ticket_id") | {"file": path.name})
                continue
            if not HUMAN_RE.match(by):
                refused.append(refusal("human-required",
                                       f"作答者必须是 human:<人名>（收到 {by!r}）：解答责任在人",
                                       "写 human:<你的名字>（agent 不得代答）") | {"file": path.name})
                continue
            if text == "":
                refused.append(refusal("answer-required", "答复正文为空", "写清答复内容后重提") | {"file": path.name})
                continue
            tickets = tickets_from_ledger(ledger_rows)
            ticket = tickets.get(ticket_id)
            if ticket is None:
                refused.append(refusal("ticket-not-found",
                                       f"工单 {ticket_id} 不在本视角账本里（已读到 {sorted(tickets)[:8] or '（无）'}）",
                                       "只回答本视角看得见的工单（供应商提问会先落到你这一侧）") | {"file": path.name})
                continue
            if ticket.get("status") == "closed":
                refused.append(refusal("ticket-closed", f"工单 {ticket_id} 已关闭（不得再作答）",
                                       "要再答请先按流程重开工单（广播/关闭不在本脚本能力面里）")
                               | {"file": path.name})
                continue
            answered = [row for row in ledger_rows if row.get("type") == ANSWERED_EVENT
                        and str((row.get("body") or {}).get("ticket_id")) == ticket_id
                        and (row.get("body") or {}).get("by")]
            if answered:
                duplicates.append({"file": path.name, "action": action, "ticket_id": ticket_id,
                                   "reason": "already-answered"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            if not args.dry_run:
                try:
                    service = ClarificationService(participant=my_realm, realm=my_realm,
                                                   ledger=Ledger(ledger_path, realm=my_realm), events=None)
                    service.tickets[ticket_id] = dict(ticket)   # 账本重放出的工单（服务实例无状态）
                    result = service.answer(ticket_id=ticket_id, text=text, by=by)
                    # 供应商侧镜像：答复正文对提问者是可见的（问答串必须双向）
                    Ledger(mirror_path, realm=mirror_realm).append(
                        ANSWERED_EVENT, {"ticket_id": ticket_id, "package_id": ticket.get("package_id"),
                                         "rfq_rev": ticket.get("rfq_rev"), "by": by, "text": text,
                                         "fields": {}, "stripped": [], "broadcast_at": None, "view": mirror_view},
                        correlation_id=ticket_id, actor=by, ts=args.now, event_class="fact",
                        refs={"package_id": str(ticket.get("package_id") or "")})
                except ClarifyError as exc:
                    refused.append(refusal("clarify-refused", str(exc),
                                           "按服务的拒绝原因改入参后重提（拒绝时账本零新增）") | {"file": path.name})
                    continue
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（不往校验不过的账本追加）")
                ledger_added += 2
            applied.append({"file": path.name, "action": action, "event": ANSWERED_EVENT, "ticket_id": ticket_id,
                            "package_id": ticket.get("package_id"), "by": by, "answer_chars": len(text),
                            "notified": mirror_view,
                            "status": result.get("status") if not args.dry_run else "dry-run"})
        if not args.dry_run:
            archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件", "先在页面上点一次动作")
    return emit({"ok": not refused, "event": "clarify-apply", "now": args.now, "applied": applied,
                 "duplicates": duplicates, "ledger_added": ledger_added, "refused": refused, "inbox": str(inbox),
                 "note": "提问落 clarification/asked（两侧各一条）；作答落 clarification/answered 并镜像给提问者；"
                         "业务规则（缺版本/缺引用 ⇒ 拒绝）来自既有服务 ClarificationService"},
                1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
