"""ctx.mail 的 P2 实现（`docs/design/19-mail-contract.md`）——邮件集成（**无凭据部分**，FR-INTEG-003）。

本轮做：报文的**构造**（RFC 5322 字节）、**解析**（入站 → 结构化候选）、**幂等投递记录**（落账）、
**可解释失败**（`reason` + `next_action`）。
本轮**不做**真正收发：需要 SMTP/IMAP 凭据，而且"发给谁、发什么"是人的决定（D-052）。
所以这里给的是一个**传输边界**：内置的 `NullTransport` **永远**返回
`{"status": "unavailable", "reason": "mail-transport-unavailable", "next_action": "配置 SMTP/IMAP 凭据后接入"}`，
**没有任何**"看起来发出去了"的返回值 —— 做不到的事在接口上显式拒绝，而不是在返回值里含糊过去。

八条不变量（契约 §1，逐条落在代码里）：

1. **不假装发送**：`deliver()` 对**本服务认得的**报文（已入队，或本实例 compose 过）只做两件事 ——
   落 `mail/refused`、返回 `unavailable` + `reason` + `next_action`；**没有**"已发出"事件
   （契约 §4 只声明 3 个 `mail/*`，见 `EVENT_MODES`）。未知 `message_id` **不静默也不假装**：
   抛 `UnknownMessage` 且**不落账**（没有事实行就谈不上"发信"）；真要让"必须发出去"的调用方拿到异常，
   用 `deliver(..., require_transport=True)`（那一刻才抛 `MailTransportUnavailable`，拒绝行**已经**落账）。
2. **确定性**：`Date` 由参数传入，本模块**不读墙钟**（不 import 任何时钟/网络模块）；`message_id` 由
   (kind, to, subject, body_sha256, package_id, rfq_rev) 这个幂等键**memo** 得到（同键同 id），
   因此同输入两次 `compose` 的报文**字节完全一致**；头里的非 ASCII 一律走 RFC 2047 encoded-word、
   附件一律 base64（行长固定），没有任何随机数/时间戳/字典序依赖。
3. **头注入防护**：`to` / `from` / `subject` / `date` / 附件文件名与类型里出现 `\\r`/`\\n`（或 NUL）
   → `HeaderInjectionRejected`，**且不落账**（不清洗、不截断、不"修正"后发出）。
4. **私域不出 realm**（INV-008）：正文/头里出现 `reserve_price` / `cost_model` / `signature` / `private:`
   的值 → `PrivateFieldRejected`（同时兜住 compose 与 enqueue，含附件内容与拼好的原生字节）。
5. **幂等投递记录**：同一 `(kind, to, subject, body_hash, package_id, rfq_rev)` 重复 `enqueue` →
   **不新增**账本事实行，返回 `{"message_id": <原 id>, "seq": <原 seq>, "duplicate": True}`
   （FR-LEDGER-004 去重语义；键索引会随 `replay()` 从账本重建，重启后同样幂等）。
6. **解析不改状态**：`parse()` 是纯函数（不落账、不写文件、不抛未捕获异常）；入站**候选**不等于"已受理"，
   本服务不产生任何义务（只有 3 个 `fact` 事件，没有 commitment/PO/对外报价出口）。
7. **附件**：只允许 `text/*`（保留文件名 + `sha256` + 字节数；正文与附件内容都不进账本 body）；
   其它类型一律 `UnsupportedAttachment`（不猜二进制语义）。
8. **本 realm 内**：解析结果带 `realm`（= 本服务 realm）；`candidates()` 按 realm 过滤，跨 realm 不可见；
   `get()` 也看不到别的 realm 的报文。

事件（契约 §4，`event_class` 一律 `fact`；无 waterfall）：

| 事件 | `correlation_id` | body 关键键 |
|---|---|---|
| `mail/queued` | `message_id` | message_id, kind, package_id, rfq_rev, to[], from, subject, body_sha256, bytes, realm |
| `mail/refused` | `message_id` | message_id, reason, next_action, transport_available |
| `mail/parsed` | `body_sha256` | body_sha256, from, subject, candidate_package_id, attachments[], realm |

（三段 body 另各多留一个"重建用"的键，见 `QUEUED_BODY_KEYS` / `PARSED_BODY_KEYS` 旁的注释。）

**原生报文怎么拿**：契约 §2 的 Message 视图只有 12 个键（都没有原生字节），但 §5-① 又要求
"能拿报文回来解析"。所以原生字节挂在**视图之外**：`Message.raw_bytes` / `Message.raw` /
`Message.as_bytes()` / `bytes(msg)` / `msg["raw"]`（`_raw`、`raw_bytes`、`raw_text` 同义）/ 模块级
`render(message)`。它**不进** `keys()`/`items()`/`json.dumps()`，因此"键名即契约"没有被污染。
原生字节由 ASCII 头（非 ASCII 走 encoded-word）+ UTF-8 正文构成，所以**整份报文是合法 UTF-8**，
`str`/`bytes` 两种访问方式互不丢失。

【已知偏差（如实登记，不假装）】
· 正文按调用方给出的 **LF** 形式写进报文，换行**不平移**：这样 `body_sha256` 与调用方手上那份正文
  一字不差（`parse()` 侧会把 CRLF 归一后再算哈希，两边一致）。RFC 5322 的 CRLF 用于头区与 MIME 分隔；
  "多行正文的 CRLF 归一"属于传输层（T-259，待凭据）。
· `compose()` 不落账 → 原生字节**不进账本**，所以 `replay()` 重建出来的报文视图**没有**原生字节
  （账本是事实源，不是文件仓库：契约 §6 否决了把附件二进制写进账本）。
· 附件内容只留 `sha256`/文件名/字节数，正文只留 `body_sha256`：账本里没有正文，这是设计意图。
"""

from __future__ import annotations

import base64
import copy
import re
from email.header import Header
from email.parser import BytesParser
from email.policy import default as DEFAULT_POLICY
from email.utils import formataddr, getaddresses
from typing import Any

from ..kernel.canon import HASH_PREFIX, is_hash, nfc, sha256_hex
from ..kernel.ledger import Ledger

__all__ = [
    "MailError", "HeaderInjectionRejected", "UnsupportedAttachment", "UnknownMessage",
    "MailTransportUnavailable", "PrivateFieldRejected",
    "Message", "RawMessage", "NullTransport", "MailService",
    "QUEUED_EVENT", "REFUSED_EVENT", "PARSED_EVENT", "EVENT_CLASS", "EVENT_MODES",
    "KINDS", "PRIVATE_TOKENS", "MESSAGE_KEYS", "PARSE_KEYS", "PARSE_REASONS", "ATTACHMENT_KEYS",
    "TRANSPORT_REASON", "TRANSPORT_NEXT_ACTION", "UNKNOWN_MESSAGE_REASON", "SENT_UNDECLARED_REASON",
    "MALFORMED_REASON", "UNSUPPORTED_ATTACHMENT_REASON", "RAW_ALIASES",
    "render", "to_bytes", "raw_bytes", "candidate_package_id",
]

# --- 事件（契约 §4：名字与 event_class 都不可改；本文件不自行发明事件） ----------------
QUEUED_EVENT = "mail/queued"
REFUSED_EVENT = "mail/refused"
PARSED_EVENT = "mail/parsed"

#: 契约 §4：三个 `mail/*` 全是 `emit`（观测/留痕，无 waterfall）；内核按声明拒绝用错模式
EVENT_MODES = {
    QUEUED_EVENT: "emit",
    REFUSED_EVENT: "emit",
    PARSED_EVENT: "emit",
}

#: 契约 §4：`event_class` 一律 `fact`
EVENT_CLASS = "fact"

#: 契约 §2 的 `kind` 取值集合（**当前只声明这三种**；不是这三种的 kind 一律拒）
KINDS = ("rfq-notice", "clarify", "report")

#: 私域哨兵（INV-008 / 契约 §1.4）：正文、头、附件里出现即拒（不清洗）
PRIVATE_TOKENS = ("reserve_price", "cost_model", "signature", "private:")

#: 契约 §2 的 Message 视图键（**键名即契约**；原生字节挂在视图之外，见模块 docstring）
MESSAGE_KEYS = ("message_id", "kind", "package_id", "rfq_rev", "to", "from", "subject", "date",
                "body_sha256", "bytes", "realm", "citations")

#: 契约 §2 的 Parse 视图键
PARSE_KEYS = ("ok", "from", "to", "subject", "date", "body_sha256", "attachments",
              "candidate_package_id", "realm", "reason", "next_action")

#: 契约 §2 的附件键
ATTACHMENT_KEYS = ("filename", "content_type", "sha256", "bytes")

#: 契约 §4 的 body 关键键（"关键键"= 下界：这些必须在，允许另带重建用的键，见下一行注释）
QUEUED_BODY_KEYS = ("message_id", "kind", "package_id", "rfq_rev", "to", "from", "subject",
                    "body_sha256", "bytes", "realm")
REFUSED_BODY_KEYS = ("message_id", "reason", "next_action", "transport_available")
PARSED_BODY_KEYS = ("body_sha256", "from", "subject", "candidate_package_id", "attachments", "realm")

#: 实现额外写进 body 的键（都只是为了 `replay()`/`candidates()` 能重建完整视图；不含正文/附件内容）：
#:   · `mail/queued` 多一个 `date`（视图的 `date` 是调用方传的，账本里不留就没法重建）
#:   · `mail/parsed` 多一个 `to` 与 `date`（同理；`realm` 是 realm 过滤的唯一依据）
EXTRA_QUEUED_KEYS = ("date",)
EXTRA_PARSED_KEYS = ("to", "date")

#: 拒绝原因（可解释失败的最小词表；`parse()` 的取值集合）
TRANSPORT_REASON = "mail-transport-unavailable"
TRANSPORT_NEXT_ACTION = "配置 SMTP/IMAP 凭据后接入"
UNKNOWN_MESSAGE_REASON = "mail-unknown-message"
SENT_UNDECLARED_REASON = "mail-sent-event-undeclared"
MALFORMED_REASON = "malformed-message"
UNSUPPORTED_ATTACHMENT_REASON = "unsupported-attachment"
PARSE_REASONS = (MALFORMED_REASON, UNSUPPORTED_ATTACHMENT_REASON)

#: 视图外的原生报文别名（`msg[...]` / `msg.get(...)` 都认；**不进 keys()**）
RAW_ALIASES = ("raw", "_raw", "raw_bytes", "raw_text", "raw_message", "eml", "message_bytes",
               "message", "rfc5322", "source", "wire", "data", "payload", "bytes_raw")

#: 附件的内容别名（调用方给内容时的常见键名）
CONTENT_ALIASES = ("content", "data", "text", "body", "bytes")

#: 主题里的**显式** package 标记（猜不出就是 None —— 契约 §2："只从主题里的显式标记取"）
_PKG_MARKERS = (
    re.compile(r"\[\s*(?:package[:\s]+)?(pkg-[A-Za-z0-9][A-Za-z0-9_.-]*)\s*\]", re.IGNORECASE),
    re.compile(r"\bpackage[:\s]\s*(pkg-[A-Za-z0-9][A-Za-z0-9_.-]*)", re.IGNORECASE),
    re.compile(r"\b(pkg-[A-Za-z0-9][A-Za-z0-9_.-]*)", re.IGNORECASE),
)


class MailError(RuntimeError):
    """邮件服务错误基类（契约 §3）。"""


class HeaderInjectionRejected(MailError):
    """头值（收件人/主题/任意头值）里出现换行或 NUL —— 拒绝，**且不落账**（契约 §1.3）。"""


class UnsupportedAttachment(MailError):
    """附件类型不是 `text/*` —— 不猜二进制语义（契约 §1.7）。"""


class UnknownMessage(MailError):
    """不存在的 `message_id`（或不属于本 realm —— 跨 realm 报文不可见）。"""


class MailTransportUnavailable(MailError):
    """**只在显式要求发送时抛**：`deliver(..., require_transport=True)` 且传输不可用。

    `deliver()` 的默认路径**不抛** —— 它落 `mail/refused` 并返回 `unavailable`（契约 §1.1）。
    """


class PrivateFieldRejected(MailError):
    """正文/头/附件里出现私域哨兵（`reserve_price` / `cost_model` / `signature` / `private:`）。

    契约 §1.4 只说"不得出现"，没说怎么处理；这里选**显式拒绝**而不是静默剥字段 ——
    静默清洗会掩盖"有人想把私域发出去"这件事（契约 §6 对"静默清洗"的一贯否决）。
    """


class RawMessage(bytes):
    """原生报文（RFC 5322 字节）+ 一点类型兼容。

    存在的理由见模块 docstring：契约把原生字节放在 Message 视图之外。为了让调用方**不必先判类型**，
    本类在 `bytes` 语义之外额外接受 `str` 参数（`decode()` / `encode()` / `in` / `startswith()`），
    返回的始终是**同一份**字节，不是第二份数据。
    """

    def __new__(cls, data: Any) -> "RawMessage":
        return bytes.__new__(cls, bytes(data))

    # --- bytes 语义 + str 兼容 ------------------------------------------
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        return bytes(self).decode(encoding, errors)

    def encode(self, encoding: str = "utf-8", errors: str = "strict") -> bytes:
        return bytes(self).decode("utf-8", "surrogateescape").encode(encoding, errors)

    def text(self) -> str:
        """UTF-8 文本形式（构造保证整份报文是合法 UTF-8）。"""
        return bytes(self).decode("utf-8", "surrogateescape")

    @staticmethod
    def _needle(value: Any) -> Any:
        return value.encode("utf-8") if isinstance(value, str) else value

    def __contains__(self, item: Any) -> bool:
        return bytes.__contains__(self, self._needle(item))

    def __eq__(self, other: Any) -> bool:
        return bytes.__eq__(self, self._needle(other))

    def __ne__(self, other: Any) -> bool:
        result = self.__eq__(other)
        return result if result is NotImplemented else not result

    __hash__ = bytes.__hash__

    def startswith(self, prefix: Any, *args: Any) -> bool:
        return bytes.startswith(self, self._needle(prefix), *args)

    def endswith(self, suffix: Any, *args: Any) -> bool:
        return bytes.endswith(self, self._needle(suffix), *args)

    def find(self, sub: Any, *args: Any) -> int:
        return bytes.find(self, self._needle(sub), *args)

    def count(self, sub: Any, *args: Any) -> int:
        return bytes.count(self, self._needle(sub), *args)

    def __str__(self) -> str:
        return self.text()

    def __repr__(self) -> str:
        return f"RawMessage({bytes(self)[:80]!r}…)"


class Message(dict):
    """Message 视图：**恰好**契约 §2 的 12 个键 + 视图外的原生报文访问器。

    `keys()` / `items()` / `len()` / `json.dumps()` / `set(msg)` 只见契约的 12 个键；
    原生字节走 `msg["raw"]`（`_raw`/`raw_bytes`/`raw_text` 同义）、`msg.raw_bytes`、`msg.as_bytes()`、
    `bytes(msg)`、`render(msg)` —— 这样"键名即契约"与"报文拿得回来"两边都成立。
    """

    def __init__(self, view: Any = None, raw: Any = None) -> None:
        dict.__init__(self)
        for key, value in dict(view or {}).items():
            dict.__setitem__(self, key, value)
        self._raw = None if raw is None else RawMessage(raw)

    # --- 原生报文 ---------------------------------------------------------
    @property
    def raw(self) -> Any:
        return self._raw

    @property
    def raw_bytes(self) -> Any:
        return self._raw

    @property
    def raw_text(self) -> Any:
        return None if self._raw is None else self._raw.text()

    def as_bytes(self) -> Any:
        return self._raw

    def to_bytes(self) -> Any:
        return self._raw

    def render(self) -> Any:
        return self._raw

    def __bytes__(self) -> bytes:
        if self._raw is None:
            raise MailError(
                "这条报文没有原生字节：它可能是从账本 replay 重建的（原生报文不进账本，契约 §6）")
        return bytes(self._raw)

    # --- 视图之外的别名（不污染 keys()） ----------------------------------
    def __contains__(self, key: Any) -> bool:
        if isinstance(key, str) and key in RAW_ALIASES and self._raw is not None:
            return True
        return dict.__contains__(self, key)

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, str) and key in RAW_ALIASES:
            return self.raw_text if key == "raw_text" else self._raw
        return dict.__getitem__(self, key)

    def get(self, key: Any, default: Any = None) -> Any:
        try:
            return self.__getitem__(key)
        except KeyError:
            return default

    def view(self) -> dict:
        """纯视图（只有契约的键；原生字节不出来）。"""
        return {key: copy.deepcopy(value) for key, value in self.items()}


class NullTransport:
    """传输边界的**唯一**内置实现：永远不可用（契约 §0）。

    它**没有**发信方法，`deliver()` 也**不会**因为注入了传输就报告成功：本轮没有"已发出"事件，
    发出去的邮件不在账本里 = 违反"模型可见 ⟺ 账本可见"（AGENTS.md 规则 2）。
    """

    name = "null"

    def status(self) -> dict:
        return {"available": False, "reason": TRANSPORT_REASON, "next_action": TRANSPORT_NEXT_ACTION}

    def deliver(self, **kwargs: Any) -> dict:
        """永远 `unavailable`（契约 §0 逐字）。"""
        return {"status": "unavailable", "reason": TRANSPORT_REASON,
                "next_action": TRANSPORT_NEXT_ACTION}


# ======================================================================
# 纯函数：与实例状态无关的编解码/校验
# ======================================================================
def _ascii(text: str) -> bool:
    return all(ord(ch) < 128 for ch in text)


def _reject_break(field: str, value: str) -> str:
    """头值里的 `\\r`/`\\n`/NUL → `HeaderInjectionRejected`（不清洗，契约 §1.3）。"""
    if any(ch in value for ch in ("\r", "\n", "\x00")):
        raise HeaderInjectionRejected(
            f"{field} 里出现换行/NUL：拒绝构造（契约 §1.3 头注入防护）。"
            f"本服务**不**静默清洗 —— 清洗会掩盖注入尝试（契约 §6）；"
            f"请把正文换行放进 body，把字段本身的换行去掉后重试")
    return value


def _header_value(field: str, value: Any) -> str:
    """头值 → ASCII 行内容（非 ASCII 走 RFC 2047 encoded-word，确定性）。"""
    text = _reject_break(field, nfc("" if value is None else str(value)))
    if _ascii(text):
        return text
    return Header(text, "utf-8").encode()


def _address_value(field: str, value: Any) -> str:
    """地址头值：ASCII 原样；带显示名的非 ASCII 只编码显示名；裸非 ASCII 地址直接拒。"""
    text = _reject_break(field, nfc("" if value is None else str(value))).strip()
    if not text:
        raise MailError(f"{field} 不能为空（报文必须有收件人与发件人）")
    if _ascii(text):
        return text
    match = re.match(r"^(.*?)\s*<([^<>]*)>\s*$", text)
    if match and match.group(2):
        name = match.group(1).strip()
        encoded = Header(name, "utf-8").encode() if name else ""
        return f"{encoded} <{match.group(2).strip()}>" if encoded else f"<{match.group(2).strip()}>"
    raise MailError(
        f"{field} 是非 ASCII 且没有显示名形式：SMTPUTF8 不在本轮范围（需凭据与人工决定，D-052），"
        f"请改用 ASCII 地址或 `显示名 <ascii@address>` 形式")


def _to_list(value: Any) -> list:
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        raise MailError(f"收件人必须是 list[str]（契约 §3），收到 {type(value).__name__}")
    out = [str(item) for item in items if str(item).strip()]
    if not out:
        raise MailError("收件人不能为空：没有收件人的报文没有意义（也不该进账本）")
    return out


def _rev_int(value: Any, *, field: str = "rfq_rev") -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise MailError(f"{field} 必须是正整数（版本绑定是硬要求），收到 {value!r}")
    return int(value)


def _rev_like(value: Any) -> Any:
    """幂等键里的版本：能当整数就对成整数（`2` 与 `\"2\"` 是同一版），否则原样。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def _lf(data: bytes) -> bytes:
    """换行归一到 LF：哈希与比较都用这一形式（正文写进报文时也用它，见模块 docstring）。"""
    return bytes(data).replace(b"\r\n", b"\n")


def _body_bytes(body: Any) -> bytes:
    if body is None:
        return b""
    if isinstance(body, (bytes, bytearray)):
        return _lf(bytes(body))
    return _lf(nfc(str(body)).encode("utf-8"))


def _hash_of(data: bytes) -> str:
    return HASH_PREFIX + sha256_hex(data)


def _contains_private(value: Any) -> bool:
    text = value if isinstance(value, str) else str(value)
    low = text.lower()
    return any(token in low for token in PRIVATE_TOKENS)


def _scan_private(*pairs: Any) -> None:
    """(标签, 值) 序列 → 出现私域哨兵即拒（契约 §1.4，不清洗）。"""
    for label, value in pairs:
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                _scan_private((f"{label}[{index}]", item))
            continue
        if isinstance(value, dict):
            for key in sorted(value, key=str):
                _scan_private((f"{label}.{key}", value[key]))
            continue
        if _contains_private(value):
            raise PrivateFieldRejected(
                f"{label} 里出现私域哨兵（{', '.join(PRIVATE_TOKENS)} 之一）："
                f"私域不出 realm（INV-008 / 契约 §1.4），本服务拒绝构造，也不落任何账本行")


def candidate_package_id(subject: Any) -> Any:
    """从主题里取**显式** package 标记；猜不出就是 None（契约 §2）。

    认这些写法（都要求 `pkg-` 前缀这个显式标记）：`[pkg-014]` / `[package:pkg-014]` /
    `package:pkg-014` / 主题里出现的裸 `pkg-014`。**不做**模糊匹配、不做"最接近的包"猜测。
    """
    text = nfc("" if subject is None else str(subject))
    if "pkg-" not in text.lower():
        return None
    for pattern in _PKG_MARKERS:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


def _attachment_input(item: Any) -> dict:
    """把调用方给的附件 dict 规范化（只认 `text/*`；内容只留哈希，不入账本 body）。"""
    if not isinstance(item, dict):
        raise MailError(f"附件必须是 dict（filename/content_type/content），收到 {type(item).__name__}")
    filename = item.get("filename", item.get("name"))
    if not filename:
        raise MailError("附件缺少 filename：文件名是契约 §2 的附件键之一")
    filename = _reject_break("附件文件名", nfc(str(filename)))
    content_type = item.get("content_type", item.get("content-type", item.get("mime")))
    content_type = str(content_type or "text/plain").strip().lower() or "text/plain"
    _reject_break("附件类型", content_type)
    if not content_type.startswith("text/"):
        raise UnsupportedAttachment(
            f"附件 {filename!r} 的类型 {content_type!r} 不是 text/*：本服务不猜二进制语义"
            f"（契约 §1.7），也不把二进制写进账本 body")
    content = None
    for key in CONTENT_ALIASES:
        if key in item and item[key] is not None:
            content = item[key]
            break
    if content is None:
        raise MailError(f"附件 {filename!r} 缺少内容（content/data/text 之一）")
    data = _body_bytes(content)
    return {
        "filename": filename,
        "content_type": content_type,
        "content_bytes": data,
        "sha256": _hash_of(data),
        "bytes": len(data),
    }


def _wrap_base64(data: bytes, width: int = 76) -> bytes:
    encoded = base64.b64encode(data).decode("ascii")
    lines = [encoded[index:index + width] for index in range(0, len(encoded), width)] or [""]
    return "\r\n".join(lines).encode("ascii")


def _quoted_param(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _pct(value: str) -> str:
    out = []
    for ch in value:
        if ch.isascii() and (ch.isalnum() or ch in "._-"):
            out.append(ch)
        else:
            out.extend(f"%{byte:02X}" for byte in ch.encode("utf-8"))
    return "".join(out)


def _attachment_part(attachment: dict) -> bytes:
    filename = attachment["filename"]
    head_lines = [f'Content-Type: {attachment["content_type"]}',
                  "Content-Transfer-Encoding: base64"]
    if _ascii(filename):
        quoted = _quoted_param(filename)
        head_lines[0] = f'Content-Type: {attachment["content_type"]}; name="{quoted}"'
        head_lines.append(f'Content-Disposition: attachment; filename="{quoted}"')
    else:
        # 非 ASCII 文件名：不用 encoded-word 塞进参数（RFC 2047 不适用于参数），走 RFC 2231
        head_lines.append(f"Content-Disposition: attachment; filename*=utf-8''{_pct(filename)}")
    head = "\r\n".join(head_lines).encode("ascii")
    return head + b"\r\n\r\n" + _wrap_base64(attachment["content_bytes"])


def _body_part(body_bytes: bytes) -> bytes:
    cte = "7bit" if all(byte < 128 for byte in body_bytes) else "8bit"
    head = ('Content-Type: text/plain; charset="utf-8"\r\n'
            f'Content-Transfer-Encoding: {cte}').encode("ascii")
    return head + b"\r\n\r\n" + body_bytes


def _boundary(seed: bytes) -> str:
    return "=_quotagent_" + sha256_hex(seed)[:32]


def render(message: Any) -> Any:
    """报文 → 原生 RFC 5322 字节（**视图之外的访问器**，契约 §2 不占键位）。

    与 `Message.raw_bytes` / `Message.as_bytes()` / `bytes(msg)` / `msg["raw"]` 返回同一份字节。
    """
    raw = getattr(message, "raw_bytes", None)
    if raw is not None:
        return RawMessage(raw)
    if isinstance(message, dict):
        for key in RAW_ALIASES:
            value = message.get(key)
            if value is not None:
                return RawMessage(value)
    raise MailError(
        "拿不到原生字节：报文不是本服务 compose 出来的（或它来自账本 replay —— 原生报文不进账本）")


def to_bytes(message: Any) -> bytes:
    return bytes(render(message))


raw_bytes = to_bytes


def _build_wire(*, sender: str, to: list, subject: str, date: str, body_bytes: bytes,
                attachments: list) -> bytes:
    """手写报文字节：确定性 + 换行可控 + 非 ASCII 一律编码（见模块 docstring 的已知偏差）。"""
    lines = [
        "From: " + _address_value("from", sender),
        "To: " + ", ".join(_address_value("to", item) for item in to),
        "Subject: " + _header_value("subject", subject),
        "Date: " + _header_value("date", date),
        "MIME-Version: 1.0",
    ]
    if not attachments:
        lines.append('Content-Type: text/plain; charset="utf-8"')
        lines.append("Content-Transfer-Encoding: " + ("7bit" if all(b < 128 for b in body_bytes) else "8bit"))
        return _join(lines, body_bytes)
    seed = body_bytes + b"|" + "|".join(item["filename"] + ":" + item["sha256"] for item in attachments).encode("utf-8")
    boundary = _boundary(seed)
    lines.append(f'Content-Type: multipart/mixed; boundary="{boundary}"')
    parts = [_body_part(body_bytes)]
    parts.extend(_attachment_part(item) for item in attachments)
    body = (b"--" + boundary.encode("ascii") + b"\r\n"
            + (b"\r\n--" + boundary.encode("ascii") + b"\r\n").join(parts)
            + b"\r\n--" + boundary.encode("ascii") + b"--\r\n")
    return _join(lines, body)


def _join(lines: list, payload: bytes) -> bytes:
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
    return head + payload


def _headers_wellformed(data: bytes) -> bool:
    """头区结构检查：每一行要么是 `Name: value`，要么是续行；空报文/无头→畸形。"""
    head = data
    for separator in (b"\r\n\r\n", b"\n\n", b"\r\r\n\r"):
        if separator in data:
            head = data.split(separator, 1)[0]
            break
    lines = head.splitlines()
    if not lines:
        return False
    seen = False
    for line in lines:
        if line[:1] in (b" ", b"\t"):
            if not seen:
                return False
            continue
        if b":" not in line:
            return False
        seen = True
    return seen


def _raw_of(raw: Any) -> Any:
    """入参 → 原生字节（bytes / str / Message 都认）；认不出返回 None（交给失败路径）。"""
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    if isinstance(raw, str):
        return raw.encode("utf-8", "surrogateescape")
    if isinstance(raw, Message):
        return None if raw.raw_bytes is None else bytes(raw.raw_bytes)
    if isinstance(raw, dict):
        for key in RAW_ALIASES:
            value = raw.get(key)
            if value is None:
                continue
            if isinstance(value, (bytes, bytearray)):
                return bytes(value)
            if isinstance(value, str):
                return value.encode("utf-8", "surrogateescape")
    return None


# ======================================================================
# 服务
# ======================================================================
class MailService:
    """`ctx.mail` 的 P2 Provider（邮件集成无凭据部分；账本是唯一事实源）。

    只接一个账本（本 realm 的账本）：`replay()` 从 `mail/queued` / `mail/parsed` 重建报文索引与入站候选，
    所以重启/新实例看到同样的报文与同样的幂等行为。
    """

    #: 观测/留痕事件的 actor
    actor = "agent:mail"

    def __init__(self, *, realm: str, ledger: Ledger | None = None, events: Any = None,
                 transport: Any = None) -> None:
        self.realm = str(realm or "")
        self.ledger = ledger
        self.events = events
        self.transport = NullTransport() if transport is None else transport
        self._index: dict[str, dict] = {}
        self._order: list[str] = []
        self._keys: dict[tuple, str] = {}
        self._landed: dict[tuple, str] = {}
        self._counter = 0
        self._inbound: dict[str, dict] = {}
        #: 本实例 compose 过但还没入队的报文（只用于 `deliver()`/`get()` 认得这条 message_id；
        #: 不是事实源 —— 原生报文与未入队的报文都不进账本）
        self._composed: dict[str, Message] = {}
        self.replayed = 0
        if self.ledger is not None:
            self.replayed = int(self.replay()["replayed"])

    # ---------------------------------------------------------------- 构造
    def compose(self, *, kind: str, package_id: str, rfq_rev: int, sender: str,
                to: list, subject: str, body: str, date: str,
                attachments: list | None = None) -> Message:
        """构造 RFC 5322 报文（Message 视图；**不落账**）——契约 §3。

        `Date` 由参数传入（不读墙钟）；同输入两次调用**字节完全一致**（契约 §1.2）。
        头里有换行 → `HeaderInjectionRejected`；正文/头里出现私域哨兵 → `PrivateFieldRejected`；
        非 `text/*` 附件 → `UnsupportedAttachment`。三种拒绝都**不落账**。
        """
        kind_text = _reject_break("kind", str(kind or "").strip())
        if not kind_text:
            raise MailError("kind 不能为空（契约 §2 的取值：%s）" % ", ".join(KINDS))
        if kind_text not in KINDS:
            raise MailError(
                f"未知 kind={kind_text!r}：契约 §2 只声明 {', '.join(KINDS)}；"
                f"要加新种类请先改契约/事件表，不要在实现里私开")
        package = _reject_break("package_id", str(package_id or "").strip())
        if not package:
            raise MailError("package_id 不能为空：报文必须能引用回某个包（citations 也要它）")
        revision = _rev_int(rfq_rev)
        recipients = _to_list(to)
        sender_text = _reject_break("from", nfc(str(sender or "")).strip())
        if not sender_text:
            raise MailError("from（发件人）不能为空")
        subject_text = _reject_break("subject", nfc(str(subject or "")))
        date_text = _reject_break("date", str(date or ""))
        if not date_text.strip():
            raise MailError("date 必须由调用方传入（本服务不读墙钟，契约 §1.2）——ISO8601 字符串")
        body_bytes = _body_bytes(body)
        parsed_attachments = [_attachment_input(item) for item in (attachments or [])]

        # 私域哨兵：值级先扫（能指出是哪个字段），拼好报文后再整份扫一遍（兜底）
        _scan_private(("from", sender_text), ("subject", subject_text), ("date", date_text),
                      ("to", recipients), ("body", body_bytes.decode("utf-8", "surrogateescape")),
                      ("package_id", package))
        _scan_private(*(("附件", item) for item in parsed_attachments))

        key = self._key_of(kind=kind_text, to=recipients, subject=subject_text,
                           body_sha256=_hash_of(body_bytes), package_id=package, rfq_rev=revision)
        message_id = self._assign_id(key)
        wire = _build_wire(sender=sender_text, to=recipients, subject=subject_text, date=date_text,
                           body_bytes=body_bytes, attachments=parsed_attachments)
        _scan_private(("原生报文", wire.decode("utf-8", "surrogateescape")))
        view = {
            "message_id": message_id,
            "kind": kind_text,
            "package_id": package,
            "rfq_rev": revision,
            "to": list(recipients),
            "from": sender_text,
            "subject": subject_text,
            "date": date_text,
            "body_sha256": _hash_of(body_bytes),
            "bytes": len(wire),
            "realm": self.realm,
            "citations": [f"package:{package}@rev{revision}"],
        }
        message = Message(view, wire)
        self._composed[message_id] = message
        return message

    # ---------------------------------------------------------------- 幂等投递记录
    def enqueue(self, *, message: dict) -> dict:
        """落 `mail/queued`（幂等）；返回 `{"message_id", "seq", "duplicate"}` —— 契约 §3。

        幂等键 = `(kind, to, subject, body_hash, package_id, rfq_rev)`（契约 §1.5）：
        重复入队**不新增**账本事实行，返回原 `seq` 与原 `message_id`（同一条报文只有一行事实）。
        """
        view = dict(message) if isinstance(message, dict) else None
        if view is None:
            raise MailError(f"enqueue 需要 Message 视图/同形状 dict（契约 §3），收到 {type(message).__name__}")
        if self.ledger is None:
            raise MailError("没有账本：投递记录必须落账（账本是唯一事实源）；compose/parse 不需要账本")
        kind_text = str(view.get("kind") or "")
        recipients = _to_list(view.get("to"))
        subject_text = _reject_break("subject", str(view.get("subject") or ""))
        package = str(view.get("package_id") or "")
        revision = _rev_int(view.get("rfq_rev"))
        body_sha256 = str(view.get("body_sha256") or "")
        if not is_hash(body_sha256):
            raise MailError(f"body_sha256 必须是 {HASH_PREFIX}<64 hex>（契约 §2），收到 {body_sha256!r}")
        sender_text = _reject_break("from", str(view.get("from") or ""))
        date_text = _reject_break("date", str(view.get("date") or ""))
        # 头注入/私域：手搓 dict 也要拦，**且不落账**（契约 §1.3/§1.4）
        _scan_private(("from", sender_text), ("subject", subject_text), ("to", recipients),
                      ("package_id", package), ("date", date_text))
        key = self._key_of(kind=kind_text, to=recipients, subject=subject_text,
                           body_sha256=body_sha256, package_id=package, rfq_rev=revision)

        known = self._landed.get(key)
        if known is not None:
            return {"message_id": known, "seq": self._seq_of(known), "duplicate": True}

        message_id = str(view.get("message_id") or "") or self._assign_id(key)
        body = {
            "message_id": message_id,
            "kind": kind_text,
            "package_id": package,
            "rfq_rev": revision,
            "to": list(recipients),
            "from": sender_text,
            "subject": subject_text,
            "body_sha256": body_sha256,
            "bytes": int(view.get("bytes") or 0),
            "realm": str(view.get("realm") or self.realm),
            # 契约 §4 是"body 关键键"（下界）：多留一个 date，replay 才能重建完整视图
            "date": date_text,
        }
        ref = self._append(QUEUED_EVENT, body, correlation_id=message_id,
                           refs={"message_id": message_id, "package_id": package})
        raw = view.raw_bytes if isinstance(view, Message) else None
        self._remember(message_id, view=Message(dict(view, message_id=message_id), raw), body=body,
                       seq=(None if ref is None else int(ref.seq)))
        self._keys[key] = message_id
        self._landed[key] = message_id
        return {"message_id": message_id, "seq": (None if ref is None else int(ref.seq)),
                "duplicate": bool(ref.duplicate) if ref is not None else False}

    # ---------------------------------------------------------------- 投递（不假装发送）
    def deliver(self, *, message_id: str, require_transport: bool = False) -> dict:
        """**永远** `unavailable` + 可解释的 `reason`/`next_action`，并落 `mail/refused`（契约 §1.1）。

        本轮没有"已发出"事件，所以这里**没有**成功分支：传输可用与否都不假裝——
        注入了可用传输时报 `mail-sent-event-undeclared`（先把"已发出"事件按 ADR 声明，再放行）。
        未知 `message_id` 抛 `UnknownMessage`（不落账：没有事实行就不是"发过信"）。
        `require_transport=True` 时抛 `MailTransportUnavailable`（拒绝行**先**落账）。
        """
        message_id_text = str(message_id or "")
        record = self._index.get(message_id_text)
        composed = self._composed.get(message_id_text)
        status = self.transport_status()
        if record is not None:
            known = self._realm_ok(record["body"].get("realm"))
        elif composed is not None:
            known = self._realm_ok(composed.get("realm"))      # compose 过但还没入队：依然认得它
        else:
            known = False
        if not known:
            # 未知 message_id **不静默**：没有事实行可谈"发信"，这里不落账、也不假装拒绝过一条真报文
            raise UnknownMessage(
                f"{UNKNOWN_MESSAGE_REASON}：未知 message_id={message_id_text!r} 在 realm {self.realm!r} 的"
                f"账本里没有这条报文，本实例也没有 compose 过它。先 compose + enqueue，再 deliver"
                f"（投递记录必须有账本行；原生报文不进账本）")
        if status["available"]:
            reason = SENT_UNDECLARED_REASON
            next_action = ("本轮不声明\"已发出\"事件（D-052 / 契约 §4）：发出去的邮件不在账本里等于事实丢失。"
                           "接入真实传输前先按 ADR 声明该事实行并接线")
        else:
            reason = TRANSPORT_REASON
            next_action = TRANSPORT_NEXT_ACTION
        self._append(REFUSED_EVENT, {
            "message_id": message_id_text,
            "reason": reason,
            "next_action": next_action,
            "transport_available": bool(status["available"]),
        }, correlation_id=message_id_text, refs={"message_id": message_id_text})
        result = {"status": "unavailable", "reason": reason, "next_action": next_action}
        if require_transport and not status["available"]:
            raise MailTransportUnavailable(
                f"{reason}：{next_action}（拒绝已落 {REFUSED_EVENT}，message_id={message_id_text!r}）")
        return result

    def transport_status(self) -> dict:
        """`{"available", "reason", "next_action"}`——契约 §3。无传输实现时永远不可用。"""
        status = getattr(self.transport, "status", None)
        payload = None
        if callable(status):
            try:
                payload = status()
            except Exception:  # noqa: BLE001 - 传输方的异常不能变成"看起来能用"
                payload = None
        if isinstance(payload, dict):
            return {"available": bool(payload.get("available")),
                    "reason": str(payload.get("reason") or ""),
                    "next_action": str(payload.get("next_action") or "")}
        available = getattr(self.transport, "available", None)
        if isinstance(available, bool) and available:
            return {"available": True, "reason": "", "next_action": ""}
        return {"available": False, "reason": TRANSPORT_REASON, "next_action": TRANSPORT_NEXT_ACTION}

    # ---------------------------------------------------------------- 解析（纯函数）
    def parse(self, raw: Any) -> dict:
        """入站报文 → Parse 视图（契约 §2/§3）：**纯函数**，不落账、不写文件、不抛未捕获异常。

        畸形输入返回 `ok=False` + `reason` + `next_action`（可行动）；
        含非 `text/*` 附件时 `reason="unsupported-attachment"`（不猜二进制语义）。
        入站候选**不等于**已受理：本方法不产生任何义务（契约 §1.6）。
        """
        data = _raw_of(raw)
        if data is None or not data.strip():
            return self._failure(raw, MALFORMED_REASON,
                                 "空报文/认不出的入参：入站内容必须是报文字节（bytes/str/报文视图）")
        try:
            if not _headers_wellformed(data):
                return self._failure(data, MALFORMED_REASON,
                                     "头区不是 `Name: value` 结构（缺分隔空行、头行缺冒号、或以续行开头）："
                                     "请让发件方按 RFC 5322 重发，或人工确认后再重试")
            message = BytesParser(policy=DEFAULT_POLICY).parsebytes(data)
            if not message.keys():
                return self._failure(data, MALFORMED_REASON,
                                     "解析不出任何头：请让发件方按 RFC 5322 重发")
            sender = str(message.get("From") or "")
            recipients = [address for _name, address in getaddresses([str(message.get("To") or "")])
                          if address]
            subject = str(message.get("Subject") or "")
            date = str(message.get("Date") or "")

            body_bytes = b""
            attachments = []
            for part in message.walk():
                if part.is_multipart():
                    continue
                content_type = str(part.get_content_type() or "").lower()
                content = bytes(part.get_payload(decode=True) or b"")
                filename = part.get_filename()
                disposition = str(part.get("Content-Disposition") or "")
                if not content_type.startswith("text/"):
                    return self._failure(data, UNSUPPORTED_ATTACHMENT_REASON,
                                         f"入站报文含非文本附件（{content_type}）：本服务不猜二进制语义"
                                         f"（契约 §1.7），也没有附件仓库；请人工另走渠道收取",
                                         sender=sender, to=recipients, subject=subject, date=date)
                if filename or "attachment" in disposition.lower() or "inline" in disposition.lower():
                    payload = _lf(content)
                    attachments.append({
                        "filename": str(filename or ""),
                        "content_type": content_type,
                        "sha256": _hash_of(payload),
                        "bytes": len(payload),
                    })
                elif not body_bytes:
                    body_bytes = _lf(content)
        except Exception as exc:  # noqa: BLE001 - 契约 §1.6/§5-⑨：畸形输入不得抛未捕获异常
            return self._failure(data, MALFORMED_REASON,
                                 f"解析入站报文失败（{type(exc).__name__}）：请让发件方按 RFC 5322 重发，"
                                 f"或人工确认后再重试")

        return {
            "ok": True,
            "from": sender,
            "to": recipients,
            "subject": subject,
            "date": date,
            "body_sha256": _hash_of(body_bytes),
            "attachments": attachments,
            "candidate_package_id": candidate_package_id(subject),
            "realm": self.realm,
            "reason": None,
            "next_action": None,
        }

    def record_parsed(self, *, parsed: dict) -> dict:
        """把一次成功的解析结果留痕（`mail/parsed`）——**入站候选不等于已受理**（契约 §1.6）。

        幂等：同一 `body_sha256` 重复登记不新增事实行（账本去重语义）。
        """
        if not isinstance(parsed, dict) or not parsed.get("ok"):
            raise MailError("record_parsed 只接受 `ok=True` 的 Parse 视图（失败的解析不落账，契约 §4）")
        body_sha256 = str(parsed.get("body_sha256") or "")
        if not is_hash(body_sha256):
            raise MailError(f"parsed 缺少 {HASH_PREFIX}<64 hex> 形式的 body_sha256")
        view = {
            "body_sha256": body_sha256,
            "from": str(parsed.get("from") or ""),
            "subject": str(parsed.get("subject") or ""),
            "candidate_package_id": parsed.get("candidate_package_id"),
            "attachments": copy.deepcopy(list(parsed.get("attachments") or [])),
            "realm": str(parsed.get("realm") or self.realm),
            # 契约 §4 是"body 关键键"（下界）：多留 to/date，candidates() 才能重建完整视图
            "to": list(parsed.get("to") or []),
            "date": str(parsed.get("date") or ""),
        }
        _scan_private(("入站 from", view["from"]), ("入站 subject", view["subject"]),
                      ("入站 to", view["to"]), ("入站附件", view["attachments"]))
        seq = None
        if self.ledger is not None:
            ref = self._append(PARSED_EVENT, view, correlation_id=body_sha256,
                               refs={"body_sha256": body_sha256})
            seq = None if ref is None else int(ref.seq)
        self._inbound[body_sha256] = self._candidate_view(view)
        out = self._full_parse_view(parsed)
        out["seq"] = seq
        return out

    def ingest(self, raw: Any) -> dict:
        """`parse()` + `record_parsed()` 的组合：入站解析并留痕（**仍不产生任何义务**）。

        失败（`ok=False`）时不落账，原样返回 Parse 视图（`reason`/`next_action` 在结果里）。
        """
        parsed = self.parse(raw)
        if not parsed.get("ok"):
            return parsed
        return self.record_parsed(parsed=parsed)

    def candidates(self) -> list[dict]:
        """本 realm 的入站候选（只读、按 `body_sha256` 排序）——契约 §3。

        候选来自账本的 `mail/parsed` 行（跨实例可见）+ 本进程 `record_parsed` 过的结果；
        **跨 realm 的候选不可见**（契约 §1.8）。
        """
        collected: dict[str, dict] = {}
        for row in self._rows():
            if str(row.get("type")) != PARSED_EVENT:
                continue
            body = row.get("body") or {}
            body_sha256 = str(body.get("body_sha256") or "")
            if not body_sha256 or body_sha256 in collected:
                continue
            if not self._realm_ok(body.get("realm") if body.get("realm") is not None else row.get("realm")):
                continue
            collected[body_sha256] = self._candidate_view(body)
        for body_sha256, view in self._inbound.items():
            if body_sha256 in collected or not self._realm_ok(view.get("realm")):
                continue
            collected[body_sha256] = copy.deepcopy(view)
        order = sorted(collected, key=lambda item: (item, str(collected[item].get("subject") or "")))
        return [copy.deepcopy(collected[item]) for item in order]

    # ---------------------------------------------------------------- 只读
    def get(self, message_id: str) -> Message:
        """按 `message_id` 取报文视图；未知或跨 realm → `UnknownMessage`（契约 §3）。

        账本里有的按账本（事实源）；只在**本实例** compose 过、还没入队的报文也认得（它还没有事实行）。
        """
        key = str(message_id or "")
        record = self._index.get(key)
        if record is not None and self._realm_ok(record["body"].get("realm")):
            view = record["view"]
            return Message(view.view() if isinstance(view, Message) else dict(view), record.get("raw"))
        composed = self._composed.get(key)
        if composed is not None and self._realm_ok(composed.get("realm")):
            return Message(composed.view(), composed.raw_bytes)
        raise UnknownMessage(
            f"不存在的报文 {key!r}（或不属于本 realm {self.realm!r}：跨 realm 报文不可见）；"
            f"先 compose + enqueue，或检查 message_id")

    def messages(self) -> list[dict]:
        """本 realm 的报文视图（按 `message_id` 排序；**只出视图键**）——账本重建的依据。"""
        out = []
        for message_id in self._order:
            record = self._index[message_id]
            if not self._realm_ok(record["body"].get("realm")):
                continue
            out.append(record["view"].view() if isinstance(record["view"], Message) else dict(record["view"]))
        return out

    def to_bytes(self, message_id: str) -> RawMessage:
        """按 `message_id` 取原生报文（视图之外的显式访问器；与 `get(mid)["raw"]` 同一份字节）。"""
        return RawMessage(self.get(message_id).raw_bytes)

    def render(self, message_id: str) -> RawMessage:
        """`to_bytes` 的同义方法（模块级 `render(message)` 收的是视图，这里收 `message_id`）。"""
        return self.to_bytes(message_id)

    def refused(self) -> list[dict]:
        """本 realm 的拒绝记录（`mail/refused` 的 body），按 seq 排序（可解释失败可追溯）。"""
        return [dict(row.get("body") or {}) for row in self._rows()
                if str(row.get("type")) == REFUSED_EVENT]

    # ---------------------------------------------------------------- 重放
    def replay(self) -> dict:
        """从账本重建（**账本是唯一事实源**）：报文索引、幂等键索引、入站候选、序号。"""
        held = {message_id: record.get("raw") for message_id, record in self._index.items()}
        self._index = {}
        self._order = []
        self._keys = {}
        self._landed = {}
        self._counter = 0
        self._inbound = {}
        if self.ledger is None:
            return {"replayed": 0, "order": [], "messages": [], "candidates": [],
                    "note": "无账本，无法重放（compose/parse 仍可用）"}
        inbound: dict[str, dict] = {}
        for row in self._rows():
            type_ = str(row.get("type") or "")
            body = row.get("body") or {}
            if type_ == QUEUED_EVENT:
                message_id = str(body.get("message_id") or "")
                if not message_id or message_id in self._index:
                    continue                            # append-only：同一 message_id 只认第一条
                view = self._message_view(body)
                self._remember(message_id, view=view, body=dict(body), seq=int(row.get("seq") or 0),
                               raw=held.get(message_id))
                key = self._key_of(kind=str(body.get("kind") or ""), to=body.get("to") or [],
                                   subject=str(body.get("subject") or ""),
                                   body_sha256=str(body.get("body_sha256") or ""),
                                   package_id=str(body.get("package_id") or ""),
                                   rfq_rev=_rev_like(body.get("rfq_rev")))
                # 幂等键索引随账本重建：重启后同键重复 enqueue 依然不新增事实行（契约 §1.5）
                self._keys[key] = message_id
                self._landed[key] = message_id
            elif type_ == PARSED_EVENT:
                body_sha256 = str(body.get("body_sha256") or "")
                if not body_sha256 or body_sha256 in inbound:
                    continue
                inbound[body_sha256] = self._candidate_view(body)
        self._inbound = inbound
        return {"replayed": len(self._index), "order": list(self._order), "messages": self.messages(),
                "candidates": self.candidates(), "note": "从账本重建（原生报文不进账本，replay 后无原生字节）"}

    # ==================================================================
    # 内部
    # ==================================================================
    def _rows(self) -> list:
        if self.ledger is None:
            return []
        try:
            return list(self.ledger.read())
        except Exception:  # noqa: BLE001 - 账本读失败不该让只读接口崩
            return []

    def _realm_ok(self, realm: Any) -> bool:
        if not self.realm:
            return True
        return str(realm or "") == self.realm

    def _key_of(self, *, kind: str, to: Any, subject: str, body_sha256: str, package_id: str,
                rfq_rev: Any) -> tuple:
        return (str(kind), tuple(str(item) for item in _to_list(to)), str(subject),
                str(body_sha256), str(package_id), _rev_like(rfq_rev))

    def _assign_id(self, key: tuple) -> str:
        """幂等键 → `message_id`（同键同 id，确定性；新键取下一个序号）。"""
        known = self._keys.get(key)
        if known:
            return known
        self._counter += 1
        message_id = "ml-%04d" % self._counter
        self._keys[key] = message_id
        return message_id

    def _remember(self, message_id: str, *, view: Any, body: dict, seq: Any, raw: Any = None) -> None:
        self._index[message_id] = {"view": view, "body": dict(body), "seq": seq, "raw": raw}
        self._order = sorted(self._index, key=lambda item: (self._number(item), item))
        self._counter = max([self._counter] + [self._number(item) for item in self._index])

    def _seq_of(self, message_id: str) -> Any:
        record = self._index.get(message_id)
        return None if record is None else record.get("seq")

    @staticmethod
    def _number(message_id: Any) -> int:
        tail = str(message_id or "").rsplit("-", 1)[-1]
        return int(tail) if tail.isdigit() else 0

    @staticmethod
    def _message_view(body: dict) -> Message:
        """账本行 body → Message 视图（账本里没有原生字节，也没有正文）。"""
        package = str(body.get("package_id") or "")
        revision = _rev_like(body.get("rfq_rev"))
        return Message({
            "message_id": str(body.get("message_id") or ""),
            "kind": str(body.get("kind") or ""),
            "package_id": package,
            "rfq_rev": revision,
            "to": [str(item) for item in (body.get("to") or [])],
            "from": str(body.get("from") or ""),
            "subject": str(body.get("subject") or ""),
            "date": str(body.get("date") or ""),
            "body_sha256": str(body.get("body_sha256") or ""),
            "bytes": int(body.get("bytes") or 0),
            "realm": str(body.get("realm") or ""),
            "citations": [f"package:{package}@rev{revision}"],
        })

    def _candidate_view(self, body: dict) -> dict:
        return {
            "ok": True,
            "from": str(body.get("from") or ""),
            "to": [str(item) for item in (body.get("to") or [])],
            "subject": str(body.get("subject") or ""),
            "date": str(body.get("date") or ""),
            "body_sha256": str(body.get("body_sha256") or ""),
            "attachments": copy.deepcopy(list(body.get("attachments") or [])),
            "candidate_package_id": body.get("candidate_package_id"),
            "realm": str(body.get("realm") or ""),
            "reason": None,
            "next_action": None,
        }

    @staticmethod
    def _full_parse_view(parsed: dict) -> dict:
        view = {key: copy.deepcopy(parsed.get(key)) for key in PARSE_KEYS}
        view["ok"] = True
        return view

    def _failure(self, raw: Any, reason: str, next_action: str, *, sender: str = "", to: Any = None,
                 subject: str = "", date: str = "") -> dict:
        """`ok=False` 的 Parse 视图（键与成功路径**完全一致**；畸形输入不抛，契约 §5-⑨）。"""
        data = raw if isinstance(raw, (bytes, bytearray)) else _raw_of(raw)
        return {
            "ok": False,
            "from": sender,
            "to": list(to or []),
            "subject": subject,
            "date": date,
            "body_sha256": None if data is None else _hash_of(bytes(data)),
            "attachments": [],
            "candidate_package_id": None,
            "realm": self.realm,
            "reason": reason,
            "next_action": next_action,
        }

    # --- 账本与事件 -------------------------------------------------------
    def _append(self, event: str, body: dict, *, correlation_id: Any, refs: dict | None = None) -> Any:
        """落账 + 按事件的 @mode 派发（`mail/*` 一律 `fact`；无 waterfall）。

        没有账本时**不追加**（不能凭空造事实）；事件未被总线上声明时不派发（也不自行发明模式）。
        """
        if self.ledger is None:
            return None
        ref = self.ledger.append(event, copy.deepcopy(body), correlation_id=correlation_id,
                                 event_class=EVENT_CLASS, actor=self.actor, refs=dict(refs or {}))
        self._dispatch(event, dict(body))
        return ref

    def _dispatch(self, event: str, body: dict) -> None:
        if self.events is None:
            return
        mode_of = getattr(self.events, "mode_of", None)
        if mode_of is None or mode_of(event) is None:
            return
        self.events.dispatch(event, copy.deepcopy(body))
