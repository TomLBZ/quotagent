# 24 Agent 运行期插件（上下文 / 记忆 / harness）—— 契约

<!-- budget: 28 KB（`docs/design/*.md` 统一预算，见 12-documentation-standard.md §1） -->

**状态：已实现（合同=本文；代码=树内三件插件；机检=`host/t275-runtime-gate.mjs`）。**
规划与需求背景见 `23-agent-runtime-and-storage-plugins.md`；记忆四层的原始设计见 `06-agents-and-prompts.md §4`。
**本文件刻意不写需求/验收 ID 记号**：文档门要求引用的 ID 必须在定义文件里存在，未落表就写 ID 等于
用一条指向空气的验证命令冒充已登记（与 22/23 同一纪律）。

## 1. 三件插件在系统里的位置

| 插件 | 提供 | 干什么 | 门 |
|---|---|---|---|
| `host/modules/agent-context.mjs` | `agentContext` | 把"这一轮给模型看什么"变成**可核对的数据**：来源先登记、条目有界装配、拒私域与对手侧 | 第 2/7/8/9/10/11/12/20/21 条 |
| `host/modules/agent-memory.mjs` | `agentMemory` | 四层记忆（会话 / 项目 / 策略 / 跨方）逐层封死"谁能写" | 第 3/5/6/8/13/14/15/20/21 条 |
| `host/modules/agent-harness.mjs` | `agentHarness` | 有界确定性的 `plan()`/`step()` 骨架 + 宿主内存决策日志（环缓冲） | 第 4/8/16/17/18/20/21 条 |

三件都**不消费平台服务**（`inject: []`）：上下文来源由调用方登记、记忆的账本行由调用方（Python 侧）投影后给出、
harness 的载荷由调用方给 —— 宿主不替 agent 取数，也不替 agent 落任何东西。
三件都可独立装卸、独立演进（自进化可在不改内核的前提下换掉其中任何一件）。

## 2. 四层记忆的边界（谁可以写哪一层）

| 层 | 谁可以写 | 位置与生命周期 | 写入形状 | 拒绝码（有名） |
|---|---|---|---|---|
| `session` 会话 | **agent**（本进程内） | **只在宿主内存**，随 fiber 卸载回收；**永不落盘** | `{layer, key, text, citations[]}` | `memory-session-persist-refused`（任何 persist 请求）、`memory-session-full`（满即拒，不驱逐） |
| `project` 项目 | **没人能直接写本插件**：它是**账本投影** | 内存缓存；事实在账本里，缓存随丢随建 | `rebuild(rows)`（只读重建）、`read()`、`clearCache()` | `memory-project-readonly`（写入一律拒） |
| `policy` 策略 | **仅人**（`actor` 以 `human:` 开头） | 内存 patch 视图；落地（写账本）由 Python 侧做 | `write({actor, key, value, citations[]})`；agent 只能 `propose` | `memory-policy-human-only`（agent / 空 actor / `system:` 一律拒） |
| `cross_party` 跨方 | **协议**（QEP 信封：`message_id` + `base_revision` + `entries[]`） | 内存共识视图；`via:'qep'` | `applyProtocol(envelope)` | `memory-cross-party-direct-read-refused` / `…-direct-write-refused`（直接读/写对方一律拒） |

**四层共有的两条**（也都由门断言）：
- **写入必须带 `citations`**：无引用即拒（`memory-missing-citations`）；以 `[假设]` 开头的条目可以存在，
  但 `in_decision_chain:false` —— 存在但不进决策链。
- **跨 realm 不可见**：条目/行声明别的 realm 或声明私域 → 拒/排除并**计数报出**（`memory-cross-realm-refused`；
  与不变量"私域服务在对方 realm 中取不到值"同一条纪律在宿主侧的落点）。

## 3. 五条硬边界（合同的最短表述）

1. **会话永不落盘**：`persist()` 对**任何层**一律返回 `ok:false`；对会话层给专门码
   `memory-session-persist-refused`，并带 `disk_written:false` / `ledger_written:false`。
   门除了断言返回码，还**在仓库树里检索会话正文哨兵**（检索不到才算通过）——"说了不落盘"不等于"没落盘"。
2. **项目 = 账本投影**：`rebuild(rows)` 从调用方给出的账本行算出投影（`by_type` / `correlations` / `digest`），
   `clearCache()` 后重建成**逐字节一致**；换一个输入摘要必变。丢缓存不丢事实 —— 事实只可能在账本里。
3. **策略只人写**：`actor` 不以 `human:` 开头即拒；agent 的路径只有 `propose`，它产的是
   `{kind:'policy-patch-proposal', value_digest, written:false}`（**不落 patch、不落账本**），由人确认后再写。
4. **跨方只走协议**：直接读/写另一侧数据一律拒；只有带 QEP 信封的 `applyProtocol` 能进，
   且信封里的私域条目仍被逐条排除（`via:'qep'`、`ledger_written:false`）。
5. **不得成为第二条事实写路径**：三件插件都不写文件、不写账本、不订阅事件、不起子进程、不联网、
   不注册定时器、不取墙钟、不随机（门第 19 条静态扫描 + 非空转对照）。落盘与落账本**只有 Python 侧**。
   由此推出两条：三件插件的留痕（`events()`）是**宿主内存视图**，要进账本必须先两侧登记事件类型；
   上下文/harness 的产出是**输入集合与载荷**，不是承诺，也不得绕过既有的 tool-call / output-drafted 拦截点。

## 4. 上下文装配：登记、有界、降级

- **来源先登记后使用**：`registerSource({id, kind, realm, visibility})`；`kind` 是闭合集合
  （账本投影 / 项目知识 / 策略 patch / 会话），`visibility` 三档（own / private / peer）。
  未登记来源的条目一律拒（`context-unregistered-source`）—— 上下文不能从"别处顺手拿"。
- **私域与对手侧结构性拒**：`private` → `context-private-refused`；`peer` 或来源 realm ≠ 本 realm →
  `context-cross-party-refused`。拒的是**条目**，且拒时**只带 code/来源名/键名**，
  正文一个字都不出现在输出里（门用私域/对手侧哨兵检索整份输出）。
- **有界且计数诚实**：条数上限 `max_items`、单条正文按 UTF-8 字节夹到 `max_bytes`；
  `counts.items`/`counts.admitted`/`counts.bytes` 是**夹取前**的真值（`items.length + omitted === counts.items`），
  超长条目的 `bytes` 仍是原文真值（夹后长度另记 `clipped_bytes`）。展示可以有界，**数字不许悄悄变小**。
- **降级与"空 ≠ 读不到"**：来源一件没登记 / 入参不是对象 / 插件已卸载 → `degraded:true` + 有名 reason +
  next_action；登记了来源但这条没给条目 → `degraded:false` 且 `reason='context-empty'`。
  两种情形**同形状**（键集固定），且**空上下文一律 `ok:false`** —— 不得用"看起来健康的空"冒充装配成功。
- **引用与假设**：`citations[]` 必填；`[假设]` 条目存在但 `in_decision_chain:false`；`inputs[]` 是
  `<source>#<key>` 的引用列表（供输入重建路径逐条核对：删一条引用必须能发现）。
- **确定性**：条目按来源→键稳定排序（与入参顺序无关），同输入两次 `assemble()` 字节一致、跨实例一致、
  冻结输入不抛、入参不被改写。

## 5. harness：有界 + 宿主内存决策日志

- **硬上限**：`max_steps`（一轮步数）与 `max_bytes`（单步载荷）是硬上限 —— 超步数拒
  （`harness-max-steps-reached`），超字节拒（`harness-payload-too-large`，报出 bytes 与 limit）。
  超上限的计划**夹取并报**（`truncated`/`omitted`，而 `counts.steps` 仍是真值）。
- **决策日志在宿主内存的环缓冲里**：容量固定 `ring_size`，满了丢最旧并计 `dropped`（丢了多少看得见）；
  条目上一律 `in_memory:true` / `persisted:false` / `ledger_written:false`；`log()` 只回内存副本。
- **日志里不得出现凭据**：载荷出现凭据形状（键名如 token/secret/api_key，或 `cred:<ns>/<plugin>:*`、
  密钥前缀这类值）→ **整步拒**（`harness-credential-refused`），日志条目**只记字段路径**，绝不记值；
  门断言日志文本与仓库树里都检索不到凭据哨兵。
- **确定性**：同输入两次 `plan()` 的 `objective_digest` 与步表字节一致；不读墙钟、不随机、不读环境变量。

## 6. 被否决的方案（4 项，含理由）

1. **把四层记忆做成四个数据库表（或一个通用 KV 表）** → 否决：项目记忆必须是**账本可重建投影**，
   否则出现第二事实源；一旦允许直接写表，"账本重建 == 事实"这条不变量就断了（丢缓存不能丢事实，
   但表里的行既不是缓存也不是事实，是第三种东西）。**落在实现上**：`project` 层只有 `rebuild/read/clearCache`，
   没有任何写入口。
2. **让 harness 直接写账本（或提供 `commit` 类方法）** → 否决：账本写者唯一（Python 侧），
   `commit` 类永不进桥方法面；harness 是"骨架 + 载荷"，它一旦能写账本就是第二条事实写路径。
   **落在实现上**：三件插件的静态扫描里含 `ledger.append` / `appendEvent` / `EventBus` / 写文件 API，
   命中即红；模块方法面里没有任何账本句柄。
3. **把凭据/正文放进 harness 决策日志（"方便出事回看"）** → 否决：日志是宿主内存里活得最久的东西之一，
   凭据进去就等于把作用域隔离让给了"谁读得到内存"。**落在实现上**：凭据形状整步拒 + 只记字段名；
   门用哨兵同时检日志文本与仓库树。
4. **agent 直接写策略层，人只做事后追认** → 否决：策略 patch（权重、阈值、让步上限）是跨项目的
   人类授权，追认制等于把"最终决定"变成默认通过；且模型自评不得作为指标来源这一既有铁律同样要求
   人的位置在前。**落在实现上**：`human:` 前缀是硬校验，agent 只有 `propose`（`written:false`）。

## 7. 未决项（3 项，需人确认）

1. **上下文来源的准入门槛**：现在"登记即准入"（`kind` 闭合 + `realm`/`visibility` 显式），
   但**谁来批准一次登记**（管理员道？按 profile 静态声明？自动登记 + 事后审计？）未定。
   当前实现只保证"未登记一律拒"，不保证"登记的都是该登记的"。
2. **留痕入账的粒度与事件类型命名**：三件插件的 `events()` 目前是内存视图，
   落地需要先在事件两侧登记（`05-events.md` + Python 侧内核）。命名、粒度（每次拒绝一条？按轮聚合？）
   与截断策略（内存环满时丢最旧）都还没定，本批**没有**新增任何事件类型。
3. **跨方共识的 `base_revision` 语义**：`applyProtocol` 现在只校验信封形状与私域排除，
   **没有**实现 revision 向量比较/冲突检测（`03` 文档里跨方对账那套）。要不要在这一层做，
   还是继续留在协议内核侧，待定。

## 8. 机检与证据

```
node --check host/modules/agent-context.mjs host/modules/agent-memory.mjs host/modules/agent-harness.mjs
node host/t275-runtime-gate.mjs                 # 一行 JSON：{checks, passed, total, failures}；全绿 exit 0
node host/t275-runtime-gate.mjs --mutate 1..4   # 单点变异自证（锚点恰好命中 1 次 + 变异后字节必变 +
                                                # 首条 FAIL 有名 + 第 1 条断言打印的 sha256 是变异后的 +
                                                # finally 还原后逐字节一致）
```

门的 22 条断言里**必含四类反例**（会话落盘被拒 / 策略由 agent 写入被拒 / 跨方与私域不进上下文 /
上限生效且截断计数诚实），另有来源登记面、引用与假设、降级可区分性、确定性、项目投影可复校、
跨方协议、静态负控、配置负控、卸载零残留与留痕汇总。门覆盖的价值不在条数，
而在于**每条都写清了"什么情况下必须变红"**，并由四处单点变异各自证明一遍。
