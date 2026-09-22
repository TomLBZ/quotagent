/**
 * t279-heuristics-gate —— T-279「比价 heuristics visualizer」的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 被围对象：`host/modules/bid-heuristics.mjs`（domain 插件）+ 它在 `webui` 里的两条路由
 * （`GET /quotagent/<view>/heuristics/`、`GET /quotagent/<view>/api/heuristics`）。
 *
 * 断言（26 条，含负控、非空转对照与**单点变异**；每条都写清"什么情况下必须变红"）：
 *   1. 契约正控：manifest 齐备 + 只 import ../lib 白名单 + 源码里 0 个脚本字面量
 *   2. 挂载正控：provide 拦截拿得到句柄（rank/factors/config）；dispose 后 effect 归零
 *   3. 手算正控：三家候选逐字段等于**手算**（算式写在注释里，不用实现验实现）+ 行键集固定
 *   4. 口径正控：与 `services/compare.py` 的 Σw·minmax（升序）**等价**（本插件分 = 100 − 那个分）
 *   5. 负控：确定性（同输入两次逐字节一致 / 跨实例一致 / 输入逆序一致 / 输出里没有时间键）
 *   6. 正控：**权重敏感非空转**（只改一个权重 → 分数与名次都变；原始行写进 detail）
 *   7. 负控：权重越界**夹取并回显**（回显请求原值 + 人话说明 + applied 是夹取后的真值）
 *   8. 负控：归一化**和为一**（绝对容差 1e-9 写清）+ 全零权重回落默认（不输出 NaN）
 *   9. 负控：**私域哨兵零泄漏**且**不参与计算**（带哨兵与不带哨兵输出逐字节一致）
 *  10. 负控：**无绝对量级**（原始单价/交期/质保/账期/偏差的数值一个都不出现在输出里）
 *  11. 负控：有界与 `omitted` 诚实（截断报数；且归一化基数仍是全体 → 分数与不截断时相同）
 *  12. 负控：`degraded` 可分辨（坏输入 → 有名 reason；正常 → false + reason null；两种空法不同）
 *  13. 负控：不编造（缺因子记 missing 不记 0；无代号的候选不进排名；字符串数字按取不到）
 *  14. 负控：零写面/不读账本（静态扫描 + **扫描器非空转对照**）
 *  15. 正控：贡献点解释得分（Σ贡献 == score，容差 point_tolerance）+ hint 不含原始数值
 *  16. 正控：fixture 纯读取 + 冻结输入不抛错（没偷偷改调用方的候选）
 *  17. 负控：配置不得静默放行（未知键/错类型/非对象/翻转 const）
 *  18-21. **真 HTTP**（in-process 挂载真 `webui` + 真依赖模块 + 夹具账本）：
 *      两视角页面 200 + 道内子导航 + GET 表单 + 排名表；**0 行脚本 / 0 内联事件**；
 *      改权重 → 响应体与 data-score 都不同；两视角页面/JSON 私域哨兵 0 命中（并有非空转对照）
 *  22-26. **单点变异**：4 处变异各自必须让**指定的**断言变红（且变异必须真的改了字节），
 *      全程 `host/modules/bid-heuristics.mjs` 字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t279-heuristics-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, 'modules', 'bid-heuristics.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

// 门自己注入的**假** admin token：只为在夹具里取到第四道页面（`/t279/admin/`，提权后）的 HTML。
// 值不落任何文件、不出本进程；admin-guard 在 apply() 时读它（见 admin-guard 的 configured）。
const T279_TOKEN = 't279-gate-token-7c41'
process.env.QUOTAGENT_ADMIN_TOKEN_T279 = T279_TOKEN

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红的（"没跑到"不得当成"通过"）
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 产物加载：先装解析钩子（把 `../lib/std-schema.mjs` 指到真库），再动态 import。
// 变异体在**临时目录**里跑（绝不写产品树）→ 也依赖这个钩子才解析得到同一个库（无双实例）。
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

const sourceOf = (path) => readFileSync(path, 'utf8')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const originalSource = sourceOf(TARGET)
const originalHash = sha256(originalSource)

const mod = await import(pathToFileURL(TARGET).href)

/** 挂载：照抄产物声明的 `inject`，包装 `provide` 抓句柄。 */
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

/** 从**临时副本**挂载变异体（`?v=` 破缓存；返回 handle）。 */
const mountMutant = async (mutatedSource, raw = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 't279-mut-'))
  const file = join(dir, `bid-heuristics.mut-${sha256(mutatedSource).slice(0, 8)}.mjs`)
  writeFileSync(file, mutatedSource, 'utf8')
  const mutant = await import(`${pathToFileURL(file).href}?v=${sha256(mutatedSource).slice(0, 8)}`)
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  await ctx.plugin({
    name: `${mutant.name}#mutant`,
    inject: mutant.inject,
    Config: mutant.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((mutant.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await mutant.apply(inner, config)
    },
  }, mutant.Config.parse(raw))
  return { ctx, box, mutant, file, dir }
}

/** 单点变异：找不到/多于一处的"变异"是**假变异**（返回 null，调用方必须判红）。 */
const applyMutation = (text, find, replace) => {
  const count = text.split(find).length - 1
  if (count !== 1 || find === replace || !replace) return null
  return text.replace(find, replace)
}

/** 递归找非有限数（`JSON.stringify` 会把 NaN 写成 null，扫文本是抓不到的）。 */
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
const r12 = (value) => Math.round(value * 1e12) / 1e12
const rowsOf = (payload) => (payload.rows ?? []).map(({ rank, code, score, contributions }) =>
  ({ rank, code, score, contributions }))

// ===========================================================================
// 夹具 + 手算表
// ===========================================================================
/**
 * 手算表（**不跑实现算出来的**；公式：极差归一 q∈[0,1]（1=最好），score=100·Σw·q，
 * 权重默认 {price:.6, delivery:.15, payment:.1, warranty:.05, deviation:.1}，和为一）：
 *   sup-A：单价 100（最高）→ q_price=0；交期 10（最短）→ q=1；账期 30（最短）→ q=1；
 *          质保 12（最短）→ q=0；偏差 0（最少）→ q=1
 *          → score = 100·(.6·0 + .15·1 + .1·1 + .05·0 + .1·1) = 0 + 15 + 10 + 0 + 10 = 35
 *   sup-B：单价 80（最低）→ 1；交期 20（最长）→ 0；账期 45（最长）→ 0；质保 24（最长）→ 1；偏差 2（最多）→ 0
 *          → score = 60 + 0 + 0 + 5 + 0 = 65
 *   sup-C：只给得出单价 90（介于 80/100）→ q_price = 1 − (90−80)/20 = 0.5；
 *          只在取得到的因子上归一（分母 = w_price = 0.6）→ score = 100·(.6·0.5)/.6 = 50
 *   名次（分数降序，同分按代号字典序）：sup-B 65 → sup-C 50 → sup-A 35
 * 对照 `services/compare.py`（Σw·minmax，越小越好，升序）：
 *   sup-A：.6·1 + .15·0 + .1·0 + .05·1 + .1·0 = 0.65 → 65 分 = 100 − 35 ✓
 *   sup-B：.6·0 + .15·1 + .1·1 + .05·0 + .1·1 = 0.35 → 35 分 = 100 − 65 ✓
 */
const HAND_PAYLOAD = {
  weights: { price: 0.6, delivery: 0.15, payment: 0.1, warranty: 0.05, deviation: 0.1 },
  candidates: [
    { code: 'sup-A', unit_price: 100, lead_time_days: 10, payment_terms: 30, warranty_months: 12, deviation_count: 0 },
    { code: 'sup-B', unit_price: 80, lead_time_days: 20, payment_terms: 45, warranty_months: 24, deviation_count: 2 },
    { code: 'sup-C', unit_price: 90 },
  ],
}
const HAND_EXPECT = [
  { rank: 1, code: 'sup-B', score: 65, contributions: { price: 60, delivery: 0, payment: 0, warranty: 5, deviation: 0 } },
  { rank: 2, code: 'sup-C', score: 50, contributions: { price: 50, delivery: 0, payment: 0, warranty: 0, deviation: 0 } },
  { rank: 3, code: 'sup-A', score: 35, contributions: { price: 0, delivery: 15, payment: 10, warranty: 0, deviation: 10 } },
]
/** 与 `services/compare.py` 同口径的**独立**实现（门自己算，用来证明"名次一致"）。 */
const compareStyleScores = (payload) => {
  const factors = [['price', 'unit_price', 1], ['delivery', 'lead_time_days', 1], ['payment', 'payment_terms', 1],
    ['warranty', 'warranty_months', -1], ['deviation', 'deviation_count', 1]]
  const weighted = payload.weights
  const total = Object.values(weighted).reduce((sum, value) => sum + value, 0)
  const out = {}
  for (const [factor, field, sign] of factors) {
    const values = payload.candidates.map((item) => (typeof item[field] === 'number' ? item[field] * sign : null))
    const present = values.filter((value) => value !== null)
    const low = Math.min(...present)
    const high = Math.max(...present)
    payload.candidates.forEach((item, index) => {
      const value = values[index]
      if (value === null) return
      const m = high <= low ? 0 : (value - low) / (high - low)
      out[item.code] = (out[item.code] ?? 0) + (weighted[factor] / total) * m
    })
  }
  return Object.fromEntries(Object.entries(out).map(([code, m]) => [code, r12(100 * m)]))
}

/** 变异体要跑的四条场景（与第 3/7/8/11 条断言同口径；真产物必须**四条全真**）。 */
const scenarioFacts = (rank) => {
  const hand = rank(HAND_PAYLOAD)
  const five = rank({
    weights: { price: 1 },
    candidates: Array.from({ length: 5 }, (_, index) => ({
      code: `c${index + 1}`, unit_price: 10 + index, lead_time_days: 50 - index,
    })),
  })
  const clamped = rank({ weights: { price: 5, delivery: -3 }, candidates: HAND_PAYLOAD.candidates })
  const nonSum = rank({ weights: { price: 0.9 }, candidates: HAND_PAYLOAD.candidates })
  return {
    '手算': JSON.stringify(rowsOf(hand)) === JSON.stringify(HAND_EXPECT),
    '夹取回显': clamped.clamp_notes.length >= 2
      && clamped.weights_applied.price === r12(1 / 1.25) && clamped.weights_applied.delivery === 0
      && clamped.weights_requested.price === 5 && clamped.weights_requested.delivery === -3,
    '归一化': Math.abs(nonSum.normalized_sum - 1) <= 1e-9,
    '有界': five.rows.length === 3 && five.omitted === 2 && five.truncated === true,
  }
}
const SCENARIOS = ['手算', '夹取回显', '归一化', '有界']

/** 4 处单点变异（各自只改一处；`mustRed` 是"必须变红"的那条场景）。 */
const MUTATIONS = [
  { name: '变异1：删掉权重夹取（越界原样放行）',
    find: `  if (amount < WEIGHT_MIN) return { value: WEIGHT_MIN, note: \`夹取下界 \${WEIGHT_MIN}\` }
  if (amount > WEIGHT_MAX) return { value: WEIGHT_MAX, note: \`夹取上界 \${WEIGHT_MAX}\` }
  return { value: amount, note: '' }`,
    replace: "  return { value: amount, note: '' }",
    mustRed: '夹取回显' },
  { name: '变异2：去掉"只在取得到的因子上归一"（缺因子被当成 0 参与分母）',
    find: '      const points = 100 * weightsApplied[factor] * q / weightsUsed',
    replace: '      const points = 100 * weightsApplied[factor] * q',
    mustRed: '手算' },
  { name: '变异3：权重不归一（applied 直接当成归一后的权重）',
    find: '    for (const factor of FACTORS) weightsApplied[factor] = round12(applied[factor] / total)',
    replace: '    for (const factor of FACTORS) weightsApplied[factor] = applied[factor]',
    mustRed: '归一化' },
  { name: '变异4：去掉候选上限（名次行不再截断）',
    find: '  const rows = ranked.slice(0, limit).map((item) => ({',
    replace: '  const rows = ranked.slice(0, ranked.length).map((item) => ({',
    mustRed: '有界' },
]

try {
  // ---------- 1. 契约正控 ----------
  const imports = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  const manifest = {
    name: mod.name === 'bid-heuristics',
    inject: Array.isArray(mod.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod.usedServices) && mod.usedServices.length === 0,
    provides: JSON.stringify(mod.provides) === JSON.stringify(['bidHeuristics']),
    config: typeof mod.Config?.['~standard']?.validate === 'function',
    apply: typeof mod.apply === 'function',
    fixture: typeof mod.fixture?.sample === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  const scriptNeedle = '<scr' + 'ipt'
  const scriptInSource = originalSource.includes(scriptNeedle)
  check('1 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[bidHeuristics]/Config/apply/fixture）、'
    + '只 import ../lib 白名单，且源码里 0 个脚本字面量（D-070：字面量本身就会触发可机检事实的断言）',
  manifestBad.length === 0 && importLeaks.length === 0 && !scriptInSource && hookReady,
  `载入=${TARGET}；问题键=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；`
  + `含脚本字面量=${scriptInSource}；解析钩子=${hookReady ? '已装' : '不可用'}；字节=${Buffer.byteLength(originalSource)}`)

  // ---------- 2. 挂载 + 零残留 ----------
  const probe = await mountWith({})
  const probeEffects = probe.fiber.getEffects().length
  const handle = probe.box.handle
  const methodsOk = Boolean(handle) && typeof handle.rank === 'function' && typeof handle.factors === 'function'
    && typeof handle.config === 'function'
  await probe.fiber.dispose()
  const probeAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（rank/factors/config），dispose 后 effect 归零',
    methodsOk && probeEffects > 0 && probeAfter === 0,
    `句柄键=${Object.keys(handle ?? {}).join('|') || '空'}；effect ${probeEffects} → ${probeAfter}`)

  const live = await mountWith({})
  const rank = live.box.handle.rank

  // ---------- 3. 手算正控 ----------
  const hand = rank(HAND_PAYLOAD)
  const ROW_KEYS = 'code|contributions|coverage|focus|hint|item|potential|rank|score'
  const keysFixed = hand.rows.every((row) => Object.keys(row).sort().join('|') === ROW_KEYS)
  const contribKeysFixed = hand.rows.every((row) =>
    Object.keys(row.contributions).join('|') === 'price|delivery|payment|warranty|deviation')
  check('3 手算正控：三家候选的 score/contributions/rank 逐个等于手算值（算式见门顶部注释）+ 输出键集固定',
    JSON.stringify(rowsOf(hand)) === JSON.stringify(HAND_EXPECT) && keysFixed && contribKeysFixed,
    `实得=${JSON.stringify(rowsOf(hand))}；期望=${JSON.stringify(HAND_EXPECT)}；键集固定=${keysFixed}/${contribKeysFixed}`)

  // ---------- 3b. 行项目分组正控（不同行项目的单价不可比） ----------
  const BY_ITEM = [
    { code: 'sup-A', item: 'L-001', unit_price: 100 },
    { code: 'sup-B', item: 'L-001', unit_price: 80 },
    { code: 'sup-A', item: 'L-002', unit_price: 10 },
    { code: 'sup-B', item: 'L-002', unit_price: 10 },
  ]
  const byItem = rank({ weights: { price: 1 }, candidates: BY_ITEM })
  const ordered = byItem.rows.map((row) => `${row.item}:${row.rank}:${row.code}:${row.score}`)
  check('3b 正控：极差归一**按行项目分组**（L-001 的 100/80 与 L-002 的 10/10 各自比 —— 不同行项目的单价'
    + '混在一批里比会把"哪家报价好"变成"哪个行项目贵"）；组内名次 1..n、`baseline`/`counts.items` 自述；'
    + '**非空转对照**：整批都不带行项目时 `baseline=\"whole-set\"`（老口径仍在，不是把分组写死）',
  ordered.join(' | ') === 'L-001:1:sup-B:100 | L-001:2:sup-A:0 | L-002:1:sup-A:100 | L-002:2:sup-B:100'
  && byItem.baseline === 'per-item' && byItem.counts.items === 2
  && hand.baseline === 'whole-set' && hand.counts.items === 1 && hand.rows.every((row) => row.item === '(未给行项目)'),
  `分组后=${ordered.join(' | ')}；baseline=${byItem.baseline}/${hand.baseline}；items=${byItem.counts.items}/${hand.counts.items}`)

  // ---------- 3c. 相同候选去重（重复行不得变成"同一家占两个名次"） ----------
  const dupRow = { code: 'sup-A', item: 'L-001', unit_price: 100, lead_time_days: 10 }
  const dedupe = rank({ weights: { price: 1, delivery: 0, payment: 0, warranty: 0, deviation: 0 },
    candidates: [dupRow, { ...dupRow }, { code: 'sup-B', item: 'L-001', unit_price: 80, lead_time_days: 10 }] })
  check('3c 正控：**完全相同的候选**只保留一条（同项同代号同因子值 → 不产生"同一家占两个名次"的假象），'
    + '去重条数照实报在 `counts.duplicates`（去重不是"偷偷丢行"）',
  dedupe.rows.length === 2 && dedupe.counts.duplicates === 1 && dedupe.counts.unique === 2
  && dedupe.counts.usable === 3 && dedupe.rows.map((row) => row.code).join(',') === 'sup-B,sup-A',
  `rows=${dedupe.rows.map((row) => `${row.rank}:${row.code}:${row.score}`).join(',')}；counts=${JSON.stringify(dedupe.counts)}`)

  // ---------- 4. 口径正控（与 compare.py 等价） ----------
  // 等价性只对**五分量齐备**的候选声明：compare.py 的 TCO 分量永远算得出来（缺的那侧记 0），
  // 本插件对缺因子的候选额外做了"只在取得到的因子上归一" —— 那是**超集**行为，不能拿来当等价性证据。
  const FULL_PAYLOAD = { weights: HAND_PAYLOAD.weights, candidates: HAND_PAYLOAD.candidates.slice(0, 2) }
  const compareScores = compareStyleScores(FULL_PAYLOAD)
  const fullRun = rank(FULL_PAYLOAD)
  const mirrored = Object.fromEntries(fullRun.rows.map((row) => [row.code, r12(100 - row.score)]))
  const compareOrder = Object.entries(compareScores).sort((left, right) => left[1] - right[1]).map(([code]) => code)
  const heuristicsOrder = fullRun.rows.map((row) => row.code)
  const pairs = (object) => JSON.stringify(Object.entries(object).sort())
  check('4 口径正控：对**五分量齐备**的候选，`services/compare.py` 口径（Σw·minmax 升序）与本插件分'
    + '（100 − 那个分）**逐项相等且名次相同**（同一组权重下两个口径不许各说各话 —— "比价口径不一致"痛点的机检落点）',
  pairs(mirrored) === pairs(compareScores) && JSON.stringify(compareOrder) === JSON.stringify(heuristicsOrder),
  `compare 口径=${JSON.stringify(compareScores)} → 名次 ${JSON.stringify(compareOrder)}；`
  + `本插件 100−score=${JSON.stringify(mirrored)} → 名次 ${JSON.stringify(heuristicsOrder)}`)

  // ---------- 5. 确定性 ----------
  const d1 = JSON.stringify(rank(HAND_PAYLOAD))
  const d2 = JSON.stringify(rank(HAND_PAYLOAD))
  const reversed = { ...HAND_PAYLOAD, candidates: [...HAND_PAYLOAD.candidates].reverse() }
  const d3 = JSON.stringify(rank(reversed))
  const other = await mountWith({})
  const d4 = JSON.stringify(other.box.handle.rank(HAND_PAYLOAD))
  const timeKeys = /"(ts|at|now|time|elapsed|date|seq|generated_at)"\s*:/.test(d1)
  check('5 负控：确定性（同输入两次逐字节一致 / 跨实例一致 / 候选逆序一致 / 输出里没有时间字段）',
    d1 === d2 && d2 === d3 && d3 === d4 && d1.length > 200 && !timeKeys,
    `两次一致=${d1 === d2}；逆序一致=${d2 === d3}；跨实例一致=${d3 === d4}；长度=${d1.length}；含时间键=${timeKeys}`)

  // ---------- 6. 权重敏感（非空转） ----------
  const SENS_CANDIDATES = [
    { code: 'a', unit_price: 1, lead_time_days: 9 },
    { code: 'b', unit_price: 2, lead_time_days: 1 },
  ]
  const sensBase = rank({ weights: { price: 0.4, delivery: 0.6, payment: 0, warranty: 0, deviation: 0 },
    candidates: SENS_CANDIDATES })
  const sensChanged = rank({ weights: { price: 0.9, delivery: 0.6, payment: 0, warranty: 0, deviation: 0 },
    candidates: SENS_CANDIDATES })
  const sensLine = `base=${JSON.stringify(rowsOf(sensBase))} changed=${JSON.stringify(rowsOf(sensChanged))}`
  // 非空转对照：两次只差 price 一个权重（其余四个逐字节相同），所以不同必须来自那次改动
  const onlyPriceChanged = ['delivery', 'payment', 'warranty', 'deviation']
    .every((factor) => sensBase.weights_requested[factor] === sensChanged.weights_requested[factor])
    && sensBase.weights_requested.price !== sensChanged.weights_requested.price
  const scoreByCode = (payload) => Object.fromEntries(payload.rows.map((row) => [row.code, row.score]))
  const scoresDiffer = pairs(scoreByCode(sensBase)) !== pairs(scoreByCode(sensChanged))
  const orderDiffers = sensBase.rows.map((row) => row.code).join(',') !== sensChanged.rows.map((row) => row.code).join(',')
  check('6 正控：权重敏感**非空转**（只改一个权重 → 每个候选的得分都变、名次顺序也变；'
    + '不是"页面换了参数但排序纹丝不动"）',
  onlyPriceChanged && scoresDiffer && orderDiffers
  && sensBase.weights_applied.price === r12(0.4) && sensChanged.weights_applied.price === r12(0.6),
  `只改了一个权重=${onlyPriceChanged}；得分变了=${scoresDiffer}；名次变了=${orderDiffers}；原始行 ${sensLine}`)

  // ---------- 7. 权重夹取回显 ----------
  const clamped = rank({ weights: { price: 5, delivery: -3, payment: 0.1, warranty: 'x', deviation: 0.1 },
    candidates: HAND_PAYLOAD.candidates })
  const clampOk = clamped.weights_applied.price === r12(1 / 1.25)   // 夹到 1；{1, 0, .1, .05(默认), .1} 归一
    && clamped.weights_applied.delivery === 0
    && clamped.weights_requested.price === 5 && clamped.weights_requested.delivery === -3
    && clamped.weights_requested.warranty === null
    && clamped.clamp_notes.length >= 3
    && clamped.clamp_notes.some((note) => note.includes('夹取上界')) && clamped.clamp_notes.some((note) => note.includes('夹取下界'))
    && clamped.clamp_notes.some((note) => note.includes('不是有限数'))
  check('7 负控：权重越界**夹取并回显**（applied 是夹取后的真值、请求原值照抄、人话说明逐条列出；'
    + '非数字权重不静默当 0 也不搬进响应体）',
  clampOk,
  `applied=${JSON.stringify(clamped.weights_applied)}；requested=${JSON.stringify(clamped.weights_requested)}；`
  + `notes=${JSON.stringify(clamped.clamp_notes)}`)

  // ---------- 8. 归一化与全零回落 ----------
  const partial = rank({ weights: { price: 0.9 }, candidates: HAND_PAYLOAD.candidates })
  const zero = rank({ weights: { price: 0, delivery: 0, payment: 0, warranty: 0, deviation: 0 },
    candidates: HAND_PAYLOAD.candidates })
  const defaultSum = 1
  const zeroBad = badNumbers(zero)
  check('8 负控：权重归一后**和为一**（绝对容差 1e-9，写进 normalization.tolerance）；'
    + '全零权重 → 回落默认并重新归一（人话说明 + 输出里没有任何非有限数）',
  Math.abs(partial.normalized_sum - 1) <= 1e-9 && Math.abs(zero.normalized_sum - 1) <= 1e-9
  && zeroBad.length === 0 && zero.clamp_notes.some((note) => note.includes('全为 0'))
  && zero.rows.length === HAND_EXPECT.length
  && zero.normalization.tolerance === 1e-9
  && JSON.stringify(rowsOf(zero)) === JSON.stringify(rowsOf(rank({ candidates: HAND_PAYLOAD.candidates })))
  && Math.abs(defaultSum - partial.weights_applied.price - partial.weights_applied.delivery
    - partial.weights_applied.payment - partial.weights_applied.warranty - partial.weights_applied.deviation) <= 1e-9,
  `部分权重→sum=${partial.normalized_sum}；全零→sum=${zero.normalized_sum} 说明=${JSON.stringify(zero.clamp_notes[0] ?? '')}；`
  + `非有限数=${zeroBad.join(',') || '无'}；容差=${zero.normalization.tolerance}`)

  // ---------- 9. 私域哨兵（零泄漏 + 不参与计算） ----------
  const SENTINELS = ['reserve_price', 'cost_model', 'PRIVATE-NOTE-SENTINEL-7f', 'BIDDERS-SENTINEL-3c', '987654321']
  const withSentinels = {
    weights: HAND_PAYLOAD.weights,
    candidates: HAND_PAYLOAD.candidates.map((item, index) => (index === 0
      ? { ...item, reserve_price: 987654321, cost_model: 'COST-MODEL-SENTINEL-9a' }
      : (index === 1
        ? { ...item, 'private:note': 'PRIVATE-NOTE-SENTINEL-7f', bidders_private: 'BIDDERS-SENTINEL-3c', internal_notes: '内部备注' }
        : { ...item }))),
  }
  const cleanRun = JSON.stringify(rank(HAND_PAYLOAD))
  const dirtyRun = JSON.stringify(rank(withSentinels))
  const inputText = JSON.stringify(withSentinels)
  const hitInOutput = SENTINELS.filter((needle) => dirtyRun.includes(needle))
  const hitInInput = SENTINELS.filter((needle) => inputText.includes(needle))
  check('9 负控：**私域哨兵零泄漏**，且私域字段**不参与任何计算**（同一批候选带哨兵与不带哨兵 → 输出**逐字节一致**）。'
    + '这是"因为排名暗示标底"的反例：私域值连算都不用，排名自然推不出它',
  hitInOutput.length === 0 && hitInInput.length >= 4 && cleanRun === dirtyRun && dirtyRun.includes('sup-B'),
  `输出命中=${hitInOutput.join(',') || '无'}；输入命中（非空转对照）=${hitInInput.join(',')}；带哨兵与不带哨兵字节一致=${cleanRun === dirtyRun}`)

  // ---------- 10. 无绝对量级 ----------
  const BIG = { code: 'big', unit_price: 4242, lead_time_days: 7373, payment_terms: 5151, warranty_months: 2929,
    deviation_count: 1313 }
  const BIG2 = { code: 'big2', unit_price: 1414, lead_time_days: 6161, payment_terms: 8989, warranty_months: 3434,
    deviation_count: 2727 }
  const bigRun = JSON.stringify(rank({ candidates: [BIG, BIG2] }))
  const bigLiterals = ['4242', '7373', '5151', '2929', '1313', '1414', '6161', '8989', '3434', '2727']
  const fieldNames = ['unit_price', 'lead_time_days', 'payment_terms', 'warranty_months', 'deviation_count']
  const leaked = [...bigLiterals, ...fieldNames].filter((needle) => bigRun.includes(needle))
  check('10 负控：**不输出任何绝对量级**（原始单价/交期/账期/质保/偏差的数值与字段名一个都不出现在输出里；'
    + '贡献点是极差归一后的无量纲份额 ⇒ 无法反推别人的报价或底价）',
  leaked.length === 0 && bigRun.includes('big') && (rank({ candidates: [BIG, BIG2] }).rows ?? []).length === 2,
  `命中=${leaked.join(',') || '无'}；输出长度=${bigRun.length}；候选数=${rank({ candidates: [BIG, BIG2] }).rows.length}`)

  // ---------- 11. 有界与 omitted 诚实 ----------
  const capped = await mountWith({ max_candidates: 3 })
  const capRank = capped.box.handle.rank
  const manyCandidates = Array.from({ length: 7 }, (_, index) => ({
    code: `s-${index + 1}`, unit_price: 10 + index,
  }))
  const cut = capRank({ weights: { price: 1 }, candidates: manyCandidates })
  const uncut = rank({ weights: { price: 1 }, candidates: manyCandidates })
  const cappedIds = cut.rows.map((row) => row.code)
  check('11 负控：有界（`max_candidates` 夹取上限；超出**如实报** `omitted`/`truncated`），'
    + '且截断**不改口径**（被截掉的候选仍参与极差归一 → 留下的行分数与不截断时逐字节相同）',
  cut.rows.length === 3 && cut.omitted === 4 && cut.truncated === true && cut.counts.over_limit === 4
  && cut.counts.usable === 7 && !cappedIds.includes('s-4')
  && JSON.stringify(rowsOf(cut)) === JSON.stringify(rowsOf(uncut).slice(0, 3)),
  `上限 3 → rows=${cut.rows.length} omitted=${cut.omitted} truncated=${cut.truncated} codes=${cappedIds.join(',')}；`
  + `与不截断同分=${JSON.stringify(rowsOf(cut)) === JSON.stringify(rowsOf(uncut).slice(0, 3))}`)

  // ---------- 12. degraded 可分辨 ----------
  const badPayloads = [undefined, null, 'garbage', 42, {}, { candidates: 'nope' }, { candidates: [null, 'x', 7, {}] },
    { candidates: [{ code: 'no-factors' }, { unit_price: 5 }] }]
  const degradedReasons = []
  let threw = null
  for (const input of badPayloads) {
    try {
      const out = rank(input)
      degradedReasons.push(`${JSON.stringify(input)?.slice(0, 28) ?? 'undefined'}→${out.degraded}/${out.reason}/rows=${out.rows.length}`)
      if (!(out.degraded === true && typeof out.reason === 'string' && out.reason !== '' && out.rows.length === 0)) {
        degradedReasons.push(`!! 形状不对：${JSON.stringify(out).slice(0, 80)}`)
      }
    } catch (err) { threw = `${err.name}: ${String(err.message).slice(0, 80)}` }
  }
  const healthy = rank(HAND_PAYLOAD)
  const noUsable = rank({ candidates: [{ code: 'no-factors' }] })
  const noArray = rank({})   // 是对象、但没有候选数组（与"非对象载荷"是两个不同的 reason）
  check('12 负控：`degraded` 可分辨 —— 坏输入一律 `degraded:true` + **有名** `reason`（闭合集合）且 rows 为空、不抛错；'
    + '正常输入 `degraded:false` + `reason:null`；"没有可用候选"与"载荷形状不对"是**两个不同的 reason**（不许含糊成一条）',
  threw === null && degradedReasons.every((item) => !item.startsWith('!!'))
  && healthy.degraded === false && healthy.reason === null
  && noUsable.reason === 'no-usable-candidates' && noArray.reason === 'candidates-not-an-array'
  && mod.DEGRADED_REASONS.includes(noUsable.reason) && mod.DEGRADED_REASONS.includes(noArray.reason),
  `抛错=${threw ?? '无'}；${degradedReasons.join(' | ')}；正常=${healthy.degraded}/${healthy.reason}`)

  // ---------- 13. 不编造 ----------
  const sparse = rank({ weights: { price: 1 }, candidates: [
    { code: 'only-price', unit_price: 0 },
    { code: 'string-price', unit_price: '12' },
    { code: 'nan-price', unit_price: Number.NaN },
    { unit_price: 3 },
    null, 42, 'garbage', [1, 2],
  ] })
  const nanOut = badNumbers(sparse)
  check('13 负控：不编造 —— 缺因子记进 `missing`（不当 0）、无代号的候选不进排名、字符串数字/NaN 按"取不到"处理'
    + '（`0` 是真值不得被当成缺失）；候选数与丢掉的条数**照实计数**',
  sparse.rows.length === 1 && sparse.rows[0].code === 'only-price' && sparse.rows[0].contributions.price === 100
  && JSON.stringify(sparse.rows[0].coverage.missing)
    === JSON.stringify(['delivery', 'payment', 'warranty', 'deviation'])
  && sparse.counts.candidates === 8 && sparse.counts.excluded_invalid === 7 && nanOut.length === 0,
  `rows=${JSON.stringify(rowsOf(sparse))}；counts=${JSON.stringify(sparse.counts)}；非有限数=${nanOut.join(',') || '无'}`)

  // ---------- 14. 零写面 / 不读账本（静态扫描 + 非空转对照） ----------
  const FORBIDDEN = ['writeFile', 'appendFile', 'createWriteStream', 'mkdirSync', 'rmSync', 'renameSync',
    'readFileSync', 'openLedger', 'ledger', 'Date.now', 'new Date', 'Math.random', 'process.env', 'fetch(',
    'spawn', 'execFile', 'setInterval(', 'setTimeout(', 'ctx.on(', 'ctx.events', 'child_process', "require("]
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(originalSource)
  const selfTest = scan(`const tick = set${'Interval'}(() => {}, 1); open${'Ledger'}(p)`)
  check('14 负控：产物**零写面、不读账本**（无写文件/读文件/账本/墙钟/随机/网络/子进程/事件订阅）'
    + '且扫描器**非空转**（对照样本必须命中）',
  hits.length === 0 && selfTest.length >= 2,
  `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}`)

  // ---------- 15. 贡献点解释得分 + hint ----------
  const pointBad = []
  const hintBad = []
  for (const row of hand.rows.concat(partial.rows, zero.rows)) {
    const sum = Object.values(row.contributions).reduce((acc, value) => acc + value, 0)
    if (Math.abs(sum - row.score) > 1e-5) pointBad.push(`${row.code}:Σ=${sum}≠${row.score}`)
    if (!(row.score >= 0 && row.score <= 100)
      || Object.values(row.contributions).some((value) => value < 0 || value > 100)) {
      pointBad.push(`${row.code}:越界`)
    }
    if (typeof row.hint !== 'string' || row.hint.length < 8) hintBad.push(`${row.code}:hint 空`)
    for (const literal of ['4242', '100.0', '999999']) if (row.hint.includes(literal)) hintBad.push(`${row.code}:hint 含原始数值`)
  }
  const frozenHint = JSON.stringify(rank(HAND_PAYLOAD).rows.map((row) => row.hint))
    === JSON.stringify(hand.rows.map((row) => row.hint))
  check('15 正控：贡献点**解释得了**得分（Σ贡献 == score，容差 ' + hand.point_tolerance + ' 写进输出）；'
    + '每项都带一句确定性的"如何提升排名"（两次调用逐字节相同，且不含任何原始数值）',
  pointBad.length === 0 && hintBad.length === 0 && frozenHint && hand.rows.every((row) => row.hint.includes('优先改善') || row.hint.includes('没有可提升项')),
  `贡献和偏差=${pointBad.join(',') || '无'}；hint 问题=${hintBad.join(',') || '无'}；hint 稳定=${frozenHint}；`
  + `示例=${JSON.stringify(hand.rows[0].hint)}`)

  // ---------- 16. fixture 纯读取 + 冻结输入 ----------
  const reference = JSON.stringify(rank(HAND_PAYLOAD))
  const first = JSON.stringify(mod.fixture.sample(live.box.handle))
  const second = JSON.stringify(mod.fixture.sample(live.box.handle))
  const afterFixture = JSON.stringify(rank(HAND_PAYLOAD))
  const frozen = deepFreeze(JSON.parse(JSON.stringify(HAND_PAYLOAD)))
  const frozenOut = JSON.stringify(rank(frozen))
  check('16 正控：fixture 纯读取（连跑两次逐字节一致、不改变句柄行为），且**冻结输入**不抛错'
    + '（ESM 严格模式下任何对入参的写入都会抛 TypeError → 证明没偷偷改调用方的候选）',
  first === second && first.length > 50 && afterFixture === reference && frozenOut === reference,
  `fixture 两次一致=${first === second} 长度=${first.length}；句柄未变=${afterFixture === reference}；冻结输入一致=${frozenOut === reference}`)

  // ---------- 17. 配置不得静默放行 ----------
  const refuses = (raw) => { try { mod.Config.parse(raw); return 'accepted' } catch { return 'refused' } }
  const defaults = mod.Config.parse({})
  check('17 负控：配置不得静默放行（未知键 / 错误类型 / 非对象入参一律被拒；空配置给出默认权重与默认上限；'
    + '`deterministic` 是 const 键，翻转即拒）',
  refuses({ mystery_key: 1 }) === 'refused' && refuses({ max_candidates: 'many' }) === 'refused'
  && refuses(42) === 'refused' && refuses({ deterministic: false }) === 'refused'
  && defaults.max_candidates === 50 && defaults.weights.price === 0.6 && defaults.deterministic === true,
  `未知键=${refuses({ mystery_key: 1 })} 错类型=${refuses({ max_candidates: 'many' })} 非对象=${refuses(42)} `
  + `翻转 const=${refuses({ deterministic: false })}；默认=${JSON.stringify(defaults)}`)

  // ---------- 18-21. 真 HTTP（真 webui + 真依赖模块 + 夹具账本） ----------
  /**
   * 与 `host/webui.mjs`（webui 门）同一套挂法：把 webui 声明的依赖逐个真挂（都用真模块），
   * 账本用门自己的夹具（**不碰真账本、不写任何文件**）。
   * 夹具里刻意放一条带承包商私域键（`cost_floor`）的报价行 → 用来做"供应商侧看不到"的负控与
   * "同一批数据在承包商侧可见"的非空转对照。
   */
  const HB_FIXTURE = [
    { seq: 1, type: 'quote/submitted', correlation_id: 'q-1', ts: '2026-09-21T10:00:00Z', realm: 'contractor:con-B',
      body: { quote_id: 'q-1', lead_time_days: 10, payment_terms_offered: { advance_pct: 20, days: 30 },
        warranty_months: 12, deviations: [], lines: [{ item_id: 'L-001', unit_price: 100 }] } },
    { seq: 2, type: 'quote/submitted', correlation_id: 'q-2', ts: '2026-09-21T11:00:00Z', realm: 'contractor:con-B',
      body: { quote_id: 'q-2', lead_time_days: 20, payment_terms_offered: { advance_pct: 10, days: 45 },
        warranty_months: 24, deviations: [{ deviation_id: 'd-1' }, { deviation_id: 'd-2' }],
        lines: [{ item_id: 'L-001', unit_price: 80 }] } },
    // 私域负控行：承包商私域键在**行体**上（承包商视角可见、供应商视角必须看不到）
    { seq: 3, type: 'quote/submitted', correlation_id: 'q-priv', ts: '2026-09-21T12:00:00Z', realm: 'contractor:con-B',
      body: { quote_id: 'q-priv', cost_floor: 70000, markup_pct: 12.5, lead_time_days: 5, warranty_months: 6,
        lines: [{ item_id: 'L-001', unit_price: 60 }] } },
  ]
  const hbLedger = {
    path: '/tmp/t279-fixture-ledger.jsonl',
    rows: () => HB_FIXTURE,
    verify: () => ({ ok: true, count: HB_FIXTURE.length, head: 'sha256:' + 'b'.repeat(64) }),
  }
  const httpCtx = new Context()
  await httpCtx.plugin(EventsService)
  httpCtx.provide('ledgerView', hbLedger)
  const httpBox = {}
  const mountReal = async (file, raw, service, name) => {
    const loaded = await import(pathToFileURL(join(HERE, 'modules', file)).href)
    await httpCtx.plugin({
      name: `${name}#t279`,
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
  await mountReal('admin-guard.mjs', { token_env: 'QUOTAGENT_ADMIN_TOKEN_T279' }, 'adminGuard', 'admin-guard')
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
  await httpCtx.plugin({ name: 'projection#t279', inject: [], Config: projection.Config,
    apply: (inner, config) => projection.apply(inner, config) }, projection.Config.parse({}))
  const webui = await import(pathToFileURL(join(HERE, 'modules', 'webui.mjs')).href)
  const httpFiber = await httpCtx.plugin({
    name: 'webui#t279',
    inject: webui.inject,
    Config: webui.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'webui') httpBox.webui = v; return originalProvide(s, v) }
      await webui.apply(inner, config)
    },
  }, webui.Config.parse({ port: 0, route_prefix: '/t279' }))
  const base = httpBox.webui.url.replace(/\/$/, '')
  const get = async (path) => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, text: await res.text() }
  }
  const INLINE_EVENT = /\son[a-z]+\s*=/i
  const scoresOfPage = (text) => [...String(text).matchAll(/data-score="([^"]*)"/g)].map((match) => match[1])
  const codesOfPage = (text) => [...String(text).matchAll(/data-row="([^"]*)"/g)].map((match) => match[1])
  /** 页面上"代号 → 得分"的对应（行序会随权重变，按下标比是错的口径）。 */
  const pageScoreByCode = (text) => Object.fromEntries([...String(text).matchAll(
    /data-row="([^"]*)" data-rank="\d+"><td>\d+<\/td><td><code>[^<]*<\/code><\/td><td data-score="([^"]*)"/g)]
    .map((match) => [match[1], match[2]]))

  const contractorPage = await get('/contractor/heuristics/')
  const supplierPage = await get('/supplier/heuristics/')
  const contractorJson = await get('/contractor/api/heuristics')
  const supplierJson = await get('/supplier/api/heuristics')
  let cj = {}
  let sj = {}
  try { cj = JSON.parse(contractorJson.text) } catch { cj = {} }
  try { sj = JSON.parse(supplierJson.text) } catch { sj = {} }
  const navOk = contractorPage.text.includes('data-subnav="contractor"') && supplierPage.text.includes('data-subnav="supplier"')
    && contractorPage.text.includes('data-heuristics-link="1"')
  const formOk = /<form method="get" action="\/t279\/(contractor|supplier)\/heuristics\/">/.test(contractorPage.text)
    && supplierPage.text.includes('<button type="submit">')
  check('18 真 HTTP 正控：`/t279/<view>/heuristics/` 双方各自 200，页面含道内子导航（含"比价口径"入口）、'
    + '`<form method=get>`（五个权重输入 + 提交）与排名表（`data-heuristics="rows"` + 每项 `data-contribution`）',
  contractorPage.status === 200 && supplierPage.status === 200 && navOk && formOk
  && contractorPage.text.includes('data-heuristics="rows"')
  && contractorPage.text.includes('data-contribution="warranty"')
  && codesOfPage(contractorPage.text).length >= 3 && scoresOfPage(contractorPage.text).length >= 3
  && contractorJson.status === 200 && supplierJson.status === 200,
  `status=${contractorPage.status}/${supplierPage.status}；子导航/入口=${navOk}；GET 表单=${formOk}；`
  + `承包商页行=${codesOfPage(contractorPage.text).join(',')}；供应商页行=${codesOfPage(supplierPage.text).join(',')}`)

  const pageScripty = [contractorPage, supplierPage].filter((page) => page.text.includes(scriptNeedle) || INLINE_EVENT.test(page.text))
  const jsonScripty = [contractorJson, supplierJson].filter((page) => page.text.includes(scriptNeedle))
  const scriptSelfTest = (`<a onclick="x()"></a>`).includes(scriptNeedle) || INLINE_EVENT.test('<a onclick="x()"></a>')
  check('19 真 HTTP 负控：两视角的**页面与 JSON 都 0 行脚本 / 0 内联事件**（零 JS 是机检事实：交互只用 '
    + '`form method=get` 与链接），且扫描器非空转',
  pageScripty.length === 0 && jsonScripty.length === 0 && scriptSelfTest
  && !contractorPage.text.includes('onclick=') && !contractorPage.text.includes('onload='),
  `页面命中=${pageScripty.length}；JSON 命中=${jsonScripty.length}；扫描器对照=${scriptSelfTest}`)

  const priceOnly = await get('/contractor/heuristics/?w_price=1&w_delivery=0&w_payment=0&w_warranty=0&w_deviation=0')
  const deliveryOnly = await get('/contractor/heuristics/?w_price=0&w_delivery=1&w_payment=0&w_warranty=0&w_deviation=0')
  const priceJson = await get('/contractor/api/heuristics?w_price=1&w_delivery=0&w_payment=0&w_warranty=0&w_deviation=0')
  const deliveryJson = await get('/contractor/api/heuristics?w_price=0&w_delivery=1&w_payment=0&w_warranty=0&w_deviation=0')
  const pageDiffers = priceOnly.text !== deliveryOnly.text
  const priceScores = pageScoreByCode(priceOnly.text)
  const deliveryScores = pageScoreByCode(deliveryOnly.text)
  const scoreDiffers = Object.keys(priceScores).length >= 2
    && Object.entries(priceScores).some(([code, score]) => deliveryScores[code] !== score)
  const httpOrderDiffers = JSON.stringify(codesOfPage(priceOnly.text)) !== JSON.stringify(codesOfPage(deliveryOnly.text))
  check('20 真 HTTP 正控：**改权重 → 响应体不同**（页面与 JSON 两条路由都试）；同一批候选下 `?w_price=1` 与 '
    + '`?w_delivery=1` 的 data-score 与名次顺序都不同（HTTP 层面证明"调权重不是装饰"）',
  pageDiffers && scoreDiffers && httpOrderDiffers && priceJson.text !== deliveryJson.text
  && priceOnly.status === 200 && deliveryOnly.status === 200,
  `页面体不同=${pageDiffers}；分数不同=${scoreDiffers}；名次不同=${httpOrderDiffers}；`
  + `w_price=1 名次=${codesOfPage(priceOnly.text).join(',')} 代号→分=${JSON.stringify(priceScores)}；`
  + `w_delivery=1 名次=${codesOfPage(deliveryOnly.text).join(',')} 代号→分=${JSON.stringify(deliveryScores)}`)

  const SENTINEL_NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:', 'bidders_private']
  const supplierHits = SENTINEL_NEEDLES.filter((needle) => supplierPage.text.includes(needle) || supplierJson.text.includes(needle))
  const contractorEvents = await get('/contractor/api/events')
  const contractorHits = SENTINEL_NEEDLES.filter((needle) => contractorEvents.text.includes(needle))
  check('21 真 HTTP 负控：**供应商侧**的 heuristics 页面与 JSON 里搜不到私域哨兵（' + SENTINEL_NEEDLES.join('/')
    + '）；**非空转对照**：同一批私域数据在承包商侧的既有路由里可见（证明源里确实有），'
    + '并且带私域的候选行在供应商侧**根本不进候选**',
  supplierHits.length === 0 && contractorHits.length >= 1
  && codesOfPage(contractorPage.text).includes('q-priv')
  && !codesOfPage(supplierPage.text).includes('q-priv'),
  `供应商侧命中=${supplierHits.join(',') || '无'}；承包商侧既有路由命中（对照）=${contractorHits.join(',')}；`
  + `承包商页含 q-priv=${codesOfPage(contractorPage.text).includes('q-priv')}；供应商页含 q-priv=${codesOfPage(supplierPage.text).includes('q-priv')}`)

  check('22 真 HTTP 正控：`/<view>/api/heuristics` 的 JSON 契约齐备（rows/weights_applied/counts/truncated/omitted/'
    + 'degraded/reason/contributions 五键），且 `degraded:false`（夹具里有真数据 —— 不是"看着像有数据的空表"）',
  Array.isArray(cj.rows) && cj.rows.length >= 3 && cj.degraded === false && cj.reason === null
  && typeof cj.truncated === 'boolean' && typeof cj.omitted === 'number'
  && cj.rows.every((row) => ['price', 'delivery', 'payment', 'warranty', 'deviation'].every((factor) =>
    typeof row.contributions[factor] === 'number'))
  && typeof cj.weights_applied.price === 'number' && Math.abs(cj.normalized_sum - 1) <= 1e-9
  && sj.degraded === false && Array.isArray(sj.rows) && sj.rows.length >= 1,
  `contractor rows=${cj.rows?.length} degraded=${cj.degraded} sum=${cj.normalized_sum}；`
  + `supplier rows=${sj.rows?.length} degraded=${sj.degraded}`)

  // ---- 四道页面的子导航里都有比价口径入口（admin 道用门内假 token 真提权拿页面，否则只是 401 固定体） ----
  const elevate = await fetch(`${base}/admin/api/elevate`, { method: 'POST', body: `token=${T279_TOKEN}` })
  const adminCookie = String(elevate.headers.get('set-cookie') ?? '').split(';')[0]
  const adminPageRes = await fetch(`${base}/admin/`, { headers: { cookie: adminCookie } })
  const adminPageText = await adminPageRes.text()
  const navPages = { contractor: contractorPage.text, supplier: supplierPage.text,
    ops: (await get('/ops/')).text, admin: adminPageText }
  const navMissing = Object.entries(navPages)
    .filter(([, text]) => !text.includes('data-heuristics-link="1"'))
    .map(([name]) => name)
  check('18b 真 HTTP 正控：**四道页面**（承包商 / 供应商 / 运维 / 系统管理）的子导航里都有比价口径入口，'
    + '且第四道是**提权后**的真面板（不是 401 固定体）—— 入口可见性本身也要机检',
  navMissing.length === 0 && elevate.status === 200 && adminPageRes.status === 200
  && adminPageText.includes('阻塞清单') && adminPageText.includes('/t279/contractor/heuristics/'),
  `缺入口的道=${navMissing.join(',') || '无'}；提权=${elevate.status}；admin 页=${adminPageRes.status} `
  + `含阻塞清单=${adminPageText.includes('阻塞清单')} 含比价链接=${adminPageText.includes('/t279/contractor/heuristics/')}`)

  await httpFiber.dispose()

  // ---------- 23-26. 单点变异（4 处全部变红 + 防假变异 + 原文件字节不变） ----------
  const realScenarios = scenarioFacts((await mountWith({ max_candidates: 3 })).box.handle.rank)
  const realAllTrue = SCENARIOS.every((name) => realScenarios[name] === true)
  check('23 变异前基线：四条场景（手算/夹取回显/归一化/有界）在**真产物**上全真 '
    + '（否则变异变红就说明不了任何事：基线本来就是红的）',
  realAllTrue, `基线=${JSON.stringify(realScenarios)}`)

  const mutationReport = []
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
    const fake = mutated === null || mutated === originalSource
    if (fake) {
      mutationReport.push(`${mutation.name}→假变异（找不到唯一锚点或字节没变）`)
      check(`24 变异：${mutation.name}`, false, `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
      continue
    }
    const mounted = await mountMutant(mutated, { max_candidates: 3 })
    const facts = scenarioFacts(mounted.box.handle.rank)
    const red = SCENARIOS.filter((name) => facts[name] === false)
    await mounted.ctx.stop?.()
    mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
    check(`24 变异：${mutation.name}`, red.includes(mutation.mustRed),
      `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts)}；`
      + `字节已变=${mutated !== originalSource}；变异体=${mounted.file}`)
  }

  const fakeGuard = applyMutation(originalSource, '这一段源码里根本不存在-MUTATION-ANCHOR', 'x')
  const selfMutation = applyMutation(originalSource, mutationAnchorForSelfTest(originalSource), mutationAnchorForSelfTest(originalSource))
  check('25 防假变异（自检）：找不到唯一锚点的"变异"必须被判定为**假变异**（返回 null），'
    + '把锚点替换成它自己也不算变异 —— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

  const afterHash = sha256(sourceOf(TARGET))
  check('26 还原：本门全程**没有写过产品树** —— `host/modules/bid-heuristics.mjs` 跑完之后与跑之前'
    + '**逐字节一致**（变异只写在临时目录的副本里），`host/modules/webui.mjs` 也未被本门改动',
  afterHash === originalHash && originalSource === sourceOf(TARGET),
  `sha256 前=${originalHash.slice(0, 16)}… 后=${afterHash.slice(0, 16)}…；变异小结=${mutationReport.join('；')}`)

  for (const mounted of [live, other, capped]) {
    try { await mounted.fiber.dispose() } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 300)}`)
}

finish()

/** 给"自我替换"那条自检用的锚点：取源码里真实存在的一段（拿真源码量，不凭印象写）。 */
function mutationAnchorForSelfTest(text) {
  const anchor = 'export const provides'
  return text.includes(anchor) ? anchor : 'export const name'
}
