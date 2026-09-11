# 01 架构

<!-- budget: 28 KB -->

## 1. 全景

```
                        ┌───────────────── 承包商侧运行时 (realm: contractor:*) ─────────────────┐
                        │  ctx.rfq     采购包/清单/RFQ 版本与分发                              │
                        │  ctx.compare 归一化→TCO 比价→风险标注→排序建议                       │
                        │  ctx.award   授标意向→(人工批)→授标确认                             │
                        │  ctx.terms   条款库、付款/质保/罚则                                  │
                        │  私域: 标底、内部评分、成本基准                                        │
                        └───────────────┬──────────────────────────────────────────────────────┘
                                        │  QEP 报文（签名、版本化、传输无关）
                        ┌───────────────┴──────────────────────────────────────────────────────┐
                        │  relay（可选，只转发与存证，不解密私域；可退化为共享目录/邮件）          │
                        └───────────────┬──────────────────────────────────────────────────────┘
                        ┌───────────────┴─────── 供应商侧运行时 (realm: supplier:*) ────────────┐
                        │  ctx.intake   读包：条目/规格/接口抽取，缺项与疑问清单                  │
                        │  ctx.costmodel 成本构成（私域，永不出 realm）                          │
                        │  ctx.pricing  定价策略与利润（人工批最终数字）                          │
                        │  ctx.capacity 产能日历与交期承诺校验                                   │
                        │  ctx.deviation 偏差表与替代方案                                        │
                        └──────────────────────────────────────────────────────────────────────┘

  双侧共享语义（各自本地实现，协议保证等价）:
  ctx.ledger 账本 · ctx.events 事件 · ctx.norm 归一化 · ctx.clarify 澄清 · ctx.negotiate 谈判
  ctx.approval 人工门 · ctx.guard 护栏 · ctx.evidence 证据 · ctx.qep 协议 · ctx.eval 评测 · ctx.evolve 进化
```

**关键结构决定**：不存在"中心服务端权威数据库"。双方各自持有账本，协议负责让两份账本收敛到
同一共识（ADR-0003），私域数据不出本侧（P5）。

## 2. L0 内核（四个能力，人类所有）

| 能力 | 职责 | 不变量 |
|---|---|---|
| `ctx.ledger` | 追加式事件序列 + 可重建投影 | 事件一旦追加不可修改；投影可由事件全量重建（P4） |
| `ctx.events` | 五模式分发：`emit/parallel/serial/bail/waterfall` | 监听器注册即 effect，卸载自动注销（P3） |
| `ctx.plugin` | 插件的装载/依赖协调/卸载（Cordis 语义） | 依赖未就绪不得激活；卸载后无残留副作用 |
| `ctx.qep` | 信封校验、版本协商、幂等去重 | 版本不兼容即拒绝，绝不静默降级（P7、`03` §6） |

内核的**不可变性**由三条机制保障：
1. 内核代码不在自进化可写范围内（`07` §2 的可写面清单）；
2. 内核事件类型（`kernel/*`）的增删改必须走 ADR；
3. 内核变更必须过全量 AC 套件 + 账本重放一致性检查。

## 3. L1 能力接缝（Cordis 优势 2/4/5 的落地）

每项能力按三角实现，缺一不可（来源：harness 的 capability seam 规范，
见 `../analysis/harness-agent-repo-conventions.md` §2.5）：

- **Definition**：接口与不变量（`04-services-catalog.md` 的每个 `ctx.*` 条目）；
- **Provider**：默认实现（如 `norm.default`、`pricing.costplus`），可被替换；
- **Consumer**：使用者的门面，通常是模型可见工具或事件监听者。

替换一个 Provider 就能整体改变行为，例如把 `pricing` 的默认实现换成投标策略实现、
把 `norm` 的单位换算表换成某行业计量规则库，而不触碰其他任何模块。

## 4. 依赖与激活（reactive coeffects 的落地）

报价链路的前置条件被声明为依赖（`docs/analysis/cordis-design-strengths.md` 优势 2）：

```
ctx.pricing  ← inject: rfq, norm, costmodel, capacity, approval, fx(汇率)
ctx.compare  ← inject: norm, terms, guard, ledger
ctx.award    ← inject: compare, approval, ledger, qep
```

语义（照搬 Cordis 的 epoch 机制，见 `../analysis/cordis-architecture.md` §2.3）：

1. `rfq` 的当前版本被撤销/升版 → 依赖它的 `pricing` 失活并重载 → 未提交的报价被标记为
   "基于过期版本"，必须重新确认（**不自动迁移草稿**，因为口径变更可能改变成本）。
2. 汇率源不可用 → `pricing` 失活（缺依赖）→ 拒绝出价，而不是用缓存汇率悄悄算完。
3. 产能日历更新 → `capacity` 重载 → 交期承诺重新校验；已提交的报价不自动改（事实不可变），
   而是产生 `capacity/conflict-raised` 事件提请人工处理。

**这一条把"算了一半的报价"和"用过期口径报出的价"从流程事故变成结构性不可能。**

## 5. L2 装配：四层 patch（数据即配置）

```
行业模板 (bundles/industry-*)      计量规则、税制、条款术语的基线
   └─▶ 公司策略 (patch: org)       评分权重、TCO 折现率、护栏阈值、审批矩阵
          └─▶ 项目 (patch: project) 参与方名录、日历、币种、规范库
                 └─▶ 标段 (patch: package) 范围、清单、接口、截止时间
```

- 叠加顺序固定：模板 → 组织 → 项目 → 标段 → 会话级覆盖（最高优先，仅本地生效）。
- 每条 patch 按条目 id 定位，可整行替换或插入新行（`../analysis/harness-agent-repo-conventions.md` §2.4）。
- **冲突规则 P7**：同一键被多层覆盖时，最具体层胜出；**跨方**冲突不用"文件赢"，而用字段权威方
  矩阵（ADR-0003）。两层规则不同，必须区分——这是本设计对 Cordis 的一处有意偏离。

## 6. 部署形态（profiles）

| Profile | 组成 | 用途 |
|---|---|---|
| `contractor-ops` | kernel + norm + rfq + compare + award + terms + guard + approval + web/CLI | 承包商日常 |
| `supplier-bid` | kernel + norm + intake + costmodel + pricing + capacity + deviation + approval | 供应商日常 |
| `relay` | kernel + qep + evidence（无业务插件） | 报文转发与存证；可退化为共享目录 |
| `evaluator` | kernel + eval + 回放器（只读账本） | 离线评测与影子重放 |
| `evolve` | evaluator + evolve + shadow 运行器 | 自进化流水线（`07`） |
| `minimal-mock` | 单进程，全部服务在内存/文件 | P0 mock（`../work/roadmap.md`） |

**P0 只需 `minimal-mock` 一个 profile**：两侧逻辑同进程、账本写文件、QEP 用文件投递模拟。
这保证"最先跑起来的东西"最小，且不预设任何外部系统（`11-integration-map.md` 每项都有降级路径）。

## 7. 一次完整往返（P1 目标链路）

```
[承包商] SourcingAgent 生成 BidPackage v1 + 清单
         → 人工确认范围与清单 → rfq/published(v1) [Fact] → QEP 发出
[供应商] IntakeAgent 抽清单条目 → 缺项/疑问 → 人工确认 → clarification/asked [Fact]
[承包商] ClarifyAgent 起草答案 → 人工定稿 → clarification/answered [Fact] → 广播全部在册投标人
         （若答案改变范围 → rfq/amended(v2)，所有报价必须基于 v2）
[供应商] CostAgent 成本构成(私域) → PriceAgent 定价建议 → 人工批准数字 → quote/submitted [Fact]
[承包商] NormAgent 归一化 → CompareAgent TCO 比较 + guard(异常低价/漏项/产能风险) → 排名建议
         → 人工评审 → award/intent [Intent] → QEP 发出
[供应商] 确认或拒绝 → award/confirmed 或 award/declined [Fact]
[承包商] 人工签批 → award/committed [Commitment] → po/issued
后续: change/proposed → 定价 → 人工批准 → change/approved → 结算对账
```

链路上每个 `[Fact]` 都是账本事件，因此**整条链路可离线重放、可审计重建**（P4）。

## 8. 与 Cordis 的关系（一句话交代边界）

我们**采用其设计纪律而非其代码**（ADR-0001）：副作用可回退、依赖声明式协调、组成即数据、
事件即扩展点、内核小。我们不 vendor Cordis，理由：实现栈自由、避免跟随未稳定 API
（`../analysis/cordis-architecture.md` §6.2）、且我们的核心不变量（跨方账本、承诺治理）
Cordis 完全不覆盖，必须自建。
