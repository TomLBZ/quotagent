"""AC-CHANGE-001/002：变更闭环与生效版本（T-212）。"""

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.approval import ApprovalService
from ..services.change import ChangeService
from .registry import Assertion, register

QUOTE = {"quote_id": "q-0007", "rfq_rev": 2,
         "lines": [{"item_id": "L-001", "qty": 100, "unit_price": 88.5},
                   {"item_id": "L-002", "qty": 50, "unit_price": 12.0}]}


def _fixture(name: str):
    root = new_scratch(name)
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    approvals = ApprovalService(ledger=ledger, events=bus)
    service = ChangeService(ledger=ledger, events=bus, approvals=approvals)
    return ledger, bus, approvals, service


@register("AC-CHANGE-001", "P1", "变更请求必须引用原报价条目与单价基准，缺引用或引用不可验证即拒绝",
          "qa ac AC-CHANGE-001", evidence_refs=("EV-051",))
def check_change_001() -> list[Assertion]:
    out: list[Assertion] = []
    ledger, bus, approvals, service = _fixture("change-001")
    bus.install_defaults()

    def _code(deltas: list[dict]) -> str:
        try:
            service.propose(QUOTE, deltas, reason="探针")
        except Exception as err:  # noqa: BLE001
            return getattr(err, "code", "?")
        return "accepted"

    good = {"ref_line": "L-001", "new_qty": 130, "basis_unit_price_ref": "q-0007#L-001:unit_price"}
    checks = {
        "missing-line-ref": [{"new_qty": 130, "basis_unit_price_ref": "q-0007#L-001:unit_price"}],
        "missing-basis-ref": [{"ref_line": "L-001", "new_qty": 130}],
        "unknown-line": [{**good, "ref_line": "L-404"}],
        "basis-mismatch": [{**good, "basis_unit_price": 91.0}],
        "empty-delta": [],
    }
    codes = {want: _code(deltas) for want, deltas in checks.items()}
    out.append(Assertion("缺引用即拒绝：缺 `ref_line` / 缺 `basis_unit_price_ref` / 引用不存在的条目 / "
                         "空 delta 各有明确拒绝码",
                         codes == {name: name for name in checks},
                         f"codes={codes}"))
    out.append(Assertion("引用必须**可验证**：基准引用指向别的条目、或提议采用的基准值与原报价不符（过期基准）"
                         "都拒绝（不是「有个字符串就算引用」）",
                         codes["basis-mismatch"] == "basis-mismatch"
                         and _code([{**good, "basis_unit_price_ref": "q-0007#L-002:unit_price"}]) == "basis-mismatch",
                         f"stale={codes['basis-mismatch']}"))
    rejected_rows = ledger.read(type="change/rejected")
    out.append(Assertion("每次拒绝都留痕 `change/rejected`（含拒绝码与原因），且**不落** `change/proposed`",
                         len(rejected_rows) == 6
                         and all(row["body"]["code"] in {"missing-line-ref", "missing-basis-ref",
                                                         "unknown-line", "basis-mismatch", "empty-delta"}
                                 for row in rejected_rows)
                         and ledger.read(type="change/proposed") == [],
                         f"rejected={len(rejected_rows)} proposed={len(ledger.read(type='change/proposed'))}"))
    accepted = service.propose(QUOTE, [good], reason="客户追加 30 m")
    out.append(Assertion("合法变更被采纳：`change/proposed` 带 `ref_quote_lines`/`basis_unit_price_ref`/`delta`，"
                         "`change/priced` 带按原单价算出的差额",
                         accepted["ref_quote_lines"] == ["L-001"]
                         and accepted["basis_unit_price_ref"] == "q-0007#L-001:unit_price"
                         and accepted["basis_unit_price_refs"] == ["q-0007#L-001:unit_price"]
                         and len(ledger.read(type="change/proposed")) == 1
                         and ledger.read(type="change/priced")[0]["body"]["delta_amount"] == 2655.0
                         and ledger.read(type="change/priced")[0]["body"]["basis"].startswith("原报价单价"),
                         f"delta={ledger.read(type='change/priced')[0]['body']['delta_amount']}"))
    out.append(Assertion("未被拒绝的请求不产生拒绝事件（拒绝留痕只对应真实拒绝）",
                         len(ledger.read(type="change/rejected")) == 6
                         and accepted["status"] == "proposed" and accepted["approved_by"] is None,
                         f"rejected={len(ledger.read(type='change/rejected'))} status={accepted['status']}"))
    return out


@register("AC-CHANGE-002", "P1", "变更差额按原单价可复算；未经批准的变更不影响任何金额；人工批准后生效",
          "qa ac AC-CHANGE-002", evidence_refs=("EV-051",))
def check_change_002() -> list[Assertion]:
    out: list[Assertion] = []
    ledger, bus, approvals, service = _fixture("change-002")

    # 手算：L-001 100→130 只改量 → 30×88.5 = 2655；L-002 50→40 且单价 12.0→13.5 → 40×13.5−50×12.0 = −60
    change = service.propose(QUOTE, [
        {"ref_line": "L-001", "new_qty": 130, "basis_unit_price_ref": "q-0007#L-001:unit_price"},
        {"ref_line": "L-002", "new_qty": 40, "new_unit_price": 13.5,
         "basis_unit_price_ref": "q-0007#L-002:unit_price"}], reason="追加 30 m，同时改单价")
    out.append(Assertion("差额逐行按**原报价单价**复算：只改量按原单价增量，改价按新旧差价结算"
                         "（手算 30×88.5=2655 与 40×13.5−50×12.0=−60，合计 2595）",
                         change["delta_amount"] == 2595.0
                         and [item["line_delta"] for item in change["lines"]] == [2655.0, -60.0],
                         f"delta={change['delta_amount']} lines={[item['line_delta'] for item in change['lines']]}"))
    recomputed = service.recompute(change["change_id"], QUOTE)
    out.append(Assertion("复算可重放：用同一报价重算，逐行与合计都与提议时一致（`reproducible`）",
                         recomputed["reproducible"] is True
                         and recomputed["delta_amount"] == change["delta_amount"],
                         f"reproducible={recomputed['reproducible']} total={recomputed['delta_amount']}"))
    out.append(Assertion("基准过期即复算失败（用改动后的报价复算 → 拒绝，不给出静默错误的数字）",
                         _recompute_rejects(service, change["change_id"]),
                         "过期基准未报错"))
    before = service.effective_total(QUOTE)
    out.append(Assertion("**未经批准的变更不影响任何金额**：`effective_total` 仍等于原报价合计 9450，"
                         "变更只出现在 `pending_changes` 里",
                         before["base_amount"] == 9450.0 and before["effective_amount"] == 9450.0
                         and before["approved_delta"] == 0.0
                         and before["pending_changes"] == [change["change_id"]]
                         and before["applied_changes"] == [],
                         f"total={before}"))
    out.append(Assertion("账本里此刻不存在 `change/approved`（金额未变不是因为没查账）",
                         ledger.read(type="change/approved") == [],
                         f"rows={len(ledger.read(type='change/approved'))}"))
    agent_try = None
    try:
        service.approve(change["change_id"], approved_by="agent:planner")
    except Exception as err:  # noqa: BLE001
        agent_try = str(err)
    no_gate = None
    try:
        service.approve(change["change_id"], approved_by="human:zhang")
    except Exception as err:  # noqa: BLE001
        no_gate = str(err)
    out.append(Assertion("生效只能由人：agent 自批被拒；**没有人工门批准记录**时即使声称 human 也拒绝（代签禁止）",
                         agent_try is not None and "人批准" in agent_try and no_gate is not None
                         and "缺少人工批准记录" in no_gate,
                         f"agent={agent_try} claim={no_gate}"))
    request = approvals.request("change.approve", {"change_id": change["change_id"]},
                                ref=change["change_id"], approvers=["human:zhang"],
                                reason="变更需批准")
    approvals.decide(request["approval_id"], by="human:zhang", decision="granted", comment="同意变更")
    approved = service.approve(change["change_id"], approved_by="human:zhang",
                               approval_id=request["approval_id"])
    after = service.effective_total(QUOTE)
    out.append(Assertion("人工批准后生效：落 `change/approved`（带 `delta_amount` 与 `approved_by`），"
                         "`effective_total` 变为 9450+2595=12045，变更进入 `applied_changes`",
                         approved["status"] == "approved" and after["effective_amount"] == 12045.0
                         and after["applied_changes"] == [change["change_id"]]
                         and after["pending_changes"] == []
                         and ledger.read(type="change/approved")[0]["body"]["approved_by"] == "human:zhang"
                         and ledger.read(type="change/approved")[0]["body"]["delta_amount"] == 2595.0,
                         f"after={after} rows={len(ledger.read(type='change/approved'))}"))
    before_rows = len(ledger.read(type="change/approved"))
    service.approve(change["change_id"], approved_by="human:zhang",
                    approval_id=request["approval_id"])
    out.append(Assertion("幂等：重复批准不重复落账、金额不再变化",
                         len(ledger.read(type="change/approved")) == before_rows
                         and service.effective_total(QUOTE)["effective_amount"] == 12045.0,
                         f"rows={len(ledger.read(type='change/approved'))}"))
    return out


def _recompute_rejects(service, change_id: str) -> bool:
    altered = {"quote_id": "q-0007", "rfq_rev": 2,
               "lines": [{"item_id": "L-001", "qty": 100, "unit_price": 91.0},
                         {"item_id": "L-002", "qty": 50, "unit_price": 12.0}]}
    try:
        service.recompute(change_id, altered)
        return False
    except Exception:  # noqa: BLE001
        return True
