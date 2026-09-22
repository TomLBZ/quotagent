#!/usr/bin/env python3
"""tools/quote-sign.py —— 「把**草稿**签成**报价**」的**人工签署入口**（`quote.submit`，只能在终端）。
**位置（本批迁移）**：实体在 `src/domain/quote-prepare/tools/quote-sign.py`；旧位置 `tools/quote-sign.py` 只剩**薄转发**
（`runpy` 指到本文件）—— 门名、`tools/verify.sh` 的分支、`./run` 与文档里的既有命令**一行未改**。

为什么单独一个脚本：本仓铁律是**浏览器不得直接签署人工动作**（`approval.decide` / `quote.submit` /
`award.commit` / `po.issue` / `change.approve` 五件事只能由人/CLI 签，ADR-0013 §3）。所以
`GET /quotagent/supplier/quotes/prepare/` 上那个「下一步（签署）」区域给的是**可复制的命令**
（真实 RFQ / 行项目 / 金额整数分），由人在终端执行 —— **本 APP 不代签**。

它与 `tools/quote-draft.py` 的分工：
  · `quote-draft.py` 落 `quote/drafted`（**非签名动作**：只表示「报价已准备好」，不产生对外义务）；
  · 本脚本落 `approval/requested` → `approval/granted` → `quote/submitted`（**签名动作**）。
    顺序不可颠倒：无批准记录的提交报价路径是 INV-005 的禁止项（AC-APPROVE-002）。

**必须是人的三个门（各自给具体 code + next_action，拒绝时账本零新增）**：
  · `--actor` 必须以 `human:` 开头（`agent:`/空 ⇒ `human-required`，退出码 2，**连空账本都不创建**）；
  · `--draft-id` 必须真的在**供应商账本**里有一条 `quote/drafted`（否则 `draft-not-found`，退出码 1）；
  · `--now` 必填且是合法 ISO（本脚本**不读墙钟**）。
  另外：`--comment` 会**逐字**落进批准记录（`approval/granted.comment`），
  但**不进** `quote/submitted` 的 body（body 只带结构化字段与哈希）。

**多行报价 = 一次人签提交整份**：草稿里带 `lines`（逐行单价/交期）时，**一次签名只产生一份报价**，
`quote/submitted` 的 body 逐行给 `lines`（+ `line_count`），标量 `item_id`/`unit_price_cents`/`lead_time_days`
留空（多行报价没有「唯一那个行项目」）；签之前会**重算**草稿的 `lines_sha256`：
对不上 ⇒ `draft-tampered`、某一行不合法 ⇒ `draft-line-invalid`（两种都**账本零新增**）。

幂等：同一份草稿已经签过（供应商账本里已有 `quote/submitted` 且 `quote_id` 与本脚本派生的一致）
⇒ 记 `duplicates`、**账本零新增**、`exit 0`。

stdout 严格一行 JSON：`{ok, event, draft_id, quote_id, approval_id, applied:[...], duplicates:[...],
ledger_added, refusal:{code,next_action}|null, ...}`；退出码 0 = 已签或幂等、1 = 有拒绝、2 = 用法/环境错误。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
DRAFT_RE = re.compile(r"^qd-[A-Za-z0-9-]+-[0-9a-f]{12}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

EVENT_DRAFTED = "quote/drafted"
EVENT_SUBMITTED = "quote/submitted"
EVENT_REQUESTED = "approval/requested"
EVENT_GRANTED = "approval/granted"
SCOPE = "quote.submit"
TIMEOUT_POLICIES = ("remind", "escalate", "abort")

SUBMITTED_BODY_KEYS = ("approval_id", "approved_by", "currency", "item_id", "lead_time_days",
                       "package_id", "quote_id", "quote_draft_id", "source", "submitted_at",
                       "unit_price_cents")
# 多行报价在 `quote/submitted` body 里**额外**带这两键（单行报价的 body **逐字节不变**）：
#   `lines` = 逐行 `{item_id, unit_price_cents, unit_price(元), lead_time_days}`
#   `line_count` = 行数（供页面与读者一眼看到「这份报价几行」）
SUBMITTED_BODY_KEYS_MULTI = tuple(sorted(SUBMITTED_BODY_KEYS + ("lines", "line_count")))
NOTIFICATION_BODY_KEYS = ("approval_id", "approved_by", "currency", "item_id", "lead_time_days",
                          "package_id", "quote_id", "quote_draft_id", "source", "submitted_at",
                          "supplier", "unit_price_cents")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


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
            return None, f"账本第 {lineno} 行不是合法 JSON（{exc}）"
        if not isinstance(record, dict):
            return None, f"账本第 {lineno} 行不是记录对象"
        rows.append(record)
    return rows, None


def body_of(row: dict) -> dict:
    raw = row.get("body")
    return raw if isinstance(raw, dict) else {}


def draft_of(rows: list[dict], draft_id: str) -> dict | None:
    found = None
    for row in rows:
        if str(row.get("type")) != EVENT_DRAFTED:
            continue
        body = body_of(row)
        if body.get("ok") is not True:
            continue
        if str(body.get("quote_draft_id") or "") == draft_id:
            found = body
    return found


def already_signed(rows: list[dict], quote_id: str) -> bool:
    for row in rows:
        if str(row.get("type")) != EVENT_SUBMITTED:
            continue
        if str(body_of(row).get("quote_id") or "") == quote_id:
            return True
    return False


def approval_id_for(draft_id: str) -> str:
    value = int(hashlib.sha256(draft_id.encode("utf-8")).hexdigest(), 16) % 10000
    return f"ap-{value:04d}"


def canonical_lines(record: dict) -> str:
    """与唯一落账本者 `quote-draft.py` 的 `canonical_lines()` **逐字节一致**的规范化 JSON

    （单行 5 键；多行 `{currency, lines[], rfq_id}`）。签之前**重算一次**这份草稿的行摘要：
    对不上 ⇒ `draft-tampered`（账本里的草稿行被改过/自述不可信），**账本零新增**。
    """
    raw_lines = record.get("lines")
    if isinstance(raw_lines, list) and raw_lines:
        rows = []
        for entry in raw_lines:
            row = entry if isinstance(entry, dict) else {}
            rows.append({"item_id": str(row.get("item_id") or ""),
                         "lead_time_days": row.get("lead_time_days"),
                         "unit_price_cents": row.get("unit_price_cents")})
        payload = {"currency": str(record.get("currency") or ""), "lines": rows,
                   "rfq_id": str(record.get("rfq_id") or "")}
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload = {"currency": str(record.get("currency") or ""),
               "item_id": str(record.get("item_id") or ""),
               "lead_time_days": record.get("lead_time_days"),
               "rfq_id": str(record.get("rfq_id") or ""),
               "unit_price_cents": record.get("unit_price_cents")}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def lines_of(draft: dict) -> list[dict]:
    """草稿的逐行结构（`lines` 里只认三键；空/缺 ⇒ `[]` = 单行报价，沿用标量三键）。"""
    raw = draft.get("lines")
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        row = entry if isinstance(entry, dict) else {}
        out.append({"item_id": str(row.get("item_id") or ""),
                    "unit_price_cents": row.get("unit_price_cents"),
                    "lead_time_days": row.get("lead_time_days")})
    return out


def quote_id_for(draft_id: str) -> str:
    return "q-" + hashlib.sha256(draft_id.encode("utf-8")).hexdigest()[:12]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quote-sign", add_help=False,
                                     description="把报价草稿签成报价（人工动作；浏览器不代签）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--draft-id", dest="draft_id", default="")
    parser.add_argument("--actor", default="", help="签署人（**必须** human:<人名>）")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--comment", default="", help="批注（逐字落进批准记录；不进报价 body）")
    parser.add_argument("--timeout-policy", dest="timeout_policy", default="remind")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    return parser


def _usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = _parser()
    try:
        args, unknown = parser.parse_known_args(argv)
    except SystemExit:
        return _usage_error("usage", "参数解析失败", "见 --help")
    if unknown:
        return _usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    # 门①：人（**最先判**：非法调用连空账本都不创建）
    if not str(args.actor).startswith("human:"):
        return _usage_error("human-required",
                            f"--actor 必须以 human: 开头，收到 {args.actor!r}",
                            "签名只能由人做：--actor human:<你的名字>（agent 不得代签，ADR-0013 §3）")
    if not args.now or not ISO_RE.match(args.now):
        return _usage_error("usage-now", "缺 --now 或不是合法 ISO8601",
                            "显式给时间：--now 2026-09-21T15:00:00Z（本脚本不读墙钟）")
    if not DRAFT_RE.match(str(args.draft_id)):
        return _usage_error("draft-id-malformed", "缺 --draft-id 或形状非法（形如 qd-supplier-0123456789ab）",
                            "从 /quotagent/supplier/quotes/prepare/ 的「下一步（签署）」区域复制命令")
    if str(args.timeout_policy) not in TIMEOUT_POLICIES:
        return _usage_error("timeout-policy-invalid", f"取值必须是 {TIMEOUT_POLICIES}",
                            "不存在「超时自动批准」这一选项（06 §6）")

    ui_shared = Path(args.ui_shared)
    supplier_ledger = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    contractor_ledger = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"

    rows, error = load_rows(supplier_ledger)
    if error is not None or rows is None:
        return _usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    draft = draft_of(rows, str(args.draft_id))
    quote_id = quote_id_for(str(args.draft_id))
    approval_id = approval_id_for(str(args.draft_id))
    base = {"draft_id": str(args.draft_id), "quote_id": quote_id, "approval_id": approval_id,
            "ledger_supplier": str(supplier_ledger), "ledger_contractor": str(contractor_ledger),
            "actor": str(args.actor), "now": args.now, "scope": SCOPE, "dry_run": bool(args.dry_run)}
    # 门②：草稿必须真的在账本里
    if draft is None:
        return emit({**base, "ok": False, "event": None, "applied": [], "duplicates": [],
                     "ledger_added": 0,
                     "refusal": refusal("draft-not-found",
                                        f"供应商账本里没有 quote_draft_id={args.draft_id} 的 {EVENT_DRAFTED} 行",
                                        "先跑 tools/quote-draft.py 落草稿，再签（本脚本账本零新增）")}, 1)
    # 幂等：已签过就零新增
    if already_signed(rows, quote_id):
        return emit({**base, "ok": True, "event": EVENT_SUBMITTED, "applied": [],
                     "duplicates": [{"quote_id": quote_id, "draft_id": str(args.draft_id),
                                     "line_count": len(lines_of(draft)) or 1,
                                     "ledger_added": 0, "reason": "already-signed",
                                     "matched": "ledger-submitted"}],
                     "ledger_added": 0, "refusal": None,
                     "note": "同一份草稿已经签过：账本零新增（签名是幂等动作，不产生第二条报价事实）"}, 0)

    supplier_realm = str(rows[0].get("realm") or "") if rows else ""
    if not REALM_RE.match(supplier_realm):
        return _usage_error("supplier-unknown", "供应商账本的 realm 读不出来（不猜）",
                            "先让一条事实行落进供应商账本（realm 由账本给出）")
    # 草稿自述必须自洽：账本里的 `lines_sha256` 与**重算**的结构化行一致（被改过 ⇒ 拒、账本零新增）
    declared_digest = str(draft.get("lines_sha256") or "").split(":", 1)[-1]
    if declared_digest != hashlib.sha256(canonical_lines(draft).encode("utf-8")).hexdigest():
        return emit({**base, "ok": False, "event": None, "applied": [], "duplicates": [],
                     "ledger_added": 0,
                     "refusal": refusal("draft-tampered",
                                        f"草稿 {args.draft_id} 的 lines_sha256 与重算结果不符"
                                        "（行项目/单价/交期被改过？）",
                                        "这份草稿不可信：回供应商道重新备一份（本脚本账本零新增）")}, 1)
    contractor_rows, contractor_error = load_rows(contractor_ledger)
    if contractor_error is not None or contractor_rows is None:
        return _usage_error("ledger-unreadable", str(contractor_error),
                            "先修承包商账本（本脚本不往坏账本追加）")
    contractor_realm = str(contractor_rows[0].get("realm") or "") if contractor_rows else ""

    currency = str(draft.get("currency") or "CNY")
    item_id = str(draft.get("item_id") or "")
    unit_price_cents = draft.get("unit_price_cents")
    lead_time_days = draft.get("lead_time_days")
    package_id = str(draft.get("rfq_id") or "")
    supplier_id = str(draft.get("supplier") or supplier_realm)
    # ---- 多行报价：**一份报价 = 一整张表**（一次人签提交整份，不必一行签一次）------------------------
    # 草稿带 `lines` ⇒ 这次签出来的报价 body 逐行给 `lines`（+ `line_count`），
    # 标量三键（`item_id`/`unit_price_cents`/`lead_time_days`）**留空**：多行报价没有「唯一那个行项目」，
    # 编一个首行值当标量会让读者以为这份报价只有一行（`check-quote-draft-route.py` 逐行对账）。
    draft_lines = lines_of(draft)
    line_bodies: list[dict] = []
    for entry in draft_lines:
        line_item = str(entry.get("item_id") or "")
        cents = entry.get("unit_price_cents")
        lead = entry.get("lead_time_days")
        if not REF_RE.match(line_item) or isinstance(cents, bool) or not isinstance(cents, int) \
                or cents <= 0 or isinstance(lead, bool) or not isinstance(lead, int) or lead <= 0:
            return emit({**base, "ok": False, "event": None, "applied": [], "duplicates": [],
                         "ledger_added": 0,
                         "refusal": refusal("draft-line-invalid",
                                            f"草稿 {args.draft_id} 的某一行不合法：{entry!r}",
                                            "这一份草稿不可信：回供应商道重新备一份（本脚本账本零新增）")}, 1)
        line_bodies.append({"item_id": line_item, "lead_time_days": lead,
                            "unit_price": round(cents / 100.0, 6), "unit_price_cents": cents})
    if line_bodies:
        item_id = ""
        unit_price_cents = None
        lead_time_days = None
    submitted = {"approval_id": approval_id, "approved_by": str(args.actor), "currency": currency,
                 "item_id": item_id, "lead_time_days": lead_time_days, "package_id": package_id,
                 "quote_id": quote_id, "quote_draft_id": str(args.draft_id), "source": "quote-draft",
                 "submitted_at": args.now, "unit_price_cents": unit_price_cents}
    if line_bodies:
        submitted["lines"] = line_bodies
        submitted["line_count"] = len(line_bodies)
    notification = {**submitted, "supplier": supplier_id}
    what = (f"{len(line_bodies)} 行：" + " / ".join(f"{row['item_id']} {row['unit_price_cents']} 分"
                                                   for row in line_bodies[:4])) if line_bodies \
        else f"行项目 {item_id}，{unit_price_cents} 分"
    requested = {"approval_id": approval_id, "scope": SCOPE, "ref": quote_id, "status": "pending",
                 "requested_by": str(args.actor), "submitted_at": args.now,
                 "timeout_policy": str(args.timeout_policy),
                 "summary": f"提交报价 {quote_id}（{what}）"}
    granted = {**requested, "status": "granted", "decided_by": str(args.actor), "comment": str(args.comment)}

    applied: list[dict] = []
    ledger_added = 0
    if not args.dry_run:
        try:
            ledger = Ledger(supplier_ledger, realm=supplier_realm)
            ledger.append(EVENT_REQUESTED, requested, correlation_id=quote_id,
                          actor=str(args.actor), ts=args.now)
            ledger.append(EVENT_GRANTED, granted, correlation_id=quote_id,
                          actor=str(args.actor), ts=args.now)
            ledger.append(EVENT_SUBMITTED, submitted, correlation_id=quote_id,
                          actor=str(args.actor), ts=args.now)
            Ledger(contractor_ledger, realm=contractor_realm or "contractor:quote-sign").append(
                EVENT_SUBMITTED, notification, correlation_id=quote_id,
                actor=str(args.actor), ts=args.now)
        except LedgerError as exc:
            return _usage_error("ledger-frozen", str(exc)[0:200],
                                "先修账本（本脚本不往校验不过的账本追加任何行）")
        ledger_added = 4
    # 回执**可按 id 指认**（调用方要能核"这一份"是不是我签的，而不是猜 `applied[0]`）：
    # 每条 applied 都带 `draft_id` / `quote_id` / `approval_id` / `line_count`。
    applied.append({"view": "supplier", "events": [EVENT_REQUESTED, EVENT_GRANTED, EVENT_SUBMITTED],
                    "quote_id": quote_id, "draft_id": str(args.draft_id), "approval_id": approval_id,
                    "line_count": len(line_bodies) or 1,
                    "ledger_added": 0 if args.dry_run else 3,
                    "body_keys": sorted(SUBMITTED_BODY_KEYS_MULTI if line_bodies else SUBMITTED_BODY_KEYS)})
    applied.append({"view": "contractor", "events": [EVENT_SUBMITTED], "quote_id": quote_id,
                    "draft_id": str(args.draft_id), "approval_id": approval_id,
                    "ledger_added": 0 if args.dry_run else 1,
                    "body_keys": sorted(NOTIFICATION_BODY_KEYS + (("lines", "line_count") if line_bodies else ()))})

    return emit({**base, "ok": True, "event": EVENT_SUBMITTED, "applied": applied, "duplicates": [],
                 "ledger_added": ledger_added, "refusal": None,
                 "supplier": supplier_realm, "contractor": contractor_realm,
                 "draft": {key: draft.get(key) for key in sorted(draft)},
                 "note": "签名动作已落账：approval/requested → approval/granted → quote/submitted"
                         "（顺序不可颠倒，INV-005）；承包商账本同时得到「供应商已提交报价」的登记。"}, 0)


if __name__ == "__main__":
    raise SystemExit(main())
