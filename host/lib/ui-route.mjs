/**
 * ui-route —— 注入式 UI 的**路由注册面机制**（通用件：只知道"有条路由被注册在某个路径上"，
 * 不知道它是什么、给谁用）。
 *
 * 为什么需要它：`docs/design/27-plugin-architecture.md` §6.1 把"路由注册"列为 WebUI 必须提供的注册面之一
 * （与槽位并列）。没有它，插件想加一条 HTTP 路由就只能去改 `webui.mjs` —— 那正是"webui 耦合业务"的入口。
 * 规则真源：27 §6；决策：ADR-0020 §5；姊妹机制：`host/lib/ui-slot.mjs`（区块）。
 *
 * 本文件是**机制**，零业务语义、**零写面**：
 *   · 不认识任何插件 id、任何领域名词（门 `plugin-lifecycle` 的静态负控逐行扫这一条）；
 *   · 只做四件事：**校验**注册形状、**查表**（路径 + 方法，精确匹配，不做正则/通配）、
 *     **列举**（供 `/api/routes` 把动态路由与静态路由登记在同一张表里）、**指名报错**；
 *   · 不写文件、不读账本、不联网、不取墙钟、不用随机数、不注册定时器。
 *
 * 纪律（结构性，不靠评审）：
 *   · 路径必须**相对前缀**、以 `/` 开头、不含空白/`?`/`#`/`*`（不做通配，避免"哪条路由先匹配"的隐式语义）；
 *   · 同一 `(方法, 路径)` 重复注册且形状相同 ⇒ 幂等（`already-registered`）；形状不同 ⇒ `duplicate-route`（**拒**，不悄悄覆盖）；
 *   · 处理器不是函数 ⇒ `invalid-handler`；路径形状不对 ⇒ `illegal-path`；方法不在闭合集合里 ⇒ `illegal-method`；
 *   · 注册表 dispose 之后注册 ⇒ `route-disposed`（卸载不留后门）。
 */

/** 允许的方法（闭合集合；`GET` 只读、`POST` 写）。 */
export const METHODS = ['GET', 'POST']

/** 拒收原因码（闭合集合；门逐条断言"拒绝是有名的"）。 */
export const REFUSAL_CODES = ['illegal-path', 'illegal-method', 'invalid-handler', 'duplicate-route',
  'route-disposed']

/** 路径形状：相对前缀、单段或多段、不允许通配/查询/空白。 */
export const PATH_RE = /^\/[A-Za-z0-9._~\/-]*$/
/** `what` 的长度上限（它是给人看的说明，不是正文载体）。 */
export const WHAT_MAX = 200

const code = (name, reason, next_action) => ({ ok: false, code: name, reason, next_action })
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 建一个路由注册表。
 * 返回的 API 全是**纯机制**：
 *   `register(entry)` / `unregister(method, path)` / `has(method, path)` /
 *   `match(path, method)` / `size()` / `list()` / `dispose()`
 */
export function createRouteRegistry() {
  /** key = `${method} ${path}` → {method, path, what, auth, handler} */
  const entries = new Map()
  let disposed = false

  const keyOf = (method, path) => `${method} ${path}`

  /**
   * 注册一条路由。
   * @param entry `{path, method, handler, what, auth}`（`what`/`auth` 缺省给空串，便于登记表打印）
   * @returns `{ok:true, code:'registered'|'already-registered', key, method, path, dispose}` 或拒收体
   */
  const register = (entry) => {
    if (disposed) {
      return code('route-disposed', '注册表已释放', '重新挂载宿主后再注册（dispose 之后注册一律拒）')
    }
    if (!plainObject(entry)) {
      return code('illegal-path', '注册载荷不是对象', 'register({path, method, handler, what})')
    }
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!PATH_RE.test(path) || path.includes('//')) {
      return code('illegal-path', `路径形状不合法：${JSON.stringify(entry.path)}`,
        '路径必须相对前缀、以 `/` 开头、只含 [A-Za-z0-9._~/-]（不做通配，不做正则）')
    }
    const method = typeof entry.method === 'string' ? entry.method.trim().toUpperCase() : ''
    if (!METHODS.includes(method)) {
      return code('illegal-method', `方法不在闭合集合里：${JSON.stringify(entry.method)}`,
        `用 ${METHODS.join(' / ')} 之一（只读用 GET，写用 POST）`)
    }
    if (typeof entry.handler !== 'function') {
      return code('invalid-handler', 'handler 必须是函数（收到请求时被调用）',
        'handler: (request) => 已写好响应；拿不到数据时也要给有名 code + next_action')
    }
    const what = typeof entry.what === 'string' ? entry.what.slice(0, WHAT_MAX) : ''
    const auth = typeof entry.auth === 'string' ? entry.auth : 'none'
    const key = keyOf(method, path)
    const existing = entries.get(key)
    if (existing) {
      if (existing.what === what && existing.auth === auth && existing.handler === entry.handler) {
        return { ok: true, code: 'already-registered', key, method, path, dispose: () => unregister(method, path) }
      }
      return code('duplicate-route', `同一 (方法, 路径) 已用不同形状注册过：${key}`,
        '要么复用同一份注册，要么先 dispose 旧的再注册（不许悄悄覆盖）')
    }
    entries.set(key, { method, path, what, auth, handler: entry.handler })
    return { ok: true, code: 'registered', key, method, path, dispose: () => unregister(method, path) }
  }

  const unregister = (method, path) => entries.delete(keyOf(String(method).toUpperCase(), path))
  const has = (method, path) => entries.has(keyOf(String(method).toUpperCase(), path))
  const size = () => entries.size

  /**
   * 查表（**精确匹配**：路径 + 方法都要相等）。返回 `null` = 没注册过这条路由
   * （调用方据此走既有的 404/405 语义，不猜）。
   */
  const match = (path, method) => {
    const hit = entries.get(keyOf(String(method ?? '').toUpperCase(), path))
    return hit === undefined ? null : { handler: hit.handler, route: { method: hit.method, path: hit.path,
      what: hit.what, auth: hit.auth } }
  }

  /** 只回执**元数据**（不含 handler）：`/api/routes` 与门据此断言"登记数与注册数一致"。 */
  const list = () => [...entries.values()].sort((left, right) => (left.path < right.path ? -1
    : (left.path > right.path ? 1 : (left.method < right.method ? -1 : 1))))
    .map(({ method, path, what, auth }) => ({ method, path, what, auth, source: 'uiRoutes' }))

  const dispose = () => { disposed = true; entries.clear() }

  return { register, unregister, has, match, size, list, dispose, get disposed() { return disposed } }
}
