# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201、T-216、T-217、T-202、T-218、T-203 与 **T-204（澄清工单）done**：
建单必带版本与条目引用（否则拒绝留痕）；广播缺任一在册投标人不得关闭（INV-006）；
包升版自动重开且旧答案标 stale；答案草稿经 waterfall 拦私域；回答者必须 human。
新增 `tools/verify.sh ac-registry`（P0 文档 AC 必须有断言，已负控）。
`verify.sh docs|bridge|cordis|p0-no-node|v|ac-registry` PASS；**45 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B8 = T-205**：包版本变更与报价过期标记（AC-COMPARE-001、AC-RFQ-002）。见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
