# 证据目录

<!-- budget: 4 KB -->

命名：`EV-<NNN>-<AC-ID 或主题>.txt`。每条 AC 执行后把**原始输出**存这里（头部含时间、命令、commit、退出码）。

| 编号 | 内容 | 对应 AC |
|---|---|---|
| EV-001 | 文档门运行记录（含首次失败与修复后全绿） | AC-DESIGN-001/002/003 |
| EV-002 | 设计期事实来源取证（cordis / 论文 / harness 的 commit 与文件行号） | 支撑 `docs/analysis/*` 的 `代码`/`论文` 标注 |
| EV-003 | 远端推送与 refs 回读 | 规则 7（一轮一批） |

规则：**没有证据的 AC 不得标 passed**（`AGENTS.md` 规则 6）。
`progress-checklist.md` 的 evidence 列必须指向本目录的真实文件。
