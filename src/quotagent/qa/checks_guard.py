"""护栏 AC（T-113）：AC-GUARD-001（异常低价与漏项被标 Flag，且 Flag 不改变排序/状态）、
AC-GUARD-003（S4 反例全部被拦且有账本留痕）。"""

from __future__ import annotations

import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.compare import CompareService
from ..services.evaldata import load_counterexamples
from ..services.guard import GuardService
from ..services.scenarios import run_s4
from .registry import Assertion, register

PACKAGE = {
    "package_id": "pkg-0007",
    "rev": 2,
    "currency": "CNY",
    "items": [
        {"item_id": "L-001", "unit": "m", "qty": 60, "spec_refs": ["spec://piping/DN100"]},
        {"item_id": "L-002", "unit": "kg", "qty": 400, "spec_refs": ["spec://support/STD"]},
    ],
    "deadlines": {"quote_by": "2026-09-25T00:00:00Z", "delivery_by": "2026-11-30T00:00:00Z"},
    "payment_terms": {"advance_pct": 20, "days": 30},
    "warranty_months": 24,
    "capacity": {"max_tonnes_per_month": 120.0},
}

WEIGHTS = {"price": 0.6, "delivery": 0.15, "payment": 0.1, "warranty": 0.05, "deviation": 0.1}
POLICY = {"time_cost_per_day": 800.0, "capital_rate": 0.08, "warranty_cost_per_month": 2000.0}


def _quotes() -> list[dict]:
    return [
        {"quote_id": "q-low", "rfq_rev": 2, "currency": "CNY", "total_amount": 90000.0,
         "lead_time_days": 60, "payment_terms_offered": {"advance_pct": 20, "days": 30},
         "warranty_months": 24, "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}],
         "capacity": {"declared_tonnes_per_month": 100.0}, "notes": "报价有效"},
        {"quote_id": "q-mid", "rfq_rev": 2, "currency": "CNY", "total_amount": 400000.0,
         "lead_time_days": 60, "payment_terms_offered": {"advance_pct": 20, "days": 30},
         "warranty_months": 24, "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}],
         "capacity": {"declared_tonnes_per_month": 100.0}, "notes": "报价有效"},
        {"quote_id": "q-missing", "rfq_rev": 2, "currency": "CNY", "total_amount": 395000.0,
         "lead_time_days": 62, "payment_terms_offered": {"advance_pct": 20, "days": 30},
         "warranty_months": 24, "lines": [{"item_id": "L-001"}],
         "capacity": {"declared_tonnes_per_month": 100.0}, "notes": "报价有效"},
    ]


@register("AC-GUARD-001", "P0/P1", "异常低价与漏项被标 Flag，且 Flag 不改变排序或状态（只标注）",
          command="qa ac AC-GUARD-001")
def check_guard_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-guard-001")
    ledger = Ledger(root / "ledger.jsonl", realm="contractor:con-B")
    bus = EventBus()
    guard = GuardService(ledger=ledger, events=bus, actor="agent:guard")
    compare = CompareService(ledger=ledger, events=bus, actor="agent:compare")
    quotes = _quotes()

    flags = guard.check({"package": PACKAGE, "quotes": quotes})
    kinds = {flag["kind"] for flag in flags}
    out.append(Assertion("异常低价被标 Flag（低于同包中位价的 60%）",
                         "abnormal_low" in kinds
                         and any(f["target_ref"] == "q-low" for f in flags if f["kind"] == "abnormal_low"),
                         f"kinds={sorted(kinds)} flags={[(f['kind'], f['target_ref']) for f in flags]}"))
    out.append(Assertion("漏项被标 Flag（清单条目在报价中缺失）",
                         "missing_item" in kinds
                         and any(f["target_ref"] == "q-missing" and "L-002" in f["detail"]
                                 for f in flags if f["kind"] == "missing_item"),
                         f"missing={[f['detail'] for f in flags if f['kind'] == 'missing_item']}"))
    out.append(Assertion("Flag 带 severity 与证据引用（可审计、可复核）",
                         all(f.get("severity") in ("low", "medium", "high") and f.get("evidence_refs")
                             for f in flags),
                         f"flags={json.dumps([{k: f[k] for k in ('kind', 'severity')} for f in flags], ensure_ascii=False)}"))

    # 关键不变量：Flag 只标注，不改变排序与状态
    without = compare.rank(PACKAGE, quotes, weights=WEIGHTS, policy=POLICY)
    with_flags = compare.rank(PACKAGE, quotes, weights=WEIGHTS, policy=POLICY, flags=flags)
    out.append(Assertion("Flag 不改变排序顺序（护栏不得否决）",
                         [r["quote_id"] for r in without["ranking"]] == [r["quote_id"] for r in with_flags["ranking"]],
                         f"without={[r['quote_id'] for r in without['ranking']]} "
                         f"with={[r['quote_id'] for r in with_flags['ranking']]}"))
    out.append(Assertion("Flag 不改变任何报价的状态（异常低价只是提请人看）",
                         all(a["status"] == b["status"] for a, b in zip(without["ranking"], with_flags["ranking"]))
                         and all(r["status"] == "ranked" for r in with_flags["ranking"]),
                         f"statuses={[r['status'] for r in with_flags['ranking']]}"))
    out.append(Assertion("护栏没有否决接口（check 只返回 Flag；Flag 与排序并存落账）",
                         not hasattr(guard, "reject") and not hasattr(guard, "veto"),
                         f"guard_api={[n for n in dir(guard) if not n.startswith('_')]}"))
    flag_events = ledger.read(type="compare/flag-raised")
    out.append(Assertion("Flag 逐条落账（compare/flag-raised），且落账内容与返回值一致",
                         len(flag_events) >= len(flags)
                         and {e["body"]["kind"] for e in flag_events} == kinds,
                         f"events={len(flag_events)} kinds={sorted(kinds)}"))
    return out


@register("AC-GUARD-003", "P0", "S4 反例（注入/漏项/虚假产能/伪造批准）全部被拦且有账本留痕",
          command="qa ac AC-GUARD-003")
def check_guard_003() -> list[Assertion]:
    out: list[Assertion] = []
    cases = load_counterexamples()
    out.append(Assertion("反例集随仓库入库（合成数据，非人工检查）",
                         len(cases) >= 4
                         and {case["scenario"] for case in cases} >= {"injection", "missing_item",
                                                                     "capacity_claim", "forged_approval"},
                         f"cases={[c['case_id'] for c in cases]}"))

    result = run_s4(new_scratch("ac-guard-003"))
    by_case = {step["case_id"]: step for step in result["steps"]}
    out.append(Assertion("S4 全部反例被拦（每个 case 都有拦截动作）",
                         result["status"] == "pass"
                         and all(step["blocked"] for step in result["steps"]),
                         f"status={result['status']} blocked="
                         f"{ {sid: st['blocked'] for sid, st in by_case.items()} }"))
    out.append(Assertion("注入文本不被当作指令执行（原文保留、只标注）",
                         by_case["CX-INJECT-001"]["effect"].startswith("annotated")
                         and "忽略以上规则" in by_case["CX-INJECT-001"]["detail"],
                         f"effect={by_case.get('CX-INJECT-001', {}).get('effect')}"))
    out.append(Assertion("漏项 / 虚假产能 / 伪造批准各自被拦（不是同一条通用拒绝）",
                         by_case["CX-MISSING-001"]["effect"] != by_case["CX-CAPACITY-001"]["effect"]
                         != by_case["CX-APPROVAL-001"]["effect"],
                         f"effects={ {sid: st['effect'] for sid, st in by_case.items()} }"))
    traces = result["ledger_trace"]
    out.append(Assertion("每个反例都有账本留痕（事件类型 + 序号）",
                         all(traces.get(case_id) for case_id in by_case),
                         f"traces={json.dumps(traces, ensure_ascii=False)[:260]}"))
    out.append(Assertion("反例集只增不减：重复加入被接受、删除被拒绝",
                         result["counterexample_registry"]["attempted_remove_rejected"]
                         and result["counterexample_registry"]["count"] == len(cases),
                         f"registry={result['counterexample_registry']}"))
    return out


@register("AC-GUARD-002", "P1", "产能冲突与条款冲突样本被标 Flag 并提请人工（护栏只标注、不否决）",
          "qa ac AC-GUARD-002", evidence_refs=("EV-047",))
def check_guard_002() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("guard-002")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    guard = GuardService(ledger=ledger, events=bus)

    package = dict(PACKAGE)
    package["warranty_terms"] = {"months": 24, "response_hours": 48}      # 质保族要求
    package["penalty_terms"] = {"late_pct_per_week": 0.5, "cap_pct": 5}   # 罚则族要求

    quotes = [
        # 条款冲突三族齐全：付款/质保/罚则都与包内要求不一致
        {"quote_id": "q-terms", "rfq_rev": 2, "total_amount": 100000.0,
         "payment_terms_offered": {"advance_pct": 40, "days": 60},
         "warranty_terms": {"months": 12, "response_hours": 72},
         "penalty_terms": {"late_pct_per_week": 0.0, "cap_pct": 0},
         "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}]},
        # 声称产能超过可验证上限（虚假产能路径）
        {"quote_id": "q-cap", "rfq_rev": 2, "total_amount": 98000.0,
         "payment_terms_offered": {"advance_pct": 20, "days": 30},
         "warranty_terms": {"months": 24, "response_hours": 48},
         "penalty_terms": {"late_pct_per_week": 0.5, "cap_pct": 5},
         "capacity": {"declared_tonnes_per_month": 400.0},
         "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}]},
        # 由产能服务算出的日历/关键路径不可行结论（T-207）
        {"quote_id": "q-calendar", "rfq_rev": 2, "total_amount": 101000.0,
         "payment_terms_offered": {"advance_pct": 20, "days": 30},
         "warranty_terms": {"months": 24, "response_hours": 48},
         "penalty_terms": {"late_pct_per_week": 0.5, "cap_pct": 5},
         "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}]},
    ]
    target = {"package": package, "quotes": quotes,
              "capacity_conflicts": [{"quote_id": "q-calendar", "commitment_id": "cm-0003",
                                      "required": 400.0, "available": 220.0, "shortfall": 180.0,
                                      "milestone_blockers": [{"milestone": "首批到货"}]}]}

    flags = guard.check(target)
    by_kind: dict[str, list[dict]] = {}
    for flag in flags:
        by_kind.setdefault(flag["kind"], []).append(flag)

    term_flags = by_kind.get("term_conflict", [])
    families = {flag.get("family") for flag in term_flags}
    out.append(Assertion("条款冲突覆盖**付款/质保/罚则**三族，逐族逐项列出 required vs offered",
                         families == {"payment_terms", "warranty_terms", "penalty_terms"}
                         and all(flag["diffs"] and flag["requires_human"] for flag in term_flags)
                         and all(flag["target_ref"] == "q-terms" for flag in term_flags),
                         f"families={sorted(families)} flags={len(term_flags)}"))

    cap_flags = by_kind.get("capacity_risk", [])
    cap_refs = {flag["target_ref"] for flag in cap_flags}
    out.append(Assertion("产能冲突两条来源都标 Flag：声称超限（q-cap）与日历/关键路径结论（q-calendar）",
                         cap_refs == {"q-cap", "q-calendar"}
                         and all(flag["requires_human"] and flag["severity"] for flag in cap_flags),
                         f"refs={sorted(cap_refs)}"))
    out.append(Assertion("两类 Flag 都**提请人工**（requires_human=true，且带证据引用）",
                         all(flag.get("requires_human") is True and flag["evidence_refs"]
                             for flag in term_flags + cap_flags),
                         f"flags={[(flag['kind'], flag.get('requires_human')) for flag in term_flags + cap_flags]}"))

    ledger_flags = ledger.read(type="compare/flag-raised")
    kinds_in_ledger = {row["body"]["kind"] for row in ledger_flags}
    out.append(Assertion("Flag 逐条落账 compare/flag-raised（含 kind/severity/requires_human）",
                         {"term_conflict", "capacity_risk"} <= kinds_in_ledger
                         and all("requires_human" in row["body"] for row in ledger_flags),
                         f"ledger_kinds={sorted(kinds_in_ledger)} rows={len(ledger_flags)}"))

    compare = CompareService(ledger=ledger, events=bus)
    ranked = compare.rank(package, [dict(quote, **{"terms": {"lead_time_days": 30, "payment": "net30"}})
                                    for quote in quotes], weights=WEIGHTS, policy=POLICY, flags=flags)
    out.append(Assertion("护栏只标注：两类 Flag 存在时排序仍然产出（flag 与排序并存，不否决不改变状态）",
                         bool(ranked.get("ranking")) and len(ranked["ranking"]) == 3
                         and all("flag" not in key for key in ranked["ranking"][0]),
                         f"ranking={[row['quote_id'] for row in ranked.get('ranking', [])]}"))
    out.append(Assertion("护栏接口没有否决口（check 只返回 Flag 列表，返回项里没有 decision/veto 字段）",
                         isinstance(flags, list)
                         and all("decision" not in flag and "veto" not in flag for flag in flags)
                         and not hasattr(guard, "reject") and not hasattr(guard, "veto"),
                         f"flag_keys={sorted(flags[0]) if flags else None}"))
    return out
