#!/usr/bin/env python3
"""tools/rfq-publish.py —— 「承包商在 APP 里发布 RFQ」的**唯一落账本者**（GUI 零写账、H1）。

为什么需要它：WebUI（`src/system/webui/code/`）是**完整 GUI 应用**，但它**不是第二条事实写路径**
（`AGENTS.md` 规则 1/2/3；`docs/design/29-webui-gui-app.md` §3）。所以「发布 RFQ」这个写动作拆成两段：

  ① 宿主（Node，`src/system/webui/code/app-shell.mjs` 的 action 服务端一半）只落**一条 0600 待办件**
     `<ui-shared>/rfq-publish/<pp>-<12hex>.json`：包 id / 标题 / 行项目 / 截止 / 邀请对象 / 发言人 —— 账本零新增；
  ② 本脚本（**唯一落账本者**）：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ **重算校验**
     （`payload_sha256` / `bytes` / `submitted_at` 必须与重算一致）→ 用**真服务** `RfqService`
     （`src/domain/rfq/code/rfq.py`）建包 + 发布 + 分发 ⇒ 落 `rfq/published` 与 `rfq/distributed`；
     并把**投递信封**（`{delivered_to, rev, sent_at, snapshot_hash, spec}`，与 g1 走查 `01-package.json`
     同形）写给被邀供应商 —— 供应商视角**只出自己那份**（白名单在 `src/system/projection`）。

纪律（与 `quote-draft.py` / `quote-sign.py` 同规格）：
  · 用法/环境错误在**构造 Ledger 之前**返回（拒绝时连空账本文件都不创建）；
  · `--now` 必填且为合法 ISO8601（**不读墙钟**：发布是事实，事实带你给的时间）；
  · 幂等：同一 `(package_id, rev, payload_sha256)` 已经落过 ⇒ `duplicates` + **账本零新增** + `exit 0`；
  · 待办件移入 `<inbox>/applied/`（**不删**：幂等可观察）；
  · stdout 恰一行 JSON；退出码 0 = 已落或幂等、1 = 有拒绝、2 = 用法/环境错误。

用法（人类/脚本）：
  python3 src/domain/rfq/tools/rfq-publish.py --request <pending.json> --now 2026-09-22T09:00:00Z
  python3 src/domain/rfq/tools/rfq-publish.py --inbox <ui-shared>/rfq-publish --now ...   # 消费最早一条
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
from quotagent.services.measures import DEFAULT_UNITS, MeasureBook, MeasureRule, UnitTable  # noqa: E402
from quotagent.services.rfq import RfqService  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
PP_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "rfq-publish"
ACTION = "publish"
MAX_ITEMS = 64
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
                             "让宿主先落待办件（APP 的「发布 RFQ」提交会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}",
                             "待办件必须是宿主落的普通文件（不要用符号链接/管道）")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600",
                             "chmod 600 待办件再消费（宿主落盘时就是 0600）")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限 {MAX_FILE_BYTES}",
                             "行项目拆分后重提（上限是为了拒绝体量失控的载荷）")
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
                             "这份待办件不是发布 RFQ 的载荷")
    if record.get("action") != ACTION:
        return None, refusal("action-not-publish", f"action 不是 {ACTION}：{record.get('action')!r}",
                             "用发布动作的待办件")
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
    if not isinstance(size, int) or isinstance(size, bool) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与备注正文长度不一致",
                             "让宿主重落待办件")
    return record, None


def items_of(record: dict) -> tuple[list[dict] | None, dict | None]:
    raw = record.get("items")
    if not isinstance(raw, list) or not raw:
        return None, refusal("items-required", "items 必须是非空数组（至少要一条行项目）",
                             "在 APP 的「发布 RFQ」表单里填至少一条行项目")
    if len(raw) > MAX_ITEMS:
        return None, refusal("items-too-many", f"行项目 {len(raw)} 条超过上限 {MAX_ITEMS}",
                             "拆成多个包发布")
    out: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            return None, refusal("item-not-an-object", f"items[{index}] 不是对象", "改这一条行项目")
        item_id = str(item.get("item_id") or "").strip()
        if not ITEM_RE.match(item_id):
            return None, refusal("item-id-malformed", f"items[{index}].item_id 形状非法：{item_id!r}",
                                 "行项目 id 用字母数字开头、只含 [A-Za-z0-9._-]")
        if item_id in seen:
            return None, refusal("item-id-duplicated", f"行项目 id 重复：{item_id}",
                                 "行项目 id 在同一个包里必须唯一")
        seen.add(item_id)
        unit = str(item.get("unit") or "").strip()
        if unit == "":
            return None, refusal("item-unit-required", f"行项目 {item_id} 缺 unit",
                                 "每条行项目都要给计量单位（如 m / kg / 台）")
        try:
            qty = float(item.get("qty"))
        except (TypeError, ValueError):
            return None, refusal("item-qty-invalid", f"行项目 {item_id} 的 qty 不是数：{item.get('qty')!r}",
                                 "qty 给一个数（数量）")
        if qty < 0:
            return None, refusal("item-qty-negative", f"行项目 {item_id} 的 qty 为负：{qty}",
                                 "数量不得为负")
        out.append({"item_id": item_id, "code": str(item.get("code") or item_id),
                    "description": str(item.get("description") or item_id), "unit": unit, "qty": qty})
    return out, None


def spec_of(record: dict, items: list[dict], actor: str) -> dict:
    deadlines = {"quote_by": str(record.get("quote_by") or "").strip()}
    for key in ("clarify_by", "delivery_by"):
        value = str(record.get(key) or "").strip()
        if value:
            deadlines[key] = value
    return {"package_id": str(record.get("package_id") or "").strip(),
            "subject": str(record.get("subject") or "").strip(),
            "scope": [str(record.get("subject") or record.get("package_id") or "").strip()],
            "currency": str(record.get("currency") or "CNY").strip() or "CNY",
            "deadlines": deadlines,
            "items": items,
            "notes": str(record.get("note") or ""),
            "published_by": actor}


def measurebook(items: list[dict]) -> MeasureBook:
    return MeasureBook({item["item_id"]: MeasureRule(item["item_id"], base_unit=item["unit"],
                                                    allowed_units=(item["unit"],), tolerance_bps=5)
                        for item in items})


def unittable(items: list[dict]) -> UnitTable:
    """单位表：内置单位（`DEFAULT_UNITS`）+ **本包行项目用到的单位各自作为自己的基准单位**（换算因子 1）。

    为什么：发布表单里的单位是**发布方写的**（如 `根`/`台`/`套`），内置单位表只登记了 m/kg 这类换算基准。
    P0 的口径是"认不出换算关系的单位不换算"（因子 1，不做静默折算）；**越界/非法单位仍由校验门拦住**
    （单位不能为空、行项目 id 不能重复）。要引入换算关系就得改单位表（那是 `system/measures` 的事）。
    """
    table = UnitTable(DEFAULT_UNITS)
    extra = {item["unit"]: (item["unit"], 1.0) for item in items if not table.has(item["unit"])}
    if extra:
        table.patch(extra)
    return table


def archive(inbox: Path, request: Path) -> str:
    applied = inbox / "applied"
    applied.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(applied, 0o700)
    except OSError:
        pass
    target = applied / request.name
    shutil.move(str(request), str(target))
    return str(target.relative_to(inbox.parent)) if inbox.parent in target.parents else str(target)


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="发布 RFQ（GUI 的写动作服务端一半；唯一落账本者）")
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="", help="待办件目录（消费文件名最小的那条）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="",
                        help="被邀方账本（给定时写一条**投递登记**：本侧收到的包与行项目 —— 收件人侧自己那条事实）")
    parser.add_argument("--delivery", default="", help="投递信封写到哪里（文件或目录；空=不写）")
    parser.add_argument("--actor", default="agent:rfq-publish")
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
                         "refusal": None, "inbox": str(inbox), "pending": 0,
                         "note": "待办件目录里没有待消费的载荷（这是空跑，不是失败）"}, 0)
        request = candidates[0]
    record, deny = read_pending(request)
    if deny is not None:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "request": str(request), "refusal": deny}, 1)
    assert record is not None

    items, deny = items_of(record)
    if deny is not None:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "request": str(request), "refusal": deny}, 1)
    assert items is not None

    package_id = str(record.get("package_id") or "").strip()
    if not PP_RE.match(package_id):
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refusal": refusal("package-id-malformed", f"package_id 形状非法：{package_id!r}",
                                        "包 id 用字母数字开头、只含 [A-Za-z0-9._-]")}, 1)
    actor = str(record.get("actor") or args.actor).strip() or args.actor
    spec = spec_of(record, items, actor)
    invited = [str(who).strip() for who in (record.get("invited") or []) if str(who).strip()]
    if not invited:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refusal": refusal("invited-required", "invited 为空：至少要邀请一家供应商",
                                        "在 APP 的「发布 RFQ」表单里填邀请对象（realm，如 supplier:g1）")}, 1)
    bad = [who for who in invited if not REALM_RE.match(who)]
    if bad:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refusal": refusal("invitee-malformed", f"邀请对象形状非法：{bad}",
                                        "邀请对象写 realm 形状（如 supplier:g1）")}, 1)

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    realm = realm_of(rows, "contractor:gui")
    key = digest_of(canonical(record))
    # 幂等：同一份载荷已经消费过（在 `applied/` 归档里，按名字 + 重算哈希对照）⇒ 账本零新增。
    # 为什么用归档而不是"账本里搜哈希"：`rfq/published` 的既有形状里没有载荷哈希，而**账本事件类型不可凭空新增**
    # （`AGENTS.md` 规则 8：协议/账本格式变更必须先有 ADR）。归档件是宿主落的消费凭证，与
    # `quote-draft.py` 的幂等口径同规格。
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous = {}
        if digest_of(canonical(previous)) == key:
            return emit({"ok": True, "event": "rfq/published", "applied": [],
                         "duplicates": [{"package_id": package_id, "reason": "already-applied", "key": key}],
                         "ledger_added": 0, "refusal": None, "request": str(request),
                         "archived": str(archived_before),
                         "note": "同一份载荷已经消费过（归档件逐字节一致）：账本零新增，发布是幂等动作"}, 0)

    bus = EventBus()
    bus.install_defaults()
    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")
    rfq = RfqService(ledger=ledger, events=bus, units=unittable(items),
                     measures=measurebook(items), actor=actor)
    rfq.create_package(spec)
    report = rfq.validate()
    if not report["ok"]:
        return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refusal": refusal("spec-invalid", "; ".join(report["errors"]),
                                        "按上面每条错误改载荷后重提（账本零新增）")}, 1)
    if args.dry_run:
        return emit({"ok": True, "event": "rfq/published", "dry_run": True, "applied": [],
                     "duplicates": [], "ledger_added": 0, "refusal": None,
                     "package_id": package_id, "items": len(items), "invited": invited,
                     "note": "干跑：校验通过、账本零新增、信封未写"}, 0)
    published = rfq.publish()
    sent = rfq.distribute(invited, now=args.now)
    rev = int(published["rev"])
    snapshot_hash = rfq.snapshot_hash(rev)

    # 承包商侧的操作产物（与 g1 走查同模式：包体不进 `rfq/published`，侧内快照补齐；写者仍是本脚本）
    side = ui_shared / "contractor"
    side.mkdir(parents=True, exist_ok=True)
    snapshot = {"package_id": package_id, "rev": rev, "snapshot_hash": snapshot_hash,
                "spec": spec, "invited": invited, "published_at": args.now,
                "deadlines": spec["deadlines"], "currency": spec["currency"]}
    (side / f"rfq-{package_id}-rev{rev}.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    ops_path = side / "rfq-ops.json"
    try:
        ops = json.loads(ops_path.read_text(encoding="utf-8")).get("ops", [])
    except (FileNotFoundError, ValueError):
        ops = []
    ops.append({"op": "publish", "package_id": package_id, "rev": rev, "payload_sha256": key,
                "at": args.now})
    ops_path.write_text(json.dumps({"ops": ops}, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")

    envelope = {"delivered_to": list(sent["recipients"]), "rev": rev, "sent_at": sent["sent_at"],
                "snapshot_hash": snapshot_hash, "spec": spec}
    delivery_written = ""
    if args.delivery:
        target = Path(args.delivery)
        if target.exists() and target.is_dir():
            target = target / f"{package_id}-rev{rev}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(envelope, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                          encoding="utf-8")
        delivery_written = str(target)
    # 投递登记（**收件人侧的那条事实**）：被邀方自己的账本里要有"我收到了这份包、包里有这些行项目"，
    # 否则收件人侧的备报价门（`quote-draft.py` 的"行项目必须真的存在"）无凭可依 —— 那不是收件人的错，
    # 而是投递没有留痕。与 `quote-draft.py` 的"两侧登记（双向可见性）"同一模式：**同一个唯一写者**写两侧。
    supplier_notice = ""
    if args.ledger_supplier:
        s_rows, s_error = load_rows(Path(args.ledger_supplier))
        if s_error is not None or s_rows is None:
            return usage_error("ledger-unreadable", str(s_error), "先修被邀方账本（本脚本不往坏账本追加）")
        s_realm = realm_of(s_rows, "") or (invited[0] if len(invited) == 1 else "")
        if s_realm == "":
            return usage_error("supplier-realm-unknown",
                               "被邀方账本还没有 realm，且邀请对象不止一个（不猜写给了谁）",
                               "一个包一次只邀请一家（本脚本 P0 只写一条投递登记），或先让被邀方产生一条事实")
        if s_realm not in invited:
            return usage_error("ledger-not-invited",
                               f"被邀方账本 realm={s_realm} 不在邀请名单 {invited} 里（拒绝写给未被邀的账本）",
                               "邀请名单与被邀方账本要对得上（不猜）")
        notice = {"package_id": package_id, "rev": rev, "snapshot_hash": snapshot_hash, "channel": "relay",
                  "sent_at": sent["sent_at"], "recipients": [s_realm],
                  "envelope": envelope, "items": items, "quote_by": spec["deadlines"]["quote_by"],
                  "currency": spec["currency"], "subject": spec["subject"], "published_by": actor,
                  "note": "投递登记：本侧收到的包与行项目（逐条可核；由发布方的唯一写者写，收件人据此备报价）"}
        try:
            Ledger(Path(args.ledger_supplier), realm=s_realm).append(
                "rfq/distributed", notice, correlation_id=package_id, actor=actor, ts=args.now,
                event_class="fact", refs={"package_id": package_id, "rfq_rev": rev})
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修被邀方账本（不往校验不过的账本追加）")
        supplier_notice = args.ledger_supplier
    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    return emit({"ok": True, "event": "rfq/published", "applied": [
        {"event": "rfq/published", "package_id": package_id, "rev": rev, "items": len(items),
         "snapshot_hash": snapshot_hash},
        {"event": "rfq/distributed", "recipients": list(sent["recipients"]), "sent_at": sent["sent_at"],
         "delivery": delivery_written},
        {"event": "rfq/distributed", "view": "recipient", "recipients": [invited[0]] if invited else [],
         "ledger": supplier_notice, "items": len(items)},
    ], "duplicates": [], "ledger_added": 3 if supplier_notice else 2, "refusal": None, "request": str(request),
        "archived": archived, "snapshot": str(side / f"rfq-{package_id}-rev{rev}.json"),
        "delivery": delivery_written, "package_id": package_id, "rev": rev,
        "ledger": str(ledger_path), "realm": realm,
        "note": "发布是**不产生对外义务**的动作（意向可撤回）；对外承诺（授标/发 PO）仍要人签"}, 0)




def crash_guard(fn, argv):
    """意外异常也必须是**一行 JSON**：宿主（GUI 的动作服务端一半）据此如实报错、不假装成功。"""
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 —— 兜底只报错，不落任何东西
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed",
                                      "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
