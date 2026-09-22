"""ctx.deviation 的 P0 实现（`04-services-catalog.md` §4 / `02-domain-model.md` §2.3）。

不变量：
- 每条偏差必须标 `kind`（technical/commercial/schedule/scope）与 `impact`（price/time/risk）；
- **未标 `impact` 的偏差不参与 TCO**（但也不被丢弃：状态为 `incomplete` 并进入排除清单）；
- 替代方案只是 Intent（建议），不自动改变已捕捉/已量化的偏差。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now

CAPTURED_EVENT = "quote/deviation-captured"
QUANTIFIED_EVENT = "quote/deviation-quantified"
KINDS = ("technical", "commercial", "schedule", "scope")
IMPACT_KEYS = ("price", "time_days", "risk")


class DeviationError(RuntimeError):
    """偏差错误。"""


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@dataclass
class DeviationService:
    realm: str
    ledger: Ledger | None = None
    events: EventBus | None = None
    actor: str = "agent:deviation"
    _deviations: dict[str, dict] = field(default_factory=dict, init=False)
    _order: list[str] = field(default_factory=list, init=False)
    _counter: int = field(default=0, init=False)

    # --- 捕捉 -------------------------------------------------------------
    def capture(self, draft: dict, package: dict) -> list[dict]:
        found: list[dict] = []
        package_items = {item["item_id"]: item for item in package.get("items", [])}

        for line in draft.get("lines", []):
            item_id = line.get("item_id")
            item = package_items.get(item_id)
            if item is None:
                if line.get("additional"):
                    found.append(self._make(
                        "scope", item_id,
                        f"报价含清单外内容（{line.get('note') or 'additional'}）",
                        refs=[f"{package['package_id']}#rev{package.get('rev')}:{item_id}"],
                        detail={"additional": True}))
                continue
            offered = set(line.get("spec_refs") or [])
            required = set(item.get("spec_refs") or [])
            if offered and offered - required:
                found.append(self._make(
                    "technical", item_id,
                    f"规格引用被替换: {sorted(offered - required)}（清单要求 {sorted(required)}）",
                    refs=[f"{package['package_id']}#rev{package.get('rev')}:{item_id}",
                          *sorted(offered - required)],
                    detail={"offered": sorted(offered), "required": sorted(required)}))

        package_terms = package.get("payment_terms") or {}
        offered_terms = draft.get("payment_terms_offered") or {}
        diffs = {key: {"required": package_terms.get(key), "offered": offered_terms.get(key)}
                 for key in set(package_terms) | set(offered_terms)
                 if package_terms.get(key) != offered_terms.get(key)}
        if diffs:
            found.append(self._make(
                "commercial", None,
                f"商务条款与包内要求不同: {sorted(diffs)}",
                refs=[f"{package['package_id']}#rev{package.get('rev')}:payment_terms"],
                detail={"diffs": diffs}))

        deadlines = package.get("deadlines") or {}
        quote_by, delivery_by = _parse(deadlines.get("quote_by")), _parse(deadlines.get("delivery_by"))
        offered_days = draft.get("lead_time_days")
        if quote_by and delivery_by and offered_days is not None:
            allowed = (delivery_by - quote_by).days
            if float(offered_days) > allowed:
                found.append(self._make(
                    "schedule", None,
                    f"报价交期 {offered_days} 天超过包内可用 {allowed} 天",
                    refs=[f"{package['package_id']}#rev{package.get('rev')}:deadlines"],
                    detail={"allowed_days": allowed, "offered_days": offered_days}))

        return found

    def _make(self, kind: str, item_id: str | None, description: str, *, refs: list[str],
              detail: dict) -> dict:
        if kind not in KINDS:
            raise DeviationError(f"偏差类别非法: {kind!r}（取值 {KINDS}）")
        self._counter += 1
        deviation_id = f"dv-{self._counter:04d}"
        record = {"deviation_id": deviation_id, "kind": kind, "item_id": item_id,
                  "description": description, "refs": refs, "detail": detail,
                  "impact": None, "status": "incomplete", "quantified_by": None,
                  "quantified_at": None, "captured_at": utc_now(), "realm": self.realm}
        self._deviations[deviation_id] = record
        self._order.append(deviation_id)
        self._append(CAPTURED_EVENT, {"deviation_id": deviation_id, "kind": kind,
                                      "item_id": item_id, "description": description,
                                      "impact": None, "refs": refs})
        if self.events is not None and self.events.mode_of(CAPTURED_EVENT) is not None:
            self.events.emit(CAPTURED_EVENT, {"deviation_id": deviation_id, "kind": kind})
        return copy.deepcopy(record)

    # --- 量化 -------------------------------------------------------------
    def impact(self, deviation_id: str, *, price: float | None = None,
               time_days: float | None = None, risk: str | None = None) -> dict:
        record = self._deviations.get(deviation_id)
        if record is None:
            raise DeviationError(f"不存在的偏差: {deviation_id}")
        missing = [name for name, value in (("price", price), ("time_days", time_days), ("risk", risk))
                   if value is None]
        if missing:
            raise DeviationError(f"影响量化必须给出全部三维 {IMPACT_KEYS}，缺少 {missing}")
        record["impact"] = {"price": float(price), "time_days": float(time_days), "risk": risk}
        record["status"] = "quantified"
        record["quantified_by"] = self.actor
        record["quantified_at"] = utc_now()
        self._append(QUANTIFIED_EVENT, {"deviation_id": deviation_id, "kind": record["kind"],
                                        "item_id": record["item_id"], "impact": record["impact"],
                                        "quantified_by": self.actor})
        return copy.deepcopy(record)

    def alternative(self, deviation_id: str) -> dict:
        record = self._deviations.get(deviation_id)
        if record is None:
            raise DeviationError(f"不存在的偏差: {deviation_id}")
        suggestions = {
            "technical": "按清单规格报价，或把差异作为技术偏差单独列价（由人工决定采纳）",
            "commercial": "按包内付款条款报价，或就偏离项发澄清后重报",
            "schedule": "调整交期或提出分批交付方案（需人工确认）",
            "scope": "把清单外内容移出本报价，或转澄清工单确认是否立变更",
        }
        return {"kind": "intent", "deviation_id": deviation_id,
                "description": suggestions[record["kind"]],
                "citations": list(record["refs"]), "applied": False}

    # --- 查询与 TCO 贡献 ---------------------------------------------------
    def deviations(self, *, kind: str | None = None) -> list[dict]:
        records = [self._deviations[key] for key in self._order]
        if kind is not None:
            records = [record for record in records if record["kind"] == kind]
        return copy.deepcopy(records)

    def explain(self, deviation_id: str) -> dict:
        record = self._deviations.get(deviation_id)
        if record is None:
            raise DeviationError(f"不存在的偏差: {deviation_id}")
        return copy.deepcopy(record)

    def tco_contribution(self, deviations: list[dict] | None = None) -> dict:
        records = self.deviations() if deviations is None else deviations
        included = [record for record in records if record.get("impact")]
        excluded = [record["deviation_id"] for record in records if not record.get("impact")]
        by_kind: dict[str, float] = {}
        for record in included:
            by_kind[record["kind"]] = by_kind.get(record["kind"], 0.0) + float(record["impact"]["price"])
        return {
            "total_price_impact": round(sum(float(r["impact"]["price"]) for r in included), 6),
            "total_time_impact_days": round(sum(float(r["impact"]["time_days"]) for r in included), 6),
            "included": [r["deviation_id"] for r in included],
            "excluded": excluded,
            "by_kind": by_kind,
            "rule": "未标 impact 的偏差不参与 TCO（02-domain-model.md §2.3），但必须可查",
        }

    def _append(self, event: str, body: dict) -> None:
        if self.ledger is None:
            return
        self.ledger.append(event, body, correlation_id=body.get("deviation_id"),
                           actor=self.actor,
                           refs={"deviation_id": body["deviation_id"]})
