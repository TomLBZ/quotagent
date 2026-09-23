/**
 * `system/user-plugin-manager` 的 **GUI 贡献** —— 用户空间插件的**自助面**搬进业务视角（DEF-026）。
 *
 * 修的是哪一条：自助装卸面（`GET/POST ${prefix}/plugins/**`）**只存在于身份页**，APP 外壳里
 * **一个入口都没有** —— 业务方看不到"我自己有一块地方可以挂视图/动作"，也看不到自己命名空间里有什么。
 * 现在：两侧视角各有一块「我的插件（用户空间）」面板：
 *
 *   · **你的是哪个命名空间**（`user-space/<你的名字>` 存在就是它，否则 `u-<你的名字>`，与身份面同一条判据）；
 *   · 用户空间里现在有哪些**命名空间**与**插件**，以及**它装没装**——装载状态不是另记一份，
 *     而是问**注册面**：一个用户空间插件的界面贡献（视图/面板/动作）出现在注册面里就是装着
 *     （`userspace/<命名空间>/<插件>` 的 plugin_id），卸载后随之消失（规则 1）；
 *   · **自助装卸**：只对**自己命名空间**的插件给按钮（表单 POST 到既有路由 `${prefix}/plugins/{load,unload}`），
 *     别人的命名空间照实说明"找管理员"——判据在服务端（`not-my-namespace`），这里只是入口。
 *
 * 纪律：本文件**不写任何文件**（表单打到既有路由，落账/落盘仍归既有写面）；不新造路由；
 * 面板是 `html` 形状，只做入口与如实读数。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const plugin_id = 'system/user-plugin-manager'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 用户空间的两处根：宿主给的那个（`--user-space-root`，通常 `<仓库>/user-space`）+ 仓库内的 `src/userspace`。 */
const spaceRoots = (host) => {
  const roots = []
  const fromHost = asText(host?.root)
  if (fromHost) roots.push(join(fromHost, 'user-space'))
  if (fromHost) roots.push(join(fromHost, 'src', 'userspace'))
  return roots
}

/** 有界目录列举：不递归、不跟符号链接、读不到就如实返回空（面板照实说"读不到"）。 */
const subdirsOf = (dir) => {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
    return readdirSync(dir).sort().filter((name) => {
      if (name.startsWith('.')) return false
      try { return statSync(join(dir, name)).isDirectory() } catch (err) { return false }
    })
  } catch (err) {
    return null
  }
}

/** 命名空间清单：`〔名字空间 → [插件名]〕`（去重；读不到的根如实记进 unreadable）。 */
const namespacesOf = (host) => {
  const out = new Map()
  const unreadable = []
  for (const root of spaceRoots(host)) {
    const names = subdirsOf(root)
    if (names === null) { unreadable.push(root); continue }
    for (const ns of names) {
      const plugins = subdirsOf(join(root, ns)) ?? []
      const known = out.get(ns) ?? { ns, plugins: [], roots: [] }
      known.roots.push(root)
      for (const plugin of plugins) if (!known.plugins.includes(plugin)) known.plugins.push(plugin)
      known.plugins.sort()
      out.set(ns, known)
    }
  }
  return { namespaces: [...out.values()], unreadable, roots: spaceRoots(host) }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const pfx = asText(host.prefix) || ''

  /** 装载状态**问注册面**（机制读数）：`userspace/<ns>/<plugin>` 的界面贡献是否在册。 */
  const loadedNames = () => {
    const seen = new Set()
    for (const kind of ['view', 'panel', 'action', 'shortcut', 'report', 'notification-source', 'status-item']) {
      for (const entry of surface.byKind(kind)) {
        const id = asText(entry.plugin_id)
        if (id.startsWith('userspace/')) seen.add(id.slice('userspace/'.length))
      }
    }
    return seen
  }

  const panel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'userspace.mine.supplier' : 'userspace.mine',
    title: '我的插件（用户空间：自建视图 / 动作）', view, order, kind: 'html',
    data: (ctx) => {
      const who = ctx?.identity ?? null
      const name = asText(who?.name)
      const side = asText(who?.side)
      const listing = namespacesOf(host)
      const loaded = loadedNames()
      if (name === '') {
        return { ok: true, kind: 'html',
          degraded: true,
          reason: '还没登录（机器码 identity-required）——用户空间按<b>名字</b>分命名空间，所以先要知道你是谁',
          next_action: `去 ${pfx}/identity/?next=${pfx}/ 登录，再回来这块面板`,
          html: `<p class="q-hint" data-userspace="no-identity">先登录：每个名字有自己的命名空间`
            + `（<code>${esc(pfx)}/plugins/</code> 按会话身份判"哪些是我的"）。</p>` }
      }
      const mine = listing.namespaces.some((entry) => entry.ns === name) ? name : `u-${name}`
      const rows = listing.namespaces.map((entry) => {
        const isMine = entry.ns === mine
        const plugins = entry.plugins.length
          ? entry.plugins.map((plugin) => {
            const key = `${entry.ns}/${plugin}`
            const on = loaded.has(key)
            const action = isMine
              ? `<form method="post" action="${esc(pfx)}/plugins/${on ? 'unload' : 'load'}" style="display:inline">`
                + `<input type="hidden" name="ns" value="${esc(entry.ns)}">`
                + `<input type="hidden" name="plugin" value="${esc(plugin)}">`
                + `<button type="submit" data-userspace-op="${on ? 'unload' : 'load'}"`
                + ` data-userspace-plugin="${esc(key)}">${on ? '卸载' : '装载'}</button></form>`
              : `<small>别人的命名空间：装卸找管理员（<code>${esc(pfx)}/admin/api/user-plugins/</code>）</small>`
            return `<li data-userspace-plugin="${esc(key)}" data-userspace-loaded="${on ? '1' : '0'}">`
              + `<code>${esc(plugin)}</code> ${on ? '已装载（它的界面贡献在注册面里）' : '未装载'} ${action}</li>`
          }).join('')
          : '<li>（这个命名空间里还没有插件）</li>'
        return `<div data-userspace-ns="${esc(entry.ns)}" data-userspace-mine="${isMine ? '1' : '0'}">`
          + `<b><code>${esc(entry.ns)}</code></b>${isMine ? '（<b>我的</b>）' : '（别人的，只读）'}`
          + `<ul>${plugins}</ul></div>`
      }).join('')
      return { ok: true, kind: 'html',
        counts: { namespaces: listing.namespaces.length, mine_plugins: (listing.namespaces
          .find((entry) => entry.ns === mine)?.plugins ?? []).length, loaded: loaded.size },
        html: `<p data-userspace-identity="${esc(name)}" data-userspace-ns-mine="${esc(mine)}">`
          + `身份 <code>human:${esc(name)}</code>（${esc(side)} 侧）：你的命名空间是 <code>${esc(mine)}</code>。`
          + `自助装卸入口在这里，也在 <a href="${esc(pfx)}/plugins/" data-userspace-link="1">我的插件</a>`
          + `（同一个路由，判据在服务端：只有自己的命名空间能装卸，跨命名空间 ⇒ <code>not-my-namespace</code>）。</p>`
          + (rows || '<p>（用户空间里还没有任何命名空间/插件）</p>')
          + `<p class="q-hint">用户空间插件和别的插件一样：在 <code>code/ui.mjs</code> 里`
          + ` <code>export register(surface, host)</code> 注册视图 / 面板 / 动作 / 快捷键 ⇒ `
          + `<b>装载后自建视图随之出现</b>；卸载后一起消失（<code>AGENTS.md</code> 规则 1）。`
          + `"已装载"的判据是注册面里有没有它的贡献，不是另记一份状态。</p>`
          + (listing.unreadable.length
            ? `<p class="q-hint">读不到的目录（如实报，不当成空）：${listing.unreadable.map(esc).join('、')}</p>`
            : ''),
        note: `用户空间的根：${listing.roots.map(esc).join('、')}；`
          + `本面板只读目录 + 问注册面，不写任何文件（装卸仍走 ${pfx}/plugins/ 的既有写面）` }
    } })

  out.push(surface.view({ plugin_id: me, id: 'userspace.workspace', title: '我的插件', order: 40,
    view: 'contractor', hint: '自己的命名空间 / 自建视图与动作 / 自助装卸（同一个路由，判据在服务端）' }))
  out.push(panel('contractor', 40))
  out.push(panel('supplier', 40))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.userspace', title: '我的插件', order: 40,
    read: (ctx) => {
      const who = ctx?.identity ?? null
      const name = asText(who?.name)
      if (name === '') return { text: '未登录（用户空间按名字分）', level: 'info',
        next_action: `先登录：${pfx}/identity/` }
      const listing = namespacesOf(host)
      const mine = listing.namespaces.some((entry) => entry.ns === name) ? name : `u-${name}`
      return { text: `我的命名空间 ${mine} · 已装载 ${loadedNames().size}`, level: 'ok',
        next_action: `在「我的插件」面板里装卸自己的插件（或 ${pfx}/plugins/）` }
    } }))

  return out
}
