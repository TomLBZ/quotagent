"""对外承诺的唯一出口（`AGENTS.md` 规则 3 / INV-005）。

三条承诺路径——**提交报价 / 授标承诺 / 发 PO**——都必须先过 `ctx.approval` 的人工门；
这里没有旁路：每次调用都要拿到有效批准记录（scope + 业务引用都匹配），否则抛 `ApprovalRequired`。
`PriceProposal` 只有在人工确认最终数字之后才允许进入提交路径（FR-PRICE-002）。
"""

from __future__ import annotations

from typing import Any

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now
from .approval import ApprovalRequired, ApprovalService
from .pricing import PriceNotConfirmed

QUOTE_SUBMITTED_EVENT = "quote/submitted"
AWARD_COMMITTED_EVENT = "award/committed"
PO_ISSUED_EVENT = "po/issued"

SCOPE_QUOTE_SUBMIT = "quote.submit"
SCOPE_AWARD_COMMIT = "award.commit"
SCOPE_PO_ISSUE = "po.issue"


class CommitmentError(RuntimeError):
    """承诺路径错误（缺确认、缺派生依据等）。"""


class CommitmentGate:
    def __init__(self, *, approval: ApprovalService, ledger: Ledger | None = None,
                 events: EventBus | None = None, actor: str = "agent:commitment",
                 pricing: Any = None) -> None:
        self.approval = approval
        self.ledger = ledger
        self.events = events
        self.actor = actor
        self.pricing = pricing
        self._awards: dict[str, dict] = {}
        self._quotes: dict[str, dict] = {}
        self._po_counter = 0

    # --- 1. 提交报价 -------------------------------------------------------
    def submit_quote(self, quote: dict, *, approval_id: str | None = None,
                     proposed_price_ref: str | None = None) -> dict:
        quote_id = quote.get("quote_id")
        if not quote_id:
            raise CommitmentError("报价必须有 quote_id")
        if proposed_price_ref is not None:
            if self.pricing is None or not self.pricing.is_confirmed(proposed_price_ref):
                raise PriceNotConfirmed(
                    f"定价建议 {proposed_price_ref} 尚未获得人确认，不得提交（FR-PRICE-002 / 规则 3）")
        approval = self.approval.require(scope=SCOPE_QUOTE_SUBMIT, ref=quote_id,
                                         approval_id=approval_id)
        record = {"quote_id": quote_id, "package_id": quote.get("package_id"),
                  "rfq_rev": quote.get("rfq_rev"), "currency": quote.get("currency"),
                  "lines": quote.get("lines", []), "approval_id": approval["approval_id"],
                  "approved_by": approval["decided_by"],
                  "proposal_ref": proposed_price_ref, "submitted_at": utc_now()}
        self._quotes[quote_id] = record
        ref = self._append(QUOTE_SUBMITTED_EVENT, record, event_class="fact", ref=quote_id)
        return {"quote_id": quote_id, "approval_id": approval["approval_id"],
                "approved_by": approval["decided_by"], "submitted_at": record["submitted_at"],
                "ledger_ref": ref}

    # --- 2. 授标承诺 -------------------------------------------------------
    def commit_award(self, intent: dict, *, supplier_confirmed: bool,
                     approval_id: str | None = None) -> dict:
        intent_id = intent.get("intent_id")
        if not intent_id:
            raise CommitmentError("授标意向必须有 intent_id")
        if not supplier_confirmed:
            raise CommitmentError(
                "授标承诺需要供应商确认（award/confirmed）：意向可撤回，承诺不可凭空产生（FR-AWARD-002）")
        approval = self.approval.require(scope=SCOPE_AWARD_COMMIT, ref=intent_id,
                                         approval_id=approval_id)
        award_id = f"aw-{len(self._awards) + 1:04d}"
        record = {"award_id": award_id, "intent_id": intent_id,
                  "package_id": intent.get("package_id"), "quote_id": intent.get("quote_id"),
                  "approved_by": approval["decided_by"], "approval_id": approval["approval_id"],
                  "supplier_confirmed": True, "committed_at": utc_now()}
        self._awards[award_id] = record
        self._append(AWARD_COMMITTED_EVENT, record, event_class="commitment", ref=intent_id)
        return {"award_id": award_id, "status": "committed", "approval_id": approval["approval_id"],
                "approved_by": approval["decided_by"]}

    # --- 3. 发 PO（只能由承诺派生） ---------------------------------------
    def issue_po(self, award_id: str, lines: list[dict], *,
                 approval_id: str | None = None) -> dict:
        self.approval.require(scope=SCOPE_PO_ISSUE, ref=award_id, approval_id=approval_id)
        award = self._awards.get(award_id)
        if award is None:
            raise CommitmentError(
                f"PO 只能由 AwardCommitment 派生：{award_id!r} 不是本侧已成立的承诺（不得手工另建）")
        self._po_counter += 1
        record = {"po_id": f"po-{self._po_counter:04d}", "award_id": award_id,
                  "quote_id": award.get("quote_id"), "lines": lines, "issued_at": utc_now()}
        self._append(PO_ISSUED_EVENT, record, event_class="commitment", ref=award_id)
        return {"po_id": record["po_id"], "award_id": award_id, "line_count": len(lines),
                "issued_at": record["issued_at"]}

    # --- 内部 -------------------------------------------------------------
    def awards(self) -> list[dict]:
        return list(self._awards.values())

    def _append(self, event: str, body: dict, *, event_class: str, ref: str) -> dict | None:
        if self.ledger is None:
            return None
        record = self.ledger.append(event, body, correlation_id=ref, event_class=event_class,
                                    actor=self.actor, refs={"ref": ref})
        if self.events is not None and self.events.mode_of(event) is not None:
            self.events.emit(event, {"ref": ref, "event": event})
        return record.as_dict()
