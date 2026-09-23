# 预填的硬上限 · 勾选语义 · 行对象字段自查（P22 实测）

<!-- 预算：16 KB（`src/*/*/docs/*.md`）。口径真源：`docs/design/29-webui-gui-app.md`（§4 全流程、§19 批量人签）；
     规矩真源：`row-action-prefill.md`（行对象字段 ≠ 外壳取值名）；机制真源：外壳 `code/assets/app.js`。
     本页只讲 **P22 实测的三件真缺口**（预填一个必然被拒的包 / 勾选语义看不见 / 行对象字段对不上）与复跑。
     读数与截图：`tmp/p22-shots/`（§5 复跑命令）。只改插件 `code/ui.mjs` 与 `plugin.json`；外壳**一字未改**。 -->

## 0 一句话

三件事都是**插件侧**能修的、且都用真跑证明过：① 「备报价」不再预填一个**必然被拒**的包（本侧事实的包目录
有硬上限 64 个，而「我的包」按定义就是最新那个）；② 勾选语义（本页已选 N / 全命中已选 M）与「选中全部命中行」
**真的显示在界面上**（P20 写的那段话写在 `data.note` 里，而 table 面板的 `data.note` **不渲染** ⇒ 用户看不到）；
③ 全插件扫一遍「行对象的键名 vs 外壳按字段名取值」，修掉两处真缺口（多行报价的三列、`from_rev`）。

## 1 预填不会预填一个必然被拒的包（`LIMITS.max_items = 64`）

**机制事实**：`domain/quote-prepare` 的校验用的目录由 `buildCatalogue(payloadOf(host, 'supplier'))` 算，
**包 id 目录与行项目目录都硬截在 `LIMITS.max_items = 64`**（`quote-prepare.mjs:243`）；而面板「发给我的 RFQ 包」
读的是**投递信封**（按定义 = 最新那个包）。⇒ 包数一旦 >64，**界面自动预填一个它自己会拒的包**
（服务端按同一份目录判 `rfq-not-found`）。

**修前实测**（70 个包的私有夹具 `tmp/p22-run`）：
面板 `quote.package` 的 `editable_defaults.rfq_id = P22-PKG-070`（最新那个）；点「提交编辑」→「执行」⇒
`validation-failed / L-001: 第 1 行 rfq_id:RFQ P22-PKG-070 不在本视角的事实里（本视角已知 64 个：…）`，
账本零新增。截图：`p22-390-01-before-prefill.png`（表单里预填着 070）、`p22-390-02-before-refused.png`（具名拒绝）。
另有一条同类死路：这块表还声明了 `bulk: 'quote.draft'`，而批量按钮的 presets 只有 `{ids, rows}` ⇒
必填的 `rfq_id` 谁也填不上（实测 `rfq_id=required：必填` + 单价/交期 `below-min`，`p22-390-03-before-bulk-empty-rfq.png`）。

**修法**（`src/domain/quote-prepare/code/ui.mjs`，只动这一个插件）：
`referenceablePackages(host)` 用**与 `validate()` 同一个函数**算出"本侧真的认得哪些包"；预填与备报价入口
（`editable_action`/`editable_defaults` 与版式里的 `editable`）**只在认得时才给**：认不得 ⇒ 面板 `degraded`
+ 有名 `reason = package-not-in-visible-facts` + 给出能引用的包 id + **不预填**；那两个可编辑面板上的 `bulk`
**删掉**（可编辑表的「提交编辑」本来就是"整张表一次提交"那条路 —— 删的是一颗按下去必然被拒的按钮，不是功能）。
面板 `hint` 写明这条口径（`hint` 是**渲染出来**的那句，见 §3）。

**修后实测**：同一夹具同一页 —— 面板顶上「降级（不冒充健康） `package-not-in-visible-facts`」+ 下一步写明
「这一份包（P22-PKG-070）不在其中 ⇒ 现在提交必被拒…能作 RFQ 引用的包：P22-PKG-001 / …（共 64 个）」，
表里**没有**可编辑框、没有提交按钮（截图 `p22-390-04-after-no-prefill.png`）；对象页多一条事实
「可作 RFQ 引用：否 —— 不在本侧事实的包目录里（目录上限 64 个包）」（`p22-390-06-…png`）。

**反向对照**（`≤64` 时口径一字未变，`python3 tmp/p22-shots/small-fixture-check.py` 6/6 PASS）：
3 个包的夹具 `tmp/p22-small` 上，面板**不降级**、`editable_defaults.rfq_id = P22-PKG-003`（最新那个）、
带上回执给的版本指纹后 `quote.draft` **真落账**（`code=drafted`，供应商侧账本 +1 行；重跑按草稿 id 幂等）。

**边界（如实登记）**：本批**没动** `quote-prepare.mjs` 的 `max_items`（那不是本批可改面，且改它就是改判据）；
所以"让最新那个包也能备报价"仍然做不到 —— 面板只能说清"为什么现在不行、哪些能行"。「我收到的包」面板
（`domain/clarify`）按自己的行做认收/回文承诺，不受这条预填影响。

## 2 勾选语义真的显示出来，且「选中全部命中行」真能送出全部命中

**界面上的两个数字**（外壳 `app.js`）：提交按钮 = `批量人签提交（…）（已选 X 行）`；跨页选择存在时计数行多一句
`已跨页选中 M 行`，并给 `选中全部命中行（命中数）` 与 `取消选择` 两颗按钮。即 **M = 全命中已选**、
**X = 本页勾的 + 跨页选中的**（只跨页选、本页没勾时按钮写成 `已选 0（含跨页共 M）行`）。

**P22 真跑（390px，`tmp/p22-run`）**：筛「首行单价 8000–8300」⇒ **命中 30 行 / 每页 10 / 共 3 页**
→ 点「选中全部命中行（30）」⇒ 计数行写「**已跨页选中 30 行**」、按钮写「已选 0（含跨页共 30）行」、
表单写「批量：30 行」⇒ 一次署名提交 ⇒ 抓包 `ids` **恰好 30 个**（与手算的命中集**同集合**），
两侧账本各 +30 条 `quote/submitted`、30 条 `approval/granted`（同一批注）。
读数：`tmp/p22-shots/crosspage-out.txt`、`crosspage-submitted-ids.json`、`crosspage-check.json`。

**这一轮修的是"说清"那一半**：`quote.drafts` 面板的 `hint` 现在逐字描述上面那两个数字与那颗按钮（含"换筛选
条件会自动作废跨页选择"、"本块含已签署的历史行"、一次上限 50）。**外壳侧已在 P21 收口**（本页 P22 只登记）：
手工勾选**跨页保留**（按面板记）、翻回来复选框**回填勾选态**、勾过的行带底色；翻页**不弹 toast**（用计数行说话）。
P25 真跑复核（105 行 / 5 页）：勾 2 行 ⇒ 翻到第 2 页（本页 0 勾、按钮「已选 0（含不在本页共 2） 行」、
计数行「已勾选 2 行」）⇒ 翻回第 1 页那 2 行**仍是勾选态**、按钮「已选 2 行」
（截图 `tmp/p25-shots/p25-after-02-crosspage-check.png`）；四条插件文案也按这个事实改了口
（`p25-truth-and-short-viewport.md` §2）。

## 3 一条外壳事实：`hint` 会渲染，`data.note` 不会（table 面板）

P20 把「勾选不跨页」那段话写在面板的 `data.note` 里 —— 而 `renderTable` 只在**没有行**时把 `data.note` 当
`next_action` 用（`app.js:1461`），正常有行时**一个字节都不显示**。真正会被渲染的是注册时的 **`panel.hint`**
（`app.js:1932`，`esc()` 转义 ⇒ 里面写 markdown 记号会原样显示）。本批把预填口径与勾选语义都搬进 `hint`。
顺带的口径：`data.degraded/reason/next_action` 会渲染成「降级（不冒充健康）」块 —— 所以面板要**如实降级**
比藏起来好（§1 就用它）。

## 4 全插件自查：行对象的键名 ≠ 外壳按字段名取值

**规矩**（`row-action-prefill.md`）：行内/批量动作的每个字段，**只能按自己的 `name` 在那一行里取值**
（`app.js#openAction` 的 `presets` = 那一行的整对象；批量路径的 presets 只有 `{ids, rows}`）；取不到就是空字段 ——
值明明在屏幕上，用户却要手抄，或者这一步在界面上**做不完**。

**可重跑的脚本**：`python3 tmp/p22-shots/check-row-fields.py --base http://…` —— 扫**全部视图**的面板
（`/api/ui/panels`）+ 从面板行里现取对象 id 再扫**对象页**（`/api/ui/object`），逐个字段判"行里能不能取到值"，
输出 `必填挡住`（required 且取不到 = 用户被空字段挡住）与 `可选手填` 两档清单 + JSON 留档。
本轮覆盖面：3 视图 · **223 块面板** · **71 个对象页** · 逐字段 **125 处**（读数 `row-fields-check.json`）。

**本批修掉的真缺口（判据 = 外壳真取到了值）**：

| 面板 · 动作 · 字段 | 修前 | 修后（浏览器实测的表单字段值） |
|---|---|---|
| `exchange.requote-rail` · `exchange.requote-now` · `item_id`/`unit_price_cents`/`lead_time_days`（三个都必填） | **一份报价 = 一整张表**（29 §7.5）之后，账本里的标量键是空的（`"item_id": ""`、`"unit_price_cents": null`）⇒ 三个空框 + 必填 | 行里回落到**首行**并新增「行数」列 ⇒ `item_id=L-001`、`unit_price_cents=8010`、`lead_time_days=8`（`p22-390-07/08-*.png`） |
| `exchange.rev-versions` · `exchange.rev-amend` · `from_rev` | 行里的键叫 `rev`（就是表格那一列）⇒ 空 | 行里补 `from_rev` ⇒ 两条路径（行内 / 可编辑表）都取到 |
| `quote.package`/`package.mine` · 批量 `quote.draft` · `rfq_id`（必填） | 批量按钮的 presets 填不上 ⇒ 必填挡在提交前 | 删掉那两颗 `bulk` 按钮（§1） |

**如实登记、本批不修**：`authority.check`/`authority.escalate` 的 `amount`/`approvers`/`ref`（动作的主语是
"这一笔钱"，不是那行配置；且 `tools/verify.sh authority` 的判据要求这两块面板各带这两个动作）；
`exchange.ask/promise` 的 `question`/`note`/`due_at` 与 `rfq.remind` 的 `letter`（**要人写的话 / 未来时刻**，
`row-action-prefill.md` §3 的例外）；`people.roster-*` 与 `export.prefs-*`（**不在本批可改面**）。
逐条清单：`tmp/p22-shots/row-fields-before.txt` 与 `row-fields-check.json`。

## 5 会话身份的预填不能在「还没读到身份」时静默失效（P52）

**P51 实测的形态**（截图 `tmp/p51-shots/35-供应商确认授标-表单.png` 与同一次会话的
`36-供应商确认授标-回执.png` 对照）：`award.confirm` 的表单里 `signature` **是空的**、顶栏徽标写着
**「未登录」**，而同一个会话紧接着提交**成功**（回执那张截图里徽标已是 `wangjie`）。同一次会话、同一个身份，
差别只在**表单打开的时刻**。

**机制事实**：会话身份是客户端**异步**读一次的（`app.js#loadIdentity()` → `GET /identity/me`，页面装载时发起；
徽标由它回来之后 `renderChrome()` 更新），而署名预填（`field.type === 'signature'` / `identity: true`
⇒ 填 `human:<会话身份>`）发生在 `app.js#openAction()` 里。两者之间没有先后保证：表单开得早（或页面被
**bfcache 还原**、或在别的标签页登录过再回来）⇒ `state.identity` 还是空 ⇒ 字段空着，用户**必须手抄自己的
名字**，还要先撞一次 `required：必填`。这不是人签判据的问题（服务端一字不松），而是**界面的预填漏了一次**。

**修法**（外壳，`code/assets/app.js#openAction`）：动作只要有 `signature` / `identity: true` 字段、而
`state.identity` 还是空 ⇒ **先把身份读回来**（`await loadIdentity()`，只读一次，不缓存坏结果）**再渲染表单**；
读到了就照旧按会话身份预填，读不到就照旧空着（**这是"不知道"，不是"没登录"** —— 绝不代签、绝不编一个名字）。
于是徽标、署名、发言人这三处从同一份读数来，不会再出现"表单里是空的、徽标却已经是某某"。

**读数（P52 真跑）**：正常路径（行内 / 工具栏 / 引导区）四条入口的 `signature` 都预填 `human:<会话身份>`
（含 `award.confirm` / `po.acknowledge`）；把 `/identity/me` 在装载期挡掉一次（复现"打开表单时还不知道身份"）
—— 修前 `signature` 空、修后仍是 `human:<会话身份>`。原始读数与截图见 `tmp/p52-shots/REPORT.md`。

**边界**：预填**只是省手抄**；`signature` 必须等于会话身份这条服务端判据一条没松（`quote-draft` 门与
`identity` 路由的负控照旧：错署名 `signer-mismatch`、未登录 `identity-required`、账本零新增）。

## 6 复跑

```bash
sh tmp/p22-shots/start.sh 8491 $(pwd)/tmp/p22-run          # ① 规模夹具（70 个包 > 上限 64）
python3 tmp/p22-shots/seed-scale.py --port 8491 --pkgs 70 --gates 0   # 造包：第 65 个起备报价必被拒（修前读数）
python3 tmp/p22-shots/crosspage-check.py                   # ② 把界面真送出的 30 个 id 与命中集逐元素对账
python3 tmp/p22-shots/check-row-fields.py --base http://127.0.0.1:8491/quotagent   # ④ 全插件字段自查清单
sh tmp/p22-shots/start.sh 8492 $(pwd)/tmp/p22-small         # ③ 反向对照（≤64：预填照旧、真能提交）
python3 tmp/p22-shots/seed-scale.py --port 8492 --pkgs 3 --gates 0
python3 tmp/p22-shots/small-fixture-check.py
tools/verify.sh webui && tools/verify.sh quote-draft        # 门（本轮：47/47 · 16/16）
```
