#!/usr/bin/env python3
"""src/domain/change/tools/requote.py —— 「**改报**：承包商发新版后，把我的旧报价作废并开重报」的唯一落账本者（DEF-017）。

要解决的问题（逐条）：
  · DEF-017（P1）：承包商把量改了（`@rev2`）之后，供应商侧**看不到**"我的 rev1 报价已被作废"，
    也没有"按新版重报"的入口（`POST /supplier/quotes/q-1/amend` 404；`QuoteBook` 的
    `superseded` / `open_requote_requests` 零 UI 呈现）。本写者把这两件事落成事实：
      1. `quote/superseded`（每份基于旧版的活动报价一条）——业务规则走**既有服务** `QuoteBook.on_amended`；
      2. `quote/requote-open`（"我要按 revN 重报"的登记）——本侧一条，并在**承包商账本**留一条同名登记
         （对方据此知道"这家要按新版重报"，不是默默等待）。

业务规则不在这里重写：`QuoteBook.register` / `on_amended` 来自 `src/domain/quotes/code/quotes.py`
（`requires_requote` / `superseded_by_rev` / `reason` 都是它给的）。本脚本负责：权限门 → 形状门 →
重算校验 → **按账本判定版本**（报价绑定的 rev 由"提交时刻之前最近一次投递/升版事实"推出，不猜） →
调服务落账 → 双向登记。

只管**作废与重报登记**：真正的新报价仍必须由人签提交（`tools/quote-sign.py` / 界面上的 quote.submit），
本脚本**不代签、不写报价正文**。

纪律：宿主只落 0600 待办件（账本零新增）；`--now` 必填；拒绝时零写账本；stdout 恰一行 JSON；退出码 0/1/2。
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
from quotagent.services.quotes import QuoteBook  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
MAX_FILE_BYTES = 262144

SCHEMA = "quotagent/pending/v1"
KIND = "requote"
ACTION = "requote"
SUPERSEDED_EVENT = "quote/superseded"
REQUOTE_EVENT = "quote/requote-open"
ARCHIVE_DIR = "applied"
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
REV_EVENTS = ("rfq/distributed", "rfq/amended", "rfq/published")


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
                             "用「按最新 rev 重报」按钮落的待办件")
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


def rev_timeline(rows: list[dict], package_id: str) -> list[tuple[str, int]]:
    """本视角看到的该包"版本事实"时间线：`[(ts, rev), …]` 升序（只用 rfq/* 事实，不猜）。"""
    out: list[tuple[str, int]] = []
    for row in rows:
        if str(row.get("type") or "") not in REV_EVENTS:
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        refs = row.get("refs") if isinstance(row.get("refs"), dict) else {}
        if str(body.get("package_id") or refs.get("package_id") or "") != package_id:
            continue
        rev = body.get("rev", refs.get("rfq_rev"))
        if isinstance(rev, int):
            out.append((str(row.get("ts") or ""), rev))
    return sorted(out, key=lambda item: item[0])


def my_quotes(rows: list[dict], package_id: str) -> list[dict]:
    """我在这个包上已**提交**的报价（每行 = 一份报价，来自本侧 `quote/submitted` 事实）。"""
    out: list[dict] = []
    for row in rows:
        if str(row.get("type") or "") != "quote/submitted":
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        if str(body.get("package_id") or "") != package_id:
            continue
        quote_id = str(body.get("quote_id") or "")
        if not REF_RE.match(quote_id):
            continue
        out.append({"quote_id": quote_id, "submitted_at": str(body.get("submitted_at") or row.get("ts") or ""),
                    "item_id": str(body.get("item_id") or ""),
                    "unit_price_cents": body.get("unit_price_cents"),
                    "lead_time_days": body.get("lead_time_days")})
    return out


def envelope_rev(target: str, package_id: str, realm: str) -> tuple[int | None, list[dict]]:
    """投递信封里的版本与行项目（与首页同一份来源；只读）。"""
    if not str(target or "").strip():
        return None, []
    base = Path(target)
    files = sorted(base.glob("*.json")) if base.is_dir() else ([base] if base.is_file() else [])
    best: int | None = None
    items: list[dict] = []
    for path in files:
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(envelope, dict):
            continue
        spec = envelope.get("spec") if isinstance(envelope.get("spec"), dict) else {}
        if str(spec.get("package_id") or "") != package_id:
            continue
        delivered = [str(item) for item in (envelope.get("delivered_to") or [])]
        if delivered and realm and realm not in delivered:
            continue
        rev = envelope.get("rev")
        if isinstance(rev, int) and (best is None or rev > best):
            best = rev
            items = [item for item in (spec.get("items") or []) if isinstance(item, dict)]
    return best, items


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="requote", add_help=False,
                                     description="「改报」待办件的唯一落账本者（作废旧报价 + 开重报）")
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--delivery", default="")
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
    supplier_realm = realm_of(supplier_rows, "supplier:unknown")
    contractor_realm = realm_of(contractor_rows, "contractor:requote")

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
        if view != "supplier":
            refused.append(refusal("view-unknown", f"view={view!r} 不是 supplier（改报是供应商侧的动作）",
                                   "重提一次（视角名由页面提交）") | {"file": path.name})
            continue
        actor = str(record.get("actor") or "").strip()
        if not HUMAN_RE.match(actor):
            refused.append(refusal("human-required",
                                   f"改报的发言人必须 human:<人名>（收到 {actor!r}）：重报是对外动作的起点",
                                   "写 human:<你的名字>") | {"file": path.name})
            continue
        package_id = str(record.get("package_id") or "").strip()
        if not REF_RE.match(package_id):
            refused.append(refusal("package-id-malformed", f"package_id 缺或形状非法：{package_id!r}",
                                   "从「报价状态轨」表里复制包 id") | {"file": path.name})
            continue
        mine = my_quotes(supplier_rows, package_id)
        if not mine:
            refused.append(refusal("no-submitted-quote",
                                   f"我在 {package_id} 上没有已提交的报价（本侧账本没有 quote/submitted 事实）",
                                   "先在「备报价」里备并**人签提交**一份报价，改报才有对象") | {"file": path.name})
            continue
        wanted_quote = str(record.get("quote_id") or "").strip()
        if wanted_quote and wanted_quote not in {item["quote_id"] for item in mine}:
            refused.append(refusal("quote-id-not-mine",
                                   f"报价 {wanted_quote} 不在我提交过的报价里"
                                   f"（我提交过 {sorted(item['quote_id'] for item in mine)[:6]}）",
                                   "只对自己提交过的报价改报（不猜、不改别人的报价）") | {"file": path.name})
            continue
        timeline = rev_timeline(supplier_rows, package_id)
        env_rev, env_items = envelope_rev(args.delivery, package_id, supplier_realm)
        latest = max([rev for _, rev in timeline] + ([env_rev] if isinstance(env_rev, int) else []),
                     default=0)
        if latest < 1:
            refused.append(refusal("rfq-not-found",
                                   f"没看到 {package_id} 的任何版本事实（本人账本 rfq/* ∪ 投递信封）",
                                   "刷新页面重读；改报必须有「新版本」可依据（不猜）") | {"file": path.name})
            continue

        def based_on(item: dict) -> int:
            """报价绑定的版本：提交时刻之前最近一次版本事实（没有则 1）。"""
            rev = 1
            for ts, value in timeline:
                if ts <= str(item["submitted_at"]):
                    rev = value
            return rev

        stale = [{**item, "based_on_rev": based_on(item)} for item in mine]
        requires = [item for item in stale if item["based_on_rev"] < latest]
        if not requires:
            refused.append(refusal("rev-not-advanced",
                                   f"我的报价都是基于最新版本（latest=rev{latest}）；没有可作废的旧报价"
                                   "（改报只在新版之后才有意义）",
                                   "等承包商发新版（rev+1），或直接按当前版本重报") | {"file": path.name})
            continue
        existing = {str((row.get("body") or {}).get("quote_id")) + "#" + str((row.get("body") or {}).get("superseded_by_rev"))
                    for row in supplier_rows if str(row.get("type")) == SUPERSEDED_EVENT}
        todo = [item for item in requires if f"{item['quote_id']}#{latest}" not in existing]
        if not todo:
            duplicates.append({"file": path.name, "action": ACTION, "package_id": package_id,
                               "quotes": [item["quote_id"] for item in requires], "superseded_by_rev": latest,
                               "reason": "already-superseded"})
            if not args.dry_run:
                archive(inbox, path)
            continue

        if not args.dry_run:
            book = QuoteBook(participant=supplier_realm, realm=supplier_realm,
                             ledger=Ledger(ledger_supplier, realm=supplier_realm))
            # register 必须带 rfq_rev（版本绑定是硬要求）：逐条按"我看到的版本"登记
            for item in todo:
                book.register({"quote_id": item["quote_id"], "package_id": package_id,
                               "rfq_rev": item["based_on_rev"], "supplier": supplier_realm},
                              package_id=package_id)
            try:
                # 既有服务：标记过期 + 生成重报请求（reason / requires_requote 都是它给的口径）
                result = book.on_amended(package_id=package_id,
                                         from_rev=min(item["based_on_rev"] for item in todo),
                                         to_rev=latest, notified=True)
            except Exception as exc:   # noqa: BLE001 —— 服务的拒绝码原样给用户看
                refused.append(refusal("requote-refused", f"{type(exc).__name__}: {exc}",
                                       "按服务的拒绝原因改入参后重提（拒绝时账本零新增）") | {"file": path.name})
                continue
            superseded = result.get("superseded") or []
            if not superseded:
                refused.append(refusal("nothing-superseded",
                                       f"服务没有作废任何报价（基于旧版的报价可能已作废或不存在）：latest=rev{latest}",
                                       "刷新页面看报价状态轨后重试（不改任何事实）") | {"file": path.name})
                continue
            try:
                mirror = Ledger(ledger_contractor, realm=contractor_realm)
                for item in superseded:      # 承包商侧同名登记：对方知道"这家要按新版重报"
                    mirror.append(SUPERSEDED_EVENT, {**item, "view": "contractor",
                                                     "supplier": supplier_realm, "at": args.now},
                                  correlation_id=item["quote_id"], actor="agent:requote", ts=args.now,
                                  event_class="fact", refs={"package_id": package_id, "rfq_rev": latest})
                requote_body = {"package_id": package_id, "superseded_by_rev": latest,
                                "quotes": [item["quote_id"] for item in superseded],
                                "based_on_revs": sorted({item["based_on_rev"] for item in superseded}),
                                "requested_by": actor, "at": args.now, "ok": True, "view": "supplier",
                                "next_action": f"按 rev{latest} 重报：新报价仍需人签提交（界面不代签）"}
                Ledger(ledger_supplier, realm=supplier_realm).append(
                    REQUOTE_EVENT, requote_body, correlation_id=package_id, actor=actor, ts=args.now,
                    event_class="fact", refs={"package_id": package_id, "rfq_rev": latest})
                mirror.append(REQUOTE_EVENT, {**requote_body, "view": "contractor", "supplier": supplier_realm},
                              correlation_id=package_id, actor=actor, ts=args.now, event_class="fact",
                              refs={"package_id": package_id, "rfq_rev": latest})
            except LedgerError as exc:
                return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（不往校验不过的账本追加）")
            ledger_added += 2 * len(superseded) + 2
        items_for_requote = env_items or []
        if not items_for_requote:
            # 从本侧版本事实里取该版行项目（投递登记带 items）
            for row in reversed(supplier_rows):
                body = row.get("body") if isinstance(row.get("body"), dict) else {}
                if str(row.get("type") or "") in REV_EVENTS and str(body.get("package_id") or "") == package_id \
                        and isinstance(body.get("items"), list) and body["items"]:
                    items_for_requote = [item for item in body["items"] if isinstance(item, dict)]
                    break
        applied.append({"file": path.name, "action": ACTION, "event": SUPERSEDED_EVENT, "package_id": package_id,
                        "superseded_by_rev": latest,
                        "superseded": [{"quote_id": item["quote_id"], "based_on_rev": item["based_on_rev"],
                                        "reason": item.get("reason"), "requires_requote": item.get("requires_requote")}
                                       for item in (result.get("superseded") if not args.dry_run else requires)],
                        "my_quote_lines": [{"quote_id": item["quote_id"], "item_id": item["item_id"],
                                            "unit_price_cents": item["unit_price_cents"],
                                            "lead_time_days": item["lead_time_days"]} for item in mine],
                        "requote_lines": [{"item_id": item.get("item_id"), "qty": item.get("qty"),
                                           "unit": item.get("unit")} for item in items_for_requote],
                        "notified": "contractor"})
        if not args.dry_run:
            archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件", "先在页面上点一次「按最新 rev 重报」")
    return emit({"ok": not refused, "event": SUPERSEDED_EVENT, "now": args.now, "applied": applied,
                 "duplicates": duplicates, "ledger_added": ledger_added, "refused": refused, "inbox": str(inbox),
                 "note": "作废与重报请求都来自既有服务 QuoteBook.on_amended；两侧各登记一条，"
                         "承包商侧的报价状态轨据此显示 superseded / requote-requested",
                 }, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
