/**
 * `budget-guard` 中间件的**围栏门**（T-250）：每条正控都配负控，红/绿由真跑决定。
 *
 * 为什么门在 `host/` 而不在 `tmp/`：产物是"可写面"内的东西（晋升后进 `host/modules/`），门必须由
 * **被围对象之外**的一侧维护（ADR-0016 的可写面纪律）—— 门不能由被围的产物自己写。
 *
 * 覆盖（10 条，含 6 条负控）：
 *   ① 正控：调用-成本序列逐字段等于**手算值**（总花费 / 剩余 / 拒绝点；算式见下）
 *   ② 负控：超预算被拒**且可解释**（reason + next_action + window_reset_in_ms，不是裸 false），
 *           且"等窗口有用（budget-exceeded）"与"等也没用（cost-exceeds-budget）"是两种不同拒绝
 *   ③ 负控：窗口到期后额度**真的恢复** —— 用假时钟推进 1ms，**不真等**（并报真实耗时）
 *   ④ 负控：key 数越硬上界被**夹取**（99→4），**任何时刻** keys ≤ 上界；窗口过期后桶被自动回收
 *   ⑤ 负控：配置负控 —— 未知键 / 未知 mode / NaN·Infinity 数值一律响地拒掉（不许静默退回默认）
 *   ⑥ 负控：畸形 cost（NaN/Infinity/负数/字符串/undefined/对象）与非对象入参**不崩、不放行、不留痕**；
 *           亚 µ 成本**不白送**（0.4µ 记 1µ，向上取整）
 *   ⑦ 正控：`estimate` 是纯函数式整数换算（1500 token × 3/Mtok = 4500µ = 0.004500），畸形输入给原因不抛错
 *   ⑧ 正控：注入假时钟跑同一序列两次 → 输出**字节一致**（窗口判定不依赖真实时间）
 *   ⑨ 负控：静态扫描产物 —— 不注册定时器 / 不订阅事件 / 不写文件；墙钟**只**出现在可被 `setClock`
 *           整体替换的默认时钟里（下面所有用例都是替换成假时钟之后跑的）
 *   ⑩ 正控：`fixture.sample` 纯读取（两次采样字节一致）＋ 单桶记录条数被夹取且**金额守恒**
 *
 * 手算基线（①③，sliding / window_ms=1000 / budget=5000µ = 0.005 单位）：
 *   charge(k1, 1500) → 1500 ≤ 5000                          → 放行，spent=1500，remaining=3500
 *   charge(k1, 2500) → 1500+2500=4000 ≤ 5000                → 放行，spent=4000，remaining=1000
 *   charge(k1, 1500) → 4000+1500=5500 > 5000（差 500）      → 拒：reason=budget-exceeded，spent 仍 4000
 *                      两条记录都在 t=0 写下、在 t=1000 过期；要腾出的 500µ 由最早那条（1500µ）一次就够
 *                      → window_reset_in_ms = (0 + 1000) - 0 = 1000
 *   推进 999ms → now - at = 999 < 1000 仍在窗口内 → 仍拒，且 reset 只剩 1ms
 *   推进到 1000ms → now - at = 1000 ≥ 1000 出窗口（占用区间是 (now-1000, now]）→ 额度**整块回来**：
 *                  spent 由 4000 归 0，再 charge(1500) → 放行，spent=1500
 *   charge(k2, 6000) → 6000 > 5000（**单次**就超过整个窗口预算）→ 拒：reason=cost-exceeds-budget，
 *                      等到什么时候都不行（窗口滚动不会让一笔 6000 装进 5000），且这一笔不建桶、spent 仍 0
 *
 * 产物定位（踩过的坑，写清楚免得下一个人再踩）：
 *   晋升前产物在 `tmp/t250-budget.mjs`（相对本文件即 `./../tmp/t250-budget.mjs`），晋升后在
 *   `./modules/budget-guard.mjs`。产物按契约 `import ... from '../lib/std-schema.mjs'`；从 `tmp/` 看
 *   `../lib` = **仓库根**的 `lib/`，而它并不存在（实测：直接 import tmp 产物 →
 *   `ERR_MODULE_NOT_FOUND .../lib/std-schema.mjs`）。所以这里用仓库既有做法（`tools/evolve-module.mjs`
 *   的影子目录）：在 `tmp/` 下建影子目录 `tmp/t250-budget-shadow/`，把 `host/lib` 软链进去、产物**按字节
 *   复制**到 `<影子>/modules/`，再 import 影子里的那一份（并断言复制字节一致）。影子只落在 gitignored 的
 *   `tmp/` 里，仓库里其它文件一个字不动，也不在仓库外写文件。
 *   同一个影子目录直接喂给官方 fixture：`node host/check-modules.mjs --module budget-guard
 *   --module-dir tmp/t250-budget-shadow/modules`。
 *
 * 变异测试钩子：`T250_ARTIFACT=<path>` 覆盖产物来源（指向 /tmp 沙盒里的单点变异副本，逐个确认门会变红）；
 * 不设该变量时行为如上（影子 / 晋升后的真身）。
 *
 * 输出：一行 JSON `{"checks":[{"name","ok","detail"}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * `stderr` 另打印一行 `[artifact]`：**实际加载路径 + 源路径 + 字节数 + sha256**。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 实现已搬进 `src/<层>/<插件>/tests/`（迁移阶段 4.2 / EV-172）：宿主目录由仓库根推出（`src/<层>/<插件>/tests/` 4 层上溯），
// 旧位置 `host/` 留**薄转发**；本文件其余逻辑与搬迁前逐行相同（`join(HERE, '..')` 仍是仓库根）。
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'host')
// 宿主内核解析（搬迁后本文件不在 `host/` 下）：裸名 `cordis` 从**宿主目录**解析 —— 与搬迁前 Node 上溯到
// `host/node_modules/` 的那一份**同一个文件**（`cordis` 的 `main`/`exports` 都指向 `lib/index.js`）。
const CORDIS_URL = process.env.QUOTAGENT_CORDIS
  ? pathToFileURL(process.env.QUOTAGENT_CORDIS).href
  : pathToFileURL(join(HERE, 'node_modules', 'cordis', 'lib', 'index.js')).href
const { Context, EventsService } = await import(CORDIS_URL)
const ROOT = join(HERE, '..')
const IN_TREE = join(HERE, 'modules', 'budget-guard.mjs')            // 晋升后的位置
const FROM_TMP = join(ROOT, 'tmp', 't250-budget.mjs')                // ← './../tmp/t250-budget.mjs'
const SHADOW = join(ROOT, 'tmp', 't250-budget-shadow')               // 影子目录（gitignored）
const OVERRIDE = process.env.T250_ARTIFACT || null                   // 变异测试：指向沙盒里的变异产物

const checks = []
let failures = 0
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 定位并加载产物：覆盖变量 → 晋升后的真身 → tmp 产物（经影子目录，按字节复制）。 */
const loadArtifact = async () => {
  if (OVERRIDE) {
    if (!existsSync(OVERRIDE)) {
      console.error(`[FAIL] T250_ARTIFACT 指向的文件不存在：${OVERRIDE}`)
      process.exit(2)
    }
    const source = readFileSync(OVERRIDE, 'utf8')
    return { mod: await import(pathToFileURL(OVERRIDE).href), source, source_path: OVERRIDE,
      loaded_path: OVERRIDE, identical: true, why: 'T250_ARTIFACT 覆盖（变异测试沙盒）' }
  }
  if (existsSync(IN_TREE)) {
    const source = readFileSync(IN_TREE, 'utf8')
    return { mod: await import(pathToFileURL(IN_TREE).href), source, source_path: IN_TREE,
      loaded_path: IN_TREE, identical: true, why: '已晋升：直接加载真身' }
  }
  if (!existsSync(FROM_TMP)) {
    console.error(`[FAIL] 找不到产物：${relative(ROOT, IN_TREE)} 与 ${relative(ROOT, FROM_TMP)} 都不存在`)
    process.exit(2)
  }
  mkdirSync(join(SHADOW, 'modules'), { recursive: true })
  const libLink = join(SHADOW, 'lib')
  if (!existsSync(libLink)) symlinkSync(join(ROOT, 'host', 'lib'), libLink, 'dir')   // 影子里的 ../lib
  const copyPath = join(SHADOW, 'modules', 'budget-guard.mjs')
  copyFileSync(FROM_TMP, copyPath)                                                   // 按字节复制
  const source = readFileSync(FROM_TMP, 'utf8')
  const identical = readFileSync(copyPath, 'utf8') === source
  return { mod: await import(pathToFileURL(copyPath).href), source, source_path: FROM_TMP,
    loaded_path: copyPath, identical, why: '晋升前：影子目录 tmp/t250-budget-shadow 里的按字节副本' }
}

const artifact = await loadArtifact()
const { apply: budgetApply, Config: budgetConfig, fixture: budgetFixture } = artifact.mod
const HEX = sha256(artifact.source)
console.error(`[artifact] 加载路径=${artifact.loaded_path} 源路径=${artifact.source_path} ` +
  `字节=${Buffer.byteLength(artifact.source)} sha256=${HEX} 影子副本字节一致=${artifact.identical}（${artifact.why}）`)

const fibers = []
/** 挂载：包装 provide 抓句柄（provided service 只能在插件自己的 ctx 里取），随后注入假时钟。 */
const mount = async (conf = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const fiber = await ctx.plugin({
    name: 'budget-guard#probe', inject: [...mod.inject], Config: budgetConfig,
    apply: async (inner, cfg) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if (service === 'budgetGuard') box.handle = value
        return originalProvide(service, value)
      }
      await budgetApply(inner, cfg)
    },
  }, budgetConfig.parse(conf))
  let now = 0
  box.handle.setClock(() => now)          // 窗口判定全走假时钟 → 不真等、可复现
  box.advance = (ms) => { now += ms }
  box.fiber = fiber
  fibers.push(fiber)
  return { ctx, box, fiber }
}

const mod = artifact.mod
const main = async () => {
  // --- ① 正控：手算值逐字段比对（算式见文件头） ---
  const a = await mount({ window_ms: 1000, budget: 5000 })
  const first = a.box.handle.charge({ key: 'k1', cost: 1500 })
  const second = a.box.handle.charge({ key: 'k1', cost: 2500 })
  const third = a.box.handle.charge({ key: 'k1', cost: 1500 })
  check('正控①：调用-成本序列逐字段等于**手算值**（1500 → 4000 → 4000+1500>5000 拒），拒绝点落在 4000+1500=5500 上',
    first.admitted === true && first.cost_micro === 1500 && first.spent === 1500 && first.remaining === 3500
    && second.admitted === true && second.spent === 4000 && second.remaining === 1000
    && third.admitted === false && third.cost_micro === 1500 && third.spent === 4000 && third.remaining === 1000
    && third.over_by === 500,
    `加载=${relative(ROOT, artifact.loaded_path)} sha256=${HEX}；` +
    `手算 remaining：5000-1500=${first.remaining}、5000-4000=${second.remaining}；` +
    `第 3 笔 4000+1500=5500>5000 差 ${third.over_by} → admitted=${third.admitted} spent=${third.spent}`)

  // --- ② 负控：拒绝必须可解释，且两种拒绝不许混为一谈 ---
  const oversized = a.box.handle.charge({ key: 'k2', cost: 6000 })
  const explained = (item) => Boolean(item) && typeof item === 'object' && item.admitted === false
    && typeof item.reason === 'string' && item.reason.length > 0
    && typeof item.next_action === 'string' && item.next_action.length > 0
    && typeof item.window_reset_in_ms === 'number' && typeof item.spent === 'number'
  check('负控①：超预算被拒**且可解释**（reason + next_action + window_reset_in_ms，不是裸 false），"等窗口有用"与"等也没用"分开报',
    explained(third) && third.reason === 'budget-exceeded' && third.window_reset_in_ms === 1000
    && /窗口/.test(third.next_action)
    && explained(oversized) && oversized.reason === 'cost-exceeds-budget'
    && oversized.reason !== third.reason && /不行/.test(oversized.next_action)
    && oversized.spent === 0 && oversized.present === false,
    `budget-exceeded（reset=${third.window_reset_in_ms}ms、next_action 说"约 1000ms 后额度会腾出来"）` +
    `vs cost-exceeds-budget（单次 6000 > 整窗预算 5000，reset=${oversized.window_reset_in_ms}ms、next_action 说"等也不行"，` +
    `且**没有**建桶 present=${oversized.present} spent=${oversized.spent}）`)

  // --- ③ 负控：窗口到期额度真的回来（假时钟推进，不真等） ---
  a.box.advance(999)                                   // now - at = 999 < 1000 → 仍在窗口内
  const almost = a.box.handle.charge({ key: 'k1', cost: 1500 })
  const startedAt = process.hrtime.bigint()
  a.box.advance(1)                                     // now = 1000，t=0 的两条记录出窗口（占用区间 (now-1000, now]）
  const recovered = a.box.handle.charge({ key: 'k1', cost: 1500 })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  check('负控②：窗口到期后额度**真的恢复**（假时钟推进 1ms 而不是真等）：999ms 仍拒、1000ms 放行且 spent 归位到 1500',
    almost.admitted === false && almost.spent === 4000 && almost.window_reset_in_ms === 1
    && recovered.admitted === true && recovered.spent === 1500 && recovered.remaining === 3500
    && elapsedMs < 1000,
    `t=999 拒（spent=${almost.spent}，还差 ${almost.window_reset_in_ms}ms 到期）→ t=1000 放行` +
    `（spent=${recovered.spent}：1500+2500 已腾空、只剩这一笔 1500）；真实耗时 ${elapsedMs.toFixed(3)}ms（没有真等 1000ms）`)

  // --- ④ 负控：key 数夹取 + 任何时刻都有界 + 窗口过期自动回收 ---
  const bounded = await mount({ window_ms: 100, budget: 1000000, max_keys: 99, max_keys_limit: 4 })
  const boundedConfig = bounded.box.handle.config()
  for (let index = 0; index < 12; index += 1) bounded.box.handle.charge({ key: `k${index}`, cost: 1 })
  const boundedStats = bounded.box.handle.stats()
  bounded.box.advance(100)                             // 全部出窗口
  bounded.box.handle.charge({ key: 'late', cost: 1 })
  const sweptStats = bounded.box.handle.stats()
  check('负控③：key 数越硬上界被**夹取**（99→4）且**任何时刻** keys ≤ 上界（12 个 key 只留 4 个、淘汰 8）；窗口过期后桶被自动回收',
    boundedConfig.max_keys === 4 && boundedConfig.max_keys_limit === 4
    && boundedStats.keys === 4 && boundedStats.evicted === 8
    && sweptStats.reclaimed >= 4 && sweptStats.keys <= 4,
    `config.max_keys=${boundedConfig.max_keys}（传 99，上界 4）；12 次 charge 后 keys=${boundedStats.keys} evicted=${boundedStats.evicted}；` +
    `推进 100ms 后再 charge → reclaimed=${sweptStats.reclaimed} keys=${sweptStats.keys}（不随运行时长增长）`)

  // --- ⑤ 负控：配置负控（未知键 / 未知 mode / NaN·Infinity） ---
  const mountError = async (conf) => {
    try { await mount(conf); return { accepted: true, note: 'accepted' } }
    catch (err) { return { accepted: false, note: `${String(err?.code ?? err?.name ?? 'error')}: ${String(err?.message ?? '').slice(0, 52)}` } }
  }
  const confCases = [{ mystery_key: 1 }, { mode: 'rolling' }, { budget: NaN }, { max_keys: NaN }, { window_ms: Infinity }, { price_per_mtok: -1 }]
  const confOutcomes = []
  for (const conf of confCases) {
    const outcome = await mountError(conf)
    confOutcomes.push(`${Object.keys(conf)[0]}=${String(Object.values(conf)[0])} → ${outcome.note}`)
  }
  check('负控④：配置负控 —— 未知键 / 未知 mode / NaN·Infinity 数值 全部**响地拒掉**（不得静默退回默认值、不得静默变成无界）',
    confOutcomes.every((item) => !item.includes('→ accepted')) && confCases.length === confOutcomes.length,
    confOutcomes.join(' | '))

  // --- ⑥ 负控：畸形 cost / 入参不崩、不放行、不留痕；亚 µ 不白送 ---
  const risky = await mount({ window_ms: 1000, budget: 5000 })
  risky.box.handle.charge({ key: 'k1', cost: 1500 })
  const money = () => JSON.stringify({
    peek: risky.box.handle.peek({ key: 'k1' }),
    keys: risky.box.handle.stats().keys,
    charged: risky.box.handle.stats().charged,
    admitted: risky.box.handle.stats().admitted,
  })
  const before = money()
  const badCosts = [NaN, Infinity, -Infinity, -1, '5', undefined, null, {}, [], true]
  const badArgs = [null, undefined, 'x', 5, { key: 42, cost: 5 }, { key: '', cost: 5 }]
  const outcomes = []
  let crashed = 0
  for (const cost of badCosts) {
    try { outcomes.push(risky.box.handle.charge({ key: 'k1', cost })) } catch { crashed += 1 }
  }
  for (const arg of badArgs) {
    try { outcomes.push(risky.box.handle.charge(arg)) } catch { crashed += 1 }
  }
  const after = money()
  const reasons = [...new Set(outcomes.map((item) => item?.reason))].sort()
  const subMicro = risky.box.handle.charge({ key: 'k1', cost: 0.4 })     // 0.4µ 不许"白送"：向上取整成 1µ
  check('负控⑤：畸形 cost（NaN/Infinity/负数/字符串/undefined/对象）与非对象入参**不崩、不放行、不留痕**；亚 µ 成本**不白送**（0.4µ 记 1µ）',
    crashed === 0 && outcomes.length === badCosts.length + badArgs.length
    && outcomes.every((item) => item && item.admitted === false && typeof item.reason === 'string' && item.reason.length > 0
      && typeof item.next_action === 'string' && item.next_action.length > 0)
    && before === after
    && subMicro.admitted === true && subMicro.cost_micro === 1 && subMicro.spent === 1501,
    `畸形样本 ${outcomes.length} 个（异常 ${crashed} 个）全部 admitted=false 且有 reason+next_action：${JSON.stringify(reasons)}；` +
    `花费/桶数/计数**一个都没动**=${before === after}；0.4µ → cost_micro=${subMicro.cost_micro}（向上取整不白送）spent=${subMicro.spent}`)

  // --- ⑦ 正控：estimate 纯函数式整数换算 ---
  const est = await mount({ window_ms: 1000, budget: 5000, price_per_mtok: 0.5 })
  const peekBefore = JSON.stringify(est.box.handle.peek({ key: 'k9' }))
  const one = est.box.handle.estimate({ tokens: 1500, price_per_mtok: 3 })
  const oneAgain = est.box.handle.estimate({ tokens: 1500, price_per_mtok: 3 })
  const byDefault = est.box.handle.estimate({ tokens: 1500 })            // 用 config 单价 0.5 → 750µ
  const zero = est.box.handle.estimate({ tokens: 0 })
  const bad = [est.box.handle.estimate({ tokens: 'x' }), est.box.handle.estimate({ tokens: NaN, price_per_mtok: 3 }),
    est.box.handle.estimate({ tokens: 10, price_per_mtok: 'x' }), est.box.handle.estimate(undefined),
    est.box.handle.estimate(null), est.box.handle.estimate({})]
  const peekAfter = JSON.stringify(est.box.handle.peek({ key: 'k9' }))
  check('正控②：`estimate` 是**纯函数式整数换算**（1500 token × 3/Mtok = 4500µ = 0.004500），畸形输入给 reason 不抛错，且不动任何状态',
    one.ok === true && one.cost_micro === 4500 && one.cost_text === '0.004500'
    && JSON.stringify(one) === JSON.stringify(oneAgain)
    && byDefault.cost_micro === 750 && zero.cost_micro === 0
    && bad.every((item) => item.ok === false && typeof item.reason === 'string' && typeof item.next_action === 'string')
    && peekBefore === peekAfter,
    `推算：1 token 的钱 = 3/1e6 单位 = 3µ → 1500×3 = ${one.cost_micro}µ（${one.cost_text} 单位）；` +
    `缺省单价 0.5 → ${byDefault.cost_micro}µ；0 token → ${zero.cost_micro}µ；畸形 ${bad.length} 个全部 ok=false 不抛错；` +
    `估算前后 peek 字节一致=${peekBefore === peekAfter}（纯函数，不记账）`)

  // --- ⑧ 正控：假时钟下同序列两次字节一致 ---
  const sequence = async () => {
    const run = await mount({ window_ms: 100, budget: 500, max_keys: 2, max_keys_limit: 2 })
    const log = []
    log.push(run.box.handle.charge({ key: 'a', cost: 100.4 }))      // 向上取整 101
    log.push(run.box.handle.charge({ key: 'a', cost: 200 }))        // 301
    log.push(run.box.handle.charge({ key: 'a', cost: 1 }))          // 302
    log.push(run.box.handle.charge({ key: 'b', cost: 501 }))        // 单次 > 500 → 拒
    run.box.advance(50)
    log.push(run.box.handle.charge({ key: 'c', cost: 50 }))
    run.box.advance(50)                                             // t=100：a 的两笔出窗口
    log.push(run.box.handle.charge({ key: 'a', cost: 150 }))
    log.push(run.box.handle.charge({ key: 'd', cost: 1 }))          // 触发"最久未触碰"淘汰
    log.push(run.box.handle.peek({ key: 'a' }))
    log.push(run.box.handle.stats())
    log.push(run.box.handle.estimate({ tokens: 1234, price_per_mtok: 2 }))
    return JSON.stringify(log)
  }
  const runOne = await sequence()
  const runTwo = await sequence()
  check('正控③：注入假时钟跑同一序列两次 → 输出**字节一致**（窗口判定/回收/淘汰都不依赖真实时间，无墙钟、无随机）',
    runOne === runTwo && runOne.length > 300, `len=${runOne.length} equal=${runOne === runTwo}`)

  // --- ⑨ 负控：静态扫描产物 + manifest 自检 ---
  const needles = ['setInterval(', 'setTimeout(', 'setImmediate(', 'ctx.on(', 'ctx.events', 'writeFile',
    'appendFile', 'createWriteStream', 'node:fs', 'require(', 'ledger']
  const hits = needles.filter((needle) => artifact.source.includes(needle))
  const clockUses = artifact.source.split('Date.now(').length - 1
  const clockLine = artifact.source.split('\n').find((line) => line.includes('Date.now(')) ?? ''
  const clockReplaceable = /^\s*const defaultClock = \(\) => Date\.now\(\)\s*$/.test(clockLine)
    && artifact.source.includes('setClock') && artifact.source.includes('clock = typeof impl === \'function\' ? impl : defaultClock')
  const manifestOk = mod.name === 'budget-guard' && Array.isArray(mod.inject) && mod.inject.length === 0
    && Array.isArray(mod.builtin) && mod.builtin.length === 0
    && Array.isArray(mod.usedServices) && mod.usedServices.length === 0
    && Array.isArray(mod.provides) && mod.provides.includes('budgetGuard')
    && typeof mod.apply === 'function' && typeof mod.fixture?.sample === 'function'
    && typeof mod.Config?.['~standard']?.validate === 'function'
  check('负控⑥：产物静态自检 —— 不注册定时器、不订阅事件、不写文件（禁字 0 命中）；墙钟**只**出现在可被 setClock 替换的默认时钟；manifest 与契约一致',
    hits.length === 0 && clockUses === 1 && clockReplaceable && manifestOk,
    (hits.length ? `命中 ${JSON.stringify(hits)}` : `扫描 ${needles.length} 个禁字：0 命中`) +
    `；'Date.now(' 出现 ${clockUses} 次，该行=${clockReplaceable
      ? 'const defaultClock = () => Date.now()（默认时钟，setClock() 可整体替换 —— 本门所有窗口用例都是替换成假时钟后跑的）'
      : `不符合默认时钟形状：${clockLine.trim()}`}` +
    `；manifest name=${mod.name} inject=${JSON.stringify(mod.inject)} provides=${JSON.stringify(mod.provides)} ` +
    `builtin=${JSON.stringify(mod.builtin)} usedServices=${JSON.stringify(mod.usedServices)}）` +
    `；加载=${relative(ROOT, artifact.loaded_path)} sha256=${HEX}`)

  // --- ⑩ 正控：fixture.sample 纯读取 + 单桶记录有界且金额守恒 ---
  const sampleOne = JSON.stringify(budgetFixture.sample(a.box.handle))
  const sampleTwo = JSON.stringify(budgetFixture.sample(a.box.handle))
  const records = await mount({ window_ms: 10000, budget: 1000000, max_records: 99, max_records_limit: 8 })
  for (let index = 0; index < 30; index += 1) records.box.handle.charge({ key: 'a', cost: 1 })
  const recordsConfig = records.box.handle.config()
  const recordsPeek = records.box.handle.peek({ key: 'a' })
  const recordsStats = records.box.handle.stats()
  check('正控④：`fixture.sample` 纯读取（两次采样字节一致）＋ 单桶记录条数被夹取且**金额守恒**（30 笔合并后仍恰好 30µ）',
    sampleOne === sampleTwo && sampleOne.length > 10
    && recordsConfig.max_records === 8 && recordsConfig.max_records_limit === 8
    && recordsPeek.records === 8 && recordsPeek.spent === 30
    && recordsStats.charged === 30 && recordsStats.coalesced === 22,
    `fixture.sample 两次字节一致=${sampleOne === sampleTwo}（len=${sampleOne.length}）；` +
    `max_records 传 99 → ${recordsConfig.max_records}（上界 8）；30 笔 1µ 之后 records=${recordsPeek.records} ` +
    `spent=${recordsPeek.spent}（合并只动时间戳、金额守恒）coalesced=${recordsStats.coalesced}`)
}

try {
  await main()
} catch (err) {
  check('围栏门自身未抛错（检查逻辑不得把门跑崩）', false,
    `error=${err?.code ?? err?.name}: ${String(err?.message).slice(0, 140)}`)
} finally {
  for (const fiber of fibers) {
    try { await fiber.dispose() } catch { /* 卸载失败不影响判定：门只报断言 */ }
  }
}

// 空集合守卫（教训同 `verify.sh p0-no-node`）：断言跑少/跑漏必须红，不许被当成全绿
const EXPECTED = 10
if (checks.length !== EXPECTED) {
  check(`空集合守卫：本门应有 ${EXPECTED} 条断言（跑少/跑漏一律算红）`, false, `实际 ${checks.length} 条：${JSON.stringify(checks.map((item) => item.name.slice(0, 6)))}`)
}

const passed = checks.length - failures
console.log(JSON.stringify({ checks, passed, total: checks.length, failures }))
if (failures) {
  console.error(`[FAIL] budget-guard 围栏门：${failures}/${checks.length} 条未通过`)
} else {
  console.error(`[PASS] budget-guard 围栏门（${passed}/${checks.length}：手算准入/拒绝可解释/窗口恢复/有界夹取/配置负控/畸形入参/估算纯函数/确定性/静态自检/采样纯读取）`)
}
process.exit(failures ? 1 : 0)
