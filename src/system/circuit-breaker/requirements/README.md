# system/circuit-breaker 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/circuit-breaker/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-circuit-breaker.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

运行期熔断：连续失败达阈值即快速失败，冷却后半开有界试探，拒绝带状态与重试时间。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-RUNTIME-005` | host/modules/circuit-breaker.mjs | `AC-RUNTIME-005` | `tools/verify.sh breaker` · `tools/verify.sh breaker-route`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `breaker`（`host/modules/circuit-breaker.mjs`）。 |
| 依赖（实测 import 目标） | `host/modules/circuit-breaker.mjs` → `../lib/std-schema.mjs`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh breaker` · `tools/verify.sh breaker-route` |
| 写面 | 账本唯一写者仍是内核（H1）；本插件的账本写入只在映射表 §1 证据列点名的工具里（若有） |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `host/modules/circuit-breaker.mjs` |
| 证据（映射表 §1） | `breaker`(10/10) · `breaker-route`(4/4) · `EV-077` |
| 缺口 | 名下 1 条 FR（`FR-RUNTIME-005`）的关联 AC 尚未在 `qa` 注册（`tools/verify.sh ac-registry`：P2 未到期）⇒ 这几条现由本插件的门 `tools/verify.sh breaker`、`tools/verify.sh breaker-route` 围栏。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-circuit-breaker.md` ⇒ 已登记在映射表 §4.2 |
