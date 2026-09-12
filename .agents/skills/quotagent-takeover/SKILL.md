---
name: quotagent-takeover
description: Use when taking over quotagent after a crash, context compaction, or a new session. Rebuilds state from files, verifies before acting, and hands over cleanly.
---

# quotagent 接手与恢复

## 何时用

新会话开始、上下文被压缩后、进程崩溃后、或不确定"上一步做到哪了"时。

## 步骤（严格按序）

1. **读交接**：`docs/work/handover.md`（≤1024 B，唯一"下一步动作"来源）。
2. **读状态**：`.agents/state.json`（机器可读：phase / next_task / last_verified / blockers）。
3. **读清单**：`docs/work/progress-checklist.md`，找 `status=doing` 或 `todo` 的第一个任务；
   `status=doing` 的任务若无人认领且无证据，视为未完成，重新执行。
4. **不信任记忆**：本会话之外的一切结论以仓库文件为准；不要凭印象续写文档或代码。
5. **先验证再动手**：运行 `tools/verify.sh docs` 与 `tools/verify.sh smoke`，确认仓库当前是绿的；
   红则先修文档门或运行时（必要时 `tools/bootstrap.sh` 重建仓库内 `.venv`，它幂等）。
6. **确认远端一致**：`git fetch origin && git log --oneline -3 origin/main`，
   与本地 HEAD 比对；不一致先 `git pull --rebase`，绝不强推。
7. **接手认领**：把该任务的 `status` 改为 `doing` 并写入 `.agents/sessions/` 一行记录。

## 崩溃恢复的关键事实

- **账本是唯一权威**（设计文档 `03` §7）：运行时的状态从账本重放恢复，未落账草稿允许丢失。
- 本仓库的"账本"是 `docs/work/*` + `.agents/state.json` + git 历史：三者互相冗余，
  任一缺失仍可恢复；但它们必须保持一致——不一致时以 `handover.md` 为准并立刻修正另外两处。
- 绝不假设"刚才那次 commit 成功了"：用 `git ls-remote origin` 读回远端 refs 才算完成。

## 移交（每轮次结束前必做）

1. 更新 `progress-checklist.md`（status + evidence 编号）。
2. 更新 `docs/work/handover.md`（阶段、最后验证命令与结果、**下一步唯一动作**、阻塞）。
3. 更新 `.agents/state.json`（next_task / last_verified_* / blockers）。
4. 追加 `.agents/sessions/` 一行记录。
5. `git add -A && git commit && git push`，然后 `git ls-remote origin` 回读确认。

## 反模式（出现即回退重做）

- 在没有证据的情况下把任务标成 done。
- 凭"我上一轮大概做了"继续写代码/文档。
- 遇到红门就改门或改 AC 让它变绿（改门必须走 ADR）。
- 把 handover 写成日志散文（它必须是一页可执行的指令）。
