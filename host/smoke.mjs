/**
 * cordis 宿主冒烟测试（`tools/verify.sh cordis`）。
 *
 * 目的：证明我们**直接依赖**的 cordis（钉在 host/package.json）本身就提供了 P0 手写过的那套语义，
 * 并把"真实约定"钉死下来（这些约定来自读 cordis 4.0.0-rc.10 的源码，不是猜的）：
 *   - 事件五模式：emit / parallel / serial / bail / waterfall（对应 AC-EVT-001）
 *     · emit     —— 全部调用，忽略返回值
 *     · parallel —— allSettled 后若有失败则抛 AggregateError（全部跑完才抛）
 *     · serial   —— 顺序 await，遇到第一个"非 null/false/undefined"的值即返回（短路）
 *     · bail     —— 同步同上
 *     · waterfall—— 监听器签名为 `(...args, next)`；值传递靠**可变载荷**（同一条链共享同一个
 *                    args 数组），**`next()` 不接受参数**（源码：`next = () => dispatch()`）；
 *                    不调 next() 即短路、该监听器的返回值即最终值；next() 调两次抛错；
 *                    终结回调（最后一个参数）**无参调用**（`inner()`），载荷靠闭包/可变对象
 *                    （对应 AC-EVT-002；注意与我们 P0 Python 版 `next(work)` 的差异）
 *   - 插件 effect/disposer 与"卸载无残留"（对应 AC-PLUGIN-001 / INV-002）：
 *     cordis 把 `ctx.events.on()` 的订阅也登记为该 fiber 的 effect（`register()` 内部包了
 *     `fiber.effect()`），所以 `getEffects()` 至少为 2（订阅 + 我们自己的 effect）。
 *   - 重新装载得到新 fiber（uid 递增，不迁移旧状态）（对应 AC-PLUGIN-002）
 * 全部断言为真时退出码 0，并把关键事实以 JSON 打到 stdout（供证据留存）。
 */
import { Context, EventsService, FiberState, RegistryService } from 'cordis'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const facts = { cordis_version: require_('cordis/package.json').version, node: process.version, checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const ctx = new Context()
await ctx.plugin(EventsService)
await ctx.plugin(RegistryService)

// --- 1. 五模式原生存在 -------------------------------------------------------
check('cordis 原生提供 5 个事件模式',
  ['emit', 'parallel', 'serial', 'bail', 'waterfall'].every((m) => typeof ctx.events[m] === 'function'),
  ['emit', 'parallel', 'serial', 'bail', 'waterfall'].map((m) => `${m}:${typeof ctx.events[m]}`).join(' '))

// --- 2. 插件：订阅 + effect（注册可回退）------------------------------------
const seen = []
let released = 0
const plugin = {
  name: 'probe',
  apply(c) {
    c.events.on('quote/submitted', (payload) => seen.push(payload))
    c.fiber.effect(() => () => { released += 1 })
  },
}
const first = await ctx.plugin(plugin)
check('插件装载后 fiber 为 ACTIVE', first.state === FiberState.ACTIVE, `state=${first.state} uid=${first.uid}`)

ctx.events.emit('quote/submitted', { quote_id: 'q-1' })
check('emit 送达监听器', seen.length === 1 && seen[0].quote_id === 'q-1', `seen=${JSON.stringify(seen)}`)
const effectsBefore = first.getEffects()
check('订阅与 effect 都被登记为该 fiber 的 effect（订阅自动可回退）',
  effectsBefore.length >= 2, `effects=${effectsBefore.length}`)

// --- 3. 卸载：订阅与 effect 都回收（无残留）---------------------------------
const firstUid = first.uid
await first.dispose()
check('卸载后 fiber 为 DISPOSED', first.state === FiberState.DISPOSED, `state=${first.state}`)
check('卸载后 effect 已释放', released === 1, `released=${released}`)
check('卸载后 effect 列表清空（无残留）', first.getEffects().length === 0,
  `effects=${first.getEffects().length}`)
ctx.events.emit('quote/submitted', { quote_id: 'q-2' })
check('卸载后不再收到事件（无残留订阅）', seen.length === 1, `seen=${seen.length}`)

// --- 4. 重新装载：新 fiber（uid 递增）---------------------------------------
const second = await ctx.plugin(plugin)
check('重新装载得到新 fiber（uid 递增，不迁移旧状态）',
  second.uid !== firstUid && second.state === FiberState.ACTIVE,
  `first=${firstUid} second=${second.uid}`)
await second.dispose()

// --- 5. 五模式语义抽样 -------------------------------------------------------
ctx.events.on('probe/emit', () => 'ignored')
check('emit 忽略返回值', ctx.events.emit('probe/emit') === undefined)

ctx.events.on('probe/bail', () => false)
ctx.events.on('probe/bail', () => undefined)
ctx.events.on('probe/bail', () => 'first-truthy')
ctx.events.on('probe/bail', () => 'never')
check('bail：跳过 false/undefined，首个其它值胜出', ctx.events.bail('probe/bail') === 'first-truthy')

ctx.events.on('probe/serial', () => undefined)
ctx.events.on('probe/serial', async () => 'serial-answer')
ctx.events.on('probe/serial', () => 'never')
check('serial：顺序执行，遇首个非空值即返回', (await ctx.events.serial('probe/serial')) === 'serial-answer')

ctx.events.on('probe/parallel', async () => 1)
ctx.events.on('probe/parallel', async () => 2)
let parallelOk = true
try { await ctx.events.parallel('probe/parallel') } catch { parallelOk = false }
check('parallel：全部成功时正常返回（返回值为 void）', parallelOk)

ctx.events.on('probe/parallel-fail', async () => { throw new Error('boom') })
ctx.events.on('probe/parallel-fail', async () => 'still-runs')
let aggregated = false
try { await ctx.events.parallel('probe/parallel-fail') } catch (err) { aggregated = err instanceof AggregateError }
check('parallel：有失败时全部跑完并聚合抛错（AggregateError）', aggregated)

const wfState = { value: 'x' }
const wfRan = []
ctx.events.on('probe/waterfall', (state, next) => { wfRan.push(1); state.value += '-a'; return next() })
ctx.events.on('probe/waterfall', (state) => { wfRan.push(2); state.value += '-sc'; return state.value })
ctx.events.on('probe/waterfall', (state, next) => { wfRan.push(3); state.value += '-never'; return next() })
const wfResult = ctx.events.waterfall('probe/waterfall', wfState, (state) => `final:${state.value}`)
check('waterfall：可变载荷共享 + 不调 next() 即短路（下游不执行，返回值即最终值）',
  wfResult === 'x-a-sc' && wfRan.join(',') === '1,2',
  `result=${JSON.stringify(wfResult)} ran=[${wfRan.join(',')}]`)

const emptyPayload = { value: 'z' }
const wfNoTerminal = ctx.events.waterfall('probe/waterfall-empty', emptyPayload, () => `only:${emptyPayload.value}`)
check('waterfall：无监听器时调用终结回调（**终结回调不接受参数**，载荷靠闭包）',
  wfNoTerminal === 'only:z', `result=${wfNoTerminal}`)

let doubleNext = false
const once = ctx.events.on('probe/waterfall2', (value, next) => { next(value); return next(value) })
try { ctx.events.waterfall('probe/waterfall2', 'y', (v) => v) } catch { doubleNext = true }
once()
check('waterfall：next() 调两次抛错（防止同一链被重复推进）', doubleNext)

check('宿主事件模式与 P0 语义一致（AC-EVT-001/002 的替换基础）', failures === 0,
  `failures=${failures}`)

console.log(JSON.stringify(facts, null, 2))
process.exit(failures === 0 ? 0 : 1)
