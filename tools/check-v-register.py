#!/usr/bin/env python3
"""校验 V-001..V-012 的登记表（`tools/verify.sh v`）。

只读、仅标准库。检查的是**登记是否合法**（结构、签字、证据在位），不是结论对错——
结论对不对由人负责。

退出码：0 全绿；1 有失败项；2 配置/文件缺失（登记表或执行包不存在）。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATION_DIR = ROOT / "docs" / "work" / "validation"
REGISTER = VALIDATION_DIR / "register.json"
IDS = [f"V-{index:03d}" for index in range(1, 13)]
STATUSES = ("open", "pass", "fail", "partial")
REQUIRED_KEYS = ("id", "hypothesis", "verification", "criterion", "impact", "owner_role",
                 "prepared", "status", "results", "conclusion", "decided_by", "decided_at", "evidence")
SECTIONS = ("## 需要谁", "## 怎么做", "## 产出与例子", "## 放回哪里")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures: list[str] = []

    def ok(self, text: str) -> None:
        self.lines.append(f"[ok]   {text}")

    def fail(self, text: str, details: list[str] | None = None) -> None:
        self.failures.append(text)
        self.lines.append(f"[FAIL] {text}")
        for detail in details or []:
            self.lines.append(f"       - {detail}")


def main() -> int:
    extra = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if extra:
        print(f"用法: tools/check-v-register.py（不接受参数，收到 {extra}）", file=sys.stderr)
        return 2
    report = Report()
    if not REGISTER.exists():
        print(f"[FAIL] 找不到登记表 {REGISTER.relative_to(ROOT)}")
        print("RESULT: FAIL (1 项)")
        return 2
    data = json.loads(REGISTER.read_text(encoding="utf-8"))
    checks = {entry.get("id"): entry for entry in data.get("checks", [])}

    missing = [vid for vid in IDS if vid not in checks]
    report.ok(f"12 条 V 齐全（{len(checks)} 条）") if not missing else \
        report.fail(f"{len(missing)} 条 V 未登记", missing)

    structural, unprepared, unclosed, illegal = [], [], [], []
    for vid in IDS:
        entry = checks.get(vid)
        if entry is None:
            continue
        absent = [key for key in REQUIRED_KEYS if key not in entry]
        if absent:
            structural.append(f"{vid}: 缺字段 {absent}")
            continue
        if entry["prepared"] is not True:
            unprepared.append(f"{vid}: prepared={entry['prepared']!r}（agent 备料未完成）")
        status = entry["status"]
        if status not in STATUSES:
            illegal.append(f"{vid}: status={status!r} 不在 {STATUSES}")
            continue
        if status == "open":
            if entry["conclusion"] or entry["decided_by"] or entry["decided_at"] or entry["evidence"]:
                unclosed.append(f"{vid}: status=open 但已有结论/签字/证据（要么补 status，要么清空）")
        else:
            problems = []
            if not str(entry["conclusion"] or "").strip():
                problems.append("缺 conclusion")
            if not str(entry["decided_by"] or "").startswith("human:"):
                problems.append(f"decided_by 必须是 human:*（现为 {entry['decided_by']!r}）")
            if not DATE_RE.match(str(entry["decided_at"] or "")):
                problems.append("decided_at 需为 YYYY-MM-DD")
            if not entry["results"]:
                problems.append("缺 results")
            if not entry["evidence"]:
                problems.append("缺 evidence")
            for path in entry["evidence"] or []:
                if not (ROOT / path).exists():
                    problems.append(f"证据文件不存在: {path}")
                elif not re.match(r"docs/work/evidence/EV-\d+", path):
                    problems.append(f"证据命名不符约定（应为 docs/work/evidence/EV-<数字>-...）: {path}")
            if problems:
                unclosed.append(f"{vid}: " + "；".join(problems))
    report.ok("登记结构完整（字段齐全、状态合法）") if not (structural or illegal) else \
        report.fail("登记结构有问题", structural + illegal)
    report.ok("备料完成（prepared=true）") if not unprepared else report.fail("备料未完成", unprepared)
    report.ok("已填结论的条目都有签字与证据；未填的保持 open") if not unclosed else \
        report.fail("结论与签字/证据不一致", unclosed)

    missing_files = []
    for vid in IDS:
        path = VALIDATION_DIR / f"{vid}.md"
        if not path.exists():
            missing_files.append(f"{vid}.md 不存在")
            continue
        text = path.read_text(encoding="utf-8")
        absent = [section for section in SECTIONS if section not in text]
        if absent:
            missing_files.append(f"{vid}.md 缺小节 {absent}")
    report.ok("12 份执行包存在且含必需小节（需要谁/怎么做/产出与例子/放回哪里）") if not missing_files else \
        report.fail("执行包不完整", missing_files)

    printed = "== V 登记表校验（T-117 / S0.15） =="
    print(printed)
    print(f"登记表: {REGISTER.relative_to(ROOT)}")
    print("\n".join(report.lines))
    decided = sum(1 for vid in IDS if checks.get(vid, {}).get("status") != "open")
    print(f"结论进度: {decided}/12（open 表示待人工；agent 不得代填）")
    print(f"RESULT: {'PASS' if not report.failures else 'FAIL (' + str(len(report.failures)) + ' 项)'}")
    return 0 if not report.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
