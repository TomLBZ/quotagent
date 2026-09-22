"""归一化 AC（T-106）：AC-NORM-001（混合口径归一在容差内）、AC-NORM-002（不可归一即拒绝）、AC-NORM-003（条目对齐）。"""

from __future__ import annotations

from quotagent.kernel.events import EventBus
from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch
from quotagent.services.measures import (DEFAULT_TAXES, DEFAULT_UNITS, FxBook, FxRate, MeasureBook,
                                 MeasureRule, TaxBook, UnitTable)
from quotagent.services.norm import NormService
from quotagent.qa.registry import Assertion, register

TOLERANCE_BPS = 5  # 声明容差：万分之 5（由计量规则给出，随结果与账本事件留存）


def _package() -> dict:
    return {
        "package_id": "pkg-014",
        "scope": ["厂区给排水管道更换"],
        "currency": "CNY",
        "tax_code": "cn-vat-13",
        "tax_mode": "exclusive",
        "interfaces": [{"interface_id": "IF-001", "between_packages": ["pkg-014", "pkg-015"],
                        "responsibility_party": "con-B", "description": "与既有管网接口"}],
        "deliverables": ["竣工资料"],
        "exclusions": ["夜间施工"],
        "deadlines": {"clarify_by": "2026-09-20T00:00:00Z", "quote_by": "2026-09-25T00:00:00Z"},
        "items": [
            {"item_id": "L-001", "code": "P-100", "description": "DN100 管道", "unit": "m", "qty": 120,
             "spec_refs": ["spec://piping/DN100"], "measurement_rule": "mr-length"},
            {"item_id": "L-002", "code": "S-200", "description": "管支架", "unit": "kg", "qty": 480,
             "spec_refs": ["spec://support/STD"], "measurement_rule": "mr-mass"},
            {"item_id": "L-003", "code": "V-300", "description": "阀门", "unit": "pcs", "qty": 6,
             "spec_refs": ["spec://valve/DN100"], "measurement_rule": "mr-count"},
        ],
    }


def _books() -> tuple[UnitTable, MeasureBook, FxBook, TaxBook]:
    units = UnitTable(DEFAULT_UNITS)
    measures = MeasureBook({
        "L-001": MeasureRule("L-001", base_unit="m", allowed_units=("m", "cm", "km"),
                             tolerance_bps=TOLERANCE_BPS, rounding=2, note="按延长米计量"),
        "L-002": MeasureRule("L-002", base_unit="kg", allowed_units=("kg", "t"),
                             tolerance_bps=TOLERANCE_BPS, rounding=2, note="按净重计量"),
        "L-003": MeasureRule("L-003", base_unit="pcs", allowed_units=("pcs",),
                             tolerance_bps=TOLERANCE_BPS, rounding=2, note="按个数计量"),
    })
    fx = FxBook()
    fx.add(FxRate(base="USD", quote="CNY", rate=7.2, at="2026-09-10T00:00:00Z", source="pboc"))
    fx.add(FxRate(base="USD", quote="CNY", rate=7.5, at="2026-09-12T00:00:00Z", source="pboc"))
    fx.add(FxRate(base="EUR", quote="CNY", rate=7.8, at="2026-09-11T00:00:00Z", source="ecb"))
    taxes = TaxBook(DEFAULT_TAXES)
    return units, measures, fx, taxes


def _norm_service(*, extra_items: list[dict] | None = None):
    root = new_scratch("norm")
    ledger = Ledger(root / "ledger.jsonl", realm="contractor:con-B")
    bus = EventBus()
    bus.install_defaults()
    units, measures, fx, taxes = _books()
    package = _package()
    if extra_items:
        package["items"] = list(package["items"]) + [dict(item) for item in extra_items]
    service = NormService(package=package, units=units, measures=measures, fx=fx, taxes=taxes,
                          ledger=ledger, events=bus)
    service.attach_defaults()
    return service, ledger, bus


@register("AC-NORM-001", "P0", "含税/不含税 + 不同单位 + 不同币种的混合报价归一后金额在声明容差内",
          "qa ac AC-NORM-001", evidence_refs=("EV-016",))
def ac_norm_001() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus = _norm_service()

    # 手算预期（独立口径，不调用实现）：
    # 报价 A（USD，含税）：L-001 单价 0.55 USD/cm，数量 12000 cm
    #   单位 cm→m：0.55 * 100 = 55.0 USD/m；币种 USD→CNY @7.2：55 * 7.2 = 396.0 CNY/m（含税）
    #   税 13% 含税→不含税：396 / 1.13 = 350.442477876… → 350.44 CNY/m
    #   行金额（不含税）= 350.442477876… * 120 = 42053.0973451… → 42053.10
    # 报价 B（EUR，不含税）：L-002 单价 0.9 EUR/t 但数量以 kg 报（qty 480 kg = 0.48 t）
    #   单位 kg→t：单价 0.9 EUR/t 不变（qty 转 t：480/1000 = 0.48 t）
    #   币种 EUR→CNY @7.8：0.9 * 7.8 = 7.02 CNY/kg… 注意基准单位是 kg：
    #   单价 0.9 EUR/t → 0.0009 EUR/kg → * 7.8 = 0.00702 CNY/kg
    #   行金额 = 0.00702 * 480 = 3.3696 → 3.37（不含税，不加税）
    quote_a = {
        "quote_id": "q-0007", "package_id": "pkg-014", "rfq_rev": 1, "supplier_realm": "supplier:sup-A",
        "currency": "USD", "tax_code": "cn-vat-13", "tax_mode": "inclusive",
        "fx_at": "2026-09-10T00:00:00Z",
        "lines": [{"item_id": "L-001", "unit": "cm", "unit_price": 0.55, "qty": 12000}],
    }
    quote_b = {
        "quote_id": "q-0008", "package_id": "pkg-014", "rfq_rev": 1, "supplier_realm": "supplier:sup-B",
        "currency": "EUR", "tax_code": "cn-vat-13", "tax_mode": "exclusive",
        "fx_at": "2026-09-11T00:00:00Z",
        "lines": [{"item_id": "L-002", "unit": "kg", "unit_price": 0.0009, "qty": 480}],
    }

    outcome_a = service.normalize(quote_a)
    outcome_b = service.normalize(quote_b)
    ok_a = outcome_a.result is not None and outcome_a.rejection is None
    ok_b = outcome_b.result is not None and outcome_b.rejection is None
    out.append(Assertion("两条混合口径报价均成功归一（无拒绝）",
                         ok_a and ok_b,
                         f"A={outcome_a.rejection and outcome_a.rejection.as_dict()} "
                         f"B={outcome_b.rejection and outcome_b.rejection.as_dict()}"))

    if ok_a and ok_b:
        line_a = outcome_a.result.lines[0]
        line_b = outcome_b.result.lines[0]
        expected_a = 42053.097345132744  # 350.442477876… * 120
        expected_b = 0.00702 * 480
        diff_a = abs(line_a["normalized_amount_exclusive"] - expected_a)
        diff_b = abs(line_b["normalized_amount_exclusive"] - expected_b)
        tol_a = expected_a * TOLERANCE_BPS / 10000
        tol_b = expected_b * TOLERANCE_BPS / 10000
        out.append(Assertion("报价 A（USD 含税 + cm）归一金额在手算值容差内",
                             diff_a <= tol_a,
                             f"归一={line_a['normalized_amount_exclusive']} 手算={expected_a:.6f} "
                             f"差={diff_a:.6f} 容差={tol_a:.6f}"))
        out.append(Assertion("报价 B（EUR 不含税 + kg/t 换算）归一金额在手算值容差内",
                             diff_b <= tol_b,
                             f"归一={line_b['normalized_amount_exclusive']} 手算={expected_b:.6f} "
                             f"差={diff_b:.6f} 容差={tol_b:.6f}"))
        out.append(Assertion("结果随行携带所用口径因子（单位/汇率/税），可事后解释",
                             all(k in line_a for k in ("factors", "currency", "base_unit", "tolerance_bps"))
                             and line_a["factors"]["unit"]["from"] == "cm"
                             and line_a["factors"]["fx"]["rate"] == 7.2
                             and line_a["factors"]["tax"]["mode"] == "inclusive",
                             f"factors={line_a.get('factors')}"))
        out.append(Assertion("含税报价被折算到不含税口径（396 → 350.44 CNY/m，差异 = 税）",
                             abs(line_a["normalized_unit_price_exclusive"] - 350.4424778761062) < 0.01
                             and abs(line_a["normalized_unit_price_inclusive"] - 396.0) < 1e-9,
                             f"exclusive={line_a['normalized_unit_price_exclusive']} "
                             f"inclusive={line_a['normalized_unit_price_inclusive']}"))
    else:
        out.append(Assertion("两条混合报价归一成功（前置条件）", False, "无法继续比对金额"))

    # 汇率时点必须被尊重：同一报价改用时点 2026-09-12（7.5）后金额随汇率变化
    quote_a2 = dict(quote_a, quote_id="q-0010", fx_at="2026-09-12T00:00:00Z")
    outcome_a2 = service.normalize(quote_a2)
    expected_a2 = (0.55 * 100 * 7.5 / 1.13) * 120
    if outcome_a2.result is not None:
        got = outcome_a2.result.lines[0]["normalized_amount_exclusive"]
        out.append(Assertion("声明不同汇率时点得到不同金额（时点不可被忽略）",
                             abs(got - expected_a2) <= expected_a2 * TOLERANCE_BPS / 10000,
                             f"7.5 时点归一={got} 手算={expected_a2:.6f}"))
    else:
        out.append(Assertion("声明不同汇率时点得到不同金额（时点不可被忽略）", False,
                             f"被拒绝：{outcome_a2.rejection.as_dict() if outcome_a2.rejection else None}"))

    normalized_events = ledger.read(type="quote/normalized")
    out.append(Assertion("成功归一路径落账 quote/normalized（durable，可审计）",
                         len(normalized_events) == 3 and ledger.verify_chain(),
                         f"count={len(normalized_events)} chain_ok={ledger.verify_chain()}"))
    return out


@register("AC-NORM-002", "P0", "缺计量规则或汇率时点不可得 → 拒绝并给出理由，且不产生结果",
          "qa ac AC-NORM-002", evidence_refs=("EV-017",))
def ac_norm_002() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus = _norm_service(extra_items=[
        {"item_id": "L-004", "code": "NO-RULE", "description": "清单中但没有计量规则的条目",
         "unit": "m", "qty": 10, "spec_refs": [], "measurement_rule": None}])

    base = {"quote_id": "q-bad", "package_id": "pkg-014", "rfq_rev": 1, "supplier_realm": "supplier:sup-A",
            "currency": "CNY", "tax_code": "cn-vat-13", "tax_mode": "exclusive"}
    cases = {
        "unit_not_in_measure_rule": dict(base, quote_id="q-bad-1",
                                         lines=[{"item_id": "L-001", "unit": "bag", "unit_price": 1, "qty": 10}]),
        "measure_rule_missing": dict(base, quote_id="q-bad-2",
                                     lines=[{"item_id": "L-004", "unit": "m", "unit_price": 1, "qty": 10}]),
        "fx_timepoint_unavailable": dict(base, quote_id="q-bad-3", currency="USD",
                                         fx_at="2026-01-01T00:00:00Z",
                                         lines=[{"item_id": "L-001", "unit": "m", "unit_price": 1, "qty": 10}]),
        "tax_rule_missing": dict(base, quote_id="q-bad-4", tax_code="xx-vat-99",
                                 lines=[{"item_id": "L-001", "unit": "m", "unit_price": 1, "qty": 10}]),
    }
    codes: list[str] = []
    for expected_code, quote in cases.items():
        outcome = service.normalize(quote)
        actual = outcome.rejection.code if outcome.rejection else None
        codes.append(str(actual))
        out.append(Assertion(f"{expected_code} → 拒绝且不产生结果",
                             outcome.result is None and actual == expected_code,
                             f"result={outcome.result} code={actual}"))
        if outcome.rejection:
            out.append(Assertion(f"{expected_code} 的拒绝给出理由与下一步动作（P6：fail loud 且可行动）",
                                 bool(outcome.rejection.reason) and bool(outcome.rejection.next_action),
                                 f"reason={outcome.rejection.reason} next={outcome.rejection.next_action}"))

    out.append(Assertion("四条拒绝理由互不相同（不是笼统的'归一失败'）",
                         len(set(codes)) == len(cases),
                         f"codes={codes}"))

    normalized = ledger.read(type="quote/normalized")
    rejected = ledger.read(type="quote/normalize-rejected")
    out.append(Assertion("拒绝路径不落账 quote/normalized（不产生结果）", len(normalized) == 0,
                         f"quote/normalized={len(normalized)}"))
    out.append(Assertion("拒绝路径落账 quote/normalize-rejected（留痕，可审计）",
                         len(rejected) == 4 and all("next_action" in r["body"] for r in rejected),
                         f"count={len(rejected)}"))
    first = rejected[0]["body"] if rejected else {}
    out.append(Assertion("拒绝事件带可机检字段（code/reason/next_action/item_id）",
                         {"code", "reason", "next_action"} <= set(first),
                         f"keys={sorted(first)}"))
    return out


@register("AC-NORM-003", "P0", "报价条目对齐到清单条目或被标 additional；未对齐条目不被静默丢弃",
          "qa ac AC-NORM-003", evidence_refs=("EV-018",))
def ac_norm_003() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus = _norm_service()

    quote = {
        "quote_id": "q-align", "package_id": "pkg-014", "rfq_rev": 1, "supplier_realm": "supplier:sup-A",
        "currency": "CNY", "tax_code": "cn-vat-13", "tax_mode": "exclusive",
        "lines": [
            {"item_id": "L-001", "unit": "m", "unit_price": 300, "qty": 120},
            {"item_id": "L-003", "unit": "pcs", "unit_price": 1200, "qty": 6},
            {"item_id": "L-900", "unit": "m", "unit_price": 50, "qty": 10, "additional": True,
             "note": "额外提供的临时封堵"},
        ],
    }
    outcome = service.normalize(quote)
    if outcome.result is None:
        out.append(Assertion("含 additional 条目的报价可正常归一", False,
                             f"被拒绝：{outcome.rejection.as_dict() if outcome.rejection else None}"))
        return out

    result = outcome.result
    out.append(Assertion("清单条目全部分类到 matched/additional/missing 三态，无静默丢弃",
                         {"matched", "additional", "missing"} <= set(result.alignment),
                         f"alignment={result.alignment}"))
    out.append(Assertion("additional 条目被显式标记（含原因），不下沉为普通条目",
                         result.alignment["additional"] == ["L-900"]
                         and result.lines[2]["alignment"] == "additional"
                         and bool(result.lines[2]["alignment_note"]),
                         f"additional={result.alignment['additional']} line={result.lines[2].get('alignment_note')}"))
    out.append(Assertion("未被报价的清单条目进入 missing（漏项可见，不是消失）",
                         result.alignment["missing"] == ["L-002"],
                         f"missing={result.alignment['missing']}"))
    out.append(Assertion("additional 条目的归一来源被显式记录（按报价单位本身归一，不是猜测换算）",
                         result.lines[2]["factors"]["measure_rule"]["source"] == "derived_from_unit_for_additional"
                         and result.lines[0]["factors"]["measure_rule"]["source"] == "package_measure_rule",
                         f"additional={result.lines[2]['factors']['measure_rule']} "
                         f"matched={result.lines[0]['factors']['measure_rule']}"))

    bad_quote = dict(quote, quote_id="q-unaligned",
                     lines=[{"item_id": "L-777", "unit": "m", "unit_price": 10, "qty": 1}])
    bad = service.normalize(bad_quote)
    out.append(Assertion("既不在清单也未标 additional 的条目 → 拒绝（不静默丢弃）",
                         bad.result is None and bad.rejection is not None
                         and bad.rejection.code == "unaligned_line"
                         and "L-777" in json_dumps(bad.rejection.details),
                         f"code={bad.rejection.code if bad.rejection else None} "
                         f"details={bad.rejection.details if bad.rejection else None}"))

    out.append(Assertion("两轮对齐结论都进账本（成功 normalized / 失败 normalize-rejected）",
                         len(ledger.read(type="quote/normalized")) == 1
                         and len(ledger.read(type="quote/normalize-rejected")) == 1,
                         f"normalized={len(ledger.read(type='quote/normalized'))} "
                         f"rejected={len(ledger.read(type='quote/normalize-rejected'))}"))
    return out


def json_dumps(value) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)
