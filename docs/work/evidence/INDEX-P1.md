# 证据索引（P1 mvp demo：EV-039 起）

> P0 阶段的证据在 [`INDEX.md`](INDEX.md)：EV-001..EV-038。

| 证据 | 内容 | 关联 |
|---|---|---|
| EV-039 | 宿主 profile 与配置否决（AC-PLUGIN-003，11 断言）：两 profile = 两真进程（pid/realm/账本/配置各异）；内核键更新被否决且配置未变·插件未重启；授权区间拒 agent；陌生键被拒；生效更新落盘 | AC-PLUGIN-003 / T-201 |
| EV-040 | 桥接最小闭环（AC-INTEG-004 12 断言 + AC-INTEG-005 6 断言）：内核首帧自述 50 项事件与 7 个 read/compute 方法、五个 `kernel/bridge-*` 事件已登记；版本不兼容→退出码 2 且账本 0 字节；特性降级落 `kernel/bridge-degraded`；宿主调 `approval.decide` → `commit-refused` + 留痕；宿主播报 `human:zhang` → 拒绝 + `claimed_source`/`injected_operator` 分别留痕；`fact` 面默认关闭；超限帧（>8 MiB）被拒 | AC-INTEG-004, AC-INTEG-005 / T-216 |
| EV-041 | 桥的故障语义（AC-INTEG-006，13 断言 + 7 个场景原始输出）：SIGKILL 后链仍真、durable 零丢失、重启留痕；在途请求记 unknown；重启预算 3/30s 第 4 次降只读（只关 fact/commit）；背压丢 live 带计数与时间窗、durable 可由 ledger.read 补齐；锚点不在链中→fault+只读；无孤儿；启动失败退出码 3 且账本零新增 | AC-INTEG-006 / T-217 |
| EV-042 | QEP 顺序与版本协商（AC-QEP-003 14 断言 + AC-QEP-004 6 断言）：seq 空洞时依赖该序号的跃迁挂起（不落事实）并发 `relay/resend-request`；补齐后按序应用并落 `kernel/qep-gap-filled`；重发字节可复现、幂等留痕；回执 `relay/receipt` 回到发送方、控制类报文不乒乓；版本交集为空即拒（`kernel/qep-rejected`）；特性差异落 `kernel/qep-degraded`；不可降级项缺失即拒 | AC-QEP-003/004 / T-202 |
| EV-043 | relay 绑定（AC-INTEG-002，11 断言）：relay 只记整包 sha256（不解析 body）；目标不可达→relay/queued→pump→relay/delivered；字节透明（逐字节相同）；篡改包照常转发但接收方验签拒收留痕；spool 被改→拒投 + relay/tamper-detected；账本隔离；发送侧不可达不落半条记录、恢复后重发幂等 | AC-INTEG-002 / T-218 |
| EV-044 | 账本同步（AC-SYNC-001，15 断言）：三值判定（一致/单侧改/冲突）；单价冲突→供应商胜出、条款冲突→承包商胜出（矩阵为双方共识，对调视角同解）；承诺字段冲突不自动合并+挂起；矩阵未覆盖→转人工；单侧或 agent 批准不算，双方 human 批准才解除挂起；非权威字段改动转 intent/suggestion | AC-SYNC-001 / T-203 |
| EV-045 | 澄清工单（AC-CLARIFY-001 8 + 002 3 + 003 4 断言）：建单必带 rfq_rev 与条目引用（否则拒绝留痕）；答案草稿经 waterfall 拦私域（strict 短路 / 非 strict 剥字段）；回答者必须 human；广播缺任一在册投标人不得关闭（bail 留痕）、覆盖全可关闭；包升版自动重开且旧答案标 stale/applies_to_rev、广播清空。附 `verify.sh ac-registry` 输出（P0 AC 无「有编号无断言」；负控改名后变红） | AC-CLARIFY-001..003 / T-204 |
| EV-046 | 报价过期与重报（AC-RFQ-004 10 断言）：升版后旧版本报价标 stale/superseded_by_rev、留痕 `quote/superseded`（可审计不清除）、不进排序且以 `quote_superseded` 显式列出、产生重报请求、链式升版与幂等；另含 AC-COMPARE-001（6 断言）与 AC-EVT-001（10 断言）的强化，修掉"挂总线时 bail 事件被 emit 派发"的真实缺陷 | AC-RFQ-004 / T-205 |
| EV-047 | 护栏扩展与产能日历（AC-GUARD-002 6 断言 + AC-CAP-001 10 断言，另回归 AC-GUARD-001/003）：条款冲突覆盖付款/质保/罚则三族；产能风险双来源（声称超限 + 日历/关键路径）；两类 Flag 均 requires_human 且逐条落账；`firm` 交期有效期内模型不可改（人可改、过期可改、indicative 可改）；冲突只提请人工（不改交期不否决）；日历私域对外不带数值 | AC-GUARD-002 / AC-CAP-001 / T-206 / T-207 |
