# ADR-0011 P0 的比价（TCO 与引用链）、护栏（只标注）、场景集与指标基线

Status: accepted

## Problem

S0.11–S0.14 把"比价 / 护栏 / 端到端 / 指标"落到代码，四件事设计文档只给了原则：

1. **TCO 怎么折**：五个分量（价格/交期/付款条件/质保/偏差）如何变成可比较的数字？权重从哪来？
   "同输入同输出"到什么粒度？
2. **"每个数值都有引用链"怎么强制**：引用长什么样、失败时如何定位、排序建议本身要不要引用？
3. **护栏与 Flag 的边界**：私域泄露属于哪一类 Flag（`02` §2.4 的枚举里没有，FR-GUARD-005 又要求检测）？
4. **重放确定性与反例集**：`09` §3.3 的反例"只增不减"与 `evolve/proposed` 事件在 P0 如何落地？
   指标基线如何避免与账本漂移？

按规则 8 与 12 §6（涉及协议/账本必须写 ADR），必须成文。

## Decision

1. **TCO 口径固定为金额化五项分量**（手算可复现，公式进 AC 注释）：
   `price` = 归一化后可比较金额；`delivery` = `max(0, 报价交期 - 包允许交期) × time_cost_per_day`；
   `payment` = `金额 × (1 - 预付比例) × 净账期 / 365 × capital_rate`；
   `warranty` = `max(0, 要求质保月 - 报价质保月) × warranty_cost_per_month`；
   `deviation` = Σ **已量化**偏差的价格影响（未量化不进 TCO，只在 `raw.quantified` 里可查）；
   `tco_total` = 五项之和。**排序分数** = `Σ w_i × minmax_i × 100`（分量在本次报价集上极差归一，
   全等记 0），越低越好，同分按 `quote_id` 定序；`weights`/`policy` 均来自策略 patch。
2. **`Evaluation` 是内容寻址的派生数据**：`evaluation_id = "eval:" + sha256(包/权重/策略/排名)[:12]`，
   不含墙钟时间与自增序号 → 同输入两次排序**字节级一致**（`09` §1 投影原则）；时间只存账本 `ts`。
   `recompute(evaluation, weights)` 用已存分量 + 新权重重算，策略 patch 效果可复现。
3. **引用链是硬约束**：排序行、每个分量都必须带非空 `citations`，前缀限定
   `ledger:`/`package:`/`quote:`/`policy:`/`deviation:`；`verify_citations()` 任一处缺失即
   `MissingCitation` 并给出**路径 + quote_id**；`rank()` 返回前自校验（不产出裸数字）。
4. **版本失配的报价不进排序**：`quote.rfq_rev != package.rev` → 进 `excluded[]`
   （`code=rfq_version_mismatch` + 双方版本 + `next_action`），落账 `rfq/version-mismatch`；
   其金额不得进入任何 TCO 分量（**不得静默比较**）。
5. **护栏只能标注**：`check(target, ruleset) -> Flag[]`，无 `reject`/`veto`；Flag 不改变排序、
   不改变状态、不阻断流程（否决权在人）。`kind` 枚举沿用 `02` §2.4 并**扩展 `private_leak`**
   （FR-GUARD-005：硬阻断在投影层 `PrivateLeak`，护栏这层只标注留痕）。规则可注册
   （`register_rule -> disposer`）；每条 Flag 落账 `compare/flag-raised`（Flag 从不由模型自行消解）；
   异常低价阈值（默认同包中位价 60%）由调用方声明，不硬编码在流程里。
6. **反例集只增不减由代码保证**：`remove`/`replace` 抛 `CounterexampleImmutable`，同 `case_id` 的
   `add` 也视为改写（`allow_rewrite=True` 也不放行）；新增落账 `evolve/proposed`（mode=serial）；
   数据随仓库入库 `docs/work/scenarios/s4-counterexamples.json`（合成数据）。
7. **场景集是"一条命令 + 确定性摘要"**：`qa suite s1|s2|s3|s4|s1..s4|all`；每个场景返回
   `steps/facts/assertions/digest`，`digest` 只覆盖确定性内容（**不含时间与时长**）。
   **场景必须跑在干净账本上**：账本对 `(correlation_id, type, body_hash)` 幂等去重，
   复用旧账本会把"重放"变成"重复投递"（零新增事件）——所以 CLI 每次新建并清理运行目录。
8. **指标只采集基线、不设目标值，且可一条命令重生成**：九项指标全部由账本事件推导，每项带
   `basis`（事件类型与计数）；账本里没有的量记 `None` 并注明落地任务，**不补零**。
   基线报告入库 `docs/work/metrics-baseline.md`，生成命令写进文件头（`qa metrics --out` 新子命令）。

## Consequences

**正向**

- 五项分量与分数都能手算复核；改权重不必重跑归一化（`recompute`）。
- Evaluation 内容寻址 + 无墙钟 → 重放可字节比对，`09` §3.2 的"行为断言"有了机检基础。
- 引用链可机检来源前缀、删一条即失败：让"每个数值有出处"从口号变成断言。
- 护栏（可调阈值、只标注）与人工门（绑 scope+ref、可否决）分工不越权。
- 反例"只增不减"是会抛异常的 API；S4 的四个反例都有账本留痕。
- 指标基线可重生成；缺失量显式 `None`，不让"没测"伪装成"测了"。

**负向**

- 极差分数依赖"本次报价集"：不能跨包比较分数（`tco_total` 才可比）。
- `payment` 用单一资金成本率近似，真实融资结构更复杂（P1 由条款库细化）。
- `private_leak` 的正文检测是表征匹配，会漏语义级泄露（P1 护栏扩展 T-206）。
- S4 的"虚假产能"是声明上限对照，不等于真实产能核验（现场验证 V 项负责）。
- 场景每次需新建/清理账本目录（秒级开销）。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 只按 `tco_total` 金额排序 | 交期/质保偏好是业务决策，必须可被策略 patch 调整（FR-COMPARE-002） |
| Evaluation 带自增 id 与创建时间 | 破坏字节级可重放（FR-COMPARE-002 / 09 §3.2） |
| 引用链写"见账本"自由文本 | 无法机检来源、无法定位缺失（AC-COMPARE-003 要求删一条即失败） |
| 失配报价按旧版本尽力比较 | 版本变了清单就可能变，排出来的序是错的；必须挂起要人决定 |
| 异常低价直接否决该报价 | `04` §4 明确护栏无否决权；异常低价也可能是真实的（清库） |
| 未量化偏差按 0 计入 TCO | 把"没量化"当成"没影响"，与 AC-DEV-001 冲突 |
| 反例集允许删除"过时用例" | 正是防"改测试提高通过率"的机制（`07` §4） |
| 指标缺失补零 | 掩盖未落地项；P0 明确记 `None` + 落地任务 |

## Revisit conditions

1. P1 由人把 `weights`/`policy` 默认值写成项目 patch（G1 门），并记入 `10-nonfunctional.md` 的预算节。
2. T-206/T-207 落地后护栏扩展（异常低价对历史基线、产能/条款冲突），阈值改为可声明规则集并在 Flag 里记来源。
3. T-209 落地后本批 P0 子集并入统一场景驱动，`digest` 与反例集路径保持不变。
4. 若"评分权重来自模型建议"，必须先过人批准（规则 3）并在此追加一节；
   Ed25519 落地（ADR-0008）后 `Evaluation` 外发需加签名，`ledger:` 前缀正好是承诺点。
