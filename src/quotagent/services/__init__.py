"""服务层（L1 能力接缝）：每项能力都是 Definition + Provider + Consumer 的三角（`01-architecture.md` §3）。

业务逻辑只在这里与插件里，不进内核（`AGENTS.md` 规则 10 / ADR-0002）。
"""

from __future__ import annotations

__all__ = ["measures", "norm", "rfq", "intake"]
