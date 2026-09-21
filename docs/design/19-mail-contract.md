# 19 邮件集成（无凭据部分）契约

- 需求：`FR-INTEG-003`（邮件集成，P2，规划内未做）
- 阶段：P2 · 依据：`AGENTS.md`（账本唯一事实源、宿主不写账本、私域不出 realm）、ADR-0012（判定在事实层）、D-042（禁"相对当下的绝对时刻"）
- 实现：`src/quotagent/services/mail.py`（新服务；**只用标准库** `email`，不引第三方）
- 事件族：`mail/*`；验收：新条目 `AC-MAIL-001`

## 0. 本轮做什么、不做什么（诚实边界）

**做**：报文的**构造**（RFC 5322 字节）、**解析**（入站 → 结构化候选）、**幂等投递记录**（落账）、**可解释失败**。

**不做（本轮明确不做，且代码里必须显式拒绝而不是静默假装）**：
- **真正发信/收信** —— 需要 SMTP/IMAP 凭据，且要人工决定"发给谁、发什么"。
  本轮提供一个**传输边界**（`Transport`），内置 `NullTransport` **永远**返回
  `{"status": "unavailable", "reason": "mail-transport-unavailable", "next_action": "配置 SMTP/IMAP 凭据后接入"}`；
  **不允许**任何"看起来发出去了"的返回值。

## 1. 不变量（硬要求）

1. **不假装发送**：没有传输实现时，任何"发信"调用都必须返回 `unavailable` + 可解释 `reason`/`next_action`，
   并落 `mail/refused`；**不得**落 `mail/sent`（该事件本轮不声明）。
2. **确定性**：`compose()` 的 `Date` 由参数传入（不读墙钟）；同输入两次字节**完全一致**。
3. **头注入防护**：收件人/主题/任意头值里出现 `\r`/`\n` → `HeaderInjectionRejected`（不得静默清洗后发送）。
4. **私域不出 realm**（INV-008）：正文/头里不得出现 `reserve_price`/`cost_model`/`signature`/`private:` 的值；
   机检用哨兵文本断言。
5. **幂等投递记录**：同一 `(kind, to, subject, body_hash, package_id, rfq_rev)` 重复 `enqueue` →
   账本**不新增**事实行（FR-LEDGER-004 去重语义），返回 `{"duplicate": true, "seq": <原 seq>}`。
6. **解析不改状态**：`parse()` 是纯函数（不落账、不写文件）；入站**候选**不等于"已受理"，
   不得据此产生任何义务（无 commitment/PO/报价）。
7. **附件**：只允许 `text/*`（把内容做 sha256 并保留文件名）；`application/*` 等一律 `UnsupportedAttachment`
   —— 不猜二进制语义，也不把它们写进账本 body。
8. **本 realm 内**：入站解析结果带 `realm`；跨 realm 的候选在 `candidates()` 里不可见。

## 2. 数据结构（键名即契约）

```text
Message 视图 = {
  "message_id": "ml-0001",           # 服务内序号，确定性
  "kind": "rfq-notice" | "clarify" | "report",
  "package_id": "pkg-014", "rfq_rev": 2,
  "to": ["supplier@example.com"], "from": "contractor@example.com",
  "subject": "…", "date": "<参数传入的 ISO8601>",
  "body_sha256": "sha256:…", "bytes": 812, "realm": "contractor:con-B",
  "citations": ["package:pkg-014@rev2"]
}

Parse 视图 = {
  "ok": true|false,
  "from": "…", "to": ["…"], "subject": "…", "date": "…",
  "body_sha256": "sha256:…",
  "attachments": [{"filename": "…", "content_type": "text/csv", "sha256": "sha256:…", "bytes": 120}],
  "candidate_package_id": "pkg-014" | None,   # 只从主题里的**显式**标记取，猜不出就是 None
  "realm": "…",
  "reason": null | "malformed-message" | "unsupported-attachment" | …,
  "next_action": "…"                          # 失败时可行动
}
```

## 3. 方法签名

```python
class MailError(RuntimeError): ...
class HeaderInjectionRejected(MailError): ...
class UnsupportedAttachment(MailError): ...
class UnknownMessage(MailError): ...
class MailTransportUnavailable(MailError): ...   # 只在"显式要求发送"时抛

class MailService:
    def __init__(self, *, realm: str, ledger: Ledger, events: Any = None, transport: Any = None): ...
    def compose(self, *, kind: str, package_id: str, rfq_rev: int, sender: str,
                to: list[str], subject: str, body: str, date: str,
                attachments: list[dict] | None = None) -> dict      # Message 视图（不落账）
    def enqueue(self, *, message: dict) -> dict                     # 落 mail/queued（幂等）；返回 {"message_id","seq","duplicate"}
    def deliver(self, *, message_id: str) -> dict                    # 无传输实现 → 落 mail/refused 并返回 unavailable（不抛）
    def parse(self, raw: bytes) -> dict                              # 纯函数
    def candidates(self) -> list[dict]                               # 本 realm 的入站候选（只读）
    def get(self, message_id: str) -> dict
    def replay(self) -> dict                                         # 从账本重建
    def transport_status(self) -> dict                                # {"available": false, "reason": ..., "next_action": ...}
```

## 4. 事件（一律 `fact`；无 waterfall）

| 事件 | `correlation_id` | body 关键键 |
|---|---|---|
| `mail/queued` | `message_id` | `message_id, kind, package_id, rfq_rev, to[], from, subject, body_sha256, bytes, realm` |
| `mail/refused` | `message_id` | `message_id, reason, next_action, transport_available` |
| `mail/parsed` | `body_sha256` | `body_sha256, from, subject, candidate_package_id, attachments[], realm` |

**不声明 `mail/sent`**（本轮没有发送能力，声明了就会有人以为能发）。

## 5. 机检（≥12 条，注册到 `AC-MAIL-001`）

① 正控：`compose` 产出可被 `email` 解析回来的报文，关键头一致；
② **确定性**：同输入两次 `compose` 字节一致；静态扫 `time.`/`datetime`/`utc_now` → 无；
③ **头注入**：`to`/`subject` 含 `\r\n` → `HeaderInjectionRejected`，**且不落账**；
④ **不假装发送**：`deliver()` 返回 `unavailable` + `reason` + `next_action`，落 `mail/refused`，**账本无 `mail/sent`**；
⑤ 幂等：同键重复 `enqueue` → `duplicate=true` 且账本不新增；
⑥ 私域哨兵不进报文与账本 body；
⑦ 附件：`text/*` 通过并带 sha256；`application/*` → `UnsupportedAttachment`；
⑧ `parse` 纯函数（不落账、不写文件）；`candidate_package_id` 只在主题里显式标记时才有值；
⑨ 畸形报文 → `ok=false` + `reason` + `next_action`（不抛未捕获异常）；
⑩ 跨 realm 候选不可见；⑪ `replay()` 重建；⑫ 不产生义务 + 账本链仍真。
每条注明"会变红的反例"；附 ≥4 处单点变异自证。

## 6. 被否决的选项

- **本轮直接接 `smtplib` 发信**：需要凭据，且"发给谁"是人的决定 → 否决（改为传输边界 + 显式拒绝）。
- **静默清洗头里的换行**：会掩盖注入尝试 → 否决（拒绝且落账）。
- **把附件二进制写进账本 body**：账本是事实源不是文件仓库 → 否决（只留 sha256/文件名/大小）。
- **解析后自动受理为 RFQ**：入站内容未经人确认不得变成事实 → 否决（只给"候选"）。
