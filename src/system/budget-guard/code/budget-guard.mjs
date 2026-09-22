/**
 * 进树中间件候选：`budget-guard`（T-250）—— 运行期**窗口成本预算准入**中间件。
 *
 * 做什么：把"一次调用花了多少钱"按 **key** 记在一个**窗口**里；窗口内累计成本越过预算就**拒绝**这次调用，
 * 并说清"额度什么时候回来 / 还能做什么"。金额一律用**整数微元（µ，1 µ = 1e-6 货币单位）**表示，
 * token → 钱 的换算（`estimate`）也留在代码里用一次乘法 + 显式取整完成 —— 不靠模型估数，也不留浮点尾差。
 *
 * 与既有中间件的分工边界（写清才不是重复造轮子；四者判据互不相同，可叠加在一条链路上）：
 *   · `governor`（额度限流）  按**并发额度**放行：credits 是**容量型**的、`release()` 就归还，管"这一刻能不能
 *                            同时跑、超时多久、重试几次"；它**没有时间窗口、也不看花了多少钱**。
 *   · `circuit-breaker`（熔断）按**失败**切断：连续失败打开断路器、冷却后 half-open 试探；判据是**错误**。
 *   · `idempotency-guard`（判重）按**请求身份**去重：同一请求只做一次、重复请求复用结果；判据是**键相等**。
 *   · 本模块                   按**花费 × 时间窗**准入：窗口内累计成本 + 本次成本 > 预算 → 拒。
 *                             判据是**金额 + 窗口滚动**，与前三者正交：一次调用可以既不重复、下游也健康、
 *                             并发也没打满，但"这个窗口的钱已经花完了" —— 只有本模块挡得住。
 *   典型链路：判重（别重复花钱）→ 熔断（下游坏了别花钱）→ **预算（预算内才花钱）** → 限流（同时别打太满）。
 *
 * 纪律（围栏门会静态扫描这些字样）：
 *   ① **不写账本、不写文件、不订阅事件、不注册定时器**：内存里只有"窗口内的在途花费"，进程结束即消失，
 *      它不是第二本账 —— 要成为事实的花费仍由内核侧落账（H1）。本模块没有任何文件系统调用，也没有
 *      任何事件订阅（不碰 cordis 的事件服务）。
 *   ② **金额只用整数 µ + 显式取整**：累计、比较、拆分全走整数（`Math.ceil` / `Math.trunc` 显式写出），
 *      不会出现 0.0015 + 0.0025 = 0.005000000000000001 这类尾差；取整方向是**向上**（保守）→
 *      "窗口内总花费 ≤ budget"是硬不变量，不会因为尾差把预算花超。
 *   ③ **拒绝可解释**：拒绝一律带 `reason` + `next_action`，不返回裸 false；"单次就超整窗预算、等也没用"
 *      与"窗口滚动后会放行"是**两种**不同的拒绝，不许混为一谈（后者的 `window_reset_in_ms` 才算得出来）。
 *   ④ **窗口判定只用可注入时钟**：默认墙钟全文件只有一处（`defaultClock`），`setClock()` 可整体替换 →
 *      注入假时钟即可复现窗口滚动与额度回收，**不注册任何定时器、不真等**。
 *   ⑤ **有界**：同时记账的 key 数 ≤ `max_keys`（配置越硬上界 `max_keys_limit` 时被夹住）；单桶记录条数
 *      ≤ `max_records`（超出把最老的一段合并，时间戳取这一段里**最新**的 —— 保守方向：只会更晚释放额度，
 *      绝不提前放出来）；窗口内已无花费的桶会被自动回收 → 内存上界与运行时长无关。
 *
 * 对外口径：`charge()` 是**预留式**记账（先算钱、再放行），`spent` / `remaining` / `budget` / 单次 `cost`
 * 的单位**统一是 µ 整数**；要给人看的钱用 `estimate().cost_text`（定点文本，整数拆分得来）。
 */
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'budget-guard'

export const inject = []

export const builtin = []

export const usedServices = []

export const provides = ['budgetGuard']

/** 微元刻度：1 货币单位 = 1_000_000 µ。本模块所有金额都是**整数 µ**（不出现"半个 µ"）。 */
const MICRO_PER_UNIT = 1000000

/** 窗口模式：滑动（逐条记录随时间滚动回收）/ 固定（对齐窗口边界、翻页整块重置）。 */
const MODES = ['sliding', 'fixed']

export const Config = object({
  key: string().default('host'),               // 默认预算桶键（调用方不传 key 时用它）
  window_ms: number().default(60000),          // 窗口长度（毫秒）
  mode: string().default('sliding'),           // 'sliding' | 'fixed'；其它值在**装配期**被拒（不静默退回）
  budget: number().default(1000000),           // 单个窗口内的预算（µ；1000000 µ = 1 单位）
  max_keys: number().default(256),             // 同时记账的 key 数上限
  max_keys_limit: number().default(1024),      // 硬上界：配置也不许超过（超了被夹住）
  max_records: number().default(64),           // 单桶记录条数上限（超出把最老的一段合并）
  max_records_limit: number().default(1024),   // 记录条数硬上界
  price_per_mtok: number().default(0),         // `estimate()` 的缺省单价（每百万 token 的价格）
})

export class BudgetGuardError extends Error {
  constructor(code, message, detail = {}) {
    super(`[${code}] ${message}`)
    this.name = 'BudgetGuardError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 默认墙钟：**全文件唯一一处**墙钟（`setClock()` 可整体替换它 → 测试注入假时钟即可复现窗口判定）。
 * 这里不做任何决策，只是 `clock()` 的初始实现；没有定时器、没有等待。
 */
const defaultClock = () => Date.now()

/** 字段读取（getter 抛错一律退化成 undefined）：畸形入参不许把判定路径炸掉。 */
const readField = (source, name) => {
  try {
    if (source === null || typeof source !== 'object') return undefined
    return source[name]
  } catch {
    return undefined
  }
}

/** 只接受**真正的数字**：字符串 `'5'` 不算（静默把字符串当数字，是"看不出来的放行"的另一种写法）。 */
const readNumber = (source, name) => {
  const value = readField(source, name)
  return typeof value === 'number' ? value : undefined
}

/** 键：不传 → 用默认键；传了但不是非空字符串 → 判无效（绝不把花费记到"猜出来的"桶上）。 */
const keyOf = (raw, fallback) => {
  const value = readField(raw, 'key')
  if (value === undefined) return { key: fallback, ok: true }
  return (typeof value === 'string' && value.length > 0) ? { key: value, ok: true } : { key: null, ok: false }
}

/** µ → 定点十进制文本（整数拆分，不经浮点）：同输入永远同文本，可复现。 */
const microText = (micro) => {
  const value = Math.trunc(micro)
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}${Math.trunc(abs / MICRO_PER_UNIT)}.${String(abs % MICRO_PER_UNIT).padStart(6, '0')}`
}

/**
 * **纯函数式**成本估算：token 数 × 每百万 token 单价 → **整数 µ**。
 * 推导（数值换算留在代码里，不靠模型估）：1 个 token 的钱 = price / 1e6 单位 = price µ（因为 1 单位 = 1e6 µ），
 * 所以 `cost_µ = tokens × price_per_mtok` —— 一次乘法，交给 `Math.ceil` 显式取整（向上，保守：宁多算不少算）。
 * 不抛错：畸形输入返回 `{ ok:false, reason, next_action }`（照样可解释，也不动任何状态）。
 */
const estimateOf = (raw, defaultPrice) => {
  const tokens = readNumber(raw, 'tokens')
  const priceField = readField(raw, 'price_per_mtok')                  // 缺省 vs 传了畸形值要分开：畸形值不许静默退回默认单价
  const price = priceField === undefined ? defaultPrice : priceField
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) {
    return { ok: false, reason: 'tokens-invalid',
      next_action: 'tokens 必须是 ≥ 0 的有限数字（undefined / 字符串 / NaN / Infinity / 负数一律不接受）' }
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    return { ok: false, reason: 'price-invalid',
      next_action: 'price_per_mtok 必须是 ≥ 0 的有限数字（不传时才用 config.price_per_mtok）' }
  }
  const product = tokens * price
  if (!Number.isFinite(product)) {
    return { ok: false, reason: 'product-overflow',
      next_action: '乘积超出双精度范围：请分次估算或换用更小的计量单位' }
  }
  const costMicro = Math.ceil(product)
  return { ok: true, tokens, price_per_mtok: price, cost_micro: costMicro, cost_text: microText(costMicro),
    formula: 'cost_µ = ceil(tokens × price_per_mtok)', exact: Number.isSafeInteger(costMicro),
    next_action: '把 cost_micro 交给 charge({key, cost: cost_micro}) 做预算准入' }
}

export function apply(ctx, config) {
  // 装配期就把看不懂的配置**拒掉**（响的失败，不是静默退化）：模式 / 预算 / 单价都不许是"猜得出来"的值
  if (!MODES.includes(config.mode)) {
    throw new BudgetGuardError('config-mode-invalid',
      `mode=${JSON.stringify(config.mode)} 不在 ${JSON.stringify(MODES)} 内`, { mode: config.mode })
  }
  // 数值配置一律要求"有限数字"：NaN / Infinity 会让"预算"和"有界"**静默失效**（NaN 比较恒为 false），
  // 所以这里响地拒掉，而不是退化成默认值。`number()` 只保证类型是 number，NaN 也算 number。
  for (const field of ['window_ms', 'budget', 'max_keys', 'max_keys_limit', 'max_records', 'max_records_limit', 'price_per_mtok']) {
    if (!Number.isFinite(config[field])) {
      throw new BudgetGuardError('config-number-invalid',
        `${field}=${String(config[field])} 必须是有限数字（NaN/Infinity 会让有界性与预算静默失效）`, { field })
    }
  }
  if (config.price_per_mtok < 0) {
    throw new BudgetGuardError('config-price-invalid', `price_per_mtok=${config.price_per_mtok} 必须是 ≥ 0 的有限数字`)
  }
  const mode = config.mode
  const windowMs = Math.max(1, Math.floor(config.window_ms))        // 时间用 floor（毫秒无小数语义）
  const budget = Math.max(0, Math.ceil(config.budget))             // 金额用 ceil（保守：宁可少发额度）
  const keyLimit = Math.max(1, Math.floor(config.max_keys_limit))
  const maxKeys = Math.min(Math.max(1, Math.floor(config.max_keys)), keyLimit)      // 夹取：越硬上界即被夹住
  const recordLimit = Math.max(1, Math.floor(config.max_records_limit))
  const maxRecords = Math.min(Math.max(1, Math.floor(config.max_records)), recordLimit)
  const defaultPrice = config.price_per_mtok

  const buckets = new Map()   // key → { key, records:[{at, cost_micro}], spent, window_id, touched }
  const stats = { charged: 0, admitted: 0, refused: 0, refused_budget: 0, refused_oversized: 0,
    refused_invalid: 0, evicted: 0, reclaimed: 0, coalesced: 0 }
  let clock = defaultClock
  let tick = 0                // 自增序号：只做"最久未触碰"的**确定性**依据（与真实时间无关，可复现）

  const windowIdOf = (now) => Math.floor(now / windowMs)

  /** 窗口内已花（**纯计算**，不改状态）：滑动=窗口内记录之和；固定=当前窗口 id 相同的累计。 */
  const spentOf = (bucket, now) => {
    if (bucket === null) return 0
    if (mode === 'fixed') return bucket.window_id === windowIdOf(now) ? bucket.spent : 0
    let total = 0
    for (const record of bucket.records) {
      if (now - record.at < windowMs) total += record.cost_micro    // 占用区间：(now - window_ms, now]
    }
    return total
  }

  /**
   * 最早能腾出 `needed` µ 的毫秒数（窗口滚动/记录过期的时间；固定窗口=翻页那一刻）。
   * 滑动窗口按**写入顺序**累加可释放的额度，够 `needed` 就返回那条记录的过期时刻；不够则等到最后一条过期。
   */
  const resetInOf = (bucket, now, needed) => {
    if (mode === 'fixed') {
      const id = windowIdOf(now)
      return (bucket !== null && bucket.window_id === id && bucket.spent > 0) ? (id + 1) * windowMs - now : 0
    }
    if (bucket === null || bucket.records.length === 0) return 0
    let freed = 0
    for (const record of bucket.records) {
      if (now - record.at >= windowMs) continue                     // 已出窗口（尚未回收）
      freed += record.cost_micro
      if (freed >= needed) return Math.max(0, record.at + windowMs - now)
    }
    const last = bucket.records[bucket.records.length - 1]
    return Math.max(0, last.at + windowMs - now)
  }

  /**
   * 单桶记录条数有界：超出就把**最老的一段**合并成一条，时间戳取这一段里**最新**的
   * —— 保守方向：合并只会**更晚**释放额度，绝不会提前放出来（提前放出 = 超发预算）。
   */
  const capRecords = (bucket) => {
    if (bucket.records.length <= maxRecords) return
    const mergeCount = bucket.records.length - maxRecords + 1
    const merged = bucket.records.slice(0, mergeCount)
    const newestAt = merged[merged.length - 1].at
    let total = 0
    for (const record of merged) total += record.cost_micro
    bucket.records.splice(0, mergeCount, { at: newestAt, cost_micro: total })
    stats.coalesced += 1
  }

  /** 拿桶（不存在就建）+ 刷新"最久未触碰"序号。 */
  const bucketOf = (key, now) => {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { key, records: [], spent: 0, window_id: windowIdOf(now), touched: 0 }
      buckets.set(key, bucket)
    }
    bucket.touched = tick
    tick += 1
    return bucket
  }

  /** 记一笔花费：滑动窗口逐条留时间戳；固定窗口进当前窗口的累计（翻页先清零）。 */
  const commit = (bucket, now, costMicro) => {
    if (mode === 'fixed') {
      const id = windowIdOf(now)
      if (bucket.window_id !== id) { bucket.window_id = id; bucket.spent = 0; bucket.records.length = 0 }
      bucket.spent += costMicro
      return
    }
    bucket.records.push({ at: now, cost_micro: costMicro })
    capRecords(bucket)
  }

  /**
   * 桶数上界：超过 `max_keys` 就淘汰**最久未触碰**的那个。淘汰依据是自增序号（不是墙钟）→ 同一序列可复现。
   * 刚记账的桶的序号最新 → 永远不会淘汰到"这一笔"（纪律：有界不许以丢掉刚放行的花费为代价）。
   */
  const evictOldest = () => {
    while (buckets.size > maxKeys) {
      let victimKey = null
      let victimTouched = Infinity
      for (const [key, bucket] of buckets) {
        if (bucket.touched < victimTouched) { victimTouched = bucket.touched; victimKey = key }
      }
      if (victimKey === null) break
      buckets.delete(victimKey)
      stats.evicted += 1
    }
  }

  /** 回收 + 夹取：窗口内已无花费的桶直接删掉，然后把桶数压回上界内。 */
  const sweep = (now) => {
    for (const [key, bucket] of [...buckets]) {
      if (spentOf(bucket, now) === 0) {
        buckets.delete(key)
        stats.reclaimed += 1
      }
    }
    evictOldest()
  }

  /** 只读视图（不改状态、不建桶）：某个 key 现在这个窗口花了多少、还剩多少。 */
  const viewOf = (key, bucket, now) => {
    const spent = spentOf(bucket, now)
    return { key, present: bucket !== null, spent, remaining: Math.max(0, budget - spent), budget, mode,
      window_ms: windowMs, window_id: mode === 'fixed' ? windowIdOf(now) : null,
      records: bucket === null ? 0 : bucket.records.length, window_reset_in_ms: resetInOf(bucket, now, 0) }
  }

  /** 统一拒绝出口：**永远**给 reason + next_action（绝不返回裸 false）。 */
  const deny = (reason, nextAction, key, bucket, now, extra = {}) => {
    stats.refused += 1
    return { ...viewOf(key, bucket, now), admitted: false, cost_micro: null, reason, next_action: nextAction, ...extra }
  }

  /**
   * 准入 + 记账（预留式：先算钱，再放行）。
   * 返回**永远**是对象：`{admitted, spent, remaining, reason, next_action, window_reset_in_ms, ...}`，
   * `admitted` 为 false 时必然带 `reason` + `next_action`；畸形入参既不许崩，也不许留下痕迹。
   */
  const charge = (raw) => {
    const now = clock()
    const input = (raw !== null && typeof raw === 'object') ? raw : null
    if (input === null) {
      stats.refused_invalid += 1
      return deny('arg-invalid', 'charge({key, cost}) 需要一个对象参数（cost 必填、单位 µ，整数或小数都行但会计整）',
        config.key, null, now)
    }
    const keyed = keyOf(input, config.key)
    if (!keyed.ok) {
      stats.refused_invalid += 1
      return deny('key-invalid', 'key 必须是非空字符串（不传则用 config.key；绝不把花费记到猜出来的桶上）',
        config.key, null, now)
    }
    const key = keyed.key
    const costRaw = readNumber(input, 'cost')
    if (costRaw === undefined || !Number.isFinite(costRaw) || costRaw < 0) {
      stats.refused_invalid += 1
      return deny('cost-invalid',
        'cost 必须是 ≥ 0 的有限数字（µ）：字符串/NaN/Infinity/负数/缺失一律拒绝 —— 负数等于返还额度，会超发预算',
        key, buckets.get(key) ?? null, now)
    }
    const costMicro = Math.ceil(costRaw)          // 显式向上取整：不因浮点尾差少算花费

    sweep(now)                                     // 回收 + 夹取（有界）
    const existing = buckets.get(key) ?? null       // 先只读地看现有桶：**可能拒绝**的分支不许建桶
    const spent = spentOf(existing, now)
    const remaining = Math.max(0, budget - spent)
    const base = { cost_micro: costMicro, budget, mode, window_ms: windowMs,
      window_id: mode === 'fixed' ? windowIdOf(now) : null }

    if (costMicro > budget) {                      // 单次就超过整个窗口预算 → **等也没用**
      stats.refused += 1
      stats.refused_oversized += 1
      const need = budget - remaining
      return { ...viewOf(key, existing, now), ...base, admitted: false,
        over_by: Math.max(0, costMicro - remaining), window_reset_in_ms: resetInOf(existing, now, need),
        reason: 'cost-exceeds-budget',
        next_action: `单次成本 ${costMicro}µ 已超过整个窗口预算 ${budget}µ：窗口滚动也不会放行（等到什么时候都不行），` +
          '请提高 budget、拆分调用或降低单次用量' }
    }
    if (spent + costMicro > budget) {              // 预算内但本窗口已花完 → 说清"多久后回来"
      stats.refused += 1
      stats.refused_budget += 1
      const need = spent + costMicro - budget
      const resetIn = resetInOf(existing, now, need)
      return { ...viewOf(key, existing, now), ...base, admitted: false, over_by: need,
        window_reset_in_ms: resetIn, reason: 'budget-exceeded',
        next_action: `本窗口已花 ${spent}µ / 预算 ${budget}µ，还差 ${need}µ：约 ${resetIn}ms 后额度会腾出来（用退化/degrade 路径或等窗口滚动）` }
    }

    const bucket = bucketOf(key, now)              // 只有真的可能放行时才建桶
    commit(bucket, now, costMicro)
    evictOldest()                                  // 建桶之后立刻压回上界：桶数**任何时刻**都不超 max_keys
    const after = spent + costMicro
    stats.charged += costMicro
    stats.admitted += 1
    return { ...viewOf(key, bucket, now), ...base, admitted: true, spent: after, remaining: budget - after,
      window_reset_in_ms: resetInOf(bucket, now, 0), reason: 'admitted',
      next_action: `放行：本窗口余额 ${budget - after}µ；这是**预留**式记账，同一笔花费不要再记第二次` }
  }

  ctx.provide('budgetGuard', {
    charge,
    /** 纯函数式换算（不碰状态、不抛错）：token 数 × 每百万 token 单价 → 整数 µ。 */
    estimate: (raw) => estimateOf(raw, defaultPrice),
    /** 纯读取：某个 key 当前窗口的花费/余额（**不建桶、不回收、不动统计**）。 */
    peek: (raw = {}) => {
      const keyed = keyOf(raw, config.key)
      const key = keyed.ok ? keyed.key : null
      return viewOf(key, key === null ? null : (buckets.get(key) ?? null), clock())
    },
    stats: () => ({ ...stats, keys: buckets.size, max_keys: maxKeys, max_records: maxRecords,
      budget, window_ms: windowMs, mode }),
    config: () => ({ key: config.key, window_ms: windowMs, mode, budget, max_keys: maxKeys,
      max_keys_limit: keyLimit, max_records: maxRecords, max_records_limit: recordLimit,
      price_per_mtok: defaultPrice }),
    /** 清记账（不动统计）：`reset({key})` 清一个桶，`reset()` 清全部 —— 调用方显式重置窗口内欠账用。 */
    reset: (raw = {}) => {
      const keyed = keyOf(raw, config.key)
      if (keyed.ok && raw !== null && typeof raw === 'object' && readField(raw, 'key') !== undefined) {
        const cleared = buckets.delete(keyed.key) ? 1 : 0
        return { scope: 'key', key: keyed.key, cleared, keys: buckets.size }
      }
      const cleared = buckets.size
      buckets.clear()
      return { scope: 'all', key: null, cleared, keys: 0 }
    },
    /** 注入时钟：默认墙钟 `defaultClock`，可整体替换 → 窗口判定可复现（**不注册任何定时器、不真等**）。 */
    setClock: (impl) => { clock = typeof impl === 'function' ? impl : defaultClock },
  })
}

/** fixture 采样点：**纯读取**（A5 会连跑两次比对字节；这里只读配置/统计 + 一次纯函数估算，不碰时钟、不建桶）。 */
export const fixture = {
  sample: (handle) => ({
    config: handle.config(),
    stats: handle.stats(),
    estimate: handle.estimate({ tokens: 1500, price_per_mtok: 3 }),
  }),
}
