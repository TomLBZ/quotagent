/**
 * 薄转发（迁移阶段 4.1）：实现已搬到 `src/system/evolution/tools/evolve-module.mjs`。
 * 门名（`tools/verify.sh evolve-module` 的调用方 `tools/check-evolved-module.py`）与 `host/` 侧
 * 的既有引用都指旧路径 —— 转发让它们**一行都不用改**；本文件不含任何实现。
 */
import './../src/system/evolution/tools/evolve-module.mjs'
