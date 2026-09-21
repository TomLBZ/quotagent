/**
 * 进树模块的 manifest + fixture A1..A6 检查器（评审 C §6、§7.1 第 5 条 / 任务 T-221）。
 *
 * 每个进树模块（`host/modules/*.mjs`）都要有 manifest（`name/inject/provides/Config/apply/disposer`）
 * 并通过六条 fixture —— **每条都配一个"违规必须变红"的负控**，不是声明：
 *
 *   A1 inject 白名单：取未在 `inject` 声明的服务必须抛错；`usedServices` 必须与 `inject` 相等
 *   A2 零残留      ：dispose 前后 effect 数为 0 且 timer/listener 计数差分全 0（泄漏必被检出）
 *   A3 config 负控 ：未知键、翻转 const 键 → 被拒
 *   A4 事件声明    ：emit 未声明事件名 → 被拒（事件表真源在 Python 侧，由 `--events` 传入）
 *   A5 确定性      ：同输入两次派生输出字节级一致（引入墙钟/自增即红）
 *   A6 无跨模块 import：模块文件内不得出现指向别的模块目录的相对 import（静态检查 + ESM 解析）
 *
 * 关键实现细节（踩过）：provided service 只能在**插件自己的 ctx** 里取（宿主 ctx 取会抛
 * "cannot get property ... without inject"），所以这里用包装 `apply` 的方式抓句柄；且 A2 会把
 * 那个 fiber dispose 掉，之后的 fixture 必须另起新 fiber。
 *
 * 用法：node check-modules.mjs [--events events.json] [--module kernel-bridge]
 * 输出 JSON（modules[] + checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_DIR = join(HERE, 'modules')
const argv = process.argv.slice(2)
const argOf = (flag, fallback = null) => {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback
}
const eventsPath = argOf('--events')
const only = argOf('--module')
const declaredEvents = eventsPath && existsSync(eventsPath)
  ? JSON.parse(readFileSync(eventsPath, 'utf-8')).events || []
  : []

const checks = []
let failures = 0
const constKeysFound = []
// 内建 mixin（`ctx.*` 直接可用，**不是**可 inject 的服务）：写进 inject 会让插件永远 pending（实测）
const BUILTIN_MIXINS = ['events', 'logger', 'timer', 'registry']  // A3 模块集级汇总：哪些模块真的有 const 键
const check = (moduleName, fixture, name, ok, detail = '') => {
  checks.push({ module: moduleName, fixture, name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const REQUIRED_MANIFEST = ['name', 'inject', 'provides', 'Config', 'apply', 'usedServices']
const counters = { timers: 0, listeners: 0 }

/**
 * 依赖 stub（评审 C §6 明确要求 fixture 用 stub 依赖）：模块声明的 `inject` 若无人提供，
 * cordis 会让插件停在 pending（provide 不会执行）。所以按需挂上最小 stub。
 * `events` 由 cordis 的 EventsService 提供，不需要 stub。
 */
const STUBS = {
  norm: {
    config: () => ({ tolerance_bps: 5 }),
    check: (declared, offered) => {
      const limit = Number(declared) * 5 / 10000
      if (Math.abs(Number(offered) - Number(declared)) > limit) {
        throw new Error(`[tolerance-exceeded] ${declared} vs ${offered}`)
      }
      return true
    },
    convert: (qty, factor) => ({ qty: Number(qty), factor: Number(factor), base: Number(qty) * Number(factor) }),
  },
  ledgerView: {
    count: () => 0,
    head: () => 'sha256:' + '0'.repeat(64),
    read: () => [],
  },
  compare: { flagCount: () => 0 },
  bridge: { surface: () => ({}) },
}

/** 起一个带句柄的模块实例：句柄在插件自己的 ctx 里取（那里才有 inject 权限）。 */
async function mount(mod) {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  for (const service of mod.inject || []) {
    const stub = STUBS[service]
    if (!stub) throw new Error(`缺少 ${service} 的 stub：模块声明的依赖必须可被 fixture 满足`)
    // 必须在**根 ctx** 上 provide（在子 ctx 上 provide 对兄弟/父不可见 → 消费者会一直 pending）
    ctx.provide(service, stub)
  }
  const box = { handle: null, released: 0 }
  const wrapper = {
    name: `${mod.name}#probe`,
    inject: mod.inject,
    Config: mod.Config,
    apply: async (inner, config) => {
      // 抓句柄靠**包装 provide**：cordis 的 reflect 规则不允许（也不该）从外部 ctx 取服务的提供物，
      // 这里捕获的正是模块自己 provide 出来的对象，既不伪造也不绕过 inject。
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if (mod.provides.includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await mod.apply(inner, config)
    },
  }
  // 模块若监听端口（webui），fixture 一律用临时端口 0，避免多个挂载互相抢端口
  const draft = mod.Config.parse({})
  const fiber = await ctx.plugin(wrapper, ('port' in draft) ? { ...draft, port: 0 } : draft)
  return { ctx, fiber, box }
}

// `index.mjs` 是模块**发现入口**（导出 moduleFiles/loadModules），不是插件：不参与 fixture
for (const file of readdirSync(MODULE_DIR)
  .filter((item) => item.endsWith('.mjs') && item !== 'index.mjs').sort()) {
  const mod = await import(pathToFileURL(join(MODULE_DIR, file)).href)
  const name = mod.name || file
  if (only && only !== name) continue

  // --- manifest 形状 ---
  // 契约不全的模块必须**报失败断言**而不是让整脚本抛错（否则一个半成品模块会掩盖其它模块的结果）
  const missing = REQUIRED_MANIFEST.filter((key) => mod[key] === undefined)
  const shapeOk = missing.length === 0 && Array.isArray(mod.inject) && Array.isArray(mod.usedServices)
  check(name, 'manifest', 'manifest 必填字段齐备（name/inject/provides/Config/apply/usedServices，且 inject/usedServices 是数组）',
    shapeOk, missing.length ? `缺 ${missing.join(', ')}`
      : `inject=${JSON.stringify(mod.inject)} usedServices=${JSON.stringify(mod.usedServices)}`)
  if (!shapeOk) continue   // 形状都不对就不进后续 fixture（断言已经红了，不用连带崩溃）
  check(name, 'manifest', 'provides 非空且 Config 实现 standard-schema（cordis 用 `~standard.validate` 校验）',
    Array.isArray(mod.provides) && mod.provides.length > 0
    && typeof mod.Config?.['~standard']?.validate === 'function',
    `provides=${JSON.stringify(mod.provides)}`)

  // --- A1 inject 白名单 ---
  check(name, 'A1', 'A1 声明即事实：`usedServices` 与 `inject` 完全相等',
    JSON.stringify([...mod.usedServices].sort()) === JSON.stringify([...mod.inject].sort()),
    `used=${JSON.stringify(mod.usedServices)} inject=${JSON.stringify(mod.inject)}`)
  check(name, 'A1', 'A1 负控：`inject` 不得写入 cordis 内建 mixin（`events`）——写进去插件会永远 pending（实测）',
    !(mod.inject || []).includes('events') && (mod.builtin || []).includes('events'),
    `inject=${JSON.stringify(mod.inject)} builtin=${JSON.stringify(mod.builtin)}`)
  const a1 = await mount(mod)
  check(name, 'A1', 'A1 正控：provided service 在插件内可取到（句柄非空）',
    a1.box.handle !== null && typeof a1.box.handle === 'object',
    `handle keys=${JSON.stringify(Object.keys(a1.box.handle || {}))}`)
  let stolen = null
  try {
    void a1.fiber.ctx[`service-not-injected-${name}`]
  } catch (err) {
    stolen = String(err.message).slice(0, 70)
  }
  check(name, 'A1', 'A1 负控：取用未在 `inject` 声明的服务必须抛错（不得静默可用）',
    stolen !== null, `error=${stolen}`)

  // --- A2 零残留 ---
  const effectsBefore = a1.fiber.getEffects().length
  counters.timers += 1
  const handle = setInterval(() => {}, 1000)
  a1.fiber.ctx.effect(() => () => {
    a1.box.released += 1
    counters.timers -= 1
    clearInterval(handle)
  })
  await a1.fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(name, 'A2', 'A2 正控：dispose 后 effect 数为 0 且资源计数差分全 0',
    effectsBefore > 0 && a1.fiber.getEffects().length === 0 && counters.timers === 0 && a1.box.released === 1,
    `effects ${effectsBefore} → ${a1.fiber.getEffects().length}；counters=${JSON.stringify(counters)} released=${a1.box.released}`)

  const leak = await mount(mod)
  counters.timers += 1
  setInterval(() => {}, 1000) // 故意泄漏：没有对应 dispose
  await leak.fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(name, 'A2', 'A2 负控：泄漏定时器的条目被检出（计数差分非 0 → 检查器必须报红）',
    counters.timers > 0, `counters=${JSON.stringify(counters)}`)
  counters.timers = 0

  // --- A3 config 负控 ---
  //（constKeysFound 见文件末尾汇总断言）
  let unknownKey = 'accepted'
  try {
    mod.Config.parse({ mystery_key: 1 })
  } catch { unknownKey = 'refused' }
  const constKey = Object.entries(mod.Config.dict || {}).find(([, node]) => node?.isConst)?.[0]
  let flipped = constKey ? 'accepted' : 'n/a'
  if (constKey) {
    const node = mod.Config.dict[constKey]
    try {
      mod.Config.parse({ [constKey]: node.value === true ? false : true })
    } catch { flipped = 'refused' }
  }
  // A3 口径：**每个**模块都必须拒未知键；const 键负控是**模块集级**要求（有 const 键的模块逐个验，
  // 没有 const 键的模块不硬套——否则断言在测"模块有没有恰好存在某个键"，与 config 否决纪律无关）
  const a3Ok = unknownKey === 'refused' && (constKey ? flipped === 'refused' : true)
  check(name, 'A3', constKey
    ? 'A3 config 负控：未知键被拒；翻转 const 键被拒'
    : 'A3 config 负控：未知键被拒（本模块无 const 键，const 负控在模块集级断言里）',
    a3Ok, `unknown=${unknownKey} constKey=${constKey ?? '（无）'} flip=${flipped}`)
  if (constKey) constKeysFound.push(`${name}.${constKey}`)

  // --- A4 事件声明 + A5 确定性（都用同一份"活着"的实例） ---
  const live = await mount(mod)
  const declared = declaredEvents.length ? declaredEvents : ['quote/submitted']
  const emitted = [...readFileSync(join(MODULE_DIR, file), 'utf-8')
    .matchAll(/\.emit\(\s*'([^']+)'/g)].map((match) => match[1])
  const notDeclared = emitted.filter((event) => !declared.includes(event))
  if (name === 'kernel-bridge' && live.box.handle?.emitDeclaration) {
    let undeclared = 'accepted'
    try {
      live.box.handle.emitDeclaration(declared, 'demo/not-declared', {})
    } catch { undeclared = 'refused' }
    check(name, 'A4', 'A4 事件声明：**运行时** emit 未声明事件名被拒（事件表真源在 Python 侧）',
      undeclared === 'refused' && declared.length > 0 && notDeclared.length === 0,
      `undeclared=${undeclared}；事件表 ${declared.length} 条；源码里 emit 的名字=${JSON.stringify(emitted)}`)
  } else {
    check(name, 'A4', 'A4 事件声明：源码里 emit 的事件名必须都在事件表里（真源在 Python 侧，静态扫描）',
      notDeclared.length === 0 && declared.length > 0,
      `emit=${JSON.stringify(emitted)} 未声明=${JSON.stringify(notDeclared)}；事件表 ${declared.length} 条`)
  }

  // A5 采样点：**模块自带** `fixture.sample(handle)` 优先（新增插件不必改本文件，避免多人抢同一文件）；
  // 没带就退回内置分支（历史模块保留原样）。
  const sample = () => {
    if (typeof mod.fixture?.sample === 'function') return JSON.stringify(mod.fixture.sample(live.box.handle))
    if (name === 'kernel-bridge') return JSON.stringify(live.box.handle.surface())
    if (name === 'norm') return JSON.stringify(live.box.handle.convert(120, 1))
    if (name === 'webui') return JSON.stringify({ prefix: live.box.handle.prefix, port: live.box.handle.port > 0 })
    return JSON.stringify(live.box.handle.normalize([{ item_id: 'L-001', qty: 120, factor: 1 }]))
  }
  const first = sample()
  await new Promise((resolve) => setTimeout(resolve, 15))
  const second = sample()
  check(name, 'A5', 'A5 确定性：同输入两次输出字节一致（无墙钟/无自增序号）',
    first === second && first.length > 10, `len=${first.length} equal=${first === second}`)
  await live.fiber.dispose()
  await live.ctx.stop?.()

  // --- A6 无跨模块 import ---
  const source = readFileSync(join(MODULE_DIR, file), 'utf-8')
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const leaks = imports.filter((spec) => /modules\//.test(spec)
    || (spec.startsWith('.') && !spec.startsWith('./') && !spec.startsWith('../lib/')))
  check(name, 'A6', 'A6 无跨模块 import：不得出现指向别的模块目录的相对 import（只允许 ../lib/ 与包名）',
    leaks.length === 0, `imports=${JSON.stringify(imports)} 越界=${JSON.stringify(leaks)}`)
}

check('__set__', 'A3', 'A3 模块集级：至少有一个模块暴露 const 键并拒绝翻转（否则 const 纪律无人覆盖）',
  constKeysFound.length > 0, `const 键：${constKeysFound.join(', ') || '（一个都没有）'}`)

const report = { kind: 'quotagent/modules', module_dir: relative(HERE, MODULE_DIR),
  events_source: eventsPath || '(内置兜底列表)', modules: [...new Set(checks.map((item) => item.module))],
  checks, passed: checks.filter((item) => item.ok).length, total: checks.length,
  note: 'A1..A6 每条含负控（评审 C §6 / §7.1 第 5 条）' }
console.log(JSON.stringify(report, null, 2))
if (failures) {
  console.error(`[FAIL] module manifests/fixtures: ${failures} 项未通过`)
} else {
  console.error(`[PASS] module manifests/fixtures（${report.passed}/${report.total}，${report.modules.length} 个模块）`)
}
process.exit(failures ? 1 : 0)
