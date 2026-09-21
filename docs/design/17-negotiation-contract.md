# T-254 接口契约提案：`ctx.negotiate`（下轮实现照此写）

- 对应需求：`FR-NEGO-001`、`FR-NEGO-002`（`docs/work/functional-requirements.md:132-133`）；验收标准 `AC-NEGO-001`（`docs/work/acceptance-criteria.md:87`，命令 `qa ac AC-NEGO-001`）。
- 设计依据：同目录 `t254-nego-design.md`（决策 D-N1..D-N5、机检点 15 条、P2 切片）。
- 契约强度：标注 **不可改** 的名字是既有对象/既有异常，改名即破坏别的 AC；其余为本提案新定，实现时可微调，但必须同步改回本文件（否则等于两处真源）。

## 1. 模块与类

| 项 | 值 | 说明 |
|---|---|---|
| 新模块 | `src/quotagent/services/negotiation.py` | 与 `pricing.py` / `quotes.py` 同级 |
| 服务类 | `NegotiationService`（`@dataclass`，风格对齐 `src/quotagent/services/pricing.py:38-49`） | 字段：`cost_service: CostModelService`、`pricing: Any`、`approval: Any`、`ledger: Ledger | None`、`events: EventBus | None`、`policy: dict`、`actor: str = "agent:negotiate"`、内部 `_threads`/`_rounds`/`_order`/`_counter`（`init=False`） |
| 纯函数（模块级，可单测、无副作用） | `derive_bounds(policy, cost_unit, *, item_id) -> dict`、`concession_delta(move, role) -> float`、`check_move(move, bounds, role) -> dict | None` | `check_move` 返回 `None` 表示通过，否则返回拒绝体（serial 链"首个非 `None` 即停"） |
| 装配 | `attach(ctx) -> None`、`attach_defaults() -> None` | 把 serial 链注册到 `negotiate/round`（对齐 `PricingService.attach/_register_stages`，`pricing.py:58-72`）；用错模式由内核拒绝 |
| 依赖（构造期必须给齐） | `approval` 为 `None` 时**直接拒绝**（不旁路） | 对齐 `pricing.py:224-225` 的"不允许旁路"写法 |

## 2. 数据结构（形状逐键列出，键名即契约）

### 2.1 Thread 视图（`open_thread` / `get_thread` 返回）

| 键 | 类型 | 说明 |
|---|---|---|
| `thread_id` | str | `nt-%04d`；由账本重建的计数器生成（对齐 `approval.py:93-94`） |
| `package_id`、`rfq_rev` | str、int | 包与包版本（版本绑定是硬要求，对齐 `quotes.py:50-51`） |
| `counterparty` | str | 对手方 `participant_id` |
| `role` | str | `supplier` / `contractor`（本侧视角，决定让步方向） |
| `quote_id` | str | 本侧报价（`QuoteBook` 里已登记的报价） |
| `proposal_id` | str | 已人确认的定价建议（`PricingService.is_confirmed` 必须为真） |
| `item_id` | str | 本轮谈判的条目 |
| `bounds` | dict | 见 2.3 |
| `bounds_hash` | str | `kernel.canon.digest(bounds)`，进账本，供复算锚定 |
| `status` | str | `open` / `closed` |
| `rounds_used`、`max_rounds` | int、int | 用量来自账本重建，不是进程内计数 |
| `created_at`、`closed_at`、`outcome` | str / None | `outcome ∈ {accepted, rejected, withdrawn, limit-reached}` |
| `refs` | dict | `{thread_id, package_id, quote_id, item_id}`（落 `ledger.append(..., refs=...)`） |

### 2.2 Round 视图（`submit_round` / `get_round` 返回）

| 键 | 类型 | 说明 |
|---|---|---|
| `round_id` | str | `"{thread_id}#{attempt_no:02d}"` |
| `round_key` | str | `"neg:" + digest({thread_id, attempt_no, move, bounds_hash})[:12]`（内容寻址，无时间戳 → 同输入同输出，做法同 `ADR-0011` §2 的 `evaluation_id`） |
| `thread_id`、`attempt_no` | str、int | 身份键 `(thread_id, attempt_no)`；`attempt_no` 含被拒尝试 |
| `move` | dict | 见 2.4 |
| `delta_pct` | float | 让步幅度（对己方不利方向的相对变化，≥0） |
| `requested_price` | float | `move["to"]` |
| `floor`、`ceiling`、`band` | float、float、dict | 该轮判定用的边界（数字同时进账本，供复算） |
| `in_band` | bool | `band` 内为真 |
| `status` | str | `conceded` / `awaiting_approval` / `rejected` / `aborted` |
| `approval_id`、`approval_scope`、`approval_ref` | str/None | scope 恒为 `negotiate.price-concession`，ref 恒为 `"{thread_id}:a{attempt_no}"` |
| `citations` | list[str] | 只用**既有前缀集合**（`ledger:` / `package:` / `quote:` / `policy:`，`ADR-0011` §3）；成本工件写成 `policy:cost_artifact_ref=<hash>`，**不新增前缀** |
| `code`、`reason`、`next_action` | str | 拒绝时给可行动结论（做法同 `quotes.py:81-83` 的 `code`+`next_action`） |
| `created_at` | str | 只进账本 `ts` 与视图，**不参与任何判定** |

### 2.3 `bounds` 形状

| 键 | 来源 | 说明 |
|---|---|---|
| `max_rounds` | `negotiate.max_rounds` | 轮次上限 |
| `max_concession_pct` | `negotiate.max_concession_pct` | 单次让步幅度上限（%） |
| `min_margin_pct` | `negotiate.min_margin_pct` | 底线余量（%） |
| `band` | `pricing.authorized_band` | `{min_unit_price, max_unit_price}`，既有键 |
| `cost_baseline`、`cost_artifact_ref` | `CostModelService.unit_cost(item_id)["excl_tax"]` 与成本工件哈希 | 私域明细不出 realm，只落基线 + 引用 |
| `policy_hash` | `digest(策略子树)` | 复算锚点 |
| `source` | `human:*` | 只能由人声明（`host/lib/frozen.mjs:55-58` 同口径） |
| `floor`、`ceiling` | 派生 | `floor = max(cost_baseline × (1 + min_margin_pct/100), band.min_unit_price)`；`ceiling = band.max_unit_price` |

### 2.4 `move` 形状

| 键 | 取值 | 说明 |
|---|---|---|
| `dimension` | 只接受 `"price"` | 其它值 → `UnsupportedMoveDimension`（数量走包升版、交期留待后续、条款归条款族） |
| `item_id` | str | 必须与 thread 的 `item_id` 一致 |
| `from`、`to` | float | 让步前后单价；`role=supplier` 时要求 `to < from`，`role=contractor` 时要求 `to > from` |
| `unit` | str | 计价单位（用于展示与对账） |

## 3. 方法签名与返回

```python
open_thread(*, package_id: str, rfq_rev: int, counterparty: str, role: str,
            quote_id: str, proposal_id: str, item_id: str,
            bounds: dict | None = None, declared_by: str = "human:") -> dict   # Thread 视图
declare_bounds(thread_id: str, bounds: dict, *, by: str, reason: str = "") -> dict   # 只追加，不改旧行
request_concession(thread_id: str, move: dict, *, reason: str = "",
                   timeout_policy: str = "remind", timeout_s: float = 3600.0,
                   escalate_to: str | None = None) -> dict   # 门请求（返回 approval 记录视图）
submit_round(thread_id: str, *, move: dict, rationale: str = "",
             approval_id: str | None = None) -> dict   # Round 视图
recompute(round_id: str) -> dict   # 纯复算，只用账本行内数字
rounds_used(thread_id: str) -> int
close(thread_id: str, *, outcome: str, by: str, comment: str = "") -> dict
get_thread(thread_id: str) -> dict
get_round(round_id: str) -> dict
threads() -> list[dict]
rounds(thread_id: str) -> list[dict]
replay() -> dict   # 从账本重建线程/轮次/计数器（对齐 approval.replay，approval.py:62-95）
```

行为约束（可静态或运行期机检）：

| 方法 | 必须做 | 必须不做 |
|---|---|---|
| `open_thread` | 校验 `rfq_rev` 为正整数、`proposal_id` 已人确认；落 `negotiate/bounds-declared` + `negotiate/opened`；`declared_by` 非 `human:*` 即拒 | 不落任何承诺类事实；不读墙钟判定 |
| `declare_bounds` | 只追加一条新的 `negotiate/bounds-declared`；`by` 必须 `human:*` | 不改旧行、不删旧行 |
| `request_concession` | 调 `approval.request(scope="negotiate.price-concession", ref="{thread_id}:a{attempt_no}", timeout_policy=...)`；非法策略由既有实现拒绝（`approval.py:104-108`） | 不传 `granted`；不做任何"预批准" |
| `submit_round` | 判定链：维度 → 轮次上限 → 幅度 → 底线 → 区间 → 门（`approval.require(scope=..., ref=...)`）；通过则落 `negotiate/round`（`event_class="intent"`） | 不在 `approval.require` 之外自行判断"批没批"；不把拒绝的轮落成 `negotiate/round` |
| `recompute` | 逐字节可复现；跨 realm 抛 `PrivateAccessDenied` | 不读私域明细、不读墙钟 |
| `close` | `outcome="accepted"` 时要求本线程引用的 `proposal_id` 仍处于已人确认态 | 不产生义务（无 `commitment` 事件、无 PO、无报价外发） |

## 4. 异常（不可改名者标 **不可改**）

| 异常 | 归属 | 触发 | `code` |
|---|---|---|---|
| `NegotiationError` | 本提案（基类，`RuntimeError` 子类） | — | — |
| `NegotiationPolicyMissing` | 本提案 | `negotiate.*` 键缺任一（**不兜默认值**） | `negotiation-policy-missing` |
| `ConcessionLimitExceeded` | 本提案 | `delta_pct > max_concession_pct` | `concession-over-limit` |
| `ConcessionBelowFloor` | 本提案 | `to < floor` | `concession-below-floor` |
| `ConcessionOutOfBand` | 本提案 | `to` 超出 `band` | `concession-out-of-band` |
| `RoundLimitExceeded` | 本提案 | `attempt_no > max_rounds` | `round-limit-exceeded` |
| `NegotiationRoundConflict` | 本提案 | 同 `(thread_id, attempt_no)` 内容不同 | `round-conflict` |
| `UnsupportedMoveDimension` | 本提案 | `dimension != "price"` | `unsupported-dimension` |
| `ThreadClosedError` | 本提案 | 对已关闭线程提交 | `thread-closed` |
| `UnknownThread` / `UnknownRound` | 本提案 | 不存在的 id（对齐 `UnknownApproval` 的写法） | `unknown-thread` / `unknown-round` |
| `ApprovalRequired` | **不可改**（`src/quotagent/services/approval.py:39-40`） | 价格让步缺有效批准 | — |
| `AgentCannotApprove` | **不可改**（`approval.py:35-36`） | 非 `human:*` 来源的批准/声明 | — |
| `PriceNotConfirmed` | **不可改**（`src/quotagent/services/pricing.py:34-35`） | `proposal_id` 未人确认 | — |
| `PrivateAccessDenied` | **不可改**（`src/quotagent/services/costmodel.py:36-37`） | 跨 realm 读成本 | — |
| `LedgerFrozenError` | **不可改**（`src/quotagent/kernel/ledger.py:39-40`） | 链校验失败后仍试图追加 | — |

错误消息里**不得**出现绝对时刻（D-042 纪律在断言层禁止“相对当下的绝对时刻”）。

## 5. 事件与门（落账契约）

| 事件 | `event_class` | `correlation_id` | body 关键键 |
|---|---|---|---|
| `negotiate/bounds-declared` | `fact` | `thread_id` | `thread_id, max_rounds, max_concession_pct, min_margin_pct, band, cost_baseline, cost_artifact_ref, policy_hash, source` |
| `negotiate/opened` | `fact` | `thread_id` | `thread_id, package_id, rfq_rev, counterparty, role, quote_id, proposal_id, item_id, bounds_hash` |
| `negotiate/round` | `intent` | `thread_id` | `thread_id, attempt_no, round_key, move, delta_pct, floor, ceiling, band, in_band, approval_id, status, citations` |
| `negotiate/round-rejected` | `fact` | `thread_id` | `thread_id, attempt_no, code, reason, next_action, move` |
| `negotiate/closed` | `fact` | `thread_id` | `thread_id, outcome, decided_by, rounds_used, round_keys[]` |

模式（与 `05-events.md` §3 逐条一致，两侧登记后由 `tools/check-events.py` 强制）：`bounds-declared`=emit、`opened`=emit、`round`=serial、`round-rejected`=bail、`closed`=emit；**没有任何 `waterfall`**（因此不需要 §5 拦截点登记）。

门（恰好一个新增 scope）：

| 项 | 值 |
|---|---|
| `scope` | `negotiate.price-concession`（不可跨动作/跨轮复用，`FR-APPROVE-002`） |
| `ref` | `"{thread_id}:a{attempt_no}"` |
| payload | `{thread_id, attempt_no, item_id, from, to, delta_pct, floor, ceiling, cost_artifact_ref, bounds_hash, citations}` |
| `timeout_policy` | 只能 `remind`（默认）/ `escalate`（`escalate_to` 必须 `human:*`）/ `abort`；**绝无自动批准** |
| `decision` | 只能由 `human:*` 调 `decide`（`approval.py:143-161`） |

## 6. 文件清单与工作量（Q8 的"会新增/修改哪些文件"）

| 文件 | 动作 | 内容 | 估算 |
|---|---|---|---|
| `src/quotagent/services/negotiation.py` | 新增 | 服务 + 3 个纯函数 + 5 个事件 | 约 240–280 行 |
| `src/quotagent/qa/checks_negotiation.py` | 新增 | `AC-NEGO-001` 注册，15 条断言 + 负控 | 约 160–200 行 |
| `src/quotagent/qa/__init__.py` | 修改 | 导入新 checks 模块（1 行；不加即"注册表里没有这条 AC"） | 1 行 |
| `src/quotagent/kernel/events.py` | 修改 | `DEFAULT_TABLE` +4 行（并把 `negotiate/round` 转正，模式保持 `serial`） | 5 行 |
| `docs/design/05-events.md` | 修改 | §3 +4 行；`negotiate/round` 说明列去掉"规划中" | 5 行 |
| `docs/design/02-domain-model.md` | 修改 | §4 命名表 +`negotiate/*` 一行（`05-events.md` §0 规则 5） | 2 行 |
| `docs/design/04-services-catalog.md` | 修改 | `ctx.negotiate` 补 P2 实现口径；§6 不变量表 +1 行 | 8–12 行 |
| `docs/design/15-requirements-coverage.md` | 修改 | 两行状态【缺口】→【映射】+ 真实承载体；§3 登记表删对应两行 | 4 行 |
| `docs/work/progress-checklist.md` | 修改 | T-309 状态更新 + 新增任务行（编号由父方分配） | 2 行 |
| `docs/work/evidence/EV-0xx-…txt` | 新增 | 门输出原始留痕（编号由父方分配，须先有文件再引用） | 1 个文件 |
| `host/lib/schema.mjs` | 修改 | +`negotiate.max_rounds`、`negotiate.max_concession_pct`、`negotiate.min_margin_pct`，全部 `humanOnly: true` | 3 行 |
| （可选）`host/modules/negotiation-view.mjs` | 新增 | 只读视图插件 → 必须同步 `docs/design/14-plugin-inventory.md` 与覆盖矩阵 §2，否则 `tools/verify.sh coverage` 变红 | 1 文件 + 2 行文档 |

合计：约 400–500 行新代码/断言 + 约 30 行文档与配置改动。按本仓既有批次粒度，估**一个实现轮次**（含门与证据），不超过两轮。

**不得修改**（硬）：`AGENTS.md`、任何已 accepted 的 ADR、`docs/work/acceptance-criteria.md` 的既有 AC 文本（`AC-NEGO-001` 已存在且命令已定，只注册不新增）、`docs/work/functional-requirements.md`（FR 原文不动）。

## 7. 不变量与禁止项（静态可检）

1. 服务不写文件、不联网、不读墙钟；只用 Python 3.9+ 标准库 + 既有服务。
2. 无 `commitment` 类事件；无 `approval.decide(` 调用；无 `commit`/`issue_po` 路径。
3. 无默认 bounds：三个 `negotiate.*` 键缺任一即拒。
4. 复算只用账本行内数字，返回值不含时间戳与自增号。
5. 轮次用量与计数器一律从账本重建（重启不重置）。
6. `correlation_id = thread_id`，一轮一件事：`-rejected` 与对应 `round` 不同 `type`（不会互相去重）。

## 8. 下轮唯一动作序列（实现顺序）

| 步 | 动作 | 完成判据 |
|---|---|---|
| 1 | 事件两侧登记（`05-events.md` §3 + `kernel/events.py`），`negotiate/round` 去掉"规划中" | `tools/verify.sh events` 绿 |
| 2 | 先写 `AC-NEGO-001` 的 15 条断言（RED），再写服务到 GREEN | `qa ac AC-NEGO-001` 绿，负控逐条变红 |
| 3 | host 键白名单 + 负控（`agent:` 改 `negotiate.*` 必须被拒） | 配置门绿且负控红 |
| 4 | 覆盖矩阵两行转正 + 服务目录/命名表漂移修正 | `tools/verify.sh coverage` 绿 |
| 5 | 进度清单与证据落 `docs/work/evidence/` | `tools/verify.sh docs` 绿 + EV 文件存在 |
| 6 | 可选：只读视图插件（同步插件清单与矩阵两处） | `tools/verify.sh plugins` 与 `coverage` 双绿 |
