#!/usr/bin/env python3
"""src/domain/commitments/tools/change-apply.py —— 「变更与价格让步」写动作的**唯一落账本者**
（DEF-018：承包商提出变更 + 批准/驳回；价格让步必须过人工门）。

三步（只落**已登记**的事件类型；新增事件类型属账本格式变更，须先有 ADR ⇒ 本轮不新造）：

  · `--step propose`  提出变更：`change/proposed` + `change/priced`（`ChangeService.propose`）。
    逐行口径：**原单价只读**（基准引用必须是 `<quote_id>#<item_id>:unit_price`）、只改量、
    实时 `before/after/delta`（整数分口径见输出）。任何一行**没有可验证的基准**即被服务拒
    （落 `change/rejected` —— 那是它登记的"拒绝也留痕"语义）；`no-op-change`（所有行量与原来一样）
    在本脚本里**先拒**，此时**账本零新增**。
  · `--step approve`  **批准变更（人签）**：先落人工门 `approval/requested` → `approval/granted`
    （`scope=change.approve`，`ref=<change_id>`），再 `ChangeService.approve(...)` 落 `change/approved`。
    `approved_by` 必须是 `human:*`（服务自己会拒 agent）。
  · `--step reject`   驳回：人工门 `approval/requested` → `approval/denied`（理由逐字落 `comment`），
    变更保持 `proposed`（**未批准的变更一分钱都不计**：`effective_total` 只算已批准项）。

跨进程状态：`ChangeService` 没有 replay ⇒ 本脚本先从**承包商账本**重建变更登记
（`change/priced` + `change/proposed` + `change/approved`/`rejected`），再动服务（与 `seed_gate` 同模式）。

纪律：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ 重算校验 → 业务前置 →
落账 → 归档；拒绝路径（除服务自己登记过的拒绝留痕）**账本零新增**；stdout 恰一行 JSON；退出码 0/1/2。

用法：
  python3 src/domain/commitments/tools/change-apply.py --step propose --request <pending.json> \\
      --ledger-contractor .../contractor/ledger.jsonl --now 2026-09-22T16:30:00Z
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

from quotagent.kernel.events import EventBus  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402
from quotagent.services.approval import ApprovalService  # noqa: E402
from quotagent.services.change import APPROVAL_SCOPE, ChangeService  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CHANGE_RE = re.compile(r"^chg-[A-Za-z0-9-]{1,32}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "change-apply"
STEPS = ("propose", "approve", "reject")
MAX_LINES = 64
MAX_FILE_BYTES = 262144
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def deny(code: str, reason: str, next_action: str, step: str, request: str = "") -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "step": step, "request": request, "refusal": refusal(code, reason, next_action)}, 1)


def digest_of(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


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


def body_of(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def realm_of(rows: list[dict], fallback: str) -> str:
    for row in rows:
        value = str(row.get("realm") or "").strip()
        if REALM_RE.match(value):
            return value
    return fallback


def read_pending(path: Path, step: str) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（页面点动作会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "待办件必须是宿主落的普通文件")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600", "chmod 600 后再消费")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限", "拆分后重提")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA or record.get("kind") != KIND:
        return None, refusal("pending-schema-unknown",
                             f"schema/kind 不匹配：{record.get('schema')!r}/{record.get('kind')!r}",
                             "这份待办件不是变更动作的载荷")
    if record.get("action") != step:
        return None, refusal("action-mismatch", f"action 不是 {step}：{record.get('action')!r}",
                             "用这一动作的待办件（一步一件）")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件")
    note = str(record.get("note") or "")
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与正文长度不一致", "让宿主重落待办件")
    return record, None


def archive(inbox: Path, request: Path) -> str:
    applied = inbox / "applied"
    applied.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(applied, 0o700)
    except OSError:
        pass
    target = applied / request.name
    index = 1
    while target.exists():
        target = applied / f"{request.stem}.{index}.json"
        index += 1
    shutil.move(str(request), str(target))
    return str(target)


def quotes_in(rows: list[dict], ui_shared: Path | None = None) -> dict[str, dict]:
    """本侧账本里的报价（`quote/submitted` 逐行聚合）：`quote_id → {rfq_rev, lines[], package_id}`。

    单价一律从**整数分**换回元（`unit_price_cents / 100`）——与 `compare-rank.py` 同口径。
    **量**（`qty`）在报价事实里通常不带（报价按行项目报价，量属于包的清单），因此缺失时从
    **本侧包快照** `<ui-shared>/contractor/rfq-<pkg>-rev<N>.json` 的 `spec.items` 里按 item_id 取；
    都取不到就按 1.0（并在输出里如实标 `qty_source`，不假装知道量）。
    """
    out: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "quote/submitted":
            continue
        body = body_of(row)
        quote_id = str(body.get("quote_id") or "")
        if not quote_id:
            continue
        item_id = str(body.get("item_id") or "")
        entry = out.setdefault(quote_id, {"quote_id": quote_id, "rfq_rev": body.get("rfq_rev"),
                                          "package_id": body.get("package_id") or "",
                                          "supplier": body.get("supplier") or "", "lines": [],
                                          "qty_source": "quote-fact"})
        if item_id:
            cents = body.get("unit_price_cents")
            if isinstance(cents, (int, float)):
                qty = body.get("qty")
                entry["lines"].append({"item_id": item_id,
                                       "qty": float(qty) if isinstance(qty, (int, float)) else None,
                                       "unit_price": float(cents) / 100.0})
                continue
        lines = body.get("lines")
        if isinstance(lines, list):
            for line in lines:
                entry["lines"].append({"item_id": str(line.get("item_id")),
                                       "qty": float(line.get("qty") or 0) or None,
                                       "unit_price": float(line.get("unit_price") or 0)})
    # 量补齐：从本侧包快照的清单按 item_id 取值（报价事实不带量）
    qty_of: dict[str, dict[str, float]] = {}
    if ui_shared is not None:
        for entry in out.values():
            package_id = str(entry.get("package_id") or "")
            if not package_id or package_id in qty_of:
                continue
            candidates = sorted((ui_shared / "contractor").glob(f"rfq-{package_id}-rev*.json"))
            table: dict[str, float] = {}
            if candidates:
                try:
                    snapshot = json.loads(candidates[-1].read_text(encoding="utf-8"))
                    spec = snapshot.get("spec") if isinstance(snapshot.get("spec"), dict) else {}
                    for item in spec.get("items") or []:
                        table[str(item.get("item_id"))] = float(item.get("qty") or 0)
                except (ValueError, TypeError):
                    table = {}
            qty_of[package_id] = table
    for entry in out.values():
        table = qty_of.get(str(entry.get("package_id") or ""), {})
        for line in entry["lines"]:
            if line.get("qty"):
                continue
            if table.get(line["item_id"]):
                line["qty"] = table[line["item_id"]]
                entry["qty_source"] = "package-snapshot"
        if any(line.get("qty") is None for line in entry["lines"]):
            entry["qty_source"] = "unknown-default-1"
            for line in entry["lines"]:
                if line.get("qty") is None:
                    line["qty"] = 1.0
    return out


def replay_changes(service: ChangeService, rows: list[dict], quotes: dict[str, dict]) -> dict:
    """把变更登记从**账本**重建（`ChangeService` 没有 replay；与 `seed_gate` 同模式）。"""
    changes: dict[str, dict] = {}
    for row in rows:
        type_ = str(row.get("type") or "")
        if not type_.startswith("change/"):
            continue
        body = body_of(row)
        change_id = str(body.get("change_id") or "")
        if not change_id:
            continue
        entry = changes.setdefault(change_id, {"change_id": change_id, "quote_id": body.get("quote_id"),
                                               "rfq_rev": body.get("rfq_rev"), "reason": "", "lines": [],
                                               "ref_quote_lines": [], "basis_unit_price_refs": [],
                                               "basis_unit_price_ref": None, "delta_amount": 0.0,
                                               "status": "proposed", "actor": row.get("actor"),
                                               "proposed_at": str(row.get("ts") or ""), "approved_by": None,
                                               "approved_at": None, "approval_id": None})
        if type_ == "change/proposed":
            entry["reason"] = body.get("reason") or entry["reason"]
            entry["ref_quote_lines"] = list(body.get("ref_quote_lines") or entry["ref_quote_lines"])
            entry["basis_unit_price_refs"] = list(body.get("basis_unit_price_refs") or entry["basis_unit_price_refs"])
            entry["basis_unit_price_ref"] = body.get("basis_unit_price_ref") or entry["basis_unit_price_ref"]
        elif type_ == "change/priced":
            entry["lines"] = [dict(item) for item in (body.get("lines") or [])]
            entry["delta_amount"] = float(body.get("delta_amount") or 0.0)
        elif type_ == "change/approved":
            entry.update({"status": "approved", "approved_by": body.get("approved_by"),
                          "approval_id": body.get("approval_id"), "approved_at": str(row.get("ts") or "")})
        elif type_ == "change/rejected":
            entry.setdefault("rejections", []).append({"code": body.get("code"), "reason": body.get("reason"),
                                                       "at": str(row.get("ts") or "")})
    service._changes = changes          # noqa: SLF001 —— 内存登记从账本重建
    return {"changes": len(changes), "approved": sum(1 for item in changes.values() if item["status"] == "approved")}


def decisions_in(rows: list[dict], change_id: str) -> dict | None:
    """人工门对该变更的判定（最后一条 approval/* 行）：`{status, by, comment, at, approval_id}`。"""
    found = None
    for row in rows:
        if not str(row.get("type") or "").startswith("approval/"):
            continue
        body = body_of(row)
        if str(body.get("scope") or "") != APPROVAL_SCOPE or str(body.get("ref") or "") != change_id:
            continue
        found = {"status": body.get("status"), "by": body.get("decided_by"), "comment": body.get("comment") or "",
                 "at": str(row.get("ts") or ""), "approval_id": body.get("approval_id"),
                 "event": str(row.get("type"))}
    return found


def bump_counter(approvals: ApprovalService, rows: list[dict]) -> int:
    highest = 0
    for row in rows:
        suffix = str(body_of(row).get("approval_id") or "").rsplit("-", 1)[-1]
        if str(row.get("type") or "").startswith("approval/") and suffix.isdigit():
            highest = max(highest, int(suffix))
    approvals._counter = highest          # noqa: SLF001
    return highest


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="变更与价格让步的唯一落账本者（提出/批准/驳回）")
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="", help="对方账本（写一条投递登记：对方看得见变更）")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    step = args.step
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-22T16:30:00Z")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "step": step, "event": None, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "pending": 0, "note": "待办件目录空（空跑）"}, 0)
        request = candidates[0]
    record, deny_reason = read_pending(request, step)
    if deny_reason is not None:
        return emit({"ok": False, "step": step, "event": None, "applied": [], "duplicates": [],
                     "ledger_added": 0, "request": str(request), "refusal": deny_reason}, 1)
    assert record is not None

    actor = str(record.get("actor") or "").strip()
    if not actor.startswith("human:"):
        return deny("human-required", f"{step} 必须有人署名：actor 以 human: 开头",
                    "写 human:<你的名字>（变更批准只能由人做）", step, str(request))
    note = str(record.get("note") or "")
    if step == "reject" and note.strip() == "":
        return deny("reason-required", "驳回变更必须留理由（对方要知道为什么）",
                    "在「理由」里写清楚", step, str(request))

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    realm = realm_of(rows, "contractor:gui")
    quotes = quotes_in(rows, ui_shared)
    key = digest_of(canonical(record))
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous = {}
        if digest_of(canonical(previous)) == key:
            return emit({"ok": True, "step": step, "event": None, "applied": [], "ledger_added": 0,
                         "duplicates": [{"reason": "already-applied", "key": key}], "refusal": None,
                         "request": str(request),
                         "note": "同一份载荷已消费过（归档件逐字节一致）：账本零新增（幂等）"}, 0)
    if args.dry_run:
        return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                     "ledger_added": 0, "refusal": None, "note": "干跑：校验通过、账本零新增"}, 0)

    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")
    bus = EventBus()
    bus.install_defaults()
    approvals = ApprovalService(ledger=ledger, actor=actor)
    bump_counter(approvals, rows)
    service = ChangeService(ledger=ledger, events=bus, approvals=approvals, actor=actor)
    seeded = replay_changes(service, rows, quotes)

    applied: list[dict] = []
    ledger_added = 0
    out_extra: dict = {}

    if step == "propose":
        quote_id = str(record.get("quote_id") or "").strip()
        if not ID_RE.match(quote_id):
            return deny("quote-id-malformed", f"quote_id 形状非法：{quote_id!r}",
                        "从报价收件箱/比价矩阵里取真报价 id", step, str(request))
        quote = quotes.get(quote_id)
        if quote is None:
            return deny("quote-not-found", f"本侧账本里没有报价 {quote_id}（变更必须引用中标/在评报价）",
                        "从比价矩阵或报价收件箱列出的真报价里选一条", step, str(request))
        raw_lines = record.get("lines")
        if not isinstance(raw_lines, list) or not raw_lines:
            return deny("lines-required", "变更必须给至少一条行变更", "在差异编辑器里改至少一行量", step, str(request))
        if len(raw_lines) > MAX_LINES:
            return deny("lines-too-many", f"行数 {len(raw_lines)} 超过上限 {MAX_LINES}", "拆成多次变更", step, str(request))
        by_item = {str(line["item_id"]): line for line in quote["lines"]}
        deltas: list[dict] = []
        preview: list[dict] = []
        noop = True
        for index, raw in enumerate(raw_lines):
            if not isinstance(raw, dict):
                return deny("line-not-an-object", f"lines[{index}] 不是对象", "改这一行", step, str(request))
            item_id = str(raw.get("item_id") or raw.get("ref_line") or "").strip()
            source = by_item.get(item_id)
            if source is None:
                return deny("unknown-line", f"报价 {quote_id} 没有条目 {item_id!r}（本报价条目：{sorted(by_item)}）",
                            "只对报价里真的有的条目提变更", step, str(request))
            try:
                new_qty = float(raw.get("new_qty"))
            except (TypeError, ValueError):
                return deny("new-qty-invalid", f"{item_id} 的新数量不是数：{raw.get('new_qty')!r}",
                            "新数量给一个数（整数分口径只影响金额，不影响量的写法）", step, str(request))
            if new_qty < 0:
                return deny("new-qty-negative", f"{item_id} 的新数量为负：{new_qty}", "量不得为负", step, str(request))
            if new_qty != float(source["qty"]):
                noop = False
            deltas.append({"ref_line": item_id,
                           "basis_unit_price_ref": f"{quote_id}#{item_id}:unit_price",
                           "new_qty": new_qty})
            preview.append({"item_id": item_id, "old_qty": float(source["qty"]), "new_qty": new_qty,
                            "old_unit_price": float(source["unit_price"]),
                            "before_amount": round(float(source["qty"]) * float(source["unit_price"]), 6),
                            "after_amount": round(new_qty * float(source["unit_price"]), 6),
                            "line_delta": round(new_qty * float(source["unit_price"])
                                                - float(source["qty"]) * float(source["unit_price"]), 6),
                            "basis_unit_price_ref": f"{quote_id}#{item_id}:unit_price"})
        if noop:
            return deny("no-op-change", "所有行的新数量都与原来一样：这不是一条变更（账本零新增）",
                        "至少改动一行的量；只改价格属于价格让步，也要走这条链（改量≠改价，价由基准锁定）",
                        step, str(request))
        try:
            change = service.propose(quote, deltas, reason=note)
        except Exception as exc:  # noqa: BLE001 —— 服务自己已落 `change/rejected`（登记过的语义）
            return deny("change-rejected", f"{type(exc).__name__}: {exc}",
                        "按拒绝原因改基准引用/行引用后重提（服务的拒绝留痕在 change/rejected 行上）",
                        step, str(request))
        applied.append({"event": "change/proposed", "change_id": change["change_id"],
                        "ref_quote_lines": change["ref_quote_lines"]})
        applied.append({"event": "change/priced", "change_id": change["change_id"],
                        "delta_amount": change["delta_amount"], "basis": change["basis_unit_price_refs"]})
        ledger_added += 2
        out_extra = {"change_id": change["change_id"], "quote_id": quote_id, "preview": preview,
                     "delta_amount": change["delta_amount"], "status": change["status"]}
        counterpart = {"package_id": quote["package_id"], "quote_id": quote_id,
                       "change_id": change["change_id"], "delta_amount": change["delta_amount"],
                       "lines": preview, "reason": note, "at": args.now, "by": actor,
                       "status": "proposed", "note": "投递登记：对方收到一条待回应的变更（未批准前不影响金额）"}
    else:
        change_id = str(record.get("change_id") or "").strip()
        if not CHANGE_RE.match(change_id):
            return deny("change-id-malformed", f"change_id 形状非法：{change_id!r}",
                        "从变更列表里取真变更 id（形如 chg-0001）", step, str(request))
        existing = service._changes.get(change_id)          # noqa: SLF001
        if existing is None:
            return deny("change-not-found", f"本账本里没有变更 {change_id}",
                        "从变更列表列出真变更 id（不猜）", step, str(request))
        if existing.get("status") == "approved":
            return deny("change-already-approved",
                        f"变更 {change_id} 已批准（by {existing.get('approved_by')} @ {existing.get('approved_at')}）",
                        "已批准不可重复批准；要调整就再提一条新变更", step, str(request))
        quote = quotes.get(str(existing.get("quote_id") or ""))
        if quote is None:
            return deny("quote-not-found", f"变更 {change_id} 引用的报价不在本侧账本里",
                        "先确认这条变更引用的报价事实（不猜）", step, str(request))
        request_row = approvals.request(APPROVAL_SCOPE, {"change_id": change_id,
                                                         "delta_amount": existing.get("delta_amount")},
                                        ref=change_id, approvers=[actor], reason=note,
                                        summary=f"{'批准' if step == 'approve' else '驳回'}变更 {change_id}"
                                                f"（差额 {existing.get('delta_amount')}）")
        applied.append({"event": "approval/requested", "approval_id": request_row["approval_id"],
                        "scope": APPROVAL_SCOPE, "ref": change_id})
        ledger_added += 1
        if step == "approve":
            decided = approvals.decide(request_row["approval_id"], by=actor, decision="granted", comment=note)
            applied.append({"event": "approval/granted", "approval_id": request_row["approval_id"],
                            "decided_by": actor})
            ledger_added += 1
            approved = service.approve(change_id, approved_by=actor,
                                       approval_id=request_row["approval_id"])
            applied.append({"event": "change/approved", "change_id": change_id,
                            "delta_amount": approved["delta_amount"], "approved_by": actor})
            ledger_added += 1
            effect = service.effective_total(quote)
            out_extra = {"change_id": change_id, "approval_id": request_row["approval_id"],
                         "status": "approved", "delta_amount": approved["delta_amount"],
                         "effective_total": effect}
            counterpart = {"package_id": quote["package_id"], "quote_id": quote["quote_id"],
                           "change_id": change_id, "status": "approved", "delta_amount": approved["delta_amount"],
                           "approved_by": actor, "at": args.now, "note": "投递登记：变更已批准（此后计入金额）"}
        else:
            decided = approvals.decide(request_row["approval_id"], by=actor, decision="denied", comment=note)
            applied.append({"event": "approval/denied", "approval_id": request_row["approval_id"],
                            "decided_by": actor, "comment": note})
            ledger_added += 1
            out_extra = {"change_id": change_id, "approval_id": request_row["approval_id"], "status": "proposed",
                         "decision": "denied", "comment": note}
            counterpart = {"package_id": quote["package_id"], "quote_id": quote["quote_id"],
                           "change_id": change_id, "status": "rejected", "reason": note, "at": args.now,
                           "by": actor, "note": "投递登记：变更被驳回（仍未生效，一分钱都不计）"}

    # 对方的可见变化：投递登记（供应商侧的变更列表由此可读）
    other_notice = ""
    if args.ledger_supplier:
        o_rows, o_error = load_rows(Path(args.ledger_supplier))
        if o_error is not None or o_rows is None:
            return usage_error("ledger-unreadable", str(o_error), "先修对方账本")
        o_realm = realm_of(o_rows, "")
        if o_realm == "":
            return usage_error("counterpart-realm-unknown", "对方账本还没有 realm（不猜写给谁）", "先让对方产生一条事实")
        try:
            o_ledger = Ledger(Path(args.ledger_supplier), realm=o_realm)
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修对方账本")
        try:
            o_ledger.append("change/proposed", {**counterpart, "mirror": True, "delivered_by": actor,
                                                "delivered_at": args.now},
                            correlation_id=str(out_extra.get("change_id") or ""), actor=actor, ts=args.now,
                            refs={"change_id": str(out_extra.get("change_id") or "")})
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修对方账本")
        applied.append({"event": "change/proposed", "view": "supplier", "mirror": True,
                        "ledger": str(args.ledger_supplier)})
        ledger_added += 1
        other_notice = str(args.ledger_supplier)

    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    hint = {
        "propose": "变更已提出（proposed+priced）：未批准前**不影响任何金额**；批准走「批准变更（人签）」。",
        "approve": "变更已批准（人工门 granted + change/approved）：此后计入金额（effective_total 已更新）。",
        "reject": "变更已驳回（人工门 denied）：它保持 proposed、不进金额；对方侧看得到驳回理由。",
    }[step]
    return emit({"ok": True, "step": step, "event": applied[-1]["event"] if applied else None,
                 "applied": applied, "duplicates": [], "ledger_added": ledger_added, "refusal": None,
                 "request": str(request), "archived": archived, "by": actor, "at": args.now,
                 "seeded": seeded, "counterpart_notice": other_notice,
                 "next_action_runtime": hint,
                 "note": "变更链只落已登记事件（change/proposed|priced|approved|rejected、approval/*）；"
                         "批准必须 human:*，reject 走人工门 denied（不用 change/rejected —— 那条是引用不可验证的语义）",
                 **out_extra}, 0)


def crash_guard(fn, argv):
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed", "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
