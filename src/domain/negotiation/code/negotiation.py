"""ctx.negotiate 的 P2 实现（`04-services-catalog.md` §4）——有限轮次谈判 + 让步人工门。

契约（**逐字遵守**）：`docs/design/17-negotiation-contract.md`；决策依据
`docs/design/16-negotiation-design.md`、`docs/design/adr/0019-negotiation-rounds-and-concessions.md`。

一轮 = 对某条目的一次**价格让步提议**；身份键 `(thread_id, attempt_no)`（被拒的尝试也占号）。

不变量（契约 §7 / `ADR-0019`）：
1. 服务不写文件、不联网、**不读墙钟**：视图里的 `created_at` 取自账本行的 `ts`（由内核写入），
   判定链里没有任何时钟输入（D-042 / 契约 §3「不读墙钟判定」）；
2. **不产生义务**：没有 commitment 事件、没有 PO、没有对外报价出口（承诺仍只走授标路径）；
3. 让步空间只来自**既有事实**：成本模型 `unit_cost(item_id)["excl_tax"]` 与既有策略键
   `pricing.authorized_band.*`；三个 `negotiate.*` 键缺任一即抛 `NegotiationPolicyMissing`，
   **不兜默认值**；
4. **任何价格让步必经人工门**（`FR-NEGO-002`）：门判定只用
   `approval.require(scope="negotiate.price-concession", ref="{thread_id}:a{attempt_no}")`；
   越界/越限是**拒绝**（抛错 + 落 `negotiate/round-rejected`），不是「过门」；绝无自动批准；
5. 轮次用量与轮次号一律**从账本重建**（`replay()`，重启不重置）；
6. 事件模式（契约 §5）：`bounds-declared`=emit、`opened`=emit、`round`=serial（`intent` 类）、
   `round-rejected`=bail、`closed`=emit；无 `waterfall`。用错模式由内核拒绝。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Callable

from ..kernel.canon import digest
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from .approval import (AgentCannotApprove, ApprovalRequired, DEFAULT_TIMEOUT_POLICY,
                       DEFAULT_TIMEOUT_S, HUMAN_PREFIX)
from .costmodel import CostModelService, PrivateAccessDenied
from .pricing import PriceNotConfirmed

# --- 事件（契约 §5：名字与模式都不可改） -------------------------------------
BOUNDS_DECLARED_EVENT = "negotiate/bounds-declared"
OPENED_EVENT = "negotiate/opened"
ROUND_EVENT = "negotiate/round"
ROUND_REJECTED_EVENT = "negotiate/round-rejected"
CLOSED_EVENT = "negotiate/closed"

#: 契约 §5 的模式表（内核按此拒绝用错模式；本文件不自行发明模式）
EVENT_MODES = {
    BOUNDS_DECLARED_EVENT: "emit",
    OPENED_EVENT: "emit",
    ROUND_EVENT: "serial",
    ROUND_REJECTED_EVENT: "bail",
    CLOSED_EVENT: "emit",
}

#: 断言链（`negotiate/round` 的 serial 监听者，注册顺序 = 判定顺序，契约 §3）
STAGE_NAMES = ("dimension", "round_limit", "concession_limit", "floor", "band", "gate")

#: 恰好一个新增人工门 scope（不可跨动作/跨轮复用，FR-APPROVE-002）
CONCESSION_SCOPE = "negotiate.price-concession"

ROLES = ("supplier", "contractor")
MOVE_DIMENSIONS = ("price",)
OUTCOMES = ("accepted", "rejected", "withdrawn", "limit-reached")

#: 三个 negotiate.* 键：缺任一即拒（无默认值）
POLICY_KEYS = ("max_rounds", "max_concession_pct", "min_margin_pct")
#: `negotiate/bounds-declared` 的 body 关键键（契约 §5）
BOUNDS_BODY_KEYS = ("thread_id", "max_rounds", "max_concession_pct", "min_margin_pct", "band",
                    "cost_baseline", "cost_artifact_ref", "policy_hash", "source")

#: 拒绝码 → 落 `round-rejected` 时的轮次视图状态（契约 §2.2 的状态取值）
STATUS_BY_CODE = {
    "approval-required": "awaiting_approval",
    "approval-denied": "rejected",
    "approval-aborted": "aborted",
}


class NegotiationError(RuntimeError):
    """谈判错误基类（契约 §4）。"""

    code = "negotiation-error"


class NegotiationPolicyMissing(NegotiationError):
    """`negotiate.*` 键缺任一（**不兜默认值**）。"""

    code = "negotiation-policy-missing"


class ConcessionLimitExceeded(NegotiationError):
    """``delta_pct > max_concession_pct``。"""

    code = "concession-over-limit"


class ConcessionBelowFloor(NegotiationError):
    """``to < floor``。"""

    code = "concession-below-floor"


class ConcessionOutOfBand(NegotiationError):
    """``to`` 超出授权区间。"""

    code = "concession-out-of-band"


class RoundLimitExceeded(NegotiationError):
    """``attempt_no > max_rounds``。"""

    code = "round-limit-exceeded"


class NegotiationRoundConflict(NegotiationError):
    """同 `(thread_id, attempt_no)` 但内容不同（显式冲突，不静默追加第二条事实）。"""

    code = "round-conflict"


class UnsupportedMoveDimension(NegotiationError):
    """``dimension != "price"``（数量/交期/条款不在谈判面）。"""

    code = "unsupported-dimension"


class ThreadClosedError(NegotiationError):
    """对已关闭线程提交。"""

    code = "thread-closed"


class UnknownThread(NegotiationError):
    """不存在的线程 id。"""

    code = "unknown-thread"


class UnknownRound(NegotiationError):
    """不存在的轮次 id。"""

    code = "unknown-round"


#: 拒绝码 → 异常（契约 §4 的一一对应；同一族的门失败都复用既有 `ApprovalRequired`）
EXCEPTION_BY_CODE = {
    "negotiation-policy-missing": NegotiationPolicyMissing,
    "unsupported-dimension": UnsupportedMoveDimension,
    "round-limit-exceeded": RoundLimitExceeded,
    "concession-over-limit": ConcessionLimitExceeded,
    "concession-below-floor": ConcessionBelowFloor,
    "concession-out-of-band": ConcessionOutOfBand,
    "round-conflict": NegotiationRoundConflict,
    "thread-closed": ThreadClosedError,
    "unknown-thread": UnknownThread,
    "unknown-round": UnknownRound,
    "item-mismatch": NegotiationError,
    "move-invalid": NegotiationError,
    "move-direction-invalid": NegotiationError,
    "approval-required": ApprovalRequired,
    "approval-denied": ApprovalRequired,
    "approval-aborted": ApprovalRequired,
}


def _rejection(code: str, reason: str, next_action: str) -> dict:
    """拒绝体：`code` + 可行动结论（形状同 `quotes.py` 的 `code`/`next_action`）。"""
    return {"code": code, "reason": reason, "next_action": next_action}


# --- 纯函数（契约 §1：可单测、无副作用） -------------------------------------

def _negotiate_subtree(policy: dict) -> dict:
    """取 `negotiate` 子树；三个键缺任一即拒（**不兜默认值**）。"""
    subtree = (policy or {}).get("negotiate")
    if not isinstance(subtree, dict):
        raise NegotiationPolicyMissing(
            f"策略缺 negotiate 子树：需要 {list(POLICY_KEYS)}（三个键缺任一即拒，不兜默认值）")
    missing = [key for key in POLICY_KEYS if subtree.get(key) is None]
    if missing:
        raise NegotiationPolicyMissing(
            f"策略缺 negotiate.{missing[0]}（缺 {missing}）：轮次与让步上限必须由人设定基线，"
            f"不得凭空生成默认值（ADR-0019 §1.3）")
    return subtree


def _authorized_band(policy: dict) -> dict:
    """授权区间：既有键路径 `pricing.authorized_band.*`（契约 §2.3；兼容扁平的 `authorized_band`）。"""
    pricing = (policy or {}).get("pricing")
    if isinstance(pricing, dict) and isinstance(pricing.get("authorized_band"), dict):
        return dict(pricing["authorized_band"])
    flat = (policy or {}).get("authorized_band")
    return dict(flat) if isinstance(flat, dict) else {}


def derive_bounds(policy: dict, cost_unit: Any, *, item_id: str) -> dict:
    """从**既有事实**推导让步边界（纯函数，无副作用）。

    - `floor = max(cost_baseline × (1 + min_margin_pct/100), band.min_unit_price)`（取更紧的一侧）；
    - `ceiling = band.max_unit_price`；
    - `policy_hash = digest(negotiate 子树)`，`cost_artifact_ref` 来自成本工件（私域明细不出 realm）。
    """
    subtree = _negotiate_subtree(policy)
    if isinstance(cost_unit, dict):
        baseline = cost_unit.get("excl_tax")
        artifact_ref = str(cost_unit.get("artifact_hash") or "")
    else:
        baseline, artifact_ref = cost_unit, ""
    if baseline is None:
        raise NegotiationError(f"成本构成里没有条目 {item_id} 的不含税单价（不得猜测成本）")
    band = _authorized_band(policy)
    low, high = band.get("min_unit_price"), band.get("max_unit_price")
    margin = float(subtree["min_margin_pct"])
    floor = float(baseline) * (1.0 + margin / 100.0)
    if low is not None:
        floor = max(floor, float(low))
    return {
        "max_rounds": int(subtree["max_rounds"]),
        "max_concession_pct": float(subtree["max_concession_pct"]),
        "min_margin_pct": margin,
        "band": band,
        "cost_baseline": float(baseline),
        "cost_artifact_ref": artifact_ref,
        "policy_hash": digest(subtree),
        "source": str(subtree.get("source") or "human:policy"),
        "floor": floor,
        "ceiling": None if high is None else float(high),
    }


def _bounds_from_declaration(body: dict) -> dict:
    """从 `negotiate/bounds-declared` 的 body 重建边界视图（只用行内数字，不读成本模型）。"""
    band = dict(body.get("band") or {})
    baseline, margin = float(body["cost_baseline"]), float(body["min_margin_pct"])
    floor = baseline * (1.0 + margin / 100.0)
    low, high = band.get("min_unit_price"), band.get("max_unit_price")
    if low is not None:
        floor = max(floor, float(low))
    return {
        "max_rounds": int(body["max_rounds"]),
        "max_concession_pct": float(body["max_concession_pct"]),
        "min_margin_pct": margin,
        "band": band,
        "cost_baseline": baseline,
        "cost_artifact_ref": str(body.get("cost_artifact_ref") or ""),
        "policy_hash": str(body.get("policy_hash") or ""),
        "source": str(body.get("source") or ""),
        "floor": floor,
        "ceiling": None if high is None else float(high),
    }


def concession_delta(move: dict, role: str) -> float:
    """让步幅度（对己方**不利**方向的相对变化，%，≥0）。

    `role=supplier` 让步即下调单价；`role=contractor` 让步即上调。方向不对（不是让步）返回 0.0。
    """
    frm, to = move.get("from"), move.get("to")
    if not isinstance(frm, (int, float)) or isinstance(frm, bool) or not isinstance(to, (int, float)) \
            or isinstance(to, bool):
        raise NegotiationError(f"move.from/move.to 必须是数字（收到 {frm!r} → {to!r}）")
    frm, to = float(frm), float(to)
    if frm <= 0:
        raise NegotiationError(f"move.from 必须为正数（收到 {frm!r}）：让步幅度按相对变化计")
    if role == "supplier":
        delta = (frm - to) / frm * 100.0
    elif role == "contractor":
        delta = (to - frm) / frm * 100.0
    else:
        raise NegotiationError(f"未知的谈判视角 role={role!r}；取值: {list(ROLES)}")
    return delta if delta > 0 else 0.0


def _check_dimension(move: dict) -> dict | None:
    if str(move.get("dimension")) != "price":
        return _rejection("unsupported-dimension",
                          f"谈判轮只接受 dimension='price'，收到 {move.get('dimension')!r}",
                          "数量改动走包升版（FR-RFQ-003）、交期归 FR-CAP-002 的 firm 语义、"
                          "条款冲突只提请人工（FR-TERMS-002）")
    return None


def _check_concession(move: dict, bounds: dict, role: str) -> dict | None:
    limit = bounds.get("max_concession_pct")
    if limit is None:
        raise NegotiationPolicyMissing("边界里没有 max_concession_pct（不兜默认值）")
    delta = concession_delta(move, role)
    if delta > float(limit):
        return _rejection("concession-over-limit",
                          f"让步幅度 {delta:.6f}% 超过单次上限 {float(limit)}%",
                          "把让步拆小或改由人放宽 negotiate.max_concession_pct（humanOnly）")
    return None


def _check_floor(move: dict, bounds: dict) -> dict | None:
    floor = bounds.get("floor")
    if floor is None:
        return _rejection("move-invalid", "边界里没有 floor（不兜默认值）",
                          "请由人重新声明边界（declare_bounds）")
    to = float(move["to"])
    if to < float(floor):
        return _rejection("concession-below-floor",
                          f"让步后单价 {to} 低于成本底线 {float(floor)}（成本基线 × (1+余量) 与区间下限取更紧侧）",
                          "提高让步后单价，或由人调整成本基线与 min_margin_pct")
    return None


def _check_band(move: dict, bounds: dict) -> dict | None:
    band = dict(bounds.get("band") or {})
    low, high = band.get("min_unit_price"), band.get("max_unit_price")
    to = float(move["to"])
    if (low is not None and to < float(low)) or (high is not None and to > float(high)):
        return _rejection("concession-out-of-band",
                          f"让步后单价 {to} 超出授权区间 [{low}, {high}]",
                          "回到授权区间内，或由人放宽 pricing.authorized_band.*（humanOnly）")
    return None


def check_move(move: dict, bounds: dict, role: str) -> dict | None:
    """纯判定（契约 §1）：返回 `None` 表示通过，否则返回拒绝体（serial 链「首个非 None 即停」）。"""
    for verdict in (_check_dimension(move),
                    _check_concession(move, bounds, role),
                    _check_floor(move, bounds),
                    _check_band(move, bounds)):
        if verdict is not None:
            return verdict
    return None


# --- 服务 ---------------------------------------------------------------------

@dataclass
class NegotiationService:
    """`ctx.negotiate` 的 P2 Provider（一轮一件事；账本是唯一事实源）。"""

    cost_service: CostModelService
    pricing: Any
    approval: Any
    ledger: Ledger | None = None
    events: EventBus | None = None
    policy: dict = field(default_factory=dict)
    actor: str = "agent:negotiate"
    _threads: dict[str, dict] = field(default_factory=dict, init=False)
    _rounds: dict[str, dict] = field(default_factory=dict, init=False)
    _order: list[str] = field(default_factory=list, init=False)
    _counter: int = field(default=0, init=False)
    _attached: bool = field(default=False, init=False)
    #: 最后一次账本追加的 `{seq, entry_hash, duplicate}`（只读观测量，不进任何视图）
    last_append: dict | None = field(default=None, init=False)
    replayed: int = field(default=0, init=False)
    #: **落账时刻的显式覆盖**（缺省 `None` = 既有行为：内核 `utc_now()`）。
    #: 为什么有这一个字段：本服务是"服务直调"的主语（`ctx.negotiate` 由宿主装配），而 UI 路径上的
    #: 落账一律由**唯一写者**发起，写者不许读墙钟（`usage.md` §7.3：`--now` 必填）。
    #: 写者构造本服务后设一次 `service.write_ts = --now`，此后本服务**所有**追加都用它；
    #: 不给（既有调用方：宿主装配、单测、走查脚本）⇒ 逐字节与改前一致（内核给 `utc_now()`）。
    write_ts: str | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        if self.approval is None:
            # 契约 §1：approval 为 None 时直接拒绝（不允许旁路，对齐 pricing.py:224-225 的写法）
            raise NegotiationError("价格让步必须过人工门：构造期必须接上 ctx.approval（不允许旁路）")
        if self.ledger is not None:
            self.replayed = self.replay()["replayed"]

    # --- 装配 -------------------------------------------------------------
    def set_policy(self, policy: dict) -> None:
        self.policy = dict(policy)

    def attach(self, ctx) -> None:
        self._register_stages(lambda name, fn: ctx.on(name, fn, label=f"negotiate:{fn.__name__}"))

    def attach_defaults(self) -> None:
        """把判定链注册到 `negotiate/round`（serial）；重复调用不重复注册。"""
        if self._attached:
            return
        if self.events is None:
            raise NegotiationError("没有事件总线，无法装配谈判判定链（不允许无判定地推进）")
        if self.events.mode_of(ROUND_EVENT) is None:
            self.events.declare(ROUND_EVENT, "serial")
        events = self.events
        self._register_stages(lambda name, fn: events.on(name, fn, label=f"negotiate:{fn.__name__}"))

    def _register_stages(self, register: Callable[[str, Callable], Any]) -> None:
        for stage in (self._stage_dimension, self._stage_round_limit, self._stage_concession_limit,
                      self._stage_floor, self._stage_band, self._stage_gate):
            register(ROUND_EVENT, stage)
        self._attached = True

    # --- 线程 -------------------------------------------------------------
    def open_thread(self, *, package_id: str, rfq_rev: int, counterparty: str, role: str,
                    quote_id: str, proposal_id: str, item_id: str,
                    bounds: dict | None = None, declared_by: str = HUMAN_PREFIX) -> dict:
        """开线程：落 `negotiate/bounds-declared` + `negotiate/opened`（不落任何承诺类事实）。"""
        if self.ledger is not None:
            self.ledger.assert_healthy()
        if not str(declared_by).startswith(HUMAN_PREFIX):
            raise AgentCannotApprove(
                f"边界只能由人声明（declared_by 必须以 {HUMAN_PREFIX!r} 开头），收到 {declared_by!r}"
                f"（host/lib/frozen.mjs:55-58 同口径）")
        if role not in ROLES:
            raise NegotiationError(f"role 必须是 {list(ROLES)} 之一，收到 {role!r}")
        if isinstance(rfq_rev, bool) or not isinstance(rfq_rev, int) or rfq_rev < 1:
            raise NegotiationError(f"rfq_rev 必须是正整数（包版本绑定是硬要求），收到 {rfq_rev!r}")
        for label, value in (("package_id", package_id), ("counterparty", counterparty),
                             ("quote_id", quote_id), ("item_id", item_id), ("proposal_id", proposal_id)):
            if not str(value or "").strip():
                raise NegotiationError(f"{label} 不能为空（线程必须挂在既有对象上）")
        if self.pricing is None or not self.pricing.is_confirmed(proposal_id):
            raise PriceNotConfirmed(
                f"定价建议 {proposal_id} 尚未获得人确认：谈判只能挂在已人确认的 proposal_id 上"
                f"（FR-PRICE-002）")

        resolved = self._resolve_bounds(item_id=item_id, declared=bounds, source=declared_by)
        self._counter += 1
        thread_id = f"nt-{self._counter:04d}"
        refs = {"thread_id": thread_id, "package_id": package_id, "quote_id": quote_id,
                "item_id": item_id}
        self._append(BOUNDS_DECLARED_EVENT, self._bounds_body(thread_id, resolved),
                     correlation_id=thread_id, event_class="fact", refs=refs)
        opened = self._append(OPENED_EVENT, {
            "thread_id": thread_id, "package_id": package_id, "rfq_rev": int(rfq_rev),
            "counterparty": counterparty, "role": role, "quote_id": quote_id,
            "proposal_id": proposal_id, "item_id": item_id, "bounds_hash": digest(resolved),
        }, correlation_id=thread_id, event_class="fact", refs=refs)
        thread = {
            "thread_id": thread_id, "package_id": package_id, "rfq_rev": int(rfq_rev),
            "counterparty": counterparty, "role": role, "quote_id": quote_id,
            "proposal_id": proposal_id, "item_id": item_id,
            "bounds": copy.deepcopy(resolved), "bounds_hash": digest(resolved),
            "status": "open", "rounds_used": 0, "max_rounds": int(resolved["max_rounds"]),
            "created_at": self._ts(opened), "closed_at": None, "outcome": None, "refs": refs,
        }
        self._threads[thread_id] = thread
        self._order.append(thread_id)
        return self._thread_view(thread)

    def declare_bounds(self, thread_id: str, bounds: dict, *, by: str, reason: str = "") -> dict:
        """人工改限：**只追加**一条新的 `negotiate/bounds-declared`（不改旧行、不删旧行）。"""
        thread = self._require_thread(thread_id)
        self._require_open(thread)
        if not str(by).startswith(HUMAN_PREFIX):
            raise AgentCannotApprove(
                f"边界只能由人声明（by 必须以 {HUMAN_PREFIX!r} 开头），收到 {by!r}")
        resolved = self._resolve_bounds(item_id=thread["item_id"], declared=bounds, source=by,
                                        base=thread["bounds"])
        body = self._bounds_body(thread_id, resolved)
        body["reason"] = reason
        self._append(BOUNDS_DECLARED_EVENT, body, correlation_id=thread_id, event_class="fact",
                     actor=by, refs=dict(thread["refs"]))
        thread["bounds"] = resolved
        thread["bounds_hash"] = digest(resolved)
        thread["max_rounds"] = int(resolved["max_rounds"])
        return self._thread_view(thread)

    # --- 门请求（人工批准前的必要一步） -----------------------------------
    def request_concession(self, thread_id: str, move: dict, *, reason: str = "",
                           timeout_policy: str = DEFAULT_TIMEOUT_POLICY,
                           timeout_s: float = DEFAULT_TIMEOUT_S,
                           escalate_to: str | None = None) -> dict:
        """为一次价格让步请求人工门（返回批准记录视图）。

        只调用既有 `approval.request`：非法超时策略由既有实现拒绝；**不传 granted、不做预批准**。
        """
        thread = self._require_thread(thread_id)
        self._require_open(thread)
        move = self._move_view(move)
        attempt_no = self.rounds_used(thread_id) + 1
        bounds = dict(thread["bounds"] or {})
        payload = {
            "thread_id": thread_id, "attempt_no": attempt_no, "item_id": thread["item_id"],
            "from": float(move["from"]), "to": float(move["to"]),
            "delta_pct": concession_delta(move, thread["role"]),
            "floor": bounds.get("floor"), "ceiling": bounds.get("ceiling"),
            "cost_artifact_ref": bounds.get("cost_artifact_ref"),
            "bounds_hash": thread["bounds_hash"], "citations": self._citations(thread),
        }
        return dict(self.approval.request(
            CONCESSION_SCOPE, payload, ref=self._gate_ref(thread_id, attempt_no), reason=reason,
            timeout_policy=timeout_policy, timeout_s=timeout_s, escalate_to=escalate_to,
            at=self.write_ts))

    # --- 轮次 -------------------------------------------------------------
    def submit_round(self, thread_id: str, *, move: dict, rationale: str = "",
                     approval_id: str | None = None) -> dict:
        """提交一轮：判定链（维度 → 轮次上限 → 幅度 → 底线 → 区间 → 门）通过才落 `negotiate/round`。"""
        thread = self._require_thread(thread_id)
        self._require_open(thread)
        move = self._move_view(move)
        attempt_no = self._attempt_no_for(thread_id, approval_id)
        round_id = self._round_id(thread_id, attempt_no)
        round_key = self._round_key(thread_id, attempt_no, move, thread["bounds_hash"])
        content = self._content_digest(thread_id, move, thread["bounds_hash"])
        existing = self._rounds.get(round_id)
        if existing is not None and existing["_type"] == "round":
            if existing["_content"] == content:
                # 同一轮的重复提交：重新走一次账本追加（去重命中 → 不产生第二条事实）
                self._append(ROUND_EVENT, existing["_body"], correlation_id=thread_id,
                             event_class="intent", refs=thread["refs"])
                return self._round_view(existing)
            raise NegotiationRoundConflict(
                f"轮次 {round_id} 已存在且内容不同：拒绝静默追加第二条事实"
                f"（原 round_key={existing['round_key']}，新 round_key={round_key}）")
        if self.events is None:
            raise NegotiationError("轮次判定链就是 negotiate/round 的 serial 链：没有事件总线即无判定，"
                                   "不允许旁路")
        if self.ledger is not None:
            self.ledger.assert_healthy()
        if not self._attached:
            self.attach_defaults()
        if self.events.listener_count(ROUND_EVENT) < 1:
            raise NegotiationError(
                "negotiate/round 判定链没有任何监听者：不允许无判定地推进（先 attach_defaults()）")
        work = {
            "thread_id": thread_id, "attempt_no": attempt_no, "round_id": round_id,
            "round_key": round_key, "content": content, "move": move, "item_id": thread["item_id"],
            "role": thread["role"], "bounds": dict(thread["bounds"] or {}),
            "band": dict((thread["bounds"] or {}).get("band") or {}),
            "bounds_hash": thread["bounds_hash"], "approval_id": approval_id,
            "approval_ref": self._gate_ref(thread_id, attempt_no), "rationale": rationale,
            "citations": self._citations(thread), "in_band": False, "delta_pct": None,
        }
        verdict = self.events.serial(ROUND_EVENT, work)
        if verdict is not None:  # serial：首个非 None 即停 → 拒绝体
            return self._reject(thread, work, verdict)
        return self._land(thread, work)

    def recompute(self, round_id: str) -> dict:
        """纯复算：只用账本行内数字重算 floor/ceiling/Δ%/是否越界（逐字节可复现，无时间戳）。"""
        record = self._rounds.get(round_id)
        if record is None or record["_type"] != "round":
            raise UnknownRound(
                f"不可复算的轮次 {round_id}：只有已落账的 negotiate/round 行才有边界数字"
                f"（被拒轮只有 round-rejected 留痕）")
        realm = getattr(self.cost_service, "realm", None)
        if realm is not None and str(record.get("_realm")) != str(realm):
            raise PrivateAccessDenied(
                f"轮次 {round_id} 的边界数字来自 realm {record.get('_realm')!r} 的成本模型，"
                f"{realm!r} 不得复算（FR-COST-002 / P5：私域永不出 realm）")
        bounds = dict(record.get("_bounds") or {})
        move = dict(record["move"])
        band = dict(record.get("band") or {})
        delta = concession_delta(move, record.get("_role") or "")
        to = float(move["to"])
        low, high = band.get("min_unit_price"), band.get("max_unit_price")
        floor = self._derive_floor(bounds)
        ceiling = None if high is None else float(high)
        in_band = (low is None or to >= float(low)) and (high is None or to <= float(high))
        limit = bounds.get("max_concession_pct")
        out = {
            "round_id": round_id, "round_key": record["round_key"],
            "thread_id": record["thread_id"], "attempt_no": int(record["attempt_no"]),
            "move": move, "bounds_hash": record["_bounds_hash"],
            "policy_hash": bounds.get("policy_hash"),
            "floor": floor, "ceiling": ceiling, "band": band,
            "delta_pct": delta, "in_band": in_band, "above_floor": floor is None or to >= float(floor),
            "within_limit": None if limit is None else delta <= float(limit),
            "reproduced": (self._same(record.get("delta_pct"), delta)
                           and bool(record.get("in_band")) == in_band
                           and self._same(record.get("floor"), floor)
                           and self._same(record.get("ceiling"), ceiling)),
        }
        return out

    def rounds_used(self, thread_id: str) -> int:
        """已用轮次：**从账本重建**（含被拒尝试；重启不重置）。"""
        self._require_thread(thread_id)
        attempts = {int(rec["attempt_no"]) for rec in self._rounds.values()
                    if rec["thread_id"] == thread_id}
        return len(attempts)

    def close(self, thread_id: str, *, outcome: str, by: str, comment: str = "") -> dict:
        """关闭线程（**不产生义务**：无 commitment 事件、无 PO、无对外报价）。"""
        thread = self._require_thread(thread_id)
        self._require_open(thread)
        if outcome not in OUTCOMES:
            raise NegotiationError(f"outcome 必须是 {list(OUTCOMES)} 之一，收到 {outcome!r}")
        if not str(by).startswith(HUMAN_PREFIX):
            raise AgentCannotApprove(
                f"线程结局必须由人给定（by 必须以 {HUMAN_PREFIX!r} 开头），收到 {by!r}")
        if outcome == "accepted" and not (self.pricing is not None
                                          and self.pricing.is_confirmed(thread["proposal_id"])):
            raise PriceNotConfirmed(
                f"outcome=accepted 要求本线程引用的定价建议 {thread['proposal_id']} 仍处于已人确认态"
                f"（FR-PRICE-002）")
        round_keys = [rec["round_key"] for rec in self._rounds.values()
                      if rec["thread_id"] == thread_id and rec["_type"] == "round"]
        body = {"thread_id": thread_id, "outcome": outcome, "decided_by": by,
                "rounds_used": self.rounds_used(thread_id), "round_keys": round_keys,
                "comment": comment}
        ref = self._append(CLOSED_EVENT, body, correlation_id=thread_id, event_class="fact",
                           actor=by, refs=dict(thread["refs"]))
        thread["status"] = "closed"
        thread["outcome"] = outcome
        thread["closed_at"] = self._ts(ref)
        return self._thread_view(thread)

    # --- 查询 -------------------------------------------------------------
    def get_thread(self, thread_id: str) -> dict:
        return self._thread_view(self._require_thread(thread_id))

    def get_round(self, round_id: str) -> dict:
        record = self._rounds.get(round_id)
        if record is None:
            raise UnknownRound(f"不存在的轮次: {round_id}")
        return self._round_view(record)

    def threads(self) -> list[dict]:
        return [self._thread_view(self._threads[thread_id]) for thread_id in self._order]

    def rounds(self, thread_id: str) -> list[dict]:
        self._require_thread(thread_id)
        records = [rec for rec in self._rounds.values() if rec["thread_id"] == thread_id]
        records.sort(key=lambda rec: (rec["thread_id"], int(rec["attempt_no"]), rec["_type"]))
        return [self._round_view(rec) for rec in records]

    def replay(self) -> dict:
        """从账本重建线程/轮次/计数器（**账本是唯一事实源**；重启不重置轮次用量）。"""
        if self.ledger is None:
            return {"replayed": 0, "threads": [], "rounds": 0, "note": "无账本，无法重放"}
        threads: dict[str, dict] = {}
        rounds: dict[str, dict] = {}
        order: list[str] = []
        bounds_by_thread: dict[str, dict] = {}
        live_bounds: dict[str, dict] = {}
        live_hash: dict[str, str] = {}
        for row in self.ledger.read():
            type_, body = str(row.get("type")), (row.get("body") or {})
            if not type_.startswith("negotiate/"):
                continue
            thread_id = body.get("thread_id")
            if type_ == BOUNDS_DECLARED_EVENT and thread_id:
                snapshot = _bounds_from_declaration(body)
                bounds_by_thread[thread_id] = snapshot
                live_bounds[thread_id] = snapshot
                live_hash[thread_id] = digest(snapshot)
            elif type_ == OPENED_EVENT and thread_id and thread_id not in threads:
                order.append(thread_id)
                threads[thread_id] = {
                    "thread_id": thread_id, "package_id": body.get("package_id"),
                    "rfq_rev": body.get("rfq_rev"), "counterparty": body.get("counterparty"),
                    "role": body.get("role"), "quote_id": body.get("quote_id"),
                    "proposal_id": body.get("proposal_id"), "item_id": body.get("item_id"),
                    "bounds": None, "bounds_hash": body.get("bounds_hash"), "status": "open",
                    "rounds_used": 0, "max_rounds": None, "created_at": row.get("ts"),
                    "closed_at": None, "outcome": None,
                    "refs": {"thread_id": thread_id, "package_id": body.get("package_id"),
                             "quote_id": body.get("quote_id"), "item_id": body.get("item_id")},
                }
            elif type_ == ROUND_EVENT and thread_id:
                attempt_no = int(body.get("attempt_no") or 0)
                round_id = self._round_id(thread_id, attempt_no)
                view = self._round_view_of(row, body, attempt_no, "conceded")
                rounds[round_id] = {**view, "_type": "round", "_body": dict(body),
                                    "_content": self._content_digest(
                                        thread_id, body.get("move") or {},
                                        live_hash.get(thread_id)),
                                    "_realm": row.get("realm"), "_role": (threads.get(thread_id) or {}).get("role"),
                                    "_bounds": dict(live_bounds.get(thread_id) or {}),
                                    "_bounds_hash": live_hash.get(thread_id)}
            elif type_ == ROUND_REJECTED_EVENT and thread_id:
                attempt_no = int(body.get("attempt_no") or 0)
                round_id = self._round_id(thread_id, attempt_no)
                view = self._round_view_of(row, body, attempt_no, None)
                rounds[round_id] = {**view, "_type": "rejected", "_body": dict(body),
                                    "_content": self._content_digest(
                                        thread_id, body.get("move") or {},
                                        live_hash.get(thread_id)),
                                    "_realm": row.get("realm"), "_role": (threads.get(thread_id) or {}).get("role"),
                                    "_bounds": dict(live_bounds.get(thread_id) or {}),
                                    "_bounds_hash": live_hash.get(thread_id)}
            elif type_ == CLOSED_EVENT and thread_id and thread_id in threads:
                threads[thread_id]["status"] = "closed"
                threads[thread_id]["outcome"] = body.get("outcome")
                threads[thread_id]["closed_at"] = row.get("ts")
        for thread_id, thread in threads.items():
            snapshot = bounds_by_thread.get(thread_id)
            if snapshot:
                thread["bounds"] = snapshot
                thread["max_rounds"] = int(snapshot["max_rounds"])
                # 线程当前边界 = 最近一次 `bounds-declared`；哈希必须跟着它走（否则视图自相矛盾）
                thread["bounds_hash"] = live_hash.get(thread_id) or thread.get("bounds_hash")
        self._threads = threads
        self._rounds = rounds
        self._order = order
        self._counter = max([int(item.rsplit("-", 1)[-1]) for item in order
                             if item.rsplit("-", 1)[-1].isdigit()] or [0])
        used = {thread_id: self.rounds_used(thread_id) for thread_id in order}
        for thread_id, count in used.items():
            self._threads[thread_id]["rounds_used"] = count
        return {"replayed": len(threads), "order": list(order), "rounds": len(rounds),
                "rounds_used": used}

    # ==================================================================
    # 判定链（`negotiate/round` 的 serial 监听者：返回 None 表示本环通过，返回拒绝体即停）
    # ==================================================================
    def _stage_dimension(self, work: dict) -> Any:
        verdict = _check_dimension(work["move"])
        if verdict is not None:
            return verdict
        if str(work["move"].get("item_id")) != str(work["item_id"]):
            return _rejection("item-mismatch",
                              f"move.item_id={work['move'].get('item_id')!r} 与线程条目 "
                              f"{work['item_id']!r} 不一致",
                              "本轮只能谈线程绑定的条目；换条目请另开线程")
        if float(work["move"]["from"]) <= 0:
            return _rejection("move-invalid", "move.from 必须为正数（让步幅度按相对变化计）",
                              "给出正确的让步前后单价")
        frm, to, role = float(work["move"]["from"]), float(work["move"]["to"]), work["role"]
        adverse = (to < frm) if role == "supplier" else (to > frm)
        if not adverse:
            return _rejection(
                "move-direction-invalid",
                f"role={role} 的让步方向是{'下调' if role == 'supplier' else '上调'}单价，"
                f"收到 {frm} → {to}",
                "让步必须是朝对己方不利方向的变化；对方新价请按既有报价修订登记")
        return None

    def _stage_round_limit(self, work: dict) -> Any:
        thread = self._threads[work["thread_id"]]
        cap = thread.get("max_rounds")
        if cap is None:
            raise NegotiationPolicyMissing("线程没有 max_rounds（不兜默认值）")
        if int(work["attempt_no"]) > int(cap):
            return _rejection("round-limit-exceeded",
                              f"第 {work['attempt_no']} 次尝试超过轮次上限 {int(cap)}"
                              f"（被拒尝试也占号）",
                              "由人放宽 negotiate.max_rounds（humanOnly）或关闭线程重开")
        return None

    def _stage_concession_limit(self, work: dict) -> Any:
        work["delta_pct"] = concession_delta(work["move"], work["role"])
        return _check_concession(work["move"], work["bounds"], work["role"])

    def _stage_floor(self, work: dict) -> Any:
        return _check_floor(work["move"], work["bounds"])

    def _stage_band(self, work: dict) -> Any:
        verdict = _check_band(work["move"], work["bounds"])
        if verdict is not None:
            return verdict
        work["in_band"] = True
        return None

    def _stage_gate(self, work: dict) -> Any:
        """门：**只用 `approval.require(scope=..., ref=...)`** 判定批没批（不允许旁路）。"""
        ref = work["approval_ref"]
        if self.approval is None:
            return _rejection("approval-required",
                              "价格让步必须过人工门，但本服务未接上 ctx.approval（不允许旁路）",
                              "装配 ctx.approval 后重新提交；门只能由 human:* 决定")
        try:
            record = self.approval.require(scope=CONCESSION_SCOPE, ref=ref,
                                           approval_id=work.get("approval_id"))
        except ApprovalRequired as exc:
            state = self._gate_state(ref)
            code = {"aborted": "approval-aborted", "denied": "approval-denied"}.get(
                str(state or ""), "approval-required")
            return _rejection(
                code,
                f"价格让步缺少有效人工批准（scope={CONCESSION_SCOPE!r} ref={ref!r} "
                f"门状态={state or 'none'}）：{exc}",
                "先 request_concession 并由 human:* 调 decide(decision='granted')，"
                "再用同一 approval_id 提交本轮")
        work["approval_id"] = record["approval_id"]
        return None

    # ==================================================================
    # 内部
    # ==================================================================
    def _reject(self, thread: dict, work: dict, verdict: dict) -> dict:
        code = str(verdict.get("code") or "rejected")
        reason = str(verdict.get("reason") or "")
        next_action = str(verdict.get("next_action") or "")
        body = {"thread_id": work["thread_id"], "attempt_no": int(work["attempt_no"]),
                "code": code, "reason": reason, "next_action": next_action,
                "move": copy.deepcopy(work["move"])}
        ref = self._append(ROUND_REJECTED_EVENT, body, correlation_id=work["thread_id"],
                           event_class="fact", refs=dict(thread["refs"]))
        view = {
            "round_id": work["round_id"], "round_key": work["round_key"],
            "thread_id": work["thread_id"], "attempt_no": int(work["attempt_no"]),
            "move": copy.deepcopy(work["move"]), "delta_pct": work.get("delta_pct"),
            "requested_price": float(work["move"]["to"]), "floor": work["bounds"].get("floor"),
            "ceiling": work["bounds"].get("ceiling"), "band": dict(work["band"]),
            "in_band": False, "status": STATUS_BY_CODE.get(code, "rejected"),
            "approval_id": None, "approval_scope": CONCESSION_SCOPE,
            "approval_ref": work["approval_ref"], "citations": list(work["citations"]),
            "code": code, "reason": reason, "next_action": next_action, "created_at": self._ts(ref),
        }
        self._rounds[work["round_id"]] = {**view, "_type": "rejected", "_body": body,
                                          "_content": work["content"], "_realm": self._realm(),
                                          "_role": work["role"], "_bounds": dict(work["bounds"]),
                                          "_bounds_hash": work["bounds_hash"]}
        raise EXCEPTION_BY_CODE.get(code, NegotiationError)(f"[{code}] {reason}；下一步: {next_action}")

    def _land(self, thread: dict, work: dict) -> dict:
        body = {
            "thread_id": work["thread_id"], "attempt_no": int(work["attempt_no"]),
            "round_key": work["round_key"], "move": copy.deepcopy(work["move"]),
            "delta_pct": work.get("delta_pct"), "floor": work["bounds"].get("floor"),
            "ceiling": work["bounds"].get("ceiling"), "band": dict(work["band"]),
            "in_band": bool(work.get("in_band")), "approval_id": work.get("approval_id"),
            "status": "conceded", "citations": list(work["citations"]),
        }
        ref = self._append(ROUND_EVENT, body, correlation_id=work["thread_id"],
                           event_class="intent", refs=dict(thread["refs"]))
        view = {
            "round_id": work["round_id"], "round_key": work["round_key"],
            "thread_id": work["thread_id"], "attempt_no": int(work["attempt_no"]),
            "move": copy.deepcopy(work["move"]), "delta_pct": work.get("delta_pct"),
            "requested_price": float(work["move"]["to"]), "floor": work["bounds"].get("floor"),
            "ceiling": work["bounds"].get("ceiling"), "band": dict(work["band"]),
            "in_band": bool(work.get("in_band")), "status": "conceded",
            "approval_id": work.get("approval_id"), "approval_scope": CONCESSION_SCOPE,
            "approval_ref": work["approval_ref"], "citations": list(work["citations"]),
            "code": "", "reason": "", "next_action": "", "created_at": self._ts(ref),
        }
        self._rounds[work["round_id"]] = {**view, "_type": "round", "_body": body,
                                          "_content": work["content"], "_realm": self._realm(),
                                          "_role": work["role"], "_bounds": dict(work["bounds"]),
                                          "_bounds_hash": work["bounds_hash"]}
        thread["rounds_used"] = self.rounds_used(work["thread_id"])
        return self._round_view(self._rounds[work["round_id"]])

    # --- 边界 -------------------------------------------------------------
    def _resolve_bounds(self, *, item_id: str, declared: dict | None, source: str,
                        base: dict | None = None) -> dict:
        """推导 + （人工声明的）覆盖；三个 `negotiate.*` 键缺任一即拒（**不兜默认值**）。"""
        unit = self.cost_service.unit_cost(item_id)
        if isinstance(unit, dict):
            unit = dict(unit)
            unit.setdefault("artifact_hash", self._cost_artifact_ref())
        resolved = derive_bounds(self.policy, unit, item_id=item_id)
        if declared:
            unknown = [key for key in declared if key not in resolved]
            if unknown:
                raise NegotiationError(f"边界里有未知键 {unknown}；允许的键: {sorted(resolved)}")
            merged = dict(base or resolved)
            merged.update({key: declared[key] for key in declared})
            for key in ("floor", "ceiling"):
                merged.pop(key, None)
            for key in ("max_rounds", "max_concession_pct", "min_margin_pct", "cost_baseline", "band",
                        "cost_artifact_ref", "policy_hash"):
                if merged.get(key) is None:
                    raise NegotiationPolicyMissing(f"边界缺 {key}（不兜默认值）")
            resolved = {**merged, "source": str(source),
                        "floor": self._derive_floor(merged),
                        "ceiling": (None if (merged.get("band") or {}).get("max_unit_price") is None
                                    else float(merged["band"]["max_unit_price"]))}
            resolved["max_rounds"] = int(resolved["max_rounds"])
            resolved["max_concession_pct"] = float(resolved["max_concession_pct"])
            resolved["min_margin_pct"] = float(resolved["min_margin_pct"])
            resolved["cost_baseline"] = float(resolved["cost_baseline"])
        else:
            resolved["source"] = str(source)
        return resolved

    def _bounds_body(self, thread_id: str, bounds: dict) -> dict:
        body = {key: bounds.get(key) for key in BOUNDS_BODY_KEYS}
        body["thread_id"] = thread_id
        return body

    def _cost_artifact_ref(self) -> str:
        model = self.cost_service.as_dict()
        return str(model.get("artifact_hash") or "")

    @staticmethod
    def _derive_floor(bounds: dict) -> float | None:
        baseline, margin = bounds.get("cost_baseline"), bounds.get("min_margin_pct")
        if baseline is None or margin is None:
            return None
        floor = float(baseline) * (1.0 + float(margin) / 100.0)
        low = (bounds.get("band") or {}).get("min_unit_price")
        if low is not None:
            floor = max(floor, float(low))
        return floor

    @staticmethod
    def _same(left: Any, right: Any) -> bool:
        if left is None or right is None:
            return left is None and right is None
        try:
            return abs(float(left) - float(right)) < 1e-12
        except (TypeError, ValueError):
            return left == right

    # --- 编号与形状 -------------------------------------------------------
    @staticmethod
    def _round_id(thread_id: str, attempt_no: int) -> str:
        return f"{thread_id}#{int(attempt_no):02d}"

    @staticmethod
    def _gate_ref(thread_id: str, attempt_no: int) -> str:
        return f"{thread_id}:a{int(attempt_no)}"

    @staticmethod
    def _round_key(thread_id: str, attempt_no: int, move: dict, bounds_hash: str | None) -> str:
        return "neg:" + digest({"thread_id": thread_id, "attempt_no": int(attempt_no),
                                "move": move, "bounds_hash": bounds_hash})[:12]

    @staticmethod
    def _content_digest(thread_id: str, move: dict, bounds_hash: str | None) -> str:
        """一轮的**内容**（不含 attempt_no）：同内容即同一轮，复提幂等；不同内容即冲突。"""
        return digest({"thread_id": thread_id, "move": move, "bounds_hash": bounds_hash})

    def _attempt_no_for(self, thread_id: str, approval_id: str | None) -> int:
        """轮次号：有批准引用时取门引用里的号（门请求即分配轮次号，且不可跨轮复用）；
        否则取账本重建的下一个号（被拒尝试也占号）。"""
        if approval_id:
            number = self._attempt_from_gate_refs(thread_id, approval_id)
            if number is not None:
                return number
        return self.rounds_used(thread_id) + 1

    def _attempt_from_gate_refs(self, thread_id: str, approval_id: str) -> int | None:
        """从账本的 `approval/*` 行回读该批准绑定的轮次号（`ref = "{thread_id}:a{N}"`）。"""
        if self.ledger is None:
            return None
        prefix = f"{thread_id}:a"
        for row in self.ledger.read():
            if not str(row.get("type", "")).startswith("approval/"):
                continue
            if (row.get("refs") or {}).get("approval_id") != approval_id:
                continue
            ref = str(row.get("correlation_id") or "")
            tail = ref[len(prefix):] if ref.startswith(prefix) else ""
            if tail.isdigit():
                return int(tail)
        return None

    def _gate_state(self, ref: str) -> str | None:
        """门状态（只读账本，供拒绝体区分"未决/被否/作废"；**不参与任何放行判定**）。"""
        if self.ledger is None:
            return None
        state = None
        for row in self.ledger.read():
            if not str(row.get("type", "")).startswith("approval/"):
                continue
            if str(row.get("correlation_id") or "") != ref:
                continue
            state = str((row.get("body") or {}).get("status") or state)
        return state

    def _move_view(self, move: Any) -> dict:
        if not isinstance(move, dict):
            raise NegotiationError(f"move 必须是对象（收到 {type(move).__name__}）")
        missing = [key for key in ("dimension", "item_id", "from", "to") if key not in move]
        if missing:
            raise NegotiationError(f"move 缺键 {missing}：形状为 "
                                   f"{{dimension, item_id, from, to, unit}}")
        out = dict(move)
        out["unit"] = str(move.get("unit") or "")
        return out

    def _citations(self, thread: dict) -> list[str]:
        """只用既有前缀集合：`ledger:` / `package:` / `quote:` / `policy:`（不新增前缀）。"""
        bounds = dict(thread.get("bounds") or {})
        return [
            f"ledger:{thread['thread_id']}",
            f"package:{thread['package_id']}@rev{thread['rfq_rev']}",
            f"quote:{thread['quote_id']}",
            f"policy:bounds={thread.get('bounds_hash')}",
            f"policy:cost_artifact_ref={bounds.get('cost_artifact_ref')}",
        ]

    def _realm(self) -> str | None:
        return None if self.ledger is None else self.ledger.realm

    def _append(self, event: str, body: dict, *, correlation_id: str, event_class: str,
                actor: str | None = None, refs: dict | None = None) -> Any:
        authority = actor or self.actor
        ref = None
        if self.ledger is not None:
            ref = self.ledger.append(event, body, correlation_id=correlation_id,
                                     event_class=event_class, actor=authority, refs=refs,
                                     ts=self.write_ts)
            self.last_append = ref.as_dict()
        self._dispatch(event, dict(body))
        return ref

    def _dispatch(self, event: str, body: dict) -> None:
        """按契约 §5 声明的模式派发（内核按声明校验模式；未登记前不派发，不自行发明模式）。

        `negotiate/round` 是 serial：它的「派发」就是判定链本身（`submit_round` 里显式调用），
        落账后不再拿账本 body 重跑一次判定。
        """
        if self.events is None:
            return
        mode = self.events.mode_of(event)
        if mode is None or mode == "serial":
            return
        self.events.dispatch(event, body)

    def _ts(self, ref: Any) -> str:
        if ref is None or self.ledger is None:
            return ""
        return str(self.ledger.get(ref.seq).get("ts") or "")

    def _require_thread(self, thread_id: str) -> dict:
        thread = self._threads.get(thread_id)
        if thread is None:
            raise UnknownThread(f"不存在的谈判线程: {thread_id}")
        return thread

    def _require_open(self, thread: dict) -> None:
        if thread["status"] != "open":
            raise ThreadClosedError(
                f"线程 {thread['thread_id']} 已关闭（outcome={thread.get('outcome')}）："
                f"不得再提交轮次或声明边界")

    def _thread_view(self, thread: dict) -> dict:
        thread["rounds_used"] = self.rounds_used(thread["thread_id"])
        return copy.deepcopy({key: value for key, value in thread.items() if not key.startswith("_")})

    def _round_view(self, record: dict) -> dict:
        return copy.deepcopy({key: value for key, value in record.items() if not key.startswith("_")})

    def _round_view_of(self, row: dict, body: dict, attempt_no: int, status: str | None) -> dict:
        """从账本行重建轮次视图（拒绝轮只有 `code/reason/next_action/move`）。"""
        thread_id = str(body.get("thread_id"))
        code = str(body.get("code") or "")
        move = dict(body.get("move") or {})
        return {
            "round_id": self._round_id(thread_id, attempt_no), "round_key": body.get("round_key"),
            "thread_id": thread_id, "attempt_no": int(attempt_no), "move": move,
            "delta_pct": body.get("delta_pct"), "requested_price": move.get("to"),
            "floor": body.get("floor"), "ceiling": body.get("ceiling"),
            "band": dict(body.get("band") or {}), "in_band": bool(body.get("in_band")),
            "status": status or STATUS_BY_CODE.get(code, "rejected"),
            "approval_id": body.get("approval_id"), "approval_scope": CONCESSION_SCOPE,
            "approval_ref": self._gate_ref(thread_id, attempt_no),
            "citations": list(body.get("citations") or []), "code": code,
            "reason": str(body.get("reason") or ""), "next_action": str(body.get("next_action") or ""),
            "created_at": str(row.get("ts") or ""),
        }
