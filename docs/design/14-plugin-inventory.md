# 插件清单：每个功能由哪个插件提供（P2）

用户 2026-09-21 指令："项目的每个功能都应被插件提供"、"当 agent 自进化能力上线后，可以用自进化的方式制作插件或中间件等来使每一个功能模块都可分别独立演进"。

本文件的纪律：**功能必须有归属**。任何新增功能都必须在这里落到一行，并指明它由哪个插件（或哪个库/服务）提供、以及"独立演进"时改哪个文件。机检：`tools/verify.sh plugins`。

## 1. 宿主层插件（cordis，`host/modules/*.mjs`）

模块契约（fixture A1..A6 机检，见 `tools/verify.sh modules`）：`name` / `provides` / `inject` / `builtin` / `usedServices` / `Config`（`host/lib/std-schema.mjs`）/ `apply(ctx, config)` / `fixture.sample(handle)`；`inject` 里不得写内建 mixin（`events` 等，写进去插件永远 pending）；不得跨模块目录 import。

| 插件（文件） | 提供的能力 | 提供者服务名 | 被哪些 profile 装配 | 独立演进时改哪里 |
|---|---|---|---|---|
| `host/modules/kernel-bridge.mjs` | Python 内核的唯一写入通道（stdio NDJSON JSON-RPC，commit 面永不暴露） | `kernel-bridge` | `contractor-ops` 等（经桥接线） | 只改本文件 + `host/lib/bridge.mjs`；协议变更加 ADR |
| `host/modules/norm.mjs` | 单位/口径归一化（边界归一，不在决策里做） | `norm` | `supplier-bid`（`norm` 能力位） | 只改本文件；归一化口径与 Python `services/norm.py` 必须一致（`AC-NORM-*`） |
| `host/modules/compare.mjs` | 比价排序与权重组合（读账本，不写账本） | `compare` | `contractor-ops`（`compare` 能力位） | 只改本文件；排序语义变更须同步 `AC-COMPARE-*` 与 ADR-0011 |
| `host/modules/sourcing.mjs` | 领域插件：RFQ 覆盖率与缺口分析（`coverage`/`gaps`/`expiring`，纯函数只读账本行） | `sourcing` | `contractor-ops` | 只改本文件；覆盖率口径变更须同步其 fixture 断言 |
| `host/modules/timeline.mjs` | 中间件：按 realm 的事件时间线环形缓冲（有界、幂等去重、零残留；不产生业务事实） | `timeline` | `webui` | 只改本文件；容量/去重口径变更须同步其 fixture 断言 |
| `host/modules/projection.mjs` | 视角投影服务（谁看到什么字段；私域键拒收、抑制原因对外通用） | `projection` | `webui`、`contractor-ops` | 只改本文件；字段白名单变更须同步 `AC-TRUST-001` |
| `host/modules/audit-hook.mjs` | 运行期决策留痕（内存环形缓冲、去重键与账本同形、**不写账本/不写文件**） | `audit` | `contractor-ops`、`webui` | 只改本文件；关注前缀/容量变更须同步 `verify.sh audit-hook` |
| `host/modules/governor.mjs` | 运行期准入与等待：限流/背压（可解释拒绝）、显式超时、有界重试 | `governor` | `contractor-ops`、`relay` | 只改本文件；阈值/重试语义变更须同步 `verify.sh governor` |
| `host/modules/bridge-canary.mjs` | 调用面分流器：把 canary 接到宿主→内核的真实桥调用上（候选抛错回退 base、base 抛错原样抛） | `canary-dispatch` | `contractor-ops` | 只改本文件；接线语义变更须同步 `verify.sh bridge-canary` |
| `host/modules/canary.mjs` | 自进化产物的真实路由分流 + 自动回滚判定（进/升需人工引用，回滚自动） | `canary` | `contractor-ops` | 只改本文件；阈值/分流语义变更须同步 ADR-0017 与其断言 |
| `host/modules/observability.mjs` | 运行期观测的只读聚合（governor 准入 / audit 留痕 / canary 分流三源合一；不写账本、不写文件、无墙钟依赖） | `observability` | `webui`（经 `/quotagent/api/obs`） | 只改本文件；聚合字段变更须同步 `verify.sh observability` 与其 A5 确定性断言 |
| `host/modules/price-history.mjs` | 价格历史的只读描述统计（按供应商：次数/最低/中位/最高/最新 + 离散趋势）——**自进化产出的第一个进树插件** | `priceHistory` | `webui`（`host/profiles.mjs`） | 只改本文件；产物由 `tools/evolve-module.mjs` 产出，哈希受 `verify.sh evolve-module` 追溯 |
| `host/modules/evidence-summary.mjs` | 账本"证据面"的只读统计（按类型计数、关联数、带引用行数、时间跨度）——**第二个自进化产出** | `evidenceSummary` | `webui`（`host/profiles.mjs`） | 只改本文件；产物由 `tools/evolve-module.mjs` 产出，哈希受 `verify.sh evolve-module` 追溯 |
| `host/modules/circuit-breaker.mjs` | 中间件：运行期**熔断**（连续失败达阈值 → 快速失败；冷却半开试探，失败立刻重开；假时钟可注入）——**第三个自进化产出、第一个中间件** | `breaker` | `contractor-ops`（`host/profiles.mjs`） | 只改本文件；产物由 `tools/evolve-module.mjs` 产出，哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh breaker` 围栏 |
| `host/modules/ops-view.mjs` | **运维视角**：把 observability + breaker + evidenceSummary 编排成一个只读快照 + 人类可读摘要（只组合、不自算口径）——**第四个自进化产出** | `opsView` | `webui`（`host/profiles.mjs`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh ops-view` 围栏 |
| `host/modules/evolve-journal.mjs` | **自进化流水**的只读归纳（提案/影子/门两态/晋升/回滚/canary 进出 + 最近事件；只给计数，不出正文）——**第五个自进化产出** | `evolveJournal` | `webui`（`host/profiles.mjs`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh evolve-journal` 围栏 |
| `host/modules/supplier-scorecard.mjs` | 见产物头部注释（**由 subagent 产出、经同一条自进化流程晋升**） | 见模块 `provides` | `webui`（`host/profiles.mjs`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh supplier-scorecard` 围栏 |
| `host/modules/idempotency-guard.mjs` | 见产物头部注释（**由 subagent 产出、经同一条自进化流程晋升**） | `idempotency` | `contractor-ops`（桥调用路径） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh idempotency-guard` 围栏 |
| `host/modules/approval-digest.mjs` | 人工门**待批摘要**（总数/按动作/等待时长四桶/置信度分布/最久等待；只给计数与时长，不出正文）——**第六个自进化产出（subagent 生产）** | `approvalDigest` | `webui`（双方视角 `/api/approvals`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh approval-digest` 围栏 |
| `host/modules/budget-guard.mjs` | 中间件：**窗口成本预算准入**（整数 µ 金额、窗口滚动、超预算拒绝可解释；`budget-exceeded`（等窗口有用）与 `cost-exceeds-budget`（等也没用）分开报）——**第七个自进化产出（subagent 生产）** | `budgetGuard` | `contractor-ops`（桥调用路径） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯，语义受 `verify.sh budget-guard` + `budget-route` 围栏 |
| `host/modules/retention-view.mjs` | 留存计划的**只读聚合视图**（计数/动作分布/待人工门/最久项/一行摘要；只组合不自算、不出正文与私域键、确定性、有界）——**第八个自进化产出（subagent 生产，T-254）** | `retentionView` | `webui`（运维视角 `/api/retention`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯 |
| `host/modules/user-plugin-manager.mjs` | **用户空间插件的管理面（本身也是插件）**：list/load/unload/reload/requestCreate/elevateRequest（待办载荷；写盘与落账本均交 Python 侧）；隔离四件套由 `host/lib/user-space.mjs` 落实（独立 Context、服务键 `<ns>.<plugin>.<svc>`、文件根绑定、凭据作用域）—— **subagent 产出（T-268）** | `userPluginManager` | `webui`（系统管理道） | 只改本文件 |
| `host/modules/plugin-market.mjs` | **插件列表/市场本身由插件提供**：只读聚合三真源（`host/modules/*.mjs` 目录 / 本清单 / `user-space/*/plugin.json`），逐项给 `source`(human/evolve/user-space) 与 `wired`；三源不一致**必须报**（`inconsistent`+`differences`），不可取其一静默；降级优先、有界、确定性、零写面 —— **subagent 产出并晋升（T-267，ap-0111）** | `pluginMarket` | `webui`（系统管理道 `/quotagent/admin/api/market`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯 |
| `host/modules/admin-guard.mjs` | 系统管理道的**门卫**：token 校验（sha256 归一 + 恒定时间比较）、不透明会话（≥128 bit，非 token 派生）、失败五类**统一拒绝体**（无 oracle）、连续失败有界冷却（冷却内正确 token 也拒、结束不自动提权）、可注入假时钟 —— **subagent 生产（T-272）** | `adminGuard` | `webui`（系统管理道） | 只改本文件 |
| `host/modules/admin-view.mjs` | 系统管理面板的**只读聚合**：阻塞（来自 Python 侧真源）与进度；降级优先、有界、确定性、按键白名单投影、不出正文与私域键 —— **subagent 生产（T-272）** | `adminView` | `webui`（`/quotagent/admin/`） | 只改本文件 |
| `host/modules/pipeline-view.mjs` | 三域运维快照的**只读聚合**（谈判/FAQ/邮件计数与最近事件；只组合不自算、降级优先、有界、确定性）——**第九个自进化产出（subagent 生产，T-260）** | `pipelineView` | `webui`（运维视角 `/api/pipeline`） | 只改本文件；哈希受 `verify.sh evolve-module` 追溯 |
| `host/modules/agent-context.mjs` | **agent 上下文装配由插件提供**：从**已登记的来源**有界装配 一次 agent 轮的上下文；私域/对手侧数据**明确拒绝**入上下文（有码有 `next_action`）；截断后 `counts` 仍是夹取前真值（数字不许悄悄变小）—— **subagent 生产（T-275）** | `agentContext` | `agent-runtime` profile | 只改本文件 |
| `host/modules/agent-memory.mjs` | **agent 记忆四层由插件提供**：`session`（只在内存，任何 persist 一律拒）/ `project`（**只读**，是账本投影）/ `policy`（**只人类可写**）/ `cross_party`（只走协议，直接读另一侧即拒）—— **subagent 生产（T-275）** | `agentMemory` | `agent-runtime` profile | 只改本文件 |
| `host/modules/agent-harness.mjs` | **agent harness 由插件提供**：有界确定性骨架 （`plan()`/`step()`，硬上限 max_steps/max_bytes）；每步产一条**宿主内存**决策日志（环缓冲，**不落盘、不落账本**），日志不得出现凭据 —— **subagent 生产（T-275）** | `agentHarness` | `agent-runtime` profile | 只改本文件 |
| `host/modules/storage-view.mjs` | **存储的只读观察面（本身也是插件）**：每租户文件数/字节/表数/键数（来自 Python 侧快照）；有界、确定性、`degraded/reason`、按键白名单投影（不出正文与路径原文）—— **subagent 生产（T-277）** | `storageView` | `storage` profile | 只改本文件 |
| `host/modules/config-view.mjs` | **配置与凭据的可视面 + 干跑 + 待处理项落盘**：三层（项目/插件/凭据）总览（每键 `source`(default\|file\|env\|runtime) / `shadowed_by` / `editable`）、`preview()` 干跑（白名单+类型+人工门+diff，**零落盘零生效**）、`submit*()` 只落 0600 待处理项（真落盘由 `tools/config-apply.py` 做）、`credentials()`（configured/source/required_mode/指纹前 8/next_action，**永不回显值**）、`audit()`（只读账本 `config/*`·`credential/*`，按键投影）—— **subagent 生产（P0 配置与凭据 UI 化）** | `configView` | `webui`（系统管理道 `/quotagent/admin/config/`） | 只改本文件 + `host/lib/config-ui.mjs`·`config-keys.mjs`（库层） |
| `host/modules/mail-view.mjs` | **邮件域（SMTP/IMAP）的只读运维视图**：读 Python 侧写的状态快照（队列计数 / 最近一次尝试的结果与 reason / `available` / `next_action`），形状门 + 键白名单投影 + UTF-8 字节夹取；降级优先（快照缺失/坏形状 → 有名 reason）、确定性、**零写面、不联网、不起子进程**（真收发只在 Python 侧）—— **subagent 生产（凭据就位时的邮件真收发，本批）** | `mailView` | `webui`（运维道 `/quotagent/ops/mail/` 与 `/quotagent/api/mail`） | 只改本文件 + `tools/refresh-ui-snapshots.py`（快照写入器）与 `docs/design/14-plugin-inventory.md`（本行） |
| `host/modules/bid-heuristics.mjs` | **比价 heuristics visualizer**：把"这家为什么排在这里"拆成五个分量（单价/交期/付款条件/质保/偏差）的**贡献点**，并让双方**自己调权重**看名次怎么变（调权重 → 分数与名次必变）。极差归一（与 `services/compare.py` 同口径，同权重下名次一致）；只在**取得到的因子**上归一（缺失因子不假装 0，记进 `missing`）；权重越界**夹取并回显**、归一后和为一（容差 `1e-9`）；有界（`max_candidates`，超出如实报 `omitted`）；`degraded` + 有名 `reason`；**零写面**（不读账本、不写文件、不取墙钟、不随机）；**私域零泄漏**（只输出白名单字段；贡献点无量纲、不输出任何绝对量级——单点变异与哨兵负控见其门）—— **subagent 生产（本批比价 heuristics）** | `bidHeuristics` | `webui`（双方视角 `/quotagent/<view>/heuristics/` 与 `/quotagent/<view>/api/heuristics`） | 只改本文件 + `host/modules/webui.mjs` 里的候选映射与页面（口径变更须同步 `verify.sh bid-heuristics` 与 `tools/check-heuristics-route.py`） |
| `host/modules/advice-panel.mjs` | **AI agent 决策建议层**（domain 插件）：吃调用方给的**白名单结构化载荷**（本视角的截止 / 待批人工门 / `bid-heuristics` 同口径的比价行 / 通道声明），按**五条确定性规则**（① 截止临近或已过期 ② 比价得分极差过大 ③ 等待人工门 ④ 凭据缺口导致的阻塞 ⑤ 供应商侧如何提升排名）派生"下一步"：每条给 `severity` / `why` / **非空 `basis`**（指向载荷里的真键，如 `deadlines[pkg-1].due_at`）/ `next_action`（**可直接复制的命令或路由**）/ `blocked_by`。**诚实分层**：输出恒带 `engine="rules"` 与页面文案"本页建议由确定性规则从投影/快照派生，不含模型推测"；**无可分数据不编建议**（`degraded:true` + 有名 `reason` + `items:[]`，"载荷不能用"与"数据齐但无可建议项"是两个 reason）；有界（`max_items` + 如实报 `omitted`/`truncated`）、确定性（同输入两次逐字节一致、与入参键序/条目顺序无关）、**零写面**（不读账本、不写文件、不取墙钟、不联网、不调模型）—— **subagent 生产（本批决策建议层）** | `advicePanel` | `webui`（双方视角 `/quotagent/<view>/advice/` 与 `/quotagent/<view>/api/advice`；四道页面子导航含入口） | 只改本文件 + `host/modules/webui.mjs` 里的载荷装配与页面（口径变更须同步 `verify.sh advice` 与 `tools/check-advice-route.py`；围栏门 `host/t281-advice-gate.mjs`） |
| `host/modules/gate-timeline.mjs` | **「审批等多久 / 变更单到底是谁卡着」**（domain 插件，正面回答两条 human problem：**审批人等不到** 与 **变更单扯皮**）：吃调用方给的**白名单事实载荷**（本视角 `approval/*` / `change/*` 行 + `as_of`），派生 ① 还在等的人工门（`id/kind/subject/owner/age_seconds/age_basis/consequence/next_action/blocked_by`：挂了多久 + **口径** + 卡在谁手里 + 超时策略三种后果 `remind|escalate|abort`（**没有"超时自动批准"**）+ 可复制的真 CLI 与催办路由）② 变更单时间线（`id/state/owed_by/waiting_since/basis/next_action`：状态 + **谁欠谁一个动作** + 从哪条事件起在等 + 账本事件/计数引用）。**规则 ⑤「逐行明细」**（`change_detail`）：每行给 `line_id/desc/原量×原价/新量×新价/delta_amount/delta_pct/basis` + 行小计与总计差额 —— **金额全整数分**（`money_unit=cents` / `rounding=half-up-to-cent`）、缺依据的行列 `basis_missing` 且**不计入小计**（缺依据不得编数）、无可用行 ⇒ `degraded`+有名 reason+明细空、私域列仅业主侧可见（其余读都不读）。**`age_seconds` 的口径 = `as_of − approval/requested 事实 ts`，绝不取墙钟**（两个墙钟入口 `payload.now` / `config.now` 读都不读 ⇒ 同一份快照在任何"当前时间"下输出逐字节一致）；**永远不能批准**（服务面无 `approve/decide/submit` 这类方法、`meta.can_approve=false`）；空投影 → `degraded` + 有名 reason + **两列表为 0**；有界、确定性、私域零泄漏；零写面（不读账本、不写文件、不取墙钟、不联网、不调模型） | `gateTimeline` | `webui`（双方视角 `/quotagent/<view>/gates/`、`/quotagent/<view>/api/gates`、`POST /quotagent/<view>/gates/nudge`；**逐行明细** `/quotagent/<view>/changes/<id>/`、`/quotagent/<view>/api/changes/<id>`；四道页面子导航含入口） | 只改本文件 + `host/modules/webui.mjs` 的载荷装配与页面 + `tools/gate-nudge.py`（**唯一落账本者**：落 `gate/nudged`，body 恰 5 键不含理由正文）；围栏门 `host/t282-gate-timeline-gate.mjs` + 真路由门 `tools/check-gate-timeline-route.py`（`verify.sh gates`）+ **逐行明细围栏门 `host/t283-change-detail-gate.mjs`** + 真路由门 `tools/check-change-detail-route.py`（`verify.sh change-detail`） |
| `host/modules/webui.mjs` | 双方视角 WebUI（承包商/供应商两个路由；只读账本） | `webui` | `webui` | 只改本文件 + `host/lib/ledger-view.mjs`；接入见 `docs/work/deployment-manual.md` |
| `host/modules/ui-feedback.mjs` | **WebUI 自适应闭环的宿主侧一半**（用户反馈 → agent 产新版本 → 自动重载 → 页面提示"请刷新"）：`GET /<prefix>/<view>/feedback`（SSR `<textarea>` + POST 提交，**0 内联脚本**）、`POST` 提交**只落一条 0600 待办件**（含用户**原话正文** + sha256 + 视图名 + 提交时版本号；**账本零新增**，H1）、`GET /<prefix>/ops/ui-feedback/` 只读观察面（待处理计数 / 最近一次处理结果与 `reason` / 各视图版本号 / `available` / `degraded`+有名 `reason`；有界、确定性、不出正文）、**服务端可判**的 `data-ui-revision` + 版本落后时的 `data-ui-stale="true"`"请刷新"横幅（`?seen=rN` 即消）。版本号**只读** Python 侧原子写的 `versions.json`（宿主**从不递增**版本号、不写账本、不起子进程、不联网、不取墙钟）—— **subagent 生产（本批反馈闭环）** | `uiFeedback` | `webui`（双方视角 `/<view>/feedback`、运维道 `/quotagent/ops/ui-feedback/`、`/quotagent/api/ui-feedback`） | 只改本文件 + `tools/ui-feedback-apply.py`（唯一落账本者）+ `host/t280-ui-feedback-gate.mjs` + `tools/check-ui-feedback.py`、`webui`/`cli`/`webui` 门与 e2e 的挂载 |

目录即清单：新增功能 = 新增 `host/modules/<name>.mjs`（`host/modules/index.mjs` 自动发现），不必改中心清单；模块被哪个 profile 挂载仍写在 `host/profiles.mjs`（组成即数据，ADR-0015）。

## 2. 宿主库层（`host/lib/*.mjs`，不直接对外提供服务）

| 库 | 职责 | 谁依赖 |
|---|---|---|
| `host/lib/config.mjs` | profile 配置装载（三档可改性） | `cli.mjs`、各 profile |
| `host/lib/frozen.mjs` | 冻结面判定（`kernel.*` 含人也不能改，INV-010） | `cli.mjs`、`invariants.mjs` |
| `host/lib/schema.mjs` | 可改键白名单唯一真源 | `host/lib/config.mjs` |
| `host/lib/std-schema.mjs` | 极简 standard-schema 构造器（cordis 不导出 Schema） | 全部模块 |
| `host/lib/bridge.mjs` | 桥客户端（首帧 hello、方法面分级） | `kernel-bridge.mjs`、`cli.mjs` |
| `host/lib/supervisor.mjs` | 重启预算/在途请求/孤儿进程（AC-INTEG-006） | `cli.mjs supervise` |
| `host/lib/evolution.mjs` | 演化门骨架（提案/影子/门/晋升/回滚，T-220） | `evolution.mjs` |
| `host/lib/canary-dispatch.mjs` | 把 canary 分流接到真实请求路径（按 key 选实现、回灌样本、**候选失败回退 base / base 失败原样抛**） | `canary` 及其调用方（`webui` 路径） |
| `host/lib/ledger-view.mjs` | 只读账本视图（H1：宿主不写账本） | `webui.mjs`、`cli.mjs webui` |

## 3. Python 侧功能（`src/quotagent/`，每个服务也是一个可独立演进的单元）

| 层 | 归属 | 说明 |
|---|---|---|
| `src/quotagent/kernel/*.py` | 内核（账本唯一写入者、事件总线、插件宿主、QEP、交付） | 内核不可自改（ADR-0002）；`kernel.*` 冻结面 |
| `src/quotagent/services/*.py` | 业务服务（measures/norm/rfq/intake/realm/approval/costmodel/pricing/commitments/deviation/compare/guard/evaldata/evalmetrics/scenarios/relay/sync/clarify/quotes/capacity/terms/change/export/retention/retention_exec/negotiation/faq/**mail**/**mail_transport**/admin_blocks）——`negotiation.py`（谈判轮次与让步，T-256）、`faq.py`（澄清 FAQ 沉淀与复用，T-257）、`mail.py`（邮件集成无凭据部分，T-258，**发信边界**）、**`mail_transport.py`（邮件的真实传输层：SMTP 发信 / IMAP 收信，纯标准库；env 优先于配置文件的 `project` 段点分键 `mail.smtp.*`/`mail.imap.*`；没配就报 `mail-*-unconfigured`、配了连不上就报 `smtp-unreachable`/`imap-auth-failed` …；凭据不进日志/账本/异常消息；收信有界并报截断；每次真尝试原子写状态快照供宿主只读——本批新增）**——`retention.py`（留存与销毁判定器，T-252）当前只实现**判定**：其 AC-AUDIT-003 含"销毁生效后不可再读"，**执行侧未实现故该 AC 未标绿**，执行侧见清单 T-253 | 每个文件 = 一个功能单元；新增服务必须带 AC（`tools/verify.sh ac-registry`） |
| `src/quotagent/qa/checks_*.py` | 各 AC 的断言实现 | 改导入清单后必须立刻跑 `tools/verify.sh ac-registry` |
| `src/quotagent/g1side.py`、`src/quotagent/bridge.py` | 走查单侧进程 / 内核桥端点 | 见 `docs/work/deployment-manual.md` |

## 4. 工作区服务（本机基础设施，见 `docs/work/deployment-manual.md`）

| 服务 | 提供者 | 备注 |
|---|---|---|
| `quotagent`（工作区网关路由 `/quotagent`） | `tools/webui-serve.py` → cordis 插件 `webui` | 幂等接入脚本 `tools/ws-integrate.py` |

## 5. 自进化产出的插件（`ADR-0016` / `T-227`）

新增功能有两条合法来源：**人写**（`T-2xx` 批次）与**自进化提案**。后者走：

1. `makeModuleProposal`（`host/lib/evolution.mjs`）绑定产物路径 / `sha256` 内容哈希 / 字节数；
2. 产物先写**影子目录**，用 `node host/check-modules.mjs --module <name> --module-dir <shadow>/modules` **真跑** A1..A6；
3. `gateModule` 五条 AND（fixture 全绿 / 不变量 / 反例集 / 预算 / 人工介入率不升）；
4. `promoteModule` 写真实 `host/modules/`，**必须**带人工 `approval_ref`（`ap-NNNN`）且影子哈希与提案一致；
5. 回滚只删自有产物（内容被他人改过则拒绝）。

不变量：**自进化只能写 `host/modules/`**（内核/服务层不可自改）；门里的 `expected_effect.metric` 固定为
`fixture:module`（不接受模型自评）；晋升后必须在本表补一行并至少被一个 profile 装配，否则 `tools/verify.sh plugins` 会红。

机检：`tools/verify.sh evolution`（27 条断言，含 7 条负控）。

## 6. 尚未归属的功能（诚实清单）

无。新增功能前先在本文件登记归属；`tools/verify.sh plugins` 会比对 `host/modules/*.mjs` 与本表，缺行即红。
