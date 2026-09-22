# EV-190 — 业务断点与身份缺口：报价行带 `qty` · 澄清入口合并 · 业务路由身份门槛 · 按 id 找对象

<!-- budget: 8 KB（`docs/work/evidence/*.md`）；原始输出在 `tmp/`（验证脚本一并放 `tmp/`，不进树） -->

判据真源：`AGENTS.md` 规则 11/12、`docs/design/29-webui-gui-app.md` §2.2/§3/§4。缺陷登记：
`docs/work/plans/webui-ui-defects.md`（DEF-001 身份、DEF-014/015 澄清、DEF-009 授标意向）。一次跑完的原始行：
`tmp/verify42-run.txt`。

> **并发写入者**：同一工作树里有 sibling subagent 在改 UI 外壳与多个 `code/ui.mjs`（系统多处报
> `modified by sibling subagent 'sa-1-…'`）。故**验证不是在共享工作树上做的**，而是 `tmp/verify42/`＝
> `git archive HEAD` + 本批三个文件的补丁；门的冲击清单同样取自 `tmp/gatecheck/`（同一构造）。
> 兄弟写者的改动**没有**被覆盖或回退。

## 1. ① 报价行带 `qty`，「从界面提授标意向」真落账

- 断点：`rfq.responses` 的行只有 `quote_id/supplier/item_id/unit_price_cents`，**没有 `qty`** ⇒ 行内
  「提出授标意向」把空量发给唯一写者 `commitment-apply.py --step propose`，被**有名拒绝**（复现：
  `code=line-qty-invalid`、`reason=行 L-002 的 qty 不是数：None`，账本零新增）。
- 修（`src/domain/rfq/code/ui.mjs`）：增 `itemQtyIndex(rows)` —— 量只取**包事实**（`rfq/published` 的数组 `items`
  → 投递信封 `spec.items` → 逐版快照 → 最后按 `rfq/amended` 的 `deltas[field=qty]` 覆盖，**最新一版为准**）；
  行给 `qty/unit/qty_source`，读不到就 `null` 并如实标注（不填假数量），面板计数加 `qty_known`。
- 实测（`tmp/verify42-award-flow.txt`）：行 `qty=150`（来源 `rfq/amended`）→ 反向对照缺量仍 `line-qty-invalid`
  → 正向 `award.propose` `ledger_added=1`，账本 37 → 38 行，新行 `award/intent-proposed` 的 `lines` 与界面那一行
  逐字一致（`L-001/150.0/8600 分`）、`obligation=null`。界面实证：同一动作从**行内按钮**点一次真落 `awin-0003`
  （41 → 42 行）；截图 `tmp/verify42-shot-01a-row-with-qty.png`（行带数量列）与
  `tmp/verify42-shot-01b-propose-prefilled.png`（行内点开时 `数量=150` 已预填）。

## 2. ② 供应商侧重复的「提问澄清」合并成一个入口

- 重复：`domain/rfq` 的 `clarify.ask` 与 `domain/clarify` 的 `exchange.ask` 在供应商工具栏上**并排两个「提问澄清」**。
- 归属与修法：澄清域主人 = `domain/clarify`（拥有 `clarify.py`/`clarify-apply.py`/问答串面板）⇒ **删掉
  `src/domain/rfq/code/ui.mjs` 的 `clarify.ask`**，保留 `exchange.ask`；`clarify.mine` 的 `actions` 改指
  `exchange.ask`（不留空按钮）；承包商侧队列/回答/广播/关闭仍留在 `domain/rfq`。
- 实测（`tmp/verify42-clarify-entries.txt`）：含「提问澄清」的动作**恰 1 个**（`exchange.ask`/`domain/clarify`）、
  全站无 `clarify.ask`、动作 id **零重复**、面板引用的动作 id **零悬空**、`domain/rfq` 仍留 `clarify.answer|broadcast|close`。
  截图 `tmp/verify42-shot-02-supplier-toolbar.png`。

## 3. ③ 两侧静态业务路由的路由级身份门槛

- 修：`src/system/webui/code/webui.mjs` **追加**门槛（动态注册路由之后、静态业务路由之前）；判据在
  `src/system/webui/code/identity.mjs#gateBusinessRoute`（`null`＝放行，否则给有名裁决）。未登录：浏览器
  `303 → <前缀>/identity/?next=<原地址>`，API/JSON `401 identity-required` + 同一个 `next`；越侧 `403 side-mismatch`。
  **公开入口不变**：`/`、`/start/`、`/overview/`、`/identity/**`、`/inbox/**`、`/sign/**`、`/plugins/**`、
  `/api/health|status|obs|routes`、`/api/ui/**`、`/assets/**`、`/app/**`、`/ops/**`、`/admin/**`（含 `<side>/inbox/`）。
- 实测（`tmp/verify42-identity-gate.txt`，78 行全 PASS）：9 条公开入口未登录仍 200；7 条业务路由未登录两种形状都有；
  登录后本侧放行、越侧 403；`next` 回跳可用（`303 → /contractor/quotes/ → 200`）。截图
  `tmp/verify42-shot-03-side-mismatch.png`。

## 4. ④ 按 id / 关键字找对象（包 · 报价 · PO · 变更）

- 修（`src/domain/rfq/code/ui.mjs`，走**注册面**，外壳机制未改）：动作 `find.object`（contractor+supplier，工具栏
  + 命令面板）、视图页结果区 `find.inline-<view>`、对象页 `find.results-<view>`（`object_kind: find` ⇒ 可分享深链
  `/app/<view>/find/<关键字>/`）；只读 `host.rows(本视角)`，只对**本视图声明过的对象类**给链接。
- 实测（`tmp/verify42-find-object.txt`）：`pkg-g1/qg-…/chg-0001/po-0001` 各命中且带深链；`/api/ui/object` 命中；
  视图页结果区按机制级便签渲染同一批；乱写关键字 ⇒ `no-match` 零行；供应商身份只出本侧对象类。截图
  `tmp/verify42-shot-04-find-po-deeplink.png`。

## 5. 门的冲击清单（**本批没有改任何门文件**，逐条列出供本批之外处置）

身份门槛与「旧判据＝未登录也能取业务路由」直接冲突；构造 `tmp/gatecheck/`＝`git archive HEAD`+本批三个文件，
**9 个门命令由绿转红，共 63 条断言**（原始输出 `tmp/gate-*-after.txt`）：`webui` 26/52、`quote-draft` 12、
`rfq-deadline` 9、`bid-heuristics` 5、`plugin-lifecycle` 4（C2/C3/L7/L8：样板插件的只读区块「真出现在页面上」
的探针取的是业务页）、`advice` 2、`authority` 2、`gates` 2、`change-detail` 1。根因**同一个**：夹具对
`/contractor/…`、`/supplier/…` **无 cookie** 取页面/JSON（实测 `contractor=401 supplier=401`），外加少数把
`/api/routes` 的 `auth=none` 当判据的正控。`canary` **仍绿**（只比对各分流响应体，不断言 200）。

**建议修法（逐门 1–3 行，二选一）**：① 夹具先 `POST /identity/login` 拿 cookie 再取业务路由 —— 判据从
「谁能打开」变成「**登录后按侧放行**」，断言不缩水；② 按 `AGENTS.md` 规则 12 / 29 §2.2 删掉「未登录也能取业务路由」
那一族断言（它们只冻旧形态）。这 9 个门文件在被禁清单里（`host/webui.mjs` 等），故只登记不动手；
`webui` 门 26 条明细见 `tmp/gate-webui-after.txt`。

> **已处置（`EV-191`）**：9 个门全部按 ① 修好（**断言只增不减、删除 0 条**）；同一根因下另发现 **3 个门**
> （`ui-feedback`/`admin-route`/`rfq-visibility`，本清单**漏登记**）也已一并修好；另测到 4 个门的**后半**
> 被前半红遮住（`advice`/`bid-heuristics`/`authority`/`gates` 各红 6/7/8/8、`change-detail` 后半直接崩）。
> 见 `docs/work/evidence/EV-191-identity-gate-fixture-relogin.md`。

**同一构造上的「不是我造成的红」**（`tmp/basecheck/`＝纯 `git archive HEAD`，用于归因）：`storage` 红是干净副本
缺 `tmp/ui-shared` 的取样产物（基线同样红）；`p0-no-node` 与 `g1` 的 `AC-ADMIN-004`（进度数字 23/17 与复算不一致，
还有 `plugin-lifecycle` 之外的旁证）在基线同样红 ⇒ 与本批无关。`g1` 全量 AC 83/84，唯一红的就是它。

## 6. 明确没做 / 超本批范围

- `/api/routes` 表里两侧业务路由的 `auth` 仍写 `none`（本批只允许**追加**门槛）⇒ 台账与行为暂不一致。
- `/api/ui/**`（GUI 数据面）与 `/api/action/**`（动作总线）**不在**本批范围：面板数据未登录仍可读、非人签动作
  未登录仍可发起（本批只按任务范围冻结两侧静态业务路由）。
- 既有澄清重复**面板**（`clarify.mine` ↔ `exchange.threads`、`clarify.queue` ↔ `exchange.queue`）仍并存
  （本批只合并了入口；面板合并会丢信息，留下一批按同一份归属判定处理）。
