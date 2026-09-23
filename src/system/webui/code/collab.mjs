/**
 * collab —— **同一侧人类之间的对象级协作**（指派/转交、关注、评论与 `@同事`、活动流、已读），外壳机制层。
 *
 * 它为什么存在：用户的原话是「打开 Teams 能做到的比你多、没人有理由用这个产品」。Teams/VSCode 的日常
 * 工作方式里，除了"看数据"还有**把活交出去**（指派/转交给同事，带原因与截止）、**叫人看**（关注/活动流）、
 * **在对象上说话**（评论 + `@同事`）、**分清这是不是我的事**（我的 / 我指派的 / 全部）。本文件提供这层的
 * **机制**：只存"谁在哪个对象上做过什么协同动作"，不认识任何业务名词（对象类由插件声明，见 `collab-ui.mjs`）。
 *
 * 本批新增的**跨对象活动流**（「我的今日」，`feed()`）：把「我关注的对象 + 我参的流程」上的事件聚成
 * 一条时间线（协作事件 + 由外壳**只读**给进来的**本侧**账本事实），可按类型/对象/人/时间筛、标已读、
 * 跳对象页、导出文本（`feedExport()`）。它**不新建任何存储**：读的还是这两个来源，写只写"我的已读水位"。
 *
 * ============================ 为什么这些数据**不能进账本**（硬约束，别搬） ============================
 * 账本是**合同事实**的 append-only 记录：每一行都要能被审计包/哈希链/模型输入重建，且必须表示对外承诺或
 * 业务状态变化（`AGENTS.md` 规则 2「模型可见 ⟺ 账本可见」、规则 3「承诺需人工批准」）。而本文件存的是
 * **人对界面的协同痕迹**：谁看过哪条、@了谁、评论正文、"我派给谁"这种内部排队。它们不是合同事实：
 *   · 写进账本 ⇒ 事件类型目录/证据包哈希/审计取证的语义被改变（一次"标为已读"会污染合同事实的时间线），
 *     并且会让"谁在哪条事实上签过字"这种取证被噪音淹没 —— 这就是**破坏审计语义**；
 *   · 写进账本 ⇒ 按规则 2 它们就变成模型可见输入，于是"人的私下协同意见"会被当成业务事实喂给模型，错。
 * 因此：协作数据只落 **`<ui_shared>/collab/<side>.json`（0600、原子写、按侧分文件）**，不进投影、不进 QEP、
 * 不进模型输入，也**不出现第二条事实写路径**：本文件不 import 任何账本 API、不写账本、不 spawn 写者。
 *
 * 隔离与边界：
 *   · **按侧隔离**：一侧一个文件；`side` 只由调用方（外壳按**会话身份**）给，本文件不接受请求体里的 side
 *     ⇒ 供应商进程/身份读不到承包商内部的指派与评论（0 命中，不是"过滤掉"）；
 *   · **同侧人类之间**：`actor` 必须是 `human:<名字>`，且 `to` 必须是**本侧名册在册成员**
 *     （名册 = `people.mjs` 的 0600 配置：单位里真实有谁、什么角色；登录一次会自动登记为「待指派」）；
 *     跨侧的名字一律拒（`unknown-colleague`）——协作不走这里，跨侧只走 QEP 报文；
 *   · 时间戳是**界面级**的（协作不是事实）⇒ 用调用方给的 `at`（外壳的 `host.now()`），本文件不取墙钟；
 *   · 有界：单对象评论 200 条 / 活动 300 条 / 关注者 64 人；对象数 500（超出按"最久没动过"淘汰并如实报数）。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

export const COLLAB_SCHEMA = 'quotagent/collab/v1'
export const COLLAB_DIR = 'collab'
/** 账本行扫描上限（有界）：活动流只在这个窗口里聚合，超出的行不参与（如实计数在回执里）。 */
export const MAX_LEDGER_ROWS = 20000
/** 「我的今日」一条时间线的**单次产出上限**（界面上还有服务端窗口分页；这里是硬顶，不静默）。 */
export const FEED_MAX = 400
const sha256Hex = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')
/** 协作数据的**存储口径自述**（进 `/api/ui/surface`，用来对账"它没进账本"）。 */
export const COLLAB_WHY_NOT_LEDGER = '协作（指派/关注/评论/已读）是**人对界面的协同痕迹**，不是合同事实：'
  + '进账本会改变事件类型目录、证据包哈希与审计取证语义，并会把人的私下意见变成模型可见输入。'
  + '所以只落 `<ui_shared>/collab/<side>.json`（0600、按侧隔离），不进账本、不进投影、不进模型输入。'
export const MAX_OBJECTS = 500
export const MAX_COMMENTS = 200
export const MAX_EVENTS = 300
export const MAX_WATCHERS = 64
export const MAX_TEXT = 2000
export const MAX_REASON = 500
export const REFUSAL_CODES = ['identity-required', 'unknown-side', 'kind-malformed', 'id-malformed',
  'colleague-malformed', 'unknown-colleague', 'reason-required', 'reason-too-long', 'due-invalid',
  'body-required', 'body-too-long', 'cross-side-mentioned', 'not-assigned-to-you', 'transfer-not-yours',
  'collab-write-failed', 'object-required', 'feed-nothing-to-export']

const NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
/** 对象 id：它只做**键**（不进路径），故允许业务侧的 id 形状（`pkg-g1` / `q-748cf…` / `chg-0001`）。 */
const ID_RE = /^[^\u0000-\u001f<>{}"'/]{1,96}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/
/** `@同事` 的形状：前面是行首或分隔符，名字与 `human:<名字>` 同一口径（ASCII 小写集）。 */
const MENTION_RE = /(^|[\s(（[【,，。;；:：])@([a-z][a-z0-9._-]{0,31})/g

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const flat = (value, limit = 200) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)
const refusal = (code, reason, next_action, extra = {}) => ({ ok: false, code, reason, next_action, ...extra })
const keyOf = (kind, id) => `${kind}/${id}`
/**
 * `a` 是不是**晚于** `b`（时刻比较，**不是字符串比较**）。
 *
 * 为什么不能比字符串：账本行的 `ts` 是**秒精度**（`…T05:08:56Z`），而界面给的 `at`（`host.now()`）是
 * **毫秒精度**（`…T05:08:56.123Z`）—— 两者逐字符比时 `'…56Z' > '…56.123Z'`（`Z` > `.`），
 * 于是"同一秒里刚写下的事实"会被判成晚于我刚刚的已读水位 ⇒ 标完已读仍显示未读（实测就是这么错的）。
 * 解析不出来的（坏时刻）回落到字符串比较：**不假装知道先后**，但也不因此报错。
 */
const laterThan = (a, b) => {
  const left = Date.parse(text(a))
  const right = Date.parse(text(b))
  if (Number.isFinite(left) && Number.isFinite(right)) return left > right
  return text(a) > text(b)
}

// ------------------------------------------------------------------ 显示口径（**只影响给人看的文案**）
/**
 * 人话名字：`human:limin` → `limin`。`human:` 前缀只该出现在**原始回执/账本/文件**里；
 * 界面上与同屏的 `@limin（主管 · 在线）` 一致（P13 走查实测：协作面板把 `human:limin` 当人名显示，
 * 与同屏名册口径互相矛盾）。
 */
/** 界面层（`collab-ui.mjs`）用同一套显示口径 ⇒ 导出，别各写一份（重复即漂移）。 */
export const nameOf = (human) => String(human ?? '').replace(/^human:/, '')
/** 服务进程所在时区的标签（UTC 就写 `UTC`，别的写 `UTC+08:00`）—— 时间要**说明是哪个时区**，不裸扔 ISO。 */
const TZ_LABEL = (() => {
  const off = -new Date().getTimezoneOffset()          // 分钟；东为正
  if (off === 0) return 'UTC'
  const pad = (n) => String(Math.abs(n)).padStart(2, '0')
  return `UTC${off > 0 ? '+' : '-'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
})()
/** 时刻的人话：`2026-09-23T00:50:49.366Z` → `2026-09-23 08:50（UTC+08:00）`（毫秒与 `T`/`Z` 不进界面）。 */
export const atLabel = (iso) => {
  const raw = text(iso)
  if (raw === '') return ''
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return raw                    // 解析不了就原样显示（不替它编一个时间）
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${TZ_LABEL}）`
}
/**
 * 显示前把**存下来的原文**洗一遍：`human:<名>` → `@<名>`，毫秒 ISO → `atLabel`。
 * 为什么需要：事件的 `summary`（如 `human:wanglei 把「…」指派给 human:limin`）是**存进文件的事实原文**，
 * 逻辑判据要用（`by`/`to` 要是 `human:<名>`），但**显示**不该把内部标识裸给人看。
 */
export const pretty = (value) => String(value ?? '')
  .replace(/human:([a-z][a-z0-9._-]{0,31})/g, '@$1')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, (found) => atLabel(found))

/** 坏形状清单最多列这么多条（面板上够用了；总数另算，不丢）。 */
const MAX_PROBLEMS = 20
/** 模块级的 `human:<名字>` 归一（工厂里那个 `humanOf` 只在该作用域内可见；这里要独立的）。 */
const asHuman = (value) => {
  const raw = text(value)
  if (raw === '') return ''
  const name = raw.startsWith('human:') ? raw.slice(6) : raw
  return NAME_RE.test(name) ? `human:${name}` : ''
}

// ------------------------------------------------------------------ 形状洗净（**读侧韧性**）
const humanList = (value, max = MAX_WATCHERS) => {
  if (value === undefined || value === null) return { list: [], dropped: 0 }
  if (!Array.isArray(value)) return { list: [], dropped: 1, malformed: '不是数组' }
  const list = []
  let dropped = 0
  for (const item of value) {
    const human = typeof item === 'string' ? asHuman(item) : ''
    if (human === '' || list.includes(human)) { dropped += 1; continue }
    list.push(human)
  }
  if (list.length > max) { dropped += list.length - max; list.length = max }
  return { list, dropped }
}
const plainRows = (value, clean) => {
  if (value === undefined || value === null) return { list: [], dropped: 0 }
  if (!Array.isArray(value)) return { list: [], dropped: 1, malformed: '不是数组' }
  const list = []
  let dropped = 0
  for (const row of value) {
    if (!plain(row)) { dropped += 1; continue }
    const cleaned = clean(row)
    if (cleaned === null) { dropped += 1; continue }
    list.push(cleaned)
  }
  return { list, dropped }
}
/**
 * 洗净**一个协作对象**（`objects["<kind>/<id>"]`）。
 * 判据：能读的字段照读、读不懂的字段**跳过并如实计数**（既不当它不存在，也不抛异常）。
 */
const sanitizeObject = (key, row, problems, dropped) => {
  /** 容器形状坏（整块读不出来）的字段名：写盘时原样带回文件，且**拒绝往它里面追加**（免得悄悄丢数据）。 */
  const malformed = []
  const note = (field, why, count, container = false) => {
    if (container && !malformed.includes(field)) malformed.push(field)
    if (!count) return
    dropped[field] = (dropped[field] ?? 0) + count
    if (problems.length < MAX_PROBLEMS) problems.push({ object: key, field, why, dropped: count })
  }
  const obj = { kind: text(row.kind), id: text(row.id), title: text(row.title),
    assignment: null, watchers: [], comments: [], events: [], reads: {},
    dropped_comments: Number(row.dropped_comments) > 0 ? Number(row.dropped_comments) : 0,
    evicted: Number(row.evicted) > 0 ? Number(row.evicted) : 0,
    created_at: text(row.created_at), touched_at: text(row.touched_at) }
  // 指派：要么是一个对象（`{to, by, …}`），要么是 null；形状不对 ⇒ 当作"没有指派"并如实计数
  if (row.assignment !== undefined && row.assignment !== null) {
    if (!plain(row.assignment)) note('assignment', '不是 `{to, by, reason, due, at, status}` 对象', 1, true)
    else {
      const to = asHuman(row.assignment.to)
      const by = asHuman(row.assignment.by)
      if (to === '' || by === '') note('assignment', '`to`/`by` 不是 `human:<名字>`', 1)
      else {
        const history = plainRows(row.assignment.history, (item) => (plain(item)
          ? { type: text(item.type), by: asHuman(item.by), to: asHuman(item.to), reason: text(item.reason),
            due: text(item.due), at: text(item.at) } : null))
        note('assignment', '`history` 里有读不懂的行（已跳过）', history.dropped)
        if (history.malformed) note('assignment', '`history` 不是数组', 1, true)
        obj.assignment = { to, by, reason: text(row.assignment.reason), due: text(row.assignment.due),
          at: text(row.assignment.at), status: text(row.assignment.status) || 'open', history: history.list }
      }
    }
  }
  const watchers = humanList(row.watchers, MAX_WATCHERS)
  note('watchers', watchers.malformed ?? '不是 `human:<名字>`（已跳过）', watchers.dropped, Boolean(watchers.malformed))
  obj.watchers = watchers.list
  const comments = plainRows(row.comments, (item) => (text(item.body) === '' && text(item.by) === ''
    ? null : { cid: text(item.cid), by: asHuman(item.by) || `human:${nameOf(text(item.by))}`,
      at: text(item.at), body: String(item.body ?? ''), bytes: Number(item.bytes) || 0,
      mentions: humanList(item.mentions, 64).list, unresolved: humanList(item.unresolved, 64).list }))
  note('comments', comments.malformed ?? '评论行形状不对（已跳过）', comments.dropped, Boolean(comments.malformed))
  obj.comments = comments.list
  const events = plainRows(row.events, (item) => ({ eid: text(item.eid), type: text(item.type),
    by: asHuman(item.by) || text(item.by), to: asHuman(item.to) || text(item.to), at: text(item.at),
    cid: text(item.cid), summary: flat(item.summary, 400),
    mentions: humanList(item.mentions, 64).list }))
  note('events', events.malformed ?? '活动行形状不对（已跳过）', events.dropped, Boolean(events.malformed))
  obj.events = events.list
  if (row.reads !== undefined && row.reads !== null && !plain(row.reads)) {
    note('reads', '不是 `{"human:<名字>": "<时刻>"}` 对象', 1, true)
  } else if (plain(row.reads)) {
    let droppedReads = 0
    for (const [human, at] of Object.entries(row.reads)) {
      if (asHuman(human) === '' || text(at) === '') { droppedReads += 1; continue }
      obj.reads[asHuman(human)] = text(at)
    }
    note('reads', '读不懂的已读记录（已跳过）', droppedReads)
  }
  return { obj, malformed }
}

/**
 * 洗净整份协作文件（**只读；绝不回写文件**）。
 * 返回 `{ doc, broken }`：`broken` 非空 = 这份文件**整体读不出来**（JSON 坏了/顶层不是对象）——
 * 这时**不能假装"还没有协作记录"**，要把它原样报给界面（原因 + 怎么修）。
 */
const sanitizeDoc = (raw, side) => {
  const doc = { schema: COLLAB_SCHEMA, side, objects: {}, people: {}, updated_at: '', note: COLLAB_WHY_NOT_LEDGER }
  const dropped = {}
  const problems = []
  const byObject = {}                 // 对象键 → 容器形状坏的字段名（写盘时带回 + 拒绝追加）
  doc.updated_at = text(raw.updated_at)
  for (const [key, row] of Object.entries(plain(raw.objects) ? raw.objects : {})) {
    if (!plain(row)) {
      dropped.objects = (dropped.objects ?? 0) + 1
      byObject[key] = ['(整条记录)']
      if (problems.length < MAX_PROBLEMS) {
        problems.push({ object: key, field: '(整条记录)', why: '不是一个对象', dropped: 1 })
      }
      continue
    }
    const cleaned = sanitizeObject(key, row, problems, dropped)
    if (cleaned.malformed.length) byObject[key] = cleaned.malformed
    doc.objects[key] = cleaned.obj
  }
  for (const [human, row] of Object.entries(plain(raw.people) ? raw.people : {})) {
    if (!plain(row)) { dropped.people = (dropped.people ?? 0) + 1; continue }
    doc.people[asHuman(human) || human] = { name: text(row.name) || nameOf(human),
      first_at: text(row.first_at), last_at: text(row.last_at) }
  }
  if (raw.people !== undefined && !plain(raw.people)) dropped.people = (dropped.people ?? 0) + 1
  doc.sanitized = { counts: dropped, problems, by_object: byObject,
    dropped_total: Object.values(dropped).reduce((sum, n) => sum + Number(n || 0), 0),
    fields: { watchers: 'human:<名字> 的**数组**', comments: '评论行数组（{by, at, body, mentions[]}）',
      events: '活动行数组（{eid, type, by, at, summary}）', reads: '`{"human:<名字>": "<时刻>"}` 对象',
      assignment: '`{to, by, reason, due, at, status}` 对象或 null', history: '`history` 里是数组' },
    read_only: true }
  return { doc, broken: null }
}

/**
 * 文件里**容器形状坏、且内容没法按新形状重建**的字段（按对象 → 字段名）：写盘时**原样带回**，
 * 免得一次正常保存把"读不懂但确实在文件里"的内容悄悄抹掉（不静默吞掉数据的另一半含义）。
 * 只带这两类：**用户写的**关注名单与评论（我们没法替它重建）。`assignment`/`reads`/`events`
 * 在写入时**本来就会被整体改写**（那正是那些人手改坏的地方）⇒ 按新形状重建并在回执里如实报 `shape_rebuilt`。
 */
const carryForward = (file) => {
  const out = new Map()
  let raw = null
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { return out }
  if (!plain(raw) || !plain(raw.objects)) return out
  for (const [key, row] of Object.entries(raw.objects)) {
    if (!plain(row)) { out.set(key, { '(整条记录)': row }); continue }
    const bad = {}
    for (const field of ['watchers', 'comments']) {
      const value = row[field]
      if (value === undefined || value === null) continue
      if (!Array.isArray(value)) bad[field] = value
    }
    if (Object.keys(bad).length) out.set(key, bad)
  }
  return out
}


/**
 * 建协作存储。
 * @param {object} options
 * @param {string} options.root 仓库根（路径只用来算相对路径，便于回执里给人看的路径）
 * @param {string} options.sharedDir 共享目录（`<ui_shared>`；协作文件落它下面的 `collab/`）
 * @param {string} [options.sessionsFile] 身份会话文件（**只读**：只用来标"这个人今天登录没有"）
 * @param {object} [options.people] **人员名册与角色**句柄（`people.mjs`；**同事名单的唯一真源**）
 * @param {string[]} [options.sides] 允许的侧（由外壳从身份面传入，本文件不硬编码）
 * @param {(msg: string) => void} [options.log]
 */
export function createCollabStore({ root = '.', sharedDir, sessionsFile = '', people = null, sides = [], log } = {}) {
  const base = resolve(String(root ?? '.'), String(sharedDir ?? 'tmp/ui-shared'))
  const dir = join(base, COLLAB_DIR)
  let allowedSides = sides.map(text).filter(Boolean)
  /** 会话文件路径（**只读**；装配顺序是"外壳先建、身份面后建" ⇒ 建好后由 `configure()` 补上）。 */
  let sessionsPath = text(sessionsFile) === '' ? '' : resolve(String(root ?? '.'), sessionsFile)
  /** **名册句柄**（同事名单的唯一真源；同样是后补：`configurePeople` 在身份面建好后调 `configure`）。 */
  let roster = people
  const say = (msg) => { if (typeof log === 'function') log(`[collab] ${msg}`)
  }
  const fileOf = (side) => join(dir, `${side}.json`)

  /**
   * 装配期后补配置（外壳与身份面的建立顺序不能反：会话文件与合法侧只有身份面知道）。
   * 只影响"本侧同事名单"与侧校验；**已经落下的协作数据不动**。
   */
  const configure = ({ sessionsFile: file, sides: nextSides, people: nextPeople } = {}) => {
    if (typeof file === 'string' && file.trim() !== '') sessionsPath = resolve(String(root ?? '.'), file.trim())
    if (Array.isArray(nextSides) && nextSides.length) allowedSides = nextSides.map(text).filter(Boolean)
    if (nextPeople) roster = nextPeople
    return { ok: true, sessions_file: sessionsPath, sides: allowedSides, roster: Boolean(roster) }
  }

  const emptyDoc = (side) => ({ schema: COLLAB_SCHEMA, side, objects: {}, people: {},
    updated_at: '', note: COLLAB_WHY_NOT_LEDGER, sanitized: { counts: {}, problems: [], dropped_total: 0,
      fields: {}, read_only: true }, broken: null })
  /** 文件**整体**读不出来时的**如实降级**读数（不是"还没有协作记录"）。 */
  const brokenDoc = (side, code, reason) => {
    const doc = emptyDoc(side)
    doc.broken = { code, reason, file: relative(resolve(String(root ?? '.')), fileOf(side)),
      how_to_fix: '这份协作文件（0600）是**配置**不是账本：把它改回 `{"schema":"quotagent/collab/v1",'
        + '"objects":{},"people":{}}` 这份形状即可（也可以直接删掉它 —— 会被当成"还没有协作记录"）；'
        + '协作面每次渲染都真读盘、不缓存 ⇒ **改好下一次刷新就自动恢复**。',
      next_action: `${relative(resolve(String(root ?? '.')), fileOf(side))} 读不出来：修好这个文件，或删掉它重建（面板会自动恢复）` }
    return doc
  }

  /**
   * 读一份协作文件（**每次都真读盘：不缓存** ⇒ 坏了的面板在文件改对后**下一次渲染自动恢复**）。
   * 坏形状的字段：能读的照读、读不懂的**跳过并如实计数**（`doc.sanitized`）—— **绝不**因为一个坏字段
   * 把整块面板打成 `TypeError`（实测：`watchers` 写成对象会让工作台整块红脸，人只看到"修插件的 data()"）。
   * 文件整个读不出来：回 `doc.broken`（不是"没有协作记录"），界面据此说清原因与怎么修。
   */
  const load = (side) => {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(fileOf(side), 'utf8'))
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyDoc(side)      // 还没写过：这才是真的"还没有"
      return brokenDoc(side, 'collab-file-unreadable', flat(err))
    }
    if (!plain(raw)) {
      return brokenDoc(side, 'collab-file-not-an-object',
        `顶层不是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`)
    }
    if (raw.objects !== undefined && !plain(raw.objects)) {
      return brokenDoc(side, 'collab-file-objects-not-an-object',
        '`objects` 不是对象（它要是「`<对象类>/<id>` → 一条协作记录」的键值表）')
    }
    return sanitizeDoc({ ...raw, objects: raw.objects ?? {} }, side).doc
  }
  /**
   * 原子写：临时文件 → `chmod 0600` → rename（不受 umask 影响；与身份会话同一口径）。
   * 两件本批新做的事：① 派生读数（`sanitized`/`broken`）**不进文件**；② 容器形状坏、读不出来的字段
   * **原样带回**（不因为一次正常保存就把文件里读不懂的内容抹掉），并在回执里如实报 `shape_carried`。
   */
  const save = (side, doc) => {
    doc.updated_at = text(doc.updated_at)
    const clean = { schema: COLLAB_SCHEMA, side, objects: {}, people: doc.people ?? {},
      updated_at: text(doc.updated_at), note: COLLAB_WHY_NOT_LEDGER }
    const carried = []
    const rebuilt = []
    const unreadable = carryForward(fileOf(side))
    for (const [key, row] of Object.entries(doc.objects ?? {})) {
      if (!plain(row)) continue
      const badAll = unreadable.get(key) ?? {}
      const bad = { ...badAll }
      if (bad['(整条记录)'] !== undefined) { delete bad['(整条记录)']; rebuilt.push(`${key}:整条记录`) }
      const out = { ...row }
      for (const [field, value] of Object.entries(bad)) { out[field] = value; carried.push(`${key}.${field}`) }
      clean.objects[key] = out
      for (const field of doc.sanitized?.by_object?.[key] ?? []) {
        if (field !== '(整条记录)' && bad[field] === undefined) rebuilt.push(`${key}.${field}`)
      }
    }
    // 整条记录都读不懂、且本次没写它的：**原样留在文件里**（我们读不出来 ≠ 可以把它删掉）
    for (const [key, value] of unreadable) {
      if (value['(整条记录)'] !== undefined && clean.objects[key] === undefined) {
        clean.objects[key] = value['(整条记录)']
        carried.push(key)
      }
    }
    const payload = JSON.stringify(clean, null, 1) + '\n'
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmp = join(dir, `.${side}.${process.pid}.tmp`)
      writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, fileOf(side))
      return { ok: true, file: relative(resolve(root ?? '.'), fileOf(side)), mode: '0600',
        shape_carried: carried, shape_rebuilt: rebuilt,
        shape_note: (carried.length || rebuilt.length)
          ? `注意：这份协作文件里有读不懂的形状 —— `
            + `${carried.length ? `${carried.join(' / ')} **原样留在文件里**（没抹掉，面板上会继续如实说它读不出来）；` : ''}`
            + `${rebuilt.length ? `${rebuilt.join(' / ')} 按本次写入的新形状**重建**（旧的读不懂的内容没法保留）；` : ''}`
            + '把形状改对（面板上写了每个字段该长什么样）就不再提示'
          : '' }
    } catch (err) {
      return refusal('collab-write-failed', flat(err),
        `先修 ${relative(resolve(root ?? '.'), dir)} 目录权限（协作文件必须 0600；写不进去时界面如实报，不假装成功）`)
    }
  }

  /**
   * 这份文件"读得不完整"的**如实读数**（面板据此降级说明：哪几个字段读不出来、该长什么样、怎么修）。
   * 没有坏形状时返回 `null`（面板不显示这一行）。**它不是账本、也不写任何东西**。
   */
  const shapeOf = (doc, side) => {
    const broken = doc.broken ?? null
    const counts = doc.sanitized?.counts ?? {}
    const problems = doc.sanitized?.problems ?? []
    const total = Number(doc.sanitized?.dropped_total ?? 0)
    if (!broken && !total) return null
    const fields = doc.sanitized?.fields ?? {}
    const file = relative(resolve(String(root ?? '.')), fileOf(side))
    return { broken, counts, problems, dropped_total: total, fields,
      by_object: doc.sanitized?.by_object ?? {},
      file,
      how_to_fix: broken?.how_to_fix
        ?? (`把 ${file} 里这些字段改回声明的形状（` + Object.entries(fields)
          .map(([field, shape]) => `${field}=${shape}`).join('；') + '），'
          + '或者把读不出来的那部分删掉；协作面**每次渲染都真读盘、不缓存** ⇒ 改好下一次刷新就自动恢复'),
      next_action: broken?.next_action
        ?? `修 ${file} 里列出的 ${total} 处坏形状（面板上逐条给的是"哪个对象、哪个字段、为什么读不出来"）` }
  }
  /**
   * 写前的**形状门**：某个对象的某个字段"整块读不出来"时，往它里面追加会**下一次读盘就被跳过**
   * （等于悄悄丢一次）⇒ 直接**如实拒绝**并说清怎么修（面板上那一行就是修法）。
   */
  const shapeBlocker = (doc, side, kind, id, field) => {
    const bad = doc.sanitized?.by_object?.[keyOf(kind, id)] ?? []
    if (!bad.includes(field)) return null
    const file = relative(resolve(String(root ?? '.')), fileOf(side))
    const shape = doc.sanitized?.fields?.[field] ?? '（见面板上的说明）'
    return refusal('collab-shape-malformed',
      `这份对象的 \`${field}\` 形状不对（整块读不出来），往里写会**下一次读盘就被跳过**`,
      `先把 ${file} 里 \`${keyOf(kind, id)}\` 的 \`${field}\` 改成 ${shape}，或把这一项删掉；`
        + '改好这一次什么都没写、下一次刷新就自动恢复（协作面不缓存）')
  }


  /**
   * 会话里登录过的人（**只读**）：它现在**不再**决定"谁是同事"，只用来在名册那一行标注"今天登录过"。
   * 为什么改：旧口径下"同事 = 登录过的人"⇒ 名单取决于谁碰巧开过页面，单位里真实的人反而进不来。
   */
  const sessionPeople = (side) => {
    if (sessionsPath === '') return []
    try {
      const parsed = JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const rows = plain(parsed?.sessions) ? Object.values(parsed.sessions) : []
      const out = new Map()
      for (const row of rows) {
        if (String(row?.side ?? '') !== side) continue
        const name = String(row?.name ?? '')
        if (!NAME_RE.test(name)) continue
        out.set(name, { name, human: `human:${name}`, source: 'session',
          expires_at: Number(row?.expires_at ?? 0) || null })
      }
      return [...out.values()]
    } catch (err) { return [] }        // 读不到会话文件 ⇒ 一律标"未登录"（如实降级，不猜人）
  }
  /**
   * 本侧同事 = **名册**（`people.mjs`）里这一侧的成员 —— 带角色、职务、直属上级与"今天登录过没有"。
   * 降级（名册机制没装配时，例如单文件单测）：退回旧口径并在每条上标 `source: 'session-fallback'`，
   * 让界面/接口能如实说明"名单来源不是名册"（不假装）。
   */
  const colleagues = (side) => {
    if (roster && typeof roster.members === 'function') {
      return roster.members(side).map((member) => ({ name: member.name, human: member.human,
        role: member.role, role_label: member.role_label, title: member.title,
        reports_to: member.reports_to, logged_in: member.logged_in, source: 'roster' }))
    }
    const doc = load(side)
    const out = new Map()
    for (const person of sessionPeople(side)) out.set(person.name, { ...person, source: 'session-fallback' })
    for (const [human, row] of Object.entries(doc.people)) {
      const name = String(row?.name ?? human.replace(/^human:/, ''))
      if (!NAME_RE.test(name)) continue
      if (out.has(name)) { out.get(name).source = 'session-fallback'; continue }
      out.set(name, { name, human: `human:${name}`, source: 'session-fallback',
        first_at: row?.first_at ?? null, last_at: row?.last_at ?? null })
    }
    return [...out.values()].sort((left, right) => (left.name < right.name ? -1 : 1))
  }
  const isColleague = (side, human) => colleagues(side).some((person) => person.human === human)
  /** 「同事名单」的**来源自述**（接口/面板据此如实说明"名单来自名册"还是"降级自登录记录"）。 */
  const rosterSource = () => (roster && typeof roster.describe === 'function'
    ? { source: 'roster', file: roster.describe().file, mode: roster.describe().mode,
      note: '同事名单来自**人员名册**（`people.mjs`，0600 配置）：名字不在名册里会被如实拒（unknown-colleague）' }
    : { source: 'session-fallback', file: '', mode: '',
      note: '**降级**：名册机制没有装配，同事名单暂时来自"登录过的人"（外壳装配问题：看日志里 [people]）' })

  // ------------------------------------------------------------------ 校验（一切拒绝都有名 + 下一步）
  const guard = (side, actor) => {
    if (!allowedSides.includes(text(side))) {
      return refusal('unknown-side', `不是本服务的合法侧：${JSON.stringify(side)}`,
        `用 ${allowedSides.join(' / ') || '（未配置任何侧）'} 之一（侧由**会话身份**决定，不由请求体决定）`)
    }
    const who = text(actor)
    if (!who.startsWith('human:') || !NAME_RE.test(who.slice(6))) {
      return refusal('identity-required', `协作是**同侧人类之间**的事，actor 必须是 human:<名字>（收到 ${JSON.stringify(actor)}）`,
        '先在身份页登录（human:<名字> + 属于哪一侧），再指派/评论；agent 不参与协作（它不该替人排队）')
    }
    return null
  }
  const guardObject = (kind, id) => {
    if (!KIND_RE.test(text(kind))) {
      return refusal('kind-malformed', `对象类形状不合法：${JSON.stringify(kind)}`,
        '对象类写小写字母/数字/连字符（它来自对象地址 /app/<view>/<kind>/<id>/）')
    }
    if (!ID_RE.test(text(id))) {
      return refusal('id-malformed', `对象 id 形状不合法：${JSON.stringify(id)}`,
        '对象 id 来自对象地址；换一条列表里真实的 id 再试')
    }
    return null
  }
  const humanOf = (value) => {
    const raw = text(value)
    if (raw === '') return ''
    const name = raw.startsWith('human:') ? raw.slice(6) : raw
    return NAME_RE.test(name) ? `human:${name}` : ''
  }

  /** 取（必要时新建）某个对象的协作记录；对象数超上限 ⇒ 淘汰最久没动过的那个（如实报数）。 */
  const ensureObject = (doc, kind, id, title, at) => {
    const key = keyOf(kind, id)
    let obj = doc.objects[key]
    if (!obj || !plain(obj)) {
      obj = { kind, id, title: text(title), assignment: null, watchers: [], comments: [], events: [],
        reads: {}, dropped_comments: 0, evicted: doc.evicted ?? 0, created_at: at, touched_at: at }
      doc.objects[key] = obj
    }
    if (text(title) !== '') obj.title = text(title)
    obj.touched_at = at
    const keys = Object.keys(doc.objects)
    if (keys.length > MAX_OBJECTS) {
      const oldest = keys.filter((item) => item !== key)
        .sort((left, right) => String(doc.objects[left]?.touched_at ?? '')
          .localeCompare(String(doc.objects[right]?.touched_at ?? '')))[0]
      if (oldest) { delete doc.objects[oldest]; doc.evicted = (doc.evicted ?? 0) + 1 }
    }
    return obj
  }
  const pushEvent = (obj, event) => {
    obj.events.unshift({ eid: `e-${obj.events.length + 1}-${String(event.at ?? '').replace(/\D/g, '').slice(-6)}`,
      ...event })
    if (obj.events.length > MAX_EVENTS) obj.events.length = MAX_EVENTS
  }
  const touchPerson = (doc, human, at) => {
    const name = human.replace(/^human:/, '')
    const known = plain(doc.people[human]) ? doc.people[human] : null
    doc.people[human] = { name, first_at: known?.first_at ?? at, last_at: at }
  }
  const labelOf = (obj) => (text(obj?.title) !== '' ? text(obj.title) : `${obj?.kind ?? ''} ${obj?.id ?? ''}`)

  // ------------------------------------------------------------------ 读侧
  const readAtOf = (obj, actor) => text(obj?.reads?.[actor])
  /** 某对象上"给我的"未读活动（别人做的、且晚于我上次标已读）。 */
  const unreadOf = (obj, actor) => (Array.isArray(obj?.events) ? obj.events : [])
    .filter((event) => text(event.by) !== actor
      && (!readAtOf(obj, actor) || laterThan(event.at, readAtOf(obj, actor))))

  /**
   * 对象级协作视图（对象页的两块面板 + `/api/collab/object` 都用它）。
   * `side` 由外壳按**会话身份**给 ⇒ 对方侧的对象在这里查不到本侧的协作记录（0 命中）。
   */
  const view = ({ side, actor = '', kind, id }) => {
    const bad = guard(side, actor) ?? guardObject(kind, id)
    const me = text(actor)
    if (bad) {
      // 未登录也允许**查看**对象页的协作面板：给"去登录"而不是报错（同侧人类之间，没登录就没有名单）
      return { ok: false, code: bad.code, reason: bad.reason, next_action: bad.next_action,
        side: text(side), kind: text(kind), id: text(id), found: false, assignment: null, watchers: [],
        comments: [], events: [], unread: 0, unread_comments: 0, read_at: '', colleagues: [], mine: false,
        watching: false, counts: { comments: 0, events: 0, watchers: 0, dropped_comments: 0 } }
    }
    const doc = load(side)
    const obj = doc.objects[keyOf(kind, id)] ?? null
    const comments = (Array.isArray(obj?.comments) ? obj.comments : []).map((item) => ({
      ...item, mine: text(item.by) === me, mentions_me: (item.mentions ?? []).includes(me) }))
    const unread = unreadOf(obj, me)
    return {
      ok: true, found: Boolean(obj), side: text(side), kind: text(kind), id: text(id),
      title: obj ? labelOf(obj) : '', assignment: obj?.assignment ?? null,
      watchers: (obj?.watchers ?? []).map((human) => ({ human, name: nameOf(human),
        me: human === me })),
      comments, events: (obj?.events ?? []).slice(0, 50),
      read_at: readAtOf(obj, me), unread: unread.length,
      unread_comments: unread.filter((event) => event.type === 'commented').length,
      mine: text(obj?.assignment?.to) === me, watching: (obj?.watchers ?? []).includes(me),
      colleagues: colleagues(side), me, colleague_source: rosterSource(),
      counts: { comments: comments.length, events: (obj?.events ?? []).length,
        watchers: (obj?.watchers ?? []).length, dropped_comments: obj?.dropped_comments ?? 0 },
      // **读得不完整就如实说**（`broken` = 整份文件读不出来；`problems` = 哪几个字段读不出来 + 该长什么样）
      shape: shapeOf(doc, side),
      storage: { file: relative(resolve(String(root ?? '.')), fileOf(side)), mode: '0600',
        why_not_ledger: COLLAB_WHY_NOT_LEDGER },
    }
  }

  // ------------------------------------------------------------------ 写侧（指派 / 关注 / 评论 / 已读）
  const assign = ({ side, actor, kind, id, to, reason = '', due = '', title = '', at = '' }) => {
    const me = text(actor)
    const bad = guard(side, me) ?? guardObject(kind, id)
    if (bad) return bad
    const target = humanOf(to)
    if (target === '') {
      return refusal('colleague-malformed', `同事名字形状不合法：${JSON.stringify(to)}`,
        '写 `human:<名字>` 或直接写名字（小写字母开头、≤32 位；名字要能被对方登录时对上）')
    }
    if (!isColleague(side, target)) {
      const list = colleagues(side).map((person) => `@${person.name}`
        + (person.role_label ? `（${person.role_label}）` : '')).join(' ')
      return refusal('unknown-colleague', `@${nameOf(target)} 不在本侧（${side}）**名册**里`,
        `协作只在**同侧在册成员**之间：本侧名册 ${list || '（还是空的）'}；`
        + '先把人加进名册（对方登录一次会自动登记为「待指派」），跨侧不能指派（跨侧只走 QEP 报文）',
        { roster: colleagues(side).map((person) => person.human) })
    }
    const why = text(reason)
    if (why === '') {
      return refusal('reason-required', '指派必须写原因（接手的人靠它判断优先级，不是为了留痕）',
        '在「原因」里写一句人话：为什么要交给对方、什么时候要')
    }
    if (why.length > MAX_REASON) {
      return refusal('reason-too-long', `原因 ${why.length} 字超过上限 ${MAX_REASON}`,
        `压到 ${MAX_REASON} 字以内（长的说明放评论里）`)
    }
    const deadline = text(due)
    if (deadline !== '' && !ISO_RE.test(deadline)) {
      return refusal('due-invalid', `截止不是合法 ISO8601：${JSON.stringify(due)}`,
        '写 `2026-10-01` 或 `2026-10-01T18:00:00Z`')
    }
    const doc = load(side)
    const obj = ensureObject(doc, kind, id, title, at)
    const before = obj.assignment
    // ---- **按角色限动作**（不是限视图）：转交**别人的活**要有资格 ------------------------------------
    // 口径：没有人时 = 指派（谁都能把一件没人认领的事交出去）；**已经有人时 = 转交**，只有
    //   · 归我（当前指派给我）、或 · 我指派的（当前指派是我下的）才能转交；
    //   · 否则只有名册里 `policy.transfer.override_roles` 的角色（默认 supervisor/admin）可以转交，
    //     且必须写明理由（`reason` 本来就必填）—— 越权一律拒（`transfer-not-yours`），账本与协作文件零新增。
    const transfer = before ? roster && typeof roster.transferOverride === 'function'
      ? roster.transferOverride(side, me)
      : { ok: true, role: 'roster-missing', role_label: '（名册未装配）' } : null
    if (before && before.to !== me && before.by !== me && !(transfer && transfer.ok)) {
      return refusal('transfer-not-yours',
        `「${labelOf(obj)}」现在归 @${nameOf(before.to)}（由 @${nameOf(before.by)} 指派）：你既不是接手的人，也不是指派的人`
          + `（你当前的角色是 ${transfer?.role_label ?? '未知'}）`,
        '只有**归我**（当前指派给我）或**我指派的**才能转交；要转交别人的活，'
          + `让有资格的角色来做（名册策略 \`transfer.override_roles\`，默认 supervisor / admin），`
          + '或者先在评论里跟对方说清楚（评论谁都能发）',
        { assigned_to: before.to, assigned_by: before.by, role: transfer?.role ?? null })
    }
    const history = (
      Array.isArray(before?.history) ? before.history : []).slice(-19)
    if (before) {
      history.push({ type: before.to === target ? 'reassigned-in-place' : 'handed-over', by: before.by,
        to: before.to, reason: before.reason, due: before.due, at: before.at })
    }
    obj.assignment = { to: target, by: me, reason: why, due: deadline, at, status: 'open', history }
    pushEvent(obj, { at, by: me, type: before ? 'reassigned' : 'assigned', to: target, reason: why, due: deadline,
      summary: `${me} 把「${labelOf(obj)}」${before ? '转交' : '指派'}给 ${target}`
        + `（原因：${flat(why, 80)}${deadline ? `；截止 ${deadline}` : ''}）` })
    touchPerson(doc, me, at); touchPerson(doc, target, at)
    const saved = save(side, doc)
    if (!saved.ok) return saved
    return { ok: true, code: before ? 'reassigned' : 'assigned', target, reason: why, due: deadline,
      file: saved.file, mode: saved.mode, history_depth: history.length,
      transfer: transfer ? { role: transfer.role, role_label: transfer.role_label,
        source: before ? ((before.to === me || before.by === me) ? 'mine' : 'role-override') : 'first' } : null,
      shape: shapeOf(doc, side), shape_note: saved.shape_note || null,
      next_action: `@${nameOf(target)} 打开工作台/通知中心的「我的」就能看到这一条（同侧可见；对方侧看不到）`
        + `${saved.shape_note ? `｜${saved.shape_note}` : ''}` }
  }

  /** 关注 / 取消关注（**每人一份**：我关注不影响别人，别人关注也不影响我）。 */
  const toggleWatch = ({ side, actor, kind, id, title = '', at = '', want = null }) => {
    const me = text(actor)
    const bad = guard(side, me) ?? guardObject(kind, id)
    if (bad) return bad
    const doc = load(side)
    const blocker = shapeBlocker(doc, side, kind, id, 'watchers')
    if (blocker) return blocker
    const obj = ensureObject(doc, kind, id, title, at)
    const has = obj.watchers.includes(me)
    const next = want === null || want === undefined ? !has : want === true
    if (next && !has) {
      if (obj.watchers.length >= MAX_WATCHERS) {
        obj.watchers = obj.watchers.slice(-(MAX_WATCHERS - 1))
      }
      obj.watchers.push(me)
    } else if (!next && has) {
      obj.watchers = obj.watchers.filter((human) => human !== me)
    }
    pushEvent(obj, { at, by: me, type: next ? 'watched' : 'unwatched',
      summary: next ? `${me} 开始关注「${labelOf(obj)}」` : `${me} 取消关注「${labelOf(obj)}」` })
    touchPerson(doc, me, at)
    const saved = save(side, doc)
    if (!saved.ok) return saved
    return { ok: true, code: next ? 'watching' : 'unwatched', watching: next,
      watchers: obj.watchers.map((human) => ({ human, name: nameOf(human), me: human === me })),
      file: saved.file, mode: saved.mode, shape: shapeOf(doc, side), shape_note: saved.shape_note || null,
      next_action: next
        ? '这个对象有新活动时会进你通知中心的「我的」（只影响你自己，不影响别人）'
        : '已取消关注：之后这个对象的活动不再进你的通知' }
  }

  /** 评论 + `@同事`：正文里的 `@<名字>` 必须是**本侧**同事；跨侧名字一律拒（不静默丢掉）。 */
  const comment = ({ side, actor, kind, id, body, title = '', at = '' }) => {
    const me = text(actor)
    const bad = guard(side, me) ?? guardObject(kind, id)
    if (bad) return bad
    const said = String(body ?? '').trim()
    if (said === '') {
      return refusal('body-required', '评论正文是空的', '写一句人话再发（空评论不留痕，也不通知任何人）')
    }
    if (said.length > MAX_TEXT) {
      return refusal('body-too-long', `评论 ${said.length} 字超过上限 ${MAX_TEXT}`,
        `压到 ${MAX_TEXT} 字以内，或把长文放到附件/工单里`)
    }
    const found = [...said.matchAll(MENTION_RE)].map((item) => item[2])
    const mentions = []
    const unresolved = []
    const crossSide = []
    // `@同事` 的解析**与同事名单同一处判据**：名册（本侧在册成员）命中 ⇒ 通知他；跨侧 ⇒ 拒；
    // 名册里没有、也没在任何一侧 ⇒ 进 `unresolved`（**不假装通知到了**）。
    const rosterNames = new Set(colleagues(side).map((person) => person.name))
    const otherSides = allowedSides.filter((item) => item !== side)
    const otherNames = new Set(otherSides.flatMap((item) => colleagues(item).map((person) => person.name)))
    for (const name of [...new Set(found)]) {
      const human = `human:${name}`
      if (rosterNames.has(name)) { mentions.push(human); continue }
      if (otherNames.has(name)) { crossSide.push(human); continue }
      unresolved.push(human)
    }
    if (crossSide.length) {
      return refusal('cross-side-mentioned',
        `${pretty(crossSide.join(' / '))} 属于**另一侧**，不能出现在本侧内部评论里`,
        '本侧评论只在本侧人类之间可见：要跟对方沟通走业务动作（答疑/广播/报价/变更），不走这里')
    }
    const doc = load(side)
    const blocker = shapeBlocker(doc, side, kind, id, 'comments')
    if (blocker) return blocker
    const obj = ensureObject(doc, kind, id, title, at)
    const row = { cid: `c-${obj.comments.length + 1}-${String(at).replace(/\D/g, '').slice(-6)}`, by: me, at,
      body: said, mentions, unresolved, bytes: Buffer.byteLength(said, 'utf8') }
    obj.comments.push(row)
    if (obj.comments.length > MAX_COMMENTS) {
      obj.dropped_comments += obj.comments.length - MAX_COMMENTS
      obj.comments = obj.comments.slice(-MAX_COMMENTS)
    }
    pushEvent(obj, { at, by: me, type: 'commented', cid: row.cid, mentions,
      summary: `${me} 在「${labelOf(obj)}」上评论${mentions.length ? `并 @ 了 ${mentions.join(' ')}` : ''}：${flat(said, 80)}` })
    obj.reads[me] = at                    // 自己发的当然算自己已读
    touchPerson(doc, me, at)
    for (const human of mentions) touchPerson(doc, human, at)
    const saved = save(side, doc)
    if (!saved.ok) return saved
    return { ok: true, code: 'commented', cid: row.cid, mentions, unresolved, file: saved.file, mode: saved.mode,
      shape: shapeOf(doc, side), shape_note: saved.shape_note || null,
      next_action: mentions.length
        ? `${pretty(mentions.join(' '))} 的通知中心会多一条「@我」（同侧可见；它不落账本、不影响合同事实）`
        : (unresolved.length
          ? `提醒：${pretty(unresolved.join(' '))} 不在本侧名单里，**没有**通知到任何人`
          : '同侧的人随时能在对象页看到这条评论') }
  }

  /** 标为已读（**每人一份**：我标已读不影响别人的未读与关注）。 */
  const markRead = ({ side, actor, kind, id, at = '', all = false }) => {
    const me = text(actor)
    const bad = guard(side, me)
    if (bad) return bad
    const doc = load(side)
    if (all) {
      let marked = 0
      for (const obj of Object.values(doc.objects)) {
        if (!plain(obj)) continue
        obj.reads = plain(obj.reads) ? obj.reads : {}
        obj.reads[me] = at
        marked += 1
      }
      const saved = save(side, doc)
      if (!saved.ok) return saved
      return { ok: true, code: 'read-all', objects: marked, file: saved.file,
        shape: shapeOf(doc, side), shape_note: saved.shape_note || null,
        next_action: `已把本侧 ${marked} 个对象的协作活动都标成你读过了（只影响你自己）` }
    }
    const badObject = guardObject(kind, id)
    if (badObject) return badObject
    const obj = ensureObject(doc, kind, id, '', at)
    const unreadBefore = unreadOf(obj, me).length
    obj.reads = plain(obj.reads) ? obj.reads : {}
    obj.reads[me] = at
    touchPerson(doc, me, at)
    const saved = save(side, doc)
    if (!saved.ok) return saved
    return { ok: true, code: 'read', unread_before: unreadBefore, file: saved.file,
      shape: shapeOf(doc, side), shape_note: saved.shape_note || null,
      next_action: '已读是你自己的标记（同侧别人不受影响，也不进账本）' }
  }

  // ================================================================ 「我的今日」：**跨对象活动流**
  /**
   * 把「我关注的对象 + 我参的流程」上的事件聚成一条时间线（本批新增的能力）。
   *
   * 两条来源（都不进账本）：
   *   ① **协作事件**（本文件的 `objects[].events`：指派/转交/关注/评论）—— 同侧、按会话身份；
   *   ② **本侧账本的事实行**（`ledgerRows`，由外壳的 `host.rows(view)` **只读**给进来）——
   *      本文件**自己不读账本、不 import 任何账本 API**（纪律见文件头），只做聚合与显示。
   *
   * 「我参的」判据（两条都算，**不猜**）：我关注 / 指派给我 / 我指派的 / 我评论或 @ 过 / 我留下过事件；
   * 或者这一条账本行的 `actor` 就是我。其余算「本侧」（同侧可见，但不冒充"我的"）。
   *
   * **对象类来自插件声明**（`kinds`：`[{kind, id_keys}]`，由外壳按注册面给），本文件不写任何对象类字面量：
   * 账本行里的对象 id 按它自己声明的键（如 `<对象类>_id`）+ `correlation_id`/`ref` 命中已见过的 id 取值。
   * 解析不出对象行 ⇒ 这一条**如实说"没解析出对象"**（不给假深链），仍留在时间线里。
   *
   * 已读：与协作面**同一份**每对象水位（`reads[me]`）—— `at` 晚于水位的算未读（标已读只影响我自己）。
   */
  const FEED_WINDOWS = [{ key: 'today', label: '今天' }, { key: 'week', label: '近 7 天' },
    { key: 'older', label: '更早' }]
  const FEED_COLLAB_WORDS = { assigned: '指派', reassigned: '转交', watched: '开始关注',
    unwatched: '取消关注', commented: '评论', read: '标为已读' }
  const DAY_MS = 24 * 60 * 60 * 1000

  /** 这一条属于哪一档时间（`now` 由调用方给：协作不是事实，不取墙钟 —— 与 `at` 同源）。 */
  const feedWindowOf = (iso, nowMs) => {
    const at = Date.parse(text(iso))
    if (!Number.isFinite(at)) return 'older'
    const start = new Date(nowMs)
    start.setHours(0, 0, 0, 0)
    if (at >= start.getTime()) return 'today'
    return at >= nowMs - 7 * DAY_MS ? 'week' : 'older'
  }
  /** 账本行的 `body`（坏形状 ⇒ 空对象：不编）。 */
  const rowBody = (row) => (plain(row?.body) ? row.body : {})
  /** 按**声明的**对象类收集 id（`id_keys` 由外壳给；本文件不认识任何对象类）。 */
  const feedObjectIndex = (rows, kinds) => {
    const byId = new Map()
    for (const row of rows) {
      const body = rowBody(row)
      for (const spec of kinds) {
        for (const key of (spec.id_keys ?? [])) {
          const value = text(body[key]) || text(row[key])
          if (value === '') continue
          const set = byId.get(value) ?? new Set()
          set.add(spec.kind)
          byId.set(value, set)
        }
      }
    }
    return byId
  }
  /** 这一行讲的是哪个对象：先按 id 键，再用 `correlation_id` / `ref` 命中已见过的 id（都不中就**不给**）。 */
  const feedObjectOfRow = (row, kinds, byId) => {
    const body = rowBody(row)
    for (const spec of kinds) {
      for (const key of (spec.id_keys ?? [])) {
        const value = text(body[key]) || text(row[key])
        if (value !== '') return { kind: spec.kind, id: value }
      }
    }
    for (const candidate of [text(body.ref), text(row.correlation_id)]) {
      if (candidate === '') continue
      const hits = byId.get(candidate)
      if (hits && hits.size) return { kind: [...hits][0], id: candidate }
    }
    return null
  }
  /**
   * 人话的键值摘要（账本行的**原文**键值，最多 4 个短标量：不替它编一句话）。
   *
   * **截断必须说出来**（P28 空账本走查登记的显示缺陷）：修前这里是 `flat(String(value), 32)` 之后
   * 再用一个恒不成立的 `shown.length > 32` 跳过 —— 结果是取值超过 32 字就被**静默截断**，界面上看到
   * 的是一句话**中途断掉、没有省略号**（用户既不知道少了字，也不知道少在哪）。
   * 现在：超过上限 ⇒ 截到上限并**带 `…`**，同时把"截了几处"一并交出去（调用方写进正文，不静默丢）。
   */
  const DETAIL_VALUE_MAX = 32
  const feedRowDetail = (row) => {
    const body = rowBody(row)
    const parts = []
    let truncated = 0
    for (const [key, value] of Object.entries(body)) {
      if (parts.length >= 4) break
      if (value === null || value === undefined) continue
      if (typeof value === 'object') continue
      const raw = flat(String(value), DETAIL_VALUE_MAX + 1)
      if (raw === '') continue
      const clipped = raw.length > DETAIL_VALUE_MAX
      if (clipped) truncated += 1
      parts.push(`${key}=${clipped ? `${raw.slice(0, DETAIL_VALUE_MAX)}…` : raw}`)
    }
    return { text: parts.join(' · '), truncated }
  }

  /**
   * 跨对象活动流（「我的今日」）。`window` 非空 ⇒ 只回那一档时间（`home` 面板用 `today`）。
   * 返回 `{ok, items, counts, buckets, windows, storage, ...}` —— 每一条都能跳对象页 / 标已读。
   */
  const feed = ({ side, actor = '', ledgerRows = [], kinds = [], now = '', window = '', limit = FEED_MAX } = {}) => {
    const bad = guard(side, actor)
    if (bad) {
      return { ok: false, code: bad.code, reason: bad.reason, next_action: bad.next_action,
        items: [], buckets: [], counts: { total: 0, mine: 0, side: 0, unread: 0, facts: 0, collab: 0 } }
    }
    const me = text(actor)
    const nowText = text(now)
    const nowMs = Number.isFinite(Date.parse(nowText)) ? Date.parse(nowText) : Date.now()
    const doc = load(side)
    const specs = (Array.isArray(kinds) ? kinds : []).filter((spec) => spec && text(spec.kind) !== '')
    const rows = (Array.isArray(ledgerRows) ? ledgerRows : []).slice(0, MAX_LEDGER_ROWS)
    const byId = feedObjectIndex(rows, specs)

    // ---- ① 协作侧：哪些对象与我有关 + 我的每对象已读水位 --------------------------------
    const myKeys = new Set()
    const involved = new Map()          // key → {obj, label, unread, watchers, assignment}
    for (const obj of Object.values(doc.objects)) {
      if (!plain(obj)) continue
      const key = keyOf(text(obj.kind), text(obj.id))
      const assignment = plain(obj.assignment) ? obj.assignment : null
      const events = Array.isArray(obj.events) ? obj.events : []
      const comments = Array.isArray(obj.comments) ? obj.comments : []
      const mine = (Array.isArray(obj.watchers) && obj.watchers.includes(me))
        || (assignment && (text(assignment.to) === me || text(assignment.by) === me))
        || events.some((event) => text(event.by) === me)
        || comments.some((comment) => text(comment.by) === me
          || (comment.mentions ?? []).includes(me))
      if (mine) myKeys.add(key)
      involved.set(key, { obj, label: labelOf(obj), mine, reads: readAtOf(obj, me) })
    }
    // ---- ② 事实侧：行里的 actor 就是我 ⇒ 这一条当然算「我参的」（它也会把对象带进 myKeys） ----
    const rowObjects = rows.map((row) => feedObjectOfRow(row, specs, byId))
    rows.forEach((row, at) => {
      if (text(row?.actor) !== me) return
      const object = rowObjects[at]
      if (object) myKeys.add(keyOf(object.kind, object.id))
    })

    const items = []
    for (const [key, info] of involved.entries()) {
      const watermark = info.reads
      for (const event of (Array.isArray(info.obj.events) ? info.obj.events : [])) {
        const at = text(event.at)
        const kind = text(event.type)
        const by = text(event.by)
        if (at === '' || kind === '') continue
        // 未读 = 晚于我这一条上的已读水位（**按时刻比**：秒精度的事实与毫秒精度的水位混着写）
        const unread = watermark === '' || laterThan(at, watermark)
        items.push({ id: `feed-collab-${side}-${key}-${text(event.eid) || at}`,
          source: 'collab', feed_kind: 'collab', feed_kind_label: '协作',
          type: kind, type_label: FEED_COLLAB_WORDS[kind] ?? kind,
          at, at_day: at.slice(0, 10), at_label: atLabel(at),
          object_key: key, object: { kind: text(info.obj.kind), id: text(info.obj.id) },
          object_label: info.label, object_unresolved: false,
          who: by, who_label: by === '' ? '' : `@${nameOf(by)}`,
          summary: pretty(flat(event.summary, 240)),
          body: pretty(flat(event.summary, 240)),
          next_action: '', unread, mine: info.mine, watermark,
          ref: { kind: text(info.obj.kind), id: text(info.obj.id), view: side, title: info.label },
          action: unread ? 'collab.read' : '', label: '标为已读', dedupe_key: '' })
      }
    }
    rows.forEach((row, at) => {
      const object = rowObjects[at]
      const key = object ? keyOf(object.kind, object.id) : ''
      const who = text(row?.actor)
      const label = key !== '' && involved.has(key) ? involved.get(key).label : (object
        ? `${object.kind} ${object.id}` : '（未解析出对象）')
      const mine = who === me || (key !== '' && myKeys.has(key))
      const watermark = key !== '' && involved.has(key) ? involved.get(key).reads : ''
      const when = text(row?.ts)
      const type = text(row?.type)
      if (when === '' || type === '') return
      const unread = watermark !== '' && laterThan(when, watermark)
      const detail = feedRowDetail(row)
      items.push({ id: `feed-fact-${side}-${text(row?.seq) || at}`,
        source: 'ledger', feed_kind: 'fact', feed_kind_label: '事实',
        type, type_label: type, at: when, at_day: when.slice(0, 10), at_label: atLabel(when),
        seq: Number(row?.seq) || null,
        object_key: key, object: object ?? null, object_label: label,
        object_unresolved: object === null,
        who, who_label: who === '' ? '' : pretty(who),
        summary: `${type}${object ? `（${label}）` : ''}`,
        // **截断的说法**：取值超过上限的写 `…`，并在这一条里如实报出截了几处（不静默截断）
        body: [detail.text, detail.truncated ? `（${detail.truncated} 处取值过长，已截到 ${DETAIL_VALUE_MAX} 字并标 …）` : '',
          text(row?.class) === 'fact' ? '账本事实' : ''].filter(Boolean).join(' · '),
        next_action: object ? '' : '这一行里没有本侧声明的对象类能认出的 id：只有本侧账本行号，没有深链',
        unread, mine, watermark, ledger_seq: Number(row?.seq) || null,
        ref: object ? { kind: object.kind, id: object.id, view: side, title: label } : null,
        action: unread && object ? 'collab.read' : '', label: '标为已读', dedupe_key: '' })
    })

    // ---- ③ 排序（时间倒序；同一时刻按账本行号/来源稳定） + 时间档 + 计数 -------------------
    // 排序也**按时刻**（账本行秒精度 / 协作事件毫秒精度混在一起；比字符串会在同一秒里排错）
    const timeMs = (value) => {
      const ms = Date.parse(text(value))
      return Number.isFinite(ms) ? ms : 0
    }
    const sorted = items.slice().sort((left, right) => (timeMs(left.at) === timeMs(right.at)
      ? ((right.ledger_seq ?? 0) - (left.ledger_seq ?? 0)) || (left.id < right.id ? -1 : 1)
      : (timeMs(left.at) < timeMs(right.at) ? 1 : -1)))
    const stamped = sorted.map((item) => ({ ...item, window: feedWindowOf(item.at, nowMs),
      window_label: (FEED_WINDOWS.find((entry) => entry.key === feedWindowOf(item.at, nowMs)) ?? {}).label ?? '' }))
    const buckets = FEED_WINDOWS.map((entry) => ({ key: entry.key, label: entry.label,
      count: stamped.filter((item) => item.window === entry.key).length }))
    const picked = window === '' ? stamped : stamped.filter((item) => item.window === text(window))
    const shown = picked.slice(0, Math.max(1, Number(limit) || FEED_MAX))
    const countOf = (list, test) => list.filter(test).length
    return { ok: true, side, me, items: shown, buckets, windows: FEED_WINDOWS,
      counts: { total: shown.length, all: stamped.length, mine: countOf(shown, (item) => item.mine),
        side: countOf(shown, (item) => !item.mine), facts: countOf(shown, (item) => item.feed_kind === 'fact'),
        collab: countOf(shown, (item) => item.feed_kind === 'collab'),
        today: countOf(shown, (item) => item.window === 'today'),
        unread: countOf(shown, (item) => item.unread === true),
        unread_mine: countOf(shown, (item) => item.unread === true && item.mine),
        objects: new Set(shown.map((item) => item.object_key).filter((key) => key !== '')).size,
        unresolved: countOf(shown, (item) => item.object_unresolved === true),
        dropped: Math.max(0, stamped.length - shown.length) },
      filter: window, objects_kinds: specs.map((spec) => spec.kind),
      my_objects: [...myKeys].sort(),
      shape: shapeOf(doc, side),
      storage: { file: relative(resolve(String(root ?? '.')), fileOf(side)), mode: '0600',
        why_not_ledger: COLLAB_WHY_NOT_LEDGER },
      ledger_read: `事实来自**本侧**账本（${rows.length} 行，由外壳只读给进来）：另一侧的账本不在这里，`
        + '所以这条时间线上永远看不到对面私域' }
  }

  /**
   * 「我的今日」的**已读**：把我参的那些对象上的活动标成我读过了（与 `markRead` 同一份水位）。
   * `keys` 由界面/脚本从 `feed()` 的条目里取（`object_key`）；只认本侧自己的水位，别人不受影响。
   */
  const markFeedRead = ({ side, actor, at = '', keys = [] } = {}) => {
    const bad = guard(side, actor)
    if (bad) return bad
    const me = text(actor)
    const doc = load(side)
    const wanted = [...new Set((Array.isArray(keys) ? keys : []).map((key) => text(key))
      .filter((key) => /^[a-z][a-z0-9-]{0,31}\/[^\u0000-\u001f<>{}\"'/]{1,96}$/.test(key)))]
    if (wanted.length === 0) {
      return refusal('object-required', '没有给要标已读的对象（keys 空或在形状上不合法）',
        '从活动流每条的 `object_key` 取值：形如 `<对象类>/<对象 id>`')
    }
    let marked = 0
    let unreadBefore = 0
    for (const key of wanted) {
      const sep = key.indexOf('/')
      const kind = key.slice(0, sep)
      const id = key.slice(sep + 1)
      const obj = ensureObject(doc, kind, id, '', at)
      unreadBefore += unreadOf(obj, me).length
      obj.reads = plain(obj.reads) ? obj.reads : {}
      obj.reads[me] = at
      marked += 1
    }
    touchPerson(doc, me, at)
    const saved = save(side, doc)
    if (!saved.ok) return saved
    return { ok: true, code: 'feed-read', objects: marked, keys: wanted, unread_before: unreadBefore,
      file: saved.file, mode: saved.mode, shape: shapeOf(doc, side), shape_note: saved.shape_note || null,
      next_action: `已把「我的今日」里这 ${marked} 个对象的活动标成你读过了（只影响你自己；`
        + '每条事实本身一字未改，账本零新增）' }
  }

  /**
   * 「我的今日」导出成**文本**（发给同事 / 写周报）：纯函数，内容**逐条来自 `feed()` 的条目**
   * （谁的事实谁导出：这里不重读任何东西、不生成新事实），行尾带账本行号 ⇒ 可与账面逐行对。
   */
  const FEED_COLUMNS = ['no', 'at_label', 'feed_kind_label', 'type_label', 'object_label', 'who_label',
    'unread_label', 'ledger_seq', 'body']
  const feedText = ({ items = [], meta = {} } = {}) => {
    const lines = []
    lines.push('quotagent · 我的今日（跨对象活动流）')
    lines.push(`侧：${text(meta.side) || '（未登录）'} · 身份：${text(meta.me) || '（未登录）'}`
      + `${meta.generated_at ? ` · 生成时刻：${atLabel(meta.generated_at)}` : ''}`)
    lines.push(`范围：${text(meta.scope_label) || '我参的 + 本侧'} · 事件 ${items.length} 条`
      + `（事实 ${items.filter((item) => item.feed_kind === 'fact').length} / 协作 ${items.filter((item) => item.feed_kind === 'collab').length}）`
      + ` · 未读 ${items.filter((item) => item.unread === true).length}`
      + ` · 跨 ${new Set(items.map((item) => item.object_key).filter(Boolean)).size} 个对象`)
    if (meta.filters) lines.push(`筛选：${text(meta.filters)}`)
    lines.push(`来源：本侧账本事实（只读）+ 同侧协作活动（不进账本）`
      + `${meta.file ? `｜协作文件 ${text(meta.file)}（0600）` : ''}`)
    lines.push('─'.repeat(60))
    items.forEach((item, at) => {
      lines.push(`${at + 1}. ${item.at_label} · ${item.feed_kind_label} · ${item.type_label}`
        + ` · ${item.object_label} · ${item.who_label || '（无署名）'}`
        + `${item.unread ? ' · 未读' : ''}${item.ledger_seq ? ` · 账本 #${item.ledger_seq}` : ''}`)
      if (item.body) lines.push(`   ${item.body}`)
      if (item.ref) lines.push(`   打开：${prefixPath(meta.prefix, meta.side, item.ref.kind, item.ref.id)}`)
    })
    lines.push('─'.repeat(60))
    lines.push('说明：时间线是**读**（不写账本、不改任何事实）；「标为已读」只影响你自己的未读水位。')
    return lines.join('\n')
  }
  /** 对象页深链（拼路径，不认识对象类；`prefix` 由调用方给）。 */
  const prefixPath = (prefix, side, kind, id) => `${text(prefix) || ''}/app/${text(side)}/${kind}/${id}/`
  /** 导出件的**标准形状**（与外壳 `buildReport` 的 `result.export` 同一套字段：客户端直接落文件）。 */
  const feedExport = ({ items = [], meta = {} } = {}) => {
    const content = `${feedText({ items, meta })}\n`
    const day = (text(meta.generated_at) || '').slice(0, 10) || 'today'
    const rows = items.map((item, at) => ({ no: at + 1, at_label: item.at_label,
      feed_kind_label: item.feed_kind_label, type_label: item.type_label, object_label: item.object_label,
      who_label: item.who_label, unread_label: item.unread ? '未读' : '已读',
      ledger_seq: item.ledger_seq ?? '', body: item.body ?? '' }))
    return { ok: true, filename: `我的今日_${text(meta.side) || 'no-side'}_${day}.txt`, format: 'txt',
      content_type: 'text/plain; charset=utf-8', content, rows: rows.length, items: items.length,
      columns: FEED_COLUMNS.slice(), digest: `sha256:${sha256Hex(content)}`,
      source: '同侧协作活动（0600，不进账本）+ 本侧账本事实（只读，逐行带账本行号）',
      generated_at: text(meta.generated_at), ledger_added: 0 }
  }

  // ------------------------------------------------------------------ 工作台 / 通知：我的 · 我指派的 · 全部
  /** 桶（过滤维度）：`mine` = 我的（指派给我 / @我 / 我关注的）；`assigned` = 我指派的（别人在办）。 */
  const bucketLabels = [{ key: 'mine', label: '我的' }, { key: 'assigned', label: '我指派的' }]

  const hubItems = (side, me) => {
    const doc = load(side)
    const items = []
    for (const obj of Object.values(doc.objects)) {
      if (!plain(obj)) continue
      const ref = { kind: String(obj.kind), id: String(obj.id), view: side, title: labelOf(obj) }
      const assignment = plain(obj.assignment) ? obj.assignment : null
      const unread = unreadOf(obj, me)
      const watching = (obj.watchers ?? []).includes(me)
      const mentioned = unread.filter((event) => event.type === 'commented'
        && (event.mentions ?? []).includes(me))
      if (assignment && text(assignment.to) === me && assignment.status === 'open') {
        items.push({ id: `collab-mine-${obj.kind}-${obj.id}`, bucket: 'mine', bucket_label: '我的',
          level: 'warn', title: `指派给我：${labelOf(obj)}`,
          body: `@${nameOf(assignment.by)} 交给你办（原因：${pretty(assignment.reason)}`
            + `${assignment.due ? `；截止 ${pretty(assignment.due)}` : '；未写截止'}）`
            + `${unread.length ? `｜这条上还有 ${unread.length} 条未读活动` : ''}`,
          next_action: '打开对象页：办完可以「指派 / 转交」给下一个人，或「标为已读」',
          ref, action: 'collab.comment', label: '评论 / @同事', at: assignment.at,
          detail: { assigned_by: assignment.by, due: assignment.due, reason: assignment.reason } })
      }
      for (const event of mentioned.slice(0, 3)) {
        const who = text(event.by)
        items.push({ id: `collab-mention-${obj.kind}-${obj.id}-${event.eid}`, bucket: 'mine',
          bucket_label: '我的', level: 'warn', title: `@我：@${nameOf(who)} 在 ${labelOf(obj)} 上提到你`,
          body: pretty(flat(event.summary, 160)), next_action: '打开对象页回复（评论里写 @<名字> 会再通知到他）',
          ref, action: 'collab.comment', label: '回复', at: event.at })
      }
      if (watching && unread.length && !mentioned.length) {
        items.push({ id: `collab-watch-${obj.kind}-${obj.id}`, bucket: 'mine', bucket_label: '我的',
          level: 'info', title: `你关注的 ${labelOf(obj)} 有 ${unread.length} 条新活动`,
          body: unread[0] ? pretty(flat(unread[0].summary, 160)) : '', next_action: '打开对象页看活动流',
          ref, action: 'collab.read', label: '标为已读', at: unread[0]?.at ?? '' })
      }
      if (assignment && text(assignment.by) === me && text(assignment.to) !== me && assignment.status === 'open') {
        const theyRead = Boolean(obj.reads?.[assignment.to]
          && (!assignment.at || String(obj.reads[assignment.to]) >= String(assignment.at)))
        // 「我指派的」只在**对方真的说了什么**时提醒（评论/回复）：关注、标已读这类动作不该当"进展"来敲门
        const later = unread.filter((event) => text(event.by) === text(assignment.to)
          && event.type === 'commented')
        items.push({ id: `collab-assigned-${obj.kind}-${obj.id}`, bucket: 'assigned',
          bucket_label: '我指派的', level: later.length ? 'info' : 'ok',
          title: `我指派给 @${nameOf(assignment.to)}：${labelOf(obj)}`,
          body: `对方${theyRead ? '已读过' : '还没读'}｜截止 ${pretty(assignment.due) || '未写'}`
            + `${later.length ? `｜对方留了 ${later.length} 条评论：${pretty(flat(later[0].summary, 100))}` : ''}`,
          next_action: theyRead ? '对方看过了：可以在对象页评论里催一句或追加说明'
            : '对方还没读：同侧可以在这里再 @ 他一次（评论里写 @<名字>）',
          ref, action: 'collab.comment', label: '评论 / 催一句', at: later[0]?.at ?? assignment.at,
          detail: { assigned_to: assignment.to, read: theyRead, due: assignment.due } })
      }
    }
    return items.sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
  }

  /** 工作台数据（`bucket` 为空 ⇒ 全部）：计数按桶给，界面出「我的 / 我指派的 / 全部」筛选片。 */
  const hub = ({ side, actor = '', bucket = '' }) => {
    const bad = guard(side, actor)
    if (bad) {
      return { ok: false, code: bad.code, reason: bad.reason, next_action: bad.next_action,
        items: [], buckets: [], counts: { mine: 0, assigned: 0, total: 0, unread: 0 } }
    }
    const me = text(actor)
    const all = hubItems(side, me)
    const buckets = bucketLabels.map((item) => ({ ...item,
      count: all.filter((row) => row.bucket === item.key).length }))
    const picked = text(bucket) === '' ? all : all.filter((item) => item.bucket === text(bucket))
    const doc = load(side)
    const unread = Object.values(doc.objects)
      .reduce((sum, obj) => sum + (plain(obj) ? unreadOf(obj, me).length : 0), 0)
    return { ok: true, side, me, buckets,
      counts: { mine: buckets[0].count, assigned: buckets[1].count, total: all.length, unread,
        objects: Object.keys(doc.objects).length,
        watchers: new Set(Object.values(doc.objects)
          .flatMap((obj) => (plain(obj) && Array.isArray(obj.watchers) ? obj.watchers : []))).size },
      filter: text(bucket), items: picked, colleagues: colleagues(side), colleague_source: rosterSource(),
      shape: shapeOf(doc, side),
      storage: { file: relative(resolve(String(root ?? '.')), fileOf(side)), mode: '0600',
        why_not_ledger: COLLAB_WHY_NOT_LEDGER } }
  }

  /**
   * 通知中心的数据（插件把它注册成通知源）：指派给我 / @我 / 我关注的 / 我指派的进展。
   * 每条都带 `ref`（对象深链）⇒ 界面上能"从我收到的通知直接跳进对象页"。
   */
  const inbox = ({ side, actor = '' }) => {
    const bad = guard(side, actor)
    if (bad) return []
    const me = text(actor)
    const doc = load(side)
    const shape = shapeOf(doc, side)
    // **不静默**：协作文件整份读不出来 ⇒ 通知里也给一条（否则人以为"今天没有协作通知"）
    const out = shape?.broken ? [{ id: `${side}:collab:store-broken`, level: 'warn',
      title: `协作记录读不出来（${shape.broken.code}）`,
      body: `${shape.broken.reason}｜文件 ${shape.broken.file}`,
      next_action: shape.broken.next_action, at: '', tags: [] }] : []
    for (const obj of Object.values(doc.objects)) {
      if (!plain(obj)) continue
      const label = labelOf(obj)
      const ref = { kind: String(obj.kind), id: String(obj.id), view: side, title: label }
      const assignment = plain(obj.assignment) ? obj.assignment : null
      const unread = unreadOf(obj, me)
      if (assignment && text(assignment.to) === me && assignment.status === 'open') {
        out.push({ id: `${side}:collab:assigned-to-me:${obj.kind}:${obj.id}`, level: 'warn',
          title: `@${nameOf(assignment.by)} 把 ${label} 指派给你`, tags: ['我的', '指派给我'],
          body: `原因：${pretty(assignment.reason)}${assignment.due ? `；截止 ${pretty(assignment.due)}` : '；未写截止'}`,
          next_action: '打开对象页看明细；办完用「指派 / 转交」交给下一个人',
          ref, action: 'collab.comment', preset: { kind: String(obj.kind), id: String(obj.id) }, at: assignment.at })
      }
      for (const event of unread.filter((item) => item.type === 'commented'
        && (item.mentions ?? []).includes(me)).slice(0, 5)) {
        out.push({ id: `${side}:collab:mention:${obj.kind}:${obj.id}:${event.eid}`, level: 'warn',
          title: `@${nameOf(event.by)} 在 ${label} 上 @了你`, tags: ['我的', '@我'],
          body: pretty(flat(event.summary, 200)), next_action: '打开对象页回复；评论里写 @<名字> 会再通知到他',
          ref, action: 'collab.comment', preset: { kind: String(obj.kind), id: String(obj.id) }, at: event.at })
      }
      if ((obj.watchers ?? []).includes(me) && unread.length) {
        out.push({ id: `${side}:collab:watching:${obj.kind}:${obj.id}`, level: 'info',
          title: `你关注的 ${label} 有 ${unread.length} 条新活动`, tags: ['我的', '我关注的'],
          body: unread[0] ? pretty(flat(unread[0].summary, 200)) : '', next_action: '打开对象页看活动流（谁在什么时候做了什么）',
          ref, action: 'collab.read', preset: { kind: String(obj.kind), id: String(obj.id) }, at: unread[0]?.at ?? '' })
      }
      if (assignment && text(assignment.by) === me && text(assignment.to) !== me && assignment.status === 'open') {
        // 只在对方**真的说了什么**时才提醒「我指派的」（评论/回复）——关注/标已读不算"进展"
        const later = unread.filter((event) => text(event.by) === text(assignment.to)
          && event.type === 'commented')
        out.push({ id: `${side}:collab:assigned-by-me:${obj.kind}:${obj.id}:${later.length}`, level: 'info',
          title: `我指派给 @${nameOf(assignment.to)} 的 ${label} 有进展`, tags: ['我指派的'],
          body: later.length ? pretty(flat(later[0].summary, 200)) : `对方还没回话（截止 ${pretty(assignment.due) || '未写'}）`,
          next_action: '打开对象页：可以在评论里 @他催一句', ref, action: 'collab.comment',
          preset: { kind: String(obj.kind), id: String(obj.id) }, at: later[0]?.at ?? assignment.at })
      }
    }
    return out
  }

  /** 状态栏读数（同侧、按当前身份）。 */
  const summary = ({ side, actor = '' }) => {
    const data = hub({ side, actor })
    if (!data.ok) return { ok: false, code: data.code, text: '协作：未登录（指派/评论只在同侧人类之间）',
      level: 'warn', next_action: data.next_action }
    return { ok: true, text: `我的 ${data.counts.mine} · 我指派的 ${data.counts.assigned}`
      + ` · 未读 ${data.counts.unread} · 关注者 ${data.counts.watchers}`
      + `${data.shape ? ` · **读得不完整**（${data.shape.broken ? data.shape.broken.code : `${data.shape.dropped_total} 处坏形状`}）` : ''}`,
      level: data.shape ? 'bad' : (data.counts.mine ? 'warn' : 'ok'), counts: data.counts, side, me: data.me,
      shape: data.shape,
      next_action: data.shape ? data.shape.next_action
        : (data.counts.mine ? '在工作台按「我的」筛选，逐条打开对象页' : '') }
  }

  /** 存储自述（**证据**：协作文件在哪、多大规模、为什么不在账本里）。 */
  const describe = () => {
    const perSide = {}
    for (const side of allowedSides) {
      const doc = load(side)
      perSide[side] = { file: relative(resolve(String(root ?? '.')), fileOf(side)), mode: '0600',
        exists: existsSync(fileOf(side)), objects: Object.keys(doc.objects).length,
        people: Object.keys(doc.people).length,
        // **读侧韧性**的如实读数：坏形状（哪几个字段、该长什么样）与"整份读不出来"都在这里
        shape: shapeOf(doc, side),
        comments: Object.values(doc.objects).reduce((sum, obj) =>
          sum + (plain(obj) && Array.isArray(obj.comments) ? obj.comments.length : 0), 0),
        updated_at: text(doc.updated_at) }
    }
    return { schema: COLLAB_SCHEMA, dir: relative(resolve(String(root ?? '.')), dir), sides: allowedSides,
      per_side: perSide, why_not_ledger: COLLAB_WHY_NOT_LEDGER, colleague_source: rosterSource(),
      bounded: { objects_per_side: MAX_OBJECTS, comments_per_object: MAX_COMMENTS, events_per_object: MAX_EVENTS,
        watchers_per_object: MAX_WATCHERS },
      note: '协作数据按侧分文件、0600：一侧的进程/身份读不到另一侧的（不是"过滤掉"，是结构性隔离）' }
  }

  return { sides: () => allowedSides, dir, fileOf, load, save, configure, colleagues, view, assign, toggleWatch,
    comment, markRead, hub, inbox, summary, describe, refused: REFUSAL_CODES,
    // **跨对象活动流**（「我的今日」）：聚合（只读）+ 标已读 + 导出文本
    feed, markFeedRead, feedText, feedExport, feedWindows: () => FEED_WINDOWS.map((item) => ({ ...item })),
    feedColumns: () => FEED_COLUMNS.slice() }
}
