# 插件清单：每个功能由哪个插件提供（P2）

用户 2026-09-21 指令："项目的每个功能都应被插件提供"、"当 agent 自进化能力上线后，可以用自进化的方式制作插件或中间件等来使每一个功能模块都可分别独立演进"。

本文件的纪律：**功能必须有归属**。任何新增功能都必须在这里落到一行，并指明它由哪个插件（或哪个库/服务）提供、以及"独立演进"时改哪个文件。机检：`tools/verify.sh plugins`。

## 1. 宿主层插件（cordis，`host/modules/*.mjs`）

模块契约（fixture A1..A6 机检，见 `tools/verify.sh modules`）：`name` / `provides` / `inject` / `builtin` / `usedServices` / `Config`（`host/lib/std-schema.mjs`）/ `apply(ctx, config)` / `fixture.sample(handle)`；`inject` 里不得写内建 mixin（`events` 等，写进去插件永远 pending）；不得跨模块目录 import。

| 插件（文件） | 提供的能力 | 提供者服务名 | 被哪些 profile 装配 | 独立演进时改哪里 |
|---|---|---|---|---|
| `host/modules/kernel-bridge.mjs` | Python 内核的唯一写入通道（stdio NDJSON JSON-RPC，commit 面永不暴露） | `kernel-bridge` | `contractor-ops` 等（经桥接线） | 只改本文件 + `host/lib/bridge.mjs`；协议变更加 ADR |
| `host/modules/norm.mjs` | 单位/口径归一化（边界归一，不在决策里做） | `norm` | `supplier-bid`（`norm` 能力位） | 只改本文件；归一化口径与 Python `services/norm.py` 必须一致（`AC-NORM-*`） |
| `host/modules/compare.mjs` | 比价排序与权重组合（读账本，不写账本） | `compare` | `contractor-ops`（`compare` 能力位） | 只改本文件；排序语义变更须同步 `AC-COMPARE-*` 与 ADR-0011 |
| `host/modules/sourcing.mjs` | 领域插件：RFQ 覆盖率与缺口分析（`coverage`/`gaps`/`expiring`，纯函数只读账本行） | `sourcing` | `contractor-ops` | 只改本文件；覆盖率口径变更须同步其 fixture 断言 |
| `host/modules/timeline.mjs` | 中间件：按 realm 的事件时间线环形缓冲（有界、幂等去重、零残留；不产生业务事实） | `timeline` | `webui` | 只改本文件；容量/去重口径变更须同步其 fixture 断言 |
| `host/modules/projection.mjs` | 视角投影服务（谁看到什么字段；私域键拒收、抑制原因对外通用） | `projection` | `webui`、`contractor-ops` | 只改本文件；字段白名单变更须同步 `AC-TRUST-001` |
| `host/modules/audit-hook.mjs` | 运行期决策留痕（内存环形缓冲、去重键与账本同形、**不写账本/不写文件**） | `audit` | `contractor-ops`、`webui` | 只改本文件；关注前缀/容量变更须同步 `verify.sh audit-hook` |
| `host/modules/governor.mjs` | 运行期准入与等待：限流/背压（可解释拒绝）、显式超时、有界重试 | `governor` | `contractor-ops`、`relay` | 只改本文件；阈值/重试语义变更须同步 `verify.sh governor` |
| `host/modules/bridge-canary.mjs` | 调用面分流器：把 canary 接到宿主→内核的真实桥调用上（候选抛错回退 base、base 抛错原样抛） | `canary-dispatch` | `contractor-ops` | 只改本文件；接线语义变更须同步 `verify.sh bridge-canary` |
| `host/modules/canary.mjs` | 自进化产物的真实路由分流 + 自动回滚判定（进/升需人工引用，回滚自动） | `canary` | `contractor-ops` | 只改本文件；阈值/分流语义变更须同步 ADR-0017 与其断言 |
| `host/modules/webui.mjs` | 双方视角 WebUI（承包商/供应商两个路由；只读账本） | `webui` | `webui` | 只改本文件 + `host/lib/ledger-view.mjs`；接入见 `docs/work/deployment-manual.md` |

目录即清单：新增功能 = 新增 `host/modules/<name>.mjs`（`host/modules/index.mjs` 自动发现），不必改中心清单；模块被哪个 profile 挂载仍写在 `host/profiles.mjs`（组成即数据，ADR-0015）。

## 2. 宿主库层（`host/lib/*.mjs`，不直接对外提供服务）

| 库 | 职责 | 谁依赖 |
|---|---|---|
| `host/lib/config.mjs` | profile 配置装载（三档可改性） | `cli.mjs`、各 profile |
| `host/lib/frozen.mjs` | 冻结面判定（`kernel.*` 含人也不能改，INV-010） | `cli.mjs`、`invariants.mjs` |
| `host/lib/schema.mjs` | 可改键白名单唯一真源 | `host/lib/config.mjs` |
| `host/lib/std-schema.mjs` | 极简 standard-schema 构造器（cordis 不导出 Schema） | 全部模块 |
| `host/lib/bridge.mjs` | 桥客户端（首帧 hello、方法面分级） | `kernel-bridge.mjs`、`cli.mjs` |
| `host/lib/supervisor.mjs` | 重启预算/在途请求/孤儿进程（AC-INTEG-006） | `cli.mjs supervise` |
| `host/lib/evolution.mjs` | 演化门骨架（提案/影子/门/晋升/回滚，T-220） | `evolution.mjs` |
| `host/lib/canary-dispatch.mjs` | 把 canary 分流接到真实请求路径（按 key 选实现、回灌样本、**候选失败回退 base / base 失败原样抛**） | `canary` 及其调用方（`webui` 路径） |
| `host/lib/ledger-view.mjs` | 只读账本视图（H1：宿主不写账本） | `webui.mjs`、`cli.mjs webui` |

## 3. Python 侧功能（`src/quotagent/`，每个服务也是一个可独立演进的单元）

| 层 | 归属 | 说明 |
|---|---|---|
| `src/quotagent/kernel/*.py` | 内核（账本唯一写入者、事件总线、插件宿主、QEP、交付） | 内核不可自改（ADR-0002）；`kernel.*` 冻结面 |
| `src/quotagent/services/*.py` | 业务服务（measures/norm/rfq/intake/realm/approval/costmodel/pricing/commitments/deviation/compare/guard/evaldata/evalmetrics/scenarios/relay/sync/clarify/quotes/capacity/terms/change/export） | 每个文件 = 一个功能单元；新增服务必须带 AC（`tools/verify.sh ac-registry`） |
| `src/quotagent/qa/checks_*.py` | 各 AC 的断言实现 | 改导入清单后必须立刻跑 `tools/verify.sh ac-registry` |
| `src/quotagent/g1side.py`、`src/quotagent/bridge.py` | 走查单侧进程 / 内核桥端点 | 见 `docs/work/deployment-manual.md` |

## 4. 工作区服务（本机基础设施，见 `docs/work/deployment-manual.md`）

| 服务 | 提供者 | 备注 |
|---|---|---|
| `quotagent`（工作区网关路由 `/quotagent`） | `tools/webui-serve.py` → cordis 插件 `webui` | 幂等接入脚本 `tools/ws-integrate.py` |

## 5. 自进化产出的插件（`ADR-0016` / `T-227`）

新增功能有两条合法来源：**人写**（`T-2xx` 批次）与**自进化提案**。后者走：

1. `makeModuleProposal`（`host/lib/evolution.mjs`）绑定产物路径 / `sha256` 内容哈希 / 字节数；
2. 产物先写**影子目录**，用 `node host/check-modules.mjs --module <name> --module-dir <shadow>/modules` **真跑** A1..A6；
3. `gateModule` 五条 AND（fixture 全绿 / 不变量 / 反例集 / 预算 / 人工介入率不升）；
4. `promoteModule` 写真实 `host/modules/`，**必须**带人工 `approval_ref`（`ap-NNNN`）且影子哈希与提案一致；
5. 回滚只删自有产物（内容被他人改过则拒绝）。

不变量：**自进化只能写 `host/modules/`**（内核/服务层不可自改）；门里的 `expected_effect.metric` 固定为
`fixture:module`（不接受模型自评）；晋升后必须在本表补一行并至少被一个 profile 装配，否则 `tools/verify.sh plugins` 会红。

机检：`tools/verify.sh evolution`（27 条断言，含 7 条负控）。

## 6. 尚未归属的功能（诚实清单）

无。新增功能前先在本文件登记归属；`tools/verify.sh plugins` 会比对 `host/modules/*.mjs` 与本表，缺行即红。
