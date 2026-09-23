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

#: `approval/aborted` 有两个生产者，**键集不同但都不是新事件类型**（ADR-0023）：
#:
#:   · 人做的终止（`tools/gate-actions.py --step abort`）：`{**上一行的 body, action, status='aborted',
#:     aborted_by, aborted_at, last_action_at, reason_sha256, **comment=理由正文逐字**, note}` ——
#:     理由正文进账本，是为了让「为什么作废」从账本回读（审计底线：谁/何时/为什么/依据哪一行可一屏答出）。
#:   · 超时策略触发的作废（下面的 `sweep()`）：**没有人类理由**，`comment` 沿用记录里的空串 ——
#:     读侧如实显示"没有人写过理由"，**不替它编一句**（`aborted_by` 也不会凭空写一个人名）。
#:
#: 兼容性（追加型）：旧账本行没有 `comment`（只有 `reason_sha256`）⇒ 读侧按缺省处理并**如实说**
#: 「账本只有理由哈希、正文在 0600 待办件里」；旧行一个字节不动。


class ApprovalError(RuntimeError):
    """人工门错误基类。"""


class AgentCannotApprove(ApprovalError):
    """批准记录只能由人产生（代签禁止）。"""


class ApprovalRequired(ApprovalError):
    """缺少有效批准记录，动作被拒绝（INV-005）。"""


class UnknownApproval(ApprovalError):
    """批准记录不存在。"""


class SignoffRequired(ApprovalRequired):
    """**没有可消费的已批准门**（P48 的人门判据）：门不存在 / 还没批 / 被驳回 · 被终止 /
    **自签自批**（批的人 == 署名的人）/ 批的人不是开单时点名的那位。

    为什么要有它（而不是沿用 `ApprovalRequired` 一句「缺少人工批准记录」）：承诺与发 PO 这两条主链
    修前是**自签自批**——写者在自己这一次落账里先 `request()` 再 `decide(decision='granted')`，
    于是「有批准记录」成立、主管却从来没有否决权（他不批，承包商照样能签）；而查到的「谁批的」
    就是署名者本人。判据换成**消费一扇已批准的门**之后，拒因必须逐条可区分，界面才答得出
    「去哪儿开单、该找谁批」。`code` / `reason` / `next_action` 三个键就是写者与界面要的具名拒。
    """

    def __init__(self, code: str, reason: str, next_action: str) -> None:
        super().__init__(f"[{code}] {reason}")
        self.code = code
        self.reason = reason
        self.next_action = next_action


#: 人门选择/校验共用的一套具名拒（写者与界面直接照抄，不另起一套词）。
NEXT_OPEN_GATE = ("在「审批队列 / 提交人工门」按这一条开单：scope 与 ref 填上面给的业务引用、"
                  "审批人写**另一个人**（主管）的名字；对方在审批队列里点「批准」之后回来重提")
NEXT_SWITCH = ("若业务上确实需要本人批准，只能在运营侧显式打开自签自批开关"
               "（`<ui-shared>/commitments/policy.json` 的 `allow_self_approval: true`，**默认关闭**"
               "且界面不提供开关）——打开后本次批准会如实标成「批准人 == 署名者本人」")


class ApprovalService:
    def __init__(self, *, ledger: Ledger | None = None, events: EventBus | None = None,
                 actor: str = "agent:approval") -> None:
        self.ledger = ledger
        self.events = events
        self.actor = actor
        self._records: dict[str, dict] = {}
        self._order: list[str] = []
        self.replayed = 0
        # 计数器**先归零、再由 `replay()` 推到已用过的最大序号**：顺序反过来（先 replay 再置 0）
        # 会把重放算出的序号抹掉，于是**每个新进程都从 `ap-0001` 起** —— 跨进程动作（GUI 一次一进程）
        # 在同一账本上产出**重号**的批准记录（实测同一账本上出现过两个 `ap-0001`）。
        # 无账本时保持 0（既不重放也无从推）。`replay()` 的这一步是既有语义，本处只按正确顺序调用它。
        self._counter = 0
        if self.ledger is not None:
            replay = self.replay()
            self.replayed = replay["replayed"]

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
                confidence: float | None = None, flags: list[str] | None = None,
                at: str | None = None) -> dict:
        """开一个待批门。`at` = 落账时刻（**唯一写者传 `--now` 进来**；不给则沿用 `utc_now()`）。"""
        if not scope:
            raise ApprovalError("批准请求必须声明 scope（批准范围）")
        if timeout_policy not in TIMEOUT_POLICIES:
            raise ApprovalError(f"超时策略必须是 {TIMEOUT_POLICIES} 之一，收到 {timeout_policy!r}"
                                f"（不存在「超时自动批准」这一选项，06 §6）")
        if timeout_policy == "escalate" and not str(escalate_to or "").startswith(HUMAN_PREFIX):
            raise ApprovalError("escalate 必须给一个人类上级（escalate_to 需以 'human:' 开头）")
        self._counter += 1
        approval_id = f"ap-{self._counter:04d}"
        stamp = at or utc_now()
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
            "last_action_at": stamp,
            "remind_count": 0,
            "escalated_at": None,
            "aborted_at": None,
            "timeout_log": [],
            "requested_by": self.actor,
            "requested_at": stamp,
            "status": "pending",
            "decided_by": None,
            "decided_at": None,
            "comment": "",
        }
        self._records[approval_id] = record
        self._order.append(approval_id)
        self._append(REQUESTED_EVENT, record, correlation_id=ref or approval_id, ts=at)
        return dict(record)

    # --- 决定（只能由人） -------------------------------------------------
    def decide(self, approval_id: str, *, by: str, decision: str, comment: str = "",
               at: str | None = None) -> dict:
        """决定一个门（**只能由人**）：`granted`/`denied`。

        `at` = 落账时刻（**唯一写者传 `--now` 进来**）：宿主/写者不读墙钟这一条不许因为界面而放宽，
        所以这里给一个显式的口子；不传则沿用既有行为（`utc_now()`），旧调用方逐字节不变。
        """
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
        record["decided_at"] = at or utc_now()
        record["comment"] = comment
        self._append(GRANTED_EVENT if decision == "granted" else DENIED_EVENT, record,
                     correlation_id=record["ref"] or approval_id, ts=at)
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
                # 超时作废**没有人类理由**：`comment` 保持空串、**不写** `aborted_by`（不编一个署名）——
                # 读侧据此如实显示"没有人写过理由（超时策略的自动作废）"，见 ADR-0023。
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

    def signoff(self, *, scope: str, ref: str, signer: str,
                allow_self_approval: bool = False) -> dict:
        """**消费一扇已批准的门**（P48）：在账本重放出的记录里挑一扇，挑不到就抛 `SignoffRequired`。

        与 `require()` 的分工：`require()` 只答「有没有一条适用于这个 ref 的批准记录」；
        本方法答的是产品真正要的那一问 ——「**这一扇门是被谁批的、他是不是本该批的人、他是不是
        就是署名者本人**」。承诺 / 发 PO 两条主链走这一条（判据见 `signoff_verdict` 的 ①–⑤）。
        """
        record, refusal = select_signoff(self.records(), scope=scope, ref=ref, signer=signer,
                                         allow_self_approval=allow_self_approval)
        if record is None:
            assert refusal is not None
            raise SignoffRequired(refusal["code"], refusal["reason"], refusal["next_action"])
        return record

    def _append(self, event: str, record: dict, *, correlation_id: str | None,
                ts: str | None = None) -> None:
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
                           refs={"approval_id": record["approval_id"], "scope": record["scope"]},
                           ts=ts)
        if self.events is not None:
            self.events.emit(event, {"approval_id": record["approval_id"], "scope": record["scope"],
                                     "status": record["status"]})


def is_human(who: object) -> bool:
    """批准记录只能由人产生（`by` 以 `human:` 开头）——旧行也照这一条核。"""
    return str(who or "").startswith(HUMAN_PREFIX)


def named_approvers(record: dict) -> list[str]:
    """开单时**点名**的审批人（ADR-0022 的 `approvers` 派分事实；旧行没有这个键 ⇒ 空表）。"""
    return [str(who).strip() for who in (record.get("approvers") or []) if str(who).strip()]


def signoff_verdict(record: dict, *, scope: str, ref: str, signer: str,
                    allow_self_approval: bool = False) -> dict | None:
    """**人门判据**（唯一一处判定，P48）：一条批准记录是否可以被 `signer` 这次署名消费。

    返回 `None` = 可以消费；否则返回具名拒 `{code, reason, next_action}`。判据（缺一不可）：

      ① 引用对得上：`scope` 与 `ref` 都与被批的业务对象一致（FR-APPROVE-002，不可跨动作复用）；
      ② 已 granted（还在等 / 被驳回 / 被终止的门都不能消费）；
      ③ 批的人是人（`decided_by` 以 `human:` 开头）；
      ④ **批的人不是署名的人**（`allow_self_approval=False`，默认）——修前的写法在同一次落账里
         自己开单自己批，主管没有否决权；
      ⑤ 开单时**点名**了审批人（`approvers` 非空）⇒ 批的人必须是点名的那位（旧行没点名 ⇒ 只按
         ①②③④ 对账，并在回执里如实标「开单时未点名审批人」）。
    """
    scope, ref = str(scope), str(ref)
    if str(record.get("scope")) != scope or str(record.get("ref")) != ref:
        return {"code": "approval-ref-mismatch",
                "reason": f"批准 {record.get('approval_id')} 不适用于 scope={scope!r} ref={ref!r}"
                          f"（这条门是 scope={record.get('scope')!r} ref={record.get('ref')!r}）",
                "next_action": NEXT_OPEN_GATE}
    approval_id = str(record.get("approval_id") or "")
    status = str(record.get("status") or "pending")
    by = str(record.get("decided_by") or "")
    named = named_approvers(record)
    if status != "granted":
        if status == "pending":
            return {"code": "approval-not-granted",
                    "reason": f"门 {approval_id} 还在等（卡在 {'、'.join(named) or '（开单时没点名）'}）："
                              f"没人批之前不许承诺（谁批的必须另有其人）",
                    "next_action": NEXT_OPEN_GATE}
        if status == "denied":
            return {"code": "approval-denied",
                    "reason": f"门 {approval_id} 已被 {by or '（未记录署名）'} 驳回"
                              f"（{record.get('comment') or '账本没留意见正文'}）：驳回就是否决，不能当批准用",
                    "next_action": "按驳回理由改完再重新开一个门（原门不会被\"再批一次\"翻案）"}
        if status == "aborted":
            return {"code": "approval-aborted",
                    "reason": f"门 {approval_id} 已被终止（作废本次意图）：作废不是批准",
                    "next_action": "重新开一个门并请人批准（终止的门不可再批）"}
        return {"code": "approval-required", "reason": f"门 {approval_id} 的状态是 {status}：不可消费",
                "next_action": NEXT_OPEN_GATE}
    if not is_human(by):
        return {"code": "approver-not-human",
                "reason": f"门 {approval_id} 的署名不是人（decided_by={by or '（空）'}）：agent 不得代批（P8）",
                "next_action": "让人来自行批准（批准记录只能由人产生）"}
    if by == str(signer):
        if not allow_self_approval:
            return {"code": "approver-must-differ",
                    "reason": f"门 {approval_id} 是**你自己**批的（decided_by={by} == 你的署名 {signer}）："
                              f"自签自批不算人门 —— 主管（或任何一个别人）不批，你照样能签",
                    "next_action": NEXT_SWITCH}
        return None
    if named and by not in named:
        return {"code": "approver-not-named",
                "reason": f"门 {approval_id} 是 {by} 批的，但开单时点名的是 {'、'.join(named)}："
                          f"审批权在开单那一刻就定了，没点名的人批不了这一条",
                "next_action": "让点名的那位本人批（或先把门升级 / 委托给他，再回来重提）"}
    return None


def verify_signoff(record: dict, *, scope: str, ref: str, signer: str,
                   allow_self_approval: bool = False) -> dict:
    """把**已经拿到**的一扇批准记录按人门判据再核一遍；不通过 ⇒ 抛 `SignoffRequired`。

    服务层的结构性入口（`CommitmentGate.commit_award` / `issue_po` 都调它）：这样判据不只活
    在 GUI 的那一个写者里，任何调用方（测试、其它写者、以后的通道）都绕不过。
    """
    verdict = signoff_verdict(record, scope=scope, ref=ref, signer=signer,
                              allow_self_approval=allow_self_approval)
    if verdict is not None:
        raise SignoffRequired(verdict["code"], verdict["reason"], verdict["next_action"])
    return record


def select_signoff(records: list[dict], *, scope: str, ref: str, signer: str,
                   allow_self_approval: bool = False) -> tuple[dict | None, dict | None]:
    """**在已有批准记录里挑一扇可以消费的门**（承诺 / 发 PO 的唯一入口）。

    挑法：先按 `scope` + `ref` 取这一条业务引用上的全部门（账本顺序），在其中挑**最后一扇**
    `signoff_verdict` 通过的（= 最近一次真正通过的人门）；一扇都没有 ⇒ 用**最后一扇门**的状态
    给出最可行动的具名拒（没人开单 / 还在等 / 被驳回 / 自签自批 / 批的人不是点名的那位）。
    """
    scope, ref = str(scope), str(ref)
    candidates = [item for item in records
                  if str(item.get("scope")) == scope and str(item.get("ref")) == ref]
    if not candidates:
        return None, {"code": "approval-required",
                      "reason": f"账本里没有这扇门（scope={scope} ref={ref}）："
                                f"承诺与发 PO 必须**消费一扇已批准的门**，"
                                f"不能在同一次落账里自己开单、自己批准",
                      "next_action": NEXT_OPEN_GATE}
    eligible = [item for item in candidates
                if signoff_verdict(item, scope=scope, ref=ref, signer=signer,
                                   allow_self_approval=allow_self_approval) is None]
    if eligible:
        return eligible[-1], None
    return None, signoff_verdict(candidates[-1], scope=scope, ref=ref, signer=signer,
                                 allow_self_approval=allow_self_approval) or {
        "code": "approval-required", "reason": f"门（scope={scope} ref={ref}）不可消费",
        "next_action": NEXT_OPEN_GATE}


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
