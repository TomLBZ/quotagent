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
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EvolutionError, PatchJournal, gate, gateModule, makeModuleProposal, makeProposal, promote,
  promoteModule, recordEvent, rollback, rollbackModule, shadowArtifact, shadowMount,
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


// --- 7. T-227：自进化**产出插件**（产物 = host/modules/<name>.mjs）-----------------
// 沙盒纪律：本节把"仓库根"指向临时目录，真实 `host/modules/` 一个字都不写（末尾有断言核对）。
const sandbox = mkdtempSync(join(work, 'sandbox-'))
const sandboxHost = join(sandbox, 'host')
const sandboxModules = join(sandboxHost, 'modules')
mkdirSync(sandboxModules, { recursive: true })
symlinkSync(join(ROOT, 'host', 'lib'), join(sandboxHost, 'lib'), 'dir')                 // 影子模块要 `../lib/std-schema.mjs`
symlinkSync(join(ROOT, 'host', 'node_modules'), join(sandboxHost, 'node_modules'), 'dir') // 解析 'cordis'

const GOOD_MODULE = [
  "/** 冒烟用最小插件：只提供一个纯函数，不订阅事件、不写文件。 */",
  "import { object, string } from '../lib/std-schema.mjs'",
  "export const name = 'smoke-widget'",
  "export const inject = []",
  "export const builtin = []",
  "export const usedServices = []",
  "export const provides = ['smoke-widget']",
  "export const Config = object({ label: string().default('ok') })",
  "export function apply(ctx, config) {",
  "  ctx.provide('smoke-widget', { label: config.label, double: (n) => Number(n) * 2 })",
  "}",
  "export const fixture = { sample: (handle) => ({ label: handle.label, doubled: handle.double(21) }) }",
  '',
].join('\n')

const realModulesBefore = readdirSync(join(ROOT, 'host', 'modules')).filter((f) => f.endsWith('.mjs')).sort()

const moduleProposal = makeModuleProposal({
  name: 'smoke-widget', source: GOOD_MODULE, target_dir: sandboxModules, kind: 'module',
  rationale: '冒烟：验证"自进化产出插件"整链（提案→影子→fixture→门→晋升→回滚）',
  expected_effect: { metric: 'fixture:module', direction: 'up', magnitude: 1 },
  risks: ['影子与真实目录不一致时以 fixture 为准'], rollback_plan: '删除自有产物 + journal 撤回',
  evidence_refs: ['ledger:evolve.jsonl#1'],
}, { repoRoot: sandbox })
check('模块提案：绑定产物路径/内容哈希/字节数，且指标来源固定为 fixture:module（不接受模型自评）',
  moduleProposal.artifact.path === join(sandboxModules, 'smoke-widget.mjs')
  && /^sha256:[0-9a-f]{64}$/.test(moduleProposal.artifact.hash) && moduleProposal.artifact.bytes > 0
  && moduleProposal.source === 'fixture:module',
  `path=${moduleProposal.artifact.path.replace(sandbox, '<sandbox>')} bytes=${moduleProposal.artifact.bytes}`)

const shadowed = shadowArtifact(moduleProposal, { shadowDir: sandboxHost })
const realModulesAfterShadow = readdirSync(join(ROOT, 'host', 'modules')).filter((f) => f.endsWith('.mjs')).sort()
check('影子写入：产物只落影子目录，真实 host/modules/ **未被触碰**',
  existsSync(shadowed.shadow_path) && JSON.stringify(realModulesAfterShadow) === JSON.stringify(realModulesBefore),
  `shadow=${shadowed.shadow_path.replace(sandbox, '<sandbox>')} 真目录 ${realModulesBefore.length} → ${realModulesAfterShadow.length}`)

/** 真跑 fixture：对**影子目录**里的模块跑同一套 A1..A6（子进程，取真实结果）。 */
const runFixtures = (moduleName, moduleDir) => {
  // 产物不合格时 fixture 以非 0 退出——那是**预期**的负控路径，所以不能用 execFileSync（它会抛），
  // 要用 spawnSync 拿 stdout + 退出码：报告总是会打印，退出码另行断言。
  const proc = spawnSync(process.execPath, [join(ROOT, 'host', 'check-modules.mjs'),
    '--module', moduleName, '--module-dir', moduleDir], { cwd: join(ROOT, 'host'), encoding: 'utf8' })
  if (!proc.stdout || !proc.stdout.trim()) {
    throw new Error(`fixture 子进程无输出（exit=${proc.status}）：${String(proc.stderr).slice(-400)}`)
  }
  const report = JSON.parse(proc.stdout)
  return { passed: report.passed, total: report.total, failed: report.checks.filter((c) => !c.ok).length,
    exit: proc.status }
}

const fixtureGood = runFixtures('smoke-widget', sandboxModules)
const invariantsReal = (() => {
  try {
    execFileSync(join(ROOT, 'tools', 'verify.sh'), ['invariants'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch { return false }
})()
const gateVerdictModule = gateModule(moduleProposal, {
  fixture: fixtureGood, invariantsOk: invariantsReal, counterexamplesOk: true, budgetOk: true,
  humanRateBefore: 1, humanRateAfter: 1,
})
check('门（模块版）：五条 AND 全过 —— 门信号是**真跑出来的 fixture A1..A6**，不是自报',
  gateVerdictModule.verdict === 'passed' && fixtureGood.passed === fixtureGood.total && fixtureGood.total >= 12,
  `fixture ${fixtureGood.passed}/${fixtureGood.total}；宿主不变量实测=${invariantsReal}；checks=${gateVerdictModule.checks.length}`)

// 负控 1：门未过（故意坏的模块：把内建 mixin 写进 inject → 真实 fixture 必须抓到）
// 注意：`--module` 是按模块**导出的 name** 过滤的，所以坏产物必须连 name 一起改，
// 否则 fixture 会以"没有匹配的模块"返回 0/0（实测踩到）——那是空集合，不是通过。
const BAD_MODULE = GOOD_MODULE
  .replace("export const name = 'smoke-widget'", "export const name = 'smoke-broken'")
  .replace("export const inject = []", "export const inject = ['events']")
const badProposal = makeModuleProposal({
  name: 'smoke-broken', source: BAD_MODULE, target_dir: sandboxModules, kind: 'module',
  rationale: '负控：坏产物必须被 fixture 抓住', expected_effect: { metric: 'fixture:module', direction: 'up', magnitude: 1 },
  risks: [], rollback_plan: '不晋升', evidence_refs: ['ledger:evolve.jsonl#1'],
}, { repoRoot: sandbox })
shadowArtifact(badProposal, { shadowDir: sandboxHost })
const fixtureBad = runFixtures('smoke-broken', sandboxModules)
const badVerdict = gateModule(badProposal, { fixture: fixtureBad, invariantsOk: true, counterexamplesOk: true, budgetOk: true,
  humanRateBefore: 1, humanRateAfter: 1 })
let badPromoteBlocked = null
try {
  promoteModule(badProposal, null, { approval_ref: 'ap-0001', gateVerdict: badVerdict, shadowDir: sandboxHost, repoRoot: sandbox })
} catch (err) { badPromoteBlocked = err.code }
check('门负控：坏产物（inject 写内建 mixin）被**真实 fixture** 抓出 → 门 rejected → 晋升被拒',
  badVerdict.verdict === 'rejected' && fixtureBad.failed > 0 && badPromoteBlocked === 'promote-gate-failed',
  `fixture ${fixtureBad.passed}/${fixtureBad.total}（失败 ${fixtureBad.failed}）；门=${badVerdict.verdict}；晋升=${badPromoteBlocked}`)

// 负控 2：写目标不在可写面
let outsideWrite = null
try {
  makeModuleProposal({ name: 'evil', source: GOOD_MODULE, target_dir: join(sandbox, 'src', 'quotagent', 'services'),
    kind: 'module', rationale: 'x', expected_effect: { metric: 'fixture:module', direction: 'up', magnitude: 1 },
    risks: [], rollback_plan: 'x', evidence_refs: ['ledger:x#1'] }, { repoRoot: sandbox })
} catch (err) { outsideWrite = err.code }
check('负控：写目标超出可写面（如服务层目录）必须被拒——可写面只有 host/modules/',
  outsideWrite === 'artifact-outside-write-surface', `error=${outsideWrite}`)

// 负控 3：产物不是插件（缺 apply）
let notAModule = null
try {
  makeModuleProposal({ name: 'not-plugin', source: 'export const name = "not-plugin"\n', target_dir: sandboxModules,
    kind: 'module', rationale: 'x', expected_effect: { metric: 'fixture:module', direction: 'up', magnitude: 1 },
    risks: [], rollback_plan: 'x', evidence_refs: ['ledger:x#1'] }, { repoRoot: sandbox })
} catch (err) { notAModule = err.code }
check('负控：非插件文件（缺 apply）不得进 host/modules/', notAModule === 'artifact-not-a-module', `error=${notAModule}`)

// 负控 4：指标来源是"模型自评"
let selfReport = null
try {
  makeModuleProposal({ name: 'self-report', source: GOOD_MODULE, target_dir: sandboxModules, kind: 'module',
    rationale: 'x', expected_effect: { metric: 'model:self-assessment', direction: 'up', magnitude: 1 },
    risks: [], rollback_plan: 'x', evidence_refs: ['ledger:x#1'] }, { repoRoot: sandbox })
} catch (err) { selfReport = err.code }
check('负控：指标来源是"模型自评"必须被拒（门信号只能是真实 fixture）', selfReport === 'effect-invalid', `error=${selfReport}`)

// 负控 5：晋升缺人工 approval_ref
let noApproval = null
try {
  promoteModule(moduleProposal, null, { gateVerdict: gateVerdictModule, shadowDir: sandboxHost, repoRoot: sandbox })
} catch (err) { noApproval = err.code }
check('负控：没有人工 approval_ref 不得晋升（门通过也不行）', noApproval === 'promote-needs-approval', `error=${noApproval}`)

// 正控：带 ap-0001 晋升 → 产物落到沙盒的 host/modules/（真实目录仍不动）
const journalModule = new PatchJournal()
const promotedModule = promoteModule(moduleProposal, journalModule,
  { approval_ref: 'ap-0001', gateVerdict: gateVerdictModule, shadowDir: sandboxHost, repoRoot: sandbox })
const realModulesAfterPromote = readdirSync(join(ROOT, 'host', 'modules')).filter((f) => f.endsWith('.mjs')).sort()
check('晋升正控：门通过 + 人工引用 → 产物写入（沙盒）host/modules/，真实目录仍未被触碰',
  promotedModule.status === 'promoted' && existsSync(promotedModule.written_to)
  && JSON.stringify(realModulesAfterPromote) === JSON.stringify(realModulesBefore),
  `written=${promotedModule.written_to.replace(sandbox, '<sandbox>')}；真目录 ${realModulesAfterPromote.length} 个文件`)

// 负控 6：晋升前影子产物被偷改 → 哈希不一致必须拒绝
writeFileSync(shadowed.shadow_path, GOOD_MODULE.replace("'ok'", "'tampered'"), 'utf8')
let tampered = null
try {
  promoteModule(moduleProposal, null, { approval_ref: 'ap-0001', gateVerdict: gateVerdictModule, shadowDir: sandboxHost, repoRoot: sandbox })
} catch (err) { tampered = err.code }
check('负控：影子产物与提案哈希不一致（提案后被偷改）必须拒绝晋升', tampered === 'artifact-tampered', `error=${tampered}`)
writeFileSync(shadowed.shadow_path, GOOD_MODULE, 'utf8')   // 还原

// 负控 7：回滚只撤自有——产物被改过时拒绝删除
writeFileSync(promotedModule.written_to, GOOD_MODULE.replace("'ok'", "'someone-else'"), 'utf8')
let rollbackRefused = null
try {
  rollbackModule(moduleProposal, { targetPath: promotedModule.written_to, expectedHash: promotedModule.artifact_hash, journal: journalModule })
} catch (err) { rollbackRefused = err.code }
const stillThere = existsSync(promotedModule.written_to)
writeFileSync(promotedModule.written_to, GOOD_MODULE, 'utf8')   // 还原成自有内容
const rolledModule = rollbackModule(moduleProposal, { targetPath: promotedModule.written_to,
  expectedHash: promotedModule.artifact_hash, journal: journalModule })
check('回滚：内容被他人改过时拒绝删除；自有内容才撤（只撤自己拥有的）',
  rollbackRefused === 'rollback-refused-modified' && stillThere && rolledModule.removed === true
  && !existsSync(promotedModule.written_to),
  `拒绝代码=${rollbackRefused}；自有回滚 removed=${rolledModule.removed} revoked=${JSON.stringify(rolledModule.revoked_keys)}`)

// 事件：模块提案整链也按序落账（Python 侧 append）
const moduleEvents = []
for (const [event, body] of [['evolve/proposed', { id: moduleProposal.id, artifact_hash: moduleProposal.artifact.hash, actor: 'host:evolution' }],
  ['evolve/shadowed', { id: moduleProposal.id, shadow: shadowed.shadow_path, actor: 'host:evolution' }],
  ['evolve/gated', { id: moduleProposal.id, verdict: gateVerdictModule.verdict, fixture: `${fixtureGood.passed}/${fixtureGood.total}`, actor: 'host:evolution' }],
  ['evolve/promoted', { id: moduleProposal.id, approval_ref: 'ap-0001', artifact_hash: promotedModule.artifact_hash, actor: 'host:evolution' }],
  ['evolve/rolled-back', { id: moduleProposal.id, path: rolledModule.path, actor: 'host:evolution' }]]) {
  moduleEvents.push(recordEvent(event, body, evolveLedger))
}
check('模块产物的演化事件同样由 Python 侧落账（连续 seq，追加在既有 5 条之后）',
  moduleEvents.length === 5 && moduleEvents.every((item, idx) => item.seq === idx + 6),
  `seqs=${moduleEvents.map((item) => item.seq).join(',')}`)

rmSync(sandbox, { recursive: true, force: true })

rmSync(work, { recursive: true, force: true })
rmSync(shadowDir, { recursive: true, force: true })
console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] evolution skeleton: ${failures} 项未通过`)
} else {
  console.error('[PASS] evolution skeleton')
}
process.exit(failures ? 1 : 0)
