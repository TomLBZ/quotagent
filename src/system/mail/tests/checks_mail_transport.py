"""AC-MAIL-002 机检：邮件由插件提供 —— 凭据就位时真收发、没凭据时诚实报未连接。

结构性事实（HTTP 行为与回环真收发由 `verify.sh mail-transport` 27/27 举证）。
无 Node 时降级并明说（ADR-0013 §8）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
#: 阶段 5（EV-175）：`transport` / `mail` 的**实体**已搬到 `src/system/mail/code/`，旧路径只剩**薄重导**。
#: 这里必须指实体 —— 读旧路径的话，"专属 reason / 异常洗过" 这类**源码文本**判据会在 14 行转发上判红
#: （实测：`p0-no-node` 的 AC-MAIL-002 就是这样红的）。
FILES = {'transport': ROOT / 'src' / 'system' / 'mail' / 'code' / 'mail_transport.py',
         'mail': ROOT / 'src' / 'system' / 'mail' / 'code' / 'mail.py',
         # 实体（本批 `EV-178` 搬进本插件 `code/`；旧路径 `host/modules/mail-view.mjs` 只剩薄重导）：
         # 本 AC 按**源码字节**判「视图模块非空/够大」⇒ 必须读实体那一份（读 289 B 的转发会误判）。
         'view': ROOT / 'src' / 'system' / 'mail' / 'code' / 'mail-view.mjs',
         'keys': ROOT / 'src' / 'system' / 'config' / 'code' / 'config-keys.mjs',
         # 实体（EV-177 搬进本插件 tests/；旧路径只剩薄转发 ⇒ 按大小/文本判的读点必须指实体）
         'gate': ROOT / 'src' / 'system' / 'mail' / 'tests' / 'check-mail-transport.py'}


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@register('AC-MAIL-002', 'P2', '邮件由插件提供：未配置诚实报未连接（区分"没配/连不上"）、配置后真收发、凭据零泄漏',
          'tools/verify.sh ac AC-MAIL-002')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    missing = [k for k, p in FILES.items() if not p.is_file()]
    out.append(Assertion("① 五个部件齐备（transport / mail / 只读视图 / 键白名单 / 门脚本）", not missing, f"缺失={missing}"))
    tr = FILES['transport'].read_text(encoding='utf-8') if FILES['transport'].is_file() else ''
    keys = FILES['keys'].read_text(encoding='utf-8') if FILES['keys'].is_file() else ''
    view = FILES['view'].read_text(encoding='utf-8') if FILES['view'].is_file() else ''
    # 未配置与连不上必须**可区分**（两个不同 reason），且不得自称已连接
    reasons = {k: (k in tr) for k in ('mail-smtp-unconfigured', 'mail-imap-unconfigured',
                                      'smtp-unreachable', 'imap-unreachable')}
    out.append(Assertion("① 未配置与连不上**各有专属 reason**（不是笼统失败，也不自称已连接）",
                         sum(reasons.values()) >= 3, f"reasons={reasons}"))
    # 凭据不进日志/账本正文/异常消息：源码里有洗异常的痕迹（不直接抛原始串）
    scrub = bool(re.search(r'redact|sanitiz|洗|scrub', tr))
    out.append(Assertion("① 异常/日志里的凭据要洗过（源码有 redact/scrub 类处理）", scrub, f"scrub_marker={scrub}"))
    # 邮件键在白名单里（⇒ 上批的配置 UI 能直接改并持久化）
    mailkeys = len(re.findall(r"'mail\.(smtp|imap)\.", keys))
    out.append(Assertion("① 邮件配置键已进白名单（⇒ 配置 UI 可改并持久化，无需另写一条写路径）",
                         mailkeys >= 6, f"mail.* 白名单键数={mailkeys}"))
    # 宿主视图零写面 + 0 script
    out.append(Assertion("① 宿主只读视图零写面（不写文件）且不引入 `<script>`",
                         not re.search(r'writeFileSync|appendFileSync|createWriteStream|mkdirSync',
                                       '\n'.join(l for l in view.splitlines()
                                                  if not l.lstrip().startswith(('//', '*', '/*')))),
                         f"view_bytes={len(view)}"))
    v = (ROOT / 'tools' / 'verify.sh').read_text(encoding='utf-8')
    out.append(Assertion("① `verify.sh mail-transport` 门已挂（回环真收发由它举证）",
                         'mail-transport)' in v and 'check-mail-transport.py' in v, "gate=" + str('mail-transport)' in v)))
    if _node():
        r = subprocess.run(['node', '--input-type=module', '-e',
                            "import * as M from './host/modules/mail-view.mjs';console.log(JSON.stringify(Object.keys(M)))"],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        try:
            exported = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            exported = []
        out.append(Assertion("① 只读视图模块可加载且导出预期符号（非空转）",
                             'provides' in exported or 'name' in exported, f"exports={exported[:6]}"))
    else:
        out.append(Assertion("① 只读视图模块存在且非空（无 Node：**降级**；HTTP 行为由 `verify.sh mail-transport` 守卫）",
                             len(view) > 2000, f"view_bytes={len(view)}"))
    return out
