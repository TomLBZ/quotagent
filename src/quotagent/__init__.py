"""quotagent —— 承包商 ↔ 供应商 采购-报价闭环 agent 运行时（P0 mock）。

实现栈与账本格式见 `docs/design/adr/0007-p0-runtime-and-ledger-format.md`。
硬约束：仅标准库（无第三方运行时依赖）；单进程、文件账本、文件投递（`docs/design/01-architecture.md` §6）。
"""

from __future__ import annotations

__version__ = "0.1.0"
QEP_VERSION = "1.0"
PROFILE = "minimal-mock"

__all__ = ["__version__", "QEP_VERSION", "PROFILE"]
