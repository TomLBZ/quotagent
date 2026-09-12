"""设计期 AC：直接驱动文档门 `tools/check-docs.py`（AC-DESIGN-001/002/003）。

门是纯标准库的只读脚本；本模块只在一次进程内跑一次门并复用输出。
"""

from __future__ import annotations

import subprocess
import sys

from ..paths import repo_root
from .registry import Assertion, register

_CACHE: dict[str, tuple[int, str]] = {}


def gate_output() -> tuple[int, str]:
    """运行文档门，返回 (退出码, 原始输出)。"""
    if not _CACHE:
        root = repo_root()
        proc = subprocess.run([sys.executable, str(root / "tools" / "check-docs.py")],
                              cwd=str(root), capture_output=True, text=True)
        output = (proc.stdout or "") + (proc.stderr or "")
        _CACHE["gate"] = (proc.returncode, output)
    return _CACHE["gate"]


def _fail_lines(output: str) -> str:
    lines = [l for l in output.splitlines() if l.startswith("[FAIL]") or l.startswith("       - ")]
    return " / ".join(lines[:6])


def _check(needle: str) -> Assertion:
    code, output = gate_output()
    ok = code == 0 and any(line.startswith(f"[ok]   {needle}") for line in output.splitlines())
    detail = "" if ok else f"门退出码={code}；相关行: {_fail_lines(output) or '缺失'}"
    return Assertion(name=f"文档门 {needle} 通过", ok=ok, detail=detail)


@register("AC-DESIGN-001", "设计期", "ID 引用完整、无占位符",
          "tools/verify.sh docs", evidence_refs=("EV-004",))
def ac_design_001() -> list[Assertion]:
    code, output = gate_output()
    integrity = [l for l in output.splitlines() if l.startswith("[ok]   ID 完整性")]
    placeholders = [l for l in output.splitlines() if l.startswith("[ok]   占位符")]
    integrity_ok = bool(integrity) and "0 未解析" in integrity[0]
    return [
        Assertion("文档门退出码为 0", code == 0, f"exit={code}"),
        Assertion("所有 ID 引用均可解析", integrity_ok,
                  "" if integrity_ok else (integrity[0] if integrity else _fail_lines(output))),
        Assertion("无占位符 ID", bool(placeholders), "" if placeholders else _fail_lines(output)),
    ]


@register("AC-DESIGN-002", "设计期", "所有受预算约束的文件不超预算",
          "tools/verify.sh docs", evidence_refs=("EV-004",))
def ac_design_002() -> list[Assertion]:
    code, output = gate_output()
    budget = [l for l in output.splitlines() if l.startswith("[ok]   预算")]
    return [
        Assertion("文档门退出码为 0", code == 0, f"exit={code}"),
        Assertion("预算检查通过且给出最高占用", bool(budget),
                  "" if budget else _fail_lines(output)),
    ]


@register("AC-DESIGN-003", "设计期", "FR↔AC 双向无孤儿",
          "tools/verify.sh docs", evidence_refs=("EV-004",))
def ac_design_003() -> list[Assertion]:
    code, output = gate_output()
    coverage = [l for l in output.splitlines() if l.startswith("[ok]   FR↔AC 覆盖")]
    ok = code == 0 and bool(coverage) and "无孤儿" in coverage[0] and "均关联 AC" in coverage[0]
    return [
        Assertion("文档门退出码为 0", code == 0, f"exit={code}"),
        Assertion("FR 均关联 AC 且无孤儿 AC", ok, "" if ok else (coverage[0] if coverage else _fail_lines(output))),
    ]
