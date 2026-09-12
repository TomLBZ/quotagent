"""ctx.ledger 的 P0 实现（`docs/design/04-services-catalog.md` §1）。

形态：append-only 的 `ledger.jsonl`，每行一个 canonical JSON 事件记录。
哈希链：`entry_hash = sha256(canonical(记录去掉 entry_hash))`，`prev_hash` 指向前一条的 `entry_hash`。
去重：同一 `(correlation_id, type, body_hash)` 不产生第二条事实（FR-LEDGER-004）。
停发：启动与每次追加后校验哈希链；校验失败即冻结（拒绝继续追加），对外发送路径必须查 `healthy`（FR-LEDGER-003）。

记录字段与哈希公式见 `docs/design/adr/0007-p0-runtime-and-ledger-format.md`。
"""

from __future__ import annotations

import copy
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .canon import ZERO_HASH, canonical_bytes, canonical_json, digest, is_hash

EVENT_CLASSES = ("fact", "intent", "commitment")
DEDUP_FIELDS = ("correlation_id", "type", "body_hash")


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class LedgerError(RuntimeError):
    """账本错误基类。"""


class LedgerIntegrityError(LedgerError):
    """哈希链校验失败。"""


class LedgerFrozenError(LedgerIntegrityError):
    """校验失败后的冻结账本：拒绝追加，停止对外发送（FR-LEDGER-003）。"""


@dataclass(frozen=True)
class LedgerRef:
    seq: int
    entry_hash: str
    duplicate: bool = False

    def as_dict(self) -> dict:
        return {"seq": self.seq, "entry_hash": self.entry_hash, "duplicate": self.duplicate}


def entry_hash_of(record: dict) -> str:
    return digest({k: v for k, v in record.items() if k != "entry_hash"})


def _reduce_index(state: dict, rec: dict) -> dict:
    state["count"] += 1
    state["last_seq"] = rec["seq"]
    state["head_hash"] = rec["entry_hash"]
    return state


def _reduce_types(state: dict, rec: dict) -> dict:
    types = state.setdefault("by_type", {})
    types[rec["type"]] = types.get(rec["type"], 0) + 1
    state["count"] += 1
    return state


def _reduce_commitments(state: dict, rec: dict) -> dict:
    state["count"] += 1
    if rec["class"] == "commitment":
        state.setdefault("commitments", []).append(
            {"seq": rec["seq"], "type": rec["type"], "correlation_id": rec["correlation_id"],
             "approvals": rec["body"].get("approvals", []) if isinstance(rec["body"], dict) else []}
        )
    return state


def _new_state(view: str) -> dict:
    if view == "index":
        return {"count": 0, "last_seq": 0, "head_hash": ZERO_HASH}
    if view == "types":
        return {"count": 0, "by_type": {}}
    if view == "commitments":
        return {"count": 0, "commitments": []}
    raise LedgerError(f"未知投影 view={view!r}；已注册: index, types, commitments")


REDUCERS: dict[str, Callable[[dict, dict], dict]] = {
    "index": _reduce_index,
    "types": _reduce_types,
    "commitments": _reduce_commitments,
}


class Ledger:
    """文件账本。`read()` 返回副本，外部拿到的事件不可改写内部状态（事件一经追加不可修改）。"""

    def __init__(self, path: str | os.PathLike, realm: str = "local",
                 *, verify_on_open: bool = True, fsync: bool = True) -> None:
        self.path = Path(path)
        self.realm = realm
        self._fsync = fsync
        self._frozen = False
        self.open_failure: dict | None = None
        self._records: list[dict] = []
        self._malformed: list[dict] = []
        self._dedup: dict[tuple, int] = {}
        self._append_hooks: list[Callable[[dict], None]] = []
        self._events = None
        self._inc: dict[str, dict] = {view: _new_state(view) for view in REDUCERS}
        self._load()
        if verify_on_open:
            report = self.verify_report()
            if not report["ok"]:
                self._frozen = True
                self.open_failure = report

    # --- 观测挂接（`kernel/ledger-appended` 是 live 事件，不进账本） --------
    def attach_events(self, bus) -> None:
        self._events = bus

    def on_append(self, callback: Callable[[dict], None]) -> Callable[[], None]:
        """订阅追加通知；返回 disposer（订阅也是 effect，卸载后不得残留）。"""
        self._append_hooks.append(callback)

        def dispose() -> None:
            try:
                self._append_hooks.remove(callback)
            except ValueError:
                pass

        return dispose

    def append_hook_count(self) -> int:
        return len(self._append_hooks)

    # --- 只读属性 ---------------------------------------------------------
    @property
    def frozen(self) -> bool:
        return self._frozen

    @property
    def healthy(self) -> bool:
        return not self._frozen

    @property
    def count(self) -> int:
        return len(self._records)

    @property
    def head_hash(self) -> str:
        return self._records[-1]["entry_hash"] if self._records else ZERO_HASH

    @property
    def last_ref(self) -> LedgerRef | None:
        return LedgerRef(self._records[-1]["seq"], self._records[-1]["entry_hash"]) if self._records else None

    # --- 写入口（唯一） ---------------------------------------------------
    def append(self, type: str, body: dict, *, correlation_id: str | None = None,
               event_class: str = "fact", actor: str = "agent:local",
               refs: dict | None = None, ts: str | None = None) -> LedgerRef:
        if self._frozen:
            raise LedgerFrozenError(
                f"账本已冻结（哈希链校验失败: seq {self.open_failure and self.open_failure.get('first_bad_seq')}）：拒绝追加、停止对外发送")
        if event_class not in EVENT_CLASSES:
            raise LedgerError(f"非法 event_class={event_class!r}；取值: {EVENT_CLASSES}")
        hit = self._dedup_hit(correlation_id, type, body)
        if hit is not None:
            return LedgerRef(hit["seq"], hit["entry_hash"], duplicate=True)

        record = {
            "seq": len(self._records) + 1,
            "ts": ts or utc_now(),
            "realm": self.realm,
            "type": type,
            "class": event_class,
            "correlation_id": correlation_id,
            "actor": actor,
            "refs": refs or {},
            "body": copy.deepcopy(body),
        }
        record["body_hash"] = digest(record["body"])
        record["prev_hash"] = self.head_hash
        record["entry_hash"] = entry_hash_of(record)

        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = canonical_json(record)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
            fh.flush()
            if self._fsync:
                os.fsync(fh.fileno())

        self._records.append(record)
        self._dedup[self._dedup_key(record)] = record["seq"]
        for view, reducer in REDUCERS.items():
            self._inc[view] = reducer(self._inc[view], copy.deepcopy(record))

        report = self.verify_report(from_seq=max(1, record["seq"] - 1))
        if not report["ok"]:
            self._frozen = True
            raise LedgerIntegrityError(f"追加后哈希链校验失败: {report}")
        for hook in list(self._append_hooks):
            hook({"seq": record["seq"], "type": record["type"], "entry_hash": record["entry_hash"]})
        if self._events is not None:
            self._events.emit("kernel/ledger-appended",
                              {"seq": record["seq"], "type": record["type"],
                               "entry_hash": record["entry_hash"], "realm": record["realm"]})
        return LedgerRef(record["seq"], record["entry_hash"])

    def assert_healthy(self) -> None:
        """对外发送路径的前置检查（FR-LEDGER-003：失败即停发）。"""
        if self._frozen:
            raise LedgerFrozenError("账本冻结：停止对外发送")

    # --- 读 ---------------------------------------------------------------
    def read(self, *, type: str | None = None, from_seq: int = 1, to_seq: int | None = None,
             correlation_id: str | None = None, event_class: str | None = None,
             predicate: Callable[[dict], bool] | None = None) -> list[dict]:
        out = []
        for rec in self._records:
            if rec["seq"] < from_seq:
                continue
            if to_seq is not None and rec["seq"] > to_seq:
                continue
            if type is not None and rec["type"] != type:
                continue
            if correlation_id is not None and rec["correlation_id"] != correlation_id:
                continue
            if event_class is not None and rec["class"] != event_class:
                continue
            if predicate is not None and not predicate(rec):
                continue
            out.append(copy.deepcopy(rec))
        return out

    def get(self, seq: int) -> dict:
        if seq < 1 or seq > self.count:
            raise LedgerError(f"seq {seq} 不存在（当前 {self.count} 条）")
        return copy.deepcopy(self._records[seq - 1])

    def find(self, *, correlation_id: str | None = None, type: str | None = None,
             body: dict | None = None) -> dict | None:
        seq = self._dedup.get((correlation_id, type, digest(body) if body is not None else None))
        return None if seq is None else self.get(seq)

    # --- 投影（FR-LEDGER-002） -------------------------------------------
    def project(self, view: str = "index", *, from_seq: int = 1, to_seq: int | None = None) -> dict:
        """从账本**全量重建**投影（任意时点：from_seq/to_seq）。"""
        state = _new_state(view)
        for rec in self.read(from_seq=from_seq, to_seq=to_seq):
            state = REDUCERS[view](state, rec)
        return state

    def incremental(self, view: str = "index") -> dict:
        """追加时增量维护的同一投影（用于与全量重建比对）。"""
        return copy.deepcopy(self._inc[view])

    # --- 校验 -------------------------------------------------------------
    def verify_report(self, from_seq: int = 1) -> dict:
        report = {"ok": True, "checked": 0, "first_bad_seq": None, "reason": "",
                  "head_hash": self.head_hash, "count": self.count}
        if self._malformed and from_seq <= self._malformed[0]["line"]:
            report.update(ok=False, first_bad_seq=self._malformed[0]["line"],
                          reason=f"记录不是合法 JSON: {self._malformed[0]['error']}")
            return report
        expected_prev = ZERO_HASH if from_seq <= 1 else self._records[from_seq - 2]["entry_hash"]
        for rec in self._records[from_seq - 1:]:
            report["checked"] += 1
            if rec["seq"] != report["checked"] + from_seq - 1:
                report.update(ok=False, first_bad_seq=rec["seq"], reason="seq 不连续")
                return report
            if rec["prev_hash"] != expected_prev:
                report.update(ok=False, first_bad_seq=rec["seq"], reason="prev_hash 与前一条 entry_hash 不一致")
                return report
            if digest(rec["body"]) != rec["body_hash"]:
                report.update(ok=False, first_bad_seq=rec["seq"], reason="body_hash 与 body 不一致（内容被篡改）")
                return report
            if entry_hash_of(rec) != rec["entry_hash"]:
                report.update(ok=False, first_bad_seq=rec["seq"], reason="entry_hash 与记录内容不一致（记录被篡改）")
                return report
            expected_prev = rec["entry_hash"]
        return report

    def verify_chain(self, from_seq: int = 1) -> bool:
        return bool(self.verify_report(from_seq=from_seq)["ok"])

    # --- 内部 -------------------------------------------------------------
    def _dedup_key(self, record: dict) -> tuple:
        return (record["correlation_id"], record["type"], record["body_hash"])

    def _dedup_hit(self, correlation_id: str | None, type: str, body: dict) -> dict | None:
        seq = self._dedup.get((correlation_id, type, digest(body)))
        return None if seq is None else self._records[seq - 1]

    def _load(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()
            return
        with open(self.path, "r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError as exc:
                    self._malformed.append({"line": lineno, "error": str(exc)})
                    continue
                if not is_hash(rec.get("entry_hash")) or not is_hash(rec.get("prev_hash")):
                    self._malformed.append({"line": lineno, "error": "entry_hash/prev_hash 缺失或格式错误"})
                    continue
                self._records.append(rec)
        for rec in self._records:
            self._dedup[self._dedup_key(rec)] = rec["seq"]
            for view, reducer in REDUCERS.items():
                self._inc[view] = reducer(self._inc[view], copy.deepcopy(rec))

    def __repr__(self) -> str:  # pragma: no cover - 便于排障
        return f"<Ledger {self.path} realm={self.realm} count={self.count} frozen={self._frozen}>"
