# ADR-0010 P0 的人工门与 realm 过滤落地语义

Status: accepted

## Problem

S0.9–S0.10 首次把"信任"落到代码：人工门、私域隔离、越界定价、偏差量化。设计文档给了原则
（`AGENTS.md` 规则 3、`08` §2/§3、INV-005/INV-008），但三件必须定死的事没有定义，而定错任何一件都会
让"可审计"变成口号：

1. **批准记录的形状与绑定**：批准绑 `scope` 还是绑具体业务对象？越界定价请求批准时，"有效"如何判定？
   `08` §2 明确"realm 是命名空间语义，不是安全边界"——那么真正的"私域不出 realm"靠什么机制保证？
2. **私域字段的分类与过滤点**：投影、模型输入、视图这三处各自丢掉什么？未分类字段默认怎么办？
   成本明细进模型是允许的（`08` §3：Private 可进本侧模型），但进不进**账本**？
3. **偏差与 TCO 的关系**：`02` §2.3 说"每条偏差必须标 `impact`"，AC-DEV-001 说"未标 `impact` 的偏差
   不参与 TCO"——未量化的偏差是丢弃、还是保留但排除？

按 `AGENTS.md` 规则 8（信任模型与账本格式变更必须新增 ADR），必须成文。

## Decision

1. **批准记录 = `{approval_id, scope, ref, payload, payload_hash, reason, approvers, requested_by,
   requested_at, status, decided_by, decided_at, comment}`**，并以 durable 事件
   `approval/requested|granted|denied` 落账。批准**同时绑定 `scope` 与业务引用 `ref`**：
   `require(scope, ref)` 只认"同一个 scope 且同一个 ref 且 status=granted"的记录；跨动作复用
   （例如拿报价批准去承诺授标）一律 `ApprovalRequired`（FR-APPROVE-002）。
2. **批准只能由人产生**：`decide(by=...)` 要求 `by` 以 `human:` 开头，否则 `AgentCannotApprove`
   （代签禁止）；服务**不提供**任何"自动批准/超时批准"入口（P8）；决定是一次性的
   （已处理的记录不可再次决定）。伪造的 `approval_id` 在 `require` 时即被拒。
3. **承诺的唯一出口**：提交报价 / 授标承诺 / 发 PO 三条路径都先过 `require(...)`，
   且**没有旁路参数**（`approval_id` 只是提前指定要用的记录，仍要过 scope+ref 校验）。
   授标承诺额外要求供应商确认；PO 只能由本侧已成立的 `AwardCommitment` 派生。
   定价结果另加一道门：引用未获人确认的 `PriceProposal` 提交报价 → `PriceNotConfirmed`（FR-PRICE-002）。
4. **realm 过滤是"投影规则"，按字段族分类**：`public / exchange / private-contractor /
   private-supplier / regulated` 由一张声明的字段表（`services/realm.py` 的 `DEFAULT_FIELD_CLASSES`）
   驱动，按最长前缀匹配。三条过滤点各自规则不同：
   - **对方视图 / 出站载荷**（`project` / `assert_clean`）：只保留 public/exchange，
     加上目标 realm 自己的私域与 regulated；出现私域/regulated → `PrivateLeak`（`08` §3 规则 2）；
   - **本侧模型输入**（`model_context`）：保留本侧私域（`08` §3：Private 可进本侧模型），
     丢掉对方私域与**全部 regulated**（审批记录、签名不进模型）；
   - **视图**（`RealmView.of`）：与对方视图同规则，供 UI/队列使用。
   **未分类字段不静默放行**：`project` 会把它记进 `unclassified_paths()`（默认按 exchange 处理，
   但审计能看到"存在未声明分类的字段"）。
5. **私域明细的落账方式**：成本构成按要素分解在**本 realm 的私域存储**（`PrivateStore`，文件 + 哈希引用），
   账本事件 `quote/cost-built` 只带 `artifact_hash` 与汇总金额——满足规则 2 / P4（"可由 durable 事件
   + 只读引用（附件哈希）覆盖"），同时保证证据切片外发时明细不出 realm。跨 realm 取件
   （`read_view` / `private_store.get`）一律 `PrivateAccessDenied`。
6. **越界定价无条件请求批准**：定价流水线（waterfall `quote/price-drafted`：成本基线 → 市场参考 →
   策略加价 → 风险准备金 → 授权区间检查）在末段判定"是否落在授权区间（单价）"；
   越界即创建 `quote.price-out-of-band` 批准请求、状态 `awaiting_approval`、`approval_id` 必填。
   区间内的定价不触发人工门（避免 R-003 的瓶颈化），但**最终数字仍必须人确认**才算落定：
   `confirm()` 只接受 `human:*`，落账 `quote/human-approved`（`final_price` 此前一直是 `None`）。
7. **偏差与 TCO**：偏差捕捉给 `kind ∈ {technical, commercial, schedule, scope}` 与引用；
   量化给 `impact = {price, time_days, risk}` 三维。**未标 `impact` 的偏差不参与 TCO**，
   但保留在偏差表里（`status="incomplete"`）并出现在 `tco_contribution().excluded` 中——
   即"不参与合计，但必须可查"。替代方案只作为 Intent 返回，不自动改变偏差或价格。

## Consequences

**正向**

- 批准的有效性可机检（scope+ref+status），跨动作复用与代签都被结构性拒绝；承诺路径没有旁路参数。
- 私域过滤点明确、方向明确：本侧能读自己的私域，对方读不到；模型只吃本侧私域与 exchange；
  regulated 永不进模型。未分类字段可审计。
- 成本明细的私域性与可重建性同时成立（哈希引用 + 私域存储）。
- "未量化偏差"这种半成品既不上账（不进 TCO），也不消失（可查），符合"不静默"的仓库基调。

**负向**

- 批准是"人工"动作，测试与演示需要显式扮演 `human:*`（P0 可接受；这也让门无法被脚本悄悄绕过）。
- 字段分类表需要维护：新增字段若忘登记会被记为 unclassified（噪音，但比漏泄露好）。
- `PrivateStore` 是文件实现，多进程下需外部同步（P1 relay/双侧进程时改为按 realm 分目录 + 锁）。
- 越界定价的人工门会成为流程瓶颈（R-003）：P0 只保证"不绕过"，队列与超时策略在 P1（T-210）。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 批准只绑 scope（不绑业务对象） | 一次批准会被同一 scope 的后续动作复用，等于批量授权（FR-APPROVE-002 明确禁止） |
| 允许 agent 以 `agent:*` 签名 + 事后人工复核 | 复核无法阻止既成事实；承诺已对外发出（规则 3 / INV-005） |
| 私域字段靠"提示词里写别泄露" | 数据仍在模型上下文里；必须在投影层就不出现（`08` §3 规则 3） |
| 成本明细直接进账本（本 realm） | 证据切片会外发给对方（P1 T-208），明细会随之泄露；用哈希引用更安全 |
| 未量化的偏差直接丢弃 | 违反"不静默丢弃"（同 AC-NORM-003 的对齐条目的处理），且丢失审计线索 |
| 越界定价先提交再由人工追认 | 报价一经提交即 Fact，撤回需要新版本，代价远高于事前请求批准 |

## Revisit conditions

1. P1 的双侧进程（T-201）落地后，`PrivateStore` 改为每 realm 独立目录 + 显式锁，并纳入 AGENTS 的
   "卸载后无残留"检查（T-104 的 effect 语义）。
2. 若人工门成为瓶颈（R-003 生效），引入队列 + 批量批准 + 阈值内自动——**阈值仍由人设定**，
   且"超时自动批准"永久排除。
3. 若引入新的数据类别（例如"仅在披露协议下可交换"），字段表与三个过滤点需同步扩展并新写 ADR。
4. 若 Ed25519 落地（ADR-0008 的 Revisit 1），`regulated` 字段的范围与签名验证路径需重新核对。
