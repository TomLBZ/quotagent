"""进树插件的 **Python 承载入口**：`domain/faq`（本批 `EV-178`）。

做什么：把**已经在本插件 `code/` 里的**那一份实现（`faq.py`）的公开面**原样重导出**，让
`plugin.json` 的 `entry` 指向一个**真实存在**的入口 —— 此前 `entry` 写的是 `code/index.mjs`（不存在）
⇒ `tools/plugin.sh list` 如实报 `degraded: artifact-missing`（清单先行形态的已知缺口）。

**不新造功能**：本文件没有一行业务语义、没有任何写面，也没有第二份实现 —— `faq.py` 是唯一实现。

装载口径（与 ESM 侧的 `code/index.mjs` 包装同形）：`entry` 是**装载面**，不是实现；
`src/system/runtime/code/plugin-registry.mjs` 的 `entryKind()` 把 `.py` 记为 `kind: 'python'`
（ESM 侧的 `mount()` 只装载 ESM 入口：Python 实体的装载由 Python 侧负责，见 27 §7.1）。

为什么经 `quotagent.services.faq` 导入而不是直接按文件路径：`faq.py` 用的是**包内相对导入**
（`from ..kernel.canon …`），只有在原包上下文里才解析得到 —— 这正是搬迁后旧导入面（薄重导）仍然
成立的那一条；本入口把 `src/` 放上导入面，使**独立执行本文件**也能导入同一份实现（无双实例）。
"""
from __future__ import annotations

import sys
import types as _types
from pathlib import Path as _Path

_SRC = _Path(__file__).resolve().parents[3]          # `code/` → 插件 → 层 → `src/`
if str(_SRC) not in sys.path:                         # 与 `tools/run.sh` 同一约定：仓库 `src/` 在导入面上
    sys.path.insert(0, str(_SRC))

from quotagent.services.faq import *                # noqa: F401,F403,E402  —— 公开面**原样**重导出
from quotagent.services import faq as _impl         # noqa: E402

#: 公开面 = 实体自述的 `__all__`（若有）；否则 = **本模块定义的名字 + 本模块的数据常量**
#: （`vars()` 里 `__module__` 指向别处的名字是它 import 进来的别家对象，不算本服务的公开面）。
__all__ = list(getattr(_impl, "__all__", None) or sorted(
    _name for _name, _obj in vars(_impl).items()
    if not _name.startswith("_")
    and not isinstance(_obj, _types.ModuleType)
    and (not hasattr(_obj, "__module__") or str(getattr(_obj, "__module__", "")).startswith(_impl.__name__)))
)
globals().pop("_types", None)

globals().pop("_Path", None)
globals().pop("_SRC", None)
