"""ctx.norm 的 P0 实现（`04-services-catalog.md` §2 / `05-events.md` §3 的 `quote/normalize` 链）。

归一化就是一条 waterfall 链：**单位 → 币种（含汇率时点）→ 税 → 计量规则 → 条目对齐**，
任一环不可行即短路并产出拒绝理由与下一步动作（P6：归一化在边界，不在决策里）。
阶段本身是可撤销的 effect（`07-self-evolution.md` §2：归一化规则可卸载替换）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..kernel.canon import digest
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from .measures import (FxBook, IncompatibleMeasure, MeasureBook, MeasureRule, TaxBook, UnitTable,
                       UnknownUnit)

NORM_EVENT = "quote/normalize"
NORMALIZED_EVENT = "quote/normalized"
REJECTED_EVENT = "quote/normalize-rejected"
NORM_REASON = "归一化任一环不可行即中断并产出拒绝理由（05-events.md §5 / P6）"
STAGE_NAMES = ("unit", "currency", "tax", "measure", "align")


class NormError(RuntimeError):
    """归一化错误。"""


@dataclass
class Rejection:
    code: str
    reason: str
    next_action: str
    item_id: str | None = None
    details: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"code": self.code, "reason": self.reason, "next_action": self.next_action,
                "item_id": self.item_id, "details": self.details}

    def __str__(self) -> str:  # pragma: no cover - 排障用
        return f"[{self.code}] {self.reason} → 下一步: {self.next_action}"


@dataclass
class NormalizationResult:
    quote_id: str
    package_id: str
    rfq_rev: int
    currency: str
    tax_code: str
    tax_mode: str
    lines: list[dict]
    totals: dict
    alignment: dict
    factors: dict
    tolerance_bps: int
    citations: list[str]

    def as_dict(self) -> dict:
        return {"quote_id": self.quote_id, "package_id": self.package_id, "rfq_rev": self.rfq_rev,
                "currency": self.currency, "tax_code": self.tax_code, "tax_mode": self.tax_mode,
                "lines": self.lines, "totals": self.totals, "alignment": self.alignment,
                "factors": self.factors, "tolerance_bps": self.tolerance_bps,
                "citations": self.citations}


@dataclass
class NormalizationOutcome:
    quote_id: str
    result: NormalizationResult | None = None
    rejection: Rejection | None = None
    ledger_refs: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.result is not None and self.rejection is None


class NormService:
    """`ctx.norm` 的默认 Provider（`norm.default`）。"""

    def __init__(self, *, package: dict, units: UnitTable | None = None,
                 measures: MeasureBook | None = None, fx: FxBook | None = None,
                 taxes: TaxBook | None = None, ledger: Ledger | None = None,
                 events: EventBus | None = None, actor: str = "agent:norm", name: str = "norm") -> None:
        self.package = package
        self.units = units or UnitTable()
        self.measures = measures or MeasureBook()
        self.fx = fx or FxBook()
        self.taxes = taxes or TaxBook()
        self.ledger = ledger
        self.events = events or _private_bus()
        self.actor = actor
        self.name = name
        self._disposers: list[Callable[[], None]] = []
        self._attached = False

    # --- 装配（可撤销） ---------------------------------------------------
    def attach_defaults(self) -> list[Callable[[], None]]:
        self._ensure_declared()
        stages = (self._stage_unit, self._stage_currency, self._stage_tax,
                  self._stage_measure, self._stage_align)
        self._disposers = [self.events.on(NORM_EVENT, stage, label=f"norm:{stage.__name__[7:]}")
                           for stage in stages]
        self._attached = True
        return list(self._disposers)

    def attach(self, ctx) -> None:
        """以插件方式装配：阶段注册进 fiber 的 effect 作用域，卸载即撤销。"""
        self._ensure_declared()
        for stage in (self._stage_unit, self._stage_currency, self._stage_tax,
                      self._stage_measure, self._stage_align):
            ctx.on(NORM_EVENT, stage, label=f"norm:{stage.__name__[7:]}")
        self._attached = True

    def detach(self) -> None:
        for dispose in self._disposers:
            dispose()
        self._disposers = []
        self._attached = False

    def plugin_spec(self) -> dict:
        return {"name": self.name, "inject": [], "provide": {self.name: self}, "setup": self.attach}

    def stage_labels(self) -> list[str]:
        return self.events.listeners(NORM_EVENT)

    # --- 主流程 -----------------------------------------------------------
    def normalize(self, quote: dict) -> NormalizationOutcome:
        if self.ledger is not None:
            self.ledger.assert_healthy()          # 账本冻结即停止对外产出（FR-LEDGER-003）
        if not self._attached:
            self.attach_defaults()
        work = self._new_work(quote)
        value = self.events.waterfall(NORM_EVENT, work)
        if isinstance(value, Rejection):
            return self._record_rejection(value, quote, work)
        return self._record_success(value, quote)

    def align(self, quote: dict) -> dict:
        package_items = {item["item_id"]: item for item in self.package.get("items", [])}
        quoted = [line.get("item_id") for line in quote.get("lines", [])]
        matched = [item_id for item_id in quoted if item_id in package_items]
        additional = [line["item_id"] for line in quote.get("lines", [])
                      if line.get("item_id") not in package_items and line.get("additional")]
        unaligned = [line["item_id"] for line in quote.get("lines", [])
                     if line.get("item_id") not in package_items and not line.get("additional")]
        missing = [item_id for item_id in package_items if item_id not in quoted]
        return {"matched": matched, "additional": additional, "missing": missing, "unaligned": unaligned}

    # --- 五个阶段 ---------------------------------------------------------
    def _stage_unit(self, work: dict, next_: Callable) -> Any:
        rules: dict[str, Any] = {}
        package_items = {item["item_id"] for item in work["package"].get("items", [])}
        deferred: set[str] = set()
        for line in work["lines"]:
            item_id = line.get("item_id")
            unit = line.get("unit")
            if item_id not in package_items and not line.get("additional"):
                # 既不在清单也未标 additional：这是对齐缺陷，留给对齐阶段给出更可行动的拒绝理由
                deferred.add(item_id)
                continue
            rule = self.measures.for_item(item_id) if item_id else None
            if rule is None and line.get("additional") and self.units.has(unit):
                # additional 条目不在清单内，没有包内计量规则：按**报价单位本身**归一（不做单位换算），
                # 并把这一推导显式记录下来——不是猜测换算，也不是静默放行（AC-NORM-003）。
                rule = MeasureRule(item_id=item_id or "", base_unit=unit,
                                   allowed_units=(unit,), tolerance_bps=0, rounding=2,
                                   note="additional 条目：无包内计量规则，按报价单位本身归一")
                rules[item_id] = (rule, "derived_from_unit_for_additional")
            elif rule is not None:
                rules[item_id] = (rule, "package_measure_rule")
            if rule is None:
                return Rejection(
                    "measure_rule_missing",
                    f"清单条目 {item_id!r} 没有计量规则（无法确定基准单位/容差）",
                    "为该条目补充计量规则（基准单位、允许单位、容差）后重新归一",
                    item_id=item_id, details={"unit": unit, "measure_items": self.measures.items()})
            if not rule.allows(unit) or not self.units.has(unit):
                unknown = "（该单位也不在单位换算表中）" if not self.units.has(unit) else ""
                return Rejection(
                    "unit_not_in_measure_rule",
                    f"条目 {item_id} 的报量单位 {unit!r} 不在计量规则允许集合 "
                    f"{list(rule.allowed_units)} 内{unknown}",
                    "改用允许单位重新报量，或由承包商升版计量规则；系统不做单位猜测",
                    item_id=item_id,
                    details={"unit": unit, "allowed": list(rule.allowed_units),
                             "unit_known": self.units.has(unit)})
        work["rules"] = rules
        work["deferred"] = deferred
        return next_(work)

    def _stage_currency(self, work: dict, next_: Callable) -> Any:
        quote = work["quote"]
        target = work["package"]["currency"]
        source = quote.get("currency") or target
        at = quote.get("fx_at")
        rate = self.fx.rate_at(source, target, at)
        if rate is None:
            return Rejection(
                "fx_timepoint_unavailable",
                f"{source}→{target} 在时点 {at!r} 没有可用汇率",
                "提供该时点的汇率（或在报价中声明 fx_at）后重新提交；不得用其它时点或缓存汇率兜底",
                details={"from": source, "to": target, "at": at,
                         "available_timepoints": self.fx.timepoints(source, target)})
        work["currency"] = source
        work["fx"] = rate
        return next_(work)

    def _stage_tax(self, work: dict, next_: Callable) -> Any:
        quote = work["quote"]
        code = quote.get("tax_code") or work["package"].get("tax_code")
        rule = self.taxes.get(code) if code else None
        if rule is None:
            return Rejection(
                "tax_rule_missing",
                f"税制代码 {code!r} 不在税制表中（无法判定含税/不含税口径）",
                "补充该税率或改用已登记税制代码后重新提交",
                details={"tax_code": code, "known": self.taxes.codes()})
        work["tax_code"] = code
        work["tax"] = rule
        work["tax_mode"] = quote.get("tax_mode") or rule.mode_default
        return next_(work)

    def _stage_measure(self, work: dict, next_: Callable) -> Any:
        normalized: list[dict] = []
        for line in work["lines"]:
            item_id = line["item_id"]
            if item_id in work.get("deferred", ()) or item_id not in work["rules"]:
                continue  # 对齐缺陷：由对齐阶段拒绝并给出理由（AC-NORM-003）
            rule, rule_source = work["rules"][item_id]
            # 单价按"每个报价单位"给出，换算到基准单位要乘「1 个基准单位等于多少个报价单位」
            price_factor = self.units.factor(rule.base_unit, line["unit"])
            qty_base = self.units.convert(line["qty"], line["unit"], rule.base_unit)
            price_in_quote_currency = line["unit_price"] * price_factor
            rate = work["fx"].rate
            price_target_inclusive = price_in_quote_currency * rate
            if work["tax_mode"] == "inclusive":
                price_exclusive = price_target_inclusive / (1.0 + work["tax"].rate)
            else:
                price_exclusive = price_target_inclusive
            amount_exclusive = price_exclusive * qty_base
            normalized.append({
                "item_id": item_id,
                "alignment": None,
                "alignment_note": None,
                "unit": line["unit"],
                "qty": line["qty"],
                "base_unit": rule.base_unit,
                "base_qty": qty_base,
                "unit_price": line["unit_price"],
                "normalized_unit_price_inclusive": round(price_target_inclusive, rule.rounding),
                "normalized_unit_price_exclusive": round(price_exclusive, rule.rounding),
                "normalized_amount_exclusive": round(amount_exclusive, rule.rounding),
                "currency": work["package"]["currency"],
                "tax_code": work["tax_code"],
                "tax_mode": work["tax_mode"],
                "tolerance_bps": rule.tolerance_bps,
                "factors": {
                    "unit": {"from": line["unit"], "to": rule.base_unit,
                             "price_factor": price_factor,
                             "qty_factor": self.units.factor(line["unit"], rule.base_unit)},
                    "fx": {"from": work["fx"].base, "to": work["fx"].quote, "rate": rate,
                           "at": work["fx"].at, "source": work["fx"].source},
                    "tax": {"code": work["tax_code"], "rate": work["tax"].rate,
                            "mode": work["tax_mode"]},
                    "measure_rule": {"item_id": item_id, "base_unit": rule.base_unit,
                                     "rounding": rule.rounding, "note": rule.note,
                                     "source": rule_source},
                },
                "amount_unrounded": amount_exclusive,
            })
        work["normalized"] = normalized
        return next_(work)

    def _stage_align(self, work: dict, next_: Callable) -> Any:
        package_items = {item["item_id"]: item for item in work["package"].get("items", [])}
        quoted = [line["item_id"] for line in work["lines"]]
        matched, additional, unaligned = [], [], []
        for line in work["lines"]:
            item_id = line["item_id"]
            if item_id in package_items:
                line["alignment"] = "matched"
                matched.append(item_id)
            elif line.get("additional"):
                line["alignment"] = "additional"
                line["alignment_note"] = line.get("note") or "显式标为 additional（清单外的额外内容）"
                additional.append(item_id)
            else:
                unaligned.append(item_id)
        if unaligned:
            return Rejection(
                "unaligned_line",
                f"报价条目 {unaligned} 既不在清单中，也未显式标为 additional",
                "把这些条目对齐到清单条目，或显式标记 additional 并说明原因（不得静默丢弃）",
                details={"unaligned": unaligned, "package_items": sorted(package_items)})
        alignment = {"matched": matched, "additional": additional,
                     "missing": [item for item in package_items if item not in quoted],
                     "unaligned": []}
        by_item = {line["item_id"]: line for line in work["lines"]}
        for line in work["normalized"]:
            raw = by_item[line["item_id"]]
            line["alignment"] = raw["alignment"]
            line["alignment_note"] = raw.get("alignment_note")
        work["alignment"] = alignment
        return next_(work)

    # --- 内部 -------------------------------------------------------------
    def _new_work(self, quote: dict) -> dict:
        lines = [dict(line) for line in quote.get("lines", [])]
        for line in lines:
            line.setdefault("qty", 0)
            line.setdefault("unit_price", 0.0)
        return {"quote": quote, "package": self.package, "lines": lines, "normalized": [],
                "currency": quote.get("currency"), "tax_code": quote.get("tax_code"),
                "tax_mode": quote.get("tax_mode"), "fx": None, "tax": None, "alignment": {}}

    def _ensure_declared(self) -> None:
        if self.events.mode_of(NORM_EVENT) is None:
            self.events.declare(NORM_EVENT, "waterfall", reason=NORM_REASON)

    def _record_success(self, work: dict, quote: dict) -> NormalizationOutcome:
        lines = work["normalized"]
        tolerance = max([line["tolerance_bps"] for line in lines] or [0])
        totals = {
            "exclusive_total": round(sum(line["normalized_amount_exclusive"] for line in lines),
                                     max([line["factors"]["measure_rule"]["rounding"] for line in lines] or [2])),
            "by_alignment": {
                "matched": round(sum(l["normalized_amount_exclusive"] for l in lines if l["alignment"] == "matched"), 2),
                "additional": round(sum(l["normalized_amount_exclusive"] for l in lines if l["alignment"] == "additional"), 2),
            },
        }
        citations = [f"{work['package']['package_id']}#rev{work['package'].get('rev', quote.get('rfq_rev'))}:{line['item_id']}"
                     for line in lines]
        result = NormalizationResult(
            quote_id=quote.get("quote_id", ""), package_id=work["package"]["package_id"],
            rfq_rev=quote.get("rfq_rev", 0), currency=work["package"]["currency"],
            tax_code=work["tax_code"], tax_mode=work["tax_mode"], lines=lines, totals=totals,
            alignment=work["alignment"],
            factors={"fx": lines[0]["factors"]["fx"] if lines else {},
                     "tax": lines[0]["factors"]["tax"] if lines else {},
                     "from_currency": work["currency"]},
            tolerance_bps=tolerance, citations=citations)
        refs: list[dict] = []
        if self.ledger is not None:
            ref = self.ledger.append(
                NORMALIZED_EVENT,
                {"quote_id": result.quote_id, "package_id": result.package_id,
                 "rfq_rev": result.rfq_rev, "lines": len(lines),
                 "total_exclusive": totals["exclusive_total"], "tolerance_bps": tolerance,
                 "alignment": work["alignment"], "result_hash": digest(result.as_dict())},
                correlation_id=quote.get("correlation_id") or quote.get("quote_id"),
                actor=self.actor,
                refs={"package_id": result.package_id, "rfq_rev": result.rfq_rev})
            refs.append(ref.as_dict())
            result.citations.append(f"ledger:seq{ref.seq}")
        return NormalizationOutcome(quote_id=result.quote_id, result=result, ledger_refs=refs)

    def _record_rejection(self, rejection: Rejection, quote: dict, work: dict) -> NormalizationOutcome:
        refs: list[dict] = []
        if self.ledger is not None:
            ref = self.ledger.append(
                REJECTED_EVENT,
                dict(rejection.as_dict(),
                     quote_id=quote.get("quote_id"), package_id=work["package"]["package_id"],
                     rfq_rev=quote.get("rfq_rev")),
                correlation_id=quote.get("correlation_id") or quote.get("quote_id"),
                actor=self.actor, refs={"package_id": work["package"]["package_id"]})
            refs.append(ref.as_dict())
        return NormalizationOutcome(quote_id=quote.get("quote_id", ""), result=None,
                                    rejection=rejection, ledger_refs=refs)


def _private_bus() -> EventBus:
    bus = EventBus()
    bus.install_defaults()
    return bus
