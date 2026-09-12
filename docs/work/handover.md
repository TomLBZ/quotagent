# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P0 mock：S0.1–S0.14 功能完成（34 条 AC 绿）；**S0.15（T-117）备料完成、结论待人工**。
备料：`docs/work/validation/`（12 份执行包 + 模板 + `register.json`）。`verify.sh docs|v` 均 PASS；
自检 EV-036/037；远端已回读（EV-003）。

## 下一步唯一动作（人工）

`tools/v-kit.sh V-00X` 领材料 → 现场执行 → 证据存 `docs/work/evidence/EV-<编号>-V-00X-*.txt` →
填 `register.json`（`decided_by=human:*`）→ `tools/verify.sh v` → commit+push。
详见 `docs/work/validation/README.md`；12 条有结论后 T-117 标 `done`，G0 由人签。

## 不变量

内核不可自改 · 承诺需人批 · 私域不出 realm · 不可归一即拒绝 · 未标 impact 不进 TCO ·
护栏只标注 · 无引用即无效 · **V 结论不得由 agent 代填**。

## 阻塞

T-117 待现场人工（D-002）；V-002 盲测决定 P1 是否成立。
