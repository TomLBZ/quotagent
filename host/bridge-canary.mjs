/**
 * bridge 调用面 canary 的检查（`tools/verify.sh bridge-canary`）：每条给正控 + 负控。
 *
 * 覆盖：
 *   1. 未注册就调用 → 必须报错（不得静默 no-op）
 *   2. 无候选：全部走 base，结果与直接调用 base 一致
 *   3. weight=0 → 全 base；weight=10000 → 全 canary（精确边界）
 *   4. `methods` 白名单：名单外的方法**不参与分流**（始终 base）且计入 `refused`
 *   5. **候选抛错 → 回退 base**，调用方拿到正确答案，canary 侧如实记失败样本
 *   6. **base 抛错 → 原样抛出**（不得静默回退）
 *   7. 真实调用回灌样本 → 候选退化时 `decide()` 给出 automatic 回滚
 *   8. 候选可注册/替换（晋升产物可以按此接口接进来），替换后统计里的 candidate_name 跟着变
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { apply as canaryApply, Config as canaryConfig } from './modules/canary.mjs'
import { apply as bridgeCanaryApply, Config as bridgeCanaryConfig } from './modules/bridge-canary.mjs'
import { runCanary, CanaryApprovalRequired } from './lib/canary-run.mjs'

const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const mountPair = async (canaryConf, bridgeConf = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const cfiber = await ctx.plugin({
    name: 'canary#bridge', inject: [], Config: canaryConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'canary') box.canary = value; return original(service, value) }
      await canaryApply(inner, cfg)
    },
  }, canaryConfig.parse(canaryConf))
  const dfiber = await ctx.plugin({
    name: 'bridge-canary#probe', inject: ['canary'], Config: bridgeCanaryConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'canary-dispatch') box.dispatch = value; return original(service, value) }
      await bridgeCanaryApply(inner, cfg)
    },
  }, bridgeCanaryConfig.parse(bridgeConf))
  return { ctx, box, dispose: async () => { await dfiber.dispose(); await cfiber.dispose() } }
}

const baseTransport = (method, params) => ({ via: 'base', method, params })
const candTransport = (method, params) => ({ via: 'canary', method, params })

// --- 1. 未注册 ---
const a = await mountPair({ weight_bps: 5000 })
let notRegistered = null
try { a.box.dispatch.call('ledger.count', {}) } catch (err) { notRegistered = String(err.message) }
check('负控：未 register(base) 就调用必须报错（不得静默 no-op）',
  String(notRegistered).includes('dispatch-not-registered'), `error=${String(notRegistered).slice(0, 60)}`)

// --- 2. 无候选 → 全 base ---
a.box.dispatch.register({ base: baseTransport })
a.box.dispatch.register({ base: baseTransport })
const noCand = a.box.dispatch.call('ledger.count', { x: 1 })
check('无候选实现时全部走 base，结果与直接调用 base 一致（canary 只能验证候选，不能凭空生效）',
  noCand.lane === 'base' && JSON.stringify(noCand.result) === JSON.stringify(baseTransport('ledger.count', { x: 1 })),
  `lane=${noCand.lane} result=${JSON.stringify(noCand.result)}`)
await a.dispose()

// --- 3/4. 边界与白名单 ---
const off = await mountPair({ weight_bps: 0 })
off.box.dispatch.register({ base: baseTransport, candidate: candTransport, candidate_name: 'cand-1' })
const offCall = off.box.dispatch.call('ledger.count', {})
check('weight=0 → 全 base（即使有候选；精确边界）', offCall.lane === 'base' && offCall.result.via === 'base',
  `lane=${offCall.lane} via=${offCall.result.via}`)
await off.dispose()

const on = await mountPair({ weight_bps: 10000 }, { methods: ['ledger.count'] })   // methods 属于 bridge 侧配置
on.box.dispatch.register({ base: baseTransport, candidate: candTransport, candidate_name: 'cand-1' })
const onCall = on.box.dispatch.call('ledger.count', {})
const otherCall = on.box.dispatch.call('quote.submit', {})
const onStats = on.box.dispatch.stats()
check('weight=10000 → 走候选；`methods` 白名单外的方法**不参与分流**（始终 base）并计入 refused',
  onCall.lane === 'canary' && onCall.result.via === 'canary'
  && otherCall.lane === 'base' && otherCall.result.via === 'base' && otherCall.dispatched === false
  && onStats.refused === 1,
  `onCall=${onCall.result.via} otherCall=${otherCall.result.via} refused=${onStats.refused}`)
await on.dispose()

// --- 5. 候选抛错 → 回退 base ---
const fb = await mountPair({ weight_bps: 10000 }, { name: 'bridge-call' })
const boom = () => { throw new Error('candidate-boom') }
fb.box.dispatch.register({ base: baseTransport, candidate: boom, candidate_name: 'cand-broken' })
const fbCall = fb.box.dispatch.call('ledger.count', { y: 2 })
const fbStats = fb.box.dispatch.stats()
check('负控→正控：候选抛错时**回退 base**（调用方拿到正确答案），且回退计入统计',
  fbCall.lane === 'canary' && fbCall.fallback_used === true && fbCall.result.via === 'base'
  && fbStats.fallbacks === 1,
  `fallback=${fbCall.fallback_used} via=${fbCall.result.via} fallbacks=${fbStats.fallbacks}`)

// --- 6. base 抛错 → 原样抛出 ---
const baseBoom = () => { throw new Error('base-boom') }
// 注意：本组 weight=10000，调用会走候选 —— 要验"base 抛错"，必须让这次调用**真的**落在 base 上
// （实测踩到：不分桶就断言，等价于什么都没测）。用 weight=0 的独立挂载。
const onlyBase = await mountPair({ weight_bps: 0 })
onlyBase.box.dispatch.register({ base: baseBoom, candidate: candTransport })
let baseThrew = null
try { onlyBase.box.dispatch.call('ledger.count', {}) } catch (err) { baseThrew = String(err.message) }
await onlyBase.dispose()
check('负控：base 抛错必须原样抛出（不得静默回退掩盖真实故障）',
  String(baseThrew).includes('base-boom'), `error=${String(baseThrew).slice(0, 50)}`)
await fb.dispose()

// --- 7. 真实调用回灌 → 退化自动回滚 ---
const live = await mountPair({ weight_bps: 5000, min_samples: 5 })
live.box.canary.enterCanary({ proposal_id: 'p-bridge', approval_ref: 'ap-0031' })
const flaky = (method, params) => {
  if (params.n % 2 === 0) throw new Error('canary-degraded')
  return { via: 'canary', method }
}
live.box.dispatch.register({ base: baseTransport, candidate: flaky, candidate_name: 'cand-flaky' })
let fallbacks = 0
for (let n = 1; n <= 40; n++) {
  const r = live.box.dispatch.call('ledger.count', { n })
  if (r.fallback_used) fallbacks += 1
}
const decision = live.box.canary.decide()
const stats = live.box.canary.stats()
check('真实调用回灌样本 → 候选退化时 decide() 给出 **automatic 回滚**（安全动作，无需人工）',
  fallbacks > 0 && decision.action === 'rollback' && decision.automatic === true
  && decision.approval_required === false,
  `回退 ${fallbacks} 次；base=${stats.base.count} canary=${stats.canary.count}；action=${decision.action}`)

// --- 8. 候选可替换（晋升产物的接入点） ---
live.box.dispatch.register({ base: baseTransport, candidate: baseTransport, candidate_name: 'cand-v2' })
const afterSwap = live.box.dispatch.stats()
check('候选可替换且统计跟随（晋升产物即按此接口接进来）',
  afterSwap.candidate_name === 'cand-v2' && afterSwap.has_candidate === true,
  `candidate_name=${afterSwap.candidate_name}`)
await live.dispose()

// --- 9. runCanary 编排（T-235）：批准门 / 两侧采样 / 退化自动回滚 ---
const live2 = await mountPair({ weight_bps: 5000, min_samples: 5 }, { name: 'bridge-call' })
const flaky2 = (method, params) => {
  if (params.probe % 2 === 0) throw new Error('candidate-degraded')
  return { via: 'canary', method }
}
live2.box.dispatch.register({ base: baseTransport, candidate: flaky2, candidate_name: 'cand-v1' })
let noApprovalRun = null
try {
  runCanary({ canary: live2.box.canary, dispatch: live2.box.dispatch, method: 'ledger.count', probeCount: 20 })
} catch (err) { noApprovalRun = err }
check('runCanary 负控：缺人工引用直接拒绝（canary-approval-required，且**不进入** canary）',
  noApprovalRun instanceof CanaryApprovalRequired && live2.box.canary.state().phase === 'base',
  `code=${noApprovalRun?.code} phase=${live2.box.canary.state().phase}`)

const ran = runCanary({ canary: live2.box.canary, dispatch: live2.box.dispatch, method: 'ledger.count',
  probeCount: 40, approval_ref: 'ap-0101', proposal_id: 'p-t235' })
const lvStats = live2.box.canary.stats()
check('runCanary 正控：探针一次性采样**两侧** + 退化判定 + **自动回滚**（安全动作免批准）',
  ran.decision?.action === 'rollback' && ran.decision.automatic === true && ran.decision.approval_required === false
  && lvStats.base.count > 0 && lvStats.canary.count > 0 && ran.exited?.phase === 'base' && ran.samples.fallbacks > 0,
  `base=${lvStats.base.count} canary=${lvStats.canary.count} fallbacks=${ran.samples.fallbacks} `
  + `decision=${ran.decision?.action} exited=${ran.exited?.phase}`)

const live3 = await mountPair({ weight_bps: 5000, min_samples: 5 }, { name: 'bridge-call' })
live3.box.dispatch.register({ base: baseTransport, candidate: baseTransport, candidate_name: 'cand-good' })
const good = runCanary({ canary: live3.box.canary, dispatch: live3.box.dispatch, method: 'ledger.count',
  probeCount: 20, approval_ref: 'ap-0102' })
check('runCanary 负控：候选不退化时**不回滚**（推荐只是建议，不擅自扩大上线面）',
  good.exited === null && ['promote', 'hold'].includes(good.decision?.action) && live3.box.canary.state().phase === 'canary',
  `action=${good.decision?.action} exited=${good.exited} phase=${live3.box.canary.state().phase}`)
await live2.dispose(); await live3.dispose()

console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] bridge-canary: ${failures} 项未通过`)
} else {
  console.error(`[PASS] bridge-canary（${facts.checks.length} 条断言：调用面分流 + 失败隔离 + 样本回灌）`)
}
process.exit(failures ? 1 : 0)
