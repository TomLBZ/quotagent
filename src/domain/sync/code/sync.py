"""账本同步：三方协调（base/mine/theirs）+ 字段权威方矩阵 + 冲突上报（`03` §4；FR-QEP-007）。

规则（逐条实施，不发明新规则）：
1. 逐字段三值判定：`m==t` 一致确认；`m!=b,t==b` 采纳我方；`t!=b,m==b` 采纳对方；`m!=b,t!=b,m!=t` 冲突。
2. 冲突 → 查 §4.3 权威方矩阵：权威方取值胜出，败者留痕 `sync/conflict`；胜出写入 `sync/merged`。
3. **承诺字段冲突一律不自动合并**（`resolution=pending_human`，条目挂起）。
4. 矩阵未覆盖的字段冲突 → 同样 `pending_human`（**不猜**）。
5. 对**非权威字段**的本地修改不外发，产出 `intent/suggestion`（建议）供对方采纳（数据主权）。
6. 人工裁决需**双方各自一次 `human:*` 批准**才算成立（避免单边伪造，§4.4）。
7. 产出新的 base（revision 向量），双方各存一份。
"""

from __future__ import annotations

import copy
from typing import Any

from ..kernel.ledger import Ledger, utc_now

CONTRACTOR = "contractor"
SUPPLIER = "supplier"
ASKER = "asker"
SELF = "self"

# §4.3 字段权威方矩阵（默认值；可由项目 patch 覆盖）
FIELD_AUTHORITY: dict[str, str] = {
    "package.scope": CONTRACTOR, "package.items": CONTRACTOR, "package.quantities": CONTRACTOR,
    "package.units": CONTRACTOR, "package.measure_rules": CONTRACTOR, "package.interface_duty": CONTRACTOR,
    "spec.reference": CONTRACTOR, "spec.drawing_rev": CONTRACTOR,
    "cost_structure": SUPPLIER, "cost.margin": SUPPLIER, "cost.capacity": SUPPLIER,
    "unit_price": SUPPLIER, "line_amount": SUPPLIER, "deviation": SUPPLIER,
    "exclusions": SUPPLIER, "delivery.date": SUPPLIER,
    "payment.terms": CONTRACTOR, "warranty": CONTRACTOR, "penalty": CONTRACTOR, "acceptance.criteria": CONTRACTOR,
    "clarification.question": ASKER, "clarification.answer": CONTRACTOR,
    "calendar": SELF, "milestone": SELF,
    "approval": SELF,
}

SUGGESTION_TYPE = "intent/suggestion"
SYNC_EVENTS = ("sync/merged", "sync/conflict", "sync/suspended")


def authority_of(field: str) -> str | None:
    """最长前缀匹配（`delivery.date.week` 之类走族前缀）。"""
    if field in FIELD_AUTHORITY:
        return FIELD_AUTHORITY[field]
    best = None
    for key in FIELD_AUTHORITY:
        if field.startswith(key.split(".")[0] + ".") or field.startswith(key):
            if best is None or len(key) > len(best):
                best = key
    return FIELD_AUTHORITY[best] if best else None


class SyncError(RuntimeError):
    pass


class SyncService:
    """一方的同步服务：本方可执行的三方协调与冲突上报。"""

    def __init__(self, *, participant: str, role: str, realm: str, ledger: Ledger,
                 matrix: dict[str, str] | None = None, events: Any = None) -> None:
        if role not in (CONTRACTOR, SUPPLIER):
            raise SyncError(f"role 必须是 {CONTRACTOR}/{SUPPLIER}，收到 {role!r}")
        self.participant = participant
        self.role = role
        self.realm = realm
        self.ledger = ledger
        self.matrix = dict(matrix or FIELD_AUTHORITY)
        self.events = events
        self.suspended: dict[tuple[str, str], dict] = {}
        self.base: dict[str, Any] = {}
        self.suggestions: list[dict] = []

    # ---------------------------------------------------------------- 三方协调
    def reconcile(self, *, entry_id: str, base: dict, mine: dict, theirs: dict,
                  classes: dict[str, str] | None = None) -> dict:
        """§4.2 的算法：返回 {merged, conflicts, pending_human, base_next}。"""
        classes = classes or {}
        merged: dict[str, Any] = {}
        confirmed: dict[str, Any] = {}
        conflicts: list[dict] = []
        pending: list[dict] = []
        fields = sorted(set(base) | set(mine) | set(theirs))
        for field in fields:
            b, m, t = base.get(field), mine.get(field), theirs.get(field)
            if m == t:
                merged[field] = m
                confirmed[field] = m
                continue
            if m != b and t == b:
                merged[field] = m                      # 我方改，采纳
                continue
            if t != b and m == b:
                merged[field] = t                      # 对方改，采纳
                continue
            # 冲突：m != b, t != b, m != t
            authority = self.matrix.get(field) or authority_of(field)
            is_commitment = classes.get(field, "fact") == "commitment"
            if is_commitment or authority is None:
                reason = "commitment-field" if is_commitment else "no-authority-rule"
                record = {"entry_id": entry_id, "field": field, "base": b, "mine": m, "theirs": t,
                          "authority": authority, "class": classes.get(field, "fact"),
                          "auto_resolution": "pending_human", "reason": reason}
                conflicts.append(record)
                pending.append(record)
                self.suspended[(entry_id, field)] = {**record, "suspended_at": utc_now()}
                merged[field] = b                      # 挂起期间保持 base（不自动推进）
                self._append("sync/conflict", record)
                self._append("sync/suspended", {"entry_id": entry_id, "field": field, "reason": reason,
                                                "needs": "双方各自一次 human:* 批准（§4.4）"})
                continue
            winner_is_mine = authority in (self.role, ASKER, SELF)
            value = m if winner_is_mine else t
            record = {"entry_id": entry_id, "field": field, "base": b, "mine": m, "theirs": t,
                      "authority": authority, "class": classes.get(field, "fact"),
                      "auto_resolution": f"{authority}-wins"}
            conflicts.append(record)
            merged[field] = value
            self._append("sync/conflict", record)
            self._append("sync/merged", {"entry_id": entry_id, "field": field, "value": value,
                                         "by": authority, "auto": True})
        if confirmed:
            self._append("sync/merged", {"entry_id": entry_id, "confirmed": confirmed, "by": "agreement",
                                         "auto": True})
        self.base = copy.deepcopy(merged)
        return {"entry_id": entry_id, "merged": merged, "confirmed": confirmed,
                "conflicts": conflicts, "pending_human": pending,
                "base_next": copy.deepcopy(merged), "suspended": len(self.suspended)}

    # ---------------------------------------------------------------- 非权威字段修改 → 建议
    def suggest(self, *, entry_id: str, field: str, value: Any, reason: str = "") -> dict:
        """对非权威字段的本地修改**不外发**，改为产出建议（`intent/suggestion`）。"""
        authority = self.matrix.get(field) or authority_of(field)
        if authority in (self.role, SELF):
            raise SyncError(f"{field!r} 的权威方是 {authority}，本方可直接改，不需要建议")
        suggestion = {"type": SUGGESTION_TYPE, "class": "intent", "entry_id": entry_id, "field": field,
                      "value": value, "reason": reason, "authority": authority,
                      "by": self.participant, "at": utc_now()}
        self.suggestions.append(suggestion)
        self.ledger.append("sync/suggestion-raised", suggestion, actor=self.participant,
                           refs={"entry_id": entry_id})
        if self.events is not None:
            self.events.emit("sync/suggestion-raised", suggestion)
        return suggestion

    # ---------------------------------------------------------------- 人工裁决
    def resolve_human(self, *, entry_id: str, field: str, value: Any,
                      local_approval: dict | None, peer_approval: dict | None) -> dict:
        """承诺字段的人工裁决：**双方各自一次 human:* 批准**才成立（§4.4）。"""
        key = (entry_id, field)
        record = self.suspended.get(key)
        if record is None:
            raise SyncError(f"没有挂起项 {entry_id}/{field}")
        approvals = [item for item in (local_approval, peer_approval) if item]
        valid = [item for item in approvals if str(item.get("by", "")).startswith("human:")
                 and item.get("scope") and item.get("at")]
        if len(valid) < 2:
            self._append("sync/conflict", {**record, "auto_resolution": "pending_human",
                                           "approvals_seen": len(valid),
                                           "note": "单侧批准不算成立（避免单边伪造）"})
            return {"resolved": False, "reason": "need-both-sides",
                    "approvals_seen": len(valid), "suspended": len(self.suspended)}
        merged_value = {"value": value, "approvals": valid, "resolved_at": utc_now()}
        self.base[field] = merged_value
        del self.suspended[key]
        self._append("sync/merged", {"entry_id": entry_id, "field": field, "value": merged_value,
                                     "by": "human-both-sides", "auto": False})
        return {"resolved": True, "merged": merged_value, "suspended": len(self.suspended)}

    # ---------------------------------------------------------------- 查询
    def suspended_entries(self) -> list[dict]:
        return [dict(item) for item in self.suspended.values()]

    def _append(self, type_: str, body: dict) -> None:
        self.ledger.append(type_, body, actor=self.participant,
                           refs={"entry_id": body.get("entry_id")} if body.get("entry_id") else {})
        if self.events is not None:
            self.events.emit(type_, body)
