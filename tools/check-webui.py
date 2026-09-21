#!/usr/bin/env python3
"""WebUI 门：驱动 `host/webui.mjs`（cordis 插件 webui 的 HTTP 级检查）并逐条报出断言。

门统一走 `tools/verify.sh`；退出码 0 全通过 / 1 有断言失败 / 2 环境错误（与其它门同形）。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def node_bin() -> str:
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        return str(candidate)
    raise SystemExit("webui 门：未找到 node")


def main() -> int:
    proc = subprocess.run([node_bin(), str(ROOT / "host" / "webui.mjs")],
                          cwd=str(ROOT / "host"), capture_output=True, text=True, timeout=900)
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write((proc.stderr or "")[-2000:])
        return 2
    for item in report["checks"]:
        print(f"{'[ok]  ' if item['ok'] else '[FAIL]'} {item['name']}")
        if item["detail"]:
            print(f"        {item['detail']}")
    failed = [item for item in report["checks"] if not item["ok"]]
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（webui 门 "
          f"{len(report['checks']) - len(failed)}/{len(report['checks'])}）")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
