# 证据目录

<!-- budget: 4 KB -->

命名：`EV-<NNN>-<AC-ID 或主题>.txt`。每条 AC 执行后把**原始输出**存这里（头部含时间、命令、commit、退出码）。

| 编号 | 内容 | 对应 AC |
|---|---|---|
| EV-001 | 文档门运行记录（含首次失败与修复后全绿） | AC-DESIGN-001/002/003 |
| EV-002 | 设计期事实来源取证（cordis / 论文 / harness 的 commit 与文件行号） | 支撑 `docs/analysis/*` 的 `代码`/`论文` 标注 |
| EV-003 | 远端推送与 refs 回读 | 规则 7（一轮一批） |
| EV-004 | 文档门复跑：仓库内 + 干净副本（最小环境、裸解释器、未设 PYTHONPATH） | AC-DESIGN-001/002/003 |
| EV-005 | 账本篡改检测：篡改历史事件 → `verify_chain()` 假、审计包独立验证失败、冻结后拒追加 | AC-AUDIT-001 |
| EV-006 | 模型输入重建：抽样 20 次 `rebuild(inputs) == observed_inputs`；含未落账注入的负控；投影全量/增量/时点一致 | AC-AUDIT-002 |
| EV-007 | 自包含运行时：仅标准库、干净副本可跑、`tools/bootstrap.sh` 幂等、产物不落仓库外 | AC-RUNTIME-001 |
| EV-008 | CLI 契约：JSON 报告、退出码 0/1/2、未实现入口返回 2 | AC-RUNTIME-002 |
| EV-009 | 事件五模式实测：emit 全调用、parallel 全跑并聚合抛错、serial/bail 短路点、waterfall 委托链、模式误用报错、disposer 撤销 | AC-EVT-001 |
| EV-010 | waterfall 不调 `next()` 即短路（下游不执行、返回值即最终值、记录短路点），且默认事件表的 waterfall 事件均在 05-events.md §5 登记 | AC-EVT-002 |
| EV-011 | 插件装载/卸载残留检查：监听器、账本订阅、定时器三类 effect 计数回到基线，定时器停止触发 | AC-PLUGIN-001 |
| EV-012 | 依赖失活 → 消费者 inactive 且 effects 回收、草稿清空；依赖恢复 → 自动重载（epoch 递增）且草稿重新生成 | AC-PLUGIN-002 |
| EV-013 | QEP 信封：字段齐全、可验签、逐字段篡改导致验签失败、body_hash/版本/承诺批准校验 | AC-QEP-001 |
| EV-014 | 幂等：同报文投递 3 次只 1 条事实 + 2 条 duplicate-dropped；重发 msg_id/body_hash 不变且不产生第二条事实 | AC-QEP-002 |
| EV-015 | 文件投递：临时文件 + rename 原子落盘、命名约定、半写/坏文件不被读取且坏文件被隔离并留原因 | AC-INTEG-001 |

规则：**没有证据的 AC 不得标 passed**（`AGENTS.md` 规则 6）。
`progress-checklist.md` 的 evidence 列必须指向本目录的真实文件。
