# system/admin 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：27 §2.1 的标准形态是 `src/system/admin/requirements/README.md`；本插件**尚无插件目录**
> （迁移计划阶段 2–4 才建），本批（`T-318`）按 27 §2.4 的口径把文档落在 `docs/work/plugin-requirements-system-admin.md`
> （内容与标准形态**同形**），位置偏差逐条登记在映射表 §4.2；建目录（`plugin.json` + `code/`）时 `git mv` 进 `requirements/README.md`。
> **不先建裸目录**的理由（实测，非推测）：`plugin-registry` 的 `depsClosure` 把「目录存在」当「插件存在」，
> 先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红（27 §2.4）。

## 用途（一句话）

系统管理道：门卫（token/会话/有界冷却）+ 只读面板（阻塞与进度）+ 阻塞真源与解阻塞消费侧。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-ADMIN-001` | host/modules/admin-view.mjs | `AC-ADMIN-001` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-ADMIN-002` | host/modules/admin-guard.mjs | `AC-ADMIN-002` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-ADMIN-003` | host/modules/admin-view.mjs | `AC-ADMIN-003` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-ADMIN-004` | src/quotagent/services/admin_blocks.py | `AC-ADMIN-004` | `tools/verify.sh ac AC-ADMIN-004` |
| `FR-ADMIN-005` | tools/admin-apply.py（唯一写账本的一方）+ host/modules/webui.mjs（提交面，只落待处理项） | `AC-ADMIN-005` | `tools/verify.sh ac AC-ADMIN-005` |
| `FR-ADMIN-006` | src/quotagent/services/admin_blocks.py | `AC-ADMIN-006` | `tools/verify.sh ac AC-ADMIN-006` |
| `FR-ADMIN-007` | host/modules/admin-guard.mjs | `AC-ADMIN-007` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-ADMIN-008` | host/modules/admin-guard.mjs | `AC-ADMIN-008` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-ADMIN-009` | host/modules/admin-guard.mjs | `AC-ADMIN-009` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-ADMIN-010` | host/modules/admin-guard.mjs | `AC-ADMIN-010` | `tools/verify.sh admin-route` · `tools/verify.sh webui`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `adminGuard`、`adminView`（`host/modules/admin-{guard,view}.mjs`）；Python 侧 `services/admin_blocks.py` + `tools/admin-apply.py`、`tools/refresh-admin-snapshot.py`。 |
| 依赖（实测 import 目标） | `host/modules/admin-guard.mjs` → `../lib/std-schema.mjs`；`host/modules/admin-view.mjs` → `../lib/std-schema.mjs`；`src/quotagent/services/admin_blocks.py` → `..kernel.canon`；`tools/admin-apply.py` → `quotagent.kernel.ledger`、`quotagent.services.admin_blocks`；`tools/refresh-admin-snapshot.py` → `quotagent.services.admin_blocks`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh admin-route` · `tools/verify.sh webui` · `tools/verify.sh ac AC-ADMIN-005` · `tools/verify.sh ac AC-ADMIN-006` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `host/modules/{admin-guard,admin-view}.mjs`、`src/quotagent/services/admin_blocks.py`、`tools/{admin-apply,refresh-admin-snapshot}.py` |
| 证据（映射表 §1） | `admin-route` · `webui`(51/51) · `ac AC-ADMIN-005/006` · `EV-085` |
| 缺口 | 名下 7 条 FR（`FR-ADMIN-001`、`FR-ADMIN-002`、`FR-ADMIN-003`、`FR-ADMIN-007`、`FR-ADMIN-008`、`FR-ADMIN-009`、`FR-ADMIN-010`）的关联 AC 尚未在 `qa` 注册（`tools/verify.sh ac-registry`：P2 未到期）⇒ 这几条现由本插件的门 `tools/verify.sh admin-route`、`tools/verify.sh webui` 围栏。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-admin.md` ⇒ 已登记在映射表 §4.2 |
