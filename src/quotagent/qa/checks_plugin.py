"""插件装载 AC（T-104）：AC-PLUGIN-001（卸载无残留，INV-002）、AC-PLUGIN-002（依赖失活/重载不迁移草稿）。"""

from __future__ import annotations

import time

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..kernel.plugin import PluginHost
from ..paths import new_scratch
from .registry import Assertion, register


def _stack(tmp_name: str, realm: str):
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "ledger.jsonl", realm=realm)
    bus = EventBus()
    bus.install_defaults()
    host = PluginHost(events=bus, ledger=ledger)
    return root, ledger, bus, host


@register("AC-PLUGIN-001", "P0", "装载后 effects() 非空；卸载后为空且无残留定时器/订阅/监听",
          "qa ac AC-PLUGIN-001", evidence_refs=("EV-011",))
def ac_plugin_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, host = _stack("plugin-001", "contractor:con-B")

    base = {"listeners": bus.listener_count(), "hooks": ledger.append_hook_count(),
            "timers": host.timer_count()}
    ticks: list[int] = []
    hook_calls: list[int] = []

    def setup(ctx) -> None:
        ctx.on("kernel/ledger-appended", lambda *a: None, label="ledger-tap")
        ctx.ledger.on_append(lambda rec: hook_calls.append(rec["seq"]))
        ctx.set_interval(0.02, lambda: ticks.append(1))

    fiber = host.mount({"name": "demo-plugin", "setup": setup})
    effects = host.effects(fiber)
    mounted_ok = (fiber.status == "active" and len(effects) >= 3
                  and bus.listener_count() > base["listeners"]
                  and ledger.append_hook_count() > base["hooks"]
                  and host.timer_count() > base["timers"])
    out.append(Assertion("装载后 effects() 非空，且三类注册（监听/订阅/定时器）都真实生效",
                         mounted_ok,
                         f"status={fiber.status} effects={[e.kind for e in effects]} "
                         f"listeners={bus.listener_count()}/{base['listeners']} "
                         f"hooks={ledger.append_hook_count()}/{base['hooks']} timers={host.timer_count()}"))

    ledger.append("rfq/published", {"package_id": "pkg-014"}, correlation_id="corr-1")
    time.sleep(0.09)
    fired_before = len(ticks)
    out.append(Assertion("定时器与订阅在装载期间真的在工作（不是只登记不生效）",
                         fired_before > 0 and len(hook_calls) == 1,
                         f"ticks={fired_before} hook_calls={hook_calls}"))

    host.unmount(fiber)
    after = {"listeners": bus.listener_count(), "hooks": ledger.append_hook_count(),
             "timers": host.timer_count()}
    out.append(Assertion("卸载后 effects() 为空且状态为 disposed",
                         host.effects(fiber) == [] and fiber.status == "disposed",
                         f"effects={host.effects(fiber)} status={fiber.status}"))
    out.append(Assertion("卸载后无残留监听/订阅/定时器（INV-002）", after == base,
                         f"after={after} base={base}"))

    time.sleep(0.1)
    ledger.append("rfq/published", {"package_id": "pkg-014", "n": 2}, correlation_id="corr-2")
    time.sleep(0.06)
    out.append(Assertion("卸载后定时器不再触发、订阅不再回调",
                         len(ticks) == fired_before and len(hook_calls) == 1,
                         f"ticks={fired_before}->{len(ticks)} hook_calls={len(hook_calls)}"))

    disposal = host.disposals(fiber)
    out.append(Assertion("每个 effect 都有一次性 disposer，且卸载时全部被调用",
                         bool(disposal) and all(d["disposed"] for d in disposal),
                         f"disposals={disposal}"))
    return out


@register("AC-PLUGIN-002", "P0", "依赖失活 → 消费者非激活；恢复 → 自动重载且不迁移草稿",
          "qa ac AC-PLUGIN-002", evidence_refs=("EV-012",))
def ac_plugin_002() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, host = _stack("plugin-002", "supplier:sup-A")

    activation_log: list[str] = []

    def consumer_setup(ctx) -> None:
        epoch = ctx.fiber.activation_epoch
        activation_log.append(f"epoch-{epoch}")
        ctx.on("kernel/ledger-appended", lambda *a: None, label="consumer-tap")
        ctx.state["norm_snapshot"] = ctx.service("norm")
        ctx.set_draft("quote", {"amount": 1000, "epoch": epoch})

    consumer_spec = {"name": "pricing", "inject": ["norm"], "setup": consumer_setup}
    pending_fiber = host.mount(dict(consumer_spec))
    out.append(Assertion("依赖未就绪不得激活（FR-PLUGIN-001）",
                         pending_fiber.status == "pending" and host.effects(pending_fiber) == []
                         and activation_log == [],
                         f"status={pending_fiber.status} effects={host.effects(pending_fiber)} log={activation_log}"))

    host.mount({"name": "norm-provider", "provide": {"norm": {"table": "units@v1"}}})
    consumer = host.get("pricing")
    active_ok = (consumer.status == "active" and len(host.effects(consumer)) >= 1
                 and consumer.state.get("norm_snapshot") == {"table": "units@v1"})
    out.append(Assertion("依赖就绪后自动激活，且注入的服务可取值",
                         active_ok,
                         f"status={consumer.status} effects={len(host.effects(consumer))} "
                         f"norm={consumer.state.get('norm_snapshot')}"))

    draft_before = host.drafts(consumer)
    epoch_before = consumer.activation_epoch
    out.append(Assertion("激活期间草稿存在（用于验证不会跨重载迁移）",
                         draft_before == {"quote": {"amount": 1000, "epoch": 1}},
                         f"drafts={draft_before}"))

    host.unmount(host.get("norm-provider"))
    out.append(Assertion("依赖失活 → 消费者转为非激活且 effects 全部回收",
                         consumer.status == "inactive" and host.effects(consumer) == [],
                         f"status={consumer.status} effects={host.effects(consumer)}"))
    out.append(Assertion("依赖失活时草稿不迁移（按 01-architecture.md §4：口径可能已变，必须重新确认）",
                         host.drafts(consumer) == {},
                         f"drafts={host.drafts(consumer)}（失活前={draft_before}）"))

    host.mount({"name": "norm-provider-2", "provide": {"norm": {"table": "units@v2"}}})
    reloaded = (consumer.status == "active" and consumer.activation_epoch > epoch_before
                and len(host.effects(consumer)) >= 1)
    out.append(Assertion("依赖恢复 → 自动重载（epoch 递增），无需人工重新装载",
                         reloaded,
                         f"status={consumer.status} epoch={epoch_before}->{consumer.activation_epoch} "
                         f"effects={len(host.effects(consumer))}"))
    out.append(Assertion("重载后草稿是重新生成的（epoch=2），不是上一轮迁移过来的（epoch=1）",
                         host.drafts(consumer) == {"quote": {"amount": 1000, "epoch": 2}}
                         and consumer.state.get("norm_snapshot") == {"table": "units@v2"},
                         f"drafts={host.drafts(consumer)} norm={consumer.state.get('norm_snapshot')}"))
    out.append(Assertion("每次激活/失活都有记录（可观测，不是静默状态变化）",
                         len(activation_log) == 2,
                         f"activation_log={activation_log}"))
    return out
