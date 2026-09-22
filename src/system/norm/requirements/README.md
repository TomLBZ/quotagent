# system/norm 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/norm/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-norm.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

单位/口径归一化：在边界把量纲与口径归一，决策层不再各自换算；宿主与 Python 两侧同一口径。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-NORM-001` | src/quotagent/services/norm.py | `AC-NORM-001` | `tools/verify.sh ac AC-NORM-001` |
| `FR-NORM-002` | src/quotagent/services/norm.py | `AC-NORM-002` | `tools/verify.sh ac AC-NORM-002` |
| `FR-NORM-003` | src/quotagent/services/norm.py | `AC-NORM-003` | `tools/verify.sh ac AC-NORM-003` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `norm`（`host/modules/norm.mjs`）；Python 侧 `services/norm.py`。 |
| 依赖（实测 import 目标） | `src/quotagent/services/norm.py` → `..kernel.canon`、`..kernel.events`、`..kernel.ledger`、`.measures`；`host/modules/norm.mjs` → `../lib/std-schema.mjs`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh modules` · `tools/verify.sh ac AC-NORM-001` · `tools/verify.sh ac AC-NORM-002` · `tools/verify.sh ac AC-NORM-003` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `src/quotagent/services/norm.py`、`host/modules/norm.mjs` |
| 证据（映射表 §1） | `modules`(fixture 521/521) · `ac AC-NORM-001/002/003` |
| 缺口 | 无登记缺口（映射表 §1 与该插件名下 FR 的 AC 均已注册）。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-norm.md` ⇒ 已登记在映射表 §4.2 |

## 落地状态（`code/`）

<!-- 本行由批 `EV-176` 登记：入口 + 实体都在本插件 `code/` 下，`plugin.json` 的 `entry` = `code/index.mjs`。 -->

- `code:` **已落地** —— 实体 `code/norm.mjs`（本批随宿主模块搬迁进 `code/`）+ 入口 `code/index.mjs`（只把实体公开面**重导出**：`export *` 的绑定是活的，无业务语义、无写面）。
- `provides:` `norm`（实体自述的真实服务键；占位键已改写）。
- 实测：`tools/plugin.sh status system/norm` ⇒ `valid:true`、`reason:null`；`load` 真进口（`effects` 非 0）、`unload` 后 `effects_after:0`。
