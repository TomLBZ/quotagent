"""AC-STORAGE-001 / AC-STORAGE-004 机检：存储的**逃逸防线**与**跨租户隔离**（只落有真证据的）。

实测口径（我第一版靠猜，错了两次，见 D-068）：
  · `open-append --text` **不接受带换行的文本**（工具自己补行）→ `append-text-has-newline` 拒；
  · 键值表落在 `<root>/<ns>/db/<table>.jsonl`；
  · **隔离是按路径强制的**：`--ns '../beta'`、`--ns 'beta/../alpha'`、`--ns alpha --rel '../beta/x'` 一律
    `storage-outside-ns`；而"用合法的 ns 写它自己的根"**本来就是允许的**（那不是越权，是它的地盘）。
  · **已知边界**（登记 D-068，不在此处假装解决）：`--ns` 是**调用方自称**，本工具不做调用者身份校验；
    真正的身份约束在宿主/用户空间内核层（`credentialScope`/`assertWriteSurface`）。
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
STORE = ROOT / 'tools' / 'storage.py'


def _run(*args: str, root: Path) -> dict:
    cmd = [sys.executable, str(STORE), *args, '--root', str(root), '--at', '2026-09-21T18:00:00Z']
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=300)
    payload: dict
    try:
        payload = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        payload = {'error': (r.stdout + r.stderr)[-300:], 'ok': False}
    payload['_rc'] = r.returncode
    return payload


def _code(payload: dict) -> str:
    return str(payload.get('code') or '')


def _append_lines(root: Path, ns: str, rel: str, n: int) -> None:
    """用真工具追加 n 行（工具自己补行尾，`--text` 不许带换行）。"""
    for i in range(n):
        _run('open-append', '--ns', ns, '--rel', rel, '--text', f'l{i}', root=root)


@register('AC-STORAGE-001', 'P2', '存储逃逸防线：`..`/绝对路径/符号链三例全拒且根外目标不存在；`sha256` 与磁盘一致；有界读取诚实报破',
          'tools/verify.sh ac AC-STORAGE-001')
def check_escape() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        root, outside = base / 'store', base / 'outside'
        root.mkdir(); outside.mkdir()
        (outside / 'secret.txt').write_text('OUTSIDE-SENTINEL\n', encoding='utf-8')

        # ① 正控：本租户日志可写；`stat` 的 sha256 与磁盘一致（写第 2 行后哈希要变）
        w = _run('open-append', '--ns', 'alpha', '--rel', 'own.log', '--text', 'line-1', root=root)
        target = root / 'alpha' / 'own.log'
        st1 = _run('stat', '--ns', 'alpha', '--rel', 'own.log', root=root)
        h1 = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else ''
        d1 = str(st1.get('sha256') or '')
        out.append(Assertion("① 本租户日志可写；`stat` 的 sha256 与磁盘内容一致",
                             w.get('ok') is True and bool(target.is_file()) and d1.endswith(h1),
                             f"written={target.is_file()} declared={d1[-16:]} disk={h1[-16:]}"))

        # ② 逃逸三例：`..`、绝对路径、符号链 → 全拒，且**根外目标不存在**
        codes: list[str] = []
        codes.append(_code(_run('open-append', '--ns', 'alpha', '--rel', '../escape-a.log', '--text', 'x', root=root)))
        codes.append(_code(_run('open-append', '--ns', 'alpha', '--rel', str(outside / 'escape-b.log'),
                                '--text', 'x', root=root)))
        link = root / 'alpha' / 'linkdir'
        symlink_ok = False
        try:
            link.symlink_to(outside, target_is_directory=True)
            codes.append(_code(_run('open-append', '--ns', 'alpha', '--rel', 'linkdir/through-link.log',
                                    '--text', 'x', root=root)))
            symlink_ok = True
        except (OSError, NotImplementedError):
            pass
        a_abs, b_abs, c_abs = (base / 'escape-a.log'), (outside / 'escape-b.log'), (outside / 'through-link.log')
        escaped = [str(p.name) for p in (a_abs, b_abs, c_abs) if p.exists()]
        out.append(Assertion("② `..` / 绝对路径 / 符号链三例全拒（`storage-path-escape` 系），且**根外目标一个都不存在**",
                             all(c for c in codes) and not escaped and len(codes) >= 2,
                             f"symlink_ok={symlink_ok} codes={codes} 根外存在={escaped}"))

        # ③ 有界读取：40 行 → limit=5 → 恰 5 行且 `omitted` 诚实（=35）
        _append_lines(root, 'alpha', 'big.log', 40)
        t = _run('read-tail', '--ns', 'alpha', '--rel', 'big.log', '--limit', '5', root=root)
        lines = t.get('lines')
        n_lines = len(lines) if isinstance(lines, list) else lines
        out.append(Assertion("③ 有界读取：`limit=5` 恰返回 5 行，且 `omitted` 恰等于被丢行数（不得静默丢）",
                             n_lines == 5 and t.get('omitted') == 35 and t.get('truncated') is True,
                             f"lines={n_lines} omitted={t.get('omitted')} truncated={t.get('truncated')}"))
    return out


@register('AC-STORAGE-004', 'P2', '存储跨租户隔离：ns 逃逸与 rel 跨根一律拒且**根外/别租户哨兵不存在**（不是只返回错误）',
          'tools/verify.sh ac AC-STORAGE-004')
def check_cross_ns() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        root = base / 'store'
        root.mkdir()
        ledger = base / 'ledger.jsonl'
        ledger.write_text(json.dumps({'seq': 1, 'type': 'rfq/published', 'body': {'rfq_id': 'RFQ-1'}}) + '\n',
                          encoding='utf-8')
        before = hashlib.sha256(ledger.read_bytes()).hexdigest()
        sen = 'SENTINEL-BETA-KEY'

        # 三种越权形态：ns 逃逸（两种写法）+ rel 跨根
        forms = [
            ('ns 逃逸 `../beta`', ('put', '--ns', '../beta', '--table', 't', '--key', sen, '--value', sen)),
            ('ns 逃逸 `beta/../alpha`', ('put', '--ns', 'beta/../alpha', '--table', 't', '--key', sen, '--value', sen)),
            ('rel 跨根 `../beta/x`', ('open-append', '--ns', 'alpha', '--rel', '../beta/evil.log', '--text', sen)),
        ]
        results = {}
        for label, args in forms:
            r = _run(*args, root=root)
            results[label] = _code(r)
        out.append(Assertion("① 三种越权形态（ns 逃逸 ×2 + rel 跨根）一律 `storage-outside-ns`",
                             all(v == 'storage-outside-ns' for v in results.values()),
                             f"{results}"))

        # 哨兵：磁盘上不得出现（不是"只返回错误"）
        hits = []
        for f in root.rglob('*'):
            if f.is_file():
                try:
                    if sen in f.read_text(encoding='utf-8', errors='ignore'):
                        hits.append(str(f.relative_to(root)))
                except Exception:  # noqa: BLE001
                    continue
        stray = [str(p.relative_to(root)) for p in root.rglob('*')
                 if p.name in ('evil.log',) or 'beta' in p.parts[1:2]]
        out.append(Assertion("① 越权尝试后：哨兵与越权文件在磁盘上一个都不存在（且没有 beta 目录被顺带创建）",
                             not hits and not stray, f"哨兵命中={hits[:3]} 越权残留={stray[:3]}"))

        # ② 存储写不产生账本行、账本字节不变（H1）；声明为事实路径后往它写必须被拒
        _run('put', '--ns', 'alpha', '--table', 't', '--key', 'k', '--value', 'v1', root=root)
        after = hashlib.sha256(ledger.read_bytes()).hexdigest()
        rows = [l for l in ledger.read_text(encoding='utf-8').splitlines() if l.strip()]
        out.append(Assertion("② 存储写**不产生账本行**、账本字节零改动（H1：存储不得成为第二条事实写路径）",
                             before == after and len(rows) == 1,
                             f"before={before[:12]} after={after[:12]} rows={len(rows)}"))
        r_led = _run('open-append', '--ns', 'alpha', '--rel', 'ledger.jsonl', '--text', 'x',
                     '--ledger', str(ledger), root=root)
        out.append(Assertion("② 往**声明的事实路径**写文件被拒（并给出机器可读 code + next_action）",
                             bool(_code(r_led)) and bool(r_led.get('next_action')),
                             f"code={_code(r_led)} next_action={str(r_led.get('next_action'))[:40]}"))
    return out

@register('AC-STORAGE-006', 'P2', '存储只读观察面：有界、确定性、不出正文与私域哨兵；读它不改任何状态',
          'tools/verify.sh ac AC-STORAGE-006')
def check_observe() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        root = base / 'store'
        root.mkdir()
        sen_file = 'SENTINEL-BODY-TEXT-7c1'
        _append_lines(root, 'alpha', 'log.jsonl', 12)
        _run('put', '--ns', 'alpha', '--table', 't', '--key', 'k', '--value', sen_file, root=root)
        _run('put', '--ns', 'beta', '--table', 't', '--key', 'k2', '--value', 'v2', root=root)

        def file_hashes() -> dict:
            """既有文件的逐字节指纹（**不含** snapshot 自己落的派生文件：那是它该做的事）。"""
            out = {}
            for f in sorted(root.rglob('*')):
                if f.is_file() and not f.name.startswith('snapshot'):
                    out[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
            return out

        before = file_hashes()
        snap = base / 'snap.json'
        r1 = _run('snapshot', '--ns', 'alpha', root=root)
        a = json.loads(json.dumps(r1))
        r2 = _run('snapshot', '--ns', 'alpha', root=root)
        b = json.loads(json.dumps(r2))
        after = file_hashes()

        out.append(Assertion("① 只读观察面可采且**确定性**（两次快照逐字节一致）",
                             r1.get('ok') is True and r2.get('ok') is True
                             and json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False),
                             f"ok={r1.get('ok')}/{r2.get('ok')} bytes={r1.get('bytes')}"))
        out.append(Assertion("① **读它不改任何状态**：快照前后**既有文件逐字节不变**（派生快照文件本身不算状态改动）",
                             before == after,
                             f"既有文件数={len(before)} 变化={[k for k in set(before) | set(after) if before.get(k) != after.get(k)][:3]}"))
        text = json.dumps(r1, ensure_ascii=False)
        out.append(Assertion("① 不出正文与私域类键（哨兵正文不出现；输出里没有 body/private 类键）",
                             sen_file not in text and not re.search(r'"(body|private|private:|subject)"', text),
                             f"哨兵出现={sen_file in text} 输出键={sorted(r1.keys())[:8]}"))
    return out
