# ADR-0012 直接依赖 cordis 作为宿主层（取代 ADR-0001 的"不引入其代码"条款）

Status: accepted

## Problem

P0 按 ADR-0001 的做法**只借鉴 cordis 的设计纪律、不引入其代码**，于是用 Python 手写了微内核：
事件五模式、插件 fiber 与 effect/disposer、激活 epoch。34 条 AC 证明这套纪律能落地，但代价是
**重复造轮子**：这些语义在上游已经实现并持续维护，而我们的实现必须自己跟进修补。

用户指令（2026-09-12）：**直接依赖 cordis 当前最新版，不要重复造轮子**；并在此之上让每个功能模块
都能作为 cordis 插件/中间件**分别独立演进**（自进化上线后由自进化流水线生产插件）。

需要定死三件事：(1) 依赖哪个版本、怎么在仓库内自包含地安装；(2) cordis 的真实约定与我们 P0 假设
的差异（不能靠猜）；(3) 既有 Python 内核与 34 条 AC 如何不被破坏。

## Decision

1. **宿主层直接依赖 cordis，版本钉死**：`host/package.json` 钉 `cordis@4.0.0-rc.10`
   （npm `latest` tag；2026-09-08T15:44:33Z 发布，2026-09-12 实测安装 `added 3 packages in 4s`）。
   `host/package-lock.json` 入库保证可复现；依赖只装到 `host/node_modules`（gitignored，仓库内自包含，
   不写仓库外文件）；入口 `tools/cordis.sh`（`install|smoke|run`），验证入口 `tools/verify.sh cordis`。
2. **真实约定以源码为准并钉进冒烟测试**（`host/smoke.mjs`，18 条断言，EV-038 留原始输出）：
   - 事件五模式原生存在：`ctx.events.emit/parallel/serial/bail/waterfall`；
   - `emit` 全调用忽略返回值；`parallel` 用 `allSettled`，**有失败则全部跑完再抛 `AggregateError`**；
     `serial`/`bail` 顺序推进，遇首个 `isBailed(v)`（`v !== null && v !== false && v !== undefined`）即返回；
   - **`waterfall` 的值传递靠可变载荷**（同一条链共享 `args`），**`next()` 不接受参数**；
     不调 `next()` 即短路、该监听器返回值即最终值；`next()` 调两次抛错；**终结回调无参调用**。
     ⚠️ 与 P0 Python 版 `next(work)`（把值作为参数传递）**不同**——桥接与移植时必须按载荷语义写。
   - `ctx.events.on()` 的订阅在 cordis 内部被包成 `fiber.effect()`：卸载后 `getEffects()` 归零、
     订阅不再收到事件（"卸载无残留"是原生能力）；重新 `ctx.plugin()` 得到**新 fiber uid**（不迁移旧状态）。
3. **职责边界：cordis 管组合，Python 管事实**。
   - **host/（cordis，Node）**：插件装载与生命周期、事件编排、配置分层（profiles）、
     中间件/视图/队列、场景驱动、后续自进化流水线的宿主。
   - **src/（Python）**：账本（append-only + 哈希链）、业务服务（norm/rfq/intake/cost/pricing/
     approval/commitments/deviation/compare/guard/eval/scenarios）、AC 运行器与文档门。
   - **桥接**：host 通过 `tools/run.sh`（stdout JSON）与 Python 侧交互，协议是
     **一行一条 JSON 的请求/响应 + 版本握手字段**（`{"v":<协议版本>,"id":...}`），
     Python 侧仍是唯一写账本者；桥接本身要有 AC（`qa ac AC-INTEG-*` 家族扩展），
     桥接失败必须**显式报错而不是静默降级**（沿用 `10` §1 的停发语义）。
4. **迁移与回滚**：P0 的 34 条 AC 与全部证据**保持不变**（它们是回归基线）；
   Python 内核不删、不改语义；host 的每一步都以"能在不破坏既有 AC 的前提下接管一块职责"为标准，
   任何一步出问题可单独回滚（host 与 Python 各自独立提交）。ADR-0001 的其余三条设计纪律仍然有效，
   本条只取代其中"不引入其代码"一句。

## Consequences

**正向**

- 不再手写事件模式/插件生命周期；上游语义由 cordis 维护，我们只写业务插件。
- "每个模块可独立演进"有了原生载体：插件边界 + `inject` 依赖声明 + effect 回收 + 配置 patch/journal。
- 预发布版的差异被**实测**钉住（EV-038），不再依赖对 API 的猜测。
- 仓库内自包含仍成立：Node 解释器来自工作区工具链，依赖装在 `host/node_modules`。

**负向**

- 引入第二运行时（Node/cordis + Python），桥接成为新的故障面与性能瓶颈（需 AC 覆盖）。
- `4.0.0-rc.10` 是预发布版：升级需重跑冒烟并把结论写进 commit（升级策略见 `host/README.md`）。
- cordis 4 是"组合式"核心（`Context` 自身几乎为空，能力由 `EventsService`/`RegistryService` 等提供），
  不熟悉的人会以为"没有 API"——`host/README.md` 与冒烟测试承担这部分说明成本。
- 我们的 P0 Python 内核在 host 接管后会变成"只保账本与业务服务"，其上层的重复实现需要逐步退场，
  期间存在两套语义并存的风险（用"谁写账本"的单一规则压住）。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 继续手写微内核（现状） | 与用户指令冲突；持续维护上游已解决的问题 |
| 全量移植到 TS/cordis（连账本与服务一起） | 会废弃 34 条 AC 与全部证据链，风险与工作量远大于收益；且 Python 侧的领域逻辑已可评审 |
| 只用 cordis 当 UI/中间件、不接管事件编排 | 无法满足"每个模块成为可独立演进的插件"；编排层才是插件边界所在 |
| 引入 cordis 但只在本机全局装（`npm i -g`） | 破坏"仓库自包含、无宿主依赖"，fresh system 无法复现 |
| 用 `4.0.0-beta.5`（next tag） | `next` 比 `latest` 更不稳定；用户要"当前最新版"= npm 发布标签的 latest |

## Revisit conditions

1. cordis 发布 `4.0.0` 正式版后，升级并重跑 `tools/verify.sh cordis`（差异写进 commit）。
2. 桥接的实测延迟超过 `10` §3 的性能预算，或成为确定性重放的障碍 → 重新评估桥接粒度（批处理/进程内嵌）。
3. P1 结束前，若"host 接管事件编排"与既有 `AC-EVT-*` 出现语义冲突，以**账本事实**为准，
   并为该冲突另写 ADR（不得靠改 AC 通过）。
4. 自进化流水线（`07`）上线后，插件发布需走 `loader`/`include` 的 patch+journal，
   并在本 ADR 追加一节记录实际机制。
