# 04 服务目录（`ctx.*`）

<!-- budget: 26 KB. 每项必须给出三角与不变量；只有一个角色的不构成接缝 -->

## 0. 读法

每项格式：**职责 / Definition（关键方法） / 默认 Provider / Consumer / 数据边界 / 关联 FR**。
`不变量` 是可机检断言，不是愿望。P0 只实现标 `[P0]` 的项。

## 1. 内核（人类所有，不可自进化）

### `ctx.ledger` [P0]
- 职责：追加式事件序列 + 可重建投影；哈希链。
- Definition：`append(event) -> ref`（唯一写入口）· `read(filter) -> events` · `project(view, from?) -> state` · `verify_chain(from) -> bool`。
- Provider：`ledger.jsonl`（文件，默认）· `ledger.sqlite`（P2）。
- 文件格式、哈希公式与去重键：ADR-0007（字节级真源；改格式必须新写 ADR）。
- Consumer：几乎全部服务；投影供 agent 读取。
- 数据边界：**本 realm 事件全量**；跨 realm 只能读对方发来的报文。
- 不变量：`append` 后事件不可修改；`verify_chain()` 为真；同一 `(correlation_id,type,body_hash)` 不产生第二条事实。
- 关联：FR-LEDGER-001..004，AC-AUDIT-001。

### `ctx.events` [P0]
- 职责：五模式事件分发（`emit/parallel/serial/bail/waterfall`），注册即 effect。
- Definition：`on(name, listener, options) -> disposer` · `emit/parallel/serial/bail/waterfall(name, ...args)`。
- P0 实现：`src/quotagent/kernel/events.py`（声明表 + 五模式；waterfall 声明必须给出短路理由）。
- 不变量：监听器随卸载自动注销；waterfall 监听者不调 `next()` 即短路且必须显式记录为设计意图。
- 关联：FR-EVT-001。

### `ctx.plugin` [P0]

> P1 起，**组成/生命周期**由宿主层 cordis 承担（profile = 组成数据、配置更新走 `fiber.update` + 可否决的 `internal/update`）：见 ADR-0015 与 `host/README.md`。Python 侧仍持有账本与业务服务。
- 职责：插件装载、依赖（coeffect）协调、卸载回收；对应 Cordis 的 `registry+fiber+reflect` 语义。
- Definition：`mount(plugin, config) -> fiber` · `unmount(fiber)` · `update(fiber, config)` · `effects(fiber) -> EffectMeta[]`。
- P0 实现：`src/quotagent/kernel/plugin.py`（fiber 状态机 pending/active/inactive/disposed；ctx 内的注册自动登记为 effect）。
- 不变量：依赖未就绪不得激活；`unmount` 后 `effects()` 为空且无残留定时器/订阅/外部通知。
- 关联：FR-PLUGIN-001..003，AC-PLUGIN-001。

### `ctx.relay` [P1]

中转服务（`src/quotagent/services/relay.py`）：**只做 opaque 字节转发**，不解析 body。

- 有自己的 realm 与账本（`relay:r-1`），**不写任何参与者的账本**；
- 接收只记整包 `sha256` 与长度（`relay/received`，`parsed: false`），投递前重算哈希；
- 目标不可达 → 排队（`relay/queued`）→ `pump()` 重试（`relay/retry` → `relay/delivered`），不丢包；
- spool 被改 → `relay/tamper-detected` 并**拒绝投递**；语义篡改由接收方验签发现（AC-INTEG-002）。

### `ctx.qep` [P0]
- 职责：信封构造/校验/签名/验签、版本协商、幂等去重、重发。
- Definition：`envelope(type, class, body, refs) -> Envelope` · `validate(env) -> Result` · `send(env)` · `receive(raw) -> Event`。
- P0 实现：`src/quotagent/kernel/qep.py` + 文件投递 `src/quotagent/kernel/delivery.py`；签名与命名规则见 ADR-0008。
- 不变量：`class=commitment` 无 `approvals` 即拒收；`qep_version` 不兼容即拒绝（不静默降级）。
- 关联：FR-QEP-001..008，AC-QEP-001..004。

## 2. 共享能力

### `ctx.norm` [P0]
- 职责：口径归一化——单位、币种与汇率时点、含税/不含税、计量规则、条目对齐。
- Definition：`normalize(quote, package, ctx) -> Normalized|Rejection` · `diff(items_a, items_b) -> Alignment`。
- Provider：`norm.default`（内置换算表 + 显式规则）· `norm.industry-*`（行业模板）。
- P0 实现：`src/quotagent/services/norm.py`（`quote/normalize` 五段 waterfall）+ 口径数据 `src/quotagent/services/measures.py`；语义见 ADR-0009（容差来自 `MeasureRule.tolerance_bps`，随结果与账本事件留存）。
- Consumer：`ctx.compare`、`ctx.intake`。
- 数据边界：读取双方交换范围字段；**不得读取对方私域**。
- 不变量：**不可归一即拒绝**（拒绝理由进账本），不得猜测兜底（P6）。
- 关联：FR-NORM-001..005，AC-NORM-001/002。

### `ctx.clarify` [P0]
- 职责：澄清工单生命周期；答案广播完整性校验；FAQ 沉淀。
- Definition：`ask(ticket) -> id` · `answer(ticket, text, by)` · `broadcast(ticket) -> receipt` · `faq(query) -> entries`。
- 不变量：答案未广播给全部在册投标人不得关闭工单；`ticket.rfq_rev` 与包版本不一致时工单自动重开。
- 关联：FR-CLARIFY-001..005，AC-CLARIFY-001..003。

### `ctx.approval` [P0]
- 职责：人工门——请求、批准、拒绝、代签禁止、批准链存证。
- Definition：`request(scope, payload, approvers) -> id` · `decide(id, by, decision, comment)` · `chain(ref) -> approvals[]`。
- P0 实现：`src/quotagent/services/approval.py`（批准绑 scope+ref、只能由人产生、一次性）+ 承诺唯一出口 `src/quotagent/services/commitments.py`；语义见 ADR-0010。
- 不变量：承诺类动作在无批准记录时**不可执行**；批准记录不可由 agent 产生。
- 关联：FR-APPROVE-001..004，AC-APPROVE-001/002。

### `ctx.guard` [P0]
- 职责：护栏——异常低价、漏项、产能冲突、条款冲突、外部诱导文本（prompt injection）。
- Definition：`check(target, ruleset) -> Flag[]` · `register_rule(rule) -> disposer`。
- 不变量：`guard` 只能产出 Flag，**不得直接否决授标**（否决权在人）。
- P0 实现：`src/quotagent/services/guard.py`（六类规则 + `register_rule -> disposer` + 每条 Flag 落账；无否决接口）；语义见 ADR-0011。
- 关联：FR-GUARD-001..005，AC-GUARD-001..003。

### `ctx.negotiate` [P1]
- 职责：有限轮次谈判——让步策略、轮次上限、ZOPA 估计（输出为建议）。
- Definition：`open(thread) -> id` · `propose(thread, offer, rationale)` · `concede(policy)` · `close(thread, outcome)`。
- 不变量：轮次上限与让步幅度上限来自公司策略 patch；任何价格让步必须人工批准。
- 关联：FR-NEGO-001..003。

### `ctx.evidence` [P1]
- 职责：审计包导出——事件切片、Merkle 根、重建验证、留存策略。
- Definition：`export(scope, period) -> pack` · `verify(pack) -> bool` · `rebuild(inputs) -> inputs'`（P4 校验）。
- 不变量：`verify(pack)` 对任何被篡改事件返回假；`rebuild` 必须与观测输入逐条相等。
- 关联：FR-EVIDENCE-001..003，AC-AUDIT-001/002。

## 3. 承包商侧

### `ctx.rfq` [P0]
- 职责：采购包与清单的版本管理、发布与修订、分发。
- Definition：`create_package(spec) -> id` · `add_items(items)` · `publish() -> rev` · `amend(changes) -> rev` · `distribute(participants) -> envelopes`。
- P0 实现：`src/quotagent/services/rfq.py`（rev 只增；`revision(rev)` 只读视图；`amend` 给字段级 delta）；语义见 ADR-0009。
- 不变量：已发布版本的字段不可原地修改；`amend` 必须给出字段级 delta；已发布包必须有 `quote_by` 截止时间。
- 关联：FR-RFQ-001..006，AC-RFQ-001..003。

### `ctx.terms` [P1]
- 职责：合同条款库与冲突检测（付款、质保、罚则、验收标准）。
- Definition：`library(query)` · `conflicts(quote) -> Conflict[]` · `apply_defaults(package)`。
- 不变量：条款冲突只能标注并提请人工，不得静默取其一。
- 关联：FR-TERMS-001..002。

### `ctx.compare` [P0]
- 职责：归一化报价 → TCO 折算 → 排序建议 → 引用链。
- Definition：`rank(package, quotes, weights) -> Evaluation` · `tco(quote) -> breakdown` · `cite(evaluation) -> ledger_refs[]`。
- 不变量：`Evaluation` 中每个数值必须有 `citations`；同输入同输出（可重放）；版本不一致的报价不得参与排序。
- P0 实现：`src/quotagent/services/compare.py`（五项金额化分量 + 极差归一评分 + `verify_citations` + `recompute`）；语义见 ADR-0011。
- 关联：FR-COMPARE-001..006，AC-COMPARE-001..004。

### `ctx.award` [P0]
- 职责：授标意向→供应商确认→人工签署→承诺；PO 派生。
- Definition：`intent(package, quote) -> AwardIntent` · `withdraw(id)` · `commit(intent, approval_ref) -> AwardCommitment` · `issue_po(award) -> PO`。
- 不变量：`commit` 缺 `approval_ref` 或对方 `confirmed` 即抛错；PO 只能由 `AwardCommitment` 派生。
- 关联：FR-AWARD-001..004，AC-AWARD-001/002。

## 4. 供应商侧

### `ctx.intake` [P0]
- 职责：读包——清单条目与规格引用抽取、缺项检测、疑问清单生成。
- Definition：`ingest(package) -> items[]` · `missing(items, quote_draft) -> Missing[]` · `questions(package) -> Question[]`。
- P0 实现：`src/quotagent/services/intake.py`（逐条来源引用；无来源 → `[假设]`；疑问需人工确认后才外发）；语义见 ADR-0009。
- 不变量：抽取结果必须逐条引用 `item_id`；无引用的抽取项进入 `[假设]` 状态等待人工确认。
- 关联：FR-INTAKE-001..004，AC-INTAKE-001/002。

### `ctx.costmodel` [P0]
- 职责：成本构成（材料/人工/机具/管理/风险/税/财务），按条目。
- Definition：`build(items, library) -> CostModel` · `unit_cost(item, factors) -> amount` · `explain(ref) -> factors[]`。
- 数据边界：**私域，永不出 realm**；只可导出区间或系数（供应商自愿时由人工批准）。
- P0 实现：`src/quotagent/services/costmodel.py`（要素分解 + `explain`；明细在私域存储、账本只带哈希）+ realm 过滤 `src/quotagent/services/realm.py`；语义见 ADR-0010。
- 关联：FR-COST-001..003。

### `ctx.pricing` [P0]
- 职责：定价流水线（waterfall：成本基线 → 市场参考 → 策略加价 → 风险准备金 → 授权区间检查）。
- Definition：`price(quote_draft, policy) -> PriceProposal` · `deviate(policy)`（越界即请求批准）。
- P0 实现：`src/quotagent/services/pricing.py`（`quote/price-drafted` 五段 waterfall + 越界请求批准 + 人确认落定）；语义见 ADR-0010。
- 不变量：产出为 `PriceProposal`（Intent）；最终数字必须人来定；越界定价无条件请求批准。
- 关联：FR-PRICE-001..004，AC-PRICE-001。

### `ctx.capacity` [P1]
- 职责：产能日历与交期承诺校验（关键路径/资源冲突）。
- Definition：`check(commitment, calendar) -> Feasibility` · `reserve(slot) -> disposer`。
- 不变量：`binding=firm` 的交期在报价有效期内不得由模型变更；冲突只能提请人工（P2）。
- 关联：FR-CAP-001..002。

### `ctx.deviation` [P0 捕捉与量化 / P1 建议采纳]
- 职责：偏差与替代方案（技术/商务/进度/范围），影响量化。
- Definition：`capture(items, package) -> Deviation[]` · `impact(dev) -> {price,time,risk}` · `alternative(dev)`。
- P0 实现：`src/quotagent/services/deviation.py`（四类捕捉 + 三维量化 + `tco_contribution` 排除未量化项）；语义见 ADR-0010。
- 不变量：每条偏差必须标注 `impact` 与 `kind`；未标 `impact` 的偏差不参与 TCO。
- 关联：FR-DEV-001..002。

## 5. 自动化与自进化

### `ctx.eval` [P1]
- 职责：离线评测与影子重放——场景集、断言、指标、基线对比。
- Definition：`run(suite, profile) -> Report` · `replay(ledger_range, policy) -> Recomputed` · `diff(a,b) -> MetricDelta`。
- 不变量：评测只读账本；`replay` 必须确定性（同输入同输出），非确定性即失败。
- 关联：FR-EVAL-001..004，AC-EVAL-001/002。

### `ctx.evolve` [P2]
- 职责：自进化流水线——观察→提案→影子→评测门→canary→晋升/回滚。
- Definition：`observe(window) -> Signals` · `propose(signal) -> Proposal` · `shadow(proposal) -> Report` · `gate(report, thresholds) -> Verdict` · `promote(proposal, scope)` · `rollback(proposal)`。
- 不变量：提案不得修改内核与协议语义（P1/ADR-0002）；晋升必须留下 `evolve/promoted` 事件；回滚必须由 disposer 实现，不得靠人工删文件。
- 关联：FR-EVOLVE-001..006，AC-EVOLVE-001..003。

### `ctx.plugins`（自我检查）[P2]
- 职责：让 agent 检查/挂载/卸载自己的插件与配置层。
- Definition：`list()` · `effects()` · `config_of(entry_id)` · `patch(entry_id, changes)`（受权限与审批限制）。
- 不变量：对 `kernel` 命名空间的 `patch` 一律拒绝；每次自改必须附提案与提案 ID。
- 关联：FR-EVOLVE-004。

## 6. 不变量总表（可机检断言清单）

| ID | 断言 | 检查点 |
|---|---|---|
| INV-001 | 账本哈希链完整 | 每次 append 与每次启动 |
| INV-002 | 卸载后无残留 effect | AC-PLUGIN-001 |
| INV-003 | 报价 `rfq_rev` == 参与排序的包版本 | AC-COMPARE-001 |
| INV-004 | `Evaluation` 全部数值可引用 | AC-COMPARE-002 |
| INV-005 | Commitment 必有 `approvals` 且批准来自人 | AC-APPROVE-002 |
| INV-006 | 澄清答案广播覆盖全部在册投标人 | AC-CLARIFY-002 |
| INV-007 | 同输入重放结果一致 | AC-EVAL-001 |
| INV-008 | 私域服务在对方 realm 中取不到值 | AC-TRUST-001 |
| INV-009 | 归一化不可行即拒绝，无兜底 | AC-NORM-002 |
| INV-010 | 内核命名空间不可被 agent patch | AC-EVOLVE-003 |
