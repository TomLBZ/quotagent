# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201（宿主 profile/配置否决）、T-216/T-217（桥最小闭环与故障语义）、
**T-202（QEP 顺序/空洞/重发 + 版本协商）与 T-218（relay 绑定）done**。
relay 只做 opaque 转发：只记整包 sha256、不解析 body；不可达排队 + pump 重试；spool 被改即拒投；
语义篡改由接收方验签发现。`verify.sh docs|bridge|cordis|p0-no-node|v` PASS；**41 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B6 = T-203**：三方协调（base/mine/theirs）+ 字段权威方 + 冲突上报（AC-SYNC-001）。
拆解见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
