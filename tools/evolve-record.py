#!/usr/bin/env python3
"""把一条 `evolve/*` 事件写进账本 —— **Python 是唯一写入者**（H1）。

宿主侧（`host/lib/evolution.mjs`）只产出事件体，落账一律经这里，避免"宿主直写账本"。

用法（由 host 冒烟脚本调用，也可手工用）：
    PYTHONPATH=src python3 tools/evolve-record.py --event evolve/proposed --body '{"id":"sha256:…"}' [--ledger path]
    PYTHONPATH=src python3 tools/evolve-record.py --event evolve/proposed --body @file.json

默认账本：`tmp/evolve/ledger.jsonl`（gitignored）。输出 JSON：{event, seq, ledger}。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.events import EventBus  # noqa: E402
from quotagent.kernel.ledger import Ledger  # noqa: E402

ALLOWED = ("evolve/proposed", "evolve/shadowed", "evolve/gated", "evolve/promoted", "evolve/rolled-back")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evolve-record", description="把 evolve/* 事件写进账本（唯一写入者：Python）")
    parser.add_argument("--event", required=True, choices=ALLOWED)
    parser.add_argument("--body", required=True, help="JSON 字符串，或 @path 读取文件")
    parser.add_argument("--ledger", default=str(ROOT / "tmp" / "evolve" / "ledger.jsonl"))
    args = parser.parse_args(argv)

    raw = args.body[1:] and Path(args.body[1:]).read_text(encoding="utf-8") if args.body.startswith("@") else args.body
    body = json.loads(raw)
    if body.get("actor") and not str(body["actor"]).startswith(("agent:", "host:", "human:")):
        print(json.dumps({"error": "actor 非法（只能是 agent:/host:/human:）"}, ensure_ascii=False))
        return 2

    bus = EventBus()
    bus.install_defaults()
    ledger_path = Path(args.ledger)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(ledger_path, realm="contractor:con-B")
    ledger.assert_healthy()
    ref = ledger.append(args.event, body, correlation_id=body.get("id") or body.get("proposal_id"),
                        event_class="intent", actor=body.get("actor", "host:evolution"))
    bus.dispatch(args.event, body)
    print(json.dumps({"event": args.event, "seq": ref.seq if ref else None,
                      "ledger": str(ledger_path), "count": Ledger(ledger_path).count},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
