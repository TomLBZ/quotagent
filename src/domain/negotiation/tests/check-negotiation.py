#!/usr/bin/env python3
"""谈判轮次/让步的入库门（`tools/verify.sh negotiation`）。

跑 `checks_negotiation` 注册的 `AC-NEGO-003` 断言集（≥15 条，含变异自证记录见 EV-092）。
本门只验证**服务层**行为；`FR-NEGO-001/002` 的完整语义另由 `docs/design/16/17` 与 ADR-0019 界定。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.qa import checks_negotiation  # noqa: E402,F401  导入即注册
from quotagent.qa.registry import REGISTRY, run_check  # noqa: E402

AC = "AC-NEGO-003"
report = run_check(REGISTRY[AC])
total = len(report.assertions)
passed = sum(1 for a in report.assertions if a.ok)
print(json.dumps({"ac": AC, "exit": report.exit_code(), "passed": passed, "total": total,
                  "failures": [a.name for a in report.assertions if not a.ok][:6]}, ensure_ascii=False))
print(f"断言 {passed}/{total} 通过")
sys.exit(report.exit_code())
