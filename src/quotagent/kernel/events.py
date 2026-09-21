"""ctx.events：五模式事件分发（`docs/design/05-events.md`）。

硬约束（`05-events.md` §0）：
1. 每个事件只有一个 @mode，且只能用对应方法分发；
2. durable 事件必须进账本，live 事件只存在于进程内；
3. waterfall 监听者必须调 `next()` 委托；不调用即短路，且该短路必须是**文档化设计意图**
   （§5 拦截点总表）——因此声明 waterfall 事件必须给出理由，且 §5 未登记的事件不会被默认表声明；
4. 注册即 effect：`on()` 返回 disposer，撤销后监听器立刻消失（FR-EVT-002）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

MODES = ("emit", "parallel", "serial", "bail", "waterfall")


class EventError(RuntimeError):
    """事件系统错误基类。"""


class EventModeError(EventError):
    """事件已声明为其它 @mode（或 waterfall 未给出短路理由）。"""


class UnknownEventError(EventError):
    """事件未声明。"""


class AggregateEventError(EventError):
    """parallel 分发中至少一个监听器抛错；全部监听器都已执行完（§1 判据）。"""

    def __init__(self, name: str, errors: list[tuple[str, BaseException]]) -> None:
        self.errors = errors
        detail = "; ".join(f"{label}: {type(exc).__name__}({exc})" for label, exc in errors)
        super().__init__(f"parallel 事件 {name!r} 有 {len(errors)} 个监听器抛错: {detail}")


@dataclass
class Listener:
    fn: Callable[..., Any]
    label: str
    order: int
    disposed: bool = False


def _summarize(value: Any, limit: int = 160) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class EventBus:
    """事件总线。事件表数据来自 `05-events.md` §2/§3/§4（P0 子集）。"""

    # name -> (mode, durable, 短路理由/无)
    DEFAULT_TABLE: dict[str, tuple[str, bool, str]] = {
        # §2 内核事件
        "kernel/ledger-appended": ("emit", False, ""),
        "kernel/model-call": ("emit", True, ""),
        "kernel/model-replied": ("emit", True, ""),
        "kernel/plugin-mounted": ("emit", False, ""),
        "kernel/plugin-unmounted": ("emit", False, ""),
        "kernel/config-updated": ("waterfall", False, "内核配置被自改 → 无条件否决（INV-010，05 §5）"),
        "kernel/qep-rejected": ("emit", True, ""),
        "kernel/qep-sent": ("emit", True, ""),
        "kernel/qep-received": ("emit", True, ""),
        "kernel/qep-duplicate-dropped": ("emit", True, ""),
        "kernel/qep-gap-detected": ("emit", True, ""),
        "kernel/qep-gap-filled": ("emit", True, ""),
        "kernel/qep-degraded": ("emit", True, ""),
        "kernel/qep-resent": ("emit", True, ""),
        "kernel/bridge-degraded": ("emit", True, ""),
        "kernel/bridge-rejected": ("emit", True, ""),
        "kernel/bridge-backpressure": ("emit", True, ""),
        "kernel/bridge-restarted": ("emit", True, ""),
        "kernel/bridge-fault": ("emit", False, ""),
        # relay（中转）：只做 opaque 转发，自己的 realm/账本
        "relay/received": ("emit", True, ""),
        "relay/queued": ("emit", True, ""),
        "relay/retry": ("emit", True, ""),
        "relay/delivered": ("emit", True, ""),
        "relay/tamper-detected": ("emit", True, ""),
        # 账本同步（三方协调，03 §4）
        "sync/merged": ("emit", True, ""),
        "sync/conflict": ("emit", True, ""),
        "sync/suspended": ("emit", True, ""),
        "sync/suggestion-raised": ("emit", True, ""),
        # §3 人工门与私域/成本相关（P0 S0.9–S0.10）
        "approval/requested": ("emit", True, ""),
        "approval/granted": ("emit", True, ""),
        "approval/denied": ("emit", True, ""),
        "approval/reminded": ("emit", True, ""),
        "approval/escalated": ("emit", True, ""),
        "approval/aborted": ("emit", True, ""),
        "gate/nudged": ("emit", True, ""),
        "change/proposed": ("serial", True, ""),
        "change/priced": ("serial", True, ""),
        "change/approved": ("serial", True, ""),
        "change/rejected": ("bail", True, ""),
        "terms/defined": ("emit", True, ""),
        "terms/applied": ("emit", True, ""),
        "terms/conflict": ("emit", True, ""),
        "quote/cost-built": ("emit", True, ""),
        "quote/price-drafted": ("waterfall", False,
                                "越界定价必须在流水线内转人工门，不得直接产出可提交价格（05 §5）"),
        "quote/deviation-captured": ("emit", True, ""),
        "quote/deviation-quantified": ("emit", True, ""),
        "evolve/proposed": ("serial", True, ""),
        "evolve/shadowed": ("serial", True, ""),
        "evolve/gated": ("serial", True, ""),
        "evolve/promoted": ("serial", True, ""),
        "evolve/rolled-back": ("serial", True, ""),
        "evolve/canary-entered": ("serial", True, ""),
        "evolve/canary-exited": ("serial", True, ""),
        # §3 业务事件（P0 用到/会落账的部分）
        "rfq/published": ("emit", True, ""),
        "rfq/amended": ("emit", True, ""),
        "rfq/distributed": ("emit", True, ""),
        "rfq/due-soon": ("emit", True, ""),
        "rfq/overdue": ("emit", True, ""),
        "rfq/promised": ("emit", True, ""),
        "rfq/version-mismatch": ("bail", True, ""),
        "clarification/asked": ("emit", True, ""),
        "clarification/answer-drafted": ("waterfall", False,
                                        "答案可能含对方私域信息 → 拦截该字段（05 §5）"),
        "clarification/answered": ("emit", True, ""),
        "clarification/broadcast-incomplete": ("bail", True, ""),
        "clarification/rejected": ("emit", True, ""),
        "clarification/reopened": ("emit", True, ""),
        "quote/intake-completed": ("emit", True, ""),
        "quote/normalize": ("waterfall", False, "归一化任一环不可行即中断并产出拒绝理由（05 §5 / P6）"),
        "quote/normalized": ("emit", True, ""),
        "quote/normalize-rejected": ("emit", True, ""),
        "quote/price-proposed": ("emit", True, ""),
        "quote/guard-check": ("bail", True, ""),
        "quote/human-approved": ("emit", True, ""),
        "quote/submitted": ("emit", True, ""),
        "quote/superseded": ("emit", True, ""),
        "capacity/committed": ("emit", True, ""),
        "capacity/firm-change-refused": ("emit", True, ""),
        "capacity/conflict": ("emit", True, ""),
        "compare/rank-computed": ("emit", True, ""),
        "compare/flag-raised": ("emit", True, ""),
        "compare/table-exported": ("emit", True, ""),
        "award/intent-proposed": ("emit", True, ""),
        "award/intent-withdrawn": ("emit", True, ""),
        "award/commit-requested": ("serial", False, ""),
        "award/committed": ("emit", True, ""),
        "po/issued": ("emit", True, ""),
        "evidence/pack-exported": ("emit", True, ""),
        "evidence/retention-archived": ("emit", True, ""),
        "admin/block-pending": ("emit", True, ""),
        "userplugin/created": ("emit", True, ""),
        "userplugin/loaded": ("emit", True, ""),
        "userplugin/reloaded": ("emit", True, ""),
        "userplugin/unloaded": ("emit", True, ""),
        "userplugin/upgraded": ("emit", True, ""),
        "userplugin/rolled-back": ("emit", True, ""),
        "userplugin/elevation-requested": ("emit", True, ""),
        "userplugin/elevated": ("emit", True, ""),
        "userplugin/refused": ("emit", True, ""),
        "admin/block-resolved": ("emit", True, ""),
        "admin/block-rejected": ("emit", True, ""),
        "admin/block-expired": ("emit", True, ""),
        "evidence/retention-copy-purged": ("emit", True, ""),
        # negotiate/*（ADR-0019；无 waterfall）
        "negotiate/bounds-declared": ("emit", True, ""),
        "negotiate/opened": ("emit", True, ""),
        "negotiate/round": ("serial", False, ""),
        "negotiate/round-rejected": ("bail", True, ""),
        "negotiate/closed": ("emit", True, ""),
        # faq/*（D-051）
        "faq/entry-published": ("emit", True, ""),
        "faq/reuse-served": ("emit", True, ""),
        "faq/reuse-refused": ("emit", True, ""),
        # mail/*（D-052；无 mail/sent）
        "mail/queued": ("emit", True, ""),
        "mail/refused": ("emit", True, ""),
        "mail/parsed": ("emit", True, ""),
        # §4 agent 侧（live）
        "agent/step-start": ("emit", False, ""),
        "agent/step-end": ("emit", False, ""),
        "agent/tool-call-requested": ("waterfall", False,
                                      "越权/私自承诺在工具入口拦截（05 §5）"),
        "agent/output-drafted": ("waterfall", False, "无引用数值不得进入决策（05 §5）"),
        "agent/escalate": ("serial", False, ""),
        "agent/assumption-raised": ("emit", False, ""),
    }

    def __init__(self, name: str = "ctx.events") -> None:
        self.name = name
        self._modes: dict[str, tuple[str, bool, str]] = {}
        self._listeners: dict[str, list[Listener]] = {}
        self._counter = 0
        self.short_circuits: list[dict] = []

    # --- 声明表 -----------------------------------------------------------
    @classmethod
    def default_table(cls) -> dict[str, str]:
        return {name: mode for name, (mode, _durable, _reason) in cls.DEFAULT_TABLE.items()}

    def declare(self, name: str, mode: str, *, durable: bool = False, reason: str = "") -> None:
        if mode not in MODES:
            raise EventModeError(f"未知 @mode={mode!r}；取值: {MODES}")
        if mode == "waterfall" and not reason.strip():
            raise EventModeError(f"waterfall 事件 {name!r} 必须给出短路理由（FR-EVT-003：短路须是文档化设计意图）")
        existing = self._modes.get(name)
        if existing is not None:
            if existing[0] != mode:
                raise EventModeError(
                    f"事件 {name!r} 已声明为 @{existing[0]}，不得改成 @{mode}（05-events.md §0 规则 1）")
            return
        self._modes[name] = (mode, bool(durable), reason.strip())
        self._listeners.setdefault(name, [])

    def install_defaults(self, *, reason_check: bool = True) -> None:
        for name, (mode, durable, reason) in self.DEFAULT_TABLE.items():
            self.declare(name, mode, durable=durable, reason=reason if reason_check else "占位理由")

    def mode_of(self, name: str) -> str | None:
        entry = self._modes.get(name)
        return None if entry is None else entry[0]

    def durable(self, name: str) -> bool:
        entry = self._modes.get(name)
        return bool(entry and entry[1])

    def declared(self) -> dict[str, str]:
        return {name: entry[0] for name, entry in sorted(self._modes.items())}

    # --- 注册（即 effect） ------------------------------------------------
    def on(self, name: str, listener: Callable[..., Any], *, prepend: bool = False,
           label: str | None = None) -> Callable[[], None]:
        self._require_declared(name)
        self._counter += 1
        entry = Listener(fn=listener, label=label or f"{name}#{self._counter}", order=self._counter)
        bucket = self._listeners.setdefault(name, [])
        bucket.insert(0, entry) if prepend else bucket.append(entry)

        def dispose() -> None:
            if entry.disposed:
                return
            entry.disposed = True
            try:
                bucket.remove(entry)
            except ValueError:  # 已被清理
                pass

        return dispose

    def listener_count(self, name: str | None = None) -> int:
        if name is None:
            return sum(len(self._active(event)) for event in self._listeners)
        return len(self._active(name))

    def listeners(self, name: str) -> list[str]:
        return [entry.label for entry in self._active(name)]

    # --- 五种分发 ---------------------------------------------------------
    def emit(self, name: str, *args: Any) -> None:
        """通知/留痕：全部调用、不看返回值。"""
        self._require_mode(name, "emit")
        for entry in self._active(name):
            entry.fn(*args)
        return None

    def parallel(self, name: str, *args: Any) -> list:
        """并发扇出：全部跑完，有错则聚合抛错。"""
        self._require_mode(name, "parallel")
        results, errors = [], []
        for entry in self._active(name):
            try:
                results.append(entry.fn(*args))
            except Exception as exc:  # noqa: BLE001 - 聚合后统一抛出
                results.append(None)
                errors.append((entry.label, exc))
        if errors:
            raise AggregateEventError(name, errors)
        return results

    def serial(self, name: str, *args: Any):
        """链式决策：遇非 None 即停。"""
        self._require_mode(name, "serial")
        for entry in self._active(name):
            result = entry.fn(*args)
            if result is not None:
                return result
        return None

    def bail(self, name: str, *args: Any):
        """首个有效决策胜出：遇真值即停。"""
        self._require_mode(name, "bail")
        for entry in self._active(name):
            result = entry.fn(*args)
            if result:
                return result
        return None

    def dispatch(self, name: str, *args: Any) -> Any:
        """按事件的 `@mode` 派发（05-events.md §0 规则 1：不得用错模式）。

        `waterfall` 的第一个参数是被链式改写/回退的载体，其余参数原样透传。
        未声明的事件按 `emit` 处理（live 语义）。
        """
        mode = self.mode_of(name)
        if mode is None or mode == "emit":
            return self.emit(name, *args)
        if mode == "bail":
            return self.bail(name, *args)
        if mode == "serial":
            return self.serial(name, *args)
        if mode == "parallel":
            return self.parallel(name, *args)
        if mode == "waterfall":
            if not args:
                raise EventError(f"waterfall 事件必须带载体参数: {name!r}")
            value, *rest = args
            return self.waterfall(name, value, *rest)
        raise EventError(f"未知 @mode={mode!r}（事件 {name!r}）")

    def waterfall(self, name: str, value: Any, *args: Any):
        """中间件链：监听者签名 (value, next, *args)；不调 next() 即短路。"""
        self._require_mode(name, "waterfall")
        entries = self._active(name)

        def run(index: int, current: Any):
            if index >= len(entries):
                return current
            entry = entries[index]
            delegated = {"next": False}

            def next_(new_value: Any = None) -> Any:
                delegated["next"] = True
                return run(index + 1, current if new_value is None else new_value)

            result = entry.fn(current, next_, *args)
            if not delegated["next"] and index + 1 < len(entries):
                self.short_circuits.append({
                    "event": name,
                    "index": index,
                    "label": entry.label,
                    "returned": _summarize(result),
                })
            return result

        return run(0, value)

    # --- 内部 -------------------------------------------------------------
    def _active(self, name: str) -> list[Listener]:
        return [entry for entry in self._listeners.get(name, []) if not entry.disposed]

    def _require_declared(self, name: str) -> None:
        if name not in self._modes:
            raise UnknownEventError(f"未声明的事件 {name!r}；先 declare(name, mode)（05-events.md §0 规则 1）")

    def _require_mode(self, name: str, mode: str) -> None:
        self._require_declared(name)
        declared = self._modes[name][0]
        if declared != mode:
            raise EventModeError(
                f"事件 {name!r} 的 @mode 是 {declared}，只能用 {declared}() 分发（05-events.md §0 规则 1）")
