/**
 * 薄重导（迁移阶段 4.2/5，本批 `EV-177`）：实体已搬到 `src/system/ops-view/code/ops-view.mjs`。
 *
 * 为什么要过这一跳：`tools/verify.sh modules` 的 A6 断言（`host/modules/<stem>.mjs` 的相对 import
 * 只允许同目录 `./` 与库层 `../lib/`）**按源码文本**判 —— 宿主模块对外只依赖库层这一条纪律，
 * 正是搬完实体后仍然成立的那一条。本文件不含任何实现，只做重导。
 */
export * from '../../src/system/ops-view/code/ops-view.mjs'
