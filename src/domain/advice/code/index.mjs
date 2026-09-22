/**
 * 进树插件入口：`src/domain/advice/`（**阶段 1 = wrapper/重导出，不是实体搬迁**）。
 *
 * 实体实现仍在 `host/modules/advice-panel.mjs`（阶段 4.1 实体搬迁时才移进本目录 `code/`）。
 * 本文件是"新布局下的入口"，做两件事：
 *   ① **重导出**实体实现的公开面（`export *`）：`ENGINE` / `ENGINE_NOTE` / `RULES` / `adviseOf` / `isoMs` …
 *      —— 由 `tools/plugin.sh load domain/advice` 真 import 一次，键集合即"入口真的指到实现"的证据；
 *   ② 在实体实现的 `apply` 之上**加一个只读区块**注册（注入式 UI，契约见 `docs/ui-block-contract.md`）：
 *      区块内容来自实体实现的**运行期服务面**（`meta()` / `advise(undefined)`），不是复制的常量。
 *
 * 为什么用 `ctx.inject(['uiSlots'], …)` 而不是 `inject: ['uiSlots']`：`uiSlots` 由 `webui` 提供，
 * 而 `webui` 的 `inject` 里有本插件（`advicePanel`）——静态 inject 会成环（两边互相等）。
 * `ctx.inject` 是**动态依赖**：依赖就绪才注册；依赖消失时 cordis 自动 dispose（区块随之消失，零残留）。
 */
import * as impl from '../../../../host/modules/advice-panel.mjs'

export * from '../../../../host/modules/advice-panel.mjs'

/** 新布局下的插件 id（与目录名一致）；服务键仍由 `provides` 决定（= 实体实现的 `advicePanel`）。 */
export const name = 'advice'
export const inject = []
export const provides = impl.provides
export const Config = impl.Config
export const builtin = impl.builtin
export const usedServices = impl.usedServices

/** 注入式 UI：本插件注册的区块（槽位 + 排序 + 标题；`render` 只读、确定性）。 */
export const BLOCK = { slot: 'page.contractor', order: 20,
  title: '决策建议（domain/advice 插件注册的只读区块）' }

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 区块渲染（**只读**）：直接读实体实现的运行期服务面。
 * 拿不到服务时**如实报未就绪**（不编一条"看起来有用"的建议）—— 返回值仍是 `{ok:true, html}`：
 * 页面纪律要求"没有数据"也要能渲染出**说明**，而不是抛错或留白。
 */
export const renderBlock = (service) => {
  if (!service || typeof service.meta !== 'function' || typeof service.advise !== 'function') {
    return '<p>实体实现的服务面未就绪（本区块如实报，不编内容）：' +
      '<code>reason=advice-panel-service-unavailable</code></p>'
  }
  const meta = service.meta()
  const verdict = service.advise(undefined)          // 空载荷 ⇒ degraded + 有名 reason + 0 条建议
  const rows = (meta.rules ?? []).map((rule) =>
    `<tr><td><code>${esc(rule.rule)}</code></td><td>${esc(rule.label)}</td></tr>`).join('')
  return `<p>引擎自述：<code>engine=${esc(meta.engine)}</code> —— ${esc(meta.engine_note)}</p>`
    + `<table data-advice-rules="1"><tr><th>规则</th><th>含义</th></tr>${rows}</table>`
    + `<p>空载荷试跑（**没有可分的数据就不给建议**）：<code>degraded=${esc(String(verdict.degraded))}</code> · `
    + `<code>reason=${esc(verdict.reason ?? 'null')}</code> · <code>items=${esc(String((verdict.items ?? []).length))}</code></p>`
    + `<p><small>本区块**只读**：不读账本、不取墙钟、不写任何文件；由本插件自己注册，webui 不知道它的业务含义。</small></p>`
}

/** 装载：先跑实体实现（提供 `advicePanel`），再向 webui 的注册面提交本区块。 */
export function apply(ctx, config) {
  impl.apply(ctx, config)
  // 服务面靠**动态 inject** 拿到（cordis 不许读没 inject 的服务；实测过一条坑：给 `ctx.provide` 赋值
  // 会让该 context 在 dispose 后再也挂不上插件（`cannot create effect on inactive context`），所以
  // 本插件不拦截 provide，而是把两个依赖（自己提供的服务 + webui 的注册面）一起 inject 进来）。
  // **装载期快照**服务面：`scope.<服务>` 只在依赖就绪的窗口里可读（渲染期再读会抛
  // `cannot get required service … in inactive context`）；卸载时靠 effect 的返回函数反注册（零残留）。
  ctx.inject(['advicePanel', 'uiSlots'], (scope) => {
    const panel = scope.advicePanel
    scope.effect(() => {
      const verdict = scope.uiSlots.register({
        plugin_id: 'domain/advice',
        slot: BLOCK.slot,
        order: BLOCK.order,
        title: BLOCK.title,
        render: () => ({ ok: true, html: renderBlock(panel) }),
      })
      return verdict.ok === true ? verdict.dispose : () => {}
    })
  })
}

export function disposer() {
  return () => {}
}
