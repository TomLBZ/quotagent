# 回执如实：**零新增**必须在弹条上就说出来

<!-- 预算：16 KB（`src/*/*/docs/*.md`）。机制真源：`src/system/webui/code/assets/app.js`
     （`ledgerAddedOf` / `zeroAddedNote` / `notifyAction` / `resultHtml` / `batchReceipt`）；
     读数来源真源：`src/system/webui/code/app-shell.mjs`（`writerCheck` 的 `rows_written`、`jobDescribe` 的
     `ledger_added`）。口径真源：`docs/design/29-webui-gui-app.md` §19/§20。复跑见 `tmp/p33-shots/REPORT.md`。 -->

## 0 一句话

动作被接受了、但**一条事实都没新增**时，弹条必须写「**零新增**」并且说清为什么 —— 修前它一律写
「已受理」，而 `ledger_added=0` 只有点开回执正文的 `<details>` 才看得到 ⇒ 用户会以为"又落了一份事实"
（P31 走查实测：幂等重放落到 `duplicates`，界面仍写「已受理」）。

## 1 读数从哪来（界面一个数都不自己算）

`ledgerAddedOf(out)` 只从回执里**现成的**三处取，取不到就返回 `null`（**不知道就说不知道**，
绝不退化成 0 —— 那会把"没读到"画成"零新增"）：

| 顺序 | 落点 | 谁给的 |
|---|---|---|
| ① | `out.job.ledger_added` | 批量动作的运行时记录（逐份写者回执求和） |
| ② | `out.writer.rows_written` | 机制的**两端对账**（`app-shell.mjs#writerCheck`：把本动作那几条写者回执的 `ledger_added` 加起来） |
| ③ | `out.result.ledger_added` | 插件在建回执时自己报的数（如 `quote.submit` 的幂等分支恒 `0`） |

「为什么零新增」由 `zeroAddedNote(out)` 按回执里的证据分两种，**不猜**：

* `writer.verdict === 'no-writer-run'`（且不是批量）⇒「这次动作没跑唯一写者（只读或只改偏好）⇒ 账本零新增」；
* 本动作那几条落在 `duplicates` / 批次 `job.duplicates > 0` ⇒「已经在账本/归档里（幂等：写者按 id 认出来了，
  重签 N 件）⇒ 本次账本零新增 —— 没有第二条事实被写出来」；
* 其余 ⇒「写者回执 +0 行 ⇒ 本次账本零新增」。

## 2 三处落点（都带机读抓手）

| 界面 | 修后 | 抓手 |
|---|---|---|
| 弹条（toast） | `「<动作>：零新增」` + 「…（幂等：写者按 id 认出来了，重签 N 件）⇒ 本次账本零新增」（`warn` 样式；>0 时才写「已受理 · 本次账本 +N 行」） | `.q-toast` 文本 |
| 动作结果块（表单内 / 模态） | 标题写「零新增」，正文第一行 `账本新增：+0 行 —— …` | `[data-action-result][data-ledger-added]`、`[data-receipt-ledger="zero"]` |
| 批量回执弹层 | 「**这一批零新增：账本 +0 行 —— 没有任何新事实被写出来**」+ 逐条「已经签过（幂等）」 | `[data-batch-summary][data-batch-ledger-added]`、`[data-batch-zero="1"]` |

> 口径：这是**如实**而不是"报坏消息" —— 动作本身**确实成功了**（`ok:true`）；要说出来的是
> 「这次没有新增任何事实」，否则"已受理"三个字会被读成"又写了一条"。

## 3 复跑（真跑；夹具是 tmp 下的副本，真实账本一个字节不碰）

```bash
sh tmp/p33-shots/start-8453.sh &        # 工作树（修后）
sh tmp/p33-shots/start-8454-head.sh &   # git archive HEAD（修前）
# 单条：供应商「我的草稿」不适用；用承包商 award.propose 的**幂等重放**
#   浏览器：身份 wanglei → 命令面板 ⌘K → award.propose → 挑一条已提过的行 → 执行
#   修前（8454）：提出授标意向（不产生义务）：已受理 · (proposed)
#   修后（8453）：提出授标意向（不产生义务）：零新增 · 写者回执 +0 行 ⇒ 本次账本零新增，没有任何新事实
# 批量：身份 chenmin → 供应商 →「我的草稿」全选 → 批量人签提交（两份都已签过）
#   修前（8454）：批量人签提交（…）：已受理 · (batch-already-signed) · 2 份：已签 0 份 · 已经签过（幂等）2 份
#   修后（8453）：批量人签提交（…）：零新增 · …（幂等：写者按 id 认出来了，重签 2 件）⇒ 本次账本零新增
tools/verify.sh webui && tools/verify.sh quote-draft
```

截图与弹条原文落 `tmp/p33-shots/`（报告 `tmp/p33-shots/REPORT.md`；两份账本前后行数在报告里逐条给出）。

## 4 边界

* 修的是**读数与文案**，判据一条没松：人签门、幂等判定、写者回执的单一判据都在原处（本页不新增判据）。
* 零新增**不等于失败**：回执仍是 `ok:true`（弹条用 `warn` 样式区别于 `bad` 的"被拒"）。
* 批量与单条走的是**同一条**取数函数；某一侧取不到读数时，界面写「回执里没有这个读数（界面不替它猜）」，
  不写 0。
