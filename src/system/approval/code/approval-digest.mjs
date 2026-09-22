/**
 * approval-digest —— 人工门（approval）**待批队列**的只读摘要插件（T-250 候选产物，尚未进树）。
 *
 * 做什么：吃调用方传入的**只读行**（人工门队列视图 `queue_view()` 的 items，或等价形状的账本投影行），
 * 只做聚合 —— 不自己捞数据、不改调用方的行、不给判定：
 *   · `digest(rows)`   ——一次汇总：入参行数 / 计入项数 / 被跳过的行数、按**动作**计数的有序数组、
 *                        按**等待时长**分桶（`<1h` / `1-6h` / `6-24h` / `>24h`）、**置信度分布**
 *                        （`none` / `low` <0.6 / `mid` [0.6,0.8) / `high` ≥0.8）、**最长等待项**
 *                        （只给 id/动作/等待秒数，**不给任何正文**）、严格超过阈值 `stale_hours` 的项数、
 *                        以及**生效配置**（夹取后的 `stale_hours` / `max_buckets`，让夹取可被外部核对）；
 *   · `byPolicy(rows)` ——按超时策略（`remind` / `escalate` / `abort`）分组计数（固定枚举序输出）；
 *   · `oldest(rows)`   ——等待最久的那一项（同样只有 id/动作/等待秒数）。
 *
 * 与已进树插件的分工（为什么不是重复造轮子）：
 *   · `evidence-summary`：账本**按事件类型**计数 + 时间跨度（主键是事件类型，看的是"这本账里有什么"）。
 *     本插件主键是**待批事项**，回答的是"人手上还压着多少、各压了多久、哪些按什么策略催办"；
 *   · `supplier-scorecard`：以**供应商**为主键的绩效面（价格/交期/偏差标记），不碰人工门维度；
 *   · `timeline` / `ops-view` / `observability`：面向事件流与运行期快照；本插件面向**人工门队列这一个
 *     业务视图**，输出的是可核对的计数与分桶，不含正文；
 *   · 与 Python 侧 `ApprovalService.queue_view()` 的分工：那边是**真源**（读账本、拿墙钟算 waited_seconds）；
 *     这边是纯函数摘要层，**不引入新口径**（口径在下面写死）、不复算时间、不做任何业务判定 ——
 *     尤其**绝不产出"自动批准/拒绝"类结论**（AGENTS.md 规则 3：承诺需人工批准；超时只有 remind/escalate/abort）。
 *
 * 边界（纪律，围栏门会静态扫描这些字样）：
 *   · **只读**：不写账本、不写文件、不注册事件监听、不注册定时器、不读墙钟（不构造任何时间对象）、
 *     不用随机数、不读环境变量、不做网络调用；
 *   · **确定性**：同输入两次输出字节一致；所有排序显式（动作字典序、策略固定枚举序、最长项用
 *     (等待秒数, id, 动作) 定序兜底）→ 输出与入参顺序无关；
 *   · **不编造**：字段取不到就**跳过**——缺 id 或动作或等待时间的行**整行不计入任何统计**（缺等待时间
 *     **不当 0**）；等待时间必须是 ≥0 的有限数（NaN/±Infinity/字符串数字/负数一律按取不到处理，不解析、不猜）；
 *     缺置信度归 `none`（**不是**某个数值桶）；不在三选一枚举里的策略不进 `byPolicy`（不造 `(unknown)` 桶）；
 *   · **不输出正文**：`oldest` / `digest.oldest` 只有 id/动作/等待秒数，绝不带 `summary` / `payload` / `refs`
 *     等摘要或引用字段 —— 聚合不得变成侧信道；
 *   · **不写调用方的数据**：绝不改写传入的数组或行对象（对冻结输入同样可用）；
 *   · **有界输出**：`max_buckets` 在 [1, 8] 内夹取，非有限数回落默认 4（不静默放行成无界，也不静默变成 0）。
 *
 * 取值口径（写死，避免各处各记一遍）：
 *   · 每个逻辑字段有一组**别名**（域内两种写法都认，行优先、其次 `body`，即：先在行上按别名顺序找全，
 *     找不到再进 `row.body` 按别名顺序找；两处都没有才算取不到）：
 *     id ← `approval_id` | `id`；动作 ← `action` | `scope`；等待 ← `waited_seconds`；
 *     置信度 ← `model_confidence` | `confidence`（记录层叫 confidence、队列视图叫 model_confidence）；
 *     策略 ← `timeout_policy` | `policy`。字段名可由 `Config` 换（换的是**输入**字段名，输出键名固定）。
 *   · 等待时长分桶（**右闭**区间，故标签字面即真值）：`<1h` = 0 ≤ w ≤ 3600；`1-6h` = 3600 < w ≤ 21600；
 *     `6-24h` = 21600 < w ≤ 86400；`>24h` = w > 86400。桶梯（小时）`[1, 6, 24, 72, 168, 720, 2160]` 最多
 *     支撑 8 个桶：`max_buckets` 决定实际吐出几个，**最后一个桶吸收尾部**（变成 `>上界h` 的开区间）——
 *     所以默认 `max_buckets=4` 时正好是上面四个桶。
 *   · `stale` = **严格超过** `stale_hours`（默认 24）的项数 —— 与 `>24h` 桶边界一致：右闭区间让边界项
 *     （w 恰为 24h）归属唯一（落 `6-24h` 桶、**不**计 stale），同一个项不会被两个口径各说一遍。
 */
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'approval-digest'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['approvalDigest']

export const Config = object({
  // 字段名（输出键名固定；这里只换**输入**行的字段名，默认值即域内队列视图的写法）
  id_field: string().default('approval_id'),
  action_field: string().default('action'),
  waited_field: string().default('waited_seconds'),
  confidence_field: string().default('model_confidence'),
  policy_field: string().default('timeout_policy'),
  // 超时阈值（小时）：严格超过它的项计为 stale
  stale_hours: number().default(24),
  // 一次返回的桶数上限（夹取区间 [1, 8]，默认 4）
  max_buckets: number().default(4),
})

/** 秒/桶/口径常量（写死一处）。 */
const HOUR_SECONDS = 3600
const MAX_BUCKETS_FLOOR = 1
const MAX_BUCKETS_CEILING = 8
const MAX_BUCKETS_FALLBACK = 4
const STALE_HOURS_FALLBACK = 24
const CONFIDENCE_LOW = 0.6
const CONFIDENCE_HIGH = 0.8
/** 桶梯（小时，升序）：前 n-1 个是中间边界，第 n 个桶吸收尾部。最多支撑 8 个桶。 */
const LADDER_HOURS = [1, 6, 24, 72, 168, 720, 2160]
/** 超时策略枚举（固定枚举序，不随输入顺序变）。 */
const POLICIES = ['remind', 'escalate', 'abort']
/** 别名（次要写法；主写法由 Config 给）。 */
const ID_ALIASES = ['id']
const ACTION_ALIASES = ['scope']
const CONFIDENCE_ALIASES = ['confidence']
const POLICY_ALIASES = ['policy']

/** 显式字典序比较器：不依赖默认排序的隐含规则，也不受 locale 影响（确定性要求）。 */
const byLex = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const listOf = (rows) => (Array.isArray(rows) ? rows : [])

const isRow = (row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row)

/** 只有有限数字才算一个值；NaN / ±Infinity / 字符串数字一律按「取不到」处理（不解析、不猜）。 */
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** 非空字符串（trim 后）才是文本值；其余按「取不到」处理。 */
const textOrNull = (value) => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

const textOr = (value, fallback) => textOrNull(value) ?? fallback

/** 别名表：主写法在前，去重后冻结（顺序即契约）。 */
const fieldsOf = (primary, aliases) => Object.freeze([...new Set([primary, ...aliases])])

/**
 * 取值顺序是契约：先按别名顺序在**行上**找全，找不到再进 `row.body` 按别名顺序找；
 * 两处都没有 → `undefined`（**不补默认值**）。别名与 body 回退只在这一处识别。
 */
const pickAny = (row, fields) => {
  if (!isRow(row)) return undefined
  for (const field of fields) {
    const direct = row[field]
    if (direct !== undefined && direct !== null) return direct
  }
  const body = row.body
  if (isRow(body)) {
    for (const field of fields) {
      const nested = body[field]
      if (nested !== undefined && nested !== null) return nested
    }
  }
  return undefined
}

/** 事项 id：非空字符串或有限数字才认（数字统一成字符串再比较，保证定序与类型无关）。 */
const idOf = (row, fields) => {
  const value = pickAny(row, fields)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  return textOrNull(value)
}

/** 等待秒数：有限数且 ≥0 才算（负数/字符串/非有限数 → 取不到 → 该行跳过，**不当 0**）。 */
const waitedOf = (row, field) => {
  const value = numOrNull(pickAny(row, [field]))
  if (value === null || value < 0) return null
  return value
}

/** 置信度分桶：缺 / 非 [0,1] 有限数 → `none`（不解析字符串、不替调用方猜）。 */
const confidenceKey = (value) => {
  const amount = numOrNull(value)
  if (amount === null || amount < 0 || amount > 1) return 'none'
  if (amount < CONFIDENCE_LOW) return 'low'
  if (amount < CONFIDENCE_HIGH) return 'mid'
  return 'high'
}

/** 策略：只认三选一枚举（其余不进 `byPolicy`，不造占位桶）。 */
const policyOf = (row, fields) => {
  const value = textOrNull(pickAny(row, fields))
  return value !== null && POLICIES.includes(value) ? value : null
}

/** 桶梯的中间边界（小时）：n 个桶需要 n-1 条边界，最后一个桶吸收尾部。 */
const ladderEdges = (maxBuckets) => LADDER_HOURS.slice(0, maxBuckets - 1)

/** 桶定义（标签 + 下界 + 是否尾部开区间）：右闭区间，故标签字面即真值。 */
const bucketsOf = (maxBuckets) => {
  const edges = ladderEdges(maxBuckets)
  const buckets = []
  for (let index = 0; index < maxBuckets; index += 1) {
    const tail = index === maxBuckets - 1
    const lower = index === 0 ? 0 : edges[index - 1]
    const label = tail
      ? `>${lower}h`
      : (index === 0 ? `<${edges[0]}h` : `${edges[index - 1]}-${edges[index]}h`)
    buckets.push(Object.freeze({ label, lower_hours: lower, open: tail }))
  }
  return Object.freeze(buckets)
}

/** 落桶：第一个「w ≤ 边界」的桶；都超过就落尾部桶（尾部桶吸收剩余）。 */
const bucketIndex = (waitedSeconds, edgesSeconds) => {
  for (let index = 0; index < edgesSeconds.length; index += 1) {
    if (waitedSeconds <= edgesSeconds[index]) return index
  }
  return edgesSeconds.length
}

/** 配置夹取：有限数按 [1, 8] 夹（先取整）；非有限数/缺省 → 默认 4（不静默放行、也不静默归 0）。 */
const clampMaxBuckets = (value) => {
  const amount = numOrNull(value)
  if (amount === null) return MAX_BUCKETS_FALLBACK
  return Math.min(MAX_BUCKETS_CEILING, Math.max(MAX_BUCKETS_FLOOR, Math.floor(amount)))
}

/** 阈值：有限且 ≥0 才认；越界（负数/非有限数）回落默认 24 —— 回落成 0 会把一切都判成超时，是危险的缩水。 */
const staleHoursOf = (value) => {
  const amount = numOrNull(value)
  if (amount === null || amount < 0) return STALE_HOURS_FALLBACK
  return amount
}

/**
 * 单趟扫描（所有聚合共用这一份口径，避免"两个函数两套规则"）：
 * 缺 id / 动作 / 等待时间的行整行跳过；其余逐项累加，最长项在扫描中用 (等待秒数, id, 动作) 定序。
 */
const scanOf = (rows, options) => {
  const list = listOf(rows)
  const actions = new Map()
  const ages = new Array(options.max_buckets).fill(0)
  const confidence = { none: 0, low: 0, mid: 0, high: 0 }
  let total = 0
  let stale = 0
  let oldest = null
  for (const row of list) {
    if (!isRow(row)) continue
    const id = idOf(row, options.id_fields)
    const action = textOrNull(pickAny(row, options.action_fields))
    const waited = waitedOf(row, options.waited_field)
    if (id === null || action === null || waited === null) continue   // 取不到就跳过（不编）
    total += 1
    actions.set(action, (actions.get(action) ?? 0) + 1)
    ages[bucketIndex(waited, options.bucket_edges)] += 1
    confidence[confidenceKey(pickAny(row, options.confidence_fields))] += 1
    if (waited > options.stale_seconds) stale += 1
    if (oldest === null || waited > oldest.waited_seconds
      || (waited === oldest.waited_seconds
        && (byLex(id, oldest.id) < 0 || (id === oldest.id && byLex(action, oldest.action) < 0)))) {
      oldest = { id, action, waited_seconds: waited }
    }
  }
  return { rows: list.length, total, actions, ages, confidence, stale, oldest }
}

/** 纯函数：待批摘要（只读入参，不写回）。 */
export const digestOf = (rows, options) => {
  const scan = scanOf(rows, options)
  return {
    rows: scan.rows,
    total: scan.total,
    skipped: scan.rows - scan.total,
    by_action: [...scan.actions.keys()].sort(byLex)
      .map((action) => ({ action, count: scan.actions.get(action) })),
    by_age: options.buckets.map((bucket, index) => ({ bucket: bucket.label, count: scan.ages[index] })),
    by_confidence: {
      none: scan.confidence.none,
      low: scan.confidence.low,
      mid: scan.confidence.mid,
      high: scan.confidence.high,
    },
    oldest: scan.oldest,
    stale: scan.stale,
    limits: { stale_hours: options.stale_hours, max_buckets: options.max_buckets },
  }
}

/** 纯函数：按超时策略分组计数（只输出**出现过**的策略，顺序固定为枚举序 → 与入参顺序无关）。 */
export const byPolicyOf = (rows, options) => {
  const counts = new Map()
  for (const row of listOf(rows)) {
    if (!isRow(row)) continue
    // 与 digest 同一口径：缺 id / 动作 / 等待时间的行不进统计（两份输出才可交叉核对）
    if (idOf(row, options.id_fields) === null) continue
    if (textOrNull(pickAny(row, options.action_fields)) === null) continue
    if (waitedOf(row, options.waited_field) === null) continue
    const policy = policyOf(row, options.policy_fields)
    if (policy === null) continue
    counts.set(policy, (counts.get(policy) ?? 0) + 1)
  }
  return POLICIES.filter((policy) => counts.has(policy))
    .map((policy) => ({ policy, count: counts.get(policy) }))
}

/** 纯函数：等待最久的一项（口径与 `digest().oldest` 完全同一份定序，返回 null 表示没有可计项）。 */
export const oldestOf = (rows, options) => scanOf(rows, options).oldest

export function apply(ctx, config) {
  const cfg = config ?? {}
  const maxBuckets = clampMaxBuckets(cfg.max_buckets)
  const staleHours = staleHoursOf(cfg.stale_hours)
  const options = Object.freeze({
    id_fields: fieldsOf(textOr(cfg.id_field, 'approval_id'), ID_ALIASES),
    action_fields: fieldsOf(textOr(cfg.action_field, 'action'), ACTION_ALIASES),
    waited_field: textOr(cfg.waited_field, 'waited_seconds'),
    confidence_fields: fieldsOf(textOr(cfg.confidence_field, 'model_confidence'), CONFIDENCE_ALIASES),
    policy_fields: fieldsOf(textOr(cfg.policy_field, 'timeout_policy'), POLICY_ALIASES),
    stale_hours: staleHours,
    stale_seconds: staleHours * HOUR_SECONDS,
    max_buckets: maxBuckets,
    buckets: bucketsOf(maxBuckets),
    bucket_edges: ladderEdges(maxBuckets).map((hours) => hours * HOUR_SECONDS),
  })
  ctx.provide('approvalDigest', {
    digest: (rows) => digestOf(rows, options),
    byPolicy: (rows) => byPolicyOf(rows, options),
    oldest: (rows) => oldestOf(rows, options),
  })
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => ({
    digest: handle.digest([
      { approval_id: 'ap-0001', action: 'quote.submit', model_confidence: 0.72, timeout_policy: 'remind',
        waited_seconds: 300 },
      { body: { approval_id: 'ap-0002', action: 'award.commit', timeout_policy: 'escalate',
        waited_seconds: 90000 } },
      null,
    ]),
    byPolicy: handle.byPolicy([
      { approval_id: 'ap-0002', action: 'award.commit', timeout_policy: 'escalate', waited_seconds: 90000 },
      { approval_id: 'ap-0003', action: 'po.issue', timeout_policy: 'abort', waited_seconds: 60 },
    ]),
    oldest: handle.oldest([
      { approval_id: 'ap-0001', action: 'quote.submit', waited_seconds: 300 },
      { approval_id: 'ap-0002', action: 'award.commit', waited_seconds: 90000 },
    ]),
  }),
}
