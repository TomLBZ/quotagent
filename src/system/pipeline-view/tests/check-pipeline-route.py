"""check-pipeline-route —— 三域运维道端到端（`tools/verify.sh pipeline-route`，AC-PIPELINE-001）。

真做四件事：
  ① 用真写入器把快照写到 `tmp/ui-shared/pipeline.json`（Python 侧判定 → 宿主只读）；
  ② 真起一个 `cli.mjs webui` 进程（随机空闲端口、私有前缀），只加载进树模块；
  ③ `GET <prefix>/api/pipeline` 断言：200、含三域、`transport.available` 为布尔、
     `transport.reason`/`next_action` 齐备、**`transport.available` 必须为 false**（本轮无发信能力，D-052）、
     响应里不出现 `"body"`/`private:`/`reserve_price`；
  ④ 断言同一次会话里 `/api/ops` 仍 200（没有把既有运维道弄坏）。
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def curl(url: str, timeout: float = 10.0) -> tuple[int, str]:
    proc = subprocess.run(["curl", "-s", "-m", str(timeout), "-w", "\\n%{http_code}", url],
                          capture_output=True, text=True)
    body, _, code = proc.stdout.rpartition("\n")
    try:
        return int(code.strip()), body
    except ValueError:
        return 0, body


# ① 真刷新快照（写不了也不致命：路由会走降级路径，下面的断言会如实反映）
snap = ROOT / "tmp" / "ui-shared" / "pipeline.json"
refresh = subprocess.run([sys.executable, str(ROOT / "src" / "system" / "webui" / "tools" / "refresh-ui-snapshots.py"),
                          "--shared-dir", str(ROOT / "tmp" / "ui-shared")],
                         cwd=str(ROOT), capture_output=True, text=True, timeout=300)
check("① 快照刷新可运行（Python 侧写入器）", refresh.returncode == 0,
      f"rc={refresh.returncode} {refresh.stdout.strip()[:120]}{refresh.stderr.strip()[-160:]}")

# ② 真起服务
port = free_port()
prefix = "/q"
env = dict(os.environ)
proc = subprocess.Popen(["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui",
                         "--port", str(port), "--host", "127.0.0.1", "--prefix", prefix,
                         "--ledger-contractor", str(ROOT / "tmp" / "ui-shared" / "contractor" / "ledger.jsonl"),
                         "--ledger-supplier", str(ROOT / "tmp" / "ui-shared" / "supplier" / "ledger.jsonl"),
                         "--retention-plan", str(ROOT / "tmp" / "ui-shared" / "retention-plan.json"),
                         "--pipeline-snapshot", str(snap)],
                        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
try:
    up = False
    for _ in range(30):
        code, _b = curl(f"http://127.0.0.1:{port}{prefix}/api/health", timeout=3)
        if code == 200:
            up = True
            break
        time.sleep(1)
    check("② webui 进程就绪（/api/health 200）", up, f"port={port}")

    code, body = curl(f"http://127.0.0.1:{port}{prefix}/api/pipeline")
    data = {}
    try:
        data = json.loads(body)
    except Exception:  # noqa: BLE001
        data = {}
    pipe = data.get("pipeline") or {}
    tr = pipe.get("transport") or {}
    check("③ /api/pipeline 200 且含三域视图数组", code == 200 and isinstance(pipe.get("views"), list),
          f"status={code} views={len(pipe.get('views') or [])}")
    if pipe.get("views"):
        v0 = pipe["views"][0]
        check("③ 每个视角含 negotiate/faq/mail 三域", all(k in v0 for k in ("negotiate", "faq", "mail")),
              json.dumps(v0, ensure_ascii=False)[:160])
    check("③ transport 三件齐备（available/reason/next_action）",
          isinstance(tr.get("available"), bool) and bool(tr.get("reason")) and bool(tr.get("next_action")),
          json.dumps(tr, ensure_ascii=False)[:140])
    check("③ **本轮无发信能力 → transport.available 必须为 false**（D-052：不许报看起来能发）",
          tr.get("available") is False, f"available={tr.get('available')!r}")
    check("③ 响应不出正文与私域（\"body\"/private:/reserve_price 均不出现）",
          '"body"' not in body and "private:" not in body and "reserve_price" not in body, f"len={len(body)}")

    # 业务双方视角：谈判轮次与 FAQ 条目（只读快照切片；判定在 Python 侧）
    for view in ("contractor", "supplier"):
        c_n, b_n = curl(f"http://127.0.0.1:{port}{prefix}/{view}/api/negotiation")
        n = {}
        try:
            n = json.loads(b_n)
        except Exception:  # noqa: BLE001
            n = {}
        check(f"③ 业务视角 {view}/api/negotiation 200 且含计数（反例：路由不匹配快照域键 → counts 缺失）",
              c_n == 200 and isinstance(n.get("counts"), dict) and isinstance(n.get("recent"), list),
              f"status={c_n} counts={json.dumps(n.get('counts'), ensure_ascii=False)[:80]}")
        # 有界 + 键白名单（AC-PIPELINE-001 "有界"与"不出正文与私域"的机检）
        n_keys = set()
        for r in (n.get("recent") or []):
            n_keys |= set(r)
        check(f"③ {view} 谈判 recent 有界（≤5）且键白名单（thread_id/attempt_no/status）",
              len(n.get("recent") or []) <= 5 and n_keys <= {"thread_id", "attempt_no", "status"},
              f"n={len(n.get('recent') or [])} keys={sorted(n_keys)}")
        c_f, b_f = curl(f"http://127.0.0.1:{port}{prefix}/{view}/api/faq")
        f = {}
        try:
            f = json.loads(b_f)
        except Exception:  # noqa: BLE001
            f = {}
        check(f"③ 业务视角 {view}/api/faq 200 且含计数（反例：同上）",
              c_f == 200 and isinstance(f.get("counts"), dict) and isinstance(f.get("recent"), list),
              f"status={c_f} counts={json.dumps(f.get('counts'), ensure_ascii=False)[:80]}")
        f_keys = set()
        for r in (f.get("recent") or []):
            f_keys |= set(r)
        check(f"③ {view} FAQ recent 有界（≤5）且键白名单（entry_id/rfq_rev）",
              len(f.get("recent") or []) <= 5 and f_keys <= {"entry_id", "rfq_rev"},
              f"n={len(f.get('recent') or [])} keys={sorted(f_keys)}")
        check(f"③ {view} 的两条业务视角响应不出正文与私域",
              '"body"' not in b_n + b_f and "private:" not in b_n + b_f, "")

    code2, _ = curl(f"http://127.0.0.1:{port}{prefix}/api/ops")
    check("④ 既有运维道未被弄坏（/api/ops 仍 200）", code2 == 200, f"status={code2}")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()

failed = [c for c in CHECKS if not c["ok"]]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=2))
for c in failed:
    print("FAIL:", c["name"], "|", c["detail"])
sys.exit(0 if not failed else 1)
