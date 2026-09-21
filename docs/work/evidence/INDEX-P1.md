# 证据索引（P1 mvp demo：EV-039 起）

> P0 阶段的证据在 [`INDEX.md`](INDEX.md)：EV-001..EV-038。

| 证据 | 内容 | 关联 |
|---|---|---|
| EV-039 | 宿主 profile 与配置否决（AC-PLUGIN-003，11 断言）：两 profile = 两真进程（pid/realm/账本/配置各异）；内核键更新被否决且配置未变·插件未重启；授权区间拒 agent；陌生键被拒；生效更新落盘 | AC-PLUGIN-003 / T-201 |
| EV-040 | 桥接最小闭环（AC-INTEG-004 12 断言 + AC-INTEG-005 6 断言）：内核首帧自述 50 项事件与 7 个 read/compute 方法、五个 `kernel/bridge-*` 事件已登记；版本不兼容→退出码 2 且账本 0 字节；特性降级落 `kernel/bridge-degraded`；宿主调 `approval.decide` → `commit-refused` + 留痕；宿主播报 `human:zhang` → 拒绝 + `claimed_source`/`injected_operator` 分别留痕；`fact` 面默认关闭；超限帧（>8 MiB）被拒 | AC-INTEG-004, AC-INTEG-005 / T-216 |
