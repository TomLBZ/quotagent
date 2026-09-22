"""进树插件的 **Python 承载入口**：`system/eval`（本批 `EV-181` 接上 `entry`）。

做什么：把**已经在本插件 `code/` 里的**那三份实现的公开面**原样重导出**
（`evaldata.py` 反例集 / `evalmetrics.py` 指标与基线 / `scenarios.py` 场景集 S1..S4），
让 `plugin.json` 的 `entry` 指向一个**真实存在**的入口 —— 此前 `entry` 写的是 `code/index.mjs`
（不存在）⇒ `tools/plugin.sh list` 如实报 `degraded: artifact-missing`（清单先行形态的已知缺口）。

**不新造功能**：本文件没有一行业务语义、没有任何写面，也没有第二份实现 —— 三个 `.py` 是唯一实现。

装载口径（与 `system/measures` 的 `code/__init__.py` **同形**）：`entry` 是**装载面**，不是实现；
`src/system/runtime/code/plugin-registry.mjs` 的 `entryKind()` 把 `.py` 记为 `kind: 'python'`
（ESM 侧的 `mount()` 只装载 ESM 入口：Python 实体的装载由 Python 侧负责，见 27 §7.1）。

**为什么不是 `code/index.mjs`**（被否决的选项，见 `docs/work/decisions.md` 的 D-083）：
本插件在宿主侧**没有任何 ESM 实体**（0 个 `provides`/`apply` 的 `.mjs`），写一个 `index.mjs`
只能是空壳或新造的宿主面 = 造功能 ✗。

为什么经 `quotagent.services.<模块>` 导入而不是直接按文件路径：三份实现都用**包内相对导入**
（`from ..kernel.ledger …` / `from ..paths …`），只有在原包上下文里才解析得到 —— 这正是搬迁后
旧导入面（薄重导）仍然成立的那一条；本入口把 `src/` 放上导入面，使**独立执行本文件**也能导入
同一份实现（无双实例）。
"""
from __future__ import annotations

import sys
import types as _types
from pathlib import Path as _Path

_SRC = _Path(__file__).resolve().parents[3]          # `code/` → 插件 → 层 → `src/`
if str(_SRC) not in sys.path:                         # 与 `tools/run.sh` 同一约定：仓库 `src/` 在导入面上
    sys.path.insert(0, str(_SRC))

from quotagent.services.evaldata import *                # noqa: F401,F403,E402  —— 公开面**原样**重导出
from quotagent.services.evalmetrics import *             # noqa: F401,F403,E402
from quotagent.services.scenarios import *               # noqa: F401,F403,E402
from quotagent.services import evaldata as _evaldata     # noqa: E402
from quotagent.services import evalmetrics as _evalmetrics  # noqa: E402
from quotagent.services import scenarios as _scenarios   # noqa: E402

_IMPLS = (_evaldata, _evalmetrics, _scenarios)


def _public(module) -> list[str]:
    """某份实现的公开面：它自己的 `__all__`（若有），否则 = 本模块定义的名字（排除 import 进来的别家对象）。"""
    declared = getattr(module, "__all__", None)
    if declared:
        return list(declared)
    return sorted(
        _name for _name, _obj in vars(module).items()
        if not _name.startswith("_")
        and not isinstance(_obj, _types.ModuleType)
        and (not hasattr(_obj, "__module__") or str(getattr(_obj, "__module__", "")).startswith(module.__name__)))


#: 公开面 = 三份实现公开面的**并集**（去重、升序）。
__all__ = sorted({name for module in _IMPLS for name in _public(module)})

globals().pop("_types", None)
globals().pop("_Path", None)
globals().pop("_SRC", None)
