/**
 * 进树插件入口：`src/system/projection/`（**迁移阶段 4.1 先行 = 骨架 + wrapper，不是实体搬迁**）。
 *
 * 实体实现仍在 `host/modules/projection.mjs`（阶段 4.1 实体搬迁时才移进本目录 `code/`）。
 * 本文件只做一件事：把实体实现的公开面**重导出**（`export *`），让「目录即清单 + 六动词」在
 * 本插件上立刻成立 —— `tools/plugin.sh load system/projection` 真 import 本入口，
 * `keys` 里出现只有实体实现才有的导出名（`project` / `projectWithAudit` / `VIEW_RULES` …）。
 *
 * 与 `src/domain/advice/code/index.mjs` 同一形态（阶段 1 已成立的样板），本文件不新增任何语义：
 * 不注册区块、不订阅事件、不写文件（`permissions.ledger = none`）。
 */
import * as impl from '../../../../host/modules/projection.mjs'

export * from '../../../../host/modules/projection.mjs'

/** 新布局下的插件 id（与目录名一致）；服务键仍由 `provides` 决定（= 实体实现的 `projection`）。 */
export const name = 'projection'
export const inject = impl.inject
export const provides = impl.provides
export const Config = impl.Config
export const builtin = impl.builtin
export const usedServices = impl.usedServices

/** 装载：把实体实现的 `apply` 原样转给宿主（本 wrapper 不加任何东西）。 */
export function apply(ctx, config) {
  return impl.apply(ctx, config)
}

export function disposer() {
  return () => {}
}
