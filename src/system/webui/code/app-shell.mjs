/**
 * app-shell —— GUI **应用外壳**的机制层（0 业务语义）：多视图/导航/命令面板/通知中心/状态栏/深链/快捷键，
 * 以及把"界面事件 → 动作"接起来的**动作总线**（`docs/design/29-webui-gui-app.md` §3）。
 *
 * 本文件能做的、不能做的（判据在这一行里，不靠评审）：
 *   · **能**：装配外壳与渲染器、把注册面的贡献列出来、把动作请求交给插件自己的**服务端一半**、
 *     把 0600 待办件落盘、spawn Python 侧的唯一写者/只读工具、按槽位嵌入插件自己注册的区块；
 *   · **不能**：写账本。外壳不 import 任何账本写入 API，也不认识 `Ledger` 这个字；一切落账本只能由
 *     Python 侧唯一写者做（`host` 只提供 `stage()` 落待办件与 `runPython()` 跑写者这两件事）。
 *   · 零业务语义：本文件不出现任何插件 id、领域名词、字段绑定；功能全部来自注册面
 *     （`src/system/webui/code/ui-surface.mjs` 的贡献 + 各插件 `code/ui.mjs` 的注册）。
 *   · 一切注册可撤销（`AGENTS.md` 规则 1）：`unload()` 撤掉一个插件的**全部**贡献（视图/面板/动作/快捷键/
 *     通知源/状态项/校验器 + 它注册的旧槽位区块），页面其余部分不动。
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, chmodSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { createUiSurface, PANEL_KINDS } from './ui-surface.mjs'

export const SURFACE_VERSION = 1
/** 外壳自己的键盘快捷键（机制；插件注册的在注册面里）。 */
export const SHELL_SHORTCUTS = ['mod+k 命令面板', 'g h/g c/g s 切换视图', '? 帮助', 'r 重载', 'Esc 关闭']
/** 待办件目录名（宿主只落 0600 待办件；落账本归 Python 侧）。 */
export const PENDING_SCHEMA = 'quotagent/pending/v1'
const MAX_BODY_BYTES = 262144
const PYTHON_TIMEOUT_MS = 30000
const DEFAULT_PYTHON = process.env.QUOTAGENT_PYTHON || 'python3'

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** 深排序（**所有层级**）：与 Python 侧 `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)`
 *  逐字节一致 —— 待办件的 `payload_sha256` 由宿主算、由 Python 侧重算复核，两边必须同构。 */
const deepSort = (value) => {
  if (Array.isArray(value)) return value.map(deepSort)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = deepSort(value[key])
    return out
  }
  return value
}
const canonical = (record) => {
  const payload = {}
  for (const key of Object.keys(record).sort()) {
    if (['payload_sha256', 'bytes', 'submitted_at'].includes(key)) continue
    payload[key] = deepSort(record[key])
  }
  return JSON.stringify(payload)
}
const digestOf = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
const flat = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)

/** 读体（有界）：超上限**如实拒**，不截断成另一份正文。 */
function readBody(req, done) {
  let data = ''
  let over = false
  req.on('data', (chunk) => {
    if (data.length + chunk.length > MAX_BODY_BYTES) over = true
    else if (!over) data += chunk
  })
  req.on('end', () => done(over ? null : data))
  req.on('error', () => done(null))
}

/**
 * 建外壳。
 * @param {object} options
 * @param {string} options.root 仓库根（用来找插件贡献与调用 Python 侧工具）
 * @param {string} options.prefix 路由前缀
 * @param {string[]} options.views 视图 id（shell 用 `home` + 配置里的视图）
 * @param {object} options.config webui 配置（ui_shared / rfq_delivery / ledger_* 等）
 * @param {(view: string) => object[]} options.rowsOf 本视角**公开投影后**的行（宿主只给白名单行）
 * @param {object} options.slots 旧的槽位注册表（`ui-slot.mjs`；用来嵌入插件注册的区块与撤销）
 * @param {(msg: string) => void} options.log 日志（stderr）
 */
export function createAppShell({ root, prefix, views, config, rowsOf, publicRowsOf, slots, services, log }) {
  const surface = createUiSurface({ slots: slots?.slots?.() ?? [], views })
  const sharedDir = resolve(root, String(config.ui_shared ?? 'tmp/ui-shared'))
  const pythonBin = DEFAULT_PYTHON
  const contributions = new Map()        // plugin_id → {module, entries: [{kind,id}], error}
  const actionLog = []                   // 机制层动作流水（通知中心用；有界）

  const say = (msg) => { if (typeof log === 'function') log(`[webui-shell] ${msg}`) }

  // ------------------------------------------------------------------ 机制：进程与代价可控的 IO
  /** 跑 Python 侧工具（唯一写者或只读工具）：stdout **最后一行**必须是 JSON；rc≠0 也如实回报。 */
  const runPython = (toolPath, args = [], { timeoutMs = PYTHON_TIMEOUT_MS } = {}) => {
    const file = resolve(root, toolPath)
    if (!existsSync(file)) {
      return { ok: false, code: 'tool-missing', reason: `找不到工具：${toolPath}`,
        next_action: '先确认该插件已安装（工具路径写错时如实报，不猜）' }
    }
    const started = Date.now()
    const proc = spawnSync(pythonBin, [file, ...args], { cwd: root, encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    const stdout = proc.stdout ?? ''
    const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '')
    let parsed = null
    if (lines.length) {
      try { parsed = JSON.parse(lines[lines.length - 1]) } catch (err) { parsed = null }
    }
    return { ok: proc.status === 0 && parsed !== null, rc: proc.status, tool: toolPath, args,
      json: parsed, stdout: flat(stdout, 4000), stderr: flat(proc.stderr, 1200), ms: Date.now() - started,
      reason: proc.error ? String(proc.error).slice(0, 200) : (parsed === null ? '工具没有输出 JSON' : '') }
  }

  /** 落一条 0600 待办件（**宿主唯一的写面**；账本零新增，落账本归 Python 侧）。 */
  const stage = (kind, record, { name: wantedName } = {}) => {
    const dir = join(sharedDir, kind)
    const payload = { schema: PENDING_SCHEMA, kind, ...record, submitted_at: '' }
    payload.bytes = Buffer.byteLength(String(payload.note ?? ''), 'utf8')
    payload.payload_sha256 = digestOf(canonical(payload))
    // 文件名：默认 `<kind>-<sha12>.json`；插件可以给 `{name}`（**它自己的唯一写者按文件名收件**，
    // 例如 `qd-<view>-<12hex>.json`）—— 名字由插件定，机制不猜。
    const name = String(wantedName || `${kind}-${payload.payload_sha256.slice(7, 19)}.json`)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const target = join(dir, name)
      if (existsSync(target)) {
        return { ok: true, duplicate: true, kind, file: relative(root, target), path: target, name,
          record: payload }
      }
      const tmp = join(dir, `.${name}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(payload, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, target)
      return { ok: true, duplicate: false, kind, file: relative(root, target), path: target, name,
        record: payload }
    } catch (err) {
      return { ok: false, code: 'pending-write-failed', reason: flat(err),
        next_action: '先修待办件目录权限（宿主只落 0600 待办件，不改账本）' }
    }
  }

  const readJson = (path) => {
    try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')) } catch (err) { return null }
  }
  const sharedFile = (name) => join(sharedDir, name)

  /** 机制级的**内存便签**（`plugin_id` 作用域）：贡献可以记住"这次用哪组参数"，面板再读回来。
   *  它是纯机制（键值），随进程生灭、不落盘、不进账本；卸载插件时清空它的键。 */
  const notes = new Map()
  const noteStore = {
    get: (pluginId, key, fallback = null) => (notes.get(`${pluginId}\u0000${key}`) ?? fallback),
    set: (pluginId, key, value) => { notes.set(`${pluginId}\u0000${key}`, value); return value },
    drop: (pluginId) => { for (const key of [...notes.keys()]) if (key.startsWith(`${pluginId}\u0000`)) notes.delete(key) },
  }

  /** 插件贡献拿到的**机制上下文**：只有通用能力，没有任何业务语义。 */
  const host = {
    prefix, config, root, views, sharedDir, now: () => new Date().toISOString(),
    rows: (view) => (typeof rowsOf === 'function' ? rowsOf(view) : []),
    publicRows: (view) => (typeof publicRowsOf === 'function' ? publicRowsOf(view) : []),
    runPython, stage, readJson, sharedFile,
    /** 宿主自己注入的**服务句柄**（机制：按名字取；不知道任何服务的业务含义）。 */
    service: (name) => (services && typeof services === 'object' ? services[name] : undefined) ?? null,
    services: () => Object.keys(services ?? {}),
    note: noteStore,
    log: say,
  }

  // ------------------------------------------------------------------ 插件贡献装载（发现式：任何插件放 code/ui.mjs 就会被装载）
  const scanContributions = () => {
    const found = []
    for (const layer of ['system', 'domain']) {
      const base = join(root, 'src', layer)
      if (!existsSync(base)) continue
      for (const name of readdirSync(base).sort()) {
        const file = join(base, name, 'code', 'ui.mjs')
        if (existsSync(file)) found.push({ plugin_id: `${layer}/${name}`, file })
      }
    }
    const userspace = join(root, 'src', 'userspace')
    if (existsSync(userspace)) {
      for (const ns of readdirSync(userspace).sort()) {
        const nsDir = join(userspace, ns)
        let entries = []
        try { entries = readdirSync(nsDir).sort() } catch (err) { continue }
        if (!statSync(nsDir).isDirectory()) continue
        for (const name of entries) {
          const file = join(nsDir, name, 'code', 'ui.mjs')
          if (existsSync(file)) found.push({ plugin_id: `userspace/${ns}/${name}`, file })
        }
      }
    }
    return found
  }

  const loadContributions = async () => {
    const summary = []
    for (const item of scanContributions()) {
      try {
        const module = await import(`${item.file}?v=${SURFACE_VERSION}`)
        const register = module.register ?? module.default
        if (typeof register !== 'function') {
          contributions.set(item.plugin_id, { error: 'no-register-function', entries: [] })
          summary.push({ plugin_id: item.plugin_id, ok: false, code: 'no-register-function',
            next_action: 'code/ui.mjs 必须导出 `register(surface, host)`' })
          continue
        }
        const verdicts = await register(surface, host, item.plugin_id)
        const refused = (Array.isArray(verdicts) ? verdicts : []).filter((row) => row && row.ok === false)
        const registered = (Array.isArray(verdicts) ? verdicts : []).filter((row) => row && row.ok === true)
        contributions.set(item.plugin_id, { module, entries: registered.map((row) => ({ kind: row.kind, id: row.id })),
          refused: refused.map((row) => ({ code: row.code, reason: row.reason })) })
        summary.push({ plugin_id: item.plugin_id, ok: refused.length === 0, registered: registered.length,
          refused: refused.map((row) => ({ code: row.code, reason: flat(row.reason) })) })
      } catch (err) {
        contributions.set(item.plugin_id, { error: flat(err), entries: [] })
        summary.push({ plugin_id: item.plugin_id, ok: false, code: 'register-failed', reason: flat(err),
          next_action: '修该插件 code/ui.mjs 的 register（装载失败不静默吞）' })
        say(`插件贡献装载失败 ${item.plugin_id}：${flat(err)}`)
      }
    }
    return summary
  }

  // ------------------------------------------------------------------ 渲染：面板 / 通知 / 状态
  const panelCtx = (view) => ({ view, host, now: host.now(), rows: host.rows(view),
    panels: surface.panelsOf(view).map((panel) => panel.id),
    actions: surface.byKind('action').map((action) => action.id) })

  const panelsOf = (view) => {
    const ctx = panelCtx(view)
    return surface.panelsOf(view).map((panel) => {
      const base = { id: panel.id, title: panel.title, plugin_id: panel.plugin_id, order: panel.order,
        panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, hint: panel.hint,
        wide: panel.placement === 'wide' }
      try {
        if (panel.when && panel.when(ctx) !== true) return { ...base, visible: false, data: null }
      } catch (err) {
        return { ...base, visible: true, error: { code: 'when-failed', reason: flat(err) },
          next_action: '修面板的 when（可见性条件抛错时不渲染该面板，但如实报错）' }
      }
      try {
        const data = panel.data(ctx)
        if (!data || typeof data !== 'object') {
          return { ...base, visible: true, error: { code: 'invalid-data', reason: 'data() 没有返回对象' } }
        }
        const kind = data.kind ?? panel.panel_kind
        if (!PANEL_KINDS.includes(kind)) {
          return { ...base, visible: true, error: { code: 'unknown-panel-kind', reason: `kind=${kind}` } }
        }
        return { ...base, visible: true, degraded: data.degraded === true, reason: data.reason ?? null,
          data: { ...data, kind, plugin_id: panel.plugin_id, panel_id: panel.id } }
      } catch (err) {
        return { ...base, visible: true, error: { code: 'data-failed', reason: flat(err) },
          next_action: '修面板的 data()（抛错不静默吞：这块不渲染，页面其余部分照常）' }
      }
    }).sort((left, right) => (left.order - right.order) || (left.id < right.id ? -1 : 1))
  }

  const notifications = () => {
    const items = []
    for (const source of surface.byKind('notification-source')) {
      try {
        const out = source.poll(panelCtx(source.view || 'home')) || []
        for (const item of Array.isArray(out) ? out : []) {
          items.push({ id: String(item.id ?? `${source.plugin_id}:${items.length}`), level: String(item.level ?? 'info'),
            title: String(item.title ?? ''), body: String(item.body ?? ''),
            next_action: String(item.next_action ?? ''), ref: item.ref ?? null, at: String(item.at ?? ''),
            plugin_id: source.plugin_id })
        }
      } catch (err) {
        items.push({ id: `${source.plugin_id}:poll-failed`, level: 'bad', title: '通知源读取失败',
          body: flat(err), next_action: '修该通知源的 poll()', plugin_id: source.plugin_id,
          at: host.now() })
      }
    }
    for (const entry of actionLog.slice(0, 20)) items.push(entry)
    return items.slice(0, 200)
  }

  const statusItems = () => {
    const out = []
    for (const item of surface.byKind('status-item')) {
      try {
        const read = item.read(panelCtx('home')) || {}
        out.push({ id: item.id, title: item.title, text: String(read.text ?? ''), level: String(read.level ?? 'ok'),
          next_action: String(read.next_action ?? ''), plugin_id: item.plugin_id })
      } catch (err) {
        out.push({ id: item.id, title: item.title, text: `读取失败：${flat(err)}`, level: 'bad',
          plugin_id: item.plugin_id })
      }
    }
    out.push({ id: 'surface.counts', title: '注册面', level: 'ok', plugin_id: 'system/webui',
      text: `面板 ${surface.byKind('panel').length} · 动作 ${surface.byKind('action').length} · `
        + `快捷键 ${surface.shortcuts().length} · 通知源 ${surface.byKind('notification-source').length}` })
    return out
  }

  // ------------------------------------------------------------------ 动作：校验 → 插件的服务端一半
  /** 字段级校验（与服务端声明同源；客户端只是提前一步给同样的错误）。 */
  const validateInput = (action, input) => {
    const errors = []
    for (const field of action.input.fields) {
      const value = input[field.name]
      const empty = value === undefined || value === null || String(value).trim() === ''
      if (field.required && empty) {
        errors.push({ field: field.name, code: 'required', message: '必填',
          next_action: `填 ${field.label}` })
        continue
      }
      if (empty) continue
      if (field.type === 'number' && !Number.isFinite(Number(value))) {
        errors.push({ field: field.name, code: 'not-a-number', message: '必须是数', next_action: '给一个数' })
      }
      if (field.min !== null && Number(value) < Number(field.min)) {
        errors.push({ field: field.name, code: 'below-min', message: `不得小于 ${field.min}`,
          next_action: `改到 ≥ ${field.min}` })
      }
      if (field.max !== null && Number(value) > Number(field.max)) {
        errors.push({ field: field.name, code: 'above-max', message: `不得大于 ${field.max}`,
          next_action: `改到 ≤ ${field.max}` })
      }
      if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
        errors.push({ field: field.name, code: 'pattern', message: '形状不符合规则',
          next_action: `按声明的形状重填（pattern=${field.pattern}）` })
      }
      if (field.type === 'signature' && !String(value).startsWith('human:')) {
        errors.push({ field: field.name, code: 'human-required', message: '署名必须以 human: 开头',
          next_action: 'agent 不得代签：写 human:<你的名字>' })
      }
    }
    for (const validator of surface.validatorsFor(action.id)) {
      try {
        const out = validator.validate(input) || []
        for (const item of Array.isArray(out) ? out : []) {
          errors.push({ field: String(item.field ?? ''), code: String(item.code ?? 'validator'),
            message: String(item.message ?? ''), plugin_id: validator.plugin_id,
            next_action: String(item.next_action ?? '按上面的原因改入参') })
        }
      } catch (err) {
        errors.push({ field: '', code: 'validator-failed', plugin_id: validator.plugin_id,
          message: flat(err), next_action: '修该校验器（校验器抛错时动作不执行）' })
      }
    }
    return errors
  }

  const runAction = async (actionId, request) => {
    const action = surface.findAction(actionId)
    if (!action) {
      return { ok: false, code: 'unknown-action', reason: `注册面里没有动作 ${actionId}`,
        next_action: '插件卸载后它的动作会消失：刷新页面看当前可用的动作（命令面板 ⌘K）' }
    }
    const input = request?.input && typeof request.input === 'object' ? request.input : {}
    const errors = validateInput(action, input)
    if (errors.length) return { ok: false, code: 'validation-failed', action: action.id, errors,
      next_action: '按 errors 里每个字段的 next_action 改后重试（本次什么都没执行）' }
    if (action.confirm.required && request?.input?.confirm_ack !== '1') {
      return { ok: false, code: 'confirm-required', action: action.id,
        next_action: `这个动作需要显式确认：${action.confirm.message}` }
    }
    const ctx = { view: String(request?.view ?? action.view), input, host, now: host.now(),
      action: { id: action.id, title: action.title, plugin_id: action.plugin_id, permission: action.permission } }
    let out = null
    try {
      out = await action.server(ctx, input)
    } catch (err) {
      out = { ok: false, code: 'action-failed', reason: flat(err), next_action: '修该动作的服务端一半（不静默吞）' }
    }
    const result = out && typeof out === 'object' ? out : { ok: false, code: 'invalid-result',
      reason: '服务端一半没有返回对象', next_action: '返回 {ok, code, reason, next_action, result}' }
    const entry = { id: `act-${Date.now()}-${action.id}`, level: result.ok ? 'ok' : 'bad',
      title: `${action.title} → ${result.ok ? 'ok' : (result.code ?? 'refused')}`,
      body: flat(result.reason ?? result.note ?? ''), next_action: flat(result.next_action ?? ''),
      ref: result.result ?? null, at: host.now(), plugin_id: action.plugin_id, action: action.id }
    actionLog.unshift(entry)
    if (actionLog.length > 100) actionLog.length = 100
    return { ok: result.ok === true, action: action.id, code: result.code ?? null, reason: result.reason ?? null,
      next_action: result.next_action ?? null, result: result.result ?? null, note: result.note ?? null,
      errors: result.errors ?? null, refresh: result.refresh ?? ['panels', 'notifications', 'status'] }
  }

  // ------------------------------------------------------------------ 撤销（卸载一个插件的全部贡献）
  const unload = (pluginId) => {
    const removed = surface.disposePlugin(pluginId)
    const slotRows = []
    if (slots && typeof slots.describe === 'function') {
      for (const block of slots.describe().blocks) {
        if (block.plugin_id !== pluginId) continue
        slots.unregister(pluginId, block.slot)
        slotRows.push({ kind: 'slot-block', id: `${block.slot}:${block.plugin_id}`, title: block.title })
      }
    }
    contributions.set(pluginId, { entries: [], unloaded: true })
    noteStore.drop(pluginId)
    const payload = { ok: true, plugin_id: pluginId, removed: [...removed.removed, ...slotRows],
      count: removed.count + slotRows.length,
      next_action: '该插件的视图/面板/动作/快捷键/通知源/状态项与它注册的区块都已撤销；'
        + '页面其余部分逐字节不变（可重新装载它恢复）' }
    say(`卸载贡献：${pluginId}（移除 ${payload.count} 项）`)
    return payload
  }

  // ------------------------------------------------------------------ 外壳 HTML（单页应用；脚本只来自本服务）
  const shellHtml = (route) => {
    const title = route.view === 'home' ? '工作台' : route.view
    const initial = JSON.stringify({ prefix, route: { view: route.view, panel: route.panel ?? '' } })
      .replace(/</g, '\\u003c')
    // **无脚本回退导航**：脚本没跑起来（或禁用 JS / 爬虫 / 屏幕阅读器）时，人也能到达每一道与上手页 ——
    // 这是可访问性与渐进增强，不是"第二套页面"：正式界面仍由客户端按注册面渲染。
    const fallback = ['', 'contractor/', 'supplier/', 'ops/', 'admin/', 'start/', 'overview/']
      .map((path) => `<a href="${prefix}/${path}">${esc({ '': '总览（旧页）', 'contractor/': '承包商视角',
        'supplier/': '供应商视角', 'ops/': '运维视角', 'admin/': '系统管理', 'start/': '上手（token／配置放哪里？）',
        'overview/': '账本总览' }[path] ?? path)}</a>`).join(' · ')
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.page_title ?? 'quotagent')} · ${esc(title)}</title>
<link rel="stylesheet" href="${prefix}/assets/app.css">
<script type="application/json" id="q-boot">${initial}</script>
</head><body>
<div id="q-app">
  <header class="q-top" id="q-top"></header>
  <main class="q-main" id="q-view"></main>
  <footer class="q-status" id="q-status"></footer>
</div>
<div class="q-toasts" id="q-toasts"></div>
<noscript><p>本页需要 JavaScript 才能渲染注册面（面板/动作/通知）。无脚本回退导航：</p></noscript>
<nav class="q-fallback" data-shell-fallback="1">${fallback}</nav>
<script src="${prefix}/assets/app.js" defer></script>
</body></html>`
  }

  const asset = (name) => {
    const file = join(root, 'src', 'system', 'webui', 'code', 'assets', name)
    try { return { ok: true, body: readFileSync(file, 'utf8') } } catch (err) {
      return { ok: false, code: 'asset-missing', reason: flat(err) }
    }
  }

  const surfaceJson = () => ({
    ok: true, service: 'quotagent-webui', surface_version: SURFACE_VERSION,
    mechanism: '扩展注册面：视图/面板/区块 + 交互（字段/表格/快捷键/右键/内联）+ 动作与命令（含服务端一半）'
      + ' + 通知与状态；外壳只做机制、不懂业务语义',
    prefix,
    views: [...views].map((view) => ({ id: view,
      title: config.view_titles?.[view] ?? ({ home: '工作台', contractor: '承包商', supplier: '供应商',
        ops: '运维', admin: '系统管理' }[view] ?? view),
      external: ['ops', 'admin'].includes(view) ? `${prefix}/${view}/` : null })),
    registries: surface.snapshot(),
    actions: surface.byKind('action').map((action) => ({ id: action.id, title: action.title,
      views: action.views, group: action.group, icon: action.icon, placement: action.placement,
      inline: action.inline, context_menu: action.context_menu, shortcut: action.shortcut,
      input: action.input, permission: action.permission, confirm: action.confirm, hint: action.hint,
      plugin_id: action.plugin_id })),
    panels: surface.byKind('panel').map((panel) => ({ id: panel.id, title: panel.title, view: panel.view,
      panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, order: panel.order,
      plugin_id: panel.plugin_id })),
    shortcuts: surface.shortcuts().map((item) => ({ keys: item.keys, action: item.action, title: item.title,
      plugin_id: item.plugin_id })),
    shell_shortcuts: SHELL_SHORTCUTS,
    plugins: [...contributions.entries()].map(([plugin_id, info]) => ({ plugin_id,
      entries: info.entries ?? [], error: info.error ?? null, unloaded: info.unloaded === true })),
    next_action: '动作一律 POST ' + `${prefix}/api/action/<id>` + '（含 JSON 入参）；'
      + '写动作最终由插件自己的服务端一半落 0600 待办件、再由 Python 侧唯一写者落账本',
  })

  return { surface, host, loadContributions, unload, runAction, panelsOf, notifications, statusItems,
    surfaceJson, shellHtml, asset, scanContributions, runPython, stage, get contributions() { return contributions } }
}
