#!/usr/bin/env python3
"""薄转发（迁移阶段 4.1）：src/system/evidence/tools/audit-verify.py

本文件是**直接可执行的独立入口**（AC-AUDIT-004 用 `subprocess` 把它当 argv[0] 起进程）：
所以它必须有 shebang 且在**索引里**是 `100755`（只 chmod 工作树不进仓库 ⇒ 新克隆里
`Exec format error`）。转发本身不含实现，只把调用转到新位置。
"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/evidence/tools/audit-verify.py"), run_name="__main__")
