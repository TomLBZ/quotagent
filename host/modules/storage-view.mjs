/**
 * storage-view —— 存储的**只读聚合视图**（`provides: ['storageView']`）。
 *
 * 契约：`docs/design/25-storage-plugins.md`（§3 租户隔离、§6 只读面与投影、§7 上界与降级）；
 * 围栏门：`host/t277-storage-gate.mjs`；规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md` §1/§6。
 *
 * 分工（谁写、谁读）：
 *   · **写者唯一**：存储的落盘只有 `tools/storage.py` 做（文件面 + 键值表）。
 *     本模块是**宿主侧的只读面**：它连存储目录都不看，只读**Python 侧写出的快照**
 *     （`tools/storage.py snapshot --out <path>`，默认 `tmp/storage/snapshot.json`）。
 *     为什么绕一层快照：宿主零写面、不取墙钟 —— 让宿主自己去遍历存储树算计数，等于把
 *     "唯一写者" 与 "上界口径" 变成两份实现，早晚漂移（本仓为同类问题付过成本）。
 *   · **只读即纪律**：不写文件、不起子进程（**不调 Python**）、不联网、不随机、**不取墙钟**
 *     （源码里连日期构造与时间戳获取的写法都不出现）、不注册定时器、不订阅事件、不写账本
 *     （门第 7 条静态扫描 + 非空转对照）。
 *   · **按键白名单投影**：每个租户只出六格 `ns/files/file_bytes/tables/keys/last_write`，
 *     顶层的键集合也是固定表 —— 快照里多出来的东西（文件路径原文、`file_samples` 正文、
 *     凭据形状的键值）一个都不进输出。`ns` 必须匹配租户名形状、数字必须是有限非负整数、
 *     `last_write` 必须匹配 `YYYY-MM-DDTHH:MM:SSZ` —— 形状不对的整条丢并**计数**（`invalid_tenants`），
 *     归一化的字段计入 `clipped`（不许悄悄改值也不许悄悄丢）。
 *   · **有界且计数诚实**：租户条数封顶 `max_tenants`（超出在 `omitted_tenants` 报数），
 *     字符串按 UTF-8 字节夹到 `max_bytes`（超出在 `clipped` 报数）→ `truncated:true`；
 *     `counts` 是**夹取前**的真值（`counts.tenants === tenants.length + omitted_tenants`）。
 *   · **降级优先**："没配快照 / 读不出来 / 不是 JSON / 快照自己 degraded" → `degraded:true` + 有名
 *     `reason` + `next_action`，形状与正常输出**同一形状**，绝不抛；**零租户 ≠ 读不到**：
 *     前者的 `degraded=false` 但 `reason='storage-empty'`（两种都不许报成"健康"的绿色）。
 *   · **租户范围**：`snapshot({ns})` 只出那一个租户（其它租户的名字一个字都不出现），
 *     而 `counts.tenants` 仍是**全体真值** + `omitted_tenants` 报出被挡掉多少（数字不许悄悄变小）。
 *   · **确定性**：不读墙钟、不随机；租户按名字稳定排序（与快照里的顺序无关）；
 *     同输入两次 `snapshot()` **字节一致**；`fixture.sample` 走注入模式（零 I/O）以便 A5 复现。
 */
import { readFileSync, statSync } from 'node:fs'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'storage-view'
export const inject = []            // 只读聚合：快照路径由 Config 给（或调用方在内存里注入）
export const builtin = []
export const usedServices = []
export const provides = ['storageView']

export const Config = object({
  snapshot: string().default(''),      // Python 侧快照（`tools/storage.py snapshot --out ...`）；空 = 未配
  max_tenants: number().default(64),   // 租户条数上限（有界）
  max_bytes: number().default(128),    // 每个字符串字段的 UTF-8 字节上限（有界）
})

/** 输出里的 `source` 字段（门据此确认"这份输出是谁给的"）。 */
const SOURCE_NAME = 'storage-view'
/** 租户条目白名单（按键投影：多余的键一个都不出）。 */
export const TENANT_KEYS = ['ns', 'files', 'file_bytes', 'tables', 'keys', 'last_write']
/** `counts` 键（顺序即输出顺序）。 */
export const COUNT_KEYS = ['tenants', 'files', 'file_bytes', 'tables', 'keys', 'invalid_tenants']
/** 上界表白名单（从快照的 `limits` 里只取这些数值键）。 */
export const LIMIT_KEYS = ['max_line_bytes', 'max_file_bytes', 'max_tail_lines', 'max_value_bytes',
  'max_keys_per_table', 'max_events_per_table', 'max_tables', 'max_tenant_bytes']
/** 顶层键（降级与正常输出**同形状**；门断言两者形状一致）。 */
export const OUTPUT_KEYS = ['tenants', 'counts', 'limits', 'scope', 'truncated', 'omitted_tenants',
  'clipped', 'degraded', 'reason', 'next_action', 'source']
/** 降级原因码（闭合集合；门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['storage-snapshot-unconfigured', 'storage-snapshot-unreadable',
  'storage-snapshot-over-cap', 'storage-snapshot-malformed', 'storage-snapshot-degraded',
  'storage-scope-invalid', 'storage-view-disposed', 'storage-view-read-failed']
/** 空结果的诊断码：**不是**降级（快照读得通、确实一件都没有）。 */
export const EMPTY_REASON = 'storage-empty'
/** 范围过滤到空：**不是**降级（快照里有租户，只是不在本次范围里）。 */
export const SCOPE_EMPTY_REASON = 'storage-scope-empty'
/** 租户名形状（与 Python 侧 `NS_RE` 同口径：小写字母开头，允许数字与连字符）。 */
export const NS_RE = /^[a-z][a-z0-9-]{0,31}$/
/** `last_write` 形状（Python 侧给的是 `YYYY-MM-DDTHH:MM:SSZ`；不合形状即归一为空串并计数）。 */
export const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
/** 一次最多读多少字节的快照（有界；超界显式降级，不静默截断成"看起来健康的半份"）。 */
export const MAX_SNAPSHOT_BYTES = 4194304

/** 每个原因码对应的下一步（固定映射 → 输出确定；门断言映射覆盖闭合集合）。 */
const NEXT_ACTIONS = {
  'storage-snapshot-unconfigured': '给 storage-view 配置 snapshot（指向 tools/storage.py snapshot 写出的那份快照）',
  'storage-snapshot-unreadable': '核对 snapshot 路径与其权限：读不出来时不得当作"零租户"',
  'storage-snapshot-over-cap': '快照超过 4 MiB：先缩存储内容或分片（本视图不静默截断成半份）',
  'storage-snapshot-malformed': '快照不是合法 JSON（或不是对象）：重新跑 tools/storage.py snapshot',
  'storage-snapshot-degraded': '快照自己报了 degraded：先按快照的 next_action 修好存储，再看本视图',
  'storage-scope-invalid': 'scope.ns 必须是租户名形状（[a-z][a-z0-9-]{0,31}）；不合法一律拒，不猜',
  'storage-view-disposed': 'storage-view 已被卸载：重新装配插件后再读（已读到的快照不受影响）',
  'storage-view-read-failed': '重试并核对快照来源；本视图不猜也不掩盖（这是最后的兜底路径）',
}
const EMPTY_NEXT_ACTION = '快照合法但确实零租户：要么存储还没写过东西，要么 snapshot 指到了空根 ——'
  + '两种情形请用 Python 侧再确认一次（本视图不会把"没读到"报成"没有"）'
const SCOPE_EMPTY_NEXT_ACTION = '本范围（scope.ns）在快照里没有条目：核对租户名，或先让该租户写过东西'

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

/** 配置夹取：非有限数回落到默认值，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符）。 */
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

const finiteCount = (value) => (Number.isInteger(value) && value >= 0 ? value : null)

const statOf = (path) => {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export function apply(ctx, config) {
  const snapshotPath = typeof config?.snapshot === 'string' ? config.snapshot.trim() : ''
  const maxTenants = clampInt(config?.max_tenants, 64, 0, 1000)
  const maxBytes = clampInt(config?.max_bytes, 128, 0, 4096)
  let disposed = false
  ctx.effect(() => () => { disposed = true })

  /** 降级输出：与正常输出**同一形状**（键集合一致 —— "读不到"不得看起来像"健康的零"）。 */
  const degraded = (reason) => ({
    tenants: [],
    counts: { tenants: 0, files: 0, file_bytes: 0, tables: 0, keys: 0, invalid_tenants: 0 },
    limits: {},
    scope: '',
    truncated: false,
    omitted_tenants: 0,
    clipped: 0,
    degraded: true,
    reason,
    next_action: NEXT_ACTIONS[reason] ?? '',
    source: SOURCE_NAME,
  })

  /**
   * 投影一个租户条目 → 白名单六格；形状不对即丢（`counters.invalid += 1`）。
   * 数字：有限非负整数才收，否则归 0 并计入 `clipped`（不静默改成别的值，也不静默丢整条）。
   */
  const projectTenant = (entry, counters) => {
    if (!isPlain(entry)) {
      counters.invalid += 1
      return null
    }
    if (typeof entry.ns !== 'string' || !NS_RE.test(entry.ns)) {
      counters.invalid += 1                     // `ns`（租户身份）不成形状 → 整条丢
      return null
    }
    const numeric = {}
    for (const key of ['files', 'file_bytes', 'tables', 'keys']) {
      const value = finiteCount(entry[key])
      if (value === null) counters.clipped += 1
      numeric[key] = value === null ? 0 : value
    }
    let lastWrite = typeof entry.last_write === 'string' && STAMP_RE.test(entry.last_write)
      ? entry.last_write : ''
    if (lastWrite !== entry.last_write) counters.clipped += 1
    const ns = clip(entry.ns, maxBytes)
    if (ns !== entry.ns) counters.clipped += 1
    lastWrite = clip(lastWrite, maxBytes)
    return { ns, ...numeric, last_write: lastWrite }
  }

  /** 上界表投影：只取白名单里的数值键（快照里别的东西一个都不出）。 */
  const projectLimits = (source, counters) => {
    const out = {}
    if (!isPlain(source)) return out
    for (const key of LIMIT_KEYS) {
      const value = finiteCount(source[key])
      if (value === null) continue
      out[key] = value
    }
    return out
  }

  /**
   * 把一份（已解析的）快照投影成视图。走到这里说明快照形状可用；
   * `scopeNs` 非空时只出该租户，但 `counts` 仍是**全体真值**（数字不许悄悄变小）。
   */
  const buildView = ({ raw, scopeNs }) => {
    const counters = { clipped: 0, invalid: 0 }
    const source = isPlain(raw) ? raw : {}
    const entries = Array.isArray(source.tenants) ? source.tenants : []
    const projected = []
    for (const entry of entries) {
      const item = projectTenant(entry, counters)
      if (item !== null) projected.push(item)
    }
    projected.sort((left, right) => byName(left.ns, right.ns))
    const counts = {
      tenants: projected.length,
      files: projected.reduce((sum, item) => sum + item.files, 0),
      file_bytes: projected.reduce((sum, item) => sum + item.file_bytes, 0),
      tables: projected.reduce((sum, item) => sum + item.tables, 0),
      keys: projected.reduce((sum, item) => sum + item.keys, 0),
      invalid_tenants: counters.invalid,
    }
    const scoped = scopeNs === '' ? projected : projected.filter((item) => item.ns === scopeNs)
    const shown = scoped.slice(0, maxTenants)
    const omitted = projected.length - shown.length
    const snapshotDegraded = source.degraded === true
    const empty = projected.length === 0 && !snapshotDegraded
    const scopeEmpty = !empty && scopeNs !== '' && scoped.length === 0
    const reason = empty ? EMPTY_REASON : (scopeEmpty ? SCOPE_EMPTY_REASON : '')
    return {
      tenants: shown,
      counts,
      limits: projectLimits(source.limits, counters),
      scope: clip(scopeNs, maxBytes),
      truncated: omitted > 0 || counters.clipped > 0,
      omitted_tenants: omitted,
      clipped: counters.clipped,
      degraded: snapshotDegraded,
      reason: snapshotDegraded ? 'storage-snapshot-degraded' : reason,
      next_action: snapshotDegraded ? NEXT_ACTIONS['storage-snapshot-degraded']
        : (empty ? EMPTY_NEXT_ACTION : (scopeEmpty ? SCOPE_EMPTY_NEXT_ACTION : '')),
      source: SOURCE_NAME,
    }
  }

  /** 注入模式（**零 I/O**）：调用方在内存里给快照（fixture 与门的手算正控都吃它）。 */
  const fromInput = (sources) => {
    if (!Array.isArray(sources.tenants)) return degraded('storage-snapshot-malformed')
    return buildView({
      raw: sources,
      scopeNs: typeof sources.ns === 'string' ? sources.ns.trim() : '',
    })
  }

  /** 生产模式：只读 `Config.snapshot` 那一份文件（不看存储目录、不起子进程）。 */
  const fromDisk = () => {
    if (snapshotPath === '') return degraded('storage-snapshot-unconfigured')
    const stat = statOf(snapshotPath)
    if (stat === null || !stat.isFile()) return degraded('storage-snapshot-unreadable')
    if (stat.size > MAX_SNAPSHOT_BYTES) return degraded('storage-snapshot-over-cap')
    let text = null
    try {
      text = readFileSync(snapshotPath, 'utf8')
    } catch {
      return degraded('storage-snapshot-unreadable')
    }
    if (typeof text !== 'string' || text.includes('\u0000')) return degraded('storage-snapshot-malformed')
    let raw = null
    try {
      raw = JSON.parse(text)
    } catch {
      return degraded('storage-snapshot-malformed')
    }
    if (!isPlain(raw)) return degraded('storage-snapshot-malformed')
    return buildView({ raw, scopeNs: '' })
  }

  /**
   * 只读快照：不给参数读磁盘那份（生产模式）；给了请求对象走注入模式（fixture/门手算），
   * 请求对象里的 `ns` 是**范围**（只出本租户）。绝不抛；卸载后一律拒（`storage-view-disposed`）。
   */
  const snapshot = (request) => {
    if (disposed) return degraded('storage-view-disposed')
    try {
      if (request === undefined || request === null) return fromDisk()
      if (!isPlain(request)) return degraded('storage-snapshot-malformed')
      if (request.ns !== undefined && (typeof request.ns !== 'string' || !NS_RE.test(request.ns.trim()))) {
        return degraded('storage-scope-invalid')
      }
      if (request.tenants === undefined && request.ns === undefined) {
        // 既没给内存快照、也没给范围 → 这个请求对象没有意义（不得当成"读了磁盘然后空"）
        return degraded('storage-snapshot-malformed')
      }
      if (request.tenants === undefined) {
        // 只有范围、没有内存快照：范围必须能在磁盘快照里找到（读不到就如实降级）
        const view = fromDisk()
        if (view.degraded) return view
        return buildView({
          raw: { tenants: view.tenants, limits: view.limits, degraded: false },
          scopeNs: typeof request.ns === 'string' ? request.ns.trim() : '',
        })
      }
      return fromInput(request)
    } catch {
      return degraded('storage-view-read-failed')          // 最后兜底：宁可报"读失败"也不抛
    }
  }

  /** 一行人类可读摘要（受 `max_bytes` 字节夹取；降级时不带任何数字）。 */
  const headline = (request) => {
    const view = snapshot(request)
    if (view.degraded) return clip(`存储视图不可用（${view.reason}）`, maxBytes)
    if (view.tenants.length === 0) {
      return clip(`存储视图：本范围零租户（${view.reason}）；全体 ${view.counts.tenants} 个租户`, maxBytes)
    }
    const first = view.tenants[0]
    return clip(`存储视图：租户 ${view.tenants.length}/${view.counts.tenants}`
      + `（文件 ${view.counts.files} / 字节 ${view.counts.file_bytes} / 表 ${view.counts.tables}`
      + ` / 键 ${view.counts.keys}）；首个 ${first.ns} 最近写入 ${first.last_write || '（未报）'}`
      + `${view.truncated ? `；已截断（丢 ${view.omitted_tenants} 条/夹 ${view.clipped} 处）` : ''}`, maxBytes)
  }

  ctx.provide('storageView', { snapshot, headline, config: () => ({
    snapshot: snapshotPath, max_tenants: maxTenants, max_bytes: maxBytes,
  }) })
}

/** fixture 的内存源（形状与 Python 侧快照一致；**零 I/O** → A5 确定性可复现）。 */
const SAMPLE_SOURCES = {
  generated_at: '',
  limits: { max_line_bytes: 4096, max_file_bytes: 1048576, max_tail_lines: 200, max_tables: 32 },
  tenants: [
    { ns: 'beta', files: 1, file_bytes: 20, tables: 0, keys: 0, last_write: '2026-09-21T00:00:00Z' },
    { ns: 'alpha', files: 3, file_bytes: 512, tables: 1, keys: 4, last_write: '2026-09-21T00:00:01Z' },
    { ns: 'Gamma', files: 9, file_bytes: 9, tables: 9, keys: 9, last_write: 'nope' },
  ],
}

export const fixture = {
  sources: SAMPLE_SOURCES,
  sample: (handle) => ({
    snap: handle.snapshot(SAMPLE_SOURCES),
    again: handle.snapshot(SAMPLE_SOURCES),
    text: handle.headline(SAMPLE_SOURCES),
  }),
}
