/**
 * breaker 中间件的检查（`tools/verify.sh breaker`）：每条正控 + 负控。
 *
 * 说明：产物 `host/modules/circuit-breaker.mjs` 是**自进化产出**的（可写面只有 `host/modules/`），
 * 本门是宿主侧**人工维护的围栏** —— 门不能由被围的对象自己写（ADR-0016 的可写面纪律）。
 *
 * 覆盖：
 *   1. 初始 closed：放行，且拒绝/放行都可解释（不返回裸 false）
 *   2. 阈值：连续失败达 `failure_threshold` → 打开，并给出 `reason` + `retry_after_ms`
 *   3. 打开期间**快速失败**（不再打下游），冷却未到不放行
 *   4. 冷却到 → half-open，只放**有限次**试探（硬上界内）
 *   5. 试探成功 → 合上，连续失败计数清零
 *   6. 试探失败 → **立刻重新打开**且冷却重新计时（不许"半开"变事实全开）
 *   7. 半开额度用尽 → 拒绝并解释（`half-open-budget-exhausted`）
 *   8. 有界：`half_open_max` 超过硬上界时被夹住（配置也不许无界）
 *   9. 分桶隔离：一个 key 打开不影响另一个 key
 *  10. 确定性：注入假时钟跑同一序列两次 → 判定与统计字节一致（不依赖真实时间）
 *  11. 零残留：不订阅事件/不注册定时器/不写文件（静态扫描）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { readFileSync } from 'node:fs'
import { apply as breakerApply, Config as breakerConfig } from './modules/circuit-breaker.mjs'

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
    name: 'circuit-breaker#probe', inject: [], Config: breakerConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'breaker') box.handle = value; return original(service, value) }
      await breakerApply(inner, cfg)
    },
  }, breakerConfig.parse(conf))
  let now = 0
  box.handle.setClock(() => now)
  box.advance = (ms) => { now += ms }
  box.fiber = fiber
  return { ctx, box, fiber }
}

// --- 1. 初始状态与可解释性 ---
const a = await mount({ failure_threshold: 3, cooldown_ms: 1000, key: 'k1' })
const first = a.box.handle.allow({ key: 'k1' })
check('初始正控：closed 时放行，且返回值带 state（不返回裸 true/false）',
  first.allowed === true && first.state === 'closed' && typeof first.retry_after_ms === 'number',
  `allowed=${first.allowed} state=${first.state}`)

// --- 2. 阈值打开 ---
a.box.handle.record({ key: 'k1', ok: false })
a.box.handle.record({ key: 'k1', ok: false })
const beforeThreshold = a.box.handle.allow({ key: 'k1' })
const tripped = a.box.handle.record({ key: 'k1', ok: false })
check('阈值正控：连续失败达阈值 → 打开，并给出 reason=threshold-reached',
  beforeThreshold.allowed === true && tripped.state === 'open' && tripped.reason === 'threshold-reached',
  `第 3 次失败后 state=${tripped.state} reason=${tripped.reason}`)

// --- 3. 打开期间快速失败 + 可解释拒绝 ---
const refused = a.box.handle.allow({ key: 'k1' })
check('打开负控：**快速失败**（不放行）且可解释（reason/retry_after_ms/next_action 齐备）',
  refused.allowed === false && refused.state === 'open' && refused.reason === 'circuit-open'
  && refused.retry_after_ms === 1000 && Boolean(refused.next_action),
  `allowed=${refused.allowed} reason=${refused.reason} retry_after_ms=${refused.retry_after_ms}`)

// --- 4. 冷却 → half-open，有限试探 ---
a.box.advance(1000)
const probe1 = a.box.handle.allow({ key: 'k1' })
const probe2 = a.box.handle.allow({ key: 'k1' })   // half_open_max 默认 1 → 第二次应被拒
check('半开正控：冷却到点进入 half-open，只放**有限次**试探（额度用尽即拒且解释）',
  probe1.allowed === true && probe1.state === 'half-open' && probe1.probe === true
  && probe2.allowed === false && probe2.reason === 'half-open-budget-exhausted',
  `probe1=${probe1.state}/${probe1.allowed} probe2=${probe2.state}/${probe2.reason}`)

// --- 5/6. 试探失败 → 立刻重开；试探成功 → 合上 ---
const reOpened = a.box.handle.record({ key: 'k1', ok: false })
check('半开负控：试探失败 → **立刻重新打开**并重置冷却起点（不许"半开"变事实全开）',
  reOpened.state === 'open' && reOpened.reason === 'probe-failed' && a.box.handle.allow({ key: 'k1' }).allowed === false,
  `state=${reOpened.state} reason=${reOpened.reason}`)
a.box.advance(1000)
a.box.handle.allow({ key: 'k1' })                   // 取一次试探额度
const closed = a.box.handle.record({ key: 'k1', ok: true })
check('恢复正控：试探成功 → 合上，且连续失败计数清零（不会一次抖动又打开）',
  closed.state === 'closed' && closed.consecutive_failures === 0
  && a.box.handle.state({ key: 'k1' }).state === 'closed',
  `state=${closed.state} failures=${closed.consecutive_failures}`)

// --- 7. 分桶隔离 ---
a.box.handle.record({ key: 'k2', ok: false })
check('分桶正控：一个 key 打开不牵连另一个 key（k2 仍放行）',
  a.box.handle.allow({ key: 'k2' }).allowed === true && a.box.handle.state({ key: 'k2' }).state === 'closed',
  `k2 state=${a.box.handle.state({ key: 'k2' }).state}`)

// --- 8. 有界：半开额度被硬上界夹住 ---
const b = await mount({ failure_threshold: 1, cooldown_ms: 10, half_open_max: 99, half_open_limit: 3 })
const bcfg = b.box.handle.config()
check('有界负控：`half_open_max` 超过硬上界时被**夹到上限**（配置也不许无界）',
  bcfg.half_open_max === 3, `half_open_max=${bcfg.half_open_max}（配置传 99）`)

// --- 9. 确定性：假时钟下同序列两次一致 ---
const runSequence = async () => {
  const m = await mount({ failure_threshold: 2, cooldown_ms: 500, key: 'det' })
  const log = []
  for (const step of [['allow'], ['fail'], ['fail'], ['allow'], ['advance', 500], ['allow'], ['ok'], ['allow']]) {
    if (step[0] === 'allow') log.push(m.box.handle.allow({ key: 'det' }))
    if (step[0] === 'fail') log.push(m.box.handle.record({ key: 'det', ok: false }))
    if (step[0] === 'ok') log.push(m.box.handle.record({ key: 'det', ok: true }))
    if (step[0] === 'advance') m.box.advance(step[1])
  }
  return JSON.stringify({ log, stats: m.box.handle.stats() })
}
const det1 = await runSequence()
const det2 = await runSequence()
check('确定性正控：注入假时钟跑同一序列两次 → 判定与统计**字节一致**（判定不依赖真实时间）',
  det1 === det2 && det1.length > 100, `len=${det1.length} equal=${det1 === det2}`)

// --- 10. 零残留：静态扫描 + 不订阅事件 ---
// 静态扫描必须跟到**实体**（本批 `EV-177` 起 `host/modules/<stem>.mjs` 可能是**薄重导**：实体在
// `src/<层>/<插件>/code/`；读转发文件会让"零写面 / 零定时器 / 不订阅事件"这类断言在 8 行重导上**静默判绿**）。
const moduleSource = (relative) => {
  let current = new URL(relative, import.meta.url)
  let text = readFileSync(current, 'utf8')
  for (let hop = 0; hop < 8; hop += 1) {
    const match = text.match(/^\s*export \* from '([^']+)'/m)
    if (!match) break
    current = new URL(match[1], current)
    text = readFileSync(current, 'utf8')
  }
  return text
}
const src = moduleSource('./modules/circuit-breaker.mjs')
const forbidden = ['ctx.on(', 'ctx.events.on(', 'setInterval(', 'setTimeout(', 'writeFile', 'appendFile']
  .filter((needle) => src.includes(needle))
check('零残留负控：模块不订阅事件/不注册定时器/不写文件（冷却用注入时钟判断）',
  forbidden.length === 0, `forbidden=${forbidden.join(',') || '无'}`)

await a.fiber.dispose(); await b.fiber.dispose()
console.log(JSON.stringify({ ...facts, passed: facts.checks.length - failures, total: facts.checks.length, failures }, null, 2))
process.exit(failures === 0 ? 0 : 1)
