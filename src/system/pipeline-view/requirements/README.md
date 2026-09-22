# system/pipeline-view 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/pipeline-view/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-pipeline-view.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

三域运维快照的只读聚合：谈判/FAQ/邮件计数与最近事件（只组合不自算、降级优先、有界、确定性）。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-UX-005` | tools/refresh-ui-snapshots.py、host/modules/pipeline-view.mjs | `AC-UI-002`、`AC-UI-003` | `tools/verify.sh ac AC-UI-002` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `pipelineView`（`host/modules/pipeline-view.mjs`）+ 快照写入器 `tools/refresh-ui-snapshots.py`。 |
| 依赖（实测 import 目标） | `host/modules/pipeline-view.mjs` → `../lib/std-schema.mjs`；`tools/refresh-ui-snapshots.py` → `quotagent.kernel.ledger`、`quotagent.services.faq`、`quotagent.services.mail`、`quotagent.services.mail_transport`、`quotagent.services.negotiation`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh pipeline-view` · `tools/verify.sh pipeline-route` · `tools/verify.sh ac AC-UI-002`；另：`AC-UI-003`（尚未在 `qa` 注册 ⇒ 该 AC 的命令此刻不可跑） |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `host/modules/pipeline-view.mjs`、`tools/refresh-ui-snapshots.py` |
| 证据（映射表 §1） | `pipeline-view`(7/7) · `pipeline-route` · `ac AC-UI-002/003` |
| 缺口 | 无登记缺口（映射表 §1 与该插件名下 FR 的 AC 均已注册）。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-pipeline-view.md` ⇒ 已登记在映射表 §4.2 |
