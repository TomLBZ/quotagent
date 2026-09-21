# 证据索引（P1 mvp demo：EV-039 起）

> P0 阶段的证据在 [`INDEX.md`](INDEX.md)：EV-001..EV-038。

| 证据 | 内容 | 关联 |
|---|---|---|
| EV-039 | 宿主 profile 与配置否决（AC-PLUGIN-003，11 断言）：两 profile = 两真进程（pid/realm/账本/配置各异）；内核键更新被否决且配置未变·插件未重启；授权区间拒 agent；陌生键被拒；生效更新落盘 | AC-PLUGIN-003 / T-201 |
| EV-040 | 桥接最小闭环（AC-INTEG-004 12 断言 + AC-INTEG-005 6 断言）：内核首帧自述 50 项事件与 7 个 read/compute 方法、五个 `kernel/bridge-*` 事件已登记；版本不兼容→退出码 2 且账本 0 字节；特性降级落 `kernel/bridge-degraded`；宿主调 `approval.decide` → `commit-refused` + 留痕；宿主播报 `human:zhang` → 拒绝 + `claimed_source`/`injected_operator` 分别留痕；`fact` 面默认关闭；超限帧（>8 MiB）被拒 | AC-INTEG-004, AC-INTEG-005 / T-216 |
| EV-041 | 桥的故障语义（AC-INTEG-006，13 断言 + 7 个场景原始输出）：SIGKILL 后链仍真、durable 零丢失、重启留痕；在途请求记 unknown；重启预算 3/30s 第 4 次降只读（只关 fact/commit）；背压丢 live 带计数与时间窗、durable 可由 ledger.read 补齐；锚点不在链中→fault+只读；无孤儿；启动失败退出码 3 且账本零新增 | AC-INTEG-006 / T-217 |
| EV-042 | QEP 顺序与版本协商（AC-QEP-003 14 断言 + AC-QEP-004 6 断言）：seq 空洞时依赖该序号的跃迁挂起（不落事实）并发 `relay/resend-request`；补齐后按序应用并落 `kernel/qep-gap-filled`；重发字节可复现、幂等留痕；回执 `relay/receipt` 回到发送方、控制类报文不乒乓；版本交集为空即拒（`kernel/qep-rejected`）；特性差异落 `kernel/qep-degraded`；不可降级项缺失即拒 | AC-QEP-003/004 / T-202 |
| EV-043 | relay 绑定（AC-INTEG-002，11 断言）：relay 只记整包 sha256（不解析 body）；目标不可达→relay/queued→pump→relay/delivered；字节透明（逐字节相同）；篡改包照常转发但接收方验签拒收留痕；spool 被改→拒投 + relay/tamper-detected；账本隔离；发送侧不可达不落半条记录、恢复后重发幂等 | AC-INTEG-002 / T-218 |
