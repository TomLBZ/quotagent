"""AC-FAQ-001：澄清 FAQ 的沉淀与复用（服务层）——FR-CLARIFY-004 / AC-CLARIFY-004。

规格来源：`docs/design/18-faq-contract.md` §2（8 条不变量）、§3（Entry/Reuse 形状）、§4（方法签名与异常）、
§5（三个 `faq/*` 事件）、§6（机检 12 条）、`docs/work/decisions.md` D-051、
`docs/work/acceptance-criteria.md` `AC-CLARIFY-004`（"FAQ 命中不影响回答的版本绑定（复用不得跨版本）"）。
本机检逐条对应契约 §6 的 12 个机检点（括号里是本文的断言序号）：

  ① 正控：发布后同版本 `reuse` 命中且返回条目（#6/#7）；
  ② **跨版本 `reuse` 必须 `hit=false` 且 `entry is None`**（AC-CLARIFY-004 的正面：#9/#10）；
  ③ 命中**不改任何状态**：票单 `rfq_rev` 与答复内容不变、账本除 `reuse-served` 外无新增（逐条比对 seq：#8）；
  ④ 非 `human:` 发布被拒（`AgentCannotPublish`）且**不落** `entry-published`（#12）；
  ⑤ `publish` 的票单版本与参数不符被拒（`FaqVersionMismatch`），未知票单/未知条目不静默（#13）；
  ⑥ 跨 realm 条目不可见（读侧过滤，票单与条目两侧：#15）；⑦ 私域键不进条目（哨兵文本断言：#14）；
  ⑧ 确定性（两次 `distill` 字节一致：#3/#16）+ 不读墙钟（静态 AST 扫 `time.`/`datetime`/`utc_now`：#16）；
  ⑨ `replay()` 从账本重建（新实例看到同样的条目：#17）；⑩ 不产生义务（无 commitment/PO/报价事件：#18）；
  ⑪ 拒绝路径带 `reason` + `next_action`（#11）；⑫ 账本链仍真（`verify_report()`：#19）。
  另加两条契约面断言：#1（注册元数据 + 异常谱系）、#2（三个 `faq/*` 都是 emit/durable、无 waterfall），
  以及 #20（三本账核对 + 断言数 ≥12 自证）——共 **20 条断言**。

每条断言名里都写了"**反例**"（会变红的那件事）——断言不是形容词，是可被证伪的句子。

【未验证 / 契约耦合（如实写在代码里，不假装通过）】
  · **候选的前置状态**：`distill()` 只按契约 §6 的"已答问题"取候选，本机检用 `ClarificationService`
    真实走 `ask → answer`（**不** close、不 broadcast：broadcast 会为同一票单再追加一条
    `clarification/answered`，那是入参噪声，不该由机检引入）。若实现要求"已广播/已关闭"才算可沉淀，
    第 #3 条会红 —— 那是真源冲突，需要实现方或契约一方让步，不能靠放水掩盖。
  · **`fields` 的私域处理**：契约 §2.5 说"条目只保留……显式声明为可复用的字段"，本机检据此要求
    `publish(fields={白名单 + 私域键})` **成功且过滤**（`answer_fields` 只留白名单）。若实现选择
    "碰到私域键就整条拒绝"，第 #15 条会红。
  · **`entry_id` 形如 `fq-0001`**：契约 §3 的样例给了这个形状，本文只断言 `fq-\\d{4}` 与唯一性，
    不锁死序号从 1 起（那属于实现自由度）。
  · **跨 realm 探针**：用"同账本 + `realm=对方`"的服务实例（这是契约 §2.4"读侧过滤"能构造出的最强探针）。
    若实现不比对 realm，第 #14 条会红。
  · 静态扫描落在**实际被加载的那个模块文件**上（`faq.__file__`），
    因此 `tmp/t257-mutate.py` 的影子变异体也逃不过静态断言。
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

from ..kernel.canon import canonical_json, is_hash
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services import faq as faq_module
from ..services.clarify import ClarificationService
from ..services.faq import (AgentCannotPublish, FaqError, FaqService, FaqVersionMismatch,
                            UnknownEntry, UnknownTicket)
from .registry import REGISTRY, Assertion, register

# 事件类型名取自契约 §5（**名字是契约，不随实现的常量命名走**）
PUBLISHED_EVENT = "faq/entry-published"
SERVED_EVENT = "faq/reuse-served"
REFUSED_EVENT = "faq/reuse-refused"
FAQ_EVENTS = (PUBLISHED_EVENT, SERVED_EVENT, REFUSED_EVENT)
PUBLISH_BODY_KEYS = ("entry_id", "package_id", "rfq_rev", "question_norm", "source_ticket",
                     "published_by", "fields_used")
SERVED_BODY_KEYS = ("entry_id", "package_id", "rfq_rev", "question_norm", "citations")
REFUSED_BODY_KEYS = ("package_id", "rfq_rev", "question_norm", "reason", "next_action")
ENTRY_KEYS = ("entry_id", "package_id", "rfq_rev", "question_norm", "answer_fields", "source_ticket",
              "published_by", "published_at", "citations")
REUSE_KEYS = ("hit", "package_id", "rfq_rev", "question_norm", "entry", "reason", "next_action",
              "citations")
REASONS = ("faq-hit", "faq-version-mismatch", "faq-not-published", "faq-unknown-package")
OBLIGATION_TYPES = ("award/committed", "po/issued", "quote/submitted", "quote/revised",
                    "capacity/committed")
CLOCK_MODULES = ("time", "datetime", "os", "subprocess", "socket", "requests", "urllib", "http")

REALM = "supplier:sup-A"
OTHER_REALM = "buyer:buy-B"
PACKAGE = "pkg-014"
REV = 2
HUMAN = "human:owner"
FOREIGN_TICKET = "cl-9001"     # 对方 realm 的票单（显式 id，避免与本次 clarify 的 cl-0001 撞名）
QUESTION = "管道 DN100 的验收口径与材质证明要求？"
QUESTION_B = "保温层厚度按哪一版附表取值？"

# 白名单字段（契约 §3：unit/deadline_note）与"可复用"的正面证据
PUBLIC_FIELDS = {"unit": "m", "deadline_note": "DEADLINE-NOTE-SENTINEL-t257"}
# 私域键（契约 §2.5 点名）+ 只在私域出现的哨兵值：它们**不许**出现在任何条目/`faq/*` 账本行里
PRIVATE_FIELDS = {"reserve_price": 98765.4321, "cost_model": {"L-001": 74.4876},
                  "signature": "SIGNATURE-SENTINEL-t257", "private:margin_pct": 0.123456789}
FORBIDDEN_TOKENS = ("reserve_price", "cost_model", "signature", "private:",
                    "98765.4321", "SIGNATURE-SENTINEL-t257", "0.123456789", "74.4876")


def _ensure_events(bus: EventBus) -> list:
    """契约 §5 的三个事件：内核表已登记就用它，未登记（父方尚未接线）则由本机检按契约声明。

    三个都是 `emit` + durable、**没有 waterfall**（契约 §5："事件 class 一律 fact；无 waterfall"）。
    """
    added = []
    for name in FAQ_EVENTS:
        if bus.mode_of(name) is None:
            bus.declare(name, "emit", durable=True, reason="D-051：FAQ 族只用 emit 观测，无 waterfall")
            added.append(name)
    return added


def _stack(root: Path, *, realm: str = REALM, tag: str = "main") -> dict:
    """真账本 + 真事件总线 + **真** `ClarificationService`（FAQ 只读它的账本行，不调其内部方法）。"""
    ledger = Ledger(root / f"ledger-{tag}.jsonl", realm=realm)
    bus = EventBus()
    bus.install_defaults()
    added = _ensure_events(bus)
    clarify = ClarificationService(participant="agent:clarify", realm=realm, ledger=ledger,
                                   events=bus, package={"package_id": PACKAGE, "rfq_rev": REV},
                                   registered_bidders=["buyer:b1", "buyer:b2"])
    faq = FaqService(realm=realm, ledger=ledger, events=bus)
    return {"root": root, "ledger": ledger, "bus": bus, "clarify": clarify, "faq": faq,
            "events_added": added}


def _answered_ticket(stack: dict, *, question: str, item: str = "L-001",
                     fields: dict | None = None) -> tuple:
    """真澄清问答（ask → answer），返回 (ticket_id, answer_text)。"""
    ticket = stack["clarify"].ask(package_id=PACKAGE, rfq_rev=REV, refs={"item_ids": [item]},
                                  question=question)
    text = f"{question} → 按 rev{REV} 的附表执行，变更后 3 日内答复。"
    stack["clarify"].answer(ticket_id=ticket["ticket_id"], text=text, by=HUMAN,
                            fields=dict(fields if fields is not None else PUBLIC_FIELDS))
    return ticket["ticket_id"], text


def _attempt(fn) -> object:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 负控就是要看它抛什么
        return exc


def _faq_rows(ledger: Ledger) -> list:
    return [row for row in ledger.read() if str(row["type"]).startswith("faq/")]


def _module_source() -> tuple:
    """实际被加载的那个实现文件（影子变异体也在这里被读到）。"""
    path = Path(getattr(faq_module, "__file__", "") or "")
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    return path, text


def _calls_names_imports(tree: ast.AST) -> tuple:
    calls: set = set()
    names: set = set()
    literals: set = set()
    imports: set = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            literals.add(node.value)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute):
                calls.add(node.func.attr)
            elif isinstance(node.func, ast.Name):
                calls.add(node.func.id)
        elif isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Import):
            imports |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level:
            imports.add((node.module or "").split(".")[0])
    return calls, names, literals, imports


def _carries(text: str, tokens=FORBIDDEN_TOKENS) -> list:
    return [token for token in tokens if token in text]


@register("AC-FAQ-001", "P2",
          "澄清 FAQ 的沉淀与复用：同版本复用命中返回条目、**跨版本一律不命中且不返回任何条目内容**"
          "（AC-CLARIFY-004 的正面）、命中是纯读、非 human: 不得发布、跨 realm 不可见、私域键不进条目、"
          "replay 可从账本重建、不产生任何义务",
          "qa ac AC-FAQ-001", evidence_refs=("EV-093",))
def check_faq_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("faq-001")
    stack = _stack(root)
    ledger, bus, clarify, faq = stack["ledger"], stack["bus"], stack["clarify"], stack["faq"]

    # --- 1. 注册元数据 + 异常谱系（契约 §4） ------------------------------------------------
    meta = REGISTRY.get("AC-FAQ-001")
    hierarchy = (issubclass(FaqError, RuntimeError) and issubclass(AgentCannotPublish, FaqError)
                 and issubclass(UnknownEntry, FaqError) and issubclass(UnknownTicket, FaqError)
                 and issubclass(FaqVersionMismatch, FaqError))
    out.append(Assertion("契约面·注册与异常谱系：AC-FAQ-001 注册为 P2 / `qa ac AC-FAQ-001` / evidence EV-093，"
                         "且 FaqError 是 RuntimeError 子类、四个具体异常都继承 FaqError"
                         "（反例：phase 写成 P1、command 写错、或把 AgentCannotPublish 直接挂 RuntimeError）",
                         meta is not None and meta.phase == "P2" and meta.command == "qa ac AC-FAQ-001"
                         and tuple(meta.evidence_refs) == ("EV-093",) and hierarchy,
                         f"meta={None if meta is None else meta.as_dict()} hierarchy={hierarchy}"))

    # --- 2. 事件模式（契约 §5：三个 emit、durable、无 waterfall） --------------------------
    table = EventBus.DEFAULT_TABLE
    declared = {name: bus.mode_of(name) for name in FAQ_EVENTS}
    durable_ok = all((name not in table) or table[name][1] is True for name in FAQ_EVENTS)
    out.append(Assertion("事件模式与契约 §5 一致：faq/entry-published · faq/reuse-served · faq/reuse-refused "
                         "都是 emit（观测事件，不改状态）、durable、**没有 waterfall**；"
                         "内核表若已登记则必须同名同模式（反例：把 reuse-served 声明成 waterfall/serial，"
                         "或 durable=False 让复用不留痕）",
                         set(declared.values()) == {"emit"} and "waterfall" not in declared.values()
                         and durable_ok
                         and all((name not in table) or table[name][0] == "emit" for name in FAQ_EVENTS),
                         f"modes={declared} 内核表已登记={[n for n in FAQ_EVENTS if n in table]} "
                         f"本机检按契约补登={stack['events_added']} durable_ok={durable_ok}"))

    # --- 3. 真澄清问答 + distill 正控（⑧ 只读与确定性） ------------------------------------
    tid, answer_text = _answered_ticket(stack, question=QUESTION, fields=PUBLIC_FIELDS)
    rows_before = ledger.count
    cands_a = faq.distill(package_id=PACKAGE, rfq_rev=REV)
    cands_b = faq.distill(package_id=PACKAGE, rfq_rev=REV)
    mine = [item for item in cands_a if isinstance(item, dict) and tid in canonical_json(item)]
    other_rev = [item for item in faq.distill(package_id=PACKAGE, rfq_rev=REV + 7)
                 if isinstance(item, dict) and tid in canonical_json(item)]
    unknown_pkg = faq.distill(package_id="pkg-999", rfq_rev=REV)
    out.append(Assertion("正控·沉淀候选（契约 §6-①/§2.8）：已答澄清票单在 `distill(pkg,rev)` 里成为候选"
                         "（候选里能认出 source_ticket=本次票单）；**只读**——distill 前后账本行数一条不增；"
                         "两次 distill 产物**逐字节一致**（canonical JSON）；"
                         "其他版本（rev+7）与未知包（pkg-999）都取不到这个候选"
                         "（反例：distill 顺手落账 / 依赖字典顺序导致两次不同 / 跨版本也返回候选）",
                         bool(mine) and not other_rev and unknown_pkg == []
                         and ledger.count == rows_before
                         and canonical_json(cands_a) == canonical_json(cands_b),
                         f"ticket={tid} 候选={len(cands_a)} 命中本票={len(mine)} 其它版本={len(other_rev)} "
                         f"未知包={len(unknown_pkg)} 账本 {rows_before}→{ledger.count}"))

    # --- 4. publish 正控：Entry 视图（契约 §3） --------------------------------------------
    entry = faq.publish(package_id=PACKAGE, rfq_rev=REV, ticket_id=tid, by=HUMAN,
                        question=QUESTION, fields=dict(PUBLIC_FIELDS))
    pub_rows = ledger.read(type=PUBLISHED_EVENT)
    pub_row = pub_rows[-1] if pub_rows else {}
    citations = entry.get("citations") if isinstance(entry, dict) else None
    cites_ok = (isinstance(citations, list) and citations
                and all(isinstance(item, str) and re.match(r"^[a-z][a-z0-9-]*:.+", item)
                        for item in citations)
                and any(tid in item for item in citations)
                and any(PACKAGE in item for item in citations))
    out.append(Assertion("正控·publish 返回 Entry 视图：键名即契约（entry_id/package_id/rfq_rev/question_norm/"
                         "answer_fields/source_ticket/published_by/published_at/citations）；entry_id 形如 "
                         "`fq-0001`；question_norm 是 `sha256:` 哈希（不存问题原文）；版本绑定 = 本票单的 "
                         "`pkg-014@rev2`；`published_at` **取自账本行的 ts**（不读墙钟）；citations 带 "
                         "`ledger:<票单>` 与 `package:<pkg>@rev<rev>`；answer_fields 只含显式声明的可复用字段"
                         "（反例：published_at 用墙钟/entry_id 无序号/Q8 版本写成 rev3/citations 空）",
                         isinstance(entry, dict) and set(ENTRY_KEYS) <= set(entry)
                         and re.fullmatch(r"fq-\d{4}", str(entry.get("entry_id") or ""))
                         and entry.get("package_id") == PACKAGE and entry.get("rfq_rev") == REV
                         and entry.get("source_ticket") == tid and entry.get("published_by") == HUMAN
                         and is_hash(entry.get("question_norm"))
                         and entry.get("published_at") == pub_row.get("ts")
                         and isinstance(entry.get("answer_fields"), dict)
                         and entry["answer_fields"] == PUBLIC_FIELDS
                         and entry.get("question") in (None, QUESTION)
                         and cites_ok,
                         f"entry={ {k: entry.get(k) for k in ('entry_id', 'package_id', 'rfq_rev', 'source_ticket', 'published_by')} } "
                         f"ts_eq={entry.get('published_at') == pub_row.get('ts')} "
                         f"answer_fields={entry.get('answer_fields')} citations={citations}"))

    # --- 5. publish 落账（契约 §5） --------------------------------------------------------
    body = pub_row.get("body") or {}
    out.append(Assertion("正控·publish 落账：恰有一条 faq/entry-published、class=fact、"
                         "correlation_id=entry_id，body 带契约 §5 的 7 个键"
                         "（entry_id/package_id/rfq_rev/question_norm/source_ticket/published_by/fields_used），"
                         "fields_used 与 answer_fields 一致（声明了什么才用什么）"
                         "（反例：correlation_id 用 package_id / event_class 落成 intent / fields_used 把私域键也列上）",
                         len(pub_rows) == 1 and pub_row.get("class") == "fact"
                         and pub_row.get("correlation_id") == entry.get("entry_id")
                         and set(PUBLISH_BODY_KEYS) <= set(body)
                         and body.get("entry_id") == entry.get("entry_id")
                         and body.get("package_id") == PACKAGE and body.get("rfq_rev") == REV
                         and body.get("question_norm") == entry.get("question_norm")
                         and body.get("source_ticket") == tid and body.get("published_by") == HUMAN
                         and sorted(body.get("fields_used") or []) == sorted(entry["answer_fields"]),
                         f"rows={len(pub_rows)} class={pub_row.get('class')} "
                         f"correlation_id={pub_row.get('correlation_id')} body_keys={sorted(body)}"))

    # --- 6/7/8. 同版本命中（①）+ 落账 + 命中纯读（③） ------------------------------------
    entry_id = entry["entry_id"]
    before_text = ledger.path.read_text(encoding="utf-8")
    before_count = ledger.count
    before_ticket = canonical_json(clarify.ticket(tid))
    before_answered = canonical_json(ledger.read(type="clarification/answered"))
    served_before = len(ledger.read(type=SERVED_EVENT))
    hit = faq.reuse(package_id=PACKAGE, rfq_rev=REV, question=QUESTION)
    hit_entry = hit.get("entry") if isinstance(hit, dict) else None
    out.append(Assertion("正控·同版本 reuse 命中（契约 §6-①）：hit=true、reason=\"faq-hit\"、"
                         "返回**条目本体**且与 `get(entry_id)`/`entries()` 里的同一份逐字节一致；"
                         "package_id/rfq_rev/question_norm 与查询和条目都对得上"
                         "（反例：hit=true 但 entry 为 None（假命中）/命中返回别版本的条目）",
                         isinstance(hit, dict) and hit.get("hit") is True and hit.get("reason") == "faq-hit"
                         and isinstance(hit_entry, dict) and hit_entry.get("entry_id") == entry_id
                         and canonical_json(hit_entry) == canonical_json(faq.get(entry_id))
                         and any(canonical_json(item) == canonical_json(hit_entry)
                                 for item in faq.entries(package_id=PACKAGE, rfq_rev=REV))
                         and hit_entry.get("rfq_rev") == REV and hit.get("package_id") == PACKAGE
                         and hit.get("rfq_rev") == REV
                         and hit.get("question_norm") == hit_entry.get("question_norm"),
                         f"hit={ {k: hit.get(k) for k in ('hit', 'reason', 'package_id', 'rfq_rev')} } "
                         f"entry_id={None if hit_entry is None else hit_entry.get('entry_id')}"))
    served_rows = ledger.read(type=SERVED_EVENT)
    added_text = ledger.path.read_text(encoding="utf-8")[len(before_text):]
    served_body = served_rows[-1]["body"] if served_rows else {}
    out.append(Assertion("正控·命中落 faq/reuse-served（契约 §5）：账本**恰好多一行**（seq+1、"
                         "correlation_id=entry_id、class=fact、body 带 5 个键），且命中不改任何条目"
                         "（entries() 条数不变）"
                         "（反例：命中也落 entry-published / 命中落两条 / body 缺 citations）",
                         len(served_rows) == served_before + 1 and ledger.count == before_count + 1
                         and added_text.count("\n") == 1
                         and json.loads(added_text)["type"] == SERVED_EVENT
                         and served_rows[-1].get("class") == "fact"
                         and served_rows[-1].get("correlation_id") == entry_id
                         and set(SERVED_BODY_KEYS) <= set(served_body)
                         and served_body.get("entry_id") == entry_id
                         and served_body.get("question_norm") == entry.get("question_norm")
                         and len(ledger.read(type=PUBLISHED_EVENT)) == 1,
                         f"served={len(served_rows)}(前 {served_before}) seq={ledger.count}"
                         f"(前 {before_count}) 新增行={added_text.strip()[:150]}"))
    new_rows = ledger.read(from_seq=before_count + 1)
    out.append(Assertion("**命中不改任何状态**（契约 §6-③/§2.2，D-051）：reuse 前后账本**逐字节前缀不变**、"
                         "新增行**只有**一条 faq/reuse-served（逐条比对 seq：没有新的 clarification/*、"
                         "没有新的 faq/entry-published、没有新的条目/票单写入）；票单 rfq_rev=2 与答复正文"
                         "一字未改（内存态与账本行都比对）"
                         "（反例：命中时顺手把 FAQ 答案写回票单、或顺手改票单 rfq_rev——版本绑定被隐式改写）",
                         ledger.path.read_text(encoding="utf-8").startswith(before_text)
                         and [row["type"] for row in new_rows] == [SERVED_EVENT]
                         and [row["seq"] for row in new_rows] == [before_count + 1]
                         and canonical_json(clarify.ticket(tid)) == before_ticket
                         and canonical_json(ledger.read(type="clarification/answered")) == before_answered
                         and clarify.ticket(tid)["rfq_rev"] == REV
                         and clarify.ticket(tid)["answer"]["text"] == answer_text,
                         f"新增行={[row['type'] for row in new_rows]} seq={[row['seq'] for row in new_rows]} "
                         f"票单不变={canonical_json(clarify.ticket(tid)) == before_ticket} "
                         f"答复不变={canonical_json(ledger.read(type='clarification/answered')) == before_answered}"))

    # --- 9/10. **跨版本必须不命中**（AC-CLARIFY-004 的正面） --------------------------------
    mismatch = faq.reuse(package_id=PACKAGE, rfq_rev=REV + 1, question=QUESTION)
    mismatch_json = canonical_json(mismatch)
    out.append(Assertion("**跨版本 reuse 必须 hit=false 且 entry is None**（契约 §6-②/§2.1，D-051，"
                         "AC-CLARIFY-004 的正面）：`faq-version-mismatch` + 可行动 `next_action`；"
                         "Reuse 视图的键不超出契约 §3 的 8 个键，"
                         "且**不返回任何条目内容**（含摘要）——结果里既没有 entry_id，也没有任何私域/白名单字段值"
                         "（反例：跨版本返回\"最接近的另一版本\"条目 / 返回 entry_summary / "
                         "把旧版本 answer_fields 塞回结果）",
                         isinstance(mismatch, dict) and mismatch.get("hit") is False
                         and mismatch.get("entry") is None
                         and mismatch.get("reason") == "faq-version-mismatch"
                         and isinstance(mismatch.get("next_action"), str)
                         and len(mismatch["next_action"].strip()) >= 8
                         and set(mismatch) <= set(REUSE_KEYS)
                         and entry_id not in mismatch_json
                         and "answer_fields" not in mismatch
                         and not _carries(mismatch_json, ("fq-", "DEADLINE-NOTE-SENTINEL-t257")),
                         f"hit={mismatch.get('hit')} entry={mismatch.get('entry')} "
                         f"reason={mismatch.get('reason')!r} next_action={str(mismatch.get('next_action'))[:60]!r} "
                         f"keys={sorted(mismatch)}"))
    refused_rows = ledger.read(type=REFUSED_EVENT)
    refused_body = refused_rows[-1]["body"] if refused_rows else {}
    out.append(Assertion("跨版本拒绝**要留痕且不留内容**（契约 §5）：恰好多一条 faq/reuse-refused、"
                         "class=fact、correlation_id=package_id、body 带 5 个键，"
                         "reason/next_action 与返回值一致，且 body 里没有条目 id、没有条目内容，"
                         "也没有多出一条 reuse-served"
                         "（反例：跨版本静默不落痕 / 拒绝行里塞 entry_id 或摘要）",
                         len(refused_rows) == 1 and refused_rows[-1].get("class") == "fact"
                         and refused_rows[-1].get("correlation_id") == PACKAGE
                         and set(REFUSED_BODY_KEYS) <= set(refused_body)
                         and refused_body.get("package_id") == PACKAGE
                         and refused_body.get("rfq_rev") == REV + 1
                         and refused_body.get("reason") == "faq-version-mismatch"
                         and refused_body.get("next_action") == mismatch.get("next_action")
                         and not _carries(canonical_json(refused_body))
                         and len(ledger.read(type=SERVED_EVENT)) == 1,
                         f"rows={len(refused_rows)} correlation_id={refused_rows[-1].get('correlation_id') if refused_rows else None} "
                         f"body={refused_body}"))

    # --- 11. 拒绝路径都要能指导下一步（⑪） -----------------------------------------------
    unknown_package = faq.reuse(package_id="pkg-999", rfq_rev=REV, question=QUESTION)
    other_question = faq.reuse(package_id=PACKAGE, rfq_rev=REV, question="完全不同的问题：包装与唛头？")
    probes = {"跨版本": mismatch, "未知包": unknown_package, "同版本未发布的问题": other_question}
    probe_ok = {label: (isinstance(value, dict) and value.get("hit") is False
                        and value.get("entry") is None and value.get("reason") in REASONS
                        and value.get("reason") != "faq-hit"
                        and isinstance(value.get("next_action"), str)
                        and len(value["next_action"].strip()) >= 8
                        and set(value) <= set(REUSE_KEYS))
                for label, value in probes.items()}
    refused_after = ledger.read(type=REFUSED_EVENT)
    traced = {row["body"].get("reason") for row in refused_after}
    out.append(Assertion("拒绝路径带 `reason` + 可行动 `next_action`（契约 §6-⑪/§3）：跨版本 / 未知包 / "
                         "同版本未发布的问题三种拒绝都 hit=false + entry=None + reason ∈ 契约 §3 的四值集 "
                         "+ next_action 非空（≥8 字符），且每种都落一条 faq/reuse-refused"
                         "（反例：拒绝只返回 False / reason 自造新词 / 拒绝不带下一步 → 调用方不知道怎么办）",
                         all(probe_ok.values())
                         and {"faq-version-mismatch", "faq-unknown-package"} <= traced
                         and len(refused_after) == len(refused_rows) + 2,
                         f"probes={ {k: (v.get('reason'), str(v.get('next_action'))[:24]) for k, v in probes.items()} } "
                         f"ok={probe_ok} traced={sorted(traced)}"))
    refused_rows = refused_after

    # --- 12. 非 human: 不得发布（④） ------------------------------------------------------
    entries_before = len(faq.entries())
    bad_publish = {by: _attempt(lambda b=by: faq.publish(package_id=PACKAGE, rfq_rev=REV,
                                                         ticket_id=tid, by=b,
                                                         fields=dict(PUBLIC_FIELDS)))
                   for by in ("agent:faq", "human", "")}
    out.append(Assertion("**沉淀必须人发**（契约 §6-④/§2.3）：`by` 不以 `human:` 开头（agent:faq / \"human\" / \"\"）"
                         "一律抛 AgentCannotPublish，**一条 faq/entry-published 都不落**、条目数不变"
                         "（反例：`by.startswith(\"human\")` 放过 \"human\"（无冒号）/ agent 自动沉淀未审内容）",
                         all(isinstance(value, AgentCannotPublish) for value in bad_publish.values())
                         and len(ledger.read(type=PUBLISHED_EVENT)) == 1
                         and len(faq.entries()) == entries_before,
                         f"probes={ {k: type(v).__name__ for k, v in bad_publish.items()} } "
                         f"published={len(ledger.read(type=PUBLISHED_EVENT))} entries={len(faq.entries())}"))

    # --- 13. 版本不符 / 未知票单 / 未知条目（⑤） ------------------------------------------
    version_mismatch = _attempt(lambda: faq.publish(package_id=PACKAGE, rfq_rev=REV + 1, ticket_id=tid,
                                                    by=HUMAN, fields=dict(PUBLIC_FIELDS)))
    unknown_ticket = _attempt(lambda: faq.publish(package_id=PACKAGE, rfq_rev=REV, ticket_id="cl-9999",
                                                  by=HUMAN, fields=dict(PUBLIC_FIELDS)))
    unknown_entry = _attempt(lambda: faq.get("fq-9999"))
    out.append(Assertion("publish 的票单版本不符即拒（契约 §6-⑤/§4：FaqVersionMismatch **只在 publish 用**），"
                         "未知票单抛 UnknownTicket、未知 entry_id 抛 UnknownEntry，三者都**不静默**、"
                         "不落新的 entry-published、不新增条目"
                         "（反例：版本不符时用参数版本发布（旧答复被记成新版本）/ 未知 id 返回 None 或空 dict）",
                         isinstance(version_mismatch, FaqVersionMismatch)
                         and isinstance(unknown_ticket, UnknownTicket)
                         and isinstance(unknown_entry, UnknownEntry)
                         and len(ledger.read(type=PUBLISHED_EVENT)) == 1
                         and len(faq.entries()) == entries_before,
                         f"probes=版本不符:{type(version_mismatch).__name__} 未知票单:{type(unknown_ticket).__name__} "
                         f"未知条目:{type(unknown_entry).__name__} published={len(ledger.read(type=PUBLISHED_EVENT))}"))

    # --- 14. 私域键不进条目（⑦，哨兵文本断言） --------------------------------------------
    tid2, _text2 = _answered_ticket(stack, question=QUESTION_B, item="L-002",
                                    fields={**PUBLIC_FIELDS, **PRIVATE_FIELDS})
    entry2 = faq.publish(package_id=PACKAGE, rfq_rev=REV, ticket_id=tid2, by=HUMAN, question=QUESTION_B,
                         fields={**PUBLIC_FIELDS, **PRIVATE_FIELDS})
    fixtures = canonical_json(ledger.read(type="clarification/answered"))
    views = {"entry": canonical_json(entry2), "hit": canonical_json(hit),
             "entries": canonical_json(faq.entries()), "get": canonical_json(faq.get(entry_id)),
             "distill": canonical_json(faq.distill(package_id=PACKAGE, rfq_rev=REV)),
             "faq_rows": canonical_json([row["body"] for row in _faq_rows(ledger)])}
    leaks = {name: _carries(text) for name, text in views.items() if _carries(text)}
    sentinel_in_source = _carries(fixtures, ("SIGNATURE-SENTINEL-t257", "reserve_price", "private:"))
    out.append(Assertion("**私域不出 realm**（契约 §6-⑦/§2.5，INV-008）：条目只留白名单可复用字段"
                         "（unit/deadline_note 在，且值就是发布者声明的那两个），"
                         "私域键（reserve_price/cost_model/signature/private:）与其哨兵值"
                         "（98765.4321 / SIGNATURE-SENTINEL-t257 / 0.123456789 / 74.4876）"
                         "不出现在任何条目视图（publish/get/entries/reuse/distill）与任何 faq/* 账本行 body 里；"
                         "同时**正控**：这些私域内容确实在澄清答复里（否则本条是空测）"
                         "（反例：把答复 fields 原样拷进条目 / 把成本模型写进 citations）",
                         isinstance(entry2, dict)
                         and entry2.get("answer_fields") == PUBLIC_FIELDS
                         and not leaks and bool(sentinel_in_source),
                         f"answer_fields={entry2.get('answer_fields') if isinstance(entry2, dict) else None} "
                         f"leaks={leaks} 私域在澄清答复里={sentinel_in_source}"))

    # --- 15. 跨 realm：票单不可沉淀、条目不可见（⑥） ---------------------------------------
    foreign_question = "对方 realm 的采购需要单独印记说明吗？"
    foreign = ClarificationService(participant="agent:clarify", realm=OTHER_REALM, ledger=ledger,
                                   events=bus, package={"package_id": PACKAGE, "rfq_rev": REV},
                                   registered_bidders=[])
    foreign.ask(package_id=PACKAGE, rfq_rev=REV, refs={"item_ids": ["L-003"]},
                question=foreign_question, ticket_id=FOREIGN_TICKET)
    foreign.answer(ticket_id=FOREIGN_TICKET, text="对方 realm 的答复（只对对方有效）。", by=HUMAN,
                   fields=dict(PUBLIC_FIELDS))
    foreign_in_distill = [item for item in faq.distill(package_id=PACKAGE, rfq_rev=REV)
                          if FOREIGN_TICKET in canonical_json(item)]
    foreign_publish = _attempt(lambda: faq.publish(package_id=PACKAGE, rfq_rev=REV,
                                                   ticket_id=FOREIGN_TICKET, by=HUMAN,
                                                   fields=dict(PUBLIC_FIELDS)))
    foreign_faq = FaqService(realm=OTHER_REALM, ledger=ledger, events=bus)
    foreign_entry = foreign_faq.publish(package_id=PACKAGE, rfq_rev=REV, ticket_id=FOREIGN_TICKET,
                                        by=HUMAN, question=foreign_question,
                                        fields=dict(PUBLIC_FIELDS))
    seen_by_us = FaqService(realm=REALM, ledger=ledger, events=bus)
    foreign_entry_id = str((foreign_entry or {}).get("entry_id") or "")
    leaked = [item for item in seen_by_us.entries()
              if str(item.get("entry_id")) == foreign_entry_id]
    foreign_get = _attempt(lambda: seen_by_us.get(foreign_entry_id))
    foreign_reuse = seen_by_us.reuse(package_id=PACKAGE, rfq_rev=REV, question=foreign_question)
    foreign_row_ok = (bool(foreign_entry_id)
                      and len(ledger.read(type=PUBLISHED_EVENT,
                                          correlation_id=foreign_entry_id)) == 1)
    out.append(Assertion("**本 realm 内**（契约 §6-⑥/§2.4）：对方 realm 的澄清票单（asker_realm=buyer:buy-B）"
                         "既不进本 realm 的 `distill` 候选，拿它 `publish` 也抛 UnknownTicket（票单不属于本 realm）；"
                         "反过来，对方 realm 的条目（**真**由 realm=buyer:buy-B 的服务发布进同一账本、"
                         "entry-published 行 realm=buyer:buy-B）在本 realm 的 `entries()`/`get()`/`reuse()` 里"
                         "一律不可见——同一个 package+rev+问题，本 realm 侧仍然不命中"
                         "（反例：读侧不按 realm 过滤 → 对方的答复被本 realm 复用，等于把答复外发）",
                         not foreign_in_distill
                         and isinstance(foreign_publish, FaqError)
                         and foreign_row_ok and isinstance(foreign_entry, dict)
                         and foreign_entry.get("rfq_rev") == REV
                         and not leaked
                         and isinstance(foreign_get, UnknownEntry)
                         and foreign_reuse.get("hit") is False
                         and foreign_reuse.get("entry") is None,
                         f"对方票单在 distill 里={len(foreign_in_distill)} "
                         f"本 realm 发布它={type(foreign_publish).__name__} "
                         f"对方条目 id={foreign_entry_id} 行存在={foreign_row_ok} "
                         f"被本 realm 看见={len(leaked)} get={type(foreign_get).__name__} "
                         f"reuse_hit={foreign_reuse.get('hit')}"))

    # --- 16. 确定性 + 不读墙钟（⑧，静态 AST） ---------------------------------------------
    read_path, source = _module_source()
    calls, names, literals, imports = _calls_names_imports(ast.parse(source)) if source else (set(), set(), set(), set())
    clock_calls = sorted(calls & {"now", "utcnow", "today", "time", "monotonic", "perf_counter", "utc_now"})
    clock_names = sorted(names & {"utc_now", "datetime", "time", "time_ns"})
    clock_imports = sorted(imports & set(CLOCK_MODULES))
    reads_count = ledger.count
    twice = {"distill": canonical_json(faq.distill(package_id=PACKAGE, rfq_rev=REV)),
             "entries": canonical_json(faq.entries()),
             "get": canonical_json(faq.get(entry_id))}
    again = {"distill": canonical_json(faq.distill(package_id=PACKAGE, rfq_rev=REV)),
             "entries": canonical_json(faq.entries()),
             "get": canonical_json(faq.get(entry_id))}
    out.append(Assertion("**确定性 + 不读墙钟**（契约 §6-⑧/§2.6/§2.8）：distill/entries/get 各调两次产物"
                         "逐字节一致（canonical JSON，不依赖字典顺序、不依赖墙钟），且这些只读调用一条账本都不写；"
                         "静态 AST 扫实现源码：没有时钟调用（datetime.now/time.time/utcnow/today/utc_now）、"
                         "没有引用 utc_now/datetime/time 名字、没有导入 time/datetime/os/socket/subprocess 等"
                         "时钟与 IO/网络模块（时间只能由账本行 ts 传入）"
                         "（反例：reuse/distill 用 time.time() 排序或写 ts / 导入 datetime 生成 published_at）",
                         set(twice) == set(again)
                         and all(twice[key] == again[key] for key in twice)
                         and ledger.count == reads_count
                         and bool(source) and not clock_calls and not clock_names and not clock_imports,
                         f"bytes={ {k: len(v) for k, v in twice.items()} } 一致="
                         f"{ {k: twice[k] == again[k] for k in twice} } 账本 {reads_count}→{ledger.count} "
                         f"path={read_path} clock_calls={clock_calls} clock_names={clock_names} "
                         f"imports={sorted(imports)}"))

    # --- 17. replay() 从账本重建（⑨） -----------------------------------------------------
    fresh = FaqService(realm=REALM, ledger=ledger, events=bus)
    replayed = fresh.replay()
    replayed2 = fresh.replay()
    out.append(Assertion("`replay()` 从账本重建条目集（契约 §6-⑨/§4，对齐 approval/negotiation.replay）："
                         "**新实例**（同一份 ledger.jsonl）看到与老实例逐字节相同的条目集，`get(entry_id)` 一致，"
                         "`replay()` 返回 dict 且包含两个条目（含 entry_id），两次 replay 产物逐字节一致"
                         "（反例：条目只活在内存 → 重启就没了 / replay 视图与 entries 不一致）",
                         isinstance(replayed, dict)
                         and canonical_json(fresh.entries()) == canonical_json(faq.entries())
                         and canonical_json(replayed) == canonical_json(replayed2)
                         and entry_id in canonical_json(replayed)
                         and canonical_json(fresh.get(entry_id)) == canonical_json(faq.get(entry_id))
                         and len(fresh.entries()) == len(faq.entries()) == 2,
                         f"entries {len(fresh.entries())}/{len(faq.entries())} replay_keys={sorted(replayed)} "
                         f"replay_bytes={len(canonical_json(replayed))}"))

    # --- 18. 不产生义务（⑩，运行期 + 静态） ----------------------------------------------
    all_rows = ledger.read()
    commitments = [row for row in all_rows if row["class"] == "commitment"]
    exits = [row for row in all_rows if row["type"] in OBLIGATION_TYPES]
    faq_rows = _faq_rows(ledger)
    obligation_literals = sorted(lit for lit in literals
                                 if lit == "commitment" or lit.endswith("/committed")
                                 or lit in ("po/issued", "quote/submitted", "quote/revised"))
    out.append(Assertion("**不产生义务**（契约 §6-⑩/§2.7）：整条链跑完后账本里没有 commitment 类事件、"
                         "没有 PO/授标/对外报价事件（award/committed · po/issued · quote/submitted · "
                         "quote/revised · capacity/committed），commitments 投影为空，faq/* 全部是 fact；"
                         "静态 AST 也没有承诺类事件名字面量与承诺出口调用"
                         "（反例：FAQ 命中被当作\"对外承诺\"落 commitment / 复用顺手发报价）",
                         not commitments and not exits
                         and not ledger.project("commitments")["commitments"]
                         and all(row["class"] == "fact" for row in faq_rows)
                         and not obligation_literals
                         and not (calls & {"decide", "issue_po", "submit_quote", "commit", "commit_quote"}),
                         f"commitments={len(commitments)} exits={[row['type'] for row in exits]} "
                         f"faq_rows={len(faq_rows)} classes={sorted({row['class'] for row in faq_rows})} "
                         f"literals={obligation_literals}"))

    # --- 19. 账本链仍真（⑫） -------------------------------------------------------------
    report = ledger.verify_report()
    types_projection = ledger.project("types")["by_type"]
    counts_match = all(types_projection.get(name, 0) == len(ledger.read(type=name))
                       for name in FAQ_EVENTS)
    out.append(Assertion("账本链仍真（契约 §6-⑫）：`verify_report()[\"ok\"]` 为真、`verify_chain()` 为真、"
                         "head_hash = 最后一行 entry_hash、`project(\"types\")` 里 faq/* 的逐类计数 == 实际行数、"
                         "增量投影与全量重建一致（FR-LEDGER-002/003）"
                         "（反例：FAQ 服务直接改写账本文件/绕过 Ledger 追加 → 哈希链断）",
                         report["ok"] is True and ledger.verify_chain() is True
                         and ledger.head_hash == all_rows[-1]["entry_hash"]
                         and ledger.count == len(all_rows) and counts_match
                         and ledger.incremental("types")["by_type"] == types_projection,
                         f"ok={report['ok']} count={ledger.count} head_ok="
                         f"{ledger.head_hash == all_rows[-1]['entry_hash']} counts_match={counts_match} "
                         f"faq_types={ {k: v for k, v in types_projection.items() if k.startswith('faq/')} }"))

    # --- 20. 三本账核对 + 断言数自证（≥12） ----------------------------------------------
    published_rows = ledger.read(type=PUBLISHED_EVENT)
    own_published = [row for row in published_rows if (row.get("body") or {}).get("realm") == REALM]
    foreign_published = [row for row in published_rows
                         if (row.get("body") or {}).get("realm") == OTHER_REALM]
    served_rows = ledger.read(type=SERVED_EVENT)
    refused_rows = ledger.read(type=REFUSED_EVENT)
    out.append(Assertion("账本三本账核对与本机检自证：本 realm 人发的 faq/entry-published == 2、"
                         "对方 realm 的条目 == 1（跨 realm 探针造的真条目，本 realm 一条都看不见）、"
                         "faq/reuse-served == 1（整条链只有一次命中）、faq/reuse-refused ≥ 3 且 reason 覆盖 "
                         "faq-version-mismatch/faq-unknown-package；断言数 ≥ 12（契约 §6 的下限）"
                         "（反例：命中被静默吞掉不落痕 / 拒绝不留痕 / 断言数不足 12 却宣称覆盖 12 条）",
                         len(own_published) == 2 and len(foreign_published) == 1
                         and len(served_rows) == 1 and len(refused_rows) >= 3
                         and {"faq-version-mismatch", "faq-unknown-package"}
                         <= {row["body"].get("reason") for row in refused_rows}
                         and len(out) + 1 >= 12,
                         f"本realm已发布={len(own_published)} 对方realm={len(foreign_published)} "
                         f"served={len(served_rows)} refused={len(refused_rows)} reasons="
                         f"{sorted({row['body'].get('reason') for row in refused_rows})} 断言数={len(out) + 1}"))

    return out
