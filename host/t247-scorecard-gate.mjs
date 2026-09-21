/**
 * t247-scorecard-gate —— T-247「供应商绩效记分卡」候选产物的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 被围对象：`supplier-scorecard`（tmp 阶段是 `./../tmp/t247-scorecard.mjs`，晋升后是 `./modules/supplier-scorecard.mjs`）。
 * 两阶段都能跑：先试进树产物，再回退到候选源码；**实际加载到的路径写进第 1 条断言的 detail**（不许「看着通过」）。
 *
 * 产物在 tmp 阶段要从 `../lib/std-schema.mjs` 导入，而 `tmp/../lib` 并不存在 —— 门在动态 import **之前**
 * 装一个解析钩子，把这个 specifier 指到 `host/lib/std-schema.mjs`（进树后天然可解析，钩子指向同一个文件，
 * 不会出现双实例）。因此这里必须用 `import()` 而不是静态 import：静态 import 在门体执行前就求值，钩子来不及装。
 *
 * 断言（10 条，其中 6 条是**负控**；每条都写清「什么情况下必须变红」）：
 *   1. 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides/Config/apply/fixture）+ 只 import ../lib 白名单
 *   2. 挂载正控：cordis 挂载后 provide 拦截拿得到句柄；dispose 后 effect 归零（AGENTS.md 规则 1）
 *   3. 手算正控：三家供应商逐字段等于**手算**预期（算式写在注释里，不用实现验实现）+ 输出键集固定 + 取值顺序契约
 *   4. 负控：坏输入（null/非数组/混入垃圾行/NaN/Infinity/字符串数字）不崩，且输出里没有非有限数
 *   5. 负控：缺失字段**不编造**（缺单价记 null 而不是 0；缺交期记 null；同时 0 是真值不得被当成缺失）
 *   6. 负控：确定性（同输入两次字节一致 / 跨实例一致 / 输出顺序与入参顺序无关 / 输出里没有时间字段）
 *   7. 负控：静态扫描零副作用（无事件订阅、无定时器、无写文件、无墙钟、无随机）+ **扫描器非空转对照**
 *   8. 负控：配置越界被夹取（上界 1000 / 下界 1 / NaN 回默认 200 / 默认配置不夹正常规模）
 *   9. 负控：配置不得静默放行（未知键、错误类型、非对象入参一律被拒）
 *  10. 正控：fixture 纯读取（连跑两次字节一致、不改变句柄行为）+ 冻结输入不抛错（没偷偷改调用方的行）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 * 用法：`tools/cordis.sh run ../host/t247-scorecard-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href
const CANDIDATES = ['./modules/supplier-scorecard.mjs', './../tmp/t247-scorecard.mjs']

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红的（「没跑到」不得当成「通过」，本仓已有教训）
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 产物加载（先装解析钩子，再动态 import）
// ---------------------------------------------------------------------------
const hookReady = (() => {
  try {
    if (typeof registerHooks !== 'function') return false
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '../lib/std-schema.mjs') return { url: SCHEMA_URL, shortCircuit: true }
        return nextResolve(specifier, context)
      },
    })
    return true
  } catch {
    return false
  }
})()

let mod = null
let loadedFrom = null
const loadTried = []
for (const candidate of CANDIDATES) {
  const url = new URL(candidate, import.meta.url)
  if (!existsSync(fileURLToPath(url))) { loadTried.push(`${candidate}=缺失`); continue }
  try {
    mod = await import(url.href)
    loadedFrom = candidate
    loadTried.push(`${candidate}=已加载`)
    break
  } catch (err) {
    loadTried.push(`${candidate}=加载失败(${err.code ?? err.name}: ${String(err.message).slice(0, 60)})`)
  }
}

/** 挂载：照抄产物声明的 `inject`（写成 [] 会让它取不到依赖），并包装 `provide` 抓句柄。 */
const mountWith = async (raw = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  const wrapper = {
    name: `${mod.name}#gate`,
    inject: mod.inject,
    Config: mod.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((mod.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await mod.apply(inner, config)
    },
  }
  const fiber = await ctx.plugin(wrapper, mod.Config.parse(raw))
  return { ctx, fiber, box }
}

/** 递归找非有限数（`JSON.stringify` 会把 NaN 写成 null，扫 JSON 文本是抓不到的）。 */
const badNumbers = (value, path = '') => {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path || '(root)']
  if (Array.isArray(value)) return value.flatMap((item, index) => badNumbers(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => badNumbers(item, path ? `${path}.${key}` : key))
  }
  return []
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

try {
  // ---------- 0. 加载 + 契约（正控） ----------
  const source = mod ? readFileSync(fileURLToPath(new URL(loadedFrom, import.meta.url)), 'utf8') : ''
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  const manifest = {
    name: mod?.name === 'supplier-scorecard',
    inject: Array.isArray(mod?.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod?.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod?.usedServices) && mod.usedServices.length === 0,
    provides: JSON.stringify(mod?.provides) === JSON.stringify(['supplierScorecard']),
    config: typeof mod?.Config?.['~standard']?.validate === 'function',
    apply: typeof mod?.apply === 'function',
    fixture: typeof mod?.fixture?.sample === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[supplierScorecard]/Config/apply/fixture）且只 import ../lib 白名单',
    mod !== null && manifestBad.length === 0 && importLeaks.length === 0,
    `载入=${loadedFrom ?? '未加载'}；候选=${loadTried.join('；')}；解析钩子=${hookReady ? '已装' : '不可用'}；问题键=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}`)
  if (!mod) finish()

  // ---------- 2. 挂载 + 零残留（正控） ----------
  const probe = await mountWith({})
  const probeEffects = probe.fiber.getEffects().length
  const handle = probe.box.handle
  const methodsOk = Boolean(handle) && typeof handle.scorecard === 'function' && typeof handle.bySupplier === 'function'
  await probe.fiber.dispose()
  const probeAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（带 scorecard/bySupplier），dispose 后 effect 归零',
    methodsOk && probeEffects > 0 && probeAfter === 0,
    `句柄键=${Object.keys(handle ?? {}).join('|') || '空'}；effect ${probeEffects} → ${probeAfter}`)

  const live = await mountWith({})
  const score = live.box.handle

  // ---------- 3. 手算正控 ----------
  // 手算表（**不跑实现算出来的**）：
  //   sup-A：价 10/14/12 → 最小值 10、中位 12、最大 14；交期 4/8/6 → 平均 (4+8+6)/3 = 6；标记 1 条（`true`）
  //          `deviation: false` 与 `0` 都不是标记
  //   sup-B：价 5/6 → 中位 (5+6)/2 = 5.5，min 5 / max 6；只有一条交期 10 → 平均 10；标记 1 条（非 0 数字 1）
  //   sup-C：只有交期 3、没有单价 → 价格三项全 null；标记字段是空串 → 0 条
  //   无供应商键的行 + 非对象行（null/'garbage'/42/[1,2]）→ 不进任何分组
  const ROWS = [
    { supplier_id: 'sup-A', unit_price: 10, lead_time_days: 4, deviation: false },
    { supplier_id: 'sup-A', unit_price: 14, lead_time_days: 8, deviation: true },
    { supplier_id: 'sup-A', unit_price: 12, lead_time_days: 6, deviation: 0 },
    { supplier_id: 'sup-B', unit_price: 5, lead_time_days: 10, deviation: 1 },
    { supplier_id: 'sup-B', unit_price: 6, deviation: 0 },
    { supplier_id: 'sup-C', lead_time_days: 3, deviation: '' },
    { unit_price: 999, lead_time_days: 1 },
    null, 'garbage', 42, [1, 2],
  ]
  const HAND = [
    { supplier_id: 'sup-A', rows: 3, suppliers: 1, quote_count: 3, priced_count: 3, min_unit_price: 10,
      median_unit_price: 12, max_unit_price: 14, lead_time_count: 3, avg_lead_time_days: 6, deviation_count: 1 },
    { supplier_id: 'sup-B', rows: 2, suppliers: 1, quote_count: 2, priced_count: 2, min_unit_price: 5,
      median_unit_price: 5.5, max_unit_price: 6, lead_time_count: 1, avg_lead_time_days: 10, deviation_count: 1 },
    { supplier_id: 'sup-C', rows: 1, suppliers: 1, quote_count: 1, priced_count: 0, min_unit_price: null,
      median_unit_price: null, max_unit_price: null, lead_time_count: 1, avg_lead_time_days: 3, deviation_count: 0 },
  ]
  const ENTRY_KEYS = Object.keys(HAND[0]).sort().join('|')
  const bySupplier = score.bySupplier(ROWS)
  const keysFixed = bySupplier.every((entry) => Object.keys(entry).sort().join('|') === ENTRY_KEYS)
  const projected = bySupplier.map((entry) => Object.fromEntries(Object.keys(HAND[0]).map((key) => [key, entry[key]])))
  const handOk = JSON.stringify(projected) === JSON.stringify(HAND) && keysFixed
  // 取值顺序契约：行上没有的键落到 `body` 里找（账本行形状）；两处都没有才算取不到
  const nestedRow = score.scorecard([{ body: { supplier_id: 'sup-D', unit_price: 20, lead_time_days: 2 } }])
  const nestedOk = nestedRow.quote_count === 1 && nestedRow.min_unit_price === 20 && nestedRow.max_unit_price === 20
    && nestedRow.avg_lead_time_days === 2 && nestedRow.suppliers === 1
  // 单供方口径：同一批 sup-A 的行算 scorecard 应与分组结果逐字段一致（scorecard 输出没有 supplier_id 键，
  // 比较时两侧用同一份键序投影，避免拿「键序」当「语义」）
  const SINGLE_KEYS = ['rows', 'suppliers', 'quote_count', 'priced_count', 'min_unit_price', 'median_unit_price',
    'max_unit_price', 'lead_time_count', 'avg_lead_time_days', 'deviation_count']
  const single = score.scorecard(ROWS.filter((row) => row && typeof row === 'object' && row.supplier_id === 'sup-A'))
  const pick10 = (source) => SINGLE_KEYS.map((key) => source[key])
  const singleOk = JSON.stringify(pick10(single)) === JSON.stringify(pick10(HAND[0]))
  check('3 手算正控：三家供应商逐字段等于手算值（算式见注释）+ 输出键集固定 + body 回退 + scorecard 单供方口径',
    handOk && nestedOk && singleOk,
    `分组=${JSON.stringify(projected)}；期望=${JSON.stringify(HAND)}；键集固定=${keysFixed}；body 回退=${nestedOk}；单供方一致=${singleOk}`)

  // ---------- 4. 负控：坏输入 ----------
  const EMPTY = { rows: 0, suppliers: 0, quote_count: 0, priced_count: 0, min_unit_price: null,
    median_unit_price: null, max_unit_price: null, lead_time_count: 0, avg_lead_time_days: null, deviation_count: 0 }
  const garbage = [null, undefined, 'garbage', 42, [1, 2], {}]
  const badInputs = [undefined, null, 'nope', 42, {}, { supplier_id: 'x' }, garbage]
  // 有键但取值不是有限数的行：行仍算「归属」（quote_count 计入），但**不算进价格统计**（不编数值）
  const weirdValues = [{ supplier_id: 'x', unit_price: NaN }, { supplier_id: 'x', unit_price: Infinity },
    { supplier_id: 'x', unit_price: '12' }, { supplier_id: 'x', unit_price: -Number.MAX_VALUE * 2 }]
  let threw = null
  const outputs = []
  for (const input of badInputs) {
    try {
      outputs.push(score.scorecard(input), score.bySupplier(input))
    } catch (err) {
      threw = `${JSON.stringify(input)?.slice(0, 24) ?? 'undefined'} → ${err.name}: ${String(err.message).slice(0, 80)}`
      break
    }
  }
  let weird = null
  let weirdThrew = null
  const weirdOutputs = []
  try {
    weird = score.scorecard(weirdValues)
    weirdOutputs.push(weird, score.bySupplier(weirdValues))
  } catch (err) {
    weirdThrew = `${err.name}: ${String(err.message).slice(0, 80)}`
  }
  const nonFinite = [...outputs, ...weirdOutputs].flatMap((out) => badNumbers(out))
  // 只对「非数组/垃圾」那组合断言输出为空壳；有键但取值非有限数的那组另有断言（见 weirdOk）
  const emptyish = outputs.every((out) => (Array.isArray(out)
    ? out.length === 0
    : out.quote_count === 0 && out.priced_count === 0 && out.deviation_count === 0 && out.min_unit_price === null
      && out.median_unit_price === null && out.max_unit_price === null && out.avg_lead_time_days === null))
  const undefinedLike = JSON.stringify(score.scorecard(undefined))
  const countOk = outputs.every((out) => (Array.isArray(out) ? true : Number.isInteger(out.rows) && Number.isInteger(out.quote_count)))
  const weirdOk = weird !== null && weird.quote_count === 4 && weird.priced_count === 0 && weird.deviation_count === 0
    && weird.min_unit_price === null && weird.median_unit_price === null && weird.max_unit_price === null
    && weird.avg_lead_time_days === null
  check('4 负控：坏输入（null/undefined/非数组/垃圾行/NaN/Infinity/字符串数字）不崩，且输出里没有非有限数',
    threw === null && weirdThrew === null && nonFinite.length === 0 && emptyish && countOk && weirdOk
    && undefinedLike === JSON.stringify(EMPTY),
    `抛错=${threw ?? weirdThrew ?? '无'}；非有限数=${nonFinite.join(',') || '无'}；空输入形状=${undefinedLike === JSON.stringify(EMPTY)}；`
    + `非数组输入全空=${emptyish}；非有限数单测=${JSON.stringify(weird)}`)

  // ---------- 5. 负控：缺失字段不编造 ----------
  const MISSING = [
    { supplier_id: 'only-lead', lead_time_days: 5 },
    { supplier_id: 'only-lead', lead_time_days: 7 },
    { supplier_id: 'only-price', unit_price: 0 },
    { supplier_id: 'bare-key' },
  ]
  const byKey = Object.fromEntries(score.bySupplier(MISSING).map((entry) => [entry.supplier_id, entry]))
  const noPrice = byKey['only-lead']
  const zeroPrice = byKey['only-price']
  const bare = byKey['bare-key']
  const noFabrication = Boolean(noPrice) && Boolean(zeroPrice) && Boolean(bare)
    && noPrice.min_unit_price === null && noPrice.median_unit_price === null && noPrice.max_unit_price === null
    && noPrice.priced_count === 0 && noPrice.avg_lead_time_days === 6
    && zeroPrice.min_unit_price === 0 && zeroPrice.median_unit_price === 0 && zeroPrice.max_unit_price === 0
    && zeroPrice.priced_count === 1 && zeroPrice.avg_lead_time_days === null && zeroPrice.lead_time_count === 0
    && bare.quote_count === 1 && bare.min_unit_price === null && bare.avg_lead_time_days === null
    && bare.deviation_count === 0
  // 非空转对照：同一批数据里字段**存在**时必须给出数值（否则「永远 null」也能骗过上面那条）
  const nonVacuous = score.scorecard(ROWS.filter((row) => row && row.supplier_id === 'sup-A')).avg_lead_time_days === 6
  check('5 负控：字段取不到就跳过（缺单价记 null 不是 0、缺交期记 null），而 0 是真值不得当成缺失',
    noFabrication && nonVacuous,
    `only-lead=${JSON.stringify(noPrice)}；only-price=${JSON.stringify(zeroPrice)}；bare=${JSON.stringify(bare)}；非空转对照=${nonVacuous}`)

  // ---------- 6. 负控：确定性 ----------
  const s1 = JSON.stringify(score.bySupplier(ROWS))
  const s2 = JSON.stringify(score.bySupplier(ROWS))
  const s3 = JSON.stringify(score.bySupplier([...ROWS].reverse()))
  const other = await mountWith({})
  const s4 = JSON.stringify(other.box.handle.bySupplier(ROWS))
  const timeKeys = /"(ts|at|now|time|elapsed|date|seq)"\s*:/.test(s1)
  check('6 负控：确定性（同输入两次字节一致 / 跨实例一致 / 输出顺序与入参顺序无关 / 输出里无时间字段）',
    s1 === s2 && s2 === s3 && s3 === s4 && s1.length > 10 && !timeKeys,
    `两次一致=${s1 === s2}；逆序一致=${s2 === s3}；跨实例一致=${s3 === s4}；长度=${s1.length}；含时间键=${timeKeys}`)

  // ---------- 7. 负控：静态扫描零副作用 + 扫描器非空转对照 ----------
  const FORBIDDEN = ['ctx.on(', 'ctx.events', 'setInterval(', 'setTimeout(', 'writeFile', 'appendFile',
    'createWriteStream', 'Date.now', 'Math.random', 'new Date', 'process.env', 'fetch(']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(source)
  const selfTest = scan('const tick = set' + 'Interval(() => {}, 1000)')
  check('7 负控：产物零副作用（无事件订阅/定时器/写文件/墙钟/随机）且扫描器非空转（对照样本必须命中）',
    hits.length === 0 && selfTest.length >= 1,
    `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}`)

  // ---------- 8. 负控：配置越界被夹取 ----------
  const many = Array.from({ length: 1001 }, (_, index) => ({ supplier_id: `sup-${String(index).padStart(4, '0')}`, unit_price: index }))
  const ceiling = await mountWith({ max_suppliers: 10 ** 9 })
  const floorZero = await mountWith({ max_suppliers: 0 })
  const floorNegative = await mountWith({ max_suppliers: -5 })
  const nanConfig = await mountWith({ max_suppliers: Number.NaN })
  const standard = await mountWith({})
  const capped = ceiling.box.handle.bySupplier(many)
  const cappedIds = capped.map((entry) => entry.supplier_id)
  const clampOk = capped.length === 1000 && cappedIds[0] === 'sup-0000' && cappedIds[999] === 'sup-0999'
    && !cappedIds.includes('sup-1000')
    && floorZero.box.handle.bySupplier(many).length === 1
    && floorNegative.box.handle.bySupplier(many).length === 1
    && nanConfig.box.handle.bySupplier(many.slice(0, 250)).length === 200
    && standard.box.handle.bySupplier(many.slice(0, 5)).length === 5
  check('8 负控：max_suppliers 越界被夹取（1e9→上界 1000；0 与 -5→下界 1；NaN→默认 200；默认配置不夹正常规模）',
    clampOk,
    `1e9 → ${capped.length} 条（首=${cappedIds[0]} 末=${cappedIds[999]} 含 sup-1000=${cappedIds.includes('sup-1000')}）；`
    + `0 → ${floorZero.box.handle.bySupplier(many).length}；-5 → ${floorNegative.box.handle.bySupplier(many).length}；`
    + `NaN(250 家) → ${nanConfig.box.handle.bySupplier(many.slice(0, 250)).length}；默认(5 家) → ${standard.box.handle.bySupplier(many.slice(0, 5)).length}`)

  // ---------- 9. 负控：配置不得静默放行 ----------
  const refuses = (raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const defaults = mod.Config.parse({})
  const unknownKey = refuses({ mystery_key: 1 })
  const wrongType = refuses({ max_suppliers: 'many' })
  const notObject = refuses(42)
  const wrongFieldType = refuses({ key_field: 7 })
  check('9 负控：配置不得静默放行（未知键 / 错误类型 / 非对象入参一律被拒；空配置给出默认值）',
    unknownKey === 'refused' && wrongType === 'refused' && notObject === 'refused' && wrongFieldType === 'refused'
    && defaults.max_suppliers === 200 && defaults.key_field === 'supplier_id',
    `未知键=${unknownKey} 错类型=${wrongType} 非对象=${notObject} 字段错类型=${wrongFieldType} 默认=${defaults.max_suppliers}/${defaults.key_field}`)

  // ---------- 10. 正控：fixture 纯读取 + 冻结输入 ----------
  const reference = JSON.stringify(score.bySupplier(ROWS))
  const first = JSON.stringify(mod.fixture.sample(score))
  const second = JSON.stringify(mod.fixture.sample(score))
  const afterFixture = JSON.stringify(score.bySupplier(ROWS))
  const frozenRows = ROWS.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : row))
  deepFreeze(frozenRows)
  // 冻结输入必须与原输入给出同一份结果：ESM 是严格模式，任何对入参的写入都会抛 TypeError
  const frozenOut = JSON.stringify(score.bySupplier(frozenRows))
  check('10 正控：fixture 纯读取（连跑两次字节一致、不改变句柄行为），且冻结输入不抛错（没偷偷改调用方的行）',
    first === second && first.length > 10 && afterFixture === reference && frozenOut === reference,
    `fixture 两次一致=${first === second} 长度=${first.length}；句柄未变=${afterFixture === reference}；冻结输入一致=${frozenOut === reference}`)

  for (const mounted of [live, other, ceiling, floorZero, floorNegative, nanConfig, standard]) {
    try {
      await mounted.fiber.dispose()
    } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 200)}`)
}

finish()
