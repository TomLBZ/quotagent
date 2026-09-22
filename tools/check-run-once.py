#!/usr/bin/env python3
"""run-once 门（`tools/verify.sh run-once`）—— 一键运行契约（QUOTAGENT-ONE-COMMAND v1）的真跑验收。

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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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


# ---------------------------------------------------------------------------------------------
# R11：`run` 的 4 处单点变异
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
]


def run_steps(script: Path, port: int, steps: list[list[str]], data_dir: str) -> dict:
    shutdown(port)
    facts = {"steps": [], "health_after": 0}
    for step in steps:
        if step[0] == "sleep":
            time.sleep(float(step[1]))
            continue
        args = list(step) + ["--port", str(port)]
        if step[0] == "up":
            args += ["--data-dir", data_dir]
        rc, out, err = run_script(script, args)
        facts["steps"].append({"args": step, "rc": rc, "out": out, "err": err, "payload": last_json(out)})
    facts["health_after"] = http_status(f"http://127.0.0.1:{port}{PORT_HEALTH}")
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
        base_facts = run_steps(base_script, base_port, mutation["steps"], f"tmp/run-once-gate/base{index}")
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
        facts = run_steps(mutant_script, mutant_port, mutation["steps"], f"tmp/run-once-gate/m{index}")
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
