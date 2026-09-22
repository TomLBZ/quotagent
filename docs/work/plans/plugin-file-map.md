# 逐文件迁移映射表（当前路径 → 目标路径）

<!-- budget: 32 KB（`docs/work/plans/*.md` 行，本批新增）。生成方式与复核命令见 plugin-migration-plan.md §3。 -->

本表是 `docs/work/plans/plugin-migration-plan.md` 的附件：**当前树里每个源码路径**（`src/**`、`host/**`、`tools/**`、`user-space/**`）
到目标路径（`src/{system,domain,userspace}/<plugin>/…`）的一行一条映射。

- 口径：路径清单 = `git ls-files src host tools user-space`（HEAD 时点，**250** 个路径）+ `user-space/` 磁盘上的 **6** 个文件 = **256** 个路径，另有 **8** 个在飞（未跟踪）源文件。
- 行数：**251 行迁移 + 5 个保留入口（不迁移，见下行与迁移计划 §2 阶段 0）= 256**；表内另有 **8** 行在飞 ⇒ 表体 **259** 行。未映射 **0** 个（判据：映射脚本对未知路径 `raise`，不静默跳过）。
- 保留不动的是 `tools/` 的 5 个薄入口：`verify.sh`/`run.sh`/`runtime.sh`/`bootstrap.sh`/`cordis.sh`（门与一键运行的稳定入口，见 `27-plugin-architecture.md` §9 未决 3）。
- 每行都由**规则**产生（不是逐条手写），规则表与复算命令在 `plugin-migration-plan.md` §3（`tmp/arch-batch/gen_map.py` 为一次性脚手架，不入库）。

| 现路径 | 目标路径 | 备注 |
|---|---|---|
| `host/CONFIG.md` | `src/system/config/CONFIG.md` |  |
| `host/README.md` | `src/system/runtime/README.md` |  |
| `host/audit-hook.mjs` | `src/system/audit-hook/tests/audit-hook.mjs` |  |
| `host/breaker.mjs` | `src/system/circuit-breaker/tests/breaker.mjs` |  |
| `host/bridge-canary.mjs` | `src/system/canary/tests/bridge-canary.mjs` |  |
| `host/canary-dispatch.mjs` | `src/system/canary/tests/canary-dispatch.mjs` |  |
| `host/canary.mjs` | `src/system/canary/tests/canary.mjs` |  |
| `host/check-modules.mjs` | `src/system/repo-gate/check-modules.mjs` |  |
| `host/cli.mjs` | `src/system/runtime/cli.mjs` |  |
| `host/evolution.mjs` | `src/system/evolution/tests/evolution.mjs` |  |
| `host/evolve-journal.mjs` | `src/system/evolution/tests/evolve-journal.mjs` |  |
| `host/governor.mjs` | `src/system/governor/tests/governor.mjs` |  |
| `host/invariants.mjs` | `src/system/repo-gate/invariants.mjs` |  |
| `host/lib/bridge.mjs` | `src/system/kernel-bridge/bridge.mjs` |  |
| `host/lib/canary-dispatch.mjs` | `src/system/canary/canary-dispatch.mjs` |  |
| `host/lib/canary-run.mjs` | `src/system/canary/canary-run.mjs` |  |
| `host/lib/config-keys.mjs` | `src/system/config/config-keys.mjs` |  |
| `host/lib/config-ui.mjs` | `src/system/config/config-ui.mjs` |  |
| `host/lib/config.mjs` | `src/system/config/config.mjs` |  |
| `host/lib/evolution.mjs` | `src/system/evolution/evolution.mjs` |  |
| `host/lib/frozen.mjs` | `src/system/kernel/frozen.mjs` |  |
| `host/lib/ledger-view.mjs` | `src/system/kernel/ledger-view.mjs` |  |
| `host/lib/schema.mjs` | `src/system/config/schema.mjs` |  |
| `host/lib/std-schema.mjs` | `src/system/config/std-schema.mjs` |  |
| `host/lib/supervisor.mjs` | `src/system/kernel-bridge/supervisor.mjs` |  |
| `host/lib/user-space.mjs` | `src/system/user-plugin-manager/user-space.mjs` |  |
| `host/modules/admin-guard.mjs` | `src/system/admin/admin-guard.mjs` |  |
| `host/modules/admin-view.mjs` | `src/system/admin/admin-view.mjs` |  |
| `host/modules/advice-panel.mjs` | `src/domain/advice/advice-panel.mjs` |  |
| `host/modules/agent-context.mjs` | `src/system/agent-runtime/agent-context.mjs` |  |
| `host/modules/agent-harness.mjs` | `src/system/agent-runtime/agent-harness.mjs` |  |
| `host/modules/agent-memory.mjs` | `src/system/agent-runtime/agent-memory.mjs` |  |
| `host/modules/approval-digest.mjs` | `src/system/approval/approval-digest.mjs` |  |
| `host/modules/audit-hook.mjs` | `src/system/audit-hook/audit-hook.mjs` |  |
| `host/modules/authority-band.mjs` | `src/domain/authority-band/authority-band.mjs` |  |
| `host/modules/bid-heuristics.mjs` | `src/domain/bid-heuristics/bid-heuristics.mjs` |  |
| `host/modules/bridge-canary.mjs` | `src/system/canary/bridge-canary.mjs` |  |
| `host/modules/budget-guard.mjs` | `src/system/budget-guard/budget-guard.mjs` |  |
| `host/modules/canary.mjs` | `src/system/canary/canary.mjs` |  |
| `host/modules/circuit-breaker.mjs` | `src/system/circuit-breaker/circuit-breaker.mjs` |  |
| `host/modules/compare.mjs` | `src/domain/compare/compare.mjs` |  |
| `host/modules/config-view.mjs` | `src/system/config/config-view.mjs` |  |
| `host/modules/evidence-summary.mjs` | `src/system/evidence/evidence-summary.mjs` |  |
| `host/modules/evolve-journal.mjs` | `src/system/evolution/evolve-journal.mjs` |  |
| `host/modules/gate-timeline.mjs` | `src/domain/gate-timeline/gate-timeline.mjs` |  |
| `host/modules/governor.mjs` | `src/system/governor/governor.mjs` |  |
| `host/modules/idempotency-guard.mjs` | `src/system/idempotency-guard/idempotency-guard.mjs` |  |
| `host/modules/index.mjs` | `src/system/runtime/plugin-index.mjs` | 目录即清单（自动发现） |
| `host/modules/kernel-bridge.mjs` | `src/system/kernel-bridge/kernel-bridge.mjs` |  |
| `host/modules/mail-view.mjs` | `src/system/mail/mail-view.mjs` |  |
| `host/modules/norm.mjs` | `src/system/norm/norm.mjs` |  |
| `host/modules/observability.mjs` | `src/system/observability/observability.mjs` |  |
| `host/modules/ops-view.mjs` | `src/system/ops-view/ops-view.mjs` |  |
| `host/modules/pipeline-view.mjs` | `src/system/pipeline-view/pipeline-view.mjs` |  |
| `host/modules/plugin-market.mjs` | `src/system/market/plugin-market.mjs` |  |
| `host/modules/price-history.mjs` | `src/domain/price-history/price-history.mjs` |  |
| `host/modules/projection.mjs` | `src/system/projection/projection.mjs` |  |
| `host/modules/retention-view.mjs` | `src/system/retention/retention-view.mjs` |  |
| `host/modules/rfq-deadline.mjs` | `src/domain/rfq-deadline/rfq-deadline.mjs` |  |
| `host/modules/sourcing.mjs` | `src/domain/sourcing/sourcing.mjs` |  |
| `host/modules/storage-view.mjs` | `src/system/storage/storage-view.mjs` |  |
| `host/modules/supplier-scorecard.mjs` | `src/domain/supplier-scorecard/supplier-scorecard.mjs` |  |
| `host/modules/timeline.mjs` | `src/system/timeline/timeline.mjs` |  |
| `host/modules/ui-feedback.mjs` | `src/system/ui-feedback/ui-feedback.mjs` |  |
| `host/modules/user-plugin-manager.mjs` | `src/system/user-plugin-manager/user-plugin-manager.mjs` |  |
| `host/modules/webui.mjs` | `src/system/webui/webui.mjs` |  |
| `host/observability.mjs` | `src/system/observability/tests/observability.mjs` |  |
| `host/ops-view.mjs` | `src/system/ops-view/tests/ops-view.mjs` |  |
| `host/package-lock.json` | `src/system/runtime/package-lock.json` |  |
| `host/package.json` | `src/system/runtime/package.json` |  |
| `host/profiles.mjs` | `src/system/runtime/profiles.mjs` |  |
| `host/smoke.mjs` | `src/system/runtime/smoke.mjs` |  |
| `host/t247-idem-gate.mjs` | `src/system/idempotency-guard/tests/t247-idem-gate.mjs` |  |
| `host/t247-scorecard-gate.mjs` | `src/domain/supplier-scorecard/tests/t247-scorecard-gate.mjs` |  |
| `host/t250-approval-gate.mjs` | `src/system/approval/tests/t250-approval-gate.mjs` |  |
| `host/t250-budget-gate.mjs` | `src/system/budget-guard/tests/t250-budget-gate.mjs` |  |
| `host/t254-retention-view-gate.mjs` | `src/system/retention/tests/t254-retention-view-gate.mjs` |  |
| `host/t260-pipeline-gate.mjs` | `src/system/pipeline-view/tests/t260-pipeline-gate.mjs` |  |
| `host/t267-market-gate.mjs` | `src/system/market/tests/t267-market-gate.mjs` |  |
| `host/t268-user-space-gate.mjs` | `src/system/user-plugin-manager/tests/t268-user-space-gate.mjs` |  |
| `host/t271-admin-gate.mjs` | `src/system/admin/tests/t271-admin-gate.mjs` |  |
| `host/t275-runtime-gate.mjs` | `src/system/agent-runtime/tests/t275-runtime-gate.mjs` |  |
| `host/t277-storage-gate.mjs` | `src/system/storage/tests/t277-storage-gate.mjs` |  |
| `host/t279-heuristics-gate.mjs` | `src/domain/bid-heuristics/tests/t279-heuristics-gate.mjs` |  |
| `host/t280-ui-feedback-gate.mjs` | `src/system/ui-feedback/tests/t280-ui-feedback-gate.mjs` |  |
| `host/t281-advice-gate.mjs` | `src/domain/advice/tests/t281-advice-gate.mjs` |  |
| `host/t282-gate-timeline-gate.mjs` | `src/domain/gate-timeline/tests/t282-gate-timeline-gate.mjs` |  |
| `host/t283-change-detail-gate.mjs` | `src/domain/gate-timeline/tests/t283-change-detail-gate.mjs` |  |
| `host/t284-authority-gate.mjs` | `src/domain/authority-band/tests/t284-authority-gate.mjs` |  |
| `host/t285-rfq-deadline-gate.mjs` | `src/domain/rfq-deadline/tests/t285-rfq-deadline-gate.mjs` |  |
| `host/webui.mjs` | `src/system/webui/tests/webui.mjs` |  |
| `src/quotagent/__init__.py` | `src/system/runtime/__init__.py` |  |
| `src/quotagent/bridge.py` | `src/system/kernel-bridge/bridge.py` |  |
| `src/quotagent/g1side.py` | `src/system/repo-gate/g1side.py` |  |
| `src/quotagent/kernel/__init__.py` | `src/system/kernel/__init__.py` |  |
| `src/quotagent/kernel/canon.py` | `src/system/kernel/canon.py` |  |
| `src/quotagent/kernel/delivery.py` | `src/system/kernel/delivery.py` |  |
| `src/quotagent/kernel/events.py` | `src/system/kernel/events.py` |  |
| `src/quotagent/kernel/evidence.py` | `src/system/kernel/evidence.py` |  |
| `src/quotagent/kernel/ledger.py` | `src/system/kernel/ledger.py` |  |
| `src/quotagent/kernel/modelgate.py` | `src/system/kernel/modelgate.py` |  |
| `src/quotagent/kernel/plugin.py` | `src/system/kernel/plugin.py` |  |
| `src/quotagent/kernel/qep.py` | `src/system/kernel/qep.py` |  |
| `src/quotagent/paths.py` | `src/system/runtime/paths.py` |  |
| `src/quotagent/qa/__init__.py` | `src/system/qa-runner/__init__.py` |  |
| `src/quotagent/qa/__main__.py` | `src/system/qa-runner/__main__.py` |  |
| `src/quotagent/qa/checks_admin.py` | `src/system/admin/tests/checks_admin.py` |  |
| `src/quotagent/qa/checks_adv.py` | `src/domain/advice/tests/checks_adv.py` |  |
| `src/quotagent/qa/checks_agentrt.py` | `src/system/agent-runtime/tests/checks_agentrt.py` |  |
| `src/quotagent/qa/checks_agentrt_lifecycle.py` | `src/system/agent-runtime/tests/checks_agentrt_lifecycle.py` |  |
| `src/quotagent/qa/checks_agentrt_memory.py` | `src/system/agent-runtime/tests/checks_agentrt_memory.py` |  |
| `src/quotagent/qa/checks_audit.py` | `src/system/evidence/tests/checks_audit.py` |  |
| `src/quotagent/qa/checks_award.py` | `src/domain/commitments/tests/checks_award.py` |  |
| `src/quotagent/qa/checks_bridge.py` | `src/system/kernel-bridge/tests/checks_bridge.py` |  |
| `src/quotagent/qa/checks_capacity.py` | `src/domain/capacity/tests/checks_capacity.py` |  |
| `src/quotagent/qa/checks_change.py` | `src/domain/change/tests/checks_change.py` |  |
| `src/quotagent/qa/checks_clarify.py` | `src/domain/clarify/tests/checks_clarify.py` |  |
| `src/quotagent/qa/checks_compare.py` | `src/domain/compare/tests/checks_compare.py` |  |
| `src/quotagent/qa/checks_config.py` | `src/system/config/tests/checks_config.py` |  |
| `src/quotagent/qa/checks_cost.py` | `src/domain/costmodel/tests/checks_cost.py` |  |
| `src/quotagent/qa/checks_design.py` | `src/system/repo-gate/tests/checks_design.py` |  |
| `src/quotagent/qa/checks_deviation.py` | `src/domain/deviation/tests/checks_deviation.py` |  |
| `src/quotagent/qa/checks_eval.py` | `src/system/eval/tests/checks_eval.py` |  |
| `src/quotagent/qa/checks_events.py` | `src/system/kernel/tests/checks_events.py` |  |
| `src/quotagent/qa/checks_export.py` | `src/domain/export/tests/checks_export.py` |  |
| `src/quotagent/qa/checks_faq.py` | `src/domain/faq/tests/checks_faq.py` |  |
| `src/quotagent/qa/checks_gate.py` | `src/domain/gate-timeline/tests/checks_gate.py` |  |
| `src/quotagent/qa/checks_guard.py` | `src/domain/guard/tests/checks_guard.py` |  |
| `src/quotagent/qa/checks_intake.py` | `src/domain/intake/tests/checks_intake.py` |  |
| `src/quotagent/qa/checks_mail.py` | `src/system/mail/tests/checks_mail.py` |  |
| `src/quotagent/qa/checks_mail_transport.py` | `src/system/mail/tests/checks_mail_transport.py` |  |
| `src/quotagent/qa/checks_negotiation.py` | `src/domain/negotiation/tests/checks_negotiation.py` |  |
| `src/quotagent/qa/checks_norm.py` | `src/system/norm/tests/checks_norm.py` |  |
| `src/quotagent/qa/checks_plugin.py` | `src/system/kernel/tests/checks_plugin.py` |  |
| `src/quotagent/qa/checks_pricing.py` | `src/domain/pricing/tests/checks_pricing.py` |  |
| `src/quotagent/qa/checks_qep.py` | `src/system/kernel/tests/checks_qep.py` |  |
| `src/quotagent/qa/checks_quotes.py` | `src/domain/quotes/tests/checks_quotes.py` |  |
| `src/quotagent/qa/checks_retention.py` | `src/system/retention/tests/checks_retention.py` |  |
| `src/quotagent/qa/checks_retention_exec.py` | `src/system/retention/tests/checks_retention_exec.py` |  |
| `src/quotagent/qa/checks_rfq.py` | `src/domain/rfq/tests/checks_rfq.py` |  |
| `src/quotagent/qa/checks_runtime.py` | `src/system/runtime/tests/checks_runtime.py` |  |
| `src/quotagent/qa/checks_storage.py` | `src/system/storage/tests/checks_storage.py` |  |
| `src/quotagent/qa/checks_sync.py` | `src/domain/sync/tests/checks_sync.py` |  |
| `src/quotagent/qa/checks_terms.py` | `src/domain/terms/tests/checks_terms.py` |  |
| `src/quotagent/qa/checks_ui_snapshot.py` | `src/system/webui/tests/checks_ui_snapshot.py` |  |
| `src/quotagent/qa/checks_uifb.py` | `src/system/ui-feedback/tests/checks_uifb.py` |  |
| `src/quotagent/qa/checks_userplugin.py` | `src/system/user-plugin-manager/tests/checks_userplugin.py` |  |
| `src/quotagent/qa/checks_userplugin_elevate.py` | `src/system/user-plugin-manager/tests/checks_userplugin_elevate.py` |  |
| `src/quotagent/qa/checks_userplugin_versions.py` | `src/system/user-plugin-manager/tests/checks_userplugin_versions.py` |  |
| `src/quotagent/qa/checks_usreq.py` | `src/system/repo-gate/tests/checks_usreq.py` |  |
| `src/quotagent/qa/checks_uxweb.py` | `src/system/webui/tests/checks_uxweb.py` |  |
| `src/quotagent/qa/checks_viz.py` | `src/domain/bid-heuristics/tests/checks_viz.py` |  |
| `src/quotagent/qa/registry.py` | `src/system/qa-runner/registry.py` |  |
| `src/quotagent/services/__init__.py` | `src/system/runtime/services-__init__.py` |  |
| `src/quotagent/services/admin_blocks.py` | `src/system/admin/admin_blocks.py` |  |
| `src/quotagent/services/approval.py` | `src/system/approval/approval.py` |  |
| `src/quotagent/services/capacity.py` | `src/domain/capacity/capacity.py` |  |
| `src/quotagent/services/change.py` | `src/domain/change/change.py` |  |
| `src/quotagent/services/clarify.py` | `src/domain/clarify/clarify.py` |  |
| `src/quotagent/services/commitments.py` | `src/domain/commitments/commitments.py` |  |
| `src/quotagent/services/compare.py` | `src/domain/compare/compare.py` |  |
| `src/quotagent/services/costmodel.py` | `src/domain/costmodel/costmodel.py` |  |
| `src/quotagent/services/deviation.py` | `src/domain/deviation/deviation.py` |  |
| `src/quotagent/services/evaldata.py` | `src/system/eval/evaldata.py` |  |
| `src/quotagent/services/evalmetrics.py` | `src/system/eval/evalmetrics.py` |  |
| `src/quotagent/services/export.py` | `src/domain/export/export.py` |  |
| `src/quotagent/services/faq.py` | `src/domain/faq/faq.py` |  |
| `src/quotagent/services/guard.py` | `src/domain/guard/guard.py` |  |
| `src/quotagent/services/intake.py` | `src/domain/intake/intake.py` |  |
| `src/quotagent/services/mail.py` | `src/system/mail/mail.py` |  |
| `src/quotagent/services/mail_transport.py` | `src/system/mail/mail_transport.py` |  |
| `src/quotagent/services/measures.py` | `src/system/measures/measures.py` |  |
| `src/quotagent/services/negotiation.py` | `src/domain/negotiation/negotiation.py` |  |
| `src/quotagent/services/norm.py` | `src/system/norm/norm.py` |  |
| `src/quotagent/services/pricing.py` | `src/domain/pricing/pricing.py` |  |
| `src/quotagent/services/quotes.py` | `src/domain/quotes/quotes.py` |  |
| `src/quotagent/services/realm.py` | `src/system/realm/realm.py` |  |
| `src/quotagent/services/relay.py` | `src/system/relay/relay.py` |  |
| `src/quotagent/services/retention.py` | `src/system/retention/retention.py` |  |
| `src/quotagent/services/retention_exec.py` | `src/system/retention/retention_exec.py` |  |
| `src/quotagent/services/rfq.py` | `src/domain/rfq/rfq.py` |  |
| `src/quotagent/services/scenarios.py` | `src/system/eval/scenarios.py` |  |
| `src/quotagent/services/sync.py` | `src/domain/sync/sync.py` |  |
| `src/quotagent/services/terms.py` | `src/domain/terms/terms.py` |  |
| `tools/admin-apply.py` | `src/system/admin/tools/admin-apply.py` |  |
| `tools/audit-verify.py` | `src/system/evidence/tools/audit-verify.py` |  |
| `tools/check-ac-registry.py` | `src/system/repo-gate/tests/check-ac-registry.py` |  |
| `tools/check-admin-route.py` | `src/system/admin/tests/check-admin-route.py` |  |
| `tools/check-advice-route.py` | `src/domain/advice/tests/check-advice-route.py` |  |
| `tools/check-audit-hook.py` | `src/system/audit-hook/tests/check-audit-hook.py` |  |
| `tools/check-authority-route.py` | `src/domain/authority-band/tests/check-authority-route.py` |  |
| `tools/check-breaker-route.py` | `src/system/circuit-breaker/tests/check-breaker-route.py` |  |
| `tools/check-bridge-canary.py` | `src/system/canary/tests/check-bridge-canary.py` |  |
| `tools/check-budget-route.py` | `src/system/budget-guard/tests/check-budget-route.py` |  |
| `tools/check-canary-dispatch.py` | `src/system/canary/tests/check-canary-dispatch.py` |  |
| `tools/check-canary.py` | `src/system/canary/tests/check-canary.py` |  |
| `tools/check-change-detail-route.py` | `src/domain/gate-timeline/tests/check-change-detail-route.py` |  |
| `tools/check-clean-copy.py` | `src/system/repo-gate/tests/check-clean-copy.py` |  |
| `tools/check-config-route.py` | `src/system/config/tests/check-config-route.py` |  |
| `tools/check-docs.py` | `src/system/repo-gate/tests/check-docs.py` |  |
| `tools/check-events.py` | `src/system/kernel/tests/check-events.py` |  |
| `tools/check-evolved-module.py` | `src/system/evolution/tests/check-evolved-module.py` |  |
| `tools/check-faq.py` | `src/domain/faq/tests/check-faq.py` |  |
| `tools/check-fr-coverage.py` | `src/system/repo-gate/tests/check-fr-coverage.py` |  |
| `tools/check-gate-timeline-route.py` | `src/domain/gate-timeline/tests/check-gate-timeline-route.py` |  |
| `tools/check-governor.py` | `src/system/governor/tests/check-governor.py` |  |
| `tools/check-heuristics-route.py` | `src/domain/bid-heuristics/tests/check-heuristics-route.py` |  |
| `tools/check-idem-route.py` | `src/system/idempotency-guard/tests/check-idem-route.py` |  |
| `tools/check-invariants.py` | `src/system/repo-gate/tests/check-invariants.py` |  |
| `tools/check-mail-transport.py` | `src/system/mail/tests/check-mail-transport.py` |  |
| `tools/check-mail.py` | `src/system/mail/tests/check-mail.py` |  |
| `tools/check-module-wiring.py` | `src/system/repo-gate/tests/check-module-wiring.py` |  |
| `tools/check-modules.py` | `src/system/repo-gate/tests/check-modules.py` |  |
| `tools/check-negotiation.py` | `src/domain/negotiation/tests/check-negotiation.py` |  |
| `tools/check-pipeline-route.py` | `src/system/pipeline-view/tests/check-pipeline-route.py` |  |
| `tools/check-plugin-inventory.py` | `src/system/repo-gate/tests/check-plugin-inventory.py` |  |
| `tools/check-retention.py` | `src/system/retention/tests/check-retention.py` |  |
| `tools/check-rfq-deadline-route.py` | `src/domain/rfq-deadline/tests/check-rfq-deadline-route.py` |  |
| `tools/check-ui-feedback.py` | `src/system/ui-feedback/tests/check-ui-feedback.py` |  |
| `tools/check-ui-seed.py` | `src/system/webui/tests/check-ui-seed.py` |  |
| `tools/check-v-register.py` | `src/system/repo-gate/tests/check-v-register.py` |  |
| `tools/check-webui.py` | `src/system/webui/tests/check-webui.py` |  |
| `tools/config-apply.py` | `src/system/config/tools/config-apply.py` |  |
| `tools/evolve-module.mjs` | `src/system/evolution/tools/evolve-module.mjs` |  |
| `tools/evolve-record.py` | `src/system/evolution/tools/evolve-record.py` |  |
| `tools/export-events.py` | `src/system/evidence/tools/export-events.py` |  |
| `tools/g1-walkthrough.py` | `src/system/repo-gate/tests/g1-walkthrough.py` |  |
| `tools/gate-nudge.py` | `src/domain/gate-timeline/tools/gate-nudge.py` |  |
| `tools/manual-check.py` | `src/system/repo-gate/tools/manual-check.py` |  |
| `tools/mutate-ui-views.py` | `src/system/webui/tools/mutate-ui-views.py` |  |
| `tools/refresh-admin-snapshot.py` | `src/system/admin/tools/refresh-admin-snapshot.py` |  |
| `tools/refresh-agent-memory.py` | `src/system/agent-runtime/tools/refresh-agent-memory.py` |  |
| `tools/refresh-retention-plan.py` | `src/system/retention/tools/refresh-retention-plan.py` |  |
| `tools/refresh-ui-snapshots.py` | `src/system/webui/tools/refresh-ui-snapshots.py` |  |
| `tools/rfq-promise.py` | `src/domain/rfq-deadline/tools/rfq-promise.py` |  |
| `tools/storage.py` | `src/system/storage/tools/storage.py` |  |
| `tools/ui-feedback-apply.py` | `src/system/ui-feedback/tools/ui-feedback-apply.py` |  |
| `tools/ui-feedback-monitor.sh` | `src/system/ui-feedback/tools/ui-feedback-monitor.sh` |  |
| `tools/ui-feedback-tick.sh` | `src/system/ui-feedback/tools/ui-feedback-tick.sh` |  |
| `tools/ui-seed-pipeline.py` | `src/system/webui/tools/ui-seed-pipeline.py` |  |
| `tools/userplugin-elevate.py` | `src/system/user-plugin-manager/tools/userplugin-elevate.py` |  |
| `tools/userplugin-record.py` | `src/system/user-plugin-manager/tools/userplugin-record.py` |  |
| `tools/v-kit.sh` | `src/system/repo-gate/tools/v-kit.sh` |  |
| `tools/webui-serve.py` | `src/system/webui/tools/webui-serve.py` |  |
| `tools/ws-integrate.py` | `src/system/runtime/tools/ws-integrate.py` |  |
| `user-space/README.txt` | `src/userspace/README.txt` |  |
| `user-space/con-a/quote-trend/data/observations.jsonl` | `src/userspace/con-a/quote-trend/data/observations.jsonl` |  |
| `user-space/con-a/quote-trend/index.mjs` | `src/userspace/con-a/quote-trend/index.mjs` |  |
| `user-space/con-a/quote-trend/plugin.json` | `src/userspace/con-a/quote-trend/plugin.json` |  |
| `user-space/demo-ns/hello/index.mjs` | `src/userspace/demo-ns/hello/index.mjs` |  |
| `user-space/demo-ns/hello/plugin.json` | `src/userspace/demo-ns/hello/plugin.json` |  |
| `host/modules/quote-prepare.mjs` | `src/domain/quote-prepare/quote-prepare.mjs` | 在飞（未跟踪） |
| `host/t286-quote-draft-gate.mjs` | `src/domain/quote-prepare/tests/t286-quote-draft-gate.mjs` | 在飞（未跟踪） |
| `host/t287-rfq-visibility-gate.mjs` | `src/system/projection/tests/t287-rfq-visibility-gate.mjs` | 在飞（未跟踪） |
| `src/quotagent/qa/checks_qprep.py` | `src/domain/quote-prepare/tests/checks_qprep.py` | 在飞（未跟踪） |
| `tools/check-quote-draft-route.py` | `src/domain/quote-prepare/tests/check-quote-draft-route.py` | 在飞（未跟踪） |
| `tools/check-rfq-visibility-route.py` | `src/system/projection/tests/check-rfq-visibility-route.py` | 在飞（未跟踪） |
| `tools/quote-draft.py` | `src/domain/quote-prepare/tools/quote-draft.py` | 在飞（未跟踪） |
| `tools/quote-sign.py` | `src/domain/quote-prepare/tools/quote-sign.py` | 在飞（未跟踪） |

## 汇总（按目标层）

| 层 | 插件数 | 迁入文件数 |
|---|---|---|
| `src/system/<plugin>/` | 34 | 182（+ 在飞 2 = 184） |
| `src/domain/<plugin>/` | 25（+ 在飞的 `quote-prepare` = 26） | 63（+ 在飞 6 = 69） |
| `src/userspace/<ns>/<plugin>/` | 2 个命名空间（`con-a`、`demo-ns`） | 6（含 `README.txt`） |
| `tools/`（保留的薄入口） | – | 5 |

> `user-space/README.txt` → `src/userspace/README.txt`；`src/userspace/` 的 gitignore 语义见 27 §9 未决 2。

## 规则（复算用）

| 现路径模式 | 目标 | 说明 |
|---|---|---|
| `src/quotagent/kernel/<f>.py` | `src/system/kernel/<f>.py` | 内核冻结（ADR-0002），不随自进化改 |
| `src/quotagent/services/<name>.py` | `src/{system|domain}/<plugin>/<name>.py` | 归属表：`norm/measures/realm/approval/mail(_transport)/relay/retention(_exec)/evaldata|evalmetrics|scenarios→eval/admin_blocks→admin` 为 system；`rfq/intake/compare/guard/costmodel/pricing/commitments/deviation/capacity/change/clarify/faq/negotiation/quotes/sync/terms/export` 为 domain |
| `src/quotagent/qa/checks_*.py` | `src/{system|domain}/<plugin>/tests/checks_*.py` | 检查随被检查的插件搬家（47 个映射逐条写在脚手架里） |
| `src/quotagent/qa/{__init__,__main__,registry}.py` | `src/system/qa-runner/` | AC 运行器（跨插件的运行入口） |
| `src/quotagent/{__init__,paths}.py` | `src/system/runtime/` | 运行时与路径解析 |
| `src/quotagent/bridge.py` | `src/system/kernel-bridge/bridge.py` | 与宿主桥同插件 |
| `src/quotagent/g1side.py` | `src/system/repo-gate/g1side.py` | G1 走查的 Python 侧 |
| `host/modules/<stem>.mjs` | `src/{system|domain}/<plugin>/<stem>.mjs` | 归属规则见 27 §1.2（`norm/compare` 与 Python 侧同插件） |
| `host/lib/<f>.mjs` | 按功能拆到 `system/{kernel,kernel-bridge,canary,config,evolution,user-plugin-manager}/` | 库层不单独成立插件：它属于使用它的插件 |
| `host/<plugin>.mjs`（围栏门） | `src/<层>/<plugin>/tests/<plugin>.mjs` | 门的对象即插件 |
| `host/t2NN-*-gate.mjs` | `src/<层>/<plugin>/tests/` | 同上 |
| `host/{package.json,package-lock.json,README.md,smoke.mjs,cli.mjs,profiles.mjs}` | `src/system/runtime/` | 宿主运行时清单与入口 |
| `tools/<name>`（除 5 个薄入口） | `src/{system|domain}/<plugin>/{tests|tools}/<name>` | `check-*` 归 `tests/`；落账本/落盘工具归 `tools/` |
| `user-space/**` | `src/userspace/**` | 相对路径不变 |

（完）
