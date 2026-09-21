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

### `ctx.sync` [P1]

账本同步（`src/quotagent/services/sync.py`）：三方协调 `base/mine/theirs` + 字段权威方矩阵（`03` §4）。

- 逐字段三值判定：`m==t` 确认、单侧改采纳、双改不一致为冲突；
- 冲突按 §4.3 矩阵裁决（单价归供应商、条款归承包商、澄清问题归提问方…），落 `sync/conflict` + `sync/merged`；
- **承诺字段冲突或矩阵未覆盖 → `pending_human` + 条目挂起**（`sync/suspended`），不自动合并；
- 人工裁决需**双方各自一次 `human:*` 批准**才成立（单边批准不算，代签被拒）；
- 对**非权威字段**的本地修改不外发，改为 `intent/suggestion`（数据主权，§4.3 规则）。

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
- P1 实现：`src/quotagent/services/clarify.py`（`ClarificationService`）——建单（缺版本或缺条目引用即拒，落 `clarification/rejected`）、作答（草稿先过 `clarification/answer-drafted` waterfall，含对方私域即被拦下，strict 模式直接短路）、广播（在册投标人集合决定完整性，缺任一即落 `clarification/broadcast-incomplete` 且 `close()` 拒绝）、版本重开（`on_package_rev` → 旧答案标 `stale`/`applies_to_rev`）。
- 回答者必须是 `human:*`（agent 代答被拒）：解答责任在人。
- 关联：FR-CLARIFY-001..005，AC-CLARIFY-001..003。

### `ctx.approval` [P0]
- 职责：人工门——请求、批准、拒绝、代签禁止、批准链存证。
- Definition：`request(scope, payload, approvers) -> id` · `decide(id, by, decision, comment)` · `chain(ref) -> approvals[]`。
- P0 实现：`src/quotagent/services/approval.py`（批准绑 scope+ref、只能由人产生、一次性）+ 承诺唯一出口 `src/quotagent/services/commitments.py`；语义见 ADR-0010。
- 不变量：承诺类动作在无批准记录时**不可执行**；批准记录不可由 agent 产生。
- P1（T-210）：`queue_view()` 给出人工门队列（动作 / payload 摘要 / 引用链 / Flag / 可选模型置信度 / 超时策略 / 已等待时长 / 是否过期）；`sweep()` 对**已过期**项执行其策略——`remind`（默认，仍待批并留痕）· `escalate`（转人类上级继续等待）· `abort`（作废本次意图，需重新发起）；
- **绝无「超时自动批准」**：策略取值只有上述三种，非法策略直接拒绝；超时动作永不落 `approval/granted`；待批**不阻塞**其他工作（只有需要该批准的动作会被 `require()` 挡下）。
- 关联：FR-APPROVE-001..004，AC-APPROVE-001/002。

### `ctx.guard` [P0]
- 职责：护栏——异常低价、漏项、产能冲突、条款冲突、外部诱导文本（prompt injection）。
- P1 扩展：条款冲突覆盖**付款/质保/罚则三族**（逐族列出 required vs offered）；产能风险有两条来源——① 声称产能超过可验证上限，② `ctx.capacity` 算出的日历/关键路径不可行结论（只转 Flag，不改交期）。
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
- P1（T-208）：包带**签名**（HMAC-SHA256 占位，ADR-0008）与**包含证明**（第三方只凭叶子+证明+根即可核对）；`manifest_hash` 绑定清单自身（改清单任意字段即失败）；独立验证入口 `tools/audit-verify.py`（只给包文件 + 验证方密钥，不接触原账本；`--require-signature` 对无签名包判失败）。
- 关联：FR-EVIDENCE-001..003、FR-EVIDENCE-005，AC-AUDIT-001/002/004。

## 3. 承包商侧

### `ctx.rfq` [P0]
- 职责：采购包与清单的版本管理、发布与修订、分发。
- Definition：`create_package(spec) -> id` · `add_items(items)` · `publish() -> rev` · `amend(changes) -> rev` · `distribute(participants) -> envelopes`。
- P0 实现：`src/quotagent/services/rfq.py`（rev 只增；`revision(rev)` 只读视图；`amend` 给字段级 delta）；语义见 ADR-0009。
- 不变量：已发布版本的字段不可原地修改；`amend` 必须给出字段级 delta；已发布包必须有 `quote_by` 截止时间。
- P1（T-215a）：`distribute(participants, rev)` 逐参与者留痕（`delivery_id`/`participant`/`rev`/`snapshot_hash`/`channel`/`sent_at`），版本以**快照哈希**锚定；`deliveries(rev, participant)` 回答「谁在何时收到哪个版本」（历史只增不清）；空名单/空标识/重复参与者/未发布版本一律拒绝。`deadline_status(now, soon_hours)` 给出各截止的剩余小时与临近/已过；`remind()` 按状态分流为 `rfq/due-soon` / `rfq/overdue`，**同一版本同一截止的同一状态只提醒一次**，且**绝不自动顺延截止**。
- 关联：FR-RFQ-001..006，AC-RFQ-001..003。

### `ctx.terms` [P1]
- 职责：合同条款库与冲突检测（付款、质保、罚则、验收标准）。
- Definition：`library(query)` · `conflicts(quote) -> Conflict[]` · `apply_defaults(package)`。
- 不变量：条款冲突只能标注并提请人工，不得静默取其一。
- P1（T-211）实现口径：条款族覆盖付款/质保/罚则/**验收标准**；`define/revise` **只追加版本**（旧版本保留，`as_of` 取当时生效版本），基线只允许 `human:*`/`bundle:*` 载入；`apply_defaults` **只补缺失键**且每条补入项标 `source=library-default`（不得冒充供应商承诺）；`conflicts()` 逐键并列 required/offered，`resolution` 恒为 `None`、不存在任何"胜出值"字段，并按 `mismatch`/`required_only`/`offered_only`/`unknown_key` 分类（未知键也提请人工）；`escalate()` 只把冲突送人工门。`ctx.guard` 的条款差异计算下沉到本服务（单一实现）。
- 关联：FR-TERMS-001..002。

### `ctx.change` [P1]

- 职责：变更闭环——变更请求的**引用校验**、差额重算、人工批准后生效。
- Definition：`propose(quote, deltas) -> change` · `recompute(change_id) -> delta` · `approve(change_id, approved_by)` · `effective_total(quote) -> amount`。
- 不变量：变更必须引用**原报价条目**与**单价基准**，引用不可验证（条目不存在、基准指向别的条目、基准值与本报价不符）即拒绝并留 `change/rejected`；差额按**原报价单价**逐行复算；**未经人工批准的变更不影响任何金额**（只出现在 `pending_changes`）。
- 实现：`src/quotagent/services/change.py`；事件 `change/proposed`（intent）· `change/priced` · `change/approved`（commitment：`delta_amount` + `approved_by`）· `change/rejected`（bail）。
- 字段口径：`basis_unit_price_refs` 恒为**逐行基准引用的列表**（单行也是单元素列表），`basis_unit_price_ref` 为其中首元素（兼容 `03` 报文表的单数字段名）。
- 关联：FR-CHANGE-001..002，AC-CHANGE-001/002。

### `ctx.quotes` [P1]

报价生命周期台账（`src/quotagent/services/quotes.py`）：包升版后把基于旧版本的报价标记为**过期**。

- 排序门仍由 `ctx.compare` 承担（`rfq_rev != package.rev` → 不进排序 + `rfq/version-mismatch`，P0）；
- 本模块补"升版那一刻"的显式标记：`stale` + `superseded_by_rev` + `quote/superseded` 留痕（标记不是删除，报价原样保留可审计）；
- 产生重报请求（含旧/新版本号与 `next_action`），供提示对方基于新版本重报；
- `compare.rank(..., book=...)` 会把过期报价以 `code=quote_superseded` **显式列在 excluded**，而不是"消失在排名里"。

### `ctx.compare` [P0]
- 职责：归一化报价 → TCO 折算 → 排序建议 → 引用链。
- Definition：`rank(package, quotes, weights) -> Evaluation` · `tco(quote) -> breakdown` · `cite(evaluation) -> ledger_refs[]`。
- 不变量：`Evaluation` 中每个数值必须有 `citations`；同输入同输出（可重放）；版本不一致的报价不得参与排序。
- P0 实现：`src/quotagent/services/compare.py`（五项金额化分量 + 极差归一评分 + `verify_citations` + `recompute`）；语义见 ADR-0011。
- P1（T-214）：`services/export.py` 生成可评审比较表——**逐行**（每个参与排序的报价一行；每个被排除的报价也一行，带 `code`/`reason`/`next_action`）；每行含 Flag、差异说明与引用链；`verify()` 与 `Evaluation` **及账本**（`compare/rank-computed`）逐行核对；导出确定性（同输入字节一致，无时间戳/自增）；CSV 带 BOM（Excel 可直接打开）。`compare/table-exported` 留痕。
- 关联：FR-COMPARE-001..006，AC-COMPARE-001..004。

### `ctx.award` [P0]
- 职责：授标意向→供应商确认→人工签署→承诺；PO 派生。
- Definition：`intent(package, quote) -> AwardIntent` · `withdraw(id)` · `commit(intent, approval_ref) -> AwardCommitment` · `issue_po(award) -> PO`。
- 不变量：`commit` 缺 `approval_ref` 或对方 `confirmed` 即抛错；PO 只能由 `AwardCommitment` 派生。
- P1（T-213）实现口径：意向 `intent()` **不产生义务**、可 `withdraw()`、撤回后可复（复得新意向，旧意向保持 withdrawn）；
  已撤回或已成承诺的意向不能再承诺（`intent-not-active`）；承诺记录**中标行快照**，PO 行来源链为
  ① 承诺行快照 → ② 本侧已提交报价的行 → ③ 无快照时仅核对引用形态，且**追溯模式写进 PO 记录**
  （`trace_mode=full|ref-only`，不静默降级）；`issue_po` **先判派生依据再判批准**（首条错误指向最可行动的下一步）；
  PO 行必须引用中标条目，有快照时单价必须与中标价一致（`po-line-not-derived` / `po-line-price-mismatch`）。
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

- **宿主强制不变量（H1/H2/H3/H5/H6）机检**（评审 C §4.2 / `ADR-0014 §7`）：入口 `tools/verify.sh invariants`（Python 侧 H1/H2/H3 + Node 侧 H5/H6）。每条都写成「正控 + 负控」，负控是把违规场景真跑出来断言检测器报红：
  · H1 账本唯一写入口：宿主直写一行 → 哈希链失败并冻结停发；桥只开 read/compute；
  · H2 事件声明表：未声明事件不可订阅/不可 emit；`emit` 派发 `bail` 事件被拒；
  · H3 承诺出口唯一化：三条承诺路径无批准即抛错、agent 代签被拒、批准不可跨 scope 复用；
  · H5 冻结面：`kernel.*` 伪造更新被拒（frozen）且配置摘要不变；**否决必须由宿主显式安装**（裸 context 上 `fiber.update` 不会自动被白名单拦下）；
  · H6 卸载残留：干净插件 dispose 后 effect=0 且资源计数差分全 0；泄漏定时器必须被检出。

## 8. 演化门（P1 骨架，评审 C §5.2/§5.3、`ADR-0014 §7` 第 7 条）

- 实现：`host/lib/evolution.mjs`（提案记录 / `PatchJournal` 归属 / `shadowMount` 影子挂载 / `gate` 五条 AND /
  `promote` / `rollback`）+ `host/evolution.mjs`（冒烟，含负控）+ `tools/evolve-record.py`（**Python 是唯一账本写入者**，H1）。
- 提案记录：`{id=内容哈希, target, diff, rationale, expected_effect{metric,direction,magnitude}, risks, rollback_plan,
  evidence_refs[]}`；指标来源只认白名单（**不接受模型自评**）、每个指标至少一条账本引用；
  `target` 落在 `kernel.*` 一律拒绝（INV-010）；同类提案连续失败 3 次 → host 强制转人工，不再自动重试。
- 归属：`journal.owner(key)` 可查（`proposal` / `file-or-human`）；提案**不得占用文件或人工 patch 的键**，
  回滚只撤自己拥有的键。
- 影子：`isolate('shadow:<proposal_id>')` 隔离 realm + **账本复制到新文件**（否则幂等去重会把重放变成重复投递）。
- 门：五条 AND（目标指标不退化、INV 全绿、反例集全绿、预算不越界、**人工介入率不上升**），逐条给理由，由 host 计算。
- 晋升：**P1 不允许自动晋升** —— `promote` 必带形如 `ap-0001` 的人工 `approval_ref`，且门必须已通过；否则拒绝。
- 回滚：`dispose()`（effect 逆序回收）+ journal 撤回，**不依赖人工删文件**。
- 事件：`evolve/proposed|shadowed|gated|promoted|rolled-back`（两侧已登记；由 Python 侧落账）。

## 9. 进树模块

### 9.3 `webui`（WebUI 插件，T-222）

每个**功能都由插件提供**（用户 2026-09-21）：UI 不是宿主内嵌代码，而是 `host/modules/webui.mjs`
——与 `kernel-bridge`/`norm`/`compare` 同形的 cordis 插件（`name/inject/provides/Config/apply`；
`inject` 里**不写** `events`：它是内建 mixin，写进去插件会永远停在 pending，实测）。

- 路由：`/quotagent/`（总览）、`/api/health`、`/api/status`（两侧账本各自计数 + 链自洽性，链校验由 Python 侧给出）、
  **双方视角各一个**：`/quotagent/contractor/` 与 `/quotagent/supplier/`（含各自 `/api/events`）。
- **结构性隔离**：每个视角只读**自己的**账本（`ledger_contractor`/`ledger_supplier`）；投影白名单（`VIEW_RULES`）是纵深防御；
  私域键在对方视角被抑制且**对外只说"含私域字段"**（键名仅留服务端 stderr —— 集成实测出的泄漏）。
- 健壮性：请求级兜底（单个坏数据记录不得杀死服务，实测过一次）；`ctx.effect()` 注册 HTTP 服务，dispose 即释放端口。
- 宿主**不写**账本（H1）。接入工作区 dashboard 见 `docs/work/deployment-manual.md`，机检 `tools/verify.sh webui`。
的 manifest 与 fixture（评审 C §6 / §7.1 第 5 条 / T-221）

- 进树模块（P1 树 = `kernel-bridge` + `norm` + 消费者 `compare`，见 `§7.1` 第 3 条）各有 manifest：
  `{name, inject, provides, Config, apply, disposer, usedServices, builtin}` 放在 `host/modules/*.mjs`。
- 每个模块必须通过六条 fixture（`host/check-modules.mjs`，由 `tools/check-modules.py` 驱动，
  入口 `tools/verify.sh modules`），**每条都带负控**：
  · A1 inject 白名单：取未声明的服务必须抛错；`usedServices` 必须等于 `inject`；
    **`inject` 里不得写 cordis 内建 mixin（`events`）**——写进去插件会永远停在 pending（实测）；
  · A2 零残留：dispose 后 effect 数为 0 且 timer/listener 计数差分全 0（泄漏必须被检出）；
  · A3 config 负控：未知键被拒、翻转 const 键被拒（`Config` 走 standard-schema，cordis 用 `~standard.validate`）；
  · A4 事件声明：**源码里 emit 的事件名必须都在事件表里**（真源在 Python 侧，由 `tools/export-events.py` 导出）；
    桥模块另有运行时负控（emit 未声明事件名被拒）；
  · A5 确定性：同输入两次派生输出字节一致（引入墙钟/自增序号即红）；
  · A6 无跨模块 import：只允许 `../lib/` 与包名，指向别的模块目录即红。
- 配置校验分两层：**模块形状**由本仓 `host/lib/std-schema.mjs`（standard-schema v1）管；
  **宿主白名单/冻结面**（`kernel.*`、`humanOnly`）由 `host/lib/frozen.mjs` + `host/lib/schema.mjs` 管（H5）。
