# 功能需求（FR）

<!-- budget: 32 KB. 每条 FR 必须有优先级、所属阶段、关联 AC；无 AC 的 FR 不得进入实现 -->

## 0. 读法

- ID：`FR-<域>-<NNN>`；优先级：`must`（不做则阶段不成立）· `should`（阶段内应做）· `could`（可延后）。
- 阶段：P0 mock · P1 mvp demo · P2 product（定义见 `roadmap.md`）。
- 每条需求都引用 `acceptance-criteria.md` 中的 AC；**AC 未定义的需求不得实现**（AGENTS.md 规则 6）。
- 服务与事件细节见 `../design/04-services-catalog.md` 与 `../design/05-events.md`，本文件不重复定义。

## 1. 验证清单（V）：未验证的假设

**规则**：凡标 `[假设]` 的设计断言都必须在这里有一条 V 记录。V 未验证前，相关设计不得升格为
"已确认事实"，相关指标不得设目标值。

| ID | 假设 | 验证方式 | 判定标准 | 影响 |
|---|---|---|---|---|
| V-001 | 澄清往返是报价周期的主要耗时来源 | 现场访谈 2 家承包商 + 3 家供应商，抽样 5 个已结项包 | 澄清耗时占比 ≥ 20% 则成立 | 决定 `ctx.clarify` 的优先级 |
| V-002 | 供应商愿意提交结构化报价（对称性假设） | 用 S1 场景模板做 3 次盲测，看供应商是否接受模板与字段 | ≥ 2/3 接受则成立 | 决定 P1 是否有意义 |
| V-003 | 采购方接受"AI 排序建议 + 人工签署" | 与 2 名采购负责人评审 S1 比价结果 | ≥ 1 名愿意在真实包上试用则成立 | 决定 `ctx.compare` 的推广路径 |
| V-004 | 包边界在澄清后会被修改（需版本化） | 抽样 10 个历史包的 rev 次数 | 平均 rev > 1 则成立 | 决定 RFQ 版本化的复杂度投入 |
| V-005 | 变更争议主要源于"原报价未条目化" | 抽取 10 份历史变更单的争议描述 | ≥ 5 份提到单价/条目缺失则成立 | 决定 `change` 与报价条目化的强绑定 |
| V-006 | 规模上界（条目 ≤2000、投标人 ≤50、事件 ≤10^6） | 向现场索取真实项目统计 | 超出则修订 `10-nonfunctional.md` §8 | 决定性能预算与存储选型 |
| V-007 | 协作确是跨法人（非同一集团内部） | 确认参与方法律关系与结算主体 | 跨法人则 ADR-0001/0003 前提成立 | 影响隔离模型与账本同步 |
| V-008 | 电子证据在审计中的采信标准 | 咨询 1 名审计/法务 | 明确采信要求则修订 `09` §4 | 决定证据包形态 |
| V-009 | 异常低价判定的合理阈值 | 用历史中标数据做分布分析 | 形成分布结论则写入策略 patch | 决定 guard 默认值 |
| V-010 | 留存期与销毁策略要求 | 咨询合规 | 得到明确期限则写入项目 patch | 决定存储与留存实现 |
| V-011 | 邮件/文件投递在双方间实际可用 | 与一家供应商做一次真实投递演练 | 成功送达并可校验签名则成立 | 决定 P1 绑定选择 |
| V-012 | 供应商侧最痛的是"读包 + 澄清 + 重复录入" | 访谈 3 家供应商 | ≥ 2 家认同则成立 | 决定供应商侧功能排序 |

## 2. 内核域

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-LEDGER-001 | 提供 append-only 账本，含哈希链；事件一经追加不可修改 | must | P0 | AC-AUDIT-001 |
| FR-LEDGER-002 | 从账本可重建任意时点投影（全量与增量） | must | P0 | AC-AUDIT-002 |
| FR-LEDGER-003 | 账本启动与每次追加后校验哈希链，失败即停发 | must | P0 | AC-AUDIT-001 |
| FR-LEDGER-004 | 同一 `(correlation_id, type, body_hash)` 不产生第二条事实 | must | P0 | AC-QEP-002 |
| FR-EVT-001 | 事件五模式分发（emit/parallel/serial/bail/waterfall） | must | P0 | AC-EVT-001 |
| FR-EVT-002 | 监听器注册返回 disposer，卸载后自动注销 | must | P0 | AC-PLUGIN-001 |
| FR-EVT-003 | waterfall 不调 `next()` 即短路，且短路点必须在文档登记 | must | P0 | AC-EVT-002 |
| FR-PLUGIN-001 | 插件装载/卸载，依赖未就绪不得激活 | must | P0 | AC-PLUGIN-001 |
| FR-PLUGIN-002 | 依赖变化自动触发消费者重载/失活，不自动迁移草稿 | must | P0 | AC-PLUGIN-002 |
| FR-PLUGIN-003 | 卸载后无残留订阅、定时器、外部通知 | must | P0 | AC-PLUGIN-001 |
| FR-PLUGIN-004 | 配置更新先过可否决的更新事件，否决即不生效 | must | P1 | AC-PLUGIN-003 |
| FR-QEP-001 | 构造/校验/签名/验签 QEP 信封 | must | P0 | AC-QEP-001 |
| FR-QEP-002 | 承诺类报文缺人工批准即拒收 | must | P0 | AC-APPROVE-002 |
| FR-QEP-003 | `seq` 空洞检测与重发请求；不跳号处理 | must | P1 | AC-QEP-003 |
| FR-QEP-004 | 至少一次投递 + 幂等去重 | must | P0 | AC-QEP-002 |
| FR-QEP-005 | 版本交集为空则拒绝通信并留痕（不静默降级） | must | P1 | AC-QEP-004 |
| FR-QEP-006 | 特性级降级必须留痕，且批准链/版本绑定/签名不可降级 | must | P1 | AC-QEP-004 |
| FR-QEP-007 | 三方协调（base/mine/theirs）+ 字段权威方 + 冲突上报 | must | P1 | AC-SYNC-001 |
| FR-QEP-008 | 崩溃后未同步事件可安全重发，不产生重复事实 | must | P1 | AC-QEP-002 |

## 2.1 运行时与运行器（P0 S0.1）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RUNTIME-001 | 仓库内自包含运行时：实现仅依赖 Python 3.9+ 标准库；解释器由仓库内脚本解析（仓库 `.venv` 优先，可被 `QUOTAGENT_PY` 覆盖）；运行不写仓库外文件 | must | P0 | AC-RUNTIME-001 |
| FR-RUNTIME-002 | CLI 骨架：`python -m quotagent.qa` 提供 `ac`/`suite`/`list` 入口；AC 报告为机器可读 JSON，退出码 0=通过、1=断言失败、2=未知入口 | must | P0 | AC-RUNTIME-002 |

## 3. 共享能力域

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-NORM-001 | 单位、币种与汇率时点、含税口径、计量规则归一化 | must | P0 | AC-NORM-001 |
| FR-NORM-002 | 不可归一即拒绝并留痕，不得猜测兜底 | must | P0 | AC-NORM-002 |
| FR-NORM-003 | 报价条目与询价清单条目对齐（含 `additional` 标记） | must | P0 | AC-NORM-003 |
| FR-NORM-004 | 包版本与报价版本一致性门（不一致不得进比价） | must | P0 | AC-COMPARE-001 |
| FR-CLARIFY-001 | 澄清工单绑定包版本与条目引用 | must | P0 | AC-CLARIFY-001 |
| FR-CLARIFY-002 | 答案必须广播给全部在册投标人，否则不得关闭 | must | P1 | AC-CLARIFY-002 |
| FR-CLARIFY-003 | 包版本变更时相关工单自动重开 | should | P1 | AC-CLARIFY-003 |
| FR-CLARIFY-004 | FAQ 沉淀与复用（本 realm 内） | could | P2 | AC-CLARIFY-004 |
| FR-APPROVE-001 | 人工门：请求、批准、拒绝、代签禁止 | must | P0 | AC-APPROVE-001 |
| FR-APPROVE-002 | 批准绑定 scope，不可跨动作复用 | must | P0 | AC-APPROVE-002 |
| FR-APPROVE-003 | 待批队列不阻塞 agent 其他工作；超时策略三选一且无"自动批准" | must | P1 | AC-APPROVE-003 |
| FR-GUARD-001 | 异常低价检测（对同包与历史） | must | P1 | AC-GUARD-001 |
| FR-GUARD-002 | 漏项检测（清单对齐） | must | P0 | AC-GUARD-001 |
| FR-GUARD-003 | 产能/交期可行性冲突检测 | should | P1 | AC-GUARD-002 |
| FR-GUARD-004 | 条款冲突检测（付款/质保/罚则） | should | P1 | AC-GUARD-002 |
| FR-GUARD-005 | 报价正文注入与私域泄露检测；护栏只产 Flag 不否决 | must | P0 | AC-GUARD-003 |
| FR-EVIDENCE-001 | 审计包导出（事件切片 + Merkle 根 + 清单） | must | P1 | AC-AUDIT-001 |
| FR-EVIDENCE-002 | 审计包独立验证（哈希链 + 签名） | must | P1 | AC-AUDIT-001 |
| FR-EVIDENCE-003 | 模型输入重建校验（P4 的可机检实现） | must | P1 | AC-AUDIT-002 |
| FR-EVIDENCE-004 | 留存期与销毁策略可配置，销毁动作留痕 | should | P2 | AC-AUDIT-003 |

## 4. 承包商侧

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RFQ-001 | 创建采购包：范围、接口、计量规则、交付物、除外责任 | must | P0 | AC-RFQ-001 |
| FR-RFQ-002 | 清单条目 CRUD 与校验（单位属计量规则表、必须有唯一接口责任方） | must | P0 | AC-RFQ-001 |
| FR-RFQ-003 | 发布产生不可变版本；修改必须升版并给字段级 delta | must | P0 | AC-RFQ-002 |
| FR-RFQ-004 | 分发记录：谁在何时收到哪个版本 | must | P1 | AC-RFQ-003 |
| FR-RFQ-005 | 截止时间管理与超时提醒（澄清截止、报价截止） | should | P1 | AC-RFQ-003 |
| FR-COMPARE-001 | 归一化报价 → TCO 折算（价格/交期/付款条件/质保/偏差） | must | P0 | AC-COMPARE-002 |
| FR-COMPARE-002 | 排序建议：权重来自策略 patch；同输入同输出 | must | P0 | AC-COMPARE-002 |
| FR-COMPARE-003 | 每个数值必须有引用链（账本条目 + 清单条目） | must | P0 | AC-COMPARE-003 |
| FR-COMPARE-004 | 生成可评审的比较表（含 Flag 与差异说明），可导出 | must | P1 | AC-COMPARE-004 |
| FR-AWARD-001 | 授标意向（Intent）可撤回，可复；不产生义务 | must | P1 | AC-AWARD-001 |
| FR-AWARD-002 | 供应商确认 + 承包商人工签署 → 承诺；缺一即抛错 | must | P0 | AC-AWARD-001 |
| FR-AWARD-003 | PO 只能由承诺派生，不得手工另建 | must | P1 | AC-AWARD-002 |
| FR-TERMS-001 | 条款库与默认条款应用 | should | P1 | AC-TERMS-001 |
| FR-TERMS-002 | 条款冲突标注并提请人工，不得静默取其一 | must | P1 | AC-TERMS-001 |
| FR-CHANGE-001 | 变更请求引用原报价条目与单价基准 | must | P1 | AC-CHANGE-001 |
| FR-CHANGE-002 | 变更定价与差额重算；人工批准后生效 | must | P1 | AC-CHANGE-002 |

## 5. 供应商侧

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-INTAKE-001 | 从包中抽取清单条目与规格引用，逐条给出 `item_id` | must | P0 | AC-INTAKE-001 |
| FR-INTAKE-002 | 缺项检测与疑问清单生成（人工确认后才外发） | must | P0 | AC-INTAKE-002 |
| FR-INTAKE-003 | 无引用的抽取结果标记为 `[假设]` 等待人工确认 | must | P0 | AC-INTAKE-002 |
| FR-COST-001 | 成本构成按条目与成本要素（材料/人工/机具/管理/风险/税/财务） | must | P0 | AC-COST-001 |
| FR-COST-002 | 成本模型为私域，永不出 realm | must | P0 | AC-TRUST-001 |
| FR-COST-003 | 成本构成可解释（因子可追溯） | should | P1 | AC-COST-001 |
| FR-PRICE-001 | 定价流水线产出 PriceProposal（Intent），越界即请求批准 | must | P0 | AC-PRICE-001 |
| FR-PRICE-002 | 最终报价数字必须人工确定 | must | P0 | AC-PRICE-001 |
| FR-CAP-001 | 交期可行性校验（产能日历 + 关键路径） | should | P1 | AC-CAP-001 |
| FR-CAP-002 | `firm` 交期在报价有效期内不可由模型变更 | must | P1 | AC-CAP-001 |
| FR-DEV-001 | 偏差捕捉（技术/商务/进度/范围）与影响量化 | must | P0 | AC-DEV-001 |
| FR-DEV-002 | 替代方案建议（Intent，人工采纳） | could | P2 | AC-DEV-001 |

## 6. 协作与治理

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-NEGO-001 | 有限轮次谈判：轮次上限与让步上限来自策略 patch | could | P2 | AC-NEGO-001 |
| FR-NEGO-002 | 任何价格让步必须人工批准 | must | P2 | AC-NEGO-001 |
| FR-EVAL-001 | 场景集（S1..S4）与断言执行 | must | P1 | AC-EVAL-001 |
| FR-EVAL-002 | 离线重放确定性（同输入同输出） | must | P1 | AC-EVAL-001 |
| FR-EVAL-003 | 指标采集与基线报告 | must | P0 | AC-EVAL-002 |
| FR-EVAL-004 | 反例集只增不减，新增需人批 | must | P1 | AC-EVAL-002 |
| FR-EVOLVE-001 | 提案结构（target/diff/rationale/expected_effect/risks/rollback_plan） | must | P2 | AC-EVOLVE-001 |
| FR-EVOLVE-002 | 影子重放与指标对比 | must | P2 | AC-EVOLVE-001 |
| FR-EVOLVE-003 | 评测门五条同时满足（含人工介入率不上升） | must | P2 | AC-EVOLVE-002 |
| FR-EVOLVE-004 | 自改范围限制：内核不可 patch；自改附提案 ID | must | P2 | AC-EVOLVE-003 |
| FR-EVOLVE-005 | canary 与自动回滚（卸载实现） | must | P2 | AC-EVOLVE-003 |
| FR-EVOLVE-006 | 提案失败三次转人工 | should | P2 | AC-EVOLVE-004 |
| FR-INTEG-001 | 文件投递绑定（原子写 + 命名约定） | must | P0 | AC-INTEG-001 |
| FR-INTEG-002 | HTTP relay 绑定（只转发与存证） | should | P1 | AC-INTEG-002 |
| FR-INTEG-004 | 宿主与内核经 stdio NDJSON 桥通信：能力清单由内核自述；版本不兼容即拒绝且账本零新增；`commit` 面永不暴露、调用留痕；身份不可自我声明；错误码固定且带可行动 `next_action` | must | P1 | AC-INTEG-004, AC-INTEG-005, AC-INTEG-006 |
| FR-INTEG-003 | 邮件绑定（P2）；失败不得落账为"已发送" | could | P2 | AC-INTEG-003 |
| FR-UX-001 | 人工门队列视图（动作、摘要、引用链、Flag） | must | P1 | AC-APPROVE-003 |
| FR-UX-002 | 供应商视图不得暴露承包商私域字段 | must | P1 | AC-TRUST-001 |
| FR-UX-003 | 比价表导出（CSV/Excel） | should | P1 | AC-COMPARE-004 |

## 7. 阶段分布（用于排期）

| 阶段 | must 数 | 核心内容 |
|---|---|---|
| P0 | 35 | 内核四件套 + 运行时/CLI 骨架 + 归一化 + 单进程端到端闭环 + 指标基线 |
| P1 | 24 | 双侧进程 + QEP 同步 + 澄清广播 + 护栏 + 审计重建 + 场景集 |
| P2 | 12 | 邮件/ERP 接入 + 谈判 + 自进化流水线 + 留存合规 |
