#!/usr/bin/env python3
"""quotagent 文档门：ID 完整性、预算、覆盖、占位符。

只用标准库，可被任意 python3 (>=3.9) 直接运行；不写任何文件，只打印结果与退出码。
退出码: 0 全绿; 1 存在失败项。

预算不在此脚本硬编码，而是从 docs/design/12-documentation-standard.md §1 的表格解析，
避免两处真源漂移。

定义文件集合（口径，唯一真源就在本脚本的 AC_MAIN / AC_ARCHIVE_GLOB、FR_MAIN / FR_ARCHIVE_GLOB、
T_MAIN / T_ARCHIVE_GLOB 与 HANDOVER_MAIN / HANDOVER_ARCHIVE_GLOB）：
  AC：`docs/work/acceptance-criteria.md` **+ 同目录下所有 `acceptance-criteria-archive*.md`**；
  FR：`docs/work/functional-requirements.md` **+ 同目录下所有 `functional-requirements-archive*.md`**；
  T ：`docs/work/progress-checklist.md` **+ 同目录下所有 `progress-checklist-archive*.md`**；
  交接：`docs/work/handover.md` **+ 同目录下所有 `handover-archive*.md`**（本批新增的第一个**指针型**集合：
       主文件受 1024 B 预算约束，细节搬进归档；断言落在"细节不许搬丢"—— 主文件里的每个 `§N` 指针
       必须在归档里有**对应小节且小节非空**，见 check_handover_set）。
归档只改变"定义可以放在哪个文件里"，不改变任何断言语义：ID 必须存在于集合内、
预算照查、FR↔AC 覆盖照查两个集合里的行（见 check_coverage）。归档**必须真的被读到**：
某个归档 0 条 FR 定义行（或 0 条 AC / T 定义行）即判失败，杜绝"两边都是空集合"式的静默通过。
注意 V 不走集合：`V-` 行只认主文件 `docs/work/functional-requirements.md` §1（口径比 FR 更窄）。
同一套集合口径也被 `tools/verify.sh coverage`（`docs/design/15-requirements-coverage.md` +
`15-requirements-coverage-archive*.md`）与 `tools/verify.sh plugins`
（`docs/design/14-plugin-inventory.md` + `14-plugin-inventory-archive*.md`）使用。

扫描范围（D-072，承接 D-071 第 3 条"判据不得覆盖无关写入者"）：
  门只扫**契约文档** = 仓库内 `.md`，但排除 `.git/ .venv/ tmp/ node_modules/ __pycache__/` 下的
  临时/派生文件。理由（量出来的，见 EV-151 §三 / EV-152）：旧口径 `ROOT.rglob("*.md")` 把 `tmp/**`
  的 166/267 个 .md 也算成判据，而别的门（`qa ac AC-RUNTIME-001` 的整树副本 `tmp/ac/<rand>/clean/`、
  `clean-copy` 的 `tmp/clean-copy/`）会在本门的扫描窗口里创建/删除这些文件 → 本门 `read_text` 抛
  FileNotFoundError → 本门红（实证 16 次里 2 次；高频并发下 11/12 次）→ 内嵌跑 `AC-DESIGN-002` 的
  `AC-RUNTIME-002` 也随之红。**这就是"判据覆盖了无关写入者"**：临时副本不是契约文档，且
  AC-RUNTIME-001 自己的"干净副本"口径（`checks_runtime.py` 的 IGNORE_DIRS）本来就排除它们。
  因此修法是**收窄扫描范围**（把临时/派生目录移出判据），**不是**"读不到就跳过"——那等于把消失的
  契约文档当成通过。契约文档在读窗口里消失**仍然判红**，见 read_md：崩溃换成指名道姓的失败，
  退出码仍是 1（既不静默跳过，也不丢证据）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SCAN_SUFFIX = ".md"

# --- 扫描范围（D-072）：排除的是**临时/派生目录**，不是契约文档 ------------------
# 口径与 AC-RUNTIME-001 的"干净副本"（checks_runtime.py 的 IGNORE_DIRS）一致：
# 契约文档 = 全仓 .md 减去下列目录下的文件。按**相对仓库根的路径分量**判定（不是绝对路径），
# 这样"仓库本身正好位于 /tmp 或 node_modules 下"也不会被误排除。
SCAN_EXCLUDE_DIRS = frozenset({".git", ".venv", "tmp", "node_modules", "__pycache__"})

# --- ID 定义源（一处一事实：每个 ID 前缀只有一个定义文件） --------------------
# 例外有三且仅此三处：AC、FR 与 T 的"定义文件"各是**一组** —— 主文件 + 同目录下的全部归档。
# 归档是**集合内的合法定义处**，不是豁免区：归档里的行受同一套断言（ID 完整性、预算、
# FR↔AC 无孤儿），且"归档 0 条定义行"是硬失败（见 collect_definitions）。
# T 的归档（D-073 批次新增）口径与 FR/AC 完全一致：搬进归档的 T 号仍是**定义**（引用照解析），
# 只是行不在主文件里 —— 这样进度清单可以按"最老的行先搬"腾预算，而不会制造"消失的 ID"。
AC_MAIN = "docs/work/acceptance-criteria.md"
AC_ARCHIVE_GLOB = "acceptance-criteria-archive*.md"
FR_MAIN = "docs/work/functional-requirements.md"
FR_ARCHIVE_GLOB = "functional-requirements-archive*.md"
T_MAIN = "docs/work/progress-checklist.md"
T_ARCHIVE_GLOB = "progress-checklist-archive*.md"
DEF_SETS: dict[str, tuple[str, str]] = {          # 前缀 -> (主文件, 同目录归档 glob)
    "FR": (FR_MAIN, FR_ARCHIVE_GLOB),
    "AC": (AC_MAIN, AC_ARCHIVE_GLOB),
    "T": (T_MAIN, T_ARCHIVE_GLOB),
}
# 单文件定义源：其余每个前缀只有一个文件。V **不**随 FR 扩到归档集合（口径更窄，不放宽）：
# `V-` 行只认主文件 §1 的验证清单。
DEF_SOURCES = {
    "V": FR_MAIN,
    "INV": "docs/design/04-services-catalog.md",
    "NFR": "docs/design/10-nonfunctional.md",
}
# 集合前缀的可观察输出口径（AC 的字符串与 D-072/EV-149 记录逐字一致，只是多了一份 FR）
SET_LABELS = {
    "FR": ("FR 定义集合", "fr_archives", "FR 定义行"),
    "AC": ("AC 定义集合", "archives", "AC 定义行"),
    "T": ("T 定义集合", "t_archives", "T 定义行"),
}
ADR_DIR = "docs/design/adr"
EVIDENCE_DIR = "docs/work/evidence"

# --- 交接文档集合（本批新增）：`docs/work/handover.md` 的预算是 **1024 B**（§1），逐批细节写在主文件里
# 立刻超预算 ⇒ 细节按同一套归档机制搬进同目录 `handover-archive*.md`。判据落在"细节不许消失"上：
# 主文件里的每个 `§N` 指针必须在归档里有**对应小节且小节非空**（抽掉小节的标题行 ⇒ 本节必红）。
HANDOVER_MAIN = "docs/work/handover.md"
HANDOVER_ARCHIVE_GLOB = "handover-archive*.md"
HANDOVER_POINTER_RE = re.compile(r"§\s*(\d+)")

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
        self.reads_ok = 0
        self.unreadable: list[str] = []

    def ok(self, text: str) -> None:
        self.lines.append(f"[ok]   {text}")

    def fail(self, text: str, details: list[str] | None = None) -> None:
        self.failures.append(text)
        self.lines.append(f"[FAIL] {text}")
        for d in details or []:
            self.lines.append(f"       - {d}")


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_absolute() else str(path)


def excluded(path: Path) -> bool:
    """是否落在临时/派生目录里（按相对仓库根的路径分量判定）。"""
    try:
        parts = path.resolve().relative_to(ROOT).parts
    except ValueError:            # 仓库外（正常不会出现）——按绝对分量兜底
        parts = path.parts
    return bool(SCAN_EXCLUDE_DIRS.intersection(parts))


def read_md(rep: Report, path: Path) -> str | None:
    """读一个契约文档。**读不到 = 判红，不是跳过**。

    D-072 的边界：真契约文档在扫描窗口里被删/被移走时必须红（不得当成"已读过"或静默跳过），
    所以这里把 FileNotFoundError/OSError 转成一条**指名道姓**的失败并如实计数，而不是 `continue`
    了事 —— 退出码仍是 1，且失败原因写在输出里（比裸 traceback 可诊断）。
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        rep.unreadable.append(rel(path))
        rep.fail(f"契约文档在扫描窗口里消失（不跳过，判红）: {rel(path)}")
        return None
    except OSError as exc:
        rep.unreadable.append(rel(path))
        rep.fail(f"契约文档不可读: {rel(path)}（{type(exc).__name__}: {exc}）")
        return None
    rep.reads_ok += 1
    return text


def md_files() -> tuple[list[Path], int]:
    """返回 (契约文档, 被排除的临时 .md 数量)。

    排除口径见 SCAN_EXCLUDE_DIRS = 临时/派生目录；**契约文档一个都不能被排除**
    （docs/**、.agents/**、host/**、AGENTS.md/README.md/USER-GOALS.md…）。排除计数只用于打印，
    不参与判定；判定看的是集合本身（见 AC-RUNTIME-001 的"契约文档集合不变"断言）。
    """
    files: list[Path] = []
    skipped = 0
    for p in ROOT.rglob(f"*{SCAN_SUFFIX}"):
        if excluded(p):
            skipped += 1
            continue
        files.append(p)
    for extra in (ROOT / "AGENTS.md", ROOT / "README.md"):
        if extra.exists() and extra not in files:
            files.append(extra)
    return sorted(set(files)), skipped


def id_definition_files(prefix: str) -> tuple[list[Path], list[Path]]:
    """某前缀的定义文件集合 = (全部文件, 其中的归档文件)。

    集合前缀（见 DEF_SETS：FR、AC、T）：主文件恒在首位，其后是与主文件**同目录**、名字匹配归档 glob
    的每个文件（glob 覆盖多份归档，如 `functional-requirements-archive.md` / `-archive-b.md`）。
    单文件前缀：只有主文件、无归档。
    调用方必须把归档真的读进来（read_md），并对"归档 0 条定义行"判失败 —— 见 collect_definitions。
    """
    if prefix in DEF_SETS:
        main_rel, archive_glob = DEF_SETS[prefix]
        main = ROOT / main_rel
        archives = sorted(p for p in main.parent.glob(archive_glob) if p.is_file())
        return [main, *archives], archives
    return [ROOT / DEF_SOURCES[prefix]], []


def ac_definition_files() -> tuple[list[Path], list[Path]]:
    return id_definition_files("AC")


def fr_definition_files() -> tuple[list[Path], list[Path]]:
    return id_definition_files("FR")


def ids_in(path: Path, rep: Report, prefix: str) -> set[str]:
    text = read_md(rep, path)
    return {m.group("id") for m in ROW_RE.finditer(text or "")
            if m.group("id").startswith(prefix + "-")}


def collect_definitions(rep: Report) -> set[str]:
    defined: set[str] = set()
    for prefix in sorted(set(DEF_SETS) | set(DEF_SOURCES)):
        paths, archives = id_definition_files(prefix)
        main_rel = rel(paths[0])
        found: set[str] = set()
        per_file: dict[str, int] = {}
        for path in paths:
            if not path.exists():
                rep.fail(f"定义文件缺失: {rel(path)}")
                continue
            text = read_md(rep, path)
            if text is None:
                continue
            ids = {m.group("id") for m in ROW_RE.finditer(text)
                   if m.group("id").startswith(prefix + "-")}
            per_file[rel(path)] = len(ids)
            found |= ids
        if not found:
            rep.fail(f"{main_rel} 中未找到任何 {prefix}- 定义行")
        if archives:
            # 可观察证据 + 硬断言：归档必须真被读到（0 条定义行 = 空读 = 失败），
            # 不许只靠"主文件与归档两边都是空集合"静默通过。FR / AC / T 同一套口径。
            label, key, row_label = SET_LABELS[prefix]
            arch_rels = [rel(p) for p in archives]
            for relp in arch_rels:
                if per_file.get(relp, 0) == 0:
                    rep.fail(f"归档文件未被有效读取（0 条 {prefix}- 定义行）: {relp}")
            archived = set().union(*(ids_in(p, rep, prefix) for p in archives))
            rep.ok(f"{label}: 主文件 {main_rel} 定义 {per_file.get(main_rel, 0)} 条；"
                   f"{key}=[{', '.join(f'{r}:{per_file.get(r, 0)}' for r in arch_rels)}]"
                   f"（归档文件共 {len(archived)} 条 {row_label}，受同一套门校验）")
        defined |= found
    adr_dir = ROOT / ADR_DIR
    adr = {m.group(1) for p in sorted(adr_dir.glob("*.md"))
           for m in [ADR_RE.search(read_md(rep, p) or "")] if m}
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
        text = read_md(rep, path)
        if text is None:
            continue                      # 已在 read_md 里判红；这里只是不再崩溃
        for token in REF_RE.findall(text):
            refs += 1
            if token in defined:
                continue
            if any(token.startswith(p) for p in DESIGN_PHASE_PREFIXES):
                continue
            unresolved.setdefault(token, set()).add(rel(path))
    if unresolved:
        rep.fail(f"未解析的 ID 引用 {len(unresolved)} 个（共 {refs} 处引用）",
                 [f"{k}  ← {', '.join(sorted(v))}" for k, v in sorted(unresolved.items())])
    else:
        rep.ok(f"ID 完整性: {len(defined)} 个定义，{refs} 处引用，0 未解析")


def check_placeholders(rep: Report, files: list[Path]) -> None:
    hits: list[str] = []
    for path in files:
        text = read_md(rep, path)
        if text is None:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            m = PLACEHOLDER_RE.search(line)
            if m:
                hits.append(f"{rel(path)}:{i}: {m.group(0)}")
    if hits:
        rep.fail(f"占位符 {len(hits)} 处", hits)
    else:
        rep.ok("占位符: 无")


def parse_budgets(rep: Report) -> dict[str, int]:
    path = ROOT / "docs/design/12-documentation-standard.md"
    text = read_md(rep, path)
    if text is None:
        return {}
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
            if excluded(path) or path.is_dir():
                continue
            relp = rel(path)
            # 更具体的行（精确路径）优先于通配行
            specific = [v for k, v in budgets.items() if not any(c in k for c in "*?[") and k == relp]
            effective = min([limit] + specific)
            try:
                size = path.stat().st_size
            except FileNotFoundError:     # 扫描窗口里消失 ⇒ 判红（同 read_md：不跳过当通过）
                rep.fail(f"受预算约束的文件在扫描窗口里消失（不跳过，判红）: {relp}")
                continue
            checked += 1
            ratio = size / effective
            if ratio > worst[0]:
                worst = (ratio, f"{relp} {size}/{effective} B")
            if size > effective:
                overs.append(f"{relp}: {size} > {effective} B (超 {size - effective} B)")
    if overs:
        rep.fail(f"预算超限 {len(overs)} 个文件", overs)
    else:
        rep.ok(f"预算: {checked} 个文件受检，最高占用 {worst[0]:.0%}（{worst[1]}）")


def check_coverage(rep: Report) -> None:
    # FR 与 AC 的定义都是**集合**（主文件 + 同目录归档）：归档不豁免覆盖检查 —— 搬进归档的
    # FR/AC 行与它还在主文件时受完全相同的"无孤儿"断言约束（范围扩大，语义不变）。
    fr_files, fr_archives = fr_definition_files()
    fr_files = [p for p in fr_files if p.exists()]
    ac_files, ac_archives = ac_definition_files()
    ac_files = [p for p in ac_files if p.exists()]
    fr_rows = [l for p in fr_files for l in (read_md(rep, p) or "").splitlines()
               if l.startswith("| FR-")]
    ac_rows = [l for p in ac_files for l in (read_md(rep, p) or "").splitlines()
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
               f"（FR 定义文件 {len(fr_files)} 个：主文件 + {len(fr_archives)} 个归档；"
               f"AC 定义文件 {len(ac_files)} 个：主文件 + {len(ac_archives)} 个归档）")


def check_handover_set(rep: Report, budgets: dict[str, int]) -> None:
    """交接文档集合（主文件 + 同目录 `handover-archive*.md`）：细节搬走，但**不许搬丢**。

    判据：① 主文件在；② 归档集合非空（`glob` 0 个文件 ⇒ 红）；③ 主文件里的每个 `§N` 指针在归档里有
    对应标题 `## N …`；④ 每个被指向的小节**非空**（标题下一行空到尾 ⇒ 红）。
    这条与 FR/AC/T 的"归档 0 条定义行 = 空读 = 失败"是同一套思路：归档要有实质内容才算数。
    """
    main = ROOT / HANDOVER_MAIN
    if not main.exists():
        rep.fail(f"交接主文件不存在：{HANDOVER_MAIN}")
        return
    archives = sorted(p for p in main.parent.glob(HANDOVER_ARCHIVE_GLOB) if p.is_file())
    main_text = read_md(rep, main) or ""
    problems: list[str] = []
    if not archives:
        problems.append(f"交接归档集合为空（`{HANDOVER_ARCHIVE_GLOB}` 0 个文件）⇒ 细节没处放")
    pointers = sorted({m.group(1) for m in HANDOVER_POINTER_RE.finditer(main_text)})
    if not pointers:
        problems.append(f"`{HANDOVER_MAIN}` 里没有任何 `§N` 指针（细节的归档指向必须显式写出来）")
    arch_texts = {str(p.relative_to(ROOT)): (read_md(rep, p) or "") for p in archives}
    sections = 0
    for num in pointers:
        heading = re.compile(rf"^##\s*{re.escape(num)}[.、\s]")
        hit = None
        for rel, text in arch_texts.items():
            lines = text.splitlines()
            for index, line in enumerate(lines):
                if not heading.match(line.strip()):
                    continue
                body = []
                for follow in lines[index + 1:]:
                    if follow.strip().startswith("##"):
                        break
                    if follow.strip():
                        body.append(follow.strip())
                if body:
                    hit = rel
                    sections += 1
                else:
                    problems.append(f"归档 `{rel}` 的小节 `## {num}` 是**空小节**（只有标题）")
                break
            if hit:
                break
        if hit is None and not any(f"## {num}" in p for p in problems):
            problems.append(f"指针 §{num} 在归档里找不到对应标题 `## {num} …`（细节搬丢了或编号漂了）")
    if problems:
        rep.fail("交接文档集合（主文件 + 归档）", problems)
    else:
        limit = budgets.get(HANDOVER_MAIN)
        shown = f"{limit} B" if limit else "（预算表无此行）"
        rep.ok(f"交接文档集合: 主文件 {HANDOVER_MAIN}（{main.stat().st_size} B / 预算 {shown}）/ 归档 "
               f"{list(arch_texts)}；`§N` 指针 {len(pointers)} 个全部解析且小节非空（{sections} 节有正文）")


def main() -> int:
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    rep = Report()
    files, skipped = md_files()
    defined = collect_definitions(rep)
    budgets = parse_budgets(rep)
    check_ids(rep, files, defined)
    check_placeholders(rep, files)
    check_budgets(rep, budgets)
    check_handover_set(rep, budgets)
    check_coverage(rep)
    print("== quotagent 文档门 (AC-DESIGN-001/002/003) ==")
    print(f"扫描范围: 契约文档 {len(files)} 个 markdown 文件"
          f"（已排除 {'/'.join(sorted(SCAN_EXCLUDE_DIRS))} 下的 {skipped} 个临时/派生 .md），仓库根 {ROOT}")
    print(f"扫描读取: 成功 {rep.reads_ok} 次读取，读窗口里消失 {len(rep.unreadable)} 个契约文档"
          f"（消失 ⇒ 判红，不跳过）")
    print("\n".join(rep.lines))
    print(f"RESULT: {'PASS' if not rep.failures else 'FAIL (' + str(len(rep.failures)) + ' 项)'}")
    if verbose and rep.failures:
        for line in rep.lines:
            if line.startswith("       - "):
                print(line)
    return 1 if rep.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
