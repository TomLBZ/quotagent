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
AWARD_INTENT_EVENT = "award/intent-proposed"
AWARD_WITHDRAWN_EVENT = "award/intent-withdrawn"
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
        self._intents: dict[str, dict] = {}
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

    # --- 1.5 授标意向（FR-AWARD-001：可撤回、可复、不产生义务） -------------
    def intent(self, *, package_id: str, quote_id: str, lines: list[dict] | None = None,
               valid_until: str | None = None, reason: str = "") -> dict:
        """提出授标意向：**不产生义务**（可撤回；撤回后可复，复得新意向）。"""
        intent_id = f"awin-{len(self._intents) + 1:04d}"
        record = {"intent_id": intent_id, "package_id": package_id, "quote_id": quote_id,
                  "lines": [dict(line) for line in (lines or [])], "status": "proposed",
                  "supplier_confirmed": False, "valid_until": valid_until, "reason": reason,
                  "proposed_at": utc_now(), "withdrawn_at": None, "obligation": None}
        self._intents[intent_id] = record
        self._append(AWARD_INTENT_EVENT, {**record, "note": "意向：不产生义务，可撤回"},
                     event_class="intent", ref=intent_id)
        return record

    def withdraw(self, intent_id: str, *, reason: str = "") -> dict:
        record = self._intents.get(intent_id)
        if record is None:
            raise CommitmentError(f"未知授标意向: {intent_id!r}")
        if record["status"] == "committed":
            raise CommitmentError(f"意向 {intent_id} 已成承诺，不可撤回（承诺不是意向）")
        record.update({"status": "withdrawn", "withdrawn_at": utc_now(), "withdraw_reason": reason})
        self._append(AWARD_WITHDRAWN_EVENT, {"intent_id": intent_id, "package_id": record["package_id"],
                                             "quote_id": record["quote_id"], "reason": reason,
                                             "note": "意向撤回：无义务；复提需新意向"},
                     event_class="intent", ref=intent_id)
        return {"intent_id": intent_id, "status": "withdrawn", "obligation": None,
                "withdrawn_at": record["withdrawn_at"]}

    def intents(self) -> list[dict]:
        return list(self._intents.values())

    # --- 2. 授标承诺 -------------------------------------------------------
    def commit_award(self, intent: dict | str, *, supplier_confirmed: bool,
                     approval_id: str | None = None) -> dict:
        if isinstance(intent, str):
            registry_entry = self._intents.get(intent)
            if registry_entry is None:
                raise CommitmentError(f"未知授标意向: {intent!r}")
            intent = registry_entry
        intent_id = intent.get("intent_id")
        if not intent_id:
            raise CommitmentError("授标意向必须有 intent_id")
        known = self._intents.get(intent_id)
        if known is not None and known["status"] != "proposed":
            raise CommitmentError(
                f"[intent-not-active] 意向 {intent_id} 当前状态为 {known['status']!r}，"
                f"只有 proposed 的意向才能被承诺（撤回的意向需重新提出）")
        if not supplier_confirmed:
            raise CommitmentError(
                "授标承诺需要供应商确认（award/confirmed）：意向可撤回，承诺不可凭空产生（FR-AWARD-002）")
        approval = self.approval.require(scope=SCOPE_AWARD_COMMIT, ref=intent_id,
                                         approval_id=approval_id)
        award_id = f"aw-{len(self._awards) + 1:04d}"
        record = {"award_id": award_id, "intent_id": intent_id,
                  "package_id": intent.get("package_id"), "quote_id": intent.get("quote_id"),
                  "lines": [dict(line) for line in (intent.get("lines") or [])],
                  "approved_by": approval["decided_by"], "approval_id": approval["approval_id"],
                  "supplier_confirmed": True, "committed_at": utc_now()}
        current = self._intents.get(intent_id)
        if current is not None:
            current.update({"status": "committed", "award_id": award_id})
        self._awards[award_id] = record
        self._append(AWARD_COMMITTED_EVENT, record, event_class="commitment", ref=intent_id)
        return {"award_id": award_id, "status": "committed", "approval_id": approval["approval_id"],
                "approved_by": approval["decided_by"]}

    # --- 3. 发 PO（只能由承诺派生） ---------------------------------------
    def issue_po(self, award_id: str, lines: list[dict], *,
                 approval_id: str | None = None) -> dict:
        """PO 只能由承诺派生（FR-AWARD-003）：**先判派生依据，再判批准**——首条错误指向最可行动的下一步。"""
        award = self._awards.get(award_id)
        if award is None:
            raise CommitmentError(
                f"[po-not-derived] PO 只能由 AwardCommitment 派生：{award_id!r} 不是本侧已成立的承诺"
                f"（不得手工另建；已成立的承诺：{sorted(self._awards)}）")
        # 行来源链：① 承诺里的中标行快照 → ② 本侧已提交报价的行 → ③ 无快照时只要求给出引用
        # （追溯模式写进 PO 记录，不静默降级：`full` 逐行核对价格，`ref-only` 仅核对引用形态）
        snapshot = {str(line.get("item_id")): line for line in award.get("lines") or []}
        submitted = self._quotes.get(str(award.get("quote_id") or "")) or {}
        if not snapshot and submitted.get("lines"):
            snapshot = {str(line.get("item_id")): line for line in submitted["lines"]}
        trace_mode = "full" if snapshot else "ref-only"
        traced: list[dict] = []
        for line in lines:
            ref = str(line.get("ref_line") or line.get("item_id") or "")
            if not ref:
                raise CommitmentError("[po-line-not-derived] PO 行必须引用中标报价条目（缺 ref_line）")
            base = snapshot.get(ref)
            if snapshot and base is None:
                raise CommitmentError(
                    f"[po-line-not-derived] PO 行必须引用中标报价条目：{ref!r} 不在 "
                    f"{award_id} 的条目 {sorted(snapshot)} 里")
            unit_price = (float(line["unit_price"]) if line.get("unit_price") is not None
                          else float((base or {}).get("unit_price", 0)))
            if base is not None and float(line.get("unit_price", base.get("unit_price", 0))) != \
                    float(base.get("unit_price", 0)):
                raise CommitmentError(
                    f"[po-line-price-mismatch] PO 不得凭空改价：{ref} 中标单价 "
                    f"{float(base.get('unit_price', 0)):g}，PO 给 {unit_price:g}")
            traced.append({"ref_line": ref,
                           "qty": float(line.get("qty", (base or {}).get("qty", 0)) or 0),
                           "unit_price": unit_price,
                           "basis": f"{award.get('quote_id')}#{ref}:unit_price",
                           "trace": trace_mode})
        approval = self.approval.require(scope=SCOPE_PO_ISSUE, ref=award_id, approval_id=approval_id)
        self._po_counter += 1
        record = {"po_id": f"po-{self._po_counter:04d}", "award_id": award_id,
                  "intent_id": award.get("intent_id"), "quote_id": award.get("quote_id"),
                  "package_id": award.get("package_id"),
                  "lines": traced,
                  "total_amount": round(sum(item["qty"] * item["unit_price"] for item in traced), 6),
                  "approval_id": approval["approval_id"], "approved_by": approval["decided_by"],
                  "chain": f"po → {award_id} → {award.get('intent_id')} → {award.get('quote_id')}",
                  "trace_mode": trace_mode,
                  "issued_at": utc_now()}
        self._pos = getattr(self, "_pos", {})
        self._pos[record["po_id"]] = record
        self._append(PO_ISSUED_EVENT, record, event_class="commitment", ref=award_id)
        return {"po_id": record["po_id"], "award_id": award_id, "intent_id": award.get("intent_id"),
                "quote_id": award.get("quote_id"), "line_count": len(traced), "trace_mode": trace_mode,
                "total_amount": record["total_amount"], "chain": record["chain"],
                "issued_at": record["issued_at"]}

    def trace(self, po_id: str) -> dict:
        """PO 的可追溯链：po → 承诺 → 意向 → 报价（逐行引用单价基准）。"""
        record = getattr(self, "_pos", {}).get(po_id)
        if record is None:
            raise CommitmentError(f"未知 PO: {po_id!r}")
        award = self._awards.get(record["award_id"]) or {}
        return {"po_id": po_id, "chain": record["chain"], "award_id": record["award_id"],
                "intent_id": record["intent_id"], "quote_id": record["quote_id"],
                "lines": record["lines"], "total_amount": record["total_amount"],
                "approval_id": record["approval_id"],
                "award_lines": [dict(line) for line in award.get("lines") or []]}

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
