# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201（宿主 profile/配置否决）、T-216（桥最小闭环）、T-217（桥故障语义）done；
**T-202 内核部分 done**（seq 空洞→挂起+重发请求、补齐后按序应用、回执不乒乓、版本交集/降级留痕，
AC-QEP-003/004 全绿）。剩余：**T-218 = relay 绑定**（opaque 转发 + 排队重试，AC-INTEG-002）。
`verify.sh docs|bridge|cordis|p0-no-node|v` PASS；**40 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B5b = T-218**：relay 只转发不解析 body（篡改由接收方验签发现）、不可达时排队重试、回执闭环。
拆解见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
