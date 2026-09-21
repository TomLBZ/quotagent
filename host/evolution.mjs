/**
 * 演化门骨架的冒烟（`tools/verify.sh evolution`）：每条行为都有**正控 + 负控**。
 *
 * 覆盖（评审 C §7.1 第 7 条）：proposal 记录类型 → patch/journal 归属 → shadow 挂载（隔离 realm + 账本副本）
 * → gate runner 五条 AND → **promote 必带人工 approval_ref（无则拒）** → 回滚（dispose + journal 撤回，
 * 只撤自己拥有的键）→ 事件经 **Python 侧**落账（H1：宿主不写账本）。
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EvolutionError, PatchJournal, gate, makeProposal, promote, recordEvent, rollback, shadowMount,
} from './lib/evolution.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const work = mkdtempSync(join(tmpdir(), 'evolve-'))
const ledger = join(work, 'ledger.jsonl')          // 影子挂载用的"共享账本"
const evolveLedger = join(work, 'evolve.jsonl')     // 事件落账用：**每次跑都从零开始**，冒烟自洽
writeFileSync(ledger, '')
const shadowDir = mkdtempSync(join(work, 'shadow-'))

// --- 1. proposal 记录类型 -------------------------------------------------
const draft = {
  kind: 'compare.weights',
  target: 'compare.weights.price',
  diff: { 'compare.weights.price': [0.6, 0.55] },
  rationale: '价格权重过度倾斜导致交期被忽视（依据窗口内护栏触发率）',
  expected_effect: { metric: 'guard.flag_rate', direction: 'down', magnitude: 0.05 },
  risks: ['交期权重上升可能抬高总价'],
  rollback_plan: '卸载条目 compare（dispose）并撤回 journal 键 compare.weights.price',
  evidence_refs: ['ledger:12', 'eval:report-0007'],
  source: 'eval:report',
}
const proposal = makeProposal(draft)
check('提案记录：必填字段齐备且 id 为内容哈希', proposal.id.startsWith('sha256:') && proposal.id.length === 71,
  `id=${proposal.id.slice(0, 24)}…`)
const missing = (() => {
  try {
    const { risks, ...rest } = draft
    makeProposal(rest)
    return null
  } catch (err) {
    return err.code
  }
})()
check('负控：缺必填字段（risks）被拒', missing === 'proposal-incomplete', `code=${missing}`)
const selfScored = (() => {
  try {
    makeProposal({ ...draft, source: 'model:self-eval' })
    return null
  } catch (err) {
    return err.code
  }
})()
check('负控：指标来源不计白名单（模型自评）被拒；无引用也被拒',
  selfScored === 'metric-source-invalid' && (() => {
    try {
      makeProposal({ ...draft, evidence_refs: [] })
      return false
    } catch (err) {
      return err.code === 'no-citation'
    }
  })(), `self-scored=${selfScored}`)
const kernelTarget = (() => {
  try {
    makeProposal({ ...draft, target: 'kernel.realm' })
    return null
  } catch (err) {
    return err.code
  }
})()
check('负控：target 落在 `kernel.*` 被拒（INV-010 / H5）', kernelTarget === 'kernel-target-refused',
  `code=${kernelTarget}`)
const escalated = (() => {
  try {
    makeProposal(draft, { history: [{ kind: draft.kind, outcome: 'failed' }, { kind: draft.kind, outcome: 'failed' },
      { kind: draft.kind, outcome: 'failed' }] })
    return null
  } catch (err) {
    return err.code
  }
})()
check('负控：同类提案已连续失败 3 次 → 强制转人工（不再自动重试）',
  escalated === 'same-kind-escalated', `code=${escalated}`)

// --- 2. journal 归属 -----------------------------------------------------
const journal = new PatchJournal({ 'profiles.contractor-ops': 'file' })
const taken = journal.own(proposal, { 'compare.weights.price': 0.55 })
const cutIn = (() => {
  try {
    journal.own(proposal, { 'profiles.contractor-ops': 'x' })
    return null
  } catch (err) {
    return err.code
  }
})()
check('journal 归属：提案可占用无主键；**不得占用文件/人工 patch 的键**；归属可查',
  taken.length === 1 && cutIn === 'journal-cut-in'
  && journal.owner('compare.weights.price').owner === proposal.id
  && journal.owner('profiles.contractor-ops').kind === 'base',
  `cut-in=${cutIn}`)

// --- 3. shadow 挂载（隔离 realm + 账本副本） ------------------------------
let applied = 0
const shadow = await shadowMount(proposal, {
  ledgerPath: ledger, shadowDir,
  plugin: { onApply: () => { applied += 1 } },
})
check('shadow 挂载：隔离 realm 名带提案 id、账本被复制到新文件、插件已 apply',
  shadow.realm === `shadow:${proposal.id}` && existsSync(shadow.ledger_copy)
  && applied === 1 && shadow.effect_count > 0,
  `realm=${shadow.realm.slice(0, 24)}… copy=${shadow.ledger_copy.split('/').pop()} effects=${shadow.effect_count}`)

// --- 4. gate runner（五条 AND，逐条理由） --------------------------------
const passed = gate(proposal, { metricBefore: 0.12, metricAfter: 0.08, invariantsOk: true,
  counterexamplesOk: true, budgetOk: true, humanRateBefore: 0.2, humanRateAfter: 0.2 })
const byHumanRate = gate(proposal, { metricBefore: 0.12, metricAfter: 0.08, invariantsOk: true,
  counterexamplesOk: true, budgetOk: true, humanRateBefore: 0.2, humanRateAfter: 0.35 })
const byBudget = gate(proposal, { metricBefore: 0.12, metricAfter: 0.08, invariantsOk: true,
  counterexamplesOk: true, budgetOk: false, humanRateBefore: 0.2, humanRateAfter: 0.2 })
const regressed = gate(proposal, { metricBefore: 0.12, metricAfter: 0.15, invariantsOk: true,
  counterexamplesOk: true, budgetOk: true, humanRateBefore: 0.2, humanRateAfter: 0.2 })
check('gate：五条同时满足才放行（passed）', passed.verdict === 'passed' && passed.checks.length === 5,
  `checks=${passed.checks.map((item) => `${item.name}:${item.ok}`).join(' ')}`)
check('负控：人工介入率上升即越界（用"多问人"换指标）', byHumanRate.verdict === 'rejected'
  && byHumanRate.reasons.some((item) => item.includes('人工介入率')), `reasons=${JSON.stringify(byHumanRate.reasons)}`)
check('负控：预算越界或指标退化都被拒', byBudget.verdict === 'rejected' && regressed.verdict === 'rejected',
  `budget=${byBudget.verdict} regressed=${regressed.verdict}`)

// --- 5. 晋升：P1 不允许自动晋升 -----------------------------------------
const autoPromote = (() => {
  try {
    promote(proposal, journal, { gateVerdict: passed })
    return null
  } catch (err) {
    return err.code
  }
})()
const noGate = (() => {
  try {
    promote(proposal, journal, { approval_ref: 'ap-0001', gateVerdict: byHumanRate })
    return null
  } catch (err) {
    return err.code
  }
})()
const promoted = promote(proposal, journal, { approval_ref: 'ap-0001', gateVerdict: passed })
check('负控：无人工 approval_ref 的 promote 被拒（P1 不允许自动晋升）',
  autoPromote === 'promote-needs-approval', `code=${autoPromote}`)
check('负控：门未通过的提案即使带批准也不得晋升', noGate === 'promote-gate-failed', `code=${noGate}`)
check('正控：门通过 + 带人工 approval_ref → 晋升并把该提案拥有的键折进 base',
  promoted.status === 'promoted' && promoted.keys.includes('compare.weights.price'),
  `keys=${JSON.stringify(promoted.keys)} approval_ref=${promoted.approval_ref}`)

// --- 6. 事件经 Python 落账 + 回滚 ---------------------------------------
const recorded = []
for (const [event, body] of [['evolve/proposed', { id: proposal.id, actor: 'host:evolution' }],
  ['evolve/shadowed', { id: proposal.id, realm: shadow.realm, ledger_copy: shadow.ledger_copy, actor: 'host:evolution' }],
  ['evolve/gated', { id: proposal.id, verdict: passed.verdict, actor: 'host:evolution' }],
  ['evolve/promoted', { id: proposal.id, approval_ref: 'ap-0001', keys: promoted.keys, actor: 'host:evolution' }]]) {
  recorded.push(recordEvent(event, body, evolveLedger))
}
const rolled = await rollback(proposal, journal, shadow)
recorded.push(recordEvent('evolve/rolled-back', { id: proposal.id, revoked_keys: rolled.revoked_keys,
  actor: 'host:evolution' }, evolveLedger))
check('事件由 **Python 侧**落账（宿主不写账本）：5 条 evolve/* 依次进账本且 seq 递增',
  recorded.length === 5 && recorded.every((item, idx) => item.seq === idx + 1),
  `seqs=${recorded.map((item) => item.seq).join(',')} ledger=${recorded[0].ledger.split('/').slice(-2).join('/')}`)
check('回滚：dispose 回收全部 effect 且 journal 只撤该提案拥有的键',
  rolled.status === 'rolled-back' && rolled.effects_released > 0
  && rolled.revoked_keys.length === 1 && journal.owner('compare.weights.price') === null,
  `effects=${rolled.effects_released} revoked=${JSON.stringify(rolled.revoked_keys)}`)

rmSync(work, { recursive: true, force: true })
rmSync(shadowDir, { recursive: true, force: true })
console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] evolution skeleton: ${failures} 项未通过`)
} else {
  console.error('[PASS] evolution skeleton')
}
process.exit(failures ? 1 : 0)
