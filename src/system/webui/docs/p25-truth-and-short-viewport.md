# P25：四个「会误导人的数字 / 文案 / 噪音」与横屏矮视口的收口

<!-- 预算：12 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = 完整 GUI 应用；§9/§12/§19/§20）。
     机制真源：外壳 `code/assets/app.js`（筛选片 / 提示条 / 作业面板）、`code/app-shell.mjs`（作业账与收尾对账）、
     `code/webui.mjs`（`/api/ui/jobs`）。插件侧改动：`domain/quote-prepare/code/ui.mjs`、`system/approval/code/ui.mjs`。
     本页只讲这四件事的**判据、真跑读数与截图**：`tmp/p25-shots/`（§5 复跑命令）。
     四条纪律：① 数字必须来自**真源**，不能编；② **不为好看隐藏真实差异**；③ 不新建门/测试；④ 只改外壳与这两个插件。 -->

## 0 一句话

四个都是"实测登记过、未修"的小谎与噪音，本轮逐条修掉并留读数：**「全部 0」的假计数**（外壳
`bucketBar` 把「没有数字」当 `0`）、**插件文案说"勾选不跨页"而外壳早已跨页保留**、**中断批次提示条
拿一条过期清单反复说"还没做 N 份"**、**横屏矮视口（844×390）首屏 0 行数据**。

## 1 筛选片的「全部 N」= 真源，不再是 0

**假在哪**：`bucketBar(scope, buckets, current, rows, counts)` 里「全部」那颗片硬传 `null`，而渲染那句
`Number.isFinite(Number(count)) ? … : pick(key)` —— `Number(null) === 0` ⇒ 明明"没有数字"，片上写 **0**；
同一行右边那句「共 N 行 / 命中 M 行」又是真的 ⇒ 用户会以为筛掉了全部行。

**修法**（`code/assets/app.js`）：新增 `hasCount()`（`null`/`undefined`/`''` = **没有数字**，绝不折算成 0），
「全部」片改用 `pick('')` —— 真源两处取其一：服务端窗口的 **`query.total_full`**（服务端在**全集**上算的），
或没开窗口时的**整份行数**。它由此与同块表头那句「共 N 行」**同源**。

**真跑对账**（`tmp/p25-shots/bucket-reconcile.py` + 浏览器读数，同一会话同一块）：

| 块 | 修前片上 | 修后片上 | 真源（`items` / `total_full` / `bucket_counts.today`） | 同一行的「共 N 行」 |
|---|---|---|---|---|
| `collab.feed-home`（工作台） | 全部 **0** | 全部 **400** | 400 / 400 / 400（16 页） | 共 400 行 |
| `collab.feed-supplier` | 全部 **0** | 全部 **400** | 400 / 400 / 400（16 页） | 共 400 行 |
| `workbench`（工作台待办卡） | 全部 **0** | 全部 **452** | `tally.total` = 452（卡片自己那句「另有 449 条信息」同源） | — |
| `collab.hub-*`（没有协作数据） | 全部 **0** | 全部 **0** | 0（**真的是 0**：没有条目） | 0 |

**如实登记的边界（不改、不藏）**：桶片（今天 / 近 7 天 / 更早）的数字由**插件声明**
（`collab.mjs` 在**截断前**的集合上算），条目超过单次上限（400）时它会**高于**「全部」（实测 今天 **420**
vs 全部 400，差 20 条记在 `counts.dropped`）—— 这是"块里最多列 400 条"的真实差，不是编的数字；要它消失得先
解掉上限，不是把数字抹平。**没有数字就不写数字**这条纪律的落点就是 `hasCount()`。

## 2 插件文案按事实改口：勾选**跨页保留**

**假在哪**：`quote-prepare/code/ui.mjs`（`quote.drafts` 面板 `hint`、面板 `data.note`、`batch-too-large` 的
`next_action`）与 `system/approval/code/ui.mjs`（批量决定的 `batch-too-large.next_action`）写着
「表格左侧的勾只算这一页 —— 翻页后上一页的勾不跟着走」；而 P21 起外壳**勾选按面板记、跨页保留**。

**真跑（修文案前先量事实，浏览器 1280×800，`quote.drafts` 45 行 / 2 页）**：第 1 页勾 2 行 ⇒ 按钮
「已选 2 行」→ 翻到第 2 页 ⇒ 本页 0 勾、按钮「已选 0（含不在本页共 2） 行」、计数行「已勾选 2 行」→
翻回第 1 页 ⇒ 那 2 行**仍是勾选态**、按钮「已选 2 行」，且这 2 行带 `tr.q-row-picked` 底色
（`getComputedStyle` 实测有底色）。读数与截图：`tmp/p25-shots/p25-after-02-crosspage-check.png`、
`p25-after-07-drafts-hint-crosspage.png`。

**修法**：四处用户文案逐字改成界面上的真字符串 —— 「勾选**跨页保留**（翻到下一页时上一页的勾不会丢，
翻回来还是勾着的，勾过的行有底色）」「提交按钮上的数字就是真会送出的行数（手工勾过的 + 「选中全部命中行」
选上的）」「本页没勾、只有别页勾着时写成「已选 0（含不在本页共 M） 行」」；`batch-too-large` 的出口保留
（先筛 ≤ 50 行再点「选中全部命中行（N）」），只是不再说"靠手工勾行不行"。

## 3 中断批次提示条：只在**真有未完成**时出现，且可忽略

**噪音在哪**：`jobs.json` 里没跑完的那批（`interrupted`）**永久**保留 `pending_ids`；界面每次加载都拿它说
「还没做的 N 份」。P23 实测：把剩下的 26 份重试完（26/26 有结论、账本按幂等零新增），刷新页面**仍然**弹
「还没做的 26 份」—— 一条过期清单反复说同一句话。

**修法（两侧）**：

- **服务端收尾对账**（`code/app-shell.mjs#jobReconcile`，只做减法、不删记录）：读 `/api/ui/jobs` 时把没跑完的
  `pending_ids`/`refused_ids` 与**后来的批次**对账 —— 某一份已经拿到结论（`applied`/`duplicates`/`refused`
  任一，来自 `items[]` 或 `progress[]` 的写者回执）⇒ 不再算"还没做"，条数记在 **`superseded`**；真没做的
  份数记在 **`unfinished`**（= `pending` + `refused` 的条数）。**对账在按身份过滤之前做**（谁重试的都算数）。
- **界面**（`code/assets/app.js`）：`unfinished` 为 0 ⇒ **一个字都不摆**；非 0 才摆提示条，并给
  「**忽略这条（不再提示）**」（便签键 = `批次 id|剩余份数`，落本浏览器 `localStorage`，有界 20 条）。
  便签**只收起提示、不删任何数据**：`/api/ui/jobs` 里的记录与 `pending_ids` 一字不动；又做掉几份（数字变了）
  或来了新的一批（换了 id）⇒ 照常提示。

**真跑三步**（`tmp/p25-shots/interrupt.py`：跑到第 3 条写者回执时**按端口 SIGKILL**，再重启）：

| 步骤 | `/api/ui/jobs` 真源读数 | 界面 | 截图 |
|---|---|---|---|
| 造一个真中断的批次（30 份，停在 4/30） | `status=interrupted done=4 pending=26 unfinished=26 superseded=0` | 提示条：「还没做的 26 份（进程中断过）」+「只重试剩下的 26 份」+「忽略这条（不再提示）」 | `p25-after-03-banner-B.png` |
| 点「忽略这条（不再提示）」 | 记录**一字未动**（`pending=26 unfinished=26`） | 提示条当场消失；**刷新后仍不出现**（便签 `{"job-…|26":"…"}`） | `p25-after-04-banner-ignored.png` |
| 只重试剩下的 26 份（另一批 28 份同款） | 该批 `pending=0 refused=0 superseded=28 unfinished=0` | **不再摆提示条**（自然消失）；作业面板写「待办 0」 | `p25-after-02-banner-self-cleared-after-retry.png` |

修前对照：同一夹具下重试完 26/26 后**仍然**弹「还没做的 26 份」（`p25-before-05/06-*.png`）。

## 4 横屏矮视口 844×390：首屏开始出现数据行

**账**（P23 登记：`firstRowY 1135`）：高度 390px 时**纵向 chrome** 就吃掉一整屏 —— 顶栏折成两行 **130**、
标签条 39、视图动作条 **454**（一屏按钮墙）、状态栏 **141** ⇒ 中间那块可滚区域只剩 **79px**。

**修法**（`code/assets/app.css`，矮视口判据 = **高 ≤520px**，与宽 ≤560px 那套"每块一行、横滑不删按钮"
同一做法；390×844 竖屏**不受影响**）：顶栏单行（`flex-wrap: nowrap` + 导航/工具条各自横滑）、标签条 ≤34、
视图动作条与「导出 / 打印」条**单行横滑**（右侧仍有"还能横滑"的渐变与「↔」）、查询条与计数行合成一行、
状态栏单行横滑（>8 项那截仍在「更多 N 项」里）、表格 `caption` 去掉（与计数行**同一组数字**）、
间距/字号收一档（12.5px / 行高 1.35）。

**真跑读数**（供应商视角，手机横屏 844×390，量前先点掉屏幕上的提示条、滚到顶）：

| 读数 | 修前 | 修后 |
|---|---|---|
| 首行数据 y（`firstRowY`） | **1134** | **350** |
| 首屏**可见数据行**（与视口相交） | **0** | **2**（其中**整行**入屏 1） |
| 顶栏 / 标签条 / 视图动作条 / 导出条 / 查询条 / 状态栏 | 130 / 39 / **454** / 79 / 110 / 141 | **51 / 30 / 42 / 54 / 37 / 34** |
| 可滚区域高（`#q-view`） | 79 | 275 |

同一套规则在**矮而宽的桌面窗口**（1280×500）下也成立：`firstRowY 320`、**5** 行可见、视图动作条 38 颗按钮
**一颗没少**（`sw 7087 / cw 1230` ⇒ 整条横滑）。截图：`tmp/p25-shots/p25-after-08-narrow-844x390.png`、
`p25-after-09-*home*.png`、`p25-after-11-short-desktop-1280x500.png`。

**边界（如实登记）**：屏幕上有**提示条**时首屏仍只剩很少空间（提示条是内容、不是 chrome，不该被压掉）；
`firstRowY 350` 是"没有提示条"的读数。竖屏 390×844（宽 ≤560px）走的是卡片化那套，本轮未动。

## 5 复跑（真跑 + 截图；私有数据目录，绝不碰真实账本）

```bash
sh tmp/p25-shots/start.sh 8495 $(pwd)/tmp/p25-run            # ① 起服务（私有目录 tmp/p25-run）
python3 tmp/p21-shots/seed-scale.py --port 8495 --pkgs 45 --gates 12   # 45 包 / 45 份待签草稿（多页 + 多桶）
python3 tmp/p25-shots/bucket-reconcile.py --port 8495 --side supplier --name p21-supplier \
  --path "/api/ui/panels?view=supplier" --out tmp/p25-shots/bucket-reconcile-supplier.json
python3 tmp/p25-shots/chip-check.py --chips-file tmp/p25-shots/chips-after-supplier.json \
  --view supplier --out tmp/p25-shots/chip-check-supplier.json       # ① 片上数字 vs 真源（0 处不符）
python3 tmp/p25-shots/interrupt.py fire  --port 8495 --take 30       # ③ 造一个真中断的批次（SIGKILL）
python3 tmp/p25-shots/jobs-read.py  --port 8495                      # ③ 读数：pending / superseded / unfinished
python3 tmp/p25-shots/interrupt.py retry --port 8495                 # ③ 只重试剩下的 ⇒ 提示条自然消失
# ④ 浏览器侧：Emulation.setDeviceMetricsOverride(844×390) → 量 firstRowY / 可见行数（读数见 §4）
python3 tools/check-docs.py && sh tools/verify.sh webui                # 门（本轮：文档门 PASS）
```

截图/读数全在 `tmp/p25-shots/`（修前 `p25-before-*`、修后 `p25-after-*`、`*.json`）。
