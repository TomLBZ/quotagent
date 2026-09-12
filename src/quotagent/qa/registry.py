"""AC 注册表与报告结构：AC 是可执行断言，不是人工检查（`docs/work/acceptance-criteria.md` §0）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_CONFIG = 2  # 未知 AC / 未实现的入口 / 配置错误


@dataclass
class Assertion:
    name: str
    ok: bool
    detail: str = ""

    def as_dict(self) -> dict:
        return {"name": self.name, "ok": bool(self.ok), "detail": self.detail}


@dataclass
class ACCheck:
    ac: str
    phase: str
    title: str
    command: str
    fn: Callable[[], list[Assertion]]
    evidence_refs: list[str] = field(default_factory=list)
    module: str = ""

    def as_dict(self) -> dict:
        return {"ac": self.ac, "phase": self.phase, "title": self.title, "command": self.command,
                "evidence_refs": list(self.evidence_refs), "module": self.module}


@dataclass
class ACReport:
    ac: str
    status: str  # pass | fail | unknown | error | not-implemented
    assertions: list[Assertion] = field(default_factory=list)
    evidence_refs: list[str] = field(default_factory=list)
    command: str = ""
    phase: str = ""
    title: str = ""
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "pass"

    def exit_code(self) -> int:
        if self.status == "pass":
            return EXIT_PASS
        if self.status == "fail":
            return EXIT_FAIL
        return EXIT_CONFIG

    def first_failure(self) -> str:
        for item in self.assertions:
            if not item.ok:
                return f"{item.name}: {item.detail}" if item.detail else item.name
        return self.message

    def as_dict(self) -> dict:
        return {
            "ac": self.ac,
            "status": self.status,
            "assertions": [a.as_dict() for a in self.assertions],
            "evidence_refs": list(self.evidence_refs),
            "command": self.command,
            "phase": self.phase,
            "title": self.title,
            "first_failure": self.first_failure(),
            "exit_code": self.exit_code(),
        }


REGISTRY: dict[str, ACCheck] = {}


def register(ac: str, phase: str, title: str, command: str,
             evidence_refs: tuple[str, ...] = ()) -> Callable[[Callable[[], list[Assertion]]], Callable[[], list[Assertion]]]:
    def decorator(fn: Callable[[], list[Assertion]]) -> Callable[[], list[Assertion]]:
        if ac in REGISTRY:
            raise RuntimeError(f"AC 重复注册: {ac}")
        REGISTRY[ac] = ACCheck(ac=ac, phase=phase, title=title, command=command,
                               fn=fn, evidence_refs=list(evidence_refs),
                               module=getattr(fn, "__module__", ""))
        return fn

    return decorator


def run_check(check: ACCheck) -> ACReport:
    from ..paths import cleanup_scratch

    report = ACReport(ac=check.ac, status="fail", evidence_refs=list(check.evidence_refs),
                      command=check.command, phase=check.phase, title=check.title)
    try:
        assertions = list(check.fn())
    except Exception as exc:  # 断言层之外的一切异常都是一次真实失败，必须带原始差异
        report.status = "error"
        report.assertions = [Assertion(name="执行异常", ok=False,
                                       detail=f"{type(exc).__name__}: {exc}")]
        return report
    finally:
        # AC 自清理：一次性目录用完即删（否则会改变文档门的扫描范围）
        cleanup_scratch()
    if not assertions:
        report.assertions = [Assertion(name="至少一条断言", ok=False, detail="该 AC 未产出任何断言")]
        return report
    report.assertions = assertions
    report.status = "pass" if all(a.ok for a in assertions) else "fail"
    return report


def run_ac(ac: str) -> ACReport:
    check = REGISTRY.get(ac)
    if check is None:
        known = ", ".join(sorted(REGISTRY)[:8])
        return ACReport(ac=ac, status="unknown", command=f"qa ac {ac}",
                        message=f"未注册的 AC: {ac}（已注册: {known}...）")
    return run_check(check)


def list_acs() -> list[dict]:
    return [REGISTRY[key].as_dict() for key in sorted(REGISTRY)]
