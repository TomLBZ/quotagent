#!/usr/bin/env python3
"""src/domain/change/tools/amend-rev.py —— 「承包商发新版（rev+1）」的**唯一落账本者**。

**为什么在 change 插件下**：DEF-017（供应商改报）的前置就是"承包商把量改了（`@rev2`）"。`domain/rfq`
由别的批次在改（硬约束不允许本批动它），所以这个写者落在本插件的 `tools/` 下，业务规则全部走**既有服务**
`RfqService`（`amend` / `distribute`），本脚本只做：权限门 → 形状门 → 重算校验 → 用**已发布快照重放**
服务状态 → 调 `amend` → 分发 → 写快照/信封 → 给被邀供应商的账本落**投递登记**（双向可见）。

**越权面（写清楚，便于评审）**：本动作是"发新版"的**最小可用实现**，只支持改**已发布版本里的条目数量**
（`items.<item_id>.qty`）——增删条目、改截止、改邀请名单不在本批能力面里（那些由 `domain/rfq` 自己的动作做）。

为什么必须"重放"：`RfqService` 是**无状态实例**，事实在 append-only 账本 + 承包商侧快照文件
（`<ui-shared>/contractor/rfq-<包>-rev<N>.json`，由发布写者写）里。本脚本用快照重组 `_store(rev, snapshot)`
（服务自己的存储路径，哈希口径因此与服务一致），**并且**用服务自己算的哈希与快照里的 `snapshot_hash`
对账；对不上如实报 `snapshot-hash-drift`（不静默继续）。

纪律：宿主只落 0600 待办件（账本零新增）；`--now` 必填；拒绝时账本零新增；stdout 恰一行 JSON；退出码 0/1/2。
发言人必须 `human:*`（改量是对外可见的变更，agent 不得代改）。
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
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")
MAX_FILE_BYTES = 262144

SCHEMA = "quotagent/pending/v1"
KIND = "amend-rev"
ACTION = "amend-rev"
AMENDED_EVENT = "rfq/amended"
DISTRIBUTED_EVENT = "rfq/distributed"
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
    if record.get("kind") != KIND or str(record.get("action") or "") != ACTION:
        return None, refusal("action-not-supported",
                             f"kind/action 必须是 {KIND}/{ACTION}：{record.get('kind')!r}/{record.get('action')!r}",
                             "用「发新版」按钮落的待办件")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件（改了载荷要重算哈希）")
    note = str(record.get("note") or "")
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


def measurebook(items: list[dict]) -> MeasureBook:
    """计量规则表（与 `src/domain/rfq/tools/rfq-publish.py` 同一口径：每行项目以自己的单位为准）。"""
    return MeasureBook({item["item_id"]: MeasureRule(item["item_id"], base_unit=item["unit"],
                                                    allowed_units=(item["unit"],), tolerance_bps=5)
                        for item in items if item.get("item_id") and item.get("unit")})


def unittable(items: list[dict]) -> UnitTable:
    """单位表：内置单位 + 本包行项目用到的单位各自作为自己的基准单位（换算因子 1，不静默折算）。"""
    table = UnitTable(DEFAULT_UNITS)
    extra = {item["unit"]: (item["unit"], 1.0) for item in items
             if item.get("unit") and not table.has(item["unit"])}
    if extra:
        table.patch(extra)
    return table


def snapshots_of(ui_shared: Path, package_id: str) -> list[tuple[int, dict]]:
    """承包商侧已发布快照（发布写者写的 `rfq-<包>-rev<N>.json`）：`[(rev, snapshot), …]` 升序。"""
    side = ui_shared / "contractor"
    out: list[tuple[int, dict]] = []
    if not side.is_dir():
        return out
    for path in sorted(side.glob(f"rfq-{package_id}-rev*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rev = record.get("rev")
        spec = record.get("spec")
        if isinstance(rev, int) and isinstance(spec, dict):
            out.append((rev, {"rev": rev, "spec": spec, "snapshot_hash": record.get("snapshot_hash"),
                              "published_at": record.get("published_at") or spec.get("published_at")}))
    return sorted(out, key=lambda item: item[0])


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="amend-rev", add_help=False,
                                     description="「发新版（rev+1）」待办件的唯一落账本者")
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--delivery", default="", help="投递信封写到哪里（文件或目录；与首页同一个源）")
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
    contractor_realm = realm_of(contractor_rows, "contractor:amend-rev")
    supplier_realm = realm_of(supplier_rows, "")
    if not REALM_RE.match(supplier_realm):
        return usage_error("supplier-realm-unknown",
                           "被邀方账本还没有 realm（不猜写给了谁）",
                           "先让被邀方产生一条事实（例如发布时落投递登记），再发新版")

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
        view = str(record.get("view") or "")
        if view != "contractor":
            refused.append(refusal("view-unknown", f"view={view!r} 不是 contractor（发新版是承包商侧的动作）",
                                   "重提一次（视角名由页面提交）") | {"file": path.name})
            continue
        actor = str(record.get("actor") or "").strip()
        if not HUMAN_RE.match(actor):
            refused.append(refusal("human-required",
                                   f"发新版的发言人必须 human:<人名>（收到 {actor!r}）：改量对外可见，agent 不得代改",
                                   "写 human:<你的名字>") | {"file": path.name})
            continue
        package_id = str(record.get("package_id") or "").strip()
        if not REF_RE.match(package_id):
            refused.append(refusal("package-id-malformed", f"package_id 缺或形状非法：{package_id!r}",
                                   "从「已发布的 RFQ」表里复制包 id") | {"file": path.name})
            continue
        item_updates = record.get("items")
        if not isinstance(item_updates, list) or not item_updates:
            refused.append(refusal("items-required", "items 必须是非空数组（要改哪几条、改成多少）",
                                   "给至少一条 {item_id, qty}") | {"file": path.name})
            continue
        wanted: dict[str, float] = {}
        bad = None
        for entry in item_updates:
            if not isinstance(entry, dict) or not ITEM_RE.match(str(entry.get("item_id") or "")):
                bad = refusal("item-id-malformed", f"items[] 里 item_id 形状非法：{entry!r}",
                              "行项目 id 用字母数字开头、只含 [A-Za-z0-9._:-]")
                break
            try:
                qty = float(entry.get("qty"))
            except (TypeError, ValueError):
                bad = refusal("item-qty-invalid", f"items[{entry.get('item_id')}].qty 不是数：{entry.get('qty')!r}",
                              "qty 给一个正数")
                break
            if qty <= 0:
                bad = refusal("item-qty-invalid", f"items[{entry.get('item_id')}].qty 必须为正：{qty}",
                              "数量改成正数（改量不得产生 0 或负量版本）")
                break
            wanted[str(entry["item_id"])] = qty
        if bad is not None:
            bad.update({"file": path.name})
            refused.append(bad)
            continue
        snapshots = snapshots_of(ui_shared, package_id)
        if not snapshots:
            refused.append(refusal("snapshot-missing",
                                   f"找不到 {package_id} 的已发布快照（{ui_shared}/contractor/rfq-{package_id}-rev*.json）",
                                   "先在本视角发布这个包（「发布 RFQ」），再发新版") | {"file": path.name})
            continue
        from_rev = record.get("from_rev")
        base_rev = int(snapshots[-1][0]) if not isinstance(from_rev, int) else int(from_rev)
        found = [item for item in snapshots if item[0] == base_rev]
        if not found:
            refused.append(refusal("rev-not-found", f"未见 rev{base_rev} 的已发布快照（已有 {[r for r, _ in snapshots]}）",
                                   "按已有版本号重填 from_rev") | {"file": path.name})
            continue
        existing = [row for row in contractor_rows if row.get("type") == AMENDED_EVENT
                    and str((row.get("body") or {}).get("package_id")) == package_id
                    and str((row.get("body") or {}).get("from_rev")) == str(base_rev)]
        if existing:
            duplicates.append({"file": path.name, "action": ACTION, "package_id": package_id,
                               "from_rev": base_rev, "reason": "already-amended"})
            if not args.dry_run:
                archive(inbox, path)
            continue

        if args.dry_run:
            applied.append({"file": path.name, "action": ACTION, "package_id": package_id, "from_rev": base_rev,
                            "to_rev": base_rev + 1, "dry_run": True})
            continue

        # ---- 用已发布快照重放服务状态（服务无状态；事实在账本 + 快照文件里） --------------------
        bus = EventBus()
        bus.install_defaults()      # 事件必须先声明（05-events.md §0 规则 1）：与 rfq-publish.py 同规格
        latest_items = snapshots[-1][1]["spec"].get("items") or []
        rfq = RfqService(ledger=Ledger(ledger_contractor, realm=contractor_realm), events=bus, actor=actor,
                         units=unittable(latest_items), measures=measurebook(latest_items),
                         name="rfq-amend-rev")
        hash_drift = []
        for rev, snapshot in snapshots:
            spec = snapshot["spec"]
            replay = {**spec, "rev": rev, "status": "published",
                      "published_at": snapshot.get("published_at") or spec.get("published_at")}
            rfq.create_package(spec)
            rfq._store(rev, replay)      # noqa: SLF001 —— 服务自己的存储路径（哈希口径一致）
            rfq._current_rev = rev       # noqa: SLF001
            rfq._draft = None            # noqa: SLF001 —— 重放完不是"草稿态"
            if snapshot.get("snapshot_hash") and rfq.snapshot_hash(rev) != snapshot["snapshot_hash"]:
                hash_drift.append({"rev": rev, "file_hash": snapshot["snapshot_hash"],
                                   "replayed_hash": rfq.snapshot_hash(rev)})
        try:
            amended = rfq.amend({"items": {item_id: {"qty": qty} for item_id, qty in wanted.items()}})
        except Exception as exc:   # noqa: BLE001 —— 服务的拒绝码要原样给用户看
            refused.append(refusal("amend-refused", f"{type(exc).__name__}: {exc}",
                                   "按服务的拒绝原因改入参后重提（拒绝时账本零新增）") | {"file": path.name})
            continue
        to_rev = int(amended["rev"])
        try:
            sent = rfq.distribute([supplier_realm], rev=to_rev, now=args.now)
        except Exception as exc:   # noqa: BLE001
            refused.append(refusal("distribute-refused", f"{type(exc).__name__}: {exc}",
                                   "先修分发对象后重提（本脚本不静默跳过分发）") | {"file": path.name})
            continue

        # ---- 承包商侧快照 + 投递信封 + 供应商侧投递登记（双向可见） -------------------------------
        side = ui_shared / "contractor"
        side.mkdir(parents=True, exist_ok=True)
        spec_after = rfq._published_snapshot(to_rev)   # noqa: SLF001 —— 服务自己的快照
        snapshot_hash = rfq.snapshot_hash(to_rev)
        snapshot_file = side / f"rfq-{package_id}-rev{to_rev}.json"
        snapshot_file.write_text(json.dumps({"package_id": package_id, "rev": to_rev,
                                             "snapshot_hash": snapshot_hash, "spec": spec_after,
                                             "invited": [supplier_realm], "published_at": args.now,
                                             "deadlines": spec_after.get("deadlines"),
                                             "currency": spec_after.get("currency")},
                                            ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                                 encoding="utf-8")
        ops_path = side / "rfq-ops.json"
        try:
            ops = json.loads(ops_path.read_text(encoding="utf-8")).get("ops", [])
        except (FileNotFoundError, ValueError):
            ops = []
        ops.append({"op": "amend", "package_id": package_id, "rev": to_rev, "from_rev": base_rev,
                    "payload_sha256": digest_of(canonical(record)), "at": args.now})
        ops_path.write_text(json.dumps({"ops": ops}, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8")
        envelope = {"delivered_to": [supplier_realm], "rev": to_rev, "sent_at": args.now,
                    "snapshot_hash": snapshot_hash, "spec": spec_after}
        delivery_written = ""
        if str(args.delivery or "").strip():
            target = Path(args.delivery)
            if target.exists() and target.is_dir():
                target = target / f"{package_id}-rev{to_rev}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(envelope, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                              encoding="utf-8")
            delivery_written = str(target)
        notice = {"package_id": package_id, "rev": to_rev, "from_rev": base_rev, "snapshot_hash": snapshot_hash,
                  "channel": "relay", "sent_at": args.now, "recipients": [supplier_realm],
                  "envelope": envelope, "items": spec_after.get("items") or [],
                  "quote_by": (spec_after.get("deadlines") or {}).get("quote_by"),
                  "currency": spec_after.get("currency"), "subject": spec_after.get("subject"),
                  "deltas": amended["deltas"], "published_by": actor, "view": "supplier",
                  "note": "投递登记（新版）：本侧收到的包与行项目；旧版本报价据此作废，按本版重报"}
        try:
            Ledger(ledger_supplier, realm=supplier_realm).append(
                DISTRIBUTED_EVENT, notice, correlation_id=package_id, actor=actor, ts=args.now,
                event_class="fact", refs={"package_id": package_id, "rfq_rev": to_rev})
        except LedgerError as exc:
            return usage_error("ledger-frozen", str(exc)[0:200], "先修被邀方账本（本脚本不往坏账本追加）")
        ledger_added += 3   # contractor: rfq/amended + rfq/distributed；supplier: rfq/distributed
        applied.append({"file": path.name, "action": ACTION, "event": AMENDED_EVENT, "package_id": package_id,
                        "from_rev": base_rev, "to_rev": to_rev, "deltas": amended["deltas"],
                        "snapshot": str(snapshot_file), "delivery": delivery_written,
                        "supplier_notice": str(ledger_supplier), "snapshot_hash": snapshot_hash,
                        "snapshot_hash_drift": hash_drift})
        archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件", "先在页面上点一次「发新版」")
    return emit({"ok": not refused, "event": AMENDED_EVENT, "now": args.now, "applied": applied,
                 "duplicates": duplicates, "ledger_added": ledger_added, "refused": refused, "inbox": str(inbox),
                 "note": "amend 与 distribute 都走既有服务 RfqService；本脚本只负责权限/形状/重算门、"
                         "快照与信封落盘、以及被邀方账本的投递登记",
                 }, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
