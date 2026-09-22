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

  const state = {
    surface: { views: [], actions: [], panels: [], shortcuts: [], plugins: [] },
    route: { view: Q.route.view || 'home', kind: Q.route.kind || '', id: Q.route.id || '' },
    panels: [], object: null, notifications: [], status: [], plugins: [],
    edits: {}, selected: {}, selectedRows: {}, recent: [], readNotifs: new Set(), banners: [],
  }

  const html = (parts) => parts.join('')
  const badge = (text, level) => `<span class="q-badge ${level || ''}">${esc(text)}</span>`
  const attr = (value) => esc(value).replace(/'/g, '&#39;')

  /** 对象/视图的**深链**（可复制分享）：对象地址 = `/app/<view>/<kind>/<id>/`。 */
  const linkOf = (view, kind, id) => (kind && id ? `${API(`/app/${view}/${kind}/${id}/`)}` : API(`/app/${view}/`))
  const refLink = (ref) => (ref && ref.kind && ref.id ? linkOf(state.route.view, ref.kind, ref.id) : '')
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
    state.recent.unshift({ id: `act-${Date.now()}`, plugin_id: action?.plugin_id || '', level: result.ok ? 'ok' : 'bad',
      title: `${action ? action.title : '动作'} → ${result.ok ? 'ok' : result.code}`, body: result.reason || '',
      next_action: result.next_action || '', at: new Date().toISOString() })
    state.recent = state.recent.slice(0, 20)
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

  // ---------------------------------------------------------------- 路由（含对象深链）
  function parsePath(pathname) {
    const bits = String(pathname).replace(Q.prefix, '').split('/').filter(Boolean)
    if (bits[0] !== 'app') return { view: 'home', kind: '', id: '' }
    return { view: bits[1] || 'home', kind: bits[2] || '', id: bits[3] || '' }
  }
  const routeUrl = (route) => linkOf(route.view, route.kind, route.id)

  function navigate(view, kind, id, { replace = false } = {}) {
    const next = { view: view || 'home', kind: kind || '', id: id || '' }
    state.route = next; state.edits = {}; state.selected = {}; state.selectedRows = {}
    const url = routeUrl(next)
    if (replace) history.replaceState(next, '', url)
    else history.pushState(next, '', url)
    rememberRoute(next)
    renderChrome(); loadAll()
  }
  function rememberRoute(route) {
    try {
      const label = route.kind && route.id ? `${route.view} › ${route.kind} ${route.id}` : route.view
      localStorage.setItem(LAST_KEY, JSON.stringify({ ...route, label, at: new Date().toISOString() }))
    } catch (err) { /* 私密模式下 localStorage 不可用：不影响功能 */ }
  }
  const lastRoute = () => {
    try {
      const raw = localStorage.getItem(LAST_KEY)
      return raw ? JSON.parse(raw) : null
    } catch (err) { return null }
  }
  window.addEventListener('popstate', () => {
    state.route = parsePath(location.pathname)
    renderChrome(); loadAll()
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
    el('q-top').innerHTML = `<span class="q-brand">quotagent<small>GUI 应用外壳</small></span>`
      + `<nav class="q-nav" aria-label="视角">${nav}</nav>`
      + `<div class="q-tools">`
      + `<button data-open="palette" title="命令面板（Ctrl/Cmd+K）" aria-label="打开命令面板">⌘K 命令</button>`
      + `<button data-open="notify" title="通知中心（待办/结果/失败）" aria-label="打开通知中心">通知`
      + ` <span id="q-notify-count" class="q-badge">0</span></button>`
      + `<button data-open="plugins" title="插件与注册面（可热重载）" aria-label="打开插件面板">插件</button>`
      + `<button data-open="help" title="快捷键与上手指引（?）" aria-label="打开帮助">?</button>`
      + `<button id="q-reload" title="重载当前页（r）">重载</button></div>`
    el('q-top').querySelectorAll('[data-nav]').forEach((node) => node.addEventListener('click', (ev) => {
      ev.preventDefault(); navigate(node.dataset.nav, '', '')
    }))
    el('q-top').querySelector('[data-open="palette"]').addEventListener('click', openPalette)
    el('q-top').querySelector('[data-open="notify"]').addEventListener('click', openNotify)
    el('q-top').querySelector('[data-open="plugins"]').addEventListener('click', openPlugins)
    el('q-top').querySelector('[data-open="help"]').addEventListener('click', openHelp)
    el('q-reload').addEventListener('click', () => loadAll(true))
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

  function renderTable(panel, data) {
    // 插件可以按**动作 id 字符串**声明行内动作（`row_actions: ['quote.submit']`）—— 必须查表换成动作对象，
    // 否则渲染出来的是一颗空按钮（本轮人类走查实测：PO 追溯 / 人签提交 / 受理 全都点不到）。
    const asAction = (item) => (typeof item === 'string' ? actionOf(item) : item)
    const declared = data.actions || panel.actions || []
    const panelActions = declared.map(asAction).filter(Boolean)
    const rowDeclared = data.row_actions || declared
    const rowActions = rowDeclared.map((item) => {
      const found = asAction(item)
      if (found) return found
      return { id: String(item), title: `${item}（本页没有这个动作）`, missing: true }
    })
    const bulk = data.bulk ? actionOf(data.bulk) : null
    const columns = data.columns || []
    const rows = data.rows || []
    const editable = columns.some((column) => column.editable)
    const head = html([bulk ? '<th class="q-rowsel"><input type="checkbox" data-select-all aria-label="全选"></th>' : '',
      columns.map((column) => `<th>${esc(column.label || column.key)}</th>`).join(''), '<th>动作</th>'])
    if (!rows.length) {
      return stateBlock({ kind: 'empty', title: '没有行', reason: data.reason || 'no-rows',
        next_action: data.next_action || (data.note || '') })
    }
    const body = rows.map((row, index) => {
      // 行标识：优先行自带的 `id`，否则用第一列的值（**不猜业务字段名**：机制层不认识任何领域键）
      const rowKey = String(row.id ?? row[columns[0]?.key] ?? index)
      const cells = columns.map((column) => {
        const raw = row[column.key]
        const value = raw === null || raw === undefined ? '' : String(raw)
        if (column.editable) {
          return `<td><input data-edit="${attr(rowKey)}" data-field="${attr(column.key)}"`
            + ` data-type="${attr(column.type || 'text')}" value="${attr(value)}"`
            + ` placeholder="${attr(column.help || '')}" aria-label="${attr(column.label || column.key)}"></td>`
        }
        if (column.type === 'code') return `<td><code>${esc(value)}</code></td>`
        if (column.type === 'json') return `<td><code>${esc(value.slice(0, 220))}</code></td>`
        return `<td>${esc(value)}</td>`
      }).join('')
      const inline = rowActions.map((action) => {
        if (!action) return ''
        if (action.missing) {
          return `<button disabled title="注册面里没有这个动作（插件可能被卸载了）">`
            + `${esc(action.title)}</button>`
        }
        const confirm = action.confirm?.required ? ' data-confirm="1"' : ''
        return `<button data-row-action="${attr(action.id)}" data-row='${attr(JSON.stringify(row))}'${confirm}`
          + ` title="${attr(action.hint || '')}">`
          + `${esc(action.title)}${action.permission === 'human-signature' ? ' ✍' : ''}</button>`
      }).join(' ')
      return `<tr data-row-key="${attr(rowKey)}">`
        + (bulk ? `<td><input type="checkbox" data-select="${attr(rowKey)}" aria-label="选中这一行"></td>` : '')
        + `${cells}<td class="q-rowacts">${inline} ${rowRefCell(row)}</td></tr>`
    }).join('')
    const controls = html([bulk ? `<button data-bulk="${attr(bulk.id)}" class="primary">${esc(bulk.title)}`
      + `（已选 <span data-selected-count="1">0</span> 行）</button>` : '',
      editable && Object.keys(state.edits).length
        ? `<button data-submit-edits data-panel="${attr(panel.id)}" class="primary">`
          + `提交编辑（${Object.keys(state.edits).length} 行）</button>`
          + '<button data-cancel-edits>放弃改动</button>'
        : ''])
    return html([`<div class="q-scroll"><table class="q-table" data-panel-table="${attr(panel.id)}">`
      + `<caption class="q-caption">${esc(panel.title)}</caption>`
      + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      controls ? `<div class="q-actions">${controls}</div>` : ''])
  }

  function renderList(panel, data) {
    const items = data.items || []
    if (!items.length) {
      return stateBlock({ kind: 'empty', title: '没有条目', reason: data.reason || 'no-items',
        next_action: data.next_action || '' })
    }
    return `<ul class="q-list">${items.map((item) => {
      const action = item.action ? actionOf(item.action) : null
      const href = refLink(item.ref)
      return `<li data-level="${attr(item.level || 'info')}">`
        + `${item.level ? badge(item.level, item.level === 'bad' ? 'bad' : (item.level === 'warn' ? 'warn'
          : (item.level === 'ok' ? 'ok' : ''))) + ' ' : ''}`
        + `<span class="q-li-title">${esc(item.title || item.label || '')}</span>`
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
  function renderBody(kind, panel, data) {
    if (kind === 'table') return renderTable(panel, data)
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

  function panelSection(panel) {
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
    return `<section class="q-panel${wide ? ' wide' : ''}${panel.error ? ' q-err' : ''}"`
      + ` data-panel="${attr(panel.id)}" data-panel-plugin="${attr(panel.plugin_id)}">`
      + `<h3>${esc(panel.title)}${refHref ? ` <a class="q-deeplink" href="${attr(refHref)}"`
        + ` data-open-object="1" data-k="${attr(panelRef.kind)}" data-id="${attr(panelRef.id)}"`
        + ` title="打开 ${attr(refLabel(panelRef))} 的对象页（可复制分享）">打开对象 →</a>` : ''}</h3>`
      + `<details class="q-mech"><summary>机制（这块是谁注册的）</summary><div class="q-src">${mech}</div></details>`
      + `${panel.hint ? `<p class="q-hint">${esc(panel.hint)}</p>` : ''}${body}</section>`
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
    const wanted = items.filter((item) => item.level === 'warn' || item.level === 'bad')
    const headline = wanted.length
      ? `有 ${wanted.length} 件需要你处理${items.length > wanted.length ? `，另有 ${items.length - wanted.length} 条信息` : ''}`
      : (items.length ? `眼下没有卡住你的事（${items.length} 条信息）` : '还没有插件报告待办')
    // 急的排前面，但**信息类也要摆出来**：只显示急的会让"收到几条报价登记"这种线索消失
    const list = items.slice(0, 8)
    const rest = items.length - list.length
    return `<section class="q-todo" data-workbench="1" data-todo-count="${items.length}"
      data-todo-urgent="${wanted.length}">
  <div class="q-todo-head">
    <h2>你现在该做什么</h2>
    <p>${esc(headline)}${items.length && wanted.length ? `（另有 ${items.length - wanted.length} 条信息）` : ''}</p>
    <button class="q-link" data-open="palette">搜全部动作（Ctrl+K）</button>
  </div>
  ${list.length ? `<ul class="q-todo-list">${list.map(todoRow).join('')}</ul>`
    : stateBlock({ kind: 'empty', title: '没有待办（不是坏了）', reason: 'no-todo',
      hint: '工作台上的待办由插件注册；一个插件都没报待办时这里是空的。',
      next_action: '下一步：选一个视角（顶部导航）→ 用下面的常用动作开一单，或用 Ctrl+K 搜动作' })}
  ${rest > 0 ? `<p class="q-hint" data-todo-rest="${rest}">还有 ${rest} 条待办没摆在这里（按分类在各插件的面板里；`
    + `用 Ctrl+K 搜动作处理）。</p>` : ''}
  ${last && (last.kind || last.view) ? `<p class="q-hint" data-last-route="1">上次你在 <b>${esc(last.label)}</b>`
    + ` <button class="q-link" data-resume="1">继续 →</button></p>` : ''}
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
  function viewActions() {
    const view = state.route.view
    // 视图级动作（没有声明 `object_kind` 的）—— 对象页上的那批由 `objectActions()` 单列，这里不重复
    return state.surface.actions
      .filter((action) => (action.views || []).includes(view) && !action.inline)
      .filter((action) => !action.object_kind)
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
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><nav class="q-crumbs" aria-label="面包屑">${crumbs}</nav>`
      + `<button class="q-link" data-copy="${attr(linkOf(route.view, route.kind, route.id))}">复制这条深链</button></div>`,
      head,
      toolbarHtml(objectActions(), `${route.view}/${route.kind}`),
      `<div class="q-panels">${state.panels.map(panelSection).join('')}</div>`,
      toolbarHtml(viewActions(), `${route.view}（视图级动作）`) ? `<details class="q-mech q-more-actions">`
        + `<summary>本视图的其它动作（${viewActions().length} 个）</summary>`
        + toolbarHtml(viewActions(), `${route.view}（视图级动作）`) + '</details>' : '',
      `<div data-ui-blocks="${attr(`page.${route.view}`)}"></div>`])
    bindInteractions()
    loadBlocks()
  }

  function renderViewPage() {
    const actions = viewActions()
    const isHome = state.route.view === 'home'
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><h1>${esc(viewTitle(state.route.view))}</h1>`
      + `<p>${isHome ? '我今天要做什么' : `${state.panels.length} 块面板`} · 深链 `
      + `<button class="q-link" data-copy="${attr(linkOf(state.route.view))}">复制</button>`
      + `<code>${esc(linkOf(state.route.view))}</code></p></div>`,
      isHome ? workbenchHtml() : '',
      toolbarHtml(actions, state.route.view),
      `<div class="q-panels${isHome ? ' q-panels-home' : ''}">${state.panels.map(panelSection).join('')}</div>`,
      `<div data-ui-blocks="${attr(`page.${state.route.view}`)}"></div>`])
    bindInteractions()
    loadBlocks()
  }

  function renderMain() {
    if (state.route.kind && state.route.id) renderObjectPage()
    else renderViewPage()
    renderStatus()
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
    root.querySelectorAll('[data-resume]').forEach((node) => node.addEventListener('click', () => {
      const last = lastRoute()
      if (last) navigate(last.view, last.kind, last.id)
    }))
    root.querySelectorAll('[data-select-all]').forEach((node) => node.addEventListener('change', () => {
      root.querySelectorAll('[data-select]').forEach((box) => {
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
    root.querySelectorAll('[data-edit]').forEach((node) => node.addEventListener('input', () => {
      const key = node.closest('tr').dataset.rowKey
      state.edits[key] = state.edits[key] || {}
      const raw = node.dataset.type === 'number' ? Number(node.value) : node.value
      state.edits[key][node.dataset.field] = raw
      const holder = node.closest('[data-panel]')
      if (!holder) return
      let bar = holder.querySelector('[data-editbar]')
      if (!bar) {
        bar = document.createElement('div')
        bar.className = 'q-actions'
        bar.dataset.editbar = '1'
        holder.appendChild(bar)
      }
      bar.innerHTML = `<button class="primary" data-submit-edits>提交编辑（${Object.keys(state.edits).length} 行）</button>`
        + '<button data-cancel-edits>放弃改动</button>'
      bar.querySelector('[data-submit-edits]').addEventListener('click', () => submitEdits(holder))
      bar.querySelector('[data-cancel-edits]').addEventListener('click', () => {
        state.edits = {}; loadAll(true)
      })
    }))
    root.querySelectorAll('[data-submit-edits]').forEach((node) => node.addEventListener('click', () =>
      submitEdits(node.closest('[data-panel]'))))
    root.querySelectorAll('[data-cancel-edits]').forEach((node) => node.addEventListener('click', () => {
      state.edits = {}; state.selected = {}; state.selectedRows = {}; loadAll(true)
    }))
    root.querySelectorAll('[data-bulk]').forEach((node) => node.addEventListener('click', () => {
      const ids = Object.entries(state.selected).filter(([, on]) => on).map(([id]) => id)
      // 已经改了单元格但没勾行 ⇒ 直接提交这些改动（不逼用户先勾一遍；改了东西却只收到"没有选中"是最气人的）
      if (!ids.length && Object.keys(state.edits).length) {
        return submitEdits(node.closest('[data-panel]'))
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
    const count = Object.values(state.selected).filter(Boolean).length
    document.querySelectorAll('[data-selected-count]').forEach((node) => { node.textContent = String(count) })
  }
  function submitEdits(holder) {
    const panelId = holder?.dataset?.panel
    const panel = state.panels.find((item) => item.id === panelId) || state.panels.find((item) => item.data?.editable_action)
    const actionId = panel?.data?.editable_action
    const defaults = panel?.data?.editable_defaults || {}
    const rows = Object.entries(state.edits).map(([id, fields]) => ({ id, item_id: id, ...defaults, ...fields }))
    if (!rows.length) return toast('warn', '没有编辑内容', '改任意一个可编辑单元格后再提交')
    if (!actionId) return toast('bad', '这个面板没有声明可编辑动作', '可编辑表格要在 data.editable_action 里声明动作 id')
    openAction(actionId, { rows, unit_price_cents: rows[0].unit_price_cents, lead_time_days: rows[0].lead_time_days,
      rfq_id: defaults.rfq_id, prepared_by: defaults.prepared_by, currency: defaults.currency })
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
    const help = field.help ? `<span class="q-help">${esc(field.help)}</span>` : ''
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
    return `<div class="q-field"><label for="${attr(id)}">${esc(field.label)}${field.required ? ' *' : ''}</label>`
      + `<input id="${attr(id)}" name="${attr(field.name)}" type="text"${inputmode} value="${attr(v)}"`
      + ` data-field-type="${attr(field.type)}">${help}${hint}`
      + `<span class="q-fielderr" data-err="${attr(field.name)}" role="alert"></span></div>`
  }

  function validateInput(action, input) {
    const errors = []
    for (const field of action.input?.fields || []) {
      const value = input[field.name]
      const empty = value === undefined || value === null || String(value).trim() === ''
      if (field.required && empty) errors.push({ field: field.name, code: 'required', message: '必填' })
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
      for (const field of fields) if (field.from_route && !(field.name in (presets || {}))) {
        routePreset[field.name] = state.route.id
      }
    }
    const values = { ...routePreset, ...(presets || {}) }
    const body = html([
      `<h2 id="q-action-title">${esc(action.title)}</h2>`,
      `<p class="q-src">动作 <code>${esc(action.id)}</code> · 由 <code>${esc(action.plugin_id)}</code> 注册 · `
      + `权限 <code>${esc(action.permission)}</code>`
      + `${action.confirm?.required ? ' · 提交前会再确认一次' : ''}`
      + `${action.object_kind ? ` · 作用于 <code>${esc(action.object_kind)}</code>` : ''}</p>`,
      action.hint ? `<p class="q-hint">${esc(action.hint)}</p>` : '',
      action.permission === 'human-signature'
        ? `<p class="q-degraded">这一步是人工门：<code>signature</code> 里的署名会随请求送到插件自己的`
          + `服务端一半，再由 Python 侧唯一写者落账本（界面不是第二条事实写路径）。</p>` : '',
      fields.map((field) => fieldHtml(field, values[field.name])).join(''),
      (action.input?.bulk && values.ids ? `<p class="q-hint">批量：${esc(values.ids.length)} 行</p>` : ''),
      `<div class="q-actions"><button class="primary" data-run="1">${action.confirm?.required
        ? '下一步：确认' : '执行'}</button><button data-close="1">取消</button></div>`,
      '<div data-result="1"></div>'])
    openModal(body, 'q-action-modal')
    const modal = el('q-modal')
    modal.querySelector('[data-close]').addEventListener('click', closeModal)
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
        closeModal()
        await loadAll()
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
      `<p class="q-degraded" data-confirm-message="1">${esc(action.confirm?.message || '确认执行这个动作？')}</p>`,
      `<dl class="q-kv">${rows}</dl>`,
      action.permission === 'human-signature'
        ? `<p class="q-consequence">后果：产生对外义务；签名与载荷指纹会写进账本（不可撤销，只能再走一次变更）。`
          + `署名必须是你本人（<code>human:&lt;名字&gt;</code>）。</p>` : '',
      `<div class="q-actions"><button class="primary" data-yes="1">确认执行</button>`
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
    if (id) modal.dataset.kind = id
    modal.innerHTML = `<div class="q-card">${bodyHtml}</div>`
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal() })
  }
  function closeModal() { const modal = el('q-modal'); if (modal) modal.remove() }

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
    const draw = () => {
      list.innerHTML = filtered.map((item, index) =>
        `<li data-index="${index}" role="option" aria-selected="${index === cursor ? 'true' : 'false'}"`
        + ` class="${index === cursor ? 'active' : ''}"><b>${esc(item.title)}</b>`
        + `${item.hint ? ` <span class="q-tag">${esc(item.hint)}</span>` : ''}</li>`).join('')
        || '<li class="q-empty">没有匹配的条目 —— 换个词，或清空输入看全部</li>'
      list.querySelectorAll('li[data-index]').forEach((node) => node.addEventListener('click', () => {
        filtered[Number(node.dataset.index)].run(); closeModal()
      }))
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
      if (ev.key === 'Enter' && filtered[cursor]) { filtered[cursor].run(); closeModal() }
    })
    input.focus(); draw()
  }

  function openNotify() {
    const items = [...state.recent.map((item) => ({ ...item, level: item.level === 'ok' ? '' : 'bad' })),
      ...state.notifications]
    openModal(`<h2 id="q-action-title">通知中心</h2><p class="q-src">动作结果、插件通知源与待人工门都排在这里`
      + `（有界、不编造）· 每条可带一行内联动作</p>`
      + `<ul>${items.length ? items.map((item, index) => `<li data-notify="${index}">`
        + `<span class="q-notify-level">${badge(item.level || 'info',
          item.level === 'bad' ? 'bad' : (item.level === 'warn' ? 'warn' : ''))}</span>`
        + `<b>${esc(item.title)}</b>${item.body ? ` — ${esc(item.body)}` : ''}`
        + `${item.next_action ? `<div class="q-hint">${esc(item.next_action)}</div>` : ''}`
        + `${item.action && actionOf(item.action) ? `<div class="q-actions"><button`
          + ` data-notify-action="${attr(item.action)}">去处理</button></div>` : ''}`
        + `<div class="q-hint">${esc(item.plugin_id || '')} · ${esc(item.at || '')}</div></li>`).join('')
        : '<li class="q-empty">没有通知</li>'}</ul>`, 'q-notify')
    const modal = el('q-modal')
    modal.querySelectorAll('[data-notify-action]').forEach((node) => node.addEventListener('click', () => {
      openAction(node.dataset.notifyAction, null)
    }))
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
      <tr><td><code>g</code> + 视图首字母</td><td>转到视图（${viewsOf().map((view) =>
        `${esc(view.title)}：<code>g ${esc(view.id[0] ?? '')}</code>`).join(' · ')}）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>?</code></td><td>本帮助</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>r</code></td><td>重载当前页（含对象页）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Tab</code>/<code>Shift+Tab</code></td><td>在按钮与字段间移动（焦点有描边）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Esc</code></td><td>关闭弹层/右键菜单</td><td>—</td><td>外壳</td></tr>
      ${shortcuts}</tbody></table>
      <p class="q-hint">插件注册的快捷键与动作同生同死：插件卸载后这里的行与页面上的入口一起消失。</p>`, 'q-help')
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
    const count = state.notifications.length + state.recent.filter((item) => item.level === 'bad').length
    const node = el('q-notify-count')
    if (node) { node.textContent = String(count); node.className = `q-badge ${count ? 'warn' : ''}` }
    rememberRoute(state.route)
  }

  async function loadSurface() {
    const out = await getJson('/api/ui/surface')
    if (out.ok) state.surface = out
    else banner('bad', '注册面读取失败（界面是空壳）', out.reason || out.code || '',
      out.next_action || '确认服务在跑；然后点「重载」')
  }

  // 初始化：地址栏就是**唯一**的位置来源（刷新/分享/前进后退都靠它）
  state.route = parsePath(location.pathname)
  renderChrome(); loadAll(true)
  setInterval(() => { getJson('/api/ui/notifications').then((out) => {
    if (!out.ok) return
    state.notifications = out.items || []
    const count = state.notifications.length + state.recent.filter((item) => item.level === 'bad').length
    const node = el('q-notify-count')
    if (node) node.textContent = String(count)
  }) }, 15000)
})()
