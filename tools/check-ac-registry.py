#!/usr/bin/env python3
"""检查「文档里写了的 AC」是否都有注册的断言（本仓曾出现 P0 标记的 AC 从未实现）。

AC 定义集合（口径，唯一真源在本脚本的 AC_MAIN / AC_ARCHIVE_GLOB 两个常量）：
  `docs/work/acceptance-criteria.md` **+ 同目录下所有 `acceptance-criteria-archive*.md`**。
归档只改变"行写在哪个文件里"，**不改变任何断言语义**：P0 行搬进归档后仍然必须已注册。

规则：
- AC 定义集合里 **phase 恰为 P0** 的 AC 必须已在 `qa list` 注册 → 否则退出码 1；
- P1/P2/P0-P1 等**尚未到期**的 AC 只报告（退出码 0），因为它们属于后续批次；
- 反向检查：注册的 AC 必须在定义集合里有行（防止"代码里有、文档里没有"）；
- 空读守卫：归档文件必须真被读到（0 条 AC 行 = 失败），P0 集合为空也判失败 ——
  不许"没跑到"或"两边都是空集合"被当成绿灯。

用法：tools/verify.sh ac-registry（或直接 python3 tools/check-ac-registry.py）
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AC_MAIN = ROOT / "docs/work/acceptance-criteria.md"
AC_ARCHIVE_GLOB = "acceptance-criteria-archive*.md"
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


def ac_docs() -> tuple[list[Path], list[Path]]:
    """AC 定义文件集合 = (全部文件, 其中的归档文件)；主文件恒在首位。"""
    archives = sorted(p for p in AC_MAIN.parent.glob(AC_ARCHIVE_GLOB) if p.is_file())
    return [AC_MAIN, *archives], archives


def documented() -> dict[str, str]:
    docs, archives = ac_docs()
    rows: dict[str, str] = {}
    counts: dict[str, int] = {}
    for path in docs:
        rel = str(path.relative_to(ROOT))
        if not path.exists():
            print(f"[FAIL] 定义文件缺失: {rel}", file=sys.stderr)
            raise SystemExit(1)
        found = ROW.findall(path.read_text(encoding="utf-8"))
        counts[rel] = len(found)
        for ac, phase in found:
            rows.setdefault(ac, phase)
    # 归档必须真被读到：某个归档 0 条 AC 行 = 空读 = 失败（不许静默通过）
    arch_rels = [str(p.relative_to(ROOT)) for p in archives]
    empty = [r for r in arch_rels if counts.get(r, 0) == 0]
    if empty:
        print(f"[FAIL] 归档文件未被有效读取（0 条 AC 行）：{empty}", file=sys.stderr)
        raise SystemExit(1)
    arch_rows = sum(counts[r] for r in arch_rels)
    print(f"[ok]   定义文件 {len(docs)} 个（主文件 1 + archives=["
          + ", ".join(f"{r}:{counts[r]}" for r in arch_rels) + f"]，归档共 {arch_rows} 条 AC 行）")
    return rows


def main() -> int:
    doc, reg = documented(), registered()
    p0_rows = sorted(ac for ac, phase in doc.items() if phase == "P0")
    missing_p0 = sorted(ac for ac in p0_rows if ac not in reg)
    missing_later = sorted((ac, phase) for ac, phase in doc.items()
                           if phase != "P0" and ac not in reg)
    orphan = sorted(ac for ac in reg if ac not in doc)

    print(f"[ok]   定义集合 {len(doc)} 条 AC（其中 P0 {len(p0_rows)} 条），注册表 {len(reg)} 条")
    if missing_later:
        print(f"[info] 尚未到期（P1/P2 等）未注册 {len(missing_later)} 条："
              + "、".join(f"{ac}({phase})" for ac, phase in missing_later[:8])
              + ("…" if len(missing_later) > 8 else ""))
    if orphan:
        print(f"[FAIL] 注册表里有、定义集合里没有：{orphan}", file=sys.stderr)
        return 1
    if not p0_rows:
        print("[FAIL] 定义集合里 0 条 P0 AC（集合异常）：拒绝给出假的绿灯", file=sys.stderr)
        return 1
    if missing_p0:
        print(f"[FAIL] P0 阶段 AC 未实现（文档有编号但无断言）：{missing_p0}", file=sys.stderr)
        return 1
    print("[ok]   P0 阶段的 AC 全部已注册（无「有编号无断言」；P0 行落在主文件或归档都照查）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
