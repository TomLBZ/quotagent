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
import { createCollabStore } from './collab.mjs'
import { createCollabSurface, COLLAB_PLUGIN_ID } from './collab-ui.mjs'
import { createPeopleStore } from './people.mjs'
import { createPeopleSurface, PEOPLE_PLUGIN_ID } from './people-ui.mjs'

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
 * @param {string} [options.sessionsFile] 身份会话文件（**只读**：协作面用它算"本侧同事名单"）——见 `collab.mjs`
 * @param {string[]} [options.sides] 允许的侧（由身份面传入；外壳不硬编码任何侧名）
 */
export function createAppShell({ root, prefix, views, config, rowsOf, publicRowsOf, slots, services, log,
  sessionsFile = '', sides = [] }) {
  const surface = createUiSurface({ slots: slots?.slots?.() ?? [], views })
  const sharedDir = resolve(root, String(config.ui_shared ?? 'tmp/ui-shared'))
  /**
   * **同侧人类之间的协作**（指派/转交、关注、评论与 `@同事`、活动流、已读）：它是**机制**，不是业务语义 ——
   * 对象类由插件声明（`collab-ui.mjs` 按 `surface.objectKindsFor(view)` 自动挂协作面），本文件不认识任何
   * 对象类。数据落 `<ui_shared>/collab/<side>.json`（0600），**不写账本**（理由见 `collab.mjs` 文件头：
   * 写进账本会破坏审计语义，并让"人对界面的协同痕迹"变成模型可见输入）。
   */
  const collab = createCollabStore({ root, sharedDir, sessionsFile, sides, log: (msg) => log?.(msg) })
  /**
   * **人员名册与角色**（同侧成员 / 角色 / 直属关系 / 按角色限动作）：同样是**机制**，不是业务语义 ——
   * 它只存"谁在册、什么角色、额度多少、谁归谁"，并回答"这次请求能不能被执行"（只收紧、不放开）。
   * 数据落 `<ui_shared>/people/roster.json`（0600，按侧隔离），**不写账本**（理由见 `people.mjs` 文件头：
   * 名册/额度是**可改的配置**，写进账本会改变审计语义并变成模型可见输入）。
   * 它可以被后补配置（会话文件 ⇒ "今天谁登录过"；合法侧 ⇒ 名册按侧分片）。
   */
  const people = createPeopleStore({ root, sharedDir, sessionsFile, sides, log: (msg) => log?.(msg) })
  const pythonBin = DEFAULT_PYTHON
  const contributions = new Map()        // plugin_id → {module, file, entries: [{kind,id}], error}
  const actionLog = []                   // 机制层动作流水（通知中心用；有界）
  /**
   * **只读调用缓存**（机制：同一组参数的只读工具调用在一次渲染内只 spawn 一次）+ 计数（前后可对账）。
   * 来源优先级：环境变量 `QUOTAGENT_UI_PYTHON_CACHE_MS`（用来做"开/关缓存"的对照实测）> 配置
   * `python_cache_ms` > 默认 3000ms。**0 = 关闭合并**（只读调用一律真起进程；对照用，也可在资源紧张时关掉）。
   */
  const envCacheMs = Number(process.env.QUOTAGENT_UI_PYTHON_CACHE_MS ?? '')
  const readCacheTtlMs = Number.isInteger(envCacheMs) && String(process.env.QUOTAGENT_UI_PYTHON_CACHE_MS ?? '') !== ''
    ? envCacheMs
    : (Number.isInteger(config.python_cache_ms) ? config.python_cache_ms : 3000)
  const readCacheOn = readCacheTtlMs > 0
  const readCache = new Map()            // key → {at, result}
  const ioStats = { spawns: 0, read_spawns: 0, read_hits: 0, cache_clears: 0 }
  const say = (msg) => { if (typeof log === 'function') log(`[webui-shell] ${msg}`) }

  // ------------------------------------------------------------------ 机制：进程与代价可控的 IO
  /**
   * 跑 Python 侧工具（唯一写者或只读工具）：stdout **最后一行**必须是 JSON；rc≠0 也如实回报。
   *
   * `{read: true}`（插件声明"这一调用只读"）⇒ 同一组 `(工具, 参数)` 在 `python_cache_ms` 窗口内**只 spawn 一次**
   * （同一个进程里三块面板读同一个只读工具时，第三次不会再起第三个进程）；写入类调用**不缓存**，
   * 且任何一次 `stage()`/动作执行都会**清空缓存**（界面上的下一步不会读到旧值）。
   */
  const runPython = (toolPath, args = [], { timeoutMs = PYTHON_TIMEOUT_MS, read = false } = {}) => {
    const file = resolve(root, toolPath)
    if (!existsSync(file)) {
      return { ok: false, code: 'tool-missing', reason: `找不到工具：${toolPath}`,
        next_action: '先确认该插件已安装（工具路径写错时如实报，不猜）' }
    }
    const cacheKey = `${toolPath}\u0000${args.join('\u0000')}`
    if (read && readCacheOn) {
      const hit = readCache.get(cacheKey)
      if (hit && Date.now() - hit.at <= readCacheTtlMs) {
        ioStats.read_hits += 1
        return { ...hit.result, cached: true, cache_age_ms: Date.now() - hit.at }
      }
      const memo = renderScopes[renderScopes.length - 1]
      if (memo && memo.has(cacheKey)) {
        const shared = memo.get(cacheKey)
        ioStats.read_hits += 1
        return { ...shared, cached: true, cache_age_ms: 0, same_render: true }
      }
    }
    const started = Date.now()
    const proc = spawnSync(pythonBin, [file, ...args], { cwd: root, encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    ioStats.spawns += 1
    if (read) ioStats.read_spawns += 1
    const stdout = proc.stdout ?? ''
    const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '')
    let parsed = null
    if (lines.length) {
      try { parsed = JSON.parse(lines[lines.length - 1]) } catch (err) { parsed = null }
    }
    const result = { ok: proc.status === 0 && parsed !== null, rc: proc.status, tool: toolPath, args,
      json: parsed, stdout: flat(stdout, 4000), stderr: flat(proc.stderr, 1200), ms: Date.now() - started,
      reason: proc.error ? String(proc.error).slice(0, 200) : (parsed === null ? '工具没有输出 JSON' : '') }
    if (read && result.ok && readCacheOn) {
      readCache.set(cacheKey, { at: Date.now(), result })
      const memo = renderScopes[renderScopes.length - 1]
      if (memo) memo.set(cacheKey, result)
    }
    return result
  }

  /** 清空只读缓存（任何一次可能改变事实的动作前后都调它：界面绝不读旧值）。 */
  const clearReadCache = () => {
    if (readCache.size === 0) return
    readCache.clear()
    ioStats.cache_clears += 1
  }

  /** 一次渲染的作用域（面板/状态/通知在同一批里读同一个只读工具 ⇒ 只起一个进程）。 */
  const renderScopes = []
  const withRenderScope = (fn) => {
    const memo = new Map()
    renderScopes.push(memo)
    try { return fn() } finally {
      renderScopes.pop()
      for (const [key, result] of memo) {
        if (result.ok) readCache.set(key, { at: Date.now(), result })
      }
    }
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
      clearReadCache()          // 落了一条待办件 ⇒ 只读缓存作废（下一次渲染读到的是新状态）
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
    /** **同侧协作**句柄（指派/转交、关注、评论与 `@同事`、活动流、已读）：机制，不认识对象类。
     *  插件可以拿它把协作挂到自己的对象上；`side`/`actor` 必须来自 `ctx.identity`（会话），不由表单给。 */
    collab,
    /** **人员名册与角色**句柄（同侧成员 / 角色 / 直属关系 / 按角色限动作）：机制，不认识业务对象。
     *  `collab` 从这里取"同事是谁"（不再靠"登录过的人"）；动作总线用它判"这次请求能不能被执行"。 */
    people,
    /** 宿主自己注入的**服务句柄**（机制：按名字取；不知道任何服务的业务含义）。 */
    service: (name) => (services && typeof services === 'object' ? services[name] : undefined) ?? null,
    services: () => Object.keys(services ?? {}),
    note: noteStore,
    log: say,
  }

  /**
   * 协作面（`collab-ui.mjs`）：把协作挂到**插件声明的对象类**上（视图/对象类都由插件声明，外壳不认识）。
   * 注册面在装载/卸载后会变 ⇒ `syncCollab()` 在每次变动后重新对账（新对象类出现就挂上，消失就撤销）。
   */
  const collabSurface = createCollabSurface({ surface, host, views: views.filter((view) => view !== 'home'),
    log: (msg) => say(msg) })
  /**
   * 名册面（`people-ui.mjs`）：把**人员名册与角色**搬上界面（面板 + 维护动作 + 状态读数）。与协作面一样是
   * 外壳自带的机制贡献：视图列表由装配方给（身份面建好之后才知道），对象类与它无关（名册不看对象）。
   */
  const peopleSurface = createPeopleSurface({ surface, host, views: views.filter((view) => view !== 'home'),
    log: (msg) => say(msg) })
  const syncPeople = () => {
    const out = peopleSurface.sync()
    if (out && out.panels !== undefined) {
      say(`名册面：视图 ${out.views.join('/') || '（无）'} · 面板 ${out.panels} 组`)
    }
    return out
  }
  const syncCollab = () => {
    const out = collabSurface.sync()
    if (out && out.object_panels !== undefined) {
      say(`协作面：视图 ${out.views.join('/') || '（无）'} · 对象类 ${out.kinds.join('/') || '（暂无）'}`
        + ` · 对象面板 ${out.object_panels} 组`)
    }
    return out
  }

  /**
   * 装配期后补：协作面需要**身份面**的两样东西（会话文件 ⇒ 本侧同事名单；合法侧 ⇒ 哪些视图是业务侧视图）。
   * 建立顺序是"外壳 → 身份面"，所以由 `webui.mjs` 在建好身份面后调用它（外壳不硬编码任何侧名）。
   */
  const configureCollab = ({ sessionsFile: file, sides: nextSides, views: nextViews } = {}) => {
    const store = collab.configure({ sessionsFile: file, sides: nextSides })
    const list = Array.isArray(nextViews) && nextViews.length
      ? nextViews.filter((view) => view !== 'home' && store.sides.includes(view)) : null
    const synced = list ? collabSurface.configure({ views: list }) : syncCollab()
    return { ok: true, sessions_file: store.sessions_file, sides: store.sides,
      views: list ?? collabSurface.viewsOf(), object_panels: synced.object_panels, kinds: synced.kinds }
  }

  /**
   * 装配期后补：名册面需要**身份面**的同两样东西（会话文件 ⇒ "今天谁登录过"；合法侧 ⇒ 名册按侧分片）。
   * 协作面也吃同一份配置（`collab.mjs` 的同一份名册句柄由 `configure` 补进去）。
   */
  const configurePeople = ({ sessionsFile: file, sides: nextSides, views: nextViews } = {}) => {
    const store = people.configure({ sessionsFile: file, sides: nextSides })
    collab.configure({ people, sides: store.sides })
    const list = Array.isArray(nextViews) && nextViews.length
      ? nextViews.filter((view) => view !== 'home' && store.sides.includes(view)) : null
    const synced = list ? peopleSurface.configure({ views: list }) : syncPeople()
    return { ok: true, sessions_file: store.sessions_file, sides: store.sides,
      views: list ?? peopleSurface.viewsOf(), panels: synced.panels }
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
      const verdict = await loadOne(item)
      summary.push(verdict)
    }
    syncCollab()          // 对象类都声明完了：把协作面挂到它们上面（并撤掉已经不存在的）
    syncPeople()          // 名册面不依赖对象类，但视图列表同样以装配方给的为准
    return summary
  }

  /** 装载/重载计数：它进 `?v=`（**唯一的模块缓存失效手段**）—— 没有它，改 `code/ui.mjs` 必须重启进程。 */
  let loadSeq = 0
  const moduleVersionOf = (file) => {
    let stamp = 0
    try { stamp = Math.round(statSync(file).mtimeMs) } catch (err) { stamp = 0 }
    return `${SURFACE_VERSION}.${stamp}.${loadSeq}`
  }

  /** 装载**一个**插件文件（`load`/`reload` 共用）：import 带 `?v=<mtime>`，装载失败有名报错，不静默吞。 */
  const loadOne = async (item) => {
    let module = null
    try {
      loadSeq += 1
      module = await import(`${item.file}?v=${moduleVersionOf(item.file)}`)
    } catch (err) {
      contributions.set(item.plugin_id, { file: item.file, error: flat(err), entries: [] })
      say(`插件贡献装载失败 ${item.plugin_id}：${flat(err)}`)
      return { plugin_id: item.plugin_id, file: item.file, ok: false, code: 'register-failed',
        reason: flat(err), next_action: '修该插件 code/ui.mjs 的语法/import（装载失败不静默吞）' }
    }
    const register = module.register ?? module.default
    if (typeof register !== 'function') {
      contributions.set(item.plugin_id, { module, file: item.file, error: 'no-register-function', entries: [] })
      return { plugin_id: item.plugin_id, file: item.file, ok: false, code: 'no-register-function',
        next_action: 'code/ui.mjs 必须导出 `register(surface, host)`' }
    }
    try {
      const verdicts = await register(surface, host, item.plugin_id)
      const refused = (Array.isArray(verdicts) ? verdicts : []).filter((row) => row && row.ok === false)
      const registered = (Array.isArray(verdicts) ? verdicts : []).filter((row) => row && row.ok === true)
      contributions.set(item.plugin_id, { module, file: item.file,
        entries: registered.map((row) => ({ kind: row.kind, id: row.id })),
        refused: refused.map((row) => ({ code: row.code, reason: row.reason })) })
      return { plugin_id: item.plugin_id, file: item.file, ok: refused.length === 0,
        registered: registered.length, refused: refused.map((row) => ({ code: row.code, reason: flat(row.reason) })) }
    } catch (err) {
      contributions.set(item.plugin_id, { module, file: item.file, error: flat(err), entries: [] })
      say(`插件贡献注册失败 ${item.plugin_id}：${flat(err)}`)
      return { plugin_id: item.plugin_id, file: item.file, ok: false, code: 'register-failed', reason: flat(err),
        next_action: '修该插件 code/ui.mjs 的 register（注册失败不静默吞）' }
    }
  }

  const fileOf = (pluginId) => (scanContributions().find((item) => item.plugin_id === pluginId) ?? {}).file ?? ''

  /**
   * **运行期装载一个插件**（`POST /api/ui/plugins/<id>/load`）。
   * 已经装载过 ⇒ 拒绝（`already-loaded`）并指向 `reload`（不静默重装：重装会先撤掉它的贡献）。
   */
  const loadPlugin = async (pluginId) => {
    // 协作面是**外壳自带的机制贡献**（`collab-ui.mjs`，不是磁盘上的插件文件）：它只有"装着/撤掉"两种状态。
    if (pluginId === PEOPLE_PLUGIN_ID) {
      const before = peopleSurface.contributions
      const synced = syncPeople()
      return { ok: true, code: before ? 'already-loaded' : 'loaded', plugin_id: pluginId,
        file: 'src/system/webui/code/people-ui.mjs', built_in: true, registered: synced.panels,
        next_action: before
          ? '名册面本来就在（外壳自带）：要撤掉用 POST .../unload，要重建用 POST .../reload'
          : '名册面已挂到各视图上（刷新页面即可看到「人员名册与角色」与维护动作）' }
    }
    if (pluginId === COLLAB_PLUGIN_ID) {
      const before = collabSurface.contributions
      const synced = syncCollab()
      return { ok: true, code: before ? 'already-loaded' : 'loaded', plugin_id: pluginId,
        file: 'src/system/webui/code/collab-ui.mjs', built_in: true, registered: synced.object_panels,
        next_action: before
          ? '协作面本来就在（外壳自带）：要撤掉用 POST .../unload，要重建用 POST .../reload'
          : '协作面已挂到所有插件声明的对象类上（刷新页面即可看到指派/关注/评论）' }
    }
    const item = scanContributions().find((row) => row.plugin_id === pluginId)
    if (!item) {
      return { ok: false, code: 'plugin-not-found', plugin_id: pluginId,
        next_action: '磁盘上没有这个插件的 code/ui.mjs：先在 `src/<层>/<名>/code/ui.mjs` 写它的 register' }
    }
    const known = contributions.get(pluginId)
    if (known && known.entries && known.entries.length && known.unloaded !== true) {
      return { ok: false, code: 'already-loaded', plugin_id: pluginId, file: relative(root, item.file),
        next_action: `它已经在界面上：要让它重读磁盘上的新代码，用 reload（POST ${prefix}/api/ui/plugins/${encodeURIComponent(pluginId)}/reload）` }
    }
    const started = Date.now()
    const verdict = await loadOne(item)
    clearReadCache()               // 新贡献可能带来新的只读读取：缓存一律作废
    syncCollab()                   // 它可能声明了新的对象类 ⇒ 协作面跟着长出来
    return { ok: verdict.ok === true, code: verdict.ok ? 'loaded' : (verdict.code ?? 'register-failed'),
      plugin_id: pluginId, file: relative(root, item.file), ms: Date.now() - started,
      registered: verdict.registered ?? 0, refused: verdict.refused ?? [], reason: verdict.reason ?? null,
      next_action: verdict.ok
        ? `它的视图/面板/动作/快捷键已出现在界面上（刷新页面即可看到）；要撤销用 POST ${prefix}/api/ui/plugins/${encodeURIComponent(pluginId)}/unload`
        : (verdict.next_action ?? '看 reason 定位（装载失败时界面不变）') }
  }

  /**
   * **热重载一个插件**：撤销它的全部贡献 → 按磁盘上的**当前**内容重新 import（`?v=<mtime>`）→ 重新注册。
   * 这是"改 `code/ui.mjs` 不用重启进程"的那条路；**不改**其它插件的任何贡献。
   */
  const reloadPlugin = async (pluginId) => {
    // 协作面（外壳自带）：reload = 撤掉它的全部贡献后按当前代码重建（并重新挂到最新声明的对象类上）。
    if (pluginId === PEOPLE_PLUGIN_ID) {
      peopleSurface.dispose()
      const synced = syncPeople()
      return { ok: true, code: 'reloaded', plugin_id: pluginId, built_in: true,
        file: 'src/system/webui/code/people-ui.mjs', module_version: `people.${Date.now()}`,
        registered: synced.panels,
        next_action: '名册面已重建（「人员名册与角色」+ 维护动作都在）；'
          + '名册**数据**不受影响（它落在 <ui_shared>/people/ 下的 0600 文件里，不是贡献）' }
    }
    if (pluginId === COLLAB_PLUGIN_ID) {
      collabSurface.dispose()
      const synced = syncCollab()
      return { ok: true, code: 'reloaded', plugin_id: pluginId, built_in: true,
        file: 'src/system/webui/code/collab-ui.mjs', module_version: `collab.${Date.now()}`,
        registered: synced.object_panels,
        next_action: '协作面已重建（指派/关注/评论/@同事 与「我的 / 我指派的 / 全部」筛选都在）；'
          + '协作**数据**不受影响（它落在 <ui_shared>/collab/ 下的 0600 文件里，不是贡献）' }
    }
    const item = scanContributions().find((row) => row.plugin_id === pluginId)
    if (!item) {
      return { ok: false, code: 'plugin-not-found', plugin_id: pluginId,
        next_action: '磁盘上没有这个插件的 code/ui.mjs（先写它，再用 load）' }
    }
    const before = contributions.get(pluginId) ?? { entries: [] }
    const removed = unload(pluginId)
    const started = Date.now()
    const verdict = await loadOne(item)
    clearReadCache()
    syncCollab()                   // 重载可能改了它声明的对象类
    let mtime = null
    try { mtime = new Date(statSync(item.file).mtimeMs).toISOString() } catch (err) { mtime = null }
    return { ok: verdict.ok === true, code: verdict.ok ? 'reloaded' : (verdict.code ?? 'register-failed'),
      plugin_id: pluginId, file: relative(root, item.file), mtime, module_version: moduleVersionOf(item.file),
      ms: Date.now() - started, removed: removed.count, was: (before.entries ?? []).length,
      registered: verdict.registered ?? 0, refused: verdict.refused ?? [], reason: verdict.reason ?? null,
      next_action: verdict.ok
        ? '新代码已在**同一个进程**里生效：刷新页面即可看到新贡献（进程没有重启，其它插件的贡献一项未动）'
        : (verdict.next_action ?? '看 reason 定位（装载失败时该插件的贡献保持**已撤销**状态，页面上会少东西）') }
  }

  /** 插件装载清单（`GET /api/ui/plugins`）：谁在磁盘上、装载没装载、mtime 多少。 */
  const pluginsJson = () => ({
    ok: true, prefix,
    plugins: [...scanContributions().map((item) => {
      const known = contributions.get(item.plugin_id) ?? {}
      let mtime = null
      try { mtime = new Date(statSync(item.file).mtimeMs).toISOString() } catch (err) { mtime = null }
      return { plugin_id: item.plugin_id, file: relative(root, item.file), mtime,
        loaded: Array.isArray(known.entries) && known.entries.length > 0 && known.unloaded !== true,
        contributions: known.entries ?? [], refused: known.refused ?? [], error: known.error ?? null }
    }), {
      // 外壳自带的**协作面**（不是磁盘上的插件文件）：一样列在这里，一样可卸载/重建（规则 1）
      plugin_id: COLLAB_PLUGIN_ID, file: 'src/system/webui/code/collab-ui.mjs', built_in: true,
      mtime: null, loaded: collabSurface.contributions > 0,
      contributions: surface.byKind('action').filter((item) => item.plugin_id === COLLAB_PLUGIN_ID)
        .map((item) => ({ kind: 'action', id: item.id, title: item.title }))
        .concat(surface.byKind('panel').filter((item) => item.plugin_id === COLLAB_PLUGIN_ID)
          .map((item) => ({ kind: 'panel', id: item.id, title: item.title }))),
      refused: [], error: null,
      note: '同侧协作（指派/转交、关注、评论与 @同事、活动流、我的/我指派的/全部）：外壳自带的机制贡献',
    }, {
      // 外壳自带的**名册/角色面**（同样不是磁盘上的插件文件）：一样列在这里，一样可卸载/重建（规则 1）
      plugin_id: PEOPLE_PLUGIN_ID, file: 'src/system/webui/code/people-ui.mjs', built_in: true,
      mtime: null, loaded: peopleSurface.contributions > 0,
      contributions: surface.byKind('action').filter((item) => item.plugin_id === PEOPLE_PLUGIN_ID)
        .map((item) => ({ kind: 'action', id: item.id, title: item.title }))
        .concat(surface.byKind('panel').filter((item) => item.plugin_id === PEOPLE_PLUGIN_ID)
          .map((item) => ({ kind: 'panel', id: item.id, title: item.title }))),
      refused: [], error: null,
      note: '人员名册与角色（同侧成员 / 角色 / 直属关系 / 按角色限动作）：外壳自带的机制贡献',
    }],
    mechanism: '装载面是**机制**：按磁盘上的 `code/ui.mjs` 发现式装载；`reload` = 撤掉这个插件的全部贡献后按'
      + '当前文件内容重新 import（带 ?v=<mtime> 击穿模块缓存）⇒ 改插件 UI 不必重启进程。'
      + '卸载后它的视图/面板/动作/快捷键/通知源/状态项一起消失（AGENTS.md 规则 1）；'
      + '标了 `built_in` 的那两条（协作面 / 名册面）是外壳自己的贡献，同样可卸载/重建',
    next_action: `POST ${prefix}/api/ui/plugins/<plugin_id>/reload 让磁盘上的新代码在**当前进程**里生效`,
  })

  // ------------------------------------------------------------------ 渲染：面板 / 通知 / 状态
  /** 当前地址（**对象深链** `/app/<view>/<kind>/<id>`）：插件从 `ctx.route` 才知道"现在要看哪一个对象"。 */
  const normRoute = (route) => ({ view: String(route?.view ?? 'home'), panel: String(route?.panel ?? ''),
    kind: String(route?.kind ?? ''), id: String(route?.id ?? '') })

  /**
   * **会话身份**（机制）：只有"这次请求是谁"这一件事，没有任何业务含义。侧与 `human:<名字>` 都来自服务端
   * 会话（cookie 解析在身份面），**不由**请求体/表单决定 ⇒ 协作类贡献拿到的永远是同一个侧的人。
   */
  const normIdentity = (who) => {
    if (!who || who.ok !== true) return null
    const human = String(who.human ?? '')
    const side = String(who.side ?? '')
    if (human === '' || side === '') return null
    return { human, name: String(who.name ?? ''), side }
  }

  const panelCtx = (view, route = { view }, who = null) => {
    const normalized = normRoute({ ...route, view })
    return { view: normalized.view, route: normalized, host, now: host.now(), rows: host.rows(normalized.view),
      identity: normIdentity(who),
      panels: surface.panelsOf(normalized.view).map((panel) => panel.id),
      actions: surface.byKind('action').map((action) => action.id) }
  }

  /**
   * 某视图上面板的数据。
   * `route.kind` 非空 ⇒ **对象页**：只渲染声明了该 `object_kind` 的面板（其余面板在这一页上不出现），
   * 且 `ctx.route` 带上 `kind/id` 供插件渲染那一个对象；没声明过该对象类 ⇒ 返回空数组（调用方报未命中）。
   * `who` = 本次请求的会话（可选；插件从 `ctx.identity` 拿"同侧人类之间"的协作身份与侧）。
   */
  const panelsOf = (view, route = {}, who = null) => {
    const normalized = normRoute({ ...route, view })
    const picked = normalized.kind === '' ? surface.panelsFor(view, '')
      : surface.panelsFor(view, normalized.kind)
    const ctx = panelCtx(view, normalized, who)
    // 一次渲染的作用域：这一页上的多块面板读同一个只读工具时**只起一个进程**（缓存见 `runPython`）。
    return withRenderScope(() => picked.map((panel) => {
      const base = { id: panel.id, title: panel.title, plugin_id: panel.plugin_id, order: panel.order,
        panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, hint: panel.hint,
        object_kind: panel.object_kind, wide: panel.placement === 'wide' }
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
    }).sort((left, right) => (left.order - right.order) || (left.id < right.id ? -1 : 1)))
  }

  /**
   * **对象页的整份数据**（`GET /api/ui/object?view=&kind=&id=`）：外壳只做机制 —— 找出"谁负责这个对象类"、
   * 把它声明的 `data.object` 页头（标题/摘要/事实/链接）按通用形状摊平、附上该对象类的动作与可用对象类清单。
   * 没有任何插件声明这个对象类 ⇒ `found:false` + 有名 reason + 下一步（**不编内容**）。
   */
  const objectOf = (view, kind, id, who = null) => {
    const kinds = surface.objectKindsFor(view)
    const claimed = kinds.includes(kind)
    const panels = claimed ? panelsOf(view, { view, kind, id }, who) : []
    const header = panels.map((panel) => (panel.data ?? {}).object).find((item) => item && typeof item === 'object')
      ?? null
    const found = claimed && panels.length > 0 && (header ? header.found !== false : true)
    return {
      ok: true, view, kind, id, found,
      title: header?.title ?? (claimed ? `${kind} ${id}` : `${kind}（本视图没有这种对象）`),
      subtitle: header?.subtitle ?? '', facts: Array.isArray(header?.facts) ? header.facts : [],
      links: Array.isArray(header?.links) ? header.links : [],
      reason: found ? '' : (header?.reason ?? (claimed ? 'object-not-found' : 'object-kind-not-registered')),
      next_action: found ? '' : (header?.next_action ?? (claimed
        ? '这个 id 不在本视图的投影里：换成列表里真实存在的 id（列表里每一行的 id 就是它的深链）'
        : `本视图可打开的对象类：${kinds.join(' / ') || '（一个都没有：还没有插件声明 object_kind）'}`
          + `；也可以回到 ${prefix}/app/${view}/ 看列表`)),
      kinds, panels,
      actions: surface.actionsFor(view, kind).map((action) => action.id),
      deep_link: `${prefix}/app/${view}/${kind}/${id}/`,
      mechanism: '对象页是**机制**：外壳按插件声明的 `object_kind` 找面板、把面板给的 `data.object` 摊成页头；'
        + '外壳不认识任何具体对象类',
    }
  }

  /**
   * 通知源里**可跳转的对象引用**的规范化（机制，不认识任何对象类）：
   * 插件给的 `ref` 只有形如 `{kind, id[, view, title]}` 才被保留（`kind`/`id` 都是非空串）；
   * 其它形状（裸 id、任意回执对象）一律丢成 `null` —— 免得界面上出现一条点不动的"假深链"。
   */
  const normRef = (ref) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null
    const kind = String(ref.kind ?? '').trim()
    const id = String(ref.id ?? '').trim()
    if (kind === '' || id === '') return null
    const view = String(ref.view ?? '').trim()
    return { kind, id, view: views.includes(view) ? view : '', title: String(ref.title ?? '').trim() }
  }

  /**
   * 通知源给的**标签**（机制：只搬运，不解读）：用来在通知中心做「我的 / 我指派的 / …」这类筛选片。
   * 形状约束在这里：最多 6 个、每个 ≤ 24 字符、非空字符串 —— 界面上不会出现一条点不动/看不懂的筛选。
   */
  const normTags = (value) => (Array.isArray(value) ? value.map((item) => String(item ?? '').trim())
    .filter((item) => item !== '').slice(0, 6).map((item) => item.slice(0, 24)) : [])

  const notifications = (who = null) => withRenderScope(() => {
    const items = []
    for (const source of surface.byKind('notification-source')) {
      try {
        const out = source.poll(panelCtx(source.view || 'home', undefined, who)) || []
        for (const item of Array.isArray(out) ? out : []) {
          items.push({ id: String(item.id ?? `${source.plugin_id}:${items.length}`), level: String(item.level ?? 'info'),
            title: String(item.title ?? ''), body: String(item.body ?? ''),
            next_action: String(item.next_action ?? ''), action: item.action ? String(item.action) : '',
            ref: normRef(item.ref), at: String(item.at ?? ''), plugin_id: source.plugin_id,
            tags: normTags(item.tags),
            // `preset`：点通知上的「去处理」时，用这些键值预填动作表单（如那条通知讲的是哪个报价）
            preset: item.preset && typeof item.preset === 'object' && !Array.isArray(item.preset)
              ? item.preset : null })
        }
      } catch (err) {
        items.push({ id: `${source.plugin_id}:poll-failed`, level: 'bad', title: '通知源读取失败',
          body: flat(err), next_action: '修该通知源的 poll()', plugin_id: source.plugin_id,
          at: host.now(), ref: null, action: '', tags: [] })
      }
    }
    // 动作流水：只保留 `{kind,id}` 形状的对象引用（动作回执是任意 JSON，不能当深链用）；
    // 并且**只给自己看**（`actor` 全会话身份；未登录时看不到任何人的动作流水）。
    const me = normIdentity(who)
    for (const entry of actionLog.slice(0, 20)) {
      if (entry.actor !== (me ? me.human : '')) continue
      items.push({ ...entry, ref: normRef(entry.ref) })
    }
    return items.slice(0, 200)
  })

  const statusItems = (who = null) => withRenderScope(() => {
    const out = []
    for (const item of surface.byKind('status-item')) {
      try {
        const read = item.read(panelCtx('home', undefined, who)) || {}
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
    // 机制的**代价读数**：一次页面渲染到底起了几个 Python 进程、省掉几个（前后可对账）
    out.push({ id: 'shell.io', title: 'Python', level: ioStats.spawns ? 'ok' : 'ok', plugin_id: 'system/webui',
      text: `进程 ${ioStats.spawns} 次（只读 ${ioStats.read_spawns}）· 只读命中缓存 ${ioStats.read_hits} 次`
        + ` · 缓存窗口 ${readCacheTtlMs}ms` })
    return out
  })

  // ------------------------------------------------------------------ 动作：校验 → 插件的服务端一半
  /** 字段级校验（与服务端声明同源；客户端只是提前一步给同样的错误）。 */
  const validateInput = (action, input) => {
    const errors = []
    // 批量动作：对象 id 由批量清单（`ids` / `rows`）顶替 ⇒ 不再要求手抄一个 id 字段
    // （与客户端同一口径：P3 走查实测批量受理被"报价 id 必填"挡在门外的真缺陷）。
    const bulk = (Array.isArray(input.ids) && input.ids.length > 0)
      || (Array.isArray(input.rows) && input.rows.length > 0)
    for (const field of action.input.fields) {
      const value = input[field.name]
      const empty = value === undefined || value === null || String(value).trim() === ''
      const covered = bulk && (field.from_route === true
        || (action.input.bulk === 'rows' && field.name === 'item_id'))
      if (field.required && empty && !covered) {
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

  const runAction = async (actionId, request, who = null) => {
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
    const ctx = { view: String(request?.view ?? action.view), route: normRoute({ view: request?.view ?? action.view,
      kind: request?.route?.kind, id: request?.route?.id }), input, host, now: host.now(),
      // **会话身份**（机制）：插件可以据此判定"同侧人类之间"的协作；表单里的字段改不动它。
      identity: normIdentity(who),
      action: { id: action.id, title: action.title, plugin_id: action.plugin_id, permission: action.permission } }
    // ---- **按角色限动作**（机制；`people.mjs` 的策略面）：只**收紧**动作，永不放开 ----------------------
    // 判据在名册的 `policy.amount_limit` 里（配置：哪个动作、金额从哪条事实取、什么单位）：
    // 动作金额超过**我的角色**额度 ⇒ 在动作的服务端一半执行**之前**拒绝（账本/待办件零新增），并告诉你该找谁。
    // 位置与纪律：它在人签门（`/api/action/<id>` 的「署名 == 会话身份」）**之后**、插件自己的服务端一半**之前** ——
    // 角色既不能替签、也不能跳过人工门；它只能否决（"角色不改变签署权"这条在这里是**结构性**的）。
    const guardVerdict = people.guardAction({ action_id: action.id, input, identity: ctx.identity,
      view: ctx.view, rows: (view) => host.rows(view) })
    if (guardVerdict) {
      // 拒绝回执带上**可核对的读数**（我是什么角色、额度多少、这笔金额多少、该找哪个角色）：
      // 把 verdict 里的结构化字段（`refusal` 除了 ok/code/reason/next_action 之外的键）原样透到 `result`。
      const { ok: _ignored, code: guardCode, reason: guardReason, next_action: guardNext, ...guardRest } = guardVerdict
      const guardDetail = Object.keys(guardRest).length ? guardRest : null
      const entry = { id: `act-${Date.now()}-${action.id}`, level: 'bad',
        title: `${action.title} → ${guardCode}`, body: flat(guardReason),
        next_action: flat(guardNext), ref: null, at: host.now(), plugin_id: action.plugin_id,
        action: action.id, actor: ctx.identity ? ctx.identity.human : '',
        guard: { code: guardCode, ...(guardDetail ?? {}) } }
      actionLog.unshift(entry)
      if (actionLog.length > 100) actionLog.length = 100
      return { ok: false, code: guardCode, action: action.id, reason: guardReason,
        next_action: guardNext, result: guardDetail,
        guard: 'role-limit', ledger: 'zero-management' }
    }
    let out = null
    try {
      out = await action.server(ctx, input)
    } catch (err) {
      out = { ok: false, code: 'action-failed', reason: flat(err), next_action: '修该动作的服务端一半（不静默吞）' }
    }
    const result = out && typeof out === 'object' ? out : { ok: false, code: 'invalid-result',
      reason: '服务端一半没有返回对象', next_action: '返回 {ok, code, reason, next_action, result}' }
    const actor = normIdentity(who)
    const entry = { id: `act-${Date.now()}-${action.id}`, level: result.ok ? 'ok' : 'bad',
      title: `${action.title} → ${result.ok ? 'ok' : (result.code ?? 'refused')}`,
      body: flat(result.reason ?? result.note ?? ''), next_action: flat(result.next_action ?? ''),
      ref: result.result ?? null, at: host.now(), plugin_id: action.plugin_id, action: action.id,
      // 动作流水**按会话身份隔离**：同侧别人做的事不该出现在你的通知中心里（多人在同一侧时的隐私与噪声）
      actor: actor ? actor.human : '' }
    actionLog.unshift(entry)
    if (actionLog.length > 100) actionLog.length = 100
    clearReadCache()   // 动作可能改了事实（写者刚跑过）⇒ 只读缓存作废：下一屏读到的一定是新状态
    return { ok: result.ok === true, action: action.id, code: result.code ?? null, reason: result.reason ?? null,
      next_action: result.next_action ?? null, result: result.result ?? null, note: result.note ?? null,
      errors: result.errors ?? null, refresh: result.refresh ?? ['panels', 'notifications', 'status'] }
  }

  // ------------------------------------------------------------------ 撤销（卸载一个插件的全部贡献）
  const unload = (pluginId) => {
    // 协作面（外壳自带）：撤掉它的贡献时把机制侧的账也清干净（否则再 load 会说"已经装着"）
    if (pluginId === COLLAB_PLUGIN_ID) collabSurface.dispose()
    if (pluginId === PEOPLE_PLUGIN_ID) peopleSurface.dispose()
    const removed = surface.disposePlugin(pluginId)
    const slotRows = []
    if (slots && typeof slots.describe === 'function') {
      for (const block of slots.describe().blocks) {
        if (block.plugin_id !== pluginId) continue
        slots.unregister(pluginId, block.slot)
        slotRows.push({ kind: 'slot-block', id: `${block.slot}:${block.plugin_id}`, title: block.title })
      }
    }
    contributions.set(pluginId, { entries: [], unloaded: true, file: fileOf(pluginId) })
    noteStore.drop(pluginId)
    clearReadCache()
    const payload = { ok: true, plugin_id: pluginId, removed: [...removed.removed, ...slotRows],
      count: removed.count + slotRows.length,
      next_action: '该插件的视图/面板/动作/快捷键/通知源/状态项与它注册的区块都已撤销；'
        + '页面其余部分逐字节不变（可 POST .../load 或 .../reload 恢复）' }
    say(`卸载贡献：${pluginId}（移除 ${payload.count} 项）`)
    return payload
  }

  // ------------------------------------------------------------------ 外壳 HTML（单页应用；脚本只来自本服务）
  const shellHtml = (route) => {
    const safe = normRoute(route)
    const title = safe.kind !== '' ? `${safe.kind} ${safe.id}` : (safe.view === 'home' ? '工作台' : safe.view)
    const initial = JSON.stringify({ prefix, route: { view: safe.view, panel: safe.panel, kind: safe.kind,
      id: safe.id } }).replace(/</g, '\\u003c')
    // **无脚本回退导航**：脚本没跑起来（或禁用 JS / 爬虫 / 屏幕阅读器）时，人也能到达每一道与上手页 ——
    // 这是可访问性与渐进增强，不是"第二套页面"：正式界面仍由客户端按注册面渲染。
    const fallback = ['', 'contractor/', 'supplier/', 'ops/', 'admin/', 'start/']
      .map((path) => `<a href="${prefix}/${path}">${esc({ '': '工作台', 'contractor/': '承包商视角',
        'supplier/': '供应商视角', 'ops/': '运维视角', 'admin/': '系统管理',
        'start/': '上手（token／配置放哪里？）' }[path] ?? path)}</a>`).join(' · ')
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.page_title ?? 'quotagent')} · ${esc(title)}</title>
<link rel="stylesheet" href="${prefix}/assets/app.css">
<script type="application/json" id="q-boot">${initial}</script>
</head><body>
<div id="q-app">
  <header class="q-top" id="q-top"></header>
  <nav class="q-tabs" id="q-tabs" aria-label="打开的标签页"></nav>
  <div class="q-banners" id="q-banners" aria-live="polite"></div>
  <main class="q-main" id="q-view" tabindex="-1"></main>
  <footer class="q-status" id="q-status"></footer>
</div>
<div class="q-toasts" id="q-toasts" aria-live="polite"></div>
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
      + ' + 通知与状态 + **对象深链**（面板/动作声明 object_kind，地址 /app/<view>/<kind>/<id>）；外壳只做机制、'
      + '不懂业务语义',
    prefix,
    views: [...views].map((view) => ({ id: view,
      title: config.view_titles?.[view] ?? ({ home: '工作台', contractor: '承包商', supplier: '供应商',
        ops: '运维', admin: '系统管理' }[view] ?? view),
      object_kinds: surface.objectKindsFor(view),
      external: ['ops', 'admin'].includes(view) ? `${prefix}/${view}/` : null })),
    deep_link: { pattern: `${prefix}/app/<view>/[<kind>/<id>/]`,
      note: '视图地址 `…/app/<view>/`；**对象地址** `…/app/<view>/<kind>/<id>/`（kind 由插件声明 object_kind，'
        + '刷新不丢、可复制分享；对方视角打开同一 id 只会在它自己的投影里找不到 ⇒ 如实未命中）' },
    io: { python_spawns: ioStats.spawns, python_read_spawns: ioStats.read_spawns,
      read_cache_hits: ioStats.read_hits, read_cache_ttl_ms: readCacheTtlMs, cache_clears: ioStats.cache_clears,
      note: '只读工具调用（插件声明 read:true）按「工具+参数」缓存 TTL；任何一次动作/落待办件都会清空缓存' },
    registries: surface.snapshot(),
    actions: surface.byKind('action').map((action) => ({ id: action.id, title: action.title,
      views: action.views, group: action.group, icon: action.icon, placement: action.placement,
      inline: action.inline, context_menu: action.context_menu, shortcut: action.shortcut,
      input: action.input, permission: action.permission, confirm: action.confirm, hint: action.hint,
      object_kind: action.object_kind, plugin_id: action.plugin_id })),
    panels: surface.byKind('panel').map((panel) => ({ id: panel.id, title: panel.title, view: panel.view,
      panel_kind: panel.panel_kind, placement: panel.placement, actions: panel.actions, order: panel.order,
      object_kind: panel.object_kind, plugin_id: panel.plugin_id })),
    shortcuts: surface.shortcuts().map((item) => ({ keys: item.keys, action: item.action, title: item.title,
      plugin_id: item.plugin_id })),
    shell_shortcuts: SHELL_SHORTCUTS,
    // **同侧协作**（指派/转交、关注、评论与 @同事、活动流、已读）：外壳机制的一部分，同样按注册面撤销。
    // 这里给出它的存储自述 —— 用来对账"它没进账本、也没进投影"（`why_not_ledger` 是判据本身）。
    collab: { ...collab.describe(), contributions: collabSurface.contributions,
      object_panels: collabSurface.objectPanels, plugin_id: COLLAB_PLUGIN_ID,
      http: { object: `${prefix}/api/collab/object?view=<view>&kind=<kind>&id=<id>`,
        hub: `${prefix}/api/collab/hub`, store: `${prefix}/api/collab/store` } },
    // **人员名册与角色**（同侧成员 / 角色 / 直属关系 / 按角色限动作）：外壳机制的一部分，同样按注册面撤销。
    // 这里给出它的存储自述与**策略读数** —— 用来对账"它没进账本、也没进投影"，以及"谁有额度"。
    people: { ...people.describe(), contributions: peopleSurface.contributions,
      panels: peopleSurface.panelCount, plugin_id: PEOPLE_PLUGIN_ID,
      http: { roster: `${prefix}/api/people/roster`, suggest: `${prefix}/api/people/suggest`,
        store: `${prefix}/api/people/store` } },
    plugins: [...contributions.entries()].map(([plugin_id, info]) => ({ plugin_id,
      entries: info.entries ?? [], error: info.error ?? null, unloaded: info.unloaded === true })),
    next_action: '动作一律 POST ' + `${prefix}/api/action/<id>` + '（含 JSON 入参）；'
      + '写动作最终由插件自己的服务端一半落 0600 待办件、再由 Python 侧唯一写者落账本',
  })

  return { surface, host, loadContributions, unload, loadPlugin, reloadPlugin, pluginsJson, runAction,
    panelsOf, objectOf, notifications, statusItems, normalizeRoute: normRoute, ioStats, clearReadCache,
    surfaceJson, shellHtml, asset, scanContributions, runPython, stage,
    // **同侧协作**（机制）：HTTP 路由（`webui.mjs`）按会话身份拿侧与 actor，再调这里的四件事。
    collab, collabSurface, syncCollab, configureCollab, collabPluginId: COLLAB_PLUGIN_ID,
    // **人员名册与角色**（机制）：HTTP 路由按会话身份拿侧；`collab` 的候选名单也从它来。
    people, peopleSurface, syncPeople, configurePeople, peoplePluginId: PEOPLE_PLUGIN_ID,
    get contributions() { return contributions } }
}
