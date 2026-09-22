#!/usr/bin/env python3
"""插件清单门（`tools/verify.sh plugins`）："每个功能都由插件提供"的机检形态。

四条断言（双向、可负控）：
  P0 **清单文档集合被真读到**：`docs/design/14-plugin-inventory.md`（主文件）+ 同目录
     `14-plugin-inventory-archive*.md`（归档）—— 归档不是豁免区，与 FR/AC/T 同一套归档机制
     （`tools/check-docs.py` 的 DEF_SETS 口径）；**归档 0 条登记行 = 空读 = 失败**（不许"两边都空"静默通过）。
  P1 目录 ↔ 清单：`host/modules/*.mjs` 每个文件在清单文档集合里有一行（反之亦然）；
  P2 模块 ↔ 装配：每个模块至少被 `host/profiles.mjs` 的某个 `modules` 引用，或在清单里显式标「未接线」；
  P3 Python 侧归属：`src/quotagent/services/*.py` 每个文件在清单文档集合里出现（功能有归属）。

用法：`python3 tools/check-plugin-inventory.py`
退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MODULE_DIR = ROOT / 'host' / 'modules'
INVENTORY = ROOT / 'docs' / 'design' / '14-plugin-inventory.md'
INVENTORY_ARCHIVE_GLOB = '14-plugin-inventory-archive*.md'
PROFILES = ROOT / 'host' / 'profiles.mjs'
SERVICES = ROOT / 'src' / 'quotagent' / 'services'
#: 服务**实体**（阶段 5）：`src/{system,domain}/<插件>/code/*.py`（内核不是「服务」，排除）。
SERVICES_ENTITY = ROOT / 'src'
SERVICES_ENTITY_EXCLUDE = {'kernel'}


def service_names() -> list[str]:
    """「服务」的名字集合 = 旧路径模块名 ∪ 实体文件名。

    阶段 5（EV-175）把实体搬进 `src/<层>/<插件>/code/`、旧路径只剩**薄重导** ⇒ 只扫旧目录的话，
    「功能有归属」这条会在转发文件上成立，而**实体**（真正的那份实现）没人管；两边都扫才不空转。
    名字去重后与旧口径逐名相同（薄重导与实体同名）。
    """
    names = {p.stem for p in SERVICES.glob('*.py') if p.stem != '__init__'}
    for layer in ('system', 'domain'):
        for plugin_dir in (SERVICES_ENTITY / layer).glob('*/code/*.py'):
            if plugin_dir.parent.parent.name in SERVICES_ENTITY_EXCLUDE:
                continue
            if plugin_dir.stem != '__init__':
                names.add(plugin_dir.stem)
    return sorted(names)

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    results.append((name, bool(ok), detail))


def inventory_files() -> tuple[list[Path], list[Path]]:
    """清单文档集合 = (主文件 + 同目录归档, 其中的归档文件)。"""
    archives = sorted(p for p in INVENTORY.parent.glob(INVENTORY_ARCHIVE_GLOB) if p.is_file())
    return [INVENTORY, *archives], archives


def inventory_text() -> tuple[str, dict[str, int]]:
    """把清单文档集合**全文读进来**（读不到 = 空串，由 P0 判红），并逐文件数**登记名**。

    登记名 = 该文件里出现的 `host/modules/<x>.mjs` 模块名 + 它贡献的 `services/<x>.py` 服务名
    （后者与 P3 的"功能有归属"同一口径：服务名以子串出现即算）。归档必须**真的贡献登记名**，
    否则"两边都空"会让 P1/P3 静默通过。
    """
    services = service_names()
    modules = sorted(p.stem for p in MODULE_DIR.glob('*.mjs') if p.stem != 'index')
    per: dict[str, int] = {}
    chunks: list[str] = []
    for path in inventory_files()[0]:
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            per[str(path.relative_to(ROOT))] = 0
            continue
        chunks.append(text)
        contributed = {name for name in modules if f'`host/modules/{name}.mjs`' in text}
        contributed |= {name for name in services if name in text}
        per[str(path.relative_to(ROOT))] = len(contributed)
    return '\n'.join(chunks), per


def main() -> int:
    for path in (MODULE_DIR, INVENTORY, PROFILES, SERVICES):
        if not path.exists():
            print(f'插件清单门：缺少 {path}', file=sys.stderr)
            return 2

    files, archives = inventory_files()
    text, per_file = inventory_text()
    empty = [rel for rel, count in per_file.items() if count == 0]
    check('P0 清单文档集合（主文件 + 归档）都被真读到（归档 0 条登记行 = 空读 = 失败）',
          bool(text) and not empty,
          f'定义文件 {[str(p.relative_to(ROOT)) for p in files]}；逐文件登记行={per_file}；空读={empty}')

    modules = sorted(p.stem for p in MODULE_DIR.glob('*.mjs') if p.stem != 'index')
    # `index.mjs` 是模块发现入口（不是插件），不进"清单→目录"比对
    documented = sorted({m.group(1) for m in re.finditer(r'`host/modules/([a-z0-9-]+)\.mjs`', text)}
                        - {'index'})

    undocumented = [name for name in modules if name not in documented]
    phantom = [name for name in documented if name not in modules]
    check('P1 目录→清单：每个进树模块在清单里有一行（新增功能必须登记归属）',
          not undocumented, f'模块 {modules}；未登记={undocumented}')
    check('P1 清单→目录：清单里的模块行都有对应文件（不得引用不存在的插件）',
          not phantom, f'清单里多出={phantom}')

    profiles_text = PROFILES.read_text(encoding='utf-8')
    wired = set(re.findall(r"'([a-z0-9-]+)'", ' '.join(re.findall(r'modules: \[(.*?)\]', profiles_text))))
    unwired = [name for name in modules if name not in wired]
    # 显式声明「未接线」的行不算漏（诚实允许尚未装配的插件）
    allowed_unwired = [name for name in unwired if f'`host/modules/{name}.mjs`' in text and '未接线' in text]
    check('P2 模块→装配：每个模块至少被一个 profile 引用，或在清单里显式标「未接线」',
          not [n for n in unwired if n not in allowed_unwired],
          f'profile 引用={sorted(wired)}；未接线={unwired}（已显式标注={allowed_unwired}）')

    services = service_names()
    missing_owner = [name for name in services if name not in text]
    check('P3 Python 功能归属：每个 `services/*.py` 在清单里出现（功能有归属）',
          not missing_owner, f'服务 {len(services)} 个；未归属={missing_owner}')

    checks = [{'name': name, 'ok': ok, 'detail': detail} for name, ok, detail in results]
    for item in checks:
        print(f"{'[ok]  ' if item['ok'] else '[FAIL]'} {item['name']}")
        if item['detail']:
            print(f"        {item['detail']}")
    failed = [item for item in checks if not item['ok']]
    print(f"RESULT: {'PASS' if not failed else 'FAIL'}（插件清单门 {len(checks) - len(failed)}/{len(checks)}）")
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
