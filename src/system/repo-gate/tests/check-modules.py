#!/usr/bin/env python3
"""模块 manifest + fixture A1..A6 的 Python runner（评审 C §7.1 第 5 条：**由 Python runner 驱动取证**）。

做三件事：
1. 用 `tools/export-events.py` 把**事件表**（真源在 Python 侧）导出成 JSON；
2. 用 `host/check-modules.mjs` 在 Node 侧跑 manifest 形状与 A1..A6（每条含负控）；
3. 打成与 `qa` 同形的报告（逐条 [ok]/[FAIL] + 汇总），并把报告写入 `tmp/`（便于取证）。

退出码：0 = 全部通过；1 = 有失败；2 = 环境/用法错误（不得当作通过）。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def resolve_node() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        return str(candidate)
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="check-modules", description="模块 manifest 与 fixture A1..A6 检查")
    parser.add_argument("--report", default=str(ROOT / "tmp" / "modules-report.json"))
    args = parser.parse_args(argv)

    node = resolve_node()
    if node is None:
        print("[FAIL] 未找到 node：模块 fixture 需要在 Node 侧跑（不得当作通过）", file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="quotagent-modules-"))
    events_path = work / "events.json"
    export = subprocess.run([sys.executable, str(ROOT / "tools" / "export-events.py"), "--out", str(events_path)],
                            cwd=str(ROOT), capture_output=True, text=True, timeout=120,
                            env={**dict(__import__("os").environ), "PYTHONPATH": str(ROOT / "src")})
    if export.returncode != 0:
        print(f"[FAIL] 事件表导出失败（rc={export.returncode}）：{export.stderr.strip()[-200:]}", file=sys.stderr)
        return 2
    events = json.loads(export.stdout.strip().splitlines()[-1])

    run = subprocess.run([node, str(ROOT / "host" / "check-modules.mjs"), "--events", str(events_path)],
                         cwd=str(ROOT / "host"), capture_output=True, text=True, timeout=600)
    try:
        report = json.loads(run.stdout)
    except json.JSONDecodeError:
        print(f"[FAIL] 宿主检查无有效输出（rc={run.returncode}）：{run.stderr.strip()[-300:]}", file=sys.stderr)
        return 2

    report["events_exported"] = events["count"]
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for item in report["checks"]:
        print(f"[{'ok' if item['ok'] else 'FAIL'}] {item['module']} · {item['fixture']} — {item['name']}")
        if item.get("detail"):
            print(f"        {item['detail']}")
    print("-" * 72)
    print(f"模块：{len(report['modules'])} 个（{', '.join(report['modules'])}）；"
          f"事件表 {events['count']} 条（真源：Python 侧）")
    print(f"fixture 断言：{report['passed']}/{report['total']} 通过；报告落 {args.report}")
    shutil.rmtree(work, ignore_errors=True)
    failed = report["total"] - report["passed"]
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
