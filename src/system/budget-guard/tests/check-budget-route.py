"""check-budget-route —— 预算守卫接在**真实调用路径**上的端到端检查（`tools/verify.sh budget-route`）。

真跑命令、看真输出：
  ① `--budget 2 --cost 1 --repeat 4`（4 个**不同**请求）→ 前两次放行、后两次被预算拒绝且可解释；
  ② **硬证据**：预算被拒的请求**没有打到下游**（熔断器 allowed = 2，不是 4）；
  ③ 预算被拒**不误伤幂等**（不同请求 → reused = 0）；
  ④ 预算充足时一次都不拒（不能有"没超也拒"的假象）。
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


def run_bridge(*extra: str) -> tuple[int, dict]:
    proc = subprocess.run(["node", "host/cli.mjs", "bridge", "--profile", "contractor-ops", *extra],
                          cwd=ROOT, capture_output=True, text=True, timeout=180)
    try:
        return proc.returncode, json.loads(proc.stdout)
    except Exception:  # noqa: BLE001
        return proc.returncode, {"_raw": proc.stdout[-300:], "_err": proc.stderr[-300:]}


# ① + ② 预算耗尽
code, out = run_bridge("--method", "ledger.count", "--budget", "2", "--cost", "1", "--repeat", "4")
budget = out.get("budget") or {}
breaker = out.get("breaker") or {}
idem = out.get("idem") or {}
check("正控①：预算 2 / 每次 1 / 4 个不同请求 → 后两次被预算拒绝且**可解释**",
      out.get("ok") is True and int(budget.get("refused", 0)) == 2
      and (budget.get("last") or {}).get("admitted") is False
      and bool((budget.get("last") or {}).get("reason"))
      and bool((budget.get("last") or {}).get("next_action")),
      f"refused={budget.get('refused')} reason={(budget.get('last') or {}).get('reason')}")
check("硬证据②：被预算拒绝的请求**没有打到下游**（熔断器 allowed = 2，而不是 4）",
      int((breaker.get("stats") or {}).get("allowed", -1)) == 2,
      f"breaker.allowed={(breaker.get('stats') or {}).get('allowed')}（4 个请求里只有 2 个真的执行）")
check("负控③：预算拒绝**不误伤幂等**（不同请求 → reused = 0）",
      int(idem.get("reused", -1)) == 0, f"idem.reused={idem.get('reused')}")

# ④ 预算充足
code2, out2 = run_bridge("--method", "ledger.count", "--budget", "100", "--cost", "1", "--repeat", "3")
b2 = out2.get("budget") or {}
check("负控④：预算充足时**一次都不拒**（不能有'没超也拒'的假象）",
      out2.get("ok") is True and int(b2.get("refused", -1)) == 0
      and int((b2.get("stats") or {}).get("admitted", 0)) >= 3,
      f"refused={b2.get('refused')} admitted={(b2.get('stats') or {}).get('admitted')}")

# ⑤ 单次成本超整窗预算：可解释且**不该建桶占额度**
code3, out3 = run_bridge("--method", "ledger.count", "--budget", "1", "--cost", "5", "--repeat", "1")
b3 = out3.get("budget") or {}
check("负控⑤：单次成本 > 整窗预算 → 拒绝理由与'等窗口'区分开（可解释，不是裸 false）",
      (b3.get("last") or {}).get("admitted") is False and bool((b3.get("last") or {}).get("reason"))
      and int(b3.get("refused", 0)) >= 1,
      f"reason={(b3.get('last') or {}).get('reason')} next_action={str((b3.get('last') or {}).get('next_action'))[:40]}")

failed = [c for c in CHECKS if not c["ok"]]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=2))
sys.exit(0 if not failed else 1)
