#!/usr/bin/env python3
"""quotagent 文档门：ID 完整性、预算、覆盖、占位符。

只用标准库，可被任意 python3 (>=3.9) 直接运行；不写任何文件，只打印结果与退出码。
退出码: 0 全绿; 1 存在失败项。

预算不在此脚本硬编码，而是从 docs/design/12-documentation-standard.md §1 的表格解析，
避免两处真源漂移。

AC 定义集合（口径，唯一真源就在本脚本的 AC_MAIN / AC_ARCHIVE_GLOB 两个常量）：
  `docs/work/acceptance-criteria.md` **+ 同目录下所有 `acceptance-criteria-archive*.md`**。
归档只改变"定义可以放在哪个文件里"，不改变任何断言语义：ID 必须存在于集合内、
预算照查、FR↔AC 覆盖照查归档里的行（见 check_coverage）。归档**必须真的被读到**：
某个归档 0 条 AC 定义行即判失败，杜绝"两边都是空集合"式的静默通过。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN_SUFFIX = ".md"

# --- ID 定义源（一处一事实：每个 ID 前缀只有一个定义文件） --------------------
# 例外且仅此一处：AC 的"定义文件"是一组 —— 主文件 + 同目录下的全部归档。
AC_MAIN = "docs/work/acceptance-criteria.md"
AC_ARCHIVE_GLOB = "acceptance-criteria-archive*.md"
DEF_SOURCES = {
    "FR": "docs/work/functional-requirements.md",
    "V": "docs/work/functional-requirements.md",
    "AC": AC_MAIN,
    "T": "docs/work/progress-checklist.md",
    "INV": "docs/design/04-services-catalog.md",
    "NFR": "docs/design/10-nonfunctional.md",
}
ADR_DIR = "docs/design/adr"
EVIDENCE_DIR = "docs/work/evidence"

# 定义行：表格首列就是 ID
ROW_RE = re.compile(r"^\|\s*(?P<id>[A-Z]+-[A-Z0-9-]*\d)\s*\|", re.M)
ADR_RE = re.compile(r"^#\s+(ADR-\d{4})\b", re.M)
REF_RE = re.compile(r"\b(?:FR|AC|T|V|INV|NFR|ADR|EV)-[A-Z0-9]+(?:-[A-Z0-9]+)*\d\b")
PLACEHOLDER_RE = re.compile(r"\b(?:FR|AC|T|V|INV|NFR|ADR|EV)-[xX]+|\bTBD\b|\bTODO-ID\b")

BUDGET_ROW_RE = re.compile(r"^\|\s*`(?P<path>[^`]+)`\s*\|\s*(?P<num>\d+)\s*(?P<unit>B|KB)\s*\|", re.M)
DESIGN_PHASE_PREFIXES = ("AC-DESIGN-",)


class Report:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.lines: list[str] = []

    def ok(self, text: str) -> None:
        self.lines.append(f"[ok]   {text}")

    def fail(self, text: str, details: list[str] | None = None) -> None:
        self.failures.append(text)
        self.lines.append(f"[FAIL] {text}")
        for d in details or []:
            self.lines.append(f"       - {d}")


def md_files() -> list[Path]:
    files = [p for p in ROOT.rglob(f"*{SCAN_SUFFIX}") if ".git" not in p.parts]
    for extra in (ROOT / "AGENTS.md", ROOT / "README.md"):
        if extra.exists() and extra not in files:
            files.append(extra)
    return sorted(set(files))


def ac_definition_files() -> tuple[list[Path], list[Path]]:
    """AC 定义集合 = (全部文件, 其中的归档文件)。

    集合构成：主文件恒在首位，其后是与主文件同目录、名字匹配 AC_ARCHIVE_GLOB 的每个文件。
    调用方必须把归档真的读进来（read_text），并对"归档 0 条定义行"判失败 —— 见 collect_definitions。
    """
    main = ROOT / AC_MAIN
    archives = sorted(p for p in main.parent.glob(AC_ARCHIVE_GLOB) if p.is_file())
    return [main, *archives], archives


def ac_ids_in(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    return {m.group("id") for m in ROW_RE.finditer(text) if m.group("id").startswith("AC-")}


def collect_definitions(rep: Report) -> set[str]:
    defined: set[str] = set()
    ac_files, ac_archives = ac_definition_files()
    for prefix, rel in DEF_SOURCES.items():
        paths = ac_files if prefix == "AC" else [ROOT / rel]
        found: set[str] = set()
        per_file: dict[str, int] = {}
        for path in paths:
            if not path.exists():
                rep.fail(f"定义文件缺失: {rel}")
                continue
            ids = {m.group("id") for m in ROW_RE.finditer(path.read_text(encoding="utf-8"))
                   if m.group("id").startswith(prefix + "-")}
            per_file[str(path.relative_to(ROOT))] = len(ids)
            found |= ids
        if not found:
            rep.fail(f"{rel} 中未找到任何 {prefix}- 定义行")
        if prefix == "AC":
            # 可观察证据 + 硬断言：归档必须真被读到（0 条定义行 = 空读 = 失败），
            # 不许只靠"主文件与归档两边都是空集合"静默通过。
            arch_rels = [str(p.relative_to(ROOT)) for p in ac_archives]
            for relp in arch_rels:
                if per_file.get(relp, 0) == 0:
                    rep.fail(f"归档文件未被有效读取（0 条 AC- 定义行）: {relp}")
            archived = set().union(*(ac_ids_in(p) for p in ac_archives)) if ac_archives else set()
            rep.ok(f"AC 定义集合: 主文件 {AC_MAIN} 定义 {per_file.get(AC_MAIN, 0)} 条；"
                   f"archives=[{', '.join(f'{r}:{per_file.get(r, 0)}' for r in arch_rels)}]"
                   f"（归档文件共 {len(archived)} 条 AC 定义行，受同一套门校验）")
        defined |= found
    adr_dir = ROOT / ADR_DIR
    adr = {m.group(1) for p in sorted(adr_dir.glob("*.md"))
           for m in [ADR_RE.search(p.read_text(encoding="utf-8"))] if m}
    if not adr:
        rep.fail(f"{ADR_DIR} 中未找到 ADR 定义")
    defined |= adr
    ev_dir = ROOT / EVIDENCE_DIR
    ev = {m.group(0) for p in ev_dir.glob("EV-*") if (m := re.match(r"EV-\d+", p.name))}
    defined |= ev
    return defined


def check_ids(rep: Report, files: list[Path], defined: set[str]) -> None:
    unresolved: dict[str, set[str]] = {}
    refs = 0
    for path in files:
        text = path.read_text(encoding="utf-8")
        for token in REF_RE.findall(text):
            refs += 1
            if token in defined:
                continue
            if any(token.startswith(p) for p in DESIGN_PHASE_PREFIXES):
                continue
            unresolved.setdefault(token, set()).add(str(path.relative_to(ROOT)))
    if unresolved:
        rep.fail(f"未解析的 ID 引用 {len(unresolved)} 个（共 {refs} 处引用）",
                 [f"{k}  ← {', '.join(sorted(v))}" for k, v in sorted(unresolved.items())])
    else:
        rep.ok(f"ID 完整性: {len(defined)} 个定义，{refs} 处引用，0 未解析")


def check_placeholders(rep: Report, files: list[Path]) -> None:
    hits: list[str] = []
    for path in files:
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            m = PLACEHOLDER_RE.search(line)
            if m:
                hits.append(f"{path.relative_to(ROOT)}:{i}: {m.group(0)}")
    if hits:
        rep.fail(f"占位符 {len(hits)} 处", hits)
    else:
        rep.ok("占位符: 无")


def parse_budgets(rep: Report) -> dict[str, int]:
    path = ROOT / "docs/design/12-documentation-standard.md"
    text = path.read_text(encoding="utf-8")
    budgets: dict[str, int] = {}
    for m in BUDGET_ROW_RE.finditer(text):
        size = int(m.group("num")) * (1024 if m.group("unit") == "KB" else 1)
        budgets[m.group("path").strip()] = size
    if not budgets:
        rep.fail("未能从 docs/design/12-documentation-standard.md §1 解析出预算表")
    return budgets


def check_budgets(rep: Report, budgets: dict[str, int]) -> None:
    overs: list[str] = []
    checked = 0
    worst = (0.0, "")
    for pattern, limit in budgets.items():
        paths = sorted(ROOT.glob(pattern))
        for path in paths:
            if ".git" in path.parts or path.is_dir():
                continue
            rel = str(path.relative_to(ROOT))
            # 更具体的行（精确路径）优先于通配行
            specific = [v for k, v in budgets.items() if not any(c in k for c in "*?[") and k == rel]
            effective = min([limit] + specific)
            size = path.stat().st_size
            checked += 1
            ratio = size / effective
            if ratio > worst[0]:
                worst = (ratio, f"{rel} {size}/{effective} B")
            if size > effective:
                overs.append(f"{rel}: {size} > {effective} B (超 {size - effective} B)")
    if overs:
        rep.fail(f"预算超限 {len(overs)} 个文件", overs)
    else:
        rep.ok(f"预算: {checked} 个文件受检，最高占用 {worst[0]:.0%}（{worst[1]}）")


def check_coverage(rep: Report) -> None:
    fr_path = ROOT / "docs/work/functional-requirements.md"
    # AC 侧定义集合（主文件 + 归档）：归档不豁免覆盖检查 —— 搬进归档的 AC 行
    # 与它还在主文件时受完全相同的"无孤儿"断言约束（范围扩大，语义不变）。
    ac_files, ac_archives = ac_definition_files()
    ac_files = [p for p in ac_files if p.exists()]
    fr_rows = [l for l in fr_path.read_text(encoding="utf-8").splitlines()
               if l.startswith("| FR-")]
    ac_rows = [l for p in ac_files for l in p.read_text(encoding="utf-8").splitlines()
               if l.startswith("| AC-")]
    fr_ids = [m.group(1) for l in fr_rows
              for m in [re.match(r"\|\s*(FR-[A-Z0-9-]*\d+)", l)] if m]
    fr_referenced: set[str] = set()
    fr_without_ac: list[str] = []
    for line, fid in zip(fr_rows, fr_ids):
        acs = {t for t in REF_RE.findall(line) if t.startswith("AC-")}
        if not acs:
            fr_without_ac.append(fid)
        fr_referenced |= acs
    ac_ids = [m.group(1) for l in ac_rows
              for m in [re.match(r"\|\s*(AC-[A-Z0-9-]*\d+)", l)] if m]
    orphans = [a for a in ac_ids if a not in fr_referenced
               and not any(a.startswith(p) for p in DESIGN_PHASE_PREFIXES)]
    problems = []
    if fr_without_ac:
        problems.append("FR 未关联任何 AC: " + ", ".join(fr_without_ac))
    if orphans:
        problems.append("AC 未被任何 FR 引用: " + ", ".join(orphans))
    if problems:
        rep.fail("FR↔AC 覆盖", problems)
    else:
        rep.ok(f"FR↔AC 覆盖: {len(fr_ids)} 条 FR 均关联 AC，{len(ac_ids)} 条 AC 无孤儿"
               f"（AC 定义文件 {len(ac_files)} 个：主文件 + {len(ac_archives)} 个归档）")


def main() -> int:
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    rep = Report()
    files = md_files()
    defined = collect_definitions(rep)
    check_ids(rep, files, defined)
    check_placeholders(rep, files)
    check_budgets(rep, parse_budgets(rep))
    check_coverage(rep)
    print("== quotagent 文档门 (AC-DESIGN-001/002/003) ==")
    print(f"扫描 {len(files)} 个 markdown 文件，仓库根 {ROOT}")
    print("\n".join(rep.lines))
    print(f"RESULT: {'PASS' if not rep.failures else 'FAIL (' + str(len(rep.failures)) + ' 项)'}")
    if verbose and rep.failures:
        for line in rep.lines:
            if line.startswith("       - "):
                print(line)
    return 1 if rep.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
