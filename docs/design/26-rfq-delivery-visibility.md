# RFQ 投递事实的视角可见性（字段级白名单）

<!-- 契约文档。口径的唯一真源是 `host/modules/projection.mjs` 的投递事实块注释 + 本页；门 `tools/verify.sh rfq-visibility`
     （围栏门 `host/t287-rfq-visibility-gate.mjs` + 真路由门 `tools/check-rfq-visibility-route.py`）逐字引用这两处。 -->

## 1. 这份契约要修的是什么（先量后改的**实测**结论）

| 量到的事实（改前） | 出处 |
|---|---|
| 供应商视角页面原文：「最新 RFQ 包：—（本视角暂无 RFQ 事件）」 | `GET /quotagent/supplier/` 真回读 |
| 同一时刻供应商 `/supplier/api/events`：**count=6**，类型分布只有 `quote/*` 与 `clarification/*`，**`rfq/*` 一条都没有** | 真回读 |
| 同一时刻承包商侧：**count=21**，含 `rfq/published`、`rfq/distributed`×2、`rfq/amended` | 真回读 |
| 供应商那本账本里 `rfq/*` **0 行**（20 行里没有一条）；`rfq/*` 事实只落在**发送方 realm**（`realm: contractor:g1`）的账本里 | 逐行量 `tmp/ui-shared/supplier/ledger.jsonl` |
| 供应商侧要读包时读的是**共享交换目录**里的交付件（`contractor/01-package.json`）：`delivered_to: ["supplier:g1"]`、`rev: 1`、`sent_at`、`spec.{deadlines,items}` | `src/quotagent/g1side.py` 的 `_read(shared, "contractor", "01-package")` |

后果：供应商**看不到要报的包、看不到 @rev、看不到报价截止、看不到改版** ⇒ 整条链的起点断了（`docs/work/plans/ui-workflow-rework.md` 的 1 号根因）。

**修法（不放宽任何隔离）**：投影层读**投递信封**（发送方放进共享交换目录的交付件，真供应商进程读的同一份文件），
按**发放对象（`delivered_to`）**做**收件人作用域**过滤，再按下面的**字段级白名单**投影成"我这一侧看到的包事实"。
**不跨读对方账本**：`ROWS 的来源仍然是本视角自己的账本`，信封是**交换面**（与 `03-exchange-protocol.md` 同族），
不是对方的私域账本（`INV-008` / `AC-TRUST-001` 的语义不变）。

## 2. 字段级白名单（**逐字段**：✓ 面向被邀供应商 / ✗ 承包商私域或他家供应商数据）

### 2.1 ✓ 可见（被邀的那一家；每个都有实测出处）

| 字段（读法） | 含义 | 实测值（g1 夹具） | 为什么被邀供应商必须看到 |
|---|---|---|---|
| `spec.package_id` | 包 id | `pkg-g1` | 没有它，供应商不知道在报哪个包（也回不了价） |
| `rev` | 版本 rev | `1`（改版后 `2`） | 不知道在报**哪一版**是「按旧版报价」这类事故的根因 |
| `spec.deadlines.quote_by` | 报价截止 | `2026-09-25T00:00:00Z` | 截止时间与催报**没有入口**（P-10 原话） |
| `spec.deadlines.clarify_by` | 澄清截止 | `2026-09-23T00:00:00Z` | 澄清窗口一过，问题就烂在手里 |
| `spec.items[].item_id` / `.code` / `.qty` / `.unit` | 行项目与数量 | `L-001/P-100/120/m`、`L-002/S-200/480/kg`（改版后 `L-001`=150） | 报价必须以**行项目 × 数量**为单位，否则只能报一个总价 |
| `spec.currency` | 币种 | `CNY` | `03` §3 的交换范围字段（`services/realm.py` 的 `DEFAULT_FIELD_CLASSES` 里是 `exchange`） |
| `sent_at`（输出里叫 `delivered_at`） | 发放时刻（**事实时间戳**） | `2026-09-23T09:00:00Z` | "我什么时候收到的"是事实，不是墙钟 |
| 发放对象 | **只出"我"这一个**（`recipient` = 本视角身份） | `supplier:g1` | 供应商要知道**这份是发给我的**；但**不看**别人（见 2.2） |

### 2.2 ✗ 不可见（**读都不读**；`DELIVERY_NEVER_READ` 就是这份清单的机检形态）

| 字段 / 类别 | 归属 | 为什么不得出现 |
|---|---|---|
| `cost_floor`、`reserve_price`、`internal_score`、`tco_weights` | 承包商私域（`private-contractor`） | 比价基准与底价：看到它就不再是竞标 |
| `other_quotes`、`bidders_private` | 承包商私域 | **其他供应商的报价**与**竞标人名册**：报价之间的横向泄漏 |
| `cost_model`、`markup_pct`、`profiles`、`internal_notes`、`authorized_band`、`calendar:private` | 对方私域 | `services/realm.py` 已登记为私域键（供应商视角本来就拒收） |
| `delivered_to` 的**其他成员**、`recipients`、`envelopes` | 他家供应商数据 | 竞标人名册：连"另有几家"这种**计数**也不出（计数同样可被用来反推局面） |
| `snapshot_hash`、`hash`、`payload_bytes` | 发送方案卷细节 | 与"我要报的包"无关（版本锚定由 `rev` 表达） |
| `06-evaluation.json`、`11-audit-pack*.json`、`private/**` | 承包商比价表与审计包 | 不在投递面上；投影只读**投递信封**这一条路（别的文件根本不进读取路径） |

### 2.3 输出形状（**恰 9 键**；门逐字断言）

```
row            = { seq: null, type: "rfq/published", correlation_id, ts: delivered_at, rfq: <9 键> }   // seq=null：**不是账本行**，不冒充账本序号
rfq（恰 9 键）  = { package_id, rev, quote_by, clarify_by, currency, items[], recipient, delivered_at, basis }
items[i]（4 键）= { item_id, code, qty, unit }
```
`basis: "delivery-envelope"` 是**来源自述**（别让读者以为这是账本行）。`summary` 由同一条 `summarize()` 从 `rfq` 派生
（含 `rev` 与两个截止的**逐字**值）。

## 3. 收件人作用域（**按身份**，身份只能来自本视角自己的账本）

- 身份 = **本视角自己那本账本**里出现过的 realm（`host/lib/ledger-view.mjs` 的 `realms()`）：0 个 ⇒ `no-identity`；
  多于 1 个 ⇒ `ambiguous-identity`（fail-closed：**一个包都不给**）。
- 可见性判定：信封的 `delivered_to` **必须命中**本视角身份（精确相等）。**不命中就当作它不存在** ——
  不是"藏起来"（藏 = 还在输出里），而是**根本没进输出**：这就是「带哨兵与不带哨兵输出**逐字节一致**」的机制来源。
- 身份**绝不来自信封**（否则等于让发送方决定收件人是谁）。

## 4. 两道**结构性负控** + 双向负控（fail-closed）

| 负控 | 判据 | 触发时 |
|---|---|---|
| ① 他家供应商数据 | 输出串里出现**任何非我的** `delivered_to` 成员 ⇒ 整条抑制 | 服务端审计 `delivery-other-recipient-suppressed`，对外**不出现那个代号** |
| ② 承包商私域 | 输出串里出现私域键名（本视角 `privateKeys` ∪ `DELIVERY_NEVER_READ`）⇒ 整条抑制 | 服务端审计 `delivery-private-key-suppressed` |
| 双向 | ① 被邀者：带哨兵（他家的信封）与不带哨兵**逐字节一致**；② 未邀者：`packages` 空 + 有名 reason | 门 `rfq-visibility` 两半都断言 |

审计只走宿主 stderr；**对外视图里不出现任何键名/代号**（抑制原因通用化，与 `projection` 既有纪律一致）。

## 5. 确定性 / 有界 / 降级（三条都要可机检）

- **确定性**：纯函数；不读墙钟、不随机、不用自增序号；信封顺序无关（同一包多版本取 `rev` 大者，同 rev 取 `delivered_at` 靠后者）。
- **有界**：`max_packages`（默认 8）/ `max_items`（默认 32）夹取，并**如实报** `omitted` / `bounded` / `truncated` / `counts.items_omitted`。
- **降级（闭合集合 7 个有名 reason）**：`view-not-a-delivery-consumer`（承包商侧不读投递）/ `no-identity` /
  `ambiguous-identity` / `identity-malformed` / `payload-not-an-object` / `no-deliveries`（没有任何信封）/
  `no-deliveries-visible`（有信封但**没有发给我的**）。降级时 `packages` 必为空、页面写清 reason。

## 6. 组装点与门（改这里要同步哪里）

| 位置 | 作用 |
|---|---|
| `host/modules/projection.mjs` | 白名单与作用域的唯一真源（`projectDeliveries`）；**纯函数**（不读文件、不取墙钟、零写面） |
| `host/lib/ledger-view.mjs` | `realms()`：身份来自本视角自己的账本 |
| `host/modules/webui.mjs` | 只读装配投递信封（`rfq_delivery` 配置：文件或目录、按文件名排序、有界）+ 首页投递块（`data-rfq-*` 抓手，**0 行 `<script>` / 0 内联事件**）+ `projectionOf()` 一次请求一次投影 |
| `host/cli.mjs`、`tools/webui-serve.py` | `--rfq-delivery`（缺省指向 g1 走查产出的 `tmp/ui-shared/contractor/01-package.json`） |
| 门 | `tools/verify.sh rfq-visibility` = 围栏门 `host/t287-rfq-visibility-gate.mjs`（26 条断言 + **4 处单点变异全红**）+ 真路由门 `tools/check-rfq-visibility-route.py`（真起两个进程、两种身份） |

**不做什么**（硬边界）：不跨读对方账本；不放宽任何既有门；不改 `AGENTS.md` / accepted ADR；宿主**零写面**
（投递信封只有读面：跑完前后账本与信封**逐字节不变**）；页面**不得**内联脚本或内联事件。

关联：`FR-RFQ-009` / `AC-RFQ-007`（任务 `T-287`，证据 `EV-160`）；上游语义见 `FR-RFQ-004`（分发记录：谁在何时收到哪个版本）、
`FR-RFQ-005`（截止时间与超时提醒）。
