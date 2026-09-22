#!/usr/bin/env python3
"""plugin-lifecycle 门（`tools/verify.sh plugin-lifecycle`）——「一切皆插件」的六动词 + 注入式 UI 注册面。

规则真源：`docs/design/27-plugin-architecture.md` §4（六动词）/§6（注入式 UI）；
契约：`src/system/runtime/docs/lifecycle-contract.md`、`src/domain/advice/docs/ui-block-contract.md`。

这个门断言什么（每条都是**真跑**，不是读代码猜）：
  A. 六动词真跑：`list/status/load/reload/unload/deps` 各自真执行一次；装载真 import 入口（`keys` 里必须
     出现**只有实体实现才有**的导出名）、重载真拿新实例（新 uid + 新 instance）、卸载后 effects 归零且可重复；
  B. 拒绝路径：未知插件（`unknown-plugin` + 候选）、非法层名（`illegal-layer`）、未知动词（`usage`）、
     依赖成环（`dependency-cycle` + 环上的 id）、清单不合法（`not-a-plugin`）；
  C. 注册面证明（真 HTTP）：两个样板插件各自注册的**只读区块**在真页面上真出现、
     `GET /api/ui/blocks` 只回执注册元数据、只读路由收到 POST ⇒ 405 + `Allow: GET`、
     两个页面 0 内联脚本、0 区块错误；
  D. **webui 不懂得它们是什么**：`host/modules/webui.mjs` 里 0 次出现两个样板插件的 id/标题；
     机制行（含 `uiSlots`/`slots.render` 的每一行）0 命中业务名词；`host/lib/ui-slot.mjs` 同样 0 命中；
  E. 机制层的拒绝语义（负控，直接驱动 `host/lib/ui-slot.mjs`）：非法 id / 未知槽位 / order 越界 / 空标题 /
     render 非函数 / 同槽位不同形状重复注册 / 内联脚本 ⇒ 各有名 code；render 抛错 ⇒ 该块不渲染但页面有名错误块；
  F. **4 处单点变异全红**：变异只写在临时副本里（产品树字节不变，门会前后比 sha256）；每处变异必须让
     **指定的**断言变红；找不到唯一锚点 = 假变异 = 判红。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SH = ROOT / "tools" / "plugin.sh"
CLI = ROOT / "src" / "system" / "runtime" / "tools" / "plugin-lifecycle.mjs"
REGISTRY = ROOT / "src" / "system" / "runtime" / "code" / "plugin-registry.mjs"
UI_SLOT = ROOT / "host" / "lib" / "ui-slot.mjs"
WEBUI = ROOT / "host" / "modules" / "webui.mjs"
RUN = ROOT / "run"
ADVICE = ROOT / "src" / "domain" / "advice" / "code" / "index.mjs"
HELLO = ROOT / "src" / "userspace" / "demo-ns" / "hello" / "code" / "index.mjs"
CORDIS = ROOT / "host" / "node_modules" / "cordis" / "lib" / "index.js"

ID_ADVICE = "domain/advice"
ID_HELLO = "userspace/demo-ns/hello"
TITLE_ADVICE = "决策建议（domain/advice 插件注册的只读区块）"
TITLE_HELLO = "用户空间插件区块（demo-ns.hello 注册的只读区块）"
ENGINE_NOTE = "本页建议由确定性规则从投影/快照派生，不含模型推测"
BUSINESS_NOUNS = ["决策建议", "比价", "授权", "时限", "变更", "报价", "中标", "澄清", "邮件", "留存",
                 "证据", "谈判", "市场", "供应商", "承包商", "回文"]

RESULTS: list[tuple[str, bool, str]] = []
CREATED_ROOTS: list[Path] = []      # 门自己造的夹具/变异根（收摊时停它们的运行时进程 + 清目录）
CREATED_DIRS: list[Path] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def node_bin() -> str:
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        return str(candidate)
    raise SystemExit("plugin-lifecycle 门：未找到 node")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_plugin(args: list[str], timeout: int = 180, env_extra: dict | None = None) -> tuple[int, str, str]:
    env = dict(os.environ)
    env.setdefault("QUOTAGENT_CORDIS", str(CORDIS))
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run([str(PLUGIN_SH), *args], cwd=str(ROOT), capture_output=True, text=True,
                          timeout=timeout, env=env)
    return proc.returncode, proc.stdout, proc.stderr


def json_line(text: str) -> dict:
    """取 stdout 的**最后一行** JSON（帧纪律：stdout 只有机器可读结果）。"""
    for line in reversed([item for item in text.splitlines() if item.strip()]):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {}


def runtime_stop() -> None:
    run_plugin(["--runtime", "stop"], timeout=60)


# ---------------------------------------------------------------------------------------------
# 夹具：环状依赖 + 坏清单（都在 tmp/ 下，绝不写产品树）
# ---------------------------------------------------------------------------------------------
def make_fixture_root() -> Path:
    """给"依赖成环"与"清单不合法"造一个独立根：`<fixture>/src/domain/{a,b,broken}/`。"""
    fixture = Path(tempfile.mkdtemp(prefix="pl-fixture-", dir=str(ROOT / "tmp")))
    CREATED_ROOTS.append(fixture)
    CREATED_DIRS.append(fixture)
    for name, dep in (("a", "domain/b"), ("b", "domain/a")):
        plugin = fixture / "src" / "domain" / name
        (plugin / "code").mkdir(parents=True, exist_ok=True)
        (plugin / "plugin.json").write_text(json.dumps({
            "name": name, "version": "1.0.0", "layer": "domain", "provides": [f"{name}Service"],
            "entry": "code/index.mjs", "description": f"夹具插件 {name}（只用于门）",
            "depends_on": [dep],
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (plugin / "code" / "index.mjs").write_text(
            "export const name = %r\nexport const inject = []\nexport const provides = [%r]\n"
            "export const Config = undefined\nexport const apply = (ctx) => { ctx.provide(%r, { ok: true }) }\n"
            % (name, f"{name}Service", f"{name}Service"), encoding="utf-8")
    broken = fixture / "src" / "domain" / "broken"
    (broken / "code").mkdir(parents=True, exist_ok=True)
    # 最少契约缺字段（缺 version/entry/description）+ entry 指向不存在的文件：必须被判非法
    (broken / "plugin.json").write_text(json.dumps({
        "name": "broken", "layer": "domain", "provides": ["brokenService"],
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    # 目录里没有 plugin.json 的目录：**不是插件**（不枚举、不假装）
    (fixture / "src" / "domain" / "not-a-plugin").mkdir(parents=True, exist_ok=True)
    return fixture


# ---------------------------------------------------------------------------------------------
# 真 HTTP（用 run up 起真服务，隔离端口与数据根）
# ---------------------------------------------------------------------------------------------
def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_get(url: str, timeout: float = 5.0) -> tuple[int, str, dict]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace"), dict(err.headers)


def http_post(url: str, payload: bytes = b"probe=1", timeout: float = 5.0) -> tuple[int, str, dict]:
    request = urllib.request.Request(url, data=payload, method="POST",
                                    headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace"), dict(err.headers)


def wait_health(port: int, prefix: str, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            code, _body, _headers = http_get(f"http://127.0.0.1:{port}{prefix}/api/health", timeout=3)
            if code == 200:
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def run_sh(script: Path, args: list[str], env_extra: dict | None = None, timeout: int = 240) -> tuple[int, str, str]:
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(["sh", str(script), *args], cwd=str(ROOT), capture_output=True, text=True,
                          timeout=timeout, env=env)
    return proc.returncode, proc.stdout, proc.stderr


# ---------------------------------------------------------------------------------------------
# 单点变异（只改临时副本；产品树字节必须不变）
# ---------------------------------------------------------------------------------------------
def apply_mutation(source: str, find: str, replace: str) -> str | None:
    """唯一锚点替换；找不到或多于一处的"变异"返回 None（= 假变异，调用方判红）。"""
    if source.count(find) != 1:
        return None
    return source.replace(find, replace, 1)


def stage_mutant_plugin_dir(tag: str) -> Path:
    """把 `src/system/runtime/` 整块复制到 tmp/，变异副本从那里跑（相对 import 仍然成立）。"""
    target = Path(tempfile.mkdtemp(prefix=f"pl-mutant-{tag}-", dir=str(ROOT / "tmp")))
    CREATED_DIRS.append(target)
    shutil.copytree(ROOT / "src" / "system" / "runtime", target / "runtime")
    shutil.copytree(ROOT / "src" / "domain" / "advice", target / "src-plugins" / "advice")
    return target


def make_mutant_root(tag: str) -> Path:
    """变异跑在**独立根**上：把三个样板插件复制进去（这样它的 socket/pid 不与主根冲突）。

    `host/` 用**符号链接**指回真实宿主目录：样板插件的 wrapper 是相对 path 指向 `host/modules/*.mjs`
    的（阶段 1 的形态），夹具根里必须有同一个相对位置；链接而不是复制，避免把 node_modules 拷一遍。
    """
    root = Path(tempfile.mkdtemp(prefix=f"pl-root-{tag}-", dir=str(ROOT / "tmp")))
    CREATED_ROOTS.append(root)
    CREATED_DIRS.append(root)
    (root / "src" / "system").mkdir(parents=True, exist_ok=True)
    (root / "src" / "domain").mkdir(parents=True, exist_ok=True)
    (root / "src" / "userspace" / "demo-ns").mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "src" / "system" / "runtime", root / "src" / "system" / "runtime")
    shutil.copytree(ROOT / "src" / "domain" / "advice", root / "src" / "domain" / "advice")
    shutil.copytree(ROOT / "src" / "userspace" / "demo-ns" / "hello",
                    root / "src" / "userspace" / "demo-ns" / "hello")
    os.symlink(ROOT / "host", root / "host")
    return root


def run_mutant_cli(script: Path, root: Path, args: list[str], timeout: int = 180) -> tuple[int, dict, str]:
    env = dict(os.environ)
    env.setdefault("QUOTAGENT_CORDIS", str(CORDIS))
    proc = subprocess.run([node_bin(), str(script), "--root", str(root), *args], cwd=str(root),
                          capture_output=True, text=True, timeout=timeout, env=env)
    return proc.returncode, json_line(proc.stdout), proc.stderr


# ---------------------------------------------------------------------------------------------
# A/B：六动词真跑 + 拒绝路径
# ---------------------------------------------------------------------------------------------
def lifecycle_probe() -> dict:
    """把"六动词真跑"的结果收集成一个 dict（正控分支与变异分支共用同一套探针）。"""
    facts: dict = {}
    runtime_stop()
    code, out, _err = run_plugin(["list", "--json", "--root", str(ROOT)])
    listing = json_line(out)
    facts["list_rc"] = code
    facts["list"] = listing
    ids = {item.get("id"): item for item in listing.get("plugins", [])}
    facts["ids"] = sorted(ids)

    code, out, _err = run_plugin(["status", ID_ADVICE, "--root", str(ROOT)])
    status_before = json_line(out)
    facts["status_before"] = status_before

    code, out, _err = run_plugin(["load", ID_ADVICE, "--root", str(ROOT)])
    loaded = json_line(out)
    facts["load"] = loaded
    code, out, _err = run_plugin(["status", ID_ADVICE, "--root", str(ROOT)])
    facts["status_after_load"] = json_line(out)

    code, out, _err = run_plugin(["load", ID_ADVICE, "--root", str(ROOT)])
    facts["load_again"] = json_line(out)

    code, out, _err = run_plugin(["reload", ID_ADVICE, "--root", str(ROOT)])
    facts["reload"] = json_line(out)

    code, out, _err = run_plugin(["unload", ID_ADVICE, "--root", str(ROOT)])
    facts["unload"] = json_line(out)
    code, out, _err = run_plugin(["status", ID_ADVICE, "--root", str(ROOT)])
    facts["status_after_unload"] = json_line(out)
    code, out, _err = run_plugin(["unload", ID_ADVICE, "--root", str(ROOT)])
    facts["unload_again"] = json_line(out)
    code, out, _err = run_plugin(["load", ID_ADVICE, "--root", str(ROOT)])
    facts["load_third"] = json_line(out)

    code, out, _err = run_plugin(["load", ID_HELLO, "--root", str(ROOT)])
    facts["hello_load"] = json_line(out)
    code, out, _err = run_plugin(["status", ID_HELLO, "--root", str(ROOT)])
    facts["hello_status"] = json_line(out)
    code, out, _err = run_plugin(["unload", ID_HELLO, "--root", str(ROOT)])
    facts["hello_unload"] = json_line(out)

    code, out, _err = run_plugin(["load", "system/runtime", "--root", str(ROOT)])
    facts["runtime_load"] = json_line(out)
    code, out, _err = run_plugin(["unload", "system/runtime", "--root", str(ROOT)])
    facts["runtime_unload"] = json_line(out)

    code, out, _err = run_plugin(["deps", ID_ADVICE, "--root", str(ROOT)])
    facts["deps"] = json_line(out)
    code, out, _err = run_plugin(["status", "domain/nope", "--root", str(ROOT)])
    facts["unknown_rc"] = code
    facts["unknown"] = json_line(out)
    code, out, _err = run_plugin(["load", "foo/bar", "--root", str(ROOT)])
    facts["illegal_layer_rc"] = code
    facts["illegal_layer"] = json_line(out)
    code, out, _err = run_plugin(["list", "--layer", "nope", "--root", str(ROOT)])
    facts["layer_filter_rc"] = code
    facts["layer_filter"] = json_line(out)
    code, out, _err = run_plugin(["frobnicate", ID_ADVICE, "--root", str(ROOT)])
    facts["unknown_verb_rc"] = code
    facts["unknown_verb"] = json_line(out)
    runtime_stop()
    return facts


def assert_lifecycle(facts: dict) -> None:
    listing = facts.get("list", {})
    ids = facts.get("ids", [])
    check("A1 `list --json` 枚举三层插件（真扫 src/{system,domain}/ 与 src/userspace/<ns>/）",
          facts.get("list_rc") == 0 and listing.get("ok") is True
          and set([ID_ADVICE, ID_HELLO, "system/runtime"]).issubset(set(ids))
          and listing.get("count") == len(ids),
          f"rc={facts.get('list_rc')} count={listing.get('count')} ids={ids}")
    plugins = {item.get("id"): item for item in listing.get("plugins", [])}
    advice = plugins.get(ID_ADVICE, {})
    check("A2 每项给 id/layer/version/provides/entry/description/status（清单是唯一登记真源）",
          advice.get("layer") == "domain" and advice.get("version") == "1.0.0"
          and advice.get("provides") == ["advicePanel"] and advice.get("entry") == "code/index.mjs"
          and isinstance(advice.get("description"), str) and advice.get("description") != ""
          and advice.get("status") == "not-loaded",
          f"advice={json.dumps({k: advice.get(k) for k in ('layer','version','provides','entry','status')}, ensure_ascii=False)}")
    check("A3 目录里没有 plugin.json 的目录**不是插件**（不枚举、不假装）",
          "not-a-plugin" not in " ".join(ids),
          f"ids={ids}")

    check("A4 `load domain/advice` 真装载：真 import 入口（keys 里出现只有实体实现才有的导出名）",
          facts.get("load", {}).get("ok") is True
          and {"adviseOf", "ENGINE_NOTE", "RULES"}.issubset(set(facts.get("load", {}).get("keys", [])))
          and facts.get("load", {}).get("fiber_state") == "ACTIVE"
          and (facts.get("load", {}).get("effects", {}).get("count") or 0) > 0,
          f"uid={facts.get('load', {}).get('uid')} state={facts.get('load', {}).get('fiber_state')} "
          f"effects={facts.get('load', {}).get('effects')} keys={facts.get('load', {}).get('keys')}")
    first_uid = facts.get("load", {}).get("uid")
    check("A5 `status` 回读装载事实（loaded + 同一个 uid + effects 来自内核实测）",
          facts.get("status_after_load", {}).get("status") == "loaded"
          and facts.get("status_after_load", {}).get("uid") == first_uid,
          f"status={facts.get('status_after_load', {}).get('status')} uid={facts.get('status_after_load', {}).get('uid')} "
          f"load_uid={first_uid}")
    check("A6 重复 `load` ⇒ `already-loaded`（幂等路径，不是静默成功）",
          facts.get("load_again", {}).get("ok") is False
          and facts.get("load_again", {}).get("code") == "already-loaded",
          f"code={facts.get('load_again', {}).get('code')}")
    reloaded = facts.get("reload", {})
    check("A7 `reload` = 先卸后装 ⇒ **新实例（新 uid + 新 instance）**，不迁移任何内存状态",
          reloaded.get("ok") is True and reloaded.get("uid") not in (None, first_uid)
          and reloaded.get("from_uid") == first_uid
          and reloaded.get("instance") != facts.get("load", {}).get("instance"),
          f"from_uid={reloaded.get('from_uid')} uid={reloaded.get('uid')} code={reloaded.get('code')} "
          f"instance={reloaded.get('instance')} vs 旧 {facts.get('load', {}).get('instance')}")
    unloaded = facts.get("unload", {})
    check("A8 `unload` 真移除：`dispose()` 后**回读** effects 归零（不留残订阅/定时器）",
          unloaded.get("ok") is True and unloaded.get("zero_effects") is True
          and unloaded.get("effects_after") == 0 and (unloaded.get("effects_before") or 0) > 0,
          f"effects_before={unloaded.get('effects_before')} effects_after={unloaded.get('effects_after')}")
    check("A9 卸载后 `status` 如实报 not-loaded；再次 `unload` ⇒ `not-loaded`（动作可重复）",
          facts.get("status_after_unload", {}).get("status") == "not-loaded"
          and facts.get("unload_again", {}).get("ok") is False
          and facts.get("unload_again", {}).get("code") == "not-loaded",
          f"status={facts.get('status_after_unload', {}).get('status')} "
          f"again={facts.get('unload_again', {}).get('code')}")
    check("A10 卸载后可以再 `load`，且拿到**又一个新实例**（可重复装载 ⇒ 可重复卸载）",
          facts.get("load_third", {}).get("ok") is True
          and facts.get("load_third", {}).get("uid") not in (None, first_uid, reloaded.get("uid")),
          f"uid={facts.get('load_third', {}).get('uid')}（曾见 {first_uid}, {reloaded.get('uid')}）")

    hello_load = facts.get("hello_load", {})
    check("A11 用户空间插件同一条接口（`userspace/demo-ns/hello`：命名空间服务 + 区块声明）",
          hello_load.get("ok") is True and hello_load.get("layer") == "userspace"
          and set(["NAMESPACE", "BLOCK"]).issubset(set(hello_load.get("keys", [])))
          and hello_load.get("provides") == ["bucket", "status"]
          and facts.get("hello_unload", {}).get("zero_effects") is True,
          f"uid={hello_load.get('uid')} provides={hello_load.get('provides')} keys={hello_load.get('keys')}")
    check("A12 `system/runtime` 自己也走同一条接口（`provides=[pluginLifecycle]`）",
          facts.get("runtime_load", {}).get("ok") is True
          and facts.get("runtime_load", {}).get("provides") == ["pluginLifecycle"]
          and facts.get("runtime_unload", {}).get("zero_effects") is True,
          f"uid={facts.get('runtime_load', {}).get('uid')}")

    deps = facts.get("deps", {})
    check("A13 `deps` 给依赖闭包：`depends_on` + `inject`（服务键 → 提供者）；未迁移的目标如实记 missing",
          deps.get("ok") is True and deps.get("direct") == ["system/webui"]
          and deps.get("missing_targets") == ["system/webui"]
          and deps.get("cycle") is None,
          f"direct={deps.get('direct')} missing={deps.get('missing_targets')} unresolved={deps.get('unresolved_services')}")
    check("A14 依赖未就绪 ⇒ **非激活**（不是崩）：`deps_ready=false` 且语义有名字（`depends_on` 指向未迁移的 webui）",
          facts.get("status_before", {}).get("deps_ready") is False
          and facts.get("status_before", {}).get("deps_missing") == ["system/webui"],
          f"deps_ready={facts.get('status_before', {}).get('deps_ready')} "
          f"deps_missing={facts.get('status_before', {}).get('deps_missing')}")

    check("B1 未知插件 ⇒ `unknown-plugin` + 候选列表（rc=1）",
          facts.get("unknown_rc") == 1 and facts.get("unknown", {}).get("code") == "unknown-plugin"
          and facts.get("unknown", {}).get("candidates"),
          f"rc={facts.get('unknown_rc')} code={facts.get('unknown', {}).get('code')} "
          f"candidates={facts.get('unknown', {}).get('candidates')}")
    check("B2 非法层名 ⇒ `illegal-layer`（rc=1；`foo/bar` 这种形状不接受）",
          facts.get("illegal_layer_rc") == 1 and facts.get("illegal_layer", {}).get("code") == "illegal-layer",
          f"rc={facts.get('illegal_layer_rc')} code={facts.get('illegal_layer', {}).get('code')}")
    check("B3 `list --layer <非法>` ⇒ `illegal-layer`（rc=1；过滤参数也要拒绝）",
          facts.get("layer_filter_rc") == 1 and facts.get("layer_filter", {}).get("code") == "illegal-layer",
          f"rc={facts.get('layer_filter_rc')} code={facts.get('layer_filter', {}).get('code')}")
    check("B4 未知动词 ⇒ `usage`（rc=2：用法/环境错误，不当成『通过』）",
          facts.get("unknown_verb_rc") == 2 and facts.get("unknown_verb", {}).get("code") == "usage",
          f"rc={facts.get('unknown_verb_rc')} code={facts.get('unknown_verb', {}).get('code')}")


def assert_fixture_refusals(fixture: Path) -> None:
    env = {"QUOTAGENT_CORDIS": str(CORDIS)}
    code, out, _err = run_plugin(["deps", "domain/a", "--root", str(fixture)], env_extra=env)
    payload = json_line(out)
    check("B5 依赖成环 ⇒ `dependency-cycle` + **环上的 id**（不是笼统『有环』）",
          code == 1 and payload.get("code") == "dependency-cycle"
          and set(payload.get("cycle") or []) >= {"domain/a", "domain/b"},
          f"rc={code} cycle={payload.get('cycle')}")
    code, out, _err = run_plugin(["list", "--json", "--root", str(fixture)], env_extra=env)
    listing = json_line(out)
    degraded = {item.get("id"): item.get("reason") for item in listing.get("degraded", [])}
    check("B6 清单不合法 ⇒ 进 `degraded` 并给**有名 reason**（缺字段 / 入口不存在）",
          degraded.get("domain/broken") == "manifest-missing-fields",
          f"degraded={degraded}")
    code, out, _err = run_plugin(["load", "domain/broken", "--root", str(fixture)], env_extra=env)
    payload = json_line(out)
    check("B7 装载不合法清单 ⇒ `not-a-plugin`（rc=1；坏清单不许装进来）",
          code == 1 and payload.get("code") == "not-a-plugin",
          f"rc={code} code={payload.get('code')}")


# ---------------------------------------------------------------------------------------------
# C/D/E：注册面（真 HTTP + 静态扫描 + 机制负控）
# ---------------------------------------------------------------------------------------------
def assert_registration(port: int, prefix: str) -> None:
    base = f"http://127.0.0.1:{port}{prefix}"
    code, body, _headers = http_get(f"{base}/api/ui/blocks")
    blocks_payload = {}
    try:
        blocks_payload = json.loads(body)
    except json.JSONDecodeError:
        pass
    blocks = blocks_payload.get("blocks", [])
    by_plugin = {item.get("plugin_id"): item for item in blocks}
    check("C1 `GET /api/ui/blocks` 真返回两个样板插件的注册元数据（只回执元数据，不含正文）",
          code == 200 and blocks_payload.get("count") == 2
          and by_plugin.get(ID_ADVICE, {}).get("slot") == "page.contractor"
          and by_plugin.get(ID_ADVICE, {}).get("order") == 20
          and by_plugin.get(ID_ADVICE, {}).get("title") == TITLE_ADVICE
          and by_plugin.get(ID_HELLO, {}).get("slot") == "page.supplier"
          and by_plugin.get(ID_HELLO, {}).get("order") == 30
          and "html" not in json.dumps(blocks_payload),
          f"count={blocks_payload.get('count')} blocks={json.dumps(blocks, ensure_ascii=False)[:300]}")

    contractor_code, contractor, _ = http_get(f"{base}/contractor/")
    supplier_code, supplier, _ = http_get(f"{base}/supplier/")
    check("C2 承包商页面上**真出现** domain/advice 注册的只读区块（原始行见门输出）",
          contractor_code == 200 and f'data-ui-block="{ID_ADVICE}"' in contractor
          and f'data-ui-block-slot="page.contractor"' in contractor
          and TITLE_ADVICE in contractor and ENGINE_NOTE in contractor
          and "data-ui-block-error" not in contractor,
          "原始行: " + (re.findall(r'data-ui-block="[^"]*"[^>]*', contractor) or ["(无)"])[0][:160])
    check("C3 供应商页面上**真出现** userspace/demo-ns/hello 注册的只读区块",
          supplier_code == 200 and f'data-ui-block="{ID_HELLO}"' in supplier
          and 'data-ui-block-slot="page.supplier"' in supplier and TITLE_HELLO in supplier
          and "demo-ns.hello" in supplier and "data-ui-block-error" not in supplier,
          "原始行: " + (re.findall(r'data-ui-block="[^"]*"[^>]*', supplier) or ["(无)"])[0][:160])
    check("C4 两个页面仍然 **0 行 `<script>`、0 个内联事件属性**（SSR 契约不因注入面而松动）",
          "<script" not in contractor and "<script" not in supplier
          and not re.search(r"\son[a-z]+\s*=", contractor) and not re.search(r"\son[a-z]+\s*=", supplier),
          f"contractor_bytes={len(contractor)} supplier_bytes={len(supplier)}")

    post_code, post_body, post_headers = http_post(f"{base}/api/ui/blocks")
    check("C5 注册面自述是**只读**路由：POST ⇒ 405 + `method-not-allowed` + `Allow: GET`",
          post_code == 405 and "method-not-allowed" in post_body
          and str(post_headers.get("allow") or post_headers.get("Allow") or "").upper() == "GET",
          f"POST→{post_code} allow={post_headers.get('allow') or post_headers.get('Allow')}")
    routes_code, routes_body, _ = http_get(f"{base}/api/routes")
    route_rows = []
    try:
        route_rows = json.loads(routes_body).get("routes", [])
    except json.JSONDecodeError:
        pass
    registered = [row for row in route_rows if str(row.get("path", "")).endswith("/api/ui/blocks")]
    check("C6 新路由**在路由表里登记了**（`/api/routes` 里 method=GET），没登记的接口抓得到",
          routes_code == 200 and len(registered) == 1 and registered[0].get("method") == "GET",
          f"routes 命中={len(registered)} {registered}")


def assert_webui_knows_nothing() -> None:
    webui = WEBUI.read_text(encoding="utf-8")
    slot = UI_SLOT.read_text(encoding="utf-8")
    needles = [ID_ADVICE, ID_HELLO, "demo-ns.hello", TITLE_ADVICE, TITLE_HELLO]
    hits = [needle for needle in needles if needle in webui]
    check("D1 `host/modules/webui.mjs` 里 **0 次**出现两个样板插件的 id/标题（webui 不知道它们是什么）",
          not hits, f"命中={hits}（webui.mjs 不含这些字符串）")
    mechanism_lines = [line for line in webui.splitlines()
                       if "uiSlots" in line or "slotsHtmlOf" in line or "ui_slots" in line]
    noun_hits = [f"{line.strip()[:60]}" for line in mechanism_lines
                 if any(noun in line for noun in BUSINESS_NOUNS)]
    check("D2 注入面**机制行**逐行扫业务名词 ⇒ 0 命中（机制不懂业务）",
          bool(mechanism_lines) and not noun_hits,
          f"机制行 {len(mechanism_lines)} 行；业务名词命中={noun_hits}")
    slot_hits = [needle for needle in needles if needle in slot] + \
        [noun for noun in BUSINESS_NOUNS if noun in slot]
    check("D3 机制实现 `host/lib/ui-slot.mjs` 自身也 0 命中插件 id/标题/业务名词",
          not slot_hits, f"命中={slot_hits}")


def assert_mechanism_refusals() -> None:
    """直接驱动机制层（不经 HTTP）：每条拒绝路径都必须有**有名 code**。"""
    script = """
import { createSlotRegistry } from '%s'
const registry = createSlotRegistry()
const base = { plugin_id: 'domain/advice', slot: 'page.contractor', order: 10, title: 'T', render: () => ({ ok: true, html: '<p>x</p>' }) }
const facts = {}
facts.ok = registry.register(base)
facts.illegal_id = registry.register({ ...base, plugin_id: 'foo/bar', slot: 'page.supplier' })
facts.illegal_id_layer = registry.register({ ...base, plugin_id: 'nope/thing', slot: 'page.supplier' })
facts.unknown_slot = registry.register({ ...base, plugin_id: 'domain/x', slot: 'page.nowhere' })
facts.bad_order = registry.register({ ...base, plugin_id: 'domain/y', order: 99999 })
facts.bad_title = registry.register({ ...base, plugin_id: 'domain/z', title: '   ' })
facts.bad_render = registry.register({ ...base, plugin_id: 'domain/w', render: 'nope' })
facts.dup_idempotent = registry.register(base)
facts.dup_conflict = registry.register({ ...base, order: 99 })
facts.count_after = registry.size()
const scripty = createSlotRegistry()
scripty.register({ plugin_id: 'domain/inline', slot: 'page.ops', order: 1, title: 'S', render: () => ({ ok: true, html: '<script>alert(1)</script>' }) })
facts.inline = scripty.render('page.ops')
const boom = createSlotRegistry()
boom.register({ plugin_id: 'domain/boom', slot: 'page.ops', order: 1, title: 'B', render: () => { throw new Error('boom') } })
facts.throw = boom.render('page.ops')
facts.describe = registry.describe()
console.log(JSON.stringify(facts))
""" % (str(UI_SLOT),)
    proc = subprocess.run([node_bin(), "--input-type=module", "-e", script], cwd=str(ROOT),
                          capture_output=True, text=True, timeout=120)
    facts = {}
    for line in reversed([item for item in proc.stdout.splitlines() if item.strip()]):
        try:
            facts = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    if not facts:
        check("E0 机制层可被直接驱动（负控前置）", False, f"stderr={proc.stderr[-200:]}")
        return
    codes = {key: facts.get(key, {}).get("code") for key in
             ("illegal_id", "illegal_id_layer", "unknown_slot", "bad_order", "bad_title", "bad_render")}
    check("E1 非法 id / 非法层 / 未知槽位 / order 越界 / 空标题 / render 非函数 ⇒ 各有名 code",
          codes == {"illegal_id": "illegal-plugin-id", "illegal_id_layer": "illegal-plugin-id",
                    "unknown_slot": "unknown-slot", "bad_order": "invalid-order",
                    "bad_title": "invalid-title", "bad_render": "invalid-render"},
          f"codes={codes}")
    check("E2 同一 `(slot, plugin_id)` 完全相同 ⇒ 幂等；形状不同 ⇒ `duplicate-registration`（不许悄悄覆盖）",
          facts.get("ok", {}).get("code") == "registered"
          and facts.get("dup_idempotent", {}).get("code") == "already-registered"
          and facts.get("dup_conflict", {}).get("code") == "duplicate-registration"
          and facts.get("count_after") == 1,
          f"once={facts.get('ok', {}).get('code')} again={facts.get('dup_idempotent', {}).get('code')} "
          f"conflict={facts.get('dup_conflict', {}).get('code')} size={facts.get('count_after')}")
    check("E3 带 `<script>` 的区块 HTML **被拒收**（页面 0 内联脚本由机制结构性保证）",
          "inline-script-refused" in json.dumps(facts.get("inline", {})),
          f"render={json.dumps(facts.get('inline', {}), ensure_ascii=False)[:200]}")
    check("E4 `render` 抛错 ⇒ 该块**不渲染**，但页面出有名错误块（不静默吞、也不编替代块）",
          facts.get("throw", {}).get("blocks") == 0
          and (facts.get("throw", {}).get("errors") or [{}])[0].get("code") == "block-render-failed"
          and 'data-ui-block-error="domain/boom"' in facts.get("throw", {}).get("html", ""),
          f"blocks={facts.get('throw', {}).get('blocks')} errors={json.dumps(facts.get('throw', {}).get('errors'), ensure_ascii=False)[:160]}")

    # E5：真插件入口 + 假注册面提供者 ⇒ 装载即注册、**卸载即反注册**（零残留：不留指向已死实例的区块）
    probe = """
import { Context, EventsService } from '%s'
import { createSlotRegistry } from '%s'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const mod = await import('%s')
const ctx = new Context()
await ctx.plugin(EventsService)
const registry = createSlotRegistry()
const fiber = await ctx.plugin({ name: 'domain/advice', inject: [], provides: mod.provides,
  Config: mod.Config, apply: mod.apply }, mod.Config.parse({}))
const before = registry.size()
const uiFiber = ctx.inject([], (scope) => { scope.provide('uiSlots', registry) })
await uiFiber
await sleep(300)
const afterProvide = registry.size()
const rendered = registry.render('page.contractor').html
await fiber.dispose()
await sleep(300)
console.log(JSON.stringify({ before, afterProvide, afterDispose: registry.size(),
  blocked: registry.describe().blocks.length,
  renderOk: rendered.includes('engine=rules') && rendered.includes('data-ui-block-error') === false }))
""" % (CORDIS, UI_SLOT, ADVICE)
    proc = subprocess.run([node_bin(), "--input-type=module", "-e", probe], cwd=str(ROOT),
                          capture_output=True, text=True, timeout=120)
    facts5 = {}
    for line in reversed([item for item in proc.stdout.splitlines() if item.strip()]):
        try:
            facts5 = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    check("E5 真插件入口：装载即注册（1 块）、**卸载即反注册**（0 块，零残留）、区块内容来自实体实现",
          facts5.get("before") == 0 and facts5.get("afterProvide") == 1
          and facts5.get("afterDispose") == 0 and facts5.get("blocked") == 0
          and facts5.get("renderOk") is True,
          f"facts={facts5} stderr={proc.stderr[-160:] if proc.stderr else ''}")


# ---------------------------------------------------------------------------------------------
# F：4 处单点变异（只改临时副本；产品树字节不变）
# ---------------------------------------------------------------------------------------------
MUTATIONS = [
    {"name": "变异1：load 不把插件记入位（去掉装载登记）",
     "find": "    loaded.set(plugin.id, { handle: mounted, record: { uid: mounted.uid, instance, entry: plugin.manifest.entry } })",
     "replace": "    void instance",
     "sequence": [["load", "domain/advice"], ["status", "domain/advice"]],
     "must_red": lambda payload: payload.get("status") != "loaded"},
    {"name": "变异2：unload 不真移除（去掉装载表的删除）",
     "find": "      const verdict = await unmount(entry.handle)\n      loaded.delete(plugin.id)",
     "replace": "      const verdict = await unmount(entry.handle)",
     "sequence": [["load", "domain/advice"], ["unload", "domain/advice"], ["unload", "domain/advice"]],
     "must_red": lambda payload: payload.get("code") != "not-loaded"},
    {"name": "变异3：重载复用同一个实例号（instance 恒为 #1）",
     "find": "    state.seq.set(id, (state.seq.get(id) ?? 0) + 1)\n    return `${id}#${state.seq.get(id)}`",
     "replace": "    state.seq.set(id, 1)\n    return `${id}#1`",
     "sequence": [["load", "domain/advice"], ["reload", "domain/advice"]],
     "must_red": lambda payload: payload.get("instance") == "domain/advice#1"},
    {"name": "变异4：`list --layer` 不再拒绝非法层名",
     "find": "    if (args.layer !== null && !LAYERS.includes(args.layer)) {",
     "replace": "    if (false) {",
     "sequence": [["list", "--layer", "nope", "--json"]],
     "must_red": lambda payload: payload.get("code") != "illegal-layer"},
]


def run_mutant_sequence(cli_path: Path, root: Path, sequence: list[list[str]]) -> tuple[dict, bool, int]:
    """按序列真跑一遍，返回（最后一个动词的载荷, 载荷是否有效, 最后一个 rc）。"""
    run_mutant_cli(cli_path, root, ["--runtime", "stop"])
    payload: dict = {}
    rc = 0
    for verb in sequence:
        rc, payload, _err = run_mutant_cli(cli_path, root, list(verb))
    run_mutant_cli(cli_path, root, ["--runtime", "stop"])
    legible = isinstance(payload, dict) and "ok" in payload
    return payload, legible, rc


def assert_mutations() -> None:
    original_cli = CLI.read_text(encoding="utf-8")
    cli_sha_before = sha256(CLI)
    baselines_ok = True
    baseline_notes = []
    for index, mutation in enumerate(MUTATIONS, start=1):
        # ① 基线（未变异）跑同一序列：**必须不是红的**，否则"变异变红"说明不了任何事
        base_root = make_mutant_root(f"b{index}")
        staged_base = stage_mutant_plugin_dir(f"b{index}")
        payload, legible, rc = run_mutant_sequence(staged_base / "runtime" / "tools" / "plugin-lifecycle.mjs",
                                                  base_root, mutation["sequence"])
        base_red = bool(mutation["must_red"](payload)) if legible else True
        baseline_notes.append(f"#{index} 基线红={base_red}")
        if base_red:
            baselines_ok = False
        # ② 变异体：同一序列必须**变红**
        mutated = apply_mutation(original_cli, mutation["find"], mutation["replace"])
        if mutated is None or mutated == original_cli:
            check(f"F{index} 变异：{mutation['name']}", False,
                  f"假变异：锚点唯一性={mutated is not None} 字节已变={mutated != original_cli}")
            continue
        staged = stage_mutant_plugin_dir(f"m{index}")
        mutant_cli = staged / "runtime" / "tools" / "plugin-lifecycle.mjs"
        mutant_cli.write_text(mutated, encoding="utf-8")
        mutant_root = make_mutant_root(f"m{index}")
        payload, legible, rc = run_mutant_sequence(mutant_cli, mutant_root, mutation["sequence"])
        red = bool(mutation["must_red"](payload)) if legible else False
        check(f"F{index} 变异：{mutation['name']}（必须让指定断言变红）", red,
              f"变异体 rc={rc} 有效载荷={legible} payload={json.dumps(payload, ensure_ascii=False)[:200]}")
    check("F0 基线（未变异）在同一序列上**不红**（否则四条变异变红都是空转）",
          baselines_ok, "；".join(baseline_notes))
    fake = apply_mutation(original_cli, "这一段源码里根本不存在-MUTATION-ANCHOR", "x")
    check("F5 防假变异：不存在的锚点必须返回 None（否则『变异变红』说明不了任何事）", fake is None, f"fake={fake!r}")
    check("F6 全过程**产品树字节不变**（变异只写在临时副本里）",
          sha256(CLI) == cli_sha_before,
          f"before={cli_sha_before[:12]} after={sha256(CLI)[:12]}")


# ---------------------------------------------------------------------------------------------
def main() -> int:
    port = free_port()
    up_rc, up_out, up_err = run_sh(RUN, ["up", "--port", str(port), "--data-dir",
                                         f"tmp/plugin-lifecycle-gate/shared", "--no-seed"])
    healthy = wait_health(port, "/quotagent")
    fixture = make_fixture_root()
    try:
        assert_registration(port, "/quotagent")
    finally:
        run_sh(RUN, ["down", "--port", str(port)])

    facts = lifecycle_probe()
    assert_lifecycle(facts)
    assert_fixture_refusals(fixture)
    assert_webui_knows_nothing()
    assert_mechanism_refusals()
    assert_mutations()
    # 收摊：门自己造的每个根都要**停掉它的运行时进程**再清目录（否则门会留下常驻进程；
    # 实测踩到过：夹具根的运行时没人停，三次跑留了三个 daemon）。
    stopped = 0
    for root in CREATED_ROOTS:
        rc, _out, _err = run_plugin(["--runtime", "stop", "--root", str(root)], timeout=60)
        stopped += 1 if rc == 0 else 0
    check("C0b 门自己造的夹具/变异根：运行时进程逐个停掉并清目录（门不留常驻进程）",
          stopped == len(CREATED_ROOTS),
          f"根 {len(CREATED_ROOTS)} 个，停掉 {stopped} 个")
    for path in CREATED_DIRS:
        shutil.rmtree(path, ignore_errors=True)
    check("C0 真 HTTP 前置：`./run up` 起得来（否则 C1–C6 是空转）",
          up_rc == 0 and healthy,
          f"up_rc={up_rc} healthy={healthy} out={up_out.strip()[:160]} err={up_err.strip()[-160:]}")

    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in RESULTS:
        print(f"{'[ok]  ' if ok else '[FAIL]'} {name}")
        if detail:
            print(f"        {detail}")
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（plugin-lifecycle 门 {len(RESULTS) - len(failed)}/{len(RESULTS)}）")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
