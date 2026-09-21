#!/usr/bin/env python3
"""把 quotagent WebUI 接入**现有工作区 dashboard**（幂等；可在任意 fresh mount 上重跑）。

做三件事：

1. 在 `/workspace/services/services.json` 里登记服务 `quotagent`
   （脚本 `projects/quotagent/tools/webui-serve.py`、端口 8093、健康路径 `/api/health`）；
2. 在 `gateway.routes` 里加一条**代理路由** `/quotagent` → 该服务
   （不剥前缀：UI 自己按 `/quotagent/...` 暴露承包商/供应商两个子路由）；
3. 调 `bin/ws-gateway` 启停服务并**回读**健康路径与 dashboard 的路由表 —— 不是"写完就说成功"。

用法：`python3 tools/ws-integrate.py [--port 8093] [--prefix /quotagent] [--no-restart]`
退出码：0 = 接入且回读通过；2 = 回读失败（附原因）。
"""
from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WS = Path("/workspace")
SERVICES = WS / "services" / "services.json"
GATEWAY = WS / "bin" / "ws-gateway"
SERVICE_NAME = "quotagent"
HEALTH_PATH = "/api/health"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def http_get(url: str, timeout: float = 5.0) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (本机回环)
            return resp.status, resp.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}"


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def main(argv: list[str]) -> int:
    port = int(argv[argv.index("--port") + 1]) if "--port" in argv else 8093
    prefix = argv[argv.index("--prefix") + 1] if "--prefix" in argv else "/quotagent"
    restart = "--no-restart" not in argv

    manifest = load(SERVICES)
    changed: list[str] = []
    # 约定（见 services.json 的 `_map`）：**服务 = 顶层键**（与 gateway/dashboard 同级），
    # 路由表在 gateway.routes 里；`_` 开头的键是注释。
    entry = manifest.get(SERVICE_NAME) or {}
    desired = {
        "script": "projects/quotagent/tools/webui-serve.py",
        "port": port,
        "health": HEALTH_PATH,
        "log": "logs/quotagent.log",
        "settings": {"route_prefix": prefix, "views": ["contractor", "supplier"],
                     "note": "quotagent 双方视角 WebUI（cordis 插件 webui；每方视角读自己的账本）"},
    }
    if entry != desired:
        manifest[SERVICE_NAME] = desired
        changed.append(f"{SERVICE_NAME}（服务条目）")

    routes = manifest.setdefault("gateway", {}).setdefault("routes", [])
    if not any(item.get("prefix") == prefix for item in routes):
        routes.append({"prefix": prefix, "type": "proxy", "service": SERVICE_NAME,
                       "note": "quotagent 双方视角（承包商 / 供应商）"})
        changed.append(f"gateway.routes{prefix}")

    if changed:
        shutil.copy2(SERVICES, SERVICES.with_suffix(".json.bak"))
        SERVICES.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"[ws-integrate] 已登记：{', '.join(changed)}（备份 services.json.bak）")
    else:
        print("[ws-integrate] 清单已登记（幂等，无改动）")

    if restart:
        for action in ("stop", "start"):
            done = subprocess.run([str(GATEWAY), action, SERVICE_NAME], capture_output=True, text=True)
            print(f"[ws-integrate] ws-gateway {action} {SERVICE_NAME}: rc={done.returncode} "
                  f"{(done.stderr or done.stdout).strip()[:120]}")
            if action == "start":
                time.sleep(3)

    # --- 回读（唯一判据）---
    code, body = http_get(f"http://127.0.0.1:{port}{prefix}{HEALTH_PATH}")
    direct_ok = code == 200 and '"ok"' in body
    code_gw, body_gw = http_get(f"http://127.0.0.1:80{prefix}{HEALTH_PATH}")
    via_gateway = code_gw == 200 and '"ok"' in body_gw
    st_code, st_body = http_get("http://127.0.0.1:80/api/status")
    route_listed = prefix in st_body
    print(f"[ws-integrate] 直连 :{port} → {code}；经网关 :80 → {code_gw}；"
          f"dashboard 路由表包含 {prefix} = {route_listed}（/api/status {st_code}）")
    for view in ("contractor", "supplier"):
        v_code, v_body = http_get(f"http://127.0.0.1:80{prefix}/{view}/")
        print(f"[ws-integrate] 经网关 {prefix}/{view}/ → {v_code} {len(v_body)} B")
    if direct_ok and via_gateway and route_listed:
        print("[ws-integrate] PASS：quotagent UI 已可从现有 dashboard 访问")
        return 0
    print("[ws-integrate] FAIL：回读未通过（见上）", file=sys.stderr)
    print(f"[ws-integrate] 诊断：端口 {port} 可连={port_open(port)}；网关直连 status={st_code}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
