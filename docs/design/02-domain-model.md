# 02 领域模型与状态机

<!-- budget: 24 KB. 标注: [假设]=待现场验证 -->

## 1. 三分类贯穿一切（P2 / ADR-0004）

| 类别 | 可变性 | 谁能产生 | 例子 |
|---|---|---|---|
| **Fact** | 不可变，只追加 | 任何一方在**记录已发生的事**时 | `rfq/published(v1)`、`quote/submitted`、`clarification/answered` |
| **Intent** | 可变、可撤回 | 单方 agent 或人 | `quote/draft`、`award/intent`、`change/proposed` |
| **Commitment** | 不可变，只能追加更正 | **双方 + 人工批准** | `award/committed`、`po/issued`、`change/approved` |

**判据（一条就够）**：该对象是否让一方对另一方产生了可主张的义务？是 → Commitment；
否但要进入对方视野 → Intent；否且只是记录 → Fact。

## 2. 实体

### 2.1 组织与边界

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `Participant` | `participant_id`, `kind∈{contractor,supplier}`, `realm`, `keys[]` | 一方；持有自己的密钥与账本 |
| `Project` | `project_id`, `name`, `participants[], currency_default, calendar` | 项目级上下文 |
| `Section` | `section_id`, `project_id`, `patches[]` | 标段；四层 patch 的最具体层 |

### 2.2 询价（承包商侧主控）

| 实体 | 关键字段 | 不变量 |
|---|---|---|
| `BidPackage` | `package_id`, `rev`, `scope[]`, `interfaces[]`, `measurement_rules`, `deliverables[]`, `exclusions[]`, `currency`, `tax_mode∈{inclusive,exclusive}`, `payment_terms`, `deadlines{clarify_by,quote_by}`, `attachments[]` | `rev` 只增；已发布版本的任何字段不可原地修改（改即 `rev+1`） |
| `LineItem` | `item_id`, `package_id`, `code`, `description`, `unit`, `qty`, `spec_refs[]`, `measurement_rule`, `notes` | `qty` 的权威方 = 承包商；`unit` 必须属于计量规则表 |
| `Interface` | `interface_id`, `between_packages[]`, `responsibility_party`, `description` | 每个接口必须有唯一责任方；否则包定义校验失败 |
| `ClarificationTicket` | `ticket_id`, `package_id`, `rfq_rev`, `asker_realm`, `question`, `refs[item_ids]`, `answer?`, `answered_by`, `broadcast_at?` | 答案必须对**全部在册投标人**广播（对称性）；未广播的回答不构成 Fact |

### 2.3 报价（供应商侧主控）

| 实体 | 关键字段 | 不变量 |
|---|---|---|
| `Quote` | `quote_id`, `package_id`, `rfq_rev`（**必填**）, `supplier_realm`, `validity_until`, `currency`, `tax_mode`, `lines[]`, `deviations[]`, `exclusions[]`, `assumptions[]`, `schedule{}`, `payment_terms_offered`, `submitted_at`, `signature` | 提交后不可修改，只能 `revise`（产生新版本）；`rfq_rev` 与当前包版本不一致时**不得进入比价**（P6） |
| `QuoteLine` | `item_id`, `unit_price`, `qty`, `amount`, `alt_offered?` | 条目必须能对应到询价清单条目或显式标为 `additional` |
| `CostModel` | 材料/人工/机具/管理/风险/税/财务，按条目 | **私域，永不出 realm**（P5） |
| `Deviation` | `deviation_id`, `item_id?`, `kind∈{technical,commercial,schedule,scope}`, `description`, `impact`, `alternative?` | 每条偏差必须标 `impact∈{price,time,risk}` |
| `CapacityCommitment` | `lead_time_days`, `milestones[]`, `binding∈{firm,indicative}` | `firm` 交期在报价有效期内不可由模型自行变更 |

### 2.4 评审与授标（承包商侧主控）

| 实体 | 关键字段 | 不变量 |
|---|---|---|
| `Evaluation` | `evaluation_id`, `package_id`, `weights`, `normalized_quotes[]`, `scores[]`, `ranking[]`, `flags[]`, `citations[]` | 所有数值必须可追溯到账本条目（`citations`）；无引用即无效 |
| `Flag` | `kind∈{abnormal_low,missing_item,capacity_risk,term_conflict,external_term}`, `severity`, `evidence_refs[]` | 护栏产出；`abnormal_low` 不得自动否决，只能提请人工 |
| `AwardIntent` | `package_id`, `supplier_realm`, `quote_id`, `reason_refs[]` | Intent：可撤回，无商业义务 |
| `AwardCommitment` | 同上 + `approved_by`, `approved_at`, `signature` | 需供应商确认 + 承包商人工批准，缺一不可 |
| `PurchaseOrder` | `po_id`, `award_id`, `lines[]`, `terms`, `issued_at` | 由 `AwardCommitment` 唯一派生，不得手工另建 |

### 2.5 履约期

| 实体 | 关键字段 | 不变量 |
|---|---|---|
| `ChangeRequest` | `change_id`, `ref_quote_lines[]`, `description`, `delta_qty`, `priced_delta?`, `basis_unit_price_ref` | 定价必须引用原报价单价作为基准，不得空白重算（痛点 1.6） |
| `Acceptance` | `acceptance_id`, `po_id`, `lines[]`, `accepted_at`, `deficiencies[]` | 验收数量不得超过订单量（差额须走变更） |
| `InvoiceMatch` | `invoice_id`, `po_id`, `acceptance_id`, `three_way∈{match,mismatch}`, `diffs[]` | 三方核对（订单-验收-发票）不一致必须留痕 |

## 3. 状态机

```
BidPackage:   draft ──publish──▶ published(rev=n) ──amend──▶ published(rev=n+1) ──close──▶ closed
                                   │                              │
ClarifyTicket: open ──answer──▶ answered ──broadcast──▶ closed     │ (rev 变化使未广播回答作废)
                                   │                              │
Quote:        draft ──human_approve──▶ ready ──submit──▶ submitted ──revise──▶ superseded(新版本)
                                                          │   └──withdraw──▶ withdrawn
                                                          │
Award:        intent ──supplier_confirm──▶ confirmed ──human_sign──▶ committed ──issue──▶ po_issued
                    └──withdraw/decline──▶ closed(no award)
ChangeOrder:  proposed ──priced──▶ priced ──human_approve──▶ approved ──apply──▶ applied ──settle──▶ settled
```

**状态机的三条硬规则**

1. **版本绑定**：`Quote.rfq_rev` 必须等于其依赖的 `BidPackage.rev`，否则停在 `draft` 并产生
   `rfq/version-mismatch` 事件（P6）。
2. **不可回退的跃迁必须有人**：`ready→submitted`、`confirmed→committed`、`priced→approved`
   三处跃迁要求 `approved_by` 非空，且批准记录本身是账本事件（P8 / AGENTS.md 规则 3）。
3. **撤回只作用于 Intent**：Fact 不可撤回；已提交的报价用 `quote/revised` 追加新版本，
   旧版本永久保留（审计要求）。

## 4. 账本事件类型（与 `05-events.md` 对应）

命名规则 `域/事件`，全部小写连字符；`Fact` 事件后缀为过去式，`Intent` 用现在式意图名。

```
kernel/*            内核：ledger/appended, plugin/loaded, plugin/unloaded, qep/rejected
rfq/*               published, amended, closed, version-mismatch
clarification/*     asked, answered, broadcast, reopened
quote/*             drafted, priced, submitted, revised, withdrawn, rejected-by-guard
norm/*              normalized, rejected(口径不可归一)
compare/*           ranked, flag-raised, conflict-with-terms
award/*             intent, withdrawn, confirmed, declined, committed
po/*                issued, amended
change/*            proposed, priced, approved, applied, settled
acceptance/*        recorded, deficiency-raised
invoice/*           matched, mismatch-raised
approval/*          requested, granted, denied
evolve/*            observed, proposed, shadowed, gated, promoted, rolled-back
```

**P4 校验方式**（可机检）：任意一次模型调用，其输入集合必须能由上述事件 + 只读引用（附件哈希）
重建。P1 实现为一条断言：`rebuild(inputs) == observed_inputs`（AC-AUDIT-001）。

## 5. 与外部系统的边界

外部系统只以两种方式进入模型：**结构化字段**（经 `ctx.norm` 归一）与**附件引用**（哈希 + 类型，
正文不进决策路径，见 `08` §3）。任何需要"读懂 PDF 正文"的判断，都先产出 `[假设]` 型 Intent，
由人工确认后升级为 Fact。这是把"模型幻觉"隔离在承诺之外的结构手段。

## 6. 规模假设 [假设]

| 量 | 假设上界 | 影响 |
|---|---|---|
| 单包清单条目 | ≤ 2000 | 归一化与比价的内存/时间预算（`10`） |
| 单包投标人 | ≤ 50 | 澄清广播与比价矩阵 |
| 单项目账本事件 | ≤ 10^6 | 投影重建策略（增量优先） |
| 报价版本 | ≤ 20/包 | 版本链长度 |

以上均为**待现场校准的假设**，进入 `../work/functional-requirements.md` 的验证清单（V-006）。
