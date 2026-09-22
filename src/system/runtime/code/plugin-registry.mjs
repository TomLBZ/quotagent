/**
 * plugin-registry —— 「一切皆插件」的**目录即清单 + 六动词**实现（`src/system/runtime/` 的 code/，阶段 1 新增）。
 *
 * 规则真源：`docs/design/27-plugin-architecture.md` §1–§4（三层分类 / 单插件布局 / 最小契约 / 生命周期）；
 * 决策：ADR-0020（一切皆插件）、ADR-0021（需求归属）。本文件**不重复规则文本**，只实现它并给出原因码。
 *
 * 分工（本文件 = 纯逻辑 + 真装载；**不写任何文件**）：
 *   · `scan(root)`      ：扫 `src/{system,domain}/*​/plugin.json` 与 `src/userspace/<ns>/<plugin>/plugin.json`
 *                        （目录即清单；目录里没有 `plugin.json` 的目录**不是插件**，不枚举）；
 *   · `validate(p)`     ：最小契约校验（§3.1）⇒ 缺字段/层不一致/名字不一致/入口不存在，逐条给原因码；
 *   · `depsClosure()`   ：`depends_on` + `inject`（服务键 → 提供者）的传递闭包；**有环给环上的 id**；
 *   · `mount()`         ：**真装载**：动态 `import` 入口 → `cordis` 的 `ctx.plugin()` 拿到 `fiber`
 *                        （`uid` / `state` / `getEffects()` 都是内核实测值，不是本文件编的）；
 *   · `unmount()`       ：`fiber.dispose()` 后**回读** effects 是否为 0（卸载不留残订阅/定时器）。
 *
 * 零写面：唯一的写入者是 `tools/plugin-lifecycle.mjs`（装载记录 `tmp/plugin-runtime/state.json`），
 * 它必须同时写入装载事实与**只有它写**这件事（见 `plugin.json.permissions`）。
 * 本文件不联网、不取随机、不注册定时器；`Date` 只在调用方（CLI）用于记录时间戳。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 层（与 `host/lib/ui-slot.mjs` 的 `LAYERS`、目录布局同一套取值）。 */
export const LAYERS = ['system', 'domain', 'userspace']
/** 清单文件名与上限（**复用** `host/lib/user-space.mjs` 的既有约定，不新增第二套）。 */
export const MANIFEST = 'plugin.json'
export const MAX_MANIFEST_BYTES = 65536
/** 最小契约必填字段（27 §3.1；缺一即非法）。 */
export const REQUIRED_FIELDS = ['name', 'version', 'layer', 'provides', 'entry', 'description']
/** ns / plugin 名形状（与 `host/lib/user-space.mjs` 的 `NAME_RE` **同一正则**）。 */
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
/** 插件 id 形状（`层次/插件`；userspace 为 `userspace/<ns>/<plugin>`）。 */
export const PLUGIN_ID_RE = /^(system|domain|userspace)\/[a-z][a-z0-9-]{0,31}(\/[a-z][a-z0-9-]{0,31})?$/
/** 六动词（唯一接口；三个层同一套）。 */
export const VERBS = ['list', 'status', 'load', 'reload', 'unload', 'deps']

/** 清单级降级/非法原因码（闭合集合；门逐条断言"降级是有名的"）。 */
export const MANIFEST_REASONS = ['manifest-missing', 'manifest-unreadable', 'manifest-not-json',
  'manifest-not-an-object', 'manifest-too-large', 'manifest-missing-fields', 'name-mismatch',
  'layer-mismatch', 'ns-missing', 'artifact-missing', 'id-shape']
/** 动词级拒绝码（`ok:false` 一律带 `code` + `reason` + `next_action`）。 */
export const CODES = ['unknown-plugin', 'illegal-layer', 'not-a-plugin', 'already-loaded', 'not-loaded',
  'dependency-cycle', 'unresolved-service', 'not-activated', 'cordis-missing', 'import-failed',
  'mount-failed', 'registry-corrupt', 'usage']

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const refusal = (code, id, reason, next_action, extra = {}) =>
  ({ ok: false, code, id, reason, next_action, ...extra })

/** 解析 `层次/插件` → `{layer, plugin, ns}`；形状非法 ⇒ `null`。 */
export function parsePluginId(id) {
  const text = typeof id === 'string' ? id.trim() : ''
  if (!PLUGIN_ID_RE.test(text)) return null
  const parts = text.split('/')
  return parts[0] === 'userspace'
    ? { layer: 'userspace', ns: parts[1], plugin: parts[2], id: text }
    : { layer: parts[0], plugin: parts[1], id: text }
}

/** 插件目录（按 id）：`<root>/src/<层>/<插件>` 或 `<root>/src/userspace/<ns>/<插件>`。 */
export function pluginDir(root, id) {
  const parsed = parsePluginId(id)
  if (parsed === null) return null
  return parsed.layer === 'userspace'
    ? join(root, 'src', 'userspace', parsed.ns, parsed.plugin)
    : join(root, 'src', parsed.layer, parsed.plugin)
}

/** 枚举全部插件**目录**（目录即清单的前半句：没有 `plugin.json` 的目录会被 `scan` 标 `manifest-missing`）。 */
export function pluginDirs(root) {
  const out = []
  for (const layer of ['system', 'domain']) {
    const base = join(root, 'src', layer)
    if (!isDir(base)) continue
    for (const name of readdirSync(base).sort()) {
      if (isDir(join(base, name))) out.push({ layer, ns: null, plugin: name, dir: join(base, name) })
    }
  }
  const userspace = join(root, 'src', 'userspace')
  if (isDir(userspace)) {
    for (const ns of readdirSync(userspace).sort()) {
      const nsDir = join(userspace, ns)
      if (!isDir(nsDir)) continue
      for (const name of readdirSync(nsDir).sort()) {
        if (isDir(join(nsDir, name))) out.push({ layer: 'userspace', ns, plugin: name, dir: join(nsDir, name) })
      }
    }
  }
  return out
}

const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
const idOf = ({ layer, ns, plugin }) => (layer === 'userspace' ? `userspace/${ns}/${plugin}` : `${layer}/${plugin}`)

/**
 * 扫一层/三层插件（**只读、有界**；单条坏清单不拖倒整次扫描）。
 * @returns `{root, plugins, degraded}`：`plugins[].manifest` = 解析后的对象或 `null`（配 `reason`）。
 */
export function scan(root) {
  const plugins = []
  const degraded = []
  for (const item of pluginDirs(root)) {
    const id = idOf(item)
    const manifestPath = join(item.dir, MANIFEST)
    const base = { id, layer: item.layer, ns: item.ns, plugin: item.plugin, dir: item.dir,
      manifest_path: manifestPath, manifest: null, reason: null, invalid: false }
    if (!existsSync(manifestPath)) {
      plugins.push({ ...base, reason: 'manifest-missing', invalid: true })
      degraded.push({ id, reason: 'manifest-missing',
        next_action: `给 ${id} 写 ${MANIFEST}（最小契约见 docs/design/27-plugin-architecture.md §3.1）` })
      continue
    }
    let raw = ''
    try {
      const size = statSync(manifestPath).size
      if (size > MAX_MANIFEST_BYTES) {
        plugins.push({ ...base, reason: 'manifest-too-large', invalid: true })
        degraded.push({ id, reason: 'manifest-too-large', next_action: `清单必须 ≤ ${MAX_MANIFEST_BYTES} B` })
        continue
      }
      raw = readFileSync(manifestPath, 'utf8')
    } catch (err) {
      plugins.push({ ...base, reason: 'manifest-unreadable', invalid: true })
      degraded.push({ id, reason: 'manifest-unreadable', next_action: `让 ${MANIFEST} 可读（${String(err && err.message).slice(0, 80)}）` })
      continue
    }
    let manifest = null
    try {
      manifest = JSON.parse(raw)
    } catch {
      plugins.push({ ...base, reason: 'manifest-not-json', invalid: true })
      degraded.push({ id, reason: 'manifest-not-json', next_action: `${MANIFEST} 必须是合法 JSON（UTF-8）` })
      continue
    }
    if (!plainObject(manifest)) {
      plugins.push({ ...base, reason: 'manifest-not-an-object', invalid: true })
      degraded.push({ id, reason: 'manifest-not-an-object', next_action: `${MANIFEST} 顶层必须是对象` })
      continue
    }
    const verdict = validate(base, manifest)
    plugins.push({ ...base, manifest, reason: verdict.ok ? null : verdict.reason, invalid: !verdict.ok,
      next_action: verdict.ok ? null : verdict.next_action })
    if (!verdict.ok) degraded.push({ id, reason: verdict.reason, next_action: verdict.next_action })
  }
  return { root, plugins, degraded }
}

/**
 * 最小契约校验（27 §3.1/§3.2；**逐条给原因码**，不夹取、不补默认值）。
 * 检查：必填字段、`name` 与目录一致、`layer` 与目录一致、userspace 必须有 `ns`、`entry` 文件必须存在。
 */
export function validate(base, manifest) {
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = manifest[field]
    if (field === 'provides') return !Array.isArray(value) || value.length === 0
    if (field === 'entry') return typeof value !== 'string' || value.trim() === ''
    if (field === 'version') return typeof value !== 'string' || value.trim() === ''
    if (field === 'description') return typeof value !== 'string' || value.trim() === ''
    return typeof value !== 'string' || value.trim() === ''
  })
  if (missing.length > 0) {
    return { ok: false, reason: 'manifest-missing-fields',
      next_action: `补必填字段 ${missing.join(', ')}（最小契约见 27 §3.1）` }
  }
  if (manifest.name !== base.plugin) {
    return { ok: false, reason: 'name-mismatch',
      next_action: `清单里的 name 必须等于目录名「${base.plugin}」（一处一事实：目录即 id）` }
  }
  if (manifest.layer !== base.layer) {
    return { ok: false, reason: 'layer-mismatch',
      next_action: `layer 必须等于所在目录的层「${base.layer}」（层是位置决定的，不是声明出来的）` }
  }
  if (base.layer === 'userspace' && manifest.ns !== base.ns) {
    return { ok: false, reason: 'ns-missing',
      next_action: `userspace 插件必须在清单里声明 ns="${base.ns}"（与目录一致）` }
  }
  const entry = join(base.dir, manifest.entry)
  if (!existsSync(entry)) {
    return { ok: false, reason: 'artifact-missing', next_action: `入口文件不存在：${manifest.entry}（改 entry 或补文件）` }
  }
  return { ok: true, reason: null, next_action: null }
}

/** 找插件（按 id）；找不到给 `unknown-plugin` + **候选列表**。 */
export function findPlugin(scanned, id) {
  const parsed = parsePluginId(id)
  if (parsed === null) {
    return refusal('illegal-layer', id, `插件 id 形状非法：${JSON.stringify(id)}`,
      '写 `层次/插件`（system|domain|userspace；userspace 写 `userspace/<ns>/<plugin>`）',
      { candidates: candidateIds(scanned, id) })
  }
  const hit = scanned.plugins.find((item) => item.id === id)
  if (hit === undefined) {
    return refusal('unknown-plugin', id, `没有这个插件：${id}`,
      '用 `tools/plugin.sh list --json` 看有哪些；目录里没有 plugin.json 的目录不是插件',
      { candidates: candidateIds(scanned, id) })
  }
  if (hit.invalid) {
    return refusal('not-a-plugin', id, `清单不合法（${hit.reason}）：${id}`, hit.next_action)
  }
  return { ok: true, plugin: hit }
}

/** 候选（按层级前缀或名字近似；有界、确定性）。 */
export function candidateIds(scanned, id, limit = 8) {
  const text = String(id ?? '')
  const layer = text.split('/')[0]
  const name = text.split('/').pop()
  const all = scanned.plugins.map((item) => item.id).sort()
  const sameLayer = all.filter((item) => item.startsWith(`${layer}/`))
  const byName = all.filter((item) => item.endsWith(`/${name}`) && !sameLayer.includes(item))
  return [...new Set([...sameLayer, ...byName])].slice(0, limit)
}

/** 服务键 → 提供它的插件（`provides` 是**基础名**；userspace 侧命名空间化为 `<ns>.<plugin>.<svc>`）。 */
export function serviceIndex(scanned) {
  const index = new Map()
  for (const item of scanned.plugins) {
    if (item.invalid) continue
    for (const key of item.manifest.provides ?? []) {
      const full = item.layer === 'userspace' ? `${item.ns}.${item.plugin}.${key}` : key
      for (const name of [key, full]) {
        const list = index.get(name) ?? []
        list.push(item.id)
        index.set(name, list)
      }
    }
  }
  return index
}

/**
 * 依赖闭包（`depends_on` + `inject` 服务键）：返回 `{ok, direct, closure, order, cycle, unresolved, missing}`。
 * 有环 ⇒ `ok:false` + `cycle`（**环上的 id**，不是笼统"有环"）。
 * 目标插件尚未迁移（没有清单）⇒ 记进 `missing`（**不是错误**：诚实标注"依赖方还没搬"）。
 */
export function depsClosure(scanned, id) {
  const services = serviceIndex(scanned)
  const direct = new Map()
  const unresolved = []
  const missing = []
  for (const item of scanned.plugins) {
    const deps = new Set()
    for (const dep of item.manifest?.depends_on ?? []) deps.add(dep)
    for (const key of item.manifest?.inject ?? []) {
      const providers = (services.get(key) ?? []).filter((pid) => pid !== item.id)
      if (providers.length === 0) { unresolved.push({ id: item.id, service: key }); continue }
      for (const pid of providers) deps.add(pid)
    }
    direct.set(item.id, [...deps].sort())
  }
  const known = new Set(scanned.plugins.map((item) => item.id))
  // DFS 三色：白色未访问 / 灰色在栈上 / 黑色已完成；灰色再入栈 = 环。
  const state = new Map()
  const stack = []
  let cycle = null
  const visit = (node) => {
    state.set(node, 'gray')
    stack.push(node)
    for (const next of direct.get(node) ?? []) {
      if (!known.has(next)) { if (!missing.includes(next)) missing.push(next); continue }
      const color = state.get(next) ?? 'white'
      if (color === 'gray' && cycle === null) {
        cycle = stack.slice(stack.indexOf(next)).concat(next)
      } else if (color === 'white') {
        visit(next)
      }
    }
    stack.pop()
    state.set(node, 'black')
  }
  if (known.has(id)) visit(id)
  const order = []
  const seen = new Set()
  const collect = (node) => {
    if (seen.has(node)) return
    seen.add(node)
    order.push(node)
    for (const next of direct.get(node) ?? []) if (known.has(next)) collect(next)
  }
  collect(id)
  const closure = [...direct.get(id) ?? []]
  const transitive = order.filter((node) => node !== id)
  if (cycle !== null) {
    return { ok: false, code: 'dependency-cycle', cycle, direct: direct.get(id) ?? [], closure: transitive,
      order, unresolved, missing }
  }
  return { ok: true, direct: direct.get(id) ?? [], closure: transitive, order, unresolved, missing }
}

/**
 * 解析 cordis（宿主内核）：解析顺序 = `$QUOTAGENT_CORDIS` → `host/node_modules/cordis`（仓库内）→ 裸 `cordis`。
 * 为什么需要这段：阶段 1 宿主依赖仍在 `host/node_modules/`（阶段 4.4 才搬进 `src/system/runtime/`），
 * 而本文件在 `src/` 下，Node 的裸解析上溯不到 `host/node_modules/`（实测量过）。
 */
export async function loadCordis(root) {
  const candidates = []
  if (process.env.QUOTAGENT_CORDIS) candidates.push(process.env.QUOTAGENT_CORDIS)
  candidates.push(join(root, 'host', 'node_modules', 'cordis', 'lib', 'index.js'))
  candidates.push('cordis')
  const tried = []
  for (const candidate of candidates) {
    try {
      const mod = candidate.startsWith('/') || candidate.includes('node_modules')
        ? await import(pathToFileURL(candidate).href)
        : await import(candidate)
      if (typeof mod.Context === 'function') return { ok: true, module: mod, from: candidate }
      tried.push(`${candidate}: 无 Context 导出`)
    } catch (err) {
      tried.push(`${candidate}: ${String(err && err.message).slice(0, 80)}`)
    }
  }
  return { ok: false, code: 'cordis-missing', tried,
    next_action: '宿主内核未就绪：跑 `tools/cordis.sh install`（只在缺失时装）或设 $QUOTAGENT_CORDIS' }
}

/** 入口类型（决定 import 方式与报告里的 `kind`）。 */
export const entryKind = (entry) => (String(entry).endsWith('.mjs') || String(entry).endsWith('.js') ? 'esm'
  : (String(entry).endsWith('.py') ? 'python' : 'unknown'))

export async function createRootContext(root) {
  const cordis = await loadCordis(root)
  if (!cordis.ok) return { ok: false, ...cordis }
  const ctx = new cordis.module.Context()
  if (cordis.module.EventsService) await ctx.plugin(cordis.module.EventsService)
  return { ok: true, ctx, module: cordis.module }
}

/**
 * **真装载**：动态 import 入口 → `ctx.plugin()`。
 * 返回的 `uid` / `state` / `effects` 全部是 cordis 内核实测值；`keys` 是入口模块的真实导出名（排序后）。
 * 依赖未就绪（例如入口用 `ctx.inject` 等一个平台没提供的服务）**不是失败**：`activated` 如实报 false。
 *
 * `ctx`：**共用一个 root Context**（运行时进程里只建一次）——这样 `fiber.uid` 在同一个 registry 里单调递增，
 * `reload` 才拿得到"新实例（新 uid）"（cordis 的 uid 计数器是**每个 registry 各自从 1 开始**的；
 * 每次 `new Context()` 会让两个实例都拿到同一个数字，跨 Context 不可比 —— 见 `host/lib/user-space.mjs` 的口径备忘）。
 */
export async function mount(plugin, { root, config = {}, ctx: context = null } = {}) {
  if (context === null) {
    const created = await createRootContext(root)
    if (!created.ok) return { ...created, id: plugin.id }
    context = created.ctx
  }
  const entryPath = join(plugin.dir, plugin.manifest.entry)
  let mod = null
  try {
    mod = await import(pathToFileURL(entryPath).href)
  } catch (err) {
    return { ok: false, code: 'import-failed', id: plugin.id, entry: plugin.manifest.entry,
      reason: String(err && err.message ? err.message : err).slice(0, 300),
      next_action: `入口 import 失败：修 ${plugin.manifest.entry}（或先用 node --check 看语法）` }
  }
  if (typeof mod.apply !== 'function') {
    return { ok: false, code: 'import-failed', id: plugin.id, entry: plugin.manifest.entry,
      reason: '入口模块没有导出 apply(ctx, config)',
      next_action: 'cordis 插件入口必须导出 apply（Object 形态）；见 27 §7.1' }
  }
  const parsed = typeof mod.Config?.parse === 'function' ? mod.Config.parse(config) : undefined
  let fiber = null
  try {
    fiber = await context.plugin({ name: mod.name ?? plugin.plugin, inject: mod.inject ?? [],
      provides: mod.provides ?? [], Config: mod.Config, apply: mod.apply }, parsed)
  } catch (err) {
    return { ok: false, code: 'mount-failed', id: plugin.id, entry: plugin.manifest.entry,
      reason: String(err && err.message ? err.message : err).slice(0, 300),
      next_action: '装载抛错：先跑该插件自己的围栏门定位（构造合法但装载失败）' }
  }
  const keys = Object.keys(mod).sort()
  const effects = typeof fiber.getEffects === 'function' ? fiber.getEffects() : []
  return { ok: true, id: plugin.id, ctx: context, fiber, mod, keys, entry: plugin.manifest.entry,
    kind: entryKind(plugin.manifest.entry),
    uid: fiber.uid === null || fiber.uid === undefined ? null : String(fiber.uid),
    state: String(fiber.state ?? ''),
    effects: { count: effects.length, labels: effects.map((item) => item.label ?? '').sort() },
    activated: (fiber.inject === undefined || Object.keys(fiber.inject ?? {}).length === 0) }
}

/** **真卸载**：`fiber.dispose()` 之后**回读** effects（归零才算卸载干净）。 */
export async function unmount(handle) {
  const before = typeof handle.fiber.getEffects === 'function' ? handle.fiber.getEffects().length : 0
  await handle.fiber.dispose()
  const after = typeof handle.fiber.getEffects === 'function' ? handle.fiber.getEffects().length : 0
  return { disposed: true, effects_before: before, effects_after: after, zero_effects: after === 0 }
}

/** 仓库根（从本文件上溯：`src/system/runtime/code/` → 仓库根 4 层）。 */
export function repoRootOf(here) {
  return resolve(dirname(here), '..', '..', '..', '..')
}
