#!/usr/bin/env python3
"""留存与销毁的入库门（`tools/verify.sh retention`）——**两侧都跑**。

· `AC-AUDIT-003`（计划侧）：只读判定器 `services/retention.py`（账本行永不销毁、未知类型不判销毁、
  确定性、无副作用、有界、销毁须人工门）；
· `AC-AUDIT-005`（执行侧）：执行器 `services/retention_exec.py`（真删派生副本、账本落痕不含被销毁内容、
  读侧封存、越界与缺批准一律拒绝、幂等）。

**边界声明**：`AC-AUDIT-003` 在文档里的字面要求（"销毁生效后目标事件不可再读"）由两侧合起来满足 ——
计划侧给判定与拒绝，执行侧给真实销毁与落痕。**先删后记的时间窗未消除**（删除与 append 之间进程被杀
会留下"已删未记"，业务上会按"未封存"处理）——这条已记入 D-048，不声称已解决。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.qa import checks_retention, checks_retention_exec  # noqa: E402,F401  导入即注册
from quotagent.qa.registry import REGISTRY, run_check  # noqa: E402

ACS = ["AC-AUDIT-003", "AC-AUDIT-005"]
summary, ok = [], True
for ac in ACS:
    report = run_check(REGISTRY[ac])
    code = report.exit_code()
    total = len(report.assertions)
    passed = sum(1 for a in report.assertions if a.ok)
    ok = ok and code == 0
    summary.append({"ac": ac, "exit": code, "passed": passed, "total": total})
    print(f"[{ac}] exit={code} 断言 {passed}/{total} 通过")
print(json.dumps({"gate": "retention", "acs": summary, "note": "计划侧 + 执行侧"}, ensure_ascii=False))
sys.exit(0 if ok else 1)
