"""AC-AGENTRT-006 机检：agent 运行期插件（上下文 / 记忆四层 / harness）。

分两半（关键：**无 Node 也要全绿** —— ADR-0013 §8 要求 phase≠P1 的 AC 无 Node 可复跑）：
  · 静态半边（永远跑）：三个模块存在、**零写面/零外部副作用**（不得出现写文件、子进程、网络、随机、定时器）、
    四层记忆的名字与三类拒绝码在源码里齐全；
  · 动态半边（Node 可用时）：真跑 `host/t275-runtime-gate.mjs`，断言 `failures:0` 且 `total>=22`；
    Node 不可用时**明说降级**（宿主语义由围栏门与 `verify.sh` 的 gate 守卫，不靠这一条假装跑过）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
GATE = ROOT / 'src' / 'system' / 'agent-runtime' / 'tests' / 't275-runtime-gate.mjs'
MODULES = {
    'agent-context': ROOT / 'host' / 'modules' / 'agent-context.mjs',
    'agent-memory': ROOT / 'host' / 'modules' / 'agent-memory.mjs',
    'agent-harness': ROOT / 'host' / 'modules' / 'agent-harness.mjs',
}
# 宿主模块**不得**有的东西（每一条单独断言，违规要报出命中文本）
FORBIDDEN = {
    '写文件': r'writeFileSync|appendFileSync|createWriteStream|writeFile\(|mkdirSync|rmSync|unlinkSync',
    '子进程': r'child_process|spawnSync|execSync|execFileSync',
    '网络': r'\bfetch\(|node:http|node:net|https?://',
    '随机': r'Math\.random|crypto\.randomBytes|randomUUID',
    '定时器': r'setTimeout|setInterval|setImmediate',
}


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _gate_result() -> dict:
    if not _node():
        return {'skipped': True}
    r = subprocess.run(['node', str(GATE.name)], cwd=str(GATE.parent), capture_output=True, text=True, timeout=600)
    line = ''
    for candidate in reversed((r.stdout or '').splitlines()):
        if '"total"' in candidate and '"failures"' in candidate:
            line = candidate.strip()
            break
    try:
        report = json.loads(line)
    except Exception:  # noqa: BLE001
        return {'error': (r.stdout + r.stderr)[-400:], 'rc': r.returncode}
    report['rc'] = r.returncode
    return report


@register('AC-AGENTRT-006', 'P2', '运行期插件的有界与显式降级：截断必须报数、不可用必须 degraded+reason，空上下文不得报 ok:true',
          'tools/verify.sh ac AC-AGENTRT-006')
def check() -> list[Assertion]:
    out: list[Assertion] = []

    # ① 三个模块 + 围栏门都在
    missing = [name for name, path in MODULES.items() if not path.is_file()] + ([] if GATE.is_file() else ['gate'])
    out.append(Assertion("① 三个运行期模块与围栏门都在（agent-context / agent-memory / agent-harness / gate）",
                         not missing, f"缺失={missing}"))

    # ② 零写面 / 零外部副作用（逐类断言，报出命中文本）
    for label, pattern in FORBIDDEN.items():
        hits = []
        for path in MODULES.values():
            if not path.is_file():
                continue
            for m in re.finditer(pattern, path.read_text(encoding='utf-8')):
                hits.append(f"{path.name}:{m.group(0)}")
        out.append(Assertion(f"② 宿主模块零「{label}」（{pattern[:34]}…）", not hits, f"命中={hits[:4]}"))

    # ③ 四层记忆与三类拒绝码在源码里齐全（静态可见的边界）
    mem_src = MODULES['agent-memory'].read_text(encoding='utf-8') if MODULES['agent-memory'].is_file() else ''
    layers = {k: (k in mem_src) for k in ("'session'", "'project'", "'policy'", "'cross_party'")}
    out.append(Assertion("③ 四层记忆名字齐全（session / project / policy / cross_party）",
                         all(layers.values()), f"layers={layers}"))
    codes = {c: (c in mem_src) for c in ('memory-session-persist-refused', 'memory-policy-human-only')}
    ctx_src = MODULES['agent-context'].read_text(encoding='utf-8') if MODULES['agent-context'].is_file() else ''
    codes.update({c: (c in ctx_src) for c in ('context-private-refused', 'context-cross-party-refused')})
    out.append(Assertion("③ 三类关键拒绝码齐全（会话落盘 / 策略只人写 / 私域与跨方不进上下文）",
                         all(codes.values()), f"codes={codes}"))

    # ④ 真跑围栏门（Node 可用时）；不可用则明说降级
    report = _gate_result()
    if report.get('skipped'):
        out.append(Assertion("④ 围栏门真跑（无 Node：**降级**为静态半边；宿主语义由 `verify.sh runtime-plugins` 守卫）",
                             GATE.is_file(), "node 不可用 → 降级；gate 文件就位=True"))
    else:
        total = int(report.get('total') or 0)
        failures = int(report.get('failures') or 0)
        out.append(Assertion("④ 围栏门真跑：`failures:0` 且断言数 ≥22",
                             report.get('rc') == 0 and failures == 0 and total >= 22,
                             f"total={total} failures={failures} rc={report.get('rc')} err={str(report.get('error'))[:120]}"))

    # ⑤ 门里必须真的包含"四类反例 + 变异自证"的痕迹（防"门是空壳"）
    gate_src = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    marks = {k: (k in gate_src) for k in ('反例', '变异', 'restored', 'MUTATION')}
    out.append(Assertion("⑤ 围栏门含四类反例与变异自证机制（不是空壳门）",
                         sum(marks.values()) >= 3, f"markers={marks}"))

    # ⑥ FR-AGENTRT-006 的具体口径：截断要报数、降级要带 reason、空上下文不得报 ok:true
    #    （行为级证明在围栏门里；这一条断言"契约真的写进了模块"，防"文档说得好听、代码里没有"）
    src = '\n'.join((MODULES[n].read_text(encoding='utf-8') if MODULES[n].is_file() else '') for n in MODULES)
    contract = {
        'truncated': "'truncated'" in src,
        'omitted/丢条数': ('omitted' in src),
        'degraded': "'degraded'" in src,
        'reason': ("'reason'" in src or '"reason"' in src),
        'next_action': ('next_action' in src),
        '空上下文区分（empty/empty-context）': ('empty' in src),
    }
    out.append(Assertion("⑥ 有界/降级契约在模块源码里齐全（截断报数、degraded+reason+next_action、空上下文可区分）",
                         all(contract.values()), f"contract={contract}"))
    # ⑦ 门必须真的断言过"截断诚实 + 上限生效"（防门与契约两张皮）
    gate_src = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    gate_marks = {k: (k in gate_src) for k in ('truncated', 'omitted', 'max_steps', 'maxSteps')}
    out.append(Assertion("⑦ 围栏门里有『截断/丢条数/上限』的断言（不是只测快乐路径）",
                         sum(gate_marks.values()) >= 3, f"marks={gate_marks}"))
    return out
