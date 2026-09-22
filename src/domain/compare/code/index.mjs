/**
 * 进树插件入口：`src/domain/compare/`（**本批 `EV-179` 的真实承载**）。
 *
 * 做什么：把**已随实体搬迁落进本目录 `code/`** 的那一份实现（`./compare.mjs`）的公开面**重导出**
 * （`export *`，名字绑定是活的），并把它自述的 `inject`/`provides`/`builtin`/`usedServices`/`Config`
 * 原样透给宿主。**不新造功能**：本文件没有一行业务语义，也没有任何写面。
 *
 * 为什么 `entry` 指本文件而不是 `./compare.mjs`：`plugin.json` 的 `entry` 是**装载面**（27 §7.1 的
 * 宿主默认口径是 `code/index.mjs`）；实体的语义仍只在 `./compare.mjs` 里（一处一事实）。
 * `tools/plugin.sh status domain/compare` 因此从 `degraded: artifact-missing` 变为合法清单（`valid:true`）。
 *
 * 为什么 `name` 由本文件给出：插件 id 的第二段就是插件的身份（`plugin.json` 的 `name`），
 * 与实体文件自带的 `name` 可以不同名（实体名是宿主模块名）。这是**命名**，不是语义。
 */
import * as impl from './compare.mjs'

export * from './compare.mjs'

export const name = 'compare'
export const inject = impl.inject
export const provides = impl.provides
export const builtin = impl.builtin
export const usedServices = impl.usedServices
export const Config = impl.Config

/** 装载：把实体的 `apply` 原样转给宿主（本包装不加任何东西）。 */
export function apply(ctx, config) {
  return impl.apply(ctx, config)
}
