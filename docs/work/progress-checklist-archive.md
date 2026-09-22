# 进度清单归档（主文件在 `progress-checklist.md`）

<!-- budget: 32 KB（与主文件同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

本文件是 `docs/work/progress-checklist.md` 的归档。**主文件仍是当前状态的正文**（当前阶段、在做的行、
缺陷与阻塞都在那里）。**归档不是豁免区**：

- **门的口径**：`T-<NNN>` 的定义可以落在主文件，也可以落在本文件（以及同目录下任何
  `progress-checklist-archive*.md`）。`docs/work/progress-checklist.md` + 这些归档 = 门的
  **T 定义集合**（`tools/check-docs.py` 的 `DEF_SETS["T"]` / `T_ARCHIVE_GLOB`）；ID 完整性按该集合判，
  所以"把一个 T 号搬进归档"不会制造"消失的 ID"。
- **搬进归档的行仍受全部断言约束**：ID 引用必须解析（`roadmap.md` 等处的 `T-` 引用照旧成立）、
  文件必须在预算内；门的输出会打印它读了哪些归档（`t_archives=[...]`），并**断言归档文件确实被读到**
  （归档 0 条 T 行即判失败）。
- **整行逐字搬走**：下面每一行与它在主文件里时**逐字节相同**（含 evidence 列），只换了所在文件，
  `git diff` 可复核。

**选入规则**（可复核）：主文件里第二个单元格**不为 `P0`**、`status` 列**恰为 `done`**（待办/阻塞行
一律留在主文件 —— 面板的计数读主文件）、且由 git 引入时间 **≤ 2026-09-21T10:46:22Z** 的 T 行，
按引入时间升序（同批保持原文件行序）整行搬入。**`P0` 行一律留在主文件**（最保守）。
| T-001 | 设计期 | 分析层文档（cordis 架构 / 设计优势 / agent 仓库约定 / 领域痛点） | – | – | done | EV-002 |
| T-002 | 设计期 | 设计层文档（00..12 + ADR-0001..0006） | – | – | done | EV-001 |
| T-003 | 设计期 | 需求与路线图（FR / AC / roadmap / 本清单 / handover） | – | – | done | EV-001 |
| T-004 | 设计期 | 文档门工具与运行、推送并回读远端 refs | – | AC-DESIGN-001/002/003 | done | EV-001, EV-003 |
| T-201 | P1 | 双侧进程分离 + profiles | FR-PLUGIN-004 | AC-PLUGIN-003 | done | EV-039 |
| T-202 | P1 | QEP 顺序/空洞/重发 + 版本协商 | FR-QEP-003, FR-QEP-005, FR-QEP-006, FR-QEP-008 | AC-QEP-003, AC-QEP-004 | done | EV-042 |
| T-203 | P1 | 三方协调 + 字段权威方 + 冲突上报（S1.3） | FR-QEP-007 | AC-SYNC-001 | done | EV-044 |
| T-204 | P1 | 澄清工单 + 广播完整性 + 版本重开（S1.4） | FR-CLARIFY-001..003 | AC-CLARIFY-001..003 | done | EV-045 |
| T-205 | P1 | 包版本变更与报价过期标记（S1.5） | FR-NORM-004, FR-RFQ-003, FR-RFQ-006 | AC-COMPARE-001, AC-RFQ-002, AC-RFQ-004 | done | EV-046 |
| T-206 | P1 | 护栏扩展：条款冲突（付款/质保/罚则）与产能冲突双来源（S1.6） | FR-GUARD-001, FR-GUARD-004 | AC-GUARD-001, AC-GUARD-002 | done | EV-047 |
| T-207 | P1 | 产能日历与交期校验 + `firm` 交期不可由模型变更（S1.6） | FR-CAP-001, FR-CAP-002, FR-GUARD-003 | AC-CAP-001, AC-GUARD-002 | done | EV-047 |
| T-208 | P1 | 审计包导出/验证 + 签名 + 包含证明 + 模型输入重建（S1.10） | FR-EVIDENCE-001..003, FR-EVIDENCE-005 | AC-AUDIT-001, AC-AUDIT-002, AC-AUDIT-004 | done | EV-048 |
| T-210 | P1 | 人工门队列视图 + 超时策略三选一（S1.12） | FR-APPROVE-003, FR-UX-001 | AC-APPROVE-003 | done | EV-049 |
| T-211 | P1 | 条款库与冲突标注（S1.11） | FR-TERMS-001, FR-TERMS-002, FR-GUARD-004 | AC-TERMS-001 | done | EV-050 |
| T-212 | P1 | 变更闭环（S1.11 前置：变更与报价版本衔接） | FR-CHANGE-001, FR-CHANGE-002 | AC-CHANGE-001, AC-CHANGE-002 | done | EV-051 |
| T-213 | P1 | 授标与 PO 闭环（含事件门机检） | FR-AWARD-001..003 | AC-AWARD-001, AC-AWARD-002 | done | EV-052 |
| T-214 | P1 | 比较表导出（S1.13） | FR-COMPARE-004, FR-UX-003 | AC-COMPARE-004 | done | EV-053 |
| T-216 | P1 | 桥接协议最小闭环（握手/版本协商/方法面/身份注入/错误码） | FR-INTEG-004 | AC-INTEG-004, AC-INTEG-005 | done | EV-040 |
| T-217 | P1 | 桥的故障语义（SIGKILL/断连 + 背压 + 在途请求记 unknown + 重启预算 + 锚点）（S1.16） | FR-INTEG-004 | AC-INTEG-006 | done | EV-041 |
| T-218 | P1 | relay 绑定：opaque 转发 + 不可达排队重试 + 篡改拒投（S1.17） | FR-INTEG-002 | AC-INTEG-002 | done | EV-043 |
| T-215a | P1 | 分发记录 + 截止时间与超时提醒（S1.14 前置） | FR-RFQ-004, FR-RFQ-005 | AC-RFQ-003 | done | EV-054 |
| T-215b | P1 | 部署与操作手册（一页能跑起来）+ `verify.sh g1` 聚合门（MVP 判据见 ADR-0014 §3） | FR-RUNTIME-001 | AC-RUNTIME-001、走查 14 条判据 | done | EV-055 |
| T-219 | P1 | 宿主强制不变量 H1/H2/H3/H5/H6 各带负控（评审 C §7.1 第 6 条） | FR-PLUGIN-004 | `tools/verify.sh invariants` 22/22 | done | EV-056 |
| T-220 | P1 | 演化门机检骨架：proposal 记录 + patch/journal 归属 + 影子挂载 + dispose 回滚 + promote 必带人工 `approval_ref`（§7.1 第 7 条） | FR-EVOLVE-001 | `verify.sh evolution` 15/15（含负控） | done | EV-057 |
| T-221 | P1 | 每个进树模块的 manifest（name/inject/Config/apply）+ fixture A1..A6 + ≥1 契约测试（§7.1 第 5 条） | FR-PLUGIN-001 | `verify.sh modules` 36/36（3 模块 × 12 项） | done | EV-058 |
| T-223 | 模型 Jev 调研报告（强项/用法/适用性/插件建议） | B22 | done | EV-060 |
| T-222 | WebUI 插件（双方视角路由）+ 工作区接入（从现有 dashboard 可访问） | B20/B21 | done | EV-059 |
| T-225 | 插件清单门 + 模块自动发现 + clean-copy 门（fresh clone 自足性）+ host 依赖自愈 | B23 | done | EV-061 |
| T-226 | `timeline` 中间件插件（subagent 交付：按 realm 时间线环形缓冲、幂等去重、零残留） | B23 | done | EV-061 |
| T-227 | 自进化产出插件：提案交付 `host/modules/*.mjs`，影子目录真跑模块 fixture 当门信号，晋升仍需人工引用（ADR-0016） | B24 | done | EV-063 |
| T-228 | A1 `builtin` 断言改双向（声明即事实）+ 各模块声明与用法对齐 | B23b | done | EV-062 |
| T-229 | canary 分流与自动回滚：进/升需人工引用、回滚自动；判定三条阈值 + 样本不足不下结论（`canary` 插件，ADR-0017） | B25 | done | EV-064 |
| T-230 | canary 接线到真实入口：投影独立成 `projection` 插件 + `canary-dispatch` 失败隔离 + UI 路径端到端（ADR-0017 §4 收口） | B26 | done | EV-065 |
| T-231 | canary 样本接到真实桥调用：`bridge-canary` 插件 + CLI `--canary-weight/--candidate-module`（默认零影响，同形契约） | B27 | done | EV-066 |
| T-232 | 运行期中间件 `governor` 插件：可解释拒绝/背压、显式超时、有界重试（与 canary 互补） | B28 | done | EV-067 |
| T-233 | 运行期审计钩子 `audit-hook` 插件：决策留痕（观测，不写账本）+ 去重/有界/零残留 | B29 | done | EV-068 |
| T-234 | `governor` 接进 UI 真实 HTTP 路径：背压端到端（429+Retry-After）+ 三档映射单测（504/500） | B30 | done | EV-069 / D-027 |
| T-235 | canary 探针 + 退化自动回滚接到真实命令路径（真人批准进、自动回滚出、落账） | B31 | done | D-030 / EV-070 |
| T-236 | 运行期观测（governor/audit/canary）独立插件 + WebUI `/api/obs` 双方可见 | B32 | done | D-031 / EV-071 |
| T-237 | 用自进化流程真实产出并晋升第一个进树插件（price-history）+ 可机检追溯链 | B33 | done | D-032 / EV-072 |
| T-238 | 自进化产出的 price-history 接进 WebUI 双方视角（/api/history + 页面价格序列表） | B34 | done | D-033 / EV-073 |
| T-239 | 第二次自进化产出（evidence-summary）+ 同类失败护栏真的生效 + 追溯偷改负控 | B35 | done | D-034 / EV-074 |
| T-240 | 第二个自进化产出（evidence-summary）接进 WebUI 双方视角 + 固化"新增依赖同步四处" | B36 | done | D-035 / EV-075 |
| T-241 | 第三次自进化产出：第一个中间件 circuit-breaker（围栏门人工维护，10/10） | B37 | done | D-036 / EV-076 |
| T-242 | 把自进化产出的 breaker 接进真实调用路径（端到端门 4/4） | B38 | done | D-037 / EV-077 |
| T-243 | 第四次自进化产出：运维视角插件 ops-view（第三个视角，围栏门 9/9） | B39 | done | D-038 / EV-078 |
| T-244 | 运维视角挂到 /quotagent/ops/（第三条视角道齐备，webui 门 18/18） | B40 | done | D-039 / EV-079 |
| T-245 | 第五个自进化产出（evolve-journal）：自进化流水接进运维视角（webui 门 19/19） | B41 | done | D-040 / EV-080 |
| T-246 | 把"新增依赖同步四处"的人肉清单变成机检（verify.sh wiring 5/5，抓出 2 个孤儿 stub） | B42 | done | D-041 / EV-081 |
| T-247 | 由 subagents 生产两件插件（supplier-scorecard 已接线 / idempotency-guard 待接线）+ 修 process.exit 截断 | B43 | done | D-042 / EV-082 |
| T-248 | 幂等守卫接进桥调用路径（同请求只打一次下游，端到端门 5/5） | B44 | done | D-043 / EV-083 |
| T-249 | 把 P2 现状写进运维手册（三条视角道/接口/中间件接线/门清单/排障） | B45 | done | D-044 / EV-084 |
| T-250 | subagents 产出两件（approval-digest→双方视角 / budget-guard→桥路径）并接线 | B46 | done | D-045 / EV-085 |
| T-251 | 需求覆盖矩阵 + `verify.sh coverage`：FR↔插件↔门全链可核对；补登记 14 FR/14 AC | B47 | done | D-046 / EV-086 |
