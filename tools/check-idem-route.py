"""check-idem-route —— 幂等守卫接在**真实调用路径**上的端到端检查（`tools/verify.sh idem-route`）。

真跑命令、看真输出：
  ① `--idem-probe 3`（同一请求连发 3 次）→ 只有**第一次**真的打到下游，后两次判重复并**复用**结论
     （`reused >= 2`，且熔断器的 `allowed` 计数 = 1，这就是"没有重复打下游"的硬证据）；
  ② 不同请求不误判：换 params 再跑，必须仍是 `fresh`（幂等不许变成"什么都拦"）；
  ③ 失败请求**不得被复用成成功**：对不存在的方法连发 2 次 → 第一次失败落完成态，
     第二次判 `replay`（允许重试）而不是 `duplicate-done`。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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


# ① 同一请求连发
code, out = run_bridge("--method", "ledger.count", "--idem-probe", "3")
idem = out.get("idem") or {}
breaker = out.get("breaker") or {}
check("正控①：同一请求连发 3 次 → 后两次判**重复**并复用结论，不重复执行",
      out.get("ok") is True and int(idem.get("reused", 0)) >= 2
      and (idem.get("last") or {}).get("decision") in ("duplicate-done", "duplicate-inflight"),
      f"reused={idem.get('reused')} last={(idem.get('last') or {}).get('decision')}")
check("硬证据①：**只打了一次下游**（熔断器 allowed 计数 = 1，其余被幂等挡下）",
      int((breaker.get("stats") or {}).get("allowed", -1)) == 1,
      f"breaker.allowed={(breaker.get('stats') or {}).get('allowed')}（repeat=3）")

# ② 不同请求不误判
code2, out2 = run_bridge("--method", "ledger.count", "--params", '{"probe":"other"}')
check("负控②：换了 params 的请求仍判 `fresh`（幂等不许变成'什么都拦'）",
      (out2.get("idem") or {}).get("last", {}).get("decision") == "fresh" and out2.get("ok") is True,
      f"decision={(out2.get('idem') or {}).get('last', {}).get('decision')}")

# ③ 失败不得被复用成成功
code3, out3 = run_bridge("--method", "no.such/method", "--idem-probe", "2")
idem3 = out3.get("idem") or {}
last3 = idem3.get("last") or {}
check("负控③：失败请求连发 2 次 → 第二次判 `replay`（允许重试）而**不是** duplicate-done（失败不得被复用成成功）",
      last3.get("decision") == "replay" and int(idem3.get("reused", -1)) == 0,
      f"decision={last3.get('decision')} reused={idem3.get('reused')} reason={last3.get('reason')}")
check("如实记录：三种判定都被计入统计（fresh / duplicate / replay）",
      int((idem3.get("stats") or {}).get("fresh", 0)) >= 1
      and int((idem3.get("stats") or {}).get("replay", 0)) >= 1,
      f"stats={json.dumps(idem3.get('stats'), ensure_ascii=False)[:150]}")

failed = [c for c in CHECKS if not c["ok"]]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=2))
sys.exit(0 if not failed else 1)
