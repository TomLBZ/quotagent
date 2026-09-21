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
    # 走 tools/cordis.sh run：它会先确保 host 依赖（干净副本里 node_modules 不存在是正常的，
    # 门必须能自己把它装回来，否则 fresh clone 上"门红"会把环境问题当成代码问题）
    proc = subprocess.run([str(ROOT / "tools" / "cordis.sh"), "run", "webui.mjs"],
                          cwd=str(ROOT), capture_output=True, text=True, timeout=1800)
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
