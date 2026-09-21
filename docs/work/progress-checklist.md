# 进度清单

<!-- budget: 32 KB. status ∈ todo|doing|blocked|done；done 必须有 evidence（AGENTS.md 规则 6） -->

**当前阶段：P1 mvp demo（S1.1 已完成，S1.2 起按 `roadmap.md` §3 推进）**。设计期与 P0 mock（S0.1–S0.15 备料）任务全部 `done`；
P0 的 34 条 AC 全绿；P1 前提（V 项）按用户 2026-09-21 指令**假设通过**，在 `validation/register.json.planning_assumptions` 标注（非结论）。
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
| T-103 | P0 | 事件五模式 + effect/disposer 语义 | FR-EVT-001..003 | AC-EVT-001, AC-EVT-002 | done | EV-009, EV-010 |
| T-104 | P0 | 插件装载与依赖协调 | FR-PLUGIN-001..003 | AC-PLUGIN-001, AC-PLUGIN-002 | done | EV-011, EV-012 |
| T-105 | P0 | QEP 信封 + 文件投递 + 幂等 | FR-QEP-001, FR-QEP-002, FR-QEP-004, FR-INTEG-001 | AC-QEP-001, AC-QEP-002, AC-INTEG-001 | done | EV-013, EV-014, EV-015 |
| T-106 | P0 | 归一化与拒绝语义 | FR-NORM-001..004 | AC-NORM-001..003 | done | EV-016, EV-017, EV-018 |
| T-107 | P0 | 询价包与清单版本化 | FR-RFQ-001..003 | AC-RFQ-001, AC-RFQ-002 | done | EV-019, EV-020 |
| T-108 | P0 | 读包抽取、缺项、疑问草案 | FR-INTAKE-001..003 | AC-INTAKE-001, AC-INTAKE-002 | done | EV-021, EV-022 |
| T-109 | P0 | 成本构成（私域） | FR-COST-001..003 | AC-COST-001, AC-TRUST-001 | done | EV-023, EV-024 |
| T-110 | P0 | 定价建议 + 人工门 | FR-PRICE-001, FR-PRICE-002, FR-APPROVE-001, FR-APPROVE-002 | AC-PRICE-001, AC-APPROVE-001, AC-APPROVE-002 | done | EV-025, EV-026, EV-027 |
| T-111 | P0 | 偏差与影响量化 | FR-DEV-001, FR-DEV-002 | AC-DEV-001 | done | EV-028 |
| T-112 | P0 | 比价：TCO + 排序 + 引用链 | FR-COMPARE-001..003 | AC-COMPARE-001..003 | done | EV-029, EV-030, EV-031 |
| T-113 | P0 | 护栏：漏项 + 注入/私域检测 | FR-GUARD-002, FR-GUARD-005 | AC-GUARD-001, AC-GUARD-003 | done | EV-032, EV-033 |
| T-114 | P0 | 端到端脚本（S1 合成场景） | FR-EVAL-001 | AC-EVAL-001 | done | EV-034 |
| T-115 | P0 | 指标基线采集与报告 | FR-EVAL-003 | AC-EVAL-002 | done | EV-035, `docs/work/metrics-baseline.md` |
| T-116 | P0 | 文档门工具（`tools/verify.sh docs`） | – | AC-DESIGN-001..003 | done | EV-004 |
| T-117 | P0 | 现场验证 V-001..V-012 | – | manual（结论写入 functional-requirements §1） | doing | 备料+自检：EV-036, EV-037；12 份执行包与登记表：`docs/work/validation/`（结论状态全部 `open`，待人工签字） |

## P1 mvp demo（见 `roadmap.md` §3）

| T | 阶段 | 内容 | FR | AC | status | evidence |
|---|---|---|---|---|---|---|
| T-201 | P1 | 双侧进程分离 + profiles | FR-PLUGIN-004 | AC-PLUGIN-003 | done | EV-039 |
| T-202 | P1 | QEP 顺序/空洞/重发 + 版本协商 | FR-QEP-003, FR-QEP-005, FR-QEP-006, FR-QEP-008 | AC-QEP-003, AC-QEP-004 | done | EV-042 |
| T-218 | P1 | relay 绑定：opaque 转发 + 不可达排队重试 + 篡改拒投（S1.17） | FR-INTEG-002 | AC-INTEG-002 | done | EV-043 |
| T-203 | P1 | 三方协调 + 字段权威方 + 冲突上报（S1.3） | FR-QEP-007 | AC-SYNC-001 | done | EV-044 |
| T-204 | P1 | 澄清工单 + 广播完整性 + 版本重开（S1.4） | FR-CLARIFY-001..003 | AC-CLARIFY-001..003 | done | EV-045 |
| T-205 | P1 | 包版本变更与报价过期标记（S1.5） | FR-NORM-004, FR-RFQ-003, FR-RFQ-006 | AC-COMPARE-001, AC-RFQ-002, AC-RFQ-004 | done | EV-046 |
| T-206 | P1 | 护栏扩展：条款冲突（付款/质保/罚则）与产能冲突双来源（S1.6） | FR-GUARD-001, FR-GUARD-004 | AC-GUARD-001, AC-GUARD-002 | done | EV-047 |
| T-207 | P1 | 产能日历与交期校验 + `firm` 交期不可由模型变更（S1.6） | FR-CAP-001, FR-CAP-002, FR-GUARD-003 | AC-CAP-001, AC-GUARD-002 | done | EV-047 |
| T-208 | P1 | 审计包导出/验证 + 签名 + 包含证明 + 模型输入重建（S1.10） | FR-EVIDENCE-001..003, FR-EVIDENCE-005 | AC-AUDIT-001, AC-AUDIT-002, AC-AUDIT-004 | done | EV-048 |
| T-209 | P1 | 场景集 S1..S4 + 反例集 | FR-EVAL-001, FR-EVAL-002, FR-EVAL-004 | AC-EVAL-001, AC-EVAL-002 | todo | – |
| T-210 | P1 | 人工门队列视图 + 超时策略三选一（S1.12） | FR-APPROVE-003, FR-UX-001 | AC-APPROVE-003 | done | EV-049 |
| T-211 | P1 | 条款库与冲突标注（S1.11） | FR-TERMS-001, FR-TERMS-002, FR-GUARD-004 | AC-TERMS-001 | done | EV-050 |
| T-212 | P1 | 变更闭环（S1.11 前置：变更与报价版本衔接） | FR-CHANGE-001, FR-CHANGE-002 | AC-CHANGE-001, AC-CHANGE-002 | done | EV-051 |
| T-213 | P1 | 授标与 PO 闭环（含事件门机检） | FR-AWARD-001..003 | AC-AWARD-001, AC-AWARD-002 | done | EV-052 |
| T-214 | P1 | 比较表导出（S1.13） | FR-COMPARE-004, FR-UX-003 | AC-COMPARE-004 | done | EV-053 |
| T-215a | P1 | 分发记录 + 截止时间与超时提醒（S1.14 前置） | FR-RFQ-004, FR-RFQ-005 | AC-RFQ-003 | done | EV-054 |
| T-215b | P1 | 部署与操作手册（一页能跑起来）+ `verify.sh g1` 聚合门（MVP 判据见 ADR-0014 §3） | FR-RUNTIME-001 | AC-RUNTIME-001、走查 14 条判据 | done | EV-055 |
| T-219 | P1 | 宿主强制不变量 H1/H2/H3/H5/H6 各带负控（评审 C §7.1 第 6 条） | FR-PLUGIN-004 | `tools/verify.sh invariants` 22/22 | done | EV-056 |
| T-220 | P1 | 演化门机检骨架：proposal 记录 + patch/journal 归属 + 影子挂载 + dispose 回滚 + promote 必带人工 `approval_ref`（§7.1 第 7 条） | FR-EVOLVE-001 | `verify.sh evolution` 15/15（含负控） | done | EV-057 |
| T-223 | 模型 Jev 调研报告（强项/用法/适用性/插件建议） | B22 | done | EV-060 |
| T-225 | 插件清单门 + 模块自动发现 + clean-copy 门（fresh clone 自足性）+ host 依赖自愈 | B23 | done | EV-061 |
| T-226 | `timeline` 中间件插件（subagent 交付：按 realm 时间线环形缓冲、幂等去重、零残留） | B23 | done | EV-061 |
| T-228 | A1 `builtin` 断言改双向（声明即事实）+ 各模块声明与用法对齐 | B23b | done | EV-062 |
| T-227 | 自进化产出插件：提案交付 `host/modules/*.mjs`，影子目录真跑模块 fixture 当门信号，晋升仍需人工引用（ADR-0016） | B24 | done | EV-063 |
| T-229 | canary 分流与自动回滚：进/升需人工引用、回滚自动；判定三条阈值 + 样本不足不下结论（`canary` 插件，ADR-0017） | B25 | done | EV-064 |
| T-230 | canary 接线到真实入口：投影独立成 `projection` 插件 + `canary-dispatch` 失败隔离 + UI 路径端到端（ADR-0017 §4 收口） | B26 | done | EV-065 |
| T-231 | canary 样本接到真实桥调用：`bridge-canary` 插件 + CLI `--canary-weight/--candidate-module`（默认零影响，同形契约） | B27 | done | EV-066 |
| T-232 | 运行期中间件 `governor` 插件：可解释拒绝/背压、显式超时、有界重试（与 canary 互补） | B28 | done | EV-067 |
| T-233 | 运行期审计钩子 `audit-hook` 插件：决策留痕（观测，不写账本）+ 去重/有界/零残留 | B29 | done | EV-068 |
| T-234 | `governor` 接进 UI 真实 HTTP 路径：背压端到端（429+Retry-After）+ 三档映射单测（504/500） | B30 | done | EV-069 / D-027 |
| T-247 | 由 subagents 生产两件插件（supplier-scorecard 已接线 / idempotency-guard 待接线）+ 修 process.exit 截断 | B43 | done | D-042 / EV-082 |
| T-252 | FR-EVIDENCE-004 留存与销毁：设计决策 + ADR-0018 + 判定器 `services/retention.py` + 机检 21/21 | B48 | done | D-047 / EV-087 |
| T-254b | 留存计划的**刷新钩子**：seed 之后 + 网关探活时刷新（清目录后最多一个探活周期恢复） | B51 | done | EV-090 §5 |
| T-255 | 谈判轮次/让步：设计与契约落档（`16/17-negotiation-*.md`）+ ADR-0019 | B52 | done | EV-091 |
| T-257a | FAQ 沉淀与复用（FR-CLARIFY-004）契约落档 + D-051（`docs/design/18-faq-contract.md`） | B54 | done | — |
| T-258a | 邮件集成（无凭据部分）契约落档 + `AC-MAIL-001` + D-052（`docs/design/19-mail-contract.md`） | B56 | done | — |
| T-260a | P2 新服务运维可见：快照契约 + `AC-PIPELINE-001`/`AC-UI-002` + D-053（`docs/design/20-…`） | B59 | done | — |
| T-261a | 三域面板的"演示种子"标注：运维手册补节 + D-054（真流程种真事件、演员可识别、幂等） | B61 | done | — |
| T-262a | 业务双方视角：`/<view>/api/negotiation`、`/<view>/api/faq` + 页面区块 + 门断言（webui 25/25）+ D-055 | B63 | done | EV-097 |
| T-263a | 有界与顺序补真数据门（7 条→5 条、seq 倒序、投影哨兵）+ D-056 口径 | B65 | done | EV-098 |
| T-270 | dashboard 可见性缺陷：清单只在进程启动时读一次 → 按 mtime 重读 + 服务名可点链接（workspace 仓库 `5d00ab6`） | B66 | done | — |
| T-266 | P3 需求与验收规格落库（`docs/work/plans/p3-spec.json`：41 FR + 42 AC 全文）+ 3 份规划文档 | B66 | done | EV-131 |
| T-271 | Python 侧 admin 阻塞/进度判定器 + 快照写入器 + 2 条 AC 机检（subagent 产出，父方实跑） | B67 | done | EV-132 |
| T-275 | agent 运行期插件（上下文/记忆四层/harness）+ 围栏门 22/22 + 四类反例与 4 处变异自证 | B74 | done | EV-140 |
| T-275b | 父方复核：自跑门、静态零写面断言、挂 `verify.sh agent-runtime`、清单标『未接线』 | B74 | done | EV-140 |
| T-272 | 宿主侧 admin 门卫/视图插件 + 围栅门 18/18 + 端到端 12/12（subagent 产出，父方实跑） | B67 | done | EV-132 |
| T-273 | admin 道接入 webui（路由/提权表单/CLI/e2e/profile/stubs/verify.sh）+ 本批 FR/AC 落表 | B67 | done | EV-132 |
| T-273b | admin 道变异自证（统一拒绝体/投影/状态机/比较写法四处偷改必红；落表待实现） | B68 | todo | — |
| T-264 | 系统管理 UI：`/quotagent/admin/` 道 + token 提权 + 视角切换 + agent 进度/阻塞面板 | B67 | todo | D-059 |
| T-265b | Python 消费侧：`tools/admin-apply.py`（唯一写账本者）+ 判定器读已解决事实 + `AC-ADMIN-005` 16/16（subagent 产出，父方实跑） | B68 | done | EV-133 |
| T-265c | 线上闭环：UI 提交 → 消费 → 面板 blocked 9→8 / resolved 0→1（真回读） | B68 | done | EV-133 |
| T-265b2 | `approval_ref` 的**账本侧核验**（与批准记录对照，不只形状；先例 `retention_exec`） | B69 | todo | — |
| T-265 | 阻塞解除闭环：宿主只落待处理提交 → Python 侧消费 → 账本 `admin/block-resolved` | B68 | todo | D-059 |
| T-267a | `plugin-market` 插件：候选 + 围栅门 13/13 + 4 处变异自证（subagent 产出，父方实跑） | B69 | done | EV-134 |
| T-267b | 父方接线：profile/CLI/e2e/门/stubs/路由 + 晋升（ap-0111）+ 线上真回读 26 项 | B69 | done | EV-134 |
| T-267 | 插件市场插件 + 用户空间插件全生命周期与隔离四件套 + 提权 | B69 | todo | D-060 |
| T-268 | agent 运行期插件（上下文/记忆/harness，参考 deepseek harness） | B70 | todo | D-061 |
| T-269 | 存储插件（文件管理 / 数据库，接口与隔离先行） | B70 | todo | D-061 |
| T-263 | 三域视图**变异自证**：逐处偷改实现 → 对应门必须真变红（`verify.sh ui-mutate`，4/4 红且还原） | B65 | done | EV-098 |
| T-262 | 快照写入器加**有界的最近列表**（谈判轮次 / FAQ 条目），供业务视角渲染 | B64 | done | EV-097 |
| T-261 | UI 种子：`tools/ui-seed-pipeline.py` + `verify.sh ui-seed`（7/7）+ 接进 serve 启动流程 + 线上非 0 回读 | B62 | done | D-054 / EV-096 |
| T-260 | 实现：`tools/refresh-ui-snapshots.py` + `pipeline-view`（第九个自进化产出）+ `/api/pipeline` + 门与端到端；线上与公网 200 | B60 | done | D-053 / EV-095 |
| T-259 | 邮件**发信/收信**（需 SMTP/IMAP 凭据 + 人工决定收发对象）：接入传输实现 | B58 | blocked | 待人工提供凭据 |
| T-258 | 邮件实现（无凭据部分）：`services/mail.py` + `AC-MAIL-001` 机检 + 事件两侧登记 + 矩阵更新 | B57 | done | D-052 / EV-094 |
| T-257 | FAQ 实现：`services/faq.py` + `AC-FAQ-001` 机检 + 事件两侧登记 + 矩阵转正 | B55 | done | D-051 / EV-093 |
| T-256 | 谈判轮次**实现**：`services/negotiation.py` + `AC-NEGO-003`（机检 + 变异自证）+ 事件两侧登记 + 矩阵转正 | B53 | done | D-050 / EV-092 |
| T-254 | 留存计划可被看见：桥侧 `retention.plan`（compute，只读）+ 宿主 `retention-view`（自进化产出）→ 运维视角 `/api/retention`；线上+公网 200 | B50 | done | EV-089 / EV-090 |
| T-253 | 留存**执行侧**：真删派生副本 + 读侧封存 + 落 `evidence/retention-*`；`AC-AUDIT-005` 机检 22/22 | B49 | done | D-048 / EV-088 |
| T-251 | 需求覆盖矩阵 + `verify.sh coverage`：FR↔插件↔门全链可核对；补登记 14 FR/14 AC | B47 | done | D-046 / EV-086 |
| T-250 | subagents 产出两件（approval-digest→双方视角 / budget-guard→桥路径）并接线 | B46 | done | D-045 / EV-085 |
| T-249 | 把 P2 现状写进运维手册（三条视角道/接口/中间件接线/门清单/排障） | B45 | done | D-044 / EV-084 |
| T-248 | 幂等守卫接进桥调用路径（同请求只打一次下游，端到端门 5/5） | B44 | done | D-043 / EV-083 |
| T-246 | 把"新增依赖同步四处"的人肉清单变成机检（verify.sh wiring 5/5，抓出 2 个孤儿 stub） | B42 | done | D-041 / EV-081 |
| T-245 | 第五个自进化产出（evolve-journal）：自进化流水接进运维视角（webui 门 19/19） | B41 | done | D-040 / EV-080 |
| T-244 | 运维视角挂到 /quotagent/ops/（第三条视角道齐备，webui 门 18/18） | B40 | done | D-039 / EV-079 |
| T-243 | 第四次自进化产出：运维视角插件 ops-view（第三个视角，围栏门 9/9） | B39 | done | D-038 / EV-078 |
| T-242 | 把自进化产出的 breaker 接进真实调用路径（端到端门 4/4） | B38 | done | D-037 / EV-077 |
| T-241 | 第三次自进化产出：第一个中间件 circuit-breaker（围栏门人工维护，10/10） | B37 | done | D-036 / EV-076 |
| T-240 | 第二个自进化产出（evidence-summary）接进 WebUI 双方视角 + 固化"新增依赖同步四处" | B36 | done | D-035 / EV-075 |
| T-239 | 第二次自进化产出（evidence-summary）+ 同类失败护栏真的生效 + 追溯偷改负控 | B35 | done | D-034 / EV-074 |
| T-238 | 自进化产出的 price-history 接进 WebUI 双方视角（/api/history + 页面价格序列表） | B34 | done | D-033 / EV-073 |
| T-237 | 用自进化流程真实产出并晋升第一个进树插件（price-history）+ 可机检追溯链 | B33 | done | D-032 / EV-072 |
| T-236 | 运行期观测（governor/audit/canary）独立插件 + WebUI `/api/obs` 双方可见 | B32 | done | D-031 / EV-071 |
| T-235 | canary 探针 + 退化自动回滚接到真实命令路径（真人批准进、自动回滚出、落账） | B31 | done | D-030 / EV-070 |
| T-224 | Jev 建议层插件（`advisor`）：建议不入判定、低置信转人工、外部失败降级 | B23+ | todo | — |
| T-222 | WebUI 插件（双方视角路由）+ 工作区接入（从现有 dashboard 可访问） | B20/B21 | done | EV-059 |
| T-221 | P1 | 每个进树模块的 manifest（name/inject/Config/apply）+ fixture A1..A6 + ≥1 契约测试（§7.1 第 5 条） | FR-PLUGIN-001 | `verify.sh modules` 36/36（3 模块 × 12 项） | done | EV-058 |
| T-216 | P1 | 桥接协议最小闭环（握手/版本协商/方法面/身份注入/错误码） | FR-INTEG-004 | AC-INTEG-004, AC-INTEG-005 | done | EV-040 |
| T-217 | P1 | 桥的故障语义（SIGKILL/断连 + 背压 + 在途请求记 unknown + 重启预算 + 锚点）（S1.16） | FR-INTEG-004 | AC-INTEG-006 | done | EV-041 |

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
| T-310 | P2 | 澄清 FAQ 沉淀与复用（本 realm 内） | FR-CLARIFY-004 | AC-CLARIFY-004 | todo | – |

## 缺陷与阻塞

| 编号 | 类型 | 内容 | 影响 | 状态 |
|---|---|---|---|---|
| D-001 | 已知缺陷 | 已执行 AC：AC-DESIGN-001..003、AC-RUNTIME-001/002、AC-AUDIT-001/002、AC-EVT-001/002、AC-PLUGIN-001/002、AC-QEP-001/002、AC-INTEG-001、AC-NORM-001..003、AC-RFQ-001/002、AC-INTAKE-001/002、AC-COST-001、AC-TRUST-001、AC-PRICE-001、AC-APPROVE-001/002、AC-DEV-001、AC-COMPARE-001..003、AC-GUARD-001/003、AC-EVAL-001/002；其余 P0 AC 尚无实现 | 门 G0 未开始 | open（P0 进行中） |
| D-002 | 未验证 | V-001..V-012 全部待现场验证（**备料已完成**：12 份执行包 + 模板 + 登记表 + 校验器在 `docs/work/validation/`；agent 自检 EV-036/EV-037 已过；结论需人工签字，`register.json` 12 条均为 `open`） | 影响 P1 目标值设定与 G0 门签署 | open（等人工） |
