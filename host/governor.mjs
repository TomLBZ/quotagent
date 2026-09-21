/**
 * governor 中间件的检查（`tools/verify.sh governor`）：准入、超时、有界重试，每条给正控 + 负控。
 *
 * 覆盖：
 *   1. 准入：额度足够 → 放行并扣减；额度耗尽 → **拒绝且给出 reason + retry_after_ms**（不是裸 false）
 *   2. 归还：release 幂等且不超容量（多还不会凭空造额度）
 *   3. 背压：额度耗尽时 run() 抛出 `backpressure`（不是静默排队、不是静默成功）
 *   4. 超时：`timeout` 是**显式错误**（不许静默重试到成功），且超时后额度被归还（不会永久泄漏）
 *   5. 有界重试：配置里超过硬上界 → 直接拒绝（不许无界重试）；上界内重试次数可观测
 *   6. 重试成功路径：第一次超时、第二次成功 → `attempts=2` 且最终 ok
 *   7. 业务错误（非超时）在重试用尽后**原样抛出**（不被包装成成功）
 *   8. 确定性：用假时钟跑同一序列两次 → 统计字节一致（判定不依赖真实时间）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { apply as governorApply, Config as governorConfig } from './modules/governor.mjs'

const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const mount = async (conf = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const fiber = await ctx.plugin({
    name: 'governor#probe', inject: [], Config: governorConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'governor') box.handle = value; return original(service, value) }
      await governorApply(inner, cfg)
    },
  }, governorConfig.parse(conf))
  // 假时钟 + 即时 sleep：让"超时/重试"的判定不需要真的等
  const sleepCalls = []
  box.handle.setClock(() => 0, (ms, resolve) => { sleepCalls.push(ms); resolve() })
  box.sleepCalls = sleepCalls
  return { ctx, box, fiber }
}

// --- 1. 准入与拒绝的可解释性 ---
const a = await mount({ capacity: 2, key: 'k1' })
const ok1 = a.box.handle.admit({ key: 'k1' })
const ok2 = a.box.handle.admit({ key: 'k1' })
const refused = a.box.handle.admit({ key: 'k1' })
check('准入正控：额度足够时放行并扣减（remaining 递减）',
  ok1.admitted && ok2.admitted && ok2.remaining === 0 && ok1.remaining === 1,
  `ok1.remaining=${ok1.remaining} ok2.remaining=${ok2.remaining}`)
check('准入负控：额度耗尽时**拒绝且可解释**（reason + retry_after_ms + next_action）',
  refused.admitted === false && refused.reason === 'credit-exhausted'
  && typeof refused.retry_after_ms === 'number' && Boolean(refused.next_action),
  `reason=${refused.reason} retry_after_ms=${refused.retry_after_ms}`)

// --- 2. 归还幂等且不超容量 ---
const r1 = a.box.handle.release({ key: 'k1' })
const r2 = a.box.handle.release({ key: 'k1' })
const r3 = a.box.handle.release({ key: 'k1' })
check('归还负控：release 幂等且**不超容量**（多还不会凭空造额度）',
  r1.remaining === 1 && r2.remaining === 2 && r3.remaining === 2,
  `remaining 序列=${[r1.remaining, r2.remaining, r3.remaining].join('→')}`)

// --- 3. 背压：run() 遇额度耗尽必须抛，不许静默 ---
const b = await mount({ capacity: 1, key: 'k2' })
// 注意：成功的 run() 会**归还**额度，所以必须先用 admit 直接占住额度再 run（实测踩到：不占住就测不到背压）
b.box.handle.admit({ key: 'k2' })
let backpressure = null
try { await b.box.handle.run({ key: 'k2', fn: async () => 'never' }) } catch (err) { backpressure = err }
check('背压负控：额度耗尽时 run() 抛 `backpressure`（不是静默排队，也不是静默成功）',
  backpressure?.code === 'backpressure' && backpressure.detail.reason === 'credit-exhausted',
  `code=${backpressure?.code} detail=${JSON.stringify(backpressure?.detail?.reason)}`)

// --- 4/6. 超时是显式错误；重试成功路径 ---
const c = await mount({ capacity: 4, key: 'k3', max_retries: 0, timeout_ms: 5, retry_backoff_ms: 7 })
let timeoutErr = null
try {
  await c.box.handle.run({ key: 'k3', fn: () => new Promise(() => {}) })   // 永不 resolve
} catch (err) { timeoutErr = err }
const afterTimeout = c.box.handle.stats().buckets.k3
check('超时正控：超时是**显式错误**（code=timeout），且超时后额度被归还（不永久泄漏）',
  timeoutErr?.code === 'timeout' && afterTimeout === 4 && c.box.handle.stats().timeouts >= 1,
  `code=${timeoutErr?.code} 归还后额度=${afterTimeout}`)

const d = await mount({ capacity: 4, key: 'k4', max_retries: 2, timeout_ms: 1, retry_backoff_ms: 3 })
let calls = 0
const flaky = async () => {
  calls += 1
  if (calls === 1) return new Promise(() => {})   // 第一次超时
  return 'served-on-retry'
}
const retried = await d.box.handle.run({ key: 'k4', fn: flaky })
check('重试正控：第一次超时、第二次成功 → attempts=2 且最终 ok；重试间隔走配置（确定性，无随机退避）',
  retried.ok === true && retried.attempts === 2 && retried.result === 'served-on-retry'
  && d.box.sleepCalls.length === 1 && d.box.sleepCalls[0] === 3,
  `attempts=${retried.attempts} sleep=${JSON.stringify(d.box.sleepCalls)}`)

// --- 5. 有界重试 ---
let unbounded = null
try { await d.box.handle.run({ key: 'k4', fn: async () => 'x', retries: 99 }) } catch (err) { unbounded = err }
check('有界重试负控：请求重试次数超过硬上界 → **直接拒绝**（不许无界重试）',
  unbounded?.code === 'retry-limit-exceeded', `code=${unbounded?.code}`)

// --- 7. 业务错误重试用尽后原样抛出 ---
const e = await mount({ capacity: 4, key: 'k5', max_retries: 1, retry_backoff_ms: 1 })
let bizErr = null
try {
  await e.box.handle.run({ key: 'k5', fn: async () => { throw new Error('business-failure') } })
} catch (err) { bizErr = err }
check('负控：业务错误在重试用尽后**原样抛出**（不得被包装成成功，也不得无限重试）',
  String(bizErr?.message).includes('business-failure') && e.box.handle.stats().retries === 1,
  `error=${String(bizErr?.message).slice(0, 40)} retries=${e.box.handle.stats().retries}`)

// --- 8. 确定性 ---
const sequence = async () => {
  const f = await mount({ capacity: 2, key: 'k6', max_retries: 1, retry_backoff_ms: 2, timeout_ms: 1 })
  const out = []
  out.push(f.box.handle.admit({ key: 'k6' }).admitted)
  out.push(f.box.handle.admit({ key: 'k6' }).admitted)
  out.push(f.box.handle.admit({ key: 'k6' }).admitted)
  try { await f.box.handle.run({ key: 'k6', fn: () => new Promise(() => {}) }) } catch (err) { out.push(err.code) }
  out.push(f.box.handle.stats().buckets.k6)
  await f.fiber.dispose()
  return out
}
const s1 = await sequence()
const s2 = await sequence()
check('确定性：同一序列跑两次统计与结果一致（假时钟；判定不依赖真实时间）',
  JSON.stringify(s1) === JSON.stringify(s2), `${JSON.stringify(s1)}`)

for (const item of [a, b, c, d, e]) await item.fiber.dispose()
console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] governor: ${failures} 项未通过`)
} else {
  console.error(`[PASS] governor（${facts.checks.length} 条断言：准入/背压/超时/有界重试）`)
}
process.exit(failures ? 1 : 0)
