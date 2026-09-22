#!/usr/bin/env python3
"""薄转发（迁移阶段 4.1）：实体已搬到 `src/system/runtime/tests/check-plugin-lifecycle.py`。

本文件**不含任何实现**：只把调用转到新位置（`runpy` 保持 `__file__` / `sys.argv` / 退出码语义——
实现按 `Path(__file__)` 定位仓库根，转发的 `__file__` 即新位置本身）。
门名不变：`tools/verify.sh plugin-lifecycle`。

纪律：① 改实现只改新位置那一份；② 本文件只许是转发（`tools/verify.sh plugin-assets` 断言：
目标存在、旧位置只剩薄转发、同一资产不得出现在别的插件目录里、`tools/` 下非薄入口数只减不增）。
"""
from __future__ import annotations

import runpy
from pathlib import Path

_TARGET = Path(__file__).resolve().parents[1] / "src" / "system" / "runtime" / "tests" / "check-plugin-lifecycle.py"
runpy.run_path(str(_TARGET), run_name="__main__")
