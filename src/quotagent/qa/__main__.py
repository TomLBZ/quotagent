"""CLI 骨架（T-101）：

    python -m quotagent.qa ac AC-AUDIT-001 [--evidence EV-005]
    python -m quotagent.qa suite s1
    python -m quotagent.qa list
    python -m quotagent.qa selftest

契约（`docs/work/acceptance-criteria.md` §0）：`ac` 在 stdout 打印 JSON
`{ac, status, assertions[], evidence_refs[]}`；退出码 0=通过、1=断言失败、2=未知入口/配置错误。
人工可读的摘要走 stderr，stdout 只放 JSON（便于机器消费）。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from .. import PROFILE, QEP_VERSION, __version__
from ..paths import evidence_dir, repo_root
from .registry import EXIT_CONFIG, EXIT_FAIL, EXIT_PASS, ACReport, list_acs, run_ac

PROG = "python -m quotagent.qa"
SUITES = {"s1": "T-114", "s2": "T-209", "s3": "T-209", "s4": "T-209"}


def _git_commit() -> str:
    try:
        proc = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(repo_root()),
                              capture_output=True, text=True, timeout=10)
        return (proc.stdout or "").strip() or "unknown"
    except Exception:
        return "unknown"


def _print_json(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False))


def _human(report: ACReport) -> str:
    lines = [f"[{report.status.upper()}] {report.ac} — {report.title}"]
    for item in report.assertions:
        mark = "ok  " if item.ok else "FAIL"
        lines.append(f"  {mark} {item.name}" + (f" — {item.detail}" if (item.detail and not item.ok) else ""))
    if report.status != "pass":
        lines.append(f"  首个失败: {report.first_failure()}")
    return "\n".join(lines)


def _write_evidence(report: ACReport, evidence_id: str) -> Path:
    path = evidence_dir() / f"{evidence_id}-{report.ac}.txt"
    header = [
        f"{evidence_id} — {report.ac}: {report.title}",
        "",
        f"时间: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        f"命令: {report.command}",
        f"实际调用: {sys.executable} -m quotagent.qa ac {report.ac}",
        f"commit: {_git_commit()}",
        f"退出码: {report.exit_code()}",
        "运行环境: quotagent %s · profile=%s · qep_version=%s · python=%s"
        % (__version__, PROFILE, QEP_VERSION, sys.version.split()[0]),
        "",
        "--- 原始输出（stdout JSON） ---",
        json.dumps(report.as_dict(), ensure_ascii=False, indent=2),
        "",
        "--- 断言摘要（stderr 内容） ---",
        _human(report),
        "",
    ]
    existed = path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        if existed:
            fh.write(f"--- 追加运行 {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ---\n")
        fh.write("\n".join(header))
    return path


def _cmd_ac(args: argparse.Namespace) -> int:
    report = run_ac(args.ac_id)
    if args.evidence:
        report.evidence_refs = sorted(set(report.evidence_refs) | {args.evidence})
        written = _write_evidence(report, args.evidence)
        print(f"[evidence] {written}", file=sys.stderr)
    if args.out:
        Path(args.out).write_text(json.dumps(report.as_dict(), ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8")
    _print_json(report.as_dict())
    print(_human(report), file=sys.stderr)
    return report.exit_code()


def _cmd_suite(args: argparse.Namespace) -> int:
    name = args.name
    task = SUITES.get(name)
    if task is None:
        print(f"未知场景集: {name}（已知: {', '.join(sorted(SUITES))}）", file=sys.stderr)
        _print_json({"suite": name, "status": "unknown", "assertions": [], "evidence_refs": [],
                     "message": f"未知场景集 {name}"})
        return EXIT_CONFIG
    message = (f"场景集 {name} 尚未实现：对应 roadmap 任务 {task}；"
               f"P0 先以 AC 级断言取证（docs/work/roadmap.md §2 S0.13）")
    print(message, file=sys.stderr)
    _print_json({"suite": name, "status": "not-implemented", "assertions": [], "evidence_refs": [],
                 "message": message, "roadmap_task": task})
    return EXIT_CONFIG


def _cmd_list(args: argparse.Namespace) -> int:
    acs = list_acs()
    _print_json({"count": len(acs), "acs": acs})
    return EXIT_PASS


def _cmd_selftest(args: argparse.Namespace) -> int:
    from ..paths import scratch_root
    from .checks_runtime import _third_party_imports
    from .registry import REGISTRY

    third_party = _third_party_imports()
    checks = [
        {"name": "Python >= 3.9", "ok": sys.version_info[:2] >= (3, 9), "detail": sys.version.split()[0]},
        {"name": "仓库根可解析", "ok": (repo_root() / "tools" / "verify.sh").is_file(), "detail": str(repo_root())},
        {"name": "临时目录可写（仓库内优先）", "ok": scratch_root().is_dir(), "detail": str(scratch_root())},
        {"name": "AC 注册表非空", "ok": len(REGISTRY) > 0, "detail": f"{len(REGISTRY)} 条"},
        {"name": "仅标准库依赖", "ok": not third_party, "detail": "; ".join(third_party[:3])},
    ]
    ok = all(c["ok"] for c in checks)
    _print_json({"status": "pass" if ok else "fail", "checks": checks,
                 "assertions": checks, "evidence_refs": [], "profile": PROFILE,
                 "version": __version__})
    print(f"[{'PASS' if ok else 'FAIL'}] quotagent runtime selftest ({PROFILE})", file=sys.stderr)
    return EXIT_PASS if ok else EXIT_FAIL


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=PROG, description="quotagent QA 运行器：AC 是可执行断言")
    parser.add_argument("--version", action="version", version=f"quotagent {__version__} ({PROFILE})")
    sub = parser.add_subparsers(dest="cmd")
    p_ac = sub.add_parser("ac", help="执行单条 AC")
    p_ac.add_argument("ac_id")
    p_ac.add_argument("--evidence", metavar="EV-NNN", default=None, help="把原始输出写入 docs/work/evidence/EV-NNN-<AC>.txt")
    p_ac.add_argument("--out", metavar="PATH", default=None, help="把 JSON 报告另存到文件")
    p_ac.set_defaults(func=_cmd_ac)
    p_suite = sub.add_parser("suite", help="执行场景集")
    p_suite.add_argument("name")
    p_suite.set_defaults(func=_cmd_suite)
    p_list = sub.add_parser("list", help="列出已注册的 AC")
    p_list.set_defaults(func=_cmd_list)
    p_self = sub.add_parser("selftest", help="运行时自检")
    p_self.set_defaults(func=_cmd_selftest)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if not getattr(args, "func", None):
        parser.print_help(sys.stderr)
        return EXIT_CONFIG
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
