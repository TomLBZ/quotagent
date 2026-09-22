#!/usr/bin/env python3
"""check-evolution-log-path —— **可复跑的追链校验**：`docs/work/evolution-log.json` 里**每条记录**的
`sha256` 与**当前实体**逐字节相等（`artifact_path` 指到哪，就读哪；缺字段回落到 `host/modules/<name>.mjs`）。

与门 `tools/verify.sh evolve-module`（`check-evolved-module.py`）的分工：门是 CI 形态（含"晋升前有门通过记录 /
fixture 全绿 / 旧路径只是薄重导"这类形状断言）；**本脚本只做一件事** —— 逐条字节相等，输出可直接贴进证据的
原始行。搬迁（本批 `EV-177`）把 12 个产物搬进 `src/<层>/<插件>/code/` 并同步了日志的 `artifact_path` 与
`artifact_hash`；这个脚本就是"日志与实体没走散"的那条可复跑判据。

用法：`python3 src/system/evolution/tests/check-evolution-log-path.py [--root DIR]`
退出码：0 = 每条都逐字节相等；1 = 有不一致（逐行指出是哪条、差在哪）；2 = 环境/用法错误。
反向验证（本批证据里的"必红"行）：把任取一份 `artifact_path` 指向的文件**改一个字节**再跑本脚本 ⇒ 必 rc=1。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[4]
LOG_REL = "docs/work/evolution-log.json"


def artifact_path(root: Path, item: dict) -> Path:
    recorded = item.get("artifact_path")
    if recorded:
        return root / str(recorded)
    return root / "host" / "modules" / f"{item.get('name', '?')}.mjs"


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    args = parser.parse_args()
    root = Path(args.root).resolve()

    log = root / LOG_REL
    if not log.is_file():
        print(f"追链校验：{LOG_REL} 不存在（root={root}）", file=sys.stderr)
        return 2
    payload = json.loads(log.read_text(encoding="utf-8"))
    entries = payload.get("entries", payload) if isinstance(payload, dict) else payload
    if not isinstance(entries, list) or not entries:
        print("追链校验：日志为空 —— 空集合不得判绿", file=sys.stderr)
        return 2

    failures = 0
    for item in entries:
        name = item.get("name", "?")
        path = artifact_path(root, item)
        if not path.is_file():
            failures += 1
            print(json.dumps({"name": name, "ok": False, "reason": "artifact-missing",
                              "path": str(path.relative_to(root))}, ensure_ascii=False))
            continue
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        recorded = str(item.get("artifact_hash", "")).removeprefix("sha256:")
        ok = digest == recorded and len(raw) == item.get("bytes")
        if not ok:
            failures += 1
        print(json.dumps({"name": name, "ok": ok, "path": str(path.relative_to(root)),
                          "bytes": len(raw), "bytes_recorded": item.get("bytes"),
                          "sha256": digest, "sha256_recorded": recorded,
                          "sha256_equal": digest == recorded,
                          "bytes_equal": len(raw) == item.get("bytes")}, ensure_ascii=False))
    print(json.dumps({"TOTAL": len(entries), "FAIL": failures}, ensure_ascii=False))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
