# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 收口完成**：`tools/verify.sh g1` 退出 0 —— **57/57 条 AC + 14/14 条 MVP 判据**（`ADR-0014 §3`）。
八个入口（docs/events/bridge/cordis/p0-no-node/ac-registry/audit/v）与 s1..s4 全绿。
`g1` 内含两个真进程 + 共享目录的端到端走查（发布→澄清→升版→报价→比价→授标→变更→审计包独立验证）。

## 下一步唯一动作

**等待人工 G1 签署**（`ADR-0014 §1`：G0/G1 与 V 项结论只能人签）。若要继续推进，下一批候选 = 进入 P2
（自进化流水线 / http relay / 宿主视图），拆解见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无技术阻塞。人工项：V 项真实结论与 G0/G1 签署。
