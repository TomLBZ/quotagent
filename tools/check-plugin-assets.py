#!/usr/bin/env python3
"""plugin-assets 门（`tools/verify.sh plugin-assets`）—— **检查/测试资产的归属一致性**（迁移阶段 4.1）。

规则真源：`docs/design/27-plugin-architecture.md` §2.1（每个插件有自己的 `code/`+`tools/`+`tests/`+…）、
§2.2（`tools/` 里的写账本者只能是该账本唯一写者）、§9 未决 3（`tools/` 保留的薄入口）；
执行清单：`docs/work/plans/plugin-migration-plan.md` §2 阶段 1/4.1；**人可读的分类表**在
`docs/work/plans/plugin-file-map.md` §分类（本门把它当登记真源逐条核对，不另立一处）。

这个门断言什么（每条都**真读磁盘 / 真跑命令**，不读代码猜）：
  PA1 每个**已搬**资产：**目标位置存在**（文件、非空），且**旧位置只剩薄转发**（含
      `薄转发（迁移阶段 4.1）` 标记、行数 ≤ 20、字节 ≤ 1200、内含目标相对路径、内容与目标不同）。
  PA2 旧位置**不是实体**：转发文件字节 ≤ 目标字节 1/4 且 sha256 ≠ 目标（挡住"把转发改成实体"）。
  PA3 分类表**双向**：`plugin-file-map.md` §分类 里 `插件·已搬` 的行 == 门内登记（旧位置/归属/子目录逐条一致），
      且门内登记的每一项都在表里有行（不许"搬了不登记"）。
  PA4 分类表是**全量登记**：§分类 三节的行集合 == 磁盘上的资产集合（`tools/` 顶层文件、`host/*-gate.mjs`、
      `src/quotagent/qa/checks_*.py`）—— 新增一个资产而不登记即红。
  PA5 归属唯一：每个已搬资产的 basename 在 `src/**`（排除 `__pycache__`）里**只出现一次**，
      且位于**归属插件**的目录下（资产不得出现在别的插件目录里）。
  PA6 门接口**不因搬迁失联**：`tools/verify.sh help` 真跑 rc=0、门名数 ≥ 70、`help` 列出的每个名字都有
      `case` 分支；每个分支里引用的**实现路径**都解析得到且真实存在；每个已搬资产仍被
      `tools/verify.sh` 或 `src/quotagent/qa/*.py` 引用（防"搬完就没人调用"）；再真跑一条最便宜的
      只读既有门（`v`）证明接口真能跑。
  PA7 `tools/**` 的**散落不再增长**：`tools/` 下的**非薄入口**文件集合 == §分类 里 `插件·待搬` 的集合（双向），
      且数量 ≤ `BASELINE_NONTHIN`（本批实测值，**只减不增**）。
  F0 基线（未变异）在同一套判据上**不红**（否则"变异变红"说明不了任何事）。
  F1..F4 **4 处单点变异全红**（整树副本 + 单点改动；每处必须让**指定的**断言变红）；
      ① 抽走目标目录里的资产 ② 把一条转发改成实体 ③ 把资产副本放进另一个插件目录
      ④ 往 `tools/` 加一个未登记的非薄入口。
  F5 防假变异：不存在的锚点必须被判为假变异（不许"没改到任何字节"也算红）。
  F6 全过程**产品树字节不变**（变异只写在 `tmp/` 的整树副本里）。

用法：`tools/verify.sh plugin-assets`（或 `python3 tools/check-plugin-assets.py [--root DIR]`）
退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_REL = "docs/work/plans/plugin-file-map.md"
VERIFY_REL = "tools/verify.sh"

#: 已搬资产登记（**唯一机器登记处**）：旧位置 → (归属插件 id, 新位置)；分类表里必须逐条对上（PA3）。
RELOCATED: dict[str, tuple[str, str]] = {
    "tools/check-quote-draft-route.py": (
        "domain/quote-prepare", "src/domain/quote-prepare/tests/check-quote-draft-route.py"),
    "tools/check-rfq-visibility-route.py": (
        "system/projection", "src/system/projection/tests/check-rfq-visibility-route.py"),
    "tools/check-gate-timeline-route.py": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/check-gate-timeline-route.py"),
    "tools/check-change-detail-route.py": (
        "domain/gate-timeline", "src/domain/gate-timeline/tests/check-change-detail-route.py"),
    "tools/check-authority-route.py": (
        "domain/authority-band", "src/domain/authority-band/tests/check-authority-route.py"),
    "tools/check-plugin-lifecycle.py": (
        "system/runtime", "src/system/runtime/tests/check-plugin-lifecycle.py"),
    "tools/check-advice-route.py": (
        "domain/advice", "src/domain/advice/tests/check-advice-route.py"),
    "src/quotagent/qa/checks_qprep.py": (
        "domain/quote-prepare", "src/domain/quote-prepare/tests/checks_qprep.py"),
}

#: 平台级薄入口（27 §9 未决 3 + 阶段 5.2 的 `plugin.sh`）：不搬、留名。
THIN_ENTRIES = frozenset({"verify.sh", "run.sh", "runtime.sh", "bootstrap.sh", "cordis.sh", "plugin.sh"})
FORWARDER_MARK = "薄转发（迁移阶段 4.1）"
MAX_FORWARDER_BYTES = 1200
MAX_FORWARDER_LINES = 20
EXCLUDE_DIRS = frozenset({"__pycache__", ".git", "tmp", "node_modules", ".venv"})

#: `tools/` 下非薄入口文件的**实测值**：阶段 4.1 搬前 69（75 个文件 − 6 个薄入口）− 搬走 7 个 + `plugin-assets.py` 自己 1 个
#: = 63；一键运行的干净副本验收门 `tools/check-run-clone.py`（EV-171）再 +1 ⇒ **64**。
#: 锁的语义是"只减不增"：搬走本门或其它项时这个数应随之下调；**上调只允许"新增一个同级平台门"这一种理由**（改这一行是显式动作）。
BASELINE_NONTHIN = 64
#: 门名数下界（阶段 4.1 搬前 69 + `plugin-assets` = 70；本批新增 `run-clone` ⇒ 71；门名是接口，只增不减）。
MIN_GATE_NAMES = 71
#: `--help` 一类的别名不算"实现分支"。
HELP_ALIASES = frozenset({"help", "--help", "-h"})

CASE_RE = re.compile(r"^  (?P<name>[a-zA-Z0-9|_-]+)\)\s*$", re.M)
# 实现路径 token：可带 `$ROOT/` / `$HERE/` 锚点，允许 `../` 链，必须以扩展名结尾（挡住散文里的目录名）。
PATH_RE = re.compile(r"(?:(?P<anchor>\$\{?(?:ROOT|HERE)\}?)/)?(?P<rel>(?:\.\./)*[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)")
TOP_DIRS = ("tools", "host", "src", "docs", "run", "AGENTS.md", "README.md")
ROW_RE = re.compile(r"^\|\s*`(?P<asset>[^`]+)`\s*\|\s*(?P<owner>[^|]*?)\s*\|\s*(?P<klass>[^|]*?)\s*\|\s*(?P<sub>[^|]*?)\s*\|\s*$")
CLASSES = ("平台薄入口", "插件·已搬", "插件·待搬")

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_excluded(path: Path, root: Path) -> bool:
    """按**相对仓库根**的路径分量判定（副本位于 `/…/tmp/…` 下也不会被整片误排除）。"""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        parts = path.parts
    return bool(EXCLUDE_DIRS.intersection(parts))


def tools_files(root: Path) -> list[str]:
    """`tools/` 下的文件（相对仓库根；排除 `__pycache__` 一类派生目录）。"""
    base = root / "tools"
    out = [str(p.relative_to(root)) for p in base.rglob("*") if p.is_file() and not is_excluded(p, root)]
    return sorted(out)


def host_gate_files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in (root / "host").glob("*-gate.mjs") if p.is_file())


def qa_check_files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in (root / "src" / "quotagent" / "qa").glob("checks_*.py") if p.is_file())


def classification_rows(root: Path) -> list[dict]:
    """解析 `plugin-file-map.md` §分类 的三节表（机器登记的人可读镜像）。"""
    text = (root / MAP_REL).read_text(encoding="utf-8")
    rows: list[dict] = []
    section = None
    in_it = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## 分类") or stripped.startswith("## 分类表"):
            in_it = True
            continue
        if in_it and stripped.startswith("## "):
            break
        if in_it and stripped.startswith("### "):
            section = stripped
            continue
        if not in_it:
            continue
        match = ROW_RE.match(stripped)
        if not match or section is None:
            continue
        asset = match.group("asset").strip()
        klass = match.group("klass").strip().strip("`")
        if klass not in CLASSES:
            continue
        owner = match.group("owner").strip().strip("`")
        rows.append({"section": section, "asset": asset, "owner": owner, "klass": klass,
                     "sub": match.group("sub").strip().strip("`")})
    return rows


def forwarder_problem(root: Path, old: str, target: str) -> str:
    """旧位置是否"只剩薄转发"；返回空串 = 通过，否则是有名的原因。"""
    old_path, target_path = root / old, root / target
    if not old_path.is_file():
        return f"旧位置不存在：{old}"
    text = old_path.read_text(encoding="utf-8", errors="replace")
    size, lines = old_path.stat().st_size, len(text.splitlines())
    if FORWARDER_MARK not in text:
        return f"缺薄转发标记（{FORWARDER_MARK}）：{old}"
    if size > MAX_FORWARDER_BYTES:
        return f"转发文件过大（{size} B > {MAX_FORWARDER_BYTES} B）：{old}"
    if lines > MAX_FORWARDER_LINES:
        return f"转发文件行数过多（{lines} > {MAX_FORWARDER_LINES}）：{old}"
    if target not in text and Path(target).name not in text:
        return f"转发没有指向目标（{target}）：{old}"
    if target_path.is_file():
        if sha256(old_path) == sha256(target_path):
            return f"旧位置与目标字节相同（= 实体没搬走/留了副本）：{old}"
        if size * 4 > target_path.stat().st_size:
            return (f"旧位置相对目标过大（{size} B vs {target_path.stat().st_size} B，"
                    f"超过 1/4 ⇒ 不像薄转发）：{old}")
    return ""


def resolve_tokens(root: Path, body: str) -> tuple[list[str], list[str]]:
    """抽出分支体里引用的实现路径 → (真实存在的, 解析不到/不存在的)。"""
    ok: list[str] = []
    bad: list[str] = []
    for line in body.splitlines():
        if line.strip().startswith("#"):
            continue
        for match in PATH_RE.finditer(line):
            rel = match.group("rel")
            anchor = match.group("anchor")
            if any(ch in rel for ch in "*${}") or "XXXX" in rel:
                continue
            if anchor == "$HERE":
                rel = "tools/" + rel
            rel = os.path.normpath(rel)
            # 只认"实现路径"：首段必须是本仓的顶层目录（挡住 `tmp/*.XXXXXX` 一类临时路径与散文里的文件名）。
            if rel.split("/", 1)[0] not in TOP_DIRS:
                continue
            if rel.startswith("..") or (root / rel).is_dir():
                continue
            (ok if (root / rel).exists() else bad).append(rel)
    return sorted(set(ok)), sorted(set(bad))


def gate_interface_problems(root: Path, run_gates: bool) -> tuple[list[str], str]:
    """PA6：门名 ↔ 分支 ↔ 实现路径三方对齐；可选真跑 help 与 v。"""
    problems: list[str] = []
    text = (root / VERIFY_REL).read_text(encoding="utf-8")
    starts = [(m.start(), m.group("name")) for m in CASE_RE.finditer(text)]
    names: set[str] = set()
    for _entry in starts:
        names |= {n for n in _entry[1].split("|") if n}
    resolved = 0
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        good, bad = resolve_tokens(root, text[pos:end])
        resolved += len(good)
        for rel in bad:
            problems.append(f"分支 `{name}` 引用的实现不存在：{rel}")
    if len(names) < MIN_GATE_NAMES:
        problems.append(f"门名数 {len(names)} < {MIN_GATE_NAMES}（门名是接口，只增不减）")
    if resolved < 60:
        problems.append(f"分支里解析到的实现路径只有 {resolved} 个（判定器在空转？）")
    if not run_gates:
        return problems, f"静态解析 {resolved} 条实现路径"
    env = dict(os.environ)
    env["QUOTAGENT_ROOT"] = str(root)
    helped = subprocess.run(["sh", str(root / VERIFY_REL), "help"], cwd=str(root), capture_output=True,
                            text=True, timeout=180, env=env)
    if helped.returncode != 0:
        problems.append(f"`verify.sh help` rc={helped.returncode}（接口失联）")
    listed: set[str] = set()
    for line in helped.stdout.splitlines():
        for token in line.strip().split("|"):
            token = token.strip()
            if re.fullmatch(r"[a-z0-9_-]+", token or ""):
                listed.add(token)
    for name in sorted(listed - HELP_ALIASES):
        if name not in names:
            problems.append(f"`verify.sh help` 列出了 `{name}`，但没有对应的 case 分支")
    if len(listed) < MIN_GATE_NAMES:
        problems.append(f"`verify.sh help` 只列出 {len(listed)} 个门名（< {MIN_GATE_NAMES}）")
    cheap = subprocess.run(["sh", str(root / VERIFY_REL), "v"], cwd=str(root), capture_output=True,
                           text=True, timeout=300, env=env)
    if cheap.returncode != 0:
        problems.append(f"`verify.sh v`（最便宜的只读门）rc={cheap.returncode}："
                        f"{(cheap.stderr or cheap.stdout).strip().splitlines()[-1][:120] if (cheap.stderr or cheap.stdout).strip() else ''}")
    return problems, f"真跑 help rc={helped.returncode}（{len(listed)} 个门名）+ v rc={cheap.returncode}；静态解析 {resolved} 条实现路径"


def evaluate(root: Path, run_gates: bool = True) -> tuple[list[tuple[str, bool, str]], dict]:
    """对给定仓库根求值（正控与变异共用同一套判据，杜绝两套）。"""
    res: list[tuple[str, bool, str]] = []
    add = lambda name, ok, detail="": res.append((name, bool(ok), detail))  # noqa: E731
    facts: dict = {}

    # --- PA1/PA2：已搬资产（目标在 + 旧位置只剩薄转发 + 旧位置不是实体）------------------
    p1: list[str] = []
    p2: list[str] = []
    for old, (owner, target) in sorted(RELOCATED.items()):
        target_path = root / target
        if not target_path.is_file():
            p1.append(f"目标不存在：{target}")
            continue
        if target_path.stat().st_size == 0:
            p1.append(f"目标是空文件：{target}")
        problem = forwarder_problem(root, old, target)
        if problem:
            p1.append(problem)
        else:
            old_size, target_size = (root / old).stat().st_size, target_path.stat().st_size
            if old_size * 4 > target_size:
                p2.append(f"{old}（{old_size} B vs {target_size} B）")
    add(f"PA1 已搬 {len(RELOCATED)} 个资产：目标存在且旧位置只剩薄转发（标记/行数/字节/指向）",
        not p1, "; ".join(p1[:6]) or f"全部通过（{len(RELOCATED)} 项）")
    add("PA2 旧位置不是实体：字节 ≤ 目标 1/4 且 sha256 ≠ 目标（挡住「把转发改成实体」）",
        not p2, "; ".join(p2[:6]) or "全部通过")

    # --- PA3/PA4：分类表双向 + 全量登记 -----------------------------------------------
    rows = classification_rows(root)
    facts["rows"] = len(rows)
    table_moved = {r["asset"]: r for r in rows if r["klass"] == "插件·已搬"}
    mismatch: list[str] = []
    for old, (owner, target) in sorted(RELOCATED.items()):
        row = table_moved.get(old)
        if row is None:
            mismatch.append(f"表里没有已搬行：{old}")
            continue
        sub = f'{target.rsplit("/", 2)[1]}/'
        if row["owner"] != owner:
            mismatch.append(f"{old} 归属不一致：表={row['owner']} 登记={owner}")
        if row["sub"] != sub:
            mismatch.append(f"{old} 子目录不一致：表={row['sub']} 登记={sub}")
    for asset in sorted(set(table_moved) - set(RELOCATED)):
        mismatch.append(f"表里标了已搬但门内无登记：{asset}")
    add(f"PA3 分类表 §分类 的「已搬」行 == 门内登记（{len(RELOCATED)} 项，归属与子目录逐条一致）",
        not mismatch, "; ".join(mismatch[:6]) or "双向一致")

    disk = {
        "tools": set(tools_files(root)),
        "host": set(host_gate_files(root)),
        "qa": set(qa_check_files(root)),
    }
    name_of = {"tools": "`tools/**`", "host": "`host/*-gate.mjs`", "qa": "`src/quotagent/qa/checks_*.py`"}
    unregistered: list[str] = []
    for key, files in disk.items():
        registered = {r["asset"] for r in rows if r["asset"] in files}
        for asset in sorted(files - registered):
            unregistered.append(f"{key}: {asset}")
    add(f"PA4 分类表是**全量登记**（tools {len(disk['tools'])} / host {len(disk['host'])} / "
        f"qa {len(disk['qa'])} 个资产逐条有行）", not unregistered, "; ".join(unregistered[:8]) or "无遗漏")
    facts["registered"] = sum(len({r['asset'] for r in rows if r['asset'] in f}) for f in disk.values())

    # --- PA5：归属唯一（不许出现在别的插件目录里）-------------------------------------
    src_files = [p for p in (root / "src").rglob("*") if p.is_file() and not is_excluded(p, root)]
    wrong: list[str] = []
    for old, (owner, target) in sorted(RELOCATED.items()):
        base = Path(target).name
        # 旧位置自身允许存在（它就是薄转发的家）；这里只看"实体"是否唯一、是否落在归属插件目录里。
        hits = [str(p.relative_to(root)) for p in src_files if p.name == base and str(p.relative_to(root)) != old]
        if len(hits) != 1:
            wrong.append(f"{base} 在 src/** 里出现 {len(hits)} 次：{hits[:4]}")
            continue
        owner_dir = f"src/{owner}/"
        if not hits[0].startswith(owner_dir):
            wrong.append(f"{base} 落在 `{hits[0]}`，不属于归属插件 `{owner}`")
    add("PA5 归属唯一：每个已搬资产的 basename 在 `src/**` 里只出现一次且在**归属插件**目录下",
        not wrong, "; ".join(wrong[:6]) or f"{len(RELOCATED)} 项全部唯一且在归属目录")

    # --- PA6：门接口不因搬迁失联 -----------------------------------------------------
    problems, note = gate_interface_problems(root, run_gates)
    referenced: list[str] = []
    verify_text = (root / VERIFY_REL).read_text(encoding="utf-8")
    qa_text = "\n".join((root / "src" / "quotagent" / "qa" / p.name).read_text(encoding="utf-8", errors="replace")
                        for p in (root / "src" / "quotagent" / "qa").glob("*.py"))
    for old, (_owner, target) in sorted(RELOCATED.items()):
        base = Path(target).name
        if old not in verify_text and base not in verify_text and base not in qa_text and old not in qa_text:
            referenced.append(f"{old} 搬完之后没人引用（门名/AC 都指不到它）")
    add("PA6 门接口不因搬迁失联（help 门名 ↔ case 分支 ↔ 实现路径三方对齐 + 真跑 help/v + 已搬资产仍被引用）",
        not problems and not referenced, "; ".join((problems + referenced)[:6]) or note)

    # --- PA7：散落不再增长 -----------------------------------------------------------
    nonthin = [f for f in disk["tools"] if Path(f).name not in THIN_ENTRIES and f not in RELOCATED]
    pending_tools = {r["asset"] for r in rows if r["klass"] == "插件·待搬" and r["asset"].startswith("tools/")}
    diff: list[str] = []
    for asset in sorted(set(nonthin) - pending_tools):
        diff.append(f"`tools/` 里的非薄入口不在待搬清单（散落没登记）：{asset}")
    for asset in sorted(pending_tools - set(nonthin)):
        diff.append(f"待搬清单里的项在磁盘上不是非薄入口：{asset}")
    if len(nonthin) > BASELINE_NONTHIN:
        diff.append(f"非薄入口 {len(nonthin)} 个 > 基线 {BASELINE_NONTHIN} 个（散落变多）")
    add(f"PA7 `tools/**` 的散落不再增长（非薄入口 == §分类 的待搬集合 {len(pending_tools)} 项，"
        f"且 ≤ 基线 {BASELINE_NONTHIN}）", not diff, "; ".join(diff[:8]) or f"实计 {len(nonthin)} 项，双向一致")
    facts["nonthin"] = len(nonthin)
    facts["thin_entries"] = sorted(Path(f).name for f in disk["tools"] if Path(f).name in THIN_ENTRIES)
    return res, facts


def tree_copy(src: Path, dst: Path) -> Path:
    """整树副本（排除 `.git`/`tmp`/`__pycache__`；`.venv` 与 `node_modules` 保留，符号链接按原样）。"""
    shutil.copytree(src, dst, symlinks=True,
                    ignore=shutil.ignore_patterns(".git", "tmp", "__pycache__"))
    return dst


def apply_replacement(path: Path, find: str, replace: str) -> bool:
    """唯一锚点替换；锚点不存在或不唯一 ⇒ False（= 假变异）。"""
    text = path.read_text(encoding="utf-8")
    if text.count(find) != 1:
        return False
    path.write_text(text.replace(find, replace, 1), encoding="utf-8")
    return True


def main() -> int:
    global ROOT
    argv = list(sys.argv[1:])
    if "--root" in argv:
        index = argv.index("--root")
        try:
            ROOT = Path(argv[index + 1]).resolve()
        except IndexError:
            print("用法：python3 tools/check-plugin-assets.py [--root DIR]", file=sys.stderr)
            return 2
    if not (ROOT / MAP_REL).is_file() or not (ROOT / VERIFY_REL).is_file():
        print(f"plugin-assets 门：{ROOT} 不像仓库根（缺 {MAP_REL} 或 {VERIFY_REL}）", file=sys.stderr)
        return 2

    relevant = [ROOT / MAP_REL, ROOT / VERIFY_REL,
                *[ROOT / p for p in RELOCATED], *[ROOT / t for _o, (_w, t) in RELOCATED.items()]]
    digests_before = {str(p): sha256(p) for p in relevant if p.is_file()}

    RESULTS.extend(evaluate(ROOT, run_gates=True)[0])
    baseline_red = [name for name, ok, _ in RESULTS if not ok]

    # --- F1..F4：4 处单点变异（整树副本；每处必须让指定断言变红）------------------------
    tmp_root = ROOT / "tmp"
    tmp_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="plugin-assets-", dir=str(tmp_root)))
    mutant_specs = [
        {"name": "F1 抽走目标目录里的资产（`src/domain/authority-band/tests/check-authority-route.py`）必须让 PA1 变红",
         "apply": lambda base: (base / "src/domain/authority-band/tests/check-authority-route.py").unlink(),
         "must_red": "PA1 ", "why": "目标不存在 ⇒ 实体丢了"},
        {"name": "F2 把一条转发改成实体（`tools/check-change-detail-route.py` ← 目标全文）必须让 PA1/PA2 变红",
         "apply": lambda base: (base / "tools/check-change-detail-route.py").write_bytes(
             (base / "src/domain/gate-timeline/tests/check-change-detail-route.py").read_bytes()),
         "must_red": "PA1 ", "why": "旧位置变成实体 ⇒ 两份实现、字节相同"},
        {"name": "F3 把资产副本放进另一个插件目录（change-detail 的副本塞进 authority-band）必须让 PA5 变红",
         "apply": lambda base: shutil.copyfile(
             base / "src/domain/gate-timeline/tests/check-change-detail-route.py",
             base / "src/domain/authority-band/tests/check-change-detail-route.py"),
         "must_red": "PA5 ", "why": "归属唯一被打破：同一资产出现在两个插件目录"},
        {"name": "F4 往 `tools/` 加一个未登记的非薄入口（`tools/check-zz-unregistered.py`）必须让 PA4/PA7 变红",
         "apply": lambda base: (base / "tools/check-zz-unregistered.py").write_text(
             "# 未登记的新检查资产（变异）\n", encoding="utf-8"),
         "must_red": "PA7 ", "why": "散落变多且没登记"},
    ]
    mutated_roots: list[Path] = []
    for index, spec in enumerate(mutant_specs, start=1):
        base = tree_copy(ROOT, work / f"mutant-{index}")
        spec["apply"](base)
        res, _facts = evaluate(base, run_gates=True)
        reds = [name for name, ok, _ in res if not ok]
        hit = [name for name in reds if spec["must_red"] in name]
        delta = [n for n in reds if n not in baseline_red]
        mutated_roots.append(base)
        check(f"{spec['name']}", bool(hit) and bool(delta),
              f"变异体红 {len(reds)} 项、新增红 {len(delta)} 项、命中指定断言={bool(hit)}；{spec['why']}；"
              f"红项={[n.split(' ')[0] for n in reds][:8]}")

    check("F0 基线（未变异）在同一套判据上**不红**（否则 4 处变异变红都是空转）",
          not baseline_red, f"基线红项={baseline_red}")
    probe = work / "probe-fake.py"
    probe.write_text("# 探针文件（只为验证 F5 的防假变异路径）\n", encoding="utf-8")
    check("F5 防假变异：不存在的锚点必须返回 False（不许「没改到任何字节」也算红）",
          apply_replacement(probe, "不存在的锚点", "x") is False,
          "唯一锚点缺失 ⇒ False（探针文件在 tmp/ 副本根，产品树不受影响）")
    after = {str(p): sha256(p) for p in relevant if p.is_file()}
    check("F6 全过程**产品树字节不变**（变异只写在 tmp/ 的整树副本里）",
          after == digests_before, f"前后 {len(digests_before)}/{len(after)} 个文件摘要一致="
                                   f"{after == digests_before}；副本 {len(mutated_roots)} 份在 {work}")

    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in RESULTS:
        print(f"{'[ok]  ' if ok else '[FAIL]'} {name}")
        if detail:
            print(f"        {detail}")
    total = len(RESULTS)
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（plugin-assets 门 {total - len(failed)}/{total}）")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
