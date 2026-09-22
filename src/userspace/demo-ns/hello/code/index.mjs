// 用户空间插件（演示，src/userspace/demo-ns/hello/）：只在自己的命名空间里注册服务；
// 不碰平台保留名（approval / ledger* / kernel.* / webui…），不写别人目录，零写面。
//
// 阶段 1：本插件是**实体搬迁**（用户空间样本体量小），不是 wrapper —— 运行时副本
// `user-space/demo-ns/hello/` 保持不动，阶段 5.1 收敛成"运行时根 gitignore + 跟踪的 EXAMPLE"。
// 服务键按用户空间约定是**基础名**：宿主装载期命名空间化为 `<ns>.<plugin>.<svc>`
// （= `demo-ns.hello.bucket` / `demo-ns.hello.status`）；本文件直接挂载时也按同一命名空间注册。
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
  ctx.provide(`${NAMESPACE}.bucket`, bucket)
  ctx.provide(`${NAMESPACE}.status`, status)

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
