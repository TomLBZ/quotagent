"""ctx.pricing 的 P0 实现（`04-services-catalog.md` §4）——定价建议 + 人工门。

定价流水线（waterfall，`05-events.md` §3 的 `quote/price-drafted`）：
**成本基线 → 市场参考 → 策略加价 → 风险准备金 → 授权区间检查**。

不变量：
- 产出是 `PriceProposal`（**Intent**），不是报价（`06-agents-and-prompts.md` 角色矩阵）；
- **越界（超出授权区间）无条件请求批准**，状态为 `awaiting_approval`，不得直接产出可提交价格；
- **最终数字必须由人确认**（`confirm` 只接受 `human:*`），未确认的定价不得进入提交路径。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now
from .approval import AgentCannotApprove
from .costmodel import CostModelService

PRICE_PIPELINE = "quote/price-drafted"
PIPELINE_REASON = "越界定价必须在流水线内转人工门，不得直接产出可提交价格（05-events.md §5 / 规则 3）"
PRICE_PROPOSED_EVENT = "quote/price-proposed"
HUMAN_APPROVED_EVENT = "quote/human-approved"
OUT_OF_BAND_SCOPE = "quote.price-out-of-band"
STAGE_NAMES = ("cost_baseline", "market_reference", "strategy_markup", "risk_reserve", "band_check")


class PriceError(RuntimeError):
    """定价错误。"""


class PriceNotConfirmed(RuntimeError):
    """定价结果尚未获得人确认，不得进入提交路径（FR-PRICE-002）。"""


@dataclass
class PricingService:
    cost_service: CostModelService
    policy: dict
    ledger: Ledger | None = None
    events: EventBus | None = None
    approval: Any = None
    actor: str = "agent:price"
    _proposals: dict[str, dict] = field(default_factory=dict, init=False)
    _order: list[str] = field(default_factory=list, init=False)
    _counter: int = field(default=0, init=False)
    _attached: bool = field(default=False, init=False)

    # --- 装配 -------------------------------------------------------------
    def set_policy(self, policy: dict) -> None:
        self.policy = dict(policy)

    def build_cost(self, items: list[dict], *, quote_id: str) -> dict:
        return self.cost_service.build(items, quote_id=quote_id)

    def attach(self, ctx) -> None:
        self._register_stages(lambda name, fn: ctx.on(name, fn, label=f"pricing:{fn.__name__}"))

    def _register_stages(self, register: Callable[[str, Callable], Any]) -> None:
        for stage in (self._stage_cost_baseline, self._stage_market_reference,
                      self._stage_strategy_markup, self._stage_risk_reserve, self._stage_band_check):
            register(PRICE_PIPELINE, stage)
        self._attached = True

    def attach_defaults(self) -> None:
        if self.events is None:
            raise PriceError("没有事件总线，无法装配定价流水线")
        if self.events.mode_of(PRICE_PIPELINE) is None:
            self.events.declare(PRICE_PIPELINE, "waterfall", reason=PIPELINE_REASON)
        self._register_stages(lambda name, fn: self.events.on(name, fn, label=f"pricing:{fn.__name__}"))

    # --- 定价 -------------------------------------------------------------
    def price(self, *, quote_id: str, item_id: str | None = None) -> dict:
        if self.ledger is not None:
            self.ledger.assert_healthy()
        if self.events is None:
            raise PriceError("定价需要事件总线（流水线即 waterfall）")
        if not self._attached:
            self.attach_defaults()
        model = self.cost_service.as_dict()
        item_ids = sorted(model["items"])
        target = item_id or (item_ids[0] if len(item_ids) == 1 else None)
        if target is None:
            raise PriceError(f"必须指定 item_id（成本构成含多个条目: {item_ids}）")
        work = {"quote_id": quote_id, "item_id": target, "qty": model["items"][target]["qty"],
                "policy": dict(self.policy), "stages": []}
        resolved = self.events.waterfall(PRICE_PIPELINE, work)
        if isinstance(resolved, dict) and resolved.get("vetoed"):
            raise PriceError(f"定价被护栏否决: {resolved.get('reason')}")

        self._counter += 1
        proposal_id = f"pp-{self._counter:04d}"
        proposal = {
            "proposal_id": proposal_id,
            "quote_id": quote_id,
            "item_id": target,
            "qty": resolved["qty"],
            "currency": model.get("currency", "CNY"),
            "cost_baseline": resolved["cost_baseline"],
            "market_reference": resolved.get("market_reference"),
            "markup_pct": resolved["markup_pct"],
            "markup_amount": resolved["markup_amount"],
            "risk_reserve_pct": resolved["risk_reserve_pct"],
            "risk_reserve_amount": resolved["risk_reserve_amount"],
            "proposed_price": resolved["proposed_price"],
            "total_amount": resolved["proposed_price"] * resolved["qty"],
            "band": resolved["band"],
            "in_band": resolved["in_band"],
            "status": resolved["status"],
            "approval_id": resolved.get("approval_id"),
            "stages": resolved["stages"],
            "final_price": None,
            "confirmed_by": None,
            "confirmed_at": None,
            "created_at": utc_now(),
            "citations": [f"cost-model:{model['artifact_hash']}",
                          f"policy:markup={resolved['markup_pct']}"],
        }
        self._proposals[proposal_id] = proposal
        self._order.append(proposal_id)
        if self.ledger is not None:
            self.ledger.append(
                PRICE_PROPOSED_EVENT,
                {"proposal_id": proposal_id, "quote_id": quote_id, "item_id": target,
                 "cost_baseline": proposal["cost_baseline"], "proposed_price": proposal["proposed_price"],
                 "in_band": proposal["in_band"], "status": proposal["status"],
                 "approval_id": proposal["approval_id"], "stages": [s["stage"] for s in proposal["stages"]],
                 "citations": proposal["citations"]},
                correlation_id=quote_id, event_class="intent", actor=self.actor,
                refs={"quote_id": quote_id, "item_id": target})
        if self.events is not None and self.events.mode_of(PRICE_PROPOSED_EVENT) is not None:
            self.events.emit(PRICE_PROPOSED_EVENT, {"proposal_id": proposal_id,
                                                    "status": proposal["status"],
                                                    "in_band": proposal["in_band"]})
        return dict(proposal)

    # --- 人确认 -----------------------------------------------------------
    def confirm(self, proposal_id: str, *, by: str) -> dict:
        proposal = self._proposals.get(proposal_id)
        if proposal is None:
            raise PriceError(f"不存在的定价建议: {proposal_id}")
        if not str(by).startswith("human:"):
            raise AgentCannotApprove(
                f"最终报价数字必须由人确定（by 必须以 'human:' 开头），收到 {by!r}（FR-PRICE-002）")
        proposal["status"] = "human_confirmed"
        proposal["final_price"] = proposal["proposed_price"]
        proposal["confirmed_by"] = by
        proposal["confirmed_at"] = utc_now()
        if self.ledger is not None:
            self.ledger.append(
                HUMAN_APPROVED_EVENT,
                {"proposal_id": proposal_id, "quote_id": proposal["quote_id"],
                 "item_id": proposal["item_id"], "final_price": proposal["final_price"],
                 "proposed_price": proposal["proposed_price"], "decided_by": by,
                 "approval_id": proposal["approval_id"]},
                correlation_id=proposal["quote_id"], actor=by,
                refs={"proposal_id": proposal_id, "quote_id": proposal["quote_id"]})
        return dict(proposal)

    def get(self, proposal_id: str) -> dict:
        proposal = self._proposals.get(proposal_id)
        if proposal is None:
            raise PriceError(f"不存在的定价建议: {proposal_id}")
        return dict(proposal)

    def proposals(self) -> list[dict]:
        return [dict(self._proposals[key]) for key in self._order]

    def is_confirmed(self, proposal_id: str) -> bool:
        proposal = self._proposals.get(proposal_id)
        return bool(proposal and proposal["status"] == "human_confirmed")

    # --- 流水线阶段 -------------------------------------------------------
    def _stage_cost_baseline(self, work: dict, next_: Callable) -> Any:
        unit = self.cost_service.unit_cost(work["item_id"])
        work["cost_baseline"] = unit["excl_tax"]
        work["stages"].append({"stage": "cost_baseline", "value": unit["excl_tax"],
                               "note": "成本构成不含税单价（私域）"})
        return next_(work)

    def _stage_market_reference(self, work: dict, next_: Callable) -> Any:
        reference = (work["policy"].get("market_reference") or {}).get(work["item_id"])
        work["market_reference"] = reference
        work["stages"].append({"stage": "market_reference", "value": reference,
                               "note": "市场参考价（用于对照，不直接决定报价）"})
        return next_(work)

    def _stage_strategy_markup(self, work: dict, next_: Callable) -> Any:
        markup_pct = float(work["policy"].get("markup_pct", 0.0))
        amount = work["cost_baseline"] * markup_pct / 100.0
        work["markup_pct"] = markup_pct
        work["markup_amount"] = amount
        work["price_after_markup"] = work["cost_baseline"] + amount
        work["stages"].append({"stage": "strategy_markup", "value": work["price_after_markup"],
                               "note": f"策略加价 {markup_pct}%（来自策略 patch）"})
        return next_(work)

    def _stage_risk_reserve(self, work: dict, next_: Callable) -> Any:
        reserve_pct = float(work["policy"].get("risk_reserve_pct", 0.0))
        reserve = work["price_after_markup"] * reserve_pct / 100.0
        work["risk_reserve_pct"] = reserve_pct
        work["risk_reserve_amount"] = reserve
        work["proposed_price"] = work["price_after_markup"] + reserve
        work["stages"].append({"stage": "risk_reserve", "value": work["proposed_price"],
                               "note": f"风险准备金 {reserve_pct}%"})
        return next_(work)

    def _stage_band_check(self, work: dict, next_: Callable) -> Any:
        band = dict(work["policy"].get("authorized_band") or {})
        low = band.get("min_unit_price")
        high = band.get("max_unit_price")
        price = work["proposed_price"]
        in_band = (low is None or price >= low) and (high is None or price <= high)
        work["band"] = band
        work["in_band"] = in_band
        work["stages"].append({"stage": "band_check", "value": price,
                               "note": f"授权区间 [{low}, {high}] → {'区间内' if in_band else '越界'}"})
        if in_band:
            work["status"] = "proposed"
            return work
        # 越界：无条件请求批准（不得直接产出可提交价格）
        if self.approval is None:
            raise PriceError("越界定价必须请求批准，但本服务未接上 ctx.approval（不允许旁路）")
        request = self.approval.request(
            OUT_OF_BAND_SCOPE,
            {"quote_id": work["quote_id"], "item_id": work["item_id"],
             "proposed_price": price, "cost_baseline": work["cost_baseline"], "band": band},
            ref=f"{work['quote_id']}:{work['item_id']}",
            reason=f"定价 {price:.2f} 超出授权区间 {band}（越界必须由人决定）")
        work["approval_id"] = request["approval_id"]
        work["status"] = "awaiting_approval"
        return work
