"""报价生命周期（T-205 / FR-RFQ-006）：包升版后把基于旧版本的报价**标记为过期**并产生重报请求。

与既有能力的分工（不重复造轮子）：
- **排序门**已由 `services/compare.py` 承担：`quote.rfq_rev != package.rev` 一律不进排序并落
  `rfq/version-mismatch`（FR-NORM-004 / AC-COMPARE-001，P0 已证）；
- **本模块**补的是"升版那一刻的**显式标记**与**重报闭环**"：谁因为哪次升版失效、要请谁重报、
  以及让 `compare` 把过期报价以 `quote_superseded` 显式列在 excluded 里（可审计，不靠"没出现在排名里"推断）。

不变量：
- 过期是**标记**不是删除：报价原样保留（可读、可审计），只加 `stale/superseded_by_rev/status`；
- 只有"基于被替换版本的**活动**报价"会被标记一次（幂等：重复调用不产生第二条留痕）；
- 重报请求只针对被标记的报价，且带旧/新版本号与可行动的下一步。
"""

from __future__ import annotations

import copy
from typing import Any, Iterable

from ..kernel.ledger import Ledger, utc_now

SUPERSEDED_EVENT = "quote/superseded"

ACTIVE = "active"
SUPERSEDED = "superseded"


class QuoteBookError(RuntimeError):
    pass


class QuoteBook:
    """一方的报价台账（只登记经 QEP 收到的报价，并维护它们的生命周期状态）。"""

    def __init__(self, *, participant: str, realm: str, ledger: Ledger, events: Any = None) -> None:
        self.participant = participant
        self.realm = realm
        self.ledger = ledger
        self.events = events
        self.quotes: dict[str, dict] = {}
        self.requote_requests: list[dict] = []

    # ---------------------------------------------------------------- 登记
    def register(self, quote: dict, *, package_id: str | None = None) -> dict:
        """登记一份报价（必须自带 `quote_id` 与 `rfq_rev`：版本绑定是硬要求）。"""
        quote_id = quote.get("quote_id")
        rfq_rev = quote.get("rfq_rev")
        if not quote_id:
            raise QuoteBookError("报价缺 quote_id")
        if not isinstance(rfq_rev, int) or rfq_rev < 1:
            raise QuoteBookError(f"报价缺 rfq_rev（收到 {rfq_rev!r}）：报价必须绑定包版本")
        record = {"quote_id": quote_id, "package_id": package_id or quote.get("package_id"),
                  "based_on_rev": int(rfq_rev), "status": ACTIVE, "stale": False,
                  "superseded_by_rev": None, "registered_at": utc_now(),
                  "supplier": (quote.get("supplier") or quote.get("sender") or {}).get("participant_id")
                  if isinstance(quote.get("supplier") or quote.get("sender"), dict) else quote.get("supplier"),
                  "quote": copy.deepcopy(quote)}
        self.quotes[quote_id] = record
        return self._view(quote_id)

    # ---------------------------------------------------------------- 升版 → 标记过期
    def on_amended(self, *, package_id: str, from_rev: int, to_rev: int,
                   notified: bool = False) -> dict:
        """包从 `from_rev` 升到 `to_rev`：把基于 `from_rev` 的活动报价标记过期并请求重报。"""
        if to_rev <= from_rev:
            raise QuoteBookError(f"升版目标必须大于原版本：{from_rev} → {to_rev}")
        superseded: list[dict] = []
        requests: list[dict] = []
        for record in self.quotes.values():
            if record["status"] != ACTIVE or record["based_on_rev"] != from_rev:
                continue
            if package_id and record["package_id"] and record["package_id"] != package_id:
                continue
            record["status"] = SUPERSEDED
            record["stale"] = True
            record["superseded_by_rev"] = int(to_rev)
            record["superseded_at"] = utc_now()
            view = {"quote_id": record["quote_id"], "package_id": record["package_id"],
                    "based_on_rev": record["based_on_rev"], "superseded_by_rev": int(to_rev),
                    "status": SUPERSEDED, "stale": True,
                    "supplier": record["supplier"], "requires_requote": True,
                    "reason": f"包已升版 rev{from_rev} → rev{to_rev}：基于旧版本的报价不得参与比较",
                    "next_action": f"请基于 rev{to_rev} 重报（同一 quote_id 的重报应按新版本重新登记）"}
            superseded.append(view)
            requests.append(view)
            self.requote_requests.append(view)
            self._append(SUPERSEDED_EVENT, {
                "quote_id": record["quote_id"], "package_id": record["package_id"],
                "based_on_rev": record["based_on_rev"], "superseded_by_rev": int(to_rev),
                "status": SUPERSEDED, "requires_requote": True, "notified": bool(notified),
                "reason": view["reason"]})
        return {"package_id": package_id, "from_rev": from_rev, "to_rev": to_rev,
                "superseded": superseded, "requote_requests": requests,
                "active": len(self.active())}

    # ---------------------------------------------------------------- 查询
    def active(self) -> list[dict]:
        return [self._view(quote_id) for quote_id, record in sorted(self.quotes.items())
                if record["status"] == ACTIVE]

    def superseded(self) -> list[dict]:
        return [self._view(quote_id) for quote_id, record in sorted(self.quotes.items())
                if record["status"] == SUPERSEDED]

    def open_requote_requests(self) -> list[dict]:
        return [copy.deepcopy(item) for item in self.requote_requests]

    def is_superseded(self, quote_id: str) -> bool:
        record = self.quotes.get(quote_id)
        return bool(record and record["status"] == SUPERSEDED)

    def exclude_superseded(self, quotes: Iterable[dict]) -> tuple[list[dict], list[dict]]:
        """把过期报价从候选里摘出来（返回：可用, 被排除），供 `compare` 显式列出。"""
        keep, dropped = [], []
        for quote in quotes:
            quote_id = str(quote.get("quote_id") or "")
            record = self.quotes.get(quote_id)
            if record is not None and record["status"] == SUPERSEDED:
                dropped.append({"quote_id": record["quote_id"], "code": "quote_superseded",
                                "based_on_rev": record["based_on_rev"],
                                "superseded_by_rev": record["superseded_by_rev"],
                                "reason": f"报价基于 rev{record['based_on_rev']}，已被 rev"
                                          f"{record['superseded_by_rev']} 取代（不得静默比较）",
                                "next_action": "请对方基于当前版本重报"})
                continue
            keep.append(quote)
        return keep, dropped

    def _view(self, quote_id: str) -> dict:
        record = self.quotes[quote_id]
        return copy.deepcopy({key: value for key, value in record.items() if key != "quote"})

    def _append(self, type_: str, body: dict) -> None:
        self.ledger.append(type_, body, actor=self.participant,
                           refs={"quote_id": body.get("quote_id")} if body.get("quote_id") else {})
        if self.events is None:
            return
        return self.events.dispatch(type_, body)
