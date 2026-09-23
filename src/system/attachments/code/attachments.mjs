/**
 * `system/attachments` —— **对象级附件的存储与权限**（RFQ 包 / 报价 / 变更 / 采购单 PO 都能挂文件）。
 *
 * 它解决什么（用户的硬需求，直译）：「现实采购里不能传文件、不能打印/导出」是**用不下去**的根因 ——
 * 技术规格、质检报告、回签的 PO 必须能随对象走。缺陷真源：`docs/work/plans/webui-ui-defects.md`
 * 的 DEF-029/DEF-027 家族（导出与追溯）+ 本批 P6 的「文件交换」条目。
 *
 * 四条硬约束（本文件的判据就在这里，不靠评审）：
 *  ① **附件本体不进账本**：账本只认事实（`AGENTS.md` 规则 2 + `docs/design/25-storage-plugins.md` §3
 *     「存储不得成为第二条事实写路径」）。这里只落 `<ui_shared>/attachments/` 下的 **0600** 文件
 *     （目录 0700）：`index.json`（文件名/大小/sha256/上传人/时间/对象关联）+ `blobs/<sha256>.bin`
 *     （**内容寻址**：同一份正文只存一份）+ `journal.jsonl`（**上传与删除的留痕**，append-only）。
 *     `ledger_added` 恒为 0 —— 它不是账本的第二条写路径。
 *  ② **按侧与身份校验**：下载/列表/删除都要**会话身份**；未登录 401。跨侧只在两件事同时成立时放行 ——
 *     附件声明 `visibility:'both'`（交付件）**且** 请求方的侧**确实是该对象的当事方**（该对象在本侧可见）。
 *     否则 403 `cross-side-attachment`（"另一侧不可下载"这条负控的判据）。
 *  ③ **拒绝要指名 + 零落盘**：大小/类型/文件名/对象越权/路径穿越一律**有名拒绝**（闭合 `REFUSAL_CODES`），
 *     拒绝路径上**不创建任何文件**（不给攻击者留残留，也不给"半份文件"）。
 *  ④ **原子写 + 0600**：`tmp + rename`，显式 `chmod`（不受 umask 影响）；正文只以内容寻址的名字落盘
 *     （用户给的文件名只进索引，不进路径 ⇒ 路径穿越在结构上不可能）。
 *
 * 与账本的关系（为什么不是账本事件）：附件是**交付物**而不是合同事实；把它写成事件会改变事件类型目录、
 * 证据包哈希与审计取证语义（与名册/协作面同一口径，见 `docs/design/29-webui-gui-app.md` §7/§8）。
 * 需要的可追溯性由 `journal.jsonl`（0600）+ sha256 + 上传人/时刻提供。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/** 索引文档的形状（版本进 schema；换形状要先加 ADR —— `AGENTS.md` 规则 8 的同源纪律）。 */
export const SCHEMA = 'quotagent/attachments/v1'

/** 上限（**有界**：超限一律有名拒绝，不静默截断 —— 夹取等于把错误藏起来）。 */
export const LIMITS = {
  max_bytes: 8 * 1024 * 1024,        // 单个文件 ≤ 8 MiB（默认；配置可调）
  max_name_bytes: 160,               // 文件名 ≤ 160 字节
  max_per_object: 32,                // 一个对象最多 32 个附件（活的；同一文件名的多版各占一个）
  max_attachments: 2000,             // 全库最多 2000 条索引
  max_id_bytes: 64,                  // 对象 id ≤ 64 字节
  max_index_bytes: 4 * 1024 * 1024,  // 索引文件读入上限（超过即如实报索引过大）
  max_envelope_bytes: 1024 * 1024,   // 交换信封单文件读入上限
  max_envelope_files: 60,            // 交换信封扫描文件数上限
  max_ledger_rows: 20000,            // 账本行扫描上限（有界）
  visibility_cache_ms: 2000,         // "本侧可见对象"的缓存窗口（同一屏里的多个请求只读一遍）
  max_preview_text_bytes: 256 * 1024, // 文本预览读入上限（超过 ⇒ 只预览前一段并**如实标注**）
  max_preview_render: 4,             // 界面上一屏最多内联渲染几个预览（其余给入口，不把页撑爆）
}

/** 可见性：`both` = 交付件（对方是该对象当事方就能下）；`side` = **只有上传方本侧**能下。 */
export const VISIBILITIES = ['both', 'side']

/**
 * **界内预览**（不下载也能看）的闭合集合：只做三类 —— 图片 / PDF / 文本。
 *
 * 为什么只做这三类（口径与理由）：图片与 PDF 浏览器**自带**渲染器（`<img>` / `<iframe>`，
 * 同源、不引 CDN 与外部字体）；文本按 UTF-8 解码后以**转义过的纯文本**进 `<pre>`。
 * Office / 压缩包 / 图纸（dwg、step）/ 邮件（eml）**一律不预览**：把它们塞进浏览器要么需要
 * 第三方解析器（引外网依赖），要么等于把不可信二进制交给浏览器渲染 —— 这两条都违反本批的硬约束；
 * 这一类**如实说"不预览"并给下载入口**（`preview-type-not-allowed`），不假装"加载中"。
 */
export const PREVIEW_TYPES = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  pdf: 'pdf',
  txt: 'text', csv: 'text', md: 'text', json: 'text', xml: 'text', yaml: 'text',
}
export const PREVIEW_KINDS = ['image', 'pdf', 'text']
/** 文本预览的响应类型：哪怕原文件是 csv/json，**预览就是纯文本**（浏览器不解析、不执行）。 */
export const PREVIEW_INLINE_TYPES = { image: '', pdf: '', text: 'text/plain; charset=utf-8' }

/** 一个文件名能预览成哪一类（`null` = 这一类界内不预览；判据与上传白名单同一处：按扩展名）。 */
export function previewKindOf(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  const ext = value.split('.').pop()?.toLowerCase() ?? ''
  if (value === ext || ext === '') return null
  return PREVIEW_TYPES[ext] ?? null
}
/** 预览不了时的**人话原因**（如实说明，不猜内容）。 */
export function previewRefusalReason(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  const ext = (value.split('.').pop() ?? '').toLowerCase()
  const known = Object.keys(ALLOWED_TYPES).includes(ext)
  return `这一类界内不预览：${ext ? `.${ext}` : '（没有扩展名）'}`
    + (known ? '（它是允许上传的类型，只是没有浏览器自带渲染器）' : '（这个扩展名也不在上传白名单里）')
}

/** 对象类策略（**本插件自己的声明**：哪类对象能挂附件、谁可以挂、默认给谁看）。 */
export const OBJECT_POLICY = {
  package: { label: 'RFQ 包', upload_sides: ['contractor', 'supplier'], default_visibility: 'both',
    note: '承包商发规格/图纸，供应商回技术澄清件（双方都是这个包的当事方）' },
  quote: { label: '报价', upload_sides: ['supplier', 'contractor'], default_visibility: 'both',
    note: '供应商附质检报告/规格偏离表；承包商附比价依据（双方都是这份报价的当事方）' },
  po: { label: '采购单 PO', upload_sides: ['contractor', 'supplier'], default_visibility: 'both',
    note: '承包商附技术要求；供应商**回签的 PO** 挂在这里（但要能看到这张 PO 才挂得上）' },
  change: { label: '变更单', upload_sides: ['contractor', 'supplier'], default_visibility: 'both',
    note: '变更依据、现场照片、双方确认件' },
}

/** 允许的文件类型（**按扩展名**判定，响应头也用这张表 ⇒ 客户端给的 content-type 不被信任）。 */
export const ALLOWED_TYPES = {
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8', xml: 'application/xml', yaml: 'application/yaml',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', gz: 'application/gzip',
  dwg: 'application/acad', dxf: 'application/dxf', step: 'application/step', stp: 'application/step',
  eml: 'message/rfc822', msg: 'application/vnd.ms-outlook',
}

/** 拒绝码（闭合集合；界面按码给下一步，不静默吞）。 */
export const REFUSAL_CODES = ['identity-required', 'attachment-too-large', 'attachment-type-not-allowed',
  'attachment-name-invalid', 'attachment-empty', 'attachment-id-invalid', 'attachment-not-found',
  'attachment-deleted', 'attachment-index-full', 'attachment-limit-reached', 'object-kind-not-allowed',
  'object-side-not-allowed', 'object-id-invalid', 'object-not-in-your-view', 'cross-side-attachment',
  'not-your-attachment', 'visibility-invalid', 'blob-missing', 'blob-tampered', 'storage-unavailable',
  'journal-unwritable', 'preview-type-not-allowed']

/** HTTP 状态码（回执语义：能区分的必须区分，不许一律 200）。 */
export const STATUS_FOR = {
  'identity-required': 401, 'attachment-too-large': 413, 'attachment-type-not-allowed': 415,
  'attachment-name-invalid': 400, 'attachment-empty': 400, 'attachment-id-invalid': 400,
  'attachment-not-found': 404, 'attachment-deleted': 410, 'attachment-index-full': 409,
  'attachment-limit-reached': 409, 'object-kind-not-allowed': 400, 'object-side-not-allowed': 403,
  'object-id-invalid': 400, 'object-not-in-your-view': 403, 'cross-side-attachment': 403,
  'not-your-attachment': 403, 'visibility-invalid': 400, 'blob-missing': 500, 'blob-tampered': 500,
  'storage-unavailable': 500, 'journal-unwritable': 500, 'preview-type-not-allowed': 415,
}

export const ATTACHMENT_ID_RE = /^att-[0-9a-f]{12}$/
export const OBJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/
export const SIDES = ['contractor', 'supplier']

/** 每个对象类在 JSON 文档里用哪个键指代"它自己"（本插件的声明；不猜、不模糊匹配）。 */
export const ID_KEYS = { package: 'package_id', quote: 'quote_id', po: 'po_id', change: 'change_id' }

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex')
const refusal = (code, reason, next_action, extra = {}) => ({ ok: false, code, reason, next_action, ...extra })
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const flat = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)

/** 文件名纪律：**只收一个名字**（不含路径分隔符、不含控制字符、不是 `.`/`..`）。 */
export function nameRefusal(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (value === '') {
    return refusal('attachment-name-invalid', '文件名是空的',
      '给一个文件名（含扩展名，例如 spec.pdf；不要带路径）')
  }
  if (Buffer.byteLength(value, 'utf8') > LIMITS.max_name_bytes) {
    return refusal('attachment-name-invalid', `文件名超过 ${LIMITS.max_name_bytes} 字节`,
      '把文件名改短（名字只用于展示与下载，不是身份）')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return refusal('attachment-name-invalid', '文件名含控制字符',
      '重命名后再传（控制字符会破坏回执与响应头）')
  }
  if (/[\\/]/.test(value) || value === '.' || value === '..' || value.includes('..')) {
    return refusal('attachment-name-invalid', `文件名含路径成分：${JSON.stringify(value)}`,
      '只给文件名本身（路径穿越在这里结构上不可能成立：正文按 sha256 命名，名字只进索引）')
  }
  return null
}

/** 类型纪律：按扩展名查白名单（拒绝时把允许的扩展名列出来，便于自查）。 */
export function typeRefusal(name) {
  const ext = String(name ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (name === ext || !ALLOWED_TYPES[ext]) {
    return refusal('attachment-type-not-allowed', `不接受的类型（按扩展名判定）：${ext || '(无扩展名)'}`,
      `允许：${Object.keys(ALLOWED_TYPES).sort().join(' / ')}`)
  }
  return { ok: true, ext, content_type: ALLOWED_TYPES[ext] }
}

/**
 * 建附件的**存储与权限面**（纯 Node、无外部依赖；除自己的目录外不写任何东西、不读账本以外的事实）。
 *
 * @param {object} options
 * @param {string} options.root 仓库根（相对共享目录的解析基准）
 * @param {string} options.sharedDir `<ui_shared>`（相对或绝对）
 * @param {string} [options.ledgerContractor] 承包商账本路径（只读；用来判"本侧可见哪些对象"）
 * @param {string} [options.ledgerSupplier] 供应商账本路径（只读；同上）
 * @param {string} [options.delivery] 交换信封位置（文件或目录；被邀方只读**投给自己的**那份）
 * @param {{max_bytes?: number, max_per_object?: number}} [options.limits]
 * @param {(msg: string) => void} [options.log]
 */
export function createAttachmentsStore({ root = '.', sharedDir = 'tmp/ui-shared', ledgerContractor = '',
  ledgerSupplier = '', delivery = '', limits = {}, log = null } = {}) {
  const say = (msg) => { if (typeof log === 'function') log(`[attachments] ${msg}`) }
  const shared = resolve(root, sharedDir)
  const dir = join(shared, 'attachments')
  const blobsDir = join(dir, 'blobs')
  const trashDir = join(dir, 'trash')
  const indexFile = join(dir, 'index.json')
  const journalFile = join(dir, 'journal.jsonl')
  const bounds = { ...LIMITS, ...limits }
  let indexNote = ''
  const visibilityCache = new Map()

  const ensureDir = (path, mode) => {
    mkdirSync(path, { recursive: true, mode })
    try { chmodSync(path, mode) } catch (err) { /* 文件系统不支持时尽力而为（与既有落盘同一口径） */ }
  }
  const writeAtomic = (path, payload, mode = 0o600) => {
    const tmp = join(dir, `.${path.split('/').pop()}.${process.pid}.tmp`)
    writeFileSync(tmp, payload, { encoding: 'utf8', mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  }
  const readIndex = () => {
    indexNote = ''
    try {
      const info = statSync(indexFile)
      if (info.size > bounds.max_index_bytes) {
        indexNote = `index-too-large:${info.size}`
        return { schema: SCHEMA, seq: 0, attachments: {} }
      }
      const doc = JSON.parse(readFileSync(indexFile, 'utf8'))
      if (!plain(doc) || !plain(doc.attachments)) {
        indexNote = 'index-shape-invalid'
        return { schema: SCHEMA, seq: 0, attachments: {} }
      }
      return { schema: SCHEMA, seq: Number(doc.seq) || 0, attachments: doc.attachments }
    } catch (err) {
      if (existsSync(indexFile)) indexNote = `index-unreadable:${flat(err, 120)}`
      return { schema: SCHEMA, seq: 0, attachments: {} }
    }
  }
  const writeIndex = (doc) => {
    ensureDir(dir, 0o700)
    writeAtomic(indexFile, JSON.stringify({ schema: SCHEMA, seq: doc.seq, attachments: doc.attachments },
      null, 1) + '\n')
  }
  /** 留痕（append-only，0600）：上传与删除各一行；**拒绝不写**（拒绝不该留残留）。 */
  const journal = (record) => {
    try {
      ensureDir(dir, 0o700)
      const line = JSON.stringify({ at: record.at, event: record.event, id: record.id, side: record.side,
        actor: record.actor, object: record.object, name: record.name, bytes: record.bytes,
        sha256: record.sha256, visibility: record.visibility, ...(record.extra ?? {}) }) + '\n'
      if (!existsSync(journalFile)) {
        writeFileSync(journalFile, line, { encoding: 'utf8', mode: 0o600 })
        chmodSync(journalFile, 0o600)
      } else {
        appendFileSync(journalFile, line, { encoding: 'utf8', mode: 0o600 })
      }
      return { ok: true, file: journalFile }
    } catch (err) {
      return refusal('journal-unwritable', `留痕文件写不进去：${flat(err, 160)}`,
        '先修 <ui_shared>/attachments 目录权限（0600/0700）')
    }
  }
  const journalLines = (limit = 200) => {
    try {
      return readFileSync(journalFile, 'utf8').split('\n').filter((line) => line.trim() !== '').slice(-limit)
        .map((line) => { try { return JSON.parse(line) } catch (err) { return { raw: line } } })
    } catch (err) { return [] }
  }

  // ---------------------------------------------------------------- 「本侧可见哪些对象」（越权的判据）
  /** 在 JSON 文档里按 `ID_KEYS` 收集对象 id（有界深度/宽度；不猜、不模糊匹配）。 */
  const collectIds = (value, out, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return out
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) collectIds(item, out, depth + 1)
      return out
    }
    if (!plain(value)) return out
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (ID_KEYS.package === key && text(item) !== '') out.package.add(text(item))
      if (ID_KEYS.quote === key && text(item) !== '') out.quote.add(text(item))
      if (ID_KEYS.po === key && text(item) !== '') out.po.add(text(item))
      if (ID_KEYS.change === key && text(item) !== '') out.change.add(text(item))
      collectIds(item, out, depth + 1)
    }
    return out
  }
  const emptyIds = () => ({ package: new Set(), quote: new Set(), po: new Set(), change: new Set() })
  const ledgerPathOf = (side) => (side === 'contractor'
    ? (text(ledgerContractor) || join(shared, 'contractor', 'ledger.jsonl'))
    : (text(ledgerSupplier) || join(shared, 'supplier', 'ledger.jsonl')))
  const readJsonFile = (path, cap) => {
    try {
      const info = statSync(path)
      if (!info.isFile() || info.size > cap) return null
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) { return null }
  }
  const jsonFilesIn = (path) => {
    if (path === '') return []
    try {
      const info = statSync(path)
      if (info.isFile()) return [path]
      if (!info.isDirectory()) return []
      return readdirSync(path).filter((name) => name.endsWith('.json')).sort()
        .slice(0, bounds.max_envelope_files).map((name) => join(path, name))
    } catch (err) { return [] }
  }
  const realmOfSide = (side, rows) => {
    const realm = rows.map((row) => text(row?.realm)).find((item) => item !== '')
    return realm || `${side}:unknown`
  }
  /** 信封是不是**投给本侧**的（`delivered_to` 里有本侧 realm 或本侧前缀）。 */
  const addressedTo = (doc, side, realm) => {
    const list = Array.isArray(doc?.delivered_to) ? doc.delivered_to.map(text) : []
    if (!list.length) return false
    return list.some((item) => item === realm || item.startsWith(`${side}:`))
  }
  /**
   * 本侧**可见的对象**（按 `ID_KEYS` 从三处取值，全部只读、有界）：
   *   ① 本侧账本的事实（结构性隔离：只读自己那一侧的账本）；
   *   ② `<ui_shared>/<本侧>/*.json`（本侧自己产出的交付件/请求件）；
   *   ③ 对方目录与 `--rfq-delivery` 指向的信封里 **`delivered_to` 命中本侧** 的那些。
   * 判据是"这个 id 在本侧的事实/交换件里出现过"，不是"猜它可能存在"。
   */
  const visibleObjects = (side, { fresh = false } = {}) => {
    const cached = visibilityCache.get(side)
    if (!fresh && cached && Date.now() - cached.at <= bounds.visibility_cache_ms) {
      return { ...cached.value, cached: true }
    }
    const ids = emptyIds()
    const sources = []
    const rows = []
    const ledgerFile = ledgerPathOf(side)
    try {
      const info = statSync(ledgerFile)
      if (info.isFile()) {
        const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
          .slice(0, bounds.max_ledger_rows)
        for (const line of lines) {
          try {
            const row = JSON.parse(line)
            rows.push(row)
            collectIds(row?.body, ids)
            collectIds(row?.refs, ids)
            collectIds({ package_id: row?.package_id, quote_id: row?.quote_id, po_id: row?.po_id,
              change_id: row?.change_id }, ids)
          } catch (err) { /* 坏行跳过：账本行的真源不在这里 */ }
        }
        sources.push({ kind: 'ledger', file: ledgerFile, rows: rows.length })
      }
    } catch (err) { sources.push({ kind: 'ledger', file: ledgerFile, rows: 0, reason: 'unreadable' }) }
    const realm = realmOfSide(side, rows)
    const own = join(shared, side)
    for (const file of jsonFilesIn(own)) {
      const doc = readJsonFile(file, bounds.max_envelope_bytes)
      if (doc === null) continue
      collectIds(doc, ids)
      sources.push({ kind: 'own-envelope', file, delivered: true })
    }
    const others = SIDES.filter((item) => item !== side).map((item) => join(shared, item))
    for (const other of others) {
      for (const file of jsonFilesIn(other)) {
        const doc = readJsonFile(file, bounds.max_envelope_bytes)
        if (doc === null) continue
        const mine = addressedTo(doc, side, realm) || addressedTo(Array.isArray(doc) ? { delivered_to: [] } : doc,
          side, realm)
        const list = Array.isArray(doc) ? doc : [doc]
        const delivered = list.some((item) => addressedTo(item, side, realm))
        if (!mine && !delivered) { sources.push({ kind: 'peer-envelope', file, delivered: false }); continue }
        collectIds(doc, ids)
        sources.push({ kind: 'peer-envelope', file, delivered: true })
      }
    }
    for (const file of jsonFilesIn(text(delivery))) {
      const doc = readJsonFile(file, bounds.max_envelope_bytes)
      if (doc === null) continue
      const list = Array.isArray(doc) ? doc : [doc]
      if (!list.some((item) => addressedTo(item, side, realm))) continue
      collectIds(doc, ids)
      sources.push({ kind: 'delivery', file, delivered: true })
    }
    const value = { realm, ids, sources, at: new Date().toISOString() }
    visibilityCache.set(side, { at: Date.now(), value })
    return value
  }
  /** 某个对象在本侧可见吗（越权判据；不可见 ⇒ 挂不上、也下不了）。 */
  const objectVisible = (side, kind, id) => {
    if (!SIDES.includes(side) || !OBJECT_POLICY[kind]) return false
    const seen = visibleObjects(side)
    return seen.ids[kind] ? seen.ids[kind].has(text(id)) : false
  }

  // ---------------------------------------------------------------- 读 / 写
  const entryOf = (id) => {
    const doc = readIndex()
    const entry = doc.attachments[text(id)]
    return { doc, entry: plain(entry) ? entry : null }
  }
  /** 一侧能看到这一条吗（**唯二条件**：本侧上传的 / 交付件且本侧是该对象当事方）。 */
  const canSee = (entry, side) => {
    if (entry.side === side) return true
    if (entry.visibility !== 'both') return false
    return objectVisible(side, entry.object?.kind, entry.object?.id)
  }
  /** 文件名的**归一键**（同一对象上「同名」判据：去空白 + 大小写不敏感；原始文件名只用于展示与下载）。 */
  const nameKeyOf = (name) => text(name).toLowerCase()
  /** 一个文件名在**同对象上的版本链**（活的在前、版本号降序）：`{name_key, latest, versions[], holders[]}`。 */
  const chainsOf = (entries) => {
    const chains = new Map()
    for (const entry of entries) {
      if (!plain(entry)) continue
      const key = `${text(entry.object?.kind)}\u0000${text(entry.object?.id)}\u0000${nameKeyOf(entry.name_key ?? entry.name)}`
      const chain = chains.get(key) ?? { key, object: entry.object, name: text(entry.name),
        name_key: nameKeyOf(entry.name_key ?? entry.name), versions: [] }
      chain.versions.push(entry)
      chains.set(key, chain)
    }
    for (const chain of chains.values()) {
      chain.versions.sort((left, right) => (Number(right.version) || 1) - (Number(left.version) || 1)
        || String(right.uploaded_at).localeCompare(String(left.uploaded_at)))
      chain.latest = chain.versions.find((item) => item.deleted !== true) ?? null
      chain.latest_id = chain.latest ? chain.latest.id : ''
      for (let at = 0; at < chain.versions.length; at += 1) {
        const item = chain.versions[at]
        const above = chain.versions.slice(0, at).find((other) => other.deleted !== true) ?? null
        item.superseded_by = above ? above.id : ''
      }
      chain.version_count = chain.versions.length
      chain.deleted_count = chain.versions.filter((item) => item.deleted === true).length
      chain.holders = [...new Set(chain.versions.map((item) => text(item.uploader)))]
    }
    return chains
  }
  const publicEntry = (entry) => ({ id: entry.id, name: entry.name, bytes: entry.bytes, sha256: entry.sha256,
    content_type: entry.content_type, uploader: entry.uploader, at: entry.uploaded_at, visibility: entry.visibility,
    owner_side: entry.side, object: entry.object, deleted: entry.deleted === true,
    deleted_at: entry.deleted_at ?? null, deleted_by: entry.deleted_by ?? null,
    // ---- **多版本**与**预览**（同一条索引就带着这两个口径，界面/脚本不必自己推） ----
    version: Number(entry.version) || 1, name_key: nameKeyOf(entry.name_key ?? entry.name),
    supersedes: text(entry.supersedes), superseded_by: text(entry.superseded_by),
    preview_kind: previewKindOf(entry.name), previewable: previewKindOf(entry.name) !== null,
    mine: null })

  /**
   * **上传**：正文以内容寻址落 0600 存储，索引只记元数据（文件名/大小/sha256/上传人/时间/对象关联）。
   * 一切拒绝都发生在写任何文件**之前**（零残留）。
   */
  const put = ({ side, actor, kind, id, name, body, visibility }) => {
    if (!SIDES.includes(side)) {
      return refusal('identity-required', `上传方不在两侧之内：${JSON.stringify(side)}`,
        '先在 /identity/ 登录（侧由会话给，不由请求体给）')
    }
    const who = text(actor)
    if (who === '') {
      return refusal('identity-required', '上传人（human:<名字>）是空的',
        '署名取会话身份：登录后重试')
    }
    const policy = OBJECT_POLICY[text(kind)]
    if (!policy) {
      return refusal('object-kind-not-allowed', `这类对象不能挂附件：${JSON.stringify(kind ?? null)}`,
        `能挂附件的对象类：${Object.keys(OBJECT_POLICY).join(' / ')}`)
    }
    if (!policy.upload_sides.includes(side)) {
      return refusal('object-side-not-allowed', `${side} 侧不能往「${policy.label}」上挂附件`,
        `${policy.label}的允许上传方：${policy.upload_sides.join(' / ')}`)
    }
    const objectId = text(id)
    if (!OBJECT_ID_RE.test(objectId) || Buffer.byteLength(objectId, 'utf8') > bounds.max_id_bytes) {
      return refusal('object-id-invalid', `对象 id 形状不合法：${JSON.stringify(id ?? null)}`,
        '对象 id 用小写/大写字母数字与 . _ -（1..64 字节）')
    }
    if (!objectVisible(side, text(kind), objectId)) {
      const seen = visibleObjects(side)
      const mine = [...(seen.ids[text(kind)] ?? new Set())].sort()
      return refusal('object-not-in-your-view',
        `本侧看不到这个对象（${policy.label} ${objectId}）：不能给看不见的对象挂附件`,
        mine.length
          ? `本侧可见的${policy.label}：${mine.slice(0, 8).join(' / ')}${mine.length > 8 ? ' …' : ''}`
          : `本侧现在没有任何可见的${policy.label}（先让对方投给你，或换一个对象）`)
    }
    const nastyName = nameRefusal(name)
    if (nastyName) return nastyName
    // **先判大小、再判类型**：一份 200 MiB 的 `.exe` 最该听到的是"太大"，而不是"类型不对"
    // （顺序影响用户下一步做什么；两种拒绝都仍然**有名**且零落盘）。
    if (body === null || body === undefined) {
      return refusal('attachment-empty', '请求体里没有文件内容（0 字节）',
        '传文件正文（POST 原始字节，或 JSON 里的 base64）；空文件会被拒，免得索引里出现一条点不开的条目')
    }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    if (buffer.length === 0) {
      return refusal('attachment-empty', '文件是 0 字节', '空的附件会被拒（索引里不留点不开的条目）')
    }
    if (buffer.length > bounds.max_bytes) {
      return refusal('attachment-too-large',
        `文件 ${buffer.length} 字节超过上限 ${bounds.max_bytes} 字节`,
        `拆小或压缩后再传（单文件上限 ${Math.round(bounds.max_bytes / 1024)} KiB；上限在 /api/attachments/store 里可核）`,
        { limit_bytes: bounds.max_bytes, got_bytes: buffer.length })
    }
    const typed = typeRefusal(name)
    if (!typed.ok) return typeRefusal(name)
    const want = text(visibility) || policy.default_visibility
    if (!VISIBILITIES.includes(want)) {
      return refusal('visibility-invalid', `可见性取值不认识：${JSON.stringify(visibility ?? null)}`,
        `用 ${VISIBILITIES.join(' / ')}（both = 交付件；side = 只有本侧可见）`)
    }
    const doc = readIndex()
    const live = Object.values(doc.attachments).filter((item) => item.deleted !== true)
    if (live.length >= bounds.max_attachments) {
      return refusal('attachment-index-full', `全库附件数已达上限 ${bounds.max_attachments}`,
        '先删掉不再需要的附件（删除会留痕：原件进 trash/、journal 记一行）')
    }
    const sameObject = live.filter((item) => item.object?.kind === text(kind) && item.object?.id === objectId)
    if (sameObject.length >= bounds.max_per_object) {
      return refusal('attachment-limit-reached',
        `对象 ${objectId} 上已有 ${sameObject.length} 个附件（上限 ${bounds.max_per_object}；`
          + '同一文件名的每个版本各占一个）',
        '先合并/删除不再需要的版本（删除会留痕：原件进 trash/、journal 记一行），或把它挂到别的对象上')
    }
    const sha = sha256Of(buffer)
    const key = nameKeyOf(name)
    // ---- **多版本**（同对象 + 同名 = 一条版本链；每次上传是一个新版本，**不覆盖**历史） ------------
    const sameName = live.filter((item) => item.object?.kind === text(kind) && item.object?.id === objectId
      && nameKeyOf(item.name_key ?? item.name) === key)
    const prev = sameName.slice().sort((left, right) => (Number(right.version) || 1) - (Number(left.version) || 1)
      || String(right.uploaded_at).localeCompare(String(left.uploaded_at)))[0] ?? null
    const version = prev ? Math.max(1, Number(prev.version) || 1) + 1 : 1
    // 附件 id 仍以**内容**为锚（`att-<sha256 前 12 位>`）：同一份字节只存一份正文。
    // 只有当这个 id 已经被**别的对象/别的文件名**占着时，才按「这一条是谁的」派生一个稳定的 id
    //（否则同名不同内容不会撞车，但**同一份字节挂到两个名字下**会互相覆盖 —— 那是修前的真 bug）。
    const occupant = doc.attachments[`att-${sha.slice(0, 12)}`]
    const occupantSame = plain(occupant) && occupant.object?.kind === text(kind)
      && occupant.object?.id === objectId && nameKeyOf(occupant.name_key ?? occupant.name) === key
    // 同一份字节（sha256 相同）+ 同一个对象 + 同一个文件名 + 还在（没被删） ⇒ 就是**同一条**附件：
    // 不新建版本、不改索引、不写 journal（如实说清"这不是新版本"）。比 sha 而不是比版本号：
    // 用户把 v1 的内容又传一次时，sha256 会命中 v1 那条 —— 那也说清"就是这一条"。
    const sameContent = sameName.find((item) => String(item.sha256).replace(/^sha256:/, '') === sha) ?? null
    if (sameContent !== null) {
      return { ok: true, code: 'attachment-unchanged', entry: { ...publicEntry(sameContent),
        mine: sameContent.side === side }, unchanged: true, dedup: true, ledger_added: 0,
        note: '同一份字节（sha256 相同）、同一个对象、同一个文件名：这就是**同一条**附件（不是新版本）；'
          + `它现在是 v${Number(sameContent.version) || 1}`,
        next_action: '要记成新版本：把改过的文件传上来（同名 = v' + (Number(sameContent.version) + 1)
          + '，旧版仍然可下）' }
    }
    let attachmentId = `att-${sha.slice(0, 12)}`
    if (occupant !== undefined || occupantSame) {
      // 撞了 id（同一份字节挂在别处/同一个文件名的旧版本上）⇒ 按「谁 + 哪个对象 + 哪个文件名 + 第几版」派生
      attachmentId = `att-${sha256Of(Buffer.from(`${side}|${text(kind)}|${objectId}|${key}|${sha}|v${version}`))
        .slice(0, 12)}`
    }
    const blobPath = join(blobsDir, `${sha}.bin`)
    try {
      ensureDir(dir, 0o700)
      ensureDir(blobsDir, 0o700)
    } catch (err) {
      return refusal('storage-unavailable', `附件目录建不出来：${flat(err, 160)}`,
        '先修 <ui_shared>/attachments 的权限（目录 0700）')
    }
    if (existsSync(blobPath) && statSync(blobPath).size !== buffer.length) {
      return refusal('blob-tampered', `内容寻址冲突：${sha.slice(0, 12)} 已有不同大小的正文`,
        '这是存储被改过的信号：先核对 blobs/ 目录（同一 sha256 必须同一份字节）')
    }
    if (!existsSync(blobPath)) {
      try {
        const tmp = join(blobsDir, `.${sha}.${process.pid}.tmp`)
        writeFileSync(tmp, buffer, { mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, blobPath)
      } catch (err) {
        return refusal('storage-unavailable', `正文落盘失败：${flat(err, 160)}`,
          '先修 <ui_shared>/attachments/blobs 的写权限（0600/0700）')
      }
    }
    const entry = { id: attachmentId, side, object: { kind: text(kind), id: objectId }, name: text(name),
      bytes: buffer.length, sha256: `sha256:${sha}`, content_type: typed.content_type,
      uploader: who.startsWith('human:') ? who : `human:${who}`, uploaded_at: new Date().toISOString(),
      visibility: want, deleted: false,
      // **多版本**（同一对象 + 同名 = 一条链；这一条是第几版、取代了谁）
      version, supersedes: prev ? prev.id : '', name_key: key }
    const next = readIndex()
    next.attachments[attachmentId] = entry
    next.seq = Math.max(Number(next.seq) || 0, Object.keys(next.attachments).length)
    try {
      writeIndex(next)
    } catch (err) {
      return refusal('storage-unavailable', `索引落盘失败：${flat(err, 160)}`,
        '先修 <ui_shared>/attachments/index.json 的写权限（0600）')
    }
    const trace = journal({ at: entry.uploaded_at, event: 'uploaded', id: entry.id, side, actor: entry.uploader,
      object: entry.object, name: entry.name, bytes: entry.bytes, sha256: entry.sha256, visibility: want,
      extra: { version, supersedes: entry.supersedes, replaces_name: prev ? prev.name : '' } })
    visibilityCache.delete(side)
    say(`上传 ${entry.id}（${entry.name} v${version}，${entry.bytes} B）→ ${entry.object.kind} ${entry.object.id} @ ${side}`
      + `${prev ? `（取代 v${Number(prev.version) || 1} ${prev.id}）` : ''}`)
    return { ok: true, entry: { ...publicEntry(entry), mine: true }, version, supersedes: entry.supersedes,
      preview_kind: previewKindOf(entry.name), journal_trace: trace.ok === true, dedup: existsSync(blobPath),
      ledger_added: 0,
      note: prev
        ? `同名附件的新版本（v${version}）：第 ${Number(prev.version) || 1} 版没有被覆盖 —— 它还在这条索引里，仍可下载`
        : '这是这个文件名的第 1 版（同一对象上再传同名文件会记成 v2，旧版不覆盖）',
      next_action: previewKindOf(entry.name)
        ? '界内可直接预览（图片 / PDF / 文本）：对象页的「附件：预览与版本」里不下载也能看'
        : `${previewRefusalReason(entry.name)}：需要时下载来看（预览只做图片/PDF/文本，不引外网依赖）` }
  }

  /** **列表**：某个对象上"本侧能看到的"附件（含已删除的墓碑 —— 删除要留痕，痕迹看得见）。 */
  const list = ({ side, kind, id }) => {
    if (!SIDES.includes(side)) {
      return refusal('identity-required', '未登录：读不到任何一侧的附件', '先在 /identity/ 登录')
    }
    const doc = readIndex()
    // P34：坏条目（null / 字符串 / 数组）**逐条计数，不静默丢**（口径见 `row-action-prefill.md` §4）
    const allEntries = Object.values(doc.attachments)
    const unreadable = allEntries.filter((entry) => !plain(entry)).length
    const picked = allEntries.filter((entry) => plain(entry)
      && (kind === undefined || text(kind) === '' || entry.object?.kind === text(kind))
      && (id === undefined || text(id) === '' || entry.object?.id === text(id)))
      .filter((entry) => canSee(entry, side))
    // 版本链（同对象 + 同名）：列表里每条都带上「第几版 / 最新一版是谁 / 被谁取代」
    const chains = chainsOf(picked)
    const latestOf = new Map()
    for (const chain of chains.values()) {
      for (const item of chain.versions) latestOf.set(item.id, chain.latest_id)
    }
    const rows = picked
      .sort((left, right) => String(left.uploaded_at).localeCompare(String(right.uploaded_at)))
      .map((entry) => ({ ...publicEntry(entry), mine: entry.side === side,
        latest: latestOf.get(entry.id) === entry.id,
        is_latest: latestOf.get(entry.id) === entry.id,
        superseded_by: text(entry.superseded_by),
        deletable: entry.deleted !== true && entry.side === side }))
    const names = new Set(rows.map((row) => `${row.object?.kind}/${row.object?.id}/${row.name_key}`))
    const versioned = [...names].filter((name) => rows.filter((row) =>
      `${row.object?.kind}/${row.object?.id}/${row.name_key}` === name).length > 1).length
    return { ok: true, side, kind: text(kind), id: text(id), files: rows,
      ...(unreadable > 0 ? { note: `附件索引里有 ${unreadable} 条读不出来（形状异常：不是对象）—— `
        + '好条照列、坏条已跳过并计数（不静默丢）：先修 <ui_shared>/attachments/index.json 的那几条' } : {}),
      counts: { total: rows.length, live: rows.filter((row) => !row.deleted).length,
        deleted: rows.filter((row) => row.deleted).length, mine: rows.filter((row) => row.mine).length,
        names: names.size, versioned_names: versioned,
        ...(unreadable > 0 ? { unreadable } : {}),
        previewable: rows.filter((row) => !row.deleted && row.previewable).length,
        versions: rows.reduce((sum, row) => sum + (Number(row.version) || 1), 0) },
      version_rule: '同一对象上**同名**文件每传一次就是新的一版（v1、v2…）：旧版**不覆盖**、仍可下载；'
        + '同一份字节只存一份正文（内容寻址）',
      preview_rule: '界内预览只做图片 / PDF / 文本（浏览器自带渲染器，不引外网依赖）；其余类型如实说"不预览"并给下载' }
  }

  /**
   * **版本链**（同对象 + 同名 = 一条链）：谁在什么时候换了哪一版，逐条可下（旧版也在）。
   * 只回**本侧能看到的**条目（与下载/列表同一判据）；`kind/id` 省略 ⇒ 本侧全部对象的链。
   */
  const versions = ({ side, kind, id }) => {
    if (!SIDES.includes(side)) {
      return refusal('identity-required', '未登录：读不到任何一侧的附件版本', '先在 /identity/ 登录')
    }
    const doc = readIndex()
    const picked = Object.values(doc.attachments).filter((entry) => plain(entry)
      && (kind === undefined || text(kind) === '' || entry.object?.kind === text(kind))
      && (id === undefined || text(id) === '' || entry.object?.id === text(id)))
      .filter((entry) => canSee(entry, side))
    const chains = chainsOf(picked)
    const groups = [...chains.values()]
      .sort((left, right) => `${left.object?.kind}/${left.object?.id}/${left.name_key}`
        .localeCompare(`${right.object?.kind}/${right.object?.id}/${right.name_key}`))
      .map((chain) => ({ name: chain.name, name_key: chain.name_key, object: chain.object,
        version_count: chain.version_count, deleted_count: chain.deleted_count, holders: chain.holders,
        latest_id: chain.latest_id, latest_version: chain.latest ? Number(chain.latest.version) || 1 : 0,
        versions: chain.versions.map((entry) => ({ ...publicEntry(entry), mine: entry.side === side,
          latest: chain.latest_id === entry.id, is_latest: chain.latest_id === entry.id })) }))
    return { ok: true, side, kind: text(kind), id: text(id), groups,
      counts: { groups: groups.length, versions: groups.reduce((sum, group) => sum + group.version_count, 0),
        versioned_groups: groups.filter((group) => group.version_count > 1).length,
        deleted: groups.reduce((sum, group) => sum + group.deleted_count, 0) },
      rule: '同一对象上同名文件 = 一条版本链；每条版本都有自己的 id、sha256、上传人与时刻，'
        + '旧版**不覆盖**、仍可下载（删除的版本留墓碑）' }
  }

  /**
   * **取件（界内预览）**：与下载**同一条**身份/侧/完整性判据，只是把内容按"能不能在浏览器里看"分流。
   *
   * 三类（`PREVIEW_TYPES`）：image / pdf 原样给字节（客户端 `<img>` / `<iframe>`，浏览器自带渲染器）；
   * text 按 UTF-8 解码、超上限只给前一段并**如实标注** `truncated`（不假装是全文）。
   * 其余类型 ⇒ `preview-type-not-allowed`（415）+ 人话原因 + 下载入口（不静默、不把二进制塞给浏览器）。
   * 正文仍不进账本（`ledger_added: 0`）——预览是**读**，不是第二条事实写路径。
   */
  const preview = ({ side, id, maxBytes = 0 }) => {
    const got = get({ side, id })
    if (!got.ok) return got
    const entry = got.entry
    const kind = previewKindOf(entry.name)
    if (kind === null) {
      return refusal('preview-type-not-allowed', previewRefusalReason(entry.name),
        `下载来看（${prefixHint()}）；界内预览只做图片 / PDF / 文本 —— 这一段不引任何外网依赖`,
        { preview_kinds: PREVIEW_KINDS, attachment: entry })
    }
    const cap = Math.max(1024, Number(maxBytes) > 0 ? Number(maxBytes) : bounds.max_preview_text_bytes)
    if (kind !== 'text') {
      return { ok: true, kind, entry, body: got.body, truncated: false, previewed_bytes: got.body.length,
        total_bytes: got.body.length, inline_content_type: entry.content_type,
        sha256_verified: true, ledger_added: 0 }
    }
    const truncated = got.body.length > cap
    const slice = truncated ? got.body.subarray(0, cap) : got.body
    const textBody = slice.toString('utf8')
    return { ok: true, kind, entry, body: slice, text: textBody, truncated, previewed_bytes: slice.length,
      total_bytes: got.body.length, inline_content_type: PREVIEW_INLINE_TYPES.text,
      sha256_verified: true, ledger_added: 0,
      note: truncated
        ? `文本超过预览上限（${cap} 字节）：这里只给了前 ${slice.length} 字节（**没有假装是全文**）——完整内容请下载`
        : '文本预览按 UTF-8 解码后以纯文本显示（不解析 JSON/CSV、更不执行任何东西）' }
  }
  /** 预览回执里给用户可复制的下载入口（机制：路径由插件自述，界面/脚本照抄）。 */
  const prefixHint = () => '同一对象的「附件」面板里点文件名下载（按侧与身份校验）'

  /** **取件**（下载的唯一入口）：身份 → 身份形状 → 存在 → 未删 → 侧权限 → 正文 sha256 自校验。 */
  const get = ({ side, id }) => {
    if (!SIDES.includes(side)) {
      return refusal('identity-required', '未登录：读不到附件', '先在 /identity/ 登录（侧由会话给）')
    }
    const wanted = text(id)
    if (!ATTACHMENT_ID_RE.test(wanted)) {
      return refusal('attachment-id-invalid', `附件 id 形状不合法：${JSON.stringify(id ?? null)}`,
        '附件 id 形如 att-<12 位十六进制>（列表里每条都带它的下载地址；不做路径拼接、不做通配）')
    }
    const { entry } = entryOf(wanted)
    if (entry === null) {
      return refusal('attachment-not-found', `没有这个附件：${wanted}`, '回对象的附件面板看当前有哪些（列表即真源）')
    }
    if (entry.deleted === true) {
      return refusal('attachment-deleted', `这条附件已被删除（${entry.deleted_by ?? '?'} @ ${entry.deleted_at ?? '?'}）`,
        '删除留了痕：原件在 <ui_shared>/attachments/trash/，journal.jsonl 里有一行；需要的话按流程重新上传')
    }
    if (!canSee(entry, side)) {
      return refusal('cross-side-attachment',
        `${side} 侧不能下载这条附件（它属于 ${entry.side} 侧，可见性 ${entry.visibility}）`,
        '交付件（visibility=both）要对方是该对象当事方才能下；本侧内部件（visibility=side）永远不出本侧')
    }
    const blobPath = join(blobsDir, `${String(entry.sha256).replace(/^sha256:/, '')}.bin`)
    let body = null
    try {
      body = readFileSync(blobPath)
    } catch (err) {
      return refusal('blob-missing', `正文文件缺失：${flat(err, 160)}`,
        '附件索引里有这一条、但 blobs/ 里没有正文：如实报缺失（不造一份替代正文）')
    }
    const digest = sha256Of(body)
    const want = String(entry.sha256).replace(/^sha256:/, '')
    if (digest !== want) {
      return refusal('blob-tampered', `正文与索引里的 sha256 不一致（索引 ${want.slice(0, 12)}，实际 ${digest.slice(0, 12)}）`,
        '正文被改过：这是完整性告警，先按 journal.jsonl 与上游核对，别当正常件用')
    }
    return { ok: true, entry: publicEntry(entry), body, sha256_verified: true, ledger_added: 0 }
  }

  /** **删除**（留痕）：正文移入 `trash/`（未被别的条目引用时才搬）、索引留墓碑、journal 记一行。 */
  const remove = ({ side, actor, id, reason = '' }) => {
    if (!SIDES.includes(side)) {
      return refusal('identity-required', '未登录：删不了附件', '先在 /identity/ 登录')
    }
    const who = text(actor)
    const wanted = text(id)
    if (!ATTACHMENT_ID_RE.test(wanted)) {
      return refusal('attachment-id-invalid', `附件 id 形状不合法：${JSON.stringify(id ?? null)}`,
        '附件 id 形如 att-<12 位十六进制>')
    }
    const { doc, entry } = entryOf(wanted)
    if (entry === null) return refusal('attachment-not-found', `没有这个附件：${wanted}`, '刷新附件面板看当前列表')
    if (entry.deleted === true) {
      return refusal('attachment-deleted', '这条附件已经删过了（重复删除不改任何东西）',
        '原件的痕迹在 trash/ 与 journal.jsonl 里')
    }
    if (entry.side !== side || entry.uploader !== who) {
      return refusal('not-your-attachment',
        `只能删自己上传的附件（这条由 ${entry.uploader} 上传于 ${entry.uploaded_at}）`,
        '要撤掉别人传的件，请让上传人自己删，或在协作面里说明理由（删除留痕，不是静默清除）')
    }
    const at = new Date().toISOString()
    const sha = String(entry.sha256).replace(/^sha256:/, '')
    const blobPath = join(blobsDir, `${sha}.bin`)
    const others = Object.values(doc.attachments).filter((item) => item.id !== entry.id && item.deleted !== true
      && String(item.sha256).replace(/^sha256:/, '') === sha)
    let moved = false
    if (others.length === 0 && existsSync(blobPath)) {
      try {
        ensureDir(trashDir, 0o700)
        const target = join(trashDir, `${entry.id}-${sha.slice(0, 12)}.bin`)
        writeFileSync(target, readFileSync(blobPath), { mode: 0o600 })
        chmodSync(target, 0o600)
        rmSync(blobPath)
        moved = true
      } catch (err) {
        return refusal('storage-unavailable', `删除时搬移正文失败：${flat(err, 160)}`,
          '先修 <ui_shared>/attachments 的权限；**这次没有改动任何东西**（索引未变）')
      }
    }
    const next = readIndex()
    next.attachments[entry.id] = { ...entry, deleted: true, deleted_at: at, deleted_by: who,
      trash: moved ? `trash/${entry.id}-${sha.slice(0, 12)}.bin` : '' }
    try {
      writeIndex(next)
    } catch (err) {
      return refusal('storage-unavailable', `删除后写索引失败：${flat(err, 160)}`,
        '先修 <ui_shared>/attachments/index.json 的权限（0600）')
    }
    const trace = journal({ at, event: 'deleted', id: entry.id, side, actor: who, object: entry.object,
      name: entry.name, bytes: entry.bytes, sha256: entry.sha256, visibility: entry.visibility,
      extra: { deleted_by: who, reason: text(reason), trash: moved ? `trash/${entry.id}-${sha.slice(0, 12)}.bin` : '',
        still_shared: others.length > 0 ? others.map((item) => item.id) : [] } })
    visibilityCache.delete(side)
    say(`删除 ${entry.id}（留痕：${moved ? '正文进 trash/' : '正文仍被别的条目引用'}，journal 记一行）`)
    return { ok: true, entry: publicEntry(next.attachments[entry.id]), trace: journal.ok === true, moved,
      ledger_added: 0, note: '删除**留痕**：索引留墓碑 + journal.jsonl 一行；原件按引用情况进 trash/（不是静默清除）' }
  }

  /** 自述（给界面 / 对账用）：落点、权限、上限、为什么不是账本、当前读数。 */
  const describe = () => {
    const doc = readIndex()
    const rows = Object.values(doc.attachments)
    let blobCount = 0
    let blobBytes = 0
    try {
      for (const name of readdirSync(blobsDir)) {
        try { blobBytes += statSync(join(blobsDir, name)).size; blobCount += 1 } catch (err) { /* 跳过 */ }
      }
    } catch (err) { /* 目录还没建：读数就是 0 */ }
    const modeOf = (path, fallback) => {
      try { return `0${(statSync(path).mode & 0o777).toString(8)}` } catch (err) { return fallback }
    }
    return {
      ok: true, schema: SCHEMA, service: 'quotagent-attachments', root: dir,
      dir_mode: modeOf(dir, '0700（未建）'), index_mode: modeOf(indexFile, '0600（未建）'),
      journal: journalFile, journal_lines: journalLines(1000).length,
      counts: { entries: rows.length, live: rows.filter((item) => item.deleted !== true).length,
        deleted: rows.filter((item) => item.deleted === true).length, blobs: blobCount, blob_bytes: blobBytes },
      limits: bounds,
      allowed_types: Object.keys(ALLOWED_TYPES).sort(),
      object_policy: Object.fromEntries(Object.entries(OBJECT_POLICY)
        .map(([kind, policy]) => [kind, { label: policy.label, upload_sides: policy.upload_sides,
          default_visibility: policy.default_visibility, note: policy.note }])),
      index_note: indexNote,
      why_not_ledger: '附件是**交付物**不是合同事实：`docs/design/25-storage-plugins.md` §3 要求存储不得成为'
        + '第二条事实写路径；写进账本会改事件类型目录、证据包哈希与审计取证语义（与名册/协作面同一口径）',
      visibility_rule: '下载/列表/删除都要会话身份；跨侧只在「交付件（visibility=both）**且**本侧是该对象当事方」'
        + '时放行，否则 403 cross-side-attachment',
      // **多版本**（不覆盖历史）与**界内预览**（不下载也能看）的机读口径：界面/脚本/对账都读它
      versions: { rule: '同一对象上同名文件 = 一条版本链：每传一次是新的一版（v1、v2…），'
        + '每条版本都有自己的 id / sha256 / 上传人 / 时刻，旧版**不覆盖**、仍可下载；'
        + '同一份字节只存一份正文（内容寻址：`blobs/<sha256>.bin`）',
        fields: ['version', 'supersedes', 'superseded_by', 'name_key', 'is_latest'],
        same_content: '同一份字节 + 同一个对象 + 同一个文件名 ⇒ 判为**同一条**（回执 `attachment-unchanged`），'
          + '不新建版本、不写 journal',
        bounded: { per_object: bounds.max_per_object, note: '同一文件名的每个版本各占一个名额' } },
      preview: { kinds: PREVIEW_KINDS, types: PREVIEW_TYPES,
        inline_types: PREVIEW_INLINE_TYPES,
        max_text_bytes: bounds.max_preview_text_bytes, render_max: bounds.max_preview_render,
        rule: '界内预览只做图片 / PDF / 文本：图片与 PDF 交给**浏览器自带**渲染器（同源 `<img>` / `<iframe>`，'
          + '不引 CDN / 外部字体 / 第三方解析器），文本按 UTF-8 解码后以**转义纯文本**显示；'
          + '其余类型如实说"不预览"（415 preview-type-not-allowed）并给下载入口',
        identity_rule: '预览与下载**同一条**判据：会话身份 + 交付件当事方；未登录 401，跨侧 403；'
          + '预览也是读，**不写账本**（ledger_added 恒 0）',
        truncated: '文本预览超上限只给前一段并如实标 `truncated: true`（不假装是全文）' },
      ledger_added: 0,
    }
  }

  return { dir, describe, put, get, list, versions, preview, remove, visibleObjects, objectVisible, journalLines,
    currentLimits: () => ({ ...bounds }), invalidate: () => { visibilityCache.clear(); return true } }
}

/**
 * **进程内共享的存储实例**（按 `root + ui_shared` 缓存）：插件的两个一半（`code/index.mjs` 的路由面与
 * `code/ui.mjs` 的面板面）必须看**同一份**索引与同一份可见性判据 —— 各建一个实例会让"面板说有一条、
 * 点下载 404"这种分裂成为可能。键里不含任何业务参数：同一台机器同一份共享目录 = 同一个存储。
 */
const STORES = new Map()
export function attachmentStore(config = {}) {
  const root = resolve(String(config.root ?? '.'))
  const sharedDir = String(config.sharedDir ?? 'tmp/ui-shared')
  const key = `${root}\u0000${sharedDir}`
  const hit = STORES.get(key)
  if (hit) return hit
  const envMax = Number(process.env.QUOTAGENT_ATTACHMENT_MAX_BYTES ?? '')
  const limit = Number.isFinite(envMax) && envMax > 0 ? { max_bytes: Math.floor(envMax) }
    : (Number.isFinite(Number(config.max_bytes)) && Number(config.max_bytes) > 0
      ? { max_bytes: Math.floor(Number(config.max_bytes)) } : {})
  const store = createAttachmentsStore({ root, sharedDir,
    ledgerContractor: String(config.ledgerContractor ?? ''), ledgerSupplier: String(config.ledgerSupplier ?? ''),
    delivery: String(config.delivery ?? ''), limits: limit, log: config.log })
  STORES.set(key, store)
  return store
}
