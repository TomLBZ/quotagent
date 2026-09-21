"""qa 包：AC 注册表 + CLI 入口（`python -m quotagent.qa`）。"""

from __future__ import annotations

# 导入即注册（顺序无关，注册表按键排序输出）
from . import (checks_audit, checks_bridge, checks_compare, checks_cost, checks_design,  # noqa: F401
               checks_deviation, checks_eval, checks_events, checks_guard, checks_intake, checks_norm,
               checks_plugin, checks_pricing, checks_qep, checks_rfq, checks_runtime)
from .registry import (ACReport, Assertion, ACCheck, REGISTRY, list_acs, run_ac,  # noqa: F401
                       run_check, EXIT_CONFIG, EXIT_FAIL, EXIT_PASS)

__all__ = ["ACReport", "Assertion", "ACCheck", "REGISTRY", "list_acs", "run_ac", "run_check",
           "EXIT_CONFIG", "EXIT_FAIL", "EXIT_PASS"]
