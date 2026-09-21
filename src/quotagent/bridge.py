"""宿主 ↔ Python 内核桥（stdio 上的 NDJSON，协议见 ADR-0013 与 docs/design/13-cordis-bridge.md）。

分工：**cordis 管组合，Python 管事实**（ADR-0012）。本模块是内核侧端点：
- 首帧推 `kernel/hello`（能力清单，唯一真源是 Python 侧的声明表）；
- 收 `bridge.init` 做版本交集：**主版本不兼容即退出码 2，且账本零新增**；
- 方法面按 `cls` 四级（read/compute/fact/commit），**commit 面永不暴露**（调用即拒 + 留痕）；
- `fact` 面 P1 默认关闭（`intents_only`，ADR-0013 §3）；
- 身份**永不自我声明**：宿主传的 `source` 只作为"声称值"记录，权威身份由内核注入；
- stdout 只承载协议帧，日志一律走 stderr。

退出码：0 正常 · 2 版本不兼容 · 3 启动失败。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable

from .kernel.events import EventBus
from .kernel.ledger import utc_now
from .kernel.ledger import Ledger
from .services.measures import IncompatibleMeasure, UnknownUnit, UnitTable

BRIDGE_VERSION = "1.0"
BRIDGE_MIN_SUPPORTED = "1.0"
KERNEL_VERSION = "0.1.0"
FRAME_VERSION = 1
MAX_FRAME_BYTES = 8 * 1024 * 1024
DEFAULT_CREDIT_WINDOW = 256

# 固定错误码（ADR-0013 §4）；每个码都要给出可行动的 next_action
NEXT_ACTION = {
    "invalid-request": "检查帧：必须是一行 JSON（≤ 8 MiB）、字段名与类型符合 13-cordis-bridge.md §3",
    "unknown-method": "先用 kernel/hello 读 methods[]，只调用清单内的方法",
    "commit-refused": "承诺类与人工签署只走交互式 Python CLI（ADR-0013 §3）；宿主不得代签",
    "version-mismatch": "升级宿主或内核使 accept_bridge 与 min_supported 有交集（ADR-0006 §3）",
    "ledger-unhealthy": "先跑账本校验（ADR-0007 §6）；校验失败前拒绝新增，只读仍可用",
    "deadline-exceeded": "缩短单次调用或提高宿主侧 deadline；必要时拆分请求",
    "backpressure": "等待 bridge.credit 或用 ledger.read{from_seq:last_acked+1} 补齐",
    "kernel-crashed": "重启内核（预算 3 次/30s，超预算降只读）；在途请求记为 unknown，不得当成功",
}

CLASSES = ("read", "compute", "fact", "commit")
# P1 只开放这两类（ADR-0013 §3：intents_only）
OPEN_CLASSES = ("read", "compute")

# commit 面：**声明但永不暴露**（对抗性断言的对象）
REFUSED_SURFACE = (
    ("qep.receive", "fact"),
    ("qep.send", "fact"),
    ("approval.decide", "commit"),
    ("quote.submit", "commit"),
    ("award.commit", "commit"),
    ("po.issue", "commit"),
    ("change.approve", "commit"),
)


class BridgeError(Exception):
    def __init__(self, code: str, message: str, *, data: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}

    def as_frame(self, req_id: Any = None) -> dict:
        return {"v": FRAME_VERSION, "n": "error", "p": {
            "id": req_id, "code": self.code, "message": self.message,
            "next_action": NEXT_ACTION.get(self.code, ""), "data": self.data}}


class MethodSurface:
    """方法面登记：名字 → (cls, handler)。只有 OPEN_CLASSES 会被暴露。"""

    def __init__(self) -> None:
        self._methods: dict[str, tuple[str, Callable[[dict], Any]]] = {}

    def register(self, name: str, cls: str, handler: Callable[[dict], Any]) -> None:
        if cls not in CLASSES:
            raise ValueError(f"未知方法类: {cls!r}（合法: {CLASSES}）")
        self._methods[name] = (cls, handler)

    def cls_of(self, name: str) -> str | None:
        entry = self._methods.get(name)
        return entry[0] if entry else None

    def exposed(self) -> list[dict]:
        out = [{"m": name, "cls": cls} for name, (cls, _fn) in self._methods.items() if cls in OPEN_CLASSES]
        return sorted(out, key=lambda item: item["m"])

    def declared(self) -> list[dict]:
        out = [{"m": name, "cls": cls} for name, (cls, _fn) in self._methods.items()]
        out += [{"m": name, "cls": cls} for name, cls in REFUSED_SURFACE]
        return sorted(out, key=lambda item: item["m"])

    def call(self, name: str, params: dict, *, fact_enabled: bool) -> Any:
        cls = self.cls_of(name)
        if cls is None:
            refused = {m: cls for m, cls in REFUSED_SURFACE}
            if name in refused:
                if refused[name] == "fact":
                    raise BridgeError("commit-refused", f"{name} 属 fact 面，P1 默认关闭（intents_only）",
                                      data={"m": name, "cls": "fact", "surfaces_open": list(OPEN_CLASSES)})
                raise BridgeError("commit-refused", f"{name} 属承诺面，永不暴露给宿主",
                                  data={"m": name, "cls": "commit"})
            raise BridgeError("unknown-method", f"未登记的方法: {name}",
                              data={"m": name, "exposed": [item["m"] for item in self.exposed()]})
        if cls == "commit":
            raise BridgeError("commit-refused", f"{name} 属承诺面，永不暴露给宿主",
                              data={"m": name, "cls": "commit"})
        if cls == "fact" and not fact_enabled:
            raise BridgeError("commit-refused", f"{name} 属 fact 面，P1 默认关闭（intents_only）",
                              data={"m": name, "cls": "fact", "surfaces_open": list(OPEN_CLASSES)})
        return self._methods[name][1](params)


class BridgeKernel:
    """内核侧端点：能力自述、版本协商、方法面调度、拒绝留痕。"""

    # 通知与背压的硬上限：超过窗口太多即丢弃并留痕（ADR-0013 §5）
    NOTIFY_QUEUE_CAP = 64

    def __init__(self, *, realm: str, ledger_path: str | Path, profile: str = "",
                 participant: str = "", fact_enabled: bool = False, session: str = "",
                 restarts: int = 0, anchor: str | None = None, anchor_seq: int = 0,
                 read_only: bool = False,
                 credit_window: int = DEFAULT_CREDIT_WINDOW) -> None:
        self.realm = realm
        self.profile = profile
        self.fact_enabled = fact_enabled
        self.ledger = Ledger(ledger_path, realm=realm)
        self.bus = EventBus()
        self.bus.install_defaults()
        self.ledger.attach_events(self.bus)
        # 权威身份由内核注入（宿主不能自称 human:*）
        self.injected_operator = f"bridge:{profile or 'host'}"
        self.participant = participant or f"kernel:{profile or realm}"
        self.rejected: list[dict] = []
        self.surface = MethodSurface()
        self._register_methods()
        self._init_head = self.ledger.head_hash
        self._init_seq = self.ledger.count
        self.degraded: list[dict] = []
        self.refusals_logged = 0
        # --- 故障/背压/只读（T-217，ADR-0013 §5/§6）---
        self.session = session or f"s-{self.ledger.count}"
        self.restarts = int(restarts)
        self.anchor = anchor
        self.anchor_seq = int(anchor_seq or 0)
        self.read_only = bool(read_only)
        self.read_only_reason = "host-downgrade" if read_only else ""
        self.credit_window = int(credit_window)
        self.sent_unacked = 0
        self.notifications: list[dict] = []
        self.dropped = {"live": 0, "durable": 0}
        self.backpressure_episodes = 0
        # 背压是"回合"而非"每帧"：进入回合后累积计数，窗口恢复（或会话结束）时落一条事件
        self.bp_open = False
        self.bp_accum = {"live": 0, "durable": 0}
        self.bp_since: str | None = None
        self.delivered = {"live": 0, "durable": 0}
        self._wire_notifications()
        self._startup_marks()

    # ---------------------------------------------------------------- 故障与背压
    def _wire_notifications(self) -> None:
        """把所有已声明事件转成通知帧（durable/live 分开计数，供背压与补齐使用）。"""
        for name in sorted(self.bus.declared()):
            self.bus.on(name, self._make_listener(name))

    def _make_listener(self, name: str):
        durable = bool(self.bus.durable(name))

        def listener(*args) -> None:
            payload: Any
            if len(args) == 1:
                payload = args[0]
            else:
                payload = list(args)
            if isinstance(payload, dict):
                payload = {k: v for k, v in payload.items() if not k.startswith("_")}
            self.notifications.append({"name": name, "durable": durable, "payload": payload})

        return listener

    def _startup_marks(self) -> None:
        """启动即记账：重启留痕；宿主给的锚点与账本不一致 → 落 fault 并降只读（ADR-0013 §6）。"""
        if self.restarts > 0:
            self._append("kernel/bridge-restarted", {
                "profile": self.profile, "realm": self.realm, "session": self.session,
                "restarts": self.restarts, "anchor": {"head": self.ledger.head_hash, "seq": self.ledger.count},
                "previous_head": self.anchor, "read_only": self.read_only})
        # 锚点语义：宿主给出"最后观测到的 (seq, head)"。
        #   · 账本**落后**于宿主观测（seq 更小）→ 数据丢失/回滚 → fault + 只读；
        #   · 同一 seq 的 entry_hash 与宿主记录**不同** → 历史被替换 → fault + 只读；
        #   · 账本**超前**（seq 更大）→ 不是 fault（宿主只是没看到尾巴），用 ledger.read 补齐；
        #   · 哈希链本身校验失败 → fault + 只读（ADR-0007 §6 的停发语义）。
        problems = []
        if self.anchor and not self.anchor_seq:
            # 只给了哈希（没有 seq）：该哈希必须是**创世 head** 或链中某条目的 entry_hash
            genesis = "sha256:" + "0" * 64
            if self.anchor != genesis and not any(rec["entry_hash"] == self.anchor
                                                  for rec in self.ledger.read()):
                problems.append("anchor-not-in-chain")
        if self.anchor and self.anchor_seq:
            if self.ledger.count < self.anchor_seq:
                problems.append("ledger-behind-anchor")
            else:
                try:
                    recorded = self.ledger.get(self.anchor_seq)
                    if recorded["entry_hash"] != self.anchor:
                        problems.append("history-replaced")
                except Exception:
                    problems.append("anchor-not-in-chain")
        if not self.ledger.verify_report()["ok"]:
            problems.append("hash-chain-invalid")
        if problems:
            self._append("kernel/bridge-fault", {
                "profile": self.profile, "realm": self.realm, "reasons": problems,
                "expected": {"head": self.anchor, "seq": self.anchor_seq},
                "actual": {"head": self.ledger.head_hash, "seq": self.ledger.count},
                "action": "read-only-until-verify-chain"})
            self.read_only = True
            self.read_only_reason = ",".join(problems)

    def _respond(self, stdout, frame: dict) -> None:
        """写一帧响应，然后才轮到通知（ADR-0013 §5：响应优先于通知）。错误帧同样走这里。"""
        self._write(stdout, frame)
        self._drain_notifications(stdout)

    def _flush_backpressure(self) -> None:
        """回合收尾：把这一轮的丢弃计数与时间窗落成一条事件（避免每帧一条噪声）。"""
        if not self.bp_open:
            return
        self._append("kernel/bridge-backpressure", {
            "profile": self.profile, "realm": self.realm, "session": self.session,
            "credit_window": self.credit_window, "sent_unacked": self.sent_unacked,
            "queue_len": len(self.notifications), "dropped": dict(self.bp_accum),
            "dropped_total": dict(self.dropped), "window": {"from": self.bp_since, "to": utc_now()},
            "note": "durable 不可丢数据（已在账本，用 ledger.read{from_seq} 补齐）；live 可丢但必须留痕"})
        self.backpressure_episodes += 1
        self.bp_open = False
        self.bp_accum = {"live": 0, "durable": 0}
        self.bp_since = None

    def _drain_notifications(self, stdout) -> None:
        """窗口内发送通知；窗口耗尽时 live 可丢（必留痕）、durable 留在队列等宿主补齐。"""
        budget = max(0, self.credit_window - self.sent_unacked)
        while self.notifications and budget > 0:
            item = self.notifications.pop(0)
            self._write(stdout, {"v": FRAME_VERSION, "n": "event", "p": {
                "name": item["name"], "durable": item["durable"], "payload": item["payload"],
                "credit_remaining": budget - 1}})
            self.delivered["durable" if item["durable"] else "live"] += 1
            self.sent_unacked += 1
            budget -= 1
        if not self.notifications:
            return
        dropped = {"live": 0, "durable": 0}
        if self.sent_unacked >= self.credit_window:
            # 窗口已耗尽：live 通知丢弃并计数；durable 保留（数据在账本，补齐靠 ledger.read）
            kept = []
            for item in self.notifications:
                if item["durable"]:
                    kept.append(item)
                else:
                    dropped["live"] += 1
            self.notifications = kept
        overflow = max(0, len(self.notifications) - self.NOTIFY_QUEUE_CAP)
        if overflow:  # 二次保险：连 durable 都堆积到上限时也丢帧，但计数（数据仍在账本）
            kept = []
            for item in self.notifications:
                if overflow > 0:
                    dropped["durable"] += 1; overflow -= 1; continue
                kept.append(item)
            self.notifications = kept
        if not (dropped["live"] or dropped["durable"]):
            return
        self.dropped["live"] += dropped["live"]
        self.dropped["durable"] += dropped["durable"]
        self.bp_accum["live"] += dropped["live"]
        self.bp_accum["durable"] += dropped["durable"]
        if not self.bp_open:
            self.bp_open = True
            self.bp_since = utc_now()

    # ---------------------------------------------------------------- 方法面
    def _register_methods(self) -> None:
        reg = self.surface.register
        reg("ledger.head", "read", lambda _p: {
            "head": self.ledger.head_hash, "seq": self.ledger.count, "healthy": self.ledger.healthy})
        reg("ledger.count", "read", lambda _p: {"count": self.ledger.count})
        reg("ledger.read", "read", lambda p: {
            "entries": self.ledger.read(type=p.get("type"),
                                        from_seq=int(p.get("from_seq", 1)),
                                        to_seq=p.get("to_seq"))})
        reg("ledger.healthy", "read", lambda _p: {
            "healthy": self.ledger.healthy, "frozen": self.ledger.frozen})
        reg("events.declared", "read", lambda _p: {"events": [
            {"name": name, "mode": mode, "durable": bool(self.bus.durable(name))}
            for name, mode in sorted(self.bus.declared().items())]})
        reg("ledger.verify", "read", lambda p: {
            "report": self.ledger.verify_report(from_seq=int(p.get("from_seq", 1)))})
        reg("bridge.status", "read", lambda _p: {
            "read_only": self.read_only, "read_only_reason": self.read_only_reason,
            "restarts": self.restarts, "session": self.session, "credit_window": self.credit_window,
            "sent_unacked": self.sent_unacked, "pending_notifications": len(self.notifications),
            "delivered": dict(self.delivered), "dropped": dict(self.dropped),
            "backpressure_episodes": self.backpressure_episodes, "anchor": self.anchor,
            "ledger": {"head": self.ledger.head_hash, "seq": self.ledger.count,
                       "healthy": self.ledger.healthy}})
        reg("measures.convert", "compute", self._measures_convert)
        reg("measures.factor", "compute", self._measures_factor)

    def _measures_convert(self, params: dict) -> dict:
        table = UnitTable()
        try:
            value = table.convert(float(params["value"]), str(params["from"]), str(params["to"]))
        except (UnknownUnit, IncompatibleMeasure) as err:
            raise BridgeError("invalid-request", f"{type(err).__name__}: {err}",
                              data={"params": sorted(params)}) from err
        return {"value": value, "from": params["from"], "to": params["to"], "units": len(table.units())}

    def _measures_factor(self, params: dict) -> dict:
        table = UnitTable()
        try:
            factor = table.factor(str(params["from"]), str(params["to"]))
        except (UnknownUnit, IncompatibleMeasure) as err:
            raise BridgeError("invalid-request", f"{type(err).__name__}: {err}") from err
        return {"factor": factor, "from": params["from"], "to": params["to"]}

    # ---------------------------------------------------------------- 握手与调度
    def hello(self) -> dict:
        return {"v": FRAME_VERSION, "n": "kernel/hello", "p": {
            "bridge": {"version": BRIDGE_VERSION, "min_supported": BRIDGE_MIN_SUPPORTED},
            "kernel": {"version": KERNEL_VERSION, "profile": self.profile, "operator": self.injected_operator},
            "qep_versions": list(__import__("quotagent.kernel.qep", fromlist=["SUPPORTED_QEP_VERSIONS"])
                                 .SUPPORTED_QEP_VERSIONS),
            "features": ["ndjson-stdio", "credit-window", "commit-surface-closed",
                         "fact-surface-" + ("open" if self.fact_enabled else "closed"), "identities-injected"],
            "events": [{"name": name, "mode": mode, "durable": bool(self.bus.durable(name))}
                       for name, mode in sorted(self.bus.declared().items())],
            "methods": self.surface.exposed(),
            "methods_refused": [{"m": name, "cls": cls} for name, cls in REFUSED_SURFACE],
            "ledger": {"path": str(self.ledger.path), "head": self.ledger.head_hash,
                       "seq": self.ledger.count, "healthy": self.ledger.healthy},
            "realms": [self.realm],
            "max_frame_bytes": MAX_FRAME_BYTES,
            "credit_window": self.credit_window,
            "session": self.session,
            "restarts": self.restarts,
            "read_only": self.read_only,
            "anchor_seq": self.anchor_seq,
        }}

    def init(self, payload: dict) -> dict:
        accept = payload.get("accept_bridge") or []
        if not isinstance(accept, list) or not accept:
            raise BridgeError("invalid-request", "bridge.init 必须带非空 accept_bridge[]")
        if BRIDGE_VERSION not in [str(item) for item in accept]:
            # 交集为空 → 退出码 2，账本零新增（不落任何事件）
            raise BridgeError("version-mismatch",
                              f"accept_bridge={accept} 与内核 {BRIDGE_VERSION} 无交集",
                              data={"bridge_version": BRIDGE_VERSION, "min_supported": BRIDGE_MIN_SUPPORTED})
        if payload.get("credit_window"):
            try:
                self.credit_window = max(1, int(payload["credit_window"]))
            except (TypeError, ValueError) as err:
                raise BridgeError("invalid-request", f"credit_window 必须是正整数: {err}") from err
        missing = sorted(set(payload.get("want_events") or []) - set(self.bus.declared()))
        if missing:
            self._append("kernel/bridge-degraded", {
                "profile": self.profile, "realm": self.realm, "missing_events": missing,
                "reason": "宿主请求的事件内核未声明（特性级降级必须留痕；不可降级项除外）",
                "accept_bridge": [str(item) for item in accept], "bridge_version": BRIDGE_VERSION})
            self.degraded.append({"missing_events": missing})
        return {"v": FRAME_VERSION, "n": "bridge.ready", "p": {
            "profile": self.profile, "realm": self.realm, "operator": self.injected_operator,
            "surfaces_open": list(OPEN_CLASSES) + (["fact"] if self.fact_enabled else []),
            "ledger_seq": self.ledger.count, "credit_window": self.credit_window,
            "session": self.session, "restarts": self.restarts, "read_only": self.read_only,
            "degraded": self.degraded[-1] if self.degraded else None,
            "non_degradable": ["approval-chain", "version-binding", "signature-verification"]}}

    def handle(self, frame: dict) -> dict | None:
        """一帧 → 一帧（或 None 表示无需响应，用于通知类）。"""
        name = frame.get("n")
        payload = frame.get("p") or {}
        if frame.get("v") != FRAME_VERSION:
            raise BridgeError("invalid-request", f"帧版本 {frame.get('v')!r} 不是 {FRAME_VERSION}")
        if name == "kernel/hello":
            return self.hello()
        if name == "bridge.init":
            return self.init(payload)
        if name == "bridge.credit":
            self.sent_unacked = max(0, self.sent_unacked - int(payload.get("n", self.credit_window)))
            if self.sent_unacked < self.credit_window:
                self._flush_backpressure()
            return {"v": FRAME_VERSION, "n": "bridge.credit-ack",
                    "p": {"credit_window": self.credit_window, "sent_unacked": self.sent_unacked}}
        if name == "bridge.shutdown":
            return {"v": FRAME_VERSION, "n": "bridge.bye", "p": {"seq": self.ledger.count}}
        if name == "method":
            return self._dispatch(payload)
        raise BridgeError("invalid-request", f"未知帧名: {name!r}",
                          data={"known": ["kernel/hello", "bridge.init", "bridge.credit",
                                          "bridge.shutdown", "method"]})

    def _read_only_gate(self, method: str) -> None:
        cls = self.surface.cls_of(method)
        if self.read_only and (cls in ("fact", "commit")
                               or any(m == method for m, _ in REFUSED_SURFACE)):
            raise BridgeError("commit-refused",
                              f"桥已降为只读（原因 {self.read_only_reason or 'unknown'}）：{method} 不可用",
                              data={"m": method, "read_only": True, "reason": self.read_only_reason,
                                    "surfaces_open": list(OPEN_CLASSES)})

    def _dispatch(self, payload: dict) -> dict:
        req_id = payload.get("id")
        method = payload.get("m")
        params = payload.get("params") or {}
        if not isinstance(method, str) or not method:
            raise BridgeError("invalid-request", "method 帧必须带字符串 m", data={"id": req_id})
        claimed = str(params.pop("source", "") or params.pop("operator", ""))
        params_digest = hashlib.sha256(
            json.dumps(params, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
        if claimed.startswith("human:"):
            # 身份永不自我声明：宿主不能自称人
            self._append("kernel/bridge-rejected", {
                "method": method, "realm": self.realm, "reason": "self-declared-identity",
                "claimed_source": claimed, "injected_operator": self.injected_operator,
                "profile": self.profile, "action": "refused",
                "request_id": req_id, "params_digest": params_digest})
            self.rejected.append({"m": method, "reason": "self-declared-identity"})
            raise BridgeError("invalid-request", f"身份不能自我声明（claimed={claimed!r}）",
                              data={"claimed_source": claimed, "injected_operator": self.injected_operator})
        try:
            self._read_only_gate(method)
            result = self.surface.call(method, params, fact_enabled=self.fact_enabled)
        except BridgeError as err:
            if err.code == "commit-refused":
                self._append("kernel/bridge-rejected", {
                    "method": method, "realm": self.realm, "reason": err.code,
                    "claimed_source": claimed, "injected_operator": self.injected_operator,
                    "profile": self.profile, "action": "refused", "cls": err.data.get("cls"),
                    "request_id": req_id, "params_digest": params_digest})
                self.rejected.append({"m": method, "reason": err.code})
            raise
        return {"v": FRAME_VERSION, "n": "result", "p": {
            "id": req_id, "ok": True, "m": method,
            "result": result, "operator": self.injected_operator}}

    def _append(self, type_: str, body: dict) -> None:
        try:
            ref = self.ledger.append(type_, body)
            if not getattr(ref, "duplicate", False):
                self.bus.emit(type_, body)
        except Exception as err:  # 账本不可写不得让桥静默继续（ADR-0007 §6）
            raise BridgeError("ledger-unhealthy", f"账本拒绝新增: {err}",
                              data={"type": type_}) from err

    # ---------------------------------------------------------------- 服务循环
    def serve(self, stdin=None, stdout=None, stderr=None) -> int:
        stdin = stdin or sys.stdin
        stdout = stdout or sys.stdout
        stderr = stderr or sys.stderr
        accepted = False
        while True:
            raw = stdin.readline(MAX_FRAME_BYTES + 1)
            if raw == "":
                return 0
            if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                self._respond(stdout, BridgeError("invalid-request",
                                                  f"帧超过 {MAX_FRAME_BYTES} B 上限").as_frame())
                return 0
            line = raw.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError as err:
                self._respond(stdout, BridgeError("invalid-request",
                                                  f"帧不是合法 JSON: {err.msg}").as_frame())
                continue
            if not isinstance(frame, dict):
                self._respond(stdout, BridgeError("invalid-request", "帧必须是 JSON 对象").as_frame())
                continue
            try:
                response = self.handle(frame)
            except BridgeError as err:
                if err.code == "version-mismatch":
                    self._respond(stdout, err.as_frame(frame.get("p", {}).get("id")))
                    return 2
                self._respond(stdout, err.as_frame(frame.get("p", {}).get("id")))
                continue
            except Exception as err:  # 未预期异常也要是确定性帧，不留半句
                self._respond(stdout, {"v": FRAME_VERSION, "n": "error", "p": {
                    "id": frame.get("p", {}).get("id"), "code": "kernel-crashed",
                    "message": f"{type(err).__name__}: {err}",
                    "next_action": NEXT_ACTION["kernel-crashed"], "data": {}}})
                continue
            if frame.get("n") == "bridge.init" and response is not None:
                accepted = True
            if response is not None:
                self._respond(stdout, response)
                if accepted:
                    stderr.write(json.dumps({"bridge": "ready", "realm": self.realm,
                                             "seq": self.ledger.count}) + "\n")
                    stderr.flush()
                    accepted = False
            if frame.get("n") == "bridge.shutdown":
                self._flush_backpressure()
                self._drain_notifications(stdout)
                return 0

    @staticmethod
    def _write(stdout, frame: dict) -> None:
        stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
        stdout.flush()


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="quotagent.bridge", description="宿主 ↔ 内核桥（NDJSON/stdio）")
    parser.add_argument("--serve", action="store_true", help="进入桥模式（stdin/stdout 走协议帧）")
    parser.add_argument("--realm", default="local")
    parser.add_argument("--ledger", required=True, help="账本路径（内核是唯一写者）")
    parser.add_argument("--profile", default="")
    parser.add_argument("--participant", default="")
    parser.add_argument("--session", default="")
    parser.add_argument("--restarts", type=int, default=0)
    parser.add_argument("--anchor", default=None)
    parser.add_argument("--anchor-seq", type=int, default=0)
    parser.add_argument("--read-only", action="store_true")
    parser.add_argument("--credit-window", type=int, default=DEFAULT_CREDIT_WINDOW)
    parser.add_argument("--fact-surface", choices=("open", "closed"), default="closed",
                        help="P1 默认 closed（intents_only，ADR-0013 §3）")
    args = parser.parse_args(argv)
    if not args.serve:
        parser.print_help(sys.stderr)
        return 0
    try:
        kernel = BridgeKernel(realm=args.realm, ledger_path=args.ledger, profile=args.profile,
                              participant=args.participant, fact_enabled=args.fact_surface == "open",
                              session=args.session, restarts=args.restarts, anchor=args.anchor,
                              anchor_seq=args.anchor_seq,
                              read_only=args.read_only, credit_window=args.credit_window)
    except Exception as err:
        sys.stderr.write(json.dumps({"bridge": "startup-failed",
                                     "error": f"{type(err).__name__}: {err}"}) + "\n")
        return 3
    # 首帧：内核自述（能力清单的唯一真源在 Python 侧）
    kernel._write(sys.stdout, kernel.hello())
    return kernel.serve()


if __name__ == "__main__":
    raise SystemExit(main())
