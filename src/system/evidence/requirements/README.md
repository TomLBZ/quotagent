# system/evidence 需求（**本插件自己的** FR 行 + 每条的验收方式）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID 与承载体，不复制 FR 正文**（一处一事实，`docs/design/12-documentation-standard.md` §3.1）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/evidence/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-evidence.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

审计与证据面：审计包导出/独立验证/签名与包含证明 + 模型输入重建校验 + 账本证据面只读统计（只给计数不出正文）。

## 归属行（本插件承载的需求）

FR 正文只在定义集合（`docs/work/functional-requirements.md` + 同目录归档）里；本表只写**本插件怎么被验收**。
「关联 AC」取自该 FR 的定义行；「承载体」取自 `docs/design/15-requirements-coverage.md` §1 的实测列。

| FR 号 | 承载体（`15` §1 实测） | 关联 AC | 验收方式（门或命令） |
|---|---|---|---|
| `FR-EVIDENCE-001` | src/quotagent/kernel/evidence.py | `AC-AUDIT-001` | `tools/verify.sh ac AC-AUDIT-001` |
| `FR-EVIDENCE-002` | src/quotagent/kernel/evidence.py | `AC-AUDIT-001` | `tools/verify.sh ac AC-AUDIT-001` |
| `FR-EVIDENCE-003` | src/quotagent/kernel/modelgate.py | `AC-AUDIT-002` | `tools/verify.sh ac AC-AUDIT-002` |
| `FR-EVIDENCE-005` | src/quotagent/kernel/evidence.py | `AC-AUDIT-004` | `tools/verify.sh ac AC-AUDIT-004` |
| `FR-EVIDENCE-006` | host/modules/evidence-summary.mjs | `AC-EVIDENCE-003` | `tools/verify.sh evolve-module`（关联 AC 尚未在 `qa` 注册 ⇒ 现由本插件的门围栏，见「现状与缺口」） |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `evidenceSummary`（`host/modules/evidence-summary.mjs`，自进化产出）；Python 侧 `kernel/evidence.py`（`export`/`verify`/`sign_pack`）、`kernel/modelgate.py`（`ModelGateway.rebuild_matches`）。 |
| 依赖（实测 import 目标） | `src/quotagent/kernel/evidence.py` → `.canon`、`.ledger`；`src/quotagent/kernel/modelgate.py` → `.canon`、`.ledger`；`host/modules/evidence-summary.mjs` → `../lib/std-schema.mjs`（27 §5.1/§5.2：只 import 内核面或其它插件的公开服务面，不 import 别的插件实现文件） |
| 门（映射表 §1 证据列里的 `ac` 简写已展开成可跑命令） | `tools/verify.sh ac AC-AUDIT-001` · `tools/verify.sh ac AC-AUDIT-002` · `tools/verify.sh evolve-module` |
| 写面 | `plugin.json.permissions = {ledger: "sole-writer", writes: ["own-dir"]}`：账本侧**只有本插件写** `evidence/pack-exported` 这一条事件（唯一写者 `tools/evidence-pack-export.py`，经内核 `kernel.ledger` 的 H1 写路径；导出件 ≥ 0 行即 +1）；导出件正文落自己的目录（目录内容寻址、文件 0600）。其余面（`evidence-summary` 读面 / `audit-verify.py` / `evidence-pack-verify.py` / `export-events.py`）一律只读。 |

## 现状与缺口

| 项 | 现状 |
|---|---|
| 状态（映射表 §1） | `done` |
| 承载体（映射表 §1） | `src/quotagent/kernel/{evidence,modelgate}.py`、`host/modules/evidence-summary.mjs` |
| 证据（映射表 §1） | `audit` · `ac AC-AUDIT-001/002` · `evolve-module`(11/11) · `EV-075` |
| 缺口 | 名下 1 条 FR（`FR-EVIDENCE-006`）的关联 AC 尚未在 `qa` 注册（`tools/verify.sh ac-registry`：P2 未到期）⇒ 这几条现由本插件的门 `tools/verify.sh evolve-module` 围栏。 |
| 需求文档位置 | **非标准位置**：本文件 `docs/work/plugin-requirements-system-evidence.md` ⇒ 已登记在映射表 §4.2 |

## 落地状态（`code/`）

<!-- 本行由批 `EV-177` 登记：入口 + 实体都在本插件 `code/` 下，`plugin.json` 的 `entry` = `code/index.mjs`。 -->

- `code:` **已落地** —— 实体 `code/evidence-summary.mjs`（本批随宿主模块搬迁进 `code/`，**字节守恒**，`evolve-module` 逐字节校验）+
  入口 `code/index.mjs`（只把实体公开面**重导出**：`export *` 的绑定是活的，无业务语义、无写面）。
- `provides:` `evidenceSummary`（实体自述的真实服务键；占位键已改写）。
- 实测：`tools/plugin.sh status system/evidence` ⇒ `valid:true`、`reason:null`；`load` 真进口（`effects` 非 0）、`unload` 后 `effects_after:0`。
