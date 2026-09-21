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
| FR-PLUGIN-004 | 配置更新先过可否决的更新事件，否决即不生效 | must | P1 | AC-PLUGIN-003、AC-PLUGIN-004 |
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
| FR-CLARIFY-004 | FAQ 沉淀与复用（本 realm 内） | could | P2 | AC-CLARIFY-004、AC-FAQ-001 、AC-PIPELINE-001 |
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
| FR-EVIDENCE-004 | 留存期与销毁策略可配置，销毁动作留痕 | should | P2 | AC-AUDIT-003、AC-AUDIT-005 |
| FR-EVIDENCE-005 | 审计包必须**签名**（导出方身份可验）并提供**包含证明**；验证方在**不接触原账本**的前提下可独立验证（缺字段/缺密钥不得静默通过） | must | P1 | AC-AUDIT-004 |

## 4. 承包商侧

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RFQ-001 | 创建采购包：范围、接口、计量规则、交付物、除外责任 | must | P0 | AC-RFQ-001 |
| FR-RFQ-002 | 清单条目 CRUD 与校验（单位属计量规则表、必须有唯一接口责任方） | must | P0 | AC-RFQ-001 |
| FR-RFQ-003 | 发布产生不可变版本；修改必须升版并给字段级 delta | must | P0 | AC-RFQ-002 |
| FR-RFQ-004 | 分发记录：谁在何时收到哪个版本 | must | P1 | AC-RFQ-003 |
| FR-RFQ-005 | 截止时间管理与超时提醒（澄清截止、报价截止） | should | P1 | AC-RFQ-003 |
| FR-RFQ-006 | 包升版后，基于旧版本的报价必须被标记为**过期**（含旧/新版本号）且不得进入排序，并产生重报请求（提示对方基于新版本重报） | must | P1 | AC-RFQ-004 |
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
| FR-NEGO-001 | 有限轮次谈判：轮次上限与让步上限来自策略 patch | could | P2 | AC-NEGO-001 、AC-NEGO-003 、AC-PIPELINE-001 |
| FR-NEGO-002 | 任何价格让步必须人工批准 | must | P2 | AC-NEGO-001 、AC-NEGO-003 |
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
| FR-INTEG-003 | 邮件绑定（P2）；失败不得落账为"已发送" | could | P2 | AC-INTEG-003 | AC-MAIL-001 、AC-PIPELINE-001 |
| FR-UX-001 | 人工门队列视图（动作、摘要、引用链、Flag） | must | P1 | AC-APPROVE-003 |
| FR-UX-002 | 供应商视图不得暴露承包商私域字段 | must | P1 | AC-TRUST-001 |
| FR-UX-003 | 比价表导出（CSV/Excel） | should | P1 | AC-COMPARE-004 |
| FR-RUNTIME-003 | 提供宿主运行期决策留痕：按事件前缀订阅、有界环形流水、去重键与账本同形；**不写账本、不写文件** | must | P2 | AC-RUNTIME-003 |
| FR-RUNTIME-004 | 提供运行期窗口成本预算准入：整数微元记账、窗口滚动、超预算拒绝**可解释**（区分"等窗口有用"与"等也没用"） | must | P2 | AC-RUNTIME-004 |
| FR-RUNTIME-005 | 提供运行期熔断：连续失败达阈值即快速失败，冷却后半开有界试探，拒绝带状态与重试时间 | must | P2 | AC-RUNTIME-005 |
| FR-RUNTIME-006 | 提供运行期准入与等待：可解释的限流/背压拒绝、显式超时（超时是错误不是静默重试）、有界重试、判定不依赖墙钟 | must | P2 | AC-RUNTIME-006 |
| FR-RUNTIME-007 | 提供运行期观测的**只读聚合**（准入/留痕/分流三源合一）：只给聚合数字与阶段，不出条目正文、不写账本 | must | P2 | AC-RUNTIME-007 |
| FR-RUNTIME-008 | 提供按 realm 的**有界**事件时间线（幂等去重、卸载即注销、零残留），供 UI 与排障读取 | must | P2 | AC-RUNTIME-008 |
| FR-RUNTIME-009 | 提供运行期请求**幂等判重**：同请求不重复打下游；失败结果是 replay 而非复用成成功 | must | P2 | AC-RUNTIME-009 |
| FR-EVIDENCE-006 | 提供账本证据面的只读统计（按类型计数、关联数、带引用行数、时间跨度），只输出计数不输出正文 | must | P2 | AC-EVIDENCE-003 |
| FR-EVOLVE-007 | 提供自进化流水的只读归纳（提案/影子/门两态/晋升/回滚/canary 进出 + 最近事件），只出计数不出正文 | must | P2 | AC-EVOLVE-005 |
| FR-PRICE-003 | 提供按供应商的历史价格描述统计（次数、最低/中位/最高、最新、离散趋势），只读且**不参与决策** | must | P2 | AC-PRICE-002 |
| FR-RFQ-007 | 提供按采购包的应标覆盖率与缺口清单（未应标名单、低于下限的包、临期/逾期包），只读且**不猜名单** | must | P2 | AC-RFQ-005 |
| FR-EVAL-005 | 提供按供应商的绩效记分卡（次数、价格分布、交期均值、偏差标记），只读且**不产出评分或排名** | must | P2 | AC-EVAL-003 |
| FR-UX-004 | 提供运维视角的只读快照（中间件状态 + 熔断 + 证据面聚合 + 人可读摘要），**不属于任何一方**、不出正文与私域键 | must | P2 | AC-RUNTIME-010 |
| FR-UX-005 | 提供运维快照的定期落盘（谈判/FAQ/邮件三域计数与最近事件），供宿主**只读**展示；快照不得含正文与私域键，且不含 `generated_at` 之外的时间键 | must | P2 | AC-UI-002 、AC-UI-003 |
| FR-ADMIN-001 | 新增第四道 UI 道 `/quotagent/admin/`（系统管理）：未提权时不得输出任何面板内容，只给与失败同形的统一拒绝体 | should | P2 | AC-ADMIN-001 |
| FR-ADMIN-002 | 任一道 UI 都提供管理员 token 提权入口；token 只经当次表单请求体提交，不回显、不写前端存储、不进 HTML/JS、不入账本、不出现在 URL 与日志 | should | P2 | AC-ADMIN-002 |
| FR-ADMIN-003 | 提权后可切换到任意一道 UI（含回切）；切换只改导航与道可见性，不改变任何字段白名单——管理员身份不得成为看到私域键的新路径 | should | P2 | AC-ADMIN-003 |
| FR-ADMIN-004 | 系统管理面板可见 agent 进度与阻塞（含插件需求与缺凭据两类），清单由 Python 判定器从真来源生成，计数只读并标注口径 | should | P2 | AC-ADMIN-004 |
| FR-ADMIN-006 | 阻塞状态机只允许 `blocked→pending→resolved/rejected/expired`，转移只能由 Python 侧写账本产生；宿主只读；非法转移一律拒绝且不留部分效果 | must | P2 | AC-ADMIN-006 |
| FR-ADMIN-007 | 提权粒度两档：会话级决定道可见性与切换，请求级决定一切写类提交（缺 token 即拒）；两档都无超时自动批准/自动解除，过期只减权不增权 | must | P2 | AC-ADMIN-007 |
| FR-ADMIN-008 | 提权失败一律统一响应（缺 token/错 token/过期会话/未启用/冷却五类同形），不含 token 及其可逆派生；连续失败达阈值进入有界冷却，冷却期不产生任何成功 | must | P2 | AC-ADMIN-008 |
| FR-ADMIN-009 | 反例：无 token 不得提权；非 admin token 一律被拒且不泄露（无 oracle）；被拒不产生会话，也不在宿主留下任何提交文件 | must | P2 | AC-ADMIN-009 |
| FR-ADMIN-010 | token 校验只在服务端：来源限于环境变量或 0600 文件，先 sha256 归一再用恒定时间比较；token 不得出现在 HTML/JS 响应、快照文件、账本行与宿主日志四处 | must | P2 | AC-ADMIN-010 |
| FR-ADMIN-005 | 阻塞可在 UI 内解除：提交落为宿主侧「待处理项」（0600），由 Python 侧消费并落账完成；**提交瞬间宿主侧账本零新增**，宿主永不写账本 | should | P2 | AC-ADMIN-005 |
| FR-MARKET-001 | 插件列表本身由插件提供：只读聚合三真源（目录/清单/用户空间），逐项给 source 与 wired；未装配显式 unwired 不得隐藏；空列表报 degraded | must | P2 | AC-MARKET-001、AC-MARKET-006 |
| FR-MARKET-002 | 市场目录与已装载项必须分开；未过门/未晋升产物不得进"可安装项"；每条可安装带 install_ref，无引用一律拒 | must | P2 | AC-MARKET-002 |
| FR-MARKET-003 | 三源不一致即报 inconsistent + 逐项差异，不得取其一静默 | must | P2 | AC-MARKET-003 |
| FR-MARKET-004 | 市场只读零副作用：不装载/不下载/不写文件/不起子进程/不写账本；"安装/提权"只产指向既有门的引用 | must | P2 | AC-MARKET-004 |
| FR-MARKET-005 | 有界且确定性：条数上界、稳定排序、不含正文与私域键；超界截断并报被丢条数 | should | P2 | AC-MARKET-005 |
| FR-MARKET-006 | 不可用不得伪装：degraded + reason + next_action，不得返回"看起来健康的零插件清单" | must | P2 | AC-MARKET-006 |
| FR-USERPLUG-002 | 写面只有 `user-space/<ns>/<plugin>/`：写 `host/modules/`、`src/`、`tools/`、别人 ns、仓库外一律拒且目标不存在 | must | P2 | AC-USERPLUG-002、AC-USERPLUG-012 |
| FR-USERPLUG-003 | 自动重载：产物/清单变化只重载该插件（pid 不变、新 uid），不迁移旧内存状态 | must | P2 | AC-USERPLUG-003 |
| FR-USERPLUG-004 | 自动卸载零残留：effects 归零、不影响其它用户空间与平台插件 | must | P2 | AC-USERPLUG-004 |
| FR-USERPLUG-006 | 隔离四件套：独立 instance / 独立服务命名空间（含保留名禁用）/ 独立文件根（挂载期绑定）/ 独立凭据作用域 | must | P2 | AC-USERPLUG-006 |
| FR-USERPLUG-007 | 四类反例必须结构性拒绝并留痕（写别人目录 / 跨 instance 共享状态 / 未提权被他人加载 / 无凭据自称已连接） | must | P2 | AC-USERPLUG-007 |
| FR-USERPLUG-008 | 管理本身也是插件（list/load/unload/reload/请求/提权请求）；卸载管理面后已装载插件照常运行，新装载被拒且不伪装成功 | must | P2 | AC-USERPLUG-008 |
| FR-USERPLUG-009 | 不耦合进平台：不得改内核/服务层与已晋升产物，只能经已登记服务面 inject；未登记服务名即拒 | must | P2 | AC-USERPLUG-009 |
| FR-USERPLUG-011 | 未提权不可被他人加载（跨 ns → `user-plugin-not-elevated` 且未载入） | must | P2 | AC-USERPLUG-011 |
| FR-USERPLUG-012 | 两个方向都封死：自进化 target→`user-space/` 拒；用户空间 target→`host/modules/` 拒 | must | P2 | AC-USERPLUG-012 |
| FR-USERPLUG-001 | 自然语言需求 → 产出用户空间插件 → **完成即自动进列表**（无人工搬运）；真源 `user-space/<ns>/<plugin>/plugin.json`；落 `userplugin/created`（含 `source_prompt_digest` 与产物哈希），同哈希幂等 | must | P2 | AC-USERPLUG-001 |
| FR-USERPLUG-005 | P2 | 用户空间插件的**迭代与回滚**：版本号递增才允许产物变更（同版本不能对应两个产物）；回滚只能回到历史里真实存在过的版本，且**只有磁盘内容已还原成该版本**时才登记 —— 账本不记不真的事 | AC-USERPLUG-005 |
| FR-USERPLUG-010 | P2 | 用户空间插件**提权**为系统级插件：管理面只产待办载荷（零写面）；真正写树由 `tools/userplugin-elevate.py` 执行 —— 必须**人类 actor** + `ap-NNNN` 人工门引用 + **影子哈希与现算产物哈希一致**（陈旧载荷/被改产物一律拒绝）；目标只能是 `<name>.mjs`，**已存在即拒绝（不覆盖）**，越界写面不可达 | AC-USERPLUG-010 |
| FR-AGENTRT-006 | P2 | **有界 + 显式降级**（运行期插件）：上下文切片条数/记忆条目数/单条字节数上界必须声明；超界**截断并报被丢条数**（不得静默丢）；无法组装时 `degraded:true` + `reason` + `next_action`；**空上下文不得报 `ok:true`**（"确实没内容"与"没组装出来"必须可区分） | AC-AGENTRT-006 |
| FR-AGENTRT-007 | P2 | **各自独立装卸、卸载零残留**：三件运行期插件可分别装载/卸载/重载；卸载后无订阅/定时器/句柄残留（各件都有 `*-disposed` 留痕）；**卸载记忆插件不丢事实** —— 项目记忆的来源是账本（Python 侧重放），与插件是否在跑无关 | AC-AGENTRT-007 |
| FR-AGENTRT-002 | P2 | **记忆四层边界**（运行期插件）：①会话记忆只在进程内、**永不落盘**；②项目记忆是**账本的可重建投影**（丢缓存不丢事实：删掉快照重建后逐字节一致），重放**只读**账本；③策略记忆**只人类可写**；④跨方共识**只走协议**（不得由本插件合并） | AC-AGENTRT-002 |
| FR-STORAGE-001 | P2 | **文件管理由插件提供**（Python 侧 `tools/storage.py` 唯一写入者；宿主侧只读观察面 `storage-view`）：按 ns 分区根、append-only 日志、`stat` 返回与磁盘一致的 `sha256`；`..`/绝对路径/符号链逃逸一律拒且**根外目标不存在**；读取必须有界并诚实报破 | AC-STORAGE-001 |
| FR-STORAGE-004 | P2 | 存储**跨租户隔离**：`ns` 逃逸与 `rel` 跨根一律拒（`storage-outside-ns`），且越权尝试后**哨兵在磁盘上不存在**；存储写不产生账本行、账本字节零改动（不得成为第二条事实写路径） | AC-STORAGE-004 |
| FR-STORAGE-006 | P2 | 存储提供**只读观察面**（容量/计数/失败次数）供自进化 `observe` 使用：有界、确定性、不出正文与私域键；**读它不改任何状态** | AC-STORAGE-006 |
| FR-UXWEB-001 | P2 | **GUI 必须能做事，不是一篇纯文字**：承包商/供应商第一屏固定三块（待批事项 / 进行中 / 健康），其余下沉可展开区；每块里的动作是**可点的表单或链接**；页面**保持 0 行 `<script>` / 0 内联事件**（交互只用 `<form method=get>`，可机检） | AC-UXWEB-001 |
| FR-UXWEB-002 | P2 | **子视图与真交互**：双方各自的事件流 / 报价 / 待批 / 证据（供应商侧为澄清）子视图，带 `limit/page/sort/q` 筛选排序翻页；参数越界**夹取并回显 applied**；分页不重叠不丢行；空结果**显式说明**（不许看起来像故障）；每页有道内子导航与「上手（token／配置放哪里）」入口 | AC-UXWEB-001 |
| FR-CONFIG-001 | P2 | **插件/项目配置可 UI 更改并持久化**：宿主侧只读总览（每键 `source`(`default|file|env|runtime`) / `shadowed_by` / `editable`）+ **干跑预览**（零落盘零生效）；保存只落 **0600 待处理项**（宿主零写面），由 `tools/config-apply.py` **原子写** `/workspace/config.yaml`（临时文件 + rename，失败回滚）并落账本 `config/changed|refused`；支持 `--init` 从模板生成配置文件（即"支持配置文件初始化"） | AC-CONFIG-001 |
| FR-CONFIG-002 | P2 | **凭据可 UI 提交且只写不回显**：状态视图只给 `configured` / `source` / `required_mode` / `fingerprint_first8` / `next_action`；提交与轮换**绝不回显值**；未提权对配置与凭据的 11 条路径一律 **401 同形**（无 oracle、不泄漏键名）；YAML 只实现**声明清楚的子集**，锚点/别名/多文档等一律拒并给 reason（不静默糊掉） | AC-CONFIG-001 |
| FR-MAIL-001 | P2 | **邮件收发由插件提供**（`services/mail_transport.py`，标准库 `smtplib`/`imaplib`）：SMTP 参数与 IMAP 参数从配置读（**环境变量优先于** `/workspace/config.yaml`）；**未配置必须如实报未连接**（`available:false` + reason + next_action，且给出与"连不上"**可区分**的 reason），配置了就真能收发；凭据不进日志/账本正文/异常消息 | AC-MAIL-001 |
| FR-MAIL-002 | P2 | 邮件相关配置键**进白名单**（⇒ 既有配置 UI 可直接改并持久化到 YAML，不新增第二条写路径）；宿主侧只读视图 `host/modules/mail-view.mjs`（队列计数 / 最近结果与 reason / `available` / `next_action`，零写面）+ `GET /quotagent/ops/mail/`（0 行 `<script>`）与 `GET /quotagent/api/mail` | AC-MAIL-002 |
| FR-VIZ-001 | P2 | **比价 heuristics 可视化（domain 插件）**：把候选按**可调权重**（价格/交期/付款/质保/偏差）排序，并给出**每项的贡献分解**与确定性的"如何提升排名"提示；权重越界**夹取并回显**（归一后和为一）；有界并诚实报 `omitted`；**私域零泄漏**（供应商侧不得因排名暗示标底：带私域键的行整行跳过并报数，带哨兵与不带哨兵的输出**逐字节一致**）；页面 SSE 交互（`<form method=get>`，无内联脚本） | AC-VIZ-001 |
| FR-ADV-001 | P2 | **AI agent 决策建议层（domain 插件 `advice-panel`）**：吃调用方给的**白名单结构化载荷**（本视角的截止 / 待批人工门 / `bid-heuristics` 同口径的比价行 / 通道声明；**不读账本、不联网、不调模型**），按**五条确定性规则**（① 截止临近或已过期 ② 比价得分极差过大 ③ 等待人工门 ④ 凭据缺口导致的阻塞 ⑤ 供应商侧如何提升排名）派生"下一步"：每条给 `severity`(high\|medium\|low) / `why` / **非空 `basis`**（指向载荷真键，如 `deadlines[pkg-1].due_at`）/ `next_action`（**可直接复制的命令或路由**：人工门给 `python3 -m quotagent.g1side ...`、比价给 `/<view>/heuristics/?w_<分量>=1`、凭据缺口**逐字节照抄**通道声明里的 `next_action`，**不假装能发**）/ `blocked_by`。**诚实分层**：输出恒带 `engine="rules"` 与文案"本页建议由确定性规则从投影/快照派生，不含模型推测"；**无可分数据不编建议**（空投影 → `degraded:true` + 有名 `reason` + `items:[]`；"载荷不能用"与"数据齐但无可建议项"是两个 reason）；有界（`max_items` + 如实报 `omitted`/`truncated`）、确定性（同输入两次逐字节一致，且与入参键序/条目顺序无关）、**私域零泄漏**（条目上多出来的键读都不读：带哨兵与不带哨兵输出逐字节一致）；路由 `GET /quotagent/<view>/advice/`（SSR，**0 行 `<script>`**）与 `GET /quotagent/<view>/api/advice`，并挂进四道页面子导航 | AC-ADV-001 |
| FR-UIFB-001 | P2 | **WebUI 自适应闭环（反馈 → 新版本 → 自动重载 → 提示"请刷新"）**：每页渲染 `data-ui-revision="rN"`（版本号**只来自落盘的 `versions.json`**，宿主从不凭空递增）；`/<view>/feedback` 是 SSR 页（`<textarea>` + POST），提交**只落一条 0600 待办件**（含用户**原话正文** + sha256 + 视图名，宿主**账本零新增**）并回 202 + id + `next_action`；`tools/ui-feedback-apply.py` 是**唯一落账本者**（重算产物哈希 → 原子写版本状态 → 落 `ui/feedback-applied`，body **不含反馈正文**；幂等、拒绝路径给具体 code）；版本落后时页面顶部出现 `data-ui-stale="true"` 横幅（"已更新到 rM，请刷新页面" + `<form method=get>` 的"我已刷新"，`?seen=rM` 即消），版本相同**不得**出现横幅；运维观察面只读、有界、确定性（`degraded` 有名 reason） | AC-UIFB-001 |
| FR-GATE-001 | P2 | **「审批等多久 / 变更单到底是谁卡着」**（domain 插件 `gate-timeline`，正面回答两条 human problem：「审批人等不到」与「变更单扯皮」）：吃调用方给的**白名单事实载荷**（本视角的 `approval/*` / `change/*` 行 + `as_of`），派生 ① **还在等的人工门** `{id,kind,subject,owner,age_seconds,age_basis,consequence,next_action,blocked_by}`（挂了多久 / **口径** / 卡在谁手里（队列里的真审批人，没有就如实说 `unassigned`）/ 再等下去会发生什么（`remind|escalate|abort` 各自说清，**没有"超时自动批准"这一项**）/ 下一步）与 ② **变更单时间线** `{id,state,owed_by,waiting_since,basis,next_action}`（状态 / **谁欠谁一个动作** / 从哪条事件起在等 / 以账本事件与计数引用为凭）。**`age_seconds` 的口径 = `as_of − approval/requested 事实 ts`（绝不取墙钟）**：两个墙钟入口（`payload.now` / `config.now`）**读都不读**，所以同一份快照在任何"当前时间"下输出逐字节一致。**本插件永远不能批准**：服务面里没有 `approve/decide/grant/submit` 这类方法（`meta.can_approve=false`），`nudge()` 只产催办载荷（`requested_action="nudge"`）→ 路由 `GET /quotagent/<view>/gates/`（SSR，**0 行 `<script>`**）、`GET /quotagent/<view>/api/gates`、`POST /quotagent/<view>/gates/nudge`（宿主**只落一条 0600 待办件**：用户原话 + 目标门 id + sha256，**账本零新增**；202 + `next_action`），并挂进四道页面子导航；`tools/gate-nudge.py` 是**唯一落账本者**（校验目标门在本视图投影里且**尚未被决定** → 落 `gate/nudged`，body 恰 5 键、**不含理由正文**；待办件移入 `applied/`；幂等 `duplicates`；四种拒绝码各给 code + next_action）；**空投影 → `degraded:true` + 有名 reason + 两个列表都为 0**（不编）；有界、确定性、私域零泄漏 | AC-GATE-001 |
| FR-GATE-002 | P2 | **变更单逐行明细**（`gate-timeline` 规则 ⑤）：`/<view>/changes/<id>/` 与 `/<view>/api/changes/<id>` 逐行给原量×原价→新量×新价→差额（整数分）、行小计与总计差额、每行 `basis`；缺依据的行**不计入小计**（列 `basis_missing`）；无可用行 ⇒ degraded+reason+明细空；未知 id ⇒ 404+`next_action`；私域列仅业主侧可见 | AC-GATE-002 |
## 7. 阶段分布（用于排期）

| 阶段 | must 数 | 核心内容 |
|---|---|---|
| P0 | 35 | 内核四件套 + 运行时/CLI 骨架 + 归一化 + 单进程端到端闭环 + 指标基线 |
| P1 | 24 | 双侧进程 + QEP 同步 + 澄清广播 + 护栏 + 审计重建 + 场景集 |
| P2 | 12 | 邮件/ERP 接入 + 谈判 + 自进化流水线 + 留存合规 |
