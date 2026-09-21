# host/ —— cordis 宿主层（P1 起）

<!-- budget: 4 KB。本目录是"组合层"，业务事实仍在 Python 侧（ADR-0012） -->

组合/插件/事件编排层直接依赖 [cordis](https://www.npmjs.com/package/cordis)（钉 `4.0.0-rc.10`），
不再用 Python 手写这套微内核（ADR-0012 取代 ADR-0001 的相关条款）；P0 内核与 34 条 AC 原样保留。
cordis 原生语义由 `host/smoke.mjs` 逐条验证（EV-038）；配置更新见 `CONFIG.md`。

## profiles（组成即数据，ADR-0015）

| profile | 角色 | realm | 账本 | 模块 |
|---|---|---|---|---|
| `contractor-ops` | 承包商运营台 | `contractor:con-B` | `ledger-contractor.jsonl` | config / compare / guard / approval / queue |
| `supplier-bid` | 供应商报价台 | `supplier:sup-A` | `ledger-supplier.jsonl` | config / norm / cost / pricing |
| `relay` | 中转（不解析 body） | `relay:r-1` | `ledger-relay.jsonl` | config / transport |

一个 profile = **一个真进程 + 一个 realm + 一本账本**。`sidecar` 在桥接通前显式写
`deferred-to-B3`（**不假装连上内核**）。改 profile 属 `humanOnly`，只有人能改。

## 怎么用（都在仓库内，无宿主依赖）

```sh
tools/cordis.sh install          # 幂等；只装到 host/node_modules（gitignored）
tools/cordis.sh smoke            # 冒烟：五模式 + effect/disposer + 重载（退出码 0/1）
tools/cordis.sh run cli.mjs boot --profile contractor-ops --root DIR [--hold 5]
tools/cordis.sh run cli.mjs status --profile contractor-ops --root DIR
tools/cordis.sh run <script.mjs> # 跑 host/ 下的其它脚本
tools/verify.sh cordis           # 等价于 smoke，进验证入口
```

stdout 只输出**一行 JSON**，日志走 stderr（ADR-0013 的帧纪律）。node 解析顺序：`$QUOTAGENT_NODE` → `PATH`
→ 工作区 `/workspace/runtime/node/*/bin/node`。

## 边界（谁负责什么）

- **host/（cordis）**：组合装配、生命周期、事件编排、配置分层（profiles）、中间件与视图。
- **src/（Python）**：账本（append-only 哈希链）、业务服务、AC 运行器与文档门；**事实与不变量以 Python 账本为准**。
- 宿主**不写账本**；两侧经桥接协议通信（ADR-0013）。

## 版本与升级

- `host/package.json` 钉确切版本；`host/package-lock.json` 入库保证可复现。
- 升级 cordis = 改 `package.json` + `npm install` + `tools/cordis.sh smoke` 通过 + 一次独立 commit。
- cordis 目前是 `4.0.0-rc.*`（预发布）：升级前先跑冒烟与 `qa ac AC-PLUGIN-003`，结论写进 commit 信息。

## 演化门骨架（T-220）

- `host/lib/evolution.mjs`（提案/journal 归属/影子挂载/门/晋升/回滚）+ `host/evolution.mjs`（冒烟，含负控），
  入口 `tools/verify.sh evolution`。落账由 `tools/evolve-record.py` 走 Python 侧（宿主不写账本）。
- P1 不允许自动晋升；canary 真实路由与自动晋升/回滚阈值留 P2（`ADR-0014 §7`）。

## 进树模块与 fixture（T-221 / 评审 C §6）

WebUI 也是模块（`modules/webui.mjs`）：双方视角两个路由、每方读自己的账本、dispose 释放端口；接入 dashboard 见 `docs/work/deployment-manual.md`，门 `tools/verify.sh webui`。

- `host/modules/{kernel-bridge,norm,compare}.mjs`：一模块一 manifest（`name/inject/provides/Config/apply/disposer`）。
- 入口 `tools/verify.sh modules`（fixture A1..A6，每条带负控；规格见 `docs/design/04-services-catalog.md` §9）。
- `host/lib/std-schema.mjs`：standard-schema v1 构造器（cordis 只消费 `Config["~standard"].validate`，不导出 `Schema`）。
- 两个实测坑：① `inject: ["events"]` 会让插件**永远 pending**（`events` 是内建 mixin）；
  ② provided service 只能在**插件自己的 ctx** 取（外部取抛 "without inject"），fixture 用包装 `provide` 抓句柄。
