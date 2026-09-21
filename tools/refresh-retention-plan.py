#!/usr/bin/env python3
"""把**留存计划**（`services/retention.py` 的只读判定）写到 `tmp/ui-shared/retention-plan.json`。

为什么这样分工：判定属于**事实层**（Python，ADR-0012），宿主只做展示；
宿主不自己算留存 —— 否则同一件事会有两份实现，早会漂移。
`now` 由调用方传入（内核不读墙钟）；默认策略见 `DEFAULT_RULES`，可用 `--policy` 覆盖。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402
from quotagent.services.retention import RetentionPolicy  # noqa: E402

UI = ROOT / "tmp" / "ui-shared"
# 默认策略：只声明**可重建副本**类的到期动作；不可重建物一律 keep（需要人工门时才动）
DEFAULT_RULES = {
    "compare/table-exported": {"retain_days": 30, "after": "archive"},
    "evidence/pack-exported": {"retain_days": 90, "after": "keep", "requires_approval": True},
}


def main() -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    policy = RetentionPolicy(DEFAULT_RULES, default_days=365.0)
    out = {"generated_at": now, "views": {}}
    for view in ("contractor", "supplier"):
        path = UI / view / "ledger.jsonl"
        if not path.exists():
            out["views"][view] = {"plan": None, "reason": "账本不存在"}
            continue
        ledger = Ledger(path, realm=f"{view}:ui")
        rows = ledger.read()
        out["views"][view] = {"plan": policy.plan(rows, now), "rows": len(rows)}
    target = UI / "retention-plan.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=1), encoding="utf-8")
    tmp.replace(target)
    print(json.dumps({"ok": True, "out": str(target.relative_to(ROOT)),
                      "views": {k: (v.get("rows") if v.get("plan") else 0) for k, v in out["views"].items()}},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
