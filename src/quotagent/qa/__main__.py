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
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .. import PROFILE, QEP_VERSION, __version__
from ..paths import evidence_dir, repo_root
from .registry import EXIT_CONFIG, EXIT_FAIL, EXIT_PASS, ACReport, list_acs, run_ac

PROG = "python -m quotagent.qa"
SUITES = {"s1": "T-114", "s2": "T-114", "s3": "T-114", "s4": "T-114"}
SUITE_ALIASES = {"all": ["s1", "s2", "s3", "s4"], "s1..s4": ["s1", "s2", "s3", "s4"]}


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


def _suite_names(name: str) -> list[str]:
    if name in SUITE_ALIASES:
        return list(SUITE_ALIASES[name])
    if ".." in name:
        start, end = name.split("..", 1)
        names = [f"s{index}" for index in range(int(start.lstrip("s")), int(end.lstrip("s")) + 1)]
        return names
    return [name]


def _cmd_suite(args: argparse.Namespace) -> int:
    from ..paths import scratch_root
    from ..services.scenarios import SCENARIOS, run as run_scenario

    names = _suite_names(args.name)
    unknown = [name for name in names if name not in SCENARIOS]
    if unknown:
        print(f"未知场景集: {', '.join(unknown)}（已知: {', '.join(sorted(SCENARIOS))}）", file=sys.stderr)
        _print_json({"suite": args.name, "status": "unknown", "assertions": [], "evidence_refs": [],
                     "message": f"未知场景集 {unknown}"})
        return EXIT_CONFIG

    root = scratch_root() / "scenarios"
    results = {}
    for name in names:
        # 每次运行用干净目录：账本对同 (correlation_id, type, body) 去重（幂等），
        # 复用旧账本会让"重放"变成"重复投递"（零新增事件）——所以场景必须在新账本上跑
        run_dir = scratch_root() / "scenarios" / f"{name}-{os.getpid()}-{time.time_ns()}"
        try:
            results[name] = run_scenario(name, run_dir)
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)
    for name, result in results.items():
        for item in result["assertions"]:
            print(f"[{'ok  ' if item['ok'] else 'FAIL'}] {name}: {item['name']}", file=sys.stderr)
    if len(names) == 1:
        payload = dict(results[names[0]])
        payload["evidence_refs"] = []
        _print_json(payload)
        return EXIT_PASS if payload["status"] == "pass" else EXIT_FAIL
    status = "pass" if all(result["status"] == "pass" for result in results.values()) else "fail"
    payload = {"suite": args.name, "status": status,
               "suites": {name: {"status": result["status"], "digest": result["digest"],
                                 "assertions": result["assertions"],
                                 "facts": result["facts"]} for name, result in results.items()},
               "assertions": [item for result in results.values() for item in result["assertions"]],
               "evidence_refs": []}
    _print_json(payload)
    return EXIT_PASS if status == "pass" else EXIT_FAIL


def _cmd_metrics(args: argparse.Namespace) -> int:
    """采集 S1..S4 的指标并生成一份人可读的基线报告（FR-EVAL-003，roadmap S0.14）。"""
    from ..kernel.ledger import Ledger
    from ..paths import scratch_root
    from ..services.evaldata import load_counterexamples
    from ..services.evalmetrics import baseline_report, collect_metrics
    from ..services.scenarios import run as run_scenario

    names = ["s1", "s2", "s3", "s4"]
    sections, summary, digests = [], {}, {}
    for name in names:
        run_dir = scratch_root() / "metrics" / f"{name}-{os.getpid()}-{time.time_ns()}"
        try:
            result = run_scenario(name, run_dir)
            ledger = Ledger(run_dir / "ledger.jsonl", realm="contractor:con-B")
            data = collect_metrics(ledger)
            report_path = baseline_report(ledger, out_path=run_dir / "report.md")
            sections.append((name, result, report_path.read_text(encoding="utf-8")))
            summary[name] = {key: row["value"] for key, row in data["metrics"].items()}
            digests[name] = result["digest"]
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)

    from ..services.evalmetrics import METRIC_KEYS
    lines = [
        "# 指标基线报告（P0，S1..S4 合成场景）",
        "",
        "<!-- 生成方式：tools/run.sh -m quotagent.qa metrics --out docs/work/metrics-baseline.md -->",
        "",
        "**P0 只采集与记录基线，不设目标值**；目标值由人在 P1 开始前设定并写入项目 patch（roadmap G1 门）。",
        "全部数值来自各场景账本（`ctx.eval.collect`），场景数据为合成数据。",
        "",
        "## 场景摘要",
        "",
        "| 场景 | 状态 | 内容摘要（digest） |",
        "|---|---|---|",
    ]
    from ..services.scenarios import SCENARIOS
    titles = {"s1": "材料采购：单币种含税、60 条目、4 家投标",
              "s2": "分包工程：多包 + 接口责任交叉 + 偏差入 TCO",
              "s3": "设备采购：长交期 + 复杂付款 + 外币",
              "s4": "恶意输入：注入 / 漏项 / 虚假产能 / 伪造批准"}
    for name in names:
        lines.append(f"| {name} | {summary[name] and 'pass'} | {titles[name]} · digest `{digests[name]}` |")
    lines += ["", "## 指标汇总", "", "| 指标 | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for key in METRIC_KEYS:
        cells = []
        for name in names:
            value = summary[name][key]
            if isinstance(value, dict):
                cells.append("/".join(f"{k}={v if v is None else round(v, 4) if isinstance(v, float) else v}"
                                      for k, v in value.items()))
            elif isinstance(value, float):
                cells.append(f"{value:.4f}")
            else:
                cells.append("None" if value is None else str(value))
        lines.append(f"| {key} | " + " | ".join(cells) + " |")
    lines += ["", "## 反例集（red-team，只增不减）", ""]
    for case in load_counterexamples():
        lines.append(f"- `{case['case_id']}`（{case['scenario']}）：{case['note']}")
    for name, result, text in sections:
        lines += ["", "---", "", f"## {name} · " + titles[name], "",
                  f"- 状态: {result['status']} · digest: `{result['digest']}`", ""]
        body = text.split("## 指标", 1)[1] if "## 指标" in text else text
        lines += ["## 指标" + body.rstrip(), ""]
    report = "\n".join(lines) + "\n"
    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
    _print_json({"suites": {name: {"status": "pass" if summary[name] else "fail", "digest": digests[name]}
                            for name in names},
                 "out": args.out, "bytes": len(report.encode("utf-8")),
                 "metrics": {name: {k: (v if not isinstance(v, float) else round(v, 6))
                                    for k, v in summary[name].items()} for name in names}})
    return EXIT_PASS


def _cmd_list(args: argparse.Namespace) -> int:
    acs = list_acs()
    _print_json({"count": len(acs), "acs": acs})
    return EXIT_PASS


def _cmd_selftest(args: argparse.Namespace) -> int:
    from ..paths import scratch_root
    # `checks_runtime` 已按迁移阶段 4.1 变成**薄转发**：实体在 `src/system/runtime/tests/checks_runtime.py`，
    # 由薄转发按文件路径装载成模块对象 `_M`，**不再**把名字导进本模块的命名空间。
    # 因此这里只能经 `_M` 取那个函数（`from .checks_runtime import _third_party_imports` 是 T-323 搬迁后的
    # 残留引用：薄转发不转发符号 ⇒ 一跑就 ImportError）。判据不变，仍真跑同一份实现。
    from . import checks_runtime as _checks_runtime
    from .registry import REGISTRY

    third_party = _checks_runtime._M._third_party_imports()
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
    p_all = sub.add_parser("all", help="执行全部已注册 AC（阶段门用）")
    p_all.set_defaults(func=_run_all)
    p_list = sub.add_parser("list", help="列出已注册的 AC")
    p_list.set_defaults(func=_cmd_list)
    p_metrics = sub.add_parser("metrics", help="采集 S1..S4 指标并生成基线报告")
    p_metrics.add_argument("--out", default=None, help="基线报告输出路径（Markdown）")
    p_metrics.set_defaults(func=_cmd_metrics)
    p_self = sub.add_parser("selftest", help="运行时自检")
    p_self.set_defaults(func=_cmd_selftest)
    return parser


def _run_all(args) -> int:
    """执行全部已注册 AC，逐条打印，任一失败即非零退出（供 `verify.sh g1` 之类的阶段门）。"""
    from .registry import list_acs, run_ac
    from . import REGISTRY  # noqa: F401  （导入即注册）

    total = 0
    failed: list[str] = []
    for item in list_acs():
        total += 1
        report = run_ac(item["ac"])
        ok = all(assertion.ok for assertion in report.assertions)
        print(f"[{'ok' if ok else 'FAIL'}] {item['ac']} — {item['title'][:60]}"
              f"（{sum(1 for a in report.assertions if a.ok)}/{len(report.assertions)} 断言）")
        if not ok:
            failed.append(item["ac"])
    print("-" * 72)
    print(f"全量 AC：{total - len(failed)}/{total} 通过" + (f"；失败 {failed}" if failed else ""))
    return 0 if not failed else 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if not getattr(args, "func", None):
        parser.print_help(sys.stderr)
        return EXIT_CONFIG
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
