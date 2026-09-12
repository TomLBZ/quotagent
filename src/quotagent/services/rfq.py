"""ctx.rfq 的 P0 实现（`04-services-catalog.md` §3 / `02-domain-model.md` §2.2）。

不变量：`rev` 只增；**已发布版本的任何字段不可原地修改**（改即 `rev+1`，且 amend 必须给出字段级 delta）；
已发布包必须有 `quote_by` 截止时间；清单条目的单位必须属于计量规则表；每个接口必须有唯一责任方。
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, NoReturn

from ..kernel.canon import digest, canonical_bytes
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now
from .measures import MeasureBook, UnitTable

PUBLISHED_EVENT = "rfq/published"
AMENDED_EVENT = "rfq/amended"


class RfqError(RuntimeError):
    """询价包错误。"""


class RfqValidationError(RfqError):
    """包定义校验失败（不得发布）。"""


class PublishedVersionImmutable(RfqError):
    """已发布版本不可原地修改（改即 rev+1）。"""


class RevisionNotFound(RfqError):
    """版本不存在。"""


def _freeze(obj: Any) -> Any:
    """递归只读视图：dict → MappingProxyType，list → tuple。"""
    if isinstance(obj, dict):
        return MappingProxyType({key: _freeze(value) for key, value in obj.items()})
    if isinstance(obj, (list, tuple)):
        return tuple(_freeze(item) for item in obj)
    return obj


def _flatten(prefix: str, value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            out.update(_flatten(f"{prefix}.{key}" if prefix else key, item))
        return out
    return {prefix: value}


def _get_path(obj: dict, path: str) -> Any:
    current: Any = obj
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_path(obj: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    current = obj
    for part in parts[:-1]:
        current = current.setdefault(part, {})
    current[parts[-1]] = value


class RfqService:
    """`ctx.rfq` 的默认 Provider。"""

    def __init__(self, *, ledger: Ledger | None = None, events: EventBus | None = None,
                 units: UnitTable | None = None, measures: MeasureBook | None = None,
                 actor: str = "agent:sourcing", name: str = "rfq") -> None:
        self.ledger = ledger
        self.events = events
        self.units = units or UnitTable()
        self.measures = measures or MeasureBook()
        self.actor = actor
        self.name = name
        self._draft: dict | None = None
        self._published: dict[int, dict] = {}
        self._hashes: dict[int, str] = {}
        self._texts: dict[int, str] = {}
        self._current_rev = 0

    # --- 草稿 -------------------------------------------------------------
    def create_package(self, spec: dict) -> dict:
        draft = {
            "package_id": spec.get("package_id"),
            "rev": 0,
            "status": "draft",
            "scope": list(spec.get("scope") or []),
            "interfaces": copy.deepcopy(spec.get("interfaces") or []),
            "items": copy.deepcopy(spec.get("items") or []),
            "deliverables": list(spec.get("deliverables") or []),
            "exclusions": list(spec.get("exclusions") or []),
            "measurement_rules": copy.deepcopy(spec.get("measurement_rules") or {}),
            "currency": spec.get("currency", "CNY"),
            "tax_code": spec.get("tax_code", "cn-vat-13"),
            "tax_mode": spec.get("tax_mode", "exclusive"),
            "payment_terms": copy.deepcopy(spec.get("payment_terms") or {}),
            "deadlines": copy.deepcopy(spec.get("deadlines") or {}),
            "attachments": copy.deepcopy(spec.get("attachments") or []),
            "created_at": utc_now(),
        }
        self._draft = draft
        return copy.deepcopy(draft)

    def draft(self) -> dict:
        if self._draft is None:
            raise RfqError("当前没有草稿（已发布版本只能通过 amend 修订）")
        return copy.deepcopy(self._draft)

    def add_items(self, items: list[dict]) -> dict:
        draft = self._require_draft()
        draft["items"].extend(copy.deepcopy(items))
        return copy.deepcopy(draft)

    def set_interfaces(self, interfaces: list[dict]) -> dict:
        draft = self._require_draft()
        draft["interfaces"] = copy.deepcopy(interfaces)
        return copy.deepcopy(draft)

    def update_draft(self, changes: dict) -> dict:
        draft = self._require_draft()
        for key, value in (changes.get("package") or {}).items():
            draft[key] = copy.deepcopy(value)
        for item_id, fields in (changes.get("items") or {}).items():
            item = self._find_item(draft, item_id)
            if item is None:
                raise RfqError(f"草稿中不存在条目 {item_id}")
            item.update(copy.deepcopy(fields))
        return copy.deepcopy(draft)

    # --- 校验 -------------------------------------------------------------
    def validate_of(self, spec: dict) -> dict:
        errors: list[str] = []
        if not spec.get("package_id"):
            errors.append("缺少 package_id")
        if not (spec.get("scope") or []):
            errors.append("scope 为空（包范围必须明确）")
        items = spec.get("items") or []
        if not items:
            errors.append("清单为空（至少一条 LineItem）")
        for item in items:
            item_id = item.get("item_id")
            if not item_id:
                errors.append("存在没有 item_id 的清单条目")
                continue
            unit = item.get("unit")
            if not unit:
                errors.append(f"清单条目 {item_id} 缺少 unit")
                continue
            rule = self.measures.for_item(item_id)
            if rule is None:
                errors.append(f"清单条目 {item_id} 缺计量规则（measurement_rule 未在计量规则表中定义）")
                continue
            if not rule.allows(unit) or not self.units.has(unit):
                errors.append(f"清单条目 {item_id} 的单位 {unit!r} 不在计量规则允许集合 "
                              f"{list(rule.allowed_units)} 内")
        for interface in spec.get("interfaces") or []:
            interface_id = interface.get("interface_id") or "<未命名接口>"
            owners = interface.get("responsible_parties")
            owner = interface.get("responsibility_party")
            if owners is not None and len(list(owners)) != 1:
                errors.append(f"接口 {interface_id} 的责任方不唯一: {list(owners)}"
                              f"（每个接口必须有唯一责任方）")
            elif not owner:
                errors.append(f"接口 {interface_id} 无唯一责任方（responsibility_party 为空）")
        if not (spec.get("deadlines") or {}).get("quote_by"):
            errors.append("缺少 deadlines.quote_by（已发布包必须有报价截止时间）")
        return {"ok": not errors, "errors": errors}

    def validate(self, rev: int | None = None) -> dict:
        if rev is None:
            spec = self._require_draft()
        else:
            spec = self._published_snapshot(rev)
        return self.validate_of(spec)

    # --- 发布与修订 -------------------------------------------------------
    def publish(self) -> dict:
        if self._draft is None:
            raise RfqError("没有可发布的草稿")
        report = self.validate_of(self._draft)
        if not report["ok"]:
            raise RfqValidationError("包定义校验失败，拒绝发布: " + "; ".join(report["errors"]))
        rev = self._current_rev + 1
        snapshot = copy.deepcopy(self._draft)
        snapshot["rev"] = rev
        snapshot["status"] = "published"
        snapshot["published_at"] = utc_now()
        self._store(rev, snapshot)
        self._current_rev = rev
        self._draft = None
        record = {"package_id": snapshot["package_id"], "rev": rev, "hash": self._hashes[rev],
                  "quote_by": snapshot["deadlines"].get("quote_by"),
                  "items": len(snapshot["items"]), "payload_bytes": len(self._texts[rev].encode("utf-8"))}
        if self.ledger is not None:
            self.ledger.append(PUBLISHED_EVENT, record, correlation_id=snapshot["package_id"],
                               actor=self.actor, refs={"package_id": snapshot["package_id"], "rfq_rev": rev})
        if self.events is not None:
            self.events.emit(PUBLISHED_EVENT, record)
        return {"rev": rev, "hash": self._hashes[rev], "published_at": snapshot["published_at"],
                "quote_by": record["quote_by"]}

    def amend(self, changes: dict) -> dict:
        if self._current_rev < 1:
            raise RfqError("amend 只能作用于已发布版本（当前还没有发布）")
        base_rev = self._current_rev
        base = self._published_snapshot(base_rev)
        updated = copy.deepcopy(base)
        deltas: list[dict] = []

        for path, value in _flatten("", changes.get("package") or {}).items():
            before = _get_path(updated, path)
            _set_path(updated, path, copy.deepcopy(value))
            deltas.append({"item_id": "package", "field": path, "before": before,
                           "after": copy.deepcopy(value)})

        item_changes = changes.get("items") or {}
        for key in ("add", "remove"):
            if key not in item_changes:
                continue
            if key == "add":
                for item in item_changes["add"]:
                    updated["items"].append(copy.deepcopy(item))
                    deltas.append({"item_id": item.get("item_id"), "field": "__added__",
                                   "before": None, "after": copy.deepcopy(item)})
            else:
                for item_id in item_changes["remove"]:
                    item = self._find_item(updated, item_id)
                    if item is None:
                        raise RfqError(f"要删除的条目不存在: {item_id}")
                    updated["items"].remove(item)
                    deltas.append({"item_id": item_id, "field": "__removed__",
                                   "before": copy.deepcopy(item), "after": None})
        for item_id, fields in item_changes.items():
            if item_id in ("add", "remove"):
                continue
            item = self._find_item(updated, item_id)
            if item is None:
                raise RfqError(f"要修改的条目不存在: {item_id}")
            for field, value in fields.items():
                before = item.get(field)
                item[field] = copy.deepcopy(value)
                deltas.append({"item_id": item_id, "field": field, "before": before,
                               "after": copy.deepcopy(value)})

        if not deltas:
            raise RfqError("amend 未包含任何变更（不得产生空版本）")
        report = self.validate_of(updated)
        if not report["ok"]:
            raise RfqValidationError("amend 后的包定义校验失败: " + "; ".join(report["errors"]))
        rev = base_rev + 1
        updated["rev"] = rev
        updated["status"] = "published"
        updated["published_at"] = utc_now()
        updated["amended_from"] = base_rev
        self._store(rev, updated)
        self._current_rev = rev
        record = {"package_id": updated["package_id"], "rev": rev, "from_rev": base_rev,
                  "deltas": deltas, "delta_count": len(deltas), "hash": self._hashes[rev]}
        if self.ledger is not None:
            self.ledger.append(AMENDED_EVENT, record, correlation_id=updated["package_id"],
                               actor=self.actor, refs={"package_id": updated["package_id"], "rfq_rev": rev})
        if self.events is not None:
            self.events.emit(AMENDED_EVENT, record)
        return {"rev": rev, "deltas": deltas, "hash": self._hashes[rev]}

    # --- 读取 -------------------------------------------------------------
    def revision(self, rev: int) -> MappingProxyType:
        return _freeze(self._published_snapshot(rev))

    def revisions(self) -> list[int]:
        return sorted(self._published)

    def current_rev(self) -> int:
        return self._current_rev

    def snapshot_hash(self, rev: int) -> str:
        self._published_snapshot(rev)
        return self._hashes[rev]

    def package_ref(self, rev: int | None = None) -> dict:
        """给消费者（如读包）用的可写副本；只暴露交换范围字段。"""
        snapshot = self._published_snapshot(rev if rev is not None else self._current_rev)
        return {"package_id": snapshot["package_id"], "rev": snapshot["rev"],
                "currency": snapshot["currency"], "tax_code": snapshot["tax_code"],
                "tax_mode": snapshot["tax_mode"], "deadlines": copy.deepcopy(snapshot["deadlines"]),
                "items": copy.deepcopy(snapshot["items"]),
                "interfaces": copy.deepcopy(snapshot["interfaces"])}

    def deltas(self, rev: int) -> list[dict]:
        snapshot = self._published_snapshot(rev)
        return copy.deepcopy(snapshot.get("deltas") or [])

    def modify_published(self, rev: int, *, field: str, value: Any,
                         item_id: str | None = None) -> NoReturn:
        self._published_snapshot(rev)
        target = f"条目 {item_id} 的" if item_id else "包级"
        raise PublishedVersionImmutable(
            f"已发布版本 (rev={rev}) 的{target}字段 {field!r} 不可原地修改："
            f"必须 amend 产生新版本（rev={self._current_rev + 1}），旧版本永久保留")

    def plugin_spec(self) -> dict:
        return {"name": self.name, "inject": [], "provide": {self.name: self}, "setup": None}

    # --- 内部 -------------------------------------------------------------
    def _store(self, rev: int, snapshot: dict) -> None:
        self._published[rev] = copy.deepcopy(snapshot)
        self._texts[rev] = canonical_bytes(snapshot).decode("utf-8")
        self._hashes[rev] = digest(snapshot)

    def _published_snapshot(self, rev: int) -> dict:
        if rev not in self._published:
            raise RevisionNotFound(f"版本不存在: rev={rev}（已有: {self.revisions()}）")
        return copy.deepcopy(self._published[rev])

    def _require_draft(self) -> dict:
        if self._draft is None:
            raise RfqError("当前没有草稿（已发布版本只能通过 amend 修订）")
        return self._draft

    @staticmethod
    def _find_item(spec: dict, item_id: str) -> dict | None:
        for item in spec.get("items") or []:
            if item.get("item_id") == item_id:
                return item
        return None
