# system/market 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/market/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-market.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

插件市场：**插件列表本身由插件提供**——只读聚合三真源（目录 / 清单 / 用户空间），
逐项给 `source` 与 `wired`，三源不一致必须报，零副作用、零写面。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-MARKET-001 | 只读聚合三真源，逐项 `source`(human/evolve/user-space) 与 `wired`；未装配显式 unwired | `tools/verify.sh plugin-market` |
| FR-MARKET-002 | 市场目录与已装载项必须分开；未过门/未晋升产物不得进「可安装项」；无 `install_ref` 一律拒 | `tools/verify.sh plugin-market` |
| FR-MARKET-003 | 三源不一致即报 `inconsistent` + 逐项差异，不得取其一静默 | `tools/verify.sh plugin-market` |
| FR-MARKET-004 | 只读零副作用：不装载/不下载/不写文件/不起子进程/不写账本 | `tools/verify.sh plugin-market` |
| FR-MARKET-005 | 有界且确定性：条数上界、稳定排序、不含正文与私域键，超界报被丢条数 | `tools/verify.sh plugin-market` |
| FR-MARKET-006 | 不可用不得伪装：`degraded` + `reason` + `next_action` | `tools/verify.sh plugin-market` |
| FR-USREQ-008 | 「UI 上必须看得到插件市场」在真页面上可达 | `tools/verify.sh plugin-market` · `admin-route` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `pluginMarket`（宿主模块 `host/modules/plugin-market.mjs`）；页面在系统管理道 `/quotagent/admin/` 的市场区 |
| 依赖 | `host/modules/*.mjs` 目录扫描、`docs/design/14-plugin-inventory.md`（清单真源）、`user-space/*/plugin.json`（用户空间真源）；不注入其它插件的服务 |
| 写面 | 零写面：不写账本、不写文件、不装载、不起子进程（「安装/提权」只产指向既有门的引用） |
| 门 | `tools/verify.sh plugin-market`（`AC-MARKET-001..006`；`source`/`wired`/`inconsistent` 逐条断言） |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 插件目录与清单的**规则文本** | `docs/design/27-plugin-architecture.md`（本插件只聚合它） |
| 宿主层模块的登记行 | `docs/design/14-plugin-inventory.md`（`tools/verify.sh plugins`） |
| 用户空间插件的装载/卸载/隔离 | `system/user-plugin-manager`（`FR-USERPLUG-*`） |
| 自进化提案的晋升与 canary | `system/evolution`、`system/canary`（`FR-EVOLVE-*`） |
| 需求归属与 FR 映射 | `system/repo-gate`（`docs/work/plugin-requirements-map.md` + `tools/verify.sh plugin-requirements`） |
