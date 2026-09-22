/*
 * 薄转发（迁移阶段 4.1）：实体已搬到 `src/system/runtime/tests/netblock.c`。
 * 本文件**不含实现**：只把同一个编译单元包含进来 —— 按仓库路径编译的既有命令
 * （`gcc -shared -fPIC -O0 -o netblock.so tools/netblock.c -ldl`）一行都不用改。
 * 为什么这么转发：`.c` 没有 import 机制，`#include` 就是它的"薄重导"；
 * 纪律（`tools/verify.sh plugin-assets`）：改实现只改新位置那一份、旧位置不许留实体。
 */
#include "../../src/system/runtime/tests/netblock.c"
