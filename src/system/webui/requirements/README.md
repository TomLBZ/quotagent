# system/webui 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/webui/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-webui.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

双方（承包商 / 供应商）的**完整 GUI 应用** —— 一个可长期使用的应用外壳（多视图 + 导航 + 命令面板 +
通知 + 快捷键 + 深链），**功能由插件注册进来**（插件提交自己的**视图/区块、交互方式、动作与命令、
业务逻辑钩子、通知与状态**），WebUI 自身**不含业务语义与插件名**。
**判定标准：双方仅通过 GUI 就能走完全部业务流程（含写操作），不需要回终端。**
口径真源：`docs/design/29-webui-gui-app.md`（与 `27-plugin-architecture.md` §6 同源；冲突以 29 为准）。
**旧口径已废止**（"把账本投影装配成人能用的页面与只读路由"、三块第一屏 + 0 JS、UI 快照 hash）：见 29 §2。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-UXWEB-001 | 完整 GUI 应用外壳（多视图/导航/命令面板/通知/快捷键/深链）+ 注册面（视图·区块 / 交互方式 / 动作与命令 / 业务逻辑钩子 / 通知与状态） | **待实现**（P0：`docs/design/29-webui-gui-app.md` §5） |
| FR-UXWEB-002 | 双方流程逐条可在 GUI 内闭环（29 §4；动作真落账本或 0600 待办件） | **待实现**（P0：同上） |
| FR-PLUGIN-005 | 插件向 WebUI 的**注入式注册面**提交区块/路由声明；WebUI 只做机制 | `tools/verify.sh plugin-lifecycle` |
| FR-USREQ-001 | 「每一步都能在 APP 内闭环（含写操作）」的**写入口** | `tools/verify.sh webui` · `config-route` · `gates` · `rfq-deadline` · `ui-feedback` |
| FR-USREQ-002 | 视觉基线（「像现代 app」） | **暂无机检**（矩阵 §3 登记为缺口；旧结构锚点判据已按 29 §2 删除） |
| FR-USREQ-004 | 服务自述面 `GET /quotagent/api/routes`（projects & routes 的仓内一半） | `tools/verify.sh webui` |
| FR-USREQ-005 | 面向用户的 app 定位（三块 + 子视图 + 「上手」入口），不是一堆报告 | `tools/verify.sh webui` |
| FR-USREQ-011 | 双方各自视角是**不同路由**，不是一条 route | `tools/verify.sh webui` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `webui`（**完整 GUI 应用**外壳 + 注册面；口径真源 `docs/design/29-webui-gui-app.md`）、`uiSlots`（注入式 UI 槽位服务：`nav.*`/`page.*`/`api.*`/`admin.*`） |
| 依赖 | `host/lib/ledger-view.mjs`（只读账本视图）、`host/lib/ui-slot.mjs`（机制，0 插件 id / 0 业务名词） |
| 写面 | 零写面：不写账本、不写文件（提交类动作只落 0600 待办件，落账本由 Python 侧唯一写者做） |
| 门 | `tools/verify.sh webui`（51/51）· `plugin-lifecycle`（注册面 C/D 组）· `run-once`（一键起服务 + `/healthz`） |
| 路由登记 | 新增路由必须在 `GET /api/routes` 里登记，且只读路由收到非 GET ⇒ 405 + `Allow: GET`（`FR-QUOTE-001` 批次加的机检） |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 业务语义、插件 id、字段白名单 | 各业务插件（注册面向 webui 提交自己的区块/路由）；白名单与私域过滤归 `system/projection` |
| 人工门队列视图的数据 | `system/approval`（`FR-UX-001`）；本插件只装配页面 |
| 变更单明细与催办动作 | `domain/gate-timeline`（`FR-GATE-001/002`） |
| 邮件域运维视图 | `system/mail`（`FR-MAIL-002`） |
| 视觉基线判据 | 待建（矩阵 §3 的 `FR-USREQ-002` 缺口；规格 `docs/work/plans/ui-workflow-rework-part3.md` §4） |

## 落地状态（`code/`）

<!-- 本批 `EV-181` 接上 `entry`；决策与被否决的选项见 `docs/work/decisions.md` D-078。 -->

- `code:` **已接入口** —— 实体 `webui.mjs`（`provides=['webui','uiSlots']`）与机制件 `ui-route.mjs`/`ui-slot.mjs` 都在 `code/`；
  `entry` = `code/index.mjs`（只重导出实体，零业务语义零写面）⇒ `tools/plugin.sh list` 报 `valid:true`，**不再是** `degraded: artifact-missing`。
- `provides` 由占位键 `['webui']` 改写为**实体自述的真实服务键** `['webui','uiSlots']`（`uiSlots` = 注入式 UI 的注册面，机制、0 语义）。
- 真装载：`tools/plugin.sh load system/webui` ⇒ `ok:true`、`kind=esm`、`provides=['webui','uiSlots']`、卸载后 effects 归零；
  该实体 `inject` 列出 25 个同位插件服务键，运行期在缺少这些服务时 fiber 停在 `PENDING`（**「未就绪 ⇒ 非激活，不是崩」**，不是失败）。
- 连带改动（必须）：`plugin-lifecycle` 的 A13/A14 原以「真根上 `system/webui` 未迁移」为锚点 ⇒ 本批改指**对照根**
  （真 id + 真清单字节 + 入口文件缺失）并在真根补正控；断言只增不减（见 D-078 与 `docs/work/evidence/EV-181-*`）。
