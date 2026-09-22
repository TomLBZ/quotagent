# 员工工作流驱动的 UI 重做规格 · 第 2 部分（§3 目标交互规格）

- 这是 `docs/work/plans/ui-workflow-rework.md` 的**第 2 部分**（单文件超 32 KB 预算，按文档标准的「删重复 → 删叙述 → 拆文件」优先序拆开；编号与 § 号沿用未拆前的版次，便于逐字对照）。
- 前置：§0 结论 / §1 实测证据 / §2 缺口清单在主文件；§4 视觉规格与 §5–§7 在第 3 部分。
- 原始证据：`docs/work/evidence/EV-158-ui-workflow-rework.txt`。
- 纪律与硬约束（`R-1..R-8`）在 §3.0；**实现者必须先读完 §3.0 再读下面的页面规格**。

---

## 3. 目标交互规格

### 3.0 硬约束（实现者不得违反；违反即设计错误）

| 编号 | 规则 | 依据 / 为什么 |
|---|---|---|
| R-1 | **页面零内联脚本**：新页面 0 行 `<script>`、0 个内联事件属性；交互 = SSR `<form method=get\|post>` + `<a>` | 既有门逐页断言（`P0-2/E2`、`P0-3/E2b/E2c`），且 `INV-001` 的"NFR-UX-001..004 不靠 JS"口径 |
| R-2 | **宿主零写账本**：`host/**` 不写账本、不起子进程、不联网、不取墙钟、不取随机数；写面只有**0600 待办件** | `H1`；门 t280 的写函数白名单 `writeFileSync/chmodSync/renameSync/mkdirSync/readFileSync/readdirSync/statSync` |
| R-3 | **唯一落账本者 = Python 侧**：每个新写面必须同批交出一条 `tools/*.py` 消费者，否则就是"界面说成功、账本没动"的假成功 | 既有 `gate-nudge.py` / `rfq-promise.py` / `ui-feedback-apply.py` 同一形状 |
| R-4 | **失败同形，不做 oracle**：鉴权失败复用固定体；写失败只区分"已受理 / 未受理"，不细分原因 | `AC-ADMIN-001/002`、`AC-TRUST-001` |
| R-5 | **网页永不签**：批准 / 提交报价 / 定标 / 发 PO / 变更批准五件事只能"准备载荷 + 可复制命令" | `ADR-0013 §3` + `/api/routes` 的 `write_surface.note` |
| R-6 | **老路由字节不动**：新增写面一律用**新路由**，不改现有 URL 的响应形状 | 既有冻结断言（`P0-2/E11` 的 `FROZEN_SHA`） |
| R-7 | **时间只用事实时刻**：表单校验不得取墙钟；时间字段只做 ISO 格式校验 + "必须晚于本视角投影的 `as_of`" | 既有 `age_clock=facts-only` / `due_clock=facts-only` 口径与 `data-ui-revision` 机制 |
| R-8 | **空态与否定态必须显式**：`data-empty` + 人话 + `reason` + `next_action`；**不得**把"读不到"渲染成"零条" | 既有 `E6` 与各页 `degraded+reason` 口径 |

### 3.1 通用约定（所有新路由共用）

- 前缀变量 `P = /quotagent`（不得写死）。HTML 一律走既有 `html(title, body, prefix)`；JSON 一律 `JSON.stringify(payload, null, 2) + "\n"`。
- **写路由统一形状**（与本仓既有三个写面同形，便于门复用断言）：

| 情形 | 状态码 | 响应 |
|---|---|---|
| 已受理 | `202` | `{service, view, ok:true, code:"accepted", id:"<待办件 id>", bytes, <字段 sha256…>, record:{…}, next_action:"跑 <命令> 消费待办件（唯一落账本者）", duplicate:false, file:"<inbox>/<id>.json"}` |
| 幂等重复 | `202` | 同键集，`duplicate:true`，`id` 为已存在件 |
| 形状不合法 | `400` | `{service, view, ok:false, code:"<某个具体码>", next_action:"…"}`（码取自 §3.2/§3.3 的校验列，**不含**被判字段的取值） |
| 未受理（业务上拒绝，如目标不在本视角投影） | `404` | `{ok:false, code:"<target-not-found>", next_action:"…"}` |
| 载荷过大 | `413` | `{error:"payload-too-large", limit:16384}` |

- 待办件一律 **恰 0600**（`writeFileSync(..., {mode:0o600})` + 显式 `chmodSync`），含 `schema/kind/view/requested_action/<业务键>/sha256/bytes/submitted_at:""`（`submitted_at` 由 Python 侧按 `--now` 落）。
- 每个新页面必须带 `data-subnav`（道内导航）、`data-block`（首屏三块）与 `data-ui-view`/`data-ui-revision`（沿用现有）。
- 每个新页面必须在页脚保留同一句铁律说明，并**列出本页"准备不了"的动作**（防误导）。

### 3.2 承包商采购员：每步的目标页面 / 控件 / 校验 / 提交后可验证结果

#### C1 开 RFQ

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/contractor/packages/`（我的包：一行一个包：`包名 @rev`、条目数、邀请数、`quote_by`（事实时刻）、**未回名单**、状态标签）；`GET P/contractor/packages/new`（建包表单） |
| 控件 | `<form method="get" action="P/contractor/packages/">`（筛选/翻页，沿用 `data-applied`）＋ `<form method="post" action="P/contractor/packages/new">`（建包） |
| 表单字段 | `package_id`(`pkg-…`，`[a-z0-9-]{3,32}`)、`subject`(≤120 字)、`quote_by`(ISO8601)、`currency`(`CNY\|USD\|EUR` 白名单)、`items`(重复字段 `item_id`/`qty`(>0)/`unit`/`spec_ref`，1..50 行)、`invited`(重复字段，供应商 id，1..20)、`terms`(`payment/warranty/penalty` 三键可选) |
| 校验 | ① 格式与白名单（上面括号内）；② `quote_by` 必须**晚于**本视角投影的 `as_of`（事实时刻，不取墙钟）；③ `package_id` 在本视角投影里不存在（重复 → `400 code:"package-id-exists"`）；④ `items` 行数 1..50、`invited` 1..20（越界夹取到边界并回显 `applied`，不静默） |
| 提交后可验证结果 | `202` + 待办件 `tmp/ui-shared/rfq-drafts/<id>.json`；页面顶部出现 `data-pending="<sha8>"` 区块：待办件 id / 落点 / `next_action`（一条 `tools/rfq-draft.py --now <ISO>` 的**可复制**命令）；跑完消费者后 `GET P/contractor/packages/` 出现该包行，`data-rfq-id="<id>"` 且 `@rev=1`；`GET P/contractor/api/events?type=rfq/` 多一条 `rfq/published` |
| 明确不做 | 分发/发送（`can_send=false`）：页面给「导出通知正文（可复制）」区块，并逐字写"**未发送**" |

#### C2 收报价

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/contractor/quotes/`（**重排**：按包分组，每条报价一行：供应商、金额、币种、提交事实 ts、`@rev` **是否已被新版作废**、状态标签）；`GET P/contractor/quotes/<id>/`（行级明细 + 该报价的状态轨） |
| 控件 | 行内三个 `<form method="post">`：`review`（`accept` \| `reject` \| `need-info` + `note`）；包级一个 `<form>`：`compare`（跳到比较表） |
| 表单字段 | `quote_id`、`decision`(白名单三值)、`note`(≤500 字，`need-info` 时必填)、`reason_code`(白名单) |
| 校验 | `quote_id` 必须在本视角投影里；已被新版作废的报价**不允许** `accept`（`409 code:"quote-superseded"`，并要求改对最新 rev）；`note` 超过 500 字 → 400 |
| 提交后可验证结果 | `202` + 待办件；消费者落 `quote/reviewed`（body 恰 5 键：`{quote_id, view, actor, decision_sha256, ok}`，**不含理由正文**）；页面该行状态标签由"待审"→"已受理（待落账）"→（消费后）"已接受/已退回/待补件" |
| 新增只读 JSON | `GET P/contractor/api/quotes`（键集：`{view, service, counts, quotes:[{quote_id, supplier, amount, currency, rev, superseded, ts}]}`；与页面同口径，便于门断言"我到底收到几条"） |

#### C3 比价

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/contractor/compare/?package_id=<id>`（**比较表**：行 = 条目（`item_id`/`qty`/`unit`），列 = 供应商；单元格 = 单价 / 行总价 / 与最低价差（百分比 + 绝对分）；表下方「偏差标记」区列出 `compare/flag-raised` 的 `kind`/`family`/`diffs`） |
| 控件 | 权重表单 `<form method="get">`（五个 `w_*` 滑块→数字输入，即时重排，**不落事实**，页首写"临时视图，未保存"）；`<form method="post" action="P/contractor/compare/weights">`（把权重存成事实）；`<a href="P/contractor/compare/export.csv?package_id=…">导出 CSV</a>` |
| 表单字段 | `package_id`、`w_price/w_lead/w_quality/w_risk/w_terms`（0..1，和不必为 1，页面回显归一化后的值）、`note`(≤200) |
| 校验 | 五个 `w_*` 非数字/越界 → 夹取到 `[0,1]` 并回显 `applied`；`package_id` 不在本视角 → `404`；**导出**必须与 `compare/rank-computed` 逐行一致（导出页脚写 `source=eval:<id>` 与行数，供人核对） |
| 提交后可验证结果 | 权重：`202` + 待办件 → `compare/weights-set`；页头变成"当前权重来自事实 `ts=…`"（不再是"临时视图"）。导出：下载的 CSV 首行 `# package_id,rev,evaluation_id,basis`；并提供 `GET P/contractor/api/compare?package_id=` 只读 JSON |
| 明确不做 | 不改判定：权重不改变任何已落账的排名事实（页面逐字写"权重只影响本页展示，不回溯改写 `compare/*` 事实"） |

#### C4 选标

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/contractor/award/`（授标轨：`intent-proposed` → `approval/requested` → `approval/granted` → `award/committed`，每段显示事实 ts 与"卡在谁手里"）；`GET P/contractor/award/<intent_id>/`（意向详情 + 行级快照） |
| 控件 | `<form method="post" action="P/contractor/award/intent">`（**提意向**，无义务、可撤回）；`<form method="post" action="P/contractor/award/<intent_id>/withdraw">`（撤回）；**载荷准备区**（不是表单）：`data-human-gate-action="award.commit"` |
| 表单字段 | `package_id`、`quote_id`、`lines`(重复：`item_id`/`qty`)、`note` |
| 校验 | `quote_id` 必须未被作废；`lines` 的 `item_id` 必须是该包条目；缺 `approval_id` 的**提交承诺**永不接受（网页无此路由，直接 404） |
| 提交后可验证结果 | 提意向：`202` + 待办件 → `award/intent-proposed`；页面该包行出现"已提意向（可撤回）"标签。撤回：`202` → `award/intent-withdrawn`；标签回"未提意向" |
| 载荷准备区（R-5） | 区块内容：`intent_id` / 待批金额（整数分）/ 行数 / `payload_sha256`（由宿主对**只读事实**拼串算 sha256，不含私域）+ `<pre>` 逐字可复制命令（形如 `python3 tools/award-commit.py --intent awin-0001 --approval ap-0007 --now <ISO>`）+ 一句"**签字在终端**：本页不提供签收按钮，也永远不会提供"。该区块必须带 `data-human-gate-action` 与 `data-cmd-sha256`，且**不得**含 `<form method="post">`（门可静态断言） |

#### C5 发 PO

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/contractor/po/`（只读列表：`po_id`/`award_id`/行数/`trace_mode`(full\|ref-only)/签发事实 ts）；`GET P/contractor/po/new?award_id=<id>`（载荷准备页） |
| 控件 | 载荷准备区 `data-human-gate-action="po.issue"`：行表（`item_id`/`qty`/`unit_price`/金额，**每行带来源链**：引用哪条报价、哪条变更）+ `payload_sha256` + 可复制命令 |
| 校验 | `award_id` 必须已 `award/committed`（先判派生再判批准：无中标行则页面直接写"不能开 PO，原因：<code>"，不给命令） |
| 提交后可验证结果 | 网页**无**写路由（`POST` 一律 404，符合 R-5）；跑完终端命令后 `GET P/contractor/po/` 出现该 PO 行，行来源链可点进报价/变更单 |
| 明确不做 | 不提供"我已经发了 PO"的自报按钮（发了就是账本里有 `po/issued`，没有就不能显示） |

#### C6 变更单

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/contractor/changes/new?quote_id=<id>`（**提出变更**：行级表单，原单价×原量**只读**，只让改量）；`GET P/contractor/changes/<id>/`（已有逐行明细页，保留） |
| 控件 | `<form method="post" action="P/contractor/changes/new">`；明细页的载荷准备区 `data-human-gate-action="change.approve"`（变更批准属五个不可签动作之一） |
| 表单字段 | `quote_id`、`lines`(重复：`item_id`（只读展示）、`new_qty`(>0)、`reason_code`白名单)、`reason_note`(≤300) |
| 校验 | `new_qty` 与 `qty` 相同 → `400 code:"no-op-change"`；`item_id` 必须存在于该报价；**不允许改 `unit_price`**（页面把原单价渲染成 `<code>` 文本而非输入框，并写"定价必须引用原报价单价"）；缺 `basis_unit_price_ref` 的行在明细页明示"未纳入小计" |
| 提交后可验证结果 | `202` + 待办件 → `change/proposed` + `change/priced` 两条；`GET P/contractor/changes/new` 提交后跳到 `GET P/contractor/changes/<新 id>/`，页面 `data-subtotal-before/after/delta` 三值齐备；`GET P/contractor/api/gates` 的 `changes` 列表多一条且 `owed_by` 指向正确一方 |

### 3.3 供应商报价员：每步的目标页面 / 控件 / 校验 / 提交后可验证结果

#### S1 收 RFQ（先修根因）

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/supplier/packages/`（**我收到的包**：`包名 @rev`、`quote_by` 倒计时（按事实时刻算）、我的状态标签：`未见`/`已认收`/`草稿`/`已准备提交`/`已被新版作废`）；`GET P/supplier/packages/<id>/`（包正文要点 + 条目表 + rev 历史 + 变更点） |
| 控件 | `<form method="get">`（筛选）＋ `<form method="post" action="P/supplier/packages/<id>/ack">`（认收） |
| 表单字段 | `package_id`、`seen_rev`(整数，默认取投影里最新 rev)、`note`(≤300，可选) |
| 校验 | `package_id` 必须是**本视角投影里 recipient 命中我的包**（否则 `404 code:"package-not-found"`）；`seen_rev` 不得超过当前最新 rev（否则 `400 code:"rev-out-of-range"`） |
| 提交后可验证结果 | `202` + 待办件 → `rfq/acknowledged`；页面状态标签 → "已认收 @rev2"；**承包商侧** `GET P/contractor/packages/<id>/` 的"已回/未回名单"里我从未回变为已认收（双向闭环，见 §3.4） |
| 依赖 | 必须先做 **S-gap-1 的投影放宽**，否则本页只能是空页（现在就是空页） |

#### S2 报价 / 改报

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/supplier/packages/<id>/quote`（条目级报价表：`item_id`/`qty`/`unit_price`/`lead_days`/`currency`/`valid_until`/`remark`；表尾 `subtotal`（整数分）；**表内不含任何成本构成/底价私域键**） |
| 控件 | 报价表（`<form method="post" action="P/supplier/packages/<id>/quote">`）；已在册的报价行给 `<form method="post" action="P/supplier/quotes/<quote_id>/amend">`（改报）；被新版作废的报价行给 `<a href="…/quote?from=<quote_id>">`（按新版预填，**不是**一键提交） |
| 表单字段 | `package_id`、`rev`、`lines`(重复：`item_id`/`unit_price`(整数分)/`qty`/`lead_days`(整数)/`currency`白名单/`valid_until`(ISO)/`remark`≤200)、`terms`(三键可选)、`attachments_note`(≤300) |
| 校验 | `unit_price` 必须为正整数分（**页面明写"金额一律整数分"，元写成分会被判越界**——与 authority 页同口径）；`rev` 必须是当前最新 rev（旧 rev → `409 code:"rev-stale"` 并给"按最新 rev 重填"链接）；`valid_until` 必须晚于本视角 `as_of`；`lead_days` 0..3650 |
| 提交后可验证结果（分两段，R-5） | ① **准备载荷**：`POST …/quote` 落 0600 待办件，`202` + `data-pending="<sha8>"`（页面显示：待办件 id、落点、`next_action` 里的可复制命令）。② 页面明确写"**提交报价是人签的动作**（`ADR-0013 §3`）：本页只准备载荷，签字命令在终端"，并在页脚列出该命令。跑完 `tools/quote-submit.py` 后：`GET P/supplier/quotes/` 出现 `quote/submitted` 行、`GET P/supplier/api/pending` 里该待办件消失、**承包商侧** `GET P/contractor/quotes/` 出现这条报价（§3.4） |

#### S3 澄清

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/supplier/clarifications/`（我的工单：状态 `open`/`answered`/`closed`、我的问题、承包商的答复、被引用的条目；**承包商侧镜像 `GET P/contractor/clarifications/`**） |
| 控件 | `<form method="post" action="P/supplier/clarifications/ask">`（提问）；`<form method="post" action="P/contractor/clarifications/<ticket>/answer">`（承包商回答，同一 SSR 生成函数） |
| 表单字段 | `package_id`、`rfq_rev`、`refs`(重复：`item_id`，1..20，可多选)、`question`(≤500)、`answer`(≤2000)、`broadcast_to`(重复：供应商 id，回答时可选，**必须 ⊆ 在册全集**，否则 400 并列出缺谁) |
| 校验 | `refs` 至少 1 项（否则 `400 code:"clarify-ref-missing"`）；`question` 非空；`broadcast_to` 不满在册全集 → `400 code:"broadcast-incomplete"`（现有 `ClarificationService` 同码） |
| 提交后可验证结果 | 提问：`202` → `clarification/asked`；**承包商视角** `GET P/contractor/clarifications/` 立刻出现该工单（今天是 404 页面）且 `data-cleared` 显示"待你回答"。回答：`202` → `clarification/answered`；**供应商视角**工单状态从 `open` → `answered`，答复正文可见（现在是"我问了没人能答"） |

#### S4 确认中标

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/supplier/award/`（我的授标通知：`intent_id`/`award_id`/包/行数/金额/当前状态：`意向` → `已授标（待我确认）` → `已确认` → `PO 已签发`） |
| 控件 | `<form method="post" action="P/supplier/award/<award_id>/confirm-payload">`（**准备声明载荷**，不是签收）；载荷区 `data-human-gate-action="award.supplier-confirm"` |
| 表单字段 | `award_id`、`declared_by`(发言人，`human:*`/`agent:*`，`^[a-z]+:[A-Za-z0-9._-]{1,64}$`)、`supplier_confirmed`(`true`\|`false`)、`can_meet_due`(`true`\|`false`\|`unknown`)、`note`(≤300) |
| 校验 | `award_id` 必须是命中本供应商的授标（否则 `404`）；`declared_by` 必须匹配发言人正则（现有 `actor-malformed` 同口径）；**`supplier_confirmed=true` 且 `can_meet_due=false` 时要求 `note` 非空**（避免"确认了又交不了货"） |
| 提交后可验证结果 | `202` + 待办件 → `tools/award-confirm.py` 落 `award/supplier-confirmed`（body 恰 6 键，`{award_id, view, actor, declared_sha256, can_meet_due, ok}`，不含 `note` 正文）；页面状态 → "已提交声明（待落账）"→（消费后）"已确认"。**承包商侧** `GET P/contractor/award/<intent_id>/` 的 `supplier_confirmed` 从 `null` → `true`，且 `CommitmentGate.commit_award` 的可行前提满足 |
| 明确不做 | 网页不给"确认"按钮（`<button>确认中标</button>` 是**签收语义**，违反 R-5 的精神边界：承诺类动作一律载荷化） |

#### S5 处理变更

| 项 | 规格 |
|---|---|
| 目标页面 | `GET P/supplier/changes/`（我的变更单列表）与 `GET P/supplier/changes/<id>/`（**逐行明细**，与承包商侧同口径：原单价×原量 → 新量 → 差额；`money_unit=cents`） |
| 控件 | `<form method="post" action="P/supplier/changes/<id>/respond">`（接受 / 异议） |
| 表单字段 | `change_id`、`response`(`accept`\|`dispute`)、`lines`(重复：`item_id` 勾选，只有勾选的行走接受)、`note`(≤500，`dispute` 时必填)、`can_meet_due`(三值) |
| 校验 | `change_id` 必须命中本视角（否则 404）；`dispute` 缺 `note` → 400；**不允许**在本页做"变更批准"（无此路由）；被接受的行必须引用原报价单价（缺 `basis_unit_price_ref` 的行页面标"未纳入小计"且**不可勾选**） |
| 提交后可验证结果 | `202` + 待办件 → `change/supplier-responded`；**承包商侧** `GET P/contractor/changes/<id>/` 增加一行"供应商回应：接受/异议 @ts"；`GET P/contractor/api/gates` 的 `changes[<id>].owed_by` 从"供应商"变为"承包商（待批准）"或"承包商（待补依据）" |
| 依赖 | 必须先做 **S-gap-8 的投影放宽**（现在供应商侧连这张变更单都 404） |

### 3.4 双向闭环（一个动作在对方视角产生的可见变化）

契约：**每一个新写动作，必须在对方视角有一条可机检的可见变化**；只落本侧事实、对方看不到的动作，一律视为未完成。

| 角色方动作 | 本侧可见结果（可断言） | **对方侧可见结果（可断言）** | 对方侧所在页面 |
|---|---|---|---|
| 承包商 建包（C1） | `GET P/contractor/packages/` 出现 `data-rfq-id` 行 | `GET P/supplier/packages/` 出现同一 `package_id @rev1` 行，状态"未见" | `/supplier/packages/` |
| 供应商 认收（S1） | 状态标签"已认收 @revN" | `GET P/contractor/packages/<id>/` 的未回名单里我消失（`data-responded-count` +1） | `/contractor/packages/<id>/` |
| 承包商 提意向（C4） | 授标轨第一段点亮 | `GET P/supplier/award/` 出现"意向（未产生义务，承包商可撤回）"行 | `/supplier/award/` |
| 承包商 撤回意向 | 标签回"未提意向" | `GET P/supplier/award/` 该行标"已撤回"，且不再可准备声明载荷 | `/supplier/award/` |
| 供应商 准备报价载荷（S2） | `GET P/supplier/quotes/` 该行状态"待落账" + `data-pending` | 消费者落账后 `GET P/contractor/quotes/` 出现该报价行（金额/币种/供应商） | `/contractor/quotes/` |
| 承包商 报价评审（C2） | 报价行状态标签变化 | `GET P/supplier/quotes/<id>/` 出现"承包商已受理/已退回/要求补件"（**不含**承包商内部备注） | `/supplier/quotes/<id>/` |
| 供应商 提问（S3） | 工单状态 `open` | `GET P/contractor/clarifications/` 出现待答工单（今天该页 404） | `/contractor/clarifications/` |
| 承包商 回答（S3） | 工单状态 `answered`，答复可复制 | `GET P/supplier/clarifications/` 工单状态 `open`→`answered`，答复正文可见 | `/supplier/clarifications/` |
| 承包商 提变更（C6） | 明细页 `before/after/delta` 三值 | `GET P/supplier/changes/<id>/` 出现该变更（新量、差额），可回应 | `/supplier/changes/<id>/` |
| 供应商 回应变更（S5） | 本侧状态"已回应" | `GET P/contractor/changes/<id>/` 增加"供应商回应"行；`api/gates` 的 `owed_by` 变更 | `/contractor/changes/<id>/` |
| 承包商 登记承诺（已有） | `rfq/promised` 事实 + `remaining_seconds` | `GET P/supplier/packages/<id>/` 显示新的 `due_ts` 与"来自事实 `rfq/promised`"（**今天供应商看不到包，所以这条闭环现在断了**） | `/supplier/packages/<id>/` |

机检断言（建议门）：对每一行，跑"动作 → 消费者 → 两次 GET（本侧 + 对方侧）"，断言对方侧页面的指定 `data-*` 从旧值变新值；并断言**反向不泄漏**（对方侧看不到本侧私域键，沿用现有私域哨兵断言）。

### 3.5 权限 / 授权区间 / 人工门在 UI 上的呈现（铁律：**不在网页上签署**）

**要呈现的三件事**（每页都要有，位置固定）：

1. **我现在能做什么**（能力区）：一句话说明本页可执行的动作 + 每个动作的目标路由；不可执行的动作**不渲染按钮**（宁缺勿假），并在"做不到的事"区块逐条列出原因码。
2. **授权区间**（金额类页）：把 `authority.bands.*` 的判定摊开成四行：
   - `本笔金额`（整数分，页面把元写成"元 → 分"的**换算提示**，避免 ×100 错误）；
   - `在不在区间`（`within` \| `over` \| `unknown`，`unconfigured` 时必须显示 `unknown` + "未经配置 ⇒ 一律走人工门"，**不给**"可以批"的结论）；
   - `越界多少 / 下一个能批的人是谁`（`next_role`，空缺时显式写"没有更高的角色能批这笔"）；
   - `来源`（`authority.bands.*` 的键名 + 快照 ts）。
3. **人工门**（不可签动作）：统一组件，形态固定：

```html
<section data-human-gate-action="award.commit" data-cmd-sha256="sha256:…"
         data-gate="human-only" data-approval-ref="ap-0007">
  <h3>这五件事只能在终端由人签：批准 / 提交报价 / 定标 / 发 PO / 变更批准</h3>
  <dl>
    <dt>待批对象</dt><dd>awin-0001（包 pkg-g1，2 行，合计 97.43 元）</dd>
    <dt>载荷指纹</dt><dd>sha256:567c81ae…（人请在终端核对这一串）</dd>
    <dt>当前卡在谁手里</dt><dd>human:liangzi（等 1 天 8 小时，按事实时刻算）</dd>
  </dl>
  <p><b>本页不提供签收按钮</b>：请复制下面这条命令到终端，由具名的人执行：</p>
  <pre>python3 tools/award-commit.py --intent awin-0001 --approval ap-0007 --now 2026-09-22T07:00:00Z</pre>
  <p>等价 HTTP：<code>POST /quotagent/&lt;view&gt;/award/commit</code> → <b>404</b>（刻意不提供）。</p>
</section>
```

**机检断言（静态、无需 JS）**：

- 全站响应体 0 行 `<script>`、0 个 `on*=` 内联事件（沿用现有断言）；
- 每个 `data-human-gate-action` 区块**内部**不含 `<form`（正则断言：`data-human-gate-action` 到 `</section>` 之间匹配 `<form` 数 == 0）；
- `/api/routes` 的 `write_surface.browser_writable` **不含**批准/提交报价/定标/发 PO/变更批准五类路径（现有 `note` 五动作清单保持逐字不变）；
- 五类动作的常见路径（`award/commit`、`quotes/submit`、`po/issue`、`change/<id>/approve`）在路由表里 `method` 必须**不存在**或**非 POST**；
- 每个 `data-human-gate-action` 必须带 `data-cmd-sha256`，且该 sha256 可由门对"只读事实拼串"独立重算一致（防页面拼错命令）；
- 业务视角页面**不得**出现 admin 道的直链（提权入口仍然只在页脚折叠区，且文案"业务用户无需使用"）。

**授权区间不得越权呈现**：`unconfigured` ⇒ 页面只出 `unknown` + "走人工门"，**不给** `next_role`、**不给**升级命令（沿用现有 authority 页 `unconfigured` 口径）。

---

