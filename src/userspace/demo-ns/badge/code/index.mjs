// 用户空间插件 badge（src/userspace/demo-ns/badge/）：运行期装卸的**演示与取证对象**。
//
// 为什么有它：`userspace/demo-ns/hello` 在启动期就被静态装配（`host/cli.mjs` 的 webui 动作），
// 因此它证明不了"运行中的服务能真装卸"；本插件**不在**任何启动装配里，只能由运行期控制通道
// 装进来 —— 装进来后它注册的只读区块必须**真出现在页面上**（`data-ui-block="userspace/demo-ns/badge"`），
// 卸掉后必须**消失且页面其余部分逐字节不变**（`tools/verify.sh plugin-lifecycle` 的 L 段）。
//
// 纪律（与 hello 同形，用户空间约定）：
//   · 零写面：不写文件、不写账本、不联网、不取随机、不起定时器、不读墙钟；
//   · 服务只注册在自己命名空间（`demo-ns.badge.*`），平台保留名一个不碰；
//   · 两份装载器同一份实现：装载器给了 `config.prefix`（隔离内核路径，只收基础名）就注册基础名，
//     没给（平台装载器路径）就自己加前缀。
export const name = 'badge'
export const inject = []
export const provides = ['stamp', 'status']
export const Config = undefined

/** 本插件的服务命名空间前缀（与 host/lib/user-space.mjs 的 `<ns>.<plugin>.<svc>` 同一约定）。 */
export const NAMESPACE = 'demo-ns.badge'

/** 注入式 UI：本插件注册的区块（槽位 + 排序 + 标题）。槽位与 hello 相同、order 更大 ⇒ 排在它后面。 */
export const BLOCK = { slot: 'page.supplier', order: 40,
  title: '运行期装载演示区块（demo-ns.badge 注册的只读区块）' }

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const apply = (ctx, config) => {
  // 本实例自己的观测序号（只在本次挂载里可见；不读墙钟、不用随机数）。
  const marks = []
  const stamp = {
    mark: (label) => { marks.push(String(label)); return { ok: true, count: marks.length } },
    last: () => (marks.length === 0 ? null : marks[marks.length - 1]),
    count: () => marks.length,
  }
  const status = { version: config?.version ?? '1.0.0', ns: config?.ns ?? 'demo-ns', plugin: 'badge',
    mounted: 'runtime' }
  const hostPrefix = typeof config?.prefix === 'string' ? config.prefix.trim() : ''
  const ownPrefix = hostPrefix === '' ? `${NAMESPACE}.` : ''
  ctx.provide(`${ownPrefix}stamp`, stamp)
  ctx.provide(`${ownPrefix}status`, status)

  ctx.inject(['uiSlots'], (scope) => {
    scope.effect(() => {
      const verdict = scope.uiSlots.register({
        plugin_id: 'userspace/demo-ns/badge',
        slot: BLOCK.slot,
        order: BLOCK.order,
        title: BLOCK.title,
        render: () => ({ ok: true, html: renderBlock({ ...status, marks: stamp.count() }) }),
      })
      return verdict.ok === true ? verdict.dispose : () => {}
    })
  })
}

/** 区块渲染（**只读**）：只读本插件自己的服务状态；没有数据就如实说"没有"，不编造。 */
export const renderBlock = (state) => {
  const s = state ?? {}
  return `<p>本区块由 <code>${esc(NAMESPACE)}</code> 在运行期注册（不是启动期静态装配）。</p>`
    + `<p>自述：<code>ns=${esc(s.ns ?? 'demo-ns')}</code> · <code>plugin=badge</code> · <code>version=${esc(s.version ?? '1.0.0')}</code></p>`
    + `<p>本实例观测序号：<code>${esc(String(s.marks ?? 0))}</code>（重载拿到新实例后从 0 重新开始 —— 内存状态不迁移）</p>`
    + `<p><small>零写面：不读账本、不取墙钟、不写任何文件；webui 不知道它的业务含义。</small></p>`
}
