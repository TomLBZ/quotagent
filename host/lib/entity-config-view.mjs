/**
 * 薄重导（迁移阶段 4.2/5，本批 EV-176）：实体已搬到 `src/system/config/code/config-view.mjs`。
 *
 * 为什么中间要过一个 `host/lib/` 的跳板：`tools/verify.sh modules` 的 A6 断言（`host/modules/<stem>.mjs`
 * 的相对 import 只允许同目录 `./` 与库层 `../lib/`）**按源码文本**判 —— 宿主模块对外只依赖库层这一条
 * 纪律，正是搬完实体后仍然成立的那一条。本文件不含任何实现，只做重导（唯一实现 = `src/system/config/code/config-view.mjs`）。
 */
export * from '../../src/system/config/code/config-view.mjs'
