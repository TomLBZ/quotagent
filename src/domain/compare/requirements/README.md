# domain/compare 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/domain/compare/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-domain-compare.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

比价：TCO、加权排序、引用校验；宿主侧同口径的排序与权重组合。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-COMPARE-001` | src/quotagent/services/compare.py | `AC-COMPARE-002` | `tools/verify.sh ac AC-COMPARE-002` |
| `FR-COMPARE-002` | src/quotagent/services/compare.py | `AC-COMPARE-002` | `tools/verify.sh ac AC-COMPARE-002` |
| `FR-COMPARE-003` | src/quotagent/services/compare.py | `AC-COMPARE-003` | `tools/verify.sh ac AC-COMPARE-003` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `compare`（`host/modules/compare.mjs`）；Python 侧 `services/compare.py`（`CompareService`）。 |
| 依赖（实测 import 目标） | `src/quotagent/services/compare.py` → `..kernel.canon`、`..kernel.events`、`..kernel.ledger`；`host/modules/compare.mjs` → `../lib/std-schema.mjs`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh ac AC-COMPARE-002` · `tools/verify.sh ac AC-COMPARE-003` · `tools/verify.sh bid-heuristics` |
| 写面 | `plugin.json.permissions = {writes: ["own-dir","request-file"], ledger: "sole-writer"}`：账本侧只有本插件写这一族事件 —— `compare/{rank-computed,table-exported}`（比价排名与导出留痕）；唯一写者 = `tools/compare-apply.py`（经内核 `ledger` 的 H1 写路径）。 |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `src/quotagent/services/compare.py`、`host/modules/compare.mjs` |
| 证据（映射表 §1） | `ac AC-COMPARE-002/003` · `bid-heuristics`（同口径） · `EV-039` |
| 缺口 | 无登记缺口（映射表 §1 与该插件名下 FR 的 AC 均已注册）。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-domain-compare.md` ⇒ 已登记在映射表 §4.2 |

## 落地状态（`code/`）

<!-- 本行由批 `EV-176` 逐插件如实登记（机检口径见 `docs/work/plans/plugin-file-map.md` §分类）。 -->

- `code:` **已承载（本批 `EV-179`）** —— 宿主模块实体 `compare.mjs` + Python 实体 `compare.py` 都在 `code/`；
  本批新增入口 `code/index.mjs`（对 `./compare.mjs` 的薄包装：`export *` 活绑定 + 透传自述面）⇒ `entry` 指向的入口**真实存在**，
  `tools/plugin.sh status domain/compare` 由 `degraded: artifact-missing` 变为 `valid:true`（`kind: esm`）。**不新造功能**：
  `provides=[compare]` 与实体一致，语义仍只在 `compare.mjs`/`compare.py` 里。
- **为什么这个插件可以直接里接入口**：它的 `code/` 里**只有一个**自述服务键的宿主模块（`compare.mjs`，`provides=['compare']`，
  且 `host/profiles.mjs` 的 `contractor-ops` 已装配它、清单 `14` 行 18 已登记）—— 不存在「哪个实体是入口」的设计歧义。
