"""check-breaker-route —— 熔断器接到**真实调用路径**的端到端检查（`tools/verify.sh breaker-route`）。

它做的是"真跑命令、看真输出"：
  ① 正常方法重复调用 → 断路器全程 closed，一次都不许拒（熔断不能误伤正常流量）；
  ② 不存在的方法重复调用 → 连续失败达阈值 → 断路器打开 → 后续调用被**快速失败**且可解释
     （`reason=circuit-open` + `retry_after_ms`），并且**失败的调用次数被如实记录**。

为什么必须端到端：单元门（`verify.sh breaker`）证明的是"逻辑对"，这一条证明的是"**真的接在路径上**"——
本项目在 T-231 抓到过"注册了分流器但调用路径仍直连"的假接线，所以接线必须用真命令验。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def run_bridge(method: str, repeat: int) -> tuple[int, dict]:
    proc = subprocess.run(["node", "host/cli.mjs", "bridge", "--profile", "contractor-ops",
                           "--method", method, "--repeat", str(repeat)],
                          cwd=ROOT, capture_output=True, text=True, timeout=180)
    try:
        return proc.returncode, json.loads(proc.stdout)
    except Exception:  # noqa: BLE001
        return proc.returncode, {"_raw": proc.stdout[-400:], "_err": proc.stderr[-400:]}


# ① 正常流量不得被误伤
code_ok, ok_json = run_bridge("ledger.count", 6)
breaker_ok = ok_json.get("breaker") or {}
check("正控：正常方法重复调用 6 次，断路器**一次都不拒**（熔断不误伤正常流量）",
      ok_json.get("ok") is True and int(breaker_ok.get("refused", -1)) == 0
      and (breaker_ok.get("state") or {}).get("state") == "closed"
      and int((breaker_ok.get("stats") or {}).get("allowed", 0)) >= 6,
      f"exit={code_ok} refused={breaker_ok.get('refused')} state={(breaker_ok.get('state') or {}).get('state')} "
      f"allowed={(breaker_ok.get('stats') or {}).get('allowed')}")

# ② 连续失败 → 打开 → 后续快速失败且可解释
code_bad, bad_json = run_bridge("no.such/method", 8)
breaker_bad = bad_json.get("breaker") or {}
stats_bad = breaker_bad.get("stats") or {}
refused = int(breaker_bad.get("refused", 0))
last_refusal = breaker_bad.get("last_refusal") or {}
check("负控：连续失败达阈值 → 断路器打开，后续调用被**快速失败**（不再打下游）",
      refused >= 1 and (breaker_bad.get("state") or {}).get("state") == "open",
      f"exit={code_bad} refused={refused} state={(breaker_bad.get('state') or {}).get('state')} "
      f"consecutive={(breaker_bad.get('state') or {}).get('consecutive_failures')}")
check("可解释：被拒时给出 reason=circuit-open + retry_after_ms + next_action（不返回裸 false）",
      last_refusal.get("reason") == "circuit-open" and isinstance(last_refusal.get("retry_after_ms"), int)
      and bool(last_refusal.get("next_action")),
      f"reason={last_refusal.get('reason')} retry_after_ms={last_refusal.get('retry_after_ms')} "
      f"next_action={str(last_refusal.get('next_action'))[:40]}")
check("如实记录：失败的调用被计入断路器统计（allowed 只统计真正打到下游的那几次）",
      int(stats_bad.get("allowed", 0)) >= 1 and int(stats_bad.get("allowed", 0)) < 8
      and int(stats_bad.get("refused", 0)) + int(stats_bad.get("allowed", 0)) == 8,
      f"allowed={stats_bad.get('allowed')} refused={stats_bad.get('refused')}（repeat=8）")

failed = [c for c in CHECKS if not c["ok"]]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=2))
sys.exit(0 if not failed else 1)
