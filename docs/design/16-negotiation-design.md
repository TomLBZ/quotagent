# T-254 谈判设计决策记录：FR-NEGO-001 / FR-NEGO-002（只写 tmp/，本轮不写实现）

- 范围：`FR-NEGO-001`（有限轮次谈判：轮次上限与让步上限来自策略 patch，`docs/work/functional-requirements.md:101`）与 `FR-NEGO-002`（任何价格让步必须人工批准，同文件 `:102`）在覆盖矩阵里是【缺口】（`docs/design/15-requirements-coverage.md:68-69`）。
- 验收标准原文：`AC-NEGO-001`「轮次与让步上限生效；任何价格让步需要人工批准」（`docs/work/acceptance-criteria.md:87`），命令 `qa ac AC-NEGO-001`。
- 本文件只做决策与契约（接口契约见同目录 `t254-nego-contract.md`）；**未核实**的项在 §6 逐条列出，不当作事实。

## 0. 结论摘要（8 问各一句）

1. 一轮谈**价格（逐条目单价）**；轮次身份键是 `(thread_id, attempt_no)`，线程挂在既有对象上（`package_id + rfq_rev + 对手方 + 本侧 quote_id + 已人确认 proposal_id`），全部以 `correlation_id = thread_id` 串在同一条 `negotiate/*` 账本序列上。
2. 让步空间只来自**既有成本模型 + 既有策略键**：授权区间 `pricing.authorized_band.*`（`humanOnly`）与成本底线 `unit_cost(item_id)["excl_tax"] × (1 + min_margin_pct/100)`；三个上限键缺任一即拒、**不设默认值**；边界以 `negotiate/bounds-declared` 落账（带 `policy_hash` + `cost_artifact_ref`）后可复算。
3. 只有**一个新增人工门 scope**：`negotiate.price-concession`（`ref = "{thread_id}:a{attempt_no}"`）；终局确认复用既有 `PricingService.confirm`（`FR-PRICE-002`）；首次报价不新设门；越界/越限是**拒绝**不是过门；超时只 `remind/escalate/abort`，绝无自动批准。
4. 事件前缀用 `negotiate/*`（**否决 `nego/*`**）：4 个新名 `negotiate/bounds-declared`(emit)、`negotiate/opened`(emit)、`negotiate/round-rejected`(bail)、`negotiate/closed`(emit)，加既有 `negotiate/round`(serial，`docs/design/05-events.md:95`，不改名不改模式)；全仓无冲突。
5. 谈判**策略**可进自进化的可写面（host 插件，只产出建议）；**上限值、门的存在性、事件语义、对外承诺出口不得进可写面**（`ADR-0016` §1、`ADR-0012` §3、`INV-010`）。
6. 15 条机检点（每条含"会变红的反例"），覆盖让步越界、缺门、轮次上限、可复算、幂等、账本链。
7. P2 切片：本轮=设计+契约；下一轮=服务+AC+事件双向登记+覆盖矩阵转正+host 键白名单；必须等=跨方谈判报文（协议 ADR）、邮件绑定（`FR-INTEG-003`，T-301）、多租户（T-304）、交期维度（`FR-CAP-002` 的 `firm` 语义）、ZOPA 与上限具体数值（需人工基线）。
8. 接口契约见 `tmp/t254-nego-contract.md`（服务类名、方法签名、返回形状、异常名、文件清单与工作量）。

## 1. 证据（本轮实际读到的事实源）

| 事实 | 位置 |
|---|---|
| 需读两条 FR（could / must，均 P2） | `docs/work/functional-requirements.md:101-102` |
| AC-NEGO-001 的原文与命令 | `docs/work/acceptance-criteria.md:87` |
| `ctx.negotiate` 的职责与 Definition | `docs/design/04-services-catalog.md:101-105` |
| `negotiate/round` 已声明为 `serial` + durable，标"规划中" | `docs/design/05-events.md:95` |
| 人工门：`scope` 必填、超时三选一、绝无自动批准、`require()` 绑 scope+ref | `src/quotagent/services/approval.py:97-140`、`:199-243`（`granted_by_timeout: 0`）、`:270-284` |
| 门只能由人决定（`by` 必须 `human:` 前缀） | `src/quotagent/services/approval.py:143-161` |
| 门的超时策略常量 | `src/quotagent/services/approval.py:23-25` |
| 定价：授权区间越界**无条件**转人工门 | `src/quotagent/services/pricing.py:210-234` |
| 定价：最终数字必须由人确定 | `src/quotagent/services/pricing.py:140-160` |
| 成本底线来源（不含税单价） | `src/quotagent/services/costmodel.py:196-204`，被 `pricing.py:176-181` 取为 `cost_baseline` |
| 成本明细不出 realm / 不猜成本 | `src/quotagent/services/costmodel.py:122`、`:215-220` |
| 账本：append-only + 哈希链 + 同 `(correlation_id, type, body_hash)` 去重 | `src/quotagent/kernel/ledger.py:162-212`、`:170-172` |
| 报价台账（本侧报价对象） | `src/quotagent/services/quotes.py:32-59` |
| 四层 patch（策略参数落点） | `docs/design/01-architecture.md:81-91` |
| 可改性三档 + `humanOnly` 键（含 `pricing.authorized_band.*`） | `docs/design/adr/0015-host-profiles-and-config-veto.md:36-42`、`host/lib/schema.mjs:10-21` |
| 白名单外键拒绝 + `human-only` 否决实现 | `host/lib/frozen.mjs:37-64` |
| 策略参数「人设定基线，agent 只能在区间内提案」（含"让步上限"） | `docs/design/07-self-evolution.md:25` |
| 自进化可写面只有 `host/modules/`；内核**与服务层**不可自改 | `docs/design/adr/0016-self-evolution-artifact-surface.md:11-13` |
| cordis 管组合、Python 管事实（账本唯一写者） | `docs/design/adr/0012-direct-cordis-dependency-as-host.md:32-40` |
| 破坏性动作的默认值/门做法可借鉴（超时即继续留存、只 remind/escalate/abort） | `docs/design/adr/0018-retention-and-destruction-boundary.md:11-20` |
| 建议层边界（模型不进判定层） | `docs/work/decisions-archive.md:5-14`（D-018） |
| 「天花板由人定」的同类决策 | `docs/work/decisions.md:287-293`（D-047） |
| 门不得随墙上时间漂（时钟纪律） | `docs/work/decisions.md:218-220`（D-042） |
| 内容寻址 + 无时间戳 → 同输入字节一致 | `docs/design/adr/0011-p0-compare-guard-eval-semantics.md:26-31` |
| 事件门：文档 ↔ `kernel/events.py` 双向 + 模式一致 | `tools/check-events.py:80-90`；「规划中」放行见 `:25`、`docs/work/evidence/EV-052`、`EV-058` |
| 状态【缺口】【存疑】必须逐条登记 | `docs/design/15-requirements-coverage.md:147-157`；门 `tools/check-fr-coverage.py:105-115` |
| 跨方报文已有 `quote/revised`（追加新版本、旧版永久保留） | `docs/design/03-exchange-protocol.md:59` |
| 需求覆盖已机检（本轮起点） | `docs/work/evidence/EV-086` |

## 2. 决策（每条给 选定 / 被否决 / 代价）

### D-N1 谈判轮次的数据形状（Q1）

**选定**：一轮 = 对某采购包下**一个条目的一次价格让步提议**，外加理由与判定基准。

| 字段 | 形状 | 说明 |
|---|---|---|
| 线程 `thread_id` | `nt-%04d`（由账本重建的计数器生成，同形 `ap-####` / `pp-####`） | 对齐 `src/quotagent/services/approval.py:93-94` 的重建做法 |
| 线程绑定 | `package_id` + `rfq_rev` + `counterparty` + `role`(`supplier`/`contractor`) + 本侧 `quote_id` + 已人确认的 `proposal_id` + `item_id` | 全部是既有对象/字段，不新造业务实体 |
| 一轮身份键 | `(thread_id, attempt_no)`，`attempt_no` 从 1 单调递增（**含被拒的尝试**） | 回答"这一轮重提了吗" |
| 一轮内容 `move` | `{dimension: "price", item_id, from, to, unit}` | 本批只允许 `price` |
| 一轮判定基准 | `{cost_baseline, cost_artifact_ref, floor, ceiling, band, delta_pct, bounds_hash, policy_hash}` | 见 D-N2，全部可在账本内复算 |
| 一轮结果 `outcome` | `conceded` / `awaiting_approval` / `rejected` / `aborted` | 对应 §4 的事件 |

多轮串联：`negotiate/opened` 建线程 → 每轮一条 `negotiate/round`（serial 判定链）→ 越界/越限时一条 `negotiate/round-rejected` → `negotiate/closed` 收尾；全部 `correlation_id = thread_id`，`refs = {thread_id, package_id, quote_id, item_id}`。

**谈什么/不谈什么**（这是本决策的实质）：
- 谈：价格（逐条目单价）。理由：`FR-NEGO-002` 只约束价格让步；价格是唯一既有"数字 + 授权区间 + 成本底线"三件套齐备的维度（`pricing.py:210-234`）。
- 数量与范围**不在谈判面**：改数量即改清单，走 `FR-RFQ-003` 升版 + `FR-RFQ-006` 过期重报（`services/quotes.py:62-94`）。
- 交期本批**不谈**：`firm` 交期在有效期内不可由模型变更（`FR-CAP-002`），硬塞进谈判会造出第二套交期口径。
- 付款/质保等条款不当作"让步"：条款冲突只能标注并提请人工（`FR-TERMS-002`），不得静默取其一。

**被否决**：
- ① 用 `quote/revised` 直接当轮次载体：报价版本是**事实**，谈判轮是"意图 + 门"；混在一起会让未批准的价格顺着报价路径流出去。
- ② 新造一张"谈判表"（自有 JSON/内存持久化）：账本是唯一事实源（`FR-LEDGER-001`），第二份状态必然漂移（D-043 的"同形契约"教训同类）。
- ③ 轮次键用全局自增号：无法回答"同一轮是否重提"，幂等与冲突检查都落不了地。

**代价**：轮次表达力受限（只能表达价格让步）；`attempt_no` 把失败尝试也计入用量（见机检点 5 的取舍）；交期维度留待后续单独设计。

### D-N2 让步空间从哪来（Q2）

**选定**（全部来自既有对象或既有键，**不新增数字来源**）：

| 边界 | 来源 | 键 / API | 可改性 |
|---|---|---|---|
| 授权区间 | 既有策略键 | `pricing.authorized_band.{min_unit_price,max_unit_price}`（`pricing.py:211-215`） | `humanOnly`（`host/lib/schema.mjs:15`） |
| 成本底线 | 既有成本模型 | `CostModelService.unit_cost(item_id)["excl_tax"]`（`costmodel.py:196-204`） | 私域只读，不可改 |
| 底线余量 | 新键 | `negotiate.min_margin_pct` | `humanOnly`（07-self-evolution.md:25 的"人设定基线"） |
| 让步幅度上限 | 新键 | `negotiate.max_concession_pct` | `humanOnly` |
| 轮次上限 | 新键 | `negotiate.max_rounds` | `humanOnly` |

硬规则：
1. 三个 `negotiate.*` 键**缺任一即拒绝**（`NegotiationPolicyMissing`），**不设默认值**——对齐既有"不得猜测"纪律（`costmodel.py:122`、`FR-NORM-002`）。
2. `floor = cost_baseline × (1 + min_margin_pct/100)`；`ceiling = band.max_unit_price`；`floor` 与 `band.min_unit_price` 同时存在时取**更紧**的一侧（`max`），避免出现"区间允许但低于成本"的可提交价格。
3. 边界进账本：`negotiate/bounds-declared`（emit，durable）在开线程时落一条，body 带 `max_rounds`、`max_concession_pct`、`min_margin_pct`、`band`、`cost_baseline`、`cost_artifact_ref`、`policy_hash`（`kernel.canon.digest` 对策略子树求哈希）、`source`。人工改限时**只追加新行**（不改旧行），旧行永久保留。
4. 可复算：`recompute(round_id)` 只用该轮账本行里的数字 + `bounds_hash` 重算 `floor/ceiling/Δ%/是否越界`；返回值不含时间戳与自增号，两次调用逐字节一致（ADR-0011 §2 的"内容寻址 + 无时间戳"做法）。
5. 成本基线写进（realm 内的）账本**有既有先例**：`quote/price-proposed` 的 body 已带 `cost_baseline`（`pricing.py:126-128`）；跨 realm 读取仍被 `PrivateAccessDenied` 挡住（`costmodel.py:215-220`），不违反 `FR-COST-002`。

**被否决**：
- ① 用市场参考价（`policy.market_reference`）推让步空间：市场价不是承诺，拿它当底线等于**凭空生成数字**（`pricing.py:183-188` 明确它"不直接决定报价"）。
- ② 把成本明细（要素级）写进账本：违反 `FR-COST-002` / `INV-008`；只落 `cost_baseline` 与 `artifact_hash` 引用。
- ③ 缺键时给默认 `0.0`：默认值就是"凭空"，且会让"人未设定基线"变成静默放行。
- ④ 让模型给区间建议并直接采纳：模型只能在区间内提案（07-self-evolution.md:25），落定必须人签。

**代价**：谈判不能"开箱即用"——每个 realm 必须有人先把三个键写进 patch（这是刻意的）；上限值缺乏现场数据时只能先由人给一个基线值，本设计**不写死任何数值**。

### D-N3 人工门怎么绑（Q3，`FR-NEGO-002` 的核心）

**选定**：

| 动作 | 是否过门 | scope / ref | 复用对象 |
|---|---|---|---|
| 首次报价 | 不新设门 | — | 已在 `quote/price-drafted` 流水线内被 `authorized_band` 与人工确认覆盖（`pricing.py:210-234`、`FR-PRICE-001`） |
| **任何价格让步**（含区间内的） | **必经** | `scope="negotiate.price-concession"`，`ref="{thread_id}:a{attempt_no}"` | `ApprovalService.request/decide/require`（`approval.py:97-140`、`:270-284`） |
| 越界（超授权区间）/ 越限（超幅度、超轮次） | **拒绝**，不过门 | — | 服务直接抛错，落 `negotiate/round-rejected` |
| 终局确认（`outcome=accepted`） | 复用既有门 | — | `PricingService.confirm(proposal_id, by="human:*")`（`pricing.py:140-160`、`FR-PRICE-002`） |
| 对外承诺（授标/下单） | 仍只走既有出口 | — | `award/committed` 路径；谈判**不得**新增承诺出口（`FR-AWARD-002`、`INV-005`） |

口径细节：
- 门的 `timeout_policy` 只用 `remind`（默认）/`escalate`（`escalate_to` 必须 `human:*`）/`abort`，非法值由既有实现拒绝（`approval.py:104-108`）；**绝无自动批准**（`approval.py:7`、`:200`、`:241-243` 的 `granted_by_timeout: 0`）。
- 轮次在 `awaiting_approval` 期间**不推进**：不改价格、不落"已让步"事实；`remind` 只是提醒并留痕，`escalate` 转上级继续等，`abort` 把该轮标 `aborted`（需重新发起）。
- 门绑定不可复用：`submit_round` 必须走既有 `approval.require(scope=..., ref=...)`——批准绑 `scope`+`ref`，跨动作/跨轮复用即抛 `ApprovalRequired`（`FR-APPROVE-002`）。
- "越限/越界由人批准放行"**被否决**：人工门是必要条件，上限是硬约束；若门能批准越限，`FR-NEGO-001` 的"上限生效"就落空。放宽只能由人改 patch（`humanOnly`，`host/lib/frozen.mjs:55-58` 会拒绝 `agent:` 来源）。

**被否决**：
- ① 为谈判自造一套批准机制（旁路 `ctx.approval`）：承诺与门的出口必须唯一（`INV-005`、ADR-0010）。
- ② 本批把交期让步也纳入门：交期涉 `capacity` 的 `firm` 语义（`FR-CAP-002`），先做会造出第二套交期口径。
- ③ "门超时后按最保守让步自动推进"：等同超时自动批准，明令禁止（P8）。
- ④ 用 `guard` 代替门：护栏只产 Flag、不否决（`FR-GUARD-005`），不能承担"必须人批"。

**代价**：一次价格让步至少一次人工往返；谈判代理不能自主推进（设计意图），成本计入"人工介入率"；需要给人一个**待批让步**的视图（`FR-UX-001` 的队列视图已能承载，无需新门）。

### D-N4 事件命名（Q4）

**选定**：前缀 `negotiate/*`（**不是 `nego/*`**）。理由：`docs/design/05-events.md:95` 已登记 `negotiate/round`，`docs/design/04-services-catalog.md:101` 的服务名是 `ctx.negotiate`；同一域两个前缀=漂移，且 `tools/check-events.py` 会双向核对。

| 事件 | 模式 | durable | 生产者 → 消费者 | 一行说明 |
|---|---|---|---|---|
| `negotiate/bounds-declared` | emit | ✔ | `ctx.negotiate` → 人/审计 | 上限与成本底线的**快照**（数字 + `policy_hash` + `cost_artifact_ref`）；开线程与每次人工改限各落一条 |
| `negotiate/opened` | emit | ✔ | `ctx.negotiate` → approval, quotes | 线程建立，绑定包版本、对手方与本侧已人确认的定价建议 |
| `negotiate/round` | serial | ✔ | `ctx.negotiate` → approval | **既有名，不改名不改模式**：一轮的判定链（上限→底线→区间→门），首个非 `None` 即停 |
| `negotiate/round-rejected` | bail | ✔ | `ctx.negotiate` → approval, 审计 | 越限/越界/缺门/维度不支持 → 拒绝留痕（带 `code` 与 `next_action`） |
| `negotiate/closed` | emit | ✔ | `ctx.negotiate` → 双方视图 | 线程关闭（accepted/rejected/withdrawn/limit-reached）；**无义务**，承诺仍只走授标路径 |

逐个核对结果（全仓扫描 `nego/` 与 `negotiate/` 两种前缀的**所有**匹配）：
- 唯一命中是 `negotiate/round`：`docs/design/05-events.md:95`、`docs/work/evidence/EV-052`、`docs/work/evidence/EV-058`（后两处是"规划中，允许未登记"的机检输出）。
- `src/quotagent/kernel/events.py` 的默认事件表里**没有任何** `negotiate/*` 或 `nego/*`（`negotiate/round` 因此仍处"规划中"放行态）。
- 4 个新名在文档、Python、mjs 三类文件里**均无同名**；与既有 `approval/*`、`quote/*`、`award/*`、`change/*` 家族不冲突。
- 无 `waterfall` 事件 → 不需要在 `05-events.md` §5 拦截点总表登记（`AC-EVT-002` 只强制 waterfall）。
- 下一轮必须**两侧同时登记**（`tools/check-events.py:80-90`），并在同一提交里去掉了 `negotiate/round` 的"规划中"标注；同时按 `05-events.md` §0 规则 5 补 `docs/design/02-domain-model.md` §4 的命名表。

**被否决**：
- ① `nego/*` 前缀：与已登记的 `negotiate/round` 分裂，等于把"一处一事实"拆成两处。
- ② `negotiate/concession-requested` + `negotiate/concession-approved`：与 `approval/requested|granted` 重复；门的留痕必须只有一处出处。
- ③ `negotiate/counter-offer`（对手方反报价）：会暗示新增报文类型 → 触发协议变更（AGENTS.md 规则 8 要求新 ADR）。改用既有 `quote/revised`（`03-exchange-protocol.md:59`）把对方新价当一次报价修订登记，协议零改动。
- ④ 把 `negotiate/round` 改成 `waterfall`：模式是已声明的语义，改即改历史（`07-self-evolution.md` §1 第 2 条），需 ADR；serial 的"首个非 None 即停"正好表达判定链。

**代价**：多了一个"边界快照"事件（账本行数上升，换可复算与可审计）；serial 链上每个监听者都必须遵守"返回非 `None` 即停"，写错会静默短路（靠机检点 15 兜底）。

### D-N5 与 canary/演化层的关系（Q5）

**选定**：

| 面 | 能否进自进化可写面 | 依据 |
|---|---|---|
| 谈判**策略**（先让哪个条目、让步节奏、理由文本） | 能（host 插件/中间件，**只产建议**，不改数字） | `ADR-0012` §3（cordis 管组合）；`ADR-0016` §1 可写面 = `host/modules/` |
| 谈判轮次的**只读视图** | 能（host 插件，只数不出正文） | 既有 `ops-view` / `approval-digest` 同类做法 |
| 上限值（`negotiate.*` / `pricing.authorized_band.*`） | **不能** | `ADR-0015` §3、`host/lib/frozen.mjs:55-58`；07-self-evolution.md:25"人设定基线" |
| 门的存在性与"价格让步必经门" | **不能** | `07-self-evolution.md` §1 红线第 4 条；`INV-010` |
| 事件名与字段语义（`negotiate/*`） | **不能** | `07-self-evolution.md` §1 第 2 条（改语义即改历史） |
| Python 侧谈判服务 | **不能** | `ADR-0016` §1：内核**与服务层**仍不可自改 |
| 模型做让步判定 | **不能** | D-018（建议层不进判定层） |

机检要求（写进种子门）：
- 演化提案 `target` 命中 `negotiate.*` → 门拒（`human-only` 负控），并要求"命中 humanOnly 键的提案必须由人签"。
- host 插件不得调用 `ctx.approval.decide`：`by` 非 `human:*` 即 `AgentCannotApprove`（`approval.py:147-150`）。
- 插件判定必须是纯函数、**不读墙钟**（D-042 纪律：门不得随墙上时间漂）。

**被否决**：① 让自进化产出 Python 侧谈判服务（服务层不在可写面）；② 允许插件直接写账本（账本唯一写者是内核，`ADR-0012` §3）；③ 把"让步建议"直接当判定输入（D-018）。

**代价**：谈判的"聪明"部分只能以建议形态存在，效率提升受限；插件与 Python 侧要经桥（`FR-INTEG-004`）多一跳，观测与排障成本上升。

## 3. 机检点（Q6，15 条，每条含"会变红的反例"）

| # | 断言（可写成 `AC-NEGO-001` 的 `Assertion`） | 会变红的反例（负控） |
|---|---|---|
| 1 | 低于成本底线的让步被拒：`to < floor` → `ConcessionBelowFloor`，账本无 `negotiate/round`（只有 `negotiate/round-rejected`） | 注掉 `floor` 校验 → 同一 `to` 被接受，断言变红 |
| 2 | 超幅度上限被拒：`delta_pct > max_concession_pct` → `ConcessionLimitExceeded` | 把 `max_concession_pct` 从 5 改成 50（或跳过检查）→ 变红 |
| 3 | 超出授权区间的让步被拒：`to > band.max_unit_price` → `ConcessionOutOfBand` | 让区间检查只看 `min` 不看 `max` → 变红 |
| 4 | 缺人工门被拒：未带有效 `approval_id` 的让步 → `ApprovalRequired`（复用既有类） | 让 `require()` 在找不到记录时返回 `None` 而不抛错 → 变红 |
| 5 | 轮次上限生效：第 `max_rounds + 1` 次提交 → `RoundLimitExceeded`，`attempt_no` 不写进 `negotiate/round` | 把用量改成"只算成功轮"（失败尝试不计）→ 变红 |
| 6 | 轮次用量**从账本重建**（重启不重置）：用同一 `ledger.jsonl` 新建服务 → `rounds_used` 与重启前一致，第 N+1 次仍被拒 | 删掉构造期重放 → 计数器归零，断言变红 |
| 7 | 可复算（同输入同输出）：`recompute(round_id)` 两次调用**逐字节一致**，`round_key` 相同 | 把 `utc_now()` 或自增号塞进返回值 → 字节不一致，变红 |
| 8 | 幂等（同一轮重复提交）：同 `(thread_id, attempt_no)` + 同 body 二次提交 → 账本去重命中（`duplicate=True`），行数不变，返回同一 `round_key` | 在 body 里加一个自增/时间字段 → 行数 +1，变红 |
| 9 | 同一轮号**不同内容** → 显式冲突 `NegotiationRoundConflict`（不静默追加第二条事实） | 去掉冲突检查 → 账本出现两条同 `(thread_id, attempt_no)` 的行，变红 |
| 10 | 账本链仍真：`verify_chain()` 为真，`project("types")` 里 `negotiate/*` 计数 == 实际行数 | 手改一行 body → `verify_report()["ok"]=False`、`frozen=True`、追加抛 `LedgerFrozenError`（断言"链仍真"变红） |
| 11 | 私域不出 realm：在对方 realm 的实例上 `recompute` 抛 `PrivateAccessDenied` | 注掉 realm 检查 → 变红 |
| 12 | 缺策略键即拒（**不凭空生成数字**）：policy 少 `negotiate.max_concession_pct` → `NegotiationPolicyMissing` | 给该键一个默认 `0.0` → 断言"缺键必须拒"变红 |
| 13 | 不新增承诺出口：新事件全部 `event_class != "commitment"`，且服务源码不含 `decide(` 调用 | 把 `closed` 的 `accepted` 落成 commitment → 变红 |
| 14 | 不读墙钟：两次 `submit_round` 在无时刻注入下结果一致；门的超时只在显式 `sweep()` 时刻生效 | 让服务内部调 `utc_now()` 参与判定（跨秒即不同）→ 变红 |
| 15 | 事件名双向登记：`tools/verify.sh events` 全绿（4 新名两侧同名同模式，`negotiate/round` 去掉"规划中"后仍一致） | 只改 `05-events.md` 不加 `kernel/events.py` 的 `DEFAULT_TABLE` → 门红 |

覆盖要求核对：让步越界（1、2、3）、缺人工门（4）、轮次上限（5、6）、可复算（7）、幂等（8、9）、账本链仍真（10）均已覆盖；另加私域（11）、无默认值（12）、无新承诺出口（13）、无墙钟（14）、事件登记（15）。

## 4. P2 切片（Q7）

| 切片 | 内容 | 判定 |
|---|---|---|
| 本轮（已完成） | 决策 + 接口契约（本文件与 `t254-nego-contract.md`），不写实现 | 就是本批次 |
| 下一轮**可做** | 服务 + 纯函数；`AC-NEGO-001` 注册（15 条断言）；4 事件两侧登记 + `negotiate/round` 转正；覆盖矩阵两行从【缺口】转【映射】；host 键白名单 + 负控；证据落 `docs/work/evidence/` | 依赖已就绪（成本模型、门、账本、报价台账全在） |
| 必须等 | ① 真正的**跨方**谈判（对手方在另一进程接招）：需新增协议报文类型 → 协议 ADR（AGENTS.md 规则 8）；本设计先用 `quote/revised` 规避。② 邮件绑定（`FR-INTEG-003`，T-301）。③ 多租户（T-304，`ADR-0015` §Revisit 4）。④ 交期维度让步（要先解 `FR-CAP-002` 的 `firm` 语义与 `FR-CAP-001` 产能日历）。⑤ ZOPA 估计与"让步节奏建议"（需历史价格基线，与 `V-009` 同类）。⑥ 上限的**具体数值**（必须由人设定基线，本设计不写默认值）。⑦ 自进化产出的谈判策略插件（要先有 `humanOnly` 负控）。 |

## 5. 已知漂移与未核实（不当作事实）

| 项 | 状态 |
|---|---|
| `docs/design/04-services-catalog.md:105` 引用的一条款号在 FR 文档里**没有定义行**（FR 文档只有 001/002 两条 NEGO） | 漂移，下一轮随服务目录更新一并修正（只改服务目录文字，不动 AC） |
| `docs/design/04-services-catalog.md:101` 标 `ctx.negotiate [P1]`，而 FR 表标 **P2**（`functional-requirements.md:101-102`） | 漂移，以 FR 文档为准（P2） |
| `docs/design/02-domain-model.md` §4 命名表**没有** `negotiate/*` 行 | 缺口，下一轮补（05-events.md §0 规则 5） |
| 真实商务中的谈判轮次/让步幅度经验值 | **未核实**（无现场数据）→ 因此不设默认值 |
| `03-exchange-protocol.md` 是否有过"谈判报文"的历史讨论 | **未核实**（本轮按 `negotiate`、`nego`、`谈判`、`counter-offer` 检索无命中） |
| 对手方（另一 realm）是否会接受"以报价修订表达反报价"的实务做法 | **未核实**（取决于对方系统，P2 接入时再定） |
