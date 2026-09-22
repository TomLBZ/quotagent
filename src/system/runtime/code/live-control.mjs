/**
 * live-control —— **运行中服务的插件装卸面**（`src/system/runtime/` 的 code/，阶段 5.2+ 的收口件）。
 *
 * 它解决什么问题（用户原话的直译）：「被 agent 动态读取 / 重载 / 使用 / 卸载」——在**长驻的 WebUI 进程**里，
 * 而不是在"另起一个 proc 跑 import"里。阶段 1 的 `tools/plugin-lifecycle.mjs` 已经能把插件挂进一个
 * **独立的常驻运行时进程**（`tmp/plugin-runtime/`），但它不是"正在服务用户请求的那个进程"：
 * 装载事实活不到页面上。本文件把同一条接口接到**宿主自身的 ctx** 上，于是：
 *   · 装进来的插件与宿主**同一个 ctx 树**（因此能看到 `uiSlots` / `uiRoutes` 这些注册面）；
 *   · 它注册的 UI 区块**真的出现在页面上**（`data-ui-block=…`）；
 *   · 卸掉之后区块消失，且**页面其余部分逐字节不变**（门 L 段用 sha256 对比 —— 这正是
 *     `docs/work/plans/plugin-migration-plan.md` §5.3 那条判据）。
 *
 * 规则真源：`docs/design/27-plugin-architecture.md` §4（六动词）/§6（注入式 UI）；契约：
 * `src/system/runtime/docs/lifecycle-contract.md` §4（运行期装卸）。
 *
 * 机制复用（**不重造**）：扫描/校验/依赖闭包/真装载/真卸载全部走 `plugin-registry.mjs` ——
 * 本文件只加三样东西：① 控制通道（HTTP，注册到 `uiRoutes` 而不是改 webui.mjs）；② 围栅；③ 逐条回执。
 *
 * 围栅（**四道，全部 fail-closed**；"防 agent 误操作"是设计目标，不是文档纪律）：
 *   ① 控制令牌：`QUOTAGENT_PLUGIN_CONTROL_TOKEN`（或 0600 文件）**没配 = 整条通道关闭**
 *      （`plugin-control-disabled`；不是"默认开放"）；令牌比对用 sha256 + `timingSafeEqual`，不回显、不落盘；
 *   ② 显式确认：改名动作（load/reload/unload）必须带 `confirm:true`，否则 `confirmation-required`；
 *   ③ 层锁定：`system/**`（宿主 harness 自己）不许热插拔 ⇒ `layer-locked`（把自己换掉会连控制通道一起没了）；
 *   ④ 只认显式动词与显式 id：未知动词 / 未注册的路由一律有名拒绝，不猜、不通配。
 *
 * 零写面（静态负控逐条扫）：不写文件、不写账本、不联网（**只回环**由 webui 承担）、不取随机、不读墙钟、
 * 不注册定时器。唯一"副作用"是宿主 ctx 里的 in-memory 装载事实 —— 与 `plugin.json.permissions` 的
 * `ledger: "none"` 一致。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { depsClosure, findPlugin, mount, scan, unmount } from './plugin-registry.mjs'

/** 本插件的服务键（宿主据此 inject；同时也是"控制面存在"的自证）。 */
export const provides = ['livePluginControl']
export const name = 'live-control'
export const inject = []
export const builtin = []
export const usedServices = ['uiRoutes']

/** 控制动词（与 `tools/plugin.sh` 的六动词同一套取值；`deps` 是只读闭包，不做装卸）。 */
export const VERBS = ['list', 'status', 'load', 'reload', 'unload', 'deps']
/** 会改宿主 ctx 的动词（必须带 `confirm:true`）。 */
export const MUTATING = ['load', 'reload', 'unload']
/** 不许热插拔的层（宿主 harness 自己；换掉它连控制通道一起消失）。 */
export const LOCKED_LAYERS = ['system']

/** 控制通道的拒绝码（闭合集合；门逐条断言"拒绝是有名的"）。 */
export const CONTROL_CODES = ['plugin-control-disabled', 'plugin-control-unauthorized', 'confirmation-required',
  'layer-locked', 'unknown-verb', 'unknown-plugin', 'not-a-plugin', 'illegal-layer', 'already-loaded',
  'not-loaded', 'mount-failed', 'import-failed', 'dependency-cycle', 'route-unavailable']

/** 令牌来源（**只报来源，不回显**）：env 优先 → 0600 文件 → 都没有 = 通道关闭。 */
export const TOKEN_ENV = 'QUOTAGENT_PLUGIN_CONTROL_TOKEN'
export const TOKEN_FILE_ENV = 'QUOTAGENT_PLUGIN_CONTROL_TOKEN_FILE'

/**
 * 解析控制令牌（**只读、不回显**）：
 *   ① `$QUOTAGENT_PLUGIN_CONTROL_TOKEN`（编排注入）；
 *   ② `$QUOTAGENT_PLUGIN_CONTROL_TOKEN_FILE`（缺省 `<root>/../config/quotagent-plugin-control-token`），
 *      **权限必须恰为 0600**（否则视为没配 —— fail-closed，与管理员 token 同一口径）。
 * @returns `{token, source}`；`token === ''` 表示通道关闭。
 */
export function resolveToken({ env = process.env, root = '' } = {}) {
  const fromEnv = String(env[TOKEN_ENV] ?? '').trim()
  if (fromEnv !== '') return { token: fromEnv, source: 'env' }
  const path = String(env[TOKEN_FILE_ENV] ?? '') .trim()
    || join(resolve(root || '.'), '..', 'config', 'quotagent-plugin-control-token')
  try {
    const mode = statSync(path).mode & 0o777
    if (mode !== 0o600) return { token: '', source: `file:mode-${mode.toString(8)}-refused`, path }
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? { token: '', source: 'file:empty', path } : { token: text, source: 'file:0600', path }
  } catch {
    return { token: '', source: 'absent', path }
  }
}

const refusal = (code, reason, next_action, extra = {}) =>
  ({ ok: false, code, reason, next_action, ...extra })

const digestOf = (text) => createHash('sha256').update(String(text), 'utf8').digest()

/** 令牌比对（**常量时间**：比 digest，不比原文；长度不同也走同一条路径）。 */
export function tokenMatches(given, expected) {
  if (typeof expected !== 'string' || expected === '') return false
  try {
    return timingSafeEqual(digestOf(given ?? ''), digestOf(expected))
  } catch {
    return false
  }
}

/**
 * 围栅（**纯函数**：门直接驱动它做负控，不需要起服务）。
 * @returns `{ok:true}` 或 `{ok:false, code, reason, next_action}`
 */
export function fence({ headers = {}, body = {}, token = '' } = {}) {
  if (typeof token !== 'string' || token === '') {
    return refusal('plugin-control-disabled',
      '运行期装卸通道**默认关闭**：机器上没有配置控制令牌',
      `配置控制令牌后重启服务：0600 文件 <root>/../config/quotagent-plugin-control-token 或 env ${TOKEN_ENV}；`
      + '（不配 = 这条通道整体不存在，任何 load/reload/unload 都不发生）')
  }
  const given = headers['x-plugin-control-token'] ?? headers['X-Plugin-Control-Token'] ?? ''
  if (String(given) === '') {
    return refusal('plugin-control-unauthorized', '缺少 X-Plugin-Control-Token 头',
      `带上控制令牌头（值取自 ${TOKEN_ENV} 或那个 0600 文件；令牌永不回显）`)
  }
  if (!tokenMatches(String(given), token)) {
    return refusal('plugin-control-unauthorized', '控制令牌不匹配',
      '确认用的是这台机器的控制令牌（只比 sha256 摘要；令牌不落盘、不回显）')
  }
  const verb = String(body.verb ?? '')
  if (!VERBS.includes(verb)) {
    return refusal('unknown-verb', `未知动词：${JSON.stringify(body.verb ?? null)}`,
      `用 ${VERBS.join(' | ')} 之一（工具的薄入口是 tools/plugin.sh <动词> <插件> --live）`)
  }
  if (MUTATING.includes(verb) && body.confirm !== true) {
    return refusal('confirmation-required', `${verb} 会改运行中服务的装配：必须显式确认`,
      '带 {"confirm":true}（`tools/plugin.sh <动词> <插件> --live` 已默认带上；裸 curl 必须自己写）')
  }
  return { ok: true, verb }
}

/** 层锁：`system/**` 不许热插拔（id 形状非法交给 `findPlugin`，这里只管层）。 */
export function lockedLayer(id) {
  const layer = String(id ?? '').split('/')[0]
  return LOCKED_LAYERS.includes(layer) ? layer : null
}

/** 拒绝码 → HTTP 状态（回执语义：能区分的必须区分，不许一律 200）。 */
export const statusFor = (code) => {
  if (code === 'plugin-control-disabled') return 503
  if (code === 'route-unavailable') return 503
  if (code === 'plugin-control-unauthorized' || code === 'layer-locked') return 403
  if (code === 'unknown-plugin') return 404
  if (code === 'confirmation-required' || code === 'already-loaded' || code === 'not-loaded'
    || code === 'dependency-cycle' || code === 'not-a-plugin') return 409
  if (code === 'unknown-verb' || code === 'illegal-layer') return 400
  return 500
}

/** 一条命令能到哪儿（给人看的 next_action；来源永远是"这台机器现在能查到的"）。 */
export const nextActionFor = (verb, id, root) => (MUTATING.includes(verb)
  ? `装载事实只在运行中服务的 ctx 里（内存）：${verb} 之后用 \`tools/plugin.sh status ${id} --live\` 回读 uid/effects`
  : `只读动词：要改装配用 load/reload/unload（带上 --live）；插件目录真源是 ${root}/src/<层>/<插件>/`)

/**
 * 控制通道的请求处理（**机制**；不含任何业务判断）。
 * @param ctx 宿主 ctx（注册者被挂在这里 —— 它必须能看见 `uiSlots`/`uiRoutes`）
 */
export function createControl({ ctx, root, loaded = new Map(), seq = new Map() } = {}) {
  const list = () => [...loaded.keys()].sort().map((id) => {
    const record = loaded.get(id)
    return { id, uid: record.uid, instance: record.instance, effects: record.handle?.effects?.count ?? null,
      entry: record.entry }
  })

  /** 动词分发（**同步返回结果体**，宿主负责写 HTTP 响应）。 */
  const dispatch = async (body) => {
    const verb = String(body.verb ?? '')
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : null
    if (verb === 'list') {
      return { ok: true, verb, control: 'live', root, loaded: list(),
        next_action: nextActionFor(verb, id ?? '', root) }
    }
    if (id === null) {
      return refusal('unknown-verb', `${verb} 需要插件 id`,
        '写 `层次/插件`（userspace 写 `userspace/<ns>/<plugin>`）')
    }
    const locked = lockedLayer(id)
    if (locked !== null) {
      return refusal('layer-locked', `${locked} 层不许热插拔：${id}`,
        '宿主 harness 自己不在运行期装卸面上（换掉它连控制通道一起消失）；'
        + 'system 层要改就走 `tools/plugin.sh` 的常驻运行时进程 + 重启服务')
    }
    const scanned = scan(root)
    const found = findPlugin(scanned, id)
    if (!found.ok) return { ...found, verb }
    const plugin = found.plugin
    if (verb === 'deps') {
      const closure = depsClosure(scanned, plugin.id)
      return { ok: closure.ok, verb, id: plugin.id, code: closure.ok ? null : 'dependency-cycle',
        direct: closure.direct, cycle: closure.cycle ?? null,
        missing_targets: closure.missing, unresolved_services: closure.unresolved,
        next_action: closure.ok ? '依赖闭包已给出（顺序即拓扑序）'
          : `环：${(closure.cycle ?? []).join(' → ')}` }
    }
    if (verb === 'status') {
      const record = loaded.get(plugin.id)
      return { ok: true, verb, id: plugin.id, control: 'live', loaded: record !== undefined,
        uid: record?.uid ?? null, instance: record?.instance ?? null,
        effects: record?.handle?.effects?.count ?? 0,
        effects_labels: record?.handle?.effects?.labels ?? [],
        entry: plugin.manifest.entry, provides: plugin.manifest.provides,
        last_error: record?.last_error ?? null,
        next_action: record === undefined
          ? `未装载（运行中服务里没有它的实例）：\`tools/plugin.sh load ${plugin.id} --live\``
          : '已装载（装载事实在运行中服务的 ctx 里，内存态；重启服务即消失）' }
    }
    if (verb === 'unload') {
      const record = loaded.get(plugin.id)
      if (record === undefined) {
        return refusal('not-loaded', `未装载：${plugin.id}`,
          `先 \`tools/plugin.sh load ${plugin.id} --live\`（重复 unload 就是这条 not-loaded）`)
      }
      const verdict = await unmount(record.handle)
      loaded.delete(plugin.id)
      return { ok: true, verb, id: plugin.id, control: 'live', from_uid: record.uid,
        effects_before: verdict.effects_before, effects_after: verdict.effects_after,
        zero_effects: verdict.zero_effects, effects: 0, loaded: false,
        next_action: verdict.zero_effects
          ? '已从运行中服务卸下，effects 归零（区块/路由随之从页面上消失；页面其余部分逐字节不变）'
          : '卸载后 effects 不为 0：真残留，必须查（AC-PLUGIN-001）' }
    }
    if (verb === 'reload' && loaded.get(plugin.id) === undefined) {
      return refusal('not-loaded', `未装载：${plugin.id}`,
        'reload 的语义是"先卸后装"：先 load 一次（`--live`）')
    }
    let fromUid = null
    let fromEffects = null
    if (verb === 'reload') {
      const previous = loaded.get(plugin.id)
      fromUid = previous.uid
      fromEffects = previous.handle?.effects?.count ?? null
      const verdict = await unmount(previous.handle)
      loaded.delete(plugin.id)
      if (!verdict.zero_effects) {
        return refusal('mount-failed', `重载前卸载未归零 effects（before=${verdict.effects_before}）`,
          '查该插件的 ctx.effect 是否有未返回 disposer 的注册')
      }
    } else if (loaded.get(plugin.id) !== undefined) {
      return refusal('already-loaded', `已在装载：${plugin.id}`,
        `要得到新实例用 \`tools/plugin.sh reload ${plugin.id} --live\`（reload = 先卸后装）`)
    }
    const mounted = await mount(plugin, { root, config: body.config ?? {}, ctx })
    if (!mounted.ok) return { ...mounted, verb, id: plugin.id }
    seq.set(plugin.id, (seq.get(plugin.id) ?? 0) + 1)
    const instance = `${plugin.id}#${seq.get(plugin.id)}`
    loaded.set(plugin.id, { handle: mounted, uid: mounted.uid, instance, entry: plugin.manifest.entry })
    return { ok: true, verb, id: plugin.id, control: 'live', layer: plugin.layer,
      uid: mounted.uid, from_uid: fromUid, from_effects: fromEffects, instance,
      effects: mounted.effects.count, effects_labels: mounted.effects.labels,
      entry: mounted.entry, keys: mounted.keys, provides: plugin.manifest.provides,
      next_action: `装载事实在**运行中服务**里：\`tools/plugin.sh status ${plugin.id} --live\` 回读；`
        + '重载用 reload（新 uid、不迁移内存状态）；卸掉用 unload（effects 必须归零）' }
  }

  return { list, dispatch }
}

// ---------------------------------------------------------------------------------------------
// 插件装配：把控制通道注册到宿主的路由注册面（**不改 webui.mjs**）
// ---------------------------------------------------------------------------------------------
export const Config = undefined

/**
 * 装配：
 *   · `config.root` = 仓库根（扫描插件用）；`config.route_path` 缺省 `/api/plugins/control`；
 *   · 通过 `ctx.inject(['uiRoutes'], …)` 注册路由（**动态依赖**：注册面不在就整块不生效 —— 不假装有控制面）；
 *   · 装载进来的插件挂在本模块的 scope 里（宿主 ctx 树内 ⇒ 能看到 `uiSlots`，区块才上得了页面）。
 */
export const apply = (ctx, config = {}) => {
  const root = resolve(String(config.root ?? process.cwd()))
  const routePath = String(config.route_path ?? '/api/plugins/control')
  const loaded = new Map()
  const seq = new Map()
  ctx.inject(['uiRoutes'], (scope) => {
    const control = createControl({ ctx: scope, root, loaded, seq })
    scope.effect(() => {
      const verdict = scope.uiRoutes.register({
        path: routePath,
        method: 'POST',
        auth: 'control-token',
        what: '运行期插件装卸（load/reload/unload/status/list/deps；围栅：控制令牌 + 显式确认 + '
          + 'system 层锁定；只改宿主内存装配，零写面）',
        handler: (request) => Promise.resolve().then(async () => {
          const expected = resolveToken({ root })
          const raw = await new Promise((done) => request.readBody(done))
          let body = {}
          try {
            const parsed = JSON.parse(String(raw ?? '')) 
            body = parsed !== null && typeof parsed === 'object' ? parsed : {}
          } catch {
            return request.json(400, { ok: false, code: 'unknown-verb', verb: null,
              reason: '请求体必须是 JSON（{"verb":…,"id":…,"confirm":true}）',
              next_action: '用 `tools/plugin.sh <动词> <插件> --live`（它就是那个客户端）' })
          }
          const verdict = fence({ headers: request.req.headers ?? {}, body, token: expected.token })
          if (!verdict.ok) {
            return request.json(statusFor(verdict.code), { ...verdict, verb: body.verb ?? null,
              id: body.id ?? null, control: 'live', token_source: expected.source })
          }
          const out = await control.dispatch(body)
          const code = out.ok === true ? 200 : statusFor(out.code)
          return request.json(code, { ...out, token_source: expected.source })
        }),
      })
      return verdict.ok === true ? verdict.dispose : () => {}
    })
  })
  // 纪律：**不返回任何值** —— cordis 把 `apply` 的返回值当 effect 处理（返回普通对象 = `TypeError: Invalid effect`，
  // 实测踩过）。装配信息走 stdout/stderr 与 `status` 动词，不从 apply 返回。
  return undefined
}
