/**
 * user-plugin-manager —— **用户空间插件的管理面**（T-268 产物；FR-USERPLUG-008：管理本身也是插件）。
 *
 * 契约（逐字）：`docs/work/plans/p3-spec.json` 的 FR-USERPLUG-001..012 / AC-USERPLUG-001..012；
 * 设计：`docs/design/22-plugin-market-and-user-space.md`；隔离内核：`host/lib/user-space.mjs`；
 * 围栏门：`host/t268-user-space-gate.mjs`（14+ 条断言，含四类反例与 4 处单点变异自证）。
 *
 * 它是什么：`provides: ['userPluginManager']`，把"隔离内核"接成管理面动作 ——
 *   `list()` 只读清单（真源 = `user-space/<ns>/<plugin>/plugin.json`）；
 *   `load/unload/reload` 驱动隔离内核（每个实例一个独立 `Context`，D-060）；
 *   `requestCreate({ns, description})` 只产**待办载荷**（自然语言 → 插件由 agent 侧产出，宿主**不写文件**）；
 *   `elevateRequest(ns, plugin, approvalRef)` 校验人工门引用形状 + 影子哈希一致，产**待办载荷**
 *     （真正写 `host/modules/` 属下一批：ADR-0016 / FR-USERPLUG-010 ⑤）；
 *   `stats()` 只读汇总（**不含任何凭据**）。
 *
 * 纪律（每条都有围栏门的断言看着）：
 *   · **零写面**：本模块不写任何文件、不落账本（H1：宿主不写账本）、不起子进程、不联网、不订阅事件、
 *     不注册定时器、不取墙钟、不随机 —— 落盘与落账本由 Python 侧做（管理面只回待办载荷）；
 *   · **失败不伪装成功**：`load/unload/reload` 一律返回 `{ok:false, code, next_action}` 且**目标未被装载**
 *     （装载失败后 effects 仍为空）；管理面自己被卸载（disposed）后：已装载插件照常运行、列表快照仍可读，
 *     但**新装载一律拒**（`manager-disposed`），绝不返回 `ok:true`；
 *   · **code 必须区分**：`user-space-outside-ns` / `user-plugin-not-elevated` / `manifest-invalid` /
 *     `plugin-not-found` / `already-loaded` / `not-loaded` / `manager-disposed`；
 *   · **有界**：`scan` 先按内核上限夹取，管理面再按 `max_plugins` 夹取；`counts.plugins` 是**夹取前**的真值
 *     （展示可以有界，数字不许悄悄变小）；`max_bytes` 夹取清单里的字符串字段；
 *   · **降级优先**：`root` 没配 / 不是目录 / 读不出来 → `degraded:true` + `reason` + `next_action`，
 *     形状与正常输出一致；**零插件 ≠ 读不到**（前者 `degraded:false` 且列表为空）。
 *
 * 与内核的分工：本模块**不重复实现**隔离判定（命名空间键 / 文件根 / 凭据作用域 / 提权门槛都在
 * `host/lib/user-space.mjs`），只负责"管理面动作 + 留痕 + 有界视图"。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { number, object, string } from '../lib/std-schema.mjs'
import { ENTRY, MANIFEST, NAME_RE, RESERVED_SERVICES, loadPlugin, reload as reloadInstance, scan } from '../lib/user-space.mjs'

export const name = 'user-plugin-manager'
export const inject = []            // 管理面不消费平台服务：隔离内核只按自己的 root 工作
export const builtin = []
export const usedServices = []
export const provides = ['userPluginManager']

export const Config = object({
  root: string().default(''),          // 用户空间根目录（`user-space/`；空 = 未配置 → 降级，不冒充健康）
  max_plugins: number().default(50),   // 管理面一次列出的插件数上限（有界）
  max_bytes: number().default(256),    // 清单里字符串字段的 UTF-8 字节上限（有界）
})

/** 管理面动作名（门据此断言句柄键**恰好**这些）。 */
export const ACTIONS = ['list', 'load', 'unload', 'reload', 'requestCreate', 'elevateRequest', 'stats']
/** 拒绝码白名单（与内核同表；门断言这些码都能被造出来）。 */
export const REFUSAL_CODES = ['user-space-outside-ns', 'artifact-outside-write-surface', 'user-plugin-not-elevated',
  'manifest-invalid', 'plugin-not-found', 'already-loaded', 'not-loaded', 'manager-disposed', 'load-failed']
/** 待办载荷的 `kind`（落盘/落账本由 Python 侧做）。 */
export const REQUEST_KIND_CREATE = 'plugin-request'
export const REQUEST_KIND_ELEVATE = 'plugin-elevation-request'
/** 提权引用的形状（人工门；与内核 `APPROVAL_RE` 同一口径）。 */
export const APPROVAL_RE = /^ap-\d{4}$/
/** 提权的写入面（本批**不写**，只把 target 报出来）。 */
export const PROMOTE_DIR = ['host', 'modules']

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))
const posix = (path) => String(path).split('\\').join('/')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 配置夹取：非有限数回落到默认值，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符，结果字节数必然 ≤ maxBytes）。 */
const clip = (text, maxBytes) => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** 拒绝载荷：与成功载荷**同形**（`ok`/`code`/`next_action` 三件套是契约，其余是给门的证据）。 */
const refusal = (code, reason = '', extra = {}) => ({ ok: false, code, reason: reason || code,
  next_action: NEXT_ACTIONS[code] ?? '', ...extra })

const NEXT_ACTIONS = {
  'user-space-outside-ns': '写面/装载面只有 user-space/<ns>/<plugin>/：把目标改回本插件目录',
  'artifact-outside-write-surface': '自进化的可写面只有 host/modules/：不要把 target 指到 user-space/',
  'user-plugin-not-elevated': '跨 ns 装载需要先提权（管理员走人工门 + 影子哈希一致）',
  'manifest-invalid': '先修好 plugin.json（形状与必填字段），再装载',
  'plugin-not-found': '确认 ns/plugin 名与 user-space/ 下的目录一致',
  'already-loaded': '先 unload 再 load（要换新实例用 reload）',
  'not-loaded': '该插件当前没有装载（先 load）',
  'manager-disposed': '管理面插件已被卸载：已装载的插件照常运行，新装载需要重新装配管理面',
  'load-failed': '装载抛错：看返回的 reason（本模块把失败如实报出，不伪装成功）',
  'elevate-needs-approval': '先拿人工引用（approval_ref，形状 ap-0000）再提权',
  'elevate-tampered': '影子产物哈希与清单声明不一致：按被改动处理，重新产出后再提权',
}

/** 管理面挂载一次、服务一个 root；**每个动作都从当前磁盘状态出发**（不缓存判定）。 */
export function apply(ctx, config) {
  const root = typeof config?.root === 'string' ? config.root.trim() : ''
  const maxPlugins = clampInt(config?.max_plugins, 50, 0, 100000)
  const maxBytes = clampInt(config?.max_bytes, 256, 0, 1048576)
  const loaded = new Map()               // `${ns}/${plugin}` → {handle, unload, uid}
  const events = []                      // 留痕（有界）：落账本由 Python 侧做（H1）
  const counters = { loads: 0, unloads: 0, reloads: 0, refusals: 0, create_requests: 0, elevation_requests: 0 }
  let disposed = false
  const keyOf = (ns, plugin) => `${ns}/${plugin}`
  const record = (event) => {
    if (events.length < 512) events.push(event)
    if (event?.kind === 'userplugin/refused') counters.refusals += 1
    return event
  }
  const refuse = (code, reason = '', extra = {}) => {
    const payload = refusal(code, reason, extra)
    record({ kind: 'userplugin/refused', code: payload.code, reason: payload.reason,
      next_action: payload.next_action, ...(extra.ns === undefined ? {} : { ns: extra.ns }),
      ...(extra.plugin === undefined ? {} : { plugin: extra.plugin }) })
    return { ok: false, code: payload.code, next_action: payload.next_action }
  }
  /** 管理面被卸载后：只读动作照常，**新装载一律拒**（拒绝不伪装成功）。 */
  const acting = (action) => (disposed ? refuse('manager-disposed', `after-dispose:${action}`) : null)

  const list = () => {
    const found = scan(root)
    const shownNs = found.namespaces.slice(0, maxPlugins)
    let clipped = 0
    const namespaces = shownNs.map((entry) => ({
      ns: entry.ns,
      plugins: entry.plugins.map((item) => {
        const name = clip(String(item.name), maxBytes)
        if (name !== item.name) clipped += 1
        return { name, ns: entry.ns, version: clip(String(item.version ?? ''), maxBytes),
          dir: clip(String(item.dir ?? ''), maxBytes), sha256: String(item.sha256 ?? ''),
          invalid: item.invalid === true, reason: String(item.reason ?? ''),
          loaded: loaded.has(keyOf(entry.ns, item.name)) }
      }),
    }))
    const omittedNotes = found.namespaces.length - shownNs.length
    return {
      namespaces,
      counts: { plugins: found.counts.plugins, loaded: loaded.size, invalid: found.counts.invalid },
      degraded: found.degraded,
      reason: found.reason,
      next_action: found.next_action,
      truncated: found.truncated || omittedNotes > 0 || clipped > 0,
      omitted: found.omitted + omittedNotes,
      clipped,
    }
  }

  const load = async (ns, plugin) => {
    const blocked = acting('load')
    if (blocked) return blocked
    if (!NAME_RE.test(String(ns)) || !NAME_RE.test(String(plugin))) {
      return refuse('user-space-outside-ns', 'namespace-or-plugin-name-invalid', { ns, plugin })
    }
    const key = keyOf(ns, plugin)
    if (loaded.has(key)) return refuse('already-loaded', `already-loaded:${key}`, { ns, plugin })
    const outcome = await loadPlugin(ctx, { root, ns, plugin, onEvent: record })
    if (!outcome.handle) {
      return { ok: false, code: outcome.refusal.code, next_action: outcome.refusal.next_action }
    }
    loaded.set(key, { handle: outcome.handle, unload: outcome.unload, uid: outcome.handle.uid })
    counters.loads += 1
    return { ok: true, code: '', next_action: '', uid: outcome.handle.uid, effects: outcome.handle.effects() }
  }

  const unload = async (ns, plugin) => {
    if (!NAME_RE.test(String(ns)) || !NAME_RE.test(String(plugin))) {
      return refuse('user-space-outside-ns', 'namespace-or-plugin-name-invalid', { ns, plugin })
    }
    const key = keyOf(ns, plugin)
    const entry = loaded.get(key)
    if (!entry) return refuse('not-loaded', `not-loaded:${key}`, { ns, plugin })
    const outcome = await entry.unload()
    loaded.delete(key)
    counters.unloads += 1
    return { ok: true, code: '', next_action: '', uid: entry.uid, effects: outcome.effects ?? 0 }
  }

  const reload = async (ns, plugin) => {
    const blocked = acting('reload')
    if (blocked) return blocked
    const key = keyOf(ns, plugin)
    const entry = loaded.get(key)
    if (!entry) return refuse('not-loaded', `not-loaded:${key}`, { ns, plugin })
    const previous = entry.uid
    const outcome = await reloadInstance(entry.handle, { root, onEvent: record })
    if (!outcome.handle) {
      loaded.delete(key)
      return { ok: false, code: outcome.refusal.code, next_action: outcome.refusal.next_action }
    }
    loaded.set(key, { handle: outcome.handle, unload: outcome.unload, uid: outcome.handle.uid })
    counters.reloads += 1
    return { ok: true, code: '', next_action: '', uid: outcome.handle.uid, previous_uid: previous,
      effects: outcome.handle.effects(), previous_effects: outcome.previous_effects }
  }

  /** 自然语言 → 待办载荷：**不写文件**（产出插件是 agent 侧的事，宿主只登记请求）。 */
  const requestCreate = (request) => {
    const ns = isPlain(request) ? request.ns : null
    const description = isPlain(request) ? request.description : null
    if (typeof ns !== 'string' || !NAME_RE.test(ns.trim())) {
      return refusal('user-space-outside-ns', 'namespace-invalid')
    }
    if (typeof description !== 'string' || description.trim() === '') {
      return refusal('manifest-invalid', 'description-empty')
    }
    counters.create_requests += 1
    return { kind: REQUEST_KIND_CREATE, ns: ns.trim(), description_sha256: sha256(description),
      bytes: Buffer.byteLength(description, 'utf8') }
  }

  const entryOf = (ns, plugin) => {
    const found = scan(root)
    for (const entry of found.namespaces) {
      if (entry.ns !== ns) continue
      for (const item of entry.plugins) if (item.name === plugin) return item
    }
    return null
  }

  /** 提权申请：人工门引用形状 + 影子哈希一致 → 待办载荷（**本批不写 `host/modules/`**）。 */
  const elevateRequest = (ns, plugin, approvalRef) => {
    if (typeof approvalRef !== 'string' || !APPROVAL_RE.test(approvalRef.trim())) {
      return refusal('elevate-needs-approval', typeof approvalRef === 'string' && approvalRef.trim() !== ''
        ? 'approval-ref-malformed' : 'approval-ref-missing', { ns, plugin })
    }
    if (!NAME_RE.test(String(ns)) || !NAME_RE.test(String(plugin))) {
      return refusal('user-space-outside-ns', 'namespace-or-plugin-name-invalid', { ns, plugin })
    }
    const entry = entryOf(ns, plugin)
    if (entry === null) return refusal('plugin-not-found', `plugin-not-found:${keyOf(ns, plugin)}`, { ns, plugin })
    if (entry.invalid === true && entry.reason !== 'artifact-hash-mismatch') {
      return refusal('manifest-invalid', `entry-invalid:${entry.reason}`, { ns, plugin })
    }
    // 影子哈希：扫描是**每次现读**的（不缓存判定）→ 产物被改动即 `elevate-tampered`
    const declared = isPlain(entry.manifest) && typeof entry.manifest.sha256 === 'string'
      ? entry.manifest.sha256.trim().toLowerCase() : ''
    if (declared === '' || declared !== String(entry.sha256 ?? '').toLowerCase()) {
      return refusal('elevate-tampered', declared === '' ? 'manifest-hash-missing' : 'shadow-hash-mismatch',
        { ns, plugin })
    }
    const moduleName = isPlain(entry.manifest) && typeof entry.manifest.name === 'string' && entry.manifest.name
      ? entry.manifest.name : plugin
    counters.elevation_requests += 1
    return {
      kind: REQUEST_KIND_ELEVATE,
      ok: true,
      code: '',
      ns,
      plugin,
      approval_ref: approvalRef.trim(),
      manifest_sha256: declared,
      target: posix([...PROMOTE_DIR, `${moduleName}.mjs`].join('/')),
      bytes: Buffer.byteLength(String(entry.sha256 ?? ''), 'utf8'),
      // 写入属下一批：本批只回载荷（人工门 + ADR-0016 五条 AND 真跑 + 补 14 登记行都由后续批次落）
      next_action: '写入 host/modules/ 属下一批（ADR-0016 晋升链）：本批只产出待办载荷',
      written: false,
    }
  }

  /** 只读汇总；**不含凭据**（门断言输出里既没有 `cred:` 也没有作用域内的值）。 */
  const stats = () => {
    const found = scan(root)
    return {
      root: root === '' ? '' : posix(root),
      root_configured: root !== '',
      namespaces: found.counts.namespaces,
      plugins: found.counts.plugins,
      invalid: found.counts.invalid,
      loaded: loaded.size,
      loaded_keys: [...loaded.keys()].sort(byName),
      // 已装载实例的**只读**描述（uid + effect 数 + 服务键）：管理面卸载后据此仍能看出"插件还在跑"
      instances: [...loaded.entries()].sort((left, right) => byName(left[0], right[0]))
        .map(([key, entry]) => ({ key, uid: entry.uid, ns: entry.handle.ns, plugin: entry.handle.plugin,
          effects: typeof entry.handle.effects === 'function' ? entry.handle.effects() : 0,
          service_keys: [...entry.handle.serviceKeys] })),
      degraded: found.degraded,
      reason: found.reason,
      truncated: found.truncated,
      omitted: found.omitted,
      limits: { max_plugins: maxPlugins, max_bytes: maxBytes, reserved_services: RESERVED_SERVICES.length },
      resume: { ...counters, manager_disposed: disposed },
      entry: { manifest: MANIFEST, artifact: ENTRY },
      events: events.length,
    }
  }

  ctx.provide('userPluginManager', {
    config: () => ({ root: posix(root), max_plugins: maxPlugins, max_bytes: maxBytes }),
    list, load, unload, reload, requestCreate, elevateRequest, stats,
    /** 留痕视图（Python 侧据此落账本：`userplugin/refused` 带 code + next_action）。 */
    events: () => events.map((item) => ({ ...item })),
  })
  // 管理面被卸载：标记 disposed（已装载的用户空间插件**照常运行**，只是不再有新装载）
  ctx.effect(() => () => {
    disposed = true
    record({ kind: 'userplugin/manager-disposed', loaded: loaded.size, at: counters.loads })
  })
}

/** fixture：纯读取（挂载一次、连跑两次比对字节；root 给 fixture 自己的目录，**零写面**）。 */
export const fixture = {
  sample: (handle) => ({
    list: handle.list(),
    again: handle.list(),
    stats: handle.stats(),
  }),
}
