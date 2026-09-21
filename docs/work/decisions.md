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
| D-009 | 桥的帧名（`method`/`result`/`error`/`bridge.credit`/`bridge.ready`）在 ADR-0013 之上由 `13-cordis-bridge.md` §2 定稿（ADR 只固定了传输与握手） | ADR-0013 §1 只定"一行一帧"；实现需要具体帧名，定稿落在设计层文档，便于升级时逐条比对 | agent:arch | 改帧名需同步宿主与 AC |
| D-010 | `fact` 面未开放时的错误码复用 `commit-refused`，由 `next_action` 与 `data.cls` 区分（fact→需放宽 ADR；commit→只走交互式 CLI） | 错误码表在 ADR-0013 §4 是**固定**的，新增码需改 ADR；两处语义都是"该面不可用" | agent:arch | 若新增 `surface-closed` 码，需先改 ADR 与两条 AC |
| D-011 | 重启后的锚点语义 = 宿主观测到的 `(seq, head)`：账本**落后**（seq 更小）、同 seq 的 `entry_hash` 不同、锚点不在链中、或链路校验失败 → 落 `kernel/bridge-fault` 并降只读；账本**超前**不算 fault（宿主只是没看到尾巴，用 `ledger.read` 补齐） | 若把"超前"也当异常，正常崩溃重启会被误判为回滚，导致不必要的只读降级 | agent:arch | 语义若变，AC-INTEG-006 的锚点断言与 ADR-0013 §6 需同改 |
| D-012 | 回执（`relay/receipt`）是**传输确认**而非业务事实：由接收方在应用成功后签名回发，发送方据此清账；`relay/receipt` 与 `relay/resend-request` 属**控制类**，不互相回执、不计入待回执 | 若回执也回执回执，双方会陷入无界乒乓（实测第一版就是这样）；把回执当业务事实又会污染事实账本 | agent:arch | 若引入批量回执或聚合 ack，需同步改 `03` §5 与 AC-QEP-003 |
| D-013 | 新增 `tools/check-ac-registry.py`（入口 `tools/verify.sh ac-registry`）：**phase 恰为 P0 的文档 AC 必须已有注册断言**，未到期（P1/P2/P0-P1）只报告不失败；反向捕获"注册了但文档没有"的孤儿 AC | 实测发现 `AC-CLARIFY-001` 在 `acceptance-criteria.md` 里标着 P0 却从未有断言（文档门只查文档，查不出这种漂移） | agent:arch | 若某 P0 AC 需要延后，须改文档 phase 或在 checklist 里写明理由 |
| D-014 | 事件派发统一走 `EventBus.dispatch()`（按事件的 `@mode` 选分发器）；服务不得自行 `emit(bail 事件)` | 实测暴露：`compare` 用 emit 派发 bail 模式的 `rfq/version-mismatch`，一旦挂上事件总线就抛 `EventModeError` —— 而 AC-COMPARE-001 当时没挂总线，所以漏了；修法把「按模式派发」下沉到总线并**同时给 AC-COMPARE-001/AC-EVT-001 补断言**（覆盖漏洞与 bug 一起修） | agent:arch | 新增服务写事件前先查 `05-events.md` 的 @mode；AC 里凡涉及事件派发的路径都要挂总线 |
