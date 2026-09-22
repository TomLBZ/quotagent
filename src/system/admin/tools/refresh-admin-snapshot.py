#!/usr/bin/env python3
"""把 admin 道的「agent 进度与阻塞」快照写到 `tmp/ui-shared/admin-blocks.json`（T-271 / FR-ADMIN-004）。

为什么这样分工：判定属于**事实层**（Python，ADR-0012）；宿主只做展示聚合（T-272 的 admin 道
`/quotagent/admin/api/blocks` 只读这个文件）。本工具**不写账本**（H1：宿主永不写账本；这个工具也
不写）、**不改任何输入文件**、不创建账本（找不到账本就不建 —— 这里连账本都不读）。

形状（键名即契约：判定器的输出 + 一个 `generated_at`；读取端见 `host/modules/admin-view.mjs`）::

    {"generated_at": "<ISO8601>",
     "blocks":        [{block_id, kind, reason, required_action, refs, state, source, task, redacted_fields}],
     "counts":        {blocked, pending, resolved, rejected, expired},
     "counts_source": "<口径来源：多少条记录、按什么计数、覆盖哪些可读源>",
     "progress":      {phase, next_task, done, todo, by_status, checklist_rows, source, sources,
                       blocks_bounded, records_rejected},
     "degraded": bool, "reason": str|null, "next_action": str|null}

`counts_source` 与 `progress.source` 不是装饰：宿主 `admin-view` 缺这两个键就判降级
（「没有口径就没有可信数字」），面板会显示降级而不是真数据。

判定逻辑**不在这里重写**：一律调 `services/admin_blocks.py` 的 `derive_blocks()`（单一实现）。

三个真源由参数给出（默认是仓库内的真路径；相对路径按**仓库根**解析，因此不依赖调用者的 cwd）：

    --state     默认 .agents/state.json（任务登记 + 阻塞 + 进度）
    --checklist 默认 docs/work/progress-checklist.md（任务行状态列）
    --pipeline  默认 tmp/ui-shared/pipeline.json（三域快照：服务自述不可用）

**缺源给全零形状**：源缺失/损坏时照样写出完整形状（计数 0 + `degraded=true` + `reason` + `next_action`），
面板据此降级显示 —— 不崩、不猜、也不把"读不到"写成"零阻塞"（`degraded` 与 `progress.sources` 两者可分）。

确定性：同一输入 + 同一个 `--now`，两次运行**逐字节一致**（键全排序、记录定序、不读墙钟除元数据）。
`--now` 不给时取当前 UTC（只有 `generated_at` 会因此变化）。

用法::

    python3 tools/refresh-admin-snapshot.py
    python3 tools/refresh-admin-snapshot.py --out tmp/scratch/admin.json --now 2026-09-21T00:00:00Z
    python3 tools/refresh-admin-snapshot.py --state /tmp/x/state.json --checklist /tmp/x/checklist.md \
        --pipeline /tmp/x/pipeline.json --out /tmp/x/admin.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/refresh-admin-snapshot.py` 只剩**薄转发**。
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.services.admin_blocks import AdminBlockError, derive_blocks  # noqa: E402

DEFAULT_STATE = ROOT / ".agents" / "state.json"
DEFAULT_CHECKLIST = ROOT / "docs" / "work" / "progress-checklist.md"
DEFAULT_PIPELINE = ROOT / "tmp" / "ui-shared" / "pipeline.json"
DEFAULT_OUT = ROOT / "tmp" / "ui-shared" / "admin-blocks.json"


def _resolve(value: str) -> Path:
    """绝对路径原样用；相对路径按**仓库根**解析（不依赖 cwd，参数即事实）。"""
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else (ROOT / path)


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(prog="refresh-admin-snapshot",
                                     description="把 admin 道的阻塞/进度快照写到 --out（默认 tmp/ui-shared/admin-blocks.json）")
    parser.add_argument("--state", default=str(DEFAULT_STATE), help="任务登记/阻塞真源（默认 .agents/state.json）")
    parser.add_argument("--checklist", default=str(DEFAULT_CHECKLIST),
                        help="进度清单真源（默认 docs/work/progress-checklist.md）")
    parser.add_argument("--pipeline", default=str(DEFAULT_PIPELINE),
                        help="三域快照真源（默认 tmp/ui-shared/pipeline.json）")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出文件（原子写：先 .tmp 再 replace）")
    parser.add_argument("--now", default=None, help="快照时点（ISO8601；不给取当前 UTC；给定即逐字节可复现）")
    parser.add_argument("--resolutions", default="",
                        help="admin 账本（JSONL）：读 admin/block-resolved 行作为**已解决事实**（不传 = 与旧行为逐字节一致）")
    args = parser.parse_args(argv)

    state, checklist, pipeline = _resolve(args.state), _resolve(args.checklist), _resolve(args.pipeline)
    target = _resolve(args.out)
    now = args.now or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    try:
        resolutions = Path(args.resolutions) if args.resolutions else None
        derived = derive_blocks(state, checklist, pipeline, now, resolutions_path=resolutions)
    except AdminBlockError as exc:                      # 用法错误：拒绝，不产出半个快照
        print(json.dumps({"ok": False, "error": f"判定器拒绝输入：{exc}"}, ensure_ascii=False, sort_keys=True))
        return 2

    payload = {"generated_at": now, **derived}
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1)

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")               # 原子写：先 .tmp 再 replace（不留半截文件）
    tmp.write_text(blob, encoding="utf-8")
    tmp.replace(target)

    progress = payload["progress"]
    summary = {"ok": True, "out": _display(target), "bytes": len(blob.encode("utf-8")),
               "generated_at": now, "blocks": len(payload["blocks"]), "counts": payload["counts"],
               "degraded": payload["degraded"], "reason": payload["reason"],
               "phase": progress["phase"], "next_task": progress["next_task"],
               "done": progress["done"], "todo": progress["todo"],
               "sources": {name: body["status"] for name, body in progress["sources"].items()}}
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
