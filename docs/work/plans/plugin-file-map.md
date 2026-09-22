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
| `src/quotagent/kernel/__init__.py` | `src/system/kernel/code/__init__.py` |  |
| `src/quotagent/kernel/canon.py` | `src/system/kernel/code/canon.py` |  |
| `src/quotagent/kernel/delivery.py` | `src/system/kernel/code/delivery.py` |  |
| `src/quotagent/kernel/events.py` | `src/system/kernel/code/events.py` |  |
| `src/quotagent/kernel/evidence.py` | `src/system/kernel/code/evidence.py` |  |
| `src/quotagent/kernel/ledger.py` | `src/system/kernel/code/ledger.py` |  |
| `src/quotagent/kernel/modelgate.py` | `src/system/kernel/code/modelgate.py` |  |
| `src/quotagent/kernel/plugin.py` | `src/system/kernel/code/plugin.py` |  |
| `src/quotagent/kernel/qep.py` | `src/system/kernel/code/qep.py` |  |
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
| `user-space/README.txt` | `src/userspace/README.txt` |  | 已落（阶段 5.1，EV-168） |
| `user-space/con-a/quote-trend/data/observations.jsonl` | `src/userspace/con-a/quote-trend/data/observations.jsonl` |  | 已落（字节未变，297 B / sha256 33f46dbe…） |
| `user-space/con-a/quote-trend/index.mjs` | `src/userspace/con-a/quote-trend/code/index.mjs` |  | 已落（**偏表格原意**：按硬规范 §2.1 落进 `code/`；字节未变，11742 B / sha256 dffeff77…） |
| `user-space/con-a/quote-trend/plugin.json` | `src/userspace/con-a/quote-trend/plugin.json` |  | 已落（合并清单：加 `layer`/`entry`，`artifact` 指 `code/index.mjs`） |
| `user-space/demo-ns/hello/index.mjs` | —— |  | **删**（与 `code/index.mjs` 是同一插件的两份实现；那 12 行逐字留档在 `src/userspace/demo-ns/hello/docs/migration-note.md`） |
| `user-space/demo-ns/hello/plugin.json` | `src/userspace/demo-ns/hello/plugin.json` |  | 已落（合并清单：与阶段 1 的新清单合成一份） |
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
| `src/quotagent/kernel/<f>.py` | `src/system/kernel/code/<f>.py` | 内核冻结（ADR-0002），不随自进化改；旧路径留**薄重导**（阶段 5 第一小片，EV-173） |
| `src/quotagent/services/<name>.py` | `src/{system|domain}/<plugin>/code/<name>.py` | 旧路径留**薄重导**（阶段 5 第二/三小片：`EV-174` 12 项 + `EV-175` 18 项 = **30/30 搬完**；有读方的 7 个模块在 `EV-175` 里**先改读方再搬**，见 `plugin-file-map-batches.md`） | 归属表：`norm/measures/realm/approval/mail(_transport)/relay/retention(_exec)/evaldata|evalmetrics|scenarios→eval/admin_blocks→admin` 为 system；`rfq/intake/compare/guard/costmodel/pricing/commitments/deviation/capacity/change/clarify/faq/negotiation/quotes/sync/terms/export` 为 domain |
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

**阶段 5.1 的收敛结论（EV-168）**：`src/userspace/**` 是**唯一事实源**；`user-space` 现在是指向它的
**兼容链接**（tracked symlink —— `.gitignore` 的 `user-space/` 规则只匹配目录，不匹配符号链接），
所以旧路径的读方（`tools/webui-serve.py` 的 `--user-space-root`/`--market-user-space`、`host/lib/user-space.mjs`
的默认根、若干宿主门）不必改一行，而磁盘上只有一份内容。


## 分类（检查/测试资产的归属与「薄入口」判定；迁移阶段 4.1）

<!-- 本节的机检是 `tools/verify.sh plugin-assets`（实现 `tools/check-plugin-assets.py`，PA1–PA7 + 4 处单点变异）。
     本节只回答一件事：**每个散落的检查/测试资产跟着哪个插件走、哪个是平台级薄入口**。 -->

**口径（怎么读这张表）**

1. **一行一资产**：`资产 | 归属插件 | 分类 | 子目录`。**归属**按 `docs/design/27-plugin-architecture.md` §1.2 的三条问句判定，
   并由本文档上面的**逐文件映射表**（`现路径 → 目标路径`）与 `docs/work/plugin-requirements-map.md` 的插件行交叉核对 ——
   本节**不新造归属**，只把既有映射按「归属 + 分类」再索引一遍（一处一事实）。
2. **分类取值三档**：`平台薄入口`（不搬，留名；27 §9 未决 3 + 阶段 5.2 的 `plugin.sh` 共 6 个）·
   `插件·已搬`（实体已在新位置，旧位置**只剩薄转发**）· `插件·待搬`（实体仍在旧位置，**逐条登记**在此，不许无名散落）。
3. **子目录**：`tests/` = 门/检查（`check-*.py`、`checks_*.py`、围栏门 `*-gate.mjs`）随被检查的插件走；
   `tools/` = 有写面的工具（写账本者只能是该账本唯一写者，27 §2.2）。
4. **`tools/**` 的非薄入口数**（散落的度量）：搬前 **69**（75 个文件 − 6 个薄入口），阶段 4.1 **搬走 7 个**（旧位置变薄转发）
   并**新增 1 个**（本节的机检门 `tools/check-plugin-assets.py` 自己，也登记为 `插件·待搬`）⇒ **63**；
   一键运行的干净副本验收门 `tools/check-run-clone.py`（EV-171）再 **+1** ⇒ **64**（同样是本类的平台门，登记为 `插件·待搬`）。
   门把 64 冻结为下界锁（`tools/check-plugin-assets.py` 的 `BASELINE_NONTHIN`）：**只减不增**，且集合必须与下表逐条相等。
5. **薄转发**：旧位置那几行只做转发（Python 用 `runpy`/`importlib` 指到新位置；`.mjs` 围栅门用 `import './../src/…'`，
   实现只在 `src/<层>/<插件>/tests/` 那一份），**不含任何实现**；
   改实现只改新位置那一份。留下的理由：`tools/verify.sh` 的门名与分支、`src/quotagent/qa/*.py` 里按路径读实现的判据、
   以及 `docs/**` 的既有引用都指向旧路径 —— 转发让它们**一行都不用改**（门名是接口）。

### 批次台账（已整节拆出）

**各批次的搬迁台账**（逐项清单 / 归属 / 门名 / 反例）已**整节逐字**拆到
[`plugin-file-map-batches.md`](plugin-file-map-batches.md)：主文件 48825 B / 预算 49152 B（99.3%）
⇒ 主文件只留**机器登记的 §分类三节表**（`tools/verify.sh plugin-assets` 的 PA3/PA4 读它）与规则。
本批（`EV-174` / `T-323`）的清单同样登记在那份台账里。

### 全量分类表（144 行 = 77 + 20 + 47）

### A. `tools/**`（77 个，其中平台薄入口 6 + 阶段 4.1 已搬 7 + 待搬 64）

| 资产 | 归属插件 | 分类 | 子目录 |
|---|---|---|---|
| `tools/admin-apply.py` | `system/admin` | 插件·待搬 | `tools/` |
| `tools/audit-verify.py` | `system/evidence` | 插件·待搬 | `tools/` |
| `tools/bootstrap.sh` | — | 平台薄入口 | — |
| `tools/check-ac-registry.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-admin-route.py` | `system/admin` | 插件·待搬 | `tests/` |
| `tools/check-advice-route.py` | `domain/advice` | 插件·已搬 | `tests/` |
| `tools/check-audit-hook.py` | `system/audit-hook` | 插件·待搬 | `tests/` |
| `tools/check-authority-route.py` | `domain/authority-band` | 插件·已搬 | `tests/` |
| `tools/check-breaker-route.py` | `system/circuit-breaker` | 插件·待搬 | `tests/` |
| `tools/check-bridge-canary.py` | `system/canary` | 插件·待搬 | `tests/` |
| `tools/check-budget-route.py` | `system/budget-guard` | 插件·待搬 | `tests/` |
| `tools/check-canary-dispatch.py` | `system/canary` | 插件·待搬 | `tests/` |
| `tools/check-canary.py` | `system/canary` | 插件·待搬 | `tests/` |
| `tools/check-change-detail-route.py` | `domain/gate-timeline` | 插件·已搬 | `tests/` |
| `tools/check-clean-copy.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-config-route.py` | `system/config` | 插件·待搬 | `tests/` |
| `tools/check-docs.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-events.py` | `system/kernel` | 插件·待搬 | `tests/` |
| `tools/check-evolved-module.py` | `system/evolution` | 插件·待搬 | `tests/` |
| `tools/check-faq.py` | `domain/faq` | 插件·待搬 | `tests/` |
| `tools/check-fr-coverage.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-gate-timeline-route.py` | `domain/gate-timeline` | 插件·已搬 | `tests/` |
| `tools/check-governor.py` | `system/governor` | 插件·待搬 | `tests/` |
| `tools/check-heuristics-route.py` | `domain/bid-heuristics` | 插件·待搬 | `tests/` |
| `tools/check-idem-route.py` | `system/idempotency-guard` | 插件·待搬 | `tests/` |
| `tools/check-invariants.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-mail-transport.py` | `system/mail` | 插件·待搬 | `tests/` |
| `tools/check-mail.py` | `system/mail` | 插件·待搬 | `tests/` |
| `tools/check-module-wiring.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-modules.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-negotiation.py` | `domain/negotiation` | 插件·待搬 | `tests/` |
| `tools/check-pipeline-route.py` | `system/pipeline-view` | 插件·待搬 | `tests/` |
| `tools/check-plugin-assets.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-plugin-inventory.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-plugin-lifecycle.py` | `system/runtime` | 插件·已搬 | `tests/` |
| `tools/check-plugin-requirements.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-quote-draft-route.py` | `domain/quote-prepare` | 插件·已搬 | `tests/` |
| `tools/check-retention.py` | `system/retention` | 插件·待搬 | `tests/` |
| `tools/check-rfq-deadline-route.py` | `domain/rfq-deadline` | 插件·待搬 | `tests/` |
| `tools/check-rfq-visibility-route.py` | `system/projection` | 插件·已搬 | `tests/` |
| `tools/check-run-once.py` | `system/runtime` | 插件·待搬 | `tests/` |
| `tools/check-run-clone.py` | `system/runtime` | 插件·待搬 | `tests/` |
| `tools/check-ui-feedback.py` | `system/ui-feedback` | 插件·待搬 | `tests/` |
| `tools/check-ui-seed.py` | `system/webui` | 插件·待搬 | `tests/` |
| `tools/check-v-register.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/check-webui.py` | `system/webui` | 插件·待搬 | `tests/` |
| `tools/config-apply.py` | `system/config` | 插件·待搬 | `tools/` |
| `tools/cordis.sh` | — | 平台薄入口 | — |
| `tools/evolve-module.mjs` | `system/evolution` | 插件·待搬 | `tools/` |
| `tools/evolve-record.py` | `system/evolution` | 插件·待搬 | `tools/` |
| `tools/export-events.py` | `system/evidence` | 插件·待搬 | `tools/` |
| `tools/g1-walkthrough.py` | `system/repo-gate` | 插件·待搬 | `tests/` |
| `tools/gate-nudge.py` | `domain/gate-timeline` | 插件·待搬 | `tools/` |
| `tools/manual-check.py` | `system/repo-gate` | 插件·待搬 | `tools/` |
| `tools/mutate-ui-views.py` | `system/webui` | 插件·待搬 | `tools/` |
| `tools/netblock.c` | `system/runtime` | 插件·待搬 | `tests/` |
| `tools/plugin.sh` | — | 平台薄入口 | — |
| `tools/quote-draft.py` | `domain/quote-prepare` | 插件·待搬 | `tools/` |
| `tools/quote-sign.py` | `domain/quote-prepare` | 插件·待搬 | `tools/` |
| `tools/refresh-admin-snapshot.py` | `system/admin` | 插件·待搬 | `tools/` |
| `tools/refresh-agent-memory.py` | `system/agent-runtime` | 插件·待搬 | `tools/` |
| `tools/refresh-retention-plan.py` | `system/retention` | 插件·待搬 | `tools/` |
| `tools/refresh-ui-snapshots.py` | `system/webui` | 插件·待搬 | `tools/` |
| `tools/rfq-promise.py` | `domain/rfq-deadline` | 插件·待搬 | `tools/` |
| `tools/run.sh` | — | 平台薄入口 | — |
| `tools/runtime.sh` | — | 平台薄入口 | — |
| `tools/storage.py` | `system/storage` | 插件·待搬 | `tools/` |
| `tools/ui-feedback-apply.py` | `system/ui-feedback` | 插件·待搬 | `tools/` |
| `tools/ui-feedback-monitor.sh` | `system/ui-feedback` | 插件·待搬 | `tools/` |
| `tools/ui-feedback-tick.sh` | `system/ui-feedback` | 插件·待搬 | `tools/` |
| `tools/ui-seed-pipeline.py` | `system/webui` | 插件·待搬 | `tools/` |
| `tools/userplugin-elevate.py` | `system/user-plugin-manager` | 插件·待搬 | `tools/` |
| `tools/userplugin-record.py` | `system/user-plugin-manager` | 插件·待搬 | `tools/` |
| `tools/v-kit.sh` | `system/repo-gate` | 插件·待搬 | `tools/` |
| `tools/verify.sh` | — | 平台薄入口 | — |
| `tools/webui-serve.py` | `system/webui` | 插件·待搬 | `tools/` |
| `tools/ws-integrate.py` | `system/runtime` | 插件·待搬 | `tools/` |

### B. `host/*-gate.mjs`（20 个：**已全部搬** —— 阶段 4.2 前 10 个（EV-172）+ 续批 10 个（EV-173））

| 资产 | 归属插件 | 分类 | 子目录 |
|---|---|---|---|
| `host/t247-idem-gate.mjs` | `system/idempotency-guard` | 插件·已搬 | `tests/` |
| `host/t247-scorecard-gate.mjs` | `domain/supplier-scorecard` | 插件·已搬 | `tests/` |
| `host/t250-approval-gate.mjs` | `system/approval` | 插件·已搬 | `tests/` |
| `host/t250-budget-gate.mjs` | `system/budget-guard` | 插件·已搬 | `tests/` |
| `host/t254-retention-view-gate.mjs` | `system/retention` | 插件·已搬 | `tests/` |
| `host/t260-pipeline-gate.mjs` | `system/pipeline-view` | 插件·已搬 | `tests/` |
| `host/t267-market-gate.mjs` | `system/market` | 插件·已搬 | `tests/` |
| `host/t268-user-space-gate.mjs` | `system/user-plugin-manager` | 插件·已搬 | `tests/` |
| `host/t271-admin-gate.mjs` | `system/admin` | 插件·已搬 | `tests/` |
| `host/t275-runtime-gate.mjs` | `system/agent-runtime` | 插件·已搬 | `tests/` |
| `host/t277-storage-gate.mjs` | `system/storage` | 插件·已搬 | `tests/` |
| `host/t279-heuristics-gate.mjs` | `domain/bid-heuristics` | 插件·已搬 | `tests/` |
| `host/t280-ui-feedback-gate.mjs` | `system/ui-feedback` | 插件·已搬 | `tests/` |
| `host/t281-advice-gate.mjs` | `domain/advice` | 插件·已搬 | `tests/` |
| `host/t282-gate-timeline-gate.mjs` | `domain/gate-timeline` | 插件·已搬 | `tests/` |
| `host/t283-change-detail-gate.mjs` | `domain/gate-timeline` | 插件·已搬 | `tests/` |
| `host/t284-authority-gate.mjs` | `domain/authority-band` | 插件·已搬 | `tests/` |
| `host/t285-rfq-deadline-gate.mjs` | `domain/rfq-deadline` | 插件·已搬 | `tests/` |
| `host/t286-quote-draft-gate.mjs` | `domain/quote-prepare` | 插件·已搬 | `tests/` |
| `host/t287-rfq-visibility-gate.mjs` | `system/projection` | 插件·已搬 | `tests/` |

### C. `src/quotagent/qa/checks_*.py`（47 个：平台薄入口 0 + 已搬 **47**（阶段 4.1 的 1 + `EV-173` 的 21 + `EV-174` 的 25）+ 待搬 0）

| 资产 | 归属插件 | 分类 | 子目录 |
|---|---|---|---|
| `src/quotagent/qa/checks_admin.py` | `system/admin` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_adv.py` | `domain/advice` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_agentrt.py` | `system/agent-runtime` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_agentrt_lifecycle.py` | `system/agent-runtime` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_agentrt_memory.py` | `system/agent-runtime` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_audit.py` | `system/evidence` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_award.py` | `domain/commitments` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_bridge.py` | `system/kernel-bridge` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_capacity.py` | `domain/capacity` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_change.py` | `domain/change` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_clarify.py` | `domain/clarify` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_compare.py` | `domain/compare` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_config.py` | `system/config` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_cost.py` | `domain/costmodel` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_design.py` | `system/repo-gate` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_deviation.py` | `domain/deviation` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_eval.py` | `system/eval` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_events.py` | `system/kernel` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_export.py` | `domain/export` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_faq.py` | `domain/faq` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_gate.py` | `domain/gate-timeline` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_guard.py` | `domain/guard` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_intake.py` | `domain/intake` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_mail.py` | `system/mail` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_mail_transport.py` | `system/mail` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_negotiation.py` | `domain/negotiation` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_norm.py` | `system/norm` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_plugin.py` | `system/kernel` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_pricing.py` | `domain/pricing` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_qep.py` | `system/kernel` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_qprep.py` | `domain/quote-prepare` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_quotes.py` | `domain/quotes` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_retention.py` | `system/retention` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_retention_exec.py` | `system/retention` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_rfq.py` | `domain/rfq` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_runtime.py` | `system/runtime` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_storage.py` | `system/storage` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_sync.py` | `domain/sync` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_terms.py` | `domain/terms` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_ui_snapshot.py` | `system/webui` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_uifb.py` | `system/ui-feedback` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_userplugin.py` | `system/user-plugin-manager` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_userplugin_elevate.py` | `system/user-plugin-manager` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_userplugin_versions.py` | `system/user-plugin-manager` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_usreq.py` | `system/repo-gate` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_uxweb.py` | `system/webui` | 插件·已搬 | `tests/` |
| `src/quotagent/qa/checks_viz.py` | `domain/bid-heuristics` | 插件·已搬 | `tests/` |

> 说明 1：`tools/check-plugin-assets.py`（本节的机检门）、`tools/check-plugin-requirements.py`、`tools/check-run-once.py`
> 与 `tools/netblock.c` 这 4 项**不在**本文件上面的逐文件映射表里（那是更早批次生成的）；本节把它们一并登记（归属按同一个口径判定）。
> 说明 2：本节的 143 行与磁盘**双向可复算**：`§A` 行数 == `tools/` 顶层文件数、`§B` == `host/*-gate.mjs`、`§C` == `src/quotagent/qa/checks_*.py`
> （`tools/verify.sh plugin-assets` 的 PA4 断言这件事：新增一个资产而不登记即红）。
> 说明 3：预算 —— 本节使本文件从 26646 B 增到约 41 KB，因此 `docs/design/12-documentation-standard.md` §1 把
> `docs/work/plans/*.md` 行从 32 KB 提到 48 KB，**同时**为 `docs/work/plans/` 下既有 5 个文件各加一条**具体**预算行钉在 32 KB
> （具体行只能收紧，不能放宽）—— 即：放宽只对本节生效，其它文件的预算一格未松。

（完）
