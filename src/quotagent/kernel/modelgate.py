"""模型调用门（P0 最小）：模型可见 ⟺ 账本可见（`AGENTS.md` 规则 2 / P4）。

每次模型调用前把**完整输入**写入账本事件 `kernel/model-call`，提供方边界独立记录它实际收到的输入。
`rebuild_inputs()` 只读账本重建输入，与观测输入逐字节比对 —— 任何未落账却进入模型的输入都会被检出
（AC-AUDIT-002）。P1 的完整形态见 `docs/design/04-services-catalog.md` §2 `ctx.evidence.rebuild`（T-208）。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Protocol

from .canon import canonical_json, digest
from .ledger import Ledger, LedgerRef


class ModelProvider(Protocol):
    name: str

    def complete(self, inputs: dict) -> dict:  # pragma: no cover - 协议声明
        ...


@dataclass
class ModelReply:
    call_id: str
    seq: int
    output: dict
    inputs_hash: str

    def as_dict(self) -> dict:
        return {"call_id": self.call_id, "seq": self.seq, "inputs_hash": self.inputs_hash,
                "output": self.output}


class DeterministicModelProvider:
    """P0 的确定性模型替身：同输入同输出，且在自己的边界记录收到的输入（独立观测点）。"""

    name = "model.deterministic-echo@0.1.0"

    def __init__(self) -> None:
        self.received: list[dict] = []

    def complete(self, inputs: dict) -> dict:
        observed = copy.deepcopy(inputs)
        self.received.append(observed)
        text = "\n".join(f"{m.get('role')}: {m.get('content')}" for m in observed.get("messages", []))
        return {
            "text": text,
            "provider": self.name,
            "observed_inputs_hash": digest(observed),
        }


class ModelGateway:
    """记录每次模型调用的输入与输出；`inject_unlogged` 用于负控（验证检测非空转）。"""

    def __init__(self, ledger: Ledger, provider: ModelProvider | None = None, *,
                 inject_unlogged: bool = False) -> None:
        self.ledger = ledger
        self.provider = provider or DeterministicModelProvider()
        self.inject_unlogged = inject_unlogged
        self._observed: dict[str, dict] = {}

    def call(self, *, step: str, messages: list[dict], params: dict | None = None,
             agent_id: str = "agent:local", correlation_id: str | None = None) -> ModelReply:
        inputs = {"step": step, "agent_id": agent_id, "params": params or {}, "messages": messages}
        ref: LedgerRef = self.ledger.append(
            "kernel/model-call",
            dict(inputs, inputs_hash=digest(inputs)),
            correlation_id=correlation_id or step,
            actor=agent_id,
            refs={"step": step},
        )
        call_id = f"model-call:{ref.seq}"
        actually_sent = copy.deepcopy(inputs)
        if self.inject_unlogged:
            actually_sent["messages"] = list(actually_sent["messages"]) + [
                {"role": "system", "content": "未落账的注入内容"}
            ]
        output = self.provider.complete(actually_sent)
        self._observed[call_id] = copy.deepcopy(getattr(self.provider, "received", [])[-1])
        self.ledger.append(
            "kernel/model-replied",
            {"call": call_id, "call_seq": ref.seq, "output": output},
            correlation_id=correlation_id or step,
            actor=agent_id,
            refs={"call_seq": ref.seq},
        )
        return ModelReply(call_id=call_id, seq=ref.seq, output=output, inputs_hash=digest(inputs))

    # --- 重建与比对 -------------------------------------------------------
    def rebuild_inputs(self, call_id: str) -> dict:
        """只读账本重建该次调用的输入（不含记录的 inputs_hash 字段本身）。"""
        seq = _seq_of(call_id)
        record = self.ledger.get(seq)
        if record["type"] != "kernel/model-call":
            raise ValueError(f"{call_id} 对应的账本事件类型是 {record['type']!r}")
        body = copy.deepcopy(record["body"])
        body.pop("inputs_hash", None)
        return body

    def observed_inputs(self, call_id: str) -> dict:
        """提供方边界观测到的输入。"""
        if call_id not in self._observed:
            raise KeyError(f"无观测记录: {call_id}")
        return copy.deepcopy(self._observed[call_id])

    def rebuild_matches(self, call_id: str) -> dict:
        rebuilt = self.rebuild_inputs(call_id)
        observed = self.observed_inputs(call_id)
        return {
            "call_id": call_id,
            "equal": canonical_json(rebuilt) == canonical_json(observed),
            "rebuilt_hash": digest(rebuilt),
            "observed_hash": digest(observed),
        }

    def model_call_seqs(self) -> list[int]:
        return [rec["seq"] for rec in self.ledger.read(type="kernel/model-call")]


def _seq_of(call_id: str) -> int:
    prefix, _, tail = call_id.partition(":")
    if prefix != "model-call" or not tail.isdigit():
        raise ValueError(f"非法 call_id: {call_id!r}")
    return int(tail)
