# 插件 ↔ 需求映射表（每条 FR 的**唯一**归属插件）

<!-- budget: 32 KB（`docs/work/*.md` 行）。规则真源 = `docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`。
     位置口径真源 = `docs/design/27-plugin-architecture.md` §2.4（本批 T-318 起命名一律 `docs/work/plugin-requirements-<层>-<插件>.md`）。
     机检：`tools/verify.sh plugin-requirements`（四条断言 + 4 处单点变异，见 `tools/check-plugin-requirements.py`）。 -->

## 0. 口径（怎么读这张表）

1. **一行一插件**，即"全部插件的一行索引表"：`插件 id（层/名） | 负责的 FR 号 | 承载文件 | 状态 | 证据`。插件 id 一律写 `层次/插件`（userspace 写 `userspace/<ns>/<插件>`，与 `tools/plugin.sh` 同一套形状，见 27 §4.2）。
2. **唯一指针**：FR 定义集合（`docs/work/functional-requirements.md` + `functional-requirements-archive*.md`）里的**每条 FR 恰好出现一次**。多插件共同参与时本表只写**主归属**（谁负责提供），共同参与方写在证据列（例：`FR-USREQ-001` 主归属 `system/webui`，另参与 `system/ui-feedback` / `domain/gate-timeline` / `domain/rfq-deadline`）。
3. **归属怎么定**（按序，可复算）：① `15-requirements-coverage.md` §1 的**承载体实测**折算插件 id（ADR-0021 §2：「归属真源是覆盖矩阵」）；② 该矩阵 §2「插件归属」的显式名单；③ 28 §2.2/§2.3/§2.4 的家族表。与 28 家族表不一致的逐条登记在 §3（**不得悄悄偏离**）。
4. **状态**：`done` = 名下每条 FR 都有真门且无登记缺口；`partial` = 有真证据但有**已登记**缺口；`missing` = 名下至少一条 FR **没有任何证据**，**或**该插件尚无 FR 归属（需求未编号）。缺口逐条在 15 §3、本表 §3/§4 与 `docs/work/requirements-traceability.md`。
5. **证据列**：门名（真跑 `tools/verify.sh <门名>`）· `ac <AC-ID>`（`tools/verify.sh ac <AC-ID>`）· `EV-` 条目 · `req=<path>`（该插件的**独立需求文档**，路径必须真实存在）。标准形态 = `src/<层>/<插件>/requirements/README.md`（27 §2.1）；`T-321` 起 **63/63 全部在标准位置**（`T-318` 的 `docs/work/plugin-requirements-<层>-<插件>.md` 过渡形态已结束，归位台账见 §4.2，逐条 sha256 见 `docs/work/evidence/EV-172-*`）。**没有证据的行不得写 `done`**。
6. **与 `requirements/README.md` 的分工**：本表是**归属真源**（谁负责 + 状态 + 证据），插件自己的 `requirements/README.md` 只写该插件的 FR 行与可执行命令（27 §2.1；`tools/verify.sh plugin-requirements` 断言：有 `requirements/` 目录的插件在本表有行且标了 `req=`、每个 `req=` 指向的文件真实存在、**不在标准布局的逐条登上 §4.2 台账**，台账 ∪ 原生标准位置名单 == 全部有 `req=` 的插件）。

## 1. 插件 ↔ FR（63 行 = 当前插件全集）

| 插件 id（层/名） | 负责的 FR 号 | 承载文件 | 状态 | 证据 |
|---|---|---|---|---|
| `system/kernel` | FR-LEDGER-001、FR-LEDGER-002、FR-LEDGER-003、FR-LEDGER-004、FR-EVT-001、FR-EVT-002、FR-EVT-003、FR-QEP-001、FR-QEP-002、FR-QEP-003、FR-QEP-004、FR-QEP-005、FR-QEP-006、FR-QEP-008、FR-PLUGIN-001、FR-PLUGIN-002、FR-PLUGIN-003、FR-PLUGIN-004、FR-INTEG-001 | `src/system/kernel/code/{ledger,events,qep,plugin,delivery}.py`（旧路径 `src/quotagent/kernel/**` 留薄重导，EV-173） | done | `events` · `invariants` · `plugin-lifecycle` · `ac AC-AUDIT-001` · `ac AC-QEP-001/002/003/004` · `ac AC-INTEG-001` · `ac AC-PLUGIN-001/004` · `req=src/system/kernel/requirements/README.md` |
| `system/evidence` | FR-EVIDENCE-001、FR-EVIDENCE-002、FR-EVIDENCE-003、FR-EVIDENCE-005、FR-EVIDENCE-006 | `src/system/kernel/code/{evidence,modelgate}.py`、`host/modules/evidence-summary.mjs` | done | `audit` · `ac AC-AUDIT-001/002` · `evolve-module`(11/11) · `EV-075` · `req=src/system/evidence/requirements/README.md` |
| `system/retention` | FR-EVIDENCE-004 | `src/quotagent/services/retention.py`、`retention_exec.py`、`tools/refresh-retention-plan.py` | done | `retention`(判定侧 AC-AUDIT-003 21 机检；执行侧 AC-AUDIT-005 22/22) · `retention-view` · `EV-089`/`EV-090` · `req=src/system/retention/requirements/README.md` |
| `system/norm` | FR-NORM-001、FR-NORM-002、FR-NORM-003 | `src/quotagent/services/norm.py`、`host/modules/norm.mjs` | done | `modules`(fixture 521/521) · `ac AC-NORM-001/002/003` · `req=src/system/norm/requirements/README.md` |
| `domain/quotes` | FR-NORM-004、FR-RFQ-006 | `src/quotagent/services/quotes.py`（`QuoteBook`） | done | `ac AC-RFQ-004`（标 superseded + 重报请求） · `ac AC-COMPARE-001`（版本一致性门） · `req=src/domain/quotes/requirements/README.md` |
| `domain/sync` | FR-QEP-007 | `src/quotagent/services/sync.py`（`SyncService.reconcile`） | done | `ac AC-SYNC-001` · `req=src/domain/sync/requirements/README.md` |
| `system/runtime` | FR-RUNTIME-001、FR-RUNTIME-002、FR-USREQ-003 | `src/system/runtime/`（`code/index.mjs`、`tools/plugin-lifecycle.mjs`）、`tools/runtime.sh`、`tools/run.sh`、`./run` | partial | `plugin-lifecycle`(43/43) · `run-once`(18/18) · `smoke` · `ac AC-RUNTIME-002`；`FR-USREQ-003` = 矩阵 §3 已登记缺口（「像员工」无机检） · `req=src/system/runtime/requirements/README.md` |
| `system/audit-hook` | FR-RUNTIME-003 | `host/modules/audit-hook.mjs` | done | `audit-hook`(7/7) · `EV-068` · `req=src/system/audit-hook/requirements/README.md` |
| `system/budget-guard` | FR-RUNTIME-004 | `host/modules/budget-guard.mjs` | done | `budget-guard`(10/10) · `budget-route`(5/5) · `EV-085` · `req=src/system/budget-guard/requirements/README.md` |
| `system/circuit-breaker` | FR-RUNTIME-005 | `host/modules/circuit-breaker.mjs` | done | `breaker`(10/10) · `breaker-route`(4/4) · `EV-077` · `req=src/system/circuit-breaker/requirements/README.md` |
| `system/governor` | FR-RUNTIME-006 | `host/modules/governor.mjs` | done | `governor`(9/9) · `EV-067` · `req=src/system/governor/requirements/README.md` |
| `system/observability` | FR-RUNTIME-007 | `host/modules/observability.mjs` | done | `observability`(6/6) · `EV-071` · `req=src/system/observability/requirements/README.md` |
| `system/timeline` | FR-RUNTIME-008 | `host/modules/timeline.mjs` | done | `modules`(521/521) · `EV-038` · `req=src/system/timeline/requirements/README.md` |
| `system/idempotency-guard` | FR-RUNTIME-009 | `host/modules/idempotency-guard.mjs` | done | `idempotency-guard`(10/10) · `idem-route`(5/5) · `EV-083` · `req=src/system/idempotency-guard/requirements/README.md` |
| `system/approval` | FR-APPROVE-001、FR-APPROVE-002、FR-APPROVE-003、FR-UX-001 | `src/quotagent/services/approval.py`、`host/modules/approval-digest.mjs` | done | `ac AC-APPROVE-001/002/003` · `approval-digest`(9/9) · `EV-085` · `req=src/system/approval/requirements/README.md` |
| `system/eval` | FR-EVAL-001、FR-EVAL-002、FR-EVAL-003、FR-EVAL-004 | `src/quotagent/services/{scenarios,evalmetrics,evaldata}.py` | done | `ac AC-EVAL-001/002` · 反例集 `docs/work/scenarios/s4-counterexamples.json`（只增不减） · `req=src/system/eval/requirements/README.md` |
| `domain/supplier-scorecard` | FR-EVAL-005 | `host/modules/supplier-scorecard.mjs` | done | `supplier-scorecard`(10/10) · `evolve-module`(11/11) · `EV-082` · `req=src/domain/supplier-scorecard/requirements/README.md` |
| `system/admin` | FR-ADMIN-001、FR-ADMIN-002、FR-ADMIN-003、FR-ADMIN-004、FR-ADMIN-005、FR-ADMIN-006、FR-ADMIN-007、FR-ADMIN-008、FR-ADMIN-009、FR-ADMIN-010 | `host/modules/{admin-guard,admin-view}.mjs`、`src/quotagent/services/admin_blocks.py`、`tools/{admin-apply,refresh-admin-snapshot}.py` | done | `admin-route` · `webui`(51/51) · `ac AC-ADMIN-005/006` · `EV-085` · `req=src/system/admin/requirements/README.md` |
| `system/config` | FR-CONFIG-001、FR-CONFIG-002、FR-USREQ-009 | `host/modules/config-view.mjs`、`host/lib/{config,config-ui,config-keys,schema,frozen}.mjs`、`src/system/config/tools/config-apply.py` | done | `config-route`(AC-CONFIG-001：11 条路径 401 同形 + 干跑零落盘 + `--init`) · `EV-159` · `req=src/system/config/requirements/README.md` |
| `system/storage` | FR-STORAGE-001、FR-STORAGE-004、FR-STORAGE-006 | `tools/storage.py`（唯一写入者）、`host/modules/storage-view.mjs` | done | `storage` · `ac AC-STORAGE-001/004/006` · `req=src/system/storage/requirements/README.md` |
| `system/market` | FR-MARKET-001、FR-MARKET-002、FR-MARKET-003、FR-MARKET-004、FR-MARKET-005、FR-MARKET-006、FR-USREQ-008 | `host/modules/plugin-market.mjs` | done | `plugin-market`(AC-MARKET-001..006) · `req=src/system/market/requirements/README.md` |
| `system/user-plugin-manager` | FR-USERPLUG-001、FR-USERPLUG-002、FR-USERPLUG-003、FR-USERPLUG-004、FR-USERPLUG-005、FR-USERPLUG-006、FR-USERPLUG-007、FR-USERPLUG-008、FR-USERPLUG-009、FR-USERPLUG-010、FR-USERPLUG-011、FR-USERPLUG-012 | `host/lib/user-space.mjs`、`host/modules/user-plugin-manager.mjs`、`tools/userplugin-{record,elevate}.py` | done | `user-space`(AC-USERPLUG-001..012) · `plugin-lifecycle` · `EV-082` · `req=src/system/user-plugin-manager/requirements/README.md` |
| `system/agent-runtime` | FR-AGENTRT-002、FR-AGENTRT-006、FR-AGENTRT-007 | `host/modules/{agent-context,agent-memory,agent-harness}.mjs`、`tools/refresh-agent-memory.py` | done | `agent-runtime`（T-275 围栏门） · `ac AC-AGENTRT-002/006/007` · `req=src/system/agent-runtime/requirements/README.md` |
| `system/ui-feedback` | FR-UIFB-001、FR-USREQ-006 | `host/modules/ui-feedback.mjs`、`tools/ui-feedback-{apply.py,monitor.sh,tick.sh}` | done | `ui-feedback`(28 断言 + 真 HTTP) · `ac AC-USREQ-006`(10/10) · `EV-159` · `req=src/system/ui-feedback/requirements/README.md` |
| `system/webui` | FR-UXWEB-001、FR-UXWEB-002、FR-PLUGIN-005、FR-USREQ-001、FR-USREQ-002、FR-USREQ-004、FR-USREQ-005、FR-USREQ-011 | `host/modules/webui.mjs`、`host/lib/{ui-slot,ledger-view}.mjs`、`src/system/webui/tools/webui-serve.py` | missing | `webui`(51/51) · `plugin-lifecycle` · `run-once` · `config-route` · `gates` · `rfq-deadline` · `ui-feedback`；**`FR-USREQ-002` 视觉零判据**（矩阵 §3 缺口）⇒ 按最弱项记 `missing` · `req=src/system/webui/requirements/README.md` |
| `system/evolution` | FR-EVOLVE-001、FR-EVOLVE-002、FR-EVOLVE-003、FR-EVOLVE-004、FR-EVOLVE-006、FR-EVOLVE-007、FR-USREQ-010 | `host/lib/evolution.mjs`、`host/modules/evolve-journal.mjs`、`tools/{evolve-record,evolve-module}.mjs` | done | `evolution`(27 条含 7 负控) · `evolve-journal`(7/7) · `evolve-module`(11/11) · `EV-080` · `req=src/system/evolution/requirements/README.md` |
| `system/canary` | FR-EVOLVE-005 | `host/modules/{canary,bridge-canary}.mjs`、`host/lib/canary-dispatch.mjs` | done | `canary` · `bridge-canary` · `canary-route` · `EV-070` · `req=src/system/canary/requirements/README.md` |
| `system/mail` | FR-MAIL-001、FR-MAIL-002、FR-INTEG-003 | `src/quotagent/services/mail.py`、`mail_transport.py`、`host/modules/mail-view.mjs` | done | `mail-transport`(27 条，含回环真发收) · `mail`(AC-MAIL-001/002) · `pipeline-view` · `EV-159` · `req=src/system/mail/requirements/README.md` |
| `system/relay` | FR-INTEG-002 | `src/quotagent/services/relay.py` | done | `ac AC-INTEG-002` · `req=src/system/relay/requirements/README.md` |
| `system/kernel-bridge` | FR-INTEG-004 | `src/quotagent/bridge.py`、`host/modules/kernel-bridge.mjs`、`host/lib/bridge.mjs` | done | `bridge`(AC-INTEG-004/005/006) · `req=src/system/kernel-bridge/requirements/README.md` |
| `system/repo-gate` | FR-USREQ-007 | `tools/verify.sh`、`tools/check-*.py`、`docs/design/15-requirements-coverage.md`、`docs/work/plugin-requirements-map.md` | done | `docs` · `coverage`(8/8) · `plugin-requirements`（本批新增） · `EV-159` · `req=src/system/repo-gate/requirements/README.md` |
| `system/ops-view` | FR-UX-004 | `host/modules/ops-view.mjs` | done | `ops-view`(9/9) · `EV-079` · `req=src/system/ops-view/requirements/README.md` |
| `system/pipeline-view` | FR-UX-005 | `host/modules/pipeline-view.mjs`、`src/system/webui/tools/refresh-ui-snapshots.py` | done | `pipeline-view`(7/7) · `pipeline-route` · `req=src/system/pipeline-view/requirements/README.md` |
| `system/projection` | FR-RFQ-009、FR-UX-002 | `host/modules/projection.mjs`、`host/lib/ledger-view.mjs`、`src/quotagent/services/realm.py` | done | `rfq-visibility`(围栏 26/26 + 真路由 10/10) · `webui`(私域负控) · `ac AC-TRUST-001` · `req=src/system/projection/requirements/README.md` |
| `domain/rfq` | FR-RFQ-001、FR-RFQ-002、FR-RFQ-003、FR-RFQ-004、FR-RFQ-005 | `src/quotagent/services/rfq.py` | done | `ac AC-RFQ-001/002/003` · `req=src/domain/rfq/requirements/README.md` |
| `domain/rfq-deadline` | FR-RFQ-008 | `host/modules/rfq-deadline.mjs`、`tools/rfq-promise.py` | done | `rfq-deadline`(围栏 23/23 + 真路由 11/11) · `req=src/domain/rfq-deadline/requirements/README.md` |
| `domain/sourcing` | FR-RFQ-007 | `host/modules/sourcing.mjs` | done | `ac AC-RFQ-005` · `modules`(521/521) · `req=src/domain/sourcing/requirements/README.md` |
| `domain/compare` | FR-COMPARE-001、FR-COMPARE-002、FR-COMPARE-003 | `src/quotagent/services/compare.py`、`host/modules/compare.mjs` | done | `ac AC-COMPARE-002/003` · `bid-heuristics`（同口径） · `EV-039` · `req=src/domain/compare/requirements/README.md` |
| `domain/export` | FR-COMPARE-004、FR-UX-003 | `src/quotagent/services/export.py` | done | `ac AC-COMPARE-004` · `req=src/domain/export/requirements/README.md` |
| `domain/guard` | FR-GUARD-001、FR-GUARD-002、FR-GUARD-003、FR-GUARD-004、FR-GUARD-005 | `src/quotagent/services/guard.py`、`terms.py`（条款差异下沉） | done | `ac AC-GUARD-001/002/003` · `req=src/domain/guard/requirements/README.md` |
| `domain/intake` | FR-INTAKE-001、FR-INTAKE-002、FR-INTAKE-003 | `src/quotagent/services/intake.py` | done | `ac AC-INTAKE-001/002` · `req=src/domain/intake/requirements/README.md` |
| `domain/clarify` | FR-CLARIFY-001、FR-CLARIFY-002、FR-CLARIFY-003 | `src/quotagent/services/clarify.py` | done | `ac AC-CLARIFY-001/002/003` · `req=src/domain/clarify/requirements/README.md` |
| `domain/faq` | FR-CLARIFY-004 | `src/quotagent/services/faq.py`、`tools/check-faq.py` | done | `faq`(AC-FAQ-001 20/20) · `req=src/domain/faq/requirements/README.md` |
| `domain/commitments` | FR-AWARD-001、FR-AWARD-002、FR-AWARD-003 | `src/quotagent/services/commitments.py` | done | `ac AC-AWARD-001/002` · `req=src/domain/commitments/requirements/README.md` |
| `domain/costmodel` | FR-COST-001、FR-COST-002、FR-COST-003 | `src/quotagent/services/costmodel.py` | done | `ac AC-COST-001` · `ac AC-TRUST-001` · `req=src/domain/costmodel/requirements/README.md` |
| `domain/pricing` | FR-PRICE-001、FR-PRICE-002 | `src/quotagent/services/pricing.py` | done | `ac AC-PRICE-001` · `req=src/domain/pricing/requirements/README.md` |
| `domain/price-history` | FR-PRICE-003 | `host/modules/price-history.mjs` | done | `evolve-module`(11/11) · `ac AC-PRICE-002` · `EV-073` · `req=src/domain/price-history/requirements/README.md` |
| `domain/deviation` | FR-DEV-001、FR-DEV-002 | `src/quotagent/services/deviation.py` | done | `ac AC-DEV-001` · `req=src/domain/deviation/requirements/README.md` |
| `domain/capacity` | FR-CAP-001、FR-CAP-002 | `src/quotagent/services/capacity.py` | done | `ac AC-CAP-001` · `req=src/domain/capacity/requirements/README.md` |
| `domain/change` | FR-CHANGE-001、FR-CHANGE-002 | `src/quotagent/services/change.py` | done | `ac AC-CHANGE-001/002` · `req=src/domain/change/requirements/README.md` |
| `domain/terms` | FR-TERMS-001、FR-TERMS-002 | `src/quotagent/services/terms.py` | done | `ac AC-TERMS-001` · `req=src/domain/terms/requirements/README.md` |
| `domain/negotiation` | FR-NEGO-001、FR-NEGO-002 | `src/quotagent/services/negotiation.py`、`tools/check-negotiation.py` | done | `negotiation`(AC-NEGO-001/003，15+ 断言) · `req=src/domain/negotiation/requirements/README.md` |
| `domain/gate-timeline` | FR-GATE-001、FR-GATE-002 | `host/modules/gate-timeline.mjs`、`tools/gate-nudge.py` | done | `gates`(33/33 + 真路由 11/11) · `change-detail`(22/22 + 9/9) · `req=src/domain/gate-timeline/requirements/README.md` |
| `domain/authority-band` | FR-AUTH-001 | `host/modules/authority-band.mjs`、`host/lib/config-keys.mjs` | done | `authority`(22/22 + 真路由 12/12) · `EV-156` · `req=src/domain/authority-band/requirements/README.md` |
| `domain/advice` | FR-ADV-001、FR-USREQ-012 | `src/domain/advice/code/index.mjs`（阶段 1 wrapper → `host/modules/advice-panel.mjs`） | done | `advice`(30/30 + 真路由 14/14) · `plugin-lifecycle` · `req=src/domain/advice/requirements/README.md` |
| `domain/bid-heuristics` | FR-VIZ-001 | `host/modules/bid-heuristics.mjs` | done | `bid-heuristics`（围栏 4 变异 + 真 HTTP） · `req=src/domain/bid-heuristics/requirements/README.md` |
| `domain/quote-prepare` | FR-QUOTE-001 | `host/modules/quote-prepare.mjs`、`tools/{quote-draft,quote-sign}.py` | done | `quote-draft`(17 断言 + 真路由) · `EV-161`（`T-288`） · `req=src/domain/quote-prepare/requirements/README.md` |
| `system/measures` | —（无 FR 归属） | `src/quotagent/services/measures.py`（口径数据层） | missing | **无 FR 归属**（矩阵 §2 亦无归属行）；被各口径 AC 间接覆盖 · `ac AC-NORM-001` · `req=src/system/measures/requirements/README.md` |
| `system/qa-runner` | —（无 FR 归属） | `src/quotagent/qa/{registry.py,__main__.py,checks_*.py}` | missing | **无 FR 归属**；`ac-registry` + `ac <AC-ID>`（运行器自身） · `req=src/system/qa-runner/requirements/README.md` |
| `system/realm` | —（无 FR 归属） | `src/quotagent/services/realm.py` | missing | **无 FR 归属**；私域投影的**执行件**（`FR-UX-002` 主归属 `system/projection`） · `ac AC-TRUST-001` · `req=src/system/realm/requirements/README.md` |
| `userspace/demo-ns/hello` | —（无 FR 归属） | `src/userspace/demo-ns/hello/code/index.mjs`、`user-space/demo-ns/hello/` | missing | **无 FR 归属**（用户空间样板；其 `plugin.json` 对 `FR-USERPLUG-001/002/006/009` 是**部分承载**，主归属在 `system/user-plugin-manager`） · `plugin-lifecycle` · `user-space` · `req=src/userspace/demo-ns/hello/requirements/README.md` |
| `userspace/demo-ns/badge` | —（无 FR 归属） | `src/userspace/demo-ns/badge/code/index.mjs` | missing | **无 FR 归属**（运行期装卸的取证插件，不被任何静态装配；`plugin.json` 对 `FR-USERPLUG-001/002/006`、`FR-PLUGIN-003` 是**部分承载**） · `plugin-lifecycle` · `user-space` · `req=src/userspace/demo-ns/badge/requirements/README.md` |
| `userspace/con-a/quote-trend` | —（无 FR 归属） | `src/userspace/con-a/quote-trend/code/index.mjs`（唯一事实源；`user-space/con-a/quote-trend/` 为兼容链接） | missing | **无 FR 归属**（用户空间插件；`plugin.json` 对 `FR-USERPLUG-001/002/006/009`、`FR-STORAGE-006` 是**部分承载**） · `user-space` · `storage` · `req=src/userspace/con-a/quote-trend/requirements/README.md` |

## 2. 未认领的 FR

**无**（166/166 全部有唯一主归属；`tools/verify.sh plugin-requirements` 断言"每条 FR 至少被一个插件认领" **且** "无人重复认领"）。

## 3. 与 28 §2.2/§2.3/§2.4 家族表的偏差登记

**本节的表已整表拆到 `docs/work/plugin-requirements-deviations.md`**（同批 `T-318`：映射表 36.5 KB > 32 KB 预算 ⇒ 按 12 §1 的顺序「拆文件」）。
口径不变：28 的家族表是**方案**，`docs/design/15-requirements-coverage.md` 是**归属真源**（ADR-0021 §2），不一致时以真源为准并逐条登记，**不修改 28 的原文**。

## 4. 需求文档位置与缺口（`T-321` 起**全部在标准布局**）

> **位置口径**：标准位置 = `src/<层>/<插件>/requirements/README.md`（27 §2.1/§2.4）。`T-318` 的过渡形态
> （落 `docs/work/plugin-requirements-<层>-<插件>.md`）已在 `T-321` 结束：58 份 `git mv` 归位、**逐字节不变**
> （每条 `原位置 → 现位置` 与 sha256 见 `docs/work/evidence/EV-172-*`）。机检 = `plugin-requirements` 的 A6a/A6c/A7。

### 4.1 缺口清单（尚未建独立需求文档的插件）

**无**（缺口数 **0**：63 个插件全部有 `req=`；数字由 §5 复算命令算出，不手写）。
机检 A7 是**双向**断言：「没有需求文档的插件集合 == 本清单里的插件集合」，任一侧多写/少写即红。

### 4.2 归位台账（58 份从 `docs/work/` 搬到标准布局，逐条登记）

> 机检 **A6c**（三条都**双向**）：① **不在标准布局位置**的 `req=` 逐条登记（状态写 `未归位`），台账不许多出；
> ② **台账 ∪ 本节「原生就在标准位置」名单 == 全部有 `req=` 的插件**（63；一条不漏、一条不多）；
> ③ 每条台账**由规则核对**：原位置 = `docs/work/plugin-requirements-<层>-<插件>.md`（`userspace/<ns>/<插件>` 写
> `plugin-requirements-userspace-<ns>-<插件>.md`）—— 状态 `已归位` 要求**原位置已不存在**、现位置**真实存在**
> 且与 §1 的 `req=` 同一文件。为什么当初放 `docs/work/`：那时 `depsClosure` 把「目录存在」当「插件存在」，
> 先建插件目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 目录可以建了。
> **原生就在标准位置（从未搬动，故不入台账）的 5 个**：`system/runtime`、`domain/advice`、`userspace/demo-ns/hello`、`userspace/demo-ns/badge`、`userspace/con-a/quote-trend`。

| 插件 id | 现位置（标准布局） | 状态 |
|---|---|---|
| `domain/authority-band` | `src/domain/authority-band/requirements/README.md` | 已归位 |
| `domain/bid-heuristics` | `src/domain/bid-heuristics/requirements/README.md` | 已归位 |
| `domain/capacity` | `src/domain/capacity/requirements/README.md` | 已归位 |
| `domain/change` | `src/domain/change/requirements/README.md` | 已归位 |
| `domain/clarify` | `src/domain/clarify/requirements/README.md` | 已归位 |
| `domain/commitments` | `src/domain/commitments/requirements/README.md` | 已归位 |
| `domain/compare` | `src/domain/compare/requirements/README.md` | 已归位 |
| `domain/costmodel` | `src/domain/costmodel/requirements/README.md` | 已归位 |
| `domain/deviation` | `src/domain/deviation/requirements/README.md` | 已归位 |
| `domain/export` | `src/domain/export/requirements/README.md` | 已归位 |
| `domain/faq` | `src/domain/faq/requirements/README.md` | 已归位 |
| `domain/gate-timeline` | `src/domain/gate-timeline/requirements/README.md` | 已归位 |
| `domain/guard` | `src/domain/guard/requirements/README.md` | 已归位 |
| `domain/intake` | `src/domain/intake/requirements/README.md` | 已归位 |
| `domain/negotiation` | `src/domain/negotiation/requirements/README.md` | 已归位 |
| `domain/price-history` | `src/domain/price-history/requirements/README.md` | 已归位 |
| `domain/pricing` | `src/domain/pricing/requirements/README.md` | 已归位 |
| `domain/quote-prepare` | `src/domain/quote-prepare/requirements/README.md` | 已归位 |
| `domain/quotes` | `src/domain/quotes/requirements/README.md` | 已归位 |
| `domain/rfq` | `src/domain/rfq/requirements/README.md` | 已归位 |
| `domain/rfq-deadline` | `src/domain/rfq-deadline/requirements/README.md` | 已归位 |
| `domain/sourcing` | `src/domain/sourcing/requirements/README.md` | 已归位 |
| `domain/supplier-scorecard` | `src/domain/supplier-scorecard/requirements/README.md` | 已归位 |
| `domain/sync` | `src/domain/sync/requirements/README.md` | 已归位 |
| `domain/terms` | `src/domain/terms/requirements/README.md` | 已归位 |
| `system/admin` | `src/system/admin/requirements/README.md` | 已归位 |
| `system/agent-runtime` | `src/system/agent-runtime/requirements/README.md` | 已归位 |
| `system/approval` | `src/system/approval/requirements/README.md` | 已归位 |
| `system/audit-hook` | `src/system/audit-hook/requirements/README.md` | 已归位 |
| `system/budget-guard` | `src/system/budget-guard/requirements/README.md` | 已归位 |
| `system/canary` | `src/system/canary/requirements/README.md` | 已归位 |
| `system/circuit-breaker` | `src/system/circuit-breaker/requirements/README.md` | 已归位 |
| `system/config` | `src/system/config/requirements/README.md` | 已归位 |
| `system/eval` | `src/system/eval/requirements/README.md` | 已归位 |
| `system/evidence` | `src/system/evidence/requirements/README.md` | 已归位 |
| `system/evolution` | `src/system/evolution/requirements/README.md` | 已归位 |
| `system/governor` | `src/system/governor/requirements/README.md` | 已归位 |
| `system/idempotency-guard` | `src/system/idempotency-guard/requirements/README.md` | 已归位 |
| `system/kernel` | `src/system/kernel/requirements/README.md` | 已归位 |
| `system/kernel-bridge` | `src/system/kernel-bridge/requirements/README.md` | 已归位 |
| `system/mail` | `src/system/mail/requirements/README.md` | 已归位 |
| `system/market` | `src/system/market/requirements/README.md` | 已归位 |
| `system/measures` | `src/system/measures/requirements/README.md` | 已归位 |
| `system/norm` | `src/system/norm/requirements/README.md` | 已归位 |
| `system/observability` | `src/system/observability/requirements/README.md` | 已归位 |
| `system/ops-view` | `src/system/ops-view/requirements/README.md` | 已归位 |
| `system/pipeline-view` | `src/system/pipeline-view/requirements/README.md` | 已归位 |
| `system/projection` | `src/system/projection/requirements/README.md` | 已归位 |
| `system/qa-runner` | `src/system/qa-runner/requirements/README.md` | 已归位 |
| `system/realm` | `src/system/realm/requirements/README.md` | 已归位 |
| `system/relay` | `src/system/relay/requirements/README.md` | 已归位 |
| `system/repo-gate` | `src/system/repo-gate/requirements/README.md` | 已归位 |
| `system/retention` | `src/system/retention/requirements/README.md` | 已归位 |
| `system/storage` | `src/system/storage/requirements/README.md` | 已归位 |
| `system/timeline` | `src/system/timeline/requirements/README.md` | 已归位 |
| `system/ui-feedback` | `src/system/ui-feedback/requirements/README.md` | 已归位 |
| `system/user-plugin-manager` | `src/system/user-plugin-manager/requirements/README.md` | 已归位 |
| `system/webui` | `src/system/webui/requirements/README.md` | 已归位 |

## 5. 复算与计数（可复核）

```bash
# 状态计数：只数 §1 的数据行（§4.2 是另一张表，用区间切出来，避免"69 行"的误读）
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c '^| `'       # 63（插件全集）
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c ' done '      # 55
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c ' partial '   # 1（system/runtime）
sed -n '/^## 1\./,/^## 2\./p' docs/work/plugin-requirements-map.md | grep -c ' missing '   # 7
grep -oE 'req=[a-zA-Z0-9_./-]+' docs/work/plugin-requirements-map.md | sort -u | wc -l     # 63（= 插件全集）
# FR 定义集合规模（**定义行**口径：主文件 + 同目录归档）
grep -chE '^\| FR-' docs/work/functional-requirements*.md | awk '{s+=$1} END {print s}'    # 166
# 唯一指针：只看第 3 个 pipe 字段（"负责的 FR 号"列）——总数与去重数都必须 166
python3 -c "
import re
rows=[l for l in open('docs/work/plugin-requirements-map.md') if l.startswith('| \`')]
frs=[f for l in rows for f in re.findall(r'FR-[A-Z]+-[0-9]{3}', l.split('|')[2])]
print(len(frs), len(set(frs)))"                                                            # 166 166
# 缺口数与逐插件文档覆盖（**全部机算**，不手写）：§4.1 的缺口数 = 插件全集 − 有 req= 的插件数
python3 -c "
import re, pathlib
t=pathlib.Path('docs/work/plugin-requirements-map.md').read_text()
sec=t.split('## 1.')[1].split('## 2.')[0]
rows=[l for l in sec.splitlines() if l.startswith('| \`')]
has=[l for l in rows if 'req=' in l]
print('插件行', len(rows), '有需求文档', len(has), '缺口', len(rows)-len(has))"                # 63 63 0
# 归位台账与未归位集合（A6c 的两条双向断言，机算）
python3 -c "
import re, pathlib
t=pathlib.Path('docs/work/plugin-requirements-map.md').read_text()
sec=t.split('## 1.')[1].split('## 2.')[0]
reqs={l.split('|')[1].strip().strip('\`'): re.findall(r'req=([^\\s\`、]+)', l) for l in sec.splitlines() if l.startswith('| \`')}
std={p for p,v in reqs.items() if all(x.startswith(f'src/{p}/requirements/') for x in v)}
print('有 req= 的插件', len(reqs), '在标准位置', len(std), '不在标准位置', len(reqs)-len(std))"
# 逐插件文档的 FR 行集合 == 映射表该插件认领的 FR 集合（互证命令与原始输出见 `docs/work/evidence/EV-169-*`）
# 门的自检（同一套口径 + 4 处单点变异 + 产品树字节不变）
tools/verify.sh plugin-requirements
```

> 注意两个**易误读**的口径：① §1 的**证据列**会提到别的插件的 FR（"部分承载"注释），所以"全文 grep FR" 会多出 8 处重复 —— 唯一指针只看**第 3 个 pipe 字段**；
> ② `grep -c '^| \`'` 全文数是 121（63 + §4.2 的 58 行台账），插件全集是 **63**。

| 计数 | 值 |
|---|---|
| 插件行 | 63（system 34 + domain 26 + userspace 3） |
| 认领 FR | 166 / 166（未认领 0） |
| 状态 | done 55 · partial 1 · missing 7 |
| 已建需求文档 | 63（**全部在标准布局** `src/<层>/<插件>/requirements/README.md`；`T-321` 归位 58 份） |
| 缺需求文档（§4.1） | 0 |
| 文档位置偏差（§4.2 未归位） | **0**（归位台账 58 条逐条指向真实文件；未归位集合与台账里的「未归位」行双向一致） |
| 机检 | `tools/verify.sh plugin-requirements` |
