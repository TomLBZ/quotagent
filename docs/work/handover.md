# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P0 mock：S0.1–S0.14 完成（仅 T-117 待人工）。语义见 ADR-0009/0010/0011；
本批新增 `services/{compare,guard,eval*,scenarios}.py`。

## 最后验证

`tools/verify.sh docs` PASS（43 md、0 未解析）；34 条 AC 全绿（EV-005..EV-035）；
`suite s1..s4` 一条命令 PASS；基线报告已入库；远端 refs 已回读（EV-003）。

## 下一步唯一动作

T-117 现场验证 V-001..V-012（结论写入 functional-requirements §1）——**需人工**；
V-002 盲测决定 P1 是否成立，agent 只备料。

## 不变量

内核不可自改 · 承诺需人批（绑 scope+ref）· 模型可见即账本可重建 · 私域不出 realm ·
不可归一即拒绝 · 未标 impact 不进 TCO · 护栏只标注不否决 · 无引用即无效 ·
反例只增不减 · AC 需可执行证据 · 一轮一批 commit+push 回读。

## 阻塞

无技术阻塞。缺陷见 D-001/D-002。
