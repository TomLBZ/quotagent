"""AC-VIZ-001 机检：比价 heuristics visualizer 的**结构性**事实（真 HTTP 与权重敏感由 `verify.sh bid-heuristics` 举证）。

无 Node 时降级并明说（ADR-0013 §8）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
# 实体已随批 EV-176 搬进插件 `code/`（旧路径只剩薄重导）：静态断言读实体那一份，否则静默判绿。
MOD = ROOT / 'src' / 'domain' / 'bid-heuristics' / 'code' / 'bid-heuristics.mjs'
GATE = ROOT / 'src' / 'domain' / 'bid-heuristics' / 'tests' / 't279-heuristics-gate.mjs'


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@register('AC-VIZ-001', 'P2', '比价 heuristics：权重可调且回显、贡献可分解、私域零泄漏、零写面、页面仍无内联脚本',
          'tools/verify.sh ac AC-VIZ-001')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    src = MOD.read_text(encoding='utf-8') if MOD.is_file() else ''
    gate = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    out.append(Assertion("① 插件与围栏门齐备", bool(src) and bool(gate), f"module={len(src)}B gate={len(gate)}B"))
    # 可调权重 + 贡献分解 + 夹取回显（三个语义标记）
    marks = {'weights': bool(re.search(r'weights', src)), 'contributions': 'contributions' in src,
             'omitted': 'omitted' in src, 'degraded': 'degraded' in src,
             'clamp': bool(re.search(r'clamp|夹取|Math\.min|Math\.max', src))}
    out.append(Assertion("① 语义齐备：可调权重 / 贡献分解 / 有界（omitted）/ 降级（degraded）/ 夹取",
                         all(marks.values()), f"marks={marks}"))
    # 零写面（非注释源码）
    code = '\n'.join(l for l in src.splitlines() if not l.lstrip().startswith(('//', '*', '/*', '#')))
    webui = ROOT / 'host' / 'modules' / 'webui.mjs'
    wsrc = webui.read_text(encoding='utf-8') if webui.is_file() else ''
    chk_code = code + '\n' + '\n'.join(l for l in wsrc.splitlines()
                                       if not l.lstrip().startswith(('//', '*', '/*', '#')))
    w = sorted(set(re.findall(r'writeFileSync|appendFileSync|createWriteStream|mkdirSync|child_process|fetch\(', code)))
    out.append(Assertion("① 宿主侧零写面/零外部副作用（不写文件、不起子进程、不联网）", not w, f"命中={w}"))
    # 交互只用 GET 表单；页面模板不含内联脚本
    has_form = bool(re.search(r"method=[\"']?get", chk_code, re.I))
    out.append(Assertion("① 交互用 GET 表单（非注释源码里无 `<script`、无内联事件属性）",
                         has_form and '<script' not in chk_code and not re.search(r'\son[a-z]+=', chk_code),
                         f"get_form={has_form} script={chk_code.count('<script')}"))
    # 门里必须有权重敏感 + 私域哨兵负控 + 变异自证
    gm = {k: (k in gate) for k in ('敏感', '哨兵', '变异', 'mutat', '还原')}
    out.append(Assertion("① 围栏门含权重敏感/私域哨兵负控/变异自证（不是空壳门）", sum(gm.values()) >= 4, f"marks={gm}"))
    v = (ROOT / 'tools' / 'verify.sh').read_text(encoding='utf-8')
    out.append(Assertion("① `verify.sh bid-heuristics` 门已挂", 'bid-heuristics)' in v and 'check-heuristics-route.py' in v,
                         "gate=" + str('bid-heuristics)' in v)))
    if _node():
        r = subprocess.run(['node', '--input-type=module', '-e',
                            "import * as M from './host/modules/bid-heuristics.mjs';console.log(JSON.stringify(Object.keys(M)))"],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        try:
            exported = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            exported = []
        out.append(Assertion("① 插件模块可加载且导出预期符号（非空转）", 'provides' in exported or 'name' in exported,
                             f"exports={exported[:6]}"))
    else:
        out.append(Assertion("① 插件模块存在且非空（无 Node：**降级**；HTTP 行为由 `verify.sh bid-heuristics` 守卫）",
                             len(src) > 5000, f"bytes={len(src)}"))
    return out
