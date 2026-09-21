"""check-fr-coverage —— 把「每个功能都由插件提供」变成机检（`tools/verify.sh coverage`）。

读 `docs/design/15-requirements-coverage.md`（需求覆盖矩阵），断言：
  A1 双向全覆盖：FR **定义集合**（`docs/work/functional-requirements.md` + 同目录
     `functional-requirements-archive*.md`）里的每条 FR 在矩阵里都有一行，且矩阵里没有伪造的 FR ID；
     另加守卫：集合非空、归档文件被读到（归档 0 条 FR 行 = 空读 = 失败，不许静默变绿）；
  A2 双向全覆盖：`host/modules/*.mjs` 里每个插件在矩阵里都有一行，反之亦然；
  A3 **承载体必须真实存在**（防"矩阵里写一个不存在的文件"）；
  A4 状态只能是 直引/映射/缺口/存疑；【缺口】【存疑】必须逐条列在矩阵的登记小节里（不许悄悄留洞）；
  A5 每个插件至少归属 1 条 FR 或 AC（"功能由插件提供"的落点）；
  A6 内建负控：拿"篡改过的矩阵"跑一遍**必须变红**（门不是橡皮图章）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / 'docs/design/15-requirements-coverage.md'
FR_MAIN = ROOT / 'docs/work/functional-requirements.md'
FR_ARCHIVE_GLOB = 'functional-requirements-archive*.md'
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def read(p: Path) -> str:
    return p.read_text(encoding='utf-8', errors='ignore') if p.exists() else ''


def fr_archive_files() -> list[Path]:
    """FR 归档文件（与主文件同目录、名字匹配 glob 的每个文件）。"""
    return sorted(p for p in FR_MAIN.parent.glob(FR_ARCHIVE_GLOB) if p.is_file())


def fr_definition_text() -> str:
    """FR **定义集合**的正文 = 主文件 + 同目录下所有 `functional-requirements-archive*.md`。

    归档只改变"行写在哪"，**不改变判据**：搬进归档的 FR 行仍必须被覆盖矩阵逐条覆盖
    （A1 双向：文档里缺一条红、矩阵里伪造一条红）。口径与 `tools/check-docs.py` 的 FR 定义集合一致。
    """
    return '\n'.join(read(p) for p in [FR_MAIN, *fr_archive_files()])


def rows(section: str) -> list[list[str]]:
    out = []
    for line in section.splitlines():
        line = line.strip()
        if not line.startswith('|') or set(line) <= set('|- '):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if cells and cells[0].lower() in ('fr', '插件', 'plugin', 'id'):
            continue
        out.append(cells)
    return out


def section_of(text: str, title_kw: str) -> str:
    parts = re.split(r'^##+ ', text, flags=re.M)
    for p in parts[1:]:
        if title_kw in p.split('\n', 1)[0]:
            return p
    return ''


def evaluate(matrix_text: str, allow_debt: bool = True) -> list[dict]:
    """对给定矩阵文本求值，返回断言列表（供负控复用）。"""
    res: list[dict] = []
    fr_doc = fr_definition_text()
    ac_doc = read(ROOT / 'docs/work/acceptance-criteria.md')
    frs = sorted(set(re.findall(r'FR-[A-Z]+-\d+', fr_doc)))
    acs = set(re.findall(r'AC-[A-Z]+-\d+', ac_doc))
    # FR 的定义是**集合**（主文件 + 同目录归档）：归档不是豁免区 —— 搬进归档的 FR 行
    # 仍必须被矩阵逐条覆盖（双向：缺一条红、伪造一条红）。这里另加"集合非空 + 归档被读到"的守卫，
    # 否则"两边都没读到"会让 A1 静默变绿（缺 0、伪造 0）。
    archives = fr_archive_files()
    empty_archives = [str(p.relative_to(ROOT)) for p in archives
                      if not re.search(r'^\| FR-', read(p), re.M)]
    fr_rows = len(re.findall(r'^\| FR-', fr_doc, re.M))
    res.append({"name": "FR 定义集合非空且归档被读到（主文件 + 同目录归档；归档 0 条 FR 行 = 空读）",
                "ok": fr_rows > 0 and not empty_archives,
                "detail": f"FR 行 {fr_rows} 条；归档 {[str(p.relative_to(ROOT)) for p in archives]}；"
                          f"空读 {empty_archives}"})
    mods = sorted(p.stem for p in (ROOT / 'host/modules').glob('*.mjs') if p.stem != 'index')

    fr_sec = section_of(matrix_text, 'FR 覆盖')
    plug_sec = section_of(matrix_text, '插件归属')
    debt_sec = section_of(matrix_text, '缺口与存疑登记')
    fr_rows = rows(fr_sec) if fr_sec else []
    plug_rows = rows(plug_sec) if plug_sec else []

    fr_ids = [r[0] for r in fr_rows if fr_rows and r and r[0].startswith('FR-')]
    missing = [f for f in frs if f not in fr_ids]
    fake = [i for i in fr_ids if i not in set(frs)]
    res.append({"name": f"矩阵对 FR 文档**双向全覆盖**（定义集合 = 主文件 + 归档，共 {len(frs)} 条）",
                "ok": not missing and not fake,
                "detail": f"缺 {len(missing)} 条{missing[:6]}；伪造 {len(fake)} 条{fake[:6]}"})

    plug_ids = [r[0].strip('`') for r in plug_rows if r and r[0]]
    p_missing = [m for m in mods if m not in plug_ids]
    p_fake = [i for i in plug_ids if i not in set(mods)]
    res.append({"name": f"矩阵对插件目录**双向全覆盖**（{len(mods)} 个插件）",
                "ok": not p_missing and not p_fake,
                "detail": f"缺 {len(p_missing)} 个{p_missing[:6]}；伪造 {len(p_fake)} 个{p_fake[:6]}"})

    # 承载体真实存在
    bad_paths: list[str] = []
    for r in fr_rows:
        if len(r) < 2:
            continue
        for token in re.split(r'[,、\s]+', r[1]):
            t = token.strip('`* ')
            if not t or t in ('—', '-'):
                continue
            if re.fullmatch(r'[a-z0-9-]+', t) and not t.startswith(('src', 'host', 'tools', 'scenarios')):
                cand = ROOT / 'host' / 'modules' / f'{t}.mjs'
                if not cand.exists():
                    bad_paths.append(f'{r[0]}→{t}')
                continue
            if t.endswith('.py') or t.endswith('.mjs') or t.endswith('.sh'):
                if not (ROOT / t).exists():
                    bad_paths.append(f'{r[0]}→{t}')
    res.append({"name": "每条 FR 的承载体**在仓库里真实存在**（防矩阵瞎写）",
                "ok": not bad_paths, "detail": f"不存在的承载体 {len(bad_paths)} 处：{bad_paths[:6]}"})

    # 状态合法性 + 债务显式登记
    bad_status = []
    debt_rows = rows(debt_sec) if debt_sec else []
    debt_ids = {r[0] for r in debt_rows if r and r[0]}
    for r in fr_rows:
        if len(r) < 4:
            continue
        st = r[3].strip('`* ')
        if st not in ('直引', '映射', '缺口', '存疑'):
            bad_status.append(f'{r[0]}:{st}')
        if st in ('缺口', '存疑') and r[0] not in debt_ids:
            bad_status.append(f'{r[0]}:{st}未登记')
    res.append({"name": "状态合法；【缺口】【存疑】**逐条登记**（不许悄悄留洞）",
                "ok": not bad_status,
                "detail": f"问题 {len(bad_status)} 处：{bad_status[:8]}；登记表 {len(debt_ids)} 条"})

    # 每个插件至少 1 条 FR/AC 归属
    no_own = []
    for r in plug_rows:
        if len(r) < 2:
            continue
        owner = r[1]
        if not re.search(r'(FR|AC)-[A-Z]+-\d+', owner):
            no_own.append(r[0])
    res.append({"name": "每个插件至少归属 1 条 FR 或 AC（'功能由插件提供'的落点）",
                "ok": not no_own, "detail": f"无归属插件 {len(no_own)} 个：{no_own[:8]}"})
    if not allow_debt:
        for c in res:
            if '缺口' in c['name'] or '存疑' in c['name']:
                pass
    return res


text = read(MATRIX)
check("矩阵文件存在", MATRIX.exists(), str(MATRIX.relative_to(ROOT)))
if MATRIX.exists():
    CHECKS.extend(evaluate(text))

    # A6 内建负控：篡改后的矩阵必须变红
    neg = []
    tampered = text.replace('直引', '直引', 1)
    tampered = re.sub(r'^\| FR-([A-Z]+)-001 \|.*$', '| FR-\\1-001 | host/modules/__不存在__.mjs | x | 直引 |',
                      tampered, count=1, flags=re.M)
    neg.append(('承载体改成本不存在的文件', evaluate(tampered)))
    tampered2 = re.sub(r'^\| FR-[A-Z]+-002 \|.*$', '', text, count=1, flags=re.M)
    neg.append(('删掉一条 FR 行', evaluate(tampered2)))
    tampered3 = re.sub(r'^\| [a-z][a-z0-9-]+ \| (FR|AC)-.*$', '', text, count=1, flags=re.M)
    neg.append(('删掉一条插件行', evaluate(tampered3)))
    ok_neg = all(any(not c['ok'] for c in r) for _, r in neg)
    check("内建负控：三种篡改（假承载体/删 FR 行/删插件行）**都必须让门变红**", ok_neg,
          '; '.join(f"{n}→{'红' if any(not c['ok'] for c in r) else '竟然绿'}" for n, r in neg))

failed = [c for c in CHECKS if not c['ok']]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=2))
if MATRIX.exists() and failed:
    for c in failed:
        print('FAIL:', c['name'], '|', c['detail'])
sys.exit(0 if not failed else 1)
