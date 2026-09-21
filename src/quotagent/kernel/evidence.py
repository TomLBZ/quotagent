"""证据包：事件切片 + Merkle 根 + 清单 + **签名** + **包含证明**，独立验证不需信任导出方。

P0（AC-AUDIT-001）：哈希链 + Merkle 根 + 清单。P1（AC-AUDIT-004 / FR-EVIDENCE-005）补：
- 包**签名**（P1 用 HMAC-SHA256 占位，见 ADR-0008；Ed25519 待后续）；签名覆盖除签名字段外的整包；
- **清单自身**被 `manifest_hash` 绑定（改清单任意字段即失败，而不是只靠计数检查）；
- `inclusion_proof()` / `verify_inclusion()`：第三方只需叶子 + 证明 + 根即可验证某条事件在包内；
- 验证方**未提供密钥**时不得把「有签名」当成「签名通过」（`require_signature` 语义）。
"""

from __future__ import annotations

from .canon import ZERO_HASH, canonical_bytes, digest, merkle_proof, merkle_root, merkle_verify
from .ledger import Ledger, entry_hash_of, utc_now


SIGNATURE_ALGO = "hmac-sha256"          # P1 占位（ADR-0008）；Ed25519 待后续
SIGNED_FIELDS_EXCLUDED = ("signature", "signed_by", "signature_algo")


def sign_pack(pack: dict, keystore, participant: str) -> dict:
    """给审计包签名（导出方身份可验）。签名覆盖除签名字段外的整包（含清单与根）。"""
    payload = canonical_bytes({key: value for key, value in pack.items()
                               if key not in SIGNED_FIELDS_EXCLUDED})
    pack["signature"] = keystore.sign(participant, payload)
    pack["signed_by"] = participant
    pack["signature_algo"] = SIGNATURE_ALGO
    return pack


def export(ledger: Ledger, *, scope: str | None = None, from_seq: int = 1,
           to_seq: int | None = None, generated_at: str | None = None,
           keystore=None, participant: str | None = None) -> dict:
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
    leafs = [rec["entry_hash"] for rec in events]
    pack["manifest"]["leafs"] = leafs
    pack["manifest"]["merkle_root"] = pack["merkle_root"]
    # 顺序要紧：pack_hash 覆盖"除清单与签名字段外的整包"，manifest_hash 覆盖"除自身外的整份清单"
    # （清单里包含 pack_hash，所以先算 pack_hash，再算 manifest_hash；反过来会让两者互相矛盾）
    pack["manifest"]["pack_hash"] = digest({k: v for k, v in pack.items()
                                            if k not in ("manifest",) + SIGNED_FIELDS_EXCLUDED})
    pack["manifest"]["manifest_hash"] = digest({k: v for k, v in pack["manifest"].items()
                                                if k != "manifest_hash"})
    if keystore is not None and participant:
        sign_pack(pack, keystore, participant)
    return pack


def inclusion_proof(pack: dict, seq: int) -> dict:
    """取包内某条事件的包含证明（第三方只需叶子 + 证明 + 根）。"""
    events = pack.get("events") or []
    leafs = [rec["entry_hash"] for rec in events]
    index = next((i for i, rec in enumerate(events) if rec.get("seq") == seq), None)
    if index is None:
        raise ValueError(f"包内没有 seq={seq}")
    return {"seq": seq, "leaf": leafs[index], "index": index,
            "proof": merkle_proof(leafs, index), "merkle_root": pack.get("merkle_root")}


def verify_inclusion(proof: dict) -> bool:
    """只凭叶子/证明/根验证包含关系。"""
    return merkle_verify(proof.get("leaf"), proof.get("proof") or [], proof.get("merkle_root"))


def verify(pack: dict, *, keystore=None, require_signature: bool = False) -> dict:
    """独立验证：不看导出方状态，只看包内自洽性。返回 {ok, checks[], first_failure}。

    `keystore` 为空时**不把「有签名」当「签名通过」**：要么明确记录"未提供密钥"，要么在
    `require_signature=True` 时判失败（不得静默通过）。
    """
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
    add("清单自身被 manifest_hash 绑定",
        digest({k: v for k, v in manifest.items() if k != "manifest_hash"}) == manifest.get("manifest_hash"),
        "改清单任意字段即失败（不只是计数检查）")
    add("包哈希一致",
        digest({k: v for k, v in pack.items()
                if k not in ("manifest",) + SIGNED_FIELDS_EXCLUDED}) == manifest.get("pack_hash"))
    add("清单声明的叶子与切片一致",
        list(manifest.get("leafs") or []) == leafs
        and manifest.get("merkle_root") == pack.get("merkle_root"))

    signature = pack.get("signature")
    if signature:
        if keystore is None:
            add("包签名（验证方未提供密钥）", not require_signature,
                "包内带签名，但验证方没有密钥：不得当作签名通过"
                + ("（require_signature=True 判失败）" if require_signature else "（仅记录存在性）"))
        else:
            payload = canonical_bytes({k: v for k, v in pack.items()
                                       if k not in SIGNED_FIELDS_EXCLUDED})
            add("包签名（导出方身份）",
                keystore.verify(str(pack.get("signed_by")), payload, str(signature)),
                f"signed_by={pack.get('signed_by')} algo={pack.get('signature_algo')}")
    else:
        add("包签名（存在性）", not require_signature,
            "包内没有签名" + ("（require_signature=True 判失败）" if require_signature else "（仅记录）"))

    failed = [c for c in checks if not c["ok"]]
    return {"ok": not failed, "checks": checks,
            "first_failure": failed[0]["name"] + ": " + failed[0]["detail"] if failed else ""}
