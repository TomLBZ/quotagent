# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P0 mock：S0.1–S0.8 完成。内核见 ADR-0007/0008；本批新增 `services/norm.py`（五段归一化链）、
`services/rfq.py`（版本化）、`services/intake.py`（读包），口径数据在 `services/measures.py`；
语义见 ADR-0009。

## 最后验证

`tools/verify.sh docs` PASS（AC-DESIGN-001..003，EV-004）；21 条 AC 全绿
（EV-005..EV-008、EV-009..EV-015、EV-016..EV-022）；远端 refs 已回读（EV-003）。

## 下一步唯一动作

执行 T-109（S0.9：成本构成私域，AC-COST-001 + AC-TRUST-001），再按 `roadmap.md` §2 推进。

## 不变量

内核不可自改 · 承诺需人批 · 模型可见即账本可重建 · 私域不出 realm · 不可归一即拒绝 ·
AC 需可执行证据 · 一轮一批 commit+push 并回读。

## 阻塞

无。需人工：T-117 的 V-002 盲测决定 P1 是否成立，agent 只备料。缺陷见 D-001/D-002。
