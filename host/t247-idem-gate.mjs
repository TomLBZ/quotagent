/**
 * `idempotency-guard` 中间件的**围栏门**：每条正控都配一条负控，红/绿都由真跑决定。
 *
 * 为什么门在 `host/` 而不在 `tmp/`：产物是"可写面"内的东西（晋升后进 `host/modules/`），门必须由
 * **被围对象之外**的一侧维护（ADR-0016 的可写面纪律）——门不能由被围的产物自己写。
 *
 * 覆盖（10 条，含 5 条负控）：
 *   ① 正控：首次请求判 `fresh`（放行），且**可解释**（reason + next_action + 与内核同形的 sha256 键）
 *   ② 负控：同一请求第二次 `begin`（仍在途）→ `duplicate-inflight`，**绝不是 fresh**
 *   ③ 正控：`finish(ok)` 后同一请求 → `duplicate-done` 且**复用 result_digest**（不重放副作用）
 *   ④ 负控：`finish(ok=false)` 后 → **不是** `duplicate-done`（失败不得被复用成成功），而是 `replay` 并说明原因
 *   ⑤ 负控：`window_max` 越硬上界被**夹住**（99→上界），且运行时条目数不超上界（有界）
 *   ⑥ 负控：未知/畸形 params（undefined / 循环引用 / BigInt / Symbol / getter 抛错 / 非对象 method）
 *      一律**不崩**，且每条都给 decision + reason + next_action
 *   ⑦ 正控：`keyOf` 稳定 —— 键序无关、同输入同键、值或方法不同即不同键（无时间/随机参与）
 *   ⑧ 正控：注入假时钟跑同一序列两次 → 判定与统计**字节一致**（窗口/TTL 判定不依赖真实时间）
 *   ⑨ 负控：静态扫描产物源码 —— 无定时器、无事件订阅、无文件写入
 *   ⑩ 正控：完成态超出复用窗口（注入时钟前进）→ 判 `replay` 而不是静默 `fresh`
 *
 * 产物定位（踩过的坑，写清楚免得下一个人再踩）：
 *   晋升前产物在 `tmp/t247-idem.mjs`（相对本文件即 `./../tmp/t247-idem.mjs`），晋升后在 `./modules/idempotency-guard.mjs`。
 *   产物按契约 `import ... from '../lib/std-schema.mjs'`；从 `tmp/` 看 `../lib` = **仓库根**的 `lib/`，而它并不存在
 *   （实测：直接 import tmp 产物 → `ERR_MODULE_NOT_FOUND .../lib/std-schema.mjs`）。
 *   所以这里用仓库既有做法（`tools/evolve-module.mjs` 的影子目录）：在 `tmp/` 下建一个影子目录，
 *   把 `host/lib` 软链进去 + 产物**按字节复制**进去，再 import 影子里的那一份（并断言复制字节一致）。
 *   影子只落在 gitignored 的 `tmp/` 里；仓库里其它文件一个字不动，也不在仓库外写文件。
 *
 * 输出：一行 JSON `{"checks":[{"name","ok","detail"}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 */
import { Context, EventsService } from 'cordis'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IN_TREE = join(HERE, 'modules', 'idempotency-guard.mjs')      // 晋升后的位置
const FROM_TMP = join(ROOT, 'tmp', 't247-idem.mjs')                 // ← './../tmp/t247-idem.mjs'
const SHADOW = join(ROOT, 'tmp', 't247-idem-gate-shadow')

const checks = []
let failures = 0
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 定位并加载产物：晋升前从 tmp/（经影子目录），晋升后直接是同目录的 modules/。 */
const loadArtifact = async () => {
  if (existsSync(IN_TREE)) {
    const source = readFileSync(IN_TREE, 'utf8')
    return { mod: await import(pathToFileURL(IN_TREE).href), source, path: IN_TREE, identical: true }
  }
  if (!existsSync(FROM_TMP)) {
    console.error(`[FAIL] 找不到产物：${relative(ROOT, IN_TREE)} 与 ${relative(ROOT, FROM_TMP)} 都不存在`)
    process.exit(2)
  }
  mkdirSync(join(SHADOW, 'modules'), { recursive: true })
  const libLink = join(SHADOW, 'lib')
  if (!existsSync(libLink)) symlinkSync(join(ROOT, 'host', 'lib'), libLink, 'dir')
  const copyPath = join(SHADOW, 'modules', 'idempotency-guard.mjs')
  copyFileSync(FROM_TMP, copyPath)
  const source = readFileSync(FROM_TMP, 'utf8')
  const identical = readFileSync(copyPath, 'utf8') === source
  return { mod: await import(pathToFileURL(copyPath).href), source, path: FROM_TMP, identical }
}

const artifact = await loadArtifact()
const { apply: idemApply, Config: idemConfig, fixture: idemFixture } = artifact.mod
const artifactLabel = `${relative(ROOT, artifact.path)} sha256:${sha256(artifact.source).slice(0, 12)}…`

const fibers = []
/** 挂载：用包装 provide 抓句柄（provided service 只能在插件自己的 ctx 里取），并注入假时钟。 */
const mount = async (conf = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const fiber = await ctx.plugin({
    name: 'idempotency-guard#probe', inject: [], Config: idemConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if (service === 'idempotency') box.handle = value
        return original(service, value)
      }
      await idemApply(inner, cfg)
    },
  }, idemConfig.parse(conf))
  let now = 0
  box.handle.setClock(() => now)
  box.advance = (ms) => { now += ms }
  box.fiber = fiber
  fibers.push(fiber)
  return { ctx, box, fiber }
}

const main = async () => {
  // --- ① 首次判 fresh：放行且可解释；键与内核去重键同形 ---
  const a = await mount({ window_ms: 1000, inflight_ttl_ms: 500, window_max: 8, window_max_limit: 8 })
  const request = { method: 'quote/submit', params: { rfq_rev: 'r1', amount: 120, currency: 'CNY' } }
  const first = a.box.handle.begin(request)
  check('正控①：首次请求判 fresh（放行）且**可解释**（reason + next_action + 同形 sha256 键）',
    first.decision === 'fresh' && first.allowed === true && first.replay === false
    && Boolean(first.reason) && Boolean(first.next_action)
    && /^quote\/submit\|\|sha256:[0-9a-f]{64}$/.test(first.key),
    `产物=${artifactLabel} decision=${first.decision} reason=${first.reason} key=${first.key.slice(0, 26)}…`)

  // --- ② 同一请求第二次 begin（在途）→ duplicate-inflight（负控：不许再给 fresh） ---
  const second = a.box.handle.begin(request)
  check('负控①：同一请求第二次 begin（仍在途）→ **duplicate-inflight**，绝不是 fresh，且给出 next_action',
    second.decision === 'duplicate-inflight' && second.decision !== 'fresh' && second.allowed === false
    && Boolean(second.reason) && Boolean(second.next_action) && second.key === first.key,
    `decision=${second.decision} reason=${second.reason}`)

  // --- ③ finish(ok) 后同一请求 → duplicate-done + 复用 result_digest ---
  const digest = 'sha256:' + 'a'.repeat(64)
  const finished = a.box.handle.finish({ ...request, ok: true, result_digest: digest })
  const third = a.box.handle.begin(request)
  check('正控②：finish(ok) 后同一请求 → duplicate-done 且**复用 result_digest**（供复用，不是重放副作用）',
    finished.recorded === true && finished.state === 'done' && finished.result_digest === digest
    && third.decision === 'duplicate-done' && third.reusable === true && third.result_digest === digest,
    `finish=${finished.state} decision=${third.decision} digest 一致=${third.result_digest === digest}`)

  // --- ④ 失败不得被复用成成功（负控） ---
  const failing = { method: 'quote/submit', params: { rfq_rev: 'r2', amount: 120, currency: 'CNY' } }
  a.box.handle.begin(failing)
  const failedFinish = a.box.handle.finish({ ...failing, ok: false, result_digest: digest })
  const retry = a.box.handle.begin(failing)
  check('负控②：finish(ok=false) 后 → **不是** duplicate-done（失败不得被复用成成功），而是 replay 并说明原因',
    failedFinish.result_digest === null && retry.decision === 'replay' && retry.decision !== 'duplicate-done'
    && retry.allowed === true && Boolean(retry.reason) && Boolean(retry.next_action),
    `decision=${retry.decision} reason=${retry.reason} 失败态 digest=${String(failedFinish.result_digest)}`)

  // --- ⑤ 有界：window_max 越硬上界被夹住 + 运行时条目数不超上界（负控） ---
  const bounded = await mount({ window_max: 99, window_max_limit: 4, replay_memory: 9999, replay_memory_limit: 8 })
  const boundedConfig = bounded.box.handle.config()
  for (let index = 0; index < 12; index += 1) {
    bounded.box.handle.begin({ method: 'ledger/append', params: { seq: index } })
  }
  const boundedStats = bounded.box.handle.stats()
  check('负控③：窗口容量越硬上界被**夹住**（99→4），且运行时条目数不超上界（有界，不随运行时长增长）',
    boundedConfig.window_max === 4 && boundedConfig.replay_memory === 8
    && boundedStats.entries === 4 && boundedStats.evicted === 8,
    `config.window_max=${boundedConfig.window_max}（传 99） replay_memory=${boundedConfig.replay_memory}（传 9999） entries=${boundedStats.entries} evicted=${boundedStats.evicted}`)

  // --- ⑥ 畸形/未知入参不崩（负控） ---
  const risky = await mount({})
  const cyclic = {}; cyclic.self = cyclic
  const cyclicMethod = {}; cyclicMethod.me = cyclicMethod
  const badGetter = {}
  Object.defineProperty(badGetter, 'boom', { enumerable: true, get() { throw new Error('getter-boom') } })
  const shapes = [
    {}, null, undefined, 123, 'quote/submit', Symbol('s'),
    { method: 'quote/submit', params: undefined },
    { method: 'quote/submit', params: 10n },                     // BigInt 直接做 params（走标量分支）
    { method: 'quote/submit', params: Symbol('top') },
    { method: 'quote/submit', params: new Date(NaN) },
    { method: 'quote/submit', params: badGetter },
    { method: 'quote/submit', params: () => 1 },
    { params: cyclic },
    { method: 'quote/submit', params: { big: 10n, sym: Symbol('x'), fn: () => 1, map: new Map([['b', 2], ['a', 1]]), set: new Set([2, 1]) } },
    { method: cyclicMethod, params: { a: 1 } },
    { method: 'quote/submit', params: [1, undefined, NaN, Infinity, -0] },
  ]
  const outcomes = []
  for (const shape of shapes) {
    try {
      const decision = risky.box.handle.begin(shape)
      const keyOf = risky.box.handle.keyOf(shape)
      const peeked = risky.box.handle.peek(shape)
      outcomes.push({ ok: Boolean(decision) && typeof decision.decision === 'string' && Boolean(decision.reason)
        && Boolean(decision.next_action) && typeof decision.key === 'string'
        && typeof keyOf === 'string' && typeof peeked.key === 'string' })
    } catch (err) {
      outcomes.push({ ok: false, error: `${err?.code ?? err?.name}: ${String(err?.message).slice(0, 60)}` })
    }
  }
  const crashed = outcomes.filter((item) => item.ok !== true)
  // 畸形入参也不许"两份不同的坏参数算出同一把键"（那会被误判成同一请求）
  const badKeyA = risky.box.handle.keyOf({ method: 'quote/submit', params: cyclic })
  const badKeyB = risky.box.handle.keyOf({ method: 'quote/submit', params: badGetter })
  check('负控④：未知/畸形 params（循环引用 / BigInt / Symbol / 抛错 getter / 非对象 method / 非对象输入）一律**不崩**，都有 decision + reason，且不同的坏参数不撞同一把键',
    crashed.length === 0 && outcomes.length === shapes.length && badKeyA !== badKeyB,
    `样本 ${outcomes.length} 个，异常 ${crashed.length} 个；坏参数不撞键=${badKeyA !== badKeyB}${crashed.length ? `：${JSON.stringify(crashed.slice(0, 2))}` : ''}`)

  // --- ⑦ keyOf 稳定性（正控） ---
  const keyA = risky.box.handle.keyOf({ method: 'quote/submit', params: { b: 2, a: [1, { y: 2, x: 1 }] } })
  const keyB = risky.box.handle.keyOf({ params: { a: [1, { x: 1, y: 2 }], b: 2 }, method: 'quote/submit' })
  const keyC = risky.box.handle.keyOf({ method: 'quote/submit', params: { b: 2, a: [1, { y: 3, x: 1 }] } })
  const keyD = risky.box.handle.keyOf({ method: 'quote/award', params: { b: 2, a: [1, { y: 2, x: 1 }] } })
  check('正控③：keyOf 稳定 —— 键序无关、同输入同键、值或方法不同即不同键（无时间/随机参与）',
    keyA === keyB && keyA !== keyC && keyA !== keyD && keyA.includes('sha256:')
    && keyA === risky.box.handle.keyOf({ method: 'quote/submit', params: { b: 2, a: [1, { y: 2, x: 1 }] } }),
    `键序无关=${keyA === keyB} 值敏感=${keyA !== keyC} 方法敏感=${keyA !== keyD}`)

  // --- ⑧ 假时钟下同序列两次字节一致（正控） ---
  const sequence = async () => {
    const m = await mount({ window_ms: 100, inflight_ttl_ms: 50, window_max: 2, window_max_limit: 2 })
    const log = []
    const req = { method: 'quote/submit', params: { rfq_rev: 'r9', amount: 88 } }
    log.push(m.box.handle.begin(req))
    m.box.advance(20)
    log.push(m.box.handle.begin(req))
    log.push(m.box.handle.finish({ ...req, ok: true, result_digest: 'sha256:' + 'b'.repeat(64) }))
    m.box.advance(10)
    log.push(m.box.handle.begin(req))
    m.box.advance(200)
    log.push(m.box.handle.begin(req))
    log.push(m.box.handle.stats())
    return JSON.stringify(log)
  }
  const firstRun = await sequence()
  const secondRun = await sequence()
  check('正控④：注入假时钟跑同一序列两次 → 判定与统计**字节一致**（窗口/TTL 判定不依赖真实时间）',
    firstRun === secondRun && firstRun.length > 200, `len=${firstRun.length} equal=${firstRun === secondRun}`)

  // --- ⑨ 静态扫描：无定时器 / 无事件订阅 / 无文件写入（负控） ---
  const needles = ['setTimeout(', 'setInterval(', 'setImmediate(', 'ctx.on(', 'ctx.events',
    'writeFile', 'appendFile', 'createWriteStream', 'ledger']
  const hits = needles.filter((needle) => artifact.source.includes(needle))
  check('负控⑤：静态扫描产物 —— 不注册定时器、不订阅事件、不写文件（窗口/TTL 全用注入时钟判断）',
    hits.length === 0, hits.length ? `命中 ${JSON.stringify(hits)}` : `扫描 ${needles.length} 个字样，无命中`)

  // --- ⑩ 出窗口 → replay 而不是静默 fresh（正控） ---
  const aging = await mount({ window_ms: 100, inflight_ttl_ms: 500, window_max: 8, window_max_limit: 8 })
  const aged = { method: 'po/issue', params: { po_id: 'PO-1', revision: 1 } }
  aging.box.handle.begin(aged)
  aging.box.handle.finish({ ...aged, ok: true, result_digest: 'sha256:' + 'c'.repeat(64) })
  aging.box.advance(101)
  const afterWindow = aging.box.handle.begin(aged)
  check('正控⑤：完成态超出复用窗口（注入时钟前进 101ms）→ 判 **replay** 而不是静默 fresh（重复意图必须被认出来）',
    afterWindow.decision === 'replay' && afterWindow.decision !== 'fresh' && afterWindow.allowed === true
    && afterWindow.replay === true && Boolean(afterWindow.next_action),
    `decision=${afterWindow.decision} reason=${afterWindow.reason}`)

  // --- 附带证据（不占断言名额）：产物导入路径与影子字节一致 ---
  if (!artifact.identical) check('产物来源：影子副本与源文件字节一致', false, '影子副本与源文件不一致')
  if (typeof idemFixture?.sample === 'function') {
    const sampleOne = JSON.stringify(idemFixture.sample(a.box.handle))
    const sampleTwo = JSON.stringify(idemFixture.sample(a.box.handle))
    if (sampleOne !== sampleTwo || sampleOne.length <= 10) {
      check('fixture.sample 是纯读取（两次采样字节一致）', false, `len=${sampleOne.length}`)
    }
  }
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

const passed = checks.length - failures
console.log(JSON.stringify({ checks, passed, total: checks.length, failures }))
if (failures) {
  console.error(`[FAIL] idempotency-guard 围栏门：${failures}/${checks.length} 条未通过`)
} else {
  console.error(`[PASS] idempotency-guard 围栏门（${passed}/${checks.length}：fresh/在途/完成态复用/失败不复用/有界/畸形入参/键稳定/确定性/静态扫描/出窗口）`)
}
process.exit(failures ? 1 : 0)
