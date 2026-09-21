"""ctx.faq 的 P2 实现（`docs/design/18-faq-contract.md`）——澄清 FAQ 的沉淀与复用（FR-CLARIFY-004）。

与 `services/clarify.py` 的分工（契约 §1）：clarify 管**一次问答的生命周期**（ask/answer/broadcast/close）；
本服务管**沉淀与复用**——把已答问题抽成条目，供**同 package 同版本**的重复提问复用。
本服务**只读** clarify 的账本行（不 import、不调用它的内部方法），也不改任何票单。

八条不变量（契约 §2，逐条落在代码里）：

1. **版本绑定不可跨**（AC-CLARIFY-004 的字面要求）：条目带 `package_id` + `rfq_rev`；跨版本一律
   `hit=false` + `reason="faq-version-mismatch"` + `next_action`，且 `entry is None`——**不返回任何条目内容**
   （没有"最接近的另一版本"这种静默降级）；
2. **命中不改版本绑定**：`reuse()` 是**纯读**——不写票单、不改条目、不改任何状态；它唯一的账本副作用是
   **观测事件**（`faq/reuse-served` / `faq/reuse-refused`），不是状态变更（D-051）；
3. **沉淀必须人发**：`publish(by=...)` 的 `by` 必须以 `human:` 开头，否则抛 `AgentCannotPublish`，
   **且不落** `faq/entry-published`（与 `negotiate.declare_bounds` 同一纪律）；
4. **本 realm 内**：条目记录发布 realm，读侧按 realm 过滤（跨 realm 的条目不可见，`get()` 亦不可见）；
5. **私域不出 realm**：条目只保留**问题文本的规范化哈希**与**白名单**内的可复用字段；
   `reserve_price` / `cost_model` / `signature` / `private:*` 一律剥掉（键与值都扫）（INV-008）；
6. **不读墙钟**：本模块不 import 任何时钟；`published_at` / `answered_at` 一律取自账本行的 `ts`
   （错误消息里也没有绝对时刻，D-042）；
7. **不产生义务**：只有三个 `fact` 事件，没有 commitment / PO / 对外报价出口；
8. **确定性**：`entry_id` 由账本重建的序号给出，`entries()` / `distill()` 按 id 排序，`reuse()` 命中取
   最早发布的那条——同输入两次调用字节一致（不依赖字典顺序）。

事件（契约 §5，`event_class` 一律 `fact`，无 waterfall）：

| 事件 | `correlation_id` | body 关键键 |
|---|---|---|
| `faq/entry-published` | `entry_id` | entry_id, package_id, rfq_rev, question_norm, source_ticket, published_by, fields_used[] |
| `faq/reuse-served` | `entry_id` | entry_id, package_id, rfq_rev, question_norm, citations[] |
| `faq/reuse-refused` | `package_id` | package_id, rfq_rev, question_norm, reason, next_action |

三种拒绝（跨版本 / 未沉淀 / 未知包）都落**同一条** `faq/reuse-refused`，原因走 `reason`——拒绝也要能指导
下一步（`next_action`），且**不带任何条目内容**。
"""

from __future__ import annotations

from typing import Any

import copy

from ..kernel.canon import HASH_PREFIX, canonical_json, nfc, sha256_hex
from ..kernel.ledger import Ledger
from .approval import HUMAN_PREFIX

__all__ = [
    "AgentCannotPublish", "FaqError", "FaqService", "FaqVersionMismatch", "UnknownEntry", "UnknownTicket",
    "ENTRY_PUBLISHED_EVENT", "REUSE_REFUSED_EVENT", "REUSE_SERVED_EVENT", "EVENT_MODES", "filter_fields",
    "question_norm",
]

# --- 事件（契约 §5：名字与 event_class 都不可改；本文件不自行发明事件） -----------------
ENTRY_PUBLISHED_EVENT = "faq/entry-published"
REUSE_SERVED_EVENT = "faq/reuse-served"
REUSE_REFUSED_EVENT = "faq/reuse-refused"

#: 契约 §5 的模式表：三个 `faq/*` 全是 `emit`（无 waterfall）；内核按声明拒绝用错模式
EVENT_MODES = {
    ENTRY_PUBLISHED_EVENT: "emit",
    REUSE_SERVED_EVENT: "emit",
    REUSE_REFUSED_EVENT: "emit",
}

#: 契约 §5：`event_class` 一律 `fact`
EVENT_CLASS = "fact"

#: clarify 侧的账本行（只读它们的账本行，不 import `services/clarify.py`）
ASKED_EVENT = "clarification/asked"
ANSWERED_EVENT = "clarification/answered"
REOPENED_EVENT = "clarification/reopened"

#: 拒绝原因（契约 §3 的取值集合，逐字）
REASON_HIT = "faq-hit"
REASON_VERSION_MISMATCH = "faq-version-mismatch"
REASON_NOT_PUBLISHED = "faq-not-published"
REASON_UNKNOWN_PACKAGE = "faq-unknown-package"

#: 私域哨兵（INV-008 / 契约 §2.5）：键里出现即剥；值里出现也剥
PRIVATE_TOKENS = ("reserve_price", "cost_model", "signature", "private:")

#: 可复用字段**白名单**（契约 §3 `answer_fields`：只有这里面的键能进条目）
REUSABLE_FIELDS = (
    "unit", "deadline_note", "lead_time_days", "payment_terms", "delivery_terms", "incoterms",
    "packaging", "moq", "currency",
)


class FaqError(RuntimeError):
    """FAQ 错误基类（契约 §4）。"""


class AgentCannotPublish(FaqError):
    """`publish(by=...)` 的 `by` 不以 `human:` 开头（沉淀必须人发）。"""


class UnknownEntry(FaqError):
    """不存在的 `entry_id`（或不属于本 realm —— 跨 realm 条目不可见）。"""


class UnknownTicket(FaqError):
    """票单不存在或不属于本 realm。"""


class FaqVersionMismatch(FaqError):
    """**只在 `publish` 用**：发布时票单版本与参数不一致即拒（`ticket.rfq_rev != rfq_rev`）。

    注意：`reuse()` 的跨版本情形**不抛异常**——调用方需要"能不能用"的答案，不是异常流；
    那条路径返回 `hit=false` + `reason="faq-version-mismatch"`（契约 §4 的注意）。
    """


# --- 纯函数（无副作用、可单测、不读时钟） --------------------------------------------

def question_norm(question: Any) -> str:
    """问题文本的规范化哈希：NFC → 去首尾空白 → 空白折叠 → 大小写折叠 → `sha256:<hex>`。

    **只留哈希、不留原文**：这是条目与复用查询的匹配键，也是"私域不进条目"的一道保险
    （票单里的问题原文不会因此进条目）。
    """
    text = " ".join(nfc(str(question or "")).split())
    return HASH_PREFIX + sha256_hex(text.casefold().encode("utf-8"))


def is_private_key(key: Any) -> bool:
    """键是否属于私域（`private*` 前缀，或含 `reserve_price`/`cost_model`/`signature`）。"""
    low = str(key).lower()
    return low.startswith("private") or any(token in low for token in PRIVATE_TOKENS)


def contains_private(value: Any) -> bool:
    """值里是否出现私域哨兵（键过了白名单，值还要再扫一遍）。"""
    try:
        text = canonical_json(value) if not isinstance(value, str) else value
    except (TypeError, ValueError):
        text = str(value)
    low = str(text).lower()
    return any(token in low for token in PRIVATE_TOKENS)


def filter_fields(fields: Any) -> dict:
    """只留**白名单**内的可复用字段，再扫私域哨兵（键与值都扫）；结果按 key 排序（确定性）。"""
    if not isinstance(fields, dict):
        return {}
    out: dict = {}
    for key in sorted(fields, key=str):
        if not isinstance(key, str) or key not in REUSABLE_FIELDS or is_private_key(key):
            continue
        value = fields[key]
        if contains_private(value):
            continue
        out[key] = copy.deepcopy(value)
    return out


def _rev_eq(left: Any, right: Any) -> bool:
    try:
        return int(left) == int(right)
    except (TypeError, ValueError):
        return False


def _entry_number(entry_id: Any) -> int:
    tail = str(entry_id or "").rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def _entry_sort_key(entry_id: Any) -> tuple:
    return (_entry_number(entry_id), str(entry_id))


class FaqService:
    """`ctx.faq` 的 P2 Provider（FAQ 沉淀与复用；账本是唯一事实源）。

    只接一个账本（本 realm 的账本）：条目/票单都从账本行读，`replay()` 重建后新实例看到同样的条目。
    """

    #: 观测事件（`reuse-served` / `reuse-refused`）的 actor；`entry-published` 用发布者本人
    actor = "agent:faq"

    def __init__(self, *, realm: str, ledger: Ledger | None = None, events: Any = None) -> None:
        self.realm = str(realm or "")
        self.ledger = ledger
        self.events = events
        self._entries: dict[str, dict] = {}
        self._order: list[str] = []
        self._counter = 0
        self.replayed = 0
        if self.ledger is not None:
            self.replayed = int(self.replay()["replayed"])

    # ---------------------------------------------------------------- 沉淀候选
    def distill(self, *, package_id: str, rfq_rev: int) -> list[dict]:
        """候选（**只读、不落账**）：本 realm 内该包该版本**已有答复**且尚未沉淀的问答。

        没有答复的问题不是可沉淀的候选（拿去复用等于把未审内容变成事实，契约 §7）。
        """
        published: dict[str, str] = {}
        for record in self._visible():
            if str(record.get("package_id")) != str(package_id) or not _rev_eq(record.get("rfq_rev"), rfq_rev):
                continue
            published.setdefault(str(record.get("source_ticket")), str(record.get("entry_id")))
        candidates: list[dict] = []
        for ticket in self._tickets(package_id=package_id, rfq_rev=rfq_rev):
            answered = ticket.get("answered")
            if not answered:
                continue
            ticket_id = str(ticket["ticket_id"])
            candidates.append({
                "ticket_id": ticket_id,
                "package_id": str(package_id),
                "rfq_rev": int(rfq_rev),
                "question": str(ticket.get("question") or ""),
                "question_norm": question_norm(ticket.get("question")),
                "answer_fields": filter_fields(answered.get("fields")),
                "answered_by": str(answered.get("by") or ""),
                "answered_at": str(answered.get("at") or ""),      # 账本行的 ts，不读墙钟
                "stale": bool(ticket.get("stale")),
                "published": ticket_id in published,
                "entry_id": published.get(ticket_id),
                "citations": self._ticket_citations(ticket_id, str(package_id), rfq_rev),
            })
        candidates.sort(key=lambda cand: str(cand["ticket_id"]))
        return candidates

    # ---------------------------------------------------------------- 发布（必须人发）
    def publish(self, *, package_id: str, rfq_rev: int, ticket_id: str,
                by: str, question: str = "", fields: dict | None = None) -> dict:
        """沉淀一条 FAQ 条目（Entry 视图），落 `faq/entry-published`。

        版本绑定 = 票单的 `package_id` + `rfq_rev`（不可跨）；`fields` 缺省时取票单答复里
        **显式声明为可复用**的字段，仍要过白名单与私域扫描。
        """
        if not str(by or "").startswith(HUMAN_PREFIX):
            raise AgentCannotPublish(
                f"FAQ 沉淀必须由人发布（by 必须以 {HUMAN_PREFIX!r} 开头，收到 {by!r}）："
                f"沉淀物会被别人当事实复用，未审内容不得成为事实（D-051 / 契约 §2.3）")
        if self.ledger is None:
            raise FaqError("没有账本：FAQ 条目必须落账（账本是唯一事实源）")
        if isinstance(rfq_rev, bool) or not isinstance(rfq_rev, int) or rfq_rev < 1:
            raise FaqError(f"rfq_rev 必须是正整数（版本绑定是硬要求），收到 {rfq_rev!r}")
        ticket = self._ticket(ticket_id)
        if str(ticket.get("package_id")) != str(package_id):
            raise FaqError(
                f"工单 {ticket_id} 属于包 {ticket.get('package_id')!r}，与发布参数 "
                f"package_id={package_id!r} 不一致（条目只挂在自己票单的包上）")
        if not _rev_eq(ticket.get("rfq_rev"), rfq_rev):
            raise FaqVersionMismatch(
                f"工单 {ticket_id} 的版本 rfq_rev={ticket.get('rfq_rev')} 与发布参数 rfq_rev={rfq_rev} "
                f"不一致：条目必须与票单版本一致（D-051：版本绑定只能靠新的一轮问答来改）")

        text = nfc(str(question or "")).strip() or str(ticket.get("question") or "")
        norm = question_norm(text)
        declared = fields if isinstance(fields, dict) else {}
        source_fields = declared if fields is not None else ((ticket.get("answered") or {}).get("fields") or {})
        kept = filter_fields(source_fields)

        existing = self._published_entry(str(package_id), int(rfq_rev), norm, str(ticket_id))
        if existing is not None:
            # 同一票单同一问题重复发布：重新走一次账本追加（去重命中 → 不产生第二条事实）
            self._append(ENTRY_PUBLISHED_EVENT, existing["_body"], correlation_id=existing["entry_id"],
                         actor=str(by), refs=existing["_refs"])
            return self._view(existing)

        entry_id = f"fq-{self._counter + 1:04d}"
        citations = self._ticket_citations(str(ticket_id), str(package_id), rfq_rev)
        refs = {"entry_id": entry_id, "package_id": str(package_id), "ticket_id": str(ticket_id)}
        body = {
            "entry_id": entry_id,
            "package_id": str(package_id),
            "rfq_rev": int(rfq_rev),
            "question_norm": norm,
            "question": _safe_question(question),
            "source_ticket": str(ticket_id),
            "published_by": str(by),
            "fields_used": sorted(kept),
            "answer_fields": copy.deepcopy(kept),
            "citations": list(citations),
            # 条目所属 realm（读侧过滤的唯一依据）：跨 realm 的条目不可见
            "realm": self.realm,
        }
        ref = self._append(ENTRY_PUBLISHED_EVENT, body, correlation_id=entry_id, actor=str(by), refs=refs)
        record = self._record_of({"body": body, "ts": self._ts(ref)})
        assert record is not None                                 # body 由本方法构造，必然可解析
        record["_refs"] = dict(refs)
        self._entries[entry_id] = record
        self._order = sorted(self._entries, key=_entry_sort_key)
        self._counter = max(self._counter, _entry_number(entry_id))
        return self._view(record)

    # ---------------------------------------------------------------- 复用（纯读）
    def reuse(self, *, package_id: str, rfq_rev: int, question: str) -> dict:
        """FAQ 复用查询（Reuse 视图）——**纯读**：不改票单、不改条目、不改版本绑定。

        命中 → 落 `faq/reuse-served`（观测事件）；未命中 → 落 `faq/reuse-refused`（带 `reason`
        与可行动的 `next_action`，且**不带任何条目内容**）。跨版本**不抛异常**（契约 §4 的注意）。
        """
        norm = question_norm(question)
        same = [rec for rec in self._visible()
                if str(rec.get("package_id")) == str(package_id) and str(rec.get("question_norm")) == norm]
        same.sort(key=lambda rec: _entry_sort_key(rec.get("entry_id")))
        hit = next((rec for rec in same if _rev_eq(rec.get("rfq_rev"), rfq_rev)), None)
        if hit is not None:
            citations = list(hit.get("citations") or [])
            self._append(REUSE_SERVED_EVENT, {
                "entry_id": str(hit.get("entry_id")), "package_id": str(package_id),
                "rfq_rev": int(rfq_rev), "question_norm": norm, "citations": list(citations),
            }, correlation_id=str(hit.get("entry_id")),
                refs={"entry_id": str(hit.get("entry_id")), "package_id": str(package_id),
                      "ticket_id": str(hit.get("source_ticket") or "")})
            return {
                "hit": True, "package_id": str(package_id), "rfq_rev": int(rfq_rev), "question_norm": norm,
                "entry": self._view(hit), "reason": REASON_HIT,
                "next_action": "按条目的 answer_fields 复用该答复；版本绑定不变（复用是读，D-051）",
                "citations": citations,
            }

        if same:
            reason = REASON_VERSION_MISMATCH
            next_action = (
                f"FAQ 复用不得跨版本（D-051 / AC-CLARIFY-004）：本 realm 内该问题的条目绑定在别的版本上，"
                f"不得跨版本复用；要在 rev {int(rfq_rev)} 上复用，请按该版本重新提问并由 human:* 重新发布条目")
        elif self._package_known(str(package_id)):
            reason = REASON_NOT_PUBLISHED
            next_action = ("该问题在当前版本还没有 FAQ 条目：先 clarify.ask/answer 取得答复，"
                           "再由 human:* 发布条目（publish）")
        else:
            reason = REASON_UNKNOWN_PACKAGE
            next_action = ("本 realm 内没有这个包的记录：确认 package_id 与 realm，"
                           "再按当前版本提问并由 human:* 发布条目")
        citations = [f"package:{package_id}@rev{int(rfq_rev)}"]
        self._append(REUSE_REFUSED_EVENT, {
            "package_id": str(package_id), "rfq_rev": int(rfq_rev), "question_norm": norm,
            "reason": reason, "next_action": next_action,
        }, correlation_id=str(package_id), refs={"package_id": str(package_id)})
        return {
            "hit": False, "package_id": str(package_id), "rfq_rev": int(rfq_rev), "question_norm": norm,
            "entry": None, "reason": reason, "next_action": next_action, "citations": citations,
        }

    # ---------------------------------------------------------------- 查询
    def entries(self, *, package_id: str | None = None, rfq_rev: int | None = None) -> list[dict]:
        """本条 realm 的条目（可按包/版本过滤）；按 `entry_id` 排序（确定性）。"""
        out = [rec for rec in self._visible()
               if (package_id is None or str(rec.get("package_id")) == str(package_id))
               and (rfq_rev is None or _rev_eq(rec.get("rfq_rev"), rfq_rev))]
        out.sort(key=lambda rec: _entry_sort_key(rec.get("entry_id")))
        return [self._view(rec) for rec in out]

    def get(self, entry_id: str) -> dict:
        record = next((rec for rec in self._visible()
                       if str(rec.get("entry_id")) == str(entry_id)), None)
        if record is None:
            raise UnknownEntry(
                f"不存在的 FAQ 条目 {entry_id!r}（或不属于本 realm {self.realm!r}：跨 realm 条目不可见）")
        return self._view(record)

    def replay(self) -> dict:
        """从账本重建条目集（**账本是唯一事实源**：重启/新实例看到同样的条目）。"""
        if self.ledger is None:
            return {"replayed": 0, "order": [], "entries": [], "note": "无账本，无法重放"}
        records: dict[str, dict] = {}
        for row in self._rows():
            if str(row.get("type")) != ENTRY_PUBLISHED_EVENT:
                continue
            record = self._record_of(row)
            if record is None:
                continue
            entry_id = str(record["entry_id"])
            if entry_id in records:
                continue                       # append-only：同一 entry_id 只认第一条
            records[entry_id] = record
        self._entries = records
        self._order = sorted(records, key=_entry_sort_key)
        self._counter = max([_entry_number(e) for e in records] or [0])
        return {"replayed": len(records), "order": list(self._order),
                "entries": [self._view(records[e]) for e in self._order]}

    # ==================================================================
    # 内部
    # ==================================================================
    def _rows(self) -> list[dict]:
        if self.ledger is None:
            return []
        return list(self.ledger.read())

    def _realm_of(self, record: dict) -> str:
        return str(record.get("_realm") or "")

    def _visible(self) -> list[dict]:
        """本 realm 可见的条目（跨 realm 条目读侧过滤；顺序 = `entry_id` 序）。"""
        return [self._entries[entry_id] for entry_id in self._order
                if self._entry_visible(self._entries[entry_id])]

    def _entry_visible(self, record: dict) -> bool:
        if not self.realm:
            return True
        return self._realm_of(record) == self.realm

    def _record_of(self, row: dict) -> dict | None:
        """账本行 → 条目记录（视图键 + `_` 私有键）；缺 `entry_id` 的行返回 None。"""
        body = row.get("body") or {}
        entry_id = body.get("entry_id")
        if not entry_id:
            return None
        record = {
            "entry_id": str(entry_id),
            "package_id": body.get("package_id"),
            "rfq_rev": body.get("rfq_rev"),
            "question_norm": body.get("question_norm"),
            "question": body.get("question"),
            "answer_fields": copy.deepcopy(body.get("answer_fields") or {}),
            "source_ticket": body.get("source_ticket"),
            "published_by": body.get("published_by"),
            "published_at": str(row.get("ts") or ""),          # 取自账本行的 ts，不读墙钟
            "citations": [str(item) for item in (body.get("citations") or [])],
            "_realm": str(body.get("realm") or row.get("realm") or ""),
            "_body": copy.deepcopy(body),
            "_refs": {"entry_id": str(entry_id), "package_id": str(body.get("package_id") or ""),
                      "ticket_id": str(body.get("source_ticket") or "")},
        }
        return record

    @staticmethod
    def _view(record: dict) -> dict:
        """条目视图：只出契约 §3 的键（`_` 私有键不出）。"""
        return copy.deepcopy({key: value for key, value in record.items() if not str(key).startswith("_")})

    def _published_entry(self, package_id: str, rfq_rev: int, norm: str, ticket_id: str) -> dict | None:
        for entry_id in self._order:
            record = self._entries[entry_id]
            if not self._entry_visible(record):
                continue
            if (str(record.get("package_id")) == package_id and _rev_eq(record.get("rfq_rev"), rfq_rev)
                    and str(record.get("question_norm")) == norm
                    and str(record.get("source_ticket")) == ticket_id):
                return record
        return None

    def _package_known(self, package_id: str) -> bool:
        return any(self._tickets(package_id=package_id)) or any(
            str(rec.get("package_id")) == package_id for rec in self._visible())

    def _ticket_citations(self, ticket_id: str, package_id: str, rfq_rev: int) -> list[str]:
        """只用既有前缀集合：`ledger:` / `package:`（与 `clarify` / `negotiate` 同风格）。"""
        return [f"ledger:{ticket_id}", f"package:{package_id}@rev{int(rfq_rev)}"]

    # --- 只读 clarify 的账本行（不调用它的任何方法） ----------------------
    def _tickets(self, *, package_id: str | None = None, rfq_rev: int | None = None) -> list[dict]:
        raw: dict[str, dict] = {}
        for row in self._rows():
            type_ = str(row.get("type") or "")
            if not type_.startswith("clarification/"):
                continue
            body = row.get("body") or {}
            ticket_id = body.get("ticket_id")
            if not ticket_id:
                continue
            ticket = raw.get(str(ticket_id))
            if ticket is None:
                ticket = {
                    "ticket_id": str(ticket_id), "package_id": body.get("package_id"),
                    "rfq_rev": body.get("rfq_rev"), "question": str(body.get("question") or ""),
                    # 票单的 realm：`asker_realm`（clarify.ask 默认写自己的 realm），退回行 realm
                    "realm": str(body.get("asker_realm") or row.get("realm") or ""),
                    "status": str(body.get("status") or "open"),
                    "created_at": str(row.get("ts") or ""), "answered": None, "stale": False,
                }
                raw[str(ticket_id)] = ticket
            if body.get("package_id") is not None and not ticket.get("package_id"):
                ticket["package_id"] = body["package_id"]
            if body.get("rfq_rev") is not None and not isinstance(ticket.get("rfq_rev"), int):
                ticket["rfq_rev"] = body["rfq_rev"]
            if body.get("question") and not ticket["question"]:
                ticket["question"] = str(body["question"])
            if body.get("status"):
                ticket["status"] = str(body["status"])
            if type_ == ANSWERED_EVENT and body.get("by"):
                ticket["answered"] = {"by": str(body["by"]), "fields": dict(body.get("fields") or {}),
                                      "at": str(row.get("ts") or "")}
                ticket["status"] = "answered"
            if type_ == REOPENED_EVENT:
                # 包升版后旧答复只对旧版本有效（FR-CLARIFY-003）——条目仍绑在旧版本上
                ticket["stale"] = True
        out = [ticket for ticket in raw.values() if self._ticket_visible(ticket)]
        if package_id is not None:
            out = [ticket for ticket in out if str(ticket.get("package_id")) == str(package_id)]
        if rfq_rev is not None:
            out = [ticket for ticket in out if _rev_eq(ticket.get("rfq_rev"), rfq_rev)]
        out.sort(key=lambda ticket: str(ticket["ticket_id"]))
        return out

    def _ticket_visible(self, ticket: dict) -> bool:
        """票单可见性：只沉淀**本 realm** 的票单（跨 realm 的票单一律不可见）。

        票单 realm 取 `clarify.ask` 写入的 `asker_realm`（有它就按它判，必须与本服务 realm 一致）；
        该键缺失时才退回登记行的账本 realm（那时它表达的就是"这个账本的 realm"）。
        """
        if not self.realm:
            return True
        realm = str(ticket.get("realm") or "")
        if realm:
            return realm == self.realm
        return str(getattr(self.ledger, "realm", "") or "") == self.realm

    def _ticket(self, ticket_id: str) -> dict:
        for ticket in self._tickets():
            if str(ticket["ticket_id"]) == str(ticket_id):
                return ticket
        raise UnknownTicket(
            f"未知工单 {ticket_id!r}：本 realm {self.realm!r} 的账本里没有它"
            f"（跨 realm 的票单不可沉淀）")

    # --- 账本与事件 -------------------------------------------------------
    def _append(self, event: str, body: dict, *, correlation_id: str, actor: str | None = None,
                refs: dict | None = None) -> Any:
        """落账 + 按事件的 @mode 派发（`faq/*` 一律 `fact`；无 waterfall）。

        没有账本时**不追加**（观测事件无处可落，也不能凭空造一条事实）。
        """
        if self.ledger is None:
            return None
        ref = self.ledger.append(event, copy.deepcopy(body), correlation_id=correlation_id,
                                 event_class=EVENT_CLASS, actor=actor or self.actor,
                                 refs=dict(refs or {}))
        self._dispatch(event, dict(body))
        return ref

    def _dispatch(self, event: str, body: dict) -> None:
        """只在总线上**已声明**该事件时派发；未登记（内核表还没接线）时不派发、也不自行发明模式。"""
        if self.events is None:
            return
        mode_of = getattr(self.events, "mode_of", None)
        if mode_of is None or mode_of(event) is None:
            return
        self.events.dispatch(event, copy.deepcopy(body))

    def _ts(self, ref: Any) -> str:
        """账本行的 `ts`（本模块不读墙钟）。"""
        if ref is None or self.ledger is None:
            return ""
        return str(self.ledger.get(ref.seq).get("ts") or "")


def _safe_question(question: Any) -> str | None:
    """条目里的 `question`：**仅当发布者显式给出且非私域**才留（否则 None）。"""
    text = nfc(str(question or "")).strip()
    if not text or contains_private(text):
        return None
    return text
