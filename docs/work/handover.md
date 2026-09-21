# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 进行中**：T-201（宿主 profile/配置否决）与 T-216（**桥接最小闭环**）done。桥 = stdio NDJSON v1：
内核首帧自述能力清单、版本不兼容→退出码 2 且账本零新增、只开 read/compute、**commit 面永不暴露**
（调用即拒 + 留痕）、身份由内核注入、`fact` 面默认关闭。见 ADR-0013/0015 与 `13-cordis-bridge.md`。
`verify.sh docs|v|cordis|bridge` PASS；**37 条 AC 与 s1..s4 全绿**。

## 下一步唯一动作

**B4 = T-217**：桥的故障语义（SIGKILL/洪水/断连 + 背压 + 在途请求记 unknown），按 ADR-0013 §8 补 AC；
之后 **B5 = T-202**（QEP relay/重发/seq 空洞）。拆解见 state.json 的 `next_action`。

## 不变量

内核不可自改 · 账本唯一写者 · commit 面不进桥 · 私域不出 realm · V 结论只能人签（详见 AGENTS.md）。

## 阻塞

无。V 项真实结论仍待人工。
