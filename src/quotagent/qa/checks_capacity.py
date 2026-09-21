"""产能/交期 AC（T-207 / FR-CAP-001、FR-CAP-002）：AC-CAP-001。

覆盖：`firm` 交期在有效期内不可由模型变更（人改/过期后改可以）、产能日历 + 关键路径可行性、
冲突只提请人工（不否决、不改交期）、日历私域不外发。
"""

from __future__ import annotations

import json
from datetime import date, timedelta

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.capacity import Calendar, CapacityService, FirmDateImmutable
from .registry import Assertion, register

START = "2026-10-01"


def _stack(tmp_name: str, *, rate: float = 10.0, days: int = 30):
    root = new_scratch(tmp_name)
    bus = EventBus()
    bus.install_defaults()
    calendar = Calendar(owner="supplier:sup-A")
    begin = date.fromisoformat(START)
    for offset in range(days):
        day = begin + timedelta(days=offset)
        calendar.set_day(day, 0.0 if day.weekday() >= 5 else rate)   # 周末无产能
    service = CapacityService(participant="sup-A", realm="supplier:sup-A",
                              ledger=Ledger(root / "sup.jsonl", realm="supplier:sup-A"),
                              events=bus, calendar=calendar)
    return root, service, calendar


@register("AC-CAP-001", "P1", "firm 交期在有效期内不可由模型变更（冲突只提请人工）",
          "qa ac AC-CAP-001", evidence_refs=("EV-047",))
def ac_cap_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, service, calendar = _stack("ac-cap-001")

    commitment = service.commit(quote_id="q-0007", package_id="pkg-014", lead_time_days=10,
                                quantity=100.0, start_date=START, binding="firm",
                                valid_until="2026-12-31", by="human:liao")
    out.append(Assertion("建立 `firm` 承诺：交期由 lead_time 推导，且带有效期（有效期内不可变更的前提）",
                         commitment.delivery_date == "2026-10-11"
                         and commitment.valid_until == "2026-12-31"
                         and commitment.binding == "firm"
                         and len(service.ledger.read(type="capacity/committed")) == 1,
                         f"commitment={json.dumps(commitment.to_dict(), ensure_ascii=False)[:180]}"))

    refusal = None
    try:
        service.amend(commitment_id=commitment.commitment_id, changes={"lead_time_days": 25},
                      by="agent:price", on="2026-10-02")
    except FirmDateImmutable as err:
        refusal = str(err)
    refused_events = service.ledger.read(type="capacity/firm-change-refused")
    after = service.commitment(commitment.commitment_id)
    out.append(Assertion("**模型**在有效期内改 `firm` 交期 → 被拒且留痕，承诺值不变",
                         refusal is not None and "FR-CAP-002" in refusal
                         and [row["body"]["attempted_by"] for row in refused_events] == ["agent:price"]
                         and after.lead_time_days == 10 and after.delivery_date == "2026-10-11"
                         and after.revision == 1,
                         f"refusal={refusal} events={len(refused_events)} "
                         f"lead={after.lead_time_days} rev={after.revision}"))
    out.append(Assertion("拒绝事件带可行动的 next_action（不是只说「不能改」）",
                         bool(refused_events) and bool(refused_events[-1]["body"]["next_action"])
                         and "人工门" in refused_events[-1]["body"]["next_action"],
                         f"next_action={refused_events[-1]['body']['next_action'] if refused_events else None}"))

    human = service.amend(commitment_id=commitment.commitment_id, changes={"lead_time_days": 25},
                          by="human:liao", on="2026-10-02")
    out.append(Assertion("**人**在有效期内改同一字段 → 允许（产生新 revision 并留痕）",
                         human["revision"] == 2
                         and service.commitment(commitment.commitment_id).lead_time_days == 25
                         and service.commitment(commitment.commitment_id).delivery_date == "2026-10-26"
                         and any(row["body"].get("action") == "amend"
                                 for row in service.ledger.read(type="capacity/committed")),
                         f"amend={json.dumps(human, ensure_ascii=False)}"))

    expired = service.amend(commitment_id=commitment.commitment_id, changes={"quantity": 120.0},
                           by="agent:price", on="2027-01-05")
    out.append(Assertion("有效期过后模型可以改（有效期是「不可变更」的边界，不是无限期）",
                         expired["revision"] == 3
                         and service.commitment(commitment.commitment_id).quantity == 120.0,
                         f"expired_amend={json.dumps(expired, ensure_ascii=False)}"))

    loose = service.commit(quote_id="q-0008", package_id="pkg-014", lead_time_days=5, quantity=50.0,
                           start_date=START, binding="indicative", by="agent:price")
    indicative = service.amend(commitment_id=loose.commitment_id, changes={"lead_time_days": 7},
                               by="agent:price", on="2026-10-02")
    out.append(Assertion("`indicative` 交期允许模型调整（binding 决定约束强度）",
                         indicative["revision"] == 2
                         and service.commitment(loose.commitment_id).lead_time_days == 7,
                         f"indicative={json.dumps(indicative, ensure_ascii=False)}"))

    # 产能冲突：要 400 单位，日历在窗口内只有 ~200 → 不可行，只提请人工
    heavy = service.commit(quote_id="q-0009", package_id="pkg-014", lead_time_days=30,
                           quantity=400.0, start_date=START, binding="firm",
                           valid_until="2026-12-31", by="human:liao",
                           milestones=[{"name": "首批到货", "due": "2026-10-11", "quantity": 150.0}])
    feasibility = service.feasibility(commitment_id=heavy.commitment_id)
    conflict_rows = service.ledger.read(type="capacity/conflict")
    out.append(Assertion("产能日历 + 关键路径算出不可行 → 只提请人工（requires_human，不改交期、不否决）",
                         feasibility["feasible"] is False and feasibility["requires_human"] is True
                         and feasibility["action"] == "escalate_to_human"
                         and feasibility["shortfall"] > 0 and feasibility["milestone_blockers"]
                         and bool(conflict_rows)
                         and service.commitment(heavy.commitment_id).delivery_date == "2026-10-31",
                         f"feasibility={json.dumps(feasibility, ensure_ascii=False)[:260]}"))
    out.append(Assertion("冲突事件写明「不自动改交期、不否决报价」（护栏不否决的落账口径）",
                         "不否决" in conflict_rows[-1]["body"]["note"]
                         and conflict_rows[-1]["body"]["binding"] == "firm",
                         f"note={conflict_rows[-1]['body']['note']}"))
    out.append(Assertion("里程碑阻塞逐条列出（关键路径，不是只看总量）",
                         any(item["milestone"] == "首批到货" and item["required"] == 150.0
                             and item["available"] < 150.0 for item in feasibility["milestone_blockers"]),
                         f"blockers={json.dumps(feasibility['milestone_blockers'], ensure_ascii=False)}"))

    local_flags = service.conflict_flags()
    safe_flags = service.conflict_flags(share_safe=True)
    out.append(Assertion("冲突可转成护栏 Flag；**对外形态不含日历数值**（产能日历是私域）",
                         local_flags and local_flags[0]["kind"] == "capacity_risk"
                         and local_flags[0]["requires_human"] is True
                         # 本地形态带具体数值（400/220/180）；对外形态不得带这些私域数值
                         and all(token in local_flags[0]["detail"] for token in ("400", "220", "180"))
                         and not any(token in safe_flags[0]["detail"]
                                     for token in ("400", "220", "180"))
                         and "calendar:private" in safe_flags[0]["evidence_refs"],
                         f"local={local_flags[0]['detail'][:80]} safe={safe_flags[0]['detail'][:80]}"))
    return out
