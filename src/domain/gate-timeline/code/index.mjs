/**
 * 进树插件入口：`src/domain/gate-timeline/`（**迁移阶段 4.1 先行 = 骨架 + wrapper，不是实体搬迁**）。
 *
 * 实体实现仍在 `host/modules/gate-timeline.mjs`（阶段 4.1 实体搬迁时才移进本目录 `code/`）。
 * 本文件只把实体实现的公开面**重导出**（`export *`）：`load` 真 import 本入口后，
 * `keys` 里必须出现只有实体实现才有的导出名（`AGE_CLOCK` / `SECTIONS` / `POLICY_EFFECTS` …）。
 *
 * 与 `src/domain/advice/code/index.mjs` 同一形态；本文件不新增任何语义，也不写任何文件。
 */
import * as impl from '../../../../host/modules/gate-timeline.mjs'

export * from '../../../../host/modules/gate-timeline.mjs'

/** 新布局下的插件 id（与目录名一致）；服务键仍由 `provides` 决定（= `gateTimeline`）。 */
export const name = 'gate-timeline'
export const inject = impl.inject
export const provides = impl.provides
export const Config = impl.Config
export const builtin = impl.builtin
export const usedServices = impl.usedServices

export function apply(ctx, config) {
  return impl.apply(ctx, config)
}

export function disposer() {
  return () => {}
}
