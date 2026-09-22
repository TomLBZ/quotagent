/**
 * 薄重导（迁移阶段 5，本批 `EV-178`）：实体已搬到 `src/system/user-plugin-manager/code/user-space.mjs`。
 *
 * 为什么留在旧路径：`host/evolution.mjs`（冒烟）与 `src/**` 的既有读方都按旧路径引用
 * （`host/evolution.mjs` 的 `import ... from './lib/evolution.mjs'`、`src/userspace/README.txt`
 * 与设计文档的说法）—— 一行的重导让它们**一行都不用改**（门名与导入面是接口）。
 * 本文件不含任何实现：唯一实现 = `src/system/user-plugin-manager/code/user-space.mjs`。
 */
export * from '../../src/system/user-plugin-manager/code/user-space.mjs'
