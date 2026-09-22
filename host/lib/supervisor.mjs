/**
 * 薄重导（迁移阶段 4.2/5，本批 `EV-177`）：实体已搬到 `src/system/kernel-bridge/code/supervisor.mjs`。
 *
 * 为什么库层也搬：`host/lib/**` 不单独成立插件 —— 它是**使用它的插件**的库层
 * （归宿规则见 `docs/work/plans/plugin-file-map.md` §规则：`host/lib/<f>.mjs` 按功能拆到
 * `system/{kernel,kernel-bridge,canary,config,evolution,user-plugin-manager,webui}/`）。
 * 旧导入路径照样是**活的**：`export *` 的名字绑定是活的，`host/modules/*.mjs` 与 `host/*.mjs`
 * 里的 `../lib/supervisor.mjs` 一行未改（本文件不含任何实现）。
 */
export * from '../../src/system/kernel-bridge/code/supervisor.mjs'
