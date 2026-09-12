# quotagent

面向 **承包商 ↔ 供应商** 采购-报价闭环的 agentic 系统设计。架构范式取自
[Cordis](https://github.com/cordiverse/cordis)（时空可组合性元框架：revertible effects +
reactive coeffects，[arXiv:2608.25512](https://arxiv.org/abs/2608.25512)），
工程约定参考 DeepSeek Harness 的「全插件 agent harness」形态。

**当前状态：P0 mock 进行中（S0.1–S0.2 已完成：仓库内自包含运行时 + CLI 骨架 + 账本）。** 设计与需求在
`docs/`，实现按 `docs/work/roadmap.md` 的 P0 → P1 → P2 推进，由 agent 自实现并在线自进化。

## 它解决什么

| 视角 | 痛点 | quotagent 的应对 |
|---|---|---|
| 承包商 | 询价包口径不一、报价不可比、澄清版本错配、变更无审计链 | 规范化询价包 + 标准化比价 + 版本绑定的澄清账本 + 变更单闭环 |
| 供应商 | 读包靠人、成本构成难沉淀、澄清反复、报价策略无反馈 | 自动读包与工程量拆分 + 成本模型 + 澄清工单 + 报价策略记忆 |
| 双方对接口 | Excel/邮件互发、字段口径漂移、双方同时改同字段、数据主权顾虑 | QEP 交换协议 + 双向账本三方协调 + 隔离 realm + 承诺审批门 |

## 阅读顺序

```
docs/analysis/cordis-architecture.md       Cordis 架构的代码级分析（事实层，含文件/行号）
docs/analysis/cordis-design-strengths.md   可发扬的设计优势 + 到本领域的映射表
docs/analysis/harness-agent-repo-conventions.md  面向 agent 的仓库工程约定来源
docs/analysis/domain-painpoints.md         领域痛点结构化分析（含 [假设] 清单）
docs/design/00-overview.md                 系统总览与设计原则
docs/design/01-architecture.md             架构主体：Cordis 范式如何落到 quotagent
docs/work/roadmap.md                       mock → mvp demo → product 路线图
docs/work/handover.md                      接手文档（每轮次更新，≤ 1024 B）
```

## 给 agent 的最小操作序列

```bash
cat docs/work/handover.md          # 1. 我在哪、下一步唯一动作
cat .agents/state.json             # 2. 机器可读状态
tools/bootstrap.sh                 # 3. 首次：建仓库内 .venv（幂等；仅标准库，不装任何包）
tools/verify.sh smoke              # 4. 运行时自检（解释器 / 标准库依赖 / 临时目录）
tools/verify.sh ac AC-AUDIT-001    # 5. 跑一条 AC（AC 实现在 src/quotagent/qa/）
# 6. 在 progress-checklist 里挑一个 status=todo 的任务，按其 FR/AC 实现
# 7. 取证：tools/run.sh -m quotagent.qa ac <AC-ID> --evidence EV-NNN
# 8. 更新 progress-checklist + handover + state.json，commit & push 并回读远端
```

规则见 [AGENTS.md](AGENTS.md)——本仓库规则的唯一真源。
