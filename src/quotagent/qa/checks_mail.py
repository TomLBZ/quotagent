"""AC-MAIL-001：邮件集成（无凭据部分）——FR-INTEG-003 / D-052 / AC-MAIL-001。

规格来源：`docs/design/19-mail-contract.md`（§0 边界、§1 八条不变量、§2 数据结构、§3 方法签名与异常、
§4 三个 `mail/*` 事件、§5 机检 12 条）、`docs/work/decisions.md` D-052、
`docs/work/acceptance-criteria.md` 的 `AC-MAIL-001` 行。本机检逐条对应契约 §5 的 12 个机检点
（括号里是本文的断言序号）：

  ① 正控：`compose` 的产物能被标准库 `email` 解析回来、关键头一致（#3）；
  ② **确定性**：同输入两次 `compose` 字节一致（#4）+ 静态 AST 扫 `time.`/`datetime`/`utc_now` → 无（#4）；
  ③ **头注入**：`to`/`subject`/`from` 含 `\\r\\n` → `HeaderInjectionRejected` 且**账本无新增**（#5）；
  ④ **不假装发送**：`deliver()` 返回 `unavailable` + `reason` + `next_action`、落 `mail/refused`、
     **账本无 `mail/sent`**（#6）+ `transport_status()` 只读（#7）；
  ⑤ 幂等：同键重复 `enqueue` → `duplicate=true` 且账本不新增（#9）；
  ⑥ 私域哨兵不进报文与账本 body（#11）；⑦ 附件：`text/*` 带 sha256、`application/*` → `UnsupportedAttachment`（#10）；
  ⑧ `parse` 纯函数（不落账、不写文件）+ `candidate_package_id` 只在主题里显式标记时才有值（#12/#13）；
  ⑨ 畸形报文 → `ok=false` + `reason` + `next_action`（不抛未捕获异常）（#14）；
  ⑩ 跨 realm 候选不可见（#15）；⑪ `replay()` 重建（#16）；⑫ 不产生义务（#17）+ 账本链仍真（#18）。
  另加两条契约面断言：#1（注册元数据 + 异常谱系）、#2（三个 `mail/*` 都是 emit/durable、无 waterfall，
  **且没有 `mail/sent`**），以及 #18 里的三本账核对 + 断言数 ≥12 自证 —— 共 **18 条断言**。

每条断言名里都写了"**反例**"（会变红的那件事，即什么情况下它会变红）——断言不是形容词，是可被证伪的句子。

【未验证 / 契约耦合（如实写在代码里，不假装通过）】
  · **`compose` 的原始报文放在哪**：契约 §2 的 Message 视图键里**没有** `raw`/`eml` 字段，但 §5-①
    要求"产物能被 `email` 解析回来"。本机检把"原始报文"当**可发现物**：先按常见键名
    （`raw`/`raw_bytes`/`raw_message`/`eml`/`message`/`rfc5322`/`data`/`payload`）找，找不到就找
    `raw()/eml()/to_bytes()/render()` 之类的方法，再找不到就看 `get(message_id)` 视图，
    都没有 → 第 #3 条红（判据：**暴露不出原始报文，就没人能验证它是不是合法 RFC 5322**）。
  · **`parse()` 纯函数 vs `mail/parsed` 事件**：契约 §1.6/§5-⑧ 明确 `parse()` 不落账、不写文件，
    但 §4 又声明了 `mail/parsed`（`correlation_id=body_sha256`），而 §3 没有任何"投递/受理"方法去落它。
    本机检因此**只**要求 `parse()` 不落账（硬），并要求三个 `mail/*` 在事件表里都是 emit/durable
    （硬），**不**要求 `parse()` 落 `mail/parsed`（那会与 §1.6 直接冲突）。谁落 `mail/parsed` 属于
    契约的悬空处，不靠放水掩盖。
  · **`candidates()` 的数据来源**：契约没说候选是内存态还是从账本 `mail/parsed` 行重建。
    第 #15 条的做法是**两侧探针**：① 往账本植入一条 `realm=对方` 的 `mail/parsed` 事实行，
    本 realm 的 `candidates()` 不许看见它；② 用"同账本 + `realm=对方`"的服务实例（真 `MailService`）
    解析一条对方报文，双方都不许看见对方的候选。若实现把候选只放内存（根本不读账本），
    第 ① 个探针是**弱探针**（不可能红）——判别力如实写在 detail 的 `对方实例可见=` 里。
  · **主题里的"显式标记"语法**：契约 §2 只写"只从主题里的**显式**标记取"，没给语法。
    第 #13 条对 `[pkg-014] …` 与 `pkg-014 …` 两种写法**至少一种**要能取到 `pkg-014`，
    并硬要求"主题里没有包号 → None（不许猜）"、"主题里写的是 `pkg-999` → 只能是 `pkg-999` 或 None
    （绝不许返回 `pkg-014`）"。若实现只认括号形式，第 #13 条仍应绿（另一种写法由"至少一种"兜住）。
  · **私域哨兵的处理方式**：契约 §1.4 说"正文/头里不得出现私域值"，没规定是"拒绝"还是"剥离"。
    第 #11 条两种都算过：抛 `MailError` 算过；若接受了，则哨兵（键名与值）在报文与账本里都**不许出现**。
  · **`enqueue` 的拒绝语义**：`deliver(未知 id)` 契约没写是抛 `UnknownMessage` 还是返回拒绝。
    第 #6 条要求"不静默"：要么抛 `MailError`（不含 `MailTransportUnavailable`——那个只在显式要求发送时抛），
    要么返回一个**不含** `"sent"`/`ok=true` 的解释性结果，二者皆可，且都不许落 `mail/sent`；
    它若顺手也落一条拒绝痕，只能是 `mail/refused`（本机检允许"我们这条报文恰 1 条 + 未知 id 至多 1 条"）。
  · **Message 视图的容器类型**：契约 §2 给的是键值结构，本条按 `dict` 判（`dict` 子类也算）。
    若实现返回 dataclass/namedtuple 视图，第 #3 条会红 —— 那是接口约定的分歧，需父方裁决，不能靠放水掩盖。
  · **`date` 的线上形态（实测踩到的坑）**：契约 §2 的 `date` 是 ISO8601（`2026-09-21T09:30:00Z`），
    而 `email.policy.default` 的 `DateHeader` **解析不了 ISO8601**：`msg["Date"] = "<ISO8601>"` 之后
    序列化出来是一个**空的 `Date:`**（时间戳整条丢掉）。所以第 #3 条既接受"头里就是那个 ISO8601 原值"，
    也接受"头里是等价的时间点（含 2026）"；但**空的 `Date:` 一律红** —— 报文丢了时间戳是真缺陷，
    不是机检洁癖。（修法：临时切 `email.policy.compat32` 写原始头值，或把参数格式化成 RFC 2822。）
  · **multipart 的 MIME boundary（实测踩到的坑）**：stdlib `email` 的 boundary 来自
    `random.randrange`，不显式钉住的话**同输入两次 compose 的字节不可能一致**（契约 §1.2 直接不成立）。
    第 #4 条因此专门用"带附件的报文"再探一次字节一致性（不是只探无附件的简单报文）。
  · 静态扫描落在**实际被加载的那个模块文件**上（`mail.__file__`），
    因此 `tmp/t258-qa-mutate.py` 的影子变异体也逃不过静态断言。
"""

from __future__ import annotations

import ast
import hashlib
import re
from email.parser import BytesParser
from email.policy import default as EMAIL_POLICY
from email.utils import getaddresses
from pathlib import Path
from typing import Any

from ..kernel.canon import canonical_json, is_hash
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services import mail as mail_module
from ..services.mail import (HeaderInjectionRejected, MailError, MailService, MailTransportUnavailable,
                             UnsupportedAttachment, UnknownMessage)
from .registry import REGISTRY, Assertion, register

# --- 事件与键名取自契约（**名字是契约**，不随实现的常量命名走） ------------------------------
QUEUED_EVENT = "mail/queued"
REFUSED_EVENT = "mail/refused"
PARSED_EVENT = "mail/parsed"
SENT_EVENT = "mail/sent"          # 契约 §4：本轮**不声明**（声明了就会有人以为能发）
MAIL_EVENTS = (QUEUED_EVENT, REFUSED_EVENT, PARSED_EVENT)
QUEUED_BODY_KEYS = ("message_id", "kind", "package_id", "rfq_rev", "to", "from", "subject",
                    "body_sha256", "bytes", "realm")
REFUSED_BODY_KEYS = ("message_id", "reason", "next_action", "transport_available")
MESSAGE_KEYS = ("message_id", "kind", "package_id", "rfq_rev", "to", "from", "subject", "date",
                "body_sha256", "bytes", "realm", "citations")
PARSE_KEYS = ("ok", "from", "to", "subject", "date", "body_sha256", "attachments",
              "candidate_package_id", "realm")   # `reason`/`next_action` 只在失败时硬要求
OBLIGATION_TYPES = ("award/committed", "po/issued", "quote/submitted", "quote/revised",
                    "capacity/committed")
OBLIGATION_LITERALS = ("award/committed", "po/issued", "quote/submitted", "quote/revised",
                       "capacity/committed")
CLOCK_MODULES = ("time", "datetime")                       # 契约 §5-②：时间只能由参数传入
NETWORK_MODULES = ("smtplib", "imaplib", "poplib", "socket", "subprocess")   # D-052：本轮不真收发
CLOCK_CALLS = ("now", "utcnow", "utc_now", "today", "monotonic", "perf_counter", "time", "time_ns")
CLOCK_NAMES = ("utc_now", "datetime", "time", "time_ns")
TRANSPORT_REASON = "mail-transport-unavailable"     # 契约 §0 逐字给出

REALM = "contractor:con-B"
OTHER_REALM = "buyer:buy-B"
PACKAGE = "pkg-014"
OTHER_PACKAGE = "pkg-999"
REV = 2
SENDER = "contractor@example.com"
TO = ["supplier@example.com", "buyer@example.com"]
DATE = "2026-09-21T09:30:00Z"
SUBJECT = "[pkg-014] RFQ notice rev2"
BODY = "BODY-SENTINEL-t258: please quote per rev2 attachment."
BODY_B = "BODY-SENTINEL-t258-B: revised subject line."
# 附件（正文里不放换行：避免 CRLF 归一化把 sha256 断言变成假红）
ATT_PAYLOAD = "ATTACH-PAYLOAD-t258,1,2,3"
ATT_FILENAME = "items.csv"
ATT_CTYPE = "text/csv"
APPLICATION_CTYPE = "application/octet-stream"
# 私域哨兵（契约 §1.4 点名的键 + 只在私域出现的值）
PRIVATE_TEXT = ("internal: reserve_price=98765.4321; cost_model={\"L-001\":74.4876}; "
                "signature=SIGNATURE-SENTINEL-t258; private:margin_pct=0.123456789")
FORBIDDEN_TOKENS = ("reserve_price", "cost_model", "signature", "private:",
                    "98765.4321", "SIGNATURE-SENTINEL-t258", "0.123456789", "74.4876")
FOREIGN_SENTINEL = "FOREIGN-SENTINEL-t258"


def _sha_hex(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(bytes(data)).hexdigest()


def _hash(data) -> str:
    return "sha256:" + _sha_hex(data)


def _ensure_events(bus: EventBus) -> list:
    """契约 §4 的三个事件：内核表已登记就用它，未登记（父方尚未接线）则按契约声明。

    三个都是 `emit` + durable、**没有 waterfall**（契约 §4：\"一律 fact；无 waterfall\"）。
    """
    added = []
    for name in MAIL_EVENTS:
        if bus.mode_of(name) is None:
            bus.declare(name, "emit", durable=True, reason="D-052：mail 族只用 emit 观测，无 waterfall")
            added.append(name)
    return added


def _stack(root: Path, *, realm: str = REALM, tag: str = "main") -> dict:
    ledger = Ledger(root / ("ledger-%s.jsonl" % tag), realm=realm)
    bus = EventBus()
    bus.install_defaults()
    added = _ensure_events(bus)
    mail = MailService(realm=realm, ledger=ledger, events=bus)
    return {"root": root, "ledger": ledger, "bus": bus, "mail": mail, "events_added": added}


def _attempt(fn) -> object:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 负控就是要看它抛什么
        return exc


def _mail_rows(ledger: Ledger) -> list:
    return [row for row in ledger.read() if str(row["type"]).startswith("mail/")]


def _module_source() -> tuple:
    """实际被加载的那个实现文件（影子变异体也在这里被读到）。"""
    path = Path(getattr(mail_module, "__file__", "") or "")
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


def _looks_like_message(value) -> bool:
    """像一份 RFC 5322 报文吗（有 `From:`/`To:`/`Subject:`/`Date:` 之类的头行）。"""
    if isinstance(value, (bytes, bytearray)):
        text = bytes(value).decode("utf-8", "replace")
    elif isinstance(value, str):
        text = value
    else:
        return False
    return bool(re.search(r"(?m)^(From|To|Subject|Date|Message-ID)\s*:", text)) and "\n" in text


_RAW_KEYS = ("raw", "raw_bytes", "raw_message", "eml", "rfc5322", "message_bytes", "source",
             "data", "payload", "bytes_raw")
_RAW_METHODS = ("raw", "raw_bytes", "eml", "to_bytes", "render", "raw_message")


def _find_raw(view, *, depth: int = 0):
    if not isinstance(view, dict) or depth > 2:
        return None
    for key in _RAW_KEYS:
        value = view.get(key)
        if _looks_like_message(value):
            return value
    for value in view.values():
        if isinstance(value, dict):
            found = _find_raw(value, depth=depth + 1)
            if found is not None:
                return found
    return None


def _raw_of(mail: MailService, message: dict) -> tuple:
    """找 compose 的原始报文；返回 (raw|None, 来源说明)。"""
    found = _find_raw(message)
    if found is not None:
        return found, "视图字段"
    message_id = (message or {}).get("message_id")
    for name in _RAW_METHODS:
        method = getattr(mail, name, None)
        if not callable(method) or name in ("get", "parse", "enqueue", "deliver", "compose", "replay"):
            continue
        try:
            value = method(message_id)
        except Exception:  # noqa: BLE001 —— 试探性调用，签名不符就走下一个
            continue
        if _looks_like_message(value):
            return value, "服务方法 %s()" % name
    got = _attempt(lambda: mail.get(message_id))
    if isinstance(got, dict):
        found = _find_raw(got)
        if found is not None:
            return found, "get() 视图"
    return None, "未找到（契约 §5-① 要求产物可被解析回来，必须能拿到原始报文）"


def _as_text(raw) -> str:
    return raw if isinstance(raw, str) else bytes(raw).decode("utf-8", "replace")


def _as_bytes(raw) -> bytes:
    return raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode("utf-8")


def _carries(text: str, tokens=FORBIDDEN_TOKENS) -> list:
    return [token for token in tokens if token in text]


def _jsonable(obj, *, depth: int = 0):
    """把实现返回的视图转成可 JSON 化的结构：bytes → utf-8 文本（不可解码就退成转义文本）。

    机检自己不能被"视图里带了个 bytes 字段"搞崩 —— 崩了就只能报"执行异常"，那不是断言。
    """
    if depth > 6:
        return "<too-deep>"
    if isinstance(obj, (bytes, bytearray)):
        return bytes(obj).decode("utf-8", "replace")
    if isinstance(obj, dict):
        return {str(key): _jsonable(value, depth=depth + 1) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(item, depth=depth + 1) for item in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return repr(obj)


def _safe_json(obj) -> str:
    """`canonical_json` 的稳版本：实现给的视图里可能有 bytes / 自定义对象。"""
    return canonical_json(_jsonable(obj))


def _date_header_of(parsed_msg, raw) -> str:
    """取 Date 头：契约 §2 的 `date` 是 ISO8601（**不是** RFC 2822），`email.policy.default` 的
    `DateHeader` 解析不了它、`str()` 会给出空串 —— 因此取不到时回落到原始报文里的那个头行。"""
    try:
        value = str(parsed_msg.get("Date") or "")
    except Exception:  # noqa: BLE001
        value = ""
    if value:
        return value
    match = re.search(r"(?mi)^Date:[ \t]*(.+?)[ \t]*$", _as_text(raw))
    return match.group(1).strip() if match else ""


def _compose(mail: MailService, **overrides) -> dict:
    kwargs = {"kind": "rfq-notice", "package_id": PACKAGE, "rfq_rev": REV, "sender": SENDER,
              "to": list(TO), "subject": SUBJECT, "body": BODY, "date": DATE}
    kwargs.update(overrides)
    return mail.compose(**kwargs)


def _compose_with_attachment(mail: MailService, *, filename: str, content_type: str, payload: str,
                             **overrides) -> tuple:
    """附件入参的键名契约没写；按 content/data/text/body 依次试，返回 (结果或异常, 命中的键名)。

    若实现按业务拒绝（`UnsupportedAttachment` 等 `MailError`），**立即**把它当结果返回——
    不能靠换键名把"拒绝"试成"通过"。
    """
    notes = []
    for key in ("content", "data", "text", "body", "payload"):
        attachment = {"filename": filename, "content_type": content_type, key: payload}
        try:
            return _compose(mail, attachments=[attachment], **overrides), key
        except MailError as exc:
            if isinstance(exc, UnsupportedAttachment):
                return exc, key
            notes.append("%s:%s" % (key, type(exc).__name__))
        except (TypeError, KeyError, AttributeError) as exc:
            notes.append("%s:%s" % (key, type(exc).__name__))
    return None, "无可用键名(%s)" % ",".join(notes)


def _snapshot(path: Path) -> tuple:
    entries = sorted(str(item.relative_to(path)) for item in path.rglob("*"))
    sizes = sorted((str(item.relative_to(path)), item.stat().st_size)
                   for item in path.rglob("*") if item.is_file())
    return entries, sizes


@register("AC-MAIL-001", "P2",
          "邮件集成（无凭据部分）：`compose` 确定性且可被标准库 `email` 解析回来；头注入被拒**且不落账**；"
          "无传输实现时 `deliver()` 返回 `unavailable` + `reason` + `next_action` 并落 `mail/refused`，"
          "**账本无 `mail/sent`**；同键重复 `enqueue` 幂等；私域哨兵不进报文与账本；`text/*` 附件带 sha256、"
          "`application/*` 被拒；`parse` 纯函数且畸形输入不崩；跨 realm 候选不可见；`replay()` 可重建；"
          "不产生义务；账本链仍真",
          "qa ac AC-MAIL-001", evidence_refs=("EV-094",))
def check_mail_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("mail-001")
    stack = _stack(root)
    ledger, bus, mail = stack["ledger"], stack["bus"], stack["mail"]

    # --- 1. 注册元数据 + 异常谱系（契约 §3） ----------------------------------------------
    meta = REGISTRY.get("AC-MAIL-001")
    hierarchy = (issubclass(MailError, RuntimeError)
                 and issubclass(HeaderInjectionRejected, MailError)
                 and issubclass(UnsupportedAttachment, MailError)
                 and issubclass(UnknownMessage, MailError)
                 and issubclass(MailTransportUnavailable, MailError))
    out.append(Assertion("契约面·注册与异常谱系：AC-MAIL-001 注册为 P2 / `qa ac AC-MAIL-001` / evidence EV-094，"
                         "且 MailError 是 RuntimeError 子类、HeaderInjectionRejected / UnsupportedAttachment / "
                         "UnknownMessage / MailTransportUnavailable 四个具体异常都继承 MailError"
                         "（反例：phase 写成 P1、command 写错、或把 HeaderInjectionRejected 直接挂 RuntimeError）",
                         meta is not None and meta.phase == "P2" and meta.command == "qa ac AC-MAIL-001"
                         and tuple(meta.evidence_refs) == ("EV-094",) and hierarchy,
                         "meta=%s hierarchy=%s" % (None if meta is None else meta.as_dict(), hierarchy)))

    # --- 2. 事件模式（契约 §4：三个 emit、durable、无 waterfall；**没有 mail/sent**） --------
    table = EventBus.DEFAULT_TABLE
    declared = {name: bus.mode_of(name) for name in MAIL_EVENTS}
    durable_ok = all((name not in table) or table[name][1] is True for name in MAIL_EVENTS)
    sent_free = bus.mode_of(SENT_EVENT) is None and SENT_EVENT not in table
    out.append(Assertion("事件模式与契约 §4 一致：mail/queued · mail/refused · mail/parsed 都是 emit"
                         "（观测事件，不改状态）、durable、**没有 waterfall**；内核表若已登记则必须同名同模式；"
                         "且 **`mail/sent` 没有被声明**（不在内核表、也不在事件总线上）"
                         "（反例：把 mail/refused 声明成 waterfall/serial，或 durable=False 让拒绝不留痕，"
                         "或顺手声明 mail/sent 让后人以为能发信）",
                         set(declared.values()) == {"emit"} and "waterfall" not in declared.values()
                         and durable_ok and sent_free
                         and all((name not in table) or table[name][0] == "emit" for name in MAIL_EVENTS),
                         "modes=%s 内核表已登记=%s 本机检按契约补登=%s durable_ok=%s mail/sent 未声明=%s"
                         % (declared, [n for n in MAIL_EVENTS if n in table], stack["events_added"],
                            durable_ok, sent_free)))

    # --- 3. 正控·compose 产物可被标准库 email 解析回来、关键头一致（契约 §5-①/§2） ----------
    written_before = _snapshot(root)
    count_before_compose = ledger.count
    message = _compose(mail)
    raw, raw_source = _raw_of(mail, message)
    parsed_view: Any = None
    if raw is not None:
        parsed_view = _attempt(lambda: BytesParser(policy=EMAIL_POLICY).parsebytes(_as_bytes(raw)))
    header_ok = False
    header_detail = "raw=%s" % raw_source
    parsed_msg = parsed_view if hasattr(parsed_view, "get_all") else None
    if parsed_msg is not None:
        to_addrs = {addr.lower() for _name, addr in getaddresses(
            [str(item) for item in (parsed_msg.get_all("To") or [])])}
        from_addrs = {addr.lower() for _name, addr in getaddresses(
            [str(item) for item in (parsed_msg.get_all("From") or [])])}
        date_header = _date_header_of(parsed_msg, raw)
        header_ok = (str(parsed_msg.get("Subject") or "") == SUBJECT
                     and to_addrs == {addr.lower() for addr in TO}
                     and from_addrs == {SENDER.lower()}
                     and (date_header == DATE or "2026" in date_header)
                     and BODY.split(":")[0] in _as_text(raw))
        header_detail += (" subject=%r to=%s from=%s date=%r"
                          % (str(parsed_msg.get("Subject") or ""), sorted(to_addrs),
                             sorted(from_addrs), date_header))
    view_ok = (isinstance(message, dict) and set(MESSAGE_KEYS) <= set(message)
               and re.fullmatch(r"ml-\d{4}", str(message.get("message_id") or "")) is not None
               and message.get("kind") == "rfq-notice" and message.get("package_id") == PACKAGE
               and message.get("rfq_rev") == REV and list(message.get("to") or []) == TO
               and message.get("from") == SENDER and message.get("subject") == SUBJECT
               and message.get("date") == DATE and message.get("realm") == REALM
               and is_hash(message.get("body_sha256"))
               and isinstance(message.get("bytes"), int) and message["bytes"] >= len(BODY.encode("utf-8"))
               and isinstance(message.get("citations"), list) and message["citations"]
               and any(PACKAGE in str(item) and str(REV) in str(item) for item in message["citations"]))
    out.append(Assertion("正控·compose 的 Message 视图键名即契约（§2 的 12 个键都在：message_id/kind/package_id/"
                         "rfq_rev/to/from/subject/date/body_sha256/bytes/realm/citations），message_id 形如 "
                         "`ml-0001`、date 就是**参数传入**的那个 ISO8601、realm 是本 realm、body_sha256 是 "
                         "`sha256:` 哈希、citations 带本包本版本；**且产物是一份真的 RFC 5322 报文**："
                         "用标准库 `email` 解析回来后 Subject / To / From / Date 关键头与视图逐一对得上，"
                         "正文也在里面（反例：message_id 无序号 / date 用墙钟顶掉参数 / citations 空 / "
                         "compose 只返回一个描述而根本产不出可解析的报文 / 头被写成别的值）",
                         view_ok and header_ok,
                         "view_ok=%s header_ok=%s raw 来源=%s %s keys=%s"
                         % (view_ok, header_ok, raw_source, header_detail,
                            sorted(message) if isinstance(message, dict) else message)))
    compose_readonly = (ledger.count == count_before_compose and _snapshot(root) == written_before)
    out.append(Assertion("正控·compose 是**只读**的（不是“投递”）：一次成功 compose 前后账本行数一条不增、"
                         "工作目录里的文件一个不多（契约 §3：compose 返回 Message 视图，**不落账**）"
                         "（反例：compose 顺手落 mail/queued，把“构造”和“投递”混成一件事）",
                         compose_readonly,
                         "账本 %s→%s 目录一致=%s" % (count_before_compose, ledger.count,
                                                   _snapshot(root) == written_before)))

    # --- 4. 确定性 + 不读墙钟（契约 §5-②/§1.2，运行期 + 静态 AST） -------------------------
    message2 = _compose(mail)
    raw2, _src2 = _raw_of(mail, message2)
    other_mail_instance = MailService(realm=REALM, ledger=ledger, events=bus)
    message3 = _compose(other_mail_instance)
    raw3, _src3 = _raw_of(other_mail_instance, message3)
    view_a = {k: v for k, v in message.items() if k != "message_id"}
    view_b = {k: v for k, v in message2.items() if k != "message_id"}
    view_c = {k: v for k, v in message3.items() if k != "message_id"}
    raw_bytes = _as_bytes(raw) if raw is not None else None
    bytes_stable = (raw is not None and raw2 is not None and raw3 is not None
                    and raw_bytes == _as_bytes(raw2) == _as_bytes(raw3))
    hash_stable = (message.get("body_sha256") == message2.get("body_sha256")
                   == message3.get("body_sha256") is not None)
    changed = _compose(mail, body=BODY + " x")
    hash_differs = changed.get("body_sha256") != message.get("body_sha256")
    # 带附件的报文也要字节稳定：stdlib `email` 默认用 **随机 boundary**，不显式钉住 boundary 的实现
    # 在 multipart 上立刻"两次不同"（这是真源冲突里最容易漏的一条，所以单独探）。
    det_a, det_key = _compose_with_attachment(mail, filename="det.csv", content_type="text/csv",
                                              payload="DET-PAYLOAD-t258")
    det_b, _det_key_b = _compose_with_attachment(mail, filename="det.csv", content_type="text/csv",
                                                 payload="DET-PAYLOAD-t258")
    det_raw_a = _raw_of(mail, det_a)[0] if isinstance(det_a, dict) else None
    det_raw_b = _raw_of(mail, det_b)[0] if isinstance(det_b, dict) else None
    multipart_det = (isinstance(det_a, MailError)          # 附件被拒 → 那是 #10 的判据，不在这里罚
                     or (det_raw_a is not None and det_raw_b is not None
                         and _as_bytes(det_raw_a) == _as_bytes(det_raw_b)))
    read_path, source = _module_source()
    calls, names, _literals, imports = (_calls_names_imports(ast.parse(source)) if source
                                        else (set(), set(), set(), set()))
    clock_calls = sorted(calls & set(CLOCK_CALLS))
    clock_names = sorted(names & set(CLOCK_NAMES))
    clock_imports = sorted(imports & set(CLOCK_MODULES))
    net_imports = sorted(imports & set(NETWORK_MODULES))
    out.append(Assertion("**确定性 + 不读墙钟**（契约 §5-②/§1.2/D-042）：同输入两次 compose（**跨两个服务实例**）"
                         "产出的报文**逐字节一致**（含 Date 头；**带附件时也一致** —— 也就是 MIME 边界"
                         "必须是确定的，不能是 stdlib `email` 默认的随机 boundary）、body_sha256 一致；"
                         "换一个字节的正文 → body_sha256 必变（不是常量哈希）；视图除 message_id 外逐字节一致；"
                         "静态 AST 扫实现源码：没有时钟调用（now/utcnow/today/utc_now/time/monotonic）、"
                         "没有引用 utc_now/datetime/time 名字、没有 import time/datetime；"
                         "也没有 import smtplib/imaplib/poplib/socket/subprocess（D-052：本轮不真收发）"
                         "（反例：compose 里用 datetime.now() 生成 Date 或 Message-ID → 两次字节不同、"
                         "重启后同输入也不同；不钉 boundary 让 multipart 报文每次都不一样；"
                         "或偷偷 import smtplib 准备“顺手发一下”）",
                         bool(message.get("body_sha256")) and bytes_stable and hash_stable and hash_differs
                         and view_a == view_b == view_c and multipart_det
                         and bool(source) and not clock_calls and not clock_names and not clock_imports
                         and not net_imports,
                         "字节一致=%s 哈希一致=%s 换正文哈希变=%s 视图(除 message_id)一致=%s "
                         "附件报文字节一致=%s（附件键名=%s）实现=%s "
                         "clock_calls=%s clock_names=%s clock_imports=%s net_imports=%s"
                         % (bytes_stable, hash_stable, hash_differs, view_a == view_b == view_c,
                            multipart_det, det_key, read_path, clock_calls, clock_names,
                            clock_imports, net_imports)))

    # --- 5. 头注入：拒绝且不落账（契约 §5-③/§1.3） ----------------------------------------
    injections = {
        "to": {"to": ["ok@example.com\r\nBcc: evil@example.com"]},
        "subject": {"subject": SUBJECT + "\r\nX-Evil: 1"},
        "from": {"sender": "evil@example.com\nBcc: hidden@example.com"},
        "to(LF)": {"to": ["a@example.com\nb@example.com"]},
    }
    count_before_injection = ledger.count
    written_before_injection = _snapshot(root)
    attempts = {label: _attempt(lambda kw=kw: _compose(mail, **kw)) for label, kw in injections.items()}
    kinds = {label: type(value).__name__ for label, value in attempts.items()}
    out.append(Assertion("**头注入防护**（契约 §5-③/§1.3）：`to`/`subject`/`from` 里出现 `\\r`/`\\n` 一律抛 "
                         "HeaderInjectionRejected（四个探针：CRLF 收件人、CRLF 主题、LF 发件人、LF 收件人），"
                         "**不得**静默清洗出一个“看起来正常”的报文——四个探针都必须**拿不到 Message 视图**；"
                         "同时账本一条不落、目录一个文件不多"
                         "（反例：`value.replace(\"\\r\",\"\").replace(\"\\n\",\"\")` 后再发 → 注入被吞掉、"
                         "或者只对主题查而对 to/from 不查）",
                         all(isinstance(value, HeaderInjectionRejected) for value in attempts.values())
                         and ledger.count == count_before_injection
                         and _snapshot(root) == written_before_injection,
                         "探针结果=%s 账本 %s→%s" % (kinds, count_before_injection, ledger.count)))

    # --- 6. 不假装发送：deliver 返回 unavailable + reason + next_action、落 mail/refused ----
    count_before_enqueue = ledger.count
    enqueued = mail.enqueue(message=message)
    queued_rows = ledger.read(type=QUEUED_EVENT)
    queued_row = queued_rows[-1] if queued_rows else {}
    queue_view_ok = (isinstance(enqueued, dict) and set(("message_id", "seq", "duplicate")) <= set(enqueued)
                     and enqueued.get("message_id") == message.get("message_id")
                     and enqueued.get("duplicate") is False
                     and enqueued.get("seq") == queued_row.get("seq")
                     and queued_row.get("class") == "fact"
                     and queued_row.get("correlation_id") == message.get("message_id")
                     and set(QUEUED_BODY_KEYS) <= set(queued_row.get("body") or {})
                     and (queued_row["body"] or {}).get("realm") == REALM
                     and (queued_row["body"] or {}).get("body_sha256") == message.get("body_sha256")
                     and (queued_row["body"] or {}).get("bytes") == message.get("bytes")
                     and (queued_row["body"] or {}).get("subject") == SUBJECT
                     and (queued_row["body"] or {}).get("from") == SENDER
                     and list((queued_row["body"] or {}).get("to") or []) == TO
                     and ledger.count == count_before_enqueue + 1)
    out.append(Assertion("正控·enqueue 落 `mail/queued`（契约 §4）：恰好多一条、class=fact、"
                         "correlation_id=message_id、body 带契约的 10 个键（message_id/kind/package_id/rfq_rev/"
                         "to[]/from/subject/body_sha256/bytes/realm），realm 是本 realm，body_sha256 与视图一致；"
                         "返回 {message_id, seq, duplicate} 且 seq 就是那一行的 seq"
                         "（反例：correlation_id 用 package_id / class 落成 intent / 返回的 seq 与账本行不符）",
                         queue_view_ok,
                         "enqueued=%s row_seq=%s body_keys=%s 账本 %s→%s"
                         % (enqueued if isinstance(enqueued, dict) else type(enqueued).__name__,
                            queued_row.get("seq"), sorted(queued_row.get("body") or {}),
                            count_before_enqueue, ledger.count)))

    # --- 7. 不假装发送：deliver（契约 §5-④/§1.1/§0） --------------------------------------
    count_before_deliver = ledger.count
    delivered = _attempt(lambda: mail.deliver(message_id=message["message_id"]))
    refused_rows = ledger.read(type=REFUSED_EVENT)
    refused_body = (refused_rows[-1].get("body") or {}) if refused_rows else {}
    sent_rows = [row for row in ledger.read() if "sent" in str(row["type"])]
    unknown_deliver = _attempt(lambda: mail.deliver(message_id="ml-9999"))
    refused_after_unknown = ledger.read(type=REFUSED_EVENT)
    # 未知 id 的"不静默"：三种都算过 —— 抛 UnknownMessage / 抛别的 MailError（不含传输不可用）/
    # 返回一个**解释性拒绝**（带 reason + next_action，且不是"已发送"）。
    # 契约没规定 deliver(未知 id) 抛还是拒，所以这里只钉住"不许静默成功"。
    unknown_explained = (isinstance(unknown_deliver, dict)
                         and str(unknown_deliver.get("status") or "") != "sent"
                         and isinstance(unknown_deliver.get("reason"), str)
                         and unknown_deliver["reason"].strip()
                         and isinstance(unknown_deliver.get("next_action"), str)
                         and len(unknown_deliver["next_action"].strip()) >= 8
                         and '"sent"' not in _safe_json(unknown_deliver)
                         and unknown_deliver.get("sent") is not True
                         and unknown_deliver.get("ok") is not True)
    unknown_ok = (isinstance(unknown_deliver, UnknownMessage)
                  or (isinstance(unknown_deliver, MailError)
                      and not isinstance(unknown_deliver, MailTransportUnavailable))
                  or unknown_explained)
    deliver_ok = (isinstance(delivered, dict)
                  and delivered.get("status") == "unavailable"
                  and delivered.get("reason") == TRANSPORT_REASON
                  and isinstance(delivered.get("next_action"), str)
                  and len(delivered["next_action"].strip()) >= 8
                  and '"sent"' not in _safe_json(delivered)
                  and delivered.get("sent") is not True and delivered.get("ok") is not True)
    # 我们这条报文的拒绝**恰好留一条痕**；未知 id 探针最多再留一条（也是 refused，且没说"已发送"），
    # 所以总量允许 1~2 条 —— 但那条已知报文的行不许重复。
    own_refusals = [row for row in refused_after_unknown
                    if row.get("correlation_id") == message["message_id"]]
    extra_refusals = [row for row in refused_after_unknown if row is not own_refusals[0]] \
        if own_refusals else list(refused_after_unknown)
    out.append(Assertion("**不假装发送**（契约 §5-④/§1.1/§0/D-052）：没有传输实现时 `deliver()` **不抛**"
                         "（不是 MailTransportUnavailable——那个只在显式要求发送时抛）而是返回 "
                         "status=\\\"unavailable\\\" + reason=\\\"%s\\\" + 非空 next_action，"
                         "且返回值里既没有 \\\"sent\\\" 也没有 ok=true；我们这条报文**恰好留一条** `mail/refused`"
                         "（class=fact、correlation_id=message_id、body 带 message_id/reason/next_action/"
                         "transport_available 四个键、transport_available 为假、next_action 与返回值一致）；"
                         "**账本里没有任何 `mail/sent`**（mail/* 的行里也没有 sent 类事件）；"
                         "未知 message_id 不静默（抛 UnknownMessage / 抛别的 MailError / 返回解释性拒绝，"
                         "绝不返回\"已发送\"；它若也落痕，只能是 `mail/refused` 而不是 `mail/sent`）"
                         "（反例：deliver 返回 {\\\"status\\\":\\\"sent\\\"} 假装发出去了 / 只返回 unavailable"
                         "但忘了落 mail/refused（事后无从追溯）/ 未知 id 当成成功）"
                         % TRANSPORT_REASON,
                         deliver_ok and unknown_ok
                         and len(own_refusals) == 1 and own_refusals[0].get("class") == "fact"
                         and set(REFUSED_BODY_KEYS) <= set(refused_body)
                         and refused_body.get("message_id") == message["message_id"]
                         and refused_body.get("reason") == TRANSPORT_REASON
                         and refused_body.get("next_action") == delivered.get("next_action")
                         and not bool(refused_body.get("transport_available"))
                         and all(row.get("type") == REFUSED_EVENT for row in extra_refusals)
                         and len(refused_after_unknown) <= 2
                         and not sent_rows
                         and ledger.count == count_before_deliver + len(refused_after_unknown),
                         "deliver=%s 未知id=%s（解释性拒绝=%s）本报文 refused=%d 共=%d body=%s "
                         "sent 类行=%s 账本 %s→%s"
                         % (delivered if isinstance(delivered, dict) else type(delivered).__name__,
                            type(unknown_deliver).__name__, unknown_explained, len(own_refusals),
                            len(refused_after_unknown), refused_body,
                            [row["type"] for row in sent_rows], count_before_deliver, ledger.count)))

    # --- 8. transport_status 只读且如实说"不可用"（契约 §3/§0） ----------------------------
    count_before_status = ledger.count
    status_a = _attempt(lambda: mail.transport_status())
    status_b = _attempt(lambda: mail.transport_status())
    status_ok = (isinstance(status_a, dict) and status_a.get("available") is False
                 and isinstance(status_a.get("reason"), str) and status_a["reason"].strip()
                 and isinstance(status_a.get("next_action"), str) and len(status_a["next_action"].strip()) >= 8
                 and status_a == status_b and ledger.count == count_before_status)
    out.append(Assertion("`transport_status()` 如实报告\"不可用\"且是只读（契约 §3/§0）：返回 "
                         "{available: false, reason: <非空>, next_action: <可行动>}，"
                         "available **必须为假**（本轮没有凭据 → 也没有\"能发\"的假象）；"
                         "两次调用逐字节一致、一条账本都不写"
                         "（反例：available=true 让上层以为配置好了 / 调一次 status 顺手落一条账）",
                         status_ok,
                         "status=%s 账本 %s→%s" % (status_a if isinstance(status_a, dict)
                                                 else type(status_a).__name__,
                                                 count_before_status, ledger.count)))

    # --- 9. 幂等：同键重复 enqueue → duplicate=true 且账本不新增（契约 §5-⑤/§1.5） --------
    count_before_dup = ledger.count
    again = _compose(mail)                        # 同输入再 compose 一次（message_id 可能不同）
    duplicate = _attempt(lambda: mail.enqueue(message=again))
    rows_after_dup = ledger.read(type=QUEUED_EVENT)
    changed_subject = _compose(mail, subject="[pkg-014] RFQ notice rev2 (amended)")
    fresh = _attempt(lambda: mail.enqueue(message=changed_subject))
    rows_after_fresh = ledger.read(type=QUEUED_EVENT)
    dup_ok = (isinstance(duplicate, dict) and duplicate.get("duplicate") is True
              and duplicate.get("seq") == enqueued.get("seq")
              and len(rows_after_dup) == len(queued_rows) and ledger.count == count_before_dup + 1)
    out.append(Assertion("**幂等投递记录**（契约 §5-⑤/§1.5，FR-LEDGER-004 去重语义）：同一 "
                         "(kind, to, subject, body_hash, package_id, rfq_rev) 重复 enqueue → "
                         "duplicate=true 且 seq **就是原来那一行的 seq**、账本行数不变（第二次 compose 的 "
                         "message_id 与第一次不同也照样认出是同一条——去重键里**没有** message_id）；"
                         "**正控**：换一个主题（键变了）必须落新的一行、duplicate=false"
                         "（反例：去重按 message_id 做 → 同内容两次投递落两行；或者反过来见谁都 duplicate）",
                         dup_ok and isinstance(fresh, dict) and fresh.get("duplicate") is False
                         and len(rows_after_fresh) == len(rows_after_dup) + 1,
                         "重复=%s 原 seq=%s 行数 %d→%d；换主题=%s 行数→%d"
                         % (duplicate, enqueued.get("seq"), len(queued_rows), len(rows_after_dup),
                            fresh, len(rows_after_fresh))))

    # --- 10. 附件：text/* 带 sha256；application/* 被拒（契约 §5-⑦/§1.7） ------------------
    count_before_att = ledger.count
    att_message, att_key = _compose_with_attachment(mail, filename=ATT_FILENAME, content_type=ATT_CTYPE,
                                                    payload=ATT_PAYLOAD)
    att_raw, _att_src = (_raw_of(mail, att_message) if isinstance(att_message, dict) else (None, "未产出报文"))
    att_parsed = (_attempt(lambda: mail.parse(_as_bytes(att_raw))) if att_raw is not None else None)
    expect_digest_hex = _sha_hex(ATT_PAYLOAD.encode("utf-8"))
    att_items = ((att_parsed or {}).get("attachments") if isinstance(att_parsed, dict) else None) or []
    att_ok = (isinstance(att_message, dict) and isinstance(att_items, list) and len(att_items) == 1
              and isinstance(att_items[0], dict)
              and str(att_items[0].get("content_type") or "").startswith("text/")
              and att_items[0].get("filename") == ATT_FILENAME
              and expect_digest_hex in str(att_items[0].get("sha256") or "")
              and is_hash(att_items[0].get("sha256"))
              and att_items[0].get("bytes") == len(ATT_PAYLOAD.encode("utf-8"))
              and ATT_FILENAME in _as_text(att_raw))
    app_message, app_key = _compose_with_attachment(mail, filename="blob.bin",
                                                    content_type=APPLICATION_CTYPE, payload="\x00\x01binary")
    app_ok = isinstance(app_message, UnsupportedAttachment)
    out.append(Assertion("**附件只走 text/\\***（契约 §5-⑦/§1.7，否决项\"把附件二进制写进账本 body\"）："
                         "`text/csv` 附件构造成功，且**把整条报文再解析回来**能看到一个附件，"
                         "content_type 以 `text/` 开头、文件名保留、sha256 **就是附件内容的 sha256**"
                         "（sha256: 前缀 + 64 位十六进制）、bytes=内容长度；"
                         "`application/octet-stream` 一律抛 UnsupportedAttachment（**不猜二进制语义**），"
                         "且被拒时一条账本都不落、也不产出报文；两种探针都不写账本"
                         "（反例：application/* 也照单全收、或附件只留文件名不算 sha256、"
                         "或把附件内容塞进账本 body）",
                         att_ok and app_ok and ledger.count == count_before_att,
                         "附件键名=%s 解析回看的附件=%s 期望摘要=%s… application/*=%s 账本 %s→%s"
                         % (att_key, att_items, expect_digest_hex[:16], app_message
                            if isinstance(app_message, UnsupportedAttachment) else app_key,
                            count_before_att, ledger.count)))

    # --- 11. 私域哨兵不进报文与账本 body（契约 §5-⑥/§1.4/INV-008） ------------------------
    private_probe = _attempt(lambda: _compose(mail, subject=SUBJECT + " internal note",
                                              body=BODY + "\n" + PRIVATE_TEXT))
    private_rejected = isinstance(private_probe, MailError)
    private_evidence = ""
    if not private_rejected and isinstance(private_probe, dict):
        pr_raw, _pr_src = _raw_of(mail, private_probe)
        _attempt(lambda: mail.enqueue(message=private_probe))
        private_evidence = _safe_json(private_probe) + "|" + (_as_text(pr_raw) if pr_raw else "")
    ledger_blob = _safe_json([row.get("body") for row in _mail_rows(ledger)])
    probe_leaks = _carries(private_evidence) if private_evidence else []
    ledger_leaks = _carries(ledger_blob)
    out.append(Assertion("**私域不出 realm**（契约 §5-⑥/§1.4/INV-008）：正文/头里带私域哨兵"
                         "（键名 reserve_price/cost_model/signature/private: 与值 98765.4321 / 74.4876 / "
                         "SIGNATURE-SENTINEL-t258 / 0.123456789）时，`compose` 要么显式拒绝（抛 MailError），"
                         "要么接受但**这些哨兵一个都不出现在报文里、也不出现在任何 `mail/*` 账本行 body 里**"
                         "（反例：私域过滤被去掉 → 内部储备价/成本模型随邮件外发，等于把报价底牌寄给对手）",
                         private_rejected or (not probe_leaks and not ledger_leaks),
                         "拒绝=%s 报文泄漏=%s 账本泄漏=%s（探针内容长度 %d）"
                         % (private_rejected, probe_leaks, ledger_leaks, len(PRIVATE_TEXT))))

    # --- 12. parse 是纯函数（不落账、不写文件）（契约 §5-⑧/§1.6） -------------------------
    count_before_parse = ledger.count
    written_before_parse = _snapshot(root)
    first_parse = _attempt(lambda: mail.parse(_as_bytes(raw)))
    second_parse = _attempt(lambda: mail.parse(_as_bytes(raw)))
    parse_view_ok = (isinstance(first_parse, dict) and set(PARSE_KEYS) <= set(first_parse)
                     and first_parse.get("ok") is True
                     and first_parse.get("subject") == SUBJECT
                     and {addr.lower() for _n, addr in getaddresses(
                         [str(item) for item in (first_parse.get("to") or [])])}
                     == {addr.lower() for addr in TO}
                     and is_hash(first_parse.get("body_sha256"))
                     and isinstance(first_parse.get("attachments"), list)
                     and first_parse.get("realm") == REALM
                     and first_parse.get("candidate_package_id") == PACKAGE
                     and (isinstance(first_parse.get("reason"), str) or first_parse.get("reason") is None)
                     and (isinstance(second_parse, dict)
                          and _safe_json(second_parse) == _safe_json(first_parse)))
    out.append(Assertion("`parse()` 是**纯函数**（契约 §5-⑧/§1.6）：把 compose 的报文解析回来 —— ok=true、"
                         "from/to/subject/date/body_sha256/attachments/candidate_package_id/realm 都在（§2 的 Parse "
                         "视图键），两次解析产物逐字节一致；**账本行数一条不增、工作目录文件一个不多**"
                         "（入站解析是读，不是受理）"
                         "（反例：parse 顺手落一条 mail/parsed 或写临时文件 → 重启/并发下事实源被污；"
                         "或两次解析结果不同（藏了计数器））",
                         parse_view_ok and ledger.count == count_before_parse
                         and _snapshot(root) == written_before_parse,
                         "parse_ok=%s 两次一致=%s 账本 %s→%s 目录一致=%s"
                         % (isinstance(first_parse, dict) and first_parse.get("ok"),
                            isinstance(first_parse, dict) and isinstance(second_parse, dict)
                            and _safe_json(first_parse) == _safe_json(second_parse),
                            count_before_parse, ledger.count, _snapshot(root) == written_before_parse)))

    # --- 13. candidate_package_id 只在主题里显式标记时才有值（契约 §5-⑧/§2） --------------
    def _parse_subject(subject: str) -> dict:
        raw_probe = ("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\n\r\nBODY\r\n"
                     % (SENDER, TO[0], subject, DATE)).encode("utf-8")
        return mail.parse(raw_probe)

    bracketed = _parse_subject("[%s] 请确认交期" % PACKAGE)
    plain = _parse_subject("%s 请确认交期" % PACKAGE)
    no_marker = _parse_subject("请确认交期（没有包号标记）")
    other_marker = _parse_subject("[%s] 请确认交期" % OTHER_PACKAGE)
    explicit_hit = ((bracketed.get("candidate_package_id") == PACKAGE)
                    or (plain.get("candidate_package_id") == PACKAGE))
    other_value = other_marker.get("candidate_package_id")
    out.append(Assertion("`candidate_package_id` **只从主题里的显式标记取，猜不出就是 None**"
                         "（契约 §5-⑧/§2）：主题写 `[pkg-014] …` 或 `pkg-014 …` **至少一种**要取到 pkg-014；"
                         "主题里**没有**包号 → 必须是 None（不许拿本服务的默认 package 去猜）；"
                         "主题里写的是 `pkg-999` → 只能是 pkg-999 或 None，**绝不许返回 pkg-014**"
                         "（反例：候选直接取服务/账本里最近一个 package（猜）→ 无标记的主题也返回 pkg-014；"
                         "或对别的包号张冠李戴）",
                         explicit_hit and no_marker.get("candidate_package_id") is None
                         and other_value in (OTHER_PACKAGE, None),
                         "括号式=%s 裸写式=%s 无标记=%s 别的包号=%s"
                         % (bracketed.get("candidate_package_id"), plain.get("candidate_package_id"),
                            no_marker.get("candidate_package_id"), other_value)))

    # --- 14. 畸形报文：不崩 + ok=false + reason + next_action（契约 §5-⑨） ----------------
    malformed = {
        "空字节串": b"",
        "全 NUL 二进制": b"\x00\x01\x00\xff\xfe\x00",
        "没有头行": b"this is just a line without any header\n",
        "坏 UTF-8 头": b"From: \xff\xfe\r\nSubject: \xff\xfe\r\n\r\nbody",
    }
    count_before_malformed = ledger.count
    results = {label: _attempt(lambda probe=probe: mail.parse(probe))
               for label, probe in malformed.items()}
    all_dicts = all(isinstance(value, dict) for value in results.values())
    failures = {label: value for label, value in results.items()
                if isinstance(value, dict) and value.get("ok") is not True}
    failure_well_formed = all(
        isinstance(value.get("reason"), str) and value["reason"].strip()
        and isinstance(value.get("next_action"), str) and len(value["next_action"].strip()) >= 8
        and isinstance(value.get("attachments"), list)
        and value.get("candidate_package_id") is None
        for value in failures.values())
    out.append(Assertion("**畸形报文不崩、且可解释**（契约 §5-⑨）：空字节串 / 全 NUL 二进制 / 没有头行 / "
                         "坏 UTF-8 头四种垃圾输入，`parse()` 一律**不抛未捕获异常**（都返回 dict）；"
                         "凡是 ok≠true 的，必须带非空 `reason` 与非空可行动 `next_action`，`attachments` 仍是列表、"
                         "`candidate_package_id` 不许猜（None）；账本一条不落"
                         "（反例：parse 里直接 msg[\"From\"] 一把取 → 垃圾输入抛 KeyError/UnicodeDecodeError 崩掉调用方；"
                         "或 ok=false 却没有 reason，调用方不知道下一步）",
                         all_dicts and failure_well_formed and len(failures) >= 2
                         and ledger.count == count_before_malformed,
                         "结果=%s 判为失败的=%s 账本 %s→%s"
                         % ({label: (value.get("ok") if isinstance(value, dict)
                                     else type(value).__name__) for label, value in results.items()},
                            sorted(failures), count_before_malformed, ledger.count)))
    out.append(Assertion("**空输入必须被判为畸形**（契约 §5-⑨ 的硬要求：畸形报文 → ok=false + reason + "
                         "next_action）：**空字节串** `b\"\"` 是最没有争议的畸形报文，必须 ok=false；"
                         "「全 NUL 二进制」也不例外（没有 From/Subject/Date 任何一个头行）"
                         "（反例：把\"解析不出头\"当成\"ok=true 的空消息\"放过 → 未受理的东西看起来像入站成功，"
                         "候选里就会长出一条没有来源的报文）",
                         isinstance(results["空字节串"], dict)
                         and results["空字节串"].get("ok") is False
                         and isinstance(results["空字节串"].get("reason"), str)
                         and results["空字节串"]["reason"].strip()
                         and len(str(results["空字节串"].get("next_action") or "").strip()) >= 8
                         and isinstance(results["全 NUL 二进制"], dict)
                         and results["全 NUL 二进制"].get("ok") is False,
                         "空字节串=%s 全 NUL=%s"
                         % (results["空字节串"] if isinstance(results["空字节串"], dict)
                            else type(results["空字节串"]).__name__,
                            results["全 NUL 二进制"] if isinstance(results["全 NUL 二进制"], dict)
                            else type(results["全 NUL 二进制"]).__name__)))

    # --- 15. 跨 realm 候选不可见（契约 §5-⑩/§1.8） ---------------------------------------
    # ① 往账本植入一条 realm=对方 的 mail/parsed 事实行（契约 §4 的 mail/parsed body 里有 realm）
    foreign_digest = _hash("FOREIGN-BODY-t258")
    ledger.append(PARSED_EVENT, {"body_sha256": foreign_digest, "from": "foreign@example.com",
                                 "subject": FOREIGN_SENTINEL + " 对方 realm 的入站候选",
                                 "candidate_package_id": PACKAGE, "attachments": [],
                                 "realm": OTHER_REALM},
                  correlation_id=foreign_digest, actor="agent:foreign")
    # ② 同账本 + realm=对方 的真服务实例，解析一条对方报文（最强探针）
    foreign_mail = MailService(realm=OTHER_REALM, ledger=ledger, events=bus)
    foreign_raw = ("From: foreign@example.com\r\nTo: %s\r\nSubject: %s other realm\r\n"
                   "Date: %s\r\n\r\nforeign body\r\n" % (SENDER, FOREIGN_SENTINEL, DATE)).encode("utf-8")
    foreign_parse = _attempt(lambda: foreign_mail.parse(foreign_raw))
    count_before_candidates = ledger.count
    mine_a = _attempt(lambda: mail.candidates())
    mine_b = _attempt(lambda: mail.candidates())
    foreign_c = _attempt(lambda: foreign_mail.candidates())
    mine_blob = _safe_json(mine_a) if isinstance(mine_a, list) else str(mine_a)
    foreign_blob = _safe_json(foreign_c) if isinstance(foreign_c, list) else str(foreign_c)
    leaks_to_us = [token for token in ("FOREIGN-SENTINEL-t258", OTHER_REALM, "foreign@example.com")
                   if token in mine_blob]
    leaks_to_them = [token for token in (SUBJECT, "BODY-SENTINEL-t258", message["message_id"])
                     if token in foreign_blob]
    realms_ok = (isinstance(mine_a, list)
                 and all(not isinstance(item, dict) or item.get("realm") in (None, REALM) for item in mine_a))
    foreign_sees = "FOREIGN-SENTINEL-t258" in foreign_blob
    out.append(Assertion("**本 realm 内：跨 realm 候选不可见**（契约 §5-⑩/§1.8）：把一条 "
                         "`realm=buyer:buy-B` 的 `mail/parsed` 事实行植入同一账本，再用\"同账本 + realm=对方\"的"
                         "真服务实例解析一条对方报文 —— 本 realm 的 `candidates()` 里**不许出现**对方哨兵/对方 realm/"
                         "对方域名；反过来对方实例的候选里也不许出现本 realm 的报文；"
                         "本 realm 候选条目若带 `realm` 必须是本 realm；`candidates()` 两次调用一致且只读"
                         "（反例：读侧不按 realm 过滤 → 对方的入站候选（可能含对方私域）被本 realm 当成自己的候选受理）"
                         "；判别力见 detail 里的 `对方实例可见=`（若实现把候选只放内存、不读账本，本条的植入探针是弱探针）",
                         isinstance(mine_a, list) and isinstance(mine_b, list) and isinstance(foreign_c, list)
                         and not leaks_to_us and not leaks_to_them and realms_ok
                         and _safe_json(mine_a) == _safe_json(mine_b)
                         and ledger.count == count_before_candidates
                         and isinstance(foreign_parse, dict),
                         "本 realm 候选=%d 条 泄漏到本 realm=%s 泄漏到对方=%s 对方实例可见=%s "
                         "候选带非本 realm 的=%s 两次一致=%s"
                         % (len(mine_a) if isinstance(mine_a, list) else -1, leaks_to_us, leaks_to_them,
                            foreign_sees, not realms_ok,
                            isinstance(mine_a, list) and isinstance(mine_b, list)
                            and _safe_json(mine_a) == _safe_json(mine_b))))

    # --- 16. replay() / get() 从账本重建（契约 §5-⑪/§3） --------------------------------
    count_before_replay = ledger.count
    fresh_instance = MailService(realm=REALM, ledger=ledger, events=bus)
    replayed = _attempt(lambda: fresh_instance.replay())
    replayed2 = _attempt(lambda: fresh_instance.replay())
    fresh_get = _attempt(lambda: fresh_instance.get(message["message_id"]))
    live_get = _attempt(lambda: mail.get(message["message_id"]))
    rebuilt = (isinstance(replayed, dict) and _safe_json(replayed) == _safe_json(replayed2)
               and message["message_id"] in _safe_json(replayed)
               and isinstance(fresh_get, dict) and isinstance(live_get, dict)
               and _safe_json(fresh_get) == _safe_json(live_get)
               and fresh_get.get("message_id") == message["message_id"]
               and fresh_get.get("subject") == SUBJECT
               and fresh_get.get("body_sha256") == message.get("body_sha256")
               and isinstance(_attempt(lambda: fresh_instance.get("ml-9999")), UnknownMessage))
    out.append(Assertion("`replay()` 从账本重建、`get()` 跨实例一致（契约 §5-⑪/§3）：**新实例**（同一份 "
                         "ledger.jsonl）看到与老实例逐字节相同的 Message 视图（subject/body_sha256 都对得上），"
                         "`replay()` 返回 dict、两次产物逐字节一致、里面认得出这条 message_id；"
                         "未知 message_id 抛 UnknownMessage（不静默返回空）"
                         "（反例：消息只活在内存 → 重启就丢了 / replay 视图与 get 不一致 / 未知 id 返回 {}）",
                         rebuilt and ledger.count == count_before_replay,
                         "replay_keys=%s fresh_get=%s 与老实例一致=%s 账本 %s→%s"
                         % (sorted(replayed) if isinstance(replayed, dict) else replayed,
                            (fresh_get or {}).get("message_id") if isinstance(fresh_get, dict) else fresh_get,
                            isinstance(fresh_get, dict) and isinstance(live_get, dict)
                            and _safe_json(fresh_get) == _safe_json(live_get),
                            count_before_replay, ledger.count)))

    # --- 17. 不产生义务（契约 §5-⑫，运行期 + 静态） --------------------------------------
    all_rows = ledger.read()
    commitments = [row for row in all_rows if row["class"] == "commitment"]
    exits = [row for row in all_rows if row["type"] in OBLIGATION_TYPES]
    mail_rows = _mail_rows(ledger)
    obligation_literals = sorted(lit for lit in _literals if lit in OBLIGATION_LITERALS)
    out.append(Assertion("**不产生义务**（契约 §5-⑫/§1.6 否决项\"解析后自动受理为 RFQ\"）：整条链跑完后账本里"
                         "没有 commitment 类事件、没有 PO/授标/对外报价事件（award/committed · po/issued · "
                         "quote/submitted · quote/revised · capacity/committed），commitments 投影为空，"
                         "`mail/*` 全部是 fact（观测事实，不是承诺）；"
                         "静态 AST 也没有这些承诺事件的字面量、没有承诺出口调用"
                         "（反例：入站邮件被自动受理成 RFQ 并落 commitment / 邮件一发就当报价已提交）",
                         not commitments and not exits
                         and not ledger.project("commitments")["commitments"]
                         and all(row["class"] == "fact" for row in mail_rows)
                         and not obligation_literals
                         and not (calls & {"issue_po", "submit_quote", "commit_quote", "commit"}),
                         "commitments=%d exits=%s mail 行=%d classes=%s 字面量=%s"
                         % (len(commitments), [row["type"] for row in exits], len(mail_rows),
                            sorted({row["class"] for row in mail_rows}), obligation_literals)))

    # --- 18. 账本链仍真 + 三本账核对 + 断言数自证（契约 §5-⑫，≥12 条） --------------------
    report = ledger.verify_report()
    types_projection = ledger.project("types")["by_type"]
    counts_match = all(types_projection.get(name, 0) == len(ledger.read(type=name))
                       for name in MAIL_EVENTS)
    queued_rows = ledger.read(type=QUEUED_EVENT)
    refused_rows = ledger.read(type=REFUSED_EVENT)
    parsed_rows = ledger.read(type=PARSED_EVENT)
    own_parsed = [row for row in parsed_rows if (row.get("body") or {}).get("realm") == REALM]
    foreign_parsed = [row for row in parsed_rows if (row.get("body") or {}).get("realm") == OTHER_REALM]
    own_refused_rows = [row for row in refused_rows
                        if row.get("correlation_id") == message["message_id"]]
    refused_shape_ok = all(str((row.get("body") or {}).get("reason") or "").strip()
                           and '"sent"' not in _safe_json(row.get("body") or {})
                           for row in refused_rows)
    out.append(Assertion("账本链仍真 + 三本账核对 + 本机检自证（契约 §5-⑫）：`verify_report()[\"ok\"]` 为真、"
                         "`verify_chain()` 为真、head_hash = 最后一行 entry_hash、`project(\"types\")` 里 "
                         "mail/* 的逐类计数 == 实际行数、增量投影与全量重建一致（FR-LEDGER-002/003）；"
                         "**mail/sent 一行都没有**；三本账对得上：本 realm 的 queued 恰 2 条（首投 + 换主题那次；"
                         "重复投递零新增）、我们这条报文的 refused **恰 1 条**（另加至多 1 条来自\"未知 id\"探针的"
                         "拒绝，形状必须是 refused 且带非空 reason）、parsed 里对方 realm 恰 1 条（本机检植入的"
                         "探针行，没有第二条）、本 realm 的 inbound 一行都不落（parse 是纯函数）；"
                         "断言数 ≥ 12（契约 §5 的下限）"
                         "（反例：邮件服务直接改写账本文件/绕过 Ledger 追加 → 哈希链断；"
                         "或重复投递也写行、parse 也写行，三本账对不上；或断言数不足 12 却宣称覆盖 12 条）",
                         report["ok"] is True and ledger.verify_chain() is True
                         and ledger.head_hash == all_rows[-1]["entry_hash"]
                         and ledger.count == len(all_rows) and counts_match
                         and ledger.incremental("types")["by_type"] == types_projection
                         and not ledger.read(type=SENT_EVENT)
                         and len(queued_rows) == 2 and 1 <= len(refused_rows) <= 2
                         and len(own_refused_rows) == 1 and refused_shape_ok
                         and len(foreign_parsed) == 1 and not own_parsed
                         and len(out) + 1 >= 12,
                         "ok=%s count=%s head_ok=%s counts_match=%s queued=%d refused=%d（本报文 %d）"
                         " parsed=%d（本 realm %d / 对方 %d）mail/sent=%d 断言数=%d"
                         % (report["ok"], ledger.count, ledger.head_hash == all_rows[-1]["entry_hash"],
                            counts_match, len(queued_rows), len(refused_rows), len(own_refused_rows),
                            len(parsed_rows), len(own_parsed), len(foreign_parsed),
                            len(ledger.read(type=SENT_EVENT)), len(out) + 1)))

    return out
