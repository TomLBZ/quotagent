#!/usr/bin/env python3
"""B16b：按手册在**干净副本**里实跑一遍（不联网、不装包），把原始输出落成证据。

为什么这么干：手册的价值在于"别人照着能做"，不是"作者描述得清楚"。所以把仓库导出一份干净副本
（`git archive`，不含 tmp/ 与 .git 之外的工作区脏物），在该副本里按手册顺序执行，原始输出即证据。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

#: 仓库根由**本文件位置**推出（`tools/` 上溯 1 层）—— 硬编码绝对路径会让「克隆到别的路径」就废
#: （可移植性，服务「克隆即跑」；机检 `tools/verify.sh plugin-assets` 的 PA9）。
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'tmp' / 'manual-check'
LOG = ROOT / 'docs' / 'work' / 'evidence' / 'EV-055-deployment-manual-walkthrough.txt'


def sh(*args, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=1800, **kw)


def main() -> int:
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    # 干净副本：只取已提交内容（含 tools/、src/、docs/、host/），不带 tmp/ 与 .venv
    archive = WORK / 'quotagent.tar'
    tar = sh('git', 'archive', '--format=tar', '-o', str(archive), 'HEAD', cwd=str(ROOT))
    if tar.returncode != 0:
        print('git archive 失败', tar.stderr[-300:])
        return 2
    shutil.unpack_archive(str(archive), str(WORK / 'quotagent'))
    copy = WORK / 'quotagent'
    print('干净副本:', copy)

    lines = ['EV-055 — 按《部署与操作手册》在干净副本里实跑（T-215b / S1.14）', '',
             f'副本来源: git archive HEAD → {copy}',
             '环境: 无网络、不装第三方包；解释器由仓库内 tools/runtime.sh 解析', '',
             '说明: 手册第 1、2、3 节的每一步都在此副本里按顺序执行，下面是原始输出（截断单行长度）。', '']
    steps = [
        ('手册 §0 解释器解析', [str(copy / 'tools/verify.sh'), 'smoke']),
        ('手册 §1 文档门', [str(copy / 'tools/verify.sh'), 'docs']),
        ('手册 §2 两个真进程走查', [sys.executable, str(copy / 'tools/g1-walkthrough.py')]),
    ]
    failures = []
    for title, cmd in steps:
        proc = sh(*cmd, cwd=str(copy), env={**os.environ, 'PYTHONPATH': str(copy / 'src')})
        lines.append(f'=== {title} ===')
        lines.append(f'$ {" ".join(cmd)}   （退出码 {proc.returncode}）')
        for line in (proc.stdout or '').strip().splitlines()[-24:]:
            lines.append('  ' + line[:200])
        if proc.stderr.strip():
            lines.append('  [stderr] ' + proc.stderr.strip().splitlines()[-1][:200])
        lines.append('')
        if proc.returncode != 0:
            failures.append(title)

    lines.append('=== 结论 ===')
    lines.append(f'手册步骤实跑: {len(steps) - len(failures)}/{len(steps)} 通过'
                 + (f'；失败 {failures}' if failures else '（干净副本可用：裸解释器即可跑通，无需装包/联网）'))
    LOG.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('证据:', LOG, LOG.stat().st_size, 'B')
    print(f'步骤 {len(steps) - len(failures)}/{len(steps)} 通过', failures)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
