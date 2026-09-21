#!/usr/bin/env python3
"""干净副本自足性门（fresh-clone / fresh-mount 可复现性）：

把**已提交内容**（`git archive HEAD`）解到 `tmp/clean-copy/`，只给裸解释器（无网络、不安装 Python 包），
跑关键门。这一步专门抓"本地能跑、克隆就废"的缺陷——实测抓到过：`.gitignore` 的 `lib/` 通配吞掉
`host/lib/*.mjs` 整层，本地一切正常、干净副本缺库。

用法：`python3 tools/check-clean-copy.py [--keep]`
退出码：0 = 所有子门在干净副本里通过；1 = 有子门失败；2 = 环境错误（git/python 缺失、解包失败）。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'tmp' / 'clean-copy'
GATES = [('docs', ['docs']), ('cordis 冒烟', ['cordis']), ('事件门', ['events']),
         ('进树模块 fixture', ['modules']), ('插件清单门', ['plugins']), ('WebUI 门', ['webui']),
         ('canary 门', ['canary']), ('canary-route 门', ['canary-route']), ('bridge-canary 门', ['bridge-canary']), ('governor 门', ['governor']), ('不变量门', ['invariants']), ('演化门', ['evolution']),
         ('AC 注册表', ['ac-registry']), ('无 Node 下的 P0', ['p0-no-node'])]


def main(argv: list[str]) -> int:
    if not (ROOT / '.git').exists():
        print('clean-copy 门：不是 git 仓库', file=sys.stderr)
        return 2
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    archive = subprocess.run(['git', 'archive', 'HEAD'], cwd=str(ROOT), capture_output=True)
    if archive.returncode != 0:
        print(f"clean-copy 门：git archive 失败：{archive.stderr.decode()[:200]}", file=sys.stderr)
        return 2
    untar = subprocess.run(['tar', '-x', '-C', str(WORK)], input=archive.stdout, capture_output=True)
    if untar.returncode != 0:
        print(f"clean-copy 门：解包失败：{untar.stderr.decode()[:200]}", file=sys.stderr)
        return 2

    files = sum(1 for _ in WORK.rglob('*') if _.is_file())
    print(f"干净副本：{WORK}（{files} 个文件，仅已提交内容）")

    # 自足性前置断言：被 import 的宿主库层必须在副本里存在（正是历史缺陷点）
    required = ['host/lib/config.mjs', 'host/lib/schema.mjs', 'host/lib/frozen.mjs', 'host/lib/std-schema.mjs',
                'host/lib/ledger-view.mjs', 'host/modules/webui.mjs', 'host/modules/index.mjs', 'host/modules/canary.mjs', 'host/canary.mjs',
                'docs/design/adr/0016-self-evolution-artifact-surface.md', 'docs/design/adr/0017-canary-routing-and-auto-rollback.md',
                'host/package-lock.json', 'src/quotagent/kernel/ledger.py']
    missing = [rel for rel in required if not (WORK / rel).exists()]
    print(f"[{'ok' if not missing else 'FAIL'}] 自足性：{len(required) - len(missing)}/{len(required)} 个必需文件在副本里"
          + (f"；缺 {missing}" if missing else ''))

    failed: list[str] = []
    for label, gate in GATES:
        env = dict(os.environ)
        env['QUOTAGENT_ROOT'] = str(WORK)          # 门内部以此为准（run.sh / runtime.sh 会读）
        env['PATH'] = os.environ.get('PATH', '')   # 保留工作区工具链：fresh mount 就是这种状态
        proc = subprocess.run([str(WORK / 'tools' / 'verify.sh'), *gate],
                              cwd=str(WORK), capture_output=True, text=True, env=env, timeout=1800)
        tail = [line for line in (proc.stdout or proc.stderr).strip().splitlines() if line.strip()]
        print(f"[{'ok' if proc.returncode == 0 else 'FAIL'}] {label}: exit={proc.returncode} | "
              f"{tail[-1][:96] if tail else ''}")
        if proc.returncode != 0:
            failed.append(label)
            print('        ' + ' / '.join(tail[-4:])[:400])

    if not argv or '--keep' not in argv:
        shutil.rmtree(WORK, ignore_errors=True)
    if missing or failed:
        print(f"RESULT: FAIL（缺文件 {len(missing)}；失败门 {failed}）")
        return 1
    print(f"RESULT: PASS（{len(GATES)} 道门在干净副本里全绿；已提交内容自足可复现）")
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
