# domain/bid-heuristics 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：27 §2.1 的标准形态是 `src/domain/bid-heuristics/requirements/README.md`；本插件**尚无插件目录**
> （迁移计划阶段 2–4 才建），本批（`T-318`）按 27 §2.4 的口径把文档落在 `docs/work/plugin-requirements-domain-bid-heuristics.md`
> （内容与标准形态**同形**），位置偏差逐条登记在映射表 §4.2；建目录（`plugin.json` + `code/`）时 `git mv` 进 `requirements/README.md`。
> **不先建裸目录**的理由（实测，非推测）：`plugin-registry` 的 `depsClosure` 把「目录存在」当「插件存在」，
> 先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红（27 §2.4）。

## 用途（一句话）

比价 heuristics：把「这家为什么排在这里」拆成五个分量贡献点，并让双方自己调权重看名次怎么变。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-VIZ-001` | host/modules/bid-heuristics.mjs | `AC-VIZ-001` | `tools/verify.sh ac AC-VIZ-001` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `bidHeuristics`（`host/modules/bid-heuristics.mjs`）。 |
| 依赖（实测 import 目标） | `host/modules/bid-heuristics.mjs` → `../lib/std-schema.mjs`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh bid-heuristics` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `host/modules/bid-heuristics.mjs` |
| 证据（映射表 §1） | `bid-heuristics`（围栏 4 变异 + 真 HTTP） |
| 缺口 | 无登记缺口（映射表 §1 与该插件名下 FR 的 AC 均已注册）。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-domain-bid-heuristics.md` ⇒ 已登记在映射表 §4.2 |
