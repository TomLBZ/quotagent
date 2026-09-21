# host/ —— cordis 宿主层（P1 起）

<!-- budget: 4 KB。本目录是"组合层"，业务事实仍在 Python 侧（ADR-0012） -->

P1 起，系统的**组合/插件/事件编排**层直接依赖 [cordis](https://www.npmjs.com/package/cordis)
（钉 `4.0.0-rc.10`，npm `latest`，2026-09-08 发布），不再用 Python 手写这套微内核
（ADR-0012 取代 ADR-0001 的"不引入其代码"条款）。P0 的 Python 内核与 34 条 AC 保持原样。

cordis 原生就提供我们 P0 手写过的那套语义（`host/smoke.mjs` 逐条验证，EV-038）：
`ctx.events.emit/parallel/serial/bail/waterfall`、`fiber.effect()`、卸载回收、重载得新 uid。
配置更新的细节见 `CONFIG.md`（可否决的 `internal/update` 瀑布）。

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

stdout 只输出**一行 JSON**（机器可读），日志走 stderr——沿用 ADR-0013 的帧纪律。
解释器解析顺序：`$QUOTAGENT_NODE` → `PATH` 上的 `node` → 工作区运行时
`/workspace/runtime/node/*/bin/node`（`source /workspace/bin/activate.sh` 后即在 PATH 上）。

## 边界（谁负责什么）

- **host/（cordis）**：组合装配、插件生命周期、事件编排、配置分层（profiles）、中间件与视图。
- **src/（Python）**：账本（append-only 哈希链）、业务服务（norm/rfq/cost/pricing/approval/
  compare/guard/eval/scenarios）、AC 运行器与文档门。**业务事实与不变量以 Python 侧账本为准。**
- 宿主**不写账本**（B6 起的唯一写者规则）；两侧通过桥接协议通信（ADR-0013），桥接本身要有 AC。

## 版本与升级

- `host/package.json` 钉确切版本；`host/package-lock.json` 入库保证可复现。
- 升级 cordis = 改 `package.json` + `npm install` + `tools/cordis.sh smoke` 通过 + 一次独立 commit。
- cordis 目前是 `4.0.0-rc.*`（预发布）：升级前先跑冒烟与 `qa ac AC-PLUGIN-003`，结论写进 commit 信息。
