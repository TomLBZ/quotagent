/**
 * 配置与凭据的**只读投影 + 干跑 + 待处理项落盘**（库层，纯函数 + 有界 I/O）。
 *
 * 三条纪律（每条都有门看着，见 `tools/check-config-route.py`）：
 *   ① **凭据只写不回显**：本文件里没有任何"把凭据值读出来渲染"的路径 —— `credentialsView()` 只输出
 *      `configured / source / required_mode / fingerprint_first8 / next_action`，指纹来自 **Python 侧写的状态快照**
 *      （`--status`），宿主自己从不读凭据值（连 token 文件都不读）；
 *   ② **零落盘**：`preview()`（干跑）与一切只读视图**不写任何文件**；本文件唯一的写函数是 `writePendingItem()`
 *      —— 目录 0700、文件 0600、`.tmp.<pid>` + rename 原子落位（照抄 `host/modules/webui.mjs` 既有形状），
 *      且只落**待处理项**（真落盘由 Python 侧 `tools/config-apply.py` 做）；
 *   ③ **不取墙钟、不随机**：待处理项里没有时间戳（`submitted_at: null`），时间由 Python 侧按 `--now` 落账；
 *      幂等键 = `sha256(规范化 payload)`（同内容重复提交 = 同一文件名 = 不新增文件）。
 *
 * YAML：仓库零第三方依赖 → 只实现**声明清楚的子集**（见 `parseYaml` 的文档与拒绝清单）；不支持的结构一律
 * **拒并给 reason**，绝不静默糊掉。子集的两侧实现（本文件 / `tools/config-apply.py`）必须一致，门用同一份夹具
 * 逐字节比对。
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAYERS, PROJECT_KEYS, CREDENTIALS, envNameFor, matchSchemaPattern } from './config-keys.mjs'
import { SCHEMA } from './schema.mjs'

/**
 * **P32：外部行数组的唯一读数入口**（口径见 `src/system/webui/docs/row-action-prefill.md` §4）。
 * 只认**非 null 的对象**行：数组里混进 `null`/字符串/数字/嵌套数组时，裸读 `row.key` 抛
 * `TypeError` ⇒ 这一页/这块面板整块崩掉。
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

export { LAYERS, PROJECT_KEYS, CREDENTIALS, envNameFor, matchSchemaPattern }

// ---------------------------------------------------------------------------
// 规范化 / 摘要（与 Python 侧 `canonical_fields` 同形：键排序、无空格、非 ASCII 不转义）
// ---------------------------------------------------------------------------
export const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
export const digestOf = (value) => `sha256:${sha256(canonical(value))}`

// ---------------------------------------------------------------------------
// YAML 子集：解析（拒：锚点/别名、多文档、块标量、制表符缩进、重复键、非字符串键）
// ---------------------------------------------------------------------------
const KEY_RE = /^([^:#]+?)\s*:/
const UNSUPPORTED = [
  [/^\s*---\s*$|^\s*\.\.\.\s*$/m, 'multi-document-mark'],
  [/^\s*\t|\t/m, 'tab-indent'],
  [/:\s*[|>][+-]?\s*(#.*)?$/m, 'block-scalar'],
  [/:\s*[&*][A-Za-z0-9_-]+/m, 'anchor-or-alias'],
  [/^\s*-?\s*<<\s*:/m, 'merge-key'],
]

/** 引号/注释感知的标量切分：去掉行尾注释（` #` 形式，引号内不算），再解析类型。 */
const stripComment = (raw) => {
  const text = String(raw)
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && index > 0 && /\s/.test(text[index - 1])) return text.slice(0, index)
  }
  return text
}

const splitTopLevel = (text, separator) => {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === separator && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts
}

const unquote = (text) => {
  const value = String(text).trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).split("''").join("'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  return value
}

const SCALAR_INT = /^-?\d+$/
const SCALAR_FLOAT = /^-?\d*\.\d+([eE][+-]?\d+)?$/

export const parseScalar = (raw) => {
  const text = stripComment(raw).trim()
  if (text === '') return null
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return splitTopLevel(inner, ',').map((item) => parseScalar(item))
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim()
    const out = {}
    if (inner === '') return out
    for (const item of splitTopLevel(inner, ',')) {
      const at = item.indexOf(':')
      if (at < 0) throw new Error('flow-map-entry-without-colon')
      out[unquote(item.slice(0, at))] = parseScalar(item.slice(at + 1))
    }
    return out
  }
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text)
  if (text === 'true' || text === 'True' || text === 'TRUE') return true
  if (text === 'false' || text === 'False' || text === 'FALSE') return false
  if (text === 'null' || text === '~' || text === 'Null' || text === 'NULL') return null
  if (SCALAR_INT.test(text)) return Number(text)
  if (SCALAR_FLOAT.test(text)) return Number(text)
  return text
}

/** 一行里的 `键: 值` 切分（第一个「后面是空白或行尾」的冒号；引号内的冒号不算）。 */
const splitKey = (text) => {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === ':' && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return { key: unquote(text.slice(0, index)), rest: text.slice(index + 1) }
    }
  }
  return null
}

/** 预处理：去掉空行/纯注释行，算出每行的缩进与正文，并做**不支持结构**的拒绝。 */
const preprocess = (text) => {
  const source = String(text ?? '')
  for (const [pattern, reason] of UNSUPPORTED) if (pattern.test(source)) return { ok: false, reason }
  const rows = []
  source.split('\n').forEach((line, index) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return
    const indent = line.length - line.replace(/^\s*/, '').length
    rows.push({ indent, body: line.trim(), line: index + 1 })
  })
  return { ok: true, rows }
}

/** 子集解析：返回 `{ok:true, value}` 或 `{ok:false, reason}`（reason 是机器可读的原因码）。 */
export const parseYaml = (text) => {
  const pre = preprocess(text)
  if (!pre.ok) return pre
  const rows = pre.rows
  if (rows.length === 0) return { ok: true, value: {} }

  const build = (start, indent) => {
    const isList = rows[start].body.startsWith('- ') || rows[start].body === '-'
    const container = isList ? [] : {}
    const seen = new Set()
    let index = start
    while (index < rows.length) {
      const row = rows[index]
      if (row.indent < indent) break
      if (row.indent > indent) return { error: `unexpected-indent:第 ${row.line} 行` }
      if (isList) {
        const rest = row.body.replace(/^-\s?/, '')
        if (rest === '') {
          const next = rows[index + 1]
          if (!next || next.indent <= indent) { container.push(null); index += 1; continue }
          const nested = build(index + 1, next.indent)
          if (nested.error) return nested
          container.push(nested.value)
          index = nested.next
          continue
        }
        const pair = splitKey(rest)
        if (pair && pair.rest.trim() !== '') {
          // `- 键: 值`：单键映射项（其后续更深缩进的行归它）
          const item = {}
          try { item[pair.key] = parseScalar(pair.rest) } catch (err) { return { error: `bad-scalar:第 ${row.line} 行（${err.message}）` } }
          const next = rows[index + 1]
          if (next && next.indent > indent) {
            const nested = build(index + 1, next.indent)
            if (nested.error) return nested
            if (typeof nested.value !== 'object' || Array.isArray(nested.value)) return { error: `bad-list-map:第 ${row.line} 行` }
            Object.assign(item, nested.value)
            container.push(item)
            index = nested.next
            continue
          }
          container.push(item)
          index += 1
          continue
        }
        if (pair && pair.rest.trim() === '') {
          const item = {}
          const next = rows[index + 1]
          if (next && next.indent > indent) {
            const nested = build(index + 1, next.indent)
            if (nested.error) return nested
            item[pair.key] = nested.value
            container.push(item)
            index = nested.next
            continue
          }
          item[pair.key] = null
          container.push(item)
          index += 1
          continue
        }
        try { container.push(parseScalar(rest)) } catch (err) { return { error: `bad-scalar:第 ${row.line} 行（${err.message}）` } }
        index += 1
        continue
      }
      if (row.body.startsWith('- ')) return { error: `list-item-in-map:第 ${row.line} 行` }
      const pair = splitKey(row.body)
      if (!pair) return { error: `not-a-mapping:第 ${row.line} 行` }
      if (pair.key === '') return { error: `empty-key:第 ${row.line} 行` }
      if (seen.has(pair.key)) return { error: `duplicate-key:${pair.key}` }
      seen.add(pair.key)
      const rest = pair.rest.trim()
      if (rest === '') {
        const next = rows[index + 1]
        if (next && next.indent > indent) {
          const nested = build(index + 1, next.indent)
          if (nested.error) return nested
          container[pair.key] = nested.value
          index = nested.next
          continue
        }
        container[pair.key] = null
        index += 1
        continue
      }
      try { container[pair.key] = parseScalar(pair.rest) } catch (err) { return { error: `bad-scalar:第 ${row.line} 行（${err.message}）` } }
      index += 1
    }
    return { value: container, next: index }
  }

  if (rows[0].body.startsWith('- ')) {
    // 顶层列表：允许（简单列表），但顶层映射是本项目唯一用到的形状
    const built = build(0, rows[0].indent)
    if (built.error) return { ok: false, reason: built.error }
    return { ok: true, value: built.value }
  }
  const built = build(0, rows[0].indent)
  if (built.error) return { ok: false, reason: built.error }
  if (built.next !== rows.length) return { ok: false, reason: `trailing-lines:第 ${rows[built.next].line} 行` }
  return { ok: true, value: built.value }
}

// ---------------------------------------------------------------------------
// YAML 子集：渲染（只渲染**受管段**；其余字节不动 → 用户注释不丢）
// ---------------------------------------------------------------------------
const KEY_SAFE = /^[A-Za-z0-9_.-]+$/
const VALUE_SAFE = /^[A-Za-z0-9_./@:+*-]*$/
const quoteKey = (key) => (KEY_SAFE.test(key) ? key : `"${String(key).replace(/"/g, '\\"')}"`)
const quoteValue = (value) => {
  const text = String(value)
  const risky = text === '' || !VALUE_SAFE.test(text) || /^(true|false|null|~|\d+|-?\d*\.\d+)$/.test(text)
  return risky ? `'${text.replace(/'/g, "''")}'` : text
}
const renderScalar = (value) => {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (Array.isArray(value)) return `[${value.map((item) => renderScalar(item)).join(', ')}]`
  if (typeof value === 'object') return '{}'
  return quoteValue(value)
}
const renderNode = (node, indent) => {
  const pad = ' '.repeat(indent)
  if (Array.isArray(node)) return node.flatMap((item) => [`${pad}- ${renderScalar(item)}`])
  if (node && typeof node === 'object') {
    return Object.keys(node).sort().flatMap((key) => {
      const value = node[key]
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
        return [`${pad}${quoteKey(key)}:`, ...renderNode(value, indent + 2)]
      }
      return [`${pad}${quoteKey(key)}: ${renderScalar(value)}`]
    })
  }
  return [`${pad}${renderScalar(node)}`]
}

/** 顶层段的行范围（`key: ...` 到下一个顶层键之前）；注释与空行归前一段。 */
export const sectionRanges = (text) => {
  const lines = String(text ?? '').split('\n')
  const starts = []
  lines.forEach((line, index) => {
    const match = /^([^\s#][^:]*?)\s*:/.exec(line)
    if (match && !line.startsWith('-')) starts.push({ key: unquote(match[1]), index })
  })
  const ranges = new Map()
  starts.forEach((entry, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length
    ranges.set(entry.key, [entry.index, end])
  })
  return { lines, ranges }
}

/**
 * 把受管段（`project` / `plugins` / `credentials`）整段替换成新内容，**其余行逐字节保留**。
 * 段不存在 → 追加到文件末尾。返回新的全文。
 */
export const spliceSection = (text, key, node) => {
  const { lines, ranges } = sectionRanges(text)
  const body = [`${key}:`, ...renderNode(node ?? {}, 2)]
  const range = ranges.get(key)
  if (!range) {
    const base = String(text ?? '')
    const tail = base === '' || base.endsWith('\n') ? '' : '\n'
    return `${base}${tail}${body.join('\n')}\n`
  }
  const [start, end] = range
  return [...lines.slice(0, start), ...body, ...lines.slice(end)].join('\n')
}

/** 展平嵌套映射 → 点分键路径（顶层段的子键用**字面**点分键，不再展开）。 */
export const flattenDoc = (doc, prefix = '') => {
  const out = {}
  for (const [key, value] of Object.entries(doc || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flattenDoc(value, path))
    else out[path] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// 配置文档读取（只读）：受管段的真值
// ---------------------------------------------------------------------------
/** 受管段（只有这三段由 `tools/config-apply.py` 写；其余段永不触碰）。 */
export const MANAGED_SECTIONS = ['project', 'plugins', 'credentials']

/**
 * 只读受管段：**只解析** `project` / `plugins` / `credentials` 三段的原文，其余段一律不碰。
 *
 * 为什么按段解析（而不是先解析整份文件再取段）：
 *   · 用户的真实配置里可能存在本子集不支持的结构（例如 `notes: |` 这类块标量）——那些段**不在我们的写面上**，
 *     我们的 splice 只整段替换受管段、其余行逐字节保留，所以不该因为"别人的段有块标量"就把整件事拒掉；
 *   · 但**受管段内部**一旦出现不支持的结构 → 一律**拒并给 reason**（不静默糊掉），绝不带着错误的理解去写。
 */
export const readManagedSections = (text) => {
  const { lines, ranges } = sectionRanges(text)
  const out = {}
  for (const key of MANAGED_SECTIONS) {
    const range = ranges.get(key)
    if (!range) continue
    const [start, end] = range
    const block = lines.slice(start, end).join('\n')
    const parsed = parseYaml(block)
    if (!parsed.ok) return { ok: false, reason: `managed-section-unparsable:${key}:${parsed.reason}`, value: out }
    const section = parsed.value?.[key]
    if (section !== undefined && section !== null && (typeof section !== 'object' || Array.isArray(section))) {
      return { ok: false, reason: `managed-section-not-a-mapping:${key}`, value: out }
    }
    out[key] = section ?? {}
  }
  return { ok: true, reason: '', value: out }
}

export const readConfigFile = (path) => {
  if (!path) return { ok: false, reason: 'config-file-unconfigured', value: null, text: '' }
  if (!existsSync(path)) return { ok: false, reason: 'config-file-missing', value: null, text: '' }
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch (err) { return { ok: false, reason: `config-file-unreadable:${String(err.code ?? '')}`, value: null, text: '' } }
  const parsed = readManagedSections(text)
  if (!parsed.ok) return { ok: false, reason: `config-file-unparsable:${parsed.reason}`, value: parsed.value, text }
  return { ok: true, reason: '', value: parsed.value, text }
}

const asMap = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

// ---------------------------------------------------------------------------
// 层 1：项目配置总览（每键 source / shadowed_by / editable）
// ---------------------------------------------------------------------------
export const projectView = ({ doc, env = {}, runtime = {}, maxKeys = 200 }) => {
  const fileLayer = asMap(asMap(doc).project)
  const rows = []
  const keys = Object.keys(PROJECT_KEYS).sort()
  for (const key of keys.slice(0, maxKeys)) {
    const declared = PROJECT_KEYS[key]
    const matched = matchSchemaPattern(key, SCHEMA)
    const envName = envNameFor(key)
    const envRaw = typeof env[envName] === 'string' && env[envName] !== '' ? env[envName] : null
    const hasFile = Object.prototype.hasOwnProperty.call(fileLayer, key)
    const hasRuntime = Object.prototype.hasOwnProperty.call(runtime, key)
    const layers = ['default']
    if (hasFile) layers.push('file')
    if (envRaw !== null) layers.push('env')
    if (hasRuntime) layers.push('runtime')
    const source = hasRuntime ? 'runtime' : (envRaw !== null ? 'env' : (hasFile ? 'file' : 'default'))
    const value = source === 'runtime' ? runtime[key]
      : source === 'env' ? parseScalar(envRaw)
        : source === 'file' ? fileLayer[key] : declared.default
    // `shadowed_by` = 被本行压住的**显式层**（default 不算"被压住"：它只是落回默认值）
    const overridden = ['file', 'env', 'runtime'].filter((layer) => layers.includes(layer) && layer !== source)
    rows.push({
      key, layer: 'project', type: declared.type, value,
      source, shadowed_by: overridden.length ? overridden.join(',') : null,
      sources: layers, human_only: matched?.rule?.humanOnly === true, frozen: matched?.rule?.frozen === true,
      schema_pattern: matched?.pattern ?? null,
      editable: Boolean(matched) && matched.rule.frozen !== true && matched.rule.humanOnly !== true,
      needs_approval: matched?.rule?.humanOnly === true,
      env: envName, env_set: envRaw !== null, in_file: hasFile, digest: digestOf(value),
      note: declared.note ?? matched?.rule?.note ?? '',
    })
  }
  return { rows, truncated: keys.length > maxKeys, total: keys.length }
}

// ---------------------------------------------------------------------------
// 层 2：插件配置总览（真源 = 配置文件 `plugins.<ns>/<plugin>`）
// ---------------------------------------------------------------------------
export const pluginView = ({ doc, env = {}, maxKeys = 200 }) => {
  const section = asMap(asMap(doc).plugins)
  const rows = Object.keys(section).sort().slice(0, maxKeys).map((target) => {
    const fields = asMap(section[target])
    const keys = Object.keys(fields).sort().map((field) => {
      const envName = envNameFor(`plugins.${target}.${field}`)
      const envRaw = typeof env[envName] === 'string' && env[envName] !== '' ? env[envName] : null
      return { key: field, value: envRaw !== null ? parseScalar(envRaw) : fields[field],
        source: envRaw !== null ? 'env' : 'file', shadowed_by: envRaw !== null ? 'file' : null, env: envName }
    })
    const [namespace, plugin] = String(target).split('/')
    return { layer: 'plugin', target, namespace: namespace ?? '', plugin: plugin ?? '', keys,
      source: keys.length ? (keys.some((item) => item.source === 'env') ? 'env' : 'file') : 'default',
      shadowed_by: null, editable: true,
      note: '插件配置的字段名由插件自己导出的 Config 决定（装载期校验；未声明的字段以 plugin-config-refused 拒）' }
  })
  return { rows, total: Object.keys(section).length }
}

// ---------------------------------------------------------------------------
// 层 3：凭据总览（**不出值**：configured/source/required_mode/fingerprint_first8/next_action）
// ---------------------------------------------------------------------------
export const readStatusFile = (path) => {
  if (!path) return { ok: false, reason: 'status-snapshot-unconfigured', value: null }
  if (!existsSync(path)) return { ok: false, reason: 'status-snapshot-missing', value: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'status-snapshot-not-an-object', value: null }
    return { ok: true, reason: '', value: parsed }
  } catch (err) { return { ok: false, reason: `status-snapshot-unreadable:${String(err.name ?? '')}`, value: null } }
}

/** 待处理项**只读投影**：只取 layer/target/payload_sha256/bytes —— 绝不碰 `fields`（那里有值）。 */
export const pendingSummary = (dir) => {
  if (!dir) return { configured: false, count: 0, by_target: {}, reason: 'inbox-unconfigured' }
  if (!existsSync(dir)) return { configured: true, count: 0, by_target: {}, reason: '' }
  let names = []
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort() } catch (err) {
    return { configured: true, count: 0, by_target: {}, reason: `inbox-unreadable:${String(err.code ?? '')}` }
  }
  const byTarget = {}
  let count = 0
  for (const name of names.slice(0, 200)) {
    let record = null
    try { record = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch (err) { continue }
    if (!record || typeof record !== 'object') continue
    const target = typeof record.target === 'string' ? record.target : ''
    const key = `${String(record.layer ?? '')}:${target}`
    byTarget[key] = (byTarget[key] ?? 0) + 1
    count += 1
  }
  return { configured: true, count, by_target: byTarget, reason: '' }
}

const fingerprintOf = (value) => (typeof value === 'string' && /^[0-9a-f]{8}$/.test(value) ? value : null)

/** 未配置时的下一步（**非空字符串**是契约：A1/A20 的形态）。 */
const credentialNextAction = (name, configured, statusReason) => (configured
  ? `已配置（来源见 source）。轮换：提权后在 /quotagent/admin/config/ 提交新值（只写不回显），再由 Python 侧消费 `
    + `（tools/config-apply.py --approval-ref ap-NNNN --actor human:<名>）`
  : `未配置：提权后在 /quotagent/admin/config/ 提交「${name}」，或由运维写 0600 文件/环境变量；`
    + `未配置的功能必须如实报不可用${statusReason ? `（凭据状态快照：${statusReason}）` : ''}`)

export const credentialsView = ({ status, inbox, env = {}, statFile = (path) => statSync(path) }) => {
  const snapshot = readStatusFile(status)
  const statusMap = asMap(snapshot.ok ? (snapshot.value.credentials ?? {}) : {})
  const pending = pendingSummary(inbox)
  const rows = Object.keys(CREDENTIALS).sort().map((name) => {
    const declared = CREDENTIALS[name]
    const fromStatus = asMap(statusMap[name])
    const envSet = declared.env ? (typeof env[declared.env] === 'string' && env[declared.env] !== '') : false
    const fileOk = (() => {
      const path = typeof fromStatus.file === 'string' && fromStatus.file ? fromStatus.file : declared.file
      if (!path) return { ok: false, path: '' }
      try {
        const info = statFile(path)
        const mode = (info.mode & 0o777).toString(8).padStart(3, '0')
        return { ok: mode === '0600' && info.size > 0, path, mode }
      } catch (err) { return { ok: false, path, mode: null } }
    })()
    const configured = fromStatus.configured === true ? true : (envSet || fileOk.ok)
    const source = typeof fromStatus.source === 'string' && fromStatus.source
      ? fromStatus.source : (envSet ? 'env' : (fileOk.ok ? 'file' : 'default'))
    const fingerprint = fingerprintOf(fromStatus.fingerprint_first8)
    return {
      name, configured, source, required_mode: declared.required_mode ?? '0600',
      fingerprint_first8: fingerprint,
      // 指纹只可能来自 Python 侧状态快照（宿主不读凭据值）：拿不到就如实说"不可用 + 为什么"
      fingerprint_source: fingerprint ? 'python-status-snapshot' : 'unavailable',
      fingerprint_reason: fingerprint ? '' : statusReasonOf(snapshot),
      value_present: false,
      next_action: credentialNextAction(name, configured, snapshot.ok ? '' : snapshot.reason),
      env: declared.env ?? '', file: fileOk.path, file_mode: fileOk.mode,
      note: declared.note ?? '',
      pending: pending.by_target[`credential:${name}`] ?? 0,
    }
  })
  return {
    rows, total: rows.length,
    snapshot: { available: snapshot.ok, reason: snapshot.ok ? '' : snapshot.reason,
      next_action: snapshot.ok ? '' : '由 Python 侧落状态快照：tools/config-apply.py --status <路径>（只写 configured/source/指纹前 8 位，不含值）' },
    pending: { configured: pending.configured, count: pending.count, reason: pending.reason },
    note: '凭据只写不回显：任何响应体里都不出现凭据值；指纹前 8 位来自 Python 侧状态快照（宿主不读凭据值）',
  }
}

const statusReasonOf = (snapshot) => (snapshot.ok ? 'not-computed' : snapshot.reason)

// ---------------------------------------------------------------------------
// 干跑（preview）：白名单 + 类型 + 人工门 + diff，**零落盘零生效**
// ---------------------------------------------------------------------------
export const REFUSAL_CODES = ['unknown-layer', 'unknown-target', 'unknown-key', 'frozen', 'humanOnly',
  'type-mismatch', 'unknown-credential', 'bad-field', 'unsupported-yaml', 'no-fields', 'empty-value', 'bad-target']

const HUMAN_APPROVAL_RE = /^ap-\d{4}$/

const coerceType = (key, value, type) => {
  if (type === 'boolean') return typeof value === 'boolean' ? { ok: true, value } : { ok: false }
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : { ok: false }
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value) ? { ok: true, value } : { ok: false }
  if (type === 'string') return typeof value === 'string' && value !== '' ? { ok: true, value } : { ok: false }
  return { ok: true, value }
}

/**
 * 干跑：返回 `{accepted, vetoed_by, reasons[], diff[]}`。
 * **零落盘、零生效、零墙钟**：`diff` 的 old 取当前层（default/file/env/runtime），new 取提交值。
 * 判定边界：`frozen` 永拒；`humanOnly` 必须带 `ap-NNNN` 形状的人工引用（宿主不得自称 human）。
 */
export const previewPatch = ({ doc = {}, env = {}, runtime = {}, patch = {} }) => {
  const reasons = []
  let vetoedBy = null
  const layer = String(patch.layer ?? 'project')
  const target = String(patch.target ?? '')
  const fields = asMap(patch.fields)
  const diff = []

  if (typeof patch.yaml_text === 'string' && patch.yaml_text !== '') {
    const parsed = parseYaml(patch.yaml_text)
    if (!parsed.ok) {
      return { accepted: false, vetoed_by: 'unsupported-yaml', reasons: [{ code: 'unsupported-yaml', key: '', reason: parsed.reason }],
        diff: [], patch: { layer, target, fields }, note: '干跑：YAML 解析失败一律拒（不支持的结构不静默糊掉）' }
    }
  }

  if (layer === 'project') {
    const keys = Object.keys(fields).sort()
    if (!keys.length) reasons.push({ code: 'no-fields', key: '', reason: '至少提交一个键' })
    const view = projectView({ doc, env, runtime })
    // P32：`view.rows` 是行数组 ⇒ 走唯一读数入口；坏行**不静默丢**（在 `reasons` 里如实报一条）
    const viewRead = readRows(view.rows)
    if (viewRead.bad > 0) {
      reasons.push({ code: 'config-row-unreadable', key: '',
        reason: `配置总览里有 ${viewRead.bad} 条读不出来（形状异常：不是对象）→ 这些键按"读不到旧值"处理（不猜、不编）` })
    }
    const byKey = Object.fromEntries(viewRead.rows.map((row) => [row?.key, row]))
    for (const key of keys) {
      const row = byKey[key]
      const declared = PROJECT_KEYS[key]
      const matched = matchSchemaPattern(key, SCHEMA)
      // 顺序就是判定优先级：冻结 → 人工门 → 未登记 → 类型（被拒的键一个都不进 diff）
      if (!matched) {
        reasons.push({ code: 'unknown-key', key, reason: '键不在 host/lib/schema.mjs 白名单内（未登记键一律拒）' })
        vetoedBy = vetoedBy ?? 'unknown-key'
        continue
      }
      if (matched.rule.frozen === true) {
        reasons.push({ code: 'frozen', key, reason: `冻结键（${matched.pattern}）：永拒（连人也不能改）` })
        vetoedBy = 'frozen'
        continue
      }
      if (matched.rule.humanOnly === true && !HUMAN_APPROVAL_RE.test(String(patch.human_approval_ref ?? ''))) {
        reasons.push({ code: 'humanOnly', key, reason: `人工专属键（${matched.pattern}）：必须带 ap-NNNN 形状的人工引用（宿主不得自称 human）` })
        vetoedBy = vetoedBy ?? 'humanOnly'
        continue
      }
      if (!declared) {
        reasons.push({ code: 'unknown-key', key, reason: '白名单里有前缀，但键没有登记类型与默认值（先改 host/lib/config-keys.mjs 再改本文件）' })
        vetoedBy = vetoedBy ?? 'unknown-key'
        continue
      }
      const coerced = coerceType(key, fields[key], declared.type)
      if (!coerced.ok) {
        reasons.push({ code: 'type-mismatch', key, reason: `类型必须是 ${declared.type}（收到 ${Array.isArray(fields[key]) ? 'array' : typeof fields[key]}）` })
        vetoedBy = vetoedBy ?? 'type-mismatch'
        continue
      }
      diff.push({ layer, target: key, key, old: row?.value, old_digest: row?.digest, new: coerced.value,
        new_digest: digestOf(coerced.value), source: row?.source, changed: digestOf(coerced.value) !== row?.digest })
    }
  } else if (layer === 'plugin') {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(target)) {
      reasons.push({ code: 'bad-target', key: '', reason: '插件层 target 必须形如 <ns>/<plugin>（小写字母/数字/连字符）' })
      vetoedBy = 'bad-target'
    }
    const keys = Object.keys(fields).sort()
    if (!keys.length) reasons.push({ code: 'no-fields', key: '', reason: '至少提交一个字段' })
    const section = asMap(asMap(doc).plugins)
    const current = asMap(section[target])
    for (const key of keys) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
        reasons.push({ code: 'bad-field', key: '', reason: '字段名只允许 [A-Za-z0-9_.-]（1..64）' })
        vetoedBy = vetoedBy ?? 'bad-field'
        continue
      }
      const value = fields[key]
      const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value)
        || (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item)))
      if (!scalar) {
        reasons.push({ code: 'type-mismatch', key, reason: '插件配置字段只接受标量或标量列表（嵌套映射由插件自己声明，宿主不猜）' })
        vetoedBy = vetoedBy ?? 'type-mismatch'
        continue
      }
      diff.push({ layer, target, key, old: Object.prototype.hasOwnProperty.call(current, key) ? current[key] : null,
        old_digest: Object.prototype.hasOwnProperty.call(current, key) ? digestOf(current[key]) : null,
        new: value, new_digest: digestOf(value), source: 'file',
        changed: !Object.prototype.hasOwnProperty.call(current, key) || canonical(current[key]) !== canonical(value) })
    }
  } else if (layer === 'credential') {
    if (!Object.prototype.hasOwnProperty.call(CREDENTIALS, target)) {
      reasons.push({ code: 'unknown-credential', key: '', reason: '凭据名不在登记表内（不猜）' })
      vetoedBy = 'unknown-credential'
    }
    const value = fields.value
    if (typeof value !== 'string' || value === '') {
      reasons.push({ code: 'empty-value', key: 'value', reason: '凭据值必须是非空字符串（且**只写不回显**：响应体里不出现值）' })
      vetoedBy = vetoedBy ?? 'empty-value'
    } else {
      // 干跑只给**摘要与指纹**：值不进 diff 的任何字段
      diff.push({ layer, target, key: 'value', old: null, old_digest: null, new: null,
        new_digest: digestOf(value), new_fingerprint_first8: sha256(value).slice(0, 8), source: 'default',
        changed: true, note: '凭据：diff 只出摘要与指纹前 8 位，不出值' })
    }
  } else {
    reasons.push({ code: 'unknown-layer', key: '', reason: 'layer 必须是 project / plugin / credential' })
    vetoedBy = 'unknown-layer'
  }

  return { accepted: reasons.length === 0 && diff.every((row) => row.changed !== false),
    vetoed_by: reasons.length ? vetoedBy : null, reasons, diff,
    patch: { layer, target, fields: Object.keys(fields) },
    note: '干跑（dry-run）：宿主侧前置提示，零落盘零生效；权威判定在 Python 侧 tools/config-apply.py' }
}

// ---------------------------------------------------------------------------
// 待处理项落盘（宿主唯一的写函数）：0700 目录 / 0600 文件 / 临时名 + rename
// ---------------------------------------------------------------------------
export const writePendingItem = (dir, record) => {
  if (!dir) return { ok: false, code: 'inbox-unconfigured' }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持 POSIX 位时尽力而为 */ }
    const payload = canonical(record.fields ?? {})
    const digest = sha256(payload)
    const requestId = digest.slice(0, 16)
    const item = { request_id: requestId, layer: record.layer, target: record.target,
      fields: record.fields, payload_sha256: digest, bytes: Buffer.byteLength(payload, 'utf8'),
      schema: 1, submitted_at: null, submitted_by: 'admin-session' }
    const path = join(dir, `cfg-${requestId}.json`)
    if (existsSync(path)) return { ok: true, code: 'duplicate', request_id: requestId, payload_sha256: digest,
      bytes: item.bytes, path }   // 幂等：同 payload → 同文件名 → 不重复落盘
    const tmp = join(dir, `.cfg-${requestId}.${process.pid}.tmp`)
    writeFileSync(tmp, `${JSON.stringify(item)}\n`, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch (err) { /* 同上 */ }
    renameSync(tmp, path)
    try { rmSync(tmp, { force: true }) } catch (err) { /* 已 rename 成功，残留清理尽力而为 */ }
    return { ok: true, code: 'accepted', request_id: requestId, payload_sha256: digest, bytes: item.bytes, path }
  } catch (err) {
    return { ok: false, code: 'inbox-write-failed', detail: String(err).slice(0, 120) }
  }
}

/** 待处理项 → 提交回执（**不回显任何字段值**）：202 + payload_sha256 + next_action。 */
export const submitReceipt = (out, nextAction) => ({
  ok: out.ok, request_id: out.request_id ?? null, payload_sha256: out.payload_sha256 ?? null,
  bytes: out.bytes ?? 0, layer: out.layer ?? null, target: out.target ?? null,
  code: out.code, next_action: nextAction,
})

export const NEXT_ACTION = '等待 Python 侧消费：tools/config-apply.py --inbox <dir> --file /workspace/config.yaml '
  + '--ledger <path> --approval-ref ap-NNNN --actor human:<人名> --now <ISO>（宿主不写文件、不写账本）'
