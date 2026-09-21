# 运行时陷阱（宿主/桥/shell）

> 门与流程类陷阱在 [`pitfalls.md`](pitfalls.md)。

- **cordis 的注册/派发必须在插件 fiber 内**：在根 context 上 `events.on(...)` 或 `events.bail(...)` 会
  `TypeError: Cannot read properties of null (reading '_hooks')`（根 fiber 为 null）。写宿主插件时，
  监听器一律在 `apply(ctx)` 里注册。
- **别自造 `internal/update`**：cordis 内置了配置更新链（`fiber.update()` → `waterfall(fiber,'internal/update',…)`，
  链尾才落 `fiber.config` 并 `restart()`；监听器不调 `next()` 即短路=否决）。自造同名事件会与内置语义打架，
  正确做法是只写规则、复用上游链路（ADR-0015）。
- **`tools/*.sh` 是 POSIX sh**：`${@:2}`、`[[ ]]` 之类 bash 写法会 `Bad substitution`；传参用 `shift` + `"$@"`。
