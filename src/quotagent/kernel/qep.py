"""薄重导（迁移阶段 5）：内核模块的**实体**已搬到 `src/system/kernel/code/qep.py`。

本文件**不含内核实现**（内核不可自改：ADR-0002 / INV-010）：把实体的源码在**本模块的命名空间**里执行，
`__name__` = `quotagent.kernel.qep`、`__package__` = `quotagent.kernel` 保持不变 ⇒
`import quotagent.kernel.qep` 与内核模块之间的相对导入（`from .canon import …`）**一字不改**。
内核的唯一一份实现只在 `src/system/kernel/code/` 下；改内核仍然要改那一个文件。
"""
from __future__ import annotations

from pathlib import Path as _Path

_TARGET = _Path(__file__).resolve().parents[3] / "src" / "system" / "kernel" / "code" / "qep.py"
if not _TARGET.is_file():
    raise ImportError("kernel/qep 的实体不在 " + str(_TARGET) + "（迁移阶段 5 的薄重导失效）")

exec(compile(_TARGET.read_text(encoding="utf-8"), str(_TARGET), "exec"), globals())

globals().pop("_Path", None)
globals().pop("_TARGET", None)
