"""产能与交期（T-207 / FR-CAP-001、FR-CAP-002）：产能日历 + 关键路径校验 + `firm` 交期的不可变更性。

两条硬约束：
1. **`firm` 交期在报价有效期内不可由模型自行变更**（`02` §CapacityCommitment 的不变量）：agent 的修改一律被拒
   并落 `capacity/firm-change-refused`；人（`human:*`）可以改，改即产生新 revision 并留痕。
2. **产能/交期冲突只提请人工**（FR-GUARD-003 与"护栏不否决"）：可行性校验的结论是 Flag/conflict 事件 +
   `requires_human`，**不**改交期、**不**否决报价、**不**改变排序。

产能日历是**供应商私域**（`02`）：只在本 realm 内参与计算，不外发、不落进对方可见的字段。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from ..kernel.ledger import Ledger, utc_now

COMMITTED_EVENT = "capacity/committed"
REFUSED_EVENT = "capacity/firm-change-refused"
CONFLICT_EVENT = "capacity/conflict"

BINDING = ("firm", "indicative")
MODEL_ACTORS = ("agent:", "model:", "system:")
IMMUTABLE_FIELDS = ("delivery_date", "lead_time_days", "quantity")


class CapacityError(RuntimeError):
    pass


class FirmDateImmutable(CapacityError):
    """`firm` 交期在有效期内被模型改动 → 拒绝（不是警告）。"""


def _as_date(value: str | date) -> date:
    return value if isinstance(value, date) else datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def _is_model(actor: str) -> bool:
    return any(str(actor).startswith(prefix) for prefix in MODEL_ACTORS)


@dataclass
class Calendar:
    """供应商产能日历（私域）：某天可用产能（单位由包约定，如 t/月按天摊或人天）。"""

    owner: str
    days: dict[str, float] = field(default_factory=dict)

    def set_day(self, day: str | date, available: float) -> None:
        self.days[_as_date(day).isoformat()] = float(available)

    def daily(self, day: str | date) -> float:
        return float(self.days.get(_as_date(day).isoformat(), 0.0))

    def between(self, start: str | date, end: str | date) -> float:
        begin, finish = _as_date(start), _as_date(end)
        total, cursor = 0.0, begin
        while cursor <= finish:
            total += self.daily(cursor)
            cursor += timedelta(days=1)
        return total

    def window(self, start: str | date, days: int) -> list[tuple[str, float]]:
        begin = _as_date(start)
        return [((begin + timedelta(days=offset)).isoformat(), self.daily(begin + timedelta(days=offset)))
                for offset in range(int(days))]


@dataclass
class Commitment:
    commitment_id: str
    quote_id: str
    package_id: str
    binding: str
    lead_time_days: int
    quantity: float
    start_date: str
    delivery_date: str
    valid_until: str
    milestones: list[dict] = field(default_factory=list)
    revision: int = 1
    created_by: str = "human:unknown"
    history: list[dict] = field(default_factory=list)

    @property
    def end_date(self) -> str:
        return self.delivery_date

    def to_dict(self) -> dict:
        data = copy.deepcopy(self.__dict__)
        return data


class CapacityService:
    """一方的产能/交期服务（日历 + 承诺 + 可行性校验）。"""

    def __init__(self, *, participant: str, realm: str, ledger: Ledger, events: Any = None,
                 calendar: Calendar | None = None) -> None:
        self.participant = participant
        self.realm = realm
        self.ledger = ledger
        self.events = events
        self.calendar = calendar or Calendar(owner=realm)
        self.commitments: dict[str, Commitment] = {}
        self.conflicts: list[dict] = []

    # ---------------------------------------------------------------- 承诺
    def commit(self, *, quote_id: str, package_id: str, lead_time_days: int, quantity: float,
               start_date: str | date, binding: str = "indicative", valid_until: str | date | None = None,
               milestones: Iterable[dict] = (), commitment_id: str | None = None,
               by: str = "human:unknown") -> Commitment:
        if binding not in BINDING:
            raise CapacityError(f"binding 必须是 {BINDING}，收到 {binding!r}")
        start = _as_date(start_date)
        delivery = start + timedelta(days=int(lead_time_days))
        expires = _as_date(valid_until) if valid_until else delivery + timedelta(days=30)
        if expires < delivery:
            raise CapacityError("报价有效期早于交期：`firm` 交期无意义（有效期内不可变更）")
        cid = commitment_id or f"cm-{len(self.commitments) + 1:04d}"
        commitment = Commitment(commitment_id=cid, quote_id=quote_id, package_id=package_id,
                                binding=binding, lead_time_days=int(lead_time_days),
                                quantity=float(quantity), start_date=start.isoformat(),
                                delivery_date=delivery.isoformat(), valid_until=expires.isoformat(),
                                milestones=[dict(item) for item in milestones], created_by=by)
        self.commitments[cid] = commitment
        self._append(COMMITTED_EVENT, {"commitment_id": cid, "quote_id": quote_id,
                                       "package_id": package_id, "binding": binding,
                                       "lead_time_days": commitment.lead_time_days,
                                       "quantity": commitment.quantity,
                                       "delivery_date": commitment.delivery_date,
                                       "valid_until": commitment.valid_until, "revision": 1,
                                       "by": by, "action": "commit"})
        return commitment

    def amend(self, *, commitment_id: str, changes: dict, by: str,
              on: str | date | None = None) -> dict:
        """修改承诺。`firm` + 有效期内 + 模型发起 → **拒绝**（FR-CAP-002）。"""
        commitment = self._require(commitment_id)
        today = _as_date(on) if on is not None else date.today()
        within = today <= _as_date(commitment.valid_until)
        touching = {key: value for key, value in changes.items() if key in IMMUTABLE_FIELDS}
        if commitment.binding == "firm" and within and touching and _is_model(by):
            payload = {"commitment_id": commitment_id, "quote_id": commitment.quote_id,
                       "package_id": commitment.package_id, "binding": commitment.binding,
                       "attempted_by": by, "changes": touching, "valid_until": commitment.valid_until,
                       "reason": "`firm` 交期在报价有效期内不可由模型变更（FR-CAP-002）",
                       "next_action": "需要变更时由人在人工门批准后改动，或先让该承诺过期"}
            self._append(REFUSED_EVENT, payload)
            raise FirmDateImmutable(payload["reason"])
        revision = commitment.revision + 1
        before = {key: getattr(commitment, key) for key in changes}
        for key, value in changes.items():
            if key in ("delivery_date", "valid_until", "start_date"):
                setattr(commitment, key, _as_date(value).isoformat())
            elif key == "milestones":
                commitment.milestones = [dict(item) for item in value]
            else:
                setattr(commitment, key, value)
        if "lead_time_days" in changes and "delivery_date" not in changes:
            commitment.delivery_date = (_as_date(commitment.start_date)
                                        + timedelta(days=int(commitment.lead_time_days))).isoformat()
        commitment.revision = revision
        commitment.history.append({"revision": revision, "by": by, "before": before,
                                   "after": {key: getattr(commitment, key) for key in changes},
                                   "at": utc_now()})
        self._append(COMMITTED_EVENT, {"commitment_id": commitment_id, "quote_id": commitment.quote_id,
                                       "package_id": commitment.package_id, "binding": commitment.binding,
                                       "lead_time_days": commitment.lead_time_days,
                                       "quantity": commitment.quantity,
                                       "delivery_date": commitment.delivery_date,
                                       "valid_until": commitment.valid_until, "revision": revision,
                                       "by": by, "action": "amend", "changes": sorted(changes)})
        return {"commitment_id": commitment_id, "revision": revision, "binding": commitment.binding,
                "delivery_date": commitment.delivery_date, "by": by, "changes": sorted(changes)}

    # ---------------------------------------------------------------- 可行性（日历 + 关键路径）
    def feasibility(self, *, commitment_id: str, required_per_day: float | None = None) -> dict:
        """产能日历 + 关键路径校验：结论只提请人工，**不**改交期、**不**否决报价。"""
        commitment = self._require(commitment_id)
        start = _as_date(commitment.start_date)
        finish = _as_date(commitment.delivery_date)
        working = self.calendar.window(start, (finish - start).days + 1)
        available = sum(day for _, day in working)
        needed = float(commitment.quantity if required_per_day is None else required_per_day)
        shortfall = max(0.0, round(needed - available, 6))
        blockers: list[dict] = []
        cursor = start
        for milestone in commitment.milestones:
            due = _as_date(milestone.get("due", finish))
            share = float(milestone.get("quantity", 0.0))
            have = self.calendar.between(cursor, due)
            if share > have:
                blockers.append({"milestone": milestone.get("name") or milestone.get("id"),
                                 "due": due.isoformat(), "required": share, "available": have,
                                 "gap": round(share - have, 6)})
            cursor = due
        feasible = shortfall == 0 and not blockers
        result = {"commitment_id": commitment_id, "quote_id": commitment.quote_id,
                  "package_id": commitment.package_id, "binding": commitment.binding,
                  "window": [working[0][0] if working else None, working[-1][0] if working else None],
                  "days": len(working), "required": needed, "available": round(available, 6),
                  "shortfall": shortfall, "milestone_blockers": blockers, "feasible": feasible,
                  "requires_human": not feasible,
                  "action": "escalate_to_human" if not feasible else "none"}
        if not feasible:
            self.conflicts.append(result)
            self._append(CONFLICT_EVENT, {**result,
                                          "reason": "产能/交期不可行（日历或关键路径不足）",
                                          "note": "只提请人工：不自动改交期、不否决报价（护栏不否决）"})
        return result

    def conflict_flags(self, *, share_safe: bool = False) -> list[dict]:
        """把冲突转成护栏 Flag（`kind=capacity_risk`）。

        `share_safe=False`：本方内部形态，带缺口数值（供人工判断）；
        `share_safe=True`：**对外形态**——产能日历是私域，数值不外发，只留定性结论与私域引用。
        """
        out = []
        for item in self.conflicts:
            if share_safe:
                detail = ("产能/交期不可行（缺口数值属本方私域，见 evidence_refs 指向的账本条目）；"
                          f"里程碑阻塞 {len(item['milestone_blockers'])} 处")
            else:
                detail = (f"产能不可行：需要 {item['required']:g}，日历可用 {item['available']:g}"
                          f"（缺口 {item['shortfall']:g}；里程碑阻塞 {len(item['milestone_blockers'])} 处）")
            out.append({"kind": "capacity_risk", "severity": "high", "target_ref": item["quote_id"],
                        "detail": detail, "requires_human": True,
                        "evidence_refs": [f"commitment:{item['commitment_id']}:window", "calendar:private"]})
        return out

    # ---------------------------------------------------------------- 查询
    def commitment(self, commitment_id: str) -> Commitment:
        return self._require(commitment_id)

    def firm_dates(self) -> list[dict]:
        return [{"commitment_id": item.commitment_id, "quote_id": item.quote_id,
                 "delivery_date": item.delivery_date, "valid_until": item.valid_until,
                 "binding": item.binding} for item in self.commitments.values() if item.binding == "firm"]

    def _require(self, commitment_id: str) -> Commitment:
        commitment = self.commitments.get(commitment_id)
        if commitment is None:
            raise CapacityError(f"未知承诺: {commitment_id}")
        return commitment

    def _append(self, type_: str, body: dict) -> None:
        self.ledger.append(type_, body, actor=self.participant,
                           refs={"commitment_id": body.get("commitment_id")} if body.get("commitment_id") else {})
        if self.events is not None:
            self.events.dispatch(type_, body)
