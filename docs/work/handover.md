# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：B2/T-201 done —— 宿主 profile = 组成数据（一 profile 一真进程/一 realm/一账本）；
配置更新走 cordis 原生 `fiber.update`+`internal/update`：守卫不调 `next()` 即否决 → 配置不变、不重启
（ADR-0015、`host/CONFIG.md`、EV-039）。宿主钉 `cordis@4.0.0-rc.10`（ADR-0012/0013），
前提/MVP 判据 ADR-0014（V 项按指令假设通过，非结论）；顺序见 decisions.md D-007。
`verify.sh docs|v|cordis` PASS；35 条 AC 与 s1..s4 全绿。

## 下一步唯一动作

**B3 = T-202**：QEP 跨进程投递 + receipt + 重发 + seq 空洞（AC-QEP-003/AC-INTEG-002）。
拆解与依赖见 `.agents/state.json` 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
