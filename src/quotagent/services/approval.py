"""ctx.approval 的 P0 实现（`04-services-catalog.md` §2）——人工门。

不变量（`AGENTS.md` 规则 3 / INV-005）：
- 承诺类动作在没有**有效**批准记录时不可执行；
- 批准记录**不可由 agent 产生**（`by` 必须以 `human:` 开头，否则 `AgentCannotApprove`）；
- 批准**绑定 scope 与业务引用**，不可跨动作复用（FR-APPROVE-002）；
- 绝不存在"超时自动批准"（P8）：`decide` 只能由人显式调用。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..kernel.canon import digest
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now

REQUESTED_EVENT = "approval/requested"
GRANTED_EVENT = "approval/granted"
DENIED_EVENT = "approval/denied"
HUMAN_PREFIX = "human:"


class ApprovalError(RuntimeError):
    """人工门错误基类。"""


class AgentCannotApprove(ApprovalError):
    """批准记录只能由人产生（代签禁止）。"""


class ApprovalRequired(ApprovalError):
    """缺少有效批准记录，动作被拒绝（INV-005）。"""


class UnknownApproval(ApprovalError):
    """批准记录不存在。"""


class ApprovalService:
    def __init__(self, *, ledger: Ledger | None = None, events: EventBus | None = None,
                 actor: str = "agent:approval") -> None:
        self.ledger = ledger
        self.events = events
        self.actor = actor
        self._records: dict[str, dict] = {}
        self._order: list[str] = []
        self._counter = 0

    # --- 请求 -------------------------------------------------------------
    def request(self, scope: str, payload: dict, *, ref: str | None = None,
                approvers: list[str] | None = None, reason: str = "") -> dict:
        if not scope:
            raise ApprovalError("批准请求必须声明 scope（批准范围）")
        self._counter += 1
        approval_id = f"ap-{self._counter:04d}"
        record = {
            "approval_id": approval_id,
            "scope": scope,
            "ref": ref,
            "payload": dict(payload),
            "payload_hash": digest(payload),
            "reason": reason,
            "approvers": list(approvers or []),
            "requested_by": self.actor,
            "requested_at": utc_now(),
            "status": "pending",
            "decided_by": None,
            "decided_at": None,
            "comment": "",
        }
        self._records[approval_id] = record
        self._order.append(approval_id)
        self._append(REQUESTED_EVENT, record, correlation_id=ref or approval_id)
        return dict(record)

    # --- 决定（只能由人） -------------------------------------------------
    def decide(self, approval_id: str, *, by: str, decision: str, comment: str = "") -> dict:
        record = self._records.get(approval_id)
        if record is None:
            raise UnknownApproval(f"不存在的批准记录: {approval_id}")
        if not str(by).startswith(HUMAN_PREFIX):
            raise AgentCannotApprove(
                f"批准记录只能由人产生（by 必须以 {HUMAN_PREFIX!r} 开头），收到 {by!r}；"
                f"agent 不得代签，也不得自动批准（P8）")
        if decision not in ("granted", "denied"):
            raise ApprovalError(f"decision 取值非法: {decision!r}（granted|denied）")
        if record["status"] != "pending":
            raise ApprovalError(f"批准 {approval_id} 已处理（状态 {record['status']}），不可重复决定")
        record["status"] = decision
        record["decided_by"] = by
        record["decided_at"] = utc_now()
        record["comment"] = comment
        self._append(GRANTED_EVENT if decision == "granted" else DENIED_EVENT, record,
                     correlation_id=record["ref"] or approval_id)
        return dict(record)

    # --- 查询 -------------------------------------------------------------
    def get(self, approval_id: str) -> dict:
        record = self._records.get(approval_id)
        if record is None:
            raise UnknownApproval(f"不存在的批准记录: {approval_id}")
        return dict(record)

    def pending(self) -> list[dict]:
        return [dict(self._records[key]) for key in self._order
                if self._records[key]["status"] == "pending"]

    def records(self) -> list[dict]:
        return [dict(self._records[key]) for key in self._order]

    def chain(self, ref: str) -> list[dict]:
        return [dict(self._records[key]) for key in self._order if self._records[key]["ref"] == ref]

    def granted(self, *, scope: str, ref: str | None) -> dict | None:
        for key in self._order:
            record = self._records[key]
            if (record["status"] == "granted" and record["scope"] == scope
                    and record["ref"] == ref):
                return dict(record)
        return None

    def require(self, *, scope: str, ref: str | None, approval_id: str | None = None) -> dict:
        """承诺路径的统一入口：没有有效批准即抛错（INV-005）。"""
        if approval_id:
            record = self.get(approval_id)  # 伪造引用 → UnknownApproval
            if record["status"] != "granted" or record["scope"] != scope or record["ref"] != ref:
                raise ApprovalRequired(
                    f"批准 {approval_id} 不适用于 scope={scope!r} ref={ref!r}"
                    f"（当前: scope={record['scope']!r} ref={record['ref']!r} status={record['status']}）")
            return record
        found = self.granted(scope=scope, ref=ref)
        if found is None:
            raise ApprovalRequired(
                f"动作 {scope!r}（ref={ref!r}）缺少人工批准记录："
                f"承诺类动作必须先经 ctx.approval 并由人批准（INV-005 / AGENTS.md 规则 3）")
        return found

    def _append(self, event: str, record: dict, *, correlation_id: str | None) -> None:
        if self.ledger is None:
            return
        self.ledger.append(event,
                           {"approval_id": record["approval_id"], "scope": record["scope"],
                            "ref": record["ref"], "payload_hash": record["payload_hash"],
                            "status": record["status"], "decided_by": record["decided_by"],
                            "comment": record["comment"]},
                           correlation_id=correlation_id, actor=record["decided_by"] or self.actor,
                           refs={"approval_id": record["approval_id"], "scope": record["scope"]})
        if self.events is not None:
            self.events.emit(event, {"approval_id": record["approval_id"], "scope": record["scope"],
                                     "status": record["status"]})
