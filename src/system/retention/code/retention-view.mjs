/**
 * retention-view —— **留存计划的只读聚合视图**（T-254 候选产物；与 `ops-view` 同族：只组合、不自算）。
 *
 * 为什么需要它：T-252/T-253 把留存**判定**（`services/retention.py`）与**执行**（`retention_exec.py`）落了地，
 * 但判定结果**没有消费方** —— 运维在 WebUI 上看不到「多少条到期 / 待归档 / 待销毁副本 / 被拒 / 需人工门」。
 * 本模块把一份**已经算好的**留存计划变成可读聚合视图：不改判定、不碰执行、不落任何痕。
 *
 * 分工（不重复造轮子）：
 *   · `services/retention.py`    ：判定器（谁 keep / archive / purge-copy、谁需要人工门）——**唯一判定方**；
 *   · `services/retention_exec.py`：执行器（真删派生副本、落痕）——本模块**完全不接触**；
 *   · 本模块                      ：只读聚合 + 一行人类可读摘要。数字照抄计划，动作名照抄条目。
 *
 * 纪律（每条都有 `host/t254-retention-view-gate.mjs` 的断言看着；ADR-0018 / ADR-0016）：
 *   · **只组合、不自算**：不判断「该不该归档/销毁」，也不拿 `items` 重算 `counts` —— 两者不一致时照抄计划里的
 *     权威计数（重算等于另立口径，且会把「计划错了」这件事抹平）；
 *   · **不出正文与私域键**：条目只读 `id`/`object`/`type`/`age_days`/`action` 五个键，其余键**不读也不记事名**
 *     （名字泄漏本身就是本项目踩过的坑）；保留字段里出现私域标记（`private:` / `body` / `reserve_price` /
 *     `cost_model` / `signature`）或控制字符的值一律替换为 `(redacted)`；
 *   · **确定性**：不读墙钟、不随机、不依赖入参顺序 —— 同一份计划两次 `snapshot()` **字节一致**；
 *   · **有界**：`oldest` 至多 `max_items` 条（超出部分在 `omitted` 里报数），`headline` 按 UTF-8 字节夹取到 `max_bytes`；
 *   · **零 I/O、零事件**：不订阅事件、不注册定时器、不读写文件、不发事件；
 *   · **容错不崩**：计划缺失或形状非法 → 返回**全零形状**并置 `degraded: true`，绝不抛异常。
 *     宁可让运维看到「不可用」并去查上游，也不给一个看起来健康的零。
 */
import { number, object } from '../lib/std-schema.mjs'

/**
 * **P32：外部行数组的唯一读数入口**（口径见 `src/system/webui/docs/row-action-prefill.md` §4）。
 * 只认**非 null 的对象**行：数组里混进 `null`/字符串/数字/嵌套数组时，裸读 `row.action` 抛
 * `TypeError` ⇒ 这一页/这块面板整块崩掉（外壳判 `data-failed`、SSR 路由 500）。
 * 坏行**逐条计数**（`bad`，调用方必须如实报出）、**好行照列**；源不是数组 ⇒ `list:false`（「读不出来」≠「零行」）。
 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, rows: [], all: 0, bad: 0 }
  const rows = []
  let bad = 0
  for (const row of value) { if (isRow(row)) rows.push(row); else bad += 1 }
  return { list: true, rows, all: value.length, bad }
}

export const name = 'retention-view'
export const inject = []            // 纯函数插件：不依赖任何其他服务（计划由调用方给）
export const builtin = []
export const usedServices = []
export const provides = ['retentionView']

export const Config = object({
  max_items: number().default(12),   // oldest 列表上限（有界，避免大计划把视图变成全量转储）
  max_bytes: number().default(4096), // headline 的 UTF-8 字节上限
})

/** 视图会输出的计数键（契约固定七项；计划里的 `total`/`undecided` 等**不**在此视图口径内）。 */
export const COUNT_KEYS = ['keep', 'archive', 'purge-copy', 'accepted', 'rejected', 'refused', 'approval_required']
/** 条目里允许被读取的键（与 `retention.py` 的 `READ_KEYS` 同一纪律：白名单之外一律不读）。 */
export const ITEM_KEYS = ['id', 'object', 'type', 'age_days', 'action']
/** 私域标记：值里一旦出现，整段替换（不回显、不截断式泄漏）。 */
const MARKERS = [/private:/i, /\bbody\b/i, /\breserve_price\b/i, /\bcost_model\b/i, /\bsignature\b/i,
  /[\u0000-\u001f\u007f]/]
const REDACTED = '(redacted)'
/** 降级时的说明（无数字，避免被当成一份"零的"统计读） */
const DEGRADED_HEADLINE = '留存计划不可用（形状非法）：不猜，计数不展示'

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 计划里的计数：有限、非负的整数才收；NaN/Infinity/字符串/负数/缺失一律判为「不可用」。 */
const asCount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.trunc(value) : null)

/** 配置夹取：非有限数回落到默认值，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, number))
}

/** 只放行**单行、无标记**的标识串；命中私域标记或控制字符 → 统一 `(redacted)`；非字符串/空串 → null。 */
const scrub = (value) => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return MARKERS.some((pattern) => pattern.test(text)) ? REDACTED : text
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符，结果字节数必然 ≤ maxBytes）。 */
const clip = (text, maxBytes) => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

export function apply(ctx, config) {
  const maxItems = clampInt(config?.max_items, 12, 0, 200)
  const maxBytes = clampInt(config?.max_bytes, 4096, 0, 1048576)

  /** 全零形状：字段与正常输出**同一个形状**，只是数字全是 0、列表全空、`degraded: true`。 */
  const zeroShape = () => ({
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    action_mix: [],
    pending_approvals: 0,
    refused: 0,
    oldest: [],
    bounded: false,
    omitted: 0,
    degraded: true,
    source: 'retention-view',
    privacy: { entry_bodies_included: false, private_keys_included: false },
  })

  /** 留存计划 → 只读快照。**全部数字来自 `plan`**；本函数不做任何「应该怎样」的判断。 */
  const snapshot = (plan) => {
    // 形状门槛（宁可不判）：缺 counts/items/approvals/rejected 或类型不对 → 全零 + degraded
    if (!isPlain(plan) || !isPlain(plan.counts) || !Array.isArray(plan.items)
      || !Array.isArray(plan.approvals) || !Array.isArray(plan.rejected)) return zeroShape()
    const counts = {}
    for (const key of COUNT_KEYS) {
      const value = asCount(plan.counts[key])
      if (value === null) return zeroShape()
      counts[key] = value
    }
    // 逐条只读白名单字段；缺 id/type/age_days/action 的行**整行跳过**（不猜、不当 0）
    const usable = []
    // P32：`plan.items` 是外部给的行数组 ⇒ 走唯一读数入口（非对象行本来就被下面的 `isPlain` 挡掉，
    // 这里把口径显式化：漏一条坏形状 = 这条读不出来，而不是整页崩）
    for (const row of readRows(plan.items).rows) {
      if (!isPlain(row)) continue
      const action = scrub(row.action)
      const age = typeof row.age_days === 'number' && Number.isFinite(row.age_days) ? row.age_days : null
      if (action === null || age === null) continue
      usable.push({
        id: scrub(row.id) ?? scrub(row.object) ?? '(unknown)',   // 账本行的 id 为 null：退回 object（seq:N）
        type: scrub(row.type) ?? '(unknown)',
        age_days: age,
        action,
      })
    }
    // 排序只是**展示**（最老的排前面），不改变任何动作判定；平手用 id 兜底 → 与入参顺序无关
    const ordered = [...usable].sort((left, right) => (right.age_days - left.age_days) || byName(left.id, right.id))
    const oldest = ordered.slice(0, maxItems)
    // action_mix 归纳的是**条目里实际出现的动作名**（不预设词表：判定器将来加动作，这里自动跟上）
    const mix = new Map()
    for (const item of usable) mix.set(item.action, (mix.get(item.action) ?? 0) + 1)
    const action_mix = [...mix.entries()].sort((left, right) => byName(left[0], right[0]))
      .map(([action, count]) => ({ action, count }))
    const dropped = ordered.length - oldest.length
    const sourceOmitted = asCount(plan.bounded?.omitted) ?? 0   // 计划**自己**被夹取掉的部分也算 omitted
    // 人工门引用：只数**未决**的条数（判定器一律 status=pending；已决的不计，避免把"已批"说成"待批"）
    const pending = plan.approvals.filter((row) => isPlain(row)
      && (row.status === undefined || row.status === 'pending' || row.status === 'requested')).length
    return {
      counts,
      action_mix,
      pending_approvals: pending,
      refused: counts.refused,
      oldest,
      bounded: dropped > 0 || sourceOmitted > 0,
      omitted: dropped + sourceOmitted,
      degraded: false,
      source: 'retention-view',
      privacy: { entry_bodies_included: false, private_keys_included: false },
    }
  }

  /** 一行人类可读摘要（四段：待归档 / 待销毁副本 / 需人工门 / 已拒）；受 `max_bytes` 字节夹取。 */
  const headline = (plan) => {
    const snap = snapshot(plan)
    const text = snap.degraded ? DEGRADED_HEADLINE
      : `待归档 ${snap.counts.archive} / 待销毁副本 ${snap.counts['purge-copy']}`
        + ` / 需人工门 ${snap.counts.approval_required} / 已拒 ${snap.counts.refused}`
    return clip(text, maxBytes)
  }

  ctx.provide('retentionView', { snapshot, headline })
}

/** fixture：纯读取（连跑两次比对字节；形状与 `retention.py::RetentionPolicy.plan` 一致，只留视图会读的键） */
const SAMPLE_PLAN = {
  counts: { keep: 1, archive: 1, 'purge-copy': 1, accepted: 3, rejected: 0, refused: 0, approval_required: 1 },
  items: [
    { object: 'seq:1', id: null, type: 'audit/decision', age_days: 120.5, action: 'keep' },
    { object: 'id:copy:export-1', id: 'copy:export-1', type: 'export/bundle', age_days: 9, action: 'archive' },
    { object: 'id:copy:proj-2', id: 'copy:proj-2', type: 'cache/projection', age_days: 3, action: 'purge-copy' },
  ],
  approvals: [{ scope: 'evidence.purge-copy', ref: 'id:copy:proj-2', status: 'pending' }],
  rejected: [],
  bounded: { limit: 20, listed: 3, omitted: 0, truncated: false },
}

export const fixture = {
  plan: SAMPLE_PLAN,
  sample: (handle) => ({
    snap: handle.snapshot(SAMPLE_PLAN),
    again: handle.snapshot(SAMPLE_PLAN),
    text: handle.headline(SAMPLE_PLAN),
  }),
}
