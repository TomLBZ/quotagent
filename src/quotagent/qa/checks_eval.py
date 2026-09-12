"""评测 AC（T-114/T-115）：AC-EVAL-001（确定性重放 + S1..S4 全绿）、
AC-EVAL-002（指标基线报告可生成且人可读；反例集只增不减）。"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from ..kernel.ledger import Ledger
from ..paths import new_scratch, repo_root
from ..services.evaldata import CounterexampleImmutable, CounterexampleRegistry, load_counterexamples
from ..services.evalmetrics import METRIC_KEYS, baseline_report, collect_metrics
from ..services.scenarios import run_s1, run_s2, run_s3, run_s4
from .registry import Assertion, register

SCENARIOS = {"s1": run_s1, "s2": run_s2, "s3": run_s3, "s4": run_s4}
VOLATILE_KEYS = ("duration_ms",)


def _digest(run: dict) -> str:
    return run["digest"]


@register("AC-EVAL-001", "P0/P1", "同输入重放两次结果完全一致（确定性）；S1..S4 全绿",
          command="qa suite s1..s4")
def check_eval_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-eval-001")

    results = {}
    for name, runner in SCENARIOS.items():
        first = runner(root / f"{name}-a")
        second = runner(root / f"{name}-b")
        results[name] = (first, second)
    out.append(Assertion("S1..S4 全部通过（各自断言全绿）",
                         all(first["status"] == "pass" for first, _ in results.values()),
                         f"status={ {n: f['status'] for n, (f, _) in results.items()} } "
                         f"failures={ {n: [a['name'] for a in f['assertions'] if not a['ok']] for n, (f, _) in results.items() if f['status'] != 'pass'} }"))
    out.append(Assertion("同输入重放两次的摘要完全一致（确定性）",
                         all(_digest(first) == _digest(second) for first, second in results.values()),
                         f"digests={ {n: (f['digest'][:12], s['digest'][:12]) for n, (f, s) in results.items()} }"))
    out.append(Assertion("两次运行的完整结果只差声明的易变字段（其余字节一致）",
                         all(_stable(first) == _stable(second) for first, second in results.values()),
                         f"volatile={VOLATILE_KEYS}"))
    out.append(Assertion("S1 一条命令跑完 询价→澄清→2 报价→比价（步骤齐全且有序）",
                         [step["step"] for step in results["s1"][0]["steps"]] ==
                         ["rfq_published", "clarification_asked", "clarification_answered",
                          "quotes_received", "normalized", "guarded", "ranked"]
                         and len(results["s1"][0]["facts"]["ranking"]) >= 2,
                         f"steps={[s['step'] for s in results['s1'][0]['steps']]} "
                         f"ranking={results['s1'][0]['facts']['ranking']}"))
    out.append(Assertion("S1 规模符合场景定义（单币种含税、条目 50~200、3~5 家投标）",
                         50 <= results["s1"][0]["facts"]["item_count"] <= 200
                         and 3 <= results["s1"][0]["facts"]["bidder_count"] <= 5,
                         f"items={results['s1'][0]['facts']['item_count']} "
                         f"bidders={results['s1'][0]['facts']['bidder_count']}"))

    cli = subprocess.run([sys.executable, "-m", "quotagent.qa", "suite", "s1..s4"],
                         cwd=str(repo_root()), capture_output=True, text=True, timeout=600,
                         env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": str(repo_root() / "src"),
                              "HOME": str(root)})
    payload = {}
    try:
        payload = json.loads(cli.stdout)
    except Exception:
        payload = {}
    out.append(Assertion("CLI 入口 `qa suite s1..s4` 可执行且退出码 0（roadmap S0.13 的一条命令）",
                         cli.returncode == 0 and payload.get("status") == "pass"
                         and sorted(payload.get("suites", {})) == ["s1", "s2", "s3", "s4"],
                         f"exit={cli.returncode} status={payload.get('status')} "
                         f"suites={sorted(payload.get('suites', {}))} stderr={cli.stderr.strip()[:120]}"))
    return out


def _stable(run: dict) -> str:
    trimmed = {key: value for key, value in run.items() if key not in VOLATILE_KEYS}
    return json.dumps(trimmed, ensure_ascii=False, sort_keys=True)


@register("AC-EVAL-002", "P0", "指标基线报告可生成且人可读；反例集只增不减（删除被拒绝）",
          command="qa ac AC-EVAL-002")
def check_eval_002() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-eval-002")
    run_s1(root)                  # 先跑场景：事件落 root/ledger.jsonl
    ledger = Ledger(root / "ledger.jsonl", realm="contractor:con-B")   # 再从该账本采集指标
    metrics = collect_metrics(ledger)
    out.append(Assertion("九项指标全部可采集（缺失记 None，不得静默补零）",
                         set(metrics["metrics"]) == set(METRIC_KEYS)
                         and all("value" in row and "basis" in row for row in metrics["metrics"].values()),
                         f"metrics={ {k: v['value'] for k, v in metrics['metrics'].items()} }"))
    out.append(Assertion("指标带依据（事件类型与计数），不是凭空数字",
                         metrics["metrics"]["澄清轮次"]["basis"]["events"] > 0
                         and metrics["metrics"]["报价可比率"]["basis"]["events"] > 0,
                         f"clarification_basis={metrics['metrics']['澄清轮次']['basis']} "
                         f"ratio_basis={metrics['metrics']['报价可比率']['basis']}"))

    report_path = root / "baseline-report.md"
    written = baseline_report(ledger, out_path=report_path)
    text = Path(written).read_text(encoding="utf-8")
    out.append(Assertion("基线报告可生成且人可读（Markdown 标题 + 逐指标一行：定义/值/依据）",
                         Path(written).exists()
                         and text.startswith("# ")
                         and text.count("\n| ") >= len(METRIC_KEYS)
                         and "指标" in text and "依据" in text,
                         f"path={written} bytes={len(text)}"))
    out.append(Assertion("报告声明 P0 不设目标值（基线规则：目标值由人设定）",
                         "不设目标值" in text and "目标值" in text
                         and not any(token in text for token in ("目标 ≥", "target:", "SLO")),
                         f"head={text.splitlines()[0] if text else ''}"))

    registry = CounterexampleRegistry(root / "counterexamples.json")
    cases = load_counterexamples()
    for case in cases:
        registry.add(case, by="human:zhang")
    out.append(Assertion("反例集随仓库入库且可加载",
                         len(registry.load()) == len(cases) and len(cases) >= 4,
                         f"count={len(registry.load())} cases={[c['case_id'] for c in cases]}"))
    rejected = None
    try:
        registry.remove(cases[0]["case_id"])
    except CounterexampleImmutable as exc:
        rejected = exc
    out.append(Assertion("删除反例被拒绝（只增不减，防止改测试提高通过率）",
                         rejected is not None
                         and len(registry.load()) == len(cases),
                         f"error={rejected} count_after={len(registry.load())}"))
    replaced = None
    try:
        registry.add(dict(cases[0], payload={"tampered": True}), by="human:zhang", allow_rewrite=True)
    except CounterexampleImmutable as exc:
        replaced = exc
    out.append(Assertion("改写既有反例同样被拒绝（同 case_id 视为改写）",
                         replaced is not None, f"error={replaced}"))
    return out
