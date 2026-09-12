"""偏差与影响量化 AC（T-111）：AC-DEV-001（未标 impact 的偏差不参与 TCO；类别与影响可查）。"""

from __future__ import annotations

import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.deviation import DeviationService
from .registry import Assertion, register

REALM = "supplier:sup-A"

PACKAGE = {
    "package_id": "pkg-014",
    "rev": 1,
    "currency": "CNY",
    "payment_terms": {"payment_days": 45, "advance_pct": 10.0},
    "deadlines": {"quote_by": "2026-09-25T00:00:00Z", "delivery_by": "2026-11-30T00:00:00Z"},
    "items": [
        {"item_id": "L-001", "description": "DN100 管道", "unit": "m", "qty": 120,
         "spec_refs": ["spec://piping/DN100"], "measurement_rule": "mr-length"},
        {"item_id": "L-002", "description": "管支架", "unit": "kg", "qty": 480,
         "spec_refs": ["spec://support/STD"], "measurement_rule": "mr-mass"},
    ],
}

DRAFT = {
    "quote_id": "q-0007",
    "package_id": "pkg-014",
    "rfq_rev": 1,
    "currency": "CNY",
    "lead_time_days": 120,
    "payment_terms_offered": {"payment_days": 30, "advance_pct": 20.0},
    "lines": [
        {"item_id": "L-001", "unit": "m", "unit_price": 84.17, "qty": 120,
         "spec_refs": ["spec://piping/DN100-rev2"]},          # 技术偏差：规格引用被替换
        {"item_id": "L-002", "unit": "kg", "unit_price": 8.0, "qty": 480,
         "spec_refs": ["spec://support/STD"]},
        {"item_id": "L-900", "unit": "m", "unit_price": 50.0, "qty": 10, "additional": True,
         "note": "临时封堵"},                                    # 范围偏差：清单外内容
    ],
}


def _service(tmp_name: str = "dev-001"):
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "supplier.jsonl", realm=REALM)
    bus = EventBus()
    bus.install_defaults()
    return DeviationService(realm=REALM, ledger=ledger, events=bus, actor="agent:deviation"), ledger, bus


@register("AC-DEV-001", "P0", "未标 impact 的偏差不参与 TCO；偏差类别与影响可查",
          "qa ac AC-DEV-001", evidence_refs=("EV-028",))
def ac_dev_001() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus = _service()

    deviations = service.capture(DRAFT, PACKAGE)
    kinds = {d["kind"] for d in deviations}
    out.append(Assertion("偏差捕捉覆盖四类（技术/商务/进度/范围）并逐条带 kind 与条目引用",
                         kinds == {"technical", "commercial", "schedule", "scope"}
                         and all(d.get("kind") and d.get("deviation_id") for d in deviations),
                         f"kinds={sorted(kinds)} deviations={[(d['kind'], d.get('item_id')) for d in deviations]}"))
    out.append(Assertion("刚捕捉的偏差都还没量化（impact 为空），被标为 incomplete 而非被丢弃",
                         all(d["impact"] is None for d in deviations)
                         and all(d["status"] == "incomplete" for d in deviations),
                         f"status={[d['status'] for d in deviations]}"))

    unquantified_total = service.tco_contribution(deviations)
    out.append(Assertion("未标 impact 的偏差不参与 TCO（合计为 0，且被显式排除并列出）",
                         unquantified_total["total_price_impact"] == 0.0
                         and len(unquantified_total["excluded"]) == len(deviations)
                         and unquantified_total["included"] == [],
                         f"contribution={json.dumps(unquantified_total, ensure_ascii=False)}"))

    technical = next(d for d in deviations if d["kind"] == "technical")
    quantified = service.impact(technical["deviation_id"], price=1200.0, time_days=5, risk="medium")
    out.append(Assertion("影响量化给出三维（price/time/risk），并记录量化人/来源",
                         quantified["impact"] == {"price": 1200.0, "time_days": 5, "risk": "medium"}
                         and quantified["status"] == "quantified"
                         and quantified["quantified_by"] == "agent:deviation",
                         f"impact={quantified['impact']} status={quantified['status']}"))

    partial = service.tco_contribution(service.deviations())
    out.append(Assertion("量化后的偏差进入 TCO 合计，未量化的仍被排除（部分量化不污染合计）",
                         abs(partial["total_price_impact"] - 1200.0) < 1e-9
                         and len(partial["excluded"]) == len(deviations) - 1
                         and partial["included"] == [technical["deviation_id"]],
                         f"total={partial['total_price_impact']} included={partial['included']} "
                         f"excluded={partial['excluded']}"))

    schedule = next(d for d in deviations if d["kind"] == "schedule")
    service.impact(schedule["deviation_id"], price=0.0, time_days=15, risk="low")
    # 手算：技术偏差 time_days=5 + 进度偏差 15 = 20 天；价格合计仍只有技术偏差的 1200
    contribution = service.tco_contribution(service.deviations())
    out.append(Assertion("时间影响单独可查（5 天技术 + 15 天进度 = 20 天；价格合计不变）",
                         contribution["total_time_impact_days"] == 20.0
                         and abs(contribution["total_price_impact"] - 1200.0) < 1e-9,
                         f"time={contribution['total_time_impact_days']} price={contribution['total_price_impact']}"))

    by_kind = service.deviations(kind="scope")
    out.append(Assertion("按类别可查偏差", len(by_kind) == 1 and by_kind[0]["item_id"] == "L-900",
                         f"scope={by_kind}"))
    detail = service.explain(technical["deviation_id"])
    out.append(Assertion("单条偏差可解释（描述/引用/影响/量化来源）",
                         detail["deviation_id"] == technical["deviation_id"]
                         and detail["description"] and detail["refs"]
                         and detail["impact"]["price"] == 1200.0,
                         f"explain={json.dumps(detail, ensure_ascii=False)[:240]}"))

    suggestion = service.alternative(technical["deviation_id"])
    out.append(Assertion("替代方案只作为建议（Intent），不自动改变已捕捉的偏差",
                         suggestion["kind"] == "intent" and suggestion["description"]
                         and service.explain(technical["deviation_id"])["impact"]["price"] == 1200.0,
                         f"suggestion={suggestion}"))

    captured = ledger.read(type="quote/deviation-captured")
    quantified_events = ledger.read(type="quote/deviation-quantified")
    out.append(Assertion("捕捉与量化分别落账（可审计：谁在何时把哪条偏差量化成多少）",
                         len(captured) == len(deviations) and len(quantified_events) == 2
                         and all("impact" in e["body"] for e in captured)
                         and ledger.verify_chain(),
                         f"captured={len(captured)} quantified={len(quantified_events)} "
                         f"chain={ledger.verify_chain()}"))
    return out
