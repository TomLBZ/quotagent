#!/usr/bin/env python3
"""tools/compare-rank.py —— 「承包商在 APP 里看回应与比价」的**服务端一半**（**只读**：账本零新增）。

它做三件事，全部复用既有的真实现，不另起一套口径：

  ① 从**承包商自己的账本**读出已送达本侧的报价事实（`quote/submitted` 行：`quote_id` / `package_id` /
     `item_id` / `unit_price_cents` / `lead_time_days` / `currency`）——私域键与读数都在本侧账本内；
  ② 从**承包商侧自己的包快照**（由唯一写者 `src/domain/rfq/tools/rfq-publish.py` 落在
     `<ui-shared>/contractor/rfq-<pkg>-rev<N>.json`）取回包版本与行项目数量 —— 包的**版本以快照哈希锚定**；
  ③ 调 `src/domain/compare/code/compare.py` 的 `CompareService.rank(package, quotes, weights=…)`
     （**权重可调**：`--weights price=0.6,delivery=0.15,…`；分量与引用链由服务产出，**贡献可解释**：
     每一行都带 `components.{price,delivery,payment,warranty,deviation}` 与 `citations`）。

**只读**：`CompareService(ledger=None)` ⇒ 它自己的 `_append` 是 no-op，账本零新增、不取墙钟、不联网。

用法：
  python3 src/domain/compare/tools/compare-rank.py --ui-shared tmp/ui-shared \\
      --ledger-contractor …/contractor/ledger.jsonl --package-id pkg-gui \\
      --weights price=0.6,delivery=0.15,payment=0.1,warranty=0.05,deviation=0.1
stdout 恰一行 JSON：`{ok, package_id, rev, weights, ranking:[…], excluded, counts, citations, …}`。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.services.compare import (  # noqa: E402
    COMPONENTS, DEFAULT_WEIGHTS, CompareService, _minmax,
)

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def rows_of(path: Path) -> tuple[list[dict] | None, str | None]:
    if not path.exists():
        return [], None
    out: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            return None, f"{path}:{lineno} 不是合法 JSON：{exc}"
        if not isinstance(record, dict):
            return None, f"{path}:{lineno} 不是对象"
        out.append(record)
    return out, None


def body_of(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def weights_of(text: str) -> tuple[dict | None, str | None]:
    """`price=0.6,delivery=0.15` → `{price:0.6, …}`；不认识的键 / 不是有限数一律**拒**（不静默忽略）。"""
    if not text.strip():
        return dict(DEFAULT_WEIGHTS), None
    out: dict[str, float] = {}
    for chunk in text.split(","):
        piece = chunk.strip()
        if piece == "":
            continue
        if "=" not in piece:
            return None, f"权重片段没有 `=`：{piece!r}（形如 price=0.6）"
        key, value = (part.strip() for part in piece.split("=", 1))
        if key not in COMPONENTS:
            return None, f"不认识的分量：{key!r}（可用 {list(COMPONENTS)}）"
        try:
            number = float(value)
        except ValueError:
            return None, f"{key} 的权重不是数：{value!r}"
        if number != number or number in (float("inf"), float("-inf")):
            return None, f"{key} 的权重不是有限数：{value!r}"
        if number < 0 or number > 1:
            return None, f"{key} 的权重必须在 [0,1]：{number}"
        out[key] = number
    for name in COMPONENTS:
        out.setdefault(name, 0.0)
    return out, None


def package_of(snapshot_dir: Path, package_id: str) -> tuple[dict | None, str | None, str]:
    """从承包商侧自己的包快照取回版本与行项目数（**包体不进 `rfq/published`**，见 `rfq-publish.py`）。"""
    candidates = sorted(snapshot_dir.glob(f"rfq-{package_id}-rev*.json")) if snapshot_dir.exists() else []
    if not candidates:
        return None, f"没有 {package_id} 的包快照（先发布一次：APP 的「发布 RFQ」）", ""
    latest = candidates[-1]
    try:
        snapshot = json.loads(latest.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, f"包快照不可解析：{latest}（{exc}）", str(latest)
    spec = snapshot.get("spec") if isinstance(snapshot.get("spec"), dict) else {}
    items = spec.get("items") if isinstance(spec.get("items"), list) else []
    package = {"package_id": package_id, "rev": int(snapshot.get("rev") or 0),
               "currency": snapshot.get("currency") or spec.get("currency") or "CNY",
               "deadlines": snapshot.get("deadlines") or spec.get("deadlines") or {},
               "payment_terms": spec.get("payment_terms") or {},
               "warranty_months": spec.get("warranty_months"),
               "items": items, "snapshot_hash": snapshot.get("snapshot_hash")}
    return package, None, str(latest)


def per_item_matrix(package: dict, prepared: list[dict], weights: dict) -> dict:
    """比较矩阵 + **同一行项目内**才互相比较（per-item 归一）的贡献分解（DEF-012）。

    口径（与 `compare.py` 的 `_minmax` **同一个函数**，只是分母换成**本行项目内**的极差）：

      · 单元格：`unit_price_cents` / `line_total_cents`（量×单价）/ `delta_pct_vs_item_min`
        （相对**本行项目最低价**的百分比差 —— 只有同一行项目内的价才互相比较）；
      · `normalized`：`_minmax(价, 本行最低, 本行最高)` ∈ [0,1]，0 = 本行最便宜；
      · `contribution`：`w_price × normalized × share`（share = 该行金额 / 该家报价总额）——
        即"这一行在它这家的价格分里贡献了多少惩罚"，逐行给、可解释；
      · 全局名次仍以 `CompareService.rank` 为准（跨报价 minmax 的 TCO 口径），两者**不混算**、
        矩阵页脚如实写明这个差别。
    """
    totals = {str(quote.get("quote_id")): float(quote.get("total_amount") or 0.0) for quote in prepared}
    prices: dict[str, dict[str, float]] = {}
    qtys: dict[str, float] = {}
    for quote in prepared:
        for line in quote.get("lines") or []:
            item_id = str(line.get("item_id") or "")
            if not item_id:
                continue
            prices.setdefault(item_id, {})[str(quote.get("quote_id"))] = float(line.get("unit_price") or 0.0)
            if line.get("qty") is not None:
                qtys[item_id] = float(line.get("qty") or 0.0)
    w_price = float(weights.get("price") or 0.0)
    items: list[dict] = []
    summary: dict[str, float] = {str(quote.get("quote_id")): 0.0 for quote in prepared}
    cheapest_wins = 0
    for item_id in sorted(prices):
        cells = prices[item_id]
        values = [value for value in cells.values() if value is not None]
        low, high = (min(values), max(values)) if values else (0.0, 0.0)
        qty = float(qtys.get(item_id) or 0.0)
        row_cells = []
        for quote in prepared:
            quote_id = str(quote.get("quote_id"))
            price = cells.get(quote_id)
            if price is None:
                row_cells.append({"quote_id": quote_id, "supplier": quote.get("supplier", ""),
                                  "missing": True, "reason": "这条报价没有报这一行项目",
                                  "next_action": "要就这一行比价，先让对方补报这一行"})
                continue
            normalized = _minmax(price, low, high)
            line_total = round(qty * price, 6)
            share = (line_total / totals[quote_id]) if totals.get(quote_id) else 0.0
            contribution = round(w_price * normalized * share, 9)
            summary[quote_id] = round(summary.get(quote_id, 0.0) + contribution, 9)
            row_cells.append({"quote_id": quote_id, "supplier": quote.get("supplier", ""),
                              "unit_price_cents": round(price * 100, 6),
                              "unit_price": price, "line_total_cents": round(line_total * 100, 6),
                              "delta_pct_vs_item_min": round((price / low - 1.0) * 100, 3) if low else 0.0,
                              "normalized": round(normalized, 9), "contribution": contribution,
                              "is_item_min": price == low, "missing": False})
        items.append({"item_id": item_id, "qty": qty, "min_unit_price_cents": round(low * 100, 6),
                      "max_unit_price_cents": round(high * 100, 6),
                      "spread_pct": round((high / low - 1.0) * 100, 3) if low else 0.0,
                      "cells": row_cells})
        cheapest_wins += sum(1 for cell in row_cells if cell.get("is_item_min"))
    return {"kind": "per-item", "items": items,
            "quote_summary": [{"quote_id": quote_id, "supplier": next((quote.get("supplier", "") for quote in prepared
                                                                       if str(quote.get("quote_id")) == quote_id), ""),
                               "matrix_price_contribution": round(summary.get(quote_id, 0.0), 9),
                               "total_amount": totals.get(quote_id)}
                              for quote_id in sorted(summary)],
            "counts": {"items": len(items), "quotes": len(prepared), "item_min_cells": cheapest_wins},
            "note": "单元格只在**同一行项目内**比较（per-item 归一：本行最低价/最高价做极差）；"
                    "全局名次与五分量贡献仍以 CompareService.rank 的跨报价 minmax 为准，两者不混算"}


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="比价排序（权重可调、贡献可解释；只读、账本零新增）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--package-id", default="")
    parser.add_argument("--weights", default="", help="price=0.6,delivery=0.15,payment=0.1,warranty=0.05,deviation=0.1")
    parser.add_argument("--view", default="contractor")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return emit({"ok": False, "refusal": refusal("usage-unknown-flag", str(unknown), "去掉不认识的参数")}, 2)
    ui_shared = Path(args.ui_shared)
    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = rows_of(ledger_path)
    if error is not None or rows is None:
        return emit({"ok": False, "refusal": refusal("ledger-unreadable", str(error),
                                                     "先修账本（本脚本只读）")}, 2)
    weights, bad = weights_of(args.weights)
    if weights is None:
        return emit({"ok": False, "refusal": refusal("weights-invalid", str(bad),
                                                     f"分量只有 {list(COMPONENTS)}，权重取 [0,1] 内的数")}, 2)

    # 已送达本侧的报价事实（按 package_id + quote_id 归组；同一报价的行会分在多条账本行上）
    quotes: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "quote/submitted":
            continue
        body = body_of(row)
        package_id = str(body.get("package_id") or "").strip()
        if args.package_id and package_id != args.package_id:
            continue
        quote_id = str(body.get("quote_id") or "").strip()
        if not quote_id:
            continue
        entry = quotes.setdefault(quote_id, {"quote_id": quote_id, "package_id": package_id,
                                             "currency": str(body.get("currency") or "CNY"),
                                             "lead_time_days": body.get("lead_time_days"),
                                             "supplier": str(body.get("supplier") or ""),
                                             "items": {}})
        item_id = str(body.get("item_id") or "").strip()
        cents = body.get("unit_price_cents")
        if item_id and isinstance(cents, (int, float)):
            entry["items"][item_id] = float(cents)
    if not quotes:
        return emit({"ok": True, "view": args.view, "package_id": args.package_id or None,
                     "weights": weights, "ranking": [], "excluded": [], "citations": [],
                     "counts": {"quotes": 0, "items": 0},
                     "degraded": True, "reason": "no-submitted-quotes",
                     "next_action": "等供应商在 APP 里「提交报价」（人签）后本侧账本才会有报价事实",
                     "note": "本侧账本里还没有已送达的报价：不编候选、不排名"}, 0)
    package_ids = sorted({entry["package_id"] for entry in quotes.values() if entry["package_id"]})
    if args.package_id:
        package_ids = [args.package_id]
    if not package_ids:
        return emit({"ok": True, "view": args.view, "weights": weights, "ranking": [], "excluded": [],
                     "citations": [], "counts": {"quotes": len(quotes), "items": 0},
                     "degraded": True, "reason": "quote-without-package",
                     "next_action": "报价事实里没有 package_id：先发布 RFQ 再让对方报价",
                     "note": "报价事实归不到包：不排名"}, 0)

    results = []
    for package_id in package_ids:
        if not ID_RE.match(package_id):
            results.append({"package_id": package_id, "degraded": True, "reason": "package-id-malformed",
                            "ranking": [], "excluded": [], "citations": []})
            continue
        package, why, snapshot_file = package_of(ui_shared / "contractor", package_id)
        if package is None:
            results.append({"package_id": package_id, "degraded": True, "reason": "package-snapshot-missing",
                            "next_action": why, "ranking": [], "excluded": [], "citations": []})
            continue
        rev = int(package["rev"])
        qty_of = {str(item.get("item_id")): item.get("qty") for item in package["items"]}
        prepared = []
        for entry in quotes.values():
            if entry["package_id"] != package_id:
                continue
            lines = []
            total = 0.0
            for item_id, cents in sorted(entry["items"].items()):
                qty = qty_of.get(item_id)
                qty = float(qty) if isinstance(qty, (int, float)) else 1.0
                unit_price = round(cents / 100.0, 6)
                lines.append({"item_id": item_id, "qty": qty, "unit_price": unit_price})
                total += qty * unit_price
            prepared.append({"quote_id": entry["quote_id"], "rfq_rev": rev, "currency": entry["currency"],
                             "lines": lines, "total_amount": round(total, 6),
                             "lead_time_days": entry["lead_time_days"],
                             "payment_terms_offered": {"days": 45, "advance_pct": 0},
                             "warranty_months": 24, "supplier": entry["supplier"]})
        if not prepared:
            results.append({"package_id": package_id, "rev": rev, "degraded": True,
                            "reason": "no-quotes-for-package", "ranking": [], "excluded": [],
                            "citations": [], "snapshot": snapshot_file})
            continue
        service = CompareService(ledger=None, events=None)   # **只读**：不落 `compare/*`、不取墙钟
        try:
            evaluation = service.rank(package, prepared, weights=weights)
        except Exception as exc:  # noqa: BLE001 —— 服务的门就是门：拒就如实报（不兜底排名）
            results.append({"package_id": package_id, "rev": rev, "degraded": True, "reason": "rank-refused",
                            "detail": f"{type(exc).__name__}: {exc}", "ranking": [], "excluded": [],
                            "citations": [], "snapshot": snapshot_file})
            continue
        ranking = []
        for position, row in enumerate(evaluation["ranking"], start=1):
            entry = next((item for item in prepared if item["quote_id"] == row["quote_id"]), {})
            ranking.append({"rank": position, "quote_id": row["quote_id"], "score": row["score"],
                            "tco_total": row["tco_total"], "supplier": entry.get("supplier", ""),
                            "lead_time_days": entry.get("lead_time_days"),
                            "total_amount": entry.get("total_amount"),
                            "components": {name: {"value": row["components"][name]["value"],
                                                  "raw": row["components"][name].get("raw", {}),
                                                  "citations": row["components"][name]["citations"]}
                                           for name in COMPONENTS if name in row["components"]},
                            "citations": row["citations"]})
        results.append({"package_id": package_id, "rev": rev, "evaluation_id": evaluation["evaluation_id"],
                        "weights": evaluation["weights"], "policy": evaluation["policy"],
                        "ranking": ranking, "excluded": evaluation["excluded"],
                        "citations": evaluation["citations"], "snapshot": snapshot_file,
                        "matrix": per_item_matrix(package, prepared, evaluation["weights"]),
                        "prepared": len(prepared),
                        "degraded": False})
    primary = results[0] if results else {}
    return emit({"ok": True, "view": args.view, "service": "compare",
                 "source": "compare-rank.py（只读：CompareService(ledger=None)；权重可调、贡献可解释）",
                 "weights": weights, "components": list(COMPONENTS),
                 "critical_components": ["price", "delivery"],
                 "package_id": args.package_id or (primary.get("package_id") or None),
                 "rev": primary.get("rev"), "ranking": primary.get("ranking", []),
                 "excluded": primary.get("excluded", []), "citations": primary.get("citations", []),
                 "evaluation_id": primary.get("evaluation_id"),
                 "matrix": primary.get("matrix"),
                 "packages": results, "counts": {"packages": len(results),
                                                 "quotes": len(quotes),
                                                 "ranked": len(primary.get("ranking", []))},
                 "degraded": bool(primary.get("degraded", False)),
                 "reason": primary.get("reason"),
                 "next_action": primary.get("next_action") or
                     "在 APP 的比价面板里调权重（`w_price` 等）后重算：名次与贡献点会跟着变",
                 "note": "只读复算：不改账本、不落文件、不取墙钟；分量与引用链来自 "
                         "src/domain/compare/code/compare.py（同一实现，同权重同名次）"}, 0)




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
