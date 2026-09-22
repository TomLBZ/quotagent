"""中转（relay）：**只做 opaque 字节转发**，不解析 body（`03` §1 / FR-INTEG-002）。

角色边界：
- relay 有**自己的 realm 与账本**（`relay:r-1`），不写任何参与者的账本；
- relay **不解析报文内容**（不做 json.loads），只记录整包 `sha256` → 因而"对它注入篡改"不会在 relay 层被
  语义识别，但会在**接收方验签**时暴露（AC-INTEG-002 的两条断言分别覆盖）；
- 目标不可达 → **排队**（落 `relay/queued`），`pump()` 重试（落 `relay/retry` → `relay/delivered`）；
- 投递前重算 spool 字节的 `sha256`：与接收时不一致 → `relay/tamper-detected` 并**拒绝投递**（不把坏包递出去）。
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Callable

from ..kernel.ledger import Ledger, utc_now

RELAY_EVENTS = ("relay/received", "relay/queued", "relay/retry", "relay/delivered", "relay/tamper-detected")


class RelayError(RuntimeError):
    pass


def sha256_of(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class RelayService:
    """一个中转节点：spool + 自己的账本。`inbox_of(to)` 由调用方注入（决定"可达性"）。"""

    def __init__(self, *, ledger: Ledger, participant: str = "relay:r-1", realm: str = "relay:r-1",
                 spool_root: str | Path | None = None,
                 inbox_of: Callable[[str], Path | None] | None = None) -> None:
        self.participant = participant
        self.realm = realm
        self.ledger = ledger
        self.spool_root = Path(spool_root or (Path(ledger.path).parent / "spool"))
        self.inbox_of = inbox_of or (lambda _to: None)
        self.outbox: list[dict] = []       # 已接收、尚未投递
        self.queued: list[dict] = []       # 投递失败、等待重试
        self.delivered: list[dict] = []

    # ---------------------------------------------------------------- 接收（+可选立即转发）
    def accept(self, message: Any, *, to: str, name: str | None = None,
               deliver_now: bool = True) -> dict:
        """接收整包字节（**不解析内容**），落 spool 并记账；默认立即尝试转发。"""
        raw = message if isinstance(message, bytes) else Path(message).read_bytes()
        digest = sha256_of(raw)
        count = len(self.ledger.read(type="relay/received")) + 1
        blob_name = name or f"{count:06d}-{digest.split(':')[1][:8]}.blob"
        self.spool_root.mkdir(parents=True, exist_ok=True)
        blob = self.spool_root / blob_name
        blob.write_bytes(raw)
        item = {"blob": str(blob), "name": blob_name, "to": to, "sha256": digest,
                "bytes": len(raw), "attempts": 0, "received_at": utc_now()}
        self.ledger.append(
            "relay/received",
            {"to": to, "sha256": digest, "bytes": len(raw), "blob": blob_name, "parsed": False,
             "note": "relay 不解析 body（FR-INTEG-002）"},
            actor=self.participant, refs={"to": to})
        self.outbox.append(item)
        if not deliver_now:
            return {**item, "delivered": False, "queued": False, "pending": True}
        return self.deliver(item)

    # ---------------------------------------------------------------- 投递
    def deliver(self, item: dict) -> dict:
        """把 spool 里的字节**原样**投到目标收件箱；不可达即排队。"""
        blob = Path(item["blob"])
        if not blob.exists():
            raise RelayError(f"spool 里找不到 {item['name']}")
        raw = blob.read_bytes()
        if sha256_of(raw) != item["sha256"]:
            self.ledger.append(
                "relay/tamper-detected",
                {"blob": item["name"], "to": item["to"], "expected_sha256": item["sha256"],
                 "actual_sha256": sha256_of(raw), "action": "refused-delivery",
                 "note": "中转只做 opaque 校验；语义篡改仍由接收方验签发现"},
                actor=self.participant, refs={"to": item["to"]})
            raise RelayError(f"spool 内容与接收时的哈希不一致，拒绝投递: {item['name']}")
        target = self.inbox_of(item["to"])
        final: Path | None = None
        if target is not None:
            try:
                target.mkdir(parents=True, exist_ok=True)
                proposed = target / item["name"]
                staging = proposed.with_suffix(proposed.suffix + ".tmp")
                staging.write_bytes(raw)                   # 原子写（临时文件 + rename，同 FR-INTEG-001）
                staging.replace(proposed)
                final = proposed
            except OSError as err:
                return self._queue(item, reason=f"目标不可达（{type(err).__name__}: {err}）")
        if final is None:
            return self._queue(item, reason="目标不可达（resolver 返回空）")
        item["attempts"] = int(item.get("attempts", 0)) + 1
        self.ledger.append(
            "relay/delivered",
            {"blob": item["name"], "to": item["to"], "sha256": item["sha256"], "bytes": len(raw),
             "path": str(final), "attempts": item["attempts"], "parsed": False},
            actor=self.participant, refs={"to": item["to"]})
        self.delivered.append(dict(item))
        self.outbox = [existing for existing in self.outbox if existing["name"] != item["name"]]
        self.queued = [existing for existing in self.queued if existing["name"] != item["name"]]
        return {"delivered": True, "queued": False,
                **{key: item[key] for key in ("name", "to", "sha256", "attempts", "blob")},
                "path": str(final)}

    def _queue(self, item: dict, *, reason: str) -> dict:
        item["attempts"] = int(item.get("attempts", 0)) + 1
        item["reason"] = reason
        if not any(existing["name"] == item["name"] for existing in self.queued):
            self.queued.append(item)
        self.ledger.append(
            "relay/queued",
            {"blob": item["name"], "to": item["to"], "attempts": item["attempts"], "reason": reason,
             "note": "不可达即排队，稍后 pump() 重试（不丢包）"},
            actor=self.participant, refs={"to": item["to"]})
        return {"delivered": False, "queued": True, "name": item["name"], "to": item["to"],
                "blob": item["blob"], "attempts": item["attempts"], "reason": reason}

    def pump(self) -> dict:
        """重试所有排队项（仍不可达则继续排队）。"""
        attempted, delivered, still = [], [], []
        for item in list(self.queued):
            self.ledger.append(
                "relay/retry",
                {"blob": item["name"], "to": item["to"], "attempt": item["attempts"] + 1},
                actor=self.participant, refs={"to": item["to"]})
            attempted.append(item["name"])
            try:
                outcome = self.deliver(item)
            except RelayError as err:
                still.append({"name": item["name"], "error": str(err)})
                continue
            if outcome.get("delivered"):
                delivered.append(item["name"])
            else:
                still.append({"name": item["name"], "reason": outcome.get("reason")})
        keep = {entry["name"] for entry in still}
        self.queued = [item for item in self.queued if item["name"] in keep]
        return {"attempted": attempted, "delivered": delivered, "still_queued": still,
                "queue": len(self.queued)}

    # ---------------------------------------------------------------- 查询
    def pending(self) -> list[dict]:
        return [dict(item) for item in self.queued]

    def history(self) -> list[dict]:
        return [{"seq": rec["seq"], "type": rec["type"], "body": rec["body"]}
                for rec in self.ledger.read() if rec["type"].startswith("relay/")]

    def spool_bytes(self, name: str) -> bytes:
        return (self.spool_root / name).read_bytes()
