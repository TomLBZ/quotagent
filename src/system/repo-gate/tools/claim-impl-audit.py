#!/usr/bin/env python3
r"""「承诺 ↔ 实现」对账尺子：把一份**可检验承诺集**逐条在实现里解析**承接点**（`file:line`）。

**位置（P46 搬迁）**：实体在 `src/system/repo-gate/tools/claim-impl-audit.py`（仓内固定位置）。
它**不是** `tools/verify.sh` 的门（本批没有新建门），而是一把**可重跑的尺子**：判据与 P45 首次对账时
**一字未改**（只改三处运行面：① 脚本进仓、任意 cwd 可跑（`ROOT` 由 `__file__` 推）；
② 输入真源固定在 `docs/work/evidence/EV-193-claims.json`（此前在会被清掉的 `tmp/`）；
③ 输出默认写回 `docs/work/evidence/EV-193-claim-matrix.tsv`，不再写 `tmp/`）。

**什么时候跑**（触发条件，不是定时任务）：
  · 改了 `docs/design/29-webui-gui-app.md` 或 `29-webui-gui-app-archive.md`（**含改自己的登记节**）之后；
  · 改了 `docs/work/evidence/EV-193-claims.json`（承诺 / probe）之后；
  · 怀疑「文档说的」与「代码做的」漂了（新增/删除路由、动作、面板、门时）；
  · 提交前想复核「缺口 = 0」这条口径（与 `body-keys-audit.py` 一起跑，见 29 §24）。

**怎么读结果**：`rc=0` = 无缺口且无未处置漂移；`rc=1` = 有缺口 / 漂移（逐条打出来）；
`rc=2` = 输入缺失或 JSON 坏（**不得当作通过**）。表在 stdout 与 `--matrix` 指定的 TSV；机器可读在
`<matrix>.resolved.json`。逐条读法：`承接` = 全部 probe 命中（列 `file:line`）；`缺口` = 有 probe 未命中
（**不许**当成已实现）；`漂移` = 数据里显式标 `drift` 的条目（必须带证据行）。

**偏差怎么处置**（三种，动手前先分类）：
  ① **文档错**（承诺与实现不符是文档漂了）⇒ 改文档，并把 `drift` 的证据行逐字写进本条的 `drift` 字段；
  ② **实现错**（实现真缺）⇒ 修实现；修不动（不在本批可改面）⇒ 登记在证据页「登记待定」并**保留缺口**；
  ③ **尺子错**（probe 写歪了、把能找到的写成找不到）⇒ 改 probe 必须**逐条说明为什么原 probe 不成立**，
     并重跑全部条目证明**只消假红、没有把找不到的地方写成已实现**（P45 就发生过 9 条假缺口，逐条核实后归零）。
  **禁止**：不许用「改判据/删 probe/放宽口径」把红消掉；缺口数为 0 是**跑出来的**，不是删出来的。

用法（任意 cwd）：
    python3 src/system/repo-gate/tools/claim-impl-audit.py                  # 默认：EV-193-claims.json → 清单表 + stdout
    python3 src/system/repo-gate/tools/claim-impl-audit.py --no-write       # 只判、不写文件
    python3 src/system/repo-gate/tools/claim-impl-audit.py --claims X.json --matrix /tmp/out.tsv
    python3 src/system/repo-gate/tools/claim-impl-audit.py tokens spec.json # 勘察：一批正则的首个命中
"""
from __future__ import annotations

import fnmatch
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]        # src/system/repo-gate/tools/ ⇒ 仓库根在四层之上
DEFAULT_CLAIMS = ROOT / "docs/work/evidence/EV-193-claims.json"
DEFAULT_MATRIX = ROOT / "docs/work/evidence/EV-193-claim-matrix.tsv"
# 临时/派生目录不进判据（与 `tools/check-docs.py` 的 SCAN_EXCLUDE_DIRS 同口径）
SKIP_DIRS = {".git", ".venv", "tmp", "node_modules", "__pycache__"}


def walk_all():
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        parts = set(p.relative_to(ROOT).parts)
        if parts & SKIP_DIRS:
            continue
        yield p


def scan(patterns: list[dict]):
    """按 token 列表勘察：返回 {pattern: [(relpath, lineno, text), ...]}"""
    out: dict[str, list] = {p["pattern"]: [] for p in patterns}
    for path in walk_all():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lines = text.splitlines()
        rel = str(path.relative_to(ROOT))
        for spec in patterns:
            rx = re.compile(spec["pattern"])
            if rx.search(text) is None:
                continue
            for i, line in enumerate(lines, 1):
                if rx.search(line):
                    if len(out[spec["pattern"]]) < spec.get("limit", 3):
                        out[spec["pattern"]].append((rel, i, line.strip()[:160]))
    return out


def probe_file(spec: dict) -> dict:
    """单个 probe：{path|glob, pattern, min_count?, absent?}

    `absent:true` = **必须 0 命中**（用于「已删且不得复活」类承诺）；此时 ok = 无命中。
    `min_count:N` = 命中行数至少 N（用于「恰 6 条 / 12 键 / 21 路由」这类数数承诺）。
    `absent_file` = 命中文件本身即失败（文件不存在才算承接）。
    """
    pat = spec.get("pattern", "")
    rx = re.compile(pat) if pat else None
    if spec.get("absent_file"):
        found = []
        for path in walk_all():
            rel = str(path.relative_to(ROOT))
            if fnmatch.fnmatch(rel, spec["glob"]) or path.name == spec["glob"]:
                found.append({"file": rel, "line": 0, "text": "(文件存在)"})
        return {"spec": spec, "hits": found, "ok": not found}
    hits = []
    need = int(spec.get("min_count", 1))
    cap = need if "min_count" in spec else spec.get("limit", 1)
    if spec.get("path"):
        cands: list[Path] = [ROOT / spec["path"]]
    else:
        cands = list(walk_all())
    for path in cands:
        if not path.exists() or not path.is_file():
            continue
        rel = str(path.relative_to(ROOT))
        if spec.get("glob") and not fnmatch.fnmatch(rel, spec["glob"]):
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(lines, 1):
            if rx and rx.search(line):
                hits.append({"file": rel, "line": i, "text": line.strip()[:200]})
                if len(hits) >= cap:
                    break
        if len(hits) >= cap:
            break
    if spec.get("absent"):
        return {"spec": spec, "hits": hits, "ok": not hits}
    return {"spec": spec, "hits": hits, "ok": len(hits) >= need}


def run(claims_path: str, out_path: str, write: bool = True) -> int:
    src = Path(claims_path)
    if not src.is_absolute():
        src = (Path.cwd() / src)
    if not src.exists():
        print(f"[尺子错] 承诺真源不存在：{claims_path}（rc=2：不得当作通过）", file=sys.stderr)
        return 2
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
        claims = data["claims"]
    except (ValueError, KeyError) as exc:
        print(f"[尺子错] 承诺真源读不出来（{type(exc).__name__}: {exc}）（rc=2）", file=sys.stderr)
        return 2
    rows = []
    stats = {"total": 0, "anchored": 0, "gap": 0, "drift": 0}
    by_section: dict[str, dict] = {}
    for c in claims:
        stats["total"] += 1
        results = [probe_file(p) for p in c["probes"]]
        ok = all(r["ok"] for r in results)
        if c.get("drift"):
            status = "漂移（已改）" if ok else "漂移（待改）"
            stats["drift"] += 1
        elif ok:
            status = "承接"
            stats["anchored"] += 1
        else:
            status = "缺口"
            stats["gap"] += 1
        sec = c["section"]
        s = by_section.setdefault(sec, {"total": 0, "anchored": 0, "gap": 0, "drift": 0})
        s["total"] += 1
        s[{"承接": "anchored", "缺口": "gap"}.get(status, "drift")] += 1
        anchor = "；".join(f"{h['file']}:{h['line']}" for r in results for h in r["hits"][:2]) or "—"
        missing = [r["spec"].get("pattern", "(文件不存在)") for r in results if not r["ok"]]
        rows.append({"id": c["id"], "section": sec, "claim": c["claim"], "status": status,
                     "anchor": anchor, "missing": missing, "note": c.get("note", ""),
                     "drift": c.get("drift", "")})

    prefix = str(Path(claims_path))
    try:                                     # 表里写**相对仓库根**的路径（可移植，不落绝对路径字面量）
        prefix = str(src.resolve().relative_to(ROOT))
    except ValueError:
        pass
    lines = [f"# 承诺 ↔ 实现对账清单（{stats['total']} 条）—— 由 `claim-impl-audit.py` 生成，勿手改",
             f"# 生成：python3 src/system/repo-gate/tools/claim-impl-audit.py"
             f"（承诺真源 = {prefix}）",
             f"# 统计：承接 {stats['anchored']} / 缺口 {stats['gap']} / 漂移 {stats['drift']}",
             "# 列：id | § | 状态 | 承接点（file:line）| 可检验承诺 | 备注/漂移证据"]
    for r in rows:
        note = r["drift"] or r["note"] or ""
        if r["status"] == "缺口":
            note = "未命中 probe: " + ", ".join(r["missing"])
        note = note.replace("\t", " ").replace("\n", " ")
        lines.append(f"{r['id']}\t{r['section']}\t{r['status']}\t{r['anchor']}\t"
                     f"{r['claim'].replace(chr(9), ' ')}\t{note}")
    if write:
        out = Path(out_path)
        if not out.is_absolute():
            out = ROOT / out_path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        Path(str(out) + ".resolved.json").write_text(
            json.dumps({"source": prefix, "stats": stats, "by_section": by_section, "rows": rows},
                       ensure_ascii=False, indent=1), encoding="utf-8")
    open_gaps = [r["id"] for r in rows if r["status"] == "缺口"]
    open_drift = [r["id"] for r in rows if r["status"] == "漂移（待改）"]
    print(json.dumps({"stats": stats, "by_section": by_section, "gaps": open_gaps,
                      "drifts": [r["id"] for r in rows if r["status"].startswith("漂移")],
                      "drift_fixed": [r["id"] for r in rows if r["status"] == "漂移（已改）"],
                      "drift_open": open_drift,
                      "matrix": (str(Path(out_path)) if write else None)},
                     ensure_ascii=False, indent=1))
    print(f"== 缺口 {len(open_gaps)} 条 / 漂移（待改） {len(open_drift)} 条 / 总 {stats['total']} 条 ==",
          file=sys.stderr)
    for r in rows:
        if r["status"] == "缺口":
            print(f"  · [缺口] {r['id']} {r['section']} 未命中 probe: {', '.join(r['missing'])}", file=sys.stderr)
    return 1 if (open_gaps or open_drift) else 0


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] == "tokens":
        if len(argv) < 2:
            print(__doc__)
            return 2
        pats = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        res = scan(pats)
        for p in pats:
            hs = res[p["pattern"]]
            print(f"--- {p['pattern']}")
            for f, i, t in hs:
                print(f"    {f}:{i}: {t}")
            if not hs:
                print("    (0 命中)")
        return 0
    write = "--no-write" not in argv
    claims = argv[argv.index("--claims") + 1] if "--claims" in argv else str(DEFAULT_CLAIMS)
    matrix = argv[argv.index("--matrix") + 1] if "--matrix" in argv else str(DEFAULT_MATRIX)
    return run(claims, matrix, write)


if __name__ == "__main__":
    raise SystemExit(main())
