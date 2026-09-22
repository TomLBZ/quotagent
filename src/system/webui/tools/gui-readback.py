#!/usr/bin/env python3
"""Python 侧回读：直接读两侧账本 jsonl，逐行打印**原始行**（证明 GUI 的动作真的落了账）。

用法：python3 tmp/gui-readback.py [--shared tmp/gui-run]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

TYPES = None


def dump(path: Path, label: str) -> dict:
    print(f"\n================ 账本：{label}（{path}）================")
    if not path.exists():
        print("（账本不存在）")
        return {}
    counts = {}
    lines = path.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines, 1):
        if not line.strip():
            continue
        row = json.loads(line)
        counts[row["type"]] = counts.get(row["type"], 0) + 1
        print(f"seq={row['seq']:>3} type={row['type']:<24} class={row.get('class'):<10} "
              f"actor={row.get('actor')} ts={row.get('ts')} corr={row.get('correlation_id')}")
        print(f"        body={json.dumps(row.get('body'), ensure_ascii=False, sort_keys=True)}")
    print(f"-- 合计 {len(lines)} 行；按类型：{json.dumps(counts, ensure_ascii=False, sort_keys=True)}")
    return counts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--shared', default='tmp/gui-run')
    args = ap.parse_args()
    shared = Path(args.shared).resolve()
    c = dump(shared / 'contractor' / 'ledger.jsonl', 'contractor（承包商侧自己的账本）')
    s = dump(shared / 'supplier' / 'ledger.jsonl', 'supplier（供应商侧自己的账本）')
    print('\n================ 共享交换目录（投递信封 / 包快照 / 授标意向）================')
    for rel in ['contractor/01-package.json', 'contractor/rfq-pkg-gui-rev1.json',
                'exchange/award-intents.json']:
        target = shared / rel
        print(f"\n--- {rel}（{'存在' if target.exists() else '缺失'}）")
        if target.exists():
            print(json.dumps(json.loads(target.read_text(encoding='utf-8')), ensure_ascii=False, indent=1)[:1500])
    print('\n================ 待办件（宿主只落 0600 待办件；唯一写者消费后归档）================')
    for kind in ['rfq-publish', 'quote-drafts', 'commitment-apply']:
        base = shared / kind
        pending = sorted(p.name for p in base.glob('*.json')) if base.exists() else []
        applied = sorted(p.name for p in (base / 'applied').glob('*.json')) if (base / 'applied').exists() else []
        modes = []
        for name in applied:
            modes.append(oct((base / 'applied' / name).stat().st_mode & 0o777))
        print(f"{kind}: 待消费={pending or '（空）'} 已归档={len(applied)} 条，归档权限={sorted(set(modes)) or '—'}")
    print(f"\n[汇总] contractor 类型分布：{json.dumps(c, ensure_ascii=False, sort_keys=True)}")
    print(f"[汇总] supplier   类型分布：{json.dumps(s, ensure_ascii=False, sort_keys=True)}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
