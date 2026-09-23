# system/user-plugin-manager 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/user-plugin-manager/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-user-plugin-manager.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

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
| 写面 | `plugin.json.permissions = {ledger: "sole-writer", writes: ["own-dir", "request-file"]}`：账本侧**只有本插件写** `userplugin/*` 这一族事件（唯一写者 `tools/userplugin-record.py` 与 `tools/userplugin-elevate.py`，经内核 `kernel.ledger` 的 H1 写路径）；请求由宿主落 0600 待办件（`request-file`）后由这两个写者消费；正文不进账本。 |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `host/lib/user-space.mjs`、`host/modules/user-plugin-manager.mjs`、`tools/userplugin-{record,elevate}.py` |
| 证据（映射表 §1） | `user-space`(AC-USERPLUG-001..012) · `plugin-lifecycle` · `EV-082` |
| 缺口 | 名下 9 条 FR（`FR-USERPLUG-002`、`FR-USERPLUG-003`、`FR-USERPLUG-004`、`FR-USERPLUG-006`、`FR-USERPLUG-007`、`FR-USERPLUG-008`、`FR-USERPLUG-009`、`FR-USERPLUG-011`、`FR-USERPLUG-012`）的关联 AC 尚未在 `qa` 注册（`tools/verify.sh ac-registry`：P2 未到期）⇒ 这几条现由本插件的门 `tools/verify.sh user-space`、`tools/verify.sh plugin-lifecycle` 围栏。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-user-plugin-manager.md` ⇒ 已登记在映射表 §4.2 |

## 落地状态（`code/`）

<!-- 本行由批 `EV-176` 登记：入口 + 实体都在本插件 `code/` 下，`plugin.json` 的 `entry` = `code/index.mjs`。 -->

- `code:` **已落地** —— 实体 `code/user-plugin-manager.mjs`（本批随宿主模块搬迁进 `code/`）+ 入口 `code/index.mjs`（只把实体公开面**重导出**：`export *` 的绑定是活的，无业务语义、无写面）。
- `provides:` `userPluginManager`（实体自述的真实服务键；占位键已改写）。
- 实测：`tools/plugin.sh status system/user-plugin-manager` ⇒ `valid:true`、`reason:null`；`load` 真进口（`effects` 非 0）、`unload` 后 `effects_after:0`。
