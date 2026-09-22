# 逐文件迁移映射表 · **批次台账**（主文件在 `plugin-file-map.md`）

<!-- budget: 48 KB（`docs/work/plans/*.md` 通配行，见 docs/design/12-documentation-standard.md §1） -->

本文件是 `docs/work/plans/plugin-file-map.md` §分类 的**批次台账分册**：每个迁移批次搬了什么、
归到哪个插件、新位置在哪、门名与行为如何对拍。**主文件仍是机器登记真源**（§分类 三节全量分类表 =
`tools/verify.sh plugin-assets` 的 PA3/PA4 判据）；这里只放叙事，避免主文件顶破 48 KB 预算。

拆分时间线：阶段 4.1 示范批次 → 阶段 4.2 前 10 → 阶段 4.2 续批（20/20）+ `EV-173` → **本批 `EV-174`**。

---

### 本批先行的 8 项（阶段 4.1 的示范批次）

| 资产（旧位置） | 归属插件 | 新位置 | 门名（行为搬前搬后一致） |
|---|---|---|---|
| `tools/check-quote-draft-route.py` | `domain/quote-prepare` | `src/domain/quote-prepare/tests/check-quote-draft-route.py` | `tools/verify.sh quote-draft` |
| `tools/check-rfq-visibility-route.py` | `system/projection` | `src/system/projection/tests/check-rfq-visibility-route.py` | `tools/verify.sh rfq-visibility` |
| `tools/check-gate-timeline-route.py` | `domain/gate-timeline` | `src/domain/gate-timeline/tests/check-gate-timeline-route.py` | `tools/verify.sh gates` |
| `tools/check-change-detail-route.py` | `domain/gate-timeline` | `src/domain/gate-timeline/tests/check-change-detail-route.py` | `tools/verify.sh change-detail` |
| `tools/check-authority-route.py` | `domain/authority-band` | `src/domain/authority-band/tests/check-authority-route.py` | `tools/verify.sh authority` |
| `tools/check-plugin-lifecycle.py` | `system/runtime` | `src/system/runtime/tests/check-plugin-lifecycle.py` | `tools/verify.sh plugin-lifecycle` |
| `tools/check-advice-route.py` | `domain/advice` | `src/domain/advice/tests/check-advice-route.py` | `tools/verify.sh advice` |
| `src/quotagent/qa/checks_qprep.py` | `domain/quote-prepare` | `src/domain/quote-prepare/tests/checks_qprep.py` | `tools/verify.sh ac AC-QUOTE-001` |

### 阶段 4.2 已搬的 10 个围栅门（`EV-172` / `T-321`）

口径与上面 8 项相同：实体进 `src/<层>/<插件>/tests/`，旧位置 `host/` 只剩 5 行薄转发，`tools/verify.sh <门名>` 的**退出码与输出形状逐项对拍一致**（原始行见 `docs/work/evidence/EV-172-*`）。
剩余的 10 个在续批里搬完，见下一节。

| 资产（旧位置） | 归属插件 | 新位置 | 门名（行为搬前搬后一致） |
|---|---|---|---|
| `host/t247-idem-gate.mjs` | `system/idempotency-guard` | `src/system/idempotency-guard/tests/t247-idem-gate.mjs` | `tools/verify.sh idempotency-guard` |
| `host/t247-scorecard-gate.mjs` | `domain/supplier-scorecard` | `src/domain/supplier-scorecard/tests/t247-scorecard-gate.mjs` | `tools/verify.sh supplier-scorecard` |
| `host/t250-budget-gate.mjs` | `system/budget-guard` | `src/system/budget-guard/tests/t250-budget-gate.mjs` | `tools/verify.sh budget-guard` |
| `host/t250-approval-gate.mjs` | `system/approval` | `src/system/approval/tests/t250-approval-gate.mjs` | `tools/verify.sh approval-digest` |
| `host/t286-quote-draft-gate.mjs` | `domain/quote-prepare` | `src/domain/quote-prepare/tests/t286-quote-draft-gate.mjs` | `tools/verify.sh retention-view` |
| `host/t280-ui-feedback-gate.mjs` | `system/ui-feedback` | `src/system/ui-feedback/tests/t280-ui-feedback-gate.mjs` | `tools/verify.sh ui-feedback` |
| `host/t254-retention-view-gate.mjs` | `system/retention` | `src/system/retention/tests/t254-retention-view-gate.mjs` | `tools/verify.sh authority` |
| `host/t287-rfq-visibility-gate.mjs` | `system/projection` | `src/system/projection/tests/t287-rfq-visibility-gate.mjs` | `tools/verify.sh rfq-deadline` |
| `host/t285-rfq-deadline-gate.mjs` | `domain/rfq-deadline` | `src/domain/rfq-deadline/tests/t285-rfq-deadline-gate.mjs` | `tools/verify.sh quote-draft` |
| `host/t284-authority-gate.mjs` | `domain/authority-band` | `src/domain/authority-band/tests/t284-authority-gate.mjs` | `tools/verify.sh rfq-visibility` |

### 阶段 4.2 续批 + `qa` 检查搬家 + 阶段 5 第一小片（`EV-173` / `T-322`）

口径与上面完全一样（`git mv` 实体 + 旧位置薄转发 + 门名/分支一行未改 + 逐项对拍）。本批三件：

**① 剩下的 10 个围栅门**（`host/*-gate.mjs` 至此 **20/20 全部搬完**）：

| 资产（旧位置） | 归属插件 | 新位置 |
|---|---|---|
| `host/t260-pipeline-gate.mjs` | `system/pipeline-view` | `src/system/pipeline-view/tests/t260-pipeline-gate.mjs` |
| `host/t267-market-gate.mjs` | `system/market` | `src/system/market/tests/t267-market-gate.mjs` |
| `host/t268-user-space-gate.mjs` | `system/user-plugin-manager` | `src/system/user-plugin-manager/tests/t268-user-space-gate.mjs` |
| `host/t271-admin-gate.mjs` | `system/admin` | `src/system/admin/tests/t271-admin-gate.mjs` |
| `host/t275-runtime-gate.mjs` | `system/agent-runtime` | `src/system/agent-runtime/tests/t275-runtime-gate.mjs` |
| `host/t277-storage-gate.mjs` | `system/storage` | `src/system/storage/tests/t277-storage-gate.mjs` |
| `host/t279-heuristics-gate.mjs` | `domain/bid-heuristics` | `src/domain/bid-heuristics/tests/t279-heuristics-gate.mjs` |
| `host/t281-advice-gate.mjs` | `domain/advice` | `src/domain/advice/tests/t281-advice-gate.mjs` |
| `host/t282-gate-timeline-gate.mjs` | `domain/gate-timeline` | `src/domain/gate-timeline/tests/t282-gate-timeline-gate.mjs` |
| `host/t283-change-detail-gate.mjs` | `domain/gate-timeline` | `src/domain/gate-timeline/tests/t283-change-detail-gate.mjs` |

**② 21 个 `qa` 检查**（`src/quotagent/qa/checks_*.py` → 各自插件的 `tests/`；`qa` 包的导入面靠
`importlib` 薄转发保持不变，AC 注册与 `tools/verify.sh ac <AC>` 的入口一字未改）：
`checks_admin` · `checks_adv` · `checks_gate` · `checks_uifb` · `checks_viz` · `checks_config` ·
`checks_uxweb` · `checks_storage` · `checks_userplugin` · `checks_userplugin_versions` ·
`checks_userplugin_elevate` · `checks_agentrt` · `checks_agentrt_lifecycle` · `checks_agentrt_memory` ·
`checks_mail` · `checks_mail_transport` · `checks_usreq` · `checks_design` · `checks_audit` ·
`checks_retention` · `checks_retention_exec`。

**③ 阶段 5 的第一小片**：内核实体 `src/quotagent/kernel/**`（9 个 `.py`）搬进 `src/system/kernel/code/`，
旧路径留**薄重导**（实体源码在 `quotagent.kernel` 的命名空间里执行 ⇒ `import quotagent.kernel.*` 与
内核间相对导入一字不改）。内核**依然不可自改**（ADR-0002 / INV-010），唯一一份实现只在 `code/` 下。

### 阶段 4.2 终批 + 阶段 5 第二小片（`EV-174` / `T-323`）

口径与上面完全一样（`git mv` 实体 + 旧位置薄转发/薄重导 + `tools/verify.sh` 的门名与分支**一行未改** +
逐项对拍）。

**① 剩下的 25 个 `qa` 检查 → 各自插件的 `tests/`**（`src/quotagent/qa/checks_*.py` 至此 **47/47 搬完**；
旧位置留 `importlib` 薄转发，`qa` 包的导入面、AC 注册与 `tools/verify.sh ac <AC>` 入口一字未改）。
25 项**都能判到既有归属插件**（`src/<层>/<插件>/plugin.json` 已在）⇒ 本批**不新建插件目录**（不造假功能）。
逐项「旧位置 → 归属 → 新位置」的完整表 = 主文件 §分类 **C 节**（25 行已由 `插件·待搬` 改为 `插件·已搬`，
与门内 `RELOCATED` 双向逐条一致）；清单与对拍原始行见
`docs/work/evidence/EV-174-plugin-relocation-batch4.md`（原始输出 `EV-174-batch4-raw.json`）。

**② 阶段 5 第二小片：12 个服务模块实体进 `src/<层>/<插件>/code/`**（逐条 sha256 与
`git show HEAD:<旧路径>` 的 blob **逐字节守恒**；旧路径留**薄重导** —— 实体源码在**本模块的命名空间**里
`exec`，`__name__`/`__package__` 不变 ⇒ `from ..services.<name> import …` 与模块间相对导入一字不改）：

| 资产（旧位置） | 归属插件 | 新位置 |
|---|---|---|
| `src/quotagent/services/commitments.py` | `domain/commitments` | `src/domain/commitments/code/commitments.py` |
| `src/quotagent/services/capacity.py` | `domain/capacity` | `src/domain/capacity/code/capacity.py` |
| `src/quotagent/services/change.py` | `domain/change` | `src/domain/change/code/change.py` |
| `src/quotagent/services/clarify.py` | `domain/clarify` | `src/domain/clarify/code/clarify.py` |
| `src/quotagent/services/compare.py` | `domain/compare` | `src/domain/compare/code/compare.py` |
| `src/quotagent/services/costmodel.py` | `domain/costmodel` | `src/domain/costmodel/code/costmodel.py` |
| `src/quotagent/services/deviation.py` | `domain/deviation` | `src/domain/deviation/code/deviation.py` |
| `src/quotagent/services/export.py` | `domain/export` | `src/domain/export/code/export.py` |
| `src/quotagent/services/guard.py` | `domain/guard` | `src/domain/guard/code/guard.py` |
| `src/quotagent/services/intake.py` | `domain/intake` | `src/domain/intake/code/intake.py` |
| `src/quotagent/services/norm.py` | `system/norm` | `src/system/norm/code/norm.py` |
| `src/quotagent/services/measures.py` | `system/measures` | `src/system/measures/code/measures.py` |

> **选取口径**（只搬归属明确、且"没有读方按旧路径读源码"的模块）：`mail` / `mail_transport` /
> `admin_blocks` / `retention` / `retention_exec` / `faq` / `negotiation` 这 7 个模块**仍有读方按旧路径读**
> （`tools/check-mail-transport.py`、`tools/check-plugin-inventory.py`、以及若干 `checks_*.py` 用
> `__file__` / 路径扫描做静态断言）⇒ 本批不动它们：**先动会让那些断言在 20 行薄重导上静默判绿**
> （= 断言变空），留待"读方一起改"的那一批。其余 12 项的读方一律走 `quotagent.services.<name>` 的
> **导入面**，薄重导后逐条实测可用（见 EV-174 的「旧导入路径仍可用」原始行）。
> 另外：`AC-RUNTIME-001`（`p0-no-node`）的扫描面本批**同时收紧到实体目录**（`src/<层>/<插件>/code/*.py`），
> 否则"服务不依赖宿主运行时"这条也会在薄重导上判绿（实测扫描面 62 个文件：内核 18 + 服务实体 12 + 旧路径 31）。

