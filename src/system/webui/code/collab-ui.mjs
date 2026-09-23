/**
 * collab-ui —— 把 `collab.mjs` 的**同侧协作**搬上界面（对象级指派/转交、关注、评论与 `@同事`、活动流、
 * 工作台的「我的 / 我指派的 / 全部」、通知中心的「指派给我 / @我 / 我关注的 / 我指派的」）。
 *
 * 它为什么在**外壳这一层**而不是某个业务插件里（这不是"把业务写进外壳"）：
 *   · 本文件**不出现任何业务名词、插件 id、对象类字面量**：对象类来自 `surface.objectKindsFor(view)` ——
 *     **谁声明的对象类，谁就自动获得协作面**（今天有 包/报价/授标/PO/变更/门，明天插件再加一类也一样）；
 *   · 协作本身是通用能力（Teams 的"指派/关注/评论/@人"对任何对象都成立），所以它是外壳的机制面，
 *     与"通知中心/命令面板/布局"同一层；业务语义（对象是什么、能做哪些业务动作）仍全在插件里；
 *   · 侧与身份只来自**会话**（`ctx.identity`，由外壳按 cookie 解析）⇒ 协作永远是"同侧人类之间"；
 *     未登录时对象页如实说"要登录"，而不是给出一个假的可编辑框。
 *
 * 纪律：这些贡献走的是**同一个注册面**（`surface.*`），因此与插件贡献一样**可撤销**（`dispose()`），
 * 并按"当前声明的视图/对象类"**对账式**注册（`sync()`：新类目出现就挂上、消失就撤掉，规则 1）；
 * 协作数据只落 `<ui_shared>/collab/<side>.json`（0600），**不进账本、不进投影、不进模型输入**
 * （理由逐条写在 `collab.mjs` 文件头）。
 */
// 显示口径（`@名字` / 人话时间）与协作存储**同一份实现**，别在这里再写一份（重复即漂移）。
import { nameOf, atLabel, pretty } from './collab.mjs'

export const COLLAB_PLUGIN_ID = 'system/collab'
/** 对象页上面板顺序：排在业务面板之后（不抢对象页头，也不挡别人的表）。 */
const OBJECT_PANEL_ORDER = 900

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 显示口径与协作存储**同一份实现**（`collab.mjs` 里导出）：`human:limin` → `@limin`、
 * 毫秒 ISO → `2026-09-23 08:50（UTC+08:00）`。**别在这里再写一份**（重复即漂移）。
 * 为什么要这一层：P13 走查实测协作面板把 `human:limin` 与 `2026-09-23T00:48:52.624Z` 当人名/时间显示，
 * 而同屏的「同事」行写的是漂亮的 `@limin（主管 · 在线）` ⇒ 同一屏两种口径，自相矛盾。
 * **逻辑判据用原始值**（`by`/`to`/`watchers[]` 仍是 `human:<名字>`），只有**给人看的字符串**过这一层。
 */
const show = (value) => pretty(value)
const at = (iso) => atLabel(iso)
const who = (human) => `@${nameOf(human)}`

/**
 * 面板上"这块读得不完整"的**如实降级行** —— 不是静默空着。
 * 一行一条、**值都短**（长句进 `next_action`）：值列在窄列里换行会难看，可读性也是这一条要求的一部分。
 */
const shapeItems = (shape) => {
  if (!shape) return []
  // kv 面板的**值列在窄屏上只有几十像素**（三列布局）：一长串会把字挤成一列一个字。
  // 所以降级说明**不塞进值里**，而是走面板的 `note`（整行）+ `next_action`（整行）—— 两者都自然换行。
  if (shape.broken) {
    return [{ key: '⚠ 这份协作文件读不出来（不是"没有协作记录"）', code: true,
      value: '原因与修法见下方提示' }]
  }
  return [{ key: `⚠ 有 ${shape.dropped_total} 处坏形状（已跳过，不是"没有"）`, code: true,
    value: '逐条说明见下方提示' }]
}
/** 一句话摘要（进面板的 `note`，整行、可换行）。 */
const shapeNote = (shape) => (shape
  ? (shape.broken
    ? `⚠ 协作文件读不出来（${shape.broken.code}）：${show(shape.broken.reason)}｜文件 ${shape.broken.file}`
    : `⚠ 有 ${shape.dropped_total} 处坏形状（已跳过，不是"没有"）：`
      + [...new Set((shape.problems ?? []).map((problem) => problem.field))].slice(0, 6).join('、')
      + `${(shape.problems ?? []).length > 6 ? ' …' : ''}`)
  : '')
/** 面板 `next_action` 里那段**完整**的降级说明（逐条 why + 该长什么样 + 怎么修）。 */
const shapeExplain = (shape) => (shape
  ? `${(shape.problems ?? []).map((problem) => `${problem.field}：${show(problem.why)}（跳过 ${problem.dropped} 处）`).join('；')}`
    + `${(shape.problems ?? []).length ? '｜' : ''}${show(shape.how_to_fix)}`
  : '')

/**
 * @param {object} options
 * @param {object} options.surface 注册面（`ui-surface.mjs`）
 * @param {object} options.host 机制上下文（用 `host.collab` 这个协作存储句柄、`host.now()`）
 * @param {string[]} options.views 协作面覆盖的视图（装配方给：身份侧的视图；`home` 由本模块自己加上）
 * @param {(msg: string) => void} [options.log]
 */
export function createCollabSurface({ surface, host, views = [], log } = {}) {
  const me = COLLAB_PLUGIN_ID
  const say = (msg) => { if (typeof log === 'function') log(`[collab-ui] ${msg}`) }
  const collaborators = () => (host && host.collab ? host.collab : null)
  const meOf = (ctx) => (ctx && ctx.identity ? ctx.identity : null)

  let viewList = views.map(asText).filter((view) => view !== '')
  /** 与视图无关的贡献（动作 / 通知源 / 状态项）：视图列表变了要整体重建（动作的 `views` 是声明的一部分）。 */
  let onceDisposers = []
  let onceViews = null
  /** 按视图/对象类注册的贡献（`sync()` 对账用）：新类目出现就挂上，消失就撤掉。 */
  const hubPanels = new Map()       // view → [disposer…]
  const objectPanels = new Map()    // `<view>\0<kind>` → [disposer…]

  const businessViews = () => viewList.filter((view) => view !== 'home')
  const push = (bucket, out) => {
    if (out && out.ok === true) bucket.push(out.dispose)
    else say(`贡献被拒：${out?.code ?? 'unknown'}（${asText(out?.reason)}）`)
    return out
  }

  /** 未登录/机制缺失时的**如实**面板数据（不是"空数据"，也不是可点的假控件）。 */
  const blocked = (reason, next) => ({ ok: true, kind: 'kv', degraded: true, reason,
    next_action: next, items: [{ key: '协作', value: '只发生在**同一侧登录的人**之间：先登录再来指派/评论' }] })

  // ------------------------------------------------------------------ ① 对象页：协作状态（谁在办 / 谁在看 / 谁 @ 过我）
  const objectPanelData = (kind) => (ctx) => {
    const store = collaborators()
    const me = meOf(ctx)
    if (!store) return blocked('collab-mechanism-missing', '外壳没有装上协作机制（这是外壳的装配问题）')
    if (!me) return blocked('identity-required',
      '顶栏「身份」→ 去登录（human:<名字> + 属于哪一侧）后再看这里的指派与评论')
    const id = asText(ctx?.route?.id)
    const data = store.view({ side: me.side, actor: me.human, kind, id })
    if (!data.ok) {
      return { ok: true, kind: 'kv', degraded: true, reason: data.code, next_action: data.next_action,
        items: [{ key: '协作', value: '这一侧读不到协作数据（按会话侧隔离）' }] }
    }
    const assignment = data.assignment
    const watchers = data.watchers.map((item) => `@${item.name}${item.me ? '（你）' : ''}`)
    const shape = data.shape ?? null
    const items = [
      // 人名与时刻都走**同一套显示口径**（`@limin（你）· 由 @wanglei 指派 · 2026-09-23 08:50（UTC+08:00）`）：
      // 原始值（`human:limin` / 毫秒 ISO）只留在回执与文件里，不上界面。
      { key: '当前指派', value: assignment
        ? `${who(assignment.to)}${assignment.to === me.human ? '（你）' : ''}`
          + `（由 ${who(assignment.by)} 指派 · ${at(assignment.at)}）`
        : '（未指派：还没有人把这件事交给谁）', code: Boolean(assignment) },
      { key: '为什么交办 / 截止', value: assignment
        ? `${show(assignment.reason)}${assignment.due ? `｜截止 ${at(assignment.due)}` : '｜未写截止'}` : '—' },
      { key: '关注这个对象的人', value: watchers.length
        ? `${watchers.join(' ')}（共 ${watchers.length} 人；${data.watching ? '你也在其中' : '你还没关注'}）`
        : '还没有人关注（关注只影响自己：关注后的新活动进你通知中心的「我的」）' },
      { key: '我的未读', value: data.unread
        ? `${data.unread} 条（其中评论 ${data.unread_comments} 条）—— 标已读只影响你自己`
        : '0 条（没有别人留下的新活动）' },
      { key: '同侧同事（可 @）', value: data.colleagues.length
        ? data.colleagues.map((person) => `@${person.name}`
          + (person.role_label ? `（${person.role_label}${person.logged_in ? ' · 在线' : ''}）` : '')).join(' ')
        : '（本侧名册还是空的：用「名册：加人」加一个，或让对方登录一次自动登记为「待指派」）' },
      { key: '同事名单来自哪', value: `${data.colleague_source?.source === 'roster'
        ? `**人员名册**：${data.colleague_source.file}（${data.colleague_source.mode}）`
        : `**降级**（名册未装配）：${data.colleague_source?.note ?? ''}`}`
        + '｜名册里没有的名字会被如实拒（`unknown-colleague`）', code: true },
      { key: '协作数据落在哪', value: `${data.storage.file}（${data.storage.mode}；按侧隔离，不进账本）`,
        code: true },
    ]
    items.push(...shapeItems(shape))        // ⚠ 如实降级：哪几个字段读不出来 + 该长什么样（修法在 next_action）
    return { ok: true, kind: 'kv', items, counts: data.counts,
      degraded: data.found !== true || Boolean(shape),
      note: shapeNote(shape),
      reason: shape ? (shape.broken ? shape.broken.code : 'collab-shape-bad-fields')
        : (data.found === true ? null : 'no-collab-yet'),
      next_action: shape ? `${shape.broken ? show(shape.how_to_fix) : shapeExplain(shape)}｜${shape.next_action}`
        : (assignment ? '办完用「指派 / 转交」交给下一个人（附原因与截止），或「标为已读」'
          : '工具栏「指派 / 转交」把这件事交给同侧同事（写清原因与截止）') }
  }

  // ------------------------------------------------------------------ ② 对象页：评论与活动流（谁在什么时候做了什么）
  const threadPanelData = (kind) => (ctx) => {
    const store = collaborators()
    const me = meOf(ctx)
    if (!store || !me) {
      return { ok: true, kind: 'list', degraded: true,
        reason: store ? 'identity-required' : 'collab-mechanism-missing',
        next_action: store ? '登录后这条时间线里就有同侧同事的评论与活动' : '外壳装配问题',
        items: [{ level: 'info', title: '活动流只给同侧登录的人看（未登录 ⇒ 看不到，也不假装是空的）' }] }
    }
    const id = asText(ctx?.route?.id)
    const data = store.view({ side: me.side, actor: me.human, kind, id })
    if (!data.ok) {
      return { ok: true, kind: 'list', degraded: true, reason: data.code, next_action: data.next_action,
        items: [{ level: 'info', title: '这一侧读不到协作数据（按会话侧隔离）' }] }
    }
    const items = []
    for (const comment of [...data.comments].reverse()) {
      // **同屏一致**：这里显示 `@limin`（与左边的「同事」行同一口径），不是 `human:limin`
      items.push({ level: comment.mentions_me ? 'warn' : (comment.mine ? 'ok' : 'info'),
        title: `${who(comment.by)} 评论${comment.mentions_me ? '（@了你）' : ''}`
          + `${comment.mentions.length ? `，@ ${comment.mentions.map((human) => nameOf(human)).join(' ')}` : ''}`,
        body: comment.body, at: comment.at,
        next_action: comment.mine ? '' : '工具栏「评论 / @同事」回复（写 @<名字> 会再通知到他）' })
    }
    const words = { assigned: '指派', reassigned: '转交', watched: '开始关注', unwatched: '取消关注' }
    for (const event of data.events.slice(0, 40)) {
      if (event.type === 'commented') continue          // 评论已经单独列过了
      items.push({ level: 'info', title: `${who(event.by)}：${words[event.type] ?? event.type}`,
        body: show(event.summary), at: event.at })
    }
    const shape = data.shape ?? null
    if (shape?.broken) {
      items.push({ level: 'bad', title: `协作记录读不出来（${shape.broken.code}）`,
        body: `${show(shape.broken.reason)}｜文件 ${shape.broken.file}`,
        next_action: shape.broken.next_action })
    } else if (shape) {
      items.push({ level: 'warn', title: `有 ${shape.dropped_total} 处协作记录的形状读不出来（已跳过，不是"没有"）`,
        body: (shape.problems ?? []).slice(0, 5).map((problem) =>
          `${problem.object} 的 ${problem.field}（${show(problem.why)}）`).join('；'),
        next_action: shape.next_action })
    }
    return { ok: true, kind: 'list', items, reason: items.length ? null : 'no-collab-activity',
      degraded: Boolean(shape),
      next_action: shape ? `${shape.broken ? show(shape.how_to_fix) : shapeExplain(shape)}｜${shape.next_action}`
        : (items.length ? '' : '还没有人在这里说过话：用工具栏「评论 / @同事」写第一句（同侧可见）'),
      counts: { comments: data.counts.comments, events: data.counts.events,
        dropped_comments: data.counts.dropped_comments },
      note: [shapeNote(shape), data.counts.dropped_comments
        ? `有界：单对象只留最近 200 条评论，更早的 ${data.counts.dropped_comments} 条已滚出（如实报数，不假装还在）`
        : ''].filter(Boolean).join('｜') }
  }

  // ------------------------------------------------------------------ ③ 工作台：我的 / 我指派的 / 全部
  const hubPanelData = (view) => (ctx) => {
    const store = collaborators()
    const me = meOf(ctx)
    if (!store) return { ok: true, kind: 'list', degraded: true, reason: 'collab-mechanism-missing', items: [] }
    if (!me) {
      // **未登录**：工作台把两侧的待办并在一张卡上，卡头那句「有 N 件需要你处理」按本侧算 ——
      // 没有会话身份就没有"本侧" ⇒ 别的面板在这条上都会降成"信息"，这里**只留一条 warn**：
      // "先登录才知道哪些是你的"。这是**如实**的：没登录谁也办不了（业务动作一律被拒）。
      return { ok: true, kind: 'list', degraded: true, reason: 'identity-required',
        next_action: '顶栏「身份」→ 去登录：登录后这里按「我的 / 我指派的」列出同侧同事交给你的活',
        items: [{ level: 'warn', title: '未登录：先登录才知道哪些待办属于你（这一侧的卡头计数只算本侧）',
          body: `当前地址：${ctx?.route?.view ?? view}；未登录时读不到任何人的指派`
            + '，工作台上别的面板的待办也都只作为"信息"列出（按会话侧隔离，不是"没有"）',
          next_action: '顶栏「身份」→ 去登录（human:<名字> + 属于哪一侧）' }] }
    }
    const data = store.hub({ side: me.side, actor: me.human })
    if (!data.ok) {
      return { ok: true, kind: 'list', degraded: true, reason: data.code, next_action: data.next_action, items: [] }
    }
    const shape = data.shape ?? null
    const items = data.items.map((item) => ({ id: item.id, level: item.level, title: item.title, body: item.body,
      next_action: item.next_action, ref: item.ref, action: item.action, label: item.label, at: item.at,
      // 桶（过滤维度）：`mine`=我的、`assigned`=我指派的 ⇒ 界面出「我的 / 我指派的 / 全部」筛选片
      bucket: item.bucket, bucket_label: item.bucket_label }))
    if (shape?.broken) {
      items.push({ level: 'bad', title: `协作记录读不出来（${shape.broken.code}）——「我的」现在读不到任何一条`,
        body: `${show(shape.broken.reason)}｜文件 ${shape.broken.file}`,
        next_action: shape.broken.next_action })
    } else if (shape) {
      items.push({ level: 'warn', title: `有 ${shape.dropped_total} 处协作记录的形状读不出来（已跳过，不是"没有"）`,
        body: (shape.problems ?? []).slice(0, 5).map((problem) =>
          `${problem.object} 的 ${problem.field}（${show(problem.why)}）`).join('；'),
        next_action: shape.next_action })
    }
    return { ok: true, kind: 'list', items,
      degraded: Boolean(shape),
      buckets: data.buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, count: bucket.count })),
      counts: data.counts, reason: items.length ? null : 'no-collab-for-you',
      next_action: shape ? `${shape.broken ? show(shape.how_to_fix) : shapeExplain(shape)}｜${shape.next_action}`
        : (data.items.length
          ? '每一行的「打开」进对象页；「我的」= 别人交给你的活，「我指派的」= 你交出去的活现在怎么样了'
          : '还没有协作项：打开一个对象页（包/报价/门/变更），用工具栏「指派 / 转交」把活交给同侧同事'),
      note: [shapeNote(shape), `协作存储：${data.storage.file}（0600，按侧隔离；不进账本）`]
        .filter(Boolean).join('｜') }
  }

  // ------------------------------------------------------------------ 注册（可撤销 / 可对账）
  const registerObjectPanels = (view, kind) => {
    const made = []
    push(made, surface.panel({ plugin_id: me, id: `collab.object-${view}-${kind}`,
      title: '协作：指派 / 关注（同侧）', view, order: OBJECT_PANEL_ORDER, kind: 'kv', object_kind: kind,
      hint: '指派/转交、关注、@同事 只发生在**同一侧**的人之间；这些记录不进账本、不影响合同事实',
      data: objectPanelData(kind) }))
    push(made, surface.panel({ plugin_id: me, id: `collab.thread-${view}-${kind}`,
      title: '协作：评论与活动流', view, order: OBJECT_PANEL_ORDER + 1, kind: 'list', object_kind: kind,
      actions: ['collab.comment', 'collab.read'],
      hint: '一个对象上发生过什么、谁在看：评论里写 @<名字> 会通知到同侧的那位同事',
      data: threadPanelData(kind) }))
    return made
  }

  const registerHub = (view) => {
    const made = []
    push(made, surface.panel({ plugin_id: me, id: `collab.hub-${view}`, title: '协作：我的 / 我指派的 / 全部',
      view, order: view === 'home' ? 20 : 890, kind: 'list', actions: ['collab.assign', 'collab.comment'],
      hint: '「我的」= 别人交给你的活，「我指派的」= 你交出去的活现在怎么样了；点「打开」进对象页',
      data: hubPanelData(view) }))
    return made
  }

  const registerOnce = () => {
    onceDisposers = []
    const sides = [...businessViews(), 'home']
    // 动作：**视图级**（不带 object_kind）——它们的入参由**当前对象地址**预填（`from_route` / `from_route_kind`），
    // 于是一份注册对**所有对象类**都成立（对象类由插件声明，本模块不认识任何对象类）。
    const objectFields = [
      { name: 'kind', label: '对象类', type: 'text', from_route_kind: true,
        help: '由当前对象地址带出（在对象页上点这个动作会自动填）' },
      { name: 'id', label: '对象 id', type: 'text', from_route: true,
        help: '由当前对象地址带出；从列表/通知进来时会按那条记录预填' },
    ]
    push(onceDisposers, surface.action({ plugin_id: me, id: 'collab.assign', title: '指派 / 转交给同事',
      views: sides, group: '协作', order: 5, icon: 'user', placement: ['toolbar', 'inline', 'command'],
      confirm: { required: true, message: '把这件事交给同侧同事（会通知到他；不影响账本与合同事实）——确认交办？' },
      hint: '同侧人类之间把活交出去：无人时是指派，已有人时是转交（历史留痕）；跨侧不能指派',
      input: { fields: [...objectFields,
        { name: 'to', label: '交给谁（@同事）', type: 'text', required: true,
          suggest_url: '/api/people/suggest',
          help: '取值来自**人员名册**（本侧在册成员 + 角色）；打字时会给出候选（也可以照旧手敲）；'
            + '名册里没有的名字会被如实拒（unknown-colleague）' },
        { name: 'reason', label: '原因（接手的人靠它判断优先级）', type: 'textarea', required: true },
        { name: 'due', label: '截止（ISO8601，可空）', type: 'text', help: '例：2026-10-01T18:00:00Z' }] },
      server: async (ctx, input) => runCollab(ctx, 'assign', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'collab.toggle-watch', title: '关注 / 取消关注',
      views: sides, group: '协作', order: 6, placement: ['toolbar', 'inline', 'command'],
      confirm: { required: false },
      hint: '关注后这个对象的新活动会进你通知中心的「我的」；**每人一份**，不影响别人',
      input: { fields: [...objectFields] },
      server: async (ctx, input) => runCollab(ctx, 'watch', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'collab.comment', title: '评论 / @同事',
      views: sides, group: '协作', order: 7, placement: ['toolbar', 'inline', 'command'],
      confirm: { required: false },
      hint: '同侧可见的评论；正文里写 @<名字> 会通知到那位同事（跨侧名字会被拒：跨侧沟通走业务动作）',
      input: { fields: [...objectFields,
        { name: 'body', label: '评论正文（可 @同事）', type: 'textarea', required: true,
          mention_suggest_url: '/api/people/suggest',
          help: '例：@limin 这条料的量要跟现场再核一遍｜在正文里打 `@` 会弹出**名册**里的候选' }] },
      server: async (ctx, input) => runCollab(ctx, 'comment', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'collab.read', title: '标为已读',
      views: sides, group: '协作', order: 8, placement: ['toolbar', 'inline', 'command'],
      confirm: { required: false },
      hint: '已读是**你自己的**标记（同侧别人的未读不受影响，也不进账本）',
      input: { fields: [...objectFields] },
      server: async (ctx, input) => runCollab(ctx, 'read', input) }))
    // 通知中心：指派给我 / @我 / 我关注的 / 我指派的进展（每条都带对象深链 ⇒ 一键跳进对象页）
    push(onceDisposers, surface.notificationSource({ plugin_id: me, id: 'collab.notify',
      title: '协作（指派 / @我 / 我关注的）', order: 10,
      hint: '协作通知是同侧人类之间的事：不落账本、不影响合同事实；已读只在你本浏览器',
      poll: (ctx) => {
        const store = collaborators()
        const who = meOf(ctx)
        return store && who ? store.inbox({ side: who.side, actor: who.human }) : []
      } }))
    push(onceDisposers, surface.statusItem({ plugin_id: me, id: 'collab.status', title: '协作', order: 45,
      read: (ctx) => {
        const store = collaborators()
        const who = meOf(ctx)
        if (!store) return { text: '协作机制未装配', level: 'warn' }
        if (!who) return { text: '未登录（指派/评论只在同侧登录的人之间）', level: 'warn',
          next_action: '顶栏「身份」→ 去登录' }
        const out = store.summary({ side: who.side, actor: who.human })
        return out.ok ? { text: out.text, level: out.level, next_action: out.next_action } : out
      } }))
    onceViews = viewList.join(',')
  }

  /** 动作的**服务端一半**：侧与 actor 一律取**会话**，入参里的 kind/id 只当"对哪个对象"（不决定身份）。 */
  const runCollab = async (ctx, verb, input) => {
    const store = collaborators()
    const who = meOf(ctx)
    if (!store) {
      return { ok: false, code: 'collab-mechanism-missing', reason: '外壳没有装上协作机制',
        next_action: '这是外壳装配问题：看服务日志里 [collab] 的报错' }
    }
    if (!who) {
      return { ok: false, code: 'identity-required',
        reason: '协作是**同一侧登录的人**之间的事：当前请求没有会话身份',
        next_action: '顶栏「身份」→ 去登录（human:<名字> + 属于哪一侧），再用同一个动作；这一次什么都没写' }
    }
    const kind = asText(input.kind) || asText(ctx?.route?.kind)
    const id = asText(input.id) || asText(ctx?.route?.id)
    if (kind === '' || id === '') {
      return { ok: false, code: 'object-required',
        reason: `不知道对**哪个对象**协作（kind=${JSON.stringify(kind)} id=${JSON.stringify(id)}）`,
        next_action: '在对象页上打开这个动作（会按地址预填），或从列表/通知里点这一行的按钮' }
    }
    const base = { side: who.side, actor: who.human, kind, id, at: host.now() }
    const out = verb === 'assign' ? store.assign({ ...base, to: input.to, reason: input.reason, due: input.due })
      : verb === 'comment' ? store.comment({ ...base, body: input.body })
        : verb === 'watch' ? store.toggleWatch(base) : store.markRead(base)
    // 被拒时把**可核对的额外读数**一起回执（本侧名册 / 当前指派给谁 / 我是什么角色）：
    // 界面与脚本据此说明"为什么被拒、该找谁"，而不是只给一句 code。
    const refusalInfo = out.ok === true ? null : { code: out.code ?? null,
      roster: Array.isArray(out.roster) ? out.roster : null,
      assigned_to: out.assigned_to ?? null, assigned_by: out.assigned_by ?? null, role: out.role ?? null }
    return { ok: out.ok === true, code: out.code ?? null, reason: out.reason ?? null,
      next_action: out.next_action ?? null,
      result: out.ok ? { side: who.side, actor: who.human, kind, id, verb,
        ...(out.code === 'commented' ? { cid: out.cid, mentions: out.mentions, unresolved: out.unresolved } : {}),
        ...(out.code === 'assigned' || out.code === 'reassigned'
          ? { to: out.target, due: out.due, history_depth: out.history_depth,
            transfer: out.transfer ?? null } : {}),
        ...(out.code === 'watching' || out.code === 'unwatched' ? { watching: out.watching } : {}),
        ...(out.code === 'read' ? { unread_before: out.unread_before } : {}),
        storage: out.file ? { file: out.file, mode: out.mode } : null,
        ledger: 'zero-management' } : refusalInfo }
  }

  /**
   * 对账：注册面会随插件装载/卸载与装配参数变 ⇒ 每次变动都同步一次。
   * 三条不变式：① 与视图无关的贡献只在视图列表变化时重建；② 每个"要协作的视图"必备一块工作台面板；
   * ③ 每个被声明的对象类必备两块对象面板（对象类消失 ⇒ 撤掉）。
   */
  const sync = () => {
    if (onceViews === null || onceViews !== viewList.join(',')) registerOnce()
    const wantedViews = new Set(['home', ...businessViews()])
    for (const view of wantedViews) if (!hubPanels.has(view)) hubPanels.set(view, registerHub(view))
    for (const [view, list] of [...hubPanels.entries()]) {
      if (wantedViews.has(view)) continue
      for (const dispose of list) dispose()
      hubPanels.delete(view)
    }
    const wanted = new Map()
    for (const view of businessViews()) {
      for (const kind of surface.objectKindsFor(view)) wanted.set(`${view}\u0000${kind}`, { view, kind })
    }
    for (const [key, item] of wanted) {
      if (!objectPanels.has(key)) objectPanels.set(key, registerObjectPanels(item.view, item.kind))
    }
    for (const [key, list] of [...objectPanels.entries()]) {
      if (wanted.has(key)) continue
      for (const dispose of list) dispose()
      objectPanels.delete(key)
    }
    return { ok: true, plugin_id: me, views: businessViews(), hubs: hubPanels.size,
      object_panels: objectPanels.size,
      kinds: [...new Set([...objectPanels.keys()].map((key) => key.split('\u0000')[1]))].sort() }
  }

  /** 装配期后补：协作面覆盖哪些视图（= 身份侧的视图）由装配方在身份面建好之后才知道。 */
  const configure = ({ views: nextViews } = {}) => {
    if (Array.isArray(nextViews) && nextViews.length) {
      viewList = nextViews.map(asText).filter((view) => view !== '')
    }
    return sync()
  }

  const dispose = () => {
    for (const disposeOne of onceDisposers) disposeOne()
    onceDisposers = []
    onceViews = null
    for (const list of hubPanels.values()) for (const disposeOne of list) disposeOne()
    hubPanels.clear()
    for (const list of objectPanels.values()) for (const disposeOne of list) disposeOne()
    objectPanels.clear()
  }

  return { sync, configure, dispose, plugin_id: me, viewsOf: () => [...viewList],
    get objectPanels() { return objectPanels.size }, get contributions() { return onceDisposers.length } }
}
