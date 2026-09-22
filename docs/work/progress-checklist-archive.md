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
**EV-171 批的扩展**：为给新行腾预算，截止时间放宽到 **≤ 2026-09-21T14:00:00Z**，据此追加
`T-253`/`T-254`/`T-260`/`T-261`/`T-262`/`T-263`/`T-264`/`T-265c` 八行（整行逐字、按引入时间升序追加在文末；
既有各批也是「逐批追加」，故文末不全局单调 —— 这一点如实记在这里，不假装整文有序）。
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

**选入规则（2026-09-22 迁移阶段 4.1 批次追加）**：主文件里第二个单元格**不为 `P0`**、`status` 列**恰为 `done`**、且**批号 ≤ B66 的老行**（内容已被后续批次取代），按主文件行序整行逐字搬入：`T-252` `T-254b` `T-255` `T-257a` `T-258a` `T-260a` `T-261a` `T-262a` `T-263a` `T-270` `T-266` `T-271`（共 12 行）。待办/阻塞行一律留在主文件（面板计数读主文件）。搬入的行与它们在主文件里时**逐字节相同**，`git diff` 可复核。

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
| T-260 | 实现：`tools/refresh-ui-snapshots.py` + `pipeline-view`（第九个自进化产出）+ `/api/pipeline` + 门与端到端；线上与公网 200 | B60 | done | D-053 / EV-095 |
| T-254 | 留存计划可被看见：桥侧 `retention.plan`（compute，只读）+ 宿主 `retention-view`（自进化产出）→ 运维视角 `/api/retention`；线上+公网 200 | B50 | done | EV-089 / EV-090 |
| T-253 | 留存**执行侧**：真删派生副本 + 读侧封存 + 落 `evidence/retention-*`；`AC-AUDIT-005` 机检 22/22 | B49 | done | D-048 / EV-088 |
| T-264 | 系统管理 UI：`/quotagent/admin/` 道 + token 提权 + 视角切换 + agent 进度/阻塞面板 | B67 | todo | D-059 |
| T-265c | 线上闭环：UI 提交 → 消费 → 面板 blocked 9→8 / resolved 0→1（真回读） | B68 | done | EV-133 |
| T-263 | 三域视图**变异自证**：逐处偷改实现 → 对应门必须真变红（`verify.sh ui-mutate`，4/4 红且还原） | B65 | done | EV-098 |
| T-262 | 快照写入器加**有界的最近列表**（谈判轮次 / FAQ 条目），供业务视角渲染 | B64 | done | EV-097 |
| T-261 | UI 种子：`tools/ui-seed-pipeline.py` + `verify.sh ui-seed`（7/7）+ 接进 serve 启动流程 + 线上非 0 回读 | B62 | done | D-054 / EV-096 |
| T-311 | P2 | 12 条用户诉求**持久化进合同**：`FR-USREQ-001..012`（§6.1，每行含原话短引 + 可验收含义 + 验收方式）+ 可追溯表 `docs/work/requirements-traceability.md`（2 done / 9 partial / 1 missing）+ FR 归档批次 B（46 行逐字；主文件 31695→28235 B）+ `AC-USREQ-006`（cron 没待处理反馈时不得发垃圾消息，10/10） | FR-USREQ-001..012 | AC-USREQ-006 | done | EV-159 |
| T-312 | P2 | 「一切皆插件」架构**持久化成硬规范**（本批，只改文档）：① `docs/design/27-plugin-architecture.md`（三层分类 system 34 / domain 25 / userspace 2 + 单插件目录布局 + `plugin.json` 最小契约 + 六动词生命周期 + 依赖规则 + 注入式 UI 契约 + cordis 边界：直接用/可替换/必须自研/不迁移）② `docs/design/28-plugin-requirements-and-run.md`（"不存在产品整体功能性需求" + 40 个 FR 家族 / 45 个 AC 家族 → 归属插件逐条映射 + 一键运行契约原文）③ ADR-0020「一切皆插件与目录规范」、ADR-0021「需求必须归属到插件」④ `docs/work/plans/plugin-migration-plan.md`（6 阶段，每阶段可单独提交）+ `plugin-file-map.md`（**259 行**逐文件映射，256 路径全映射 0 未映射）+ `spec-persistence.md`（tmp/ 与 plans/ 的事实源落点 + 5 条缺口登记）⑤ 预算表新增 4 行（`docs/work/plans/*.md` 等）⑥ 可追溯表加"插件归属"列（12 条） | FR-PLUGIN-001..004, FR-USERPLUG-012 | AC-PLUGIN-004 | done | EV-162 |
| T-313 | P2 | **两个阻塞消掉（本批）**：① **D-073 根因修复** —— `AC-AGENTRT-002` 的会话哨兵扫描改为**契约源集合**口径（全树 − `.git/.venv/tmp/node_modules/__pycache__`，按相对仓库根的路径分量判定；与 D-071/D-072 同源），哨兵改分片拼接（检查器自身不再是命中源），并新增 **⑤b 反向断言**（真源码路径含哨兵 ⇒ 必命中；仅 `tmp/` 派生副本 ⇒ 不命中；副本字节还原后与真源逐字节一致）与 ⑤c ② **文档预算**：AC 主文件 32645→25723 B、进度清单 31843→23921 B（均 ≤ 28 KB），各行**整行逐字**搬入新建 `acceptance-criteria-archive-b.md` / `progress-checklist-archive.md`（门的 **T 定义集合先扩到归档**再搬） | – | AC-AGENTRT-002 | done | EV-164 |
| T-314 | P2 | **迁移阶段 1 的骨架与契约工具（本批）**：① 三层骨架 `src/{system,domain,userspace}/` + **3 个真实插件样板**（`system/runtime`、`domain/advice`（wrapper/重导出 → `host/modules/advice-panel.mjs`，阶段 4.1 实体搬迁）、`userspace/demo-ns/hello`（实体搬迁，用户空间体量小）），每个含 `plugin.json`（最小契约）+ `README.md` + `requirements/` + `docs/` + `code/` + `tools/` + `tests/` + `data/`；wrapper 的 README 逐条写明"阶段 1 wrapper、阶段 N 实体搬迁" ② `tools/plugin.sh` 六动词真实现（目录即清单 / 最小契约校验 / 依赖闭包含环 / **真 import + 真挂进常驻运行时进程**；`reload` 新实例、`unload` 回读 effects 归零）③ 拒绝路径逐条有名 code（未知插件 / 非法层名 / 未知动词 / 依赖成环 / 坏清单） | FR-PLUGIN-001, FR-PLUGIN-003, FR-RUNTIME-001 | AC-PLUGIN-005 | done | EV-165 |
| T-315 | P2 | **注入式 UI 注册面 + 一键运行（本批）**：① `host/lib/ui-slot.mjs`（机制：槽位闭合集合 / 排序 / 装配 / 拒收内联脚本 / 指名报错，**0 插件 id、0 业务名词**）+ `host/modules/webui.mjs` 只提供注册面与通用拼接（源文件里 0 次出现样板插件 id/标题）② 两个样板插件各注册一个只读区块，**真页面真出现**（两页仍 0 内联脚本）③ 仓库根 `./run up|down|status|doctor`（POSIX sh；doctor 7 项逐条 next_action；凭据缺失不阻塞 up；二次 up 幂等且两次 status 逐字节一致；down 真释放端口）④ 新门 `plugin-lifecycle`（43/43）与 `run-once`（含 4 处单点变异全红 + 产品树字节不变）⑤ D-075 记录"装载落在常驻运行时进程 / 注入面只做机制"与三条实测坑 | FR-PLUGIN-005, FR-RUNTIME-001 | AC-PLUGIN-006, AC-RUNTIME-010 | done | EV-165, EV-166 |
| T-316 | P2 | **「需求归属到插件」从口号落成完整映射与逐插件需求文档（本批，只动文档 + 一条门）**：① `docs/work/plugin-requirements-map.md`（**63 行**插件一行一表：`插件 id / 负责的 FR 号 / 承载文件 / 状态 / 证据`）—— FR 定义集合 **166 条各出现且仅出现一次**（未认领 0、重复 0），与 28 §2.2/§2.4 家族表的 **13 处偏差逐条登记**（归属真源 = `15-requirements-coverage.md`，ADR-0021 §2），**52** 个插件的需求文档缺口逐条列在 §4.1 ② **9 个插件的独立需求文档**：3 个样板在标准位置（`src/{system/runtime,domain/advice,userspace/demo-ns/hello}/requirements/README.md`）+ 6 个核心（webui/storage/market/evolution/mail/kernel）在 `docs/work/plugin-requirements-<插件>.md` （**位置偏差**逐条登记在 §4.2：先建裸插件目录会让 `plugin-lifecycle` 的 A13/A14 变红，本批不得把门改松）③ `docs/design/14-plugin-inventory.md` **先归档再加行**：库层/Python 侧/工作区/自进化四节 **4348 B 整节逐字**搬入新建 `docs/design/14-plugin-inventory-archive.md`，主文件 28564 → 24865 B，再加 9 行（3 样板 + 6 骨架）⇒ **27390 B ≤ 28 KB（实测）** ④ 新门 `plugin-requirements`（**17/17**：每条 FR 恰好一个归属 / 引用的 FR 都在定义集合内 / `plugin.sh list` 每个插件有行 / `req=` 文档真实存在 / 目录不无主 / 位置偏差与缺口清单双向登记 / 状态与证据；**4 处单点变异全红** + 防假变异 + 产品树字节不变）⑤ `plugins` 门扩成**清单文档集合**（主文件 + `14-plugin-inventory-archive*.md`，归档 0 条登记名 = 硬失败）⑥ 实测：`plugin-lifecycle` 43/44（A13/A14 对裸目录敏感，本批的文档位置选择已避开；剩余 1 项红 = 并发批次在飞的 webui 注册面 `/api/ui/blocks`，本批未改产品代码） | FR-USREQ-007, FR-PLUGIN-004 | AC-DESIGN-001, AC-PLUGIN-004 | done | EV-167 |
| T-101 | P0 | 仓库内自包含运行时 + CLI 骨架 | FR-RUNTIME-001, FR-RUNTIME-002 | AC-RUNTIME-001, AC-RUNTIME-002 | done | EV-007, EV-008 |
| T-102 | P0 | 账本：追加、哈希链、投影重建、去重 | FR-LEDGER-001..004 | AC-AUDIT-001, AC-AUDIT-002 | done | EV-005, EV-006 |
| T-103 | P0 | 事件五模式 + effect/disposer 语义 | FR-EVT-001..003 | AC-EVT-001, AC-EVT-002 | done | EV-009, EV-010 |
| T-104 | P0 | 插件装载与依赖协调 | FR-PLUGIN-001..003 | AC-PLUGIN-001, AC-PLUGIN-002 | done | EV-011, EV-012 |
| T-105 | P0 | QEP 信封 + 文件投递 + 幂等 | FR-QEP-001, FR-QEP-002, FR-QEP-004, FR-INTEG-001 | AC-QEP-001, AC-QEP-002, AC-INTEG-001 | done | EV-013, EV-014, EV-015 |
| T-106 | P0 | 归一化与拒绝语义 | FR-NORM-001..004 | AC-NORM-001..003 | done | EV-016, EV-017, EV-018 |
