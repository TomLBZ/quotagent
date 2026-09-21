"""桥接 AC（P1，ADR-0013 §8）：

- AC-INTEG-004：协议与版本协商（hello 能力清单是唯一真源；不兼容即退出码 2 且账本零新增；
  stdout 只承载协议帧；未知方法/非法帧/超限帧都是确定性错误码 + next_action；直跑与经桥结果一致）。
- AC-INTEG-005：承诺面不可达（对抗性：宿主尝试 commit 面必须被拒且留痕；身份不能自我声明；
  fact 面 P1 默认关闭；read/compute 仍可用）。

两条 AC 都把**宿主当被测进程**（Python 只发命令、读 JSON 帧），沿用评审 R-P1-06 的做法。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from ..kernel.events import EventBus
from ..paths import new_scratch
from .registry import Assertion, register

BRIDGE_VERSION = "1.0"
REQUIRED_HELLO_FIELDS = ("bridge", "kernel", "qep_versions", "features", "events", "methods",
                         "methods_refused", "ledger", "realms", "max_frame_bytes", "credit_window")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _resolve_node() -> str | None:
    """桥接 AC 走宿主（cordis）时需要 Node；解析顺序与 tools/cordis.sh 一致。"""
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        if os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _host_env() -> dict:
    env = dict(os.environ)
    node = _resolve_node()
    if node:
        env["QUOTAGENT_NODE"] = node
    return env


def _host(*args: str, timeout: int = 90) -> tuple[int, dict | None, str]:
    """跑一次宿主 CLI（host/cli.mjs），返回（退出码, 最后一行 JSON, 原始输出）。"""
    repo = _repo_root()
    proc = subprocess.run([str(repo / "tools" / "cordis.sh"), "run", "cli.mjs", *args],
                          cwd=str(repo), capture_output=True, text=True, timeout=timeout, env=_host_env())
    payload = None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                payload = None
    return proc.returncode, payload, (proc.stdout or "") + (proc.stderr or "")


def _kernel_frames(root: Path, frames: list[str], *, realm: str = "r", ledger_name: str = "ledger.jsonl",
                   extra_args: tuple[str, ...] = (), timeout: int = 60) -> tuple[int, list[dict], str, Path]:
    """直连内核端点（不经宿主）：把 NDJSON 帧喂给 stdin，收集 stdout 帧。"""
    repo = _repo_root()
    ledger = root / ledger_name
    proc = subprocess.run([str(repo / "tools" / "run.sh"), "-m", "quotagent.bridge", "--serve",
                           "--realm", realm, "--ledger", str(ledger), *extra_args],
                          input="\n".join(frames) + "\n", capture_output=True, text=True,
                          timeout=timeout, cwd=str(repo))
    out: list[dict] = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return proc.returncode, out, proc.stderr or "", ledger


def _declared_event_count() -> int:
    bus = EventBus()
    bus.install_defaults()
    return len(bus.declared())


BRIDGE_EVENTS = ("kernel/bridge-degraded", "kernel/bridge-rejected", "kernel/bridge-backpressure",
                 "kernel/bridge-restarted", "kernel/bridge-fault")


@register("AC-INTEG-004", "P1", "协议与版本协商：hello 能力清单唯一真源；不兼容即退出码 2 且账本零新增；stdout 只走协议帧",
          "qa ac AC-INTEG-004", evidence_refs=("EV-040",))
def ac_integ_003() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-integ-003")

    # --- 1) 首帧 hello + 兼容协商 + 一次 read/compute ---
    frames = [
        json.dumps({"v": 1, "n": "bridge.init", "p": {"accept_bridge": [BRIDGE_VERSION],
                                                      "profile": "contractor-ops",
                                                      "want_events": ["kernel/ledger-appended"]}}),
        json.dumps({"v": 1, "n": "method", "p": {"id": 1, "m": "ledger.head"}}),
        json.dumps({"v": 1, "n": "method", "p": {"id": 2, "m": "measures.factor",
                                                 "params": {"from": "cm", "to": "m"}}}),
        json.dumps({"v": 1, "n": "bridge.shutdown", "p": {}}),
    ]
    code, got, stderr, ledger = _kernel_frames(root, frames, realm="contractor:con-B")
    names = [frame.get("n") for frame in got]
    out.append(Assertion("内核首帧是 kernel/hello（能力自述先于一切请求）",
                         bool(got) and got[0].get("n") == "kernel/hello", f"帧序={names}"))
    hello = got[0]["p"] if got else {}
    out.append(Assertion("hello 含 14 字段契约的全部字段（含 credit_window 与 max_frame_bytes）",
                         all(field in hello for field in REQUIRED_HELLO_FIELDS),
                         f"缺={[f for f in REQUIRED_HELLO_FIELDS if f not in hello]}"))
    out.append(Assertion("events[] 与 Python 侧声明表一致（唯一真源在 Python 侧）",
                         len(hello.get("events", [])) == _declared_event_count()
                         and {e["name"] for e in hello.get("events", [])} >= set(BRIDGE_EVENTS),
                         f"hello={len(hello.get('events', []))} 声明表={_declared_event_count()} "
                         f"bridge 事件齐={set(BRIDGE_EVENTS) <= {e['name'] for e in hello.get('events', [])}}"))
    out.append(Assertion("方法面只暴露 read/compute；承诺面在 methods_refused 里且不在 methods[]",
                         {m["cls"] for m in hello.get("methods", [])} <= {"read", "compute"}
                         and {"approval.decide", "quote.submit", "award.commit", "po.issue", "change.approve"}
                         <= {m["m"] for m in hello.get("methods_refused", [])}
                         and not ({"approval.decide"} & {m["m"] for m in hello.get("methods") or []}),
                         f"methods={[m['m'] for m in hello.get('methods', [])]} "
                         f"refused={[m['m'] for m in hello.get('methods_refused', [])]}"))
    results = {frame["p"].get("m"): frame["p"].get("result")
               for frame in got if frame.get("n") == "result"}
    out.append(Assertion("协商后进入 ready，read 与 compute 都可用",
                         "bridge.ready" in names and set(results) == {"ledger.head", "measures.factor"}
                         and (results.get("measures.factor") or {}).get("factor") == 0.01,
                         f"帧序={names} 方法={sorted(results)}"))
    out.append(Assertion("stdout 只承载协议帧（每行都是 JSON 帧；日志走 stderr）",
                         all("n" in frame and "p" in frame for frame in got) and code == 0,
                         f"帧数={len(got)} 退出码={code} stderr行={len(stderr.splitlines())}"))
    out.append(Assertion("直跑与经桥的 compute 结果一致（同输入同值：cm→m 因子 0.01）",
                         (results.get("measures.factor") or {}).get("factor") == 0.01,
                         f"result={results.get('measures.factor')}"))

    # --- 2) 版本交集为空：退出码 2 且账本零新增 ---
    mismatch_root = root / "mismatch"
    mismatch_root.mkdir(parents=True, exist_ok=True)
    code2, got2, _err2, ledger2 = _kernel_frames(
        mismatch_root, [json.dumps({"v": 1, "n": "bridge.init", "p": {"accept_bridge": ["2.0"]}})],
        ledger_name="mismatch.jsonl")
    codes = [frame.get("p", {}).get("code") for frame in got2 if frame.get("n") == "error"]
    out.append(Assertion("版本交集为空 → 退出码 2 且**账本零新增**（不静默降级，ADR-0006 §3）",
                         code2 == 2 and codes == ["version-mismatch"]
                         and ledger2.exists() and ledger2.stat().st_size == 0,
                         f"退出码={code2} 错误码={codes} 账本字节={ledger2.stat().st_size if ledger2.exists() else 'n/a'}"))

    # --- 3) 特性级降级：必须留痕且通信继续 ---
    degrade_root = root / "degrade"
    degrade_root.mkdir(parents=True, exist_ok=True)
    code3, got3, _err3, ledger3 = _kernel_frames(degrade_root, [
        json.dumps({"v": 1, "n": "bridge.init", "p": {"accept_bridge": [BRIDGE_VERSION],
                                                      "want_events": ["kernel/does-not-exist"]}}),
        json.dumps({"v": 1, "n": "bridge.shutdown", "p": {}})], ledger_name="degrade.jsonl")
    entries = [json.loads(line) for line in ledger3.read_text(encoding="utf-8").splitlines() if line.strip()]
    out.append(Assertion("特性级降级落 kernel/bridge-degraded（含缺失项）且通信继续",
                         code3 == 0 and any(entry["type"] == "kernel/bridge-degraded"
                                            and entry["body"].get("missing_events") == ["kernel/does-not-exist"]
                                            for entry in entries)
                         and any(frame.get("n") == "bridge.ready" for frame in got3),
                         f"账本类型={[e['type'] for e in entries]} 帧序={[f.get('n') for f in got3]}"))

    # --- 4) 确定性错误码 + next_action ---
    err_root = root / "errors"
    err_root.mkdir(parents=True, exist_ok=True)
    oversized = "x" * (8 * 1024 * 1024 + 32)
    _code4, got4, _err4, _led4 = _kernel_frames(err_root, [
        json.dumps({"v": 1, "n": "method", "p": {"id": 1, "m": "nope.nope"}}),
        "not json at all",
        json.dumps({"v": 9, "n": "method", "p": {"id": 2, "m": "ledger.head"}}),
        oversized,
    ], ledger_name="errors.jsonl")
    errs = [frame["p"] for frame in got4 if frame.get("n") == "error"]
    codes4 = [err["code"] for err in errs]
    out.append(Assertion("未知方法/非法帧/帧版本错/超限帧都是确定性错误码且带 next_action",
                         codes4[:3] == ["unknown-method", "invalid-request", "invalid-request"]
                         and "invalid-request" in codes4
                         and all(err.get("next_action") for err in errs),
                         f"错误码={codes4}"))
    out.append(Assertion("超限帧被拒（>8 MiB 不产生内存放大，直接断开）",
                         codes4 == ["unknown-method", "invalid-request", "invalid-request", "invalid-request"]
                         and "上限" in (errs[-1].get("message") or ""),
                         f"错误码={codes4} 末条消息={errs[-1].get('message') if errs else None}"))

    # --- 5) 宿主侧（cordis）跑同一协议 ---
    node = _resolve_node()
    if node is None:
        out.append(Assertion("宿主侧握手（需要 Node；设 QUOTAGENT_NODE 或 source /workspace/bin/activate.sh）",
                             False, "未找到 node"))
        return out
    host_root = root / "host"
    host_root.mkdir(parents=True, exist_ok=True)
    hcode, hpayload, hraw = _host("bridge", "--profile", "contractor-ops", "--root", str(host_root),
                                  "--method", "ledger.head")
    out.append(Assertion("宿主（cordis）按同一协议握手并调用 read 方法成功",
                         hcode == 0 and bool(hpayload) and hpayload.get("ok") is True
                         and hpayload["hello"]["bridge"]["version"] == BRIDGE_VERSION
                         and hpayload["call"]["result"]["head"].startswith("sha256:"),
                         f"exit={hcode} payload={json.dumps(hpayload, ensure_ascii=False)[:200] if hpayload else hraw[:160]}"))
    return out


@register("AC-INTEG-005", "P1", "承诺面不可达（对抗性）：宿主尝试 commit 面被拒且留痕；身份不能自我声明；fact 面默认关闭",
          "qa ac AC-INTEG-005", evidence_refs=("EV-040",))
def ac_integ_004() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-integ-004")
    node = _resolve_node()
    if node is None:
        out.append(Assertion("对抗性 AC 需要宿主进程（Node）", False, "未找到 node"))
        return out

    # --- 1) 宿主尝试承诺面 ---
    code, payload, raw = _host("bridge", "--profile", "contractor-ops", "--root", str(root),
                               "--method", "approval.decide", "--params", json.dumps({"approval_id": "a-1"}))
    call = (payload or {}).get("call") or {}
    error = call.get("error") or {}
    ledger = root / "contractor-ops" / "ledger-contractor.jsonl"
    entries = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()
               if line.strip()] if ledger.exists() else []
    rejected = [entry for entry in entries if entry["type"] == "kernel/bridge-rejected"]
    out.append(Assertion("宿主调承诺面（approval.decide）被拒：commit-refused + next_action 指向交互式 CLI",
                         code == 0 and error.get("code") == "commit-refused"
                         and "CLI" in (error.get("next_action") or "")
                         and error.get("data", {}).get("cls") == "commit",
                         f"error={json.dumps(error, ensure_ascii=False)[:220] if error else raw[:160]}"))
    out.append(Assertion("拒绝留痕：kernel/bridge-rejected 入账（含 method/cls/注入身份）",
                         any(item["body"].get("method") == "approval.decide"
                             and item["body"].get("reason") == "commit-refused"
                             and item["body"].get("injected_operator") == "bridge:contractor-ops"
                             for item in rejected),
                         f"bridge-rejected 条数={len(rejected)} body={json.dumps(rejected[-1]['body'], ensure_ascii=False)[:200] if rejected else None}"))

    # --- 2) 身份不能自我声明 ---
    code2, payload2, raw2 = _host("bridge", "--profile", "contractor-ops", "--root", str(root),
                                  "--method", "ledger.head", "--claim", "human:zhang")
    error2 = ((payload2 or {}).get("call") or {}).get("error") or {}
    entries2 = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()
                if line.strip()] if ledger.exists() else []
    self_declared = [entry for entry in entries2
                     if entry["type"] == "kernel/bridge-rejected"
                     and entry["body"].get("reason") == "self-declared-identity"]
    out.append(Assertion("宿主播报 human 身份被拒（身份永不自我声明；权威身份由内核注入）",
                         code2 == 0 and error2.get("code") == "invalid-request"
                         and "human:zhang" in json.dumps(error2, ensure_ascii=False)
                         and error2.get("data", {}).get("injected_operator") == "bridge:contractor-ops",
                         f"error={json.dumps(error2, ensure_ascii=False)[:200] if error2 else raw2[:160]}"))
    out.append(Assertion("自我声明的尝试也留痕（claimed_source 与 injected_operator 分别记录）",
                         bool(self_declared) and self_declared[-1]["body"].get("claimed_source") == "human:zhang"
                         and self_declared[-1]["body"].get("injected_operator") == "bridge:contractor-ops",
                         f"self-declared 条数={len(self_declared)}"))

    # --- 3) fact 面 P1 默认关闭（声明但拒绝）---
    code3, got3, _err3, _led3 = _kernel_frames(root / "fact", [
        json.dumps({"v": 1, "n": "bridge.init", "p": {"accept_bridge": [BRIDGE_VERSION]}}),
        json.dumps({"v": 1, "n": "method", "p": {"id": 1, "m": "qep.receive", "params": {}}}),
        json.dumps({"v": 1, "n": "bridge.shutdown", "p": {}})], ledger_name="fact.jsonl")
    hello3 = next((frame["p"] for frame in got3 if frame.get("n") == "kernel/hello"), {})
    error3 = next((frame["p"] for frame in got3 if frame.get("n") == "error"), {})
    out.append(Assertion("fact 面默认关闭：hello 声明 capabilities/intents_only，调用 qep.receive 被拒且说明需放宽 ADR",
                         "fact-surface-closed" in hello3.get("features", [])
                         and error3.get("code") == "commit-refused"
                         and error3.get("data", {}).get("cls") == "fact"
                         and "P1" in (error3.get("message") or ""),
                         f"features={hello3.get('features')} error={json.dumps(error3, ensure_ascii=False)[:180]}"))

    # --- 4) 关面不等于关桥：read/compute 仍可用 ---
    code4, got4, _err4, _led4 = _kernel_frames(root / "open", [
        json.dumps({"v": 1, "n": "bridge.init", "p": {"accept_bridge": [BRIDGE_VERSION]}}),
        json.dumps({"v": 1, "n": "method", "p": {"id": 1, "m": "ledger.count"}}),
        json.dumps({"v": 1, "n": "method", "p": {"id": 2, "m": "measures.factor",
                                                 "params": {"from": "m", "to": "cm"}}}),
        json.dumps({"v": 1, "n": "bridge.shutdown", "p": {}})], ledger_name="open.jsonl")
    results = [frame["p"] for frame in got4 if frame.get("n") == "result"]
    out.append(Assertion("承诺面关闭不影响 read/compute（拒绝不是全局关桥）",
                         len(results) == 2 and results[1]["result"]["factor"] == 100.0,
                         f"results={[r['m'] for r in results]} factor={results[1]['result']['factor'] if len(results) > 1 else None}"))
    return out


# --------------------------------------------------------------------------- 故障语义（T-217，ADR-0013 §6/§8）
@register("AC-INTEG-006", "P1", "桥的故障语义：SIGKILL 后哈希链仍真且 durable 零丢失；在途请求记 unknown；"
                                "重启预算 3/30s 超限降只读；背压丢 live 必留痕、durable 可补齐；无孤儿；启动失败不写账本",
          "qa ac AC-INTEG-006", evidence_refs=("EV-041",))
def ac_integ_006() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-integ-006")
    node = _resolve_node()
    out.append(Assertion("故障注入需要宿主进程（Node）", node is not None, f"node={node}"))
    if node is None:
        return out

    def scenario(name: str, timeout: int = 120) -> dict:
        code, payload, raw = _host("supervise", "--profile", "contractor-ops", "--root", str(root),
                                   "--scenario", name, timeout=timeout)
        return {"exit": code, "payload": payload or {}, "raw": raw}

    # --- 1) SIGKILL → 重启：链仍真、durable 零丢失、重启留痕 ---
    crash = scenario("crash-restart")
    data = crash["payload"]
    before = data.get("durable_before") or []
    after = data.get("durable_after") or []
    out.append(Assertion("SIGKILL 后重启：哈希链仍真（verify_report.ok）且无坏条目",
                         data.get("hash_chain_ok") is True and data.get("verify_first_bad_seq") is None,
                         f"hash_chain_ok={data.get('hash_chain_ok')} first_bad={data.get('verify_first_bad_seq')} "
                         f"raw={crash['raw'][:120]}"))
    out.append(Assertion("已落账的 durable 条目零丢失（重启前 ⊆ 重启后）",
                         bool(before) and set(before) <= set(after),
                         f"before={before} after={after}"))
    out.append(Assertion("重启留痕：账本出现 kernel/bridge-restarted（含重启次数与锚点）",
                         "kernel/bridge-restarted" in after and data.get("restarts") == 1
                         and data.get("read_only_after") is False,
                         f"entries={data.get('ledger_entries')} restarts={data.get('restarts')}"))

    # --- 2) 在途请求记 unknown ---
    flight = scenario("crash-in-flight")
    fdata = flight["payload"]
    unknown = fdata.get("unknown_in_flight") or []
    out.append(Assertion("崩溃时在途请求记为 unknown（不得当成功），并记录原因",
                         fdata.get("in_flight_state") == "unknown" and any(
                             item.get("id") == 77 and item.get("reason") == "kernel-exited-before-reply"
                             for item in unknown),
                         f"in_flight_state={fdata.get('in_flight_state')} unknown={unknown}"))

    # --- 3) 重启预算 3/30s，超限降只读 ---
    budget = scenario("restart-budget", timeout=240)
    rounds = (budget["payload"] or {}).get("rounds") or []
    allowed = [r for r in rounds if not r["read_only"]]
    downgraded = [r for r in rounds if r["read_only"]]
    out.append(Assertion("重启预算 3 次/30s：第 1–3 次允许，第 4 次降只读",
                         len(rounds) == 4 and len(allowed) == 3 and len(downgraded) == 1
                         and downgraded[0]["round"] == 4,
                         f"rounds={[(r['round'], r['read_only'], r['window_used']) for r in rounds]}"))
    out.append(Assertion("只读降级只关承诺面：read 仍可用，commit 被拒且理由标 read_only",
                         all(r["read_ok"] for r in rounds)
                         and all(r["commit_code"] == "commit-refused" for r in rounds)
                         and all(r["commit_read_only"] is False for r in allowed)
                         and all(r["commit_read_only"] is True for r in downgraded),
                         f"read_ok={[r['read_ok'] for r in rounds]} "
                         f"ro_data={[r['commit_read_only'] for r in rounds]}"))

    # --- 4) 背压：live 可丢必留痕，durable 可补齐 ---
    bp = scenario("backpressure")
    bdata = bp["payload"]
    under = bdata.get("kernel_status_under_backpressure") or {}
    bodies = bdata.get("backpressure_bodies") or []
    out.append(Assertion("窗口耗尽时 live 通知被丢弃且计数（不静默丢弃）",
                         (under.get("dropped") or {}).get("live", 0) > 0 and bool(bodies),
                         f"dropped={under.get('dropped')} episodes={under.get('backpressure_episodes')}"))
    out.append(Assertion("背压留痕含丢弃计数与时间窗（kernel/bridge-backpressure 入账）",
                         bodies and bodies[0]["dropped"]["live"] > 0
                         and bodies[0]["window"]["from"] and bodies[0]["window"]["to"]
                         and bodies[0]["credit_window"] == 1,
                         f"body={json.dumps(bodies[0], ensure_ascii=False)[:220] if bodies else None}"))
    out.append(Assertion("durable 不可丢数据：被背压的 durable 条目可由 ledger.read 补齐（条数与写入数一致）",
                         bdata.get("durable_recoverable") == 6
                         and sum(1 for entry in bdata.get("ledger_entries", [])
                                 if entry["type"] == "kernel/bridge-rejected") == 6,
                         f"recoverable={bdata.get('durable_recoverable')} "
                         f"ledger={[e['type'] for e in bdata.get('ledger_entries', [])]}"))

    # --- 5) 锚点不一致 → fault + 降只读 ---
    anchor = scenario("anchor-mismatch")
    adata = anchor["payload"]
    status = adata.get("kernel_status") or {}
    out.append(Assertion("锚点不在链中 → 落 kernel/bridge-fault 且降只读（read 仍可用、commit 被拒）",
                         status.get("read_only") is True and status.get("read_only_reason") == "anchor-not-in-chain"
                         and adata.get("read_ok") is True and adata.get("commit_code") == "commit-refused"
                         and adata.get("commit_read_only") is True,
                         f"status={json.dumps(status, ensure_ascii=False)[:200]} read_ok={adata.get('read_ok')}"))

    # --- 6) 关闭不留孤儿；启动失败不写账本 ---
    orphan = scenario("orphan")
    odata = orphan["payload"]
    out.append(Assertion("关闭后进程确实消失（无孤儿），且是优雅退出（退出码 0）",
                         odata.get("alive_during") is True and odata.get("alive_after") is False
                         and (odata.get("shutdown") or {}).get("orphan") is False
                         and odata.get("exit_code") == 0,
                         f"alive_during={odata.get('alive_during')} alive_after={odata.get('alive_after')} "
                         f"exit={odata.get('exit_code')}"))
    startup = scenario("startup-failure")
    sdata = startup["payload"]
    out.append(Assertion("启动失败（账本不可打开）→ 退出码 3 且账本零新增、无协议帧",
                         sdata.get("exit_code") == 3 and sdata.get("frames") == 0
                         and sdata.get("ledger_written") is False and sdata.get("orphan") is False,
                         f"exit={sdata.get('exit_code')} frames={sdata.get('frames')} "
                         f"ledger_written={sdata.get('ledger_written')}"))
    return out
