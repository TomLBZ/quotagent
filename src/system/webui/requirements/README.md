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
**旧口径与旧判据已按 29 §2 整体删除、不留副本**（本文件不再复述它们）：判据一律见 29 §1/§4。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-UXWEB-001 | 完整 GUI 应用外壳（多视图/导航/命令面板/通知/快捷键/深链）+ 注册面（视图·区块 / 交互方式 / 动作与命令 / 业务逻辑钩子 / 通知与状态） | **待实现**（P0：`docs/design/29-webui-gui-app.md` §5） |
| FR-UXWEB-002 | 双方流程逐条可在 GUI 内闭环（29 §4；动作真落账本或 0600 待办件） | **待实现**（P0：同上） |
| FR-PLUGIN-005 | 插件向 WebUI 的**注入式注册面**提交区块/路由声明；WebUI 只做机制 | `tools/verify.sh plugin-lifecycle` |
| FR-USREQ-001 | 「每一步都能在 APP 内闭环（含写操作）」的**写入口** | `tools/verify.sh webui` · `config-route` · `gates` · `rfq-deadline` · `ui-feedback` |
| FR-USREQ-002 | 视觉基线（「像现代 app」） | **暂无机检**（矩阵 §3 登记为缺口；旧结构锚点判据已按 29 §2 删除） |
| FR-USREQ-004 | 服务自述面 `GET /quotagent/api/routes`（projects & routes 的仓内一半） | `tools/verify.sh webui` |
| FR-USREQ-005 | 面向用户的 app 定位（GUI 应用外壳：视图/面板/动作 + 「上手」入口），不是一堆报告 | `tools/verify.sh webui` |
| FR-USREQ-011 | 双方各自视角是**不同路由**，不是一条 route | `tools/verify.sh webui` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `webui`（**完整 GUI 应用**外壳 + 注册面；口径真源 `docs/design/29-webui-gui-app.md`）、`uiSlots`（注入式 UI 槽位服务：`nav.*`/`page.*`/`api.*`/`admin.*`） |
| 依赖 | `host/lib/ledger-view.mjs`（只读账本视图）、`host/lib/ui-slot.mjs`（机制，0 插件 id / 0 业务名词） |
| 写面 | 零写面：不写账本、不写文件（提交类动作只落 0600 待办件，落账本由 Python 侧唯一写者做） |
| 门 | `tools/verify.sh webui`（51/51）· `plugin-lifecycle`（注册面 C/D 组）· `run-once`（一键起服务 + `/healthz`） |
| 路由登记 | 新增路由必须在 `GET /api/routes` 里登记，且只读路由收到非 GET ⇒ 405 + `Allow: GET`（`FR-QUOTE-001` 批次加的机检） |

## 身份与会话 + 三个自助面（`DEF-001/003/025/026`；承载 `FR-UXWEB-001/002`、`FR-USREQ-001` 的这部分）

| 面 | 实现 | 可执行验收命令 |
|---|---|---|
| 会话（登录/切换/登出；**不是**每动作手填名字） | `code/identity.mjs`（服务端会话 0600 + 不透明 cookie） | `bash tmp/verify-identity/run-server.sh && python3 tmp/verify-identity.py` |
| 人签只能本人签（署名 == 会话身份；别人的草稿不可替你签） | `tools/identity-sign.py` → `quote-sign.py`；`tools/identity-confirm.py` → `commitment-apply.py --step confirm` | 同上（`signer-mismatch` / `not-my-draft` / `not-my-quote` 三条负控 + 账本零新增断言） |
| 「待我处理」（待签报价/待批准/待确认中标/待回澄清/超期未回；只列本人或本侧） | `code/identity.mjs` 的 `workbench()`（只读本侧账本 + 本侧 0600 待办件；`as_of` = 事实时刻） | 同上（换人/换侧列表变化 + 越侧 `side-mismatch` + 新门只出现在该侧） |
| `DEF-025` 邮件/SMTP 配置可改可持久化（不必提权） | `tools/identity-mail-apply.py` → `config-apply.py`（唯一落盘者） | 同上（ops 侧可改、落 YAML、凭据不回显、业务身份 `/admin/config/` 仍 401） |
| `DEF-026` 自助装卸**自己的**用户空间插件 | `code/identity.mjs` → `userPluginManager`（跨命名空间 `not-my-namespace`） | 同上（装载/卸载真变化 + 跨 ns 拒） |

## 人员名册与角色（`P5` 批次；承载 `FR-UXWEB-001/002`、`FR-USREQ-001` 的这部分）

| 面 | 实现 | 可执行验收命令 |
|---|---|---|
| **「同事」= 名册里的人**（不是「登录过的人」）：同侧成员 / 角色（可加可改）/ 直属关系 | `code/people.mjs`（`<ui_shared>/people/roster.json`，0700/**0600**、原子写、按侧隔离；**不进账本**，理由在文件头） | `python3 tmp/p5-people-verify.py`（2.x：名册可读 / 按侧隔离 / 未登录 401 / 0600） |
| 名册/角色/直属/策略**在界面上可维护**（零终端） | `code/people-ui.mjs`（面板「人员名册与角色」+「名册表（逐行可改）」+ 动作 `people.member-add`/`member-save`/`member-remove`/`role-set`/`role-remove`/`policy-set`；本侧无管理员时 bootstrap，有管理员后只有管理员能改 ⇒ `admin-required`） | 同上（3.x：角色配置/新建角色/环拒/role-in-use/跨侧写拒） |
| `@提及`/指派/转交**从名册取值**（带自动补全；未知名字如实拒） | `collab.mjs#colleagues` 取 `people.members(side)`；`GET /api/people/suggest`（补全的服务端一半）+ 字段声明 `suggest_url`/`mention_suggest_url`（`ui-surface.mjs`）⇒ 客户端 `datalist` / 正文打 `@` 弹候选（`assets/app.js`） | 同上（4.x：候选==名册 / 不含异侧 / `unknown-colleague` / `unresolved` / `cross-side-mentioned`） |
| **按角色限动作**（不是限视图）：转交别人的活、超额批准 | `collab.mjs#assign`（`transfer-not-yours`：只有归我/我指派的或在 `policy.transfer.override_roles` 里）+ `people.mjs#guardAction`（额度规则读**事实**，`role-limit-exceeded` + 该找哪个角色）—— 都在动作的服务端一半**之前**否决（**账本与待办件零新增**） | 同上（5.x/6.x：越权转交/超额批准/额度可配、**账本 md5 与行数不变**） |
| **角色不改变签署权** | 额度/角色判据在 `/api/action/<id>` 的「署名 == 会话身份」之后（`webui.mjs` + `app-shell.mjs#runAction`）：只能否决、不能放开 | 同上（6.7/6.8：`403 signer-mismatch` / 未登录 401，账本零新增） |
| 通知偏好 / 已读 / **布局** / 筛选**整份服务端化**（按身份，跨设备仍在） | `webui.mjs` 的 `/api/ui/notif-state`（`<ui_shared>/webui/notif-state.json`，0700/**0600**、有界、洗净 + `dropped`）+ `assets/app.js` 的 load/push（localStorage 降为离线镜像） | 同上（8.x：换浏览器读回同一份 / 按身份隔离 / 未登录 401 / 洗净计数 / 0600） |
| 只读路由的**方法围栏**（405 + `Allow: GET`，先判方法再判身份） | `webui.mjs` 的 `GET_ONLY_PATTERNS`（含 `/api/collab/{hub,object,store}`、`/api/people/{roster,suggest,store}`） | `tools/verify.sh quote-draft`（第 ③ 条：`/api/routes` 里 81 条只读路由逐条 POST，反向对照 28 条写路由不误报） |

用法、配置与边界：`docs/people-and-roles.md`（本插件内）；口径真源 `docs/design/29-webui-gui-app.md` §8/§9。

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
