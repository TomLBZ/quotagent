"""规范化与哈希原语。

规范形式（`docs/design/03-exchange-protocol.md` §2 的 `body_hash` 定义，落到实现）：
键排序、无空白分隔符、UTF-8、字符串先做 NFC 归一、`ensure_ascii=False`。
哈希一律带 `sha256:` 前缀；创世前驱哈希为 `sha256:` + 64 个 0。
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any, Iterable

HASH_PREFIX = "sha256:"
ZERO_HASH = HASH_PREFIX + "0" * 64


def nfc(obj: Any) -> Any:
    if isinstance(obj, str):
        return unicodedata.normalize("NFC", obj)
    if isinstance(obj, dict):
        return {nfc(k): nfc(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [nfc(v) for v in obj]
    return obj


def canonical_json(obj: Any) -> str:
    return json.dumps(nfc(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_bytes(obj: Any) -> bytes:
    return canonical_json(obj).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(obj: Any) -> str:
    """对象 → `sha256:<hex>`（先规范化为 canonical JSON）。"""
    return HASH_PREFIX + sha256_hex(canonical_bytes(obj))


def is_hash(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(HASH_PREFIX) and len(value) == len(HASH_PREFIX) + 64


def merkle_root(leaf_hashes: Iterable[str]) -> str:
    """按顺序两两合并的 Merkle 根；落单者与自身合并；空集合返回 ZERO_HASH。"""
    level = [str(h) for h in leaf_hashes]
    if not level:
        return ZERO_HASH
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else level[i]
            nxt.append(HASH_PREFIX + sha256_hex((left + right).encode("utf-8")))
        level = nxt
    return level[0]


def merkle_proof(leaf_hashes: Iterable[str], index: int) -> list[dict]:
    """`index` 处叶子的包含证明（与 `merkle_root` 同构：落单者与自己配对）。"""
    level = [str(h) for h in leaf_hashes]
    if not level:
        raise ValueError("空集合没有包含证明")
    if not 0 <= index < len(level):
        raise IndexError(f"index {index} 超出范围（0..{len(level) - 1}）")
    proof: list[dict] = []
    cursor = index
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else level[i]
            nxt.append(HASH_PREFIX + sha256_hex((left + right).encode("utf-8")))
        sibling = cursor + 1 if cursor % 2 == 0 else cursor - 1
        sibling = sibling if sibling < len(level) else cursor
        proof.append({"side": "right" if cursor % 2 == 0 else "left", "hash": level[sibling]})
        cursor //= 2
        level = nxt
    return proof


def merkle_verify(leaf_hash: str, proof: Iterable[dict], root: str) -> bool:
    """用包含证明把 `leaf_hash` 折到 `root`（验证方只需要叶子、证明与根）。"""
    current = str(leaf_hash)
    for step in proof:
        sibling = str(step.get("hash"))
        current = (HASH_PREFIX + sha256_hex((current + sibling).encode("utf-8"))
                   if step.get("side") == "right"
                   else HASH_PREFIX + sha256_hex((sibling + current).encode("utf-8")))
    return current == root
