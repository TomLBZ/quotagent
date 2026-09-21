# 15 需求覆盖矩阵（机检：`tools/verify.sh coverage`）

> 目的：把「**每个功能都由插件提供**」从文字声称变成**可核对**的映射。
> 门会断言：与 FR 文档、插件目录**双向全覆盖**；承载体**真实存在**；状态合法；【缺口】【存疑】**逐条登记**；每个插件至少归属 1 条 FR/AC。
> 生成方式：FR 侧由 `tmp/t251-fr-map.md`（逐条打开文件核对符号与行号）转写；插件侧由 `tmp/t251-plugin-map.md` 转写，并经父方核验。

## 1. FR 覆盖

| FR | 承载体 | 证据 | 状态 |
|---|---|---|---|
| FR-APPROVE-001 | src/quotagent/services/approval.py | ApprovalService.request() | 直引 |
| FR-APPROVE-002 | src/quotagent/services/approval.py | ApprovalService.require(scope, ref, approval | 直引 |
| FR-APPROVE-003 | src/quotagent/services/approval.py | ApprovalService.sweep() | 直引 |
| FR-AWARD-001 | src/quotagent/services/commitments.py | CommitmentGate.intent(package_id, quote_id,  | 直引 |
| FR-AWARD-002 | src/quotagent/services/commitments.py | CommitmentGate.commit_award(intent, supplier | 直引 |
| FR-AWARD-003 | src/quotagent/services/commitments.py | CommitmentGate.issue_po(award_id, lines) | 直引 |
| FR-CAP-001 | src/quotagent/services/capacity.py | CapacityService.feasibility(commitment_id, r | 直引 |
| FR-CAP-002 | src/quotagent/services/capacity.py | CapacityService.amend()（firm + 有效期内 + 模型发起 → | 直引 |
| FR-CHANGE-001 | src/quotagent/services/change.py | ChangeService.propose(quote, deltas) | 直引 |
| FR-CHANGE-002 | src/quotagent/services/change.py | ChangeService.recompute(change_id) | 直引 |
| FR-CLARIFY-001 | src/quotagent/services/clarify.py | ClarificationService.ask(package_id, rfq_rev | 直引 |
| FR-CLARIFY-002 | src/quotagent/services/clarify.py | ClarificationService.broadcast(to) | 直引 |
| FR-CLARIFY-003 | src/quotagent/services/clarify.py | ClarificationService.on_package_rev(package_ | 直引 |
| FR-CLARIFY-004 | src/quotagent/services/faq.py | FaqService.reuse（AC-FAQ-001；跨版本必须不命中） | 直引 |
| FR-COMPARE-001 | src/quotagent/services/compare.py | CompareService.tco(quote, package, policy) | 映射 |
| FR-COMPARE-002 | src/quotagent/services/compare.py | CompareService.rank(package, quotes, weights | 直引 |
| FR-COMPARE-003 | src/quotagent/services/compare.py | CompareService.verify_citations(evaluation) | 直引 |
| FR-COMPARE-004 | src/quotagent/services/export.py | ExportService.comparison_rows(evaluation, fl | 直引 |
| FR-COST-001 | src/quotagent/services/costmodel.py | CostModelService.build(items, quote_id) | 映射 |
| FR-COST-002 | src/quotagent/services/costmodel.py | PrivateStore（按 realm 隔离的私域存储） | 直引 |
| FR-COST-003 | src/quotagent/services/costmodel.py | CostModelService.explain(quote_id, item_id) | 映射 |
| FR-DEV-001 | src/quotagent/services/deviation.py | DeviationService.capture(draft, package) | 映射 |
| FR-DEV-002 | src/quotagent/services/deviation.py | DeviationService.alternative(deviation_id) | 映射 |
| FR-EVAL-001 | src/quotagent/services/scenarios.py | SCENARIOS = {"s1": run_s1, ...} | 映射 |
| FR-EVAL-002 | src/quotagent/services/scenarios.py | _digest(steps, facts, assertions)（sort_keys  | 映射 |
| FR-EVAL-003 | src/quotagent/services/evalmetrics.py | collect_metrics(ledger) | 直引 |
| FR-EVAL-004 | src/quotagent/services/evaldata.py | CounterexampleImmutable | 直引 |
| FR-EVIDENCE-001 | src/quotagent/kernel/evidence.py | export(ledger, scope, from_seq, to_seq)（事件切片 | 映射 |
| FR-EVIDENCE-002 | src/quotagent/kernel/evidence.py | evidence.verify(pack, keystore, require_sign | 直引 |
| FR-EVIDENCE-003 | src/quotagent/kernel/modelgate.py | ModelGateway.rebuild_matches(call_id) | 映射 |
| FR-EVIDENCE-004 | src/quotagent/services/retention.py、src/quotagent/services/retention_exec.py | 计划侧（AC-AUDIT-003）+ 执行侧（AC-AUDIT-005），两侧均有门 | 直引 |
| FR-EVIDENCE-005 | src/quotagent/kernel/evidence.py | sign_pack(pack, keystore, participant) | 直引 |
| FR-EVOLVE-001 | host/lib/evolution.mjs | makeProposal(input,{history})（target/diff/ra | 映射 |
| FR-EVOLVE-002 | host/lib/evolution.mjs | shadowMount(proposal,{ledgerPath,shadowDir,p | 映射 |
| FR-EVOLVE-003 | host/lib/evolution.mjs | gate(proposal, evidence)（五条 AND：指标不退化/INV 全绿 | 映射 |
| FR-EVOLVE-004 | host/lib/evolution.mjs | makeProposal 的 kernel-target-refused 分支 | 映射 |
| FR-EVOLVE-005 | host/modules/canary.mjs | enterCanary({proposal_id, approval_ref}) | 映射 |
| FR-EVOLVE-006 | host/lib/evolution.mjs | SAME_KIND_FAILURE_LIMIT = 3 | 映射 |
| FR-EVT-001 | src/quotagent/kernel/events.py | EventBus.emit/parallel/serial/bail/waterfall | 映射 |
| FR-EVT-002 | src/quotagent/kernel/events.py | EventBus.on()（返回 disposer） | 直引 |
| FR-EVT-003 | src/quotagent/kernel/events.py | EventBus.declare()（waterfall 无 reason 即抛 Eve | 直引 |
| FR-GUARD-001 | src/quotagent/services/guard.py | GuardService._rule_abnormal_low() | 映射 |
| FR-GUARD-002 | src/quotagent/services/guard.py | GuardService._rule_missing_item() | 映射 |
| FR-GUARD-003 | src/quotagent/services/capacity.py | CapacityService.feasibility() | 直引 |
| FR-GUARD-004 | src/quotagent/services/guard.py | GuardService._rule_term_conflict()（三族） | 直引 |
| FR-GUARD-005 | src/quotagent/services/guard.py | GuardService._rule_private_leak() | 映射 |
| FR-INTAKE-001 | src/quotagent/services/intake.py | TemplateExtractor.extract(package) | 映射 |
| FR-INTAKE-002 | src/quotagent/services/intake.py | IntakeService.missing(draft) | 映射 |
| FR-INTAKE-003 | src/quotagent/services/intake.py | ASSUMPTION_MARKER = "[假设]" | 映射 |
| FR-INTEG-001 | src/quotagent/kernel/delivery.py | FileTransport.stage(envelope, to) | 直引 |
| FR-INTEG-002 | src/quotagent/services/relay.py | RelayService.accept(message, to) | 直引 |
| FR-INTEG-003 | src/quotagent/services/mail.py、src/quotagent/services/mail_transport.py | MailService.compose/enqueue/parse（AC-MAIL-001）+ MailTransport.send/fetch_recent/probe（真收发，`tools/verify.sh mail-transport` 27 条） | 直引 |
| FR-INTEG-004 | src/quotagent/bridge.py | BridgeKernel.hello() | 映射 |
| FR-LEDGER-001 | src/quotagent/kernel/ledger.py | Ledger.append() | 直引 |
| FR-LEDGER-002 | src/quotagent/kernel/ledger.py | Ledger.project(view, from_seq, to_seq) | 直引 |
| FR-LEDGER-003 | src/quotagent/kernel/ledger.py | Ledger.assert_healthy() | 直引 |
| FR-LEDGER-004 | src/quotagent/kernel/ledger.py | Ledger._dedup_key() | 直引 |
| FR-NEGO-001 | src/quotagent/services/negotiation.py | NegotiationService（AC-NEGO-003，15+ 断言） | 直引 |
| FR-NEGO-002 | src/quotagent/services/negotiation.py | NegotiationService（AC-NEGO-003，15+ 断言） | 直引 |
| FR-NORM-001 | src/quotagent/services/norm.py | NormService.normalize() | 映射 |
| FR-NORM-002 | src/quotagent/services/norm.py | Rejection | 映射 |
| FR-NORM-003 | src/quotagent/services/norm.py | NormService._stage_align() | 映射 |
| FR-NORM-004 | src/quotagent/services/quotes.py | QuoteBook.on_amended(from_rev,to_rev) | 直引 |
| FR-PLUGIN-001 | src/quotagent/kernel/plugin.py | PluginHost._activate() | 直引 |
| FR-PLUGIN-002 | src/quotagent/kernel/plugin.py | PluginHost._reconcile() | 直引 |
| FR-PLUGIN-003 | src/quotagent/kernel/plugin.py | PluginHost.unmount() | 直引 |
| FR-PLUGIN-004 | src/quotagent/kernel/plugin.py | PluginHost.update() | 直引 |
| FR-PRICE-001 | src/quotagent/services/pricing.py | PricingService.price(quote_id, item_id) | 映射 |
| FR-PRICE-002 | src/quotagent/services/pricing.py | PricingService.confirm(proposal_id, by) | 直引 |
| FR-QEP-001 | src/quotagent/kernel/qep.py | QepEndpoint.envelope() | 映射 |
| FR-QEP-002 | src/quotagent/kernel/qep.py | QepEndpoint.validate() → commitment 缺 approv | 直引 |
| FR-QEP-003 | src/quotagent/kernel/qep.py | QepEndpoint._drain_held() | 直引 |
| FR-QEP-004 | src/quotagent/kernel/qep.py | QepEndpoint._apply() | 直引 |
| FR-QEP-005 | src/quotagent/kernel/qep.py | QepEndpoint.negotiate(peer) | 映射 |
| FR-QEP-006 | src/quotagent/kernel/qep.py | NON_DEGRADABLE_FEATURES | 映射 |
| FR-QEP-007 | src/quotagent/services/sync.py | SyncService.reconcile(entry_id, base, mine,  | 直引 |
| FR-QEP-008 | src/quotagent/kernel/qep.py | QepEndpoint._recover_outbox() | 映射 |
| FR-RFQ-001 | src/quotagent/services/rfq.py | RfqService.create_package(spec) | 映射 |
| FR-RFQ-002 | src/quotagent/services/rfq.py | RfqService.add_items(items) | 映射 |
| FR-RFQ-003 | src/quotagent/services/rfq.py | RfqService.publish() | 映射 |
| FR-RFQ-004 | src/quotagent/services/rfq.py | RfqService.distribute(participants, rev) | 直引 |
| FR-RFQ-005 | src/quotagent/services/rfq.py | RfqService.deadline_status(rev, now) | 直引 |
| FR-RFQ-006 | src/quotagent/services/quotes.py | QuoteBook.on_amended()（标 superseded + 重报请求） | 直引 |
| FR-RUNTIME-001 | tools/runtime.sh | 解释器探测脚本 _qt_probe（断言 3.9+） | 映射 |
| FR-RUNTIME-002 | src/quotagent/qa/__main__.py | build_parser()（ac/suite/list/metrics 子命令） | 映射 |
| FR-TERMS-001 | src/quotagent/services/terms.py | TermLibrary.apply_defaults(terms, as_of) | 直引 |
| FR-TERMS-002 | src/quotagent/services/terms.py | TermLibrary.conflicts(required, offered) | 直引 |
| FR-UX-001 | src/quotagent/services/approval.py | ApprovalService.queue_view(now, policy) | 直引 |
| FR-UX-002 | src/quotagent/services/realm.py | RealmProjector.project(record, to_realm) | 映射 |
| FR-UX-003 | src/quotagent/services/export.py | ExportService.to_csv(rows, bom=True) | 直引 |

> 本节之外还有 **14 条 P2 新增 FR**（见 §4）同样在本矩阵管辖内（§1 与本文件同步更新）。
| FR-RUNTIME-003 | host/modules/audit-hook.mjs | AC-RUNTIME-003（见 §4 的机检命令） | 映射 |
| FR-RUNTIME-004 | host/modules/budget-guard.mjs | AC-RUNTIME-004（见 §4 的机检命令） | 映射 |
| FR-RUNTIME-005 | host/modules/circuit-breaker.mjs | AC-RUNTIME-005（见 §4 的机检命令） | 映射 |
| FR-RUNTIME-006 | host/modules/governor.mjs | AC-RUNTIME-006（见 §4 的机检命令） | 映射 |
| FR-RUNTIME-007 | host/modules/observability.mjs | AC-RUNTIME-007（见 §4 的机检命令） | 映射 |
| FR-RUNTIME-008 | host/modules/timeline.mjs | AC-RUNTIME-008（见 §4 的机检命令） | 映射 |
| FR-RUNTIME-009 | host/modules/idempotency-guard.mjs | AC-RUNTIME-009（见 §4 的机检命令） | 映射 |
| FR-EVIDENCE-006 | host/modules/evidence-summary.mjs | AC-EVIDENCE-003（见 §4 的机检命令） | 映射 |
| FR-EVOLVE-007 | host/modules/evolve-journal.mjs | AC-EVOLVE-005（见 §4 的机检命令） | 映射 |
| FR-PRICE-003 | host/modules/price-history.mjs | AC-PRICE-002（见 §4 的机检命令） | 映射 |
| FR-RFQ-007 | host/modules/sourcing.mjs | AC-RFQ-005（见 §4 的机检命令） | 映射 |
| FR-EVAL-005 | host/modules/supplier-scorecard.mjs | AC-EVAL-003（见 §4 的机检命令） | 映射 |
| FR-UX-004 | host/modules/ops-view.mjs | AC-RUNTIME-010（见 §4 的机检命令） | 映射 |

| FR-UX-005 | tools/refresh-ui-snapshots.py、host/modules/pipeline-view.mjs | AC-UI-002 + AC-PIPELINE-001 | 直引 |


| FR-ADMIN-001 | host/modules/admin-view.mjs | 见对应 AC | 直引 |
| FR-ADMIN-002 | host/modules/admin-guard.mjs | 见对应 AC | 直引 |
| FR-ADMIN-003 | host/modules/admin-view.mjs | 见对应 AC | 直引 |
| FR-ADMIN-005 | tools/admin-apply.py（唯一写账本的一方）+ host/modules/webui.mjs（提交面，只落待处理项） | 见 AC-ADMIN-005 | 直引 |
| FR-ADMIN-004 | src/quotagent/services/admin_blocks.py | 见对应 AC | 直引 |
| FR-ADMIN-006 | src/quotagent/services/admin_blocks.py | 见对应 AC | 直引 |
| FR-ADMIN-007 | host/modules/admin-guard.mjs | 见对应 AC | 直引 |
| FR-ADMIN-008 | host/modules/admin-guard.mjs | 见对应 AC | 直引 |
| FR-ADMIN-009 | host/modules/admin-guard.mjs | 见对应 AC | 直引 |
| FR-ADMIN-010 | host/modules/admin-guard.mjs | 见对应 AC | 直引 |

| FR-MARKET-001 | host/modules/plugin-market.mjs | 见 AC-MARKET-001 | 直引 |
| FR-MARKET-002 | host/modules/plugin-market.mjs | 见 AC-MARKET-002 | 直引 |
| FR-MARKET-003 | host/modules/plugin-market.mjs | 见 AC-MARKET-003 | 直引 |
| FR-MARKET-004 | host/modules/plugin-market.mjs | 见 AC-MARKET-004 | 直引 |
| FR-MARKET-005 | host/modules/plugin-market.mjs | 见 AC-MARKET-005 | 直引 |
| FR-MARKET-006 | host/modules/plugin-market.mjs | 见 AC-MARKET-006 | 直引 |

| FR-USERPLUG-002 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-002 | 直引 |
| FR-USERPLUG-003 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-003 | 直引 |
| FR-USERPLUG-004 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-004 | 直引 |
| FR-USERPLUG-006 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-006 | 直引 |
| FR-USERPLUG-007 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-007 | 直引 |
| FR-USERPLUG-008 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-008 | 直引 |
| FR-USERPLUG-009 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-009 | 直引 |
| FR-USERPLUG-011 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-011 | 直引 |
| FR-USERPLUG-012 | host/lib/user-space.mjs + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-012 | 直引 |

| FR-USERPLUG-001 | tools/userplugin-record.py + host/lib/user-space.mjs（scan/列表） | 见 AC-USERPLUG-001 | 直引 |
| FR-USERPLUG-005 | tools/userplugin-record.py + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-005 | 直引 |
| FR-USERPLUG-010 | tools/userplugin-elevate.py + host/modules/user-plugin-manager.mjs | 见 AC-USERPLUG-010 | 直引 |
| FR-AGENTRT-006 | host/modules/agent-context.mjs + host/modules/agent-memory.mjs + host/modules/agent-harness.mjs | 见 AC-AGENTRT-006 | 直引 |
| FR-AGENTRT-007 | host/modules/agent-context.mjs + host/modules/agent-memory.mjs + host/modules/agent-harness.mjs | 见 AC-AGENTRT-007 | 直引 |
| FR-AGENTRT-002 | tools/refresh-agent-memory.py + host/modules/agent-memory.mjs | 见 AC-AGENTRT-002 | 直引 |
| FR-STORAGE-001 | tools/storage.py + host/modules/storage-view.mjs | 见 AC-STORAGE-001 | 直引 |
| FR-STORAGE-004 | tools/storage.py | 见 AC-STORAGE-004 | 直引 |
| FR-STORAGE-006 | tools/storage.py + host/modules/storage-view.mjs | 见 AC-STORAGE-006 | 直引 |
| FR-UXWEB-001 | host/modules/webui.mjs | 见 AC-UXWEB-001 | 直引 |
| FR-UXWEB-002 | host/modules/webui.mjs | 见 AC-UXWEB-001 | 直引 |
| FR-CONFIG-001 | host/modules/config-view.mjs + host/lib/config-ui.mjs + tools/config-apply.py | 见 AC-CONFIG-001 | 直引 |
| FR-CONFIG-002 | tools/config-apply.py + host/lib/config-keys.mjs | 见 AC-CONFIG-001 | 直引 |
| FR-MAIL-001 | src/quotagent/services/mail_transport.py + src/quotagent/services/mail.py | 见 AC-MAIL-001 | 直引 |
| FR-MAIL-002 | host/modules/mail-view.mjs + host/lib/config-keys.mjs | 见 AC-MAIL-002 | 直引 |
| FR-VIZ-001 | host/modules/bid-heuristics.mjs | 见 AC-VIZ-001 | 直引 |

## 2. 插件归属

| 插件 | 归属 FR/AC | 强度 |
|---|---|---|
| approval-digest | FR-UX-001 | 部分 |
| user-plugin-manager | FR-USERPLUG-003、FR-USERPLUG-004、FR-USERPLUG-006、FR-USERPLUG-008（T-268 subagent 产出） | 强 |
| agent-context | FR-AGENTRT-006（有界/降级）| 部分 |
| agent-memory | FR-AGENTRT-006（有界/降级）| 部分 |
| agent-harness | FR-AGENTRT-006（有界/降级）| 部分 |
| storage-view | FR-STORAGE-006 | 直引 |
| config-view | FR-CONFIG-001 | 直引 |
| plugin-market | FR-MARKET-001、FR-MARKET-002、FR-MARKET-003、FR-MARKET-004、FR-MARKET-005、FR-MARKET-006（T-267 subagent 产出） | 强 |
| admin-guard | FR-ADMIN-002、FR-ADMIN-007、FR-ADMIN-008、FR-ADMIN-009、FR-ADMIN-010（T-272 subagent 产出） | 强 |
| admin-view | FR-ADMIN-001、FR-ADMIN-003、FR-ADMIN-004（T-272 subagent 产出） | 强 |
| audit-hook | FR-RUNTIME-003（本次登记） | 强 |
| bridge-canary | FR-EVOLVE-005 | 部分 |
| budget-guard | AC-RUNTIME-004（本次登记） | — |
| canary | FR-EVOLVE-005, AC-EVOLVE-003 | 强 / 部分 |
| circuit-breaker | AC-RUNTIME-005（本次登记） | — |
| compare | FR-COMPARE-001, FR-COMPARE-002 | 部分 / 部分 |
| evidence-summary | AC-EVIDENCE-003（本次登记） | — |
| evolve-journal | AC-EVOLVE-005（本次登记） | — |
| governor | AC-RUNTIME-006（本次登记） | — |
| idempotency-guard | FR-RUNTIME-009（本次登记） | 强 |
| kernel-bridge | FR-INTEG-004, AC-INTEG-005 | 部分 / 部分 |
| norm | FR-NORM-001, FR-NORM-002, AC-NORM-001 | 部分 / 部分 / 部分 |
| observability | AC-RUNTIME-007（本次登记） | — |
| ops-view | AC-RUNTIME-010（本次登记） | — |
| price-history | AC-PRICE-002（本次登记） | — |
| projection | FR-UX-002, AC-TRUST-001 | 强 / 部分 |
| sourcing | AC-RFQ-005（本次登记） | — |
| supplier-scorecard | AC-EVAL-003（本次登记） | — |
| timeline | AC-RUNTIME-008（本次登记） | — |
| pipeline-view | FR-UX-005、FR-NEGO-001、FR-CLARIFY-004、FR-INTEG-003（三域运维可见） | 强 |
| retention-view | FR-EVIDENCE-004、FR-UX-004（本次登记） | 强 |
| mail-view | FR-INTEG-003、FR-UX-005（邮件域只读视图：队列计数 / 最近一次尝试 / available / next_action；本次登记） | 强 |
| bid-heuristics | FR-COMPARE-002（权重可调 + 同输入同输出）、FR-UX-002（供应商视角不暴露承包商私域）、FR-UX-003（比价口径对齐；本次登记） | 强 |
| webui | FR-UX-001、FR-UX-002、FR-INTEG-001 | 强 |

> 更新（T-253）：`FR-EVIDENCE-004` **已完整落地（计划侧 + 执行侧）**，`AC-AUDIT-003`/`AC-AUDIT-005` 均有机检。
> 原注（T-252）：`FR-EVIDENCE-004` 已从【缺口】转为**部分实现** —— 判定器入库并有机检（`verify.sh retention`），
> 但**执行侧**（删除派生副本、读侧封存）尚未实现；`AC-AUDIT-003` 因此**不标绿**，执行侧见清单 T-253。

> 更新（T-256）：`FR-NEGO-001/002` 已落地（服务层 + 机检 `AC-NEGO-003`）。

> 更新（T-257）：`FR-CLARIFY-004` 已落地（`services/faq.py` + `AC-FAQ-001`）。

> 更新（T-258）：`FR-INTEG-003` 拆两半 —— **无凭据部分已落地**（`services/mail.py` + `AC-MAIL-001`）；**发信/收信仍待 SMTP/IMAP 凭据**（登记为 T-259，属人工输入）。

> 更新（本批）：`FR-INTEG-003` 的**发信/收信已落地**：`services/mail_transport.py`（SMTP/IMAP，纯标准库）
> 在凭据就位时真收发、没凭据时**分得清**「没配 / 配了没试过 / 连不上」（不同 reason + next_action），
> 凭据不进账本/响应/日志（`mail/sent` 是事实行，body 无凭据无正文），收信有界并报截断；
> 运维道可见面为 `mail-view` 插件 + `GET /quotagent/ops/mail/`（0 行 `<script>`）与 `GET /quotagent/api/mail`。
> 机检：`tools/verify.sh mail-transport`（27 条，含回环假 SMTP/IMAP 真收发与哨兵零泄漏）。

## 3. 缺口与存疑登记

> 门要求：状态为【缺口】【存疑】的 FR **必须**在本节逐条登记，且状态只能取 直引/映射/缺口/存疑。

| ID | 类型 | 说明 | 计划 |
|---|---|---|---|
| FR-CLARIFY-004 | src/quotagent/services/faq.py | FaqService.reuse（AC-FAQ-001；跨版本必须不命中） | 直引 |
| FR-EVIDENCE-004 | src/quotagent/services/retention.py、src/quotagent/services/retention_exec.py | 计划侧（AC-AUDIT-003）+ 执行侧（AC-AUDIT-005），两侧均有门 | 直引 |
| FR-NEGO-001 | src/quotagent/services/negotiation.py | NegotiationService（AC-NEGO-003，15+ 断言） | 直引 |
| FR-NEGO-002 | src/quotagent/services/negotiation.py | NegotiationService（AC-NEGO-003，15+ 断言） | 直引 |
| FR-INTEG-003 | src/quotagent/services/mail.py、src/quotagent/services/mail_transport.py | MailService.compose/enqueue/parse（AC-MAIL-001）+ MailTransport.send/fetch_recent/probe（真收发，`tools/verify.sh mail-transport` 27 条） | 直引 |

## 4. 本次新增的 P2 需求（12 件无归属插件 + 1 条总纲）

| 新增 FR | 插件 | 新增 AC | 该 AC 的机检命令（已存在且真绿） | 证据 |
|---|---|---|---|---|
| FR-RUNTIME-003 | audit-hook | AC-RUNTIME-003 | audit-hook 门 7/7 | `EV-068` |
| FR-RUNTIME-004 | budget-guard | AC-RUNTIME-004 | budget-guard 门 10/10 + budget-route 门 5/5 | `EV-085` |
| FR-RUNTIME-005 | circuit-breaker | AC-RUNTIME-005 | breaker 门 10/10 + breaker-route 门 4/4 | `EV-077` |
| FR-RUNTIME-006 | governor | AC-RUNTIME-006 | governor 门 9/9 | `EV-067` |
| FR-RUNTIME-007 | observability | AC-RUNTIME-007 | observability 门 6/6 | `EV-071` |
| FR-RUNTIME-008 | timeline | AC-RUNTIME-008 | modules 门 248/248 | `EV-038` |
| FR-RUNTIME-009 | idempotency-guard | AC-RUNTIME-009 | idempotency-guard 门 10/10 + idem-route 门 5/5 | `EV-083` |
| FR-EVIDENCE-006 | evidence-summary | AC-EVIDENCE-003 | evolve-module 追溯门 11/11 + webui 21/21 | `EV-075` |
| FR-EVOLVE-007 | evolve-journal | AC-EVOLVE-005 | evolve-journal 门 7/7 | `EV-080` |
| FR-PRICE-003 | price-history | AC-PRICE-002 | evolve-module 追溯门 11/11 + webui 21/21 | `EV-073` |
| FR-RFQ-007 | sourcing | AC-RFQ-005 | modules 门 248/248 | `EV-039` |
| FR-EVAL-005 | supplier-scorecard | AC-EVAL-003 | supplier-scorecard 门 10/10 + webui 21/21 | `EV-082` |
| FR-UX-004 | ops-view | AC-RUNTIME-010 | ops-view 门 9/9 + webui 21/21 | `EV-079` |
| FR-PLUGIN-004 | (全部插件) | AC-PLUGIN-004 | coverage 门 + plugins 门 + evolve-module 门 | `EV-086` |

> 新增理由：这 12 件插件（其中 7 件为**自进化产出**）此前**没有任何需求归属** ——
> 也就是说"功能已实现、门全绿"，但需求体系里没有它的位置。补登记后，
> 「插件 ↔ 需求」双向可核对，`verify.sh coverage` 不会再有孤儿。

