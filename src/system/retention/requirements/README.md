# system/retention 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/retention/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-retention.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

留存期与销毁：判定侧生成留存计划、执行侧真销毁并留痕，外加只读聚合视图。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-EVIDENCE-004` | src/quotagent/services/retention.py、src/quotagent/services/retention_exec.py | `AC-AUDIT-003`、`AC-AUDIT-005` | `tools/verify.sh ac AC-AUDIT-003` · `tools/verify.sh ac AC-AUDIT-005` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `retentionView`（`host/modules/retention-view.mjs`）；Python 侧 `services/retention.py`（计划）+ `services/retention_exec.py`（执行）+ `tools/refresh-retention-plan.py`（刷新）。 |
| 依赖（实测 import 目标） | `src/quotagent/services/retention.py` → `..kernel.canon`、`.approval`、`.realm`；`tools/refresh-retention-plan.py` → `quotagent.kernel.ledger`、`quotagent.services.retention`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh retention` · `tools/verify.sh retention-view` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `src/quotagent/services/retention.py`、`retention_exec.py`、`tools/refresh-retention-plan.py` |
| 证据（映射表 §1） | `retention`(判定侧 AC-AUDIT-003 21 机检；执行侧 AC-AUDIT-005 22/22) · `retention-view` · `EV-089`/`EV-090` |
| 缺口 | 无登记缺口（映射表 §1 与该插件名下 FR 的 AC 均已注册）。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-retention.md` ⇒ 已登记在映射表 §4.2 |

## 落地状态（`code/`）

<!-- 本行由批 `EV-176` 逐插件如实登记（机检口径见 `docs/work/plans/plugin-file-map.md` §分类）。 -->

- `code:` 部分落地 —— Python 实体 2 个已在 `code/`（`retention.py`、`retention_exec.py`）；宿主 **ESM 入口未接** ⇒ `entry` 仍如实报 `degraded: artifact-missing`。
