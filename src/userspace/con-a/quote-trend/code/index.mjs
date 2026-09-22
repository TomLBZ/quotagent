/**
 * 用户空间插件 con-a/quote-trend（T-269 产物）
 *
 * 需求（用户原话，逐字见 plugin.json 的 `created_from`）：
 *   承包商想按项目维度记录每次报价金额，并能看出趋势——哪个项目在涨、哪个在跌、涨跌多少。
 *
 * 自包含（这就是"用户自己决定业务功能、不耦合进平台"这一条的落地形状）：
 *   · `inject = []`：不消费任何平台服务，也不改内核/服务层（FR-USERPLUG-009）；
 *   · 服务只注册在**自己命名空间**里：`provide('quoteTrend')` / `provide('observationLog')`
 *     → 宿主把它变成 `con-a.quote-trend.quoteTrend` / `con-a.quote-trend.observationLog`，
 *     平台保留名（approval / 账本家族 / kernel.* / webui …）一个都不碰（FR-USERPLUG-006 ②）；
 *   · 数据只落在**自己的文件根**里：`<plugin dir>/data/observations.jsonl`，**append-only**
 *     ——不写 host/modules/、src/、tools/、别人的 ns，也不写仓库外（FR-USERPLUG-002）；
 *   · 纯标准库 ESM，零第三方依赖；不起子进程、不联网、不取随机、不起定时器、不留任何事实层写入。
 *
 * 确定性（同输入两次 `trend()` 逐字节一致）：
 *   · 本文件**不引用任何日期对象、不读墙钟、不看时区**：ISO 时刻只用整数算术（days-from-civil）
 *     折算成"自纪元起的毫秒"，排序因此与运行环境、时区、调用时间无关；
 *   · 排序键 =（时刻毫秒，文件行序）→ 同一条观测的次序由文件内容唯一决定；
 *   · 返回对象按规格给的键序构造（键序固定 ⇒ `JSON.stringify` 逐字节可复现）。
 *
 * 观测日志的读面（只读，供自进化 `observe` / 门核验用，口径对齐 FR-STORAGE-006）：
 *   `observationLog.path()`   → 本插件数据文件的**绝对路径**（写面自证）
 *   `observationLog.stats()`  → `{lines, projects}`：非空行数与出现过的项目数（不读正文之外的任何东西）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'quote-trend'
export const inject = []
export const provides = ['quoteTrend', 'observationLog']
export const Config = undefined

/** 数据文件（相对本插件文件根）；一行一条观测 `{project_id, amount_minor, at}`。 */
export const DATA_REL = 'data/observations.jsonl'

/** 入参拒绝码（本插件的唯一拒绝码：形状不对就不写文件）。 */
const INVALID = 'invalid-observation'
const NEXT_ACTIONS = {
  'project-id-empty': 'project_id 必须是非空字符串（按项目维度记账，空值无从归属）',
  'amount-minor-not-integer': 'amount_minor 必须是整数（最小货币单位，例如"分"；小数/字符串/NaN 都不收）',
  'at-not-iso8601': 'at 必须是 ISO-8601 时刻：YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]（且月/日/时/分/秒必须在合法区间内）',
  'write-surface-refused': '目标只允许是本插件自己的文件根：data/observations.jsonl',
}
const nextActionOf = (reason) => NEXT_ACTIONS[reason] ?? '按 record(project_id, amount_minor, at_iso) 的入参形状重试'
/** 拒绝载荷：与成功载荷同形（`ok` 先出现，调用方不必分支解析）。 */
const refusalOf = (reason) => ({ ok: false, code: INVALID, reason, next_action: nextActionOf(reason) })

/** ISO-8601 时刻的**形状**（只认带 'T' 分隔的完整时刻；秒小数最多 9 位；时区可省）。 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})?$/
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/**
 * 民用历 → 自 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil，纯整数算术）。
 * 为什么自己算而不用日期对象：日期对象会引入"本地时区/运行时环境"这两个不确定输入。
 */
const daysFromCivil = (year, month, day) => {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const shifted = month + (month > 2 ? -3 : 9)
  const dayOfYear = Math.floor((153 * shifted + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

/**
 * ISO-8601 时刻 → 自纪元起的毫秒（整数）；**形状或区间不合法 → null**（不抛）。
 * 合法性：月 01-12、日按月长（含闰年 2 月）、时 00-23、分/秒 00-59、时区偏移 ≤ ±14:00。
 */
export const epochMillisOf = (text) => {
  const match = typeof text === 'string' ? ISO_RE.exec(text) : null
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7] ?? ''
  const zone = match[8] ?? ''
  if (month < 1 || month > 12) return null
  const monthLength = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  if (day < 1 || day > monthLength) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  let offsetMinutes = 0
  if (zone !== '' && zone !== 'Z' && zone !== 'z') {
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 14 || offsetMinute > 59) return null
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === '-' ? -1 : 1)
  }
  const millis = Number(`${fraction}000`.slice(0, 3))
  return daysFromCivil(year, month, day) * 86400000 + hour * 3600000 + minute * 60000
    + second * 1000 + millis - offsetMinutes * 60000
}

/** 插件文件根：优先用宿主在装载期给的 `config.root`（绝对路径）；没有就退回产物自己的目录。 */
const pluginDirOf = (config) => {
  const given = typeof config?.root === 'string' && config.root.trim() !== '' ? config.root.trim() : ''
  return given === '' ? dirname(fileURLToPath(import.meta.url)) : resolve(given)
}

/** 宿主文件服务（装载期绑在插件自己目录上的那一个）：有就用它做写面判定，没有也不影响自包含。 */
const filesServiceOf = (ctx, ns, plugin, config) => {
  const key = typeof config?.services?.files === 'string' && config.services.files !== ''
    ? config.services.files
    : `${ns}.${plugin}.files`
  try {
    const service = ctx === null || ctx === undefined ? undefined : ctx[key]
    return service && typeof service === 'object' ? service : null
  } catch {
    return null
  }
}

/** 读日志：`{lines, rows}` —— `lines` 是非空行数，`rows` 是通过形状检查的观测（坏行不拖倒整次读）。 */
const readLog = (dataPath) => {
  if (!existsSync(dataPath)) return { lines: 0, rows: [] }
  let text = ''
  try {
    text = readFileSync(dataPath, 'utf8')
  } catch {
    return { lines: 0, rows: [] }
  }
  const rows = []
  let lines = 0
  for (const chunk of String(text).split('\n')) {
    const line = chunk.trim()
    if (line === '') continue
    lines += 1
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = null
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof parsed.project_id === 'string' && Number.isInteger(parsed.amount_minor)
      && typeof parsed.at === 'string' && epochMillisOf(parsed.at) !== null) {
      rows.push({ project_id: parsed.project_id, amount_minor: parsed.amount_minor, at: parsed.at })
    }
  }
  return { lines, rows }
}

/**
 * 装载：只注册自己命名空间里的两个服务。
 * `config` = `{root, ns, plugin, prefix, services}`（宿主注入；直接挂载时可缺，全部有默认值）。
 */
export const apply = (ctx, config = {}) => {
  const ns = typeof config?.ns === 'string' && config.ns !== '' ? config.ns : 'con-a'
  const plugin = typeof config?.plugin === 'string' && config.plugin !== '' ? config.plugin : 'quote-trend'
  const pluginDir = pluginDirOf(config)
  const files = filesServiceOf(ctx, ns, plugin, config)

  // 写面自证：宿主给了文件服务就用它判定一次（界外一律拒，绝不"就近落盘"）；
  // 没有文件服务时（例如被直接挂载）目标仍由 `pluginDir` 唯一确定 —— 即本插件自己的目录。
  let surface = { ok: true, code: '', reason: '', path: join(pluginDir, 'data', 'observations.jsonl') }
  if (files !== null && typeof files.assertWrite === 'function') {
    const verdict = files.assertWrite(DATA_REL)
    surface = verdict && verdict.ok === true && typeof verdict.path === 'string'
      ? { ok: true, code: '', reason: '', path: verdict.path }
      : { ok: false, code: verdict?.code || 'user-space-outside-ns', reason: 'write-surface-refused',
          path: join(pluginDir, 'data', 'observations.jsonl') }
  }
  const dataPath = surface.path

  /** 记录一次报价观测（append-only；形状不合法 → 拒且**不写文件**）。 */
  const record = (project_id, amount_minor, at_iso) => {
    if (typeof project_id !== 'string' || project_id.trim() === '') return refusalOf('project-id-empty')
    if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor)) {
      return refusalOf('amount-minor-not-integer')
    }
    if (epochMillisOf(at_iso) === null) return refusalOf('at-not-iso8601')
    if (surface.ok !== true) {
      return { ok: false, code: surface.code, reason: surface.reason, next_action: nextActionOf(surface.reason) }
    }
    const line = JSON.stringify({ project_id, amount_minor, at: at_iso })
    mkdirSync(dirname(dataPath), { recursive: true })
    appendFileSync(dataPath, `${line}\n`, 'utf8')
    return { ok: true, count: readLog(dataPath).lines }
  }

  /**
   * 某项目的趋势：读自己的日志 → 该项目的观测按 `at` 升序 → 首末两点算差值/方向/基点。
   * 0 条 → `points:0, direction:'flat', note:'no-observation'`；1 条 → `delta_minor:0, direction:'flat'`。
   */
  const trend = (project_id) => {
    const wanted = typeof project_id === 'string' ? project_id : ''
    const { rows } = readLog(dataPath)
    const points = rows
      .map((row, index) => ({ row, index, epoch: epochMillisOf(row.at) }))
      .filter((item) => item.row.project_id === wanted)
      .sort((left, right) => (left.epoch - right.epoch) || (left.index - right.index))
    if (points.length === 0) {
      return { project_id: wanted, points: 0, first: null, last: null, delta_minor: null,
        direction: 'flat', pct_bp: null, note: 'no-observation' }
    }
    const first = points[0].row.amount_minor
    const last = points[points.length - 1].row.amount_minor
    const delta = last - first
    return {
      project_id: wanted,
      points: points.length,
      first,
      last,
      delta_minor: delta,
      direction: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'),
      pct_bp: first === 0 ? 0 : Math.round((delta * 10000) / first),   // 基点（bp）：first=0 不可比 → 记 0
    }
  }

  ctx.provide('quoteTrend', { record, trend })
  ctx.provide('observationLog', {
    /** 本插件数据文件的绝对路径（宿主/门据此核验写面）。 */
    path: () => dataPath,
    /** 只读观察面：非空行数 + 出现过的项目数（有界、确定性、不出正文）。 */
    stats: () => {
      const { lines, rows } = readLog(dataPath)
      return { lines, projects: new Set(rows.map((row) => row.project_id)).size }
    },
  })
}
