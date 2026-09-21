# 18 澄清 FAQ 的沉淀与复用（契约）

- 需求：`FR-CLARIFY-004`（FAQ 沉淀与复用，**本 realm 内**）；验收：**`AC-CLARIFY-004`**（既有条目）
- 阶段：P2 · 依据：`AGENTS.md` 铁律（账本唯一事实源、宿主不写账本、人工门 P8）、ADR-0012（判定在事实层）、D-042（AC 不得含相对当下的绝对时刻）
- 实现：`src/quotagent/services/faq.py`（新服务，**不改** `services/clarify.py`）
- 事件族：`faq/*`（与 `negotiate/*`、`evidence/*` 同风格；两侧登记后才可由 `verify.sh events` 放行）

## 1. 为什么单独一个服务

`ClarificationService`（`services/clarify.py`）管**一次问答的生命周期**（ask/answer/broadcast/close）。
FAQ 是**沉淀与复用**：把已答问题抽成条目，供后续同版本的重复提问复用。
两者职责不同、生命周期不同 → **新服务**，且**只读** clarify 的账本行（不调用其内部方法，避免耦合）。

## 2. 核心不变量（本契约的硬要求）

1. **版本绑定不可跨**（AC-CLARIFY-004 的字面要求）：条目带 `package_id` + `rfq_rev`；
   复用查询只接受**同 package 同 rev**；跨版本一律 `hit=false` + `reason="faq-version-mismatch"` +
   `next_action`，**且不得返回任何条目内容**（含摘要）—— 不允许"最接近的另一版本"这种静默降级。
2. **命中不改版本绑定**：`reuse()` 是**纯读**：不写账本、不改票单 `rfq_rev`、不改任何状态；
   它只返回条目与"为什么命中"的依据（`citations`）。
3. **沉淀必须人发**：`publish()` 的 `by` 必须以 `human:` 开头，否则抛 `AgentCannotPublish`；
   非 `human:` 不得发布（与 `negotiate.declare_bounds` 同一纪律）。
4. **本 realm 内**：只沉淀本服务 realm 的票单；跨 realm 的条目一律不可见（读侧过滤 + 机检断言）。
5. **私域不出 realm**：条目只保留**问题文本的规范化哈希**与**答复里显式声明为可复用的字段**；
   私域键（`reserve_price`/`cost_model`/`signature`/`private:`）**不得**进入条目（INV-008）。
6. **不读墙钟**：需要时间一律由参数传入（照 `approval.sweep(now=...)`）。
7. **不产生义务**：不得写 commitment / PO / 报价外发类事件。
8. **确定性**：同输入两次 `distill()/reuse()` 的产物字节一致（不依赖字典顺序、不依赖墙钟）。

## 3. 数据结构（键名即契约）

```text
Entry 视图 = {
  "entry_id": "fq-0001",              # 服务内序号，确定性
  "package_id": "pkg-014",
  "rfq_rev": 2,                        # **版本绑定**（跨版本即不可复用）
  "question_norm": "sha256:…",         # 规范化问题的哈希（不存原文，避免把私域带进条目）
  "question": "…",                     # 可选：仅当发布者显式给出且非私域
  "answer_fields": {...},             # 仅可复用字段（白名单：unit/deadline_note/…）
  "source_ticket": "cl-0007",
  "published_by": "human:owner",
  "published_at": "<账本行 ts>",        # 取自账本，不读墙钟
  "citations": ["ledger:cl-0007", "package:pkg-014@rev2"]
}

Reuse 视图 = {
  "hit": true|false,
  "package_id": …, "rfq_rev": …, "question_norm": …,
  "entry": Entry|None,                 # hit=false 时**必须**为 None
  "reason": "faq-hit" | "faq-version-mismatch" | "faq-not-published" | "faq-unknown-package",
  "next_action": "…",                   # 可行动的一句话（拒绝也要能指导下一步）
  "citations": [...]
}
```

## 4. 方法签名

```python
class FaqService:
    def __init__(self, *, realm: str, ledger: Ledger, events: Any = None): ...

    def distill(self, *, package_id: str, rfq_rev: int) -> list[dict]   # 候选（只读、不落账）
    def publish(self, *, package_id: str, rfq_rev: int, ticket_id: str,
                by: str, question: str = "", fields: dict | None = None) -> dict   # Entry 视图 + 落 faq/entry-published
    def reuse(self, *, package_id: str, rfq_rev: int, question: str) -> dict        # Reuse 视图（纯读；命中落 faq/reuse-served，版本不符落 faq/reuse-refused）
    def entries(self, *, package_id: str | None = None, rfq_rev: int | None = None) -> list[dict]
    def get(self, entry_id: str) -> dict
    def replay(self) -> dict   # 从账本重建条目集（对齐 approval.replay / negotiation.replay）
```

异常（不可改名者标 **不可改**）：

| 异常 | 归属 | 触发 |
|---|---|---|
| `FaqError` | 本契约（基类，`RuntimeError` 子类） | — |
| `AgentCannotPublish` | 本契约 | `by` 不以 `human:` 开头 |
| `UnknownEntry` | 本契约 | 不存在的 `entry_id` |
| `UnknownTicket` | 本契约 | 票单不存在或不属于本 realm |
| `FaqVersionMismatch` | 本契约（**只在 `publish` 用**：发布时票单版本与参数不一致即拒） | `ticket.rfq_rev != rfq_rev` |
| `ApprovalRequired` / `AgentCannotApprove` | **不可改**（`approval.py`） | 若测试用到门 |
| `PrivateAccessDenied` | **不可改**（`costmodel.py`） | 跨 realm 读成本 |
| `LedgerFrozenError` | **不可改**（`kernel/ledger.py`） | 冻结后追加 |

**注意**：`reuse()` 的**跨版本情形不抛异常**，而是 `hit=false` + `reason`（调用方需要"能不能用"的答案，不是异常流）——
但**机检必须断言"没有返回任何条目内容"**。

## 5. 事件（`event_class` 一律 `fact`；无 waterfall）

| 事件 | `correlation_id` | body 关键键 |
|---|---|---|
| `faq/entry-published` | `entry_id` | `entry_id, package_id, rfq_rev, question_norm, source_ticket, published_by, fields_used[]` |
| `faq/reuse-served` | `entry_id` | `entry_id, package_id, rfq_rev, question_norm, citations[]` |
| `faq/reuse-refused` | `package_id` | `package_id, rfq_rev, question_norm, reason, next_action` |

## 6. 机检（≥12 条；实现轮次交付，注册到新 AC `AC-FAQ-001`）

① 正控：发布后同版本 `reuse` 命中且返回条目；② **跨版本 `reuse` 必须 `hit=false` 且 `entry is None`**（AC-CLARIFY-004 的正面）；
③ 命中**不改任何状态**（票单 `rfq_rev` 不变、账本除 `reuse-served` 外无新增）；
④ 非 `human:` 发布被拒（`AgentCannotPublish`）且**不落** `entry-published`；
⑤ `publish` 的票单版本不符被拒（`FaqVersionMismatch`）；
⑥ 跨 realm 条目不可见；⑦ 私域键不进条目（哨兵文本断言）；
⑧ 确定性（两次 `distill` 字节一致、不读墙钟：静态扫 `time.`/`datetime`/`utc_now`）；
⑨ `replay()` 从账本重建（新实例看到同样的条目）；⑩ 不产生义务（无 commitment/PO/报价事件）；
⑪ 拒绝路径带 `reason` + `next_action`；⑫ 账本链仍真。
每条都要注明"**会变红的反例**"；并附 ≥3 处单点变异自证。

## 7. 被否决的选项（记录理由，免得下次重来）

- **跨版本"最接近匹配"**：直接违反 AC-CLARIFY-004 的"复用不得跨版本" → 否决。
- **命中时顺手更新票单**（把 FAQ 答案写进票单）：命中就会改状态，版本绑定可能被隐式改写 → 否决（`reuse` 保持纯读）。
- **自动沉淀（模型抽条目不给人看）**：沉淀物会被别人复用，等于把未审内容变成"事实" → 否决（必须 `human:` 发布）。
- **把 FAQ 塞进 `clarify.py`**：两个生命周期耦合，且会让既有 AC 的断言面变模糊 → 否决。
