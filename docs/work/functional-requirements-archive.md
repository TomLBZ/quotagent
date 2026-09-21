# 功能需求归档 A（较早的一批；主文件在 `functional-requirements.md`）

<!-- budget: 32 KB（与主文件同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

本文件是 `docs/work/functional-requirements.md` 的归档。**主文件仍是契约正文**（读法、验证清单
§1 的 `V-001..V-012`、当前阶段与最近的 FR 行都在那里）。**归档不是豁免区**：

- **门的口径**：`FR-<域>-<NNN>` 的定义可以落在主文件，也可以落在本文件（以及同目录下任何
  `functional-requirements-archive*.md`）。`docs/work/functional-requirements.md` + 这些归档 = 门的
  **FR 定义集合**；`tools/check-docs.py` 按该集合判 ID 完整性、预算与 FR↔AC 覆盖
  （`tools/check-fr-coverage.py` 的覆盖矩阵按同一集合判 FR 双向全覆盖）。输出里可见 `fr_archives=[...]`。
- **搬进归档的行仍受全部断言约束**：ID 引用必须解析、文件必须在预算内、每条 FR 仍必须关联 AC
  （无孤儿）。门的输出里会打印它读了哪些归档，并**断言归档文件确实被读到**
  （归档 0 条 FR 定义行即判失败），所以"归档"不可能是绕过校验的后门。
- **逐字搬走**：下面每一行与它在主文件里时**逐字节相同**（含字段与引用），只换了所在文件。

**选入规则**（可复核）：主文件里 阶段 **不为 `P0`**、且由 git 引入时间 **≤ 2026-09-21T04:34:36Z**
的 FR 行（git 历史 `--reverse -p` 每条 FR 首次出现的时间），按主文件原行序整行搬入，分节保留原节标题。
**`P0` 行一律留在主文件**（最保守）；`FR-NEGO-001`、`FR-NEGO-002` 因
`docs/design/17-negotiation-contract.md` 明文「`functional-requirements.md`（FR 原文不动）」而留主文件
（与 `AC-NEGO-001` 同类处理）。`V-001..V-012`（§1 验证清单）**不搬**：`V-` 只认主文件。

## 2. 内核域（搬自主文件同名节）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-PLUGIN-004 | 配置更新先过可否决的更新事件，否决即不生效 | must | P1 | AC-PLUGIN-003、AC-PLUGIN-004 |
| FR-QEP-003 | `seq` 空洞检测与重发请求；不跳号处理 | must | P1 | AC-QEP-003 |
| FR-QEP-005 | 版本交集为空则拒绝通信并留痕（不静默降级） | must | P1 | AC-QEP-004 |
| FR-QEP-006 | 特性级降级必须留痕，且批准链/版本绑定/签名不可降级 | must | P1 | AC-QEP-004 |
| FR-QEP-007 | 三方协调（base/mine/theirs）+ 字段权威方 + 冲突上报 | must | P1 | AC-SYNC-001 |
| FR-QEP-008 | 崩溃后未同步事件可安全重发，不产生重复事实 | must | P1 | AC-QEP-002 |

## 3. 共享能力域（搬自主文件同名节）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-CLARIFY-002 | 答案必须广播给全部在册投标人，否则不得关闭 | must | P1 | AC-CLARIFY-002 |
| FR-CLARIFY-003 | 包版本变更时相关工单自动重开 | should | P1 | AC-CLARIFY-003 |
| FR-CLARIFY-004 | FAQ 沉淀与复用（本 realm 内） | could | P2 | AC-CLARIFY-004、AC-FAQ-001 、AC-PIPELINE-001 |
| FR-APPROVE-003 | 待批队列不阻塞 agent 其他工作；超时策略三选一且无"自动批准" | must | P1 | AC-APPROVE-003 |
| FR-GUARD-001 | 异常低价检测（对同包与历史） | must | P1 | AC-GUARD-001 |
| FR-GUARD-003 | 产能/交期可行性冲突检测 | should | P1 | AC-GUARD-002 |
| FR-GUARD-004 | 条款冲突检测（付款/质保/罚则） | should | P1 | AC-GUARD-002 |
| FR-EVIDENCE-001 | 审计包导出（事件切片 + Merkle 根 + 清单） | must | P1 | AC-AUDIT-001 |
| FR-EVIDENCE-002 | 审计包独立验证（哈希链 + 签名） | must | P1 | AC-AUDIT-001 |
| FR-EVIDENCE-003 | 模型输入重建校验（P4 的可机检实现） | must | P1 | AC-AUDIT-002 |
| FR-EVIDENCE-004 | 留存期与销毁策略可配置，销毁动作留痕 | should | P2 | AC-AUDIT-003、AC-AUDIT-005 |
| FR-EVIDENCE-005 | 审计包必须**签名**（导出方身份可验）并提供**包含证明**；验证方在**不接触原账本**的前提下可独立验证（缺字段/缺密钥不得静默通过） | must | P1 | AC-AUDIT-004 |

## 4. 承包商侧（搬自主文件同名节）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RFQ-004 | 分发记录：谁在何时收到哪个版本 | must | P1 | AC-RFQ-003 |
| FR-RFQ-005 | 截止时间管理与超时提醒（澄清截止、报价截止） | should | P1 | AC-RFQ-003 |
| FR-RFQ-006 | 包升版后，基于旧版本的报价必须被标记为**过期**（含旧/新版本号）且不得进入排序，并产生重报请求（提示对方基于新版本重报） | must | P1 | AC-RFQ-004 |
| FR-COMPARE-004 | 生成可评审的比较表（含 Flag 与差异说明），可导出 | must | P1 | AC-COMPARE-004 |
| FR-AWARD-001 | 授标意向（Intent）可撤回，可复；不产生义务 | must | P1 | AC-AWARD-001 |
| FR-AWARD-003 | PO 只能由承诺派生，不得手工另建 | must | P1 | AC-AWARD-002 |
| FR-TERMS-001 | 条款库与默认条款应用 | should | P1 | AC-TERMS-001 |
| FR-TERMS-002 | 条款冲突标注并提请人工，不得静默取其一 | must | P1 | AC-TERMS-001 |
| FR-CHANGE-001 | 变更请求引用原报价条目与单价基准 | must | P1 | AC-CHANGE-001 |
| FR-CHANGE-002 | 变更定价与差额重算；人工批准后生效 | must | P1 | AC-CHANGE-002 |

## 5. 供应商侧（搬自主文件同名节）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-COST-003 | 成本构成可解释（因子可追溯） | should | P1 | AC-COST-001 |
| FR-CAP-001 | 交期可行性校验（产能日历 + 关键路径） | should | P1 | AC-CAP-001 |
| FR-CAP-002 | `firm` 交期在报价有效期内不可由模型变更 | must | P1 | AC-CAP-001 |
| FR-DEV-002 | 替代方案建议（Intent，人工采纳） | could | P2 | AC-DEV-001 |

## 6. 协作与治理（搬自主文件同名节）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-EVAL-001 | 场景集（S1..S4）与断言执行 | must | P1 | AC-EVAL-001 |
| FR-EVAL-002 | 离线重放确定性（同输入同输出） | must | P1 | AC-EVAL-001 |
| FR-EVAL-004 | 反例集只增不减，新增需人批 | must | P1 | AC-EVAL-002 |
| FR-EVOLVE-001 | 提案结构（target/diff/rationale/expected_effect/risks/rollback_plan） | must | P2 | AC-EVOLVE-001 |
| FR-EVOLVE-002 | 影子重放与指标对比 | must | P2 | AC-EVOLVE-001 |
| FR-EVOLVE-003 | 评测门五条同时满足（含人工介入率不上升） | must | P2 | AC-EVOLVE-002 |
| FR-EVOLVE-004 | 自改范围限制：内核不可 patch；自改附提案 ID | must | P2 | AC-EVOLVE-003 |
| FR-EVOLVE-005 | canary 与自动回滚（卸载实现） | must | P2 | AC-EVOLVE-003 |
| FR-EVOLVE-006 | 提案失败三次转人工 | should | P2 | AC-EVOLVE-004 |
| FR-INTEG-002 | HTTP relay 绑定（只转发与存证） | should | P1 | AC-INTEG-002 |
| FR-INTEG-004 | 宿主与内核经 stdio NDJSON 桥通信：能力清单由内核自述；版本不兼容即拒绝且账本零新增；`commit` 面永不暴露、调用留痕；身份不可自我声明；错误码固定且带可行动 `next_action` | must | P1 | AC-INTEG-004, AC-INTEG-005, AC-INTEG-006 |
| FR-INTEG-003 | 邮件绑定（P2）；失败不得落账为"已发送" | could | P2 | AC-INTEG-003 | AC-MAIL-001 、AC-PIPELINE-001 |
| FR-UX-001 | 人工门队列视图（动作、摘要、引用链、Flag） | must | P1 | AC-APPROVE-003 |
| FR-UX-002 | 供应商视图不得暴露承包商私域字段 | must | P1 | AC-TRUST-001 |
| FR-UX-003 | 比价表导出（CSV/Excel） | should | P1 | AC-COMPARE-004 |
