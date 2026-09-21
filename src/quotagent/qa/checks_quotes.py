"""报价过期与重报 AC（T-205 / FR-RFQ-006）：AC-RFQ-004。

覆盖：升版标记（stale + 旧/新版本号 + 可审计不清除）、不进入排序（`compare` 输出里以
`quote_superseded` 显式排除）、重报请求（含下一步动作）、幂等（重复升版不产生第二条留痕）。
"""

from __future__ import annotations

import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.compare import CompareService
from ..services.quotes import QuoteBook, QuoteBookError, SUPERSEDED
from .registry import Assertion, register


def _quote(quote_id: str, rev: int, unit_price: float = 88.5, *, qty: int = 100) -> dict:
    return {"quote_id": quote_id, "rfq_rev": rev, "package_id": "pkg-014",
            "supplier": {"participant_id": "sup-A"},
            "lines": [{"item_id": "L-001", "unit_price": unit_price, "qty": qty, "unit": "m"}],
            "terms": {"lead_time_days": 10, "payment": "net30"}}


def _package(rev: int = 1) -> dict:
    return {"package_id": "pkg-014", "rev": rev,
            "items": [{"item_id": "L-001", "qty": 100, "unit": "m"}]}


@register("AC-RFQ-004", "P1", "包升版后基于旧版本的报价被标记过期（可审计不清除）、不进入排序、并产生重报请求",
          "qa ac AC-RFQ-004", evidence_refs=("EV-046",))
def ac_rfq_004() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("ac-rfq-004")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    book = QuoteBook(participant="con-B", realm="contractor:con-B", ledger=ledger, events=bus)
    compare = CompareService(ledger=ledger, events=bus)

    # 登记三份报价：两份基于 rev1，一份基于 rev2（升版后提交）
    book.register(_quote("q-rev1-a", 1, 88.5), package_id="pkg-014")
    book.register(_quote("q-rev1-b", 1, 92.0), package_id="pkg-014")
    book.register(_quote("q-rev2-c", 2, 90.0), package_id="pkg-014")
    out.append(Assertion("报价必须绑定包版本（缺 rfq_rev 直接拒绝登记）",
                         _reg_refused(book) and len(book.active()) == 3,
                         f"active={len(book.active())}"))

    # 标记之前：排除靠**版本门**（P0 的 AC-COMPARE-001），与"过期标记"是两个层次
    before = compare.rank(_package(2), [_quote("q-rev1-a", 1), _quote("q-rev2-c", 2)], book=book)
    codes_before = sorted({row["code"] for row in before["excluded"]})
    out.append(Assertion("未标记时排除原因仍是版本门 rfq_version_mismatch（与过期标记分层，不混淆）",
                         codes_before == ["rfq_version_mismatch"] and before["ranking"][0]["quote_id"] == "q-rev2-c",
                         f"excluded_codes={codes_before}"))

    marked = book.on_amended(package_id="pkg-014", from_rev=1, to_rev=2, notified=True)
    views = {item["quote_id"]: item for item in marked["superseded"]}
    out.append(Assertion("升版后基于旧版本的活动报价被标记过期（stale=true + superseded_by_rev=2 + status）",
                         set(views) == {"q-rev1-a", "q-rev1-b"}
                         and all(item["stale"] and item["status"] == SUPERSEDED for item in views.values())
                         and all(item["superseded_by_rev"] == 2 for item in views.values()),
                         f"superseded={json.dumps(marked['superseded'], ensure_ascii=False)[:220]}"))
    out.append(Assertion("基于新版本的报价不受影响（仍在活动集里）",
                         [item["quote_id"] for item in book.active()] == ["q-rev2-c"],
                         f"active={[item['quote_id'] for item in book.active()]}"))

    ledger_rows = ledger.read(type="quote/superseded")
    out.append(Assertion("过期留痕 quote/superseded（含旧/新版本号与 reason，可审计不清除）",
                         len(ledger_rows) == 2
                         and all(row["body"]["based_on_rev"] == 1 and row["body"]["superseded_by_rev"] == 2
                                 for row in ledger_rows)
                         and all("不得参与比较" in row["body"]["reason"] for row in ledger_rows),
                         f"rows={[row['body']['quote_id'] for row in ledger_rows]}"))

    after = compare.rank(_package(2), [_quote("q-rev1-a", 1), _quote("q-rev1-b", 1), _quote("q-rev2-c", 2)],
                         book=book)
    ranked_ids = [row["quote_id"] for row in after["ranking"]]
    codes = sorted({row["code"] for row in after["excluded"]})
    superseded_rows = [row for row in after["excluded"] if row["code"] == "quote_superseded"]
    out.append(Assertion("过期报价**不进入排序**，且以 quote_superseded 显式列出（含旧/新版本号与下一步）",
                         ranked_ids == ["q-rev2-c"] and codes == ["quote_superseded"]
                         and len(superseded_rows) == 2
                         and superseded_rows[0]["based_on_rev"] == 1
                         and superseded_rows[0]["superseded_by_rev"] == 2
                         and bool(superseded_rows[0]["next_action"]),
                         f"ranking={ranked_ids} excluded={json.dumps(after['excluded'], ensure_ascii=False)[:240]}"))

    requests = book.open_requote_requests()
    out.append(Assertion("产生重报请求（含旧/新版本号、供应商与可行动 next_action）",
                         len(requests) == 2
                         and all(item["requires_requote"] and item["based_on_rev"] == 1
                                 and item["superseded_by_rev"] == 2
                                 and "rev2" in item["next_action"] for item in requests),
                         f"requests={json.dumps(requests, ensure_ascii=False)[:240]}"))

    again = book.on_amended(package_id="pkg-014", from_rev=1, to_rev=2)
    out.append(Assertion("幂等：对同一升版重复调用不再标记（不产生第二条留痕，重报请求不翻倍）",
                         again["superseded"] == [] and len(ledger.read(type="quote/superseded")) == 2
                         and len(book.open_requote_requests()) == 2,
                         f"again={again['superseded']} rows={len(ledger.read(type='quote/superseded'))}"))

    next_bump = book.on_amended(package_id="pkg-014", from_rev=2, to_rev=3)
    out.append(Assertion("继续升版把 rev2 的报价也标记过期（链式失效，不是只处理第一次升版）",
                         [item["quote_id"] for item in next_bump["superseded"]] == ["q-rev2-c"]
                         and book.active() == []
                         and len(book.open_requote_requests()) == 3,
                         f"superseded={[item['quote_id'] for item in next_bump['superseded']]} "
                         f"active={book.active()}"))
    out.append(Assertion("过期是标记不是删除：过期报价仍可读（含原报价内容与审 trail）",
                         len(book.superseded()) == 3
                         and all(item["status"] == SUPERSEDED for item in book.superseded()),
                         f"superseded_count={len(book.superseded())}"))
    return out


def _reg_refused(book: QuoteBook) -> bool:
    try:
        book.register({"quote_id": "q-bad", "lines": []})
        return False
    except QuoteBookError as err:
        return "rfq_rev" in str(err)
