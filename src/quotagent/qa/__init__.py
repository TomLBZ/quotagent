"""qa 包：AC 注册表 + CLI 入口（`python -m quotagent.qa`）。"""

from __future__ import annotations

# 导入即注册（顺序无关，注册表按键排序输出）
from . import (checks_audit, checks_award, checks_bridge, checks_capacity, checks_clarify,  # noqa: F401
               checks_compare, checks_cost,
               checks_design, checks_deviation, checks_export, checks_eval, checks_events, checks_guard, checks_intake, checks_norm,
               checks_plugin, checks_pricing, checks_qep, checks_quotes, checks_rfq, checks_runtime,
               checks_sync, checks_terms, checks_change,
               checks_retention, checks_retention_exec, checks_negotiation, checks_faq, checks_mail,
               checks_ui_snapshot, checks_admin)
from .registry import (ACReport, Assertion, ACCheck, REGISTRY, list_acs, run_ac,  # noqa: F401
                       run_check, EXIT_CONFIG, EXIT_FAIL, EXIT_PASS)

__all__ = ["ACReport", "Assertion", "ACCheck", "REGISTRY", "list_acs", "run_ac", "run_check",
           "EXIT_CONFIG", "EXIT_FAIL", "EXIT_PASS"]
from . import checks_userplugin
from . import checks_userplugin_versions
from . import checks_userplugin_elevate
from . import checks_agentrt  # noqa: F401,E402  (AC-USERPLUG-001：用户空间插件 created/幂等/正文不入账本)
from . import checks_agentrt_memory  # noqa: F401,E402  (AC-AGENTRT-002：记忆四层边界)
from . import checks_storage  # noqa: F401,E402  (AC-STORAGE-001/004：逃逸与跨租户)
from . import checks_agentrt_lifecycle  # noqa: F401,E402  (AC-AGENTRT-007：独立装卸/零残留)
from . import checks_uxweb  # noqa: F401,E402  (AC-UXWEB-001：GUI 控制台化第一批)
from . import checks_config  # noqa: F401,E402  (AC-CONFIG-001：配置/凭据 UI)
from . import checks_mail_transport  # noqa: F401,E402  (AC-MAIL-001：邮件收发)
from . import checks_viz  # noqa: F401,E402  (AC-VIZ-001：比价 heuristics)
from . import checks_uifb  # noqa: F401,E402  (AC-UIFB-001：WebUI 反馈闭环)
from . import checks_adv  # noqa: F401,E402  (AC-ADV-001：AI agent 决策建议层)
from . import checks_gate  # noqa: F401,E402  (AC-GATE-001：审批等多久 / 变更单谁卡着)
from . import checks_usreq  # noqa: F401,E402  (AC-USREQ-006：cron 没待处理反馈时不得发垃圾消息)
from . import checks_qprep  # noqa: F401,E402  (AC-QUOTE-001：报价草稿写闭环 + 「不要假成功」的 405 围栏)
