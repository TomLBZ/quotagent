/* app.js —— quotagent GUI 外壳的客户端（**只来自本服务**：`/quotagent/assets/app.js`；无外网 CDN、无构建步骤）。
 *
 * 它是什么、不是什么：
 *   · 它是**机制**：多视图导航 / 工作台 / 命令面板 / 通知中心 / 状态栏 / 深链 / 快捷键 / 通用渲染器
 *     （table · form · list · kv · metrics · html）/ 动作表单与**客户端校验** / 可编辑表格与批量操作 /
 *     右键菜单 / 内联动作 / 结果提示条。它**不认识**任何业务名词：所有内容都来自注册面
 *     （`/quotagent/api/ui/surface` 与 `/quotagent/api/ui/panels`）。
 *   · 它**不写账本**：动作一律 POST 到 `/quotagent/api/action/<id>`，由插件自己的**服务端一半**执行，
 *     写动作最终只由 Python 侧唯一写者落账本（`docs/design/29-webui-gui-app.md` §3）。
 */
(() => {
  // 29 §1（用户 2026-09-22）：脚本只来自受信来源（本服务 /assets/**）。启动数据放**惰性 JSON 块**
  // （`<script type="application/json" id="q-boot">`，不可执行），页面里不写内联可执行脚本。
  const Q = (() => {
    const fb = { prefix: '/quotagent', route: { view: 'home', panel: '' } }
    try { return JSON.parse(document.getElementById('q-boot')?.textContent || '') || fb } catch (err) { return fb }
  })()
  const API = (path) => `${Q.prefix}${path}`
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const el = (id) => document.getElementById(id)
  const state = { surface: { views: [], actions: [], panels: [], shortcuts: [] }, view: Q.route.view || 'home',
    panel: Q.route.panel || '', panels: [], notifications: [], status: [], edits: {}, selected: {}, recent: [] }

  const html = (parts) => parts.join('')
  const badge = (text, level) => `<span class="q-badge ${level || ''}">${esc(text)}</span>`

  async function getJson(path) {
    const res = await fetch(API(path), { headers: { accept: 'application/json' } })
    try { return await res.json() } catch (err) { return { ok: false, code: 'bad-json', reason: String(err) } }
  }
  async function postJson(path, body) {
    const res = await fetch(API(path), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}) })
    try { return await res.json() } catch (err) { return { ok: false, code: 'bad-json', reason: String(err) } }
  }

  // ---------------------------------------------------------------- 通知 / 提示条
  function toast(kind, title, detail) {
    const box = el('q-toasts')
    const node = document.createElement('div')
    node.className = `q-toast ${kind}`
    node.innerHTML = `<b>${esc(title)}</b>${detail ? `<div>${esc(detail)}</div>` : ''}`
    box.appendChild(node)
    setTimeout(() => node.remove(), kind === 'bad' ? 12000 : 6000)
  }
  function notifyAction(result, action) {
    if (!result) return
    if (result.ok) toast('ok', `${action ? action.title : '动作'}：已受理`, result.next_action || result.code || '')
    else toast('bad', `${action ? action.title : '动作'}：被拒（${result.code || 'refused'}）`,
      [result.reason, result.next_action].filter(Boolean).join(' · '))
    state.recent.unshift({ id: `act-${Date.now()}`, plugin_id: action?.plugin_id || '', level: result.ok ? 'ok' : 'bad',
      title: `${action ? action.title : '动作'} → ${result.ok ? 'ok' : result.code}`, body: result.reason || '',
      next_action: result.next_action || '', at: new Date().toISOString() })
    state.recent = state.recent.slice(0, 20)
  }

  // ---------------------------------------------------------------- 视图骨架
  function viewsOf() {
    const declared = state.surface.views && state.surface.views.length ? state.surface.views
      : [{ id: 'home', title: '工作台' }, { id: 'contractor', title: '承包商' }, { id: 'supplier', title: '供应商' }]
    return declared
  }
  function renderChrome() {
    const nav = viewsOf().map((view) => `<a href="${API(`/app/${view.id}/`)}" data-nav="${esc(view.id)}"`
      + `${view.id === state.view ? ' class="current"' : ''}>${esc(view.title)}</a>`).join('')
    el('q-top').innerHTML = `<span class="q-brand">quotagent<small>GUI 应用外壳（机制 / 功能由插件注册）</small></span>`
      + `<nav class="q-nav">${nav}</nav>`
      + `<div class="q-tools">`
      + `<button data-open="palette" title="命令面板（Ctrl/Cmd+K）">⌘K 命令</button>`
      + `<button data-open="notify" title="通知中心">通知 <span id="q-notify-count" class="q-badge">0</span></button>`
      + `<button data-open="help" title="快捷键（?）">?</button>`
      + `<button id="q-reload" title="重载本视图">重载</button></div>`
    el('q-top').querySelectorAll('[data-nav]').forEach((node) => node.addEventListener('click', (ev) => {
      ev.preventDefault(); navigate(node.dataset.nav, '')
    }))
    el('q-top').querySelector('[data-open="palette"]').addEventListener('click', openPalette)
    el('q-top').querySelector('[data-open="notify"]').addEventListener('click', openNotify)
    el('q-top').querySelector('[data-open="help"]').addEventListener('click', openHelp)
    el('q-reload').addEventListener('click', () => loadAll(true))
  }

  function navigate(view, panel) {
    state.view = view; state.panel = panel || ''
    state.edits = {}; state.selected = {}
    const url = `${API(`/app/${view}/`)}${panel ? `${panel}/` : ''}`
    history.pushState({ view, panel }, '', url)
    renderChrome(); loadAll()
  }
  window.addEventListener('popstate', () => {
    const bits = location.pathname.replace(Q.prefix, '').split('/').filter(Boolean)
    state.view = bits[1] || 'home'; state.panel = bits[2] || ''
    renderChrome(); loadAll()
  })

  // ---------------------------------------------------------------- 面板渲染（通用形状）
  function renderTable(panel, data) {
    const panelActions = (data.actions || panel.actions || []).map(actionOf).filter(Boolean)
    const bulk = data.bulk ? actionOf(data.bulk) : null
    const columns = data.columns || []
    const rows = data.rows || []
    const head = html([bulk ? `<th class="q-rowsel"><input type="checkbox" data-select-all></th>` : '',
      columns.map((column) => `<th>${esc(column.label || column.key)}</th>`).join(''),
      '<th>动作</th>'])
    const body = rows.map((row, index) => {
      // 行标识：优先行自带的 `id`，否则用第一列的值（**不猜业务字段名**：机制层不认识任何领域键）
      const rowKey = String(row.id ?? row[columns[0]?.key] ?? index)
      const cells = columns.map((column) => {
        const raw = row[column.key]
        const value = raw === null || raw === undefined ? '' : String(raw)
        if (column.editable) {
          return `<td><input data-edit="${esc(rowKey)}" data-field="${esc(column.key)}"`
            + ` data-type="${esc(column.type || 'text')}" value="${esc(value)}" placeholder="${esc(column.help || '')}"></td>`
        }
        if (column.type === 'code') return `<td><code>${esc(value)}</code></td>`
        if (column.type === 'json') return `<td><code>${esc(value.slice(0, 220))}</code></td>`
        return `<td>${esc(value)}</td>`
      }).join('')
      const inline = (data.row_actions || panelActions).map((action) => {
        if (!action) return ''
        const confirm = action.confirm?.required ? ' data-confirm="1"' : ''
        return `<button data-row-action="${esc(action.id)}" data-row='${esc(JSON.stringify(row))}'${confirm}>`
          + `${esc(action.title)}</button>`
      }).join(' ')
      return `<tr data-row-key="${esc(rowKey)}">`
        + (bulk ? `<td><input type="checkbox" data-select="${esc(rowKey)}"></td>` : '')
        + `${cells}<td>${inline}</td></tr>`
    }).join('')
    const controls = html([bulk ? `<button data-bulk="${esc(bulk.id)}" class="primary">${esc(bulk.title)}</button>` : '',
      Object.keys(state.edits).length ? `<button data-submit-edits data-panel="${esc(panel.id)}" class="primary">提交编辑</button>` : ''])
    return html([`<div class="q-scroll"><table class="q-table" data-panel-table="${esc(panel.id)}"><thead><tr>${head}</tr></thead>`
      + `<tbody>${body || `<tr><td colspan="${columns.length + (bulk ? 1 : 0) + 1}" class="q-empty">没有数据</td></tr>`}</tbody></table></div>`,
      controls ? `<div class="q-actions">${controls}</div>` : ''])
  }

  function renderData(panel, data) {
    const kind = data.kind || panel.panel_kind
    if (data.degraded) {
      return html([`<p class="q-degraded">降级（不冒充健康）：<code>${esc(data.reason || 'degraded')}</code>`
        + `${data.next_action ? ` → ${esc(data.next_action)}` : ''}</p>`,
        kind === 'metrics' ? '' : renderBody(kind, panel, data)])
    }
    return renderBody(kind, panel, data)
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
    if (kind === 'list') {
      if (!(data.items || []).length) return '<p class="q-empty">没有条目</p>'
      return `<ul class="q-list">${(data.items || []).map((item) =>
        `<li>${item.level ? badge(item.level, item.level) + ' ' : ''}${esc(item.title || item.label || '')}`
        + `${item.body ? ` —— ${esc(item.body)}` : ''}`
        + `${item.next_action ? `<div class="q-hint"><code>${esc(item.next_action)}</code></div>` : ''}</li>`).join('')}</ul>`
    }
    if (kind === 'form') {
      return `<p class="q-hint">${esc(data.note || '')}</p>`
    }
    if (kind === 'html') return data.html || ''
    return `<p class="q-empty">不认识的面板形状：<code>${esc(kind)}</code></p>`
  }

  function renderPanels() {
    const slots = state.panels.filter((panel) => (panel.placement || 'main') === 'main')
    const side = state.panels.filter((panel) => (panel.placement || 'main') !== 'main')
    const section = (panel) => {
      const visible = panel.visible !== false
      if (!visible) return ''
      const body = panel.error
        ? `<pre>${esc(panel.error.reason || '')}</pre>`
        : renderData(panel, panel.data || {})
      // 表格形状的面板占满整行（多列挤在窄格里读不了）；其余按网格排
      const wide = panel.wide || (panel.data || {}).kind === 'table' || panel.panel_kind === 'table'
      return `<section class="q-panel${wide ? ' wide' : ''}${panel.error ? ' q-err' : ''}" `
        + `data-panel="${esc(panel.id)}" data-panel-plugin="${esc(panel.plugin_id)}">`
        + `<h3>${esc(panel.title)}</h3>`
        + `<div class="q-src">由 <code>${esc(panel.plugin_id)}</code> 注册 · 形状 <code>${esc(panel.panel_kind)}</code>`
        + `${panel.order !== undefined ? ` · order ${esc(panel.order)}` : ''}</div>`
        + `${panel.hint ? `<p class="q-hint">${esc(panel.hint)}</p>` : ''}${body}</section>`
    }
    const viewTitle = (viewsOf().find((view) => view.id === state.view) || { title: state.view }).title
    const actions = state.surface.actions.filter((action) => (action.views || []).includes(state.view))
      .filter((action) => !action.inline)
    const toolbar = actions.length ? `<div class="q-actions" data-toolbar="${esc(state.view)}">`
      + actions.map((action) => `<button data-action="${esc(action.id)}"${action.confirm?.required ? ' data-confirm="1"' : ''}`
        + ` title="${esc(action.hint || '')}">${esc(action.title)}${action.permission === 'human-signature' ? ' ✍' : ''}</button>`)
        .join('') + '</div>' : ''
    el('q-view').innerHTML = html([
      `<div class="q-viewhead"><h1>${esc(viewTitle)}</h1>`
      + `<p>${state.view === 'home' ? '我今天要做什么' : `视图 <code>${esc(state.view)}</code>`}`
      + ` · 深链 <code>${API(`/app/${state.view}/`)}</code></p></div>`,
      toolbar,
      `<div class="q-panels">${slots.map(section).join('')}${side.map(section).join('')}</div>`,
      `<div data-ui-blocks="${esc(`page.${state.view}`)}"></div>`])
    bindPanelInteractions()
    loadBlocks()
  }

  function bindPanelInteractions() {
    const root = el('q-view')
    root.querySelectorAll('[data-action]').forEach((node) => node.addEventListener('click', () =>
      openAction(node.dataset.action, null)))
    root.querySelectorAll('[data-row-action]').forEach((node) => node.addEventListener('click', () => {
      let row = {}
      try { row = JSON.parse(node.dataset.row) } catch (err) { row = {} }
      openAction(node.dataset.rowAction, row)
    }))
    root.querySelectorAll('[data-select-all]').forEach((node) => node.addEventListener('change', () => {
      root.querySelectorAll('[data-select]').forEach((box) => {
        box.checked = node.checked
        state.selected[box.dataset.select] = node.checked
      })
    }))
    root.querySelectorAll('[data-select]').forEach((node) => node.addEventListener('change', () => {
      state.selected[node.dataset.select] = node.checked
      if (node.checked) state.selectedRows = { ...(state.selectedRows || {}), [node.dataset.select]:
        JSON.parse(node.closest('tr').querySelector('[data-row-action]')?.dataset.row || '{}') }
    }))
    root.querySelectorAll('[data-edit]').forEach((node) => node.addEventListener('input', () => {
      const key = node.closest('tr').dataset.rowKey
      state.edits[key] = state.edits[key] || {}
      const raw = node.dataset.type === 'number' ? Number(node.value) : node.value
      state.edits[key][node.dataset.field] = raw
      const panel = state.panels.find((item) => item.id === node.closest('[data-panel]')?.dataset.panel)
      const action = actionOf(panel?.data?.editable_action)
      const bar = root.querySelector('[data-editbar]')
      if (bar) return
      const holder = node.closest('[data-panel]')
      if (!holder) return
      const div = document.createElement('div')
      div.className = 'q-actions'
      div.dataset.editbar = '1'
      div.innerHTML = `<button data-submit-edits class="primary">提交编辑（${esc(action ? action.title : '批量')}）</button>`
        + `<span class="q-hint">改动：${Object.keys(state.edits).length} 行</span>`
      holder.appendChild(div)
      bindPanelInteractions()
    }))
    root.querySelectorAll('[data-submit-edits]').forEach((node) => node.addEventListener('click', () => {
      const panel = state.panels.find((item) => item.data && item.data.editable_action)
      const actionId = panel?.data?.editable_action
      const defaults = panel?.data?.editable_defaults || {}
      const rows = Object.entries(state.edits).map(([id, fields]) => ({ id, item_id: id, ...defaults, ...fields }))
      if (!rows.length) return toast('warn', '没有编辑内容', '改任意一个可编辑单元格后再提交')
      if (!actionId) return toast('bad', '这个面板没有声明可编辑动作', '可编辑表格要在 data.editable_action 里声明动作 id')
      openAction(actionId, { rows, unit_price_cents: rows[0].unit_price_cents, lead_time_days: rows[0].lead_time_days,
        rfq_id: defaults.rfq_id, prepared_by: defaults.prepared_by, currency: defaults.currency })
    }))
    root.querySelectorAll('[data-bulk]').forEach((node) => node.addEventListener('click', () => {
      const ids = Object.entries(state.selected).filter(([, on]) => on).map(([id]) => id)
      if (!ids.length) return toast('warn', '没有选中任何行', '先在表格左侧勾选')
      const rows = ids.map((id) => (state.selectedRows || {})[id] || { id })
      openAction(node.dataset.bulk, { ids, rows: rows.filter(Boolean) })
    }))
    root.querySelectorAll('tr[data-row-key]').forEach((node) => node.addEventListener('contextmenu', (ev) => {
      const actions = state.surface.actions.filter((action) => action.context_menu
        && (action.views || []).includes(state.view))
      if (!actions.length) return
      ev.preventDefault()
      openContextMenu(ev.clientX, ev.clientY, actions, () => {
        let row = {}
        try { row = JSON.parse(node.querySelector('[data-row-action]')?.dataset.row || '{}') } catch (err) { row = {} }
        return row
      })
    }))
  }

  function openContextMenu(x, y, actions, rowOf) {
    closeContextMenu()
    const box = document.createElement('div')
    box.id = 'q-ctx'
    box.style.left = `${x}px`; box.style.top = `${y}px`
    box.innerHTML = actions.map((action) => `<button data-ctx="${esc(action.id)}">${esc(action.title)}</button>`).join('')
    document.body.appendChild(box)
    box.querySelectorAll('[data-ctx]').forEach((node) => node.addEventListener('click', () => {
      closeContextMenu(); openAction(node.dataset.ctx, rowOf())
    }))
    setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0)
  }
  function closeContextMenu() { document.getElementById('q-ctx')?.remove() }

  async function loadBlocks() {
    const slot = `page.${state.view}`
    const out = await getJson(`/api/ui/blocks?slot=${encodeURIComponent(slot)}`)
    const holder = el('q-view').querySelector('[data-ui-blocks]')
    if (!holder) return
    if (out.ok && out.html) holder.innerHTML = `<div class="q-src">插件注册面（<code>${esc(slot)}</code>，`
      + `${out.blocks} 块 · webui 只知道槽位与排序）</div>${out.html}`
    else holder.innerHTML = ''
  }

  // ---------------------------------------------------------------- 动作表单（含客户端校验）
  const actionOf = (id) => state.surface.actions.find((action) => action.id === id) || null

  function fieldHtml(field, value) {
    const v = value === undefined || value === null ? (field.default ?? '') : value
    const help = field.help ? `<span class="q-help">${esc(field.help)}</span>` : ''
    if (field.type === 'textarea') {
      return `<div class="q-field"><label>${esc(field.label)}${field.required ? ' *' : ''}</label>`
        + `<textarea name="${esc(field.name)}" rows="4">${esc(v)}</textarea>${help}`
        + `<span class="q-fielderr" data-err="${esc(field.name)}"></span></div>`
    }
    if (field.type === 'select') {
      return `<div class="q-field"><label>${esc(field.label)}${field.required ? ' *' : ''}</label>`
        + `<select name="${esc(field.name)}">${(field.options || []).map((option) =>
          `<option value="${esc(option)}"${String(option) === String(v) ? ' selected' : ''}>${esc(option)}</option>`)
          .join('')}</select>${help}<span class="q-fielderr" data-err="${esc(field.name)}"></span></div>`
    }
    if (field.type === 'checkbox') {
      return `<div class="q-field"><label><input type="checkbox" name="${esc(field.name)}"${v ? ' checked' : ''}> `
        + `${esc(field.label)}</label>${help}<span class="q-fielderr" data-err="${esc(field.name)}"></span></div>`
    }
    const type = field.type === 'number' ? 'text' : 'text'
    const inputmode = field.type === 'number' ? ' inputmode="decimal"' : ''
    return `<div class="q-field"><label>${esc(field.label)}${field.required ? ' *' : ''}</label>`
      + `<input name="${esc(field.name)}" type="${type}"${inputmode} value="${esc(v)}" `
      + `data-field-type="${esc(field.type)}">${help}<span class="q-fielderr" data-err="${esc(field.name)}"></span></div>`
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
        errors.push({ field: field.name, code: 'pattern', message: '形状不符合规则' })
      }
      if (field.type === 'signature' && !String(value).startsWith('human:')) {
        errors.push({ field: field.name, code: 'human-required', message: '署名必须以 human: 开头（agent 不得代签）' })
      }
    }
    return errors
  }

  function openAction(id, presets) {
    const action = actionOf(id)
    if (!action) return toast('bad', '动作不存在', `注册面里没有 ${id}（插件卸载后它的入口会消失）`)
    const fields = action.input?.fields || []
    const values = { ...(presets || {}) }
    const body = html([
      `<h2>${esc(action.title)}</h2>`,
      `<p class="q-src">动作 <code>${esc(action.id)}</code> · 由 <code>${esc(action.plugin_id)}</code> 注册 · `
      + `权限 <code>${esc(action.permission)}</code>`
      + `${action.confirm?.required ? ` · 确认策略 <code>需要确认</code>` : ''}</p>`,
      action.hint ? `<p class="q-hint">${esc(action.hint)}</p>` : '',
      action.permission === 'human-signature'
        ? `<p class="q-degraded">这一步是**人工门**：写在 <code>signature</code> 里的署名会随请求送到插件自己的`
          + `服务端一半，再由 Python 侧唯一写者落账本（界面不是第二条事实写路径）。</p>` : '',
      fields.map((field) => fieldHtml(field, values[field.name])).join(''),
      (action.input?.bulk && values.ids ? `<p class="q-hint">批量：${esc(values.ids.length)} 行</p>` : ''),
      `<div class="q-actions"><button class="primary" data-run="1">执行</button>`
      + `<button data-close="1">取消</button></div>`,
      `<div data-result="1"></div>`])
    openModal(body, 'q-action-modal')
    const modal = el('q-modal')
    modal.querySelector('[data-close]').addEventListener('click', closeModal)
    modal.querySelector('[data-run]').addEventListener('click', async () => {
      const input = {}
      for (const field of fields) {
        const node = modal.querySelector(`[name="${field.name}"]`)
        if (!node) continue
        input[field.name] = field.type === 'checkbox' ? node.checked
          : (field.type === 'number' ? Number(node.value) : node.value)
      }
      for (const key of Object.keys(values)) {
        if (!(key in input)) input[key] = values[key]
      }
      if (values.rows && !input.rows) input.rows = values.rows
      if (values.ids && !input.ids) input.ids = values.ids
      const errors = validateInput(action, input)
      modal.querySelectorAll('[data-err]').forEach((node) => { node.textContent = '' })
      if (errors.length) {
        for (const error of errors) {
          const node = modal.querySelector(`[data-err="${error.field}"]`)
          if (node) node.textContent = `${error.code}：${error.message}`
        }
        if (!errors.every((error) => modal.querySelector(`[data-err="${error.field}"]`))) {
          toast('bad', '入参不合法', errors.map((error) => `${error.field}:${error.message}`).join('；'))
        }
        return
      }
      if (action.confirm?.required) {
        const ok = window.confirm(action.confirm.message || '确认执行这个动作？')
        if (!ok) return
        input.confirm_ack = '1'
      }
      const out = await postJson(`/api/action/${encodeURIComponent(action.id)}`, { view: state.view, input })
      notifyAction(out, action)
      closeModal()
      await loadAll()
    })
  }

  function openModal(bodyHtml, id) {
    let modal = el('q-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'q-modal'
      document.body.appendChild(modal)
    }
    modal.className = ''
    if (id) modal.dataset.kind = id
    modal.innerHTML = `<div class="q-card">${bodyHtml}</div>`
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal() })
  }
  function closeModal() { const modal = el('q-modal'); if (modal) modal.remove() }

  // ---------------------------------------------------------------- 命令面板 / 通知 / 帮助
  function openPalette() {
    const actions = state.surface.actions || []
    const views = viewsOf()
    const items = [...views.map((view) => ({ kind: 'view', id: `view.${view.id}`, title: `转到 ${view.title}`,
      run: () => navigate(view.id, '') })),
    ...actions.map((action) => ({ kind: 'action', id: action.id,
      title: `${action.title}${action.permission === 'human-signature' ? ' ✍' : ''}`,
      hint: `${action.id} · ${(action.views || []).join('/')}`, run: () => openAction(action.id, null) }))]
    openModal(`<h2>命令面板</h2><p class="q-src">动作来自注册面（插件注册什么，这里就有什么）</p>`
      + `<input id="q-palette-input" placeholder="输入动作名或视图名…" autocomplete="off">`
      + `<ul id="q-palette-list"></ul>`, 'q-palette')
    const modal = el('q-modal')
    const input = modal.querySelector('#q-palette-input')
    const list = modal.querySelector('#q-palette-list')
    let filtered = items
    let cursor = 0
    const draw = () => {
      list.innerHTML = filtered.map((item, index) =>
        `<li data-index="${index}" class="${index === cursor ? 'active' : ''}">`
        + `<b>${esc(item.title)}</b>${item.hint ? ` <span class="q-tag">${esc(item.hint)}</span>` : ''}</li>`).join('')
        || '<li class="q-empty">没有匹配的条目</li>'
      list.querySelectorAll('li[data-index]').forEach((node) => node.addEventListener('click', () => {
        filtered[Number(node.dataset.index)].run(); closeModal()
      }))
    }
    const filter = () => {
      const needle = input.value.trim().toLowerCase()
      filtered = items.filter((item) => item.title.toLowerCase().includes(needle)
        || item.id.toLowerCase().includes(needle))
      cursor = 0; draw()
    }
    input.addEventListener('input', filter)
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { cursor = Math.min(cursor + 1, filtered.length - 1); draw() }
      if (ev.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw() }
      if (ev.key === 'Enter' && filtered[cursor]) { filtered[cursor].run(); closeModal() }
    })
    input.focus(); draw()
  }

  function openNotify() {
    const items = [...state.recent.map((item) => ({ ...item, level: item.level === 'ok' ? '' : 'bad' })),
      ...state.notifications]
    openModal(`<h2>通知中心</h2><p class="q-src">动作结果、插件通知源与待人工门都排在这里（有界、不编造）</p>`
      + `<ul>${items.length ? items.map((item) => `<li>`
        + `<span class="q-notify-level">${badge(item.level || 'info', item.level === 'bad' ? 'bad' : (item.level === 'warn' ? 'warn' : ''))}</span>`
        + `<b>${esc(item.title)}</b>${item.body ? ` — ${esc(item.body)}` : ''}`
        + `${item.next_action ? `<div class="q-hint"><code>${esc(item.next_action)}</code></div>` : ''}`
        + `<div class="q-hint">${esc(item.plugin_id || '')} · ${esc(item.at || '')}</div></li>`).join('')
        : '<li class="q-empty">没有通知</li>'}</ul>`, 'q-notify')
  }

  function openHelp() {
    const shortcuts = (state.surface.shortcuts || []).map((item) =>
      `<tr><td><code>${esc(item.keys)}</code></td><td>${esc(item.title)}</td><td><code>${esc(item.action)}</code></td>`
      + `<td><code>${esc(item.plugin_id)}</code></td></tr>`).join('')
    openModal(`<h2>快捷键与用法</h2>
      <table class="q-table"><thead><tr><th>键</th><th>做什么</th><th>动作</th><th>注册者</th></tr></thead><tbody>
      <tr><td><code>mod+k</code> / <code>ctrl+k</code></td><td>命令面板</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>g</code> + 视图首字母</td><td>转到视图（${viewsOf().map((v) => `${esc(v.title)}：<code>g ${esc(v.id[0] ?? '')}</code>`).join(' · ')}）</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>?</code></td><td>本帮助</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>r</code></td><td>重载当前视图</td><td>—</td><td>外壳</td></tr>
      <tr><td><code>Esc</code></td><td>关闭弹层</td><td>—</td><td>外壳</td></tr>
      ${shortcuts}</tbody></table>
      <p class="q-hint">插件注册的快捷键与动作**同生同死**：插件卸载后这里的行与页面上的入口一起消失。</p>`, 'q-help')
  }

  // ---------------------------------------------------------------- 键盘
  let sequence = ''
  document.addEventListener('keydown', (ev) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    if (ev.key === 'Escape') { closeModal(); closeContextMenu(); return }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openPalette(); return }
    if (typing) return
    if (ev.key === '?') { openHelp(); return }
    if (ev.key === 'r') { loadAll(true); return }
    const key = ev.key.toLowerCase()
    if (key === 'g') { sequence = 'g'; setTimeout(() => { sequence = '' }, 1200); return }
    if (sequence === 'g') {
      sequence = ''
      const target = { h: 'home', c: 'contractor', s: 'supplier' }[key]
      if (target) { navigate(target, ''); return }
    }
    const plugin = (state.surface.shortcuts || []).find((item) => item.keys === key)
    if (plugin) { ev.preventDefault(); openAction(plugin.action, null) }
  })

  // ---------------------------------------------------------------- 加载 / 轮询
  async function loadAll(force) {
    if (force || !state.surface.actions.length) await loadSurface()
    const [panels, notifications, status] = await Promise.all([
      getJson(`/api/ui/panels?view=${encodeURIComponent(state.view)}`),
      getJson('/api/ui/notifications'),
      getJson('/api/ui/status'),
    ])
    state.panels = panels.panels || []
    state.notifications = notifications.items || []
    state.status = status.items || []
    renderPanels()
    renderStatus()
    const count = state.notifications.length + state.recent.filter((item) => item.level === 'bad').length
    const node = el('q-notify-count')
    if (node) { node.textContent = String(count); node.className = `q-badge ${count ? 'warn' : ''}` }
  }

  async function loadSurface() {
    const out = await getJson('/api/ui/surface')
    if (out.ok) state.surface = out
    else toast('bad', '注册面读取失败', out.reason || out.code || '')
  }

  function renderStatus() {
    const items = state.status.map((item) =>
      `<span>${esc(item.title)}：${esc(item.text)}${item.level && item.level !== 'ok'
        ? ` <span class="q-badge ${item.level === 'bad' ? 'bad' : 'warn'}">${esc(item.level)}</span>` : ''}</span>`)
    el('q-status').innerHTML = html([...items, '<span class="q-spacer"></span>',
      `<span>动作 ${state.surface.actions.length} · 面板 ${state.surface.panels.length} · 快捷键 ${state.surface.shortcuts.length}</span>`,
      `<span>深链 <code>${esc(API(`/app/${state.view}/`))}</code></span>`])
  }

  renderChrome()
  loadAll(true)
  setInterval(() => { getJson('/api/ui/notifications').then((out) => {
    if (out.ok) {
      state.notifications = out.items || []
      const node = el('q-notify-count')
      if (node) node.textContent = String(state.notifications.length)
    }
  }) }, 15000)
})()
