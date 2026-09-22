#!/usr/bin/env python3
"""src/domain/capacity/tools/capacity-commit.py —— 「产能日历 / 承诺交期 / 改期留痕」的唯一落账本者（DEF-021）。

要解决的问题（逐条）：
  · DEF-021（P1）：供应商侧**没有产能日历，也没有冲突提醒**（`GET /supplier/capacity/ 404`、
    `POST /supplier/capacity/commit 404`）。`CapacityService` 的 `commit/amend/feasibility/conflict_flags`
    与 `Calendar` 零 UI 消费者。本写者把三件事落成事实：
      1. `capacity/calendar` —— **本侧私域**的产能日历（按天可用量）；只进本视角账本，**不外发**；
      2. `capacity/committed` —— 承诺交期（`firm` / `indicative`）；同时给**承包商侧**镜像一条
         **share-safe** 登记（只含交期与绑定性质，**不含**日历数字与缺口值 —— 数据主权，规则 4）；
      3. `capacity/conflict` / `capacity/firm-change-refused` —— 冲突只**提请人工**（护栏不否决），
         `firm` 交期在有效期内不得由模型改动（`FirmDateImmutable`）。

业务规则不在这里重写：全部走**既有服务** `CapacityService`（`src/domain/capacity/code/capacity.py`）：
不可行 ⇒ `feasibility.requires_human=true` + `conflict_flags(kind=capacity_risk)`；`firm` 交期改动按
`IMMUTABLE_FIELDS` 判。产能日历从**本侧账本重放**（服务实例无状态；事实在 append-only 账本里）。

本脚本**不自行改动交期**（不可行时不夹取、不自动改期）；`--now` 必填；`actor` 用服务的 `by` 字段；
宿主只落 0600 待办件；拒绝时零写账本；stdout 恰一行 JSON；退出码 0/1/2。
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
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402
from quotagent.services.capacity import Calendar, CapacityError, CapacityService, FirmDateImmutable  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
BINDINGS = ("firm", "indicative")
MAX_DAYS = 400
MAX_FILE_BYTES = 262144

SCHEMA = "quotagent/pending/v1"
KIND = "capacity-commit"
ACTIONS = ("calendar", "commit", "amend")
CALENDAR_EVENT = "capacity/calendar"
COMMITTED_EVENT = "capacity/committed"
CONFLICT_EVENT = "capacity/conflict"
REFUSED_EVENT = "capacity/firm-change-refused"
ARCHIVE_DIR = "applied"
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
IMMUTABLE = ("delivery_date", "lead_time_days", "quantity")


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
    if record.get("kind") != KIND or str(record.get("action") or "") not in ACTIONS:
        return None, refusal("action-not-supported",
                             f"kind/action 必须是 {KIND}/{'|'.join(ACTIONS)}："
                             f"{record.get('kind')!r}/{record.get('action')!r}",
                             "用产能页上的按钮落的待办件")
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


class _NullLedger:
    """重放用的空账本：`CapacityService` 在重放时会往 `ledger` 追加事实，但重放阶段**不写任何东西**
    （事实已经在账本里了）——用一个"吞掉 append"的替身，避免重放污染账本。"""

    def append(self, *args, **kwargs):  # noqa: D102, ANN002, ANN003
        return None

    def rows(self):  # noqa: D102
        return []


def replay(rows: list[dict], realm: str) -> CapacityService:
    """按账本重放产能状态（日历 + 承诺）——服务实例是无状态的，事实只在账本里。"""
    calendar = Calendar(owner=realm)
    service = CapacityService(participant=realm, realm=realm, ledger=_NullLedger(), events=None,
                              calendar=calendar)
    for row in rows:
        kind = str(row.get("type") or "")
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        if kind == CALENDAR_EVENT:
            for day, available in (body.get("days") or {}).items():
                try:
                    calendar.set_day(day, float(available))
                except (TypeError, ValueError):
                    continue
        if kind == COMMITTED_EVENT:
            cid = str(body.get("commitment_id") or "")
            if cid == "":
                continue
            existing = service.commitments.get(cid)
            if existing is None:
                start = _as_day(body.get("start_date")) or _as_day(body.get("delivery_date"))
                if start is None:
                    continue
                try:
                    service.commit(quote_id=str(body.get("quote_id") or ""),
                                   package_id=str(body.get("package_id") or ""),
                                   lead_time_days=int(body.get("lead_time_days") or 0),
                                   quantity=float(body.get("quantity") or 0.0),
                                   start_date=start, binding=str(body.get("binding") or "indicative"),
                                   valid_until=body.get("valid_until"), commitment_id=cid,
                                   by=str(body.get("by") or realm))
                except CapacityError:
                    continue
                service.commitments[cid].revision = int(body.get("revision") or 1)
            else:
                for key in ("delivery_date", "lead_time_days", "quantity", "valid_until", "binding"):
                    value = body.get(key)
                    if value is None:
                        continue
                    setattr(existing, key, float(value) if key == "quantity" else value)
                existing.revision = int(body.get("revision") or existing.revision)
    return service


def _as_day(value: object) -> date | None:
    text = str(value or "")[:10]
    if not DAY_RE.match(text):
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="capacity-commit", add_help=False,
                                     description="产能日历 / 交期承诺 / 改期待办件的唯一落账本者")
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--view", default="supplier")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--ledger-contractor", default="")
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
    ledger_supplier = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    ledger_contractor = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    supplier_rows, error_s = load_rows(ledger_supplier)
    contractor_rows, error_c = load_rows(ledger_contractor)
    if error_s is not None or error_c is not None:
        return usage_error("ledger-unreadable", error_s or error_c, "先修账本（本脚本不往坏账本追加）")
    assert supplier_rows is not None and contractor_rows is not None
    realm = realm_of(supplier_rows, f"{args.view}:unknown")
    contractor_realm = realm_of(contractor_rows, "contractor:capacity")
    service = replay(supplier_rows, realm)

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
        if str(record.get("view") or "") != args.view:
            refused.append(refusal("view-unknown", f"待办件 view={record.get('view')!r} 不是本视角 {args.view!r}",
                                   "重提一次（视角名由页面提交）") | {"file": path.name})
            continue
        by = str(record.get("actor") or "").strip()

        if action == "calendar":
            days = record.get("days")
            if not isinstance(days, dict) or not days:
                refused.append(refusal("days-required", "days 必须是非空的 {日期: 可用量} 映射",
                                       "给至少一天的可用产量（例：{\"2026-10-01\": 12}）") | {"file": path.name})
                continue
            clean: dict[str, float] = {}
            bad = None
            for day, available in days.items():
                if not DAY_RE.match(str(day)):
                    bad = refusal("day-malformed", f"日期形状非法（要 YYYY-MM-DD）：{day!r}", "按 ISO 日期填")
                    break
                try:
                    clean[str(day)] = float(available)
                except (TypeError, ValueError):
                    bad = refusal("available-invalid", f"{day} 的可用量不是数：{available!r}", "给一个数")
                    break
                if clean[str(day)] < 0:
                    bad = refusal("available-negative", f"{day} 的可用量为负：{clean[str(day)]}", "可用量不得为负")
                    break
            if bad is not None:
                bad.update({"file": path.name})
                refused.append(bad)
                continue
            if len(clean) > MAX_DAYS:
                refused.append(refusal("days-too-many", f"日历 {len(clean)} 天超过上限 {MAX_DAYS}",
                                       "分段设置（本脚本不截断）") | {"file": path.name})
                continue
            body = {"owner": realm, "days": clean, "days_count": len(clean),
                    "calendar_sha256": digest_of(canonical({"days": clean})), "at": args.now, "ok": True,
                    "view": args.view,
                    "note": "产能日历是本方私域：只进本视角账本，不外发、不进对方可见字段"}
            if not args.dry_run:
                try:
                    Ledger(ledger_supplier, realm=realm).append(CALENDAR_EVENT, body, actor=by or realm,
                                                                ts=args.now, event_class="fact")
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（不往校验不过的账本追加）")
                ledger_added += 1
            applied.append({"file": path.name, "action": action, "event": CALENDAR_EVENT,
                            "days_count": len(clean), "private": True})
            if not args.dry_run:
                archive(inbox, path)
            continue

        if action == "commit":
            quote_id = str(record.get("quote_id") or "").strip()
            package_id = str(record.get("package_id") or "").strip()
            binding = str(record.get("binding") or "").strip()
            start = _as_day(record.get("start_date"))
            if not REF_RE.match(quote_id) or not REF_RE.match(package_id):
                refused.append(refusal("quote-or-package-malformed",
                                       f"quote_id={quote_id!r} / package_id={package_id!r} 形状非法",
                                       "交期承诺必须挂在一份真报价上（从「我的报价」里取）") | {"file": path.name})
                continue
            if binding not in BINDINGS:
                refused.append(refusal("binding-unknown", f"binding 必须是 {'/'.join(BINDINGS)}：{binding!r}",
                                       "硬承诺用 firm（有效期内不可改）、软承诺用 indicative") | {"file": path.name})
                continue
            try:
                lead = int(record.get("lead_time_days"))
                quantity = float(record.get("quantity"))
            except (TypeError, ValueError):
                refused.append(refusal("lead-or-quantity-invalid",
                                       f"lead_time_days={record.get('lead_time_days')!r} / "
                                       f"quantity={record.get('quantity')!r} 不是数",
                                       "交期给天数、数量给数") | {"file": path.name})
                continue
            if start is None:
                refused.append(refusal("start-date-malformed", f"start_date 必须是 YYYY-MM-DD：{record.get('start_date')!r}",
                                       "给承诺开工日（算交期用）") | {"file": path.name})
                continue
            if lead <= 0 or quantity <= 0:
                refused.append(refusal("lead-or-quantity-nonpositive",
                                       f"交期天数与数量都要为正（收到 {lead} 天 / {quantity}）",
                                       "改成正数后重提") | {"file": path.name})
                continue
            cid = "cm-" + hashlib.sha256(f"{package_id}|{quote_id}|{binding}|{start}|{lead}|{quantity}"
                                         .encode("utf-8")).hexdigest()[:12]
            existing = [row for row in supplier_rows if row.get("type") == COMMITTED_EVENT
                        and str((row.get("body") or {}).get("commitment_id")) == cid
                        and str((row.get("body") or {}).get("action")) == "commit"]
            if existing:
                duplicates.append({"file": path.name, "action": action, "commitment_id": cid,
                                   "reason": "already-committed"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            if not args.dry_run:
                service.ledger = Ledger(ledger_supplier, realm=realm)
                try:
                    commitment = service.commit(quote_id=quote_id, package_id=package_id,
                                                lead_time_days=lead, quantity=quantity, start_date=start,
                                                binding=binding, valid_until=record.get("valid_until"),
                                                commitment_id=cid, by=by or realm)
                except CapacityError as exc:
                    refused.append(refusal("commit-refused", str(exc),
                                           "按服务的拒绝原因改入参后重提（拒绝时账本零新增）") | {"file": path.name})
                    continue
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（不往校验不过的账本追加）")
                feasibility = service.feasibility(commitment_id=cid)
                flags = service.conflict_flags(share_safe=False)
                try:      # 承包商侧只登记 **share-safe** 事实（交期与绑定性质；不含日历数字与缺口）
                    Ledger(ledger_contractor, realm=contractor_realm).append(
                        COMMITTED_EVENT,
                        {"commitment_id": cid, "quote_id": quote_id, "package_id": package_id,
                         "binding": binding, "lead_time_days": lead, "delivery_date": commitment.delivery_date,
                         "revision": 1, "by": by or realm, "action": "commit", "supplier": realm,
                         "view": "contractor", "share_safe": True,
                         "note": "供应商承诺交期（share-safe 形态）：产能日历与缺口数值属对方私域，不在此行"},
                        correlation_id=cid, actor=by or realm, ts=args.now, event_class="fact",
                        refs={"package_id": package_id})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修承包商账本（不往校验不过的账本追加）")
                ledger_added += 2 + (0 if feasibility["feasible"] else 1)  # committed（两侧）+ 冲突（不可行时）
            else:
                feasibility = service.feasibility(commitment_id=cid) if cid in service.commitments else {}
                flags = service.conflict_flags(share_safe=False)
            applied.append({"file": path.name, "action": action, "event": COMMITTED_EVENT, "commitment_id": cid,
                            "package_id": package_id, "quote_id": quote_id, "binding": binding,
                            "lead_time_days": lead, "delivery_date": (commitment.delivery_date
                                                                      if not args.dry_run else None),
                            "feasibility": feasibility, "conflict_flags": flags,
                            "notified": "contractor(share-safe)"})
        else:  # amend（改期留痕）
            commitment_id = str(record.get("commitment_id") or "").strip()
            changes = record.get("changes")
            if not REF_RE.match(commitment_id):
                refused.append(refusal("commitment-id-malformed", f"commitment_id 缺或形状非法：{commitment_id!r}",
                                       "从「我的承诺交期」表里复制 commitment_id") | {"file": path.name})
                continue
            if not isinstance(changes, dict) or not changes:
                refused.append(refusal("changes-required", "changes 必须是非空对象（要改什么）",
                                       "给 {delivery_date: 'YYYY-MM-DD'} 这类改动") | {"file": path.name})
                continue
            if commitment_id not in service.commitments:
                refused.append(refusal("commitment-not-found",
                                       f"承诺 {commitment_id} 不在本视角账本里",
                                       "刷新页面看「我的承诺交期」后重试") | {"file": path.name})
                continue
            commitment = service.commitments[commitment_id]
            touching = sorted(key for key in changes if key in IMMUTABLE)
            model_actor = not HUMAN_RE.match(by)
            if commitment.binding == "firm" and touching and model_actor:
                # **前置拒绝**（不调服务、不落任何行）：agent 不得改已定交期（FR-CAP-002）
                refused.append(refusal("firm-date-immutable",
                                       f"承诺 {commitment_id} 是 firm（有效期内不可变更），"
                                       f"而发言人 {by or '（空）'} 不是 human:*：拒绝改动 {touching}",
                                       "已定交期只能由 human:<人名> 改期并留痕（agent 一律拒；本脚本不落任何行）")
                               | {"file": path.name})
                continue
            if not args.dry_run:
                service.ledger = Ledger(ledger_supplier, realm=realm)
                try:
                    amended = service.amend(commitment_id=commitment_id, changes=changes, by=by or realm,
                                            on=args.now[:10])
                except FirmDateImmutable as exc:
                    refused.append(refusal("firm-date-immutable", str(exc),
                                           "已定交期只能走改期（由人工批准），不能原地改") | {"file": path.name})
                    continue
                except (CapacityError, LedgerError) as exc:
                    return usage_error("amend-refused", str(exc)[0:200],
                                       "按服务的拒绝原因改入参后重提（拒绝时账本零新增）")
                try:
                    Ledger(ledger_contractor, realm=contractor_realm).append(
                        COMMITTED_EVENT,
                        {"commitment_id": commitment_id, "quote_id": commitment.quote_id,
                         "package_id": commitment.package_id, "binding": commitment.binding,
                         "lead_time_days": commitment.lead_time_days, "delivery_date": commitment.delivery_date,
                         "revision": amended["revision"], "by": by or realm, "action": "amend",
                         "changes": amended["changes"], "supplier": realm, "view": "contractor",
                         "share_safe": True, "note": "供应商改期（留痕：新 revision）"},
                        correlation_id=commitment_id, actor=by or realm, ts=args.now, event_class="fact",
                        refs={"package_id": commitment.package_id})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200], "先修承包商账本（不往校验不过的账本追加）")
                ledger_added += 2
            applied.append({"file": path.name, "action": action, "event": COMMITTED_EVENT,
                            "commitment_id": commitment_id, "changes": sorted(changes),
                            "revision": (amended["revision"] if not args.dry_run else None),
                            "delivery_date": (amended["delivery_date"] if not args.dry_run
                                              else commitment.delivery_date),
                            "notified": "contractor(share-safe)"})
        if not args.dry_run:
            archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件", "先在页面上点一次动作")
    return emit({"ok": not refused, "event": COMMITTED_EVENT, "now": args.now, "applied": applied,
                 "duplicates": duplicates, "ledger_added": ledger_added, "refused": refused, "inbox": str(inbox),
                 "realm": realm,
                 "note": "承诺/改期都走既有服务 CapacityService（不可行 ⇒ requires_human + capacity_risk Flag，"
                         "服务**不**自动改交期）；日历与缺口值只进本视角账本（私域）",
                 }, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
