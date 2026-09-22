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

### 阶段 5 第三小片：余下 18 个服务实体 + **先改读方再搬**（`EV-175`）

口径与上面一样（`git mv` 实体 + 旧位置**薄重导** + 逐项 byte 守恒 + 旧导入路径实测可用）。
本批的关键差别：上一批"仍有读方按旧路径读源码"的 7 个模块**这次搬了**，因此**先**把读方改指实体
（否则静态断言会在十几行的薄重导上**静默判绿** = 断言变空）。8 处读方的改法：

| 读方 | 原来读哪 | 现在读哪 | 改法 |
|---|---|---|---|
| `src/system/mail/tests/checks_mail.py` | `mail.__file__` | 实体 | 新增 `_impl_source()`：`__file__` 是薄重导 ⇒ 跟到它声明的实体 |
| `src/domain/faq/tests/checks_faq.py` | `faq.__file__` | 实体 | 同上 |
| `src/domain/negotiation/tests/checks_negotiation.py` | `negotiation.__file__` | 实体 | 同上 |
| `src/system/retention/tests/checks_retention_exec.py` | `retention_exec.__file__` | 实体 | 同上（`scanned` 走 `_impl_source()`） |
| `src/system/retention/tests/checks_retention.py` | 写死旧路径 | 实体 | 常量 `RETENTION_SOURCE` 直接指 `src/system/retention/code/retention.py` |
| `src/system/admin/tests/checks_admin.py` | 写死旧路径 + `git show HEAD:旧路径` | 实体 + `HEAD:新路径` | 常量 `SERVICE` 改指实体；HEAD 回归点同步 |
| `tools/check-mail-transport.py` | 写死旧路径（G1 的 AST 扫描） | 实体 | 路径改指 `src/system/mail/code/mail.py` |
| `tools/check-plugin-inventory.py` | `src/quotagent/services/*.py` 单一 glob（P3 功能归属） | 旧路径 ∪ 实体 | `service_names()` = 两边都扫（名字集合同口径，实体不再无人管） |

**反向验证（逐条真跑，原始行在 `docs/work/evidence/EV-175-*`）**：对每个读方做两次单点变异 ——
① 往**实体**尾部加一行（`import subprocess` / `import smtplib` / `import shutil`）⇒ 对应门/AC **必红**
（例如 `AC-AUDIT-005` 的 `scanned=src/system/retention/code/retention_exec.py`、
`AC-MAIL-001` 的 `实现=…/src/system/mail/code/mail.py` 直接印在 detail 里）；
② 往**旧路径薄重导**尾部加同一行 ⇒ 该门 **仍绿**（证明判据已不看旧路径）。两次都逐字节复原并核对 sha256。

18 项「旧位置 → 归属 → 新位置」：

| 资产（旧位置） | 归属插件 | 新位置 |
|---|---|---|
| `src/quotagent/services/admin_blocks.py` | `system/admin` | `src/system/admin/code/admin_blocks.py` |
| `src/quotagent/services/approval.py` | `system/approval` | `src/system/approval/code/approval.py` |
| `src/quotagent/services/evaldata.py` | `system/eval` | `src/system/eval/code/evaldata.py` |
| `src/quotagent/services/evalmetrics.py` | `system/eval` | `src/system/eval/code/evalmetrics.py` |
| `src/quotagent/services/scenarios.py` | `system/eval` | `src/system/eval/code/scenarios.py` |
| `src/quotagent/services/faq.py` | `domain/faq` | `src/domain/faq/code/faq.py` |
| `src/quotagent/services/mail.py` | `system/mail` | `src/system/mail/code/mail.py` |
| `src/quotagent/services/mail_transport.py` | `system/mail` | `src/system/mail/code/mail_transport.py` |
| `src/quotagent/services/negotiation.py` | `domain/negotiation` | `src/domain/negotiation/code/negotiation.py` |
| `src/quotagent/services/pricing.py` | `domain/pricing` | `src/domain/pricing/code/pricing.py` |
| `src/quotagent/services/quotes.py` | `domain/quotes` | `src/domain/quotes/code/quotes.py` |
| `src/quotagent/services/realm.py` | `system/realm` | `src/system/realm/code/realm.py` |
| `src/quotagent/services/relay.py` | `system/relay` | `src/system/relay/code/relay.py` |
| `src/quotagent/services/retention.py` | `system/retention` | `src/system/retention/code/retention.py` |
| `src/quotagent/services/retention_exec.py` | `system/retention` | `src/system/retention/code/retention_exec.py` |
| `src/quotagent/services/rfq.py` | `domain/rfq` | `src/domain/rfq/code/rfq.py` |
| `src/quotagent/services/sync.py` | `domain/sync` | `src/domain/sync/code/sync.py` |
| `src/quotagent/services/terms.py` | `domain/terms` | `src/domain/terms/code/terms.py` |

至此 `src/quotagent/services/**` 的 **30/30** 实体都在 `src/<层>/<插件>/code/`，旧目录只剩薄重导。

### 阶段 4.2 续搬：10 个外圈 `tools/**` 非薄入口进各自插件的 `tests/`（`EV-175`）

**选取口径**：挑**归属明确、自洽的小门**（只做 `ROOT` 推导一处改动：`parents[1]`（`tools/` 下）→
`parents[4]`（`src/<层>/<插件>/tests/` 下）），搬完把 `tools/verify.sh` 的**门名与分支一行未改**、
逐门 `rc` 与 `passed/total` **逐项对拍**。旧位置留**薄转发**（`runpy`；含「薄转发（迁移阶段 4.1）」标记、
≤ 20 行、且 ≤ 目标 1/4 —— 就是 `tools/check-plugin-assets.py` PA1/PA2 判据）。`tools/**` 非薄入口
由门的基线**收紧**：`BASELINE_NONTHIN` **64 → 54**（只减不增，**不是放宽**）。

| 资产（旧位置） | 归属插件 | 新位置 | 门名（行为搬前搬后一致） |
|---|---|---|---|
| `tools/check-faq.py` | `domain/faq` | `src/domain/faq/tests/check-faq.py` | `tools/verify.sh faq` |
| `tools/check-negotiation.py` | `domain/negotiation` | `src/domain/negotiation/tests/check-negotiation.py` | `tools/verify.sh negotiation` |
| `tools/check-retention.py` | `system/retention` | `src/system/retention/tests/check-retention.py` | `tools/verify.sh retention` |
| `tools/check-mail.py` | `system/mail` | `src/system/mail/tests/check-mail.py` | `tools/verify.sh mail` |
| `tools/check-canary.py` | `system/canary` | `src/system/canary/tests/check-canary.py` | `tools/verify.sh canary` |
| `tools/check-canary-dispatch.py` | `system/canary` | `src/system/canary/tests/check-canary-dispatch.py` | `tools/verify.sh canary-route` |
| `tools/check-bridge-canary.py` | `system/canary` | `src/system/canary/tests/check-bridge-canary.py` | `tools/verify.sh bridge-canary` |
| `tools/check-governor.py` | `system/governor` | `src/system/governor/tests/check-governor.py` | `tools/verify.sh governor` |
| `tools/check-audit-hook.py` | `system/audit-hook` | `src/system/audit-hook/tests/check-audit-hook.py` | `tools/verify.sh audit-hook` |
| `tools/check-breaker-route.py` | `system/circuit-breaker` | `src/system/circuit-breaker/tests/check-breaker-route.py` | `tools/verify.sh breaker-route` |

**分类表与门内登记同步**：主文件 §分类 A 节的这 10 行由 `插件·待搬` 改成 `插件·已搬`（PA3 双向逐条一致）；
A 节计数行与 §分类 口径第 4 条同步为 `已搬 10 + 待搬 54`。10 项的「旧位置 → 归属 → 新位置 → 逐门
rc/passed-total 对拍」原始行见 `docs/work/evidence/EV-175b-tools-relocation.md`。

### 阶段 4.2 续搬（二）：12 个外圈 `tools/**` 非薄入口进各自插件的 `tests/`（`EV-176`）

| 资产（旧位置） | 归属插件 | 新位置 | 门 |
|---|---|---|---|
| `tools/check-docs.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-docs.py` | `tools/verify.sh docs` |
| `tools/check-ac-registry.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-ac-registry.py` | `tools/verify.sh ac-registry` |
| `tools/check-fr-coverage.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-fr-coverage.py` | `tools/verify.sh coverage` |
| `tools/check-invariants.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-invariants.py` | `tools/verify.sh invariants` |
| `tools/check-v-register.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-v-register.py` | `tools/verify.sh v` |
| `tools/check-module-wiring.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-module-wiring.py` | `tools/verify.sh wiring` |
| `tools/check-plugin-inventory.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-plugin-inventory.py` | `tools/verify.sh plugins` |
| `tools/check-clean-copy.py` | `system/repo-gate` | `src/system/repo-gate/tests/check-clean-copy.py` | `tools/verify.sh clean-copy` |
| `tools/check-events.py` | `system/kernel` | `src/system/kernel/tests/check-events.py` | `tools/verify.sh events` |
| `tools/check-webui.py` | `system/webui` | `src/system/webui/tests/check-webui.py` | `tools/verify.sh webui` |
| `tools/check-heuristics-route.py` | `domain/bid-heuristics` | `src/domain/bid-heuristics/tests/check-heuristics-route.py` | `tools/verify.sh bid-heuristics` |
| `tools/check-idem-route.py` | `system/idempotency-guard` | `src/system/idempotency-guard/tests/check-idem-route.py` | `tools/verify.sh idem-route` |

**实现只改一处**：`ROOT` 推导 `parent.parent` / `parents[1]`（`tools/` 下）→ `parents[4]`（`src/<层>/<插件>/tests/` 下）；
门名与 `tools/verify.sh` 的分支一行未改。**逐门搬前/搬后 rc 与 passed/total 逐项不变**（12 门的原始行见 `EV-176`）。

### 阶段 5 第四小片：13 个 `host/modules/*.mjs` 实体进各自插件 `code/`（`EV-176`）

| 实体（旧位置 `host/modules/`） | 归属插件 | 新位置 | blob（HEAD == 现在） |
|---|---|---|---|
| `norm.mjs` | `system/norm` | `src/system/norm/code/norm.mjs` | `82279497c6bf` |
| `sourcing.mjs` | `domain/sourcing` | `src/domain/sourcing/code/sourcing.mjs` | `b569ccd1d048` |
| `governor.mjs` | `system/governor` | `src/system/governor/code/governor.mjs` | `4fb86f38387c` |
| `config-view.mjs` | `system/config` | `src/system/config/code/config-view.mjs` | `e276a1b41b9e` |
| `storage-view.mjs` | `system/storage` | `src/system/storage/code/storage-view.mjs` | `04c0c180678e` |
| `user-plugin-manager.mjs` | `system/user-plugin-manager` | `src/system/user-plugin-manager/code/user-plugin-manager.mjs` | `65fe92d59369` |
| `bid-heuristics.mjs` | `domain/bid-heuristics` | `src/domain/bid-heuristics/code/bid-heuristics.mjs` | `44b7206bcfdb` |
| `agent-context.mjs` | `system/agent-runtime` | `src/system/agent-runtime/code/agent-context.mjs` | `058472646d6d` |
| `agent-memory.mjs` | `system/agent-runtime` | `src/system/agent-runtime/code/agent-memory.mjs` | `fb4bfd764fa8` |
| `agent-harness.mjs` | `system/agent-runtime` | `src/system/agent-runtime/code/agent-harness.mjs` | `56369fd5352a` |
| `canary.mjs` | `system/canary` | `src/system/canary/code/canary.mjs` | `53e9d278763c` |
| `admin-guard.mjs` | `system/admin` | `src/system/admin/code/admin-guard.mjs` | `abbd3f1e4d90` |
| `admin-view.mjs` | `system/admin` | `src/system/admin/code/admin-view.mjs` | `cf0230defdbc` |

**旧位置留薄重导，且导入面逐名一致**：`host/modules/<stem>.mjs` → `export * from '../lib/entity-<stem>.mjs'` →
`export * from 'src/<层>/<插件>/code/<stem>.mjs'`（两跳都是 `export *`，名字绑定是**活的**）。
为什么中间要过 `host/lib/`：`tools/verify.sh modules` 的 A6 断言**按源码文本**判宿主模块的相对 import
（只允许同目录 `./` 与库层 `../lib/`）—— 这是"宿主模块对外只依赖库层"这条纪律，搬完实体后仍然成立。
**实体里的 `../lib/…` 逐字未改**（模块 import 契约不许改：`t271/t275/t277/t279/t285` 等门都按
`../lib/std-schema.mjs` 判白名单）⇒ 各插件目录加一条**过渡软链** `src/<层>/<插件>/lib -> ../../../host/lib`
（10 条；`host/lib/**` 将来搬进插件时删掉即可）。

**先改读方再搬 10 处**（否则静态断言在薄重导上**静默判绿**）：`t279`（TARGET）、`t277`（MODULE_PATH）、
`t275`（三件 PATH）、`t271`（GUARD/VIEW_PATH）、`t268`（MANAGER_PATH）、`checks_agentrt.py` /
`checks_agentrt_lifecycle.py`（MODULES 表）、`checks_agentrt_memory.py`（MEM）、`checks_viz.py`（MOD）、
`checks_config.py`（FILES['view']）。**实测旧导入路径可用**：13 项的导出名集合 旧 == 新 == HEAD（逐项 True，TOTAL 13 / FAIL 0）。

### 「清单先行」插件补**真实承载**：7 个（`EV-176`）

| 插件 | 入口 | 实体 | `provides`（真实服务键） |
|---|---|---|---|
| `system/norm` | `code/index.mjs` | `code/norm.mjs` | `norm` |
| `domain/sourcing` | `code/index.mjs` | `code/sourcing.mjs` | `sourcing` |
| `system/governor` | `code/index.mjs` | `code/governor.mjs` | `governor` |
| `system/config` | `code/index.mjs` | `code/config-view.mjs` | `configView` |
| `system/storage` | `code/index.mjs` | `code/storage-view.mjs` | `storageView` |
| `system/user-plugin-manager` | `code/index.mjs` | `code/user-plugin-manager.mjs` | `userPluginManager` |
| `domain/bid-heuristics` | `code/index.mjs` | `code/bid-heuristics.mjs` | `bidHeuristics` |

入口只做**重导出 + 透传**（`export *` + `inject/provides/Config/usedServices/apply`），**零业务语义、零写面**。
其余 **47 个**未接入口的插件，逐个在自己的 `requirements/README.md` 「落地状态（`code/`）」一节**如实标注**
（`部分落地` / `待实现`；不造功能）。

## 阶段 4.2 终批（二）+ 阶段 5 第五小片（`EV-177` / `T-327`）

1. **`host/lib/**` 13 个** ⇒ 归属插件 `code/`：`bridge`/`supervisor` → `system/kernel-bridge`；
   `canary-dispatch`/`canary-run` → `system/canary`；`config`/`config-keys`/`config-ui`/`schema`/`std-schema` → `system/config`；
   `frozen`/`ledger-view` → `system/kernel`；`ui-route`/`ui-slot` → `system/webui`。旧位置一律**薄重导**（`export * from`），
   旧导入路径实测仍可用（逐文件导出名集合与搬前逐名一致；含 2 个未搬对照 `evolution.mjs`/`user-space.mjs`，共 15/15）。
   **先改读方 6 处**（按源码文本读库层的点）：`tools/config-apply.py`、`tools/check-run-once.py`、`tools/check-config-route.py`、
   `tools/check-mail-transport.py`、`src/system/mail/tests/checks_mail_transport.py`、
   `src/system/config/tests/checks_config.py`、`src/domain/authority-band/tests/t284-authority-gate.mjs`。
   **搬迁补丁 2 处**：`src/system/config/code/config.mjs` 的 `./frozen.mjs` → `../lib/frozen.mjs`；
   `src/system/kernel/code/ledger-view.mjs` 的自相对 `ROOT` 上溯 2 级 → 4 级。
2. **自进化产物追链搬迁 12 个**：`host/modules/<name>.mjs` ⇒ `src/<层>/<插件>/code/<name>.mjs`（blob 守恒 12/12），
   `docs/work/evolution-log.json` 逐条同步 `artifact_path`/`artifact_hash`/`bytes`；门 `evolve-module` 改**按日志的路径读**
   （并把"旧路径只是薄重导"折进原断言，条数不变）；可复跑校验 `src/system/evolution/tests/check-evolution-log-path.py`。
3. **`tools/**` 非薄入口 12 项** ⇒ 各自插件 `tests/`（旧处**薄转发**）；`plugin-assets`：`RELOCATED 96 → 108`、
   `BASELINE_NONTHIN 42 → 30`（**收紧**）。
4. **12 个插件补真实承载**（`code/index.mjs` = 对**已在 `code/` 的实体**的薄包装 + 真 `provides`）；**不新造功能**。
5. **两处门读方加"跟重导链"**（否则按源码文本判的断言在 8 行转发上**静默判绿**）：
   `src/system/repo-gate/tests/check-module-wiring.py` 的 `module_source()`（实测：`ops-view` 的 inject 看不见 ⇒ `breaker` 变孤儿）、
   `host/check-modules.mjs` 的 `moduleSource()`（A1/A4/A6 一起跟到实体）。

### 非薄入口数的加减史（`tools/**` 的散落度量；复算：`tools/verify.sh plugin-assets` 的 PA7 行）

> 本节的数是**事实**（每批由门 `tools/check-plugin-assets.py` 的 `BASELINE_NONTHIN` 逐批收紧；只减不增、从未放宽）。
> 源文本本在 `plugin-file-map.md` §分类 point 4，本批（`EV-178`）因该文件逼近 48 KB 预算**整段逐字搬来**（内容未改，只补本批一行）。

| 时刻 | 非薄入口数 | 这一批做了什么 |
|---|---|---|
| 搬前 | **69** | 75 个文件 − 6 个平台薄入口（`verify.sh`/`run.sh`/`runtime.sh`/`bootstrap.sh`/`cordis.sh`/`plugin.sh`） |
| 阶段 4.1 | **63** | 搬走 7 个（旧位置变薄转发）；并新增 1 个（本节的机检门 `tools/check-plugin-assets.py` 自己，登记为 `插件·待搬`） |
| `EV-171` | **64** | 一键运行的干净副本验收门 `tools/check-run-clone.py` 加入（同样是本类的平台门） |
| `EV-175` | **54** | 阶段 4.2 续搬 10 个（旧位置变薄转发，全部落在 `tests/`） |
| `EV-176` | **42** | 再搬 12 个（外圈、归属明确的 `check-*.py`，全部落 `tests/`） |
| `EV-177` | **30** | 再搬 12 个（8 个路由门 + 4 个平台门） |
| **`EV-178`** | **13** | 再搬 **17** 个：`audit-verify`·`export-events`·`refresh-admin-snapshot`·`admin-apply`·`refresh-agent-memory`·`refresh-retention-plan`·`gate-nudge`·`rfq-promise`·`userplugin-record`·`userplugin-elevate`·`ui-feedback-apply`·`ui-feedback-monitor`·`ui-feedback-tick`·`ws-integrate`·`evolve-record`·`evolve-module`·`storage`（旧位置全部变薄转发） |
| `EV-179` | **3** | 再搬 **10** 个（`check-*.py` 一族与外圈工具，全部落 `tests/`；旧位置全部变薄转发） |
| **`EV-180`（本批）** | **1** | 再搬 **2** 个：`netblock.c`（→ `src/system/runtime/tests/`，旧位置用 `#include` 转发；读方 `check-run-once.py` 跟到实体）、`v-kit.sh`（→ `src/system/repo-gate/tools/`，旧位置用 `exec sh` 转发；人手命令不变） |

剩下**唯一**的非薄入口（**逐条登记在** `plugin-file-map.md` §A 的 `插件·待搬` 行）：`manual-check.py` ——
PA6 断言「已搬资产仍被**契约面**引用」，它在 `verify.sh` / `qa` / 各插件 `tests/` / `tools/` 里都没有调用者
⇒ 搬走就等于制造一个孤儿。**本批不搬**，如实登记（不假装它也能搬）。
