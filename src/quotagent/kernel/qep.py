"""ctx.qep：信封构造/校验/签名/验签 + 幂等收发（`docs/design/03-exchange-protocol.md`）。

P0 落地细节见 ADR-0008：签名用 HMAC-SHA256（共享密钥，单进程 mock），Ed25519 在 P1 落地。
去重两层（03 §5）：`msg_id` 已见即丢弃；`(correlation_id, type, body_hash)` 相同视为同一事实（由账本兜底）。
崩溃恢复（03 §7）：出站 `seq` 与前驱哈希从账本 `kernel/qep-sent` 重放恢复，重发内容不变。
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Any, Iterable

from .canon import ZERO_HASH, canonical_bytes, digest
from .ledger import Ledger, utc_now

SUPPORTED_QEP_VERSIONS = ("1.0",)
SIGNATURE_ALGO = "hmac-sha256"  # P0（ADR-0008）
CLASSES = ("fact", "intent", "commitment")
REQUIRED_FIELDS = ("qep_version", "msg_id", "correlation_id", "seq", "prev_hash", "sent_at",
                   "sender", "recipients", "refs", "type", "class", "body_hash", "body")

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class QepError(RuntimeError):
    """QEP 错误基类。"""


class EnvelopeError(QepError):
    """信封结构/内容不合法。"""


class SignatureError(QepError):
    """签名相关错误。"""


def new_msg_id(now_ms: int | None = None, randomness: int | None = None) -> str:
    """ULID 形态的 26 字符 ID（Crockford base32，时间前缀保证字典序单调）。"""
    timestamp = int(time.time() * 1000) if now_ms is None else int(now_ms)
    rand = int.from_bytes(os.urandom(10), "big") if randomness is None else int(randomness)
    value = (timestamp << 80) | (rand & ((1 << 80) - 1))
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


def signature_payload(envelope: dict) -> bytes:
    """签名覆盖除 `signature` 外的整个信封（03 §2）。"""
    return canonical_bytes({key: value for key, value in envelope.items() if key != "signature"})


class KeyStore:
    """P0 的密钥库：HMAC-SHA256 共享密钥（ADR-0008）。接口与 Ed25519 版本相同，P1 只替换实现。"""

    def __init__(self) -> None:
        self._entries: dict[str, dict] = {}
        self.algorithm = SIGNATURE_ALGO

    def add(self, participant_id: str, *, secret: bytes | str, kind: str = "participant",
            realm: str | None = None, key_id: str | None = None) -> dict:
        material = secret.encode("utf-8") if isinstance(secret, str) else bytes(secret)
        entry = {"participant_id": participant_id, "kind": kind, "realm": realm,
                 "key_id": key_id or f"{participant_id}-k1", "secret": material}
        self._entries[participant_id] = entry
        return {k: v for k, v in entry.items() if k != "secret"}

    def has(self, participant_id: str) -> bool:
        return participant_id in self._entries

    def entry(self, participant_id: str) -> dict:
        if participant_id not in self._entries:
            raise SignatureError(f"未知参与方: {participant_id!r}（无密钥，无法验签）")
        return self._entries[participant_id]

    def participants(self) -> list[str]:
        return sorted(self._entries)

    def sign(self, participant_id: str, payload: bytes) -> str:
        entry = self.entry(participant_id)
        mac = hmac.new(entry["secret"], payload, hashlib.sha256).hexdigest()
        return f"{self.algorithm}:{entry['key_id']}:{mac}"

    def verify(self, participant_id: str, payload: bytes, signature: str) -> bool:
        if not isinstance(signature, str) or signature.count(":") != 2:
            return False
        algo, key_id, mac = signature.split(":", 2)
        if algo != self.algorithm or not self.has(participant_id):
            return False
        entry = self.entry(participant_id)
        if key_id != entry["key_id"]:
            return False
        expected = hmac.new(entry["secret"], payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, mac)


def _coerce_message(message: Any) -> tuple[bytes, Path | None]:
    if isinstance(message, (bytes, bytearray)):
        return bytes(message), None
    if isinstance(message, (str, os.PathLike, Path)):
        path = Path(message)
        return path.read_bytes(), path
    if isinstance(message, dict):
        if "raw" in message:
            return message["raw"], message.get("path")
        return canonical_bytes(message), None
    raise QepError(f"无法识别的报文类型: {type(message).__name__}")


class QepEndpoint:
    """一方的 QEP 端点（P0：单进程内双方各一个实例，走文件投递）。"""

    def __init__(self, *, participant: str, kind: str, realm: str, keystore: KeyStore,
                 ledger: Ledger, transport: Any = None, events: Any = None,
                 supported: Iterable[str] = SUPPORTED_QEP_VERSIONS,
                 agent_id: str | None = None) -> None:
        self.participant = participant
        self.kind = kind
        self.realm = realm
        self.keystore = keystore
        self.ledger = ledger
        self.transport = transport
        self.events = events
        self.supported = tuple(supported)
        self.agent_id = agent_id or f"{kind}-agent@0.1.0"
        self._seen_msg_ids: set[str] = set()
        self._duplicate_attempts: dict[str, int] = {}
        self._sent: dict[str, dict] = {}
        self.rejected_messages: list[dict] = []
        self._outbox_seq, self._prev_body_hash = self._recover_outbox()

    # --- 出站状态（崩溃恢复：03 §7） ---------------------------------------
    def _recover_outbox(self) -> tuple[int, str]:
        seq, prev = 0, ZERO_HASH
        for record in self.ledger.read(type="kernel/qep-sent"):
            body = record["body"]
            seq = max(seq, int(body.get("seq", 0)))
            prev = body.get("body_hash", prev)
        return seq, prev

    @property
    def next_seq(self) -> int:
        return self._outbox_seq + 1

    @property
    def prev_hash(self) -> str:
        return self._prev_body_hash

    # --- 信封 -------------------------------------------------------------
    def envelope(self, type: str, event_class: str, body: dict, *, refs: dict | None = None,
                 recipients: list[str] | None = None, approvals: list[dict] | None = None,
                 correlation_id: str | None = None, msg_id: str | None = None,
                 sent_at: str | None = None) -> dict:
        if event_class not in CLASSES:
            raise EnvelopeError(f"class 取值非法: {event_class!r}；取值: {CLASSES}")
        return {
            "qep_version": self.supported[-1],
            "msg_id": msg_id or new_msg_id(),
            "correlation_id": correlation_id or new_msg_id(),
            "seq": self.next_seq,
            "prev_hash": self._prev_body_hash,
            "sent_at": sent_at or utc_now(),
            "sender": {"participant_id": self.participant, "kind": self.kind,
                       "realm": self.realm, "agent_id": self.agent_id},
            "recipients": list(recipients or []),
            "refs": dict(refs or {}),
            "type": type,
            "class": event_class,
            "body_hash": digest(body),
            "body": copy.deepcopy(body),
            "approvals": list(approvals or []),
        }

    def validate(self, envelope: dict, *, require_signature: bool = False) -> dict:
        errors: list[str] = []
        for field in REQUIRED_FIELDS:
            if field not in envelope:
                errors.append(f"缺少字段 {field}")
        if envelope.get("qep_version") not in self.supported:
            errors.append(f"qep_version 不兼容: {envelope.get('qep_version')!r}（本端支持 {list(self.supported)}）")
        if envelope.get("class") not in CLASSES:
            errors.append(f"class 取值非法: {envelope.get('class')!r}")
        if "body" in envelope and digest(envelope["body"]) != envelope.get("body_hash"):
            errors.append("body_hash 与 body 不一致（内容被改动）")
        if envelope.get("class") == "commitment":
            approvals = envelope.get("approvals") or []
            if not approvals:
                errors.append("commitment 缺 approvals：拒收（FR-QEP-002 / INV-005）")
            for approval in approvals:
                if not str(approval.get("by", "")).startswith("human:"):
                    errors.append(f"批准必须由人产生，收到 {approval.get('by')!r}（代签禁止，FR-APPROVE-001）")
                if not approval.get("scope") or not approval.get("at"):
                    errors.append("批准记录缺 scope/at（批准必须绑定范围与时间）")
        if require_signature and not envelope.get("signature"):
            errors.append("缺少 signature（未签名报文不得入账）")
        return {"ok": not errors, "errors": errors}

    def sign(self, envelope: dict) -> dict:
        sender = envelope.get("sender", {}).get("participant_id")
        if sender != self.participant:
            raise SignatureError(f"只能签署本方信封（sender={sender!r}）")
        signed = copy.deepcopy(envelope)
        signed.pop("signature", None)
        signed["signature"] = self.keystore.sign(self.participant, signature_payload(signed))
        return signed

    def verify(self, envelope: dict) -> bool:
        sender = (envelope.get("sender") or {}).get("participant_id")
        signature = envelope.get("signature")
        if not sender or not signature:
            return False
        return self.keystore.verify(sender, signature_payload(envelope), signature)

    # --- 发送 -------------------------------------------------------------
    def send(self, envelope: dict) -> dict:
        report = self.validate(envelope)
        if not report["ok"]:
            raise EnvelopeError(f"信封不合法，拒绝发送: {report['errors']}")
        if envelope["sender"]["participant_id"] != self.participant:
            raise EnvelopeError("只能发送本方信封")
        signed = self.sign(envelope)
        raw = canonical_bytes(signed)
        path = None
        if self.transport is not None:
            recipients = signed.get("recipients") or []
            if not recipients:
                raise EnvelopeError("收件人为空，无法投递")
            path = self.transport.write(signed, to=recipients[0])
        ref = self.ledger.append(
            "kernel/qep-sent",
            {"envelope": signed, "msg_id": signed["msg_id"], "seq": signed["seq"],
             "body_hash": signed["body_hash"], "path": str(path) if path else None,
             "recipients": signed["recipients"]},
            correlation_id=signed["correlation_id"], event_class="fact", actor=self.participant,
            refs={"msg_id": signed["msg_id"], "seq": signed["seq"]})
        self._outbox_seq = int(signed["seq"])
        self._prev_body_hash = signed["body_hash"]
        self._sent[signed["msg_id"]] = signed
        return {"msg_id": signed["msg_id"], "path": path, "bytes": raw,
                "envelope": signed, "ledger_ref": ref.as_dict(), "duplicate": ref.duplicate}

    def resend(self, msg_id: str) -> bytes:
        """重发：内容不变（msg_id 与 body_hash 不变），因此不会产生第二条事实（03 §5/§7）。"""
        envelope = self._sent.get(msg_id)
        if envelope is None:
            for record in self.ledger.read(type="kernel/qep-sent"):
                if record["body"].get("msg_id") == msg_id:
                    envelope = record["body"]["envelope"]
                    self._sent[msg_id] = envelope
                    break
        if envelope is None:
            raise QepError(f"未找到可重发的报文: {msg_id}")
        if self.transport is not None and envelope.get("recipients"):
            self.transport.write(envelope, to=envelope["recipients"][0])
        return canonical_bytes(envelope)

    # --- 接收 -------------------------------------------------------------
    def inbox(self) -> list[dict]:
        if self.transport is None:
            return []
        return self.transport.pending(self.participant)

    def receive(self, message: Any) -> dict:
        raw, path = _coerce_message(message)
        try:
            envelope = json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            entry = self._reject("解析失败", errors=[f"{type(exc).__name__}: {exc}"], path=path)
            return {"duplicate": False, "received": False, "msg_id": None,
                    "errors": entry["errors"], "rejected": entry}

        msg_id = envelope.get("msg_id")
        if msg_id and msg_id in self._seen_msg_ids:
            attempt = self._duplicate_attempts.get(msg_id, 1) + 1
            self._duplicate_attempts[msg_id] = attempt
            ref = self.ledger.append(
                "kernel/qep-duplicate-dropped",
                {"msg_id": msg_id, "type": envelope.get("type"), "body_hash": envelope.get("body_hash"),
                 "attempt": attempt, "reason": "msg_id 已见"},
                correlation_id=envelope.get("correlation_id"), actor=self.participant,
                refs={"msg_id": msg_id})
            return {"duplicate": True, "received": False, "msg_id": msg_id,
                    "reason": "msg_id 已见", "dedup": "msg_id", "ledger_ref": ref.as_dict()}

        report = self.validate(envelope, require_signature=True)
        if report["ok"] and not self.verify(envelope):
            report = {"ok": False, "errors": ["签名验签失败（发送方未知或内容被改动）"], "errors_detail": report["errors"]}
        if not report["ok"]:
            entry = self._reject("校验失败", msg_id=msg_id, errors=report["errors"], path=path)
            return {"duplicate": False, "received": False, "msg_id": msg_id,
                    "errors": report["errors"], "rejected": entry}

        ref = self.ledger.append(
            envelope["type"], envelope["body"], correlation_id=envelope["correlation_id"],
            event_class=envelope["class"], actor=envelope["sender"]["participant_id"],
            refs={"msg_id": msg_id, "seq": envelope["seq"], "body_hash": envelope["body_hash"],
                  "path": str(path) if path else None})
        self._seen_msg_ids.add(msg_id)
        if ref.duplicate:
            attempt = self._duplicate_attempts.get(msg_id, 1) + 1
            self._duplicate_attempts[msg_id] = attempt
            self.ledger.append(
                "kernel/qep-duplicate-dropped",
                {"msg_id": msg_id, "type": envelope["type"], "body_hash": envelope["body_hash"],
                 "attempt": attempt, "reason": "账本去重键命中（同一事实的另一报文）"},
                correlation_id=envelope["correlation_id"], actor=self.participant, refs={"msg_id": msg_id})
            return {"duplicate": True, "received": False, "msg_id": msg_id,
                    "reason": "账本去重命中", "dedup": "ledger", "ledger_ref": ref.as_dict()}

        self.ledger.append(
            "kernel/qep-received",
            {"msg_id": msg_id, "from": envelope["sender"]["participant_id"], "type": envelope["type"],
             "body_hash": envelope["body_hash"], "seq": envelope["seq"]},
            correlation_id=envelope["correlation_id"], actor=self.participant, refs={"msg_id": msg_id})
        return {"duplicate": False, "received": True, "msg_id": msg_id, "type": envelope["type"],
                "class": envelope["class"], "body": copy.deepcopy(envelope["body"]),
                "ledger_ref": ref.as_dict()}

    # --- 内部 -------------------------------------------------------------
    def _reject(self, reason: str, *, errors: list[str], msg_id: str | None = None,
                path: Path | None = None) -> dict:
        entry = {"reason": reason, "errors": list(errors), "msg_id": msg_id,
                 "path": str(path) if path else None, "at": utc_now()}
        self.rejected_messages.append(entry)
        try:
            self.ledger.append("kernel/qep-rejected",
                               {"reason": reason, "errors": list(errors), "msg_id": msg_id,
                                "from": None, "attempt": len(self.rejected_messages)},
                               correlation_id=msg_id, actor=self.participant,
                               refs={"msg_id": msg_id} if msg_id else {})
        except Exception:  # noqa: BLE001 - 账本冻结等极端情况不掩盖原始拒绝
            pass
        if self.events is not None:
            self.events.emit("kernel/qep-rejected", entry)
        return entry
