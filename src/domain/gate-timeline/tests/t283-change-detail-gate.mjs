/**
 * t283-change-detail-gate —— **「变更单到底改了什么、多花多少钱」**（`host/modules/gate-timeline.mjs` 的
 * 规则 ⑤「逐行明细」+ 它在 `webui` 里的两条新路由 `/<view>/changes/<id>/`、`/<view>/api/changes/<id>`）
 * 的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 为什么要有这一条：P-14 的原话是「变更单差额**看不到明细**，对账靠回忆」—— 所以这一条的正确性判据
 * **必须**是"逐行金额能与手算对上"，而不是"页面上有一张表"。本门的期望值全部是**按夹具手算的
 * 整数分**（写在断言旁边；缺依据的行按定义**不进小计**），绝不拿插件的输出当期望。
 *
 * 断言（≥12 条，每条写清"什么情况下必须变红"）：
 *   1  契约正控：manifest + 本批常量齐备（`MONEY_UNIT=costs` 口径 / `ROUNDING` / 腿 11 键 / 闭合的
 *      `DETAIL_REASONS` / 私域视图白名单）；只 import ../lib 白名单（或 node:）；源码 0 个脚本字面量
 *   2  挂载正控：`change_detail` 拿得到且是函数、dispose 后 effect 归零
 *   3  **逐行手算对账**（本门最核心的一条）：5 行输入（含 1 行缺依据）⇒ 4 行明细逐字段等于**手算的
 *      整数分**；`amount = qty × unit_price`；`delta_amount = amount_after − amount_before`；
 *      `delta_pct` 由**整数分位 half-up** 独立复算（分母 0 ⇒ null）；键集恰 11 键
 *   4  **缺依据的行不入小计**：`basis_missing` 恰 [L-003]（缺 qty_after）且**明细里没有它**；
 *      小计等于**只含可用行**的手算值（并证明"若把它算进去"是另一个数 —— 双向）
 *   5  **整张单无可用行 ⇒ degraded + 明细为空 + 小计 null**（不是 0：0 会冒充「没变」）；未知 id ⇒
 *      `change-not-found` + `next_action`；非对象载荷 ⇒ `payload-not-an-object`
 *   6  缺依据的**非整数**也要落网：浮点 / 小数字符串 / 缺字段 / 重复 line_id 都进 `basis_missing`
 *      （非空转：同一批里合法行照旧进小计）
 *   7  确定性：同输入两次逐字节一致 / 键序打乱一致 / **行顺序逆序**一致 / 跨实例一致 / 两个墙钟
 *      入口（`payload.now` / `config.now`）给任何值输出都不变 / 输出里没有时间键
 *   8  有界与 `omitted` 诚实：`max_items` 夹取并回显；输入行数上限 64（65 行 ⇒ `lines_not_read=1`）；
 *      `shown + omitted == usable`；**截断只影响展示，不改小计口径**
 *   9  **私域哨兵零泄漏（两面都扫）**：供应商侧带哨兵与不带哨兵输出**逐字节一致**、哨兵与键名 0 命中；
 *      同一份载荷在**承包商侧**确实看得到自己的私域列（非空转对照）
 *   10 零写面 / 不读账本 / 不取墙钟（静态扫描 + **扫描器非空转对照**）；`privacy` 四项如实申报
 *   11 契约正控（宿主侧）：两条新路由 + 变更单列表**每一行链到自己的明细页**（`data-change-detail-link`）
 *      + 四道页面子导航仍带 `data-gates-link`；页面模板 0 内联脚本 / 0 内联事件（静态扫描）
 *   12 **真 HTTP**：两视角明细页/JSON 200（合约商侧还带自己的私域列）、**页面上的数字与手算一致**、
 *      未知 id 页面与 JSON 都 **404 + `next_action`**、供应商侧明细页/JSON 哨兵 0 命中（夹具文件里
 *      确实有哨兵 ⇒ 非空转）、4 份响应 0 行脚本 / 0 内联事件、`/api/routes` 登记四条新路由且 auth=identity-session
 *   13 **单点变异**：4 处变异各自必须让**指定的**场景变红（且变异必须真的改了字节）
 *   14 防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `gate-timeline.mjs` 与
 *      `webui.mjs` 字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t283-change-detail-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
// `cordis` 是宿主私有的裸名依赖：搬迁后本文件不在 `host/` 下，改为按**显式解析**导入
// （见下方 `CORDIS_URL`；与搬迁前 Node 从 `host/node_modules` 上溯到的是同一份）。
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 实现已搬进 `src/<层>/<插件>/tests/`（迁移阶段 4.2 的续搬，EV-173）：宿主目录由仓库根推出
// （`src/<层>/<插件>/tests/` 4 层上溯），旧位置 `host/` 留**薄转发**；
// 本文件其余逻辑与搬迁前逐行相同（`join(HERE, '..')` 仍是仓库根）。
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'host')
// 宿主内核解析（搬迁后本文件不在 `host/` 下）：裸名 `cordis` 从**宿主目录**解析 —— 与搬迁前 Node 上溯到
// `host/node_modules/` 的那一份**同一个文件**（`cordis` 的 `main`/`exports` 都指向 `lib/index.js`）。
const CORDIS_URL = process.env.QUOTAGENT_CORDIS
  ? pathToFileURL(process.env.QUOTAGENT_CORDIS).href
  : pathToFileURL(join(HERE, 'node_modules', 'cordis', 'lib', 'index.js')).href
const { Context, EventsService } = await import(CORDIS_URL)
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/gate-timeline.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const TARGET = join(HERE, '..', 'src', 'domain', 'gate-timeline', 'code', 'gate-timeline.mjs')
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/webui.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const WEBUI = join(HERE, '..', 'src', 'system', 'webui', 'code', 'webui.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

// 门自己注入的**假** admin token：只为取第四道页面的子导航（提权后）。
process.env.QUOTAGENT_ADMIN_TOKEN_T283 = 't283-gate-token-6a1f'

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

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

const sourceOf = (path) => readFileSync(path, 'utf8')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const originalSource = sourceOf(TARGET)
const originalHash = sha256(originalSource)
const webuiSource = sourceOf(WEBUI)
const webuiHash = sha256(webuiSource)

const mod = await import(pathToFileURL(TARGET).href)

/** 挂载：照抄产物声明的 `inject`，包装 `provide` 抓句柄。 */
const mountWith = async (raw = {}, loaded = mod) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  const fiber = await ctx.plugin({
    name: `${loaded.name}#gate`,
    inject: loaded.inject,
    Config: loaded.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((loaded.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await loaded.apply(inner, config)
    },
  }, loaded.Config.parse(raw))
  return { ctx, fiber, box, loaded }
}

/** 从**临时副本**挂载变异体（`?v=` 破缓存）。 */
const mountMutant = async (mutatedSource, raw = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 't283-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `gate-timeline.mut-${tag}.mjs`)
  writeFileSync(file, mutatedSource, 'utf8')
  const mutant = await import(`${pathToFileURL(file).href}?v=${tag}`)
  const mounted = await mountWith(raw, mutant)
  return { ...mounted, mutant, file, dir }
}

/** 单点变异：找不到/多于一处的"变异"是**假变异**（返回 null，调用方必须判红）。 */
const applyMutation = (text, find, replace) => {
  const count = text.split(find).length - 1
  if (count !== 1 || find === replace || !replace) return null
  return text.replace(find, replace)
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// ===========================================================================
// 夹具 + **手算表**（先把数字量出来再写进断言：写错门就红）
//   输入（整数件 × 整数分）：
//     L-001 qb=10 ub=6000 qa=12 ua=6000  ⇒ 60000 → 72000  差额 12000  百分比 12000×10000÷60000 = 2000 分位 = 20.00%
//     L-002 qb= 3 ub=1000 qa= 3 ua=1500  ⇒  3000 →  4500  差额  1500  百分比  1500×10000÷ 3000 = 5000 分位 = 50.00%
//     L-003 qb= 3 ub=2000 qa=**(缺)** ua=2500 ⇒ **缺依据**（不得编数）⇒ 列 basis_missing 且**排除出小计**
//     L-004 qb= 0 ub=   0 qa= 5 ua=1000  ⇒     0 →  5000  差额  5000  原价 0 ⇒ 百分比 **null**（分母 0 不猜）
//     L-005 qb= 3 ub=1000 qa= 1 ua=1001  ⇒  3000 →  1001  差额 -1999  百分比 -1999×10000÷3000 = -6663.33… → -6663 分位 = -66.63%
//   小计（**只含 4 个可用行**）：60000+3000+0+3000 = **66000**；72000+4500+5000+1001 = **82501**；
//     差额 **16501**；百分比 16501×10000÷66000 = 2500.15… → **2500 分位 = 25.00%**
//   反证：若把 L-003 也算进去（原量 3 × 原价 2000 = 6000；新量缺失无从算）⇒ 66000 与 72000 都不是这个数
// ===========================================================================
const CLEAN_LINES = [
  { line_id: 'L-001', desc: '钢筋', qty_before: 10, unit_price_before: 6000, qty_after: 12, unit_price_after: 6000 },
  { line_id: 'L-002', desc: '水泥', qty_before: 3, unit_price_before: 1000, qty_after: 3, unit_price_after: 1500 },
  { line_id: 'L-003', desc: '砂石', qty_before: 3, unit_price_before: 2000, qty_after: null, unit_price_after: 2500 },
  { line_id: 'L-004', desc: '模板', qty_before: 0, unit_price_before: 0, qty_after: 5, unit_price_after: 1000 },
  { line_id: 'L-005', desc: '拆改', qty_before: 3, unit_price_before: 1000, qty_after: 1, unit_price_after: 1001 },
]
/** 手算表：`pct` 是**整数分位**（hundredths）；`null` = 分母为 0（不猜）。 */
const HAND_LINES = {
  'L-001': { qb: 10, ub: 6000, ab: 60000, qa: 12, ua: 6000, aa: 72000, d: 12000, pct: 2000 },
  'L-002': { qb: 3, ub: 1000, ab: 3000, qa: 3, ua: 1500, aa: 4500, d: 1500, pct: 5000 },
  'L-004': { qb: 0, ub: 0, ab: 0, qa: 5, ua: 1000, aa: 5000, d: 5000, pct: null },
  'L-005': { qb: 3, ub: 1000, ab: 3000, qa: 1, ua: 1001, aa: 1001, d: -1999, pct: -6663 },
}
const HAND_SUBTOTAL = { lines: 4, before: 66000, after: 82501, delta: 16501, pct: 2500 }
const HAND_MISSING = [['L-003', 'qty_after']]
const DETAIL_KEYS_SORTED = 'amount_after|amount_before|basis|delta_amount|delta_pct|desc|line_id|qty_after|qty_before|unit_price_after|unit_price_before'
const HAND_SENTINELS = ['COST-MODEL-SENTINEL-9a', 'PRIVATE-NOTE-SENTINEL-7f', 'RESERVE-PRICE-SENTINEL-4b',
  'INTERNAL-NOTE-SENTINEL-5c', '987654321']
const PRIVATE_NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:']

const CLEAN = { view: 'supplier', as_of: '2026-09-25T12:00:00Z',
  change: { change_id: 'CO-0001', quote_id: 'q-1', ts: '2026-09-25T11:00:00Z', lines: CLEAN_LINES } }
const DIRTY_LINES = CLEAN_LINES.map((line, index) => ({ ...line, cost_floor: HAND_SENTINELS[0], markup_pct: 12.5,
  reserve_price: HAND_SENTINELS[2], 'private:note': HAND_SENTINELS[1],
  internal_notes: index === 0 ? HAND_SENTINELS[3] : '本侧内部备注' }))
const dirtyFor = (view) => ({ view, as_of: CLEAN.as_of,
  change: { ...CLEAN.change, lines: DIRTY_LINES } })

/** 门自己的**整数分位 half-up**（远离零）——独立实现，用来复算插件的 `delta_pct`。 */
const halfUpHundredths = (numerator, denominator) => {
  const sign = numerator < 0 ? -1 : 1
  const magnitude = numerator < 0 ? -numerator : numerator
  return sign * Math.floor((2 * magnitude + denominator) / (2 * denominator))
}

/** 门自己的**逐行手算**：从夹具（不是从插件输出）算出期望值。 */
const handOf = (line) => {
  const before = line.qty_before * line.unit_price_before
  const after = line.qty_after * line.unit_price_after
  const delta = after - before
  const pct = before === 0 ? null : halfUpHundredths(delta * 10000, before) / 100
  return { before, after, delta, pct }
}

/** 4 处单点变异（各自只改一处；`mustRed` 是"必须变红"的那条场景）。 */
const SCENARIOS = ['逐行手算对账', '缺依据不入小计', '供应商侧哨兵', '空输入 degraded']
const MUTATIONS = [
  { name: '变异1：金额改用"四舍五入到分"的除法（手算对不上）',
    find: '    const amountBefore = facts.qty_before * facts.unit_price_before',
    replace: '    const amountBefore = Math.round(facts.qty_before * facts.unit_price_before / 100)',
    mustRed: '逐行手算对账' },
  { name: '变异2：缺依据的行也计入小计（编数）',
    find: '    if (missing.length > 0) {',
    replace: '    if (false) {',
    mustRed: '缺依据不入小计' },
  { name: '变异3：私域列对**所有**视角都回显（供应商侧泄漏）',
    find: '    if (owner) {',
    replace: '    if (true) {',
    mustRed: '供应商侧哨兵' },
  { name: '变异4：整张单无可用行也不判降级（明细为空却说健康）',
    find: '  degraded: extra.reason === null ? false : true,',
    replace: '  degraded: false,',
    mustRed: '空输入 degraded' },
]

const factsFor = async (mountFn) => {
  const base = await mountFn({})
  const handle = base.box.handle
  const detail = (payload) => handle.change_detail(payload)
  const facts = {}
  const out = detail(CLEAN)

  // ---- ① 逐行手算对账 ----
  const byId = Object.fromEntries(out.lines.map((line) => [line.line_id, line]))
  const rowsOk = out.lines.length === 4 && Object.entries(HAND_LINES).every(([id, hand]) => {
    const line = byId[id]
    if (!line) return false
    const own = handOf(CLEAN_LINES.find((item) => item.line_id === id))
    return line.qty_before === hand.qb && line.unit_price_before === hand.ub && line.amount_before === hand.ab
      && line.qty_after === hand.qa && line.unit_price_after === hand.ua && line.amount_after === hand.aa
      && line.delta_amount === hand.d
      && (hand.pct === null ? line.delta_pct === null : line.delta_pct === hand.pct / 100)
      // 独立复算：金额 = 量 × 单价；差额 = 新 − 原；百分比 = 整数分位 half-up
      && line.amount_before === own.before && line.amount_after === own.after
      && line.delta_amount === line.amount_after - line.amount_before
      && (line.amount_before === 0 ? line.delta_pct === null : line.delta_pct === own.pct)
      && Object.keys(line).sort().join('|') === DETAIL_KEYS_SORTED
      && Array.isArray(line.basis) && line.basis.length >= 5
  })
  const subtotalOk = out.subtotal.lines === HAND_SUBTOTAL.lines
    && out.subtotal.amount_before === HAND_SUBTOTAL.before
    && out.subtotal.amount_after === HAND_SUBTOTAL.after
    && out.subtotal.delta_amount === HAND_SUBTOTAL.delta
    && out.subtotal.delta_pct === HAND_SUBTOTAL.pct / 100
    && out.subtotal.delta_amount === out.subtotal.amount_after - out.subtotal.amount_before
    && out.money_unit === 'cents' && out.rounding === 'half-up-to-cent'
    && typeof out.money_note === 'string' && out.money_note.includes('整数分')
    && out.counts.lines_usable === 4 && out.counts.lines_shown === 4 && out.counts.omitted === 0
    && out.degraded === false && out.reason === null
  facts['逐行手算对账'] = rowsOk && subtotalOk

  // ---- ② 缺依据的行不入小计（双向：算进去就是另一个数）----
  const missingPairs = out.basis_missing.map((item) => [item.line_id, item.missing.join(',')])
  const withMissing = HAND_SUBTOTAL.before + 3 * 2000   // 若把 L-003 的原量 3×原价 2000 也加进去
  facts['缺依据不入小计'] = JSON.stringify(missingPairs) === JSON.stringify(HAND_MISSING)
    && !out.lines.some((line) => line.line_id === 'L-003')
    && out.counts.lines_excluded === 1 && out.counts.basis_missing === 1
    && out.subtotal.amount_before === HAND_SUBTOTAL.before
    && out.subtotal.amount_before !== withMissing
    && out.notes.some((text) => text.includes('未纳入小计'))

  // ---- ③ 私域哨兵：供应商侧逐字节一致 + 0 命中；业主侧确实看得见（非空转）----
  const cleanSupplier = JSON.stringify(out)
  const dirtySupplier = JSON.stringify(detail(dirtyFor('supplier')))
  const dirtyOwner = detail(dirtyFor('contractor'))
  const ownerText = JSON.stringify(dirtyOwner)
  const hitsSupplier = HAND_SENTINELS.filter((needle) => dirtySupplier.includes(needle))
  const keysSupplier = PRIVATE_NEEDLES.filter((needle) => dirtySupplier.includes(needle))
  const hitsOwner = HAND_SENTINELS.filter((needle) => ownerText.includes(needle))
  const keysOwner = PRIVATE_NEEDLES.filter((needle) => ownerText.includes(needle))
  const inputHits = HAND_SENTINELS.filter((needle) => JSON.stringify(DIRTY_LINES).includes(needle))
  facts['供应商侧哨兵'] = dirtySupplier === cleanSupplier && hitsSupplier.length === 0
    && keysSupplier.length === 0 && out.privacy.private_keys_read === false
    && hitsOwner.length >= 3 && keysOwner.length >= 3 && dirtyOwner.private_columns.length > 0
    && dirtyOwner.privacy.private_keys_read === true && inputHits.length >= 3

  // ---- ④ 整张单无可用行 ⇒ degraded + 明细为空 + 小计 null（不是 0）----
  const noLines = detail({ view: 'supplier', as_of: CLEAN.as_of, change: { change_id: 'CO-2', lines: [] } })
  const allMissing = detail({ view: 'supplier', as_of: CLEAN.as_of,
    change: { change_id: 'CO-3', lines: [{ line_id: 'L-9', qty_before: 1 }] } })
  const notFound = detail({ view: 'supplier', change_id: 'CO-9999' })
  const notObject = detail('garbage')
  facts['空输入 degraded'] = noLines.degraded === true && noLines.reason === 'no-usable-lines'
    && noLines.lines.length === 0 && noLines.subtotal.amount_before === null
    && noLines.subtotal.delta_amount === null && noLines.subtotal.lines === 0
    && allMissing.degraded === true && allMissing.reason === 'no-usable-lines'
    && allMissing.lines.length === 0 && allMissing.basis_missing.length === 1
    && notFound.degraded === true && notFound.reason === 'change-not-found' && notFound.lines.length === 0
    && typeof notFound.next_action === 'string' && notFound.next_action.length > 10
    && notObject.degraded === true && notObject.reason === 'payload-not-an-object'
    && notObject.lines.length === 0
  return facts
}

try {
  // ---------- 1. 契约正控 ----------
  const imports = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  const scriptNeedle = '<scr' + 'ipt'
  const manifest = {
    name: mod.name === 'gate-timeline',
    money: mod.MONEY_UNIT === 'cents',
    rounding: mod.ROUNDING === 'half-up-to-cent',
    note: typeof mod.MONEY_NOTE === 'string' && mod.MONEY_NOTE.includes('整数分')
      && mod.MONEY_NOTE.includes('half-up-to-cent'),
    keys: JSON.stringify([...mod.DETAIL_KEYS].sort().join('|')) === JSON.stringify(DETAIL_KEYS_SORTED),
    reasons: JSON.stringify(mod.DETAIL_REASONS)
      === JSON.stringify(['payload-not-an-object', 'change-not-found', 'no-usable-lines']),
    privateViews: JSON.stringify(mod.PRIVATE_COLUMN_VIEWS) === JSON.stringify(['contractor']),
    marks: ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model']
      .every((key) => mod.PRIVATE_KEY_MARKS.includes(key)),
    fn: typeof mod.changeDetailOf === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：本批常量齐备（`MONEY_UNIT="cents"` / `ROUNDING="half-up-to-cent"` / 口径人话 / '
    + '11 键 / 闭合的 `DETAIL_REASONS` / 私域视图白名单 / 私域列标记）+ `changeDetailOf` 是函数；'
    + '只 import ../lib 白名单（或 node:）；源码里 0 个脚本字面量',
  manifestBad.length === 0 && importLeaks.length === 0 && !originalSource.includes(scriptNeedle) && hookReady,
  `问题键=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；`
  + `含脚本字面量=${originalSource.includes(scriptNeedle)}；解析钩子=${hookReady ? '已装' : '不可用'}；`
  + `字节=${Buffer.byteLength(originalSource)}`)

  // ---------- 2. 挂载 + 零残留 ----------
  const probe = await mountWith({})
  const methodsOk = typeof probe.box.handle?.change_detail === 'function'
    && typeof probe.box.handle?.timeline === 'function' && typeof probe.box.handle?.meta === 'function'
  const probeEffects = probe.fiber.getEffects().length
  await probe.fiber.dispose()
  const probeAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 `change_detail` 是函数（与既有的 timeline/meta 并存）、dispose 后 effect 归零',
    methodsOk && probeEffects > 0 && probeAfter === 0,
    `句柄键=${Object.keys(probe.box.handle ?? {}).sort().join('|') || '空'}；effect ${probeEffects} → ${probeAfter}`)

  const live = await mountWith({})
  const detail = (payload, config) => live.box.handle.change_detail(payload)
  const out = detail(CLEAN)
  const meta = live.box.handle.meta()

  // ---------- 3. 逐行手算对账（核心） ----------
  const byId = Object.fromEntries(out.lines.map((line) => [line.line_id, line]))
  const handRows = Object.entries(HAND_LINES).map(([id, hand]) => {
    const line = byId[id] ?? {}
    const ok = line.amount_before === hand.ab && line.amount_after === hand.aa && line.delta_amount === hand.d
      && (hand.pct === null ? line.delta_pct === null : line.delta_pct === hand.pct / 100)
    return `${id}: 手算 ${hand.ab}→${hand.aa} 差 ${hand.d} 百分比 ${hand.pct === null ? 'null' : (hand.pct / 100).toFixed(2)}`
      + ` ｜实得 ${line.amount_before}→${line.amount_after} 差 ${line.delta_amount} 百分比 ${line.delta_pct}`
      + ` ｜${ok ? '一致' : '**不一致**'}`
  })
  const keysExact = out.lines.every((line) => Object.keys(line).sort().join('|') === DETAIL_KEYS_SORTED)
  const arithmetic = out.lines.every((line) => line.amount_before === line.qty_before * line.unit_price_before
    && line.amount_after === line.qty_after * line.unit_price_after
    && line.delta_amount === line.amount_after - line.amount_before
    && (line.amount_before === 0 ? line.delta_pct === null
      : line.delta_pct === halfUpHundredths(line.delta_amount * 10000, line.amount_before) / 100))
  check('3 **逐行手算金额对账**（本门最核心的一条）：5 行输入 ⇒ 4 行明细，逐行等于**手算的整数分**'
    + '（L-001 60000→72000 / L-002 3000→4500 / L-004 0→5000 且原价 0 ⇒ 百分比 null / '
    + 'L-005 3000→1001 差 -1999 ⇒ -66.63%）；每行 `amount = qty × unit_price`、'
    + '`delta_amount = amount_after − amount_before`、`delta_pct` 由**整数分位 half-up** 独立复算；键集恰 11 键',
  out.lines.length === 4 && handRows.every((line) => line.endsWith('一致')) && keysExact && arithmetic
  && out.money_unit === 'cents' && out.rounding === 'half-up-to-cent'
  && out.subtotal.amount_before === HAND_SUBTOTAL.before && out.subtotal.amount_after === HAND_SUBTOTAL.after
  && out.subtotal.delta_amount === HAND_SUBTOTAL.delta && out.subtotal.delta_pct === HAND_SUBTOTAL.pct / 100,
  handRows.join('；') + `；键集固定=${keysExact}；算术自洽=${arithmetic}；`
  + `小计手算 ${HAND_SUBTOTAL.before}→${HAND_SUBTOTAL.after} 差 ${HAND_SUBTOTAL.delta}（25.00%），`
  + `实得 ${out.subtotal.amount_before}→${out.subtotal.amount_after} 差 ${out.subtotal.delta_amount}`
  + `（${out.subtotal.delta_pct}%）`)

  // ---------- 4. 缺依据的行不入小计 ----------
  const missingPairs = out.basis_missing.map((item) => `${item.line_id} 缺 ${item.missing.join('/')}`)
  const withMissing = HAND_SUBTOTAL.before + 3 * 2000
  check('4 **缺依据的行不入小计**：`L-003` 缺 `qty_after` ⇒ 列进 `basis_missing` 且**明细里没有它**；'
    + '小计等于**只含 4 个可用行**的手算值（66000/82501/16501），并证明"若把它算进去"是另一个数'
    + '（6000 ⇒ 72000）—— 双向断言，不给"悄悄补 0"留活路',
  missingPairs.length === 1 && missingPairs[0] === 'L-003 缺 qty_after'
  && !out.lines.some((line) => line.line_id === 'L-003')
  && out.counts.lines_excluded === 1 && out.counts.basis_missing === 1 && out.counts.lines_usable === 4
  && out.subtotal.amount_before === HAND_SUBTOTAL.before && out.subtotal.amount_before !== withMissing
  && out.notes.some((text) => text.includes('未纳入小计')),
  `basis_missing=${JSON.stringify(missingPairs)}；明细 id=${JSON.stringify(out.lines.map((line) => line.line_id))}；`
  + `小计原金额=${out.subtotal.amount_before}（手算只含可用行 ${HAND_SUBTOTAL.before}；`
  + `若含缺依据行会是 ${withMissing}）`)

  // ---------- 5. 缺依据的"非整数"也要落网（非空转对照） ----------
  const oddCases = [
    ['浮点单价（60.5 分）', { line_id: 'L-f1', qty_before: 1, unit_price_before: 60.5, qty_after: 1, unit_price_after: 60 }],
    ['小数字符串（"60.5"）', { line_id: 'L-f2', qty_before: 1, unit_price_before: '60.5', qty_after: 1, unit_price_after: 60 }],
    ['缺新量字段', { line_id: 'L-f3', qty_before: 1, unit_price_before: 60, qty_after: undefined, unit_price_after: 60 }],
    ['缺 line_id', { qty_before: 1, unit_price_before: 60, qty_after: 1, unit_price_after: 60 }],
  ]
  const oddRun = detail({ view: 'supplier', as_of: CLEAN.as_of,
    change: { change_id: 'CO-odd', lines: [...oddCases.map(([, payload]) => payload), CLEAN_LINES[0]] } })
  const oddExcluded = oddRun.basis_missing.map((item) => item.line_id)
  const duplication = detail({ view: 'supplier', as_of: CLEAN.as_of, change: { change_id: 'CO-dup', lines: [
    { line_id: 'L-d', qty_before: 1, unit_price_before: 100, qty_after: 2, unit_price_after: 100 },
    { line_id: 'L-d', qty_before: 9, unit_price_before: 100, qty_after: 9, unit_price_after: 100 },
  ] } })
  check('5 缺依据的**非整数与坏形状**也落网：浮点单价 / 小数字符串 / 缺新量 / 缺 line_id 一律进 '
    + '`basis_missing`（不四舍五入、不补默认值）；**非空转对照**：同一批里的合法行照旧进小计；'
    + '同一 `line_id` 出现多行 ⇒ **两行都不计入小计**（口径不确定时不猜）',
  oddExcluded.length === 4 && oddExcluded.includes('L-f1') && oddExcluded.includes('L-f2')
  && oddExcluded.includes('L-f3') && oddExcluded.includes('(缺 line_id)')
  && oddRun.lines.length === 1 && oddRun.lines[0].line_id === 'L-001'
  && oddRun.subtotal.amount_before === 60000 && duplication.lines.length === 0
  && duplication.basis_missing.length === 2
  && duplication.basis_missing.every((item) => item.reason === 'duplicate-line-id')
  && duplication.degraded === true && duplication.reason === 'no-usable-lines',
  `落网=${JSON.stringify(oddExcluded)}；合法行仍进小计=${oddRun.lines.length} 行（小计 `
  + `${oddRun.subtotal.amount_before}）；重复 id ⇒ 明细 ${duplication.lines.length} 行 / basis_missing `
  + `${duplication.basis_missing.length} 条`)

  // ---------- 6. 空输入不编（硬负控） ----------
  const emptyCases = [['空对象', { view: 'supplier' }], ['undefined', undefined], ['null', null],
    ['字符串', 'garbage'], ['数字', 7], ['空 lines', { view: 'supplier', change: { change_id: 'C', lines: [] } }],
    ['坏形状 lines', { view: 'supplier', change: { change_id: 'C', lines: ['x', 7, null] } }],
    ['未知 id', { view: 'supplier', change_id: 'CO-9999', change: null }]]
  const emptyReport = []
  let emptyThrew = null
  for (const [label, payload] of emptyCases) {
    try {
      const run = detail(payload)
      const okCase = run.degraded === true && mod.DETAIL_REASONS.includes(run.reason) && run.lines.length === 0
        && run.subtotal.amount_before === null && run.subtotal.delta_amount === null
      emptyReport.push(`${label}→${run.degraded}/${run.reason}/行=${run.lines.length}`)
      if (!okCase) emptyReport.push(`!! ${label} 形状不对：${JSON.stringify(run).slice(0, 80)}`)
    } catch (err) { emptyThrew = `${label}: ${err.name}` }
  }
  check('6 **空输入 / 未知 id / 无可用行 ⇒ 不编**（硬负控）：一律 `degraded:true` + **有名** reason + '
    + '**明细为空** + 小计三个数记 `null`（不是 0 —— 0 会冒充「没变」）；三种 reason 可区分'
    + '（`payload-not-an-object` / `change-not-found` / `no-usable-lines`）；且**不抛错**',
  emptyThrew === null && emptyReport.every((line) => !line.startsWith('!!'))
  && out.degraded === false && out.reason === null,
  `抛错=${emptyThrew ?? '无'}；${emptyReport.join(' | ')}`)

  // ---------- 7. 确定性 ----------
  const d1 = JSON.stringify(detail(CLEAN))
  const d2 = JSON.stringify(detail(CLEAN))
  const shuffledKeys = { change: CLEAN.change, as_of: CLEAN.as_of, view: CLEAN.view }
  const d3 = JSON.stringify(detail(shuffledKeys))
  const reversed = { view: CLEAN.view, as_of: CLEAN.as_of,
    change: { ...CLEAN.change, lines: [...CLEAN.change.lines].reverse() } }
  const d4 = JSON.stringify(detail(reversed))
  const clockA = await mountWith({ now: '2020-01-01T00:00:00Z' })
  const clockB = await mountWith({ now: '2036-12-31T23:59:59Z' })
  const d5 = JSON.stringify(clockA.box.handle.change_detail(CLEAN))
  const d6 = JSON.stringify(clockB.box.handle.change_detail({ ...CLEAN, now: '1999-01-01T00:00:00Z' }))
  const other = await mountWith({})
  const d7 = JSON.stringify(other.box.handle.change_detail(CLEAN))
  const frozen = JSON.stringify(detail(deepFreeze(JSON.parse(JSON.stringify(CLEAN)))))
  const timeKeys = /"(ts|at|now|time|elapsed|date|generated_at)"\s*:/.test(d1)
  check('7 确定性负控：同输入两次逐字节一致 / **键序打乱**一致 / **行顺序逆序**一致 / 跨实例一致 / '
    + '两个墙钟入口（载荷 `now` 与配置 `now`）给任何值输出都不变 / **冻结输入**不抛错'
    + '（严格模式下任何对入参的写入都会抛 TypeError ⇒ 证明没偷偷改调用方的载荷）/ 输出里没有时间键'
    + '（`as_of` 是入参事实的回显，不是本层取的时钟）',
  d1 === d2 && d2 === d3 && d3 === d4 && d4 === d5 && d5 === d6 && d6 === d7 && frozen === d1
  && d1.length > 600 && !timeKeys,
  `两次=${d1 === d2} 键序=${d2 === d3} 行逆序=${d3 === d4} 墙钟A=${d4 === d5} 墙钟B=${d5 === d6} `
  + `跨实例=${d6 === d7} 冻结输入=${frozen === d1} 长度=${d1.length} 含时间键=${timeKeys}`)

  // ---------- 8. 有界与 omitted ----------
  const cap = await mountWith({ max_items: 2 })
  const capOut = cap.box.handle.change_detail(CLEAN)
  const big = await mountWith({ max_items: 1000 })
  const low = await mountWith({ max_items: 0 })
  const manyLines = []
  for (let index = 0; index < 65; index += 1) {
    manyLines.push({ line_id: `L-${String(index).padStart(3, '0')}`, qty_before: 1, unit_price_before: 100,
      qty_after: 1, unit_price_after: 100 })
  }
  const many = detail({ view: 'supplier', as_of: CLEAN.as_of, change: { change_id: 'CO-65', lines: manyLines } })
  let badLimit = null
  try { badLimit = await mountWith({ max_items: 'many' }) } catch (err) { badLimit = { refused: String(err).slice(0, 40) } }
  check('8 有界与 `omitted` 诚实：`max_items` 夹取（2 ⇒ 展示 2 行；0 ⇒ 下界 1；1000 ⇒ 上界 200；'
    + '非数字 ⇒ 挂载即拒或回落默认）；输入行数上限 64（65 行 ⇒ `lines_not_read=1` 且照实报）；'
    + '`shown + omitted == usable`；**截断只影响展示：小计仍按全部可用行算**（口径不被截断改写）',
  capOut.lines.length === 2 && capOut.counts.omitted === 2 && capOut.truncated === true
  && capOut.subtotal.amount_before === HAND_SUBTOTAL.before
  && capOut.counts.lines_shown + capOut.counts.omitted === capOut.counts.lines_usable
  && low.box.handle.change_detail(CLEAN).lines.length === 1
  && big.box.handle.change_detail(CLEAN).lines.length === 4
  && many.counts.lines_found === 65 && many.counts.lines_read === 64 && many.counts.lines_not_read === 1
  && many.lines.length === 20 && many.counts.omitted === 44
  && many.notes.some((text) => text.includes('截断只影响展示'))
  && badLimit !== null && (badLimit.refused !== undefined || badLimit.box.handle.change_detail(CLEAN).lines.length === 4),
  `上限 2 → 行 ${capOut.lines.length} omitted=${capOut.counts.omitted} 小计仍=${capOut.subtotal.amount_before}；`
  + `上限 0 → ${low.box.handle.change_detail(CLEAN).lines.length}；上限 1000 → ${big.box.handle.change_detail(CLEAN).lines.length}；`
  + `65 行 → 读 ${many.counts.lines_read} 未读 ${many.counts.lines_not_read} 展示 ${many.lines.length} omitted ${many.counts.omitted}；`
  + `'many' → ${badLimit?.refused === undefined ? '回落默认' : `挂载即拒：${badLimit.refused}`}`)

  // ---------- 9. 私域两侧扫（含非空转对照） ----------
  const cleanSupplier = JSON.stringify(detail(CLEAN))
  const dirtySupplier = JSON.stringify(detail(dirtyFor('supplier')))
  const owner = detail(dirtyFor('contractor'))
  const ownerText = JSON.stringify(owner)
  const hitsSupplier = HAND_SENTINELS.filter((needle) => dirtySupplier.includes(needle))
  const keysSupplier = PRIVATE_NEEDLES.filter((needle) => dirtySupplier.includes(needle))
  const hitsOwner = HAND_SENTINELS.filter((needle) => ownerText.includes(needle))
  const keysOwner = PRIVATE_NEEDLES.filter((needle) => ownerText.includes(needle))
  const inputHits = HAND_SENTINELS.filter((needle) => JSON.stringify(DIRTY_LINES).includes(needle))
  check('9 **私域哨兵零泄漏（两面都扫）**：供应商侧带哨兵与不带哨兵输出**逐字节一致**、哨兵与键名 0 命中、'
    + '`privacy.private_keys_read=false`；**非空转对照**：同一份载荷在**承包商侧**确实看得到自己的私域列'
    + '（哨兵与键名命中 ≥3、`private_columns` 非空、`private_keys_read=true`）',
  dirtySupplier === cleanSupplier && hitsSupplier.length === 0 && keysSupplier.length === 0
  && detail(CLEAN).privacy.private_keys_read === false && hitsOwner.length >= 3 && keysOwner.length >= 3
  && owner.private_columns.length > 0 && owner.privacy.private_keys_read === true && inputHits.length >= 3,
  `供应商：逐字节一致=${dirtySupplier === cleanSupplier} 哨兵命中=${hitsSupplier.join(',') || '无'} `
  + `键名命中=${keysSupplier.join(',') || '无'}；承包商侧命中=${hitsOwner.join(',')} `
  + `键名=${keysOwner.join(',')} 私域列 ${owner.private_columns.length} 条；输入对照=${inputHits.length} 个哨兵`)

  // ---------- 10. 零写面 / 恒等申报 ----------
  const FORBIDDEN = ['writeFile', 'appendFile', 'createWriteStream', 'readFileSync', 'openLedger', 'ledger',
    'Date.now', 'new Date', 'Math.random', 'process.env', 'fetch(', 'spawn', 'execFile', 'setInterval(',
    'setTimeout(', 'ctx.on(', 'ctx.events', 'child_process', 'require(', 'http.request', 'net.connect']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(originalSource)
  const selfTest = scan(`const t = set${'Timeout'}(() => {}, 1); open${'Ledger'}(p); await fetch${'('}(u)`)
  check('10 零写面负控：产物**零写面、不读账本、不联网、不调模型、不取墙钟**（无写/读文件、账本、墙钟、'
    + '随机、网络、子进程、事件订阅、定时器）；`privacy` 四项如实申报（含 `clock_reads=0`）；'
    + '扫描器**非空转**（对照样本必须命中 ≥3）',
  hits.length === 0 && selfTest.length >= 3 && out.privacy.model_calls === 0
  && out.privacy.network_calls === 0 && out.privacy.clock_reads === 0
  && JSON.stringify(out.ignored_now_inputs) === JSON.stringify(['payload.now', 'config.now'])
  && meta.money_unit === 'cents' && meta.rounding === 'half-up-to-cent'
  && meta.can_approve === false && JSON.stringify(meta.private_column_views) === JSON.stringify(['contractor']),
  `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}；`
  + `privacy=${JSON.stringify(out.privacy)}；meta.money=${meta.money_unit}/${meta.rounding}；`
  + `can_approve=${meta.can_approve}`)

  // ---------- 11. 宿主侧契约（静态） ----------
  const routeOk = /\/api\/changes\//.test(webuiSource) && /\/changes\//.test(webuiSource)
    && webuiSource.includes('change_detail')
  const linkOk = webuiSource.includes('data-change-detail-link')
  // 四道页面的子导航入口：`subNav`（双方视角）与 `anchorNav`（运维/系统管理两道）各一处声明，
  // 两道页面各传入「审批与变更（承包商）」「审批与变更（供应商）」两个入口。
  const navDecls = webuiSource.split('data-gates-link').length - 1
  const navLabels = ['审批与变更（承包商）', '审批与变更（供应商）']
    .every((label) => webuiSource.includes(label))
  const fourRoutes = navDecls >= 2 && navLabels
  const webuiCode = webuiSource.split('\n').filter((line) => !line.trim().startsWith('//')
    && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n')
  const inlineEvent = /\son[a-z]+\s*=/i
  check('11 宿主侧契约（静态）：两条新路由（`/<view>/api/changes/<id>` 与 `/<view>/changes/<id>/`）都在 '
    + 'webui 里；变更单列表**每一行链到自己的明细页**（`data-change-detail-link`）；四道页面子导航仍带 '
    + '`data-gates-link`；页面模板 **0 内联脚本 / 0 内联事件**（扫描器非空转）',
  routeOk && linkOk && fourRoutes && !webuiCode.includes(scriptNeedle) && !inlineEvent.test(webuiCode)
  && (scriptNeedle === '<scr' + 'ipt' && inlineEvent.test('<a onclick="x()">')),
  `路由=${routeOk} 明细链接=${linkOk} 四道入口=${fourRoutes}；`
  + `webui 含脚本字面量=${webuiCode.includes(scriptNeedle)} 含内联事件=${inlineEvent.test(webuiCode)}`)

  // ---------- 12. 真 HTTP ----------
  const fixtureDir = mkdtempSync(join(tmpdir(), 't283-http-'))
  const contractorLedger = join(fixtureDir, 'contractor.jsonl')
  const supplierLedger = join(fixtureDir, 'supplier.jsonl')
  const uiShared = join(fixtureDir, 'ui-shared')
  mkdirSync(uiShared, { recursive: true })
  // 账本侧的金额是**元**（小数；与 `services/change.py` 的既有写法同口径），宿主按 half-up 折算成整数分：
  //   60 元 → 6000 分、10.01 元 → 1001 分、0 元 → 0 分；数量是整数件。
  const httpLines = (extra) => [
    { line_id: 'L-001', desc: '钢筋', qty_before: 10, unit_price_before: 60, qty_after: 12,
      unit_price_after: 60, ...extra },
    { line_id: 'L-002', desc: '水泥', qty_before: 3, unit_price_before: 10, qty_after: 3,
      unit_price_after: 15, ...extra },
    { line_id: 'L-003', desc: '砂石', qty_before: 3, unit_price_before: 20, qty_after: null,
      unit_price_after: 25, ...extra },
    { line_id: 'L-004', desc: '模板', qty_before: 0, unit_price_before: 0, qty_after: 5,
      unit_price_after: 10, ...extra },
    { line_id: 'L-005', desc: '拆改', qty_before: 3, unit_price_before: 10, qty_after: 1,
      unit_price_after: 10.01, ...extra },
  ]
  const ownerOnly = { cost_floor: HAND_SENTINELS[0], reserve_price: HAND_SENTINELS[2],
    'private:note': HAND_SENTINELS[1] }
  const rowsFor = (extra) => [
    { seq: 1, type: 'change/priced', correlation_id: 'CO-0001', actor: 'agent:change',
      ts: '2026-09-25T11:00:00Z', realm: 'contractor:con-B',
      body: { change_id: 'CO-0001', quote_id: 'q-1', delta_amount: 165.01,
        basis_unit_price_refs: ['q-1#L-001:unit_price'], lines: httpLines(extra) } },
    // 私域行：带 `private:` 命名的键 → 整行跳过，但夹具文件里**确实有哨兵**（非空转对照）
    { seq: 2, type: 'quote/submitted', correlation_id: 'q-private', actor: 'agent:supplier',
      ts: '2026-09-25T11:30:00Z', realm: 'contractor:con-B',
      body: { quote_id: 'q-private', lines: [{ item_id: 'L-001', qty: 10, unit_price: 60 }],
        cost_floor: HAND_SENTINELS[4], markup_pct: 12.5, reserve_price: HAND_SENTINELS[2],
        cost_model: HAND_SENTINELS[0], 'private:note': HAND_SENTINELS[1] } },
    // 批准事件**不带行清单**：逐行明细的真源必须是上面那条带行的 `change/priced`
    // （不能拿"最后一条 change/* 事件"当明细来源 —— 否则真实账本上明细会整张变空）
    { seq: 3, type: 'change/approved', correlation_id: 'CO-0001', actor: 'human:liangzi',
      ts: '2026-09-25T11:30:00Z', realm: 'contractor:con-B',
      body: { change_id: 'CO-0001', quote_id: 'q-1', delta_amount: 165.01, approved_by: 'human:liangzi' } },
  ]
  writeFileSync(contractorLedger, rowsFor(ownerOnly).map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  writeFileSync(supplierLedger,
    rowsFor({ internal_notes: HAND_SENTINELS[3], cost_model: HAND_SENTINELS[0] })
      .map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const ledgerHash = sha256(readFileSync(contractorLedger, 'utf8'))
  const fixtureHas = HAND_SENTINELS.filter((needle) => readFileSync(contractorLedger, 'utf8').includes(needle))

  const httpCtx = new Context()
  await httpCtx.plugin(EventsService)
  const httpBox = {}
  httpCtx.provide('ledgerView', { path: '(t283-fixture)', rows: () => [], count: () => 0,
    verify: () => ({ ok: true, checked: 0, count: 0, head: 'sha256:' + '0'.repeat(64) }), byType: () => [] })
  const mountReal = async (file, raw, service, name) => {
    const loaded = await import(pathToFileURL(join(HERE, 'modules', file)).href)
    await httpCtx.plugin({
      name: `${name}#t283`,
      inject: loaded.inject ?? [],
      Config: loaded.Config,
      apply: async (inner, config) => {
        const originalProvide = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) httpBox[service] = v; return originalProvide(s, v) }
        await loaded.apply(inner, config)
      },
    }, loaded.Config.parse(raw))
    return loaded
  }
  await mountReal('governor.mjs', {}, 'governor', 'governor')
  await mountReal('audit-hook.mjs', { capacity: 20 }, 'audit', 'audit-hook')
  await mountReal('canary.mjs', { weight_bps: 0 }, 'canary', 'canary')
  await mountReal('observability.mjs', {}, 'observability', 'observability')
  await mountReal('price-history.mjs', { key_field: 'supplier_id' }, 'priceHistory', 'price-history')
  await mountReal('evidence-summary.mjs', {}, 'evidenceSummary', 'evidence-summary')
  await mountReal('circuit-breaker.mjs', {}, 'breaker', 'circuit-breaker')
  await mountReal('ops-view.mjs', {}, 'opsView', 'ops-view')
  await mountReal('evolve-journal.mjs', {}, 'evolveJournal', 'evolve-journal')
  await mountReal('supplier-scorecard.mjs', {}, 'supplierScorecard', 'supplier-scorecard')
  await mountReal('approval-digest.mjs', {}, 'approvalDigest', 'approval-digest')
  await mountReal('retention-view.mjs', {}, 'retentionView', 'retention-view')
  await mountReal('pipeline-view.mjs', {}, 'pipelineView', 'pipeline-view')
  await mountReal('admin-guard.mjs', { token_env: 'QUOTAGENT_ADMIN_TOKEN_T283' }, 'adminGuard', 'admin-guard')
  await mountReal('admin-view.mjs', { admin_snapshot: '' }, 'adminView', 'admin-view')
  await mountReal('plugin-market.mjs', { modules_dir: join(HERE, 'modules'),
    inventory: join(HERE, '..', 'docs', 'design', '14-plugin-inventory.md'), user_space: '' }, 'pluginMarket', 'plugin-market')
  await mountReal('user-plugin-manager.mjs', { root: join(HERE, '..', 'user-space') }, 'userPluginManager', 'user-plugin-manager')
  await mountReal('config-view.mjs', {}, 'configView', 'config-view')
  await mountReal('mail-view.mjs', { mail_state: '', ui_shared: '' }, 'mailView', 'mail-view')
  await mountReal('bid-heuristics.mjs', {}, 'bidHeuristics', 'bid-heuristics')
  await mountReal('advice-panel.mjs', {}, 'advicePanel', 'advice-panel')
  await mountReal('gate-timeline.mjs', {}, 'gateTimeline', 'gate-timeline')
  await mountReal('authority-band.mjs', {}, 'authorityBand', 'authority-band')
  await mountReal('rfq-deadline.mjs', {}, 'rfqDeadline', 'rfq-deadline')
  // 同批新增的 `quote-prepare`（webui 的 inject 依赖它）：同为 domain 插件，默认配置即可
  await mountReal('quote-prepare.mjs', {}, 'quotePrepare', 'quote-prepare')
  await mountReal('ui-feedback.mjs', { ui_shared: '' }, 'uiFeedback', 'ui-feedback')
  const projection = await import(pathToFileURL(join(HERE, 'modules', 'projection.mjs')).href)
  await httpCtx.plugin({ name: 'projection#t283', inject: [], Config: projection.Config,
    apply: (inner, config) => projection.apply(inner, config) }, projection.Config.parse({}))
  const webui = await import(pathToFileURL(WEBUI).href)
  const httpFiber = await httpCtx.plugin({
    name: 'webui#t283',
    inject: webui.inject,
    Config: webui.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'webui') httpBox.webui = v; return originalProvide(s, v) }
      await webui.apply(inner, config)
    },
  }, webui.Config.parse({ port: 0, route_prefix: '/t283', ledger_contractor: contractorLedger,
    ledger_supplier: supplierLedger, ui_shared: uiShared }))
  const base = httpBox.webui.url.replace(/\/$/, '')
  // 身份会话（P3：`/contractor/**`、`/supplier/**` 有了**路由级身份门槛**）——
  // 本门**先登录再取业务路由**：判据从「谁能打开」变成「**登录后按侧放行**」，断言一条不删、一条不放松。
  const SESSIONS = {}
  const loginAs = async (side) => {
    if (SESSIONS[side]) return SESSIONS[side]
    const res = await fetch(`${base}/identity/login?format=json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: `gate-t283-${side}`, side }).toString(),
    })
    const text = await res.text()
    const cookie = String(res.headers.get('set-cookie') ?? '').split(';')[0]
    if (res.status !== 200 || !cookie.startsWith('qa_identity=')) {
      throw new Error(`门夹具登录失败：side=${side} status=${res.status} body=${text.slice(0, 200)}`)
    }
    SESSIONS[side] = cookie
    return cookie
  }
  const cookieFor = async (path) => {
    const side = /^\/(contractor|supplier)(?:\/|$)/.exec(String(path))?.[1]
    return side ? { cookie: await loginAs(side) } : {}
  }
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: await cookieFor(path) })
    return { status: res.status, text: await res.text() }
  }
  // 身份门槛本身也要机检（P3：未登录拒 / 登录后按侧放行 / 越侧 403）
  const anonJson = await fetch(`${base}/contractor/api/changes/CO-0001`, { headers: { accept: 'application/json' } })
  const anonJsonBody = await anonJson.text()
  const anonHtml = await fetch(`${base}/contractor/changes/CO-0001/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  const anonLocation = String(anonHtml.headers.get('location') ?? '')
  const crossSidePath = 'supplier/changes/CO-0001/'
  const crossSide = await fetch(`${base}/${crossSidePath}`, { headers: { cookie: await loginAs('contractor') } })
  const crossBody = await crossSide.text()
  check('身份门槛（P3）：未登录取业务路由 ⇒ API 401 `identity-required` + `next`、浏览器 303 回 `/identity/?next=…`；'
    + '登录后**按侧放行**（同侧 200）、**越侧 403 `side-mismatch`**（不回落成「能看」）',
  anonJson.status === 401 && anonJsonBody.includes('identity-required') && anonJsonBody.includes('"next"')
  && anonHtml.status === 303 && anonLocation.includes('/t283/identity/?next=')
  && crossSide.status === 403 && crossBody.includes('side-mismatch')
  && (await get('/contractor/changes/CO-0001/')).status === 200,
  `未登录 JSON=${anonJson.status} HTML=${anonHtml.status} location=${anonLocation.slice(0, 60)}；`
  + `越侧=${crossSide.status} 含 side-mismatch=${crossBody.includes('side-mismatch')}`)
  const inlineEvent2 = /\son[a-z]+\s*=/i
  const json = (text) => { try { return JSON.parse(text) } catch { return {} } }

  const routes = json((await get('/api/routes')).text).routes ?? []
  const changeRoutes = routes.filter((row) => String(row.path).includes('/changes/'))
  const cPage = await get('/contractor/changes/CO-0001/')
  const cJson = await get('/contractor/api/changes/CO-0001')
  const sPage = await get('/supplier/changes/CO-0001/')
  const sJson = await get('/supplier/api/changes/CO-0001')
  const cPageMissing = await get('/contractor/changes/CO-9999/')
  const cJsonMissing = await get('/contractor/api/changes/CO-9999')
  const listPage = await get('/contractor/gates/')
  const cj = json(cJson.text)
  const sj = json(sJson.text)
  const linesOk = (payload) => Array.isArray(payload.lines) && payload.lines.length === 4
    && payload.lines.every((line, index) => {
      const id = line.line_id
      const hand = HAND_LINES[id]
      return Boolean(hand) && line.amount_before === hand.ab && line.amount_after === hand.aa
        && line.delta_amount === hand.d && line.delta_amount === line.amount_after - line.amount_before
        && (hand.pct === null ? line.delta_pct === null : line.delta_pct === hand.pct / 100)
        && index >= 0
    })
  const pagesOk = [cPage.text, sPage.text].every((text) => text.includes('data-money-unit="cents"')
    && text.includes('data-rounding="half-up-to-cent"') && text.includes('未纳入小计')
    && text.includes('data-detail-line="L-001"') && text.includes('data-detail-missing="L-003"')
    && text.includes('data-subtotal-delta') && text.includes('data-subnav=')
    && text.includes('data-gates-link="1"') && text.includes('data-detail-back="1"')
    && !text.includes(scriptNeedle) && !inlineEvent2.test(text))
  check('12 真 HTTP 正控：两视角明细页/JSON 各自 **200**、`/api/routes` 登记四条新路由且 `auth=identity-session`（业务路由要身份会话）、'
    + '变更单列表每一行有 `data-change-detail-link="CO-0001"`；页面/JSON 的数字与**手算一致**'
    + '（账本里的**元**由宿主按 half-up 折算成整数分：60 元 → 6000 分、10.01 元 → 1001 分；4 行、'
    + 'L-003 在「未纳入小计的行」里、小计 66000→82501 差 16501）；**明细真源是带行清单的那条事件**'
    + '（夹具里它**之后**还有一条不带行的 `change/approved`，明细不得因此变空）；'
    + '4 份响应 **0 行脚本 / 0 内联事件**；**与账本自己的声明对齐**：账本行 `delta_amount=165.01` 元 '
    + '⇒ 本页复算的总计差额 16501 分',
  changeRoutes.length === 4 && changeRoutes.every((row) => row.auth === 'identity-session')
  && cPage.status === 200 && cJson.status === 200 && sPage.status === 200 && sJson.status === 200
  && pagesOk && linesOk(cj) && linesOk(sj)
  && cj.subtotal.amount_before === HAND_SUBTOTAL.before && cj.subtotal.amount_after === HAND_SUBTOTAL.after
  && cj.subtotal.delta_amount === 16501 && sj.subtotal.delta_amount === HAND_SUBTOTAL.delta
  && cj.lines[0].unit_price_before === 6000
  && sj.basis_missing.length === 1 && sj.basis_missing[0].line_id === 'L-003'
  && listPage.text.includes('data-change-detail-link="CO-0001"'),
  `status=${cPage.status}/${cJson.status}/${sPage.status}/${sJson.status}；路由=`
  + `${JSON.stringify(changeRoutes.map((row) => `${row.method} ${row.path}`))}；`
  + `页面契约=${pagesOk}；JSON 逐行对账=${linesOk(cj)}/${linesOk(sj)}；`
  + `小计 ${cj.subtotal.amount_before}→${cj.subtotal.amount_after}（差 ${cj.subtotal.delta_amount}）`)

  check('12b 真 HTTP 负控（未知 id）：页面与 JSON **都是 404** 且都带非空 `next_action`'
    + '（不静默返回空页、不编行）；未提权 `/admin/` 仍 401 固定体（既有路由没被弄坏）',
  cPageMissing.status === 404 && cJsonMissing.status === 404
  && json(cJsonMissing.text).degraded === true && json(cJsonMissing.text).reason === 'change-not-found'
  && String(json(cJsonMissing.text).next_action).length > 10
  && cPageMissing.text.includes('change-not-found') && (await get('/admin/')).status === 401,
  `页面=${cPageMissing.status} JSON=${cJsonMissing.status} reason=${json(cJsonMissing.text).reason}；`
  + `next_action=${String(json(cJsonMissing.text).next_action).slice(0, 50)}…`)

  check('12c 真 HTTP 私域（两面都扫）：承包商侧明细页/JSON 里**看得到自己的私域列**（非空转对照），'
    + '供应商侧明细页/JSON 里哨兵与私域键名 **0 命中**（夹具文件里确实有哨兵）；且这份明细路由**只读**'
    + '（GET 前后夹具账本逐字节一致）',
  (cPage.text + cJson.text).includes('data-detail-private="1')
  && HAND_SENTINELS.some((needle) => (cPage.text + cJson.text).includes(needle))
  && !HAND_SENTINELS.some((needle) => (sPage.text + sJson.text).includes(needle))
  && !PRIVATE_NEEDLES.some((needle) => (sPage.text + sJson.text).includes(needle))
  && fixtureHas.length >= 3 && sha256(readFileSync(contractorLedger, 'utf8')) === ledgerHash
  && (sPage.text + sJson.text).includes('读都不读'),
  `承包商侧私域列=${(cPage.text + cJson.text).includes('data-detail-private="1')} `
  + `哨兵命中=${HAND_SENTINELS.filter((needle) => (cPage.text + cJson.text).includes(needle)).join(',')}；`
  + `供应商侧命中=${HAND_SENTINELS.filter((needle) => (sPage.text + sJson.text).includes(needle)).join(',') || '无'} `
  + `键名=${PRIVATE_NEEDLES.filter((needle) => (sPage.text + sJson.text).includes(needle)).join(',') || '无'}；`
  + `夹具里确实有哨兵=${fixtureHas.length}；账本未变=${sha256(readFileSync(contractorLedger, 'utf8')) === ledgerHash}`)

  const again = await get('/contractor/api/changes/CO-0001')
  check('12d 真 HTTP 确定性：同一 URL 两次 GET **逐字节一致**（明细不随刷新漂移；`as_of` 来自事实 ts）',
    again.text === cJson.text && cj.as_of === '2026-09-25T11:30:00Z'
    && JSON.stringify(cj.ignored_now_inputs) === JSON.stringify(['payload.now', 'config.now']),
    `两次一致=${again.text === cJson.text}；as_of=${cj.as_of}；忽略入口=${JSON.stringify(cj.ignored_now_inputs)}`)

  await httpFiber.dispose()

  // ---------- 13. 单点变异 ----------
  const realFacts = await factsFor((config) => mountWith(config))
  const realAllTrue = SCENARIOS.every((name) => realFacts[name] === true)
  check('13 基线：四条场景（逐行手算对账 / 缺依据不入小计 / 供应商侧哨兵 / 空输入 degraded）在**真产物**上全真'
    + '（否则变异变红就说明不了任何事：基线本来就是红的）',
  realAllTrue, `基线=${JSON.stringify(realFacts)}`)

  const mutationReport = []
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
    const fake = mutated === null || mutated === originalSource
    if (fake) {
      mutationReport.push(`${mutation.name}→假变异`)
      check(`13 变异：${mutation.name}`, false,
        `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
      continue
    }
    const facts = await factsFor((config) => mountMutant(mutated, config))
    const red = SCENARIOS.filter((name) => facts[name] === false)
    mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
    check(`13 变异：${mutation.name}`, red.includes(mutation.mustRed),
      `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts)}；`
      + `字节已变=${mutated !== originalSource}`)
  }

  const fakeGuard = applyMutation(originalSource, '这一段源码里根本不存在-T283-ANCHOR', 'x')
  const selfAnchor = originalSource.includes('export const MONEY_UNIT') ? 'export const MONEY_UNIT' : 'export const name'
  const selfMutation = applyMutation(originalSource, selfAnchor, selfAnchor)
  check('14 防假变异（自检）：找不到唯一锚点的"变异"必须被判定为**假变异**（返回 null），'
    + '把锚点替换成它自己也不算变异 —— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

  const afterHash = sha256(sourceOf(TARGET))
  const afterWebui = sha256(sourceOf(WEBUI))
  check('14 还原：本门全程**没有写过产品树** —— `host/modules/gate-timeline.mjs` 与 `host/modules/webui.mjs` '
    + '跑完之后与跑之前**逐字节一致**（变异只写在临时目录的副本里）',
  afterHash === originalHash && sourceOf(TARGET) === originalSource && afterWebui === webuiHash,
  `gate-timeline sha256 前=${originalHash.slice(0, 16)}… 后=${afterHash.slice(0, 16)}…；`
  + `webui 未变=${afterWebui === webuiHash}；变异小结=${mutationReport.join('；')}`)

  for (const mounted of [live, other, cap, big, low, clockA, clockB, ...(badLimit?.box ? [badLimit] : [])]) {
    try { await mounted.fiber.dispose() } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 300)}`)
}

finish()
