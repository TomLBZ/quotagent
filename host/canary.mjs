/**
 * canary 路由与自动回滚的检查（`tools/verify.sh canary`）：每条行为都给正控 + 负控。
 *
 * 覆盖（`ADR-0017` / D-021）：
 *   1. 分桶确定性：同一 (realm, key) 永远落同一条道；连跑两次字节一致
 *   2. realm 白名单：不在名单里的 realm **永远** base（不得偷偷分流）
 *   3. weight=0 → 全 base；weight=10000 → 全 canary（边界不是"差不多"）
 *   4. 进入 canary **必须**人工引用（负控：无引用即拒）；重复进入拒绝
 *   5. 判定：样本不足 → insufficient（不得在样本不足时给结论）
 *   6. **退化 → rollback 且 automatic=true、approval_required=false**（安全动作自动执行）
 *   7. 不退化且有更优 → promote 但 **approval_required=true**（机器人不得自行扩大上线面）
 *   8. 只有 base 退化时不回滚 canary（不得把 base 的问题算到 canary 头上）
 *   9. 退出 canary 不需要人工批准；未进入时退出报错
 *  10. 环形窗口：超出 window 丢最旧（有界，不会内存无限增长）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'

const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const mount = async (config = {}) => {
  const mod = await import('./modules/canary.mjs')
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const draft = mod.Config.parse({ ...config })
  const box = {}
  const fiber = await ctx.plugin({
    name: 'canary#probe',
    inject: [],
    Config: mod.Config,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'canary') box.handle = value; return original(service, value) }
      await mod.apply(inner, cfg)
    },
  }, draft)
  return { ctx, fiber, box, mod }
}

// --- 1/2/3. 分桶 ---
const a = await mount({ weight_bps: 5000 })
const first = ['r-a|quote-1', 'r-a|quote-2', 'r-b|quote-3'].map((p) => {
  const [realm, key] = p.split('|')
  return a.box.handle.bucket({ realm, key })
})
const second = ['r-a|quote-1', 'r-a|quote-2', 'r-b|quote-3'].map((p) => {
  const [realm, key] = p.split('|')
  return a.box.handle.bucket({ realm, key })
})
check('分桶确定性：同一 (realm, key) 两次调用结果一致（哈希分桶，无墙钟/随机）',
  JSON.stringify(first) === JSON.stringify(second), `两次=${JSON.stringify(first)}`)

const scoped = await mount({ weight_bps: 10000, realms: ['r-canary'] })
const inScope = scoped.box.handle.bucket({ realm: 'r-canary', key: 'k' })
const outScope = scoped.box.handle.bucket({ realm: 'r-other', key: 'k' })
check('realm 白名单负控：名单内的 realm 全量走 canary，名单外的**永远** base（不得越界分流）',
  inScope === 'canary' && outScope === 'base', `名单内=${inScope} 名单外=${outScope}`)

const off = await mount({ weight_bps: 0 })
const all = await mount({ weight_bps: 10000 })
const offLanes = new Set(Array.from({ length: 40 }, (_, i) => off.box.handle.bucket({ realm: 'r', key: `k${i}` })))
const allLanes = new Set(Array.from({ length: 40 }, (_, i) => all.box.handle.bucket({ realm: 'r', key: `k${i}` })))
check('边界：weight=0 → 全部 base；weight=10000 → 全部 canary（不是"差不多"，是精确边界）',
  offLanes.size === 1 && offLanes.has('base') && allLanes.size === 1 && allLanes.has('canary'),
  `0 → ${JSON.stringify([...offLanes])}；10000 → ${JSON.stringify([...allLanes])}`)
await off.fiber.dispose(); await all.fiber.dispose()

// --- 4. 进入 canary 的批准纪律 ---
let noApproval = null
try { a.box.handle.enterCanary({ proposal_id: 'p-1' }) } catch (err) { noApproval = String(err.message) }
check('负控：进入 canary 没有人工 approval_ref 必须被拒（它会影响真实流量）',
  String(noApproval).includes('canary-needs-approval'), `error=${String(noApproval).slice(0, 80)}`)
const entered = a.box.handle.enterCanary({ proposal_id: 'p-1', approval_ref: 'ap-0007' })
let twice = null
try { a.box.handle.enterCanary({ proposal_id: 'p-1', approval_ref: 'ap-0007' }) } catch (err) { twice = String(err.message) }
check('负控：重复进入 canary 必须被拒（不得叠加分流）',
  entered.phase === 'canary' && String(twice).includes('canary-already-active'), `twice=${String(twice).slice(0, 60)}`)

// --- 5. 样本不足不得给结论 ---
const insufficient = a.box.handle.decide()
check('样本不足 → insufficient（不得在样本不足时给结论）',
  insufficient.action === 'hold' && insufficient.verdict.recommendation === 'insufficient',
  `${insufficient.verdict.recommendation}：${insufficient.verdict.reasons[0]}`)

// --- 6. 退化 → 自动回滚 ---
const b = await mount({ weight_bps: 5000, min_samples: 5 })
b.box.handle.enterCanary({ proposal_id: 'p-2', approval_ref: 'ap-0008' })
for (let i = 0; i < 10; i++) b.box.handle.record({ lane: 'base', ok: true, latency_ms: 100, cost: 10 })
for (let i = 0; i < 10; i++) b.box.handle.record({ lane: 'canary', ok: i < 3 ? false : true, latency_ms: 100, cost: 10 })
const degraded = b.box.handle.decide()
check('退化 → 自动回滚：recommendation=rollback，automatic=true，**不要求**人工批准（安全动作越自动越好）',
  degraded.action === 'rollback' && degraded.automatic === true && degraded.approval_required === false
  && degraded.verdict.reasons.length >= 1,
  `action=${degraded.action} automatic=${degraded.automatic} reasons=${JSON.stringify(degraded.verdict.reasons).slice(0, 90)}`)

// --- 7. 更优 → 建议晋升但需人工 ---
const c = await mount({ weight_bps: 5000, min_samples: 5 })
c.box.handle.enterCanary({ proposal_id: 'p-3', approval_ref: 'ap-0009' })
for (let i = 0; i < 10; i++) c.box.handle.record({ lane: 'base', ok: true, latency_ms: 200, cost: 10 })
for (let i = 0; i < 10; i++) c.box.handle.record({ lane: 'canary', ok: true, latency_ms: 120, cost: 10 })
const better = c.box.handle.decide()
check('更优 → 建议晋升但 **approval_required=true**（机器人不得自行扩大自己的上线面）',
  better.action === 'promote' && better.automatic === false && better.approval_required === true,
  `action=${better.action} approval_required=${better.approval_required}`)

// --- 8. 只有 base 退化时不得回滚 canary ---
const d = await mount({ weight_bps: 5000, min_samples: 5 })
d.box.handle.enterCanary({ proposal_id: 'p-4', approval_ref: 'ap-0010' })
for (let i = 0; i < 10; i++) d.box.handle.record({ lane: 'base', ok: i < 4 ? false : true, latency_ms: 500, cost: 50 })
for (let i = 0; i < 10; i++) d.box.handle.record({ lane: 'canary', ok: true, latency_ms: 100, cost: 10 })
const baseOnly = d.box.handle.decide()
check('负控：只有 base 退化时不得回滚 canary（不得把 base 的问题算到 canary 头上）',
  baseOnly.action !== 'rollback' && baseOnly.verdict.recommendation === 'promote',
  `action=${baseOnly.action} reasons=${JSON.stringify(baseOnly.verdict.reasons).slice(0, 70)}`)

// --- 9. 退出 canary 不需要批准 ---
const exited = b.box.handle.exitCanary({ reason: 'auto-rollback:error-rate' })
let notActive = null
try { b.box.handle.exitCanary({ reason: 'again' }) } catch (err) { notActive = String(err.message) }
check('退出 canary 不需要人工引用（安全动作）；未进入时退出必须报错（不得静默 no-op）',
  exited.phase === 'base' && exited.samples_seen >= 20 && String(notActive).includes('canary-not-active'),
  `退出 samples_seen=${exited.samples_seen}；二次退出=${String(notActive).slice(0, 50)}`)

// --- 10. 环形窗口有界 ---
const e = await mount({ weight_bps: 5000, window: 5 })
for (let i = 0; i < 50; i++) e.box.handle.record({ lane: 'base', ok: true, latency_ms: 10, cost: 1 })
const bounded = e.box.handle.stats()
check('环形窗口有界：超出 window 丢最旧（内存不随样本数无限增长）',
  bounded.base.count === 5, `count=${bounded.base.count}（window=5，投递 50 条）`)

for (const item of [a, c, d, e, scoped]) await item.fiber.dispose()
console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] canary: ${failures} 项未通过`)
} else {
  console.error(`[PASS] canary（${facts.checks.length} 条断言，含自动回滚方向性负控）`)
}
process.exit(failures ? 1 : 0)
