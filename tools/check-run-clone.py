#!/usr/bin/env python3
"""run-clone 门（`tools/verify.sh run-clone`）—— 「克隆就能一键跑」在**只含已提交内容的副本**上的真跑验收。

规范原文：`docs/design/28-plugin-requirements-and-run.md` §3.1（【验收】那一行：清洁副本 + 空 HOME + 断网条件下跑 `./run up`）；
用法与判据：`src/system/runtime/docs/one-command-run.md`；实现：仓库根 `./run`（POSIX sh，薄入口）。

与 `run-once` 的分工（两个门都要有，不是重复）：
  · `run-once` 在**工作树**上验一键运行（doctor/up/down/status/logs/config init + 空 HOME + 断网 + 8 处变异）——
    它能进提交前的门链，因为读的是工作树。
  · 本门解 `git archive HEAD` 到**仓库外的临时目录**（副本里**不含** `.venv`/`host/node_modules`/`tmp`/`user-space/` 目录），
    因此它校验的是 **HEAD 本身**：与 `clean-copy` 同类，**必须在 commit 之后跑**（不能进提交前的门链）。

这个门断言什么（全部真跑真回读，不读代码猜）：
  K1 副本**只含已提交内容**：解包出来的路径集合 == `git ls-tree -r HEAD`（逐条对账），且 `.git`/`.venv`/`host/node_modules`/`tmp`
     都不在副本里、`user-space` 是 tracked 符号链接（不是目录）。
  K2 副本里的入口**真的可执行**：`run` 与每个 `tools/*.sh` 都有执行位。（实测缺陷：索引里是 100644 ⇒ 干净克隆里
     `./run up` 报 `host-deps-install-failed`、`./run doctor` 的 `gates` 项 FAIL、`tools/verify.sh` 起不来。）
  K3 `./run doctor` 在干净副本里**不崩、逐项给 next_action、退出码 0**（7 项齐全、每项有 status 与 next_action；
     缺凭据/缺依赖只降级不阻塞）。
  K4 `./run up` **一条命令成功**：真起服务 + 外部实测 `/api/health` 200 + `/quotagent/` 页面 200 + pid 是活进程
     + 副本内自建 `.venv/`（自包含运行时）+ 依赖准备有留痕。
  K5 `./run status` 健康（healthy=true、port/pid 与 up 一致、managed=true；degraded[] 逐项 available=false + reason + next_action）。
  K6 二次 `up` 幂等（`state=already-up`、pid 不变、`idempotent:true`），两次 `status` **逐字节一致**。
  K7 `down` 真回收（退出码 0 + `released:true` + 外部连接被拒），再 `down` 幂等（`state=not-managed`）。
  K8 反向对照①（缺依赖，非空转）：副本里删掉 `host/node_modules` 后再跑 `doctor`/`up` —— `doctor` 必须**如实**
     报 cordis 非 ok（带命名 reason 与 next_action），`up` 必须**要么**一条命令重装好并健康、**要么**如实失败
     （有名 code + next_action）；**不许"假装成功"**。
  K9 反向对照②（装不上，非空转）：断网垫片（LD_PRELOAD，libc 层拦 connect/getaddrinfo）+ 空 npm 缓存 ⇒ `up`
     **如实失败**：`code=host-deps-install-failed` + 退出码非 0 + `log`/`log_tail` 给出真原因（失败可诊断，不吞输出）。
  K9b 反向对照②b（npm 不可用，可移植）：`QUOTAGENT_NODE` 指向没有同级 `npm` 的 node ⇒ 同一条失败路径、
     同样有名 code + 可诊断日志（不依赖 gcc）。
  K10 **4 处单点变异全红**（依赖准备改坏 / 健康检查改成不检查 / down 不释放端口 / doctor 把缺失报成 ok），
      每处先在**同序列的未变异副本**上确认不红；变异体 == 原件 + 一处替换（字节级单点）。
  K11 全过程**产品树字节不变**（`run`、`tools/*.sh`、本门自己、`host/package-lock.json`）。
  K12 副本外的 HOME 里**除 npm 自己的缓存/日志**（`.npm/**`）没有别的东西 —— 服务与运行期数据全在副本自己的
      `tmp/` 内。（诚实边界：干净副本第一次 `up` 要跑 `npm install`，**npm 会写 `~/.npm/**`**；这是"依赖准备"
      这一步的既有边界，门把非 npm 的条目判红、把 npm 的条目如实计数并打印。）

用法：`tools/verify.sh run-clone`（或 `python3 tools/check-run-clone.py [--keep]`）；`--keep` 保留临时副本目录。
退出码：0 全通过 / 1 有断言失败 / 2 环境错误（缺 git/tar、不是仓库、解包失败）。
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
DOCTOR_ITEMS = ["interpreter", "node", "cordis", "port", "config", "credentials", "gates"]
PREFIX = "/quotagent"
HEALTH_PATH = f"{PREFIX}/api/health"
PAGE_PATH = f"{PREFIX}/"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_status(url: str, timeout: float = 4.0) -> int:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as err:
        return err.code
    except OSError:
        return 0


def wait_health(port: int, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_status(f"http://127.0.0.1:{port}{HEALTH_PATH}") == 200:
            return True
        time.sleep(0.5)
    return False


def wait_port_free(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_status(f"http://127.0.0.1:{port}{HEALTH_PATH}", timeout=2.0) == 0:
            return True
        time.sleep(0.5)
    return False


def wait_health_after(port: int, payload: dict, timeout: float = 70.0) -> bool:
    """`up` 报成功后**才**长等；`up` 已如实失败就不空等（否则每条失败路径都要烧满超时）。"""
    if payload.get("ok") is True and payload.get("state") == "started":
        return wait_health(port, timeout=timeout)
    return http_status(f"http://127.0.0.1:{port}{HEALTH_PATH}", timeout=3.0) == 200


def last_json(text: str) -> dict:
    for line in reversed([item for item in text.splitlines() if item.strip()]):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def committed_paths() -> list[str]:
    """`git ls-tree -r -z HEAD` 的路径集合（`-z` 避免非 ASCII 路径被引号包裹）。"""
    proc = subprocess.run(["git", "-C", str(ROOT), "ls-tree", "-r", "-z", "--name-only", "HEAD"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"git ls-tree 失败：{proc.stderr.strip()[:200]}")
    return sorted(item for item in proc.stdout.split("\0") if item)


def copy_paths(copy: Path) -> list[str]:
    return sorted(str(item.relative_to(copy)) for item in copy.rglob("*")
                  if item.is_file() or item.is_symlink())


def extract(dest: Path) -> int:
    """`git archive HEAD | tar -x -C dest`：只含已提交内容。"""
    archive = subprocess.run(["git", "-C", str(ROOT), "archive", "HEAD"], capture_output=True)
    if archive.returncode != 0:
        print(f"run-clone 门：git archive 失败：{archive.stderr.decode()[:200]}", file=sys.stderr)
        return 2
    dest.mkdir(parents=True, exist_ok=True)
    untar = subprocess.run(["tar", "-x", "-C", str(dest)], input=archive.stdout, capture_output=True)
    if untar.returncode != 0:
        print(f"run-clone 门：解包失败：{untar.stderr.decode()[:200]}", file=sys.stderr)
        return 2
    return 0


def copy_env(copy: Path, home: Path, extra: dict | None = None) -> dict:
    """跑副本里的 `./run` 的环境：**不借用会话注入的解释器/令牌**，配置与 token 指到副本内部（不存在 ⇒ 只降级）。"""
    env = dict(os.environ)
    env.pop("QUOTAGENT_PY", None)
    env.pop("QUOTAGENT_PLUGIN_CONTROL_TOKEN", None)
    env["QUOTAGENT_ROOT"] = str(copy)
    env["HOME"] = str(home)
    env["QUOTAGENT_CONFIG_FILE"] = str(copy / "tmp" / "run-clone" / "config.yaml")
    env["QUOTAGENT_ADMIN_TOKEN_FILE"] = str(copy / "tmp" / "run-clone" / "absent-token")
    if extra:
        env.update(extra)
    return env


def run_copy(copy: Path, args: list[str], env: dict, timeout: int = 300) -> tuple[int, str, str]:
    """**直接执行** `<副本>/run`（不是 `sh run`）：执行位缺失必须在这里暴露，而不是被绕过去。"""
    try:
        proc = subprocess.run([str(copy / "run"), *args], cwd=str(copy), capture_output=True, text=True,
                              timeout=timeout, env=env)
    except OSError as err:
        return 126, "", f"{type(err).__name__}: {err}"
    except subprocess.TimeoutExpired:
        return 124, "", f"超时 {timeout}s"
    return proc.returncode, proc.stdout, proc.stderr


def pid_file_pid(copy: Path, port: int) -> int | None:
    path = copy / "tmp" / "run" / f"webui-{port}.pid"
    if not path.is_file():
        return None
    try:
        return int(path.read_text(encoding="utf-8").splitlines()[0].strip())
    except (ValueError, IndexError):
        return None


def kill_pid(pid: int | None) -> None:
    if not pid:
        return
    for signum in (15, 9):
        try:
            os.kill(pid, signum)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.4)


def teardown(copy: Path, port: int, env: dict) -> None:
    """不管变没变异，都按副本自己的记录收摊（不许门外留进程）。"""
    run_copy(copy, ["down", "--port", str(port)], env, timeout=60)
    if not wait_port_free(port, timeout=4.0):
        kill_pid(pid_file_pid(copy, port))
        wait_port_free(port, timeout=6.0)


def build_netblock(work: Path) -> tuple[Path | None, str]:
    """编译断网垫片（`tools/netblock.c`）；本机没有 gcc/cc 就如实返回 None。"""
    source = ROOT / "tools" / "netblock.c"
    if not source.exists():
        return None, "缺 tools/netblock.c"
    compiler = shutil.which("gcc") or shutil.which("cc")
    if compiler is None:
        return None, "本机没有 gcc/cc（垫片编译不了）"
    so = work / "netblock.so"
    proc = subprocess.run([compiler, "-shared", "-fPIC", "-O0", "-o", str(so), str(source), "-ldl"],
                          capture_output=True, text=True, timeout=180)
    if proc.returncode != 0 or not so.exists():
        return None, f"编译失败：{proc.stderr.strip()[-160:]}"
    return so, f"编译成功（{compiler}）"


# ---------------------------------------------------------------------------------------------
# K1–K3：副本形态 + 可执行入口 + doctor
# ---------------------------------------------------------------------------------------------
def assert_copy_shape(copy: Path) -> None:
    committed = committed_paths()
    present = copy_paths(copy)
    only_head = sorted(set(committed) - set(present))
    only_copy = sorted(set(present) - set(committed))
    check("K1 副本**只含已提交内容**：解包路径集合 == `git ls-tree -r HEAD`（逐条对账，无多无少）",
          not only_head and not only_copy and len(committed) == len(present),
          f"HEAD {len(committed)} 条 / 副本 {len(present)} 条；只在 HEAD={only_head[:4]} 只在副本={only_copy[:4]}")
    runtime_dirs = [str(item.relative_to(copy)) for item in copy.rglob("*")
                    if item.name in {".venv", "node_modules", "tmp", "__pycache__"}]
    check("K1b 副本里**没有运行时目录**（`.venv` / `host/node_modules` / `tmp` / `__pycache__` 全部不在）",
          not runtime_dirs, f"命中={runtime_dirs[:5]}" if runtime_dirs else "0 个（干净）")
    user_space = copy / "user-space"
    check("K1c `user-space` 是 tracked 的**符号链接**（指向 `src/userspace`），不是目录",
          user_space.is_symlink() and os.readlink(user_space) == "src/userspace",
          f"is_symlink={user_space.is_symlink()} -> {os.readlink(user_space) if user_space.is_symlink() else '(目录/缺失)'}")


def assert_entry_executable(copy: Path) -> None:
    scripts = [copy / "run"] + sorted((copy / "tools").glob("*.sh"))
    not_exec = [str(item.relative_to(copy)) for item in scripts if not os.access(item, os.X_OK)]
    check("K2 副本里的入口**真的可执行**：`run` 与每个 `tools/*.sh` 都有执行位"
          "（实测缺陷：索引 100644 ⇒ 干净克隆 `./run up` 报 `host-deps-install-failed`）",
          not not_exec, f"共 {len(scripts)} 个；无执行位={not_exec}" if not_exec else
          f"共 {len(scripts)} 个全部可执行（{' '.join(str(i.relative_to(copy)) for i in scripts[:3])} …）")


def assert_doctor_clean(copy: Path, env: dict, port: int) -> dict:
    rc, out, err = run_copy(copy, ["doctor", "--port", str(port)], env)
    payload = last_json(out)
    checks = {item.get("item"): item for item in payload.get("checks", [])}
    item_lines = [line for line in out.splitlines() if line.startswith(("[ok]", "[degraded]", "[FAIL]"))]
    ok = (rc == 0 and payload.get("ok") is True and payload.get("blocking") == 0
          and [item.get("item") for item in payload.get("checks", [])] == DOCTOR_ITEMS
          and all(isinstance(item.get("next_action"), str) for item in payload.get("checks", []))
          and all(item.get("status") in ("ok", "degraded") for item in payload.get("checks", []))
          and len(item_lines) >= len(DOCTOR_ITEMS))
    check("K3 干净副本里 `./run doctor` **不崩 + 7 项齐全 + 逐项 next_action + 退出码 0**"
          "（缺凭据/缺依赖只降级：`blocking=0` = 这机器能跑）",
          ok, f"rc={rc} ok={payload.get('ok')} blocking={payload.get('blocking')} "
              f"items={[item.get('item') for item in payload.get('checks', [])]} "
              f"状态={ {name: item.get('status') for name, item in checks.items()} } "
              f"逐项行={len(item_lines)} err={err.strip()[-120:]}")
    return payload


# ---------------------------------------------------------------------------------------------
# K4–K7：up / status / 二次 up / down —— 干净副本上的完整一轮
# ---------------------------------------------------------------------------------------------
def assert_up_down_cycle(copy: Path, env: dict, port: int) -> None:
    rc_up1, out_up1, err_up1 = run_copy(copy, ["up", "--port", str(port), "--no-seed"], env)
    payload_up1 = last_json(out_up1)
    healthy = wait_health_after(port, payload_up1)
    page = http_status(f"http://127.0.0.1:{port}{PAGE_PATH}")
    pid = payload_up1.get("pid")
    live = isinstance(pid, int) and _alive(pid)
    venv = (copy / ".venv" / "bin" / "python").exists()
    deps_log = copy / "tmp" / "run" / "deps-install.log"
    deps_text = deps_log.read_text(encoding="utf-8", errors="replace") if deps_log.is_file() else ""
    check("K4 干净副本里 `./run up` **一条命令成功**：真起服务（pid 是活进程）+ 外部实测 `/api/health` 200 + "
          "`/quotagent/` 页面 200 + 副本内自建 `.venv/`（自包含）+ 依赖准备有留痕",
          rc_up1 == 0 and payload_up1.get("ok") is True and payload_up1.get("state") == "started"
          and payload_up1.get("healthy") is True and healthy and page == 200 and live and venv
          and "cordis.sh install" in deps_text,
          f"rc={rc_up1} state={payload_up1.get('state')} healthy={payload_up1.get('healthy')} "
          f"外部health={healthy} page={page} pid={pid} 活={live} .venv={venv} "
          f"deps_log=`cordis.sh install`={'cordis.sh install' in deps_text} err={err_up1.strip()[-120:]}")

    rc_st1, out_st1, _err = run_copy(copy, ["status", "--port", str(port)], env)
    payload_st1 = last_json(out_st1)
    degraded = payload_st1.get("degraded") or []
    check("K5 `./run status` 健康：`healthy=true` + port/pid 与 up 一致 + `managed=true`；"
          "`degraded[]` 逐项 `available:false` + 有名 reason + next_action（缺凭据不阻塞）",
          rc_st1 == 0 and payload_st1.get("healthy") is True and payload_st1.get("port") == port
          and payload_st1.get("managed") is True and payload_st1.get("pid") == pid and degraded
          and all(item.get("available") is False and item.get("reason") and item.get("next_action")
                  and item.get("plugin") for item in degraded),
          f"rc={rc_st1} payload={json.dumps(payload_st1, ensure_ascii=False)[:260]}")

    rc_up2, out_up2, _err = run_copy(copy, ["up", "--port", str(port), "--no-seed"], env)
    payload_up2 = last_json(out_up2)
    rc_st2, out_st2, _err = run_copy(copy, ["status", "--port", str(port)], env)
    check("K6 二次 `up` 幂等（`state=already-up` + pid 不变 + `idempotent:true`）且两次 `status` **逐字节一致**",
          rc_up2 == 0 and payload_up2.get("state") == "already-up"
          and payload_up2.get("idempotent") is True and payload_up2.get("pid") == pid
          and rc_st2 == 0 and out_st1 == out_st2,
          f"rc={rc_up2} state={payload_up2.get('state')} pid={payload_up2.get('pid')} vs {pid} "
          f"status 一致={out_st1 == out_st2}")

    rc_down1, out_down1, _err = run_copy(copy, ["down", "--port", str(port)], env)
    payload_down1 = last_json(out_down1)
    released = wait_port_free(port, timeout=8.0)
    check("K7 `down` 真回收：退出码 0 + `released:true` + 端口**真释放**（外部连接被拒）",
          rc_down1 == 0 and payload_down1.get("stopped") is True and payload_down1.get("released") is True
          and released,
          f"rc={rc_down1} payload={json.dumps(payload_down1, ensure_ascii=False)[:200]} 端口释放={released}")
    rc_down2, out_down2, _err = run_copy(copy, ["down", "--port", str(port)], env)
    payload_down2 = last_json(out_down2)
    check("K7b 再 `down` 幂等（`state=not-managed` / `process-gone`，退出码 0；不碰不是自己起的进程）",
          rc_down2 == 0 and payload_down2.get("ok") is True
          and payload_down2.get("state") in ("not-managed", "process-gone"),
          f"rc={rc_down2} state={payload_down2.get('state')}")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, ValueError):
        return False


# ---------------------------------------------------------------------------------------------
# K8：反向对照①（删掉 host/node_modules）
# ---------------------------------------------------------------------------------------------
def assert_missing_deps_honest(work: Path, base_env_note: str) -> None:
    copy = work / "negative-nodeps"
    if extract(copy) != 0:
        check("K8 反向对照：删掉 `host/node_modules` 后 doctor/up 如实报（非空转）", False, "解包失败")
        return
    port = free_port()
    home = work / "negative-nodeps-home"
    home.mkdir(parents=True, exist_ok=True)
    env = copy_env(copy, home)
    run_copy(copy, ["up", "--port", str(port), "--no-seed"], env)          # 先正常起一次（装好依赖）
    teardown(copy, port, env)
    shutil.rmtree(copy / "host" / "node_modules", ignore_errors=True)
    deps_log = copy / "tmp" / "run" / "deps-install.log"
    if deps_log.exists():
        deps_log.unlink()

    rc_doc, out_doc, _err = run_copy(copy, ["doctor", "--port", str(port)], env)
    payload_doc = last_json(out_doc)
    cordis = {item.get("item"): item for item in payload_doc.get("checks", [])}.get("cordis", {})
    honest_doctor = (cordis.get("status") in ("degraded", "failed")
                     and bool(cordis.get("next_action"))
                     and cordis.get("detail") in ("will-install-on-up", "missing-and-no-npm", "missing"))
    rc_up, out_up, err_up = run_copy(copy, ["up", "--port", str(port), "--no-seed"], env)
    payload_up = last_json(out_up)
    healthy = wait_health_after(port, payload_up)
    reinstalled = (copy / "host" / "node_modules" / "cordis").is_dir()
    honest_up = (rc_up == 0 and payload_up.get("ok") is True and healthy and reinstalled) or \
                (rc_up != 0 and payload_up.get("ok") is False and payload_up.get("code")
                 and payload_up.get("next_action"))
    check("K8 反向对照①（缺依赖，非空转）：删掉 `host/node_modules` 后 `doctor` **如实**报 cordis 非 ok"
          "（命名 reason + next_action），`up` **要么**一条命令重装好并健康、**要么**如实失败（有名 code + next_action）"
          f"；实测 {base_env_note}",
          honest_doctor and honest_up,
          f"doctor: cordis={json.dumps(cordis, ensure_ascii=False)[:160]} rc={rc_doc} | "
          f"up: rc={rc_up} state={payload_up.get('state')} code={payload_up.get('code')} "
          f"healthy={healthy} 重装={reinstalled} err={err_up.strip()[-100:]}")
    teardown(copy, port, env)
    shutil.rmtree(copy, ignore_errors=True)


# ---------------------------------------------------------------------------------------------
# K9/K9b：反向对照②（依赖装不上 ⇒ 如实失败且可诊断）
# ---------------------------------------------------------------------------------------------
def assert_install_failure_diagnosable(work: Path) -> None:
    shim, shim_note = build_netblock(work)
    copy = work / "negative-install"
    if extract(copy) != 0:
        check("K9 反向对照②：装不上时 `up` 如实失败且可诊断", False, "解包失败")
        check("K9b 反向对照②b：npm 不可用时同一条失败路径", False, "解包失败")
        return
    port = free_port()
    home = work / "negative-install-home"
    home.mkdir(parents=True, exist_ok=True)

    # K9：断网（libc 层）+ 空 npm 缓存 ⇒ 依赖真的装不上
    # 注意（实测）：本环境的会话变量里有**大写** `NPM_CONFIG_CACHE`（指向热缓存），只设小写 `npm_config_cache`
    # 时 npm 仍能从热缓存离线装成功（那样这条反向对照会变成空转）⇒ 大小写两种变量都指向空目录。
    empty_cache = work / "empty-npm-cache"
    empty_cache.mkdir(exist_ok=True)
    offline = {"npm_config_cache": str(empty_cache), "NPM_CONFIG_CACHE": str(empty_cache),
               "npm_config_offline": "true", "NPM_CONFIG_OFFLINE": "true",
               "npm_config_audit": "false", "npm_config_fund": "false"}
    if shim is not None:
        env = copy_env(copy, home, {"LD_PRELOAD": str(shim), "QUOTAGENT_NETBLOCK_LOG": str(work / "netblock.log"), **offline})
    else:
        env = copy_env(copy, home, offline)
    deps_log = copy / "tmp" / "run" / "deps-install.log"
    if deps_log.exists():
        deps_log.unlink()
    rc, out, err = run_copy(copy, ["up", "--port", str(port), "--no-seed"], env)
    payload = last_json(out)
    tail = str(payload.get("log_tail") or "")
    log_path = str(payload.get("log") or "")
    diagnosable = bool(tail.strip()) and any(marker in tail for marker in
                                            ("ENOTCACHED", "ENOTFOUND", "ENETUNREACH", "EAI_FAIL", "npm error"))
    attempts = [line for line in (work / "netblock.log").read_text(encoding="utf-8").splitlines()
                if line.strip()] if (work / "netblock.log").is_file() else []
    check("K9 反向对照②（装不上 ⇒ 如实失败且可诊断）：断网垫片（libc 层拦 connect/getaddrinfo）+ 空 npm 缓存下 "
          "`up` 退出码非 0、`code=host-deps-install-failed`、`ok:false`，并把**日志路径 + 尾部真原因**带回来"
          "（不吞输出、不假装成功）",
          rc != 0 and payload.get("ok") is False and payload.get("code") == "host-deps-install-failed"
          and bool(payload.get("next_action")) and log_path.endswith("deps-install.log") and diagnosable,
          f"rc={rc} code={payload.get('code')} 垫片={shim_note} 拦下的对外尝试={attempts[:1]} "
          f"log={log_path or '(缺)'} log_tail={tail[:200] or '(空)'}")
    if not wait_port_free(port, timeout=3.0):
        kill_pid(pid_file_pid(copy, port))

    # K9b：npm 不可用（QUOTAGENT_NODE 指向没有同级 npm 的 node）——不依赖 gcc/网络，任何机器都能跑
    node_no_npm = shutil.which("true") or "/bin/true"
    if deps_log.exists():
        deps_log.unlink()
    env2 = copy_env(copy, home, {"QUOTAGENT_NODE": node_no_npm, "PATH": "/usr/bin:/bin"})
    rc2, out2, _err = run_copy(copy, ["up", "--port", str(port), "--no-seed"], env2)
    payload2 = last_json(out2)
    tail2 = str(payload2.get("log_tail") or "")
    check("K9b 反向对照②b（npm 不可用，可移植）：`QUOTAGENT_NODE` 指向没有同级 `npm` 的 node ⇒ 同一条失败路径"
          "（`code=host-deps-install-failed` + 退出码非 0 + 日志尾部给出真原因）",
          rc2 != 0 and payload2.get("ok") is False and payload2.get("code") == "host-deps-install-failed"
          and bool(payload2.get("next_action")) and "not found" in tail2,
          f"rc={rc2} code={payload2.get('code')} QUOTAGENT_NODE={node_no_npm} log_tail={tail2[-160:] or '(空)'}")
    teardown(copy, port, env2)
    shutil.rmtree(copy, ignore_errors=True)


# ---------------------------------------------------------------------------------------------
# K10：4 处单点变异（每处先在未变异副本上确认不红）
# ---------------------------------------------------------------------------------------------
MUTATIONS = [
    {"name": "变异1：把依赖准备步骤改坏（跳过 cordis 安装）",
     "find": '  if [ ! -d "$ROOT/host/node_modules/cordis" ]; then',
     "replace": '  if [ "x" = "y" ]; then',
     "steps": ["up"],
     "must_red": lambda facts: not (facts["steps"][0]["rc"] == 0
                                    and facts["steps"][0]["payload"].get("ok") is True
                                    and facts["steps"][0]["healthy"]),
     "why": "缺依赖又不装 ⇒ 起不来；这条红 = K4 真的在验「一条命令装好并起服务」"},
    {"name": "变异2：把健康检查改成不检查（探针恒真）",
     "find": '    [ "$_ph_code" = "200" ] && return 0',
     "replace": '    return 0',
     "steps": ["up"],
     "must_red": lambda facts: not (facts["steps"][0]["payload"].get("state") == "started"
                                    and facts["steps"][0].get("live") is True
                                    and facts["steps"][0].get("health") == 200),
     "why": "探针恒真 ⇒ 什么都没起也报 already-up/healthy；这条红 = K4 的外部实测与 pid 活体断言不是摆设"},
    {"name": "变异3：把 down 改成不释放端口（收不到本次启动的 pid ⇒ 不回收）",
     "find": '  _pid=$(read_pid_file)\n  if [ -z "$_pid" ]; then',
     "replace": '  _pid=""\n  if [ -z "$_pid" ]; then',
     "steps": ["up", "down"],
     "must_red": lambda facts: not (facts["by"]['down']["rc"] == 0
                                    and facts["by"]['down']["payload"].get("released") is True
                                    and facts["by"]['down'].get("port_free") is True),
     "why": "down 拿不到自己起的 pid ⇒ 走 not-managed 分支、服务照旧在跑、端口没释放；"
            "这条红 = K7 的「真释放」断言真的连了端口（而不是只看 JSON 里的 released 字段）"},
    {"name": "变异4：doctor 把缺失的依赖报成 ok（假装能跑）",
     "find": '{"item":"cordis","status":"degraded","detail":"will-install-on-up"',
     "replace": '{"item":"cordis","status":"ok","detail":"will-install-on-up"',
     "steps": ["up", "delete:host/node_modules", "doctor"],
     "must_red": lambda facts: not (cordis_status(facts) in ("degraded", "failed")),
     "why": "缺依赖报到 ok ⇒ 「如实报」被破；这条红 = K8 的 doctor 口径真的能抓住假装成功"},
]


def run_steps(copy: Path, work: Path, port: int, steps: list[str]) -> dict:
    """跑一组步骤（真跑副本里的 `./run`），记录 rc / 输出 / JSON / 外部实测。每个副本独立 HOME 与端口。"""
    home = work / f"home-{port}"
    home.mkdir(parents=True, exist_ok=True)
    env = copy_env(copy, home)
    facts: dict = {"steps": [], "by": {}}
    for step in steps:
        if step.startswith("delete:"):
            shutil.rmtree(copy / step.split(":", 1)[1], ignore_errors=True)
            continue
        args = ["up", "--port", str(port), "--no-seed"] if step == "up" else [step, "--port", str(port)]
        rc, out, err = run_copy(copy, args, env)
        entry = {"step": step, "rc": rc, "out": out, "err": err, "payload": last_json(out)}
        if step == "up":
            entry["healthy"] = wait_health_after(port, entry["payload"])
            entry["health"] = http_status(f"http://127.0.0.1:{port}{HEALTH_PATH}")
            pid = entry["payload"].get("pid")
            entry["live"] = isinstance(pid, int) and _alive(pid)
        if step == "down":
            entry["port_free"] = wait_port_free(port, timeout=10.0)
        facts["steps"].append(entry)
        facts["by"][step] = entry
    teardown(copy, port, env)
    return facts


def step_of(facts: dict, step: str) -> dict:
    return facts.get("by", {}).get(step) or {"rc": None, "payload": {}, "step": step}


def cordis_status(facts: dict) -> str | None:
    """doctor 那一步里 `cordis` 项的状态（用于「缺依赖必须如实报」那条断言）。"""
    checks = step_of(facts, "doctor")["payload"].get("checks") or []
    return {item.get("item"): item.get("status") for item in checks}.get("cordis")


def apply_replacement(path: Path, find: str, replace: str) -> bool:
    """唯一锚点单点替换；锚点不存在或不唯一 ⇒ False（假变异）。"""
    text = path.read_text(encoding="utf-8")
    if text.count(find) != 1:
        return False
    path.write_text(text.replace(find, replace, 1), encoding="utf-8")
    return True


def assert_mutations(work: Path) -> None:
    original = (ROOT / "run").read_bytes()
    baseline_ok = True
    notes: list[str] = []
    for index, mutation in enumerate(MUTATIONS, start=1):
        # ① 基线：同序列在未变异副本上**必须不红**
        base = work / f"base-{index}"
        if extract(base) != 0:
            check(f"K10-{index} 变异：{mutation['name']}", False, "基线解包失败")
            continue
        base_port = free_port()
        base_facts = run_steps(base, work, base_port, mutation["steps"])
        base_red = bool(mutation["must_red"](base_facts))
        notes.append(f"#{index} 基线红={base_red}")
        if base_red:
            baseline_ok = False
        # ② 变异体：同序列必须变红（单点替换，字节级可验）
        mutant = work / f"mutant-{index}"
        if extract(mutant) != 0:
            check(f"K10-{index} 变异：{mutation['name']}", False, "变异体解包失败")
            continue
        run_file = mutant / "run"
        if not apply_replacement(run_file, mutation["find"], mutation["replace"]):
            check(f"K10-{index} 变异：{mutation['name']}", False,
                  f"假变异：锚点出现 {run_file.read_text(encoding='utf-8').count(mutation['find'])} 次（必须恰好 1 次）")
            continue
        spliced = original.replace(mutation["find"].encode(), mutation["replace"].encode(), 1)
        single_point = run_file.read_bytes() == spliced
        mutant_port = free_port()
        facts = run_steps(mutant, work, mutant_port, mutation["steps"])
        red = bool(mutation["must_red"](facts))
        detail = "; ".join(f"{item['step']} rc={item['rc']} "
                           f"{json.dumps(item['payload'], ensure_ascii=False)[:70]}" for item in facts["steps"])
        check(f"K10-{index} 变异：{mutation['name']}（必须让指定断言变红；变异体 == 原件 + 单点替换）",
              red and single_point,
              f"红={red} 单点={single_point} | {mutation['why']} | {detail[:300]}")
    check("K10-0 基线（未变异）在同一序列上**不红**（否则四处变异变红都是空转）", baseline_ok, "；".join(notes))
    check("K10-5 全过程**产品树字节不变**（变异只写在仓库外的副本里；`./run` 与原件逐字节一致）",
          (ROOT / "run").read_bytes() == original,
          f"before={hashlib.sha256(original).hexdigest()[:12]} "
          f"after={hashlib.sha256((ROOT / 'run').read_bytes()).hexdigest()[:12]}")


def main(argv: list[str]) -> int:
    if not (ROOT / ".git").exists():
        print("run-clone 门：不是 git 仓库（HEAD 是判据的来源）", file=sys.stderr)
        return 2
    if shutil.which("git") is None or shutil.which("tar") is None:
        print("run-clone 门：需要 git 与 tar", file=sys.stderr)
        return 2
    tmpdir = Path(os.environ.get("TMPDIR") or "/tmp")
    if str(tmpdir.resolve()).startswith(str(ROOT)):
        tmpdir = Path("/tmp")        # 副本必须在**仓库外**（这正是本门要证的事）
    work = Path(tempfile.mkdtemp(prefix="quotagent-run-clone-", dir=str(tmpdir)))
    keep = "--keep" in argv
    print(f"干净副本工作目录（仓库外）：{work}")
    try:
        try:
            copy = work / "copy"
            if extract(copy) != 0:
                return 2
            print(f"副本：{copy}（{len(copy_paths(copy))} 个文件，只含已提交内容）")

            assert_copy_shape(copy)
            assert_entry_executable(copy)

            port = free_port()
            home = work / "home"
            home.mkdir(parents=True, exist_ok=True)
            env = copy_env(copy, home)
            assert_doctor_clean(copy, env, port)
            assert_up_down_cycle(copy, env, port)
            teardown(copy, port, env)

            home_files = [str(item.relative_to(home)) for item in home.rglob("*")]
            npm_home = [item for item in home_files if item.split("/", 1)[0] == ".npm"]
            other_home = [item for item in home_files if item.split("/", 1)[0] != ".npm"]
            check("K12 副本外的 HOME 里**除了 npm 自己的缓存/日志**（`.npm/**`）**没有别的东西**："
                  "`./run` 的服务与运行期数据全在副本自己的 `tmp/` 内（`tmp/run/` pid+日志、`tmp/run-shared` 数据根）",
                  not other_home and (copy / "tmp" / "run").is_dir() and (copy / "tmp" / "run-shared").is_dir(),
                  f"HOME={home} 非 npm 条目={other_home[:5]}；npm 自己写了 {len(npm_home)} 条（依赖安装步骤的既有边界）")

            assert_missing_deps_honest(work, "本机 npm 缓存热/有网（真实重装路径）")
            assert_install_failure_diagnosable(work)
            assert_mutations(work)
        except Exception as err:      # 门自己出错也要给出可读结果（不裸 traceback、不假装通过）
            import traceback
            check(f"K0 门自身执行**未崩**（捕获到异常）", False,
                  f"{type(err).__name__}: {err} | {traceback.format_exc().strip().splitlines()[-1][:160]}")
    finally:
        if keep:
            print(f"[--keep] 临时目录保留：{work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in RESULTS:
        print(f"{'[ok]  ' if ok else '[FAIL]'} {name}")
        if detail:
            print(f"        {detail}")
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（run-clone 门 {len(RESULTS) - len(failed)}/{len(RESULTS)}）")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
