"""check-evolved-module —— 审计"自进化产出的插件"（`tools/verify.sh evolve-module`）。

为什么需要它：自进化能写 `host/modules/`，所以必须有一条**可机检的追溯链**：
仓库里被追踪的产出日志（`docs/work/evolution-log.json`）→ 每条记录的 `artifact_hash`
必须与**当前进树文件**的 sha256 一致。文件被偷改 = 门红。

它读什么：产出日志 + `host/modules/*.mjs` 的真实字节。
它不写什么：**不写账本、不改仓库**（账本由 Python 侧写，H1；本脚本只读、只报告）。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "docs" / "work" / "evolution-log.json"
MODULES = ROOT / "host" / "modules"


def main() -> int:
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    if not LOG.exists():
        print(json.dumps({"checks": [{"name": "产出日志存在", "ok": False,
              "detail": f"{LOG.relative_to(ROOT)} 不存在：自进化产出必须留可追踪的记录"}],
              "passed": 0, "total": 1}, ensure_ascii=False, indent=2))
        return 1

    entries = json.loads(LOG.read_text(encoding="utf-8"))
    entries = entries.get("entries", entries) if isinstance(entries, dict) else entries
    check("产出日志可解析且非空", isinstance(entries, list) and len(entries) > 0, f"记录 {len(entries)} 条")

    for item in entries:
        name = item.get("name", "?")
        path = MODULES / f"{name}.mjs"
        if not path.exists():
            check(f"{name} · 产物在树", False, f"{path.relative_to(ROOT)} 不存在（产出被删？）")
            continue
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        check(f"{name} · 产物在树", True, str(path.relative_to(ROOT)))
        check(f"{name} · 哈希与产出记录一致（未被偷改）", digest == item.get("artifact_hash"),
              f"记录 {item.get('artifact_hash', '')[:12]}… vs 当前 {digest[:12]}…")
        check(f"{name} · 字节数与记录一致", len(raw) == item.get("bytes"),
              f"记录 {item.get('bytes')} vs 当前 {len(raw)}")
        check(f"{name} · 晋升前有门通过记录 + 人工引用", item.get("gate") == "passed"
              and bool(item.get("approval_ref")), f"gate={item.get('gate')} approval_ref={item.get('approval_ref')}")
        check(f"{name} · fixture 全绿且样本数达标（≥12）", (item.get("fixture", {}) or {}).get("passed", 0) >= 12
              and (item.get("fixture", {}) or {}).get("passed") == (item.get("fixture", {}) or {}).get("total"),
              f"fixture={item.get('fixture')}")

    failed = [item for item in checks if not item["ok"]]
    print(json.dumps({"checks": checks, "passed": len(checks) - len(failed), "total": len(checks),
                      "failures": len(failed)}, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
