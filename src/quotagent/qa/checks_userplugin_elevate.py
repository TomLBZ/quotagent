"""AC-USERPLUG-010 机检：提权（用户空间插件 → 系统级插件）—— 人工门 + 影子哈希 + 真写。

只用 Python（无 Node 也能全绿：ADR-0013 §8）。夹具把 `--promote-dir` 指向临时目录，
**真跑写入路径**（不是只验拒绝），负控则断言"拒绝时一个字都没写"。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'tools' / 'userplugin-elevate.py'
MODULE_SRC = ("export const name = 'quote-trend'\nexport const provides = ['quoteTrend']\n"
              "export const inject = []\nexport const Config = {}\n"
              "export function apply(ctx) { ctx.provide('quoteTrend', { trend: () => ({ points: 0 }) }) }\n")


def _hash(plugin_dir: Path) -> str:
    h = hashlib.sha256()
    for name in ('index.mjs', 'plugin.json'):
        h.update((plugin_dir / name).read_bytes())
    return h.hexdigest()


def _setup(base: Path, *, approval_ref: str = 'ap-0111', ns: str = 'con-a',
           plugin: str = 'quote-trend', manifest_name: str = 'quote-trend') -> tuple[Path, Path, Path]:
    us = base / 'user-space'
    pdir = us / ns / plugin
    pdir.mkdir(parents=True)
    (pdir / 'plugin.json').write_text(json.dumps(
        {"name": manifest_name, "version": "2.0.0", "sha256": _hash(pdir) if False else ""}), encoding='utf-8')
    (pdir / 'index.mjs').write_text(MODULE_SRC, encoding='utf-8')
    digest = _hash(pdir)
    (pdir / 'plugin.json').write_text(json.dumps(
        {"name": manifest_name, "version": "2.0.0", "sha256": digest}), encoding='utf-8')
    digest = _hash(pdir)

    inbox = base / 'ev'
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / f'{ns}.{plugin}.json').write_text(json.dumps({
        'kind': 'plugin-elevation-request', 'ok': True, 'ns': ns, 'plugin': plugin,
        'approval_ref': approval_ref, 'manifest_sha256': digest,
        'target': f'host/modules/{manifest_name}.mjs', 'bytes': len(digest),
        'next_action': '写入 host/modules/ 属下一批', 'written': False}, ensure_ascii=False), encoding='utf-8')
    return us, inbox, base / 'promote'


def _run(us: Path, inbox: Path, ledger: Path, promote: Path, *extra: str) -> dict:
    cmd = [sys.executable, str(TOOL), '--requests', str(inbox), '--user-space', str(us),
           '--ledger', str(ledger), '--promote-dir', str(promote),
           '--now', '2026-09-21T17:00:00Z', *extra]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=300)
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        out = {'error': (r.stdout + r.stderr)[-400:]}
    out['rc'] = r.returncode
    return out


def _rows(ledger: Path, typ: str) -> list[dict]:
    if not ledger.exists():
        return []
    out = []
    for line in ledger.read_text(encoding='utf-8').splitlines():
        if line.strip() and json.loads(line).get('type') == typ:
            out.append(json.loads(line))
    return out


@register('AC-USERPLUG-010', 'P2', '提权：用户空间插件 → 系统级插件（人工门 + 影子哈希 + 真写 + 不覆盖）',
          'tools/verify.sh ac AC-USERPLUG-010')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        us, inbox, promote = _setup(base)
        ledger = base / 'led.jsonl'
        original_packets = len(list(inbox.glob('*.json')))

        # ① 非人类 actor → 拒绝（人工门：agent 不能自己提权）
        r1 = _run(us, inbox, ledger, promote, '--actor', 'agent:auto')
        codes1 = [x['code'] for x in r1.get('refused', [])]
        out.append(Assertion("① agent 发起提权 → 拒绝 `approval-ref-not-human`（人工门不可绕过）",
                             codes1 == ['approval-ref-not-human'] and not promote.exists(),
                             f"codes={codes1} promote_exists={promote.exists()} rc={r1['rc']}"))

        # ② 人工门引用形状不对 → 拒绝
        bad = base / 'ev2'
        bad.mkdir()
        (bad / 'p.json').write_text(json.dumps({
            'kind': 'plugin-elevation-request', 'ns': 'con-a', 'plugin': 'quote-trend',
            'approval_ref': 'ap-12', 'manifest_sha256': 'x'}, ensure_ascii=False), encoding='utf-8')
        r2 = _run(us, bad, ledger, promote, '--actor', 'human:deployer')
        out.append(Assertion("② 引用形状不对（`ap-12`）→ 拒绝 `approval-ref-malformed`",
                             [x['code'] for x in r2.get('refused', [])] == ['approval-ref-malformed'],
                             f"codes={[x['code'] for x in r2.get('refused', [])]}"))

        # ③ 影子哈希不一致（产物被改过 / 载荷陈旧）→ 拒绝，且不写
        (us / 'con-a' / 'quote-trend' / 'index.mjs').write_text(MODULE_SRC + '// tampered\n', encoding='utf-8')
        r3 = _run(us, inbox, ledger, promote, '--actor', 'human:deployer')
        out.append(Assertion("③ 产物与载荷哈希不一致 → 拒绝 `shadow-hash-mismatch`，且**树里什么都没有**",
                             [x['code'] for x in r3.get('refused', [])] == ['shadow-hash-mismatch']
                             and not promote.exists(),
                             f"codes={[x['code'] for x in r3.get('refused', [])]} promote_exists={promote.exists()}"))

        # 复原产物（重新算哈希并同步载荷）
        (us / 'con-a' / 'quote-trend' / 'index.mjs').write_text(MODULE_SRC, encoding='utf-8')
        digest = _hash(us / 'con-a' / 'quote-trend')
        pkt = json.loads((inbox / 'con-a.quote-trend.json').read_text(encoding='utf-8'))
        pkt['manifest_sha256'] = digest
        (inbox / 'con-a.quote-trend.json').write_text(json.dumps(pkt, ensure_ascii=False), encoding='utf-8')

        # ④ 人类 actor + 哈希一致 → 真写 + 落账本
        r4 = _run(us, inbox, ledger, promote, '--actor', 'human:deployer')
        target = promote / 'quote-trend.mjs'
        wrote = target.is_file() and target.read_bytes() == (us / 'con-a' / 'quote-trend' / 'index.mjs').read_bytes()
        rows = _rows(ledger, 'userplugin/elevated')
        body = rows[0].get('body') if rows else {}
        out.append(Assertion("④ 人类 actor + 影子哈希一致 → **真写**晋升目标并落 `userplugin/elevated`",
                             bool(r4.get('applied')) and wrote and len(rows) == 1
                             and body.get('approval_ref') == 'ap-0111' and body.get('actor') == 'human:deployer',
                             f"applied={len(r4.get('applied', []))} wrote={wrote} elevated={len(rows)} "
                             f"ref={body.get('approval_ref')} actor={body.get('actor')}"))

        # ⑤ 不真不记：账本记的产物哈希 == 写进树的那份字节的哈希来源
        recorded = str(body.get('artifact_sha256') or '')
        out.append(Assertion("⑤ 不真不记：账本里的 `artifact_sha256` == 写入前后现算的产物哈希",
                             recorded.endswith(digest) and (promote / 'quote-trend.mjs').is_file(),
                             f"recorded={recorded[-16:]} 现算={digest[-16:]}"))

        # ⑥ 目标已存在 → 拒绝且**不覆盖**
        before = (promote / 'quote-trend.mjs').read_bytes()
        us2, inbox2, promote2 = _setup(base / 'second')
        promote2.mkdir(parents=True)
        (promote2 / 'quote-trend.mjs').write_text('// 已在树里的模块\n', encoding='utf-8')
        r6 = _run(us2, inbox2, ledger, promote2, '--actor', 'human:deployer')
        out.append(Assertion("⑥ 目标已存在 → 拒绝 `target-exists`，且既有文件**逐字节不变**",
                             [x['code'] for x in r6.get('refused', [])] == ['target-exists']
                             and (promote2 / 'quote-trend.mjs').read_text(encoding='utf-8') == '// 已在树里的模块\n',
                             f"codes={[x['code'] for x in r6.get('refused', [])]}"))

        # ⑦ 清单 name 越界（试图写到晋升目录外）→ 拒绝
        us3, inbox3, promote3 = _setup(base / 'third', manifest_name='../../evil')
        r7 = _run(us3, inbox3, ledger, promote3, '--actor', 'human:deployer')
        out.append(Assertion("⑦ 清单 name 试图越出晋升目录 → 拒绝 `target-name-mismatch`（越界写面不可达）",
                             [x['code'] for x in r7.get('refused', [])] == ['target-name-mismatch']
                             and not (base / 'evil.mjs').exists(),
                             f"codes={[x['code'] for x in r7.get('refused', [])]}"))

        # ⑧ 缺人工门引用 → 拒绝
        us4, inbox4, promote4 = _setup(base / 'fourth', approval_ref='')
        r8 = _run(us4, inbox4, ledger, promote4, '--actor', 'human:deployer')
        out.append(Assertion("⑧ 载荷里没有人工门引用 → 拒绝 `elevate-needs-approval`",
                             [x['code'] for x in r8.get('refused', [])] == ['elevate-needs-approval'],
                             f"codes={[x['code'] for x in r8.get('refused', [])]}"))

        # ⑨ 幂等：待办件已 applied → 再跑不新增账本行、不重复写
        n_before = len(_rows(ledger, 'userplugin/elevated'))
        r9 = _run(us, inbox, ledger, promote, '--actor', 'human:deployer')
        n_after = len(_rows(ledger, 'userplugin/elevated'))
        out.append(Assertion("⑨ 幂等：待办件已消费 → 不新增 elevated 行（也不重复写）",
                             n_before == n_after == 1 and (promote / 'quote-trend.mjs').read_bytes() == before,
                             f"before={n_before} after={n_after} rc={r9['rc']}"))

        # ⑩ 拒绝路径零写面：所有拒绝都不产生 elevated 行
        refused_total = sum(1 for r in (r1, r2, r3, r6, r7, r8) for _ in r.get('refused', []))
        out.append(Assertion("⑩ 六次拒绝全部零写账本（拒绝不产生 `userplugin/elevated`）",
                             refused_total == 6 and len(_rows(ledger, 'userplugin/elevated')) == 1,
                             f"拒绝数={refused_total} elevated={len(_rows(ledger, 'userplugin/elevated'))} "
                             f"（初始待办件 {original_packets}）"))
    return out
