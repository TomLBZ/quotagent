"""证据包（P0 最小实现）：事件切片 + Merkle 根 + 清单，独立验证不需信任导出方。

P0 只做哈希链 + Merkle 根（AC-AUDIT-001）；签名、留存与模型输入重建的完整形态见
`docs/design/04-services-catalog.md` §2 的 `ctx.evidence`（P1 / T-208）。
"""

from __future__ import annotations

from .canon import ZERO_HASH, digest, merkle_root
from .ledger import Ledger, entry_hash_of, utc_now


def export(ledger: Ledger, *, scope: str | None = None, from_seq: int = 1,
           to_seq: int | None = None, generated_at: str | None = None) -> dict:
    """导出审计包。`ledger` 必须健康（冻结的账本不得导出对外证据）。"""
    ledger.assert_healthy()
    events = ledger.read(from_seq=from_seq, to_seq=to_seq)
    if not events:
        raise ValueError("空切片：无事件可导出")
    pack = {
        "kind": "quotagent/evidence-pack",
        "qep_version": "1.0",
        "scope": scope or f"ledger:{ledger.realm}",
        "generated_at": generated_at or utc_now(),
        "events": events,
        "leafs": [rec["entry_hash"] for rec in events],
        "merkle_root": merkle_root([rec["entry_hash"] for rec in events]),
        "manifest": {
            "realm": ledger.realm,
            "from_seq": events[0]["seq"],
            "to_seq": events[-1]["seq"],
            "count": len(events),
            "anchor_prev_hash": events[0]["prev_hash"],
            "head_hash": ledger.head_hash,
            "ledger_count": ledger.count,
        },
    }
    pack["manifest"]["pack_hash"] = digest({k: v for k, v in pack.items() if k != "manifest"})
    return pack


def verify(pack: dict) -> dict:
    """独立验证：不看导出方状态，只看包内自洽性。返回 {ok, checks[], first_failure}。"""
    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    events = pack.get("events") or []
    manifest = pack.get("manifest") or {}
    expected_prev = str(manifest.get("anchor_prev_hash", ZERO_HASH))
    chain_ok, chain_detail = True, "逐条重算 entry_hash 与链连接"
    for rec in events:
        if entry_hash_of(rec) != rec.get("entry_hash") or digest(rec.get("body")) != rec.get("body_hash"):
            chain_ok, chain_detail = False, f"seq {rec.get('seq')} 的记录内容与 entry_hash/body_hash 不一致"
            break
        if rec.get("prev_hash") != expected_prev:
            chain_ok, chain_detail = False, f"seq {rec.get('seq')} 的 prev_hash 与链上一条不连续"
            break
        expected_prev = rec["entry_hash"]
    add("哈希链（包内自洽）", chain_ok, chain_detail)

    leafs = [rec.get("entry_hash") for rec in events]
    add("Merkle 根与事件切片一致", merkle_root(leafs) == pack.get("merkle_root"),
        f"recomputed={merkle_root(leafs)}")
    add("leafs 列表与事件切片一致", leafs == list(pack.get("leafs") or []))
    add("清单计数一致", manifest.get("count") == len(events),
        f"manifest={manifest.get('count')} events={len(events)}")
    add("清单边界一致",
        (not events) or (manifest.get("from_seq") == events[0]["seq"] and manifest.get("to_seq") == events[-1]["seq"]))
    add("包哈希一致",
        digest({k: v for k, v in pack.items() if k != "manifest"}) == manifest.get("pack_hash"))

    failed = [c for c in checks if not c["ok"]]
    return {"ok": not failed, "checks": checks,
            "first_failure": failed[0]["name"] + ": " + failed[0]["detail"] if failed else ""}
