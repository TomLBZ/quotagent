#!/usr/bin/env python3
"""插件清单门（`tools/verify.sh plugins`）："每个功能都由插件提供"的机检形态。

三条断言（双向、可负控）：
  P1 目录 ↔ 清单：`host/modules/*.mjs` 每个文件在 `docs/design/14-plugin-inventory.md` 里有一行（反之亦然）；
  P2 模块 ↔ 装配：每个模块至少被 `host/profiles.mjs` 的某个 `modules` 引用，或在清单里显式标「未接线」；
  P3 Python 侧归属：`src/quotagent/services/*.py` 每个文件在清单里出现（功能有归属）。

用法：`python3 tools/check-plugin-inventory.py`
退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = ROOT / 'host' / 'modules'
INVENTORY = ROOT / 'docs' / 'design' / '14-plugin-inventory.md'
PROFILES = ROOT / 'host' / 'profiles.mjs'
SERVICES = ROOT / 'src' / 'quotagent' / 'services'

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    results.append((name, bool(ok), detail))


def main() -> int:
    for path in (MODULE_DIR, INVENTORY, PROFILES, SERVICES):
        if not path.exists():
            print(f'插件清单门：缺少 {path}', file=sys.stderr)
            return 2

    text = INVENTORY.read_text(encoding='utf-8')
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

    services = sorted(p.stem for p in SERVICES.glob('*.py') if p.stem != '__init__')
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
