# 用户诉求可追溯表（原话 → 实现 → 证据）

<!-- budget: 32 KB。状态只能是 done / partial / missing，且**必须**有证据列支撑（无证据即 missing）。 -->

## 0. 口径

- 本表是**用户诉求**（2026-09-22 批次，12 条）的落点：`需求号 | 用户原话要点 | 实现载体 | 状态 | 证据`。
- 契约行在 `functional-requirements.md` §6.1（`FR-USREQ-001..012`，一行一条，含原话短引 + 可验收含义 + 验收方式）；
  本表**不复制**契约文本，只给载体、状态与证据（一处一事实）。
- **状态定义**：`done` = 该需求在本仓可机检范围内的语义**全部有机检**且无登记缺口；`partial` = 有真证据，但有**已登记**缺口；
  `missing` = **没有任何**证据（不得写「已验证」）。没有证据支撑的一律 `missing`。
- **插件归属列（2026-09-22 架构规范批次新增）**：本表每条诉求都要看得见它在 `src/<层次>/<插件>/` 下的归属；**"实现载体"列写的是当前路径，本列写的是目标路径**（迁移见 `docs/work/plans/plugin-file-map.md`）；规则真源是 `docs/design/28-plugin-requirements-and-run.md` §1/§2.4.3（ADR-0021）。
- 证据列里的门名一律经 `tools/verify.sh <门名>` 跑（`ac <AC-ID>` 走 `tools/verify.sh ac <AC-ID>`）；本批原始输出在 `docs/work/evidence/EV-159-*.txt`。

## 1. 表

| 需求号 | 用户原话要点 | 实现载体（插件 / 模块 / 文件） | 插件归属（目标路径 `src/<层次>/<插件>/`） | 状态 | 证据（EV / 门 / 命令） |
|---|---|---|---|---|---|
| USREQ-001 | 「双方员工要不离开 APP 就能完成**每一步**工作（含写操作）」 | `host/modules/webui.mjs`（SSR 四道 + `<form>`）、`host/modules/config-view.mjs`、`host/modules/gate-timeline.mjs`（催办）、`host/modules/rfq-deadline.mjs`（承诺）、`host/modules/ui-feedback.mjs` | `system/webui`（写入口）+ `system/ui-feedback` + `domain/gate-timeline` + `domain/rfq-deadline` | partial | 门：`webui`（四道 0 行 `<script>` / 0 内联事件 + `<form method=get>` + 道内子导航）、`config-route`、`gates`、`rfq-deadline`、`ui-feedback`（现存**四类**写操作各 202 + 0600 待办件、宿主账本零新增）。**反证**：并发批次的逐步骤实测 11 步 **0 步**能推进流程（`docs/work/plans/ui-workflow-rework.md` §0）⇒ 「每一步」**未达成** |
| USREQ-002 | 「视觉不得像『上世纪的表单』，要像现代 app」 | `host/modules/webui.mjs`（页面模板与样式） | `system/webui`（视觉基线） | missing | **无证据**：`webui` 门的断言全是**结构**（0 内联脚本 / 三块 `data-block` 顺序 / `data-empty` / `applied` 回显），**没有任何**判据落在视觉上；也没有人工评审记录。视觉规格停在 `docs/work/plans/ui-workflow-rework-part3.md` §4（未实现） |
| USREQ-003 | 「模拟**真正的员工**（承包商采购员 / 供应商报价员），而非『上帝视角的检察员』」 | `host/profiles.mjs`（`contractor-ops`/`supplier-bid`/`relay`）、`src/quotagent/g1side.py`、`tools/g1-walkthrough.py` | `system/runtime`（两个 profile 的真实角色）+ `system/repo-gate`（走查证据） | partial | 门：`g1`（两个真进程 + 共享目录一轮走查 14 判据，退出 0）—— 只覆盖「两侧各自把工作流跑完」+ 私域互不可见。**反证**：同一次逐步骤实测里，两个角色的工作链分别 6 步 / 5 步**全部卡住**（`ui-workflow-rework.md` §0）⇒ 现在更像「能查信息的检察员」 |
| USREQ-004 | 「服务列表不堆链接；**projects & routes** 下要有项目路由入口；项目 webui 是**独立运行的 app**」 | 服务自述面 `host/modules/webui.mjs`（`GET /quotagent/api/routes`）；**跨仓**：`/workspace/services/services.json`（quotagent 服务 + gateway 路由）、`/workspace/services/dashboard/dashboard.py`（`collect_projects`）、`tools/webui-serve.py`（独立进程 + healthz，端口 8093） | `system/webui`（`/api/routes` 自述面）+ `system/runtime` | partial | 实跑（EV-159）：`curl 127.0.0.1:8090/api/status` → `projects[0] = {name: quotagent-webui, kind: webui-app, prefix: /quotagent, entry: /quotagent/, entry_source: service:/api/routes, healthy: true, ports: [8093], routes_source: service:/api/routes}`；`routes[2] = /quotagent → http://127.0.0.1:8093`；`curl 127.0.0.1:8081/quotagent/` → **200**（经 gateway 真到达）。门：`webui`（断言 webui 自述 `/api/routes`） |
| USREQ-005 | 「webui 的定位是**面向用户的 app**（一般用户不熟 CLI），不是一堆报告」 | `host/modules/webui.mjs`（`/quotagent/start/` 上手页 + 子导航 + 第一屏三块）、`host/modules/ui-feedback.mjs` | `system/webui` | partial | 门：`webui`（三块 `data-block` 顺序正确 + 8 个子视图 + `data-subnav` + 「上手」入口 + 空结果 `data-empty` 显式说明）、`ui-feedback`（反馈入口）。**缺口**：没有任何断言把「用户不需要 CLI」变成事实（现存写操作仍要把命令拿到别处执行） |
| USREQ-006 | 「cron **没待处理反馈时不得发垃圾消息**」 | `tools/ui-feedback-monitor.sh`（cron 的变化探测器）、`tools/ui-feedback-tick.sh`、`tools/ui-feedback-apply.py`、`host/modules/ui-feedback.mjs`；cron job `quotagent-ui-feedback-loop`（`/opt/data/cron/jobs.json`，仓库外） | `system/ui-feedback` | partial | 机检：`qa ac AC-USREQ-006` **10/10**（同状态两次运行 + 换 TZ 逐字节一致；无时间/随机源；空待办**恰一行** `pending=0`；真造 2 条待办 ⇒ `pending=2` + ids（非空转）；tick 静默半边结构断言）。**负控**：给探测器加一行 `date` ⇒ ③④ 断言红、退出码 1；还原后 sha256 一致。**缺口**：调度器「真的跳过」在仓库外；tick 的静默只有结构断言 |
| USREQ-007 | 「需求必须**持久化进合同文档**（不是『记住』）」 | `docs/work/functional-requirements.md` §6.1（`FR-USREQ-001..012`）、本表、`docs/work/functional-requirements-archive-b.md`（本批归档） | `system/repo-gate` | done | 门：`docs`（ID 完整性 / 预算 / FR↔AC 无孤儿；`fr_archives` 列到两份归档）、`coverage`（每条 FR 在矩阵里有一行、双向无伪造）、`ac-registry`（P0 AC 全注册）。EV-159 记下前后字节与提交 SHA |
| USREQ-008 | 「UI 上必须看得到：**插件市场、agent panel、可交互业务逻辑插件、自进化**」 | `host/modules/plugin-market.mjs`（市场）、`host/modules/admin-view.mjs` + `admin-guard.mjs`（agent 进度/阻塞面板）、`host/modules/gate-timeline.mjs`/`authority-band.mjs`/`rfq-deadline.mjs`/`bid-heuristics.mjs`/`advice-panel.mjs`（业务插件页）、`host/modules/evolve-journal.mjs` + `/api/ops`（自进化） | `system/market` + `system/admin` + `system/evolution` + 各业务插件页 | partial | 门：`plugin-market`、`admin-route`、`gates`、`authority`、`rfq-deadline`、`webui`（`/api/ops` 的 `evolve_journal` 计数与账本一致）。**缺口**：四类**没有**同一屏的汇总入口判据（现分散在各道）；市场与自进化在页面上的可达性也没有单独断言 |
| USREQ-009 | 「插件一律由插件提供（含需凭据的邮件插件）；插件配置要能 **UI 更改 + 持久化 + 配置文件（YAML）初始化**」 | `host/modules/config-view.mjs`、`host/lib/config-ui.mjs`、`host/lib/config-keys.mjs`、`tools/config-apply.py`（唯一落盘者：原子写 + `--init`）、`host/modules/mail-view.mjs`、`src/quotagent/services/mail_transport.py` | `system/config` + `system/mail` | done | 门：`config-route`（`AC-CONFIG-001`：11 条路径未提权 401 同形、干跑零落盘、保存只落 0600 待办件、`--init` 生成 YAML、真 `config.yaml` 指纹前后不变）、`mail-transport`（27 条，含回环真假收发）、`mail`（`AC-MAIL-002`）。**残余（非阻塞）**：白名单**之外**的键没有「配置面」断言 |
| USREQ-010 | 「每个功能模块可**独立演进**（自进化）；cordis 能做的直接用 cordis 最新版，不重造轮子」 | `host/lib/evolution.mjs`（提案/影子/门/晋升/回滚）、`host/evolution.mjs`、`host/modules/canary.mjs`、`host/lib/user-space.mjs`、`host/package.json`（cordis `4.0.0-rc.10`，ADR-0012） | `system/evolution` + `system/repo-gate`（cordis 反向判据） | partial | 门：`evolution`、`cordis`（五模式/effect/重载冒烟）、`modules`、`user-space`（`AC-USERPLUG-003/004` 独立重载与零残留）、`bridge-canary`。**缺口**：「cordis 已提供而我方重造」的反向判据（需一份能力对照表） |
| USREQ-011 | 「webui 可从 dashboard 访问；**不同 routes 提供双方各自视角**，而不是只有一条 route」 | `host/modules/webui.mjs`（`/contractor/`、`/supplier/`、`/ops/`、`/admin/` 四道 + `/api/routes` 自述）、`/workspace/services/services.json`（`/quotagent` 路由，跨仓） | `system/webui` | partial | 门：`webui`（**双方视角各自可达且是不同路由** + 两视角事件集合不同 + 私域负控）、`admin-route`；实跑（EV-159）：`curl 127.0.0.1:8093/quotagent/api/routes` → `service=quotagent-webui, route_prefix=/quotagent, views=[contractor, supplier]`；`curl 127.0.0.1:8081/quotagent/` → 200 |
| USREQ-012 | 「AI agent 的决策建议」由 subagent 模拟双方交互需求并做成**系统级插件供应** | `host/modules/advice-panel.mjs`（`FR-ADV-001`，围栏门 30/30 + 真路由门 14/14）、`tools/userplugin-elevate.py`（提权：人类 actor + `ap-NNNN` 人工门 + 影子哈希一致）、`tools/userplugin-record.py` | `domain/advice` + `system/user-plugin-manager`（提权路径） | partial | 门：`advice`（`AC-ADV-001`）、`user-space`（`AC-USERPLUG-010` 提权需人类门、陈旧/被改载荷拒绝、不覆盖已存在目标）。**缺口**：「建议 → 动作」一键闭环（现在仍要把命令复制到别处执行） |

## 2. 缺口清单（为什么不是 done；以及**缺什么才能机检**）

| 需求号 | 缺什么才能机检 | 计划 / 关联 |
|---|---|---|
| USREQ-001 | 一张「步骤 → 路由 → 动作」登记表（每侧员工的每一步一行），门才能断言「每一步都有 ≥1 落点」 | 工作流规格 `docs/work/plans/ui-workflow-rework.md` §2/§3 + `-part2.md` §3 |
| USREQ-002 | 可机检视觉基线（design token / 组件清单 + 每页 `data-*` 断言）**或**人工评审记录（V 记录 + 签署人） | 视觉规格 `docs/work/plans/ui-workflow-rework-part3.md` §4 |
| USREQ-003 | 每侧「员工的一天」任务清单（步骤 + 产物 + 每步的写操作），门按清单逐条断言 | 同上 §3 |
| USREQ-004 | 跨仓机检：dashboard 的 projects & routes 区**必须**含 `quotagent` 入口（工作区仓库的测试不在本仓门内） | `/workspace/services/dashboard/tests/`（跨仓） |
| USREQ-005 | 「用户不需要 CLI」的端到端机检（例如：每个写操作的 202 待办件都被某条已登记流程消费并可回读） | 工作流规格 §3 |
| USREQ-006 | 调度器侧的「输出相同 ⇒ 跳过、不发消息」证据（`/opt/data/cron/jobs.json` 在仓库外）；tick 的静默半边目前只有结构断言 | 部署手册 §cron（本批已补写） |
| USREQ-008 | 四类（市场 / agent panel / 业务插件 / 自进化）同一屏的汇总入口判据 + 市场/自进化页面可达性的单独断言 | `host/modules/webui.mjs`（汇总入口）+ 相应门 |
| USREQ-010 | 一张「cordis 已提供的能力 vs 我方自写」对照表，门负责断言「不重造」（对照表不存在 ⇒ 无法机检） | `docs/design/13-cordis-bridge.md`（可选扩展点） |
| USREQ-011 | 从 dashboard 点进 `/quotagent` 的跨仓端到端机检 | 同 USREQ-004 |
| USREQ-012 | 「建议 → 动作」的一键闭环机检（建议条目自带可执行的**仓内**落点路由，而不是给人复制的命令） | `FR-ADV-001` 的后续批次 |

## 3. 状态计数（本批）

| 状态 | 条数 | 需求号 |
|---|---|---|
| done | 2 | USREQ-007、USREQ-009 |
| partial | 9 | USREQ-001、USREQ-003、USREQ-004、USREQ-005、USREQ-006、USREQ-008、USREQ-010、USREQ-011、USREQ-012 |
| missing | 1 | USREQ-002 |
| 合计 | 12 | — |

## 4. 与其它文档的关系

- 契约（FR 文本、优先级、阶段、关联 AC）：`functional-requirements.md` §6.1；本批归档（46 行逐字搬走）在 `functional-requirements-archive-b.md`。
- 覆盖矩阵（每条 FR 的承载体与状态）：`../design/15-requirements-coverage.md` §1/§3。
- 任务与进度：`progress-checklist.md`（本批 = `T-311`）；原始命令输出：`evidence/EV-159-*.txt`。
- 并发批次的实测规格（未实现，但给出了「每一步」的缺口清单与视觉规格）：`plans/ui-workflow-rework.md` + `-part2.md` + `-part3.md`。
