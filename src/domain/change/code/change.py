"""services/change.py —— 变更闭环与生效版本（T-212 / FR-CHANGE-001/002）。

规格来源：
- `03-exchange-protocol.md` §报文表：`change/proposed`（intent，`ref_quote_lines[]` + `delta` + `basis_unit_price_ref`）、
  `change/priced`、`change/approved`（commitment，`change_id` + `delta_amount` + `approved_by`）；
  表注写明「**定价必须引用原报价单价**」。
- FR-CHANGE-001（must）：变更请求必须引用原报价条目与单价基准，**缺引用即拒绝**。
- FR-CHANGE-002（must）：变更定价与差额重算；**人工批准后生效**（未批准不影响任何金额）。

实现口径：
- 引用必须**可验证**：`ref_line` 要在原报价里存在；`basis_unit_price_ref` 必须指向该条目的单价基准；
  若同时给出 `basis_unit_price`（提议者所用的基准值），它必须与原报价一致——不一致即 `basis-mismatch`
  （防止用过期基准算差额，这是"引用"真正要防的事）。
- 差额逐行可复算：`(new_qty×new_price) − (old_qty×old_price)`，其中 `new_price` 缺省取原单价（即只改量不改价）。
- 生效只能经由人工门（`approvals.require(scope="change.approve", ref=change_id)` 且 `approved_by` 为 `human:*`）；
  未批准的变更在 `effective_total()` 里**一分钱都不计**（对抗性断言）。
"""
from __future__ import annotations

from typing import Any

from ..kernel.ledger import Ledger, utc_now
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger

PROPOSED_EVENT = "change/proposed"
PRICED_EVENT = "change/priced"
APPROVED_EVENT = "change/approved"
REJECTED_EVENT = "change/rejected"
APPROVAL_SCOPE = "change.approve"

REJECT_CODES = ("missing-line-ref", "missing-basis-ref", "unknown-line", "basis-mismatch",
                "empty-delta", "not-priced", "already-aborted")


class ChangeError(ValueError):
    """变更请求不合法（含拒绝码）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code


class ChangeService:
    def __init__(self, *, ledger: Ledger | None = None, events: EventBus | None = None,
                 approvals: Any = None, actor: str = "agent:planner") -> None:
        self.ledger = ledger
        self.events = events
        self.approvals = approvals
        self.actor = actor
        self._changes: dict[str, dict] = {}

    # --- 提出变更（FR-CHANGE-001） -----------------------------------------
    def propose(self, quote: dict, deltas: list[dict], *, change_id: str | None = None,
                reason: str = "") -> dict:
        if not deltas:
            raise self._reject("empty-delta", "变更请求至少要给一条 delta", change_id, quote)
        lines = {str(line.get("item_id")): line for line in quote.get("lines") or []}
        quote_id = str(quote.get("quote_id") or "")
        priced: list[dict] = []
        for delta in deltas:
            line_id = str(delta.get("ref_line") or "")
            if not line_id:
                raise self._reject("missing-line-ref", "delta 缺 ref_line（必须引用原报价条目）",
                                   change_id, quote)
            basis_ref = str(delta.get("basis_unit_price_ref") or "")
            if not basis_ref:
                raise self._reject("missing-basis-ref", "delta 缺 basis_unit_price_ref（必须引用单价基准）",
                                   change_id, quote)
            if line_id not in lines:
                raise self._reject("unknown-line", f"原报价 {quote_id} 没有条目 {line_id}",
                                   change_id, quote)
            source = lines[line_id]
            old_qty = float(source.get("qty") or 0)
            old_price = float(source.get("unit_price") or 0)
            expected_ref = f"{quote_id}#{line_id}:unit_price"
            if basis_ref != expected_ref:
                raise self._reject("basis-mismatch",
                                   f"单价基准引用指向 {basis_ref!r}，本报价该条目的基准应为 {expected_ref!r}",
                                   change_id, quote)
            claimed = delta.get("basis_unit_price")
            if claimed is not None and float(claimed) != old_price:
                raise self._reject("basis-mismatch",
                                   f"提议采用的基准单价 {float(claimed):g} 与本报价 {line_id} 的 {old_price:g} 不一致"
                                   f"（基准可能已过期）", change_id, quote)
            new_qty = float(delta.get("new_qty", old_qty))
            new_price = float(delta.get("new_unit_price", old_price))
            line_delta = round(new_qty * new_price - old_qty * old_price, 6)
            priced.append({"ref_line": line_id, "basis_unit_price_ref": basis_ref,
                           "basis_unit_price": old_price, "old_qty": old_qty, "new_qty": new_qty,
                           "old_unit_price": old_price, "new_unit_price": new_price,
                           "line_delta": line_delta})
        record = {"change_id": change_id or f"chg-{len(self._changes) + 1:04d}",
                  "quote_id": quote_id, "rfq_rev": quote.get("rfq_rev"), "reason": reason,
                  "ref_quote_lines": [item["ref_line"] for item in priced],
                  # 恒为列表（单行也是单元素列表）：字段语义单一，避免"单行给字符串、多行给列表"的歧义
                  "basis_unit_price_refs": sorted(item["basis_unit_price_ref"] for item in priced),
                  "basis_unit_price_ref": priced[0]["basis_unit_price_ref"],
                  "lines": priced,
                  "delta_amount": round(sum(item["line_delta"] for item in priced), 6),
                  "status": "proposed", "actor": self.actor, "proposed_at": utc_now(),
                  "approved_by": None, "approved_at": None, "approval_id": None}
        self._changes[record["change_id"]] = record
        self._emit(PROPOSED_EVENT, {"change_id": record["change_id"], "quote_id": quote_id,
                                    "ref_quote_lines": record["ref_quote_lines"],
                                    "basis_unit_price_ref": record["basis_unit_price_ref"],
                                    "basis_unit_price_refs": record["basis_unit_price_refs"],
                                    "delta": [{"ref_line": item["ref_line"], "old_qty": item["old_qty"],
                                               "new_qty": item["new_qty"], "new_unit_price": item["new_unit_price"]}
                                              for item in priced],
                                    "reason": reason,
                                    "note": "变更议题（intent）：未批准前不影响任何金额"})
        self._emit(PRICED_EVENT, {"change_id": record["change_id"], "quote_id": quote_id,
                                  "delta_amount": record["delta_amount"], "lines": priced,
                                  "basis": "原报价单价（03 §报文表：定价必须引用原报价单价）"})
        return record

    # --- 复算（FR-CHANGE-002） ---------------------------------------------
    def recompute(self, change_id: str, quote: dict | None = None) -> dict:
        record = self.get(change_id)
        lines = []
        for item in record["lines"]:
            source = None
            if quote is not None:
                source = next((line for line in quote.get("lines") or []
                               if str(line.get("item_id")) == item["ref_line"]), None)
            basis = float(item["basis_unit_price"])
            if source is not None:
                basis = float(source.get("unit_price") or 0)
                if basis != float(item["basis_unit_price"]):
                    raise ChangeError("basis-mismatch",
                                      f"复算时 {item['ref_line']} 的单价 {basis:g} 与变更基准 "
                                      f"{float(item['basis_unit_price']):g} 不一致")
            recomputed = round(float(item["new_qty"]) * float(item["new_unit_price"])
                               - float(item["old_qty"]) * basis, 6)
            lines.append({**item, "recomputed_line_delta": recomputed,
                          "reproducible": recomputed == item["line_delta"]})
        total = round(sum(item["recomputed_line_delta"] for item in lines), 6)
        return {"change_id": change_id, "quote_id": record["quote_id"], "lines": lines,
                "delta_amount": total, "reproducible": total == record["delta_amount"] and
                all(item["reproducible"] for item in lines),
                "basis": "逐行按原报价单价复算（与提议时的差额逐行比对）"}

    # --- 批准生效（FR-CHANGE-002） -----------------------------------------
    def approve(self, change_id: str, *, approved_by: str, approval_id: str | None = None) -> dict:
        record = self.get(change_id)
        if record["status"] == "approved":
            return record  # 幂等：重复批准不重复落账
        if not str(approved_by).startswith("human:"):
            raise ChangeError("approval-by-non-human",
                              f"变更只能由人批准（收到 approved_by={approved_by!r}）")
        if self.approvals is None:
            raise ChangeError("no-approval-gate", "未接人工门：变更不得生效")
        self.approvals.require(scope=APPROVAL_SCOPE, ref=change_id, approval_id=approval_id)
        record.update({"status": "approved", "approved_by": approved_by,
                       "approval_id": approval_id, "approved_at": utc_now()})
        self._emit(APPROVED_EVENT, {"change_id": change_id, "quote_id": record["quote_id"],
                                    "delta_amount": record["delta_amount"],
                                    "approved_by": approved_by, "approval_id": approval_id,
                                    "note": "变更生效（commitment）：此后计入金额"})
        return record

    def effective_total(self, quote: dict, *, changes: list[str] | None = None) -> dict:
        """报价总额 + **已批准**变更差额；未批准的一分钱都不计（FR-CHANGE-002）。"""
        base = round(sum(float(line.get("qty") or 0) * float(line.get("unit_price") or 0)
                         for line in quote.get("lines") or []), 6)
        approved = 0.0
        applied: list[str] = []
        pending: list[str] = []
        for record in self._changes.values():
            if record["quote_id"] != str(quote.get("quote_id") or ""):
                continue
            if changes and record["change_id"] not in changes:
                continue
            if record["status"] == "approved":
                approved += float(record["delta_amount"])
                applied.append(record["change_id"])
            else:
                pending.append(record["change_id"])
        return {"quote_id": quote.get("quote_id"), "base_amount": base,
                "approved_delta": round(approved, 6),
                "effective_amount": round(base + approved, 6),
                "applied_changes": applied, "pending_changes": pending,
                "note": "pending_changes 不计入金额（未经批准的变更不影响任何金额）"}

    # --- 查询与内部 -------------------------------------------------------
    def get(self, change_id: str) -> dict:
        if change_id not in self._changes:
            raise ChangeError("unknown-change", f"未登记的变更: {change_id}")
        return self._changes[change_id]

    def list(self, *, status: str | None = None) -> list[dict]:
        return [record for record in self._changes.values()
                if status is None or record["status"] == status]

    def _reject(self, code: str, message: str, change_id: str | None, quote: dict) -> ChangeError:
        error = ChangeError(code, message)
        self._emit(REJECTED_EVENT, {"change_id": change_id, "quote_id": quote.get("quote_id"),
                                    "code": code, "reason": message, "actor": self.actor,
                                    "note": "缺引用/引用不可验证即拒绝（FR-CHANGE-001）"})
        return error

    def _emit(self, event: str, body: dict) -> None:
        if self.ledger is not None:
            self.ledger.append(event, body, correlation_id=body.get("change_id"))
        if self.events is not None:
            self.events.dispatch(event, body)
