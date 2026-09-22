"""AC-AGENTRT-002 机检：记忆四层边界（会话不落盘 / 项目=账本投影且可重建 / 策略只人写 / 跨方只走协议）。

只用 Python（无 Node 也全绿：ADR-0013 §8）：
  · 项目层：`tools/refresh-agent-memory.py` 从账本重放 **两次逐字节一致**；删掉快照重建后**逐字节一致**
    （**丢缓存不丢事实**）；每条项目记忆都带 `citations`；**账本字节零改动**（只读重放）；
    账本不可读 → 拒绝（不报零）。
  · 会话层：宿主侧会话永不落盘 —— 用哨兵串扫**契约源集合**（全树减去 `.git/.venv/tmp/node_modules/
    __pycache__` 下的临时/派生目录，按**相对扫描根的路径分量**判定；口径与 D-071/D-072 的
    `tools/check-docs.py` `SCAN_EXCLUDE_DIRS` 同源）；另断言 `agent-memory` 源码里没有写文件/写账本调用
    （静态零写面）。**反向断言（非空转，D-073 的验收）**：同一个扫描器在"真源码路径"里含哨兵 ⇒ 必须命中，
    在"仅 `tmp/` 派生副本"里含哨兵 ⇒ 必须不命中（用临时副本制造两种情形，事后把副本字节**还原**并与真源
    逐字节比对）—— 收窄的是扫描范围里的**临时副本**，不是把判据放宽。
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

from ..paths import new_scratch
from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'tools' / 'refresh-agent-memory.py'
GATE = ROOT / 'host' / 't275-runtime-gate.mjs'
MEM = ROOT / 'host' / 'modules' / 'agent-memory.mjs'

# --- 哨兵扫描的判据口径（D-073，承接 D-071/D-072 第 3 条「判据不得覆盖无关写入者」）--------
# 「契约源集合」= 全树减去**临时/派生目录**，按**相对扫描根的路径分量**判定（不是绝对路径：
# "仓库恰好位于 /tmp 或 node_modules 下"也不会被误排除）。口径与 `tools/check-docs.py` 的
# SCAN_EXCLUDE_DIRS、`checks_runtime.py` 的 IGNORE_DIRS 同源。整树副本（`tmp/ac/<rand>/clean/`、
# `tmp/clean-copy/`、历史遗留的源码副本）**不是契约源**：它们是别的门/别的轮次的一次性产物，
# 判据覆盖它们 = 让本断言依赖无关写入者的存在与否（D-073 实测：`tmp/usreq-clean/src/…/checks_agentrt_memory.py`
# 这份**本检查自己的源码副本**被判成"会话落盘"命中 ⇒ g1 红）。
# **这不是放宽**：范围收窄的只是临时/派生目录，真源码（`src/ host/ docs/ tools/ .agents/`…）**全部照扫**，
# 且由 ⑤b 的反向断言当场证明扫描器不是橡皮图章（真源码路径含哨兵 → 必须命中）。
SCAN_EXCLUDE_DIRS = frozenset({'.git', '.venv', 'tmp', 'node_modules', '__pycache__'})
MAX_SCAN_BYTES = 4_000_000
#: 会话层哨兵。**分片拼接**成字面量：本文件自身也是契约源，若把整串写成连续字面量，
#: "扫真源码"就会命中检查器自己（D-073 的另一半根因）。⑤c 断言这条自洽性。
SENTINEL = 'agentrt-memory-session-' 'sentinel-9f3a'


def in_contract_source(root: Path, path: Path) -> bool:
    """path 是否落在 root 的契约源集合里（相对 root 的路径分量不含排除目录）。"""
    try:
        parts = path.resolve().relative_to(root.resolve()).parts
    except (ValueError, OSError):       # root 外（正常不会出现）——按绝对分量兜底
        parts = path.parts
    return not SCAN_EXCLUDE_DIRS.intersection(parts)


def scan_sentinel(root: Path, sentinel: str) -> list[str]:
    """扫 root 的**契约源集合**，返回含哨兵的文件的相对路径（升序）。

    口径见 SCAN_EXCLUDE_DIRS。参数化 root 是为了让 ⑤b 能在临时副本上做正/反向对照
    （同一段代码既扫真仓库、也扫副本树，不另写第二份实现）。
    """
    hits: list[str] = []
    needle = sentinel.encode()
    for f in sorted(root.rglob('*')):
        if not f.is_file() or not in_contract_source(root, f):
            continue
        try:
            if f.stat().st_size >= MAX_SCAN_BYTES:
                continue
            if needle in f.read_bytes():
                hits.append(str(f.relative_to(root)))
        except OSError:                 # 读不到/竞态消失：不把它当成命中（范围外的东西不该让本断言变红）
            continue
    return hits


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
        sentinel = SENTINEL
        hits = scan_sentinel(ROOT, sentinel)
        out.append(Assertion("⑤ 磁盘上检索不到会话哨兵（契约源集合 = 全树 − 临时/派生目录；"
                             "事件流只在内存；落账本由 Python 侧显式做）",
                             not hits, f"命中={hits[:3]}（哨兵 {sentinel[:12]}… 从未被写入磁盘；"
                                       f"范围={ROOT} 减去 {'/'.join(sorted(SCAN_EXCLUDE_DIRS))}）"))

        # ⑤b 反向断言（非空转）：同一扫描器在**真源码路径**里必须命中、在**仅 tmp/ 派生副本**里
        #     必须不命中 —— 用临时副本制造两种情形（**不写真源码**），事后把副本字节**还原**并与真源逐字节比对。
        checker_src = Path(__file__).read_bytes()
        checker_sha = hashlib.sha256(checker_src).hexdigest()
        probe = new_scratch('agentrt-sentinel')
        real_copy = probe / 'src' / 'quotagent' / 'qa' / 'checks_agentrt_memory.py'                 # 真源码路径形状
        derived_copy = probe / 'tmp' / 'usreq-clean' / 'src' / 'quotagent' / 'qa' / 'checks_agentrt_memory.py'
        for target in (real_copy, derived_copy):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(checker_src + b'\n# ' + sentinel.encode() + b'\n')
        probe_hits = scan_sentinel(probe, sentinel)
        want = [str(real_copy.relative_to(probe))]
        restored = []
        for target in (real_copy, derived_copy):        # 还原字节：删掉哨兵行后必须与真源逐字节一致
            target.write_bytes(checker_src)
            restored.append(target.read_bytes() == checker_src)
        out.append(Assertion("⑤b 反向断言（非空转）：同一扫描器扫到**真源码路径**里的哨兵 ⇒ 命中；"
                             "**仅 tmp/ 派生副本**里的哨兵 ⇒ 不命中；副本字节还原后与真源逐字节一致",
                             probe_hits == want and all(restored)
                             and hashlib.sha256(checker_src).hexdigest() == checker_sha,
                             f"真源码命中={probe_hits}（期望 {want}）；tmp/ 副本命中="
                             f"{[h for h in probe_hits if h.startswith('tmp/')]}；还原逐字节一致={all(restored)}"))
        out.append(Assertion("⑤c 扫描器自身不含哨兵字面量（否则\"扫真源码\"必然自命中 —— D-073 的另一半根因）",
                             sentinel not in checker_src.decode('utf-8', 'ignore'),
                             f"哨兵 {sentinel[:12]}… 在本文件里只以分片拼接形式存在（检 {checker_sha[:12]}）"))

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
