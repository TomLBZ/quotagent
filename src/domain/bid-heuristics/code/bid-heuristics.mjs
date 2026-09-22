/**
 * 进树模块：`bid-heuristics` —— **比价 heuristics visualizer**（domain 插件，T-279）。
 *
 * 要解决的痛点（`docs/work/plans/ux-双方痛点与交互需求.md.txt` §C8 / §J5 / §5.1 第 5 条）：
 *   · 承包商："算出来的排序和我直觉不一样，说不清理由"、"非价格条款不量化 → 最低价中标、履约最亏"；
 *   · 供应商："看不到比价，不知道自己是第几、更不知道**怎么才能往上走**"。
 * 所以本插件把"这家为什么排在这里"拆成**五个分量的贡献点**，让双方都能拿同一条算式复算，
 * 并允许**自己调权重**看排序怎么变（权重敏感、非空转）。
 *
 * 分工（不重复造轮子）：
 *   · `services/compare.py`：**判定**（TCO 折算 + 引用链 + 落账本 `compare/rank-computed`），唯一真源；
 *   · 本插件：**不改判定、不落账本、不读账本** —— 吃调用方给的一批**候选**（来自现有投影/快照），
 *     做一次确定性的、有界的、可解释的打分，把分数**拆成五分量贡献**并给一句"如何提升排名"。
 *
 * 算式（**与 `services/compare.py` 同形，手算可复现** —— 这是"口径不一致"痛点的机检落点）：
 *   ① 五分量按字段取值（`FACTOR_FIELDS`）；缺失的因子**不计分也不假装 0**（记进 `missing`）；
 *   ② 方向统一成"成本方向"：`orientation:'benefit'`（质保越长越好）取负号 → 全部变成"越低越好"；
 *   ③ 极差归一 `m = (cost - min) / (max - min)`，极差为 0（全等）→ `m = 0`
 *      （与 `compare.py:_minmax` 逐字同口径，含除零处理）；
 *   ④ 质量 `q = 1 - m ∈ [0,1]`（1 = 本次候选集里最好）；**分数越高排名越前**；
 *   ⑤ 权重先夹取（[0,1]）再归一（和为一，绝对容差 `SUM_TOLERANCE`）；
 *   ⑥ `score = 100 × Σ_present w_i·q_i / Σ_present w_i`（**只在取得到的因子上归一**，
 *      所以"只有单价"的候选也能排名，且缺失因子在行里显式列出）；
 *   ⑦ `contributions[i] = 100 × w_i·q_i / Σ_present w_i`（**无量纲的"贡献点"**，Σ 与 score 相等，
 *      容差 `POINT_TOLERANCE`）。
 * 与 `compare.py` 的排序**等价**：`compare` 分 = Σ w_i·m_i 升序（越小越好），
 * 本插件分 = 100 − 100·Σ w_i·m_i 降序（越大越好）→ 同一组权重下**名次相同**（Σw=1 时恒等）。
 *
 * 边界（纪律，逐条都有 `host/t279-heuristics-gate.mjs` 的断言看着）：
 *   · **不读账本**：只对调用方给的候选做算术（连 `fs` 都不 import —— 静态扫描断言）；
 *   · **零写面**：不写文件、不写账本、不订阅事件、不注册定时器、不起子进程、不联网；
 *   · **确定性**：不取墙钟、不用随机数；同输入两次输出**逐字节一致**；输出与**输入顺序无关**
 *     （候选先按代号字典序排、再按 `score` 降序/代号升序定序；同分不靠到达顺序分胜负）；
 *   · **有界**：一次最多 `max_candidates` 条名次（夹取区间 [1, 500]），被截掉的条数在 `omitted`
 *     如实报出（`truncated=true`）；**归一化基数仍是整个 payload 的候选集**（截断只影响展示的名次行，
 *     不影响口径 —— 这点写进注释，避免"截断悄悄改了分数"）；
 *   · **不编造**：代号取不到 / 一个可用因子都取不到的候选**不进排名**（只计数，不造占位行）；
 *     缺因子记进 `missing`，不当 0；非有限数（NaN/Infinity）与字符串数字一律按"取不到"处理；
 *   · **降级可分辨**：`degraded:true` + 有名 `reason`（闭合集合），正常时 `degraded:false` + `reason:null`；
 *   · **私域零泄漏**：输出只含**白名单字段**（代号/名次/分数/贡献/缺失/提示），候选对象上多出来的键
 *     （`reserve_price`/`cost_model`/`private:*` …）**读都不读** → 加了私域键的输出与不加**逐字节一致**；
 *     贡献点是**无量纲**的（极差归一后的加权份额），**不输出任何绝对量级**（差值/标底/成本线）
 *     —— "用排名或差值暗示标底"也是泄漏（`INV-008` / `ux-双方痛点…§5.1.5`）。
 */
import { constant, number, object } from '../lib/std-schema.mjs'

export const name = 'bid-heuristics'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['bidHeuristics']

export const Config = object({
  // 默认权重（与 `services/compare.py` 的 DEFAULT_WEIGHTS **同形同名同值**；页面/接口可逐项覆盖）
  weights: object({
    price: number().default(0.6),
    delivery: number().default(0.15),
    payment: number().default(0.1),
    warranty: number().default(0.05),
    deviation: number().default(0.1),
  }),
  // 一次返回的名次行上限（夹取区间 [1, 500]；越界夹取并回显，非有限数回落默认 50）
  max_candidates: number().default(50),
  deterministic: constant(true),   // const 键：不得翻转（A3 负控）
})

/**
 * 行项目键：候选**带了 `item`/`item_id`** 时，极差归一**按行项目分组**做 —— 不同行项目的单价
 * （如 L-001 的 86.0 与 L-002 的 11.5）本来就不可比，混在一批里做极差归一会把"哪家报价好"
 * 变成"哪个行项目贵"，那是**假排名**。没带行项目 → 整批当作一个组（`baseline:'whole-set'`，
 * 调用方自证这一批可比：同一行项目、同一包）。
 */
export const WHOLE_SET = '(未给行项目)'

/** 五个分量（**顺序即契约**：贡献对象与 factors 元数据的键序固定，与输入顺序无关）。 */
export const FACTORS = ['price', 'delivery', 'payment', 'warranty', 'deviation']

/**
 * 分量 → 候选字段（**唯一的取值口径**，写在一处避免各处各记一遍）。
 * `orientation:'cost'` 越低越好；`orientation:'benefit'` 越高越好（内部取负号转成本方向）。
 * 字段名与账本/投影里的既有写法一致：`unit_price`（行项目）、`lead_time_days`、`payment_terms`
 * （净账期天数）、`warranty_months`、`deviation_count`。
 */
export const FACTOR_FIELDS = [
  { factor: 'price', field: 'unit_price', label: '单价', orientation: 'cost' },
  { factor: 'delivery', field: 'lead_time_days', label: '交期（天）', orientation: 'cost' },
  { factor: 'payment', field: 'payment_terms', label: '付款条件（净账期天数）', orientation: 'cost' },
  { factor: 'warranty', field: 'warranty_months', label: '质保（月）', orientation: 'benefit' },
  { factor: 'deviation', field: 'deviation_count', label: '偏差计数', orientation: 'cost' },
]

/** 权重夹取区间（**显式契约**：越界夹取并回显，不静默放行也不静默改语义）。 */
const WEIGHT_MIN = 0
const WEIGHT_MAX = 1
/** 候选上限的夹取区间与回落值（非有限数 → 默认；越界 → 夹取）。 */
const CANDIDATE_FLOOR = 1
const CANDIDATE_CEILING = 500
const CANDIDATE_FALLBACK = 50
/** 归一化：`weights_applied` 之和与 1 的**绝对**容差（浮点求和，写清不靠"看起来相等"）。 */
const SUM_TOLERANCE = 1e-9
/** 贡献点之和与 `score` 的**绝对**容差（五个分量各 6 位小数舍入 ⇒ 最坏 ≈3e-6）。 */
const POINT_TOLERANCE = 1e-5
/** 分数/贡献的展示位数（6 位小数；确定性来自"固定四舍五入"，不是来自格式化）。 */
const DECIMALS = 6
const SCALE = 10 ** DECIMALS

/** 降级原因的**闭合集合**（门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['payload-not-an-object', 'candidates-not-an-array', 'no-usable-candidates']

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 只有有限数字才算一个值；NaN / ±Infinity / 字符串数字一律按"取不到"处理（不解析、不猜）。 */
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** 人话串字段：只认非空字符串（其余按取不到处理）。 */
const textOrNull = (value) => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** 固定 6 位小数（半值向 +∞ 舍入；`Math.round(-0)` 归一成 0，避免 `-0` 混进 JSON）。 */
const round6 = (value) => {
  const rounded = Math.round(value * SCALE) / SCALE
  return rounded === 0 ? 0 : rounded
}

/** 显式字典序比较器（确定性排序不依赖默认比较的隐含规则，也不受 locale 影响）。 */
const byLex = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

/** 配置夹取：有限数按 [1,500] 夹；非有限数/缺省 → 默认 50。 */
const clampLimit = (value) => {
  const amount = numOrNull(value)
  if (amount === null) return CANDIDATE_FALLBACK
  return Math.min(CANDIDATE_CEILING, Math.max(CANDIDATE_FLOOR, Math.floor(amount)))
}

/** 权重夹取：有限数夹到 [0,1]（越界记一条人话说明）；非有限数/缺类型 → 回落到默认权重。 */
const clampWeight = (raw, fallback) => {
  const amount = numOrNull(raw)
  if (amount === null) return { value: numOrNull(fallback) ?? 0, note: 'not-a-number' }
  if (amount < WEIGHT_MIN) return { value: WEIGHT_MIN, note: `夹取下界 ${WEIGHT_MIN}` }
  if (amount > WEIGHT_MAX) return { value: WEIGHT_MAX, note: `夹取上界 ${WEIGHT_MAX}` }
  return { value: amount, note: '' }
}

/** 行项目键：`item` → `item_id` → 单组占位（不猜、也不把不同行项目混起来）。 */
const itemOf = (candidate) => textOrNull(candidate.item) ?? textOrNull(candidate.item_id) ?? WHOLE_SET

/** 候选代号：`supplier_id` → `code` → `quote_id` → 取不到（取不到不进排名，不造占位行）。 */
const codeOf = (candidate) => textOrNull(candidate.supplier_id) ?? textOrNull(candidate.code)
  ?? textOrNull(candidate.quote_id)

/** 一个候选的因子取值（`null` = 取不到；**不补默认值**）。 */
const valuesOf = (candidate) => {
  const out = {}
  for (const spec of FACTOR_FIELDS) out[spec.factor] = numOrNull(candidate[spec.field])
  return out
}

/**
 * 极差归一（**与 `services/compare.py:_minmax` 同口径**）：全等时记 0（确定性，不引入除零）。
 * 用显式循环而不是 `Math.min(...values)`：大数组展开有爆栈风险，且这里要能被逐行审阅。
 */
const minmax = (value, low, high) => (high <= low ? 0 : (value - low) / (high - low))

const minOf = (values) => values.reduce((acc, value) => (value < acc ? value : acc), values[0])
const maxOf = (values) => values.reduce((acc, value) => (value > acc ? value : acc), values[0])

/**
 * 默认配置（模块级调用方在 `apply` 里已经过 Config 解析；这里再兜一层是为了让纯函数
 * 在夹具里也能被直接调用，且**不依赖任何外部状态**）。
 */
const resolvedOptions = (config) => {
  const cfg = isPlain(config) ? config : {}
  const weights = isPlain(cfg.weights) ? cfg.weights : {}
  const defaults = {}
  for (const factor of FACTORS) defaults[factor] = numOrNull(weights[factor]) ?? 0
  return Object.freeze({ defaults: Object.freeze(defaults), max_candidates: clampLimit(cfg.max_candidates) })
}

/**
 * 纯函数：对一批候选 + 一组可调权重算一次"为什么排在这里"。
 * 只读入参（不写任何入参对象），不读账本/文件/墙钟/随机数。
 */
export const rankOf = (payload, config) => {
  const options = resolvedOptions(config)
  const degradedOut = (reason) => ({
    source: 'bid-heuristics',
    rows: [],
    weights_applied: Object.freeze({}),
    weights_requested: Object.freeze({}),
    clamp_notes: [],
    counts: { candidates: 0, usable: 0, unique: 0, duplicates: 0, ranked: 0, excluded_invalid: 0, incomplete: 0,
      zero_weight: 0, over_limit: 0, missing_factors: 0, items: 0 },
    baseline: 'whole-set',
    truncated: false,
    omitted: 0,
    degraded: true,
    reason,
    normalized_sum: 0,
    normalization: { method: 'sum-to-one', tolerance: SUM_TOLERANCE },
    point_tolerance: POINT_TOLERANCE,
    factors: FACTOR_FIELDS.map((spec) => ({ factor: spec.factor, label: spec.label,
      orientation: spec.orientation })),
    note: '比价 heuristics：只对调用方给的候选做算术（不读账本、不写文件、不落账本；'
      + '输出只含分量名/标签/方向 —— 连输入字段名与任何原始数值都不出）',
  })
  if (!isPlain(payload)) return degradedOut('payload-not-an-object')
  const raw = Array.isArray(payload.candidates) ? payload.candidates
    : (Array.isArray(payload.rows) ? payload.rows : null)
  if (raw === null) return degradedOut('candidates-not-an-array')

  // ---- 权重：请求值 → 夹取 → 归一（夹取过程逐条进 clamp_notes，页面上必须报出来）----
  const requestedRaw = isPlain(payload.weights) ? payload.weights : {}
  const clampNotes = []
  const applied = {}
  for (const factor of FACTORS) {
    const hasRequest = Object.prototype.hasOwnProperty.call(requestedRaw, factor)
    const fallback = options.defaults[factor] ?? 0
    const out = hasRequest ? clampWeight(requestedRaw[factor], fallback)
      : { value: fallback, note: 'missing' }
    applied[factor] = out.value
    // 回显只放**确定的形状**：越界时回显那个数字；不是有限数时只说类型（不把请求里的任意串搬进响应体）
    if (out.note === 'missing') clampNotes.push(`权重 ${factor} 未提交 → 用默认 ${fallback}`)
    else if (out.note === 'not-a-number') {
      clampNotes.push(`权重 ${factor} 不是有限数（类型 ${Array.isArray(requestedRaw[factor])
        ? 'array' : typeof requestedRaw[factor]}）→ 用默认 ${fallback}`)
    } else if (out.note !== '') clampNotes.push(`权重 ${factor}=${requestedRaw[factor]} ${out.note}`)
  }
  let total = 0
  for (const factor of FACTORS) total += applied[factor]
  let weightsApplied = { ...applied }
  if (!(total > 0)) {
    clampNotes.push('五个权重全为 0（或夹取后全为 0）→ 回落默认权重并重新归一（否则无解，也不输出 NaN）')
    let fallbackSum = 0
    for (const factor of FACTORS) fallbackSum += options.defaults[factor] ?? 0
    weightsApplied = {}
    for (const factor of FACTORS) {
      weightsApplied[factor] = fallbackSum > 0 ? (options.defaults[factor] ?? 0) / fallbackSum : 1 / FACTORS.length
    }
  } else {
    weightsApplied = {}
    for (const factor of FACTORS) weightsApplied[factor] = round12(applied[factor] / total)
  }
  let normalizedSum = 0
  for (const factor of FACTORS) normalizedSum += weightsApplied[factor]
  const weightsRequested = {}
  for (const factor of FACTORS) {
    weightsRequested[factor] = Object.prototype.hasOwnProperty.call(requestedRaw, factor)
      ? (numOrNull(requestedRaw[factor]) ?? null) : null
  }

  // ---- 候选：代号 + 因子取值（取不到不补默认；私域/未知键**读都不读**）----
  const usable = []
  let excludedInvalid = 0
  let missingFactors = 0
  let incomplete = 0
  for (const candidate of raw) {
    if (!isPlain(candidate)) { excludedInvalid += 1; continue }
    const code = codeOf(candidate)
    if (code === null) { excludedInvalid += 1; continue }
    const values = valuesOf(candidate)
    const present = FACTORS.filter((factor) => values[factor] !== null)
    if (present.length === 0) { excludedInvalid += 1; continue }
    if (present.length < FACTORS.length) { incomplete += 1; missingFactors += FACTORS.length - present.length }
    usable.push({ code, item: itemOf(candidate), values, present })
  }
  // 与输入顺序无关（确定性）：先按行项目键、再按代号排；两次同样的输入必然得到同样的顺序
  usable.sort((left, right) => byLex(left.item, right.item) || byLex(left.code, right.code))
  // **完全相同的候选**（同项、同代号、五个因子值全同）只保留一条：重复行不改变任何算术，
  // 但会让名次表出现"同一家占两个名次"的假象。去重的条数照实报（counts.duplicates）。
  const seen = new Set()
  const unique = []
  let duplicates = 0
  for (const item of usable) {
    const key = [item.item, item.code, ...FACTORS.map((factor) => (item.values[factor] === null ? '∅' : item.values[factor]))]
      .join('\u0000')
    if (seen.has(key)) { duplicates += 1; continue }
    seen.add(key)
    unique.push(item)
  }
  if (usable.length === 0) {
    const out = degradedOut('no-usable-candidates')
    return { ...out, weights_applied: Object.freeze(weightsApplied), weights_requested: Object.freeze(weightsRequested),
      clamp_notes: clampNotes, normalized_sum: round12(normalizedSum),
      counts: { ...out.counts, candidates: raw.length, excluded_invalid: excludedInvalid } }
  }

  // ---- 极差基准：**按行项目分组**（组内才可比）。整批都没有行项目 → 一个组（`whole-set`）----
  const groupKeys = [...new Set(unique.map((item) => item.item))].sort(byLex)
  const basisOf = (members) => {
    const out = {}
    for (const spec of FACTOR_FIELDS) {
      const costs = []
      for (const item of members) {
        const value = item.values[spec.factor]
        if (value === null) continue
        costs.push(spec.orientation === 'benefit' ? -value : value)
      }
      out[spec.factor] = costs.length ? { low: minOf(costs), high: maxOf(costs) } : null
    }
    return out
  }

  // ---- 打分 + 贡献分解（组内极差；只在取得到的因子上归一 ⇒ 缺数据的候选仍然可排名）----
  let zeroWeight = 0
  const ranked = []
  for (const groupKey of groupKeys) {
    const members = unique.filter((item) => item.item === groupKey)
    const basis = basisOf(members)
    const scored = []
    for (const item of members) {
      const quality = {}
      let weightsUsed = 0
      for (const factor of FACTORS) {
        const value = item.values[factor]
        if (value === null) continue
        weightsUsed += weightsApplied[factor]
      }
      if (!(weightsUsed > 0)) { zeroWeight += 1; continue }   // 可取到的因子权重全为 0 → 不进排名（不输出 NaN）
      let score = 0
      const contributions = {}
      for (const factor of FACTORS) {
        const value = item.values[factor]
        let q = 0
        if (value !== null) {
          const spec = FACTOR_FIELDS.find((entry) => entry.factor === factor)
          const cost = spec.orientation === 'benefit' ? -value : value
          q = 1 - minmax(cost, basis[factor].low, basis[factor].high)
        }
        quality[factor] = value === null ? null : q
        const points = 100 * weightsApplied[factor] * q / weightsUsed
        contributions[factor] = round6(points)
        score += points
      }
      const missing = FACTORS.filter((factor) => item.values[factor] === null)
      // "如何提升排名"：把某个因子做到**本组**最好能再加多少分（**无量纲**，纯贡献点）
      let focus = null
      let potential = 0
      for (const factor of FACTORS) {
        if (item.values[factor] === null) continue
        const gain = 100 * weightsApplied[factor] * (1 - quality[factor]) / weightsUsed
        if (focus === null || gain > potential + 1e-12) { focus = factor; potential = gain }
      }
      const focused = potential > POINT_TOLERANCE ? focus : null
      const fullPoints = focus === null ? 0 : 100 * weightsApplied[focus] / weightsUsed
      scored.push({ code: item.code, score: round6(score), contributions, missing,
        weightsUsed: round6(weightsUsed), focus: focused, potential: round6(potential),
        hint: hintOf(focused, contributions[focus] ?? 0, fullPoints, potential) })
    }
    scored.sort((left, right) => (right.score - left.score) || byLex(left.code, right.code))
    // 名次是**该行项目内**的名次；截断后按原名次展示，不重编号（重编号会掩盖"前面还有被截掉的候选"）
    scored.forEach((item, index) => ranked.push({ ...item, item: groupKey, rank: index + 1 }))
  }

  const limit = options.max_candidates
  const rows = ranked.slice(0, limit).map((item) => ({
    rank: item.rank,
    code: item.code,
    item: item.item,
    score: item.score,
    contributions: item.contributions,
    focus: item.focus,
    potential: item.potential,
    hint: item.hint,
    coverage: { present: FACTORS.filter((factor) => !item.missing.includes(factor)), missing: item.missing,
      weights_sum: item.weightsUsed },
  }))
  const omitted = ranked.length - rows.length
  return {
    source: 'bid-heuristics',
    rows,
    baseline: groupKeys.length === 1 && groupKeys[0] === WHOLE_SET ? 'whole-set' : 'per-item',
    weights_applied: weightsApplied,
    weights_requested: weightsRequested,
    clamp_notes: clampNotes,
    counts: { candidates: raw.length, usable: usable.length, unique: unique.length, duplicates,
      ranked: rows.length, excluded_invalid: excludedInvalid, incomplete, zero_weight: zeroWeight,
      over_limit: omitted, missing_factors: missingFactors, items: groupKeys.length },
    truncated: omitted > 0,
    omitted,
    degraded: false,
    reason: null,
    normalized_sum: round12(normalizedSum),
    normalization: { method: 'sum-to-one', tolerance: SUM_TOLERANCE },
    point_tolerance: POINT_TOLERANCE,
    factors: FACTOR_FIELDS.map((spec) => ({ factor: spec.factor, label: spec.label,
      orientation: spec.orientation })),
    note: '五分量=单价/交期/付款条件/质保/偏差；极差归一后加权（**按行项目分组**、只在取得到的因子上归一）；'
      + '贡献点是**无量纲**的加权份额，不含任何绝对量级；与 services/compare.py 同口径（同权重下名次一致）',
  }
}

/** 归一化权重的展示位数（12 位；和与 1 的差仍在 `SUM_TOLERANCE` 内）。 */
function round12(value) {
  return Math.round(value * 1e12) / 1e12
}

/** "如何提升排名"的**确定性**提示（只含无量纲的贡献点，不含任何原始数值/绝对量级）。 */
function hintOf(focus, contributionPoints, fullPoints, potential) {
  if (focus === null) {
    return '在本次候选集里，该家所有取得到的因子都是最好的：没有可提升项（已是可用权重下的上限）'
  }
  const spec = FACTOR_FIELDS.find((entry) => entry.factor === focus)
  return `优先改善「${spec.label}」：该因子现在贡献 ${round6(contributionPoints)} 分（该因子满分 ${round6(fullPoints)} 分）；`
    + `把它做到本次候选集最好，这家的得分可再提高约 ${round6(potential)} 分（得分越高排名越前）`
}

export function apply(ctx, config) {
  const options = { weights: { ...(isPlain(config?.weights) ? config.weights : {}) },
    max_candidates: config?.max_candidates }
  ctx.provide('bidHeuristics', {
    rank: (payload) => rankOf(payload, options),
    /** 分量元数据（页面/接口自述用；不含任何候选数据，也不出输入字段名）。 */
    factors: () => FACTOR_FIELDS.map((spec) => ({ factor: spec.factor, label: spec.label,
      orientation: spec.orientation })),
    config: () => ({ weights: { ...options.weights }, max_candidates: clampLimit(options.max_candidates) }),
  })
}

export function disposer() {
  return () => {}
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => ({
    all: handle.rank({
      weights: { price: 0.6, delivery: 0.15, payment: 0.1, warranty: 0.05, deviation: 0.1 },
      candidates: [
        { code: 'sup-A', unit_price: 100, lead_time_days: 10, payment_terms: 30, warranty_months: 12, deviation_count: 0 },
        { code: 'sup-B', unit_price: 80, lead_time_days: 20, payment_terms: 45, warranty_months: 24, deviation_count: 2 },
        { code: 'sup-C', unit_price: 90 },
      ],
    }),
    one: handle.rank({ weights: { price: 1 }, candidates: [{ code: 'only', unit_price: 1 }] }),
    byItem: handle.rank({ weights: { price: 1 }, candidates: [
      { code: 'sup-A', item: 'L-001', unit_price: 100 },
      { code: 'sup-B', item: 'L-001', unit_price: 80 },
      { code: 'sup-A', item: 'L-002', unit_price: 10 },
    ] }),
  }),
}
