# WebUI 用法（GUI 应用外壳 + 双方闭环）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = **完整 GUI 应用**，不是账本投影/只读路由）。 -->

本页只讲**怎么用**：起服务、两条业务闭环怎么走、每个动作落到哪条账本、动作/接口清单与已知限制、身份与会话。
机制与规则见 `docs/design/29-webui-gui-app.md` 与 `docs/design/27-plugin-architecture.md` §6。

## 0. 一条命令起服务（人类可用）

```bash
./run up      # 起 WebUI（默认 http://127.0.0.1:8093/quotagent/）；幂等：已在跑就返回 already-up
./run status  # 健康 + 端口 + 日志路径        ./run logs   # 最近日志（含插件贡献装载结果）
./run down    # 停服务
```

换端口/数据目录：`./run up --port 8207 --data-dir tmp/gui-run`（或 `node host/cli.mjs webui --help`；
路径类开关有同名环境变量 `QUOTAGENT_UI_*`）。打开后首屏是**工作台**（「我今天要做什么」），不是报告列表；
页面脚本**只来自本服务**（`assets/app.js`/`app.css`），不引外网 CDN、无需构建。
空数据目录下面板**如实报 degraded + next_action**，不编假数据。

## 1. 界面骨架（机制在外壳、功能在插件）

| 部位 | 怎么用 |
|---|---|
| 顶栏 | `工作台 / 承包商 / 供应商`（运维/管理走旧页）+ 命令面板/最近/通知/插件/身份/重载；点导航即切视图，URL 变深链 |
| 工作台（首屏） | 「**你现在该做什么**」把各插件待办汇成一张卡（warn/bad 优先 + 一键按钮/深链，带「我的 / 我指派的 / 全部」筛选，§10） |
| 对象页 | 行内「打开 →」= 该对象深链；对象页只出该对象类的面板与动作（其余收进「本视图的其它动作」）；标了 `from_route`/`from_route_kind` 的入参按地址预填 |
| 插件面 | 「插件」：贡献条数 / 文件 mtime / **重载**（热更）/ 卸载 / 装载 |
| 命令面板 | `⌘K` / `Ctrl+K`：列全部动作/视图/对象类，`↑↓` 选、回车即开表单 |
| 状态栏 | 插件注册的状态读数（>8 项收进「更多 N 项」）+ 当前视图与可复制深链 |
| 快捷键 | 外壳：`g h/c/s` 切视图、`?` 帮助、`r` 重载、`Esc` 关弹层；插件：`p` 发包、`d` 备草稿、`c` 比价、`a` 提意向（卸载后一起消失）；通知/布局/键盘/标签页见 **§9** |
| 表格 | 可编辑列在单元格里改 →「提交编辑」批量提交（**键盘流转与小计见 §9**）；勾选框 + 批量按钮（"全选"只作用于**本表**）；行上右键出 `context_menu` 动作并按该行字段预填 |
| 人工门 | 需要人签的动作标题带 `✍`：表单里必须写 `human:<你的名字>`，执行前再确认一次 |

## 2. 供应商侧闭环（看包 → 备报价 → 人签提交 → 回读）

1. **看包**：「发给我的 RFQ 包」只出**发给自己的**那份（投递信封 `delivered_to` 不含自己就不显示）。
2. **备报价（可续草稿）**：行项目表的「单价/交期」列直接改 →「提交编辑」（或 `d`）→ 动作 **`quote.draft`**：
   校验（整数分/上下界/发言人 `human:`）→ 0600 待办件 → 唯一写者 `quote-draft.py` 落 `quote/drafted`（**非签名**）。
3. **提交（人工门：签名）**：草稿行「人签提交」→ 确认 → **`quote.submit`** → `quote-sign.py` 落
   `approval/requested`→`granted`→`quote/submitted`（顺序不可颠倒），并在**承包商账本**登记一条。
4. **回读**：「已提交的报价」显示报价 id / 整数分单价 / 交期 / **签署人** / 人工门 id / 提交时刻 —— 全来自事实行。

## 3. 承包商侧闭环（发布 RFQ → 比价 → 批准 → 授标 → 发 PO）

1. **发布 RFQ**（`p`）：包 id/标题/币种/截止/行项目/受邀 realm/发言人 → 确认 → **`rfq.publish`**：
   `rfq-publish.py` 落 `rfq/published`+`rfq/distributed` + 写投递信封。
2. **比价与授权**：「比价排名」= **`compare.rank`**（名次/得分/分量贡献/引用链；只读工具，账本零新增）；
   「并排对比」见 §9；「授权区间」页回答"谁能批到多少/越界怎么办"。
3. **授标意向（不产生义务）**：报价行右键/行内 → **`award.propose`** → `--step propose` 落
   `award/intent-proposed` + 写意向信封（`exchange/award-intents.json`）。
4. **供应商确认**：供应商道「确认授标」→ **`award.confirm`**（人签）→ 两侧账本各一条。
5. **授标承诺（人签）**：**`award.commit`** 门 = 意向仍 proposed + 供应商确认 + 人工批准 → `award/committed`。
6. **发 PO（人签）**：**`po.issue`** 门 = 只能由承诺派生 + 逐行引用中标条目且不得改价 + 人工批准 → `po/issued`
   （`po→award→intent→quote` 链 + 行内 `basis`）。没签的那两列是空的（**不假装已承诺**）。

## 4. 动作与接口清单（机器可读；完整表见 `/api/routes` 与 `/api/ui/surface`）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/quotagent/`、`/app/<view>/`、`/app/<view>/<kind>/<id>/` | GET | GUI 首屏（工作台）/ 视图 / **对象深链**（`kind` 由插件 `object_kind` 声明；对方视角 ⇒ 如实未命中） |
| `/assets/app.js`·`app.css` | GET | 客户端资源（**只来自本服务**） |
| `/api/ui/surface`·`panels`·`notifications`·`status`·`blocks?slot=` | GET | 注册面自述 / 面板数据 / 通知中心 / 状态栏 / 旧槽位区块 |
| `/api/action/<id>` | POST | **动作总线**：`{"view":"…","input":{…}}`；校验 → 插件自己的服务端一半 |
| `/api/collab/{object,hub,store}`、`/api/people/{roster,suggest,store}` | GET | 同侧协作（§10）/ 人员名册与角色（§11）：未登录 `401`；非 GET ⇒ **405 + `Allow: GET`** |
| `/api/ui/notif-state` | GET/POST | 通知偏好 / 已读 / **布局** / 筛选（按身份、0600；§9） |
| `/api/ui/plugins`；`…/<plugin_id>/{load,reload,unload}` | GET/POST | 装载清单；**热重载**（改 `code/ui.mjs` 不必重启）/ 卸载 |

动作的**服务端一半一律是**：插件校验 → 落 0600 待办件 → spawn **唯一写者**（`compare.rank` 例外，只读）。
`quote.submit` / `award.confirm` / `award.commit` / `po.issue` 是 **human-signature**（署名必须 == 会话身份）。
写者与账本事件、逐动作入参见各插件 docs 与 `/api/ui/surface` 的动作 `hint`；协作与名册类动作
（`collab.*` / `people.*`）**不调任何写者、账本零新增**（§10/§11）。等价命令行：
`python3 src/domain/<插件>/tools/<写者>.py --step <步骤> --request <0600待办件> --now … --ui-shared …`

验收/复现脚本（**都不写账本**）：`src/system/webui/tools/{gui-walkthrough,gui-readback,gui-unload}.py`
（双闭环走查 / 回读 / 卸载后对照）· `sh tmp/p4-collab-verify.sh`（协作面）· `python3 tmp/p5-people-verify.py`（名册/角色）。
手工复现：改任一 `code/ui.mjs` → 顶栏「插件」→「重载」。

## 5. 写路径纪律（GUI 不是第二条事实写路径）

- 动作只**发起**：外壳校验入参 → 插件的**服务端一半** → 落 **0600 待办件** → spawn **唯一写者**；写者复核
  （0600 + 普通文件 + 重算哈希 + 业务门）才落账本；
- 对外承诺（提交报价/授标承诺/发 PO）**必须人签**且签名者 = 会话身份（§8）：`--actor human:<名字>` 交给写者，
  `agent:` 一律拒；人工门记录与承诺事件同一次落账（INV-005）。

## 6. 卸载一个注册了 UI 的插件（可撤销）

```bash
# 撤销一个插件的全部 UI 贡献（视图/面板/动作/快捷键/通知源/状态项 + 旧槽位区块）
curl -s -X POST 'http://127.0.0.1:8093/quotagent/api/ui/plugins/domain%2Frfq/unload'
```

卸载后：该插件的入口（含快捷键与右键菜单项）在界面与 `/api/ui/surface` 里**同时消失**，其余插件的面板
**逐字节不变**。恢复 `POST …/{load,reload}`（§4，**不必重启**）；`plugin.json` 类插件走
`/admin/api/user-plugins/{load,unload,reload}`。

插件把自己搬上界面只需一件事：在 `code/ui.mjs` 里 `export register(surface, host)`，用
`surface.view/panel/action/shortcut/notificationSource/statusItem/validator` 注册并返回回执数组（示例见
`src/domain/commitments/code/ui.mjs`）。`host` = 机制：`rows/publicRows(view)`、`runPython(tool,args,{read})`、
`stage(kind,record,{name})`（0600 待办件）、`readJson`、`sharedFile`、`service`、`note`、`now`、`collab`（§10）。
**外壳不认识任何业务名词**（可声明的键见 `ui-surface.mjs` 头注释）。

## 7. 已知限制（如实登记，不假装完成）

1. **比价口径**：`compare-rank.py` 按 `quote_id` 排名，与 `bid-heuristics` 的 per-item 归一**尚未统一**
   （真源仍是 `services/compare.py`）。
2. **投递是单收件人 P0**：多 realm 时写者**明确拒绝**；登记行**追加** `items`/`envelope`/`quote_by`/`subject`。
3. **realm 与时间**：界面以账本 `realm` 为准；写者**不读墙钟**（`--now` 必填、待办件 `submitted_at` 为空）。
4. **通知/布局/已读/筛选**都是**本浏览器**的（`quotagent.notif`/`.layout`/`.filters`）—— 换浏览器要重标/重排；
   它们都不是账本事实。
5. **只读调用会被合并**：`host.runPython(tool, args, {read:true})` 同一组 `(工具, 参数)` 一次渲染只 spawn 一次、
   `python_cache_ms`（默认 3000）内复用；动作/落待办件清空缓存（`QUOTAGENT_UI_PYTHON_CACHE_MS=0` 关掉）。

## 8. 身份与会话 + 三个自助面（DEF-001/003/025/026）

业务动作不再靠「开哪个 URL」区分侧：**登录一次**，之后每个动作的身份从**会话**取（`human:<名字>`），不再手填。

| 面 | 路由 | 谁能用 | 落到哪 / 拒绝口径 |
|---|---|---|---|
| 登录·切换·登出 | `GET /identity/{,me}`、`POST /identity/{login,logout}` | 所有人 | 服务端会话 `<ui_shared>/identity/sessions.json`（**0600** 原子写）+ 不透明 cookie（HttpOnly/SameSite=Strict）；过期与登出**只减权** |
| 待我处理 | `GET /inbox/`（JSON `/inbox/api`）、`GET /<side>/inbox/` | 已登录且属于该侧 | 五类待办（待签报价/待批准/待确认中标/待回澄清/超期未回）；只列 `owed_by = human:<我>` 或 `side:<本侧>`；`?as_of=<ISO>` 给事实时刻（缺省取账本最大 `ts`，**不取墙钟**）；越侧 ⇒ `side-mismatch` |
| 人签 | `GET /sign/`、`POST /sign/{quote,award}` | 署名 == 会话身份 | 不一致 ⇒ `signer-mismatch`（账本零新增）→ 既有唯一写者；草稿只有本人能签（`not-my-draft`） |
| 邮件配置 | `GET/POST /mail/config/` | `side=ops` 且署名一致 | 干跑 → **0600 待处理项** → `config-apply.py` 写受管 YAML；**凭据永不回显** |
| 我的插件 | `GET /plugins/`、`POST /plugins/{load,unload,reload}` | 自己的命名空间 | 走 `userPluginManager`；跨命名空间 ⇒ `not-my-namespace`；装卸后重扫/撤销其 UI 贡献（规则 1） |

真跑验证（21 条身份路由、48 条断言、含四条负控；隔离数据目录起服务，不碰 `/workspace/config.yaml`）：
`bash tmp/verify-identity/run-server.sh && python3 tmp/verify-identity.py --base http://127.0.0.1:8231/quotagent`。
负控（脚本内断言）：未登录 / 署名不符 / 替别人签 ⇒ `401`·`403`·`not-my-draft` 且**账本零新增**；越侧读工作台 ⇒
`side-mismatch`；`/admin/config/` 无提权仍 `401`。

## 9. P3 可用性（通知 / 布局 / 键盘 / 对比 / 标签页；机制在外壳，插件只声明）

全是**外壳**机制（`assets/app.js`/`app.css`/`app-shell.mjs`），插件只声明（键见 `ui-surface.mjs` 头注释）。

- **通知中心**（顶栏「通知」）：徽标只数**未读**；每条可「去处理」（表单预填该对象）、「打开 <对象> →」、
  标已读/未读；筛选 全部/未读/待处理/失败 + 协作标签（§10）；只看 `warn` 以上、按插件静音；同一件事只出一条
  （`×N`），一次先给 12 条 +「还有 N 条」；轮询发现多条只弹**一条汇总**。
- **面板布局**：拖 `⠿` 换序（键盘 `Alt+↑/↓`）、`▾/▸` 收起、布局条可恢复默认；按「视图+对象类」存
  **服务端**（按身份，0600）⇒ 换浏览器、换设备仍是这套布局（见 `docs/people-and-roles.md` §5）。
- **可编辑表格**：`Tab/Shift+Tab` 走格 · `Enter`/`↑`/`↓` 走同列上下行 · `Esc` 还原 · `Ctrl/⌘+Enter` 提交；
  列带 `line_total_of` ⇒ 格旁实时 `×量 = 行合计`；面板带 `data.totals` ⇒ 编辑栏实时小计。
- **对比模式 + 列固定**：列带 `group`+`group_label`、面板带 `data.compare={min,max}` ⇒ 勾 2–3 组并排；`pin:'left'`
  ⇒ 横向滚动时关键列不跑掉；`data.group_totals` ⇒ 底部每组合计。
- **多标签页 / 最近访问**：打开地址即一个标签、`Alt+1..9` 切、`Alt+W` 关；「最近 N」/`Ctrl+E` 给最近 12 条深链。
- **身份**：顶栏「身份」看当前 `human:<名字>`/侧别，登录后**自动回原页**（`?next=`）；`signature` 与标
  `identity:true` 的字段按会话预填（细节见 §8）。

## 10. 多人协作（同侧人类之间；**不写账本**）

同一侧的两个人能把活交出去、叫人看、在对象上说话 —— 全在界面内，且**不进账本**（协同痕迹不是合同事实；理由
见 `code/collab.mjs` 文件头）。数据落 `<ui_shared>/collab/<side>.json`（目录 0700 / 文件 **0600**，原子写），
**按侧隔离**：另一侧身份读同一个对象 id 只读到**自己那侧**（0 命中，不是"过滤掉"）。

- **指派 / 转交**：任意对象页（包/报价/授标/PO/变更/审批门）工具栏「指派 / 转交给同事」→ **名册**里的人 +
  **原因（必填）+ 截止**；已有人时同一动作 = 转交（历史留痕），且只有**归我/我指派的**（或有资格的角色）能转（`transfer-not-yours`）；
  名册外的人一律拒（`unknown-colleague`）。
- **关注 + 活动流**：「关注 / 取消关注」；对象页「协作：评论与活动流」列出**谁在什么时候做了什么**与
  「关注这个对象的人」；关注**每人一份**，只影响自己的通知。
- **评论与 @同事**：正文写 `@<名字>` 即通知同侧那位；跨侧 `@` 拒（`cross-side-mentioned`），不存在的名字
  如实记进 `unresolved`（**不假装通知到了**）。
- **我的 / 我指派的 / 全部**：协作面板、**工作台待办卡**、**通知中心**都有筛选片；通知带
  `我的 / 我指派的 / @我 / 我关注的` 标签，点「打开 <对象> →」**直接进对象页**；已读**每人一份**。
- **机制**：协作面是外壳的机制贡献（「插件」面里可卸载/重建），按**插件声明的对象类**自动挂上；插件只需给
  条目/行加 `bucket`/`bucket_label`、给通知加 `tags`，动作字段标 `from_route_kind`。
  复跑：`sh tmp/p4-collab-verify.sh`（47 条断言：跨侧 0 命中、账本 md5 全程不变）。

## 11. 人员名册与角色（「同事」来自名册；**按角色限动作**；不写账本）

名册是**权威取值处**：`<ui_shared>/people/roster.json`（0700/**0600**、按侧隔离），带**角色**与**直属关系**；
`@提及 / 指派 / 转交`的候选与校验都从它来（未知名字拒）；第一次在某一侧登录 ⇒ 自动进名册（角色「待指派」=
有名字、**没有权限**）。界面：工作台/两侧视图的**「人员名册与角色」**面板 + **「名册表（逐行可改）」** +
工具栏「名册」组。**按角色限动作**（不是限视图）：转交别人的活要「归我/我指派的」或在
`transfer.override_roles` 里；额度规则超过**我角色**的额度 ⇒ `role-limit-exceeded` 并告诉你该找谁。
**角色不改变签署权**（人签仍要求署名 == 会话身份；越权一律拒且账本零新增）。
细节、接口、边界与截图见 **`docs/people-and-roles.md`**；复跑 `python3 tmp/p5-people-verify.py`（55 条断言）。
