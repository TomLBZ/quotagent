/**
 * 进树模块：`admin-view` —— admin 面板的**只读数据视图**（阻塞清单 + 进度计数）。
 * 与 `pipeline-view`、`retention-view`、`ops-view` 同族：**只组合、不自算**。
 *
 * 分工（谁产生、谁展示）：
 *   · **判定在 Python 侧**：阻塞事实（`admin/block-*`）只由 Python 服务写账本；面板要看的聚合快照由
 *     Python 判定器（`tools/refresh-admin-snapshot.py` 一类写入器）从真来源（任务登记表的 blocked 行 +
 *     服务自述的不可用原因）生成，落到**一个快照文件**；
 *   · **本模块只读那一个文件**：解析 → 按键白名单投影 → 有界 → 降级优先。数字照抄快照，
 *     绝不拿 `blocks[]` 的长度去反推计数（D-056：计数与列表不得相互冒充）；
 *   · **宿主不写账本（H1）**：本模块没有任何账本路径，也不写任何文件（只 `readFileSync` 那一个快照）。
 *
 * 快照约定（写入器契约；本模块对形状**从严**，形状不对就降级，绝不猜）：
 * ```
 * {
 *   "generated_at": "...",                     // 不转发：看板不显示「这份快照何时生成」这类元数据
 *   "counts":     { "blocked": 2, "pending": 0, "resolved": 1, "rejected": 0, "expired": 0 },
 *   "counts_source": "registry+facts",         // **口径来源**（必须标注；也接受 `counts.source`）
 *   "blocks":     [ { "block_id": "...", "kind": "credential", "state": "blocked",
 *                     "reason": "...", "required_action": "...", "refs": ["..."] } ],
 *   "progress":   { "done": 41, "todo": 7, "blocked": 2, "phase": "P3 落地",
 *                   "next_task": "T-272", "caliber": "progress-checklist+services" }
 * }
 * ```
 * （口径来源**必须标注**：计数认 `counts_source` 或 `counts.source`；进度认 `progress.source` 或
 * `progress.caliber`，或由 `progress.sources` 的键名拼出标签。两处**各读各的**，一个都不给就降级。）
 *
 * 纪律（每条都有 `host/t271-admin-gate.mjs` 的断言看着）：
 *   · **降级优先**：文件缺失/读不到/不是 JSON/不是对象 / `blocks` 非数组 / 计数非法 / 缺口径来源 /
 *     进度里一个数字都没有 → `degraded:true` + 全零同形状 + `reason` + `next_action`，绝不抛异常；
 *     **不得报「零阻塞」冒充健康**：零值只在 `degraded:true` 且带原因时才允许出现（这是本模块最容易
 *     犯的错：把「读不到」显示成「没有阻塞」）；
 *   · **只组合不自算**：`counts` 与 `progress` 照抄快照（与 `blocks[]` 是否一致不是本视图的事）；
 *     口径来源只**声明式**读取：计数的口径取 `counts_source`（或 `counts.source`），进度的口径取
 *     `progress.source`（或 `progress.caliber`，或由 `progress.sources` 的**键名**拼出的标签）——
 *     两处**各读自己那一份**（D-056：两个口径不得相互冒充），都没有就降级；
 *   · **不出正文与私域键**：只读白名单键（`block_id`/`kind`/`state`/`reason`/`required_action`/`refs`；
 *     进度的数字键 + 声明型字符串键 `source`/`caliber`/`phase`/`next_task`），其余键**不读也不记事名**。
 *     保留字段里一旦出现私域/正文标记
 *     （`private:` / `body` / `subject` / `attachment` / `reserve_price` / `cost_model` / `signature` /
 *     `cost_floor` / `markup_pct` / `bidders_private` / `internal_notes`）或控制字符，整段替换为
 *     `(redacted)`；也不转发任何绝对时刻；
 *   · **确定性**：不读墙钟、不随机、不依赖输入顺序（状态计数按固定键序、blocks 按快照顺序）→
 *     同一份快照两次 `project()` **字节一致**；
 *   · **有界**：`blocks` 至多 `max_blocks` 条（超出在 `omitted_blocks` 报数）、每块 `refs` 至多
 *     `max_refs` 条（超出在 `omitted_refs` 报数）、`headline` 按 UTF-8 字节夹到 `max_bytes`；
 *   · **零事件**：不订阅事件、不注册定时器、子进程/网络一概不用。
 */
import { readFileSync } from 'node:fs'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'admin-view'
export const inject = []                 // 纯函数插件：快照路径由配置给（宿主一律「Python 写文件、宿主只读」）
export const builtin = []
export const usedServices = []
export const provides = ['adminView']

export const Config = object({
  admin_snapshot: string().default(''),  // 快照文件的**绝对路径**（生产 cwd≠仓库根，相对路径会读不到）
  max_blocks: number().default(20),
  max_refs: number().default(4),
  max_bytes: number().default(256),      // headline 的 UTF-8 字节上限
})

/** 阻塞状态（**与 Python 侧状态机同名**：blocked → pending → resolved / rejected / expired）。 */
export const STATES = ['blocked', 'pending', 'resolved', 'rejected', 'expired']
/** 每个阻塞项**只读**这些键（其余键不读、不透传）。 */
export const BLOCK_KEYS = ['block_id', 'kind', 'state', 'reason', 'required_action', 'refs']
/** 输出键集合（固定形状：降级与正常**同一个键集**，调用方不必猜）。 */
export const OUTPUT_KEYS = ['blocks', 'bounded', 'counts', 'degraded', 'next_action', 'omitted_blocks',
  'omitted_refs', 'privacy', 'progress', 'reason', 'source']
/** 降级原因码（闭合集合；门据此断言「降级是有名的，不是含糊的」）。 */
export const DEGRADED_REASONS = ['snapshot-not-configured', 'snapshot-missing', 'snapshot-unreadable',
  'snapshot-not-an-object', 'snapshot-blocks-invalid', 'snapshot-counts-invalid',
  'snapshot-counts-source-missing', 'snapshot-progress-invalid', 'snapshot-progress-source-missing']
/** 私域/正文标记：值里一旦出现，整段替换（不回显、不截断式泄漏）。 */
const MARKERS = [/private:/i, /\bbody\b/i, /\bsubject\b/i, /\battachment\b/i, /\breserve_price\b/i,
  /\bcost_model\b/i, /\bsignature\b/i, /\bcost_floor\b/i, /\bmarkup_pct\b/i, /\bbidders_private\b/i,
  /\binternal_notes\b/i, /[\u0000-\u001f\u007f]/]
const REDACTED = '(redacted)'
const DEGRADED_NEXT_ACTION = '检查 Python 侧快照写入器（admin 阻塞/进度快照）的输出文件与形状'
/** 进度键名白名单（**形状**白名单：小写词 + 数字，避免把任意键名透传出去）。 */
const PROGRESS_KEY = /^[a-z][a-z0-9_]{0,31}$/
/** 进度里的**声明型字符串键**（按键白名单：只这几个键允许是字符串；值走同一套清洗 + 字节夹取）。 */
export const PROGRESS_LABEL_KEYS = ['source', 'caliber', 'phase', 'next_task']
/** 声明型字符串的字节上限（`next_task` 这类自由文本也要有界）。 */
const LABEL_MAX_BYTES = 160
/** 阻塞项保留字段的字节上限（写入器给的是散文，面板要有界；超长按整码点夹取）。 */
const BLOCK_MAX_BYTES = 400
/** 由 `progress.sources` 的**键名**拼出口径标签的上限（只取标识符，不取内容）。 */
const MAX_SOURCE_NAMES = 4

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 计数：有限、非负的整数才收；NaN/Infinity/字符串/负数一律判「不可用」。 */
const asCount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.trunc(value) : null)

const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

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

export function apply(ctx, config) {
  const maxBlocks = clampInt(config?.max_blocks, 20, 0, 1000)
  const maxRefs = clampInt(config?.max_refs, 4, 0, 64)
  const maxBytes = clampInt(config?.max_bytes, 256, 0, 1048576)
  const snapshotPath = String(config?.admin_snapshot ?? '')

  /** 降级形状：**与正常输出同一个键集**，只是全零/空列表 + `degraded:true` + 有名原因。 */
  const degradedShape = (reason) => ({
    blocks: [],
    counts: { ...Object.fromEntries(STATES.map((state) => [state, 0])), source: 'unavailable' },
    progress: { source: 'unavailable' },
    omitted_blocks: 0,
    omitted_refs: 0,
    bounded: false,
    degraded: true,
    reason,
    next_action: DEGRADED_NEXT_ACTION,
    source: 'admin-view',
    privacy: { entry_bodies_included: false, private_keys_included: false },
  })

  /**
   * 计数（**照抄**快照）：只读 `STATES` 里的键；未声明的状态记 0；出现非法值 → 判不可用（降级）。
   * 「一个状态都没声明」同样判不可用 —— 否则写入器什么都不说也会被显示成「零阻塞，健康」。
   */
  const readCounts = (raw) => {
    if (!isPlain(raw)) return null
    const out = {}
    let declared = 0
    for (const state of STATES) {
      const value = raw[state]
      if (value === undefined || value === null) { out[state] = 0; continue }
      const count = asCount(value)
      if (count === null) return null
      out[state] = count
      declared += 1
    }
    return declared === 0 ? null : out
  }

  /**
   * 进度（**照抄**快照）：数字键收「安全键名 + 有限非负数字」；四个声明型字符串键另收（清洗 + 夹取）；
   * 其余键（嵌套对象、非法键名、私域标记键名）一律丢弃（不透传）。
   * 口径来源**声明式**读取：`source` → `caliber` → 由 `sources` 的键名拼标签；都没有 → 判不可用。
   */
  const readProgress = (raw) => {
    if (!isPlain(raw)) return null
    const values = {}
    const labels = {}
    for (const key of Object.keys(raw).sort(byName)) {
      if (!PROGRESS_KEY.test(key) || MARKERS.some((pattern) => pattern.test(key))) continue
      const value = raw[key]
      if (PROGRESS_LABEL_KEYS.includes(key)) {
        const text = typeof value === 'string' ? scrub(clip(value, LABEL_MAX_BYTES)) : null
        if (text !== null) labels[key] = text
        continue
      }
      const count = asCount(value)
      if (count === null) continue
      values[key] = count
    }
    if (Object.keys(values).length === 0) return null       // 一个数字都没有 = 这不是进度
    const out = { ...values }
    if (labels.phase) out.phase = labels.phase
    if (labels.next_task) out.next_task = labels.next_task
    return { values: out, caliber: labels.source ?? labels.caliber ?? declaredSourcesLabel(raw.sources) ?? '' }
  }

  /** 由 `progress.sources` 的键名（服务名之类的标识符）拼出口径标签；只取标识符、只取前 N 个。 */
  const declaredSourcesLabel = (raw) => {
    if (!isPlain(raw)) return null
    const names = Object.keys(raw)
      .filter((key) => PROGRESS_KEY.test(key) && !MARKERS.some((pattern) => pattern.test(key)))
      .sort(byName)
    return names.length ? names.slice(0, MAX_SOURCE_NAMES).join('+') : null
  }

  /** 读一个阻塞项：只投影白名单键；展示型字段缺失记 `(unknown)`（清洗，不降级、不猜、不补 0）。 */
  const readBlock = (raw, refBudget) => {
    const out = {}
    for (const key of BLOCK_KEYS) {
      if (key === 'refs') continue
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
      const value = typeof raw[key] === 'string' ? clip(raw[key], BLOCK_MAX_BYTES) : raw[key]
      const text = scrub(value)
      if (text !== null) out[key] = text
    }
    out.block_id = out.block_id ?? '(unknown)'
    const refs = Array.isArray(raw.refs)
      ? raw.refs.map((item) => (typeof item === 'string' ? scrub(clip(item, BLOCK_MAX_BYTES)) : null))
        .filter((item) => item !== null)
      : []
    out.refs = refs.slice(0, refBudget)
    return { block: out, omitted: refs.length - out.refs.length }
  }

  /**
   * 快照 → 面板数据。**全部数字来自快照**；本函数不做任何「应该怎样」的判断。
   * 形状不对一律降级（宁可不判）：把「读不到」显示成「没有阻塞」是本模块最危险的失败模式。
   */
  const project = (payload) => {
    if (!isPlain(payload)) return degradedShape('snapshot-not-an-object')
    if (!Array.isArray(payload.blocks)) return degradedShape('snapshot-blocks-invalid')
    const counts = readCounts(payload.counts)
    if (counts === null) return degradedShape('snapshot-counts-invalid')
    // 计数口径：`counts_source` 或 `counts.source`。**只在计数自己那一份里读** ——
    // 不借进度的口径（D-056：同域两个口径不得相互冒充），读不到就降级。
    const countsSource = scrub(payload.counts_source)
      ?? scrub(isPlain(payload.counts) ? payload.counts.source : null)
    if (countsSource === null) return degradedShape('snapshot-counts-source-missing')
    const progressRead = readProgress(payload.progress)
    if (progressRead === null) return degradedShape('snapshot-progress-invalid')
    if (!progressRead.caliber) return degradedShape('snapshot-progress-source-missing')
    const progress = { ...progressRead.values, source: progressRead.caliber }
    for (const item of payload.blocks) {
      if (!isPlain(item)) return degradedShape('snapshot-blocks-invalid')
    }
    const shown = payload.blocks.slice(0, maxBlocks)
    let omittedRefs = 0
    const blocks = shown.map((item) => {
      const { block, omitted } = readBlock(item, maxRefs)
      omittedRefs += omitted
      return block
    })
    const omittedBlocks = payload.blocks.length - blocks.length
    return {
      blocks,
      counts: { ...counts, source: countsSource },
      progress,
      omitted_blocks: omittedBlocks,
      omitted_refs: omittedRefs,
      bounded: omittedBlocks > 0 || omittedRefs > 0,
      degraded: false,
      reason: '',
      next_action: '',
      source: 'admin-view',
      privacy: { entry_bodies_included: false, private_keys_included: false },
    }
  }

  /** 读快照文件（**本模块唯一的 I/O**）并投影；读不到/坏 JSON/未配置 → 降级（不抛异常）。 */
  const snapshot = () => {
    if (!snapshotPath) return degradedShape('snapshot-not-configured')
    let text = null
    try {
      text = readFileSync(snapshotPath, 'utf8')
    } catch (err) {
      return degradedShape('snapshot-missing')
    }
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch (err) {
      return degradedShape('snapshot-unreadable')
    }
    return project(payload)
  }

  /** 一行人类可读摘要（降级时**不含数字**，避免被当成一份「零的」统计读）；受 `max_bytes` 夹取。 */
  const headline = () => {
    const snap = snapshot()
    if (snap.degraded) return clip(`阻塞清单不可用（${snap.reason}）`, maxBytes)
    const shape = STATES.map((state) => `${state} ${snap.counts[state]}`).join(' / ')
    const omitted = snap.omitted_blocks > 0 ? ` · 省略 ${snap.omitted_blocks} 项` : ''
    return clip(`阻塞 ${shape}（口径 ${snap.counts.source}）${omitted}`, maxBytes)
  }

  ctx.provide('adminView', { project, snapshot, headline })
}

/** fixture：纯读取（连跑两次比对字节；形状与写入器契约一致，只留视图会读的键）。 */
const SAMPLE_SNAPSHOT = {
  generated_at: '2026-09-21T12:00:00Z',
  counts: { blocked: 2, pending: 1, resolved: 3, rejected: 0, expired: 0 },
  counts_source: 'registry+facts',
  blocks: [
    { block_id: 'blk-advisor-1', kind: 'plugin-request', state: 'blocked',
      reason: 'Jev 建议层插件未落地', required_action: '人工决定排期', refs: ['progress-checklist'] },
    { block_id: 'blk-mail-1', kind: 'credential', state: 'blocked',
      reason: '缺 SMTP/IMAP 凭据', required_action: '在面板内提交凭据', refs: ['FR-INTEG-003'] },
  ],
  progress: { done: 41, todo: 7, blocked: 2, source: 'registry' },
}

export const fixture = {
  snapshot: SAMPLE_SNAPSHOT,
  sample: (handle) => ({
    projected: handle.project(SAMPLE_SNAPSHOT),
    again: handle.project(SAMPLE_SNAPSHOT),
    unconfigured: handle.snapshot(),
    headline: handle.headline(),
  }),
}
