#!/usr/bin/env python3
"""检查「文档里写了的 AC」是否都有注册的断言（本仓曾出现 P0 标记的 AC 从未实现）。

规则：
- `docs/work/acceptance-criteria.md` 里 **phase 恰为 P0** 的 AC 必须已在 `qa list` 注册 → 否则退出码 1；
- P1/P2/P0-P1 等**尚未到期**的 AC 只报告（退出码 0），因为它们属于后续批次；
- 反向检查：注册的 AC 必须在文档里有行（防止"代码里有、文档里没有"）。

用法：tools/verify.sh ac-registry（或直接 python3 tools/check-ac-registry.py）
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs/work/acceptance-criteria.md"
ROW = re.compile(r"^\|\s*(AC-[A-Z]+-\d{3})\s*\|\s*([^|]+?)\s*\|", re.M)


def registered() -> set[str]:
    proc = subprocess.run([str(ROOT / "tools" / "run.sh"), "-m", "quotagent.qa", "list"],
                          capture_output=True, text=True, cwd=str(ROOT))
    if proc.returncode != 0:
        print(f"[FAIL] 无法读取 AC 注册表（退出码 {proc.returncode}）：{proc.stderr.strip()[:200]}", file=sys.stderr)
        raise SystemExit(2)
    data = json.loads(proc.stdout)
    items = data.get("acs") if isinstance(data, dict) else data
    return {item["ac"] for item in (items or [])}


def documented() -> dict[str, str]:
    rows = ROW.findall(DOC.read_text(encoding="utf-8"))
    return {ac: phase for ac, phase in rows}


def main() -> int:
    doc, reg = documented(), registered()
    missing_p0 = sorted(ac for ac, phase in doc.items() if phase == "P0" and ac not in reg)
    missing_later = sorted((ac, phase) for ac, phase in doc.items()
                           if phase != "P0" and ac not in reg)
    orphan = sorted(ac for ac in reg if ac not in doc)

    print(f"[ok]   文档 {len(doc)} 条 AC，注册表 {len(reg)} 条")
    if missing_later:
        print(f"[info] 尚未到期（P1/P2 等）未注册 {len(missing_later)} 条："
              + "、".join(f"{ac}({phase})" for ac, phase in missing_later[:8])
              + ("…" if len(missing_later) > 8 else ""))
    if orphan:
        print(f"[FAIL] 注册表里有、文档里没有：{orphan}", file=sys.stderr)
        return 1
    if missing_p0:
        print(f"[FAIL] P0 阶段 AC 未实现（文档有编号但无断言）：{missing_p0}", file=sys.stderr)
        return 1
    print("[ok]   P0 阶段的 AC 全部已注册（无「有编号无断言」）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
