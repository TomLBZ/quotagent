# 06 Agent 设计、工具契约与提示词组装

<!-- budget: 26 KB -->

## 1. 角色矩阵

**通用约束**：所有 agent 只能产出 Fact（记录已发生）、Intent（建议）或"待批的承诺草案"。
**没有任何 agent 可以直接产生 Commitment**（AGENTS.md 规则 3）。

| 侧 | Agent | 输入 | 产出 | 关键工具 | 人工门 |
|---|---|---|---|---|---|
| 承包商 | `SourcingAgent` | 设计/需求文本、历史包、行业模板 | 包草案 + 清单条目草案 | `intake_spec`, `draft_package`, `draft_items` | 包范围与清单确认 |
| 承包商 | `ClarifyAgent` | 澄清工单、包版本、历史 FAQ | 答案草案 + 广播名单 | `answer_draft`, `faq_lookup`, `broadcast` | 答案定稿 |
| 承包商 | `CompareAgent` | 归一化报价、权重策略、条款库 | 排序建议 + Flag + 引用链 | `rank`, `tco`, `cite`, `flag_list` | 评审结论 |
| 承包商 | `AwardAdvisor` | 排序、Flag、历史授标 | 授标意向草案 + 理由引用 | `award_intent_draft` | 授标签署（两人复核可选） |
| 承包商 | `ChangeAgent` | 变更请求、原报价条目 | 重新定价草案 | `repricing_draft` | 变更批准 |
| 供应商 | `IntakeAgent` | 包 + 清单 + 规格引用 | 条目抽取 + 缺项 + 疑问 | `ingest`, `missing_check`, `question_draft` | 疑问发出前确认 |
| 供应商 | `CostAgent` | 条目、历史成本、产能 | 成本构成（私域） | `cost_build`, `unit_cost`, `explain` | 成本基价 |
| 供应商 | `PriceAgent` | 成本构成、策略 patch、竞争情报 | 定价建议 + 风险准备金 | `price_propose`, `margin_check` | **最终报价数字** |
| 供应商 | `CapacityAgent` | 交期要求、产能日历 | 可行性 + 交期草案 | `capacity_check`, `slot_reserve` | 交期承诺 |
| 供应商 | `DeviationAgent` | 包规格 vs 己方能力 | 偏差表 + 替代方案 | `deviation_capture`, `impact` | 偏差正式声明 |
| 双方 | `AuditorAgent` | 账本切片 | 重建校验报告 | `evidence_export`, `rebuild`, `verify` | 无（只读） |
| 双方 | `EvalAgent` | 场景集、账本 | 评测报告 | `eval_run`, `replay`, `diff` | 门槛由人设定 |
| 双方 | `EvolveAgent` | 失败样本、指标漂移 | 自进化提案 | `observe`, `propose`, `shadow`, `gate` | 晋升批准（P2） |

## 2. 工具契约

### 2.1 三类工具

| 类别 | 后果 | 要求 |
|---|---|---|
| 只读 (`read`) | 无副作用 | 可自由调用；读取范围受 realm 限制 |
| 写本地 (`write-local`) | 写本地账本/草稿 | 必须经 `ctx.ledger.append`，返回引用；注册为 effect |
| 提议 (`propose`) | 产生 Intent | 必须带 `citations[]`；无引用即拒绝 |
| 对外 (`outbound`) | 可被对方看见 | **必须经人工门**；由 `ctx.qep` 发送 |

### 2.2 工具表（按角色；全部必须声明 mode 与引用要求）

```
read:            inspect_ledger, read_package, read_quote, faq_lookup, policy_get, capacity_calendar
write-local:     draft_package, draft_items, draft_question, draft_answer, draft_quote, draft_deviation
propose:         rank, tco, flag_list, award_intent_draft, price_propose, repricing_draft
outbound(需批):  publish_rfq, broadcast_answer, submit_quote, commit_award, issue_po, approve_change
meta:            approval_request, escalate, assumption_raise, evidence_export, eval_run, evolve_propose
```

### 2.3 工具的三条硬约束

1. **私域隔离**：面向一方的工具在注册时绑定 realm；跨 realm 调用直接拒绝（INV-008）。
2. **引用强制**：所有 `propose` 类工具的输出 schema 要求 `citations[]`（账本引用 + `item_id`）。
   schema 校验失败即工具失败，不做"尽力而为"（P8）。
3. **承诺旁路禁止**：`outbound` 类工具的内部实现必须调用 `ctx.approval.chain(ref)`，
   无批准记录则抛错。这是唯一的对外出口，agent 无法绕过。

## 3. 提示词组装

```
[固定前缀 · 不可被上下文压缩移除]
  角色与目标（一句话）
  硬约束：三分类（Fact/Intent/Commitment）、不可承诺、必须引用、私域边界、不确定即 escalate
  输出 schema（每类产出的 JSON schema）
[账本投影 · 按任务检索，可裁剪]
  当前包/报价的状态摘要（含版本号与截止时间）
  与任务相关的条目/澄清/条款条目
[任务]
  本轮目标 + 允许的工具清单 + 停止条件
[后置校验 · 模型看不到]
  schema 校验 → 引用校验 → guard 检查 → 人工门
```

**组装规则**

1. 固定前缀不含任何可变业务数据，避免被历史污染（也便于 P4 重建时区分）。
2. 账本投影只放**本 realm 可见**的内容；对方私域字段根本不存在于本 realm 的投影中。
3. **附件的正文永不进入提示词**：只放引用（文件名 + 哈希 + 已抽取的结构化字段）。
   需要理解正文时，先产出 `assumption_raise`，人工确认后才成为事实。
4. 每轮提示词的输入集合记为 `inputs[]`（引用列表），落账本；`ctx.evidence.rebuild` 据此校验（P4）。

## 4. 记忆分层

| 层 | 位置 | 生命周期 | 谁能写 |
|---|---|---|---|
| 会话记忆 | 进程内，随 fiber 卸载回收 | 一次任务 | agent |
| 项目记忆 | 本 realm 账本 + 知识库（FAQ、历史报价、中标率） | 项目周期 | agent（须 `citations`） |
| 策略记忆 | 公司策略 patch（权重、阈值、让步上限） | 跨项目 | **仅人**（agent 只能提案） |
| 跨方共识 | 双方账本 + `base` revision 向量 | 项目周期 | 协议（`03` §4） |

**记忆不是数据库表**：项目记忆是账本的可重建投影；丢掉缓存不丢事实（`03` §7）。

## 5. 幻觉与不确定性的结构性处置

| 现象 | 处置 | 落点 |
|---|---|---|
| 模型编造条目/单价 | 输出无 `citations` 即拒收 | `agent/output-drafted` waterfall |
| 模型推断图纸内容 | 一律标 `[假设]`，人工确认后转 Fact | `agent/assumption-raised` |
| 模型给出"建议报价"被误当承诺 | 产出类型只有 Intent；提交走人工门 | `ctx.approval` |
| 模型遗漏清单条目 | `IntakeAgent` 的缺项检测 + `guard.missing_item` | `ctx.guard` |
| 模型被报价正文诱导（注入） | 正文不进提示词；仅结构化字段 | §3 规则 3 |
| 模型自信但错 | 引用校验只能挡"无据"，需人工门挡"有据但错" | 角色矩阵的人工门 |

**诚实边界**：以上机制降低幻觉进入决策链的概率，**不消除**模型判断错误本身。
因此所有承诺点都保留了人工签字，且所有结论都留引用链以便事后追责。

## 6. 人工门的交互设计（P8：不阻塞异步流程）

- 人工门以**队列**形式存在：agent 把待批项投入 `ctx.approval`，继续做其他不依赖该批准的工作。
- 每项待批含：动作、payload 摘要、引用链、模型置信度（可选）、超时策略。
- 超时策略三选一（由策略 patch 设定）：`remind`（默认）· `escalate`（转上级）· `abort`（作废本次意图）。
  **绝不允许**"超时自动批准"。
- 一次批准绑定一个 `scope`（如 `quote.submit`），不可复用到其他动作。

## 7. 上下文压缩与崩溃时的 agent 行为

- 上下文压缩只允许丢弃"可重建的投影"，不得丢弃固定前缀中的硬约束（引 `AGENTS.md` 规则 2 与 P4）。
- agent 崩溃后重启：从账本重放本 realm 状态 → 读 `docs/work/handover.md` 与 `.agents/state.json`
  → 决定继续还是升级到人。**未提交的草稿允许丢失**（`03` §7）。
