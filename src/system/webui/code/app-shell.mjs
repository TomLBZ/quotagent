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
  sessionsFile = '', sides = [] }) {
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

  /** 清空只读缓存（任何一次可能改变事实的动作前后都调它：界面绝不读旧值）。 */
  const clearReadCache = () => {
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
     */
    report: (spec) => buildReport(spec, { now: host.now() }),
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
   * 某视图上面板的数据。
   * `route.kind` 非空 ⇒ **对象页**：只渲染声明了该 `object_kind` 的面板（其余面板在这一页上不出现），
   * 且 `ctx.route` 带上 `kind/id` 供插件渲染那一个对象；没声明过该对象类 ⇒ 返回空数组（调用方报未命中）。
   * `who` = 本次请求的会话（可选；插件从 `ctx.identity` 拿"同侧人类之间"的协作身份与侧）。
   */
  const panelsOf = (view, route = {}, who = null) => withSandbox(who, () => {
    const normalized = normRoute({ ...route, view })
    const picked = normalized.kind === '' ? surface.panelsFor(view, '')
      : surface.panelsFor(view, normalized.kind)
    const ctx = panelCtx(view, normalized, who)
    // 一次渲染的作用域：这一页上的多块面板读同一个只读工具时**只起一个进程**（缓存见 `runPython`）。
    return withRenderScope(() => picked.map((panel) => {
      const base = { id: panel.id, title: panel.title, plugin_id: panel.plugin_id, order: panel.order,
        panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, hint: panel.hint,
        object_kind: panel.object_kind, wide: panel.placement === 'wide' }
      try {
        if (panel.when && panel.when(ctx) !== true) return { ...base, visible: false, data: null }
      } catch (err) {
        return { ...base, visible: true, error: { code: 'when-failed', reason: flat(err) },
          next_action: '修面板的 when（可见性条件抛错时不渲染该面板，但如实报错）' }
      }
      try {
        const data = panel.data(ctx)
        if (!data || typeof data !== 'object') {
          return { ...base, visible: true, error: { code: 'invalid-data', reason: 'data() 没有返回对象' } }
        }
        const kind = data.kind ?? panel.panel_kind
        if (!PANEL_KINDS.includes(kind)) {
          return { ...base, visible: true, error: { code: 'unknown-panel-kind', reason: `kind=${kind}` } }
        }
        // `files` 面板的**地址纪律**（机制，与 `suggest_url` 同一口径）：下载地址与上传地址只允许**本服务
        // 前缀相对路径**（`/` 开头）—— 外站地址一律丢掉并如实计数（界面不会被引去第三方取/传文件）。
        if (kind === 'files') {
          const bad = []
          const files = (Array.isArray(data.files) ? data.files : []).filter((row) => {
            const keep = Boolean(row) && typeof row === 'object' && String(row.url ?? '').startsWith('/')
            if (!keep) bad.push(String(row?.url ?? row?.name ?? '(无地址)'))
            return keep
          })
          const upload = data.upload && typeof data.upload === 'object' && String(data.upload.url ?? '').startsWith('/')
            ? data.upload : null
          if (!upload && data.upload) bad.push(String(data.upload.url ?? '(无上传地址)'))
          return { ...base, visible: true, degraded: data.degraded === true || bad.length > 0,
            reason: bad.length ? `absolute-url-refused:${bad.length}` : (data.reason ?? null),
            data: { ...data, kind, files, upload, refused_urls: bad.length,
              plugin_id: panel.plugin_id, panel_id: panel.id } }
        }
        return { ...base, visible: true, degraded: data.degraded === true, reason: data.reason ?? null,
          data: { ...data, kind, plugin_id: panel.plugin_id, panel_id: panel.id } }
      } catch (err) {
        return { ...base, visible: true, error: { code: 'data-failed', reason: flat(err) },
          next_action: '修面板的 data()（抛错不静默吞：这块不渲染，页面其余部分照常）' }
      }
    }).sort((left, right) => (left.order - right.order) || (left.id < right.id ? -1 : 1)))
  })

  /**
   * **对象页的整份数据**（`GET /api/ui/object?view=&kind=&id=`）：外壳只做机制 —— 找出"谁负责这个对象类"、
   * 把它声明的 `data.object` 页头（标题/摘要/事实/链接）按通用形状摊平、附上该对象类的动作与可用对象类清单。
   * 没有任何插件声明这个对象类 ⇒ `found:false` + 有名 reason + 下一步（**不编内容**）。
   */
  const objectOf = (view, kind, id, who = null) => {
    const kinds = surface.objectKindsFor(view)
    const claimed = kinds.includes(kind)
    const panels = claimed ? panelsOf(view, { view, kind, id }, who) : []
    const header = panels.map((panel) => (panel.data ?? {}).object).find((item) => item && typeof item === 'object')
      ?? null
    const found = claimed && panels.length > 0 && (header ? header.found !== false : true)
    // **导出 / 打印**（机制）：只摆出该对象类上被声明过的导出（`report` 贡献），并给出每个格式的入口 ——
    // 外壳不知道这些格式里是什么内容：点按钮就是打开那个动作并把 `format` 预填好。
    const reports = (found ? surface.reportsFor(view, kind) : []).filter((item) => surface.findAction(item.action))
      .map((item) => ({ id: item.id, title: item.title, plugin_id: item.plugin_id, action: item.action,
        formats: item.formats, hint: item.hint, order: item.order }))
    return {
      ok: true, view, kind, id, found,
      title: header?.title ?? (claimed ? `${kind} ${id}` : `${kind}（本视图没有这种对象）`),
      subtitle: header?.subtitle ?? '', facts: Array.isArray(header?.facts) ? header.facts : [],
      links: Array.isArray(header?.links) ? header.links : [],
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

  const notifications = (who = null) => withSandbox(who, () => withRenderScope(() => {
    const items = []
    for (const source of surface.byKind('notification-source')) {
      try {
        const out = source.poll(panelCtx(source.view || 'home', undefined, who)) || []
        for (const item of Array.isArray(out) ? out : []) {
          items.push({ id: String(item.id ?? `${source.plugin_id}:${items.length}`), level: String(item.level ?? 'info'),
            title: String(item.title ?? ''), body: String(item.body ?? ''),
            next_action: String(item.next_action ?? ''), action: item.action ? String(item.action) : '',
            ref: normRef(item.ref), at: String(item.at ?? ''), plugin_id: source.plugin_id,
            tags: normTags(item.tags),
            // `preset`：点通知上的「去处理」时，用这些键值预填动作表单（如那条通知讲的是哪个报价）
            preset: item.preset && typeof item.preset === 'object' && !Array.isArray(item.preset)
              ? item.preset : null })
        }
      } catch (err) {
        items.push({ id: `${source.plugin_id}:poll-failed`, level: 'bad', title: '通知源读取失败',
          body: flat(err), next_action: '修该通知源的 poll()', plugin_id: source.plugin_id,
          at: host.now(), ref: null, action: '', tags: [] })
      }
    }
    // 动作流水：只保留 `{kind,id}` 形状的对象引用（动作回执是任意 JSON，不能当深链用）；
    // 并且**只给自己看**（`actor` 全会话身份；未登录时看不到任何人的动作流水）。
    const me = normIdentity(who)
    for (const entry of actionLog.slice(0, 20)) {
      if (entry.actor !== (me ? me.human : '')) continue
      items.push({ ...entry, ref: normRef(entry.ref) })
    }
    return items.slice(0, 200)
  }))

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
    const scope = { action_id: action.id, staged: [], runs: [] }
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
      // 写者回执的**原始判据 + 与本动作的归属**：界面/审计据此核对"响应说的"与"账本真发生的"
      writer_consistency: writer.verdict, writer }
  }

  // ------------------------------------------------------------------ 撤销（卸载一个插件的全部贡献）
  const unload = (pluginId) => {
    // 协作面（外壳自带）：撤掉它的贡献时把机制侧的账也清干净（否则再 load 会说"已经装着"）
    if (pluginId === COLLAB_PLUGIN_ID) collabSurface.dispose()
    if (pluginId === PEOPLE_PLUGIN_ID) peopleSurface.dispose()
    // 沙盘是**外壳机制**（不是业务插件）：它的面板/动作可以被撤，但机制本身不能卸载 —— 撤完立刻重建，
    // 免得"演示数据"入口被一次误卸载永久干掉（清空沙盘的动作也在这里面）。
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
      note: '只读工具调用（插件声明 read:true）按「工具+参数」缓存 TTL；任何一次动作/落待办件都会清空缓存' },
    registries: surface.snapshot(),
    actions: surface.byKind('action').map((action) => ({ id: action.id, title: action.title,
      views: action.views, group: action.group, icon: action.icon, placement: action.placement,
      inline: action.inline, context_menu: action.context_menu, shortcut: action.shortcut,
      input: action.input, permission: action.permission, confirm: action.confirm, hint: action.hint,
      object_kind: action.object_kind, plugin_id: action.plugin_id })),
    panels: surface.byKind('panel').map((panel) => ({ id: panel.id, title: panel.title, view: panel.view,
      panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, order: panel.order,
      object_kind: panel.object_kind, plugin_id: panel.plugin_id })),
    // **导出 / 打印**（`report` 贡献）：只给元数据（谁声明的、什么对象类、哪几种格式、真干活的动作是哪个）。
    reports: surface.reports().map((item) => ({ id: item.id, title: item.title, views: item.views,
      view: item.view, object_kind: item.object_kind, formats: item.formats, action: item.action,
      hint: item.hint, order: item.order, plugin_id: item.plugin_id })),
    reports_note: '导出/打印是**声明**：内容由声明的那个动作（插件自己的服务端一半）生成 —— 外壳不生成内容、'
      + '也不解读它导出的是什么；插件的两个一半都在这里（谁的事实谁导出）',
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
    surfaceJson, shellHtml, asset, scanContributions, runPython, stage,
    // **同侧协作**（机制）：HTTP 路由（`webui.mjs`）按会话身份拿侧与 actor，再调这里的四件事。
    collab, collabSurface, syncCollab, configureCollab, collabPluginId: COLLAB_PLUGIN_ID,
    // **人员名册与角色**（机制）：HTTP 路由按会话身份拿侧；`collab` 的候选名单也从它来。
    people, peopleSurface, syncPeople, configurePeople, peoplePluginId: PEOPLE_PLUGIN_ID,
    // **沙盘 / 演示数据**（机制）：场景由插件声明、外壳只串联；清空只删沙盘目录。
    sandbox: { describe: sandboxDescribe, run: runScenario, clear: (human) => sandboxWipe(human),
      entry: (human) => sandboxEntry(human), pluginId: SANDBOX_PLUGIN_ID, stateFile: sandboxStateFile },
    get contributions() { return contributions } }
}
