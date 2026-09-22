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
路径类开关有同名环境变量 `QUOTAGENT_UI_*`）。

打开 `http://127.0.0.1:8093/quotagent/`（前缀可配）：首屏是**工作台**（「我今天要做什么」），不是报告列表；
页面脚本**只来自本服务**（`assets/app.js`/`app.css`，源文件在 `src/system/webui/code/assets/`），不引外网 CDN、无需构建。

> 空数据目录下面板**如实报 degraded + next_action**，不编假数据。

## 1. 界面骨架（机制在外壳、功能在插件）

| 部位 | 怎么用 |
|---|---|
| 顶栏 | `工作台 / 承包商 / 供应商`（运维/管理走旧页）+ 命令面板/最近/通知/插件/身份/重载；点导航即切视图，URL 变深链 |
| 工作台（首屏） | 「**你现在该做什么**」把各插件待办汇成一张卡（warn/bad 优先 + 一键按钮/深链）+「从这里开始」四步；
下面才是插件自己的面板 |
| 对象页 | 行内「打开 →」= 该对象深链；对象页只出该对象类的面板与动作（其余收进「本视图的其它动作」）；声明
`from_route` 的入参按地址 id 预填 |
| 插件面 | 「插件」：贡献条数 / 文件 mtime / **重载**（热更）/ 卸载 / 装载 |
| 命令面板 | `⌘K` / `Ctrl+K`：列全部动作/视图/对象类，`↑↓` 选、回车即开表单 |
| 状态栏 | 插件注册的状态读数（发包/报价/授标链/比价…；>8 项收进「更多 N 项」）+ 当前视图与可复制深链 |
| 快捷键 | 外壳：`g h/c/s` 切视图、`?` 帮助、`r` 重载、`Esc` 关弹层（弹层里先回表单再关）；插件：`p` 发包、
`d` 备草稿、`c` 比价、`a` 提意向（卸载后一起消失）；通知/布局/键盘/标签页见 **§10** |
| 表格 | 可编辑列（"单价整数分 / 交期天数"）在单元格里改，改完点「提交编辑」批量提交（**键盘流转与小计见 §10**）；勾选框 + 批量按钮（"全选"只作用于**本表**）；行上右键出 `context_menu` 动作并按该行字段预填 |
| 人工门 | 需要人签的动作在标题后带 `✍`：表单里必须写 `human:<你的名字>`，执行前再确认一次 |

## 2. 供应商侧闭环（看包 → 备报价 → 人签提交 → 回读）

1. **看包**：「发给我的 RFQ 包」只出**发给自己的**那份（投递信封 `delivered_to` 不含自己就不显示）。
2. **备报价（可续草稿）**：行项目表的「单价/交期」列直接改 →「提交编辑」（或 `d`）→ 动作 **`quote.draft`**：
   校验（整数分/上下界/发言人 `human:`）→ 0600 待办件 → 唯一写者 `quote-draft.py` 落 `quote/drafted`（**非签名**）。
3. **提交（人工门：签名）**：草稿行「人签提交」→ 确认 → 动作 **`quote.submit`** → 唯一写者 `quote-sign.py` 落
   `approval/requested`→`granted`→`quote/submitted`（顺序不可颠倒），并在**承包商账本**登记一条。
4. **回读**：「已提交的报价」显示报价 id / 整数分单价 / 交期 / **签署人** / 人工门 id / 提交时刻 —— 全部来自事实行。

## 3. 承包商侧闭环（发布 RFQ → 比价 → 批准 → 授标 → 发 PO）

1. **发布 RFQ**：「发布 RFQ」（或 `p`）填包 id/标题/币种/截止/行项目（`item_id,描述,单位,数量`）/受邀 realm/
   发言人 → 确认 → 动作 **`rfq.publish`**：写者 `rfq-publish.py` 落 `rfq/published`+`rfq/distributed` + 写**投递信封**。
2. **看回应与比价**：「收到的报价」列本侧登记行；「比价排名」是动作 **`compare.rank`** 的结果：名次/得分/
   **五个分量贡献值**/引用链，权重可调（表单改 `w_price` 等；或选行批量重排）。只读工具 `compare-rank.py`
   （复用 `CompareService.rank`，**账本零新增**）；「并排对比」见 §10。
3. **授权与人工门**：「授权区间」页回答"谁能批到多少/越界怎么办"。
4. **授标意向（不产生义务）**：在「收到的报价」行上（右键或行内按钮）→ 动作 **`award.propose`** →
   唯一写者 `src/domain/commitments/tools/commitment-apply.py --step propose` 落 `award/intent-proposed`，
   并把意向写给供应商（`<ui_shared>/exchange/award-intents.json`）。
5. **供应商确认**：`供应商 → 发给我的授标意向` → 动作 **`award.confirm`**（人签）→ 自己账本 `award/confirmed`
   + 承包商账本一条同名登记。
6. **授标承诺（人签）**：**`award.commit`**（`--step commit`）门是**三样齐备**：意向仍 proposed + 供应商确认 +
   人工批准（`scope=award.commit`）→ `award/committed`。
7. **发 PO（人签）**：**`po.issue`**（`--step po`）门是"只能由承诺派生" + 逐行引用中标条目且**不得改价** + 人工批准
   （`scope=po.issue`）→ `po/issued`（`po→award→intent→quote` 链 + 行内 `basis=<quote_id>#<item_id>:unit_price`）。
8. **回读**：「授标链」把意向/确认/承诺/PO 与追溯链摆在一起；没签的那两列是空的（**不假装已承诺**）。

## 4. 动作与接口清单（机器可读）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/quotagent/`、`/app/<view>/` | GET | GUI 首屏（工作台）/ 视图地址（`home`·`contractor`·`supplier`） |
| `/app/<view>/<kind>/<id>/`、`/api/ui/object?…` | GET | **对象深链**（`kind` 由插件 `object_kind` 声明）：刷新不丢、可复制；对方视角打开 ⇒ 如实未命中 |
| `/assets/app.js`·`app.css` | GET | 客户端资源（**只来自本服务**） |
| `/api/ui/surface` | GET | 注册面自述：视图/面板/动作（schema·权限·确认策略）/快捷键/通知源/状态项 + 逐插件贡献 |
| `/api/ui/panels?view=`、`/api/ui/notifications`、`/api/ui/status`、`/api/ui/blocks?slot=` | GET | 面板数据（table/form/list/kv/metrics/html）/ 通知中心 / 状态栏 / 旧槽位区块 |
| `/api/action/<id>` | POST | **动作总线**：`{"view":"…","input":{…}}`；校验 → 插件自己的服务端一半 |
| `/api/ui/plugins`；`…/<plugin_id>/{load,reload,unload}` | GET/POST | 装载清单；**热重载**（撤贡献 → 按磁盘当前内容重新 import ⇒ 改 `code/ui.mjs` 不必重启）/ 卸载 |

动作（**服务端一半一律是**：插件校验 → 落 0600 待办件 → spawn 唯一写者；`compare.rank` 例外，它只读）：

| 动作 | 视图 | 权限 | 谁落账本 |
|---|---|---|---|
| `rfq.publish` | contractor | 确认 + `human:` 发言人 | `rfq-publish.py`（`rfq/published`、`rfq/distributed` + 投递信封/登记） |
| `quote.draft` | supplier | — | `quote-draft.py`（`quote/drafted`，两侧各一条） |
| `quote.submit` | supplier | **human-signature** | `quote-sign.py`（`approval/requested`+`granted`+`quote/submitted`） |
| `compare.rank` | contractor | — | **不写账本**（`CompareService(ledger=None)`） |
| `award.propose` | contractor | — | `commitment-apply.py --step propose`（`award/intent-proposed` + 意向信封） |
| `award.confirm` | supplier | **human-signature** | 同上 `--step confirm`（`award/confirmed`，两侧各一条） |
| `award.commit` | contractor | **human-signature** | 同上 `--step commit`（`approval/*` + `award/committed`） |
| `po.issue` | contractor | **human-signature** | 同上 `--step po`（`approval/*` + `po/issued`） |

等价命令行（同一套唯一写者；拒绝时账本零新增），例如

```bash
python3 src/domain/<插件>/tools/<写者>.py --step <步骤> --request <0600待办件> --now … --ui-shared …
```

## 5. 写路径纪律（GUI 不是第二条事实写路径）

- 动作只**发起**：外壳校验入参 → 插件的**服务端一半** → 落 **0600 待办件** → spawn **唯一写者**；写者复核
  （0600 + 普通文件 + 重算哈希 + 业务门）才落账本；
- 对外承诺（提交报价/授标承诺/发 PO）**必须人签**且签名者 = 会话身份（§9）：`--actor human:<名字>` 交给写者，
  `agent:` 一律拒；人工门记录与承诺事件同一次落账（INV-005）。

## 6. 卸载一个注册了 UI 的插件（可撤销）

```bash
# 撤销一个插件的全部 UI 贡献（视图/面板/动作/快捷键/通知源/状态项 + 旧槽位区块）
curl -s -X POST 'http://127.0.0.1:8093/quotagent/api/ui/plugins/domain%2Frfq/unload'
```

卸载后：该插件的入口（含快捷键与右键菜单项）在界面与 `/api/ui/surface` 里**同时消失**，其余插件的面板
**逐字节不变**（可对照 `/api/ui/panels?view=…` 指纹）。恢复 `POST …/{load,reload}`（§4，**不必重启**）；
`plugin.json` 类插件走 `/admin/api/user-plugins/{load,unload,reload}`。

插件把自己搬上界面只需一件事：在自己的 `code/ui.mjs` 里 `export register(surface, host)`，用
`surface.view/panel/action/shortcut/notificationSource/statusItem/validator` 注册并返回回执数组：

```js
export async function register(surface, host) {
  return [surface.panel({ plugin_id: 'domain/x', id: 'my.panel', title: '我的面板', view: 'contractor',
    order: 10, kind: 'table', data: () => ({ ok: true, kind: 'table', columns: [...], rows: host.rows('contractor') }) })]
}
```

`host` = 机制：`rows/publicRows(view)`、`runPython(tool,args,{read})`、`stage(kind,record,{name})`（0600 待办件）、
`readJson`、`sharedFile`、`service`、`note`、`now`。**外壳不认识任何业务名词**（声明面可声明的键见
`ui-surface.mjs` 头注释：含 §10 的 `pin/group/totals/compare` 与通知的 `ref/preset/action`）。

## 7. 已知限制（如实登记，不假装完成）

1. **比价口径**：`compare-rank.py` 按 `quote_id` 排名，与 `bid-heuristics` 的 per-item 归一**尚未统一**
   （真源仍是 `services/compare.py`）。
2. **投递是单收件人 P0**：多 realm 时写者**明确拒绝**；登记行**追加** `items`/`envelope`/`quote_by`/`subject`。
3. **realm 与时间**：界面以账本 `realm` 为准；写者**不读墙钟**（`--now` 必填、待办件 `submitted_at` 为空）。
4. **通知/布局/已读**都是**本浏览器**的：通知队列有界（100+200）且已读存在 localStorage（`quotagent.notif`），
   面板布局同理（`quotagent.layout`）—— 换浏览器要重标/重排；它们都不是账本事实。
5. **只读调用会被合并**：`host.runPython(tool, args, {read:true})` 的同一组 `(工具, 参数)` 一次渲染只 spawn
一次、`python_cache_ms`（默认 3000）内复用；动作/落待办件清空缓存（`QUOTAGENT_UI_PYTHON_CACHE_MS=0` 关掉）。

## 8. 验收怎么复现（仓库内脚本）

```bash
python3 src/system/webui/tools/gui-walkthrough.py --base <base>    # 双闭环走查
python3 src/system/webui/tools/gui-readback.py --shared tmp/ui-shared
python3 src/system/webui/tools/gui-unload.py --base <base>         # 卸载 UI 后对照其余部分
```

三个脚本**不写账本**（只读 HTTP/账本文件）。手工复现：改任一 `code/ui.mjs` → 顶栏「插件」→「重载」（§4）。

## 9. 身份与会话 + 三个自助面（DEF-001/003/025/026）

业务动作不再靠「开哪个 URL」区分侧：**登录一次**，之后每个动作的身份从**会话**取（`human:<名字>`），不再手填。

| 面 | 路由 | 谁能用 | 落到哪 / 拒绝口径 |
|---|---|---|---|
| 登录·切换·登出 | `GET /identity/{,me}`、`POST /identity/{login,logout}` | 所有人 | 服务端会话 `<ui_shared>/identity/sessions.json`（**0600** 原子写）+ 不透明 cookie（HttpOnly/SameSite=Strict）；过期与登出**只减权** |
| 待我处理 | `GET /inbox/`（JSON `/inbox/api`）、`GET /<side>/inbox/` | 已登录且属于该侧 | 五类：待签报价 / 待批准 / 待确认中标 / 待回澄清 / 超期未回；只列 `owed_by = human:<我>` 或 `side:<本侧>`；`?as_of=<ISO>` 给事实时刻（缺省取账本最大 `ts`，**不取墙钟**）；越侧 ⇒ `side-mismatch` |
| 人签 | `GET /sign/`、`POST /sign/{quote,award}` | 会话身份与署名一致 | **署名 == 会话身份**（不等 ⇒ `signer-mismatch`，账本零新增）→ 既有唯一写者（`identity-sign.py`→`quote-sign.py`；`identity-confirm.py`→`--step confirm`）；草稿只有本人能签（`not-my-draft`） |
| 邮件配置 | `GET/POST /mail/config/` | `side=ops` 且署名一致 | 干跑 → **0600 待处理项** → 唯一落盘者 `config-apply.py` 写受管 YAML；**凭据永不回显**（页面只给键名 / 来源 / 有无值） |
| 我的插件 | `GET /plugins/`、`POST /plugins/{load,unload,reload}` | 自己的命名空间 | 走既有管理面 `userPluginManager`；跨命名空间 ⇒ `not-my-namespace`；装卸后重扫/撤销其 UI 贡献（规则 1） |

```bash
# 真跑验证（21 条身份路由、48 条断言，含四条负控）：隔离数据目录起服务（不碰 /workspace/config.yaml）
bash tmp/verify-identity/run-server.sh && python3 tmp/verify-identity.py --base http://127.0.0.1:8231/quotagent
```

负控（脚本内断言）：未登录 / 署名不符 / 替别人签 → `401`·`403`·`not-my-draft` 且**账本零新增**；
越侧读工作台 → `side-mismatch`；`/admin/config/` 无提权仍 `401`。

## 10. P3 可用性（通知 / 布局 / 键盘 / 对比 / 标签页；机制在外壳，插件只声明）

全是**外壳**机制（`assets/app.js`/`app.css`/`app-shell.mjs`），插件只声明（可声明的键见 `ui-surface.mjs` 头注释）。

- **通知中心**（顶栏「通知」）：徽标只数**未读**；每条可「去处理」（表单已预填该对象）、「打开 <对象> →」（对象
  深链）、标已读/未读；「全部标已读」；筛选 全部/未读/待处理/失败；只看 `warn` 以上、按插件静音；同一件事只出
  一条（`×N`），一次先给 12 条 +「还有 N 条」；轮询发现多条只弹**一条汇总**（不刷屏）。
- **面板布局**：拖 `⠿` 换顺序（键盘 `Alt+↑/↓`）、`▾/▸` 收起、布局条可恢复默认；按「视图+对象类」存
  `quotagent.layout` ⇒ 刷新后仍在（换浏览器要重排）。
- **可编辑表格**：`Tab/Shift+Tab` 走格 · `Enter/Shift+Enter`、`↑/↓` 走同列上下行 · `Esc` 还原 · `Ctrl/⌘+Enter`
  提交；列声明 `line_total_of` ⇒ 格旁实时 `×量 = 行合计`；面板声明 `data.totals=[{label,key,factor,unit,count,
  skip_empty}]` ⇒ 编辑栏实时小计。
- **对比模式 + 列固定**：列带 `group`+`group_label`、面板带 `data.compare={min:2,max:3}` ⇒ 列组勾选框（勾 2–3 家
  并排，无 `group` 的关键列恒显示）；`pin:'left'` ⇒ 横向滚动时关键列不跑掉；`data.group_totals={key\|key_prefix,unit}`
  ⇒ 底部每组合计；`best_when:'min'` ⇒ 本行最低标绿。
- **多标签页 / 最近访问**：打开地址即一个标签、`Alt+1..9` 切、`Alt+W` 关、行内「钉成标签页」；顶栏「最近 N」/
  `Ctrl/⌘+E` 给最近 12 条对象深链 +「继续 →」（浏览器占了 `Ctrl+W`/`Ctrl+1..9`，故用 `Alt`）。
- **身份**：顶栏「身份」看当前 `human:<名字>`/侧别，登录后**自动回到刚才那一页**（`?next=`）；`signature` 与插件标
  `identity:true` 的字段按会话预填。身份属 A 侧却开 B 侧视图时顶部黄条如实说明（业务视图不按身份鉴权 —— 既有
  `auth:none` 口径，人签仍被服务端按会话拒）：**这不是鉴权，是如实告知**。
