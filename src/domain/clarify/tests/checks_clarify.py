"""澄清工单 AC（T-204 / FR-CLARIFY-001..003）：

- AC-CLARIFY-001：工单必带 `rfq_rev` 与条目引用；无引用的工单被拒绝（含答案草稿的私域拦截）。
- AC-CLARIFY-002：答案广播名单缺任一在册投标人 → 工单不得关闭（INV-006）。
- AC-CLARIFY-003：包升版后相关工单自动重开，且旧答案标记为"针对旧版本"。
"""

from __future__ import annotations

import json

from quotagent.kernel.events import EventBus
from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch
from quotagent.services.clarify import ClarificationService, ClarifyError
from quotagent.qa.registry import Assertion, register


def _stack(tmp_name: str, *, bidders=("sup-A", "sup-B", "sup-C"), private=("internal_cost",),
           strict: bool = True):
    root = new_scratch(tmp_name)
    bus = EventBus()
    bus.install_defaults()
    service = ClarificationService(
        participant="con-B", realm="contractor:con-B",
        ledger=Ledger(root / "con.jsonl", realm="contractor:con-B"), events=bus,
        package={"package_id": "pkg-014", "rfq_rev": 1}, registered_bidders=list(bidders),
        private_fields=list(private), strict_private=strict)
    return root, service


@register("AC-CLARIFY-001", "P1", "工单必带 rfq_rev 与条目引用；无引用的工单被拒绝（含答案草稿的私域拦截）",
          "qa ac AC-CLARIFY-001", evidence_refs=("EV-045",))
def ac_clarify_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, service = _stack("clarify-001")

    refusals = []
    for label, kwargs in (("缺条目引用", {"rfq_rev": 1, "refs": None}),
                          ("条目引用为空", {"rfq_rev": 1, "refs": {"item_ids": []}}),
                          ("缺包版本", {"rfq_rev": None, "refs": {"item_ids": ["L-001"]}})):
        try:
            service.ask(package_id="pkg-014", question="壁厚?", **kwargs)
            refusals.append((label, "未拒绝"))
        except ClarifyError as err:
            refusals.append((label, str(err)))
    out.append(Assertion("缺版本或缺条目引用的工单**被拒绝**（不是警告）",
                         all("未拒绝" != result for _, result in refusals)
                         and all("FR-CLARIFY-001" in result for _, result in refusals),
                         f"refusals={refusals}"))
    rejected = service.ledger.read(type="clarification/rejected")
    reasons = [entry["body"]["errors"][0] for entry in rejected]
    out.append(Assertion("被拒的建单不进工单表，但**留痕**（clarification/rejected 覆盖两类原因；"
                         "同一原因的重复拒绝按账本去重键合并，不产生噪声）",
                         service.tickets == {}
                         and any("rfq_rev" in reason for reason in reasons)
                         and any("item_ids" in reason for reason in reasons)
                         and len(reasons) == 2,
                         f"tickets={len(service.tickets)} rejected={len(reasons)} reasons={reasons}"))

    ticket = service.ask(package_id="pkg-014", rfq_rev=1, refs={"item_ids": ["L-001", "L-002"]},
                         question="DN100 壁厚与保温要求?", asker_realm="supplier:sup-A")
    asked = service.ledger.read(type="clarification/asked")
    out.append(Assertion("合法工单建立并绑定版本与条目引用（落 clarification/asked）",
                         ticket["status"] == "open" and ticket["rfq_rev"] == 1
                         and ticket["refs"]["item_ids"] == ["L-001", "L-002"]
                         and bool(asked) and asked[-1]["body"]["rfq_rev"] == 1
                         and asked[-1]["body"]["refs"]["item_ids"] == ["L-001", "L-002"],
                         f"ticket={json.dumps(ticket, ensure_ascii=False)[:180]}"))

    # 答案草稿先过 waterfall：含私域字段即被拦下（05-events.md §5 的短路）
    blocked = None
    try:
        service.answer(ticket_id=ticket["ticket_id"], text="按内部成本口径报", by="human:zhang",
                       fields={"internal_cost": 12.5, "spec": "rev2"})
    except ClarifyError as err:
        blocked = str(err)
    out.append(Assertion("答案草稿含**私域字段** → waterfall 拦下（不落 clarification/answered）",
                         blocked is not None and "internal_cost" in blocked
                         and service.ledger.read(type="clarification/answered") == []
                         and service.ticket(ticket["ticket_id"])["answer"] is None,
                         f"blocked={blocked}"))
    draft_rejections = [entry for entry in service.ledger.read(type="clarification/rejected")
                        if entry["body"].get("action") == "answer"]
    draft_detail = (json.dumps(draft_rejections[-1]["body"], ensure_ascii=False)[:180]
                    if draft_rejections else "无留痕")
    out.append(Assertion("拦截有留痕（clarification/rejected 记下被拦原因，含私域字段名）",
                         bool(draft_rejections) and "internal_cost" in draft_detail,
                         f"rejections={draft_detail}"))

    try:
        service.answer(ticket_id=ticket["ticket_id"], text="由 agent 代答", by="agent:bot")
        agent_refused = False
    except ClarifyError as err:
        agent_refused = "human:" in str(err)
    out.append(Assertion("回答者必须是 human:*（agent 代答被拒）", agent_refused, f"refused={agent_refused}"))

    answered = service.answer(ticket_id=ticket["ticket_id"], text="壁厚 4mm，见图纸 rev2",
                              by="human:zhang", fields={"spec": "rev2"})
    out.append(Assertion("合法作答落 clarfication/answered（含版本绑定，broadcast_at 仍为空）",
                         answered["status"] == "answered"
                         and service.ledger.read(type="clarification/answered")[-1]["body"]["broadcast_at"] is None
                         and service.ledger.read(type="clarification/answered")[-1]["body"]["rfq_rev"] == 1,
                         f"status={answered['status']}"))

    # 非 strict 模式下改为剥除字段（保留 stripped 留痕）
    _, lenient = _stack("clarify-001-lenient", strict=False)
    ticket2 = lenient.ask(package_id="pkg-014", rfq_rev=1, refs={"item_ids": ["L-003"]}, question="q2")
    draft = lenient.answer(ticket_id=ticket2["ticket_id"], text="含成本口径",
                           by="human:zhang", fields={"internal_cost": 12.5, "spec": "rev3"})
    out.append(Assertion("非 strict 模式改为**剥除**私域字段并留痕（stripped），业务字段保留",
                         draft["answer"]["stripped"] == ["internal_cost"]
                         and "internal_cost" not in draft["answer"]["fields"]
                         and draft["answer"]["fields"].get("spec") == "rev3",
                         f"answer={json.dumps(draft['answer'], ensure_ascii=False)[:180]}"))
    return out


@register("AC-CLARIFY-002", "P1", "答案广播名单缺少任一在册投标人 → 工单不得关闭（INV-006）",
          "qa ac AC-CLARIFY-002", evidence_refs=("EV-045",))
def ac_clarify_002() -> list[Assertion]:
    out: list[Assertion] = []
    root, service = _stack("clarify-002")
    ticket = service.ask(package_id="pkg-014", rfq_rev=1, refs={"item_ids": ["L-001"]}, question="交期?")
    service.answer(ticket_id=ticket["ticket_id"], text="见日历", by="human:zhang")

    incomplete = None
    try:
        service.broadcast(ticket_id=ticket["ticket_id"], to=["sup-A", "sup-B"])
    except ClarifyError as err:
        incomplete = str(err)
    bail_events = service.ledger.read(type="clarification/broadcast-incomplete")
    out.append(Assertion("广播名单缺任一在册投标人 → 拒绝（落 bail 事件，列明缺失者）",
                         incomplete is not None and "sup-C" in incomplete
                         and bool(bail_events) and bail_events[-1]["body"]["missing"] == ["sup-C"]
                         and bail_events[-1]["body"]["registered"] == ["sup-A", "sup-B", "sup-C"],
                         f"error={incomplete} bail={json.dumps(bail_events[-1]['body'], ensure_ascii=False)[:180] if bail_events else None}"))

    close_refused = None
    try:
        service.close(ticket_id=ticket["ticket_id"])
    except ClarifyError as err:
        close_refused = str(err)
    out.append(Assertion("未完整广播时**工单不得关闭**（close 被拒且状态不变）",
                         close_refused is not None and service.ticket(ticket["ticket_id"])["status"] != "closed",
                         f"refused={close_refused} status={service.ticket(ticket['ticket_id'])['status']}"))

    service.broadcast(ticket_id=ticket["ticket_id"], to=["sup-A", "sup-B", "sup-C", "sup-D"])
    closed = service.close(ticket_id=ticket["ticket_id"])
    broadcast_entries = [item for item in service.ledger.read(type="clarification/answered")
                         if item["body"].get("broadcast_complete")]
    out.append(Assertion("广播覆盖全部在册投标人（多给不相关的名字不算缺失）→ 可关闭且落完整名单",
                         closed["status"] == "closed" and bool(broadcast_entries)
                         and broadcast_entries[-1]["body"]["broadcast_to"] == ["sup-A", "sup-B", "sup-C", "sup-D"]
                         and broadcast_entries[-1]["body"]["broadcast_complete"] is True,
                         f"closed={closed['status']} broadcast={json.dumps(broadcast_entries[-1]['body'], ensure_ascii=False)[:200] if broadcast_entries else None}"))
    return out


@register("AC-CLARIFY-003", "P1", "包升版后相关工单自动重开，且旧答案标记为针对旧版本",
          "qa ac AC-CLARIFY-003", evidence_refs=("EV-045",))
def ac_clarify_003() -> list[Assertion]:
    out: list[Assertion] = []
    root, service = _stack("clarify-003")
    ticket = service.ask(package_id="pkg-014", rfq_rev=1, refs={"item_ids": ["L-001"]}, question="保温?")
    service.answer(ticket_id=ticket["ticket_id"], text="含保温 30mm", by="human:zhang")
    service.broadcast(ticket_id=ticket["ticket_id"], to=["sup-A", "sup-B", "sup-C"])
    service.close(ticket_id=ticket["ticket_id"])

    other = service.ask(package_id="pkg-999", rfq_rev=1, refs={"item_ids": ["X-1"]}, question="别的包?")
    bumped = service.on_package_rev(package_id="pkg-014", rfq_rev=2)
    reopened = service.ticket(ticket["ticket_id"])
    untouched = service.ticket(other["ticket_id"])
    reopen_events = service.ledger.read(type="clarification/reopened")

    out.append(Assertion("包升版 → 相关工单**自动重开**（含 from_rev/to_rev），无关包的工单不受影响",
                         reopened["status"] == "open" and bumped["reopened"][0]["from_rev"] == 1
                         and bumped["reopened"][0]["to_rev"] == 2
                         and untouched["status"] == "open" and untouched["rfq_rev"] == 1
                         and len(bumped["reopened"]) == 1,
                         f"reopened={bumped['reopened']} untouched={untouched['ticket_id']}"))
    out.append(Assertion("旧答案标记为**针对旧版本**（stale=true + applies_to_rev=1 + superseded_by_rev=2）",
                         reopened["answer"]["stale"] is True
                         and reopened["answer"]["applies_to_rev"] == 1
                         and reopened["answer"]["superseded_by_rev"] == 2,
                         f"answer={json.dumps(reopened['answer'], ensure_ascii=False)[:200]}"))
    out.append(Assertion("重开留痕 clarification/reopened（含旧答案已失效标记）",
                         bool(reopen_events) and reopen_events[-1]["body"]["previous_answer_stale"] is True
                         and reopen_events[-1]["body"]["to_rev"] == 2,
                         f"events={json.dumps(reopen_events[-1]['body'], ensure_ascii=False)[:200] if reopen_events else None}"))
    out.append(Assertion("旧答案不得当作对新版本的回答：广播被清空 → 直接 close 被拒",
                         reopened["broadcast"] is None and _close_refused(service, ticket["ticket_id"]),
                         f"broadcast={reopened['broadcast']}"))
    return out


def _close_refused(service: ClarificationService, ticket_id: str) -> bool:
    try:
        service.close(ticket_id=ticket_id)
        return False
    except ClarifyError:
        return True
