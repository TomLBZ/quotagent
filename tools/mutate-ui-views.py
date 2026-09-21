"""变异自证（`tools/verify.sh ui-mutate`）：逐处偷改实现 → 对应门必须**真变红**（自带防假变异）。

T-263：三域视图的"有界 / 定序 / 投影"这三条性质，若门抓不到偷改，门就只是装饰。

每处变异：改一处 → 跑对应门 → 断言门红 → **还原并核对 sha256 与改前一致**。
锚点未命中、或改了但文件字节没变 → 判为"假变异"并让脚本失败（不能拿"假变异"冒充自证）。
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

ROOT = Path('/workspace/projects/quotagent')
OUT = Path(ROOT / 'tmp' / 'ui-mutate.log')
lines: list[str] = []


def log(s: str) -> None:
    print(s)
    lines.append(s)


def run(cmd: list[str], timeout: int = 900) -> tuple[int, str]:
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


MUTATIONS = [
    dict(name='M1 写入器上限 5→50（有界被破坏）', path='tools/refresh-ui-snapshots.py',
         old='RECENT_LIMIT = 5', new='RECENT_LIMIT = 50', gate=['ui-seed']),
    dict(name='M2 写入器倒序→正序（最新在后）', path='tools/refresh-ui-snapshots.py',
         old='return list(reversed(picked[-RECENT_LIMIT:]))', new='return picked[:RECENT_LIMIT]',
         gate=['ui-seed']),
    dict(name='M3 写入器原样透传（正文/私域随行出去）', path='tools/refresh-ui-snapshots.py',
         old='    return [one(row) for row in _recent_rows(rows, ROUND_EVENT)]',
         new='    return [_body(row) for row in _recent_rows(rows, ROUND_EVENT)]', gate=['ui-seed']),
    dict(name='M4 路由去掉按键投影（原样透传）', path='host/modules/webui.mjs',
         old='          .map((row) => Object.fromEntries(RECENT_KEYS.filter((k) => row && Object.prototype.hasOwnProperty.call(row, k)).map((k) => [k, row[k]])))',
         new='          .map((row) => row)', gate=['webui']),
]

results: list[tuple[str, bool, str]] = []
for m in MUTATIONS:
    p = ROOT / m['path']
    before_sha = sha(p)
    t = p.read_text(encoding='utf-8')
    if m['old'] not in t:
        log(f'【假变异】{m["name"]}：锚点未命中 → 脚本失败（不得冒充自证）')
        results.append((m['name'], False, '锚点未命中'))
        continue
    p.write_text(t.replace(m['old'], m['new'], 1), encoding='utf-8')
    after_sha = sha(p)
    if after_sha == before_sha:
        log(f'【假变异】{m["name"]}：文件字节未变 → 脚本失败')
        results.append((m['name'], False, '字节未变'))
        continue
    codes = []
    for g in m['gate']:
        rc, out = run(['tools/verify.sh', g])
        codes.append((g, rc, [l.strip() for l in out.splitlines() if l.strip().startswith('FAIL')][:1]))
    p.write_text(t, encoding='utf-8')          # 还原
    restored = sha(p) == before_sha
    red = all(rc != 0 for _g, rc, _d in codes)
    log(f'{"✓" if red and restored else "✗"} {m["name"]} → ' +
        ', '.join(f'{g} exit={rc} {d[0][:60] if d else ""}' for g, rc, d in codes) +
        f' | 还原一致={restored}')
    results.append((m['name'], red and restored, str(codes)))

log('')
ok = all(r[1] for r in results)
log(f'结论：{sum(1 for r in results if r[1])}/{len(results)} 处变异真变红且已还原'
    + ('（全部通过）' if ok else '（有未通过项）'))
for name, good, detail in results:
    log(f'  {"✓" if good else "✗"} {name}')

OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('原始输出留档:', OUT)
raise SystemExit(0 if ok else 1)
