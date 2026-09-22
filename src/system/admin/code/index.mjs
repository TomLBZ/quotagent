/**
 * 进树插件入口：`src/system/admin/`（本批接上 `entry`，`D-079`）。
 *
 * 本目录里有两个**各自独立的 cordis 插件实体**（不是「一个服务 + 支持库」的关系，两者都有
 * `apply`/`provides`/`Config`，分别提供 `adminGuard`（门卫）与 `adminView`（只读面板）），
 * 它们本来就是宿主里两个平级模块（`host/modules/admin-guard.mjs`、`host/modules/admin-view.mjs`）。
 * 所以本入口是**机制组合**：把两个成员插件按声明顺序交给宿主，`provides` 是两个实体 provides 的并集。
 * **零业务语义、零写面**：本文件不做判断、不算数、不读文件、不写任何东西。
 *
 * 与被否决的选项：①只挑一个当入口（否决：另一个的服务键在服务索引里永远 `unresolved`，
 * `plugin.sh load system/admin` 也就只装半个插件，且清单的 `provides` 会与事实不符）
 * ②把目录拆成 `src/system/admin-guard` + `src/system/admin-view` 两个插件（否决：63 个插件的
 * 数量与需求归属（15 覆盖矩阵 / `plugin-requirements-map` 的逐插件行）是冻结事实，拆目录会连带
 * 改动归属真源，超出「接上 entry」的范围）③不接（否决：`provides` 长期是占位键 `['admin']`，
 * 与实体的真实服务键不符）。
 *
 * 配置面：组合入口**不替成员解析配置**，每个成员按自己的 `Config` 取默认值装载（与宿主里
 * 两个模块各自装载时的形态一致）。要传非默认配置请直接装成员实体。
 */
import * as guard from './admin-guard.mjs'
import * as view from './admin-view.mjs'

/** 成员插件（按 id 字典序；顺序只影响装载次序，不影响语义）。 */
export const MEMBERS = [guard, view]

export const name = 'admin'
export const inject = []
export const provides = ['adminGuard', 'adminView']
export const usedServices = []

/** 装载：把两个成员插件原样交给宿主（本包装不加任何东西）。 */
export function apply(ctx) {
  for (const member of MEMBERS) {
    ctx.plugin({ name: member.name, inject: member.inject ?? [], provides: member.provides ?? [],
      Config: member.Config, apply: member.apply }, {})
  }
}
