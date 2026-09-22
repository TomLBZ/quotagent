/**
 * ui-slot —— 注入式 UI 的**注册面机制**（通用件：只知道"有区块挂在槽位上"，不知道它是什么）。
 *
 * 用户原话（2026-09-22，逐字）：「插件可以依赖其他插件，例如 heuristics_visualizer 可以依赖 webui 来注入
 * 自身的视觉元素。**不需要让 webui 耦合展示其他插件的 UI 或者耦合某种具体的业务逻辑**。」
 * 规则真源：`docs/design/27-plugin-architecture.md` §6；决策：ADR-0020 §5。
 *
 * 本文件是**机制**，不含任何业务语义：
 *   · 它不认识任何插件 id、任何领域名词、任何字段绑定（门 `plugin-lifecycle` 静态扫描这一条）；
 *   · 它只做四件事：**校验**注册形状、**排序**（`order` 后按 `plugin_id` 字典序，稳定可复现）、
 *     **装配 HTML**（按槽位拼接，块自身的内容一个字都不解读）、**指名报错**（失败不静默吞、不兜底编造）。
 *   · 它**零写面**：不写文件、不读账本、不联网、不取墙钟、不用随机数（静态负控逐条扫）。
 *
 * 页面纪律由机制**结构性**保证（不是靠评审）：
 *   · 插件提交的 HTML 里出现 `<script` / 内联事件属性 / `javascript:` URL ⇒ **拒收**（`inline-script-refused`）；
 *   · 区块渲染抛错 ⇒ 该块**不渲染**，但错误块以**有名 reason** 落在页面上（不静默吞掉、webui 也不编一个替代块）。
 *
 * 用法（插件侧，写在插件自己的 code/ 里；**本文件不认识任何具体插件**）：
 *   ctx.inject(['uiSlots'], (scope) => {
 *     scope.effect(() => scope.uiSlots.register({ plugin_id: '<层次>/<插件>', slot: 'page.<视角>',
 *       order: 20, title: '…', render: () => ({ ok: true, html: '…' }) }))
 *   })
 *
 * 为什么用 `ctx.inject` 而不是 `inject: ['uiSlots']`：`webui` 的 `inject` 里有业务插件（它是**消费者**），
 * 业务插件若要 `inject: ['uiSlots']`（`uiSlots` 由 `webui` 提供）就形成环 —— cordis 会两边都在等对方。
 * `ctx.inject` 是**动态依赖**：依赖就绪才注册，依赖消失自动 dispose（effects 归零由 cordis 保证）。
 */

/** 允许的槽位（闭合集合；`<面>.<名>`）。新增槽位 = 改这一处 + `docs` 契约，不在业务插件里偷偷加。 */
export const SLOTS = ['page.home', 'page.contractor', 'page.supplier', 'page.ops', 'page.admin']

/** 层（与 `plugin.json.layer`、`src/{system,domain,userspace}/` 同一套取值）。 */
export const LAYERS = ['system', 'domain', 'userspace']

/**
 * 插件标识形状：`层次/插件`（userspace 为 `userspace/<ns>/<plugin>`）。
 * 基名正则与 `host/lib/user-space.mjs` 的 `NAME_RE` **同一套**（不新增第二套）。
 */
export const PLUGIN_ID_RE = /^(system|domain|userspace)\/[a-z][a-z0-9-]{0,31}(\/[a-z][a-z0-9-]{0,31})?$/

/** 排序位与标题的取值边界（超出即拒，不夹取 —— 静默夹取等于把错误藏起来）。 */
export const ORDER_MIN = -1000
export const ORDER_MAX = 1000
export const TITLE_MAX = 120

/** 拒收/降级原因码（闭合集合；门逐条断言"降级是有名的"）。 */
export const REFUSAL_CODES = ['illegal-plugin-id', 'illegal-layer', 'unknown-slot', 'invalid-order',
  'invalid-title', 'invalid-render', 'duplicate-registration', 'inline-script-refused',
  'invalid-block-output', 'block-render-failed', 'registration-disposed']

/** 页面纪律扫描器（机制层，不认识业务）：脚本标签、内联事件属性、`javascript:` URL。 */
const SCRIPT_NEEDLE = '<script'
const INLINE_EVENT_RE = /\son[a-z]+\s*=/i
const JS_URL_RE = /javascript:/i

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const code = (name, reason, next_action) => ({ ok: false, code: name, reason, next_action })

/**
 * 建一个槽位注册表。返回的 API 全是**纯机制**：
 *   `register(entry)` / `unregister(plugin_id, slot)` / `has(plugin_id, slot)` / `size(slot?)`
 *   `slots()` / `describe()`（只回执注册元数据）/ `render(slot)`（装配 HTML）/ `dispose()`
 */
export function createSlotRegistry({ slots = SLOTS } = {}) {
  const allowed = new Set(slots)
  /** key = `${slot}\u0000${plugin_id}` → {plugin_id, slot, order, title, render, seq}（`seq` 只用于去重幂等） */
  const entries = new Map()
  let disposed = false

  const keyOf = (slot, pluginId) => `${slot}\u0000${pluginId}`
  const ordered = (slot) => [...entries.values()].filter((item) => item.slot === slot)
    .sort((left, right) => (left.order - right.order) || (left.plugin_id < right.plugin_id ? -1
      : (left.plugin_id > right.plugin_id ? 1 : 0)))

  /**
   * 注册一个只读区块。幂等：同一 `(slot, plugin_id)` 且形状完全相同 ⇒ `already-registered`（`ok:true`）；
   * 形状不同 ⇒ `duplicate-registration`（**拒**，不悄悄覆盖别人）。
   * @returns `{ok:true, code:'registered'|'already-registered', key, plugin_id, slot, order, dispose}` 或拒收体
   */
  const register = (entry) => {
    if (disposed) {
      return code('registration-disposed', '注册表已释放',
        '重新挂载宿主后再注册（dispose 之后注册一律拒）')
    }
    if (!plainObject(entry)) {
      return code('illegal-plugin-id', '注册载荷不是对象', 'register({plugin_id, slot, order, title, render})')
    }
    const pluginId = typeof entry.plugin_id === 'string' ? entry.plugin_id.trim() : ''
    if (!PLUGIN_ID_RE.test(pluginId)) {
      return code('illegal-plugin-id', `plugin_id 形状不合法：${JSON.stringify(entry.plugin_id)}`,
        '写 `层次/插件`（system|domain|userspace；userspace 写 `userspace/<ns>/<plugin>`）')
    }
    const layer = pluginId.split('/')[0]
    if (!allowed.has(entry.slot)) {
      return code('unknown-slot', `槽位不在闭合集合里：${JSON.stringify(entry.slot)}`,
        `用 ${SLOTS.join(' / ')} 之一（新增槽位改 host/lib/ui-slot.mjs 的 SLOTS + 契约文档）`)
    }
    if (!Number.isInteger(entry.order) || entry.order < ORDER_MIN || entry.order > ORDER_MAX) {
      return code('invalid-order', `order 必须是 [${ORDER_MIN}, ${ORDER_MAX}] 内的整数：${JSON.stringify(entry.order)}`,
        '给一个整数 order（越小越靠前；同 order 按 plugin_id 字典序）')
    }
    if (typeof entry.title !== 'string' || entry.title.trim() === '' || entry.title.length > TITLE_MAX) {
      return code('invalid-title', `title 必须是非空字符串且 ≤ ${TITLE_MAX} 字符：${JSON.stringify(entry.title)}`,
        '给一句人话标题（它是页面上唯一的"这个块是谁的"线索）')
    }
    if (typeof entry.render !== 'function') {
      return code('invalid-render', 'render 必须是函数（返回 {ok, html} 或 HTML 字符串）',
        'render: () => ({ok: true, html: "<p>…</p>"})')
    }
    const existing = entries.get(keyOf(entry.slot, pluginId))
    if (existing) {
      const same = existing.order === entry.order && existing.title === entry.title
      if (same) {
        return { ok: true, code: 'already-registered', key: existing.key, plugin_id: pluginId,
          slot: entry.slot, order: entry.order, layer, dispose: () => unregister(pluginId, entry.slot) }
      }
      return code('duplicate-registration',
        `同一 (slot, plugin_id) 已用不同形状注册过：${pluginId} @ ${entry.slot}`,
        '要么复用同一份注册，要么先 dispose 旧的再注册（不许悄悄覆盖）')
    }
    const key = keyOf(entry.slot, pluginId)
    entries.set(key, { plugin_id: pluginId, slot: entry.slot, order: entry.order, title: entry.title,
      render: entry.render, key })
    return { ok: true, code: 'registered', key, plugin_id: pluginId, slot: entry.slot, order: entry.order,
      layer, dispose: () => unregister(pluginId, entry.slot) }
  }

  /** 反注册（卸载路径用它；返回是否真的移除了 —— 可重复调用，重复调用返回 `false`）。 */
  const unregister = (pluginId, slot) => entries.delete(keyOf(slot, pluginId))

  /** 某个插件的某个槽位是否注册过（`status` 用）。 */
  const has = (pluginId, slot) => entries.has(keyOf(slot, pluginId))

  /** 当前注册条目数（`slot` 省略 = 全部）。 */
  const size = (slot) => (slot === undefined ? entries.size : ordered(slot).length)

  /** 只回执**元数据**（不含 render）：`/api/ui/blocks` 与门据此断言"注册数 = 条目数"。 */
  const describe = () => ({
    slots: [...allowed],
    count: entries.size,
    blocks: [...entries.values()].sort((left, right) => (left.slot < right.slot ? -1
      : (left.slot > right.slot ? 1 : (left.order - right.order) || (left.plugin_id < right.plugin_id ? -1 : 1))))
      .map(({ plugin_id, slot, order, title, key }) => ({ plugin_id, slot, order, title, key })),
  })

  /** 页面纪律（机制层）：插件提交的 HTML 不许带脚本；返回拒收原因或 `null`。 */
  const htmlRefusal = (html) => {
    if (html.includes(SCRIPT_NEEDLE)) {
      return code('inline-script-refused', '区块 HTML 里出现 `<script`',
        '页面模板必须 0 内联脚本：把行为做成链接或 `<form method=get|post>`')
    }
    if (INLINE_EVENT_RE.test(html)) {
      return code('inline-script-refused', '区块 HTML 里出现内联事件属性（on*=）',
        '去掉内联事件属性：交互走表单/链接（SSR 契约）')
    }
    if (JS_URL_RE.test(html)) {
      return code('inline-script-refused', '区块 HTML 里出现 `javascript:` URL',
        '链接只写 http(s)/相对路径')
    }
    return null
  }

  /**
   * 装配某个槽位的 HTML（**机制**：排序 → 逐个 render → 套一个通用外壳）。
   * 返回 `{ok, slot, html, blocks, errors}`：`blocks` = 真的渲染出来的块数，
   * `errors` = 有名失败（每条的块**不渲染**，但错误以 `block-render-failed` 指名落在页面上）。
   */
  const render = (slot) => {
    if (slot === undefined || !allowed.has(slot)) {
      return { ok: false, slot: slot ?? null, html: '', blocks: 0, errors: [code('unknown-slot',
        `渲染请求的槽位不在闭合集合里：${JSON.stringify(slot ?? null)}`,
        `用 ${SLOTS.join(' / ')} 之一`)] }
    }
    const errors = []
    let html = ''
    let blocks = 0
    for (const item of ordered(slot)) {
      let out = null
      try {
        out = item.render({ plugin_id: item.plugin_id, slot: item.slot })
      } catch (err) {
        out = { ok: false, code: 'block-render-failed', reason: String(err && err.message ? err.message : err).slice(0, 200) }
      }
      const body = typeof out === 'string' ? { ok: true, html: out } : out
      if (!plainObject(body) || body.ok !== true || typeof body.html !== 'string') {
        const reason = plainObject(body) && typeof body.reason === 'string'
          ? body.reason : 'render 未返回 {ok:true, html}'
        errors.push(code('block-render-failed', `${item.plugin_id} @ ${item.slot}：${reason}`,
          '让 render 返回 {ok:true, html}；拿不到数据时返回 {ok:true, html:"…如实报未就绪…"} 而不是抛错'))
        html += `\n<section data-ui-block-error="${item.plugin_id}" data-ui-block-slot="${esc(item.slot)}">`
          + `<h3>区块未能渲染（${esc(item.plugin_id)}）</h3><p>reason: <code>`
          + `${esc(flat(reason))}</code></p></section>`
        continue
      }
      const refusal = htmlRefusal(body.html)
      if (refusal) {
        errors.push({ ...refusal, reason: `${item.plugin_id} @ ${item.slot}：${refusal.reason}` })
        html += `\n<section data-ui-block-error="${item.plugin_id}" data-ui-block-slot="${esc(item.slot)}">`
          + `<h3>区块被拒收（${esc(item.plugin_id)}）</h3><p>code: <code>`
          + `${esc(refusal.code)}</code> · reason: <code>${esc(flat(refusal.reason))}</code></p></section>`
        continue
      }
      blocks += 1
      html += `\n<section data-ui-block="${esc(item.plugin_id)}" data-ui-block-slot="${esc(item.slot)}"`
        + ` data-ui-block-order="${esc(String(item.order))}"><h3>${esc(item.title)}</h3>`
        + `<p><small>本区块由 <code>${esc(item.plugin_id)}</code> 自己注册（webui 只知道槽位与排序，`
        + `不懂它的业务含义）</small></p>${body.html}</section>`
    }
    return { ok: errors.length === 0, slot, html, blocks, errors }
  }

  /** 释放注册表（宿主 dispose 时调；之后注册一律 `registration-disposed`）。 */
  const dispose = () => { disposed = true; entries.clear() }

  return { register, unregister, has, size, slots: () => [...allowed], describe, render, dispose,
    get disposed() { return disposed } }
}

/** HTML 文本转义（机制层最小集：`& < > "`）。 */
export function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 单行化（错误文本不许把换行带进 HTML 属性/标签之间）。 */
function flat(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 240)
}
