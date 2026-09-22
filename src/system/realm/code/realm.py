"""领域分级与 realm 过滤（`08-trust-and-security.md` §2/§3，INV-008）。

**realm 是命名空间语义，不是安全边界**（`08` §2）——真正的隔离来自进程与密钥。这里实现的是
"数据根本不出现在对方视图/对方模型输入里"的**投影规则**：

- 分类（字段族级）：`public` / `exchange` / `private-contractor` / `private-supplier` / `regulated`；
- 对方视图（peer view）：只保留 public/exchange（+ 目标 realm 自己的私域与 regulated）；
- 本侧模型输入（model context）：保留本侧私域，**丢掉对方私域与全部 regulated**（`08` §3 数据分类表）；
- 出站守卫（assert_clean）：载荷里出现私域/regulated 字段即抛 `PrivateLeak`（`08` §3 规则 2）。

未分类字段被显式记录（`unclassified_paths()`），不会静默按公开字段外发。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

PUBLIC = "public"
EXCHANGE = "exchange"
PRIVATE_CONTRACTOR = "private-contractor"
PRIVATE_SUPPLIER = "private-supplier"
REGULATED = "regulated"

CLASSES = (PUBLIC, EXCHANGE, PRIVATE_CONTRACTOR, PRIVATE_SUPPLIER, REGULATED)
PRIVATE_CLASSES = (PRIVATE_CONTRACTOR, PRIVATE_SUPPLIER)

OWNER_KIND = {PRIVATE_CONTRACTOR: "contractor", PRIVATE_SUPPLIER: "supplier"}

DEFAULT_FIELD_CLASSES: dict[str, str] = {
    # 交换范围（`03` §3 固化）
    "package_id": EXCHANGE, "rfq_rev": EXCHANGE, "scope": EXCHANGE, "items": EXCHANGE,
    "interfaces": EXCHANGE, "currency": EXCHANGE, "tax_code": EXCHANGE, "tax_mode": EXCHANGE,
    "deadlines": EXCHANGE, "payment_terms": EXCHANGE, "deliverables": EXCHANGE,
    "exclusions": EXCHANGE, "quote_id": EXCHANGE, "lines": EXCHANGE, "deviations": EXCHANGE,
    "lead_time_days": EXCHANGE, "payment_terms_offered": EXCHANGE, "validity_until": EXCHANGE,
    "attachment_refs": EXCHANGE,
    # 私域（永不出 realm）
    "cost_model": PRIVATE_SUPPLIER, "margin_pct": PRIVATE_SUPPLIER, "element_rates": PRIVATE_SUPPLIER,
    "capacity_calendar": PRIVATE_SUPPLIER, "internal_cost": PRIVATE_SUPPLIER,
    "reserve_price": PRIVATE_CONTRACTOR, "internal_score": PRIVATE_CONTRACTOR,
    "other_quotes": PRIVATE_CONTRACTOR, "tco_weights": PRIVATE_CONTRACTOR,
    # 只存证、不进模型
    "approvals": REGULATED, "signature": REGULATED, "evidence_pack": REGULATED,
}


class PrivateLeak(RuntimeError):
    """出站载荷里出现私域/受管制字段。"""


def classify_status(path: str, classes: dict[str, str] | None = None) -> str | None:
    """按最长前缀匹配给出字段分类（未声明返回 None）。"""
    table = classes if classes is not None else DEFAULT_FIELD_CLASSES
    table = {key.rstrip(".").lower(): value for key, value in table.items()}
    lowered = path.strip().lower()
    best: tuple[int, str] | None = None
    for key, value in table.items():
        if lowered == key or lowered.startswith(key + "."):
            if best is None or len(key) > best[0]:
                best = (len(key), value)
    return None if best is None else best[1]


@dataclass
class RealmProjector:
    classes: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_FIELD_CLASSES))
    _unclassified: set[str] = field(default_factory=set, init=False)

    def classify(self, path: str) -> str:
        status = classify_status(path, self.classes)
        if status is None:
            self._unclassified.add(path)
            return EXCHANGE  # 未分类按 exchange 处理，但记录在案（见 unclassified_paths）
        return status

    def unclassified_paths(self) -> list[str]:
        return sorted(self._unclassified)

    def reset_audit(self) -> None:
        self._unclassified.clear()

    def owner_kind(self, status: str) -> str | None:
        return OWNER_KIND.get(status)

    def _keep(self, key: str, *, record_realm: str, to_realm: str, for_model: bool) -> bool:
        status = self.classify(key)
        if status in (PUBLIC, EXCHANGE):
            return True
        if status == REGULATED:
            return False if for_model else record_realm == to_realm
        owner = self.owner_kind(status)
        target_kind = to_realm.split(":", 1)[0]
        return record_realm == to_realm and owner == target_kind

    def project(self, record: dict, *, to_realm: str) -> dict:
        """对方/本侧视图：按分类裁剪，返回新对象（不改原记录）。"""
        realm = str(record.get("realm", ""))
        out: dict[str, Any] = {}
        for key, value in record.items():
            if key == "realm":
                continue
            if self._keep(key, record_realm=realm, to_realm=to_realm, for_model=False):
                out[key] = copy.deepcopy(value)
        return out

    def stripped(self, record: dict, *, to_realm: str) -> list[str]:
        realm = str(record.get("realm", ""))
        return [key for key in record if key != "realm"
                and not self._keep(key, record_realm=realm, to_realm=to_realm, for_model=False)]

    def model_context(self, record: dict, *, realm: str) -> dict:
        """本侧模型输入：不出现对方私域，也不出现任何 regulated 字段（`08` §3）。"""
        record_realm = str(record.get("realm", ""))
        out: dict[str, Any] = {}
        for key, value in record.items():
            if key == "realm":
                continue
            if self._keep(key, record_realm=record_realm, to_realm=realm, for_model=True):
                out[key] = copy.deepcopy(value)
        return out

    def assert_clean(self, payload: dict, *, to_realm: str) -> None:
        """出站守卫：私域/regulated 字段一律拒绝发送（`08` §3 规则 2）。"""
        offending = self.stripped(payload, to_realm=to_realm)
        if offending:
            raise PrivateLeak(
                f"出站载荷含不可外发字段 {offending}（目标 realm {to_realm}）："
                f"私域数据不出 realm、regulated 字段只存证（P5 / INV-008）")


class RealmView:
    """某个 realm 的视图：只暴露该项目/记录中该 realm 可见的字段。"""

    def __init__(self, projector: RealmProjector | None = None, *, realm: str) -> None:
        self.projector = projector or RealmProjector()
        self.realm = realm

    def of(self, record: dict) -> dict:
        return self.projector.project(record, to_realm=self.realm)
