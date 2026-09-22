#!/usr/bin/env python3
"""src/domain/rfq/tools/rfq-clarify-apply.py —— 「澄清单据」写动作的**唯一落账本者**
（DEF-014 承包商侧工单队列/回答/广播；同类也服务供应商侧的提问 —— 与本批其它写者同规格）。

四个步（只落**已登记**的事件类型：`clarification/asked` / `answered` / `broadcast-incomplete` / `rejected`）：

  · `--step ask`        建单（供应商侧提问：`package_id` + `rfq_rev` + ≥1 条目引用 + 问题）
  · `--step answer`     作答（**必须 `human:*`**；草稿先过 `clarification/answer-drafted` waterfall）
  · `--step broadcast`  广播（名单必须覆盖**全部在册投标人**，否则落 `broadcast-incomplete` 并拒绝）
  · `--step close`      关闭（未完整广播的工单关闭会被拒，INV-006）

跨侧可见性（与 `rfq-publish.py` 的投递登记同模式）：动作在**本侧账本**落权威事实，同时给对方账本写一条
**投递登记**（同一个事件类型 + `mirror: true` + `delivered_by` —— 对方的可见变化由这条行给出）。

纪律：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ 重算校验 → 业务前置
（工单必须真的在本侧账本里 / 包必须真的发布过 / 广播名单必须覆盖在册投标人）→ 落账 → 归档。
拒绝时**账本零新增**（服务自己的拒绝会落 `clarification/rejected` —— 那是它登记的"拒绝也留痕"语义）。

用法：
  python3 src/domain/rfq/tools/rfq-clarify-apply.py --request <pending.json> --view contractor \\
      --ledger-contractor .../contractor/ledger.jsonl --ledger-supplier .../supplier/ledger.jsonl \\
      --now 2026-09-22T09:20:00Z
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
from quotagent.services.clarify import ClarificationService  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
TICKET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "clarify-apply"
STEPS = ("ask", "answer", "broadcast", "close")
MAX_QUESTION = 500
MAX_ANSWER = 4000
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
                             "这份待办件不是澄清单据的载荷")
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


def replay_tickets(service: ClarificationService, rows: list[dict]) -> dict:
    """把工单登记从**本侧账本**重建（`ClarificationService` 没有 replay；与 `seed_gate` 同模式）。

    重建规则（与 `ClarificationService` 写出的 body 逐键对应）：
    `clarification/asked` → 建单（status=open）/ status=closed 覆盖；
    `clarification/answered` → 回答（正文 + 广播名单）；`clarification/reopened` → 重新打开。
    """
    tickets: dict[str, dict] = {}
    for row in rows:
        type_ = str(row.get("type") or "")
        if not type_.startswith("clarification/"):
            continue
        body = body_of(row)
        ticket_id = str(body.get("ticket_id") or "")
        if not ticket_id:
            continue
        ticket = tickets.setdefault(ticket_id, {
            "ticket_id": ticket_id, "package_id": body.get("package_id"), "rfq_rev": body.get("rfq_rev"),
            "refs": dict(body.get("refs") or {}), "question": body.get("question") or "",
            "asker_realm": body.get("asker_realm") or "", "status": "open", "answer": None,
            "broadcast": None, "reopened": [], "created_at": str(row.get("ts") or "")})
        if type_ == "clarification/asked":
            if str(body.get("status") or "") == "closed":
                ticket["status"] = "closed"
                ticket["closed_at"] = body.get("closed_at")
            elif str(body.get("status") or "") == "open" and body.get("question"):
                ticket["question"] = body.get("question") or ticket["question"]
                ticket["refs"] = dict(body.get("refs") or ticket["refs"])
                ticket["status"] = "open" if ticket["status"] != "closed" else "closed"
        elif type_ == "clarification/answered":
            if str(body.get("broadcast_complete")) in ("True", "true", True) or body.get("broadcast_to"):
                ticket["broadcast"] = {"to": list(body.get("broadcast_to") or []), "complete": True,
                                       "missing": [], "at": body.get("broadcast_at") or str(row.get("ts") or "")}
                if ticket.get("answer") is None:
                    ticket["answer"] = {"text": "(广播)", "fields": {}, "by": body.get("by") or "",
                                        "at": body.get("broadcast_at") or str(row.get("ts") or ""),
                                        "rfq_rev": ticket["rfq_rev"], "stale": False, "stripped": []}
            if body.get("text") is not None:
                ticket["answer"] = {"text": body.get("text"), "fields": dict(body.get("fields") or {}),
                                    "by": body.get("by") or "",
                                    "at": str(row.get("ts") or ""), "rfq_rev": ticket["rfq_rev"],
                                    "stale": False, "stripped": list(body.get("stripped") or [])}
                if ticket["status"] != "closed":
                    ticket["status"] = "answered"
        elif type_ == "clarification/reopened":
            ticket["status"] = "open"
            ticket["reopened"] = list(ticket.get("reopened") or []) + [str(row.get("ts") or "")]
    service.tickets = tickets
    return {"tickets": len(tickets)}


def package_of_ticket(rows: list[dict], ticket_id: str) -> str:
    """工单绑定的包 id（从**本侧账本**的 `clarification/*` 行回读，不凭页面输入猜）。"""
    for row in rows:
        body = body_of(row)
        if str(body.get("ticket_id") or "") == ticket_id and body.get("package_id"):
            return str(body["package_id"])
    return ""


def registered_of(rows: list[dict], package_id: str, snapshot_invited: list[str]) -> list[str]:
    """在册投标人：优先用本包快照的邀请名单，其次用本侧 `rfq/distributed` 的收件人。"""
    if snapshot_invited:
        return sorted({str(who) for who in snapshot_invited if str(who).strip()})
    out: set[str] = set()
    for row in rows:
        if str(row.get("type")) != "rfq/distributed":
            continue
        body = body_of(row)
        if str(body.get("package_id") or "") != package_id:
            continue
        for who in body.get("recipients") or []:
            out.add(str(who))
    return sorted(out)


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="澄清单据的唯一落账本者（提问/回答/广播/关闭）")
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--view", default="contractor", choices=("contractor", "supplier"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    step = args.step
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-22T09:20:00Z")

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

    view = str(record.get("view") or args.view)
    if view not in ("contractor", "supplier"):
        return deny("view-unknown", f"view 必须是 contractor|supplier：{view!r}", "从页面提交的视图名里取",
                    step, str(request))
    actor = str(record.get("actor") or "").strip()
    if not actor.startswith("human:"):
        return deny("human-required", f"{step} 必须有人署名：actor 以 human: 开头",
                    "写 human:<你的名字>（agent 不得代人回答/提问）", step, str(request))
    text = str(record.get("note") or "")

    own_path = Path(args.ledger_contractor if view == "contractor" else args.ledger_supplier) \
        if (args.ledger_contractor if view == "contractor" else args.ledger_supplier) \
        else ui_shared / view / "ledger.jsonl"
    other_path = Path(args.ledger_supplier if view == "contractor" else args.ledger_contractor) \
        if (args.ledger_supplier if view == "contractor" else args.ledger_contractor) else None
    own_rows, error = load_rows(own_path)
    if error is not None or own_rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    realm = realm_of(own_rows, f"{view}:gui")

    snapshot = None
    package_id = str(record.get("package_id") or "").strip()
    ticket_hint = str(record.get("ticket_id") or "").strip()
    if not package_id and ticket_hint:
        # 广播/关闭不需要页面重复填包：包 id 从**工单行**回读（否则服务会带着空在册名单构造，
        # 广播完整性校验就形同虚设）
        package_id = package_of_ticket(own_rows, ticket_hint)
    if package_id:
        candidates = sorted((ui_shared / "contractor").glob(f"rfq-{package_id}-rev*.json"))
        if candidates:
            try:
                snapshot = json.loads(candidates[-1].read_text(encoding="utf-8"))
            except ValueError:
                snapshot = None
    invited = [str(who) for who in ((snapshot or {}).get("invited") or [])]
    registered = registered_of(own_rows, package_id, invited)
    explicit_registered = [str(who).strip() for who in (record.get("registered") or []) if str(who).strip()]
    if explicit_registered:
        registered = sorted(set(explicit_registered))
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
                     "ledger_added": 0, "refusal": None, "registered_bidders": registered,
                     "note": "干跑：校验通过、账本零新增"}, 0)

    try:
        ledger = Ledger(own_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")
    bus = EventBus()
    bus.install_defaults()
    service = ClarificationService(participant=actor, realm=realm, ledger=ledger, events=bus,
                                   package=dict((snapshot or {}).get("spec") or {}),
                                   registered_bidders=registered)
    seeded = replay_tickets(service, own_rows)

    applied: list[dict] = []
    ledger_added = 0
    out_extra: dict = {}

    if step == "ask":
        if not ID_RE.match(package_id):
            return deny("package-id-malformed", f"package_id 形状非法：{package_id!r}",
                        "从「我的 RFQ 包」里取包 id", step, str(request))
        rfq_rev = record.get("rfq_rev")
        if not isinstance(rfq_rev, int) or rfq_rev < 1:
            return deny("rfq-rev-required", f"rfq_rev 必须是正整数：{rfq_rev!r}",
                        "工单必须绑定包版本（rev1、rev2…）", step, str(request))
        item_ids = [str(item).strip() for item in (record.get("item_ids") or []) if str(item).strip()]
        if not item_ids:
            return deny("clarify-ref-missing", "缺条目引用：工单必须引用 ≥1 条行项目（FR-CLARIFY-001）",
                        "在「引用条目」里至少勾一条（如 L-001）", step, str(request))
        if text.strip() == "" or len(text) > MAX_QUESTION:
            return deny("question-invalid", f"问题为空或超过 {MAX_QUESTION} 字（当前 {len(text)}）",
                        "写一句能看懂的问题（≤500 字）", step, str(request))
        ticket = service.ask(package_id=package_id, rfq_rev=rfq_rev, refs={"item_ids": item_ids},
                             question=text, asker_realm=realm)
        applied.append({"event": "clarification/asked", "ticket_id": ticket["ticket_id"],
                        "package_id": package_id, "rfq_rev": rfq_rev, "refs": item_ids})
        ledger_added += 1
        out_extra = {"ticket_id": ticket["ticket_id"], "status": "open"}
    else:
        ticket_id = str(record.get("ticket_id") or "").strip()
        if not TICKET_RE.match(ticket_id):
            return deny("ticket-id-malformed", f"ticket_id 形状非法：{ticket_id!r}",
                        "从工单队列里取真工单 id", step, str(request))
        if ticket_id not in service.tickets:
            return deny("ticket-not-found", f"本账本里没有工单 {ticket_id}",
                        "看工单队列列出的真工单 id（不猜）", step, str(request))
        # 工单自带包：广播/关闭不需要页面重复填包 id —— 从工单回读包与**在册投标人**
        ticket_known = service.tickets[ticket_id]
        if not package_id:
            package_id = str(ticket_known.get("package_id") or "")
            if package_id:
                candidates = sorted((ui_shared / "contractor").glob(f"rfq-{package_id}-rev*.json"))
                if candidates:
                    try:
                        snapshot = json.loads(candidates[-1].read_text(encoding="utf-8"))
                    except ValueError:
                        snapshot = None
                invited = [str(who) for who in ((snapshot or {}).get("invited") or [])]
                registered = sorted(set(explicit_registered)) if explicit_registered \
                    else registered_of(own_rows, package_id, invited)
        if step == "answer":
            if text.strip() == "" or len(text) > MAX_ANSWER:
                return deny("answer-invalid", f"答复为空或超过 {MAX_ANSWER} 字（当前 {len(text)}）",
                            "写清楚答复正文（答疑责任在人，署名 human:*）", step, str(request))
            ticket = service.answer(ticket_id=ticket_id, text=text, by=actor)
            applied.append({"event": "clarification/answered", "ticket_id": ticket_id,
                            "package_id": ticket["package_id"], "rfq_rev": ticket["rfq_rev"], "by": actor})
            ledger_added += 1
            out_extra = {"ticket_id": ticket_id, "status": ticket["status"],
                         "answer_sha256": digest_of(text)}
        elif step == "broadcast":
            to = [str(who).strip() for who in (record.get("to") or []) if str(who).strip()] or list(registered)
            if not registered:
                return deny("registered-bidders-unknown",
                            "不知道这个包的在册投标人（缺包快照的邀请名单）：广播完整性无法判定",
                            "先发布这一包（邀请名单进快照），或在载荷里显式给 registered", step, str(request))
            bad = [who for who in to if not REALM_RE.match(who)]
            if bad:
                return deny("recipient-malformed", f"广播对象形状非法：{bad}", "写 realm 形状（如 supplier:g1）",
                            step, str(request))
            try:
                result = service.broadcast(ticket_id=ticket_id, to=to)
            except Exception as exc:  # noqa: BLE001 —— 服务自己已落 broadcast-incomplete（登记过的语义）
                missing = getattr(exc, "args", [""])[0]
                return deny("broadcast-incomplete", f"{type(exc).__name__}: {missing}",
                            "把缺的供应商补进广播名单（名单必须覆盖全部在册投标人，INV-006）", step, str(request))
            applied.append({"event": "clarification/answered", "ticket_id": ticket_id,
                            "broadcast_to": result["broadcast"]["to"], "complete": True})
            ledger_added += 1
            out_extra = {"ticket_id": ticket_id, "broadcast_to": result["broadcast"]["to"]}
        else:  # close
            try:
                ticket = service.close(ticket_id=ticket_id)
            except Exception as exc:  # noqa: BLE001
                return deny("close-refused", f"{type(exc).__name__}: {exc}",
                            "先作答并**完整广播**（覆盖全部在册投标人）再关闭（INV-006）", step, str(request))
            applied.append({"event": "clarification/asked", "ticket_id": ticket_id, "status": "closed",
                            "closed_at": ticket.get("closed_at")})
            ledger_added += 1
            out_extra = {"ticket_id": ticket_id, "status": "closed"}

    # 对方的可见变化：投递登记（同一个事件类型 + mirror 标记；对方的工单队列由此可读）
    other_notice = ""
    if other_path is not None and applied:
        o_rows, o_error = load_rows(other_path)
        if o_error is not None or o_rows is None:
            return usage_error("ledger-unreadable", str(o_error), "先修对方账本（本脚本不往坏账本追加）")
        o_realm = realm_of(o_rows, "")
        if o_realm == "":
            return usage_error("counterpart-realm-unknown", "对方账本还没有 realm（不猜写给谁）",
                               "先让对方产生一条事实，或省略 --ledger-supplier/--ledger-contractor")
        try:
            o_ledger = Ledger(other_path, realm=o_realm)
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修对方账本")
        snapshot_ticket = service.tickets.get(str(out_extra.get("ticket_id") or ""), {})
        if step == "ask":
            body = {"ticket_id": out_extra.get("ticket_id"), "package_id": package_id,
                    "rfq_rev": out_extra.get("rfq_rev") or record.get("rfq_rev"),
                    "refs": snapshot_ticket.get("refs") or {"item_ids": [str(item) for item in (record.get("item_ids") or [])]},
                    "asker_realm": realm, "question": text, "status": "open", "mirror": True,
                    "delivered_by": actor, "delivered_at": args.now,
                    "note": "投递登记：对方就本包提出了这条澄清（回答人在对方侧）"}
            o_ledger.append("clarification/asked", body, actor=actor, ts=args.now,
                            refs={"ticket_id": str(out_extra.get("ticket_id") or "")})
        elif step == "answer":
            body = {"ticket_id": out_extra.get("ticket_id"),
                    "package_id": snapshot_ticket.get("package_id"),
                    "rfq_rev": snapshot_ticket.get("rfq_rev"), "by": actor, "text": text, "fields": {},
                    "stripped": [], "broadcast_at": None, "mirror": True,
                    "delivered_by": actor, "delivered_at": args.now,
                    "note": "投递登记：业主的答复（未广播前只有提问方看得见这条）"}
            o_ledger.append("clarification/answered", body, actor=actor, ts=args.now,
                            refs={"ticket_id": str(out_extra.get("ticket_id") or "")})
        elif step == "broadcast":
            body = {"ticket_id": out_extra.get("ticket_id"), "package_id": snapshot_ticket.get("package_id"),
                    "rfq_rev": snapshot_ticket.get("rfq_rev"),
                    "broadcast_at": args.now, "broadcast_to": list(out_extra.get("broadcast_to") or []),
                    "broadcast_complete": True, "answer_sha256": digest_of(str(snapshot_ticket.get("answer", {}).get("text") or "")),
                    "mirror": True, "delivered_by": actor, "delivered_at": args.now,
                    "note": "投递登记：答复已广播给在册投标人"}
            o_ledger.append("clarification/answered", body, actor=actor, ts=args.now,
                            refs={"ticket_id": str(out_extra.get("ticket_id") or "")})
        else:
            body = {"ticket_id": out_extra.get("ticket_id"), "package_id": snapshot_ticket.get("package_id"),
                    "status": "closed", "closed_at": args.now, "mirror": True,
                    "delivered_by": actor, "delivered_at": args.now, "note": "投递登记：工单已关闭"}
            o_ledger.append("clarification/asked", body, actor=actor, ts=args.now,
                            refs={"ticket_id": str(out_extra.get("ticket_id") or "")})
        ledger_added += 1
        other_notice = str(other_path)

    archived = archive(inbox, request) if request.resolve().parent in (inbox.resolve(),) else ""
    hint = {
        "ask": "工单已建：对方侧队列里立刻出现「待回答」（未答时长按事实时刻算）。",
        "answer": "答复已落账：**还没广播**——发布前只有提问方看得见；要全员可见就点「广播」。",
        "broadcast": "已广播给在册投标人（名单完整，INV-006 满足）；之后才能关闭工单。",
        "close": "工单已关闭（关闭前置是完整广播）。",
    }[step]
    return emit({"ok": True, "step": step, "event": applied[-1]["event"] if applied else None,
                 "applied": applied, "duplicates": [], "ledger_added": ledger_added, "refusal": None,
                 "request": str(request), "archived": archived, "view": view, "by": actor,
                 "registered_bidders": registered, "seeded_tickets": seeded,
                 "counterpart_notice": other_notice, "next_action_runtime": hint,
                 "note": "澄清单据四个步都只落已登记事件（clarification/asked|answered|broadcast-incomplete|"
                         "rejected）；答复人必须是 human:*",
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
