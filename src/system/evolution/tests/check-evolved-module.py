"""check-evolved-module —— 审计"自进化产出的插件"（`tools/verify.sh evolve-module`）。

为什么需要它：自进化能写 `host/modules/`，所以必须有一条**可机检的追溯链**：
仓库里被追踪的产出日志（`docs/work/evolution-log.json`）→ 每条记录的 `artifact_hash`
必须与**当前进树实体**的 sha256 一致。文件被偷改 = 门红。

**路径从日志读（本批 `EV-177`）**：产物实体已按迁移计划搬进归属插件的
`src/<层>/<插件>/code/<name>.mjs`，旧路径 `host/modules/<name>.mjs` 只剩**薄重导**
（`export * from '../lib/entity-<name>.mjs'`）。所以每条记录的 `artifact_path` 就是**唯一真源**；
缺该字段时回落到旧路径 `host/modules/<name>.mjs`（新晋升的产物仍写在那里 ⇒ 新记录照样可校验）。
「产物在树」这一条同时断言**旧路径只是薄重导**（不再含实体字节），否则「日志改了路径、实体没搬」
或「搬完又把实体放回旧路径」都会被漏掉 —— 断言条数不变（每条记录仍 5 条），断言只是更严。

它读什么：产出日志 + 日志指到的真实字节。
它不写什么：**不写账本、不改仓库**（账本由 Python 侧写，H1；本脚本只读、只报告）。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
LOG = ROOT / "docs" / "work" / "evolution-log.json"
MODULES = ROOT / "host" / "modules"
#: 薄重导的判据（与 `tools/check-plugin-assets.py` 的 FORWARDER_MARK 同一套语义）。
THIN_MARK = "薄重导"


def resolve_artifact(item: dict) -> Path:
    """日志里的路径优先；缺字段回落到旧路径（`host/modules/<name>.mjs`）。"""
    recorded_path = item.get("artifact_path")
    if recorded_path:
        return ROOT / str(recorded_path)
    return MODULES / f"{item.get('name', '?')}.mjs"


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
        path = resolve_artifact(item)
        if not path.exists():
            check(f"{name} · 产物在树", False, f"{path.relative_to(ROOT)} 不存在（产出被删？）")
            continue
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        # 记录里可能带 `sha256:` 前缀（取决于产出路径），统一归一化后比较——让校验器容忍两种写法，
        # 而不是反过来要求数据迁就工具。
        recorded = str(item.get("artifact_hash", "")).removeprefix("sha256:")
        legacy = MODULES / f"{name}.mjs"
        legacy_text = legacy.read_text(encoding="utf-8", errors="replace") if legacy.is_file() else ""
        legacy_is_thin = (THIN_MARK in legacy_text and "export * from" in legacy_text
                          and digests_differ(legacy, path))
        check(f"{name} · 产物在树", legacy_is_thin,
              f"{path.relative_to(ROOT)}；旧路径 host/modules/{name}.mjs 是薄重导={legacy_is_thin}")
        check(f"{name} · 哈希与产出记录一致（未被偷改）", digest == recorded,
              f"记录 {recorded[:12]}… vs 当前 {digest[:12]}…")
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


def digests_differ(a: Path, b: Path) -> bool:
    """旧路径与实体必须是两份不同的字节（挡住"把实体又抄回旧路径"）。"""
    return hashlib.sha256(a.read_bytes()).hexdigest() != hashlib.sha256(b.read_bytes()).hexdigest()


if __name__ == "__main__":
    sys.exit(main())
