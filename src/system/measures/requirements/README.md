# system/measures 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/measures/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-measures.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

口径数据层（P2 计量口径的事实数据），不是插件功能面：被各口径 AC 间接覆盖，无 FR 归属。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| —（无 FR 归属） | — | — | —（见「现状与缺口」） |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | Python 侧 `services/measures.py`（口径数据层），被 `kernel-bridge` 与多个服务 import。 |
| 依赖（实测 import 目标） | 无跨插件 `code/` import（27 §5.2；承载文件只 import 标准库/共享库，实测无外部 import 目标）。 |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh ac AC-NORM-001` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `missing` |
| 承载体（映射表 §1） | `src/quotagent/services/measures.py`（口径数据层） |
| 证据（映射表 §1） | **无 FR 归属**（矩阵 §2 亦无归属行）；被各口径 AC 间接覆盖 · `ac AC-NORM-001` |
| 缺口 | **无 FR 归属**（映射表 §1 与 `15` §2 均无归属行）⇒ 满足「每条 FR 有承接插件」但不反过来：本插件是承载体的执行件，不是功能需求的归属方。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-measures.md` ⇒ 已登记在映射表 §4.2 |

## 落地状态（`code/`）

<!-- 本行由批 `EV-176` 逐插件如实登记（机检口径见 `docs/work/plans/plugin-file-map.md` §分类）。 -->

- `code:` 部分落地 —— Python 实体 1 个已在 `code/`（`measures.py`）；宿主 **ESM 入口未接** ⇒ `entry` 仍如实报 `degraded: artifact-missing`。
