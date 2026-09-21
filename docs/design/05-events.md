# 05 事件表

<!-- budget: 20 KB. 命名 `域/事件`；@mode 取自 Cordis 的五种分发语义 -->

## 0. 规则

1. **每个事件只有一个 @mode**，且只能用对应方法分发（照搬 Cordis `events.ts:14` 的约束）。
2. **durable 事件必须进账本**；live 事件只存在于进程内，不进账本（照搬 harness 的
   session event / live event 分野，见 `../analysis/harness-agent-repo-conventions.md` §2.6）。
3. **waterfall 监听者必须调 `next()` 委托**；不调用即短路，且该短路必须是文档化设计意图。
4. **模型可见 ⟺ 账本可重建**（P4）：任何影响模型输入的 live 事件，其输入必须已由
   durable 事件或只读引用（附件哈希）覆盖。
5. 新增事件类型 = 修改 `02-domain-model.md` §4 的命名表 + 本文件；若是协议事件，另加 ADR。

## 1. 分发模式的选用判据

| 想要的行为 | 模式 | 说明 |
|---|---|---|
| 通知、观察、留痕 | `emit` | 不阻塞，不看返回值 |
| 并发扇出（多方同时校验） | `parallel` | 全部跑完，有错则聚合抛错 |
| 有先后的链式决策 | `serial` | 遇 bail 值即停 |
| 首个有效决策胜出 | `bail` | 资格判定、快速否决 |
| 包装/改写/可拦截的流水线 | `waterfall` | 中间件；不调 `next()` 即短路 |

## 2. 内核事件（人类所有）

| 事件 | @mode | durable | 生产者 | 消费者 |
|---|---|---|---|---|
| `kernel/ledger-appended` | emit | – | `ctx.ledger` | 遥测、投影 |
| `kernel/model-call` | emit | ✔ | `ctx.model`（网关） | 审计、`ctx.evidence.rebuild` |
| `kernel/model-replied` | emit | ✔ | `ctx.model`（网关） | 审计、`ctx.eval` |
| `kernel/plugin-mounted` / `kernel/plugin-unmounted` | emit | live | `ctx.plugin` | 诊断、`ctx.plugins` |
| `kernel/config-updated` | waterfall | live | 自进化或人工配置更新 | 否决者（合规/安全） |
| `kernel/qep-rejected` | emit | durable | `ctx.qep` | 运维告警、审计 |
| `kernel/qep-sent` / `kernel/qep-received` | emit | ✔ | `ctx.qep` | 重发与出站链恢复（`03` §7）、审计 |
| `kernel/qep-duplicate-dropped` | emit | ✔ | `ctx.qep` | 幂等命中的可审计留痕（`03` §5） |
| `kernel/qep-gap-detected` | emit | ✔ | `ctx.qep` | `seq` 空洞：挂起依赖该序号的跃迁并发出重发请求（`03` §5） |
| `kernel/qep-gap-filled` | emit | ✔ | `ctx.qep` | 空洞补齐后按序应用（不跳号） |
| `kernel/qep-degraded` | emit | ✔ | `ctx.qep` | 特性级降级留痕（批准链/版本绑定/签名不可降级，ADR-0006 §4） |
| `kernel/qep-resent` | emit | ✔ | `ctx.qep` | 未收到回执或对端请求后重发同一 `msg_id`（内容不变） |
| `kernel/bridge-degraded` | emit | ✔ | `ctx.bridge` | 宿主与内核的观测（特性级降级必须留痕，ADR-0013 §2） |
| `kernel/bridge-rejected` | emit | ✔ | `ctx.bridge` | 承诺面调用/自我声明身份的拒绝留痕（ADR-0013 §3） |
| `kernel/bridge-backpressure` | emit | ✔ | `ctx.bridge` | live 通知被丢弃时的留痕（ADR-0013 §5） |
| `kernel/bridge-restarted` | emit | ✔ | `ctx.bridge` | 重启计数与锚点比对（ADR-0013 §6） |
| `kernel/bridge-fault` | emit | live | `ctx.bridge` | 桥的运行期故障（断连/洪水/超时） |
| `relay/received` | emit | ✔ | `ctx.relay` | 中转收到整包（**不解析 body**，只记 sha256） |
| `relay/queued` | emit | ✔ | `ctx.relay` | 目标不可达 → 排队等待重试（不丢包） |
| `relay/retry` | emit | ✔ | `ctx.relay` | 排队项的一次重试尝试 |
| `relay/delivered` | emit | ✔ | `ctx.relay` | 字节原样投递到目标收件箱 |
| `relay/tamper-detected` | emit | ✔ | `ctx.relay` | spool 字节与接收时哈希不一致 → 拒绝投递 |

## 3. 业务事件

| 事件 | @mode | durable | 生产者 → 消费者 | 备注 |
|---|---|---|---|---|
| `rfq/published` | emit | ✔ | `ctx.rfq` → intake, ledger | 版本发布的唯一入口 |
| `rfq/amended` | emit | ✔ | `ctx.rfq` → pricing, compare | 触发下游"基于过期版本"标记 |
| `rfq/distributed` | emit | ✔ | `ctx.rfq` → 对方 | 分发记录：谁在何时收到哪个版本（版本以快照哈希锚定） |
| `rfq/due-soon` | emit | ✔ | `ctx.rfq` → 人工门 | 临近截止提醒（同一截止同一状态只提醒一次） |
| `rfq/overdue` | emit | ✔ | `ctx.rfq` → 人工门 | 已过截止提醒（不自动顺延） |
| `rfq/version-mismatch` | bail | durable | `ctx.norm` → guard, approval | 首个失配即短路并挂起 |
| `clarification/asked` | emit | ✔ | `ctx.clarify` → 对方 | 工单建立 |
| `clarification/answer-drafted` | waterfall | live | agent → guard, 人工门 | guard 可拦截（如答案含对方私域信息） |
| `clarification/answered` | emit | ✔ | 人工定稿 → 广播 | 必须含完整广播名单 |
| `clarification/broadcast-incomplete` | bail | durable | `ctx.clarify` → approval | 缺名单即拒收（INV-006） |
| `clarification/rejected` | emit | ✔ | `ctx.clarify` | 建单/作答被拒留痕（缺版本或条目引用、草稿含私域） |
| `clarification/reopened` | emit | ✔ | `ctx.clarify` | 包升版后工单自动重开；旧答案标记为针对旧版本 |
| `quote/intake-completed` | emit | ✔ | `ctx.intake` → pricing | 抽条目结果入账 |
| `quote/normalize` | waterfall | live | `ctx.norm` | 归一化链：单位→币种→税→计量规则→条目对齐；任一环拒绝即短路 |
| `quote/normalized` | emit | ✔ | `ctx.norm` → compare | 归一化结果 + 拒绝理由 |
| `quote/normalize-rejected` | emit | ✔ | `ctx.norm` → approval, 审计 | 口径不可归一：拒绝理由 + 下一步动作（P6） |
| `quote/price-proposed` | emit | ✔ | `ctx.pricing` → approval | 定价建议（Intent） |
| `quote/price-drafted` | waterfall | live | `ctx.pricing` | 定价流水线：成本基线→市场参考→策略加价→风险准备金→授权区间检查 |
| `quote/cost-built` | emit | ✔ | `ctx.costmodel` | 成本构成建立（账本只带私域工件哈希，明细不出 realm） |
| `quote/deviation-captured` / `quote/deviation-quantified` | emit | ✔ | `ctx.deviation` | 偏差捕捉与影响量化（未标 impact 不进 TCO） |
| `approval/requested` | emit | ✔ | `ctx.approval` | 人工门：请求（带动作/摘要/引用链/Flag/超时策略） |
| `approval/granted` | emit | ✔ | `ctx.approval` | 人工门：批准（只能由人产生，绝无自动批准） |
| `approval/denied` | emit | ✔ | `ctx.approval` | 人工门：拒绝 |
| `approval/reminded` | emit | ✔ | `ctx.approval` | 超时策略 `remind`：仍等待人类决定（不改状态） |
| `approval/escalated` | emit | ✔ | `ctx.approval` | 超时策略 `escalate`：转上级继续等待 |
| `approval/aborted` | emit | ✔ | `ctx.approval` | 超时策略 `abort`：作废本次意图（需重新发起） |
| `quote/guard-check` | bail | durable | `ctx.guard` → approval | 异常低价/漏项/产能/条款/注入检测 |
| `terms/defined` | emit | ✔ | `ctx.terms` | 条款基线载入/修订（版本化，只追加） |
| `terms/applied` | emit | ✔ | `ctx.terms` | 默认条款补入缺失键（标 `library-default`） |
| `terms/conflict` | emit | ✔ | `ctx.terms` | 条款冲突标注（并列双方值 + 提请人工，绝不自动选值） |
| `quote/human-approved` | emit | ✔ | 人工 → qep | 批准记录（不可由 agent 产生） |
| `quote/submitted` | emit | ✔ | `ctx.qep` → compare | 报价事实（含 `rfq_rev`） |
| `quote/superseded` | emit | ✔ | `ctx.quotes` | 包升版后基于旧版本的报价标记过期并可重报（FR-RFQ-006） |
| `capacity/committed` | emit | ✔ | `ctx.capacity` | 交期/产能承诺建立与修订（含 binding 与 revision） |
| `capacity/firm-change-refused` | emit | ✔ | `ctx.capacity` | `firm` 交期在有效期内被模型改动 → 拒绝留痕 |
| `capacity/conflict` | emit | ✔ | `ctx.capacity` | 产能/交期不可行 → 只提请人工（不否决、不改交期） |
| `compare/rank-computed` | emit | ✔ | `ctx.compare` → 人/AwardAdvisor | 排序 + 引用链 |
| `compare/flag-raised` | emit | ✔ | `ctx.guard` | Flag 从不由模型自行消解 |
| `compare/table-exported` | emit | ✔ | `ctx.compare` → 评审 | 比较表导出留痕（行数/字节数/`evaluation_id`；导出内容与账本逐行一致） |
| `negotiate/round` | serial | ✔ | `ctx.negotiate` → approval | 轮次与让步上限来自策略 patch（规划中（P2 谈判阶段）） |
| `award/intent-proposed` | emit | ✔ | `ctx.award` → 对方 | Intent，可撤回 |
| `award/intent-withdrawn` | emit | ✔ | `ctx.award` | 意向撤回（可复：再次提出得新意向） |
| `award/commit-requested` | serial | live | `ctx.award` → 人工门 | 需 `approval/granted` 才能推进（名称与事件表一致：`award/committed` 与 `commit-requested` 成对） |
| `award/committed` | emit | ✔ | 人工签署 → po | 承诺，缺批准即抛错（INV-005） |
| `po/issued` | emit | ✔ | `ctx.award` → 履约 | 只能由 `AwardCommitment` 派生 |
| `change/proposed` | serial | ✔ | 双侧 → 结算 | 变更议题（`ref_quote_lines[]` + `delta` + `basis_unit_price_ref`） |
| `change/priced` | serial | ✔ | 双侧 → 结算 | 差额按**原报价单价**复算（`delta_amount` + 逐行明细） |
| ↳ 字段口径 | – | – | – | `basis_unit_price_refs` 恒为逐行基准引用**列表**（单行也是单元素），`basis_unit_price_ref` 为首元素；引用不可验证即 `change/rejected` |
| `change/approved` | serial | ✔ | 双侧 → 结算 | 人工批准后生效（commitment：`delta_amount` + `approved_by`） |
| `change/rejected` | bail | ✔ | 双侧 → 结算 | 缺引用或引用不可验证即拒绝（FR-CHANGE-001） |
| `acceptance/recorded` / `invoice/matched` | emit | ✔ | 履约 → 结算 | 三方核对留痕（规划中（P4 验收 / P5 结算阶段）） |
| `sync/merged` | emit | ✔ | `ctx.sync` | 三方协调的合并结果（一致确认 / 权威方胜出 / 人工裁决） |
| `sync/conflict` | emit | ✔ | `ctx.sync` | 冲突留痕（mine/theirs/base/authority/auto_resolution） |
| `sync/suspended` | emit | ✔ | `ctx.sync` | 承诺字段或矩阵未覆盖字段的冲突 → 条目挂起待人工 |
| `sync/suggestion-raised` | emit | ✔ | `ctx.sync` | 对非权威字段的本地修改转为建议（不外发，03 §4.3） |
| `evidence/pack-exported` | emit | ✔ | `ctx.evidence` | 审计包（含 Merkle 根） |
| `evidence/retention-archived` | `emit` | 到期归档动作落痕（T-252；判定器只管计划，落痕由执行方做） | 逐条取证；body 只出计数与哈希，**不得复活已销毁数据** |
| `evidence/retention-copy-purged` | `emit` | 派生副本销毁落痕（同上） | 同上；归档包一次成型，事后补写即自证篡改 |
| `evolve/proposed` | serial | ✔ | `ctx.evolve` | 自进化提案（P3 阶段）；族内后续名称见 `07`，**登记时必须在本表逐条声明**（事件门机检：事件表有而本表无即红） |
| `evolve/shadowed` | serial | ✔ | 影子 → 门 | 隔离 realm 挂提案后条目树（账本复制到新文件，含 `MetricDelta`） |
| `evolve/gated` | serial | ✔ | host gate runner | 五条门槛 AND 的裁决与逐条理由 |
| `evolve/promoted` | serial | ✔ | 人工签署 → journal | 晋升（**必带人工 `approval_ref`**，P1 不允许自动晋升） |
| `evolve/canary-entered` | serial | ✔ | 人工签署 → canary 路由 | 产物进入真实流量分流（**必带人工 `approval_ref`**：影响真实流量） |
| `evolve/canary-exited` | serial | ✔ | canary 路由 → journal | 退出 canary；**自动回滚不需要人工批准**（安全动作），带 `reason` 与 `samples_seen` |
| `evolve/rolled-back` | serial | ✔ | 门 → journal | 回滚：dispose 回收 effect + journal 只撤自己拥有的键 |

## 4. Agent 侧事件（live）

| 事件 | @mode | 说明 |
|---|---|---|
| `agent/step-start` / `agent/step-end` | emit | 观测用；与账本步骤对应 |
| `agent/tool-call-requested` | waterfall | 工具调用前置拦截：权限、私域泄露、承诺类动作一律在此拦 |
| `agent/output-drafted` | waterfall | 输出后置拦截：引用完整性（无引用数值即拒绝）、口径一致性 |
| `agent/escalate` | serial | 升级到人工（低置信、越界、冲突） |
| `agent/assumption-raised` | emit | 模型产出被标记为 `[假设]`，等待人工确认后升级为 Fact |

## 5. 拦截点总表（"在哪拦什么"）

| 拦截目标 | 事件 | 模式 | 拦截后动作 |
|---|---|---|---|
| 工具越权（读对方私域） | `agent/tool-call-requested` | waterfall | 拒绝 + 留痕 |
| 模型自行承诺 | `agent/tool-call-requested` | waterfall | 强制改走 `ctx.approval` |
| 无引用数值进入决策 | `agent/output-drafted` | waterfall | 拒绝输出，要求补引用 |
| 不可归一的口径 | `quote/normalize` | waterfall | 中断并产出拒绝理由 |
| 未广播的澄清答案 | `clarification/broadcast-incomplete` | bail | 拒收 |
| 澄清答案含对方私域信息 | `clarification/answer-drafted` | waterfall | 拦截该答案外发，保留原文供人审 |
| 越界定价（超授权区间） | `quote/price-drafted` | waterfall | 转人工门（不得直接产出可提交价格） |
| 内核配置被自改 | `kernel/config-updated` | waterfall | 无条件否决（INV-010） |
