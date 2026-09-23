/* sw.js —— PWA 的**离线壳**（机制；由外壳按路由 `${prefix}/sw.js` 原样送出）。
 *
 * 一句话：**只把"壳"放进缓存，绝不把"数据"放进缓存**。
 *
 * 缓存策略（逐条落实；`/api/ui/surface` 的 `pwa.never_cached` 是同一份口径的机读副本）：
 *
 *   ① 非 `GET`（所有写动作 / 人签 / 登录 / 邮件配置 …）—— **不拦截**，直连网络。
 *      离线时它们照旧失败（界面如实报错）：本 SW **不排队、不重放**任何写请求。
 *   ② 跨源请求 —— 不管（本应用本来就不引外网 CDN；脚本只来自本服务的 `/assets/**`）。
 *   ③ **敏感路径一律网络-only、永不缓存**：`/api/**`（数据/通知/协作/名册/附件/对象页数据）、
 *      `/identity/**`、`/sign/**`、`/inbox/**`、`/mail/**`、`/ops/**`、`/admin/**`、`/plugins/**`，
 *      以及服务端渲染的旧页（`/<view>/**`）。离线时它们**读不到就是读不到** ——
 *      宁可显示"读不到/可能陈旧"，也不拿一份旧 JSON 冒充新数据。
 *   ④ 静态资源（`assets/app.js`、`assets/app.css`、图标、清单）—— stale-while-revalidate：
 *      命中缓存立刻回，同时后台拉一次新的（离线也能启动壳）。
 *   ⑤ 导航请求（HTML）—— network-first；网络不可用且目标是 **深链 `/app/**` 或应用根**时，
 *      回退到安装时缓存的那一份 **壳 HTML**（它只含路由前缀与视图名，**不含任何数据**），
 *      并在响应头标 `x-q-offline: 1`、给所有页面发一条 `{type:'q-offline'}` 消息 ⇒
 *      界面据此显示「离线：数据可能陈旧」而不是假装有数据。
 *      其它路径（运维/管理/旧 SSR 页）离线时**不回退**，直接 503 + 一句人话 ——
 *      那些页可能含数据，缓存它们等于把数据留在设备上。
 *   ⑥ 缓存按版本命名（`quotagent-shell-v1`）；`activate` 时删掉旧版本。
 *      换版本只改这一个常量：壳变了就换名字，旧缓存自动清掉。
 *
 * 为什么前缀不写死：本文件由 `${prefix}/sw.js` 送出，作用域就是 `${prefix}/`，
 * 于是 `self.registration.scope` 在任何路由前缀下都是权威值 —— 同一份文件、零配置。
 */

const CACHE = 'quotagent-shell-v1'
const SCOPE = self.registration.scope                       // 例：https://<主机>/<前缀>/
const BASE = new URL(SCOPE).pathname                        // 例：/<前缀>/
const SHELL_URL = SCOPE                                     // 壳（文档）：只含路由前缀，不含数据
const PRECACHE = [
  SHELL_URL,
  `${BASE}assets/app.js`,
  `${BASE}assets/app.css`,
  `${BASE}assets/manifest.webmanifest`,
  `${BASE}assets/icon-192.png`,
  `${BASE}assets/icon-512.png`,
]
/** 命中这些前缀的请求**永不缓存**（数据、身份、人签、运维/管理面）。 */
const NEVER_CACHE = ['api/', 'identity/', 'sign/', 'inbox/', 'mail/', 'ops/', 'admin/', 'plugins/']
/** 离线也能回退到壳的导航目标：应用根与深链 `/app/**`（其它路径不回退，避免把数据留在设备上）。 */
const SHELL_NAV = /^(\/|app(\/|$))/

const isSensitive = (pathname) => {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\/+/, '')
  if (NEVER_CACHE.some((prefix) => rest === prefix.replace(/\/$/, '') || rest.startsWith(prefix))) return true
  // 服务端渲染的旧页（/<view>/…）与任何非壳文档：含数据 ⇒ 不进缓存
  return /^[a-z]+\//.test(rest) && !rest.startsWith('assets/')
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // 逐个加：某一个资源暂时取不到（例如部署瞬时）不应让整个壳装不上
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))
      .catch(() => undefined)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name !== CACHE && name.startsWith('quotagent-shell-'))
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

/** 离线回退时告诉每个页面：**这一页是离线壳，数据可能陈旧**（界面据此如实显示）。 */
const shoutOffline = async (url) => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) {
    try { client.postMessage({ type: 'q-offline', at: new Date().toISOString(), url }) } catch (err) { /* 尽力而为 */ }
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return                                   // ① 写请求直连（不排队、不重放）
  let url
  try { url = new URL(req.url) } catch (err) { return }
  if (url.origin !== self.location.origin) return                    // ② 跨源不管
  const path = url.pathname
  const isAsset = path.startsWith(`${BASE}assets/`) && path !== `${BASE}assets/sw.js`
  const isShellNav = req.mode === 'navigate'
    && (path === BASE || path === BASE.replace(/\/$/, '') || SHELL_NAV.test(path.slice(BASE.length)))

  if (isAsset) {
    // ④ 静态资源：先给缓存（离线也能启动），后台顺手更新
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req, { ignoreSearch: true })
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined)
        return res
      }).catch(() => null)
      return hit || (await network) || new Response('', { status: 504, statusText: 'offline' })
    })())
    return
  }
  if (isSensitive(path) && !isShellNav) return                       // ③ 敏感路径/旧页：网络 only
  if (!isShellNav) return                                            // 其它：网络 only（不缓存数据）

  // ⑤ 导航：network-first；离线回退到**不含数据**的壳，并如实标记
  event.respondWith((async () => {
    try {
      const res = await fetch(req)
      if (res && res.ok) return res
      throw new Error(`status ${res ? res.status : 'none'}`)
    } catch (err) {
      const cache = await caches.open(CACHE)
      const shell = await cache.match(SHELL_URL)
      if (!shell) {
        return new Response('离线，且这一页没有可用的离线壳（缓存被清过）。请在网络恢复后重新打开。',
          { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-q-offline': '1' } })
      }
      const body = await shell.text()
      await shoutOffline(req.url)
      return new Response(body, { status: 200, headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-q-offline': '1',                       // 机读标记：这是一份离线壳
        'x-q-offline-at': new Date().toISOString(),
      } })
    }
  })())
})
