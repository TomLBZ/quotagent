"""薄转发（迁移阶段 4.1）：AC 检查模块的实体已搬到 `src/domain/quote-prepare/tests/checks_qprep.py`。

本文件**不含任何 AC 断言**：按文件路径装载实体模块，注册副作用照旧发生在 `quotagent.qa.registry`
（`from . import checks_qprep` 的既有导入面不变）。门名不变：`tools/verify.sh ac AC-QUOTE-001`。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_TARGET = Path(__file__).resolve().parents[3] / "src" / "domain" / "quote-prepare" / "tests" / "checks_qprep.py"
if not _TARGET.is_file():
    raise ImportError("checks_qprep 的实体不在 " + str(_TARGET) + "（迁移阶段 4.1 的薄转发失效）")
_SPEC = importlib.util.spec_from_file_location(__name__ + "._impl", _TARGET)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
