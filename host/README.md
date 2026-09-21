# host/ —— cordis 宿主层（P1 起）

<!-- budget: 4 KB。本目录是"组合层"，业务事实仍在 Python 侧（ADR-0012） -->

P1 起，系统的**组合/插件/事件编排**层直接依赖 [cordis](https://www.npmjs.com/package/cordis)
（当前 latest：`4.0.0-rc.10`，2026-09-08 发布），不再用 Python 手写这套微内核（用户指令 + ADR-0012
取代 ADR-0001 的"不引入其代码"条款）。P0 的 Python 内核与 34 条 AC 保持原样。

## 为什么直接用 cordis

`cordis 4.0.0-rc.10` 原生提供 P0 手写过的那套语义（`host/smoke.mjs` 逐条验证）：

| 我们需要的能力 | cordis 原生 |
|---|---|
| 事件五模式 | `ctx.events.emit / parallel / serial / bail / waterfall` |
| 注册可回退（disposer） | `ctx.fiber.effect(fn)` + `fiber.getEffects()` |
| 卸载无残留 | `await fiber.dispose()` → `FiberState.DISPOSED`，effect 与订阅回收 |
| 重载不迁移旧状态 | 重新 `ctx.plugin()` 得到新 `fiber.uid` |
| 声明式依赖激活 | `inject` + `RegistryService` |

## 怎么用（都在仓库内，无宿主依赖）

```sh
tools/cordis.sh install          # 幂等；只装到 host/node_modules（gitignored）
tools/cordis.sh smoke            # 冒烟：五模式 + effect/disposer + 重载（退出码 0/1）
tools/cordis.sh run <script.mjs> # 跑 host/ 下的脚本
tools/verify.sh cordis           # 等价于 smoke，进验证入口
```

解释器解析顺序：`$QUOTAGENT_NODE` → `PATH` 上的 `node` → 工作区运行时
`/workspace/runtime/node/*/bin/node`（`source /workspace/bin/activate.sh` 后即在 PATH 上）。

## 边界（谁负责什么）

- **host/（cordis）**：组合装配、插件生命周期、事件编排、配置分层（profiles）、中间件与视图。
- **src/（Python）**：账本（append-only 哈希链）、业务服务（norm/rfq/cost/pricing/approval/
  compare/guard/eval）、AC 运行器与文档门。**业务事实与不变量仍以 Python 侧账本为准。**
- 两侧通过桥接协议通信（见 ADR-0012）；桥接本身要有 AC（`qa ac AC-INTEG-*`）。

## 版本与升级

- `host/package.json` 钉住确切版本；`host/package-lock.json` 入库以保证可复现。
- 升级 cordis = 改 `package.json` + `npm install` + `tools/cordis.sh smoke` 通过 + 一次独立 commit。
- cordis 目前是 `4.0.0-rc.*`（预发布）：升级前先跑冒烟，并把结论写进 commit 信息。
