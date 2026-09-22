# WebUI UI 缺陷清单（UI Defects）

<!-- budget: 48 KB。判据出处：AGENTS.md §11–12 + docs/design/29-webui-gui-app.md §1/§4。配套规格：webui-workflow-and-ui-spec.md（步骤编号 C1–C11 / S1–S10 / G1–G8 与之一致） -->

## 0. 这份清单怎么用

- **定义**（29 §4 末句 / §5.4）：凡是用户在真实工作流里**必须回终端才能做完**、或**根本做不到**的步骤，一律算 **UI 缺陷**。
- **严重度**：**P0** = 阻断「一条真实闭环」（29 §5.1 的 P0 范围：外壳 + 注册面 + 供应商「看包→备报价→签名提交」与承包商「发布 RFQ→比价→批准→授标」）；**P1** = 阻断双方流程里的某个必需步骤；**P2** = 可用性/一致性/误导性呈现。
- **每条四个字段**：**用户想做什么** → **现在只能怎么做**（卡在哪一步、是回终端还是根本做不到）→ **期望** → **证据**（路由或源码路径；均为 2026-09-22 对 `127.0.0.1:8093` 的实测或仓库内路径）。
- **总账**：36 条缺陷（P0 12 · P1 17 · P2 7）。**21 个业务步骤里，界面内能独立做完的只有 1 步（S4 备报价草稿，且只支持单行）**；6 步只能看；2 步必须回终端；12 步连入口都没有（含终端）。

| 严重度 | 条数 | 编号 |
|---|---|---|
| P0 | 12 | DEF-001 … DEF-012 |
| P1 | 17 | DEF-013 … DEF-029 |
| P2 | 7 | DEF-030 … DEF-036 |

---

## 1. P0 —— 阻断一条真实闭环

### DEF-001 · P0 · 业务视角完全没有身份与会话（没人知道"这是我做的"）

- **用户想做什么**：以「承包商采购员 王磊」或「供应商销售 陈敏」的身份登录，看到**属于自己**的待办，并且自己签的字能落到自己名下。
- **现在只能怎么做**：做不到。`/contractor/**` 与 `/supplier/**` 全部路由是 `auth: 'none'`（实测 70 条路由中 31 条业务路由免鉴权、15 条 admin 路由才鉴权）；全站唯一身份是管理员 token（`POST /admin/api/elevate`，cookie 只对 `/admin/**` 生效）。业务数据靠"开哪个 URL"区分，不靠"我是谁"。
- **期望**：业务用户登录 ⇒ 会话绑定 `human:<name>`；视角与身份强绑定（供应商身份打开 `/contractor/**` 或对方深链一律拒绝，不得回落到"能看"）；页面顶部显示当前身份并可切换/登出；签名动作的 `actor` 从会话取，不由表单填。
- **证据**：`src/system/webui/code/webui.mjs` 路由表 `auth` 字段（`auth: 'none'` 31 处 / `admin-session`|`token` 15 处）；`POST /quotagent/admin/api/elevate` 的 cookie 作用域只到 `${prefix}/admin/**`（`webui.mjs:2196-2200`）；`tools/quote-sign.py` 要求 `--actor human:<名字>` 由人手敲参数。

### DEF-002 · P0 · 没有应用外壳：找不到功能、没有通知、没有深链、没有快捷键

- **用户想做什么**：打开就能看到"今天我要处理什么"，一条待办直接点进去办；多个事项并行时开多个标签页；用键盘和命令面板快速跳转；把某个包的链接发给同事。
- **现在只能怎么做**：靠一个平铺的 `nav`（总览 / 上手 / 承包商视角 / 供应商视角 / 运维视角 / 系统管理 / 两个 API 链接），页面正文是若干折叠的账本表格。没有左导航、没有待办徽标、没有通知中心、没有命令面板、没有快捷键、没有面包屑与标签页、没有可分享深链。
- **期望**：应用外壳 = 顶栏（视角切换/全局搜索/通知铃/命令面板/身份）+ 左导航（按岗位模块分组 + 待办徽标）+ 主区（面包屑 + 多标签页）+ 右侧上下文面板（实体详情/事实时间轴/下一步建议）+ 底部状态栏（待办门数/账本校验/连接/事实时刻）+ 命令面板（`Cmd/Ctrl+K`）+ 通知中心；槽位扩到 `page.<view>.<module>`；布局持久化。
- **证据**：`webui.mjs:61-70`（`html()` 只拼接 `<nav>` + 标题 + 正文 + 6 条 CSS 规则）；槽位闭合集合只有 5 个：`SLOTS = ['page.home','page.contractor','page.supplier','page.ops','page.admin']`（`src/system/webui/code/ui-slot.mjs:30`）；无 `/api/notifications`；实测 8 个页面 `script=0`。

### DEF-003 · P0 · 人工门在界面上"不可签"，其中四个连终端入口都没有

- **用户想做什么**：在这五个动作上，像其他系统一样在界面上确认并签字：**批准 / 提交报价 / 定标（授标承诺）/ 发 PO / 变更批准**。
- **现在只能怎么做**：报价提交能回终端（`tools/quote-sign.py`），另外四个**连终端也没有入口**（`src/**/tools/*.py` 里没有 approve / award-commit / po-issue / change-approve 消费者）；`ApprovalService.decide` / `CommitmentGate.commit_award` / `issue_po` / `ChangeService.approve` 只被测试与走查脚本调用。页面上给的是"请复制下面这条命令到终端"（报价准备页写死「**本 APP 不代签**」），或干脆没有按钮。
- **另外**：`/api/routes` 的 `write_surface.note` 逐字写着「浏览器永远不能签的五个动作：批准 / 提交报价 / 定标 / 发 PO / 变更批准（人工门在终端）」——这条口径正是本缺陷要改的。
- **期望**：界内签名 `SignAction`（外壳机制 + 插件声明策略）：显示**签什么**（对象/金额（整数分）/币种/行数/事实时刻 `as_of`）、**载荷指纹 sha256**（同时保留可复制的终端等价命令）、**我是谁**（`human:<name>` + step-up）、**后果**（产生对外义务、不可撤销）；服务端一半校验会话 → 生成签名记录 → 调用**同一个**唯一写者（29 §3 的"唯一写者"不变，GUI 不得成为第二条写路径）；`agent:*` 一律拒。
- **证据**：`webui.mjs:1848-1862`（`prepSignatureHtml`，带 `data-signature-required="1"`、`data-can-sign`）；`webui.mjs:2556-2560`（`write_surface`）；`src/domain/quote-prepare/tools/quote-sign.py`（唯一带人签的门）；`src/system/approval/code/approval.py:143`（`decide` 要求 `by` 为 `human:*`）；实测 `POST /contractor/approvals/ap-0001/decide 404`、`POST /contractor/award/commit 404`、`POST /contractor/po/issue 404`、`POST /contractor/changes/chg-0001/approve 404`。

### DEF-004 · P0 · 承包商不能创建/发布 RFQ（整条流程的起点不存在）

- **用户想做什么**：把工地材料申请变成一条可询价的包：填包名/主题/币种/报价与澄清截止、编辑若干行项目（`item_id`/qty/单位/规格引用）、勾选邀请的供应商，然后**发布**（发新版时同理），并看到"哪些供应商收到了、谁没回、还差多久"。
- **现在只能怎么做**：UI 里没有这个入口（实测 `GET /contractor/rfq/ 404`、`POST /contractor/rfq/publish 404`、`POST /contractor/rfq 404`、`POST /contractor/rfq/pkg-x/invite 404`）。唯一的替代是终端跑 `python3 -m quotagent.g1side contractor tmp/manual 1`，而它**硬编码** `pkg-g1`、写死 2 条行项目（L-001×120m、L-002×480kg）与唯一收件人 `supplier:g1` —— 换个材料就得改代码。
- **期望**：建包向导（包信息 → **可编辑行项目表格**：加删行/拖拽排序/粘贴 TSV/复制上次的包 → 邀请供应商多选）+ 服务端权威校验（`package-id-exists` / `deadline-not-future`（截止须晚于本视角 `as_of`）/ `item-duplicate` / `invited-empty` / 行数与邀请数上下界）+ 提交后 `202` + 待办件面板（id/落点/可复制 `next_action`）+ 发布需**人签**（对外承诺）；包列表页与单包详情页（条目表 / rev 历史 / 变更点 / 已回未回名单 / 事实时间轴）。
- **证据**：能力真源 `RfqService.create_package/draft/add_items/update_draft/validate/publish/distribute`（`src/domain/rfq/code/rfq.py:100/122/127/137/187/195/286`）；覆盖率与缺口 `sourcing.coverage/gaps/expiring`（`src/domain/sourcing/code/sourcing.mjs:75/117/128`）**零 UI 消费者**；替代走查 `src/quotagent/g1side.py:122-131`。

### DEF-005 · P0 · 供应商看不到自己的包详情（只有首页一行汇总）

- **用户想做什么**：打开"我收到的包"，看每条行项目的**规格与数量**、附件、`@rev` 历史与本次变更点，据此判断能不能报、报多少。
- **现在只能怎么做**：只能在首页看到一行投递事实（实测 `data-rfq="inbox"`、`data-rfq-count="1"`、`pkg-g1 @rev1`、`2 条（L-001×120m、L-002×480kg）`）。没有包列表页（`GET /supplier/rfq/ 404`），没有详情页：`spec_ref`、附件、rev 差异都看不到；投递信封也只出白名单字段。多包时 `rfq_delivery_max=8` 会把其余截断成 `omitted`，没有分页或"查看更多"。
- **期望**：「我收到的包」列表（状态徽标：`未见`/`已认收`/`草稿`/`已准备提交`/`已被新版作废`）+ 包详情页（条目表含规格 / rev 历史与差异高亮 / 附件清单 / 我的进度条 / 截止倒计时按**事实时刻**）+ 可分享深链 + 分页或"查看全部（N）"。
- **证据**：投递事实投影与字段白名单 `webui.mjs:337-351`、`webui.mjs:2100-2120`；`rfq_delivery_max` 默认 8（`webui.mjs:56`）；口径文档 `docs/design/26-rfq-delivery-visibility.md`。

### DEF-006 · P0 · 供应商备报价只能"一行一次"，交不出一份多行报价

- **用户想做什么**：把整份报价（一个包 2–50 行，每行单价/交期/备注）一次填完、一次提交、随时续填。
- **现在只能怎么做**：`/supplier/quotes/prepare/` 的表单是**单行**（字段 `rfq_id`/`item_id`/`unit_price_cents`/`lead_time_days`/`prepared_by`/`currency`/`note`，`quote-prepare.mjs:110-123`）⇒ 2 行条目就要提交 2 次，系统里也没有"一份报价 = 多行"的对象；而且提交只落 `0600` 待办件，**还需回终端**跑 `tools/quote-draft.py --now <ISO>` 才落 `quote/drafted`。
- **期望**：**行项目表格编辑器**（每行 = 一个条目，列 = 单价（整数分）/交期/备注；一次提交整张表；行内校验红框 + 字段级文案；实时小计；`Tab`/`Enter` 键盘流转；未保存离开拦一次；元→分换算提示防 ×100 错），提交后由服务端一半直接驱动唯一写者落账（守卫自进化产物时不得留"必须回终端"的第二步）。
- **证据**：`src/domain/quote-prepare/code/quote-prepare.mjs:110-123`（`FIELDS` 只有单个 `item_id`/`unit_price_cents`/`lead_time_days`）；`webui.mjs:1865-1890`（`prepPageHtml` 单表单）；实测 `POST /supplier/quotes/prepare/ 202`（`id=qd-supplier-87c9f2b5bdea`）后返回的 `next_action` 明确要求跑 `tools/quote-draft.py`。

### DEF-007 · P0 · 提交报价必须回终端（S5 签名不在界内）

- **用户想做什么**：草稿备好后，在界面上核对"报什么价、什么交期、给哪个包、哪几行"，输入一次确认（step-up）完成签名提交，并立刻在承包商侧看到这条报价。
- **现在只能怎么做**：复制页面上的命令，切到终端手敲 `tools/quote-sign.py --draft-id qd-… --actor human:chenmin --approval … --now <ISO>`；`POST /supplier/quotes/submit` 返回 **404**（刻意不提供）。页面写死「**本 APP 不代签**」。
- **期望**：签名对话框（§DEF-003 的四段式）→ 服务端一半发 `approval/requested`→`granted`→`quote/submitted`（顺序不可颠倒；无批准记录的提交路径是 INV-005 禁止项）→ 返回增量（本侧状态、承包商侧可见、需刷新的视图）；事后可查"我签过什么"。
- **证据**：`src/domain/quote-prepare/tools/quote-sign.py`（`--actor` 必须 `human:` 前缀，`--draft-id` 必须真在供应商账本里，`--now` 必填）；`webui.mjs:1848-1862`；实测 `POST /supplier/quotes/submit 404`。

### DEF-008 · P0 · 承包商不能批准/驳回/要变更（审批队列只能看）

- **用户想做什么**：在审批队列里看到"这批多少、等了多久、卡在谁手里、超时策略是什么"，然后**批准**（附意见）或**驳回**，或者"我要变更"退回重做。
- **现在只能怎么做**：只能看。`GET /contractor/approvals/ 200`（当前 0 条待批）；`POST /contractor/approvals/ap-0001/decide 404`；终端也没有 decide 入口（`ApprovalService.decide` 只在测试与走查里被调用，走查脚本 `g1side.py:186` 自己发请求、自己批，`approvers=[HUMAN]` 写死）。页面上唯一能点的是「催办」，而它只落一条 `0600` 待办件、**还要回终端**跑 `tools/gate-nudge.py` 才落账。
- **期望**：审批队列（门卡片：待批对象/金额（整数分）/卡点/等待时长（按**事实时刻**）/超时策略倒计时）+ **界内签名批准** + 驳回并附意见（逐字落 `approval/granted.comment`）+「要变更」（→ 变更单）+ 催办（可催、显示"已催 N 次 @ts"）+ 升级到下一角色（`authority.fallback_role`）+ 终止；已决定的门不允许再催（`gate-already-decided`）。
- **证据**：`src/system/approval/code/approval.py:97/143/164/199`（`request`/`decide`/`queue_view`/`sweep`）；`src/domain/gate-timeline/tools/gate-nudge.py`（`gate/nudged`，body 恰 5 键；`gate-already-decided`）；实测 `POST /contractor/gates/nudge 404 gate-not-found`。

### DEF-009 · P0 · 承包商不能授标（连"无义务的意向"都提不了）

- **用户想做什么**：比价定了之后，先提一个**可撤回、无义务**的授标意向让对方知道，等对方确认后再做**授标承诺**（人签）。
- **现在只能怎么做**：四个入口全没有（实测 `GET /contractor/award/ 404`、`POST /contractor/award/intent 404`、`POST /contractor/award/commit 404`）；终端也没有（`CommitmentGate.commit_award` 唯一调用者是 `g1side.py:184-188`，它把"请求批准 + 决定 + 承诺"**一口气做完**，`approvers=[HUMAN]` 写死 —— 这不是给人签的门）。
- **期望**：授标轨道视图（意向 → 审批 → 承诺 → PO 四段，每段显示事实 ts 与卡点）；「提意向」/「撤回意向」两个**无义务**动作必须真能点（撤回后按钮回到"未提意向"，可复提）；意向详情（行级快照/金额/`payload_sha256`）；「承诺」= 界内签名（`supplier_confirmed` 为假时明示"等对方确认"，撤回的意向要重提 —— `intent-not-active`）。
- **证据**：`src/domain/commitments/code/commitments.py:70/83/101`（`intent`/`withdraw`/`commit_award`，均须过 `ctx.approval`）。

### DEF-010 · P0 · 承包商不能发 PO（逐行可追溯的采购单无处签发）

- **用户想做什么**：承诺成立后按中标行开 PO，每一行都能看到"引用的是哪条中标报价的哪个条目、单价基准是什么"，签发后再能随时点回去追溯整条链路。
- **现在只能怎么做**：做不到。实测 `GET /contractor/po/ 404`、`POST /contractor/po/issue 404`、`GET /contractor/po/po-0001/ 404`；`CommitmentGate.issue_po` 无任何 CLI 消费者。
- **期望**：PO 列表（`po_id`/`award_id`/行数/`trace_mode`（`full`|`ref-only`）/签发事实 ts）+ **签发预览页**（逐行来源链可点进报价与变更单，行内显示 `basis`；单价与中标价不一致直接报 `po-line-price-mismatch`）+ 签发 = 界内签名；签发后导出/打印（P2）；**不提供**"我已经发了 PO"自报按钮（事实只能在账本里）。
- **证据**：`src/domain/commitments/code/commitments.py:136/192`（`issue_po` 先判派生 `po-not-derived` / `po-line-not-derived` 再判批准；`trace()`）。

### DEF-011 · P0 · 承包商收不到"可受理"的报价（没有收件箱、没有受理动作）

- **用户想做什么**：按包分组看收到的报价（供应商/金额/币种/提交时刻/是否已被新版作废），逐行核对，然后**受理 / 退回 / 要求补件**（可批量），退回的理由要能传到供应商侧。
- **现在只能怎么做**：只能看一张**原始账本行表**（实测 `GET /contractor/quotes/ 200`，4338 B：不按包分组、无状态徽标、无作废标记），没有任何动作：`POST /contractor/quotes/receive 404`、`POST /contractor/quotes/<id>/review 404`。`QuoteBook` 的 `superseded` / `open_requote_requests` 语义零 UI 呈现。
- **期望**：报价收件箱（按包分组 + 状态徽标 + 已作废高亮 + 行级明细抽屉（逐行单价/交期/条款/偏差））+ 受理/退回/要补件按钮（批量，逐条返回结果）+ 退回理由（≤500 字，`need-info` 时必填）+ `quote-superseded` 时给"按最新 rev 重报"链接；同一动作在供应商侧有一条可断言的可见变化（不含承包商内部备注）。
- **证据**：`src/domain/quotes/code/quotes.py:44/62/97/101/105/112`；`webui.mjs` 的 `SUBVIEWS.contractor` 只声明 `quotes` 为只读子视图（`webui.mjs:77-80`）。

### DEF-012 · P0 · 承包商不能比价（没有比较矩阵、贡献分解与导出）

- **用户想做什么**：把同一包的几份报价摆成一张表（行=条目，列=供应商，单元格=单价/行总价/与最低价差%），调五个权重看名次怎么变，点开"为什么它排第一"看贡献分解与偏差标记，最后导出 CSV 留档。
- **现在只能怎么做**：只能打开 `/contractor/heuristics/?w_price=0.6` —— **改 URL 参数就能重排**，但那是 `bid-heuristics` 插件的**算术演示**（不落任何事实、无供应商列、无对比矩阵）；`POST /contractor/compare 404`、`POST /contractor/compare/export 404`。`CompareService` / `ExportService` / `DeviationService` / `GuardService` **全部零 UI 消费者**。
- **期望**：比较矩阵（可拖拽换序/固定/隐藏列、按单元格排序、勾 2–3 家进对比模式）+ 权重滑块与数字输入双向绑定并即时重算（页首自述"临时视图，未保存"）+「保存权重为事实」+ 每项贡献分解 + 偏差面板（`kind`/`family`/`diffs`）+ 被排除报价的原因 + `导出 CSV`（页脚写 `source=eval:<id>` 与行数，可与事实逐行核对）。
- **证据**：`src/domain/compare/code/compare.py:66/140/200/211/220/243`；`src/domain/deviation/code/deviation.py:51/122/140/161/167`；`src/domain/guard/code/guard.py:76/92/206`；`src/domain/export/code/export.py:39/76/84/107`；现页 `webui.mjs:636-810`。

---

## 2. P1 —— 阻断双方流程里的必需步骤

### DEF-013 · P1 · 承包商不能催报（"哪几家还没回"看得到，催不动）

- **想做什么**：截止前 24h 勾选未回的供应商，一键催报（含模板与包信息），并记录"已催 N 次"。
- **现在只能怎么做**：做不到。实测 `POST /contractor/deadlines/notify 404`；`RfqService.remind`（`rfq.py:348`）**零调用者**；`rfq-deadline` 插件的 `can_send=false`，页面自述"本页**不能替你发信**"。
- **期望**：未回名单上的**批量催报**（勾选 → 催报）+ 催报弹窗（模板变量）+ 行内"已催 N 次 @ts"徽标 + 催报历史；邮件通道未配置时显式 `mail-transport-unavailable` 并给"导出通知正文（可复制）"，**绝不假装已发**。
- **证据**：`src/domain/rfq/code/rfq.py:348`；`src/domain/sourcing/code/sourcing.mjs:128`（`expiring`）；`webui.mjs:1361-1367`。

### DEF-014 · P1 · 承包商侧没有澄清工单页，答疑无处进行

- **想做什么**：看到供应商的提问工单，回答（须以 `human:*` 身份），并把答复**广播**给在册供应商。
- **现在只能怎么做**：做不到 —— **承包商侧那一页根本不存在**（`SUBVIEWS.contractor` 只有 `events/quotes/approvals/evidence`，`webui.mjs:77-80`）；实测 `GET /contractor/clarifications/ 404`、`POST /contractor/clarifications/ct-0001/answer 404`、`POST /contractor/clarify/ct-0001/broadcast 404`。走查脚本的做法是**往共享目录写一个 JSON 文件**（`g1side.py:138`），由人工搬运。
- **期望**：承包商侧工单队列（待答/已答/已关闭 + 未答时长）+ 线程视图（问题/条目引用/答复/广播对象）+ 回答框 + **一键广播**（默认全集；逐个取消时按钮上显示"将漏掉 N 家"，否则 `broadcast-incomplete` 并列出缺谁）+ 答复模板库（P2）+ FAQ 沉淀（`publish(by=…)` 须 `human:*`）。
- **证据**：`src/domain/clarify/code/clarify.py:55/82/111/134`；`src/domain/faq/code/faq.py`；`webui.mjs:77-80`。

### DEF-015 · P1 · 供应商不能提问澄清（看得到历史，问不出去）

- **想做什么**：就某几条行项目提问（"支吊架含不含在报价范围内？"），在澄清截止前发出，并看到承包商的答复。
- **现在只能怎么做**：只能看 `/supplier/clarifications/` 的 2 条历史；实测 `POST /supplier/clarifications/ask 404`、`POST /supplier/clarify 404`。
- **期望**：新建工单表单（`package_id` + `rfq_rev` + 条目多选引用（≥1 项）+ 问题 ≤500 字 + 字数提示）+ 线程视图（我侧 `open → answered` 时答复正文可见）+ FAQ 复用（已回答版本跨 rev 复用要给"按该版本重新提问"的明确指引）。
- **证据**：`src/domain/clarify/code/clarify.py:55`（`ask`，含 `clarify-ref-missing`）；FAQ 版本纪律 `src/domain/faq/code/faq.py`。

### DEF-016 · P1 · 供应商不能认收（"我收到了，会报"这句话说不出）

- **想做什么**：看完包点一下"我已收到 @revN"，让对方知道我不是没看见。
- **现在只能怎么做**：做不到。实测 `POST /supplier/rfq/pkg-x/ack 404`；没有任何认收类事实被消费。
- **期望**：包详情页顶部一个大按钮「我已收到 @revN」（可选备注、`rev-out-of-range` 校验）+ 徽标变化 + **承包商侧未回名单里我从"未回"变"已认收"**（双向可断言）；认收可撤销（P2，留痕）。
- **证据**：`src/domain/rfq/code/rfq.py:328`（`deadline_status` 的已回/未回口径）；实测 404。

### DEF-017 · P1 · 供应商不能改报（RFQ 出新 rev 后看不到作废、也没法重报）

- **想做什么**：承包商把量改了（`@rev2`），我能看到"我的 rev1 报价已被作废"，并按新版**预填**重报。
- **现在只能怎么做**：做不到。实测 `POST /supplier/quotes/q-1/amend 404`；没有任何页面呈现 `superseded` / `requote-requested`；包详情页都不存在，更谈不上 rev 差异高亮。
- **期望**：包详情页 rev 差异高亮（哪几行量变了）+「按 revN 重报」按钮（**预填，不自动提交**）+ 报价状态轨（`active`/`superseded`/`requote-requested`）；旧 rev 提交被拒时给 `rev-stale` + "按最新 rev 重填"链接。
- **证据**：`src/domain/quotes/code/quotes.py:62/105/108/112`（`on_amended`/`open_requote_requests`/`is_superseded`/`exclude_superseded`）；`src/domain/rfq/code/rfq.py:220/393`（`amend`/`deltas`）。

### DEF-018 · P1 · 承包商不能提出变更，也不能批准变更（价格让步无处走）

- **想做什么**：把"现场追加 20m"变成一条可追溯的变更单（原量×原价只读、只改量、给出单价基准引用），走人工门批准后生效。
- **现在只能怎么做**：只能看明细（`GET /contractor/changes/chg-0001/ 200`）；提出与批准都没有入口（`POST /contractor/changes 404`、`POST /contractor/changes/chg-0001/approve 404`）。**最刺眼的一处**：`/contractor/api/gates` 的 `changes[chg-0001].next_action` 直接给出一条**终端命令** `PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3` —— 产品在页面上教用户回终端。
- **期望**：变更列表 + **逐行差异编辑器**（原单价×原量只读 → 只让改量 → 实时 `before/after/delta`，整数分口径写清）+「提出变更」（无义务，可真写，`no-op-change` 校验）+「批准变更」= 界内签名（`approved_by` 须 `human:*`）+ 缺 `basis_unit_price_ref` 的行明示"未纳入小计"且不可勾选。
- **证据**：`src/domain/change/code/change.py:54/119/145/163`；`webui.mjs` 的 gates 页 `next_action` 渲染；实测 404 两项 + `chg-0001` 页 200。

### DEF-019 · P1 · 供应商看不到变更单，也不能回应（接受/异议）

- **想做什么**：收到变更请求，看逐行差异（新量、差额），然后**接受**或**异议**（附理由），让承包商侧看到我的回应。
- **现在只能怎么做**：`GET /supplier/changes/chg-0001/` 返回 **404**（虽然回的是 5377 B 的 HTML 页面，状态码仍是 404）；`POST /supplier/changes/<id>/respond` 不存在。
- **期望**：供应商侧变更列表 + 逐行明细页（与承包商同口径：原单价×原量 → 新量 → 差额；`money_unit=cents`）+ 接受/异议表单（`dispute` 时 `note` 必填；缺基准的行不可勾选）+ **承包商侧**增加一行"供应商回应：接受/异议 @ts"，`api/gates` 的 `owed_by` 相应变化。
- **证据**：实测 `GET /supplier/changes/chg-0001/ → 404`；`src/domain/change/code/change.py:187/192`（`get`/`list`）。

### DEF-020 · P1 · 双方都不能谈判（只有三个计数）

- **想做什么**：进入协商：提交一轮报价/条件（`move` + 理由）、发让步请求、反提案、接受或关闭；随时知道"还能让多少"和"还剩几轮"。
- **现在只能怎么做**：只能看计数（`GET /supplier/api/negotiation 200`，461 B：「只给计数」threads/rounds/rejected）；动作全无（实测 `POST /supplier/negotiate/round 404`、`POST /supplier/negotiate/counter 404`）。超界错误（`ConcessionLimitExceeded`/`ConcessionBelowFloor`/`ConcessionOutOfBand`/`RoundLimitExceeded`/`NegotiationRoundConflict`）根本用不上，因为没有入口。
- **期望**：谈判线程视图（轮次时间轴：谁在何时让了什么）+ **让步边界条**（当前值 / 我的底线 / 政策上限三色）+ 提交轮次与反提案表单 + 接受/拒绝/关闭 + 「还差几轮」；超界必须说明**越界多少、边界来自哪条策略**（不是一句"不允许"）；轮次上限给"申请加轮"（走人工门）。
- **证据**：`src/domain/negotiation/code/negotiation.py:382/429/448/474/518/555/562`、`derive_bounds:194`；`webui.mjs:2171-2176`（谈判计数块）。

### DEF-021 · P1 · 供应商不能承诺交期（没有产能日历，也没有冲突提醒）

- **想做什么**：报价时承诺交期，先看产能日历够不够；如果和其他承诺撞期要立刻知道；已经定下的交期不能被人偷偷改。
- **现在只能怎么做**：做不到。实测 `GET /supplier/capacity/ 404`、`POST /supplier/capacity/commit 404`。`CapacityService.commit/amend/feasibility/conflict_flags/firm_dates` 与 `Calendar` 全部零 UI 消费者。
- **期望**：产能日历热力图（按天：可用/已承诺/冲突）+ 承诺表单（实时可行性试算）+ 冲突告警条（可点进冲突的那个承诺）+「改期」留痕表单（`FirmDateImmutable`：已定交期不可直接改，只能改期并产生新 revision）。
- **证据**：`src/domain/capacity/code/capacity.py:53/67/112/139/181/216/239`。

### DEF-022 · P1 · 供应商看不到中标/落标结果，也不能确认中标或 PO

- **想做什么**：中标后收到通知、确认接受（并说明能否按期）；落标后知道"本次未中选"（不含别人的报价信息）；PO 签发后确认收到。
- **现在只能怎么做**：全都没有。实测 `GET /supplier/award/ 404`、`POST /supplier/award/aw-0001/confirm 404`、`POST /supplier/po/po-0001/confirm 404`；全仓 `grep 落标` **零命中** —— "落标通知"这个概念在代码里都不存在。
- **期望**：「我的授标」列表（意向 → 待确认 → 已确认 → PO 已签发）+ 确认表单（`declared_by` + 能否按期；`supplier_confirmed=true` 且 `can_meet_due=false` 时**要求备注非空**，避免"确认了又交不了货"）+ **落标通知**（一句话 + 原因类别 + 可申诉入口 P2）+ PO 确认视图；我在页面上确认后，承包商侧的授标轨道能继续走下去（双向闭环）。
- **证据**：`src/domain/commitments/code/commitments.py:101`（`commit_award(supplier_confirmed=…)`）、`:20-21`（`award/committed`/`po/issued`）。

### DEF-023 · P1 · 审批队列不能升级/终止；催办还要回终端才落账

- **想做什么**：门等太久了，我要催办、升级到有权限的角色、或者直接终止；并且事后能看到"谁在什么时候催过哪个门"。
- **现在只能怎么做**：只能点半下「催办」，它落一条 `0600` 待办件就结束，**必须再回终端**跑 `tools/gate-nudge.py --now <ISO>` 才落 `gate/nudged`（实测 `POST /contractor/gates/nudge 404 gate-not-found`，当前无待批门）。升级与终止没有任何入口：`ApprovalService.sweep`（`approval.py:199`）实现了 `remind`/`escalate`/`abort` 三种超时策略，但既无 UI 也无 CLI；`authority.fallback_role`（升级兜底角色）只在授权区间页被"读出来"，没有被任何动作消费。
- **期望**：门卡片上的三个动作「催办 / 升级 / 终止」都是界内真动作（落待办件 → 同进程消费者落账，不需要用户切窗口）；升级按 `authority.fallback_role` 给出下一步角色与可复制说明；终止必须留理由并落明细；催办历史（"已催 N 次 @ts"）可回读；已决定的门不允许再催（`gate-already-decided`）。
- **证据**：`src/system/approval/code/approval.py:199`；`src/domain/gate-timeline/tools/gate-nudge.py`；`webui.mjs` 的 `gates` 页与 `write_surface`。

### DEF-024 · P1 · 供应商侧的"登记回文承诺"实际不可用（同一份包，首页看得见、承诺说不存在）

- **想做什么**：今天来不及报价，先承诺"周五下班前一定回"，让对方据此调整截止看板。
- **现在只能怎么做**：`POST /<view>/deadlines/promise` 路由存在，但**供应商侧实测 404 `rfq-not-found`**（同一个 `pkg-g1` 在供应商首页的投递事实里明明有）；承包商侧同参数 `202`（`id=rp-contractor-ec99ceb8579d`）。而且两侧落账都还要回终端跑 `tools/rfq-promise.py`。
- **期望**：包详情页「我要晚点回」按钮（日期时间选择 + 原话框）在供应商侧同样可用；判定口径统一（要么投递事实也算"本视角的包"，要么把 `rfq/published` 也投影进供应商视角）；提交后同进程消费落 `rfq/promised`；承包商侧 `due_ts` 更新为"来自事实 `rfq/promised`"。
- **证据**：`src/domain/rfq-deadline/tools/rfq-promise.py`（要求目标包真的在本视图投影里，否则 `rfq-not-found`）；实测两侧状态码差异。

### DEF-025 · P1 · 邮件通道只能看状态，改配置要跳到提权后的 admin 道

- **想做什么**：运维在邮件通道不可用时当场修好（填 SMTP/IMAP 凭据、发一封测试信），而不是把它当成一条离线工单。
- **现在只能怎么做**：只能看 `/ops/mail/`（队列计数、最近一次尝试与 `reason`、`available`、`next_action`）；改配置要去 `/admin/config/`，而它未提权时返回 **401**（实测 24 B 响应），提权要拿管理员 token。
- **期望**：`/ops/mail/` 上给出"配置凭据"的直接入口（走 admin 道的既有写面 `config-apply.py`，仍是"干跑 → `0600` 待处理项 → Python 侧落盘"），并在同页给出"发一封测试信"的动作与结果；凭据**永不回显**（保持现有口径）。
- **证据**：`webui.mjs:426`（`mailHtml`）；`GET /ops/mail/ 200`、`GET /admin/config/ 401`（实测）；`src/system/config/tools/config-apply.py`。

### DEF-026 · P1 · 业务视角看不到自己的用户空间插件（自建视图只能管理员装卸）

- **想做什么**：业务方给自己挂一块视图/一个动作（例如"我的常用包"），在自己的视角里就能用。
- **现在只能怎么做**：做不到。槽位闭合集合只有 5 个（`page.home/contractor/supplier/ops/admin`），业务视角没有模块级槽位；装卸只在 admin 道（`POST /admin/api/user-plugins/<load|unload|reload>`，`auth: admin-session`），业务用户看不到、也管不了。
- **期望**：业务视角新增 `/P/plugins/`（用户空间插件的自述、启用/停用、注册了哪些视图/动作/快捷键）；槽位扩到 `page.<view>.<module>`，让插件能挂到具体模块上；装卸动作走既有的用户空间写面，不需要业务用户提权。
- **证据**：`src/system/webui/code/ui-slot.mjs:30`；`GET /quotagent/api/ui/blocks`；`POST /quotagent/admin/api/user-plugins/load`（admin-session）。

### DEF-027 · P1 · PO 追溯只能靠 URL 猜（没有 PO 页，链接不可点）

- **想做什么**：拿到一条 PO，点进去看到 `po → 承诺 → 意向 → 报价` 的完整链路，以及每一行的单价基准 `basis`。
- **现在只能怎么做**：做不到（实测 `GET /contractor/po/po-0001/ 404`）；`CommitmentGate.trace(po_id)` 已经能返回链路，但没有页面消费它。
- **期望**：PO 列表 + 详情页（链路四段可点、行内 `basis` 可点进报价/变更单、导出）；深链可分享（对方视角打开同样深链必须被拒绝或明确无权限）。
- **证据**：`src/domain/commitments/code/commitments.py:192`（`trace`，返回 `chain`/`lines`/`total_amount`）。

### DEF-028 · P1 · 没有"通知与催办"这条线（待办不提醒、催办无回执）

- **想做什么**：有 3 件要处理时页面上有徽标；报价被退回、中标、PO 签发时我能收到提醒；催办之后能看到"已催 N 次"，不必自己记。
- **现在只能怎么做**：没有通知中心、没有徽标、没有轮询/推送；页面是纯 SSR（实测 8 页 `script=0`），用户只能反复刷新首页自己找。催办落的是 `0600` 待办件（`tmp/ui-shared/gate-nudges/`），由 Python 侧消费，页面上没有"已催历史"。
- **期望**：通知中心（待办/结果/失败三类，每条 = id + 类别 + 对象深链 + **一行内联动作**：去处理/催办/稍后；未读徽标、已读、全部标已读）+ 待办徽标挂在左导航各模块上；催办后在对象上回读"已催 N 次 @ts"；时间一律用**事实时刻**，不取墙钟。
- **证据**：`webui.mjs:61-70`；无 `/api/notifications`；`tmp/ui-shared/gate-nudges/`（实测存在 `gn-contractor-…json`）。

### DEF-029 · P1 · 承包商不能导出/验证审计证据包（只能看计数）

- **想做什么**：给上级或外部出一份可验证的证据包（范围内事件 + 哈希链），或验证别人给的一个包。
- **现在只能怎么做**：只能看证据面计数与类型分布（`GET /contractor/evidence/?limit=200 200`）；`POST /contractor/evidence/export 404`。终端只有 `tools/audit-verify.py`（校验**已存在**的包），没有面向用户的"导出"入口；`tools/export-events.py` 导的是**事件类型表**，不是审计包，不能当替代。
- **期望**：证据面页上的「导出证据包」（范围选择器：包/时间窗/参与方 → 生成 → 下载）与「验证一个包」（上传/粘贴路径 → 逐项 pass/fail 结果表，失败要指出**第几条**与失败类型）；校验结果有可分享深链；账本不可读时宁可不导出。
- **证据**：`src/domain/export/code/export.py:107`（`verify`）；`src/system/evidence/tools/audit-verify.py`（退出码 0/1/2）；`src/system/evidence/tools/export-events.py`（用途不同）。

---

## 3. P2 —— 可用性 / 一致性 / 误导性呈现

### DEF-030 · P2 · 报价子视图是原始账本行表，不像"报价"（误导性）

- **想做什么**：一眼看出"哪个包收到了哪几家报价、各自什么状态"。
- **现在只能怎么做**：`/contractor/quotes/` 与 `/supplier/quotes/` 渲染的是**账本事件行**（带 `seq`/`type`/摘要），不按包分组、无供应商列聚合、无状态徽标、无金额列。
- **期望**：按包分组的报价收件箱（行 = 供应商 + 金额 + 币种 + 事实 ts + `@rev` 是否作废 + 状态徽标），行可展开到逐行明细；筛选排序按金额/交期/时间。
- **证据**：实测 `GET /contractor/quotes/ 200`（4338 B 原始行表）；`src/domain/quotes/code/quotes.py:97/101/112`。

### DEF-031 · P2 · heuristics 页"改 URL 就能重排"是伪交互（看起来能做事，其实不落任何事实）

- **想做什么**：调权重、存成事实、导出、看每项贡献。
- **现在只能怎么做**：改 URL 查询参数就能看到名次变化，但它是插件里的**算术演示**：不落事实、无供应商列、无对比矩阵、不能导出；`POST /contractor/compare 404`、`POST /contractor/compare/weights 404`。
- **期望**：要么做一个**真的**比较页（矩阵 + 权重存为事实 + 贡献分解 + 导出，见 DEF-012），要么在页首明确标注"本页只是口径演示，不改变任何事实、不能用来比价"，避免用户以为自己在做比价。
- **证据**：`webui.mjs:636-810`；`src/domain/bid-heuristics/code/bid-heuristics.mjs`；实测 `GET .../?w_price=0.6 200`。

### DEF-032 · P2 · 变更明细页的 `next_action` 直接给终端命令（产品教用户回终端）

- **想做什么**：在页面上把这一步做完，或至少得到一个"点一下就能做"的入口。
- **现在只能怎么做**：`/contractor/api/gates` 的 `changes[chg-0001].next_action` 是 `PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3` —— 一条**开发期走查脚本**的命令；`/contractor/changes/chg-0001/` 页面上的说明同理。
- **期望**：`next_action` 渲染成**界面动作**（跳到"提出变更"页 / 打开签名对话框），终端命令降级为"进阶提示"，且不得出现 `g1side` 这类走查脚本（它硬编码演示数据，不是产品入口）。
- **证据**：实测 `/contractor/api/gates` 的 `changes[]` 字段；`src/quotagent/g1side.py`（走查脚本）。

### DEF-033 · P2 · 多包被静默截断（只显示 8 个，没有"查看全部"）

- **想做什么**：供应商有 15 个在跑的包时能看到全部（或至少知道还有多少）。
- **现在只能怎么做**：投递信封最多展示 `rfq_delivery_max=8`（`webui.mjs:56`），其余只报一个 `omitted` 计数，没有分页、没有"加载更多"、没有筛选。
- **期望**：包列表带分页/虚拟滚动/筛选（状态、截止窗口、关键词），`omitted` 计数可点开看到"还有哪些包"；`rfq_delivery_max` 作为**页大小**而不是硬上限。
- **证据**：`webui.mjs:56`（`rfq_delivery_max: 8`）、`webui.mjs:2100-2120`（`data-rfq-omitted`）。

### DEF-034 · P2 · 未命中对象时返回"404 + 一整页 HTML"（人看不出是错还是空）

- **想做什么**：打开一个不存在/不属于我的变更单时，明确知道"这条不存在或无权访问"，并知道下一步做什么。
- **现在只能怎么做**：`GET /supplier/changes/chg-0001/` 返回**状态码 404** 但响应体是一整页渲染好的 HTML（5377 B），导航、标题、正文都在，用户在浏览器里看到的是一个"正常页面"，只有开发者看状态码才知道是 404；反之 `GET /contractor/rfq/ 404` 返回的是 JSON `not-found` + `hint`。
- **期望**：统一错误形状 —— 页面对象未命中时渲染一个**错误态页**（明确写"对象 X 不在你的视图里 / `reason` / 下一步"），状态码与页面语义一致；JSON 路由保持现有 `{ok:false, code, next_action}` 形状。
- **证据**：实测两类 404 的响应体差异。

### DEF-035 · P2 · 全站无统一空态/错误态/加载态与可访问性基线

- **想做什么**：空列表时知道"不是坏了"，出错时知道下一步，用键盘也能走完全部流程。
- **现在只能怎么做**：各页各自为政（有的给 `degraded + reason`，有的只报 `omitted` 计数，有的干脆什么都没有）；没有 `aria-*`、没有 `:focus` 样式、没有响应式；全站只有 `<input type="submit">`，没有 `<button>`，没有卡片/面板类组件。
- **期望**：统一的空态/错误态/加载态组件（`data-empty` + 人话 + `reason` + 下一步）；键盘可达（不用鼠标走完全部流程）、焦点可见、`aria-*`、对比度、表头与表单标签关联；布局在不同宽度下可用。
- **证据**：抽查 8 页的 CSS/元素实测（`script=0`、无 `class` 组件、无 `@media`/`:focus`/`:hover`）；各页 `degraded`/`omitted` 口径不一。

### DEF-036 · P2 · 授权区间页"只能算、不能批"，且"未配置"容易被读成"额度无限"

- **想做什么**：判断这笔钱该谁批、越界了找谁，并**就地**发起审批或升级。
- **现在只能怎么做**：页面能算（实测 `GET /contractor/authority/?amount=1&role=buyer 200`），但不落事实、不能批准、不能发起升级；未配置时只报 `unconfigured` 并把 `required_role`/`next_role` 留空。
- **期望**：授权区间与审批/升级**连起来**（越界 → 一键"提交给 `next_role` 审批"，走人工门）；`unconfigured` 时必须显式写"未经配置 ⇒ 一律走人工门，**不代表额度无限**"（现有 `unconfigured` 口径保留并加强文案）；金额单位恒为**整数分**并给元→分换算提示。
- **证据**：`webui.mjs:1528-1784`（authority 页）；`authority.bands.*` 配置键；`src/system/approval/code/approval.py`。

---

## 4. 与规格文档的对应

- 步骤编号（C1–C11 / S1–S10 / G1–G8）与「工作流 + 界面规格」一致：`docs/work/plans/webui-workflow-and-ui-spec.md` §2。
- 修复顺序按该文件 §4.3 的 P0/P1/P2 排期执行；每条缺陷的"期望"就是该步在规格 §3.2/§3.4/§3.5 里的目标形态。
- **验收口径**（不要用"门全绿"当结论，见 29 §2.4）：修完一条缺陷，必须能在**不打开终端**的前提下，把规格 §4.4 的那条操作序列走完，并断言**账本里多了哪条事实**、**对方视角看得见什么**。
