"""口径数据层（单位、计量规则、汇率、税制）。

这是 `01-architecture.md` §5 四层 patch 在 P0 的最小形态：行业模板给出基线，
项目/标段 patch 通过 `patch()` 覆盖。**任何一层缺失都不许兜底**——查不到就返回 None，由调用方拒绝
（P6：归一化在边界，不在决策里）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

DEFAULT_UNITS: dict[str, tuple[str, float]] = {
    # code -> (量纲, 到基准单位的因子)
    "m": ("length", 1.0), "cm": ("length", 0.01), "km": ("length", 1000.0),
    "kg": ("mass", 1.0), "t": ("mass", 1000.0), "g": ("mass", 0.001),
    "l": ("volume", 1.0), "m3": ("volume", 1000.0),
    "pcs": ("count", 1.0), "set": ("count", 1.0),
    "h": ("time", 1.0), "day": ("time", 24.0),
}

DEFAULT_TAXES: dict[str, dict] = {
    "cn-vat-13": {"rate": 0.13, "mode_default": "exclusive", "note": "增值税 13%"},
    "cn-vat-9": {"rate": 0.09, "mode_default": "exclusive", "note": "增值税 9%"},
}


class MeasuresError(RuntimeError):
    """口径数据层错误。"""


class UnknownUnit(MeasuresError):
    """单位不在换算表中。"""


class IncompatibleMeasure(MeasuresError):
    """两个单位量纲不同，不可换算。"""


@dataclass(frozen=True)
class UnitDef:
    code: str
    measure: str
    factor_to_base: float


class UnitTable:
    def __init__(self, units: dict[str, tuple[str, float]] | None = None) -> None:
        table = DEFAULT_UNITS if units is None else units
        self._units = {code: UnitDef(code, data[0], float(data[1])) for code, data in table.items()}

    def get(self, code: str) -> UnitDef | None:
        return self._units.get(code)

    def has(self, code: str) -> bool:
        return code in self._units

    def units(self) -> list[str]:
        return sorted(self._units)

    def patch(self, units: dict[str, tuple[str, float]]) -> None:
        for code, data in units.items():
            self._units[code] = UnitDef(code, data[0], float(data[1]))

    def convert(self, value: float, frm: str, to: str) -> float:
        if frm == to:
            return float(value)
        a, b = self.get(frm), self.get(to)
        if a is None:
            raise UnknownUnit(f"未知单位: {frm!r}（换算表: {len(self._units)} 项）")
        if b is None:
            raise UnknownUnit(f"未知单位: {to!r}（换算表: {len(self._units)} 项）")
        if a.measure != b.measure:
            raise IncompatibleMeasure(f"{frm}({a.measure}) 与 {to}({b.measure}) 量纲不同，不可换算")
        return float(value) * a.factor_to_base / b.factor_to_base

    def factor(self, frm: str, to: str) -> float:
        return self.convert(1.0, frm, to)


@dataclass(frozen=True)
class MeasureRule:
    """计量规则：某条目的基准单位、允许的报量单位、声明容差与取整。"""

    item_id: str
    base_unit: str
    allowed_units: tuple[str, ...]
    tolerance_bps: int = 0
    rounding: int = 2
    note: str = ""

    def allows(self, unit: str) -> bool:
        return unit in self.allowed_units


class MeasureBook:
    def __init__(self, rules: dict[str, MeasureRule] | None = None) -> None:
        self._rules: dict[str, MeasureRule] = dict(rules or {})

    def patch(self, rules: dict[str, MeasureRule]) -> None:
        self._rules.update(rules)

    def for_item(self, item_id: str) -> MeasureRule | None:
        return self._rules.get(item_id)

    def has_unit(self, item_id: str, unit: str) -> bool:
        rule = self.for_item(item_id)
        return bool(rule and rule.allows(unit))

    def items(self) -> list[str]:
        return sorted(self._rules)


@dataclass(frozen=True)
class FxRate:
    base: str
    quote: str
    rate: float
    at: str
    source: str = ""


class FxBook:
    """汇率按时点取值；**只接受精确命中的时点**（缺则返回 None，由调用方拒绝）。"""

    def __init__(self) -> None:
        self._rates: list[FxRate] = []

    def add(self, rate: FxRate) -> None:
        self._rates.append(rate)

    def rate_at(self, base: str, quote: str, at: str | None) -> FxRate | None:
        if in_same_currency(base, quote):
            return FxRate(base=base, quote=quote, rate=1.0, at=at or "", source="identity")
        for rate in self._rates:
            if rate.base == base and rate.quote == quote and rate.at == at:
                return rate
        return None

    def timepoints(self, base: str, quote: str) -> list[str]:
        return sorted(r.at for r in self._rates if r.base == base and r.quote == quote)


def in_same_currency(a: str, b: str) -> bool:
    return a == b


@dataclass(frozen=True)
class TaxRule:
    code: str
    rate: float
    mode_default: str = "exclusive"
    note: str = ""


class TaxBook:
    def __init__(self, taxes: dict[str, dict] | None = None) -> None:
        table = DEFAULT_TAXES if taxes is None else taxes
        self._taxes = {code: TaxRule(code, float(data["rate"]),
                                     data.get("mode_default", "exclusive"), data.get("note", ""))
                       for code, data in table.items()}

    def get(self, code: str) -> TaxRule | None:
        return self._taxes.get(code)

    def codes(self) -> list[str]:
        return sorted(self._taxes)

    def patch(self, taxes: dict[str, dict]) -> None:
        for code, data in taxes.items():
            self._taxes[code] = TaxRule(code, float(data["rate"]),
                                        data.get("mode_default", "exclusive"), data.get("note", ""))
