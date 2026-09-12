# 轮次记录

<!-- budget: 4 KB. 一行一轮次；这是索引，不是日志。 -->

格式：`YYYY-MM-DD | 轮次 | 做了什么 | 验证结果 | 下一步`。
只记事实与下一步；理由进 ADR，状态进 `../../docs/work/progress-checklist.md`。

| 日期 | 轮次 | 做了什么 | 验证 | 下一步 |
|---|---|---|---|---|
| 2026-09-11 | R1 | 分析层（4 篇）+ 设计层（13 篇 + ADR 0001..0006）+ FR/AC/roadmap/checklist/handover + 文档门工具 | `tools/verify.sh docs` PASS（EV-001）；远端已推送并回读（EV-003） | T-101（P0 S0.1）+ T-117 的 V-002 盲测 |
| 2026-09-12 | R2 | T-101（自包含运行时 `tools/runtime.sh|run.sh|bootstrap.sh` + CLI 骨架 + ADR-0007）、T-116（文档门干净环境复跑）、T-102（账本：追加/哈希链/投影重建/去重/停发；模型调用落账与输入重建） | `tools/verify.sh docs` PASS（EV-004）；`ac AC-AUDIT-001/002`、`ac AC-RUNTIME-001/002` 全绿（EV-005..EV-008） | T-103（P0 S0.3：事件五模式 + disposer） |
| 2026-09-12 | R3 | T-103（事件五模式 + 声明表 + 短路记录）、T-104（插件 fiber 状态机 + 依赖失活/重载不迁移草稿 + effect 回收）、T-105（QEP 信封/验签/幂等 + 文件原子投递；ADR-0008） | `tools/verify.sh docs` PASS（EV-004）；7 条新 AC + 7 条回归全绿（EV-009..EV-015） | T-106（P0 S0.6：归一化与拒绝语义） |
