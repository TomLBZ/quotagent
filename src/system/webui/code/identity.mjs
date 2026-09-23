/**
 * identity —— **轻量身份与会话** + 三个「仅本人可见」的自助面（DEF-001/003/025/026）。
 *
 * 为什么需要它（缺陷真源，逐字）：`docs/work/plans/webui-ui-defects.md`
 *   · DEF-001 「业务视角完全没有身份与会话」：`/contractor/**` 与 `/supplier/**` 全免鉴权，业务数据靠
 *     「开哪个 URL」区分，不靠「我是谁」；签名动作的 `actor` 由人手敲参数；全站唯一身份是管理员 token；
 *   · DEF-003 「人工门在界面上不可签」：界内签名要显示「签什么 / 我是谁 / 后果」，服务端一半校验会话；
 *   · DEF-025 「邮件通道只能看状态，改配置要跳到提权后的 admin 道」；
 *   · DEF-026 「业务视角看不到自己的用户空间插件（自建视图只能管理员装卸）」。
 *
 * 本文件做什么（**机制 + 三个自助面的服务端一半**；零业务语义：不 import 任何领域模块、不写账本、不判断金额）：
 *   ① **会话**：`POST /identity/login`（选 `human:<名字>` + 属于哪一侧）→ **服务端会话**（<ui_shared>/identity/
 *      sessions.json，目录 0700 / 文件 **0600**、原子写）+ **不透明 cookie**（HttpOnly/SameSite=Strict/Path=前缀）；
 *      `logout` 只减权；过期只减权；**身份不再由每个动作手填**；
 *   ② **人签只能本人签**：`POST /sign/<op>` 的服务端一半 —— 会话身份与会话签名（`signature` 字段）**必须一致**，
 *      否则 `signer-mismatch` 明确拒绝且**账本零新增**；通过后把 `--actor` 取自**会话**（不取表单）交给既有
 *      唯一写者（`identity-sign.py` → `quote-sign.py`；`identity-confirm.py` → `commitment-apply.py --step confirm`）；
 *   ③ **「待我处理」工作台**：`GET /inbox/`（+ `/<side>/inbox/`）：待签报价 / 待批准 / 待确认中标 / 待回澄清 /
 *      超期未回；来源是**本侧账本事实 + 本侧 0600 待办件**（不取墙钟：`as_of` = 事实时刻，可用 `?as_of=` 显式给）；
 *      只列**本人或本侧**该看的（`owed_by` 是 `human:<名字>` 或 `side:<侧>`）；
 *   ④ DEF-025：`GET/POST /mail/config/` —— 有权限（`side=ops`）的身份可改邮件/SMTP 配置：干跑 → 0600 待办件 →
 *      Python 侧 `config-apply.py` 落盘（**唯一落盘者不变**，本文件不写 YAML）；凭据只写不回显；
 *   ⑤ DEF-026：`GET/POST /plugins/**` —— 用户自助装卸**自己命名空间**的用户空间插件（自建视图随装载出现、
 *      随卸载消失，`AGENTS.md` 规则 1），跨命名空间一律拒（`not-my-namespace`）。
 *
 * 硬边界（结构性，不靠评审）：
 *   · **不写账本**：本文件没有任何账本写入路径；落账本只能由既有唯一写者（Python 侧）做；
 *   · **不取墙钟**：唯一的时间来源是 `?as_of=` 或账本事实里的 `ts`（会话有效期用 `Date.now()`，那是会话寿命不是业务判定）；
 *   · **凭据/口令永不回显**：本文件不读凭据文件；邮件页只显示键名、来源与「已配置/未配置」；
 *   · **拒绝一律有名**：`REFUSAL_CODES` 是闭合集合，每条给 `code` + `reason` + `next_action`。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

/** 会话 cookie 名（`Path` = 路由前缀：身份对整站生效，与 admin 会话只作用 `/admin/**` 不同）。 */
export const IDENTITY_COOKIE = 'qa_identity'
/** 服务端会话文件的 schema 版本（文件本身 0600）。 */
export const SESSION_SCHEMA = 'quotagent/identity-session/v1'
/** 会话默认寿命（12 小时；过期只减权，不续期、不自动增权）。 */
export const DEFAULT_TTL_MS = 12 * 3600 * 1000
/** 可选身份：两侧业务用户 + 一个运维侧（只有运维侧能改邮件配置）。 */
export const IDENTITY_SIDES = [
  { id: 'contractor', label: '承包商采购员', can: ['inbox', 'gate.approve', 'plugins.self'] },
  { id: 'supplier', label: '供应商销售', can: ['inbox', 'quote.sign', 'award.confirm', 'plugins.self'] },
  { id: 'ops', label: '运维', can: ['inbox', 'mail.config', 'plugins.self'] },
]
/** `<名字>` 的形状（它要进 `human:<名字>`、URL 与用户空间命名空间，故限定 ASCII 小写集）。 */
export const NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/
/** 会话 id：192 bit 不透明串（与任何口令无派生关系）。 */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{32,64}$/
/** 「待我处理」的五类（闭合集合）。 */
export const WORKBENCH_KINDS = ['quote-to-sign', 'gate-to-approve', 'award-to-confirm', 'clarify-open',
  'reply-overdue']
/** 拒绝码（闭合集合：拒绝一律有名，不静默）。 */
export const REFUSAL_CODES = ['identity-required', 'session-expired', 'unknown-side', 'name-malformed',
  'signer-mismatch', 'side-mismatch', 'permission-denied', 'signature-required', 'draft-not-found',
  'not-my-draft', 'not-my-namespace', 'plugin-op-unknown', 'as-of-invalid', 'tool-refused',
  'config-inbox-unconfigured', 'no-fields', 'unknown-mail-key', 'not-my-plugin']
/** scope → 该门该由哪一侧的人处理（人工门的分派口径；本文件只登记映射，不做金额/策略判断）。 */
export const GATE_OWED_BY_SIDE = {
  'quote.submit': 'supplier', 'award.commit': 'contractor', 'po.issue': 'contractor',
  'change.approve': 'contractor', 'negotiate.price-concession': 'contractor',
}
/** 邮件配置允许通过本页修改的键前缀（其余键仍走 `/admin/api/config/**`）。 */
export const MAIL_KEY_PREFIXES = ['mail.smtp.', 'mail.imap.']
export const MAIL_KEY_EXACT = ['mail.timeout_seconds', 'mail.max_messages']
/** 邮件键里**登记表声明为 integer** 的那几个（表单只会给字符串 ⇒ 提交前按类型强转；权威判定仍在 Python 侧）。 */
export const MAIL_INT_KEYS = ['mail.smtp.port', 'mail.imap.port', 'mail.timeout_seconds', 'mail.max_messages']

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * **P32：外部行数组的唯一读数入口**（口径见 `src/system/webui/docs/row-action-prefill.md` §4）。
 *
 * 对**外部给的行数组**（账本/协作/服务面回的行）做 `map`/`for-of` 时**直接把元素当对象读属性**
 * （`row.ref`），数组里只要混进**一条** `null`/字符串/数字/嵌套数组，读属性就抛 `TypeError`
 * ⇒ 这一页 500（外壳对面板抛错则是整块 `data-failed`）。
 * 纪律：坏行**逐条计数**（`bad` 必须显示出来）、**好行照列**；源不是数组 ⇒ `list:false`。
 */
const isRow = (value) => plain(value)
const rowReadOf = (value) => {
  if (!Array.isArray(value)) return { list: false, rows: [], all: 0, bad: 0 }
  const rows = []
  let bad = 0
  for (const row of value) { if (isRow(row)) rows.push(row); else bad += 1 }
  return { list: true, rows, all: value.length, bad }
}
/** 坏行的屏幕说法：**不静默丢**（好行照列、坏行如实报数）。 */
const droppedNote = (read, what) => (read.bad > 0
  ? `<p class="degraded" data-degraded="1" data-rows-dropped="${read.bad}">另有 <b>${read.bad}</b> 条${what}`
    + `读不出来（形状异常：不是对象）—— 好行照列，坏条已跳过并计数（不静默丢）。</p>`
  : '')
/** HTML 转义（本文件所有渲染都过它：任何来自账本/表单的字节都不许当标记）。 */
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const flat = (value, limit = 200) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)
/** 拒绝载荷：**永远带 HTTP 状态**（身份缺失=401，其余业务拒绝=400/403 由调用点覆盖）。 */
const refusal = (code, reason, next_action) => ({ ok: false, code, reason, next_action,
  status: ['identity-required', 'session-expired'].includes(code) ? 401 : 400 })

/**
 * 建一个身份/会话面。
 *
 * @param {object} options
 * @param {string} options.root 仓库根
 * @param {string} options.prefix 路由前缀
 * @param {object} options.config webui 配置（读 `ui_shared` / `ledger_contractor` / `ledger_supplier`）
 * @param {object} options.shell GUI 外壳（用它的 `runPython` 调 Python 侧唯一写者、`loadContributions` 重扫贡献）
 * @param {object} options.services 宿主注入的服务句柄（`userPluginManager` / `configView`；只按名字取，不解读语义）
 * @param {object} [options.people] **人员名册与角色**句柄（`people.mjs`）：登录即登记（角色=待指派），
 *   让"单位里真有人第一次进来"能进得来、但**没有权限**（权限由主管在名册里补）
 * @param {(msg: string) => void} [options.log]
 */
export function createIdentity({ root, prefix, config, shell, services, people = null, log } = {}) {
  const pfx = String(prefix ?? '').replace(/\/$/, '')
  const sharedDir = resolve(String(root ?? '.'), String(config?.ui_shared ?? 'tmp/ui-shared'))
  const dir = join(sharedDir, 'identity')
  const sessionsFile = join(dir, 'sessions.json')
  const say = (msg) => { if (typeof log === 'function') log(`[identity] ${msg}`) }
  const service = (name) => (plain(services) ? services[name] ?? null : null)

  /** 本侧账本路径（只读；结构性隔离：一个会话只会读自己那一侧的账本）。 */
  const ledgerOf = (side) => {
    if (side === 'contractor') {
      return text(config?.ledger_contractor) || join(sharedDir, 'contractor', 'ledger.jsonl')
    }
    if (side === 'supplier') {
      return text(config?.ledger_supplier) || join(sharedDir, 'supplier', 'ledger.jsonl')
    }
    return ''
  }

  // ------------------------------------------------------------------ 会话存储（0600，原子写）
  const loadSessions = () => {
    try {
      const parsed = JSON.parse(readFileSync(sessionsFile, 'utf8'))
      if (!plain(parsed) || !plain(parsed.sessions)) return { schema: SESSION_SCHEMA, sessions: {} }
      return parsed
    } catch (err) { return { schema: SESSION_SCHEMA, sessions: {} } }
  }
  const saveSessions = (doc) => {
    const payload = JSON.stringify({ schema: SESSION_SCHEMA, sessions: doc.sessions }, null, 1) + '\n'
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmpPath = join(dir, `.sessions.${process.pid}.tmp`)
      writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmpPath, 0o600)                        // 显式：不受 umask 影响（会话文件必须**恰为** 0600）
      renameSync(tmpPath, sessionsFile)
      return { ok: true, file: sessionsFile, mode: '0600' }
    } catch (err) {
      return { ok: false, code: 'session-write-failed', reason: flat(err),
        next_action: '先修 <ui_shared>/identity 目录权限（服务端会话文件必须 0600）' }
    }
  }

  const cookieOf = (value, maxAgeSec) => `${IDENTITY_COOKIE}=${value}; HttpOnly; SameSite=Strict; `
    + `Path=${pfx || '/'}; Max-Age=${maxAgeSec}`
  const cookieValue = (req) => {
    const header = String(req?.headers?.cookie ?? '')
    for (const raw of header.split(';')) {
      const pair = raw.split('=')
      if (pair.length !== 2) continue
      if (pair[0].trim() === IDENTITY_COOKIE) return pair[1].trim() || null
    }
    return null
  }
  const pruneSessions = (doc) => {
    const now = Date.now()
    let dropped = 0
    for (const [id, row] of Object.entries(doc.sessions)) {
      if (!plain(row) || Number(row.expires_at) <= now) { delete doc.sessions[id]; dropped += 1 }
    }
    return dropped
  }

  /**
   * 解析请求身份（**唯一入口**：所有自助面的服务端一半都走它）。
   * 返回 `{ok:true, human, name, side, session_id, expires_at}` 或 `{ok:false, code, reason, next_action}`。
   */
  const whoOf = (req) => {
    const sid = cookieValue(req)
    if (!sid) {
      return refusal('identity-required', '请求没有身份 cookie（未登录）',
        `先在 ${pfx}/identity/ 选一个身份登录（human:<名字> + 属于哪一侧）`)
    }
    if (!SESSION_ID_RE.test(sid)) {
      return refusal('identity-required', '身份 cookie 形状非法（不猜、不修复）',
        `重新在 ${pfx}/identity/ 登录`)
    }
    const doc = loadSessions()
    const row = doc.sessions[sid]
    if (!plain(row)) return refusal('identity-required', '会话不存在（可能已登出或服务重启过会话文件）',
      `重新在 ${pfx}/identity/ 登录`)
    if (Number(row.expires_at) <= Date.now()) {
      delete doc.sessions[sid]
      saveSessions(doc)
      return refusal('session-expired', '会话已过期（过期只减权，不续期、不自动增权）',
        `重新在 ${pfx}/identity/ 登录`)
    }
    return { ok: true, session_id: sid, human: String(row.human), name: String(row.name),
      side: String(row.side), expires_at: Number(row.expires_at), ttl_ms: DEFAULT_TTL_MS }
  }

  /** 登录（**只接受两侧/运维的合法名字**）：写服务端会话 + 发不透明 cookie。 */
  const login = ({ name, side, ttl_ms } = {}) => {
    const wanted = text(name).toLowerCase()
    const sideId = text(side)
    if (!NAME_RE.test(wanted)) {
      return refusal('name-malformed', `名字形状非法：${JSON.stringify(name)}`,
        '名字用小写字母开头、≤32 位、只含 [a-z0-9._-]（它会进 human:<名字>、URL 与用户名空间）')
    }
    if (!IDENTITY_SIDES.some((item) => item.id === sideId)) {
      return refusal('unknown-side', `不认识这一侧：${JSON.stringify(side)}`,
        `用 ${IDENTITY_SIDES.map((item) => item.id).join(' / ')} 之一`)
    }
    const doc = loadSessions()
    pruneSessions(doc)
    const sid = randomBytes(24).toString('base64url')
    const issued = Date.now()
    const ttl = Number.isInteger(ttl_ms) && ttl_ms > 0 ? Math.min(ttl_ms, DEFAULT_TTL_MS) : DEFAULT_TTL_MS
    doc.sessions[sid] = { human: `human:${wanted}`, name: wanted, side: sideId, created_at: issued,
      expires_at: issued + ttl }
    // 有界：最多保留 64 个会话（丢最早的，不丢刚发的）
    const ids = Object.keys(doc.sessions)
    if (ids.length > 64) {
      ids.sort((left, right) => Number(doc.sessions[left].created_at) - Number(doc.sessions[right].created_at))
      for (const old of ids.slice(0, ids.length - 64)) delete doc.sessions[old]
    }
    const saved = saveSessions(doc)
    if (!saved.ok) return saved
    // **登录即登记**（名册口径）：名字第一次出现在这一侧 ⇒ 进名册，角色 = 「待指派」（有名字、没有权限）。
    // 为什么在这里做：名册是**权威取值处**（@提及/指派/转交都从它来），但"单位里真有人第一次进来"不该被
    // 挡在门外 —— 他进得来、看得到、**没有权限**，等主管在界面上补角色。名册写失败**不影响登录**
    // （登录是身份面的事；名册是配置）——失败如实回报，不假装登记成功。
    let roster = null
    if (people && typeof people.enroll === 'function') {
      try {
        roster = people.enroll({ side: sideId, name: wanted, at: new Date(issued).toISOString() })
      } catch (err) {
        roster = { ok: false, code: 'people-write-failed', reason: flat(err) }
      }
      if (roster && roster.ok === false) say(`登录即登记失败：${wanted}（${sideId}）：${roster.code}`)
    }
    return { ok: true, session_id: sid, human: `human:${wanted}`, name: wanted, side: sideId,
      expires_at: issued + ttl, ttl_ms: ttl, session_file: saved.file, session_mode: saved.mode,
      roster: roster ? { enrolled: roster.enrolled ?? false, role: roster.role ?? null,
        code: roster.code ?? null, file: roster.file ?? null, mode: roster.mode ?? null } : null,
      cookie: cookieOf(sid, Math.floor(ttl / 1000)),
      next_action: `去 ${pfx}/inbox/ 看「待我处理」，或用 ${pfx}/sign/ 做人签；`
        + '名册里没有你 ⇒ 先让同侧同事在「人员名册与角色」面板里给你补角色（受额度限制的动作会拒你）' }
  }

  /** 登出（只减权：删会话 + 清 cookie）。 */
  const logout = (req) => {
    const sid = cookieValue(req)
    const doc = loadSessions()
    const existed = sid && plain(doc.sessions[sid])
    if (existed) { delete doc.sessions[sid]; saveSessions(doc) }
    return { ok: true, code: existed ? 'logged-out' : 'no-session',
      cookie: cookieOf('', 0),
      next_action: `已回到未登录状态（${pfx}/identity/ 可重新登录）` }
  }

  /** 需要「已登录 + 属于某一侧 + 有某个能力」时的统一闸门（拒绝有名）。 */
  const require_ = (req, { side = null, can = null } = {}) => {
    const who = whoOf(req)
    if (!who.ok) return who
    if (side !== null && who.side !== side) {
      return { ...refusal('side-mismatch', `当前身份是 ${who.side}，这一步只允许 ${side} 侧`,
        `切换到 ${side} 侧身份后再试（${pfx}/identity/）`), status: 403 }
    }
    if (can !== null) {
      const meta = IDENTITY_SIDES.find((item) => item.id === who.side)
      if (!(meta?.can ?? []).includes(can)) {
        return { ...refusal('permission-denied', `${who.side} 侧身份没有 ${can} 权限`,
          `用有该权限的身份登录（本页要求 side=${IDENTITY_SIDES.filter((s) => s.can.includes(can))
            .map((s) => s.id).join('/') || '（无）'}）`), status: 403 }
      }
    }
    return who
  }

  // ------------------------------------------------------------------ 账本/待办件只读读取（宿主侧只读）
  const readRows = (side) => {
    const path = ledgerOf(side)
    if (path === '') return []
    try {
      return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
        .map((line) => { try { return JSON.parse(line) } catch (err) { return null } })
        .filter((row) => plain(row))
    } catch (err) { return [] }
  }
  const bodyOf = (row) => (plain(row?.body) ? row.body : {})
  const readPending = (kind) => {
    const folder = join(sharedDir, kind)
    if (!existsSync(folder)) return []
    let names = []
    try { names = readdirSync(folder).filter((name) => name.endsWith('.json')).sort() } catch (err) { return [] }
    const out = []
    for (const name of names) {
      try { out.push({ file: join(folder, name), record: JSON.parse(readFileSync(join(folder, name), 'utf8')) }) }
      catch (err) { /* 坏待办件跳过（不猜） */ }
    }
    return out.filter((item) => plain(item.record))
  }
  /** 事实时刻：显式 `as_of` 优先，否则取账本里最大的 `ts`（**不取墙钟**）。 */
  const asOfOf = (rowsList, wanted) => {
    if (wanted !== null && wanted !== undefined && wanted !== '') {
      return ISO_RE.test(String(wanted)) ? String(wanted) : null
    }
    let newest = ''
    for (const rows of rowsList) {
      for (const row of rows) {
        const ts = String(row?.ts ?? '')
        if (ISO_RE.test(ts) && ts > newest) newest = ts
      }
    }
    return newest
  }
  const meOf = (who) => `human:${who.name}`

  /**
   * 「待我处理」：五类待办，只列**本人或本侧**该看的（`owed_by` = `human:<名字>` / `side:<侧>`）。
   *
   * 五类的判定（全部来自**事实**，不看墙钟）：
   *   · `quote-to-sign`   待签报价：本侧账本里 `quote/drafted` 但还没有配对的 `quote/submitted`（**只列
   *                       `prepared_by` 是我自己的草稿** —— 与「人签只能本人签」同一口径），加上还没被消费的
   *                       0600 草稿待办件（`<ui_shared>/quote-drafts/`）；
   *   · `gate-to-approve` 待批准：`approval/requested` 尚无同 `approval_id` 的 `approval/granted`
   *                       （按 `scope` 分派给该侧，见 `GATE_OWED_BY_SIDE`）；
   *   · `award-to-confirm` 待确认中标：承包商账本里 `award/intent-proposed` 且本侧账本里没有 `award/confirmed`
   *                       （只确认自己报过价的那份）；
   *   · `clarify-open`    待回澄清：本侧账本里 `clarification/asked` 尚未 `clarification/answered`；
   *   · `reply-overdue`   超期未回：本侧账本里最新一版 RFQ 的 `quote_by` 已过 `as_of` 且本侧没有收到报价登记。
   */
  const workbench = (who, { asOf = null } = {}) => {
    const side = who.side
    const rows = readRows(side)
    const other = side === 'contractor' ? 'supplier' : 'contractor'
    const otherRows = readRows(other)
    const as_of = asOfOf([rows, otherRows], asOf)
    if (as_of === null) {
      return { ok: false, code: 'as-of-invalid', reason: `as_of 不是合法 ISO8601：${JSON.stringify(asOf)}`,
        next_action: '给 ?as_of=2026-09-30T00:00:00Z，或让账本里有一条带 ts 的事实（本页不取墙钟）' }
    }
    const me = meOf(who)
    const items = []
    /** 只列本人/本侧该看的：`owed_by` 命中「我」或「我这一侧」才收（其余一律不进列表）。 */
    const visible = (item) => item.owed_by === me || item.owed_by === `side:${side}`
    const push = (item) => {
      if (item && visible(item)) items.push(item)
      return Boolean(item) && visible(item)
    }

    // ① 待签报价（供应商侧；只列我自己备的草稿）
    if (side === 'supplier') {
      const signedDrafts = new Set(rows.filter((row) => String(row.type) === 'quote/submitted')
        .map((row) => String(bodyOf(row).quote_draft_id ?? '')).filter((id) => id !== ''))
      for (const row of rows) {
        if (String(row.type) !== 'quote/drafted') continue
        const body = bodyOf(row)
        const draftId = String(body.quote_draft_id ?? '')
        if (draftId === '' || signedDrafts.has(draftId)) continue
        const lineCount = Number(body.line_count) > 1 ? Number(body.line_count) : 1
        push({ kind: 'quote-to-sign', owed_by: String(body.prepared_by ?? ''), ref: draftId,
          title: `报价草稿 ${draftId}（${body.rfq_id ?? '—'} / ${body.item_id ?? '—'}`
            + `${lineCount > 1 ? `，共 ${lineCount} 行` : ''}）`,
          fact: { type: row.type, seq: row.seq, ts: row.ts }, stage: 'ledger',
          money: { unit_price_cents: body.unit_price_cents ?? null, currency: body.currency ?? '',
            line_count: lineCount },
          detail: { payload_sha256: body.lines_sha256 ?? null, note_sha256: body.note_sha256 ?? null,
            item_id: body.item_id ?? null, line_count: lineCount },
          next_action: `${pfx}/sign/ 人签提交（**一次签完整份${lineCount > 1 ? ` ${lineCount} 行` : ''}**；`
            + '署名必须与登录身份一致）' })
      }
      for (const item of readPending('quote-drafts')) {
        const rec = item.record
        if (String(rec.view ?? '') !== 'supplier') continue
        const draftId = String(rec.quote_draft_id ?? '')
        push({ kind: 'quote-to-sign', owed_by: String(rec.prepared_by ?? ''), ref: draftId,
          title: `待消费的报价草稿 ${draftId || item.file}（${rec.rfq_id ?? '—'} / ${rec.item_id ?? '—'}）`,
          fact: { type: 'pending:quote-drafts', seq: null, ts: '' }, stage: 'pending-item', file: item.file,
          money: { unit_price_cents: rec.unit_price_cents ?? null, currency: rec.currency ?? '' },
          next_action: '先让 Python 侧 consumer 落 `quote/drafted`（宿主只落 0600 待办件）' })
      }
    }

    // ② 待批准（人工门；按 scope 分派给该侧）
    const grantedKeys = new Set(rows.filter((row) => String(row.type) === 'approval/granted')
      .map((row) => `${row.correlation_id ?? ''}\u0000${bodyOf(row).approval_id ?? ''}`))
    for (const row of rows) {
      if (String(row.type) !== 'approval/requested') continue
      const body = bodyOf(row)
      if (String(body.status ?? '') !== 'pending') continue
      const key = `${row.correlation_id ?? ''}\u0000${body.approval_id ?? ''}`
      if (grantedKeys.has(key)) continue
      const scope = String(body.scope ?? '')
      const owed = GATE_OWED_BY_SIDE[scope] ?? null
      if (owed === null) continue                                  // 未登记派分口径的门不进「待我处理」（不猜）
      push({ kind: 'gate-to-approve', owed_by: `side:${owed}`, ref: String(body.ref ?? row.correlation_id ?? ''),
        title: `待批准：${scope}（${body.approval_id ?? '—'}${body.ref ? ` / ${body.ref}` : ''}）`,
        fact: { type: row.type, seq: row.seq, ts: row.ts }, stage: 'ledger',
        detail: { approval_id: body.approval_id ?? null, scope, requested_by: body.requested_by ?? null },
        next_action: `${owed === side ? '本侧' : '对方侧'}待办：批准动作必须由拥有该权限的人签（actor 取自会话）` })
    }

    // ③ 待确认中标（供应商侧；只确认自己报过价的那份意向）
    if (side === 'supplier') {
      const myQuotes = new Set(rows.filter((row) => String(row.type) === 'quote/submitted')
        .map((row) => String(bodyOf(row).quote_id ?? '')))
      const confirmed = new Set(rows.filter((row) => String(row.type) === 'award/confirmed')
        .map((row) => String(bodyOf(row).intent_id ?? '')))
      const committed = new Set(otherRows.filter((row) => String(row.type) === 'award/committed')
        .map((row) => String(bodyOf(row).intent_id ?? '')))
      for (const row of otherRows) {
        if (String(row.type) !== 'award/intent-proposed') continue
        const body = bodyOf(row)
        const intentId = String(body.intent_id ?? '')
        if (intentId === '' || confirmed.has(intentId)) continue
        if (String(body.status ?? '') === 'withdrawn') continue
        const quoteId = String(body.quote_id ?? '')
        if (quoteId === '' || !myQuotes.has(quoteId)) continue      // 不能替别人确认
        push({ kind: 'award-to-confirm', owed_by: `side:${side}`, ref: intentId,
          title: `待确认中标意向 ${intentId}（报价 ${quoteId}）`,
          fact: { type: row.type, seq: row.seq, ts: row.ts, realm: String(row.realm ?? '') }, stage: 'ledger',
          detail: { quote_id: quoteId, already_committed: committed.has(intentId) },
          next_action: `在 ${pfx}/sign/ 人签确认（award.confirm；署名必须与登录身份一致）` })
      }
    }

    // ④ 待回澄清（本侧账本里尚未被答复的工单）
    const answered = new Set(rows.filter((row) => String(row.type) === 'clarification/answered')
      .map((row) => String(bodyOf(row).ticket_id ?? '')))
    for (const row of rows) {
      if (String(row.type) !== 'clarification/asked') continue
      const body = bodyOf(row)
      const ticket = String(body.ticket_id ?? '')
      if (ticket === '' || answered.has(ticket)) continue
      push({ kind: 'clarify-open', owed_by: `side:${side}`, ref: ticket,
        title: `澄清工单 ${ticket}（${body.package_id ?? '—'}@rev${body.rfq_rev ?? '—'}）尚未答复`,
        fact: { type: row.type, seq: row.seq, ts: row.ts }, stage: 'ledger',
        detail: { package_id: body.package_id ?? null, question_bytes: String(body.question ?? '').length },
        next_action: '本侧可跟进/催办；答复要由有权限的人以 human:<名字> 落（对方视角可见）' })
    }

    // ⑤ 超期未回（承包商侧：最新一版 RFQ 已过报价截止且本侧没收到报价登记）
    if (side === 'contractor') {
      const latest = new Map()
      for (const row of rows) {
        const type = String(row.type)
        if (type !== 'rfq/published' && type !== 'rfq/amended') continue
        const body = bodyOf(row)
        const pkg = String(body.package_id ?? '')
        if (pkg === '') continue
        const rev = Number(body.rev ?? 0)
        const prev = latest.get(pkg)
        if (!prev || rev >= prev.rev) {
          // `rfq/amended` 的 body 不带 `quote_by` ⇒ **沿用上一版**的截止（缺失才退到该行 ts，不猜新值）
          const carried = body.quote_by !== undefined ? String(body.quote_by) : (prev?.quote_by ?? String(row.ts ?? ''))
          latest.set(pkg, { package_id: pkg, rev, quote_by: carried, seq: row.seq, ts: row.ts,
            recipients: String(body.recipients ?? prev?.recipients ?? '') })
        }
      }
      const received = new Set(rows.filter((row) => String(row.type) === 'quote/submitted')
        .map((row) => String(bodyOf(row).package_id ?? '')).filter((id) => id !== ''))
      for (const pkg of latest.values()) {
        if (pkg.quote_by === '' || !ISO_RE.test(pkg.quote_by)) continue
        if (pkg.quote_by > as_of) continue                            // 还没到截止（按事实时刻，不取墙钟）
        if (received.has(pkg.package_id)) continue                    // 已经有报价登记
        push({ kind: 'reply-overdue', owed_by: `side:${side}`, ref: pkg.package_id,
          title: `包 ${pkg.package_id}@rev${pkg.rev} 已过报价截止 ${pkg.quote_by} 仍未收到报价`,
          fact: { type: 'rfq/published', seq: pkg.seq, ts: pkg.ts }, stage: 'ledger',
          waiting_on: `side:${other}`,
          detail: { quote_by: pkg.quote_by, as_of, recipients: pkg.recipients },
          next_action: '本侧该催报（未回名单）或延长截止 —— 两个动作都要落事实（对方视角可见）' })
      }
    }

    const by_kind = Object.fromEntries(WORKBENCH_KINDS.map((kind) => [kind, 0]))
    for (const item of items) by_kind[item.kind] = (by_kind[item.kind] ?? 0) + 1
    return { ok: true, view: side, identity: me, side, as_of, as_of_source: (asOf ?? '') === '' ? 'ledger-fact' : 'request',
      counts: { total: items.length, mine: items.filter((item) => item.owed_by === me).length,
        by_kind, ledger_rows: rows.length, other_side_rows: otherRows.length },
      items: items.sort((left, right) => (left.kind < right.kind ? -1 : (left.kind > right.kind ? 1
        : (left.ref < right.ref ? -1 : 1)))),
      sources: { ledger: ledgerOf(side), other_ledger: ledgerOf(other), pending: sharedDir,
        pending_kinds: ['quote-drafts'] },
      empty_reason: items.length ? null : 'no-items-for-you',
      note: '只列本人或本侧该看的（owed_by = human:<名字> / side:<侧>）；时间一律按事实（as_of），不取墙钟' }
  }

  // ------------------------------------------------------------------ 人签（服务端一半）
  /**
   * 人签动作的**共同闸门**：会话存在 → 会话身份与会话签名一致 →（必要时）侧别正确。
   * 通过后**署名取自会话**（`--actor` 永不由表单决定）。
   */
  const signGate = (req, { side, can, signature }) => {
    const who = require_(req, { side, can })
    if (!who.ok) return who
    const typed = text(signature)
    if (typed === '') {
      return { ...refusal('signature-required', '本动作是人签动作：必须显式署名（signature）',
        `在表单里写 human:${who.name}（服务端会校验它等于会话身份）`), status: 400 }
    }
    if (typed !== who.human) {
      return { ...refusal('signer-mismatch', `署名 ${typed} 与会话身份 ${who.human} 不一致`,
        `人签只能本人签：用 ${who.human} 署名，或切换到该身份的会话（账本零新增）`), status: 403 }
    }
    return who
  }

  const runTool = (toolPath, args) => (typeof shell?.runPython === 'function'
    ? shell.runPython(toolPath, args)
    : { ok: false, code: 'tool-missing', reason: '外壳没有 runPython（未装配）', json: null })

  /** 人签「提交报价」（DEF-003/007）：会话 → `identity-sign.py` → 唯一写者 `quote-sign.py`。 */
  const signQuote = (req, input = {}) => {
    const who = signGate(req, { side: 'supplier', can: 'quote.sign', signature: input.signature })
    if (!who.ok) return who
    const draftId = text(input.draft_id)
    const now = text(input.now)
    if (draftId === '') {
      return { ...refusal('draft-not-found', '缺 draft_id（签什么必须显式）',
        `在 ${pfx}/sign/ 里选一条「待签报价」再签`), status: 400 }
    }
    if (!ISO_RE.test(now)) {
      return { ...refusal('as-of-invalid', `now 必须是合法 ISO8601，收到 ${JSON.stringify(input.now)}`,
        '给 now=2026-09-30T00:00:00Z（唯一写者不读墙钟；时间由你/事实给）'), status: 400 }
    }
    const out = runTool('src/system/webui/tools/identity-sign.py', ['--session-human', who.human,
      '--actor', who.human, '--draft-id', draftId, '--now', now,
      ...(text(input.comment) === '' ? [] : ['--comment', text(input.comment)]),
      '--ui-shared', sharedDir, '--ledger-supplier', ledgerOf('supplier'),
      '--ledger-contractor', ledgerOf('contractor')])
    const payload = out.json ?? null
    return { ok: out.ok && payload?.ok === true, status: out.ok && payload?.ok === true ? 200 : 400,
      code: payload?.refusal?.code ?? (out.ok ? null : 'tool-refused'),
      reason: payload?.refusal?.reason ?? out.reason ?? flat(out.stderr),
      next_action: payload?.refusal?.next_action ?? payload?.next_action ?? '',
      result: payload ? { actor: payload.actor, quote_id: payload.quote_id, approval_id: payload.approval_id,
        ledger_added: payload.ledger_added, event: payload.event, session_human: who.human,
        refusal: payload.refusal ?? null } : null,
      tool: { rc: out.rc, ms: out.ms } }
  }

  /** 人签「确认中标」（DEF-022 的供应商侧一半）：会话 → `identity-confirm.py` → `commitment-apply.py --step confirm`。 */
  const signAward = (req, input = {}) => {
    const who = signGate(req, { side: 'supplier', can: 'award.confirm', signature: input.signature })
    if (!who.ok) return who
    const intentId = text(input.intent_id)
    const now = text(input.now)
    if (intentId === '') {
      return { ...refusal('draft-not-found', '缺 intent_id（确认哪份意向必须显式）',
        `在 ${pfx}/sign/ 里选一条「待确认中标」再确认`), status: 400 }
    }
    if (!ISO_RE.test(now)) {
      return { ...refusal('as-of-invalid', `now 必须是合法 ISO8601，收到 ${JSON.stringify(input.now)}`,
        '给 now=2026-09-30T00:00:00Z（唯一写者不读墙钟）'), status: 400 }
    }
    const out = runTool('src/system/webui/tools/identity-confirm.py', ['--session-human', who.human,
      '--actor', who.human, '--intent-id', intentId, '--now', now,
      '--ui-shared', sharedDir, '--ledger-supplier', ledgerOf('supplier'),
      '--ledger-contractor', ledgerOf('contractor')])
    const payload = out.json ?? null
    return { ok: out.ok && payload?.ok === true, status: out.ok && payload?.ok === true ? 200 : 400,
      code: payload?.refusal?.code ?? (out.ok ? null : 'tool-refused'),
      reason: payload?.refusal?.reason ?? out.reason ?? flat(out.stderr),
      next_action: payload?.refusal?.next_action ?? payload?.next_action ?? '',
      result: payload ? { actor: payload.actor, intent_id: payload.intent_id, ledger_added: payload.ledger_added,
        event: payload.event, session_human: who.human, refusal: payload.refusal ?? null } : null,
      tool: { rc: out.rc, ms: out.ms } }
  }

  // ------------------------------------------------------------------ DEF-025：邮件配置（有权限的页面）
  /** 允许在本页修改的键（白名单：其余键仍走 `/admin/api/config/**`，本页不做第二份白名单判定）。 */
  const mailKeyAllowed = (key) => MAIL_KEY_EXACT.includes(key)
    || MAIL_KEY_PREFIXES.some((prefixKey) => key.startsWith(prefixKey) && key.length > prefixKey.length)

  /** 页面上可编辑的邮件键（值**不回显**：只给「有/无 + 来源」）。 */
  const mailFields = () => {
    const view = service('configView')
    const rows = []
    if (view && typeof view.overview === 'function') {
      try {
        const data = view.overview()
        for (const row of data.project ?? []) {
          if (mailKeyAllowed(String(row.key ?? ''))) {
            rows.push({ key: String(row.key), source: String(row.source ?? ''), editable: row.editable === true,
              needs_approval: row.needs_approval === true, value_present: row.value !== null && row.value !== undefined
                && String(row.value) !== '', shadowed_by: row.shadowed_by ?? null })
          }
        }
        return { ok: true, rows, config_file: String(data.config_file ?? ''), degraded: data.degraded === true,
          reason: String(data.reason ?? ''), pending: data.counts?.pending ?? null }
      } catch (err) {
        return { ok: false, rows: [], reason: flat(err), degraded: true }
      }
    }
    return { ok: false, rows: [], reason: 'configView 服务不可用', degraded: true }
  }

  /**
   * 提交邮件配置：干跑（零落盘）→ 会话/署名门 → `identity-mail-apply.py`（0600 待办件 + 人工引用 +
   * `config-apply.py` 落盘）。**本文件不写 YAML、不落凭据**。
   */
  const applyMailConfig = (req, input = {}) => {
    const who = signGate(req, { side: 'ops', can: 'mail.config', signature: input.signature })
    if (!who.ok) return who
    const now = text(input.now)
    if (!ISO_RE.test(now)) {
      return { ...refusal('as-of-invalid', `now 必须是合法 ISO8601，收到 ${JSON.stringify(input.now)}`,
        '给 now=2026-09-30T00:00:00Z（唯一落盘者不读墙钟）'), status: 400 }
    }
    const fields = {}
    for (const [key, value] of Object.entries(plain(input) ? input : {})) {
      if (!mailKeyAllowed(key)) continue
      if (value === undefined || value === null || String(value) === '') continue
      const raw = String(value).trim()
      if (MAIL_INT_KEYS.includes(key) && /^-?\d+$/.test(raw)) { fields[key] = Number(raw); continue }
      fields[key] = value
    }
    const yaml = text(input.yaml)
    if (Object.keys(fields).length === 0 && yaml === '') {
      return { ...refusal('no-fields', '没有提交任何邮件键（既没有键值对，也没有 YAML 片段）',
        `填至少一个 mail.smtp.* / mail.imap.* 键，或贴一段 YAML（例如 project: 段下的 mail.smtp.host）`), status: 400 }
    }
    for (const key of Object.keys(fields)) {
      if (!mailKeyAllowed(key)) {
        return { ...refusal('unknown-mail-key', `本页不允许改这个键：${key}`,
          `本页只改 mail.smtp.* / mail.imap.* / ${MAIL_KEY_EXACT.join(' / ')}；其余键走 ${pfx}/admin/api/config/（需提权）`), status: 403 }
      }
    }
    const view = service('configView')
    // 干跑（白名单 + 类型 + 人工门 + diff；**零落盘零生效**）——只有键值形状能先干跑；YAML 片段由 Python 侧判
    let dryRun = null
    if (view && typeof view.preview === 'function' && Object.keys(fields).length > 0) {
      try {
        dryRun = view.preview({ layer: 'project', target: 'project', fields,
          human_approval_ref: 'ap-0000' })     // 形状占位：真实引用由 identity-mail-apply.py 现场生成
      } catch (err) { dryRun = { accepted: false, reasons: [{ code: 'preview-failed', reason: flat(err) }] } }
      const blocking = (dryRun.reasons ?? []).filter((item) => item.code !== 'humanOnly')
      if (!dryRun.accepted && blocking.length > 0) {
        return { ok: false, status: 400, code: 'preview-refused', reason: '干跑不通过（零落盘零生效）',
          errors: blocking, next_action: '先修 errors 里的键或值再提交（本页不落任何件）' }
      }
    }
    const args = ['--session-human', who.human, '--actor', who.human, '--now', now,
      '--ui-shared', sharedDir]
    const cfg = view && typeof view.config === 'function' ? view.config() : {}
    if (text(cfg?.config_file)) args.push('--file', text(cfg.config_file))
    if (text(cfg?.config_inbox)) args.push('--inbox', text(cfg.config_inbox))
    if (text(cfg?.config_ledger)) args.push('--ledger', text(cfg.config_ledger))
    for (const [key, value] of Object.entries(fields)) args.push('--key', key, '--value', String(value))
    if (yaml !== '') args.push('--yaml', yaml)
    const out = runTool('src/system/webui/tools/identity-mail-apply.py', args)
    const payload = out.json ?? null
    return { ok: out.ok && payload?.ok === true, status: out.ok && payload?.ok === true ? 200 : 400,
      code: payload?.refusal?.code ?? (out.ok ? null : 'tool-refused'),
      reason: payload?.refusal?.reason ?? out.reason ?? flat(out.stderr),
      next_action: payload?.refusal?.next_action ?? payload?.next_action ?? '',
      result: payload ? { session_human: who.human, keys: payload.keys ?? [], config_file: payload.config_file,
        ledger_added: payload.ledger_added, approval_id: payload.approval_id,
        persisted: payload.persisted === true,
        // 干跑只回**键名 + 新旧摘要**（不回显任何值：值只落 0600 待处理项与 YAML）
        dry_run: dryRun ? { accepted: dryRun.accepted,
          diff: (dryRun.diff ?? []).map((row) => ({ key: row.key, changed: row.old !== row.new,
            old_digest: row.old_digest ?? null, new_digest: row.new_digest ?? null })),
          reasons: dryRun.reasons ?? [] } : null,
        refusal: payload.refusal ?? null } : null,
      tool: { rc: out.rc, ms: out.ms } }
  }

  // ------------------------------------------------------------------ DEF-026：自己的用户空间插件
  /** 我的命名空间 = 我的名字（`user-space/<名字>/` 存在就是它，否则退到 `u-<名字>`）。 */
  const myNamespace = (who) => {
    const userSpaceRoot = (() => {
      const manager = service('userPluginManager')
      const cfg = manager && typeof manager.config === 'function' ? manager.config() : null
      return text(cfg?.root) || ''
    })()
    if (userSpaceRoot !== '' && existsSync(join(resolve(root ?? '.', userSpaceRoot), who.name))) return who.name
    return `u-${who.name}`
  }
  /** 清单：全部命名空间 + 哪些是「我的」（装卸只允许自己的）。 */
  const pluginsView = (who) => {
    const manager = service('userPluginManager')
    if (!manager) return { ok: false, degraded: true, reason: 'userPluginManager 服务不可用',
      next_action: '确认 user-plugin-manager 插件已装配（它提供装卸面）', namespaces: [], mine: myNamespace(who) }
    let list = null
    try { list = manager.list() } catch (err) {
      return { ok: false, degraded: true, reason: flat(err), next_action: '看宿主日志（管理面抛错）',
        namespaces: [], mine: myNamespace(who) }
    }
    const mine = myNamespace(who)
    const namespaces = (list.namespaces ?? []).map((entry) => ({ ns: entry.ns, mine: entry.ns === mine,
      plugins: (entry.plugins ?? []).map((item) => ({ name: item.name, version: item.version,
        loaded: item.loaded === true, invalid: item.invalid === true, reason: item.reason ?? '',
        mine: entry.ns === mine })) }))
    return { ok: true, degraded: list.degraded === true, reason: list.reason ?? '', mine,
      counts: list.counts ?? {}, namespaces,
      next_action: list.degraded ? (list.next_action ?? '') : '' }
  }
  /** 装卸（只允许自己的命名空间）：走既有管理面 `load/unload/reload`；装载后重扫 UI 贡献（自建视图随之出现）。 */
  const pluginOp = async (req, input = {}) => {
    const who = require_(req, { can: 'plugins.self' })
    if (!who.ok) return who
    const op = text(input.op)
    if (!['load', 'unload', 'reload'].includes(op)) {
      return { ...refusal('plugin-op-unknown', `不认识的装卸动作：${JSON.stringify(input.op)}`,
        '用 load / unload / reload'), status: 400 }
    }
    const manager = service('userPluginManager')
    if (!manager) {
      return { ...refusal('tool-refused', 'userPluginManager 服务不可用（管理面未装配）',
        '确认 user-plugin-manager 插件已装配'), status: 503 }
    }
    const ns = text(input.ns)
    const plugin = text(input.plugin)
    const mine = myNamespace(who)
    if (ns !== mine) {
      return { ...refusal('not-my-namespace', `命名空间 ${JSON.stringify(ns)} 不是你的（你的是 ${mine}）`,
        `自助装卸只允许自己的命名空间：${mine}（别人的插件要管理员走 ${pfx}/admin/api/user-plugins/**）`), status: 403 }
    }
    // 自己的命名空间里不存在的插件名 → 明确拒（不猜、不代建）
    const view = pluginsView(who)
    const known = (view.namespaces ?? []).some((entry) => entry.ns === mine
      && (entry.plugins ?? []).some((item) => item.name === plugin))
    if (!known && op !== 'unload') {
      return { ...refusal('not-my-plugin', `你的命名空间 ${mine} 里没有插件 ${JSON.stringify(plugin)}`,
        `先让你的命名空间里出现该插件（自进化/agent 侧产出），再装卸`), status: 404 }
    }
    let out = null
    try { out = await manager[op](ns, plugin) } catch (err) {
      out = { ok: false, code: 'load-failed', next_action: flat(err) }
    }
    const ok = Boolean(out && out.ok !== false && (out.ok === true || out.uid || out.effects !== undefined))
    // 贡献重扫：装/重载后该插件的视图/面板/动作随之出现（规则 1：卸载后随之消失）
    let contributions = null
    if (ok && typeof shell?.loadContributions === 'function' && typeof shell?.contributions?.get === 'function') {
      try {
        await shell.loadContributions()
        const info = shell.contributions.get(`userspace/${ns}/${plugin}`)
        contributions = info ? { entries: info.entries ?? [], error: info.error ?? null } : null
      } catch (err) { contributions = { error: flat(err) } }
    }
    if (!ok && op !== 'load' && typeof shell?.unload === 'function') {
      // 卸载路径也要撤掉它的 UI 贡献（不然页面上留着已经不在跑的东西）
      try { shell.unload(`userspace/${ns}/${plugin}`) } catch (err) { /* 尽力而为 */ }
    }
    return { ok, status: ok ? 200 : 409, code: out?.code ?? (ok ? null : 'tool-refused'),
      reason: out?.reason ?? '', next_action: out?.next_action ?? '',
      result: { op, ns, plugin, uid: out?.uid ?? null, effects: out?.effects ?? null,
        contributions, session_human: who.human, mine } }
  }

  // ------------------------------------------------------------------ 路由级身份门槛（本批 ③；DEF-001）
  /**
   * **两侧静态业务路由的身份门槛**（`/contractor/**`、`/supplier/**`）。
   *
   * 判据（与 DEF-001 的期望逐条一致）：
   *   · 未登录 / 会话过期 ⇒ 浏览器 `303` 回登录页并带 `next`（回跳原地址），API 客户端 `401` + 同上 `next`；
   *   · 登录了但不是这一侧 ⇒ `403 side-mismatch`（**不得回落到「能看」**）；
   *   · 对上侧 ⇒ `null`（放行；签名动作的 `actor` 仍由会话给，不由此改变）。
   *
   * 公开入口不经过这里（`/`、`/identity/**`、`/inbox/**`、`/sign/**`、`/api/health` 等由调用方先分流）：
   * 本函数只对**业务路由**表态，`side` 不是两侧之一时一律返回 `null`（不越权表态）。
   *
   * @param {object} req HTTP 请求（读 cookie）
   * @param {{side: string, next: string, wantsHtml?: boolean}} options `side` = 该路径所属侧；`next` = 回跳地址
   */
  const gateBusinessRoute = (req, { side, next, wantsHtml = false } = {}) => {
    const wanted = text(side)
    if (wanted !== 'contractor' && wanted !== 'supplier') return null     // 不是业务路由 ⇒ 不表态
    const back = `${pfx}/identity/?next=${encodeURIComponent(text(next))}`
    const who = whoOf(req)
    if (!who.ok) {
      if (wantsHtml) {
        return { kind: 'redirect', status: 303, location: back, code: who.code, next: text(next), side: wanted }
      }
      return { kind: 'deny', status: Number(who.status) || 401, code: who.code, reason: who.reason,
        next_action: who.next_action, next: text(next), side: wanted, login: back }
    }
    if (who.side !== wanted) {
      return { kind: 'deny', status: 403, code: 'side-mismatch',
        reason: `当前身份是 ${who.human}（side=${who.side}）：${wanted} 到的路由只对 ${wanted} 侧放行`,
        next_action: `换用 ${wanted} 侧身份再打开；本侧自己的事在 ${pfx}/${who.side}/inbox/（身份与会话页可切换）`,
        next: text(next), side: wanted, human: who.human, login: back }
    }
    return null
  }

  // ------------------------------------------------------------------ 路由（注册进既有的路由注册面）
  const views = () => ['contractor', 'supplier', 'ops']
  const htmlPage = (title, body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(config?.page_title ?? 'quotagent')} · ${esc(title)}</title></head><body>`
    + `<p data-identity-nav="1"><a href="${pfx}/identity/">身份与会话</a> · `
    + `<a href="${pfx}/inbox/">待我处理</a> · <a href="${pfx}/sign/">人签</a> · `
    + `<a href="${pfx}/mail/config/" data-mail-config="1">邮件配置</a> · `
    + `<a href="${pfx}/plugins/" data-my-plugins="1">我的插件</a> · `
    + `<a href="${pfx}/" >工作台</a></p>`
    + `<h1>${esc(title)}</h1>${body}</body></html>`

  const sideOptions = (current) => IDENTITY_SIDES.map((side) => `<option value="${side.id}"`
    + `${side.id === current ? ' selected' : ''}>${esc(side.label)}（${side.id}）</option>`).join('')

  /** 身份页：登录 / 切换 / 登出（**不显示任何凭据**；名字由人自己给）。 */
  const identityPage = (req, url) => {
    const who = whoOf(req)
    const next = text(url.searchParams.get('next'))
    const current = who.ok
      ? `<p data-identity-current="1">当前身份：<code>${esc(who.human)}</code>（side=<code>${esc(who.side)}</code>，`
        + `会话到 <code>${esc(new Date(who.expires_at).toISOString())}</code>）</p>`
        + `<form method="post" action="${pfx}/identity/logout"><button type="submit">登出</button></form>`
      : `<p data-identity-current="0">当前未登录：业务动作（含人签）一律会被拒（账本零新增）。</p>`
    return htmlPage('身份与会话', current
      + `<h2>登录 / 切换身份</h2>`
      + `<form method="post" action="${pfx}/identity/login">`
      + `<label>我是谁（human:&lt;名字&gt;）<input name="name" size="16" placeholder="chenmin" required></label> `
      + `<label>属于哪一侧 <select name="side">${sideOptions(who.ok ? who.side : 'supplier')}</select></label> `
      + `<input type="hidden" name="next" value="${esc(next)}">`
      + `<button type="submit">登录 / 切换</button></form>`
      + `<p>名字用小写字母开头、≤32 位、只含 <code>[a-z0-9._-]</code>：它会成为 <code>human:&lt;名字&gt;</code>`
      + `（账本 <code>actor</code>）、用户名空间与 URL 的一部分。身份存**服务端会话**`
      + `（<code>&lt;ui_shared&gt;/identity/sessions.json</code>，0600）+ 不透明 cookie（HttpOnly / SameSite=Strict）。</p>`
      + `<p>三个自助面：<a href="${pfx}/inbox/">待我处理</a>（待签报价/待批准/待确认中标/待回澄清/超期未回）· `
      + `<a href="${pfx}/sign/">人签</a>（署名必须等于会话身份）· `
      + `<a href="${pfx}/mail/config/">邮件配置</a>（仅 ops 侧）· `
      + `<a href="${pfx}/plugins/">我的插件</a>（只装卸自己命名空间）</p>`
      + `<p>JSON 自述：<code>${pfx}/identity/me</code>；工作台 JSON：<code>${pfx}/inbox/api</code></p>`)
  }

  const inboxPage = (req, url) => {
    const wanted = text(url.searchParams.get('as_of'))
    const sideParam = text(url.searchParams.get('side'))
    const who = sideParam === '' ? whoOf(req) : require_(req, { side: sideParam })
    if (!who.ok) {
      return { status: who.status ?? 401, body: htmlPage('待我处理', `<p data-inbox-refused="${esc(who.code)}">`
        + `${esc(who.code)}：${esc(who.reason)} → ${esc(who.next_action)}</p>`) }
    }
    const data = workbench(who, { asOf: wanted === '' ? null : wanted })
    if (!data.ok) return { status: 400, body: htmlPage('待我处理', `<p>${esc(data.code)}：${esc(data.reason)}</p>`) }
    // P32：`data.items` 是行数组 ⇒ 走唯一读数入口（坏行跳过 + 计数，好行照列）
    const inboxRead = rowReadOf(data.items)
    const rows = inboxRead.rows.map((item) => `<tr data-inbox-item="${esc(item?.kind)}" data-ref="${esc(item?.ref)}"`
      + ` data-owed-by="${esc(item?.owed_by)}"><td>${esc(item?.kind)}</td><td><code>${esc(item?.ref)}</code></td>`
      + `<td>${esc(item?.title)}</td><td><code>${esc(item?.owed_by)}</code></td>`
      + `<td>${esc(item?.next_action)}</td></tr>`).join('')
    return { status: 200, body: htmlPage('待我处理', `<p data-inbox-identity="${esc(data.identity)}"`
      + ` data-inbox-view="${esc(data.view)}" data-inbox-as-of="${esc(data.as_of)}"`
      + ` data-inbox-count="${data.counts.total}" data-inbox-mine="${data.counts.mine}">`
      + `身份 <code>${esc(data.identity)}</code>（side=<code>${esc(data.side)}</code>），事实时刻 `
      + `<code>${esc(data.as_of)}</code>（${esc(data.as_of_source)}）：共 <b>${data.counts.total}</b> 项，`
      + `其中 <b>${data.counts.mine}</b> 项是本人的。</p>`
      + Object.entries(data.counts.by_kind).map(([kind, count]) => `<code>${esc(kind)}=${count}</code>`).join(' ')
      + droppedNote(inboxRead, '待办项')
      + (inboxRead.all
        ? `<table data-inbox="items"><thead><tr><th>类别</th><th>对象</th><th>是什么</th><th>谁该办</th>`
          + `<th>下一步</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p data-inbox-empty="${esc(data.empty_reason)}">没有该你处理的（${esc(data.empty_reason)}）`
          + `—— 不是页面坏了。</p>`)
      + `<p>换事实时刻：<a href="${pfx}/inbox/?as_of=2026-09-30T00:00:00Z">as_of=2026-09-30</a> · `
      + `<a href="${pfx}/inbox/">按账本事实时刻</a> · JSON：<code>${pfx}/inbox/api</code></p>`
      + `<p><small>只列 <code>owed_by</code> = <code>${esc(data.identity)}</code> 或 `
      + `<code>side:${esc(data.side)}</code> 的项；来源：<code>${esc(data.sources.ledger)}</code></small></p>`) }
  }

  const signPage = (req) => {
    const who = whoOf(req)
    if (!who.ok) {
      return { status: 401, body: htmlPage('人签', `<p data-sign-refused="${esc(who.code)}">${esc(who.code)}：`
        + `${esc(who.reason)} → <a href="${pfx}/identity/">去登录</a></p>`) }
    }
    const data = workbench(who, { asOf: null })
    if (!data.ok) return { status: 400, body: htmlPage('人签', `<p>${esc(data.reason)}</p>`) }
    const signable = data.items.filter((item) => ['quote-to-sign', 'award-to-confirm'].includes(item.kind)
      && item.stage === 'ledger'
      // 待签报价：**只有本人备的草稿**能出现在这里（人签只能本人签）；待确认中标：本侧的意向
      && (item.kind === 'quote-to-sign' ? item.owed_by === meOf(who) : item.owed_by === `side:${who.side}`))
    const blocks = signable.map((item) => {
      const isQuote = item.kind === 'quote-to-sign'
      const action = isQuote ? `${pfx}/sign/quote` : `${pfx}/sign/award`
      const field = isQuote ? 'draft_id' : 'intent_id'
      return `<h3>${esc(item.title)}</h3>`
        + `<p>签什么：<code>${esc(field)}=${esc(item.ref)}</code>`
        + `${item.money ? (item.money.line_count > 1
          ? ` · **共 <code>${esc(item.money.line_count)}</code> 行**（这一签就提交整份；逐行单价在提交后的`
            + `「我的报价」对象页上回读；币种 <code>${esc(item.money.currency || '—')}</code>）`
          : ` · 金额（整数分）<code>${esc(item.money.unit_price_cents ?? '—')}</code> `
            + `币种 <code>${esc(item.money.currency || '—')}</code>`) : ''}`
        + ` · 事实：<code>${esc(item.fact.type)} seq=${esc(item.fact.seq)} ts=${esc(item.fact.ts)}</code>`
        + `${item.detail?.payload_sha256 ? ` · 载荷指纹 <code>${esc(item.detail.payload_sha256)}</code>` : ''}</p>`
        + `<p>我是谁：<code>${esc(meOf(who))}</code>（取自**会话**）；后果：产生对外义务，不可撤销。</p>`
        + `<form method="post" action="${action}">`
        + `<input type="hidden" name="${field}" value="${esc(item.ref)}">`
        + `<label>署名（必须等于会话身份）<input name="signature" value="${esc(meOf(who))}" size="18" required></label> `
        + `<label>事实时刻 now <input name="now" value="${esc(data.as_of)}" size="22" required></label> `
        + `<button type="submit">人签 ${esc(isQuote ? '提交报价' : '确认中标')}</button></form>`
        + `<pre>终端等价命令：PYTHONPATH=src python3 ${isQuote
          ? 'src/domain/quote-prepare/tools/quote-sign.py' : 'src/domain/commitments/tools/commitment-apply.py'} `
        + `${isQuote ? `--draft-id ${item.ref}` : `--step confirm --intent-id ${item.ref}`} `
        + `--actor ${meOf(who)} --now ${esc(data.as_of)}</pre>`
    }).filter((block) => block !== '')
    return { status: 200, body: htmlPage('人签', `<p data-sign-identity="${esc(meOf(who))}">`
      + `会话身份 <code>${esc(meOf(who))}</code>（side=<code>${esc(who.side)}</code>）。`
      + `服务端一半会校验<strong>署名 == 会话身份</strong>，不一致一律拒（账本零新增）。</p>`
      + (blocks.length ? blocks.join('') : `<p data-sign-empty="1">当前没有可人签的项（与 `
        + `<a href="${pfx}/inbox/">待我处理</a> 同一口径；草稿只有本人能签）。</p>`)) }
  }

  const mailPage = (req, url) => {
    const who = require_(req, { side: 'ops', can: 'mail.config' })
    if (!who.ok) {
      return { status: who.status ?? 401, body: htmlPage('邮件配置（SMTP/IMAP）',
        `<p data-mail-refused="${esc(who.code)}">${esc(who.code)}：${esc(who.reason)} → ${esc(who.next_action)}</p>`) }
    }
    const data = mailFields()
    // P32：`data.rows` 是行数组 ⇒ 走唯一读数入口（坏行跳过 + 计数，好行照列）
    const mailRead = rowReadOf(data.rows)
    const rows = mailRead.rows.map((row) => `<tr data-mail-key="${esc(row?.key)}"><td><code>${esc(row?.key)}</code></td>`
      + `<td>${esc(row?.source)}</td><td>${row?.value_present ? '已设值（不回显）' : '未设值'}</td>`
      + `<td>${row?.needs_approval ? '人工专属键' : '运行期键'}</td></tr>`).join('')
    const keys = mailRead.rows.map((row) => row?.key).join('\n')
    return { status: 200, body: htmlPage('邮件配置（SMTP/IMAP）', `<p data-mail-identity="${esc(meOf(who))}"`
      + ` data-mail-config-file="${esc(data.config_file)}">身份 <code>${esc(meOf(who))}</code>（ops）。`
      + `本页只改 <code>mail.smtp.*</code> / <code>mail.imap.*</code> / <code>mail.timeout_seconds</code> / `
      + `<code>mail.max_messages</code>；<strong>凭据永不回显</strong>；提交后由 Python 侧 `
      + `<code>config-apply.py</code> 落 YAML（宿主不写文件）。</p>`
      + (data.degraded ? `<p><b>降级</b>：<code>${esc(data.reason)}</code></p>` : '')
      + `<table data-mail="keys"><thead><tr><th>键</th><th>source</th><th>值</th><th>门</th></tr></thead>`
      + `<tbody>${rows || '<tr><td colspan="4">（登记表里暂无邮件键）</td></tr>'}</tbody></table>`
      + droppedNote(mailRead, '邮件键行')
      + `<h2>改配置</h2><form method="post" action="${pfx}/mail/config/">`
      + `<input type="hidden" name="next" value="${esc(`${pfx}/mail/config/`)}">`
      + `<label>SMTP 主机 <input name="mail.smtp.host" size="24"></label><br>`
      + `<label>SMTP 端口 <input name="mail.smtp.port" size="6" value="587"></label><br>`
      + `<label>发件人 <input name="mail.smtp.from" size="24"></label><br>`
      + `<label>SMTP 账号 <input name="mail.smtp.username" size="16"></label><br>`
      + `<label>SMTP 握手 <select name="mail.smtp.security"><option>starttls</option><option>ssl</option>`
      + `<option>plain</option></select></label><br>`
      + `<label>IMAP 主机 <input name="mail.imap.host" size="24"></label><br>`
      + `<label>IMAP 端口 <input name="mail.imap.port" size="6" value="993"></label><br>`
      + `<label>IMAP 账号 <input name="mail.imap.username" size="16"></label><br>`
      + `<label>或贴 YAML 片段<textarea name="yaml" rows="4" cols="48" placeholder="project:&#10;  mail.smtp.host: smtp.example.com"></textarea></label><br>`
      + `<label>署名（必须等于会话身份）<input name="signature" value="${esc(meOf(who))}" size="18"></label> `
      + `<label>事实时刻 now <input name="now" value="2026-09-30T00:00:00Z" size="22"></label> `
      + `<button type="submit">干跑 → 落盘</button></form>`
      + `<p><small>已登记邮件键：<code>${esc(keys || '—')}</code>；口令请给凭据名（`
      + `<code>${pfx}/admin/api/credentials/mail_smtp</code>，只写不回显）。</small></p>`) }
  }

  const pluginsPage = (req) => {
    const who = require_(req, { can: 'plugins.self' })
    if (!who.ok) {
      return { status: who.status ?? 401, body: htmlPage('我的插件', `<p data-plugins-refused="${esc(who.code)}">`
        + `${esc(who.code)}：${esc(who.reason)} → ${esc(who.next_action)}</p>`) }
    }
    const data = pluginsView(who)
    const pluginLine = (ns, item) => {
      const form = item.loaded
        ? `<form method="post" action="${pfx}/plugins/unload"><input type="hidden" name="ns" value="${esc(ns)}">`
          + `<input type="hidden" name="plugin" value="${esc(item.name)}"><button type="submit">卸载</button></form>`
        : `<form method="post" action="${pfx}/plugins/load"><input type="hidden" name="ns" value="${esc(ns)}">`
          + `<input type="hidden" name="plugin" value="${esc(item.name)}"><button type="submit">装载</button></form>`
      const actions = item.mine ? form
        : `<small>不是你的命名空间：装卸请找管理员（<code>${pfx}/admin/api/user-plugins/**</code>）</small>`
      return `<p data-plugin="${esc(ns)}/${esc(item.name)}" data-plugin-loaded="${item.loaded}"`
        + ` data-plugin-mine="${item.mine}"><code>${esc(item.name)}@${esc(item.version || '-')}</code> `
        + `${item.loaded ? '已装载' : '未装载'}${item.invalid ? `（清单非法：${esc(item.reason)}）` : ''} `
        + `${actions}</p>`
    }
    const nsBlock = (entry) => `<h3><code>${esc(entry.ns)}</code>`
      + `${entry.mine ? '（我的命名空间）' : '（别人的，只读）'}</h3>`
      + (entry.plugins ?? []).map((item) => pluginLine(entry.ns, item)).join('')
    const blocks = (data.namespaces ?? []).map(nsBlock).join('')
    const body = htmlPage('我的插件', `<p data-plugins-identity="${esc(meOf(who))}"`
      + ` data-plugins-mine="${esc(data.mine)}">身份 <code>${esc(meOf(who))}</code>：你的命名空间是 `
      + `<code>${esc(data.mine)}</code>。装卸只允许自己的命名空间；跨命名空间一律拒`
      + `（<code>not-my-namespace</code>，账本零新增）。</p>`
      + (data.degraded ? `<p><b>降级</b>：<code>${esc(data.reason)}</code> ${esc(data.next_action)}</p>` : '')
      + (blocks || '<p>（用户空间里还没有插件）</p>'))
    return { status: 200, body }
  }

  /** 解析请求体：JSON 或表单（两种形状都收；JSON 带类型）。 */
  const readInput = (body, contentType) => {
    if (String(contentType ?? '').includes('json')) {
      try {
        const parsed = JSON.parse(String(body || '{}'))
        return plain(parsed) ? parsed : {}
      } catch (err) { return {} }
    }
    const out = {}
    for (const [key, value] of new URLSearchParams(String(body ?? ''))) {
      if (key === 'yaml') { out.yaml = String(value); continue }
      out[key] = String(value)
    }
    return out
  }
  const wantsJson = (url, req) => url.searchParams.get('format') === 'json'
    || String(req?.headers?.accept ?? '').includes('application/json')
    || String(req?.headers?.['content-type'] ?? '').includes('json')

  /**
   * 把本文件的路由注册到既有路由注册面（`ui-route.mjs`；机制不改）。
   * @param {{register: Function}} registry `webui.mjs` 的 `uiRoutes`
   */
  const register = (registry) => {
    const list = []
    const add = (method, path, handler, what, auth) => {
      const out = registry.register({ method, path, handler, what, auth })
      list.push({ method, path, ok: out.ok === true, code: out.code, what, auth })
      if (out.ok !== true) say(`路由注册被拒：${method} ${path} → ${out.code}（${flat(out.reason)}）`)
      return out
    }
    // ① 身份与会话
    add('GET', '/identity/', (request) => {
      const out = identityPage(request.req, request.url)
      return typeof out === 'string' ? request.send(200, 'text/html; charset=utf-8', out)
        : request.send(out.status, 'text/html; charset=utf-8', out.body)
    }, '身份与会话：登录/切换/登出（服务端会话 0600 + 不透明 cookie）', 'identity')
    add('GET', '/identity/me', (request) => {
      const who = whoOf(request.req)
      return request.json(who.ok ? 200 : 401, who.ok
        ? { ok: true, human: who.human, name: who.name, side: who.side, session_id_present: true,
          expires_at: new Date(who.expires_at).toISOString(), sides: IDENTITY_SIDES.map((s) => s.id),
          note: '会话 id 不回显（它是 bearer；本响应只给身份与有效期）' }
        : { ok: false, code: who.code, reason: who.reason, next_action: who.next_action })
    }, '当前身份（JSON；会话 id 不回显）', 'identity')
    add('POST', '/identity/login', (request) => request.readBody((body) => {
      const input = readInput(body, request.req.headers['content-type'])
      const out = login({ name: input.name, side: input.side })
      if (!out.ok) return request.json(400, out)
      if (wantsJson(request.url, request.req)) {
        return request.send(200, 'application/json; charset=utf-8',
          JSON.stringify({ ok: true, human: out.human, side: out.side, session_file: out.session_file,
            session_mode: out.session_mode, expires_at: new Date(out.expires_at).toISOString(),
            // **登录即登记**（名册口径）：回执如实说明"他进名册了吗、什么角色" —— 有名字没权限，
            // 等主管在「人员名册与角色」面板里补角色（受额度限制的动作会拒他）。
            roster: out.roster ?? null,
            next_action: out.next_action }, null, 2) + '\n', { 'set-cookie': out.cookie })
      }
      const next = text(input.next)
      const target = next.startsWith('/') ? next : `${pfx}/inbox/`
      return request.send(303, 'text/plain; charset=utf-8', '', { location: target, 'set-cookie': out.cookie })
    }), '登录/切换身份（human:<名字> + side）', 'identity')
    add('POST', '/identity/logout', (request) => request.readBody((body) => {
      const out = logout(request.req)
      if (wantsJson(request.url, request.req)) {
        return request.send(200, 'application/json; charset=utf-8',
          JSON.stringify({ ok: true, code: out.code, next_action: out.next_action }, null, 2) + '\n',
          { 'set-cookie': out.cookie })
      }
      return request.send(303, 'text/plain; charset=utf-8', '', { location: `${pfx}/identity/`,
        'set-cookie': out.cookie })
    }), '登出（只减权：删会话 + 清 cookie）', 'identity')
    // ② 「待我处理」工作台（页面 + JSON；两侧各一条，越侧即拒）
    add('GET', '/inbox/', (request) => {
      const out = inboxPage(request.req, request.url)
      return request.send(out.status, 'text/html; charset=utf-8', out.body)
    }, '待我处理（按会话身份；五类待办，只列本人/本侧）', 'identity')
    add('GET', '/inbox/api', (request) => {
      const who = whoOf(request.req)
      if (!who.ok) return request.json(401, { ok: false, ...who })
      const data = workbench(who, { asOf: text(request.url.searchParams.get('as_of')) || null })
      return request.json(data.ok ? 200 : 400, data)
    }, '待我处理（JSON：workbench 的原始形状，供机器核对）', 'identity')
    for (const side of views()) {
      add('GET', `/${side}/inbox/`, (request) => {
        const out = inboxPage(request.req, request.url)
        return request.send(out.status, 'text/html; charset=utf-8', out.body)
      }, `${side} 侧的「待我处理」页（身份必须属于该侧）`, 'identity')
      add('GET', `/${side}/inbox/api`, (request) => {
        const who = require_(request.req, { side })
        if (!who.ok) return request.json(who.status ?? 401, { ok: false, ...who })
        const data = workbench(who, { asOf: text(request.url.searchParams.get('as_of')) || null })
        return request.json(data.ok ? 200 : 400, data)
      }, `${side} 侧的「待我处理」JSON（越侧即拒）`, 'identity')
    }
    // ③ 人签（页面 + 两个动作的服务端一半）
    add('GET', '/sign/', (request) => {
      const out = signPage(request.req)
      return request.send(out.status, 'text/html; charset=utf-8', out.body)
    }, '人签页：待签报价 / 待确认中标（署名必须等于会话身份）', 'identity')
    const signHandler = (op) => (request) => request.readBody((body) => {
      const input = readInput(body, request.req.headers['content-type'])
      const out = op === 'quote' ? signQuote(request.req, input) : signAward(request.req, input)
      if (wantsJson(request.url, request.req)) return request.json(out.status, out)
      if (out.ok) {
        return request.send(303, 'text/plain; charset=utf-8', '', { location: `${pfx}/inbox/` })
      }
      return request.send(out.status, 'text/html; charset=utf-8',
        htmlPage('人签被拒', `<p data-sign-refused="${esc(out.code)}">${esc(out.code)}：${esc(out.reason)} → `
          + `${esc(out.next_action)}（账本零新增）</p><p><a href="${pfx}/sign/">返回人签页</a></p>`))
    })
    add('POST', '/sign/quote', signHandler('quote'), '人签「提交报价」（会话→唯一写者 quote-sign.py）', 'identity')
    add('POST', '/sign/award', signHandler('award'), '人签「确认中标」（会话→commitment-apply.py --step confirm）', 'identity')
    // ④ DEF-025：邮件配置（仅 ops 侧；持久化由 Python 侧 config-apply.py 做）
    add('GET', '/mail/config/', (request) => {
      const out = mailPage(request.req, request.url)
      return request.send(out.status, 'text/html; charset=utf-8', out.body)
    }, '邮件（SMTP/IMAP）配置页：有权限的身份可改并持久化（凭据不回显）', 'identity')
    add('POST', '/mail/config/', (request) => request.readBody((body) => {
      const input = readInput(body, request.req.headers['content-type'])
      const out = applyMailConfig(request.req, input)
      // `next`：改完**回到你来的那个界面**（GUI 工作台的「邮件通道」面板也提交到本页；只接受本站路径，
      // 防止开放重定向）。缺省回本页 —— 与既有行为一致。
      const wanted = text(input.next)
      const back = wanted.startsWith('/') && !wanted.startsWith('//') ? wanted : `${pfx}/mail/config/`
      if (wantsJson(request.url, request.req)) return request.json(out.status, out)
      if (out.ok) {
        return request.send(303, 'text/plain; charset=utf-8', '', { location: back })
      }
      return request.send(out.status, 'text/html; charset=utf-8',
        htmlPage('邮件配置被拒', `<p data-mail-refused="${esc(out.code)}">${esc(out.code)}：${esc(out.reason)} → `
          + `${esc(out.next_action)}</p><p><a href="${esc(back)}">返回</a> · `
          + `<a href="${esc(pfx)}/mail/config/">邮件配置页</a></p>`))
    }), '提交邮件配置（干跑 → 0600 待办件 → Python 侧落 YAML）', 'identity')
    // ⑤ DEF-026：我的用户空间插件（自助装卸，只限自己命名空间）
    add('GET', '/plugins/', (request) => {
      const out = pluginsPage(request.req)
      return request.send(out.status, 'text/html; charset=utf-8', out.body)
    }, '「我的插件」：自助装卸自己命名空间的用户空间插件（自建视图随之出现/消失）', 'identity')
    const pluginHandler = (op) => (request) => request.readBody((body) => {
      const input = readInput(body, request.req.headers['content-type'])
      const promise = pluginOp(request.req, { ...input, op })
      return promise.then((out) => (wantsJson(request.url, request.req) ? request.json(out.status, out)
        : request.send(out.ok ? 303 : out.status, 'text/plain; charset=utf-8',
          out.ok ? '' : JSON.stringify(out, null, 2) + '\n',
          out.ok ? { location: `${pfx}/plugins/` } : {}))).catch((err) => request.json(500,
        { ok: false, code: 'plugin-op-failed', reason: flat(err) }))
    })
    for (const op of ['load', 'unload', 'reload']) {
      add('POST', `/plugins/${op}`, pluginHandler(op), `自助${op === 'load' ? '装载' : (op === 'unload' ? '卸载' : '重载')}`
        + '自己的用户空间插件（跨命名空间即拒）', 'identity')
    }
    return { ok: list.every((item) => item.ok), routes: list }
  }

  return { register, resolve: whoOf, whoOf, login, logout, requireGuard: require_, workbench, signQuote, signAward,
    mailFields, applyMailConfig, pluginsView, pluginOp, myNamespace, gateBusinessRoute,
    paths: { sessions_file: sessionsFile, dir, shared: sharedDir },
    ledgerPaths: { contractor: ledgerOf('contractor'), supplier: ledgerOf('supplier') },
    sides: IDENTITY_SIDES, prefix: pfx }
}
