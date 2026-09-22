# 进度清单

<!-- budget: 32 KB. status ∈ todo|doing|blocked|done；done 必须有 evidence（AGENTS.md 规则 6） -->

**当前阶段：P1 mvp demo（S1.1 已完成，S1.2 起按 `roadmap.md` §3 推进）**。设计期与 P0 mock（S0.1–S0.15 备料）任务全部 `done`；
P0 的 34 条 AC 全绿；P1 前提（V 项）按用户 2026-09-21 指令**假设通过**，在 `validation/register.json.planning_assumptions` 标注（非结论）。
任务定义（描述与顺序）在 `roadmap.md`；本文件只维护**状态与证据**。
较早的行（54 行整行 = 归档里 52 条 `T-` 定义行；`T-215a/b` 不以数字结尾，门不按定义行计）在
`progress-checklist-archive.md`（同目录；选入规则见归档头）。
**归档仍受门校验**：主文件 + 归档 = 门的 **T 定义集合**（`tools/check-docs.py` 的 `DEF_SETS["T"]`）——
搬进归档的 T 号仍是定义，引用照解析。

## 设计期

| T | 阶段 | 内容 | FR | AC | status | evidence |
|---|---|---|---|---|---|---|

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
| T-209 | P1 | 场景集 S1..S4 + 反例集 | FR-EVAL-001, FR-EVAL-002, FR-EVAL-004 | AC-EVAL-001, AC-EVAL-002 | todo | – |
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
| T-276 | 项目记忆=账本可重建投影（真账本 11 条/9 类；丢缓存不丢事实；只读重放；`citations` 齐） | B75 | done | EV-141 |
| T-277 | 存储由插件提供：`tools/storage.py`（文件管理+键值表，租户分区）+ 围栏门 18/18 + 4 处变异自证 | B76 | done | EV-142 |
| T-277b | 父方复核与接线：我自跑门、挂 `storage` profile、补登记行、落 AC-STORAGE-001/004 | B76 | done | EV-142 |
| T-278 | 运行期插件独立装卸/卸载零残留/卸载后事实不丢（`AC-AGENTRT-007` 5/5） | B77 | done | EV-143 |
| GUI-P0a | 上手页 `/start/` + `/api/routes` 路由表（每页可达 token/配置位置）`f3e76b8` | B78 | done | EV-144 |
| GUI-P0b | 第一屏三块 + 8 个子视图（GET 筛选/排序/翻页）+ 门 27→44/44；顺手修掉 admin 面板恒 `NaN` 的既有 bug | B78 | done | EV-144 |
| GUI-P0c | 配置/凭据 UI + YAML 持久化 + `--init`；新模块 `config-view`；门 `config-route` 22/22 | B79 | done | EV-145 |
| GUI-P0d | 邮件由插件提供：未配置诚实报未连接、配置后真收发（回环 SMTP 真发）+ `mail-view` 只读视图 + `verify.sh mail-transport` 27/27 | B80 | done | EV-146 |
| GUI-P0e | 比价 heuristics visualizer（可调权重 + 贡献分解 + 私域零泄漏；门 32/32 + 路由门 12/12） | B81 | done | EV-147 |
| DOC-AC1 | AC 归档合法化：门把 `acceptance-criteria-archive*.md` 并入 AC 定义集合（docs/ac-registry/coverage 三处口径统一 + 归档空读守卫 + `archives=[...]` 可观察）；46 条非 P0 老行逐字搬入归档，主文件 32760→25066 B；反向验证 3 例（副本上做，字节还原一致） | B82 | done | EV-149 |
| P3-UX2 | 三份 UX 规格持久化进 `docs/work/plans/`（22 痛点 / 9 human / 20 FR 草案）`4e0f2cb` | B78 | done | — |
| P3-UXWF | 员工工作流驱动的 UI 重做规格（三部分：`docs/work/plans/ui-workflow-rework.md` + `-part2.md` + `-part3.md`；§0 结论 / §1 实测证据 / §2 缺口清单 / §3 目标交互规格 / §4 视觉规格 40 条 / §5–§7）。**以承包商采购员与供应商报价员两个角色逐步实测现有 UI**：58 次真请求里 36 次卡住或假成功（含 4 例「POST 200 且与 GET 逐字节相同」的假成功），能完整完成的步骤 = 0（承包商 0/6，供应商 0/5），全部探测跑完两侧账本 sha 逐字节不变；视觉量测 26 页 0 CSS 变量 / 0 焦点态 / 0 `@media` / 0 `<button>` / 0 卡片类。**只产出规格与证据：不改代码、不改门、不改 AC/FR 定义** | – | – | done | EV-158 |
| T-283 | P2 | 「审批等多久 / 变更单谁卡着」GUI 闭环：`gate-timeline` 插件（等待时长口径=事实 ts 差、不取墙钟、**不能批准**）+ 三路由（页面/JSON/催办 POST 只落 0600 待办件、账本零新增）+ `tools/gate-nudge.py`（唯一落账本者，落 `gate/nudged`）+ 围栏门 33/33（4 处变异自证）与真路由门 11/11 | FR-GATE-001 | AC-GATE-001 | done | EV-153 |
| T-284 | P2 | 「变更单到底改了什么、多花多少钱」**逐行明细**：`gate-timeline` 规则 ⑤ + 两路由（`/<view>/changes/<id>/` 与 `/<view>/api/changes/<id>`，只读）+ 金额整数分逐行手算对账 / 缺依据的行不入小计 / 无可用行必降级 + 围栏门 22/22（4 处变异自证）与真路由门 9/9 | FR-GATE-002 | AC-GATE-002 | done | EV-154 |
| T-284 | P2 | 「授权区间」：谁能批到多少 / 越界怎么办 / 下一个能批的人是谁（`authority-band` 插件 + 两条路由 + 配置键进白名单可由 UI 改与 YAML 初始化）+ 围栏门 22/22（4 处变异自证）与真路由门 12/12 | FR-AUTH-001 | AC-AUTH-001 | done | EV-156 |
| T-285 | P2 | 「来不及回 RFQ」GUI 闭环：`rfq-deadline` 插件（回文时限口径=**事实 ts 差**、不取墙钟、**不能发信**、名册是业主私域）+ 三路由（页面/JSON/登记承诺 POST 只落 0600 待办件、账本零新增）+ `tools/rfq-promise.py`（唯一落账本者，落 `rfq/promised`）+ 围栏门 23/23（4 处变异自证）与真路由门 11/11（含 POST→0600→掉账本回读→**承诺改变页面口径**） | FR-RFQ-008 | AC-RFQ-006 | done | EV-157 |
| T-287 | P2 | 「供应商看不到自己的 RFQ 包」的根因修复：投递信封 + 收件人作用域 + **字段级白名单**（契约 `docs/design/26-rfq-delivery-visibility.md`）+ 首页投递块（只读、0 内联脚本）+ `--rfq-delivery` 装配；围栏门 26/26（**4 处单点变异全红**，含把包发给所有供应商的越权变异）与真路由门 10/10（真两进程两身份） | FR-RFQ-009 | AC-RFQ-007 | done | EV-160 |
| T-288 | P2 | **「不要假成功」+ 第一条真写闭环**：① 宿主围栏 —— **只应为 `GET` 的路由收到非 GET ⇒ 405 + `Allow: GET` + `{ok:false,code:"method-not-allowed",next_action}`**（改前实测 GET 与 POST `/contractor/quotes/` 返回**逐字节相同**的 200 页面，bytes=3935/sha256 相同；表单 action 只指向真写路径）② `quote-prepare` 插件（字段级 8 字段校验 + 行项目目录从本视角事实逐条按键读、读不出来**不编** + 草稿恒为**待签署** + **不能签名/提交/发信**）+ 两条路由 `GET｜POST /quotagent/supplier/quotes/prepare/`（宿主**只落 0600 待办件**、账本零新增、202 + `next_action`）③ `tools/quote-draft.py`（**唯一落账本者**：落 `quote/drafted`、body 恰 12 键、**两侧登记 ⇒ 双向可见**；幂等 + 6 类拒绝码）④ `tools/quote-sign.py`（**签名只能由人**：拒 `agent:*`，`human:*` 落 `approval/requested→granted→quote/submitted`）⑤ 围栏门 17/17（**4 处单点变异全红**）与真路由门 14/14 | FR-QUOTE-001 | AC-QUOTE-001 | done | EV-161 |
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
| T-224 | Jev 建议层插件（`advisor`）：建议不入判定、低置信转人工、外部失败降级 | B23+ | todo | — |

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
| T-311 | P2 | 12 条用户诉求**持久化进合同**：`FR-USREQ-001..012`（§6.1，每行含原话短引 + 可验收含义 + 验收方式）+ 可追溯表 `docs/work/requirements-traceability.md`（2 done / 9 partial / 1 missing）+ FR 归档批次 B（46 行逐字；主文件 31695→28235 B）+ `AC-USREQ-006`（cron 没待处理反馈时不得发垃圾消息，10/10） | FR-USREQ-001..012 | AC-USREQ-006 | done | EV-159 |
| T-312 | P2 | 「一切皆插件」架构**持久化成硬规范**（本批，只改文档）：① `docs/design/27-plugin-architecture.md`（三层分类 system 34 / domain 25 / userspace 2 + 单插件目录布局 + `plugin.json` 最小契约 + 六动词生命周期 + 依赖规则 + 注入式 UI 契约 + cordis 边界：直接用/可替换/必须自研/不迁移）② `docs/design/28-plugin-requirements-and-run.md`（"不存在产品整体功能性需求" + 40 个 FR 家族 / 45 个 AC 家族 → 归属插件逐条映射 + 一键运行契约原文）③ ADR-0020「一切皆插件与目录规范」、ADR-0021「需求必须归属到插件」④ `docs/work/plans/plugin-migration-plan.md`（6 阶段，每阶段可单独提交）+ `plugin-file-map.md`（**259 行**逐文件映射，256 路径全映射 0 未映射）+ `spec-persistence.md`（tmp/ 与 plans/ 的事实源落点 + 5 条缺口登记）⑤ 预算表新增 4 行（`docs/work/plans/*.md` 等）⑥ 可追溯表加"插件归属"列（12 条） | FR-PLUGIN-001..004, FR-USERPLUG-012 | AC-PLUGIN-004 | done | EV-162 |

| T-313 | P2 | **两个阻塞消掉（本批）**：① **D-073 根因修复** —— `AC-AGENTRT-002` 的会话哨兵扫描改为**契约源集合**口径（全树 − `.git/.venv/tmp/node_modules/__pycache__`，按相对仓库根的路径分量判定；与 D-071/D-072 同源），哨兵改分片拼接（检查器自身不再是命中源），并新增 **⑤b 反向断言**（真源码路径含哨兵 ⇒ 必命中；仅 `tmp/` 派生副本 ⇒ 不命中；副本字节还原后与真源逐字节一致）与 ⑤c ② **文档预算**：AC 主文件 32645→25723 B、进度清单 31843→23921 B（均 ≤ 28 KB），各行**整行逐字**搬入新建 `acceptance-criteria-archive-b.md` / `progress-checklist-archive.md`（门的 **T 定义集合先扩到归档**再搬） | – | AC-AGENTRT-002 | done | EV-164 |

## 缺陷与阻塞

| 编号 | 类型 | 内容 | 影响 | 状态 |
|---|---|---|---|---|
| D-001 | 已知缺陷 | 已执行 AC：AC-DESIGN-001..003、AC-RUNTIME-001/002、AC-AUDIT-001/002、AC-EVT-001/002、AC-PLUGIN-001/002、AC-QEP-001/002、AC-INTEG-001、AC-NORM-001..003、AC-RFQ-001/002、AC-INTAKE-001/002、AC-COST-001、AC-TRUST-001、AC-PRICE-001、AC-APPROVE-001/002、AC-DEV-001、AC-COMPARE-001..003、AC-GUARD-001/003、AC-EVAL-001/002；其余 P0 AC 尚无实现 | 门 G0 未开始 | open（P0 进行中） |
| D-002 | 未验证 | V-001..V-012 全部待现场验证（**备料已完成**：12 份执行包 + 模板 + 登记表 + 校验器在 `docs/work/validation/`；agent 自检 EV-036/EV-037 已过；结论需人工签字，`register.json` 12 条均为 `open`） | 影响 P1 目标值设定与 G0 门签署 | open（等人工） |
| D-071 | 已知缺陷 | 文档门 `tools/check-docs.py` 的 `md_files()` 把 `tmp/**/*.md` 也算进扫描范围（267 个 .md 里 166 个在 tmp/），与"整树副本门"（`new_scratch` 复制/删除 `tmp/ac/<rand>/clean/**`）形成 TOCTOU：实测 16 次文档门里 2 次 `FileNotFoundError`（旧 `check-docs.py:134/152`）→ 文档门红 → 内嵌跑它的 `AC-RUNTIME-002` 红。**已修（EV-152 / 决策 D-072）**：① 扫描范围收窄为**契约文档集合**（全仓 .md 减去 `.git/.venv/tmp/node_modules/__pycache__` 下的临时/派生文件；实测 267 → 98，引用数 6128 → 2798，预算与覆盖口径不变）② 契约文档在读窗口里消失**仍判红、不跳过**（`read_md`：裸 traceback → 指名失败，退出码仍 1）③ `AC-RUNTIME-001` 那条「扫描范围不变」断言语义改为**更精确**的"跑完后门的**契约文档集合**不变"，并加"门自报扫描数 == AC 独立测得数"对账 + "集合仍含全部定义文件"（10 → 13 条断言） | 并发下 12/12 绿（同条件旧门 11/12 红、churn 更快时 12/12 红）；`p0-no-node` 并发 59/59 无瞬时命中；九道门全绿 | **resolved（EV-152）** |
| GUI-P0h | 「AI agent 决策建议」层插件（确定性规则从投影派生，`engine=rules`，空投影不编建议；门 30/30 + 路由门 14/14） | B82 | done | EV-150 |
| GATE-FLAKE-2 | 门维护（本批）：① storage 门对无关写入者**解耦**（第 8 条收窄为"本用例自己触及的目标"+ 新增第 19 条全局层白名单断言；白名单外变化如实计数但**不判红**，负控+变异自证齐全）② `p0-no-node` **失败可诊断**（子进程输出不丢 + 连续两次红才算真红 + 原样回显）；**真因已量出**：文档门 `tools/check-docs.py` 的 `md_files()` 扫 `tmp/**`（267 个 .md 里 166 个在 tmp/），与整树副本门 TOCTOU → 16 次里 2 次 `FileNotFoundError`（未改文档门，见 EV-151 §三/§四） | 九道门全绿 | done | EV-151 / D-071 |
| GATE-FLAKE-3 | 门维护（本批，D-071 收口）：文档门扫描范围收窄为**契约文档集合**（决策 D-072：临时副本不进判据，`SCAN_EXCLUDE_DIRS` 与 AC-RUNTIME-001 的干净副本 IGNORE_DIRS 同口径；267 → 98）② 契约文档在**读窗口里消失仍判红**（`read_md` 不跳过；仪表化把窗口拉长后删真文档 → exit 1 且失败行指名该文件）③ `AC-RUNTIME-001` 那条断言语义改为「**契约文档集合**不变」+ 门自报数对账 + 定义文件仍在范围内 + 只断言本用例自己的 scratch（10 → 13 条） | 九道门全绿；并发 12/12 绿 | done | EV-152 / D-071 / D-072 |
| DOC-FR1 | FR 归档合法化：门把 `functional-requirements-archive*.md` 并入 **FR 定义集合**（`tools/check-docs.py` 的 FR↔AC 覆盖同步扩到集合 + 归档 0 条 FR 行硬断言 + `fr_archives=[...]`；`tools/check-fr-coverage.py` 同集合判矩阵双向全覆盖 + 归档空读守卫）；47 条最老非 P0 行**逐字**搬入新建归档，主文件 32583→27645 B；handover 1015→796 B；反向验证 3 例（整仓副本：归档抽行→红、主文件抽行→红（ID 未解析 + AC 孤儿两处）、0 条 FR 行的归档→红；还原 sha256 一致）；12 次连续 docs 全绿 | B83 | done | EV-155 |
| PERSIST-USREQ | **12 条用户诉求持久化进合同**（用户严厉指出「需求从未落进合同，因为你忘了」）：① `FR-USREQ-001..012` 写入主文件 §6.1（**原话短引 + 可验收含义 + 验收方式**；家族先查重，纯字母）② `docs/work/requirements-traceability.md`（需求→实现→证据；状态 **2 done / 9 partial / 1 missing**，无证据即 missing）③ FR 归档**批次 B**（46 行逐字，选入规则可复核；主文件 31695→28235 B ≤ 28 KB）④ 覆盖矩阵同步 12 行 + 3 条【缺口】登记（并清掉 §3 里 5 行重复登记与叙事，压回预算内）⑤ 新机检 `AC-USREQ-006`（cron 探测器 10/10；负控注入 `date` 即红）⑥ `tools/ui-feedback-monitor.sh` 纳入版本控制（需求 6 的载体，此前**未跟踪**） | B84 | done | EV-159 |
| D-073 | 门缺陷（**已修**，历史：本批之前实测命中） | `AC-AGENTRT-002` 的“⑤ 会话哨兵不落盘”断言扫 `tmp/`、`host/`、`user-space/` 时，把**自己源码的副本**当成命中（实测 `tmp/usreq-clean/src/quotagent/qa/checks_agentrt_memory.py`）⇒ `g1` 因这条断言红，与文档改动无关（无副本时不红）；这是“判据覆盖了无关写入者”的又一例（与 D-071/D-072 同类）。**已修（EV-164 / 决策 D-074）**：① 扫描口径改为**契约源集合**（全树减去 `.git/.venv/tmp/node_modules/__pycache__`，按相对根的路径分量判定；`SCAN_EXCLUDE_DIRS` 与文档门同源）② 哨兵改**分片拼接**（检查器自身不再自命中，⑤c 断言这条自洽性）③ 新增 **⑤b 反向断言**（真源码含哨兵 ⇒ 必命中、仅 `tmp/` 副本 ⇒ 不命中、副本字节还原比对）。**实测**：仓库里有 `tmp/` 源码副本时 `AC-AGENTRT-002` 绿且 `p0-no-node` 全绿；整仓副本里往真源码注入哨兵 ⇒ 红。（编号说明：`decisions.md` 的 D-073 是另一件事“同一秒的 requested+granted”，两处**历史撞车**，本轮不擅自重编号。） | 仓库内存在整树副本也不再红；根因消除，`g1`/`p0-no-node` 与副本解耦 | **resolved（EV-164）** |
| DOC-BUDGET-FLAKE | 未验证 | 父方在**别处**实测 `tools/verify.sh docs` 同批连续 5 次里 2 次 `exit=1`（当时 `docs/work/functional-requirements.md` = 32583/32768 B，即 99.4%）。本轮同机 12 次连续**全绿**（搬行后 27645/32768 B = 84.4%），且这 12 次的窗口内 `docs/work/*.md` 逐字节未变、`pgrep` 无并发写入者 ⇒ **本机未复现**（不排除父方当时确有并发写入者/半写读）。复现命令：`for i in $(seq 1 12); do tools/verify.sh docs; echo rc=$?; done`。**本批不擅自修门**（避免一次改两件事） | 门间歇红（未定位；预算 99.4% 时风险最高） | open（待复核） |
