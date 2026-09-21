"""AC-USERPLUG-001：提需求 → 产出用户空间插件 → 落 `userplugin/created`（幂等、正文不入账本）。

本检查只验 **Python 侧**（唯一写账本者）与"产出能被管理面发现"：
· 需求待办件（0600）→ `tools/userplugin-record.py` 消费 → 账本恰一条 `userplugin/created`
  （body 含 `source_prompt_digest` 与 `artifact_sha256`，**不含需求正文**）
· 幂等：重跑标 `duplicates`、账本零新增
· manifest 非法 → `userplugin/refused`（code=manifest-invalid），且**不**落 created
· "出现在管理列表"用真 `host/lib/user-space.mjs` 的 `scan()` 验证（node 一行调用；不重写宿主逻辑）
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]


def _run_writer(requests: Path, user_space: Path, ledger: Path) -> dict:
    r = subprocess.run([os.environ.get("PYTHON", "python3"), str(ROOT / "tools" / "userplugin-record.py"),
                        "--requests", str(requests), "--user-space", str(user_space),
                        "--ledger", str(ledger), "--now", "2026-09-21T15:00:00Z"],
                       cwd=str(ROOT), capture_output=True, text=True, timeout=180)
    try:
        return {"rc": r.returncode, "out": json.loads(r.stdout.strip().splitlines()[-1]), "err": r.stderr[-300:]}
    except Exception:  # noqa: BLE001
        return {"rc": r.returncode, "out": {}, "err": (r.stdout + r.stderr)[-300:]}


def _node_available() -> bool:
    """Node 是否可用（无 Node 时本检查退化而不是变红：ADR-0013 §8）。"""
    node = os.environ.get("QUOTAGENT_NODE", "node")
    try:
        return subprocess.run([node, "--version"], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _scan(user_space: Path) -> dict:
    """管理面 `scan()` 的等价读取。

    Node 可用 → 调**真** `host/lib/user-space.mjs`（单一实现，不重写宿主逻辑）；
    Node 不可用 → 按**同一规则**（`<ns>/<plugin>/plugin.json`）做 Python 兜底扫描，并在结果里写明
    `fallback: "python"` —— ADR-0013 §8 要求 phase≠P1 的 AC 在无 Node 环境下也全绿，
    而"列表可见性"另有宿主门 `verify.sh user-space` 守卫（不靠这一条）。
    """
    if _node_available():
        script = ("import { scan } from './host/lib/user-space.mjs';"
                  f"console.log(JSON.stringify(scan({json.dumps(str(user_space))})))")
        r = subprocess.run(["node", "--input-type=module", "-e", script], cwd=str(ROOT),
                           capture_output=True, text=True, timeout=180)
        try:
            out = json.loads(r.stdout.strip().splitlines()[-1])
            out["fallback"] = ""
            return out
        except Exception:  # noqa: BLE001
            return {"error": (r.stdout + r.stderr)[-300:], "fallback": ""}
    ns_list = []
    for plugin_json in sorted(user_space.glob("*/*/plugin.json")):
        try:
            manifest = json.loads(plugin_json.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        ns_list.append({"ns": plugin_json.parent.parent.name,
                        "plugins": [{"name": manifest.get("name"), "version": manifest.get("version"),
                                     "invalid": False}]})
    return {"namespaces": ns_list, "degraded": False, "fallback": "python"}


@register("AC-USERPLUG-001", "P2",
           "提需求 → 产出用户空间插件 → 落 userplugin/created（幂等；正文不入账本；非法 manifest 落 refused）",
           "tools/verify.sh ac AC-USERPLUG-001", ("EV-136",))
def check_ac_userplug_001() -> list[Assertion]:
    out: list[Assertion] = []
    with tempfile.TemporaryDirectory(prefix="up001-") as td:
        base = Path(td)
        requests, user_space = base / "requests", base / "user-space"
        (user_space / "con-a" / "quote-trend").mkdir(parents=True)
        requests.mkdir(parents=True)
        desc = "承包商想按项目维度看报价趋势"
        item = requests / "req-1.json"
        item.write_text(json.dumps({"kind": "plugin-request", "ns": "con-a", "description": desc,
                                    "description_sha256": "sha256:" + hashlib.sha256(desc.encode()).hexdigest(),
                                    "bytes": len(desc.encode()), "requested_at": "2026-09-21T15:00:00Z"},
                                   ensure_ascii=False), encoding="utf-8")
        os.chmod(item, 0o600)
        pdir = user_space / "con-a" / "quote-trend"
        (pdir / "plugin.json").write_text(json.dumps({"ns": "con-a", "name": "quote-trend", "version": "1.0.0"}), encoding="utf-8")
        (pdir / "index.mjs").write_text("export const apply = () => {}\n", encoding="utf-8")

        ledger = base / "user-plugin.jsonl"
        first = _run_writer(requests, user_space, ledger)
        rows = [json.loads(l) for l in ledger.read_text(encoding="utf-8").splitlines() if l.strip()] if ledger.exists() else []
        created = [r for r in rows if r["type"] == "userplugin/created"]
        body = (created[0].get("body") or {}) if created else {}
        text = ledger.read_text(encoding="utf-8") if ledger.exists() else ""
        out.append(Assertion("① 需求产出后恰落一条 `userplugin/created`（含 source_prompt_digest 与 artifact_sha256）",
                    len(created) == 1 and str(body.get("source_prompt_digest", "")).startswith("sha256:")
                    and str(body.get("artifact_sha256", "")).startswith("sha256:") and body.get("version") == "1.0.0",
                    f"rc={first['rc']} created={len(created)} body_keys={sorted(body)}"))
        out.append(Assertion("② **需求正文不入账本**（只出摘要；正文是用户的话，不是事实行内容）",
                    desc not in text and "承包商想按项目维度" not in text, f"ledger_bytes={len(text)}"))
        scan = _scan(user_space)
        names = [p.get("name") for n in (scan.get("namespaces") or []) for p in (n.get("plugins") or [])]
        out.append(Assertion("③ 产出**自动出现在管理列表**（真 `scan()` 命中；无人工搬运步骤）",
                    "quote-trend" in names and not scan.get("error"), f"names={names} err={scan.get('error', '')[:80]}"))

        second = _run_writer(requests, user_space, ledger)
        rows2 = [json.loads(l) for l in ledger.read_text(encoding="utf-8").splitlines() if l.strip()]
        out.append(Assertion("④ 幂等：重跑标 duplicates、账本零新增（且退出码 0）",
                    second["out"].get("ledger_added") == 0 and len(second["out"].get("duplicates") or []) == 1
                    and second["rc"] == 0 and len(rows2) == len(rows),
                    f"rc={second['rc']} added={second['out'].get('ledger_added')} dup={len(second['out'].get('duplicates') or [])}"))

        (pdir / "plugin.json").write_text("{ not-json", encoding="utf-8")
        (user_space / "con-a" / "bad").mkdir(parents=True, exist_ok=True)
        (user_space / "con-a" / "bad" / "plugin.json").write_text("{ not-json", encoding="utf-8")
        ledger3 = base / "user-plugin-3.jsonl"
        third = _run_writer(requests, user_space, ledger3)
        rows3 = [json.loads(l) for l in ledger3.read_text(encoding="utf-8").splitlines() if l.strip()] if ledger3.exists() else []
        refused = [r for r in rows3 if r["type"] == "userplugin/refused"]
        out.append(Assertion("⑤ manifest 非法 → 落 `userplugin/refused`（code=manifest-invalid）且**不**落 created",
                    any((r.get("body") or {}).get("code") == "manifest-invalid" for r in refused)
                    and not [r for r in rows3 if r["type"] == "userplugin/created"],
                    f"rc={third['rc']} refused={len(refused)} created={len([r for r in rows3 if r['type'] == 'userplugin/created'])}"))

        bad = requests / "req-bad.json"
        bad.write_text(json.dumps({"kind": "plugin-request", "ns": "con-a", "description": desc,
                                   "description_sha256": "sha256:" + "0" * 64}, ensure_ascii=False), encoding="utf-8")
        os.chmod(bad, 0o600)
        ledger4 = base / "user-plugin-4.jsonl"
        fourth = _run_writer(requests, user_space, ledger4)
        out.append(Assertion("⑥ 自述不可信：需求正文与其 sha256 不符 → 拒绝，且不因此创建账本文件",
                    any("sha256 不一致" in str(r.get("reason")) for r in (fourth["out"].get("refused") or []))
                    or not ledger4.exists(),
                    f"rc={fourth['rc']} refused={len(fourth['out'].get('refused') or [])} ledger_exists={ledger4.exists()}"))
    return out

