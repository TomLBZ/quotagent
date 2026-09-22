"""读包抽取 AC（T-108）：AC-INTAKE-001（逐条带 item_id + 无来源标 [假设]）、AC-INTAKE-002（缺项检测 + 疑问需人工确认）。"""

from __future__ import annotations

from quotagent.kernel.events import EventBus
from quotagent.kernel.ledger import Ledger
from quotagent.kernel.plugin import PluginHost
from quotagent.paths import new_scratch
from quotagent.services.intake import IntakeService, TemplateExtractor, UnconfirmedDraftError
from quotagent.services.measures import DEFAULT_UNITS, MeasureBook, MeasureRule, UnitTable
from quotagent.services.rfq import RfqService
from quotagent.qa.registry import Assertion, register

PACKAGE_SPEC = {
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


def _supplier_stack(tmp_name: str, *, include_unsourced: bool = False):
    """供应商侧：先装 rfq（承包商发布包），再装 intake（inject: rfq）。"""
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "supplier.jsonl", realm="supplier:sup-A")
    bus = EventBus()
    bus.install_defaults()
    host = PluginHost(events=bus, ledger=ledger)
    measures = MeasureBook({
        "L-001": MeasureRule("L-001", base_unit="m", allowed_units=("m", "cm"), tolerance_bps=5),
        "L-002": MeasureRule("L-002", base_unit="kg", allowed_units=("kg", "t"), tolerance_bps=5),
        "L-003": MeasureRule("L-003", base_unit="pcs", allowed_units=("pcs",), tolerance_bps=5),
    })
    rfq = RfqService(ledger=ledger, events=bus, units=UnitTable(DEFAULT_UNITS), measures=measures)
    rfq.create_package(PACKAGE_SPEC)
    rfq.publish()
    intake = IntakeService(ledger=ledger, events=bus,
                           extractor=TemplateExtractor(include_unsourced=include_unsourced))
    return host, ledger, bus, rfq, intake


@register("AC-INTAKE-001", "P0", "抽取结果逐条带 item_id；无引用者进入 [假设] 等待人工确认",
          "qa ac AC-INTAKE-001", evidence_refs=("EV-021",))
def ac_intake_001() -> list[Assertion]:
    out: list[Assertion] = []
    host, ledger, bus, rfq, intake = _supplier_stack("intake-001", include_unsourced=True)

    pending = host.mount(intake.plugin_spec())
    out.append(Assertion("读包插件在依赖 rfq 未就绪时不激活（FR-PLUGIN-001 复用）",
                         pending.status == "pending" and host.effects(pending) == [],
                         f"status={pending.status}"))
    host.mount(rfq.plugin_spec())
    mounted = host.get("intake")
    out.append(Assertion("依赖就绪后读包插件自动激活，并能取到包服务",
                         mounted.status == "active" and intake.rfq is rfq,
                         f"status={mounted.status} rfq_ok={intake.rfq is rfq}"))

    result = intake.ingest()
    facts = result["facts"]
    out.append(Assertion("抽取逐条带 item_id，且每条有可核对的来源引用（包 + 条目 + 字段）",
                         len(facts) == len(PACKAGE_SPEC["items"])
                         and all(line.get("item_id") for line in facts)
                         and all(line.get("source") for line in facts)
                         and all(f"pkg-014#rev1:{line['item_id']}" in line["source"] for line in facts),
                         f"facts={[(l['item_id'], l['status']) for l in facts]} "
                         f"lines={[(l['item_id'], l['status']) for l in result['lines']]}"))
    out.append(Assertion("抽取结果带包版本（rfq_rev），条目与版本绑定",
                         result["rfq_rev"] == 1 and all(line["rfq_rev"] == 1 for line in facts),
                         f"rfq_rev={result['rfq_rev']}"))

    assumptions = result["assumptions"]
    out.append(Assertion("无来源的抽取结果被标为 [假设] 并进入待人工确认清单（不混入事实）",
                         len(assumptions) == 1 and assumptions[0]["status"] == "assumption"
                         and assumptions[0]["marker"] == "[假设]"
                         and not assumptions[0]["source"]
                         and all(line["status"] == "extracted" for line in facts),
                         f"assumptions={assumptions}"))
    out.append(Assertion("假设项也带 item_id（可被引用/追踪），但不在事实列表里",
                         all(a.get("item_id") for a in assumptions)
                         and all(a["item_id"] not in {f["item_id"] for f in facts} for a in assumptions),
                         f"assumption_ids={[a['item_id'] for a in assumptions]}"))

    promote_err = None
    try:
        intake.confirm_assumption(assumptions[0]["item_id"], by="agent:intake")
    except UnconfirmedDraftError as exc:
        promote_err = exc
    out.append(Assertion("假设项不得由 agent 自行升级为事实（只能人工确认）",
                         promote_err is not None, f"error={promote_err}"))
    intake.confirm_assumption(assumptions[0]["item_id"], by="human:zhang")
    out.append(Assertion("人工确认后假设项才进入事实集合",
                         any(l["item_id"] == assumptions[0]["item_id"] and l["status"] == "confirmed"
                             for l in intake.current_lines()),
                         f"lines={[(l['item_id'], l['status']) for l in intake.current_lines()]}"))

    completed = ledger.read(type="quote/intake-completed")
    out.append(Assertion("读包完成落账 quote/intake-completed（durable，含条目与假设计数）",
                         len(completed) == 1 and completed[0]["body"]["items"] == len(PACKAGE_SPEC["items"])
                         and completed[0]["body"]["assumptions"] == 1 and ledger.verify_chain(),
                         f"count={len(completed)} body={completed[0]['body'] if completed else None}"))
    return out


@register("AC-INTAKE-002", "P0", "缺项检测覆盖人为删减；疑问清单需人工确认后才外发",
          "qa ac AC-INTAKE-002", evidence_refs=("EV-022",))
def ac_intake_002() -> list[Assertion]:
    out: list[Assertion] = []
    host, ledger, bus, rfq, intake = _supplier_stack("intake-002", include_unsourced=True)
    host.mount(rfq.plugin_spec())
    host.mount(intake.plugin_spec())
    intake.ingest()

    draft_lines = [{"item_id": "L-001", "unit_price": 300, "qty": 120},
                   {"item_id": "L-003", "unit_price": 1200, "qty": 6}]   # 人为删减掉 L-002
    missing = intake.missing(draft={"quote_id": "q-draft", "lines": draft_lines})
    out.append(Assertion("缺项检测覆盖人为删减的条目（L-002 被检出，不因草稿未提及而消失）",
                         [m["item_id"] for m in missing] == ["L-002"]
                         and missing[0]["reason"] == "in_draft_but_omitted",
                         f"missing={missing}"))
    out.append(Assertion("缺项带可执行下一步（要求澄清或补齐），不是只报错",
                         bool(missing[0]["next_action"]), f"next_action={missing[0]['next_action']}"))

    perfect = intake.missing(draft={"quote_id": "q-full",
                                    "lines": draft_lines + [{"item_id": "L-002", "unit_price": 8, "qty": 480}]})
    out.append(Assertion("条目齐全时无缺项（检测不是恒真）", perfect == [], f"missing={perfect}"))

    questions = intake.questions()
    out.append(Assertion("疑问草案逐条引用包版本与条目（无引用的疑问不可外发）",
                         questions and all(q["refs"] for q in questions)
                         and all(q["rfq_rev"] == 1 for q in questions),
                         f"questions={questions}"))

    send_err = None
    try:
        intake.send_questions()
    except UnconfirmedDraftError as exc:
        send_err = exc
    out.append(Assertion("未经人工确认的疑问清单不得外发（P8 人工门前置）",
                         send_err is not None and ledger.read(type="clarification/asked") == [],
                         f"error={send_err} asked={len(ledger.read(type='clarification/asked'))}"))

    agent_confirm = None
    try:
        intake.confirm_questions(by="agent:intake")
    except UnconfirmedDraftError as exc:
        agent_confirm = exc
    out.append(Assertion("疑问确认只能由人完成（agent 代签被拒绝）",
                         agent_confirm is not None, f"error={agent_confirm}"))

    confirmed = intake.confirm_questions(by="human:zhang")
    sent = intake.send_questions()
    asked = ledger.read(type="clarification/asked")
    out.append(Assertion("人工确认后可外发，且逐条落账 clarification/asked（含确认人）",
                         len(confirmed["confirmed"]) == len(questions)
                         and len(sent["sent"]) == len(questions) and len(asked) == len(questions)
                         and all(r["body"]["confirmed_by"] == "human:zhang" for r in asked),
                         f"confirmed={len(confirmed['confirmed'])} sent={len(sent['sent'])} "
                         f"asked={len(asked)}"))
    return out
