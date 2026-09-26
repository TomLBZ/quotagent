# Architecture decisions
<!-- budget: 16384 bytes, hard -->

Accepted bodies preserve historical decisions. Current boundaries are summarized in
[architecture](../architecture.md); later decisions supersede older implementation
mechanics without rewriting their original meaning.

| Decision | Title |
|---|---|
| [0001](0001-adopt-cordis-context-paradigm.md) | ADR-0001 采用 Cordis 的 context 范式作为系统设计内核 |
| [0002](0002-kernel-frozen-and-capability-seams.md) | ADR-0002 内核冻结 + 能力以接缝三角扩展 |
| [0003](0003-cross-party-reconciliation.md) | ADR-0003 跨方账本同步：字段权威方 + 三方协调 |
| [0004](0004-fact-intent-commitment.md) | ADR-0004 事实/意图/承诺三分，承诺必须人工批准 |
| [0005](0005-evolution-gated.md) | ADR-0005 自进化必须经影子重放 + 评测门 + canary |
| [0006](0006-transport-agnostic-qep.md) | ADR-0006 QEP 传输无关，协议版本不兼容即拒绝 |
| [0007](0007-p0-runtime-and-ledger-format.md) | ADR-0007 P0 实现栈与账本文件格式 |
| [0008](0008-p0-qep-signature-and-file-binding.md) | ADR-0008 P0 的 QEP 落地细节：签名机制与文件投递绑定 |
| [0009](0009-p0-norm-versioning-intake-semantics.md) | ADR-0009 P0 的归一化、版本化与读包落地语义 |
| [0010](0010-p0-approval-and-realm-filtering.md) | ADR-0010 P0 的人工门与 realm 过滤落地语义 |
| [0011](0011-p0-compare-guard-eval-semantics.md) | ADR-0011 P0 的比价（TCO 与引用链）、护栏（只标注）、场景集与指标基线 |
| [0012](0012-direct-cordis-dependency-as-host.md) | ADR-0012 直接依赖 cordis 作为宿主层（取代 ADR-0001 的"不引入其代码"条款） |
| [0013](0013-cordis-bridge-protocol.md) | ADR-0013 cordis 宿主与 Python 内核的桥接协议（NDJSON over stdio v1） |
| [0014](0014-p1-under-assumed-validations.md) | ADR-0014 P1 的推进前提（V 假设通过）、MVP 判据与削减顺序 |
| [0015](0015-host-profiles-and-config-veto.md) | ADR-0015 宿主 profile（组成即数据）与配置更新的否决语义 |
| [0016](0016-self-evolution-artifact-surface.md) | ADR-0016 自进化的可写面：插件产物由提案交付，晋升仍需人工引用 |
| [0017](0017-canary-routing-and-auto-rollback.md) | ADR-0017 canary 分流与自动回滚的方向性 |
| [0018](0018-retention-and-destruction-boundary.md) | ADR-0018 留存与销毁的边界：账本行永不销毁，销毁只作用于派生副本 |
| [0019](0019-negotiation-rounds-and-concessions.md) | ADR-0019 谈判轮次与让步的边界 |
| [0020](0020-everything-is-a-plugin.md) | ADR-0020 一切皆插件：三层分类、目录规范与注入式 UI |
| [0021](0021-requirements-owned-by-plugins.md) | ADR-0021 需求必须归属到插件（不存在"产品整体"的功能性需求） |
| [0022](0022-approval-gate-facts-in-ledger-body.md) | ADR-0022 人工门的派分事实（审批人与超时策略）随开单落账本 body |
| [0023](0023-abort-reason-verbatim-in-ledger-body.md) | ADR-0023 终止（`approval/aborted`）的理由正文进账本 body |
| [0024](0024-commitment-consumes-granted-gate.md) | ADR-0024 承诺 / 发 PO 必须**消费**一扇别人批过的门（不得自签自批） |
| [0025](0025-authority-band-change-needs-second-approver.md) | ADR-0025 授权区间变更必须**另一个人**批过才生效（不得自提自批） |
| [0026](0026-shell-data-side-scoped.md) | ADR-0026 GUI 外壳共享、**数据按会话侧隔离**（`/app/<侧>/**` 与 `/api/ui/panels|object` 的侧门） |
| [0027](0027-agentic-product-composition.md) | ADR-0027 Native Cordis product composition and account workspace |
| [0028](0028-generated-personal-utility-code.md) | ADR-0028 Model-authored personal utility code |
| [0029](0029-configurable-plugin-workspace.md) | ADR-0029 Configurable runtime inventory and modular ingestion |
| [0030](0030-connected-agent-workflows.md) | ADR-0030 Connected services and reviewable agent workflows |
| [0031](0031-controllable-agent-experience.md) | ADR-0031 Controllable agent work and plugin-owned presentation |
| [0032](0032-native-rfq-version-and-clarification-records.md) | ADR-0032 Native RFQ revisions and shared clarification records |
| [0033](0033-native-private-commercial-workbench.md) | ADR-0033 Native private commercial workbench |
| [0034](0034-immutable-extension-revisions-and-runtime-ownership.md) | ADR-0034 Immutable extension revisions and independent installed runtime |
| [0035](0035-party-teams-and-reviewed-authority.md) | ADR-0035 Explicit party teams and independently reviewed authority |
| [0036](0036-bilateral-award-and-sourced-fulfillment.md) | ADR-0036 Bilateral award, sourced changes and delivery reconciliation |
| [0037](0037-native-durable-qep-exchange.md) | ADR-0037 Native durable QEP exchange and reconciliation |
| [0038](0038-auditable-agent-admission-and-run-evaluation.md) | ADR-0038 Auditable agent admission, context and run evaluation |
| [0039](0039-native-capability-request-inbox.md) | ADR-0039 Account capability requests with administrative receipts |
| [0040](0040-native-evidence-artifacts-and-retention.md) | ADR-0040 Native evidence, attachment artifacts and audited retention |
| [0041](0041-native-configuration-transactions-and-notification-delivery.md) | ADR-0041 — Native configuration transactions and notification delivery |
| [0042](0042-native-installable-shell.md) | ADR-0042 Installable native application shell |
| [0043](0043-measured-model-dispatch-boundary.md) | ADR-0043 Measure the actual model request boundary |
| [0044](0044-domain-defaults-and-paired-party-context.md) | ADR-0044 Sourced draft defaults and explicitly paired business parties |
| [0045](0045-explicit-scope-terms-and-negotiation.md) | ADR-0045 Explicit scope, term decisions and bounded private negotiation |
| [0046](0046-personal-collection-views.md) | ADR-0046 Personal collection views |
| [0047](0047-native-isolated-demonstration-runtime.md) | ADR-0047 — Native isolated demonstration runtime |
| [0048](0048-canonical-plugin-requirement-catalog.md) | ADR-0048 Canonical plugin requirements and current documentation |
| [0049](0049-response-promises-and-read-evidence.md) | ADR-0049: Response promises, read evidence and printable source views |
| [0050](0050-native-operational-metadata.md) | ADR-0050 Native operational metadata and scoped timelines |
| [0051](0051-captured-action-review-provenance.md) | ADR-0051 — Captured action review provenance |
| [0052](0052-native-qep-resend-control.md) | ADR-0052 Signed QEP resend controls |
| [0053](0053-explicit-publication-and-reusable-source-declarations.md) | ADR-0053 Explicit publication and reusable source declarations |
| [0054](0054-reviewed-qep-mail-carriage.md) | ADR-0054 Reviewed QEP email carriage |
| [0055](0055-native-host-and-version-support-boundaries.md) | ADR-0055 Native host and version support boundaries |
