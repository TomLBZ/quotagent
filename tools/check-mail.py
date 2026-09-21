#!/usr/bin/env python3
"""邮件集成（无凭据部分）的入库门（`tools/verify.sh mail`）——跑 `AC-MAIL-001` 的断言集。

边界（D-052）：本轮**没有发信能力**；`deliver()` 必须显式返回 unavailable + reason + next_action，
且账本里**不存在 `mail/sent`**。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.qa import checks_mail  # noqa: E402,F401  导入即注册
from quotagent.qa.registry import REGISTRY, run_check  # noqa: E402

AC = "AC-MAIL-001"
report = run_check(REGISTRY[AC])
total = len(report.assertions)
passed = sum(1 for a in report.assertions if a.ok)
print(json.dumps({"ac": AC, "exit": report.exit_code(), "passed": passed, "total": total,
                  "failures": [a.name for a in report.assertions if not a.ok][:6]}, ensure_ascii=False))
print(f"断言 {passed}/{total} 通过")
sys.exit(report.exit_code())
