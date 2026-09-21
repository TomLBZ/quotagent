#!/usr/bin/env python3
"""工作区服务入口：quotagent WebUI（由 `ws-gateway` 以 `$PY <本脚本>` 拉起）。

为什么是个 Python 包装：工作区清单（`services/services.json`）只把 `script` 交给工作区 Python 运行，
而 WebUI 本身是 **cordis 插件**（Node）。所以这里只做两件事：

1. `--healthz PORT`：按工作区服务契约探测本服务的健康路径（退出 0/1，供 `ws-gateway` 保活）；
2. 否则：exec 掉 `node host/cli.mjs webui`（**不留中间进程**），把 UI 跑起来。

默认值可被环境变量覆盖（`QUOTAGENT_WEBUI_PORT` / `QUOTAGENT_UI_LEDGER_CONTRACTOR` /
`QUOTAGENT_UI_LEDGER_SUPPLIER`），以便同一份脚本在不同机器上只改清单不改编码。
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEALTH_PATH = "/api/health"


def node_bin() -> str:
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        return str(candidate)
    raise SystemExit("quotagent webui: 未找到 node（宿主层需要 Node；纯内核不需要）")


def probe(port: int, path: str = HEALTH_PATH, timeout: float = 3.0) -> int:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout) as sock:
            sock.sendall(f"GET {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode())
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
        head = data.split(b"\r\n", 1)[0]
        return 0 if b" 200 " in head else 1
    except OSError:
        return 1


def main(argv: list[str]) -> int:
    if "--healthz" in argv:
        return probe(int(argv[argv.index("--healthz") + 1]))
    port = os.environ.get("QUOTAGENT_WEBUI_PORT", "8093")
    # 先跑一遍走查（keep-shared）产生**真实**两侧账本，UI 展示的就是 g1 MVP 门产出的数据。
    # 走查失败**不阻塞** UI 启动（账本缺失时 UI 会自报 unhealthy），但原因写进日志。
    if os.environ.get("QUOTAGENT_WEBUI_SEED", "1") == "1":
        seeded = subprocess.run([sys.executable, str(ROOT / "tools" / "g1-walkthrough.py"), "--keep-shared"],
                                cwd=str(ROOT), capture_output=True, text=True, timeout=300)
        print(f"[webui-serve] 走查 seed rc={seeded.returncode} "
              f"{(seeded.stdout or '').strip().splitlines()[-1][:120] if seeded.stdout.strip() else ''}",
              file=sys.stderr, flush=True)
    args = [node_bin(), str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
            "--host", os.environ.get("QUOTAGENT_WEBUI_HOST", "127.0.0.1"),
            "--prefix", os.environ.get("QUOTAGENT_WEBUI_PREFIX", "/quotagent"),
            "--ledger-contractor", os.environ.get(
                "QUOTAGENT_UI_LEDGER_CONTRACTOR", str(ROOT / "tmp" / "g1-shared" / "contractor" / "ledger.jsonl")),
            "--ledger-supplier", os.environ.get(
                "QUOTAGENT_UI_LEDGER_SUPPLIER", str(ROOT / "tmp" / "g1-shared" / "supplier" / "ledger.jsonl"))]
    os.execv(args[0], args)  # 不留中间进程（工作区服务模型要求脚本自身就是服务）
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
