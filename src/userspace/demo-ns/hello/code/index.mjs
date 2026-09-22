// 用户空间插件（演示，src/userspace/demo-ns/hello/）：只在自己的命名空间里注册服务；
// 不碰平台保留名（approval / ledger* / kernel.* / webui…），不写别人目录，零写面。
//
// 阶段 5.1：本插件是 `user-space/demo-ns/hello/` 的**收敛目标**（旧副本已删，`user-space` 现在是指向
// `src/userspace` 的兼容链接 ⇒ 只有一处事实源）。旧副本那 12 行实现逐字留档在 `docs/migration-note.md`。
//
// 两份装载器的形状差异（本文件同时满足，**不是**两份实现）：
//   · 平台装载器（`src/system/runtime/code/plugin-registry.mjs`，六动词 + 运行期装卸）：**不**替插件加前缀，
//     所以本文件自己注册 `<ns>.<plugin>.<svc>`（= `demo-ns.hello.bucket` / `demo-ns.hello.status`）；
//   · 用户空间隔离内核（`host/lib/user-space.mjs`）：装载时把 `config.prefix`（`<ns>.<plugin>`）交给插件，
//     且**只收不带点的基础名**（`SERVICE_RE`），由装载器命名空间化。
//   ⇒ 判据：有 `config.prefix` 就注册基础名 `bucket` / `status`（交给装载器加前缀）；没有就自己加前缀。
//     两条路径互相排斥，不会出现同一个服务被注册两次。
export const name = 'hello'
export const inject = []
export const provides = ['bucket', 'status']
export const Config = undefined

/** 本插件的服务命名空间前缀（与 host/lib/user-space.mjs 的 `<ns>.<plugin>.<svc>` 同一约定）。 */
export const NAMESPACE = 'demo-ns.hello'

/** 注入式 UI：本插件注册的区块（槽位 + 排序 + 标题）。 */
export const BLOCK = { slot: 'page.supplier', order: 30,
  title: '用户空间插件区块（demo-ns.hello 注册的只读区块）' }

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const apply = (ctx, config) => {
  const store = new Map()                        // 独立 instance 的状态：只在本次挂载里可见
  const bucket = {
    put: (k, v) => { store.set(String(k), String(v)); return { ok: true, size: store.size } },
    get: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    size: () => store.size,
  }
  const status = { version: config?.version ?? '1.0.0', ns: config?.ns ?? 'demo-ns', plugin: 'hello' }
  // 装载器给了前缀 = 用户空间隔离内核路径（基础名由它命名空间化）；没给 = 平台装载器路径（自己加前缀）。
  const hostPrefix = typeof config?.prefix === 'string' ? config.prefix.trim() : ''
  const ownPrefix = hostPrefix === '' ? `${NAMESPACE}.` : ''
  ctx.provide(`${ownPrefix}bucket`, bucket)
  ctx.provide(`${ownPrefix}status`, status)

  // 注入式 UI 注册面（机制见 host/lib/ui-slot.mjs）：动态依赖，依赖消失自动 dispose（零残留）。
  // `scope.effect()` 的返回值必须是**反注册函数**（返回一个带 dispose 字段的对象会被 cordis 当成
  // 普通值丢掉 —— 那样卸载后就留下一个指向已死实例的区块；机制回归测试 E5 就是查这条）。
  ctx.inject(['uiSlots'], (scope) => {
    scope.effect(() => {
      const verdict = scope.uiSlots.register({
        plugin_id: 'userspace/demo-ns/hello',
        slot: BLOCK.slot,
        order: BLOCK.order,
        title: BLOCK.title,
        render: () => ({ ok: true, html: renderBlock({ ...status, probe: bucket.get('ping') }) }),
      })
      return verdict.ok === true ? verdict.dispose : () => {}
    })
  })
}

/** 区块渲染（**只读**）：只读本插件自己的服务状态；没有数据就如实说"没有"，不编造。 */
export const renderBlock = (status) => {
  const s = status ?? {}
  const probe = s.probe ?? null
  return `<p>服务命名空间：<code>${esc(NAMESPACE)}</code>（基础名 <code>bucket</code> / <code>status</code>）</p>`
    + `<p>自述：<code>ns=${esc(s.ns ?? 'demo-ns')}</code> · <code>plugin=hello</code> · <code>version=${esc(s.version ?? '1.0.0')}</code></p>`
    + `<p>只读探针 <code>bucket.get('&lt;未写入的键&gt;')</code> = <code>${esc(probe === null ? 'null' : String(probe))}</code>`
    + `（没有写入过就返回 <code>null</code>，本区块**不编造**值）</p>`
    + `<p><small>本区块由本插件自己注册：不读账本、不取墙钟、不写任何文件；webui 不知道它的业务含义。</small></p>`
}
