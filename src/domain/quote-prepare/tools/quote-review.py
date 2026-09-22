#!/usr/bin/env python3
"""src/domain/quote-prepare/tools/quote-review.py —— 「承包商受理/退回/要求补件」的**唯一落账本者**
（DEF-011 / 界面规格 C5）。

写路径拆成两段（与 `quote-draft.py` / `rfq-publish.py` 同规格）：宿主只落 0600 待办件，本脚本落账。

落什么账（**全部是已登记的事件类型**；新增事件类型属于账本格式变更，须先有 ADR ⇒ 本轮不新造）：

  · 承包商账本 `approval/requested` + `approval/granted`（**受理**）或 `approval/denied`（**退回/要求补件**）
    —— 受理者是人（`human:*`，`ApprovalService.decide` 自己会把 `agent:*` 拒掉），
    `scope` 携带判定：`quote-review:accepted` / `quote-review:returned` / `quote-review:need-info`
    （`ApprovalService._append` 只把 approval_id/scope/ref/payload_hash/status/decided_by/comment 写进账本，
    所以判定必须落在 `scope` 上才可回读；意见逐字落 `comment`）。
  · 承包商账本 `mail/refused` —— 「通知对方」这件事**绝不假装已发**：无 SMTP 凭据时如实报
    `mail-transport-unavailable` + `next_action`。
  · **供应商账本** `mail/queued`（`kind=rfq-notice`，subject 前缀「报价评审：」）—— 对方的可见变化
    （只含判定与承包商愿意披露的理由，**不含内部备注**）；可读的正文另一份落
    `<ui-shared>/exchange/quote-reviews.json`。理由正文不进账本（账本只留 sha256）。

拒绝路径（**账本零新增**）：`quote-not-found`（本侧账本没有这条 `quote/submitted`）、
`quote-superseded`（已被新版作废，不允许受理）、`already-reviewed`（同一报价已判定过，可回读上一次）、
`reason-required` / `reason-too-long`（退回/补件必填理由，≤500 字）、`human-required`。

用法：
  python3 src/domain/quote-prepare/tools/quote-review.py --request <pending.json> --now 2026-09-22T15:00:00Z \\
      --ledger-contractor .../contractor/ledger.jsonl --ledger-supplier .../supplier/ledger.jsonl
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

from quotagent.services.approval import ApprovalService  # noqa: E402
from quotagent.services.mail import MailService  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "quote-review"
ACTION = "review"
MAIL_KIND = "rfq-notice"
SUBJECT_PREFIX = "报价评审："
DECISIONS = ("accepted", "returned", "need-info")
SCOPE_PREFIX = "quote-review:"
MAX_REASON = 500
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


def deny(code: str, reason: str, next_action: str, request: str = "") -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "request": request, "refusal": refusal(code, reason, next_action)}, 1)


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


def read_pending(path: Path) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（APP 里点受理/退回会落它）")
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
                             "这份待办件不是报价受理的载荷")
    if record.get("action") != ACTION:
        return None, refusal("action-not-review", f"action 不是 {ACTION}：{record.get('action')!r}", "用受理动作的待办件")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件")
    note = str(record.get("note") or "")
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与理由正文长度不一致", "让宿主重落待办件")
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


def reviews_in(rows: list[dict]) -> dict[str, dict]:
    """从账本回读已有的受理判定：`{quote_id: {decision, status, by, comment, approval_id, at}}`。

    判定读 `approval/*` 行的 `scope`（`quote-review:<decision>`）——**只看账本**，不看任何页面状态。
    """
    out: dict[str, dict] = {}
    for row in rows:
        if not str(row.get("type") or "").startswith("approval/"):
            continue
        body = body_of(row)
        scope = str(body.get("scope") or "")
        if not scope.startswith(SCOPE_PREFIX):
            continue
        quote_id = str(body.get("ref") or "")
        if not quote_id:
            continue
        entry = out.setdefault(quote_id, {"quote_id": quote_id, "decision": scope[len(SCOPE_PREFIX):],
                                          "status": "pending", "by": None, "comment": "", "at": "",
                                          "approval_id": body.get("approval_id")})
        status = str(body.get("status") or "")
        if status in ("granted", "denied"):
            entry.update({"status": status, "by": body.get("decided_by"), "comment": body.get("comment") or "",
                          "at": str(row.get("ts") or ""), "approval_id": body.get("approval_id")})
    return out


def bump_counter(approvals: ApprovalService, rows: list[dict]) -> int:
    """把批准序号推到**账本里已用过的最大序号之后**。

    为什么需要：`ApprovalService.__init__` 在 `replay()` 之后无条件 `self._counter = 0`
    （见 `src/system/approval/code/approval.py`），于是**每个新进程都从 `ap-0001` 起**——
    跨进程动作（GUI 一次一进程）会在同一账本上产出重号的批准记录（同一账本上已经出现过两个 `ap-0001`）。
    这里不改服务（那是它的语义），只把计数器推到安全位置：新门的 id 与已有 id 不重号。
    """
    highest = 0
    for row in rows:
        if not str(row.get("type") or "").startswith("approval/"):
            continue
        value = str(body_of(row).get("approval_id") or "")
        suffix = value.rsplit("-", 1)[-1]
        if suffix.isdigit():
            highest = max(highest, int(suffix))
    approvals._counter = highest                      # noqa: SLF001 —— 下一个 request 得到 ap-(highest+1)
    return highest


def notices_of(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []
    items = data.get("reviews") if isinstance(data, dict) else None
    return list(items) if isinstance(items, list) else []


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="报价受理/退回/要求补件（GUI 写动作的服务端一半；唯一落账本者）")
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="", help="对方账本（写一条通知登记：对方看得见）")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-22T15:00:00Z")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                         "refusal": None, "pending": 0, "note": "待办件目录空（空跑，不是失败）"}, 0)
        request = candidates[0]
    record, deny_reason = read_pending(request)
    if deny_reason is not None:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "request": str(request), "refusal": deny_reason}, 1)
    assert record is not None

    quote_id = str(record.get("quote_id") or "").strip()
    if not ID_RE.match(quote_id):
        return deny("quote-id-malformed", f"quote_id 形状非法：{quote_id!r}",
                    "从报价收件箱的行里取 quote_id（形如 q-…）", str(request))
    decision = str(record.get("decision") or "").strip()
    if decision not in DECISIONS:
        return deny("decision-unknown", f"decision 必须是 {DECISIONS} 之一：{decision!r}",
                    "选 受理 / 退回 / 要求补件", str(request))
    actor = str(record.get("actor") or "").strip()
    if not actor.startswith("human:"):
        return deny("human-required", "受理是人做的判定：actor 必须以 human: 开头",
                    "写 human:<你的名字>（agent 不得代人受理）", str(request))
    reason = str(record.get("note") or "")
    if decision != "accepted" and reason.strip() == "":
        return deny("reason-required", f"{decision} 必须给理由（供应商要知道改什么）",
                    "在「意见」里写清楚：哪一条不对、要补什么", str(request))
    if len(reason) > MAX_REASON:
        return deny("reason-too-long", f"理由 {len(reason)} 字超过上限 {MAX_REASON}",
                    "压到 500 字以内", str(request))

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    quotes: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "quote/submitted":
            continue
        body = body_of(row)
        qid = str(body.get("quote_id") or "")
        if not qid:
            continue
        entry = quotes.setdefault(qid, {"quote_id": qid, "package_id": body.get("package_id") or "",
                                        "supplier": body.get("supplier") or "", "items": [],
                                        "submitted_at": str(row.get("ts") or "")})
        entry["items"].append({"item_id": body.get("item_id"), "unit_price_cents": body.get("unit_price_cents"),
                               "lead_time_days": body.get("lead_time_days")})
    if quote_id not in quotes:
        return deny("quote-not-found", f"本侧账本里没有报价 {quote_id}",
                    "从报价收件箱列出的真报价 id 里选一条（不猜、不凭 URL）", str(request))
    quote = quotes[quote_id]
    reviewed = reviews_in(rows)
    previous = reviewed.get(quote_id)
    if previous is not None and previous["status"] in ("granted", "denied"):
        return deny("already-reviewed",
                    f"报价 {quote_id} 已经判定过：{previous['decision']}（by {previous['by']} @ {previous['at']}）",
                    "一条报价只受理一次；要改判定只能走变更/重新报价（账本不可改写）", str(request))
    superseded = any(str(row.get("type")) == "quote/superseded"
                     and str(body_of(row).get("quote_id") or "") == quote_id for row in rows)
    if superseded and decision == "accepted":
        return deny("quote-superseded",
                    f"报价 {quote_id} 已被包的新版本作废：受理它没有意义",
                    "让对方按最新 rev 重报（「报价收件箱」会给最新版本号），或退回并说明原因", str(request))

    realm = realm_of(rows, "contractor:gui")
    key = digest_of(canonical(record))
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous_record = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous_record = {}
        if digest_of(canonical(previous_record)) == key:
            return emit({"ok": True, "event": "approval/granted", "applied": [],
                         "duplicates": [{"quote_id": quote_id, "reason": "already-applied", "key": key}],
                         "ledger_added": 0, "refusal": None, "request": str(request),
                         "note": "同一份载荷已经消费过（归档件逐字节一致）：账本零新增（幂等）"}, 0)
    if args.dry_run:
        return emit({"ok": True, "dry_run": True, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refusal": None, "quote_id": quote_id, "decision": decision,
                     "note": "干跑：校验通过、账本零新增、通知未写"}, 0)

    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")

    applied: list[dict] = []
    ledger_added = 0
    # ---- ① 判定落账：人工门（受理 = granted；退回/补件 = denied）--------------------------------
    approvals = ApprovalService(ledger=ledger, actor=actor)
    bump_counter(approvals, rows)
    scope = f"{SCOPE_PREFIX}{decision}"
    request_row = approvals.request(scope, {"quote_id": quote_id, "decision": decision,
                                            "reason_sha256": digest_of(reason)},
                                    ref=quote_id, approvers=[actor], reason=reason,
                                    summary=f"{decision} 报价 {quote_id}（{quote['supplier']}）")
    led = approvals.decide(request_row["approval_id"], by=actor,
                           decision="granted" if decision == "accepted" else "denied", comment=reason)
    applied.append({"event": "approval/requested", "approval_id": request_row["approval_id"], "scope": scope,
                    "ref": quote_id})
    applied.append({"event": "approval/granted" if decision == "accepted" else "approval/denied",
                    "approval_id": request_row["approval_id"], "decided_by": actor, "comment": reason})
    ledger_added += 2

    # ---- ② 对方通知（**收件人侧的可见变化**）：供应商账本 mail/queued ------------------------------
    supplier_notice = ""
    disclosed = {"accepted": "承包商已受理这份报价", "returned": "承包商退回了这份报价",
                 "need-info": "承包商要求补件"}[decision]
    letter = f"{disclosed}：{quote_id}（包 {quote['package_id']}）。{('理由：' + reason) if reason else ''}"
    notices_path = ui_shared / "exchange" / "quote-reviews.json"
    notices = notices_of(notices_path)
    notices.append({"kind": KIND, "quote_id": quote_id, "package_id": quote["package_id"],
                    "decision": decision, "letter": letter, "by": actor, "at": args.now,
                    "approval_id": request_row["approval_id"]})
    notices_path.parent.mkdir(parents=True, exist_ok=True)
    notices_path.write_text(json.dumps({"reviews": notices[-500:]}, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                            encoding="utf-8")
    if args.ledger_supplier:
        s_rows, s_error = load_rows(Path(args.ledger_supplier))
        if s_error is not None or s_rows is None:
            return usage_error("ledger-unreadable", str(s_error), "先修对方账本")
        s_realm = realm_of(s_rows, "")
        if s_realm == "":
            return usage_error("supplier-realm-unknown", "对方账本还没有 realm（不猜写给谁）", "先让对方产生一条事实")
        try:
            s_ledger = Ledger(Path(args.ledger_supplier), realm=s_realm)
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修对方账本")
        s_mail = MailService(realm=s_realm, ledger=s_ledger)
        try:
            message = s_mail.compose(kind=MAIL_KIND, package_id=quote["package_id"], rfq_rev=1, sender=actor,
                                     to=[s_realm], subject=f"{SUBJECT_PREFIX}{decision} {quote_id}",
                                     body=letter, date=args.now)
            queued = s_mail.enqueue(message=dict(message))
            refused_row = s_mail.deliver(message_id=str(queued.get("message_id")))
        except Exception as exc:  # noqa: BLE001
            return usage_error("letter-rejected", f"{type(exc).__name__}: {exc}", "改披露正文后重提")
        applied.append({"event": "mail/queued", "view": "supplier", "message_id": queued.get("message_id"),
                        "seq": queued.get("seq"), "duplicate": bool(queued.get("duplicate")),
                        "ledger": str(args.ledger_supplier)})
        applied.append({"event": "mail/refused", "view": "supplier", "status": refused_row.get("status"),
                        "reason": refused_row.get("reason")})
        if not queued.get("duplicate"):
            ledger_added += 1
        supplier_notice = str(args.ledger_supplier)

    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    label = {"accepted": "已受理", "returned": "已退回", "need-info": "已要求补件"}[decision]
    return emit({"ok": True, "event": "approval/granted" if decision == "accepted" else "approval/denied",
                 "applied": applied, "duplicates": [], "ledger_added": ledger_added, "refusal": None,
                 "request": str(request), "archived": archived, "quote_id": quote_id, "decision": decision,
                 "status": led.get("status"), "approval_id": request_row["approval_id"], "by": actor,
                 "notices": str(notices_path), "supplier_notice": supplier_notice,
                 "next_action_runtime": f"报价 {quote_id} {label}（账本可回读）；供应商侧看得到「{label}」"
                                        "（只有判定与披露理由，不含内部备注）。邮件通道不可用时通知未发出——"
                                        "可复制 exchange/quote-reviews.json 里的正文给对方。",
                 "note": "受理/退回/补件是人签判定（approval/requested → granted|denied，scope 带判定）；"
                         "一条报价只判定一次，判定不可改写"}, 0)


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
