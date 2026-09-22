#!/usr/bin/env python3
"""plugin-requirements 门（`tools/verify.sh plugin-requirements`）——「每条需求都归属到插件」的机检。

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1（ADR-0021 的四条硬规则）；归属真源 = `docs/design/15-requirements-coverage.md`。
本门把"需求归属到插件"从口号变成**可负控的断言**（映射表 = `docs/work/plugin-requirements-map.md`）：

  A1 映射表存在、非空、每行 id 形态合法（`^(system|domain|userspace)/<name>[/<name>]$`，与 `tools/plugin.sh` 同一套形状）。
  A2 `tools/plugin.sh list --json` 枚举到的**每个插件**在映射表里有行（真跑 CLI，不是读目录猜）；枚举为空 = 失败（不许空转变绿）。
  A3 映射表引用的每个 FR 号都在 **FR 定义集合**内（`docs/work/functional-requirements.md` + 同目录
     `functional-requirements-archive*.md`；归档不是豁免区，与 `tools/check-docs.py` 同一口径）。
  A4 每条 FR **至少被一个插件认领**（未认领逐条列出）。
  A5 每条 FR **只被一个插件认领**（唯一指针；一条 FR 出现两次即红）。
  A6a 每个 `req=` 指向的需求文档**真实存在**（不得指向不存在的文件）。
  A6b `src/<层>/<插件>/requirements/` **存在**的插件**都在映射表里有行**（目录不无主）。
  A6c 需求文档位置（**三条双向**）：① 不在标准布局位置（非 `src/<层>/<插件>/requirements/`）的插件逐条登记；
     ② §4.2 **归位台账**逐条核对（原位置已清空、现位置真实存在且与 §1 的 `req=` 同一文件）；
     ③ 台账 ∪ 「原生就在标准位置」名单 == **全部有 `req=` 的插件**（一条不漏、一条不多）。
  A7 没有需求文档的插件**逐条列在** §4.1 缺口清单（双向：清单里也不得多出插件）。
  A8 状态取值合法（done/partial/missing）；`done` 行必须有真证据（门名 / `ac <AC-ID>` / `EV-`）。

  F0 基线（未变异）在同一套断言上**不红**（否则"变异变红"说明不了任何事）。
  F1..F5 **5 处单点变异全红**：① 抽掉一行插件 ② 把一条 FR 改成不存在的号 ③ 把一条 FR 重复认领
     ④ 抽掉一条 `req=` 标记 ⑤ 把台账一行的「现位置」改成不存在的路径。
     变异只写在 `tmp/` 的临时副本里。
  F6 防假变异：不存在的锚点必须返回 None（不许"变异"没改到任何字节还判红）。
  F7 全过程**产品树字节不变**（映射表 sha256 前后一致）。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP = ROOT / "docs" / "work" / "plugin-requirements-map.md"
FR_MAIN = ROOT / "docs" / "work" / "functional-requirements.md"
FR_ARCHIVE_GLOB = "functional-requirements-archive*.md"
PLUGIN_SH = ROOT / "tools" / "plugin.sh"
TMP = ROOT / "tmp"

# 插件 id 形状（与 `src/system/runtime/code/plugin-registry.mjs` 的 PLUGIN_ID_RE 同一套）
PLUGIN_ID_RE = re.compile(r"^(?:system|domain|userspace)/[a-z][a-z0-9-]{0,31}(?:/[a-z][a-z0-9-]{0,31})?$")
ROW_RE = re.compile(r"^\|\s*`(?P<id>[^`]+)`\s*\|(?P<rest>.*)$")
FR_ID_RE = re.compile(r"\bFR-[A-Z]+-\d+\b")
REQ_RE = re.compile(r"req=(?P<path>[^\s`、]+)")
STATUSES = ("done", "partial", "missing")

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def fr_definition_files() -> list[Path]:
    return [FR_MAIN, *sorted(p for p in FR_MAIN.parent.glob(FR_ARCHIVE_GLOB) if p.is_file())]


def fr_definition_set() -> tuple[set[str], dict[str, int]]:
    """FR 定义集合（主文件 + 同目录归档）。返回 (ids, 每文件行数)。"""
    ids: set[str] = set()
    per: dict[str, int] = {}
    for path in fr_definition_files():
        text = read(path)
        rows = re.findall(r"^\|\s*(FR-[A-Z0-9-]*\d+)\s*\|", text, re.M)
        per[str(path.relative_to(ROOT))] = len(set(rows))
        ids |= {r for r in rows if r.startswith("FR-")}
    return ids, per


def parse_map(text: str) -> list[dict]:
    """解析映射表 §1 的行：id / frs / carriers / status / evidence / req。"""
    out: list[dict] = []
    for line in text.splitlines():
        match = ROW_RE.match(line.strip())
        if not match:
            continue
        pid = match.group("id").strip()
        if not PLUGIN_ID_RE.match(pid):
            continue
        cells = [c.strip() for c in match.group("rest").split("|")]
        if len(cells) < 4:
            continue
        frs = FR_ID_RE.findall(cells[0])
        evidence = cells[3]
        reqs = sorted({m.group("path") for m in REQ_RE.finditer(evidence)})
        out.append({"id": pid, "frs": frs, "status": cells[2].strip("`* "), "evidence": evidence, "reqs": reqs})
    return out


def plugin_cli_ids() -> tuple[set[str], str]:
    """真跑 `tools/plugin.sh list --json`，取枚举到的插件 id（stdout 最后一行 JSON，帧纪律）。"""
    try:
        proc = subprocess.run([str(PLUGIN_SH), "list", "--json"], cwd=str(ROOT), capture_output=True,
                              text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return set(), f"plugin.sh 不可执行：{type(exc).__name__}"
    payload: dict = {}
    for line in reversed([ln for ln in proc.stdout.splitlines() if ln.strip()]):
        try:
            payload = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    ids = {item.get("id") for item in payload.get("plugins", []) if item.get("id")}
    note = (f"rc={proc.returncode} count={payload.get('count')} ids={len(ids)} "
            f"degraded={[d.get('id') for d in payload.get('degraded', [])]}")
    return ids, note


def requirements_dir_ids() -> set[str]:
    """`src/<层>/<插件>/requirements/`（含 userspace 的 `<ns>/<插件>`）里**存在**的插件 id 集合。"""
    found: set[str] = set()
    for layer in ("system", "domain"):
        base = ROOT / "src" / layer
        if not base.is_dir():
            continue
        for plugin in sorted(p for p in base.iterdir() if p.is_dir()):
            if (plugin / "requirements").is_dir():
                found.add(f"{layer}/{plugin.name}")
    userspace = ROOT / "src" / "userspace"
    if userspace.is_dir():
        for ns in sorted(p for p in userspace.iterdir() if p.is_dir()):
            for plugin in sorted(p for p in ns.iterdir() if p.is_dir()):
                if (plugin / "requirements").is_dir():
                    found.add(f"userspace/{ns.name}/{plugin.name}")
    return found


def gap_list_ids(text: str) -> set[str]:
    """映射表 §4.1 缺口清单里逐条列出的插件 id（`| system | `a` `b` | ... |` → 补齐层前缀）。"""
    ids: set[str] = set()
    in_gap = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_gap = "缺口清单" in stripped
            continue
        if stripped.startswith("### "):          # §4.2 的子节不属于 §4.1
            in_gap = False
            continue
        if not in_gap or not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 2 or cells[0] not in ("system", "domain", "userspace"):
            continue
        for token in re.findall(r"`([^`]+)`", cells[1]):
            token = token.strip()
            if not token:
                continue
            qualified = token if "/" in token else f"{cells[0]}/{token}"
            # 只认合法插件 id 形状：反引号里的普通名词（路径片段、文件名）不算缺口条目
            if PLUGIN_ID_RE.match(qualified):
                ids.add(qualified)
    return ids


def old_requirements_path(pid: str) -> str:
    """某个插件在 `T-318` 过渡形态下的需求文档路径（由**规则**推出，不手写 58 条）。"""
    parts = pid.split("/")
    if parts[0] == "userspace":
        return f"docs/work/plugin-requirements-userspace-{parts[1]}-{parts[2]}.md"
    return f"docs/work/plugin-requirements-{parts[0]}-{parts[1]}.md"


def ledger_section(text: str) -> tuple[set[str], list[dict]]:
    """§4.2 **归位台账**：返回（台账里逐条列出的插件 id，台账行）。

    台账口径（机检 A6c）：一行一插件，列 = `插件 id | 现位置（标准布局）| 状态`；
    原位置由 `old_requirements_path()` 的**规则**推出（不写进表里，表因此不会与规则漂移）。
    """
    in_sec = False
    ids: set[str] = set()
    rows: list[dict] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_sec = False
            continue
        if stripped.startswith("### "):
            in_sec = "归位台账" in stripped
            continue
        if not in_sec or not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if not cells or not (cells[0].startswith("`") and cells[0].endswith("`")):
            continue
        pid = cells[0].strip("`").strip()
        if not PLUGIN_ID_RE.match(pid):
            continue
        rows.append({"id": pid,
                     "to": cells[1].strip("`").strip() if len(cells) > 1 else "",
                     "state": cells[2].strip("`* ").strip() if len(cells) > 2 else ""})
        ids.add(pid)
    return ids, rows


def native_standard_ids(text: str) -> set[str]:
    """§4.2 里标明的「原生就在标准位置（从未搬动，故不入台账）」名单。"""
    found: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith(">") or "原生就在标准位置" not in stripped.replace("*", ""):
            continue
        for token in re.findall(r"`([^`]+)`", stripped):
            token = token.strip()
            if PLUGIN_ID_RE.match(token):
                found.add(token)
    return found


def evaluate(text: str, cli_ids: set[str], cli_note: str, label: str) -> list[tuple[str, bool, str]]:
    """对给定映射表文本求值，返回断言列表（正控与变异共用同一套，杜绝两套判据）。"""
    res: list[tuple[str, bool, str]] = []
    add = lambda name, ok, detail="": res.append((f"{label}{name}", bool(ok), detail))  # noqa: E731
    rows = parse_map(text)
    ids = [r["id"] for r in rows]
    fr_defs, per_file = fr_definition_set()

    add("A1 映射表存在且非空（每行 id 形态合法）", bool(text) and len(rows) > 0 and len(set(ids)) == len(ids),
        f"行 {len(rows)}；重复 id {[i for i in set(ids) if ids.count(i) > 1]}；文件 {MAP.relative_to(ROOT)}")

    missing_rows = sorted(cli_ids - set(ids))
    add("A2 `plugin.sh list` 枚举到的每个插件在映射表里有行（真跑 CLI；枚举为空 = 失败）",
        bool(cli_ids) and not missing_rows,
        f"CLI ids={len(cli_ids)}（{cli_note}）；缺行={missing_rows}")

    claimed = [f for r in rows for f in r["frs"]]
    fake = sorted({f for f in claimed if f not in fr_defs})
    add(f"A3 映射表引用的 FR 都在定义集合内（{len(fr_defs)} 条：主文件 + {len(per_file) - 1} 个归档）",
        not fake, f"定义文件={per_file}；伪造 {len(fake)} 条 {fake[:8]}")

    unclaimed = sorted(fr_defs - set(claimed))
    add("A4 每条 FR 至少被一个插件认领", not unclaimed,
        f"未认领 {len(unclaimed)} 条 {unclaimed[:8]}")

    dup = sorted({f for f in claimed if claimed.count(f) > 1})
    add("A5 每条 FR **只被一个插件**认领（唯一指针：无人重复认领）", not dup, f"重复 {len(dup)} 条 {dup[:8]}")

    req_rows = {r["id"]: r["reqs"] for r in rows if r["reqs"]}
    req_missing_files = [f"{pid}:{path}" for pid, paths in req_rows.items() for path in paths
                         if not (ROOT / path).is_file()]
    add("A6a 每个 `req=` 指向的需求文档**真实存在**（不得指向不存在的文件）",
        not req_missing_files, f"标的文档 {sum(len(v) for v in req_rows.values())} 份；缺文件 {req_missing_files}")

    req_dirs = requirements_dir_ids()
    add("A6b 有 `src/<层>/<插件>/requirements/` 目录的插件**都在映射表里有行**（目录不无主）",
        req_dirs <= set(ids), f"目录侧 {sorted(req_dirs)}；无行的={sorted(req_dirs - set(ids))}")

    # A6c（`T-321` 收紧）：未归位逐条登记 + **归位台账**逐条核对（原位置已清 / 现位置真实存在且 == `req=`）+
    # 台账 ∪ 原生标准位置名单 == 全部有 `req=` 的插件 —— 三条都是双向，任一侧多写少写即红。
    std_ids = {pid for pid, paths in req_rows.items()
               if all(path.startswith(f"src/{pid}/requirements/") for path in paths)}
    nonstd_expect = set(req_rows) - std_ids
    ledger_ids, ledger_rows = ledger_section(text)
    native_ids = native_standard_ids(text)
    registered_nonstd = {row["id"] for row in ledger_rows if row["state"] != "已归位"}
    problems: list[str] = []
    if nonstd_expect != registered_nonstd:
        problems.append(f"未归位集合与台账不符：未登记={sorted(nonstd_expect - registered_nonstd)}；"
                        f"多登记={sorted(registered_nonstd - nonstd_expect)}")
    if ledger_ids & native_ids:
        problems.append(f"同一插件同时进了台账与「原生标准位置」名单：{sorted(ledger_ids & native_ids)}")
    if ledger_ids | native_ids != set(req_rows):
        problems.append(f"台账 ∪ 原生名单 != 全部有 req= 的插件：缺="
                        f"{sorted(set(req_rows) - ledger_ids - native_ids)}；"
                        f"多={sorted((ledger_ids | native_ids) - set(req_rows))}")
    for row in ledger_rows:
        if row["state"] != "已归位":
            problems.append(f"台账状态只允许 `已归位`（未归位的行必须同时出现在未归位集合里）："
                            f"{row['id']}={row['state']!r}")
            continue
        old_rel = old_requirements_path(row["id"])
        if (ROOT / old_rel).exists():
            problems.append(f"标了已归位但原位置还在：{old_rel}")
        if not row["to"] or not (ROOT / row["to"]).is_file():
            problems.append(f"台账的现位置不存在：{row['id']} → {row['to']!r}")
        if row["to"] not in req_rows.get(row["id"], []):
            problems.append(f"台账现位置与 §1 的 `req=` 不一致：{row['id']} 台账={row['to']!r} "
                            f"req={req_rows.get(row['id'])}")
    add(f"A6c 需求文档位置（双向）：未归位 {len(nonstd_expect)} 个逐条登记 + **归位台账** {len(ledger_rows)} 条逐条核对"
        f"（原位置已清 / 现位置真实存在且 == `req=`）+ 台账 ∪ 原生名单({len(native_ids)}) == 全部有 `req=` 的插件"
        f"（{len(req_rows)}）",
        not problems,
        "; ".join(problems[:6]) or f"未归位 0；台账 {len(ledger_rows)} 条与规则逐条一致（原位置均已不存在）")

    gaps = gap_list_ids(text)
    no_req = {r["id"] for r in rows if not r["reqs"]}
    add("A7 没有需求文档的插件逐条列在 §4.1 缺口清单（双向：清单里不许多出插件）",
        gaps == no_req,
        f"缺文档 {len(no_req)} 个；清单 {len(gaps)} 个；未列={sorted(no_req - gaps)[:8]}；多列={sorted(gaps - no_req)[:8]}")

    bad = [f"{r['id']}:{r['status']}" for r in rows if r["status"] not in STATUSES]
    no_ev = [r["id"] for r in rows if r["status"] == "done"
             and not re.search(r"`[^`]+`|ac\s+AC-\d|EV-\d+", r["evidence"])]
    add("A8 状态合法（done/partial/missing）且 `done` 行有真证据（门名 / `ac <AC-ID>` / `EV-`）",
        not bad and not no_ev, f"非法状态 {bad[:6]}；done 但无证据 {no_ev[:6]}")
    return res


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_mutation(source: str, find: str, replace: str) -> str | None:
    """唯一锚点替换；找不到或多于一处的"变异"返回 None（= 假变异，调用方判红）。"""
    if source.count(find) != 1:
        return None
    return source.replace(find, replace, 1)


def drop_line(source: str, needle: str) -> str | None:
    """删掉含 `needle` 的**整行**（锚点必须唯一，且必须真的少了一行）。"""
    if source.count(needle) != 1:
        return None
    lines = source.splitlines(keepends=True)
    kept = [line for line in lines if needle not in line]
    return None if len(kept) != len(lines) - 1 else "".join(kept)


def main() -> int:
    for path in (MAP, FR_MAIN, PLUGIN_SH):
        if not path.exists():
            print(f"plugin-requirements 门：缺少 {path}", file=sys.stderr)
            return 2
    TMP.mkdir(exist_ok=True)
    original = MAP.read_text(encoding="utf-8")
    sha_before = sha256(MAP)
    cli_ids, cli_note = plugin_cli_ids()

    RESULTS.extend(evaluate(original, cli_ids, cli_note, ""))
    baseline_red = [name for name, ok, _ in RESULTS if not ok]

    # --- F1..F4：4 处单点变异（临时副本） --------------------------------------------
    MUTATIONS = [
        {"name": "F1 抽掉一行插件（`system/kernel`）必须让 A4（每条 FR 被认领）变红",
         "mutate": lambda text: drop_line(text, "| `system/kernel` | FR-LEDGER-001"),
         "must_red": "A4 每条 FR 至少被一个插件认领",
         "why": "kernel 名下有 19 条 FR，抽掉这一行 ⇒ 19 条 FR 无人认领"},
        {"name": "F2 把一条 FR 改成不存在的号（FR-LEDGER-004 → FR-LEDGER-009）必须让 A3 变红",
         "mutate": lambda text: apply_mutation(text, "FR-LEDGER-004", "FR-LEDGER-009"),
         "must_red": "A3 映射表引用的 FR 都在定义集合内",
         "why": "定义集合里没有 FR-LEDGER-009 ⇒ 伪造引用"},
        {"name": "F3 把一条 FR 重复认领（FR-MARKET-006 → FR-MARKET-005）必须让 A5 变红",
         "mutate": lambda text: apply_mutation(text, "FR-MARKET-006", "FR-MARKET-005"),
         "must_red": "A5 每条 FR **只被一个插件**认领",
         "why": "唯一指针被打破：同一条 FR 出现在两处"},
        {"name": "F4 抽掉一条 `req=` 标记（system/mail，标准位置）必须让 A6c 变红",
         "mutate": lambda text: apply_mutation(text, " · `req=src/system/mail/requirements/README.md`", ""),
         "must_red": "A6c 需求文档位置",
         "why": "台账里有 system/mail（已归位）却没有 `req=` ⇒ 台账 ∪ 原生名单 != 全部有 req= 的插件"},
        {"name": "F5 把台账一行的「现位置」改成不存在的路径（`domain/rfq`）必须让 A6c 变红",
         "mutate": lambda text: apply_mutation(
             text, "| `domain/rfq` | `src/domain/rfq/requirements/README.md` | 已归位 |",
             "| `domain/rfq` | `src/domain/rfq/requirements/MISSING.md` | 已归位 |"),
         "must_red": "A6c 需求文档位置",
         "why": "台账必须指向**真实存在**且与该插件 `req=` 一致的文件（不许指到不存在的路径）"},
    ]
    staged: list[str] = []
    for index, mutation in enumerate(MUTATIONS, start=1):
        mutated = mutation["mutate"](original)
        if not isinstance(mutated, str) or mutated == original:
            check(f"{mutation['name']}", False,
                  f"假变异：锚点唯一性与字节变化校验未过（{mutation['why']}）")
            continue
        staged.append(mutated)
        copy_dir = TMP / f"plugin-requirements-mutant-{index}"
        copy_dir.mkdir(parents=True, exist_ok=True)
        mutant_path = copy_dir / "plugin-requirements-map.md"
        mutant_path.write_text(str(mutated), encoding="utf-8")
        res = evaluate(mutant_path.read_text(encoding="utf-8"), cli_ids, cli_note, f"[变异{index}] ")
        reds = [(name, ok) for name, ok, _ in res if not ok]
        hit = [name for name, ok in reds if mutation["must_red"] in name]
        check(f"{mutation['name']}", bool(hit),
              f"变异体红 {len(reds)} 项（命中指定断言={bool(hit)}）；{mutation['why']}；"
              f"红项={[n.split('] ')[-1][:34] for n, _ in reds][:6]}")

    add_baseline_ok = not baseline_red
    check("F0 基线（未变异）在同一套断言上**不红**（否则 5 处变异变红都是空转）",
          add_baseline_ok, f"基线红项={baseline_red}")
    check("F6 防假变异：不存在的锚点必须返回 None（否则『变异变红』说明不了任何事）",
          apply_mutation(original, "这一段映射表里根本不存在-MUTATION-ANCHOR", "x") is None
          and drop_line(original, "根本不存在的行锚点") is None,
          "apply_mutation / drop_line 都对不存在的锚点返回 None")
    check("F7 全过程**产品树字节不变**（变异只写在 tmp/ 的临时副本里）",
          sha256(MAP) == sha_before and MAP.read_text(encoding="utf-8") == original,
          f"before={sha_before[:12]} after={sha256(MAP)[:12]}；变异副本 {len(staged)} 份在 tmp/")

    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in RESULTS:
        print(f"{'[ok]  ' if ok else '[FAIL]'} {name}")
        if detail:
            print(f"        {detail}")
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（plugin-requirements 门 "
          f"{len(RESULTS) - len(failed)}/{len(RESULTS)}）")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
