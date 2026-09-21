# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201、T-216、T-217、T-202、T-218、T-203、T-204、T-205、T-206+T-207 与
**T-208（审计包签名 + 包含证明 + 独立验证）done**：包带 HMAC 签名与签名者、`manifest_hash` 绑定清单、
包含证明（第三方只凭叶子+证明+根）、`tools/audit-verify.py` 离线验证（退出码 0/1/2，未提供密钥不得静默通过）。
`verify.sh docs|bridge|cordis|p0-no-node|ac-registry|audit|v` 全绿；**49 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B11 = T-210**：人工门队列视图 + 超时策略（AC-APPROVE-003）—— 待批不阻塞其他工作、**不存在自动批准**。
拆解见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
