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
 *              `list` 形状的条目可以带 **`dedupe_key`**（不透明串，如 `gate:ap-…`）：同一个键被**两块不同面板**
 *              各列一次时，外壳合并成一条（先出现的赢，级别取更急的一档，`ref`/`action` 缺的补上 ⇒ 合并后仍能
 *              点进对象页；`merged_count`/`also_from` 如实写清还有哪块面板也列了它）。判据**完全由插件给**，
 *              外壳只比较字符串；同一块面板内部的重复不动。为什么要这条：同一批人工门被两块面板各列一遍，会让
 *              「有 N 件需要你处理」的计数翻倍（口径见 `app-shell.mjs#foldPanelDuplicates` 与
 *              `docs/scale-and-performance.md`）；
 *   ③ `action` 动作/命令：`{plugin_id, id, title, views, group?, order?, inline?, icon?,
 *              input:{fields:[{name,label,type,required,min,max,pattern,options,help}]},
 *              permission:'none'|'human-signature', confirm:{required,message}, server(ctx, input)}`
 *              —— `server` 就是**动作的服务端一半**（插件自己的实现；外壳只负责调用与回执）；
 *              可选 `concurrency`（**乐观并发**声明：这个动作保存的是哪一个「可编辑对象」，
 *              以及这次保存后那个对象的新状态长什么样）—— 形状见 `CONCURRENCY` 段落；
 *   ④ `shortcut` 键盘快捷键：`{plugin_id, keys, action, title}`
 *   ⑤ `notification-source` 通知源：`{plugin_id, id, title, order, poll(ctx)}`
 *   ⑥ `status-item` 状态栏项：`{plugin_id, id, title, order, read(ctx)}`
 *   ⑦ `validator` 交互校验：`{plugin_id, id, actions?, validate(input) -> [{field, code, message}]}`
 *   ⑧ `report`   导出/打印声明：`{plugin_id, id, title, views, object_kind?, formats:['csv'|'html'|…], action,
 *              columns?:[{key,label}], order?, hint?}` —— 只声明"这个对象/这个视图能以哪几种可读格式导出"
 *              **以及这份导出有哪些列**；**内容由 `action`（插件自己的服务端一半）生成**，外壳既不懂语义
 *              也不生成内容（谁的事实谁导出）。`columns` 只是**元数据**：界面拿它做「列选择」
 *              （个人偏好按身份落 0600，跨浏览器仍在；口径见 `app-shell.mjs` 的导出偏好段）。
 *
 * **乐观并发（可编辑对象的版本/指纹）** —— 声明在外壳、判据在服务端，插件只说"这是什么对象、写进去的是什么"：
 *
 *   · `action.concurrency = {object_class, label, id_field | object_id, state(ctx, input)}`：
 *       - `object_class` = 对象类（形状同 `OBJECT_KIND_RE`）；`label` = 人话（界面上怎么说这个对象）；
 *       - 对象 id：`id_field`（入参里指这个对象 id 的字段名）**或** `object_id(ctx, input)`（插件自己算，
 *         例如"我方对这份包的报价草稿"就是 `包#行项目集合`）；两者必须给一个；
 *       - `state(ctx, input)` = **这次保存后对象的权威新状态**（扁平的 字段 → 标量：由插件从它自己的
 *         事实/入参给出）。外壳对它取指纹（sha256）并逐字段算差异 —— 外壳不知道字段是什么意思。
 *   · 外壳自动往这个动作的入参里加一个 `expected_version` 字段（**只读**，界面按你打开这一页时看到的
 *     版本自动带上）。保存时两端比对：
 *       - 对得上 / 这个对象还没有版本记录 ⇒ 照常执行，并把新版本记下来（rev+1）；
 *       - 对不上 ⇒ **明确拒绝**（`object-changed`），回执里给出"谁在何时改了什么"
 *         （`result.conflict.since` = 自你那一版以来的逐字段改动，`result.conflict.mine` = 你这次要写的
 *         值 vs 现在的值）——**绝不后写覆盖前写**，也不静默吞掉；
 *       - 没带上版本（空）时用**安全默认**：这次要写的内容与现在**一样** ⇒ 放行（本来就没改）；
 *         与现在不一样 ⇒ 同样按冲突拒（"没看过就改"不算读过了）。
 *   · 面板把**你看到的那一版**交给界面：`panel.data()` 可以带 `version`（对象级）与
 *     `version_for: '<动作 id>'`（这一版是给哪个动作用的）；行可以带 `version`（行级，行内动作/批量用它）。
 *     版本形状 = `{rev, fingerprint, at, by, label}`（`host.versions.current(side, cls, id)` 给的就是它）。
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

/** 面板的通用渲染形状（外壳按 `kind` 选渲染器；不认识的一律 `unknown-panel-kind` 拒收）。
 *
 *  `files` = **一份文件集合**（附件面）：插件声明"这个对象挂着一批文件"，外壳只知道"文件列表 + 拖拽上传区
 *  + 每个文件的下载/删除入口"。文件是什么、给谁看、谁能删，全由插件声明（本文件不懂任何业务）。
 *  形状（`data()` 返回）：
 *    `{kind:'files', files:[{id, name, bytes, sha256, uploader, at, content_type, visibility, deleted,
 *      url(下载地址，本服务相对路径), deletable?:bool, note?}], upload:{url, label?, multiple?:true,
 *      max_bytes, accept?, help?}, empty_text?, reason?(降级用), next_action?, counts?:{}, object?:{kind,id}}`
 *  —— `url` 与 `upload.url` 必须是**本服务前缀相对路径**（`/` 开头；外站一律拒，与 `suggest_url` 同一纪律）。 */
export const PANEL_KINDS = ['table', 'form', 'list', 'kv', 'metrics', 'html', 'files']

/** 可导出的可读格式（`report.formats` 的闭合集合；外壳按它渲染「导出 / 打印」按钮）。 */
export const REPORT_FORMATS = ['csv', 'html', 'txt', 'json']

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
/** 乐观并发声明的上限（`concurrency.label` 是界面上唯一一句"这是什么对象"）。 */
export const CONCURRENCY_LABEL_MAX = 80
/** 导出列声明的上限（`report.columns`；与外壳序列化的列上限同一口径）。 */
export const MAX_REPORT_COLUMNS = 40

/** 拒收/降级原因码（闭合集合：降级一律**有名**，不静默吞）。 */
export const REFUSAL_CODES = ['illegal-plugin-id', 'illegal-contribution-id', 'illegal-kind', 'unknown-view',
  'invalid-title', 'invalid-order', 'invalid-input', 'invalid-permission', 'invalid-confirm', 'invalid-server',
  'invalid-when', 'invalid-data', 'duplicate-contribution', 'unknown-panel-kind', 'unknown-field-type',
  'unknown-action', 'invalid-object-kind', 'surface-disposed', 'invalid-concurrency', 'invalid-columns']

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
        mention_suggest_url: text(field.mention_suggest_url),
        // `readonly: true` = 这个字段是**机制/插件自己带上的值**，人不必也不该手抄（例如乐观并发的
        // `expected_version`）：界面渲染成只读，但仍**真实随请求发出**（它是要拿去比较的那一版）。
        readonly: field.readonly === true,
        // `version_field: true` = 这个字段装的是"你打开这一页时看到的**对象版本**"：界面按
        // 面板/行/对象页声明的 `version` 自动填上（口径见文件头的「乐观并发」段）。
        version_field: field.version_field === true })
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
    // ---- **乐观并发**（机制）：插件声明"这个动作保存的是哪个可编辑对象、写进去的是什么状态" ----------
    // 外壳据此在保存前比对版本、在冲突时**明确拒绝**并给出差异（口径见文件头「乐观并发」段）。
    let concurrency = null
    if (entry.concurrency !== undefined) {
      const raw = entry.concurrency
      if (!plainObject(raw)) {
        return { error: code('invalid-concurrency', 'concurrency 必须是对象',
          '{concurrency: {object_class, label, id_field|object_id, state(ctx, input)}}') }
      }
      const objectClass = text(raw.object_class)
      if (!OBJECT_KIND_RE.test(objectClass)) {
        return { error: code('invalid-concurrency',
          `concurrency.object_class 形状不合法：${JSON.stringify(raw.object_class)}`,
          '写小写字母/数字/连字符的对象类（界面上的"这是什么对象"与拒绝原因都用它）') }
      }
      const label = text(raw.label)
      if (label === '' || label.length > CONCURRENCY_LABEL_MAX) {
        return { error: code('invalid-concurrency', `concurrency.label 必须是人话且 ≤ ${CONCURRENCY_LABEL_MAX} 字符`,
          '给一句"这个对象在业务上叫什么"（例：我方对这份包的报价草稿）') }
      }
      if (typeof raw.state !== 'function') {
        return { error: code('invalid-concurrency', 'concurrency.state 必须是函数（这次保存后的对象新状态）',
          'state: (ctx, input) => ({字段: 值}) —— 扁平标量，外壳只取指纹与逐字段差异') }
      }
      const idField = text(raw.id_field)
      if (idField !== '' && !outFields.some((field) => field.name === idField)) {
        return { error: code('invalid-concurrency', `concurrency.id_field 不在入参字段里：${idField}`,
          'id_field 要写这个动作入参里"指对象 id"的那个字段名（或改用 object_id(ctx, input) 自己算）') }
      }
      if (idField === '' && typeof raw.object_id !== 'function') {
        return { error: code('invalid-concurrency', 'concurrency 必须给 id_field 或 object_id（二选一）',
          'id_field: "<入参里的 id 字段>" 或 object_id: (ctx, input) => "<对象 id>"') }
      }
      const expectedField = text(raw.expected_field) || 'expected_version'
      if (!outFields.some((field) => field.name === expectedField)) {
        // 外壳**自动**给这个动作加一个只读的版本字段：界面按你打开这一页时看到的版本带上它。
        outFields.push({ name: expectedField, label: '版本（你打开这一页时看到的）', type: 'text',
          required: false, min: null, max: null, pattern: null, options: [], readonly: true,
          version_field: true, identity: false, from_route: false, from_route_kind: false,
          suggest_url: '', mention_suggest_url: '',
          help: '界面自动带上你看到的那一版；留空 = 你没看过任何版本（服务端按安全默认判：'
            + '会覆盖别人的改动就拒，内容没变就放行）' })
      }
      concurrency = { object_class: objectClass, label, id_field: idField,
        object_id: typeof raw.object_id === 'function' ? raw.object_id : null,
        expected_field: expectedField, state: raw.state }
    }
    return { entry: { kind: 'action', plugin_id: text(entry.plugin_id), id: text(entry.id), title: entry.title,
      order: orderOf(entry.order), views: viewsOf, view: viewsOf[0] ?? '', group: text(entry.group) || '通用',
      icon: text(entry.icon), placement, inline: entry.inline === true,
      context_menu: entry.context_menu === true, object_kind: objectKind,
      shortcut: text(entry.shortcut) || null,
      input: { fields: outFields, bulk: text(entry.input?.bulk) || null },
      permission, confirm, server: entry.server, hint: text(entry.hint),
      panel: text(entry.panel) || null, concurrency } }
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

  /**
   * **导出 / 打印声明**（`kind: 'report'`）：插件声明"这个对象（或这个视图）能以哪几种**可读格式**导出"。
   *
   * 形状：`{plugin_id, id, title, views:[…], object_kind?, formats:['csv'|'html'|…], action, columns?, order?, hint?}`
   *   · `formats` = 声明的格式（闭合集合 `REPORT_FORMATS`）；每个格式在界面上是一个按钮；
   *   · `action`   = **真干活的那个动作 id**（导出内容由插件自己的服务端一半生成：谁的事实谁导出，
   *     外壳不解读语义、也不生成任何内容）；打开时外壳把 `format` 预填进该动作的入参；
   *   · `columns`  = **这份导出有哪些列**（`[{key,label}]`，≤ 40）。它只是**元数据**：界面拿它出
   *     「列选择」（列选择是**个人偏好**，按会话身份落 0600 —— 换浏览器/换设备仍在；
   *     口径见 `app-shell.mjs` 的导出偏好段）。留空 ⇒ 这份导出不支持列选择（照样能导出）。
   *   · `object_kind` 非空 ⇒ 它出现在 `/app/<view>/<kind>/<id>/` **对象页**的「导出 / 打印」区；
   *     留空 ⇒ 视图级导出（例如整张比价表）。
   *
   * 机制只做四件事：校验形状、登记、列举（`snapshot()`/`reportsFor()`）、可撤销（disposer）。
   * 它**不生成任何内容**、不留文件、不读账本 —— 导出内容的唯一来源是插件自己的动作。
   */
  const report = (raw) => add('report', raw, (entry) => {
    if (!plainObject(entry)) {
      return { error: code('invalid-input', 'report 贡献不是对象', 'report({plugin_id, id, title, formats, action})') }
    }
    const viewsOf = Array.isArray(entry.views) && entry.views.length > 0 ? entry.views.map(text)
      : (text(entry.view) !== '' ? [text(entry.view)] : [])
    if (viewsOf.length === 0) {
      return { error: code('unknown-view', 'report 必须声明 views（在哪些视图里出现）',
        '给 `views: ["contractor"]`') }
    }
    for (const item of viewsOf) {
      if (!allowedViews.has(item)) {
        return { error: code('unknown-view', `report.views 里有不在允许集合里的视图：${item}`,
          `用 ${views.join(' / ')} 之一`) }
      }
    }
    const formats = Array.isArray(entry.formats) ? entry.formats.map(text).filter((item) => item !== '') : []
    if (formats.length === 0) {
      return { error: code('invalid-input', 'report.formats 必须给至少一种格式',
        `用 ${REPORT_FORMATS.join(' / ')} 之一（例如 formats: ["csv","html"]）`) }
    }
    for (const format of formats) {
      if (!REPORT_FORMATS.includes(format)) {
        return { error: code('invalid-input', `report.formats 里有不认识的格式：${format}`,
          `用 ${REPORT_FORMATS.join(' / ')} 之一`) }
      }
    }
    if (!ID_RE.test(text(entry.action))) {
      return { error: code('unknown-action', `report.action 必须是动作 id：${JSON.stringify(entry.action)}`,
        '给已注册动作的 id（导出内容由那个动作的服务端一半生成：谁的事实谁导出）') }
    }
    const objectKind = text(entry.object_kind)
    if (objectKind !== '' && !OBJECT_KIND_RE.test(objectKind)) {
      return { error: code('invalid-object-kind', `report.object_kind 形状不合法：${JSON.stringify(entry.object_kind)}`,
        '对象类写小写字母/数字/连字符；留空 = 视图级导出') }
    }
    // `columns`：这份导出有哪些列（**元数据**，供界面做列选择；内容仍由 action 自己生成）。
    const columns = []
    for (const column of (Array.isArray(entry.columns) ? entry.columns : [])) {
      if (!plainObject(column) || text(column.key) === '') {
        return { error: code('invalid-columns', `report.columns 每一项都要有 key：${JSON.stringify(column ?? null)}`,
          'columns: [{key:"<行里的字段名>", label:"<列名（人话）>"}]') }
      }
      if (columns.some((known) => known.key === text(column.key))) {
        return { error: code('invalid-columns', `report.columns 里 key 重复：${text(column.key)}`,
          '一列一个 key（重复的列在导出的表头里会撞在一起）') }
      }
      columns.push({ key: text(column.key), label: text(column.label) || text(column.key) })
    }
    if (columns.length > MAX_REPORT_COLUMNS) {
      return { error: code('invalid-columns', `report.columns 有 ${columns.length} 列，超过上限 ${MAX_REPORT_COLUMNS}`,
        '把列收敛到人真的会看的那些（导出是给人看的台账）') }
    }
    return { entry: { kind: 'report', plugin_id: text(entry.plugin_id), id: text(entry.id), title: entry.title,
      order: orderOf(entry.order), views: viewsOf, view: viewsOf[0] ?? '', formats, action: text(entry.action),
      columns, object_kind: objectKind, hint: text(entry.hint) } }
  })

  /**
   * ⑨ `scenario` —— **沙盘/演示场景的步骤声明**（机制；外壳不认识任何业务）。
   *
   * 形状：`{plugin_id, id, scenario, scenario_title, title, view?, order, steps:[{action, input?, as?}], hint?}`
   *   · `scenario` 是**场景分组键**（ID_RE）：多个插件各自贡献**自己那一段**步骤，外壳按 `order` 把它们
   *     串成一条流程（谁的业务谁声明，外壳不替任何插件排序业务）；
   *   · `steps[].action` 必须是已注册动作的 id（运行时由外壳 dispatch 到**同一个动作总线**）；
   *   · `steps[].as = {human, side}` 声明这一步由**哪个演示身份**发起（沙盘里才有意义：沙盘账本不是合同
   *     事实，演示身份由机制生成并固定，不是请求可以随便给的）；
   *   · 入参里的字符串可以写 `$last.<点分路径>`（含数组下标）⇒ 取**上一步回执** `result` 里的值
   *     （例如上一步给出 `quote_id`，下一步用它）—— 机制只做取值，不认识字段含义。
   *
   * 它**不生成任何数据**：数据由 `action` 的服务端一半按既有写路径产生（沙盘只是把路径换成沙盘路径）。
   */
  const scenario = (entry) => add('scenario', entry, (raw) => {
    const scenarioId = text(raw.scenario)
    if (!ID_RE.test(scenarioId)) {
      return { error: code('illegal-scenario-id', `scenario.scenario 形状不合法：${JSON.stringify(raw.scenario)}`,
        '写场景分组键（`<域>.<名字>`，同一场景的多个插件用同一个键）') }
    }
    const steps = Array.isArray(raw.steps) ? raw.steps : null
    if (!steps || steps.length === 0 || steps.length > 40) {
      return { error: code('invalid-steps', 'scenario.steps 必须是 1..40 个步骤的数组',
        '每步 `{action:"<已有动作 id>", input:{…}, as:{human,side}?}`') }
    }
    const out = []
    for (const step of steps) {
      if (!plainObject(step) || !ID_RE.test(text(step.action))) {
        return { error: code('invalid-step', `步骤形状不合法：${JSON.stringify(step ?? null)}`,
          '每步给 `{action:"<已有动作 id>", input:{…}}`') }
      }
      const as = step.as === undefined || step.as === null ? null : step.as
      if (as !== null && (!plainObject(as) || text(as.side) === '')) {
        return { error: code('invalid-step-actor', `步骤 as 形状不合法：${JSON.stringify(as)}`,
          '给 `{side:"<侧>"}`（这一步由**哪一侧**发起；沙盘里那一侧用哪个演示身份由机制决定）') }
      }
      const capture = text(step.capture)
      if (capture !== '' && !/^[a-z][a-z0-9-]{0,31}$/.test(capture)) {
        return { error: code('invalid-capture', `步骤 capture 名字不合法：${JSON.stringify(step.capture)}`,
          '给小写字母/数字/连字符的短名（后面的步骤用 `$cap.<名字>.<字段>` 取它的回执）') }
      }
      out.push({ action: text(step.action), input: plainObject(step.input) ? step.input : {},
        as: as === null ? null : { side: text(as.side), human: text(as.human) }, capture,
        // `optional:true` = 这一步失败**不算整条流程失败**（场景照旧往下跑，失败如实记进回执）。
        // 用途：某一步依赖的既有能力暂时不成立时，演示不该整条停在那里。
        optional: step.optional === true, note: text(step.note) })
    }
    const view = text(raw.view)
    return { entry: { kind: 'scenario', plugin_id: text(raw.plugin_id), id: text(raw.id), title: raw.title,
      order: orderOf(raw.order), scenario: scenarioId, scenario_title: text(raw.scenario_title) || scenarioId,
      view, steps: out, hint: text(raw.hint) } }
  })

  const byKind = (kind) => [...entries.values()].filter((item) => item.kind === kind).sort((left, right) =>
    (sortKey(left) < sortKey(right) ? -1 : (sortKey(left) > sortKey(right) ? 1 : 0)))

  const findAction = (id) => byKind('action').find((item) => item.id === id) ?? null
  const panelsOf = (viewId) => byKind('panel').filter((item) => item.view === viewId)
  const shortcuts = () => byKind('shortcut')
  const validatorsFor = (actionId) => byKind('validator')
    .filter((item) => item.actions.length === 0 || item.actions.includes(actionId))
  /**
   * 某个视图里可用的**导出 / 打印**声明：`objectKind` 为空 ⇒ 视图级导出（整张比价表这类）；
   * 非空 ⇒ 该对象类对象页上的导出按钮。调用方（外壳/客户端）只拿到元数据，内容由 `action` 生成。
   */
  const reportsFor = (viewId, objectKind = '') => byKind('report').filter((item) => item.views.includes(viewId)
    && item.object_kind === String(objectKind ?? ''))
  /** 全部导出声明（`/api/ui/surface` 用它把「谁能导出什么」摆出来，含注册者与格式）。 */
  const reports = () => byKind('report')

  /**
   * **沙盘场景**（`scenario` 贡献）：按场景分组键聚合 ⇒ 一条可一键跑完的流程。
   * 外壳只做**分组与排序**（同组内按 order，再按 plugin_id 字典序），不认识任何步骤的业务含义。
   */
  const scenarios = () => {
    const groups = new Map()
    for (const entry of byKind('scenario')) {
      const group = groups.get(entry.scenario) ?? { scenario: entry.scenario, title: entry.scenario_title,
        hint: '', order: entry.order, steps: [], contributors: [], step_count: 0 }
      group.title = group.title || entry.scenario_title
      if (entry.order < group.order) group.order = entry.order
      group.hint = group.hint || entry.hint
      for (const step of entry.steps) group.steps.push({ ...step, plugin_id: entry.plugin_id, view: entry.view,
        declared_by: entry.title })
      group.contributors.push({ plugin_id: entry.plugin_id, id: entry.id, title: entry.title,
        step_count: entry.steps.length })
      group.step_count = group.steps.length
      groups.set(entry.scenario, group)
    }
    return [...groups.values()].sort((left, right) => (left.scenario < right.scenario ? -1 : 1))
  }

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
      hint: entry.hint, panel: entry.panel, object_kind: entry.object_kind,
      // **乐观并发声明**（只给元数据：函数型的一半不进快照 —— 与 data/server/poll 同一口径）
      concurrency: entry.concurrency
        ? { object_class: entry.concurrency.object_class, label: entry.concurrency.label,
          id_field: entry.concurrency.id_field, expected_field: entry.concurrency.expected_field,
          object_id: entry.concurrency.object_id ? '<object_id(ctx, input)>' : null }
        : null }
    if (entry.kind === 'shortcut') return { ...base, keys: entry.keys, action: entry.action }
    if (entry.kind === 'notification-source') return { ...base, hint: entry.hint }
    if (entry.kind === 'status-item') return { ...base }
    if (entry.kind === 'validator') return { ...base, actions: entry.actions }
    if (entry.kind === 'report') return { ...base, views: entry.views, formats: entry.formats,
      action: entry.action, object_kind: entry.object_kind, columns: entry.columns, hint: entry.hint }
    if (entry.kind === 'scenario') return { ...base, scenario: entry.scenario,
      scenario_title: entry.scenario_title, view: entry.view, step_count: entry.steps.length,
      steps: entry.steps.map((step) => ({ action: step.action, as: step.as, input_keys: Object.keys(step.input) })),
      hint: entry.hint }
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
        ['view', 'panel', 'action', 'shortcut', 'notification-source', 'status-item', 'validator', 'report',
          'scenario'].map((kind) => [kind, byKind(kind).length])) },
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

  return { view, panel, action, shortcut, notificationSource, statusItem, validator, report, scenario,
    findAction, panelsOf, panelsFor, actionsFor, objectKindsFor, shortcuts, validatorsFor, reportsFor, reports,
    scenarios,
    byKind, snapshot, disposePlugin, dispose, get entries() { return [...entries.values()] },
    get size() { return entries.size }, get disposed() { return disposed } }
}
