/**
 * 薄重导（迁移阶段 5，本批 `EV-178`）：实体已搬到 `src/system/kernel-bridge/code/kernel-bridge.mjs`（经 `host/lib/entity-kernel-bridge.mjs`
 * 一跳，理由见该文件头部）。`host/modules/*.mjs` 的**导入面与目录即清单的自动发现**
 * （`host/modules/index.mjs`）一行未改：`import`/`export *` 的名字绑定是**活的**，与搬前逐名一致。
 */
export * from '../lib/entity-kernel-bridge.mjs'
