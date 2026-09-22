"""AC-QUOTE-001 机检：**报价草稿写闭环**（「不要假成功」的结构性形态）。

真 HTTP 端到端与围栏（含 4 处单点变异）由 `tools/verify.sh quote-draft` 举证
（围栏门 `host/t286-quote-draft-gate.mjs` 17 条 + `tools/check-quote-draft-route.py` 14 条）。

本 AC 走**无 Node 也能跑**的那一半（ADR-0013 §8：P0 可复跑性不因引入宿主而失去）：
  · 真跑 `tools/quote-draft.py`（**唯一落账本者**）：0600 待办件 → **两侧账本各一行** `quote/drafted`
    （body 恰 12 键、**不含备注正文**）→ 待办件移入 `applied/`；幂等；四条拒绝码（权限/被改过/
    行项目不存在/动作不是 draft），且**拒绝时账本零新增**；
  · 真跑 `tools/quote-sign.py`：`agent:*` 被拒（`human-required`）而 `human:*` 落
    `approval/requested → approval/granted → quote/submitted`（**签名只能由人**）。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch
from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
MOD = ROOT / 'src' / 'domain' / 'quote-prepare' / 'code' / 'quote-prepare.mjs'   # 实体（本批 EV-178 搬进本插件 `code/`；旧路径 `host/modules/quote-prepare.mjs` 只剩薄重导）
TOOL = ROOT / 'src' / 'domain' / 'quote-prepare' / 'tools' / 'quote-draft.py'
SIGNER = ROOT / 'src' / 'domain' / 'quote-prepare' / 'tools' / 'quote-sign.py'
GATE = ROOT / 'src' / 'domain' / 'quote-prepare' / 'tests' / 't286-quote-draft-gate.mjs'
ROUTE_CHECK = ROOT / 'src' / 'domain' / 'quote-prepare' / 'tests' / 'check-quote-draft-route.py'
WEBUI = ROOT / 'src' / 'system' / 'webui' / 'code' / 'webui.mjs'   # 实体（本批 EV-178 搬进本插件 `code/`；旧路径 `host/modules/webui.mjs` 只剩薄重导）
VERIFY = ROOT / 'tools' / 'verify.sh'
INVENTORY = ROOT / 'docs' / 'design' / '14-plugin-inventory.md'
SCRIPT_NEEDLE = '<scr' + 'ipt'
INLINE_EVENT = re.compile(r'\son[a-z]+\s*=', re.I)
BODY_KEYS = ['currency', 'item_id', 'lead_time_days', 'lines_sha256', 'note_sha256', 'ok', 'prepared_by',
             'quote_draft_id', 'rfq_id', 'supplier', 'unit_price_cents', 'view']
NOTE = '周五下班前回你确切交期（备注正文｜绝不许进账本）'
NOW = '2026-09-21T22:00:00Z'


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def _canonical(record: dict) -> str:
    lines = {'currency': str(record.get('currency') or ''), 'item_id': str(record.get('item_id') or ''),
             'lead_time_days': record.get('lead_time_days'), 'rfq_id': str(record.get('rfq_id') or ''),
             'unit_price_cents': record.get('unit_price_cents')}
    return json.dumps(lines, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _rows(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out = []
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def _run(tool: Path, *extra: str) -> tuple[int, dict]:
    proc = subprocess.run([sys.executable, str(tool), *extra], capture_output=True, text=True, timeout=180,
                          cwd=str(ROOT))
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        payload = {}
    return proc.returncode, payload


def _pending(inbox: Path) -> list[Path]:
    return sorted(inbox.glob('qd-*.json')) if inbox.is_dir() else []


def _write_pending(inbox: Path, name: str, record: dict, mode: int = 0o600) -> Path:
    inbox.mkdir(parents=True, exist_ok=True)
    path = inbox / name
    path.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
    os.chmod(path, mode)
    return path


def _record(draft_id: str = 'qd-supplier-0123456789ab', **over: object) -> dict:
    record = {'schema': 1, 'kind': 'quote-draft', 'view': 'supplier', 'requested_action': 'draft',
              'rfq_id': 'pkg-g1', 'item_id': 'L-001', 'unit_price_cents': 8600, 'lead_time_days': 7,
              'currency': 'CNY', 'prepared_by': 'human:zhang', 'supplier': 'supplier:g1', 'note': NOTE,
              'submitted_at': '', 'quote_draft_id': draft_id}
    record.update(over)
    record['note_sha256'] = _sha(str(record['note']))
    record['lines_sha256'] = _sha(_canonical(record))
    record['bytes'] = len(str(record['note']).encode('utf-8'))
    return record


@register('AC-QUOTE-001', 'P2',
          '报价草稿写闭环：宿主只落 0600 待办件（账本零新增）→ Python 侧唯一落账本者落 quote/drafted'
          '（非签名动作、body 恰 12 键、不含备注正文、两侧登记 ⇒ 双向可见）→ 签名只能由人'
          '（quote-sign.py 拒 agent:*，human:* 才落 quote/submitted）；宿主对只读路由的写请求一律 405',
          'tools/verify.sh ac AC-QUOTE-001', evidence_refs=('EV-161',))
def check() -> list[Assertion]:  # noqa: C901
    out: list[Assertion] = []
    src = MOD.read_text(encoding='utf-8') if MOD.is_file() else ''
    tool_src = TOOL.read_text(encoding='utf-8') if TOOL.is_file() else ''
    signer_src = SIGNER.read_text(encoding='utf-8') if SIGNER.is_file() else ''
    gate_src = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    route_src = ROUTE_CHECK.read_text(encoding='utf-8') if ROUTE_CHECK.is_file() else ''
    webui = WEBUI.read_text(encoding='utf-8') if WEBUI.is_file() else ''
    verify = VERIFY.read_text(encoding='utf-8') if VERIFY.is_file() else ''

    out.append(Assertion('① 五件产物齐备（插件 / 唯一落账本者 / 人工签名入口 / 围栏门 / 真 HTTP 门）且门已登记',
                         all(len(text) > 1000 for text in (src, tool_src, signer_src, gate_src, route_src))
                         and 'quote-draft)' in verify,
                         f'plugin={len(src)}B draft={len(tool_src)}B sign={len(signer_src)}B '
                         f'gate={len(gate_src)}B route={len(route_src)}B'))

    # 宿主侧「假成功围栏」+ 准备页路由（静态）
    marks = {
        'guard_tables': 'GET_ONLY_PATTERNS' in webui and 'WRITE_PATTERNS' in webui,
        'method_code': 'method-not-allowed' in webui and "allow: 'GET'" in webui,
        'prepare_route': 'quotes\\/prepare' in webui and '/quotes/prepare/' in webui,
        'signature_mark': 'data-signature-required=' in webui,
        'no_sign_in_service': all(word not in src.split('ctx.provide')[1][:2000] for word in ())
        or 'can_sign: false' in src,
        'zero_inline_script': SCRIPT_NEEDLE not in webui.split('const prepPageHtml =')[1].split('const submitDraft =')[0],
    }
    out.append(Assertion('② 宿主侧：只读路由的写请求围栏（405 + `Allow: GET` + `method-not-allowed`）、'
                         '`GET|POST /supplier/quotes/prepare/` 两条路由、`data-signature-required` 页面标记、'
                         '准备页模板段 **0 行脚本 / 0 内联事件**',
                         marks['guard_tables'] and marks['method_code'] and marks['prepare_route']
                         and marks['signature_mark'] and marks['zero_inline_script']
                         and not INLINE_EVENT.search(webui.split('const prepPageHtml =')[1].split('const submitDraft =')[0]),
                         json.dumps(marks)))

    # 插件：不能签名 / 不能提交 / 零写面
    service_slice = src.split("ctx.provide('quotePrepare'", 1)[1] if "ctx.provide('quotePrepare'" in src else ''
    forbidden = [word for word in ('sign', 'approve', 'decide', 'send', 'commit')
                 if re.search(rf'\b{word}\s*:', service_slice)]
    out.append(Assertion('③ 插件**不能签名/不能批准/不能发信**：服务面声明 `provides=[quotePrepare]`、'
                         '`can_sign: false`、`signature_required: true`，且服务面里没有 sign/approve/decide/send '
                         '这类方法；源码不 import `node:fs`、不出现 `Date.now`（零写面、不取墙钟）',
                         "provides" in src and 'can_sign: false' in src and 'signature_required: true' in src
                         and not forbidden and "node:fs" not in src and 'Date.now' not in src
                         and 'inject = []' in src,
                         f'禁止词命中={forbidden}；含 node:fs={"node:fs" in src}；含 Date.now={"Date.now" in src}'))

    # 真跑唯一落账本者（无 Node 也能跑的那一半）
    root = new_scratch('ac-quote-001')
    shared = root / 'ui-shared'
    inbox = shared / 'quote-drafts'
    supplier_ledger = shared / 'supplier' / 'ledger.jsonl'
    contractor_ledger = shared / 'contractor' / 'ledger.jsonl'
    for path in (supplier_ledger, contractor_ledger):
        path.parent.mkdir(parents=True, exist_ok=True)
    Ledger(supplier_ledger, realm='supplier:g1').append(
        'rfq/published', {'package_id': 'pkg-g1', 'rev': 2,
                          'items': [{'item_id': 'L-001'}, {'item_id': 'L-002'}]},
        correlation_id='pkg-g1', ts='2026-09-21T10:00:00Z', actor='agent:fixture')
    Ledger(contractor_ledger, realm='contractor:con-B').append(
        'rfq/published', {'package_id': 'pkg-g1', 'rev': 2, 'items': 2},
        correlation_id='pkg-g1', ts='2026-09-21T10:00:00Z', actor='agent:fixture')

    extra = ['--ui-shared', str(shared), '--ledger-supplier', str(supplier_ledger),
             '--ledger-contractor', str(contractor_ledger), '--now', NOW]
    _write_pending(inbox, 'qd-supplier-0123456789ab.json', _record())
    code_ok, payload_ok = _run(TOOL, *extra)
    supplier_rows = [row for row in _rows(supplier_ledger) if row.get('type') == 'quote/drafted']
    contractor_rows = [row for row in _rows(contractor_ledger) if row.get('type') == 'quote/drafted']
    body = supplier_rows[0]['body'] if supplier_rows else {}
    applied = sorted(path.name for path in (inbox / 'applied').glob('*.json')) if (inbox / 'applied').is_dir() else []
    out.append(Assertion('④ 真跑 `tools/quote-draft.py`（唯一落账本者）：**两侧账本各 +1** `quote/drafted`'
                         '（一方是自己准备的事实、另一方是「供应商已准备报价」的通知）、body **恰 12 键**、'
                         '**不含备注正文**（只留 `note_sha256`）、待办件移入 `applied/`',
                         code_ok == 0 and payload_ok.get('ledger_added') == 2
                         and sorted(body) == BODY_KEYS and len(supplier_rows) == 1
                         and len(contractor_rows) == 1 and contractor_rows[0]['body'].get('view') == 'contractor'
                         and NOTE not in supplier_ledger.read_text(encoding='utf-8')
                         and NOTE not in contractor_ledger.read_text(encoding='utf-8')
                         and applied == ['qd-supplier-0123456789ab.json']
                         and body.get('note_sha256') == _sha(NOTE),
                         f'rc={code_ok} ledger_added={payload_ok.get("ledger_added")} 键={sorted(body)} '
                         f'applied={applied}'))

    supplier_lines = len(_rows(supplier_ledger))
    # 幂等：把**同一份**待办件重新写回 inbox 再跑 ⇒ duplicates + 账本零新增
    _write_pending(inbox, 'qd-supplier-0123456789ab.json', _record())
    code_dup, payload_dup = _run(TOOL, *extra)
    dup_first = (payload_dup.get('duplicates') or [{}])[0]
    idem_ok = (code_dup == 0 and payload_dup.get('ledger_added') == 0
               and dup_first.get('reason') == 'already-drafted'
               and dup_first.get('file') == 'qd-supplier-0123456789ab.json')
    # 拒绝路径：**一次只放一条坏件**（否则 `refused[0]` 是别人的），逐条按文件名取 code
    tamper = _record('qd-supplier-bbbb00000000')
    tamper['note'] = '被改过的正文'          # 哈希/字节数不再与正文对应 ⇒ pending-tampered
    cases = (
        ('qd-supplier-aaaa00000000.json', _record('qd-supplier-aaaa00000000'), 0o644, 'pending-insecure-mode'),
        ('qd-supplier-bbbb00000000.json', tamper, 0o600, 'pending-tampered'),
        ('qd-supplier-cccc00000000.json', _record('qd-supplier-cccc00000000', item_id='L-999'), 0o600,
         'item-not-found'),
        ('qd-supplier-dddd00000000.json', _record('qd-supplier-dddd00000000', requested_action='sign'), 0o600,
         'action-not-draft'),
    )
    refusals: dict[str, str] = {}
    zero_add = payload_dup.get('ledger_added') == 0
    next_ok = True
    for name, record, mode, expected in cases:
        path = _write_pending(inbox, name, record, mode=mode)
        _code, payload = _run(TOOL, *extra)
        entry = next((item for item in (payload.get('refused') or []) if item.get('file') == name), {})
        refusals[name] = entry.get('code') or f'({expected} 未命中)'
        zero_add = zero_add and payload.get('ledger_added') == 0
        next_ok = next_ok and bool(entry.get('next_action'))
        path.unlink(missing_ok=True)
    for path in _pending(inbox):
        path.unlink(missing_ok=True)
    expected_codes = {name: expected for name, _record_, _mode, expected in cases}
    out.append(Assertion('⑤ 幂等 + 四条拒绝路径：同一份草稿重新写回再跑 ⇒ `duplicates`（`already-drafted`）+ '
                         '**账本零新增**；0644 待办件 ⇒ `pending-insecure-mode`、被改过 ⇒ `pending-tampered`、'
                         '行项目不存在 ⇒ `item-not-found`、动作不是 draft ⇒ `action-not-draft` '
                         '—— 四条**拒绝时账本零新增**且各自给 `next_action`',
                         idem_ok and refusals == expected_codes and zero_add and next_ok
                         and len(_rows(supplier_ledger)) == supplier_lines,
                         f'幂等={idem_ok}（matched={dup_first.get("reason")}）；拒绝码={refusals}；'
                         f'四条账本零新增={zero_add}；账本行={supplier_lines}'))

    # 签名只能由人
    hash_before = hashlib.sha256(supplier_ledger.read_bytes()).hexdigest()
    sign_extra = ['--ui-shared', str(shared), '--ledger-supplier', str(supplier_ledger),
                  '--ledger-contractor', str(contractor_ledger)]
    code_agent, payload_agent = _run(SIGNER, '--draft-id', 'qd-supplier-0123456789ab',
                                    '--actor', 'agent:bot', '--now', NOW, *sign_extra)
    agent_no_write = hashlib.sha256(supplier_ledger.read_bytes()).hexdigest() == hash_before
    code_human, payload_human = _run(SIGNER, '--draft-id', 'qd-supplier-0123456789ab',
                                    '--actor', 'human:liangzi', '--comment', '同意提交', '--now', NOW, *sign_extra)
    types = [row.get('type') for row in _rows(supplier_ledger)]
    out.append(Assertion('⑥ **签名只能由人**：`tools/quote-sign.py --actor agent:bot` ⇒ 退出码 2 + '
                         '`human-required` + **账本零新增**；`--actor human:<人名>` ⇒ 落 '
                         '`approval/requested → approval/granted → quote/submitted`（顺序 = INV-005）'
                         '并同步给承包商账本一条 `quote/submitted`',
                         code_agent == 2 and (payload_agent.get('refusal') or {}).get('code') == 'human-required'
                         and agent_no_write and code_human == 0 and payload_human.get('ledger_added') == 4
                         and types[-3:] == ['approval/requested', 'approval/granted', 'quote/submitted'],
                         f'agent rc={code_agent}/{(payload_agent.get("refusal") or {}).get("code")} '
                         f'零新增={agent_no_write}；human rc={code_human} added={payload_human.get("ledger_added")} '
                         f'尾部={types[-3:]}'))

    inventory = INVENTORY.read_text(encoding='utf-8') if INVENTORY.is_file() else ''
    out.append(Assertion('⑦ 登记齐备：插件清单有 `host/modules/quote-prepare.mjs` 一行；'
                         '`host/profiles.mjs` 装配了 `quote-prepare`；`webui.mjs` 的 inject 含 `quotePrepare`',
                         '`host/modules/quote-prepare.mjs`' in inventory
                         and "'quote-prepare'" in (ROOT / 'host' / 'profiles.mjs').read_text(encoding='utf-8')
                         and "'quotePrepare'" in webui,
                         f'清单={MOD.name in inventory or "`host/modules/quote-prepare.mjs`" in inventory}'))
    return out
