"""ctx.compare 的 P0 实现（`04-services-catalog.md` §5 / `02-domain-model.md` §2.4）。

职责：归一化报价 → **TCO 折算**（价格 / 交期 / 付款条件 / 质保 / 偏差）→ **排序建议** → **引用链**。

不变量（AC-COMPARE-001..003）：
- 报价的 `rfq_rev` 与包版本不一致 → **不进入排序**，并产生 `rfq/version-mismatch`；
- 同输入同输出（可重放）：排序只依赖传入的 `weights`/`policy`，不含时间与随机数；
- `Evaluation` 中**每个数值都必须有 `citations`**，删掉任一引用即校验失败（无引用即无效）。

TCO 折算的口径（手算可复现，写入 ADR-0011）：
    delivery = max(0, lead_time - 允许交期) × policy.time_cost_per_day
    payment  = 金额 × (1 - 预付比例) × 净账期/365 × policy.capital_rate
    warranty = max(0, 要求质保 - 报价质保) × policy.warranty_cost_per_month
    deviation = Σ 已量化偏差的价格影响（未量化的偏差不进 TCO，只在 excluded 里可查）
    tco_total = price + delivery + payment + warranty + deviation
排序分数 = Σ w_i × minmax_i（分量在本次报价集上的极差归一），越低越好；同分按 quote_id 定序。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..kernel.canon import digest
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now

RANK_EVENT = "compare/rank-computed"
FLAG_EVENT = "compare/flag-raised"
MISMATCH_EVENT = "rfq/version-mismatch"
COMPONENTS = ("price", "delivery", "payment", "warranty", "deviation")
DEFAULT_WEIGHTS = {"price": 0.6, "delivery": 0.15, "payment": 0.1, "warranty": 0.05, "deviation": 0.1}
DEFAULT_POLICY = {"time_cost_per_day": 800.0, "capital_rate": 0.08, "warranty_cost_per_month": 2000.0}
CITE_PREFIXES = ("ledger", "package", "quote", "policy", "deviation")


class CompareError(RuntimeError):
    """比价错误。"""


class VersionMismatch(CompareError):
    """报价与包版本不一致。"""


class MissingCitation(CompareError):
    """数值缺少引用链 —— Evaluation 中无引用即无效。"""


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@dataclass
class CompareService:
    ledger: Ledger | None = None
    events: EventBus | None = None
    actor: str = "agent:compare"
    _counter: int = field(default=0, init=False)

    # --- 排序 -------------------------------------------------------------
    def rank(self, package: dict, quotes: list[dict], *, weights: dict | None = None,
             policy: dict | None = None, flags: list[dict] | None = None,
             book=None) -> dict:
        if self.ledger is not None:
            self.ledger.assert_healthy()
        weights = dict(DEFAULT_WEIGHTS if weights is None else weights)
        policy = dict(DEFAULT_POLICY if policy is None else policy)

        included, excluded = [], []
        # 过期报价（包升版后被标记）先由台账显式摘出：以 quote_superseded 列在 excluded 里，
        # 而不是"因为没有 rev 匹配所以消失在排名里"（可审计，T-205 / FR-RFQ-006）。
        if book is not None:
            quotes, superseded_rows = book.exclude_superseded(quotes)
            excluded.extend(superseded_rows)
        for quote in sorted(quotes, key=lambda item: item["quote_id"]):
            if quote.get("rfq_rev") != package.get("rev"):
                excluded.append({
                    "quote_id": quote["quote_id"], "code": "rfq_version_mismatch",
                    "quote_rev": quote.get("rfq_rev"), "package_rev": package.get("rev"),
                    "reason": f"报价基于 rev{quote.get('rfq_rev')}，包当前 rev{package.get('rev')}",
                    "next_action": f"请对方基于 rev{package.get('rev')} 重报，或把包回退到 "
                                   f"rev{quote.get('rfq_rev')}（不得静默比较）",
                    # 排除也要有据可查：报价本体 + 包版本字段（外发比较表由此可逐行复核）
                    "citations": sorted({f"quote:{quote['quote_id']}",
                                         f"package:{package.get('package_id')}#rev{package.get('rev')}:version"}),
                })
                self._append(MISMATCH_EVENT, {
                    "quote_id": quote["quote_id"], "quote_rev": quote.get("rfq_rev"),
                    "package_rev": package.get("rev"), "package_id": package.get("package_id"),
                    "action": "suspend_quote",
                }, correlation_id=package.get("package_id", "package"), event_class="fact")
                continue
            included.append(quote)
        if not included:
            raise VersionMismatch("没有任何报价与当前包版本一致，无法排序（已产生 rfq/version-mismatch）")

        breakdowns = [self.tco(quote, package=package, policy=policy) for quote in included]
        basis = {name: [row["components"][name]["value"] for row in breakdowns] for name in COMPONENTS}
        ranking = []
        for row in breakdowns:
            score = 100.0 * sum(
                weights.get(name, 0.0) * _minmax(row["components"][name]["value"],
                                                 min(basis[name]), max(basis[name]))
                for name in COMPONENTS)
            ranking.append({
                "quote_id": row["quote_id"], "score": round(score, 9), "tco_total": row["tco_total"],
                "components": row["components"], "status": "ranked",
                "citations": sorted(set(row["citations"]) | {f"policy:weights.{name}" for name in COMPONENTS}),
            })
        ranking.sort(key=lambda item: (item["score"], item["quote_id"]))

        evaluation = {
            "evaluation_id": _content_id(package, weights, policy, ranking),
            "package_id": package.get("package_id"), "package_rev": package.get("rev"),
            "currency": package.get("currency", "CNY"),
            "weights": weights, "policy": policy,
            "ranking": ranking, "excluded": excluded,
            "flags": list(flags or []),
            "citations": sorted({f"package:{package.get('package_id')}#rev{package.get('rev')}:items",
                                 f"policy:weights.*", f"policy:policy.*"}),
        }
        self.verify_citations(evaluation)
        self._append(RANK_EVENT, {
            "evaluation_id": evaluation["evaluation_id"], "package_id": evaluation["package_id"],
            "package_rev": evaluation["package_rev"],
            "ranking": [row["quote_id"] for row in ranking],
            "scores": {row["quote_id"]: row["score"] for row in ranking},
            "excluded": [row["quote_id"] for row in excluded],
            "flag_count": len(evaluation["flags"]),
            "citations": evaluation["citations"],
        }, correlation_id=evaluation["package_id"] or "package", event_class="intent")
        return evaluation

    # --- TCO --------------------------------------------------------------
    def tco(self, quote: dict, *, package: dict, policy: dict | None = None) -> dict:
        policy = dict(DEFAULT_POLICY if policy is None else policy)
        quote_ref = f"quote:{quote['quote_id']}"
        package_ref = f"package:{package.get('package_id')}#rev{package.get('rev')}"
        deadlines = package.get("deadlines") or {}
        quote_by, delivery_by = _parse(deadlines.get("quote_by")), _parse(deadlines.get("delivery_by"))
        allowed_days = (delivery_by - quote_by).days if (quote_by and delivery_by) else None

        price = float(quote.get("total_amount") or 0.0)
        # 账本引用只在**确实存在**该条目时给出：`ledger:0` 是指向不存在条目的悬空引用
        # （seq 从 1 开始），会骗过"有没有引用"的粗检（AC-COMPARE-004 的严格解析抓到）。
        ledger_seq = (self._last_seq("quote/normalized") or self._last_seq("quote/submitted")
                      or self._last_seq("quote/revised"))
        price_cites = [f"{quote_ref}:total_amount", f"{package_ref}:items"]
        if ledger_seq:
            price_cites.append(f"ledger:{ledger_seq}")

        over_days = max(0, float(quote.get("lead_time_days") or 0) - (allowed_days or 0))
        delivery = over_days * float(policy["time_cost_per_day"])

        terms = quote.get("payment_terms_offered") or {}
        advance = float(terms.get("advance_pct") or 0.0)
        net_days = float(terms.get("days") or 0.0)
        payment = price * (1 - advance / 100.0) * net_days / 365.0 * float(policy["capital_rate"])

        required_warranty = float(package.get("warranty_months") or 0.0)
        missing_months = max(0.0, required_warranty - float(quote.get("warranty_months") or 0.0))
        warranty = missing_months * float(policy["warranty_cost_per_month"])

        deviations = self._deviation_impacts(quote)
        deviation = sum(item["price"] for item in deviations)

        components = {
            "price": {"value": price, "raw": {"total_amount": price, "currency": quote.get("currency")},
                      "citations": sorted(set(price_cites))},
            "delivery": {"value": delivery,
                         "raw": {"lead_time_days": quote.get("lead_time_days"),
                                 "allowed_days": allowed_days, "over_days": over_days},
                         "citations": sorted({f"{quote_ref}:lead_time_days", f"{package_ref}:deadlines",
                                              "policy:time_cost_per_day"})},
            "payment": {"value": payment,
                        "raw": {"advance_pct": advance, "days": net_days},
                        "citations": sorted({f"{quote_ref}:payment_terms_offered",
                                             f"{package_ref}:payment_terms", "policy:capital_rate"})},
            "warranty": {"value": warranty,
                         "raw": {"offered_months": quote.get("warranty_months"),
                                 "required_months": required_warranty, "missing_months": missing_months},
                         "citations": sorted({f"{quote_ref}:warranty_months", f"{package_ref}:warranty_months",
                                              "policy:warranty_cost_per_month"})},
            "deviation": {"value": deviation,
                          "raw": {"quantified": [item["deviation_id"] for item in deviations]},
                          "citations": sorted({f"deviation:{item['deviation_id']}" for item in deviations}
                                              or {f"{quote_ref}:deviation_ids"})},
        }
        total = price + delivery + payment + warranty + deviation
        citations = sorted({ref for comp in components.values() for ref in comp["citations"]})
        return {"quote_id": quote["quote_id"], "components": components, "tco_total": total,
                "citations": citations, "policy": policy}

    # --- 引用链 -----------------------------------------------------------
    def numbers(self, evaluation: dict) -> list[str]:
        """所有"必须有引用"的数值路径（分量值、TCO 合计、排序分数）。"""
        paths = []
        for index, row in enumerate(evaluation.get("ranking", [])):
            paths.append(f"ranking[{index}].score")
            paths.append(f"ranking[{index}].tco_total")
            for name in COMPONENTS:
                if name in row.get("components", {}):
                    paths.append(f"ranking[{index}].components.{name}")
        return paths

    def cite(self, evaluation: dict) -> list[str]:
        refs: set[str] = set()
        for row in evaluation.get("ranking", []):
            refs.update(row.get("citations", []))
            for comp in row.get("components", {}).values():
                refs.update(comp.get("citations", []))
        refs.update(evaluation.get("citations", []))
        return sorted(refs)

    def verify_citations(self, evaluation: dict) -> None:
        for row in evaluation.get("ranking", []):
            if not row.get("citations"):
                raise MissingCitation(
                    f"ranking[{row.get('quote_id')}] 缺少引用链：排序建议本身必须可追溯（FR-COMPARE-003）")
            for name, comp in row.get("components", {}).items():
                if not comp.get("citations"):
                    raise MissingCitation(
                        f"ranking[{evaluation['ranking'].index(row)}].components.{name} "
                        f"(quote_id={row.get('quote_id')}) 缺少引用链：无引用即无效（FR-COMPARE-003）")
            for ref in row.get("citations", []):
                self._check_prefix(ref)
            for comp in row.get("components", {}).values():
                for ref in comp.get("citations", []):
                    self._check_prefix(ref)
        for ref in evaluation.get("citations", []):
            self._check_prefix(ref)

    def _check_prefix(self, ref: str) -> None:
        if ref.split(":", 1)[0] not in CITE_PREFIXES:
            raise MissingCitation(f"引用来源不可识别: {ref!r}（允许 {CITE_PREFIXES}）")

    # --- 复算 -------------------------------------------------------------
    def recompute(self, evaluation: dict, *, weights: dict) -> dict:
        """用已存的分量数值 + 新权重复算分数（策略 patch 可复算，不必重跑归一化）。"""
        rows = evaluation.get("ranking", [])
        if not rows:
            raise CompareError("Evaluation 里没有可复算的报价")
        basis = {name: [row["components"][name]["value"] for row in rows] for name in COMPONENTS}
        scores = {}
        for row in rows:
            scores[row["quote_id"]] = round(100.0 * sum(
                weights.get(name, 0.0) * _minmax(row["components"][name]["value"],
                                                 min(basis[name]), max(basis[name]))
                for name in COMPONENTS), 9)
        return {"scores": scores,
                "ranking": [qid for qid, _ in sorted(scores.items(), key=lambda kv: (kv[1], kv[0]))]}

    # --- 内部 -------------------------------------------------------------
    def _deviation_impacts(self, quote: dict) -> list[dict]:
        impacts = []
        for deviation in quote.get("deviations") or []:
            if deviation.get("impact"):
                impacts.append({"deviation_id": deviation["deviation_id"],
                                "price": float(deviation["impact"]["price"])})
        return impacts

    def _last_seq(self, event: str) -> int | None:
        if self.ledger is None:
            return None
        entries = self.ledger.read(type=event)
        return entries[-1]["seq"] if entries else None

    def _append(self, event: str, body: dict, *, correlation_id: str, event_class: str) -> None:
        if self.ledger is None:
            return
        self.ledger.append(event, body, correlation_id=correlation_id, event_class=event_class,
                           actor=self.actor, refs={"package_id": correlation_id})
        if self.events is not None and self.events.mode_of(event) not in (None, "waterfall"):
            self.events.dispatch(event, body)


def _minmax(value: float, low: float, high: float) -> float:
    """极差归一：全等时记 0（确定性，不引入除零）。"""
    if high <= low:
        return 0.0
    return (float(value) - float(low)) / (float(high) - float(low))


def _content_id(package: dict, weights: dict, policy: dict, ranking: list[dict]) -> str:
    """内容寻址：Evaluation 是可重建的派生数据，不含墙钟时间与自增序号，
    所以同输入两次排序能得到**字节级一致**的结果（FR-COMPARE-002 / 09 §1 投影原则）。"""
    payload = json.dumps({
        "package_id": package.get("package_id"), "package_rev": package.get("rev"),
        "weights": weights, "policy": policy,
        "ranking": [(row["quote_id"], row["score"], row["tco_total"]) for row in ranking],
    }, ensure_ascii=False, sort_keys=True)
    return "eval:" + digest(payload)[:12]
