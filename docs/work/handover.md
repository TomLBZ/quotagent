# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

**P1 已开工**。宿主直接依赖 cordis 4.0.0-rc.10（ADR-0012；`host/`）；桥接见 ADR-0013；
P1 前提与 MVP 判据见 ADR-0014（V 按指令"假设通过"，`register.json.planning_assumptions`
标 not_a_conclusion，**V 的 status 保持 open**）。执行顺序 = 16 批（`decisions.md` D-007）。

## 最后验证

`verify.sh docs|v|cordis` 均 PASS；P0 34 条 AC 仍全绿；远端 refs 已回读（EV-003）。

## 下一步唯一动作

**B1** 补文档覆盖缺口（FR-QEP-005/006→T-202、FR-COST-003→T-208、FR-UX-002→T-210、
roadmap S1.2/S1.14、AC 契约表加 g1、新子目录预算行）→ **B2**（T-201 双侧进程分离 + profiles，
AC-PLUGIN-003）。写冲突面同刻只允许一批持有。

## 不变量

内核不可自改 · 账本唯一写者 · 承诺需人批且桥不暴露 commit 面 · 私域不出 realm ·
不可归一即拒绝 · 护栏只标注 · 无引用即无效 · **V 结论/G0/G1 只能人签**。

## 阻塞

无。V 项真实结论仍待人工（不影响 P1 按假设推进）。
