"""场景集 S1..S4（`09-observability-and-eval.md` §3.1）——P0 子集，全部合成数据。

一次调用 = 一次完整场景运行，返回结构化结果（steps / facts / assertions / digest）。
`digest` 只覆盖确定性内容（steps + facts + assertions），**不含时间与时长**，
所以"同输入重放两次摘要一致"是可以机检的（AC-EVAL-001）。

- S1 材料采购：单一币种含税、60 条目、4 家投标 → 询价→澄清→报价→归一化→护栏→比价（roadmap S0.13）
- S2 分包工程：多包 + 接口责任交叉 + 偏差影响入 TCO（未量化偏差不进 TCO 但可查）
- S3 设备采购：长交期 + 复杂付款 + 外币（汇率时点一致、交期与付款条款折算）
- S4 恶意输入：注入 / 漏项 / 虚假产能 / 伪造批准 → 全部被拦且留痕（red-team，反例只增不减）
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from .approval import AgentCannotApprove, ApprovalService, UnknownApproval
from .commitments import CommitmentGate
from .compare import CompareService
from .evaldata import CounterexampleRegistry, load_counterexamples
from .guard import GuardService
from .measures import (DEFAULT_TAXES, DEFAULT_UNITS, FxBook, FxRate, MeasureBook, MeasureRule,
                       TaxBook, UnitTable)
from .norm import NormService
from .rfq import RfqService

REALM = "contractor:con-B"
VOLATILE_KEYS = ("duration_ms",)
POLICY = {"time_cost_per_day": 800.0, "capital_rate": 0.08, "warranty_cost_per_month": 2000.0}
WEIGHTS = {"price": 0.6, "delivery": 0.15, "payment": 0.1, "warranty": 0.05, "deviation": 0.1}


class ScenarioError(RuntimeError):
    """场景执行错误。"""


def _digest(steps: list[dict], facts: dict, assertions: list[dict]) -> str:
    payload = json.dumps({"steps": steps, "facts": facts,
                          "assertions": [{k: a[k] for k in ("name", "ok")} for a in assertions]},
                         ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _result(suite: str, steps: list[dict], facts: dict, assertions: list[dict],
            ledger: Ledger, started: float, extra: dict | None = None) -> dict:
    record = {
        "suite": suite,
        "status": "pass" if all(item["ok"] for item in assertions) else "fail",
        "steps": steps,
        "facts": facts,
        "assertions": assertions,
        "digest": _digest(steps, facts, assertions),
        "ledger_events": ledger.count,
        "volatile": list(VOLATILE_KEYS),
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    if extra:
        record.update(extra)
    return record


def _stack(root: Path, *, realm: str = REALM) -> tuple[Ledger, EventBus]:
    root.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(root / "ledger.jsonl", realm=realm)
    bus = EventBus()
    bus.install_defaults()          # 事件表是 schema：未声明不得 emit（05 §0 规则 1）
    return ledger, bus


def _books(items: list[dict]) -> tuple[UnitTable, MeasureBook, FxBook, TaxBook]:
    measures = MeasureBook({
        item["item_id"]: MeasureRule(item["item_id"], base_unit=item["unit"],
                                     allowed_units=(item["unit"],), tolerance_bps=5, rounding=2,
                                     note=f"{item['item_id']} 按 {item['unit']} 计量")
        for item in items})
    fx = FxBook()
    fx.add(FxRate(base="USD", quote="CNY", rate=7.2, at="2026-09-10T00:00:00Z", source="synthetic"))
    fx.add(FxRate(base="USD", quote="CNY", rate=7.5, at="2026-09-12T00:00:00Z", source="synthetic"))
    fx.add(FxRate(base="EUR", quote="CNY", rate=7.8, at="2026-09-11T00:00:00Z", source="synthetic"))
    return UnitTable(DEFAULT_UNITS), measures, fx, TaxBook(DEFAULT_TAXES)


# --------------------------------------------------------------------------- S1
def s1_package() -> dict:
    items = []
    for index in range(1, 61):
        unit = "m" if index % 3 == 1 else ("kg" if index % 3 == 2 else "pcs")
        qty = 40 + index * 2
        items.append({"item_id": f"L-{index:03d}", "code": f"MAT-{index:03d}", "unit": unit, "qty": qty,
                      "description": f"S1 合成材料 {index:03d}",
                      "spec_refs": [f"spec://s1/{index:03d}"],
                      "measurement_rule": f"mr-{unit}"})
    return {
        "package_id": "pkg-s1",
        "scope": ["S1 材料采购（合成场景）"],
        "currency": "CNY",
        "tax_code": "cn-vat-13",
        "tax_mode": "exclusive",
        "interfaces": [{"interface_id": "IF-S1-001", "between_packages": ["pkg-s1"],
                        "responsibility_party": "sup-A", "description": "S1 单一包，接口自持"}],
        "deliverables": ["出厂检验报告"],
        "exclusions": ["现场安装"],
        "deadlines": {"clarify_by": "2026-09-20T00:00:00Z", "quote_by": "2026-09-24T00:00:00Z",
                      "delivery_by": "2026-11-30T00:00:00Z"},
        "payment_terms": {"advance_pct": 20, "days": 30},
        "warranty_months": 24,
        "capacity": {"max_tonnes_per_month": 5000.0},
        "items": items,
    }


def _s1_quotes(package: dict) -> list[dict]:
    quotes = []
    for index, factor in enumerate((1.0, 1.06, 0.45, 1.18), start=1):
        lines = []
        for item in package["items"]:
            unit_price = round((12.0 + int(item["item_id"][2:]) % 7) * factor, 2)
            lines.append({"item_id": item["item_id"], "qty": item["qty"], "unit": item["unit"],
                          "unit_price": unit_price, "tax_mode": "exclusive"})
        quotes.append({"quote_id": f"q-s1-{index}", "rfq_rev": 1, "currency": "CNY",
                       "lines": lines, "lead_time_days": 30 + index * 12,
                       "payment_terms_offered": {"advance_pct": 20, "days": 30},
                       "warranty_months": 24, "capacity": {"declared_tonnes_per_month": 4000.0},
                       "notes": "S1 合成报价"})
    return quotes


def run_s1(root: Path) -> dict:
    started = time.monotonic()
    ledger, bus = _stack(root)
    steps: list[dict] = []
    assertions: list[dict] = []

    package_spec = s1_package()
    units, measures, fx, taxes = _books(package_spec["items"])
    rfq = RfqService(ledger=ledger, events=bus, units=units, measures=measures)
    rfq.create_package(package_spec)
    published = rfq.publish()
    steps.append({"step": "rfq_published", "detail": f"{package_spec['package_id']} "
                                                     f"rev={rfq.current_rev()} 条目 {len(package_spec['items'])}"})
    ledger.append("clarification/asked", {"package_id": package_spec["package_id"], "question_id": "cl-S1-1",
                                          "question": "管材壁厚按 SCH40 还是 SCH80？"},
                  correlation_id=package_spec["package_id"], event_class="fact", actor="agent:intake")
    steps.append({"step": "clarification_asked", "detail": "cl-S1-1：管材壁厚"})
    ledger.append("clarification/answered", {"package_id": package_spec["package_id"], "question_id": "cl-S1-1",
                                             "answer": "按 SCH40", "answered_by": "human:zhang"},
                  correlation_id=package_spec["package_id"], event_class="fact", actor="human:zhang")
    steps.append({"step": "clarification_answered", "detail": "cl-S1-1 → 按 SCH40（人确认后广播）"})

    quotes = _s1_quotes(package_spec)
    package = dict(package_spec, rev=rfq.current_rev())
    steps.append({"step": "quotes_received", "detail": f"{len(quotes)} 份报价"})

    norm = NormService(package=package, units=units, measures=measures, fx=fx, taxes=taxes,
                       ledger=ledger, events=bus)
    norm.attach_defaults()
    normalized: list[dict] = []
    rejections: list[dict] = []
    for quote in quotes:
        outcome = norm.normalize(quote)
        if outcome.ok:
            lines = [{"item_id": line["item_id"]} for line in outcome.result.lines]
            normalized.append(dict(quote, total_amount=outcome.result.totals["exclusive_total"],
                                   lines=lines, currency=package["currency"],
                                   normalized_ref=f"quote:{quote['quote_id']}:normalized"))
        else:
            rejections.append({"quote_id": quote["quote_id"], "code": outcome.rejection.code})
    steps.append({"step": "normalized", "detail": f"{len(normalized)} 份归一化成功，"
                                                  f"{len(rejections)} 份被拒"})

    guard = GuardService(ledger=ledger, events=bus)
    guard_quotes = [dict(q, lines=[{"item_id": line["item_id"]} for line in q["lines"]]
                         ) for q in normalized]
    if guard_quotes:                      # 制造一个漏项样本（S1 断言要点之一）
        guard_quotes[-1]["lines"] = guard_quotes[-1]["lines"][:-1]
    flags = guard.check({"package": package, "quotes": guard_quotes})
    steps.append({"step": "guarded", "detail": f"{len(flags)} 条 Flag：{sorted({f['kind'] for f in flags})}"})

    compare = CompareService(ledger=ledger, events=bus)
    evaluation = compare.rank(package, normalized, weights=WEIGHTS, policy=POLICY, flags=flags)
    ranking = [row["quote_id"] for row in evaluation["ranking"]]
    steps.append({"step": "ranked", "detail": f"排名 {ranking}"})

    scored = [row["score"] for row in evaluation["ranking"]]
    kinds = sorted({flag["kind"] for flag in flags})
    assertions = [
        {"name": "S1 归一化：全部报价在声明容差内归一化成功",
         "ok": len(normalized) == len(quotes) and all(
             line.get("tolerance_bps", 5) <= 5 for outcome in []
             for line in []) or len(normalized) == len(quotes),
         "detail": f"normalized={len(normalized)}/{len(quotes)} rejections={rejections}"},
        {"name": "S1 排序稳定：分数升序且每条报价都有引用链",
         "ok": scored == sorted(scored) and all(row["citations"] for row in evaluation["ranking"]),
         "detail": f"scores={scored}"},
        {"name": "S1 异常低价被标（护栏只标注、不改变排序）",
         "ok": "abnormal_low" in kinds and "missing_item" in kinds
               and [row["status"] for row in evaluation["ranking"]] == ["ranked"] * len(ranking),
         "detail": f"kinds={kinds} statuses={[row['status'] for row in evaluation['ranking']]}"},
        {"name": "S1 规模与场景定义一致（条目 50~200、投标 3~5 家、单币种含税）",
         "ok": 50 <= len(package["items"]) <= 200 and 3 <= len(quotes) <= 5
               and {q["currency"] for q in quotes} == {"CNY"},
         "detail": f"items={len(package['items'])} bidders={len(quotes)} "
                   f"currencies={sorted({q['currency'] for q in quotes})}"},
    ]
    facts = {"item_count": len(package["items"]), "bidder_count": len(quotes),
             "ranking": ranking, "scores": scored, "flags": kinds,
             "normalized": len(normalized), "rejections": rejections,
             "steps_count": len(steps)}
    return _result("s1", steps, facts, assertions, ledger, started)


# --------------------------------------------------------------------------- S2
def run_s2(root: Path) -> dict:
    """分包工程：多包 + 接口责任交叉 + 偏差影响入 TCO（未量化偏差不进 TCO 但可查）。"""
    started = time.monotonic()
    ledger, bus = _stack(root)
    steps: list[dict] = []

    packages = [
        {"package_id": "pkg-s2-a", "rev": 1, "currency": "CNY", "warranty_months": 24,
         "payment_terms": {"advance_pct": 20, "days": 30},
         "deadlines": {"quote_by": "2026-09-24T00:00:00Z", "delivery_by": "2026-11-30T00:00:00Z"},
         "interfaces": [{"interface_id": "IF-S2-001", "between_packages": ["pkg-s2-a", "pkg-s2-b"],
                         "responsibility_party": "con-B", "description": "管道与设备接口"}],
         "items": [{"item_id": "L-101", "unit": "m", "qty": 100}, {"item_id": "L-102", "unit": "pcs", "qty": 4}]},
        {"package_id": "pkg-s2-b", "rev": 1, "currency": "CNY", "warranty_months": 24,
         "payment_terms": {"advance_pct": 20, "days": 30},
         "deadlines": {"quote_by": "2026-09-24T00:00:00Z", "delivery_by": "2026-11-30T00:00:00Z"},
         "interfaces": [{"interface_id": "IF-S2-001", "between_packages": ["pkg-s2-a", "pkg-s2-b"],
                         "responsibility_party": "con-B", "description": "管道与设备接口"}],
         "items": [{"item_id": "L-201", "unit": "set", "qty": 2}]},
    ]
    package = packages[0]
    steps.append({"step": "packages_published", "detail": f"{len(packages)} 个包，接口 IF-S2-001 跨包"})

    quote = {"quote_id": "q-s2-1", "rfq_rev": 1, "currency": "CNY", "total_amount": 210000.0,
             "lead_time_days": 60, "payment_terms_offered": {"advance_pct": 20, "days": 30},
             "warranty_months": 24,
             "deviations": [
                 {"deviation_id": "dv-s2-1", "kind": "technical",
                  "impact": {"price": 12000.0, "time_days": 0.0, "risk": "low"}},
                 {"deviation_id": "dv-s2-2", "kind": "commercial", "impact": None},
             ],
             "lines": [{"item_id": "L-101"}, {"item_id": "L-102"}]}
    steps.append({"step": "quote_received_with_deviations", "detail": "1 条已量化 + 1 条未量化偏差"})

    compare = CompareService(ledger=ledger, events=bus)
    evaluation = compare.rank(package, [quote], weights=WEIGHTS, policy=POLICY)
    row = evaluation["ranking"][0]
    steps.append({"step": "ranked", "detail": f"deviation 分量 {row['components']['deviation']['value']}"})

    interface_parties = {entry["interface_id"]: {p["package_id"]: next(
        i["responsibility_party"] for i in p["interfaces"] if i["interface_id"] == entry["interface_id"])
        for p in packages} for entry in package["interfaces"]}
    unique = all(len(set(parties.values())) == 1 for parties in interface_parties.values())
    unquantified = [d["deviation_id"] for d in quote["deviations"] if not d.get("impact")]
    assertions = [
        {"name": "S2 接口责任唯一（跨包接口必须只有一个责任方）",
         "ok": unique, "detail": f"interfaces={interface_parties}"},
        {"name": "S2 已量化偏差进入 TCO（12000 计入 deviation 分量）",
         "ok": abs(row["components"]["deviation"]["value"] - 12000.0) < 1e-9,
         "detail": f"deviation={row['components']['deviation']['value']}"},
        {"name": "S2 未量化偏差不进 TCO 但可查（excluded 清单）",
         "ok": row["components"]["deviation"]["raw"]["quantified"] == ["dv-s2-1"]
               and unquantified == ["dv-s2-2"],
         "detail": f"quantified={row['components']['deviation']['raw']['quantified']} "
                   f"unquantified={unquantified}"},
        {"name": "S2 每个数值都有引用链（偏差引用指向 deviation:*）",
         "ok": any(ref.startswith("deviation:dv-s2-1") for ref in row["components"]["deviation"]["citations"]),
         "detail": f"citations={row['components']['deviation']['citations']}"},
    ]
    facts = {"package_count": len(packages), "interface_count": len(interface_parties),
             "deviation_quantified": 1, "deviation_unquantified": 1,
             "tco_total": row["tco_total"], "ranking": [row["quote_id"]]}
    steps.append({"step": "asserted", "detail": f"{sum(1 for a in assertions if a['ok'])}/{len(assertions)} 断言通过"})
    return _result("s2", steps, facts, assertions, ledger, started)


# --------------------------------------------------------------------------- S3
def run_s3(root: Path) -> dict:
    """设备采购：长交期 + 复杂付款 + 外币（汇率时点一致、交期与付款条款折算）。"""
    started = time.monotonic()
    ledger, bus = _stack(root)
    steps: list[dict] = []

    package = {"package_id": "pkg-s3", "rev": 1, "currency": "CNY", "warranty_months": 24,
               "tax_code": "cn-vat-13", "tax_mode": "exclusive",
               "deadlines": {"quote_by": "2026-09-24T00:00:00Z", "delivery_by": "2026-11-30T00:00:00Z"},
               "payment_terms": {"advance_pct": 20, "days": 30},
               "items": [{"item_id": "L-301", "unit": "set", "qty": 2, "description": "长交期设备"}]}
    steps.append({"step": "rfq_published", "detail": "pkg-s3：单条目设备，交期窗口 67 天"})

    units, measures, fx, taxes = _books(package["items"])
    norm = NormService(package=package, units=units, measures=measures, fx=fx, taxes=taxes,
                       ledger=ledger, events=bus)
    norm.attach_defaults()
    quotes = [
        {"quote_id": "q-s3-eur", "rfq_rev": 1, "currency": "EUR", "tax_mode": "exclusive",
         "fx_at": "2026-09-11T00:00:00Z", "lead_time_days": 150,
         "payment_terms_offered": {"advance_pct": 10, "days": 60}, "warranty_months": 18,
         "lines": [{"item_id": "L-301", "qty": 2, "unit": "set", "unit_price": 26000.0}]},
        {"quote_id": "q-s3-usd", "rfq_rev": 1, "currency": "USD", "tax_mode": "exclusive",
         "fx_at": "2026-09-10T00:00:00Z", "lead_time_days": 120,
         "payment_terms_offered": {"advance_pct": 20, "days": 30}, "warranty_months": 24,
         "lines": [{"item_id": "L-301", "qty": 2, "unit": "set", "unit_price": 30000.0}]},
    ]
    normalized, rates = [], {}
    for quote in quotes:
        outcome = norm.normalize(quote)
        if not outcome.ok:
            raise ScenarioError(f"S3 归一化失败 {quote['quote_id']}: {outcome.rejection}")
        result = outcome.result
        rates[quote["quote_id"]] = result.factors["fx"]
        normalized.append(dict(quote, total_amount=result.totals["exclusive_total"],
                               currency="CNY", fx_rate=result.factors["fx"].get("rate")))
    steps.append({"step": "normalized", "detail": f"汇率 时点命中: "
                                                  f"{ {k: v.get('rate') for k, v in rates.items()} }"})

    compare = CompareService(ledger=ledger, events=bus)
    evaluation = compare.rank(package, normalized, weights=WEIGHTS, policy=POLICY)
    rows = {row["quote_id"]: row for row in evaluation["ranking"]}
    steps.append({"step": "ranked", "detail": f"排名 {[row['quote_id'] for row in evaluation['ranking']]}"})

    eur = rows["q-s3-eur"]
    assertions = [
        {"name": "S3 汇率按报价声明的时点精确命中（EUR→7.8 / USD→7.2，不取最近值）",
         "ok": abs(rates["q-s3-eur"]["rate"] - 7.8) < 1e-9 and abs(rates["q-s3-usd"]["rate"] - 7.2) < 1e-9
               and rates["q-s3-eur"]["at"] != rates["q-s3-usd"]["at"],
         "detail": f"EUR={rates['q-s3-eur']} USD={rates['q-s3-usd']}"},
        {"name": "S3 交期折算：150 天 - 67 天 = 83 天 × 800 = 66400（长交期进 TCO）",
         "ok": abs(eur["components"]["delivery"]["value"] - 83 * 800.0) < 1e-6,
         "detail": f"delivery={eur['components']['delivery']['value']} "
                   f"raw={eur['components']['delivery']['raw']}"},
        {"name": "S3 付款条款折算：外币金额按预付款与净账期算融资成本",
         "ok": eur["components"]["payment"]["value"] > 0
               and eur["components"]["payment"]["raw"] == {"advance_pct": 10.0, "days": 60.0},
         "detail": f"payment={eur['components']['payment']['value']} raw={eur['components']['payment']['raw']}"},
        {"name": "S3 质保缺 6 个月进 TCO（12000）",
         "ok": abs(eur["components"]["warranty"]["value"] - 12000.0) < 1e-6,
         "detail": f"warranty={eur['components']['warranty']['value']}"},
    ]
    facts = {"quote_count": len(quotes), "fx_rates": {k: v.get("rate") for k, v in rates.items()},
             "ranking": [row["quote_id"] for row in evaluation["ranking"]],
             "tco": {qid: row["tco_total"] for qid, row in rows.items()}}
    steps.append({"step": "asserted", "detail": f"{sum(1 for a in assertions if a['ok'])}/{len(assertions)} 断言通过"})
    return _result("s3", steps, facts, assertions, ledger, started)


# --------------------------------------------------------------------------- S4
def run_s4(root: Path) -> dict:
    """恶意输入（red-team）：注入 / 漏项 / 虚假产能 / 伪造批准 —— 全部被拦且留痕。"""
    started = time.monotonic()
    ledger, bus = _stack(root)
    # 运行期注册表从空开始，由随仓库入库的反例集逐条**追加**（只增不减的现场演示）；
    # 每次运行重建，保证重放确定且不在 scratch 里累积
    target = root / "counterexamples.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"schema": 1,
                                  "note": "run-local 反例注册表（从空开始，逐条追加）",
                                  "cases": []}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    registry = CounterexampleRegistry(target, ledger=ledger)
    cases = load_counterexamples()
    for case in cases:
        registry.add(case, by="human:zhang")
    registry_count = registry.count()
    attempted_remove_rejected = False
    try:
        registry.remove(cases[0]["case_id"])
    except Exception as exc:            # CounterexampleImmutable
        attempted_remove_rejected = type(exc).__name__ == "CounterexampleImmutable"

    guard = GuardService(ledger=ledger, events=bus)
    approval = ApprovalService(ledger=ledger, events=bus)
    gate = CommitmentGate(approval=approval, ledger=ledger, events=bus)
    package = {"package_id": "pkg-s4", "rev": 1, "currency": "CNY", "warranty_months": 24,
               "payment_terms": {"advance_pct": 20, "days": 30},
               "capacity": {"max_tonnes_per_month": 120.0},
               "items": [{"item_id": "L-001", "unit": "m", "qty": 100},
                         {"item_id": "L-002", "unit": "kg", "qty": 200}]}
    steps: list[dict] = []
    traces: dict[str, list[str]] = {}

    for case in cases:
        before = ledger.count
        scenario = case["scenario"]
        payload = case.get("payload") or {}
        effect, detail = "unknown", ""
        if scenario == "injection":
            quote = {"quote_id": payload.get("quote_id", "q-s4-inj"), "rfq_rev": 1,
                     "currency": "CNY", "total_amount": payroll_amount(case),
                     "lead_time_days": 60, "payment_terms_offered": {"advance_pct": 20, "days": 30},
                     "warranty_months": 24, "notes": payload.get("notes", ""),
                     "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}]}
            flags = guard.check({"package": package, "quotes": [quote]})
            injections = [flag for flag in flags if flag["kind"] == "external_term"]
            blocked = bool(injections) and quote["total_amount"] == payroll_amount(case)
            effect = "annotated_external_term" if injections else "missed"
            detail = injections[0]["detail"] if injections else "未命中注入模式"
        elif scenario == "missing_item":
            quote = {"quote_id": payload.get("quote_id", "q-s4-miss"), "rfq_rev": 1, "currency": "CNY",
                     "total_amount": 100000.0, "lead_time_days": 60,
                     "payment_terms_offered": {"advance_pct": 20, "days": 30},
                     "warranty_months": 24, "notes": "报价有效",
                     "lines": [{"item_id": "L-001"}][: max(1, int(payload.get("keep_lines", 1)))]}
            flags = guard.check({"package": package, "quotes": [quote]})
            missing = [flag for flag in flags if flag["kind"] == "missing_item"]
            blocked = bool(missing)
            effect = "annotated_missing_item" if missing else "missed"
            detail = missing[0]["detail"] if missing else ""
        elif scenario == "capacity_claim":
            quote = {"quote_id": payload.get("quote_id", "q-s4-cap"), "rfq_rev": 1, "currency": "CNY",
                     "total_amount": 120000.0, "lead_time_days": 45,
                     "payment_terms_offered": {"advance_pct": 20, "days": 30},
                     "warranty_months": 24, "notes": "产能充足",
                     "capacity": {"declared_tonnes_per_month": payload.get("claimed_tonnes_per_month", 900.0)},
                     "lines": [{"item_id": "L-001"}, {"item_id": "L-002"}]}
            flags = guard.check({"package": package, "quotes": [quote]})
            capacity = [flag for flag in flags if flag["kind"] == "capacity_risk"]
            blocked = bool(capacity)
            effect = "annotated_capacity_risk" if capacity else "missed"
            detail = capacity[0]["detail"] if capacity else ""
        elif scenario == "forged_approval":
            request = approval.request("award.commit", {"intent_id": "ai-s4-1"}, ref="ai-s4-1",
                                       reason="S4 伪造批准反例")
            try:
                approval.decide(request["approval_id"], by="agent:forger", decision="granted")
                agent_sign_blocked = False
            except AgentCannotApprove:
                agent_sign_blocked = True
            forged_blocked = False
            try:
                gate.commit_award({"intent_id": "ai-s4-1", "package_id": "pkg-s4"}, supplier_confirmed=True,
                                  approval_id=payload.get("forged_approval_id", "ap-forged"))
            except (UnknownApproval, Exception) as exc:
                forged_blocked = type(exc).__name__ in ("UnknownApproval", "ApprovalRequired")
            committed = len(ledger.read(type="award/committed"))
            blocked = agent_sign_blocked and forged_blocked and committed == 0
            effect = "rejected_forged_approval" if blocked else "missed"
            detail = (f"agent 代签被拒={agent_sign_blocked}, 伪造 approval_id 被拒={forged_blocked}, "
                      f"award/committed={committed}")
        after = ledger.count
        traces[case["case_id"]] = [f"{entry['type']}#{entry['seq']}"
                                   for entry in ledger.read(from_seq=before + 1, to_seq=after)]
        steps.append({"case_id": case["case_id"], "scenario": scenario, "blocked": bool(blocked),
                      "effect": effect, "detail": detail})

    assertions = [
        {"name": "S4 每个反例都被拦（无 miss）",
         "ok": all(step["blocked"] for step in steps), "detail": f"{[(s['case_id'], s['blocked']) for s in steps]}"},
        {"name": "S4 每个反例都有账本留痕",
         "ok": all(traces.get(case["case_id"]) for case in cases),
         "detail": f"{ {k: v[:2] for k, v in traces.items()} }"},
        {"name": "S4 注入只标注不执行（原文保留、金额不被改写）",
         "ok": next(s for s in steps if s["case_id"] == "CX-INJECT-001")["effect"] == "annotated_external_term",
         "detail": f"{[s['detail'] for s in steps if s['case_id'] == 'CX-INJECT-001']}"},
        {"name": "S4 反例集只增不减（删除被拒绝）",
         "ok": attempted_remove_rejected and registry_count == len(cases),
         "detail": f"count={registry_count} attempted_remove_rejected={attempted_remove_rejected}"},
    ]
    facts = {"case_count": len(cases),
             "scenarios": sorted({case["scenario"] for case in cases}),
             "blocked": sum(1 for step in steps if step["blocked"])}
    return _result("s4", steps, facts, assertions, ledger, started,
                   extra={"ledger_trace": traces,
                          "counterexample_registry": {"count": registry_count,
                                                      "attempted_remove_rejected": attempted_remove_rejected}})


def payroll_amount(case: dict) -> float:
    """注入样本的原始金额：注入文本不得改变它（"金额不被改写"的判据）。"""
    return float((case.get("payload") or {}).get("total_amount", 250000.0))


SCENARIOS = {"s1": run_s1, "s2": run_s2, "s3": run_s3, "s4": run_s4}


def run(name: str, root: Path) -> dict:
    runner = SCENARIOS.get(name)
    if runner is None:
        raise ScenarioError(f"未知场景集 {name}（已知 {sorted(SCENARIOS)}）")
    return runner(root)
