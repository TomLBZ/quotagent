# 进度清单

<!-- budget: 32 KB. status ∈ todo|doing|blocked|done；done 必须有 evidence（AGENTS.md 规则 6） -->

**当前阶段：P0 mock（S0.1–S0.2 已完成）**。设计期任务全部 `done`；P0 其余任务按 `roadmap.md` §2 顺序推进。
任务定义（描述与顺序）在 `roadmap.md`；本文件只维护**状态与证据**。

## 设计期

| T | 阶段 | 内容 | FR | AC | status | evidence |
|---|---|---|---|---|---|---|
| T-001 | 设计期 | 分析层文档（cordis 架构 / 设计优势 / agent 仓库约定 / 领域痛点） | – | – | done | EV-002 |
| T-002 | 设计期 | 设计层文档（00..12 + ADR-0001..0006） | – | – | done | EV-001 |
| T-003 | 设计期 | 需求与路线图（FR / AC / roadmap / 本清单 / handover） | – | – | done | EV-001 |
| T-004 | 设计期 | 文档门工具与运行、推送并回读远端 refs | – | AC-DESIGN-001/002/003 | done | EV-001, EV-003 |

## P0 mock（见 `roadmap.md` §2）

| T | 阶段 | 内容 | FR | AC | status | evidence |
|---|---|---|---|---|---|---|
| T-101 | P0 | 仓库内自包含运行时 + CLI 骨架 | FR-RUNTIME-001, FR-RUNTIME-002 | AC-RUNTIME-001, AC-RUNTIME-002 | done | EV-007, EV-008 |
| T-102 | P0 | 账本：追加、哈希链、投影重建、去重 | FR-LEDGER-001..004 | AC-AUDIT-001, AC-AUDIT-002 | done | EV-005, EV-006 |
| T-103 | P0 | 事件五模式 + effect/disposer 语义 | FR-EVT-001..003 | AC-EVT-001, AC-EVT-002 | todo | – |
| T-104 | P0 | 插件装载与依赖协调 | FR-PLUGIN-001..003 | AC-PLUGIN-001, AC-PLUGIN-002 | todo | – |
| T-105 | P0 | QEP 信封 + 文件投递 + 幂等 | FR-QEP-001, FR-QEP-002, FR-QEP-004, FR-INTEG-001 | AC-QEP-001, AC-QEP-002, AC-INTEG-001 | todo | – |
| T-106 | P0 | 归一化与拒绝语义 | FR-NORM-001..004 | AC-NORM-001..003 | todo | – |
| T-107 | P0 | 询价包与清单版本化 | FR-RFQ-001..003 | AC-RFQ-001, AC-RFQ-002 | todo | – |
| T-108 | P0 | 读包抽取、缺项、疑问草案 | FR-INTAKE-001..003 | AC-INTAKE-001, AC-INTAKE-002 | todo | – |
| T-109 | P0 | 成本构成（私域） | FR-COST-001, FR-COST-002 | AC-COST-001, AC-TRUST-001 | todo | – |
| T-110 | P0 | 定价建议 + 人工门 | FR-PRICE-001, FR-PRICE-002, FR-APPROVE-001, FR-APPROVE-002 | AC-PRICE-001, AC-APPROVE-001, AC-APPROVE-002 | todo | – |
| T-111 | P0 | 偏差与影响量化 | FR-DEV-001 | AC-DEV-001 | todo | – |
| T-112 | P0 | 比价：TCO + 排序 + 引用链 | FR-COMPARE-001..003 | AC-COMPARE-001..003 | todo | – |
| T-113 | P0 | 护栏：漏项 + 注入/私域检测 | FR-GUARD-002, FR-GUARD-005 | AC-GUARD-001, AC-GUARD-003 | todo | – |
| T-114 | P0 | 端到端脚本（S1 合成场景） | FR-EVAL-001 | AC-EVAL-001 | todo | – |
| T-115 | P0 | 指标基线采集与报告 | FR-EVAL-003 | AC-EVAL-002 | todo | – |
| T-116 | P0 | 文档门工具（`tools/verify.sh docs`） | – | AC-DESIGN-001..003 | done | EV-004 |
| T-117 | P0 | 现场验证 V-001..V-012 | – | manual（结论写入 functional-requirements §1） | todo | – |

## P1 mvp demo（见 `roadmap.md` §3）

| T | 阶段 | 内容 | FR | AC | status | evidence |
|---|---|---|---|---|---|---|
| T-201 | P1 | 双侧进程分离 + profiles | FR-PLUGIN-004 | AC-PLUGIN-003 | todo | – |
| T-202 | P1 | QEP relay/文件绑定 + receipt + 重发 + seq 空洞 | FR-QEP-003, FR-QEP-008, FR-INTEG-002 | AC-QEP-003, AC-INTEG-002 | todo | – |
| T-203 | P1 | 三方协调 + 字段权威方 + 冲突上报 | FR-QEP-007 | AC-SYNC-001 | todo | – |
| T-204 | P1 | 澄清工单 + 广播完整性 + 版本重开 | FR-CLARIFY-001..003 | AC-CLARIFY-001..003 | todo | – |
| T-205 | P1 | 包版本变更与报价过期标记 | FR-NORM-004, FR-RFQ-003 | AC-COMPARE-001, AC-RFQ-002 | todo | – |
| T-206 | P1 | 护栏扩展：异常低价 | FR-GUARD-001 | AC-GUARD-001 | todo | – |
| T-207 | P1 | 产能日历与交期校验 | FR-CAP-001, FR-CAP-002, FR-GUARD-003 | AC-CAP-001, AC-GUARD-002 | todo | – |
| T-208 | P1 | 审计包导出/验证 + 模型输入重建 | FR-EVIDENCE-001..003 | AC-AUDIT-001, AC-AUDIT-002 | todo | – |
| T-209 | P1 | 场景集 S1..S4 + 反例集 | FR-EVAL-001, FR-EVAL-002, FR-EVAL-004 | AC-EVAL-001, AC-EVAL-002 | todo | – |
| T-210 | P1 | 人工门队列视图 + 超时策略 | FR-APPROVE-003, FR-UX-001 | AC-APPROVE-003 | todo | – |
| T-211 | P1 | 条款库与冲突标注 | FR-TERMS-001, FR-TERMS-002 | AC-TERMS-001 | todo | – |
| T-212 | P1 | 变更闭环 | FR-CHANGE-001, FR-CHANGE-002 | AC-CHANGE-001, AC-CHANGE-002 | todo | – |
| T-213 | P1 | 授标与 PO 闭环 | FR-AWARD-001..003 | AC-AWARD-001, AC-AWARD-002 | todo | – |
| T-214 | P1 | 比较表导出 | FR-COMPARE-004, FR-UX-003 | AC-COMPARE-004 | todo | – |
| T-215 | P1 | 部署与操作手册 | FR-RFQ-004, FR-RFQ-005 | AC-RFQ-003 | todo | – |

## P2 product（见 `roadmap.md` §4）

| T | 阶段 | 内容 | FR | AC | status | evidence |
|---|---|---|---|---|---|---|
| T-301 | P2 | 邮件绑定 | FR-INTEG-003 | AC-INTEG-003 | todo | – |
| T-302 | P2 | ERP 最小字段同步 | FR-INTEG-002 | AC-INTEG-002 | todo | – |
| T-303 | P2 | Web 视图（双侧） | FR-UX-001, FR-UX-002 | AC-APPROVE-003, AC-TRUST-001 | todo | – |
| T-304 | P2 | 多租户 + 密钥轮换 | FR-EVIDENCE-004 | AC-AUDIT-003 | todo | – |
| T-305 | P2 | 自进化流水线 | FR-EVOLVE-001..006 | AC-EVOLVE-001..004 | todo | – |
| T-306 | P2 | 留存与销毁策略 | FR-EVIDENCE-004 | AC-AUDIT-003 | todo | – |
| T-307 | P2 | 性能与规模加固 | NFR-PERF-001..004 | manual（基线对比） | todo | – |
| T-308 | P2 | 运维手册与 SLA、告警落地 | NFR-UX-001..004 | manual | todo | – |
| T-309 | P2 | 谈判辅助 | FR-NEGO-001, FR-NEGO-002 | AC-NEGO-001 | todo | – |

## 缺陷与阻塞

| 编号 | 类型 | 内容 | 影响 | 状态 |
|---|---|---|---|---|
| D-001 | 已知缺陷 | 实现自 P0 起：AC-AUDIT-001/002、AC-RUNTIME-001/002 已执行；其余 P0 AC 尚无实现 | 门 G0 未开始 | open（P0 进行中） |
| D-002 | 未验证 | V-001..V-012 全部待现场验证 | 影响 P1 目标值设定 | open |
