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
REMINDED_EVENT = "approval/reminded"
ESCALATED_EVENT = "approval/escalated"
ABORTED_EVENT = "approval/aborted"
TIMEOUT_POLICIES = ("remind", "escalate", "abort")
DEFAULT_TIMEOUT_POLICY = "remind"
DEFAULT_TIMEOUT_S = 3600.0
GRANTED_EVENT = "approval/granted"
DENIED_EVENT = "approval/denied"
HUMAN_PREFIX = "human:"

#: 门的**派分事实**（ADR-0022）：开单时随 `approval/requested` 一起写进账本 body 的追加键。
#:
#: 为什么必须有：界面要回答的三个问题是「**卡在谁**（审批人）/ **超时策略**与倒计时 / **该催谁**」，
#: 而这三样在开单那一刻就已经定了。此前只有 `approval/escalated`（升级/委托之后）才带 `approvers`，
#: 于是 `gate.queue` 面板只能如实标一句「账本行未带审批人」——待办看得见、却看不出该催谁。
#:
#: 兼容性（**追加型，不改旧行语义**）：旧账本行没有这些键，读侧一律按缺省处理
#: （`replay()` 的 `setdefault`、`queue_view()` 的 `.get(...)`、宿主 `gatesOf()` 的 `?? previous.X`），
#: 所以旧行读出来逐字段与改前一致；新键只**增加**可回读的事实，不改任何既有键的语义。
GATE_FACT_KEYS = ("approvers", "timeout_policy", "timeout_s", "escalate_to", "requested_at")


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
        self.replayed = 0
        if self.ledger is not None:
            replay = self.replay()
            self.replayed = replay["replayed"]
        self._counter = 0

    # --- 请求 -------------------------------------------------------------
    def replay(self) -> dict:
        """从账本重建批准记录（**账本是唯一事实源**）。

        没有这一步，进程重启后 `granted()` 会一无所知——于是"人工批准过"的承诺动作在重启后
        既无法核验也无法复现（与 `06` §7"重启后从账本重放本 realm 状态"矛盾）。
        重放规则：`approval/requested` 建记录，其后同 id 的事件（granted/denied/reminded/escalated/aborted）
        依次覆盖，最后一次写入即当前状态。
        """
        if self.ledger is None:
            return {"replayed": 0, "note": "无账本，无法重放"}
        seen: dict[str, dict] = {}
        order: list[str] = []
        for row in self.ledger.read():
            if not str(row["type"]).startswith("approval/"):
                continue
            body = row["body"] or {}
            approval_id = body.get("approval_id")
            if not approval_id:
                continue
            if approval_id not in seen:
                order.append(approval_id)
            record = dict(body)
            record.setdefault("status", "pending")
            record.setdefault("decided_by", None)
            record.setdefault("decided_at", None)
            record.setdefault("comment", "")
            record.setdefault("timeout_log", [])
            record.setdefault("remind_count", 0)
            seen[approval_id] = record
        self._records = seen
        self._order = order
        self._counter = max([int(item.rsplit("-", 1)[-1]) for item in seen if item.rsplit("-", 1)[-1].isdigit()]
                            or [0])
        return {"replayed": len(seen), "order": list(order)}

    def request(self, scope: str, payload: dict, *, ref: str | None = None,
                approvers: list[str] | None = None, reason: str = "",
                timeout_policy: str = DEFAULT_TIMEOUT_POLICY, timeout_s: float = DEFAULT_TIMEOUT_S,
                escalate_to: str | None = None, summary: str | None = None,
                confidence: float | None = None, flags: list[str] | None = None) -> dict:
        if not scope:
            raise ApprovalError("批准请求必须声明 scope（批准范围）")
        if timeout_policy not in TIMEOUT_POLICIES:
            raise ApprovalError(f"超时策略必须是 {TIMEOUT_POLICIES} 之一，收到 {timeout_policy!r}"
                                f"（不存在「超时自动批准」这一选项，06 §6）")
        if timeout_policy == "escalate" and not str(escalate_to or "").startswith(HUMAN_PREFIX):
            raise ApprovalError("escalate 必须给一个人类上级（escalate_to 需以 'human:' 开头）")
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
            "summary": summary or _summarize(payload),
            "flags": list(flags or []),
            "confidence": confidence,
            "timeout_policy": timeout_policy,
            "timeout_s": float(timeout_s),
            "escalate_to": escalate_to,
            "last_action_at": utc_now(),
            "remind_count": 0,
            "escalated_at": None,
            "aborted_at": None,
            "timeout_log": [],
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

    # --- 人工门队列视图（FR-UX-001） ---------------------------------------
    def queue_view(self, *, now: str | None = None, policy: str | None = None) -> dict:
        """待批队列：动作（scope）、摘要、引用链、Flag、可选置信度、超时策略与已等待时长。"""
        stamp = now or utc_now()
        moment = _epoch(stamp)
        items: list[dict] = []
        for key in self._order:
            record = self._records[key]
            if record["status"] != "pending":
                continue
            if policy and record.get("timeout_policy") != policy:
                continue
            waited = moment - _epoch(record["requested_at"])
            last = moment - _epoch(record.get("last_action_at") or record["requested_at"])
            items.append({
                "approval_id": record["approval_id"],
                "action": record["scope"],
                "summary": record.get("summary"),
                "refs": [record["ref"]] if record.get("ref") else [],
                "flags": list(record.get("flags") or []),
                "model_confidence": record.get("confidence"),
                "timeout_policy": record.get("timeout_policy", DEFAULT_TIMEOUT_POLICY),
                "waiting_on": list(record.get("approvers") or []) or ([record["escalate_to"]]
                                                                      if record.get("escalate_to") else []),
                "requested_at": record["requested_at"],
                "waited_seconds": round(waited, 3),
                "since_last_action_seconds": round(last, 3),
                "overdue": last >= float(record.get("timeout_s") or DEFAULT_TIMEOUT_S),
                "remind_count": int(record.get("remind_count") or 0),
            })
        return {"generated_at": stamp, "pending": len(items), "items": items,
                "policies": {name: sum(1 for item in items if item["timeout_policy"] == name)
                             for name in TIMEOUT_POLICIES},
                "note": "待批**不阻塞**其他工作；超时动作只有 remind/escalate/abort，不存在自动批准"}

    # --- 超时扫描（FR-APPROVE-003） ---------------------------------------
    def sweep(self, *, now: str | None = None) -> dict:
        """对**已超时**的待批项执行其超时策略；永不产生 granted。"""
        stamp = now or utc_now()
        moment = _epoch(stamp)
        acted: list[dict] = []
        skipped: list[dict] = []
        for key in list(self._order):
            record = self._records[key]
            if record["status"] != "pending":
                continue
            last = moment - _epoch(record.get("last_action_at") or record["requested_at"])
            if last < float(record.get("timeout_s") or DEFAULT_TIMEOUT_S):
                skipped.append({"approval_id": record["approval_id"], "reason": "not-overdue"})
                continue
            policy = record.get("timeout_policy", DEFAULT_TIMEOUT_POLICY)
            if policy == "remind":
                record["remind_count"] = int(record.get("remind_count") or 0) + 1
                record["last_action_at"] = stamp
                record["remind_at"] = stamp
                body = {**record, "action": "remind", "policy": policy,
                        "note": "提醒仍等待人类决定（不改变状态、不批准）"}
                self._append(REMINDED_EVENT, body, correlation_id=record["ref"] or key)
            elif policy == "escalate":
                target = record.get("escalate_to")
                record["approvers"] = [target] if target else record.get("approvers", [])
                record["escalated_at"] = stamp
                record["last_action_at"] = stamp
                body = {**record, "action": "escalate", "policy": policy, "escalated_to": target,
                        "note": "转上级继续等待人类决定（仍不批准）"}
                self._append(ESCALATED_EVENT, body, correlation_id=record["ref"] or key)
            elif policy == "abort":
                record["status"] = "aborted"
                record["aborted_at"] = stamp
                record["last_action_at"] = stamp
                body = {**record, "action": "abort", "policy": policy,
                        "note": "作废本次意图（需重新发起）；不得解释为批准或拒绝"}
                self._append(ABORTED_EVENT, body, correlation_id=record["ref"] or key)
            else:
                raise ApprovalError(f"未知超时策略: {policy!r}")
            record.setdefault("timeout_log", []).append({"at": stamp, "policy": policy})
            acted.append({"approval_id": record["approval_id"], "policy": policy,
                          "status": record["status"]})
        return {"at": stamp, "acted": acted, "skipped": skipped,
                "granted_by_timeout": 0,
                "note": "超时动作永不包含批准（06 §6：绝不允许超时自动批准）"}

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
        body = {"approval_id": record["approval_id"], "scope": record["scope"],
                "ref": record["ref"], "payload_hash": record["payload_hash"],
                "status": record["status"], "decided_by": record["decided_by"],
                "comment": record["comment"]}
        # ADR-0022：追加门的**派分事实**（审批人 / 超时策略与秒数 / 该升级给谁 / 开单时刻）。
        # 追加型变更：旧键逐字节不变；`None`（如未指定 escalate_to）不进 body，避免留空噪声。
        # 载荷正文仍只出 `payload_hash` —— 摘要/正文不进账本（与「凭据正文与私钥一律不进账本」同纪律）。
        for key in GATE_FACT_KEYS:
            if record.get(key) is not None:
                body[key] = record[key]
        self.ledger.append(event, body,
                           correlation_id=correlation_id, actor=record["decided_by"] or self.actor,
                           refs={"approval_id": record["approval_id"], "scope": record["scope"]})
        if self.events is not None:
            self.events.emit(event, {"approval_id": record["approval_id"], "scope": record["scope"],
                                     "status": record["status"]})


def _summarize(payload: dict, *, limit: int = 120) -> str:
    """payload 摘要（给人工看的一行）：键名与值截断，不展开私有结构。"""
    parts = []
    for key in sorted(payload or {}):
        value = payload[key]
        text = value if isinstance(value, (str, int, float, bool)) or value is None else f"<{type(value).__name__}>"
        parts.append(f"{key}={str(text)[:32]}")
    joined = ", ".join(parts)
    return joined[:limit] + ("…" if len(joined) > limit else "")


def _epoch(stamp: str) -> float:
    """ISO 时间 → 秒（解析失败按 0，避免因畸形时间戳崩掉队列视图）。"""
    from datetime import datetime, timezone
    try:
        text = str(stamp).replace("Z", "+00:00")
        moment = datetime.fromisoformat(text)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.timestamp()
    except Exception:  # noqa: BLE001
        return 0.0
