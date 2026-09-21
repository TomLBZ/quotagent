#!/usr/bin/env python3
"""留存判定器的入库门（`tools/verify.sh retention`）。

跑 `checks_retention` 注册的断言集（AC-AUDIT-003 的断言）。

**如实声明**：本轮实现的是**只读判定器**（`services/retention.py`）——它计算留存计划、
拒绝一切"销毁账本行"的意图、给出人工门与留痕要求，但**不执行销毁**、不落账本事件。
`AC-AUDIT-003` 的字面要求含"销毁**生效后**目标事件不可再读"，其**执行侧**
（真正删除派生副本 + 读侧封存 + 落 `evidence/retention-*`）尚未实现，
因此 `checks_retention` **未**加入 `qa/__init__.py` 的注册表 —— `qa ac AC-AUDIT-003`
仍如实返回"未实现"（退出码 2）。本门只验证**已实现的那部分**，执行侧见清单 T-253。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.qa import checks_retention  # noqa: E402,F401  导入即注册
from quotagent.qa.registry import REGISTRY, run_check  # noqa: E402

AC = "AC-AUDIT-003"
report = run_check(REGISTRY[AC])
raw = report.as_dict() if hasattr(report, "as_dict") else json.loads(report.to_json())
print(json.dumps({"ac": AC, "status": "pass" if report.exit_code() == 0 else "fail",
                  "scope": "plan-only（执行侧未实现，见 T-253）", "assertions": raw.get("assertions", [])},
                 ensure_ascii=False, indent=2)[:6000])
print(f"断言 {raw.get('passed')}/{raw.get('total')} 通过；范围=plan-only；退出码={report.exit_code()}")
sys.exit(report.exit_code())
