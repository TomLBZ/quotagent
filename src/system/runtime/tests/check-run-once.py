#!/usr/bin/env python3
"""run-once 门（`tools/verify.sh run-once`）—— 一键运行契约（QUOTAGENT-ONE-COMMAND v1）的真跑验收。
**位置（本批迁移）**：实体在 `src/system/runtime/tests/check-run-once.py`；旧位置 `tools/check-run-once.py` 只剩**薄转发**
（`runpy` 指到本文件）—— 门名、`tools/verify.sh` 的分支、`./run` 与文档里的既有命令**一行未改**。

规范原文：`docs/design/28-plugin-requirements-and-run.md` §3.1；用法与判据：`src/system/runtime/docs/one-command-run.md`；
实现：仓库根 `./run`（POSIX sh，薄入口）。

这个门断言什么（全部真跑真回读）：
  R1 `./run doctor` 只读体检：7 项（解释器/Node/cordis/端口/配置指纹/凭据/门）+ 逐项 `next_action`，
     全绿时退出码 0；
  R2 外部凭据缺失**不得**阻塞：`doctor` 在"临时空配置 + 无管理员 token"下仍退出 0（凭据项只降级）；
  R3 端口被**别的进程**占用 ⇒ `doctor` 退出码非 0，端口项带 `next_action`（负控，非空转）；
  R4 `up` 后 `/api/health` 真 200、URL 真可达；
  R5 `status` 是一行 JSON，且给出 `degraded[]`（缺 token ⇒ `available:false` + reason + next_action）；
  R6 第二次 `up` 幂等（`state=already-up`、pid 不变）；
  R7 两次 `status` **逐字节一致**（摘要口径稳定，不掺墙钟）；
  R8 `down` 后端口**真释放**（连接被拒）；再次 `down` 幂等；
  R9 凭据缺失下的 `up` 仍成功（临时空配置 + 指向不存在的 token 文件），且 `status` 如实报 `available:false`；
  R10 端口被占时的 `up` 退出码非 0 并把日志路径写进错误体（不允许"起了但其实是坏的"）；
  R11 `run` 的 **4 处单点变异全红**（每处先在未变异基线上确认"不红"），且产品树字节不变。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
RUN = ROOT / "run"
PORT_HEALTH = "/quotagent/api/health"
DOCTOR_ITEMS = ["interpreter", "node", "cordis", "port", "config", "credentials", "gates"]
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


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


def wait_health(port: int, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_status(f"http://127.0.0.1:{port}{PORT_HEALTH}") == 200:
            return True
        time.sleep(0.5)
    return False


def run_script(script: Path, args: list[str], env_extra: dict | None = None,
               timeout: int = 240) -> tuple[int, str, str]:
    env = dict(os.environ)
    env["QUOTAGENT_RUN_ROOT"] = str(ROOT)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(["sh", str(script), *args], cwd=str(ROOT), capture_output=True, text=True,
                          timeout=timeout, env=env)
    return proc.returncode, proc.stdout, proc.stderr


def last_json(text: str) -> dict:
    for line in reversed([item for item in text.splitlines() if item.strip()]):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {}


class ForeignListener:
    """一个"别的进程"占着端口：对任何路径都回 404（所以本服务的健康探针不会把它当自己）。"""

    def __init__(self, port: int) -> None:
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(404)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"not-quotagent\n")

            def log_message(self, *_args) -> None:
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.port = port

    def __enter__(self) -> "ForeignListener":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.server.server_close()


def doctor(port: int, env_extra: dict | None = None) -> tuple[int, str, dict]:
    rc, out, err = run_script(RUN, ["doctor", "--port", str(port)], env_extra)
    return rc, out + err, last_json(out)


def shutdown(port: int, script: Path | None = None) -> None:
    run_script(script or RUN, ["down", "--port", str(port)])


def kill_pid(pid: str) -> None:
    try:
        os.kill(int(pid), 15)
        time.sleep(1)
        os.kill(int(pid), 9)
    except (ValueError, ProcessLookupError, PermissionError):
        pass


# ---------------------------------------------------------------------------------------------
# R1–R3：doctor
# ---------------------------------------------------------------------------------------------
def assert_doctor() -> None:
    port = free_port()
    rc, text, payload = doctor(port)
    checks = {item.get("item"): item for item in payload.get("checks", [])}
    item_lines = [line for line in text.splitlines()
                  if line.startswith(("[ok]", "[degraded]", "[FAIL]"))]
    check("R1 `./run doctor` 只读体检：7 项齐全（解释器/Node/cordis/端口/配置/凭据/门）+ 逐项 next_action + 退出码 0",
          rc == 0 and payload.get("ok") is True and payload.get("blocking") == 0
          and [item.get("item") for item in payload.get("checks", [])] == DOCTOR_ITEMS
          and all(isinstance(item.get("next_action"), str) for item in payload.get("checks", []))
          and all(item.get("status") in ("ok", "degraded", "failed") for item in payload.get("checks", []))
          and len(item_lines) == len(DOCTOR_ITEMS),
          f"rc={rc} items={[item.get('item') for item in payload.get('checks', [])]} 逐项行={len(item_lines)} "
          f"blocking={payload.get('blocking')}")
    check("R1b 配置项只报**指纹**（前 8 位十六进制），永不回显内容；凭据项只报来源与权限",
          re.fullmatch(r"[0-9a-f]{8}", str(checks.get("config", {}).get("fingerprint") or "")) is not None
          and "next_action" in checks.get("credentials", {}),
          f"fingerprint={checks.get('config', {}).get('fingerprint')} "
          f"credentials={checks.get('credentials', {}).get('detail')}")

    # R2 凭据缺失不阻塞：临时空配置 + 指向不存在的 token 文件
    with tempfile.TemporaryDirectory(prefix="run-once-cfg-") as tmp:
        empty_config = Path(tmp) / "config.yaml"
        empty_config.write_text("project: {}\nplugins: {}\n", encoding="utf-8")
        rc2, text2, payload2 = doctor(port, {"QUOTAGENT_CONFIG_FILE": str(empty_config),
                                             "QUOTAGENT_ADMIN_TOKEN_FILE": str(Path(tmp) / "absent-token")})
        checks2 = {item.get("item"): item for item in payload2.get("checks", [])}
        check("R2 外部凭据缺失**不阻塞**：空配置 + 无 token 下 `doctor` 仍退出 0（相关项只降级，且有 next_action）",
              rc2 == 0 and payload2.get("blocking") == 0
              and checks2.get("credentials", {}).get("status") == "degraded"
              and checks2.get("credentials", {}).get("next_action")
              and checks2.get("config", {}).get("status") in ("ok", "degraded"),
              f"rc={rc2} blocking={payload2.get('blocking')} credentials={checks2.get('credentials')} "
              f"config={checks2.get('config', {}).get('status')}")

    # R3 负控：端口被别的进程占用 ⇒ doctor 非 0
    foreign_port = free_port()
    with ForeignListener(foreign_port):
        rc3, _text3, payload3 = doctor(foreign_port)
    checks3 = {item.get("item"): item for item in payload3.get("checks", [])}
    check("R3 端口被**别的进程**占用 ⇒ `doctor` 退出码非 0，端口项 failed 且给 next_action（负控非空转）",
          rc3 != 0 and payload3.get("ok") is False and payload3.get("blocking", 0) >= 1
          and checks3.get("port", {}).get("status") == "failed"
          and checks3.get("port", {}).get("next_action"),
          f"rc={rc3} port={checks3.get('port')}")


# ---------------------------------------------------------------------------------------------
# R4–R9：up / status / down
# ---------------------------------------------------------------------------------------------
def assert_up_down_status() -> None:
    port = free_port()
    data_dir = f"tmp/run-once-gate/{port}"
    shutdown(port)
    rc_up1, out_up1, err_up1 = run_script(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"])
    payload_up1 = last_json(out_up1)
    healthy = wait_health(port)
    try:
        check("R4 `up` 幂等启动：真起服务 + `/api/health` 真 200 + URL 真可达",
              rc_up1 == 0 and payload_up1.get("ok") is True and payload_up1.get("healthy") is True
              and healthy and http_status(f"http://127.0.0.1:{port}/quotagent/") == 200
              and isinstance(payload_up1.get("ready_ms"), int),
              f"rc={rc_up1} payload={json.dumps(payload_up1, ensure_ascii=False)[:220]} err={err_up1[-120:]}")
        rc_st1, out_st1, _err = run_script(RUN, ["status", "--port", str(port)])
        payload_st1 = last_json(out_st1)
        degraded = payload_st1.get("degraded") or []
        check("R5 `status` 一行 JSON：`healthy/pid/port/url/ready_ms/degraded[]`；缺 token ⇒ "
              "`available:false` + 有名 reason + next_action",
              rc_st1 == 0 and len([line for line in out_st1.splitlines() if line.strip()]) == 1
              and payload_st1.get("healthy") is True and payload_st1.get("port") == port
              and payload_st1.get("managed") is True and payload_st1.get("pid") == payload_up1.get("pid")
              and degraded and all(item.get("available") is False and item.get("reason")
                                   and item.get("next_action") and item.get("plugin") for item in degraded),
              f"rc={rc_st1} payload={json.dumps(payload_st1, ensure_ascii=False)[:260]}")

        rc_up2, out_up2, _err = run_script(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"])
        payload_up2 = last_json(out_up2)
        check("R6 第二次 `up` 幂等：`state=already-up`、pid 不变（不重建、不覆盖数据）",
              rc_up2 == 0 and payload_up2.get("state") == "already-up"
              and payload_up2.get("idempotent") is True
              and payload_up2.get("pid") == payload_up1.get("pid"),
              f"rc={rc_up2} state={payload_up2.get('state')} pid={payload_up2.get('pid')} "
              f"vs {payload_up1.get('pid')}")
        rc_st2, out_st2, _err = run_script(RUN, ["status", "--port", str(port)])
        check("R7 两次 `status` **逐字节一致**（摘要口径里不掺墙钟：ready_ms 是启动时量到的常值）",
              out_st1 == out_st2 and rc_st2 == 0,
              f"identical={out_st1 == out_st2} 第一次={out_st1.strip()[:120]}")

        rc_down1, out_down1, _err = run_script(RUN, ["down", "--port", str(port)])
        payload_down1 = last_json(out_down1)
        released = http_status(f"http://127.0.0.1:{port}{PORT_HEALTH}") == 0
        check("R8 `down` 真回收：退出码 0 + 端口**真释放**（连接被拒）",
              rc_down1 == 0 and payload_down1.get("stopped") is True and payload_down1.get("released") is True
              and released, f"rc={rc_down1} payload={json.dumps(payload_down1, ensure_ascii=False)[:200]} released={released}")
        rc_down2, out_down2, _err = run_script(RUN, ["down", "--port", str(port)])
        payload_down2 = last_json(out_down2)
        check("R8b 再 `down` 幂等（`state=not-managed`，退出码 0；不动不是自己起的进程）",
              rc_down2 == 0 and payload_down2.get("ok") is True
              and payload_down2.get("state") in ("not-managed", "process-gone"),
              f"rc={rc_down2} state={payload_down2.get('state')}")
    finally:
        shutdown(port)


def assert_credentials_do_not_block_up() -> None:
    port = free_port()
    shutdown(port)
    with tempfile.TemporaryDirectory(prefix="run-once-cred-") as tmp:
        empty_config = Path(tmp) / "config.yaml"
        empty_config.write_text("project: {}\nplugins: {}\n", encoding="utf-8")
        env = {"QUOTAGENT_CONFIG_FILE": str(empty_config),
               "QUOTAGENT_ADMIN_TOKEN_FILE": str(Path(tmp) / "absent-token")}
        env.pop("QUOTAGENT_ADMIN_TOKEN", None)
        try:
            rc_up, out_up, err_up = run_script(RUN, ["up", "--port", str(port), "--data-dir",
                                                     f"tmp/run-once-gate/{port}", "--no-seed"], env)
            payload_up = last_json(out_up)
            healthy = wait_health(port)
            rc_st, out_st, _err = run_script(RUN, ["status", "--port", str(port)], env)
            payload_st = last_json(out_st)
            degraded = payload_st.get("degraded") or []
            check("R9 凭据缺失下 `up` **仍成功**（空配置 + 无 token）：退出码 0 + 健康 200；"
                  "受影响项在 `degraded[]` 里报 `available:false` + reason + next_action",
                  rc_up == 0 and payload_up.get("ok") is True and healthy
                  and rc_st == 0 and payload_st.get("healthy") is True
                  and any(item.get("reason") == "admin-token-absent" for item in degraded),
                  f"up_rc={rc_up} healthy={healthy} degraded={json.dumps(degraded, ensure_ascii=False)[:240]} "
                  f"err={err_up[-100:]}")
        finally:
            shutdown(port)


def assert_up_on_foreign_port() -> None:
    port = free_port()
    shutdown(port)
    with ForeignListener(port):
        rc, out, err = run_script(RUN, ["up", "--port", str(port), "--data-dir",
                                        f"tmp/run-once-gate/{port}", "--no-seed"])
        payload = last_json(out)
        text = out + err
        log_path = re.search(r"(/workspace/\S+\.log|tmp/run/webui-\d+\.log)", text)
        check("R10 端口被占时 `up` **退出码非 0**，并把日志路径写进错误体（不允许『起了但其实是坏的』）",
              rc != 0 and payload.get("ok") is False and log_path is not None
              and (ROOT / "tmp" / "run").exists(),
              f"rc={rc} payload={json.dumps(payload, ensure_ascii=False)[:200]} log={log_path.group(0) if log_path else None}")
    shutdown(port)


def assert_logs() -> None:
    """R12：`./run logs` —— **路径 + 有界尾部**；没有日志时**如实失败**（不假装成功）。"""
    port = free_port()
    data_dir = f"tmp/run-once-gate/logs-{port}"
    shutdown(port)
    rc_missing, out_missing, _err = run_script(RUN, ["logs", "--port", str(port)])
    payload_missing = last_json(out_missing)
    check("R12a 没有日志文件时 `./run logs` **如实失败**：`code=log-missing` + `exists:false` + next_action，"
          "退出码非 0（不假装成功、不编造尾部）",
          rc_missing != 0 and payload_missing.get("code") == "log-missing"
          and payload_missing.get("exists") is False and payload_missing.get("next_action")
          and payload_missing.get("tail_lines") == 0,
          f"rc={rc_missing} payload={json.dumps(payload_missing, ensure_ascii=False)[:200]}")

    shutdown(port)
    rc_up, out_up, _err = run_script(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"])
    try:
        if rc_up == 0 and wait_health(port):
            rc, out, _err = run_script(RUN, ["logs", "--port", str(port), "--lines", "5"])
            lines = [line for line in out.splitlines() if line.strip()]
            payload = last_json(out)
            tail_body = lines[1:-1]           # 第一行是路径头、最后一行是 JSON 摘要
            check("R12b `./run logs` 给出**最近日志的路径**与**有界尾部**（`--lines 5` ⇒ 恰 5 行；"
                  "摘要带 path/exists/bytes/file_lines/tail_lines/bounded/max_lines）",
                  rc == 0 and payload.get("exists") is True and str(payload.get("path", "")).endswith(".log")
                  and payload.get("tail_lines") == 5
                  and len(tail_body) == min(5, payload.get("file_lines", 0))
                  and payload.get("bounded") is True and payload.get("max_lines") == 200
                  and isinstance(payload.get("file_lines"), int) and isinstance(payload.get("bytes"), int)
                  and payload.get("path") in lines[0],
                  f"rc={rc} tail_lines={payload.get('tail_lines')} 实际尾部={len(tail_body)} "
                  f"file_lines={payload.get('file_lines')} 头={lines[0][:100] if lines else '(空)'}")
            rc_big, out_big, _err = run_script(RUN, ["logs", "--port", str(port), "--lines", "100000"])
            lines_big = [line for line in out_big.splitlines() if line.strip()]
            payload_big = last_json(out_big)
            check("R12c 尾部**有上界**：`--lines 100000` 被夹到 200 行（不把整份日志倒出来）",
                  rc_big == 0 and payload_big.get("tail_lines") == 200 and len(lines_big[1:-1]) <= 200
                  and payload_big.get("max_lines") == 200,
                  f"rc={rc_big} tail_lines={payload_big.get('tail_lines')} 实际={len(lines_big[1:-1])} 行")
        else:
            check("R12b `./run logs` 给出路径与有界尾部", False, f"up_rc={rc_up}（前置失败）")
            check("R12c 尾部有上界", False, "前置失败")
    finally:
        shutdown(port)


def config_whitelist() -> dict:
    """白名单真源 = `host/lib/config-keys.mjs` 的 PROJECT_KEYS（与 `./run config init` 同一份文件同一个正则）。"""
    text = (ROOT / "src" / "system" / "config" / "code" / "config-keys.mjs").read_text(encoding="utf-8")
    text = text.split("export const CREDENTIALS", 1)[0]
    out = {}
    for match in re.finditer(r"^\s{2}'([a-z0-9._-]+)': \{ type: '([a-z]+)', default: (.*?), note: ", text, re.M):
        out[match.group(1)] = (match.group(2), match.group(3))
    return out


def parse_yaml_config(path: Path) -> dict:
    """用 `tools/config-apply.py` 的解析器读生成出来的配置（**同一份子集**，不另写一个解析器）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("run_once_cfgapply", str(ROOT / "src" / "system" / "config" / "tools" / "config-apply.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.parse_yaml(path.read_text(encoding="utf-8"))


def flatten(node: dict, prefix: str = "") -> dict:
    out = {}
    for key, value in (node or {}).items():
        if isinstance(value, dict) and value:
            out.update(flatten(value, f"{prefix}{key}."))
        else:
            out[prefix + key] = value
    return out


def py_literal(raw: str):
    raw = raw.strip()
    if raw == "null":
        return None
    if raw in ("''", '""'):
        return ""
    if raw == "true":
        return True
    if raw == "false":
        return False
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip("'")


def assert_config_init() -> None:
    """R13：`./run config init` —— 只含白名单键、**不覆盖已有真配置**、打印指纹与逐条 next_action。"""
    work = ROOT / "tmp" / "run-once-gate"
    work.mkdir(parents=True, exist_ok=True)
    target = work / f"config-init-{free_port()}.yaml"
    if target.exists():
        target.unlink()
    rc, out, _err = run_script(RUN, ["config", "init", "--config-file", str(target)])
    payload = last_json(out)
    whitelist = config_whitelist()
    sha = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else ""
    next_action_lines = [line for line in out.splitlines() if line.startswith("[config init] ") and ": 现在值" in line]
    parsed = parse_yaml_config(target) if target.exists() else {}
    project_leaves = flatten(parsed.get("project", {}))
    expected_values = {key: py_literal(raw) for key, (_typ, raw) in whitelist.items()}
    check("R13a `./run config init` 生成 config.yaml：**只含白名单键**（键集合双向相等、值 = 默认层、"
          "段只有 apiVersion/project/plugins/credentials）、权限 0600、**指纹**与逐条 next_action 都打出来",
          rc == 0 and payload.get("ok") is True and target.exists()
          and set(project_leaves) == set(whitelist) and project_leaves == expected_values
          and parsed.get("plugins") == {} and parsed.get("credentials") == {}
          and set(parsed) == {"apiVersion", "project", "plugins", "credentials"}
          and payload.get("mode") == "600" and payload.get("fingerprint") == sha[:8]
          and payload.get("keys") == len(whitelist)
          and len(next_action_lines) == len(whitelist)
          and payload.get("credentials_written") is False,
          f"rc={rc} mode={payload.get('mode')} 指纹={payload.get('fingerprint')} vs {sha[:8]} "
          f"键 {len(project_leaves)}/{len(whitelist)} 段={sorted(parsed)} 逐条 next_action={len(next_action_lines)}")
    sha_first = sha
    rc2, out2, _err = run_script(RUN, ["config", "init", "--config-file", str(target)])
    payload2 = last_json(out2)
    sha_second = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else ""
    check("R13b 已有真配置文件 ⇒ **不覆盖**：第二次 `config init` 拒（`code=config-exists`、退出码非 0），"
          "文件**逐字节不变**",
          rc2 != 0 and payload2.get("code") == "config-exists" and payload2.get("overwritten") is False
          and sha_second == sha_first,
          f"rc={rc2} code={payload2.get('code')} sha 不变={sha_second == sha_first}")
    default_path = Path(os.environ.get("QUOTAGENT_CONFIG_FILE", "/workspace/config.yaml"))
    existed = default_path.exists()
    sha_before = hashlib.sha256(default_path.read_bytes()).hexdigest() if existed else ""
    rc3, out3, _err = run_script(RUN, ["config", "init"])
    payload3 = last_json(out3)
    if existed:
        sha_after = hashlib.sha256(default_path.read_bytes()).hexdigest()
        check("R13c 默认配置路径上跑 `config init`：真配置文件**一个字节都没动**（拒 + sha256 相同）",
              rc3 != 0 and payload3.get("code") == "config-exists" and sha_after == sha_before,
              f"rc={rc3} code={payload3.get('code')} path={default_path} sha 相同={sha_after == sha_before}")
    else:
        created = default_path.exists()
        check("R13c 默认配置路径不存在时 `config init` 生成它（本机这次属于首次生成；跑完即删，避免留副作用）",
              rc3 == 0 and created, f"rc={rc3} created={created}")
        if created:
            default_path.unlink()


# ---------------------------------------------------------------------------------------------
# R14：**空 HOME + 断网**下的一键运行（本环境做不到内核级断网 ⇒ 如实标注）
# ---------------------------------------------------------------------------------------------
def build_netblock(work: Path) -> tuple[Path | None, str]:
    """编译断网垫片（`tools/netblock.c`）；没有 gcc 就返回 None（门如实标注做不到的那一半）。"""
    source = ROOT / "tools" / "netblock.c"
    if not source.exists():
        return None, "缺 tools/netblock.c"
    compiler = shutil.which("gcc") or shutil.which("cc")
    if compiler is None:
        return None, "本机没有 gcc/cc（垫片编译不了）"
    so = work / "netblock.so"
    proc = subprocess.run([compiler, "-shared", "-fPIC", "-O0", "-o", str(so), str(source), "-ldl"],
                          cwd=str(ROOT), capture_output=True, text=True, timeout=180)
    if proc.returncode != 0 or not so.exists():
        return None, f"gcc 失败：{proc.stderr.strip()[-160:]}"
    return so, f"编译成功（{compiler}）"


def offline_env(home: Path, shim: Path | None, attempt_log: Path) -> dict:
    """空 HOME + 断网环境：LD_PRELOAD 垫片（拦 libc 层的对外连接/解析）+ 代理黑洞 + 包管理器离线开关。

    `NO_PROXY` **必须**放行回环：黑洞代理是为了"对外没有网"，不是为了把本机自己的健康检查也打死
    （实测踩过：NO_PROXY 留空 ⇒ `up` 内部的 curl 也走死代理 ⇒ 服务明明健康却报 unhealthy）。
    """
    env = {"HOME": str(home), "ALL_PROXY": "http://127.0.0.1:9", "all_proxy": "http://127.0.0.1:9",
           "HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9",
           "HTTPS_PROXY": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9",
           "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1",
           "PIP_NO_INDEX": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1",
           "npm_config_offline": "true", "npm_config_audit": "false", "npm_config_fund": "false"}
    if shim is not None:
        env["LD_PRELOAD"] = str(shim)
        env["QUOTAGENT_NETBLOCK_LOG"] = str(attempt_log)
    return env


def assert_empty_home_offline() -> None:
    port = free_port()
    data_dir = f"tmp/run-once-gate/offline-{port}"
    work = ROOT / "tmp" / "run-once-gate"
    work.mkdir(parents=True, exist_ok=True)
    shim, shim_note = build_netblock(work)
    attempt_log = work / "netblock-attempts.log"
    attempt_log.write_text("", encoding="utf-8")
    # 先自证垫片**非空转**：它必须真的拦住一次对外连接（否则"零次尝试"说明不了任何事）
    blocked_ok, blocked_detail = (False, "垫片不可用（跳过非空转自证）")
    if shim is not None:
        probe = subprocess.run(["python3", "-c",
                                "import socket;s=socket.socket();s.settimeout(3);"
                                "print(s.connect_ex(('1.1.1.1',80)))"],
                               capture_output=True, text=True, timeout=30,
                               env=offline_env(work / "probe-home", shim, attempt_log))
        lines = [line for line in attempt_log.read_text(encoding="utf-8").splitlines() if line.strip()]
        blocked_ok = probe.stdout.strip() not in ("0", "") and any("connect 1.1.1.1" in line for line in lines)
        blocked_detail = f"connect 到 1.1.1.1 返回 {probe.stdout.strip()}；留痕={lines[:1]}"

    home = work / f"empty-home-{port}"
    if home.exists():
        shutil.rmtree(home, ignore_errors=True)
    home.mkdir(parents=True, exist_ok=True)
    env = offline_env(home, shim, attempt_log)
    attempt_log.write_text("", encoding="utf-8")
    shutdown(port)
    rc_up, out_up, err_up = run_script(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"], env)
    payload_up = last_json(out_up)
    healthy = wait_health(port)
    page_ok = http_status(f"http://127.0.0.1:{port}/quotagent/") == 200
    home_files = [str(item.relative_to(home)) for item in home.rglob("*")] if home.exists() else ["<gone>"]
    attempts = [line for line in attempt_log.read_text(encoding="utf-8").splitlines() if line.strip()]
    try:
        check("R14a **空 HOME + 断网**下 `./run up` 成功：健康检查真 200 + URL 真可达（`HOME=<空目录>`、"
              "代理黑洞 env、垫片拦 libc 层对外连接/解析）",
              rc_up == 0 and payload_up.get("ok") is True and payload_up.get("healthy") is True
              and healthy and page_ok,
              f"rc={rc_up} healthy={healthy} page200={page_ok} 垫片={shim_note} err={err_up.strip()[-120:]}")
        check("R14b 断网判据**非空转自证**：垫片真的拦住了一次对外 connect（并在留痕里记下目标）——"
              "所以「up 期间零次非回环连接尝试」这句话有分量",
              blocked_ok, blocked_detail)
        check("R14c **不写 HOME**：`./run up` 之后空 HOME 里 0 个文件（运行期数据全在仓库 `tmp/` 内）",
              home_files == [], f"HOME={home} 内容={home_files[:5]}")
        check("R14d 断网运行的 up 期间**零次非回环连接尝试**（垫片留痕为空 ⇒ 启动路径不依赖外网）",
              attempts == [], f"留痕={attempts[:3]}（{len(attempts)} 条）")
        rc_st1, out_st1, _err = run_script(RUN, ["status", "--port", str(port)], env)
        payload_st1 = last_json(out_st1)
        rc_down, out_down, _err = run_script(RUN, ["down", "--port", str(port)], env)
        payload_down = last_json(out_down)
        released = http_status(f"http://127.0.0.1:{port}{PORT_HEALTH}") == 0
        check("R14e 断网运行的服务能停干净：`down` 退出码 0 + 端口**真释放**",
              rc_down == 0 and payload_down.get("stopped") is True and payload_down.get("released") is True
              and released,
              f"down_rc={rc_down} released={released} payload={json.dumps(payload_down, ensure_ascii=False)[:160]}")
        rc_up2, out_up2, _err = run_script(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"], env)
        payload_up2 = last_json(out_up2)
        healthy2 = wait_health(port)
        rc_up3, out_up3, _err = run_script(RUN, ["up", "--port", str(port), "--data-dir", data_dir, "--no-seed"], env)
        payload_up3 = last_json(out_up3)
        rc_st2, out_st2, _err = run_script(RUN, ["status", "--port", str(port)], env)
        rc_st3, out_st3, _err = run_script(RUN, ["status", "--port", str(port)], env)
        check("R14f 空 HOME + 断网下能重启，且**第二次 up 幂等**：`state=already-up`、pid 不变、"
              "两次 `status` 逐字节一致",
              rc_up2 == 0 and payload_up2.get("ok") is True and healthy2
              and rc_up3 == 0 and payload_up3.get("state") == "already-up"
              and payload_up3.get("pid") == payload_up2.get("pid")
              and rc_st2 == 0 and rc_st3 == 0 and out_st2 == out_st3,
              f"restart rc={rc_up2} pid={payload_up2.get('pid')} 二次 up={payload_up3.get('state')} "
              f"pid 不变={payload_up3.get('pid') == payload_up2.get('pid')} "
              f"status 一致={out_st2 == out_st3} | {out_st2.strip()[:140]}")
    finally:
        shutdown(port)


# ---------------------------------------------------------------------------------------------
# R11：`run` 的 8 处单点变异（4 处原有 + 4 处本批新增：logs / config init）
# ---------------------------------------------------------------------------------------------
MUTATIONS = [
    {"name": "变异1：去掉 up 的幂等判断（已健康也重启）",
     "find": '  if [ "$HEALTH" = "0" ]; then',
     "replace": '  if [ "$HEALTH" = "0" ] && [ "x" = "y" ]; then',
     "steps": [["up", "--no-seed"], ["up", "--no-seed"]],
     "must_red": lambda facts: not (facts["steps"][1]["payload"].get("state") == "already-up"
                                   and facts["steps"][1]["payload"].get("pid") == facts["steps"][0]["payload"].get("pid"))},
    {"name": "变异2：健康探针永不通过（up 起不来也报成功）",
     "find": '    [ "$_ph_code" = "200" ] && return 0',
     "replace": '    [ "$_ph_code" = "200" ] && return 1',
     "steps": [["up", "--no-seed"]],
     "must_red": lambda facts: not (facts["steps"][0]["rc"] == 0
                                    and facts["steps"][0]["payload"].get("ok") is True
                                    and facts["steps"][0]["payload"].get("healthy") is True)},
    {"name": "变异3：status 里的 ready_ms 改成墙钟（不再冻结）",
     "find": '    "$([ -n "$_ready" ] && printf \'%s\' "$_ready" || printf \'null\')" \\',
     "replace": '    "$(( $(date +%s) ))" \\',
     "steps": [["up", "--no-seed"], ["status"], ["sleep", "1.3"], ["status"]],
     "must_red": lambda facts: not (facts["steps"][1]["out"] == facts["steps"][2]["out"])},
    {"name": "变异4：status 读不到 pid（装载记录读面失效）",
     "find": "read_pid_file() { [ -f \"$PID_FILE\" ] && sed -n '1p' \"$PID_FILE\" 2>/dev/null || true; }",
     "replace": "read_pid_file() { true; }",
     "steps": [["up", "--no-seed"], ["status"]],
     "must_red": lambda facts: not (facts["steps"][1]["payload"].get("managed") is True
                                   and facts["steps"][1]["payload"].get("pid") == facts["steps"][0]["payload"].get("pid"))},
    # ---- 本批新增：logs / config init 的四处单点变异（同样：先在未变异基线上确认不红） ----
    {"name": "变异5：`logs` 的尾部不再有上界（--lines 100000 原样照做）",
     "find": '  [ "$_lines" -gt 200 ] && _lines=200',
     "replace": '  [ "$_lines" -gt 200 ] && _lines=$_lines',
     "steps": [["up", "--no-seed"], ["logs", "--lines", "100000"]],
     "must_red": lambda facts: not (facts["steps"][1]["payload"].get("tail_lines") == 200
                                   and facts["steps"][1]["payload"].get("max_lines") == 200)},
    {"name": "变异6：`logs` 没有日志文件也报成功（去掉诚实失败路径）",
     "find": '  if [ ! -f "$LOG_FILE" ]; then',
     "replace": '  if [ "x" = "y" ]; then',
     "steps": [["logs"]],
     "must_red": lambda facts: not (facts["steps"][0]["payload"].get("ok") is False
                                   and facts["steps"][0]["payload"].get("code") == "log-missing"
                                   and facts["steps"][0]["rc"] != 0)},
    {"name": "变异7：`config init` 覆盖已有真配置文件（去掉存在即拒）",
     "find": '  if [ -e "$_target" ]; then',
     "replace": '  if [ -e "$_target" ] && [ "x" = "y" ]; then',
     "steps": [["config", "init", "--config-file", "tmp/run-once-gate/{data_dir}/cfg-{run_id}.yaml"],
               ["config", "init", "--config-file", "tmp/run-once-gate/{data_dir}/cfg-{run_id}.yaml"]],
     "must_red": lambda facts: not (facts["steps"][0]["payload"].get("ok") is True
                                   and facts["steps"][1]["payload"].get("code") == "config-exists"
                                   and facts["steps"][1]["rc"] != 0)},
    {"name": "变异8：`config init` 生成的骨架里多出一个非白名单段",
     "find": "  printf 'plugins: {}\\n'",
     "replace": "  printf 'plugins: {}\\nextra_section: 1\\n'",
     "steps": [["config", "init", "--config-file", "tmp/run-once-gate/{data_dir}/cfg8-{run_id}.yaml"]],
     "watch_file": "tmp/run-once-gate/{data_dir}/cfg8-{run_id}.yaml",
     "must_red": lambda facts: not (facts["steps"][0]["payload"].get("ok") is True
                                   and set(top_level_keys(facts["watch"]["text"]))
                                   == {"apiVersion", "project", "plugins", "credentials"})},
]


def top_level_keys(text: str) -> list[str]:
    """YAML 里 0 缩进的键（用于断言"生成的文件只有白名单那几段"）。"""
    return [match.group(1) for match in re.finditer(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:", text or "", re.M)]


def run_steps(script: Path, port: int, steps: list[list[str]], data_dir: str,
              watch_file: str | None = None) -> dict:
    shutdown(port)
    facts = {"steps": [], "health_after": 0, "watch": {"text": "", "exists": False}}
    run_id = uuid.uuid4().hex[:8]        # 每次运行都换一个：`config init` 的目标路径必须"这次是全新的"
    for step in steps:
        if step[0] == "sleep":
            time.sleep(float(step[1]))
            continue
        # `{data_dir}` / `{run_id}` 让每次运行的配置目标都不一样（基线/变异体/重跑互不看见对方生成的文件）
        expanded = [str(item).replace("{data_dir}", data_dir).replace("{run_id}", run_id) for item in step]
        args = list(expanded) + ["--port", str(port)]
        if step[0] == "up":
            args += ["--data-dir", data_dir]
        rc, out, err = run_script(script, args)
        facts["steps"].append({"args": expanded, "rc": rc, "out": out, "err": err, "payload": last_json(out)})
    facts["health_after"] = http_status(f"http://127.0.0.1:{port}{PORT_HEALTH}")
    if watch_file:
        path = ROOT / str(watch_file).replace("{data_dir}", data_dir).replace("{run_id}", run_id)
        if path.exists():
            facts["watch"] = {"exists": True, "text": path.read_text(encoding="utf-8")}
    # 收摊：先按记录杀，再用**未变异的** run 收尾（保证门自己不留进程）
    for item in facts["steps"]:
        pid = item["payload"].get("pid")
        if isinstance(pid, int):
            kill_pid(str(pid))
    shutdown(port)
    return facts


def assert_mutations() -> None:
    original = RUN.read_text(encoding="utf-8")
    sha_before = hashlib.sha256(RUN.read_bytes()).hexdigest()
    baseline_ok = True
    notes = []
    work = Path(tempfile.mkdtemp(prefix="run-once-mut-", dir=str(ROOT / "tmp")))
    for index, mutation in enumerate(MUTATIONS, start=1):
        # ① 基线：同一序列在未变异脚本上**必须不红**
        base_script = work / f"base-{index}.sh"
        base_script.write_text(original, encoding="utf-8")
        base_port = free_port()
        base_facts = run_steps(base_script, base_port, mutation["steps"], f"tmp/run-once-gate/base{index}",
                               mutation.get("watch_file"))
        base_red = bool(mutation["must_red"](base_facts))
        notes.append(f"#{index} 基线红={base_red}")
        if base_red:
            baseline_ok = False
        # ② 变异体：同一序列必须变红（只改一处；锚点必须唯一）
        if original.count(mutation["find"]) != 1:
            check(f"R11-{index} 变异：{mutation['name']}", False,
                  f"假变异：锚点出现 {original.count(mutation['find'])} 次（必须恰好 1 次）")
            continue
        mutant_script = work / f"mutant-{index}.sh"
        mutant_script.write_text(original.replace(mutation["find"], mutation["replace"], 1), encoding="utf-8")
        mutant_port = free_port()
        facts = run_steps(mutant_script, mutant_port, mutation["steps"], f"tmp/run-once-gate/m{index}",
                          mutation.get("watch_file"))
        red = bool(mutation["must_red"](facts))
        detail = "; ".join(f"{item['args'][0]} rc={item['rc']} {json.dumps(item['payload'], ensure_ascii=False)[:80]}"
                           for item in facts["steps"])
        check(f"R11-{index} 变异：{mutation['name']}（必须让指定断言变红）", red,
              f"红={red} health_after={facts['health_after']} | {detail[:320]}")
    check("R11-0 基线（未变异）在同一序列上**不红**（否则四处变异变红都是空转）", baseline_ok, "；".join(notes))
    check("R11-5 全过程**产品树字节不变**（变异只写在 tmp/ 的副本里）",
          hashlib.sha256(RUN.read_bytes()).hexdigest() == sha_before,
          f"before={sha_before[:12]} after={hashlib.sha256(RUN.read_bytes()).hexdigest()[:12]}")
    shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    assert_doctor()
    assert_up_down_status()
    assert_credentials_do_not_block_up()
    assert_up_on_foreign_port()
    assert_logs()
    assert_config_init()
    assert_empty_home_offline()
    assert_mutations()
    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in RESULTS:
        print(f"{'[ok]  ' if ok else '[FAIL]'} {name}")
        if detail:
            print(f"        {detail}")
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（run-once 门 {len(RESULTS) - len(failed)}/{len(RESULTS)}）")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
