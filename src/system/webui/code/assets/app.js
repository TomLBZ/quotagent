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
    notif: 'quotagent.notif' }
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
    // ⑤ 多标签页 / 最近访问：地址栏仍是唯一位置来源，这两个只是"摆给用户看的入口"
    tabs: store.get(KEYS.tabs, []), recentRoutes: store.get(KEYS.recent, []),
    // ② 面板布局（顺序 / 折叠）：按「视图 + 对象类」分桶持久化
    layout: store.get(KEYS.layout, {}),
    // ① 通知中心：已读集合 + 偏好（静音哪些插件 / 最低级别）
    notif: store.get(KEYS.notif, { read: [], muted: [], minLevel: 'info' }),
    // ④ 对比模式：每个面板勾了哪几组列
    compare: {},
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
  /** 把当前偏好推到服务端（有 300ms 去抖：打开通知中心会连续标已读，不必每次都打一次）。 */
  function pushNotifState(immediate = false) {
    if (notifSource !== 'server') return
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
    }
    if (immediate) { send(); return }
    notifPushTimer = setTimeout(send, 300)
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
  /** 筛选片：`全部 N` + 每个桶（`label N`）。点一下只改"看到哪些"，不改任何事实。 */
  function bucketBar(scope, buckets, current, rows) {
    if (!buckets.length) return ''
    const chip = (key, label, count) => `<span class="q-chip${current === key ? ' on' : ''}"`
      + ` data-bucket-filter="${attr(scope)}" data-bucket-key="${attr(key)}" role="button" tabindex="0">`
      + `${esc(label)} ${Number.isFinite(Number(count)) ? Number(count) : countInBucket(rows, key)}</span>`
    return `<div class="q-bucketbar" data-bucket-bar="${attr(scope)}">`
      + `<span class="q-bucketbar-label">筛选</span>`
      + chip('', '全部', rows.length)
      + buckets.map((item) => chip(item.key, item.label, item.count)).join('')
      + `<span class="q-hint">只看你关心的那一类（按你的身份存在服务端：换浏览器/换设备仍是这套筛选；不改任何事实）</span></div>`
  }


  const html = (parts) => parts.join('')
  const badge = (text, level) => `<span class="q-badge ${level || ''}">${esc(text)}</span>`
  const attr = (value) => esc(value).replace(/'/g, '&#39;')

  /** 对象/视图的**深链**（可复制分享）：对象地址 = `/app/<view>/<kind>/<id>/`。 */
  const linkOf = (view, kind, id) => (kind && id ? `${API(`/app/${view}/${kind}/${id}/`)}` : API(`/app/${view}/`))
  const refLink = (ref) => (ref && ref.kind && ref.id
    ? linkOf(ref.view || state.route.view, ref.kind, ref.id) : '')
  const refLabel = (ref) => (ref && ref.title ? ref.title : (ref ? `${ref.kind} ${ref.id}` : ''))

  async function getJson(path) {
    try {
      const res = await fetch(API(path), { headers: { accept: 'application/json' } })
      try { return await res.json() } catch (err) { return { ok: false, code: 'bad-json', reason: String(err) } }
    } catch (err) {
      return { ok: false, code: 'offline', reason: `请求 ${path} 失败：${String(err)}`,
        next_action: '确认本服务还在跑（状态栏的连接灯），然后点顶部「重载」' }
    }
  }
  async function postJson(path, body) {
    try {
      const res = await fetch(API(path), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}) })
      try { return await res.json() } catch (err) { return { ok: false, code: 'bad-json', reason: String(err) } }
    } catch (err) {
      return { ok: false, code: 'offline', reason: String(err), next_action: '确认服务在跑后重试' }
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
  function toast(kind, title, detail) {
    const box = el('q-toasts')
    if (!box) return
    const node = document.createElement('div')
    node.className = `q-toast ${kind}`
    node.setAttribute('role', 'status')
    node.innerHTML = `<b>${esc(title)}</b>${detail ? `<div>${esc(detail)}</div>` : ''}`
    box.appendChild(node)
    setTimeout(() => node.remove(), kind === 'bad' ? 12000 : 6000)
  }
  function notifyAction(result, action) {
    if (!result) return
    if (result.ok) {
      toast('ok', `${action ? action.title : '动作'}：已受理`,
        [result.code ? `(${result.code})` : '', result.next_action || ''].filter(Boolean).join(' · '))
    } else {
      toast('bad', `${action ? action.title : '动作'}：被拒（${result.code || 'refused'}）`,
        [result.reason, result.next_action].filter(Boolean).join(' · '))
    }
    state.results.unshift({ id: `act-${Date.now()}-${action?.id || ''}`, plugin_id: action?.plugin_id || '', level: result.ok ? 'ok' : 'bad',
      title: `${action ? action.title : '动作'} → ${result.ok ? 'ok' : result.code}`, body: result.reason || '',
      next_action: result.next_action || '', at: new Date().toISOString(), ref: result.ref || null })
    state.results = state.results.slice(0, 20)
  }
  function banner(kind, title, detail, nextAction) {
    state.banners = state.banners.filter((item) => item.title !== title)
    state.banners.push({ kind, title, detail, next_action: nextAction || '' })
    renderBanners()
  }
  function renderBanners() {
    const box = el('q-banners')
    if (!box) return
    box.innerHTML = state.banners.map((item, index) =>
      `<div class="q-banner ${item.kind}" data-banner="${index}"><b>${esc(item.title)}</b>`
      + `${item.detail ? ` <span>${esc(item.detail)}</span>` : ''}`
      + `${item.next_action ? ` <div class="q-hint">${esc(item.next_action)}</div>` : ''}`
      + `<button data-banner-close="${index}" aria-label="关闭这条提示">知道了</button></div>`).join('')
    box.querySelectorAll('[data-banner-close]').forEach((node) => node.addEventListener('click', () => {
      state.banners.splice(Number(node.dataset.bannerClose), 1); renderBanners()
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

  function navigate(view, kind, id, { replace = false, quiet = false } = {}) {
    const next = { view: view || 'home', kind: kind || '', id: id || '' }
    state.route = next; state.edits = {}; state.editOrigin = {}
    state.selected = {}; state.selectedRows = {}
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
    const conn = state.banners.some((item) => item.kind === 'bad') ? ['连接', '有请求失败', 'bad'] : ['连接', '正常', 'ok']
    const statusLine = (item) => `<span class="q-st ${item.level === 'ok' ? '' : item.level}">${esc(item.title)}：`
      + `${esc(item.text)}${item.level && item.level !== 'ok'
        ? ` ${badge(item.level, item.level === 'bad' ? 'bad' : 'warn')}` : ''}</span>`
    // 状态栏只摆前 8 项（再多就挤成糊字）；其余的进「更多 N 项」（点开是完整清单，仍可读）
    const shown = state.status.slice(0, 8)
    const rest = state.status.slice(8)
    el('q-status').innerHTML = html([
      `<span class="q-st ${conn[2]}">${conn[0]}：${conn[1]}</span>`,
      ...shown.map(statusLine),
      rest.length ? `<button class="q-link" data-status-all="1">更多 ${rest.length} 项</button>` : '',
      '<span class="q-spacer"></span>',
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

  // ---------------------------------------------------------------- 通用状态块（空态/错误态/降级）
  function stateBlock({ kind, title, reason, next_action, hint }) {
    const level = kind === 'error' ? 'bad' : (kind === 'degraded' ? 'warn' : 'info')
    return `<div class="q-state ${level}" data-state="${attr(kind)}" data-state-reason="${attr(reason || '')}">`
      + `<b>${esc(title)}</b>${reason ? ` <code>${esc(reason)}</code>` : ''}`
      + `${hint ? `<div>${esc(hint)}</div>` : ''}`
      + `${next_action ? `<div class="q-hint">下一步：<code>${esc(next_action)}</code></div>` : ''}</div>`
  }

  // ---------------------------------------------------------------- 面板渲染（通用形状）
  function rowRefCell(row) {
    const href = refLink(row.ref)
    if (!href) return ''
    return `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(row.ref.kind)}"`
      + ` data-id="${attr(row.ref.id)}" title="打开 ${attr(refLabel(row.ref))} 的对象页（可复制走）">打开 →</a>`
  }

  // ---------------------------------------------------------------- 可编辑表格的取值（编辑优先，原值兜底）
  const cellValue = (rowKey, field, row) => {
    const edited = (state.edits[rowKey] || {})[field]
    if (edited !== undefined) return edited
    return row ? row[field] : undefined
  }
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
    const rowKeyOf = (row, index) => String(row.id ?? row[allColumns[0]?.key] ?? index)
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
    const editable = columns.some((column) => column.editable)
    const head = html([bulk ? '<th class="q-rowsel"><input type="checkbox" data-select-all aria-label="全选"></th>' : '',
      columns.map((column) => `<th class="${attr(colClass(column))}">${esc(column.label || column.key)}</th>`).join(''),
      '<th>动作</th>'])
    const body = rows.map((row, index) => {
      const rowKey = rowKeyOf(row, index)
      const cells = columns.map((column) => {
        const raw = row[column.key]
        const value = raw === null || raw === undefined ? '' : String(raw)
        const cls = colClass(column)
        const best = column.best_when === 'min' && raw !== '' && raw !== undefined && numOf(raw)
          === Math.min(...rows.map((other) => (other[column.key] === '' || other[column.key] === undefined
            ? Infinity : numOf(other[column.key]))))
        if (column.editable) {
          const extra = column.line_total_of
            ? `<span class="q-linetotal" data-linetotal="${attr(rowKey)}:${attr(column.key)}" data-factor="${attr(column.line_total_of)}">`
              + `×${esc(String(cellValue(rowKey, column.line_total_of, row) ?? '—'))} = `
              + `${numOf(cellValue(rowKey, column.key, row)) * numOf(cellValue(rowKey, column.line_total_of, row))}</span>`
            : ''
          // 触控可用性：可编辑格在手机上要能看见自己在改哪一列（`data-label` 让小屏卡片视图带列名），
          // 数字格给对键盘（`inputmode`），回车键按语义（`enterkeyhint`）——都是浏览器原生能力。
          const numeric = column.type === 'number'
          return `<td class="${attr(cls)}" data-label="${attr(column.label || column.key)}">`
            + `<input data-edit="${attr(rowKey)}" data-field="${attr(column.key)}"`
            + ` data-type="${attr(column.type || 'text')}" value="${attr(value)}"`
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
      return `<tr data-row-key="${attr(rowKey)}">`
        + (bulk ? `<td class="q-rowsel" data-label="选中"><input type="checkbox" data-select="${attr(rowKey)}" aria-label="选中这一行"></td>` : '')
        + `${cells}<td class="q-rowacts" data-label="动作">${inline} ${rowRefCell(row)}</td></tr>`
    }).join('')
    const totals = totalsOf(data, rows, (row, index) => rowKeyOf(row, index))
    // ④ 对比模式下**每组一列合计**（如"每家报价的行合计总和"）：插件声明 `data.group_totals = {key, unit}`。
    const groupTotals = (data.group_totals && groups.length >= 2 && data.compare) ? groups.map((group) => {
      let sum = 0
      for (const row of rows) {
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
    }) : []
    const controls = html([bulk ? `<button data-bulk="${attr(bulk.id)}" class="primary">${esc(bulk.title)}`
      + `（已选 <span data-selected-count="1">0</span> 行）</button>` : '',
      editable ? `<button data-submit-edits data-panel="${attr(panel.id)}" class="primary">`
        + `提交编辑（<span data-edit-count="${attr(panel.id)}">0</span> 行）</button>`
        + `<button data-cancel-edits data-panel="${attr(panel.id)}">放弃改动</button>` : ''])
    const totalBar = (editable || totals.length || groupTotals.length)
      ? `<div class="q-editbar" data-editbar="${attr(panel.id)}">`
        + `${editable ? `<span>已改 <b data-edit-count="${attr(panel.id)}">0</b> 行</span>` : ''}`
        + totals.map((item) => `<span class="q-sum" data-total="${attr(item.key)}:${attr(item.factor ?? '')}">`
          + `${esc(item.label)}：<b>${item.value}</b>${item.unit ? ` ${esc(item.unit)}` : ''}</span>`).join('')
        + groupTotals.map((item) => `<span class="q-sum">`
          + `${item.raw ? item.label : esc(item.label)}：<b>${item.value}</b>${item.unit ? ` ${esc(item.unit)}` : ''}</span>`).join('')
        + `${editable ? `<span class="q-keys">Tab/Shift+Tab 左右走 · Enter/Shift+Enter 上下走 · Esc 还原这一格 · Ctrl/Cmd+Enter 提交</span>`
          : '<span class="q-keys">这一组勾选只影响看到的列（关键列固定不参与勾选）</span>'}`
        + `</div>`
      : ''
    const wideTable = columns.length > 6 || columns.some((column) => column.pin)
    return html([cmpBar, `<div class="q-scroll${columns.some((column) => column.pin) ? ' q-scroll-wide' : ''}">`
      + `<table class="q-table${wideTable ? ' q-wide' : ''}" data-panel-table="${attr(panel.id)}">`
      + `<caption class="q-caption">${esc(panel.title)}</caption>`
      + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      controls ? `<div class="q-actions">${controls}</div>` : '', totalBar])
  }

  function renderList(panel, data) {
    const all = data.items || []
    const buckets = bucketsOf(data, all)
    const current = filterOf(panel.id)
    const bar = bucketBar(panel.id, buckets, current, all)
    const items = byBucket(all, current)
    if (!items.length) {
      return bar + stateBlock({ kind: 'empty',
        title: current === '' ? '没有条目' : '这一桶里没有条目（不是坏了）',
        reason: current === '' ? (data.reason || 'no-items') : `bucket=${current}`,
        next_action: data.next_action || (current === '' ? '' : '点筛选片上的「全部」看所有条目') })
    }
    return bar + `<ul class="q-list">${items.map((item) => {
      const action = item.action ? actionOf(item.action) : null
      const href = refLink(item.ref)
      return `<li data-level="${attr(item.level || 'info')}"${item.bucket ? ` data-bucket="${attr(item.bucket)}"` : ''}>`
        + `${item.level ? badge(item.level, item.level === 'bad' ? 'bad' : (item.level === 'warn' ? 'warn'
          : (item.level === 'ok' ? 'ok' : ''))) + ' ' : ''}`
        + `<span class="q-li-title">${esc(item.title || item.label || '')}</span>`
        + `${item.bucket_label ? ` <span class="q-tag q-bucket-tag">${esc(item.bucket_label)}</span>` : ''}`
        + `${item.body ? `<div class="q-li-body">${esc(item.body)}</div>` : ''}`
        + `${action || href ? `<div class="q-actions">${action
          ? `<button class="primary" data-action="${attr(action.id)}" data-preset='${attr(JSON.stringify(item.ref || {}))}'>`
            + `${esc(item.label || action.title)}</button>` : ''}${href
          ? `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(item.ref.kind)}"`
            + ` data-id="${attr(item.ref.id)}">打开 ${esc(refLabel(item.ref))} →</a>` : ''}</div>` : ''}`
        + `${item.next_action ? `<div class="q-hint">下一步：<code>${esc(item.next_action)}</code></div>` : ''}</li>`
    }).join('')}</ul>`
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
    const rows = data.files || []
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
    const table = rows.length
      ? `<div class="q-scroll"><table class="q-table q-files-table" data-panel-table="${attr(panel.id)}">` +
        `<caption class="q-caption">${esc(panel.title)}（${rows.filter((row) => !row.deleted).length} 个活的` +
        `${rows.some((row) => row.deleted) ? `，${rows.filter((row) => row.deleted).length} 个已删（留痕）` : ''}）` +
        `</caption>${head}<tbody>${body}</tbody></table></div>`
      : stateBlock({ kind: 'empty', title: '这个对象上还没有附件（不是坏了）', reason: 'no-attachments',
        hint: '现实采购里这一步是硬需求：技术规格、质检报告、回签的 PO 都挂在这里。',
        next_action: data.next_action || '把文件拖到上面的方块里，或点「选择文件」' })
    const countsBar = data.counts
      ? `<p class="q-hint" data-file-counts="1">活的 ${esc(data.counts.live ?? 0)} · 本侧上传 ${esc(data.counts.mine ?? 0)}` +
        ` · 已删（留痕）${esc(data.counts.deleted ?? 0)}` +
        `${data.counts.visible_ids !== undefined ? ` · 本侧可见的同类对象 ${esc(data.counts.visible_ids)} 个` : ''}` +
        `${data.visibility_rule ? ` · ${esc(data.visibility_rule)}` : ''}</p>`
      : ''
    return html([zone, table, countsBar])
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
      return `<dl class="q-kv">${(data.items || []).map((item) =>
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
    return `<div class="q-layoutbar" data-layout-bar="${attr(layout.key)}">`
      + `<span>布局（这块是你自己的）：${count} 块面板`
      + `${collapsed ? ` · 收起 ${collapsed}` : ''}`
      + `${saved ? ` · 已保存过（刷新后仍在）` : ' · 未改过'}</span>`
      + `<button data-layout="collapse-all">收起全部</button>`
      + `<button data-layout="expand-all">展开全部</button>`
      + `<button data-layout="reset">恢复默认布局</button>`
      + `<span class="q-hint">拖动面板标题左边的 ⠿ 换顺序；键盘：焦点在 ⠿ 上按 Alt+↑/↓`
      + `${notifSource === 'server' ? '｜布局按你的身份存在服务端（换浏览器/换设备仍在）'
        : '｜布局只在本浏览器（登录后落服务端）'}</span></div>`
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
        + ` data-open-object="1" data-k="${attr(panelRef.kind)}" data-id="${attr(panelRef.id)}"`
        + ` title="打开 ${attr(refLabel(panelRef))} 的对象页（可复制分享）">打开对象 →</a>` : ''}</h3>`
      + `<button class="q-panel-btn" data-collapse="${attr(panel.id)}" aria-expanded="${collapsed ? 'false' : 'true'}"`
      + ` title="${collapsed ? '展开这块' : '收起这块（收起后标题与深链仍在）'}">${collapsed ? '▸' : '▾'}</button></div>`
      + `<details class="q-mech"><summary>机制（这块是谁注册的）</summary><div class="q-src">${mech}</div></details>`
      + `${panel.hint ? `<p class="q-hint">${esc(panel.hint)}</p>` : ''}`
      + `<div class="q-body">${body}</div></section>`
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
  }


  function toolbarHtml(actions, label) {
    if (!actions.length) return ''
    return `<div class="q-actions" data-toolbar="${attr(label)}">` + actions.map((action) =>
      `<button data-action="${attr(action.id)}"${action.confirm?.required ? ' data-confirm="1"' : ''}`
      + ` title="${attr(action.hint || '')}">${esc(action.title)}`
      + `${action.permission === 'human-signature' ? ' ✍' : ''}</button>`).join('') + '</div>'
  }

  // ---------------------------------------------------------------- 工作台：「你现在该做什么」
  function todoItems() {
    const out = []
    for (const panel of state.panels) {
      const items = ((panel.data || {}).items || [])
      for (const item of items) {
        out.push({ ...item, panel_id: panel.id, plugin_id: panel.plugin_id })
      }
    }
    const rank = { bad: 0, warn: 1, info: 2, ok: 3 }
    return out.sort((left, right) => (rank[left.level] ?? 2) - (rank[right.level] ?? 2))
  }

  function workbenchHtml() {
    const items = todoItems()
    const last = lastRoute()
    const actions = state.surface.actions.filter((action) => !action.inline)
    const groups = [...new Set(actions.map((action) => action.group || '通用'))]
    // 「我的 / 我指派的 / 全部」：条目可以带 `bucket`+`bucket_label`（协作面就是这么标自己的）⇒ 出筛选片。
    const buckets = bucketsOf({}, items)
    const current = filterOf('workbench')
    const shown = byBucket(items, current)
    const wanted = shown.filter((item) => item.level === 'warn' || item.level === 'bad')
    const headline = current !== ''
      ? `按「${esc(String(buckets.find((b) => b.key === current)?.label ?? current))}」筛选：${shown.length} 条`
        + `（全部 ${items.length} 条；不带分类的待办只在「全部」里出现）`
      : (wanted.length
        ? `有 ${wanted.length} 件需要你处理${items.length > wanted.length ? `，另有 ${items.length - wanted.length} 条信息` : ''}`
        : (items.length ? `眼下没有卡住你的事（${items.length} 条信息）` : '还没有插件报告待办'))
    // 急的排前面，但**信息类也要摆出来**：只显示急的会让"收到几条报价登记"这种线索消失
    const list = shown.slice(0, 8)
    const rest = shown.length - list.length
    return `<section class="q-todo" data-workbench="1" data-todo-count="${items.length}"
      data-todo-urgent="${wanted.length}">
  <div class="q-todo-head">
    <h2>你现在该做什么</h2>
    <p>${esc(headline)}${current === '' && items.length && wanted.length
      ? `（另有 ${items.length - wanted.length} 条信息）` : ''}</p>
    <button class="q-link" data-open="palette">搜全部动作（点这里；键盘 <kbd>Ctrl/⌘+K</kbd>）</button>
  </div>
  ${bucketBar('workbench', buckets, current, items)}
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
      + `${item.bucket_label ? ` <span class="q-tag q-bucket-tag">${esc(item.bucket_label)}</span>` : ''}`
      + `${item.body ? `<div class="q-li-body">${esc(item.body)}</div>` : ''}`
      + `${item.next_action ? `<div class="q-hint">${esc(item.next_action)}</div>` : ''}`
      + `${action || href ? `<div class="q-actions">${action ? `<button class="primary" data-action="${attr(action.id)}"`
        + ` data-preset='${attr(JSON.stringify(item.ref || {}))}'>${esc(item.label || action.title)}</button>` : ''}`
        + `${href ? `<a class="q-deeplink" href="${attr(href)}" data-open-object="1" data-k="${attr(item.ref.kind)}"`
          + ` data-id="${attr(item.ref.id)}">打开 ${esc(refLabel(item.ref))} →</a>` : ''}</div>` : ''}</li>`
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
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><nav class="q-crumbs" aria-label="面包屑">${crumbs}</nav>`
      + `<button class="q-link" data-copy="${attr(linkOf(route.view, route.kind, route.id))}">复制这条深链</button>`
      + `<button class="q-link" data-tab-pin="1" title="把这条对象地址固定成一个标签页，方便来回切">钉成标签页</button></div>`,
      head,
      toolbarHtml([...objectActions(), ...objectRouteActions()], `${route.view}/${route.kind}`),
      reportBar(state.object?.reports || [], `${route.view}/${route.kind}`),
      layoutBar(laid.list.length),
      `<div class="q-panels">${laid.list.map((item) => panelSection(item.panel, item.collapsed)).join('')}</div>`,
      toolbarHtml(viewActions({ excludeRoutePrefilled: true }), `${route.view}（视图级动作）`)
        ? `<details class="q-mech q-more-actions">`
        + `<summary>本视图的其它动作（${viewActions({ excludeRoutePrefilled: true }).length} 个）</summary>`
        + toolbarHtml(viewActions({ excludeRoutePrefilled: true }), `${route.view}（视图级动作）`) + '</details>' : '',
      `<div data-ui-blocks="${attr(`page.${route.view}`)}"></div>`])
    bindPanels()
    bindInteractions()
    bindFiles(el('q-view'))          // ⑥ 文件集合面板（附件）：拖拽上传 / 选择文件 / 键盘
    loadBlocks()
  }

  function renderViewPage() {
    const actions = viewActions()
    const isHome = state.route.view === 'home'
    const laid = orderedPanels()
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><h1>${esc(viewTitle(state.route.view))}</h1>`
      + `<p>${isHome ? '我今天要做什么' : `${state.panels.length} 块面板`} · 深链 `
      + `<button class="q-link" data-copy="${attr(linkOf(state.route.view))}">复制</button>`
      + `<code>${esc(linkOf(state.route.view))}</code>`
      + `<button class="q-link" data-tab-pin="1">钉成标签页</button></p></div>`,
      isHome ? workbenchHtml() : '',
      toolbarHtml(actions, state.route.view),
      reportBar((state.surface.reports || []).filter((item) => !item.object_kind
        && (item.views || []).includes(state.route.view)), state.route.view),
      layoutBar(laid.list.length),
      `<div class="q-panels${isHome ? ' q-panels-home' : ''}">${laid.list.map((item) =>
        panelSection(item.panel, item.collapsed)).join('')}</div>`,
      `<div data-ui-blocks="${attr(`page.${state.route.view}`)}"></div>`])
    bindPanels()
    bindInteractions()
    bindFiles(el('q-view'))          // ⑥ 文件集合面板（附件）：拖拽上传 / 选择文件 / 键盘
    loadBlocks()
  }

  function renderMain() {
    if (state.route.kind && state.route.id) renderObjectPage()
    else renderViewPage()
    renderStatus()
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
  function bindPanels() {
    const root = el('q-view')
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
      `</span>`).join('') +
      `<span class="q-hint">导出内容由注册它的插件生成（与账面同源、逐行可对）；HTML 可直接打印</span></div>`
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
    openModal(html([
      `<h2 id="q-action-title">导出：${esc(exp.filename || '')}</h2>`,
      `<p class="q-src">由 <code>${esc(action ? action.plugin_id : '')}</code> 的 <code>${
        esc(action ? action.id : '')}</code> 生成 · 格式 <code>${esc(exp.format || '')}</code>`,
      `${rows ? ` · ${esc(rows)}` : ''}${exp.digest ? ` · 内容指纹 <code>${esc(String(exp.digest).slice(0, 19))}…</code>` : ''}`,
      ` · 与账面同源（导出用的就是这一侧账本里的行）</p>`,
      `<div class="q-export-holder" data-export-holder="1"></div>`,
      `<div class="q-actions"><button class="primary" data-print="1">打印</button>`,
      `<button data-download="1">下载这份文件</button><button data-close="1">关闭</button></div>`,
      `<p class="q-hint">打印走浏览器自己的打印对话框（可以"另存为 PDF"）；下载得到的是同内容的一份文件。</p>`]),
    'q-export-modal')
    const modal = el('q-modal')
    if (!modal) return
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

  function bindInteractions() {
    const root = el('q-view')
    root.querySelectorAll('[data-action]').forEach((node) => node.addEventListener('click', () => {
      let preset = {}
      try { preset = JSON.parse(node.dataset.preset || '{}') } catch (err) { preset = {} }
      openAction(node.dataset.action, preset)
    }))
    root.querySelectorAll('[data-row-action]').forEach((node) => node.addEventListener('click', () => {
      let row = {}
      try { row = JSON.parse(node.dataset.row) } catch (err) { row = {} }
      openAction(node.dataset.rowAction, row)
    }))
    root.querySelectorAll('[data-open-object]').forEach((node) => node.addEventListener('click', (ev) => {
      if (ev.metaKey || ev.ctrlKey) return
      ev.preventDefault()
      navigate(state.route.view, node.dataset.k, node.dataset.id)
    }))
    root.querySelectorAll('[data-copy]').forEach((node) =>
      node.addEventListener('click', () => copyText(node.dataset.copy)))
    root.querySelectorAll('[data-open="palette"]').forEach((node) => node.addEventListener('click', openPalette))
    // 桶筛选片（「我的 / 我指派的 / 全部」）：只改"看到哪些"，不改任何事实；选择存本浏览器
    root.querySelectorAll('[data-bucket-filter]').forEach((node) => {
      const pick = () => {
        setFilter(node.dataset.bucketFilter, node.dataset.bucketKey)
        renderMain()
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
    // 计数与批量 ids 都会串到别的表）
    root.querySelectorAll('[data-select-all]').forEach((node) => node.addEventListener('change', () => {
      const table = node.closest('table') || root
      table.querySelectorAll('[data-select]').forEach((box) => {
        box.checked = node.checked
        state.selected[box.dataset.select] = node.checked
      })
      updateSelectedCount()
    }))
    root.querySelectorAll('[data-select]').forEach((node) => node.addEventListener('change', () => {
      state.selected[node.dataset.select] = node.checked
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
      const panelId = ev.currentTarget?.dataset?.panel
      if (panelId) renderPanels()
      else loadAll(true)
    }))
    root.querySelectorAll('[data-bulk]').forEach((node) => node.addEventListener('click', () => {
      const holder = node.closest('[data-panel]') || root
      // 只取**本表**勾上的行（跨表面板串选会把别的表的 id 一起发出去）
      const ids = [...holder.querySelectorAll('[data-select]:checked')].map((box) => box.dataset.select)
      // 已经改了单元格但没勾行 ⇒ 直接提交这些改动（不逼用户先勾一遍；改了东西却只收到"没有选中"是最气人的）
      if (!ids.length && Object.keys(state.edits).length) {
        return submitEdits(holder)
      }
      if (!ids.length) {
        return toast('warn', '没有选中任何行',
          '勾选表格左侧的复选框（或点表头全选），或者直接改单元格再点这个按钮')
      }
      const rows = ids.map((id) => (state.selectedRows || {})[id] || { id })
      openAction(node.dataset.bulk, { ids, rows: rows.filter(Boolean) })
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
    // 计数按**本表里真的勾上的**算（不是全局 state：全局计数在跨表时会把别的表的勾选也算进来）
    document.querySelectorAll('[data-selected-count]').forEach((node) => {
      const scope = node.closest('[data-panel]') || document
      node.textContent = String(scope.querySelectorAll('[data-select]:checked').length)
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
      return { id, item_id: id, ...fields }
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
    const original = new Map()
    source.forEach((row, index) => original.set(String(row.id ?? row[firstKey] ?? index), row))
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
      return original.get(rowKey)?.[field]
    }
    panelNode.querySelectorAll('[data-linetotal]').forEach((node) => {
      const [rowKey, field] = String(node.dataset.linetotal).split(':')
      const base = valueOf(rowKey, field) ?? ''
      const factor = valueOf(rowKey, node.dataset.factor) ?? ''
      node.textContent = `×${factor === '' ? '—' : factor} = ${numOf(base) * numOf(factor)}`
    })
    const keys = [...dom.keys()]
    const live = totalsOf(panel?.data ?? {}, keys.map((key) => original.get(key) ?? {}),
      (row, index) => keys[index], valueOf)
    panelNode.querySelectorAll('[data-total]').forEach((node, index) => {
      const rule = live[index]
      const holder = node.querySelector('b')
      if (holder && rule) holder.textContent = String(rule.value)
    })
    const changed = editRowsOf(panelId).length
    el('q-view').querySelectorAll(`[data-edit-count="${panelId}"]`)
      .forEach((node) => { node.textContent = String(changed) })
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
      lead_time_days: rows[0].lead_time_days })
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

  function fieldHtml(field, value) {
    const v = value === undefined || value === null ? (field.default ?? '') : value
    const fromSession = (field.identity === true || field.type === 'signature')
      && String(v).startsWith('human:') ? '（= 你当前的会话身份，改错了服务端会拒）' : ''
    const help = field.help || fromSession
      ? `<span class="q-help">${esc(field.help || '')}${fromSession ? esc(fromSession) : ''}</span>` : ''
    const id = `f-${field.name}`
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

  function openAction(id, presets, priorResult) {
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
    const body = html([
      `<h2 id="q-action-title">${esc(action.title)}</h2>`,
      `<p class="q-src">动作 <code>${esc(action.id)}</code> · 由 <code>${esc(action.plugin_id)}</code> 注册 · `
      + `权限 <code>${esc(action.permission)}</code>`
      + `${action.confirm?.required ? ' · 提交前会再确认一次' : ''}`
      + `${action.object_kind ? ` · 作用于 <code>${esc(action.object_kind)}</code>` : ''}</p>`,
      '<div class="q-modal-body">',
      action.hint ? `<p class="q-hint">${esc(action.hint)}</p>` : '',
      action.permission === 'human-signature'
        ? `<p class="q-degraded">这一步是人工门：<code>signature</code> 里的署名会随请求送到插件自己的`
          + `服务端一半，再由 Python 侧唯一写者落账本（界面不是第二条事实写路径）。</p>` : '',
      fields.map((field) => fieldHtml(field, values[field.name])).join(''),
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
      const out = await postJson(`/api/action/${encodeURIComponent(action.id)}`,
        { view: state.route.view, route: state.route, input })
      notifyAction(out, action)
      if (out.ok) {
        // **导出/打印**（`result.export`）：落一份文件 + 打开预览（打印在预览里一键完成）
        const exported = out.result && out.result.export ? { ...out.result.export } : null
        closeModal()
        await loadAll()
        if (exported) deliverExport({ result: { export: exported } }, action)
        return
      }
      // 失败：**回到表单**（确认弹层已经不在 DOM 里了，把结果写进它等于丢掉）并逐字段标红
      openAction(action.id, input, out)
      const back = el('q-modal')
      for (const error of (out.errors || []).filter((item) => item.field)) {
        const node = back?.querySelector(`[data-err="${error.field}"]`)
        if (node) node.textContent = `${error.code}：${error.message}`
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
    const card = modal.querySelector('.q-card')
    card.innerHTML = html([
      `<h2 id="q-action-title">确认：${esc(action.title)}</h2>`,
      '<div class="q-modal-body">',
      `<p class="q-degraded" data-confirm-message="1">${esc(action.confirm?.message || '确认执行这个动作？')}</p>`,
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

  function resultHtml(out, action) {
    const result = out.result && typeof out.result === 'object' ? out.result : null
    return `<div class="q-result ${out.ok ? 'ok' : 'bad'}" data-action-result="${attr(out.ok ? 'ok' : 'refused')}">`
      + `<b>${out.ok ? '已受理' : `被拒（${esc(out.code || 'refused')}）`}</b>`
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
    const restore = modalOpener
    modalOpener = null
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
    ...actions.map((action) => ({ kind: 'action', id: action.id,
      title: `${action.title}${action.permission === 'human-signature' ? ' ✍' : ''}`,
      hint: `${action.id} · ${(action.views || []).join('/')}${action.object_kind ? ` · ${action.object_kind}` : ''}`,
      run: () => openAction(action.id, null) }))]
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

  // ---------------------------------------------------------------- ① 通知中心（未读 / 标已读 / 按对象跳转 / 不刷屏）
  const LEVEL_RANK = { bad: 3, warn: 2, info: 1, ok: 1 }
  const LEVEL_TEXT = { bad: '失败/被拒', warn: '待办', info: '进展', ok: '进展' }
  /** 通知的**稳定 id**：同一件事在多次轮询里 id 不变 —— 已读状态才站得住（否则刷新就"又未读"）。 */
  const notifId = (item) => String(item.id || `${item.plugin_id || ''}:${item.title || ''}`)
  /**
   * 合并「插件通知源（每次渲染实时 poll）」+「本次会话的动作结果」，并**就地折叠重复项**：
   * 同一 id 只出一条（带 ×N）。急的排前面。这是"通知多时不刷屏"的第一道闸。
   */
  function notifList() {
    const seen = new Map()
    for (const item of [...state.notifications, ...state.results]) {
      const id = notifId(item)
      if (seen.has(id)) {
        const prev = seen.get(id)
        prev.count += 1
        if (item.level === 'bad') prev.level = 'bad'
        continue
      }
      seen.set(id, { ...item, id, count: 1, unread: !state.notif.read.has(id),
        rank: LEVEL_RANK[item.level] ?? 1 })
    }
    return [...seen.values()].sort((left, right) => (right.rank - left.rank)
      || String(right.at || '').localeCompare(String(left.at || '')))
  }
  /** 偏好过滤（静音某个插件 / 只看 warn 以上）—— 第二道闸：用户选择"哪些事值得打断我"。 */
  const notifVisible = () => {
    const minRank = LEVEL_RANK[state.notif.minLevel] ?? 1
    return notifList().filter((item) => !state.notif.muted.includes(item.plugin_id)
      && (LEVEL_RANK[item.level] ?? 1) >= minRank)
  }
  const unreadCount = () => notifVisible().filter((item) => item.unread).length
  function paintBadge() {
    const node = el('q-notify-count')
    if (!node) return
    const unread = unreadCount()
    const total = notifVisible().length
    node.textContent = String(unread)
    node.className = `q-badge ${unread ? 'warn' : ''}`
    node.title = `未读 ${unread} / 共 ${total} 条（点开是通知中心）`
  }
  function markRead(ids, value = true) {
    for (const id of ids) { if (value) state.notif.read.add(id); else state.notif.read.delete(id) }
    saveNotif()
    pushNotifState()          // 已读/未读一并落服务端（跨浏览器/跨设备仍在）
    paintBadge()
  }

  /** 通知中心：级别筛选 / 每插件静音 / 全部标已读 / 按对象跳转 / 分批展开（不再一次糊 200 条）。 */
  function openNotify() {
    const filter = state.notifFilter || 'all'
    const all = notifVisible()
    const counts = { all: all.length, unread: all.filter((item) => item.unread).length,
      todo: all.filter((item) => item.level === 'warn' || item.level === 'bad').length,
      bad: all.filter((item) => item.level === 'bad').length }
    const shown = all.filter((item) => (filter === 'unread' ? item.unread
      : (filter === 'todo' ? (item.level === 'warn' || item.level === 'bad')
        : (filter === 'bad' ? item.level === 'bad' : true))))
    // **协作筛选**（「我的 / 我指派的 / @我 / 我关注的」）：通知可以声明 `tags`（外壳只搬运字符串）。
    // 选中的标签存在本浏览器（`quotagent.filters.notifTag`）；它与上面的级别/未读筛选叠加。
    const tagCounts = {}
    for (const item of all) for (const tag of (item.tags || [])) tagCounts[tag] = (tagCounts[tag] || 0) + 1
    const tags = Object.keys(tagCounts).sort((left, right) => tagCounts[right] - tagCounts[left]
      || (left < right ? -1 : 1))
    const tag = tags.includes(filterOf('notifTag')) ? filterOf('notifTag') : ''
    const picked = tag === '' ? shown : shown.filter((item) => (item.tags || []).includes(tag))
    const cap = state.notifCap || 12
    const page = picked.slice(0, cap)
    const plugins = [...new Set(all.map((item) => item.plugin_id))].sort()
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
      + `<p class="q-src">动作结果、插件通知源与待人工门都排在这里（有界、不编造）；`
      + `同一件事只出一条（重复的合成 <code>×N</code>），批数多时先给最急的 ${cap} 条 —— 不一次糊满屏。</p>`
      + `<div class="q-notify-tools">`
      + `<span class="q-chip${filter === 'all' ? ' on' : ''}" data-notify-filter="all">全部 ${counts.all}</span>`
      + `<span class="q-chip${filter === 'unread' ? ' on' : ''}" data-notify-filter="unread">未读 ${counts.unread}</span>`
      + `<span class="q-chip${filter === 'todo' ? ' on' : ''}" data-notify-filter="todo">待我处理 ${counts.todo}</span>`
      + `<span class="q-chip${filter === 'bad' ? ' on' : ''}" data-notify-filter="bad">失败 ${counts.bad}</span>`
      + `<button data-notify-read-all="1">全部标已读（${counts.unread}）</button>`
      + `<label>只看 <select data-notify-level="1">${['info', 'warn', 'bad'].map((level) =>
        `<option value="${level}"${level === state.notif.minLevel ? ' selected' : ''}>`
        + `${esc(LEVEL_TEXT[level])}以上</option>`).join('')}</select></label>`
      + `<label>静音 <select data-notify-mute="1"><option value="">（不静音）</option>`
      + `${plugins.map((plugin) => `<option value="${attr(plugin)}"${state.notif.muted.includes(plugin)
        ? ' selected' : ''}>${esc(plugin)}</option>`).join('')}</select></label>`
      + `<span class="q-hint" data-notify-state-note="1">${esc(notifStateNote)}</span></div>`
      + (tags.length ? `<div class="q-notify-tools q-notify-tags" data-notify-tag-bar="1">`
        + `<span class="q-bucketbar-label">按协作筛选</span>`
        + `<span class="q-chip${tag === '' ? ' on' : ''}" data-notify-tag="">全部 ${all.length}</span>`
        + tags.map((label) => `<span class="q-chip${tag === label ? ' on' : ''}"`
          + ` data-notify-tag="${attr(label)}">${esc(label)} ${tagCounts[label]}</span>`).join('')
        + `<span class="q-hint">「我的」= 指派给我 / @我 / 我关注的；「我指派的」= 我交出去的活的进展</span></div>`
        : '')
      + `<ul>${rows.length ? rows.join('') : '<li class="q-empty">这一类里没有通知（不是坏了）</li>'}</ul>`
      + `${picked.length > page.length ? `<p class="q-hint"><button data-notify-more="1">`
        + `还有 ${picked.length - page.length} 条（点开继续）</button></p>` : ''}`
    openModal(body, 'q-notify')
    const modal = el('q-modal')
    modal.querySelectorAll('[data-notify-action]').forEach((node) => node.addEventListener('click', () => {
      const item = notifList().find((row) => row.id === node.closest('[data-notify]')?.dataset?.notify)
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
    modal.querySelector('[data-notify-read-all]')?.addEventListener('click', () => {
      markRead(picked.map((item) => item.id), true)
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
    modal.querySelector('[data-notify-more]')?.addEventListener('click', () => {
      state.notifCap = cap + 20
      openNotify()
    })
    // 打开即**把看到的这批标为已读**（与邮件客户端一致；想看未读的用「未读」筛选）
    if (counts.unread) markRead(page.filter((item) => item.unread).map((item) => item.id), true)
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
    if (plugin) { ev.preventDefault(); openAction(plugin.action, null) }
  })

  // ---------------------------------------------------------------- 加载
  async function loadAll(force) {
    state.banners = []          // 先清上一次的提示条（**再**装载注册面：它的失败提示不能被这行抹掉）
    if (force || !state.surface.actions.length) await loadSurface()
    const route = state.route
    const object = route.kind && route.id
    const [panels, notifications, status] = await Promise.all([
      object ? getJson(`/api/ui/object?view=${encodeURIComponent(route.view)}&kind=${encodeURIComponent(route.kind)}`
        + `&id=${encodeURIComponent(route.id)}`)
        : getJson(`/api/ui/panels?view=${encodeURIComponent(route.view)}`),
      getJson('/api/ui/notifications'),
      getJson('/api/ui/status'),
    ])
    if (object) {
      state.object = panels.ok ? panels : null
      state.panels = (panels.panels || []).filter((panel) => panel.visible !== false)
    } else {
      state.object = null
      state.panels = panels.panels || []
    }
    state.notifications = notifications.items || []
    state.status = status.items || []
    if (!panels.ok) banner('bad', object ? '对象页读取失败' : '面板读取失败', panels.reason || panels.code || '',
      panels.next_action || '点顶部「重载」重试')
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
  loadIdentity().then(() => loadNotifState()).then(() => paintBadge())
  /**
   * 通知轮询（15s）：只更**徽标**，并且**最多弹一条**汇总提示 —— 一次来 8 条也不刷屏。
   * 首次看到某条 id 时才提示（`state.seenNotifs` 是本次会话的内存集合）。
   */
  const seenNotifs = new Set()
  const pollNotify = async () => {
    const out = await getJson('/api/ui/notifications')
    if (!out.ok) return
    state.notifications = out.items || []
    const fresh = notifVisible().filter((item) => item.unread && !seenNotifs.has(item.id))
    for (const item of notifList()) seenNotifs.add(item.id)
    paintBadge()
    if (!fresh.length) return
    if (fresh.length === 1) {
      const one = fresh[0]
      toast(one.level === 'bad' ? 'bad' : (one.level === 'warn' ? 'warn' : 'ok'), `新通知：${one.title}`,
        [one.body, one.next_action].filter(Boolean).join(' · '))
      return
    }
    toast('warn', `新增 ${fresh.length} 条通知（不逐条弹）`, `最急的一条：${fresh[0].title}`
      + ` · 点顶栏「通知」看全部（${unreadCount()} 条未读）`)
  }
  setInterval(pollNotify, 15000)
  setTimeout(() => { for (const item of notifList()) seenNotifs.add(item.id) }, 1200)
})()
