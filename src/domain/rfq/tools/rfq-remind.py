#!/usr/bin/env python3
"""src/domain/rfq/tools/rfq-remind.py —— 「承包商在 APP 里一键催报」的**唯一落账本者**
（DEF-013 / 界面规格 C3：勾选未回的供应商 → 催报 → 真落账 + 给对方出通知）。

为什么需要它：WebUI 是完整 GUI 应用，但**不是第二条事实写路径**（`AGENTS.md` 规则 1/2/3；
`docs/design/29-webui-gui-app.md` §3）。所以「催报」拆成两段（与 `rfq-publish.py` 同规格）：

  ① 宿主（`app-shell.mjs` 的动作服务端一半）只落**一条 0600 待办件**
     `<ui-shared>/rfq-remind/<pp>-<12hex>.json`：包 id / 版本 / 收件人 / 主题 / 正文（`note`）/
     临近阈值 / 发言人 —— **账本零新增**；
  ② 本脚本：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ **重算校验**
     （`payload_sha256` / `bytes` / `submitted_at`）→ 业务前置（目标包必须**真的在本侧账本里**，
     收件人必须在邀请名单里）→ 落账 → 待办件移入 `applied/`。

落什么账（**全部是已登记的事件类型**，不新造）：

  · 承包商账本 `mail/queued`（`services/mail.py`：`kind=rfq-remind`）—— **催报本体**：
    "谁在何时就哪个包的哪个版本向谁发了催报（正文只留 `body_sha256`）"。重复催报的计数就由这一族
    行给出（面板上的「已催 N 次 @ts」直接读它）。
  · 承包商账本 `mail/refused`（`MailService.deliver` 的**唯一**结果面）—— **绝不假装已发**：
    没有 SMTP 凭据时如实给 `mail-smtp-unconfigured` + `next_action`，并给出可复制的通知正文文件。
  · 承包商账本 `rfq/due-soon` / `rfq/overdue`（`RfqService.remind`，判定权在服务里）——
    临近/已过截止的那条**时限事实**（同一版本同一截止同一状态只提醒一次，服务自己幂等）。
  · **供应商账本** `mail/queued` —— 对方的通知（"我这边收到催报"这条事实）；正文正文同样只留哈希，
    可读的那一份落在共享交换目录 `exchange/reminders.json`（与 `exchange/award-intents.json` 同模式）。

纪律：
  · 用法/环境错误在**构造 Ledger 之前**返回（拒绝时连空账本文件都不创建）；
  · `--now` 必填且合法 ISO8601（**不读墙钟**）；发言人必须 `human:*`（催报有人认领）；
  · 幂等：同一 `(package_id, rev, recipients, subject, body)` 已入队 ⇒ `duplicates` + 账本零新增 + exit 0；
  · 拒绝时**账本零新增**，每条给 `code` + `next_action`；
  · stdout 恰一行 JSON；退出码 0 = 已落或幂等、1 = 有拒绝、2 = 用法/环境错误。

用法：
  python3 src/domain/rfq/tools/rfq-remind.py --request <pending.json> --now 2026-09-22T09:00:00Z \
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

from quotagent.kernel.events import EventBus  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402
from quotagent.services.mail import MailService  # noqa: E402
from quotagent.services.rfq import RfqService  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
PP_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "rfq-remind"
ACTION = "remind"
MAIL_KIND = "rfq-notice"          # `docs/design/19-mail-contract.md` §2 的闭合取值之一（不私开新种类）
SUBJECT_PREFIX = "催报："          # 催报在本侧/对方账本上的识别前缀（mail/queued 的 subject）
MAX_FILE_BYTES = 262144
MAX_NOTE_BYTES = 8192
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
EVENT_NUDGE = "mail/queued"


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
    """待办件的规范化 JSON（与宿主逐字节一致：键排序 + 无空格 + 不转义非 ASCII）。"""
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
    """权限门 + 形状门 + 重算校验。返回 `(record, refusal)`（二者恰一个为 None）。"""
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}",
                             "让宿主先落待办件（APP 里点「催报」会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}",
                             "待办件必须是宿主落的普通文件（不要用符号链接/管道）")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600",
                             "chmod 600 待办件再消费（宿主落盘时就是 0600）")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限 {MAX_FILE_BYTES}",
                             "把催报正文压到 8KB 以内（收件人多时分开催）")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA:
        return None, refusal("pending-schema-unknown", f"schema 不是 {SCHEMA}：{record.get('schema')!r}",
                             "让宿主按 schema 重落待办件")
    if record.get("kind") != KIND:
        return None, refusal("pending-kind-unknown", f"kind 不是 {KIND}：{record.get('kind')!r}",
                             "这份待办件不是催报的载荷")
    if record.get("action") != ACTION:
        return None, refusal("action-not-remind", f"action 不是 {ACTION}：{record.get('action')!r}",
                             "用催报动作的待办件")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟，时间由 --now 给）",
                             "让宿主重落待办件（submitted_at 留空）")
    expected = digest_of(canonical(record))
    if str(record.get("payload_sha256") or "") != expected:
        return None, refusal("pending-tampered",
                             f"payload_sha256 与重算不一致（给出 {record.get('payload_sha256')!r}）",
                             "让宿主重落待办件（改了载荷就要重算哈希）")
    note = str(record.get("note") or "")
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与催报正文长度不一致", "让宿主重落待办件")
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


def snapshot_of(ui_shared: Path, package_id: str) -> dict | None:
    """本侧的包快照（唯一写者 `rfq-publish.py` 落的）：给邀请名单与包版本。"""
    candidates = sorted((ui_shared / "contractor").glob(f"rfq-{package_id}-rev*.json"))
    if not candidates:
        return None
    try:
        return json.loads(candidates[-1].read_text(encoding="utf-8"))
    except ValueError:
        return None


def seed_rfq(service: RfqService, rows: list[dict], snapshot: dict | None) -> dict:
    """把 `RfqService` 的已发布版本登记从**账本 + 本侧包快照**重建（重启后同样成立）。

    为什么要重建：`remind()` / `deadline_status()` 判的是"已发布版本"，而跨进程动作
    （GUI 的动作一次一进程）没有这一步就会把已发布的包判成不存在。快照体不进账本
    （见 `rfq-publish.py`），所以版本号/截止/行项目从<ui-shared>/contractor 的快照取，
    版本存在性以账本 `rfq/published` 行为准。
    """
    published_revs: list[int] = []
    published_at: dict[int, str] = {}
    for row in rows:
        if str(row.get("type")) != "rfq/published":
            continue
        body = body_of(row)
        rev = body.get("rev")
        if isinstance(rev, int) and rev > 0:
            published_revs.append(rev)
            published_at[rev] = str(row.get("ts") or "")
    if not published_revs:
        return {"revs": [], "seeded": 0}
    spec = dict((snapshot or {}).get("spec") or {})
    revs = sorted(set(published_revs))
    seeded = 0
    for rev in revs:
        snap = dict(spec)
        snap.update({"rev": rev, "status": "published", "published_at": published_at.get(rev, "")})
        snap.setdefault("scope", [snap.get("subject") or snap.get("package_id") or ""])
        snap.setdefault("items", [])
        snap.setdefault("deadlines", {})
        snap.setdefault("currency", "CNY")
        snap.setdefault("interfaces", [])
        snap.setdefault("deliverables", [])
        snap.setdefault("exclusions", [])
        snap.setdefault("package_id", (snapshot or {}).get("package_id") or "")
        service._store(rev, snap)                      # noqa: SLF001 —— 与 commitment-apply.py 的 seed_gate 同模式
        seeded += 1
    service._current_rev = revs[-1]                      # noqa: SLF001
    rem, overdue = set(), set()
    for key, event in (("rfq/due-soon", "due-soon"), ("rfq/overdue", "overdue")):
        for row in rows:
            if str(row.get("type")) != key:
                continue
            body = body_of(row)
            rem.add((int(body.get("rev") or 0), str(body.get("deadline") or ""), event))
            if event == "overdue":
                overdue.add(int(body.get("rev") or 0))
    service._reminded = rem                              # noqa: SLF001
    return {"revs": revs, "seeded": seeded, "reminded": sorted(rem)}


def reminder_notices(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []
    items = data.get("reminders") if isinstance(data, dict) else None
    return list(items) if isinstance(items, list) else []


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="催报（GUI 写动作的服务端一半；唯一落账本者）")
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="", help="待办件目录（消费文件名最小的那条）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="",
                        help="对方账本（给定时写一条**投递登记**：我收到了催报 —— 收件人侧的可见变化）")
    parser.add_argument("--actor", default="")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601",
                           "显式给时间：--now 2026-09-22T09:00:00Z（本脚本不读墙钟）")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                         "refusal": None, "pending": 0,
                         "note": "待办件目录里没有待消费的载荷（这是空跑，不是失败）"}, 0)
        request = candidates[0]
    record, deny_reason = read_pending(request)
    if deny_reason is not None:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "request": str(request), "refusal": deny_reason}, 1)
    assert record is not None

    package_id = str(record.get("package_id") or "").strip()
    if not PP_RE.match(package_id):
        return deny("package-id-malformed", f"package_id 形状非法：{package_id!r}",
                    "包 id 用字母数字开头、只含 [A-Za-z0-9._-]", str(request))
    actor = str(record.get("actor") or args.actor).strip() or args.actor
    if not actor.startswith("human:"):
        return deny("human-required", "催报必须有人认领：actor 必须以 human: 开头",
                    "写 human:<你的名字>（agent 不得以你的名义催报）", str(request))
    recipients = [str(who).strip() for who in (record.get("recipients") or []) if str(who).strip()]
    if not recipients:
        return deny("recipients-empty", "没有收件人：至少要催一家",
                    "在「回文时限」页勾选未回的供应商后重提", str(request))
    bad = [who for who in recipients if not REALM_RE.match(who)]
    if bad:
        return deny("recipient-malformed", f"收件人形状非法：{bad}",
                    "收件人写 realm 形状（如 supplier:g1）", str(request))
    letter = str(record.get("note") or "")
    if letter.strip() == "":
        return deny("empty-note", "催报正文为空",
                    "写一句话再催（对方要能看懂你要他做什么）", str(request))
    if len(letter.encode("utf-8")) > MAX_NOTE_BYTES:
        return deny("note-too-large", f"催报正文 {len(letter.encode('utf-8'))} 字节超过 {MAX_NOTE_BYTES}",
                    "压到 8KB 以内（附件/长文放包快照，不要塞进催报）", str(request))
    try:
        soon_hours = float(record.get("soon_hours") or 24.0)
    except (TypeError, ValueError):
        return deny("soon-hours-invalid", f"soon_hours 不是数：{record.get('soon_hours')!r}",
                    "给一个数（小时；如 24）", str(request))
    if soon_hours < 0 or soon_hours > 24 * 365:
        return deny("soon-hours-out-of-range", f"soon_hours 越界：{soon_hours}",
                    "给 [0, 8760] 内的小时数", str(request))
    subject = str(record.get("subject") or "").strip() or f"{SUBJECT_PREFIX}{package_id}"
    if not subject.startswith(SUBJECT_PREFIX):
        subject = f"{SUBJECT_PREFIX}{subject}"

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    published = [body_of(row) for row in rows if str(row.get("type")) == "rfq/published"
                 and str(body_of(row).get("package_id") or "") == package_id]
    if not published:
        return deny("package-not-found", f"本侧账本里没有已发布的包 {package_id}",
                    "先在「发包」里发布这一包（催报只能针对本侧真的发布过的包）", str(request))
    latest = max(int(item.get("rev") or 0) for item in published)
    rev = record.get("rev")
    rev = int(rev) if isinstance(rev, int) else latest
    if rev not in [int(item.get("rev") or 0) for item in published]:
        return deny("rev-not-published", f"rev{rev} 不是本侧已发布的版本（已发布：{[int(item.get('rev') or 0) for item in published]}）",
                    f"改催 rev{latest}，或先发布该版本", str(request))
    snapshot = snapshot_of(ui_shared, package_id)
    invited = [str(who) for who in ((snapshot or {}).get("invited") or [])]
    if not invited:
        for row in rows:
            if str(row.get("type")) != "rfq/distributed":
                continue
            body = body_of(row)
            if str(body.get("package_id") or "") != package_id:
                continue
            invited = [str(who) for who in (body.get("recipients") or [])]
    strangers = [who for who in recipients if invited and who not in invited]
    if strangers:
        return deny("recipient-not-invited", f"收件人不在本包的邀请名单里：{strangers}（邀请名单：{invited}）",
                    "只催被邀请的供应商（不猜、不群发）", str(request))

    realm = realm_of(rows, "contractor:gui")
    key = digest_of(canonical(record))
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous = {}
        if digest_of(canonical(previous)) == key:
            return emit({"ok": True, "event": EVENT_NUDGE, "applied": [],
                         "duplicates": [{"package_id": package_id, "rev": rev, "reason": "already-applied", "key": key}],
                         "ledger_added": 0, "refusal": None, "request": str(request),
                         "archived": str(archived_before),
                         "note": "同一份载荷已经消费过（归档件逐字节一致）：账本零新增，催报是幂等动作"}, 0)
    if args.dry_run:
        return emit({"ok": True, "event": EVENT_NUDGE, "dry_run": True, "applied": [], "duplicates": [],
                     "ledger_added": 0, "refusal": None, "package_id": package_id, "rev": rev,
                     "recipients": recipients, "note": "干跑：校验通过、账本零新增、通知未写"}, 0)

    bus = EventBus()
    bus.install_defaults()
    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")

    applied: list[dict] = []
    ledger_added = 0

    # ---- ① 承包商侧的**催报本体**：mail/queued（正文只留 sha256 进账本）----------------------------
    stamp_subject = f"{subject}（第 @{args.now} 次催报 · rev{rev}）"
    mail = MailService(realm=realm, ledger=ledger)
    status = mail.transport_status()
    try:
        message = mail.compose(kind=MAIL_KIND, package_id=package_id, rfq_rev=rev, sender=actor,
                               to=list(recipients), subject=stamp_subject, body=letter, date=args.now)
    except Exception as exc:  # noqa: BLE001 —— compose 的三种拒绝（头注入/私域/附件）都不落账
        return deny("letter-rejected", f"{type(exc).__name__}: {exc}",
                    "改催报正文（不得含凭据/私域字段，也不得含换行头注入）后重提", str(request))
    queued = mail.enqueue(message=dict(message))
    if queued.get("duplicate"):
        applied.append({"event": EVENT_NUDGE, "view": "contractor", "duplicate": True,
                        "message_id": queued.get("message_id"), "seq": queued.get("seq")})
    else:
        applied.append({"event": EVENT_NUDGE, "view": "contractor", "message_id": queued.get("message_id"),
                        "seq": queued.get("seq"), "recipients": recipients, "package_id": package_id,
                        "rfq_rev": rev})
        ledger_added += 1
    refused_row = mail.deliver(message_id=str(queued.get("message_id")))
    applied.append({"event": "mail/refused", "view": "contractor",
                    "status": refused_row.get("status"), "reason": refused_row.get("reason"),
                    "transport_available": bool(status.get("available"))})

    # ---- ② 对方的通知（**收件人侧的可见变化**）：供应商账本 mail/queued ---------------------------
    supplier_notice = ""
    if args.ledger_supplier:
        s_rows, s_error = load_rows(Path(args.ledger_supplier))
        if s_error is not None or s_rows is None:
            return usage_error("ledger-unreadable", str(s_error), "先修对方账本（本脚本不往坏账本追加）")
        s_realm = realm_of(s_rows, "") or (recipients[0] if len(recipients) == 1 else "")
        if s_realm == "":
            return usage_error("supplier-realm-unknown", "对方账本还没有 realm，且收件人不止一个（不猜写给谁）",
                               "一次只催一家，或先让对方产生一条事实")
        if s_realm not in recipients:
            return usage_error("ledger-not-addressed", f"对方账本 realm={s_realm} 不在收件人 {recipients} 里（拒绝写给没被催的账本）",
                               "收件人名单与对方账本要对得上（不猜）")
        try:
            s_ledger = Ledger(Path(args.ledger_supplier), realm=s_realm)
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修对方账本")
        s_mail = MailService(realm=s_realm, ledger=s_ledger)
        try:
            notice = s_mail.compose(kind=MAIL_KIND, package_id=package_id, rfq_rev=rev, sender=actor,
                                    to=[s_realm], subject=stamp_subject, body=letter, date=args.now)
            s_queued = s_mail.enqueue(message=dict(notice))
        except Exception as exc:  # noqa: BLE001
            return usage_error("letter-rejected", f"{type(exc).__name__}: {exc}", "改催报正文后重提")
        applied.append({"event": EVENT_NUDGE, "view": "supplier", "message_id": s_queued.get("message_id"),
                        "seq": s_queued.get("seq"), "ledger": str(args.ledger_supplier),
                        "duplicate": bool(s_queued.get("duplicate"))})
        if not s_queued.get("duplicate"):
            ledger_added += 1
        supplier_notice = str(args.ledger_supplier)

    # ---- ③ 时限事实（临近/已过截止）：判定权在 RfqService --------------------------------------
    rfq = RfqService(ledger=ledger, events=bus, actor=actor)
    seeded = seed_rfq(rfq, rows, snapshot)
    fired: list[dict] = []
    try:
        result = rfq.remind(rev=rev, now=args.now, soon_hours=soon_hours)
        fired = list(result.get("fired") or [])
    except Exception as exc:  # noqa: BLE001 —— 服务的门就是门：拒就如实报（不兜底）
        fired = []
        applied.append({"event": "rfq/due-soon", "degraded": True, "reason": f"{type(exc).__name__}: {exc}"})
    ledger_added += len(fired)

    # ---- ④ 可读的那一份：共享交换目录里的通知（正文不进账本）-----------------------------------
    notices_path = ui_shared / "exchange" / "reminders.json"
    notices = reminder_notices(notices_path)
    notices.append({"kind": MAIL_KIND, "package_id": package_id, "rev": rev, "recipients": recipients,
                    "subject": stamp_subject, "letter": letter, "by": actor, "at": args.now,
                    "message_id": queued.get("message_id"),
                    "mail_transport": {"available": bool(status.get("available")),
                                       "reason": status.get("reason"), "next_action": status.get("next_action")}})
    notices_path.parent.mkdir(parents=True, exist_ok=True)
    notices_path.write_text(json.dumps({"reminders": notices[-200:]}, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                            encoding="utf-8")

    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    next_action = ("催报已落账：本侧 `mail/queued`（催报本体）+ 对方账本 `mail/queued`（对方可见）。"
                   + ("时限事实 " + ", ".join(sorted({row['event'] for row in fired})) + " 也已落。"
                      if fired else f"当前距截止未进入 {soon_hours:g}h 窗口 ⇒ 只落催报、不落时限事实（可用「临近阈值」调大）。")
                   + ("邮件通道不可用（" + str(status.get("reason")) + "）：通知**没有发出**，"
                      "可复制正文文件给对方——绝不假装已发。"
                      if not status.get("available") else ""))
    return emit({"ok": True, "event": EVENT_NUDGE, "applied": applied, "duplicates": [], "ledger_added": ledger_added,
                 "refusal": None, "request": str(request), "archived": archived,
                 "package_id": package_id, "rev": rev, "recipients": recipients, "by": actor,
                 "pending_file": str(request), "notices": str(notices_path),
                 "counts": {"reminders": len(notices), "deadline_events": len(fired)},
                 "seeded": seeded, "fired": fired,
                 "mail_transport": {"available": bool(status.get("available")), "reason": status.get("reason"),
                                    "next_action": status.get("next_action")},
                 "supplier_notice": supplier_notice,
                 "message_id": queued.get("message_id"),
                 "next_action_runtime": next_action,
                 "note": "催报＝本侧 mail/queued + 对方 mail/queued（双向可断言）；正文只留哈希，可读的一份在 exchange/reminders.json"}, 0)


def crash_guard(fn, argv):
    """意外异常也必须是**一行 JSON**：宿主据此如实报错、不假装成功。"""
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 —— 兜底只报错，不落任何东西
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed", "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
