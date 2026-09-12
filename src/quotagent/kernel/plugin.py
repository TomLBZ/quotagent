"""ctx.plugin：插件装载、依赖协调（reactive coeffects）与 effect 回收（`docs/design/04` §1 / `01` §4）。

语义（照搬 Cordis 的 epoch 机制，见 `01-architecture.md` §4）：
- 依赖未就绪不得激活（FR-PLUGIN-001）；
- 依赖变化自动失活/重载消费者，**不自动迁移草稿**——口径变更可能改变成本，草稿必须重新确认（FR-PLUGIN-002）；
- 卸载后无残留订阅/定时器/外部通知：一切注册都是 effect，disposer 在卸载时逆序调用（FR-PLUGIN-003 / INV-002）。
"""

from __future__ import annotations

import inspect
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

from .events import EventBus
from .ledger import Ledger, utc_now


class PluginError(RuntimeError):
    """插件系统错误基类。"""


class DependencyError(PluginError):
    """依赖未声明/取值失败。"""


@dataclass
class EffectMeta:
    id: str
    kind: str
    label: str
    owner: str
    dispose: Callable[[], None]
    disposed: bool = False

    def as_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "label": self.label,
                "owner": self.owner, "disposed": self.disposed}


class EffectScope:
    """一个插件实例（fiber）的全部 effect；`dispose_all()` 逆序、幂等释放。"""

    def __init__(self, owner: str) -> None:
        self.owner = owner
        self._effects: list[EffectMeta] = []
        self._counter = 0
        self.closed = False

    def add(self, kind: str, label: str, dispose: Callable[[], None]) -> EffectMeta:
        if self.closed:
            raise PluginError(f"scope {self.owner} 已关闭：不得再注册 effect")
        self._counter += 1
        meta = EffectMeta(id=f"{self.owner}#{self._counter}", kind=kind, label=label,
                          owner=self.owner, dispose=dispose)
        self._effects.append(meta)
        return meta

    def dispose_all(self) -> None:
        self.closed = True
        for meta in reversed(self._effects):
            if meta.disposed:
                continue
            try:
                meta.dispose()
            finally:
                meta.disposed = True

    @property
    def active(self) -> bool:
        return not self.closed

    def metas(self) -> list[EffectMeta]:
        return [m for m in self._effects if not m.disposed]

    def history(self) -> list[dict]:
        return [m.as_dict() for m in self._effects]


class Interval:
    """一个可撤销的定时器 effect（INV-002：卸载后不得继续触发）。"""

    def __init__(self, seconds: float, fn: Callable[[], None], *, label: str) -> None:
        self.seconds = seconds
        self.fn = fn
        self.label = label
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name=f"quotagent-interval-{label}", daemon=True)

    def start(self) -> "Interval":
        self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.wait(self.seconds):
            self.fn()

    def dispose(self) -> None:
        self._stop.set()


@dataclass
class Fiber:
    name: str
    spec: dict
    config: dict
    inject: tuple = ()
    provides: tuple = ()
    status: str = "pending"          # pending | active | inactive | disposed
    activation_epoch: int = 0
    scope: EffectScope | None = None
    scopes: list = field(default_factory=list)
    state: dict = field(default_factory=dict)
    drafts: dict = field(default_factory=dict)
    created_at: str = ""
    error: str | None = None

    def as_dict(self) -> dict:
        return {"name": self.name, "status": self.status, "inject": list(self.inject),
                "provides": list(self.provides), "activation_epoch": self.activation_epoch,
                "effects": len(self.scope.metas()) if self.scope else 0, "error": self.error}


class ScopedLedger:
    """插件视角的账本：`on_append` 自动登记为本 fiber 的 effect（订阅不得残留，INV-002 / FR-PLUGIN-003）。"""

    def __init__(self, ctx: "PluginContext") -> None:
        self._ctx = ctx
        self._ledger = ctx.plugin.ledger

    def on_append(self, callback: Callable[[dict], None], *, label: str | None = None) -> EffectMeta:
        dispose = self._ledger.on_append(callback)
        return self._ctx.effect("subscription",
                                label or f"{self._ctx.fiber.name}:ledger-append", dispose)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._ledger, item)


class PluginContext:
    """交给插件 `setup(ctx)` 的上下文：一切注册都自动登记为本 fiber 的 effect。"""

    def __init__(self, host: "PluginHost", fiber: Fiber) -> None:
        self._host = host
        self.plugin = host
        self.fiber = fiber
        self.events = host.events
        self.ledger = ScopedLedger(self)

    # 数据（随 fiber 生命周期）
    @property
    def state(self) -> dict:
        return self.fiber.state

    @property
    def config(self) -> dict:
        return self.fiber.config

    def set_draft(self, key: str, value: Any) -> None:
        self.fiber.drafts[key] = value

    # 依赖
    def service(self, name: str) -> Any:
        value = self._host.service(name)
        if value is None and not self._host.has_service(name):
            raise DependencyError(f"插件 {self.fiber.name} 请求的依赖 {name!r} 当前不可用")
        return value

    # effect 注册
    def effect(self, kind: str, label: str, dispose: Callable[[], None]) -> EffectMeta:
        scope = self.fiber.scope
        if scope is None:
            raise PluginError(f"fiber {self.fiber.name} 未激活，不能注册 effect")
        meta = scope.add(kind, label, dispose)
        self._host._register_effect(meta)
        return meta

    def on(self, name: str, listener: Callable[..., Any], *, prepend: bool = False,
           label: str | None = None) -> EffectMeta:
        dispose = self.events.on(name, listener, prepend=prepend, label=label or f"{self.fiber.name}:{name}")
        return self.effect("listener", label or f"{self.fiber.name}:{name}", dispose)

    def set_interval(self, seconds: float, fn: Callable[[], None], *, label: str | None = None) -> EffectMeta:
        interval = Interval(seconds, fn, label=label or f"{self.fiber.name}:interval").start()
        return self.effect("timer", label or f"{self.fiber.name}:interval", interval.dispose)

    def emit(self, name: str, *args: Any) -> None:
        self.events.emit(name, *args)


class PluginHost:
    """ctx.plugin：装载 / 卸载 / 依赖协调 / 配置更新。"""

    def __init__(self, *, events: EventBus | None = None, ledger: Ledger | None = None,
                 name: str = "ctx.plugin") -> None:
        self.name = name
        self.events = events or EventBus()
        if not self.events.declared():
            self.events.install_defaults()
        self.ledger = ledger
        if ledger is not None:
            ledger.attach_events(self.events)
        self._fibers: dict[str, Fiber] = {}
        self._order: list[str] = []
        self._services: dict[str, tuple[str, Any]] = {}   # 服务名 -> (提供者 fiber, 值)
        self._effects: dict[str, EffectMeta] = {}
        self._activation_log: list[dict] = []

    # --- 装载/卸载 --------------------------------------------------------
    def mount(self, spec: Any, config: dict | None = None, *, name: str | None = None) -> Fiber:
        normalized = _normalize_spec(spec, name=name)
        fiber_name = normalized["name"]
        if fiber_name in self._fibers:
            raise PluginError(f"插件名重复: {fiber_name}")
        fiber = Fiber(name=fiber_name, spec=normalized, config=dict(config or normalized.get("config") or {}),
                      inject=tuple(normalized.get("inject") or ()),
                      provides=tuple((normalized.get("provide") or {}).keys()),
                      created_at=utc_now())
        self._fibers[fiber_name] = fiber
        self._order.append(fiber_name)
        for service_name, value in (normalized.get("provide") or {}).items():
            if service_name in self._services:
                raise PluginError(f"服务名重复: {service_name}（已由 {self._services[service_name][0]} 提供）")
            self._services[service_name] = (fiber_name, value)
        self.events.emit("kernel/plugin-mounted", fiber.as_dict())
        self._reconcile()
        return fiber

    def unmount(self, fiber: Fiber | str) -> None:
        target = self.get(fiber) if isinstance(fiber, str) else fiber
        if target is None:
            raise PluginError(f"未装载的插件: {fiber!r}")
        if target.status == "disposed":
            return
        self._deactivate(target, "unmounted")
        target.status = "disposed"
        for service_name, (owner, _value) in list(self._services.items()):
            if owner == target.name:
                del self._services[service_name]
        self.events.emit("kernel/plugin-unmounted", target.as_dict())
        self._reconcile()

    def update(self, fiber: Fiber | str, config: dict) -> dict:
        """配置更新先过可否决的 `kernel/config-updated`（FR-PLUGIN-004）；否决则不生效。"""
        target = self.get(fiber) if isinstance(fiber, str) else fiber
        if target is None:
            raise PluginError(f"未装载的插件: {fiber!r}")
        proposal = {"fiber": target.name, "from": dict(target.config), "to": dict(config)}
        verdict = self.events.waterfall("kernel/config-updated", proposal)
        if isinstance(verdict, dict) and verdict.get("vetoed"):
            self._activation_log.append({"fiber": target.name, "event": "config-vetoed",
                                         "reason": verdict.get("reason", ""), "at": utc_now()})
            return {"applied": False, "config": dict(target.config), "verdict": verdict}
        target.config = dict(config)
        if target.status == "active":
            self._deactivate(target, "config-updated")
            self._reconcile()
        return {"applied": True, "config": dict(target.config)}

    # --- 查询 -------------------------------------------------------------
    def get(self, name: str) -> Fiber | None:
        return self._fibers.get(name)

    def fibers(self) -> list[Fiber]:
        return [self._fibers[name] for name in self._order if name in self._fibers]

    def effects(self, fiber: Fiber | str) -> list[EffectMeta]:
        target = self.get(fiber) if isinstance(fiber, str) else fiber
        if target is None or target.scope is None:
            return []
        return list(target.scope.metas())

    def disposals(self, fiber: Fiber | str) -> list[dict]:
        target = self.get(fiber) if isinstance(fiber, str) else fiber
        if target is None:
            return []
        return [entry for scope in target.scopes for entry in scope.history()]

    def drafts(self, fiber: Fiber | str) -> dict:
        target = self.get(fiber) if isinstance(fiber, str) else fiber
        return {} if target is None else dict(target.drafts)

    def service(self, name: str) -> Any:
        entry = self._services.get(name)
        if entry is None:
            return None
        owner, value = entry
        fiber = self._fibers.get(owner)
        if fiber is None or fiber.status != "active":
            return None
        return value

    def has_service(self, name: str) -> bool:
        entry = self._services.get(name)
        if entry is None:
            return False
        fiber = self._fibers.get(entry[0])
        return fiber is not None and fiber.status == "active"

    def timer_count(self) -> int:
        return len([m for m in self._effects.values() if m.kind == "timer" and not m.disposed])

    def effect_count(self) -> int:
        return len([m for m in self._effects.values() if not m.disposed])

    def activation_log(self) -> list[dict]:
        return list(self._activation_log)

    def require(self, name: str) -> Fiber:
        fiber = self.get(name)
        if fiber is None:
            raise PluginError(f"未装载的插件: {name}")
        return fiber

    # --- 内部 -------------------------------------------------------------
    def _register_effect(self, meta: EffectMeta) -> None:
        self._effects[meta.id] = meta

    def _service_ready(self, name: str) -> bool:
        return self.has_service(name)

    def _reconcile(self) -> None:
        changed = True
        while changed:
            changed = False
            for fiber in self.fibers():
                if fiber.status == "disposed":
                    continue
                ready = all(self._service_ready(dep) for dep in fiber.inject)
                if ready and fiber.status in ("pending", "inactive"):
                    self._activate(fiber)
                    changed = True
                elif not ready and fiber.status == "active":
                    self._deactivate(fiber, "dependency-lost")
                    changed = True

    def _activate(self, fiber: Fiber) -> None:
        scope = EffectScope(fiber.name)
        fiber.scope = scope
        fiber.scopes.append(scope)
        fiber.activation_epoch += 1
        fiber.status = "active"
        fiber.error = None
        self._activation_log.append({"fiber": fiber.name, "event": "activated",
                                     "epoch": fiber.activation_epoch, "at": utc_now()})
        setup = fiber.spec.get("setup")
        if setup is None:
            return
        ctx = PluginContext(self, fiber)
        try:
            if _accepts_config(setup):
                setup(ctx, dict(fiber.config))
            else:
                setup(ctx)
        except Exception as exc:  # noqa: BLE001 - 失败必须无残留
            fiber.error = f"{type(exc).__name__}: {exc}"
            self._deactivate(fiber, "setup-failed")
            raise

    def _deactivate(self, fiber: Fiber, reason: str) -> None:
        if fiber.scope is not None:
            fiber.scope.dispose_all()    # 逆序释放全部 effect；scope 对象保留以供审计
        drafts = len(fiber.drafts)
        fiber.drafts.clear()             # 不自动迁移草稿（01-architecture.md §4）
        if fiber.status != "disposed":
            fiber.status = "inactive"
        self._activation_log.append({"fiber": fiber.name, "event": "deactivated", "reason": reason,
                                     "drafts_dropped": drafts, "at": utc_now()})


def _accepts_config(setup: Callable[..., Any]) -> bool:
    """插件入口统一为 `setup(ctx)`；同时兼容 `setup(ctx, config)`（配置也总能在 `ctx.config` 取到）。"""
    try:
        signature = inspect.signature(setup)
    except (TypeError, ValueError):
        return False
    positional = [p for p in signature.parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    if any(p.kind == p.VAR_POSITIONAL for p in signature.parameters.values()):
        return False
    return len(positional) >= 2


def _normalize_spec(spec: Any, *, name: str | None = None) -> dict:
    if isinstance(spec, dict):
        normalized = dict(spec)
    else:
        normalized = {
            "name": getattr(spec, "name", None),
            "inject": list(getattr(spec, "inject", ()) or ()),
            "provide": dict(getattr(spec, "provide", {}) or {}),
            "setup": getattr(spec, "setup", None),
            "config": dict(getattr(spec, "config", {}) or {}),
        }
    if name:
        normalized["name"] = name
    if not normalized.get("name"):
        raise PluginError("插件必须有 name")
    normalized.setdefault("inject", [])
    normalized.setdefault("provide", {})
    return normalized
