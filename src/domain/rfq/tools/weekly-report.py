#!/usr/bin/env python3
"""**本周汇报**（只读汇总器 / 对账脚本）—— `domain/rfq` 的「这周到底发生了什么、花了多少钱」。

它只做一件事：把**一侧账本**（`--ledger`，默认用法是承包商侧）的**本周**事实行，聚合成五个
管理者/采购员真的会问的数字，并把**每一项的证据行原样列出来**（`seq` + `ts` + `type`）⇒ 报表与账本
**逐行可对**。因此本脚本：

  · **只读**：不写账本、不写投影、不落任何文件（`--out` 除外，且写的是本脚本自己的输出）；
  · **不取墙钟**：`--as-of` 缺省 = 账本里最大的 `ts`（已知的最新**事实**时刻）——
    同一份账本在任何时间跑都输出**逐字节一致**的数字（与 `gate-timeline` 的 `age_clock:"facts-only"` 同一口径）；
  · **不造假数字**：算不出来的行（缺量/缺价）进 `amount_missing` 并**排除出小计**（不当 0 冒充）；
    配不上对的审批门进 `gate_unmatched`；读不出来的账本行**跳过并计数**（`dropped_lines`）；
  · **不建门、不改账本格式**：它是 `tools/` 下的只读工具（与 `compare-rank.py`、`gate-nudge.py` 同族）。

五项指标（口径都写在输出里的 `metrics.*.basis`，照抄即可）：

  ① `packages_published`   本周落 `rfq/published` 的**发布包数**（含逐包 rev）；
  ② `quotes_received`      本周落 `quote/submitted` 的**收报价数**；
  ③ `award_amount_cents`   本周落 `award/committed` 的**授标金额**（Σ 量×单价，**整数分**；
                           单价优先取 `unit_price_cents`，只有 `unit_price` 时 ×100 —— 口径逐行给出）；
  ④ `gate_avg_wait_seconds` 本周**被决定**的人工门：平均等待 = Σ(决定时刻 − 请求时刻) / 门数
                           （配对键 = `approval_id` + `scope` + `payload_hash`，**不靠 id 单键**：
                             实测同一份账本里 `ap-0001` 会被 award.commit 与 po.issue 两门复用）；
  ⑤ `overdue_no_reply`     截至 `as_of` **已过报价截止、而本账本里没有任何对应报价**的包
                           （`quote_by` < `as_of` 且无 `quote/submitted(package_id=…)`）。

附加（同一把尺子量出来的，标 `supporting`）：本周 `po/issued` 张数与 `total_amount`（账本原生币种）。

用法（人类可读 / 表格 / 原始 JSON / 原始证据）：
    python3 src/domain/rfq/tools/weekly-report.py --ledger tmp/p26-run/contractor/ledger.jsonl
    python3 src/domain/rfq/tools/weekly-report.py --ledger … --format text --as-of 2026-09-25T00:00:00Z
    python3 src/domain/rfq/tools/weekly-report.py --ledger … --format csv  --weeks-ago 1
    python3 src/domain/rfq/tools/weekly-report.py --ledger … --format evidence-csv
退出码：0 = 出了一份报表（**注意**：`degraded` 也算 0，降级原因在 `notes/degraded` 里）；
        2 = 账本读不出来/参数非法（`ok:false` + 有名 `code`）。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

SCHEMA = "quotagent/weekly-report/v1"
TOOL = "weekly-report"
VIEW = "contractor"
DECISION_EVENTS = ("approval/granted", "approval/denied", "approval/aborted")
CENTS = Decimal("0.01")


def emit(payload: dict, code: int = 0) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    return code


def parse_ts(value) -> datetime | None:
    raw = str(value or "").strip()
    if raw == "":
        return None
    text = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def iso(ts: datetime | None) -> str:
    """ISO 秒精度时刻（`…Z`）；给不出可读时刻的行**如实返回空串**（不猜、不补）。"""
    if ts is None:
        return ""
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_ledger(path: Path) -> tuple[list[dict], int]:
    """读账本（append-only JSONL）。读不出来的行**跳过并计数** —— 不猜、不补。"""
    rows: list[dict] = []
    dropped = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line == "":
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                dropped += 1
                continue
            if not isinstance(parsed, dict):
                dropped += 1
                continue
            rows.append(parsed)
    return rows, dropped


def week_window(as_of: datetime) -> tuple[datetime, datetime]:
    """`as_of` 所在的 ISO 周（周一 00:00:00Z 起、到下一个周一 00:00:00Z 止，左闭右开）。"""
    day = as_of.astimezone(timezone.utc)
    monday = (day - timedelta(days=day.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return monday, monday + timedelta(days=7)


def in_window(ts: datetime | None, start: datetime, end: datetime) -> bool:
    return ts is not None and start <= ts < end


def body_of(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def to_decimal(value) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def line_cents(line: dict) -> tuple[int | None, str]:
    """一条授标行 →（整数分, 口径字符串）。**算不出来就返回 None**（调用方列进 `amount_missing`）。"""
    qty = to_decimal(line.get("qty"))
    if qty is None:
        return None, "该行没有可读的 `qty`"
    cents = to_decimal(line.get("unit_price_cents"))
    if cents is not None:
        basis = f"unit_price_cents={line.get('unit_price_cents')}×qty={line.get('qty')}"
    else:
        price = to_decimal(line.get("unit_price"))
        if price is None:
            return None, "该行既没有 `unit_price_cents` 也没有 `unit_price`"
        cents = (price * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        basis = f"unit_price={line.get('unit_price')}×100 ×qty={line.get('qty')}"
    total = (qty * cents).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(total), basis


def cents_str(cents: int) -> str:
    """整数分 → 两位小数字符串（只在**显示**时格式化；数字一律整数分）。"""
    return str((Decimal(cents) * CENTS).quantize(CENTS))


def build(ledger: Path, as_of_arg: str, weeks_ago: int, week_arg: str) -> dict:
    if not ledger.exists():
        return {"ok": False, "tool": TOOL, "schema": SCHEMA, "code": "ledger-missing",
                "reason": f"账本不存在：{ledger}",
                "next_action": "给 --ledger 一个真实存在的账本（一侧一个文件；默认用法是承包商侧）",
                "ledger_added": 0}
    try:
        rows, dropped = read_ledger(ledger)
    except OSError as exc:  # noqa: BLE001
        return {"ok": False, "tool": TOOL, "schema": SCHEMA, "code": "ledger-unreadable",
                "reason": f"{type(exc).__name__}: {exc}", "ledger_added": 0}
    if not rows:
        return {"ok": False, "tool": TOOL, "schema": SCHEMA, "code": "ledger-empty",
                "reason": f"账本里一行事实都没有：{ledger}",
                "next_action": "先产生事实（发布 RFQ / 提交报价…）；空账本给不出周报，也不编一个",
                "ledger_added": 0}

    stamped = [(row, parse_ts(row.get("ts"))) for row in rows]
    known = [ts for _, ts in stamped if ts is not None]
    if not known:
        return {"ok": False, "tool": TOOL, "schema": SCHEMA, "code": "ledger-ts-unreadable",
                "reason": "账本里没有一行带可读的 `ts`（周窗口无从定义）", "ledger_added": 0}

    as_of_basis = "ledger-max-ts"
    if str(as_of_arg or "").strip() != "":
        parsed = parse_ts(as_of_arg)
        if parsed is None:
            return {"ok": False, "tool": TOOL, "schema": SCHEMA, "code": "as-of-malformed",
                    "reason": f"--as-of 不是 ISO 时刻：{as_of_arg!r}",
                    "next_action": "写 `2026-09-25T00:00:00Z` 这样的 ISO 时刻", "ledger_added": 0}
        as_of, as_of_basis = parsed, "given"
    elif str(week_arg or "").strip() != "":
        try:
            year, week = str(week_arg).split("-W")
            as_of = datetime.fromisocalendar(int(year), int(week), 1).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return {"ok": False, "tool": TOOL, "schema": SCHEMA, "code": "week-malformed",
                    "reason": f"--week 不是 ISO 周：{week_arg!r}（要 `2026-W39` 这样）", "ledger_added": 0}
        as_of, as_of_basis = as_of, "given-week"
    else:
        as_of = max(known)
    as_of = as_of - timedelta(weeks=max(0, weeks_ago))
    if weeks_ago > 0:
        # 口径自述要**如实**：这一次的事实时刻不是账本最大值，而是它再往前挪了 N 周
        as_of_basis = f"{as_of_basis}-minus-{weeks_ago}w"
    start, end = week_window(as_of)

    notes: list[str] = []
    evidence: dict[str, list[dict]] = {}

    # ---- ① 本周发布包数 ----------------------------------------------------------------
    published = []
    for row, ts in stamped:
        if row.get("type") != "rfq/published" or not in_window(ts, start, end):
            continue
        body = body_of(row)
        published.append({"seq": row.get("seq"), "ts": iso(ts), "package_id": str(body.get("package_id") or ""),
                          "rev": body.get("rev"), "items": body.get("items"),
                          "quote_by": body.get("quote_by")})
    evidence["packages_published"] = published

    # ---- ② 本周收报价数 ----------------------------------------------------------------
    quotes = []
    for row, ts in stamped:
        if row.get("type") != "quote/submitted" or not in_window(ts, start, end):
            continue
        body = body_of(row)
        raw_lines = body.get("lines")
        lines = raw_lines if isinstance(raw_lines, list) else []
        item_id = str(body.get("item_id") or "")
        # **两种行形状**（口径逐条摆出来，不猜）：多行报价带 `lines[]`（或 `line_count`）；
        # 单行报价**没有 `lines[]`**（body 里只有 `item_id`/`unit_price_cents`）⇒ 行数按 1 计。
        if lines:
            counted = len(lines)
        elif item_id:
            counted = 1
        else:
            counted = 0
        quotes.append({"seq": row.get("seq"), "ts": iso(ts), "quote_id": str(body.get("quote_id") or ""),
                       "package_id": str(body.get("package_id") or ""), "supplier": str(body.get("supplier") or ""),
                       "rfq_rev": body.get("rfq_rev"), "line_count": body.get("line_count") or counted,
                       "line_shape": "多行（lines[]）" if lines else ("单行（无 lines[]）" if item_id else "读不出行"),
                       "item_id": item_id,
                       "unit_price_cents": body.get("unit_price_cents")})
    evidence["quotes_received"] = quotes

    # ---- ③ 本周授标金额（整数分；算不出来的行**排除出小计**并逐条列出）-------------------
    awards = []
    amount_missing: list[dict] = []
    award_total = 0
    for row, ts in stamped:
        if row.get("type") != "award/committed" or not in_window(ts, start, end):
            continue
        body = body_of(row)
        raw_lines = body.get("lines")
        lines = raw_lines if isinstance(raw_lines, list) else []
        subtotal = 0
        per_line = []
        for index, line in enumerate(lines):
            if not isinstance(line, dict):
                amount_missing.append({"metric": "award_amount_cents", "seq": row.get("seq"),
                                       "award_id": str(body.get("award_id") or ""), "line": index,
                                       "why": "这一行不是对象"})
                continue
            cents, basis = line_cents(line)
            if cents is None:
                amount_missing.append({"metric": "award_amount_cents", "seq": row.get("seq"),
                                       "award_id": str(body.get("award_id") or ""),
                                       "item_id": str(line.get("item_id") or line.get("ref_line") or ""),
                                       "why": basis})
                continue
            subtotal += cents
            per_line.append({"item_id": str(line.get("item_id") or line.get("ref_line") or ""),
                             "qty": line.get("qty"), "amount_cents": cents, "basis": basis})
        award_total += subtotal
        awards.append({"seq": row.get("seq"), "ts": iso(ts), "award_id": str(body.get("award_id") or ""),
                       "quote_id": str(body.get("quote_id") or ""), "package_id": str(body.get("package_id") or ""),
                       "approved_by": str(body.get("approved_by") or ""), "approval_id": str(body.get("approval_id") or ""),
                       "lines": per_line, "amount_cents": subtotal,
                       "lines_missing": len(lines) - len(per_line)})
    evidence["award_amount_cents"] = awards

    # ---- ④ 人工门平均等待（配不上对的**如实列出**）--------------------------------------
    pending: dict[tuple, dict] = {}
    for row, ts in stamped:
        if row.get("type") != "approval/requested":
            continue
        body = body_of(row)
        key = (str(body.get("approval_id") or ""), str(body.get("scope") or ""),
               str(body.get("payload_hash") or ""))
        pending.setdefault(key, {"seq": row.get("seq"), "at": ts, "approval_id": key[0], "scope": key[1],
                                 "ref": str(body.get("ref") or ""), "payload_hash": key[2]})
    gates = []
    unmatched = []
    total_wait = 0
    for row, ts in stamped:
        if row.get("type") not in DECISION_EVENTS or not in_window(ts, start, end):
            continue
        body = body_of(row)
        key = (str(body.get("approval_id") or ""), str(body.get("scope") or ""),
               str(body.get("payload_hash") or ""))
        asked = pending.get(key)
        if asked is None or asked["at"] is None or ts is None:
            unmatched.append({"seq": row.get("seq"), "ts": iso(ts), "type": row.get("type"),
                              "approval_id": key[0], "scope": key[1],
                              "why": "本账本里没有配对上的 approval/requested"
                                     "（配对键 = approval_id + scope + payload_hash）"})
            continue
        wait = int((ts - asked["at"]).total_seconds())
        if wait < 0:
            unmatched.append({"seq": row.get("seq"), "ts": iso(ts), "type": row.get("type"),
                              "approval_id": key[0], "scope": key[1],
                              "why": f"决定时刻早于请求时刻（{iso(ts)} < {iso(asked['at'])}）"})
            continue
        total_wait += wait
        gates.append({"request_seq": asked["seq"], "request_ts": iso(asked["at"]), "decided_seq": row.get("seq"),
                      "decided_ts": iso(ts), "decision": row.get("type"), "scope": key[1],
                      "approval_id": key[0], "ref": asked["ref"],
                      "decided_by": str(body.get("decided_by") or ""), "wait_seconds": wait})
    gates.sort(key=lambda item: (item["decided_ts"], item["decided_seq"] or 0))
    avg = round(total_wait / len(gates), 1) if gates else None
    evidence["gate_avg_wait_seconds"] = gates

    # ---- ⑤ 超时未回（截至 as_of）-------------------------------------------------------
    replied: set[str] = set()
    for row, _ in stamped:
        if row.get("type") != "quote/submitted":
            continue
        body = body_of(row)
        package_id = str(body.get("package_id") or "")
        if package_id != "":
            replied.add(package_id)
    overdue = []
    for row, ts in stamped:
        if row.get("type") != "rfq/published":
            continue
        body = body_of(row)
        package_id = str(body.get("package_id") or "")
        deadline = parse_ts(body.get("quote_by"))
        if package_id == "" or deadline is None or deadline >= as_of or package_id in replied:
            continue
        overdue.append({"seq": row.get("seq"), "ts": iso(ts) if ts else "", "package_id": package_id,
                        "rev": body.get("rev"), "quote_by": iso(deadline),
                        "overdue_seconds": int((as_of - deadline).total_seconds()),
                        "overdue_days": round((as_of - deadline).total_seconds() / 86400, 1),
                        "why": "已过报价截止，且本账本里没有这个包的 quote/submitted"})
    overdue.sort(key=lambda item: item["quote_by"])
    evidence["overdue_no_reply"] = overdue

    # ---- 附加：本周发 PO（同一把尺子）---------------------------------------------------
    pos = []
    for row, ts in stamped:
        if row.get("type") != "po/issued" or not in_window(ts, start, end):
            continue
        body = body_of(row)
        raw_lines = body.get("lines")
        lines = raw_lines if isinstance(raw_lines, list) else []
        pos.append({"seq": row.get("seq"), "ts": iso(ts), "po_id": str(body.get("po_id") or ""),
                    "award_id": str(body.get("award_id") or ""), "quote_id": str(body.get("quote_id") or ""),
                    "total_amount": body.get("total_amount"), "lines": len(lines)})
    evidence["po_issued"] = pos

    if dropped:
        notes.append(f"账本里有 {dropped} 行读不出来（不是 JSON 对象）——**已跳过并计数**，不进任何小计")
    if amount_missing:
        notes.append(f"有 {len(amount_missing)} 条授标行缺量或缺价 ⇒ **排除出授标金额小计**（不当 0 冒充）；逐条见 `amount_missing`")
    if unmatched:
        notes.append(f"有 {len(unmatched)} 条审批决定配不上请求行 ⇒ 不进平均等待；逐条见 `gate_unmatched`")
    if not gates and not unmatched:
        notes.append("本周没有任何被决定的人工门 ⇒ 平均等待为 `null`（**不是 0**：0 会被读成「秒批」）")
    if not pos:
        notes.append("本周没有发 PO（`po/issued` 零行）")
    notes.append(f"窗口口径：ISO 周 [{iso(start)}, {iso(end)}) 左闭右开；`as_of={iso(as_of)}`"
                 f"（{as_of_basis}，**不取墙钟**）")

    return _finalize({
        "ok": True, "tool": TOOL, "schema": SCHEMA, "view": VIEW,
        "ledger": str(ledger), "ledger_realm": str(rows[0].get("realm") or ""),
        "as_of": iso(as_of), "as_of_basis": as_of_basis,
        "week": {"start": iso(start), "end": iso(end), "iso": f"{start.isocalendar()[0]}-W{start.isocalendar()[1]:02d}",
                 "note": "ISO 周（周一 00:00Z 起，左闭右开）"},
        "ledger_rows": len(rows), "dropped_lines": dropped,
        "metrics": {
            "packages_published": {"value": len(published), "unit": "包",
                                   "distinct_packages": len({item["package_id"] for item in published if item["package_id"]}),
                                   "basis": "本周 `rfq/published` **行数**（同一包重复发布 = 多行；"
                                            "不同包 id 的个数见 `distinct_packages`）；逐行见 evidence.packages_published",
                                   "rows": [item["seq"] for item in published]},
            "quotes_received": {"value": len(quotes), "unit": "份",
                                "distinct_quotes": len({item["quote_id"] for item in quotes if item["quote_id"]}),
                                "basis": "本周 `quote/submitted` 行数（逐行见 evidence.quotes_received；"
                                         "行数按报价的行形状算：多行带 `lines[]`、**单行没有 `lines[]`** ⇒ 按 1 行）",
                                "rows": [item["seq"] for item in quotes]},
            "award_amount_cents": {"value": award_total, "unit": "分", "display": f"{cents_str(award_total)} 元",
                                   "awards": len(awards),
                                   "basis": "本周 `award/committed` 逐行 Σ(量×单价)，单价优先 `unit_price_cents`、"
                                            "否则 `unit_price`×100（每行的口径见 evidence.award_amount_cents[].lines[].basis）",
                                   "rows": [item["seq"] for item in awards]},
            "gate_avg_wait_seconds": {"value": avg, "unit": "秒", "gates": len(gates),
                                      "total_wait_seconds": total_wait,
                                      "basis": "本周**被决定**的人工门平均等待 = Σ(决定 ts − 请求 ts) / 门数；"
                                               "配对键 approval_id+scope+payload_hash（逐门见 evidence.gate_avg_wait_seconds）",
                                      "rows": [item["decided_seq"] for item in gates]},
            "overdue_no_reply": {"value": len(overdue), "unit": "包",
                                 "basis": f"`quote_by` < as_of({iso(as_of)}) 且本账本里没有对应 `quote/submitted` 的包",
                                 "rows": [item["seq"] for item in overdue]},
        },
        "supporting": {
            "po_issued": {"value": len(pos), "unit": "张",
                          "total_amount_native": str(sum((Decimal(str(item["total_amount"] or 0))
                                                          for item in pos), Decimal(0))),
                          "note": "`po/issued.total_amount` 是账本原生币种金额（未换算成整数分；"
                                  "要整数分的是 ③ 授标金额，它按行 `qty×单价` 算）"},
        },
        "evidence": evidence,
        "amount_missing": amount_missing,
        "gate_unmatched": unmatched,
        "notes": notes,
        "discipline": "只读：不写账本、不写投影（`ledger_added: 0`）；不取墙钟（as_of 来自事实）；"
                      "算不出来的数字进 amount_missing/gate_unmatched，**不当 0**",
    })


def _finalize(report: dict) -> dict:
    """把**人读正文**与**指标 CSV** 一起放进同一份 JSON。

    为什么让工具自己渲染、而不在界面侧再写一遍：口径只该有**一份实现** —— 界面拿 `text`/`csv` 字段
    直接给用户下载/预览（不走 `stdout` 截断的通道），CLI 的 `--format text|csv` 打印的也是同两个字符串，
    两边不可能漂移。渲染是**纯函数**（只读 report），不写任何东西。
    """
    report["text"] = render_text(report)
    report["csv"] = render_csv(report)
    return report


def render_text(report: dict) -> str:
    metrics = report["metrics"]
    week = report["week"]
    lines = [f"本周汇报（{week['iso']} · {week['start']} — {week['end']}）",
             f"账本：{report['ledger']}   事实时刻 as_of：{report['as_of']}（{report['as_of_basis']}）",
             "-" * 72]
    lines.append(f"① 发布包数            {metrics['packages_published']['value']}"
                 f" 行（{metrics['packages_published'].get('distinct_packages', '?')} 个不同的包 id）")
    for item in report["evidence"]["packages_published"]:
        lines.append(f"     · seq {item['seq']}  {item['ts']}  {item['package_id']} rev{item['rev']}"
                     f"  截止 {item['quote_by']}")
    lines.append(f"② 收报价数            {metrics['quotes_received']['value']}"
                 f" 份（{metrics['quotes_received'].get('distinct_quotes', '?')} 个不同的报价 id）")
    for item in report["evidence"]["quotes_received"]:
        lines.append(f"     · seq {item['seq']}  {item['ts']}  {item['quote_id']}  包 {item['package_id']}"
                     f"  {item['line_count']} 行（{item.get('line_shape', '')}）")
    award = metrics["award_amount_cents"]
    lines.append(f"③ 授标金额            {award['value']} 分（{award['display']}）· {award['awards']} 份承诺")
    for item in report["evidence"]["award_amount_cents"]:
        lines.append(f"     · seq {item['seq']}  {item['ts']}  {item['award_id']}  {item['amount_cents']} 分"
                     f"（{len(item['lines'])} 行）")
    gate = metrics["gate_avg_wait_seconds"]
    lines.append(f"④ 人工门平均等待      {gate['value'] if gate['value'] is not None else '（本周没有门被决定）'}"
                 f" 秒 · {gate['gates']} 门 · 合计 {gate['total_wait_seconds']} 秒")
    for item in report["evidence"]["gate_avg_wait_seconds"]:
        lines.append(f"     · {item['approval_id']} {item['scope']}  等 {item['wait_seconds']} 秒"
                     f"（{item['request_ts']} → {item['decided_ts']}，{item['decision'].split('/')[-1]}）")
    late = metrics["overdue_no_reply"]
    lines.append(f"⑤ 超时未回            {late['value']} 包")
    for item in report["evidence"]["overdue_no_reply"]:
        lines.append(f"     · seq {item['seq']}  {item['package_id']} rev{item['rev']}  截止 {item['quote_by']}"
                     f"  已超 {item['overdue_days']} 天")
    supporting = report["supporting"]["po_issued"]
    lines.append(f"（附加）本周发 PO      {supporting['value']} 张 · 原生金额合计 {supporting['total_amount_native']}")
    lines.append("-" * 72)
    for note in report["notes"]:
        lines.append(f"· {note}")
    lines.append("对账：每一项的 `evidence.*` 都带账本行号（seq）⇒ 逐行可与账本核对；"
                 "本报表不写账本、不取墙钟、算不出来就不算（见 amount_missing / gate_unmatched）")
    return "\n".join(lines) + "\n"


def render_csv(report: dict) -> str:
    head = ["指标", "数值", "单位", "口径", "证据账本行号", "附加读数"]
    rows = [
        ["发布包数", report["metrics"]["packages_published"]["value"], "包",
         report["metrics"]["packages_published"]["basis"],
         " ".join(str(item) for item in report["metrics"]["packages_published"]["rows"]),
         f"distinct_packages={report['metrics']['packages_published'].get('distinct_packages')}"],
        ["收报价数", report["metrics"]["quotes_received"]["value"], "份",
         report["metrics"]["quotes_received"]["basis"],
         " ".join(str(item) for item in report["metrics"]["quotes_received"]["rows"]),
         f"distinct_quotes={report['metrics']['quotes_received'].get('distinct_quotes')}"],
        ["授标金额", report["metrics"]["award_amount_cents"]["value"], "分",
         report["metrics"]["award_amount_cents"]["basis"],
         " ".join(str(item) for item in report["metrics"]["award_amount_cents"]["rows"]),
         f"display={report['metrics']['award_amount_cents']['display']}; awards="
         f"{report['metrics']['award_amount_cents']['awards']}"],
        ["人工门平均等待", report["metrics"]["gate_avg_wait_seconds"]["value"]
         if report["metrics"]["gate_avg_wait_seconds"]["value"] is not None else "", "秒",
         report["metrics"]["gate_avg_wait_seconds"]["basis"],
         " ".join(str(item) for item in report["metrics"]["gate_avg_wait_seconds"]["rows"]),
         f"gates={report['metrics']['gate_avg_wait_seconds']['gates']}; total_wait_seconds="
         f"{report['metrics']['gate_avg_wait_seconds']['total_wait_seconds']}"],
        ["超时未回", report["metrics"]["overdue_no_reply"]["value"], "包",
         report["metrics"]["overdue_no_reply"]["basis"],
         " ".join(str(item) for item in report["metrics"]["overdue_no_reply"]["rows"]), ""],
        ["（附加）本周发 PO", report["supporting"]["po_issued"]["value"], "张",
         "本周 `po/issued` 行数", "",
         f"total_amount_native={report['supporting']['po_issued']['total_amount_native']}"],
    ]
    out = [",".join(head)]
    for row in rows:
        out.append(",".join('"' + str(cell).replace('"', '""') + '"' for cell in row))
    return "\n".join(out) + "\n"


def render_evidence_csv(report: dict) -> str:
    out = ["metric,seq,ts,type_or_event,object,amount_cents,detail"]
    for item in report["evidence"]["packages_published"]:
        out.append(f"packages_published,{item['seq']},{item['ts']},rfq/published,{item['package_id']},,"
                   f"rev{item['rev']} quote_by={item['quote_by']}")
    for item in report["evidence"]["quotes_received"]:
        out.append(f"quotes_received,{item['seq']},{item['ts']},quote/submitted,{item['quote_id']},,"
                   f"package={item['package_id']} lines={item['line_count']}")
    for item in report["evidence"]["award_amount_cents"]:
        for line in item["lines"]:
            out.append(f"award_amount_cents,{item['seq']},{item['ts']},award/committed,"
                       f"{item['award_id']}:{line['item_id']},{line['amount_cents']},\"{line['basis']}\"")
    for item in report["evidence"]["gate_avg_wait_seconds"]:
        out.append(f"gate_avg_wait_seconds,{item['decided_seq']},{item['decided_ts']},{item['decision']},"
                   f"{item['approval_id']},,wait_seconds={item['wait_seconds']} scope={item['scope']}")
    for item in report["evidence"]["overdue_no_reply"]:
        out.append(f"overdue_no_reply,{item['seq']},{item['ts']},rfq/published,{item['package_id']},,"
                   f"quote_by={item['quote_by']} overdue_days={item['overdue_days']}")
    for item in report["evidence"]["po_issued"]:
        out.append(f"po_issued,{item['seq']},{item['ts']},po/issued,{item['po_id']},,"
                   f"total_amount={item['total_amount']}")
    for item in report["amount_missing"]:
        out.append(f"amount_missing,{item['seq']},,award/committed,{item.get('award_id', '')},,"
                   f"\"{item['why']}\"")
    for item in report["gate_unmatched"]:
        out.append(f"gate_unmatched,{item['seq']},{item['ts']},approval,{item['approval_id']},,\"{item['why']}\"")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="本周汇报（只读汇总器）：五项指标逐行可从账本对账")
    parser.add_argument("--ledger", required=True, help="一侧账本的 JSONL 路径（默认用法：承包商侧）")
    parser.add_argument("--as-of", default="", help="事实时刻（ISO；缺省 = 账本里最大的 ts，**不取墙钟**）")
    parser.add_argument("--week", default="", help="按 ISO 周取（如 2026-W39）；与 --as-of 同时给时以 --as-of 为准")
    parser.add_argument("--weeks-ago", type=int, default=0, help="把窗口整体往前挪 N 周（对比上周用）")
    parser.add_argument("--format", default="json", choices=["json", "text", "csv", "evidence-csv"],
                        help="json（默认，给界面/脚本）· text（给人读/贴周报）· csv（指标表）· evidence-csv（逐行证据）")
    parser.add_argument("--out", default="", help="把渲染结果写到这个文件（可选；不写账本）")
    args = parser.parse_args(argv)

    report = build(Path(args.ledger), args.as_of, args.weeks_ago, args.week)
    if not report.get("ok"):
        return emit(report, 2)
    rendered = {"json": lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n",
                # text / csv 用**报告里那两个字段**（工具自己渲染的那一份；界面导出用的是同一份）
                "text": lambda item: item.get("text", ""),
                "csv": lambda item: item.get("csv", ""),
                "evidence-csv": render_evidence_csv}[args.format](report)
    if args.out:
        Path(args.out).write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
