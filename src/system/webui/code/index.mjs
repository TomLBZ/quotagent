/**
 * 进树插件入口：`src/system/webui/`（本批 `EV-181` 接上 `entry`）。
 *
 * 做什么：把**已在本目录 `code/` 的实体** `webui.mjs` 的公开面**重导出**（`export *`，名字绑定是活的），
 * 并把它自述的 `inject`/`provides`/`usedServices`/`Config` 原样透给宿主。**不新造功能**：本文件没有
 * 一行业务语义、没有任何写面、也没有第二份实现 —— `webui.mjs` 是唯一实现。
 *
 * `provides` 是实体的**真实服务键**（`webui` = 页面与只读路由装配；`uiSlots` = 注入式 UI 的注册面，
 * 机制、0 业务语义），不是此前的占位键 `['webui']`。决策与**被否决的选项**见
 * `docs/work/decisions.md` 的 D-078。
 */
import * as impl from './webui.mjs'

export * from './webui.mjs'

export const name = 'webui'
export const inject = impl.inject
export const provides = impl.provides
export const usedServices = impl.usedServices
export const Config = impl.Config

/** 装载：把实体的 `apply` 原样转给宿主（本包装不加任何东西）。 */
export function apply(ctx, config) {
  return impl.apply(ctx, config)
}
