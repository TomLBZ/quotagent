#!/usr/bin/env python3
"""文档声明的事件 ↔ 事件表（`kernel/events.py`）的一致性机检（T-213）。

动机：事件名漂移不报错——文档写 `award/confirm-requested`、代码写 `award/commit-requested`，
两侧各自"看起来对"，直到有人按文档写代码才发现。此检查把两侧钉在一起：

1. `docs/design/05-events.md` 表格首列声明的事件名，必须在 `kernel/events.py` 的表里存在；
2. 反向：事件表里的事件也必须在文档里出现（避免"代码里有、规格里无"的暗接口）；
3. 模式（`emit`/`serial`/`bail`/`parallel`/`waterfall`）与文档声明必须一致。

退出码：0 = 一致；1 = 有漂移（逐条列出）；2 = 环境/解析错误（不得当作通过）。
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVENTS_DOC = ROOT / "docs/design/05-events.md"
EVENTS_MODULE = ROOT / "src/quotagent/kernel/events.py"

MODES = ("emit", "serial", "bail", "parallel", "waterfall")
PLANNED_MARK = "规划中"  # 文档里标了"规划中"的事件允许尚未登记（阶段未到），但一旦登记，模式必须一致
PLANNED_MARK = "规划中"  # 文档里标了"规划中"的事件允许尚未登记（阶段未到），但一旦登记，模式必须一致
NAME_RE = re.compile(r"\|\s*(?:`↳[^`]*`\s*\|)?\s*((?:`[a-z][a-z0-9-]*/[a-z0-9./-]+`\s*(?:[/、]\s*`[a-z][a-z0-9-]*/[a-z0-9./-]+`)*))")


PLANNED: set[str] = set()


def doc_events() -> dict[str, str]:
    """从 05-events.md 的表格里取出 事件名 → 模式（标了「规划中」的记入 PLANNED）。"""
    declared: dict[str, str] = {}
    planned: set[str] = PLANNED
    for line in EVENTS_DOC.read_text(encoding="utf-8").splitlines():
        if not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        raw_names, mode = cells[0], cells[1].strip("`").strip()
        names = re.findall(r"`([a-z][a-z0-9-]*/[a-z0-9./-]+)`", raw_names)
        if not names or mode not in MODES:
            continue
        note = cells[-1] if len(cells) > 3 else ""
        for name in names:
            declared[name] = mode
            if PLANNED_MARK in note:
                planned.add(name)
    return declared


def code_events() -> dict[str, str]:
    tree = ast.parse(EVENTS_MODULE.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                    continue
                if "/" not in key.value or not isinstance(value, ast.Tuple) or not value.elts:
                    continue
                mode = value.elts[0]
                if isinstance(mode, ast.Constant) and mode.value in MODES:
                    out[key.value] = mode.value
    return out


def main() -> int:
    if not EVENTS_DOC.exists() or not EVENTS_MODULE.exists():
        print(f"[FAIL] 找不到 {EVENTS_DOC} 或 {EVENTS_MODULE}")
        return 2
    doc, code = doc_events(), code_events()
    if not doc or not code:
        print(f"[FAIL] 解析结果为空（doc={len(doc)} code={len(code)}）——不得当作通过")
        return 2
    problems: list[str] = []
    for name in sorted(set(doc) - set(code)):
        if name in PLANNED:
            print(f"[ok]   规划中（阶段未到，允许未登记）: {name}")
            continue
        problems.append(f"文档声明但事件表没有: {name}（模式 {doc[name]}）"
                        f" —— 若确为后续阶段，请在说明列标注「规划中」")
    for name in sorted(set(code) - set(doc)):
        problems.append(f"事件表有但文档未声明: {name}（模式 {code[name]}）")
    for name in sorted(set(doc) & set(code)):
        if doc[name] != code[name]:
            problems.append(f"模式不一致: {name}（文档 {doc[name]} vs 事件表 {code[name]}）")
    print(f"事件: 文档声明 {len(doc)} 条，事件表登记 {len(code)} 条，取交集 {len(set(doc) & set(code))} 条")
    if problems:
        print(f"[FAIL] 漂移 {len(problems)} 处")
        for item in problems:
            print(f"       - {item}")
        return 1
    print("[ok]   文档与事件表完全一致（名称与模式）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
