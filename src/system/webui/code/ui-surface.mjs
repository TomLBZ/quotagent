/**
 * ui-surface —— **扩展注册面**（机制，0 业务语义）：插件把自己的功能搬上界面时唯一要打交道的东西。
 *
 * 规则真源：`docs/design/29-webui-gui-app.md` §3（注册面至少这几类：视图/面板/区块、交互、动作与命令、
 * 业务逻辑钩子=动作的**服务端一半**、通知与状态）；用户原话：WebUI 允许插件注册**自身的 UI 元素、交互方式、
 * 业务逻辑**，从而允许实现任意功能，但 webui 自己**不含业务语义**。
 *
 * 本文件只做**机制**，别的什么都不做：
 *   · 它不认识任何插件 id、任何领域名词、任何字段绑定（`webui` 的静态负控逐条扫这一条）；
 *   · 它**零写面**：不读账本、不写文件、不联网、不取墙钟、不用随机数、不注册定时器；
 *   · 它只做四件事：**校验**贡献形状、**登记**（按 kind/plugin/id 去重，重复形状不一致即`拒`）、
 *     **列举**（`snapshot()` 供 `/api/ui/surface`；只回执元数据，不含 render/执行体）、
 *     **可撤销**（每个 contribute* 返回 disposer；`disposePlugin(id)` 一次撤干净 —— `AGENTS.md` 规则 1）。
 *
 * 贡献种类（`kind`）与最小形状：
 *   ① `view`   视图/面板/区块的**容器**：`{plugin_id, id, title, order, view, when?, hint?}`
 *   ② `panel`  一块可渲染数据：`{plugin_id, id, title, view, order, kind, when?, data(ctx)}`；
 *              `data()` 返回**通用形状**（`table` / `form` / `list` / `kv` / `metrics` / `html`），
 *              外壳只按形状渲染，不解读语义；
 *   ③ `action` 动作/命令：`{plugin_id, id, title, views, group?, order?, inline?, icon?,
 *              input:{fields:[{name,label,type,required,min,max,pattern,options,help}]},
 *              permission:'none'|'human-signature', confirm:{required,message}, server(ctx, input)}`
 *              —— `server` 就是**动作的服务端一半**（插件自己的实现；外壳只负责调用与回执）；
 *   ④ `shortcut` 键盘快捷键：`{plugin_id, keys, action, title}`
 *   ⑤ `notification-source` 通知源：`{plugin_id, id, title, order, poll(ctx)}`
 *   ⑥ `status-item` 状态栏项：`{plugin_id, id, title, order, read(ctx)}`
 *   ⑦ `validator` 交互校验：`{plugin_id, id, actions?, validate(input) -> [{field, code, message}]}`
 *
 * 交互类（表单字段与校验、可编辑表格与批量操作、右键菜单、内联动作）都由上面的**声明**拼出来：
 * 字段形状 = `action.input.fields`；表格可编辑/批量 = `panel.data()` 返回的 `editable` / `bulk`；右键菜单 =
 * `action.context_menu=true` 且 `panel.data()` 的行给出 `id`；快捷键 = `shortcut`。**机制不替插件猜业务**。
 *
 * **表格与布局的声明**（`panel.data()` 里，插件只管声明，渲染与键盘都在外壳）：
 *   · 列可带 `editable:true`（可改）、`type`（`text`/`number`/`code`/`json`）、`help`（占位/说明）、
 *     `pin:'left'|'right'`（**固定列**：横向滚动时关键列不跑掉）、`best_when:'min'`（一列里的最小值高亮）、
 *     `group` + `group_label`（**对比模式的列组**：勾 2–3 组并排看，见 `data.compare`）、
 *     `line_total_of:'<同行的另一个字段>'`（该格旁边实时显示"×系数 = 行合计"）；
 *   · `data.totals = [{label, key, factor, unit, skip_empty}]` ⇒ 编辑栏实时算 `Σ key×factor`
 *     （改任意一格立刻重算，不用提交）；`data.compare = {min:2, max:3, hint}` ⇒ 开启对比模式；
 *   · 可编辑表格的键盘：`Tab`/`Shift+Tab` 走格、`Enter`/`↑`/`↓` 走同列上下行、`Esc` 还原这一格、
 *     `Ctrl/⌘+Enter` 提交 —— 备一份多行报价可以只用键盘。
 *   · 面板布局：用户可以拖动面板换顺序、折叠/展开；布局按「视图+对象类」存在浏览器里（刷新后仍在）。
 *
 * 通知源给出的每条通知可以带 `ref = {kind, id[, view, title]}` ⇒ 通知中心里能**一键跳到那个对象**
 * （`view` 省略时按当前视角；外壳只认这种形状，裸 id 会被丢掉 —— 免得出现点不动的"假深链"）。
 *
 * **对象深链**（对象级地址 `/app/<view>/<kind>/<id>`）：机制只提供三件事，对象是什么由插件声明 ——
 *   ① 面板/动作可以声明 `object_kind: '<对象类>'`（如一行 P0 把"某类对象"搬上界面的面板）；
 *   ② `data(ctx)` 的 `ctx.route` 给出当前地址的 `{view, kind, id}` 三元组（没在对象地址上时 `kind/id` 为空串），
 *      面板据此渲染**那一个对象**；面板可选返回 `data.object = {title, subtitle, facts:[{key,value}],
 *      links:[{kind,id,title}], found, reason, next_action}` —— 外壳只按这个通用形状渲染对象页头
 *      （`found:false` ⇒ 外壳渲染**如实未命中态**，不编内容）；
 *   ③ 表格行/列表项可以带 `ref = {kind, id, title}` ⇒ 客户端把该行渲染成**可点、可复制的深链**；
 *      列表项还可以带 `action = '<动作 id>'` + `label` ⇒ 渲染成一键入口（工作台"你现在该做什么"用它）。
 *      行内动作（`row_actions: ['<动作 id>']`）打开时，**行的字段按同名预填该动作的入参**
 *      （动作要 `draft_id`，行就要给 `draft_id` —— 名字对不上就等于让人手抄一遍 id）。
 *   这三条都是**声明**，外壳不认识任何具体 kind；插件卸载后它的对象页与深链一起消失（规则 1）。
 */

/** 面板的通用渲染形状（外壳按 `kind` 选渲染器；不认识的一律 `unknown-panel-kind` 拒收）。 */
export const PANEL_KINDS = ['table', 'form', 'list', 'kv', 'metrics', 'html']

/** 字段类型（客户端渲染器与校验器都只认这些）。 */
export const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'signature', 'hidden']

/** 权限档：`none`（能点就发）/ `human-signature`（必须人签：入参加 `signature=human:<人名>`）。 */
export const PERMISSIONS = ['none', 'human-signature']

/** 动作出现在哪里（placement）：工具栏 / 面板内联 / 命令行 / 右键菜单 / 快捷键。 */
export const PLACEMENTS = ['toolbar', 'inline', 'command', 'context', 'shortcut']

export const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/
export const PLUGIN_ID_RE = /^(system|domain|userspace)\/[a-z][a-z0-9-]{0,31}(\/[a-z][a-z0-9-]{0,31})?$/
/** **对象类**（`object_kind`）的形状：它要进 URL（`/app/<view>/<kind>/<id>`），故限定小写集。 */
export const OBJECT_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
export const ORDER_MIN = -1000
export const ORDER_MAX = 1000
export const TITLE_MAX = 120
export const MAX_FIELDS = 40

/** 拒收/降级原因码（闭合集合：降级一律**有名**，不静默吞）。 */
export const REFUSAL_CODES = ['illegal-plugin-id', 'illegal-contribution-id', 'illegal-kind', 'unknown-view',
  'invalid-title', 'invalid-order', 'invalid-input', 'invalid-permission', 'invalid-confirm', 'invalid-server',
  'invalid-when', 'invalid-data', 'duplicate-contribution', 'unknown-panel-kind', 'unknown-field-type',
  'unknown-action', 'invalid-object-kind', 'surface-disposed']

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const code = (name, reason, next_action) => ({ ok: false, code: name, reason, next_action })
const orderOf = (value) => (Number.isInteger(value) ? value : 0)
const sortKey = (entry) => `${String(entry.order).padStart(6, '0')}\u0000${entry.plugin_id}\u0000${entry.id}`

/**
 * 建一个注册面。
 * @param {{slots?: string[], views?: string[]}} options `views` = 允许的视图 id 集合（外壳从配置给，**不是**业务语义）
 */
export function createUiSurface({ slots = [], views = [] } = {}) {
  const allowedViews = new Set(views)
  const allowedSlots = new Set(slots)
  /** key = `${kind}\u0000${plugin_id}\u0000${id}` */
  const entries = new Map()
  let disposed = false

  const keyOf = (kind, pluginId, id) => `${kind}\u0000${pluginId}\u0000${id}`

  /** 共同部分：插件 id / 贡献 id / 标题 / 顺序。 */
  const checkCommon = (kind, entry) => {
    if (!plainObject(entry)) {
      return code('invalid-input', `${kind} 贡献不是对象`, `contribute ${kind} 时给 {plugin_id, id, title, …}`)
    }
    const pluginId = text(entry.plugin_id)
    if (!PLUGIN_ID_RE.test(pluginId)) {
      return code('illegal-plugin-id', `${kind}.plugin_id 形状不合法：${JSON.stringify(entry.plugin_id)}`,
        '写 `层次/插件`（system|domain|userspace）')
    }
    const id = text(entry.id)
    if (!ID_RE.test(id)) {
      return code('illegal-contribution-id', `${kind}.id 形状不合法：${JSON.stringify(entry.id)}`,
        '贡献 id 写 `<域>.<动作>`（小写字母/数字/点/连字符，且至少一个点），它要能出现在 URL 与命令里')
    }
    if (typeof entry.title !== 'string' || entry.title.trim() === '' || entry.title.length > TITLE_MAX) {
      return code('invalid-title', `${kind}.title 必须是非空字符串且 ≤ ${TITLE_MAX} 字符`,
        '给一句人话标题（它是界面上唯一的"这是谁的什么"线索）')
    }
    if (entry.order !== undefined && (!Number.isInteger(entry.order)
      || entry.order < ORDER_MIN || entry.order > ORDER_MAX)) {
      return code('invalid-order', `${kind}.order 必须是 [${ORDER_MIN}, ${ORDER_MAX}] 内的整数`,
        '给整数 order（越小越靠前；同 order 按 plugin_id 字典序）')
    }
    if (entry.view !== undefined && !allowedViews.has(text(entry.view))) {
      return code('unknown-view', `${kind}.view 不在允许集合里：${JSON.stringify(entry.view)}`,
        `用配置里已声明的视图之一（当前：${views.join(' / ') || '（无）'}）`)
    }
    return null
  }

  /** 登记入口（所有 contribute* 都走它；形状不一致的同键 ⇒ 拒，不悄悄覆盖）。 */
  const add = (kind, raw, normalize) => {
    if (disposed) {
      return code('surface-disposed', '注册面已释放', '重新挂载宿主后再注册（dispose 之后注册一律拒）')
    }
    const bad = checkCommon(kind, raw)
    if (bad) return bad
    const normalized = normalize(raw)
    if (normalized.error) return normalized.error
    const entry = normalized.entry
    const key = keyOf(kind, entry.plugin_id, entry.id)
    const existing = entries.get(key)
    if (existing) {
      const same = JSON.stringify(snapshotOf(existing)) === JSON.stringify(snapshotOf(entry))
      if (same) {
        return { ok: true, code: 'already-registered', key, kind, id: entry.id, plugin_id: entry.plugin_id,
          dispose: () => entries.delete(key) }
      }
      return code('duplicate-contribution', `同一 (kind, plugin_id, id) 已用不同形状注册过：${kind} ${entry.id}`,
        '要么复用同一份注册，要么先 dispose 旧的再注册（不许悄悄覆盖）')
    }
    entries.set(key, entry)
    return { ok: true, code: 'registered', key, kind, id: entry.id, plugin_id: entry.plugin_id,
      dispose: () => entries.delete(key) }
  }

  /** 视图容器：一个视图下可以有多块面板（面板自己声明 `view` 归属）。 */
  const view = (raw) => add('view', raw, (entry) => {
    if (!plainObject(entry) || text(entry.view) === '') {
      return { error: code('unknown-view', 'view 贡献必须声明 view（挂到哪个视图下）',
        '给 `view: "<视图 id>"`（取自配置 views）') }
    }
    return { entry: { kind: 'view', plugin_id: text(entry.plugin_id), id: text(entry.id),
      title: entry.title, order: orderOf(entry.order), view: text(entry.view),
      hint: text(entry.hint), when: typeof entry.when === 'function' ? entry.when : null } }
  })

  /** 面板：一块**可渲染数据**（通用形状由 `data()` 给，外壳只按形状渲染）。 */
  const panel = (raw) => add('panel', raw, (entry) => {
    if (!plainObject(entry) || text(entry.view) === '') {
      return { error: code('unknown-view', 'panel 贡献必须声明 view', '给 `view: "<视图 id>"`') }
    }
    if (!PANEL_KINDS.includes(text(entry.kind))) {
      return { error: code('unknown-panel-kind', `panel.kind 不在闭合集合里：${JSON.stringify(entry.kind)}`,
        `用 ${PANEL_KINDS.join(' / ')} 之一`) }
    }
    if (typeof entry.data !== 'function') {
      return { error: code('invalid-data', 'panel.data 必须是函数（返回通用渲染形状）',
        'data: (ctx) => ({ok:true, kind:"table", columns:[…], rows:[…]})') }
    }
    if (entry.when !== undefined && typeof entry.when !== 'function') {
      return { error: code('invalid-when', 'panel.when 必须是函数（可见性条件）', 'when: (ctx) => boolean') }
    }
    const objectKind = text(entry.object_kind)
    if (objectKind !== '' && !OBJECT_KIND_RE.test(objectKind)) {
      return { error: code('invalid-object-kind', `panel.object_kind 形状不合法：${JSON.stringify(entry.object_kind)}`,
        '对象类写小写字母/数字/连字符（例如某类业务对象），它要能出现在 URL /app/<view>/<kind>/<id> 里') }
    }
    return { entry: { kind: 'panel', plugin_id: text(entry.plugin_id), id: text(entry.id), title: entry.title,
      order: orderOf(entry.order), view: text(entry.view), panel_kind: text(entry.kind),
      placement: text(entry.placement) || 'main', data: entry.data,
      when: typeof entry.when === 'function' ? entry.when : null, object_kind: objectKind,
      hint: text(entry.hint), actions: Array.isArray(entry.actions) ? entry.actions.map(text) : [] } }
  })

  /** 动作/命令：**含服务端一半**（`server`），权限与确认策略都是声明。 */
  const action = (raw) => add('action', raw, (entry) => {
    if (!plainObject(entry) || typeof entry.server !== 'function') {
      return { error: code('invalid-server', 'action.server 必须是函数（动作的服务端一半）',
        'server: (ctx, input) => ({ok, code, reason, next_action, result})') }
    }
    const viewsOf = Array.isArray(entry.views) && entry.views.length > 0 ? entry.views.map(text)
      : (text(entry.view) !== '' ? [text(entry.view)] : [])
    if (viewsOf.length === 0) {
      return { error: code('unknown-view', 'action 必须声明 views（出现在哪些视图/命令行里）',
        '给 `views: ["contractor"]`（命令行里出现的动作可给空数组）') }
    }
    for (const item of viewsOf) {
      if (!allowedViews.has(item)) {
        return { error: code('unknown-view', `action.views 里有不在允许集合里的视图：${item}`,
          `用 ${views.join(' / ')} 之一`) }
      }
    }
    const fields = Array.isArray(entry.input?.fields) ? entry.input.fields : []
    if (fields.length > MAX_FIELDS) {
      return { error: code('invalid-input', `动作入参字段 ${fields.length} 个超过上限 ${MAX_FIELDS}`,
        '把动作拆小（一个动作一件事）') }
    }
    const outFields = []
    for (const field of fields) {
      if (!plainObject(field) || text(field.name) === '') {
        return { error: code('invalid-input', '入参字段必须有 name', '给 `{name, label, type}`') }
      }
      const type = text(field.type) || 'text'
      if (!FIELD_TYPES.includes(type)) {
        return { error: code('unknown-field-type', `字段 ${field.name} 的类型不在闭合集合里：${type}`,
          `用 ${FIELD_TYPES.join(' / ')} 之一`) }
      }
      outFields.push({ name: text(field.name), label: text(field.label) || text(field.name), type,
        required: field.required === true, min: field.min ?? null, max: field.max ?? null,
        pattern: text(field.pattern) || null, options: Array.isArray(field.options) ? field.options.map(text) : [],
        help: text(field.help), default: field.default ?? null,
        // `from_route: true` = 这个字段由**当前对象地址**的 id 预填（插件声明"它就是那个对象的 id"）：
        // 于是 `/app/<view>/<kind>/<id>/` 对象页工具栏上的动作可以一键打开，不用手抄 id。
        from_route: field.from_route === true,
        // `from_route_kind: true` = 这个字段由**当前对象地址的对象类**（`route.kind`）预填；与 `from_route`
        // 配对使用 ⇒ 一份**视图级动作**（不带 `object_kind`）对任何对象类都成立：对象类由插件声明，
        // 声明 `from_route`/`from_route_kind` 字段的动作在对象页上也进主工具栏（客户端按这条声明摆位）。
        from_route_kind: field.from_route_kind === true,
        // `identity: true` = 这个字段由**当前会话身份**预填（`human:<名字>`；机制只知道"会话里是谁"，
        // 不知道这个字段在业务上叫什么）。人签动作的 `signature` 字段自动按这条处理。
        identity: field.identity === true,
        // `suggest_url` = 这个字段的值可以从**服务端一个只读建议列表**里取（自动补全；客户端渲染成
        // `<datalist>`，键盘上下选，也可以照旧手敲）。`mention_suggest_url` = 同样给一份建议列表，
        // 但用于**长文本里 @ 人**：在正文里打 `@` 就弹这批候选，选一个就插进去。
        // 机制只认形状（本服务前缀相对路径，`/` 开头），**不认识任何建议内容的语义**（谁来提供由插件/机制自己定）。
        suggest_url: text(field.suggest_url),
        mention_suggest_url: text(field.mention_suggest_url) })
    }
    // 自动补全的建议列表地址只允许**本服务前缀相对路径**（`/` 开头）：脚本与数据都只来自本服务
    // （与"脚本只来自 /assets/**"同一口径；外站地址一律拒，免得界面被引去第三方取候选人名单）。
    for (const field of outFields) {
      for (const key of ['suggest_url', 'mention_suggest_url']) {
        if (field[key] !== '' && !field[key].startsWith('/')) {
          return { error: code('invalid-input', `字段 ${field.name} 的 ${key} 必须是本服务前缀相对路径：${JSON.stringify(field[key])}`,
            `写 \`${key}: "/api/…"\`（本服务自己的只读建议接口；界面不访问第三方取候选）`) }
        }
      }
    }
    const permission = text(entry.permission) || 'none'
    if (!PERMISSIONS.includes(permission)) {
      return { error: code('invalid-permission', `permission 不在闭合集合里：${permission}`,
        `用 ${PERMISSIONS.join(' / ')} 之一（人签动作写 human-signature）`) }
    }
    const confirm = plainObject(entry.confirm)
      ? { required: entry.confirm.required !== false, message: text(entry.confirm.message) || '确认执行这个动作？' }
      : { required: false, message: '' }
    if (entry.confirm !== undefined && !plainObject(entry.confirm)) {
      return { error: code('invalid-confirm', 'confirm 必须是对象（{required, message}）',
        'confirm: {required: true, message: "…"}') }
    }
    const placement = Array.isArray(entry.placement) && entry.placement.length > 0
      ? entry.placement.map(text) : ['toolbar']
    for (const item of placement) {
      if (!PLACEMENTS.includes(item)) {
        return { error: code('invalid-input', `placement 里有不认识的位置：${item}`,
          `用 ${PLACEMENTS.join(' / ')} 之一`) }
      }
    }
    if (permission === 'human-signature' && !outFields.some((field) => field.name === 'signature')) {
      return { error: code('invalid-input', 'human-signature 动作必须声明 signature 字段（人签的入口）',
        '在 input.fields 里加 {name:"signature", label:"署名", type:"signature", required:true}') }
    }
    const objectKind = text(entry.object_kind)
    if (objectKind !== '' && !OBJECT_KIND_RE.test(objectKind)) {
      return { error: code('invalid-object-kind', `action.object_kind 形状不合法：${JSON.stringify(entry.object_kind)}`,
        '对象类写小写字母/数字/连字符；声明后该动作会出现在 `/app/<view>/<kind>/<id>` 对象页的工具栏上') }
    }
    return { entry: { kind: 'action', plugin_id: text(entry.plugin_id), id: text(entry.id), title: entry.title,
      order: orderOf(entry.order), views: viewsOf, view: viewsOf[0] ?? '', group: text(entry.group) || '通用',
      icon: text(entry.icon), placement, inline: entry.inline === true,
      context_menu: entry.context_menu === true, object_kind: objectKind,
      shortcut: text(entry.shortcut) || null,
      input: { fields: outFields, bulk: text(entry.input?.bulk) || null },
      permission, confirm, server: entry.server, hint: text(entry.hint),
      panel: text(entry.panel) || null } }
  })

  /** 快捷键：`{plugin_id, keys, action, title}`（`keys` 形如 `g c` / `mod+k` / `p`）。 */
  const shortcut = (raw) => add('shortcut', raw, (entry) => {
    const keys = text(entry.keys)
    if (!/^[a-z0-9+ ]{1,16}$/.test(keys)) {
      return { error: code('invalid-input', `shortcut.keys 形状不合法：${JSON.stringify(entry.keys)}`,
        '写 `g c`（组合键用空格）、`mod+k`、`p` 这类形式（小写字母/数字/+）') }
    }
    if (!ID_RE.test(text(entry.action))) {
      return { error: code('unknown-action', `shortcut.action 必须是动作 id：${JSON.stringify(entry.action)}`,
        '给已注册动作的 id（快捷键只是它的入口）') }
    }
    return { entry: { kind: 'shortcut', plugin_id: text(entry.plugin_id),
      id: text(entry.id) || `shortcut.${keys.replace(/[^a-z0-9]+/g, '-')}`, title: entry.title,
      order: orderOf(entry.order), keys, action: text(entry.action) } }
  })

  /** 通知源：`poll(ctx)` 返回 `[{id, level, title, body, next_action, at, ref}]`（外壳只排队展示）。 */
  const notificationSource = (raw) => add('notification-source', raw, (entry) => {
    if (typeof entry.poll !== 'function') {
      return { error: code('invalid-data', 'notification-source.poll 必须是函数',
        'poll: (ctx) => [{id, level, title, next_action}]') }
    }
    return { entry: { kind: 'notification-source', plugin_id: text(entry.plugin_id), id: text(entry.id),
      title: entry.title, order: orderOf(entry.order), poll: entry.poll, hint: text(entry.hint) } }
  })

  /** 状态栏项：`read(ctx)` 返回 `{text, level, next_action}`。 */
  const statusItem = (raw) => add('status-item', raw, (entry) => {
    if (typeof entry.read !== 'function') {
      return { error: code('invalid-data', 'status-item.read 必须是函数', 'read: (ctx) => ({text, level})') }
    }
    return { entry: { kind: 'status-item', plugin_id: text(entry.plugin_id), id: text(entry.id),
      title: entry.title, order: orderOf(entry.order), read: entry.read } }
  })

  /** 交互校验：插件可以给动作入参追加**跨字段**规则（字段级规则已经在 `input.fields` 里）。 */
  const validator = (raw) => add('validator', raw, (entry) => {
    if (typeof entry.validate !== 'function') {
      return { error: code('invalid-data', 'validator.validate 必须是函数',
        'validate: (input) => [{field, code, message}]') }
    }
    const actions = Array.isArray(entry.actions) ? entry.actions.map((item) => text(item))
      : (text(entry.action) ? [text(entry.action)] : [])
    return { entry: { kind: 'validator', plugin_id: text(entry.plugin_id), id: text(entry.id),
      title: entry.title, order: orderOf(entry.order), actions, validate: entry.validate } }
  })

  const byKind = (kind) => [...entries.values()].filter((item) => item.kind === kind).sort((left, right) =>
    (sortKey(left) < sortKey(right) ? -1 : (sortKey(left) > sortKey(right) ? 1 : 0)))

  const findAction = (id) => byKind('action').find((item) => item.id === id) ?? null
  const panelsOf = (viewId) => byKind('panel').filter((item) => item.view === viewId)
  const shortcuts = () => byKind('shortcut')
  const validatorsFor = (actionId) => byKind('validator')
    .filter((item) => item.actions.length === 0 || item.actions.includes(actionId))

  // ---- 对象深链（**机制**）：哪些对象类被声明过 / 某个对象类是谁在负责 / 某个视图的对象页动作 ----
  /** 本视图里被声明过的对象类（去重、字典序）：`/app/<view>/<kind>/<id>` 能打开哪些 kind 由它决定。 */
  const objectKindsFor = (viewId) => [...new Set(byKind('panel').filter((item) => item.view === viewId
    && item.object_kind !== '').map((item) => item.object_kind))].sort()
  /** 某个视图里服务某个对象类的面板（对象页只渲染这些；没声明过 ⇒ 空数组，调用方据此报未命中）。 */
  const panelsFor = (viewId, objectKind) => byKind('panel').filter((item) => item.view === viewId
    && (objectKind ? item.object_kind === objectKind : item.object_kind === ''))
  /** 某个视图里作用于某个对象类的动作（对象页工具栏用它；`objectKind` 为空 ⇒ 视图级动作）。 */
  const actionsFor = (viewId, objectKind) => byKind('action').filter((item) => item.views.includes(viewId)
    && item.object_kind === (objectKind ?? ''))

  /** 只回执**元数据**（不含 data/server/poll/read/validate —— 那些是插件自己的实现，不出现接口里）。 */
  const snapshotOf = (entry) => {
    const base = { kind: entry.kind, plugin_id: entry.plugin_id, id: entry.id, title: entry.title,
      order: entry.order }
    if (entry.kind === 'view') return { ...base, view: entry.view, hint: entry.hint, when: Boolean(entry.when) }
    if (entry.kind === 'panel') return { ...base, view: entry.view, panel_kind: entry.panel_kind,
      placement: entry.placement, actions: entry.actions, hint: entry.hint, when: Boolean(entry.when),
      object_kind: entry.object_kind }
    if (entry.kind === 'action') return { ...base, views: entry.views, group: entry.group, icon: entry.icon,
      placement: entry.placement, inline: entry.inline, context_menu: entry.context_menu,
      shortcut: entry.shortcut, input: entry.input, permission: entry.permission, confirm: entry.confirm,
      hint: entry.hint, panel: entry.panel, object_kind: entry.object_kind }
    if (entry.kind === 'shortcut') return { ...base, keys: entry.keys, action: entry.action }
    if (entry.kind === 'notification-source') return { ...base, hint: entry.hint }
    if (entry.kind === 'status-item') return { ...base }
    if (entry.kind === 'validator') return { ...base, actions: entry.actions }
    return base
  }

  /** 注册面自述：`plugins[]` 按 plugin_id 分组（**卸载演示与审计**都靠它：谁贡献了什么，可逐条对照）。 */
  const snapshot = () => {
    const plugins = {}
    for (const entry of entries.values()) {
      plugins[entry.plugin_id] = plugins[entry.plugin_id] ?? []
      plugins[entry.plugin_id].push({ kind: entry.kind, id: entry.id, title: entry.title })
    }
    return {
      version: 1,
      slots: [...allowedSlots],
      views: [...allowedViews],
      counts: { total: entries.size, by_kind: Object.fromEntries(
        ['view', 'panel', 'action', 'shortcut', 'notification-source', 'status-item', 'validator']
          .map((kind) => [kind, byKind(kind).length])) },
      plugins: Object.entries(plugins).sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([plugin_id, contributions]) => ({ plugin_id, contributions })),
      entries: [...entries.values()].map(snapshotOf).sort((left, right) =>
        (sortKey(left) < sortKey(right) ? -1 : (sortKey(left) > sortKey(right) ? 1 : 0))),
    }
  }

  /** 撤销一个插件的**全部**贡献（卸载路径用它）：返回被撤掉的东西，界面上它们随之消失。 */
  const disposePlugin = (pluginId) => {
    const removed = []
    for (const [key, entry] of [...entries.entries()]) {
      if (entry.plugin_id !== pluginId) continue
      removed.push({ kind: entry.kind, id: entry.id, title: entry.title })
      entries.delete(key)
    }
    return { ok: true, plugin_id: pluginId, removed, count: removed.length }
  }

  const dispose = () => { disposed = true; entries.clear() }

  return { view, panel, action, shortcut, notificationSource, statusItem, validator,
    findAction, panelsOf, panelsFor, actionsFor, objectKindsFor, shortcuts, validatorsFor, byKind, snapshot,
    disposePlugin, dispose, get entries() { return [...entries.values()] }, get size() { return entries.size },
    get disposed() { return disposed } }
}
