# 决策日志（P1 起）

<!-- budget: 32 KB。一行一决策；重大架构决策另有 ADR；评审原文在 docs/work/reviews/（.txt） -->

规则：

1. 每行必须有**依据**（数据、评审、指令或 ADR 编号）与**决策者**（`human:` / `agent:<角色>`）。
2. 用户 2026-09-12 指令：人工批准原则上默认通过；**独立 agent 的评审结论可代替人类决策**，
   但必须留下本日志 + 评审原文（`docs/work/reviews/`）+ （架构级）ADR。
3. 不可被自动化移除的人的门（`07` §6）仍然成立：**V 项结论、G0/G1 签署、承诺类动作的批准**只能由人签，
   agent 不得代填；被"假设通过"的项必须显式标 `not_a_conclusion`。

| 编号 | 日期 | 决策 | 依据 | 决策者 | 影响 |
|---|---|---|---|---|---|
| D-001 | 2026-09-12 | 宿主层**直接依赖 cordis 4.0.0-rc.10**（npm `latest`），取代 ADR-0001"不引入其代码"条款 | 用户指令（不重复造轮子）+ 实测安装与语义探针 EV-038 | `human:用户指令` + `agent:B7` | ADR-0012；`host/`、`tools/cordis.sh`、`tools/verify.sh cordis` |
| D-002 | 2026-09-12 | 边界：**cordis 管组合，Python 管事实**（账本唯一写者）；宿主不得直接写账本 | ADR-0012 + 评审 A（R1/R3 风险） | `agent:review-cordis`（B7 复核接受） | ADR-0012/0013；桥接与 profiles 的实现约束 |
| D-003 | 2026-09-12 | 桥接 = **stdio NDJSON JSON-RPC v1**（`tools/run.sh -m quotagent.bridge --serve`），带 `kernel/hello` 版本握手与信用窗口背压 | 评审 A §3（传输/帧/握手/错误码/背压） | `agent:review-cordis`（B7 复核接受） | ADR-0013；批次 B3/B4 的实现与 AC |
| D-004 | 2026-09-12 | 宿主**默认只发意图/命令**（`intents_only`）；`commit` 面永不暴露；`fact` 面 P1 默认关 | 评审 A × 评审 C 的差异（A 允许受限 fact、C 主张 intents_only）；取更保守者 | `agent:review-cordis` + `agent:review-evolution`（B7 裁决） | ADR-0013；安全边界（INV-005 在桥路径下成立） |
| D-005 | 2026-09-12 | P1 推进前提：**假设 V-001..V-012 全部通过**（用户指令）；`register.json` 保持 `open` 并新增 `planning_assumptions`（标 `not_a_conclusion`） | 用户指令 | `human:用户指令` + `agent:B7` | ADR-0014；T-117 仍待人工签字，G0 仍待人工签署 |
| D-006 | 2026-09-12 | MVP 判据与削减顺序取评审 B 的 **MVP 线 + C1..C8**；"绝不许假"清单（8 项）同期生效 | 评审 B §1/§6 | `agent:review-p1-plan`（B7 复核接受） | ADR-0014；批次验收与演示脚本 |
| D-007 | 2026-09-12 | P1 执行顺序取评审 B 的 **16 批依赖序**（B1 文档缺口 → B2 进程分离 → B3 桥 → B4 协议 → … → B16 手册与 g1） | 评审 B §2/§3 | `agent:review-p1-plan`（B7 复核接受） | `progress-checklist` 推进顺序；写冲突面单批持有 |
| D-008 | 2026-09-12 | 每模块独立演进的边界与 10 条宿主强制不变量（H1..H10）采信评审 C；P1 只交付"可演进骨架"（清单 8 条），canary/自动晋升留 P2 | 评审 C §1/§2/§5 | `agent:review-evolution`（B7 复核接受） | ADR-0014 的 P1 交付清单；后续 T-305 自进化前置 |

## 待人工裁决（不得由 agent 决定）

- V 项正式结论与 G0/G1 签署（`docs/work/validation/register.json`）。
- D-005 的假设若被真实结论推翻，受影响功能需重新定范围（记录为新决策行，不回改历史行）。
