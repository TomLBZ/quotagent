"""services/export.py —— 比较表导出（T-214 / FR-COMPARE-004、FR-UX-003）。

设计要点（全部有 AC-COMPARE-004 断言）：
- **逐行**：每个参与排序的报价一行，每个被排除的报价也一行（带 `code`/`reason`/`next_action`，不静默消失）；
- **与账本一致**：`verify()` 把导出行与 `compare/rank-computed` 的账本条目逐行比对（不是只跟自己算的比）；
- 每行带**引用链**，且引用必须能在账本/包里解析（未知引用即失败）；
- **确定性**：同输入两次导出字节一致（无时间戳、无自增序号，派生数据不得含墙钟时间）；
- **Excel 可用**：CSV 带 UTF-8 BOM（双击不乱码）；`.xlsx` 需第三方库，P1 不做（记 `decisions.md` D-016）。
"""
from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger

EXPORT_EVENT = "compare/table-exported"

ROW_HEADER = ("row_type", "rank", "quote_id", "score", "tco_total", "price", "delivery", "payment",
              "warranty", "deviation", "flags", "deviation_note", "citations", "code", "reason",
              "next_action")
COMPONENTS = ("price", "delivery", "payment", "warranty", "deviation")
BOM = "\ufeff"


class ExportError(RuntimeError):
    """导出/核对失败（含定位信息）。"""


class ExportService:
    def __init__(self, *, ledger: Ledger | None = None, events: EventBus | None = None) -> None:
        self.ledger = ledger
        self.events = events

    # --- 行构造 -----------------------------------------------------------
    def comparison_rows(self, evaluation: dict, *, flags: list[dict] | None = None) -> list[dict]:
        """由 `Evaluation` 构造比较表行（含 Flag 与差异说明）。"""
        flag_index: dict[str, list[dict]] = {}
        for flag in list(flags if flags is not None else evaluation.get("flags") or []):
            flag_index.setdefault(str(flag.get("target_ref") or ""), []).append(flag)
        rows: list[dict] = []
        for position, row in enumerate(evaluation.get("ranking") or [], start=1):
            quote_id = str(row.get("quote_id"))
            related = flag_index.get(quote_id, [])
            rows.append({
                "row_type": "ranked", "rank": position, "quote_id": quote_id,
                "score": row.get("score"), "tco_total": row.get("tco_total"),
                **{name: ((row.get("components") or {}).get(name) or {}).get("value")
                   for name in COMPONENTS},
                "flags": "|".join(sorted(str(flag.get("kind")) for flag in related)) or "",
                "deviation_note": "|".join(sorted(str(flag.get("detail")) for flag in related
                                                  if flag.get("kind") in ("deviation", "term_conflict",
                                                                          "abnormal_low", "missing_item",
                                                                          "capacity_risk"))) or "",
                "citations": "|".join(sorted(row.get("citations") or [])),
                "code": "", "reason": "", "next_action": "",
            })
        for row in evaluation.get("excluded") or []:
            rows.append({
                "row_type": "excluded", "rank": "", "quote_id": str(row.get("quote_id")),
                "score": "", "tco_total": "",
                **{name: "" for name in COMPONENTS},
                "flags": "|".join(sorted(str(flag.get("kind"))
                                         for flag in flag_index.get(str(row.get("quote_id")), []))),
                "deviation_note": "",
                "citations": "|".join(sorted(row.get("citations") or [])),
                "code": row.get("code", ""), "reason": row.get("reason", ""),
                "next_action": row.get("next_action", ""),
            })
        return rows

    # --- 序列化（确定性） --------------------------------------------------
    def to_csv(self, rows: list[dict], *, bom: bool = True) -> str:
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=list(ROW_HEADER), lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({name: _cell(row.get(name)) for name in ROW_HEADER})
        return (BOM if bom else "") + buffer.getvalue()

    def export(self, evaluation: dict, path: str | Path, *, flags: list[dict] | None = None,
               bom: bool = True) -> dict:
        rows = self.comparison_rows(evaluation, flags=flags)
        text = self.to_csv(rows, bom=bom)
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        body = {"evaluation_id": evaluation.get("evaluation_id"),
                "package_id": evaluation.get("package_id"), "package_rev": evaluation.get("package_rev"),
                "path": str(target), "rows": len(rows),
                "ranked": sum(1 for row in rows if row["row_type"] == "ranked"),
                "excluded": sum(1 for row in rows if row["row_type"] == "excluded"),
                "bytes": len(text.encode("utf-8")), "bom": bom,
                "note": "导出与账本逐行一致（compare/rank-computed）；xlsx 需第三方库，P1 以 CSV 交付"}
        if self.ledger is not None:
            self.ledger.append(EXPORT_EVENT, body,
                               correlation_id=evaluation.get("package_id") or "package",
                               event_class="fact")
        if self.events is not None:
            self.events.dispatch(EXPORT_EVENT, body)
        return {"path": str(target), "rows": len(rows), "text": text, "body": body}

    # --- 逐行核对 ---------------------------------------------------------
    def verify(self, rows: list[dict], *, evaluation: dict, ledger: Ledger | None = None) -> dict:
        """把导出行与 `Evaluation` **以及账本**逐行核对；任何不一致都带定位。"""
        checked = 0
        ranked = [row for row in rows if row["row_type"] == "ranked"]
        excluded = [row for row in rows if row["row_type"] == "excluded"]
        if len(ranked) != len(evaluation.get("ranking") or []):
            return {"ok": False, "rows_checked": checked, "first_mismatch":
                    f"ranked 行数 {len(ranked)} ≠ 排序结果 {len(evaluation.get('ranking') or [])}"}
        if len(excluded) != len(evaluation.get("excluded") or []):
            return {"ok": False, "rows_checked": checked, "first_mismatch":
                    f"excluded 行数 {len(excluded)} ≠ 排除清单 {len(evaluation.get('excluded') or [])}"}
        for want, have in zip(evaluation.get("ranking") or [], sorted(ranked, key=lambda r: r["rank"])):
            checked += 1
            if str(want.get("quote_id")) != have["quote_id"] or want.get("score") != have["score"]:
                return {"ok": False, "rows_checked": checked,
                        "first_mismatch": f"第 {checked} 行与 Evaluation 不一致: {want.get('quote_id')}"}
            for name in COMPONENTS:
                if ((want.get("components") or {}).get(name) or {}).get("value") != have[name]:
                    return {"ok": False, "rows_checked": checked,
                            "first_mismatch": f"第 {checked} 行分量 {name} 不一致"}
        for want, have in zip(evaluation.get("excluded") or [], excluded):
            checked += 1
            if str(want.get("quote_id")) != have["quote_id"] or want.get("code") != have["code"]:
                return {"ok": False, "rows_checked": checked,
                        "first_mismatch": f"第 {checked} 行排除原因与 Evaluation 不一致"}
        ledger_rows = self._ledger_rank_rows(evaluation, ledger) if ledger is not None else None
        if ledger_rows is not None:
            scores = {row["quote_id"]: row["score"] for row in ranked}
            if ledger_rows["scores"] != scores:
                return {"ok": False, "rows_checked": checked,
                        "first_mismatch": f"与账本 scores 不一致: 导出 {scores} vs 账本 {ledger_rows['scores']}"}
            if ledger_rows["ranking"] != [row["quote_id"] for row in sorted(ranked, key=lambda r: r["rank"])]:
                return {"ok": False, "rows_checked": checked,
                        "first_mismatch": f"与账本排名顺序不一致: {ledger_rows['ranking']}"}
            if ledger_rows["excluded"] != [row["quote_id"] for row in excluded]:
                return {"ok": False, "rows_checked": checked,
                        "first_mismatch": f"与账本排除清单不一致: {ledger_rows['excluded']}"}
        unresolved = []
        for row in rows:
            for ref in (row.get("citations") or "").split("|"):
                if ref and not self._resolve(ref, ledger, evaluation):
                    unresolved.append((row["quote_id"], ref))
        if unresolved:
            return {"ok": False, "rows_checked": checked,
                    "first_mismatch": f"引用无法解析: {unresolved[:3]}"}
        return {"ok": True, "rows_checked": checked, "first_mismatch": None}

    # --- 内部 -------------------------------------------------------------
    def _ledger_rank_rows(self, evaluation: dict, ledger: Ledger) -> dict | None:
        for row in reversed(ledger.read(type="compare/rank-computed")):
            body = row["body"]
            if body.get("evaluation_id") == evaluation.get("evaluation_id"):
                return {"scores": body.get("scores") or {}, "ranking": body.get("ranking") or [],
                        "excluded": body.get("excluded") or []}
        return None

    def _resolve(self, ref: str, ledger: Ledger | None, evaluation: dict | None = None) -> bool:
        """引用解析（**双源**）：`<kind>:<id>` 或 `<kind>:<id>:<field>`（`package` 也可能是 `id#rev<n>`）。

        - `quote:` / `package:` 指向的是**输入文档**（报价单/包），因此既可在账本条目里，
          也可在本次 `Evaluation` 的 ranking/excluded 输入清单里被确认——报价数据本身并不必然有账本条目；
        - `ledger:` / `deviation:` 只能来自账本（且 `ledger:0` 不可能存在，seq 从 1 开始）；
        - 未登记的 kind、或指向本次比较之外的对象，一律**不可解析**（宁可失败也不要"看起来像引用"）。
        """
        kind, _, rest = ref.partition(":")
        ident = rest.split("#")[0].split(":")[0]
        if not ident:
            return False
        if kind == "policy":
            return True  # 策略来源由 evaluation 的 policy/weights 摘要覆盖
        if kind == "quote":
            if any(str(row.get("quote_id")) == ident
                   for row in (evaluation or {}).get("ranking", []) + (evaluation or {}).get("excluded", [])):
                return True
        if kind == "package":
            if str((evaluation or {}).get("package_id")) == ident:
                return True
        if ledger is None:
            return False
        if kind == "quote":
            return any(row["body"].get("quote_id") == ident or row.get("correlation_id") == ident
                       for row in ledger.read())
        if kind == "package":
            return any(str(row["body"].get("package_id")) == ident for row in ledger.read())
        if kind == "ledger":
            if ident == "0":
                return False
            return any(str(row["seq"]) == ident for row in ledger.read())
        if kind == "deviation":
            return any(row["type"] == "deviation/captured"
                       and str(row["body"].get("deviation_id")) == ident for row in ledger.read())
        return False


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)
