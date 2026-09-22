# system/user-plugin-manager 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：27 §2.1 的标准形态是 `src/system/user-plugin-manager/requirements/README.md`；本插件**尚无插件目录**
> （迁移计划阶段 2–4 才建），本批（`T-318`）按 27 §2.4 的口径把文档落在 `docs/work/plugin-requirements-system-user-plugin-manager.md`
> （内容与标准形态**同形**），位置偏差逐条登记在映射表 §4.2；建目录（`plugin.json` + `code/`）时 `git mv` 进 `requirements/README.md`。
> **不先建裸目录**的理由（实测，非推测）：`plugin-registry` 的 `depsClosure` 把「目录存在」当「插件存在」，
> 先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红（27 §2.4）。

## 用途（一句话）

用户空间插件的管理面（本身也是插件）：list/load/unload/reload/requestCreate/elevateRequest，隔离四件套由用户空间库落实。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-USERPLUG-001` | tools/userplugin-record.py + host/lib/user-space.mjs（scan/列表） | `AC-USERPLUG-001` | `tools/verify.sh ac AC-USERPLUG-001` |
| `FR-USERPLUG-002` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-002`、`AC-USERPLUG-012` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-003` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-003` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-004` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-004` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-005` | tools/userplugin-record.py + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-005` | `tools/verify.sh ac AC-USERPLUG-005` |
| `FR-USERPLUG-006` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-006` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-007` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-007` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-008` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-008` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-009` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-009` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-010` | tools/userplugin-elevate.py + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-010` | `tools/verify.sh ac AC-USERPLUG-010` |
| `FR-USERPLUG-011` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-011` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |
| `FR-USERPLUG-012` | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | `AC-USERPLUG-012` | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `userPluginManager`（`host/modules/user-plugin-manager.mjs`）+ `host/lib/user-space.mjs`；落账本侧 `tools/userplugin-{record,elevate}.py`。 |
| 依赖（实测 import 目标） | `host/modules/user-plugin-manager.mjs` → `../lib/std-schema.mjs`、`../lib/user-space.mjs`；`tools/userplugin-record.py` → `quotagent.kernel.ledger`；`tools/userplugin-elevate.py` → `quotagent.kernel.ledger`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh user-space` · `tools/verify.sh plugin-lifecycle` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `host/lib/user-space.mjs`、`host/modules/user-plugin-manager.mjs`、`tools/userplugin-{record,elevate}.py` |
| 证据（映射表 §1） | `user-space`(AC-USERPLUG-001..012) · `plugin-lifecycle` · `EV-082` |
| 缺口 | 名下 9 条 FR（`FR-USERPLUG-002`、`FR-USERPLUG-003`、`FR-USERPLUG-004`、`FR-USERPLUG-006`、`FR-USERPLUG-007`、`FR-USERPLUG-008`、`FR-USERPLUG-009`、`FR-USERPLUG-011`、`FR-USERPLUG-012`）的关联 AC 尚未在 `qa` 注册（`tools/verify.sh ac-registry`：P2 未到期）⇒ 这几条现由本插件的门 `tools/verify.sh user-space`、`tools/verify.sh plugin-lifecycle` 围栏。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-user-plugin-manager.md` ⇒ 已登记在映射表 §4.2 |
