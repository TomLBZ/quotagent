"""check-ui-seed —— UI 演示种子的入库门（`tools/verify.sh ui-seed`，AC-UI-003）。

真跑三件事（全程在 scratch 上，不碰真账本）：
  ① 种子在空目录上跑 → 三域都有事件、`added > 0`；
  ② **再跑一遍 → `added == 0` 且账本逐字节不变**（幂等，D-054 第 2 条）；
  ③ 用真写入器出快照 → 三域计数**全部非 0**（面板不会是空面板），
     且**写入者一律是 `*:ui-seed`**（D-054 第 1 条：演员可识别）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REC_NEG = {"thread_id", "attempt_no", "status"}
REC_FAQ = {"entry_id", "rfq_rev"}
SEED = ROOT / "tools" / "ui-seed-pipeline.py"
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def run(*args: str) -> tuple[int, dict, str]:
    proc = subprocess.run([sys.executable, *args], cwd=str(ROOT), capture_output=True, text=True, timeout=600)
    payload: dict = {}
    for line in (proc.stdout or "").splitlines():
        if line.strip().startswith("{"):
            try:
                payload = json.loads(line)
            except Exception:  # noqa: BLE001
                pass
    return proc.returncode, payload, (proc.stdout or "") + (proc.stderr or "")


scratch = ROOT / "tmp" / "ac-ui-003"
subprocess.run(["rm", "-rf", str(scratch)], check=False)
scratch.mkdir(parents=True, exist_ok=True)

check("种子脚本存在", SEED.exists(), str(SEED.relative_to(ROOT)))
rc1, p1, log1 = run(str(SEED), "--shared-dir", str(scratch), "--now", "2026-09-21T12:00:00Z")
added1 = (p1.get("added") or {})
check("① 空目录上跑种子：exit=0 且两侧都新增了行（反例：种子里某一步静默跳过 → added 为 0）",
      rc1 == 0 and sum(int(v or 0) for v in added1.values()) > 0,
      f"rc={rc1} added={added1}")

counts1 = p1.get("counts") or {}
def three(counts: dict) -> list[str]:
    bad = []
    for side, dom in (counts or {}).items():
        for key, name in (("negotiate", "谈判"), ("faq", "FAQ"), ("mail", "邮件")):
            val = (dom or {}).get(key) or {}
            nums = [v for v in val.values() if isinstance(v, int)]
            if not nums or max(nums) <= 0:
                bad.append(f"{side}.{name}")
    return bad

check("① 三域都真的落了事件（反例：只种了谈判、FAQ/邮件为空 → 红）",
      bool(counts1) and not three(counts1), f"counts={json.dumps(counts1, ensure_ascii=False)[:160]}")

ledgers = sorted(scratch.rglob("ledger*.jsonl"))
before = {p: p.read_bytes() for p in ledgers}
rc2, p2, log2 = run(str(SEED), "--shared-dir", str(scratch), "--now", "2026-09-21T12:00:00Z")
after = {p: p.read_bytes() for p in sorted(scratch.rglob("ledger*.jsonl"))}
added2 = (p2.get("added") or {})
check("② 幂等：第二遍 added 全为 0（反例：重复运行把账本越撑越大 → 红）",
      rc2 == 0 and all(int(v or 0) == 0 for v in added2.values()), f"rc={rc2} added={added2}")
check("② 幂等：第二遍后账本**逐字节不变**（反例：追加了去重后的重复行 → 红）",
      bool(before) and before == after, f"文件数={len(before)}/{len(after)}")

snap = scratch / "pipeline.json"
rc3, _p3, log3 = run(str(ROOT / "tools" / "refresh-ui-snapshots.py"), "--shared-dir", str(scratch))
payload = {}
try:
    payload = json.loads(snap.read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    payload = {}
# 真数据非空（D-040）：种子确实种了谈判轮次与 FAQ 条目 → 有界列表**必须非空**且只含白名单键
views = payload.get("views") or {}
for _vw, _slice in views.items():
    _nrec = ((_slice.get("negotiate") or {}).get("recent")) or []
    _frec = ((_slice.get("faq") or {}).get("recent")) or []
    check(f"{_vw} 谈判 recent 真数据非空且键合规", len(_nrec) >= 1 and all(set(r) <= REC_NEG for r in _nrec), f"n={len(_nrec)}")
    check(f"{_vw} FAQ recent 真数据非空且键合规", len(_frec) >= 1 and all(set(r) <= REC_FAQ for r in _frec), f"n={len(_frec)}")
nonzero = all(
    max([v for v in ((views.get(vw) or {}).get(dom) or {}).values() if isinstance(v, int)] or [0]) > 0
    for vw in views for dom in ("negotiate", "faq", "mail"))
check("③ 快照里两视角三域计数**全部非 0**（反例：面板恒为 0 —— 空面板与坏面板看不出来）",
      rc3 == 0 and bool(views) and nonzero, f"rc={rc3} views={list(views)}")

actors = set()
for p in scratch.rglob("*.jsonl"):
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            row = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        a = str(((row.get("body") or {}).get("by")) or row.get("actor") or "")
        if a:
            actors.add(a)
seeded_actors = {a for a in actors if "ui-seed" in a}
bad_actors = {a for a in seeded_actors if not re.match(r"^(human|agent):ui-seed", a)}
check("③ 种子的写入者一律 `human:ui-seed` / `agent:ui-seed`（反例：冒充真实业务主体 → 红）",
      bool(seeded_actors) and not bad_actors, f"seed 演员={sorted(seeded_actors)[:4]} 非法={sorted(bad_actors)}")

failed = [c for c in CHECKS if not c["ok"]]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=1))
for c in failed:
    print("FAIL:", c["name"], "|", c["detail"])
sys.exit(0 if not failed else 1)
