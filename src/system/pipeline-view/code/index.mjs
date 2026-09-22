/**
 * 进树插件入口：`src/system/pipeline-view/`（**本批 EV-177 的真实承载**）。
 *
 * 做什么：把**已随实体搬迁落进本目录 `code/`** 的那一份实现（`./pipeline-view.mjs`）的公开面**重导出**
 * （`export *`，名字绑定是活的），并把它自述的 `inject`/`provides`/`Config`/`usedServices`
 * 原样透给宿主。**不新造功能**：本文件没有一行业务语义，也没有任何写面。
 *
 * 本插件的实体是**自进化产出**（`docs/work/evolution-log.json` 里 `name=pipeline-view` 那条，
 * `artifact_path` 就指 `code/pipeline-view.mjs`）；搬迁**字节守恒**，`tools/verify.sh evolve-module` 逐字节比对。
 *
 * `plugin.json` 的 `entry` 指到本文件 ⇒ `tools/plugin.sh status system/pipeline-view` 从
 * `degraded: artifact-missing` 变为合法清单（`valid:true`）；`provides` 同时由占位键改写为
 * 实体的**真实服务键**（pipelineView）。
 *
 * 为什么 `name` 由本文件给出：插件 id 的第二段就是插件的身份（`plugin.json` 的 `name`），
 * 与实体文件自带的 `name` 可以不同名（实体名是宿主模块名）。这是**命名**，不是语义。
 */
import * as impl from './pipeline-view.mjs'

export * from './pipeline-view.mjs'

export const name = 'pipeline-view'
export const inject = impl.inject
export const provides = impl.provides
export const usedServices = impl.usedServices
export const Config = impl.Config

/** 装载：把实体的 `apply` 原样转给宿主（本包装不加任何东西）。 */
export function apply(ctx, config) {
  return impl.apply(ctx, config)
}
