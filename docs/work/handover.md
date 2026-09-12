# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P0 mock：S0.1 完成（自包含运行时 `tools/*.sh`、CLI `python -m quotagent.qa`、文档门 T-116）；
S0.2 完成（`kernel/ledger.py`：追加/哈希链/投影重建/去重/停发）。格式见 ADR-0007。

## 最后验证

`tools/verify.sh docs` PASS（AC-DESIGN-001..003，EV-004）；`ac AC-AUDIT-001/002`、
`ac AC-RUNTIME-001/002` 全绿（EV-005..EV-008）；远端 refs 已回读（EV-003）。

## 下一步唯一动作

执行 T-103（S0.3：事件五模式 + disposer，AC-EVT-001/002），再按 `roadmap.md` §2 推进；新 AC 先有定义行。

## 不变量

内核不可自改 · 承诺需人批 · 模型可见即账本可重建 · 私域不出 realm · 不可归一即拒绝 ·
AC 需可执行证据 · 一轮一批 commit+push 并回读。

## 阻塞

无。需人工：T-117 的 V-002 盲测决定 P1 是否成立，agent 只备料。缺陷见 D-001/D-002。
