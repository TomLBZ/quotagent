/* app.js —— quotagent GUI 外壳的客户端（**只来自本服务**：`/quotagent/assets/app.js`；无外网 CDN、无构建步骤）。
 *
 * 它是什么、不是什么：
 *   · 它是**机制**：多视图导航 / 工作台（"你现在该做什么"）/ **对象深链** `/app/<view>/<kind>/<id>` /
 *     命令面板 / 通知中心 / 状态栏 / 通用渲染器（table · form · list · kv · metrics · html）/ 动作表单与
 *     **客户端校验** / 可编辑表格与批量操作 / 右键菜单 / 内联动作 / 结果提示条 / 插件装载面（热重载）。
 *     它**不认识**任何业务名词：所有内容都来自注册面（`/api/ui/surface`、`/api/ui/panels`、`/api/ui/object`）。
 *   · 它**不写账本**：动作一律 POST 到 `/api/action/<id>`，由插件自己的**服务端一半**执行，
 *     写动作最终只由 Python 侧唯一写者落账本（`docs/design/29-webui-gui-app.md` §3）。
 *   · 脚本只来自受信来源（本服务 /assets/**）。启动数据放**惰性 JSON 块**
 *     （`<script type="application/json" id="q-boot">`，不可执行），页面里不写内联可执行脚本；
 *     所有事件都用 addEventListener 绑，页面里**没有** on* 内联事件属性。
 */
(() => {
  const Q = (() => {
    const fb = { prefix: '/quotagent', route: { view: 'home', kind: '', id: '', panel: '' } }
    try { return JSON.parse(document.getElementById('q-boot')?.textContent || '') || fb } catch (err) { return fb }
  })()
  const API = (path) => `${Q.prefix}${path}`
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const el = (id) => document.getElementById(id)
  const LAST_KEY = 'quotagent.last-route'
  /** 客户端机制的**持久化便签**（localStorage；私密模式不可用时就退化成"本次会话内有效"）。 */
  const KEYS = { tabs: 'quotagent.tabs', recent: 'quotagent.recent', layout: 'quotagent.layout',
    notif: 'quotagent.notif', jobHints: 'quotagent.jobHints' }
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch (err) { return fallback }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch (err) { /* 容量/私密模式：不影响功能 */ }
    },
  }

  const state = {
    surface: { views: [], actions: [], panels: [], shortcuts: [], plugins: [] },
    route: { view: Q.route.view || 'home', kind: Q.route.kind || '', id: Q.route.id || '' },
    panels: [], object: null, notifications: [], status: [], plugins: [],
    edits: {}, editOrigin: {}, selected: {}, selectedRows: {}, banners: [],
    // **服务端窗口**：这一块正在向服务端取新的一页（读数中如实标出来，数字不冒充已更新）
    panelBusy: {}, wantKeys: {},
    // ⑤ 多标签页 / 最近访问：地址栏仍是唯一位置来源，这两个只是"摆给用户看的入口"
    tabs: store.get(KEYS.tabs, []), recentRoutes: store.get(KEYS.recent, []),
    // ② 面板布局（顺序 / 折叠）：按「视图 + 对象类」分桶持久化
    layout: store.get(KEYS.layout, {}),
    // ① 通知中心：已读集合 + 偏好（静音哪些插件 / 最低级别）
    notif: store.get(KEYS.notif, { read: [], muted: [], minLevel: 'info' }),
    // ④ 对比模式：每个面板勾了哪几组列
    compare: {},
    // **服务端忙**（P13）：服务端渲染准入回的 `ui-busy` 读数（含 Retry-After 与事件循环滞后）
    busy: null, busyNoticed: false,
    results: [],
  }
  state.notif.read = new Set(Array.isArray(state.notif.read) ? state.notif.read : [])
  state.notif.muted = Array.isArray(state.notif.muted) ? state.notif.muted : []
  if (!(state.notif.minLevel in { info: 1, warn: 1, bad: 1 })) state.notif.minLevel = 'info'
  if (!Array.isArray(state.tabs)) state.tabs = []
  if (!Array.isArray(state.recentRoutes)) state.recentRoutes = []
  if (!state.layout || typeof state.layout !== 'object') state.layout = {}

  const saveNotif = () => store.set(KEYS.notif, { read: [...state.notif.read].slice(-500),
    muted: state.notif.muted, minLevel: state.notif.minLevel })

  /**
   * **通知偏好 / 已读 / 面板布局 / 筛选片的服务端化**（跨浏览器、跨设备仍在；0600 落盘在服务端）。
   *
   * 为什么：原先这些只写 localStorage ⇒ 换浏览器/换设备就重来（P3 走查如实登记的摩擦）。
   * 口径：登录后有 `GET/POST /api/ui/notif-state`（按**会话身份**落 0600 文件）⇒ 它成为真源，
   * localStorage 降为**离线镜像**（未登录 / 服务端不可写时仍能用，但会**如实说明**只在本浏览器有效）。
   * 服务端还没有这个人的记录时，把本浏览器里攒下的状态**一次性推上去**（迁移，不丢用户标过的已读/拖过的面板）。
   */
  let notifSource = 'local'          // 'server' | 'local'
  let notifStateNote = '未登录：只在本浏览器有效'
  let notifPushTimer = null
  const notifPayload = () => ({ state: { read: [...state.notif.read].slice(-500), muted: state.notif.muted,
    min_level: state.notif.minLevel, layout: state.layout, filters: state.filters } })
  async function loadNotifState() {
    const out = await getJson('/api/ui/notif-state')
    if (!out.ok) {
      notifSource = 'local'
      notifStateNote = `只在本浏览器有效（${out.code || 'identity-required'}）：登录后落服务端，跨设备仍在`
      return out
    }
    notifSource = 'server'
    notifStateNote = `存在服务端（按会话身份 ${out.identity || ''}）：通知偏好 / 已读 / **布局** / 筛选都在，`
      + '换浏览器、换设备仍在'
    const localRead = [...state.notif.read]
    const localMuted = [...state.notif.muted]
    const localLevel = state.notif.minLevel
    const localLayout = state.layout
    const localFilters = state.filters
    state.notif.read = new Set(Array.isArray(out.state?.read) ? out.state.read : [])
    state.notif.muted = Array.isArray(out.state?.muted) ? out.state.muted : []
    if (['info', 'warn', 'bad'].includes(out.state?.min_level)) state.notif.minLevel = out.state.min_level
    // 布局 / 筛选：服务端有记录 ⇒ 它就是真源（这正是"换设备仍在"）；服务端空 ⇒ 用本浏览器的镜像。
    const serverLayout = out.state?.layout && typeof out.state.layout === 'object' ? out.state.layout : {}
    const serverFilters = out.state?.filters && typeof out.state.filters === 'object' ? out.state.filters : {}
    if (Object.keys(serverLayout).length) state.layout = serverLayout
    if (Object.keys(serverFilters).length) state.filters = serverFilters
    saveNotif()
    store.set(KEYS.layout, state.layout)
    store.set(FILTER_KEY, state.filters)
    const serverEmpty = state.notif.read.size === 0 && state.notif.muted.length === 0
      && state.notif.minLevel === 'info' && Object.keys(serverLayout).length === 0
      && Object.keys(serverFilters).length === 0
    if (serverEmpty && (localRead.length || localMuted.length || localLevel !== 'info'
      || Object.keys(localLayout || {}).length || Object.keys(localFilters || {}).length)) {
      state.notif.read = new Set(localRead)
      state.notif.muted = localMuted
      state.notif.minLevel = localLevel
      state.layout = localLayout
      state.filters = localFilters
      saveNotif()
      store.set(KEYS.layout, state.layout)
      store.set(FILTER_KEY, state.filters)
      pushNotifState(true)
    }
    return out
  }
  /** 把当前偏好推到服务端（有 300ms 去抖：打开通知中心会连续标已读，不必每次都打一次）。
   *  `immediate=true` 时**立刻发**并返回这次 POST 的 promise —— 通知中心打开时要用它保证
   *  「已读先落服务端、再取未读数」的顺序（否则界面上的"未读"是标已读之前的读数）。 */
  function pushNotifState(immediate = false) {
    if (notifSource !== 'server') return Promise.resolve(null)
    if (notifPushTimer) clearTimeout(notifPushTimer)
    const send = async () => {
      notifPushTimer = null
      const out = await postJson('/api/ui/notif-state', notifPayload())
      if (!out.ok) {
        notifSource = 'local'      // 写失败就**如实降级**（不假装已经跨设备了）
        notifStateNote = `写服务端失败（${out.code || 'write-failed'}）：仍只在本浏览器有效`
        banner('warn', '通知偏好没能写到服务端', [out.code, out.reason].filter(Boolean).join(' · '),
          out.next_action || '偏好仍写在本浏览器（localStorage）；服务恢复后再点一次「标为已读」即可')
        paintBadge()
      }
      return out
    }
    if (immediate) return send()
    notifPushTimer = setTimeout(send, 300)
    return Promise.resolve(null)
  }

  // ---------------------------------------------------------------- 协作类的「我的 / 我指派的 / 全部」筛选
  /**
   * 条目/行可以声明 `bucket`（桶键）+ `bucket_label`（人话标签），面板可以在 `data.buckets` 里声明桶清单；
   * 通知可以声明 `tags`（标签数组）。外壳只**搬运字符串**、按它出筛选片 —— 不知道"我的"是什么意思。
   * 筛选状态只存在**本浏览器**（`quotagent.filters`）：它是你个人的看法，不是业务事实，也不进账本。
   */
  const FILTER_KEY = 'quotagent.filters'
  state.filters = store.get(FILTER_KEY, {})
  if (!state.filters || typeof state.filters !== 'object') state.filters = {}
  const filterOf = (key) => String(state.filters[key] ?? '')
  const setFilter = (key, value) => {
    state.filters = { ...state.filters, [key]: String(value ?? '') }
    store.set(FILTER_KEY, state.filters)
    pushNotifState()            // 筛选也服务端化：换浏览器/换设备仍是这套筛选
  }
  /** 收集桶：先取面板声明的 `data.buckets`（有计数），再补条目自带但没声明过的 `bucket`。 */
  function bucketsOf(data, rows) {
    const out = []
    for (const item of (Array.isArray(data?.buckets) ? data.buckets : [])) {
      const key = String(item?.key ?? '')
      if (key === '' || out.some((known) => known.key === key)) continue
      out.push({ key, label: String(item?.label ?? key), count: item?.count })
    }
    for (const row of (rows || [])) {
      const key = String(row?.bucket ?? '')
      if (key === '' || out.some((known) => known.key === key)) continue
      out.push({ key, label: String(row?.bucket_label ?? key), count: undefined })
    }
    return out
  }
  const countInBucket = (rows, key) => rows.filter((row) => String(row?.bucket ?? '') === key).length
  const byBucket = (rows, key) => (key === '' ? rows : rows.filter((row) => String(row?.bucket ?? '') === key))
  /** 片上的数字**是不是真有一个**（`null`/`undefined`/`''` = 没有；**绝不**把它当 0 ——
   *  `Number(null) === 0` 正是「全部 0」那个假数字的来历）。 */
  const hasCount = (count) => count !== null && count !== undefined && count !== '' && Number.isFinite(Number(count))
  /** 筛选片：`全部 N` + 每个桶（`label N`）。点一下只改"看到哪些"，不改任何事实。
   *  `counts` = 服务端在全集上算好的桶计数（客户端只有一页时用它，免得片上的数字跟着这一页变小）。 */
  function bucketBar(scope, buckets, current, rows, counts) {
    if (!buckets.length) return ''
    const pick = (key) => (counts && counts[key] !== undefined ? counts[key]
      : (key === '' ? rows.length : countInBucket(rows, key)))
    const chip = (key, label, count) => `<span class="q-chip${current === key ? ' on' : ''}"`
      + ` data-bucket-filter="${attr(scope)}" data-bucket-key="${attr(key)}" role="button" tabindex="0">`
      + `${esc(label)} ${hasCount(count) ? Number(count) : pick(key)}</span>`
    // 「全部」那颗片的数字 = **这一块真的有多少行**（真源：服务端窗口的 `query.total_full`；没开窗口就是
    // 整份行集的行数）。它必须与同一块表头那句「共 N 行」**同源**，否则用户会以为筛掉了东西。
    const total = pick('')
    return `<div class="q-bucketbar" data-bucket-bar="${attr(scope)}">`
      + `<span class="q-bucketbar-label">筛选</span>`
      + chip('', '全部', total)
      + buckets.map((item) => chip(item.key, item.label, item.count)).join('')
      + `<span class="q-hint">只看你关心的那一类（按你的身份存在服务端：换浏览器/换设备仍是这套筛选；不改任何事实）</span></div>`
  }


  // ---------------------------------------------------------------- 长列表：查询 / 排序 / 分页 + 窗口化渲染
  /**
   * 这一节是**机制**（0 业务语义）：任何形状为 `table` / `files` / `list` 的面板都自动获得
   * 「关键字搜索 · 按列筛选（枚举 / 文本 / 数值区间 / 时间区间）· 点列头排序 · 分页 / 窗口化渲染」——
   * 插件一行不改就有；想更精确的插件可以给列加 `filter:'enum'|'text'|'number'|'date'` 覆盖自动判型。
   *
   * 为什么必须有（用户口径）："干一天活的规模也顺"——包几百个、报价上千行、通知几百条时，全量渲染
   * 会把首屏拖到几秒、把 DOM 撑到几万节点；而**搜索 / 筛选 / 排序**在规模下才是真正干活的入口。
   *
   * **正确性纪律（性能不得换来错的数字）**：
   *   · **计数在全集上算**：`共 N 行`（面板给的全部行）与 `命中 M 行`（筛选后）都在全量行集上算，
   *     与"不分页时看到的一样"；本页只代表窗口（`本页 K 行`），不参与任何计数口径；
   *   · **排序是全序且稳定**（同值按原始行序），所以"排序后第 k 行"与全量排序的第 k 行**逐行相同**；
   *   · **筛选可组合**（关键字 ∧ 每列条件）且**可一键清空**；它只改"看到哪些"，不改任何事实、不写账本；
   *   · **小计按命中行集算**（客户端已改的格子优先），翻页不丢编辑（编辑按「面板|行键」存在 `state.edits`）；
   *   · **窗口化渲染**：DOM 里最多只有本页那么多个 `<tr>`；每页行数可以选「全部」，那是**明确选择**
   *     全量渲染（界面上写着），不是偷偷的。
   * 唯一口径与实测数字见 `src/system/webui/docs/scale-and-performance.md`。
   */
  const QUERY_KEY = 'quotagent.query'
  /** 每页行数（`0` = 全部；选了它界面会明说"这一页会全量渲染"）。 */
  const QUERY_SIZES = [10, 25, 50, 100, 250, 0]
  const QUERY_DEFAULT_SIZE = 25
  const QUERY_MIRROR_MAX = 40          // 服务端镜像最多这么多块面板（超出只在本浏览器，界面如实说）
  state.query = store.get(QUERY_KEY, {})
  if (!state.query || typeof state.query !== 'object' || Array.isArray(state.query)) state.query = {}
  const emptyQuery = () => ({ kw: '', cols: {}, sort: '', page: 0, size: QUERY_DEFAULT_SIZE })
  /** 一块面板当前的查询状态（坏值一律回落到默认 —— 不猜、不半坏着用）。 */
  const queryOf = (panelId) => {
    const raw = state.query[panelId] || {}
    const size = QUERY_SIZES.includes(Number(raw.size)) ? Number(raw.size) : QUERY_DEFAULT_SIZE
    return { kw: String(raw.kw ?? ''), sort: String(raw.sort ?? ''),
      cols: (raw.cols && typeof raw.cols === 'object' && !Array.isArray(raw.cols)) ? { ...raw.cols } : {},
      page: Math.max(0, Number(raw.page) || 0), size }
  }
  const colFilterValues = (q) => Object.entries(q.cols).filter(([, value]) => String(value ?? '').trim() !== '')
  const queryActive = (q) => q.kw.trim() !== '' || q.sort !== '' || colFilterValues(q).length > 0
  /** 查询状态的人话摘要（提示条/计数用；不解读业务）。 */
  const querySummary = (q) => [q.kw.trim() ? `关键字「${q.kw.trim()}」` : '',
    colFilterValues(q).length ? `${colFilterValues(q).length} 个列条件` : '', q.sort ? `排序 ${q.sort}` : '']
    .filter(Boolean).join(' · ')

  /**
   * 服务端镜像（按会话身份，跨浏览器/跨设备仍在）：关键字 / 排序 / 每页行数各占一个**扁平键**
   * （`k.<面板>` / `s.<面板>` / `z.<面板>`）—— 服务端那份状态是**有界洗净的标量表**（见 `webui.mjs`），
   * 塞结构化对象进去会被如实丢掉，所以这里只镜像这三个小的。**列条件与页码只在本浏览器**
   * （它们组合起来能超长；界面上的提示条会如实说明这一点）。镜像键有上限（超出丢最早的，界面说明）。
   */
  const QUERY_MIRROR_RE = /^[ksz]\./
  function mirrorQuery(panelId) {
    const q = queryOf(panelId)
    const mirror = { ...state.filters }
    const put = (key, value) => { if (value === '' || value === null) delete mirror[key]; else mirror[key] = String(value) }
    put(`k.${panelId}`, q.kw.trim().slice(0, 48))
    put(`s.${panelId}`, q.sort)
    put(`z.${panelId}`, q.size === QUERY_DEFAULT_SIZE ? '' : String(q.size))
    const keys = Object.keys(mirror).filter((key) => QUERY_MIRROR_RE.test(key))
    for (const key of keys.slice(0, Math.max(0, keys.length - QUERY_MIRROR_MAX))) delete mirror[key]
    state.filters = mirror
    store.set(FILTER_KEY, state.filters)
    pushNotifState()
  }
  /** 启动/换设备时把服务端镜像读回本地查询状态（服务端那份是"换设备仍在"的来源）。 */
  function hydrateQueryFromMirror() {
    const panelIds = new Set(Object.keys(state.query))
    for (const [key, value] of Object.entries(state.filters || {})) {
      if (!QUERY_MIRROR_RE.test(key)) continue
      const kind = key[0]
      const panelId = key.slice(2)
      if (panelId === '') continue
      panelIds.add(panelId)
      const q = queryOf(panelId)
      if (kind === 'k') q.kw = String(value)
      if (kind === 's') q.sort = String(value)
      if (kind === 'z') q.size = QUERY_SIZES.includes(Number(value)) ? Number(value) : q.size
      state.query[panelId] = q
    }
    store.set(QUERY_KEY, state.query)
    return panelIds
  }
  const saveQuery = (panelId, next) => {
    const clean = { kw: next.kw, cols: next.cols, sort: next.sort, page: next.page, size: next.size }
    const pristine = clean.kw.trim() === '' && clean.sort === '' && !colFilterValues(clean).length
      && clean.page === 0 && clean.size === QUERY_DEFAULT_SIZE && !Object.keys(clean.cols).length
    if (pristine) delete state.query[panelId]
    else state.query[panelId] = clean
    store.set(QUERY_KEY, state.query)
    // 查询一变，之前按需取回来的命中行键就作废了（再带着 `keys=true` 只会白花几十 KB）
    if (state.wantKeys && state.wantKeys[panelId]) delete state.wantKeys[panelId]
    mirrorQuery(panelId)
  }
  /**
   * 改查询状态：**条件变了就回第 1 页**（留在第 7 页看一份只剩 2 页的结果是坑）；然后**只重取这一块**。
   * 服务端窗口开着 ⇒ 走 `refreshPanel`（向服务端要这一页：筛选/排序/分页与计数都在服务端全集上算）；
   * 没开（形状没有行数组 / 旧数据）⇒ 本地重绘，行为与本批之前一致。
   */
  const setQuery = (panelId, patch, { keepPage = false } = {}) => {
    const next = { ...queryOf(panelId), ...patch }
    if (!keepPage && patch.page === undefined) next.page = 0
    saveQuery(panelId, next)
    forgetSelection(panelId)            // 选择与当前查询绑定：条件一变，跨页选择作废（比静默发错 id 安全）
    repaintPanel(panelId)               // 先把查询条上你刚点的那个状态画出来（立即反馈）
    return refreshPanel(panelId)        // 再按需取页（服务端只回这一块的那一页）
  }
  /** 清空这一块的查询（关键字 + 列条件 + 排序；页码回第 1 页；每页行数保留）。 */
  const clearQuery = (panelId) => {
    saveQuery(panelId, { ...emptyQuery(), size: queryOf(panelId).size })
    repaintPanel(panelId)
    refreshPanel(panelId)
    toast('ok', '查询已清空', '关键字 / 列条件 / 排序都清掉了；每页行数保留（那是显示偏好，不是筛选）')
  }

  // ---- 服务端窗口：把"这一块要哪一页"送到服务端（**不是**本地截断）---------------------------------
  /** 这一块上客户端已改的格子（服务端据此把小计算成"你正要提交的那份"；只发这一块的）。 */
  function editsSpecOf(panelId) {
    const out = {}
    for (const [key, fields] of Object.entries(state.edits || {})) {
      if (!key.startsWith(`${panelId}|`) || !fields || !Object.keys(fields).length) continue
      out[key.slice(panelId.length + 1)] = { ...fields }
    }
    return Object.keys(out).length ? out : null
  }
  /** 一块面板的查询说明（送到服务端的形状；未知/坏值由服务端洗净并在回执里如实计数）。 */
  function specOf(panelId) {
    const q = queryOf(panelId)
    const spec = { kw: q.kw, sort: q.sort, page: q.page, size: q.size }
    if (Object.keys(q.cols).length) spec.cols = q.cols
    const bucket = filterOf(panelId)          // 桶筛选片（list）也是"看到哪些"的一部分 ⇒ 一起送
    if (bucket !== '') spec.bucket = bucket
    const edits = editsSpecOf(panelId)
    if (edits) spec.edits = edits
    // 命中行键（跨页全选用）**按需要**：默认不发（几十 KB 的行键只有点了那颗按钮才需要）
    if (state.wantKeys?.[panelId] === true) spec.keys = true
    return spec
  }
  /** 服务端窗口的请求地址（`w=1` 常开；`only` 只取这几块；`pq` = 每块的查询状态）。 */
  function panelsUrl(only) {
    const params = ['w=1']
    const pq = {}
    const ids = (only && only.length) ? only : Object.keys(state.query || {})
    for (const panelId of ids) if (panelId) pq[panelId] = specOf(panelId)
    if (only && only.length) params.push(`only=${encodeURIComponent(only.join(','))}`)
    if (Object.keys(pq).length) params.push(`pq=${encodeURIComponent(JSON.stringify(pq))}`)
    const view = state.route.view || 'home'
    if (state.route.kind && state.route.id) {
      return `/api/ui/object?view=${encodeURIComponent(view)}&kind=${encodeURIComponent(state.route.kind)}`
        + `&id=${encodeURIComponent(state.route.id)}&${params.join('&')}`
    }
    return `/api/ui/panels?view=${encodeURIComponent(view)}&${params.join('&')}`
  }
  /**
   * **按需取页**（本批的核心动作）：把这一块的查询状态送到服务端，只换这一块的 `data`（别的面板一字不动）。
   * 纪律：读数中**如实标出来**（`data-q-busy`）；读不到**不冒充成功**（保留上一次的行 + 黄条说明 + 下一步）。
   */
  async function refreshPanel(panelId) {
    const panel = state.panels.find((item) => item.id === panelId)
    if (!panel || !panel.data || panel.data.query?.server !== true) { repaintPanel(panelId); return false }
    state.panelBusy = { ...(state.panelBusy || {}), [panelId]: true }
    repaintPanel(panelId)                                   // 先标"读数中"（数字不冒充已更新）
    const out = await getJson(panelsUrl([panelId]))
    state.panelBusy = { ...(state.panelBusy || {}), [panelId]: false }
    const fresh = (out && out.ok && Array.isArray(out.panels))
      ? out.panels.find((item) => item.id === panelId) : null
    if (!fresh) {
      banner('warn', '这一块没读到新的一页（显示的还是上一次的那一页）',
        `${(out && (out.code || out.reason)) || 'read-failed'}`,
        (out && out.next_action) || '点这一块的「重新读一次」或页面顶部「重载」重试')
      repaintPanel(panelId)
      return false
    }
    state.panels = state.panels.map((item) => (item.id === panelId ? fresh : item))
    repaintPanel(panelId)
    return true
  }
  /** 一次重取多块（服务端镜像读回来时用：把"换设备也在"的那套查询喂给服务端）。 */
  async function refreshPanels(panelIds) {
    const ids = (panelIds || []).filter((id) => id && state.panels.some((panel) => panel.id === id
      && panel.data && panel.data.query?.server === true))
    if (!ids.length) return false
    const out = await getJson(panelsUrl(ids))
    if (!out || !out.ok || !Array.isArray(out.panels)) {
      for (const id of ids) repaintPanel(id)
      return false
    }
    const byId = new Map(out.panels.map((item) => [item.id, item]))
    state.panels = state.panels.map((item) => byId.get(item.id) ?? item)
    for (const id of ids) repaintPanel(id)
    return true
  }

  // ---- 求值：全量行集 → （筛选）→ （排序）→ （分页窗口）--------------------------------------------
  /** 列筛选控件类型：插件显式声明优先，其余按列 `type` 自动判型（不猜业务，只认形状）。 */
  const columnFilterKind = (column) => {
    const declared = String(column?.filter ?? '')
    if (['enum', 'text', 'number', 'date'].includes(declared)) return declared
    if (column?.type === 'number') return 'number'
    if (column?.type === 'date' || column?.type === 'datetime') return 'date'
    return 'text'
  }
  /** 一行的"可搜文本"：**所有标量字段**（含没显示的列、id、时刻）—— 搜一个 id 不该先去找它在哪一列。 */
  const rowHaystack = (row, columns) => {
    const parts = []
    for (const column of columns) parts.push(textOf(row?.[column.key]))
    for (const [key, value] of Object.entries(row || {})) {
      if (key === 'ref' || key === 'row_actions' || key === 'preset') continue
      if (value === null || typeof value === 'object') continue
      parts.push(String(value))
    }
    return parts.join(' \u0000 ').toLowerCase()
  }
  const haystackCache = new WeakMap()
  const haystackOf = (row, columns, signature) => {
    if (!row || typeof row !== 'object') return textOf(row).toLowerCase()
    const hit = haystackCache.get(row)
    if (hit && hit.signature === signature) return hit.text
    const text = rowHaystack(row, columns)
    haystackCache.set(row, { signature, text })
    return text
  }
  const textOf = (value) => (value === null || value === undefined ? '' : String(value))
  const cellText = (row, key) => textOf(row?.[key])
  /** 单列条件：`数值/时间` 用 `min~max`、枚举用全等、文本用包含（都忽略大小写）。 */
  const matchColumn = (row, column, raw) => {
    const value = String(raw ?? '').trim()
    if (value === '') return true
    const kind = columnFilterKind(column)
    const cell = cellText(row, column.key)
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
  /**
   * **全量行集 → 命中行集**（关键字 ∧ 每个列条件）。返回 `{rows, matched, total}`：
   * `total` 是面板给的全部行（计数口径的基准），`matched` 是筛选后剩下的那些（仍保持原始行序）。
   */
  function applyQuery(columns, rows, q) {
    const total = rows.length
    const conditions = colFilterValues(q).map(([key]) => columns.find((column) => column.key === key)
      || { key, type: 'text' })
    const needle = q.kw.trim().toLowerCase()
    const signature = `${columns.length}|${columns.map((column) => column.key).join(',')}`
    let matched = rows
    if (conditions.length) {
      matched = matched.filter((row) => conditions.every((column) => matchColumn(row, column, q.cols[column.key])))
    }
    if (needle !== '') {
      matched = matched.filter((row) => haystackOf(row, columns, signature).includes(needle))
    }
    return { rows, matched, total }
  }
  /** **稳定全序排序**（同值按原始行序）⇒ "排序后第 k 行"与全量排序逐行一致；不认的排序列=不排。 */
  function sortRows(items, columns, sort) {
    const at = String(sort).indexOf(':')
    const key = at < 0 ? '' : sort.slice(0, at)
    const dir = at < 0 ? '' : sort.slice(at + 1)
    if (key === '' || (dir !== 'asc' && dir !== 'desc')) return items
    const column = columns.find((item) => item.key === key)
    if (!column) return items
    const numeric = columnFilterKind(column) === 'number'
    const factor = dir === 'desc' ? -1 : 1
    return items.slice().sort((left, right) => {
      const a = left.row?.[key]
      const b = right.row?.[key]
      let cmp = 0
      if (numeric) {
        const x = Number(a); const y = Number(b)
        const xf = Number.isFinite(x) && String(textOf(a)).trim() !== ''
        const yf = Number.isFinite(y) && String(textOf(b)).trim() !== ''
        cmp = xf && yf ? (x - y) : (xf === yf ? 0 : (xf ? -1 : 1))
      } else {
        const x = textOf(a); const y = textOf(b)
        cmp = x.localeCompare(y, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      }
      return cmp !== 0 ? cmp * factor : (left.index - right.index)
    })
  }
  /** 分页窗口（`size === 0` ⇒ 全部；页号越界一律夹回合法范围，不返回空页）。 */
  function pageView(items, size, page) {
    if (!size) return { page: 0, pages: 1, start: 0, end: items.length, window: items }
    const pages = Math.max(1, Math.ceil(items.length / size))
    const at = Math.min(Math.max(0, Number(page) || 0), pages - 1)
    const start = at * size
    return { page: at, pages, start, end: Math.min(items.length, start + size),
      window: items.slice(start, start + size) }
  }
  /**
   * 一块面板的**视图**（全量→筛选→排序→窗口，一次算完）；同时缓存起来供"小计重算/批量选择"用：
   * 小计与批量必须按**命中全集**算，不能只按这一页的 DOM 算（否则翻页就把别的行漏掉了）。
   *
   * **两条路（本批新增服务端窗口）**：
   *   · 面板的 `data.query.server === true` ⇒ 走**服务端窗口**：`rows` 就是服务端给的那一页，
   *     计数/页号/命中数/小计/命中行键**照抄服务端**（客户端不再自己截断，也没有全量行可截）；
   *   · 否则照旧走**本地**：全量→筛选→排序→窗口（形状没有行数组的面板、或没带 `w=1` 的旧数据）。
   */
  const panelViews = {}
  function queryView(panelId, columns, rows, q, rowKeyOf, serverQuery) {
    const view = (serverQuery && serverQuery.server === true)
      ? serverView(panelId, columns, rows, q, rowKeyOf, serverQuery)
      : localView(panelId, columns, rows, q, rowKeyOf)
    panelViews[panelId] = view
    return view
  }
  /** 本地路径（原样保留：它仍是"服务端不可用/旧数据"时的兜底，也是两条路对拍时的参照）。 */
  function localView(panelId, columns, rows, q, rowKeyOf) {
    const filtered = applyQuery(columns, rows, q)
    const sorted = sortRows(filtered.matched.map((row, index) => ({ row, index })), columns, q.sort)
    const paged = pageView(sorted, q.size, q.page)
    return { panelId, columns, q, server: false, total: filtered.total,
      matched: filtered.matched, matchedCount: filtered.matched.length, matchedKeys: null,
      matchedKeysCapped: false, sorted, window: paged.window.map((item) => item.row),
      page: paged.page, pages: paged.pages, start: paged.start, end: paged.end, size: q.size,
      active: queryActive(q), rowKeyOf, byKey: new Map(rows.map((row, index) => [rowKeyOf(row, index), row])),
      rowKeys: paged.window.map((item) => rowKeyOf(item.row, item.index)),
      totals: null, groupTotals: null, mins: null, enumOptions: null, bucketCounts: null,
      filesCounts: null, rowsFull: rows.length, applied: null }
  }
  /**
   * **服务端窗口路径**：行是服务端给的那一页，数字是服务端在全集上算的。
   * 这里**不做任何截断**（没有全量行可截）——这正是"服务端分页"与"前端先拿全量再截断"的区别。
   */
  function serverView(panelId, columns, rows, q, rowKeyOf, sq) {
    const keys = Array.isArray(sq.row_keys) && sq.row_keys.length === rows.length ? sq.row_keys : null
    const keyAt = keys ? (row, index) => String(keys[index]) : rowKeyOf
    return { panelId, columns, q, server: true, total: Number(sq.total) || 0,
      matched: rows, matchedCount: Number(sq.matched) || 0,
      matchedKeys: Array.isArray(sq.matched_keys) && sq.matched_keys.length ? sq.matched_keys : null,
      matchedKeysCapped: sq.matched_keys_capped === true, matchedKeysCap: Number(sq.matched_keys_cap) || 0,
      matchedKeysAvailable: Number(sq.matched_keys_available) || 0, matchedKeysOnDemand: sq.matched_keys_on_demand === true,
      sorted: rows.map((row, index) => ({ row, index })), window: rows, rowKeys: rows.map(keyAt),
      page: Number(sq.page) || 0, pages: Math.max(1, Number(sq.pages) || 1),
      start: Number(sq.start) || 0, end: Number(sq.end) || rows.length, size: Number(sq.size) || 0,
      active: sq.active === true, rowKeyOf: keyAt,
      byKey: new Map(rows.map((row, index) => [keyAt(row, index), row])),
      totals: Array.isArray(sq.totals) && sq.totals.length ? sq.totals : null,
      groupTotals: Array.isArray(sq.group_totals) && sq.group_totals.length ? sq.group_totals : null,
      mins: sq.mins && Object.keys(sq.mins).length ? sq.mins : null,
      enumOptions: sq.enum_options && Object.keys(sq.enum_options).length ? sq.enum_options : null,
      bucketCounts: sq.bucket_counts ?? null, levelCounts: sq.level_counts ?? null,
      levelByBucket: sq.level_by_bucket ?? null, head: Array.isArray(sq.head) ? sq.head : null,
      filesCounts: sq.files_counts ?? null, rowsFull: Number(sq.total_full) || 0, applied: sq.applied ?? null,
      shape: sq.field ?? '' }
  }
  const firstKeyOf = (panel, row, index) => String(row?.id ?? row?.[(panel?.data?.columns || [])[0]?.key] ?? index)
  /** 一个格子的值：**客户端已改的优先**（小计、排序、筛选看到的都是"你正要提交的那份"）。 */
  const editValueOf = (panelId, rowKey, field, row) => {
    const typed = (state.edits[`${panelId}|${rowKey}`] || {})[field]
    return typed === undefined ? (row ? row[field] : undefined) : typed
  }

  // ---- 查询状态的持久化边界（给界面一句人话）------------------------------------------------------
  const mirrorNote = () => (notifSource === 'server'
    ? `关键字/排序/每页行数按你的身份存服务端（换浏览器/换设备仍在，最多 ${QUERY_MIRROR_MAX} 块面板）；列条件与页码只在本浏览器`
    : `未登录：查询状态只在本浏览器（登录后关键字/排序/每页行数落服务端，换设备仍在）`)

  // ---- 窄屏查询条折叠（P21 / D3）------------------------------------------------------------------
  /**
   * 手机上默认**折叠**查询条：一块面板的头（标题 + 机制 + 关键字 + 列筛选 + 计数 + 翻页 + 恢复默认 + 镜像说明）
   * 在 390px 下曾占约 800px ⇒ 844px 的手机**首屏看不到任何数据行**（P20 实测）。
   * 折叠状态记在本浏览器（不改服务端偏好、不影响任何事实）；展开后所有控件照旧。
   */
  const qbarOpenOf = (panelId) => (state.qbarOpen || {})[panelId] === true
  const setQbarOpen = (panelId, open) => {
    state.qbarOpen = { ...(state.qbarOpen || {}), [panelId]: open === true }
  }

  // ---- 选择（跨页批量）--------------------------------------------------------------------------
  /** 「选中全部命中行」的选择记在面板名下；查询一变就作废（比静默发错 id 安全）。 */
  const forgetSelection = (panelId) => {
    if (state.selectedAll && state.selectedAll[panelId]) {
      for (const key of state.selectedAll[panelId]) {
        delete state.selected[key]
        delete state.selectedRows[key]
      }
      delete state.selectedAll[panelId]
    }
  }
  const selectedAllOf = (panelId) => ((state.selectedAll || {})[panelId] || [])
  /**
   * **手工勾选（跨页保留）**（P21 / D2）：勾选按**面板**记一份（`state.picked[panelId][行键] = true`）。
   *
   * 为什么按面板记：翻页之后上一页的行不在 DOM 里，`[data-select]:checked` 查不到它们 —— 只认 DOM 的话
   * 用户在第 1 页勾的行会**静默消失**（P20 实测：勾 2 行只送出 1 行，少签）。按面板记之后：翻回去勾还在，
   * 批量提交送的是**真的勾过的那些**（含不在本页的），计数行也照实说。
   */
  const pickedOf = (panelId) => ((state.picked || {})[panelId] || {})
  const pickedKeysOf = (panelId) => Object.keys(pickedOf(panelId))
  const pickSet = (panelId, key, on) => {
    const bucket = { ...(state.picked || {})[panelId] }
    if (on) bucket[key] = true
    else delete bucket[key]
    state.picked = { ...(state.picked || {}), [panelId]: bucket }
  }
  const pickClear = (panelId) => {
    if (!state.picked || !state.picked[panelId]) return
    const next = { ...state.picked }
    delete next[panelId]
    state.picked = next
  }
  const selectionCountOf = (panelId) => new Set([...pickedKeysOf(panelId), ...selectedAllOf(panelId)]).size
  /**
   * 「选中全部命中行」（跨页）。服务端窗口下命中全集的行键是**按需**取的：先按一次带 `keys=true` 的
   * 重取（只这一块），拿到行键再选中 —— 所以这一步可能是异步的（按钮先变成"正在取行键…"）。
   */
  async function selectAllMatched(panelId) {
    let view = panelViews[panelId]
    if (!view) return
    if (view.server && !view.matchedKeys && view.matchedCount > 0 && !view.matchedKeysCapped) {
      state.wantKeys = { ...(state.wantKeys || {}), [panelId]: true }
      await refreshPanel(panelId)
      view = panelViews[panelId]
      if (!view) return
    }
    const keys = view.server
      ? (view.matchedKeys || [])
      : view.matched.map((row, index) => view.rowKeyOf(row, index))
    if (!keys.length) {
      return toast('warn', '这一块没法跨页全选（不是没选中）',
        `命中行数超过服务端一次给得出行键的上限（${view.matchedKeysCap || 0} 行）：先用关键字/列条件把范围缩小，再点一次`)
    }
    state.selectedAll = { ...(state.selectedAll || {}), [panelId]: keys }
    for (const [index, row] of view.window.entries()) {
      const key = view.rowKeyOf(row, index)
      state.selectedRows = { ...(state.selectedRows || {}), [key]: row }
    }
    // 不在本页的那些行只有 id（插件按 id 取事实，与"勾单行"走同一条路）
    for (const key of keys) state.selected[key] = true
    repaintPanel(panelId)
    updateSelectedCount()
    const onPage = view.window.length
    toast('ok', `已选中全部命中行（${keys.length} 行）`,
      `批量动作会把它们一起送出去（含不在本页的那 ${Math.max(0, keys.length - onPage)} 行）；`
      + '换筛选条件会自动取消这份选择')
  }
  function clearSelection(panelId) {
    const view = panelViews[panelId]
    const keys = new Set([...(view ? view.window.map((row, index) => view.rowKeyOf(row, index)) : []),
      ...selectedAllOf(panelId), ...pickedKeysOf(panelId)])
    for (const key of keys) {
      delete state.selected[key]
      delete state.selectedRows[key]
    }
    pickClear(panelId)
    delete (state.selectedAll || {})[panelId]
    repaintPanel(panelId)
    updateSelectedCount()
  }

  // ---- 计数条（机器可对账：`data-count-*` 就是可核对的数字）----------------------------------------
  function countBarHtml(panelId, view, extra = '') {
    const attrOf = (name, value) => ` data-${name}="${attr(value)}"`
    const busy = state.panelBusy?.[panelId] === true
    return `<div class="q-qcount" data-q-count="${attr(panelId)}"`
      + attrOf('count-total', view.total) + attrOf('count-matched', view.matchedCount)
      + attrOf('count-window', view.window.length) + attrOf('count-full', view.rowsFull)
      + attrOf('server-paged', view.server ? 1 : 0) + attrOf('q-busy', busy ? 1 : 0)
      + attrOf('page', view.page + 1)
      + attrOf('pages', view.pages) + attrOf('page-size', view.size)
      + attrOf('q-active', view.active ? 1 : 0) + attrOf('sort', view.q.sort || '') + '>'
      + `<span class="q-c-total">共 <b>${view.total}</b> 行</span>`
      + `<span class="q-c-matched">命中 <b data-count-matched-num="1">${view.matchedCount}</b> 行</span>`
      + (view.size
        ? `<span class="q-c-page">第 <b data-count-page-num="1">${view.page + 1}</b>/<b>${view.pages}</b> 页`
          + `<span class="q-c-page-in">（本页 <b data-count-window-num="1">${view.window.length}</b> 行）</span></span>`
        : `<span class="q-c-page">本页 <b>${view.window.length}</b> 行（**选了「全部」= 全量渲染**）</span>`)
      + (view.server
        ? `<span class="q-qhint q-c-server" data-q-server="1" title="行由服务端按窗口给（w=1）；计数/排序/筛选都在服务端全集上算，`
          + `客户端照抄 —— 不是把全量拿下来自己截">服务端分页</span>`
        : '')
      + (busy ? `<span class="q-qhint q-c-busy" data-q-fetching="1">正在取这一页…（数字还是上一次的）</span>` : '')
      + (view.active ? `<span class="q-qcount-on q-c-filter">正在筛选：${esc(querySummary(view.q))}</span>` : '')
      + (extra ? `<span class="q-c-extra">${extra}</span>` : '')
      + '</div>'
  }

  // ---- 查询条（关键字 / 列条件 / 分页 / 清空）-----------------------------------------------------
  /** 枚举候选：**服务端在全集上算好的**优先（客户端只有一页时自己算会少几个选项）；否则从行里算。
   *  >24 个不同值就给文本框 —— 不猜、也不摆一个没法用的下拉。 */
  function enumOptions(rows, column, view) {
    const fromServer = view?.enumOptions?.[column.key]
    if (Array.isArray(fromServer) && fromServer.length) return fromServer
    const seen = new Map()
    for (const row of rows) {
      const value = cellText(row, column.key).trim()
      if (value === '' || value.length > 24) continue
      seen.set(value, (seen.get(value) || 0) + 1)
      if (seen.size > 26) return null
    }
    if (!seen.size || seen.size > 24) return null
    return [...seen.entries()].sort((left, right) => right[1] - left[1]
      || left[0].localeCompare(right[0], 'zh-Hans-CN')).map(([value, count]) => ({ value, count }))
  }
  /** 一列的筛选控件（形状由 `columnFilterKind` 定；值来自当前查询状态）。 */
  function columnFilterControl(panelId, column, q, rows, view) {
    const key = String(column.key)
    const raw = String(q.cols[key] ?? '')
    const kind = columnFilterKind(column)
    const label = esc(column.label || key)
    const base = `data-q-col="${attr(`${panelId}:${key}`)}" data-q-kind="${attr(kind)}" aria-label="按 ${label} 筛选"`
    if (kind === 'number' || kind === 'date') {
      const [min = '', max = ''] = raw.split('~')
      const type = kind === 'number' ? 'number' : 'date'
      const extra = kind === 'number' ? ' inputmode="decimal" step="any"' : ''
      return `<label class="q-qcol"><span>${label}${kind === 'number' ? '（数值区间）' : '（时间区间）'}</span>`
        + `<input type="${type}"${extra} ${base} data-q-bound="min" value="${attr(min)}" placeholder="≥">`
        + `<input type="${type}"${extra} ${base} data-q-bound="max" value="${attr(max)}" placeholder="≤"></label>`
    }
    if (kind === 'enum') {
      const options = enumOptions(rows, column, view)
      if (options && options.length) {
        return `<label class="q-qcol"><span>${label}</span><select ${base} data-q-enum="1">`
          + `<option value="">（全部）</option>`
          + options.map((option) => `<option value="${attr(option.value)}"`
            + `${option.value === raw ? ' selected' : ''}>${esc(option.value)}（${option.count}）</option>`).join('')
          + '</select></label>'
      }
    }
    return `<label class="q-qcol"><span>${label}（包含）</span>`
      + `<input type="text" ${base} value="${attr(raw)}" placeholder="含…" autocomplete="off"></label>`
  }
  function queryBar(panelId, columns, view, rows) {
    const q = view.q
    const conds = colFilterValues(q).length
    const sortAt = q.sort.indexOf(':')
    const sortKey = sortAt < 0 ? '' : q.sort.slice(0, sortAt)
    const sortDir = sortAt < 0 ? '' : q.sort.slice(sortAt + 1)
    const selected = selectedAllOf(panelId).length
    const manual = pickedKeysOf(panelId).length
    const open = qbarOpenOf(panelId)
    const pageBtn = (label, page, title, kind) => `<button data-q-page="${attr(panelId)}" data-q-to="${attr(page)}"`
      + ` data-q-page-kind="${attr(kind)}" title="${attr(title)}"${view.size === 0 ? ' disabled' : ''}>${label}</button>`
    // **窄屏折叠（P21 / D3）**：`data-qbar-open` 是状态，CSS 决定"折叠时露什么" ——
    // 窄屏上露「🔍 搜这块 / 筛选」一颗按钮 + 计数行 + 翻页；关键字/列条件/每页行数/恢复默认在折叠区里。
    // 展开/折叠记在本浏览器（`state.qbarOpen`），不改服务端状态、不影响任何事实。
    return `<div class="q-qbar" data-query-bar="${attr(panelId)}" data-qbar-open="${open ? 1 : 0}">`
      + `<div class="q-qbar-row q-qbar-lead">`
      + `<button class="q-qbar-toggle" data-q-toggle="${attr(panelId)}" aria-expanded="${open ? 'true' : 'false'}"`
      + ` title="手机上默认折叠：点一下展开关键字与按列筛选">🔍 搜这块 / 筛选</button>`
      + `<span class="q-qbar-foldnote q-qhint">${view.active ? '正在筛选' : '关键字 / 列条件'}</span>`
      + `</div>`
      + `<div class="q-qbar-row q-qbar-fold">`
      + `<label class="q-qkw">搜这块：<input type="search" data-q-kw="${attr(panelId)}" value="${attr(q.kw)}"`
      + ` placeholder="关键字（id / 供应商 / 时刻 / 任何一列的值…）" autocomplete="off"`
      + ` aria-label="在这块里搜关键字"></label>`
      + `<button data-q-clear="${attr(panelId)}"${view.active ? '' : ' disabled'}>清空查询</button>`
      + (columns.length ? `<details class="q-qcols"${conds ? ' open' : ''}><summary>按列筛选`
        + `${conds ? `（${conds} 条生效）` : `（${columns.length} 列可选）`}</summary>`
        + `<div class="q-qcolwrap">${columns.map((column) => columnFilterControl(panelId, column, q, rows, view)).join('')}</div>`
        + `<div class="q-qhint">数值列给区间（≥ / ≤）、时间列给日期区间、短枚举列给下拉、其余列是"包含"；`
        + `条件之间是**并且**，与关键字一起生效。筛选只改"看到哪些"，不改任何事实、不写账本。</div></details>` : '')
      + `</div>`
      + countBarHtml(panelId, view,
        `${manual ? `已勾选 <span data-picked-count="1">${manual}</span> 行 ` : ''}`
        + `${selected ? `已跨页选中 ${selected} 行 ` : ''}`
        + `${manual && !selected ? `<button data-q-unselect="${attr(panelId)}">取消勾选</button> ` : ''}`
        + (view.matchedCount > view.window.length && view.size
          ? `<button data-q-selectall="${attr(panelId)}"${view.matchedKeysCapped
            ? ` disabled title="命中超过 ${view.matchedKeysCap} 行：跨页全选要先缩小筛选范围"`
            : ` title="${view.matchedKeysOnDemand
              ? '点一下：先按需取回命中的行键（这一块，不下载整份数据），再跨页选中'
              : '把命中全集的行一起选中（含不在本页的）'}"`}>`
            + `选中全部命中行（${view.matchedCount}）</button> ` : '')
        + (selected ? `<button data-q-unselect="${attr(panelId)}">取消选择</button> ` : '')
        + `<span class="q-c-sorthint">${sortKey ? `排序：<code>${esc(sortKey)}</code> ${sortDir === 'desc' ? '↓ 降序' : '↑ 升序'}` : '点列头可排序（升→降→取消）'}</span>`)
      + `<div class="q-qbar-row q-qpages">`
      + pageBtn('⏮ 首页', 0, '第 1 页', 'first') + pageBtn('上一页', view.page - 1, '上一页', 'prev')
      + `<label class="q-page-extra">跳到第 <input type="number" min="1" max="${view.pages}" data-q-jump="${attr(panelId)}"`
      + ` value="${view.page + 1}" aria-label="跳到第几页"> 页</label>`
      + pageBtn('下一页', view.page + 1, '下一页', 'next') + pageBtn('末页 ⏭', view.pages - 1, '最后一页', 'last')
      + `<label class="q-page-extra">每页 <select data-q-size="${attr(panelId)}" aria-label="每页显示多少行">`
      + QUERY_SIZES.map((size) => `<option value="${size}"${size === q.size ? ' selected' : ''}>`
        + `${size === 0 ? '全部（全量渲染）' : size}</option>`).join('') + '</select></label>'
      + `<button class="q-page-extra" data-q-reset="${attr(panelId)}">恢复默认显示</button>`
      + `<span class="q-qhint">${esc(mirrorNote())}</span>`
      + `</div></div>`
  }
  /** 已生效的筛选项做成"可以一条条摘掉"的片（不用回去翻哪一列设过什么）。 */
  function activeFilterChips(panelId, view) {
    const chips = []
    if (view.q.kw.trim()) {
      chips.push(`<span class="q-chip on" data-q-drop="${attr(`${panelId}:kw`)}"`
        + ` role="button" tabindex="0" title="点一下去掉这个关键字">关键字「${esc(view.q.kw.trim())}」✕</span>`)
    }
    for (const [key, value] of colFilterValues(view.q)) {
      const column = view.columns.find((item) => item.key === key)
      chips.push(`<span class="q-chip on" data-q-drop="${attr(`${panelId}:${key}`)}" role="button" tabindex="0"`
        + ` title="点一下去掉这一列的筛选">${esc(column ? (column.label || key) : key)} = ${esc(value)} ✕</span>`)
    }
    if (view.q.sort) {
      chips.push(`<span class="q-chip on" data-q-drop="${attr(`${panelId}:sort`)}"`
        + ` role="button" tabindex="0" title="点一下取消排序">排序 ${esc(view.q.sort)} ✕</span>`)
    }
    return chips.length ? `<div class="q-qchips">${chips.join('')}</div>` : ''
  }

  // ---- 单块面板重绘（只换这一块，别的面板不动）-----------------------------------------------------
  /**
   * 重绘一块面板 = 换掉那个 `<section>` 的 DOM 后**在这一块内**重新绑定交互。
   * 为什么换节点而不是改 innerHTML：旧节点上的监听器会跟着节点一起消失（不会累积重复监听）；
   * 查询条自己的事件走 `#q-view` 上的**委托**（只绑一次），所以换完节点仍然好用。
   */
  function repaintPanel(panelId) {
    const panel = state.panels.find((item) => item.id === panelId)
    const section = el('q-view')?.querySelector(`section[data-panel="${panelId}"]`)
    if (!panel || !section) return
    const active = document.activeElement
    let focus = null
    if (active && section.contains(active)) {
      const key = active.dataset.qKw !== undefined ? `[data-q-kw="${panelId}"]`
        : (active.dataset.qCol ? `[data-q-col="${attr(active.dataset.qCol)}"][data-q-bound="${attr(active.dataset.qBound || '')}"]`
          : (active.dataset.qJump !== undefined ? `[data-q-jump="${panelId}"]` : ''))
      if (key) focus = { key, start: active.selectionStart, end: active.selectionEnd }
    }
    const collapsed = section.classList.contains('collapsed')
    section.outerHTML = panelSection(panel, collapsed)
    const fresh = el('q-view')?.querySelector(`section[data-panel="${panelId}"]`)
    if (!fresh) return
    bindPanels(fresh)
    bindInteractions(fresh)
    bindFiles(fresh)
    // 重绘之后把"已选 N 行"按**面板里真勾着的**再算一遍（P21 / D2：翻页回来勾还在，计数也得对得上）
    updateSelectedCount()
    if (focus) {
      const node = fresh.querySelector(focus.key)
      if (node && typeof node.focus === 'function') {
        node.focus()
        if (focus.start !== null && focus.start !== undefined && node.setSelectionRange
          && node.type !== 'number' && node.type !== 'date' && node.type !== 'search') {
          try { node.setSelectionRange(focus.start, focus.end) } catch (err) { /* 类型不支持就算了 */ }
        }
      }
    }
  }
  /** 重绘/重取所有有查询状态的面板（例如服务端镜像读回来后——换个浏览器也要是同一套查询）。
   *  服务端窗口开路时**要重取**（客户端手里没有全量行，光重绘只会画出旧窗口）。 */
  function repaintQueriedPanels(panelIds) {
    const ids = (panelIds || []).filter((panelId) => panelViews[panelId] || state.query[panelId])
    if (!ids.length) return false
    return refreshPanels(ids)
  }

  /**
   * 查询条的**委托**事件（`#q-view` 上只绑一次）：关键字输入（180ms 去抖）、列条件、翻页、
   * 每页行数、点列头排序、清空、摘掉某一个条件、跨页全选。委托的好处：重绘面板不会丢事件。
   */
  const queryInputTimers = {}
  function bindQueryDelegates() {
    const root = el('q-view')
    if (!root || root.dataset.qDelegated === '1') return
    root.dataset.qDelegated = '1'
    const panelIdOf = (node, name) => String(node?.dataset?.[name] ?? '')
    root.addEventListener('input', (ev) => {
      const node = ev.target
      if (!node || !node.dataset) return
      if (node.dataset.qKw !== undefined) {
        const panelId = panelIdOf(node, 'qKw')
        clearTimeout(queryInputTimers[panelId])
        const value = node.value
        // 去抖：一边打字一边把 5000 行重算 5 次没有意义；180ms 后一次算完
        queryInputTimers[panelId] = setTimeout(() => setQuery(panelId, { kw: value }), 180)
        return
      }
      if (node.dataset.qCol !== undefined) {
        const [panelId, key] = String(node.dataset.qCol).split(':')
        if (!panelId || !key) return
        const scope = node.closest('[data-query-bar]')
        const bounds = [...(scope?.querySelectorAll(`[data-q-col="${attr(node.dataset.qCol)}"]`) || [])]
        const readBound = (name) => (bounds.find((item) => item.dataset.qBound === name) || {}).value ?? ''
        const value = node.dataset.qBound
          ? `${String(readBound('min')).trim()}~${String(readBound('max')).trim()}`
          : node.value
        const next = { ...queryOf(panelId).cols }
        if (String(value).trim() === '' || String(value) === '~') delete next[key]
        else next[key] = value
        // 列条件也去抖（区间两个框、回车前不要每敲一下都重算）
        const token = `${panelId}:${key}`
        clearTimeout(queryInputTimers[token])
        queryInputTimers[token] = setTimeout(() => setQuery(panelId, { cols: next }), 180)
        queryInputTimers[panelId] = null
        return
      }
      if (node.dataset.qJump !== undefined) return          // 翻页框在 change 上处理
    })
    root.addEventListener('change', (ev) => {
      const node = ev.target
      if (!node || !node.dataset) return
      if (node.dataset.qSize !== undefined) {
        return setQuery(panelIdOf(node, 'qSize'), { size: Number(node.value) })
      }
      if (node.dataset.qEnum !== undefined) {
        const [panelId, key] = String(node.dataset.qCol).split(':')
        const next = { ...queryOf(panelId).cols }
        if (String(node.value).trim() === '') delete next[key]; else next[key] = node.value
        return setQuery(panelId, { cols: next })
      }
      if (node.dataset.qJump !== undefined) {
        const panelId = panelIdOf(node, 'qJump')
        return setQuery(panelId, { page: Math.max(0, Number(node.value) - 1) }, { keepPage: true })
      }
      if (node.dataset.qSort !== undefined) return applySortToggle(panelIdOf(node, 'qSort'), node.dataset.qSortKey)
    })
    root.addEventListener('click', (ev) => {
      const node = ev.target?.closest?.('[data-q-page],[data-q-clear],[data-q-reset],[data-q-selectall],'
        + '[data-q-unselect],[data-q-drop],[data-q-sort],[data-q-toggle],[data-reload-page]')
      if (!node) return
      if (node.dataset.reloadPage !== undefined) return loadAll(true)
      // 查询条折叠/展开（P21 / D3）：只换这一块的重绘，不发任何请求、不改任何事实
      if (node.dataset.qToggle !== undefined) {
        const panelId = panelIdOf(node, 'qToggle')
        setQbarOpen(panelId, !qbarOpenOf(panelId))
        repaintPanel(panelId)
        return
      }
      if (node.dataset.qPage !== undefined) {
        return setQuery(panelIdOf(node, 'qPage'), { page: Number(node.dataset.qTo) }, { keepPage: true })
      }
      if (node.dataset.qClear !== undefined) return clearQuery(panelIdOf(node, 'qClear'))
      if (node.dataset.qReset !== undefined) {
        const panelId = panelIdOf(node, 'qReset')
        saveQuery(panelId, { ...emptyQuery() })
        repaintPanel(panelId)
        return refreshPanel(panelId)
      }
      if (node.dataset.qSelectall !== undefined) return selectAllMatched(panelIdOf(node, 'qSelectall'))
      if (node.dataset.qUnselect !== undefined) return clearSelection(panelIdOf(node, 'qUnselect'))
      if (node.dataset.qSort !== undefined) return applySortToggle(panelIdOf(node, 'qSort'), node.dataset.qSortKey)
      if (node.dataset.qDrop !== undefined) {
        const [panelId, what] = String(node.dataset.qDrop).split(':')
        const q = queryOf(panelId)
        if (what === 'kw') return setQuery(panelId, { kw: '' })
        if (what === 'sort') return setQuery(panelId, { sort: '' })
        const cols = { ...q.cols }; delete cols[what]
        return setQuery(panelId, { cols })
      }
    })
    root.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      const node = ev.target?.closest?.('[data-q-drop],[data-q-sort]')
      if (!node) return
      ev.preventDefault()
      if (node.dataset.qSort !== undefined) return applySortToggle(panelIdOf(node, 'qSort'), node.dataset.qSortKey)
      const [panelId, what] = String(node.dataset.qDrop).split(':')
      if (what === 'kw') return setQuery(panelId, { kw: '' })
      if (what === 'sort') return setQuery(panelId, { sort: '' })
      const cols = { ...queryOf(panelId).cols }; delete cols[what]
      return setQuery(panelId, { cols })
    })
  }
  /** 点列头排序：升 → 降 → 取消（三态；不改任何事实）。 */
  function applySortToggle(panelId, key) {
    if (!panelId || !key) return
    const current = queryOf(panelId).sort
    const dir = current === `${key}:asc` ? 'desc' : (current === `${key}:desc` ? '' : 'asc')
    setQuery(panelId, { sort: dir === '' ? '' : `${key}:${dir}` })
  }

  // ---- 性能探针（**测量面**：只读、可关、不参与任何业务）--------------------------------------------
  /**
   * 每次主区渲染记一条读数（`paint_ms` = 渲染这段同步代码花了多久；`frame_ms` = 到下一帧画完）+
   * 当时的 DOM 节点数与**真的渲染了多少行**（窗口化的证据）。它是机制的一部分：验收要"性能测量"
   * 就得有一个可读的、同一口径的读数，而不是靠感觉。读数在 `window.__Q_GUI_METRICS` 里，只读。
   */
  const perfProbe = { version: 2, count: 0, last: null, history: [] }
  const metricOf = (t0, extra = {}) => {
    try {
      const windowed = state.panels.filter((panel) => (panel.data || {}).query?.server === true)
      const rows_api = state.panels.reduce((sum, panel) => sum + ((panel.data?.rows || panel.data?.items
        || panel.data?.files || []).length), 0)
      const rows_full = windowed.reduce((sum, panel) => sum + (Number((panel.data || {}).query?.total_full) || 0), 0)
      const entry = { at: new Date().toISOString(), route: routeLabel(state.route),
        state: state.loading ? 'loading' : (state.panelsError || state.objectError ? 'error' : 'ready'),
        paint_ms: Math.round((performance.now() - t0) * 10) / 10, panels: state.panels.length,
        // `rows_api` = 这次**真下发**的行（服务端窗口之后就是那一页）；`rows_full_server` = 面板给的全量行；
        // `server_windowed_panels` = 有几块走服务端窗口 —— 三个数一起看才说明"首屏不再整份下发"
        rows_api, rows_full_server: rows_full, server_windowed_panels: windowed.length,
        rows_dom: document.querySelectorAll('tr[data-row-key]').length,
        dom_nodes: document.getElementsByTagName('*').length,
        paged_panels: state.panels.filter((panel) => {
          const view = panelViews[panel.id]
          return view && view.size > 0 && view.matchedCount > view.window.length
        }).length, ...extra }
      perfProbe.count += 1
      perfProbe.last = entry
      perfProbe.history = [...perfProbe.history.slice(-19), entry]
      return entry
    } catch (err) { return null }
  }
  window.__Q_GUI_METRICS = perfProbe

  const html = (parts) => parts.join('')
  const badge = (text, level) => `<span class="q-badge ${level || ''}">${esc(text)}</span>`

  const attr = (value) => esc(value).replace(/'/g, '&#39;')

  /** 对象/视图的**深链**（可复制分享）：对象地址 = `/app/<view>/<kind>/<id>/`。 */
  const linkOf = (view, kind, id) => (kind && id ? `${API(`/app/${view}/${kind}/${id}/`)}` : API(`/app/${view}/`))
  const refLink = (ref) => (ref && ref.kind && ref.id
    ? linkOf(ref.view || state.route.view, ref.kind, ref.id) : '')
  const refLabel = (ref) => (ref && ref.title ? ref.title : (ref ? `${ref.kind} ${ref.id}` : ''))

  // ---------------------------------------------------------------- PWA：可安装 + **离线如实**
  /**
   * 装成应用（standalone 启动）+ 离线壳：策略原文在 `assets/sw.js`，机读副本在 `/api/ui/surface` 的 `pwa`。
   *
   * 这边只做两件事：① 注册那个 Service Worker（失败**如实说**，不静默）；② 把"离线"变成一个
   * **看得见、说得清**的状态：顶部横幅 + 状态栏连接灯都写「离线：数据可能陈旧（上次成功读到的时刻）」，
   * 面板/通知照旧走各自的「读不到 / 保留上次读数并标陈旧」口径 —— **绝不假装有数据**。
   *
   * 为什么不去缓存数据：数据（面板/通知/对象/协作）与身份/人签/运维面一律**不进**缓存
   * （`sw.js` 的 `NEVER_CACHE`）—— 宁可显示"读不到"，也不把一份旧 JSON 当新数据端上来。
   */
  const offlineState = { on: false, at: '', lastGood: '', why: '', failed: 0 }
  /** 界面要显示的离线读数（机器可读：`data-offline-*`，见状态栏与横幅）。 */
  function offlineReadout() {
    return { on: offlineState.on, at: offlineState.at, last_good: offlineState.lastGood,
      why: offlineState.why, failures: offlineState.failed }
  }
  function offlineBanner() {
    const when = offlineState.lastGood || ''
    const detail = offlineState.why + (when ? ` · 上一次成功读到 ${when}` : ' · 这一次还没有成功读到过数据')
      + ` · 失败的请求 ${offlineState.failed} 次`
    banner('warn', '离线：数据可能陈旧', detail,
      '离线壳只缓存**外壳**（界面本身），不缓存任何数据：面板/通知会如实显示"读不到"或保留上次读数并标陈旧。'
      + '动作与人签需要网络（离线时不排队、不重放）。')
  }
  function setOffline(on, why) {
    if (on) {
      offlineState.on = true
      offlineState.at = new Date().toISOString()
      offlineState.why = why || offlineState.why
    } else {
      offlineState.on = false
      offlineState.why = ''
      state.banners = state.banners.filter((item) => item.title !== '离线：数据可能陈旧')
    }
    offlineBanner()
    renderBanners()
    try { renderStatus() } catch (err) { /* 只为如实显示，不影响取数 */ }
  }
  /** 一次**网络层失败**（fetch 抛错）：记一次并在界面上说出来（不静默）。 */
  function offlineNoteBad(path) {
    offlineState.failed += 1
    setOffline(true, `请求 ${String(path || '').slice(0, 80)} 没有回音（网络不可达或服务不在）`)
  }
  /** 一次成功读到：刷新"上次成功读到"的时刻；网络回来了就把离线标记去掉。 */
  function offlineNoteGood() {
    offlineState.lastGood = new Date().toISOString()
    offlineState.failed = 0
    if (offlineState.on) setOffline(false)
  }

  // ---------------------------------------------------------------- PWA：注册离线壳（可安装的另一半）
  /** **是不是以应用方式在跑**（standalone）：装成应用后浏览器不给地址栏/刷新键 —— 外壳自己得给导航与刷新，
   *  所以这件事在界面上要看得见（状态栏一行），也是"装上了没有"最直接的读数。 */
  function standaloneNow() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
    } catch (err) { return false }
  }
  function pwaStatus() {
    return state.pwa || { supported: false, ok: false, code: 'sw-not-registered', scope: '',
      script: API('/sw.js'), display: 'standalone', standalone: standaloneNow() }
  }
  function registerShellWorker() {
    if (!('serviceWorker' in navigator)) {
      state.pwa = { supported: false, ok: false, code: 'sw-unsupported', scope: API('/'),
        script: API('/sw.js'), reason: '这个浏览器不支持 Service Worker（界面照常可用：只是没有离线壳）' }
      return
    }
    const script = API('/sw.js')
    navigator.serviceWorker.register(script, { scope: API('/') }).then((reg) => {
      state.pwa = { supported: true, ok: true, scope: reg.scope || API('/'), script,
        active: Boolean(reg.active), installing: Boolean(reg.installing), waiting: Boolean(reg.waiting),
        display: 'standalone' }
      try { renderStatus() } catch (err) { /* 只为如实显示 */ }
    }).catch((err) => {
      state.pwa = { supported: true, ok: false, code: 'sw-register-failed', scope: API('/'), script,
        reason: String(err).slice(0, 160) }
      banner('warn', '离线壳没有装上（界面照常可用）',
        `注册 ${script} 失败：${String(err).slice(0, 160)}`,
        '浏览器要求 Service Worker 走 https（或 localhost）并且作用域在本前缀下；装不上只是"没有离线能力"，'
        + '不影响任何动作与写路径')
      try { renderStatus() } catch (err2) { /* 同上 */ }
    })
    // 离线壳离线回退时会**明说**这一页是离线壳（`sw.js` 的 `q-offline` 消息）：
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event && event.data ? event.data : {}
      if (data.type === 'q-offline') setOffline(true, '离线壳（Service Worker 回退到不含数据的壳页面）')
    })
  }
  window.addEventListener('online', () => setOffline(false))
  window.addEventListener('offline', () => setOffline(true, '浏览器报告网络已断开（navigator.onLine=false）'))

  if (navigator.onLine === false) setOffline(true, '打开这一页时浏览器报告网络已断开（navigator.onLine=false）')
  // 装成应用/退出应用（standalone 切换）时，状态栏那一行跟着变 —— 不需要刷新整页
  try {
    window.matchMedia('(display-mode: standalone)')
      .addEventListener('change', () => { try { renderStatus() } catch (err) { /* 只为如实显示 */ } })
  } catch (err) { /* 老浏览器没有 addEventListener：那一行只在渲染时更新 */ }
  registerShellWorker()
  /**
   * **只读自述**（给自动化与排障用；**不含任何机密**：没有账本内容、没有凭据、没有别人的数据）：
   *   `window.quotagentShell.offline()` → 离线读数（是否离线/上次成功读到/失败次数/原因）
   *   `window.quotagentShell.pwa()`     → 离线壳（Service Worker）状态与作用域
   *   `window.quotagentShell.prefix()`  → 路由前缀
   * 为什么给：装成应用之后，"离线壳到底装没装上、现在是不是离线"这两件事不该只靠肉眼看状态栏。
   */
  window.quotagentShell = { offline: () => offlineReadout(), pwa: () => pwaStatus(), prefix: () => Q.prefix,
    standalone: () => standaloneNow() }

  async function getJsonOnce(path) {
    try {
      const res = await fetch(API(path), { headers: { accept: 'application/json' } })
      try { const out = await res.json(); offlineNoteGood(); return out }
      catch (err) { return { ok: false, code: 'bad-json', reason: String(err) } }
    } catch (err) {
      offlineNoteBad(path)
      return { ok: false, code: 'offline', reason: `请求 ${path} 失败：${String(err)}`,
        next_action: '确认网络/本服务还在跑（状态栏的连接灯），然后点顶部「重载」' }
    }
  }
  /**
   * **服务端忙（429 + Retry-After）** 的如实处理（P13）：服务端的渲染准入会明确回
   * `code:'ui-busy'` 并给出 `retry_after_ms` —— 这时**不是**"读不到数据"，而是"还没轮到我们"。
   * 于是：① 照实提示（含事件循环滞后/阈值这两个真读数）；② 等它说的时间再试；③ 试满仍被拒，
   * 把服务端那句话原样交给调用方去渲染错误态（**不静默成空**，也不把上一次的行清掉）。
   */
  const BUSY_RETRIES = 2
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** 服务端"忙"的读数落进状态栏（连接灯说"忙"，不冒充"正常"也不冒充"失败"）。 */
  function paintBusy() { try { renderStatus() } catch (err) { /* 只为如实显示，不影响取数 */ } }
  function noteBusy(out, waitMs) {
    state.busy = { code: out.code, at: new Date().toISOString(), wait_ms: waitMs,
      loop_lag_ms: out.loop_lag_ms ?? null, shed_ms: out.shed_ms ?? null }
    if (state.busyNoticed === true) { paintBusy(); return }
    state.busyNoticed = true
    paintBusy()
    toast('warn', '服务端忙（这一条没有开始跑）',
      `已按它给的 Retry-After 等 ${waitMs}ms 再试一次`
      + `${Number.isFinite(out.loop_lag_ms) ? `（事件循环滞后 ${out.loop_lag_ms}ms，阈值 ${out.shed_ms}ms）` : ''}`
      + '；这一次没有读到半份数据，界面保留上一次的读数')
  }
  async function getJson(path) {
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
      const out = await getJsonOnce(path)
      if (out && out.code === 'ui-busy' && attempt < BUSY_RETRIES) {
        const waitMs = Math.min(8000, Math.max(300, Number(out.retry_after_ms) || 1000))
        noteBusy(out, waitMs)
        await sleepMs(waitMs)
        continue
      }
      if (out && out.code !== 'ui-busy' && state.busy) { state.busy = null; state.busyNoticed = false; paintBusy() }
      return out
    }
    return { ok: false, code: 'ui-busy', reason: '服务端连续忙（已按 Retry-After 试过）',
      next_action: '等几秒再点「重载」；连续这样说明这台服务的渲染负载超过单进程上限' }
  }
  async function postJson(path, body) {
    try {
      const res = await fetch(API(path), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}) })
      try { const out = await res.json(); offlineNoteGood(); return out }
      catch (err) { return { ok: false, code: 'bad-json', reason: String(err) } }
    } catch (err) {
      offlineNoteBad(path)
      return { ok: false, code: 'offline', reason: String(err),
        next_action: '写操作需要网络（离线壳**不**排队、**不**重放写请求）：恢复网络后重试这一次操作' }
    }
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text) }
      else { window.prompt('复制这个链接：', text) }
      toast('ok', '已复制', text)
    } catch (err) { toast('warn', '复制失败（浏览器不允许）', text) }
  }

  // ---------------------------------------------------------------- 通知 / 提示条
  /**
   * 一条提示条。
   *
   * **P21（D7）：弹层打开时不再浮在弹层上面** —— 那会压住全屏弹层的标题（390px 实测：导出预览的标题被两条
   * 通知盖住）。让位的做法不是"丢掉不显示"，而是**搬到弹层正文的最上面**（`[data-toast-host]`）：它跟着正文
   * 滚、不覆盖标题、也不压吸底按钮；弹层关掉之后新提示回到右下角浮层。
   */
  function toast(kind, title, detail) {
    const node = document.createElement('div')
    node.className = `q-toast ${kind}`
    node.setAttribute('role', 'status')
    node.innerHTML = `<b>${esc(title)}</b>${detail ? `<div>${esc(detail)}</div>` : ''}`
    const bodyHost = document.querySelector('#q-modal .q-modal-body')
    let inline = bodyHost ? bodyHost.querySelector('[data-toast-host]') : null
    if (bodyHost && !inline) {
      inline = document.createElement('div')
      inline.className = 'q-toasts-inline'
      inline.setAttribute('data-toast-host', '1')
      bodyHost.prepend(inline)
    }
    const box = inline || el('q-toasts')
    if (!box) return
    box.appendChild(node)
    setTimeout(() => node.remove(), kind === 'bad' ? 12000 : 6000)
  }
  /**
   * 这次动作**真往账本里落了几行**（`0` = 零新增、`null` = 回执里没有这个读数）。
   *
   * 三处都是**回执里现成的读数**，界面一个数都不自己算（自己算就是第二条判据）：
   *   ① 批量动作：`job.ledger_added`（动作运行时逐份写者回执求和）；
   *   ② 单条动作：`writer.rows_written`（机制把**本动作**那几条写者回执的 `ledger_added` 加起来；
   *      没跑写者的动作恒 `0` —— 那是"这次确实没写"，不是"不知道"）；
   *   ③ 插件自己在 `result.ledger_added` 里报的数（如 `quote.submit` 的幂等分支恒 0）。
   * 三处都拿不到 ⇒ `null`：**不知道就说不知道**，绝不退化成 0（那会把"没读到"画成"零新增"）。
   */
  function ledgerAddedOf(out) {
    const job = out && out.job
    if (job && Number.isFinite(Number(job.ledger_added))) return Number(job.ledger_added)
    const rows = out && out.writer ? out.writer.rows_written : undefined
    if (Number.isFinite(Number(rows))) return Number(rows)
    const declared = out && out.result ? out.result.ledger_added : undefined
    if (Number.isFinite(Number(declared))) return Number(declared)
    return null
  }
  /** "零新增"的那半句话：区分**幂等重放**（做过的事再交一次）与**本来就不写账本**（只读/只改偏好）。 */
  function zeroAddedNote(out) {
    const writer = (out && out.writer) || {}
    const job = (out && out.job) || null
    const jobDuplicates = job ? Number(job.duplicates ?? 0) : 0
    const mineDuplicates = Array.isArray(writer.ours && writer.ours.duplicates)
      ? writer.ours.duplicates.length : 0
    if (writer.verdict === 'no-writer-run' && !job) {
      return '这次动作没跑唯一写者（只读或只改偏好）⇒ 账本零新增，没有任何新事实'
    }
    if (jobDuplicates + mineDuplicates > 0) {
      return `这一件（或这几件）**已经在账本/归档里**（幂等：写者按 id 认出来了，重签 ${jobDuplicates + mineDuplicates} 件）`
        + '⇒ 本次账本零新增 —— 没有第二条事实被写出来'
    }
    return '写者回执 +0 行 ⇒ 本次账本零新增，没有任何新事实'
  }
  function notifyAction(result, action) {
    if (!result) return
    if (result.ok) {
      // **零新增必须一眼看出来**（P33 修的缺陷）：修前一律写「已受理」，而 `ledger_added=0`
      // （幂等重放 / 只读动作）只有点开回执正文才看得到 ⇒ 用户会以为"又落了一份事实"。
      const added = ledgerAddedOf(result)
      const zero = added === 0
      const reading = added === null
        ? '回执里没有"账本新增行数"这个读数（界面不替它猜）'
        : (zero ? zeroAddedNote(result) : `本次账本 +${added} 行`)
      toast(zero ? 'warn' : 'ok', `${action ? action.title : '动作'}：${zero ? '零新增' : '已受理'}`,
        [reading, result.code ? `(${result.code})` : '', result.next_action || ''].filter(Boolean).join(' · '))
    } else {
      toast('bad', `${action ? action.title : '动作'}：被拒（${result.code || 'refused'}）`,
        [result.reason, result.next_action].filter(Boolean).join(' · '))
    }
    const added = ledgerAddedOf(result)
    state.results.unshift({ id: `act-${Date.now()}-${action?.id || ''}`, plugin_id: action?.plugin_id || '',
      level: result.ok ? (added === 0 ? 'warn' : 'ok') : 'bad',
      title: `${action ? action.title : '动作'} → ${result.ok ? (added === 0 ? '零新增' : 'ok') : result.code}`,
      body: result.reason || '', ledger_added: added,
      next_action: result.next_action || '', at: new Date().toISOString(), ref: result.ref || null })
    state.results = state.results.slice(0, 20)
  }
  function banner(kind, title, detail, nextAction) {
    state.banners = state.banners.filter((item) => item.title !== title)
    state.banners.push({ kind, title, detail, next_action: nextAction || '' })
    renderBanners()
  }
  /**
   * 「上一批没有跑完」那条提示的**忽略便签**（③）：`(批次 id, 还剩几份)` —— 你点过「忽略」就不再摆。
   * **只收起提示，不删任何数据**（记录照旧在 `/api/ui/jobs`，账本一个字节没动）；而且它是**这一件事**的便签：
   * 又做掉几份（数字变了）或来了新的一批（换了 id）⇒ 照常提示。便签有界（只留最近 20 条）。
   */
  const jobHintNote = (key) => store.get(KEYS.jobHints, {})[key] || null
  const ignoreJobHint = (key) => {
    const all = store.get(KEYS.jobHints, {})
    if (!all || typeof all !== 'object') return
    all[key] = new Date().toISOString()
    const kept = Object.keys(all).slice(-20)
    store.set(KEYS.jobHints, Object.fromEntries(kept.map((item) => [item, all[item]])))
  }
  function renderBanners() {
    const box = el('q-banners')
    if (!box) return
    box.innerHTML = state.banners.map((item, index) =>
      `<div class="q-banner ${item.kind}" data-banner="${index}"><b>${esc(item.title)}</b>`
      + `${item.detail ? ` <span>${esc(item.detail)}</span>` : ''}`
      + `${item.next_action ? ` <div class="q-hint">${esc(item.next_action)}</div>` : ''}`
      // **提示条上的动作**（P21：上一批没跑完 ⇒ 一条「只重试剩下的 N 份」）；没有动作就只有「知道了」。
      // 带 `dismiss` 的那种（没跑完的那一批）：收起这条**不再反复出现**（便签见 `ignoreJobHint`）。
      + `${item.retry ? `<button class="primary" data-banner-retry="${index}">`
        + `只重试剩下的 ${(item.retry.ids || []).length} 份</button>` : ''}`
      + `<button data-banner-close="${index}"`
      + ` aria-label="关闭这条提示${item.dismiss ? '（下次打开也不再提示；不删任何数据）' : ''}"`
      + ` title="${attr(item.dismiss
        ? '只收起这条提示，不删任何数据（/api/ui/jobs 里的记录照旧；剩下的份数变了或来了新的一批会照常提示）'
        : '关闭这条提示')}">${esc(item.dismiss?.label || '知道了')}</button></div>`).join('')
    box.querySelectorAll('[data-banner-close]').forEach((node) => node.addEventListener('click', () => {
      const item = state.banners[Number(node.dataset.bannerClose)]
      if (item?.dismiss?.key) ignoreJobHint(item.dismiss.key)   // 便签：刷新/换页也不再摆这一条
      state.banners.splice(Number(node.dataset.bannerClose), 1); renderBanners()
    }))
    box.querySelectorAll('[data-banner-retry]').forEach((node) => node.addEventListener('click', () => {
      const item = state.banners[Number(node.dataset.bannerRetry)]
      if (!item?.retry) return
      // 同一个动作 + 同一份署名（署名由会话身份自动预填），只把 ids 换成"剩下的那些"
      openAction(item.retry.action, { ids: item.retry.ids })
    }))
  }

  // ---------------------------------------------------------------- 路由（含对象深链）+ 多标签页 + 最近访问
  function parsePath(pathname) {
    const bits = String(pathname).replace(Q.prefix, '').split('/').filter(Boolean)
    if (bits[0] !== 'app') return { view: 'home', kind: '', id: '' }
    return { view: bits[1] || 'home', kind: bits[2] || '', id: bits[3] || '' }
  }
  const routeUrl = (route) => linkOf(route.view, route.kind, route.id)
  const sameRoute = (left, right) => left && right && left.view === right.view && left.kind === right.kind
    && left.id === right.id
  const routeLabel = (route) => (route.kind && route.id ? `${route.kind} ${route.id}`
    : viewTitle(route.view))
  const padTab = (route) => ({ ...route, url: routeUrl(route), label: routeLabel(route) })

  const saveTabs = () => store.set(KEYS.tabs, state.tabs.slice(0, 12))
  const saveRecent = () => store.set(KEYS.recent, state.recentRoutes.slice(0, 12))

  /** 一个地址 = 一个标签页；已开着就切过去（不重复开）。 */
  function rememberTab(route) {
    const entry = padTab(route)
    const at = state.tabs.findIndex((tab) => sameRoute(tab, route))
    if (at >= 0) state.tabs[at] = entry
    else state.tabs.push(entry)
    if (state.tabs.length > 12) state.tabs = state.tabs.slice(-12)
    saveTabs()
  }
  /** 「最近访问」：地址级去重（同一个地址只留最近一次），最多 12 条。 */
  function rememberRecent(route) {
    if (route.view === 'home' && !route.kind && !route.id) return
    const entry = { ...padTab(route), at: new Date().toISOString() }
    state.recentRoutes = [entry, ...state.recentRoutes.filter((item) => !sameRoute(item, route))].slice(0, 12)
    saveRecent()
  }
  function closeTab(index) {
    if (index < 0 || index >= state.tabs.length) return
    const was = state.tabs[index]
    state.tabs.splice(index, 1)
    saveTabs()
    if (sameRoute(was, state.route) && state.tabs.length) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)]
      return navigate(next.view, next.kind, next.id, { replace: true, quiet: true })
    }
    renderTabs()
  }
  /** 切到第 N 个标签页（`Alt+1..9`）；越界时如实提示，不静默无动作。 */
  function switchTab(n) {
    const tab = state.tabs[n - 1]
    if (!tab) return toast('warn', '没有第 ' + n + ' 个标签页', `现在开着 ${state.tabs.length} 个`)
    navigate(tab.view, tab.kind, tab.id)
  }
  function renderTabs() {
    const box = el('q-tabs')
    if (!box) return
    if (!state.tabs.length) { box.innerHTML = ''; return }
    box.innerHTML = state.tabs.map((tab, index) => `<span class="q-tab${sameRoute(tab, state.route)
      ? ' active' : ''}"><button class="q-link" data-tab="${index}" title="${attr(tab.url)}">`
      + `<span class="q-tab-n">${index + 1}</span> ${esc(tab.label)}</button>`
      + `<button class="q-tab-x" data-tab-close="${index}" aria-label="关闭这个标签页">×</button></span>`).join('')
      + `<button class="q-tab-add" data-tab-new="1" title="把当前地址再开一个标签页">+ 新标签</button>`
    box.querySelectorAll('[data-tab]').forEach((node) => node.addEventListener('click', () => {
      const tab = state.tabs[Number(node.dataset.tab)]
      if (tab) navigate(tab.view, tab.kind, tab.id)
    }))
    box.querySelectorAll('[data-tab-close]').forEach((node) => node.addEventListener('click', (ev) => {
      ev.stopPropagation(); closeTab(Number(node.dataset.tabClose))
    }))
    box.querySelector('[data-tab-new]')?.addEventListener('click', () => {
      state.tabs.push(padTab({ view: 'home', kind: '', id: '' }))
      saveTabs(); renderTabs(); toast('ok', '已开一个新标签页', '点它回到工作台（标签页各自独立，互不影响当前地址）')
    })
  }

  function navigate(view, kind, id, { replace = false, quiet = false, thenAction = '' } = {}) {
    const next = { view: view || 'home', kind: kind || '', id: id || '' }
    state.route = next; state.edits = {}; state.editOrigin = {}
    state.selected = {}; state.selectedRows = {}; state.picked = {}; state.selectedAll = {}
    // **在这条地址上接着开某个动作**（机制）：缺上下文的动作被引导到"能填的地方"（那条对象的页面）时，
    // 到了地方就自动把这个动作的表单打开 —— 用户不必再找一次那颗按钮（`loadAll` 收尾时消费它）。
    state.thenAction = thenAction || ''
    const url = routeUrl(next)
    if (replace) history.replaceState(next, '', url)
    else history.pushState(next, '', url)
    rememberRoute(next)
    renderChrome(); renderTabs(); loadAll()
    if (!quiet) renderTabs()
  }
  function rememberRoute(route) {
    try {
      const label = route.kind && route.id ? `${route.view} › ${route.kind} ${route.id}` : route.view
      localStorage.setItem(LAST_KEY, JSON.stringify({ ...route, label, at: new Date().toISOString() }))
    } catch (err) { /* 私密模式下 localStorage 不可用：不影响功能 */ }
    rememberTab(route)
    rememberRecent(route)
  }
  const lastRoute = () => {
    try {
      const raw = localStorage.getItem(LAST_KEY)
      return raw ? JSON.parse(raw) : null
    } catch (err) { return null }
  }
  window.addEventListener('popstate', () => {
    state.route = parsePath(location.pathname)
    renderChrome(); renderTabs(); loadAll()
  })

  // ---------------------------------------------------------------- 顶栏 / 状态栏
  function viewsOf() {
    const declared = state.surface.views && state.surface.views.length ? state.surface.views
      : [{ id: 'home', title: '工作台' }, { id: 'contractor', title: '承包商' }, { id: 'supplier', title: '供应商' }]
    return declared
  }
  const viewTitle = (id) => (viewsOf().find((view) => view.id === id) || { title: id }).title

  function renderChrome() {
    const nav = viewsOf().map((view) => `<a href="${attr(linkOf(view.id))}" data-nav="${attr(view.id)}"`
      + `${view.id === state.route.view ? ' class="current" aria-current="page"' : ''}>${esc(view.title)}</a>`).join('')
    el('q-top').innerHTML = `<a class="q-skip" href="#q-view">跳到主内容</a>`
      + `<span class="q-brand">quotagent<small>GUI 应用外壳</small></span>`
      + `<nav class="q-nav" aria-label="视角">${nav}</nav>`
      + `<div class="q-tools">`
      // 触控优先：手机上「⌘K」这个键名没有任何意义 —— 名字写「命令」，快捷键留在 tooltip 里
      + `<button data-open="palette" title="命令面板：搜动作/视图/对象类，点一下就执行（键盘 Ctrl/Cmd+K）"`
      + ` aria-label="打开命令面板（搜动作与视图）">命令 <kbd>⌘K</kbd></button>`
      + `<button data-open="recent" title="最近访问 / 继续上次（Ctrl/Cmd+E）" aria-label="打开最近访问">最近 `
      + `<span class="q-badge">${state.recentRoutes.length}</span></button>`
      + `<button data-open="notify" title="通知中心（待办/结果/失败）" aria-label="打开通知中心">通知`
      + ` <span id="q-notify-count" class="q-badge">0</span></button>`
      + `<button data-open="plugins" title="插件与注册面（可热重载）" aria-label="打开插件面板">插件</button>`
      + `<button data-open="help" title="快捷键与上手指引（?）" aria-label="打开帮助">?</button>`
      + `<button data-open="identity" title="我是谁（会话身份）：人签的署名来自它" aria-label="打开身份与会话">身份`
      + `${state.identity ? ` <span class="q-badge">${esc(state.identity.name)}</span>` : ' <span class="q-badge warn">未登录</span>'}</button>`
      + `<button id="q-reload" title="重载当前页（r）">重载</button></div>`
    el('q-top').querySelectorAll('[data-nav]').forEach((node) => node.addEventListener('click', (ev) => {
      ev.preventDefault(); navigate(node.dataset.nav, '', '')
    }))
    el('q-top').querySelector('[data-open="palette"]').addEventListener('click', openPalette)
    el('q-top').querySelector('[data-open="recent"]').addEventListener('click', openRecent)
    el('q-top').querySelector('[data-open="notify"]').addEventListener('click', openNotify)
    el('q-top').querySelector('[data-open="identity"]').addEventListener('click', openIdentity)
    el('q-top').querySelector('[data-open="plugins"]').addEventListener('click', openPlugins)
    el('q-top').querySelector('[data-open="help"]').addEventListener('click', openHelp)
    el('q-reload').addEventListener('click', () => loadAll(true))
    paintBadge()
  }

  function renderStatus() {
    const route = state.route
    const deep = route.kind && route.id ? linkOf(route.view, route.kind, route.id) : linkOf(route.view)
    // **离线**（PWA）：连接灯有第四种样子 —— 它说的是「我现在读不到新数据，屏上的东西可能陈旧」，
    // 与「正常」「服务端忙」「有请求失败」都长得不一样（四个状态互不冒充）。
    // `data-offline*` 是机器可读的那一维（离线壳只缓存外壳，不缓存数据）。
    const pwa = pwaStatus()
    const conn = offlineState.on
      ? ['连接', `离线：数据可能陈旧${offlineState.lastGood ? `（上次成功读到 ${offlineState.lastGood}）` : '（这次还没读到过数据）'}`, 'warn']
      : (state.busy
        ? ['连接', `服务端忙（等 ${state.busy.wait_ms}ms 重试${Number.isFinite(state.busy.loop_lag_ms)
          ? ` · 滞后 ${state.busy.loop_lag_ms}ms` : ''}）`, 'warn']
        : (state.banners.some((item) => item.kind === 'bad')
          ? ['连接', '有请求失败', 'bad'] : ['连接', '正常', 'ok']))
    const statusLine = (item) => `<span class="q-st ${item.level === 'ok' ? '' : item.level}">${esc(item.title)}：`
      + `${esc(item.text)}${item.level && item.level !== 'ok'
        ? ` ${badge(item.level, item.level === 'bad' ? 'bad' : 'warn')}` : ''}</span>`
    // 状态栏只摆前 8 项（再多就挤成糊字）；其余的进「更多 N 项」（点开是完整清单，仍可读）
    const shown = state.status.slice(0, 8)
    const rest = state.status.slice(8)
    el('q-status').innerHTML = html([
      `<span class="q-st ${conn[2]}" data-offline="${offlineState.on ? '1' : '0'}"`
      + ` data-offline-at="${attr(offlineState.at)}" data-offline-last-good="${attr(offlineState.lastGood)}"`
      + ` data-offline-failures="${attr(String(offlineState.failed))}">${conn[0]}：${conn[1]}</span>`,
      ...shown.map(statusLine),
      rest.length ? `<button class="q-link" data-status-all="1">更多 ${rest.length} 项</button>` : '',
      '<span class="q-spacer"></span>',
      `<span class="q-st" data-pwa="${pwa.ok ? 'installed' : 'not-installed'}" data-pwa-code="${attr(pwa.code || '')}"`
      + ` data-pwa-scope="${attr(pwa.scope || '')}">离线壳 `
      + `${pwa.ok ? `已装（scope ${esc(pwa.scope || '')}）` : `未装（${esc(pwa.code || '')}）`}</span>`,
      `<span class="q-st" data-standalone="${standaloneNow() ? '1' : '0'}">`
      + `${standaloneNow() ? '以应用方式启动（standalone）' : '浏览器标签页'}</span>`,
      `<span class="q-st">动作 ${state.surface.actions.length} · 面板 ${state.surface.panels.length}`
      + ` · 快捷键 ${state.surface.shortcuts.length}</span>`,
      `<span class="q-st">深链 <button class="q-link" data-copy="${attr(deep)}">复制</button>`
      + `<code>${esc(deep)}</code></span>`])
    el('q-status').querySelectorAll('[data-copy]').forEach((node) =>
      node.addEventListener('click', () => copyText(node.dataset.copy)))
    el('q-status').querySelectorAll('[data-status-all]').forEach((node) =>
      node.addEventListener('click', () => openModal(`<h2 id="q-action-title">状态栏（全部 ${state.status.length} 项）</h2>`
        + `<p class="q-src">读数来自插件注册的状态项（外壳只摆位，不解读）</p>`
        + `<ul class="q-list">${state.status.map((item) => `<li><b>${esc(item.title)}</b>：${esc(item.text)}`
          + `${item.next_action ? `<div class="q-hint">下一步：<code>${esc(item.next_action)}</code></div>` : ''}`
          + `<div class="q-hint">${esc(item.plugin_id || '')} · ${esc(item.level || '')}</div></li>`).join('')}</ul>`,
        'q-status-all')))
  }

  // ---------------------------------------------------------------- 通用状态块（空态/错误态/加载态/降级）
  /**
   * 四种状态**各有各的样子**（`data-state` 是机器可读的那一维），且**永不互相冒充**：
   *   · `loading`  = 正在读（还不知道有没有数据）—— 绝不留上一页的行在屏幕上；
   *   · `empty`    = 读到了，真的是空的（带 `reason` 说明为什么空）；
   *   · `degraded` = 读到了但降级（不冒充健康）；
   *   · `error`    = **没读到**（带 code/reason/下一步）—— 绝不显示成"空"。
   */
  function stateBlock({ kind, title, reason, next_action, hint }) {
    const level = kind === 'error' ? 'bad' : (kind === 'degraded' ? 'warn' : 'info')
    const role = kind === 'error' ? 'alert' : (kind === 'loading' ? 'status' : '')
    return `<div class="q-state ${level}" data-state="${attr(kind)}" data-state-reason="${attr(reason || '')}"`
      + `${role ? ` role="${role}"` : ''}${kind === 'loading' ? ' aria-busy="true"' : ''}>`
      + `<b>${esc(title)}</b>${reason ? ` <code>${esc(reason)}</code>` : ''}`
      + `${hint ? `<div>${esc(hint)}</div>` : ''}`
      + `${next_action ? `<div class="q-hint">下一步：<code>${esc(next_action)}</code></div>` : ''}</div>`
  }

  // ---------------------------------------------------------------- 面板渲染（通用形状）
  function rowRefCell(row) {
    const href = refLink(row.ref)
    if (!href) return ''
    return `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(row.ref.kind)}"`
      + ` data-v="${attr(row.ref.view || '')}" data-id="${attr(row.ref.id)}"`
      + ` title="打开 ${attr(refLabel(row.ref))} 的对象页（可复制走）">打开 →</a>`
  }

  // ---------------------------------------------------------------- 可编辑表格的取值（编辑优先，原值兜底）
  /** 单元格取值：**客户端已改的优先，原值兜底**（键是「面板|行键」，见 `editValueOf`）。
   *  翻页/重绘后格子里显示的仍是"你改的那个值"，不会看起来像把改动丢了。 */
  const cellValue = (panelId, rowKey, field, row) => editValueOf(panelId, rowKey, field, row)
  const numOf = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  /** 列固定的 CSS 类（`pin:'left'|'right'`；`sticky` 的横向偏移由 CSS 的 left/right:0 给）。 */
  const colClass = (column) => (column && column.pin === 'left' ? 'q-pin'
    : (column && column.pin === 'right' ? 'q-pin-right' : ''))

  /**
   * **实时小计**（机制：对插件声明的字段做乘法求和，不解读语义）。
   * 面板声明 `data.totals = [{label, key, factor, unit, count, skip_empty}]` ⇒ 无论用户改的是被乘数（`key`）
   * 还是系数（`factor`），合计都会**在输入时立刻重算**（不用等提交，也不用鼠标离开单元格）。
   * `count:true` = 数"填了值的行数"（不是求和）。
   */
  function totalsOf(data, rows, rowKeyOf, valueOf) {
    const declared = Array.isArray(data.totals) ? data.totals : []
    return declared.map((rule) => {
      let sum = 0
      let counted = 0
      rows.forEach((row, index) => {
        const key = rowKeyOf(row, index)
        const read = (field) => (valueOf ? valueOf(key, field) : (row ? row[field] : undefined))
        if (rule.skip_empty === true && String(read(rule.key) ?? '').trim() === '') return
        if (rule.count === true) { counted += 1; return }
        sum += numOf(read(rule.key)) * (rule.factor === undefined || rule.factor === null ? 1
          : numOf(read(rule.factor)))
        counted += 1
      })
      return { label: String(rule.label ?? rule.key), value: rule.count === true ? counted : sum,
        unit: String(rule.unit ?? ''), counted, key: String(rule.key), factor: rule.factor ?? null,
        count: rule.count === true }
    })
  }

  /** 对比模式（④）：列可以带 `group`；外壳给每个组一个勾选框，2–3 组并排，关键列（无 group）恒在。 */
  function compareGroups(columns) {
    const groups = []
    for (const column of columns) {
      if (!column.group) continue
      if (!groups.some((item) => item.id === column.group)) {
        groups.push({ id: String(column.group), label: String(column.group_label || column.group) })
      }
    }
    return groups
  }
  function pickedGroups(panel, data, groups) {
    const rule = data.compare
    const max = Number.isFinite(Number(rule.max)) ? Number(rule.max) : 3
    const min = Number.isFinite(Number(rule.min)) ? Number(rule.min) : 2
    const saved = state.compare[panel.id]
    const picked = Array.isArray(saved) ? saved.filter((id) => groups.some((g) => g.id === id))
      : groups.slice(0, Math.min(max, groups.length)).map((g) => g.id)
    return { picked: picked.length ? picked : groups.slice(0, Math.min(max, groups.length)).map((g) => g.id),
      min, max, rule }
  }

  function renderTable(panel, data) {
    // 插件可以按**动作 id 字符串**声明行内动作（`row_actions: ['quote.submit']`）—— 必须查表换成动作对象，
    // 否则渲染出来的是一颗空按钮（P2 人类走查实测：PO 追溯 / 人签提交 / 受理 全都点不到）。
    const asAction = (item) => (typeof item === 'string' ? actionOf(item) : item)
    const declared = data.actions || panel.actions || []
    const rowDeclared = data.row_actions || declared
    const bulk = data.bulk ? actionOf(data.bulk) : null
    const allColumns = data.columns || []
    const rows = data.rows || []
    if (!rows.length) {
      return stateBlock({ kind: 'empty', title: '没有行', reason: data.reason || 'no-rows',
        next_action: data.next_action || (data.note || '') })
    }
    // **行键按全量行集算一次**：分页只换窗口，行键不能跟着页变（否则编辑/勾选会串行）。
    const rowKeyOf = (row, index) => String(row.id ?? row[allColumns[0]?.key] ?? index)
    const keyOf = new Map(rows.map((row, index) => [row, rowKeyOf(row, index)]))
    const keyFor = (row, index) => keyOf.get(row) ?? (index === undefined ? '' : rowKeyOf(row, index))
    // ---- ④ 对比模式：勾选 2–3 个列组（如"哪几家的报价"）并排看；关键列（无 group）不参与勾选、恒显示 ----
    const groups = compareGroups(allColumns)
    let columns = allColumns
    let cmpBar = ''
    if (data.compare && groups.length >= 2) {
      const { picked, min, max, rule } = pickedGroups(panel, data, groups)
      state.compare[panel.id] = picked
      columns = allColumns.filter((column) => !column.group || picked.includes(String(column.group)))
      const over = picked.length > max
      cmpBar = `<div class="q-cmp-bar${over ? ' over' : ''}" data-compare-bar="${attr(panel.id)}">`
        + `<b>对比模式</b><span class="q-cmp-count" data-max="${attr(max)}" data-min="${attr(min)}">`
        + `已选 ${picked.length} 组（${min}–${max} 组）`
        + `${rule.hint ? ` · ${esc(rule.hint)}` : ''}</span>`
        + groups.map((group) => `<label><input type="checkbox" data-cmp-group="${attr(group.id)}"`
          + ` data-cmp-panel="${attr(panel.id)}"${picked.includes(group.id) ? ' checked' : ''}> ${esc(group.label)}`
          + `（${allColumns.filter((column) => String(column.group) === group.id).length} 列）</label>`).join('')
        + `${over ? `<span class="q-cmp-warn">最多 ${max} 组：已有的勾选先取消一个再看新的</span>` : ''}`
        + `<button class="q-link" data-cmp-reset="${attr(panel.id)}">全选</button></div>`
    }
    // ---- 查询视图（全量 → 筛选 → 排序 → 窗口）：计数、排序、筛选都在**全量行集**上算 ----------
    const q = queryOf(panel.id)
    const view = queryView(panel.id, columns, rows, q, keyFor, data.query)
    const windowRows = view.window
    const qbar = queryBar(panel.id, columns, view, rows) + activeFilterChips(panel.id, view)
    if (!view.matchedCount) {
      // **筛选后 0 行 ≠ 没有数据**：两个状态分开说，且这里给一键清空（否则用户会以为这块坏了）
      return html([qbar, countBarHtml(panel.id, view),
        `<div class="q-state info" data-state="empty" data-state-reason="filtered-out">`
        + `<b>筛选后 0 行（不是这块没有数据）</b> <code>filtered-out</code>`
        + `<div class="q-hint">这块本来有 <b>${view.total}</b> 行：${esc(querySummary(view.q))} 把这些行全滤掉了。`
        + '筛选只改“看到哪些”，账本与事实一条都没动。</div>'
        + `<div class="q-actions">`
        + `<button class="primary" data-q-clear="${attr(panel.id)}">清空查询，看全部 ${view.total} 行</button>`
        + `<button data-q-reset="${attr(panel.id)}">恢复默认显示</button></div></div>`])
    }
    // 列头：可点排序（升 → 降 → 取消）；`aria-sort` 让屏幕阅读器也知道现在是按哪列排的
    const sortOf = (column) => (q.sort === `${column.key}:asc` ? 'asc'
      : (q.sort === `${column.key}:desc` ? 'desc' : 'none'))
    const thOf = (column) => {
      const sorted = sortOf(column)
      return `<th class="${attr(colClass(column))}" data-q-sort="${attr(panel.id)}"`
        + ` data-q-sort-key="${attr(column.key)}" role="button" tabindex="0"`
        + ` aria-sort="${sorted}" title="点一下：升序 → 降序 → 不排序（只改看到哪些，不改任何事实）">`
        + `${esc(column.label || column.key)}<span class="q-sortmark" aria-hidden="true">${
          sorted === 'asc' ? ' ↑' : (sorted === 'desc' ? ' ↓' : '')}</span></th>`
    }
    const editable = columns.some((column) => column.editable)
    // **勾选状态从 state 回填**（P21 / D2）：翻页之后回到本页，之前勾的行**还是勾着的**（`state.picked`）。
    const picked = pickedOf(panel.id)
    const pageKeys = view.window.map((row, index) => view.rowKeyOf(row, index))
    const pickedOnPage = pageKeys.filter((key) => picked[key]).length
    const head = html([bulk ? `<th class="q-rowsel"><input type="checkbox" data-select-all`
      + `${pageKeys.length && pickedOnPage === pageKeys.length ? ' checked' : ''}`
      + ` aria-label="全选本页（不含其它页）" title="只勾本页这几行；要跨页选全部命中的行，用上面的「选中全部命中行」"></th>` : '',
      columns.map(thOf).join(''), '<th>动作</th>'])
    // `best_when:'min'`（一列里的最小值高亮）：**在命中行集上**算 —— 最小值是数据的性质，不是这一页的性质
    // （服务端窗口开路时这个值由服务端给：客户端手里只有一页，自己算出来的"最小"会随翻页变）
    const mins = {}
    for (const column of columns) {
      if (column.best_when !== 'min') continue
      if (view.mins && view.mins[column.key] !== undefined) { mins[column.key] = view.mins[column.key]; continue }
      let best = Infinity
      for (const row of view.matched) {
        const raw = row[column.key]
        if (raw === '' || raw === undefined) continue
        best = Math.min(best, numOf(raw))
      }
      mins[column.key] = best
    }
    const body = windowRows.map((row, windowIndex) => {
      // 行键 **按全量行集算一次**（服务端窗口下由服务端给 `row_keys`）：翻页/换筛选后行键不跟着页变，
      // 所以编辑（`state.edits` 的键）与跨页选择不会串行。
      const rowKey = view.rowKeyOf(row, windowIndex)
      const cells = columns.map((column) => {
        const raw = row[column.key]
        const value = raw === null || raw === undefined ? '' : String(raw)
        const cls = colClass(column)
        const best = column.best_when === 'min' && raw !== '' && raw !== undefined
          && numOf(raw) === mins[column.key]
        if (column.editable) {
          // **取值顺序：客户端已改的格子 > 面板数据里的原值**（`editValueOf` 按「面板|行键」取 —— 分页换页
          // 后重绘时，别的页上改过的格子也必须显示成你改的值，否则看起来"翻页就把改动丢了"）。
          const extra = column.line_total_of
            ? `<span class="q-linetotal" data-linetotal="${attr(rowKey)}:${attr(column.key)}" data-factor="${attr(column.line_total_of)}">`
              + `×${esc(String(editValueOf(panel.id, rowKey, column.line_total_of, row) ?? '—'))} = `
              + `${numOf(editValueOf(panel.id, rowKey, column.key, row))
                * numOf(editValueOf(panel.id, rowKey, column.line_total_of, row))}</span>`
            : ''
          // 触控可用性：可编辑格在手机上要能看见自己在改哪一列（`data-label` 让小屏卡片视图带列名），
          // 数字格给对键盘（`inputmode`），回车键按语义（`enterkeyhint`）——都是浏览器原生能力。
          const numeric = column.type === 'number'
          const current = editValueOf(panel.id, rowKey, column.key, row)
          const shown = current === null || current === undefined ? '' : String(current)
          return `<td class="${attr(cls)}" data-label="${attr(column.label || column.key)}">`
            + `<input data-edit="${attr(rowKey)}" data-field="${attr(column.key)}"`
            + ` data-type="${attr(column.type || 'text')}" value="${attr(shown)}"`
            + ` data-orig="${attr(value)}"${numeric ? ' inputmode="decimal" enterkeyhint="next"' : ''}`
            + ` placeholder="${attr(column.help || '')}" aria-label="${attr(column.label || column.key)}">${extra}</td>`
        }
        if (column.type === 'code') return `<td class="${attr(cls)}" data-label="${attr(column.label || column.key)}"><code>${esc(value)}</code></td>`
        if (column.type === 'json') return `<td class="${attr(cls)}" data-label="${attr(column.label || column.key)}"><code>${esc(value.slice(0, 220))}</code></td>`
        return `<td class="${attr(cls)}${best ? ' q-cellbest' : ''}" data-label="${attr(column.label || column.key)}">${esc(value)}</td>`
      }).join('')
      // **按行**声明行内动作：行自己带 `row_actions` 时以行为准（机制：有的动作只对某几行成立 ——
      // 例如"确认收到 PO"只该长在真有 PO 的那一行上，否则点别行会送出一个占位符 id）
      const rowDeclaredFor = Array.isArray(row.row_actions) ? row.row_actions : rowDeclared
      const inline = rowDeclaredFor.map((item) => {
        const action = asAction(item)
        if (!action) {
          return `<button disabled title="注册面里没有这个动作（插件可能被卸载了）">`
            + `${esc(String(item))}（本页没有这个动作）</button>`
        }
        const confirm = action.confirm?.required ? ' data-confirm="1"' : ''
        return `<button data-row-action="${attr(action.id)}" data-row='${attr(JSON.stringify(row))}'${confirm}`
          + ` title="${attr(action.hint || '')}">`
          + `${esc(action.title)}${action.permission === 'human-signature' ? ' ✍' : ''}</button>`
      }).join(' ')
      return `<tr data-row-key="${attr(rowKey)}"${picked[rowKey] ? ' class="q-row-picked" data-picked="1"' : ''}>`
        + (bulk ? `<td class="q-rowsel" data-label="选中"><input type="checkbox" data-select="${attr(rowKey)}"`
          + `${picked[rowKey] ? ' checked' : ''} aria-label="选中这一行"></td>` : '')
        + `${cells}<td class="q-rowacts" data-label="动作">${inline} ${rowRefCell(row)}</td></tr>`
    }).join('')
    // 小计（`data.totals`）按**命中行集**算（不是本页）：翻页不会让合计变小；客户端已改的格子优先。
    // 服务端窗口：`view.totals` 就是服务端在命中行集上算好的（已改的格子通过 `pq.edits` 一起送过去）。
    const valueOf = (rowKey, field) => editValueOf(panel.id, rowKey, field, view.byKey.get(rowKey))
    const totals = view.totals ?? totalsOf(data, view.matched, (row) => keyFor(row), valueOf)
    // ④ 对比模式下**每组一列合计**（如"每家报价的行合计总和"）：插件声明 `data.group_totals = {key, unit}`。
    const groupTotals = view.groupTotals ?? ((data.group_totals && groups.length >= 2 && data.compare)
      ? groups.map((group) => {
        let sum = 0
        for (const row of view.matched) {
          for (const column of allColumns) {
            if (String(column.group) !== group.id) continue
            const wanted = data.group_totals.key === undefined ? null : String(data.group_totals.key)
            const prefix = data.group_totals.key_prefix === undefined ? null : String(data.group_totals.key_prefix)
            if (wanted !== null && column.key !== wanted) continue
            if (prefix !== null && !String(column.key).startsWith(prefix)) continue
            sum += numOf(row[column.key])
          }
        }
        return { label: `${group.label} ${esc(data.group_totals.label_suffix || '合计')}`, value: sum,
          unit: String(data.group_totals.unit || ''), raw: true }
      }) : [])
    const controls = html([bulk ? `<button data-bulk="${attr(bulk.id)}" class="primary">${esc(bulk.title)}`
      + `（已选 <span data-selected-count="1">0</span> 行）</button>` : '',
      editable ? `<button data-submit-edits data-panel="${attr(panel.id)}" class="primary">`
        + `提交编辑（<span data-edit-count="${attr(panel.id)}">${editRowsOf(panel.id).length}</span> 行）</button>`
        + `<button data-cancel-edits data-panel="${attr(panel.id)}">放弃改动</button>` : ''])
    const totalBar = (editable || totals.length || groupTotals.length)
      ? `<div class="q-editbar" data-editbar="${attr(panel.id)}">`
        + `${editable ? `<span>已改 <b data-edit-count="${attr(panel.id)}">${editRowsOf(panel.id).length}</b> 行</span>` : ''}`
        + totals.map((item) => `<span class="q-sum" data-total="${attr(item.key)}:${attr(item.factor ?? '')}">`
          + `${esc(item.label)}：<b>${item.value}</b>${item.unit ? ` ${esc(item.unit)}` : ''}</span>`).join('')
        + groupTotals.map((item) => `<span class="q-sum">`
          + `${item.raw ? item.label : esc(item.label)}：<b>${item.value}</b>${item.unit ? ` ${esc(item.unit)}` : ''}</span>`).join('')
        + (view.server
          ? `<span class="q-hint">小计由**服务端**在命中行集上算（${view.matchedCount} 行；本页只有 ${view.window.length} 行）`
            + `，改格子后自动重算一次（重算前不拿本页的数字冒充全集）</span>`
          : `<span class="q-hint">小计按**命中行集**算（${view.matchedCount} 行；不是本页 ${view.window.length} 行）`
            + `，客户端已改的格子优先</span>`)
        + `${editable ? `<span class="q-keys">Tab/Shift+Tab 左右走 · Enter/Shift+Enter 上下走 · Esc 还原这一格 · Ctrl/Cmd+Enter 提交</span>`
          : '<span class="q-keys">这一组勾选只影响看到的列（关键列固定不参与勾选）</span>'}`
        + `</div>`
      : ''
    const wideTable = columns.length > 6 || columns.some((column) => column.pin)
    return html([qbar, cmpBar, `<div class="q-scroll${columns.some((column) => column.pin) ? ' q-scroll-wide' : ''}">`
      + `<table class="q-table${wideTable ? ' q-wide' : ''}" data-panel-table="${attr(panel.id)}">`
      + `<caption class="q-caption">${esc(panel.title)}` + `（本页 ${view.window.length} / 共 ${view.total} 行`
      + `${view.active ? `，命中 ${view.matchedCount}` : ''}）</caption>`
      + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      controls ? `<div class="q-actions">${controls}</div>` : '', totalBar])
  }

  function renderList(panel, data) {
    const server = data.query?.server === true
    const all = data.items || []
    const buckets = bucketsOf(data, all)
    const current = filterOf(panel.id)
    // **跨面板去重**（机制）：这一块里有 N 条与别块面板列的是同一件事（外壳在服务端合并了）——
    // 如实说出来，免得用户以为"少了几条"。合并后的条目带着 `ref`，仍然可以点进对象页。
    const dedupeNote = Number(data.deduped) > 0
      ? `<p class="q-hint" data-dedupe="1" data-dedupe-count="${attr(data.deduped)}">${
        esc(data.dedupe_note || `跨面板去重：合并了 ${data.deduped} 条重复（同一对象被两块面板各列一次）`)}</p>` : ''
    // 桶筛选片的数字：服务端窗口开路时用**服务端在全集上算好的桶计数**（否则只有一页，片上的数字会跟着变小）
    const counts = server ? { '': Number(data.query.total_full) || 0, ...(data.query.bucket_counts || {}) } : null
    const bar = bucketBar(panel.id, buckets, current, all, counts)
    // 服务端窗口：桶筛选**已经在服务端做过**（`pq.<面板>.bucket`），这里别再筛第二遍（会把窗口再切小）
    const items = server ? all : byBucket(all, current)
    if (!items.length) {
      return bar + dedupeNote + stateBlock({ kind: 'empty',
        title: current === '' ? '没有条目' : '这一桶里没有条目（不是坏了）',
        reason: current === '' ? (data.reason || 'no-items') : `bucket=${current}`,
        next_action: data.next_action || (current === '' ? '' : '点筛选片上的「全部」看所有条目') })
    }
    // 长列表同样**窗口化渲染 + 关键字搜索**（工作台的待办可能上百条：一次全渲染会把首屏拖慢，
    // 而且翻不到"还有没有别的"）。计数与表一样在**全量/命中集**上算，本页只代表窗口。
    const columns = (data.columns || []).concat(data.columns ? [] : [{ key: 'title', label: '标题' },
      { key: 'body', label: '详情' }, { key: 'next_action', label: '下一步' }])
    const q = queryOf(panel.id)
    const view = queryView(panel.id, columns, items, q, (row, index) => String(row.id ?? index), data.query)
    const qbar = queryBar(panel.id, columns, view, items) + activeFilterChips(panel.id, view)
    if (!view.matchedCount) {
      return bar + qbar + `<div class="q-state info" data-state="empty" data-state-reason="filtered-out">`
        + `<b>筛选后 0 条（不是这块没有条目）</b> <code>filtered-out</code>`
        + `<div class="q-hint">这一桶本来有 ${view.total} 条：${esc(querySummary(view.q))} 把它们全滤掉了。</div>`
        + `<div class="q-actions"><button class="primary" data-q-clear="${attr(panel.id)}">清空查询</button></div></div>`
    }
    const listBody = view.window.map((item) => {
      const action = item.action ? actionOf(item.action) : null
      const href = refLink(item.ref)
      return `<li data-level="${attr(item.level || 'info')}"${item.bucket ? ` data-bucket="${attr(item.bucket)}"` : ''}>`
        + `${item.level ? badge(item.level, item.level === 'bad' ? 'bad' : (item.level === 'warn' ? 'warn'
          : (item.level === 'ok' ? 'ok' : ''))) + ' ' : ''}`
        + `<span class="q-li-title">${esc(item.title || item.label || '')}</span>`
        + `${item.merged_count > 1 ? ` <span class="q-tag" data-merged-count="${attr(item.merged_count)}"`
          + ` title="${attr(`这一条在 ${item.merged_count} 块面板里都出现过，外壳合并成了一条：${
            (item.also_from || []).map((row) => row.panel_id).join(' / ')}`)}">合并 ${item.merged_count} 块</span>` : ''}`
        + `${item.bucket_label ? ` <span class="q-tag q-bucket-tag">${esc(item.bucket_label)}</span>` : ''}`
        + `${item.body ? `<div class="q-li-body">${esc(item.body)}</div>` : ''}`
        + `${action || href ? `<div class="q-actions">${action
          ? `<button class="primary" data-action="${attr(action.id)}" data-preset='${attr(JSON.stringify(item.ref || {}))}'>`
            + `${esc(item.label || action.title)}</button>` : ''}${href
          ? `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(item.ref.kind)}"`
            + ` data-v="${attr(item.ref.view || '')}" data-id="${attr(item.ref.id)}">打开 ${esc(refLabel(item.ref))} →</a>` : ''}</div>` : ''}`
        + `${item.next_action ? `<div class="q-hint">下一步：<code>${esc(item.next_action)}</code></div>` : ''}</li>`
    }).join('')
    return bar + dedupeNote + qbar + `<ul class="q-list">${listBody}</ul>`
  }

  function renderData(panel, data) {
    const kind = data.kind || panel.panel_kind
    const degraded = data.degraded
      ? stateBlock({ kind: 'degraded', title: '降级（不冒充健康）', reason: data.reason || 'degraded',
        next_action: data.next_action || '' })
      : ''
    const body = renderBody(kind, panel, data)
    return degraded + body
  }

  /**
   * **文件集合面板**（形状 `files`，机制）：插件声明"这个对象挂着一批文件"，外壳只按形状渲染 ——
   * 拖拽上传区（多文件）+ 文件表（文件名/大小/上传人/时间/sha256/可见性）+ 每行下载与删除入口。
   * 机制不认识"附件"这个业务概念：上传地址、删除动作、可见性选项都由插件在 `data` 里声明。
   */
  function renderFiles(panel, data) {
    const allFiles = data.files || []
    // 附件同样**可搜 + 窗口化渲染**（一个对象上挂几百个回签件/质检报告时，一次全渲染既慢又找不到）。
    const fileColumns = [{ key: 'name', label: '文件名' }, { key: 'uploader', label: '上传人' },
      { key: 'at', label: '时间' }, { key: 'sha256', label: 'sha256', filter: 'text' },
      { key: 'visibility_label', label: '给谁看', filter: 'enum' }, { key: 'bytes', label: '大小', filter: 'number' }]
    const q = queryOf(panel.id)
    const view = queryView(panel.id, fileColumns, allFiles, q, (row, index) => String(row.id ?? index), data.query)
    const rows = view.window
    const qbar = allFiles.length > 0 ? queryBar(panel.id, fileColumns, view, allFiles) + activeFilterChips(panel.id, view) : ''
    const upload = data.upload || null
    const rowAction = (Array.isArray(data.row_actions) ? data.row_actions : []).find((id) => actionOf(id))
    const visSelect = (upload && upload.visibility && (upload.visibility.options || []).length)
      ? `<div class="q-drop-vis"><label>这个文件给谁看： <select data-file-visibility="1">${
        upload.visibility.options.map((option) => `<option value="${attr(option.value)}"${
          option.value === upload.visibility.default ? ' selected' : ''} title="${attr(option.help || '')}">${
          esc(option.label)}</option>`).join('')}</select></label></div>`
      : ''
    const zone = upload ? html([
      `<div class="q-drop" data-dropzone="1" tabindex="0" role="group" aria-label="拖拽上传或选择文件"`,
      ` data-upload-url="${attr(upload.url)}" data-upload-kind="${attr(upload.kind)}"`,
      ` data-upload-id="${attr(upload.id)}" data-name-param="${attr(upload.name_param || 'name')}"`,
      ` data-visibility-param="${attr(upload.visibility_param || 'visibility')}">`,
      `<div class="q-drop-big">把文件拖到这里</div>`,
      `<div>或 <button class="primary" data-file-pick="1">选择文件</button>`,
      `${upload.multiple ? '（可多选）' : ''}`,
      `<input type="file" hidden data-file-input="1"${upload.multiple ? ' multiple' : ''}`,
      `${upload.accept ? ` accept="${attr(upload.accept)}"` : ''}></div>`,
      visSelect,
      `${upload.help ? `<div class="q-hint">${esc(upload.help)}</div>` : ''}`,
      `<div class="q-hint">上传人 = 你的会话身份；文件名/大小/时间/sha256 会记下来，**正文不进账本**`,
      `（落 0600 存储）。对方能不能看由「给谁看」这一档决定。</div>`,
      `<div class="q-drop-status" data-drop-status="1"></div></div>`]) : ''
    const head = `<thead><tr><th>文件名</th><th>大小</th><th>上传人</th><th>时间</th><th>sha256</th>` +
      `<th>给谁看</th><th>操作</th></tr></thead>`
    const body = rows.length ? rows.map((row) => {
      const deleted = row.deleted === true
      return `<tr data-file-row="${attr(row.id)}"${deleted ? ' class="q-file-deleted"' : ''}>` +
        `<td>${deleted ? `<s>${esc(row.name)}</s>` : `<a class="q-deeplink" href="${attr(row.url)}"` +
          ` data-file-download="1" download="${attr(row.name)}" title="下载（按侧与身份校验；带 sha256 校验头）">` +
          `${esc(row.name)}</a>`}</td>` +
        `<td>${esc(row.bytes_label || row.bytes)}</td>` +
        `<td><code>${esc(row.uploader)}</code></td>` +
        `<td>${esc(row.at)}</td>` +
        `<td><code title="${attr(row.sha256)}">${esc(row.sha256_short || row.sha256)}</code>` +
          `<button class="q-link" data-copy="${attr(row.sha256)}" title="复制完整 sha256（用来对账）">复制</button></td>` +
        `<td>${esc(row.visibility_label || row.visibility)}</td>` +
        `<td>${deleted
          ? `已删除（${esc(row.deleted_by || '')} @ ${esc(row.deleted_at || '')}）—— 留痕：墓碑 + trash/`
          : `<a class="q-deeplink" href="${attr(row.url)}" download="${attr(row.name)}">下载</a>` +
            `${rowRowDelete(row, rowAction)}`}</td></tr>`
    }).join('') : ''
    const live = view.filesCounts ? view.filesCounts.live : view.matched.filter((row) => row.deleted !== true).length
    const dead = view.filesCounts ? view.filesCounts.dead : view.matchedCount - live
    const fileCounts = `<div class="q-qcount" data-q-count="${attr(panel.id)}"`
      + ` data-count-total="${attr(view.total)}" data-count-matched="${attr(view.matchedCount)}"`
      + ` data-count-window="${attr(view.window.length)}" data-page="${attr(view.page + 1)}"`
      + ` data-count-full="${attr(view.rowsFull)}" data-server-paged="${attr(view.server ? 1 : 0)}"`
      + ` data-pages="${attr(view.pages)}"><span>共 <b>${view.total}</b> 个文件记录</span>`
      + `<span>命中 <b>${view.matchedCount}</b>（活的 ${live}`
      + `${dead ? `，已删留痕 ${dead}` : ''}）</span>`
      + `<span>第 ${view.page + 1}/${view.pages} 页（本页 ${view.window.length} 行）</span>`
      + `${state.panelBusy?.[panel.id] === true ? '<span class="q-hint">正在取这一页…</span>' : ''}</div>`
    const table = rows.length
      ? `<div class="q-scroll"><table class="q-table q-files-table" data-panel-table="${attr(panel.id)}">` +
        `<caption class="q-caption">${esc(panel.title)}（本页 ${rows.length} / 共 ${view.total} 个文件记录` +
        `${view.active ? `，命中 ${view.matchedCount}` : ''}）` +
        `</caption>${head}<tbody>${body}</tbody></table></div>`
      : (allFiles.length
        ? `<div class="q-state info" data-state="empty" data-state-reason="filtered-out">`
          + `<b>筛选后 0 个附件（不是没有附件）</b> <code>filtered-out</code>`
          + `<div class="q-hint">这个对象上本来挂着 ${view.total} 个：${esc(querySummary(view.q))} 把它们全滤掉了。</div>`
          + `<div class="q-actions"><button class="primary" data-q-clear="${attr(panel.id)}">清空查询</button></div></div>`
        : stateBlock({ kind: 'empty', title: '这个对象上还没有附件（不是坏了）', reason: 'no-attachments',
          hint: '现实采购里这一步是硬需求：技术规格、质检报告、回签的 PO 都挂在这里。',
          next_action: data.next_action || '把文件拖到上面的方块里，或点「选择文件」' }))
    const countsBar = data.counts
      ? `<p class="q-hint" data-file-counts="1">活的 ${esc(data.counts.live ?? 0)} · 本侧上传 ${esc(data.counts.mine ?? 0)}` +
        ` · 已删（留痕）${esc(data.counts.deleted ?? 0)}` +
        `${data.counts.visible_ids !== undefined ? ` · 本侧可见的同类对象 ${esc(data.counts.visible_ids)} 个` : ''}` +
        `${data.visibility_rule ? ` · ${esc(data.visibility_rule)}` : ''}</p>`
      : ''
    return html([zone, qbar, fileCounts, table, countsBar])
  }

  /** 一行的删除入口（做成"打开那个动作"的按钮：行内动作与表格同一套机制，不懂业务）。
   *  **只有 `deletable:true` 的行才给按钮**（插件已经判过"是不是我上传的"）：界面不摆一个按下去必被拒的按钮。 */
  function rowRowDelete(row, actionId) {
    if (!actionId || row.deleted === true || row.deletable !== true) return ''
    const action = actionOf(actionId)
    return `<button data-action="${attr(actionId)}" data-preset='${attr(JSON.stringify({ id: row.id }))}'` +
      ` title="${attr(action.title)}">删除（留痕）</button>`
  }
  function renderBody(kind, panel, data) {
    if (kind === 'table') return renderTable(panel, data)
    if (kind === 'files') return renderFiles(panel, data)
    if (kind === 'metrics') {
      return `<div class="q-metrics">${(data.metrics || []).map((item) =>
        `<div class="q-metric"><b>${esc(item.value)}</b><span>${esc(item.label)}</span></div>`).join('')}</div>`
    }
    if (kind === 'kv') {
      // kv 也是"行"（`key/value` 一对一行）：同样按需取窗口 —— 一个对象上挂 900 条预填读数时，
      // 一次全渲染既慢又翻不到后面；计数/搜索/分页与表同一条机制（服务端窗口有就照抄服务端的数字）。
      const cols = [{ key: 'key', label: '键' }, { key: 'value', label: '值' }]
      const items = data.items || []
      const q = queryOf(panel.id)
      const view = queryView(panel.id, cols, items, q, (row, index) => String(row.id ?? index), data.query)
      // 只有"真的多到要翻页"或"用户筛过"才摆查询条（一两行的读数不该长出一条搜索框）
      const showBar = view.total > view.size || view.active || view.window.length < view.total
      const qbar = (view.size && showBar) ? queryBar(panel.id, cols, view, items) + activeFilterChips(panel.id, view) : ''
      if (view.size && !view.matchedCount) {
        return qbar + `<div class="q-state info" data-state="empty" data-state-reason="filtered-out">`
          + `<b>筛选后 0 条（不是这块没有数据）</b> <code>filtered-out</code>`
          + `<div class="q-hint">这块本来有 ${view.total} 条：${esc(querySummary(view.q))} 把它们全滤掉了。</div>`
          + `<div class="q-actions"><button class="primary" data-q-clear="${attr(panel.id)}">清空查询</button></div></div>`
      }
      return qbar + `<dl class="q-kv">${view.window.map((item) =>
        `<dt>${esc(item.key)}</dt><dd>${item.code ? `<code>${esc(item.value)}</code>` : esc(item.value)}</dd>`).join('')}</dl>`
    }
    if (kind === 'list') return renderList(panel, data)
    if (kind === 'form') return `<p class="q-hint">${esc(data.note || '')}</p>`
    if (kind === 'html') return data.html || ''
    return stateBlock({ kind: 'error', title: '不认识的面板形状', reason: kind,
      next_action: '这是插件与外壳的形状不一致：用 panel_kind 里声明过的形状之一' })
  }

  // ---------------------------------------------------------------- ② 面板布局（折叠 / 拖拽排序 / 持久化）
  /** 布局桶的键：视图 + 对象类（同一视角的列表页与对象页各记各的）。 */
  const layoutKey = () => `${state.route.view}${state.route.kind ? `/${state.route.kind}` : ''}`
  const layoutOf = () => {
    const key = layoutKey()
    const found = state.layout[key]
    return { key, order: Array.isArray(found?.order) ? found.order : [],
      collapsed: Array.isArray(found?.collapsed) ? found.collapsed : [],
      hidden: Array.isArray(found?.hidden) ? found.hidden : [] }
  }
  const saveLayout = (next) => {
    state.layout[layoutKey()] = { order: next.order, collapsed: next.collapsed, hidden: next.hidden }
    store.set(KEYS.layout, state.layout)
    pushNotifState()            // 布局**服务端化**：按身份落 0600 文件 ⇒ 换浏览器/换设备仍是这套布局
  }
  /** 按保存的顺序排面板（没记过的面板按插件声明的 order 排在后面 —— 不猜，只补位）。 */
  function orderedPanels() {
    const { order, collapsed, hidden } = layoutOf()
    const list = state.panels.filter((panel) => panel.visible !== false && !hidden.includes(panel.id))
    if (!order.length) return { list: list.map((panel) => ({ panel, collapsed: collapsed.includes(panel.id) })),
      collapsed, hidden }
    const known = list.filter((panel) => order.includes(panel.id))
      .sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
    const rest = list.filter((panel) => !order.includes(panel.id))
    return { list: [...known, ...rest].map((panel) => ({ panel, collapsed: collapsed.includes(panel.id) })),
      collapsed, hidden, key: layoutOf().key }
  }
  function movePanel(panelId, delta) {
    const shown = orderedPanels().list.map((item) => item.panel.id)
    const at = shown.indexOf(panelId)
    const to = at + delta
    if (at < 0 || to < 0 || to >= shown.length) return
    shown.splice(to, 0, shown.splice(at, 1)[0])
    const layout = layoutOf()
    saveLayout({ order: shown, collapsed: layout.collapsed, hidden: layout.hidden })
    renderPanels()
    toast('ok', '面板顺序已保存', notifSource === 'server'
      ? `已按你的身份写到服务端（${notifStateNote}）`
      : '刷新页面后仍是这个顺序（未登录：只在本浏览器里）')
  }
  function dropPanel(dragId, targetId, before) {
    const shown = orderedPanels().list.map((item) => item.panel.id).filter((id) => id !== dragId)
    const at = shown.indexOf(targetId)
    if (at < 0) return
    shown.splice(before ? at : at + 1, 0, dragId)
    const layout = layoutOf()
    saveLayout({ order: shown, collapsed: layout.collapsed, hidden: layout.hidden })
  }
  function toggleCollapse(panelId, force) {
    const layout = layoutOf()
    const has = layout.collapsed.includes(panelId)
    const next = (force === undefined ? !has : force)
    const collapsed = next ? [...new Set([...layout.collapsed, panelId])]
      : layout.collapsed.filter((id) => id !== panelId)
    saveLayout({ order: layout.order, collapsed, hidden: layout.hidden })
    renderPanels()
  }
  function layoutBar(count) {
    const layout = layoutOf()
    const collapsed = layout.collapsed.length
    const saved = layout.order.length || collapsed
    const inner = `<span>布局（这块是你自己的）：${count} 块面板`
      + `${collapsed ? ` · 收起 ${collapsed}` : ''}`
      + `${saved ? ` · 已保存过（刷新后仍在）` : ' · 未改过'}</span>`
      + `<button data-layout="collapse-all">收起全部</button>`
      + `<button data-layout="expand-all">展开全部</button>`
      + `<button data-layout="reset">恢复默认布局</button>`
      + `<span class="q-hint">拖动面板标题左边的 ⠿ 换顺序；键盘：焦点在 ⠿ 上按 Alt+↑/↓`
      + `${notifSource === 'server' ? '｜布局按你的身份存在服务端（换浏览器/换设备仍在）'
        : '｜布局只在本浏览器（登录后落服务端）'}</span>`
    // **窄屏把它折起来**（P21 / D3）：布局是低频操作，而这一条 + 视图头在手机上占掉首屏一半。
    // 折起来 ≠ 少按钮：点开 summary 就是原来那一行（`data-layout-bar` 仍在根节点上，脚本照旧找得到）。
    return narrowUi(900)
      ? `<details class="q-layoutbar q-layoutbar-fold" data-layout-bar="${attr(layout.key)}">`
        + `<summary>布局：${count} 块面板${collapsed ? ` · 收起 ${collapsed}` : ''}`
        + `${saved ? ' · 已保存过' : ''}（点开：收起/展开/恢复默认 · 拖动排序说明）</summary>`
        + `<div class="q-layoutbar-inner">${inner}</div></details>`
      : `<div class="q-layoutbar" data-layout-bar="${attr(layout.key)}">${inner}</div>`
  }

  /**
   * 一块面板：标题行（拖拽把手 + 折叠 + 收起）+ 机制折叠 + 正文。
   * 正文放在 `.q-body` 里 —— 收起时只隐藏正文，标题与深链仍在（收起来不等于"这块没了"）。
   */
  function panelSection(panel, collapsed) {
    if (panel.visible === false) return ''
    const body = panel.error
      ? stateBlock({ kind: 'error', title: '这块面板渲染失败', reason: panel.error.reason || panel.error.code,
        next_action: panel.next_action || '修插件里这块的 data()' })
      : renderData(panel, panel.data || {})
    const wide = panel.wide || (panel.data || {}).kind === 'table' || panel.panel_kind === 'table'
    // 面板自报"我讲的是哪一个对象"（`data.ref`）⇒ 在标题旁给一条对象深链（机制：不猜对象类）
    const panelRef = (panel.data || {}).ref
    const refHref = refLink(panelRef)
    const mech = html(['由 <code>', esc(panel.plugin_id), '</code> 注册 · 形状 <code>',
      esc(panel.panel_kind), '</code>', panel.object_kind ? ` · 对象类 <code>${esc(panel.object_kind)}</code>` : '',
      ` · order ${esc(panel.order)}`])
    return `<section class="q-panel${wide ? ' wide' : ''}${panel.error ? ' q-err' : ''}${collapsed ? ' collapsed' : ''}"`
      + ` data-panel="${attr(panel.id)}" data-panel-plugin="${attr(panel.plugin_id)}">`
      + `<div class="q-panel-head"><button class="q-drag" draggable="true" data-drag="${attr(panel.id)}"`
      + ` title="拖动换顺序（键盘：焦点在这里按 Alt+↑ / Alt+↓）" aria-label="拖动排序">⠿</button>`
      + `<h3>${esc(panel.title)}${refHref ? ` <a class="q-deeplink" href="${attr(refHref)}"`
        + ` data-open-object="1" data-k="${attr(panelRef.kind)}" data-v="${attr(panelRef.view || '')}"`
        + ` data-id="${attr(panelRef.id)}"`
        + ` title="打开 ${attr(refLabel(panelRef))} 的对象页（可复制分享）">打开对象 →</a>` : ''}</h3>`
      + `<button class="q-panel-btn" data-collapse="${attr(panel.id)}" aria-expanded="${collapsed ? 'false' : 'true'}"`
      + ` title="${collapsed ? '展开这块' : '收起这块（收起后标题与深链仍在）'}">${collapsed ? '▸' : '▾'}</button></div>`
      + `<details class="q-mech"><summary>机制（这块是谁注册的）</summary><div class="q-src">${mech}</div></details>`
      // **手机上面板说明默认收起**（P21 / D3）：插件写的"这块怎么用"常有几行，390px 下它就是首屏杀手；
      // 收起来不等于删掉 —— summary 上写着"怎么用"，点开就是原文。
      + `${hintBlock(panel.hint)}`
      + `<div class="q-body">${body}</div></section>`
  }

  /** 窄屏判据（机制，一处定义）：`narrowUi(560)` = 手机上那一档（面板说明/查询条折叠也用同一把尺子）。 */
  function narrowUi(maxPx) {
    try {
      return window.matchMedia(`(max-width: ${Number(maxPx) || 560}px)`).matches
        // **横屏手机**：高度比宽度更紧（844×390 实测：面板头一样把首屏吃光）—— 所以判据里带上高度
        || window.matchMedia('(max-height: 520px)').matches
    } catch (err) { return false }
  }

  /**
   * 面板说明（插件写的"这块怎么用"）：宽屏照旧一行 `q-hint`；**手机（≤560px）默认收起**（P21 / D3）
   * —— 390px 下几行说明就是"首屏看不到数据行"的主因之一。收起来 ≠ 删掉：summary 点开就是原文。
   */
  function hintBlock(hint) {
    if (!hint) return ''
    if (!narrowUi(560)) return `<p class="q-hint">${esc(hint)}</p>`
    return `<details class="q-panel-hint"><summary>这块怎么用（说明）</summary>`
      + `<p class="q-hint">${esc(hint)}</p></details>`
  }

  /** 只重画面板区（折叠 / 拖拽 / 对比模式都是纯客户端状态，不必再问服务端要一遍数据）。 */
  function renderPanels() {
    const holder = el('q-view').querySelector('.q-panels')
    if (!holder) return
    const { list } = orderedPanels()
    holder.innerHTML = list.map((item) => panelSection(item.panel, item.collapsed)).join('')
    const bar = el('q-view').querySelector('[data-layout-bar]')
    if (bar) bar.outerHTML = layoutBar(list.length)
    bindPanels()
    bindInteractions()
    bindFiles(el('q-view'))          // ⑥ 文件集合面板（附件）：拖拽上传 / 选择文件 / 键盘
    updateSelectedCount()            // 重绘后计数按**真勾着的**算（P21 / D2）
  }


  function toolbarHtml(actions, label) {
    if (!actions.length) return ''
    return `<div class="q-actions" data-toolbar="${attr(label)}">` + actions.map((action) =>
      `<button data-action="${attr(action.id)}"${action.confirm?.required ? ' data-confirm="1"' : ''}`
      + ` title="${attr(action.hint || '')}">${esc(action.title)}`
      + `${action.permission === 'human-signature' ? ' ✍' : ''}</button>`).join('') + '</div>'
  }

  // ---------------------------------------------------------------- 空态：先说人话 + 2–3 个真能做的下一步
  /** 一行"业务数据"至少要**能指得出对象**（机制只按通用形状判，不看业务名词）：
   *  `id`（对象 id）/ `ref`（对象深链）/ `action`（行内可执行的动作）/ `bucket`（筛选片归属）。
   *  四个都没有的行，是面板**自己在说"我这里没有东西"**或给"下一步"的说明行（如 `gate.todo` 的
   *  「没有待批的门」）—— 它照旧渲染、逐条如实列出，但不该把整块面板算成"有数据"。 */
  const ADDRESSABLE_ROW_KEYS = ['id', 'ref', 'action', 'bucket']
  const rowPointsToSomething = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false
    return ADDRESSABLE_ROW_KEYS.some((key) => {
      const value = row[key]
      if (value === undefined || value === null) return false
      if (typeof value === 'object') return Object.keys(value).length > 0
      return String(value).trim() !== ''
    })
  }
  /**
   * **这块面板有没有"业务数据"**（机制，只看通用形状与声明 —— 外壳不认识任何业务）：
   * `table.rows` / `list.items` / `kv.items` / `files.files`（活的）非空，或插件自己报的 `counts` 里有非零。
   * 三条**例外**（都是声明或通用形状，不是外壳猜的）：
   *   · `panel.not_data === true`（说明类/运营配置类：沙盘入口、名册与角色、导出偏好…）**不参与**这个判断
   *     —— 它照旧渲染、照旧有数据，只是不把空态挤掉；
   *   · **降级（`degraded`）不算有数据**：降级只是"读不到/还没轮到它"。
   *   · **读数不算数据、说明行不算一行数据**（P31 收口；判据仍然只有形状）：
   *     `html`（说明）/ `metrics`（读数）与 **`kv`（键值读数：落点 / 权限 / 上限 / 版本规则…）零也常显示**
   *     —— 键值面板里那几条**永远是面板自己的口径说明**，不能证明"这一屏有活"；
   *     `list` 的 `items[]` 里**没有任何一行能指得出对象**（见 `rowPointsToSomething`）⇒ 这一屏是在说
   *     "我这里没有东西"。
   *     空账本首屏此前被判成 `has-data` 的两处正是这两类（`system/approval#gate.todo` 的说明行、
   *     `system/attachments#attach.store-home` 的键值读数）—— 两个插件都不在可改面内，所以收口只能落在
   *     **机制**这一侧（就是下面这些规则）；`counts` 非零照旧算有数据（读数面板里真报了数就不算空）。
   *     `rows`（表格）不受影响：表格的每一行都是面板列出来的一条记录。
   */
  function panelHasData(panel) {
    if (!panel || panel.not_data === true) return false
    const data = panel.data || {}
    if (data.degraded === true) return false
    if (data.counts && Object.values(data.counts).some((value) => Number(value) > 0)) return true
    if (Array.isArray(data.rows) && data.rows.length) return true
    if (Array.isArray(data.files) && data.files.some((file) => file && file.deleted !== true)) return true
    if (Array.isArray(data.items) && data.items.some(rowPointsToSomething)) return true
    return false
  }
  /**
   * **工作台（`home`）的空态判据**（P31 收口，home 专用规则）：工作台是**导向页** —— 它的面板
   * 全是"读数 + 下一步"（各自的插件已经用 `not_data` 声明"这块不参与空态判断"），所以**只看面板**
   * 会把"我这里有活"说成"空"。
   *
   * 判据只有一条（通用形状，不看业务名词）：工作台上**有没有一条"指得出对象"或"标了急"的待办** ——
   *   · `ref.kind` + `ref.id` 都在 ⇒ 这条待办指向一个真对象（点得进去 → 说明确实有东西）；
   *   · `level` 是 `warn`/`bad` ⇒ 这条待办现在卡着人（与 `quiet` 判据同一个口径）。
   * 一条都没有 ⇒ 这一屏确实还没开始（空账本首屏就是这种情况）。
   * 为什么不数"有按钮的待办"：导向页的每一条下一步**天生都带一个按钮**（"备一份草稿"），拿它当
   * "有数据"会把空账本判成有活 —— 这正是 P31 之前 `gate.todo` / `attach.store-home` 那两处误判的同型错误。
   */
  function workbenchHasNothing() {
    return !todoItems().items.some((item) => (item.ref && item.ref.kind && item.ref.id)
      || item.level === 'warn' || item.level === 'bad')
  }
  /** 这一屏**一块有业务数据的面板都没有**（P28 实测：承包商的墙是 39 块空面板）—— 空态判据。
   *  返回 `withData`（哪几块算有数据）也是给对账用的：一眼能看出"为什么这一屏不算空"。 */
  function viewEmptiness() {
    const list = orderedPanels().list.map((item) => item.panel)
    const withData = list.filter(panelHasData)
    const home = state.route.view === 'home'
    const panelsEmpty = list.length > 0 && withData.length === 0
    const nothingTodo = !home || workbenchHasNothing()
    return { total: list.length, withData, home, home_nothing: home ? nothingTodo : null,
      empty: panelsEmpty && nothingTodo }
  }
  const viewIsEmpty = () => viewEmptiness().empty
  /** 空态/非空态都要留一个**机器可读**的读数（截图之外还能逐条对账）。 */
  function emptinessMark() {
    const { total, withData, empty, home, home_nothing: homeNothing } = viewEmptiness()
    return `<div class="q-emptiness" data-view-emptiness="${empty ? 'empty' : 'has-data'}"`
      + ` data-panels-total="${total}" data-panels-with-data="${attr(withData.map((panel) => panel.id).join(','))}"`
      + ` data-emptiness-basis="${empty ? (home ? 'panels+todo' : 'panels') : 'has-data'}"`
      + `${home ? ` data-home-nothing="${homeNothing ? '1' : '0'}"` : ''}`
      + ` hidden></div>`
  }
  /**
   * **起步块**（空态）：人话由**插件**写（`guide` 贡献的 `summary`），按钮由**注册面的动作**来 ——
   * 最多 3 步，每一步点了就真开那个动作的表单（`input` 是插件给的预填）。查不到的动作**如实略过并计数**，
   * 绝不摆一颗按不动的按钮。这一块还写明"下面那 N 块面板为什么是空的"（它们是等活的面板，不是坏了）。
   */
  function startBlock({ heading = '这一屏还是空的（不是坏了）', empty = true } = {}) {
    const guides = (state.surface.guides || []).filter((guide) => guide.view === state.route.view)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    const summaries = guides.map((guide) => guide.summary).filter((text) => String(text || '').trim() !== '')
    const steps = []
    let missing = 0
    for (const guide of guides) {
      for (const step of (guide.steps || [])) {
        if (steps.length >= 3) break
        const action = actionOf(step.action)
        if (!action) { missing += 1; continue }
        steps.push({ guide, step, action })
      }
    }
    const list = orderedPanels().list.map((item) => item.panel)
    return `<section class="q-start" data-start-block="1" data-start-steps="${steps.length}">
  <h2>${esc(heading)}</h2>
  ${summaries.map((text) => `<p class="q-start-summary">${esc(text)}</p>`).join('')
    || '<p class="q-start-summary">还没有插件为这一屏写"这里是干什么的"——下面是现在真能做的下一步。</p>'}
  ${steps.length ? `<div class="q-actions q-start-steps">${steps.map((item, index) =>
    `<button class="primary" data-guide-action="${attr(item.action.id)}" data-guide-index="${attr(index)}"`
    + ` title="${attr(item.action.hint || '')}">${esc(item.step.label || item.action.title)}`
    + `${item.action.permission === 'human-signature' ? ' ✍' : ''}</button>`).join('')}</div>
    <ul class="q-start-notes">${steps.map((item) => item.step.note
      ? `<li>${esc(item.step.note)}</li>` : '').join('')}</ul>` : ''}
  <p class="q-hint" data-start-wall="1">${empty
    ? `这一屏现在有 <b>${list.length}</b> 块面板，它们都还没有数据 —— 它们是"等活"的面板（谁注册的就在谁名下），不是坏了。`
      + `${missing ? `另有 ${missing} 个起步按钮指向的动作当前没装（如实略过，不摆按不动的按钮）。` : ''}`
      + '想看完整流转也可以点上面的演示数据。'
    : `眼下没有卡住你的事：这一屏有 <b>${list.length}</b> 块面板（读数、配置与对账面），收在下面那一栏里，点开就能看。`
      + `${missing ? `另有 ${missing} 个起步按钮指向的动作当前没装（如实略过）。` : ''}`}</p>
</section>`
  }

  // ---------------------------------------------------------------- 工作台：「你现在该做什么」
  /**
   * 待办聚合（机制）：把这一页上各面板报的条目汇到一起，按级别排（急的在前）。
   *
   * **服务端窗口**：面板只下发"排在前面的那几条"（`data.query.head`）—— 但**数字**一个都不能少：
   * `total_full` / `level_counts` / `bucket_counts` / `level_by_bucket` 都是服务端在**全集**上算的，
   * 所以"有 N 件需要你处理"仍然是全集上的数字（不是"有 8 件"）。
   */
  function todoItems() {
    const out = []
    let total = 0
    let urgent = 0
    let degraded = 0
    const bucketTotal = {}
    const bucketUrgent = {}
    let windowed = false
    for (const panel of state.panels) {
      // **降级（读不到）的面板不参与待办聚合**（P31 收口，与 `panelHasData` 的"降级不算有数据"同一口径）：
      // 降级面板给的条目是"未登录 / 读不到"的说明行（如协作面的「未登录：先登录才知道哪些是「我的今日」」），
      // 把它们算进「有 N 件需要你处理」正是 P31 前空账本首屏的另一处误判来源（未登录时那两行全是 warn）。
      // 面板自己的说明行照旧在那一块里渲染 —— **不隐藏任何东西**，只是不冒充待办。
      if ((panel.data || {}).degraded === true) { degraded += 1; continue }
      const q = (panel.data || {}).query
      if (q && q.server === true && Array.isArray(q.head)) {
        windowed = true
        total += Number(q.total_full) || 0
        const levels = q.level_counts || {}
        urgent += (Number(levels.warn) || 0) + (Number(levels.bad) || 0)
        for (const [key, n] of Object.entries(q.bucket_counts || {})) {
          bucketTotal[key] = (bucketTotal[key] || 0) + (Number(n) || 0)
        }
        for (const [key, lv] of Object.entries(q.level_by_bucket || {})) {
          bucketUrgent[key] = (bucketUrgent[key] || 0) + (Number(lv.warn) || 0) + (Number(lv.bad) || 0)
        }
        for (const item of q.head) out.push({ ...item, panel_id: panel.id, plugin_id: panel.plugin_id })
        continue
      }
      const items = ((panel.data || {}).items || [])
      total += items.length
      for (const item of items) {
        const key = String(item.bucket ?? '')
        const hot = item.level === 'warn' || item.level === 'bad'
        if (hot) urgent += 1
        if (key !== '') {
          bucketTotal[key] = (bucketTotal[key] || 0) + 1
          if (hot) bucketUrgent[key] = (bucketUrgent[key] || 0) + 1
        }
        out.push({ ...item, panel_id: panel.id, plugin_id: panel.plugin_id })
      }
    }
    const rank = { bad: 0, warn: 1, info: 2, ok: 3 }
    const items = out.sort((left, right) => (rank[left.level] ?? 2) - (rank[right.level] ?? 2))
    return { items, total, urgent, bucketTotal, bucketUrgent, windowed, degraded }
  }

  function workbenchHtml() {
    const tally = todoItems()
    const items = tally.items
    const last = lastRoute()
    const actions = state.surface.actions.filter((action) => !action.inline)
    const groups = [...new Set(actions.map((action) => action.group || '通用'))]
    // 「我的 / 我指派的 / 全部」：条目可以带 `bucket`+`bucket_label`（协作面就是这么标自己的）⇒ 出筛选片。
    const buckets = bucketsOf({}, items)
    const current = filterOf('workbench')
    const shown = byBucket(items, current)
    // 计数用的是**全集上的数字**（服务端窗口开路时由服务端给；本地路径就是 rows.length）
    const shownTotal = current === '' ? tally.total : (tally.bucketTotal[current] ?? shown.length)
    const wantedCount = current === '' ? tally.urgent
      : (tally.bucketUrgent[current] ?? shown.filter((item) => item.level === 'warn' || item.level === 'bad').length)
    const headline = (current !== ''
      ? `按「${esc(String(buckets.find((b) => b.key === current)?.label ?? current))}」筛选：${shownTotal} 条`
        + `（全部 ${tally.total} 条；不带分类的待办只在「全部」里出现）`
      : (wantedCount
        ? `有 ${wantedCount} 件需要你处理${tally.total > wantedCount ? `，另有 ${tally.total - wantedCount} 条信息` : ''}`
        : (tally.total ? `眼下没有卡住你的事（${tally.total} 条信息）` : '还没有插件报告待办')))
      // **读不到的面板不计入这些数字**（与 `panelHasData` 同一口径）；但**必须如实说**有几块读不到 ——
      // 否则"数字变小"会被读成"事情变少了"。
      + (tally.degraded ? `（另有 ${tally.degraded} 块面板现在读不到：它们各自写着原因，不计入这里的数字）` : '')
    // 急的排前面，但**信息类也要摆出来**：只显示急的会让"收到几条报价登记"这种线索消失
    const list = shown.slice(0, 8)
    const rest = Math.max(0, shownTotal - list.length)
    return `<section class="q-todo" data-workbench="1" data-todo-count="${tally.total}"
      data-todo-urgent="${wantedCount}" data-todo-windowed="${tally.windowed ? 1 : 0}"
      data-todo-degraded-panels="${tally.degraded}">
  <div class="q-todo-head">
    <h2>你现在该做什么</h2>
    <p>${esc(headline)}</p>
    <button class="q-link" data-open="palette">搜全部动作（点这里；键盘 <kbd>Ctrl/⌘+K</kbd>）</button>
  </div>
  ${bucketBar('workbench', buckets, current, items, { '': tally.total, ...tally.bucketTotal })}
  ${list.length ? `<ul class="q-todo-list">${list.map(todoRow).join('')}</ul>`
    : stateBlock({ kind: 'empty', title: '没有待办（不是坏了）', reason: 'no-todo',
      hint: '工作台上的待办由插件注册；一个插件都没报待办时这里是空的。',
      next_action: '下一步：选一个视角（顶部导航）→ 用下面的常用动作开一单，或用 Ctrl+K 搜动作' })}
  ${rest > 0 ? `<p class="q-hint" data-todo-rest="${rest}">还有 ${rest} 条待办没摆在这里（按分类在各插件的面板里；`
    + `用 Ctrl+K 搜动作处理）。</p>` : ''}
  ${last && (last.kind || last.view) ? `<p class="q-hint" data-last-route="1">上次你在 <b>${esc(last.label)}</b>`
    + ` <button class="q-link" data-resume="1">继续 →</button>`
    + `${state.recentRoutes.length > 1 ? ` · 还有 ${state.recentRoutes.length - 1} 条最近访问`
      + ` <button class="q-link" data-open="recent">看全部</button>` : ''}</p>` : ''}
  <details class="q-mech" open><summary>从这里开始（不看文档也能上手）</summary>
    <ol class="q-steps">
      <li>顶部切换<b>视角</b>：工作台 / 承包商 / 供应商 —— 每个视角只看它自己的投影，看不到对方私域。</li>
      <li><b>待办</b>都在这张卡片里：点<b>蓝色按钮</b>直接开表单；按钮上带 ✍ 的是<b>人工门</b>（要写
        <code>human:&lt;你的名字&gt;</code>，界面不代签）。</li>
      <li>列表里每行的<b>「打开 →」</b>是对象深链（如 <code>${esc(API('/app/<view>/<kind>/<id>/'))}</code>）：
        地址栏可复制分享，刷新不丢；状态栏也能一键复制。</li>
      <li>失败时看<b>红色提示条</b>：每条都给 <code>code</code> + 人话 + 下一步；<b>降级</b>（黄色）是"读不到"，
        不是"零条"。</li>
    </ol>
    <p class="q-hint">注册面里现有 ${actions.length} 个动作、${groups.length} 个分组：
      ${groups.map((group) => `<code>${esc(group)}</code>`).join(' · ')}。动作按你所在视角过滤后出现在工具栏里。</p>
  </details>
</section>`
  }

  function todoRow(item) {
    const action = item.action ? actionOf(item.action) : null
    const href = refLink(item.ref)
    return `<li data-level="${attr(item.level || 'info')}" data-todo-plugin="${attr(item.plugin_id || '')}">`
      + `${item.level ? badge(item.level, item.level === 'bad' ? 'bad' : (item.level === 'warn' ? 'warn'
        : (item.level === 'ok' ? 'ok' : ''))) + ' ' : ''}`
      + `<span class="q-li-title">${esc(item.title || '')}</span>`
      + `${item.merged_count > 1 ? ` <span class="q-tag" data-merged-count="${attr(item.merged_count)}"`
        + ` title="${attr(`这一条在 ${item.merged_count} 块面板里都出现过，外壳合并成了一条（计数不重复算）：${
          (item.also_from || []).map((row) => row.panel_id).join(' / ')}`)}">合并 ${item.merged_count} 块</span>` : ''}`
      + `${item.bucket_label ? ` <span class="q-tag q-bucket-tag">${esc(item.bucket_label)}</span>` : ''}`
      + `${item.body ? `<div class="q-li-body">${esc(item.body)}</div>` : ''}`
      + `${item.next_action ? `<div class="q-hint">${esc(item.next_action)}</div>` : ''}`
      + `${action || href ? `<div class="q-actions">${action ? `<button class="primary" data-action="${attr(action.id)}"`
        + ` data-preset='${attr(JSON.stringify(item.ref || {}))}'>${esc(item.label || action.title)}</button>` : ''}`
        + `${href ? `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(item.ref.kind)}"`
          + ` data-v="${attr(item.ref.view || '')}" data-id="${attr(item.ref.id)}">打开 ${esc(refLabel(item.ref))} →</a>` : ''}</div>` : ''}</li>`
  }

  // ---------------------------------------------------------------- 主区渲染
  function objectActions() {
    const view = state.route.view
    const kind = state.route.kind
    // 对象页：该对象类的动作（含声明为 inline 的 —— 在对象页上它就是主按钮）
    return state.surface.actions
      .filter((action) => action.object_kind === kind && (action.views || []).includes(view))
  }

  /** 视图级动作里**声明了按当前对象地址预填**的那些（`from_route` / `from_route_kind` 字段）：
   *  这类动作对**任何对象类**都成立（协作类的「指派 / 转交」「关注」「评论 / @同事」「标为已读」就是这样）
   *  ⇒ 也摆进对象页主工具栏；否则它们会被折叠进「本视图的其它动作」，等于对象页上没有入口。 */
  const isRoutePrefilled = (action) => (action.input?.fields || [])
    .some((field) => field.from_route || field.from_route_kind)
  function objectRouteActions() {
    const view = state.route.view
    return state.surface.actions.filter((action) => !action.object_kind
      && (action.views || []).includes(view) && isRoutePrefilled(action))
  }
  function viewActions({ excludeRoutePrefilled = false } = {}) {
    const view = state.route.view
    // 视图级动作（没有声明 `object_kind` 的）—— 对象页上的那批由 `objectActions()` 单列，这里不重复
    return state.surface.actions
      .filter((action) => (action.views || []).includes(view) && !action.inline)
      .filter((action) => !action.object_kind)
      .filter((action) => !excludeRoutePrefilled || !isRoutePrefilled(action))
  }

  function renderObjectPage() {
    const object = state.object || {}
    const route = state.route
    const crumbs = [`<a href="${attr(linkOf('home'))}" data-open-object="1" data-k="" data-id="">工作台</a>`,
      `<a href="${attr(linkOf(route.view))}" data-open-object="1" data-k="" data-id="">${esc(viewTitle(route.view))}</a>`,
      `<span>${esc(route.kind)} ${esc(route.id)}</span>`].join(' <span class="q-sep">›</span> ')
    const head = object.found === false
      ? stateBlock({ kind: 'error',
        title: `${route.kind} ${route.id}：本视图里没有这个对象${object.reason === 'object-kind-not-registered'
          ? '（这种对象类在这里没有被注册）' : ''}`,
        reason: object.reason || 'object-not-found',
        hint: '对方视角打开的同一深链不会回落成"能看"：每个视角只在自己的投影里找，找不到就如实说找不到。',
        next_action: object.next_action || '' })
      : html([`<h1>${esc(object.title || `${route.kind} ${route.id}`)}</h1>`,
        object.subtitle ? `<p class="q-hint">${esc(object.subtitle)}</p>` : '',
        (object.facts || []).length ? `<dl class="q-kv q-object-facts">${(object.facts || []).map((fact) =>
          `<dt>${esc(fact.key)}</dt><dd>${fact.code ? `<code>${esc(fact.value)}</code>` : esc(fact.value)}</dd>`)
          .join('')}</dl>` : '',
        (object.links || []).length ? `<div class="q-actions">${(object.links || []).map((link) =>
          `<a href="${attr(linkOf(route.view, link.kind, link.id))}" data-open-object="1"`
          + ` data-k="${attr(link.kind)}" data-id="${attr(link.id)}">${esc(link.title || `${link.kind} ${link.id}`)} →</a>`
          ).join('')}</div>` : ''])
    const laid = orderedPanels()
    // **入口策略**（机制）：对象页页头工具栏只摆**这个地址上跑得起来**的动作（对象地址已就位 ⇒
    // 声明了 `from_route` 的那些一键可开）；缺上下文的收进「要先有一个对象」区（写明该在哪跑）。
    const headBar = partitionActions([...objectActions(), ...objectRouteActions()], { route: true })
    const others = partitionActions(viewActions({ excludeRoutePrefilled: true }), { route: true })
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><nav class="q-crumbs" aria-label="面包屑">${crumbs}</nav>`
      + `<button class="q-link" data-copy="${attr(linkOf(route.view, route.kind, route.id))}">复制这条深链</button>`
      // **分享**（机制贡献 `share.object`）：深链 + 对方需要什么身份/侧 + 可直接粘贴的邮件正文
      + `${actionOf('share.object') ? `<button class="q-link" data-share-object="1" title="把这条对象整理成`
        + `「链接 + 对方需要什么身份/侧 + 邮件正文」，直接发给同事">分享（含邮件正文）</button>` : ''}`
      + `<button class="q-link" data-tab-pin="1" title="把这条对象地址固定成一个标签页，方便来回切">钉成标签页</button></div>`,
      head,
      toolbarHtml(headBar.ready, `${route.view}/${route.kind}`),
      needsContextBlock(headBar.need, `${route.view}/${route.kind}`),
      reportBar(state.object?.reports || [], `${route.view}/${route.kind}`),
      layoutBar(laid.list.length),
      `<div class="q-panels">${laid.list.map((item) => panelSection(item.panel, item.collapsed)).join('')}</div>`,
      others.ready.length || others.need.length
        ? `<details class="q-mech q-more-actions">`
        + `<summary>本视图的其它动作（${others.ready.length + others.need.length} 个）</summary>`
        + toolbarHtml(others.ready, `${route.view}（视图级动作）`)
        + needsContextBlock(others.need, `${route.view}（视图级动作）`) + '</details>' : '',
      `<div data-ui-blocks="${attr(`page.${route.view}`)}"></div>`])
    bindPanels()
    bindInteractions()
    bindFiles(el('q-view'))          // ⑥ 文件集合面板（附件）：拖拽上传 / 选择文件 / 键盘
    loadBlocks()
  }

  function renderViewPage() {
    const isHome = state.route.view === 'home'
    const laid = orderedPanels()
    // **入口策略**（机制）：工具栏只摆**这个地址上跑得起来**的动作；缺上下文的收进
    // 「这些动作要先有一个对象」区（点一下从候选里挑一条、预填带入，而不是按下去撞「必填」）。
    const bar = partitionActions(viewActions(), {})
    // **空态**（机制）：这一屏一块有业务数据的面板都没有时 —— 先说人话 + 给 2–3 个真能做的下一步，
    // 面板墙收进一个可展开的 details（一块不少，只是不再铺一面墙）。
    const empty = viewIsEmpty()
    // 工作台（home）另有一条：**眼下没有卡住你的事**（紧急待办 = 0）时，也把面板墙收成一栏 ——
    // 首屏是那张卡（说人话 + 下一步），不是一面墙；面板一块不少，点开就在（`data-todo-urgent` 是读数）。
    const quiet = isHome && todoItems().urgent === 0
    const foldWall = empty || quiet
    const wall = laid.list.map((item) => panelSection(item.panel, item.collapsed)).join('')
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><h1>${esc(viewTitle(state.route.view))}</h1>`
      + `<p>${isHome ? '我今天要做什么' : `${state.panels.length} 块面板`} · 深链 `
      + `<button class="q-link" data-copy="${attr(linkOf(state.route.view))}">复制</button>`
      + `<code>${esc(linkOf(state.route.view))}</code>`
      + `<button class="q-link" data-tab-pin="1">钉成标签页</button></p></div>`,
      emptinessMark(),
      empty ? startBlock({ empty: true })
        : (quiet ? startBlock({ heading: '眼下没有卡住你的事：下面这些是能开工的下一步', empty: false }) : ''),
      isHome ? workbenchHtml() : '',
      toolbarHtml(bar.ready, state.route.view),
      needsContextBlock(bar.need, state.route.view),
      reportBar((state.surface.reports || []).filter((item) => !item.object_kind
        && (item.views || []).includes(state.route.view)), state.route.view),
      layoutBar(laid.list.length),
      empty
        ? `<details class="q-wall" data-panel-wall="1"><summary>这一屏的 ${laid.list.length} 块面板现在都还没有数据`
          + `（不是坏了）—— 点开逐块看它们在等什么</summary>`
          + `<div class="q-panels${isHome ? ' q-panels-home' : ''}">${wall}</div></details>`
        : (foldWall
          ? `<details class="q-wall" data-panel-wall="1"><summary>眼下没有卡住你的事（紧急待办 0）—— `
            + `${laid.list.length} 块面板收在这里，点开逐块看</summary>`
            + `<div class="q-panels q-panels-home">${wall}</div></details>`
          : `<div class="q-panels${isHome ? ' q-panels-home' : ''}">${wall}</div>`),
      `<div data-ui-blocks="${attr(`page.${state.route.view}`)}"></div>`])
    bindPanels()
    bindInteractions()
    bindFiles(el('q-view'))          // ⑥ 文件集合面板（附件）：拖拽上传 / 选择文件 / 键盘
    loadBlocks()
  }

  /**
   * **加载态**（③）：导航/重载一进来先显示它 —— 上一页的行**已经被清掉**，屏幕上不留旧数据；
   * 读失败会走 `renderErrorPage`（错误态），**不会**变成"空白/没有数据"。
   */
  function renderLoadingPage() {
    const route = state.route
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><h1>${esc(route.kind && route.id ? `${route.kind} ${route.id}`
        : viewTitle(route.view))}</h1><p>读取中…（已把上一页清掉：屏幕上不留旧数据）</p></div>`,
      stateBlock({ kind: 'loading', title: '正在读取这一页', reason: 'loading',
        hint: '读面板数据 / 通知 / 状态；读不到会如实报错（带 code 与下一步），不会显示成"空"。' }),
      `<div class="q-panels" aria-hidden="true">${Array.from({ length: 3 }, () =>
        `<section class="q-panel q-skel"><div class="q-skel-line"></div><div class="q-skel-line short"></div>`
        + `<div class="q-skel-line"></div></section>`).join('')}</div>`])
  }

  /** **错误态**（③）："没读到"必须自成一种样子 —— 绝不伪装成空列表，也给出可复制的下一步。 */
  function renderErrorPage(error) {
    const route = state.route
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><h1>${esc(route.kind && route.id ? `${route.kind} ${route.id}`
        : viewTitle(route.view))}</h1><p>这一页没读到</p></div>`,
      stateBlock({ kind: 'error', title: '这一页没读到（不是"没有数据"）',
        reason: error.code || 'read-failed', hint: error.reason || '',
        next_action: error.next_action || '点「重新读一次」；还是失败就看服务日志（./run logs）' }),
      `<div class="q-actions"><button class="primary" data-reload-page="1">重新读一次</button>`
      + `<button data-copy="${attr(linkOf(route.view, route.kind, route.id))}">复制这个地址</button></div>`])
  }

  function renderMain() {
    const t0 = performance.now()
    // 主区只有这四条路：读中 / 读不到 / 对象页 / 视图页（互不冒充 —— 见 stateBlock 的口径）
    if (state.loading) renderLoadingPage()
    else if (state.panelsError || state.objectError) renderErrorPage(state.panelsError || state.objectError)
    else if (state.route.kind && state.route.id) renderObjectPage()
    else renderViewPage()
    renderStatus()
    bindQueryDelegates()
    const entry = metricOf(t0)
    // `frame_ms` = 到**下一帧画完**（含样式/布局/绘制）：与 `paint_ms` 一起给出同一口径的前后对照
    if (entry) requestAnimationFrame(() => requestAnimationFrame(() => {
      entry.frame_ms = Math.round((performance.now() - t0) * 10) / 10
    }))
  }

  /**
   * **窄屏可读性（机制）**：横向能滚的表格给出**可见的滑动提示**，否则在手机上"右边还有列"这件事
   * 只能靠猜（走查实测：报价表的单价/交期/动作列全在视口外，人根本不知道要滑）。
   * 判据只用几何量（`scrollWidth > clientWidth`），与业务无关；窗口变化时重算。
   */
  function markScrollables(root) {
    const scope = root || document
    const boxes = [...scope.querySelectorAll('.q-scroll, .q-tools, .q-nav, .q-tabs, .q-actions[data-toolbar]')]
    for (const box of boxes) {
      const can = box.scrollWidth > box.clientWidth + 1
      if (can) box.dataset.scrollX = '1'
      else delete box.dataset.scrollX
    }
  }
  window.addEventListener('resize', () => markScrollables(document))

  /** ② 面板层交互：拖拽排序、折叠、布局按钮、钉标签页。 */
  function bindPanels(root = el('q-view')) {
    markScrollables(document)      // 顶栏/标签页/动作条同样是横向滚动容器：一样要给出提示
    root.querySelectorAll('[data-collapse]').forEach((node) => node.addEventListener('click', () =>
      toggleCollapse(node.dataset.collapse)))
    root.querySelectorAll('[data-layout]').forEach((node) => node.addEventListener('click', () => {
      const op = node.dataset.layout
      if (op === 'reset') {
        delete state.layout[layoutKey()]
        store.set(KEYS.layout, state.layout)
        renderPanels()
        return toast('ok', '布局已恢复默认', '面板顺序与折叠状态都回到插件声明的样子')
      }
      const ids = orderedPanels().list.map((item) => item.panel.id)
      toggleCollapseAll(op === 'collapse-all' ? ids : [])
    }))
    root.querySelectorAll('[data-tab-pin]').forEach((node) => node.addEventListener('click', () => {
      rememberTab(state.route)
      renderTabs()
      toast('ok', '已钉成标签页', `${routeLabel(state.route)}（Alt+1..9 可切换）`)
    }))
    let dragId = ''
    root.querySelectorAll('[data-drag]').forEach((node) => {
      node.addEventListener('dragstart', (ev) => {
        dragId = node.dataset.drag
        ev.dataTransfer?.setData('text/plain', dragId)
        node.closest('section')?.classList.add('q-dragging')
      })
      node.addEventListener('dragend', () => {
        dragId = ''
        root.querySelectorAll('.q-dragging, .q-droptarget').forEach((item) =>
          item.classList.remove('q-dragging', 'q-droptarget'))
      })
      node.addEventListener('keydown', (ev) => {
        if (!ev.altKey) return
        if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return
        ev.preventDefault()
        movePanel(node.dataset.drag, ev.key === 'ArrowUp' ? -1 : 1)
      })
    })
    root.querySelectorAll('section[data-panel]').forEach((section) => {
      section.addEventListener('dragover', (ev) => {
        if (!dragId) return
        ev.preventDefault()
        section.classList.add('q-droptarget')
      })
      section.addEventListener('dragleave', () => section.classList.remove('q-droptarget'))
      section.addEventListener('drop', (ev) => {
        ev.preventDefault()
        const source = dragId || ev.dataTransfer?.getData('text/plain') || ''
        if (!source || source === section.dataset.panel) return
        const box = section.getBoundingClientRect()
        dropPanel(source, section.dataset.panel, ev.clientY < box.top + box.height / 2)
        dragId = ''
        renderPanels()
      })
    })
  }

  function toggleCollapseAll(ids) {
    const layout = layoutOf()
    saveLayout({ order: layout.order, collapsed: ids, hidden: layout.hidden })
    renderPanels()
  }

  // ---------------------------------------------------------------- ⑥ 文件集合面板（附件）
  /**
   * 一个文件的上传：**原始字节** POST（查询串带对象关联与文件名）。为什么不是 multipart/表单：
   * 原始字节最直白 —— 没有"边界串/编码"这一层可以被搞错，大文件也是流式的；文件名与可见性走查询串，
   * 服务端按**会话身份**判侧（查询串改不动"我是谁"）。
   */
  async function uploadOne(zone, file) {
    const url = zone.dataset.uploadUrl
    const params = new URLSearchParams()
    params.set('kind', zone.dataset.uploadKind || '')
    params.set('id', zone.dataset.uploadId || '')
    params.set(zone.dataset.nameParam || 'name', file.name)
    const vis = zone.querySelector('[data-file-visibility]')
    if (vis) params.set(zone.dataset.visibilityParam || 'visibility', vis.value)
    const status = (text) => {
      const box = zone.querySelector('[data-drop-status]')
      if (box) box.textContent = text
    }
    status(`上传 ${file.name}…（${Math.max(1, Math.round(file.size / 1024))} KiB）`)
    try {
      const res = await fetch(`${url}?${params.toString()}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
      let out = null
      try { out = await res.json() } catch (err) {
        out = { ok: false, code: 'bad-json', reason: `HTTP ${res.status}（响应不是 JSON）` }
      }
      if (!out.ok) {
        status(`${file.name} 被拒：${out.code || res.status} —— ${out.reason || ''}`)
        toast('bad', `上传被拒（${out.code || res.status}）`,
          [out.reason, out.next_action].filter(Boolean).join(' · '))
        return { ok: false, code: out.code || String(res.status), status: res.status }
      }
      status(`${file.name} 已上传（sha256 ${String(out.attachment?.sha256 || '').slice(0, 19)}…）`)
      return { ok: true, status: res.status }
    } catch (err) {
      status(`${file.name} 上传失败：${String(err)}`)
      return { ok: false, code: 'offline', status: 0 }
    }
  }
  async function uploadFiles(zone, files) {
    if (!zone || !files || !files.length) return
    const done = []
    for (const file of files) done.push(await uploadOne(zone, file))
    const ok = done.filter((item) => item.ok).length
    const bad = done.filter((item) => !item.ok)
    toast(ok ? 'ok' : 'bad', `${ok}/${done.length} 个文件已上传`,
      bad.length ? `被拒：${[...new Set(bad.map((item) => item.code))].join(' / ')}（原因见面板上的字与提示条）`
        : '列表已刷新：文件名/大小/上传人/时间/sha256 都在表里，可核对')
    await loadAll()
  }
  /** 拖拽 + 选择文件（多文件）+ 键盘（焦点在方块上按 Enter/Space = 选择文件）。 */
  function bindFiles(root) {
    root.querySelectorAll('[data-dropzone]').forEach((zone) => {
      const input = zone.querySelector('[data-file-input]')
      const pick = zone.querySelector('[data-file-pick]')
      if (pick && input) pick.addEventListener('click', () => input.click())
      if (input) input.addEventListener('change', () => { uploadFiles(zone, [...input.files]); input.value = '' })
      zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('q-drop-on') })
      zone.addEventListener('dragleave', () => zone.classList.remove('q-drop-on'))
      zone.addEventListener('drop', (ev) => {
        ev.preventDefault()
        zone.classList.remove('q-drop-on')
        uploadFiles(zone, [...(ev.dataTransfer ? ev.dataTransfer.files : [])])
      })
      zone.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault()
        if (input) input.click()
      })
    })
  }

  // ---------------------------------------------------------------- ⑦ 导出 / 打印（`report` 声明）
  /**
   * 导出/打印按钮组：每个**声明过的格式**一个按钮 = 打开那个插件自己的动作并把 `format` 预填好。
   * 外壳既不知道导出的是什么内容、也不生成内容（谁的事实谁导出）；`html` 那一档就是"可打印的文档"。
   */
  function reportBar(reports, label) {
    const list = (reports || []).filter((item) => actionOf(item.action) && (item.formats || []).length)
    if (!list.length) return ''
    return `<div class="q-actions q-reportbar" data-reportbar="${attr(label)}">` + list.map((item) =>
      `<span class="q-report"><span class="q-report-title">${esc(item.title)}</span>` +
      (item.formats || []).map((format) => `<button data-action="${attr(item.action)}"` +
        ` data-preset='${attr(JSON.stringify({ format }))}' title="${attr(item.hint || '')}">` +
        `${format === 'html' ? '打印 / HTML' : `导出 ${format.toUpperCase()}`}</button>`).join('') +
      // **导出模板可配**（机制）：声明了 `columns` 的导出多一个「列…」入口 —— 列选择是**个人偏好**
      //（按身份落 0600 ⇒ 换浏览器/换设备仍是这套列），外壳只按它过滤列，不生成内容。
      `${(item.columns || []).length ? `<button data-export-columns="${attr(item.id)}"` +
        ` title="挑这份导出要哪些列（你的个人偏好，按身份存服务端；换浏览器仍在）">` +
        `列（${exportSelectionText(item)}）</button>` : ''}` +
      `</span>`).join('') +
      `<span class="q-hint">导出内容由注册它的插件生成（与账面同源、逐行可对）；HTML 可直接打印；`
      + `带「列…」的导出可以按你自己的偏好挑列</span></div>`
  }
  /** 你对这份导出保存过的列选择（真源：面板声明的 `export_prefs`，或一次**只读**动作调用）。 */
  function exportPrefOf(reportId) {
    if (state.exportPrefs && state.exportPrefs[reportId]) return state.exportPrefs[reportId]
    for (const panel of state.panels) {
      const prefs = (panel.data || {}).export_prefs
      if (prefs && typeof prefs === 'object' && prefs[reportId]) return prefs[reportId]
    }
    return null
  }
  /**
   * 把"我这一套列选择"读回来（机制）：面板有那块 `export_prefs` 就直接用；没有（例如在**对象页**上，
   * 那块面板按对象类过滤掉了）就问服务端一次 —— `export.columns` 的**只读模式**（`report_id` 留空）。
   * 于是「列…」按钮上的 `N/M` 与勾选状态在任何页面上都对；换浏览器也一样（0600 按身份）。
   */
  async function hydrateExportPrefs() {
    const reports = (state.surface.reports || []).filter((item) => (item.columns || []).length)
    if (!reports.length) return false
    const fromPanels = {}
    for (const panel of state.panels) {
      const prefs = (panel.data || {}).export_prefs
      if (prefs && typeof prefs === 'object') Object.assign(fromPanels, prefs)
    }
    state.exportPrefs = fromPanels
    if (Object.keys(fromPanels).length) return false
    const action = actionOf('export.columns')
    if (!action) return false
    const out = await postJson(`/api/action/${encodeURIComponent(action.id)}`,
      { view: state.route.view, route: state.route, input: { report_id: '' } })
    const all = out.result?.export_prefs_all
    if (!out.ok || !Array.isArray(all)) return false
    state.exportPrefs = Object.fromEntries(all.map((item) => [item.report_id, item]))
    return true
  }
  const exportSelectionText = (report) => {
    const saved = exportPrefOf(report.id)
    const total = (report.columns || []).length
    return saved ? `${(saved.columns || []).length}/${total} 你选的` : `全部 ${total} 列`
  }
  /**
   * **列选择弹层**（机制）：勾掉不要的列 ⇒ POST 机制动作 `export.columns`（按会话身份落 0600）。
   * 这里不做任何内容生成：勾选结果只决定"导出时用哪几列"，内容仍由插件自己的动作生成。
   */
  function openColumnsPicker(reportId) {
    const report = (state.surface.reports || []).find((item) => item.id === reportId) || null
    if (!report) return toast('bad', '没有这份导出', `注册面里没有 ${reportId}（刷新页面看当前的导出声明）`)
    const columns = report.columns || []
    const saved = exportPrefOf(reportId)
    const picked = new Set(saved ? saved.columns : columns.map((column) => column.key))
    const action = actionOf('export.columns')
    const draw = () => {
      const holder = el('q-modal')?.querySelector('[data-cols-form]')
      if (!holder) return
      holder.innerHTML = columns.map((column) => `<label class="q-col-pick"><input type="checkbox"` +
        ` data-col="${attr(column.key)}"${picked.has(column.key) ? ' checked' : ''}> ` +
        `<span>${esc(column.label)}</span> <code>${esc(column.key)}</code></label>`).join('')
      holder.querySelectorAll('[data-col]').forEach((node) => node.addEventListener('change', () => {
        if (node.checked) picked.add(node.dataset.col); else picked.delete(node.dataset.col)
        const count = el('q-modal')?.querySelector('[data-cols-count]')
        if (count) count.textContent = String(picked.size)
      }))
    }
    openModal(html([
      `<h2 id="q-action-title">导出列选择：${esc(report.title)}</h2>`,
      `<p class="q-src">导出 <code>${esc(report.id)}</code> · 由 <code>${esc(report.plugin_id)}</code> 声明 `
      + `（${report.formats.join(' / ')}）· 内容仍由 <code>${esc(report.action)}</code> 从它自己那一侧的事实生成</p>`,
      '<div class="q-modal-body">',
      `<p class="q-hint">勾掉不要的列 ⇒ 这份导出以后只出你选的列（列顺序按声明的顺序，不跟手抖跑）。`
      + `选择是<b>你的个人偏好</b>：按会话身份落服务端 0600 文件 —— <b>换浏览器、换设备仍是这套列</b>；`
      + `${saved ? `你上次保存于 <code>${esc(saved.saved_at || '')}</code>` : '你还没保存过（现在是全部列）'}。`
      + `列选择<b>不进账本</b>：它不是业务事实。</p>`,
      `<div class="q-col-picks" data-cols-form="1"></div>`,
      `<div class="q-actions"><span class="q-hint">已选 <b data-cols-count="1">${picked.size}</b> / ${columns.length} 列</span>`,
      `<button class="primary" data-cols-save="1">保存我的列选择</button>`,
      `<button data-cols-all="1">全选</button>`,
      `<button data-cols-none="1">全不选</button>`,
      `${saved ? `<button data-cols-reset="1">用全部列（清掉我的选择）</button>` : ''}`,
      `<button data-close="1">取消</button></div>`,
      `<p class="q-hint">保存后再导出：预览里会写明"用了哪几列、跳过了哪几列"，逐列可核对；`
      + `一个都没选中时不会导出（服务端会**如实拒**，不偷偷导全表）。</p>`,
      '</div>']), 'q-export-columns')
    draw()
    const modal = el('q-modal')
    if (!modal) return
    modal.querySelector('[data-close]')?.addEventListener('click', closeModal)
    modal.querySelector('[data-cols-all]')?.addEventListener('click', () => {
      for (const column of columns) picked.add(column.key)
      draw()
      const count = modal.querySelector('[data-cols-count]')
      if (count) count.textContent = String(picked.size)
    })
    modal.querySelector('[data-cols-none]')?.addEventListener('click', () => {
      picked.clear(); draw()
      const count = modal.querySelector('[data-cols-count]')
      if (count) count.textContent = '0'
    })
    const save = async (input, done) => {
      if (!action) return toast('bad', '这个界面上没有列选择动作', '外壳没装上 export.columns（重新加载页面）')
      const out = await postJson(`/api/action/${encodeURIComponent(action.id)}`,
        { view: state.route.view, route: state.route, input })
      notifyAction(out, action)
      if (!out.ok) return toast('bad', `列选择没保存（${out.code || 'refused'}）`, out.reason || '')
      await loadAll(true)
      closeModal()
      done(out)
      if (out.result?.export_prefs) {
        toast('ok', `列选择已保存（${(out.result.export_prefs.columns || []).length} 列）`,
          `按你的身份存在服务端（0600）：${out.result.export_prefs.file || ''} —— 换浏览器/换设备仍是这套列`)
      }
    }
    modal.querySelector('[data-cols-save]')?.addEventListener('click', () => save(
      { report_id: reportId, columns: [...picked].join(' ') }, () => {}))
    modal.querySelector('[data-cols-reset]')?.addEventListener('click', () => save(
      { report_id: reportId, reset: true }, () => {}))
  }
  /** 打印：把导出的 HTML 放进一个隐藏 iframe 里打印（不打印界面本身；弹窗被拦也能用下载的那份）。 */
  function printExport(htmlText) {
    const frame = document.createElement('iframe')
    frame.setAttribute('data-print-frame', '1')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    document.body.appendChild(frame)
    frame.srcdoc = htmlText
    frame.addEventListener('load', () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print() } catch (err) { /* 浏览器拦住时用下载件打印 */ }
      setTimeout(() => frame.remove(), 4000)
    })
  }
  /** 导出预览 + 打印（一屏内完成：看得见内容、点得到打印、也能再下载一次）。 */
  function exportPreview(exp, action) {
    const rows = exp.rows === undefined || exp.rows === null ? '' : `${exp.rows} 行`
    const used = Array.isArray(exp.columns_used) && exp.columns_used.length
      ? `本次列（${exp.columns_used.length}）：${exp.columns_used.map((column) => column.label).join(' · ')}`
      : ''
    openModal(html([
      `<h2 id="q-action-title">导出：${esc(exp.filename || '')}</h2>`,
      `<p class="q-src">由 <code>${esc(action ? action.plugin_id : '')}</code> 的 <code>${
        esc(action ? action.id : '')}</code> 生成 · 格式 <code>${esc(exp.format || '')}</code>`,
      `${rows ? ` · ${esc(rows)}` : ''}${exp.digest ? ` · 内容指纹 <code>${esc(String(exp.digest).slice(0, 19))}…</code>` : ''}`,
      ` · 与账面同源（导出用的就是这一侧账本里的行）</p>`,
      `<div class="q-export-holder" data-export-holder="1"></div>`,
      used || exp.columns_pref || exp.columns_note
        ? `<div class="q-hint q-export-columns" data-export-columns-note="1">`
          + `${exp.columns_pref ? `<b>列选择来自你的个人偏好</b>（report <code>${esc(exp.columns_pref.report_id)}</code>`
            + `${exp.columns_pref.saved_at ? `，保存于 ${esc(exp.columns_pref.saved_at)}` : ''}`
            + `，${esc(exp.columns_pref.source || '')}）：这是"跨浏览器仍在"的那一份` : ''}`
          + `${used ? `<div>${esc(used)}</div>` : ''}`
          + `${(exp.columns_dropped || []).length ? `<div>按你的选择跳过：${
            esc((exp.columns_dropped || []).map((column) => column.label).join(' · '))}</div>` : ''}`
          + `${exp.columns_note ? `<div>${esc(exp.columns_note)}</div>` : ''}`
          + `${(exp.columns_available || []).length && exp.columns_pref ? `<button data-export-columns="${
            attr(exp.columns_pref.report_id)}">改用别的列…</button>` : ''}</div>`
        : '',
      `<div class="q-actions"><button class="primary" data-print="1">打印</button>`,
      `<button data-download="1">下载这份文件</button><button data-close="1">关闭</button></div>`,
      `<p class="q-hint">打印走浏览器自己的打印对话框（可以"另存为 PDF"）；下载得到的是同内容的一份文件。</p>`]),
    'q-export-modal')
    const modal = el('q-modal')
    if (!modal) return
    modal.querySelectorAll('[data-export-columns]').forEach((node) => node.addEventListener('click', () => {
      closeModal()
      openColumnsPicker(node.dataset.exportColumns)
    }))
    const holder = modal.querySelector('[data-export-holder]')
    if (holder) {
      if ((exp.format || '') === 'html') {
        const frame = document.createElement('iframe')
        frame.className = 'q-export-frame'
        frame.setAttribute('data-export-frame', '1')
        frame.setAttribute('title', exp.filename || '导出预览')
        frame.srcdoc = exp.content
        holder.appendChild(frame)
      } else {
        const pre = document.createElement('pre')
        pre.className = 'q-export-text'
        pre.textContent = String(exp.content).slice(0, 20000)
        holder.appendChild(pre)
      }
    }
    modal.querySelector('[data-close]')?.addEventListener('click', closeModal)
    modal.querySelector('[data-print]')?.addEventListener('click', () => printExport(exp.content))
    modal.querySelector('[data-download]')?.addEventListener('click', () => downloadExport(exp))
  }
  /** 导出结果落成一份文件（浏览器下载；文件名由插件给）。 */
  function downloadExport(exp) {
    try {
      const blob = new Blob([exp.content], { type: exp.content_type || 'text/plain; charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = exp.filename || `export.${exp.format || 'txt'}`
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      return true
    } catch (err) {
      toast('warn', '下载没起来（浏览器限制）', String(err))
      return false
    }
  }
  /** 动作回执里带了 `result.export` ⇒ 落文件 + 打开预览（打印在预览里一键完成）。 */
  function deliverExport(out, action) {
    const exp = out && out.result && out.result.export
    if (!exp || typeof exp.content !== 'string') return false
    const saved = downloadExport(exp)
    exportPreview(exp, action)
    toast('ok', `导出已生成：${exp.filename || ''}`,
      [exp.rows !== undefined ? `${exp.rows} 行（与账面同源）` : '', saved ? '已下载' : ''].filter(Boolean).join(' · '))
    return true
  }

  function bindInteractions(root = el('q-view')) {
    const panelOf = (node) => {
      const section = node.closest('[data-panel]')
      const id = section?.dataset?.panel
      return (id && state.panels.find((item) => item.id === id)) || null
    }
    root.querySelectorAll('[data-action]').forEach((node) => node.addEventListener('click', () => {
      let preset = {}
      try { preset = JSON.parse(node.dataset.preset || '{}') } catch (err) { preset = {} }
      // **带预填的入口**（工作台待办卡 / 通知中心 / 面板里的按钮：插件自己给了 preset）直接开表单；
      // **裸入口**（工具栏那些）走一遍可跑性判定 —— 缺上下文就摆候选清单，不摆空表单。
      const hasPreset = Object.keys(preset).length > 0
      if (hasPreset) return openAction(node.dataset.action, preset, null, { panel: panelOf(node) })
      return openActionEntry(node.dataset.action)
    }))
    root.querySelectorAll('[data-row-action]').forEach((node) => node.addEventListener('click', () => {
      let row = {}
      try { row = JSON.parse(node.dataset.row) } catch (err) { row = {} }
      openAction(node.dataset.rowAction, row, null, { panel: panelOf(node) })
    }))
    // **入口策略**（机制）：缺上下文的动作点进「先挑一条」的候选清单（不是空表单）；
    // 空态「起步」块里的按钮 = 插件写的下一步，点了真开那个动作的表单。
    root.querySelectorAll('[data-pick-action]').forEach((node) =>
      node.addEventListener('click', () => openActionEntry(node.dataset.pickAction)))
    root.querySelectorAll('[data-guide-action]').forEach((node) => node.addEventListener('click', () => {
      const guides = (state.surface.guides || []).filter((guide) => guide.view === state.route.view)
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      const steps = guides.flatMap((guide) => guide.steps || []).filter((step) => actionOf(step.action))
      const step = steps[Number(node.dataset.guideIndex)]
      if (!step) return
      openActionEntry(step.action, step.input || null)
    }))
    root.querySelectorAll('[data-open-object]').forEach((node) => node.addEventListener('click', (ev) => {
      if (ev.metaKey || ev.ctrlKey) return
      ev.preventDefault()
      // 视角以**这一条自己声明的**为准（`data-v`），没声明才按当前页的视角 —— 与 `refLink()`
      // 拼 href 用的是同一条规则（否则 href 写着 `/app/contractor/gate/…`、点下去却跳到当前视角，
      // 而那个视角可能根本没注册这个对象类，只能如实说"本视图里没有这个对象"：P14 走查实测）。
      navigate(node.dataset.v || state.route.view, node.dataset.k, node.dataset.id)
    }))
    root.querySelectorAll('[data-copy]').forEach((node) =>
      node.addEventListener('click', () => copyText(node.dataset.copy)))
    root.querySelectorAll('[data-share-object]').forEach((node) => node.addEventListener('click', () =>
      openAction('share.object', { kind: state.route.kind, id: state.route.id })))
    // **导出模板可配**（机制）：声明了 `columns` 的导出多一个「列…」入口
    root.querySelectorAll('[data-export-columns]').forEach((node) =>
      node.addEventListener('click', () => openColumnsPicker(node.dataset.exportColumns)))
    root.querySelectorAll('[data-open="palette"]').forEach((node) => node.addEventListener('click', openPalette))
    // 桶筛选片（「我的 / 我指派的 / 全部」）：只改"看到哪些"，不改任何事实；选择存本浏览器 + 服务端（按身份）
    root.querySelectorAll('[data-bucket-filter]').forEach((node) => {
      const pick = () => {
        setFilter(node.dataset.bucketFilter, node.dataset.bucketKey)
        const scope = String(node.dataset.bucketFilter ?? '')
        // 面板自己的桶筛选片要**把这一块重取一遍**（服务端窗口：新桶的行在服务端，不在本页）
        const panel = state.panels.find((item) => item.id === scope)
        if (panel && panel.data && panel.data.query?.server === true) refreshPanel(scope)
        else renderMain()
      }
      node.addEventListener('click', pick)
      node.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault(); pick()
      })
    })
    root.querySelectorAll('[data-open="recent"]').forEach((node) => node.addEventListener('click', openRecent))
    root.querySelectorAll('[data-open="notify"]').forEach((node) => node.addEventListener('click', openNotify))
    root.querySelectorAll('[data-open="identity"]').forEach((node) => node.addEventListener('click', openIdentity))
    root.querySelectorAll('[data-resume]').forEach((node) => node.addEventListener('click', () => {
      const last = lastRoute()
      if (last) navigate(last.view, last.kind, last.id)
    }))
    // 全选只在**本表**里生效（P3 走查实测：不 scope 的话一个表的"全选"会把整页所有表的复选框都勾上，
    // 计数与批量 ids 都会串到别的表）；勾选记进**本面板**的桶（翻页回来还是勾着的，P21 / D2）。
    root.querySelectorAll('[data-select-all]').forEach((node) => node.addEventListener('change', () => {
      const table = node.closest('table') || root
      const panelId = node.closest('[data-panel]')?.dataset?.panel || ''
      table.querySelectorAll('[data-select]').forEach((box) => {
        box.checked = node.checked
        state.selected[box.dataset.select] = node.checked
        pickSet(panelId, box.dataset.select, node.checked)
      })
      updateSelectedCount()
    }))
    root.querySelectorAll('[data-select]').forEach((node) => node.addEventListener('change', () => {
      state.selected[node.dataset.select] = node.checked
      pickSet(node.closest('[data-panel]')?.dataset?.panel || '', node.dataset.select, node.checked)
      node.closest('tr')?.classList.toggle('q-row-picked', node.checked)
      if (node.checked) {
        let row = {}
        try { row = JSON.parse(node.closest('tr').querySelector('[data-row-action]')?.dataset.row || '{}') } catch (err) { row = {} }
        state.selectedRows = { ...(state.selectedRows || {}), [node.dataset.select]: row }
      }
      updateSelectedCount()
    }))
    // ---- ③ 可编辑表格：实时小计 + Tab/Enter 流转（备报价时不用鼠标逐个点） ----
    root.querySelectorAll('[data-edit]').forEach((node) => {
      node.addEventListener('input', () => {
        const key = editKeyOf(node)
        state.edits[key] = state.edits[key] || {}
        const raw = node.dataset.type === 'number' ? Number(node.value) : node.value
        state.edits[key][node.dataset.field] = raw
        // 小计重算不许静默失败：抛错就红条报出来（否则用户看到的是"改了但数字不动"）
        try { refreshEdits(node.closest('[data-panel]')) } catch (err) {
          banner('warn', '小计重算失败（外壳）', String(err),
            '这是外壳的机制错误，不是你填错了：值已经记在表格里，直接点「提交编辑」也能提交')
        }
      })
      node.addEventListener('focus', () => node.closest('td')?.classList.add('q-editing'))
      node.addEventListener('blur', () => node.closest('td')?.classList.remove('q-editing'))
      node.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault()
          return submitEdits(node.closest('[data-panel]'))
        }
        if (ev.key === 'Escape') {
          ev.preventDefault()
          const orig = node.dataset.orig ?? ''
          node.value = orig
          const key = editKeyOf(node)
          if (state.edits[key]) delete state.edits[key][node.dataset.field]
          refreshEdits(node.closest('[data-panel]'))
          return
        }
        if (ev.key === 'Enter' || ev.key === 'Tab') {
          ev.preventDefault()
          return focusCell(node, { forward: !ev.shiftKey, column: ev.key === 'Enter' })
        }
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault()
          return focusCell(node, { forward: ev.key === 'ArrowDown', column: true })
        }
      })
    })
    root.querySelectorAll('[data-cmp-group]').forEach((node) => node.addEventListener('change', () => {
      const panelId = node.dataset.cmpPanel
      const box = node.closest('[data-compare-bar]')
      const picked = [...box.querySelectorAll('[data-cmp-group]')].filter((item) => item.checked)
        .map((item) => item.dataset.cmpGroup)
      const max = Number(box.querySelector('.q-cmp-count')?.dataset.max ?? 3)
      state.compare[panelId] = picked
      renderPanels()
      const after = el('q-view').querySelector(`[data-compare-bar="${panelId}"] .q-cmp-count`)
      if (after && picked.length < 2 && max >= 2) {
        toast('warn', `对比模式至少要 2 组（现在 ${picked.length} 组）`,
          '再勾一组：勾满 2–3 组才能并排比较；取消全部勾选会退回默认展示')
      }
    }))
    root.querySelectorAll('[data-cmp-reset]').forEach((node) => node.addEventListener('click', () => {
      const panelId = node.dataset.cmpReset
      const box = node.closest('[data-compare-bar]')
      state.compare[panelId] = [...box.querySelectorAll('[data-cmp-group]')].map((item) => item.dataset.cmpGroup)
      const view = state.panels.find((panel) => panel.id === panelId)
      const max = Number(view?.data?.compare?.max ?? 3)
      if (state.compare[panelId].length > max) {
        state.compare[panelId] = state.compare[panelId].slice(0, max)
        toast('warn', `对比模式最多并排 ${max} 组`, `已保留前 ${max} 组（照着列顺序取的），其余勾选要手动取消一个再点`)
      }
      renderPanels()
    }))
    root.querySelectorAll('[data-submit-edits]').forEach((node) => node.addEventListener('click', () =>
      submitEdits(node.closest('[data-panel]'))))
    root.querySelectorAll('[data-cancel-edits]').forEach((node) => node.addEventListener('click', (ev) => {
      state.edits = {}; state.editOrigin = {}; state.selected = {}; state.selectedRows = {}
      state.picked = {}; state.selectedAll = {}
      const panelId = ev.currentTarget?.dataset?.panel
      if (panelId) renderPanels()
      else loadAll(true)
    }))
    root.querySelectorAll('[data-bulk]').forEach((node) => node.addEventListener('click', () => {
      const holder = node.closest('[data-panel]') || root
      // 送出的 ids = **本面板勾过的行**（含不在本页的：翻页不会把勾弄丢，P21 / D2）+ **「选中全部命中行」**。
      // 只取本表/本面板（跨表面板串选会把别的表的 id 一起发出去 —— P3 实测过）。
      const panelId = holder.dataset?.panel || ''
      const domIds = [...holder.querySelectorAll('[data-select]:checked')].map((box) => box.dataset.select)
      const ids = [...new Set([...domIds, ...pickedKeysOf(panelId), ...selectedAllOf(panelId)])]
      // 已经改了单元格但没勾行 ⇒ 直接提交这些改动（不逼用户先勾一遍；改了东西却只收到"没有选中"是最气人的）
      if (!ids.length && Object.keys(state.edits).length) {
        return submitEdits(holder)
      }
      if (!ids.length) {
        return toast('warn', '没有选中任何行',
          '勾选表格左侧的复选框（或点表头全选），或者直接改单元格再点这个按钮')
      }
      const rows = ids.map((id) => (state.selectedRows || {})[id] || { id })
      const panel = state.panels.find((item) => item.id === holder.dataset?.panel) || null
      openAction(node.dataset.bulk, { ids, rows: rows.filter(Boolean) }, null, { panel })
    }))
    root.querySelectorAll('tr[data-row-key]').forEach((node) => node.addEventListener('contextmenu', (ev) => {
      const actions = state.surface.actions.filter((action) => action.context_menu
        && (action.views || []).includes(state.route.view))
      if (!actions.length) return
      ev.preventDefault()
      openContextMenu(ev.clientX, ev.clientY, actions, () => {
        let row = {}
        try { row = JSON.parse(node.querySelector('[data-row-action]')?.dataset.row || '{}') } catch (err) { row = {} }
        return row
      })
    }))
  }
  function updateSelectedCount() {
    // 计数按**本面板真的勾上的**算（不是全局 state：全局计数在跨表时会把别的表的勾选也算进来）；
    // 跨页/跨页勾选（翻页前的勾 + 「选中全部命中行」）单独标出来 —— 否则用户以为只选了本页那几行。
    // 计数条里那句"已勾选 N 行"也一起更新（它在重绘时是烘进去的，勾选时面板并不重绘）
    document.querySelectorAll('[data-picked-count]').forEach((node) => {
      const scope = node.closest('[data-panel]') || document
      node.textContent = String(pickedKeysOf(scope.dataset?.panel || '').length)
    })
    document.querySelectorAll('[data-selected-count]').forEach((node) => {
      const scope = node.closest('[data-panel]') || document
      const panelId = scope.dataset?.panel || ''
      const dom = scope.querySelectorAll('[data-select]:checked').length
      const all = new Set([...pickedKeysOf(panelId), ...selectedAllOf(panelId)])
      const extra = all.size
      node.textContent = extra > dom ? `${dom}（含不在本页共 ${extra}）` : String(dom)
    })
  }
  // ---------------------------------------------------------------- ③ 编辑区：取值 / 键盘流转 / 实时小计
  /** 编辑键 = 面板 + 行（同一页上两块可编辑表格互不串改）。 */
  const editKeyOf = (node) => `${node.closest('[data-panel]')?.dataset?.panel ?? ''}`
    + `|${node.closest('tr')?.dataset?.rowKey ?? ''}`
  const editRowsOf = (panelId) => Object.entries(state.edits)
    .filter(([key, fields]) => key.startsWith(`${panelId}|`) && Object.keys(fields).length > 0)
    .map(([key, fields]) => {
      const id = key.slice(panelId.length + 1)
      const panel = state.panels.find((item) => item.id === panelId)
      const firstKey = panel?.data?.columns?.[0]?.key
      // **原行也要带上**：插件在行里声明的 `version`（"你看到的那一版"）得跟着这次提交回去；
      // 改过的格覆盖原值（`...fields` 在后）——机制只搬运，不解读任何字段。
      const original = (panel?.data?.rows || []).find((row, index) =>
        String(row.id ?? row[firstKey] ?? index) === id) || {}
      return { ...original, ...fields, id, item_id: id }
    })
  /**
   * **实时重算**（不提交、不问服务端）：① 每行的行合计（列声明 `line_total_of`）
   * ② 面板声明的小计（`data.totals`，从编辑栏上的 `data-total="字段:系数"` 读规则）
   * ③ 已改行数。全部在 `input` 事件里同步完成 —— 改一个格子，小计立刻跟着变。
   * **取值顺序：DOM 里刚输入的值 > 面板数据里的原值**（数量这类只读列没有输入框，
   * 必须回落到原值，否则"单价×数量"里的数量会变成 0 —— 这是本轮走查实测到的真缺陷）。
   */
  function refreshEdits(panelNode) {
    if (!panelNode) return
    const panelId = panelNode.dataset.panel
    const panel = state.panels.find((item) => item.id === panelId)
    const source = panel?.data?.rows || []
    const firstKey = panel?.data?.columns?.[0]?.key
    // 行键与表格/编辑用的那一套一致（服务端窗口下由服务端给 `row_keys`；否则按原始下标）
    const viewForKeys = panelViews[panelId]
    const original = new Map()
    source.forEach((row, index) => original.set(viewForKeys
      ? viewForKeys.rowKeyOf(row, index)
      : String(row.id ?? row[firstKey] ?? index), row))
    const table = panelNode.querySelector('table[data-panel-table]')
    const dom = new Map()
    for (const tr of [...(table?.querySelectorAll('tbody tr[data-row-key]') ?? [])]) {
      const fields = {}
      tr.querySelectorAll('input[data-field]').forEach((input) => { fields[input.dataset.field] = input.value })
      dom.set(tr.dataset.rowKey, fields)
    }
    const valueOf = (rowKey, field) => {
      const typed = dom.get(rowKey)?.[field]
      if (typed !== undefined) return typed
      const typedAnywhere = (state.edits[`${panelId}|${rowKey}`] || {})[field]
      if (typedAnywhere !== undefined) return typedAnywhere
      return original.get(rowKey)?.[field]
    }
    panelNode.querySelectorAll('[data-linetotal]').forEach((node) => {
      const [rowKey, field] = String(node.dataset.linetotal).split(':')
      const base = valueOf(rowKey, field) ?? ''
      const factor = valueOf(rowKey, node.dataset.factor) ?? ''
      node.textContent = `×${factor === '' ? '—' : factor} = ${numOf(base) * numOf(factor)}`
    })
    // **小计按命中行集算**（与首屏渲染同一口径）：分页后本页只有几十行，若按 DOM 算，
    // 合计会随翻页变小 —— 那是错的数字。命中行集来自面板视图缓存（全量→筛选后的那批）。
    const view = panelViews[panelId]
    if (view && view.server) {
      // **服务端窗口**：小计在服务端按命中行集算（客户端手里只有一页，自己算必然少算别的页）。
      // 改了格子 ⇒ 把这一块带着改动（`pq.edits`）重取一次，小计由服务端重算；期间**如实标成"重算中"**，
      // 不拿本页的数字冒充全集（那正是"错数字"）。行内合计（×数量 = …）与"已改 N 行"仍然即时。
      const bar = panelNode.querySelector(`[data-editbar="${panelId}"]`)
      if (bar) bar.dataset.totalPending = '1'
      scheduleTotalsRefresh(panelId)
    } else {
      const rowsForTotals = view ? view.matched : [...dom.keys()].map((key) => original.get(key) ?? {})
      const keyOfRow = view ? (row) => view.rowKeyOf(row) : (row, index) => String(row.id ?? index)
      const live = totalsOf(panel?.data ?? {}, rowsForTotals, keyOfRow, valueOf)
      panelNode.querySelectorAll('[data-total]').forEach((node, index) => {
        const rule = live[index]
        const holder = node.querySelector('b')
        if (holder && rule) holder.textContent = String(rule.value)
      })
    }
    const changed = editRowsOf(panelId).length
    el('q-view').querySelectorAll(`[data-edit-count="${panelId}"]`)
      .forEach((node) => { node.textContent = String(changed) })
  }
  /** 改动之后的小计重算（服务端窗口）：去抖一次，读回的是服务端在命中行集上算好的那个数。 */
  const totalsTimers = {}
  function scheduleTotalsRefresh(panelId) {
    clearTimeout(totalsTimers[panelId])
    totalsTimers[panelId] = setTimeout(() => { refreshPanel(panelId) }, 260)
  }
  /**
   * ③ 键盘流转：`Enter` 同列下一行 / `Shift+Enter` 上一行 / `Tab` 下一格 / `Shift+Tab` 上一格 /
   * `Esc` 还原这一格 / `Ctrl·Cmd+Enter` 直接提交。焦点永远停在**可编辑单元格**上，
   * 备一份多行报价时可以只用键盘（不用鼠标逐个点）。
   */
  function focusCell(node, { forward = true, column = false } = {}) {
    const tr = node.closest('tr')
    const table = node.closest('table')
    if (!tr || !table) return
    const bodyRows = [...table.querySelectorAll('tbody tr[data-row-key]')]
    const cellsOf = (row) => [...row.querySelectorAll('input[data-edit]')]
    if (column) {
      const list = cellsOf(tr)
      const fieldAt = list.indexOf(node)
      const order = forward ? bodyRows.slice(bodyRows.indexOf(tr) + 1)
        : bodyRows.slice(0, bodyRows.indexOf(tr)).reverse()
      for (const row of order) {
        const candidate = cellsOf(row)[fieldAt] ?? cellsOf(row)[cellsOf(row).length - 1]
        if (candidate) return candidate.focus() && candidate.select?.()
      }
      return toast('ok', forward ? '已经是这一列的最后一行' : '已经是这一列的第一行',
        column ? '想加行就先在表格外的地方补一行（本表不支持插入行）' : '')
    }
    const flat = bodyRows.flatMap(cellsOf)
    const at = flat.indexOf(node)
    const next = flat[at + (forward ? 1 : -1)]
    if (!next) return toast('ok', forward ? '最后一个可编辑格子' : '第一个可编辑格子',
      '看编辑栏的小计，然后点「提交编辑」或按 Ctrl/Cmd+Enter')
    next.focus(); next.select?.()
  }

  function submitEdits(holder) {
    const panelId = holder?.dataset?.panel
    const panel = state.panels.find((item) => item.id === panelId)
      || state.panels.find((item) => item.data?.editable_action)
    const actionId = panel?.data?.editable_action
    const defaults = panel?.data?.editable_defaults || {}
    const rows = editRowsOf(panel?.id ?? panelId ?? '')
    if (!rows.length) {
      return toast('warn', '没有编辑内容', '改任意一个可编辑单元格后再提交（改了就会自动算进上面那条小计）')
    }
    if (!actionId) return toast('bad', '这个面板没有声明可编辑动作', '可编辑表格要在 data.editable_action 里声明动作 id')
    openAction(actionId, { rows, ...defaults, unit_price_cents: rows[0].unit_price_cents,
      lead_time_days: rows[0].lead_time_days }, null, { panel })
  }

  function openContextMenu(x, y, actions, rowOf) {
    closeContextMenu()
    const box = document.createElement('div')
    box.id = 'q-ctx'
    box.setAttribute('role', 'menu')
    box.style.left = `${x}px`; box.style.top = `${y}px`
    box.innerHTML = actions.map((action) => `<button role="menuitem" data-ctx="${attr(action.id)}">`
      + `${esc(action.title)}</button>`).join('')
    document.body.appendChild(box)
    box.querySelectorAll('[data-ctx]').forEach((node) => node.addEventListener('click', () => {
      closeContextMenu(); openAction(node.dataset.ctx, rowOf())
    }))
    setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0)
  }
  function closeContextMenu() { document.getElementById('q-ctx')?.remove() }

  async function loadBlocks() {
    const slot = `page.${state.route.view}`
    const out = await getJson(`/api/ui/blocks?slot=${encodeURIComponent(slot)}`)
    const holder = el('q-view').querySelector('[data-ui-blocks]')
    if (!holder) return
    if (out.ok && out.html) holder.innerHTML = `<details class="q-mech"><summary>插件注册的区块`
      + `（<code>${esc(slot)}</code>，${out.blocks} 块）</summary>${out.html}</details>`
    else holder.innerHTML = ''
  }

  // ---------------------------------------------------------------- 动作表单（客户端校验 + 界内确认）
  const actionOf = (id) => state.surface.actions.find((action) => action.id === id) || null

  // ================================================================ 入口策略（机制）：动作摆哪儿、缺上下文去哪
  /**
   * **"点了没用"的总根因**（P28 走查实测三处）：工具栏把那一个视角的**全部**动作平铺，其中包括
   * "必须先有某个对象/某一行才成立"的对象级、行级动作；它们在工具栏上没有上下文可预填 ⇒ 按下去只会
   * 得到「必填」。真正能用的是表格行内那颗按钮（行内把整行当预填）。
   *
   * 机制（**判据全在注册面的声明上，不是外壳猜的**）：
   *   ① 所需上下文由动作的 `needs` 给出（`/api/ui/surface` 里每个动作都带；口径见 `ui-surface.mjs`
   *      文件头「字段来源」段）：`route`（对象地址）/ `row`（那一行）/ `selection`（已选集合）/ `bulk`；
   *   ② 外壳据此**只把当前地址上跑得起来的动作摆进工具栏**：缺上下文的那批摆进同一页的
   *      「这些动作要先有一个对象」区，逐条写明**它该在哪跑**（在哪块面板的行里 / 得在对象页上），
   *      点一下就从候选里挑一条、**预填带入**再开表单；
   *   ③ 命令面板里**仍能找到全部**动作（一个不少），但缺上下文时进去的是**候选清单**，
   *      而不是一个空表单让人撞「必填」；一个候选都没有时如实说"现在没有可挑的"并给下一步。
   */
  const needsOf = (action) => action?.needs
    || { route: [], row: [], selection: [], session: [], version: [], user: [], new_value: [], bulk: false }
  const fieldOf = (action, name) => (action?.input?.fields || []).find((field) => field.name === name) || null
  const onObjectPage = () => Boolean(state.route.kind && state.route.id)
  /** 行里给这个字段的值：`row_field` 指了另一列就取那一列，没指就取同名列（既有约定）。 */
  const rowValueFor = (action, name, row) => {
    if (!row || typeof row !== 'object') return ''
    const key = String(fieldOf(action, name)?.row_field || name)
    const value = row[key]
    return value === undefined || value === null || String(value).trim() === '' ? '' : value
  }
  /**
   * 这个动作在**这个地址**上缺什么上下文？（空数组 = 现在就跑得起来）
   * `ctx.route` = 当前正站在对象页上（且对象类对得上）；`ctx.row` = 从哪一行进来的；`ctx.selection` = 有勾选。
   */
  function contextMissing(action, ctx = {}) {
    const needs = needsOf(action)
    const routeReady = Boolean(ctx.route) && onObjectPage()
      && (!action.object_kind || action.object_kind === state.route.kind)
    const rowValues = [ctx.row, ...(Array.isArray(ctx.rows) ? ctx.rows : [])].filter(Boolean)
    const out = []
    for (const [group, names] of [['route', needs.route], ['row', needs.row], ['selection', needs.selection]]) {
      if (!names.length) continue
      const pending = names.filter((name) => {
        if (group === 'route' && routeReady) return false
        if (group === 'selection' && ctx.selection) return false
        // 对象地址 / 那一行 / 已选集合可以互相顶替：手里任何一处给出了同名列的值就算数（同一条约定）
        return !rowValues.some((row) => rowValueFor(action, name, row) !== '')
      })
      if (pending.length) out.push({ group, fields: pending })
    }
    if (needs.bulk && !ctx.selection) out.push({ group: 'selection', fields: [] })
    return out
  }
  const placeOf = (action) => (Array.isArray(action.placement) && action.placement.length
    ? action.placement : ['toolbar'])
  /**
   * 工具栏分区（机制）：能在这个地址上跑的 → 摆按钮；缺上下文的 → 收进「要先有一个对象」区。
   * `placement` 是插件的声明：没声明 `toolbar` 的动作**不进工具栏**（它该在行内/命令面板里，不被搬走）。
   */
  function partitionActions(actions, ctx = {}) {
    const ready = []
    const need = []
    for (const action of actions) {
      if (!placeOf(action).includes('toolbar')) continue
      const missing = contextMissing(action, ctx)
      if (missing.length) need.push({ action, missing })
      else ready.push(action)
    }
    return { ready, need }
  }
  /** 候选清单的**每类上限**（挑一条不是让你在几百行里翻）；超了要在清单里写明「只列前 N 条」。 */
  const CANDIDATE_CAP = 12
  /**
   * 这个动作"该在哪跑"的候选（机制，按字段名与既有约定取值；外壳不认识任何业务名词）：
   *   · `rows`    = 这一页的面板里，**给得出它要的那些字段名**的行（挑一条就能预填带入）；
   *   · `objects` = 带对象深链（`row.ref`）的行 —— 需要"对象地址"的动作要站在那个对象的页面上才成立。
   *
   * **去重按"这一行会带进表单的值"，不按标签**（P33 修的缺陷）：修前去重键是 `${panel}:${标签}`，
   * 而标签优先取 `package_id`/`quote_id` 这种**一份对象一个名字**的字段 ⇒ 一份多行报价的几行在清单里
   * **塌成一条**：从引导入口只能挑到首行，要提第二行（如 `L-002`）得先回表格用查询条筛到那一行。
   * 现在两条行**只有预填指纹完全一样**才算同一个候选 ⇒ 多行报价的每一行都是可挑的一条；并且把
   * **能区分行的那几个字段值**补进按钮文字（否则清单上会并排出现几个一模一样的名字，等于没修）。
   * 最多各 12 条（挑一条不是让你在几百行里翻）。
   */
  function contextCandidates(action) {
    const needs = needsOf(action)
    const wanted = [...needs.route, ...needs.row, ...needs.selection]
    const rows = []
    const objects = []
    const seen = new Set()
    /** 一条候选在界面上怎么称呼（用行自己给的名字；都没有就拿第一列的值；再没有就按序号）。 */
    const labelOf = (panel, row, index) => {
      const first = (panel.data && panel.data.columns && panel.data.columns[0]) || null
      const named = row.label || row.title || row.name || row.intent_id || row.package_id || row.quote_id
        || row.po_id || row.gate_id || row.id || (first && first.key ? row[first.key] : '')
      return String(named === undefined || named === null || named === '' ? `第 ${index + 1} 行` : named)
    }
    /** **预填指纹**：这一行会把哪几个字段、取什么值带进表单（逐字段 `名字=值`，顺序取自声明）。
     *  它是去重的**唯一键** —— 名字一样不算同一条（同名不同行恰恰是多行报价的常态）。 */
    const fingerprintOf = (row) => wanted
      .map((name) => `${name}=${String(rowValueFor(action, name, row))}`).join('\u0001')
    /** 按钮上**区分行**的那半句：指纹里"不等于标签"的那些值（多行报价靠它分辨第几行）。 */
    const lineTagOf = (label, row) => wanted.map((name) => {
      const value = String(rowValueFor(action, name, row))
      return value !== '' && value !== label ? `${name}=${value}` : ''
    }).filter(Boolean).join(' · ')
    for (const panel of state.panels) {
      const data = panel.data || {}
      const list = Array.isArray(data.rows) ? data.rows : []
      for (let index = 0; index < list.length; index += 1) {
        const row = list[index]
        if (!row || typeof row !== 'object') continue
        const base = String((row.ref && row.ref.title) || labelOf(panel, row, index))
        if (row.ref && row.ref.kind && row.ref.id) {
          const key = `obj:${panel.id}:${row.ref.kind}:${row.ref.id}`
          if (!seen.has(key)) { seen.add(key); objects.push({ panel, row, label: base }) }
        }
        if (!wanted.length) continue
        let complete = true
        for (const name of wanted) {
          if (rowValueFor(action, name, row) === '') { complete = false; break }
        }
        if (!complete) continue
        const key = `row:${panel.id}:${fingerprintOf(row)}`
        if (seen.has(key)) continue
        seen.add(key)
        const lineTag = lineTagOf(base, row)
        rows.push({ panel, row, label: base, line_tag: lineTag,
          label_full: lineTag ? `${base} — ${lineTag}` : base })
      }
    }
    return { rows: rows.slice(0, CANDIDATE_CAP), objects: objects.slice(0, CANDIDATE_CAP),
      // **上限要可见**（不是把多的悄悄藏掉）：命中多少、列了几条、余几条一起给出去
      counts: { rows_hit: rows.length, rows_shown: Math.min(rows.length, CANDIDATE_CAP),
        objects_hit: objects.length, objects_shown: Math.min(objects.length, CANDIDATE_CAP) } }
  }
  /** 从候选行/对象取这次要预填的入参（只填它真给得出的那些字段名 —— 不编值）。 */
  function rowPresetOf(action, row) {
    const preset = {}
    for (const field of (action.input?.fields || [])) {
      const value = rowValueFor(action, field.name, row)
      if (value !== '') preset[field.name] = value
    }
    return preset
  }
  /** 缺什么、该去哪跑 —— 一句人话（依据是**插件自己声明的行内归属**与候选，不猜）。 */
  const affinityOf = (action) => (state.surface.action_entry || [])
    .find((item) => item.id === action.id)?.affinity || []
  function whereText(action, missing) {
    const groups = missing.map((item) => item.group)
    const panels = affinityOf(action).map((item) => item.split('/').slice(1).join('/'))
    const titles = panels.map((id) => (state.panels.find((panel) => panel.id === id) || {}).title || id)
    const bits = []
    if (groups.includes('row') || groups.includes('selection')) {
      bits.push(titles.length
        ? `它在「${titles.slice(0, 2).join('」「')}」这张表的**行内**能跑（行里那颗按钮会把整行带入）`
        : '它要**某一行**的数据（在带这个对象的表里、行内那颗按钮上跑）')
    }
    if (groups.includes('route')) {
      bits.push(titles.length ? `要在「${titles.slice(0, 2).join('」「')}」里那**一条对象**的页面上跑`
        : '要在**那条对象的页面**上跑（页头工具栏）')
    }
    if (groups.includes('selection')) bits.push('先在带勾选的表里勾几行，表头会出现批量按钮')
    return bits.join('；') || '先挑一条'
  }
  /**
   * **缺上下文时的入口**（机制）：不摆空表单，先让人挑一条 ——
   *   · 有"给得出这些字段"的行 ⇒ 挑一条，按那行**预填**开表单（与行内那颗按钮同一条路）；
   *   · 只有对象行（`ref`）⇒ 打开那条对象的页面，并在那一页上**自动打开**这个动作（对象地址会预填）；
   *   · 一条候选都没有 ⇒ 如实说"现在没有可挑的"，并给出**能做的下一步**（起步指引里的真动作）。
   */
  function openActionEntry(id, presets = null) {
    const action = actionOf(id)
    if (!action) {
      return toast('bad', '动作不存在', `注册面里没有 ${id}（插件卸载后它的入口会消失：刷新页面看当前可用的动作）`)
    }
    const ctx = { route: onObjectPage() }
    const missing = contextMissing(action, ctx)
    if (!missing.length) return openAction(id, presets)
    const { rows, objects, counts: found } = contextCandidates(action)
    const steps = (state.surface.guides || []).filter((guide) => guide.view === state.route.view)
      .flatMap((guide) => guide.steps || []).filter((step) => actionOf(step.action)).slice(0, 3)
    const item = (payload, text) => `<li>${payload} <span class="q-hint">${esc(text)}</span></li>`
    const body = html([
      `<h2 id="q-action-title">${esc(action.title)}：先挑一条</h2>`,
      `<p class="q-src">这一步要有上下文才成立：<code>${esc(missing.flatMap((item) => item.fields).join('、') || '已选集合')}</code>`
      + ` —— 外壳不摆一个空表单让人撞「必填」，而是把你带到能填的地方。</p>`,
      action.hint ? `<p class="q-hint">${esc(action.hint)}</p>` : '',
      `<p class="q-hint">${esc(whereText(action, missing))}</p>`,
      rows.length ? `<h3>从这一页的表里挑一条（会把那一行带入表单）</h3>${found.rows_hit > found.rows_shown
        ? `<p class="q-hint" data-entry-capped="rows">命中 ${found.rows_hit} 条，只列前 ${found.rows_shown} 条`
          + `（余 ${found.rows_hit - found.rows_shown} 条没列出来 —— 不是没有）：要在别的行上跑，`
          + `先在上面那块表里筛一下，候选会跟着变</p>` : ''}<ul class="q-entry-list">${
        rows.map((item2, index) => item(`<button data-entry-row="${attr(index)}">${esc(item2.label_full)}</button>`,
          `在「${esc(item2.panel.title)}」里${item2.line_tag ? ` — 带入：${esc(item2.line_tag)}` : ''}`)).join('')}</ul>` : '',
      objects.length ? `<h3>或打开一条对象，在它自己的页面上跑</h3>${found.objects_hit > found.objects_shown
        ? `<p class="q-hint" data-entry-capped="objects">命中 ${found.objects_hit} 条，只列前 ${found.objects_shown} 条</p>`
        : ''}<ul class="q-entry-list">${
        objects.map((item2, index) => item(`<button data-entry-object="${attr(index)}">打开 ${esc(item2.label)} →</button>`,
          `对象类 ${esc(item2.row.ref.kind)}｜在那一页上这个动作会自动打开`)).join('')}</ul>` : '',
      !rows.length && !objects.length
        ? `<div class="q-state info" data-state="empty" data-state-reason="no-context-candidate">`
          + `<b>现在这一页没有可挑的（不是坏了）</b> <code>no-context-candidate</code>`
          + `<div class="q-hint">这一步要的那条对象还不存在 —— 先让它存在，再回来点这个动作。</div></div>`
        : '',
      steps.length ? `<h3>现在真能做的下一步</h3><ul class="q-entry-list">${
        steps.map((step, index) => item(`<button class="primary" data-entry-step="${attr(index)}">${
          esc(step.label || actionOf(step.action).title)}</button>`, '注册面里的真动作：点了就开它的表单')).join('')}</ul>`
        : '<p class="q-hint">下一步：用 <kbd>Ctrl/⌘+K</kbd> 搜别的动作，或先在上面两步里造出这条对象。</p>',
      `<div class="q-actions q-modal-foot"><button data-close="1">关闭</button></div>`])
    openModal(body, 'q-entry-modal')
    const modal = el('q-modal')
    modal.querySelector('[data-close]').addEventListener('click', closeModal)
    modal.querySelectorAll('[data-entry-row]').forEach((node) => node.addEventListener('click', () => {
      const picked = rows[Number(node.dataset.entryRow)]
      if (!picked) return
      closeModal()
      openAction(action.id, { ...(presets || {}), ...rowPresetOf(action, picked.row) }, null, { panel: picked.panel })
    }))
    modal.querySelectorAll('[data-entry-object]').forEach((node) => node.addEventListener('click', () => {
      const picked = objects[Number(node.dataset.entryObject)]
      if (!picked) return
      closeModal()
      navigate(picked.row.ref.view || state.route.view, picked.row.ref.kind, picked.row.ref.id,
        { thenAction: action.id })
    }))
    modal.querySelectorAll('[data-entry-step]').forEach((node) => node.addEventListener('click', () => {
      const step = steps[Number(node.dataset.entryStep)]
      if (!step) return
      closeModal()
      openAction(step.action, step.input || {})
    }))
  }

  /** 只读对账面（机制）：入口策略的判定读数 —— 验证脚本按它逐条核对"这个动作在哪摆、缺什么"。
   *  它**不改任何状态**（只调上面那几个纯函数）。 */
  window.__Q_GUI_ENTRY = {
    needs: (id) => { const action = actionOf(id); return action ? needsOf(action) : null },
    missingHere: (id) => { const action = actionOf(id); return action ? contextMissing(action, { route: onObjectPage() }) : null },
    candidates: (id) => {
      const action = actionOf(id)
      if (!action) return null
      const found = contextCandidates(action)
      return { rows: found.rows.map((item) => `${item.panel.id}:${item.label_full}`),
        objects: found.objects.map((item) => `${item.panel.id}:${item.label}`),
        counts: found.counts }
    },
    toolbar: () => partitionActions(viewActions(), {}).ready.map((action) => action.id),
    needsContext: () => partitionActions(viewActions(), {}).need.map((item) => ({
      id: item.action.id, missing: item.missing.map((one) => `${one.group}:${one.fields.join(',')}`) })),
    emptiness: () => { const out = viewEmptiness(); return { empty: out.empty, total: out.total,
      home: out.home, home_nothing: out.home_nothing, with_data: out.withData.map((panel) => panel.id) } } }

  /** 「这些动作要先有一个对象」区（机制）：**不是把功能藏起来** —— 逐条写明它该在哪跑，点一下就挑一条。 */
  function needsContextBlock(list, label) {
    if (!list.length) return ''
    return `<details class="q-need-context" data-need-context="${attr(label)}">`
      + `<summary>这些动作要先有一个对象（${list.length} 个）—— 点一下从候选里挑一条，或去它该在的地方跑</summary>`
      + `<ul>` + list.map((item) => `<li><button class="q-link" data-pick-action="${attr(item.action.id)}">${
        esc(item.action.title)}${item.action.permission === 'human-signature' ? ' ✍' : ''}</button>`
        + `<div class="q-hint">${esc(whereText(item.action, item.missing))}｜缺：<code>${
          esc(item.missing.flatMap((one) => one.fields).join('、') || '已选集合')}</code></div></li>`).join('') + '</ul></details>'
  }

  // ---------------------------------------------------------------- 乐观并发：把"你看到的那一版"填进表单
  /**
   * **机制**：动手保存前，界面要把"你打开这一页时看到的对象版本"带回服务端（否则服务端只能按
   * 安全默认判 —— 会覆盖别人的改动就拒）。版本由插件声明（`panel.data.version` / 行的 `version` /
   * 对象页页头的 `version`），面板可以再用 `version_for:'<动作 id>'` 说明"这一版是给哪个动作用的"。
   * 取值顺序（都有出处，不猜）：
   *   ① 打开这个动作时明确给的预填值（`editable_defaults` / 行里那个字段）
   *   ② 行的 `version`（行内动作 / 批量 / 右键菜单）
   *   ③ 打开它的那块面板的 `data.version`（可编辑表格"提交编辑"这一路）
   *   ④ 页面上声明 `version_for` 命中这个动作的面板
   *   ⑤ 对象页页头的 `version`
   * 一个都取不到 ⇒ 空串（服务端按安全默认判：**会覆盖别人的改动就拒**）。
   */
  const fingerprintOfVersion = (version) => {
    if (!version) return ''
    if (typeof version === 'string') return version.trim()
    if (typeof version !== 'object') return ''
    const hash = String(version.fingerprint ?? '').trim()
    if (hash !== '') return hash
    return version.rev === undefined || version.rev === null ? '' : `rev:${version.rev}`
  }
  const versionFieldOf = (action) => (action.input?.fields || []).find((field) => field.version_field === true) || null
  function versionPreset(action, { preset = {}, panel = null, fresh = false } = {}) {
    const field = versionFieldOf(action)
    if (!field) return { preset: {}, note: null }
    const fromPanel = (item) => (item?.data?.version_for === action.id || item?.id === panel?.id
      ? fingerprintOfVersion(item?.data?.version) : '')
    const candidates = fresh
      ? [fingerprintOfVersion(panel?.data?.version), fromPanel(panel), fingerprintOfVersion(preset.version),
        ...state.panels.map(fromPanel), fingerprintOfVersion(state.object?.version)]
      : [preset[field.name], fingerprintOfVersion(preset.version), fingerprintOfVersion(panel?.data?.version),
        ...state.panels.map(fromPanel), fingerprintOfVersion(state.object?.version)]
    const value = candidates.find((item) => typeof item === 'string' && item.trim() !== '') ?? ''
    // 版本的人话说明（有 `rev/at/by` 就说出来；只有指纹就把指纹摆出来）——界面不编，只搬运
    const sources = [preset.version, panel?.data?.version, ...state.panels.map((item) => item.data?.version),
      state.object?.version].filter((item) => item && typeof item === 'object')
    const found = sources.find((item) => fingerprintOfVersion(item) === value) ?? null
    const note = value === ''
      ? '这一次**没有带上版本**（这一页没有声明"你看到的那一版"）：服务端按安全默认判 ——'
        + '内容与现在一样就放行，**会覆盖别人的改动就拒**'
      : `你带上的版本：${found
        ? `rev ${esc(String(found.rev ?? '?'))}${found.by ? ` · ${esc(String(found.by))}` : ''}`
          + `${found.at ? ` @ ${esc(String(found.at).slice(0, 19))}` : ''}`
        : '（只有指纹）'} ｜ \`${esc(String(value).slice(0, 23))}…\` —— `
        + '别人在你打开这一页之后先保存过，这次保存就会被明确拒绝并给出差异'
    return { preset: { [field.name]: value }, note }
  }

  function fieldHtml(field, value) {
    const v = value === undefined || value === null ? (field.default ?? '') : value
    const fromSession = (field.identity === true || field.type === 'signature')
      && String(v).startsWith('human:') ? '（= 你当前的会话身份，改错了服务端会拒）' : ''
    const help = field.help || fromSession
      ? `<span class="q-help">${esc(field.help || '')}${fromSession ? esc(fromSession) : ''}</span>` : ''
    const id = `f-${field.name}`
    // **只读字段**（机制/插件自己带上的值：如乐观并发的 `expected_version`）：看得见、发得出、不必手抄。
    if (field.readonly === true) {
      return `<div class="q-field q-field-readonly"><label for="${attr(id)}">${esc(field.label)}`
        + `${field.required ? ' *' : ''} <span class="q-tag">只读</span></label>`
        + `<input id="${attr(id)}" name="${attr(field.name)}" type="text" value="${attr(v)}" readonly`
        + `${field.version_field ? ' data-version-field="1"' : ''}>${help}</div>`
    }
    if (field.type === 'textarea') {
      return `<div class="q-field"><label for="${attr(id)}">${esc(field.label)}${field.required ? ' *' : ''}</label>`
        + `<textarea id="${attr(id)}" name="${attr(field.name)}" rows="4">${esc(v)}</textarea>${help}`
        + `<span class="q-fielderr" data-err="${attr(field.name)}" role="alert"></span></div>`
    }
    if (field.type === 'select') {
      return `<div class="q-field"><label for="${attr(id)}">${esc(field.label)}${field.required ? ' *' : ''}</label>`
        + `<select id="${attr(id)}" name="${attr(field.name)}">${(field.options || []).map((option) =>
          `<option value="${attr(option)}"${String(option) === String(v) ? ' selected' : ''}>${esc(option)}</option>`)
          .join('')}</select>${help}<span class="q-fielderr" data-err="${attr(field.name)}" role="alert"></span></div>`
    }
    if (field.type === 'checkbox') {
      return `<div class="q-field"><label class="q-inline"><input type="checkbox" id="${attr(id)}"`
        + ` name="${attr(field.name)}"${v ? ' checked' : ''}> ${esc(field.label)}</label>${help}`
        + `<span class="q-fielderr" data-err="${attr(field.name)}" role="alert"></span></div>`
    }
    const inputmode = field.type === 'number' ? ' inputmode="decimal"' : ''
    const hint = field.type === 'number' ? `<span class="q-help">只填数字（金额一律<b>整数分</b>：8600 = 86.00）</span>` : ''
    // 自动补全（机制）：声明了 `suggest_url` 的字段挂一个 `<datalist>`，候选由**本服务**的只读接口给
    // （`openAction` 里异步灌进去）；声明了 `mention_suggest_url` 的文本域在打 `@` 时弹候选。
    const suggest = field.suggest_url
      ? `<datalist data-suggest="${attr(field.name)}" id="dl-${attr(field.name)}"></datalist>`
        + `<span class="q-help">候选来自服务端（自动补全；也可以照旧手敲）</span>` : ''
    return `<div class="q-field"><label for="${attr(id)}">${esc(field.label)}${field.required ? ' *' : ''}</label>`
      + `<input id="${attr(id)}" name="${attr(field.name)}" type="text"${inputmode} value="${attr(v)}"`
      + ` data-field-type="${attr(field.type)}">${help}${hint}${suggest}`
      + `<span class="q-fielderr" data-err="${attr(field.name)}" role="alert"></span></div>`
  }

  function validateInput(action, input) {
    const errors = []
    // 批量动作（`input.bulk='ids'` 且请求里带了 ids/rows）：**对象 id 字段由批量清单顶替**，
    // 不要再逼用户手抄一个 id（P3 走查实测：批量受理被"报价 id 必填"挡在确认层之前）。
    const bulkIds = Array.isArray(input.ids) && input.ids.length > 0
    const bulkRows = Array.isArray(input.rows) && input.rows.length > 0
    for (const field of action.input?.fields || []) {
      const covered = (bulkIds || bulkRows) && (field.from_route === true || action.input?.bulk === 'rows' && field.name === 'item_id')
      const value = input[field.name]
      const empty = value === undefined || value === null || String(value).trim() === ''
      if (field.required && empty && !covered) {
        errors.push({ field: field.name, code: 'required', message: '必填' })
      }
      if (empty) continue
      if (field.type === 'number' && !Number.isFinite(Number(value))) {
        errors.push({ field: field.name, code: 'not-a-number', message: '必须是数' })
      }
      if (field.min !== null && field.min !== undefined && Number(value) < Number(field.min)) {
        errors.push({ field: field.name, code: 'below-min', message: `不得小于 ${field.min}` })
      }
      if (field.max !== null && field.max !== undefined && Number(value) > Number(field.max)) {
        errors.push({ field: field.name, code: 'above-max', message: `不得大于 ${field.max}` })
      }
      if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
        errors.push({ field: field.name, code: 'pattern', message: `形状不符合规则（${field.pattern}）` })
      }
      if (field.type === 'signature' && !String(value).startsWith('human:')) {
        errors.push({ field: field.name, code: 'human-required', message: '署名必须以 human: 开头（agent 不得代签）' })
      }
    }
    return errors
  }

  function readInputs(action, modal, values) {
    const input = {}
    for (const field of action.input?.fields || []) {
      const node = modal.querySelector(`[name="${field.name}"]`)
      if (!node) continue
      input[field.name] = field.type === 'checkbox' ? node.checked
        : (field.type === 'number' ? Number(node.value) : node.value)
    }
    for (const key of Object.keys(values || {})) if (!(key in input)) input[key] = values[key]
    if (values?.rows && !input.rows) input.rows = values.rows
    if (values?.ids && !input.ids) input.ids = values.ids
    return input
  }

  // ---------------------------------------------------------------- 批量动作：进度 / 回执 / 出口（P21）
  /**
   * **批量动作**（注册面声明 `input.bulk === 'ids'`：一次署名、逐份落账的那几颗）。
   *
   * P21 这一批给它的界面加三样东西：
   *   ① **实时进度**（D1）：服务端把这一批的进度落在 `/api/ui/jobs`（写者逐条回执）—— 提交期间轮询它，
   *      把"正在签哪一个 / 已经几份"写在弹层里，而不是让用户对着一个不动的按钮等；
   *   ② **只重试被拒/未完成的那些**（D6）：回执里逐条写明哪几条被拒、哪几条没做 —— 界面给一颗按钮
   *      只把这几个 id 再送一次（幂等：重复的会如实报 duplicates，账本零新增）；
   *   ③ **超限的出口**（D6）：`batch-too-large` 时给「只签前 N 份」（N 取服务端自己说的那个上限）。
   *
   * 这里**不替插件做任何判定**：哪几条被拒、上限是多少，全部照抄回执/拒绝里的字面量。
   */
  const isBatchAction = (action) => String(action?.input?.bulk ?? '') === 'ids'
  const batchTotalOf = (out) => Number(out?.job?.total ?? (out?.result?.results || []).length) || 0
  const batchRefusedOf = (out) => {
    const named = out?.job?.refused_ids
    if (Array.isArray(named) && named.length) return named
    return (out?.result?.results || []).filter((row) => row?.where === 'refused')
      .map((row) => row.draft_id || row.gate_id || row.id || '').filter(Boolean)
  }
  const batchPendingOf = (out) => (Array.isArray(out?.job?.pending_ids) ? out.job.pending_ids : [])
  const batchIdsOf = (out) => (Array.isArray(out?.job?.ids) ? out.job.ids : [])
  /** 服务端自己说的"一次最多几份"（从拒绝文案里取第一个整数；取不到就写'上限'，不编一个数）。 */
  const batchCapOf = (out) => {
    const match = /(\d+)\s*(份|条)/.exec(String(out?.reason || ''))
    const value = match ? Number(match[1]) : null
    return Number.isFinite(value) && value > 0 ? value : null
  }
  /** 「还能做什么」的按钮（要被 `wireBatchNext` 接上；没有出口时返回空串，界面不摆按不动的按钮）。 */
  function batchNextHtml(action, out) {
    const buttons = []
    const ids = batchIdsOf(out)
    const pending = batchPendingOf(out)
    const refused = batchRefusedOf(out)
    const retry = [...new Set([...refused, ...pending])]
    const cap = batchCapOf(out)
    if (out?.code === 'batch-too-large' && ids.length && cap && ids.length > cap) {
      buttons.push(`<button class="primary" data-batch-slice="${attr(cap)}">只签前 ${cap} ${action.input?.bulk === 'ids' ? '份' : '条'}`
        + `（服务端说一次最多 ${cap}）</button>`)
    }
    if (retry.length) {
      buttons.push(`<button class="primary" data-batch-retry="1">只重试被拒/未完成的 ${retry.length} `
        + `${retry.length > 1 ? '份' : '份'}（幂等：已完成的会如实报"已经签过"）</button>`)
    }
    return buttons.length ? `<div class="q-actions q-batch-next" data-batch-next="1">${buttons.join('')}</div>` : ''
  }
  /** 接上「只重试被拒项 / 只签前 N 份」：都是**同一个动作 + 同一份署名**，只是 ids 换成要重做的那些。 */
  function wireBatchNext(host, action, out, input, options = {}) {
    if (!host) return
    const keep = { ...(input || {}) }
    delete keep.confirm_ack
    const ids = batchIdsOf(out)
    const cap = Number(host.querySelector('[data-batch-slice]')?.dataset?.batchSlice || 0)
    const slice = host.querySelector('[data-batch-slice]')
    if (slice && cap > 0) {
      slice.addEventListener('click', () => {
        openAction(action.id, { ...keep, ids: ids.slice(0, cap) }, null, { panel: options.panel || null })
      })
    }
    const retry = host.querySelector('[data-batch-retry]')
    if (retry) {
      retry.addEventListener('click', () => {
        const wanted = [...new Set([...batchRefusedOf(out), ...batchPendingOf(out)])]
        openAction(action.id, { ...keep, ids: wanted }, null, { panel: options.panel || null })
      })
    }
  }
  /**
   * **批量进度**：提交期间轮询 `/api/ui/jobs`（只读、按会话身份），把"正在签哪一个 / 已经几份"写进弹层。
   * 服务端不可达/离线时**不假装有进度**（写一行"读不到进度"，别的照旧）。
   */
  function startBatchProgress(modal, action) {
    const holder = modal?.querySelector?.('.q-modal-body') || modal
    if (!holder) return () => {}
    let node = holder.querySelector('[data-batch-progress]')
    if (!node) {
      node = document.createElement('div')
      node.className = 'q-batch-progress'
      node.setAttribute('data-batch-progress', '1')
      node.setAttribute('role', 'status')
      holder.prepend(node)
    }
    let stopped = false
    const paint = (jobs) => {
      if (stopped) return
      const run = (jobs.running || [])[0] || null
      if (run) {
        const active = run.active || {}
        node.innerHTML = `<b>正在逐份落账：${run.done ?? 0}/${run.total}</b>`
          + `${active.target ? ` · 当前 <code>${esc(active.target)}</code>` : ''}`
          + `${run.total ? ` · ${Math.round(((run.done ?? 0) / run.total) * 100)}%` : ''}`
          + `<div class="q-hint">服务端在 worker 线程里逐条跑唯一写者（界面不写账本）：`
          + `已完成 ${run.done ?? 0} 次写者调用${run.ledger_seen ? ` · 账本 +${run.ledger_seen} 行` : ''}；`
          + `这一批的记录在 <code>/api/ui/jobs</code>，刷新页面也读得回来</div>`
        return
      }
      const recent = (jobs.recent || [])[0]
      if (recent && recent.id) {
        // 没跑完的记录：说清**还剩几份真没做**（服务端收尾对账之后的数）；对账完剩 0 ⇒ 如实说"已被后来的批次收尾"
        const unfinished = (recent.pending_ids || []).length + (recent.refused_ids || []).length
        const mid = recent.status === 'interrupted' || recent.status === 'failed'
        node.innerHTML = `<b>上一批：${mid ? (unfinished ? '没有跑完（进程中断）' : '中断过，但没剩下要做的了') : '已结束'}</b>`
          + `<div class="q-hint">${esc(recent.title || '')} · 共 ${recent.total} · 已签 ${recent.applied} · `
          + `已签过 ${recent.duplicates} · 被拒 ${recent.refused} · 待办 ${unfinished}</div>`
      } else {
        node.textContent = '正在提交这一批…（还没拿到逐条进度）'
      }
    }
    const tick = async () => {
      if (stopped) return
      const out = await getJson('/api/ui/jobs')
      if (stopped) return
      if (out && out.ok) paint(out)
      else if (out && out.code === 'offline') node.textContent = '离线：读不到逐条进度（提交仍在服务端跑）。'
      else node.textContent = '读不到逐条进度（/api/ui/jobs 不可达）—— 提交本身照旧。'
    }
    tick()
    const timer = setInterval(tick, 800)
    return () => { stopped = true; clearInterval(timer) }
  }
  /** **批量回执弹层**：逐条结果 + 「只重试被拒/未完成」/「只签前 N 份」两个出口（有才给）。 */
  function batchReceipt(action, out, input, options = {}) {
    const job = out?.job || {}
    const rows = (out?.result?.results || []).map((row) => ({
      id: row.draft_id || row.gate_id || row.id || '',
      where: row.where, code: row.code || '', added: Number(row.ledger_added ?? 0),
      reason: row.reason || '', next: row.next_action || '' }))
    const group = (kind) => rows.filter((row) => row.where === kind)
    /** 这一批**真落了几行**（回执里现成：批量走 `job.ledger_added`，兜底逐条相加）。 */
    const batchAdded = ledgerAddedOf(out) ?? rows.reduce((sum, row) => sum + row.added, 0)
    const zeroBatch = batchAdded === 0
    const list = (kind, label) => {
      const picked = group(kind)
      if (!picked.length) return ''
      return `<h4>${label}（${picked.length}）</h4><ul class="q-batch-list">`
        + picked.map((row) => `<li><code>${esc(row.id)}</code> ${row.code ? `· <code>${esc(row.code)}</code>` : ''}`
          + `${row.added ? ` · 账本 +${row.added}` : ''}${row.reason ? `<div class="q-hint">${esc(row.reason)}</div>` : ''}`
          + `${row.next ? `<div class="q-hint">下一步：${esc(row.next)}</div>` : ''}</li>`).join('') + '</ul>'
    }
    openModal(html([
      `<h2 id="q-action-title">回执：${esc(action.title)}</h2>`,
      '<div class="q-modal-body">',
      `<p class="q-degraded" data-batch-summary="1" data-batch-ledger-added="${attr(batchAdded)}">`
      + `${zeroBatch
        ? `<b data-batch-zero="1">这一批零新增：账本 +0 行 —— 没有任何新事实被写出来</b>（下面对每一份说清它是"已经签过"还是"被拒"）<br>`
        : ''}`
      + `共 <b>${job.total ?? rows.length}</b> 份：`
      + `已签 <b>${job.applied ?? group('applied').length}</b> · 已经签过（幂等）`
      + `<b>${job.duplicates ?? group('duplicates').length}</b> · 被拒 <b>${job.refused ?? group('refused').length}</b>`
      + `（本次账本 +${batchAdded} 行${zeroBatch ? '：**没有新增任何事实**' : ''}）`
      + `<span class="q-hint">这份逐条回执也落服务端（<code>/api/ui/jobs</code>）：刷新或换设备都读得回来</span></p>`,
      list('applied', '已签'),
      list('duplicates', '已经签过（幂等，零新增）'),
      list('refused', '被拒（每一条各自的原因）'),
      batchNextHtml(action, out),
      '<div class="q-actions q-modal-foot"><button data-close="1">关闭</button></div>',
      '</div>']), 'q-batch-receipt')
    const modal = el('q-modal')
    modal?.querySelector('[data-close]')?.addEventListener('click', closeModal)
    wireBatchNext(modal, action, out, input, options)
  }

  function openAction(id, presets, priorResult, options = {}) {
    const action = actionOf(id)
    if (!action) {
      return toast('bad', '动作不存在', `注册面里没有 ${id}（插件卸载后它的入口会消失：刷新页面看当前可用的动作）`)
    }
    const fields = action.input?.fields || []
    // 对象页上：声明了 `from_route` 的字段用**当前对象地址的 id** 预填（插件自己声明"它就是那个对象的 id"），
    // 于是对象页工具栏上的动作一键打开即可，不用手抄 id。
    const routePreset = {}
    if (state.route.kind && state.route.id) {
      for (const field of fields) {
        if (field.name in (presets || {})) continue
        if (field.from_route) routePreset[field.name] = state.route.id
        // `from_route_kind`（注册面声明）：这个字段要的是**对象类**，不是 id —— 于是同一份"视图级动作"
        // 对任何对象类都成立（协作类的指派/关注/评论就是这么挂到每个对象页上的）。
        if (field.from_route_kind) routePreset[field.name] = state.route.kind
      }
    }
    // 会话身份预填：`type:'signature'` 的字段与插件标了 `identity:true` 的字段（如"发言人"）——
    // 用当前登录身份填上（人签只能本人签：填错名字服务端会拒，这里只是省去手抄）。
    const identityPreset = {}
    const me = state.identity
    if (me && me.human) {
      for (const field of fields) {
        if (field.name in (presets || {}) || field.name in routePreset) continue
        if (field.type === 'signature' || field.identity === true) identityPreset[field.name] = me.human
      }
    }
    const values = { ...routePreset, ...identityPreset, ...(presets || {}) }
    // 会话身份兜底：`prepared_by`/`actor` 这类字段即使被空串预填（例如插件给了 `editable_defaults.prepared_by: ''`）
    // 也要落回会话身份 —— 否则用户会因为一个他自己没填过的空字段被"必填"挡住。
    if (me && me.human) {
      for (const field of fields) {
        if (field.type !== 'signature' && field.identity !== true) continue
        if (String(values[field.name] ?? '').trim() === '') values[field.name] = me.human
      }
    }
    // **乐观并发**：把"你打开这一页时看到的那一版"填进只读字段（插件声明了 `version_field` 才有）
    const versionInfo = versionPreset(action, { preset: values, panel: options.panel || null,
      fresh: options.fresh === true })
    Object.assign(values, versionInfo.preset)
    const body = html([
      `<h2 id="q-action-title">${esc(action.title)}</h2>`,
      `<p class="q-src">动作 <code>${esc(action.id)}</code> · 由 <code>${esc(action.plugin_id)}</code> 注册 · `
      + `权限 <code>${esc(action.permission)}</code>`
      + `${action.confirm?.required ? ' · 提交前会再确认一次' : ''}`
      + `${action.object_kind ? ` · 作用于 <code>${esc(action.object_kind)}</code>` : ''}`
      + `${action.concurrency ? ` · 受版本保护：<code>${esc(action.concurrency.object_class)}</code>`
        + `（${esc(action.concurrency.label)}）` : ''}</p>`,
      '<div class="q-modal-body">',
      action.hint ? `<p class="q-hint">${esc(action.hint)}</p>` : '',
      action.permission === 'human-signature'
        ? `<p class="q-degraded">这一步是人工门：<code>signature</code> 里的署名会随请求送到插件自己的`
          + `服务端一半，再由 Python 侧唯一写者落账本（界面不是第二条事实写路径）。</p>` : '',
      fields.map((field) => fieldHtml(field, values[field.name])).join(''),
      versionInfo.note ? `<p class="q-hint q-version-note" data-version-note="1">${versionInfo.note}</p>` : '',
      (action.input?.bulk && values.ids ? `<p class="q-hint">批量：${esc(values.ids.length)} 行</p>` : ''),
      (values.rows && values.rows.length ? `<p class="q-hint">这次提交会带上 <b>${values.rows.length}</b> 行`
        + `（表格里改过的行）：${values.rows.map((row) => `<code>${esc(row.item_id ?? row.id ?? '')}</code>`)
          .join(' ')}</p>` : ''),
      '<div data-result="1"></div>',
      '</div>',
      `<div class="q-actions q-modal-foot"><button class="primary" data-run="1">${action.confirm?.required
        ? '下一步：确认' : '执行'}</button><button data-close="1">取消</button></div>`])
    openModal(body, 'q-action-modal')
    const modal = el('q-modal')
    modal.querySelector('[data-close]').addEventListener('click', closeModal)
    // 自动补全（机制）：`suggest_url` ⇒ datalist；`mention_suggest_url` ⇒ 正文里打 `@` 弹候选。
    wireSuggest(modal, fields)
    wireMention(modal, fields)
    // 上一次失败的结果（被拒原因 / errors / 下一步）跟着表单一起回来 —— 不能只在 toast 里一闪而过
    if (priorResult) {
      const holder = modal.querySelector('[data-result]')
      if (holder) holder.innerHTML = resultHtml(priorResult, action)
    }
    const first = modal.querySelector('input, textarea, select')
    if (first) first.focus()
    const run = async (input) => {
      // **批量动作：先挂上实时进度**（P21 / D1）—— 提交期间弹层里一直显示"正在逐份落账 N/M · 当前是哪一个"。
      const batch = isBatchAction(action)
      const stopProgress = batch ? startBatchProgress(el('q-modal'), action) : null
      const out = await postJson(`/api/action/${encodeURIComponent(action.id)}`,
        { view: state.route.view, route: state.route, input })
      if (stopProgress) stopProgress()
      notifyAction(out, action)
      if (out.ok) {
        // **导出/打印**（`result.export`）：落一份文件 + 打开预览（打印在预览里一键完成）
        const exported = out.result && out.result.export ? { ...out.result.export } : null
        // **分享**（`result.share`）：深链 + "对方需要什么身份/侧" + 可粘贴的邮件正文
        const shared = out.result && out.result.share ? out.result.share : null
        closeModal()
        await loadAll()
        if (exported) deliverExport({ result: { export: exported } }, action)
        if (shared) return shareModal(shared, action)
        // **批量回执**（P21）：逐条结果 + 「只重试被拒/未完成的那几份」出口（部分失败时这正是用户要的）
        if (batch && (out.result?.results || out.job)) {
          return batchReceipt(action, out, input, { panel: options.panel || null })
        }
        return
      }
      // 失败：**回到表单**（确认弹层已经不在 DOM 里了，把结果写进它等于丢掉）并逐字段标红
      openAction(action.id, input, out, { panel: options.panel || null })
      const back = el('q-modal')
      for (const error of (out.errors || []).filter((item) => item.field)) {
        const node = back?.querySelector(`[data-err="${error.field}"]`)
        if (node) node.textContent = `${error.code}：${error.message}`
      }
      // **批量被拒的出口**（P21 / D6）：`batch-too-large` ⇒ 「只签前 N 份」；部分被拒 ⇒ 「只重试被拒的 N 份」。
      if (batch && back) {
        const holder = back.querySelector('[data-result]') || back.querySelector('.q-modal-body')
        if (holder) {
          holder.insertAdjacentHTML('beforeend', batchNextHtml(action, out))
          wireBatchNext(holder, action, out, input, { panel: options.panel || null })
        }
      }
      // **乐观并发冲突**：第二条写的人看到的不是"失败了"四个字，而是"谁在何时把哪个字段改成了什么"
      if (out.code === 'object-changed' && out.result?.conflict) {
        wireConflict(back, action, input, out.result.conflict, options.panel || null)
      }
    }
    modal.querySelector('[data-run]').addEventListener('click', async () => {
      const input = readInputs(action, modal, values)
      const errors = validateInput(action, input)
      modal.querySelectorAll('[data-err]').forEach((node) => { node.textContent = '' })
      if (errors.length) {
        for (const error of errors) {
          const node = modal.querySelector(`[data-err="${error.field}"]`)
          if (node) node.textContent = `${error.code}：${error.message}`
        }
        const unmapped = errors.filter((error) => !modal.querySelector(`[data-err="${error.field}"]`))
        if (unmapped.length) {
          toast('bad', '入参不合法', unmapped.map((error) => `${error.field}:${error.message}`).join('；'))
        }
        return
      }
      if (!action.confirm?.required) return run(input)
      showConfirm(action, input, modal, () => run({ ...input, confirm_ack: '1' }))
    })
  }

  /** **界内确认**（不再用浏览器原生 confirm）：显示签什么、后果、以及要提交的字段值 —— 可返回修改。 */
  function showConfirm(action, input, modal, onYes) {
    const rows = (action.input?.fields || []).map((field) => {
      const value = input[field.name]
      const shown = value === undefined || value === null || value === '' ? '（空）' : String(value)
      return `<dt>${esc(field.label)}</dt><dd>${field.type === 'signature' ? `<code>${esc(shown)}</code>`
        : esc(shown)}</dd>`
    }).join('')
    // **确认页要复述"这一批几份"**（P21 / D5）：P20 实测确认页只有字段值（`ids` 是数组，渲染成 `（空）`），
    // 用户要签 88 份却看不到这个数字 —— 而它正是"一次署名"这句话里唯一需要用户确认的量。
    const ids = Array.isArray(input.ids) ? input.ids.length : 0
    const rowsCount = Array.isArray(input.rows) ? input.rows.length : 0
    const isBatch = isBatchAction(action)
    const countLine = isBatch && ids
      ? `<p class="q-consequence" data-confirm-count="1">这一批共 <b>${ids}</b> 份：`
        + `<b>一次署名</b>，服务端**逐份**各跑一次唯一写者（每份各自落账、各自可被拒）——`
        + `部分失败会逐条如实告诉你，已完成的重新提交会如实报"已经签过"（幂等，零新增）。</p>`
      : (rowsCount ? `<p class="q-consequence" data-confirm-count="1">这次提交会带上 <b>${rowsCount}</b> 行。</p>` : '')
    const card = modal.querySelector('.q-card')
    card.innerHTML = html([
      `<h2 id="q-action-title">确认：${esc(action.title)}</h2>`,
      '<div class="q-modal-body">',
      `<p class="q-degraded" data-confirm-message="1">${esc(action.confirm?.message || '确认执行这个动作？')}</p>`,
      countLine,
      `<dl class="q-kv" data-confirm-kv="1">${rows}</dl>`,
      action.permission === 'human-signature'
        ? `<p class="q-consequence">后果：产生对外义务；签名与载荷指纹会写进账本（不可撤销，只能再走一次变更）。`
          + `署名必须是你本人（<code>human:&lt;名字&gt;</code>）。</p>` : '',
      '</div>',
      `<div class="q-actions q-modal-foot"><button class="primary" data-yes="1">确认执行</button>`
      + `<button data-back="1">返回修改</button></div>`])
    card.querySelector('[data-yes]').focus()
    card.querySelector('[data-back]').addEventListener('click', () => openAction(action.id, input))
    card.querySelector('[data-yes]').addEventListener('click', () => onYes())
  }

  /**
   * **乐观并发的冲突视图**（机制）：第二条保存的人不该只看到"失败了"四个字 —— 他要看到
   * **谁在何时把哪个字段改成了什么**（服务端给的差异，界面只渲染），并能**带上最新版本重做**。
   * 三个出口：① 刷新看最新的（页面上的值换成别人改过的）② 带上最新版本重做（我填的还留着）
   * ③ 放弃这次保存（什么都不写）。
   */
  function wireConflict(modal, action, input, conflict, panel) {
    const host = modal?.querySelector('[data-result]')
    if (!host) return
    const table = (rows, head) => (rows.length
      ? `<div class="q-scroll"><table class="q-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
      : '')
    const sinceRows = (conflict.since || []).map((item) => `<tr><td><code>${esc(item.field)}</code></td>`
      + `<td>${esc(item.from)}</td><td>${esc(item.to)}</td>`
      + `<td>${esc(item.by || '（未记名）')}${item.at ? ` @ ${esc(String(item.at).slice(0, 19))}` : ''}</td>`
      + `<td>rev ${esc(String(item.rev ?? ''))}</td></tr>`).join('')
    const mineRows = (conflict.mine || []).map((item) => `<tr><td><code>${esc(item.field)}</code></td>`
      + `<td>${esc(item.from)}</td><td>${esc(item.to)}</td></tr>`).join('')
    host.innerHTML = html([
      `<div class="q-conflict" data-conflict="1">`,
      `<b>这次保存被拒：${esc(conflict.label || action.concurrency?.label || '这个对象')} 在你打开之后被别人改过</b>`,
      `<div>现在是 <code>rev ${esc(String(conflict.current?.rev ?? '?'))}</code>`
      + `${conflict.current?.by ? `，最后改动 <code>${esc(conflict.current.by)}</code>` : ''}`
      + `${conflict.current?.at ? ` @ ${esc(String(conflict.current.at).slice(0, 19))}` : ''}`
      + `${conflict.seen ? `；你手上那一版是 rev ${esc(String(conflict.seen.rev ?? '?'))}`
        + `${conflict.seen.by ? `（${esc(conflict.seen.by)}）` : ''}` : '；这一次没有带上你看到的版本'}`
      + `。<b>这一次什么都没写</b>（没有被覆盖，也没有静默吞掉）。</div>`,
      table(sinceRows, '<th>字段</th><th>改前</th><th>改后</th><th>谁改的 / 何时</th><th>版本</th>'),
      sinceRows ? '' : '<p class="q-hint">服务端没有留下"自你那一版以来的逐字段改动"'
        + '（你的那一版已经不在它保留的改动历史里了）—— 下面是"现在是什么 vs 你要写什么"。</p>',
      `<div class="q-hint">你要写进去的值 vs 现在对象里的值（${(conflict.mine || []).length} 处不同）：</div>`,
      table(mineRows, '<th>字段</th><th>现在</th><th>你要写的</th>'),
      `<div class="q-actions"><button class="primary" data-conflict-retry="1">带上最新版本重做（我填的留着）</button>`,
      `<button data-conflict-refresh="1">刷新看最新的</button>`,
      `<button data-conflict-dismiss="1">放弃这次保存</button></div>`,
      `<p class="q-hint">重做 = 界面重新读一遍这一页的最新值，把最新版本带进表单，再执行一次；`
      + '如果你想保留的是别人的那一版，就点「放弃这次保存」。</p>',
      `</div>`])
    const freshPanel = () => panel || null
    host.querySelector('[data-conflict-refresh]')?.addEventListener('click', async () => {
      await loadAll(true)
      toast('ok', '已刷新', '页面上的值已经换成最新的（别人改过的地方就在表里）；'
        + '要接着保存就点「带上最新版本重做」')
    })
    host.querySelector('[data-conflict-retry]')?.addEventListener('click', async () => {
      const vfield = versionFieldOf(action)
      const next = { ...input }
      if (vfield) delete next[vfield.name]
      delete next.confirm_ack          // 重做时再确认一次（上一次的确认对不上新版本）
      const panel = freshPanel()
      await loadAll(true)
      openAction(action.id, next, null, { fresh: true, panel })
      toast('ok', '带上最新版本重开表单', vfield
        ? `版本字段 ${vfield.name} 已换成刚读到的那一版；你填的值都还在`
        : '这一页没有版本字段：服务端会按"现在是什么 vs 你要写什么"判')
    })
    host.querySelector('[data-conflict-dismiss]')?.addEventListener('click', () => closeModal())
  }

  /** **分享弹层**（机制）：可复制的深链 + "对方需要什么身份/侧" + 可直接粘贴的邮件正文。 */
  function shareModal(share, action) {
    const abs = (path) => `${location.origin}${path}`
    const link = abs(share.path || '')
    const alt = (share.other_views || []).map((item) => `${item.title}（${item.view}）：${abs(item.path)}`).join('\n')
    const email = share.email || {}
    const body = (email.lines || []).join('\n').split(email.link_token || '{{LINK}}').join(link)
      .split(email.alt_links_token || '{{ALT_LINKS}}').join(alt || '（没有别的视角）')
    const subject = String(email.subject || '')
    const requirementRows = (share.requirements || []).map((item) => `<tr>`
      + `<td>${esc(item.key)}</td><td>${esc(item.value)}${item.ok === false ? ' ⚠' : ''}</td></tr>`).join('')
    openModal(html([
      `<h2 id="q-action-title">分享：${esc(share.title || `${share.kind} ${share.id}`)}</h2>`,
      `<p class="q-src">对象 <code>${esc(share.kind)} ${esc(share.id)}</code> · 视角 `
      + `<code>${esc(share.view)}</code>（${esc(share.view_title || share.view)}）· 由 `
      + `<code>${esc(action ? action.plugin_id : '')}</code> 的 <code>share.object</code> 拼出来的`
      + `（分享**不写账本、不落文件、不发邮件**）</p>`,
      '<div class="q-modal-body">',
      `${share.found === false ? `<p class="q-degraded">这条地址在**本视图里现在是未命中**`
        + `（${esc(share.reason || 'object-not-found')}）：分享出去对方也看不到 —— 先修这条地址。</p>` : ''}`,
      `<div class="q-field"><label>可复制的深链（贴到哪里都能打开）</label>`,
      `<input type="text" value="${attr(link)}" readonly data-share-link="1">`,
      `<span class="q-help">刷新不丢；<b>对方需要什么身份/侧才能看</b>见下表。`
      + `打开时如果不在对方那一侧的投影里，页面会**如实未命中**（不会回落成"能看"）。</span></div>`,
      `<div class="q-actions"><button class="primary" data-copy="${attr(link)}">复制深链</button>`,
      `${(share.other_views || []).length ? (share.other_views || []).map((item) => `<button data-copy="${
        attr(abs(item.path))}" title="同一个 id 在 ${attr(item.title)} 视角下的地址（对方那一侧更可能直接命中）">`
        + `复制 ${esc(item.title)} 视角的链接</button>`).join('') : ''}</div>`,
      `<dl class="q-kv">${(share.facts || []).map((fact) => `<dt>${esc(fact.key)}</dt><dd>${
        fact.code ? `<code>${esc(fact.value)}</code>` : esc(fact.value)}</dd>`).join('')}</dl>`,
      `<table class="q-table"><caption>对方需要什么才能看到（一条一条写清楚）</caption>`,
      `<thead><tr><th>这一条</th><th>答案</th></tr></thead><tbody>${requirementRows}</tbody></table>`,
      `<div class="q-field"><label>邮件主题</label>`,
      `<input type="text" value="${attr(subject)}" readonly></div>`,
      `<div class="q-field"><label>邮件正文（可直接粘贴到你的邮件客户端）</label>`,
      `<textarea rows="12" readonly data-share-body="1">${esc(body)}</textarea>`,
      `<span class="q-help">正文里已经写好：链接、对方需要的身份/侧、打开后是什么、`
      + `打不开时该怎么看 —— 对方不用先问你"我该用什么身份打开"。</span></div>`,
      `<div class="q-actions"><button class="primary" data-share-copy-email="1">复制邮件正文（含主题）</button>`,
      `<button data-close="1">关闭</button></div>`,
      `<p class="q-hint">分享不产生任何对外承诺，也不落任何记录：它只是把地址与前提整理成一段人能直接用的文字。</p>`,
      '</div>']), 'q-share')
    const modal = el('q-modal')
    if (!modal) return
    modal.querySelectorAll('[data-copy]').forEach((node) =>
      node.addEventListener('click', () => copyText(node.dataset.copy)))
    modal.querySelector('[data-close]')?.addEventListener('click', closeModal)
    modal.querySelector('[data-share-copy-email]')?.addEventListener('click', () =>
      copyText(`主题：${subject}\n\n${body}`))
  }

  function resultHtml(out, action) {
    const result = out.result && typeof out.result === 'object' ? out.result : null
    const added = ledgerAddedOf(out)
    const zero = out.ok && added === 0
    return `<div class="q-result ${out.ok ? 'ok' : 'bad'}" data-action-result="${attr(out.ok ? 'ok' : 'refused')}"`
      + ` data-ledger-added="${attr(added === null ? '' : added)}">`
      + `<b>${out.ok ? (zero ? '零新增' : '已受理') : `被拒（${esc(out.code || 'refused')}）`}</b>`
      // 回执正文也把**账本新增行数**摆在第一行（不再埋在 `<details>` 的原始回执里）
      + `${out.ok
        ? `<div data-receipt-ledger="${attr(zero ? 'zero' : 'added')}">账本新增：`
          + `${added === null ? '回执里没有这个读数（界面不替它猜）'
            : (zero ? `+0 行 —— ${esc(zeroAddedNote(out))}` : `+${added} 行`)}</div>`
        : ''}`
      + `${out.reason ? `<div>${esc(out.reason)}</div>` : ''}`
      + `${(out.errors || []).length ? `<ul>${(out.errors || []).map((error) =>
        `<li><code>${esc(error.field || '')}</code> ${esc(error.code || '')}：${esc(error.message || '')}`
        + `${error.next_action ? ` → ${esc(error.next_action)}` : ''}</li>`).join('')}</ul>` : ''}`
      + `${out.next_action ? `<div class="q-hint">下一步：<code>${esc(out.next_action)}</code></div>` : ''}`
      + `${result ? `<details class="q-mech"><summary>原始回执（${Object.keys(result).length} 个键）</summary>`
        + `<pre>${esc(JSON.stringify(result, null, 1).slice(0, 4000))}</pre></details>` : ''}</div>`
  }

  // ---------------------------------------------------------------- 自动补全（机制：建议列表来自**本服务**的只读接口）
  /**
   * 字段可以声明 `suggest_url`（这个值从一份服务端建议列表里挑）与 `mention_suggest_url`
   * （长文本里打 `@` 弹候选）。机制只做三件事：**取一次**（同一个地址一次会话内只取一次）、
   * **渲染**（`<datalist>` 原生候选 / 文本域上的 `@` 下拉）、**填进去**（候选的 `value` 就是入参值）。
   * 它不认识任何建议内容的语义：谁来提供由插件/机制自己声明（例如名册面给"本侧在册的人"）。
   */
  const suggestCache = new Map()
  async function suggestItems(url) {
    if (suggestCache.has(url)) return suggestCache.get(url)
    const promise = getJson(url).then((out) => (out && out.ok && Array.isArray(out.items) ? out.items : []))
      .catch(() => [])
    suggestCache.set(url, promise)
    return promise
  }
  /** 把建议列表灌进 `<datalist>`（原生候选：键盘上下选、可照旧手敲）。 */
  function wireSuggest(modal, fields) {
    for (const field of fields) {
      if (!field.suggest_url) continue
      const holder = modal.querySelector(`datalist[data-suggest="${field.name}"]`)
      const input = modal.querySelector(`[name="${field.name}"]`)
      if (!holder || !input) continue
      suggestItems(field.suggest_url).then((items) => {
        holder.innerHTML = items.map((item) => `<option value="${attr(item.value)}">${esc(item.label || '')}</option>`)
          .join('')
        input.setAttribute('list', holder.id)
        input.setAttribute('autocomplete', 'off')
      })
    }
  }
  /**
   * 文本域里的 `@` 候选：在光标前出现 `@<前缀>` 时弹出**名册**里的候选；点/回车/Tab 就替换掉那一段。
   * 为什么在机制层做：@ 人这件事对任何"在对象上说话"的动作都成立（协作面就是这么用它）。
   */
  function wireMention(modal, fields) {
    for (const field of fields) {
      if (!field.mention_suggest_url) continue
      const area = modal.querySelector(`textarea[name="${field.name}"]`)
      if (!area) continue
      const box = document.createElement('div')
      box.className = 'q-mention'
      box.setAttribute('role', 'listbox')
      box.style.display = 'none'
      area.parentNode.insertBefore(box, area.nextSibling)
      const tokenAt = () => {
        const upto = area.value.slice(0, area.selectionStart)
        const hit = /(^|[\s(（[【,，。;；:：])@([a-z0-9._-]*)$/.exec(upto)
        return hit ? { start: upto.length - hit[2].length - 1, prefix: hit[2] } : null
      }
      const close = () => { box.style.display = 'none'; box.innerHTML = '' }
      const insert = (value) => {
        const token = tokenAt()
        if (!token) return close()
        const before = area.value.slice(0, token.start)
        const after = area.value.slice(area.selectionStart)
        const text = `@${value} `
        area.value = `${before}${text}${after}`
        const caret = before.length + text.length
        area.setSelectionRange(caret, caret)
        area.focus()
        close()
      }
      const refresh = async () => {
        const token = tokenAt()
        if (!token) return close()
        const items = (await suggestItems(field.mention_suggest_url))
          .filter((item) => String(item.value).startsWith(token.prefix) && String(item.value) !== token.prefix)
          .slice(0, 8)
        if (!items.length) return close()
        box.innerHTML = `<span class="q-hint">名册里的候选（点一个填进去，也可以照旧手敲）：</span>`
          + items.map((item) => `<button type="button" data-mention="${attr(item.value)}">`
            + `${esc(item.label || `@${item.value}`)}</button>`).join('')
        box.style.display = 'block'
        box.querySelectorAll('[data-mention]').forEach((node) => node.addEventListener('click',
          () => insert(node.dataset.mention)))
      }
      area.addEventListener('input', refresh)
      area.addEventListener('keyup', () => { if (tokenAt()) refresh() })
      area.addEventListener('blur', () => setTimeout(close, 150))
      area.addEventListener('keydown', (ev) => {
        if (box.style.display === 'none') return
        const first = box.querySelector('[data-mention]')
        if (!first) return
        if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); insert(first.dataset.mention) }
        if (ev.key === 'Escape') { ev.preventDefault(); close() }
      })
      refresh()
    }
  }

  /**
   * 弹层（**机制**）：所有对话框/命令面板/导出预览都走这里。本批把「键盘与屏幕阅读器」这一层补齐 ——
   *   · 打开时：记住焦点 → 把**背景**设为 `inert`（Tab 出不去、屏幕阅读器也读不到背景）→ 焦点落到
   *     第一个可聚焦元素（表单字段优先，否则标题/关闭按钮）；`aria-labelledby` 指向弹层标题；
   *   · 关闭时：恢复 `inert`、把焦点还给**打开它的那个元素**（键盘用户不会掉到页面顶端）；
   *   · Tab/Shift+Tab 在弹层内**循环**（焦点陷阱），Esc 由全局键盘处理（已有：先「返回修改」再关）；
   *   · 手机上（≤560px）弹层是**全屏单页**（CSS），底部按钮吸底 —— 不用去够屏幕中间的按钮。
   */
  let modalOpener = null
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]),'
    + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  function openModal(bodyHtml, id) {
    let modal = el('q-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'q-modal'
      document.body.appendChild(modal)
    }
    modal.className = ''
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    if (!modalOpener) modalOpener = document.activeElement
    // 标题给个 id 并让弹层引用它：屏幕阅读器打开时会念「对话框：<标题>」而不是「空对话框」。
    const titled = /<h2[^>]*>/.test(bodyHtml)
    const withId = titled ? bodyHtml.replace('<h2', '<h2 id="q-modal-title"') : bodyHtml
    modal.setAttribute('aria-labelledby', titled ? 'q-modal-title' : '')
    if (id) modal.dataset.kind = id
    modal.innerHTML = `<div class="q-card" role="document">${withId}</div>`
    // **D7：弹层打开时，已经在屏幕上的提示条**也搬进弹层正文（不是让它们消失）—— 固定浮层会压住
    // 全屏弹层的标题；搬进去之后提示仍然看得见（跟着正文滚），标题与吸底按钮都不被盖。
    const floatBox = el('q-toasts')
    const inlineBox = modal.querySelector('.q-modal-body')
    if (floatBox && inlineBox && floatBox.children.length) {
      const host = document.createElement('div')
      host.className = 'q-toasts-inline'
      host.setAttribute('data-toast-host', '1')
      inlineBox.prepend(host)
      while (floatBox.firstChild) host.appendChild(floatBox.firstChild)
    }
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal() })
    modal.addEventListener('keydown', (ev) => { if (ev.key === 'Tab') trapTab(ev, modal) })
    // 背景 inert：Tab 与辅助技术都停在弹层里（浏览器原生 inert，不需要自己数元素）
    const app = el('q-app')
    if (app) app.setAttribute('inert', '')
    document.body.classList.add('q-modal-open')
    // 初始焦点：第一个可聚焦元素（表单字段天然排在标题后面）；一个都没有时把焦点给卡片本身
    const first = modal.querySelector(FOCUSABLE)
    const card = modal.querySelector('.q-card')
    if (first) {
      first.focus()
      if (first.tagName === 'INPUT' && first.type !== 'checkbox') first.select?.()
    } else if (card) { card.tabIndex = -1; card.focus() }
  }
  /** Tab 在弹层内循环（焦点陷阱）：到最后一个再按 Tab 回第一个，反之亦然。 */
  function trapTab(ev, modal) {
    const nodes = [...modal.querySelectorAll(FOCUSABLE)]
      .filter((node) => node.offsetWidth || node.offsetHeight || node === document.activeElement)
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus() }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus() }
  }
  function closeModal() {
    const modal = el('q-modal')
    // **弹层里那份提示条搬回浮层**（P21 / D7）：不然"发出去的提示"会跟着弹层一起被丢掉
    // （弹层里那份是 Node 的 DOM 子树，remove() 一并带走）—— 关门不等于把话咽回去。
    const floatBox = el('q-toasts')
    const inlineToasts = modal ? [...modal.querySelectorAll('.q-toasts-inline .q-toast')] : []
    if (floatBox && inlineToasts.length) for (const node of inlineToasts) floatBox.appendChild(node)
    const restore = modalOpener
    modalOpener = null
    // 通知中心的异步取数在弹层关掉之后可能才回来 ⇒ 记下"已关"，回来时不再往空气里画
    state.notifyOpen = false
    if (modal) modal.remove()
    const app = el('q-app')
    if (app) app.removeAttribute('inert')
    document.body.classList.remove('q-modal-open')
    if (restore && typeof restore.focus === 'function' && document.contains(restore)) restore.focus()
  }

  // ---------------------------------------------------------------- 命令面板 / 通知 / 插件 / 帮助
  function paletteItems() {
    const views = viewsOf()
    const actions = state.surface.actions || []
    const kinds = (state.surface.views || []).flatMap((view) => (view.object_kinds || [])
      .map((kind) => ({ kind, view: view.id })))
    return [...views.map((view) => ({ kind: 'view', id: `view.${view.id}`, title: `转到 ${view.title}`,
      hint: `/${'app'}/${view.id}/`, run: () => navigate(view.id, '', '') })),
    ...kinds.map((item) => ({ kind: 'object-kind', id: `kind.${item.view}.${item.kind}`,
      title: `打开对象类：${item.kind}`, hint: `${item.view} 视角 · /app/${item.view}/${item.kind}/<id>/`,
      run: () => {
        const found = state.panels.map((panel) => (panel.data?.rows || []).find((row) => row.ref
          && row.ref.kind === item.kind)).find(Boolean)
        if (found) navigate(item.view, item.kind, found.ref.id)
        else navigate(item.view, '', '')
      } })),
    // **动作**：命令面板里**永远能找到全部动作**（一个不少）。但缺上下文的那些**进去不是空表单** ——
    // 先让你挑一条（候选行 / 那条对象的页面），口径见本文件「入口策略」段的第 ③ 条。
    ...actions.map((action) => {
      const missing = contextMissing(action, { route: onObjectPage() })
      const verdict = missing.length
        ? `要先挑一条（${missing.flatMap((one) => one.fields).join('、') || '已选集合'}）` : '就绪：点了就开表单'
      return { kind: 'action', id: action.id,
        title: `${action.title}${action.permission === 'human-signature' ? ' ✍' : ''}`,
        hint: `${action.id} · ${(action.views || []).join('/')}${action.object_kind ? ` · ${action.object_kind}` : ''}`
          + ` · ${verdict}`,
        run: () => openActionEntry(action.id) }
    })]
  }

  function openPalette() {
    const items = paletteItems()
    openModal(`<h2 id="q-action-title">命令面板</h2><p class="q-src">视图 / 对象类 / 动作都来自注册面（插件注册什么，`
      + `这里就有什么）· <kbd>↑</kbd><kbd>↓</kbd> 选 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭</p>`
      + `<input id="q-palette-input" placeholder="输入动作名 / 视图名 / 对象类…" autocomplete="off"`
      + ` aria-label="搜索动作与视图" role="combobox" aria-expanded="true">`
      + `<ul id="q-palette-list" role="listbox"></ul>`, 'q-palette')
    const modal = el('q-modal')
    const input = modal.querySelector('#q-palette-input')
    const list = modal.querySelector('#q-palette-list')
    let filtered = items
    let cursor = 0
    // 先关面板再执行（动作的执行会**自己开一个弹层**；先 run 再 close 会把刚开的表单立刻关掉 ——
    // P3 走查实测：命令面板里选动作 = 表单一闪即关，等于从命令面板打不开任何动作）
    const invoke = (item) => { if (!item) return; closeModal(); item.run() }
    const draw = () => {
      list.innerHTML = filtered.map((item, index) =>
        `<li data-index="${index}" role="option" aria-selected="${index === cursor ? 'true' : 'false'}"`
        + ` class="${index === cursor ? 'active' : ''}"><b>${esc(item.title)}</b>`
        + `${item.hint ? ` <span class="q-tag">${esc(item.hint)}</span>` : ''}</li>`).join('')
        || '<li class="q-empty">没有匹配的条目 —— 换个词，或清空输入看全部</li>'
      list.querySelectorAll('li[data-index]').forEach((node) => node.addEventListener('click', () =>
        invoke(filtered[Number(node.dataset.index)])))
    }
    const filter = () => {
      const needle = input.value.trim().toLowerCase()
      filtered = items.filter((item) => item.title.toLowerCase().includes(needle)
        || item.id.toLowerCase().includes(needle) || String(item.hint || '').toLowerCase().includes(needle))
      cursor = 0; draw()
    }
    input.addEventListener('input', filter)
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { cursor = Math.min(cursor + 1, filtered.length - 1); draw(); ev.preventDefault() }
      if (ev.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); ev.preventDefault() }
      if (ev.key === 'Enter') { ev.preventDefault(); invoke(filtered[cursor]) }
    })
    input.focus(); draw()
  }

  // ---------------------------------------------------------------- ① 通知中心（**服务端窗口**：数字如实 + 真能翻到底）
  const LEVEL_RANK = { bad: 3, warn: 2, info: 1, ok: 1 }
  const LEVEL_TEXT = { bad: '失败/被拒', warn: '待办', info: '进展', ok: '进展' }
  /**
   * 通知中心的**查询状态**（会话内）：关键字 / 每页条数 / 页码 / 级别 / 筛选片 / 协作标签。
   * 为什么不再在本地筛选分页：通知的**全量产出**可以有好几千条（规模数据下 6324 条），界面不可能把它整个
   * 拉下来再自己截断 —— 那正是「共 600 条」说谎的根源（界面上写着 600，后台产出 6324，剩下的 5724 条
   * 哪儿都点不到）。现在与各面板**同一套**：请求带上 `w=1` + `pq.notify` → 服务端在**全量条目**上
   * 筛选 → 排序 → 分页 → 只回这一页，并把在全集上算出来的数字一并给出（共 / 命中 / 第 P/PP 页 / 未读 /
   * 还剩多少条没翻到）→ 界面**照抄**（`data-notify-*` 就是可对账的读数）。
   */
  const NOTIF_SIZES = [10, 25, 50, 100, 250]
  state.notifKw = String(state.notifKw || '')
  state.notifSize = NOTIF_SIZES.includes(Number(state.notifSize)) ? Number(state.notifSize) : 25
  state.notifPage = Math.max(0, Number(state.notifPage) || 0)
  state.notifFilter = state.notifFilter || 'all'
  /** 通知窗口的这一页要什么（形状与面板的 `pq` 同一套；级别/静音/筛选片都由客户端显式给）。 */
  const notifSpecOf = (page, extra = null) => ({ size: state.notifSize,
    page: Math.max(0, Number(page ?? state.notifPage) || 0),
    kw: String(state.notifKw || ''), chip: state.notifFilter || 'all', tag: String(filterOf('notifTag') || ''),
    level: state.notif.minLevel, muted: state.notif.muted, ...(extra || {}) })
  const notifUrl = (page, extra) => `/api/ui/notifications?w=1&pq=${
    encodeURIComponent(JSON.stringify({ notify: notifSpecOf(page, extra) }))}`
  /** 上一次**成功取到**的那一页（服务端给的数字与行；读不到时保留并标陈旧，不冒充空）。 */
  const notifQuery = () => ((state.notify && state.notify.query) || null)
  const notifPageItems = () => ((state.notify && state.notify.items) || [])
    .map((item) => { const id = String(item.id || ''); return { ...item, id,
      count: Number(item.count) || 1, unread: !state.notif.read.has(id) } })
  const notifUnreadKnown = () => notifQuery()?.unread?.known === true
  /** 未读：服务端按**会话身份的已读记录**算（`unread.known`）；未登录 ⇒ 只按本页算（界面如实说）。 */
  function unreadCount() {
    const q = notifQuery()
    if (!q) return 0
    if (q.unread?.known === true) return Number(q.unread.total) || 0
    return notifPageItems().filter((item) => item.unread).length
  }
  function paintBadge() {
    const node = el('q-notify-count')
    if (!node) return
    const q = notifQuery()
    const known = notifUnreadKnown()
    const unread = unreadCount()
    const total = q ? Number(q.produced) || 0 : 0
    node.textContent = String(unread)
    node.className = `q-badge ${unread || state.notifError ? 'warn' : ''}`
    const stale = state.notifError
      ? `**这一行是上一次成功读到的**：现在读不到通知源 —— ${state.notifError.code}（点开看原因与下一步）`
      : '点开是通知中心'
    node.title = !q
      ? '通知还没读到（点开通知中心看原因）'
      : (known ? `未读 ${unread} / 共 ${total} 条 · ${stale}`
        : `未读 ${unread}（**未登录**：服务端不知道谁读过什么，这个数只按本页算）/ 共 ${total} 条 · ${stale}`)
  }
  function markRead(ids, value = true) {
    for (const id of ids) { if (value) state.notif.read.add(String(id)); else state.notif.read.delete(String(id)) }
    saveNotif()
    pushNotifState()          // 已读/未读一并落服务端（跨浏览器/跨设备仍在）—— 未读数由服务端据此算
    paintBadge()
  }
  /**
   * 取通知窗口的**这一页**（只回这一页；页号越界由服务端夹回合法页 ⇒ 取回后跟着服务端的页号走，
   * 否则界面上的页号与这一页的内容会对不上）。
   */
  async function fetchNotify(page) {
    state.notifyBusy = true
    const out = await getJson(notifUrl(page))
    state.notifyBusy = false
    if (!out.ok) {
      state.notifyError = { code: out.code || 'notifications-read-failed', reason: out.reason || '',
        next_action: out.next_action || '点顶部「重载」重试' }
      paintBadge()
      return false
    }
    state.notifyError = null
    state.notify = { at: new Date().toISOString(), query: out.query || null, items: out.items || [],
      stats: out.stats || null }
    // 徽标与通知中心**共用同一份读数**（`chip_counts`/`unread` 都是在全集上算的，与筛选/关键字无关）
    state.notifPoll = { at: state.notify.at, query: state.notify.query, items: state.notify.items }
    if (out.query) {
      state.notifPage = Math.max(0, Number(out.query.page) || 0)
      state.notifSize = Number(out.query.size) || state.notifSize
    }
    paintBadge()
    return true
  }

  /**
   * 通知中心（弹层）：**服务端窗口**的一页 + 在**全量产出**上算出来的计数。
   *
   * 打开 / 翻页 / 搜索 / 换筛选片都走同一个入口：先画上一次取到的那一页（或"正在取这一页…"），
   * 再取这一次的窗口 —— **只回这一页**（不是把全量拉下来自己截），数字全部来自服务端。
   * 顶栏那句是**如实**的：`共 N 条（后台产出）· 已显示 N 条 · 剩余 M 条`，与 `/api/ui/status` 的
   * 「通知」那一行同源（`data-notify-head` 上的属性就是可对账的读数）。
   */
  async function openNotify() {
    state.notifyOpen = true
    renderNotify()
    await fetchNotify(state.notifPage)
    if (!state.notifyOpen) return
    // 打开即把**本页**标为已读（与邮件客户端一致；想看未读的用「未读」筛选片）。
    // 登录时先把已读**立即**写到服务端、再取一次这一页 ⇒ 界面上的"未读"与每条的小圆点同一时刻，不自相矛盾。
    const fresh = notifPageItems().filter((item) => item.unread)
    if (fresh.length) {
      markRead(fresh.map((item) => item.id), true)
      if (notifUnreadKnown()) {
        await pushNotifState(true)
        if (!state.notifyOpen) return
        await fetchNotify(state.notifPage)
      }
    }
    if (state.notifyOpen) renderNotify()
  }

  /** 画通知中心（用**上一次成功取到**的那一页 + 服务端给的计数；取数中则如实标"正在取这一页…"）。 */
  function renderNotify() {
    const q = notifQuery()
    const page = notifPageItems()
    const busy = state.notifyBusy === true
    const filter = String((q && q.chip) || state.notifFilter || 'all')
    const counts = (q && q.chip_counts) || { all: null, unread: null, todo: null, bad: null }
    const unreadKnown = notifUnreadKnown()
    const produced = q ? Number(q.produced) || 0 : 0     // 后台产出（全部，可一页页翻到）
    const shown = q ? Number(q.end) || 0 : 0             // 已显示 = 按页推进已经到过的条数
    const rest = q ? Number(q.rest) || 0 : 0             // 剩余 = 还没翻到的条数
    const matched = q ? Number(q.matched) || 0 : 0       // 当前筛选/关键字命中的条数
    const pageAt = q ? (Number(q.page) || 0) + 1 : 1
    const pages = q ? Math.max(1, Number(q.pages) || 1) : 1
    const size = q ? Number(q.size) || state.notifSize : state.notifSize
    const kw = String(state.notifKw || '')
    const tag = String(filterOf('notifTag') || '')
    const tags = (q && q.tags) || []
    const tagCounts = (q && q.tag_counts) || {}
    const pageUnread = page.filter((item) => item.unread).length
    const readCap = 500        // 已读记录的容量（本浏览器 500 条；服务端 1000 条，见 notif-state 的 bounds）
    // 静音下拉的候选：**通知源清单**（`/api/ui/surface` 的 `notification_sources` 元数据）——
    // 不必把全量通知拉下来才知道"有哪些插件在发通知"。
    const plugins = [...new Set([...(state.surface.notification_sources || []).map((item) => item.plugin_id),
      ...state.notif.muted, ...page.map((item) => item.plugin_id).filter(Boolean)])].sort()
    const groups = [['bad', '失败 / 被拒'], ['warn', '要你处理'], ['info', '进展与信息']]
    const rows = []
    for (const [level, title] of groups) {
      const items = page.filter((item) => (LEVEL_RANK[item.level] ?? 1) === LEVEL_RANK[level])
      if (!items.length) continue
      rows.push(`<li class="q-notify-group">${esc(title)}（${items.length}）</li>`)
      for (const item of items) {
        const href = refLink(item.ref)
        const act = item.action ? actionOf(item.action) : null
        rows.push(`<li class="${item.unread ? 'unread' : 'wasread'}" data-notify="${attr(item.id)}">`
          + `<span class="q-notify-level">${badge(item.level || 'info', item.level === 'bad' ? 'bad'
            : (item.level === 'warn' ? 'warn' : ''))}</span>`
          + `${item.unread ? '<span class="q-unread-dot" aria-label="未读">●</span> ' : ''}`
          + `<b>${esc(item.title)}</b>${item.count > 1 ? ` <span class="q-tag">×${item.count}</span>` : ''}`
          + `${(item.tags || []).map((label) => ` <span class="q-tag q-notify-tag" data-tag="${attr(label)}">`
            + `${esc(label)}</span>`).join('')}`
          + `${item.body ? ` — ${esc(item.body)}` : ''}`
          + `${item.next_action ? `<div class="q-hint">下一步：${esc(item.next_action)}</div>` : ''}`
          + `<div class="q-actions">`
          + `${act ? `<button class="primary" data-notify-action="${attr(item.action)}">`
            + `${esc(act.title)}${act.permission === 'human-signature' ? ' ✍' : ''}</button>` : ''}`
          + `${href ? `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(item.ref.kind)}"`
            + ` data-v="${attr(item.ref.view || '')}" data-id="${attr(item.ref.id)}">`
            + `打开 ${esc(refLabel(item.ref) || `${item.ref.kind} ${item.ref.id}`)} →</a>` : ''}`
          + `<button data-notify-read="${attr(item.id)}" data-notify-value="${item.unread ? '1' : '0'}">`
            + `${item.unread ? '标为已读' : '标为未读'}</button>`
          + `<span class="q-hint">${item.actor ? `${esc(item.actor)} · ` : ''}${esc(item.plugin_id || '')}`
            + ` · ${esc(String(item.at || '').slice(0, 19))}</span>`
          + `</div></li>`)
      }
    }
    const body = `<h2 id="q-action-title">通知中心</h2>`
      + `<p class="q-src">同一件事只出一条（重复的合成 <code>×N</code>，跨插件的重复在服务端就合并了）。`
      + `**这一页由服务端按窗口给**（与各面板里的表同一套机制）：「共 / 已显示 / 剩余」都是在**全量产出**上`
      + `算出来的（与 <code>/api/ui/status</code> 的「通知」那一行同源）——「已显示」= 按页推进已到过的条数、`
      + `「剩余」= 还没翻到的条数，点「末页 ⏭」能一直翻到底，不存在"只给你前 600 条"。</p>`
      + `${state.notifyError ? `<div class="q-state warn" data-state="degraded" data-state-reason="${attr(state.notifyError.code)}">`
        + `<b>通知没读到最新的一版（不是"没有通知"）</b> <code>${esc(state.notifyError.code)}</code>`
        + `<div>下面这份是**上一次成功读到**的（${esc(String((state.notify && state.notify.at) || '').slice(0, 19))}）：`
        + `${esc(state.notifyError.reason || '')}</div>`
        + `<div class="q-hint">下一步：${esc(state.notifyError.next_action || '点顶部「重载」重试')}</div></div>` : ''}`
      // **正文**（`.q-modal-body`：卡片是 flex 列、max-height 88vh —— 正文滚、底部计数/翻页条吸底）。
      // 这既是外壳既有的弹层口径（`app.css` 的 `#q-modal .q-modal-body`），也让通知列表拿到剩下的全部高度。
      + `<div class="q-modal-body">`
      + `<div class="q-notify-tools">`
      + `<label class="q-qkw">搜通知：<input type="search" data-notify-kw="1" value="${attr(state.notifKw || '')}"`
      + ` placeholder="标题 / 正文 / 插件 / 对象 id…" autocomplete="off" aria-label="在通知里搜关键字"></label>`
      + `<button data-notify-clear="1"${(kw || filter !== 'all' || tag) ? '' : ' disabled'}>清空筛选</button>`
      + `<span class="q-qcount" data-q-count="notify" data-notify-head="1"`
      + ` data-count-produced="${attr(produced)}" data-count-total="${attr(produced)}"`
      + ` data-count-shown="${attr(shown)}" data-count-rest="${attr(rest)}"`
      + ` data-count-matched="${attr(matched)}" data-count-window="${attr(page.length)}"`
      + ` data-count-full="${attr(produced)}" data-page="${attr(pageAt)}" data-pages="${attr(pages)}"`
      + ` data-page-size="${attr(size)}" data-unread-known="${unreadKnown ? 1 : 0}"`
      + ` data-unread="${attr(unreadKnown ? (Number(counts.unread) || 0) : '')}" data-q-server="1"`
      + `${busy ? ' data-q-fetching="1"' : ''}>`
      + `<span>共 <b data-notify-produced="1">${produced}</b> 条（后台产出）</span>`
      + `<span>已显示 <b data-notify-shown="1">${shown}</b> 条</span>`
      + `<span>剩余 <b data-notify-rest="1">${rest}</b> 条</span>`
      + `<span>命中 <b>${matched}</b></span>`
      + (unreadKnown ? `<span>未读 <b data-notify-unread="1">${Number(counts.unread) || 0}</b></span>`
        : `<span>未读 <b data-notify-unread="1">${pageUnread}</b>（**未登录 ⇒ 只按本页算**）</span>`)
      + `<span>第 <b data-notify-page-num="1">${pageAt}</b>/<b>${pages}</b> 页（本页 <b>${page.length}</b> 条`
      + ` · 每页 ${size}）</span>`
      + (q ? `<span class="q-qhint" data-q-server="1" title="这一页由服务端在**全量产出**上筛选/排序/分页后下发；`
        + `计数、未读与'还剩多少没翻到'都是服务端算的 —— 客户端手里只有这一页">服务端窗口</span>` : '')
      + (busy ? `<span class="q-qhint" data-q-fetching="1">正在取这一页…（数字还是上一次的）</span>` : '')
      // 收口：计数块是 `<span class="q-qcount">`（不是 div）⇒ 必须用 `</span>` 结束，否则浏览器会把
      // 下面整段内容挤出 `.q-card`（P14 走查实测：老代码写成 `</div></div>`，弹层因此被压成一条窄栏、
      // 计数与列表浮在卡片外面）。
      + `</span></div>`
      + `<div class="q-notify-tools">`
      + `<span class="q-chip${filter === 'all' ? ' on' : ''}" data-notify-filter="all">全部 ${counts.all === null ? '—' : counts.all}</span>`
      + `<span class="q-chip${filter === 'unread' ? ' on' : ''}" data-notify-filter="unread">未读 ${unreadKnown
        ? (counts.unread === null ? '—' : counts.unread) : `（本页 ${pageUnread}）`}</span>`
      + `<span class="q-chip${filter === 'todo' ? ' on' : ''}" data-notify-filter="todo">待我处理 ${counts.todo === null ? '—' : counts.todo}</span>`
      + `<span class="q-chip${filter === 'bad' ? ' on' : ''}" data-notify-filter="bad">失败 ${counts.bad === null ? '—' : counts.bad}</span>`
      + `<button data-notify-read-all="1"${matched > readCap ? ' disabled' : ''} title="${
        matched > readCap ? `命中 ${matched} 条超过已读记录的容量（本浏览器 ${readCap} / 服务端 1000），`
          + `这一颗会丢记录 ⇒ 用「标记本页 N 条」或先缩小筛选` : '把当前筛选命中的这些条全部标为已读（不是全部通知）'
      }">全部标已读（${matched}）</button>`
      + `<label>只看 <select data-notify-level="1">${['info', 'warn', 'bad'].map((level) =>
        `<option value="${level}"${level === state.notif.minLevel ? ' selected' : ''}>`
        + `${esc(LEVEL_TEXT[level])}以上</option>`).join('')}</select></label>`
      + `<label>静音 <select data-notify-mute="1"><option value="">（不静音）</option>`
      + `${plugins.map((plugin) => `<option value="${attr(plugin)}"${state.notif.muted.includes(plugin)
        ? ' selected' : ''}>${esc(plugin)}</option>`).join('')}</select></label>`
      + `<label>每页 <select data-notify-size="1" aria-label="通知每页多少条">`
      + NOTIF_SIZES.map((n) => `<option value="${n}"${n === size ? ' selected' : ''}>${n}</option>`).join('')
      + `</select></label>`
      + `<button data-notify-page="prev"${pageAt <= 1 ? ' disabled' : ''}>上一页</button>`
      + `<button data-notify-page="next"${pageAt >= pages ? ' disabled' : ''}>下一页</button>`
      + `<span class="q-hint" data-notify-state-note="1">${esc(notifStateNote)}</span></div>`
      + (tags.length ? `<div class="q-notify-tools q-notify-tags" data-notify-tag-bar="1">`
        + `<span class="q-bucketbar-label">按协作筛选</span>`
        + `<span class="q-chip${tag === '' ? ' on' : ''}" data-notify-tag="">全部 ${counts.all === null ? '—' : counts.all}</span>`
        + tags.map((label) => `<span class="q-chip${tag === label ? ' on' : ''}"`
          + ` data-notify-tag="${attr(label)}">${esc(label)} ${tagCounts[label]}</span>`).join('')
        + `<span class="q-hint">「我的」= 指派给我 / @我 / 我关注的；「我指派的」= 我交出去的活的进展</span></div>`
        : '')
      + `<ul>${rows.length ? rows.join('') : `<li class="q-empty">${q
        ? '这一类里没有通知（不是坏了）'
        : '通知还没读到 —— 看上面那条原因与下一步'}</li>`}</ul>`
      + `<div class="q-qbar-row q-qpages q-notify-pages">`
      + `<span class="q-hint" data-notify-counts="1">共 ${produced} 条（后台产出）· 已显示 ${shown} 条 · `
      + `剩余 ${rest} 条 · 当前筛选命中 ${matched} 条 · 第 ${pageAt}/${pages} 页（本页 ${page.length} 条）`
      + `${kw ? ` · 关键字「${esc(state.notifKw)}」` : ''}${tag ? ` · 协作标签「${esc(tag)}」` : ''}`
      + ` · 本页仍未读 ${pageUnread} 条${unreadKnown ? '' : '（未登录：未读只按本页算）'}</span>`
      + `<button data-notify-page="first"${pageAt <= 1 ? ' disabled' : ''}>⏮ 首页</button>`
      + `<button data-notify-page="prev"${pageAt <= 1 ? ' disabled' : ''}>上一页</button>`
      + `<button data-notify-page="next"${pageAt >= pages ? ' disabled' : ''}>下一页</button>`
      + `<button data-notify-page="last"${pageAt >= pages ? ' disabled' : ''}>末页 ⏭</button>`
      + `<button data-notify-read-picked="1" title="把**这一页**的这些条全部标为已读（不是全部通知）">`
      + `标记本页 ${page.length} 条为已读</button></div>`
      + `</div>`                     // 收口 `.q-modal-body`
    openModal(body, 'q-notify')
    const modal = el('q-modal')
    modal.querySelectorAll('[data-notify-action]').forEach((node) => node.addEventListener('click', () => {
      const item = notifPageItems().find((row) => row.id === node.closest('[data-notify]')?.dataset?.notify)
      openAction(node.dataset.notifyAction, item?.preset || null)
    }))
    modal.querySelectorAll('[data-open-object]').forEach((node) => node.addEventListener('click', (ev) => {
      if (ev.metaKey || ev.ctrlKey) return
      ev.preventDefault()
      navigate(node.dataset.v || state.route.view, node.dataset.k, node.dataset.id)
      closeModal()
    }))
    modal.querySelectorAll('[data-notify-read]').forEach((node) => node.addEventListener('click', () => {
      markRead([node.dataset.notifyRead], node.dataset.notifyValue !== '1')
      openNotify()
    }))
    modal.querySelector('[data-notify-read-all]')?.addEventListener('click', async () => {
      // 「全部标已读」= 当前**筛选命中的全部**（不只本页）：按需向服务端要一次命中行 id 清单
      // （与面板的「选中全部命中行」同一套 `keys=true`；命中超过上限时服务端**如实说**、不静默给一半）。
      const out = await getJson(notifUrl(state.notifPage, { keys: true }))
      const keys = Array.isArray(out.query?.matched_keys) ? out.query.matched_keys : []
      if (!out.ok || !keys.length) {
        toast('warn', '没拿到「命中全部」的 id 清单', out.next_action || out.reason
          || `命中 ${out.query?.matched_keys_available ?? '—'} 条`)
        return
      }
      const capped = out.query.matched_keys_capped === true
      markRead(keys, true)
      toast(capped ? 'warn' : 'ok', `已把命中的 ${keys.length} 条标为已读`,
        capped ? '命中超过服务端一次给的行数上限 ⇒ 这份清单不是全部，先用关键字缩小范围再标'
          : '已读记录保存在服务端（按会话身份）；界面上的未读数会跟着更新')
      openNotify()
    })
    // ---- 通知中心的查询交互（关键字 / 页码 / 每页条数 / 清空筛选）----
    const notifKwInput = modal.querySelector('[data-notify-kw]')
    if (notifKwInput) {
      let timer = null
      notifKwInput.addEventListener('input', () => {
        clearTimeout(timer)
        const value = notifKwInput.value
        timer = setTimeout(() => {
          state.notifKw = value
          state.notifPage = 0
          openNotify()
          const node = el('q-modal')?.querySelector('[data-notify-kw]')
          if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length) }
        }, 180)
      })
    }
    modal.querySelector('[data-notify-clear]')?.addEventListener('click', () => {
      state.notifKw = ''
      state.notifPage = 0
      state.notifFilter = 'all'
      setFilter('notifTag', '')
      openNotify()
    })
    modal.querySelector('[data-notify-size]')?.addEventListener('change', (ev) => {
      state.notifSize = NOTIF_SIZES.includes(Number(ev.target.value)) ? Number(ev.target.value) : 25
      state.notifPage = 0
      openNotify()
    })
    modal.querySelectorAll('[data-notify-page]').forEach((node) => node.addEventListener('click', () => {
      const where = node.dataset.notifyPage
      // 页号是**0 基**（与面板同一套）；越界由服务端夹回合法页，取回后界面跟着服务端的页号走
      state.notifPage = where === 'first' ? 0 : (where === 'last' ? pages - 1
        : (where === 'next' ? (pageAt - 1) + 1 : (pageAt - 1) - 1))
      openNotify()
    }))
    modal.querySelector('[data-notify-read-picked]')?.addEventListener('click', () => {
      markRead(page.map((item) => item.id), true)
      openNotify()
    })
    // 协作标签筛选片（「我的 / 我指派的 / @我 / 我关注的」）：选择存本浏览器，不改任何事实
    modal.querySelectorAll('[data-notify-tag]').forEach((node) => node.addEventListener('click', () => {
      setFilter('notifTag', node.dataset.notifyTag || '')
      openNotify()
    }))
    modal.querySelectorAll('[data-notify-filter]').forEach((node) => node.addEventListener('click', () => {
      state.notifFilter = node.dataset.notifyFilter
      openNotify()
    }))
    modal.querySelector('[data-notify-level]')?.addEventListener('change', (ev) => {
      state.notif.minLevel = ev.target.value
      saveNotif(); paintBadge(); openNotify()
    })
    modal.querySelector('[data-notify-mute]')?.addEventListener('change', (ev) => {
      const plugin = ev.target.value
      if (plugin === '') return
      state.notif.muted = state.notif.muted.includes(plugin) ? state.notif.muted : [...state.notif.muted, plugin]
      saveNotif(); paintBadge(); openNotify()
      toast('ok', `已静音 ${plugin}`, '再选「（不静音）」就恢复：静音只影响提醒与徽标，该做的事还是照做')
    })
  }

  // ---------------------------------------------------------------- ⑤ 最近访问 / 继续上次
  function openRecent() {
    const last = lastRoute()
    const rows = state.recentRoutes.map((item) => `<li><a href="${attr(item.url)}" data-open-object="1"`
      + ` data-k="${attr(item.kind)}" data-v="${attr(item.view)}" data-id="${attr(item.id)}">`
      + `${esc(item.label)}</a> <code>${esc(item.url)}</code>`
      + `<span class="q-at">${esc(String(item.at || '').slice(0, 19))}</span>`
      + `<button data-copy="${attr(item.url)}">复制链接</button></li>`).join('')
    openModal(`<h2 id="q-action-title">最近访问 / 继续上次</h2>`
      + `<p class="q-src">存在的每一条都是可分享的对象深链：刷新不丢、换标签页也不丢。`
      + `顺序按你最近打开的时间（同一地址只留最近一次）。</p>`
      + `${last ? `<p data-last-route="1">上次你在 <b>${esc(last.label)}</b>`
        + ` <button class="q-link" data-resume="1">继续 →</button></p>` : '<p>还没有"上次"（本浏览器第一次用）。</p>'}`
      + `${rows ? `<ul class="q-recent-list">${rows}</ul>`
        : '<p class="q-empty">还没访问过带对象的页面：从列表行点「打开 →」或直接点一条通知的「打开 … →」</p>'}`
      + `${state.tabs.length ? `<p class="q-hint">现在开着 ${state.tabs.length} 个标签页：`
        + `${state.tabs.map((tab) => `<code>${esc(tab.label)}</code>`).join(' · ')}</p>` : ''}`
      + '<p class="q-hint">快捷键 <kbd>Ctrl/⌘+E</kbd> 开这一页；标签页用 <kbd>Alt+1..9</kbd> 切、<kbd>Alt+W</kbd> 关'
      + '（<kbd>Ctrl+W</kbd>/<kbd>Ctrl+1..9</kbd> 被浏览器自己占用，网页拦不到）。</p>', 'q-recent')
    const modal = el('q-modal')
    modal.querySelectorAll('[data-copy]').forEach((node) =>
      node.addEventListener('click', () => copyText(node.dataset.copy)))
    modal.querySelectorAll('[data-resume], [data-open-object]').forEach((node) => {
      if (node.dataset.openObject) node.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey) return
        ev.preventDefault()
        navigate(node.dataset.v || state.route.view, node.dataset.k, node.dataset.id)
        closeModal()
      })
    })
    modal.querySelector('[data-resume]')?.addEventListener('click', () => {
      if (last) { navigate(last.view, last.kind, last.id); closeModal() }
    })
  }

  // ---------------------------------------------------------------- 身份（会话）：谁在点这些按钮
  async function loadIdentity() {
    const out = await getJson('/identity/me')
    state.identity = out.ok ? { human: out.human, name: out.name, side: out.side } : null
    renderChrome()                       // 顶栏的「身份」徽标要跟着变
    return state.identity
  }
  async function openIdentity() {
    if (state.identity === undefined) await loadIdentity()
    const me = state.identity
    openModal(`<h2 id="q-action-title">身份与会话</h2>`
      + `<p class="q-src">人签只能本人签：署名由<strong>会话</strong>决定，动作表单里带「署名」的字段会自动填成`
      + `当前身份（改不认身份就会被服务端拒，账本零新增）。</p>`
      + `${me ? `<dl class="q-kv"><dt>我是谁</dt><dd><code>${esc(me.human)}</code></dd>`
        + `<dt>属于哪一侧</dt><dd><code>${esc(me.side || '—')}</code></dd></dl>`
        + `<p>这一侧的视角与待办按身份过滤；对方的深链打开会如实"找不到"，不会回落成"能看"。</p>`
        : `<p data-identity-current="0">当前<strong>未登录</strong>：人签类动作会被服务端拒（账本零新增）。</p>`}`
      + `<div class="q-actions"><a href="${attr(`${API('/identity/')}?next=${encodeURIComponent(location.pathname)}`)}">`
      + `${me ? '切换身份 / 登出' : '去登录（human:<名字> + 属于哪一侧）'}</a>`
      + `<button data-close-identity="1">关闭</button></div>`
      + `<p class="q-hint">登录页在 <code>${esc(API('/identity/'))}</code>（本服务的页面，不是外站）：`
      + `登录后<strong>自动回到你刚才那一页</strong>（不走新标签页，不用手动切回来）；`
      + `署名与"发言人"这类字段会自动带上你的名字。</p>`, 'q-identity')
    el('q-modal').querySelector('[data-close-identity]')?.addEventListener('click', closeModal)
  }


  /** **插件与注册面**（机制面）：谁贡献了什么，以及**不重启进程**把它重载一遍。 */
  async function openPlugins() {
    openModal('<h2 id="q-action-title">插件与注册面</h2><p class="q-src">装载中…</p>', 'q-plugins')
    const out = await getJson('/api/ui/plugins')
    const modal = el('q-modal')
    if (!out.ok) {
      modal.querySelector('.q-card').innerHTML = stateBlock({ kind: 'error', title: '插件清单读取失败',
        reason: out.code || 'bad-json', next_action: out.next_action || '刷新重试' })
      return
    }
    state.plugins = out.plugins || []
    const rows = state.plugins.map((plugin) => `<tr data-plugin="${attr(plugin.plugin_id)}">`
      + `<td><code>${esc(plugin.plugin_id)}</code></td>`
      + `<td>${plugin.loaded ? badge('已装载', 'ok') : badge('未装载', 'warn')}</td>`
      + `<td>${(plugin.contributions || []).length} 项${(plugin.refused || []).length
        ? ` ${badge(`拒 ${(plugin.refused || []).length}`, 'bad')}` : ''}</td>`
      + `<td><code>${esc(String(plugin.mtime || '').slice(0, 19))}</code></td>`
      + `<td><button data-plugin-reload="${attr(plugin.plugin_id)}" title="撤掉它的贡献后按磁盘当前内容重装`
        + `（不重启进程）">重载</button>`
      + `<button data-plugin-unload="${attr(plugin.plugin_id)}" title="撤掉它的全部 UI 贡献">卸载</button>`
      + `${plugin.loaded ? '' : `<button data-plugin-load="${attr(plugin.plugin_id)}">装载</button>`}</td></tr>`).join('')
    modal.querySelector('.q-card').innerHTML = html([
      `<h2 id="q-action-title">插件与注册面</h2>`,
      `<p class="q-src">${esc(out.mechanism || '')}</p>`,
      `<p class="q-hint">${esc(out.next_action || '')}</p>`,
      `<div class="q-scroll"><table class="q-table"><thead><tr><th>插件</th><th>状态</th><th>贡献</th>`
      + `<th>文件 mtime</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`,
      '<div data-plugin-result="1"></div>'])
    const act = async (op, pluginId) => {
      const res = await postJson(`/api/ui/plugins/${encodeURIComponent(pluginId)}/${op}`, {})
      const holder = modal.querySelector('[data-plugin-result]')
      if (holder) holder.innerHTML = resultHtml({ ...res, result: res }, { title: `${pluginId} ${op}` })
      toast(res.ok ? 'ok' : 'bad', `${pluginId} ${op}：${res.code || (res.ok ? 'ok' : 'failed')}`,
        res.next_action || res.reason || '')
      if (res.ok) { await loadAll(true); await openPlugins() }
    }
    modal.querySelectorAll('[data-plugin-reload]').forEach((node) =>
      node.addEventListener('click', () => act('reload', node.dataset.pluginReload)))
    modal.querySelectorAll('[data-plugin-unload]').forEach((node) =>
      node.addEventListener('click', () => act('unload', node.dataset.pluginUnload)))
    modal.querySelectorAll('[data-plugin-load]').forEach((node) =>
      node.addEventListener('click', () => act('load', node.dataset.pluginLoad)))
  }

  function openHelp() {
    const shortcuts = (state.surface.shortcuts || []).map((item) =>
      `<tr><td><code>${esc(item.keys)}</code></td><td>${esc(item.title)}</td><td><code>${esc(item.action)}</code></td>`
      + `<td><code>${esc(item.plugin_id)}</code></td></tr>`).join('')
    openModal(`<h2 id="q-action-title">快捷键与用法</h2>
      <table class="q-table"><caption>外壳快捷键（外壳提供机制，插件可以再注册）</caption>
      <thead><tr><th>键</th><th>做什么</th><th>动作</th><th>注册者</th></tr></thead><tbody>
      <tr><td><code>Ctrl/⌘+K</code></td><td>命令面板（动作/视图/对象类）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Ctrl/⌘+E</code></td><td>最近访问 / 继续上次</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Alt+1..9</code></td><td>切到第 N 个标签页</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Alt+W</code></td><td>关掉当前标签页</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>g</code> + 视图首字母</td><td>转到视图（${viewsOf().map((view) =>
        `${esc(view.title)}：<code>g ${esc(view.id[0] ?? '')}</code>`).join(' · ')}）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>?</code></td><td>本帮助</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>r</code></td><td>重载当前页（含对象页）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Tab</code>/<code>Shift+Tab</code></td><td>在按钮与字段间移动（焦点有描边）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Esc</code></td><td>关闭弹层/右键菜单；在可编辑格子里先"还原这一格"</td><td>—</td><td>外壳</td></tr>
      ${shortcuts}</tbody></table>
      <table class="q-table"><caption>可编辑表格里（备报价时不用鼠标）</caption>
      <thead><tr><th>键</th><th>做什么</th></tr></thead><tbody>
      <tr><td><code>Tab</code> / <code>Shift+Tab</code></td><td>跳到下/上一个可编辑格（跨行）</td></tr>
      <tr><td><code>Enter</code> / <code>Shift+Enter</code></td><td>同一列的下/上一行（照着行往下填单价）</td></tr>
      <tr><td><code>↑</code> / <code>↓</code></td><td>同上（同列上下行）</td></tr>
      <tr><td><code>Esc</code></td><td>把这一格还原成改动前的值</td></tr>
      <tr><td><code>Ctrl/⌘+Enter</code></td><td>直接提交编辑（= 点「提交编辑」）</td></tr></tbody></table>
      <table class="q-table"><caption>面板布局（②）</caption>
      <thead><tr><th>怎么做</th><th>做什么</th></tr></thead><tbody>
      <tr><td>拖动面板标题左边的 <code>⠿</code></td><td>换面板顺序（松手即保存；刷新后仍是这个顺序）</td></tr>
      <tr><td>焦点在 <code>⠿</code> 上按 <code>Alt+↑/↓</code></td><td>键盘换顺序（不用鼠标）</td></tr>
      <tr><td>标题右侧的 <code>▾</code>/<code>▸</code></td><td>收起/展开这一块（收起后标题与深链仍在）</td></tr>
      <tr><td>布局条上的「收起全部 / 恢复默认布局」</td><td>整页处理；恢复默认 = 回到插件声明的样子</td></tr></tbody></table>
      <p class="q-hint">插件注册的快捷键与动作同生同死：插件卸载后这里的行与页面上的入口一起消失。</p>
      <p class="q-hint">浏览器把 <code>Ctrl+W</code>/<code>Ctrl+1..9</code> 留给自己用了（网页拦不到），所以标签页用
      <code>Alt</code> 组合键 —— 这是浏览器限制，不是没做。</p>`, 'q-help')
  }

  // ---------------------------------------------------------------- 键盘
  let sequence = ''
  document.addEventListener('keydown', (ev) => {
    const active = document.activeElement
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName)
    if (ev.key === 'Escape') {
      // Esc 在弹层里：先回列表（有「返回修改」就点它），没有再关掉 —— 免得手滑丢掉填了一半的表单
      const modal = el('q-modal')
      const back = modal?.querySelector('[data-back]')
      if (back) { back.click(); return }
      closeModal(); closeContextMenu(); return
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openPalette(); return }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'e') { ev.preventDefault(); openRecent(); return }
    // ⑤ 标签页：浏览器把 Ctrl+W / Ctrl+1..9 自己占用了（网页拦不到），所以标签页用 Alt 组合键
    if (ev.altKey && /^[1-9]$/.test(ev.key)) { ev.preventDefault(); return switchTab(Number(ev.key)) }
    if (ev.altKey && ev.key.toLowerCase() === 'w') {
      ev.preventDefault()
      const at = state.tabs.findIndex((tab) => sameRoute(tab, state.route))
      if (at < 0) return toast('warn', '当前地址不在标签页里', '点页面上的「钉成标签页」把它钉住')
      return closeTab(at)
    }
    if (typing) return
    if (ev.key === '?') { openHelp(); return }
    if (ev.key === 'r') { loadAll(true); return }
    const key = ev.key.toLowerCase()
    if (key === 'g') { sequence = 'g'; setTimeout(() => { sequence = '' }, 1200); return }
    if (sequence === 'g') {
      sequence = ''
      const target = viewsOf().find((view) => (view.id[0] ?? '') === key)
      if (target) { navigate(target.id, '', ''); return }
    }
    const plugin = (state.surface.shortcuts || []).find((item) => item.keys === key)
    if (plugin) { ev.preventDefault(); openActionEntry(plugin.action) }
  })

  // ---------------------------------------------------------------- 加载
  /**
   * **没跑完的那一批**（P21 / D1）：`GET /api/ui/jobs` 里 `recent` 有 `interrupted`/`failed` **且真还有**
   * `pending_ids`/`refused_ids` ⇒ 摆一条提示条：「到哪了」+ 一颗「只重试剩下的 N 份」（幂等：已完成的会报 duplicates）。
   *
   * P25 ③ 的两条纪律：① 数字来自服务端**收尾对账后**的 `pending_ids`/`refused_ids`（后来的批次已经给出结论的
   * 那些不再算"还没做"）⇒ 全做完了这条提示自然消失，不会拿一条过期清单反复说"还没做 N 份"；
   * ② 可以**忽略**（「忽略这条（不再提示）」= 只收起提示，不删任何数据；便签按 (批次 id, 剩余份数) 记）。
   * 读不到进度时**不假装没有**（说清"读不到"），也不影响页面上别的东西。
   */
  async function noteUnfinishedJobs() {
    const out = await getJson('/api/ui/jobs')
    if (!out || out.ok !== true) return
    const stuck = (out.recent || []).find((job) => (job.status === 'interrupted' || job.status === 'failed')
      && ((job.pending_ids || []).length || (job.refused_ids || []).length))
    if (!stuck) return
    const left = [...new Set([...(stuck.pending_ids || []), ...(stuck.refused_ids || [])])]
    if (!left.length) return                     // 真没有未完成的份数 ⇒ 一个字都不摆
    const key = `${stuck.id}|${left.length}`     // 便签：同一件事（同一批、同样的剩余数）才收起
    if (jobHintNote(key)) return
    const settled = Number(stuck.superseded || 0)
    state.banners = state.banners.filter((item) => !String(item.title).startsWith('上一批没有跑完'))
    state.banners.push({ kind: 'warn', title: `上一批没有跑完：${stuck.title || stuck.action}（共 ${stuck.total}）`,
      detail: `已签 ${stuck.applied} · 已签过（幂等）${stuck.duplicates} · 被拒 ${stuck.refused} · `
        + `还没做的 ${left.length} 份（${stuck.status === 'interrupted' ? '进程中断过' : '运行时失败'}`
        + `${settled ? `；另有 ${settled} 份已被后来的批次收尾，不再算"还没做"` : ''}）`,
      next_action: `点下面那颗按钮：只重试这 ${left.length} 份（同一份署名；已完成的会如实报"已经签过"、`
        + '账本零新增）。这一批的逐条记录在 `/api/ui/jobs`，刷新或换设备都读得回来。'
        + '「忽略这条（不再提示）」只收起提示，不删任何数据。',
      dismiss: { key, label: '忽略这条（不再提示）' },
      retry: { action: stuck.action, ids: left, title: stuck.title || stuck.action } })
    renderBanners()
  }

  /**
   * **一次加载 = 四步，顺序不许变**（③ 状态纪律的落点）：
   *   ① 清提示条 → ② **清空上一页的数据并进入 loading**（屏幕上立刻只剩加载态，绝不残留旧行，
   *   也不会让人把旧数据当成新页面）→ ③ 并行拉三份数据 → ④ 按每份**各自的 ok** 决定渲染什么，
   *   **读不到就渲染错误态**（`panelsError` / `objectError`），而不是"空数组 ⇒ 看起来像没有数据"。
   *   通知读不到时**不清空**旧通知（清空会让徽标变 0 = 假装"没有待办"更坏）：保留最后一次成功的
   *   那份并标记为陈旧，通知中心里如实说明，状态栏与提示条同时上报。
   */
  async function loadAll(force) {
    state.banners = []          // 先清上一次的提示条（**再**装载注册面：它的失败提示不能被这行抹掉）
    if (force || !state.surface.actions.length) await loadSurface()
    const route = state.route
    const object = route.kind && route.id
    // ② 清空 + loading（这一行是"不残留旧数据"的判据本身）
    state.panels = []
    state.object = null
    state.panelsError = null
    state.objectError = null
    state.status = []
    state.statusError = null
    state.notifError = null
    state.loading = { at: new Date().toISOString(), view: route.view, kind: route.kind, id: route.id }
    renderMain(); renderBanners()
    const [panels, notifications, status] = await Promise.all([
      // **首屏也走服务端窗口**（`w=1` + 每块已存的查询状态 `pq`）：首屏只下发"这一页要看的那些行"，
      // 计数/排序/筛选由服务端在全集上算（口径见 `/api/ui/surface` 的 `io.window`）。
      // 没带 `pq` 的面板用服务端默认每页行数（25）—— 与界面默认一致。
      getJson(panelsUrl(null)),
      // **通知同样走窗口**（`w=1` + `pq.notify`）：只回这一页 + 在**全量产出**上算出来的计数
      // （共 / 命中 / 未读 / 还剩多少没翻到）。整个全量不再下发（旧口径会在 600 条处静默截断）。
      getJson(notifUrl(state.notifPage)),
      getJson('/api/ui/status'),
    ])
    // **上一批没跑完要如实说**（P21 / D1 的另一半：工作不丢）：服务端把每一批的进度落在
    // `/api/ui/jobs`，进程中断/刷新之后照样读得回来 —— 有没跑完的就摆一条提示条（含"只重试剩下的"入口）。
    noteUnfinishedJobs()
    state.loading = null
    if (object) {
      if (panels.ok) {
        state.object = panels
        state.panels = (panels.panels || []).filter((panel) => panel.visible !== false)
      } else {
        state.objectError = { code: panels.code || 'object-read-failed', reason: panels.reason || '',
          next_action: panels.next_action || '点「重新读一次」；还是失败就看服务日志（./run logs）' }
        state.panels = []
      }
    } else {
      state.object = null
      if (panels.ok) {
        state.panels = panels.panels || []
      } else {
        state.panelsError = { code: panels.code || 'panels-read-failed', reason: panels.reason || '',
          next_action: panels.next_action || '点「重新读一次」；还是失败就看服务日志（./run logs）' }
        state.panels = []
      }
    }
    if (notifications.ok) {
      // 只**换掉这一页**（读不到时**不清空**：留着上一次成功的那一页并标陈旧 —— 清空会让徽标变 0，
      // 那等于假装"没有待办"，比显示出旧数据更坏）
      state.notify = { at: new Date().toISOString(), query: notifications.query || null,
        items: notifications.items || [], stats: notifications.stats || null }
      state.notifPoll = { at: state.notify.at, query: state.notify.query, items: state.notify.items }
      if (notifications.query) state.notifPage = Math.max(0, Number(notifications.query.page) || 0)
    } else {
      state.notifError = { code: notifications.code || 'notifications-read-failed',
        reason: notifications.reason || '', next_action: notifications.next_action || '点顶部「重载」重试' }
    }
    if (status.ok) state.status = status.items || []
    else state.statusError = { code: status.code || 'status-read-failed', reason: status.reason || '' }
    if (state.panelsError || state.objectError) {
      banner('bad', state.objectError ? '对象页读取失败（这一页没读到，不是没有数据）' : '面板读取失败（不是没有面板）',
        (state.objectError || state.panelsError).reason || (state.objectError || state.panelsError).code,
        (state.objectError || state.panelsError).next_action)
    }
    if (state.notifError) {
      banner('warn', '通知没读到（徽标与通知中心保留上一次成功的读数，已标记为陈旧）',
        [state.notifError.code, state.notifError.reason].filter(Boolean).join(' · '),
        state.notifError.next_action)
    }
    const errors = state.panels.filter((panel) => panel.error)
    if (errors.length) banner('warn', `${errors.length} 块面板渲染失败`,
      errors.map((panel) => `${panel.id}: ${panel.error.reason}`).join('；'), '修插件里这些面板的 data()')
    renderMain(); renderBanners()
    paintBadge()
    // 身份与视角不一致时**如实说**（业务视图本身不按身份鉴权 —— 那是既有路由口径；外壳至少不让人误以为
    // "这一页就是我该看的那一页"。跨视角打开对方视图不会回落成"看不到"，但界面必须讲清楚。）
    const side = state.identity?.side
    const cross = (side === 'contractor' && state.route.view === 'supplier')
      || (side === 'supplier' && state.route.view === 'contractor')
    if (cross) {
      banner('warn', `当前身份是 ${state.identity.human}（${side}），但这一页是对方侧的视图`,
        '业务视图目前不按身份鉴权（既有路由口径）：人签类动作仍会被服务端按会话身份拒；'
        + '要看自己的待办，切到你那一侧',
        `点顶部视角切到「${side === 'contractor' ? '承包商' : '供应商'}」，或用 ${
          API('/inbox/')} 看「待我处理」`)
    }
    rememberRoute(state.route)
    renderTabs()
    // **导出列选择**（机制）：把"我这一套列"读回来（面板有就用面板的；否则问一次只读动作），
    // 读完若拿到了新东西就再画一遍 —— 「列…」按钮上的 N/M 在任何页面上都对。
    hydrateExportPrefs().then((changed) => { if (changed) renderMain() }).catch(() => {})
    // **接着开那个动作**（入口策略）：被引导到"能填的地方"（那条对象的页面）之后，到了就自动开表单。
    if (state.thenAction) {
      const wanted = state.thenAction
      state.thenAction = ''
      if (actionOf(wanted)) openAction(wanted, null)
    }
  }

  async function loadSurface() {
    const out = await getJson('/api/ui/surface')
    if (out.ok) state.surface = out
    else banner('bad', '注册面读取失败（界面是空壳）', out.reason || out.code || '',
      out.next_action || '确认服务在跑；然后点「重载」')
  }

  // 初始化：地址栏就是**唯一**的位置来源（刷新/分享/前进后退都靠它）
  state.route = parsePath(location.pathname)
  renderChrome(); renderTabs(); loadAll(true)
  // 身份先解析（顶栏「身份」徽标 + 人签字段预填都读它），再拉**服务端**通知偏好（0600 文件；未登录则回落到本浏览器）
  loadIdentity().then(() => loadNotifState()).then((out) => {
    // 服务端那份（若在）是"换设备仍在"的来源：读回来后把受影响的块重绘一遍（查询状态就是它给的）
    const affected = hydrateQueryFromMirror()
    repaintQueriedPanels([...affected])
    // 偏好（级别/静音/已读）读回来之后，通知的**计数与未读**都要按它重算一次（服务端算的）
    return fetchNotify(state.notifPage).then(() => out).catch(() => out)
  }).then(paintBadge)
  /**
   * 通知轮询（15s）：只更**徽标**，并且**最多弹一条**汇总提示 —— 一次来 8 条也不刷屏。
   * 取的是**通知窗口的第一页**（不是全量）：`unread`/`chip_counts` 是服务端在**全量产出**上算的读数，
   * 所以徽标上的数字与通知中心里那句"共 N 条"永远同源。首次看到某条 id 时才提示
   * （`seenNotifs` 是本次会话的内存集合）。
   */
  const seenNotifs = new Set()
  const pollNotify = async () => {
    const out = await getJson(notifUrl(0))
    if (!out.ok) {
      // 轮询失败**不静默**（否则徽标会一直显示"没有新事情"）：记下来、在上报面上如实标陈旧。
      state.notifError = { code: out.code || 'notifications-read-failed', reason: out.reason || '',
        next_action: out.next_action || '点顶部「重载」重试' }
      paintBadge()
      return
    }
    state.notifError = null
    state.notifPoll = { at: new Date().toISOString(), query: out.query || null, items: out.items || [] }
    // "新到的"只在**第一页**里认（急的排前面 ⇒ 真出事的会在第一页上）；口径如实写在提示里
    const fresh = (out.items || []).filter((item) => !state.notif.read.has(String(item.id))
      && !seenNotifs.has(String(item.id)))
    for (const item of (out.items || [])) seenNotifs.add(String(item.id))
    paintBadge()
    if (!fresh.length) return
    if (fresh.length === 1) {
      const one = fresh[0]
      toast(one.level === 'bad' ? 'bad' : (one.level === 'warn' ? 'warn' : 'ok'), `新通知：${one.title}`,
        [one.body, one.next_action].filter(Boolean).join(' · '))
      return
    }
    toast('warn', `第一页上有 ${fresh.length} 条新通知（不逐条弹）`, `最急的一条：${fresh[0].title}`
      + ` · 点顶栏「通知」看全部（共 ${unreadCount()} 条未读）`)
  }
  setInterval(pollNotify, 15000)
  setTimeout(() => { for (const item of notifPageItems()) seenNotifs.add(String(item.id)) }, 1200)
})()
