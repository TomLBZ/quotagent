/**
 * 进树插件入口：`src/system/canary/`（本批接上 `entry`，`D-081`）。
 *
 * 本目录里有两个**cordis 插件实体**：`canary.mjs`（`canary`：分流与自动回滚判定）、
 * `bridge-canary.mjs`（`canary-dispatch`：把分流接到真实桥调用上，`inject: ['canary']`）。
 * 另外两份 `canary-dispatch.mjs` / `canary-run.mjs` 是**库**（导出 `makeDispatcher` / `runCanary`，
 * 没有 `apply` 也没有 `provides`）⇒ 不是入口候选。
 *
 * 所以本入口是**机制组合**：先装 `canary`（`bridge-canary` 的 `inject` 依赖它），再装 `bridge-canary`；
 * `provides` 是两个实体 provides 的并集。**零业务语义、零写面**：本文件不算分、不判定、不写任何东西。
 *
 * 与被否决的选项：①只装 `canary.mjs`（否决：`canary-dispatch` 服务键在服务索引里永远 `unresolved`，
 * 而被否决的正是「接线文件不接线」这个已知限制，见 `canary-dispatch.mjs` 头部）
 * ②把 `canary-dispatch.mjs`/`canary-run.mjs` 也当入口（否决：它们不是插件，没有 `apply`）
 * ③不接（否决：`provides` 长期是占位键 `['canary']`，与实体自述不符）。
 *
 * 配置面：组合入口**不替成员解析配置**，每个成员按自己的 `Config` 取默认值装载。
 */
import * as canary from './canary.mjs'
import * as bridgeCanary from './bridge-canary.mjs'

/** 成员插件（`canary` 在前：`bridge-canary` 声明 `inject: ['canary']`）。 */
export const MEMBERS = [canary, bridgeCanary]

export const name = 'canary'
export const inject = []
export const provides = ['canary', 'canary-dispatch']
export const usedServices = []

/** 装载：把两个成员插件原样交给宿主（本包装不加任何东西）。 */
export function apply(ctx) {
  for (const member of MEMBERS) {
    ctx.plugin({ name: member.name, inject: member.inject ?? [], provides: member.provides ?? [],
      Config: member.Config, apply: member.apply }, {})
  }
}
