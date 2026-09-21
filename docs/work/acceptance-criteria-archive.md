# 验收标准归档 A（较早的一批；主文件在 `acceptance-criteria.md`）

<!-- budget: 32 KB（与主文件同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

本文件是 `docs/work/acceptance-criteria.md` 的归档。**主文件仍是契约正文**（运行器契约、当前阶段的
AC 行与证据制度都在那里）。**归档不是豁免区**：

- **门的口径**：`AC-<域>-<NNN>` 的定义可以落在主文件，也可以落在本文件（以及同目录下任何
  `acceptance-criteria-archive*.md`）。`docs/work/acceptance-criteria.md` + 这些归档 = 门的
  **AC 定义集合**；`tools/check-docs.py` 按该集合判 ID 完整性、预算与 FR↔AC 覆盖，
  `tools/check-ac-registry.py` 按同一集合判「**phase 恰为 P0** 的 AC 必须已在 `qa list` 注册」。
- **搬进归档的行仍受全部断言约束**：ID 引用必须解析、文件必须在预算内、不得是孤儿 AC、
  P0 行仍必须注册。门的输出里会打印它读了哪些归档（`archives=[...]`），并**断言归档文件确实被读到**
  （归档 0 条 AC 行即判失败），所以"归档"不可能是绕过校验的后门。
- **逐字搬走**：下面每一行与它在主文件里时**逐字节相同**（含证据引用与命令），只换了所在文件。

**选入规则**（可复核）：主文件里 phase **不为 `P0`**、且由 git 引入时间 **≤ 2026-09-21T10:46:22Z**
的 AC 行，按引入时间升序（同批保持原文件行序）整行搬入。**`P0` 行一律留在主文件**（最保守）；
`AC-NEGO-001` 因 `docs/design/17-negotiation-contract.md` 明文「不得修改」而留主文件；
`AC-DESIGN-001..003`（文档门自身的判据、主文件 §1 散文逐条点名）留主文件。

## 2. 内核（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-AUDIT-003 | P2 | 销毁策略生效后目标事件不可再读且销毁动作本身有账本事件 | `qa ac AC-AUDIT-003` |
| AC-AUDIT-004 | P1 | 审计包带签名与包含证明，且能用独立入口（不接触原账本）验证：篡改任一字段即失败、错误密钥即失败、无签名包在 `--require-signature` 下失败并给出定位 | `qa ac AC-AUDIT-004`（入口 `tools/verify.sh audit`） |
| AC-PLUGIN-003 | P1 | 更新配置时否决者生效：配置未变、插件未重启 | `qa ac AC-PLUGIN-003` |
| AC-QEP-003 | P1 | 人为丢包造成 `seq` 空洞时，依赖该序号的跃迁被挂起并发出重发请求 | `qa ac AC-QEP-003` |
| AC-QEP-004 | P1 | 版本交集为空时通信被拒绝且落 `kernel/qep-rejected`；特性降级有账本事件 | `qa ac AC-QEP-004` |
| AC-SYNC-001 | P1 | 双方修改同一非承诺字段 → 按权威方合并；修改承诺字段 → 挂起转人工；两种情况均留痕 | `qa ac AC-SYNC-001` |

## 3. 归一化与比价（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-COMPARE-004 | P1 | 导出的比较表与账本数据一致（逐行核对），含 Flag 与差异说明 | `qa ac AC-COMPARE-004` |

## 4. 澄清、审批与护栏（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-CLARIFY-002 | P1 | 答案广播名单缺少任一在册投标人 → 工单不得关闭（INV-006） | `qa ac AC-CLARIFY-002` |
| AC-CLARIFY-003 | P1 | 包升版后相关工单自动重开，且旧答案标记为"针对旧版本" | `qa ac AC-CLARIFY-003` |
| AC-CLARIFY-004 | P2 | FAQ 命中不影响回答的版本绑定（复用不得跨版本） | `qa ac AC-CLARIFY-004` |
| AC-APPROVE-003 | P1 | 待批期间 agent 可继续其他工作；超时策略三选一生效且**不存在自动批准** | `qa ac AC-APPROVE-003` |
| AC-GUARD-001 | P0/P1 | 异常低价与漏项样本被标 Flag，且 Flag 不改变排序或状态（只标注） | `qa ac AC-GUARD-001` |
| AC-GUARD-002 | P1 | 产能冲突与条款冲突样本被标 Flag 并提请人工 | `qa ac AC-GUARD-002` |

## 5. 承包商侧与供应商侧（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-RFQ-003 | P1 | 分发记录可回答"谁在何时收到哪个版本" | `qa ac AC-RFQ-003` |
| AC-RFQ-004 | P1 | 包升版后基于旧版本的报价被标记为过期（`stale` + 旧/新版本号、可审计不清除），不进入排序（`compare` 输出里以 `quote_superseded` 显式排除），并产生重报请求 | `qa ac AC-RFQ-004` |
| AC-CAP-001 | P1 | `firm` 交期在有效期内不可由模型变更；冲突只提请人工 | `qa ac AC-CAP-001` |
| AC-TERMS-001 | P1 | 条款冲突被标注并提请人工，不静默取其一 | `qa ac AC-TERMS-001` |
| AC-AWARD-001 | P0/P1 | 缺供应商确认或缺人工签署时，`commit` 抛错；意向可撤回且无义务 | `qa ac AC-AWARD-001` |
| AC-AWARD-002 | P1 | PO 只能由承诺派生；手工构造 PO 被拒绝 | `qa ac AC-AWARD-002` |
| AC-CHANGE-001 | P1 | 变更请求必须引用原报价条目与单价基准，缺引用即拒绝 | `qa ac AC-CHANGE-001` |
| AC-CHANGE-002 | P1 | 变更差额可按原单价复算；未经批准的变更不影响任何金额 | `qa ac AC-CHANGE-002` |

## 6. 评测与自进化（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-EVAL-001 | P0/P1 | 同输入重放两次结果完全一致（确定性）；S1..S4 全绿 | `qa suite s1..s4` |
| AC-EVOLVE-001 | P2 | 提案含全部必填字段；影子重放产出指标对比 | `qa ac AC-EVOLVE-001` |
| AC-EVOLVE-002 | P2 | 门五条同时满足才放行；任一不满足则拒绝晋升 | `qa ac AC-EVOLVE-002` |
| AC-EVOLVE-003 | P2 | 对 `kernel/*` 的 patch 被拒绝（INV-010）；canary 越界触发自动回滚且 effect 全回收 | `qa ac AC-EVOLVE-003` |
| AC-EVOLVE-004 | P2 | 同类提案第三次失败后必须转人工（不再自动重试） | `qa ac AC-EVOLVE-004` |
| AC-INTEG-002 | P1 | relay 不解析 body（对其注入篡改会被验签发现）；relay 不可达时排队重试 | `qa ac AC-INTEG-002` |
| AC-INTEG-004 | P1 | 桥的协议与版本协商：内核首帧自述能力清单（与 Python 声明表一致）；只暴露 read/compute；版本不兼容→退出码 2 且账本零新增；降级留痕；确定性错误码 + `next_action`；stdout 只有协议帧 | `qa ac AC-INTEG-004`（入口 `tools/verify.sh bridge`） |
| AC-INTEG-005 | P1 | 承诺面不可达（对抗性）：宿主调 commit 面被拒且落 `kernel/bridge-rejected`；宿主播报 `human:*` 被拒（身份由内核注入）；`fact` 面默认关闭；read/compute 仍可用 | `qa ac AC-INTEG-005` |
| AC-INTEG-006 | P1 | 桥的故障语义：SIGKILL 后哈希链仍真且 durable 零丢失、重启留痕；在途请求记 unknown；重启预算 3/30s 超限降只读（只关 fact/commit）；背压丢 live 必留痕（计数 + 时间窗）且 durable 可补齐；锚点不在链中→`kernel/bridge-fault` + 只读；无孤儿；启动失败退出码 3 且账本零新增 | `qa ac AC-INTEG-006`（入口 `tools/verify.sh bridge`） |
| AC-INTEG-003 | P2 | 邮件发送失败不落账为"已发送"（账实一致） | `qa ac AC-INTEG-003` |
| AC-TRUST-001 | P0/P1 | 对方私域字段在本侧投影、模型输入、视图中三处均不存在（INV-008） | `qa ac AC-TRUST-001` |

| ID | 阶段 | 断言 | 命令 | 证据 |
|---|---|---|---|---|
| AC-RUNTIME-003 | P2 | FR-RUNTIME-003：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（audit-hook 门 7/7） | 见 `evidence/EV-068` |
| AC-RUNTIME-004 | P2 | FR-RUNTIME-004：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（budget-guard 门 10/10 + budget-route 门 5/5） | 见 `evidence/EV-085` |
| AC-RUNTIME-005 | P2 | FR-RUNTIME-005：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（breaker 门 10/10 + breaker-route 门 4/4） | 见 `evidence/EV-077` |
| AC-RUNTIME-006 | P2 | FR-RUNTIME-006：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（governor 门 9/9） | 见 `evidence/EV-067` |
| AC-RUNTIME-007 | P2 | FR-RUNTIME-007：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（observability 门 6/6） | 见 `evidence/EV-071` |
| AC-RUNTIME-008 | P2 | FR-RUNTIME-008：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（modules 门 248/248） | 见 `evidence/EV-038` |
| AC-RUNTIME-009 | P2 | FR-RUNTIME-009：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（idempotency-guard 门 10/10 + idem-route 门 5/5） | 见 `evidence/EV-083` |
| AC-EVIDENCE-003 | P2 | FR-EVIDENCE-006：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（evolve-module 追溯门 11/11 + webui 21/21） | 见 `evidence/EV-075` |
| AC-EVOLVE-005 | P2 | FR-EVOLVE-007：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（evolve-journal 门 7/7） | 见 `evidence/EV-080` |
| AC-PRICE-002 | P2 | FR-PRICE-003：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（evolve-module 追溯门 11/11 + webui 21/21） | 见 `evidence/EV-073` |
| AC-RFQ-005 | P2 | FR-RFQ-007：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（modules 门 248/248） | 见 `evidence/EV-039` |
| AC-EVAL-003 | P2 | FR-EVAL-005：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（supplier-scorecard 门 10/10 + webui 21/21） | 见 `evidence/EV-082` |
| AC-RUNTIME-010 | P2 | FR-UX-004：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（ops-view 门 9/9 + webui 21/21） | 见 `evidence/EV-079` |
| AC-PLUGIN-004 | P2 | FR-PLUGIN-004：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（coverage 门 + plugins 门 + evolve-module 门） | 见 `evidence/EV-086` |
