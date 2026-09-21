/**
 * 演化门机检骨架（评审 C §5.2/§5.3、`ADR-0014 §7`、评审 C §7.1 第 7 条 / 任务 T-220）。
 *
 * 形态：**host 侧只做组合与裁决**（提案记录、patch/journal 归属、影子挂载、门槛裁决、回滚），
 * **账本仍然只由 Python 侧写**（H1：宿主直写账本会被核对发现）——所以这里的"落账"是把事件体
 * 交给 `tools/evolve-record.py` 去 append，而不是自己写文件。
 *
 * P1 的边界（评审 C §7.1 第 7 条原文）：**不允许自动晋升**——`promote` 必带人工 `approval_ref`；
 * canary 的真实路由与自动晋升/自动回滚阈值留 P2。这里只做"机检骨架 + 手写回滚"。
 */
import { Context, EventsService } from 'cordis'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestOf } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')   // lib/ → host/ → 仓库根

/** 指标来源白名单（§5.2 反作弊）：只认账本事实，不认自评。 */
export const METRIC_SOURCES = ['ledger:count', 'ledger:rate', 'eval:report', 'approval:count', 'guard:flag-count']
/** 方向白名单：只允许"越高越好 / 越低越好"。 */
export const DIRECTIONS = ['up', 'down']
/** 同类提案连续失败阈值：达到即由 host 强制转人工（§5.2 末条），不再自动重试。 */
export const SAME_KIND_FAILURE_LIMIT = 3

export class EvolutionError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.code = code
  }
}

/** 提案记录（§5.2 步骤 2）：必填字段齐备、id 为内容哈希、指标必须带账本引用。 */
export function makeProposal(input, { history = [] } = {}) {
  const required = ['target', 'diff', 'rationale', 'expected_effect', 'risks', 'rollback_plan', 'evidence_refs']
  const missing = required.filter((key) => input[key] === undefined || input[key] === null)
  if (missing.length) {
    throw new EvolutionError('proposal-incomplete', `提案缺必填字段: ${missing.join(', ')}`)
  }
  const effect = input.expected_effect || {}
  if (!effect.metric || !DIRECTIONS.includes(effect.direction) || typeof effect.magnitude !== 'number') {
    throw new EvolutionError('effect-invalid',
      `expected_effect 需含 {metric, direction: ${DIRECTIONS.join('|')}, magnitude:number}`)
  }
  const source = String(input.source ?? 'ledger:count')
  if (!METRIC_SOURCES.includes(source)) {
    throw new EvolutionError('metric-source-invalid',
      `指标来源 ${source} 不在白名单 ${JSON.stringify(METRIC_SOURCES)}（不接受模型自评；§5.2）`)
  }
  const citations = input.evidence_refs || []
  if (!citations.length) {
    throw new EvolutionError('no-citation', '每个上报指标至少要有一条账本引用（citations ≥ 1；§5.2）')
  }
  const kind = String(input.kind ?? input.target)
  const sameKind = history.filter((item) => item.kind === kind)
  const failures = sameKind.filter((item) => item.outcome === 'failed').length
  if (failures >= SAME_KIND_FAILURE_LIMIT) {
    throw new EvolutionError('same-kind-escalated',
      `同类提案（${kind}）已连续失败 ${failures} 次：host 强制转人工，不再自动重试（§5.2 末条）`)
  }
  const record = {
    id: digestOf({ target: input.target, diff: input.diff, expected_effect: effect }),
    kind, target: input.target, diff: input.diff, rationale: input.rationale,
    expected_effect: { metric: effect.metric, direction: effect.direction, magnitude: effect.magnitude },
    risks: input.risks, rollback_plan: input.rollback_plan, evidence_refs: citations,
    source, same_kind_history: { total: sameKind.length, failed: failures },
  }
  if (String(record.target).startsWith('kernel')) {
    throw new EvolutionError('kernel-target-refused',
      'target 落在 `kernel.*` 命名空间：内核不可自改（INV-010 / H5）')
  }
  return record
}

/** patch/journal 归属（§5.3）：记录每个键的所有者，回滚只撤提案自己拥有的键。 */
export class PatchJournal {
  constructor(base = {}) {
    this.base = { ...base }      // 文件/人工 patch 提供的键（回滚不得撤）
    this.entries = []            // {key, owner, value}
  }

  own(proposal, keys) {
    if (!proposal?.id) throw new EvolutionError('journal-no-proposal', 'journal 需要提案（含 id）')
    const taken = []
    for (const [key, value] of Object.entries(keys)) {
      if (key in this.base) {
        throw new EvolutionError('journal-cut-in',
          `键 ${key} 由文件/人工 patch 拥有，提案不得占用（§5.3：回滚不覆盖别人的键）`)
      }
      this.entries.push({ key, owner: proposal.id, value })
      taken.push(key)
    }
    return taken
  }

  owner(key) {
    const hit = [...this.entries].reverse().find((item) => item.key === key)
    if (hit) return { owner: hit.owner, kind: 'proposal' }
    if (key in this.base) return { owner: 'file-or-human', kind: 'base' }
    return null
  }

  ownedKeys(proposalId) {
    return this.entries.filter((item) => item.owner === proposalId).map((item) => item.key)
  }

  revert(proposalId) {
    const own = this.ownedKeys(proposalId)
    this.entries = this.entries.filter((item) => item.owner !== proposalId)
    return own
  }
}

/**
 * 影子挂载（§5.2 步骤 3、§5.3）：在**隔离 realm** 里挂提案后的条目树，并把账本**复制到新文件**
 * （否则幂等去重会把"重放"变成"重复投递"——pitfalls 里那条）。
 */
export async function shadowMount(proposal, { ledgerPath, shadowDir, plugin, config = {} }) {
  if (!existsSync(ledgerPath)) {
    throw new EvolutionError('shadow-no-ledger', `账本不存在: ${ledgerPath}`)
  }
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const realm = `shadow:${proposal.id}`
  const isolated = ctx.isolate(realm)
  const copy = join(shadowDir, `shadow-${proposal.id.slice(7, 19)}.jsonl`)
  copyFileSync(ledgerPath, copy)
  let effects = 0
  const fiber = await isolated.plugin({
    name: `shadow-${proposal.id.slice(7, 15)}`,
    apply(c, cfg) {
      c.fiber.effect(() => () => { effects += 1 })
      cfg.onApply?.(c)
    },
  }, { ...config, onApply: plugin?.onApply })
  return {
    realm, ledger_copy: copy, fiber,
    effect_count: fiber.getEffects().length,
    dispose: async () => { await fiber.dispose(); return effects },
  }
}

/** 门槛裁决（§5.2 步骤 4）：五条 AND，逐条给理由；由 host 计算，不由提案模块自评。 */
export function gate(proposal, evidence) {
  const checks = []
  const effect = proposal.expected_effect
  const before = evidence.metricBefore
  const after = evidence.metricAfter
  const improved = effect.direction === 'up' ? after >= before : after <= before
  checks.push({ name: '目标指标不退化', ok: improved,
    detail: `${effect.metric}: ${before} → ${after}（期望 ${effect.direction}）` })
  checks.push({ name: 'INV-001..010 全绿', ok: evidence.invariantsOk === true,
    detail: `invariants=${evidence.invariantsOk}` })
  checks.push({ name: '反例集全绿', ok: evidence.counterexamplesOk === true,
    detail: `counterexamples=${evidence.counterexamplesOk}` })
  checks.push({ name: '成本/延迟不超预算', ok: evidence.budgetOk === true,
    detail: `cost=${evidence.costDelta ?? 'n/a'} latency=${evidence.latencyDelta ?? 'n/a'}` })
  const humanBefore = evidence.humanRateBefore
  const humanAfter = evidence.humanRateAfter
  checks.push({ name: '人工介入率不上升', ok: humanAfter <= humanBefore,
    detail: `介入率 ${humanBefore} → ${humanAfter}（用"多问人"换指标即越界）` })
  const failed = checks.filter((item) => !item.ok)
  return { verdict: failed.length ? 'rejected' : 'passed', checks,
    reasons: failed.map((item) => `${item.name}: ${item.detail}`),
    computed_by: 'host/gate-runner' }
}

/** 晋升（§5.2 步骤 6 + §7.1 第 7 条）：P1 **不允许自动晋升**，必带人工 approval_ref。 */
export function promote(proposal, journal, { approval_ref, gateVerdict } = {}) {
  if (!approval_ref || !/^ap-\d{4,}$/.test(String(approval_ref))) {
    throw new EvolutionError('promote-needs-approval',
      'P1 不允许自动晋升：promote 必须带形如 `ap-0001` 的人工 approval_ref（§7.1 第 7 条）')
  }
  if (gateVerdict?.verdict !== 'passed') {
    throw new EvolutionError('promote-gate-failed',
      `门未通过不得晋升：${JSON.stringify(gateVerdict?.reasons ?? [])}`)
  }
  const keys = journal.ownedKeys(proposal.id)
  if (!keys.length) {
    throw new EvolutionError('promote-nothing-owned', '提案没有拥有任何键：无可晋升内容')
  }
  return { id: proposal.id, status: 'promoted', approval_ref, keys, note: 'journal 折进 base（P1 手写）' }
}

/** 回滚（§5.3）：卸载 effect（dispose，逆序回收）+ journal 撤回；不依赖人工删文件。 */
export async function rollback(proposal, journal, shadow) {
  const released = await shadow.dispose()
  const revoked = journal.revert(proposal.id)
  return { id: proposal.id, status: 'rolled-back', effects_released: released,
    revoked_keys: revoked, note: '回滚 = dispose + journal 撤回；只撤自己拥有的键' }
}

/** 把事件体交给 Python 侧落账（H1：宿主不做账本写入）。 */
export function recordEvent(event, body, ledgerPath) {
  const script = join(ROOT, 'tools', 'evolve-record.py')
  const args = [script, '--event', event, '--body', JSON.stringify(body)]
  if (ledgerPath) args.push('--ledger', ledgerPath)
  const out = execFileSync('python3', args, {
    cwd: ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: join(ROOT, 'src') },
  })
  // 说明：显式传 ledgerPath 是**为了让冒烟自洽**（默认账本是共享的，第二次跑 seq 会接续 → 断言失效）
  return JSON.parse(out.trim().split('\n').pop())
}
