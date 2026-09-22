#!/usr/bin/env python3
"""src/domain/quote-prepare/tools/quote-inbox.py —— 「承包商报价收件箱」的**只读**汇总（DEF-011）。

账本**零新增**、不取墙钟、不联网：只把承包商自己那本账本里的 `quote/submitted` 行按**包**归组，
并把行级明细（量从本侧包快照的清单取）、已作废标记（`quote/superseded`）、受理状态
（`approval/*` 里 `scope=quote-review:<decision>` 的行）摊平成一张表给界面。

用法（GUI 面板通过 `host.runPython` 调它）：
  python3 src/domain/quote-prepare/tools/quote-inbox.py --ui-shared tmp/run-shared \\
      --ledger-contractor tmp/run-shared/contractor/ledger.jsonl
stdout 恰一行 JSON。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

SCOPE_PREFIX = "quote-review:"
DECISION_LABEL = {"accepted": "已受理", "returned": "已退回", "need-info": "待补件"}
NEXT_OF = {"accepted": "受理过的报价可以进入比价（比价仍需人签权重/导出）",
           "returned": "退回的报价不参与比价；等对方重报",
           "need-info": "等对方补件后重新提交（旧报价不自动失效）"}
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


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


def snapshot_items(ui_shared: Path, package_id: str) -> tuple[dict[str, dict], int, dict]:
    """本侧包快照的清单（量/单位/描述）与版本号（唯一写者 `rfq-publish.py` 落的）。"""
    candidates = sorted((ui_shared / "contractor").glob(f"rfq-{package_id}-rev*.json"))
    if not candidates:
        return {}, 0, {}
    try:
        snapshot = json.loads(candidates[-1].read_text(encoding="utf-8"))
    except ValueError:
        return {}, 0, {}
    spec = snapshot.get("spec") if isinstance(snapshot.get("spec"), dict) else {}
    items = {str(item.get("item_id")): item for item in (spec.get("items") or [])}
    return items, int(snapshot.get("rev") or 0), snapshot


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="报价收件箱（只读；账本零新增）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--package-id", default="")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return emit({"ok": False, "refusal": {"code": "usage-unknown-flag", "reason": str(unknown),
                                              "next_action": "去掉不认识的参数"}}, 2)
    ui_shared = Path(args.ui_shared)
    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return emit({"ok": False, "refusal": {"code": "ledger-unreadable", "reason": str(error),
                                              "next_action": "先修账本（本脚本只读）"}}, 2)

    quotes: dict[str, dict] = {}
    superseded: set[str] = set()
    for row in rows:
        type_ = str(row.get("type") or "")
        body = body_of(row)
        if type_ == "quote/superseded":
            for key in ("quote_id", "superseded_quote_id"):
                if body.get(key):
                    superseded.add(str(body[key]))
            for item in body.get("quotes") or []:
                if isinstance(item, dict) and item.get("quote_id"):
                    superseded.add(str(item["quote_id"]))
            continue
        if type_ != "quote/submitted":
            continue
        quote_id = str(body.get("quote_id") or "")
        if not quote_id:
            continue
        # 一行 = 一个条目（单行报价：标量 `item_id`/`unit_price_cents`；多行报价：`lines[]` 逐行）
        cells: list[tuple[str, float, object]] = []
        item_id = str(body.get("item_id") or "")
        cents = body.get("unit_price_cents")
        if item_id and isinstance(cents, (int, float)):
            cells.append((item_id, float(cents), body.get("lead_time_days")))
        for entry_line in (body.get("lines") or []):
            if not isinstance(entry_line, dict):
                continue
            line_item = str(entry_line.get("item_id") or "")
            line_cents = entry_line.get("unit_price_cents")
            if not isinstance(line_cents, (int, float)):
                price = entry_line.get("unit_price")
                line_cents = float(price) * 100.0 if isinstance(price, (int, float)) else None
            if line_item and isinstance(line_cents, (int, float)):
                cells.append((line_item, float(line_cents), entry_line.get("lead_time_days")))
        if not cells:
            continue
        entry = quotes.setdefault(quote_id, {"quote_id": quote_id, "package_id": str(body.get("package_id") or ""),
                                             "supplier": str(body.get("supplier") or ""),
                                             "currency": str(body.get("currency") or "CNY"),
                                             "submitted_at": str(row.get("ts") or ""),
                                             "approval_id": body.get("approval_id"),
                                             "approved_by": body.get("approved_by"), "items": {}})
        for line_item, line_cents, line_lead in cells:
            entry["items"][line_item] = {"unit_price_cents": line_cents, "lead_time_days": line_lead}

    reviews: dict[str, dict] = {}
    latest_ts = ""
    for row in rows:
        latest_ts = max(latest_ts, str(row.get("ts") or ""))
        if not str(row.get("type") or "").startswith("approval/"):
            continue
        body = body_of(row)
        scope = str(body.get("scope") or "")
        if not scope.startswith(SCOPE_PREFIX):
            continue
        quote_id = str(body.get("ref") or "")
        if not quote_id:
            continue
        entry = reviews.setdefault(quote_id, {"decision": scope[len(SCOPE_PREFIX):], "status": "pending",
                                              "by": None, "comment": "", "at": "", "approval_id": None})
        if str(body.get("status") or "") in ("granted", "denied"):
            entry.update({"status": body.get("status"), "by": body.get("decided_by"),
                          "comment": body.get("comment") or "", "at": str(row.get("ts") or ""),
                          "approval_id": body.get("approval_id")})

    packages: dict[str, dict] = {}
    for entry in quotes.values():
        package_id = entry["package_id"] or "(未标注包)"
        bag = packages.setdefault(package_id, {"package_id": package_id, "quotes": []})
        items, rev, snapshot = snapshot_items(ui_shared, package_id)
        bag["rev"] = max(int(bag.get("rev") or 0), rev)
        bag.setdefault("quote_by", ((snapshot.get("deadlines") or {}).get("quote_by")) if snapshot else None)
        detail = []
        total_cents = 0.0
        for item_id, cell in sorted(entry["items"].items()):
            meta = items.get(item_id) or {}
            qty = meta.get("qty")
            qty = float(qty) if isinstance(qty, (int, float)) else None
            line_total = (qty * cell["unit_price_cents"]) if qty is not None else None
            if line_total is not None:
                total_cents += line_total
            detail.append({"item_id": item_id, "description": meta.get("description") or "",
                           "unit": meta.get("unit") or "", "qty": qty,
                           "unit_price_cents": cell["unit_price_cents"],
                           "line_total_cents": line_total, "lead_time_days": cell.get("lead_time_days")})
        review = reviews.get(entry["quote_id"]) or {}
        decision = review.get("decision")
        bag["quotes"].append({"quote_id": entry["quote_id"], "supplier": entry["supplier"],
                              "currency": entry["currency"], "submitted_at": entry["submitted_at"],
                              "approved_by": entry["approved_by"], "approval_id": entry["approval_id"],
                              "items": detail, "total_cents": round(total_cents, 6),
                              "vs_current_rev": ("作废（基于旧版本）" if entry["quote_id"] in superseded else "有效"),
                              "superseded": entry["quote_id"] in superseded,
                              "review_status": DECISION_LABEL.get(decision, "待审") if review else "待审",
                              "review_decision": decision or None,
                              "reviewed_by": review.get("by"), "reviewed_at": review.get("at") or "",
                              "review_comment": review.get("comment") or "",
                              "review_approval_id": review.get("approval_id")})
    ordered = [packages[key] for key in sorted(packages)]
    for bag in ordered:
        bag["quotes"].sort(key=lambda item: (item["total_cents"], item["quote_id"]))
        bag["counts"] = {"quotes": len(bag["quotes"]),
                         "pending": sum(1 for item in bag["quotes"] if item["review_status"] == "待审"),
                         "superseded": sum(1 for item in bag["quotes"] if item["superseded"])}
    total = sum(item["counts"]["quotes"] for item in ordered)
    if not total:
        return emit({"ok": True, "degraded": True, "reason": "no-submitted-quotes", "packages": [],
                     "counts": {"packages": 0, "quotes": 0, "pending": 0},
                     "as_of": latest_ts,
                     "next_action": "等供应商在 APP 里「人签提交报价」；提交后这里会出现按包分组的收件箱",
                     "note": "承包商自己的账本里还没有已送达的报价事实（不编候选）"}, 0)
    return emit({"ok": True, "degraded": False, "packages": ordered,
                 "counts": {"packages": len(ordered), "quotes": total,
                            "pending": sum(item["counts"]["pending"] for item in ordered),
                            "superseded": sum(item["counts"]["superseded"] for item in ordered)},
                 "as_of": latest_ts,
                 "next_action": "逐条「受理/退回/要求补件」（人签）；受理与退回都会通知对方（不含内部备注）",
                 "note": "按包分组；量从本侧包快照的清单取；作废标记来自 quote/superseded；"
                         "受理状态来自 approval/* 的 scope=quote-review:<decision>"}, 0)


def crash_guard(fn, argv):
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        print(json.dumps({"ok": False, "refusal": {"code": "tool-crashed", "reason": f"{type(exc).__name__}: {exc}",
                                                   "next_action": "看 stderr 的堆栈修工具（只读，账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
