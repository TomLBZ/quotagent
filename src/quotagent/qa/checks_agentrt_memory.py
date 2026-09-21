"""AC-AGENTRT-002 机检：记忆四层边界（会话不落盘 / 项目=账本投影且可重建 / 策略只人写 / 跨方只走协议）。

只用 Python（无 Node 也全绿：ADR-0013 §8）：
  · 项目层：`tools/refresh-agent-memory.py` 从账本重放 **两次逐字节一致**；删掉快照重建后**逐字节一致**
    （**丢缓存不丢事实**）；每条项目记忆都带 `citations`；**账本字节零改动**（只读重放）；
    账本不可读 → 拒绝（不报零）。
  · 会话层：宿主侧会话永不落盘 —— 用哨兵串扫 `tmp/` 与仓库（宿主内存事件流不得出现在磁盘上）；
    另断言 `agent-memory` 源码里没有写文件/写账本调用（静态零写面）。
  · 策略层 / 跨方层：Node 可用时由围栏门真跑（`memory-policy-human-only` / `memory-cross-party-*`）；
    Node 不可用时**降级**为"拒绝码与不变量在源码里成立"的静态断言，并**明说降级**。
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

from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'tools' / 'refresh-agent-memory.py'
GATE = ROOT / 'host' / 't275-runtime-gate.mjs'
MEM = ROOT / 'host' / 'modules' / 'agent-memory.mjs'


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _replay(ledger: Path) -> tuple[int, bytes, dict]:
    out = Path(tempfile.mkdtemp()) / 'project.json'
    r = subprocess.run([sys.executable, str(TOOL), '--ledger', str(ledger), '--out', str(out)],
                       capture_output=True, text=True, cwd=str(ROOT), timeout=300)
    payload: dict
    try:
        payload = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        payload = {'error': (r.stdout + r.stderr)[-300:]}
    return r.returncode, (out.read_bytes() if out.exists() else b''), payload


def _fixture_ledger(path: Path) -> None:
    """用**真事件名**造一条小账本（自足夹具：不依赖 tmp/ 里的未跟踪数据）。"""
    rows = [
        {'seq': 1, 'type': 'rfq/published', 'body': {'rfq_id': 'RFQ-1'}, 'entry_hash': 'a' * 64},
        {'seq': 2, 'type': 'quote/submitted', 'body': {'quote_id': 'Q-1', 'total': 1200}, 'entry_hash': 'b' * 64},
        {'seq': 3, 'type': 'approval/granted', 'body': {'id': 'AP-1', 'actor': 'human:dealer'}, 'entry_hash': 'c' * 64},
        {'seq': 4, 'type': 'kernel/bridge-rejected', 'body': {'why': 'x'}, 'entry_hash': 'd' * 64},  # 不在闭集：不进记忆
    ]
    path.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', encoding='utf-8')


@register('AC-AGENTRT-002', 'P2', '记忆四层边界：会话不落盘 / 项目=账本投影可重建 / 策略只人写 / 跨方只走协议',
          'tools/verify.sh ac AC-AGENTRT-002')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        ledger = base / 'ledger.jsonl'
        _fixture_ledger(ledger)
        before = hashlib.sha256(ledger.read_bytes()).hexdigest()

        # ① 项目层：两次重放逐字节一致（确定性）+ 快照删掉重建仍逐字节一致（丢缓存不丢事实）
        rc1, bytes1, rep1 = _replay(ledger)
        rc2, bytes2, rep2 = _replay(ledger)
        out.append(Assertion("① 项目记忆 = 账本重放：两次逐字节一致（确定性），且只挑闭集内的事件",
                             rc1 == 0 and rc2 == 0 and bytes1 == bytes2 and bool(bytes1) and rep1.get('items', 0) == 3,
                             f"rc={rc1}/{rc2} bytes={len(bytes1)} items={rep1.get('items')} "
                             f"kinds={rep1.get('kinds')}"))

        # ② 丢缓存不丢事实：删掉快照重建 → 与删除前逐字节一致
        snap = base / 'project.json'
        subprocess.run([sys.executable, str(TOOL), '--ledger', str(ledger), '--out', str(snap)],
                       capture_output=True, cwd=str(ROOT), timeout=300)
        keep = snap.read_bytes()
        snap.unlink()
        subprocess.run([sys.executable, str(TOOL), '--ledger', str(ledger), '--out', str(snap)],
                       capture_output=True, cwd=str(ROOT), timeout=300)
        out.append(Assertion("② **丢缓存不丢事实**：删掉快照重建后逐字节一致",
                             snap.exists() and snap.read_bytes() == keep,
                             f"重建一致={bool(snap.exists() and snap.read_bytes() == keep)} bytes={len(keep)}"))

        # ③ 每条项目记忆都带 citations（无引用不进记忆）+ 账本字节零改动（只读重放）
        payload = json.loads(snap.read_text(encoding='utf-8')) if snap.exists() else {}
        no_cit = [i for i in payload.get('items', []) if not i.get('citations')]
        out.append(Assertion("③ 每条项目记忆都带 `citations`（指回账本行）",
                             bool(payload.get('items')) and not no_cit, f"缺引用={len(no_cit)}"))
        after = hashlib.sha256(ledger.read_bytes()).hexdigest()
        out.append(Assertion("③ 重放是只读的：账本字节零改动（H1：宿主/工具都不得借重放写事实）",
                             before == after, f"before={before[:12]} after={after[:12]}"))

        # ④ 账本不可读 → 拒绝，且**不报零**（"读不出来"与"确实没内容"必须可区分）
        rc3, _, rep3 = _replay(base / 'nope.jsonl')
        out.append(Assertion("④ 账本不可读 → 拒绝（`ledger-unreadable`，退出码非 0），不伪装成空投影",
                             rc3 == 2 and rep3.get('code') == 'ledger-unreadable', f"rc={rc3} code={rep3.get('code')}"))

        # ⑤ 会话层永不落盘：静态零写面 + 磁盘上检索不到宿主会话哨兵
        mem_src = MEM.read_text(encoding='utf-8') if MEM.is_file() else ''
        writes = sorted(set(re.findall(r'writeFileSync|appendFileSync|createWriteStream|writeFile\(|mkdirSync',
                                       mem_src)))
        out.append(Assertion("⑤ 会话层永不落盘（静态）：`agent-memory` 无任何写文件调用",
                             not writes, f"命中={writes}"))
        sentinel = 'agentrt-memory-session-sentinel-9f3a'
        hits = []
        for root in (ROOT / 'tmp', ROOT / 'host', ROOT / 'user-space'):
            if not root.is_dir():
                continue
            for f in root.rglob('*'):
                if f.is_file() and f.stat().st_size < 4_000_000:
                    try:
                        if sentinel.encode() in f.read_bytes():
                            hits.append(str(f.relative_to(ROOT)))
                    except Exception:  # noqa: BLE001
                        continue
        out.append(Assertion("⑤ 磁盘上检索不到会话哨兵（事件流只在内存；落账本由 Python 侧显式做）",
                             not hits, f"命中={hits[:3]}（哨兵 {sentinel[:12]}… 从未被写入磁盘）"))

        # ⑥ 策略层 / 跨方层：Node 可用时真跑围栏门；不可用时降级并明说
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
            out.append(Assertion("⑥ 策略只人写 / 跨方只走协议：围栏门真跑（四类反例全绿）",
                                 r.returncode == 0 and report.get('failures') == 0,
                                 f"total={report.get('total')} failures={report.get('failures')} rc={r.returncode}"))
        else:
            marks = {k: (k in mem_src) for k in ('memory-policy-human-only', 'memory-cross-party-direct-read-refused',
                                                 'memory-protocol-envelope-invalid')}
            out.append(Assertion("⑥ 策略只人写 / 跨方只走协议（无 Node：**降级**为源码级断言；语义由 "
                                 "`verify.sh agent-runtime` 守卫）", all(marks.values()), f"marks={marks}"))
    return out
