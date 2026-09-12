"""ctx.costmodel 的 P0 实现（`04-services-catalog.md` §4）——成本构成（**私域，永不出 realm**）。

- 按条目与成本要素分解：材料 / 人工 / 机具 / 管理 / 风险 / 税 / 财务；
- 可解释：每个要素都能追溯到费率与基数（`explain`）；
- 私域：明细写入**本 realm 的私域存储**（按哈希引用），账本事件只带引用与哈希；
  跨 realm 读取（`read_view` / `private_store.get`）一律 `PrivateAccessDenied`（P5 / INV-008）。
"""

from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..kernel.canon import digest
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now

COST_BUILT_EVENT = "quote/cost-built"
ELEMENTS = ("material", "labour", "plant", "overhead", "risk", "tax", "finance")
DIRECT_ELEMENTS = ("material", "labour", "plant")
INDIRECT_PCT_KEYS = {"overhead": "overhead_pct", "risk": "risk_pct",
                     "finance": "finance_pct", "tax": "tax_pct"}
ELEMENT_LABELS = {"material": "材料", "labour": "人工", "plant": "机具", "overhead": "管理",
                  "risk": "风险", "tax": "税", "finance": "财务"}


class CostError(RuntimeError):
    """成本构成错误。"""


class PrivateAccessDenied(CostError):
    """跨 realm 访问私域数据（P5：私域永不出 realm）。"""


class CostLibrary:
    """成本要素费率库（私域；`01-architecture.md` §5 的行业模板/公司策略层）。"""

    def __init__(self, items: dict[str, dict] | None = None) -> None:
        self._items = {key: copy.deepcopy(value) for key, value in (items or {}).items()}

    def for_item(self, item_id: str) -> dict | None:
        return copy.deepcopy(self._items.get(item_id))

    def patch(self, items: dict[str, dict]) -> None:
        for key, value in items.items():
            self._items[key] = copy.deepcopy(value)

    def items(self) -> list[str]:
        return sorted(self._items)


class PrivateStore:
    """按 realm 归属的私域工件存储（文件 + 内存索引）；跨 realm 取件被拒。"""

    def __init__(self, root: str | os.PathLike) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._owner: dict[str, str] = {}

    def put(self, record: dict, *, realm: str) -> str:
        reference = digest(record)
        self._owner[reference] = realm
        path = self.root / f"{reference.replace(':', '_')}.json"
        path.write_text(json.dumps({"realm": realm, "record": record}, ensure_ascii=False,
                                   sort_keys=True), encoding="utf-8")
        return reference

    def get(self, reference: str, *, realm: str) -> dict:
        owner = self._owner.get(reference)
        if owner is None:
            path = self.root / f"{reference.replace(':', '_')}.json"
            if path.exists():
                payload = json.loads(path.read_text(encoding="utf-8"))
                owner = payload.get("realm")
                self._owner[reference] = owner or ""
        if owner is None:
            raise CostError(f"未知的私域工件引用: {reference}")
        if owner != realm:
            raise PrivateAccessDenied(
                f"私域工件 {reference} 属于 {owner!r}，{realm!r} 无权读取（P5：私域永不出 realm）")
        path = self.root / f"{reference.replace(':', '_')}.json"
        return copy.deepcopy(json.loads(path.read_text(encoding="utf-8"))["record"])

    def refs(self) -> list[str]:
        return sorted(self._owner)


@dataclass
class CostModelService:
    """`ctx.costmodel` 的默认 Provider（供应商侧私域服务）。"""

    realm: str
    library: CostLibrary = field(default_factory=CostLibrary)
    ledger: Ledger | None = None
    events: EventBus | None = None
    store_root: str | os.PathLike | None = None
    actor: str = "agent:cost"
    private_store: PrivateStore = field(init=False)
    _models: dict[str, dict] = field(default_factory=dict, init=False)
    _current: str | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        root = self.store_root or Path(f"private-{self.realm.replace(':', '_')}")
        object.__setattr__(self, "private_store", PrivateStore(root))

    # --- 构建 -------------------------------------------------------------
    def build(self, items: list[dict], *, quote_id: str | None = None,
              library: CostLibrary | None = None) -> dict:
        book = library or self.library
        built_items: dict[str, dict] = {}
        for item in items:
            item_id = item["item_id"]
            rates = book.for_item(item_id)
            if rates is None:
                raise CostError(f"条目 {item_id} 缺成本费率（不得猜测成本）")
            qty = float(item.get("qty", 0))
            elements: dict[str, dict] = {}
            direct = 0.0
            for element in DIRECT_ELEMENTS:
                rate = rates.get(element)
                if rate is None:
                    continue
                amount = float(rate["unit_rate"]) * qty
                direct += amount
                elements[element] = {
                    "amount": amount, "unit": rate.get("unit", item.get("unit")),
                    "factors": {"unit_rate": float(rate["unit_rate"]), "qty": qty,
                                "element": element, "label": ELEMENT_LABELS[element]},
                }
            subtotal = direct
            for element, pct_key in INDIRECT_PCT_KEYS.items():
                pct = float(rates.get(pct_key, 0.0))
                if element == "tax":
                    base = subtotal + elements.get("risk", {}).get("amount", 0.0) \
                        + elements.get("finance", {}).get("amount", 0.0)
                elif element in ("risk", "finance"):
                    base = subtotal
                else:
                    base = direct
                amount = base * pct / 100.0
                elements[element] = {
                    "amount": amount, "pct": pct,
                    "factors": {"base": base, "pct": pct, "element": element,
                                "label": ELEMENT_LABELS[element]},
                }
                if element == "overhead":
                    subtotal = direct + amount
            pre_tax = sum(v["amount"] for k, v in elements.items() if k != "tax")
            incl_tax = pre_tax + elements.get("tax", {}).get("amount", 0.0)
            built_items[item_id] = {
                "item_id": item_id, "qty": qty, "unit": item.get("unit"),
                "elements": elements, "total_excl_tax": pre_tax, "total_incl_tax": incl_tax,
                "unit_cost_excl_tax": pre_tax / qty if qty else None,
                "unit_cost_incl_tax": incl_tax / qty if qty else None,
            }
        total_excl = sum(v["total_excl_tax"] for v in built_items.values())
        total_incl = sum(v["total_incl_tax"] for v in built_items.values())
        model = {
            "realm": self.realm, "quote_id": quote_id, "built_at": utc_now(),
            "items": built_items, "total_excl_tax": total_excl, "total_incl_tax": total_incl,
        }
        reference = self.private_store.put(model, realm=self.realm)
        model["artifact_hash"] = reference
        key = quote_id or reference
        self._models[key] = model
        self._current = key
        if self.ledger is not None:
            self.ledger.append(
                COST_BUILT_EVENT,
                {"realm": self.realm, "quote_id": quote_id, "items": sorted(built_items),
                 "elements": sorted({element for v in built_items.values() for element in v["elements"]}),
                 "total_excl_tax": total_excl, "total_incl_tax": total_incl,
                 "artifact_hash": reference,
                 "artifact_note": "私域明细在 realm 私域存储中，账本只带哈希引用（rule 2 / P4）"},
                correlation_id=quote_id or reference, actor=self.actor,
                refs={"quote_id": quote_id} if quote_id else {})
        if self.events is not None:
            self.events.emit(COST_BUILT_EVENT, {"realm": self.realm, "quote_id": quote_id,
                                                "artifact_hash": reference})
        return copy.deepcopy(model)

    # --- 查询 -------------------------------------------------------------
    def _model(self, key: str | None = None) -> dict:
        target = key or self._current
        if target is None or target not in self._models:
            raise CostError(f"没有可用的成本构成（key={target!r}）")
        return self._models[target]

    def unit_cost(self, item_id: str, *, quote_id: str | None = None) -> dict:
        model = self._model(quote_id)
        item = model["items"].get(item_id)
        if item is None:
            raise CostError(f"成本构成里没有条目 {item_id}")
        return {"item_id": item_id, "excl_tax": item["unit_cost_excl_tax"],
                "incl_tax": item["unit_cost_incl_tax"],
                "total_excl_tax": item["total_excl_tax"], "total_incl_tax": item["total_incl_tax"],
                "currency": "CNY"}

    def explain(self, quote_id: str, item_id: str) -> list[dict]:
        model = self._model(quote_id)
        item = model["items"].get(item_id)
        if item is None:
            raise CostError(f"成本构成里没有条目 {item_id}")
        return [{"element": element, "label": data["factors"].get("label", element),
                 "amount": data["amount"], "factors": dict(data["factors"])}
                for element, data in item["elements"].items()]

    def read_view(self, realm: str) -> dict:
        """只有本 realm 能读完整私域形态；对方 realm 一律拒绝（P5）。"""
        if realm != self.realm:
            raise PrivateAccessDenied(
                f"成本构成属于 {self.realm!r}，{realm!r} 不得读取（FR-COST-002 / P5：永不出 realm）")
        return copy.deepcopy(self._model())

    def as_dict(self) -> dict:
        return self.read_view(self.realm)

    def artifacts(self) -> list[str]:
        return self.private_store.refs()
