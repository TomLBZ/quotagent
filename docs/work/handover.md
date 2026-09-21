# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201、T-216（桥最小闭环）、**T-217（桥的故障语义）done** —— SIGKILL 后链仍真且 durable
零丢失、在途请求记 unknown、重启预算 3/30s 超限降只读（只关 fact/commit）、背压丢 live 必留痕且 durable
可补齐、锚点异常→只读、无孤儿、启动失败不写账本（见 AC-INTEG-006 与 `13-cordis-bridge.md` §7）。
`verify.sh bridge|p0-no-node` PASS；**38 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B5 = T-202**：QEP relay/receipt/重发/seq 空洞（AC-QEP-003/004、AC-INTEG-002）。见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
