# 23 Agent 运行期插件（上下文/记忆/harness）与存储插件 —— 规划

**状态：规划（未实现）。** FR 已入正式需求文档；AC 全文见 `docs/work/plans/p3-acceptance-spec.json`。

**编号与全文**：本批 41 条需求与 42 条验收条目的 **ID 与全文**在 `docs/work/plans/p3-spec.json`（含每条建议的验证命令与证据文件）。**本文件刻意不写 ID 记号**：文档门要求引用的 ID 必须在定义文件里存在，而 AC 只有在门与证据真实存在时才能合法落表 —— 未落表就写 ID，等于用一条指向空气的验证命令冒充已登记（宁可慢，不造假）。

## 1. 目标

- **上下文组装 / 记忆 / harness 由插件提供**（`agent-context`、`agent-memory`、`agent-harness`），
  各自独立装卸、可独立演进 —— 让 agent 自身的"运行时"也能被自进化迭代。
- **记忆分四层**（对齐既有 `06` 文档）：会话记忆（进程内，随 fiber 回收，**不落盘**）／
  项目记忆（**账本可重建投影**，不是数据库表）／策略记忆（只能人写，agent 只能提案）／跨方共识（只经协议）。
- 记忆写入**必须带 `citations`**；未确认内容只能以 `[假设]` 存在且**不进决策链**。
- **存储插件**（`file-store`、`db-store`）：文件管理（原子写 + per-file sha256 + ns 分区根 + 逃逸拒绝）与
  数据库（只暴露声明式接口，不接 raw SQL/连接串），且**账本仍由 Python 独占写入**（存储不得成为第二条事实写路径）。

## 2. 硬边界

- 三个 agent 运行期插件**不得写账本**（H1）、不得新增未登记事件类型（`verify.sh events` 双向守）、
  不得绕过 `agent/tool-call-requested` 与 `agent/output-drafted` 两个拦截点。
- 自进化指标来源：只读统计可作 `observe(window)` 信号，**门信号仍是真实 fixture**；
  **模型自评不得作指标来源**（既有铁律）。
- 无凭据/无后端 → `available:false` + `reason` + `next_action`，**不得自称已连接**。

## 3. 规划中的机检

`verify.sh agent-runtime` / `storage`（新建，含内建负控）＋复用 `events`/`invariants`/`modules`/`wiring`/
`evolution`/`evolve-journal`/`webui`/`clean-copy` 与既有 `qa ac AC-*`。事件两侧登记：
`agentrt/context-assembled|context-truncated|memory-written|degraded`、`storage/refused`。

## 4. 被否决的选项

- 把记忆做成"另一个数据库表" → 否决：项目记忆必须是**账本可重建投影**（否则出现第二事实源）。
- 让 harness 直接写账本/提交 → 否决：违反 H1，且 `commit` 类永不进桥方法面。
- 用模型自评当自进化指标 → 否决：既有铁律，指标必须来自真实 fixture。
- 存储插件提供"删除账本行"能力 → 否决：账本行永不销毁（ADR-0018），销毁派生副本只能走既有 `retention_exec`。

## 5. 未决

1. `db-store` 后端选择（文件型 JSONL？SQLite？本批先做**接口与隔离**，后端可用内存实现 + 显式不可用）。
2. 上下文/harness 的实际提示词与工具面（参考 deepseek harness 的具体做法由实现批调研）。

## 6. 需求行（FR-AGENTRT / FR-STORAGE）

| FR 条目 | **上下文组装由插件提供**：新增 `host/modules/agent-context.mjs`（`provides: ['agentContext']`），按能力接缝三角实现（Definition 接口 + Provider 实现 + Consumer）；上下文来源**逐项声明**（账本投影 / 项目知识 / 策略 patch / 会话），产出可重建的输入集合 `inputs[]`（与 `06` §3 规则 4 同义），组装过程**零写账本**（H1） | must | P2 | AC 条目 |
| FR 条目 | **记忆由插件提供**且按 `06` §4 **四层分层**：`host/modules/agent-memory.mjs`（`provides: ['agentMemory']`）——①会话记忆进程内、随 fiber 卸载回收（**不落盘**）②项目记忆是账本的可重建投影（**不是数据库表**，丢缓存不丢事实）③策略记忆只能人写（agent 只能提案）④跨方共识只经协议（不得由本插件合并） | must | P2 | AC 条目 |
| FR 条目 | 记忆写入**必须有 `citations`**：无引用不得进记忆；未确认内容只能以 `[假设]` 标记存在且**不进决策链**；**私域键与对方 realm 内容不进记忆**（跨 realm 不可见，INV-008 在宿主侧同样成立） | must | P2 | AC 条目 |
| FR 条目 | **harness 由插件提供且可独立演进**：`host/modules/agent-harness.mjs`（`provides: ['agentHarness']`）承载提示词前缀 / 工具面 / 输出契约 / 人工门接线；harness 插件**不得写账本**（H1）、**不得新增事件类型**（须先两侧登记，`verify.sh events`）、**不得绕过** `agent/tool-call-requested` 与 `agent/output-drafted` 两个拦截点（`05-events.md` §5） | must | P2 | AC 条目 |
| FR 条目 | 三个插件必须**服务于自进化**：其只读统计（上下文体量、被截断次数、记忆命中/未命中、被拒输出比例、人工改写率）是 `observe(window)` 的**合法信号源**，且读取不改状态；但**门信号仍是真实 fixture**（`expected_effect.metric` 固定 `fixture:module`），**模型自评不得作为指标来源** | must | P2 | AC 条目 |
| FR 条目 | **有界 + 显式降级**：上下文切片条数 / 记忆条目数 / 单条字节数上界必须声明；超界**截断并报截断**（不得静默丢）；无法组装时 `degraded:true` + `reason` + `next_action`，**空上下文不得报 `ok:true`**（"确实没内容"与"没组装出来"必须可区分） | must | P2 | AC 条目 |
| FR 条目 | **各自独立装卸、卸载零残留**：三件插件可分别装载/卸载/重载；卸载后无订阅/定时器/文件句柄残留；**卸载记忆插件不丢事实**（项目记忆可从账本重建，逐字节一致） | must | P2 | AC 条目 |

| FR 条目 | **文件管理由插件提供**（`host/modules/file-store.mjs`，`provides: ['fileStore']`）：原子写（临时文件 + rename，与 FR-INTEG-001 同语义）、每文件返回 `sha256`、按 ns 分区根、路径穿越（`..`/绝对路径/符号链接逃逸）一律拒绝、半写文件不被读取 | must | P2 | AC 条目 |
| FR 条目 | **数据库由插件提供**（`host/modules/db-store.mjs`，`provides: ['dbStore']`）：只暴露声明式接口（不接受 raw SQL/连接串形状的入参），schema/namespace 按 ns 隔离；**账本仍由 Python 独占写入**——数据库插件不得成为第二条事实写路径（H1） | must | P2 | AC 条目 |
| FR 条目 | 存储**可用性不得伪装**：无凭据/无后端时返回 `available:false` + `reason` + `next_action` 且账本零新增；**不得**返回 `connected:true`，也不得用"看起来健康的空结果"冒充已连接 | must | P2 | AC 条目 |
| FR 条目 | 存储**跨 ns 隔离**：一个 ns 不得读写另一个 ns 的文件根或 schema/键；显式构造跨 ns 路径或键必须被拒（`storage-cross-ns`）且**未发生任何写入** | must | P2 | AC 条目 |
| FR 条目 | 存储插件**不得删除账本行**（账本行永不销毁）；销毁派生副本只能走既有 `retention_exec` 门（FR-EVIDENCE-004），**不得新开销毁路径** | must | P2 | AC 条目 |
| FR 条目 | 存储插件提供**只读观察面**（容量/计数/失败次数）供自进化 `observe` 使用：有界、确定性、不出正文与私域键 | should | P2 | AC 条目 |

## 7. 验收条目（AC-AGENTRT / AC-STORAGE，摘要；全文见 JSON）

- `agentContext` 服务由插件提供；同一账本投影下组装两次 `inputs[]` **逐字节一致**（确定性）；`inputs[]` 每项都可被输入重建路径核对（**人为删一条引用 → 必须失败**）；组装过程账本行数零新增
- 四层分层各一条：①会话记忆卸载后为**零**，且磁盘上检索不到该内容（不落盘）②项目记忆删掉缓存后由账本重建且逐字节一致 ③策略记忆以 `agent:` 写入被拒、`human:` 通过 ④跨方共识不经本插件合并（对方内容跨 realm 取不到）
- 无 `citations` 的记忆写入 → 拒；`[假设]` 项**存在但不进决策链**（不出现在比价/RFQ 输入）；跨 realm 哨兵不进记忆；私域键不进记忆（`AC-TRUST-001` 的三处口径 + 记忆第四处）
- harness 装载前后账本行数与事件类型集合**不变**；harness 试图写账本/`commit` 被拒；**负控**：构造一个无引用的模型输出 → 必须被 `agent/output-drafted` 拦下（"绕过拦截点"的路径不存在）；新增事件类型而不登记 → `verify.sh eve…
- 五项只读统计可采且带依据事件（不补零）；`observe(window)` 读它不改它（读前后账本零新增）；门里的 `expected_effect.metric` 仍是 `fixture:module`，`model:self-assessment` 仍被拒 `effect-invalid`
- 超上界 → `truncated:true` + **被丢条数**（不得静默丢）；组装不可用 → `degraded:true` + `reason` + `next_action`；**空上下文不得报 `ok:true`**（与"确实无内容"可区分，两者字段不同）
- 三件插件各自卸载：每个卸载后 effects 归零、无定时器/句柄残留、另两件仍工作；**卸载记忆插件后项目记忆仍可重建**（事实不丢，与卸载前逐字节一致）

- 写为临时文件 + rename（半写文件不被读取）；`..`/绝对路径/符号链接逃逸三例全部拒且**目标不存在**；返回的 `sha256` 与磁盘内容一致（改一字即不符）
- 只暴露声明式接口（raw SQL 形状入参被拒）；存储写操作**不产生账本行**、不修改账本文件字节（H1 负控：写前后 `ledger.jsonl` 逐字节一致）；跨 ns schema 被拒
- 无凭据/无后端 → `available:false` + `reason` + `next_action` 且账本零新增；**不得**返回 `connected:true`；"真无数据"与"没连上"必须可区分（`available` 字段不同）
- 显式构造另一 ns 的文件路径与 schema/键 → 一律 `storage-cross-ns`，**且哨兵文件/键在磁盘与后端都不存在**（只断言返回错误不算通过）
- 存储插件的删除接口对账本目标**无效果且被拒**；销毁派生副本只能经 `retention_exec`，绕门的销毁请求被拒且目标仍在
- 只读观察面（容量/计数/失败次数）可采且带依据、有界、确定性、不含正文与私域哨兵；读它不改任何状态（读前后账本与磁盘零变化）
