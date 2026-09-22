"""AC-AWARD-001/002：授标意向、承诺与 PO 派生（T-213）。"""

from quotagent.kernel.events import EventBus
from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch
from quotagent.services.approval import ApprovalRequired, ApprovalService
from quotagent.services.commitments import CommitmentError, CommitmentGate
from quotagent.qa.registry import Assertion, register

QUOTE_LINES = [{"item_id": "L-001", "qty": 120, "unit_price": 84.17},
               {"item_id": "L-002", "qty": 40, "unit_price": 12.0}]


def _stack(name: str):
    root = new_scratch(name)
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    approval = ApprovalService(ledger=ledger, events=bus)
    gate = CommitmentGate(approval=approval, ledger=ledger, events=bus, actor="agent:commitment")
    return ledger, bus, approval, gate


def _grant(approval, scope: str, ref: str) -> str:
    request = approval.request(scope, {"ref": ref}, ref=ref, approvers=["human:zhang"])
    approval.decide(request["approval_id"], by="human:zhang", decision="granted", comment="同意")
    return request["approval_id"]


@register("AC-AWARD-001", "P0/P1", "意向可撤回且无义务（撤回后可复）；承诺缺供应商确认或缺人工签署即抛错",
          "qa ac AC-AWARD-001", evidence_refs=("EV-052",))
def check_award_001() -> list[Assertion]:
    out: list[Assertion] = []
    ledger, bus, approval, gate = _stack("award-001")

    first = gate.intent(package_id="pkg-014", quote_id="q-0007", lines=QUOTE_LINES,
                        reason="首轮授标意向")
    out.append(Assertion("授标意向落账 `award/intent-proposed`（intent 类）且显式声明无义务",
                         first["status"] == "proposed" and first["obligation"] is None
                         and len(ledger.read(type="award/intent-proposed")) == 1
                         and ledger.read(type="award/intent-proposed")[0]["body"]["note"].startswith("意向"),
                         f"status={first['status']} rows={len(ledger.read(type='award/intent-proposed'))}"))
    withdrawn = gate.withdraw(first["intent_id"], reason="客户改需求")
    out.append(Assertion("意向可撤回：落 `award/intent-withdrawn`，且撤回**不产生任何承诺**"
                         "（`award/committed` 为空、无义务）",
                         withdrawn["status"] == "withdrawn" and withdrawn["obligation"] is None
                         and len(ledger.read(type="award/intent-withdrawn")) == 1
                         and ledger.read(type="award/committed") == []
                         and ledger.read(type="po/issued") == [],
                         f"status={withdrawn['status']} committed={len(ledger.read(type='award/committed'))}"))
    stale = None
    try:
        gate.commit_award(first["intent_id"], supplier_confirmed=True,
                          approval_id=_grant(approval, "award.commit", first["intent_id"]))
    except CommitmentError as exc:
        stale = str(exc)
    out.append(Assertion("已撤回的意向不能被承诺（即便有批准 + 供应商确认）——`intent-not-active`",
                         stale is not None and "intent-not-active" in stale,
                         f"error={stale}"))
    second = gate.intent(package_id="pkg-014", quote_id="q-0007", lines=QUOTE_LINES, reason="复提")
    out.append(Assertion("撤回后可复：复提得到**新的**意向（新 id，旧意向保持 withdrawn 不改写）",
                         second["intent_id"] != first["intent_id"] and second["status"] == "proposed"
                         and gate.intents()[0]["status"] == "withdrawn"
                         and len(ledger.read(type="award/intent-proposed")) == 2,
                         f"first={first['intent_id']} second={second['intent_id']}"))

    no_confirm = None
    commit_approval = _grant(approval, "award.commit", second["intent_id"])
    try:
        gate.commit_award(second["intent_id"], supplier_confirmed=False, approval_id=commit_approval)
    except CommitmentError as exc:
        no_confirm = str(exc)
    out.append(Assertion("**缺供应商确认即抛错**（有批准也不行）：意向可撤回，承诺不可凭空产生",
                         no_confirm is not None and "供应商确认" in no_confirm
                         and ledger.read(type="award/committed") == [],
                         f"error={no_confirm}"))
    no_sign = None
    third = gate.intent(package_id="pkg-014", quote_id="q-0007", lines=QUOTE_LINES, reason="无批准探针")
    try:
        gate.commit_award(third["intent_id"], supplier_confirmed=True)
    except ApprovalRequired as exc:
        no_sign = str(exc)
    out.append(Assertion("**缺人工签署即抛错**（有供应商确认也不行，INV-005）",
                         no_sign is not None and "缺少人工批准记录" in no_sign,
                         f"error={no_sign}"))
    committed = gate.commit_award(second["intent_id"], supplier_confirmed=True, approval_id=commit_approval)
    out.append(Assertion("两者齐备才成立承诺：落 `award/committed`（commitment 类）且记下批准人与意图引用",
                         committed["status"] == "committed"
                         and len(ledger.read(type="award/committed")) == 1
                         and ledger.read(type="award/committed")[0]["body"]["intent_id"] == second["intent_id"]
                         and ledger.read(type="award/committed")[0]["body"]["supplier_confirmed"] is True
                         and ledger.read(type="award/committed")[0]["body"]["approved_by"].startswith("human:"),
                         f"committed={committed}"))
    out.append(Assertion("已成承诺的意向不可再撤回（承诺不是意向）",
                         _withdraw_rejects(gate, second["intent_id"]),
                         "已承诺意向被撤回"))
    return out


def _withdraw_rejects(gate, intent_id: str) -> bool:
    try:
        gate.withdraw(intent_id)
        return False
    except CommitmentError:
        return True


@register("AC-AWARD-002", "P1", "PO 只能由承诺派生（手工构造被拒）；PO 逐行可追溯到中标条目与单价基准",
          "qa ac AC-AWARD-002", evidence_refs=("EV-052",))
def check_award_002() -> list[Assertion]:
    out: list[Assertion] = []
    ledger, bus, approval, gate = _stack("award-002")
    intent = gate.intent(package_id="pkg-014", quote_id="q-0007", lines=QUOTE_LINES, reason="授标")
    committed = gate.commit_award(intent["intent_id"], supplier_confirmed=True,
                                  approval_id=_grant(approval, "award.commit", intent["intent_id"]))
    award_id = committed["award_id"]

    hand_built = None
    try:
        gate.issue_po("po-0001", [{"item_id": "L-001", "qty": 120, "unit_price": 84.17}])
    except CommitmentError as exc:
        hand_built = str(exc)
    out.append(Assertion("手工构造 PO 被拒绝：`award_id` 不是本侧承诺 → `po-not-derived`，"
                         "且在**批准检查之前**就报错（首条错误指向派生依据）",
                         hand_built is not None and "po-not-derived" in hand_built
                         and "不得手工另建" in hand_built,
                         f"error={hand_built}"))
    orphan = None
    try:
        gate.issue_po("ai-9999", [{"item_id": "L-001", "qty": 120, "unit_price": 84.17}],
                      approval_id=_grant(approval, "po.issue", "ai-9999"))
    except CommitmentError as exc:
        orphan = str(exc)
    out.append(Assertion("即便有匹配的批准记录，未知承诺也不能出 PO（批准不能替代派生依据）",
                         orphan is not None and "po-not-derived" in orphan,
                         f"error={orphan}"))
    unknown_line = None
    po_approval = _grant(approval, "po.issue", award_id)
    try:
        gate.issue_po(award_id, [{"ref_line": "L-404", "qty": 10}], approval_id=po_approval)
    except CommitmentError as exc:
        unknown_line = str(exc)
    out.append(Assertion("PO 行必须引用中标报价条目：引用不存在的条目 → `po-line-not-derived`",
                         unknown_line is not None and "po-line-not-derived" in unknown_line,
                         f"error={unknown_line}"))
    reprice = None
    try:
        gate.issue_po(award_id, [{"ref_line": "L-001", "qty": 120, "unit_price": 79.0}],
                      approval_id=po_approval)
    except CommitmentError as exc:
        reprice = str(exc)
    out.append(Assertion("PO 不得凭空改价：单价与中标价不一致 → `po-line-price-mismatch`",
                         reprice is not None and "po-line-price-mismatch" in reprice,
                         f"error={reprice}"))
    po = gate.issue_po(award_id, [{"ref_line": "L-001", "qty": 120, "unit_price": 84.17},
                                  {"ref_line": "L-002", "qty": 40}], approval_id=po_approval)
    chain = gate.trace(po["po_id"])
    out.append(Assertion("PO 由承诺派生并落账 `po/issued`：带 approval_id、意图引用与完整追溯链"
                         "（po → 承诺 → 意向 → 报价）",
                         po["award_id"] == award_id and po["intent_id"] == intent["intent_id"]
                         and po["quote_id"] == "q-0007" and po["line_count"] == 2
                         and chain["chain"] == f"po → {award_id} → {intent['intent_id']} → q-0007"
                         and len(ledger.read(type="po/issued")) == 1
                         and ledger.read(type="po/issued")[0]["body"]["approval_id"] == po_approval,
                         f"po={po} chain={chain['chain']}"))
    out.append(Assertion("逐行可追溯：每行带 `ref_line` 与单价基准引用，且单价与中标行逐行相等",
                         all(item["ref_line"] in ("L-001", "L-002")
                             and item["basis"] == f"q-0007#{item['ref_line']}:unit_price"
                             for item in chain["lines"])
                         and [item["unit_price"] for item in chain["lines"]] == [84.17, 12.0]
                         and chain["total_amount"] == round(120 * 84.17 + 40 * 12.0, 6),
                         f"lines={chain['lines']} total={chain['total_amount']}"))
    out.append(Assertion("PO 仍走人工门：无批准记录时不落账（`po/issued` 条数不变）",
                         _po_needs_approval(gate, ledger, approval),
                         "无批准也出了 PO"))
    return out


def _po_needs_approval(gate, ledger, approval) -> bool:
    """在一份**从未有过 PO 批准**的新承诺上验证：有派生依据但无批准时仍抛错。"""
    intent = gate.intent(package_id="pkg-014", quote_id="q-0007",
                         lines=QUOTE_LINES, reason="门禁探针")
    request = approval.request("award.commit", {"intent_id": intent["intent_id"]},
                               ref=intent["intent_id"])
    approval.decide(request["approval_id"], by="human:zhang", decision="granted")
    award = gate.commit_award(intent["intent_id"], supplier_confirmed=True,
                              approval_id=request["approval_id"])
    before = len(ledger.read(type="po/issued"))
    try:
        gate.issue_po(award["award_id"], [{"ref_line": "L-001", "qty": 1}])
    except ApprovalRequired:
        return len(ledger.read(type="po/issued")) == before
    return False
