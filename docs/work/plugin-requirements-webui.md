# system/webui 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：27 §2.1 的标准形态是 `src/<层>/<插件>/requirements/README.md`。本插件**尚无插件目录**
> （迁移计划阶段 2–4 才建），而**先建裸目录**会让 `plugin-lifecycle` 门的两条断言变红 —— 该门的 A13/A14 断言
> "`domain/advice` 的依赖 `system/webui` 未就绪 ⇒ 非激活"，而 `plugin-registry` 的 `depsClosure` 把"目录存在"当作"插件存在"
> （与 27 §3.3"没有 `plugin.json` 的目录不是插件"存在口径差）。本仓铁律是**不得把门改松**，所以本批把这份文档落在
> `docs/work/plugin-requirements-<插件>.md`（内容与标准形态**同形**），待迁移阶段建目录（`plugin.json` + `code/`）时 `git mv` 进 `requirements/README.md`。

## 用途（一句话）

双方视角 WebUI：把账本投影装配成人能用的页面与只读路由，并**只提供注册面**（槽位/排序/静态资源前缀），
不含任何业务语义与插件名（`docs/design/27-plugin-architecture.md` §6）。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-UXWEB-001 | 四道（contractor/supplier/ops/admin）第一屏固定三块，动作是可点的表单或链接，页面 0 内联脚本 | `tools/verify.sh webui` |
| FR-UXWEB-002 | 子视图与真交互（筛选/排序/翻页；越界夹取并回显 `applied`；空结果显式说明） | `tools/verify.sh webui` |
| FR-PLUGIN-005 | 插件向 WebUI 的**注入式注册面**提交区块/路由声明；WebUI 只做机制 | `tools/verify.sh plugin-lifecycle` |
| FR-USREQ-001 | 「每一步都能在 APP 内闭环（含写操作）」的**写入口** | `tools/verify.sh webui` · `config-route` · `gates` · `rfq-deadline` · `ui-feedback` |
| FR-USREQ-002 | 视觉基线（「像现代 app」） | **暂无机检**（矩阵 §3 登记为缺口；只有结构切片：0 内联脚本 / 三块顺序） |
| FR-USREQ-004 | 服务自述面 `GET /quotagent/api/routes`（projects & routes 的仓内一半） | `tools/verify.sh webui` |
| FR-USREQ-005 | 面向用户的 app 定位（三块 + 子视图 + 「上手」入口），不是一堆报告 | `tools/verify.sh webui` |
| FR-USREQ-011 | 双方各自视角是**不同路由**，不是一条 route | `tools/verify.sh webui` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `webui`（页面与只读路由装配）、`uiSlots`（注入式 UI 槽位服务：`nav.*`/`page.*`/`api.*`/`admin.*`） |
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
