"""AC-TERMS-001：条款库与冲突标注（T-211）。"""

import json

from quotagent.kernel.events import EventBus
from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch
from quotagent.services.approval import ApprovalService
from quotagent.services.guard import GuardService
from quotagent.services.terms import TermLibrary
from quotagent.qa.registry import Assertion, register

@register("AC-TERMS-001", "P1", "条款库版本化与默认条款；冲突并列双方值并提请人工，绝不静默取其一",
          "qa ac AC-TERMS-001", evidence_refs=("EV-050",))
def check_terms_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("terms-001")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    library = TermLibrary(ledger=ledger, events=bus)

    library.define("payment_terms", "days", 45, version=1, effective_from="2026-01-01T00:00:00Z",
                   source="bundle:industry-3pl", note="基线")
    library.define("payment_terms", "advance_pct", 0, version=1, effective_from="2026-01-01T00:00:00Z",
                   source="bundle:industry-3pl")
    library.define("warranty_terms", "months", 24, version=1, effective_from="2026-01-01T00:00:00Z",
                   source="bundle:industry-3pl")
    library.revise("payment_terms", "days", 30, effective_from="2026-06-01T00:00:00Z",
                   source="human:zhang", note="现金流收紧")
    as_of_march = library.library(as_of="2026-03-01T00:00:00Z")
    as_of_now = library.library(as_of="2026-09-01T00:00:00Z")
    out.append(Assertion("版本化：`as_of` 取当时生效版本（3 月→45 天，9 月→30 天），旧版本保留不删",
                         as_of_march["payment_terms"]["days"]["value"] == 45
                         and as_of_now["payment_terms"]["days"]["value"] == 30
                         and as_of_now["payment_terms"]["days"]["version"] == 2
                         and as_of_march["payment_terms"]["days"]["version"] == 1,
                         f"march={as_of_march['payment_terms']['days']} now={as_of_now['payment_terms']['days']}"))
    dup = None
    try:
        library.define("payment_terms", "days", 15, version=1, source="human:zhang")
    except Exception as err:  # noqa: BLE001
        dup = str(err)
    missing = None
    try:
        library.revise("penalty_terms", "cap_pct", 5)
    except Exception as err:  # noqa: BLE001
        missing = str(err)
    out.append(Assertion("版本护栏：同版本重复载入被拒；未定义基线就修订被拒（修订只能基于既有版本）",
                         dup is not None and "版本已存在" in dup and missing is not None
                         and "未定义" in missing,
                         f"dup={dup} revise={missing}"))
    agent_write = None
    try:
        library.define("payment_terms", "days", 7, version=3, source="agent:planner")
    except Exception as err:  # noqa: BLE001
        agent_write = str(err)
    out.append(Assertion("基线来源：`agent:*` 不能载入/修订条款基线（只有 human:/bundle: 可以）",
                         agent_write is not None and "human:" in agent_write,
                         f"error={agent_write}"))

    defaults = library.apply_defaults({"payment_terms": {"days": 60}}, as_of="2026-09-01T00:00:00Z")
    applied_keys = {(item["family"], item["key"]) for item in defaults["applied"]}
    out.append(Assertion("默认条款只补**缺失键**：供应商已给的 days=60 不动，只补入 advance_pct 与质保月数",
                         defaults["terms"]["payment_terms"]["days"] == 60
                         and ("payment_terms", "advance_pct") in applied_keys
                         and ("warranty_terms", "months") in applied_keys
                         and ("payment_terms", "days") not in applied_keys,
                         f"applied={sorted(applied_keys)} days={defaults['terms']['payment_terms']['days']}"))
    out.append(Assertion("补入项显式标 `source=library-default`（默认条款不得冒充供应商承诺）",
                         all(item["source"] == "library-default" and item["version"] >= 1
                             for item in defaults["applied"]),
                         f"applied={json.dumps(defaults['applied'], ensure_ascii=False)[:160]}"))
    out.append(Assertion("默认条款补入落账 `terms/applied`（模型可见 ⟺ 账本可见）",
                         len(ledger.read(type="terms/applied")) == 1
                         and ledger.read(type="terms/applied")[0]["body"]["applied_count"] >= 1,
                         f"rows={len(ledger.read(type='terms/applied'))}"))

    required = {"payment_terms": {"days": 30, "advance_pct": 0},
                "warranty_terms": {"months": 24},
                "penalty_terms": {"cap_pct": 5, "late_pct_per_week": 0.5}}   # 库不认识的键，双方不一致
    offered = {"payment_terms_offered": {"days": 60, "advance_pct": 40},   # 交换协议里的别名写法
               "warranty_terms": {"months": 24},                            # 一致 → 不报
               "penalty_terms": {"cap_pct": 5, "late_pct_per_week": 0.7}}   # 库不认识的键且值不一致
    conflicts = library.conflicts(required, offered, quote_id="q-0007", as_of="2026-09-01T00:00:00Z")
    by_key = {(item["family"], item["key"]): item for item in conflicts}
    out.append(Assertion("族名别名被识别：`payment_terms_offered` 按同一族比对（判为不一致，而非「单侧缺失」）",
                         by_key[("payment_terms", "days")]["status"] == "mismatch"
                         and by_key[("payment_terms", "advance_pct")]["status"] == "mismatch",
                         f"days={by_key[('payment_terms','days')]['status']}"))
    out.append(Assertion("双方一致不报（质保 24=24）；库不认识且双方不一致的键报 `unknown_key` 并提请人工",
                         ("warranty_terms", "months") not in by_key
                         and by_key[("penalty_terms", "late_pct_per_week")]["status"] == "unknown_key"
                         and by_key[("penalty_terms", "late_pct_per_week")]["requires_human"] is True,
                         f"keys={sorted(by_key)}"))
    out.append(Assertion("**绝不静默取其一**：每条冲突 `resolution` 为 None、`requires_human` 为真，"
                         "且条目里不存在任何「胜出值」字段（value/winner/chosen/merged）",
                         all(item["resolution"] is None and item["requires_human"] is True for item in conflicts)
                         and not any(key in item for item in conflicts
                                     for key in ("value", "winner", "chosen", "merged", "resolved_value")),
                         f"keys={sorted({key for item in conflicts for key in item})}"))

    single = library.conflicts({"warranty_terms": {"months": 24}}, {"warranty_terms": {"months": 36}})
    approvals = ApprovalService(ledger=ledger, events=bus)
    none_request = library.escalate(single, approvals=approvals, ref="q-x", approvers=["human:zhang"])
    block = library.escalate(conflicts, approvals=approvals, ref="q-0007", approvers=["human:zhang"])
    out.append(Assertion("冲突提请人工门：`terms.resolve` 待批且 `approval/granted` 为空（不会自动裁定）",
                         block is not None and block["scope"] == "terms.resolve"
                         and len(ledger.read(type="approval/granted")) == 0
                         and "term_conflict" in json.dumps(block["flags"], ensure_ascii=False)
                         and none_request is not None,
                         f"scope={block and block['scope']} flags={block and block['flags']}"))
    out.append(Assertion("信息项（仅一侧给出）不产生批准请求：只有 `mismatch`/`unknown_key` 才送人工门",
                         library.escalate(library.conflicts({"payment_terms": {"days": 30}}, {}),
                                          approvals=approvals, ref="q-y",
                                          approvers=["human:zhang"]) is None,
                         "信息项产生了批准请求"))
    conflict_rows = [row for row in ledger.read(type="terms/conflict")
                     if row["body"].get("quote_id") == "q-0007"]
    out.append(Assertion("冲突逐条落账 `terms/conflict`，且带并列双方值（审计可复核；只数本次引用的报文体）",
                         len(conflict_rows) == len(conflicts)
                         and all("required" in row["body"] and "offered" in row["body"]
                                 and row["body"]["resolution"] is None
                                 for row in conflict_rows),
                         f"rows={len(conflict_rows)} conflicts={len(conflicts)}"))

    guard = GuardService(ledger=ledger, events=bus, terms=library)
    flags = [flag for flag in guard.check({"package": {"package_id": "pkg-014", "rev": 1, **required},
                                          "quotes": [{"quote_id": "q-0007", **offered}]})
             if flag["kind"] == "term_conflict"]
    guard_keys = {(flag["family"], key) for flag in flags for key in flag["diffs"]}
    library_keys = {(item["family"], item["key"]) for item in conflicts}
    out.append(Assertion("护栏与条款库同一套差异口径（guard 的族级 Flag 键集合 == 库的冲突键集合）",
                         guard_keys == library_keys and len(flags) == 2,
                         f"guard={sorted(guard_keys)} library={sorted(library_keys)} flags={len(flags)}"))
    return out
