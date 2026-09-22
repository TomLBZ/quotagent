#!/usr/bin/env python3
"""plugin-lifecycle 门（`tools/verify.sh plugin-lifecycle`）——「一切皆插件」的六动词 + 注入式 UI 注册面。

规则真源：`docs/design/27-plugin-architecture.md` §4（六动词）/§6（注入式 UI）；
契约：`src/system/runtime/docs/lifecycle-contract.md`、`src/domain/advice/docs/ui-block-contract.md`。

这个门断言什么（每条都是**真跑**，不是读代码猜）：
  A. 六动词真跑：`list/status/load/reload/unload/deps` 各自真执行一次；装载真 import 入口（`keys` 里必须
     出现**只有实体实现才有**的导出名）、重载真拿新实例（新 uid + 新 instance）、卸载后 effects 归零且可重复；
     **A3/A15/A16/A17 = 「目录存在 ≠ 插件存在」的收紧**（真跑夹具，逐条给原始行）：没有 `plugin.json` 的目录
     不算插件（不枚举、不计数）、清单**不合法**的目录也不算「依赖已就绪」（一律进 `missing`）、合法清单的
     目录正常识别为就绪；F5 变异把这一条改回去必须变红。
  B. 拒绝路径：未知插件（`unknown-plugin` + 候选）、非法层名（`illegal-layer`）、未知动词（`usage`）、
     依赖成环（`dependency-cycle` + 环上的 id）、清单不合法（`not-a-plugin`）；
  C. 注册面证明（真 HTTP）：两个样板插件各自注册的**只读区块**在真页面上真出现、
     `GET /api/ui/blocks` 只回执注册元数据、只读路由收到 POST ⇒ 405 + `Allow: GET`、
     两个页面 0 内联脚本、0 区块错误；
  D. **webui 不懂得它们是什么**：`host/modules/webui.mjs` 里 0 次出现两个样板插件的 id/标题；
     机制行（含 `uiSlots`/`slots.render` 的每一行）0 命中业务名词；`host/lib/ui-slot.mjs` 同样 0 命中；
  E. 机制层的拒绝语义（负控，直接驱动 `host/lib/ui-slot.mjs`）：非法 id / 未知槽位 / order 越界 / 空标题 /
     render 非函数 / 同槽位不同形状重复注册 / 内联脚本 ⇒ 各有名 code；render 抛错 ⇒ 该块不渲染但页面有名错误块；
  F. **6 处单点变异全红**（F1–F6；变异 5/6 锚在 `code/plugin-registry.mjs` 的两处收紧点，本批新增）：
     变异只写在临时副本里（产品树字节不变，门会前后比 sha256）；每处变异必须让**指定的**断言变红；
     找不到唯一锚点 = 假变异 = 判红。收尾两条：F7 防假变异 / F8 产品树字节不变（因新增变异 5/6，号后移）。

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
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PLUGIN_SH = ROOT / "tools" / "plugin.sh"
CLI = ROOT / "src" / "system" / "runtime" / "tools" / "plugin-lifecycle.mjs"
REGISTRY = ROOT / "src" / "system" / "runtime" / "code" / "plugin-registry.mjs"
UI_SLOT = ROOT / "src" / "system" / "webui" / "code" / "ui-slot.mjs"   # 实体（EV-177 搬进 system/webui/code/；旧路径 host/lib/ui-slot.mjs 只剩薄重导）
WEBUI = ROOT / "src" / "system" / "webui" / "code" / "webui.mjs"   # 实体（本批 EV-178 搬进本插件 `code/`；旧路径 `host/modules/webui.mjs` 只剩薄重导）
RUN = ROOT / "run"
ADVICE = ROOT / "src" / "domain" / "advice" / "code" / "index.mjs"
HELLO = ROOT / "src" / "userspace" / "demo-ns" / "hello" / "code" / "index.mjs"
CORDIS = ROOT / "host" / "node_modules" / "cordis" / "lib" / "index.js"

ID_ADVICE = "domain/advice"
ID_HELLO = "userspace/demo-ns/hello"
BADGE = "userspace/demo-ns/badge"          # 运行期装卸的取证对象（不在任何启动装配里）
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
    # 「目录存在 ≠ 插件存在」的三组对照（A15/A16/A17 用；都在夹具根里，产品树一个字不动）：
    #   ① bare-dep → bare-target：目标**只有裸目录**（无 plugin.json）⇒ 必须如实记 missing；
    #   ② invalid-dep → invalid-target：目标有 plugin.json 但**不合法**（缺必填字段）⇒ 同样记 missing；
    #   ③ real-dep → real-target：目标是**合法清单**的真插件 ⇒ 正常识别为已就绪（正向对照）。
    def fixture_plugin(name: str, depends_on: list[str]) -> Path:
        plugin = fixture / "src" / "domain" / name
        (plugin / "code").mkdir(parents=True, exist_ok=True)
        (plugin / "plugin.json").write_text(json.dumps({
            "name": name, "version": "1.0.0", "layer": "domain", "provides": [f"{name}Service"],
            "entry": "code/index.mjs", "description": f"夹具插件 {name}（只用于门）",
            "depends_on": depends_on,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (plugin / "code" / "index.mjs").write_text(
            "export const name = %r\nexport const inject = []\nexport const provides = [%r]\n"
            "export const Config = undefined\nexport const apply = (ctx) => { ctx.provide(%r, { ok: true }) }\n"
            % (name, f"{name}Service", f"{name}Service"), encoding="utf-8")
        return plugin

    fixture_plugin("bare-dep", ["domain/bare-target"])
    (fixture / "src" / "domain" / "bare-target").mkdir(parents=True, exist_ok=True)   # 裸目录（无清单）
    fixture_plugin("invalid-dep", ["domain/invalid-target"])
    invalid_target = fixture / "src" / "domain" / "invalid-target"
    invalid_target.mkdir(parents=True, exist_ok=True)
    (invalid_target / "plugin.json").write_text(json.dumps({"name": "invalid-target"}, ensure_ascii=False) + "\n",
                                                encoding="utf-8")
    fixture_plugin("real-dep", ["domain/real-target"])
    fixture_plugin("real-target", [])
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


# ---------------------------------------------------------------------------------------------
# 身份会话（P3：`/contractor/**`、`/supplier/**` 有了**路由级身份门槛**）——
# 本门**先登录再取业务路由**：判据从「谁能打开」变成「**登录后按侧放行**」。
# 登录走**真入口** `POST /identity/login`（`format=json` ⇒ 200 + `Set-Cookie: qa_identity=…`）；
# 会话落在**本门 `./run up --data-dir`** 的数据根里（**不碰**真 `/workspace/config.yaml` 与真服务数据）。
# 纪律：断言**一条不删、一条不放松** —— 页面区块的存在性判据照旧，只是带上本侧 cookie。
# ---------------------------------------------------------------------------------------------
COOKIES: dict[tuple[str, str], str] = {}     # (base, side) → 'qa_identity=…'


def header_of(headers: dict, name: str) -> str:
    """大小写无关地取响应头（`dict(response.headers)` 保留服务端发出时的大小写）。"""
    for key, value in headers.items():
        if str(key).lower() == name.lower():
            return str(value)
    return ""


def side_of(url: str) -> str:
    """这条 URL 属于哪一侧的业务路由（`/contractor/**` / `/supplier/**`）；其它路径 ⇒ 空串（不带身份）。"""
    hit = re.search(r"/(contractor|supplier)(?:/|$)", urllib.parse.urlsplit(url).path)
    return hit.group(1) if hit else ""


def cookie_of(base: str, url: str) -> dict:
    """业务路由要带的 cookie（`base` = 本次在测服务的 `http://127.0.0.1:<port><prefix>`）。"""
    side = side_of(url)
    if not side:
        return {}
    key = (base, side)
    if key not in COOKIES:
        payload = urllib.parse.urlencode({"name": f"gate-plugin-lifecycle-{side}", "side": side}).encode("utf-8")
        code, body, headers = http_post(f"{base}/identity/login?format=json", payload, timeout=8)
        cookie = header_of(headers, "set-cookie").split(";")[0]
        if code != 200 or not cookie.startswith("qa_identity="):
            raise RuntimeError(f"门夹具登录失败：side={side} status={code} body={body[:200]}")
        COOKIES[key] = cookie
    return {"Cookie": COOKIES[key]}


def http_get_page(base: str, path: str, timeout: float = 5.0) -> tuple[int, str, dict]:
    """取**业务路由**：先按侧登录（P3 门槛）再带 cookie 取（判据不放宽：仍要求 200 + 区块真出现）。"""
    return http_get_with(f"{base}{path}", cookie_of(base, f"{base}{path}"), timeout)


def login_as(base: str, side: str) -> dict:
    """**显式**按某侧登录（越侧负控要的就是「另一侧的 cookie」——不能从 URL 推侧）。"""
    return cookie_of(base, f"{base}/{side}/")


def http_get_with(url: str, headers: dict, timeout: float = 5.0,
                  follow_redirects: bool = True) -> tuple[int, str, dict]:
    request = urllib.request.Request(url, method="GET", headers=headers or {})
    try:
        opener = urllib.request.urlopen if follow_redirects else _NO_REDIRECT_OPENER.open
        with opener(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace"), dict(err.headers)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """**不跟** 303：身份门槛的「浏览器形状」判据就是那一次 303 本身（跟过去会变成 200 登录页）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


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


def make_mutant_root(tag: str, bare_dirs: tuple = (), invalid_dirs: tuple = ()) -> Path:
    """变异跑在**独立根**上：把三个样板插件复制进去（这样它的 socket/pid 不与主根冲突）。

    `host/` 用**符号链接**指回真实宿主目录：样板插件的 wrapper 是相对 path 指向 `host/modules/*.mjs`
    的（阶段 1 的形态），夹具根里必须有同一个相对位置；链接而不是复制，避免把 node_modules 拷一遍。

    `bare_dirs`：额外造出**只有目录、没有 `plugin.json`** 的假插件目录；`invalid_dirs`：额外造出
    **有 `plugin.json` 但最小契约不合法**（只有 `name`）的目录 —— 两者都只用于变异的反向对照，
    真实仓库里不许有这种东西（只在 tmp/ 的夹具根里出现）。
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
    for rel in bare_dirs:
        (root / rel).mkdir(parents=True, exist_ok=True)
    for rel in invalid_dirs:
        (root / rel).mkdir(parents=True, exist_ok=True)
        (root / rel / "plugin.json").write_text(
            json.dumps({"name": Path(rel).name}, ensure_ascii=False) + "\n", encoding="utf-8")
    os.symlink(ROOT / "host", root / "host")
    return root


def run_mutant_cli(script: Path, root: Path, args: list[str], timeout: int = 180) -> tuple[int, dict, str]:
    env = dict(os.environ)
    env.setdefault("QUOTAGENT_CORDIS", str(CORDIS))
    proc = subprocess.run([node_bin(), str(script), "--root", str(root), *args], cwd=str(root),
                          capture_output=True, text=True, timeout=timeout, env=env)
    return proc.returncode, json_line(proc.stdout), proc.stderr


def make_anchor_root(tag: str) -> Path:
    """A13b/A14b 的**对照根**：真 `domain/advice`（整块拷贝）+ 真 `system/webui` 的**合法形状清单**，
    但**不放入口文件**（`entry` 指的文件不存在 ⇒ `artifact-missing`）。

    为什么要新增这一条（而不是复用 A15/A16）：那两条的假目标分别是「只有裸目录、没有 `plugin.json`」
    与「有清单但缺必填字段」；这里补的是**第三种**形态 —— 清单字段齐备、`name`/`layer` 都对，只有
    `entry` 指的文件不在（= `system/webui` 在接上入口之前的真实形态）。三者都不许被当成「依赖已就绪」。
    用**真实 id 与真实清单字节**（`shutil.copyfile`），不是合成的 `domain/xxx` 夹具名。
    """
    root = make_mutant_root(tag)
    target = root / "src" / "system" / "webui"
    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "src" / "system" / "webui" / "plugin.json", target / "plugin.json")
    if (target / "code" / "index.mjs").exists():          # 对照必须真的是「入口缺失」，否则本断言空转
        raise AssertionError("对照根里 webui 的入口不该存在：" + str(target))
    return root


def anchor_facts(tag: str, verbs: tuple) -> dict:
    """在对照根上真跑一遍动词序列，返回 `{verb: (rc, payload)}`（自足：自己 stage CLI、自己收尾）。"""
    staged = stage_mutant_plugin_dir(tag)
    root = make_anchor_root(tag)
    cli = staged / "runtime" / "tools" / "plugin-lifecycle.mjs"
    out = {}
    for verb in verbs:
        rc, payload, _err = run_mutant_cli(cli, root, list(verb))
        out[verb[0]] = (rc, payload)
    return out


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
    check("A3 真根扫描里**没有**「只有目录、没有 plugin.json」的项（`not_plugins` 为空；夹具上的反向对照见 A3c）",
          listing.get("not_plugins") == [] and "not-a-plugin" not in " ".join(ids),
          f"not_plugins={listing.get('not_plugins')} ids={ids}")

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
    check("A13 `deps` 给依赖闭包：`depends_on` + `inject`（服务键 → 提供者）；依赖目标已接入口 ⇒ 闭包含它、"
          "`missing_targets` 为空（真根的正控；「未就绪仍如实记 missing」的负控见 A13b）",
          deps.get("ok") is True and deps.get("direct") == ["system/webui"]
          and deps.get("closure") == ["system/webui"]
          and deps.get("order") == ["domain/advice", "system/webui"]
          and deps.get("missing_targets") == []
          and deps.get("cycle") is None,
          f"direct={deps.get('direct')} closure={deps.get('closure')} order={deps.get('order')} "
          f"missing={deps.get('missing_targets')} unresolved={deps.get('unresolved_services')}")

    # A13b/A14b：**「依赖未就绪」的负控搬到对照根上**（`system/webui` 的合法形状清单在、入口文件不在）。
    # 为什么必须搬：`system/webui` 接上入口之后，"真根上存在一个未迁移的依赖目标"这个**事实**就没了；
    # 但"目标清单不合法/入口不存在 ⇒ 不算依赖已就绪、且不许崩"这条**判据**必须继续被真跑证明 ——
    # 所以在对照根上用**真实 id 与真实清单字节**重造该形态（比依赖真根当时的偶然状态更强：它是构造出来的，
    # 不会因为仓库演进再变绿）。A15/A16 覆盖另外两种目标形态（裸目录 / 清单缺字段）。
    anchor = anchor_facts("a13b", (["deps", "domain/advice", "--json"], ["status", "domain/advice", "--json"],
                                   ["list", "--json"]))
    rc_deps, payload = anchor["deps"]
    check("A13b **负控（对照根）**：依赖目标目录与**合法形状清单**都在、只有入口文件不存在（`artifact-missing`）"
          "⇒ 仍不算依赖已就绪：`missing_targets` 如实给出 `system/webui`、闭包与拓扑序里不含它，且 `ok:true`（不是崩）",
          rc_deps == 0 and payload.get("ok") is True
          and payload.get("missing_targets") == ["system/webui"]
          and payload.get("closure") == [] and payload.get("order") == ["domain/advice"]
          and payload.get("direct") == ["system/webui"],
          f"原始行: rc={rc_deps} direct={payload.get('direct')} closure={payload.get('closure')} "
          f"order={payload.get('order')} missing_targets={payload.get('missing_targets')}")

    check("A14 依赖已就绪 ⇒ **可激活**：真根上 `deps_ready=true` 且 `deps_missing` 为空（状态语义仍有名字）",
          facts.get("status_before", {}).get("deps_ready") is True
          and facts.get("status_before", {}).get("deps_missing") == []
          and facts.get("status_before", {}).get("deps_direct") == ["system/webui"],
          f"deps_ready={facts.get('status_before', {}).get('deps_ready')} "
          f"deps_missing={facts.get('status_before', {}).get('deps_missing')} "
          f"deps_direct={facts.get('status_before', {}).get('deps_direct')}")

    rc_status, status = anchor["status"]
    _rc_list, listing_anchor = anchor["list"]
    anchor_webui = {item.get("id"): item for item in listing_anchor.get("plugins", [])}.get("system/webui", {})
    check("A14b **负控（对照根）**：同一个未就绪目标下 `status` **非激活但不崩**：`deps_ready=false` + "
          "`deps_missing=[\"system/webui\"]` + `ok:true`，且未就绪的**原因是有名的**（`valid:false` + "
          "`reason='artifact-missing'`，不是静默）",
          rc_status == 0 and status.get("ok") is True
          and status.get("deps_ready") is False
          and status.get("deps_missing") == ["system/webui"]
          and status.get("deps_direct") == ["system/webui"]
          and status.get("status") == "not-loaded" and status.get("cycle") is None
          and anchor_webui.get("valid") is False and anchor_webui.get("reason") == "artifact-missing",
          f"原始行: rc={rc_status} deps_ready={status.get('deps_ready')} "
          f"deps_missing={status.get('deps_missing')} status={status.get('status')} "
          f"webui valid={anchor_webui.get('valid')} reason={anchor_webui.get('reason')}")

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
    code, out, _err = run_plugin(["list", "--json", "--root", str(fixture)], env_extra=env)
    listing = json_line(out)
    fixture_ids = [item.get("id") for item in listing.get("plugins", [])]
    not_plugins = [item.get("id") for item in listing.get("not_plugins", [])]
    degraded = {item.get("id"): item.get("reason") for item in listing.get("degraded", [])}
    check("A3c 夹具的**裸目录**（`src/domain/not-a-plugin/`，无 `plugin.json`）**不是插件**：不进 `list`、不计数，"
          "但在 `not_plugins` 里如实报一行（收紧：目录存在 ≠ 插件存在）",
          "domain/not-a-plugin" not in fixture_ids
          and "domain/not-a-plugin" in {item.get("id") for item in listing.get("not_plugins", [])}
          and listing.get("count") == len(fixture_ids),
          f"原始行: count={listing.get('count')} not_plugins={json.dumps(listing.get('not_plugins'), ensure_ascii=False)} "
          f"ids={fixture_ids}")
    check("B6 清单不合法 ⇒ 进 `degraded` 并给**有名 reason**（缺字段 / 入口不存在）",
          degraded.get("domain/broken") == "manifest-missing-fields",
          f"degraded={degraded}")
    code, out, _err = run_plugin(["load", "domain/broken", "--root", str(fixture)], env_extra=env)
    payload = json_line(out)
    check("B7 装载不合法清单 ⇒ `not-a-plugin`（rc=1；坏清单不许装进来）",
          code == 1 and payload.get("code") == "not-a-plugin",
          f"rc={code} code={payload.get('code')}")

    # --- 「目录存在 ≠ 插件存在」的三组对照（**这是本批的收紧**，逐条贴原始行）-------------------------
    def deps_of(pid: str) -> tuple[int, dict]:
        rc, text, _e = run_plugin(["deps", pid, "--root", str(fixture)], env_extra=env)
        return rc, json_line(text)

    rc, payload = deps_of("domain/bare-dep")
    check("A15 依赖目标**只有裸目录**（`src/domain/bare-target/` 无 `plugin.json`）⇒ 不算存在："
          "`missing_targets` 如实给出该 id（收紧前这里会变成 `[]`，正是已登记的那个坑）",
          rc == 0 and payload.get("missing_targets") == ["domain/bare-target"]
          and payload.get("closure") == [],
          f"原始行: rc={rc} missing_targets={payload.get('missing_targets')} closure={payload.get('closure')}")
    rc, payload = deps_of("domain/invalid-dep")
    check("A16 依赖目标有 `plugin.json` 但**不合法**（缺必填字段）⇒ 同样不算存在（只认**合法**清单，不是「有文件就算」）",
          rc == 0 and payload.get("missing_targets") == ["domain/invalid-target"]
          and payload.get("closure") == [],
          f"原始行: rc={rc} missing_targets={payload.get('missing_targets')} closure={payload.get('closure')}")
    rc, payload = deps_of("domain/real-dep")
    check("A17 **正向对照**：目标是合法清单的真插件目录 ⇒ 正常识别为已就绪（`missing_targets` 空、闭包含该 id）",
          rc == 0 and payload.get("missing_targets") == [] and payload.get("closure") == ["domain/real-target"],
          f"原始行: rc={rc} missing_targets={payload.get('missing_targets')} closure={payload.get('closure')}")

    code, out, _err = run_plugin(["deps", "domain/not-a-plugin", "--root", str(fixture)], env_extra=env)
    payload = json_line(out)
    check("A18 直接问一个裸目录的依赖闭包 ⇒ `unknown-plugin`（rc=1，**不存在**；候选里给同层插件）",
          code == 1 and payload.get("code") == "unknown-plugin" and payload.get("candidates"),
          f"原始行: rc={code} code={payload.get('code')} candidates={payload.get('candidates')}")

    code, out, _err = run_plugin(["deps", "domain/a", "--root", str(fixture)], env_extra=env)
    payload = json_line(out)
    check("B5 依赖成环 ⇒ `dependency-cycle` + **环上的 id**（不是笼统『有环』）",
          code == 1 and payload.get("code") == "dependency-cycle"
          and set(payload.get("cycle") or []) >= {"domain/a", "domain/b"},
          f"rc={code} cycle={payload.get('cycle')}")


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

    contractor_code, contractor, _ = http_get_page(base, "/contractor/")
    supplier_code, supplier, _ = http_get_page(base, "/supplier/")
    # C7（P3）：身份门槛本身也要机检 —— 未登录拒（两种形状）/ 登录后按侧放行 / 越侧 403。
    # 没有这一条，C2/C3「页面上真出现区块」在门槛被误删时照样绿（门就白修了）。
    anon_json_code, anon_json_body, _ = http_get_with(f"{base}/contractor/api/events",
                                                      {"Accept": "application/json"})
    anon_html_code, _anon_html_body, anon_html_headers = http_get_with(
        f"{base}/supplier/", {"Accept": "text/html"}, follow_redirects=False)
    cross_side = http_get_with(f"{base}/supplier/", login_as(base, "contractor"))
    cross_side_code, cross_side_body = cross_side[0], cross_side[1]
    same_as_supplier = http_get_page(base, "/supplier/")
    check("C7 身份门槛（P3）：**未登录**取业务路由一律拒 —— API/JSON ⇒ 401 `identity-required` + `next`；"
          "浏览器（`Accept: text/html`）⇒ 303 回 `<前缀>/identity/?next=<原地址>`；"
          "**登录后按侧放行**（本侧 200）、**越侧 403 `side-mismatch`**（不回落成「能看」）",
          anon_json_code == 401 and "identity-required" in anon_json_body and '"next"' in anon_json_body
          and anon_html_code == 303 and "/identity/?next=" in header_of(anon_html_headers, "location")
          and same_as_supplier[0] == 200
          and cross_side_code == 403 and "side-mismatch" in cross_side_body,
          f"未登录 JSON={anon_json_code} HTML={anon_html_code} "
          f"location={header_of(anon_html_headers, 'location')[:60]}；本侧={same_as_supplier[0]}；"
          f"越侧（承包商 cookie 取 /supplier/）={cross_side_code} 含 side-mismatch="
          f"{'side-mismatch' in cross_side_body}")
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


def assert_live_lifecycle() -> None:
    """L：**运行中服务的运行期装卸**（长驻 WebUI 进程里真 load/reload/unload；页面区块真出现/真消失）。

    这一段的判据就是 `docs/work/plans/plugin-migration-plan.md` §5.3 那条一直没落地的断言：
    「卸载一个业务插件后其路由消失、**页面其余部分逐字节不变**」。
    """
    node = node_bin()
    live = ROOT / "src" / "system" / "runtime" / "code" / "live-control.mjs"

    # L1 机制层负控（纯函数，直接驱动；快且确定性）：围栅四道 + 回执码映射
    script = """
import { fence, statusFor, resolveToken, lockedLayer, MUTATING, VERBS } from '%s'
const facts = {}
facts.no_token = fence({ headers: {}, body: { verb: 'load', id: 'userspace/demo-ns/badge' }, token: '' })
facts.no_header = fence({ headers: {}, body: { verb: 'load', id: 'userspace/demo-ns/badge' }, token: 'T' })
facts.bad_token = fence({ headers: { 'x-plugin-control-token': 'X' }, body: { verb: 'load', id: 'userspace/demo-ns/badge' }, token: 'T' })
facts.no_confirm = fence({ headers: { 'x-plugin-control-token': 'T' }, body: { verb: 'load', id: 'userspace/demo-ns/badge' }, token: 'T' })
facts.ok = fence({ headers: { 'x-plugin-control-token': 'T' }, body: { verb: 'load', id: 'userspace/demo-ns/badge', confirm: true }, token: 'T' })
facts.bad_verb = fence({ headers: { 'x-plugin-control-token': 'T' }, body: { verb: 'frobnicate', id: 'x', confirm: true }, token: 'T' })
facts.status_codes = [statusFor('plugin-control-disabled'), statusFor('plugin-control-unauthorized'),
  statusFor('layer-locked'), statusFor('confirmation-required'), statusFor('unknown-verb'), statusFor('unknown-plugin')]
facts.locked = [lockedLayer('system/runtime'), lockedLayer('domain/advice'), lockedLayer('userspace/demo-ns/badge')]
facts.mutating = MUTATING
facts.resolve_absent = resolveToken({ env: {}, root: '/nonexistent-root' })
facts.verbs = VERBS
console.log(JSON.stringify(facts))
""" % (str(live),)
    proc = subprocess.run([node, "--input-type=module", "-e", script], cwd=str(ROOT), capture_output=True,
                          text=True, timeout=120)
    facts = json_line(proc.stdout)
    check("L1 围栅（机制层，纯函数直驱）：**没配令牌 = 整条通道关闭**（fail-closed）、缺头/错令牌各有名拒、"
          "改名动作缺 `confirm` ⇒ `confirmation-required`、未知动词 ⇒ `unknown-verb`",
          facts.get("no_token", {}).get("code") == "plugin-control-disabled"
          and facts.get("no_header", {}).get("code") == "plugin-control-unauthorized"
          and facts.get("bad_token", {}).get("code") == "plugin-control-unauthorized"
          and facts.get("no_confirm", {}).get("code") == "confirmation-required"
          and facts.get("bad_verb", {}).get("code") == "unknown-verb"
          and facts.get("ok", {}).get("ok") is True,
          f"no_token={facts.get('no_token', {}).get('code')} 缺头={facts.get('no_header', {}).get('code')} "
          f"错令牌={facts.get('bad_token', {}).get('code')} 缺确认={facts.get('no_confirm', {}).get('code')} "
          f"未知动词={facts.get('bad_verb', {}).get('code')}")
    check("L2 回执码映射与层锁：通道关闭 503 / 未授权与层锁 403 / 冲突 409 / 未知名 400 / 未知插件 404；"
          "只有 `system/*` 被锁（domain/userspace 可装卸）；令牌来源缺失时如实报 `absent`（不猜默认值）",
          facts.get("status_codes") == [503, 403, 403, 409, 400, 404]
          and facts.get("locked") == ["system", None, None]
          and facts.get("mutating") == ["load", "reload", "unload"]
          and facts.get("resolve_absent", {}).get("token") == ""
          and facts.get("resolve_absent", {}).get("source") == "absent",
          f"codes={facts.get('status_codes')} locked={facts.get('locked')} "
          f"token_source={facts.get('resolve_absent', {}).get('source')}")

    # L3+ 真 HTTP / 真页面 / 真命令：起一个**带控制令牌**的服务
    token = "pl-live-gate-token"
    port = free_port()
    data_dir = f"tmp/plugin-lifecycle-gate/live-{port}"
    env_live = {"QUOTAGENT_PLUGIN_CONTROL_TOKEN": token}
    shutdown_live = lambda: run_sh(RUN, ["down", "--port", str(port)])
    shutdown_live()
    up_rc, up_out, up_err = run_sh(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"], env_live)
    healthy = wait_health(port, "/quotagent")
    try:
        check("L3 运行中服务起得来且控制通道在（`./run up` + 令牌；通道只看令牌，不看调用者是谁）",
              up_rc == 0 and healthy, f"up_rc={up_rc} healthy={healthy} err={up_err.strip()[-160:]}")
        if not (up_rc == 0 and healthy):
            return
        prefix = "/quotagent"
        base = f"http://127.0.0.1:{port}{prefix}"
        control = f"{base}/api/plugins/control"
        # **先登录**（P3：业务路由有身份门槛）——必须在下面 `tree_before`/`ledger_before` 快照**之前**：
        # 会话文件是宿主按设计写的服务端状态（`<data-dir>/identity/`），登录要算进快照基线，
        # 这样 L13「数据根逐字节不变」判据保持**原样**（不改成「容忍一个文件」）。
        login_as(base, "contractor")
        login_as(base, "supplier")
        supplier_page = f"{base}/supplier/"
        tree_before = tree_digest(ROOT / "src") + tree_digest(ROOT / "host")
        ledger_before = tree_digest(ROOT / data_dir)

        # L4 控制路由**登记在路由表里**（动态路由由注册面登记，不是藏在 webui 里的私货）
        code, body, _ = http_get(f"{base}/api/routes")
        rows = []
        try:
            rows = json.loads(body).get("routes", [])
        except json.JSONDecodeError:
            pass
        control_rows = [row for row in rows if row.get("path") == f"{prefix}/api/plugins/control"]
        check("L4 控制通道**登记在 `/api/routes`**（method=POST、auth=control-token、source=uiRoutes）",
              code == 200 and len(control_rows) == 1 and control_rows[0].get("method") == "POST"
              and control_rows[0].get("auth") == "control-token" and control_rows[0].get("source") == "uiRoutes",
              f"命中={control_rows}")

        # L5 围栅在**真 HTTP** 上也成立（缺令牌 / 缺确认 / 层锁 / 未知插件）
        s1, b1 = http_post_json(control, {"verb": "load", "id": BADGE, "confirm": True})
        s2, b2 = http_post_json(control, {"verb": "load", "id": BADGE}, {"x-plugin-control-token": token})
        s3, b3 = http_post_json(control, {"verb": "load", "id": "system/runtime", "confirm": True},
                                {"x-plugin-control-token": token})
        s4, b4 = http_post_json(control, {"verb": "load", "id": "domain/nope", "confirm": True},
                                {"x-plugin-control-token": token})
        check("L5 真 HTTP 围栅：缺令牌 403 `plugin-control-unauthorized` / 缺确认 409 `confirmation-required` / "
              "system 层 403 `layer-locked` / 未知插件 404 `unknown-plugin`（逐条有名 code + next_action，"
              "且**都没改装配**）",
              s1 == 403 and b1.get("code") == "plugin-control-unauthorized"
              and s2 == 409 and b2.get("code") == "confirmation-required"
              and s3 == 403 and b3.get("code") == "layer-locked"
              and s4 == 404 and b4.get("code") == "unknown-plugin"
              and all(isinstance(item.get("next_action"), str) and item.get("next_action") for item in (b1, b2, b3, b4)),
              f"{s1}/{b1.get('code')} {s2}/{b2.get('code')} {s3}/{b3.get('code')} {s4}/{b4.get('code')}")

        # L6 客户端围栅：**客户端**在没有令牌时也要就地拒绝（不假装成功、不去猜默认值）
        client_env = dict(os.environ)
        client_env.pop("QUOTAGENT_PLUGIN_CONTROL_TOKEN", None)
        client_env["QUOTAGENT_PLUGIN_CONTROL_TOKEN_FILE"] = str(ROOT / "tmp" / "no-such-token-file")
        rc_cli, out_cli, _err = run_sh(PLUGIN_SH, ["status", BADGE, "--live", "--port", str(port)],
                                       client_env)
        cli_payload = json_line(out_cli)
        check("L6 客户端围栅：没有令牌时 `tools/plugin.sh <动词> --live` 就地拒（`plugin-control-disabled` + "
              "next_action；退出码非 0）",
              rc_cli != 0 and cli_payload.get("code") == "plugin-control-disabled"
              and cli_payload.get("next_action"),
              f"rc={rc_cli} code={cli_payload.get('code')} next_action={str(cli_payload.get('next_action'))[:80]}")

        # L7 装载前：页面上**没有** badge 的区块；/api/ui/blocks 只有 2 条（启动期静态装配的那两个）
        page_before_code, page_before, _ = http_get_page(base, "/supplier/")
        sha_before = hashlib.sha256(page_before.encode("utf-8")).hexdigest()
        blocks_before = ui_blocks(base)
        status_before = live_verb(PLUGIN_SH, ["status", BADGE, "--port", str(port)], token)[1]
        check("L7 装载前：badge 未装载（`status --live` loaded=false）、页面上没有它的区块、注册面只有 2 条",
              page_before_code == 200 and BADGE not in page_before
              and len(blocks_before) == 2 and status_before.get("loaded") is False,
              f"http={page_before_code} blocks={len(blocks_before)} status_loaded={status_before.get('loaded')} "
              f"sha={sha_before[:16]}")

        # L8 **装载**：真命令 → 真装载 → 区块**真出现在页面上**
        rc_load, load_payload = live_verb(PLUGIN_SH, ["load", BADGE, "--port", str(port)], token)
        page_after_code, page_after, _ = http_get_page(base, "/supplier/")
        sha_after = hashlib.sha256(page_after.encode("utf-8")).hexdigest()
        blocks_after = ui_blocks(base)
        badge_block = [item for item in blocks_after if item.get("plugin_id") == BADGE]
        check("L8 `tools/plugin.sh load … --live` 真装载进**运行中的服务**：uid/effects 可回读，"
              "且它注册的只读区块**真出现在页面上**（`data-ui-block=…`）",
              rc_load == 0 and load_payload.get("ok") is True and load_payload.get("uid")
              and (load_payload.get("effects") or 0) > 0
              and load_payload.get("control") == "live"
              and f'data-ui-block="{BADGE}"' in page_after
              and len(badge_block) == 1 and badge_block[0].get("slot") == "page.supplier"
              and len(blocks_after) == 3,
              f"rc={rc_load} uid={load_payload.get('uid')} effects={load_payload.get('effects')} "
              f"区块元数据={badge_block} 页面块数={len(blocks_after)} "
              f"原始行={(re.findall(r'data-ui-block=\"' + re.escape(BADGE) + r'\"[^>]*', page_after) or ['(无)'])[0][:120]}")

        # L9 **页面其余部分逐字节不变**：把 badge 那段 `<section>` 摘掉后必须与装载前**逐字节相同**
        stripped = re.sub(r'\n<section data-ui-block="' + re.escape(BADGE) + r'".*?</section>', "", page_after,
                          flags=re.S)
        sha_stripped = hashlib.sha256(stripped.encode("utf-8")).hexdigest()
        check("L9 装载只**增加**那一块：摘掉 badge 的 `<section>` 后与装载前的页面**逐字节相同**（sha256 相等）",
              sha_stripped == sha_before,
              f"装载前 sha256={sha_before} 装载后去块 sha256={sha_stripped} | 页面 {len(page_before)} → "
              f"{len(page_after)} 字节")

        # L10 **重载不得泄漏 effects**：新 uid（新实例）、卸载前 effects 计数可查、卸载后归零
        rc_reload, reload_payload = live_verb(PLUGIN_SH, ["reload", BADGE, "--port", str(port)], token)
        rc_status, status_payload = live_verb(PLUGIN_SH, ["status", BADGE, "--port", str(port)], token)
        check("L10 `reload --live` 真热重载：新 uid（≠ 装载时的 uid）+ 新 instance，回读 uid/effects 可查，"
              "且**重载前后 effects 计数不涨**（不泄漏）",
              rc_reload == 0 and reload_payload.get("ok") is True
              and reload_payload.get("uid") not in (None, load_payload.get("uid"))
              and reload_payload.get("from_uid") == load_payload.get("uid")
              and reload_payload.get("from_effects") == load_payload.get("effects")
              and reload_payload.get("effects") == load_payload.get("effects")
              and status_payload.get("uid") == reload_payload.get("uid")
              and status_payload.get("effects") == reload_payload.get("effects"),
              f"load_uid={load_payload.get('uid')} reload_uid={reload_payload.get('uid')} "
              f"from_effects={reload_payload.get('from_effects')} effects={reload_payload.get('effects')} "
              f"status_uid={status_payload.get('uid')} status_effects={status_payload.get('effects')}")

        # L11 **卸载**：区块消失 + 页面逐字节还原 + effects 归零 + 可重复
        rc_unload, unload_payload = live_verb(PLUGIN_SH, ["unload", BADGE, "--port", str(port)], token)
        page_final_code, page_final, _ = http_get_page(base, "/supplier/")
        sha_final = hashlib.sha256(page_final.encode("utf-8")).hexdigest()
        blocks_final = ui_blocks(base)
        rc_unload2, unload_again = live_verb(PLUGIN_SH, ["unload", BADGE, "--port", str(port)], token)
        check("L11 `unload --live` 真移除：区块从页面消失、`/api/ui/blocks` 回到 2 条、`effects_after=0`、"
              "**页面逐字节还原**（与装载前 sha256 相同）；重复卸载 ⇒ `not-loaded`",
              rc_unload == 0 and unload_payload.get("ok") is True and unload_payload.get("zero_effects") is True
              and (unload_payload.get("effects_before") or 0) > 0 and unload_payload.get("effects_after") == 0
              and f'data-ui-block="{BADGE}"' not in page_final and len(blocks_final) == 2
              and sha_final == sha_before
              and rc_unload2 != 0 and unload_again.get("code") == "not-loaded",
              f"sha 前={sha_before} 后={sha_final} 相同={sha_final == sha_before} "
              f"effects {unload_payload.get('effects_before')}→{unload_payload.get('effects_after')} "
              f"块数={len(blocks_final)} 重复卸载={unload_again.get('code')}")

        # L12 `./run plugin …`：一键运行的同一件事（薄入口只是转发 `--live`）
        run_rc, run_out, run_err = run_sh(RUN, ["plugin", "status", BADGE, "--port", str(port)], env_live)
        run_payload = json_line(run_out)
        check("L12 `./run plugin status <插件>` = 同一件事（`./run` 把动词原样转给 `tools/plugin.sh … --live`）",
              run_rc == 0 and run_payload.get("ok") is True and run_payload.get("control") == "live"
              and run_payload.get("loaded") is False,
              f"rc={run_rc} loaded={run_payload.get('loaded')} 原始行={run_out.strip()[:180]}")

        # L13 零写面：整轮装卸**不改产品树、不改账本/数据根**（宿主不写文件、不写账本）
        tree_after = tree_digest(ROOT / "src") + tree_digest(ROOT / "host")
        ledger_after = tree_digest(ROOT / data_dir)
        check("L13 零写面：整轮 load/reload/unload 前后 `src/**`+`host/**` 逐字节不变，且数据根（账本/待办件）"
              "逐字节不变（宿主只改自己的内存装配）",
              tree_after == tree_before and ledger_after == ledger_before,
              f"产品树不变={tree_after == tree_before} 数据根不变={ledger_after == ledger_before}")
    finally:
        shutdown_live()


def live_verb(script: Path, args: list[str], token: str) -> tuple[int, dict]:
    """跑一条 `--live` 动词（动词参数 + `--live`；环境里带控制令牌）。"""
    env = dict(os.environ)
    env["QUOTAGENT_PLUGIN_CONTROL_TOKEN"] = token
    rc, out, _err = run_sh(script, list(args) + ["--live"], env)
    return rc, json_line(out)


def ui_blocks(base: str) -> list[dict]:
    code, body, _ = http_get(f"{base}/api/ui/blocks")
    if code != 200:
        return []
    try:
        return json.loads(body).get("blocks", [])
    except json.JSONDecodeError:
        return []


def http_post_json(url: str, payload: dict, headers: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST",
                                    headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read().decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return err.code, {}


def tree_digest(root: Path) -> str:
    """目录的**内容摘要**（相对路径 + sha256，按路径排序）：判断"这一轮有没有改到它"。"""
    items = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if "node_modules" in path.parts or "__pycache__" in path.parts:
            continue
        items.append(f"{path.relative_to(root)}:{hashlib.sha256(path.read_bytes()).hexdigest()}")
    return hashlib.sha256("\n".join(items).encode("utf-8")).hexdigest()


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
    # D4/D5：阶段 5.2+ 的两条机制纪律（运行期装卸让它们从"应该"变成"必须"）
    # 实体（EV-177 搬进 system/webui/code/）；读旧路径会在薄重导上**静默判绿**（0 命中是因为文件里 0 语义）。
    route_path = ROOT / "src" / "system" / "webui" / "code" / "ui-route.mjs"
    route = route_path.read_text(encoding="utf-8") if route_path.exists() else ""
    route_hits = [needle for needle in needles if needle in route] + \
        [noun for noun in BUSINESS_NOUNS if noun in route]
    check("D4 路由注册面机制 `host/lib/ui-route.mjs` 同样 0 命中插件 id/标题/业务名词（与槽位面同纪律）",
          route_path.exists() and bool(route) and not route_hits, f"命中={route_hits}")
    cli_text = (ROOT / "host" / "cli.mjs").read_text(encoding="utf-8")
    start = cli_text.find("if (action === 'webui')")
    end = cli_text.find("\n  if (action === 'status')", start)
    webui_action = cli_text[start:end] if start >= 0 and end > start else ""
    # 只数**真赋值**（注释里为说明而写的字面量不算）
    live_patches = [line for line in webui_action.splitlines()
                    if "inner.provide =" in line and not line.strip().startswith(("//", "*", "/*"))]
    # 为什么查这条：`inner.provide = …` 抓句柄会污染**全树**的 provide，之后装载的插件把自己的服务注册在
    # 别人的 fiber 上 ⇒ 卸载摘不掉、服务名留在注册表里、运行期再装载必红（实测踩过，见文件内注释）。
    check("D5 `host/cli.mjs` 的 webui 装配段里 **0 处** `inner.provide =`（monkey-patch 不许逃出 apply —— "
          "否则运行期装卸留残注册）",
          start >= 0 and end > start and not live_patches,
          f"webui 段 {len(webui_action)} 字符；真赋值命中={len(live_patches)} 处 {live_patches[:2]}")


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
    # 变异 5/6 锚在**产品代码** `code/plugin-registry.mjs`（本批收紧的两处，逐处一条）：
    #   变异 5 = `scan` 把「没有 plugin.json 的目录」退回成插件 ⇒ 裸目录又被枚举/计数；
    #   变异 6 = `depsClosure` 的已知集合退回含 invalid ⇒ 清单不合法的目录又被当成「依赖已就绪」。
    {"name": "变异5：`scan` 把「只有目录、没有 plugin.json」退回成插件（裸目录又被枚举、又被计数）",
     "file": "code/plugin-registry.mjs",
     "find": "      notPlugins.push({ id, dir: item.dir, reason: 'manifest-missing' })",
     "replace": "      plugins.push({ ...base, reason: 'manifest-missing', invalid: true })",
     "bare_dirs": ("src/system/webui",),
     "sequence": [["list", "--json"]],
     "must_red": lambda payload: "system/webui" in [item.get("id") for item in payload.get("plugins", [])]},
    {"name": "变异6：依赖闭包把「目录存在」当「插件存在」（已知集合退回含 invalid 的目录）",
     "file": "code/plugin-registry.mjs",
     "find": "  const known = new Set(scanned.plugins.filter((item) => !item.invalid).map((item) => item.id))",
     "replace": "  const known = new Set(scanned.plugins.map((item) => item.id))",
     "invalid_dirs": ("src/system/webui",),
     "sequence": [["deps", "domain/advice"]],
     "must_red": lambda payload: payload.get("missing_targets") != ["system/webui"]},
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
    touched = {mutation.get("file", "tools/plugin-lifecycle.mjs") for mutation in MUTATIONS}
    sha_before = {rel: sha256(ROOT / "src" / "system" / "runtime" / rel) for rel in touched}
    baselines_ok = True
    baseline_notes = []
    for index, mutation in enumerate(MUTATIONS, start=1):
        relative = mutation.get("file", "tools/plugin-lifecycle.mjs")
        source_path = ROOT / "src" / "system" / "runtime" / relative
        source = source_path.read_text(encoding="utf-8")
        bare = tuple(mutation.get("bare_dirs", ()))
        invalid = tuple(mutation.get("invalid_dirs", ()))
        # ① 基线（未变异）跑同一序列：**必须不是红的**，否则"变异变红"说明不了任何事
        base_root = make_mutant_root(f"b{index}", bare, invalid)
        staged_base = stage_mutant_plugin_dir(f"b{index}")
        payload, legible, rc = run_mutant_sequence(staged_base / "runtime" / "tools" / "plugin-lifecycle.mjs",
                                                  base_root, mutation["sequence"])
        base_red = bool(mutation["must_red"](payload)) if legible else True
        baseline_notes.append(f"#{index} 基线红={base_red}")
        if base_red:
            baselines_ok = False
        # ② 变异体：同一序列必须**变红**
        mutated = apply_mutation(source, mutation["find"], mutation["replace"])
        if mutated is None or mutated == source:
            check(f"F{index} 变异：{mutation['name']}", False,
                  f"假变异：锚点唯一性={mutated is not None} 字节已变={mutated != source}")
            continue
        staged = stage_mutant_plugin_dir(f"m{index}")
        mutant_cli = staged / "runtime" / "tools" / "plugin-lifecycle.mjs"
        (staged / "runtime" / relative).write_text(mutated, encoding="utf-8")
        mutant_root = make_mutant_root(f"m{index}", bare, invalid)
        payload, legible, rc = run_mutant_sequence(mutant_cli, mutant_root, mutation["sequence"])
        red = bool(mutation["must_red"](payload)) if legible else False
        check(f"F{index} 变异：{mutation['name']}（必须让指定断言变红）", red,
              f"变异体 rc={rc} 有效载荷={legible} 锚在 {relative} payload={json.dumps(payload, ensure_ascii=False)[:200]}")
    check("F0 基线（未变异）在同一序列上**不红**（否则六条变异变红都是空转）",
          baselines_ok, "；".join(baseline_notes))
    fake = apply_mutation(original_cli, "这一段源码里根本不存在-MUTATION-ANCHOR", "x")
    check("F7 防假变异：不存在的锚点必须返回 None（否则『变异变红』说明不了任何事）", fake is None, f"fake={fake!r}")
    check("F8 全过程**产品树字节不变**（变异只写在临时副本里）",
          all(sha256(ROOT / "src" / "system" / "runtime" / rel) == digest for rel, digest in sha_before.items()),
          "；".join(f"{rel}={digest[:12]}" for rel, digest in sorted(sha_before.items())))


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
    assert_live_lifecycle()
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
