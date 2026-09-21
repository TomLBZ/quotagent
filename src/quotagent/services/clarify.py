"""ctx.clarify 的 P1 实现（`04` §ctx.clarify / `05-events.md` §3）：澄清工单生命周期。

三条硬约束（不是"提醒"，是拒绝执行）：

1. **工单必带版本与条目引用**（FR-CLARIFY-001）：缺 `rfq_rev` 或缺条目引用 → 拒绝建单并留痕
   （`clarification/rejected`），不存在"先建单后补引用"的路径；
2. **答案未广播给全部在册投标人不得关闭**（FR-CLARIFY-002 / INV-006）：广播名单缺任一在册投标人 →
   落 `clarification/broadcast-incomplete`（bail 事件）且 `close()` 拒绝；
3. **包版本变更时相关工单自动重开**（FR-CLARIFY-003）：重开后旧答案标记为**针对旧版本**
   （`stale=true` + `applies_to_rev`），不得当作对新版本的有效回答。

答案草稿先过 `clarification/answer-drafted` 的 waterfall 链：中间件可拦下含对方私域的草稿
（`05-events.md` §5 的短路理由），被拦下的草稿**不落** `clarification/answered`。
"""

from __future__ import annotations

import copy
from typing import Any, Iterable

from ..kernel.ledger import Ledger, utc_now

ASKED_EVENT = "clarification/asked"
ANSWERED_EVENT = "clarification/answered"
DRAFT_EVENT = "clarification/answer-drafted"
INCOMPLETE_EVENT = "clarification/broadcast-incomplete"
REJECTED_EVENT = "clarification/rejected"
REOPENED_EVENT = "clarification/reopened"
DRAFT_REASON = "答案可能含对方私域信息 → 拦截该字段（05 §5）"


class ClarifyError(RuntimeError):
    pass


class ClarificationService:
    """澄清工单：建单 / 作答 / 广播 / 关闭 / 版本重开。"""

    def __init__(self, *, participant: str, realm: str, ledger: Ledger, events: Any = None,
                 package: dict | None = None, registered_bidders: Iterable[str] = (),
                 private_fields: Iterable[str] = (), strict_private: bool = True) -> None:
        self.participant = participant
        self.realm = realm
        self.ledger = ledger
        self.events = events
        self.package = copy.deepcopy(package or {})
        self.registered_bidders = sorted(registered_bidders)
        self.private_fields = tuple(private_fields)
        self.strict_private = bool(strict_private)
        self.tickets: dict[str, dict] = {}
        self.rejections: list[dict] = []
        self._attached = False

    # ---------------------------------------------------------------- 建单
    def ask(self, *, package_id: str, rfq_rev: int | None, refs: dict | None, question: str,
            asker_realm: str = "", ticket_id: str | None = None) -> dict:
        """建单。缺版本或缺条目引用 → 拒绝（不建单）。"""
        item_ids = list((refs or {}).get("item_ids") or [])
        errors: list[str] = []
        if not isinstance(rfq_rev, int) or rfq_rev < 1:
            errors.append(f"缺 rfq_rev（收到 {rfq_rev!r}）：工单必须绑定包版本（FR-CLARIFY-001）")
        if not item_ids:
            errors.append("缺条目引用 refs.item_ids：无引用的工单不得建立（FR-CLARIFY-001）")
        if not question or not str(question).strip():
            errors.append("question 为空")
        if errors:
            self._record_rejection("建单被拒", errors=errors, ticket_id=ticket_id, action="ask")
            raise ClarifyError("；".join(errors))
        assert isinstance(rfq_rev, int)            # 上面已校验；此处仅为类型收窄
        tid = ticket_id or f"cl-{len(self.tickets) + 1:04d}"
        ticket = {"ticket_id": tid, "package_id": package_id, "rfq_rev": int(rfq_rev),
                  "refs": {"item_ids": item_ids}, "question": question, "asker_realm": asker_realm or self.realm,
                  "status": "open", "answer": None, "broadcast": None, "reopened": [],
                  "created_at": utc_now()}
        self.tickets[tid] = ticket
        self._append(ASKED_EVENT, {"ticket_id": tid, "package_id": package_id, "rfq_rev": ticket["rfq_rev"],
                                   "refs": ticket["refs"], "asker_realm": ticket["asker_realm"],
                                   "question": question, "status": "open"})
        return dict(ticket)

    # ---------------------------------------------------------------- 作答（草稿先过 waterfall）
    def answer(self, *, ticket_id: str, text: str, by: str, fields: dict | None = None) -> dict:
        """作答。草稿先过 `clarification/answer-drafted` waterfall；被拦下则不落 answered。"""
        ticket = self._require(ticket_id)
        if ticket["status"] == "closed":
            raise ClarifyError(f"工单已关闭: {ticket_id}")
        if not str(by).startswith("human:"):
            errors = [f"回答者必须是 human:*（收到 {by!r}）：解答责任在人"]
            self._record_rejection("作答被拒", errors=errors, ticket_id=ticket_id, action="answer")
            raise ClarifyError("；".join(errors))
        self._attach_defaults()
        draft = {"ticket_id": ticket_id, "package_id": ticket["package_id"], "rfq_rev": ticket["rfq_rev"],
                 "text": text, "fields": dict(fields or {}), "by": by, "blocked": False, "reasons": []}
        result = self.events.waterfall(DRAFT_EVENT, draft) if self.events is not None else draft
        result = result if isinstance(result, dict) else draft
        if result.get("blocked"):
            self._record_rejection("作答草稿被拦下", errors=list(result.get("reasons") or []),
                                   ticket_id=ticket_id, action="answer")
            raise ClarifyError(f"答案草稿被拦下（私域/合规）：{result.get('reasons')}")
        ticket["answer"] = {"text": result.get("text", text), "fields": result.get("fields", {}),
                            "by": by, "at": utc_now(), "rfq_rev": ticket["rfq_rev"], "stale": False,
                            "stripped": list(result.get("stripped") or [])}
        ticket["status"] = "answered"
        self._append(ANSWERED_EVENT, {"ticket_id": ticket_id, "package_id": ticket["package_id"],
                                      "rfq_rev": ticket["rfq_rev"], "by": by,
                                      "text": ticket["answer"]["text"], "fields": ticket["answer"]["fields"],
                                      "stripped": ticket["answer"]["stripped"], "broadcast_at": None})
        return dict(ticket)

    # ---------------------------------------------------------------- 广播（完整性校验）
    def broadcast(self, *, ticket_id: str, to: Iterable[str]) -> dict:
        """广播答案。名单缺任一在册投标人 → 不完整（落 bail 事件），工单不得关闭。"""
        ticket = self._require(ticket_id)
        if ticket["answer"] is None:
            raise ClarifyError(f"工单尚未作答，无法广播: {ticket_id}")
        recipients = sorted({str(item) for item in to})
        missing = [bidder for bidder in self.registered_bidders if bidder not in recipients]
        if missing:
            payload = {"ticket_id": ticket_id, "package_id": ticket["package_id"],
                       "rfq_rev": ticket["rfq_rev"], "registered": list(self.registered_bidders),
                       "broadcast_to": recipients, "missing": missing,
                       "action": "cannot-close", "at": utc_now()}
            ticket["broadcast"] = {"to": recipients, "complete": False, "missing": missing, "at": utc_now()}
            self._append(INCOMPLETE_EVENT, payload)
            raise ClarifyError(f"广播名单缺 {missing}：答案未覆盖全部在册投标人，工单不得关闭（INV-006）")
        ticket["broadcast"] = {"to": recipients, "complete": True, "missing": [], "at": utc_now()}
        self._append(ANSWERED_EVENT, {"ticket_id": ticket_id, "package_id": ticket["package_id"],
                                      "rfq_rev": ticket["rfq_rev"], "broadcast_at": ticket["broadcast"]["at"],
                                      "broadcast_to": recipients, "broadcast_complete": True,
                                      "answer_sha256": _sha(ticket["answer"]["text"])})
        return {"ticket_id": ticket_id, "broadcast": dict(ticket["broadcast"]), "status": ticket["status"]}

    # ---------------------------------------------------------------- 关闭
    def close(self, *, ticket_id: str) -> dict:
        ticket = self._require(ticket_id)
        broadcast = ticket.get("broadcast")
        if not broadcast or not broadcast.get("complete"):
            missing = (broadcast or {}).get("missing")
            if missing is None:
                missing = list(self.registered_bidders)
            payload = {"ticket_id": ticket_id, "action": "close-refused",
                       "reason": "答案未完整广播给在册投标人" if broadcast else "答案尚未广播",
                       "missing": missing, "at": utc_now()}
            self._append(INCOMPLETE_EVENT, payload)
            raise ClarifyError(f"工单不得关闭：{payload['reason']}（缺 {missing}，INV-006）")
        ticket["status"] = "closed"
        ticket["closed_at"] = utc_now()
        self._append(ASKED_EVENT, {"ticket_id": ticket_id, "package_id": ticket["package_id"],
                                   "status": "closed", "closed_at": ticket["closed_at"],
                                   "broadcast_to": broadcast["to"]})
        return dict(ticket)

    # ---------------------------------------------------------------- 包版本变更 → 自动重开
    def on_package_rev(self, *, package_id: str, rfq_rev: int) -> dict:
        """包升版：相关工单自动重开，旧答案标记为"针对旧版本"。"""
        reopened, stale = [], []
        for ticket in self.tickets.values():
            if ticket["package_id"] != package_id or ticket["rfq_rev"] == rfq_rev:
                continue
            previous = ticket["rfq_rev"]
            marked_stale = False
            if ticket["answer"] is not None:
                ticket["answer"]["stale"] = True
                ticket["answer"]["applies_to_rev"] = ticket["answer"].get("rfq_rev", previous)
                ticket["answer"]["superseded_by_rev"] = rfq_rev
                marked_stale = True
                stale.append({"ticket_id": ticket["ticket_id"], "answer_rev": ticket["answer"]["applies_to_rev"]})
            ticket["reopened"].append({"from_rev": previous, "to_rev": rfq_rev, "at": utc_now()})
            ticket["status"] = "open"
            ticket["broadcast"] = None
            reopened.append({"ticket_id": ticket["ticket_id"], "from_rev": previous, "to_rev": rfq_rev})
            self._append(REOPENED_EVENT, {"ticket_id": ticket["ticket_id"], "package_id": package_id,
                                          "from_rev": previous, "to_rev": rfq_rev,
                                          "previous_answer_stale": marked_stale,
                                          "note": "旧答案只对旧版本有效，不得当作对新版本的回答"})
        if package_id == self.package.get("package_id") and rfq_rev > int(self.package.get("rfq_rev") or 0):
            self.package["rfq_rev"] = rfq_rev
        return {"package_id": package_id, "rfq_rev": rfq_rev, "reopened": reopened, "answers_marked_stale": stale}

    # ---------------------------------------------------------------- 查询
    def ticket(self, ticket_id: str) -> dict:
        return copy.deepcopy(self._require(ticket_id))

    def open_tickets(self) -> list[dict]:
        return [copy.deepcopy(item) for item in self.tickets.values() if item["status"] != "closed"]

    # ---------------------------------------------------------------- 内部
    def _require(self, ticket_id: str) -> dict:
        ticket = self.tickets.get(ticket_id)
        if ticket is None:
            raise ClarifyError(f"未知工单: {ticket_id}")
        return ticket

    def _attach_defaults(self) -> None:
        """默认中间件：拦截含**对方私域字段**的答案草稿（strict 模式直接短路）。"""
        if self._attached or self.events is None:
            return
        if self.events.mode_of(DRAFT_EVENT) is None:
            self.events.declare(DRAFT_EVENT, "waterfall", reason=DRAFT_REASON)
        private = tuple(self.private_fields)

        def guard(draft: dict, next_, *args):
            fields = draft.get("fields") or {}
            hit = sorted(key for key in fields if key in private)
            text_hit = sorted(token for token in private if token and token in str(draft.get("text", "")))
            if hit or text_hit:
                if self.strict_private:
                    draft["blocked"] = True
                    draft["reasons"] = list(draft.get("reasons") or []) + [
                        f"答案含私域字段 {hit or text_hit}：不得外发（strict_private）"]
                    return draft                     # 不调 next_() → 短路（05 §5）
                stripped = list(draft.get("stripped") or [])
                for key in hit:
                    fields.pop(key, None)
                    stripped.append(key)
                draft["fields"] = fields
                draft["stripped"] = stripped
            return next_(draft)

        self.events.on(DRAFT_EVENT, guard, label=f"{self.realm}:answer-draft-guard")
        self._attached = True

    def _record_rejection(self, reason: str, *, errors: list[str], ticket_id: str | None, action: str) -> dict:
        entry = {"reason": reason, "errors": list(errors), "ticket_id": ticket_id, "action": action,
                 "at": utc_now()}
        self.rejections.append(entry)
        self._append(REJECTED_EVENT, entry)
        return entry

    def _append(self, type_: str, body: dict) -> None:
        """落账 + 按事件的 @mode 分发（bail 事件必须用 bail()，05-events.md §0 规则 1）。"""
        refs = {"ticket_id": body["ticket_id"]} if body.get("ticket_id") else {}
        self.ledger.append(type_, body, actor=self.participant, refs=refs)
        if self.events is None:
            return
        mode = self.events.mode_of(type_)
        if mode == "bail":
            return self.events.bail(type_, body)
        if mode in (None, "emit"):
            return self.events.emit(type_, body)
        if mode == "serial":
            return self.events.serial(type_, body)
        if mode == "parallel":
            return self.events.parallel(type_, body)
        return self.events.waterfall(type_, body)


def _sha(text: str) -> str:
    import hashlib
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
