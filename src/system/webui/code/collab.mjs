/**
 * collab —— **同一侧人类之间的对象级协作**（指派/转交、关注、评论与 `@同事`、活动流、已读），外壳机制层。
 *
 * 它为什么存在：用户的原话是「打开 Teams 能做到的比你多、没人有理由用这个产品」。Teams/VSCode 的日常
 * 工作方式里，除了"看数据"还有**把活交出去**（指派/转交给同事，带原因与截止）、**叫人看**（关注/活动流）、
 * **在对象上说话**（评论 + `@同事`）、**分清这是不是我的事**（我的 / 我指派的 / 全部）。本文件提供这层的
 * **机制**：只存"谁在哪个对象上做过什么协同动作"，不认识任何业务名词（对象类由插件声明，见 `collab-ui.mjs`）。
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
 *   · **同侧人类之间**：`actor` 必须是 `human:<名字>`，且 `to` 必须是**本侧已知同事**（登录过就会进名单）；
 *     跨侧的名字一律拒（`unknown-colleague`）——协作不走这里，跨侧只走 QEP 报文；
 *   · 时间戳是**界面级**的（协作不是事实）⇒ 用调用方给的 `at`（外壳的 `host.now()`），本文件不取墙钟；
 *   · 有界：单对象评论 200 条 / 活动 300 条 / 关注者 64 人；对象数 500（超出按"最久没动过"淘汰并如实报数）。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const COLLAB_SCHEMA = 'quotagent/collab/v1'
export const COLLAB_DIR = 'collab'
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
  'body-required', 'body-too-long', 'cross-side-mentioned', 'not-assigned-to-you', 'collab-write-failed']

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
 * 建协作存储。
 * @param {object} options
 * @param {string} options.root 仓库根（路径只用来算相对路径，便于回执里给人看的路径）
 * @param {string} options.sharedDir 共享目录（`<ui_shared>`；协作文件落它下面的 `collab/`）
 * @param {string} [options.sessionsFile] 身份会话文件（**只读**它来算"本侧同事名单"，不写它）
 * @param {string[]} [options.sides] 允许的侧（由外壳从身份面传入，本文件不硬编码）
 * @param {(msg: string) => void} [options.log]
 */
export function createCollabStore({ root = '.', sharedDir, sessionsFile = '', sides = [], log } = {}) {
  const base = resolve(String(root ?? '.'), String(sharedDir ?? 'tmp/ui-shared'))
  const dir = join(base, COLLAB_DIR)
  let allowedSides = sides.map(text).filter(Boolean)
  /** 会话文件路径（**只读**；装配顺序是"外壳先建、身份面后建" ⇒ 建好后由 `configure()` 补上）。 */
  let sessionsPath = text(sessionsFile) === '' ? '' : resolve(String(root ?? '.'), sessionsFile)
  const say = (msg) => { if (typeof log === 'function') log(`[collab] ${msg}`)
  }
  const fileOf = (side) => join(dir, `${side}.json`)

  /**
   * 装配期后补配置（外壳与身份面的建立顺序不能反：会话文件与合法侧只有身份面知道）。
   * 只影响"本侧同事名单"与侧校验；**已经落下的协作数据不动**。
   */
  const configure = ({ sessionsFile: file, sides: nextSides } = {}) => {
    if (typeof file === 'string' && file.trim() !== '') sessionsPath = resolve(String(root ?? '.'), file.trim())
    if (Array.isArray(nextSides) && nextSides.length) allowedSides = nextSides.map(text).filter(Boolean)
    return { ok: true, sessions_file: sessionsPath, sides: allowedSides }
  }

  const emptyDoc = (side) => ({ schema: COLLAB_SCHEMA, side, objects: {}, people: {},
    updated_at: '', note: COLLAB_WHY_NOT_LEDGER })

  const load = (side) => {
    try {
      const parsed = JSON.parse(readFileSync(fileOf(side), 'utf8'))
      if (!plain(parsed) || !plain(parsed.objects)) return emptyDoc(side)
      parsed.people = plain(parsed.people) ? parsed.people : {}
      parsed.side = side
      return parsed
    } catch (err) { return emptyDoc(side) }
  }
  /** 原子写：临时文件 → `chmod 0600` → rename（不受 umask 影响；与身份会话同一口径）。 */
  const save = (side, doc) => {
    doc.updated_at = text(doc.updated_at)
    const payload = JSON.stringify(doc, null, 1) + '\n'
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmp = join(dir, `.${side}.${process.pid}.tmp`)
      writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, fileOf(side))
      return { ok: true, file: relative(resolve(root ?? '.'), fileOf(side)), mode: '0600' }
    } catch (err) {
      return refusal('collab-write-failed', flat(err),
        `先修 ${relative(resolve(root ?? '.'), dir)} 目录权限（协作文件必须 0600；写不进去时界面如实报，不假装成功）`)
    }
  }

  // ------------------------------------------------------------------ 名单：本侧同事（会话里登录过 + 协作记录里出现过）
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
    } catch (err) { return [] }        // 读不到会话文件 ⇒ 名单只靠协作记录（如实降级，不猜人）
  }
  const colleagues = (side) => {
    const doc = load(side)
    const out = new Map()
    for (const person of sessionPeople(side)) out.set(person.name, person)
    for (const [human, row] of Object.entries(doc.people)) {
      const name = String(row?.name ?? human.replace(/^human:/, ''))
      if (!NAME_RE.test(name)) continue
      if (out.has(name)) { out.get(name).source = 'session+collab'; continue }
      out.set(name, { name, human: `human:${name}`, source: 'collab', first_at: row?.first_at ?? null,
        last_at: row?.last_at ?? null })
    }
    return [...out.values()].sort((left, right) => (left.name < right.name ? -1 : 1))
  }
  const isColleague = (side, human) => colleagues(side).some((person) => person.human === human)

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
    .filter((event) => text(event.by) !== actor && (!readAtOf(obj, actor) || text(event.at) > readAtOf(obj, actor)))

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
      watchers: (obj?.watchers ?? []).map((human) => ({ human, name: human.replace(/^human:/, ''),
        me: human === me })),
      comments, events: (obj?.events ?? []).slice(0, 50),
      read_at: readAtOf(obj, me), unread: unread.length,
      unread_comments: unread.filter((event) => event.type === 'commented').length,
      mine: text(obj?.assignment?.to) === me, watching: (obj?.watchers ?? []).includes(me),
      colleagues: colleagues(side), me,
      counts: { comments: comments.length, events: (obj?.events ?? []).length,
        watchers: (obj?.watchers ?? []).length, dropped_comments: obj?.dropped_comments ?? 0 },
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
      const list = colleagues(side).map((person) => `@${person.name}`).join(' ')
      return refusal('unknown-colleague', `${target} 不在本侧（${side}）已知同事名单里`,
        `协作只在**同侧人类**之间：本侧已知 ${list || '（还没有人登录过本侧）'}；`
        + '对方登录过一次就会进名单；跨侧不能指派（跨侧只走 QEP 报文）')
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
    const history = (
      Array.isArray(before?.history) ? before.history : []).slice(-19)
    if (before) {
      history.push({ type: before.to === target ? 'reassigned-in-place' : 'handed-over', by: before.by,
        to: before.to, reason: before.reason, due: before.due, at: before.at })
    }
    obj.assignment = { to: target, by: me, reason: why, due: deadline, at, status: 'open', history }
    pushEvent(obj, { at, by: me, type: before ? 'reassigned' : 'assigned', to: target, reason: why, due: deadline,
      summary: `${me} 把「${labelOf(obj)}」指派给 ${target}（原因：${flat(why, 80)}${deadline ? `；截止 ${deadline}` : ''}）` })
    touchPerson(doc, me, at); touchPerson(doc, target, at)
    const saved = save(side, doc)
    if (!saved.ok) return saved
    return { ok: true, code: before ? 'reassigned' : 'assigned', target, reason: why, due: deadline,
      file: saved.file, mode: saved.mode, history_depth: history.length,
      next_action: `${target} 打开工作台/通知中心的「我的」就能看到这一条（同侧可见；对方侧看不到）` }
  }

  /** 关注 / 取消关注（**每人一份**：我关注不影响别人，别人关注也不影响我）。 */
  const toggleWatch = ({ side, actor, kind, id, title = '', at = '', want = null }) => {
    const me = text(actor)
    const bad = guard(side, me) ?? guardObject(kind, id)
    if (bad) return bad
    const doc = load(side)
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
      watchers: obj.watchers.map((human) => ({ human, me: human === me })),
      file: saved.file, mode: saved.mode,
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
    const roster = new Set(colleagues(side).map((person) => person.name))
    const otherSides = allowedSides.filter((item) => item !== side)
    const otherNames = new Set(otherSides.flatMap((item) => colleagues(item).map((person) => person.name)))
    for (const name of [...new Set(found)]) {
      const human = `human:${name}`
      if (roster.has(name)) { mentions.push(human); continue }
      if (otherNames.has(name)) { crossSide.push(human); continue }
      unresolved.push(human)
    }
    if (crossSide.length) {
      return refusal('cross-side-mentioned',
        `${crossSide.join(' / ')} 属于**另一侧**，不能出现在本侧内部评论里`,
        '本侧评论只在本侧人类之间可见：要跟对方沟通走业务动作（答疑/广播/报价/变更），不走这里')
    }
    const doc = load(side)
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
      next_action: mentions.length
        ? `${mentions.join(' ')} 的通知中心会多一条「@我」（同侧可见；它不落账本、不影响合同事实）`
        : (unresolved.length
          ? `提醒：${unresolved.join(' ')} 不在本侧名单里，**没有**通知到任何人`
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
      next_action: '已读是你自己的标记（同侧别人不受影响，也不进账本）' }
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
          body: `${assignment.by} 交给你办（原因：${assignment.reason}`
            + `${assignment.due ? `；截止 ${assignment.due}` : '；未写截止'}）`
            + `${unread.length ? `｜这条上还有 ${unread.length} 条未读活动` : ''}`,
          next_action: '打开对象页：办完可以「指派 / 转交」给下一个人，或「标为已读」',
          ref, action: 'collab.comment', label: '评论 / @同事', at: assignment.at,
          detail: { assigned_by: assignment.by, due: assignment.due, reason: assignment.reason } })
      }
      for (const event of mentioned.slice(0, 3)) {
        const who = text(event.by)
        items.push({ id: `collab-mention-${obj.kind}-${obj.id}-${event.eid}`, bucket: 'mine',
          bucket_label: '我的', level: 'warn', title: `@我：${who} 在 ${labelOf(obj)} 上提到你`,
          body: flat(event.summary, 160), next_action: '打开对象页回复（评论里写 @<名字> 会再通知到他）',
          ref, action: 'collab.comment', label: '回复', at: event.at })
      }
      if (watching && unread.length && !mentioned.length) {
        items.push({ id: `collab-watch-${obj.kind}-${obj.id}`, bucket: 'mine', bucket_label: '我的',
          level: 'info', title: `你关注的 ${labelOf(obj)} 有 ${unread.length} 条新活动`,
          body: unread[0] ? flat(unread[0].summary, 160) : '', next_action: '打开对象页看活动流',
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
          title: `我指派给 ${assignment.to}：${labelOf(obj)}`,
          body: `对方${theyRead ? '已读过' : '还没读'}｜截止 ${assignment.due || '未写'}`
            + `${later.length ? `｜对方留了 ${later.length} 条评论：${flat(later[0].summary, 100)}` : ''}`,
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
      filter: text(bucket), items: picked, colleagues: colleagues(side),
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
    const out = []
    for (const obj of Object.values(doc.objects)) {
      if (!plain(obj)) continue
      const label = labelOf(obj)
      const ref = { kind: String(obj.kind), id: String(obj.id), view: side, title: label }
      const assignment = plain(obj.assignment) ? obj.assignment : null
      const unread = unreadOf(obj, me)
      if (assignment && text(assignment.to) === me && assignment.status === 'open') {
        out.push({ id: `${side}:collab:assigned-to-me:${obj.kind}:${obj.id}`, level: 'warn',
          title: `${assignment.by} 把 ${label} 指派给你`, tags: ['我的', '指派给我'],
          body: `原因：${assignment.reason}${assignment.due ? `；截止 ${assignment.due}` : '；未写截止'}`,
          next_action: '打开对象页看明细；办完用「指派 / 转交」交给下一个人',
          ref, action: 'collab.comment', preset: { kind: String(obj.kind), id: String(obj.id) }, at: assignment.at })
      }
      for (const event of unread.filter((item) => item.type === 'commented'
        && (item.mentions ?? []).includes(me)).slice(0, 5)) {
        out.push({ id: `${side}:collab:mention:${obj.kind}:${obj.id}:${event.eid}`, level: 'warn',
          title: `${event.by} 在 ${label} 上 @了你`, tags: ['我的', '@我'],
          body: flat(event.summary, 200), next_action: '打开对象页回复；评论里写 @<名字> 会再通知到他',
          ref, action: 'collab.comment', preset: { kind: String(obj.kind), id: String(obj.id) }, at: event.at })
      }
      if ((obj.watchers ?? []).includes(me) && unread.length) {
        out.push({ id: `${side}:collab:watching:${obj.kind}:${obj.id}`, level: 'info',
          title: `你关注的 ${label} 有 ${unread.length} 条新活动`, tags: ['我的', '我关注的'],
          body: unread[0] ? flat(unread[0].summary, 200) : '', next_action: '打开对象页看活动流（谁在什么时候做了什么）',
          ref, action: 'collab.read', preset: { kind: String(obj.kind), id: String(obj.id) }, at: unread[0]?.at ?? '' })
      }
      if (assignment && text(assignment.by) === me && text(assignment.to) !== me && assignment.status === 'open') {
        // 只在对方**真的说了什么**时才提醒「我指派的」（评论/回复）——关注/标已读不算"进展"
        const later = unread.filter((event) => text(event.by) === text(assignment.to)
          && event.type === 'commented')
        out.push({ id: `${side}:collab:assigned-by-me:${obj.kind}:${obj.id}:${later.length}`, level: 'info',
          title: `我指派给 ${assignment.to} 的 ${label} 有进展`, tags: ['我指派的'],
          body: later.length ? flat(later[0].summary, 200) : `对方还没回话（截止 ${assignment.due || '未写'}）`,
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
      + ` · 未读 ${data.counts.unread} · 关注者 ${data.counts.watchers}`,
      level: data.counts.mine ? 'warn' : 'ok', counts: data.counts, side, me: data.me,
      next_action: data.counts.mine ? '在工作台按「我的」筛选，逐条打开对象页' : '' }
  }

  /** 存储自述（**证据**：协作文件在哪、多大规模、为什么不在账本里）。 */
  const describe = () => {
    const perSide = {}
    for (const side of allowedSides) {
      const doc = load(side)
      perSide[side] = { file: relative(resolve(String(root ?? '.')), fileOf(side)), mode: '0600',
        exists: existsSync(fileOf(side)), objects: Object.keys(doc.objects).length,
        people: Object.keys(doc.people).length,
        comments: Object.values(doc.objects).reduce((sum, obj) =>
          sum + (plain(obj) && Array.isArray(obj.comments) ? obj.comments.length : 0), 0),
        updated_at: text(doc.updated_at) }
    }
    return { schema: COLLAB_SCHEMA, dir: relative(resolve(String(root ?? '.')), dir), sides: allowedSides,
      per_side: perSide, why_not_ledger: COLLAB_WHY_NOT_LEDGER,
      bounded: { objects_per_side: MAX_OBJECTS, comments_per_object: MAX_COMMENTS, events_per_object: MAX_EVENTS,
        watchers_per_object: MAX_WATCHERS },
      note: '协作数据按侧分文件、0600：一侧的进程/身份读不到另一侧的（不是"过滤掉"，是结构性隔离）' }
  }

  return { sides: () => allowedSides, dir, fileOf, load, save, configure, colleagues, view, assign, toggleWatch,
    comment, markRead, hub, inbox, summary, describe, refused: REFUSAL_CODES }
}
