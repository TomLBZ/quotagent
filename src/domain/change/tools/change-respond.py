#!/usr/bin/env python3
"""src/domain/change/tools/change-respond.py —— 「变更单：提出（承包商） / 回应（供应商）」的唯一落账本者（DEF-019）。

要解决的问题（逐条）：
  · DEF-019（P1）：供应商侧 `GET /supplier/changes/chg-0001/` 返回 **404**（虽然回的是整整一页 HTML），
    `POST /supplier/changes/<id>/respond` 根本不存在 —— 供应商**看不到变更单、也无法接受/异议**。
    本写者把两件事落成事实，并**双向登记**：
      1. `change/proposed`（+ `change/priced`）：承包商提出变更 ⇒ 同时镜像到**供应商账本**
         （供应商侧的「变更单（逐行差异）」据此显示；不含任何私域字段）；
      2. `change/responded`：供应商接受/异议 ⇒ 同时镜像到**承包商账本**（承包商侧多一行
         "供应商回应：接受/异议 @ts"，`owed_by` 随之改变）。

业务规则不在这里重写：定价与差额复算走**既有服务** `ChangeService`（`src/domain/change/code/change.py`）：
  · 缺 `ref_line` ⇒ `missing-line-ref`；缺 `basis_unit_price_ref` ⇒ `missing-basis-ref`；
  · 基准对不上 ⇒ `basis-mismatch`（防止用过期基准算差额）；
  · 空 delta ⇒ `empty-delta`；**未批准的变更一分钱都不计**（`effective_total`）。
提出变更**不产生义务**（`change/proposed` 是 intent）；**批准**是人工门（`ChangeService.approve`，
`approved_by` 须 `human:*`），不在本脚本能力面里（本批不做批准，避免越权）。
`propose` 的报价行来自**承包商自己的事实**（`quote/submitted` 的单价 + 已发布快照的数量），不猜。

纪律：宿主只落 0600 待办件（账本零新增）；`--now` 必填；拒绝时零写账本；stdout 恰一行 JSON；退出码 0/1/2。
发言/回应人必须 `human:*`（agent 不得代人回应变更）。
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
from quotagent.services.change import ChangeService  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
MAX_FILE_BYTES = 262144

SCHEMA = "quotagent/pending/v1"
KIND = "change-respond"
ACTIONS = ("propose", "respond")
DECISIONS = ("accept", "dispute")
PROPOSED_EVENT = "change/proposed"
PRICED_EVENT = "change/priced"
APPROVED_EVENT = "change/approved"
RESPONDED_EVENT = "change/responded"
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
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（页面按钮会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "只接受宿主落的普通文件")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600", "chmod 600 后再消费")
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
    if record.get("kind") != KIND or str(record.get("action") or "") not in ACTIONS:
        return None, refusal("action-not-supported",
                             f"kind/action 必须是 {KIND}/{'|'.join(ACTIONS)}："
                             f"{record.get('kind')!r}/{record.get('action')!r}",
                             "用「提出变更」或「回应变更」按钮落的待办件")
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


def quote_lines(ui_shared: Path, rows: list[dict], package_id: str, quote_id: str) -> tuple[list[dict], str]:
    """重建报价行（单价来自本侧 `quote/submitted` 事实，数量来自已发布快照）：`(lines, note)`。

    只读、只认这两处来源；数量缺失的行**不猜**（返回 `qty` 为 None，由调用方拒绝）。
    """
    prices = {}
    qty = {}
    side = ui_shared / "contractor"
    snapshots = sorted(side.glob(f"rfq-{package_id}-rev*.json"))
    for path in snapshots:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for item in (record.get("spec") or {}).get("items") or []:
            if isinstance(item, dict) and item.get("item_id") is not None:
                qty[str(item["item_id"])] = item.get("qty")
    for row in rows:
        if str(row.get("type") or "") != "quote/submitted":
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        if str(body.get("package_id") or "") != package_id or str(body.get("quote_id") or "") != quote_id:
            continue
        item_id = str(body.get("item_id") or "")
        cents = body.get("unit_price_cents")
        if item_id and isinstance(cents, (int, float)):
            prices[item_id] = float(cents) / 100.0
    lines = [{"item_id": item_id, "qty": qty.get(item_id), "unit_price": price}
             for item_id, price in sorted(prices.items())]
    note = f"单价来自本侧 quote/submitted 事实、数量来自已发布快照（{len(snapshots)} 个版本文件）"
    return lines, note


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="change-respond", add_help=False,
                                     description="变更单提出/回应待办件的唯一落账本者")
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--now", default="")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return usage_error("usage-unknown-flag", f"不认识的参数：{unknown}", "去掉不认识的参数后重试")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601",
                           "显式给时间：--now 2026-09-22T10:00:00Z（本脚本不读墙钟）")
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
    contractor_realm = realm_of(contractor_rows, "contractor:change")
    supplier_realm = realm_of(supplier_rows, "supplier:unknown")

    pending = [Path(args.request)] if args.request \
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
        view = str(record.get("view") or "")
        actor = str(record.get("actor") or "").strip()
        if not HUMAN_RE.match(actor):
            refused.append(refusal("human-required",
                                   f"{action} 必须由人发起（收到发言人 {actor!r}）：变更影响金额，agent 不得代提/代答",
                                   "写 human:<你的名字>") | {"file": path.name})
            continue

        if action == "propose":
            if view != "contractor":
                refused.append(refusal("view-unknown", f"提出变更是承包商侧的动作（收到 view={view!r}）",
                                       "供应商侧的对应动作是回应（respond）") | {"file": path.name})
                continue
            package_id = str(record.get("package_id") or "").strip()
            quote_id = str(record.get("quote_id") or "").strip()
            if not REF_RE.match(package_id) or not REF_RE.match(quote_id):
                refused.append(refusal("package-or-quote-malformed",
                                       f"package_id={package_id!r} / quote_id={quote_id!r} 形状非法",
                                       "包与报价都要给：变更必须引用原报价") | {"file": path.name})
                continue
            wanted = record.get("items")
            if not isinstance(wanted, list) or not wanted:
                refused.append(refusal("empty-delta", "变更请求至少要给一条 delta（items）",
                                       "填要改的行项目与新数量") | {"file": path.name})
                continue
            lines, note = quote_lines(ui_shared, contractor_rows, package_id, quote_id)
            if not lines:
                refused.append(refusal("unknown-quote",
                                       f"本视角账本里没有报价 {quote_id}（包 {package_id} 的 quote/submitted 事实）",
                                       "从「收到的报价」表里选一份真报价（不猜）") | {"file": path.name})
                continue
            by_item = {line["item_id"]: line for line in lines}
            deltas = []
            bad = None
            for entry in wanted:
                item_id = str((entry or {}).get("item_id") or "").strip()
                if item_id not in by_item:
                    bad = refusal("unknown-line", f"原报价 {quote_id} 没有条目 {item_id!r}",
                                  "只改这份报价里真实存在的条目")
                    break
                try:
                    new_qty = float(entry.get("new_qty"))
                except (TypeError, ValueError):
                    bad = refusal("new-qty-invalid", f"{item_id} 的 new_qty 不是数：{entry.get('new_qty')!r}",
                                  "新数量给一个数")
                    break
                source = by_item[item_id]
                if source.get("qty") is None:
                    bad = refusal("basis-qty-missing",
                                  f"{item_id} 的原数量不在已发布快照里（不猜基准）",
                                  "先发布该包（快照会带上行项目数量），再提变更")
                    break
                deltas.append({"ref_line": item_id,
                               "basis_unit_price_ref": f"{quote_id}#{item_id}:unit_price",
                               "new_qty": new_qty})
            if bad is not None:
                bad.update({"file": path.name})
                refused.append(bad)
                continue
            change_id = "chg-" + hex_of(f"{package_id}|{quote_id}|{sorted((d['ref_line'], d['new_qty']) for d in deltas)}")[:12]
            existing = [row for row in contractor_rows if row.get("type") == PROPOSED_EVENT
                        and str((row.get("body") or {}).get("change_id")) == change_id]
            if existing:
                duplicates.append({"file": path.name, "action": action, "change_id": change_id,
                                   "reason": "already-proposed"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            quote = {"quote_id": quote_id, "package_id": package_id, "rfq_rev": None,
                     "lines": [{"item_id": line["item_id"], "qty": line["qty"], "unit_price": line["unit_price"]}
                               for line in lines]}
            if not args.dry_run:
                service = ChangeService(ledger=Ledger(ledger_contractor, realm=contractor_realm),
                                        events=None, approvals=None, actor=actor)
                try:
                    proposed = service.propose(quote, deltas, change_id=change_id,
                                               reason=str(record.get("reason") or ""))
                except Exception as exc:   # noqa: BLE001 —— 服务拒绝码原样给用户看
                    refused.append(refusal(getattr(exc, "code", "change-refused"), f"{type(exc).__name__}: {exc}",
                                           "按服务的拒绝原因改入参后重提（拒绝时账本零新增）") | {"file": path.name})
                    continue
                try:      # 供应商侧镜像：供应商看得到的变更单（逐行差异，与承包商同口径）
                    Ledger(ledger_supplier, realm=supplier_realm).append(
                        PROPOSED_EVENT,
                        {"change_id": proposed["change_id"], "package_id": package_id, "quote_id": quote_id,
                         "reason": proposed.get("reason") or "", "delta_amount": proposed.get("delta_amount"),
                         "ref_quote_lines": proposed.get("ref_quote_lines"),
                         "lines": proposed.get("lines"),
                         "supplier": supplier_realm, "view": "supplier", "at": args.now,
                         "note": "变更议题：未批准前不影响任何金额；请回应接受或异议"},
                        correlation_id=proposed["change_id"], actor=actor, ts=args.now, event_class="fact",
                        refs={"package_id": package_id})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修供应商账本（不往校验不过的账本追加）")
                ledger_added += 3   # change/proposed + change/priced（本侧）+ 镜像（对方）
            applied.append({"file": path.name, "action": action, "event": PROPOSED_EVENT, "change_id": change_id,
                            "package_id": package_id, "quote_id": quote_id,
                            "lines": [{"ref_line": item.get("ref_line"), "old_qty": item.get("old_qty"),
                                       "new_qty": item.get("new_qty"), "line_delta": item.get("line_delta")}
                                      for item in (proposed.get("lines") if not args.dry_run else deltas)],
                            "delta_amount": (proposed.get("delta_amount") if not args.dry_run else None),
                            "quote_basis": note, "notified": "supplier"})
        else:  # respond（供应商侧）
            if view != "supplier":
                refused.append(refusal("view-unknown", f"回应变更是供应商侧的动作（收到 view={view!r}）",
                                       "承包商侧的对应动作是提出（propose）") | {"file": path.name})
                continue
            change_id = str(record.get("change_id") or "").strip()
            decision = str(record.get("decision") or "").strip()
            note = str(record.get("note") or "")
            if not REF_RE.match(change_id):
                refused.append(refusal("change-id-malformed", f"change_id 缺或形状非法：{change_id!r}",
                                       "从「变更单」表里复制 change_id") | {"file": path.name})
                continue
            if decision not in DECISIONS:
                refused.append(refusal("decision-unknown", f"decision 必须是 {'/'.join(DECISIONS)}：{decision!r}",
                                       "接受用 accept、异议用 dispute") | {"file": path.name})
                continue
            visible = [row for row in supplier_rows
                       if str(row.get("type") or "") in (PROPOSED_EVENT, PRICED_EVENT)
                       and str((row.get("body") or {}).get("change_id")) == change_id]
            if not visible:
                seen = sorted({str((row.get("body") or {}).get("change_id")) for row in supplier_rows
                               if str(row.get("type") or "") == PROPOSED_EVENT})[:6]
                refused.append(refusal("change-not-found",
                                       f"变更单 {change_id} 不在本视角账本里（已读到 {seen or '（无）'}）："
                                       "看不到就不能回应（不猜、不假装收到）",
                                       "等承包商提出变更（会镜像到你这一侧），或核对 change_id") | {"file": path.name})
                continue
            if any(str(row.get("type") or "") == APPROVED_EVENT
                   and str((row.get("body") or {}).get("change_id")) == change_id for row in supplier_rows):
                refused.append(refusal("change-already-approved", f"变更 {change_id} 已生效（批准后不接受异议）",
                                       "如仍有异议，请让承包商开新的变更单（不得原地改语义）") | {"file": path.name})
                continue
            if decision == "dispute" and note.strip() == "":
                refused.append(refusal("note-required",
                                       "异议必须附理由（只报「不接受」没有可行动的下一步）",
                                       "写清异议理由后重提") | {"file": path.name})
                continue
            responded = [row for row in supplier_rows if str(row.get("type") or "") == RESPONDED_EVENT
                         and str((row.get("body") or {}).get("change_id")) == change_id]
            if responded:
                same = [row for row in responded
                        if str((row.get("body") or {}).get("decision")) == decision]
                duplicates.append({"file": path.name, "action": action, "change_id": change_id,
                                   "decision": decision, "reason": "already-responded" if same else "already-responded-other-decision",
                                   "previous": [str((row.get("body") or {}).get("decision")) for row in responded]})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            proposal = visible[0].get("body") if isinstance(visible[0].get("body"), dict) else {}
            body = {"change_id": change_id, "package_id": str(proposal.get("package_id") or ""),
                    "decision": decision, "responded_by": actor, "note_sha256": digest_of(note),
                    "note": note, "at": args.now, "ok": True, "view": view,
                    "owed_by": "contractor" if decision == "accept" else "contractor+supplier",
                    "next_action": "承包商侧按批准流程推进（批准是人工门）" if decision == "accept"
                    else "承包商侧要回应异议：改量重提或撤回变更"}
            if not args.dry_run:
                try:
                    Ledger(ledger_supplier, realm=supplier_realm).append(
                        RESPONDED_EVENT, body, correlation_id=change_id, actor=actor, ts=args.now,
                        event_class="fact", refs={"package_id": body["package_id"]})
                    Ledger(ledger_contractor, realm=contractor_realm).append(
                        RESPONDED_EVENT, {**body, "view": "contractor", "supplier": supplier_realm},
                        correlation_id=change_id, actor=actor, ts=args.now, event_class="fact",
                        refs={"package_id": body["package_id"]})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（不往校验不过的账本追加）")
                ledger_added += 2
            applied.append({"file": path.name, "action": action, "event": RESPONDED_EVENT,
                            "change_id": change_id, "decision": decision, "notified": "contractor"})
        if not args.dry_run:
            archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件", "先在页面上点一次动作")
    return emit({"ok": not refused, "event": "change-respond", "now": args.now, "applied": applied,
                 "duplicates": duplicates, "ledger_added": ledger_added, "refused": refused, "inbox": str(inbox),
                 "note": "提出变更走既有服务 ChangeService.propose（缺引用/基准不符 ⇒ 拒绝，零写账本）；"
                         "回应落 change/responded 并镜像给承包商（对方多一行『供应商回应：接受/异议 @ts』）",
                 }, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
