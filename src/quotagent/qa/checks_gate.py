"""AC-GATE-001 机检：「审批等多久 / 变更单到底是谁卡着」的**结构性**事实 + 一次**真执行探针**。

真执行探针（Node）：同一份载荷两次逐字节一致、**两个墙钟入口（`payload.now` / `config.now`）各给两个不同值
输出都不变**、`age_seconds` 等于手算 `as_of − requested 事实 ts`、空投影 `degraded` 且**两个列表都为 0**、
每条变更单 `basis` 非空、催办载荷 `requested_action="nudge"`、插件侧不存在审批类方法。
真 HTTP（两视角页面/JSON、催办 POST 落 0600 待办件、`gate-nudge.py` 落 `gate/nudged` 且 ops 计数 +1、
幂等、拒绝路径、私域哨兵）由 `tools/verify.sh gates` 的两个门举证。

无 Node 时**降级并明说**（ADR-0013 §8）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
MOD = ROOT / 'host' / 'modules' / 'gate-timeline.mjs'
GATE = ROOT / 'host' / 't282-gate-timeline-gate.mjs'
ROUTE = ROOT / 'tools' / 'check-gate-timeline-route.py'
NUDGE = ROOT / 'tools' / 'gate-nudge.py'

#: 一次真执行探针：口径（不取墙钟）/ 空投影不编 / basis 可溯源 / 催办只产 nudge 载荷。
PROBE = r"""
import { timelineOf, nudgeOf, AGE_CLOCK, IGNORED_NOW_INPUTS, DEGRADED_REASONS, ENGINE_NOTE, ENGINE,
  GATE_COMMANDS, NUDGE_ACTION } from './host/modules/gate-timeline.mjs'
const P = {
  view: 'contractor', as_of: '2026-09-25T12:00:00Z',
  approvals: [
    { approval_id: 'ap-0001', type: 'approval/requested', ts: '2026-09-25T10:00:00Z', scope: 'award.commit',
      ref: 'awin-1', approvers: ['human:liangzi'], timeout_policy: 'escalate', timeout_s: 3600,
      escalate_to: 'human:boss' },
    { approval_id: 'ap-0002', type: 'approval/requested', ts: '2026-09-25T11:00:00Z', scope: 'po.issue',
      ref: 'po-1', timeout_policy: 'remind', timeout_s: 86400 },
    { approval_id: 'ap-0003', type: 'approval/requested', ts: '2026-09-25T09:00:00Z', scope: 'quote.submit',
      ref: 'q-1', timeout_policy: 'remind', timeout_s: 60 },
    { approval_id: 'ap-0003', type: 'approval/granted', ts: '2026-09-25T09:30:00Z', scope: 'quote.submit', ref: 'q-1' },
  ],
  changes: [
    { change_id: 'chg-0001', type: 'change/proposed', ts: '2026-09-25T10:30:00Z', quote_id: 'q-1' },
    { change_id: 'chg-0001', type: 'change/priced', ts: '2026-09-25T11:00:00Z', quote_id: 'q-1',
      delta_amount: 1720, basis_unit_price_refs: ['q-1#L-001:unit_price'] },
  ],
}
const DIRTY = { ...P,
  approvals: P.approvals.map((a) => ({ ...a, 'private:note': 'PRIVATE-NOTE-SENTINEL-7f', reserve_price: 987654321 })),
  changes: P.changes.map((c) => ({ ...c, cost_model: 'COST-MODEL-SENTINEL-9a', bidders_private: '内部' })) }
const a = JSON.stringify(timelineOf(P))
const b = JSON.stringify(timelineOf(P))
const c = JSON.stringify(timelineOf({ ...P, now: '2030-01-01T00:00:00Z' }))
const d = JSON.stringify(timelineOf({ ...P, now: '1999-01-01T00:00:00Z' }))
const e = JSON.stringify(timelineOf(P, { now: '2036-12-31T23:59:59Z' }))
const f = JSON.stringify(timelineOf(P, { now: '2020-01-01T00:00:00Z' }))
const dirty = JSON.stringify(timelineOf(DIRTY))
const out = JSON.parse(a)
const empty = timelineOf({ view: 'contractor' })
const noSignal = timelineOf({ view: 'contractor', as_of: P.as_of, approvals: [
  P.approvals[2], P.approvals[3]] })
const nudge = nudgeOf(P, { gate_id: 'ap-0001', reason: '现场催一下' })
const refused = nudgeOf(P, { gate_id: 'ap-9999', reason: 'x' })
const GATE_KEYS = 'age_basis|age_seconds|blocked_by|consequence|id|kind|next_action|owner|subject'
const CHANGE_KEYS = 'basis|id|next_action|owed_by|state|waiting_since'
console.log(JSON.stringify({
  engine: out.engine, note_ok: out.engine_note === ENGINE_NOTE, note: ENGINE_NOTE,
  age_clock: out.age_clock, clock_ok: out.age_clock === AGE_CLOCK,
  now_inputs: IGNORED_NOW_INPUTS,
  deterministic: a === b,
  clock_invariant: a === c && a === d && a === e && a === f,
  ages: out.gates.map((g) => g.age_seconds),
  gate_ids: out.gates.map((g) => g.id),
  gate_keys_fixed: out.gates.every((g) => Object.keys(g).sort().join('|') === GATE_KEYS),
  change_keys_fixed: out.changes.every((g) => Object.keys(g).sort().join('|') === CHANGE_KEYS),
  gate_basis_nonempty: out.gates.every((g) => typeof g.age_basis === 'string' && g.age_basis.length > 40),
  change_basis_nonempty: out.changes.length === 1 && Array.isArray(out.changes[0].basis)
    && out.changes[0].basis.length >= 3,
  next_actions_cli: out.gates.every((g) => typeof g.next_action === 'string'
    && g.next_action.includes('quotagent.g1side') && g.next_action.includes('gates/nudge')),
  no_auto_grant: out.gates.every((g) => /不批准|不是批准|不自动批准/.test(g.consequence))
    && !out.gates.some((g) => /会自动批准|将自动批准/.test(g.consequence)),
  commands: Object.keys(GATE_COMMANDS).sort(),
  empty_degraded: empty.degraded, empty_reason: empty.reason,
  empty_lists: empty.gates.length + empty.changes.length,
  no_signal_reason: noSignal.reason, no_signal_lists: noSignal.gates.length + noSignal.changes.length,
  reasons: DEGRADED_REASONS,
  nudge_action: NUDGE_ACTION, nudge_ok: nudge.ok, nudge_requested: nudge.record && nudge.record.requested_action,
  nudge_reason_verbatim: nudge.record && nudge.record.reason === '现场催一下',
  nudge_record_keys: nudge.record ? Object.keys(nudge.record).sort() : [],
  refuse_code: refused.code, refuse_has_action: Boolean(refused.next_action),
  sentinel_no_effect: a === dirty,
  sentinel_leak: ['COST-MODEL-SENTINEL-9a', 'PRIVATE-NOTE-SENTINEL-7f', '987654321']
    .filter((n) => dirty.includes(n)).length,
  bounded: out.counts.shown + out.counts.omitted === out.counts.gates.found + out.counts.changes.found,
}))
"""


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _code_only(text: str) -> str:
    return '\n'.join(line for line in text.splitlines()
                     if not line.lstrip().startswith(('//', '*', '/*', '#')))


@register('AC-GATE-001', 'P2',
          '审批等多久 / 变更单谁卡着：等待时长口径来自事实 ts（不取墙钟）、每条有据可溯、空投影不编、'
          '插件不能批准、催办只落待办件且唯一落账本者落 gate/nudged',
          'tools/verify.sh ac AC-GATE-001', ('EV-153',))
def check() -> list[Assertion]:
    out: list[Assertion] = []
    src = MOD.read_text(encoding='utf-8') if MOD.is_file() else ''
    gate = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    route = ROUTE.read_text(encoding='utf-8') if ROUTE.is_file() else ''
    nudge = NUDGE.read_text(encoding='utf-8') if NUDGE.is_file() else ''
    out.append(Assertion('① 插件 / 围栏门 / 真路由门 / Python 唯一落账本者四件齐备',
                         bool(src) and bool(gate) and bool(route) and bool(nudge),
                         f'module={len(src)}B gate={len(gate)}B route={len(route)}B nudge={len(nudge)}B'))

    marks = {
        'age_clock': "AGE_CLOCK = 'facts-only'" in src,
        'now_inputs': "'payload.now'" in src and "'config.now'" in src,
        'policy': all(k in src for k in ("'remind'", "'escalate'", "'abort'")),
        'no_auto_grant': '自动批准' in src,
        'reasons_closed': all(k in src for k in ('no-usable-inputs', 'no-signal', 'payload-not-an-object')),
        'action': "NUDGE_ACTION = 'nudge'" in src and "NUDGE_KIND = 'gate-nudge'" in src,
        'commits': all(k in src for k in ('quote.submit', 'award.commit', 'po.issue', 'change.approve')),
        'bounded': 'max_items' in src and 'omitted' in src and 'truncated' in src,
        'privacy': 'clock_reads' in src and 'private_keys_read' in src,
        'resolved': 'approval/granted' in src and 'approval/aborted' in src,
    }
    out.append(Assertion('① 语义齐备：`AGE_CLOCK=facts-only` / 两个墙钟入口 / 三条超时策略 / 闭合降级原因 / '
                         '`NUDGE_ACTION=nudge` / 四个 commit scope / 有界 / privacy / 已决事件',
                         all(marks.values()), f'marks={marks}'))

    code = _code_only(src)
    hits = sorted(set(re.findall(
        r'writeFileSync|appendFileSync|createWriteStream|mkdirSync|child_process|fetch\(|Date\.now|Math\.random'
        r'|openLedger|new Date|setInterval\(|setTimeout\(', code)))
    self_test = re.findall(r'openLedger|setInterval\(|Date\.now',
                           'openLedger(p); setInterval(f, 1); Date.now()')
    out.append(Assertion('① **零写面 / 不读账本 / 不取墙钟 / 不随机 / 不联网 / 不起子进程**（非注释源码静态扫描；'
                         '扫描器非空转：对照样本必须命中 ≥3）',
                         not hits and len(self_test) >= 3,
                         f'产物命中={hits}；对照样本命中={self_test}'))

    webui = (ROOT / 'host' / 'modules' / 'webui.mjs').read_text(encoding='utf-8')
    routes = ('/gates/' in webui and '/api/gates' in webui and '/gates/nudge' in webui
              and 'data-gates-link' in webui)
    out.append(Assertion('① 三条路由 + 四道页面子导航入口齐备（`<view>/gates/` + `<view>/api/gates` + '
                         '`<view>/gates/nudge` + `data-gates-link`）；页面模板里无内联脚本 / 无内联事件属性',
                         routes and '<script' not in _code_only(webui)
                         and not re.search(r'\son[a-z]+=', _code_only(webui)),
                         f'routes={routes} script={_code_only(webui).count("<script")}'))

    gm = {k: (k in gate) for k in ('确定性', '哨兵', '变异', '还原', '空投影', 'basis', '不得批准', '手算')}
    out.append(Assertion('① 围栏门含确定性 / 哨兵 / 变异自证 / 字节还原 / 空投影不编 / basis 溯源 / '
                         '不得批准 / 手算表（不是空壳门）', sum(gm.values()) >= 8, f'marks={gm}'))

    v = (ROOT / 'tools' / 'verify.sh').read_text(encoding='utf-8')
    out.append(Assertion('① `verify.sh gates` 门已挂（围栏门 + 真路由门两半）',
                         'gates)' in v and 't282-gate-timeline-gate.mjs' in v
                         and 'check-gate-timeline-route.py' in v,
                         f"gate={'gates)' in v}"))

    # Python 侧：唯一落账本者（真源 = 账本模块）+ 五键 body + 归档不删 + 幂等 + 拒绝码
    nmarks = {
        'ledger': 'from quotagent.kernel.ledger' in nudge and 'ledger.append(' in nudge,
        'event': 'EVENT = "gate/nudged"' in nudge,
        'five_keys': all(k in nudge for k in ('"gate_id": gate_id', '"view": view', '"actor"',
                                              '"reason_sha256"', '"ok": True')),
        'no_reason_in_body': '"reason": reason' not in nudge.split('body = {', 1)[1].split('}', 1)[0],
        'archive': 'ARCHIVE_DIR = "applied"' in nudge and 'shutil.move' in nudge,
        'idempotent': 'already-nudged' in nudge and 'duplicates' in nudge,
        'refusals': all(k in nudge for k in ('gate-not-found', 'pending-tampered',
                                             'gate-already-decided', 'action-not-nudge')),
        'mode_600': '0o600' in nudge,
        'no_wall_clock': 'args.now' in nudge and 'datetime.now' not in nudge and 'time.time' not in nudge,
    }
    out.append(Assertion('② Python 侧唯一落账本者形态：真账本模块 + `gate/nudged` + body 恰 5 键（**不含理由正文**）'
                         '+ 归档不删 + 幂等 + 四种拒绝码 + 待办件 0600 + 时间只来自 `--now`（不取墙钟）',
                         all(nmarks.values()), f'marks={nmarks}'))

    if _node():
        proc = subprocess.run(['node', '--input-type=module', '-e', PROBE], cwd=str(ROOT),
                              capture_output=True, text=True, timeout=120)
        try:
            facts = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            facts = {}
        out.append(Assertion('③ 真执行探针：`engine="rules"` + `age_clock="facts-only"` + 每条门/变更单形状固定 + '
                             '确定性（两次逐字节一致）',
                             bool(facts.get('engine') == 'rules' and facts.get('note_ok')
                                  and facts.get('clock_ok') and facts.get('deterministic')
                                  and facts.get('gate_keys_fixed') and facts.get('change_keys_fixed')
                                  and facts.get('bounded')),
                             f"engine={facts.get('engine')} clock={facts.get('age_clock')} "
                             f"deterministic={facts.get('deterministic')} "
                             f"keys={facts.get('gate_keys_fixed')}/{facts.get('change_keys_fixed')}"))
        out.append(Assertion('③ 真执行探针：**等待时长不来自墙钟** —— 两个墙钟入口（`payload.now`/`config.now`）'
                             '各给两个不同值，输出**逐字节不变**，且 `age_seconds` 等于手算 '
                             '`as_of(12:00) − requested ts`（[7200, 3600]；已 granted 的门不进列表）',
                             bool(facts.get('clock_invariant') and facts.get('ages') == [7200, 3600]
                                  and facts.get('gate_ids') == ['ap-0001', 'ap-0002']
                                  and facts.get('now_inputs') == ['payload.now', 'config.now']
                                  and facts.get('no_auto_grant')),
                             f"clock_invariant={facts.get('clock_invariant')} ages={facts.get('ages')} "
                             f"ids={facts.get('gate_ids')} 策略里没有自动批准={facts.get('no_auto_grant')}"))
        out.append(Assertion('③ 真执行探针：**空投影不编**（`degraded` + 有名 reason + **两个列表都为 0**）且'
                             '「载荷不能用」与「数据齐但无可报项」是两个不同 reason',
                             bool(facts.get('empty_degraded') is True
                                  and facts.get('empty_reason') == 'no-usable-inputs'
                                  and facts.get('empty_lists') == 0
                                  and facts.get('no_signal_reason') == 'no-signal'
                                  and facts.get('no_signal_lists') == 0
                                  and len(facts.get('reasons') or []) == 3),
                             f"empty={facts.get('empty_reason')}/{facts.get('empty_lists')} "
                             f"no_signal={facts.get('no_signal_reason')}/{facts.get('no_signal_lists')}"))
        out.append(Assertion('③ 真执行探针：每条都带依据（门的 `age_basis` + 变更单的非空 `basis`）、'
                             '`next_action` 是可照做的真命令/路由、且催办只产 `nudge` 载荷（**不含任何审批动作**）',
                             bool(facts.get('gate_basis_nonempty') and facts.get('change_basis_nonempty')
                                  and facts.get('next_actions_cli')
                                  and facts.get('nudge_requested') == 'nudge'
                                  and facts.get('nudge_reason_verbatim')
                                  and facts.get('nudge_record_keys')
                                  and not [k for k in facts.get('nudge_record_keys') or []
                                           if k in ('approval_id', 'granted', 'approved_by', 'decision')]
                                  and facts.get('refuse_code') == 'gate-not-found'
                                  and facts.get('refuse_has_action')),
                             f"nudge={facts.get('nudge_requested')} "
                             f"record_keys={facts.get('nudge_record_keys')} "
                             f"refuse={facts.get('refuse_code')}/{facts.get('refuse_has_action')}"))
        out.append(Assertion('③ 真执行探针：私域哨兵**不参与计算且零泄漏**（带哨兵与不带哨兵逐字节一致、命中 0）',
                             bool(facts.get('sentinel_no_effect') is True and facts.get('sentinel_leak') == 0),
                             f"sentinel_no_effect={facts.get('sentinel_no_effect')} "
                             f"leak={facts.get('sentinel_leak')}"))
    else:
        out.append(Assertion('③ 插件源码非空（无 Node：**降级**；真执行行为由 `verify.sh gates` 守卫）',
                             len(src) > 20000, f'bytes={len(src)}'))
    return out
