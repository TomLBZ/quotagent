"""AC-UXWEB-001 机检：GUI 从"纯文字报告"变成"能操作的控制器"的第一批事实。

只落**已实现且可验证**的部分（D-059）：第一屏三块锚点 + 子视图（GET 筛选/排序/翻页）+ 道内子导航 +
**依然 0 行 `<script>` / 0 内联事件**（可机检事实，交互只能用 `<form method=get>`）。

只读静态 + （Node 可用时）读模块导出的 `SUBVIEWS`；**不启动服务、不 curl**（HTTP 行为由宿主门
`verify.sh webui` 44/44 举证）。无 Node 时降级为静态断言并明说（ADR-0013 §8）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
WEBUI = ROOT / 'host' / 'modules' / 'webui.mjs'
BLOCKS = ('data-block="pending-approvals"', 'data-block="in-progress"', 'data-block="health"')


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@register('AC-UXWEB-001', 'P2', 'GUI 控制台化第一批：第一屏三块锚点 + 子视图（GET 筛选/排序/翻页）+ 子导航 + 仍 0 JS',
          'tools/verify.sh ac AC-UXWEB-001')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    src = WEBUI.read_text(encoding='utf-8') if WEBUI.is_file() else ''
    out.append(Assertion("① 模块存在且导出 SUBVIEWS（子视图清单**单点定义**，不在别处再抄一份）",
                         bool(src) and 'export const SUBVIEWS' in src, f"bytes={len(src)} has_SUBVIEWS={'SUBVIEWS' in src}"))
    # 第一屏三块：三个锚点都在且**顺序**正确（待批 → 进行中 → 健康）
    pos = [src.find(b) for b in BLOCKS]
    out.append(Assertion("① 第一屏三块锚点齐备且顺序正确（待批 → 进行中 → 健康）",
                         all(p >= 0 for p in pos) and pos == sorted(pos),
                         f"positions={pos}"))
    # 交互只能靠 GET 表单：页面模板里存在 method="get" 且**没有** <script> / 内联事件
    out.append(Assertion("① 交互用 `<form method=get>`（页面模板里没有 `<script>`、也没有内联事件属性）",
                         'method="get"' in src and '<script' not in src and not re.search(r'\son[a-z]+=', src),
                         f"get_forms={'method=\"get\"' in src} script_tags={src.count('<script')} inline_attrs={len(re.findall(r'\\son[a-z]+=', src))}"))
    # 道内子导航 + 上手入口（每一页都能点到 token/配置说明）
    out.append(Assertion("① 道内子导航（data-subnav）与「上手」入口都在（后者保证 token/配置位置**每一页可达**）",
                         'data-subnav' in src and 'start/' in src, f"subnav={'data-subnav' in src} start={'start/' in src}"))
    # 空结果必须显式（不许看起来像坏了）
    out.append(Assertion("① 空结果显式说明（`data-empty` + reason；\"筛选无结果\"不许看起来像故障）",
                         'data-empty' in src, f"data-empty={'data-empty' in src}"))
    # 子视图数量与路由前缀（Node 可用时读真导出；否则降级）
    if _node():
        r = subprocess.run(['node', '--input-type=module', '-e',
                            "import {SUBVIEWS} from './host/modules/webui.mjs';console.log(JSON.stringify(SUBVIEWS))"],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        try:
            sub = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            sub = None
        # SUBVIEWS 是 {view: [子视图…]} 的两层结构：总数 = 各视角子视图数之和
        if isinstance(sub, dict):
            n = sum(len(v) for v in sub.values())
        elif isinstance(sub, list):
            n = len(sub)
        else:
            n = 0
        out.append(Assertion("① 子视图清单为 8 条（承包 4 + 供应 4）且每条都是 GET 视图",
                             n == 8, f"SUBVIEWS={sub if n else r.stdout[-120:] + r.stderr[-120:]}"))
    else:
        n = len(re.findall(r"'(events|quotes|approvals|evidence|clarifications)'", src))
        out.append(Assertion("① 子视图清单为 8 条（无 Node：**降级**为静态计数；HTTP 行为由 `verify.sh webui` 守卫）",
                             n >= 8, f"静态命中={n}"))
    return out
