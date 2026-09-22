"""T-267b2a 机检 AC-USERPLUG-005：迭代（upgraded）与回滚（rolled-back）的内容语义。

不变量（本检查守的就是它们）：
① 同一个版本号不能对应两个不同产物（要求递增版本）；
② **账本里不存在"不真"的记录**：只有当磁盘内容哈希 == 目标版本哈希时才落 `rolled-back`；
③ 回滚只能回到历史里真实出现过的版本；已是目标版本时不许重复记账（`rollback-noop`）；
④ 幂等：重复消费不新增账本行。

只用 Python（无 Node 也能全绿：ADR-0013 §8）。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
REC = ROOT / 'tools' / 'userplugin-record.py'
DESC = '承包商想按项目维度记录每次报价金额，并能看出趋势'


def _write_plugin(us: Path, ns: str, name: str, version: str, body: str) -> Path:
    d = us / ns / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'plugin.json').write_text(json.dumps({"name": name, "version": version}), encoding='utf-8')
    (d / 'index.mjs').write_text(body, encoding='utf-8')
    return d


def _run(us: Path, ledger: Path, reqs: Path, *extra: str) -> dict:
    cmd = [sys.executable, str(REC), '--requests', str(reqs), '--user-space', str(us),
           '--ledger', str(ledger), '--now', '2026-09-21T16:00:00Z', *extra]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=300)
    payload: dict
    try:
        payload = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        payload = {"error": (r.stdout + r.stderr)[-400:]}
    payload['rc'] = r.returncode
    return payload


def _rows(ledger: Path, typ: str) -> list[dict]:
    if not ledger.exists():
        return []
    rows = []
    for line in ledger.read_text(encoding='utf-8').splitlines():
        if line.strip() and json.loads(line).get('type') == typ:
            rows.append(json.loads(line))
    return rows


def _count(ledger: Path) -> int:
    if not ledger.exists():
        return 0
    return len([l for l in ledger.read_text(encoding='utf-8').splitlines() if l.strip()])


@register('AC-USERPLUG-005', 'P2', '用户空间插件迭代/回滚的内容语义（版本、prev、不真不记）',
          'tools/verify.sh ac AC-USERPLUG-005')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        us, reqs = base / 'us', base / 'req'
        reqs.mkdir(parents=True)
        ledger = base / 'led.jsonl'
        (reqs / 'r1.json').write_text(json.dumps({
            "kind": "plugin-request", "ns": "con-a", "description": DESC,
            "description_sha256": hashlib.sha256(DESC.encode()).hexdigest(),
            "bytes": len(DESC.encode()), "requested_at": "2026-09-21T15:00:00Z"},
            ensure_ascii=False), encoding='utf-8')

        # ① 首版 → created
        _write_plugin(us, 'con-a', 'quote-trend', '1.0.0', 'export default 1;\n')
        r1 = _run(us, ledger, reqs)
        ev1 = [a['event'] for a in r1.get('applied', [])]
        out.append(Assertion("① 首版 → `userplugin/created`", ev1 == ['userplugin/created'],
                             f"applied={ev1} rc={r1['rc']}"))

        # ② 同版本不同产物 → 拒绝
        _write_plugin(us, 'con-a', 'quote-trend', '1.0.0', 'export default 2;\n')
        r2 = _run(us, ledger, reqs)
        vnb = [r for r in _rows(ledger, 'userplugin/refused')
               if (r.get('body') or {}).get('code') == 'version-not-bumped']
        out.append(Assertion("② 同版本不同产物 → 拒绝 `version-not-bumped`（同版本不能对应两个产物）",
                             (not r2.get('applied')) and bool(vnb) and not r2.get('ok'),
                             f"applied={r2.get('applied')} refused={[x['reason'][:38] for x in r2.get('refused', [])]}"))

        # ③ 递增版本 → upgraded 且带 prev
        _write_plugin(us, 'con-a', 'quote-trend', '1.1.0', 'export default 2;\n')
        r3 = _run(us, ledger, reqs)
        up = _rows(ledger, 'userplugin/upgraded')
        prev_ok = bool((up[0].get('body') or {}).get('prev_artifact_sha256')) if up else False
        out.append(Assertion("③ 版本递增 → `userplugin/upgraded`（带 `prev_artifact_sha256`）",
                             len(up) == 1 and prev_ok,
                             f"upgraded={len(up)} prev={prev_ok} applied={[a['event'] for a in r3.get('applied', [])]}"))

        # ④ 未还原就要回滚 → content-not-restored（且不落 rolled-back）
        r4 = _run(us, ledger, reqs, '--rollback', 'con-a/quote-trend', '--to-version', '1.0.0')
        code4 = (r4.get('rollback') or {}).get('code')
        out.append(Assertion("④ 目标版本还没写回就想登记回滚 → 拒绝 `rollback-content-not-restored`",
                             code4 == 'rollback-content-not-restored' and not _rows(ledger, 'userplugin/rolled-back'),
                             f"code={code4} rolled-back={len(_rows(ledger, 'userplugin/rolled-back'))}"))

        # ⑤ 部分还原（只回退 index.mjs，plugin.json 仍是 1.1.0）→ 仍必须拒绝
        _write_plugin(us, 'con-a', 'quote-trend', '1.1.0', 'export default 1;\n')
        r5 = _run(us, ledger, reqs, '--rollback', 'con-a/quote-trend', '--to-version', '1.0.0')
        code5 = (r5.get('rollback') or {}).get('code')
        out.append(Assertion("⑤ **部分还原**（版本号没跟着回退）→ 仍拒绝 `rollback-refused-modified`",
                             code5 == 'rollback-refused-modified' and not _rows(ledger, 'userplugin/rolled-back'),
                             f"code={code5}"))

        # ⑥ 整版本写回 → rolled-back
        _write_plugin(us, 'con-a', 'quote-trend', '1.0.0', 'export default 1;\n')
        r6 = _run(us, ledger, reqs, '--rollback', 'con-a/quote-trend', '--to-version', '1.0.0')
        rb = _rows(ledger, 'userplugin/rolled-back')
        rec_hash = (rb[0].get('body') or {}).get('artifact_sha256') if rb else None
        out.append(Assertion("⑥ 整个版本目录写回 → `userplugin/rolled-back`（记的是磁盘上那份的哈希）",
                             len(rb) == 1 and bool(rec_hash) and (r6.get('rollback') or {}).get('ok') is True,
                             f"rolled-back={len(rb)} recorded={str(rec_hash)[:20]} ok={(r6.get('rollback') or {}).get('ok')}"))

        # ⑦ 已是目标版本 → noop（不许重复记账）
        r7 = _run(us, ledger, reqs, '--rollback', 'con-a/quote-trend', '--to-version', '1.0.0')
        code7 = (r7.get('rollback') or {}).get('code')
        out.append(Assertion("⑦ 已是目标版本 → `rollback-noop`（不重复记账）",
                             code7 == 'rollback-noop' and len(_rows(ledger, 'userplugin/rolled-back')) == 1,
                             f"code={code7} rolled-back={len(_rows(ledger, 'userplugin/rolled-back'))}"))

        # ⑧ 未知版本 → target-unknown
        r8 = _run(us, ledger, reqs, '--rollback', 'con-a/quote-trend', '--to-version', '9.9.9')
        code8 = (r8.get('rollback') or {}).get('code')
        out.append(Assertion("⑧ 历史里没有的版本 → `rollback-target-unknown`",
                             code8 == 'rollback-target-unknown', f"code={code8}"))

        # ⑨ 不真不记：每条 rolled-back 的目标哈希都必须在版本历史里出现过
        hist = set()
        for r in _rows(ledger, 'userplugin/created') + _rows(ledger, 'userplugin/upgraded'):
            hist.add((r.get('body') or {}).get('artifact_sha256'))
        rb_rows = _rows(ledger, 'userplugin/rolled-back')
        ok9 = all((r.get('body') or {}).get('artifact_sha256') in hist for r in rb_rows) and len(rb_rows) == 1
        out.append(Assertion("⑨ 每条 `rolled-back` 的目标哈希都真实存在于版本历史（回滚只能回到真实存在过的版本）",
                             ok9, f"rolled-back={len(rb_rows)} 历史哈希={len(hist)}"))

        # ⑩ 幂等：重复消费不新增账本行
        before = _count(ledger)
        r9 = _run(us, ledger, reqs)
        after = _count(ledger)
        out.append(Assertion("⑩ 幂等：重复消费不新增账本行",
                             after == before, f"before={before} after={after} ok={r9.get('ok')}"))
    return out
