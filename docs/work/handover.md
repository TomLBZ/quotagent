# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**；已完成任务见 `progress-checklist.md` 的 done 行。最近一批
**T-215a（分发记录 + 截止时间与超时提醒）done**：`distribute()/deliveries()` 回答「谁在何时收到哪个版本」
（版本以快照哈希锚定、历史只增）；`deadline_status()/remind()` 按 overdue|due-soon 分流提醒、**幂等**、
**绝不自动顺延截止**。八入口全绿；**57 条 AC 全绿**。

## 下一步唯一动作

**B16b = T-215b**：部署与操作手册（一页能跑起来）+ `tools/verify.sh g1` 聚合门 → **P1/MVP 收口**。
手册要按它自己在干净目录实跑一遍并留证据；完成后对照 ADR-0014 §3 的 MVP 判据逐条给结论。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
