"""薄转发（迁移阶段 4.1）：AC 检查模块的实体已搬到 `src/domain/quotes/tests/checks_quotes.py`；本文件不含任何 AC 断言。

按文件路径装载实体，注册副作用照旧发生在 `quotagent.qa.registry`（`from . import checks_quotes` 的既有导入面不变）。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_T = Path(__file__).resolve().parents[3] / "src/domain/quotes/tests/checks_quotes.py"
if not _T.is_file():
    raise ImportError("checks_quotes 的实体不在 " + str(_T) + "（迁移阶段 4.1 的薄转发失效）")
_S = importlib.util.spec_from_file_location(__name__ + "._impl", _T)
_M = importlib.util.module_from_spec(_S)
_S.loader.exec_module(_M)
