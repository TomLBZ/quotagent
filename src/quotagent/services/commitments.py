"""薄重导（迁移阶段 5）：服务模块的**实体**已搬到 `src/domain/commitments/code/commitments.py`。

本文件**不含实现**：把实体的源码在**本模块的命名空间**里执行，`__name__` = `quotagent.services.commitments`、
`__package__` = `quotagent.services` 保持不变 ⇒ `from ..services.commitments import …` 与模块之间的相对导入
（`from .approval import …`）**一字不改**。唯一一份实现只在 `src/domain/commitments/code/` 下。
"""
from __future__ import annotations

from pathlib import Path as _Path

_TARGET = _Path(__file__).resolve().parents[3] / "src/domain/commitments/code/commitments.py"
if not _TARGET.is_file():
    raise ImportError("commitments 的实体不在 " + str(_TARGET) + "（迁移阶段 5 的薄重导失效）")

exec(compile(_TARGET.read_text(encoding="utf-8"), str(_TARGET), "exec"), globals())

globals().pop("_Path", None)
globals().pop("_TARGET", None)
