# WebUI 用法（GUI 应用外壳 + 双方闭环）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = **完整 GUI 应用**，不是账本投影/只读路由）。 -->

本页讲**怎么用**：起服务、两条业务闭环、每个动作落到哪条账本、接口清单与已知限制、身份与会话。
机制与规则见 `docs/design/29-webui-gui-app.md` 与 `docs/design/27-plugin-architecture.md` §6。

**新人不看文档的两条路**：① 首屏「演示数据（沙盘）」一键造一条真实流转（真动作真账本、落沙盘目录、
随时清空、真实账本零新增）→ 见 `docs/sandbox-and-demo.md`；② 面板与动作自带"下一步"。

## 0. 一条命令起服务（人类可用）

```bash
./run up      # 起 WebUI（默认 http://127.0.0.1:8093/quotagent/）；幂等：已在跑就返回 already-up
./run status  # 健康 + 端口 + 日志路径        ./run logs   # 最近日志（含插件贡献装载结果）
./run down    # 停服务
```

换端口/数据目录：`./run up --port 8207 --data-dir tmp/gui-run`（或 `node host/cli.mjs webui --help`；路径类开关有
同名环境变量 `QUOTAGENT_UI_*`）。首屏是**工作台**（「我今天要做什么」），不是报告列表；页面脚本**只来自本服务**
（`assets/app.js`/`app.css`），不引外网 CDN。空数据目录下面板**如实报 degraded + next_action**，不编假数据。
## 1. 界面骨架（机制在外壳、功能在插件）

| 部位 | 怎么用 |
|---|---|
| 顶栏 | `工作台 / 承包商 / 供应商`（运维/管理走旧页）+ 命令面板/最近/通知/插件/身份/重载；点导航即切视图，URL 变深链 |
| 工作台（首屏） | 「**你现在该做什么**」把各插件待办汇成一张卡（warn/bad 优先 + 一键按钮/深链，带筛选，§10） |
| 对象页 | 行内「打开 →」= 该对象深链；只出该对象类的面板与动作；`from_route`/`from_route_kind` 入参按地址预填 |
| 插件面 | 「插件」：贡献条数 / 文件 mtime / **重载**（热更）/ 卸载 / 装载 |
| 命令面板 | `⌘K` / `Ctrl+K`：列全部动作/视图/对象类，`↑↓` 选、回车即开表单 |
| 状态栏 | 插件注册的状态读数（>8 项收进「更多 N 项」）+ 当前视图与可复制深链 |
| 快捷键 | 外壳：`g h/c/s` 切视图、`?` 帮助、`r` 重载、`Esc` 关弹层；插件：`p` 发包、`d` 备草稿、`c` 比价、`a` 提意向（卸载后一起消失）；见 **§9** |
| 表格 | 单元格里改 →「提交编辑」批量提交（键盘/小计见 §9）；勾选 + 批量按钮；右键出行动作并按该行字段预填。**长列表/查询见 §9.6** |
| 人工门 | 需要人签的动作标题带 `✍`：表单里必须写 `human:<你的名字>`，执行前再确认一次 |

## 2. 供应商侧闭环（看包 → 备报价 → 人签提交 → 回读）

1. **看包**：「发给我的 RFQ 包」只出**发给自己的**那份（投递信封 `delivered_to` 不含自己就不显示）。
2. **备报价**：表里「单价/交期」直接改 →「提交编辑」（或 `d`）→ **`quote.draft`** → 0600 待办件 →
   唯一写者 `quote-draft.py` 落 `quote/drafted`（**非签名**，可续）。
3. **提交（人工门）**：草稿行「人签提交」→ 确认 → **`quote.submit`** → `quote-sign.py` 落
   `approval/requested`→`granted`→`quote/submitted`，并在**承包商账本**登记一条。
4. **回读**：「已提交的报价」给出报价 id / 单价（整数分）/ 交期 / **签署人** / 人工门 id / 提交时刻 —— 全来自事实行。

## 3. 承包商侧闭环（发布 RFQ → 比价 → 批准 → 授标 → 发 PO）

1. **发布 RFQ**（`p`）：包 id/标题/币种/截止/行项目/受邀 realm/发言人 → 确认 → **`rfq.publish`** 落
   `rfq/published`+`rfq/distributed` + 写投递信封。
2. **比价**：「比价排名」= **`compare.rank`**（名次/得分/贡献/引用链；只读、账本零新增）；「并排对比」见 §9。
3. **授标意向（不产生义务）**：报价行右键/行内 → **`award.propose`** → 落 `award/intent-proposed` + 意向信封。
4. **供应商确认**：供应商道「确认授标」→ **`award.confirm`**（人签）→ 两侧账本各一条。
5. **授标承诺（人签）**：**`award.commit`** 门 = 意向仍 proposed + 供应商确认 + 人工批准 → `award/committed`。
6. **发 PO（人签）**：**`po.issue`** 门 = 只能由承诺派生 + 逐行引用中标条目且不得改价 + 人工批准 → `po/issued`
   （`po→award→intent→quote` 链 + 行内 `basis`）。没签的那两列是空的（**不假装已承诺**）。

## 4. 动作与接口清单

**以 API 为准，本文件不复制该表（避免与实现漂移）**：`GET /api/routes` 给路由/auth/what；
`GET /api/ui/surface` 给动作 id、入参 schema、权限档（`human-signature` 等）、确认策略、快捷键与对象类。

## 5. 写路径纪律（GUI 不是第二条事实写路径）

- 动作只**发起**：外壳校验入参 → 插件的**服务端一半** → 落 **0600 待办件** → spawn **唯一写者**；写者复核
  （0600 + 普通文件 + 重算哈希 + 业务门）才落账本；
- 对外承诺（提交报价/授标承诺/发 PO）**必须人签**且签名者 = 会话身份（§8）：`--actor human:<名字>` 交给写者，
  `agent:` 一律拒；人工门记录与承诺事件同一次落账（INV-005）。

### 5.1 写者回执 = **唯一判据**（响应体的 `ok`/`code`/`ledger_added` 必须与它同源）

写者跑完只有两样东西算数：**退出码**与**stdout 最后一行 JSON**（`host.writerReceipt(run)`：
`{rc, said, ok, code, reason, ledger_added, applied, duplicates, refused, skipped}`，`ok = rc === 0 && stdout.ok === true`）。
归属用 `receipt.item({file: staged.name, draft_id})` **只认本动作那一条** —— 邮箱式写者一次消费多条时
`applied[0]` 不是你的那条（**修前的假失败**就是这么来的）。机制在动作返回后两端对账，响应因此有两个只读字段：
`writer_consistency`（`consistent`/`fake-failure`/`no-writer-run`…）与 `writer`（rc、stdout 自述、`ledger_added`、
逐条 files、被拒码）；`fake-failure` = 写者说**真落了**、响应却报失败（用户会重复提交，比真失败更坏）。
邮箱式写者的回执逐条给 `file`/`quote_draft_id`/`line_count`/`ledger_added` 与 `refused`/`skipped`（不静默丢件），
**别人**的件进 `result.others`。复跑：`python3 tmp/fix6-verify.py` · `python3 tmp/fix9-verify.py`。

## 6. 卸载一个注册了 UI 的插件（可撤销）

（撤销一个插件的全部 UI 贡献 = `POST /api/ui/plugins/<插件 id>/unload`，见 §4 的插件行；也可在顶栏「插件」点。）

卸载后：该插件的入口（含快捷键与右键菜单项）在界面与 `/api/ui/surface` 里**同时消失**，其余插件的面板
**逐字节不变**；恢复 `POST …/{load,reload}`（§4，不必重启），`plugin.json` 类插件走 `/admin/api/user-plugins/**`。

插件把自己搬上界面只需一件事：在 `code/ui.mjs` 里 `export register(surface, host)`，用
`surface.view/panel/action/shortcut/notificationSource/statusItem/validator` 注册并返回回执数组（示例见
`src/domain/commitments/code/ui.mjs`）；`host` = 机制（`rows/publicRows`、`runPython`、`stage`、`readJson`、
`sharedFile`、`service`、`note`、`now`、`collab`、`writerReceipt` §5.1）。**外壳不认识任何业务名词**（可声明的键见
`ui-surface.mjs` 头注释）。

## 7. 已知限制（如实登记，不假装完成）

1. **比价口径**：`compare-rank.py` 按 `quote_id` 排名，与 `bid-heuristics` 的 per-item 归一**尚未统一**（真源仍是 `services/compare.py`）。
2. **投递是单收件人 P0**：多 realm 时写者**明确拒绝**；登记行**追加** `items`/`envelope`/`quote_by`/`subject`。
3. **realm 与时间**：界面以账本 `realm` 为准；写者**不读墙钟**（`--now` 必填、待办件 `submitted_at` 为空）。
4. 通知偏好/已读/布局/筛选**按会话身份存服务端**（0600，换设备仍在；未登录时只在本浏览器）——
   都**不是账本事实**（§9）。
5. 只读调用会被合并：`runPython(tool, args, {read:true})` 同一组 `(工具, 参数)` 一次渲染只 spawn 一次、
   `python_cache_ms` 内复用；动作/落待办件清空缓存（`QUOTAGENT_UI_PYTHON_CACHE_MS=0` 关掉）。
6. 长列表是**分页窗口**（不是滚动虚拟化），而且**行由服务端按窗口给**（本批）：界面每次请求都带 `w=1`
   （+ 每块的 `pq`），服务端只回那一页的行，并把 `共 N / 命中 M / 第几页 / 小计 / 命中行键` 这些
   在**全集**上算出来的数字一起给（客户端照抄 ⇒ 不是"先拿全量再截断"）。请求里**不带 `w`/`pq`** 时
   仍是整份下发（既有工具与脚本行为不变）。口径、数字与边界见 `scale-and-performance.md`。
7. **服务端忙时界面说"忙"**（P13）：渲染准入按**事件循环滞后**判过载，超阈值的**重读**请求回
   `429 + Retry-After`（`code=ui-busy`）；界面按它自动重试（有界）并在状态栏把连接灯切成
   「服务端忙（等 X ms 重试 · 滞后 Y ms）」—— 与"正常"/"失败"三种样子互不冒充；**动作、身份、
   偏好读写、健康与静态资源一律不受影响**（不拿限制功能换稳定）。阈值 `shed_ms`（**0 = 关闭**）。
   通知聚合有 5 s 的短 TTL（`notify_cache_ms`，任何动作立刻清掉；命中时状态栏写明缓存龄）。
   定位（CPU 热点）、修法与逐项读数见 `performance-under-concurrency.md`。

## 8. 身份与会话 + 自助面

登录一次，之后动作身份从**会话**取（`human:<名字>`，不再手填）：`/identity/**`（0600 会话 + HttpOnly cookie）、
`/inbox/`（五类待办，**不取墙钟**）、`/sign/`（人签；署名 ≠ 会话 ⇒ `signer-mismatch`，账本零新增）、
`/mail/config/`（0600 待处理项 → `config-apply.py`）、`/plugins/`（自己的命名空间）。
**逐条路由/谁能用/落到哪**见 `docs/identity-and-selfservice.md`（含 21 条路由、48 条断言的真跑命令与负控）。

## 9. 可用性（通知/布局/键盘/标签页）

全是**外壳**机制（`assets/app.js`/`app.css`/`app-shell.mjs`；插件只声明，键见 `ui-surface.mjs` 头注释）。

- **通知中心**（顶栏「通知」）：徽标只数**未读**；每条可「去处理」/「打开 <对象> →」/标已读；筛选
  （级别 / 标签 / **关键字**）+ 页码与每页条数 + 清空；只看 `warn` 以上、按插件静音；同一件事只出一条（`×N`）。
- **长列表 / 查询 / 五种状态**：见 **§9.6**（每块表都有查询条；计数在全量上算、DOM 只渲染本页）。
- **面板布局**：拖 `⠿` 换序（键盘 `Alt+↑/↓`）、`▾/▸` 收起、可恢复默认；按「视图+对象类」存**服务端**（0600，按身份）
  ⇒ 换浏览器/换设备仍在（见 `docs/people-and-roles.md` §5）。
- **可编辑表格**：`Tab/Shift+Tab` 走格 · `Enter`/`↑`/`↓` 走同列 · `Esc` 还原 · `Ctrl/⌘+Enter` 提交；`line_total_of`
  ⇒ 格旁实时 `×量 = 行合计`；`data.totals` ⇒ 编辑栏小计。
- **对比 + 列固定**：`group`+`group_label` + `data.compare={min,max}` ⇒ 勾 2–3 组并排；`pin:'left'` ⇒ 横滚时关键列不跑掉。
- **多标签页 / 最近**：地址即标签、`Alt+1..9` 切、`Alt+W` 关；「最近 N」/`Ctrl+E` 给最近 12 条深链。
- **身份**：顶栏「身份」看当前 `human:<名字>`/侧别，登录后**自动回原页**（`?next=`）；`signature` 与标
  `identity:true` 的字段按会话预填（§8）。

### 9.6 长列表、查询与状态（机制）

- 每块 `table`/`files`/`list`/`kv` 顶部一条**查询条**：关键字 · 按列筛选（数值/日期区间、枚举、包含）·
  点列头排序（升→降→取消）· 分页（每页 10…250 / 全部）· 清空 · 跨页「选中全部命中行」。插件通常一行不改就有。
- **行由服务端按窗口给**：改一次筛选/排序/翻页只重取**那一块**的一页（`only=` + `pq=`），响应里带
  `data-count-*` 那一套数字与 `data-q-server="1"`；读数中如实标 `data-q-fetching`，读不到保留上一页并弹黄条。
- **计数在全量行集上算**（`共 N / 命中 M`，机器可读 `data-count-*`；`data-count-full` 是面板给的全部行）；小计 /
  枚举候选 / 桶筛选片的数字都由服务端在命中集上算；编辑跨页不丢（改动通过 `pq.edits` 回给服务端算小计）。
- 五种状态互不冒充：`loading`（先清旧数据）/`error`（读不到，带 code+下一步+"重新读一次"）/`empty`/
  `empty:filtered-out`（筛选后 0 行）/`degraded`；通知读不到时保留上次读数并**标为陈旧**。
- 口径、声明与实测数字见 `scale-and-performance.md`。

## 10. 多人协作（同侧人类之间；**不写账本**）

同一侧的两个人能把活交出去、叫人看、在对象上说话 —— 全在界面内，且**不进账本**（协同痕迹不是合同事实，理由见
`code/collab.mjs` 文件头）。数据落 `<ui_shared>/collab/<side>.json`（0700 / 文件 **0600**，原子写），**按侧隔离**：
另一侧身份读同一个对象 id 只读到**自己那侧**（0 命中，不是「过滤掉」）。

- **指派 / 转交**：任意对象页（包/报价/授标/PO/变更/审批门）工具栏「指派 / 转交给同事」→ **名册**里的人 +
  **原因（必填）+ 截止**；已有人时同一动作 = 转交（留痕），只有**归我/我指派的**（或 `transfer.override_roles`
  里的角色）能转（`transfer-not-yours`）；名册外一律拒（`unknown-colleague`）。
- **关注 + 活动流**：「关注 / 取消关注」；对象页列出谁何时做了什么与关注者；关注**每人一份**，只影响自己的通知。
- **评论与 @同事**：正文写 `@<名字>` 即通知同侧那位；跨侧 `@` 拒（`cross-side-mentioned`），不存在的名字如实记进
  `unresolved`（**不假装通知到了**）。
- **我的 / 我指派的 / 全部**：协作面板、**工作台待办卡**、**通知中心**都有筛选片；通知带 `我的/@我/我关注的` 标签。
- **机制**：协作面是外壳的机制贡献（可卸载/重建），按**插件声明的对象类**自动挂上；插件只需给条目/行加
  `bucket`/`bucket_label`、给通知加 `tags`，动作字段标 `from_route_kind`。复跑：`sh tmp/p4-collab-verify.sh`。

## 11. 人员名册与角色（「同事」来自名册；**按角色限动作**；不写账本）

名册是**权威取值处**：`<ui_shared>/people/roster.json`（0700/**0600**、按侧隔离），带**角色**与**直属关系**；
`@提及/指派/转交`的候选与校验都从它来（未知名字拒）；**登录即入册**（角色「待指派」= 有名字、没有权限）。
界面：「人员名册与角色」面板 + 「名册表（逐行可改）」。**按角色限动作**（不是限视图）：转交别人的活要
「归我/我指派的」或 `transfer.override_roles` 里的角色；额度越界 ⇒ `role-limit-exceeded` 并给出该找谁。
**角色不改变签署权**（人签仍是署名 == 会话身份，越权一律拒、账本零新增）。见 `docs/people-and-roles.md`。

## 12. 两个人同时干活（乐观并发）/ 分享 / 导出列（都不写账本）

① 并发保存会**明确拒绝**（`object-changed` + 谁何时改了哪个字段 + 三个出口）；② 对象页页头「分享（含邮件
正文）」给深链 + **对方需要什么身份/侧才能看**；③ 导出的「列（N/M）」是**个人偏好**（按身份落 0600，换浏览器仍在）。
机制与判据见 **`docs/concurrency-and-sharing.md`**；复跑 `python3 tmp/p9-verify.py`。
