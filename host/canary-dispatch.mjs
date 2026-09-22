/**
 * canary 接线检查（`tools/verify.sh canary-route`）：把"分流 + 记录 + 失败隔离"接到真实请求路径上。
 *
 * 覆盖（每条含负控）：
 *   1. weight=0 → 全 base，输出与未接线时**字节一致**（升级路径安全）
 *   2. 分桶确定性：同一 key 多次调用同道
 *   3. **候选失败必须回退 base**（且如实记 `ok:false`：错误不能被吞掉）
 *   4. **base 失败必须原样抛出**（不得静默回退掩盖真实故障）
 *   5. 样本回灌：真实调用产生的样本足以驱动 `verdict()`（不是模拟数据）
 *   6. 候选退化 → `decide()` 给出 automatic rollback（安全动作）
 *   7. 返回结构显式带 lane（调用方不得假设走了哪条道）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { apply as canaryApply, Config as canaryConfig } from './modules/canary.mjs'
import { makeDispatcher } from './lib/canary-dispatch.mjs'

const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const mountCanary = async (config) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const fiber = await ctx.plugin({
    name: 'canary#dispatch',
    inject: [],
    Config: canaryConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'canary') box.handle = value; return original(service, value) }
      await canaryApply(inner, cfg)
    },
  }, canaryConfig.parse(config))
  return { box, fiber }
}

const baseImpl = (input) => ({ value: input.n * 2, impl: 'base' })
const candImpl = (input) => ({ value: input.n * 2, impl: 'canary' })

// --- 1. weight=0：零影响 ---
const off = await mountCanary({ weight_bps: 0, min_samples: 3 })
const offDispatch = makeDispatcher({ canary: off.box.handle, realm: 'r-off', name: 'norm' })
const offWrapped = offDispatch.wrap({ base: baseImpl, candidate: candImpl, keyOf: (input) => `k${input.n}` })
const offResults = [1, 2, 3, 4, 5].map((n) => offWrapped({ n }))
check('weight=0 → 全部走 base，输出与未接线时字节一致（升级路径默认零影响）',
  offResults.every((item) => item.lane === 'base' && item.result.impl === 'base' && item.fallback_used === false)
  && JSON.stringify(offResults[0].result) === JSON.stringify(baseImpl({ n: 1 })),
  `lanes=${JSON.stringify(offResults.map((item) => item.lane))}`)
await off.fiber.dispose()

// --- 2/3/4. 分流确定性 + 失败隔离 ---
const mid = await mountCanary({ weight_bps: 5000, min_samples: 3 })
const dispatch = makeDispatcher({ canary: mid.box.handle, realm: 'r-1', name: 'norm' })
const wrapped = dispatch.wrap({ base: baseImpl, candidate: candImpl, keyOf: (input) => `k${input.n}` })
const lanesA = [1, 2, 3, 4, 5, 6].map((n) => wrapped({ n }).lane)
const lanesB = [1, 2, 3, 4, 5, 6].map((n) => wrapped({ n }).lane)
check('分桶确定性：同一 key 每次调用落同一条道（真实调用路径上可复现）',
  JSON.stringify(lanesA) === JSON.stringify(lanesB) && lanesA.includes('canary') && lanesA.includes('base'),
  `两次=${JSON.stringify(lanesA)}`)

const throwing = () => { throw new Error('candidate-boom') }
const candKey = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((n) => mid.box.handle.bucket({ realm: 'r-1', key: `norm:k${n}` }) === 'canary')
const fallbackWrap = dispatch.wrap({ base: baseImpl, candidate: throwing, keyOf: (input) => `k${input.n}` })
const fallbackResult = fallbackWrap({ n: candKey })
const statsAfterFallback = mid.box.handle.stats()
check('负控→正控：候选实现抛错时**回退 base**（调用方不受影响），且 canary 侧如实记 ok=false（错误不被吞掉）',
  fallbackResult.lane === 'canary' && fallbackResult.fallback_used === true
  && fallbackResult.result.impl === 'base' && statsAfterFallback.canary.errors >= 1,
  `lane=${fallbackResult.lane} fallback=${fallbackResult.fallback_used} canary 错误数=${statsAfterFallback.canary.errors}`)

const baseBoom = () => { throw new Error('base-boom') }
const baseKey = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((n) => mid.box.handle.bucket({ realm: 'r-1', key: `norm:k${n}` }) === 'base')
let baseThrew = null
try {
  dispatch.wrap({ base: baseBoom, candidate: candImpl, keyOf: (input) => `k${input.n}` })({ n: baseKey })
} catch (err) { baseThrew = String(err.message) }
check('负控：base 抛错必须**原样抛出**（不得静默回退掩盖真实故障）',
  String(baseThrew).includes('base-boom'), `error=${String(baseThrew).slice(0, 60)}`)
await mid.fiber.dispose()

// --- 5/6. 真实样本回灌 → 判定 ---
const live = await mountCanary({ weight_bps: 5000, min_samples: 5 })
const liveDispatch = makeDispatcher({ canary: live.box.handle, realm: 'r-live', name: 'quote-normalizer' })
const goodBase = (input) => ({ ok: true, value: input.n })
const degradedCandidate = (input) => { if (input.n % 2 === 0) throw new Error('canary-degraded'); return { ok: true, value: input.n } }
live.box.handle.enterCanary({ proposal_id: 'p-live', approval_ref: 'ap-0021' })
const liveWrapped = liveDispatch.wrap({ base: goodBase, candidate: degradedCandidate, keyOf: (input) => `k${input.n}` })
let served = 0
for (let n = 1; n <= 40; n++) { liveWrapped({ n }); served += 1 }
const v = live.box.handle.verdict()
const decision = live.box.handle.decide()
// 精确不变量：样本数 = 投递次数 + 回退次数 —— 回退时**多记一条 base 样本**（那一次确实是 base 在服务），
// canary 侧同时记 ok=false。两边都不许少记（漏样本会让判定失真）。
const liveStats = liveDispatch.stats()
check('样本回灌：真实调用驱动判定，且样本数 = 投递数 + 回退数（回退时 base 侧也如实记一条）',
  liveStats.fallbacks > 0 && v.base.count + v.canary.count === served + liveStats.fallbacks,
  `base=${v.base.count} canary=${v.canary.count} 投递=${served} 回退=${liveStats.fallbacks}`)
check('候选退化 → decide() 给出 **automatic 回滚**（安全动作，不需要人工批准）',
  decision.action === 'rollback' && decision.automatic === true && decision.approval_required === false,
  `action=${decision.action} reasons=${JSON.stringify(decision.verdict.reasons).slice(0, 100)}`)
await live.fiber.dispose()


// --- 7. 端到端：canary 分流作用在 **WebUI 的真实请求路径**（视角投影）上 ---
// 这里是"接线"的证据：真挂 webui + projection + canary，用 canary 的分桶**真的**决定
// `/supplier/api/events` 这次请求走 base 投影还是候选投影，并把样本回灌给判定器。
const { apply: webuiApply, Config: webuiConfig } = await import('./modules/webui.mjs')
const { Config: projectionConfig, apply: projectionApply } = await import('./modules/projection.mjs')

const ledgerStub = {
  path: '/tmp/e2e.jsonl',
  rows: () => [
    { seq: 1, type: 'rfq/published', correlation_id: 'pkg-1', ts: 't1', body: { package_id: 'pkg-1' } },
    { seq: 2, type: 'quote/submitted', correlation_id: 'q-1', ts: 't2', body: { quote_id: 'q-1' } },
  ],
  verify: () => ({ ok: true, count: 2, head: 'sha256:' + 'b'.repeat(64) }),
}

const e2e = async ({ weightBps, candidate }) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  ctx.provide('ledgerView', ledgerStub)
  // 系统管理两插件：e2e 里用真模块挂载（未配 token → admin 道保持未启用，行为与生产一致）
  {
    const { apply: avApply2, Config: avConfig2 } = await import('./modules/admin-view.mjs')
    await ctx.plugin({
      name: 'admin-view',   // 与提供者模块同名：wiring 门按 服务→提供者 映射查找（B2）
      inject: [], Config: avConfig2,
      apply: (inner, cfg) => avApply2(inner, { ...cfg, admin_snapshot: '' }),
    })
    const { apply: upApply2, Config: upConfig2 } = await import('./modules/user-plugin-manager.mjs')
    await ctx.plugin({ name: 'user-plugin-manager', inject: [], Config: upConfig2,
      apply: (inner, cfg) => upApply2(inner, { ...cfg, root: '' }) })
    const { apply: pmApply2, Config: pmConfig2 } = await import('./modules/plugin-market.mjs')
    await ctx.plugin({ name: 'plugin-market', inject: [], Config: pmConfig2,
      apply: (inner, cfg) => pmApply2(inner, { ...cfg, modules_dir: 'host/modules', inventory: '', user_space: '' }) })
    const { apply: agApply2, Config: agConfig2 } = await import('./modules/admin-guard.mjs')
    await ctx.plugin({
      name: 'admin-guard',
      inject: [], Config: agConfig2,
      apply: (inner, cfg) => agApply2(inner, { ...cfg, token_env: 'QUOTAGENT_ADMIN_TOKEN', token_file: '' }),
    })
  }
  const cbox = {}
  const cfiber = await ctx.plugin({
    name: 'canary#e2e', inject: [], Config: canaryConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'canary') cbox.handle = value; return original(service, value) }
      await canaryApply(inner, cfg)
    },
  }, canaryConfig.parse({ weight_bps: weightBps, min_samples: 2 }))
  // 投影服务由 canary 分流包起来（这就是"接线"：真实请求路径上的选择权交给 canary）
  const dispatcher = makeDispatcher({ canary: cbox.handle, realm: 'ui', name: 'projection', clock: () => 0, cost: () => 0 })
  const gbox2 = {}
  const { apply: governorApply2, Config: governorConfig2 } = await import('./modules/governor.mjs')
  await ctx.plugin({ name: 'governor#e2e', inject: [], Config: governorConfig2,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'governor') gbox2.handle = value; return original(service, value) }
      await governorApply2(inner, cfg)
    } }, governorConfig2.parse({ capacity: 64, timeout_ms: 5000 }))
  const pbox = {}
  const pfiber = await ctx.plugin({
    name: 'projection#e2e', inject: [], Config: projectionConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if (service !== 'projection') return original(service, value)
        pbox.base = value
        const wrapped = {
          ...value,
          lanes: () => [],
          projectWithAudit: (view, rows) => {
            const { lane, result } = dispatcher.wrap({
              base: (input) => value.projectWithAudit(input.view, input.rows),
              candidate: (input) => candidate(input.view, input.rows),
              keyOf: (input) => `${input.view}`,
            })({ view, rows })
            pbox.lastLane = lane
            return result
          },
        }
        return original(service, wrapped)
      }
      await projectionApply(inner, cfg)
    },
  }, projectionConfig.parse({}))
  // 观测来源（T-236）：webui 的 inject 现在还需要 observability（含它的三个来源）
  const { apply: auditApplyE2E, Config: auditConfigE2E } = await import('./modules/audit-hook.mjs')
  await ctx.plugin({ name: 'audit#e2e', inject: [], Config: auditConfigE2E,
    apply: (inner, cfg) => auditApplyE2E(inner, cfg) }, auditConfigE2E.parse({ capacity: 200 }))
  const { apply: obsApplyE2E, Config: obsConfigE2E } = await import('./modules/observability.mjs')
  await ctx.plugin({ name: 'observability#e2e', inject: ['governor', 'audit', 'canary'], Config: obsConfigE2E,
    apply: (inner, cfg) => obsApplyE2E(inner, cfg) }, obsConfigE2E.parse({}))
  const { apply: rvApplyE2E, Config: rvConfigE2E } = await import('./modules/retention-view.mjs')
  await ctx.plugin({ name: 'retention-view#e2e', inject: [], Config: rvConfigE2E,
    apply: (inner, cfg) => rvApplyE2E(inner, cfg) }, rvConfigE2E.parse({}))
  const { apply: apApplyE2E, Config: apConfigE2E } = await import('./modules/approval-digest.mjs')
  await ctx.plugin({ name: 'approval-digest#e2e', inject: [], Config: apConfigE2E,
    apply: (inner, cfg) => apApplyE2E(inner, cfg) }, apConfigE2E.parse({}))
  const { apply: scApplyE2E, Config: scConfigE2E } = await import('./modules/supplier-scorecard.mjs')
  await ctx.plugin({ name: 'supplier-scorecard#e2e', inject: [], Config: scConfigE2E,
    apply: (inner, cfg) => scApplyE2E(inner, cfg) }, scConfigE2E.parse({}))
  const { apply: jApplyE2E, Config: jConfigE2E } = await import('./modules/evolve-journal.mjs')
  await ctx.plugin({ name: 'evolve-journal#e2e', inject: [], Config: jConfigE2E,
    apply: (inner, cfg) => jApplyE2E(inner, cfg) }, jConfigE2E.parse({}))
  const { apply: brApplyE2E, Config: brConfigE2E } = await import('./modules/circuit-breaker.mjs')
  await ctx.plugin({ name: 'circuit-breaker#e2e', inject: [], Config: brConfigE2E,
    apply: (inner, cfg) => brApplyE2E(inner, cfg) }, brConfigE2E.parse({}))
  const { apply: opsApplyE2E, Config: opsConfigE2E } = await import('./modules/ops-view.mjs')
  await ctx.plugin({ name: 'ops-view#e2e', inject: ['observability', 'breaker', 'evidenceSummary'], Config: opsConfigE2E,
    apply: (inner, cfg) => opsApplyE2E(inner, cfg) }, opsConfigE2E.parse({}))
  const { apply: evApplyE2E, Config: evConfigE2E } = await import('./modules/evidence-summary.mjs')
  await ctx.plugin({ name: 'evidence-summary#e2e', inject: [], Config: evConfigE2E,
    apply: (inner, cfg) => evApplyE2E(inner, cfg) }, evConfigE2E.parse({}))
  const { apply: histApplyE2E, Config: histConfigE2E } = await import('./modules/price-history.mjs')
  await ctx.plugin({ name: 'price-history#e2e', inject: [], Config: histConfigE2E,
    apply: (inner, cfg) => histApplyE2E(inner, cfg) }, histConfigE2E.parse({ key_field: 'supplier_id' }))
  // 配置与凭据（config-view）：webui 的 inject 需要它（wiring 门 B2）；e2e 里用**不存在的文件** → 视图降级
  const { apply: cvApplyE2E, Config: cvConfigE2E } = await import('./modules/config-view.mjs')
  await ctx.plugin({ name: 'config-view', inject: [], Config: cvConfigE2E,
    apply: (inner, cfg) => cvApplyE2E(inner, { ...cfg, config_file: '', config_inbox: '', config_status: '',
      config_ledger: '' }) }, cvConfigE2E.parse({}))
  // 邮件域（mail-view）：webui 的 inject 需要它；快照指向**不存在的文件** → 视图如实降级（不假装有数据）
  const { apply: fbApplyE2E, Config: fbConfigE2E } = await import('./modules/ui-feedback.mjs')
  await ctx.plugin({ name: 'ui-feedback', inject: [], Config: fbConfigE2E,
    apply: (inner, cfg) => fbApplyE2E(inner, { ...cfg, ui_shared: '' }) })
  const { apply: bhApplyE2E, Config: bhConfigE2E } = await import('./modules/bid-heuristics.mjs')
  await ctx.plugin({ name: 'bid-heuristics', inject: [], Config: bhConfigE2E,
    apply: (inner, cfg) => bhApplyE2E(inner, cfg) }, bhConfigE2E.parse({}))
  const { apply: advApplyE2E, Config: advConfigE2E } = await import('./modules/advice-panel.mjs')
  await ctx.plugin({ name: 'advice-panel', inject: [], Config: advConfigE2E,
    apply: (inner, cfg) => advApplyE2E(inner, cfg) }, advConfigE2E.parse({}))
  const { apply: gtApplyE2E, Config: gtConfigE2E } = await import('./modules/gate-timeline.mjs')
  await ctx.plugin({ name: 'gate-timeline', inject: [], Config: gtConfigE2E,
    apply: (inner, cfg) => gtApplyE2E(inner, cfg) }, gtConfigE2E.parse({}))
  // 授权区间（authority-band）：webui 的 inject 需要它；配置快照由 webui 从 config-view 只读总览里取
  const { apply: abApplyE2E, Config: abConfigE2E } = await import('./modules/authority-band.mjs')
  await ctx.plugin({ name: 'authority-band', inject: [], Config: abConfigE2E,
    apply: (inner, cfg) => abApplyE2E(inner, cfg) }, abConfigE2E.parse({}))
  // RFQ 回文时限（rfq-deadline）：webui 的 inject 需要它（wiring 门 B2）；纯函数插件，无需夹具输入
  const { apply: rdApplyE2E, Config: rdConfigE2E } = await import('./modules/rfq-deadline.mjs')
  await ctx.plugin({ name: 'rfq-deadline', inject: [], Config: rdConfigE2E,
    apply: (inner, cfg) => rdApplyE2E(inner, cfg) }, rdConfigE2E.parse({}))
  // 报价草稿（quote-prepare）：webui 的 inject 需要它（wiring 门 B2）；纯函数插件，无需夹具输入
  const { apply: qpApplyE2E, Config: qpConfigE2E } = await import('./modules/quote-prepare.mjs')
  await ctx.plugin({ name: 'quote-prepare', inject: [], Config: qpConfigE2E,
    apply: (inner, cfg) => qpApplyE2E(inner, cfg) }, qpConfigE2E.parse({}))
  const { apply: mvApplyE2E, Config: mvConfigE2E } = await import('./modules/mail-view.mjs')
  await ctx.plugin({ name: 'mail-view', inject: [], Config: mvConfigE2E,
    apply: (inner, cfg) => mvApplyE2E(inner, { ...cfg, mail_state: '', ui_shared: '' }) }, mvConfigE2E.parse({}))
  const wbox = {}
  const wfiber = await ctx.plugin({
    name: 'webui#e2e', inject: ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback', 'advicePanel', 'gateTimeline', 'authorityBand', 'rfqDeadline', 'quotePrepare'], Config: webuiConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'webui') wbox.handle = value; return original(service, value) }
      await webuiApply(inner, cfg)
    },
  }, webuiConfig.parse({ port: 0, route_prefix: '/quotagent' }))
  const base = wbox.handle.url.replace(/\/$/, '')
  const body = await (await fetch(`${base}/supplier/api/events`)).text()
  const lane = pbox.lastLane
  const stats = cbox.handle.stats()
  const decision = cbox.handle.decide()
  await wfiber.dispose(); await pfiber.dispose(); await cfiber.dispose()
  return { body, lane, stats, decision, dispatcher: dispatcher.stats() }
}

const candProjection = (view, rows) => ({
  publicRows: rows.map((row) => ({ ...row, type: `canary-marker:${row.type}` })),
  audit: [],
})

const offE2E = await e2e({ weightBps: 0, candidate: candProjection })
check('端到端正控：weight=0 → UI 供应商视角走 base 投影（响应里没有候选标记，接线默认零影响）',
  offE2E.lane === 'base' && offE2E.body.includes('quote_id') && !offE2E.body.includes('canary-marker'),
  `lane=${offE2E.lane} 含 quote_id=${offE2E.body.includes('quote_id')} 含候选标记=${offE2E.body.includes('canary-marker')}`)

const onE2E = await e2e({ weightBps: 10000, candidate: candProjection })
check('端到端正控：weight=10000 → 同一路由走**候选投影**（响应里出现候选标记）；样本回灌给 canary',
  onE2E.lane === 'canary' && onE2E.body.includes('canary-marker')
  && onE2E.stats.canary.count === 1 && onE2E.stats.base.count === 0,
  `lane=${onE2E.lane} 含候选标记=${onE2E.body.includes('canary-marker')} 样本 base=${onE2E.stats.base.count} canary=${onE2E.stats.canary.count}`)

console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] canary-route: ${failures} 项未通过`)
} else {
  console.error(`[PASS] canary-route（${facts.checks.length} 条断言：分流接线 + 失败隔离 + 真实样本回灌）`)
}
process.exit(failures ? 1 : 0)
