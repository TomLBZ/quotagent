#!/usr/bin/env python3
"""canary 门：驱动 `host/canary.mjs`（分流与自动回滚判定）并逐条报出断言。

门统一走 `tools/verify.sh`；退出码 0 全通过 / 1 有断言失败 / 2 环境错误。
依赖经 `tools/cordis.sh install` 自愈（干净副本里 `node_modules` 不存在是正常的）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    subprocess.run([str(ROOT / "tools" / "cordis.sh"), "install"], cwd=str(ROOT),
                   capture_output=True, text=True, timeout=1800)
    proc = subprocess.run([str(ROOT / "tools" / "cordis.sh"), "run", "canary.mjs"],
                          cwd=str(ROOT), capture_output=True, text=True, timeout=900)
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
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（canary 门 {len(report['checks']) - len(failed)}/{len(report['checks'])}）")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
