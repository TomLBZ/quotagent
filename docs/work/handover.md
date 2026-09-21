# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201、T-216、T-217、T-202、T-218、T-203、T-204 与 **T-205（报价过期与重报）done**：
升版后旧报价标 `stale`/`superseded_by_rev` 并落 `quote/superseded`（不清除，可审计），`compare` 以
`quote_superseded` **显式排除**，并产生带版本号的重报请求。本轮另修真实缺陷：bail 事件被 emit 派发
（挂总线即崩）→ 统一走 `EventBus.dispatch()`（见 D-014 / EV-046）。
`verify.sh docs|bridge|cordis|p0-no-node|ac-registry|v` 全绿；**46 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B9 = T-206 + T-207**：护栏扩展（异常低价判定与 Flag）与产能日历/交期校验。见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
