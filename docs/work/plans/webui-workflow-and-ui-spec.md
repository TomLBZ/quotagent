# WebUI 工作流驱动的界面规格（Workflow-Driven UI Spec）

<!-- budget: 48 KB。口径真源：AGENTS.md §11–12 + docs/design/29-webui-gui-app.md。姊妹文件：webui-ui-defects.md（DEF-xxx） -->

以两个真实岗位的一天为出发点，逐步（21 个业务步骤 + 共同侧 8 项）给出「触发/输入 → 系统反馈 → 失败与下一步 → 需要什么界面元素与交互 → **现在能不能在 UI 里做完**」，再从工作流**反推**界面（外壳/视图/交互/写操作与门控/身份签名），最后与 `docs/design/29-webui-gui-app.md` §4 逐条对齐并排期。每条现状判定都带**路由或源码路径**，可直接复现。

**纪律**：① 判据是「**用户能不能做完这件事**」，不是「门全绿」（规则 12 / 29 §2.4）；② 不许用无交互判据（快照 hash / 0 内联脚本 / 三块锚点）冒充 UI 验收（29 §2.2）；③ 写动作必须真落账本或待办件（规则 2 / 29 §1）；④ `webui` **零业务语义**，新功能一律由插件经注册面挂进来（规则 11 / 29 §3）。
**事实基线**：2026-09-22，本机 `127.0.0.1:8093`（`node host/cli.mjs webui --ui-shared tmp/ui-shared`）。「实测」= 对活服务发的真实 HTTP 请求（原始输出见 §6）。

## 0. 结论先行（数字）

21 个业务步骤（承包商 11 + 供应商 10）**今天**：

| 判定 | 步数 | 步骤 |
|---|---|---|
| ✅ 能在界面里独立做完（真写操作） | **1** | S4 备报价草稿（且只支持**单行**一次） |
| 👁 只能看（读了信息，做不了动作） | **6** | C2 看包 / C5 收报价 / C6 比价 / C10 看变更 / C11 看证据 / S1 看包 |
| ⌨ 必须回终端才能做完 | **2** | S5 签名提交报价 / S9 登记回文承诺 |
| ❌ 根本做不到（UI 与终端**都没有入口**） | **12** | C1 开 RFQ / C3 催报 / C4 答疑 / C7 批准 / C8 授标承诺 / C9 发 PO / S2 认收 / S3 提问 / S6 改报 / S7 谈判 / S8 承诺交期 / S10 中标与 PO 确认 |

共同侧（§2.3）：5 项只能看，3 项做不到。

**诊断**：现有 UI = 只读账本阅读器 + 4 类 0600 待办件投递口（实测 `/api/routes` 70 条，写面仅 `admin/**`、`<view>/{gates/nudge,deadlines/promise}`、`supplier/quotes/prepare/`）。业务能力（`RfqService`/`CompareService`/`CommitmentGate`/`ChangeService`/`Clarify`/`Negotiation`/`Capacity`）**全在 Python 侧可用**，只是**没有任何 UI 或 CLI 接上去**。缺口不在后端语义，在**外壳 + 动作面 + 身份与签署**。

## 1. 用户画像

**1.1 承包商侧采购员 `human:wanglei`**：收材料申请 → 开 RFQ → 盯回文 → 答疑 → 收报价 → 比价 → 走人工门 → 授标 → 发 PO → 处理变更 → 出审计包。节奏：8:00 看今日待办与截止；上午开包/答疑；下午收报价比价报批；临截止催报；月底出证据包。**不熟 CLI**（FR-USREQ-005 逐字）。判「做完一件事」= 他点完之后**账本多了一条推进流程的事实**，且**对方视角看得见**（FR-USREQ-003 / 29 §4 末句）。

**1.2 供应商侧销售/投标人 `human:chenmin`**：看被邀的包 → 认收 → 提问澄清 → 备报价（草稿可续）→ 签名提交 → 改报 → 谈判 → 承诺交期 → 看中标结果/确认 PO。当天认收、澄清截止前提问、报价截止前报价、提交前内部审批（即人签）、中标后核产能。**数据主权**：成本模型/底价/内部评分永不出自己 realm（规则 4）；永远看不到其他供应商代号、报价、比价基准。

**1.3 共同侧**：审批人处理审批队列（**只能看** `/contractor/gates/`，「批准」无入口）；运维只看 `/ops/`、`/ops/mail/`；管理员有真写面（`admin/**`，15 条鉴权路由）。

**1.4 能力标签（本文件与缺陷清单共用）**

| 标签 | 判据 |
|---|---|
| ✅ **能做** | 浏览器点完 ⇒ 账本/待办件真的多了一条，页面能回读；不需要终端 |
| 👁 **只能看** | 页面把事实渲染出来了，但**没有任何动作**能推进这一步 |
| ⌨ **必须回终端** | UI 无入口，但仓库里有 CLI 能把这事真正做完（复制命令、切窗口、手敲参数） |
| ❌ **根本做不到** | UI 与终端**都没有入口**；能力只在 Python 库函数里，只有测试/走查脚本调用 |

## 2. 端到端工作流

每步给：**触发/输入 → 系统反馈 → 失败与下一步 → 需要的界面元素与交互**，再给 **路由 / 真源 / 现状（证据）**。「路由」为建议新增（沿用现有前缀与 `/<view>/…` 形状）；「真源」= 背后能力在源码里的位置。

### 2.1 承包商采购员：我的一天（C1–C11）

**C1 开 RFQ（08:05）** 触发/输入：工地材料申请 → `package_id`/`subject`/`currency`/`quote_by`/`clarify_by` + 1..50 行项目（`item_id`/`qty`/`unit`/`spec_ref`）+ 1..20 `invited` + 付款质保条款。反馈：`rfq/published`+`rfq/distributed`；本侧出现 `pkg-x @rev1`；对方 `/supplier/packages/` 出现同一包状态 `未见`。失败→下一步：`package-id-exists`／`deadline-not-future`／`item-duplicate`／`invited-empty`／`item-count-out-of-range`，**字段级** `errors[]`。界面：建包向导（包信息 →**可编辑行项目表格**（加删/拖拽/粘贴 TSV）→ 邀请多选）+ 提交后 `202` + 待办件面板（id/落点/可复制 `next_action`）。
真源 `src/domain/rfq/code/rfq.py:100/195/286`。
**现状 ❌ 根本做不到**。实测 `GET /contractor/rfq/ 404`、`POST /contractor/rfq/publish 404`、`POST /contractor/rfq 404`、`POST …/rfq/pkg-x/invite 404`。唯一替代 = 终端 `python3 -m quotagent.g1side contractor tmp/manual 1`，**硬编码** `pkg-g1`、2 条行项目与 `supplier:g1`（`src/quotagent/g1side.py:122-131`）。**DEF-004**

**C2 看我的包/谁收到/谁没回/还差多久（08:30）** 输入：筛选（状态/截止窗口/供应商/关键词）。反馈：包列表（`包 @rev`、条目数、邀请数、`quote_by` 倒计时（事实时刻）、未回名单、状态标签）。失败→下一步：空列表显式 `reason`，不装死。界面：**包列表页** + 单包详情（条目表/rev 历史/变更点/已回未回名单/事实时间轴）；行双击进详情、右键菜单。
真源 `rfq.py:321/328/374/393`；覆盖率/缺口 `src/domain/sourcing/code/sourcing.mjs`。
**现状 👁 只能看（不足）**。首页「进行中」**只给最新一包**（`webui.mjs:2122-2144`）；`/contractor/deadlines/` 给「还剩多久/已回未回名单」。**无包列表页**（`/contractor/rfq/ 404`），多包只能翻 `/contractor/events/?type=rfq/`；`sourcing` 的 `coverage/gaps/expiring` **零 UI 消费者**。**DEF-004/DEF-005**

**C3 催报（截止前 24h，2 家没回）** 输入：目标包 + 收件人（默认"未回全部"）+ 模板 + 正文。反馈：`rfq/reminded`（或邮件入队）；名单显示「已催 N 次 @ts」。失败→下一步：邮件通道未配置 ⇒ 显式 `mail-transport-unavailable` + 「导出通知正文（可复制）」，**绝不假装已发**。界面：未回名单**批量催报**（勾选 → 催报）+ 催报弹窗 + 行内状态徽标 + 催报历史。
真源 `RfqService.remind`、`sourcing.expiring`。
**现状 ❌**。实测 `POST /contractor/deadlines/notify 404`；`RfqService.remind` **零调用者**；`rfq-deadline` 明确 `can_send=false`，页面自述"本页**不能替你发信**"（`webui.mjs:1361-1367`）。**DEF-013**

**C4 答疑（09:20）** 输入：工单 id、答复正文、条目引用、广播名单（⊆ 在册全集）。反馈：`clarification/asked→answered→broadcast`；供应商侧工单 `open→answered` 且答复正文可见。失败→下一步：`broadcast-incomplete` 要**列出缺谁**；`clarify-ref-missing`；答复人须 `human:*`。界面：承包商侧**工单队列页**（待答/已答/已关闭 + 未答时长）+ 线程视图+ **一键广播**（默认全集，取消时按钮显示"将漏掉 N 家"）。
真源 `src/domain/clarify/code/clarify.py:55/82/111/134/154/184`；FAQ `src/domain/faq/code/faq.py`。
**现状 ❌**。**承包商侧那一页根本不存在**：`SUBVIEWS.contractor = [events,quotes,approvals,evidence]`（`webui.mjs:77-80`），实测 `GET /contractor/clarifications/ 404`、`POST …/answer 404`、`…/broadcast 404`。供应商侧**能看** 2 条历史但提不了问。g1side 的"答疑"其实是**往共享目录写 JSON**（`g1side.py:138`）——人工搬运。**DEF-014/DEF-015**

**C5 收报价（14:00）** 输入：`quote_id` + 评审（`accept`/`reject`/`need-info`）+ 理由。反馈：本侧「待审→已接受/已退回/待补件」；**对方侧**看到「已受理/已退回/要求补件」（**不含**内部备注）；已作废的报价**不允许** accept。失败→下一步：`quote-superseded`；`need-info` 时 `note` 必填。界面：报价**收件箱**（按包分组；行 = 供应商/金额/币种/提交事实 ts/`@rev` 是否已作废/状态徽标）+ 行内三按钮 + **批量**受理 + 明细抽屉。
真源 `src/domain/quotes/code/quotes.py:44/62/97/101/105/112`。
**现状 👁**。实测 `GET /contractor/quotes/ 200`（4338 B，**raw 账本行表**，不按包分组、无状态徽标）；`POST …/receive 404`、`…/<id>/review 404`。`QuoteBook` 的 `superseded/requote` 语义**零 UI 呈现**。**DEF-011**（呈现口径另见 DEF-030）

**C6 比价与排序（14:40）** 输入：`package_id` + 五权重 `w_price/w_lead/w_quality/w_risk/w_terms` + 是否存为事实。反馈：**比较矩阵**（行=条目，列=供应商；单元格=单价/行总价/与最低价差%）+ 排名（分数 + **每项贡献分解** + 可解释引用）+ 偏差标记区 + 被排除报价的原因。失败→下一步：包不在本视角 → 404；权重越界 → **拒**或夹取并回显 `applied`（写死一种）；导出须与 `eval:<id>` 逐行一致。界面：权重**滑块+数字双向绑定**即时重算+「保存权重为事实」+ 列**拖拽换序/固定隐藏** + 按单元格排序 + `导出 CSV` + 「为什么它排第一」侧栏 + **对比模式**（勾 2–3 家只看差异行）。
真源 `src/domain/compare/code/compare.py:66/140/200/211/220/243`；偏差 `deviation/code/deviation.py:51/122/140/161/167`；护栏 `guard/code/guard.py:76/92/206`；导出 `export/code/export.py:39/76/84/107`。
**现状 👁（伪交互）**。`GET /contractor/heuristics/?w_price=0.6 200`：**改 URL 参数就能重排**，但那是 `bid-heuristics` 的**算术演示**，**不落任何事实**、无比较矩阵、无供应商列、不能导出（`webui.mjs:636-810`）。`POST /contractor/compare 404`、`…/compare/export 404`。`CompareService`/`ExportService` **零 UI 消费者**。**DEF-012**（伪交互口径另见 DEF-031）

**C7 走人工门：批准/驳回/要变更（15:10）** 输入：`approval_id` + 决定（`granted`/`denied`）+ 意见（逐字落 `approval/granted.comment`）+ 超时策略（`remind`/`escalate`/`abort`）。反馈：`approval/requested→decided`；队列显示等待时长（事实时刻）与卡点；承诺类动作此后才放行。失败→下一步：已决定的门**不允许再催**（`gate-already-decided`）；`by` 须 `human:*`（`agent:` ⇒ `human-required`，**连空账本都不创建**）。界面：**审批队列**（卡片：待批对象/金额（整数分）/卡点/等待时长/超时倒计时）+ **签名对话框**（§3.5）+驳回并附意见+要变更（→C10）+催办+升级到下一角色+终止。
真源 `src/system/approval/code/approval.py:97/143/164/199/262/270`；催办 `tools/gate-nudge.py`。
**现状 ❌**。`GET /contractor/approvals/ 200`（**只能看**，当前 0 条）；`POST …/ap-0001/decide 404`；**终端也没有入口**（`src/**/tools/*.py` 无 approve/decide 消费者；`ApprovalService.decide` 只被测试与 `g1side.py:186` 调用，而 g1side **自己发请求自己批**、`approvers=[HUMAN]` 写死）。「催办」是**唯一**能点的动作，只落 `0600` 待办件、**还要回终端**跑 `tools/gate-nudge.py` 才落账（实测 `POST /contractor/gates/nudge 404 gate-not-found`，当前无待批门）。**DEF-008/DEF-003/DEF-023**

**C8 授标承诺（15:40，人签）** 输入：`intent_id` + `approval_id` + `supplier_confirmed`（须为真，否则 `CommitmentError`）+ 中标行快照。反馈：`award/intent-proposed`（**无义务、可撤回**）→`approval/requested`→`granted`→`award/committed`；供应商侧出现"已授标（待我确认）"。失败→下一步：`intent-not-active`；缺 `approval_id` 的承诺**永不接受**；供应商未确认 ⇒ 明示"等对方确认"。界面：**授标轨道视图**（意向→审批→承诺四段，各显示事实 ts 与卡点）+「提意向」/「撤回意向」（两个"无义务"动作应当**真能点**）+ 意向详情（行级快照/金额/`payload_sha256`）+承诺 = **签名对话框**。
真源 `src/domain/commitments/code/commitments.py:70/83/101/192`。
**现状 ❌**。实测 `GET /contractor/award/ 404`、`POST …/award/intent 404`、`…/award/commit 404`。终端同样无入口（唯一调用者 `g1side.py:184-188` 把"请求批准+决定+承诺"**一口气做完** —— 不是给人签的门）。**DEF-009**

**C9 发 PO（16:00，逐行可追溯）** 输入：`award_id` + 逐行 `ref_line`/`qty`/`unit_price`（单价**须等于**中标报价单价，否则 `po-line-price-mismatch`）。反馈：`po/issued`，记录带 `chain = po→aw-xxx→awin-xxx→q-xxx`、`trace_mode`（`full`/`ref-only`）、`total_amount`。失败→下一步：`po-not-derived`；`po-line-not-derived`；**先判派生再判批准**。界面：PO 列表 + **签发预览页**（逐行来源链可点进报价/变更单）+签发 = **签名对话框** + 签发后导出/打印（P2）；**不提供**自报按钮。
真源 `commitments.py:136/192`。
**现状 ❌**。实测 `GET /contractor/po/ 404`、`POST …/po/issue 404`、`GET …/po/po-0001/ 404`；终端无入口。**DEF-010**（追溯见 DEF-027）

**C10 变更与价格让步（16:30，需批准）** 输入：`quote_id` + 逐行 `new_qty`（**原单价只读**）+ `reason_code` + `reason_note` + `basis_unit_price_ref`。反馈：`change/proposed`+`change/priced`，明细页给 `data-subtotal-before/after/delta`（整数分）；`<view>/api/gates` 的 `changes[<id>].owed_by` 指出**谁欠动作**。失败→下一步：`no-op-change`；缺 `basis_unit_price_ref` 的行**明示"未纳入小计"且不可勾选**；`approved_by` 须 `human:*`。界面：变更列表 + **逐行差异编辑器**（原量×原价只读 → 新量可编辑 → 实时差额）+提出变更（无义务，可真写）+批准变更 = **签名对话框** + 供应商回应双向可见。
真源 `src/domain/change/code/change.py:54/119/145/163/187/192`。
**现状 👁**。`GET /contractor/changes/chg-0001/ 200`；`POST /contractor/changes 404`、`…/chg-0001/approve 404`。**最刺眼**：`/contractor/api/gates` 给 `changes[chg-0001].next_action` 直接是**一条终端命令** `PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3` —— 产品在页面上明示"请回终端"。**DEF-018**（终端命令呈现另见 DEF-032）

**C11 审计与证据包（月度/收尾）** 输入：范围（包/时间窗/参与方）+ 是否附包含证明 + 格式。反馈：证据包文件（`manifest.count` + 逐条事件 + 哈希链）+ **独立校验结果**（逐项 pass/fail）。失败→下一步：校验失败要指出**第几条**与类型；账本不可读 ⇒ 宁可不导出。界面：证据面页 +导出证据包（范围选择器）→下载 + 验证一个包 → 逐项结果表 + **校验链接可分享**。
真源 `export/code/export.py:107`、`tools/audit-verify.py`。
**现状 👁**。`GET /contractor/evidence/?limit=200 200`（计数与类型分布）；`POST …/evidence/export 404`。导出审计包**终端也无面向用户的入口**（只有 `audit-verify.py` 校验**已存在**的包）。**DEF-029**

### 2.2 供应商销售/投标人：我的一天（S1–S10）

**S1 看自己的 RFQ 包（09:00）** 反馈：**只出自己那份**（包 id、`@rev`、报价/澄清截止、行项目含 `spec_ref`、附件清单、rev 历史与本次变更点）。失败→下一步：无投递事实 ⇒ 显式 `degraded + reason`，**不编包**。界面：「我收到的包」列表（徽标 `未见`/`已认收`/`草稿`/`已准备提交`/`已被新版作废`）+ **包详情页**（条目表/规格/rev 差异/进度条）+ 截止倒计时（事实时刻）。
真源 投递事实投影 `projection.projectWithAudit(…,{deliveries,realms})`+ 字段白名单（`webui.mjs:2100-2120`）；`docs/design/26-rfq-delivery-visibility.md`。
**现状 👁（不足）**。实测 `/supplier/` 有 `data-rfq="inbox"`、`data-rfq-count="1"`、`pkg-g1 @rev1`、`2 条（L-001×120m、L-002×480kg）` —— **根因已修**。但**无包列表页**（`GET /supplier/rfq/ 404`）、**无详情页**（规格/附件/rev 差异看不到）、`rfq_delivery_max=8`（多包截断成 omitted）。**DEF-005**（多包截断另见 DEF-033）

**S2 认收（09:10）** 输入：`package_id` + `seen_rev` + 可选备注。反馈：`rfq/acknowledged`；**承包商侧**未回名单里我从未回 → 已认收（`data-responded-count` +1）。失败→下一步：`package-not-found`；`rev-out-of-range`。界面：包详情顶部**一个大按钮**「我已收到 @revN」+ 徽标变化。
真源 `RfqService.deadline_status`。
**现状 ❌**。实测 `POST /supplier/rfq/pkg-x/ack 404`；无任何认收事实类型消费者。**DEF-016**

**S3 提问澄清（09:30）** 输入：`package_id` + `rfq_rev` + `refs`（条目引用，**至少 1 项**）+ `question`（≤500 字）。反馈：`clarification/asked`；**承包商侧**立刻出现"待你回答"；答复后我侧 `open→answered`、答复正文可见。失败→下一步：`clarify-ref-missing`；已回答的 rev 复用要报"请按该版本重新提问"。界面：工单列表 + **新建工单**（条目多选器：从包的行项目里勾）+ 问题文本框 + 线程视图 + FAQ 沉淀复用。
真源 `clarify/code/clarify.py:55`；FAQ `faq/code/faq.py`。
**现状 ❌（看得到、问不了）**。实测 `POST /supplier/clarifications/ask 404`、`POST /supplier/clarify 404`。**DEF-015**

**S4 备报价（行项目/单价/交期/备注，草稿可续）★唯一真能闭环的一步** 输入：`rfq_id`/`item_id`/`unit_price_cents`（**整数分**）/`lead_time_days`/`currency`/`prepared_by`（须 `human:*`）/`note`（只留 sha256 进账本，正文留 0600 待办件）。反馈：`202` + 待办件 id；消费后 `quote/drafted`（**非签名动作**）；**承包商侧**看到「供应商 X 已准备报价（待签署）」。失败→下一步：字段级 `errors[{field,code,message,next_action}]`：`rfq-not-found`/`item-not-found`/`unit-price-out-of-range`/`lead-time-out-of-range`/`prepared-by-required`；**越界一律拒、不夹取**；提交失败时**什么都没落盘**。界面：**行项目表格**（每行一个条目，列=单价/交期/备注，**一次提交整张表**）+ 行内校验（红框 + 字段级文案）+ 实时小计（整数分）+「保存草稿」/「下一步：签署」+ **元→分换算提示**（防 ×100 错）。
真源 `src/domain/quote-prepare/code/quote-prepare.mjs`；落账 `tools/quote-draft.py`。
**现状 ✅（有实质限制）**。实测 `GET /supplier/quotes/prepare/ 200`、`POST 202`（`qd-supplier-87c9f2b5bdea`，`pending=quote-drafts/…json`）。限制：① 表单**单行**（`FIELDS` 只有单个 `item_id`/`unit_price_cents`/`lead_time_days`，`quote-prepare.mjs:110-123`）⇒ 2 条行项目要提 2 次，**没有"一份报价 = 多行"的概念**；② 提交后仍需回终端跑 `tools/quote-draft.py --now <ISO>` 才落账；③ 页面自述"本 APP 不代签"。**DEF-006**

**S5 签名提交报价（人工门：签名）** 输入：`draft_id` + `actor`（须 `human:<具名>`）+ `approval_id` + `comment`（逐字落 `approval/granted.comment`，**不进** `quote/submitted` body）。反馈：`approval/requested→granted→quote/submitted`（顺序不可颠倒；无批准记录的提交路径是 INV-005 禁止项）；**承包商侧**立刻看到这条报价。失败→下一步：`human-required`（非 `human:` ⇒ 退出码 2，**连空账本都不创建**）；`draft-not-found`；幂等（同草稿再签 ⇒ `duplicates`、账本零新增、退出码 0）。界面：**签名对话框**（§3.5：行项目/金额（整数分）/币种/交期/载荷指纹 sha256 → 身份 step-up → 「以 human:chenmin 签名提交」）+ 事后"我签过什么"清单（可导出）。
真源 `tools/quote-sign.py`。
**现状 ⌨ 必须回终端**。实测 `POST /supplier/quotes/submit 404`；页面给的是**可复制命令**，并写死「**本 APP 不代签**」（`prepSignatureHtml`，`webui.mjs:1848-1862`，带 `data-signature-required="1"`）。**29 §1 明确要求人工门"在界面上可点、可等、可催、可签"** ⇒ 最核心的一条缺陷。**DEF-007**（签名机制见 DEF-003）

**S6 改报（RFQ 出新 rev 后重报）** 反馈：本侧可见"我的 rev1 报价已被 rev2 作废"；按新版重报后新报价 `active`、旧的进 `superseded`。失败→下一步：`rev-stale`（旧 rev 提交被拒，给"按最新 rev 重填"链接 —— **不是**一键提交）。界面：包详情页 **rev 差异高亮**（哪几行量变了）+「按 rev2 重报」按钮（**预填，不自动提交**）+ 报价状态轨（`active`/`superseded`/`requote-requested`）。
真源 `quotes.py:62/105/112/108`、`rfq.py:220/393`。
**现状 ❌**。实测 `POST /supplier/quotes/q-1/amend 404`；无任何页面呈现 `superseded`/`requote`。**DEF-017**

**S7 谈判（承诺/反提案/接受）** 输入：`thread_id` + `move`（维度+值）+ `rationale` + 让步请求 + `outcome`。反馈：轮次记录（`rounds_used`/被拒次数）+ **让步边界**（`derive_bounds` 派生区间）+ 具名超界错误（`ConcessionLimitExceeded`/`ConcessionBelowFloor`/`ConcessionOutOfBand`/`RoundLimitExceeded`/`NegotiationRoundConflict`）。失败→下一步：超界要**说明越界多少、边界来自哪条策略**；轮次上限 ⇒ 给"申请加轮"（走人工门）。界面：**谈判线程视图**（轮次时间轴 + **让步边界条**：当前值/我的底线/政策上限三色 + 反提案表单 + 接受/拒绝 +「还差几轮」）。
真源 `src/domain/negotiation/code/negotiation.py:382/429/448/474/518/555/562`、`derive_bounds`。
**现状 ❌（谈判）+ 👁（只出计数）**。实测 `GET /supplier/api/negotiation 200`（461 B，「只给计数」threads/rounds/rejected，`webui.mjs:2171-2176`）；`POST /supplier/negotiate/round 404`、`…/counter 404`。**DEF-020**

**S8 承诺交期（产能日历、冲突提醒）** 输入：`quote_id`/`lead_time_days`/`quantity` + 产能日历（按天可用产能）。反馈：`capacity/committed`；**可行性** `feasibility`（需要的日产能 vs 可用）；**冲突标记** `conflict_flags`；**已定交期 `firm_dates` 人不可改**（`FirmDateImmutable`，改即产生新 revision 并留痕）。失败→下一步：不可行 ⇒ 明确给"最早可行交期"与差多少产能 / 要么缩量；`FirmDateImmutable` ⇒ 只能走"改期"（留痕）。界面：**产能日历热力图**（按天：可用/已承诺/冲突）+ 承诺表单（实时可行性）+ 冲突告警条 +「改期」留痕表单。
真源 `src/domain/capacity/code/capacity.py:112/139/181/216/239`、`Calendar.set_day/window`。
**现状 ❌**。实测 `GET /supplier/capacity/ 404`、`POST /supplier/capacity/commit 404`。**DEF-021**

**S9 登记回文承诺（"我周五前一定回"）** 输入：`id`（RFQ id）/`by`（`human:*`|`agent:*`）/`due_at`（ISO）/`note`（原话，只留 sha256 进账本）。反馈：`202` + 待办件 → `tools/rfq-promise.py` 落 `rfq/promised`（body 恰 6 键）；承包商侧 `due_ts` 更新为"来自事实 `rfq/promised`"。失败→下一步：`rfq-not-found`；`actor-malformed`；`empty-note`；**本脚本不发信**（登记 ≠ 已通知）。界面：包详情页「我要晚点回」按钮 + 日期时间选择 + 原话框。
真源 `src/domain/rfq-deadline/tools/rfq-promise.py`。
**现状 ⌨（且供应商侧不可用）**。同一份表单：**承包商侧** `POST 202`（`rp-contractor-ec99ceb8579d`）；**供应商侧** `POST 404 rfq-not-found`（`pkg-g1` 只在投递信封里、不在供应商账本的 `rfq/published` 事实行里 ⇒ 同一份包"首页看得见、承诺时说不存在"）。落账还要回终端跑 `tools/rfq-promise.py`。**DEF-024**

**S10 中标/落标通知与 PO 确认** 输入：`award_id` + `supplier_confirmed` + `can_meet_due` + 备注。反馈：中标：我侧"已授标（待我确认）"→ 我确认 → 承包商侧 `supplier_confirmed=true` → 授予成立；落标：一条"本次未中选"（**不含**其他供应商信息与比价基准）；PO 签发后我侧看到 PO 并可确认。失败→下一步：`supplier_confirmed=true` 且 `can_meet_due=false` ⇒ **要求备注非空**（避免"确认了又交不了货"）。界面：「我的授标」列表（意向→待确认→已确认→PO 已签发）+ 确认表单（`declared_by` + 能否按期）+ **落标通知**（一句话 + 原因类别 + 可申诉入口 P2）+ PO 确认视图。
真源 `commitments.py:101`、`award/committed`/`po/issued`。
**现状 ❌**。实测 `GET /supplier/award/ 404`、`POST /supplier/award/aw-0001/confirm 404`、`POST /supplier/po/po-0001/confirm 404`；全仓 `grep 落标` **零命中** —— 落标通知这个概念在代码里**根本不存在**。**DEF-022**

### 2.3 共同侧（G1–G8）

| 步 | 我要做的事 | 现状 | 证据（路由/源码） |
|---|---|---|---|
| G1 | **审批队列**：看每批金额/等待时长/卡在谁，催办 / 升级 / 终止 | 👁 + 一个「催办」（还要回终端才落账）；**升级与终止无入口** | `GET /<view>/gates/ 200`（`age_basis=facts-only`）；`POST /<view>/gates/nudge 404 gate-not-found`；`ApprovalService.sweep`（`approval.py:199`）管 `remind/escalate/abort` 但**无 UI 无 CLI** |
| G2 | **授权区间**：这笔钱落在谁的范围，越界找谁 | 👁 能算（落哪/越界多少/下一角色）但不落事实、不能批准 | `GET /contractor/authority/?amount=1&role=buyer 200`；`authority.bands.*`（`webui.mjs:1528-1784`） |
| G3 | **比价 heuristics 口径** | 👁 只算，不落事实、不能导出、无供应商列 | `GET /<view>/heuristics/ 200`；`domain/bid-heuristics/code/bid-heuristics.mjs` |
| G4 | **截止看板** | 👁 只能看 | `GET /<view>/deadlines/ 200` |
| G5 | **邮件通道状态**（SMTP/IMAP 通不通） | 👁 只能看；改配置要提权到 admin 道 | `GET /ops/mail/ 200`（`webui.mjs:426`）；`GET /admin/config/` 未提权 ⇒ 401 |
| G6 | **用户空间插件自建视图** | ❌ 业务视角**看不到自己的插件**（槽位只有 `page.home/contractor/supplier/ops/admin` 5 个，`ui-slot.mjs:30`）；装卸只在 admin 道（要提权） | `GET /api/ui/blocks`；`POST /admin/api/user-plugins/<load\|unload\|reload>`（`auth: admin-session`）。**DEF-026** |
| G7 | **通知与催办**（"有 3 件待我处理"） | ❌ 无通知中心、无徽标、无轮询/推送；页面纯 SSR（**0 行 `<script>`**） | `webui.mjs:61-70`（`html()` 只有一个 `nav`）；无 `/api/notifications`。**DEF-028** |
| G8 | **身份与签名**（我是谁、我签了什么） | ❌ **业务视角完全没有身份**：`/contractor/**`、`/supplier/**` 全 `auth: 'none'`（70 条路由里 31 条业务只读、15 条 admin 鉴权）；只有一个管理员 token 换 cookie 的 `POST /admin/api/elevate`。**这直接堵死了"界内签署"** | `webui.mjs` 路由表 `auth` 字段。**DEF-001** |

## 3. 信息架构与界面清单（从工作流反推）

### 3.1 应用外壳（P0 必做，缺它一切皆空）

现有 `html()` 只输出「一个 `nav` + 标题 + 正文」（`webui.mjs:61-70`）。目标外壳（参照 VS Code / DeepSeek harness 形态）：

| 区域 | 必须能干什么 |
|---|---|
| **顶栏** | 视角切换（承包商/供应商/共同侧）、全局搜索、**通知铃（未读计数）**、**命令面板入口**、当前身份与退出（`Cmd/Ctrl+K` 命令面板 · `Cmd/Ctrl+Shift+N` 通知中心 · 点身份切换/登出） |
| **左导航** | 按**岗位模块**分组（工作台/包/报价/比价/授标/PO/变更/澄清/谈判/产能/审批/授权/证据/设置）+ **待办徽标**（待批 N/待答 N/快到截止 N）；可折叠、宽度可拖拽（持久化）、`Cmd/Ctrl+B` 收起；每项有**深链** |
| **主区 / 上下文面板 / 状态栏** | 主区 = 当前视图 + **面包屑**（包 › 报价 › 比价）+ 多标签页（重排/中键关闭/`Cmd/Ctrl+W`/`Cmd/Ctrl+1..9`）；右侧 = 当前实体详情·事实时间轴·下一步建议（`Cmd/Ctrl+I` 收展，随选中行变化）；底部 = 待我处理的门数 / 账本校验状态 / 连接与视角 / 事实时刻 `as_of`（可点跳转） |
| **命令面板** | `Cmd/Ctrl+K` 模糊搜「动作+视图+对象」：`开新 RFQ`/`批准 ap-0007`/`跳到 pkg-g1 比价`/`导出证据包`；权限过滤（**做不到的动作不出现**，不是灰掉）；上下+Enter，`?` 显示可用快捷键表 |
| **通知中心** | 待办（待批/待答/快到截止）/ 结果（报价被退回、中标、PO 签发）/ 失败（邮件通道不可用）；每条带**一行内联动作**（去处理/催办/稍后）；未读徽标、已读、全部标已读、`Esc` 关闭 |

**纪律**：外壳**零业务语义**（29 §3）——只提供布局与槽位、命令与动作总线、表单与校验、通知与确认、导航与深链、键盘与可访问性；**功能由插件注册进来**。新增槽位改 `ui-slot.mjs` 的 `SLOTS`（现 5 个），新注册项进 `/api/routes`（现 70 条）。

### 3.2 视图清单（每屏要能干什么 + 写操作 + 门）

记 `P = /quotagent/<view>`；**✍** = 真写操作，**门** = 必须等人工门（界内签名见 §3.5）；除标「已有」外均为新增。

| 视图（路由） | 谁用 | 关键动作（✍ / 门） |
|---|---|---|
| V1 工作台 `P/` | 双方 | 今日待办（待批/待答/快到截止）、进行中的包、**每条待办一行内联动作** |
| V2 包 `P/packages/`、`P/packages/<id>/`、`P/api/packages` | 双方 | 承包商建包/改包/邀请/催报/发新版；供应商看包/认收/看 rev 差异/开始报价 ｜✍ 建包改包邀请催报发新版**认收**；门：发新版 |
| V3 报价 `P/quotes/`、`P/quotes/<id>/`、`P/api/quotes`、`P/quotes/prepare/`（已有） | 双方 | 承包商按包分组收件箱、行级明细、受理/退回/要补件（批量）；供应商状态轨、**多行表格编辑器**、存草稿 ｜✍ 受理/退回、草稿；门：提交报价（`quote.submit`） |
| V4 比价 `P/compare/?package_id=`、`P/compare/weights`、`P/compare/export.csv` | 承包商 | 比较矩阵、权重滑块、贡献分解、偏差面板、导出 CSV ｜✍ 存权重为事实（不改判定） |
| V5 授标 `P/award/`、`P/award/<intent_id>/`、`P/award/intent`、`P/award/<id>/{withdraw,commit,confirm}` | 双方 | 承包商提意向/撤回/承诺；供应商看意向、确认中标/落标 ｜✍ 提意向、撤回（无义务）、确认；门：承诺授标（`award.commit`） |
| V6 PO `P/po/`、`P/po/new?award_id=`、`P/po/<id>/`、`P/po/issue` | 双方 | 承包商签发预览（逐行来源链）、签发；供应商看 PO、确认 ｜✍ 签发、确认；门：发 PO（`po.issue`） |
| V7 变更 `P/changes/`、`P/changes/new`、`P/changes/<id>/`、`P/changes/<id>/{approve,respond}` | 双方 | 逐行差异编辑器、提出、**批准**、供应商接受/异议 ｜✍ 提出、回应、批准；门：变更批准（`change.approve`） |
| V8 澄清 `P/clarifications/`、`P/clarifications/<ticket>/` | 双方 | 供应商提问；承包商回答 + **广播**；关闭；FAQ 沉淀 ｜✍ 提问/回答/广播/关闭/发 FAQ（回答人与 FAQ 发布须 `human:*`） |
| V9 谈判 `P/negotiate/`、`P/negotiate/<thread_id>/{round,concession,close}` | 双方 | 线程时间轴、让步边界条、提交轮次、反提案、接受/关闭 ｜✍ 开线程/声明边界/让步/提交轮次/关闭；门：超政策边界、轮次上限加轮 |
| V10 产能 `P/capacity/`、`P/capacity/{commit,<id>/amend}` | 供应商 | 日历热力图、可行性试算、承诺交期、冲突告警 ｜✍ 承诺、改期（留痕；已定交期不可改） |
| V11 审批 `P/approvals/`、`P/approvals/<id>/{decide,escalate,abort}` | 双方+审批人 | 门卡片、签名批准、驳回、催办、升级、终止 ｜✍ **签名批准**/驳回/催办/升级/终止（本身即门） |
| V12 授权区间 `P/authority/` | 双方 | 金额试算（整数分）、落在谁的区间、越界多少、下一角色（不写；配置在 admin/config） |
| V13 证据 `P/evidence/`、`P/evidence/{export,verify}` | 双方 | 事实计数与类型分布、**导出证据包**、验证一个包 ｜✍ 导出（落文件+事实） |
| V14 通知 `P/notifications/` | 双方 | 待办/结果/失败三类，逐条内联动作 ｜✍ 标已读、逐条处理 |
| V15 插件面 `P/plugins/` | 双方 | 用户空间插件注册的视图/动作/按键出现在**自己的视角**里 |
| V16 设置 `P/settings/` | 双方 | 身份与签名方式、通知偏好、布局持久化、邮件通道状态 ｜✍ 改偏好（非账本）；凭据/配置 ⇒ admin 道 |

### 3.3 交互方式清单（每类落到具体屏）

| 交互能力 | 用在哪 | 机制要点 |
|---|---|---|
| **表单+校验** | 建包向导、报价行表、催报、回答澄清、承诺交期 | 客户端即时校验 + **服务端权威校验**；失败回**字段级** `errors[{field,code,message,next_action}]`（`quote-prepare` 已这形状，照抄）；**越界一律拒、不夹取** |
| **可编辑表格** | 包的行项目、报价行项目、变更新量 | 加/删/复制行、粘贴 TSV；单元格内联校验；实时小计（**整数分**）；`Tab`/`Enter` 流转；未保存离开拦一次 |
| **批量操作** | 催报（勾未回）、受理多份报价、关闭多个工单、标通知已读 | 全选/反选 + "已选 N" 浮动条；批量动作**逐条返回结果**（部分失败逐条列出，不许一句"部分失败"） |
| **筛选/排序** | 包列表、报价收件箱、审批队列、事件流 | 列头排序、多条件筛选（可存"我的视图"）、**参数全进 URL** ⇒ 可分享；空结果显式 `data-empty` + `reason` |
| **拖拽 / 右键菜单** | 行序、标签页、侧栏宽度、列序；包行/报价行/通知 | 拖完立即持久化（布局进用户偏好，不进账本）且**必须有键盘等价操作**；右键动作按权限与状态过滤，菜单项带快捷键提示 |
| **快捷键** | 全局 `Cmd/Ctrl+K`、`B`、`I`、`W`、`Shift+?`；列表 `j/k`/`Enter`/`x` | 快捷键**由插件注册**（29 §3 注册面第 2 类），冲突时外壳给具名错误 |
| **命令面板** | 搜「动作+视图+对象」 | 命令 = `{id, 标题, 入参 schema, 权限, 确认策略, 后端动作}`；**做不到的动作不出现**；入参不齐就地弹字段 |
| **通知与催办** | 待批/待答/快到截止/被退回/中标/PO 签发/邮件不可用 | 通知有 **id + 类别 + 对象深链 + 内联动作**；催办后显示"已催 N 次 @ts"；**不取墙钟**（用事实时刻） |
| **深链与分享** | `/contractor/packages/pkg-g1/`、`/supplier/approvals/ap-0007/`、带筛选的列表 | 深链可粘贴到邮件/Teams，打开即定位；**不泄露私域**（对方视角打开同一条深链必须 404 或明确无权限，不得回落到"能看"） |
| **空态/错误态/加载态 + 可访问性** | 全部列表与面板 | 空态写清 `reason` 与下一步；错误态给**可复制的下一步**（29 §4 末句原话）；加载态不许伪装成空态（保留现有 `degraded+reason`）；全站键盘可达（不用鼠标走完全部流程）、焦点可见、`aria-*`、对比度 |

### 3.4 写操作 × 门控 × 唯一写者

**铁律（29 §3）**：GUI 的动作只**发起**；对外承诺类动作仍必须经人工门与既有唯一写者落账本；**GUI 不是第二条事实写路径**。
**本轮口径（对齐 29 §1/§4 的"界内可签"）**：人工门在界面上**可签** = 浏览器动作由插件提供的**服务端一半**（29 §3 注册面第 4 类）去调用**同一个**唯一写者，`actor` 写成**已认证的具名人类**（`human:<name>`）。判据不变：**唯一写者仍是那一处**，账本新增行必须带 `human:*` 与签名记录。

**已有唯一写者（直接用，别重写）**：`tools/quote-draft.py`（`quote/drafted`，非签名）、`tools/quote-sign.py`（`quote.submit`，唯一带人签的门）、`tools/gate-nudge.py`（`gate/nudged`）、`tools/rfq-promise.py`（`rfq/promised`）、`tools/audit-verify.py`（验证）、`tools/ui-feedback-apply.py`、`tools/config-apply.py`、`tools/admin-apply.py`。

**待建写者（每个动作一个，全部照同一规格）**：`rfq-draft.py`（建包/改包/邀请）｜`rfq-publish.py`（**发布/发新版，人签**）｜`rfq-remind.py`（催报，`RfqService.remind`）｜`rfq-ack.py`（认收）｜`clarify-apply.py`（提问/回答/广播）｜`quote-review.py`（受理/退回）｜`compare-weights.py`（存权重）｜`award-intent.py`（提/撤意向，无义务）｜`award-commit.py`（**授标承诺，人签**）｜`award-confirm.py`（供应商确认中标）｜`po-issue.py`（**发 PO，人签**）｜`change-propose.py`（提出变更）｜`change-approve.py`（**批准变更/价格让步，人签**）｜`change-respond.py`（供应商回应）｜`negotiate-round.py`（谈判轮次/让步，超界需批准）｜`capacity-commit.py`（承诺交期/改期留痕）｜证据包导出。

**人签的五个动作**（`ADR-0013` 五件事，现由 §3.5 的 `SignAction` 在界内完成）：批准 `approval.decide`｜提交报价 `quote.submit`｜定标 `award.commit`｜发 PO `po.issue`｜变更批准 `change.approve`。

**待建写者统一规格**（照抄现有三件，别发明第四种）：权限门（待办件**恰为 0600**、普通文件）→ 形状门（`schema`/`kind`/`view`/动作）→ **重算校验**（`*_sha256` 与 `bytes` 用文件内容重算比对，`submitted_at` 必须为空 —— 宿主不取墙钟）→ 业务前置（目标必须真在本视角投影里）→ 落一条事件（body 只带结构化字段与哈希，**不含正文、不含凭据**）→ 待办件移进 `applied/`（不删，幂等可观察）→ stdout 恰一行 JSON，退出码 `0/1/2`；拒绝路径**逐条**给 `code` + `next_action`，**拒绝时零写账本**。

### 3.5 身份与签名（界内签署机制；P0 前置）

现状：业务视角 **31 条路由全 `auth: 'none'`**，全站唯一身份是管理员 token（`POST /admin/api/elevate`，cookie 只对 `/admin/**` 生效，`webui.mjs:2196-2200`）。没有身份就不可能"界内签署"——**这是 29 §1 与现状之间最大的结构性缺口**。要做五件事：

1. **业务用户登录** ⇒ 会话绑定 `human:<name>`；视角与身份**必须匹配**（供应商身份不得打开 `/contractor/**`，深链也不例外）。
2. **签名对话框 `SignAction`**（外壳机制、插件声明策略）固定四段：**签什么**（对象 id/金额（**整数分**）/币种/行数/`as_of`）· **载荷指纹**（服务端对只读事实拼串算 `sha256` **+ 可复制的终端等价命令**）· **我是谁**（`human:<name>` + step-up：口令/一次性码/硬件密钥，按部署配置）· **后果**（"产生对外义务，签名后写入账本，不可撤销（只能再走一次变更）"）。
3. **签名即事实**：服务端一半校验会话 → 生成签名记录（`actor=human:<name>`、`payload_sha256`、`ts`）→ 调用唯一写者 → 返回**增量**（结果/待办件/需刷新的视图/下一个 `next_action`）。
4. **不可代签**：`agent:*` 调用签名动作一律拒（沿用 `human-required` 语义）；UI 不得出现"以 agent 身份批准"。
5. **可审计**："我签过什么"清单（时间/对象/指纹）可导出，与证据面同源。

这样既不新增第二条写路径（29 §3 不变），又满足"人工门在界面上可点、可等、可催、可签"（29 §1/§4）。

## 4. 与 29 §4 对齐、核对表与排期

### 4.1 `docs/design/29-webui-gui-app.md` §4 逐条对齐

| 29 §4 条目 | 步 | 能做到吗 / 缺口 |
|---|---|---|
| 承包商：创建/发布 RFQ（行项目、币种、截止、邀请供应商） | C1 | ❌ 无建包/发布入口（仅终端硬编码走查） |
| 承包商：看谁收到/谁没回/还差多久 | C2 | 👁 无包列表/详情页，只出最新一包 |
| 承包商：催报与答疑（提问、业主回答、广播） | C3/C4 | ❌ 承包商澄清页 404；催报无入口 |
| 承包商：收报价（归一化、偏差、护栏） | C5/C6 | 👁 无受理动作；Normalize/Deviation/Guard 零 UI |
| 承包商：比价与排序（权重可调、贡献可解释） | C6 | 👁 无比较矩阵/贡献分解/导出 |
| 承包商：人工门：批准/驳回/要变更 | C7 | ❌ 无任何入口（终端也没有） |
| 承包商：授标承诺（人签） | C8 | ❌ 无页面、无 CLI |
| 承包商：发 PO（逐行可追溯） | C9 | ❌ 无页面、无 CLI |
| 承包商：变更与价格让步（需批准） | C10 | 👁 只有只读明细页 |
| 承包商：审计与证据包（导出、验证） | C11 | 👁 只能看计数；导出无入口 |
| 供应商：看自己的 RFQ 包（只出自己那份） | S1 | 👁 根因已修仍不足：无列表/详情页，spec/附件不可见 |
| 供应商：提问/澄清 | S3 | ❌ 无提问入口 |
| 供应商：备报价（草稿可续） | S4 | ✅ 但只支持单行一次；"可续"靠回读 |
| 供应商：提交报价（人工门：签名） | S5 | ⌨ 界内不可签（29 §1 要求可签） |
| 供应商：谈判（承诺/反提案/接受） | S7 | ❌ 只有计数 |
| 供应商：承诺交期（产能日历、冲突提醒） | S8 | ❌ 无产能页 |
| 供应商：中标/落标通知与 PO 确认 | S10 | ❌ `award/lost` 概念在代码里都不存在 |
| 共同侧：审批队列（等多久、卡在谁、可催办/升级/终止） | G1 | 👁 + 催办；升级/终止无入口 |
| 共同侧：授权区间 | G2 | 👁 只算不落事实、不能批 |
| 共同侧：比价 heuristics | G3 | 👁 不落事实、无供应商列 |
| 共同侧：截止看板 | G4 | 👁 无动作 |
| 共同侧：邮件通道状态 | G5 | 👁 配置要提权 |
| 共同侧：用户空间插件（自建视图） | G6 | ❌ 业务视角看不到自己的插件 |
| 29 §4 末句：每步都能在 APP 内闭环（含写操作）+ 失败给可复制的下一步 | 全部 | 部分成立：各页 `degraded+reason+next_action` 是好底子，扩到新页面 |

### 4.2 「仅用 GUI 可完成」核对表

| 判定 | 步数 | 清单 |
|---|---|---|
| ✅ 能 | 1 | S4 |
| 👁 只能看 | 6 | C2 C5 C6 C10 C11 S1 |
| ⌨ 必须回终端 | 2 | S5 S9 |
| ❌ 做不到 | 12 | C1 C3 C4 C7 C8 C9 S2 S3 S6 S7 S8 S10 |

按用户口径：承包商 11 步里 **0 步**能完整做完；供应商 10 步里 **1 步**能完整做完（还只支持单行）⇒ 29 §1 的"完成"标准**尚未达到**。

### 4.3 排期

**P0 —— 一条真实闭环**：① **应用外壳 V0**（顶栏 + 按岗位模块的左导航 + 主区 + 面包屑 + 状态栏 + 通知区 + 命令面板骨架；槽位扩到 `page.<view>.<module>`；布局持久化——无此则后面每屏都要重造导航）。② **身份与签名 V0**（§3.5）。③ **供应商闭环**：S1 包列表/详情 → **S4 报价表（多行一次提交）** → **S5 界内签名提交**（写者用现成 `quote-draft.py`/`quote-sign.py`，只补服务端一半与 UI）。④ **承包商闭环**：C1 建包/发布（新写者 `rfq-draft.py`/`rfq-publish.py`）→ C5 报价收件箱 → C6 比价矩阵 → **C7 批准（界内签名）** → **C8 授标承诺**。⑤ 每条写动作同批交出终端消费者，并受现有 405 假成功围栏（`webui.mjs:93-142`）同规格约束。

**P1 —— 剩余双方流程逐条搬进来**：S2 认收、S3 提问澄清、C4 答疑（含承包商侧工单页）、C3 催报、C10 提变更 + **批准变更**、C9 发 PO + 追溯、S10 中标/落标 + PO 确认、S6 改报（rev 作废可视化）、S7 谈判（线程+边界条）、S8 产能日历、C11 证据包导出+验证、G1 升级/终止、G2 授权区间接进批准流、G6 业务视角可见自己插件、G7 通知中心。

**P2 —— 打磨**：命令面板全量动作与对象搜索、快捷键表与冲突提示、右键菜单、拖拽（行序/列序/标签页）、可访问性、空态/错误态文案统一、布局持久化、对比模式与列固定、批量操作全量铺开、导出/打印 PO、通知偏好。

### 4.4 验收口径（怎么判"用户能做完"）

取代"门全绿/结构锚点/快照 hash"（29 §2.2 禁止）：① **逐步可点** —— 对 §2 的 21 步各写"从空状态 → 完成"的操作序列（谁在哪个 URL 点哪几个控件），断言**账本多了哪条事实**（`type` + 关键 `body` 键）；② **双向可验** —— 每个动作在**对方视角**有一条可断言的可见变化（把 `ui-workflow-rework-part2.md` §3.4 的表扩到全部动作），只在本侧可见 = 未完成；③ **不许回终端** —— 21 步的操作序列里不得出现任何终端命令（终端等价命令只能是"进阶提示"）；④ **失败可复制** —— 每个失败路径给 `code` + 人话 + 可复制的下一步；⑤ **边界不越** —— 签名动作必须由具名 `human:*` 完成、`agent:*` 一律拒，私域（成本模型/底标/其他供应商报价）不得出现在任何页面或 JSON（沿用哨兵断言）；⑥ **空态不装死** —— `degraded`/`reason`/`omitted`/`counts` 如实渲染，不把"读不到"渲染成"零条"。

## 5. 与既有文档的关系

- `docs/design/29-webui-gui-app.md` —— **口径真源**：本文件把它 §4 每一条落到「步骤/路由/交互/写者」。
- `docs/work/plans/ui-workflow-rework.md` / `-part2` / `-part3` —— 同批工作的**前置版**（EV-158，当时"能完整完成的步骤 = 0"）。**差异**：那批把"网页永不签"当铁律（part2 §3.5），而 29 §1/§4 现在要求人工门"**可签**"。本文件按 29 修正：**签署进界内**（插件服务端一半调用同一个唯一写者，见 §3.5），终端命令保留为等价路径。part2 §3.2/§3.3 的**页面与字段清单仍有效**，可直接复用。
- `docs/design/26-rfq-delivery-visibility.md`（S1 投递事实口径）、`21-admin-console-contract.md`（admin 写面契约）。
- `docs/work/functional-requirements.md` —— `FR-UXWEB-001/002`、`FR-USREQ-001..012` 是硬需求；注意 `FR-UXWEB-001` 里"页面保持 0 行 `<script>`"与 29 §1"允许前端框架"**冲突**，应按 29 §2 修正。

## 6. 实测原始记录（本文件所有"实测"的出处）

前缀 `http://127.0.0.1:8093/quotagent`（`node host/cli.mjs webui --ui-shared tmp/ui-shared`）。**真受理（202）**：`POST /supplier/quotes/prepare/`（`id=qd-supplier-87c9f2b5bdea`）、`POST /contractor/deadlines/promise`（`id=rp-contractor-ec99ceb8579d`）。**业务拒绝（400/404 + code）**：`POST /contractor/gates/nudge → 404 gate-not-found`、`POST /supplier/deadlines/promise → 404 rfq-not-found`。**其余 21 类业务动作一律 404**（开包/发布/催报/认收/提问/回答/广播/受理报价/比价/导出/批准/授标意向/授标承诺/发 PO/提变更/批准变更/提交报价/改报/谈判轮次/产能承诺/中标确认/PO 确认/证据导出）= "UI 上没有这个入口"。**读得到（200）**：`/contractor/{quotes,approvals,evidence,changes/<id>,deadlines,heuristics}`、`/supplier/{events,quotes,clarifications,quotes/prepare,api/negotiation}`。

**页面纪律**：抽查 8 页 `script=0`；`inline_event=1` 是 grep 命中 `data-contribution=` 的假阳性；`/admin/config/` 未提权 ⇒ 401。

**路由表**：`/api/routes` 共 70 条；`write_surface.browser_writable` 仅 4 类 —— `/quotagent/admin/**`、`/quotagent/<view>/gates/nudge`、`/quotagent/<view>/deadlines/promise`、`/quotagent/supplier/quotes/prepare/`；note 逐字：「浏览器永远不能签的五个动作：批准 / 提交报价 / 定标 / 发 PO / 变更批准（人工门在终端）」
