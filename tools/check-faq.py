#!/usr/bin/env python3
"""FAQ 沉淀与复用的入库门（`tools/verify.sh faq`）——跑 `AC-FAQ-001` 的断言集。

核心语义（D-051 / AC-CLARIFY-004）：**复用不得跨版本**，且命中是**纯读**。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.qa import checks_faq  # noqa: E402,F401  导入即注册
from quotagent.qa.registry import REGISTRY, run_check  # noqa: E402

AC = "AC-FAQ-001"
report = run_check(REGISTRY[AC])
total = len(report.assertions)
passed = sum(1 for a in report.assertions if a.ok)
print(json.dumps({"ac": AC, "exit": report.exit_code(), "passed": passed, "total": total,
                  "failures": [a.name for a in report.assertions if not a.ok][:6]}, ensure_ascii=False))
print(f"断言 {passed}/{total} 通过")
sys.exit(report.exit_code())
