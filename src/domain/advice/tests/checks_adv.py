"""AC-ADV-001 机检：决策建议层的**结构性**事实 + 一次**真执行探针**（真 HTTP、两视角差异、
空投影降级与私域哨兵由 `verify.sh advice` 的两个门举证）。

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
MOD = ROOT / 'host' / 'modules' / 'advice-panel.mjs'
GATE = ROOT / 'src' / 'domain' / 'advice' / 'tests' / 't281-advice-gate.mjs'
ROUTE = ROOT / 'src' / 'domain' / 'advice' / 'tests' / 'check-advice-route.py'

#: 一次真执行探针（空载荷 → 降级；正常载荷 → 五条规则 + 逐条 basis + 确定性 + 哨兵零影响）。
PROBE = r"""
import { adviseOf, ENGINE_NOTE, DEGRADED_REASONS } from './host/modules/advice-panel.mjs'
const P = {
  view: 'supplier',
  as_of: '2026-09-25T12:00:00Z',
  deadlines: [{ ref: 'pkg-1', due_at: '2026-09-24T00:00:00Z', kind: 'quote_by' }],
  gates: [{ approval_id: 'ap-0001', scope: 'quote.submit', ref: 'q-1' }],
  ranking: { rows: [
    { code: 'sup-A', item: 'L-001', score: 90, focus: 'price', potential: 10, hint: '优先改善「单价」' },
    { code: 'sup-B', item: 'L-001', score: 30, focus: null, potential: 0, hint: '没有可提升项' },
  ] },
  channels: [{ name: 'mail', available: false, reason: 'mail-smtp-unconfigured', next_action: '配置 SMTP 凭据' }],
}
const DIRTY = { ...P,
  deadlines: P.deadlines.map((d) => ({ ...d, reserve_price: 987654321, cost_model: 'COST-MODEL-SENTINEL-9a' })),
  gates: P.gates.map((g) => ({ ...g, 'private:note': 'PRIVATE-NOTE-SENTINEL-7f' })),
  ranking: { rows: P.ranking.rows.map((r) => ({ ...r, bidders_private: 'BIDDERS-SENTINEL-3c' })) },
  channels: P.channels.map((c) => ({ ...c, 'private:credential': 'CRED-SENTINEL-5d' })) }
const a = JSON.stringify(adviseOf(P))
const b = JSON.stringify(adviseOf(P))
const d = JSON.stringify(adviseOf(DIRTY))
const empty = adviseOf({ view: 'contractor' })
const noSignal = adviseOf({ view: 'supplier', ranking: { rows: [{ code: 'x', item: 'L-1', score: 5 }] } })
const out = JSON.parse(a)
const BASIS = /^(as_of|(deadlines|gates|ranking|channels)\[[^\]]+\]\.[a-z_]+)$/
console.log(JSON.stringify({
  engine: out.engine, note: out.engine_note, note_ok: out.engine_note === ENGINE_NOTE,
  rules: [...new Set(out.items.map((i) => i.rule))].sort(),
  items: out.items.length,
  basis_ok: out.items.every((i) => Array.isArray(i.basis) && i.basis.length > 0 && i.basis.every((t) => BASIS.test(t))),
  next_actions: out.items.every((i) => typeof i.next_action === 'string' && i.next_action.trim().length > 4),
  severity_ok: out.items.every((i) => ['high', 'medium', 'low'].includes(i.severity)),
  bounded: out.counts.shown + out.counts.omitted === out.counts.generated,
  deterministic: a === b, sentinel_no_effect: a === d,
  sentinel_leak: ['COST-MODEL-SENTINEL-9a', 'PRIVATE-NOTE-SENTINEL-7f', 'BIDDERS-SENTINEL-3c', '987654321']
    .filter((n) => d.includes(n)).length,
  empty_degraded: empty.degraded, empty_reason: empty.reason, empty_items: empty.items.length,
  no_signal_reason: noSignal.reason, no_signal_items: noSignal.items.length,
  reasons_closed: DEGRADED_REASONS.length === 3,
  privacy: out.privacy && out.privacy.model_calls === 0 && out.privacy.network_calls === 0
    && out.privacy.private_keys_read === false,
}))
"""


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@register('AC-ADV-001', 'P2',
          '决策建议层：确定性规则（engine=rules）、每条 basis 可溯源、空数据不编建议、有界、私域零泄漏、页面无内联脚本',
          'tools/verify.sh ac AC-ADV-001', ('EV-150',))
def check() -> list[Assertion]:
    out: list[Assertion] = []
    src = MOD.read_text(encoding='utf-8') if MOD.is_file() else ''
    gate = GATE.read_text(encoding='utf-8') if GATE.is_file() else ''
    route = ROUTE.read_text(encoding='utf-8') if ROUTE.is_file() else ''
    out.append(Assertion("① 插件 / 围栏门 / 真路由门齐备",
                         bool(src) and bool(gate) and bool(route),
                         f"module={len(src)}B gate={len(gate)}B route={len(route)}B"))

    marks = {
        'engine': bool(re.search(r"ENGINE\s*=\s*'rules'", src)),
        'note': '不含模型推测' in src,
        'five_rules': all(k in src for k in ('expiry', 'spread', 'gate', 'channel', 'rank-up')),
        'reasons_closed': all(k in src for k in ('no-usable-inputs', 'no-signal', 'payload-not-an-object')),
        'basis': 'basis' in src,
        'bounded': 'max_items' in src and 'omitted' in src,
        'privacy': 'private_keys_read' in src and 'model_calls' in src,
    }
    out.append(Assertion("① 语义齐备：`engine='rules'` / 「不含模型推测」/ 五条规则 / 闭合降级原因 / basis / 有界 / privacy",
                         all(marks.values()), f"marks={marks}"))

    # 零写面 / 不读账本（非注释源码）
    code = '\n'.join(line for line in src.splitlines()
                     if not line.lstrip().startswith(('//', '*', '/*', '#')))
    webui = ROOT / 'host' / 'modules' / 'webui.mjs'
    wsrc = webui.read_text(encoding='utf-8') if webui.is_file() else ''
    chk_code = code + '\n' + '\n'.join(line for line in wsrc.splitlines()
                                       if not line.lstrip().startswith(('//', '*', '/*', '#')))
    hits = sorted(set(re.findall(
        r'writeFileSync|appendFileSync|createWriteStream|mkdirSync|child_process|fetch\(|Date\.now|Math\.random|openLedger',
        code)))
    out.append(Assertion("① 零写面 / 不读账本 / 不联网 / 无墙钟与随机数（非注释源码静态扫描）",
                         not hits, f"命中={hits}"))

    # 路由与入口：页面零内联脚本；四道页面子导航有入口
    routes = ('/advice/' in wsrc and '/api/advice' in wsrc and 'data-advice-link' in wsrc)
    out.append(Assertion("① 路由与子导航入口齐备（`<view>/advice/` + `<view>/api/advice` + `data-advice-link`）；"
                         "建议页模板里无内联脚本 / 无内联事件属性",
                         routes and '<script' not in chk_code and not re.search(r'\son[a-z]+=', chk_code),
                         f"routes={routes} script={chk_code.count('<script')}"))

    gm = {k: (k in gate) for k in ('确定性', '哨兵', '变异', '还原', '空数据', '可溯源')}
    out.append(Assertion("① 围栏门含确定性/哨兵/变异自证/字节还原/空数据不编/basis 溯源（不是空壳门）",
                         sum(gm.values()) >= 6, f"marks={gm}"))
    v = (ROOT / 'tools' / 'verify.sh').read_text(encoding='utf-8')
    out.append(Assertion("① `verify.sh advice` 门已挂（围栏门 + 真路由门两半）",
                         'advice)' in v and 't281-advice-gate.mjs' in v and 'check-advice-route.py' in v,
                         f"gate={'advice)' in v}"))

    if _node():
        proc = subprocess.run(['node', '--input-type=module', '-e', PROBE], cwd=str(ROOT),
                              capture_output=True, text=True, timeout=120)
        try:
            facts = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            facts = {}
        out.append(Assertion("① 真执行探针：`advise()` 可加载并给出 engine=rules + 每条 basis 可解析 + privacy 申报",
                             bool(facts.get('engine') == 'rules' and facts.get('note_ok') and facts.get('basis_ok')
                                  and facts.get('next_actions') and facts.get('severity_ok') and facts.get('privacy')),
                             f"facts={ {k: facts.get(k) for k in ('engine', 'note_ok', 'items', 'basis_ok', 'rules')} }"))
        out.append(Assertion("① 真执行探针：**空投影 → degraded + 有名 reason + 0 条**；"
                             "「载荷不能用」与「数据齐但无可建议项」是两个 reason（不抛错、不编建议）",
                             bool(facts.get('empty_degraded') is True and facts.get('empty_reason') == 'no-usable-inputs'
                                  and facts.get('empty_items') == 0 and facts.get('no_signal_reason') == 'no-signal'
                                  and facts.get('no_signal_items') == 0 and facts.get('reasons_closed')),
                             f"empty={facts.get('empty_reason')}/{facts.get('empty_items')}；"
                             f"no_signal={facts.get('no_signal_reason')}/{facts.get('no_signal_items')}"))
        out.append(Assertion("① 真执行探针：确定性（两次逐字节一致）+ 私域哨兵**不参与计算且零泄漏**"
                             "（带哨兵与不带哨兵逐字节一致）",
                             bool(facts.get('deterministic') is True and facts.get('sentinel_no_effect') is True
                                  and facts.get('sentinel_leak') == 0 and facts.get('bounded') is True),
                             f"determinism={facts.get('deterministic')} sentinel_no_effect={facts.get('sentinel_no_effect')} "
                             f"leak={facts.get('sentinel_leak')} bounded={facts.get('bounded')}"))
    else:
        out.append(Assertion("① 插件源码非空（无 Node：**降级**；真执行行为由 `verify.sh advice` 守卫）",
                             len(src) > 10000, f"bytes={len(src)}"))
    return out
