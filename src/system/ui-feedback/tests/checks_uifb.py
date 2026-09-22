"""AC-UIFB-001 机检：WebUI 自适应闭环（反馈 → 新版本 → 自动重载 → 提示"请刷新"）的**结构性**事实。

真 HTTP 端到端与 Python 侧落账本者由 `tools/verify.sh ui-feedback` 举证
（围栏门 `host/t280-ui-feedback-gate.mjs` 28 条断言含 4 处单点变异 + `tools/check-ui-feedback.py` 11 条）。

无 Node 时**降级**并明说（ADR-0013 §8），不把"没跑到"当成"通过"。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
MOD = ROOT / 'src' / 'system' / 'ui-feedback' / 'code' / 'ui-feedback.mjs'   # 实体（本批 EV-178 搬进本插件 `code/`；旧路径 `host/modules/ui-feedback.mjs` 只剩薄重导）
APPLY = ROOT / 'src' / 'system' / 'ui-feedback' / 'tools' / 'ui-feedback-apply.py'   # 实体（本批 EV-178 搬进本插件 tools/；旧路径只剩薄转发）
GATE = ROOT / 'src' / 'system' / 'ui-feedback' / 'tests' / 't280-ui-feedback-gate.mjs'
ROUTE_CHECK = ROOT / 'src' / 'system' / 'ui-feedback' / 'tests' / 'check-ui-feedback.py'   # 实体（EV-177 搬进本插件 tests/；旧路径只剩薄转发）
WEBUI = ROOT / 'src' / 'system' / 'webui' / 'code' / 'webui.mjs'   # 实体（本批 EV-178 搬进本插件 `code/`；旧路径 `host/modules/webui.mjs` 只剩薄重导）
INVENTORY = ROOT / 'docs' / 'design' / '14-plugin-inventory.md'
SCRIPT_NEEDLE = '<scr' + 'ipt'


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@register('AC-UIFB-001', 'P2',
          'WebUI 自适应闭环：反馈页 SSR（0 内联脚本）→ 提交只落 0600 待办件（账本零新增）→ '
          'Python 侧唯一落账本者原子写版本状态 → 页面 data-ui-revision 与版本落后时的"请刷新"横幅（服务端可判）',
          'tools/verify.sh ac AC-UIFB-001', evidence_refs=('EV-148',))
def check() -> list[Assertion]:
    out: list[Assertion] = []
    src = MOD.read_text(encoding='utf-8') if MOD.is_file() else ''
    apply_src = APPLY.read_text(encoding='utf-8') if APPLY.is_file() else ''
    gate = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    route = ROUTE_CHECK.read_text(encoding='utf-8') if ROUTE_CHECK.is_file() else ''
    webui = WEBUI.read_text(encoding='utf-8') if WEBUI.is_file() else ''
    inventory = INVENTORY.read_text(encoding='utf-8') if INVENTORY.is_file() else ''

    out.append(Assertion('① 三件产物齐备（宿主插件 / 唯一落账本者 / 围栏门 / 真 HTTP 门）',
                         all(len(text) > 1000 for text in (src, apply_src, gate, route)),
                         f"plugin={len(src)}B apply={len(apply_src)}B gate={len(gate)}B route={route and len(route)}B"))

    # 宿主侧：SSR 表单 + 只落待办件 + 不写账本 + 不递增版本号 + 服务端可判横幅
    marks = {
        'feedback_page': '<textarea name="text"' in src and 'method="post"' in src,
        'pending_0600': 'chmodSync(tmp, 0o600)' in src and 'renameSync' in src,
        'no_ledger_import': 'openLedger' not in src and 'ledger.jsonl' not in src,
        'read_versions': 'versions.json' in src and 'REVISION_ZERO' in src,
        'stale_banner': 'data-ui-stale="true"' in src and '已更新到' in src and '请刷新页面' in src,
        'observed_by_seen': 'seen' in src and 'form method="get"' in src,
        'degraded_reasons': 'DEGRADED_REASONS' in src and 'versions-missing' in src and 'versions-unreadable' in src,
        'bounded': 'pending_limit' in src and 'omitted' in src,
    }
    out.append(Assertion('① 宿主侧语义齐备（SSR 表单 / 0600 待办件 / 不写账本 / 版本来自落盘 / 落后横幅 + seen / '
                         '有名 degraded / 有界）', all(marks.values()), f"marks={marks}"))

    # 页面仍 0 脚本（源码级；HTTP 级由两半门举证）
    code = '\n'.join(line for line in src.splitlines() if not line.lstrip().startswith(('//', '*', '/*', '#')))
    webui_code = '\n'.join(line for line in webui.splitlines() if not line.lstrip().startswith(('//', '*', '/*', '#')))
    # 写面白名单外的写函数（`writeFileSync` 是**待办件**那条允许的写；`writeFile(` 是另一件事，必须没有）
    forbidden = sorted(set(re.findall(r'appendFileSync|createWriteStream|child_process|fetch\(|writeFile\(|'
                                      r'unlinkSync|truncateSync|execSync|execFileSync|spawnSync', code)))
    out.append(Assertion('① 页面交互**只用表单/链接**（非注释源码里无脚本字面量、无内联事件属性），'
                         '宿主侧不写账本、不起子进程、不联网（写面只有 0600 待办件那条）',
                         SCRIPT_NEEDLE not in code and not re.search(r'\son[a-z]+=', code)
                         and not forbidden and 'openLedger' not in code
                         and SCRIPT_NEEDLE not in webui_code,
                         f"script={code.count(SCRIPT_NEEDLE)} 越界={forbidden}"))

    # Python 侧：唯一落账本者（8 键 body、原子写、幂等、拒绝码）
    body_match = re.search(r'\n\s*body = \{"view": item\["view"\],.*?\}\n', apply_src, re.S)
    body_text = body_match.group(0) if body_match else ''
    apply_marks = {
        'event': 'ui/feedback-applied' in apply_src,
        'body_keys': all(key in body_text for key in ('"revision"', '"prev_revision"', '"artifact_sha256"',
                                                      '"source_prompt_digest"', '"actor"', '"ok"', '"reason"')),
        'no_body_in_ledger': bool(body_text) and '"text"' not in body_text,
        'atomic_state': 'os.replace' in apply_src and 'fsync' in apply_src and 'chmod(tmp, 0o600)' in apply_src,
        'archive_not_delete': 'shutil.move' in apply_src and 'unlink' not in apply_src,
        'idempotent': 'duplicates' in apply_src and 'already-applied' in apply_src,
        'refusal_codes': all(item in apply_src for item in ('artifact-missing', 'hash-mismatch', 'pending-tampered')),
        'mode_gate': '0o600' in apply_src and 'pending-insecure-mode' in apply_src,
    }
    out.append(Assertion('① Python 侧语义齐备（事件名 / body 8 键且不含正文 / 原子写 / 归档不删 / 幂等 duplicates / '
                         '三条拒绝码 / 权限门 0600）', all(apply_marks.values()),
                         f"marks={apply_marks} body_keys={sorted(re.findall(r'\"([a-z_]+)\":', body_text))}"))

    # 门与登记
    out.append(Assertion('① 围栏门含单点变异与还原自证（不是空壳门）',
                         all(needle in gate for needle in ('MUTATIONS', 'mustRed', '假变异', '逐字节一致')),
                         'gate marks=' + str([n for n in ('MUTATIONS', 'mustRed', '假变异') if n in gate])))
    verify = (ROOT / 'tools' / 'verify.sh').read_text(encoding='utf-8')
    out.append(Assertion('① `verify.sh ui-feedback` 门已挂（两半都跑）',
                         'ui-feedback)' in verify and 't280-ui-feedback-gate.mjs' in verify
                         and 'check-ui-feedback.py' in verify,
                         'verify=' + str('ui-feedback)' in verify)))
    out.append(Assertion('① 插件清单登记 `host/modules/ui-feedback.mjs`（`plugins` 门要求逐行归属）',
                         '`host/modules/ui-feedback.mjs`' in inventory and '`uiFeedback`' in inventory,
                         f"inventory={len(inventory)}B"))

    if _node():
        proc = subprocess.run(['node', '--input-type=module', '-e',
                               "import * as M from './host/modules/ui-feedback.mjs';"
                               "const h={snapshot:()=>({service:'ui-feedback',queue:{pending:0},scope:{},degraded:true}),"
                               "revisionOf:()=>'r0'};"
                               "console.log(JSON.stringify({keys:Object.keys(M),provides:M.provides,"
                               "inject:M.inject,reasons:M.DEGRADED_REASONS,sample:M.fixture.sample(h)}))"],
                              cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        try:
            data = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            data = {}
        out.append(Assertion('① 插件模块可加载且导出预期符号（provides/inject/闭合 reason 集合/fixture 采样点）',
                             data.get('provides') == ['uiFeedback'] and data.get('inject') == []
                             and isinstance(data.get('reasons'), list) and isinstance(data.get('sample'), str)
                             and len(data.get('sample') or '') > 10,
                             f"provides={data.get('provides')} inject={data.get('inject')} "
                             f"reasons={data.get('reasons')} sample={data.get('sample')}"))
    else:
        out.append(Assertion('① 插件模块存在且非空（无 Node：**降级**；HTTP 与横幅行为由 `verify.sh ui-feedback` 守卫）',
                             len(src) > 8000, f"bytes={len(src)}"))
    return out
