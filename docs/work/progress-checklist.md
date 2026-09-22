# 进度清单

<!-- budget: 32 KB. status ∈ todo|doing|blocked|done；done 必须有 evidence（AGENTS.md 规则 6） -->

**当前阶段：P1 mvp demo（S1.1 已完成，S1.2 起按 `roadmap.md` §3 推进）**。设计期与 P0 mock（S0.1–S0.15 备料）任务全部 `done`；
P0 的 34 条 AC 全绿；P1 前提（V 项）按用户 2026-09-21 指令**假设通过**，在 `validation/register.json.planning_assumptions` 标注（非结论）。
任务定义（描述与顺序）在 `roadmap.md`；本文件只维护**状态与证据**。
较早的行（**74 行整行** = 归档里 **64 条 `T-<数字>` 定义行** + 10 条不以数字结尾的辅助行；门只把
`T-<数字>` 计为定义行）在 `progress-checklist-archive.md`（同目录；选入规则见归档头）。
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
| T-265b | Python 消费侧：`tools/admin-apply.py`（唯一写账本者）+ 判定器读已解决事实 + `AC-ADMIN-005` 16/16（subagent 产出，父方实跑） | B68 | done | EV-133 |
| T-265b2 | `approval_ref` 的**账本侧核验**（与批准记录对照，不只形状；先例 `retention_exec`） | B69 | todo | — |
| T-265 | 阻塞解除闭环：宿主只落待处理提交 → Python 侧消费 → 账本 `admin/block-resolved` | B68 | todo | D-059 |
| T-267a | `plugin-market` 插件：候选 + 围栅门 13/13 + 4 处变异自证（subagent 产出，父方实跑） | B69 | done | EV-134 |
| T-267b | 父方接线：profile/CLI/e2e/门/stubs/路由 + 晋升（ap-0111）+ 线上真回读 26 项 | B69 | done | EV-134 |
| T-267 | 插件市场插件 + 用户空间插件全生命周期与隔离四件套 + 提权 | B69 | todo | D-060 |
| T-268 | agent 运行期插件（上下文/记忆/harness，参考 deepseek harness） | B70 | todo | D-061 |
| T-269 | 存储插件（文件管理 / 数据库，接口与隔离先行） | B70 | todo | D-061 |
| T-259 | 邮件**发信/收信**（需 SMTP/IMAP 凭据 + 人工决定收发对象）：接入传输实现 | B58 | blocked | 待人工提供凭据 |
| T-258 | 邮件实现（无凭据部分）：`services/mail.py` + `AC-MAIL-001` 机检 + 事件两侧登记 + 矩阵更新 | B57 | done | D-052 / EV-094 |
| T-257 | FAQ 实现：`services/faq.py` + `AC-FAQ-001` 机检 + 事件两侧登记 + 矩阵转正 | B55 | done | D-051 / EV-093 |
| T-256 | 谈判轮次**实现**：`services/negotiation.py` + `AC-NEGO-003`（机检 + 变异自证）+ 事件两侧登记 + 矩阵转正 | B53 | done | D-050 / EV-092 |
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

| T-317 | P2 | **运行期装卸 + `user-space` 单一源 + `./run logs\|config init`（本批）**：① **运行中的服务能真的装卸插件**：`tools/plugin.sh <动词> <插件> --live`（或 `./run plugin …`）把插件挂进**长驻 WebUI 进程自身的 ctx**（`src/system/runtime/code/live-control.mjs` + 客户端 `plugin-live.mjs`，控制通道经**路由注册面** `host/lib/ui-route.mjs` 注册，webui 零业务耦合）——装载后其注册区块**真出现在页面上**（`data-ui-block=…`），卸载后消失且**页面其余部分逐字节不变**（sha256 对比 = 阶段 5.3 那条未验断言）；`reload` 新 uid 且 effects 不泄漏；四道围栅（控制令牌 fail-closed / 显式确认 / system 层锁定 / 只认显式动词与 id）逐条有名 code + next_action；装卸全程**零写面**（`src/**`+`host/**`+数据根逐字节不变）② 修一个**真缺陷**：`host/cli.mjs` webui 装配段用 `inner.provide = …` 抓句柄 ⇒ 污染全树 provide ⇒ 后装载的插件把服务注册在别人 fiber 上、卸载留残注册（运行期再装载必红）；改为装配完 `ctx.get(...)` 读，并把"0 处 monkey-patch"做成门 D5 ③ `user-space/**` → `src/userspace/**` 收敛为**单一源**（`user-space` 改为 tracked 兼容符号链接；两份用户插件产物字节/声明哈希未变，旧实现逐字留档）④ `./run logs`（路径 + 有界尾部，缺日志如实失败）与 `./run config init`（**只含白名单键**、不覆盖已有真配置、打印指纹与逐条 next_action、0600 原子写、不写账本）⑤ 门：`plugin-lifecycle` **59/59**（新增 L1–L13 + D4/D5）、`run-once` **34/34**（新增 R12a-c/R13a-c/R14a-f + **8 处单点变异全红**：4 旧 + 4 新 logs/config-init）、`user-space` 21/21；空 HOME + 断网（`tools/netblock.c` 垫片，含非空转自证）下 up 成功且**不写 HOME** | FR-PLUGIN-003, FR-PLUGIN-005, FR-RUNTIME-001, FR-USERPLUG-001 | AC-PLUGIN-001, AC-PLUGIN-005, AC-PLUGIN-006, AC-RUNTIME-010 | done | EV-168 |
| T-318 | P2 | **52 个插件逐个补齐独立需求文档 + 位置口径定案（本批，只动文档 + 一处门的变异锚点）**：① **52 份**新文档 `docs/work/plugin-requirements-<层>-<插件>.md`（模板与逐段口径见映射表 §4），6 份核心文档改名统一带层前缀 ⇒ **63/63** 插件有 `req=` ② 缺口数 **52 → 0**（映射表 §5 复算命令算出，不手写）③ 位置口径定案进 27 §2.4 + 映射表 §4：**不建裸目录**（裸目录会被 `depsClosure` 当「插件存在」⇒ `plugin-lifecycle` 的 A13/A14 变红），文档落 `docs/work/`、建目录时 `git mv`，§4.2 逐条登记位置偏差 ④ 映射表 §3 偏差表整表拆到 `plugin-requirements-deviations.md`（守住 32 KB）⑤ **互证**：58 份文档的 FR 行集合 == 映射表认领集合（并集 166、缺 0、重复 0；原始行见 EV-169）⑥ **反向验证**：假目录（有 `requirements/`、无 `plugin.json`）⇒ `plugin.sh list` 报 `manifest-missing` + 门 A6b 判红 | FR-USREQ-007, FR-PLUGIN-004 | AC-DESIGN-001, AC-PLUGIN-004 | done | EV-169 |
| T-319 | P2 | **迁移阶段 4.1 先行 8 项：散落的检查/测试资产收进各自插件的 `tests/`，`tools/**` 瘦成薄入口（本批）**：① 清点 **143 项**（`tools/**` 76 / `host/*-gate.mjs` 20 / `src/quotagent/qa/checks_*.py` 47）**逐项分类**写进 `docs/work/plans/plugin-file-map.md` §分类（归属插件 + 三档：平台薄入口 6 / 插件·已搬 8 / 插件·待搬 129；与磁盘**双向可复算**）② **搬 8 项**（5 条真路由门 + `plugin-lifecycle` + `advice` + `checks_qprep.py`）→ `src/<层>/<插件>/tests/`，旧位置只剩**薄转发**（`runpy`/`importlib`；`tools/verify.sh` 的分支与门名**一行未改**，逐项搬前搬后 rc/关键输出对拍一致）③ 新增门 `plugin-assets`（PA1–PA7：目标在 + 旧位置只剩薄转发 + 分类表双向与全量登记 + 归属唯一 + 门接口不失联 + 散落只减不增；**4 处单点变异全红** + 防假变异 + 产品树字节不变）④ 4 个插件骨架（`system/projection`、`domain/{gate-timeline,authority-band,quote-prepare}`：`plugin.json` + README + wrapper 入口，四者真 `load`/`unload`）⑤ `tools/**` 非薄入口 **69 → 63**（搬走 7 + 本门 1）；预算表 `docs/work/plans/*.md` 32→48 KB 并把既有 5 个文件各钉在 32 KB（具体行只能收紧） | FR-PLUGIN-004, FR-USREQ-007 | AC-DESIGN-001, AC-PLUGIN-004 | done | EV-170 |
| T-320 | P2 | **「克隆就能一键跑」落成可复现的干净副本验收（本批）**：① 新门 `run-clone`（`tools/check-run-clone.py`，K1–K12）：`git archive HEAD` 解到**仓库外**临时目录（副本里没有 `.venv`/`host/node_modules`/`tmp`；路径集合 == `git ls-tree -r HEAD` 逐条对账）→ 在其中真跑 `doctor`（7 项逐项 next_action + 退出码 0）/`up`（外部实测 health 200 + `/quotagent/` 200 + pid 是活进程 + 副本内自建 `.venv`）/`status`/二次 `up` 幂等（两次 status 逐字节一致）/`down` 真释放端口；**两条反向对照**：删掉 `host/node_modules` 后 doctor 如实报 cordis 非 ok；装不上时（断网垫片 + 空 npm 缓存，及 `QUOTAGENT_NODE` 无同级 npm）`up` 如实失败并带回 `log`/`log_tail` 真原因；**4 处单点变异全红**（依赖准备改坏 / 健康检查不检查 / down 不释放端口 / doctor 把缺失报成 ok）+ 产品树字节不变 ② **实测真缺陷并修复**：索引里 `tools/*.sh` 是 `100644`（`core.filemode=false` ⇒ `chmod +x` 不入库）⇒ 干净克隆 `./run up` 报 `host-deps-install-failed`、`doctor` 的 gates 项 FAIL；`git add --chmod=+x` 7 个脚本，并把「入口可执行位」冻结成门内断言 ③ `./run` 的依赖准备失败改为**可诊断**（原样输出落 `tmp/run/deps-install.log`，失败体带 `log` + `log_tail`）；`doctor` 的 cordis 项区分「缺失但能自动准备」（降级、不阻塞）与「无 npm」（FAIL）④ README 快速开始：克隆 → 一条命令 → URL → 凭据降级与配置 → 下一步看哪里（≤ 4096 B 预算内）⑤ 门 `plugin-assets` 基线 63→64 + 本门登记（`plugin-file-map.md` §分类 +1 行） | FR-RUNTIME-001 | AC-RUNTIME-010 | done | EV-171 |

| T-321 | P2 | **「每个插件自带测试与需求」推到实体标准布局（本批）**：① **收紧 `depsClosure`/`scan`**（产品代码 + 门）：目录里没有**合法** `plugin.json` ⇒ **不算插件**（不进 `list`、不计数、不满足任何 `depends_on`）——反向验证：假插件（裸目录）⇒ `deps` 的 `missing_targets` 仍 `["system/webui"]`（改前 `[]`）、`status` ⇒ `unknown-plugin` rc=1；叠真插件目录 ⇒ 正常识别；`plugin-lifecycle` +A3c/A15–A18 与变异 5/6（6 处变异全红）② **58 份需求文档 `git mv`** 进 `src/<层>/<插件>/requirements/README.md`（**逐字节守恒**，逐条 sha256 在 EV-172）+ 54 个插件补**最小 `plugin.json`**（`entry` 尚未落地 ⇒ 如实 `degraded: artifact-missing`）；映射表 §4.2 改**归位台账**，`plugin-requirements` 门 A6c 收紧为三条双向断言（18/18）③ **10 个围栅门搬进各自 `tests/`**（旧位置 5 行薄转发；rc/输出形状/门数逐项对拍一致；`plugin-assets` 基线不放宽） | FR-PLUGIN-004, FR-USREQ-007 | AC-DESIGN-001, AC-PLUGIN-004 | done | EV-172 |
| T-322 | P2 | 迁移阶段 4.2 续批（本批）：① 剩 10 个 `host/*-gate.mjs`（至此 **20/20**）+ ② 21 个 `qa/checks_*.py` 搬进各自 `tests/` + ③ 内核实体进 `src/system/kernel/code/`（旧路径薄重导，`import quotagent.kernel.*` 不变）；逐项 rc/输出对拍 + 两半边；修 3 处「检查器读旧门路径」的真缺陷 | FR-PLUGIN-004 | AC-PLUGIN-004 | done | EV-173 |
| T-323 | P2 | **迁移终批（本批，三件）**：① 剩 **25 个** `qa/checks_*.py` 搬进各自插件 `tests/`（至此 **47/47**；旧位置 `importlib` 薄转发，导入面 / AC 注册 / `verify.sh ac` 一字未改；**85 条已注册 AC 的断言名与 ok 逐条对拍一致**= `names_same/ok_same` 全同）② **阶段 5 第二小片**：**12 个**服务模块实体进 `src/<层>/<插件>/code/`（`git show HEAD:<旧>` 的 blob **逐字节守恒 12/12**；旧路径**薄重导**（在旧模块命名空间里 exec）⇒ 相对导入一字不改；实测旧导入路径可用：`__name__` 不变且 `co_filename` 指向实体）③ **修 `storage` 遗留红**：事实区判据在 `user-space` 为**符号链接**时失效（`_inside(USER_SPACE, <realpath>)` 恒假 ⇒ `--root user-space/<别人的 ns>` 的**写被放行**，真在 `src/userspace/` 下落了文件）⇒ 改 `_inside_zone`（词法/真实两种形态**交叉各判一次**，收紧而非放宽）+ 门第 8 条**反向自证** + 新增 `--mutate 5`；`storage` **18/19 → 19/19**。附带：`AC-RUNTIME-001` 扫描面**收紧到实体目录**（62 个文件）；`plugin-file-map.md` 48825/49152 B ⇒ 批次叙事整节 5976 B 拆到 `plugin-file-map-batches.md`（主文件 43499 B）；`plugin-assets` **14/14**（RELOCATED 49→74；`tools/**` 非薄入口仍 **64 ≤ 基线 64**，**未放宽** ✗） | FR-PLUGIN-004, FR-RUNTIME-001 | AC-PLUGIN-004, AC-RUNTIME-010 | done | EV-174 |
| T-324 | P2 | **搬迁收口批（本批，四件）**：① 修 `AC-COMPARE-004`（P1，搬前即红）：改读**决策定义集合**（`decisions.md` + `decisions-archive*.md`），判据未放宽；反向验证（归档抽走 `D-016`）⇒ 同一条断言必红 ② **阶段 5 第三小片**：余下 **18 个**服务实体进 `src/<层>/<插件>/code/`（`git show HEAD:` blob **守恒 18/18**；旧路径**薄重导**；两半边 18/18：旧导入路径可用 + `co_filename` 指实体 + HEAD 顶层定义名逐名在场）；**先改读方再搬 9 处**（`checks_mail`/`checks_faq`/`checks_negotiation`/`checks_retention(_exec)`/`checks_admin`/`checks_mail_transport`/`check-mail-transport.py`/`check-plugin-inventory.py`）—— 否则静态断言在薄重导上**静默判绿**（实测：`p0-no-node` 的 AC-MAIL-002 被 `checks_mail_transport` 读红过）；反向验证 7/7 ⇒ 服务 **30/30** 全在 `code/` ③ **阶段 4.2 续搬 10 项** `tools/**` 进各自 `tests/`（旧位置薄转发；逐门 rc 与 passed/total 逐项不变：faq 20/20、negotiation 30/30、retention 21/21+22/22、mail 20/20、canary 11/11、canary-route 8/8、bridge-canary 11/11、governor 9/9、audit-hook 7/7、breaker-route 4/4）④ `plugin-assets`：RELOCATED 74→**84**、`BASELINE_NONTHIN` **64→54**（**收紧**，非放宽）；17 门全绿 | FR-PLUGIN-004, FR-COMPARE-004 | AC-COMPARE-004, AC-PLUGIN-004 | done | EV-175 |
| T-326 | P2 | **搬迁收剩批（本批，三件）**：① **12 项** `tools/**` 非薄入口进各自 `tests/`（外圈 `check-*`，旧位置薄转发；逐门 rc 与 passed/total 不变）② **13 个** `host/modules/*.mjs` 实体进 `src/<层>/<插件>/code/`（blob 守恒 13/13；旧路径经 `host/lib/entity-*` **薄重导**，`host/modules/*.mjs` 导入面与目录即清单一行未改）③ **7 个**「清单先行」插件补真实承载（`code/index.mjs` = 对既有实体的薄包装，`provides` 改真实服务键）| FR-PLUGIN-004 | AC-PLUGIN-004 | done | EV-176 |

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
| STORAGE-SYMLINK-FACT-ZONE | 已知缺陷（**已修**） | `tools/storage.py` 的事实区判据对 `user-space` **符号链接**失效（`_inside(USER_SPACE, <realpath>)` 恒假）⇒ 「`user-space/` 里别人的 ns」整类拒绝失效。**修前实测**：`--root user-space/zz-t277-other open-append --ns acme --rel logs/x.log --text S` 返回 `ok:true`、真在 `src/userspace/zz-t277-other/acme/logs/x.log` 落了 2 B；门第 8 条七种构造里 f5/f6 两个码为空 ⇒ `verify.sh storage` **18/19 搬前即红**。**已修（EV-174 / D-077）**：① 新增 `_zone_forms` + `_inside_zone`（词法 × 真实两种形态交叉各判一次；**收紧方向**：只可能多判成事实区）② 门第 8 条加**反向自证**：把判据回退成词法形态的变体副本**必须放行** f5/f6 ⇒ 本断言在那种形态下必红 ③ 门新增 `--mutate 5`（把产品实体回退 ⇒ 子进程 exit 1、首个 FAIL = 第 8 条、还原后 sha256 逐字节一致，实测 `18/19`）。**越权写入已在该轮删除**（`rm -rf src/userspace/zz-t277-other`，删后 `git status` 无残留） | 修前：事实区可被写入（违反「存储不得成为第二条事实写路径」）；修后 `storage` **19/19** | **resolved（EV-174 / D-077）** |
