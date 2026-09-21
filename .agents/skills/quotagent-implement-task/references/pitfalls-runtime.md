# 运行时陷阱（宿主/桥/shell）

> 门与流程类陷阱在 [`pitfalls.md`](pitfalls.md)。

- **cordis 的注册/派发必须在插件 fiber 内**：在根 context 上 `events.on(...)` 或 `events.bail(...)` 会
  `TypeError: Cannot read properties of null (reading '_hooks')`（根 fiber 为 null）。写宿主插件时，
  监听器一律在 `apply(ctx)` 里注册。
- **别自造 `internal/update`**：cordis 内置了配置更新链（`fiber.update()` → `waterfall(fiber,'internal/update',…)`，
  链尾才落 `fiber.config` 并 `restart()`；监听器不调 `next()` 即短路=否决）。自造同名事件会与内置语义打架，
  正确做法是只写规则、复用上游链路（ADR-0015）。
- **`tools/*.sh` 是 POSIX sh**：`${@:2}`、`[[ ]]` 之类 bash 写法会 `Bad substitution`；传参用 `shift` + `"$@"`。
- **先写再读**：`Ledger` 在构造时加载文件，之后由别的实例写进去的记录它看不到——采集指标/校验前
  必须**在写入之后**再构造（或用新实例读）账本，否则指标 basis 全是 0。
- **cordis 的 `inject` 不能写内建 mixin**：`inject: ['events']` 会让插件**永远停在 pending**（`apply` 根本不执行），而 `inject: []` 与 `inject: ['norm']` 都正常 —— `ctx.events` 是 mixin，不是可 inject 的服务。写进 inject 不会报错，只会"什么都不发生"。同理：provided service 要在**插件自己的 ctx** 里取（外部取抛 "without inject"），fixture 想拿句柄就包装 `ctx.provide` 抓。
