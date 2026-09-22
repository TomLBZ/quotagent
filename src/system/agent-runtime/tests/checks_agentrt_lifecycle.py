"""AC-AGENTRT-007 机检：三件运行期插件**各自独立装卸**、**卸载零残留**、**卸载后事实不丢**。

关键区分（这条 AC 的价值就在这）：
  · "卸载记忆插件后项目记忆仍可重建" **不靠** 任何宿主插件 —— 项目记忆的来源是**账本**（Python 侧重放），
    所以本检查直接证明：**不加载任何插件**也能把项目记忆重放出来且逐字节一致（事实不丢）。
  · 零残留是**模块自身**的性质（`dispose`/`*-disposed`），所以静态断言 + 有 Node 时真跑围栏门；
    无 Node 时**降级**并明说（ADR-0013 §8 要求 phase≠P1 的 AC 无 Node 可复跑）。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
MEMTOOL = ROOT / 'tools' / 'refresh-agent-memory.py'
GATE = ROOT / 'src' / 'system' / 'agent-runtime' / 'tests' / 't275-runtime-gate.mjs'
MODULES = {
    'agent-context': ROOT / 'host' / 'modules' / 'agent-context.mjs',
    'agent-memory': ROOT / 'host' / 'modules' / 'agent-memory.mjs',
    'agent-harness': ROOT / 'host' / 'modules' / 'agent-harness.mjs',
}
DISPOSE_MARKS = ('disposed', 'dispose', 'unload')


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _fixture_ledger(path: Path) -> None:
    rows = [
        {'seq': 1, 'type': 'rfq/published', 'body': {'rfq_id': 'RFQ-7'}, 'entry_hash': 'a' * 64},
        {'seq': 2, 'type': 'quote/submitted', 'body': {'quote_id': 'Q-7'}, 'entry_hash': 'b' * 64},
        {'seq': 3, 'type': 'award/committed', 'body': {'id': 'AW-7'}, 'entry_hash': 'c' * 64},
    ]
    path.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', encoding='utf-8')


def _replay(ledger: Path, out: Path) -> tuple[int, bytes]:
    r = subprocess.run([sys.executable, str(MEMTOOL), '--ledger', str(ledger), '--out', str(out)],
                       capture_output=True, text=True, cwd=str(ROOT), timeout=300)
    return r.returncode, (out.read_bytes() if out.exists() else b'')


@register('AC-AGENTRT-007', 'P2', '运行期插件各自独立装卸、卸载零残留；卸载记忆插件后**事实不丢**（项目记忆仍可重建）',
          'tools/verify.sh ac AC-AGENTRT-007')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        ledger = base / 'ledger.jsonl'
        ledger.write_text('', encoding='utf-8')
        _fixture_ledger(ledger)
        sum_before = hashlib.sha256(ledger.read_bytes()).hexdigest()

        # ① 事实不丢：**不加载任何宿主插件**，只从账本重放项目记忆（逐字节一致）
        a = base / 'a.json'
        b = base / 'b.json'
        rc_a, bytes_a = _replay(ledger, a)
        rc_b, bytes_b = _replay(ledger, b)
        items = json.loads(bytes_a).get('items') if bytes_a else []
        out.append(Assertion("① **卸载/不加载记忆插件也能重建项目记忆**（来源是账本，不是插件内存）：两次重放逐字节一致",
                             rc_a == 0 and rc_b == 0 and bytes_a == bytes_b and len(items) == 3,
                             f"rc={rc_a}/{rc_b} bytes={len(bytes_a)} items={len(items)}"))
        out.append(Assertion("① 重放不改事实：账本字节零改动",
                             hashlib.sha256(ledger.read_bytes()).hexdigest() == sum_before,
                             f"before={sum_before[:12]} after={hashlib.sha256(ledger.read_bytes()).hexdigest()[:12]}"))

        # ② 零残留是模块自身的性质：三件都要有卸载/dispose 实现痕迹（**非空转**：空文件必须不命中）
        per_module = {}
        for name, path in MODULES.items():
            src = path.read_text(encoding='utf-8') if path.is_file() else ''
            per_module[name] = sum(1 for m in DISPOSE_MARKS if m in src)
        control = sum(1 for m in DISPOSE_MARKS if m in '// 空文件：什么都没有\n')
        out.append(Assertion("② 三件模块各自都有卸载/dispose 实现痕迹（且扫描器**非空转**：空文件命中 0）",
                             all(v >= 2 for v in per_module.values()) and control == 0,
                             f"每件命中={per_module} 空转对照={control}"))

        # ③ 相互独立：provides 互不重叠、互不依赖（inject 为空），且各自可被 node 解析
        provides: dict[str, str] = {}
        injects: dict[str, str] = {}
        for name, path in MODULES.items():
            src = path.read_text(encoding='utf-8') if path.is_file() else ''
            mp = re.search(r"provides\s*=\s*\[([^\]]*)\]", src)
            mi = re.search(r"inject\s*=\s*\[([^\]]*)\]", src)
            provides[name] = (mp.group(1).strip() if mp else '')
            injects[name] = (mi.group(1).strip() if mi else 'MISSING')
        vals = [v for v in provides.values() if v]
        out.append(Assertion("③ 三件插件相互独立：`provides` 各自声明且互不重叠；`inject` 均为空数组",
                             len(vals) == 3 and len(set(vals)) == 3 and all(v == '' for v in injects.values()),
                             f"provides={provides} inject={injects}"))

        # ④ 真跑围栏门（含 `*-disposed` 与 zero-write 断言）；无 Node 降级明说
        if _node():
            r = subprocess.run(['node', str(GATE.name)], cwd=str(GATE.parent), capture_output=True, text=True, timeout=600)
            report = {}
            for line in reversed((r.stdout or '').splitlines()):
                if '"failures"' in line and '"total"' in line:
                    try:
                        report = json.loads(line.strip())
                    except Exception:  # noqa: BLE001
                        report = {}
                    break
            src = '\n'.join(p.read_text(encoding='utf-8') for p in MODULES.values() if p.is_file())
            disposed = sum(1 for k in ('agentrt/context-disposed', 'agentrt/memory-disposed', 'agentrt/harness-disposed')
                           if k in src)
            out.append(Assertion("④ 围栏门真跑（failures:0）+ 三件都登记了 `*-disposed` 留痕种类（卸载有痕）",
                                 r.returncode == 0 and report.get('failures') == 0 and disposed == 3,
                                 f"total={report.get('total')} failures={report.get('failures')} disposed_kinds={disposed} rc={r.returncode}"))
        else:
            src = '\n'.join(p.read_text(encoding='utf-8') for p in MODULES.values() if p.is_file())
            disposed = sum(1 for k in ('agentrt/context-disposed', 'agentrt/memory-disposed', 'agentrt/harness-disposed')
                           if k in src)
            out.append(Assertion("④ 零残留（无 Node：**降级**为『三件都有 `*-disposed` 留痕种类』的静态断言；"
                                 "宿主语义由 `verify.sh agent-runtime` 守卫）", disposed == 3, f"disposed_kinds={disposed}"))
    return out
