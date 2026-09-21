# ADR-0015 宿主 profile（组成即数据）与配置更新的否决语义

Status: accepted

## Problem

T-201（S1.1）要求"双侧进程分离 + profiles"。这件事故意不能靠拍脑袋实现，因为三处语义必须钉死：

1. **profile 是什么**：一组进程内的配置分支，还是一份**可编辑的组成数据**？（ADR-0001 纪律 3 要求后者）
2. **配置更新怎么被否决**：FR-PLUGIN-004 要求"更新先过可否决的更新事件，否决即不生效"。
   这个事件是我们自造，还是 cordis 已有？否决之后"配置未变、插件未重启"如何机检？
3. **哪些键不能被任何人/agent 改**：INV-010 说内核命名空间不可自改，但 host 层的配置面
   （策略权重、授权区间、护栏阈值、profile 本身）各自的可改性没有定义。

实现前读 cordis 源码（`host/node_modules/cordis/lib/index.js:1022-1036` 与 `:268-283`）发现：
**cordis 原生就有这条链**——`fiber.update(config)` → 在**目标 fiber 自己的 context** 上
`waterfall(fiber, 'internal/update', config, noSave, tail)`，链尾才是
`fiber.config = config; fiber.restart()`；监听器签名 `(config, noSave, next)`，
**不调 `next()` 即短路**。也就是说"否决即不生效"是上游语义，我们不该自己再发明一个事件名。

## Decision

1. **profile = 组成数据**（`host/profiles.mjs`）：每个 profile 声明 `role / realm / ledger / modules /
   config / sidecar`。P1 提供三个：`contractor-ops`（承包商，con-B 账本）、`supplier-bid`（供应商，sup-A 账本）、
   `relay`（中转，不解析 body）。**一个 profile = 一个真进程 + 一个 realm + 一本账本**；
   `tools/cordis.sh run cli.mjs boot --profile X --root DIR` 启动，stdout 只输出**一行 JSON**
   （机器可读的启动清单：pid/realm/ledger/modules/config_digest/fiber_uid/config_epoch）。
   `sidecar` 字段在 B3 接通桥之前显式写 `deferred-to-B3`——**不假装已经连上内核**。
2. **配置更新走 cordis 原生链路**：`fiber.update(nextConfig)` + `internal/update` 瀑布。
   我们只提供**守卫**（`host/lib/frozen.mjs` 的纯函数 `validate`）：在插件自己的 fiber 上注册
   `internal/update`，命中违规就返回 verdict 而**不调 `next()`** → 链尾不执行 →
   **配置不变、插件不重启**（`fiber.config` 与 `fiber.uid`/激活代均不变，磁盘文件字节不变）。
   无违规则 `return next()` → 配置生效并 `restart()`（**生效即重启是 cordis 的语义**，AC 明确记录这一点）。
   关键实现约束：**监听器必须注册在插件 fiber 内**（根 context 的 `fiber` 为 `null`，
   在根上注册或派发会 `TypeError: Cannot read properties of null (reading '_hooks')`）。
3. **可改性三档 + 白名单（H10）**：`host/lib/schema.mjs` 是唯一真源
   - `frozen: true` —— **永不接受**：`kernel.*`（内核命名空间，INV-010）；
   - `humanOnly: true` —— 只接受 `source` 以 `human:` 开头：`approval.*`、`commitments.*`、
     `pricing.authorized_band.*`、`prices.authorized_band.*`、`guard.abnormal_low_ratio`、`profiles.*`；
   - 其余登记键（`compare.weights.*`、`norm.*`、`pricing.markup_pct`、`transport.*`）可由策略 patch 调整；
   - **白名单外的键一律拒绝**（`unknown-key`），不留"随便写点东西"的口子；
   - `enum` 可声明取值集合。
4. **只对"改动差集"判定**：校验比较当前配置与下一份配置，**未改动的键即使落在 frozen 类目也不触发否决**
   （否则配置里一旦出现受限键就永久无法更新）。重复提交同一更新必须是"接受且摘要不变"，
   不得产生假否决（AC-PLUGIN-003 有断言）。
5. **身份来源**：AC/CLI 通过 `--source` 传入，守卫按 `human:*` 前缀判定；`source` 不是密码学身份，
   P1 的桥（ADR-0013）由 Python 侧注入身份，宿主**不能自称 human**——这条在 B3 的桥接 AC 里继续覆盖。
6. **宿主不写账本**：B2 阶段 host 只持有 profile 元数据与配置；`ledger` 字段是**路径声明**，
   账本写入仍只有 Python 侧（ADR-0013 §3）。`tools/verify.sh cordis` 与 AC-PLUGIN-003 共同保证宿主行为可机检。

## Consequences

**正向**

- 组成即数据落地：新增一个角色 = 加一份 profile 数据，不改代码；改 profile 属 `humanOnly`，需人签。
- 否决语义直接用上游实现，我们只写规则；"配置未变、插件未重启"可直接断言（摘要 + 激活代 + 文件字节）。
- 双侧进程分离可机检（两个 profile 两个 pid/realm/账本/配置摘要），为 B4 的跨进程投递打好基础。
- 内核命名空间的冻结面在 host 层也成立（`kernel.*` 一律拒绝），与 INV-010 一致。

**负向**

- 受上游约束：`internal/update` 的签名与"不调 next() 即短路"是 cordis 语义，升级 cordis 需重跑 AC。
- 生效即重启：接受更新会让插件重跑 `apply`，因此**任何依赖进程内累积状态的模块都必须把状态外置**
  （草稿、缓存等），否则重启即丢——这条在 B3 的桥与后续模块里要持续遵守。
- `source` 目前是声明式的（CLI 参数），不是密码学身份；真正的身份注入要等桥（B3）落地。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 自造 `config/update` 事件做否决 | 与 cordis 内置的 `internal/update` 语义重复；实测在根 context 上派发会因 `fiber=null` 崩溃，说明"自己造"很容易踩错层 |
| 用环境变量/命令行参数做配置（不走更新链） | 无法表达"可否决"，且改配置等于重启进程，与 FR-PLUGIN-004 冲突 |
| profile 用代码分支（`if profile === 'contractor') ...`） | 违反"组成即数据"；新增角色要改代码，无法由人用配置扩展 |
| 允许宿主进程打开并写账本 | 违反账本唯一写者（INV-001 / ADR-0013 §3），历史会被两条路径改 |
| 对所有键一律"人能改、agent 不能改" | 策略权重等参数应由策略 patch 调整（FR-COMPARE-002），否则每次调权重都要人签 |

## Revisit conditions

1. B3 桥接通后，`sidecar` 字段换成真实入口，`source` 改为由 Python 侧注入并通过桥接 AC 覆盖。
2. cordis 的 `internal/update` 或 `fiber.update` 语义在正式版变化 → 重跑 `tools/verify.sh cordis` 与 AC-PLUGIN-003，
   差异写入本 ADR 的追加一节。
3. 若出现"必须在重启后保留进程内状态"的模块，需要外置状态方案（草稿库/epoch 绑定），届时补 ADR。
4. P2 多租户（T-304）引入后，profile 需要按租户展开（`profiles.<tenant>.*`），本 ADR 的键空间要随之扩展。
