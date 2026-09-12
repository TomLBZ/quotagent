# ADR-0009 P0 的归一化、版本化与读包落地语义

Status: accepted

## Problem

S0.6–S0.8 首次把三条业务语义落到字节与事件上，而设计文档只写到"应该怎样"：

1. `05-events.md` 说 `quote/normalize` 是 waterfall 链、"任一环拒绝即短路"，但没说阶段顺序与
   拒绝形态；`02-domain-model.md` 又给了 `norm/* rejected` 族的事件名，与 `05` 的 `quote/normalized`
   形成两个命名家族（本仓库禁止一处两写）。
2. AC-NORM-001 要求"归一后金额误差在**声明容差**内"——容差从哪里来、存在哪里、事后怎么复核，没有定义。
3. 报价条目允许"显式标为 `additional`"（`02` §2.3），但 `additional` 条目不在清单内、因此没有
   包内计量规则；此时"按什么归一"必须显式决定，否则等于偷偷兜底（P6 禁止）。
4. `BidPackage` 的"已发布版本不可原地修改"需要一个可机检的实现形态（AC-RFQ-002 要实测它）。
5. 读包的"无来源引用"与"疑问草案必须人工确认后才外发"需要一个不可绕过的落点（AC-INTAKE-001/002）。

按 `AGENTS.md` 规则 8（协议与账本格式变更必须新增 ADR），这些必须成文。

## Decision

1. **归一化阶段的顺序与短路**：`quote/normalize`（waterfall）固定为
   **单位 → 币种（含汇率时点）→ 税 → 计量规则 → 条目对齐**，五段依次注册为可撤销的 effect
   （`07-self-evolution.md` §2：归一化规则可卸载替换）。任一阶段返回 `Rejection` 即短路，
   `normalize()` 返回 `result=None` 且**不产生任何金额**。
2. **拒绝是一件有内容的事**：`Rejection{code, reason, next_action, item_id, details}`；
   `next_action` 必须写"人/系统下一步能做什么"（对应 R-002 的对策：拒绝理由要给下一步动作）。
   P0 的拒绝码：`measure_rule_missing`、`unit_not_in_measure_rule`、`fx_timepoint_unavailable`、
   `tax_rule_missing`、`unaligned_line`。
3. **事件命名与留痕**：成功落账 `quote/normalized`（durable，含行数、总额、容差、对齐摘要与结果哈希）；
   失败落账 **`quote/normalize-rejected`**（durable，含 code/reason/next_action）。`02-domain-model.md`
   §4 的 `norm/*` 族由此并入 `quote/*` 族（`normalize` / `normalized` / `normalize-rejected`），
   一处一事实。
4. **声明容差来自计量规则**：`MeasureRule.tolerance_bps` 是唯一容差来源，随归一化结果
   （`NormalizationResult.tolerance_bps`、每行的 `tolerance_bps`）与账本事件一起留存。
   AC-NORM-001 用它对账，因此"容差"是可复核的声明值，不是测试里的常量。
5. **汇率时点必须精确命中**：`FxBook.rate_at(base, quote, at)` 只接受与该时点**完全相等**的汇率记录；
   查不到即拒绝（`fx_timepoint_unavailable`，details 里给出该币种对已有可用时点列表）。
   不允许"取最近一条"或"用缓存汇率算完"（P6）。
6. **`additional` 条目的归一来源必须显式**：清单内条目必须有计量规则（否则拒绝）；
   `additional` 条目不在清单内，按**报价单位本身**归一（不做单位换算），并在
   `factors.measure_rule.source = "derived_from_unit_for_additional"` 中留下推导标记；
   清单内条目为 `package_measure_rule`。未被报价的清单条目进入 `alignment.missing`（漏项可见），
   既不在清单也未标 `additional` 的条目以 `unaligned_line` 拒绝并列出（不静默丢弃）。
7. **已发布版本只增不改**：`rev` 从 0（草稿）到 1（发布）只增；`revision(rev)` 返回递归只读视图
   （dict → `MappingProxyType`、list → `tuple`），原地写入抛 `TypeError`；显式的
   `modify_published()` 抛 `PublishedVersionImmutable`；`amend()` 产生新版本 + **字段级 delta**
   （`{item_id|"package", field, before, after}`），并落账 `rfq/amended`。发布前置校验：
   清单单位必须属于计量规则表、每个接口必须有唯一责任方、必须有 `deadlines.quote_by`。
8. **读包的两条门**：抽取结果逐条带 `item_id` 与来源引用（`<package>#rev<N>:<item_id>`）；
   无来源引用的抽取项标 `[假设]` 且**不得由 agent 自行升级为事实**（`confirm_assumption` 只接受
   `human:*`，否则抛 `UnconfirmedDraftError`）。疑问草案必须人工确认后才能外发
   （`send_questions()` 对未确认项抛错），外发时逐条落账 `clarification/asked`（含 `confirmed_by`）。

## Consequences

**正向**

- 归一化的每次成功/失败都可从账本复算：容差、汇率时点、税率、计量规则来源都在事件里。
- 拒绝理由可行动：每条拒绝都说明"谁下一步做什么"，避免"归一失败"这种无法处理的报错。
- 版本不可变是结构性的（只读视图 + 内容哈希 + rev 只增），不依赖调用方自觉。
- `additional` 与漏项都被显式呈现，避免"条目悄悄消失"。

**负向**

- `MappingProxyType` 视图在跨进程序列化时需要先转普通 dict（`copy.deepcopy` 会在写路径里做这件事）。
- 精确命中的汇率时点要求报价方声明 `fx_at`，比"取当天汇率"多一步人工/配置动作（有意为之）。
- `additional` 条目不做单位换算，因此不同单位的 `additional` 条目之间不可直接比较（P0 可接受）。
- 读包的 `[假设]` 通道每轮都需要人工确认，是流程成本（对应 V-002 的现场验证项）。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 归一化失败返回"尽力而为的部分结果 + 警告" | 违反 P6 与 AC-NORM-002 的"不产生结果"；部分结果会被下游当成可用金额 |
| 容差写成实现里的常量 | 容差是行业/项目口径，必须可声明、可复核、随证据留存 |
| 汇率取"最近可得时点" | 这正是现场争议来源（时点不同价不同），会静默改变金额 |
| `additional` 条目照抄某个清单条目的计量规则 | 猜测口径；且会让不可比的数字看起来可比 |
| 已发布版本用 `copy.deepcopy` 返回可写副本 | 不可变性必须是结构性的，靠约定会被绕过 |
| 假设项允许 agent 自升级（加"低置信度"标记） | 与"承诺/事实需人确认"的内核规则冲突（INV-005 的同类风险） |

## Revisit conditions

1. 若现场口径需要"一个条目多个计量规则（按工况切换）"，`MeasureBook` 需支持规则版本化并新写 ADR。
2. 若 B3 之后引入汇率曲线（带有效期区间而非时点），本 ADR 第 5 条改为区间查询 + 显式声明所用时点。
3. 若 `additional` 条目在真实报价中占比 > 10%（V 项结论），需要给它立独立的计量与比价规则。
4. 若疑问清单的人工确认成为瓶颈（R-003），改为批量确认 + 阈值内自动——阈值仍由人设定。
