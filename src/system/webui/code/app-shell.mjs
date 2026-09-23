/**
 * app-shell —— GUI **应用外壳**的机制层（0 业务语义）：多视图/导航/命令面板/通知中心/状态栏/深链/快捷键，
 * 以及把"界面事件 → 动作"接起来的**动作总线**（`docs/design/29-webui-gui-app.md` §3）。
 *
 * 本文件能做的、不能做的（判据在这一行里，不靠评审）：
 *   · **能**：装配外壳与渲染器、把注册面的贡献列出来、把动作请求交给插件自己的**服务端一半**、
 *     把 0600 待办件落盘、spawn Python 侧的唯一写者/只读工具、按槽位嵌入插件自己注册的区块；
 *   · **不能**：写账本。外壳不 import 任何账本写入 API，也不认识 `Ledger` 这个字；一切落账本只能由
 *     Python 侧唯一写者做（`host` 只提供 `stage()` 落待办件与 `runPython()` 跑写者这两件事）。
 *   · 零业务语义：本文件不出现任何插件 id、领域名词、字段绑定；功能全部来自注册面
 *     （`src/system/webui/code/ui-surface.mjs` 的贡献 + 各插件 `code/ui.mjs` 的注册）。
 *   · 一切注册可撤销（`AGENTS.md` 规则 1）：`unload()` 撤掉一个插件的**全部**贡献（视图/面板/动作/快捷键/
 *     通知源/状态项/校验器 + 它注册的旧槽位区块），页面其余部分不动。
 *   · **沙盘（演示数据）**：本文件提供**机制** —— 按会话身份把这一侧的读/写路径整体切到一个**沙盘目录**下
 *     （自己的账本、自己的待办件目录、自己的投递信封），再按插件声明的 `scenario` 贡献把步骤串起来跑一遍。
 *     机制只做「路径切换 + 顺序 dispatch」，**不认识任何业务步骤**；沙盘数据随时可清空、真实账本零新增。
 *     口径与边界见 `docs/design/29-webui-gui-app.md` §11 与 `src/system/webui/docs/sandbox-and-demo.md`。
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, chmodSync, renameSync, writeFileSync,
  rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { join, relative, resolve } from 'node:path'
import { createUiSurface, PANEL_KINDS } from './ui-surface.mjs'
import { createCollabStore } from './collab.mjs'
import { createCollabSurface, COLLAB_PLUGIN_ID } from './collab-ui.mjs'
import { createPeopleStore } from './people.mjs'
import { createPeopleSurface, PEOPLE_PLUGIN_ID } from './people-ui.mjs'

export const SURFACE_VERSION = 1
/** 外壳自己的键盘快捷键（机制；插件注册的在注册面里）。 */
export const SHELL_SHORTCUTS = ['mod+k 命令面板', 'g h/g c/g s 切换视图', '? 帮助', 'r 重载', 'Esc 关闭']
/** 待办件目录名（宿主只落 0600 待办件；落账本归 Python 侧）。 */
export const PENDING_SCHEMA = 'quotagent/pending/v1'
const MAX_BODY_BYTES = 262144
const PYTHON_TIMEOUT_MS = 30000
const DEFAULT_PYTHON = process.env.QUOTAGENT_PYTHON || 'python3'

// ============================================================================================
// **乐观并发**（对象版本/指纹）—— 机制的一半：形状、指纹、差异、上限。
//
// 为什么这是机制而不是业务：它只回答两件事 ——"这个可编辑对象上次被谁改成了什么"与"你要写进去的
// 跟它差在哪"。外壳不知道字段的业务含义（`state()` 由插件给），因此它既能保护报价草稿，也能保护
// 变更单回应、比价权重、名册这类"配置对象"（AGENTS.md 规则 10：内核/账本语义一个字都不碰）。
//
// 判据（**不后写覆盖前写**）：
//   · 版本对得上（或这个对象还没有版本）⇒ 放行，成功后把新版本记下来（rev+1）；
//   · 对不上 ⇒ **明确拒绝**（`object-changed`），给出"自你那一版以来谁改了什么"与"你这次要写什么"；
//   · 没带上版本 ⇒ 安全默认：内容与现在**一样**放行（本来就没改），**不一样就拒**（没看过就改不算读过）。
// 存储：`<ui_shared>/webui/object-versions/<侧>.json`（目录 0700 / 文件 **0600**、原子写、有界）。
// **它不是账本**：版本/指纹是"谁看到过哪一版"的运营状态，写进账本会改事件类型目录与证据包哈希
// （理由与协作面/名册/附件同源，见 `collab.mjs`/`people.mjs` 文件头）。
// ============================================================================================
export const VERSION_SCHEMA = 'quotagent/object-versions/v1'
/** 有界（超出的**丢掉并如实计数**，不静默增长）：对象数 / 每个对象的改动历史 / 字段数 / 值长度。 */
export const VERSION_LIMITS = { objects: 400, history: 12, fields: 40, value_chars: 160 }
export const CONFLICT_CODE = 'object-changed'

const VKEY_SEP = '\u0000'
export const versionObjectKey = (objectClass, objectId) => `${objectClass}${VKEY_SEP}${objectId}`
/** 一次保存的"对象新状态"规范化：**扁平 字段→标量**（排序 + 有界 + 字符串化；不认识的形状丢掉）。 */
export function normalizeState(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const key of Object.keys(value).sort()) {
    if (Object.keys(out).length >= VERSION_LIMITS.fields) break
    const raw = value[key]
    if (raw === undefined || raw === null) { out[String(key)] = ''; continue }
    if (Array.isArray(raw) || typeof raw === 'object') {
      // 复杂值：只留它的规范化 JSON 指纹的一部分（外壳不解读结构，只保证"变了就能看出来"）
      out[String(key)] = JSON.stringify(raw).slice(0, VERSION_LIMITS.value_chars)
      continue
    }
    out[String(key)] = String(raw).slice(0, VERSION_LIMITS.value_chars)
  }
  return out
}
/** 对象状态的**指纹**（`sha256:<hex>`；键序固定 ⇒ 同一内容恒同一指纹）。 */
export function fingerprintOf(fields) {
  const normalized = normalizeState(fields)
  const body = Object.keys(normalized).sort().map((key) => `${key}=${normalized[key]}`).join('\n')
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}
/** 逐字段差异（`before` → `after`）：只给**变了**的字段。 */
export function stateDiff(before, after) {
  const left = normalizeState(before)
  const right = normalizeState(after)
  const changed = []
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if ((left[key] ?? '') === (right[key] ?? '')) continue
    changed.push({ field: key, from: left[key] ?? '', to: right[key] ?? '' })
  }
  return changed
}
/** 客户端带来的"我看到的版本"与记录比对：指纹（可少 `sha256:` 前缀）或 `rev:<N>` 都认。 */
export function versionMatches(expected, current) {
  const wanted = String(expected ?? '').trim()
  if (wanted === '' || !current) return false
  const wantedHash = wanted.startsWith('sha256:') ? wanted : `sha256:${wanted}`
  if (wantedHash === current.fingerprint) return true
  const rev = /^rev:(\d+)$/.exec(wanted)
  return rev ? Number(rev[1]) === Number(current.rev) : false
}
/**
 * **自"你看到的那一版"以来的改动**（"谁在何时改了什么"）。
 * `history` 每条记的是"进入那一版时改了什么"（相对上一版）；把 rev 大于你的那些累加成
 * "字段 → 第一次的 from / 最后一次的 to / 谁在何时改的"（同一字段被多人改过就列多行）。
 */
export function changesSince(expected, current) {
  if (!current) return { known: false, since: [] }
  const history = Array.isArray(current.history) ? current.history : []
  const wanted = String(expected ?? '').trim()
  const wantedHash = wanted.startsWith('sha256:') ? wanted : `sha256:${wanted}`
  const revMatch = /^rev:(\d+)$/.exec(wanted)
  const mine = history.find((entry) => entry.fingerprint === wantedHash
    || (revMatch ? Number(entry.rev) === Number(revMatch[1]) : false))
  if (!mine) return { known: false, since: [] }
  const since = []
  for (const entry of history) {
    if (Number(entry.rev) <= Number(mine.rev)) continue
    for (const change of (Array.isArray(entry.changed) ? entry.changed : [])) {
      since.push({ ...change, by: String(entry.by ?? ''), at: String(entry.at ?? ''), rev: entry.rev })
    }
  }
  return { known: true, since, seen_rev: mine.rev, seen_by: String(mine.by ?? ''),
    seen_at: String(mine.at ?? '') }
}

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** 深排序（**所有层级**）：与 Python 侧 `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)`
 *  逐字节一致 —— 待办件的 `payload_sha256` 由宿主算、由 Python 侧重算复核，两边必须同构。 */
const deepSort = (value) => {
  if (Array.isArray(value)) return value.map(deepSort)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = deepSort(value[key])
    return out
  }
  return value
}
const canonical = (record) => {
  const payload = {}
  for (const key of Object.keys(record).sort()) {
    if (['payload_sha256', 'bytes', 'submitted_at'].includes(key)) continue
    payload[key] = deepSort(record[key])
  }
  return JSON.stringify(payload)
}
const digestOf = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
const flat = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)

/**
 * **写者回执的单一判据**（机制，0 业务语义）：一个 Python 唯一写者跑完，算数的只有两样东西 ——
 * **退出码**（`rc`）与 **stdout 最后一行 JSON**。响应体的 `ok` / `code` / `ledger_added` / `next_action`
 * 必须**从这一处派生**（插件用 `host.writerReceipt(run)` 拿它），不许再叠加"看起来没写就报失败"这类
 * 自造判据 —— 那会造出**假失败**：写者真落了行、界面却说失败，用户于是**重复提交**（比真失败更坏）。
 *
 * 它同时把"这条回执里哪一条是**本动作**那一项"变成显式查询（`receipt.item({file, draft_id})`）：
 * 修前的假失败正是拿 `applied[0]` 当自己的那一条（写者一次处理多条待办件时，第一条不是你的）。
 */
const RECEIPT_ITEM_KEYS = ['file', 'pending_file', 'request', 'name', 'draft_id', 'quote_draft_id',
  'quote_id', 'intent_id', 'gate_id', 'id']

/** 回执条目里指代"哪个待办件/请求文件"的名字（basename；没有就返回空串 —— 不猜）。 */
export function receiptFileName(entry) {
  if (entry === null || entry === undefined) return ''
  if (typeof entry === 'string') return entry.split('/').pop()
  if (typeof entry !== 'object') return ''
  for (const key of ['file', 'pending_file', 'request', 'name']) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().split('/').pop()
  }
  return ''
}

/** 写者回执：**退出码 + stdout JSON** ⇒ `{ok, code, ledger_added, applied, duplicates, refused, item()}`。 */
export function writerReceipt(run) {
  const json = run && typeof run.json === 'object' && run.json !== null ? run.json : null
  const rc = run && Number.isInteger(run.rc) ? run.rc : null
  const said = json && typeof json.ok === 'boolean' ? json.ok : null
  const applied = json && Array.isArray(json.applied) ? json.applied : []
  const duplicates = json && Array.isArray(json.duplicates) ? json.duplicates : []
  let refused = json && Array.isArray(json.refused) ? json.refused : []
  if (!refused.length && json && json.refusal) refused = [{ ...json.refusal, file: null }]
  const skipped = json && Array.isArray(json.skipped) ? json.skipped : []
  const refusal = refused[0] ?? (json ? json.refusal ?? null : null)
  const ledgerAdded = json && Number.isFinite(Number(json.ledger_added)) ? Number(json.ledger_added) : null
  const ok = rc === 0 && said === true
  return {
    tool: String(run?.tool ?? ''), rc, said, ok,
    spawn: run?.code === 'tool-missing' ? 'tool-missing' : '',
    code: ok ? null : (refusal?.code ?? run?.code ?? 'writer-failed'),
    reason: String(refusal?.reason ?? run?.reason ?? ''),
    next_action: String(refusal?.next_action ?? json?.next_action ?? ''),
    ledger_added: ledgerAdded, applied, duplicates, refused, skipped, json,
    stdout_tail: run?.stdout ? flat(run.stdout, 400) : '',
    stderr_tail: run?.stderr ? flat(run.stderr, 400) : '',
    /**
     * 在**这份回执**里找出「本动作那一条」：按待办件名 / 草稿 id / 报价 id 逐键比，返回
     * `{where, entry}`（`where` ∈ applied/duplicates/refused/skipped，顺序 = 判定优先级）。
     * 找不到 ⇒ `null`（**找不到就说找不到**，绝不退回去猜"大概是第一条"）。
     */
    item(keys = {}) {
      const wanted = new Set()
      for (const value of Object.values(keys)) {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text !== '') { wanted.add(text); wanted.add(text.split('/').pop()) }
      }
      if (!wanted.size) return null
      const hit = (entry) => {
        if (entry === null || entry === undefined) return false
        if (typeof entry === 'string') return wanted.has(entry) || wanted.has(entry.split('/').pop())
        if (typeof entry !== 'object') return false
        const name = receiptFileName(entry)
        if (name !== '' && wanted.has(name)) return true
        for (const key of RECEIPT_ITEM_KEYS) {
          const value = entry[key]
          if (typeof value === 'string' && value !== '' && wanted.has(value)) return true
        }
        return false
      }
      const lists = { applied, duplicates, refused, skipped }
      for (const where of ['applied', 'duplicates', 'refused', 'skipped']) {
        for (const entry of lists[where]) if (hit(entry)) return { where, entry }
      }
      return null
    },
  }
}

/** 回执的**可序列化摘要**（响应体里带的那一份：原始判据都在，函数不进响应）。 */
export function receiptSummary(receipt, tool = '') {
  return {
    tool: String(tool || receipt.tool || ''), rc: receipt.rc, stdout_ok: receipt.said, ok: receipt.ok,
    code: receipt.code, ledger_added: receipt.ledger_added,
    counts: { applied: receipt.applied.length, duplicates: receipt.duplicates.length,
      refused: receipt.refused.length, skipped: receipt.skipped.length },
    files: [...receipt.applied, ...receipt.duplicates, ...receipt.refused, ...receipt.skipped]
      .map(receiptFileName).filter((name) => name !== ''),
    refused_codes: receipt.refused.map((entry) => String(entry?.code ?? '')).filter((code) => code !== ''),
    stdout_tail: receipt.stdout_tail, stderr_tail: receipt.stderr_tail,
  }
}

/**
 * **导出 / 打印的序列化机制**（外壳提供，0 业务语义）：插件把"这一侧账本里的事实 + 一张表"交进来，
 * 外壳只把它变成**一份可读的文件**（CSV / 可打印 HTML）并给内容指纹 —— 它不认识表里是什么业务，
 * 也不生成任何行（行必须由插件从它自己的事实里给出；`docs/design/29-webui-gui-app.md` §3 的
 * 「谁的事实谁导出」）。上限与拒绝都是有名的（超限如实拒，不截断成半份文件）。
 */
export const REPORT_LIMITS = { max_bytes: 4 * 1024 * 1024, max_rows: 5000, max_columns: 40, max_facts: 40 }

/** CSV 单元格：逗号/引号/换行按 RFC4180 处理；`null`/`undefined` 一律空串（不写 "null" 这种假值）。 */
export function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
/** 一张表的 CSV 文本（列声明 `[{key, label}]`；**行序即账本行序**，不重排 —— 便于逐行对账）。 */
export function csvText(columns, rows) {
  const head = columns.map((column) => csvCell(column.label ?? column.key)).join(',')
  const body = rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(',')).join('\n')
  return `${head}\n${body}\n`
}
const escHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/**
 * 一份**自带样式、可直接打印**的 HTML 文档（事实表 + 明细表 + 备注）。
 * 打印样式放在文档内部 ⇒ 在哪台机器上打开都是同一份样子（不依赖界面样式）。
 */
export function htmlReport({ title = '', subtitle = '', facts = [], columns = [], rows = [], notes = [],
  generated_at = '', source = '' } = {}) {
  const factRows = facts.map((fact) => `<dt>${escHtml(fact.key)}</dt><dd>${escHtml(fact.value)}</dd>`).join('')
  const head = columns.map((column) => `<th>${escHtml(column.label ?? column.key)}</th>`).join('')
  const body = rows.map((row) => `<tr>${columns.map((column) =>
    `<td>${escHtml(row[column.key])}</td>`).join('')}</tr>`).join('')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${escHtml(title)}</title><style>
  @page { margin: 14mm; }
  body { font: 13px/1.6 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #555; margin: 0 0 10px; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 12px; }
  .facts dt { color: #555; } .facts dd { margin: 0; font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  th, td { border: 1px solid #bbb; padding: 3px 6px; text-align: left; font-size: 12px; }
  th { background: #f0f0f0; }
  td { font-variant-numeric: tabular-nums; }
  .notes { margin-top: 12px; color: #444; font-size: 12px; }
  .foot { margin-top: 14px; padding-top: 6px; border-top: 1px solid #ccc; color: #666; font-size: 11px; }
  @media print { thead { display: table-header-group; } tr { break-inside: avoid; } }
</style></head><body>
<h1>${escHtml(title)}</h1>${subtitle ? `<p class="sub">${escHtml(subtitle)}</p>` : ''}
${factRows ? `<dl class="facts">${factRows}</dl>` : ''}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${notes.length ? `<div class="notes">${notes.map((note) => `<p>${escHtml(note)}</p>`).join('')}</div>` : ''}
<p class="foot">${generated_at ? `生成时刻 ${escHtml(generated_at)} · ` : ''}${escHtml(source)}</p>
</body></html>`
}

/** 导出结果的标准形状（客户端认得 `result.export` ⇒ 落文件 + 打开预览/打印）。 */
export function buildReport(spec = {}, { now = '' } = {}) {
  const format = String(spec.format ?? '').toLowerCase()
  if (!['csv', 'html'].includes(format)) {
    return { ok: false, code: 'unsupported-format', reason: `这个导出只支持 csv / html：${JSON.stringify(spec.format ?? null)}`,
      next_action: '用声明过的格式（界面上每个格式一个按钮）' }
  }
  const columns = Array.isArray(spec.columns) ? spec.columns : []
  const rows = Array.isArray(spec.rows) ? spec.rows : []
  if (columns.length === 0 || columns.length > REPORT_LIMITS.max_columns) {
    return { ok: false, code: 'report-columns-invalid',
      reason: `列数必须在 1..${REPORT_LIMITS.max_columns} 之间（现在 ${columns.length}）`,
      next_action: '把表的列收敛到关键字段（导出是给人看的台账，不是全字段转储）' }
  }
  if (rows.length > REPORT_LIMITS.max_rows) {
    return { ok: false, code: 'report-too-many-rows',
      reason: `${rows.length} 行超过 ${REPORT_LIMITS.max_rows} 行上限`,
      next_action: '按对象/时间窗缩小范围后再导出（导出不截断：截断会给出半份台账）' }
  }
  const facts = Array.isArray(spec.facts) ? spec.facts.slice(0, REPORT_LIMITS.max_facts) : []
  const base = String(spec.filename || 'export').replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 80) || 'export'
  const filename = `${base}.${format}`
  const content = format === 'csv' ? csvText(columns, rows)
    : htmlReport({ title: spec.title ?? '', subtitle: spec.subtitle ?? '', facts, columns, rows,
      notes: Array.isArray(spec.notes) ? spec.notes : [], generated_at: spec.generated_at ?? now,
      source: spec.source ?? '' })
  if (Buffer.byteLength(content, 'utf8') > REPORT_LIMITS.max_bytes) {
    return { ok: false, code: 'report-too-large',
      reason: `导出内容 ${Buffer.byteLength(content, 'utf8')} 字节超过 ${REPORT_LIMITS.max_bytes} 字节上限`,
      next_action: '缩小范围（导出不截断：截断会给出半份台账）' }
  }
  return { ok: true, code: 'export-ready',
    result: { export: { filename, format, content_type: format === 'csv'
      ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8', content, rows: rows.length,
      columns: columns.map((column) => column.label ?? column.key), digest: `sha256:${createHash('sha256')
        .update(content, 'utf8').digest('hex')}`, source: spec.source ?? '',
      ledger_refs: Array.isArray(spec.ledger_refs) ? spec.ledger_refs.slice(0, 200) : [] } },
    note: `导出已生成（${rows.length} 行，格式 ${format}）：内容只由本插件自己那一侧的事实拼出，`
      + '外壳只做序列化 —— 逐行可与账面核对' }
}

/** 读体（有界）：超上限**如实拒**，不截断成另一份正文。 */
function readBody(req, done) {
  let data = ''
  let over = false
  req.on('data', (chunk) => {
    if (data.length + chunk.length > MAX_BODY_BYTES) over = true
    else if (!over) data += chunk
  })
  req.on('end', () => done(over ? null : data))
  req.on('error', () => done(null))
}

// ============================================================================================
// **服务端窗口（分页 / 筛选 / 排序 / 计数）** —— 机制（0 业务语义）。
//
// 为什么搬到服务端：面板把**全量行**发给客户端、由客户端"筛选→排序→分页"时，首屏要等一整份载荷
// （实测 5395 行 / 3.4 MB / 1825 ms）。而客户端真正需要的是**这一页的行** + **在全集上算出来的数字**。
// 于是这几件事在服务端做，客户端**照抄**：
//   ① 筛选（关键字 ∧ 每列条件 ∧ list 的桶筛选）、② 稳定全序排序、③ 分页窗口（本页那几行）；
//   ④ 计数（`共 N` = 面板给的行数、`命中 M` = 筛选后剩下的、`第 P/PP 页`）；
//   ⑤ 命中行集的**派生物**（小计 `totals`、`best_when:'min'` 的最小值、枚举候选、桶计数、级别计数、
//      跨页全选用的行键）—— 客户端只拿一页时这些自己算必错，所以必须一起给。
//
// 语义不变量（每条都有对账脚本顶着；口径与实测数字见 `src/system/webui/docs/scale-and-performance.md`）：
//   1. 窗口里的行**逐行等于**"全量 → 筛选 → 排序"后的第 `start..end` 行（**不是**前端把全量截一段）；
//   2. `total` 恒等于面板给的行数（与不分页时看到的同一个数字）；`matched` 恒等于独立实现对**全量行**
//      算出的筛选结果（JS 与 Python 两份实现逐项对拍）；
//   3. 排序是全序且稳定（同值按原始行序）⇒ "排序后第 k 行"与全量排序的第 k 行逐行相同；
//   4. 只读投影：不写账本、不落文件、不改任何事实（拒绝/筛选都不产生副作用）。
//
// 默认**不开窗口**（请求里没有 `w`/`pq` ⇒ 原样返回全量行）：既有调用方（`src/system/webui/tools/`、
// `tmp/` 脚本、旧客户端）行为一字不变；界面（`code/assets/app.js`）每次都带 `w=1`，所以首屏走窗口这条路。
// ============================================================================================
/** 每页行数（`0` = 全部：**明确选择**的全量渲染，界面会写明"这一页会全量渲染"）。与客户端同一套取值。 */
export const WINDOW_SIZES = [10, 25, 50, 100, 250, 0]
export const WINDOW_DEFAULT_SIZE = 25
/** 窗口能作用的形状 → 行数组字段名（其余形状没有行数组，原样返回）。 */
export const WINDOW_FIELDS = { table: 'rows', list: 'items', files: 'files', kv: 'items' }
/** 有界（超出的**丢掉并如实计数**在 `dropped` 里，不静默截断成另一份查询）。 */
export const WINDOW_LIMITS = { kw: 120, cols: 40, col_value: 80, page: 100000, edits: 200, fields: 40,
  keys: 5000, head: 8, options: 24, option_chars: 24, key_chars: 60, bucket: 120 }
/** 待办级别 → 名次（**工作台**按它排序；`level` 是外壳自己的状态词汇，不是业务字段）。 */
export const WINDOW_LEVEL_RANK = { bad: 0, warn: 1, info: 2, ok: 3 }

const windowText = (value) => (value === null || value === undefined ? '' : String(value))
/** 列筛型：插件显式声明优先，其余按列 `type` 自动判型（与客户端 `columnFilterKind` 同一判据）。 */
export const windowFilterKind = (column) => {
  const declared = String(column?.filter ?? '')
  if (['enum', 'text', 'number', 'date'].includes(declared)) return declared
  if (column?.type === 'number') return 'number'
  if (column?.type === 'date' || column?.type === 'datetime') return 'date'
  return 'text'
}
/** 一行的"可搜文本"：**所有标量字段**（含没显示的列、id、时刻）—— 与客户端 `rowHaystack` 逐字节同口径。 */
export const windowHaystack = (row, columns) => {
  const parts = []
  for (const column of columns) parts.push(windowText(row?.[column.key]))
  for (const [key, value] of Object.entries(row || {})) {
    if (key === 'ref' || key === 'row_actions' || key === 'preset') continue
    if (value === null || typeof value === 'object') continue
    parts.push(String(value))
  }
  return parts.join(' \u0000 ').toLowerCase()
}
/** 单列条件：`数值/时间` 用 `min~max`、枚举用全等、文本用包含（都忽略大小写）—— 同客户端 `matchColumn`。 */
export const windowMatchColumn = (row, column, raw) => {
  const value = String(raw ?? '').trim()
  if (value === '') return true
  const kind = windowFilterKind(column)
  const cell = windowText(row?.[column.key])
  if (kind === 'number') {
    const [min, max] = value.split('~')
    const n = Number(cell)
    if (!Number.isFinite(n) || cell.trim() === '') return false
    if (min !== undefined && min.trim() !== '' && n < Number(min)) return false
    if (max !== undefined && max.trim() !== '' && n > Number(max)) return false
    return true
  }
  if (kind === 'date') {
    const [from, to] = value.split('~')
    const day = cell.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
    if (from !== undefined && from.trim() !== '' && day < from.trim()) return false
    if (to !== undefined && to.trim() !== '' && day > to.trim()) return false
    return true
  }
  if (kind === 'enum') return cell === value
  return cell.toLowerCase().includes(value.toLowerCase())
}
/** **全量行集 → 命中行集**（关键字 ∧ 每个列条件）；`total` 是面板给的全部行（计数口径的基准）。 */
export const windowFiltered = (columns, rows, spec) => {
  const conditions = Object.entries(spec.cols).map(([key]) => [columns.find((column) => column.key === key)
    || { key, type: 'text' }, spec.cols[key]])
  const needle = spec.kw.trim().toLowerCase()
  let matched = rows
  if (conditions.length) {
    matched = matched.filter((row) => conditions.every(([column, raw]) => windowMatchColumn(row, column, raw)))
  }
  if (needle !== '') matched = matched.filter((row) => windowHaystack(row, columns).includes(needle))
  return { total: rows.length, matched }
}
/** **稳定全序排序**（同值按原始行序）⇒ 与客户端 `sortRows` 输出逐行相同；不认的排序列 = 不排。 */
export const windowSorted = (indexed, columns, sort) => {
  const at = String(sort).indexOf(':')
  const key = at < 0 ? '' : sort.slice(0, at)
  const dir = at < 0 ? '' : sort.slice(at + 1)
  if (key === '' || (dir !== 'asc' && dir !== 'desc')) return indexed
  const column = columns.find((item) => item.key === key)
  if (!column) return indexed
  const numeric = windowFilterKind(column) === 'number'
  const factor = dir === 'desc' ? -1 : 1
  return indexed.slice().sort((left, right) => {
    const a = left.row?.[key]
    const b = right.row?.[key]
    let cmp = 0
    if (numeric) {
      const x = Number(a); const y = Number(b)
      const xf = Number.isFinite(x) && String(windowText(a)).trim() !== ''
      const yf = Number.isFinite(y) && String(windowText(b)).trim() !== ''
      cmp = xf && yf ? (x - y) : (xf === yf ? 0 : (xf ? -1 : 1))
    } else {
      cmp = windowText(a).localeCompare(windowText(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    }
    return cmp !== 0 ? cmp * factor : (left.index - right.index)
  })
}
/** 分页窗口（`size === 0` ⇒ 全部；页号越界一律夹回合法范围，绝不返回空页）。 */
export const windowPageOf = (items, size, page) => {
  if (!size) return { page: 0, pages: 1, start: 0, end: items.length, window: items }
  const pages = Math.max(1, Math.ceil(items.length / size))
  const at = Math.min(Math.max(0, Number(page) || 0), pages - 1)
  const start = at * size
  return { page: at, pages, start, end: Math.min(items.length, start + size),
    window: items.slice(start, start + size) }
}
/**
 * 行键（**按全量行集算一次**）：与客户端 `rowKeyOf` 同口径 —— table 用 `id ?? 第一列的键`，
 * list/kv/files 用 `id ?? 原始下标`；下标来自**全量行集**，所以翻页/换筛选后行键不跟着页变
 * （编辑与跨页选择因此不会串行）。
 */
export const windowRowKeyOf = (field, columns, row, index) => (field === 'rows'
  ? String(row?.id ?? row?.[(columns || [])[0]?.key] ?? index)
  : String(row?.id ?? index))

/** 请求里的查询说明：**洗净 + 有界**（坏值丢掉并计数；`size`/`page` 回落到合法值）。 */
export function normalizeWindowSpec(raw = {}, columns = []) {
  const dropped = []
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  // 空串/缺省 = **没给**（回落默认每页行数），不是"0 = 全部"：`size=0`（全部）必须是**明确写的**
  const blank = (value) => value === '' || value === undefined || value === null
  const sizeRaw = blank(source.size) ? NaN : Number(source.size)
  const size = WINDOW_SIZES.includes(sizeRaw) ? sizeRaw : WINDOW_DEFAULT_SIZE
  const pageRaw = blank(source.page) ? NaN : Math.trunc(Number(source.page))
  const page = Number.isFinite(pageRaw) ? Math.max(0, Math.min(WINDOW_LIMITS.page, pageRaw)) : 0
  const kw = String(source.kw ?? '').slice(0, WINDOW_LIMITS.kw)
  const bucket = String(source.bucket ?? '').slice(0, WINDOW_LIMITS.bucket)
  const cols = {}
  if (source.cols && typeof source.cols === 'object' && !Array.isArray(source.cols)) {
    for (const [key, value] of Object.entries(source.cols)) {
      if (Object.keys(cols).length >= WINDOW_LIMITS.cols) { dropped.push(`cols:${String(key).slice(0, 32)}`); continue }
      if (typeof key !== 'string' || key.length > WINDOW_LIMITS.key_chars) { dropped.push('cols:bad-key'); continue }
      if (value === null || typeof value === 'object') { dropped.push(`cols:${key}`); continue }
      const text = String(value).slice(0, WINDOW_LIMITS.col_value)
      if (text.trim() === '') continue
      cols[key] = text
    }
  }
  const edits = {}
  if (source.edits && typeof source.edits === 'object' && !Array.isArray(source.edits)) {
    for (const [rowKey, fields] of Object.entries(source.edits)) {
      if (Object.keys(edits).length >= WINDOW_LIMITS.edits) { dropped.push(`edits:${String(rowKey).slice(0, 32)}`); continue }
      if (typeof rowKey !== 'string' || rowKey.length > 160 || !fields || typeof fields !== 'object'
        || Array.isArray(fields)) { dropped.push('edits:bad-row'); continue }
      const clean = {}
      for (const [field, value] of Object.entries(fields)) {
        if (Object.keys(clean).length >= WINDOW_LIMITS.fields) { dropped.push(`edits:${rowKey}:fields`); break }
        if (typeof field !== 'string' || field.length > WINDOW_LIMITS.key_chars) continue
        if (value === null || value === undefined) { clean[field] = ''; continue }
        if (typeof value === 'object') { dropped.push(`edits:${rowKey}:${field}`); continue }
        clean[field] = typeof value === 'number' ? value : String(value).slice(0, WINDOW_LIMITS.col_value)
      }
      if (Object.keys(clean).length) edits[rowKey] = clean
    }
  }
  const sortRaw = String(source.sort ?? '')
  const sort = /^[A-Za-z0-9_.:-]{1,60}:(asc|desc)$/.test(sortRaw) ? sortRaw : ''
  if (sortRaw !== '' && sort === '') dropped.push(`sort:${sortRaw.slice(0, 32)}`)
  return { size, page, kw, cols, sort, bucket, edits, dropped }
}

/** 小计规则（`data.totals`）在**命中行集**上算：与客户端 `totalsOf` 同口径（`valueOf` 里编辑优先）。 */
function windowTotals(declared, rows, keyOf, valueOf) {
  return (Array.isArray(declared) ? declared : []).map((rule) => {
    let sum = 0
    let counted = 0
    rows.forEach((row, index) => {
      const key = keyOf(row, index)
      const read = (field) => (valueOf ? valueOf(key, field) : (row ? row[field] : undefined))
      if (rule.skip_empty === true && String(read(rule.key) ?? '').trim() === '') return
      if (rule.count === true) { counted += 1; return }
      const factor = rule.factor === undefined || rule.factor === null ? 1 : Number(read(rule.factor))
      sum += Number(read(rule.key)) * (Number.isFinite(factor) ? factor : 0)
      counted += 1
    })
    return { label: String(rule.label ?? rule.key), value: rule.count === true ? counted : sum,
      unit: String(rule.unit ?? ''), counted, key: String(rule.key), factor: rule.factor ?? null,
      count: rule.count === true }
  })
}

/**
 * 一块面板的**服务端窗口**：把面板给的行数组换成窗口，并把"在全集上算出来的数字"一起给出。
 *
 * @param {string} field 行数组字段名（`rows` / `items` / `files`）
 * @param {object[]} columns 列声明（插件给；没有列时按调用方合成的列判型）
 * @param {object[]} rows **面板给的全量行**
 * @param {object} spec `normalizeWindowSpec` 的结果
 * @param {object} [options] `{groupTotals: {…}, groups: [{id,label}], filesCounts: true, levels: true}`
 */
export function windowPanelData({ field, columns = [], rows = [], spec, options = {} }) {
  const keyOf = (row, index) => windowRowKeyOf(field, columns, row, index)
  const keysAll = rows.map(keyOf)
  const byKey = new Map(keysAll.map((key, index) => [key, rows[index]]))
  const valueOf = (rowKey, name) => {
    const typed = spec.edits[rowKey]?.[name]
    if (typed !== undefined) return typed
    return byKey.get(rowKey)?.[name]
  }
  const levels = options.levels === true
  const rankOf = (item) => WINDOW_LEVEL_RANK[String(item?.level ?? 'info')] ?? WINDOW_LEVEL_RANK.info
  // 桶筛选只对声明了桶的面板生效（`list` 的筛选片）；它是"看到哪些"的一部分，与关键字/列条件同级。
  const scoped = spec.bucket === '' ? rows : rows.filter((row) => String(row?.bucket ?? '') === spec.bucket)
  const filtered = windowFiltered(columns, scoped, spec)
  const sorted = windowSorted(filtered.matched.map((row, index) => ({ row, index })), columns, spec.sort)
  const paged = windowPageOf(sorted, spec.size, spec.page)
  const windowRows = paged.window.map((item) => item.row)
  const windowKeys = paged.window.map((item) => keyOf(item.row, item.index))
  const matchedKeys = filtered.matched.map((row, index) => keyOf(row, index))
  const capped = matchedKeys.length > WINDOW_LIMITS.keys
  // 命中行键（跨页"选中全部命中行"要用）**按需给**：它能有几十 KB（1800 行 ≈ 50 KB），
  // 而只有用户真去点那颗按钮时才需要 ⇒ 默认不发，`spec.keys=true` 时才发（界面点按钮时补一次请求）。
  const wantKeys = options.wantKeys === true
  // 枚举候选（列筛选下拉）：在**全量行集**上算（值不多且短时才给，与客户端 `enumOptions` 同一判据）
  const enumOptions = {}
  for (const column of columns) {
    if (windowFilterKind(column) !== 'enum') continue
    const seen = new Map()
    let over = false
    for (const row of scoped) {
      const value = windowText(row?.[column.key]).trim()
      if (value === '' || value.length > WINDOW_LIMITS.option_chars) continue
      seen.set(value, (seen.get(value) || 0) + 1)
      if (seen.size > WINDOW_LIMITS.options + 2) { over = true; break }
    }
    if (over || !seen.size || seen.size > WINDOW_LIMITS.options) continue
    enumOptions[column.key] = [...seen.entries()].sort((left, right) => right[1] - left[1]
      || left[0].localeCompare(right[0], 'zh-Hans-CN')).map(([value, count]) => ({ value, count }))
  }
  // `best_when:'min'`：最小值是**命中行集**的性质（不是本页的性质），所以在服务端算
  const mins = {}
  for (const column of columns) {
    if (column.best_when !== 'min') continue
    let best = Infinity
    for (const row of filtered.matched) {
      const raw = row[column.key]
      if (raw === '' || raw === undefined) continue
      const n = Number(deltaNumber(raw))
      if (Number.isFinite(n)) best = Math.min(best, n)
    }
    if (best !== Infinity) mins[column.key] = best
  }
  const bucketCounts = {}
  for (const row of rows) {
    const key = String(row?.bucket ?? '')
    if (key === '') continue
    bucketCounts[key] = (bucketCounts[key] || 0) + 1
  }
  const levelCounts = {}
  const levelByBucket = {}
  if (levels) {
    for (const row of rows) {
      const level = String(row?.level ?? 'info')
      levelCounts[level] = (levelCounts[level] || 0) + 1
      const key = String(row?.bucket ?? '')
      if (key === '') continue
      levelByBucket[key] = levelByBucket[key] || {}
      levelByBucket[key][level] = (levelByBucket[key][level] || 0) + 1
    }
  }
  const head = levels ? rows.map((row, index) => ({ row, index }))
    .slice().sort((left, right) => (rankOf(left.row) - rankOf(right.row)) || (left.index - right.index))
    .slice(0, WINDOW_LIMITS.head).map((item) => item.row) : []
  const groupTotals = (options.groupTotals && Array.isArray(options.groups) && options.groups.length >= 2)
    ? options.groups.map((group) => {
      let sum = 0
      for (const row of filtered.matched) {
        for (const column of options.allColumns || columns) {
          if (String(column.group) !== group.id) continue
          const wanted = options.groupTotals.key === undefined ? null : String(options.groupTotals.key)
          const prefix = options.groupTotals.key_prefix === undefined ? null : String(options.groupTotals.key_prefix)
          if (wanted !== null && column.key !== wanted) continue
          if (prefix !== null && !String(column.key).startsWith(prefix)) continue
          sum += Number(row[column.key]) || 0
        }
      }
      return { label: `${group.label}${options.groupTotals.label_suffix || '合计'}`, value: sum,
        unit: String(options.groupTotals.unit || '') }
    }) : []
  const filesCounts = options.filesCounts === true
    ? { live: filtered.matched.filter((row) => row?.deleted !== true).length,
      dead: filtered.matched.filter((row) => row?.deleted === true).length }
    : null
  const query = {
    server: true, field, shape_kind: options.kind ?? '',
    applied: { kw: spec.kw, cols: spec.cols, sort: spec.sort, bucket: spec.bucket, ...spec.dropped.length ? { dropped: spec.dropped } : {} },
    size: spec.size, page: paged.page, pages: paged.pages, start: paged.start, end: paged.end,
    window: windowRows.length,
    total: filtered.total, total_full: rows.length, matched: filtered.matched.length,
    active: spec.kw.trim() !== '' || spec.sort !== '' || Object.keys(spec.cols).length > 0,
    row_keys: windowKeys, matched_keys: (wantKeys && !capped) ? matchedKeys : [],
    matched_keys_capped: capped, matched_keys_cap: WINDOW_LIMITS.keys,
    matched_keys_available: matchedKeys.length, matched_keys_on_demand: !wantKeys, keys_all: keysAll.length,
    mins, totals: windowTotals(options.totals, filtered.matched, keyOf, valueOf),
    group_totals: groupTotals, enum_options: enumOptions, bucket_counts: bucketCounts,
    level_counts: levelCounts, level_by_bucket: levelByBucket, head,
  }
  if (filesCounts) query.files_counts = filesCounts
  if (keyOf !== null && options.rowKeyShape) query.row_key_shape = options.rowKeyShape
  return { rows: windowRows, query }
}

const deltaNumber = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0 }

/** 请求里"要我开窗口"的判据与上限（解析失败一律**如实记 note**，绝不抛错：读数据的路由不该被坏参数打崩）。 */
export const WINDOW_REQUEST_LIMITS = { pq_panels: 60, only: 40, id_chars: 60 }
/**
 * 解析请求里的分页/筛选/排序意图（**机制**；路由只做参数搬运，语义全在这一节里）：
 *   · `w=1`（或带了非空 `pq`）⇒ 开窗口；**都没有 ⇒ 整份下发**（既有调用方一字不变）；
 *   · 扁平参数 `size/page/kw/sort/bucket` = 这一页的默认查询（单面板刷新时用得上）；
 *   · `pq` = JSON `{<面板 id>: {kw, cols, sort, page, size, bucket, edits}}` —— 每块面板自己的查询；
 *   · `only` = 逗号分隔的面板 id（≤ 40）：**只回这几块**（界面改一页只重取那一块）。
 * 未知/坏值不猜：坏 JSON、坏 id 一律丢掉并记在 `notes` 里（调用方可以原样回执）。
 */
export function parseWindowRequest(params) {
  const notes = []
  const get = (name) => String(params?.get?.(name) ?? '')
  const enabled = ['1', 'true', 'yes', 'on'].includes(get('w').toLowerCase())
  const defaults = { size: get('size'), page: get('page'), kw: get('kw'), sort: get('sort'), bucket: get('bucket') }
  // 扁平参数也可以直接给列条件（`cols` = JSON `{列: 条件}`）—— 单面板对账/脚本用得上
  const rawCols = get('cols').trim()
  if (rawCols !== '') {
    try {
      const parsed = JSON.parse(rawCols)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) defaults.cols = parsed
      else notes.push('cols-not-an-object')
    } catch (err) { notes.push(`cols-invalid-json:${flat(err, 80)}`) }
  }
  const perPanel = {}
  let pqPanels = 0
  const rawPq = get('pq').trim()
  if (rawPq !== '') {
    let parsed = null
    try { parsed = JSON.parse(rawPq) } catch (err) { notes.push(`pq-invalid-json:${flat(err, 80)}`) }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [panelId, spec] of Object.entries(parsed)) {
        if (typeof panelId !== 'string' || panelId === '' || panelId.length > WINDOW_REQUEST_LIMITS.id_chars) {
          notes.push(`pq-bad-panel:${String(panelId).slice(0, 32)}`); continue
        }
        if (pqPanels >= WINDOW_REQUEST_LIMITS.pq_panels) { notes.push(`pq-over-cap:${panelId}`); continue }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { notes.push(`pq-bad-spec:${panelId}`); continue }
        perPanel[panelId] = spec
        pqPanels += 1
      }
    } else if (parsed !== null) {
      notes.push('pq-not-an-object')
    }
  }
  const only = []
  for (const raw of get('only').split(',')) {
    const id = raw.trim()
    if (id === '') continue
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) { notes.push(`only-bad-id:${id.slice(0, 32)}`); continue }
    if (only.length >= WINDOW_REQUEST_LIMITS.only) { notes.push(`only-over-cap:${id}`); continue }
    if (!only.includes(id)) only.push(id)
  }
  return { enabled: enabled || pqPanels > 0 || only.length > 0, defaults, perPanel, only, notes,
    source: { w: enabled, pq_panels: pqPanels, only: only.length } }
}

/** 机制自述（进 `/api/ui/surface`）：口径、默认值、上限、以及"没带参数就整份下发"这条兼容规则。 */
export const windowDescribe = () => ({
  schema: 'quotagent/webui-window/v1',
  shapes: Object.keys(WINDOW_FIELDS), fields: { ...WINDOW_FIELDS },
  sizes: [...WINDOW_SIZES], default_size: WINDOW_DEFAULT_SIZE, limits: { ...WINDOW_LIMITS },
  request: { window_flag: 'w=1', per_panel: 'pq=<JSON {panel_id: {kw, cols, sort, page, size, bucket, edits}}>',
    only: 'only=<面板 id 逗号分隔>', flat_defaults: 'size/page/kw/sort/bucket' },
  semantics: '窗口里的行 = 全量行 → 筛选（关键字 ∧ 每列条件 ∧ list 的桶筛选）→ 稳定全序排序 → 第 start..end 行；'
    + '`data.query.total` = 面板给的行数（`共 N`），`matched` = 筛选后的行数（`命中 M`），'
    + '`size=0` = **明确选择**的全量渲染',
  derived: '命中行集上的派生物一并给出（小计 totals / group_totals / best_when 的 mins / 枚举候选 '
    + 'enum_options / 桶计数 bucket_counts / 级别计数 level_counts / 工作台用的 head / 跨页全选 matched_keys）',
  default_full: '请求里没有 `w`/`pq`/`only` ⇒ **整份下发**（既有工具与旧客户端行为不变；界面每次都带 `w=1`）',
  why_not_client: '客户端只拿一页时自己算计数必错（`共 N`/`命中 M`/小计都在全集上），所以这些数字由服务端给、'
    + '客户端照抄；界面不再"先拿全量再截断"',
  readonly: '只读投影：不写账本、不落文件；筛选/翻页不产生任何副作用',
})

/**
 * 建外壳。
 * @param {object} options
 * @param {string} options.root 仓库根（用来找插件贡献与调用 Python 侧工具）
 * @param {string} options.prefix 路由前缀
 * @param {string[]} options.views 视图 id（shell 用 `home` + 配置里的视图）
 * @param {object} options.config webui 配置（ui_shared / rfq_delivery / ledger_* 等）
 * @param {(view: string) => object[]} options.rowsOf 本视角**公开投影后**的行（宿主只给白名单行）
 * @param {object} options.slots 旧的槽位注册表（`ui-slot.mjs`；用来嵌入插件注册的区块与撤销）
 * @param {(msg: string) => void} options.log 日志（stderr）
 * @param {string} [options.sessionsFile] 身份会话文件（**只读**：协作面用它算"本侧同事名单"）——见 `collab.mjs`
 * @param {string[]} [options.sides] 允许的侧（由身份面传入；外壳不硬编码任何侧名）
 */
export function createAppShell({ root, prefix, views, config, rowsOf, publicRowsOf, slots, services, log,
  sessionsFile = '', sides = [], ledgerStats = null }) {
  const surface = createUiSurface({ slots: slots?.slots?.() ?? [], views })
  const sharedDir = resolve(root, String(config.ui_shared ?? 'tmp/ui-shared'))
  /**
   * **同侧人类之间的协作**（指派/转交、关注、评论与 `@同事`、活动流、已读）：它是**机制**，不是业务语义 ——
   * 对象类由插件声明（`collab-ui.mjs` 按 `surface.objectKindsFor(view)` 自动挂协作面），本文件不认识任何
   * 对象类。数据落 `<ui_shared>/collab/<side>.json`（0600），**不写账本**（理由见 `collab.mjs` 文件头：
   * 写进账本会破坏审计语义，并让"人对界面的协同痕迹"变成模型可见输入）。
   */
  const collab = createCollabStore({ root, sharedDir, sessionsFile, sides, log: (msg) => log?.(msg) })
  /**
   * **人员名册与角色**（同侧成员 / 角色 / 直属关系 / 按角色限动作）：同样是**机制**，不是业务语义 ——
   * 它只存"谁在册、什么角色、额度多少、谁归谁"，并回答"这次请求能不能被执行"（只收紧、不放开）。
   * 数据落 `<ui_shared>/people/roster.json`（0600，按侧隔离），**不写账本**（理由见 `people.mjs` 文件头：
   * 名册/额度是**可改的配置**，写进账本会改变审计语义并变成模型可见输入）。
   * 它可以被后补配置（会话文件 ⇒ "今天谁登录过"；合法侧 ⇒ 名册按侧分片）。
   */
  const people = createPeopleStore({ root, sharedDir, sessionsFile, sides, log: (msg) => log?.(msg) })
  /**
   * **沙盘（演示数据）**：同样是**机制**，不是业务语义 —— 它只做一件事：把"这一侧的读/写路径"整体切到
   * 一个沙盘目录下（自己的账本、自己的待办件目录、自己的投递信封），于是**同一套动作、同一套唯一写者**
   * 在沙盘里跑出来的就是一份可看的真实流转，而**真实账本零新增**。
   *
   * 口径（判据都在这里）：
   *   · 状态落 `<ui_shared>/sandbox/state.json`（目录 0700 / 文件 **0600**、原子写、有界：身份 ≤ 32 条），
   *     按**会话身份**分条：`{<human>: {on, actors:{<side>: <演示身份名>}, seeded_at, scenario}}`。
   *   · 沙盘目录 `<ui_shared>/sandbox/<human 安全化>/`，里面有 `contractor|supplier/ledger.jsonl`、
   *     `<side>/`（待办件）、投递信封；**清空 = 删掉这个目录 + 关掉这一条的 `on`**。
   *   · 打开时 `host.config.ledger_*` / `host.sharedDir` / `host.rows()` **全部**解析到沙盘路径 ——
   *     不是"过滤掉真实数据"，而是**根本没有第二条路径**（写者的 `--ledger` 也来自同一处，所以写也只进沙盘）。
   *   · 它**不是第二条事实写路径**：动作仍走同一个动作总线、同一批唯一写者、同一张待办件目录形状；
   *     只是目录与账本路径换成了沙盘那一份。
   *   · 沙盘里的**人签**由机制生成并固定的**演示身份**发起（`actors[side]`）——外壳在跑场景时把这一步的
   *     身份替换成它；**真实面上这条替换不存在**（HTTP 请求仍只认会话身份，`signer-mismatch` 一字未改）。
   *   · 边界（如实登记，不假装）：名册/协作面（`people`/`collab` 的存储）与附件存储仍指向真实目录 ——
   *     演示场景不使用它们；沙盘动作也**不允许**改角色或传附件。
   */
  const SANDBOX_SCHEMA = 'quotagent/webui-sandbox/v1'
  const SANDBOX_MAX_ACTORS = 32
  const sandboxStateFile = join(sharedDir, 'sandbox', 'state.json')
  const safeName = (value) => String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'unknown'
  const sandboxReadState = () => {
    try {
      const doc = JSON.parse(readFileSync(sandboxStateFile, 'utf8'))
      return doc && typeof doc === 'object' && doc.actors && typeof doc.actors === 'object' ? doc : null
    } catch (err) { return null }
  }
  const sandboxWriteState = (doc) => {
    try {
      const dir = join(sharedDir, 'sandbox')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmp = join(dir, `.state.json.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, sandboxStateFile)
      return { ok: true, file: sandboxStateFile }
    } catch (err) {
      return { ok: false, code: 'sandbox-state-write-failed', reason: flat(err),
        next_action: '先修 <ui_shared>/sandbox/ 的权限（机制只落 0600）' }
    }
  }
  /** 某条沙盘状态（`on` 才有效）；没有这条 ⇒ 一个"关着的"空状态（**不写盘**）。 */
  const sandboxEntry = (human) => {
    const name = String(human ?? '')
    if (name === '') return null
    const doc = sandboxReadState()
    const entry = doc?.actors?.[name]
    if (!entry || entry.on !== true) return null
    return { on: true, human: name, owner: name, dir: sandboxDirFor(name),
      actors: entry.actors && typeof entry.actors === 'object' ? entry.actors : {},
      seeded_at: entry.seeded_at ?? '', scenario: entry.scenario ?? '' }
  }
  const sandboxDirFor = (human) => join(sharedDir, 'sandbox', safeName(human))
  /** 沙盘里两侧的路径（账本 / 待办件 / 投递信封）：**全部**在沙盘目录里，真实面一个字节都不碰。 */
  const sandboxPaths = (dir) => ({
    contractor: join(dir, 'contractor', 'ledger.jsonl'),
    supplier: join(dir, 'supplier', 'ledger.jsonl'),
    delivery: join(dir, 'contractor', '01-package.json') })
  /** 沙盘里的**有效配置**：账本与投递信封换成沙盘那一份（插件读 `host.config` 就自动跟着走）。 */
  const sandboxConfig = (dir) => ({ ...config, ui_shared: dir,
    ledger_contractor: sandboxPaths(dir).contractor, ledger_supplier: sandboxPaths(dir).supplier,
    rfq_delivery: sandboxPaths(dir).delivery })
  /** 读取沙盘账本行（沙盘账本与真实账本是**同一形状的 JSONL**：同一批写者写的）。 */
  const sandboxRows = (dir, view) => {
    const paths = sandboxPaths(dir)
    const file = view === 'supplier' ? paths.supplier : (view === 'contractor' ? paths.contractor : '')
    if (file === '' || !existsSync(file)) return []
    try {
      return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
        .map((line) => { try { return JSON.parse(line) } catch (err) { return null } }).filter(Boolean)
    } catch (err) { return [] }
  }
  /**
   * 一次请求的沙盘作用域（栈，与 `renderScopes`/`actionScopes` 同一套机制）：**入口处压栈、出口弹栈**。
   * 这样 `host.config`/`host.sharedDir`/`host.rows()`/`stage()`/`runPython()` 在整条调用链上解析到同一份路径。
   */
  const sandboxScopes = []
  const currentSandbox = () => (sandboxScopes.length ? sandboxScopes[sandboxScopes.length - 1] : null)
  const humanOf = (who) => (typeof who === 'string' ? who : String(who?.human ?? ''))
  /** 压一个沙盘作用域（`entry` 的形状见 `sandboxEntry`）；`fn` 里的一切路径解析都跟着它走。
   *  `fn` 可能返回 Promise（动作的服务端一半是 async）⇒ 弹栈要等它 settle，否则 await 之后作用域就没了。 */
  const withSandboxEntry = (entry, fn) => {
    sandboxScopes.push(entry)
    const pop = () => { const at = sandboxScopes.lastIndexOf(entry)
      if (at >= 0) sandboxScopes.splice(at, 1) }
    let out
    try { out = fn() } catch (err) { pop(); throw err }
    if (out && typeof out.then === 'function') {
      return out.then((value) => { pop(); return value }, (err) => { pop(); throw err })
    }
    pop()
    return out
  }
  const withSandbox = (who, fn) => {
    const entry = sandboxEntry(humanOf(who))
    return entry ? withSandboxEntry(entry, fn) : fn()
  }
  /** 同一次沙盘、换个**演示身份**跑（场景里的 `as`）：目录不变，只有 `ctx.identity` 与署名变。 */
  const withSandboxActor = (actorHuman, fn) => {
    const entry = currentSandbox()
    if (!entry) return fn()
    return withSandboxEntry({ ...entry, actor: actorHuman }, fn)
  }
  /** 本次调用的**有效路径与配置**：沙盘打开 ⇒ 全是沙盘那一份；否则就是真实那一份。 */
  const effective = () => {
    const entry = currentSandbox()
    if (!entry) return { on: false, dir: sharedDir, config, actors: {}, human: '' }
    return { on: true, dir: entry.dir, human: entry.owner, actor: entry.actor ?? entry.owner,
      actors: entry.actors, config: sandboxConfig(entry.dir) }
  }
  const pythonBin = DEFAULT_PYTHON
  const contributions = new Map()        // plugin_id → {module, file, entries: [{kind,id}], error}
  const actionLog = []                   // 机制层动作流水（通知中心用；有界）

  // ------------------------------------------------------------------ 机制：乐观并发的**版本库**
  /**
   * 版本库（**按侧隔离**、0600、原子写、有界、不是账本）：见文件头「乐观并发」段。
   * 单文件很小（≤ 400 个对象 × ≤ 12 条历史），读的时候按 (路径, mtime, size) 缓存 —— 面板逐行问
   * `host.versions.current(...)` 时不会把同一个文件读几十遍，但**任何一次写都立刻让缓存失效**，
   * 所以"刚保存完再看就是新版本"这件事不依赖时间窗。
   */
  const versionDirOf = () => join(effective().dir, 'webui', 'object-versions')
  const versionFileOf = (side) => join(versionDirOf(), `${safeName(String(side ?? '') || 'anon')}.json`)
  const docCache = new Map()             // path → {key, doc}
  const readDoc = (path) => {
    let key = 'missing'
    try {
      const stat = statSync(path)
      key = `${Math.round(stat.mtimeMs)}:${stat.size}`
    } catch (err) { key = 'missing' }
    const hit = docCache.get(path)
    if (hit && hit.key === key) return hit.doc
    let doc = null
    if (key !== 'missing') {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        // 只要求"是个对象"：形状（`objects` / `people`）由各自的调用方判 —— 早先这里写死了 `objects`，
        // 结果导出偏好（`people`）永远读不回来（写进去了、读出来是空）。
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed
      } catch (err) { doc = null }
    }
    docCache.set(path, { key, doc })
    return doc
  }
  /** 原子写 + 显式 chmod（不受 umask 影响）；目录 0700。 */
  const writeDocAtomic = (path, doc) => {
    try {
      const dir = join(path, '..')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, path)
      docCache.set(path, { key: 'stale', doc })
      return { ok: true, file: path }
    } catch (err) {
      return { ok: false, code: 'version-write-failed', reason: flat(err),
        next_action: '先修 <ui_shared>/webui/ 的权限（机制只落 0600）' }
    }
  }
  const versionEntries = (side) => {
    const doc = readDoc(versionFileOf(side))
    return doc && doc.objects && typeof doc.objects === 'object' ? doc.objects : {}
  }
  /** 某个对象**现在**的版本（插件把它交给界面 ⇒ 界面保存时带回来）。没有记录 ⇒ `null`。 */
  const versionCurrent = (side, objectClass, objectId) => {
    const cls = String(objectClass ?? '').trim()
    const id = String(objectId ?? '').trim()
    if (cls === '' || id === '') return null
    const entry = versionEntries(side)[versionObjectKey(cls, id)]
    if (!entry || typeof entry !== 'object') return null
    return { object_class: cls, object_id: id, rev: Number(entry.rev ?? 0),
      fingerprint: String(entry.fingerprint ?? ''), at: String(entry.at ?? ''),
      by: String(entry.by ?? ''), label: String(entry.label ?? ''), fields: entry.fields ?? {},
      // 改动历史也带上：冲突时机制要靠它算"自你那一版以来谁改了什么"（界面不需要它，内部判据需要）
      history: Array.isArray(entry.history) ? entry.history : [] }
  }
  /** 记一版（rev+1）；**内容没变就不写**（不制造版本噪声）。 */
  const versionRecord = ({ side, object_class: objectClass, object_id: objectId, fields, by, label }) => {
    const path = versionFileOf(side)
    const doc = readDoc(path) ?? { schema: VERSION_SCHEMA, side: String(side ?? ''), objects: {} }
    doc.schema = VERSION_SCHEMA
    doc.side = String(side ?? '')
    doc.objects = doc.objects && typeof doc.objects === 'object' ? doc.objects : {}
    const key = versionObjectKey(objectClass, objectId)
    const prev = doc.objects[key] ?? null
    const fingerprint = fingerprintOf(fields)
    if (prev && String(prev.fingerprint ?? '') === fingerprint) {
      return { ok: true, unchanged: true, rev: Number(prev.rev ?? 0), fingerprint }
    }
    const changed = stateDiff(prev?.fields ?? {}, fields)
    const rev = Number(prev?.rev ?? 0) + 1
    const at = new Date().toISOString()
    const history = [...(Array.isArray(prev?.history) ? prev.history : []),
      { rev, at, by: String(by ?? ''), fingerprint, changed }].slice(-VERSION_LIMITS.history)
    doc.objects[key] = { object_class: objectClass, object_id: objectId, rev, fingerprint, at,
      by: String(by ?? ''), label: String(label ?? ''), fields: normalizeState(fields), history }
    const keys = Object.keys(doc.objects)
    if (keys.length > VERSION_LIMITS.objects) {
      // 有界：按最后改动时刻丢掉最旧的那些（**如实计数**，不静默无限增长）
      const ordered = keys.sort((left, right) =>
        String(doc.objects[left]?.at ?? '').localeCompare(String(doc.objects[right]?.at ?? '')))
      doc.dropped = (Number(doc.dropped ?? 0) + ordered.length - VERSION_LIMITS.objects)
      for (const stale of ordered.slice(0, ordered.length - VERSION_LIMITS.objects)) delete doc.objects[stale]
    }
    doc.updated_at = at
    const written = writeDocAtomic(path, doc)
    return written.ok ? { ok: true, unchanged: false, rev, fingerprint, at, changed, file: written.file }
      : written
  }
  const versionsApi = {
    current: (side, objectClass, objectId) => versionCurrent(side, objectClass, objectId),
    /** 只读自述（`/api/ui/surface` 用它把"版本落在哪、有多大、不是账本"摆出来）。 */
    describe: (side) => {
      const path = versionFileOf(side)
      const doc = readDoc(path)
      const objects = doc?.objects && typeof doc.objects === 'object' ? doc.objects : {}
      const list = Object.values(objects)
      return { mechanism: '乐观并发（对象版本/指纹）：保存前比对版本，对不上就**明确拒绝**并给差异',
        file: path, mode: '0600', schema: VERSION_SCHEMA, limits: VERSION_LIMITS,
        side: String(side ?? ''), objects: list.length,
        updated_at: String(doc?.updated_at ?? ''), dropped: Number(doc?.dropped ?? 0),
        history: list.slice(0, 20).map((entry) => ({ object_class: entry.object_class,
          object_id: entry.object_id, rev: entry.rev, at: entry.at, by: entry.by, label: entry.label,
          changed: (entry.history ?? []).slice(-1).map((item) => item.changed ?? [])[0] ?? [] })),
        why_not_ledger: '版本/指纹是"谁看到过哪一版"的运营状态，不是合同事实：写进账本会改事件类型目录、'
          + '证据包哈希与审计取证语义（与协作面/名册/附件同源的理由）' }
    },
    _readDoc: readDoc, _entries: versionEntries,
  }

  // ------------------------------------------------------------------ 机制：**导出列选择**（个人偏好，0600）
  /**
   * 「导出模板可配」= 每一份导出声明有哪些列（`report.columns`），用户勾掉不要的 ⇒ **按身份**落
   * `<ui_shared>/webui/export-prefs.json`（目录 0700 / 文件 **0600**、原子写、有界：身份 ≤ 64、
   * 每身份 ≤ 24 份导出、每份 ≤ 40 列）。**不是账本**：列选择是个人看法，不是业务事实。
   * 之后**任何浏览器**导出同一份报表都按这套列走（读回同一份 0600 文件）⇒ "换浏览器仍在"。
   */
  const EXPORT_PREFS_SCHEMA = 'quotagent/export-prefs/v1'
  const EXPORT_PREFS_LIMITS = { identities: 64, reports: 24, columns: 40 }
  const exportPrefsFile = () => join(effective().dir, 'webui', 'export-prefs.json')
  const exportOwnerKey = (side, human) => `${String(side ?? '') || 'anon'}${VKEY_SEP}${String(human ?? '') || 'anonymous'}`
  const exportDoc = () => {
    const doc = readDoc(exportPrefsFile())
    return doc && doc.people && typeof doc.people === 'object'
      ? doc : { schema: EXPORT_PREFS_SCHEMA, people: {}, updated_at: '' }
  }
  const exportPrefsOf = (side, human) => {
    const doc = exportDoc()
    return doc.people[exportOwnerKey(side, human)]?.reports ?? {}
  }
  const exportPrefsGet = (side, human, reportId) => {
    const entry = exportPrefsOf(side, human)[String(reportId ?? '')] ?? null
    if (!entry || !Array.isArray(entry.columns) || entry.columns.length === 0) return null
    return { report_id: String(reportId ?? ''), columns: entry.columns.map(String),
      saved_at: String(entry.saved_at ?? ''), by: String(entry.by ?? '') }
  }
  const exportPrefsSet = ({ side, human, at, reportId, columns, clear = false }) => {
    const path = exportPrefsFile()
    const doc = exportDoc()
    doc.schema = EXPORT_PREFS_SCHEMA
    doc.people = doc.people && typeof doc.people === 'object' ? doc.people : {}
    const key = exportOwnerKey(side, human)
    const owner = doc.people[key] ?? { side: String(side ?? ''), human: String(human ?? ''), reports: {} }
    owner.reports = owner.reports && typeof owner.reports === 'object' ? owner.reports : {}
    if (clear) delete owner.reports[String(reportId ?? '')]
    else {
      owner.reports[String(reportId ?? '')] = { columns: columns.slice(0, EXPORT_PREFS_LIMITS.columns).map(String),
        saved_at: at, by: String(human ?? '') }
      const ids = Object.keys(owner.reports)
      if (ids.length > EXPORT_PREFS_LIMITS.reports) {
        const ordered = ids.sort((left, right) => String(owner.reports[left]?.saved_at ?? '')
          .localeCompare(String(owner.reports[right]?.saved_at ?? '')))
        for (const stale of ordered.slice(0, ordered.length - EXPORT_PREFS_LIMITS.reports)) delete owner.reports[stale]
      }
    }
    doc.people[key] = owner
    const owners = Object.keys(doc.people)
    if (owners.length > EXPORT_PREFS_LIMITS.identities) {
      const ordered = owners.sort((left, right) => String(doc.people[left]?.reports?.[0]?.saved_at ?? '')
        .localeCompare(String(doc.people[right]?.reports?.[0]?.saved_at ?? '')))
      doc.dropped = Number(doc.dropped ?? 0) + ordered.length - EXPORT_PREFS_LIMITS.identities
      for (const stale of ordered.slice(0, ordered.length - EXPORT_PREFS_LIMITS.identities)) delete doc.people[stale]
    }
    doc.updated_at = at
    return writeDocAtomic(path, doc)
  }
  /** 导出声明里**哪一份报表**由这个动作生成（`report.action`）。找不到 ⇒ `''`（不做列过滤）。 */
  const reportIdOfAction = (actionId) => (surface.reports()
    .find((item) => item.action === String(actionId ?? '')) ?? {}).id ?? ''
  /**
   * 把用户保存的**列选择**套到这次导出的 spec 上（外壳只按 key 过滤，不解读列的含义）：
   * 返回 `{spec, pref, available, used, dropped}`；选出来的列一个都不在 ⇒ **如实拒**（不偷偷导全表）。
   */
  const applyColumnsPref = (spec, { side, human }) => {
    const reportId = String(spec.report_id ?? '') || reportIdOfAction(spec.action_id)
    const pref = reportId === '' || !human ? null : exportPrefsGet(side, human, reportId)
    const all = Array.isArray(spec.columns) ? spec.columns : []
    const available = all.map((column) => ({ key: String(column.key), label: String(column.label ?? column.key) }))
    if (!pref) return { spec, report_id: reportId, pref: null, available,
      used: available, dropped: [], note: reportId === ''
        ? '这份导出没有声明 `report.columns`（也没有列选择偏好）⇒ 按插件给的全部列导出'
        : `没有你的列选择偏好 ⇒ 按插件给的全部列导出（在「列…」里勾掉不要的列会按你的身份存下来）` }
    const wanted = new Set(pref.columns)
    const kept = all.filter((column) => wanted.has(String(column.key)))
    const used = kept.map((column) => ({ key: String(column.key), label: String(column.label ?? column.key) }))
    const dropped = available.filter((column) => !wanted.has(column.key))
    if (!kept.length) {
      return { refused: { ok: false, code: 'report-columns-empty',
        reason: `你保存的列选择（${pref.columns.join(' / ')}）跟这份导出的列（${available.map((c) => c.key).join(' / ')}）一个都对不上`,
        next_action: '在「列…」里重选一次（或点「用全部列」清掉这套选择）：这一次什么都没有导出' },
        report_id: reportId, pref, available, used: [], dropped }
    }
    return { spec: { ...spec, columns: kept }, report_id: reportId, pref, available, used, dropped,
      note: `列选择来自**你的个人偏好**（按身份落 0600：换浏览器、换设备仍是这套列）：`
        + `导出 ${kept.length}/${all.length} 列${dropped.length ? `，跳过了 ${dropped.map((c) => c.label).join('、')}` : ''}` }
  }
  const exportPrefsApi = {
    get: (side, human, reportId) => exportPrefsGet(side, human, reportId),
    set: (payload) => exportPrefsSet(payload),
    /** 某个身份的全部偏好（机制面板与 `/api/ui/surface` 用它摆出"我选了哪些列"）。 */
    all: (side, human) => {
      const reports = exportPrefsOf(side, human)
      const out = []
      for (const [reportId, entry] of Object.entries(reports)) {
        out.push({ report_id: reportId, columns: (entry.columns ?? []).map(String),
          saved_at: String(entry.saved_at ?? ''), by: String(entry.by ?? '') })
      }
      return out.sort((left, right) => (left.report_id < right.report_id ? -1 : 1))
    },
    describe: (side, human) => ({ mechanism: '导出模板可配（列选择是**个人偏好**，按会话身份落 0600）',
      file: exportPrefsFile(), mode: '0600', schema: EXPORT_PREFS_SCHEMA, limits: EXPORT_PREFS_LIMITS,
      side: String(side ?? ''), human: String(human ?? ''), mine: exportPrefsApi.all(side, human),
      why_not_ledger: '列选择是你自己的看法，不是业务事实（写进账本会改事件类型目录与证据包哈希）' }),
  }

  /**
   * **保存前的版本比对**（机制；口径见文件头「乐观并发」段）。
   * 返回 `{pending}`（放行；`pending` 里带着"成功后要记的那一版"）或 `{refusal}`（明确拒绝 + 差异）。
   * 它**不认识任何字段的业务含义**：`state()` 由插件给，外壳只做指纹、逐字段差异与版本比较。
   */
  const versionGuard = ({ action, ctx, input }) => {
    const spec = action.concurrency
    const identity = ctx?.identity && ctx.identity.side ? ctx.identity : null
    const side = identity ? identity.side : ''
    const human = identity ? identity.human : ''
    let objectId = ''
    try {
      objectId = spec.object_id ? String(spec.object_id(ctx, input) ?? '').trim()
        : String(input?.[spec.id_field] ?? '').trim()
    } catch (err) {
      return { refusal: { ok: false, code: 'version-target-failed', action: action.id, ledger: 'zero-management',
        reason: `${spec.label}：算不出这个对象的 id（插件声明的 object_id 抛错：${flat(err)}）`,
        next_action: '修该动作的 concurrency.object_id（机制不替插件猜对象）' } }
    }
    if (objectId === '') {
      return { refusal: { ok: false, code: 'version-target-missing', action: action.id, ledger: 'zero-management',
        reason: `这个动作要保存「${spec.label}」，但入参里没有它的 id（${spec.id_field || 'object_id'}）`,
        next_action: `从列表行/对象页打开这个动作（表单会带上 id），或先填 ${spec.id_field}` } }
    }
    let fields = null
    try {
      fields = normalizeState(spec.state(ctx, input))
    } catch (err) {
      return { refusal: { ok: false, code: 'version-state-failed', action: action.id, ledger: 'zero-management',
        reason: `${spec.label}：算不出"这次保存后的状态"（插件声明的 state 抛错：${flat(err)}）`,
        next_action: '修该动作的 concurrency.state（机制不猜这次要写什么）' } }
    }
    const pending = { object_class: spec.object_class, object_id: objectId, label: spec.label,
      fields, side, by: human }
    const current = versionCurrent(side, spec.object_class, objectId)
    const expected = String(input?.[spec.expected_field] ?? '').trim()
    const fingerprint = fingerprintOf(fields)
    if (!current) return { pending, first: true }
    if (versionMatches(expected, current)) return { pending, matched: true }
    // 内容与现在**一样** ⇒ 放行（本来就没改任何东西，谈不上覆盖）
    if (fingerprint === current.fingerprint) return { pending, unchanged: true }
    const since = changesSince(expected, current)
    const mine = stateDiff(current.fields, fields)
    const who = current.by || '（未记名）'
    return { refusal: { ok: false, code: CONFLICT_CODE, action: action.id, ledger: 'zero-management',
      reason: `「${spec.label}」已经被别人改过：现在是 rev ${current.rev}，最后改动 ${who} @ ${current.at}`
        + (expected !== '' ? `；你手上那一版是 ${expected.slice(0, 23)}…`
          : '；这一次**没有带上**你看到的版本（界面没能把版本交给服务端）'),
      next_action: '刷新这一页看最新的值（差异就在下面：谁在何时把哪个字段从什么改成了什么），'
        + '确认后再保存一次 —— 界面会带上刚读到的那一版；**这一次什么都没写**',
      result: { conflict: { code: CONFLICT_CODE, object_class: spec.object_class, object_id: objectId,
        label: spec.label, expected: expected || null,
        current: { rev: current.rev, fingerprint: current.fingerprint, at: current.at, by: current.by },
        seen: since.known ? { rev: since.seen_rev, by: since.seen_by, at: since.seen_at } : null,
        since: since.since, since_known: since.known, mine, mine_count: mine.length,
        refreshed_fields: current.fields } } } }
  }
  /**
   * **只读调用缓存**（机制：同一组参数的只读工具调用在一次渲染内只 spawn 一次）+ 计数（前后可对账）。
   * 来源优先级：环境变量 `QUOTAGENT_UI_PYTHON_CACHE_MS`（用来做"开/关缓存"的对照实测）> 配置
   * `python_cache_ms` > 默认 3000ms。**0 = 关闭合并**（只读调用一律真起进程；对照用，也可在资源紧张时关掉）。
   */
  const envCacheMs = Number(process.env.QUOTAGENT_UI_PYTHON_CACHE_MS ?? '')
  const readCacheTtlMs = Number.isInteger(envCacheMs) && String(process.env.QUOTAGENT_UI_PYTHON_CACHE_MS ?? '') !== ''
    ? envCacheMs
    : (Number.isInteger(config.python_cache_ms) ? config.python_cache_ms : 3000)
  const readCacheOn = readCacheTtlMs > 0
  const readCache = new Map()            // key → {at, result}
  const ioStats = { spawns: 0, read_spawns: 0, read_hits: 0, cache_clears: 0 }
  const say = (msg) => { if (typeof log === 'function') log(`[webui-shell] ${msg}`) }

  /**
   * **渲染准入与背压**（P13）。判据不是"猜"，而是**事件循环真的卡了多久**（`perf_hooks` 的
   * `monitorEventLoopDelay`）：本进程是单线程 + 同步读盘/解析，一旦渲染的 CPU 请求量超过它的
   * 服务速率，请求就只能在队列里排着 —— P12 实测到的形态是"`/api/ui/status` 50 s 无响应、
   * 进程 100% CPU 37 分钟、只能 kill"（`tmp/p13-shots/concurrent-before.json` 里健康探针 44 s）。
   *
   * 口径（**不是**"把并发用户排成单道队列"，恰恰相反）：
   *   ① 先让渲染便宜（账本备忘 + 通知备忘）—— 这是主修；
   *   ② 万一还是过载，就**明确拒绝新到的重读请求**：429 + `Retry-After` + `code:'ui-busy'` +
   *      当场的滞后读数，界面照实说"服务端忙、多久后重试"，**而不是让所有人都挂在那里**；
   *   ③ 只对**重读**路由生效（panels/object/notifications/status）。动作（`/api/action/*`）、
   *      身份、偏好读写、健康与静态资源**一律不拒** —— 不拿"限制功能"换稳定；
   *   ④ 阈值可配可关：`config.shed_ms` / `QUOTAGENT_UI_SHED_MS`（**0 = 关闭**，默认 3000ms）。
   *      默认值下只有真过载才会触发；健康检查/对账脚本在正常服务上看到的仍是 200。
   */
  const loopDelay = monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()
  const shedEnvMs = Number(process.env.QUOTAGENT_UI_SHED_MS ?? '')
  const shedMs = String(process.env.QUOTAGENT_UI_SHED_MS ?? '') !== '' && Number.isInteger(shedEnvMs)
    ? shedEnvMs
    : (Number.isInteger(config.shed_ms) ? config.shed_ms : 3000)
  const admissionStats = { checks: 0, shed: 0, peak_lag_ms: 0, last_lag_ms: 0 }
  /**
   * 准入判定（每次调用读**并重置**直方图 ⇒ 看到的是"上一段窗口"的滞后，不是进程启动以来的最大值）。
   * `exempt:true` = 这条路不参与拒绝（动作/身份/偏好/健康）。
   */
  const admission = ({ exempt = false } = {}) => {
    const lagMs = Math.round(loopDelay.max / 1e6)
    loopDelay.reset()
    admissionStats.checks += 1
    admissionStats.last_lag_ms = lagMs
    admissionStats.peak_lag_ms = Math.max(admissionStats.peak_lag_ms, lagMs)
    if (shedMs <= 0 || exempt || !Number.isFinite(lagMs) || lagMs < shedMs) {
      return { shed: false, loop_lag_ms: lagMs, shed_ms: shedMs }
    }
    admissionStats.shed += 1
    const retryAfterMs = Math.min(10000, Math.max(500, lagMs))
    return { shed: true, loop_lag_ms: lagMs, shed_ms: shedMs, retry_after_ms: retryAfterMs,
      code: 'ui-busy', retry_after_s: Math.ceil(retryAfterMs / 1000),
      reason: `服务端正在处理上一批请求（事件循环滞后 ${lagMs}ms ≥ ${shedMs}ms）：这一条重读没有开始跑，`
        + '没有读到半份数据，也没有占用队列位置',
      next_action: `约 ${Math.ceil(retryAfterMs / 1000)} 秒后自动重试；连续被拒说明这台服务的渲染负载超过了单进程上限，`
        + '先缩小窗口（每页行数/筛选）或减少同时在线的人数' }
  }

  // ------------------------------------------------------------------ 机制：进程与代价可控的 IO
  /**
   * 跑 Python 侧工具（唯一写者或只读工具）：stdout **最后一行**必须是 JSON；rc≠0 也如实回报。
   *
   * `{read: true}`（插件声明"这一调用只读"）⇒ 同一组 `(工具, 参数)` 在 `python_cache_ms` 窗口内**只 spawn 一次**
   * （同一个进程里三块面板读同一个只读工具时，第三次不会再起第三个进程）；写入类调用**不缓存**，
   * 且任何一次 `stage()`/动作执行都会**清空缓存**（界面上的下一步不会读到旧值）。
   */
  const runPython = (toolPath, args = [], { timeoutMs = PYTHON_TIMEOUT_MS, read = false } = {}) => {
    const file = resolve(root, toolPath)
    if (!existsSync(file)) {
      return { ok: false, code: 'tool-missing', reason: `找不到工具：${toolPath}`,
        next_action: '先确认该插件已安装（工具路径写错时如实报，不猜）' }
    }
    const cacheKey = `${toolPath}\u0000${args.join('\u0000')}`
    if (read && readCacheOn) {
      const hit = readCache.get(cacheKey)
      if (hit && Date.now() - hit.at <= readCacheTtlMs) {
        ioStats.read_hits += 1
        return { ...hit.result, cached: true, cache_age_ms: Date.now() - hit.at }
      }
      const memo = renderScopes[renderScopes.length - 1]
      if (memo && memo.has(cacheKey)) {
        const shared = memo.get(cacheKey)
        ioStats.read_hits += 1
        return { ...shared, cached: true, cache_age_ms: 0, same_render: true }
      }
    }
    const started = Date.now()
    const proc = spawnSync(pythonBin, [file, ...args], { cwd: root, encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    ioStats.spawns += 1
    if (read) ioStats.read_spawns += 1
    const stdout = proc.stdout ?? ''
    const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '')
    let parsed = null
    if (lines.length) {
      try { parsed = JSON.parse(lines[lines.length - 1]) } catch (err) { parsed = null }
    }
    const result = { ok: proc.status === 0 && parsed !== null, rc: proc.status, tool: toolPath, args,
      json: parsed, stdout: flat(stdout, 4000), stderr: flat(proc.stderr, 1200), ms: Date.now() - started,
      reason: proc.error ? String(proc.error).slice(0, 200) : (parsed === null ? '工具没有输出 JSON' : '') }
    // 动作期间跑的**写者**（非只读调用）：把它的回执挂到本次动作的作用域上（退出码 + stdout JSON 是判据）
    const scope = currentActionScope()
    if (scope && !read) scope.runs.push({ tool: toolPath, receipt: writerReceipt(result) })
    if (read && result.ok && readCacheOn) {
      readCache.set(cacheKey, { at: Date.now(), result })
      const memo = renderScopes[renderScopes.length - 1]
      if (memo) memo.set(cacheKey, result)
    }
    return result
  }

  /** 清空只读缓存（任何一次可能改变事实的动作前后都调它：界面绝不读旧值）。
   *  P13：通知聚合的短 TTL 备忘**同一把开关** —— 动作/落待办件之后连它一起清，
   *  免得"点了标已读、徽标还是旧的"这类陈旧读数。 */
  const clearReadCache = () => {
    clearNotifyCache()
    if (readCache.size === 0) return
    readCache.clear()
    ioStats.cache_clears += 1
  }

  /**
   * **动作作用域**（机制）：一次动作执行期间落下的待办件 + 跑过的唯一写者回执 —— 也就是"这次动作
   * 到底写了什么"的**归属**。有了它，动作返回**之后**机制能把「写者回执」与「响应体自述」两端对账，
   * 把**可证明的**矛盾标出来（响应体里的 `writer_consistency`）：这不是第二条判据，而是同一条判据
   * （退出码 + stdout JSON）的两端核对。不重写插件的结果，只如实附证据 + 显式报矛盾。
   */
  const actionScopes = []
  const currentActionScope = () => (actionScopes.length ? actionScopes[actionScopes.length - 1] : null)

  /** 两端对账：把本动作的待办件与写者回执摆在一起，给出可核对的判词。 */
  const writerCheck = (scope, verdictOk) => {
    const staged = scope.staged.map((item) => item.name)
    const ours = { applied: [], duplicates: [], refused: [], unaccounted: [...staged] }
    for (const run of scope.runs) {
      for (const where of ['applied', 'duplicates', 'refused']) {
        for (const entry of run.receipt[where]) {
          const name = receiptFileName(entry)
          if (name === '' || !staged.includes(name)) continue
          if (!ours[where].includes(name)) ours[where].push(name)
          const index = ours.unaccounted.indexOf(name)
          if (index >= 0) ours.unaccounted.splice(index, 1)
        }
      }
    }
    const receipts = scope.runs.map((run) => receiptSummary(run.receipt, run.tool))
    const rows = receipts.reduce((sum, item) => sum + (Number(item.ledger_added) || 0), 0)
    const declaredOk = verdictOk === true
    const allReceiptsOk = scope.runs.length > 0 && scope.runs.every((run) => run.receipt.ok)
    const noReceiptOk = scope.runs.length > 0 && scope.runs.every((run) => !run.receipt.ok)
    let verdict = 'consistent'
    let note = ''
    if (!scope.runs.length) {
      verdict = 'no-writer-run'
      note = '这次动作没有跑任何唯一写者（只登记待办件或只改配置）：账本该零新增'
        + (staged.length ? `；落下待办件 ${staged.join(' / ')}（等写者消费）` : '')
    } else if (!declaredOk && ours.applied.length > 0) {
      verdict = 'fake-failure'
      note = `写者回执说本动作的待办件 ${ours.applied.join(' / ')} **真的落行了**，响应体却报失败`
        + '（用户会据此重复提交）—— 响应体的 ok/code 必须与写者回执同源'
    } else if (!declaredOk && ours.duplicates.length > 0) {
      verdict = 'fake-failure'
      note = `写者回执说本动作的待办件 ${ours.duplicates.join(' / ')} **已经在账本/归档里**（幂等：这次零新增），`
        + '响应体却报失败 —— 用户会换句话/换个对象重提，等于亲手造重复'
    } else if (!declaredOk && allReceiptsOk && rows > 0 && ours.refused.length === 0
      && ours.duplicates.length === 0) {
      verdict = 'fake-failure-suspected'
      note = `写者回执全部为成功且账本真新增了 ${rows} 行，响应体却报失败`
        + '（判据：先看写者回执里本动作那一条，再由它定 ok/code）'
    } else if (declaredOk && noReceiptOk && rows === 0 && !ours.applied.length && !ours.duplicates.length) {
      verdict = 'fake-success-suspected'
      note = '写者回执说没写成功、也没报告本动作的任何一条，响应体却报成功'
    }
    return { staged, receipts, rows_written: rows, ours, verdict, note, declared_ok: declaredOk }
  }

  /** 一次渲染的作用域（面板/状态/通知在同一批里读同一个只读工具 ⇒ 只起一个进程）。 */
  const renderScopes = []
  const withRenderScope = (fn) => {
    const memo = new Map()
    renderScopes.push(memo)
    try { return fn() } finally {
      renderScopes.pop()
      for (const [key, result] of memo) {
        if (result.ok) readCache.set(key, { at: Date.now(), result })
      }
    }
  }

  /** 落一条 0600 待办件（**宿主唯一的写面**；账本零新增，落账本归 Python 侧）。 */
  const stage = (kind, record, { name: wantedName } = {}) => {
    const dir = join(effective().dir, kind)
    const payload = { schema: PENDING_SCHEMA, kind, ...record, submitted_at: '' }
    payload.bytes = Buffer.byteLength(String(payload.note ?? ''), 'utf8')
    payload.payload_sha256 = digestOf(canonical(payload))
    // 文件名：默认 `<kind>-<sha12>.json`；插件可以给 `{name}`（**它自己的唯一写者按文件名收件**，
    // 例如 `qd-<view>-<12hex>.json`）—— 名字由插件定，机制不猜。
    const name = String(wantedName || `${kind}-${payload.payload_sha256.slice(7, 19)}.json`)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const target = join(dir, name)
      const scope = currentActionScope()
      if (scope) scope.staged.push({ kind, name, file: relative(root, target) })
      if (existsSync(target)) {
        return { ok: true, duplicate: true, kind, file: relative(root, target), path: target, name,
          record: payload }
      }
      const tmp = join(dir, `.${name}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(payload, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, target)
      clearReadCache()          // 落了一条待办件 ⇒ 只读缓存作废（下一次渲染读到的是新状态）
      return { ok: true, duplicate: false, kind, file: relative(root, target), path: target, name,
        record: payload }
    } catch (err) {
      return { ok: false, code: 'pending-write-failed', reason: flat(err),
        next_action: '先修待办件目录权限（宿主只落 0600 待办件，不改账本）' }
    }
  }

  const readJson = (path) => {
    try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')) } catch (err) { return null }
  }
  const sharedFile = (name) => join(effective().dir, name)

  /** 机制级的**内存便签**（`plugin_id` 作用域）：贡献可以记住"这次用哪组参数"，面板再读回来。
   *  它是纯机制（键值），随进程生灭、不落盘、不进账本；卸载插件时清空它的键。 */
  const notes = new Map()
  const noteStore = {
    get: (pluginId, key, fallback = null) => (notes.get(`${pluginId}\u0000${key}`) ?? fallback),
    set: (pluginId, key, value) => { notes.set(`${pluginId}\u0000${key}`, value); return value },
    drop: (pluginId) => { for (const key of [...notes.keys()]) if (key.startsWith(`${pluginId}\u0000`)) notes.delete(key) },
  }

  /** 插件贡献拿到的**机制上下文**：只有通用能力，没有任何业务语义。 */
  const host = {
    prefix, root, views,
    /** **有效配置**：沙盘打开时 `ledger_*`/`rfq_delivery`/`ui_shared` 全部指向沙盘那一份（见上面沙盘段落）。 */
    get config() { return effective().config },
    /** **有效待办件目录**（沙盘打开时是沙盘目录）：`host.stage()` 与它同源。 */
    get sharedDir() { return effective().dir },
    /** 本次身份是否在沙盘里（插件可以据此在界面上如实标注"这是演示数据"）。 */
    get sandbox() { const state = effective(); return { on: state.on, actors: state.actors,
      human: state.human, dir: state.on ? state.dir : '' } },
    now: () => new Date().toISOString(),
    /** 本视角的账本行：沙盘打开时读**沙盘账本**（同一形状的 JSONL，同一批写者写的）。 */
    rows: (view) => {
      const state = effective()
      if (state.on) return sandboxRows(state.dir, view)
      return typeof rowsOf === 'function' ? rowsOf(view) : []
    },
    publicRows: (view) => {
      const state = effective()
      if (state.on) return sandboxRows(state.dir, view)
      return typeof publicRowsOf === 'function' ? publicRowsOf(view) : []
    },
    runPython, stage, readJson, sharedFile,
    /**
     * **写者回执的单一判据**（插件用它派生 `ok`/`code`/`ledger_added`/`next_action`；见 `writerReceipt`）：
     * `host.writerReceipt(run).item({file: staged.name, draft_id})` 回答"本动作那一条在回执里是 applied、
     * duplicates 还是 refused" —— 写者一次处理多条待办件时（邮箱式写者），**绝不能**拿 `applied[0]` 当自己那条。
     */
    writerReceipt: (run) => writerReceipt(run),
    /** 回执条目指代的待办件/请求文件名（basename；没有 ⇒ 空串）。判"哪几条**不**属于本动作"时用它。 */
    receiptFileName: (entry) => receiptFileName(entry),
    /** **同侧协作**句柄（指派/转交、关注、评论与 `@同事`、活动流、已读）：机制，不认识对象类。
     *  插件可以拿它把协作挂到自己的对象上；`side`/`actor` 必须来自 `ctx.identity`（会话），不由表单给。 */
    collab,
    /** **人员名册与角色**句柄（同侧成员 / 角色 / 直属关系 / 按角色限动作）：机制，不认识业务对象。
     *  `collab` 从这里取"同事是谁"（不再靠"登录过的人"）；动作总线用它判"这次请求能不能被执行"。 */
    people,
    /** 宿主自己注入的**服务句柄**（机制：按名字取；不知道任何服务的业务含义）。 */
    service: (name) => (services && typeof services === 'object' ? services[name] : undefined) ?? null,
    services: () => Object.keys(services ?? {}),
    note: noteStore,
    /**
     * **导出/打印**（机制）：插件把"这一侧账本里的事实 + 一张表"交进来 ⇒ 拿到标准导出形状
     * （CSV 或可打印 HTML + 内容指纹），直接作为动作回执的 `result` 返回即可。
     * 外壳**不认识表里的业务**、也**不生成任何行**（谁的事实谁导出）。
     *
     * 本批多了一件事：**导出模板可配** —— 若这次动作对应的 `report` 声明了 `columns`，就按**当前会话
     * 身份**保存的**列选择偏好**（0600，跨浏览器仍在）过滤列；选出来的列一个都不在 ⇒ **如实拒**
     * （不偷偷导全表）。偏好是"你自己的看法"，**不进账本**（口径见上面导出偏好段）。
     */
    report: (spec) => {
      const scope = currentActionScope()
      const who = scope?.identity ?? null
      const applied = applyColumnsPref({ ...spec, action_id: scope?.action_id ?? '' },
        { side: who ? who.side : '', human: who ? who.human : '' })
      if (applied.refused) return applied.refused
      const built = buildReport(applied.spec, { now: host.now() })
      if (!built.ok || !built.result?.export) return built
      return { ...built, result: { ...built.result, export: { ...built.result.export,
        columns_pref: applied.pref
          ? { report_id: applied.report_id, columns: applied.pref.columns, saved_at: applied.pref.saved_at,
            by: applied.pref.by, source: 'personal-preference(0600, per identity)' }
          : null,
        columns_available: applied.available, columns_used: applied.used, columns_dropped: applied.dropped,
        columns_note: applied.note,
        columns_pref_http: `${prefix}/api/action/export.columns` } } }
    },
    /** **乐观并发**句柄（机制）：插件把"你看到的那一版"交给界面，界面保存时再带回来。
     *  `current(side, object_class, id)` ⇒ `{rev, fingerprint, at, by, label, fields}` | null。 */
    versions: {
      current: (side, objectClass, objectId) => versionCurrent(side, objectClass, objectId),
      fingerprint: (fields) => fingerprintOf(fields),
      /** 当前会话身份那一侧（插件通常直接用它，免得自己从 ctx.identity 里抄侧）。 */
      side: (ctx) => String(ctx?.identity?.side ?? ''),
      describe: () => versionsApi.describe(''),
    },
    /** **导出列选择偏好**句柄（机制）：`get(side, human, report_id)` / `all(side, human)`。 */
    exportPrefs: {
      get: (side, human, reportId) => exportPrefsGet(side, human, reportId),
      all: (side, human) => exportPrefsApi.all(side, human),
      describe: (side, human) => exportPrefsApi.describe(side, human),
    },
    log: say,
  }

  /**
   * 协作面（`collab-ui.mjs`）：把协作挂到**插件声明的对象类**上（视图/对象类都由插件声明，外壳不认识）。
   * 注册面在装载/卸载后会变 ⇒ `syncCollab()` 在每次变动后重新对账（新对象类出现就挂上，消失就撤销）。
   */
  const collabSurface = createCollabSurface({ surface, host, views: views.filter((view) => view !== 'home'),
    log: (msg) => say(msg) })
  /**
   * 名册面（`people-ui.mjs`）：把**人员名册与角色**搬上界面（面板 + 维护动作 + 状态读数）。与协作面一样是
   * 外壳自带的机制贡献：视图列表由装配方给（身份面建好之后才知道），对象类与它无关（名册不看对象）。
   */
  const peopleSurface = createPeopleSurface({ surface, host, views: views.filter((view) => view !== 'home'),
    log: (msg) => say(msg) })
  const syncPeople = () => {
    const out = peopleSurface.sync()
    if (out && out.panels !== undefined) {
      say(`名册面：视图 ${out.views.join('/') || '（无）'} · 面板 ${out.panels} 组`)
    }
    return out
  }
  const syncCollab = () => {
    const out = collabSurface.sync()
    if (out && out.object_panels !== undefined) {
      say(`协作面：视图 ${out.views.join('/') || '（无）'} · 对象类 ${out.kinds.join('/') || '（暂无）'}`
        + ` · 对象面板 ${out.object_panels} 组`)
    }
    return out
  }

  /**
   * 装配期后补：协作面需要**身份面**的两样东西（会话文件 ⇒ 本侧同事名单；合法侧 ⇒ 哪些视图是业务侧视图）。
   * 建立顺序是"外壳 → 身份面"，所以由 `webui.mjs` 在建好身份面后调用它（外壳不硬编码任何侧名）。
   */
  const configureCollab = ({ sessionsFile: file, sides: nextSides, views: nextViews } = {}) => {
    const store = collab.configure({ sessionsFile: file, sides: nextSides })
    const list = Array.isArray(nextViews) && nextViews.length
      ? nextViews.filter((view) => view !== 'home' && store.sides.includes(view)) : null
    const synced = list ? collabSurface.configure({ views: list }) : syncCollab()
    return { ok: true, sessions_file: store.sessions_file, sides: store.sides,
      views: list ?? collabSurface.viewsOf(), object_panels: synced.object_panels, kinds: synced.kinds }
  }

  /**
   * 装配期后补：名册面需要**身份面**的同两样东西（会话文件 ⇒ "今天谁登录过"；合法侧 ⇒ 名册按侧分片）。
   * 协作面也吃同一份配置（`collab.mjs` 的同一份名册句柄由 `configure` 补进去）。
   */
  const configurePeople = ({ sessionsFile: file, sides: nextSides, views: nextViews } = {}) => {
    const store = people.configure({ sessionsFile: file, sides: nextSides })
    collab.configure({ people, sides: store.sides })
    const list = Array.isArray(nextViews) && nextViews.length
      ? nextViews.filter((view) => view !== 'home' && store.sides.includes(view)) : null
    const synced = list ? peopleSurface.configure({ views: list }) : syncPeople()
    return { ok: true, sessions_file: store.sessions_file, sides: store.sides,
      views: list ?? peopleSurface.viewsOf(), panels: synced.panels }
  }

  // ------------------------------------------------------------------ 插件贡献装载（发现式：任何插件放 code/ui.mjs 就会被装载）
  const scanContributions = () => {
    const found = []
    for (const layer of ['system', 'domain']) {
      const base = join(root, 'src', layer)
      if (!existsSync(base)) continue
      for (const name of readdirSync(base).sort()) {
        const file = join(base, name, 'code', 'ui.mjs')
        if (existsSync(file)) found.push({ plugin_id: `${layer}/${name}`, file })
      }
    }
    const userspace = join(root, 'src', 'userspace')
    if (existsSync(userspace)) {
      for (const ns of readdirSync(userspace).sort()) {
        const nsDir = join(userspace, ns)
        let entries = []
        try { entries = readdirSync(nsDir).sort() } catch (err) { continue }
        if (!statSync(nsDir).isDirectory()) continue
        for (const name of entries) {
          const file = join(nsDir, name, 'code', 'ui.mjs')
          if (existsSync(file)) found.push({ plugin_id: `userspace/${ns}/${name}`, file })
        }
      }
    }
    return found
  }

  const loadContributions = async () => {
    const summary = []
    for (const item of scanContributions()) {
      const verdict = await loadOne(item)
      summary.push(verdict)
    }
    syncCollab()          // 对象类都声明完了：把协作面挂到它们上面（并撤掉已经不存在的）
    syncPeople()          // 名册面不依赖对象类，但视图列表同样以装配方给的为准
    syncExport()          // 新装载的插件可能声明了新的导出 ⇒ 把「导出模板（列选择）」面板补到那些视图上
    return summary
  }

  /** 装载/重载计数：它进 `?v=`（**唯一的模块缓存失效手段**）—— 没有它，改 `code/ui.mjs` 必须重启进程。 */
  let loadSeq = 0
  const moduleVersionOf = (file) => {
    let stamp = 0
    try { stamp = Math.round(statSync(file).mtimeMs) } catch (err) { stamp = 0 }
    return `${SURFACE_VERSION}.${stamp}.${loadSeq}`
  }

  /** 装载**一个**插件文件（`load`/`reload` 共用）：import 带 `?v=<mtime>`，装载失败有名报错，不静默吞。 */
  const loadOne = async (item) => {
    let module = null
    try {
      loadSeq += 1
      module = await import(`${item.file}?v=${moduleVersionOf(item.file)}`)
    } catch (err) {
      contributions.set(item.plugin_id, { file: item.file, error: flat(err), entries: [] })
      say(`插件贡献装载失败 ${item.plugin_id}：${flat(err)}`)
      return { plugin_id: item.plugin_id, file: item.file, ok: false, code: 'register-failed',
        reason: flat(err), next_action: '修该插件 code/ui.mjs 的语法/import（装载失败不静默吞）' }
    }
    const register = module.register ?? module.default
    if (typeof register !== 'function') {
      contributions.set(item.plugin_id, { module, file: item.file, error: 'no-register-function', entries: [] })
      return { plugin_id: item.plugin_id, file: item.file, ok: false, code: 'no-register-function',
        next_action: 'code/ui.mjs 必须导出 `register(surface, host)`' }
    }
    try {
      const verdicts = await register(surface, host, item.plugin_id)
      const refused = (Array.isArray(verdicts) ? verdicts : []).filter((row) => row && row.ok === false)
      const registered = (Array.isArray(verdicts) ? verdicts : []).filter((row) => row && row.ok === true)
      contributions.set(item.plugin_id, { module, file: item.file,
        entries: registered.map((row) => ({ kind: row.kind, id: row.id })),
        refused: refused.map((row) => ({ code: row.code, reason: row.reason })) })
      return { plugin_id: item.plugin_id, file: item.file, ok: refused.length === 0,
        registered: registered.length, refused: refused.map((row) => ({ code: row.code, reason: flat(row.reason) })) }
    } catch (err) {
      contributions.set(item.plugin_id, { module, file: item.file, error: flat(err), entries: [] })
      say(`插件贡献注册失败 ${item.plugin_id}：${flat(err)}`)
      return { plugin_id: item.plugin_id, file: item.file, ok: false, code: 'register-failed', reason: flat(err),
        next_action: '修该插件 code/ui.mjs 的 register（注册失败不静默吞）' }
    }
  }

  const fileOf = (pluginId) => (scanContributions().find((item) => item.plugin_id === pluginId) ?? {}).file ?? ''

  /**
   * **运行期装载一个插件**（`POST /api/ui/plugins/<id>/load`）。
   * 已经装载过 ⇒ 拒绝（`already-loaded`）并指向 `reload`（不静默重装：重装会先撤掉它的贡献）。
   */
  const loadPlugin = async (pluginId) => {
    // 协作面是**外壳自带的机制贡献**（`collab-ui.mjs`，不是磁盘上的插件文件）：它只有"装着/撤掉"两种状态。
    if (pluginId === PEOPLE_PLUGIN_ID) {
      const before = peopleSurface.contributions
      const synced = syncPeople()
      return { ok: true, code: before ? 'already-loaded' : 'loaded', plugin_id: pluginId,
        file: 'src/system/webui/code/people-ui.mjs', built_in: true, registered: synced.panels,
        next_action: before
          ? '名册面本来就在（外壳自带）：要撤掉用 POST .../unload，要重建用 POST .../reload'
          : '名册面已挂到各视图上（刷新页面即可看到「人员名册与角色」与维护动作）' }
    }
    if (pluginId === COLLAB_PLUGIN_ID) {
      const before = collabSurface.contributions
      const synced = syncCollab()
      return { ok: true, code: before ? 'already-loaded' : 'loaded', plugin_id: pluginId,
        file: 'src/system/webui/code/collab-ui.mjs', built_in: true, registered: synced.object_panels,
        next_action: before
          ? '协作面本来就在（外壳自带）：要撤掉用 POST .../unload，要重建用 POST .../reload'
          : '协作面已挂到所有插件声明的对象类上（刷新页面即可看到指派/关注/评论）' }
    }
    // 分享 / 导出列选择：同样是**外壳自带的机制贡献**（规则 1：可卸载、可重建）
    if (pluginId === SHARE_PLUGIN_ID || pluginId === EXPORT_PLUGIN_ID) {
      const isShare = pluginId === SHARE_PLUGIN_ID
      const before = surface.byKind('action').filter((item) => item.plugin_id === pluginId).length
      const synced = isShare ? syncShare() : syncExport()
      return { ok: true, code: before ? 'already-loaded' : 'loaded', plugin_id: pluginId, built_in: true,
        file: 'src/system/webui/code/app-shell.mjs',
        registered: synced.length || before,
        next_action: before
          ? `${isShare ? '分享' : '导出列选择'}面本来就在（外壳自带）：要撤掉用 POST .../unload，要重建用 POST .../reload`
          : `${isShare ? '分享（深链 + 邮件正文）' : '导出列选择（个人偏好）'}已挂上（刷新页面即可看到入口）` }
    }
    const item = scanContributions().find((row) => row.plugin_id === pluginId)
    if (!item) {
      return { ok: false, code: 'plugin-not-found', plugin_id: pluginId,
        next_action: '磁盘上没有这个插件的 code/ui.mjs：先在 `src/<层>/<名>/code/ui.mjs` 写它的 register' }
    }
    const known = contributions.get(pluginId)
    if (known && known.entries && known.entries.length && known.unloaded !== true) {
      return { ok: false, code: 'already-loaded', plugin_id: pluginId, file: relative(root, item.file),
        next_action: `它已经在界面上：要让它重读磁盘上的新代码，用 reload（POST ${prefix}/api/ui/plugins/${encodeURIComponent(pluginId)}/reload）` }
    }
    const started = Date.now()
    const verdict = await loadOne(item)
    clearReadCache()               // 新贡献可能带来新的只读读取：缓存一律作废
    syncCollab()                   // 它可能声明了新的对象类 ⇒ 协作面跟着长出来
    syncExport()                   // 也可能声明了新的导出 ⇒ 「导出模板（列选择）」面板跟着长出来
    return { ok: verdict.ok === true, code: verdict.ok ? 'loaded' : (verdict.code ?? 'register-failed'),
      plugin_id: pluginId, file: relative(root, item.file), ms: Date.now() - started,
      registered: verdict.registered ?? 0, refused: verdict.refused ?? [], reason: verdict.reason ?? null,
      next_action: verdict.ok
        ? `它的视图/面板/动作/快捷键已出现在界面上（刷新页面即可看到）；要撤销用 POST ${prefix}/api/ui/plugins/${encodeURIComponent(pluginId)}/unload`
        : (verdict.next_action ?? '看 reason 定位（装载失败时界面不变）') }
  }

  /**
   * **热重载一个插件**：撤销它的全部贡献 → 按磁盘上的**当前**内容重新 import（`?v=<mtime>`）→ 重新注册。
   * 这是"改 `code/ui.mjs` 不用重启进程"的那条路；**不改**其它插件的任何贡献。
   */
  const reloadPlugin = async (pluginId) => {
    // 协作面（外壳自带）：reload = 撤掉它的全部贡献后按当前代码重建（并重新挂到最新声明的对象类上）。
    if (pluginId === PEOPLE_PLUGIN_ID) {
      peopleSurface.dispose()
      const synced = syncPeople()
      return { ok: true, code: 'reloaded', plugin_id: pluginId, built_in: true,
        file: 'src/system/webui/code/people-ui.mjs', module_version: `people.${Date.now()}`,
        registered: synced.panels,
        next_action: '名册面已重建（「人员名册与角色」+ 维护动作都在）；'
          + '名册**数据**不受影响（它落在 <ui_shared>/people/ 下的 0600 文件里，不是贡献）' }
    }
    if (pluginId === COLLAB_PLUGIN_ID) {
      collabSurface.dispose()
      const synced = syncCollab()
      return { ok: true, code: 'reloaded', plugin_id: pluginId, built_in: true,
        file: 'src/system/webui/code/collab-ui.mjs', module_version: `collab.${Date.now()}`,
        registered: synced.object_panels,
        next_action: '协作面已重建（指派/关注/评论/@同事 与「我的 / 我指派的 / 全部」筛选都在）；'
          + '协作**数据**不受影响（它落在 <ui_shared>/collab/ 下的 0600 文件里，不是贡献）' }
    }
    // 分享 / 导出列选择：reload = 撤掉贡献后按当前代码重建（导出面板要一并清账，否则重建不出来）
    if (pluginId === SHARE_PLUGIN_ID || pluginId === EXPORT_PLUGIN_ID) {
      const isShare = pluginId === SHARE_PLUGIN_ID
      if (!isShare) exportPanelViews.clear()
      const removed = unload(pluginId)
      const synced = isShare ? syncShare() : syncExport()
      return { ok: true, code: 'reloaded', plugin_id: pluginId, built_in: true,
        file: 'src/system/webui/code/app-shell.mjs', module_version: `mechanism.${Date.now()}`,
        removed: removed.count, registered: synced.length,
        next_action: `${isShare ? '分享面' : '导出列选择面'}已重建；`
          + `${isShare ? '分享不落任何东西（它只拼文字）' : '列选择**数据**不受影响（它落在 <ui_shared>/webui/export-prefs.json 里）'}` }
    }
    const item = scanContributions().find((row) => row.plugin_id === pluginId)
    if (!item) {
      return { ok: false, code: 'plugin-not-found', plugin_id: pluginId,
        next_action: '磁盘上没有这个插件的 code/ui.mjs（先写它，再用 load）' }
    }
    const before = contributions.get(pluginId) ?? { entries: [] }
    const removed = unload(pluginId)
    const started = Date.now()
    const verdict = await loadOne(item)
    clearReadCache()
    syncCollab()                   // 重载可能改了它声明的对象类
    syncExport()                   // 也可能改了它声明的导出 ⇒ 面板跟着对账
    let mtime = null
    try { mtime = new Date(statSync(item.file).mtimeMs).toISOString() } catch (err) { mtime = null }
    return { ok: verdict.ok === true, code: verdict.ok ? 'reloaded' : (verdict.code ?? 'register-failed'),
      plugin_id: pluginId, file: relative(root, item.file), mtime, module_version: moduleVersionOf(item.file),
      ms: Date.now() - started, removed: removed.count, was: (before.entries ?? []).length,
      registered: verdict.registered ?? 0, refused: verdict.refused ?? [], reason: verdict.reason ?? null,
      next_action: verdict.ok
        ? '新代码已在**同一个进程**里生效：刷新页面即可看到新贡献（进程没有重启，其它插件的贡献一项未动）'
        : (verdict.next_action ?? '看 reason 定位（装载失败时该插件的贡献保持**已撤销**状态，页面上会少东西）') }
  }

  /** 插件装载清单（`GET /api/ui/plugins`）：谁在磁盘上、装载没装载、mtime 多少。 */
  const pluginsJson = () => ({
    ok: true, prefix,
    plugins: [...scanContributions().map((item) => {
      const known = contributions.get(item.plugin_id) ?? {}
      let mtime = null
      try { mtime = new Date(statSync(item.file).mtimeMs).toISOString() } catch (err) { mtime = null }
      return { plugin_id: item.plugin_id, file: relative(root, item.file), mtime,
        loaded: Array.isArray(known.entries) && known.entries.length > 0 && known.unloaded !== true,
        contributions: known.entries ?? [], refused: known.refused ?? [], error: known.error ?? null }
    }), {
      // 外壳自带的**协作面**（不是磁盘上的插件文件）：一样列在这里，一样可卸载/重建（规则 1）
      plugin_id: COLLAB_PLUGIN_ID, file: 'src/system/webui/code/collab-ui.mjs', built_in: true,
      mtime: null, loaded: collabSurface.contributions > 0,
      contributions: surface.byKind('action').filter((item) => item.plugin_id === COLLAB_PLUGIN_ID)
        .map((item) => ({ kind: 'action', id: item.id, title: item.title }))
        .concat(surface.byKind('panel').filter((item) => item.plugin_id === COLLAB_PLUGIN_ID)
          .map((item) => ({ kind: 'panel', id: item.id, title: item.title }))),
      refused: [], error: null,
      note: '同侧协作（指派/转交、关注、评论与 @同事、活动流、我的/我指派的/全部）：外壳自带的机制贡献',
    }, {
      // 外壳自带的**名册/角色面**（同样不是磁盘上的插件文件）：一样列在这里，一样可卸载/重建（规则 1）
      plugin_id: PEOPLE_PLUGIN_ID, file: 'src/system/webui/code/people-ui.mjs', built_in: true,
      mtime: null, loaded: peopleSurface.contributions > 0,
      contributions: surface.byKind('action').filter((item) => item.plugin_id === PEOPLE_PLUGIN_ID)
        .map((item) => ({ kind: 'action', id: item.id, title: item.title }))
        .concat(surface.byKind('panel').filter((item) => item.plugin_id === PEOPLE_PLUGIN_ID)
          .map((item) => ({ kind: 'panel', id: item.id, title: item.title }))),
      refused: [], error: null,
      note: '人员名册与角色（同侧成员 / 角色 / 直属关系 / 按角色限动作）：外壳自带的机制贡献',
    }, {
      // 外壳自带的**分享面**（同样不是磁盘上的插件文件）：一样可卸载/重建（规则 1）
      plugin_id: SHARE_PLUGIN_ID, file: 'src/system/webui/code/app-shell.mjs#share', built_in: true,
      mtime: null, loaded: surface.byKind('action').some((item) => item.plugin_id === SHARE_PLUGIN_ID
        && item.id === 'share.object'),
      contributions: surface.byKind('action').filter((item) => item.plugin_id === SHARE_PLUGIN_ID)
        .map((item) => ({ kind: 'action', id: item.id, title: item.title })),
      refused: [], error: null,
      note: '分享（可复制深链 + 对方需要什么身份/侧 + 可粘贴的邮件正文）：外壳自带的机制贡献；'
        + '它不写账本、不落文件、不发邮件',
    }, {
      // 外壳自带的**导出列选择面**（个人偏好，0600）：一样可卸载/重建（规则 1）
      plugin_id: EXPORT_PLUGIN_ID, file: 'src/system/webui/code/app-shell.mjs#export', built_in: true,
      mtime: null, loaded: surface.byKind('action').some((item) => item.plugin_id === EXPORT_PLUGIN_ID
        && item.id === 'export.columns'),
      contributions: surface.byKind('action').filter((item) => item.plugin_id === EXPORT_PLUGIN_ID)
        .map((item) => ({ kind: 'action', id: item.id, title: item.title }))
        .concat(surface.byKind('panel').filter((item) => item.plugin_id === EXPORT_PLUGIN_ID)
          .map((item) => ({ kind: 'panel', id: item.id, title: item.title }))),
      refused: [], error: null,
      note: '导出模板可配（列选择是**个人偏好**，按会话身份落 0600 ⇒ 换浏览器/换设备仍在）：外壳自带的机制贡献；'
        + '导出**内容**仍由声明它的插件自己生成',
    }],
    mechanism: '装载面是**机制**：按磁盘上的 `code/ui.mjs` 发现式装载；`reload` = 撤掉这个插件的全部贡献后按'
      + '当前文件内容重新 import（带 ?v=<mtime> 击穿模块缓存）⇒ 改插件 UI 不必重启进程。'
      + '卸载后它的视图/面板/动作/快捷键/通知源/状态项一起消失（AGENTS.md 规则 1）；'
      + '标了 `built_in` 的那两条（协作面 / 名册面）是外壳自己的贡献，同样可卸载/重建',
    next_action: `POST ${prefix}/api/ui/plugins/<plugin_id>/reload 让磁盘上的新代码在**当前进程**里生效`,
  })

  // ------------------------------------------------------------------ 渲染：面板 / 通知 / 状态
  /** 当前地址（**对象深链** `/app/<view>/<kind>/<id>`）：插件从 `ctx.route` 才知道"现在要看哪一个对象"。 */
  const normRoute = (route) => ({ view: String(route?.view ?? 'home'), panel: String(route?.panel ?? ''),
    kind: String(route?.kind ?? ''), id: String(route?.id ?? '') })

  /**
   * **会话身份**（机制）：只有"这次请求是谁"这一件事，没有任何业务含义。侧与 `human:<名字>` 都来自服务端
   * 会话（cookie 解析在身份面），**不由**请求体/表单决定 ⇒ 协作类贡献拿到的永远是同一个侧的人。
   */
  const normIdentity = (who) => {
    if (!who || who.ok !== true) return null
    const human = String(who.human ?? '')
    const side = String(who.side ?? '')
    if (human === '' || side === '') return null
    return { human, name: String(who.name ?? ''), side }
  }

  const panelCtx = (view, route = { view }, who = null) => {
    const normalized = normRoute({ ...route, view })
    return { view: normalized.view, route: normalized, host, now: host.now(), rows: host.rows(normalized.view),
      identity: normIdentity(who),
      panels: surface.panelsOf(normalized.view).map((panel) => panel.id),
      actions: surface.byKind('action').map((action) => action.id) }
  }

  /**
   * 面板声明的列（服务端窗口按它判筛型）。面板自己给了 `columns` 就用它；没给就按**客户端同一套**合成：
   * `list` ⇒ title/body/next_action，`kv` ⇒ key/value，`files` ⇒ 客户端 `renderFiles` 那六列（**必须逐字对齐**，
   * 否则"数值列给区间、枚举列给下拉"在服务端会判成文本包含 —— 同一份数据两边算出的命中数就不一样了）。
   */
  const windowColumns = (data, kind) => {
    if (Array.isArray(data.columns) && data.columns.length) return data.columns
    if (kind === 'list') return [{ key: 'title', label: '标题' }, { key: 'body', label: '详情' },
      { key: 'next_action', label: '下一步' }]
    if (kind === 'kv') return [{ key: 'key', label: '键' }, { key: 'value', label: '值' }]
    if (kind === 'files') return [{ key: 'name', label: '文件名' }, { key: 'uploader', label: '上传人' },
      { key: 'at', label: '时间' }, { key: 'sha256', label: 'sha256', filter: 'text' },
      { key: 'visibility_label', label: '给谁看', filter: 'enum' }, { key: 'bytes', label: '大小', filter: 'number' }]
    return []
  }
  /**
   * 把一块面板的**全量行**换成**服务端窗口**（机制）：窗口里的行 + `data.query`（全集上的数字）。
   * 形状没有行数组（`metrics`/`form`/`html`）⇒ 返回 `null`（调用方原样下发，**不假装**分页）。
   */
  const windowize = (data, kind, panel, spec, tally) => {
    const field = WINDOW_FIELDS[kind]
    if (!field) return null
    const rows = Array.isArray(data[field]) ? data[field] : null
    if (!rows) return null
    const columns = windowColumns(data, kind)
    const per = (spec.perPanel && spec.perPanel[panel.id]) || {}
    const clean = normalizeWindowSpec({ ...spec.defaults, ...per }, columns)
    // 对比模式（`data.compare`）：每组一列的合计也在**命中行集**上算（同一节理由）
    const groups = []
    if (data.compare && Array.isArray(data.columns)) {
      for (const column of data.columns) {
        if (!column.group) continue
        const id = String(column.group)
        if (groups.some((item) => item.id === id)) continue
        groups.push({ id, label: String(column.group_label || id) })
      }
    }
    const out = windowPanelData({ field, columns, rows, spec: clean, options: { kind,
      totals: data.totals, groupTotals: data.group_totals, allColumns: data.columns || columns, groups,
      levels: kind === 'list' || kind === 'kv', filesCounts: kind === 'files',
      wantKeys: per.keys === true || per.keys === '1' } })
    tally.full += rows.length
    tally.sent += out.rows.length
    tally.windowed += 1
    tally.shapes[kind] = (tally.shapes[kind] || 0) + 1
    return { ...data, [field]: out.rows, rows_total: rows.length, query: out.query,
      query_note: '这一页的行由**服务端**按窗口给（筛选/排序/分页都在全集上算，数字在 `data.query` 里）：'
        + '客户端**照抄**这些计数与行序，不再自己截断。形状没有行数组的面板原样下发。' }
  }

  /**
   * 条目上的**跨面板去重键**（机制，不透明串）：插件声明"这一条讲的是哪个对象/哪个门"。
   * 外壳不解读它的内容（`gate:ap-…` 与 `foo:1` 对它没有区别），只拿它当"是不是同一件事"的判据。
   */
  const normDedupeKey = (value) => {
    const key = String(value ?? '').trim()
    return key === '' || key.length > 160 ? '' : key
  }

  /**
   * **跨面板去重**（机制，0 业务语义）—— 判据由插件给，合并规则由外壳定。
   *
   * 为什么有这一条：同一件事可以被两块面板各列一次（本批实测：`system/approval#gate.todo` 与
   * `domain/commitments#home.gates` 把**同一批人工门**各列一遍 ⇒ 本侧「有 N 件需要你处理」里
   * 2404 条中有 1200 条是重复占位）。重复占位不是"多给点信息"，它让计数说谎：用户以为有两倍的门要批。
   *
   * 判据与边界（都不认识任何领域概念）：
   *   · 条目的 `dedupe_key` 非空时才参与（插件显式声明）；键相同 ⇒ 认作同一件事；
   *   · **只跨面板**（`panel_id` 不同）：同一块面板内部的重复是那个插件自己的事，外壳不动；
   *   · 先出现的赢（面板按 `order` 排过序 ⇒ "更该由谁来说这件事"由插件用顺序表达）；
   *   · 输的那条**不丢信息**：`merged_count` + `also_from[{panel_id,plugin_id}]` 写在赢的那条上
   *     （界面上照实说"另有 N 块面板也列了它"），级别取更急的一档、缺的 `ref`/`action`/`bucket`/
   *     `preset`/`label` 补上 ⇒ **合并后仍然能点进对象页、仍然能一键发起那个动作**。
   */
  const foldPanelDuplicates = (entries, tally) => {
    const seen = new Map()
    for (const entry of entries) {
      if (entry.error || entry.visible === false || entry.kind !== 'list') continue
      const items = Array.isArray(entry.raw?.items) ? entry.raw.items : null
      if (!items) continue
      const kept = []
      for (const item of items) {
        const key = item && typeof item === 'object' && !Array.isArray(item) ? normDedupeKey(item.dedupe_key) : ''
        const prev = key === '' ? null : seen.get(key)
        if (!prev || prev.panel_id === entry.panel.id) {
          kept.push(item)
          if (key) seen.set(key, { panel_id: entry.panel.id, plugin_id: entry.panel.plugin_id, item })
          continue
        }
        const rank = (value) => WINDOW_LEVEL_RANK[String(value ?? 'info')] ?? WINDOW_LEVEL_RANK.info
        const winner = prev.item
        winner.merged_count = (winner.merged_count || 1) + 1
        winner.also_from = [...(winner.also_from || []),
          { panel_id: entry.panel.id, plugin_id: entry.panel.plugin_id }]
        if (rank(item.level) < rank(winner.level)) winner.level = item.level
        for (const field of ['ref', 'action', 'bucket', 'bucket_label', 'preset', 'label']) {
          if (!winner[field] && item[field]) winner[field] = item[field]
        }
        tally.deduped += 1
      }
      if (kept.length !== items.length) {
        const merged = items.length - kept.length
        entry.raw.items = kept
        entry.raw.deduped = merged
        entry.raw.dedupe_note = `跨面板去重：${merged} 条与别块面板列的是同一件事（同一个 \`dedupe_key\`），`
          + '已合并成一条 —— 计数按合并后算；合并后的条目仍可点进对象页'
        tally.dedupe_panels += 1
      }
    }
  }

  /**
   * 某视图上面板的数据。
   * `route.kind` 非空 ⇒ **对象页**：只渲染声明了该 `object_kind` 的面板（其余面板在这一页上不出现），
   * 且 `ctx.route` 带上 `kind/id` 供插件渲染那一个对象；没声明过该对象类 ⇒ 返回空数组（调用方报未命中）。
   * `who` = 本次请求的会话（可选；插件从 `ctx.identity` 拿"同侧人类之间"的协作身份与侧）。
   * `windowSpec`（可选；**服务端窗口**，见本文件顶部那一节）= `{ enabled, defaults, perPanel, only }`：
   *   · `enabled` 由请求里的 `w`/`pq` 给（**没有就整份下发**，既有调用方一字不变）；
   *   · 每块面板的有效查询 = `{...defaults, ...perPanel[面板 id]}`；`only` 非空 ⇒ 只回这些面板
   *     （界面改一页/改一次筛选只重取那一块，别的面板不重复下发）。
   */
  const panelsOf = (view, route = {}, who = null, windowSpec = null) => withSandbox(who, () => {
    const normalized = normRoute({ ...route, view })
    const requested = normalized.kind === '' ? surface.panelsFor(view, '')
      : surface.panelsFor(view, normalized.kind)
    const only = Array.isArray(windowSpec?.only) && windowSpec.only.length ? new Set(windowSpec.only) : null
    const picked = only ? requested.filter((panel) => only.has(panel.id)) : requested
    const ctx = panelCtx(view, normalized, who)
    // **这一次渲染付出了多少代价**（机制读数，供"前后可对账"）：Python 进程数只看**这一次请求**的增量。
    // 为什么放在这里：`/api/ui/panels` 是一次渲染的唯一起点（webui.mjs 里那一行只调这一个函数），
    // 所以在这里量到的增量就是"打开这一页起了几个进程"，不必改任何路由代码。
    const before = { spawns: ioStats.spawns, read: ioStats.read_spawns, hits: ioStats.read_hits, at: Date.now() }
    // 这一次渲染的**载荷口径**（前后对比用的就是这几个数：面板给了多少行 vs 真下发多少行）
    const tally = { full: 0, sent: 0, windowed: 0, shapes: {}, deduped: 0, dedupe_panels: 0 }
    // 一次渲染的作用域：这一页上的多块面板读同一个只读工具时**只起一个进程**（缓存见 `runPython`）。
    // **① 先算 `data()`、先不开窗口**：跨面板去重（②）必须在**面板给的全量条目**上做，③ 才逐块开窗口
    // —— 否则窗口里的那一页是先于去重的，计数里仍然带着 2× 的重复。
    const prepared = withRenderScope(() => picked.map((panel) => {
      const base = { id: panel.id, title: panel.title, plugin_id: panel.plugin_id, order: panel.order,
        panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, hint: panel.hint,
        object_kind: panel.object_kind, wide: panel.placement === 'wide' }
      try {
        if (panel.when && panel.when(ctx) !== true) return { panel, base, visible: false, data: null }
      } catch (err) {
        return { panel, base, visible: true, error: { code: 'when-failed', reason: flat(err) },
          next_action: '修面板的 when（可见性条件抛错时不渲染该面板，但如实报错）' }
      }
      try {
        const data = panel.data(ctx)
        if (!data || typeof data !== 'object') {
          return { panel, base, visible: true, error: { code: 'invalid-data', reason: 'data() 没有返回对象' } }
        }
        const kind = data.kind ?? panel.panel_kind
        if (!PANEL_KINDS.includes(kind)) {
          return { panel, base, visible: true, error: { code: 'unknown-panel-kind', reason: `kind=${kind}` } }
        }
        return { panel, base, visible: true, kind, raw: data }
      } catch (err) {
        return { panel, base, visible: true, error: { code: 'data-failed', reason: flat(err) },
          next_action: '修面板的 data()（抛错不静默吞：这块不渲染，页面其余部分照常）' }
      }
    }))
    // ② **跨面板去重**（机制）：同一件事（同一个对象/门）被两块面板各列一次 ⇒ 合并成一条。
    foldPanelDuplicates(prepared, tally)
    // ③ 每块面板各自的**服务端窗口**（机制）：只换"这一页看到的行"，并把在**去重后的全集**上算出来的
    // 数字一起给（`data.query`）；形状没有行数组（metrics/form/html）⇒ 原样返回，不假装分页。
    const rows = prepared.map((entry) => {
      if (entry.error) {
        return { ...entry.base, visible: true, error: entry.error, next_action: entry.next_action }
      }
      if (entry.visible === false || !entry.raw) return { ...entry.base, visible: false, data: null }
      const { panel, base, kind } = entry
      const data = entry.raw
      try {
        const windowed = windowSpec?.enabled === true ? windowize(data, kind, panel, windowSpec, tally) : null
        const out = windowed || data
        // `files` 面板的**地址纪律**（机制，与 `suggest_url` 同一口径）：下载地址与上传地址只允许**本服务
        // 前缀相对路径**（`/` 开头）—— 外站地址一律丢掉并如实计数（界面不会被引去第三方取/传文件）。
        if (kind === 'files') {
          const bad = []
          const files = (Array.isArray(out.files) ? out.files : []).filter((row) => {
            const keep = Boolean(row) && typeof row === 'object' && String(row.url ?? '').startsWith('/')
            if (!keep) bad.push(String(row?.url ?? row?.name ?? '(无地址)'))
            return keep
          })
          const upload = out.upload && typeof out.upload === 'object' && String(out.upload.url ?? '').startsWith('/')
            ? out.upload : null
          if (!upload && out.upload) bad.push(String(out.upload.url ?? '(无上传地址)'))
          return { ...base, visible: true, degraded: out.degraded === true || bad.length > 0,
            reason: bad.length ? `absolute-url-refused:${bad.length}` : (out.reason ?? null),
            data: { ...out, kind, files, upload, refused_urls: bad.length,
              plugin_id: panel.plugin_id, panel_id: panel.id } }
        }
        return { ...base, visible: true, degraded: out.degraded === true, reason: out.reason ?? null,
          data: { ...out, kind, plugin_id: panel.plugin_id, panel_id: panel.id } }
      } catch (err) {
        return { ...base, visible: true, error: { code: 'data-failed', reason: flat(err) },
          next_action: '修面板的 data()（抛错不静默吞：这块不渲染，页面其余部分照常）' }
      }
    }).sort((left, right) => (left.order - right.order) || (left.id < right.id ? -1 : 1))
    // 收口这次渲染的代价读数（`/api/ui/surface` 的 `io.last_render` 与状态栏都读它；只为可对账，不影响结果）
    ioStats.last_render = { at: host.now(), view, kind: normalized.kind, panels: rows.length,
      spawns: ioStats.spawns - before.spawns, read_spawns: ioStats.read_spawns - before.read,
      read_cache_hits: ioStats.read_hits - before.hits, ms: Date.now() - before.at,
      rows_full: tally.full, rows_sent: tally.sent, windowed_panels: tally.windowed,
      // **跨面板去重**的读数（只为可对账）：合并掉几条、涉及几块面板
      deduped: tally.deduped, dedupe_panels: tally.dedupe_panels,
      only: only ? [...only] : [], shapes: tally.shapes }
    return rows
  })

  /**
   * **对象页的整份数据**（`GET /api/ui/object?view=&kind=&id=`）：外壳只做机制 —— 找出"谁负责这个对象类"、
   * 把它声明的 `data.object` 页头（标题/摘要/事实/链接）按通用形状摊平、附上该对象类的动作与可用对象类清单。
   * 没有任何插件声明这个对象类 ⇒ `found:false` + 有名 reason + 下一步（**不编内容**）。
   */
  const objectOf = (view, kind, id, who = null, windowSpec = null) => {
    const kinds = surface.objectKindsFor(view)
    const claimed = kinds.includes(kind)
    const panels = claimed ? panelsOf(view, { view, kind, id }, who, windowSpec) : []
    const header = panels.map((panel) => (panel.data ?? {}).object).find((item) => item && typeof item === 'object')
      ?? null
    const found = claimed && panels.length > 0 && (header ? header.found !== false : true)
    // **导出 / 打印**（机制）：只摆出该对象类上被声明过的导出（`report` 贡献），并给出每个格式的入口 ——
    // 外壳不知道这些格式里是什么内容：点按钮就是打开那个动作并把 `format` 预填好。
    const reports = (found ? surface.reportsFor(view, kind) : []).filter((item) => surface.findAction(item.action))
      .map((item) => ({ id: item.id, title: item.title, plugin_id: item.plugin_id, action: item.action,
        formats: item.formats, columns: item.columns, hint: item.hint, order: item.order }))
    return {
      ok: true, view, kind, id, found,
      title: header?.title ?? (claimed ? `${kind} ${id}` : `${kind}（本视图没有这种对象）`),
      subtitle: header?.subtitle ?? '', facts: Array.isArray(header?.facts) ? header.facts : [],
      links: Array.isArray(header?.links) ? header.links : [],
      // **乐观并发**：插件在 `data.object.version` 里给出"你打开这一页时看到的版本" ⇒ 界面保存时带回
      // 去（`expected_version`）。机制只搬运，不解读；没给 ⇒ 界面按"没看过"处理（服务端安全默认）。
      version: header?.version && typeof header.version === 'object' ? header.version : null,
      // **分享**：插件在 `data.object.share` 里声明"对方能不能看 / 从哪个视图看得到 / 要什么前提"
      //（机制据此拼分享弹层；不声明就如实说"插件没声明，无法断言对方能不能看"）。
      share: header?.share && typeof header.share === 'object' ? header.share : null,
      reason: found ? '' : (header?.reason ?? (claimed ? 'object-not-found' : 'object-kind-not-registered')),
      next_action: found ? '' : (header?.next_action ?? (claimed
        ? '这个 id 不在本视图的投影里：换成列表里真实存在的 id（列表里每一行的 id 就是它的深链）'
        : `本视图可打开的对象类：${kinds.join(' / ') || '（一个都没有：还没有插件声明 object_kind）'}`
          + `；也可以回到 ${prefix}/app/${view}/ 看列表`)),
      kinds, panels, reports,
      reports_note: '导出/打印是**声明**（`report` 贡献）：每个格式一个按钮 = 打开声明的动作并把 format 预填好；'
        + '内容由那个插件自己的服务端一半生成（外壳不生成、不解读内容）',
      actions: surface.actionsFor(view, kind).map((action) => action.id),
      deep_link: `${prefix}/app/${view}/${kind}/${id}/`,
      mechanism: '对象页是**机制**：外壳按插件声明的 `object_kind` 找面板、把面板给的 `data.object` 摊成页头；'
        + '外壳不认识任何具体对象类',
    }
  }

  /**
   * 通知源里**可跳转的对象引用**的规范化（机制，不认识任何对象类）：
   * 插件给的 `ref` 只有形如 `{kind, id[, view, title]}` 才被保留（`kind`/`id` 都是非空串）；
   * 其它形状（裸 id、任意回执对象）一律丢成 `null` —— 免得界面上出现一条点不动的"假深链"。
   */
  const normRef = (ref) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null
    const kind = String(ref.kind ?? '').trim()
    const id = String(ref.id ?? '').trim()
    if (kind === '' || id === '') return null
    const view = String(ref.view ?? '').trim()
    return { kind, id, view: views.includes(view) ? view : '', title: String(ref.title ?? '').trim() }
  }

  /**
   * 通知源给的**标签**（机制：只搬运，不解读）：用来在通知中心做「我的 / 我指派的 / …」这类筛选片。
   * 形状约束在这里：最多 6 个、每个 ≤ 24 字符、非空字符串 —— 界面上不会出现一条点不动/看不懂的筛选。
   */
  const normTags = (value) => (Array.isArray(value) ? value.map((item) => String(item ?? '').trim())
    .filter((item) => item !== '').slice(0, 6).map((item) => item.slice(0, 24)) : [])

  /**
   * 通知**在所有来源之间公平分配名额**（机制，0 业务语义；口径见 `docs/design/29-webui-gui-app.md`
   * 的可用性节与 `src/system/webui/docs/scale-and-performance.md` §5）。
   *
   * 修前的口径是 `items.slice(0, 200)`：来源按注册顺序往后接，**一个来源给出几百条时，后面的来源
   * 整体看不到**（实测：规模数据下 400 个待批人工门把 200 个名额吃光，报价/包/变更的通知一条都进不来）。
   * 现在的口径是：
   *   · 每个来源**轮转取一条**（round-robin），谁也不会被别的来源挤掉；
   *   · 同一件事（**同一个 `id`**）被多个来源各报一次 ⇒ 合并成一条（`count` = ×N、`plugins` = 谁报的、
   *     级别取更急的一档）—— 这一条以前在客户端做（`notifList()`），现在必须在服务端做，
   *     否则「同一件事只出一条」这条承诺在服务端分页下就失效了；
   *   · **全部产出都能翻到**：不带窗口的旧调用（脚本/老客户端）仍按 `NOTIF_CAP` 截断并如实记账
   *     （`returned`/`cap`/`dropped`）；界面走的是**通知窗口**（`w=1` + `pq.notify`）——
   *     服务端在全量条目上筛选→排序→分页、**只回这一页**，同时把在全集上算出来的数字一并给出
   *     ⇒ 界面上能如实写「共 N 条 · 已显示 N · 剩余 M」，并且真能一页页翻到头（不是前 600 条的切片）。
   */
  const NOTIF_CAP = 600
  /** 通知窗口在 `pq` 里的块 id（与面板同一套机制；`pq={"notify":{size,page,kw,…}}`）。 */
  const NOTIF_BLOCK_ID = 'notify'
  /** 通知的列声明（服务端窗口按它判筛型；都是文本 ⇒ 关键字在「标题/正文/下一步/来源/id」里找）。 */
  const NOTIF_COLUMNS = [{ key: 'title', label: '标题' }, { key: 'body', label: '正文' },
    { key: 'next_action', label: '下一步' }, { key: 'plugin_id', label: '来源插件' }, { key: 'id', label: '通知 id' }]
  /** 级别排序与客户端 `LEVEL_RANK` 同口径（急的在前）；与 `WINDOW_LEVEL_RANK`（0 = 最急）方向一致。 */
  const NOTIF_LEVEL_RANK = { bad: 0, warn: 1, info: 2, ok: 2 }
  const NOTIF_CHIPS = ['all', 'unread', 'todo', 'bad']
  const notifRank = (item) => NOTIF_LEVEL_RANK[String(item?.level ?? 'info')] ?? 2
  /** 偏好/筛选片里那些「不是关键字」的维度（都由客户端在 `pq.notify` 里显式给；外壳不猜）。 */
  const normNotifFilter = (raw) => {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const chip = NOTIF_CHIPS.includes(String(source.chip ?? '')) ? String(source.chip) : 'all'
    const level = ['info', 'warn', 'bad'].includes(String(source.level ?? '')) ? String(source.level) : 'info'
    return { chip, level, tag: String(source.tag ?? '').slice(0, 24),
      muted: [...new Set((Array.isArray(source.muted) ? source.muted : [])
        .map((item) => String(item ?? '').trim()).filter((item) => item !== ''))].slice(0, 50) }
  }
  /**
   * **通知聚合的短 TTL 备忘**（P13）。为什么必须有：一次通知聚合要**逐个通知源**跑一遍
   * （本批规模下 13 个来源、每个都要在 6865 行账本上筛一遍），是这一页里最贵的一次读——
   * 修前单次 8.9–10.2 s（`tmp/p13-shots/routes.json` 与浏览器 Resource Timing 同值），
   * 而且**每个在线的人每 15 s 都要拉一次**（`app.js` 的 `pollNotify`）⇒ 4 个人同时在线时
   * 这 7–10 s 互相排队（P12 记录的"4 人首屏 38.6 s"）。
   *
   * 口径（不许拿来糊弄「别的东西也没变」）：
   *   · 键 = **会话身份 + 沙盘目录**（通知源按人给 `我的/@我/我关注的` 标签，跨人复用一定错）；
   *   · TTL 默认 5 s（`QUOTAGENT_UI_NOTIFY_CACHE_MS` / 配置 `notify_cache_ms` 可调，0 = 关）；
   *   · **任何一次动作/落待办件/清只读缓存都会清掉它**（见 `clearReadCache`）—— 用户点完「标为已读」
   *     或做完动作，下一次读到的**一定**是新状态；
   *   · 命中与否、缓存龄都在 `ioStats.notify` 与状态栏里**如实记账**（界面不假装"刚刚算过"）。
   */
  const notifyEnvMs = Number(process.env.QUOTAGENT_UI_NOTIFY_CACHE_MS ?? '')
  const notifyCacheTtlMs = String(process.env.QUOTAGENT_UI_NOTIFY_CACHE_MS ?? '') !== ''
    && Number.isInteger(notifyEnvMs) ? notifyEnvMs
    : (Number.isInteger(config.notify_cache_ms) ? config.notify_cache_ms : 5000)
  const notifyCache = new Map()          // 身份+沙盘 → { at, items, stats }
  const notifyCacheKey = (who) => {
    const state = effective()
    return `${normIdentity(who)?.human ?? 'anonymous'}\u0000${state.on ? state.dir : ''}`
  }
  const clearNotifyCache = () => { if (notifyCache.size) notifyCache.clear() }
  /**
   * 聚合后的**全量条目**（round-robin 合并 + 「同一件事只出一条」），带短 TTL 备忘。
   * 备忘里存的必须是**全量**（不是某一页）：窗口请求按页来，每次都要在这份全量上筛选→排序→分页。
   */
  const notifyAggregate = (who, cacheKey) => {
    const hit = notifyCache.get(cacheKey)
    if (notifyCacheTtlMs > 0 && hit && Date.now() - hit.at <= notifyCacheTtlMs) {
      return { ...hit, cache_hit: true, cache_age_ms: Date.now() - hit.at }
    }
    const built = withRenderScope(() => {
      const lists = []
      const sources = surface.byKind('notification-source')
      for (const source of sources) {
        const rows = []
        try {
          const out = source.poll(panelCtx(source.view || 'home', undefined, who)) || []
          for (const item of Array.isArray(out) ? out : []) {
            rows.push({ id: String(item.id ?? `${source.plugin_id}:${rows.length}`), level: String(item.level ?? 'info'),
              title: String(item.title ?? ''), body: String(item.body ?? ''),
              next_action: String(item.next_action ?? ''), action: item.action ? String(item.action) : '',
              ref: normRef(item.ref), at: String(item.at ?? ''), plugin_id: source.plugin_id,
              tags: normTags(item.tags),
              // `preset`：点通知上的「去处理」时，用这些键值预填动作表单（如那条通知讲的是哪个报价）
              preset: item.preset && typeof item.preset === 'object' && !Array.isArray(item.preset)
                ? item.preset : null })
          }
        } catch (err) {
          rows.push({ id: `${source.plugin_id}:poll-failed`, level: 'bad', title: '通知源读取失败',
            body: flat(err), next_action: '修该通知源的 poll()', plugin_id: source.plugin_id,
            at: host.now(), ref: null, action: '', tags: [] })
        }
        lists.push(rows)
      }
      // 动作流水：只保留 `{kind,id}` 形状的对象引用（动作回执是任意 JSON，不能当深链用）；
      // 并且**只给自己看**（`actor` 全会话身份；未登录时看不到任何人的动作流水）。自己的动作结果排最前。
      const me = normIdentity(who)
      const mine = []
      for (const entry of actionLog.slice(0, 20)) {
        if (entry.actor !== (me ? me.human : '')) continue
        mine.push({ ...entry, ref: normRef(entry.ref) })
      }
      const merged = []
      const depth = lists.reduce((max, rows) => Math.max(max, rows.length), 0)
      for (let i = 0; i < depth; i += 1) for (const rows of lists) if (rows[i]) merged.push(rows[i])
      // **「同一件事只出一条」**（机制）：`id` 相同就是同一件事（两个插件报同一个门时 id 一样）⇒ 合并成一条，
      // 带 `count`（界面上的 ×N）、`plugins`（谁报的，如实写清）、级别取更急的一档。
      // 这一条口径以前在客户端做；服务端分页之后必须在这里做，否则同一条会在两页里各出现一次。
      const byId = new Map()
      const items = []
      for (const item of [...mine, ...merged]) {
        const prev = byId.get(item.id)
        if (!prev) { item.count = 1; byId.set(item.id, item); items.push(item); continue }
        prev.count += 1
        prev.plugins = [...new Set([...(prev.plugins || [prev.plugin_id]), item.plugin_id])]
        if (notifRank(item) < notifRank(prev)) prev.level = item.level
        if (!prev.ref && item.ref) prev.ref = item.ref
        if (!prev.action && item.action) prev.action = item.action
        if (!prev.preset && item.preset) prev.preset = item.preset
        if (!prev.body && item.body) prev.body = item.body
        prev.tags = normTags([...(prev.tags || []), ...(item.tags || [])])
        if (String(item.at || '') > String(prev.at || '')) prev.at = item.at
      }
      return { at: Date.now(), sources: sources.length,
        per_source: sources.map((source, index) => ({ plugin_id: source.plugin_id, produced: lists[index].length })),
        produced_sources: merged.length, mine: mine.length, items }
    })
    if (notifyCacheTtlMs > 0) notifyCache.set(cacheKey, built)
    return { ...built, cache_hit: false, cache_age_ms: 0 }
  }
  /**
   * **通知**（机制）：不带窗口 ⇒ 旧口径（整份、`NOTIF_CAP` 上限、截断如实记账，脚本与老客户端一字不变）；
   * 带窗口（`w=1` + `pq.notify`）⇒ 在**全量条目**上筛选 → 排序 → 分页，**只回这一页**，并把在全集上
   * 算出来的数字一并给出（共 / 命中 / 第 P/PP 页 / 未读 / 还剩多少条没翻到 / 各级别计数 / 协作标签计数）。
   *
   * `read` = 这次请求的会话身份在服务端存的**已读 id 集合**（`Array`），或 `null`（未登录 ⇒ 服务端不知道
   * 谁读过什么）。它只影响\"未读\"的计数与筛选片，**不改条目本身**（同一条对谁都在）。
   */
  const notifications = (who = null, windowSpec = null, read = null) => withSandbox(who, () => {
    const aggregate = notifyAggregate(who, notifyCacheKey(who))
    const items = aggregate.items
    const total = items.length
    const stats = { at: host.now(), sources: aggregate.sources, per_source: aggregate.per_source,
      produced_sources: aggregate.produced_sources, mine: aggregate.mine, produced: total, cap: NOTIF_CAP,
      cache_hit: aggregate.cache_hit, cache_age_ms: aggregate.cache_age_ms, cache_ttl_ms: notifyCacheTtlMs }
    if (windowSpec?.enabled !== true) {
      const kept = items.slice(0, NOTIF_CAP)
      ioStats.notify = { ...stats, windowed: false, returned: kept.length,
        dropped: Math.max(0, total - kept.length), read_known: Array.isArray(read),
        read_count: Array.isArray(read) ? read.length : 0 }
      return { items: kept, stats: ioStats.notify, query: null }
    }
    const filter = normNotifFilter((windowSpec.perPanel || {})[NOTIF_BLOCK_ID])
    const readKnown = Array.isArray(read)
    const readSet = new Set(readKnown ? read.map((item) => String(item)) : [])
    const unreadOf = (item) => readKnown && !readSet.has(item.id)
    // ① 偏好（静音某个插件 / 只看某级别以上）：与客户端 `notifVisible()` 同口径，服务端算一次
    const minRank = { info: 2, warn: 1, bad: 0 }[filter.level]
    const visible = items.filter((item) => !filter.muted.includes(item.plugin_id) && notifRank(item) <= minRank)
    const chipCounts = { all: visible.length, unread: readKnown ? visible.filter(unreadOf).length : null,
      todo: visible.filter((item) => item.level === 'warn' || item.level === 'bad').length,
      bad: visible.filter((item) => item.level === 'bad').length }
    const tagCounts = {}
    for (const item of visible) for (const tag of (item.tags || [])) tagCounts[tag] = (tagCounts[tag] || 0) + 1
    const tags = Object.keys(tagCounts).sort((left, right) => tagCounts[right] - tagCounts[left]
      || (left < right ? -1 : 1))
    // ② 筛选片（全部 / 未读 / 待我处理 / 失败）+ 协作标签（未登录 ⇒ \"未读\"服务端不知道，留给客户端按本页算）
    let shown = visible
    if (filter.chip === 'todo') shown = visible.filter((item) => item.level === 'warn' || item.level === 'bad')
    else if (filter.chip === 'bad') shown = visible.filter((item) => item.level === 'bad')
    else if (filter.chip === 'unread' && readKnown) shown = visible.filter(unreadOf)
    if (filter.tag !== '') shown = shown.filter((item) => (item.tags || []).includes(filter.tag))
    // ③ 排序：急的在前，然后按时刻倒序（与客户端 `notifList()` 同口径；稳定 ⇒ 同一页永远是同一批条目）
    const sorted = shown.map((item, index) => ({ item, index }))
      .sort((left, right) => (notifRank(left.item) - notifRank(right.item))
        || String(right.item.at || '').localeCompare(String(left.item.at || '')) || (left.index - right.index))
      .map((entry) => entry.item)
    // ④ 分页：与面板**同一套**（`size` ∈ {10,25,50,100,250,0=全部}、页号越界夹回合法页、关键字在全集上筛）
    const per = (windowSpec.perPanel || {})[NOTIF_BLOCK_ID] || {}
    const spec = normalizeWindowSpec({ ...(windowSpec.defaults || {}), ...per }, NOTIF_COLUMNS)
    const windowed = windowPanelData({ field: 'items', columns: NOTIF_COLUMNS, rows: sorted, spec,
      // `keys=true` = 界面上的「全部标已读」要**命中全集的行 id**（默认不给：6000 行 ≈ 100 KB）
      options: { levels: true, wantKeys: per.keys === true || per.keys === '1' } })
    const query = { server: true, block_id: NOTIF_BLOCK_ID, field: 'items',
      size: windowed.query.size, page: windowed.query.page, pages: windowed.query.pages,
      start: windowed.query.start, end: windowed.query.end, window: windowed.query.window,
      matched: windowed.query.matched,
      matched_unread: readKnown ? windowed.rows.filter(unreadOf).length : null,
      produced: total, visible: visible.length, total_full: total,
      unread: { known: readKnown, read_count: readSet.size, total: chipCounts.unread },
      chip: filter.chip, chip_counts: chipCounts, tag: filter.tag, tag_counts: tagCounts, tags,
      level: filter.level, muted: filter.muted,
      applied: { kw: spec.kw, chip: filter.chip, tag: filter.tag, level: filter.level, muted: filter.muted },
      level_counts: windowed.query.level_counts, row_keys: windowed.query.row_keys,
      // 「全部标已读」按需取回的**命中全集行 id**（默认空 + `on_demand`，与面板同一套）
      matched_keys: windowed.query.matched_keys || [], matched_keys_on_demand: true,
      matched_keys_capped: windowed.query.matched_keys_capped === true,
      matched_keys_available: windowed.query.matched_keys_available ?? windowed.query.matched,
      matched_keys_cap: windowed.query.matched_keys_cap ?? null,
      // 「已显示 N / 剩余 M」用的两个数：`end` = 按页推进后**已经到过**的条数、`rest` = 还没翻到的条数
      rest: Math.max(0, windowed.query.matched - windowed.query.end),
      hidden_by_prefs: total - visible.length, notes: windowSpec.notes }
    ioStats.notify = { ...stats, windowed: true, returned: windowed.rows.length, dropped: 0,
      page: windowed.query.page, pages: windowed.query.pages, size: windowed.query.size,
      matched: windowed.query.matched, visible: visible.length,
      read_known: readKnown, read_count: readSet.size }
    return { items: windowed.rows, stats: ioStats.notify, query }
  })

  const statusItems = (who = null) => withSandbox(who, () => withRenderScope(() => {
    const out = []
    for (const item of surface.byKind('status-item')) {
      try {
        const read = item.read(panelCtx('home', undefined, who)) || {}
        out.push({ id: item.id, title: item.title, text: String(read.text ?? ''), level: String(read.level ?? 'ok'),
          next_action: String(read.next_action ?? ''), plugin_id: item.plugin_id })
      } catch (err) {
        out.push({ id: item.id, title: item.title, text: `读取失败：${flat(err)}`, level: 'bad',
          plugin_id: item.plugin_id })
      }
    }
    out.push({ id: 'surface.counts', title: '注册面', level: 'ok', plugin_id: 'system/webui',
      text: `面板 ${surface.byKind('panel').length} · 动作 ${surface.byKind('action').length} · `
        + `快捷键 ${surface.shortcuts().length} · 通知源 ${surface.byKind('notification-source').length}` })
    // 机制的**代价读数**：一次页面渲染到底起了几个 Python 进程、省掉几个（前后可对账）
    out.push({ id: 'shell.io', title: 'Python', level: ioStats.spawns ? 'ok' : 'ok', plugin_id: 'system/webui',
      text: `进程 ${ioStats.spawns} 次（只读 ${ioStats.read_spawns}）· 只读命中缓存 ${ioStats.read_hits} 次`
        + ` · 缓存窗口 ${readCacheTtlMs}ms` })
    // **上一次页面渲染**的代价（本批新增，只为"可对账"）：起几个进程 / 花多久 / 几块面板
    const last = ioStats.last_render
    if (last) {
      out.push({ id: 'shell.io.last_render', title: '上次渲染', level: 'ok', plugin_id: 'system/webui',
        text: `${last.view}${last.kind ? `/${last.kind}` : ''}：面板 ${last.panels} 块 · `
          + `Python 进程 ${last.spawns} 次（只读 ${last.read_spawns}，命中缓存 ${last.read_cache_hits}）· `
          + `服务端耗时 ${last.ms}ms` })
    }
    // **通知的名额分配**（机制）：产出多少 / 这一页返回多少 / 上限多少 / 还剩多少没翻到 —— 如实记账，不静默
    const notify = ioStats.notify
    if (notify) {
      // 口径：`produced` = 去重后 ＋ 本会话动作结果（界面上"共 N 条"读的就是它）；
      // `produced_sources` = 各通知源**合并后、去重前**的条数。两个数不等时如实写清差在哪。
      const folded = notify.produced - notify.mine
      const parts = [`来源 ${notify.sources} 个`, `产出 ${notify.produced} 条`]
      const detail = []
      if (notify.produced_sources !== folded) {
        detail.push(`源合并 ${notify.produced_sources} 条 → 按 id 去重后 ${folded} 条`)
      }
      if (notify.mine) detail.push(`本会话动作结果 ${notify.mine} 条`)
      if (detail.length) parts.push(`（${detail.join(' ＋ ')}）`)
      if (notify.windowed === true) {
        parts.push(`通知窗口可翻到底：共 ${notify.produced} 条 · 第 ${notify.page + 1}/${notify.pages} 页`
          + `（本页 ${notify.returned} 条 · 每页 ${notify.size} · 命中 ${notify.matched} 条`
          + `${notify.matched !== notify.visible ? ` · 符合偏好的 ${notify.visible} 条` : ''}）`)
      } else {
        parts.push(`这一次**不带窗口**（脚本/旧调用）：返回 ${notify.returned} 条（上限 ${notify.cap}`
          + `${notify.dropped ? `，截掉 ${notify.dropped} 条` : ''}）`)
      }
      parts.push(notify.read_known === true
        ? `已读记录 ${notify.read_count} 条（服务端，按会话身份）`
        : '未登录：服务端不知道谁读过什么（未读只按本页算）')
      out.push({ id: 'shell.notify', title: '通知',
        level: notify.windowed === false && notify.dropped > 0 ? 'warn' : 'ok', plugin_id: 'system/webui',
        text: parts.join(' · '),
        next_action: notify.windowed === false && notify.dropped > 0
          ? '界面走的是**通知窗口**（`w=1`）：全部通知都能一页页翻到（末页可点）；这条上限只约束不带 `w` 的旧调用'
          : '' })
    }
    // **账本只读备忘**（P13）：并发卡死的定位读数就在这一行 —— 同一份账本被读了几遍
    if (ledgerStats) {
      const asks = ledgerStats.memo_hits + ledgerStats.parses
      out.push({ id: 'shell.ledger', title: '账本读取', level: 'ok', plugin_id: 'system/webui',
        text: `被问到 ${asks} 次：真读盘 ${ledgerStats.parses} 次（累计 ${ledgerStats.ms}ms）、走备忘 `
          + `${ledgerStats.memo_hits} 次；账本文件 ${ledgerStats.paths} 份`,
        next_action: ledgerStats.parses > ledgerStats.memo_hits
          ? '真读次数远多于备忘命中 ⇒ 渲染里有大量"重复读同一份账本"，先看 io.ledger' : '' })
    }
    // **渲染准入（背压）**（P13）：正在排队/heap 之外的那件事 —— 服务端忙到什么程度、拒了几条
    out.push({ id: 'shell.admission', title: '渲染准入', level: admissionStats.shed ? 'warn' : 'ok',
      plugin_id: 'system/webui',
      text: `事件循环滞后 ${admissionStats.last_lag_ms}ms（峰值 ${admissionStats.peak_lag_ms}ms）· `
        + `阈值 ${shedMs}ms${shedMs > 0 ? '' : '（已关闭）'} · 检查 ${admissionStats.checks} 次 · 被拒 `
        + `${admissionStats.shed} 条${admissionStats.shed ? '（回的是 429 + Retry-After，不是挂着不动）' : ''}`,
      next_action: admissionStats.shed
        ? '界面会自动等 Retry-After 再试一次；连续被拒 ⇒ 这台服务的渲染负载超过单进程上限' : '' })
    return out
  }))

  // ------------------------------------------------------------------ 动作：校验 → 插件的服务端一半
  /** 字段级校验（与服务端声明同源；客户端只是提前一步给同样的错误）。 */
  const validateInput = (action, input) => {
    const errors = []
    // 批量动作：对象 id 由批量清单（`ids` / `rows`）顶替 ⇒ 不再要求手抄一个 id 字段
    // （与客户端同一口径：P3 走查实测批量受理被"报价 id 必填"挡在门外的真缺陷）。
    const bulk = (Array.isArray(input.ids) && input.ids.length > 0)
      || (Array.isArray(input.rows) && input.rows.length > 0)
    for (const field of action.input.fields) {
      const value = input[field.name]
      const empty = value === undefined || value === null || String(value).trim() === ''
      const covered = bulk && (field.from_route === true
        || (action.input.bulk === 'rows' && field.name === 'item_id'))
      if (field.required && empty && !covered) {
        errors.push({ field: field.name, code: 'required', message: '必填',
          next_action: `填 ${field.label}` })
        continue
      }
      if (empty) continue
      if (field.type === 'number' && !Number.isFinite(Number(value))) {
        errors.push({ field: field.name, code: 'not-a-number', message: '必须是数', next_action: '给一个数' })
      }
      if (field.min !== null && Number(value) < Number(field.min)) {
        errors.push({ field: field.name, code: 'below-min', message: `不得小于 ${field.min}`,
          next_action: `改到 ≥ ${field.min}` })
      }
      if (field.max !== null && Number(value) > Number(field.max)) {
        errors.push({ field: field.name, code: 'above-max', message: `不得大于 ${field.max}`,
          next_action: `改到 ≤ ${field.max}` })
      }
      if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
        errors.push({ field: field.name, code: 'pattern', message: '形状不符合规则',
          next_action: `按声明的形状重填（pattern=${field.pattern}）` })
      }
      if (field.type === 'signature' && !String(value).startsWith('human:')) {
        errors.push({ field: field.name, code: 'human-required', message: '署名必须以 human: 开头',
          next_action: 'agent 不得代签：写 human:<你的名字>' })
      }
    }
    for (const validator of surface.validatorsFor(action.id)) {
      try {
        const out = validator.validate(input) || []
        for (const item of Array.isArray(out) ? out : []) {
          errors.push({ field: String(item.field ?? ''), code: String(item.code ?? 'validator'),
            message: String(item.message ?? ''), plugin_id: validator.plugin_id,
            next_action: String(item.next_action ?? '按上面的原因改入参') })
        }
      } catch (err) {
        errors.push({ field: '', code: 'validator-failed', plugin_id: validator.plugin_id,
          message: flat(err), next_action: '修该校验器（校验器抛错时动作不执行）' })
      }
    }
    return errors
  }

  const runAction = async (actionId, request, who = null) => withSandbox(who, () => runActionInner(actionId, request, who))

  const runActionInner = async (actionId, request, who = null) => {
    const action = surface.findAction(actionId)
    if (!action) {
      return { ok: false, code: 'unknown-action', reason: `注册面里没有动作 ${actionId}`,
        next_action: '插件卸载后它的动作会消失：刷新页面看当前可用的动作（命令面板 ⌘K）' }
    }
    const input = request?.input && typeof request.input === 'object' ? request.input : {}
    const errors = validateInput(action, input)
    if (errors.length) return { ok: false, code: 'validation-failed', action: action.id, errors,
      next_action: '按 errors 里每个字段的 next_action 改后重试（本次什么都没执行）' }
    if (action.confirm.required && request?.input?.confirm_ack !== '1') {
      return { ok: false, code: 'confirm-required', action: action.id,
        next_action: `这个动作需要显式确认：${action.confirm.message}` }
    }
    const ctx = { view: String(request?.view ?? action.view), route: normRoute({ view: request?.view ?? action.view,
      kind: request?.route?.kind, id: request?.route?.id }), input, host, now: host.now(),
      // **会话身份**（机制）：插件可以据此判定"同侧人类之间"的协作；表单里的字段改不动它。
      identity: normIdentity(who),
      action: { id: action.id, title: action.title, plugin_id: action.plugin_id, permission: action.permission } }
    // ---- **按角色限动作**（机制；`people.mjs` 的策略面）：只**收紧**动作，永不放开 ----------------------
    // 判据在名册的 `policy.amount_limit` 里（配置：哪个动作、金额从哪条事实取、什么单位）：
    // 动作金额超过**我的角色**额度 ⇒ 在动作的服务端一半执行**之前**拒绝（账本/待办件零新增），并告诉你该找谁。
    // 位置与纪律：它在人签门（`/api/action/<id>` 的「署名 == 会话身份」）**之后**、插件自己的服务端一半**之前** ——
    // 角色既不能替签、也不能跳过人工门；它只能否决（"角色不改变签署权"这条在这里是**结构性**的）。
    const guardVerdict = people.guardAction({ action_id: action.id, input, identity: ctx.identity,
      view: ctx.view, rows: (view) => host.rows(view) })
    if (guardVerdict) {
      // 拒绝回执带上**可核对的读数**（我是什么角色、额度多少、这笔金额多少、该找哪个角色）：
      // 把 verdict 里的结构化字段（`refusal` 除了 ok/code/reason/next_action 之外的键）原样透到 `result`。
      const { ok: _ignored, code: guardCode, reason: guardReason, next_action: guardNext, ...guardRest } = guardVerdict
      const guardDetail = Object.keys(guardRest).length ? guardRest : null
      const entry = { id: `act-${Date.now()}-${action.id}`, level: 'bad',
        title: `${action.title} → ${guardCode}`, body: flat(guardReason),
        next_action: flat(guardNext), ref: null, at: host.now(), plugin_id: action.plugin_id,
        action: action.id, actor: ctx.identity ? ctx.identity.human : '',
        guard: { code: guardCode, ...(guardDetail ?? {}) } }
      actionLog.unshift(entry)
      if (actionLog.length > 100) actionLog.length = 100
      return { ok: false, code: guardCode, action: action.id, reason: guardReason,
        next_action: guardNext, result: guardDetail,
        guard: 'role-limit', ledger: 'zero-management' }
    }
    let out = null
    // 本次动作的**作用域**：它落下的待办件 + 它跑过的写者回执（见 `writerCheck`）——动作返回后两端对账
    // （`identity`/`view` 也在这里：`host.report()` 要按"谁在导出"套**个人列选择偏好**）
    const scope = { action_id: action.id, staged: [], runs: [], identity: ctx.identity, view: ctx.view }
    // ---- **乐观并发**（机制）：保存前比对对象版本；对不上 ⇒ **明确拒绝**并给差异（不后写覆盖前写）----
    let pendingVersion = null
    if (action.concurrency) {
      const verdict = versionGuard({ action, ctx, input })
      if (verdict.refusal) {
        const refusal = verdict.refusal
        actionLog.unshift({ id: `act-${Date.now()}-${action.id}`, level: 'bad',
          title: `${action.title} → ${refusal.code}`, body: flat(refusal.reason),
          next_action: flat(refusal.next_action), ref: null, at: host.now(), plugin_id: action.plugin_id,
          action: action.id, actor: ctx.identity ? ctx.identity.human : '',
          conflict: refusal.result?.conflict ?? null })
        if (actionLog.length > 100) actionLog.length = 100
        return { ...refusal, writer_consistency: 'no-writer-run',
          writer: { verdict: 'no-writer-run', rows_written: 0 },
          reason: refusal.reason, next_action: refusal.next_action, result: refusal.result ?? null }
      }
      pendingVersion = verdict.pending
    }
    actionScopes.push(scope)
    try {
      out = await action.server(ctx, input)
    } catch (err) {
      out = { ok: false, code: 'action-failed', reason: flat(err), next_action: '修该动作的服务端一半（不静默吞）' }
    } finally {
      const index = actionScopes.lastIndexOf(scope)
      if (index >= 0) actionScopes.splice(index, 1)
    }
    const result = out && typeof out === 'object' ? out : { ok: false, code: 'invalid-result',
      reason: '服务端一半没有返回对象', next_action: '返回 {ok, code, reason, next_action, result}' }
    // ---- **写者回执 ⟷ 响应体** 两端对账（机制）：判据只有一条（退出码 + stdout JSON） ------------------
    const writer = writerCheck(scope, result.ok)
    if (writer.verdict !== 'consistent' && writer.verdict !== 'no-writer-run') {
      say(`写者回执与响应不一致：${action.id} → ${writer.verdict}（${writer.note}）`)
    }
    const actor = normIdentity(who)
    // ---- **乐观并发**：这次保存**真的成了** ⇒ 把新版本记下来（rev+1），供下一个人比对 ------------
    // 只在 `result.ok === true` 时记（被写者/业务门拒的动作没有"保存成功"这回事）。
    let versionAfter = null
    if (pendingVersion && result.ok === true) {
      const recorded = versionRecord({ ...pendingVersion, fields: pendingVersion.fields })
      versionAfter = { object_class: pendingVersion.object_class, object_id: pendingVersion.object_id,
        label: pendingVersion.label, rev: recorded.rev ?? null, fingerprint: recorded.fingerprint ?? '',
        unchanged: recorded.unchanged === true, changed: recorded.changed ?? [],
        file: recorded.file ?? versionFileOf(pendingVersion.side) }
    }
    const entry = { id: `act-${Date.now()}-${action.id}`, level: result.ok ? 'ok' : 'bad',
      title: `${action.title} → ${result.ok ? 'ok' : (result.code ?? 'refused')}`
        + (writer.verdict === 'consistent' || writer.verdict === 'no-writer-run'
          ? '' : `（写者回执与响应不一致：${writer.verdict}）`),
      body: flat(result.reason ?? result.note ?? '')
        + (writer.verdict === 'consistent' || writer.verdict === 'no-writer-run' ? '' : ` · ${writer.note}`),
      next_action: flat(result.next_action ?? ''), ref: result.result ?? null, at: host.now(),
      plugin_id: action.plugin_id, action: action.id,
      // 动作流水**按会话身份隔离**：同侧别人做的事不该出现在你的通知中心里（多人在同一侧时的隐私与噪声）
      actor: actor ? actor.human : '', writer: { verdict: writer.verdict, rows_written: writer.rows_written } }
    actionLog.unshift(entry)
    if (actionLog.length > 100) actionLog.length = 100
    clearReadCache()   // 动作可能改了事实（写者刚跑过）⇒ 只读缓存作废：下一屏读到的一定是新状态
    return { ok: result.ok === true, action: action.id, code: result.code ?? null, reason: result.reason ?? null,
      next_action: result.next_action ?? null, result: result.result ?? null, note: result.note ?? null,
      errors: result.errors ?? null, refresh: result.refresh ?? ['panels', 'notifications', 'status'],
      // 乐观并发：这次保存之后的**版本**（rev/指纹；`unchanged:true` = 内容没变，没有制造新版本）
      version: versionAfter,
      conflict: result.result?.conflict ?? null,
      // 写者回执的**原始判据 + 与本动作的归属**：界面/审计据此核对"响应说的"与"账本真发生的"
      writer_consistency: writer.verdict, writer }
  }

  // ------------------------------------------------------------------ 撤销（卸载一个插件的全部贡献）
  const unload = (pluginId) => {
    // 协作面（外壳自带）：撤掉它的贡献时把机制侧的账也清干净（否则再 load 会说"已经装着"）
    if (pluginId === COLLAB_PLUGIN_ID) collabSurface.dispose()
    if (pluginId === PEOPLE_PLUGIN_ID) peopleSurface.dispose()
    // 导出列选择的**面板**是按视图记账的：撤掉贡献时要把这本账清掉，否则重建时补不回来
    if (pluginId === EXPORT_PLUGIN_ID) exportPanelViews.clear()
    // 沙盘是**外壳机制**（不是业务插件）：它的面板/动作可以被撤，但机制本身不能卸载 —— 撤完立刻重建，
    // 免得"演示数据"入口被一次误卸载永久干掉（清空沙盘的动作也在这里面）。
    // 分享 / 导出列选择则**真的可卸载**（规则 1）：撤掉后入口消失，`POST .../load|reload` 重建。
    const sandboxWas = pluginId === SANDBOX_PLUGIN_ID
    const removed = surface.disposePlugin(pluginId)
    const slotRows = []
    if (slots && typeof slots.describe === 'function') {
      for (const block of slots.describe().blocks) {
        if (block.plugin_id !== pluginId) continue
        slots.unregister(pluginId, block.slot)
        slotRows.push({ kind: 'slot-block', id: `${block.slot}:${block.plugin_id}`, title: block.title })
      }
    }
    contributions.set(pluginId, { entries: [], unloaded: true, file: fileOf(pluginId) })
    noteStore.drop(pluginId)
    if (sandboxWas) syncSandbox()
    clearReadCache()
    const payload = { ok: true, plugin_id: pluginId, removed: [...removed.removed, ...slotRows],
      count: removed.count + slotRows.length,
      next_action: '该插件的视图/面板/动作/快捷键/通知源/状态项与它注册的区块都已撤销；'
        + '页面其余部分逐字节不变（可 POST .../load 或 .../reload 恢复）' }
    say(`卸载贡献：${pluginId}（移除 ${payload.count} 项）`)
    return payload
  }

  // ------------------------------------------------------------------ 沙盘：机制贡献 + 场景 runner
  /**
   * **沙盘机制贡献**（`system/webui-sandbox`）：一块状态面板 + 两个动作（造 / 清）。
   * 与协作面、名册面同构 —— 它是**外壳自带的机制贡献**（`surface.scenario` 由插件声明，外壳只串联与 dispatch）。
   */
  const SANDBOX_PLUGIN_ID = 'system/webui-sandbox'
  const SANDBOX_DEMO_ACTOR = (side) => `demo-${safeSide(side)}`
  function safeSide(side) { return String(side ?? '').replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'side' }

  const sandboxStateFor = (human) => {
    const doc = sandboxReadState() ?? { schema: SANDBOX_SCHEMA, actors: {}, updated_at: '' }
    return { doc, entry: doc.actors?.[human] ?? null }
  }
  /** 打开/更新某身份的沙盘（幂等）；有界（超过 32 条时丢掉最旧的几条）。 */
  const sandboxOpen = ({ human, actors, scenario }) => {
    const { doc } = sandboxStateFor(human)
    doc.schema = SANDBOX_SCHEMA
    doc.actors = doc.actors ?? {}
    doc.actors[human] = { on: true, actors, scenario, seeded_at: doc.actors[human]?.seeded_at ?? '' }
    const keys = Object.keys(doc.actors)
    if (keys.length > SANDBOX_MAX_ACTORS) for (const key of keys.slice(0, keys.length - SANDBOX_MAX_ACTORS))
      delete doc.actors[key]
    doc.updated_at = new Date().toISOString()
    return sandboxWriteState(doc)
  }
  const sandboxClose = (human) => {
    const { doc } = sandboxStateFor(human)
    doc.schema = SANDBOX_SCHEMA
    doc.actors = doc.actors ?? {}
    doc.actors[human] = { ...(doc.actors[human] ?? { actors: {} }), on: false }
    doc.updated_at = new Date().toISOString()
    return sandboxWriteState(doc)
  }
  /** **清空**：删掉这个身份的沙盘目录（账本/待办件/信封一起走）+ 关掉 `on`。真实面从不触碰。 */
  const sandboxWipe = (human) => {
    const dir = sandboxDirFor(human)
    const existed = existsSync(dir)
    try { rmSync(dir, { recursive: true, force: true }) } catch (err) {
      return { ok: false, code: 'sandbox-wipe-failed', reason: flat(err),
        next_action: '先修 <ui_shared>/sandbox/ 的权限（清空只删沙盘目录，不碰真实账本）' }
    }
    const closed = sandboxClose(human)
    return { ok: closed.ok !== false, dir, removed: existed }
  }
  /** 值里的令牌：`$actor` = 这一步的演示身份；`$last.<点分路径>` = 上一步回执 `result` 里的值；
   * `$cap.<名字>.<点分路径>` = 更早某一步（声明了 `capture`）的回执 `result` 里的值。 */
  const deref = (value, { actor, last, caps }) => {
    const walk = (source, path) => {
      let cursor = source
      for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined) return null
        cursor = cursor[/^\d+$/.test(key) ? Number(key) : key]
      }
      return cursor === undefined ? null : cursor
    }
    if (typeof value === 'string') {
      if (value === '$actor') return `human:${actor}`
      if (value.startsWith('$last.')) return walk(last, value.slice(6))
      if (value.startsWith('$cap.')) {
        const rest = value.slice(5)
        const dot = rest.indexOf('.')
        const name = dot < 0 ? rest : rest.slice(0, dot)
        return walk(caps[name] ?? null, dot < 0 ? '' : rest.slice(dot + 1))
      }
      return value
    }
    if (Array.isArray(value)) return value.map((item) => deref(item, { actor, last, caps }))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) out[key] = deref(item, { actor, last, caps })
      return out
    }
    return value
  }
  /**
   * 跑一条**沙盘场景**：按声明顺序 dispatch 到**同一个动作总线**（同一批唯一写者、同一张待办件形状）。
   * 每一步都带自己的 `view` 与演示身份；`$last` 取上一步回执 ⇒ 步骤之间不必手抄 id。
   */
  const runScenario = async ({ scenario, who, skip = [] }) => {
    const group = surface.scenarios().find((item) => item.scenario === scenario)
    if (!group) {
      return { ok: false, code: 'unknown-scenario', reason: `没有插件声明场景 ${scenario}`,
        next_action: '场景由插件声明（`surface.scenario({scenario:"…", steps:[{action:"…"}]})`）：先确认该插件已装载' }
    }
    const sessionSide = String(who?.side ?? '')
    const owner = humanOf(who)
    const actors = {}
    for (const side of new Set([sessionSide, ...group.steps.map((step) => step.as?.side).filter(Boolean)]).values())
      if (side !== '') actors[side] = side === sessionSide ? String(who?.human ?? '') : SANDBOX_DEMO_ACTOR(side)
    const opened = sandboxOpen({ human: owner, actors, scenario })
    if (opened.ok === false) return { ...opened, ledger_added: 0, steps: [] }
    // 关键：**从这里开始整条链路都在沙盘作用域里**（`runScenario` 自己压栈，不依赖 HTTP 入口那一层）——
    // 否则步骤里的 `host.config.ledger_*` / `host.sharedDir` 还是真实路径，演示数据就写进真实账本了。
    const entry = { on: true, owner, dir: sandboxDirFor(owner), actors, actor: owner }
    return withSandboxEntry(entry, async () => {
      const done = []
      const caps = {}
      let last = null
      for (const step of group.steps) {
        if (skip.includes(step.action)) { done.push({ action: step.action, skipped: true }); continue }
        const actorSide = step.as?.side ?? sessionSide
        const actor = actors[actorSide] || String(who?.human ?? '')
        const input = deref(step.input ?? {}, { actor, last, caps })
        /* eslint-disable no-await-in-loop */
        const out = await withSandboxActor(actor, () => runActionInner(step.action,
          { view: step.view || actorSide, input }, { human: actor, side: actorSide }))
        done.push({ action: step.action, declared_by: step.declared_by, as: actor, view: step.view || actorSide,
          ok: out?.ok === true, code: out?.code ?? null, reason: out?.reason ?? null,
          content: out?.content ?? null, next_action: out?.next_action ?? null,
          optional: step.optional === true,
          ledger_added: Number(out?.writer?.rows_written ?? 0) })
        last = out?.result ?? null
        if (step.capture) caps[step.capture] = last ?? {}
        if (out?.ok !== true && step.optional !== true) break
      }
      const failed = done.find((item) => item.ok === false && !item.optional) ?? null
      const optionalFailed = done.filter((item) => item.ok === false && item.optional)
      const { doc } = sandboxStateFor(owner)
      doc.actors[owner] = { ...(doc.actors[owner] ?? {}), on: true, actors, scenario,
        seeded_at: new Date().toISOString() }
      sandboxWriteState(doc)
      clearReadCache()
      return { ok: failed === null, code: failed ? (failed.code ?? 'step-failed') : 'sandbox-seeded',
        reason: failed ? `第 ${done.indexOf(failed) + 1} 步（${failed.action}）失败：${failed.reason ?? ''}` : '',
        steps: done, actors, scenario, sandbox_dir: sandboxDirFor(owner),
        optional_failures: optionalFailed.map((item) => ({ action: item.action, code: item.code,
          reason: item.reason })),
        ledger_added: done.reduce((sum, item) => sum + (item.ledger_added || 0), 0),
        next_action: failed ? `按上面的原因修这一步的入参/前置事实后重跑；沙盘数据可以「清空沙盘」从零再来`
          : ('沙盘已就绪：切到「供应商」看报价、切回「承包商」看比价/授标/PO —— 这些都是**演示数据**，'
            + '真实账本零新增；看完点「清空沙盘」一键回到真实面'
            + (optionalFailed.length ? `（有 ${optionalFailed.length} 步是可选项、这次没成，'
              + '回执里列了原因：${optionalFailed.map((item) => `${item.action}:${item.code}`).join('、')}）` : '')) }
    })
  }

  const sandboxDescribe = (human) => {
    const entry = sandboxEntry(human)
    const groups = surface.scenarios()
    return { on: Boolean(entry), owner: human, actors: entry?.actors ?? {},
      seeded_at: entry?.seeded_at ?? '', scenario: entry?.scenario ?? '', dir: entry?.dir ?? '',
      state_file: sandboxStateFile, scenarios: groups.map((group) => ({ scenario: group.scenario,
        title: group.title, hint: group.hint, step_count: group.step_count,
        steps: group.steps.map((step) => ({ action: step.action, as: step.as?.side ?? '', view: step.view,
          declared_by: step.declared_by, optional: step.optional === true, note: step.note })),
        contributors: group.contributors })) }
  }

  const syncSandbox = () => {
    const panelFor = (view, order, title) => surface.panel({ plugin_id: SANDBOX_PLUGIN_ID,
      id: `sandbox.${view}`, title, view, order, kind: 'list',
      hint: '沙盘把这一侧的读/写路径整体切到 <ui_shared>/sandbox/<你的名字>/：'
        + '账本、待办件、投递信封全是沙盘自己那一份 —— 真实账本零新增，看完一键清空',
      data: (ctx) => {
        const who = String(ctx?.identity?.human ?? '')
        const info = sandboxDescribe(who)
        const items = []
        items.push({ level: info.on ? 'ok' : 'info',
          title: info.on ? `沙盘已打开（${info.scenarios.length} 条可用场景）` : '沙盘未打开（你现在看的是真实数据）',
          body: info.on ? `沙盘目录：${info.dir}｜演示身份：${Object.entries(info.actors)
            .map(([side, name]) => `${side}=${name}`).join('、')}` : '点下面的按钮造一组演示数据'
            + '（包 → 报价 → 比价 → 授标 → PO）：它是真流转、真账本事件，只是落在沙盘目录里',
          next_action: !who ? `先登录（沙盘按会话身份分条存放，谁造的谁清）：${prefix}/identity/?next=${prefix}/`
            : (info.on ? '切到另一个视角看对面的那一半；看完「清空沙盘」回到真实面'
              : '点「造一组演示数据」（会再确认一次），几秒后就能看到一整条流转') })
        for (const group of info.scenarios) {
          items.push({ level: 'info', title: `${group.title}（${group.step_count} 步）`,
            body: group.steps.map((step, index) => `${index + 1}. ${step.action}`
              + (step.as ? `（${step.as} 侧）` : '')).join(' → '),
            next_action: group.hint || '这一步会按顺序真的跑一遍（写者照旧落账，只是落在沙盘里）',
            action: 'sandbox.seed', label: '造一组演示数据',
            preset: { scenario: group.scenario } })
        }
        if (!info.scenarios.length) {
          items.push({ level: 'warn', title: '还没有插件声明演示场景',
            body: '场景由插件自己声明（`surface.scenario({scenario, steps})`）——没有声明就没有可造的演示',
            next_action: '装载/重载声明了场景的插件（顶栏「插件」）' })
        }
        if (info.on) items.push({ level: 'warn', title: '清空沙盘（回真实面）',
          body: `删掉 ${info.dir} 并关掉沙盘；真实账本一个字节都没动过`,
          next_action: '随时可以再来一次（造一组新的）', action: 'sandbox.clear', label: '清空沙盘' })
        return { ok: true, kind: 'list', items, degraded: false, counts: { scenarios: info.scenarios.length },
          note: '沙盘 = 演示数据：数据走**同一套动作与唯一写者**，只是路径在沙盘目录里；'
            + '它不写真实账本、不改真实待办件；名册/协作/附件仍是真实面（演示场景不用它们）' }
      } })
    const out = []
    out.push(panelFor('home', -98, '演示数据（沙盘）· 一键造一组可看的流转'))
    for (const view of views) if (view !== 'home') out.push(panelFor(view, 98, '演示数据（沙盘）· 造 / 清'))
    out.push(surface.action({ plugin_id: SANDBOX_PLUGIN_ID, id: 'sandbox.seed', title: '造一组演示数据（沙盘）',
      views: ['home', 'contractor', 'supplier'], group: '沙盘', icon: '✨', confirm: { required: true,
        message: '在**沙盘目录**里用同一套动作跑一遍演示流程（真实账本零新增）。确认造吗？' },
      input: { fields: [{ name: 'scenario', label: '场景', type: 'text', required: false,
        help: '留空 = 第一条可用场景（见「演示数据（沙盘）」面板）' }] },
      hint: '沙盘：把这一侧的读/写路径切到 <ui_shared>/sandbox/<你>/，再按插件声明的步骤顺序跑一遍；'
        + '人签用机制生成的演示身份（真实面上这条替换不存在）',
      server: async (ctx, input) => {
        const who = ctx.identity
        if (!who || !who.human) {
          return { ok: false, code: 'identity-required', ledger_added: 0,
            reason: '沙盘按**会话身份**分条存放（谁造的谁清），未登录时不知道要放哪一份',
            next_action: `先去 ${prefix}/identity/?next=${prefix}/ 登录（一个名字 + 属于哪一侧），再回来点这个按钮` }
        }
        const list = surface.scenarios()
        const wanted = String(input.scenario ?? '').trim() || list[0]?.scenario || ''
        const out = await runScenario({ scenario: wanted, who })
        return { ok: out.ok, code: out.code, reason: out.reason, next_action: out.next_action,
          ledger_added: out.ledger_added ?? 0,
          result: { sandbox: { on: true, dir: out.sandbox_dir, actors: out.actors, scenario: out.scenario },
            steps: out.steps ?? [], note: out.ok
              ? '这些是**演示数据**（沙盘账本）：真实账本零新增；顶栏会显示「沙盘」标记'
              : '中途失败：沙盘里的东西照旧留着，可以「清空沙盘」从零再来' } }
      } }))
    out.push(surface.action({ plugin_id: SANDBOX_PLUGIN_ID, id: 'sandbox.clear', title: '清空沙盘（回真实面）',
      views: ['home', 'contractor', 'supplier'], group: '沙盘', icon: '🧹',
      confirm: { required: true, message: '删掉沙盘目录（演示账本 + 待办件 + 信封）并关掉沙盘？真实账本不受影响。' },
      input: { fields: [] },
      hint: '只删 <ui_shared>/sandbox/<你的名字>/，并把沙盘关掉；真实账本、真实待办件一个字节都不动',
      server: (ctx) => {
        const who = ctx.identity
        if (!who || !who.human) {
          return { ok: false, code: 'identity-required', ledger_added: 0,
            reason: '沙盘按会话身份分条存放：未登录时没有可清的沙盘',
            next_action: '先登录（沙盘只清你自己那一份）' }
        }
        const before = sandboxEntry(who.human)
        const out = sandboxWipe(who.human)
        clearReadCache()
        return { ok: out.ok, code: out.ok ? 'sandbox-cleared' : out.code, reason: out.reason ?? '',
          next_action: out.ok ? '已经回到真实面：面板/状态栏/账本读数又都是真实那一份了（随时可以再造一次）'
            : out.next_action, ledger_added: 0,
          result: { sandbox: { on: false }, removed_dir: out.dir, existed: out.removed,
            was_open: Boolean(before), note: '清空只发生在沙盘目录里；真实账本零新增、零改动' } }
      } }))
    return out
  }
  const sandboxContributions = syncSandbox()

  // ------------------------------------------------------------------ 机制贡献：**分享**（深链 + 对方需要什么 + 邮件正文）
  /**
   * 「能把事分享出去」= 一条**可复制的深链** + 明确写出**对方需要什么身份/侧才能看** + **一键拼成
   * 可粘贴的邮件正文**。机制只做三件事：验对象类、取对象页头（插件声明的东西照搬）、把事实拼成
   * 一段人能直接用的文字 —— 它不认识任何业务对象（口径见 `docs/design/29-webui-gui-app.md` §14）。
   *
   * 它**不写账本、不落文件、不发邮件**：分享是"你自己把地址与前提抄出去"，不是对外承诺。
   * `object.share`（插件在 `data.object.share` 里声明）给的是"对方能不能看"这一档：
   *   `{visibility:'both'|'side', other_side_view?, requirements?:[...], note?, next_action?}`
   */
  const SHARE_PLUGIN_ID = 'system/webui-share'
  const shareBusinessViews = () => views.filter((view) => view !== 'home')
  const isBusinessSide = (view) => sides.includes(view)
  const viewTitleOf = (view) => String(config.view_titles?.[view] ?? ({ home: '工作台', contractor: '承包商',
    supplier: '供应商', ops: '运维', admin: '系统管理' }[view] ?? view))
  /** 哪个视图能打开这个对象类（对象类由插件声明；跨视图链接只在**确实声明过**的视图上给）。 */
  const viewsForKind = (kind) => views.filter((view) => surface.objectKindsFor(view).includes(kind))
  const composeShare = ({ ctx, input, who }) => {
    const view = String(ctx.view ?? '')
    const kind = String(input.kind ?? '').trim()
    const id = String(input.id ?? '').trim()
    const kinds = surface.objectKindsFor(view)
    if (!kinds.includes(kind)) {
      return { ok: false, code: 'object-kind-not-in-this-view', ledger: 'zero-management',
        reason: `本视图（${viewTitleOf(view)}）里没有对象类 ${JSON.stringify(kind)}`,
        next_action: `本视图可分享的对象类：${kinds.join(' / ') || '（一个都没有：还没有插件声明 object_kind）'}；`
          + '先在列表里点某一行的「打开 →」进对象页，再点「分享」' }
    }
    const info = objectOf(view, kind, id, who)
    const share = info.share ?? null
    const path = `${prefix}/app/${view}/${kind}/${id}/`
    const others = viewsForKind(kind).filter((other) => other !== view)
      .map((other) => ({ view: other, title: viewTitleOf(other), path: `${prefix}/app/${other}/${kind}/${id}/` }))
    const identityLine = isBusinessSide(view)
      ? `需要**登录**并且身份属于 \`${view}\`（${viewTitleOf(view)}）侧 —— 业务视图按会话身份判权限，`
        + '人签类动作还要求"署名 == 会话身份"'
      : `本视图（${viewTitleOf(view)}）不按身份鉴权：登录即可打开（人签类动作仍按会话身份判）`
    const requirements = [
      { key: '需要的身份', value: identityLine, ok: Boolean(who) },
      { key: '必须登录', value: who ? `已登录：${who.human}（${who.side}）` : '当前**未登录**：分享内容照给，'
        + '但对方打开后要先登录才能看到自己那一侧的投影', ok: Boolean(who) },
      { key: '这个对象在对方那侧能不能看', value: share
        ? `${share.visibility === 'side' ? '**本侧内部**对象（插件声明 visibility=side）：对方看不到'
          : share.visibility === 'both' ? '**交付件**（visibility=both）：对方是当事方时能看'
            : '插件声明了 share，但没有给 visibility 档：照它下面这句为准'}`
          + `${share.note ? ` · ${share.note}` : ''}`
        : '**插件没有声明这个对象的可见性**（`data.object.share` 留空）⇒ 界面不替它断言"对方一定能看"：'
          + '请让对方在他那一侧打开试试，或先用同侧同事的链接核对',
        ok: share ? share.visibility !== 'side' : null },
      { key: '对方从哪个视角能打开', value: share?.other_side_view
        ? `${share.other_side_view}（${viewTitleOf(share.other_side_view)}）：${prefix}/app/${share.other_side_view}/${kind}/${id}/`
        : (others.length ? `本视图的对象类也在这些视角里被声明过：${others.map((item) => `${item.view}（${item.title}）`).join('、')}`
          : '（没有别的视角声明过这种对象类：对方只能在你这一侧看）') },
      { key: '这个对象现在在不在本视图的投影里', value: info.found
        ? '在：页头能读出来（下面就是它的标题与关键事实）'
        : `**不在**（${info.reason || 'object-not-found'}）—— 分享前先确认它在自己这一侧真的存在，`
          + '否则对方打开只是一条"如实未命中"的地址', ok: info.found === true },
    ]
    const lines = [
      `${who ? `${who.human}（${who.side}）` : '我'}在 quotagent 上把这条发给你，麻烦看一下：`,
      '',
      `· 链接（复制到浏览器打开）：{{LINK}}`,
      `· 打开后是：${viewTitleOf(view)} 视角下的 ${kind} ${id}${info.found ? `（${info.title}）` : ''}`,
      `· 你需要的身份：${identityLine}`,
      share?.requirements?.length
        ? `· 这个对象的前提（对方插件声明的）：${share.requirements.map((item) => String(item)).join('；')}`
        : `· 这个对象的前提：${share?.note || '（插件没声明额外的前提）'}`,
      `· 如果打不开：那是**如实未命中**（地址里写的是别家/别的视角看不到的东西时不会回落成"能看"）。`
        + `在你那一侧找同名的对象入口，或回我一句"看不到 ${kind} ${id}"`,
      others.length ? '· 同一个 id 在其它视角下的地址（对方那一侧更可能直接命中）：{{ALT_LINKS}}' : '',
    ].filter((line) => line !== '')
    const out = { view, kind, id, path, view_title: viewTitleOf(view), found: info.found === true,
      title: info.title ?? '', subtitle: info.subtitle ?? '',
      facts: (info.facts ?? []).slice(0, 12), reason: info.reason ?? '', next_action: info.next_action ?? '',
      requirements, share, other_views: others,
      email: { subject: `【quotagent】${info.title || `${kind} ${id}`}：请你处理`,
        lines, link_token: '{{LINK}}', alt_links_token: '{{ALT_LINKS}}',
        recipient: String(input.recipient ?? '').trim(), note: String(input.note ?? '').trim() },
      identity: who ? { human: who.human, side: who.side } : null,
      ledger: 'zero-management' }
    return { ok: true, code: 'share-ready', ledger_added: 0,
      note: '分享只给"可复制的深链 + 对方需要什么身份/侧 + 一封可直接粘出去的邮件正文"：'
        + '它不写账本、不落文件、不发邮件（发不发由你把这段文字放到你的邮件客户端里决定）',
      next_action: info.found
        ? '复制深链或邮件正文发给对方；对方打开时按上面写的身份/侧登录'
        : `先修这条地址：${info.next_action || '换一个本视图里真实存在的 id'}`,
      result: { share: out, deep_link: path } }
  }

  /** 分享/导出这两个机制贡献（外壳自带、同样可卸载/重建）：注册返回可撤销的贡献数组。 */
  const syncShare = () => {
    const out = []
    if (!surface.findAction('share.object')) {
      out.push(surface.action({ plugin_id: SHARE_PLUGIN_ID, id: 'share.object', title: '分享（深链 + 邮件正文）',
        views: shareBusinessViews(), group: '分享', order: -6, icon: '↗', placement: ['toolbar', 'command'],
        hint: '给你一条**可复制的深链**、明确写出**对方需要什么身份/侧才能看**，并一键拼成**可直接粘贴的邮件正文**；'
          + '分享不写账本、不落文件、不发邮件',
        input: { fields: [
          { name: 'kind', label: '对象类', type: 'text', required: true, from_route_kind: true,
            help: '当前对象地址里的对象类（对象页上会自动带上）' },
          { name: 'id', label: '对象 id', type: 'text', required: true, from_route: true,
            help: '当前对象地址里的 id（对象页上会自动带上）' },
          { name: 'recipient', label: '收件人（对方的登录名，可空）', type: 'text',
            help: '只写进邮件正文的抬头，方便对方对上是给他的' },
          { name: 'note', label: '附一句话（可空）', type: 'textarea' },
        ] },
        server: async (ctx, input) => composeShare({ ctx, input, who: ctx.identity }) }))
    }
    return out
  }
  const shareContributions = syncShare()

  // ------------------------------------------------------------------ 机制贡献：**导出模板可配**（列选择）
  const EXPORT_PLUGIN_ID = 'system/webui-export'
  const reportsOfView = (view) => surface.reports().filter((item) => item.views.includes(view))
  const exportPaneRows = (view, who) => {
    const list = view === 'home' ? surface.reports() : reportsOfView(view)
    const mine = who ? exportPrefsApi.all(who.side, who.human) : []
    return list.map((item) => {
      const saved = mine.find((entry) => entry.report_id === item.id) ?? null
      const declared = (item.columns ?? []).map((column) => column.key)
      return { id: item.id, report_id: item.id, title: item.title,
        views: item.views.join(' / '), formats: item.formats.join(' / '),
        columns_declared: declared.length ? declared.join(' ') : '（未声明列：这份导出不支持列选择）',
        columns: saved ? saved.columns.join(' ') : '', save_action: 'export.columns',
        selection: saved ? `${saved.columns.length}/${declared.length} 列（你选的）` : `全部 ${declared.length} 列（默认）`,
        saved_at: saved ? saved.saved_at : '' }
    })
  }
  const syncExport = () => {
    const out = []
    if (!surface.findAction('export.columns')) {
      out.push(surface.action({ plugin_id: EXPORT_PLUGIN_ID, id: 'export.columns',
        title: '导出：这里有哪几列（个人偏好）', views: views.length ? views : ['home'],
        group: '导出', order: 34, icon: '▦', placement: ['toolbar', 'inline', 'command', 'context'],
        hint: '列选择是**你的个人偏好**：按会话身份落 0600（换浏览器、换设备仍是这套列）；'
          + '它不写账本、不改导出内容（内容永远由插件自己从它那一侧的事实生成）',
        input: { fields: [
          { name: 'report_id', label: '哪一份导出（report id；留空 = 只看）', type: 'text', required: false,
            help: '从「导出模板（列选择）」面板的行里取；**留空只读**：列出你现在这套列选择（不改任何东西）' },
          { name: 'columns', label: '要哪几列（列 key，空格/逗号分隔；留空 + 勾上「用全部列」= 还原）',
            type: 'textarea', help: '例：no rank quote_id score package_id —— 顺序按声明的顺序，勾掉的列就不再导出' },
          { name: 'reset', label: '用全部列（清掉我这套选择）', type: 'checkbox', default: false },
        ] },
        server: async (ctx, input) => {
          const who = ctx.identity
          const reportId = String(input.report_id ?? '').trim()
          if (!who || !who.human) {
            return { ok: false, code: 'identity-required', ledger_added: 0,
              reason: '列选择要按**你的身份**存（0600 文件）：当前请求没有会话身份',
              next_action: `先去 ${prefix}/identity/?next=${prefix}/ 登录，再挑列 —— 这一次什么都没写` }
          }
          // **只读模式**（`report_id` 留空）：列出"我现在这套列选择" + 每份导出的列 —— 不改任何东西。
          // 界面用它把「列…」按钮上的 N/M 与勾选状态填对（对象页上没有那块面板时也读得到真源）。
          if (reportId === '') {
            const reports = surface.reports().map((item) => ({ id: item.id, title: item.title,
              columns: (item.columns ?? []).map((column) => column.key), views: item.views, formats: item.formats }))
            return { ok: true, code: 'export-columns-read', ledger_added: 0,
              note: '只读：没有写任何东西（这一条不落账本、也不改你的偏好）',
              result: { export_prefs_all: exportPrefsApi.all(who.side, who.human), reports,
                file: exportPrefsFile(), mode: '0600' } }
          }
          const decl = surface.reports().find((item) => item.id === reportId) ?? null
          if (!decl) {
            return { ok: false, code: 'unknown-report', ledger_added: 0,
              reason: `注册面里没有这份导出：${JSON.stringify(reportId)}`,
              next_action: `现成的导出：${surface.reports().map((item) => item.id).join(' / ') || '（一个都没有）'}` }
          }
          const declared = (decl.columns ?? []).map((column) => column.key)
          if (!declared.length) {
            return { ok: false, code: 'report-has-no-columns', ledger_added: 0,
              reason: `这份导出（${reportId}）没有声明 columns：没有可选的列`,
              next_action: '这份导出按插件给的全部列走（要在界面上配列，得先让声明它的插件给出 report.columns）' }
          }
          const at = host.now()
          const clearing = input.reset === true || input.reset === 'true'
          if (clearing) {
            const wrote = exportPrefsApi.set({ side: who.side, human: who.human, at, reportId, columns: [], clear: true })
            if (!wrote.ok) return { ...wrote, ledger_added: 0 }
            clearReadCache()
            return { ok: true, code: 'export-columns-reset', ledger_added: 0,
              note: '你这套列选择已经清掉：这份导出回到**全部列**（偏好落 0600，账本零新增）',
              next_action: '下次导出就是全部列了；想再挑一次就重开这个动作',
              result: { export_prefs: { report_id: reportId, columns: declared, reset: true, file: wrote.file,
                mode: '0600', ledger: 'zero-management' } } }
          }
          const wanted = String(input.columns ?? '').split(/[\s,，、]+/).map((item) => item.trim()).filter(Boolean)
          const unknown = wanted.filter((key) => !declared.includes(key))
          if (unknown.length) {
            return { ok: false, code: 'unknown-column', ledger_added: 0,
              reason: `这些列不在这份导出里：${unknown.join(' / ')}`,
              next_action: `这份导出的列：${declared.join(' / ')}（写成空格隔开的列 key）` }
          }
          if (!wanted.length) {
            return { ok: false, code: 'columns-required', ledger_added: 0,
              reason: '没有给列（要挑列就写列 key；要还原成全部列请勾上「用全部列」）',
              next_action: `从这些列里挑：${declared.join(' / ')}` }
          }
          // 按**声明的顺序**存，免得界面上的列序跟着人的手抖跑
          const ordered = declared.filter((key) => wanted.includes(key))
          const wrote = exportPrefsApi.set({ side: who.side, human: who.human, at, reportId, columns: ordered })
          if (!wrote.ok) return { ...wrote, ledger_added: 0 }
          clearReadCache()
          const dropped = declared.filter((key) => !ordered.includes(key))
          return { ok: true, code: 'export-columns-saved', ledger_added: 0,
            note: `你这套列选择已按身份存下（${ordered.length}/${declared.length} 列；0600 文件，账本零新增）`
              + `${dropped.length ? `：不再导出 ${dropped.join(' / ')}` : ''}`,
            next_action: '换浏览器/换设备照样是这套列（读回同一份 0600 文件）；下次导出时会在预览里写明用了哪几列',
            result: { export_prefs: { report_id: reportId, columns: ordered, dropped, saved_at: at,
              file: wrote.file, mode: '0600', ledger: 'zero-management' } } }
        } }))
    }
    // 面板：**哪些视图有导出**是随插件装载变的 ⇒ 每次同步只补新出现的那些视图（卸载插件后它的
    // 导出消失，面板会变成"没有任何导出声明"的空表 —— 如实，不假装）。
    for (const view of views) {
      const wanted = reportsOfView(view).length > 0 || view === 'home' ? view : ''
      if (wanted === '' || exportPanelViews.has(wanted)) continue
      exportPanelViews.add(wanted)
      out.push(surface.panel({ plugin_id: EXPORT_PLUGIN_ID, id: `export.prefs-${wanted}`,
        title: '导出模板（列选择是**你的**个人偏好）', view: wanted, order: 92, kind: 'table',
        actions: ['export.columns'], row_actions: ['export.columns'],
        hint: '勾掉不要的列 ⇒ 这份导出以后只出你选的列；偏好按会话身份落 0600（换浏览器/换设备仍在）',
        data: (ctx) => {
          const who = ctx?.identity ?? null
          const rows = exportPaneRows(wanted, who)
          const prefs = {}
          for (const item of (who ? exportPrefsApi.all(who.side, who.human) : [])) prefs[item.report_id] = item
          return { ok: true, kind: 'table',
            columns: [{ key: 'title', label: '这份导出' }, { key: 'report_id', label: 'report id', type: 'code' },
              { key: 'views', label: '出现在' }, { key: 'formats', label: '格式', type: 'code' },
              { key: 'selection', label: '你的列选择' }, { key: 'columns', label: '列 key（改这里再提交）' },
              { key: 'saved_at', label: '保存时刻' }],
            rows, degraded: !who || rows.length === 0,
            reason: !who ? 'identity-required' : (rows.length ? null : 'no-report-declared'),
            export_prefs: prefs, counts: { reports: rows.length },
            next_action: !who
              ? '登录后这里的列选择才是「你的」（服务端按会话身份存 0600；换浏览器/换设备仍在）'
              : (rows.length ? '行内「导出：这里有哪几列」改你的列选择（「用全部列」还原）'
                : '还没有插件声明导出（`surface.report`）⇒ 没有可配列的模板'),
            note: `偏好落 ${exportPrefsApi.describe(who ? who.side : '', who ? who.human : '').file}（0600，按身份；`
              + '**不是账本**：列选择是你自己的看法）。导出内容仍然**只由插件自己那一侧的事实生成**，'
              + '外壳只按你选的列做序列化。' } } }))
    }
    return out
  }
  const exportPanelViews = new Set()
  const exportContributions = syncExport()

  /** 机制贡献的**重建**（卸载后不让"分享 / 导出列选择"入口被一次误卸载永久干掉）。 */
  const syncMechanismContributions = () => syncShare().concat(syncExport())

  // ------------------------------------------------------------------ 外壳 HTML（单页应用；脚本只来自本服务）
  const shellHtml = (route) => {
    const safe = normRoute(route)
    const title = safe.kind !== '' ? `${safe.kind} ${safe.id}` : (safe.view === 'home' ? '工作台' : safe.view)
    const initial = JSON.stringify({ prefix, route: { view: safe.view, panel: safe.panel, kind: safe.kind,
      id: safe.id } }).replace(/</g, '\\u003c')
    // **无脚本回退导航**：脚本没跑起来（或禁用 JS / 爬虫 / 屏幕阅读器）时，人也能到达每一道与上手页 ——
    // 这是可访问性与渐进增强，不是"第二套页面"：正式界面仍由客户端按注册面渲染。
    const fallback = ['', 'contractor/', 'supplier/', 'ops/', 'admin/', 'start/']
      .map((path) => `<a href="${prefix}/${path}">${esc({ '': '工作台', 'contractor/': '承包商视角',
        'supplier/': '供应商视角', 'ops/': '运维视角', 'admin/': '系统管理',
        'start/': '上手（token／配置放哪里？）' }[path] ?? path)}</a>`).join(' · ')
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.page_title ?? 'quotagent')} · ${esc(title)}</title>
<link rel="stylesheet" href="${prefix}/assets/app.css">
<script type="application/json" id="q-boot">${initial}</script>
</head><body>
<div id="q-app">
  <header class="q-top" id="q-top" role="banner"></header>
  <nav class="q-tabs" id="q-tabs" aria-label="打开的标签页"></nav>
  <div class="q-banners" id="q-banners" aria-live="polite"></div>
  <main class="q-main" id="q-view" role="main" aria-label="主内容" tabindex="-1"></main>
  <footer class="q-status" id="q-status" role="contentinfo" aria-label="状态栏"></footer>
</div>
<div class="q-toasts" id="q-toasts" aria-live="polite"></div>
<noscript><p>本页需要 JavaScript 才能渲染注册面（面板/动作/通知）。无脚本回退导航：</p></noscript>
<nav class="q-fallback" data-shell-fallback="1">${fallback}</nav>
<script src="${prefix}/assets/app.js" defer></script>
</body></html>`
  }

  const asset = (name) => {
    const file = join(root, 'src', 'system', 'webui', 'code', 'assets', name)
    try { return { ok: true, body: readFileSync(file, 'utf8') } } catch (err) {
      return { ok: false, code: 'asset-missing', reason: flat(err) }
    }
  }

  const surfaceJson = () => ({
    ok: true, service: 'quotagent-webui', surface_version: SURFACE_VERSION,
    mechanism: '扩展注册面：视图/面板/区块 + 交互（字段/表格/快捷键/右键/内联）+ 动作与命令（含服务端一半）'
      + ' + 通知与状态 + **对象深链**（面板/动作声明 object_kind，地址 /app/<view>/<kind>/<id>）；外壳只做机制、'
      + '不懂业务语义',
    prefix,
    views: [...views].map((view) => ({ id: view,
      title: config.view_titles?.[view] ?? ({ home: '工作台', contractor: '承包商', supplier: '供应商',
        ops: '运维', admin: '系统管理' }[view] ?? view),
      object_kinds: surface.objectKindsFor(view),
      external: ['ops', 'admin'].includes(view) ? `${prefix}/${view}/` : null })),
    deep_link: { pattern: `${prefix}/app/<view>/[<kind>/<id>/]`,
      note: '视图地址 `…/app/<view>/`；**对象地址** `…/app/<view>/<kind>/<id>/`（kind 由插件声明 object_kind，'
        + '刷新不丢、可复制分享；对方视角打开同一 id 只会在它自己的投影里找不到 ⇒ 如实未命中）' },
    io: { python_spawns: ioStats.spawns, python_read_spawns: ioStats.read_spawns,
      read_cache_hits: ioStats.read_hits, read_cache_ttl_ms: readCacheTtlMs, cache_clears: ioStats.cache_clears,
      // **账本只读备忘**（P13）：`parses` = 真读盘 + 逐行 JSON.parse 的次数、`memo_hits` = 走备忘的次数。
      // 这是"并发卡死"的定位与修复的可对账读数：修前每次提问都真读一遍（hits≈0），修后只读一次。
      ledger: ledgerStats ? { ...ledgerStats } : null,
      // **渲染准入与背压**（P13）：事件循环滞后读数 + 被拒次数（`shed_ms=0` 表示关闭）。
      admission: { ...admissionStats, shed_ms: shedMs,
        note: '事件循环滞后 ≥ shed_ms 时，新到的**重读**请求回 429 + Retry-After（code=ui-busy）并说明多久后重试；'
          + '动作/身份/偏好/健康不受影响。真读数，不是估计值' },
      notify_cache_ttl_ms: notifyCacheTtlMs,
      // **上一次页面渲染**的代价（本批新增）：`spawns` = 这一次 `/api/ui/panels` 起了几个 Python 进程。
      // 用途：长列表改造前后的"渲染耗时 / DOM 节点数 / Python spawn 次数"三件套里最后一件的前后对照。
      last_render: ioStats.last_render ?? null,
      // **跨面板去重**（机制）：同一件事被两块面板各列一次时合并成一条（判据 = 条目上的 `dedupe_key`）。
      dedupe: { schema: 'quotagent/webui-item-dedupe/v1', key: 'item.dedupe_key',
        scope: '同一视图内、**跨面板**；同一块面板内部的重复不动',
        winner: '面板按 `order` 先出现的那一条',
        merges: ['级别取更急的一档', 'ref/action/bucket/bucket_label/preset/label 缺的补上（合并后仍可点进对象页）',
          'merged_count / also_from[{panel_id,plugin_id}] 如实写清还有哪块面板也列了它'],
        reading: ioStats.last_render
          ? { deduped: ioStats.last_render.deduped ?? 0, panels: ioStats.last_render.dedupe_panels ?? 0 } : null,
        note: '重复占位不是"多给点信息"，它让计数说谎（两块面板各列同一批门 ⇒ 本侧计数 2×）。'
          + '外壳不认识任何对象类：它只比较插件自己给的 `dedupe_key` 字符串' },
      // **通知的名额分配**（本批新增）：产出 / 返回 / 上限 / 窗口 —— 截断与可翻到哪一条都如实写。
      notify: ioStats.notify ?? null,
      // **通知窗口**（本批新增）：通知中心走的就是面板那一套服务端窗口（`w=1` + `pq.notify`）。
      notify_window: { schema: 'quotagent/webui-notify-window/v1', block_id: NOTIF_BLOCK_ID,
        request: `w=1&pq={"${NOTIF_BLOCK_ID}":{"size":25,"page":0,"kw":"","chip":"all|unread|todo|bad",`
          + '"tag":"","level":"info|warn|bad","muted":["<插件 id>"]}}',
        sizes: [...WINDOW_SIZES], default_size: WINDOW_DEFAULT_SIZE, cap: NOTIF_CAP,
        reads: '未读由**服务端**按会话身份存的已读集合算（`/api/ui/notif-state`）；未登录 ⇒ `unread.known=false`，'
          + '界面如实说"未读只按本页算"',
        note: '不带 `w` 的旧调用仍是"整份 + 上限 600 条"（脚本一字不变）；界面走窗口 ⇒ 只回这一页、'
          + '计数/未读/还剩多少都在全集上算，**全部产出都能翻到**' },
      // **服务端窗口（分页/筛选/排序）**：口径、默认值、上限、请求参数 —— 界面与对账脚本都读它。
      window: windowDescribe(),
      note: '只读工具调用（插件声明 read:true）按「工具+参数」缓存 TTL；任何一次动作/落待办件都会清空缓存；'
        + '`last_render`/`notify` 是"上一次渲染"的读数（只为可对账，不影响结果）' },
    registries: surface.snapshot(),
    actions: surface.byKind('action').map((action) => ({ id: action.id, title: action.title,
      views: action.views, group: action.group, icon: action.icon, placement: action.placement,
      inline: action.inline, context_menu: action.context_menu, shortcut: action.shortcut,
      input: action.input, permission: action.permission, confirm: action.confirm, hint: action.hint,
      object_kind: action.object_kind, plugin_id: action.plugin_id,
      // **乐观并发声明**（元数据；`state`/`object_id` 是插件自己的实现，不进接口）：
      // 有它 ⇒ 这个动作保存的是"哪个可编辑对象"，界面把"你看到的那一版"填进 `expected_version`。
      concurrency: action.concurrency
        ? { object_class: action.concurrency.object_class, label: action.concurrency.label,
          id_field: action.concurrency.id_field, expected_field: action.concurrency.expected_field,
          object_id: action.concurrency.object_id ? '<插件自己算>' : null,
          expected_version: true }
        : null })),
    panels: surface.byKind('panel').map((panel) => ({ id: panel.id, title: panel.title, view: panel.view,
      panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, order: panel.order,
      object_kind: panel.object_kind, plugin_id: panel.plugin_id })),
    // **通知源**（机制）：只给元数据。界面拿它做「按插件静音」的下拉候选（不必把全量通知拉下来才知道有谁）。
    notification_sources: surface.byKind('notification-source').map((item) => ({ id: item.id, title: item.title,
      view: item.view, order: item.order, plugin_id: item.plugin_id })),
    // **导出 / 打印**（`report` 贡献）：只给元数据（谁声明的、什么对象类、哪几种格式、真干活的动作是哪个）。
    reports: surface.reports().map((item) => ({ id: item.id, title: item.title, views: item.views,
      view: item.view, object_kind: item.object_kind, formats: item.formats, action: item.action,
      columns: item.columns, hint: item.hint, order: item.order, plugin_id: item.plugin_id })),
    reports_note: '导出/打印是**声明**：内容由声明的那个动作（插件自己的服务端一半）生成 —— 外壳不生成内容、'
      + '也不解读它导出的是什么；插件的两个一半都在这里（谁的事实谁导出）。`columns` 是**列元数据**：'
      + '界面拿它做「列选择」（个人偏好，按身份落 0600 ⇒ 换浏览器/换设备仍在，见本 JSON 的 `export_prefs`）。',
    shortcuts: surface.shortcuts().map((item) => ({ keys: item.keys, action: item.action, title: item.title,
      plugin_id: item.plugin_id })),
    shell_shortcuts: SHELL_SHORTCUTS,
    // **同侧协作**（指派/转交、关注、评论与 @同事、活动流、已读）：外壳机制的一部分，同样按注册面撤销。
    // 这里给出它的存储自述 —— 用来对账"它没进账本、也没进投影"（`why_not_ledger` 是判据本身）。
    collab: { ...collab.describe(), contributions: collabSurface.contributions,
      object_panels: collabSurface.objectPanels, plugin_id: COLLAB_PLUGIN_ID,
      http: { object: `${prefix}/api/collab/object?view=<view>&kind=<kind>&id=<id>`,
        hub: `${prefix}/api/collab/hub`, store: `${prefix}/api/collab/store` } },
    // **人员名册与角色**（同侧成员 / 角色 / 直属关系 / 按角色限动作）：外壳机制的一部分，同样按注册面撤销。
    // 这里给出它的存储自述与**策略读数** —— 用来对账"它没进账本、也没进投影"，以及"谁有额度"。
    people: { ...people.describe(), contributions: peopleSurface.contributions,
      panels: peopleSurface.panelCount, plugin_id: PEOPLE_PLUGIN_ID,
      http: { roster: `${prefix}/api/people/roster`, suggest: `${prefix}/api/people/suggest`,
        store: `${prefix}/api/people/store` } },
    // **乐观并发**（对象版本/指纹）：哪些动作受保护、版本落在哪、冲突时给出什么（机制，不是账本事实）。
    versions: { ...versionsApi.describe(''), guarded_actions: surface.byKind('action')
      .filter((action) => action.concurrency)
      .map((action) => ({ action: action.id, plugin_id: action.plugin_id,
        object_class: action.concurrency.object_class, label: action.concurrency.label,
        id_field: action.concurrency.id_field, expected_field: action.concurrency.expected_field })) },
    // **分享**（深链 + 对方需要什么身份/侧 + 邮件正文）：入口是一个动作，不落任何东西。
    share: { plugin_id: SHARE_PLUGIN_ID, action: 'share.object', contributions: shareContributions.length,
      http: { note: '分享没有独立路由：入口是 `share.object` 动作（走同一个动作总线）' },
      mechanism: '分享只拼"可复制的深链 + 对方需要什么身份/侧 + 可直接粘贴的邮件正文"：'
        + '它不写账本、不落文件、不发邮件；"对方能不能看"由插件在 `data.object.share` 里声明，'
        + '插件没声明时界面**不替它断言**（会如实说"插件没声明，无法断言"）' },
    // **导出模板可配**（列选择 = 个人偏好，0600）：外壳只做列过滤与序列化，内容仍由插件生成。
    export_prefs: { plugin_id: EXPORT_PLUGIN_ID, action: 'export.columns',
      contributions: exportContributions.length, ...exportPrefsApi.describe('', ''),
      http: { note: '列选择没有独立路由：入口是 `export.columns` 动作（走同一个动作总线）' },
      source: 'report.columns（插件声明的列元数据）' },
    // **沙盘 / 演示数据**（机制）：谁能造一组可看的流转、步骤由谁声明、数据落在哪、怎么清。
    sandbox: { plugin_id: SANDBOX_PLUGIN_ID, state_file: sandboxStateFile,
      dir: join(sharedDir, 'sandbox'), on: sandboxScopes.length > 0,
      max_actors: SANDBOX_MAX_ACTORS, schema: SANDBOX_SCHEMA,
      actors: surface.scenarios().length, contributions: sandboxContributions.filter((item) => item.ok !== false)
        .map((item) => ({ kind: item.kind, id: item.id })),
      scenarios: surface.scenarios().map((group) => ({ scenario: group.scenario, title: group.title,
        step_count: group.step_count, contributors: group.contributors.map((item) => item.plugin_id),
        steps: group.steps.map((step) => ({ action: step.action, as: step.as?.side ?? '',
          view: step.view, declared_by: step.plugin_id, optional: step.optional === true })) })),
      why_not_ledger: '沙盘账本在 <ui_shared>/sandbox/<身份>/ 下：它**是**账本事件（同一批写者写的），'
        + '但不是真实账本那一份；清空 = 删目录，真实账本零新增',
      http: { note: '沙盘没有独立路由：入口是 `sandbox.seed` / `sandbox.clear` 两个动作（走同一个动作总线）' } },
    plugins: [...contributions.entries()].map(([plugin_id, info]) => ({ plugin_id,
      entries: info.entries ?? [], error: info.error ?? null, unloaded: info.unloaded === true })),
    next_action: '动作一律 POST ' + `${prefix}/api/action/<id>` + '（含 JSON 入参）；'
      + '写动作最终由插件自己的服务端一半落 0600 待办件、再由 Python 侧唯一写者落账本',
  })

  return { surface, host, loadContributions, unload, loadPlugin, reloadPlugin, pluginsJson, runAction,
    panelsOf, objectOf, notifications, statusItems, normalizeRoute: normRoute, ioStats, clearReadCache,
    // **渲染准入/背压**（P13）：路由在跑"重读"之前问一次 —— 过载时回 429 + Retry-After（如实报忙）。
    admission, admissionStats, ledgerStats: ledgerStats ?? null, notifyCacheTtlMs,
    // **服务端窗口**（分页/筛选/排序/计数）：路由只调 `windowSpec`（解析请求）与 `windowDescribe`（自述）。
    windowSpec: parseWindowRequest, windowDescribe,
    surfaceJson, shellHtml, asset, scanContributions, runPython, stage,
    // **同侧协作**（机制）：HTTP 路由（`webui.mjs`）按会话身份拿侧与 actor，再调这里的四件事。
    collab, collabSurface, syncCollab, configureCollab, collabPluginId: COLLAB_PLUGIN_ID,
    // **人员名册与角色**（机制）：HTTP 路由按会话身份拿侧；`collab` 的候选名单也从它来。
    people, peopleSurface, syncPeople, configurePeople, peoplePluginId: PEOPLE_PLUGIN_ID,
    // **沙盘 / 演示数据**（机制）：场景由插件声明、外壳只串联；清空只删沙盘目录。
    sandbox: { describe: sandboxDescribe, run: runScenario, clear: (human) => sandboxWipe(human),
      entry: (human) => sandboxEntry(human), pluginId: SANDBOX_PLUGIN_ID, stateFile: sandboxStateFile },
    // **乐观并发 / 分享 / 导出列选择**（机制）：HTTP 侧与验证脚本按会话身份用这三样。
    versions: { current: (side, objectClass, objectId) => versionCurrent(side, objectClass, objectId),
      describe: (side) => versionsApi.describe(side), guard: (payload) => versionGuard(payload) },
    exportPrefs: exportPrefsApi,
    share: { pluginId: SHARE_PLUGIN_ID, actionId: 'share.object', compose: composeShare },
    exportPluginId: EXPORT_PLUGIN_ID, syncMechanismContributions,
    get contributions() { return contributions } }
}
