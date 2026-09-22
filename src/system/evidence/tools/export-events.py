#!/usr/bin/env python3
"""把事件表导出成 JSON，供宿主侧 fixture A4 使用（**事件表真源只有一处：Python 侧**）。

用法（由 `tools/check-modules.py` 调用）：
    PYTHONPATH=src python3 tools/export-events.py [--out tmp/events.json]

输出：`{"count": N, "events": ["...", ...]}`（已排序，便于字节级比较）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/export-events.py` 只剩**薄转发**。
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.events import EventBus  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="export-events", description="导出事件表（唯一真源：Python 侧）")
    parser.add_argument("--out", default=str(ROOT / "tmp" / "events.json"))
    args = parser.parse_args(argv)

    bus = EventBus()
    bus.install_defaults()
    names = sorted(bus.declared())
    payload = {"count": len(names), "events": names}
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(target), "count": len(names)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
