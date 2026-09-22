# WebUI 用法（GUI 应用外壳 + 双方闭环）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = **完整 GUI 应用**，不是账本投影/只读路由）。 -->

本页只讲**怎么用**：一条命令起服务、人怎么在浏览器里走完两条业务闭环、每个动作落到哪条账本、
以及动作/接口清单与已知限制。机制与规则见 `docs/design/29-webui-gui-app.md` 与
`docs/design/27-plugin-architecture.md` §6。

## 0. 一条命令起服务（人类可用）

```bash
# 仓库根
./run up                      # 起 WebUI（默认 http://127.0.0.1:8093/quotagent/），幂等：已经在跑就返回 already-up
./run status                  # 健康 + 端口 + 日志路径
./run logs                    # 看最近日志（含插件贡献装载结果）
./run down                    # 停服务
```

其它入口（等价，便于测试不同端口/数据目录）：

```bash
# 直接起工作区服务脚本（环境变量覆盖端口/账本路径）
QUOTAGENT_WEBUI_PORT=8207 ./run up --port 8207 --host 127.0.0.1 --data-dir tmp/gui-run

# 或直接跑宿主 CLI（不起 seed 时最干净）
QUOTAGENT_WEBUI_SEED=0 QUOTAGENT_WEBUI_SEED_PIPELINE=0 \
QUOTAGENT_UI_SHARED=$PWD/tmp/gui-run \
QUOTAGENT_UI_LEDGER_CONTRACTOR=$PWD/tmp/gui-run/contractor/ledger.jsonl \
QUOTAGENT_UI_LEDGER_SUPPLIER=$PWD/tmp/gui-run/supplier/ledger.jsonl \
QUOTAGENT_UI_RFQ_DELIVERY=$PWD/tmp/gui-run/contractor/01-package.json \
node host/cli.mjs webui --profile webui --port 8207 --host 127.0.0.1 --prefix /quotagent \
  --ledger-contractor tmp/gui-run/contractor/ledger.jsonl \
  --ledger-supplier tmp/gui-run/supplier/ledger.jsonl \
  --ui-shared tmp/gui-run --rfq-delivery tmp/gui-run/contractor/01-package.json
```

打开 `http://127.0.0.1:8093/quotagent/`（前缀可配）：首屏是**工作台**（「我今天要做什么」），
不是报告列表。页面上的脚本**只来自本服务**（`/quotagent/assets/app.js` / `app.css`，
源文件在 `src/system/webui/code/assets/`），**不引任何外网 CDN**，也不需要构建步骤。

> 新起的服务/空数据目录下，面板会**如实报"还没有数据 + next_action"**（degraded），不会编一行假数据：
> 第一件事就是按 `p` 发布一个 RFQ（或直接看第 2/3 节的两条闭环）。想看有数据的界面：
> `python3 src/system/webui/tools/gui-walkthrough.py --base http://127.0.0.1:8093/quotagent`
> （仓库内走查脚本：只发 HTTP 请求，双闭环全走一遍）。

## 1. 界面骨架（机制在外壳、功能在插件）

| 部位 | 怎么用 |
|---|---|
| 顶栏导航 | `工作台 / 承包商 / 供应商`（+ 运维/管理走旧页）；点即切视图，URL 变深链 |
| 工作台（首屏） | 各插件注册的"待办"面板：待人签的草稿、待回应的包、待人工门、比价头名 |
| 命令面板 | `⌘K` / `Ctrl+K`：列全部动作（插件注册什么就有什么），回车即执行/开表单 |
| 通知中心 | 顶栏「通知」：动作结果（含失败原因与 `next_action`）+ 插件通知源 + 待人工门队列 |
| 状态栏 | 底栏：插件注册的状态读数（发包数/报价数/授标链/比价）+ 当前视图与深链 |
| 命令面板外的快捷键 | 外壳：`g h`/`g c`/`g s` 切视图、`?` 帮助、`r` 重载、`Esc` 关弹层；插件：`p` 发布 RFQ、`d` 备报价草稿、`c` 比价、`a` 提授标意向（卸载插件后这些键一起消失） |
| 表格 | 可编辑列（供应商备报价的"单价整数分 / 交期天数"）直接在单元格里改，改完点「提交编辑」批量提交；左侧勾选框 + 批量按钮（比价表：选中几家单独排；备报价表：批量备草稿） |
| 右键菜单 | 在表格行上右键 → 该视图注册了 `context_menu` 的动作（如「人签提交报价」「提出授标意向」），并把该行的字段预填进表单 |
| 人工门 | 需要人签的动作在标题后带 `✍`：表单里必须写 `human:<你的名字>`，执行前再确认一次 |

## 2. 供应商侧闭环（看包 → 备报价 → 人签提交 → 回读）

1. **看包**：`供应商 → 工作台/供应商`的「发给我的 RFQ 包（只出自己那份）」面板列出**发给自己的**包与行项目
   （数据来源：投递信封 `<ui_shared>/contractor/01-package.json`；`delivered_to` 不含自己就不显示）。
2. **备报价（可续草稿）**：在行项目表的「单价（整数分）/交期（天）」列里直接改 →「提交编辑（备报价草稿）」
   （或按 `d` 打开表单，多行文本/多行编辑都行）。这一步调动作 **`quote.draft`**：
   字段级校验（`quote-prepare` 插件的规则表：整数分、上下界、发言人必须 `human:`）→ 落**一条 0600 待办件**
   → 跑唯一写者 `src/domain/quote-prepare/tools/quote-draft.py` 落 `quote/drafted`（**非签名动作**，两侧各一条）。
3. **提交（人工门：签名）**：在「我的草稿（待签署）」行上点「人签提交」→ 表单里填 `human:<你的名字>` +
   确认 → 调动作 **`quote.submit`** → 唯一写者 `tools/quote-sign.py` 落
   `approval/requested` → `approval/granted` → `quote/submitted`（顺序不可颠倒），并在**承包商账本**登记一条
   「供应商已提交报价」。
4. **回读**：「已提交的报价（提交结果回读）」面板显示报价 id / 整数分单价 / 交期 / **签署人** / 人工门 id /
   提交时刻 —— 全部来自账本事实行。

## 3. 承包商侧闭环（发布 RFQ → 比价 → 批准 → 授标 → 发 PO）

1. **发布 RFQ**：`承包商 → 工作台`的「发布 RFQ」动作（或快捷键 `p`）填包 id / 标题 / 币种 / 报价截止 /
   行项目（每行 `item_id,描述,单位,数量`）/ 邀请对象（realm）/ 发言人（`human:`）→ 确认 → 动作
   **`rfq.publish`**：唯一写者 `src/domain/rfq/tools/rfq-publish.py` 落 `rfq/published` + `rfq/distributed`，
   并把**投递信封**写给被邀供应商（同时在被邀方账本写一条投递登记 —— 收件人据此备报价）。
2. **看回应与比价**：「收到的报价」面板列出本侧登记行；「比价排名（贡献可解释）」面板是
   动作 **`compare.rank`** 的结果：名次 / 得分 / **五个分量各自的贡献值**（单价、交期、付款条件、质保、偏差计数）/
   引用链。**权重可调**：在动作表单里改 `w_price` 等五个权重（或选中若干行后点批量「用这组权重重排」）。
   服务端一半跑只读工具 `src/domain/compare/tools/compare-rank.py`，它复用
   `src/domain/compare/code/compare.py` 的 `CompareService.rank`（同权重同名次；**账本零新增**）。
3. **授权与人工门**：「授权区间」页（旧页仍在）回答"谁能批到多少/越界怎么办"；本轮走查的金额在角色区间内。
4. **授标意向（不产生义务）**：在「收到的报价」行上（右键或行内按钮）→ 动作 **`award.propose`** →
   唯一写者 `src/domain/commitments/tools/commitment-apply.py --step propose` 落 `award/intent-proposed`，
   并把意向写给供应商（`<ui_shared>/exchange/award-intents.json`）。
5. **供应商确认**：`供应商 → 发给我的授标意向` → 动作 **`award.confirm`**（人签）→ 自己账本 `award/confirmed`
   + 承包商账本一条同名登记。
6. **授标承诺（人签）**：`承包商 → 授标与订单 → 授标承诺（人签）` → 动作 **`award.commit`**
   （`--step commit`）：门是**三样齐备**——意向存在且仍 proposed + 有供应商确认 + 人工批准记录
   （`approval/requested` → `approval/granted`，`scope=award.commit`）→ 落 `award/committed`（承诺类事件）。
7. **发 PO（人签）**：动作 **`po.issue`**（`--step po`）：门是"PO 只能由承诺派生" + 逐行引用中标条目且**不得改价**
   + 人工批准（`scope=po.issue`）→ 落 `po/issued`（带 `po → award → intent → quote` 追溯链与每行
   `basis=<quote_id>#<item_id>:unit_price`）。
8. **回读**：「授标链（四种事实行一屏）」面板把意向 / 供应商确认 / 承诺 / PO 与追溯链摆在一起；
   没有签的那两列就是空的（**不假装已承诺**）。

## 4. 动作与接口清单（机器可读）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/quotagent/` | GET | GUI 首屏（工作台） |
| `/quotagent/app/<view>/[<panel>/]` | GET | 深链（`home` / `contractor` / `supplier`） |
| `/quotagent/assets/app.js`、`app.css` | GET | 客户端资源（**只来自本服务**） |
| `/quotagent/api/ui/surface` | GET | 注册面自述：视图/面板/动作（入参 schema、权限、确认策略）/快捷键/通知源/状态项 + 逐插件贡献清单 |
| `/quotagent/api/ui/panels?view=<view>` | GET | 面板数据（通用形状：table/form/list/kv/metrics/html） |
| `/quotagent/api/ui/notifications` | GET | 通知中心（含失败原因与 `next_action`、待人工门） |
| `/quotagent/api/ui/status` | GET | 状态栏项 |
| `/quotagent/api/ui/blocks?slot=page.<view>` | GET | 旧槽位注册面装配出的区块 HTML（外壳按槽位嵌入） |
| `/quotagent/api/action/<id>` | POST | **动作总线**：`{"view":"…","input":{…}}`；校验 → 插件自己的服务端一半 |
| `/quotagent/api/ui/plugins/<plugin_id>/unload` | POST | 撤销一个插件的**全部** UI 贡献（可卸载；见 §6） |

动作（`id` → 服务端一半 → 谁落账本）：

| 动作 | 视图 | 权限 | 服务端一半 | 落账本者（唯一写者） |
|---|---|---|---|---|
| `rfq.publish` | contractor | 确认 + `human:` 发言人 | 落 0600 待办件 → spawn | `src/domain/rfq/tools/rfq-publish.py`（`rfq/published`、`rfq/distributed` + 投递信封/投递登记） |
| `quote.draft` | supplier | — | 插件 `validate()` → 落待办件 → spawn | `src/domain/quote-prepare/tools/quote-draft.py`（`quote/drafted`，两侧各一条） |
| `quote.submit` | supplier | **human-signature** | 落待办件 → spawn | `src/domain/quote-prepare/tools/quote-sign.py`（`approval/requested`+`granted`+`quote/submitted`） |
| `compare.rank` | contractor | — | spawn（**只读**） | 不写账本（`compare-rank.py` 用 `CompareService(ledger=None)`） |
| `award.propose` | contractor | — | 落待办件 → spawn | `src/domain/commitments/tools/commitment-apply.py --step propose`（`award/intent-proposed` + 意向信封） |
| `award.confirm` | supplier | **human-signature** | 落待办件 → spawn | 同上 `--step confirm`（`award/confirmed`，两侧各一条） |
| `award.commit` | contractor | **human-signature** | 落待办件 → spawn | 同上 `--step commit`（`approval/*` + `award/committed`） |
| `po.issue` | contractor | **human-signature** | 落待办件 → spawn | 同上 `--step po`（`approval/*` + `po/issued`） |

等价命令行（与界面同一套写者；拒绝时账本零新增）：

```bash
python3 src/domain/rfq/tools/rfq-publish.py --request <0600待办件> --now 2026-09-22T10:00:00Z \
  --ui-shared tmp/gui-run --ledger-contractor tmp/gui-run/contractor/ledger.jsonl \
  --ledger-supplier tmp/gui-run/supplier/ledger.jsonl --delivery tmp/gui-run/contractor/01-package.json
python3 src/domain/commitments/tools/commitment-apply.py --step commit --request <0600待办件> \
  --now 2026-09-22T10:00:00Z --ui-shared tmp/gui-run \
  --ledger-contractor tmp/gui-run/contractor/ledger.jsonl --ledger-supplier tmp/gui-run/supplier/ledger.jsonl
python3 src/domain/compare/tools/compare-rank.py --ui-shared tmp/gui-run \
  --ledger-contractor tmp/gui-run/contractor/ledger.jsonl --package-id pkg-gui --weights price=1,delivery=0
```

## 5. 写路径纪律（GUI 不是第二条事实写路径）

- 动作只**发起**：外壳把入参校验一遍，然后交给插件自己的**服务端一半**；
- 写动作一律：**落一条 0600 待办件**（含 `payload_sha256` / `bytes` / 空 `submitted_at`）→ **spawn 唯一写者**；
- 唯一写者自己再复核一遍（权限 0600 + 普通文件 + 重算哈希 + 业务门），通过才落账本；
- 对外承诺（提交报价 / 授标承诺 / 发 PO）**必须人签**：界面上的 `signature` 会作为 `--actor human:<名字>`
  交给写者；写者的门不接受 `agent:`（GUI 上被字段级校验拦下，命令行上被 `human-required` 拦下）；
- 人工门记录（`approval/requested` → `approval/granted`）与承诺事件同一次落账完成，顺序不可颠倒（INV-005）。

## 6. 卸载一个注册了 UI 的插件（可撤销）

```bash
# 撤销一个插件的全部 UI 贡献（视图/面板/动作/快捷键/通知源/状态项 + 它注册的旧槽位区块）
curl -s -X POST 'http://127.0.0.1:8093/quotagent/api/ui/plugins/domain%2Frfq/unload'
curl -s -X POST 'http://127.0.0.1:8093/quotagent/api/ui/plugins/userspace%2Fdemo-ns%2Fhello/unload'
```

卸载后：该插件的入口（含快捷键与右键菜单项）在界面与 `/api/ui/surface` 里**同时消失**，
其余插件的面板**逐字节不变**（可对照 `/api/ui/panels?view=…` 的指纹）。重新装载：
插件贡献在**服务启动时**发现式装载（扫描 `src/{system,domain}/*/code/ui.mjs` 与
`src/userspace/*/*/code/ui.mjs`），重启服务即可恢复；`plugin.json` 里的插件走既有装卸面
（`tools/plugin.sh`、`/admin/api/user-plugins/{load,unload,reload}`）。

插件把自己搬上界面只需一件事：在**自己的** `code/ui.mjs` 里 `export register(surface, host)`，
用 `surface.view/panel/action/shortcut/notificationSource/statusItem/validator` 注册，并返回回执数组：

```js
export const plugin_id = 'domain/<我的插件>'
export async function register(surface, host) {
  return [
    surface.panel({ plugin_id, id: 'my.panel', title: '我的面板', view: 'contractor', order: 10, kind: 'table',
      data: () => ({ ok: true, kind: 'table', columns: [{ key: 'x', label: 'X' }], rows: host.rows('contractor') }) }),
    surface.action({ plugin_id, id: 'my.do', title: '做一件事', views: ['contractor'], input: { fields: [] },
      server: async (ctx, input) => ({ ok: true, code: 'done' }) }),
  ]
}
```

`host` 给的是**机制**：`rows(view)`（本视角账本行）、`publicRows(view)`（投影白名单行）、`runPython(tool, args)`
（跑 Python 侧唯一写者/只读工具）、`stage(kind, record, {name})`（落 0600 待办件）、`readJson(path)`、
`sharedFile(name)`、`service(name)`、`note`（内存便签）、`now()`。**外壳不认识任何业务名词**。

## 7. 已知限制（如实登记，不假装完成）

1. **比价的候选口径**：`compare-rank.py` 按 `quote_id` 逐条排名（本走查里同一供应商的 L-001/L-002 是两条候选），
   与 `bid-heuristics` 的"同一行项目内才互相比较"（`per-item` 归一）**尚未统一** —— 单包多行项目的
   严格同项比较是 P1（口径真源仍是 `services/compare.py`）。
2. **投递是单收件人 P0**：`rfq-publish.py` 的**投递登记**只写一条（邀请多家时需要按 realm 分发；
   多 realm 时写者会明确拒绝，不猜写给谁）。
3. **供应商 realm 命名**：走查里发布方账本 realm = `contractor:gui`，被邀方 = `supplier:g1`；
   既有 `quote-draft.py` 在 body 里会写它自己的默认 supplier 串（历史行为），界面显示以账本 `realm` 为准。
4. **`rfq/distributed` 的投递登记**在既有字段之外**追加**了 `items` / `envelope` / `quote_by` / `subject`
   （不改既有键语义，读旧键的代码不受影响）。这是 P0 让"收件人据此备报价"能成立所必需的；按
   `AGENTS.md` 规则 8，若被认定为账本格式变更，应由主 agent 补一条 ADR。
5. **时间口径**：写者**不读墙钟**（`--now` 必填、待办件 `submitted_at` 必须为空）；`--now` 由宿主给出
   （界面上的动作时间 = 宿主的 `new Date()`）。`rfq/*` 事实行的 `ts` 由既有 `RfqService` 内的 `utc_now()` 打。
6. **通知中心**是"最近一次动作结果 + 插件通知源"的队列（有界 100 条动作 + 200 条通知），不是持久化信箱。

## 8. 验收怎么复现（仓库内脚本）

```bash
# ① 起服务（见 §0），② 双闭环走查（只发 HTTP 请求）
python3 src/system/webui/tools/gui-walkthrough.py --base http://127.0.0.1:8093/quotagent
# ③ Python 侧回读账本（逐行原始行）
python3 src/system/webui/tools/gui-readback.py --shared tmp/ui-shared
# ④ 卸载一个注册了 UI 的插件并对照页面其余部分
python3 src/system/webui/tools/gui-unload.py --base http://127.0.0.1:8093/quotagent
```

三个脚本都**不写账本**：①③④ 只读 HTTP / 只读账本文件，② 只发动作请求（落账本的是各插件的唯一写者）。
