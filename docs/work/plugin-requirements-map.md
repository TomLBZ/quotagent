# 插件 ↔ 需求映射表（每条 FR 的**唯一**归属插件）

<!-- budget: 32 KB（`docs/work/*.md` 行）。规则真源 = `docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`。
     机检：`tools/verify.sh plugin-requirements`（四条断言 + 4 处单点变异，见 `tools/check-plugin-requirements.py`）。 -->

## 0. 口径（怎么读这张表）

1. **一行一插件**，即"全部插件的一行索引表"：`插件 id（层/名） | 负责的 FR 号 | 承载文件 | 状态 | 证据`。插件 id 一律写 `层次/插件`（userspace 写 `userspace/<ns>/<插件>`，与 `tools/plugin.sh` 同一套形状，见 27 §4.2）。
2. **唯一指针**：FR 定义集合（`docs/work/functional-requirements.md` + `functional-requirements-archive*.md`）里的**每条 FR 恰好出现一次**。多插件共同参与时本表只写**主归属**（谁负责提供），共同参与方写在证据列（例：`FR-USREQ-001` 主归属 `system/webui`，另参与 `system/ui-feedback` / `domain/gate-timeline` / `domain/rfq-deadline`）。
3. **归属怎么定**（按序，可复算）：① `15-requirements-coverage.md` §1 的**承载体实测**折算插件 id（ADR-0021 §2：「归属真源是覆盖矩阵」）；② 该矩阵 §2「插件归属」的显式名单；③ 28 §2.2/§2.3/§2.4 的家族表。与 28 家族表不一致的逐条登记在 §3（**不得悄悄偏离**）。
4. **状态**：`done` = 名下每条 FR 都有真门且无登记缺口；`partial` = 有真证据但有**已登记**缺口；`missing` = 名下至少一条 FR **没有任何证据**，**或**该插件尚无 FR 归属（需求未编号）。缺口逐条在 15 §3、本表 §3/§4 与 `docs/work/requirements-traceability.md`。
5. **证据列**：门名（真跑 `tools/verify.sh <门名>`）· `ac <AC-ID>`（`tools/verify.sh ac <AC-ID>`）· `EV-` 条目 · `req=<path>`（该插件的**独立需求文档**，路径必须真实存在）。标准形态是 `src/<层>/<插件>/requirements/README.md`（27 §2.1）；不在标准位置的逐条登记在 §4.2。**没有证据的行不得写 `done`**。
6. **与 `requirements/README.md` 的分工**：本表是**归属真源**（谁负责 + 状态 + 证据），插件自己的 `requirements/README.md` 只写该插件的 FR 行与可执行命令（27 §2.1；`tools/verify.sh plugin-requirements` 断言：有 `requirements/` 目录的插件在本表有行且标了 `req=`、每个 `req=` 指向的文件真实存在、位置不在标准布局的逐条登记在 §4.2）。

## 1. 插件 ↔ FR（63 行 = 当前插件全集）

| 插件 id（层/名） | 负责的 FR 号 | 承载文件 | 状态 | 证据 |
|---|---|---|---|---|
| `system/kernel` | FR-LEDGER-001、FR-LEDGER-002、FR-LEDGER-003、FR-LEDGER-004、FR-EVT-001、FR-EVT-002、FR-EVT-003、FR-QEP-001、FR-QEP-002、FR-QEP-003、FR-QEP-004、FR-QEP-005、FR-QEP-006、FR-QEP-008、FR-PLUGIN-001、FR-PLUGIN-002、FR-PLUGIN-003、FR-PLUGIN-004、FR-INTEG-001 | `src/quotagent/kernel/{ledger,events,qep,plugin,delivery}.py` | done | `events` · `invariants` · `plugin-lifecycle` · `ac AC-AUDIT-001` · `ac AC-QEP-001/002/003/004` · `ac AC-INTEG-001` · `ac AC-PLUGIN-001/004` · `req=docs/work/plugin-requirements-kernel.md` |
| `system/evidence` | FR-EVIDENCE-001、FR-EVIDENCE-002、FR-EVIDENCE-003、FR-EVIDENCE-005、FR-EVIDENCE-006 | `src/quotagent/kernel/{evidence,modelgate}.py`、`host/modules/evidence-summary.mjs` | done | `audit` · `ac AC-AUDIT-001/002` · `evolve-module`(11/11) · `EV-075` |
| `system/retention` | FR-EVIDENCE-004 | `src/quotagent/services/retention.py`、`retention_exec.py`、`tools/refresh-retention-plan.py` | done | `retention`(判定侧 AC-AUDIT-003 21 机检；执行侧 AC-AUDIT-005 22/22) · `retention-view` · `EV-089`/`EV-090` |
| `system/norm` | FR-NORM-001、FR-NORM-002、FR-NORM-003 | `src/quotagent/services/norm.py`、`host/modules/norm.mjs` | done | `modules`(fixture 521/521) · `ac AC-NORM-001/002/003` |
| `domain/quotes` | FR-NORM-004、FR-RFQ-006 | `src/quotagent/services/quotes.py`（`QuoteBook`） | done | `ac AC-RFQ-004`（标 superseded + 重报请求） · `ac AC-COMPARE-001`（版本一致性门） |
| `domain/sync` | FR-QEP-007 | `src/quotagent/services/sync.py`（`SyncService.reconcile`） | done | `ac AC-SYNC-001` |
| `system/runtime` | FR-RUNTIME-001、FR-RUNTIME-002、FR-USREQ-003 | `src/system/runtime/`（`code/index.mjs`、`tools/plugin-lifecycle.mjs`）、`tools/runtime.sh`、`tools/run.sh`、`./run` | partial | `plugin-lifecycle`(43/43) · `run-once`(18/18) · `smoke` · `ac AC-RUNTIME-002`；`FR-USREQ-003` = 矩阵 §3 已登记缺口（「像员工」无机检） · `req=src/system/runtime/requirements/README.md` |
| `system/audit-hook` | FR-RUNTIME-003 | `host/modules/audit-hook.mjs` | done | `audit-hook`(7/7) · `EV-068` |
| `system/budget-guard` | FR-RUNTIME-004 | `host/modules/budget-guard.mjs` | done | `budget-guard`(10/10) · `budget-route`(5/5) · `EV-085` |
| `system/circuit-breaker` | FR-RUNTIME-005 | `host/modules/circuit-breaker.mjs` | done | `breaker`(10/10) · `breaker-route`(4/4) · `EV-077` |
| `system/governor` | FR-RUNTIME-006 | `host/modules/governor.mjs` | done | `governor`(9/9) · `EV-067` |
| `system/observability` | FR-RUNTIME-007 | `host/modules/observability.mjs` | done | `observability`(6/6) · `EV-071` |
| `system/timeline` | FR-RUNTIME-008 | `host/modules/timeline.mjs` | done | `modules`(521/521) · `EV-038` |
| `system/idempotency-guard` | FR-RUNTIME-009 | `host/modules/idempotency-guard.mjs` | done | `idempotency-guard`(10/10) · `idem-route`(5/5) · `EV-083` |
| `system/approval` | FR-APPROVE-001、FR-APPROVE-002、FR-APPROVE-003、FR-UX-001 | `src/quotagent/services/approval.py`、`host/modules/approval-digest.mjs` | done | `ac AC-APPROVE-001/002/003` · `approval-digest`(9/9) · `EV-085` |
| `system/eval` | FR-EVAL-001、FR-EVAL-002、FR-EVAL-003、FR-EVAL-004 | `src/quotagent/services/{scenarios,evalmetrics,evaldata}.py` | done | `ac AC-EVAL-001/002` · 反例集 `docs/work/scenarios/s4-counterexamples.json`（只增不减） |
| `domain/supplier-scorecard` | FR-EVAL-005 | `host/modules/supplier-scorecard.mjs` | done | `supplier-scorecard`(10/10) · `evolve-module`(11/11) · `EV-082` |
| `system/admin` | FR-ADMIN-001、FR-ADMIN-002、FR-ADMIN-003、FR-ADMIN-004、FR-ADMIN-005、FR-ADMIN-006、FR-ADMIN-007、FR-ADMIN-008、FR-ADMIN-009、FR-ADMIN-010 | `host/modules/{admin-guard,admin-view}.mjs`、`src/quotagent/services/admin_blocks.py`、`tools/{admin-apply,refresh-admin-snapshot}.py` | done | `admin-route` · `webui`(51/51) · `ac AC-ADMIN-005/006` · `EV-085` |
| `system/config` | FR-CONFIG-001、FR-CONFIG-002、FR-USREQ-009 | `host/modules/config-view.mjs`、`host/lib/{config,config-ui,config-keys,schema,frozen}.mjs`、`tools/config-apply.py` | done | `config-route`(AC-CONFIG-001：11 条路径 401 同形 + 干跑零落盘 + `--init`) · `EV-159` |
| `system/storage` | FR-STORAGE-001、FR-STORAGE-004、FR-STORAGE-006 | `tools/storage.py`（唯一写入者）、`host/modules/storage-view.mjs` | done | `storage` · `ac AC-STORAGE-001/004/006` · `req=docs/work/plugin-requirements-storage.md` |
| `system/market` | FR-MARKET-001、FR-MARKET-002、FR-MARKET-003、FR-MARKET-004、FR-MARKET-005、FR-MARKET-006、FR-USREQ-008 | `host/modules/plugin-market.mjs` | done | `plugin-market`(AC-MARKET-001..006) · `req=docs/work/plugin-requirements-market.md` |
| `system/user-plugin-manager` | FR-USERPLUG-001、FR-USERPLUG-002、FR-USERPLUG-003、FR-USERPLUG-004、FR-USERPLUG-005、FR-USERPLUG-006、FR-USERPLUG-007、FR-USERPLUG-008、FR-USERPLUG-009、FR-USERPLUG-010、FR-USERPLUG-011、FR-USERPLUG-012 | `host/lib/user-space.mjs`、`host/modules/user-plugin-manager.mjs`、`tools/userplugin-{record,elevate}.py` | done | `user-space`(AC-USERPLUG-001..012) · `plugin-lifecycle` · `EV-082` |
| `system/agent-runtime` | FR-AGENTRT-002、FR-AGENTRT-006、FR-AGENTRT-007 | `host/modules/{agent-context,agent-memory,agent-harness}.mjs`、`tools/refresh-agent-memory.py` | done | `agent-runtime`（T-275 围栏门） · `ac AC-AGENTRT-002/006/007` |
| `system/ui-feedback` | FR-UIFB-001、FR-USREQ-006 | `host/modules/ui-feedback.mjs`、`tools/ui-feedback-{apply.py,monitor.sh,tick.sh}` | done | `ui-feedback`(28 断言 + 真 HTTP) · `ac AC-USREQ-006`(10/10) · `EV-159` |
| `system/webui` | FR-UXWEB-001、FR-UXWEB-002、FR-PLUGIN-005、FR-USREQ-001、FR-USREQ-002、FR-USREQ-004、FR-USREQ-005、FR-USREQ-011 | `host/modules/webui.mjs`、`host/lib/{ui-slot,ledger-view}.mjs`、`tools/webui-serve.py` | missing | `webui`(51/51) · `plugin-lifecycle` · `run-once` · `config-route` · `gates` · `rfq-deadline` · `ui-feedback`；**`FR-USREQ-002` 视觉零判据**（矩阵 §3 缺口）⇒ 按最弱项记 `missing` · `req=docs/work/plugin-requirements-webui.md` |
| `system/evolution` | FR-EVOLVE-001、FR-EVOLVE-002、FR-EVOLVE-003、FR-EVOLVE-004、FR-EVOLVE-006、FR-EVOLVE-007、FR-USREQ-010 | `host/lib/evolution.mjs`、`host/modules/evolve-journal.mjs`、`tools/{evolve-record,evolve-module}.mjs` | done | `evolution`(27 条含 7 负控) · `evolve-journal`(7/7) · `evolve-module`(11/11) · `EV-080` · `req=docs/work/plugin-requirements-evolution.md` |
| `system/canary` | FR-EVOLVE-005 | `host/modules/{canary,bridge-canary}.mjs`、`host/lib/canary-dispatch.mjs` | done | `canary` · `bridge-canary` · `canary-route` · `EV-070` |
| `system/mail` | FR-MAIL-001、FR-MAIL-002、FR-INTEG-003 | `src/quotagent/services/mail.py`、`mail_transport.py`、`host/modules/mail-view.mjs` | done | `mail-transport`(27 条，含回环真发收) · `mail`(AC-MAIL-001/002) · `pipeline-view` · `EV-159` · `req=docs/work/plugin-requirements-mail.md` |
| `system/relay` | FR-INTEG-002 | `src/quotagent/services/relay.py` | done | `ac AC-INTEG-002` |
| `system/kernel-bridge` | FR-INTEG-004 | `src/quotagent/bridge.py`、`host/modules/kernel-bridge.mjs`、`host/lib/bridge.mjs` | done | `bridge`(AC-INTEG-004/005/006) |
| `system/repo-gate` | FR-USREQ-007 | `tools/verify.sh`、`tools/check-*.py`、`docs/design/15-requirements-coverage.md`、`docs/work/plugin-requirements-map.md` | done | `docs` · `coverage`(8/8) · `plugin-requirements`（本批新增） · `EV-159` |
| `system/ops-view` | FR-UX-004 | `host/modules/ops-view.mjs` | done | `ops-view`(9/9) · `EV-079` |
| `system/pipeline-view` | FR-UX-005 | `host/modules/pipeline-view.mjs`、`tools/refresh-ui-snapshots.py` | done | `pipeline-view`(7/7) · `pipeline-route` · `ac AC-UI-002/003` |
| `system/projection` | FR-RFQ-009、FR-UX-002 | `host/modules/projection.mjs`、`host/lib/ledger-view.mjs`、`src/quotagent/services/realm.py` | done | `rfq-visibility`(围栏 26/26 + 真路由 10/10) · `webui`(私域负控) · `ac AC-TRUST-001` |
| `domain/rfq` | FR-RFQ-001、FR-RFQ-002、FR-RFQ-003、FR-RFQ-004、FR-RFQ-005 | `src/quotagent/services/rfq.py` | done | `ac AC-RFQ-001/002/003` |
| `domain/rfq-deadline` | FR-RFQ-008 | `host/modules/rfq-deadline.mjs`、`tools/rfq-promise.py` | done | `rfq-deadline`(围栏 23/23 + 真路由 11/11) |
| `domain/sourcing` | FR-RFQ-007 | `host/modules/sourcing.mjs` | done | `ac AC-RFQ-005` · `modules`(521/521) |
| `domain/compare` | FR-COMPARE-001、FR-COMPARE-002、FR-COMPARE-003 | `src/quotagent/services/compare.py`、`host/modules/compare.mjs` | done | `ac AC-COMPARE-002/003` · `bid-heuristics`（同口径） · `EV-039` |
| `domain/export` | FR-COMPARE-004、FR-UX-003 | `src/quotagent/services/export.py` | done | `ac AC-COMPARE-004` |
| `domain/guard` | FR-GUARD-001、FR-GUARD-002、FR-GUARD-003、FR-GUARD-004、FR-GUARD-005 | `src/quotagent/services/guard.py`、`terms.py`（条款差异下沉） | done | `ac AC-GUARD-001/002/003` |
| `domain/intake` | FR-INTAKE-001、FR-INTAKE-002、FR-INTAKE-003 | `src/quotagent/services/intake.py` | done | `ac AC-INTAKE-001/002` |
| `domain/clarify` | FR-CLARIFY-001、FR-CLARIFY-002、FR-CLARIFY-003 | `src/quotagent/services/clarify.py` | done | `ac AC-CLARIFY-001/002/003` |
| `domain/faq` | FR-CLARIFY-004 | `src/quotagent/services/faq.py`、`tools/check-faq.py` | done | `faq`(AC-FAQ-001 20/20) |
| `domain/commitments` | FR-AWARD-001、FR-AWARD-002、FR-AWARD-003 | `src/quotagent/services/commitments.py` | done | `ac AC-AWARD-001/002` |
| `domain/costmodel` | FR-COST-001、FR-COST-002、FR-COST-003 | `src/quotagent/services/costmodel.py` | done | `ac AC-COST-001` · `ac AC-TRUST-001` |
| `domain/pricing` | FR-PRICE-001、FR-PRICE-002 | `src/quotagent/services/pricing.py` | done | `ac AC-PRICE-001` |
| `domain/price-history` | FR-PRICE-003 | `host/modules/price-history.mjs` | done | `evolve-module`(11/11) · `ac AC-PRICE-002` · `EV-073` |
| `domain/deviation` | FR-DEV-001、FR-DEV-002 | `src/quotagent/services/deviation.py` | done | `ac AC-DEV-001` |
| `domain/capacity` | FR-CAP-001、FR-CAP-002 | `src/quotagent/services/capacity.py` | done | `ac AC-CAP-001` |
| `domain/change` | FR-CHANGE-001、FR-CHANGE-002 | `src/quotagent/services/change.py` | done | `ac AC-CHANGE-001/002` |
| `domain/terms` | FR-TERMS-001、FR-TERMS-002 | `src/quotagent/services/terms.py` | done | `ac AC-TERMS-001` |
| `domain/negotiation` | FR-NEGO-001、FR-NEGO-002 | `src/quotagent/services/negotiation.py`、`tools/check-negotiation.py` | done | `negotiation`(AC-NEGO-001/003，15+ 断言) |
| `domain/gate-timeline` | FR-GATE-001、FR-GATE-002 | `host/modules/gate-timeline.mjs`、`tools/gate-nudge.py` | done | `gates`(33/33 + 真路由 11/11) · `change-detail`(22/22 + 9/9) |
| `domain/authority-band` | FR-AUTH-001 | `host/modules/authority-band.mjs`、`host/lib/config-keys.mjs` | done | `authority`(22/22 + 真路由 12/12) · `EV-156` |
| `domain/advice` | FR-ADV-001、FR-USREQ-012 | `src/domain/advice/code/index.mjs`（阶段 1 wrapper → `host/modules/advice-panel.mjs`） | done | `advice`(30/30 + 真路由 14/14) · `plugin-lifecycle` · `req=src/domain/advice/requirements/README.md` |
| `domain/bid-heuristics` | FR-VIZ-001 | `host/modules/bid-heuristics.mjs` | done | `bid-heuristics`（围栏 4 变异 + 真 HTTP） |
| `domain/quote-prepare` | FR-QUOTE-001 | `host/modules/quote-prepare.mjs`、`tools/{quote-draft,quote-sign}.py` | done | `quote-draft`(17 断言 + 真路由) · `EV-161`（`T-288`） |
| `system/measures` | —（无 FR 归属） | `src/quotagent/services/measures.py`（口径数据层） | missing | **无 FR 归属**（矩阵 §2 亦无归属行）；被各口径 AC 间接覆盖 · `ac AC-NORM-001` |
| `system/qa-runner` | —（无 FR 归属） | `src/quotagent/qa/{registry.py,__main__.py,checks_*.py}` | missing | **无 FR 归属**；`ac-registry` + `ac <AC-ID>`（运行器自身） |
| `system/realm` | —（无 FR 归属） | `src/quotagent/services/realm.py` | missing | **无 FR 归属**；私域投影的**执行件**（`FR-UX-002` 主归属 `system/projection`） · `ac AC-TRUST-001` |
| `userspace/demo-ns/hello` | —（无 FR 归属） | `src/userspace/demo-ns/hello/code/index.mjs`、`user-space/demo-ns/hello/` | missing | **无 FR 归属**（用户空间样板；其 `plugin.json` 对 `FR-USERPLUG-001/002/006/009` 是**部分承载**，主归属在 `system/user-plugin-manager`） · `plugin-lifecycle` · `user-space` · `req=src/userspace/demo-ns/hello/requirements/README.md` |
| `userspace/demo-ns/badge` | —（无 FR 归属） | `src/userspace/demo-ns/badge/code/index.mjs` | missing | **无 FR 归属**（运行期装卸的取证插件，不被任何静态装配；`plugin.json` 对 `FR-USERPLUG-001/002/006`、`FR-PLUGIN-003` 是**部分承载**） · `plugin-lifecycle` · `user-space` · `req=src/userspace/demo-ns/badge/requirements/README.md` |
| `userspace/con-a/quote-trend` | —（无 FR 归属） | `src/userspace/con-a/quote-trend/code/index.mjs`（唯一事实源；`user-space/con-a/quote-trend/` 为兼容链接） | missing | **无 FR 归属**（用户空间插件；`plugin.json` 对 `FR-USERPLUG-001/002/006/009`、`FR-STORAGE-006` 是**部分承载**） · `user-space` · `storage` · `req=src/userspace/con-a/quote-trend/requirements/README.md` |

## 2. 未认领的 FR

**无**（166/166 全部有唯一主归属；`tools/verify.sh plugin-requirements` 断言"每条 FR 至少被一个插件认领" **且** "无人重复认领"）。

## 3. 与 28 §2.2/§2.3/§2.4 家族表的偏差登记

> 28 的家族表是**方案**，`15-requirements-coverage.md` 是**归属真源**（ADR-0021 §2）；两者不一致时以真源为准并逐条登记在此，**不修改 28 的原文**。
> 除下表所列，其余 FR 与 28 家族表逐条一致。

| FR | 28 家族表说 | 本表归属 | 为什么（证据） |
|---|---|---|---|
| FR-QEP-007 | system/kernel（QEP 整族） | `domain/sync` | 承载体实测 `src/quotagent/services/sync.py` 的 `SyncService.reconcile`；AC 家族 `AC-SYNC-001` 在 28 §2.3 已归 `domain/sync`，27 §1.3 把 `sync` 单列为 domain 插件 |
| FR-NORM-004 | system/norm（NORM 整族） | `domain/quotes` | 承载体实测 `services/quotes.py`（`QuoteBook.on_amended`）；"包版本与报价版本一致性门"的执行件是报价簿，归 `domain/quotes` |
| FR-RFQ-006 | domain/rfq-deadline | `domain/quotes` | 承载体实测 `services/quotes.py`（标 superseded + 重报请求）；28 §2.2 与 §2.4.2 对该族 006/008 的写法自相矛盾（见下一行） |
| FR-RFQ-008 | system/projection（§2.2 与 §2.4.2 同写） | `domain/rfq-deadline` | 判为 28 的笔误：FR 文本点名 domain 插件 `rfq-deadline`，15 §2 亦写 `rfq-deadline`，且有独立围栏门 `tools/verify.sh rfq-deadline` 与 23/23+11/11 证据 |
| FR-EVIDENCE-004 | system/evidence（EVIDENCE 整族） | `system/retention` | 承载体实测 `services/retention.py` + `retention_exec.py`，有独立门 `tools/verify.sh retention` 与独立视图 `host/modules/retention-view.mjs`；27 §1.3 把 `retention` 单列为 system 插件 |
| FR-UX-001 | system/webui（UX 整族） | `system/approval` | 承载体实测 `services/approval.py` 的 `queue_view()`；15 §2 亦把 `FR-UX-001` 记在 `approval-digest` 行 |
| FR-UX-002 | system/webui | `system/projection` | 15 §2 显式把 `FR-UX-002` 与 `AC-TRUST-001` 记在 `projection` 行；私域字段过滤的机制面是投影 |
| FR-UX-003 | system/webui | `domain/export` | 承载体实测 `services/export.py`（比价表 CSV 导出） |
| FR-UX-004 | system/webui | `system/ops-view` | 承载体实测 `host/modules/ops-view.mjs`（运维视角只读快照，"不属于任何一方"） |
| FR-UX-005 | system/webui | `system/pipeline-view` | 15 §2 显式把 `FR-UX-005` 记在 `pipeline-view` 行；承载体 `tools/refresh-ui-snapshots.py` + `host/modules/pipeline-view.mjs` |
| FR-PLUGIN-005 | 28 §2.2 只数了 PLUGIN 4 条（本 FR 晚于 28 成立） | `system/webui` | 27 §6 的"注入式 UI 契约"由 webui 提供注册面；承载体实测 `host/lib/ui-slot.mjs` + `host/modules/webui.mjs`，门 `tools/verify.sh plugin-lifecycle` 的 C/D 组 |
| FR-USREQ-001..011 | 28 §2.4.3 是**多插件**列表（无唯一归属） | 取该表**首个**插件为主归属（001/002/004/005/011 → `system/webui`；003 → `system/runtime`；006 → `system/ui-feedback`；007 → `system/repo-gate`；008 → `system/market`；009 → `system/config`；010 → `system/evolution`） | 唯一指针要求"每条 FR 只出现一次"；共同参与方**不删**，写在证据列 |
| 插件自己的 `requirements/`（含 `plugin.json.requirements`）| — | 主归属仍以本表为准 | 插件文件里对某条 FR 的声明是"本插件承担的**部分**"（27 §2.1 允许），**不是**主归属：例 `src/system/runtime/requirements/README.md` 声明 `FR-PLUGIN-001/002/003`；`src/userspace/demo-ns/hello`、`demo-ns/badge`、`con-a/quote-trend` 的 `plugin.json` 各声明 `FR-USERPLUG-*` 等。唯一指针只看本表与矩阵 |

## 4. 缺口清单（尚未建独立需求文档的插件）

> 本批（`T-316`）为 **9** 个插件写了独立需求文档：3 个样板在标准位置（`src/system/runtime/requirements/README.md`、`src/domain/advice/requirements/README.md`、`src/userspace/demo-ns/hello/requirements/README.md`），6 个核心在 `docs/work/plugin-requirements-<插件>.md`（位置偏差逐条登记在 §4.2）。
> 另有 **2** 个用户空间插件（`userspace/demo-ns/badge`、`userspace/con-a/quote-trend`）的需求文档由**并发批次**（`docs/work/plans/plugin-migration-plan.md` 阶段 5.1，同工作树在飞）写在标准位置 `src/userspace/<ns>/<插件>/requirements/README.md` —— 它们按"文档真实存在"标了 `req=`，本批**只登记归属、不动它们的文件**。
> **其余 52 个插件尚未建需求文档**，逐条列在此（**不得当作已建**）。修复口径：`docs/work/plans/plugin-migration-plan.md` 阶段 2/3/4 逐插件搬迁时，把该插件的 FR 行连同验收命令落进 `src/<层>/<插件>/requirements/README.md`（模板 = `docs/work/plugin-requirements-kernel.md`）。
> 机检：`tools/verify.sh plugin-requirements` 断言「有 `requirements/` 目录的插件**都在本表有行**（目录不无主）」「每个 `req=` 指向的文档**真实存在**」「未标 `req=` 的插件**逐条列在本节**」「`req=` 指向标准位置之外的插件**逐条列在 §4.2**」。

| 层 | 插件 id（逐个列） | 数量 | 缺什么 |
|---|---|---|---|
| system | `evidence` `retention` `norm` `audit-hook` `budget-guard` `circuit-breaker` `governor` `observability` `timeline` `idempotency-guard` `approval` `eval` `admin` `config` `user-plugin-manager` `agent-runtime` `ui-feedback` `canary` `relay` `kernel-bridge` `repo-gate` `ops-view` `pipeline-view` `projection` `measures` `qa-runner` `realm` | 27 | `src/system/<插件>/requirements/README.md`（骨架未建；FR 行与门命令已在本表） |
| domain | `quotes` `sync` `supplier-scorecard` `rfq` `rfq-deadline` `sourcing` `compare` `export` `guard` `intake` `clarify` `faq` `commitments` `costmodel` `pricing` `price-history` `deviation` `capacity` `change` `terms` `negotiation` `gate-timeline` `authority-band` `bid-heuristics` `quote-prepare` | 25 | `src/domain/<插件>/requirements/README.md`（骨架未建） |
| userspace | —（两个用户空间插件的需求文档由并发批次写在标准位置，见上） | 0 | — |
| 合计 | — | 52 | — |

### 4.2 需求文档**不在标准布局位置**的插件（6 个，逐条登记）

> 27 §2.1 的标准形态是 `src/<层>/<插件>/requirements/README.md`。下列 6 个插件的**独立需求文档已写好**
> （内容与标准形态同形：用途 / 归属行 / 对外契约 / 验收命令），但落在 `docs/work/plugin-requirements-<插件>.md`，**不在**标准位置。
> 原因（实测，不是推测）：这 6 个插件**尚无插件目录**（迁移阶段 2–4 才建），而**先建裸目录**会让 `tools/verify.sh plugin-lifecycle` 的两条断言变红 ——
> 该门 A13/A14 断言「`domain/advice` 的依赖 `system/webui` **未就绪 ⇒ 非激活**」（`deps_missing=["system/webui"]`、`deps_ready=false`），
> 而 `plugin-registry` 的 `depsClosure` 把"目录存在"当作"插件存在"（实测：建出 `src/system/webui/` 后 `deps_missing=[]`、`deps_ready=true`）。
> 本仓铁律是**不得把门改松**，本批也不越权改迁移批次的判据 ⇒ 文档改落 `docs/work/`，建目录时 `git mv` 进 `requirements/README.md`。
> 这条通路差异是**迁移批次的已知交互**：阶段 0.2/4.1 建目录时，`plugin-lifecycle` 的 A13/A14 必须同步更新
> （或把 `depsClosure` 改为"没有 `plugin.json` 的目录不算已知插件"，与 27 §3.3 对齐）。

| 插件 id | 需求文档（现状） | 建目录后应搬到 |
|---|---|---|
| `system/webui` | `docs/work/plugin-requirements-webui.md` | `src/system/webui/requirements/README.md` |
| `system/storage` | `docs/work/plugin-requirements-storage.md` | `src/system/storage/requirements/README.md` |
| `system/market` | `docs/work/plugin-requirements-market.md` | `src/system/market/requirements/README.md` |
| `system/evolution` | `docs/work/plugin-requirements-evolution.md` | `src/system/evolution/requirements/README.md` |
| `system/mail` | `docs/work/plugin-requirements-mail.md` | `src/system/mail/requirements/README.md` |
| `system/kernel` | `docs/work/plugin-requirements-kernel.md` | `src/system/kernel/requirements/README.md` |

## 5. 复算与计数（可复核）

```bash
# 状态计数：只数 §1 的数据行（§4.2 是另一张表，用区间切出来，避免"69 行"的误读）
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c '^| `'       # 63（插件全集）
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c ' done '      # 55
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c ' partial '   # 1（system/runtime）
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c ' missing '   # 7
grep -oE 'req=[a-zA-Z0-9_./-]+' docs/work/plugin-requirements-map.md | sort -u | wc -l     # 11
# FR 定义集合规模（**定义行**口径：主文件 + 同目录归档）
grep -chE '^\| FR-' docs/work/functional-requirements*.md | awk '{s+=$1} END {print s}'    # 166
# 唯一指针：只看第 3 个 pipe 字段（"负责的 FR 号"列）——总数与去重数都必须 166
python3 -c "
import re
rows=[l for l in open('docs/work/plugin-requirements-map.md') if l.startswith('| \`')]
frs=[f for l in rows for f in re.findall(r'FR-[A-Z]+-[0-9]{3}', l.split('|')[2])]
print(len(frs), len(set(frs)))"                                                            # 166 166
# 门的自检（同一套口径 + 4 处单点变异 + 产品树字节不变）
tools/verify.sh plugin-requirements
```

> 注意两个**易误读**的口径：① §1 的**证据列**会提到别的插件的 FR（"部分承载"注释），所以"全文 grep FR" 会多出 8 处重复 —— 唯一指针只看**第 3 个 pipe 字段**；
> ② `grep -c '^| \`'` 全文数是 69（63 + §4.2 的 6 行），插件全集是 **63**。

| 计数 | 值 |
|---|---|
| 插件行 | 63（system 34 + domain 26 + userspace 3） |
| 认领 FR | 166 / 166（未认领 0） |
| 状态 | done 55 · partial 1 · missing 7 |
| 已建需求文档 | 11（本批 9 份：3 在标准位置 + 6 在 `docs/work/plugin-requirements-*.md`；另 2 份由并发批次写在标准位置） |
| 缺需求文档 | 52（§4.1 逐条列） |
| 文档位置偏差 | 6（§4.2 逐条登记：尚无插件目录，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红） |
| 机检 | `tools/verify.sh plugin-requirements` |
