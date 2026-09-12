---
name: quotagent-implement-task
description: Use when implementing any task from progress-checklist in quotagent. Enforces spec-first, AC-driven, effect-registered, evidence-backed work with a clean handover.
---

# 实现一个任务（progress-checklist 中的 T-<NNN>）

## 前置（缺一不可）

- 该任务在 `docs/work/progress-checklist.md` 中存在，且引用了 FR 与 AC 的 ID。
- 你能在 `docs/work/acceptance-criteria.md` 里找到该 AC 的**可执行命令**与断言。
  **找不到就先补 AC**（docs 提交），不要先写实现。
- `tools/verify.sh docs` 为绿。

## 流程

0. **运行时与 AC 入口**（运行器实现在 `src/quotagent/qa/`，格式见 ADR-0007）：
   - 跑任何东西前先 `tools/bootstrap.sh`（首次，幂等，只建仓库内 `.venv`），
     `tools/verify.sh smoke` 自检；`tools/run.sh` 自带 `PYTHONPATH=src`，不要手工设路径。
   - AC 在 `src/quotagent/qa/checks_*.py` 里实现并注册进 `registry.py`；
     **先加 `acceptance-criteria.md` 的定义行，再加断言函数**。
   - 取证：`tools/run.sh -m quotagent.qa ac <AC-ID> --evidence EV-NNN`
     （自动写时间、命令、commit、退出码与原始输出）。
   - 临时产物只能落 `tmp/`（gitignored），不许写仓库外；**用完自己清理**——门会扫描仓库内所有
     `.md`（仅排除 `.git`），留下副本就会改变门的扫描范围（AC-RUNTIME-001 断言跑完后范围不变）。
     不要为了迁就工具去改门或改 AC。
1. **先跑 AC 看它失败**（红）。记录原始输出——这是之后"真的实现了"的唯一证据来源。
   若该 AC 一开始就是绿的，说明它没有在测你要做的事，先修 AC。
2. **最小实现**，遵守这些硬约束：
   - 一切注册返回 disposer（`AGENTS.md` 规则 1）；卸载后无残留（INV-002）。
   - 新增模型可见输入必须同时新增账本事件（规则 2 / P4）。
   - 对外承诺路径必须经 `ctx.approval`；**不得**为方便加旁路（规则 3 / INV-005）。
   - 归一化不可行即拒绝，**不得**加兜底默认值（P6 / AC-NORM-002）。
   - 业务逻辑放插件，不碰内核（规则 10 / ADR-0002）。
3. **跑 AC 直到绿**，并把原始输出写入 `docs/work/evidence/EV-<NNN>-<AC-ID>.txt`
   （头部含时间、命令、commit、退出码）。
4. **跑回归**：该阶段已完成的 AC 全部重跑（例如 `tools/verify.sh g0`）；不可只跑本任务相关项
   就宣称整体通过。
5. **更新三处状态**：`progress-checklist.md`（done + evidence）、`handover.md`、`.agents/state.json`。
6. **一轮一批**：commit → push → `git ls-remote origin` 回读确认。

## 常见陷阱（本项目已踩过或已知高危）

- **工具截断文件**：用脚本工具写文件时，若命令未提供标准输入会把目标文件清空。
  写完 `.md` 后务必 `find . -name '*.md' -size -1k` 自查是否有意外空文件。
- **文档门是硬门**：ID 引用、预算、FR↔AC 覆盖任一失败都先修，别"稍后统一处理"。
- **别把 AC 做成人工检查**：确需人工的 AC 必须标 `manual` 并写清步骤与签署人。
- **别顺手扩大范围**：非目标清单在 `docs/design/00-overview.md` §5，开工前重读。
- **别改已 accepted 的 ADR**：要改就新写一条并标注 superseded。

## 完成判据（Definition of Done）

- [ ] AC 命令在干净环境重跑仍绿
- [ ] 证据文件存在且包含原始输出
- [ ] 回归无新增失败
- [ ] 三处状态文件一致
- [ ] 已 push 且远端 refs 回读确认
