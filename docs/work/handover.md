# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P0 mock：S0.1–S0.5 完成。运行时/CLI/账本见 ADR-0007；本批新增 `kernel/events.py`（五模式）、
`kernel/plugin.py`（装载与依赖协调）、`kernel/qep.py` + `kernel/delivery.py`
（信封/验签/幂等/原子投递），细节见 ADR-0008。

## 最后验证

`tools/verify.sh docs` PASS（AC-DESIGN-001..003，EV-004）；14 条 AC 全绿
（EV-005..EV-008 + EV-009..EV-015）；远端 refs 已回读（EV-003）。

## 下一步唯一动作

执行 T-106（S0.6：归一化与拒绝语义，AC-NORM-001..003），再按 `roadmap.md` §2 推进；新 AC 先有定义行。

## 不变量

内核不可自改 · 承诺需人批 · 模型可见即账本可重建 · 私域不出 realm · 不可归一即拒绝 ·
AC 需可执行证据 · 一轮一批 commit+push 并回读。

## 阻塞

无。需人工：T-117 的 V-002 盲测决定 P1 是否成立，agent 只备料。缺陷见 D-001/D-002。
