"""人工门与定价 AC（T-110）：AC-PRICE-001、AC-APPROVE-001、AC-APPROVE-002。"""

from __future__ import annotations

import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.approval import (AgentCannotApprove, ApprovalRequired, ApprovalService,
                                UnknownApproval)
from ..services.commitments import CommitmentError, CommitmentGate
from ..services.costmodel import CostLibrary, CostModelService
from ..services.pricing import PriceNotConfirmed, PricingService
from .registry import Assertion, register

# AC 侧独立声明的流水线阶段顺序（与被测实现的常量无关）
PIPELINE_STAGES = ("cost_baseline", "market_reference", "strategy_markup", "risk_reserve", "band_check")

SUPPLIER_REALM = "supplier:sup-A"

ITEMS = [{"item_id": "L-001", "unit": "m", "qty": 120, "spec_refs": ["spec://piping/DN100"]}]

LIBRARY = {"L-001": {"material": {"unit_rate": 42.0, "unit": "m"},
                     "labour": {"unit_rate": 18.0, "unit": "m"},
                     "plant": {"unit_rate": 6.0, "unit": "m"},
                     "overhead_pct": 8.0, "risk_pct": 3.0, "finance_pct": 1.5, "tax_pct": 13.0}}

POLICY = {"markup_pct": 12.0, "risk_reserve_pct": 3.0,
          "authorized_band": {"min_unit_price": 80.0, "max_unit_price": 100.0},
          "market_reference": {"L-001": 10500.0}}


def _stack(tmp_name: str):
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "supplier.jsonl", realm=SUPPLIER_REALM)
    bus = EventBus()
    bus.install_defaults()
    approval = ApprovalService(ledger=ledger, events=bus, actor="agent:approval")
    cost = CostModelService(realm=SUPPLIER_REALM, library=CostLibrary(LIBRARY), ledger=ledger,
                            events=bus, store_root=root / "private")
    pricing = PricingService(cost_service=cost, policy=POLICY, ledger=ledger, events=bus,
                             approval=approval, actor="agent:price")
    gate = CommitmentGate(approval=approval, ledger=ledger, events=bus, actor="agent:commitment",
                          pricing=pricing)
    pricing.build_cost(ITEMS, quote_id="q-0007")
    return root, ledger, bus, approval, cost, pricing, gate


@register("AC-PRICE-001", "P0", "定价产出为 Intent；越界无条件请求批准；最终数字需人确认",
          "qa ac AC-PRICE-001", evidence_refs=("EV-025",))
def ac_price_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, approval, cost, pricing, gate = _stack("price-001")

    proposal = pricing.price(quote_id="q-0007", item_id="L-001")
    events = ledger.read(type="quote/price-proposed")
    out.append(Assertion("定价产出为 Intent（账本事件 class=intent，不是承诺）",
                         events and events[0]["class"] == "intent"
                         and proposal["status"] in ("proposed", "awaiting_approval"),
                         f"class={events[0]['class'] if events else None} status={proposal['status']}"))
    # 手算：L-001 不含税单位成本 8938.512/120 = 74.4876 → 12% 加价 = 8.938512 →
    #       83.426112 → 3% 风险准备金 = 2.50278336 → 85.92889536（授权区间 [80, 100] → 区间内）
    out.append(Assertion("定价按流水线给出（成本基线 → 市场参考 → 策略加价 → 风险准备金），各阶段可查",
                         abs(proposal["cost_baseline"] - 74.4876) < 1e-6
                         and abs(proposal["markup_amount"] - 74.4876 * 0.12) < 1e-6
                         and abs(proposal["proposed_price"] - 74.4876 * 1.12 * 1.03) < 1e-6
                         and proposal["market_reference"] == 10500.0
                         and [s["stage"] for s in proposal["stages"]] == list(PIPELINE_STAGES),
                         f"baseline={proposal['cost_baseline']} markup={proposal['markup_amount']} "
                         f"price={proposal['proposed_price']} stages={[s['stage'] for s in proposal['stages']]}"))

    # 越界：把策略加价提到 40% → 74.4876*1.4*1.03 = 107.4… 超出授权区间上限 100
    pricing.set_policy(dict(POLICY, markup_pct=40.0))
    out_of_band = pricing.price(quote_id="q-0007", item_id="L-001")
    out.append(Assertion("越界（超授权区间）无条件请求批准，且状态为待批（不得直接产出可提交价格）",
                         out_of_band["in_band"] is False
                         and out_of_band["status"] == "awaiting_approval"
                         and bool(out_of_band["approval_id"])
                         and any(a["approval_id"] == out_of_band["approval_id"]
                                 for a in approval.pending()),
                         f"in_band={out_of_band['in_band']} status={out_of_band['status']} "
                         f"price={out_of_band['proposed_price']} approval={out_of_band['approval_id']}"))

    agent_confirm = None
    try:
        pricing.confirm(out_of_band["proposal_id"], by="agent:price")
    except AgentCannotApprove as exc:
        agent_confirm = exc
    out.append(Assertion("最终数字不能由 agent 确认（代签被拒绝）",
                         agent_confirm is not None and pricing.get(out_of_band["proposal_id"])["final_price"] is None,
                         f"error={agent_confirm}"))

    unconfirmed_commit = None
    try:
        gate.submit_quote({"quote_id": "q-0007", "lines": [{"item_id": "L-001", "unit_price": 84.17, "qty": 120}]},
                          proposed_price_ref=out_of_band["proposal_id"])
    except PriceNotConfirmed as exc:
        unconfirmed_commit = exc
    out.append(Assertion("未经人确认的定价结果不得进入提交路径（人工门前置）",
                         unconfirmed_commit is not None, f"error={unconfirmed_commit}"))

    approval.decide(out_of_band["approval_id"], by="human:zhang", decision="granted",
                    comment="同意本次加价")
    confirmed = pricing.confirm(out_of_band["proposal_id"], by="human:zhang")
    out.append(Assertion("人确认后最终数字落定，且落账 quote/human-approved",
                         confirmed["status"] == "human_confirmed"
                         and confirmed["final_price"] == out_of_band["proposed_price"]
                         and confirmed["confirmed_by"] == "human:zhang"
                         and len(ledger.read(type="quote/human-approved")) == 1,
                         f"status={confirmed['status']} final={confirmed['final_price']} "
                         f"approved_events={len(ledger.read(type='quote/human-approved'))}"))

    pricing.set_policy(POLICY)   # 恢复原策略，验证门只在越界时触发
    in_band_again = pricing.price(quote_id="q-0007", item_id="L-001")
    out.append(Assertion("区间内的定价不需要人工门（门只在越界时强制触发）",
                         in_band_again["in_band"] is True and in_band_again["approval_id"] is None
                         and in_band_again["status"] == "proposed",
                         f"in_band={in_band_again['in_band']} approval={in_band_again['approval_id']}"))
    return out


@register("AC-APPROVE-001", "P0", "批准记录只能由人产生；以 agent 身份签署被拒绝",
          "qa ac AC-APPROVE-001", evidence_refs=("EV-026",))
def ac_approve_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, approval, cost, pricing, gate = _stack("approve-001")

    request = approval.request("quote.submit", {"quote_id": "q-0007", "amount": 84.17 * 120},
                               ref="q-0007", reason="提交报价")
    out.append(Assertion("批准请求可创建、可查、带 scope 与业务引用",
                         request["status"] == "pending" and request["scope"] == "quote.submit"
                         and request["ref"] == "q-0007" and request["payload_hash"].startswith("sha256:"),
                         f"request={json.dumps(request, ensure_ascii=False)[:200]}"))

    agent_try = None
    try:
        approval.decide(request["approval_id"], by="agent:price", decision="granted")
    except AgentCannotApprove as exc:
        agent_try = exc
    record = approval.get(request["approval_id"])
    out.append(Assertion("agent 身份签署被拒绝，且记录仍为待批（不留半条批准）",
                         agent_try is not None and record["status"] == "pending"
                         and ledger.read(type="approval/granted") == [],
                         f"error={agent_try} status={record['status']}"))

    denied = approval.decide(request["approval_id"], by="human:lisi", decision="denied",
                             comment="单价偏高，要求重新核算")
    out.append(Assertion("人可以拒绝，拒绝也留痕（approval/denied）",
                         denied["status"] == "denied" and len(ledger.read(type="approval/denied")) == 1,
                         f"status={denied['status']}"))

    second = approval.request("quote.submit", {"quote_id": "q-0007-1"}, ref="q-0007-1", reason="重新提交")
    granted = approval.decide(second["approval_id"], by="human:zhang", decision="granted")
    out.append(Assertion("人批准后记录带批准人与时间，并落账 approval/granted",
                         granted["status"] == "granted" and granted["decided_by"] == "human:zhang"
                         and granted["decided_at"] and len(ledger.read(type="approval/granted")) == 1,
                         f"granted={json.dumps(granted, ensure_ascii=False)[:220]}"))

    chain_q0007 = approval.chain("q-0007")
    chain_new = approval.chain("q-0007-1")
    out.append(Assertion("批准链按业务引用逐条查回（谁在何时批了什么），两个引用互不串台",
                         len(chain_q0007) == 1 and chain_q0007[0]["status"] == "denied"
                         and chain_q0007[0]["decided_by"] == "human:lisi"
                         and len(chain_new) == 1 and chain_new[0]["status"] == "granted"
                         and chain_new[0]["decided_by"] == "human:zhang"
                         and len(approval.records()) == 2,
                         f"chain(q-0007)={[(c['approval_id'], c['status']) for c in chain_q0007]} "
                         f"chain(q-0007-1)={[(c['approval_id'], c['status']) for c in chain_new]}"))

    unknown = None
    try:
        approval.decide("ap-9999", by="human:zhang", decision="granted")
    except UnknownApproval as exc:
        unknown = exc
    out.append(Assertion("不存在的批准记录不可被签署（防伪造引用）", unknown is not None, f"error={unknown}"))
    out.append(Assertion("不存在任何绕过途径：批准必须经 request→decide（human），账本链完整",
                         ledger.verify_chain() and len(ledger.read(type="approval/requested")) == 2,
                         f"requested={len(ledger.read(type='approval/requested'))} "
                         f"chain={ledger.verify_chain()}"))
    return out


@register("AC-APPROVE-002", "P0", "无批准记录时提交报价/授标承诺/发 PO 三条路径全部抛错（INV-005）",
          "qa ac AC-APPROVE-002", evidence_refs=("EV-027",))
def ac_approve_002() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, approval, cost, pricing, gate = _stack("approve-002")

    quote = {"quote_id": "q-0007", "package_id": "pkg-014", "rfq_rev": 1,
             "lines": [{"item_id": "L-001", "unit_price": 84.17, "qty": 120}], "currency": "CNY"}
    intent = {"intent_id": "ai-0001", "package_id": "pkg-014", "quote_id": "q-0007"}
    po_lines = [{"item_id": "L-001", "qty": 120, "unit_price": 84.17}]

    errors: dict[str, str] = {}
    for name, call in (("submit_quote", lambda: gate.submit_quote(quote)),
                       ("commit_award", lambda: gate.commit_award(intent, supplier_confirmed=True)),
                       ("issue_po", lambda: gate.issue_po("ai-0001", po_lines))):
        try:
            call()
            errors[name] = ""
        except ApprovalRequired as exc:
            errors[name] = str(exc)
    out.append(Assertion("无批准记录时三条对外承诺路径全部抛错（INV-005 / 规则 3）",
                         all(errors.values()), f"errors={errors}"))
    out.append(Assertion("三条路径失败时都不落账（没有既成事实）",
                         ledger.read(type="quote/submitted") == []
                         and ledger.read(type="award/committed") == []
                         and ledger.read(type="po/issued") == [],
                         f"submitted={len(ledger.read(type='quote/submitted'))} "
                         f"committed={len(ledger.read(type='award/committed'))} "
                         f"po={len(ledger.read(type='po/issued'))}"))

    fake = None
    try:
        gate.submit_quote(quote, approval_id="ap-fake")
    except (UnknownApproval, ApprovalRequired) as exc:
        fake = exc
    out.append(Assertion("伪造的批准引用被拒绝（批准必须落在账本里）", fake is not None, f"error={fake}"))

    quote_approval = approval.request("quote.submit", {"quote_id": "q-0007"}, ref="q-0007")
    approval.decide(quote_approval["approval_id"], by="human:zhang", decision="granted")
    submitted = gate.submit_quote(quote, approval_id=quote_approval["approval_id"])
    out.append(Assertion("有批准后提交报价成功并落账 quote/submitted（门不是装饰）",
                         submitted["quote_id"] == "q-0007" and len(ledger.read(type="quote/submitted")) == 1,
                         f"submitted={submitted}"))

    cross_scope = None
    try:
        gate.commit_award(intent, supplier_confirmed=True, approval_id=quote_approval["approval_id"])
    except ApprovalRequired as exc:
        cross_scope = exc
    out.append(Assertion("批准绑定 scope：报价批准不能复用到授标承诺（FR-APPROVE-002）",
                         cross_scope is not None, f"error={cross_scope}"))

    not_confirmed = None
    award_approval = approval.request("award.commit", {"intent_id": "ai-0001"}, ref="ai-0001")
    approval.decide(award_approval["approval_id"], by="human:zhang", decision="granted")
    try:
        gate.commit_award(intent, supplier_confirmed=False, approval_id=award_approval["approval_id"])
    except CommitmentError as exc:
        not_confirmed = exc
    out.append(Assertion("授标承诺缺供应商确认即抛错（缺一即不可承诺）",
                         not_confirmed is not None, f"error={not_confirmed}"))

    committed = gate.commit_award(intent, supplier_confirmed=True,
                                  approval_id=award_approval["approval_id"])
    po_approval = approval.request("po.issue", {"award_id": committed["award_id"]}, ref=committed["award_id"])
    approval.decide(po_approval["approval_id"], by="human:zhang", decision="granted")
    po = gate.issue_po(committed["award_id"], po_lines, approval_id=po_approval["approval_id"])
    out.append(Assertion("有批准 + 供应商确认后授标承诺与 PO 依次成立（PO 由承诺派生）",
                         committed["status"] == "committed" and po["award_id"] == committed["award_id"]
                         and len(ledger.read(type="award/committed")) == 1
                         and len(ledger.read(type="po/issued")) == 1,
                         f"award={committed['award_id']} po={po['po_id']}"))

    orphan_approval = approval.request("po.issue", {"award_id": "ai-9999"}, ref="ai-9999")
    approval.decide(orphan_approval["approval_id"], by="human:zhang", decision="granted")
    orphan = None
    try:
        gate.issue_po("ai-9999", po_lines, approval_id=orphan_approval["approval_id"])
    except CommitmentError as exc:
        orphan = exc
    out.append(Assertion("PO 不能手工另建（即便有批准，未知承诺 → 抛错，FR-AWARD-002 的 P0 子集）",
                         orphan is not None, f"error={orphan}"))
    return out
