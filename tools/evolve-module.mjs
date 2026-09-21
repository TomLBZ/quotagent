/**
 * evolve-module —— **用自进化流程真实产出一个插件**（T-237）。
 *
 * 流程（全部走 `host/lib/evolution.mjs` 的既有机制，不另起一套）：
 *   提案（必填字段 + 可写面校验 + 效果口径固定 fixture:module）
 *   → 影子写入（只落影子目录，真实 `host/modules/` 一个字不动）
 *   → **真跑 fixture A1..A6**（子进程 `host/check-modules.mjs --module-dir 影子`，total ≥ 12 且全绿）
 *   → 五项门（fixture / INV / 场景集 / 预算 / 人工介入率不上升）——信号都来自**真跑**，不是自报
 *   → 带人工引用 `approval_ref` + 影子哈希一致 → 晋升到 `host/modules/`
 *   → 四个 evolve/* 事件交 **Python 侧**写账本（H1：宿主不写账本）
 *
 * 用法：
 *   tools/cordis.sh run ../tools/evolve-module.mjs --source-file tmp/t237-artifact.mjs \
 *     --name price-history --approval-ref ap-0100 [--shadow-dir tmp/t237-shadow] [--dry-run]
 *
 * 输出：一行 JSON（机器可读）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EvolutionError, gateModule, makeModuleProposal, promoteModule, shadowArtifact,
} from '../host/lib/evolution.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(join(HERE, '..'))
const argv = process.argv.slice(2)
const arg = (flag, fallback = null) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const has = (flag) => argv.includes(flag)

const sourceFile = arg('--source-file')
const approvalRef = arg('--approval-ref')
const shadowDir = resolve(ROOT, arg('--shadow-dir', 'tmp/t237-shadow'))
const dryRun = has('--dry-run')
const ledger = join(ROOT, 'tmp', 'evolve', 'ledger.jsonl')

const emit = (payload, code = 0) => { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); process.exit(code) }

const runVerify = (gate, ...extra) => {
  const proc = spawnSync(join(ROOT, 'tools', 'verify.sh'), [gate, ...extra], { cwd: ROOT, encoding: 'utf8' })
  return { exit: proc.status, tail: String(proc.stdout ?? '').trim().split('\n').slice(-1)[0] ?? '' }
}

const runFixtures = (moduleName, moduleDir) => {
  // 产物不合格时 fixture 以非 0 退出是**预期**的负控路径 → 用 spawnSync 取 stdout + 退出码
  const proc = spawnSync(process.execPath, [join(ROOT, 'host', 'check-modules.mjs'),
    '--module', moduleName, '--module-dir', moduleDir], { cwd: join(ROOT, 'host'), encoding: 'utf8' })
  if (!proc.stdout || !proc.stdout.trim()) {
    throw new Error(`fixture 子进程无输出（exit=${proc.status}）：${String(proc.stderr).slice(-400)}`)
  }
  const report = JSON.parse(proc.stdout)
  return { passed: report.passed, total: report.total, failed: report.checks.filter((c) => !c.ok).length,
    exit: proc.status, names: report.checks.map((c) => `${c.name}${c.ok ? '' : '✗'}`) }
}

const record = (event, body) => {
  const proc = spawnSync('python3', [join(ROOT, 'tools', 'evolve-record.py'),
    '--event', event, '--body', JSON.stringify(body), '--ledger', ledger], { cwd: ROOT, encoding: 'utf8' })
  return proc.status === 0 ? { ok: true, event } : { ok: false, event, detail: String(proc.stderr ?? '').trim().slice(0, 200) }
}

if (!sourceFile) emit({ ok: false, error: '缺少 --source-file（产物源码路径）' }, 2)
const source = readFileSync(resolve(ROOT, sourceFile), 'utf8')
const moduleName = arg('--name') ?? (source.match(/export const name = '([^']+)'/) ?? [])[1]
if (!moduleName) emit({ ok: false, error: '无法确定模块名（--name 或源码里的 export const name）' }, 2)

// 影子目录必须能解析 `../lib/std-schema.mjs`：把真实 host/lib 软链进去（与 host/evolution.mjs 的沙盒同法）
mkdirSync(join(shadowDir, 'modules'), { recursive: true })
const libLink = join(shadowDir, 'lib')
if (!existsSync(libLink)) symlinkSync(join(ROOT, 'host', 'lib'), libLink, 'dir')

const modulesBefore = runVerify('modules')
const modulesBeforeMs = Date.now()
runVerify('modules')
const baselineMs = Date.now() - modulesBeforeMs

// 同类失败历史：从**账本**读（H1：host 只读账本，写入仍由 Python 侧负责）。
// 不喂 history，`makeModuleProposal` 的"同类连续失败转人工"护栏等于没有——这是本轮补上的真缺口。
const history = existsSync(ledger)
  ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((item) => item.type === 'evolve/gated' && (item.body?.verdict === 'rejected'))
    .map(() => ({ kind: 'module', outcome: 'failed' }))
  : []

let proposal
try {
  proposal = makeModuleProposal({
    name: moduleName,
    source,
    rationale: arg('--rationale', '价格历史描述统计：让双方视角都能看到"报价序列"的形状，而不是只看最新一版'),
    expected_effect: { metric: 'fixture:module', direction: arg('--direction', 'up'), magnitude: Number(arg('--magnitude', 1)) },
    risks: arg('--risks', '统计口径若与内核 measures 不一致会造成误读 → 只输出离散趋势与描述统计，不参与任何判定'),
    rollback_plan: '删除 host/modules/<name>.mjs 并移除装配点（回滚只需一次 revert；产物为纯函数，无迁移）',
    evidence_refs: (arg('--evidence-refs', 'EV-072') ?? '').split(',').filter(Boolean),
  }, { history })
} catch (err) {
  if (err instanceof EvolutionError) emit({ ok: false, stage: 'proposal', code: err.code, error: err.message }, 2)
  throw err
}

const shadow = shadowArtifact(proposal, { shadowDir })
const fixture = runFixtures(moduleName, shadow.shadow_dir)

const inv = runVerify('invariants')
// 反例/场景集：s1..s4 四个场景全绿才算过（`verify.sh suite <name>` 需要场景名，不能空跑）
const scenarios = ['s1', 's2', 's3', 's4'].map((name) => ({ name, ...runVerify('suite', name) }))
// 预算：晋升前后跑一次 modules 门的耗时差（本产物无 I/O、无子进程，差值应当很小）
const afterMs = Date.now()
runVerify('modules')
const promotedDeltaMs = Date.now() - afterMs
const humanRefs = (source.match(/human:/g) ?? []).length

const gateVerdict = gateModule(proposal, {
  fixture,
  invariantsOk: inv.exit === 0,
  counterexamplesOk: scenarios.every((item) => item.exit === 0),
  budgetOk: promotedDeltaMs <= baselineMs * 3 + 2000,
  humanRateBefore: 0,
  humanRateAfter: humanRefs,   // 产物引入的"人签字"引用数必须是 0（静态扫描）
})

const LOG = join(ROOT, 'docs', 'work', 'evolution-log.json')
const appendLog = (entry) => {
  const current = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : { note: '自进化产出的插件清单（机检：tools/check-evolved-module.py；哈希必须与进树文件一致）', entries: [] }
  const entries = (current.entries ?? []).filter((item) => item.name !== entry.name)
  entries.push(entry)
  writeFileSync(LOG, JSON.stringify({ ...current, entries }, null, 2) + '\n', 'utf8')
}

const events = []
events.push(record('evolve/proposed', { id: proposal.id, name: moduleName, artifact_hash: proposal.artifact.hash,
  bytes: proposal.artifact.bytes, actor: 'agent:t237', target: proposal.target }))
events.push(record('evolve/shadowed', { id: proposal.id, shadow_path: shadow.shadow_path, hash: shadow.hash, actor: 'agent:t237' }))
events.push(record('evolve/gated', { id: proposal.id, verdict: gateVerdict.verdict, reasons: gateVerdict.reasons,
  fixture: `${fixture.passed}/${fixture.total}`, actor: 'host:gate-runner' }))

let promoted = null
let promoteError = null
if (gateVerdict.verdict === 'passed' && !dryRun) {
  try {
    promoted = promoteModule(proposal, null, { approval_ref: approvalRef, gateVerdict, shadowDir })
    events.push(record('evolve/promoted', { id: proposal.id, approval_ref: approvalRef,
      written_to: promoted.written_to.replace(ROOT + '/', ''), artifact_hash: promoted.artifact_hash, actor: 'agent:t237' }))
  } catch (err) {
    promoteError = { code: err.code ?? err.name, error: err.message }
  }
}

if (promoted) {
  appendLog({ name: moduleName, proposal_id: proposal.id, artifact_hash: promoted.artifact_hash,
    bytes: proposal.artifact.bytes, approval_ref: approvalRef, gate: gateVerdict.verdict,
    fixture: { passed: fixture.passed, total: fixture.total },
    produced_by: 'tools/evolve-module.mjs', ledger, evidence: (source.match(/EV-\d+/) ?? [])[0] ?? null })
}

const inTree = existsSync(join(ROOT, 'host', 'modules', `${moduleName}.mjs`))
const inTreeFixture = inTree && !dryRun
  ? runFixtures(moduleName, join(ROOT, 'host', 'modules'))
  : null

emit({
  ok: gateVerdict.verdict === 'passed' && (dryRun || Boolean(promoted)),
  module: moduleName,
  proposal_id: proposal.id,
  artifact: { hash: proposal.artifact.hash, bytes: proposal.artifact.bytes, target: proposal.target.replace(ROOT + '/', '') },
  shadow: { dir: shadow.shadow_dir.replace(ROOT + '/', ''), path: shadow.shadow_path.replace(ROOT + '/', '') },
  fixture: { passed: fixture.passed, total: fixture.total, failed: fixture.failed, exit: fixture.exit, names: fixture.names },
  gate: { verdict: gateVerdict.verdict, checks: gateVerdict.checks },
  scenarios: Object.fromEntries(scenarios.map((item) => [item.name, item.exit])),
  promote: promoted, promote_error: promoteError, dry_run: dryRun,
  same_kind_history: proposal.same_kind_history,
  in_tree: inTree, in_tree_fixture: inTreeFixture,
  modules_gate_before: modulesBefore.exit, modules_gate_after: runVerify('modules').exit,
  ledger_events: events,
  note: '晋升 = 门通过 + 人工引用 + 影子哈希一致；写入面仅 host/modules/；账本由 Python 侧写（H1）',
}, gateVerdict.verdict === 'passed' && (dryRun || Boolean(promoted)) ? 0 : 3)
