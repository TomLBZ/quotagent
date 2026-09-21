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


# --------------------------------------------------------------------------- P1（宿主层，T-201）
# AC-PLUGIN-003 把 **cordis 宿主当作被测进程**：Python 侧只发命令、读 JSON 帧（评审 R-P1-06）。
_HOST_CLI = ("run", "cli.mjs")


def _resolve_node() -> str | None:
    """宿主需要 Node：先看 PATH，再看工作区运行时（与 tools/cordis.sh 同序）。"""
    import os
    import shutil
    from pathlib import Path as _Path

    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(_Path("/workspace/runtime/node").glob("*/bin/node")):
        if os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _repo_root():
    from pathlib import Path as _Path
    return _Path(__file__).resolve().parents[3]


def _host(root, *args, timeout: int = 60):
    """跑一次宿主 CLI，返回（退出码, 解析后的 JSON 或 None, 原始输出）。"""
    import json
    import os
    import subprocess
    from pathlib import Path as _Path

    node = _resolve_node()
    repo = _repo_root()
    env = dict(os.environ)
    if node:
        env["QUOTAGENT_NODE"] = node
    proc = subprocess.run([str(repo / "tools" / "cordis.sh"), *_HOST_CLI, *args],
                          cwd=str(repo), capture_output=True, text=True, timeout=timeout, env=env)
    raw = (proc.stdout or "") + (proc.stderr or "")
    payload = None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                payload = None
    return proc.returncode, payload, raw


@register("AC-PLUGIN-003", "P1", "更新配置时否决者生效：配置未变、插件未重启（cordis 原生 internal/update 瀑布）",
          "qa ac AC-PLUGIN-003", evidence_refs=("EV-039",))
def ac_plugin_003() -> list[Assertion]:
    import json
    import subprocess
    import time as _time

    out: list[Assertion] = []
    root = new_scratch("ac-plugin-003")
    node = _resolve_node()
    out.append(Assertion("宿主可用（找得到 Node；宿主 AC 需要它）", node is not None,
                         f"node={node}（可设 QUOTAGENT_NODE 或 source /workspace/bin/activate.sh）"))
    if node is None:
        return out

    code, help_payload, raw = _host(root, "help")
    out.append(Assertion("宿主自描述：三个 profile（contractor-ops / supplier-bid / relay）+ cordis 版本",
                         code == 0 and help_payload and
                         sorted(help_payload.get("profiles", [])) == ["contractor-ops", "relay", "supplier-bid"]
                         and help_payload.get("cordis_version", "").startswith("4.0.0-rc."),
                         f"exit={code} payload={json.dumps(help_payload, ensure_ascii=False)[:160]} "
                         f"raw={raw.strip()[:120]}"))

    code, boot, raw = _host(root, "boot", "--profile", "contractor-ops", "--root", str(root))
    out.append(Assertion("profile 可启动且组成即数据（realm/账本/模块清单/配置摘要都可见）",
                         code == 0 and boot and boot.get("ok") is True
                         and boot["realm"] == "contractor:con-B"
                         and boot["ledger"].endswith("ledger-contractor.jsonl")
                         and boot["modules"] and boot["config_digest"].startswith("sha256:"),
                         f"exit={code} boot={json.dumps(boot, ensure_ascii=False)[:220]}"))
    config_file = root / "contractor-ops" / "config.json"
    out.append(Assertion("配置落盘（<root>/<profile>/config.json），宿主不写仓库外文件",
                         config_file.exists(), f"path={config_file}"))

    # --- 双侧进程分离：两个 profile = 两个真进程、两个 realm、两本账本 ---
    procs = []
    for profile in ("contractor-ops", "supplier-bid"):
        proc = subprocess.Popen(
            [str(_repo_root() / "tools" / "cordis.sh"), *_HOST_CLI, "boot",
             "--profile", profile, "--root", str(root / "two"), "--hold", "3"],
            cwd=str(_repo_root()), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**__import__("os").environ, "QUOTAGENT_NODE": node})
        line = proc.stdout.readline()
        procs.append((profile, proc, json.loads(line) if line.strip().startswith("{") else None))
    for _, proc, _ in procs:
        proc.communicate(timeout=15)
    manifests = {profile: payload for profile, _, payload in procs}
    out.append(Assertion("双侧进程分离：两个 profile 是两个真进程（pid/realm/账本/配置摘要各不相同）",
                         all(payload for payload in manifests.values())
                         and manifests["contractor-ops"]["pid"] != manifests["supplier-bid"]["pid"]
                         and manifests["contractor-ops"]["realm"] != manifests["supplier-bid"]["realm"]
                         and manifests["contractor-ops"]["ledger"] != manifests["supplier-bid"]["ledger"]
                         and manifests["contractor-ops"]["config_digest"]
                         != manifests["supplier-bid"]["config_digest"],
                         f"pids={ {p: m['pid'] for p, m in manifests.items() if m} } "
                         f"realms={ {p: m['realm'] for p, m in manifests.items() if m} }"))

    # --- 否决生效（核心断言）---
    before_bytes = config_file.read_bytes()
    code, veto, raw = _host(root, "config-update", "--profile", "contractor-ops", "--root", str(root),
                            "--patch", json.dumps({"kernel": {"max_events": 1}}),
                            "--source", "human:zhang", "--reason", "试图改内核")
    out.append(Assertion("内核命名空间更新被否决，且**配置未变**（摘要不变、文件字节不变）",
                         code == 0 and veto and veto["accepted"] is False
                         and veto["vetoed_by"] == "frozen"
                         and any("INV-010" in reason for reason in veto["reasons"])
                         and veto["digest_before"] == veto["digest_after"]
                         and veto["config_file_changed"] is False
                         and config_file.read_bytes() == before_bytes,
                         f"veto={json.dumps(veto, ensure_ascii=False)[:260] if veto else raw[:200]}"))
    out.append(Assertion("被否决时**插件未重启**（激活代不变；cordis 不调 next() 即不 restart）",
                         veto and veto["epoch_before"] == veto["epoch_after"] and veto["restarted"] is False,
                         f"epoch={veto.get('epoch_before')}->{veto.get('epoch_after')} "
                         f"restarted={veto.get('restarted')}"))

    code, human_only, _ = _host(root, "config-update", "--profile", "contractor-ops", "--root", str(root),
                                "--patch", json.dumps({"pricing": {"authorized_band": {"min_unit_price": 1}}}),
                                "--source", "agent:price", "--reason", "自动放开区间")
    out.append(Assertion("人工专属键（授权区间）不接受 agent 来源（理由指明 human-only）",
                         code == 0 and human_only and human_only["accepted"] is False
                         and any("human-only" in reason for reason in human_only["reasons"]),
                         f"reasons={human_only.get('reasons') if human_only else None}"))

    code, unknown, _ = _host(root, "config-update", "--profile", "contractor-ops", "--root", str(root),
                             "--patch", json.dumps({"whatever": {"new": 1}}),
                             "--source", "human:zhang")
    out.append(Assertion("白名单外的键被拒（unknown-key，H10）",
                         code == 0 and unknown and unknown["accepted"] is False
                         and any("unknown-key" in reason for reason in unknown["reasons"]),
                         f"reasons={unknown.get('reasons') if unknown else None}"))

    # --- 无违规的更新：生效（cordis 语义：生效即 restart，激活代递增）---
    code, accepted, _ = _host(root, "config-update", "--profile", "contractor-ops", "--root", str(root),
                              "--patch", json.dumps({"compare": {"weights": {"price": 0.5}}}),
                              "--source", "human:zhang", "--reason", "价格优先")
    out.append(Assertion("无违规的更新生效：摘要变化 + 落盘（生效即 restart 是 cordis 原生语义）",
                         code == 0 and accepted and accepted["accepted"] is True
                         and accepted["digest_before"] != accepted["digest_after"]
                         and accepted["config_file_changed"] is True,
                         f"accepted={json.dumps(accepted, ensure_ascii=False)[:240] if accepted else None}"))
    code, again, _ = _host(root, "config-update", "--profile", "contractor-ops", "--root", str(root),
                           "--patch", json.dumps({"compare": {"weights": {"price": 0.5}}}),
                           "--source", "human:zhang")
    out.append(Assertion("重复同一更新不产生假否决（只对**改动差集**判定，摘要不变）",
                         code == 0 and again and again["accepted"] is True
                         and again["digest_before"] == again["digest_after"],
                         f"again={json.dumps(again, ensure_ascii=False)[:200] if again else None}"))
    _time.sleep(0)
    return out
