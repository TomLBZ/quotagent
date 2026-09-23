# 29 归档 —— WebUI/GUI 应用：详细判据、形状与逐条读数

<!-- 本文件是 `docs/design/29-webui-gui-app.md` 的归档（预算沿用 `docs/design/*.md` 行 = 28 KB）。
     规则与口径真源仍是主文件；主文件同号小节是本文件该节的判据真源，本文件只放**细节**（字段形状、
     行级矩阵、路由清单、实测读数）。归档不是豁免区：受同一套 `tools/check-docs.py`（ID 完整性/预算/覆盖）。 -->

为什么有这份文件：主文件受 28 KB 硬预算（`docs/design/12-documentation-standard.md` §1）。按仓规的减法顺序
（删重复 → 删叙述 → 拆到归档 → 才考虑提预算），把**字段形状 / 逐条矩阵 / 路由清单 / 实测读数**逐字搬来，
**主文件的判据与禁止一条未删**（每条在主文件里仍有「能力 / 判据 / 禁止 / 真源」四行）。搬进来的行逐字保留。

## 7 台账与持久化的存储形状与拒绝码

1（形状与有界）：通知偏好与已读落 `<ui_shared>/webui/notif-state.json` —— 目录 0700 / 文件 **0600**、
   原子写、有界（read ≤ 1000、静音 ≤ 50、身份 ≤ 64）。形状不对的**丢掉并如实计数**在 `dropped` 里。
2（一份报价的拒绝码）：缺行/改行一律**有名拒绝**：待办件被改 ⇒ `pending-tampered`、行项目不在事实里 ⇒
   `line-item-not-found`、账本里的草稿自述与重算不符 ⇒ `draft-tampered`（三者账本零新增）。
3（文件权限的共同纪律，名册/协作/附件/版本/导出偏好同源）：目录 0700、文件 **0600**、原子写、**显式 chmod**
   （不受 umask 影响）、**有界**（超限**如实拒**，不静默截断）、**洗净**（坏形状如实降级并计数）。
   它们**都不进账本**（运营状态，不是合同事实；写进账本会改事件类型目录、证据包哈希与审计取证语义）。

## 8 名册与角色的逐条细节

1 额度判据（`policy.amount_limit.rules`）：动作 id → 金额从**哪条事实**取 + 单位 `major`/`minor`；
   超过**我的角色**的 `approval_limit_cents`（整数分；`null` = 不限，**`0` 与「不限」相反**）⇒
   `role-limit-exceeded`，回执给出金额 / 我的额度 / **该找哪个角色**；金额取不到按 `unknown_amount`
   （默认 `refuse`）。
2 转交判据（`collab.assign` 已有人接手时）：只有「**归我**」（当前指派给我）或「**我指派的**」（当前指派
   是我下的）能做，否则要 `policy.transfer.override_roles` 里的角色（默认 `supervisor`/`admin`）——
   拒绝码 `transfer-not-yours`。
3 名册维护的 bootstrap：本侧**还没有管理员**时谁都能先配（界面如实说明）；有了管理员之后，改人 / 改角色 /
   改策略**只有管理员**（`admin-required`）。
4 「登录即登记」：一个名字第一次在某一侧登录 ⇒ 进名册、角色「待指派」（**有名字、没有权限**）；授权由
   同侧管理员在界面上补。名册外且没登录过的人**不假装通知到了**，进 `unresolved`。

## 10 文件交换与可打印文档（对象级附件 / 导出 / 打印）—— 形状与逐条判据

### 10.1 对象级附件（谁都能挂，按对象类声明）

1. **对象类由插件声明**：`system/attachments` 在 `code/ui.mjs` 里按 `(视图, 对象类)` 注册形状为 **`files`** 的面板
   （承包商：`package` / `quote` / `po` / `change`；供应商：`package` / `quote` / `po`）。外壳只按形状渲染
   （拖拽多文件上传区 + 文件表 + 每行下载/删除），**不认识"附件"这个业务概念**（`ui-surface.mjs` 的 `PANEL_KINDS` 加一个值，
   没有一处业务名词）。
2. **形状**（`data()` 返回）：`{kind:'files', files:[{id,name,bytes,sha256,uploader,at,visibility,url,deletable,
   deleted,deleted_by,deleted_at}], upload:{url,kind,id,name_param,visibility_param,visibility:{default,options},
   multiple,max_bytes,accept}, row_actions:['attach.delete'], counts, visibility_rule, reason?, next_action?}`。
   `url` / `upload.url` **只允许本服务前缀相对路径**（`/` 开头）——外站地址一律丢掉并计数（`absolute-url-refused`），
   与 `suggest_url` 同一条纪律：界面不会被引去第三方取/传文件。
3. **上传**：客户端把**原始字节** POST 到声明过的上传地址（原始字节而非 multipart：没有边界串/编码这一层可以搞错，
   大文件也是流式的；文件名与可见性走查询串）。**侧与署名只认会话**（查询串改不动"我是谁"）。

### 10.2 附件**不进账本**（只进 0600 存储）

`<ui_shared>/attachments/`：目录 0700 / 文件 **0600**（原子写、显式 chmod，不受 umask 影响）。
`index.json`（文件名/大小/sha256/上传人/时刻/对象关联/可见性/墓碑）+ `blobs/<sha256>.bin`（**内容寻址**：
用户给的文件名只进索引、不进路径 ⇒ 路径穿越在结构上不可能）+ `journal.jsonl`（**上传与删除的留痕**，append-only）
+ `trash/`（删除时未被别的条目引用才搬过去的原件）。理由与名册/协作面同源：附件是**交付物**不是合同事实，
写进账本会改事件类型目录、证据包哈希与审计取证语义。上传/删除回执里 `ledger_added` 恒为 `0`。

### 10.3 下载按**侧 + 身份**校验（一刀切的两条件）

| 情形 | 判据 | 拒绝码 |
|---|---|---|
| 未登录（读/传/删/列表） | 侧只认会话 | `401 identity-required` |
| 本侧上传的件 | 本侧随便下 | —— |
| 交付件（`visibility=both`） | **且**请求方的侧是该对象的**当事方**（该对象在本侧事实/交换件里可见） | 否则 `403 cross-side-attachment` |
| 本侧内部件（`visibility=side`） | 只在**上传方本侧**可下 | 另一方 `403 cross-side-attachment` |
| 附件 id 形状不对（含路径穿越） | `^att-[0-9a-f]{12}$` | `400 attachment-id-invalid` |
| 超上限（默认 8 MiB）/类型不在白名单/空件/文件名含路径 | 见 `attachments.mjs` 的 `LIMITS` / `ALLOWED_TYPES` | `413` / `415` / `400` |

**拒绝一律零落盘**：所有判据跑在写任何文件**之前**；拒绝路径上不建目录、不写索引、不写日志
（验证脚本用「存储逐文件 sha256 + journal 行数前后一致」断言这一条）。
**删除留痕**：索引留墓碑（`deleted_by`/`deleted_at`）+ journal 记一行（含理由）+ 原件进 `trash/`；
对方在列表里看到的也是墓碑（"谁删的、什么时候"），不是静默消失。**只能删自己上传的**（`403 not-your-attachment`）。

### 10.4 路由**经注册面**（不改 `webui.mjs` 的静态路由表）

`system/attachments` 用 `ctx.inject(['uiRoutes'])` 注册五条路径：`POST /api/attachments/upload`、
`GET /api/attachments/list`、`GET /api/attachments/file`、`POST /api/attachments/delete`、`GET /api/attachments/store`；
**只读路径各带一条 POST 孪生路由返回 `405 + Allow: GET`**（与主文件 §9.3 的方法围栏同口径）。注册表里的 `auth` 是真实值
（`identity-session` / `none`），`/api/routes` 自动登记（`tools/verify.sh quote-draft` 第 ③ 条拿它逐条反查）。
正文由插件**自己**有界读取（不用 `webui.mjs` 那个 16 KiB 的读体夹取：那里会**静默截断**，截断等于把半份文件当完整件存下来）。

### 10.5 导出 / 打印：**声明**由插件给、**内容**由插件生成

1. **`report` 贡献**（`ui-surface.mjs` 的第 ⑧ 类）：`{plugin_id,id,title,views,object_kind?,formats:['csv'|'html'|…],
   action,order?,hint?}` —— 只声明"这个对象/这个视图能以哪几种可读格式导出"，**不生成任何内容**。
   本批三条：`report.po`（承包商 PO）、`report.rfq-package`（双方 RFQ 包）、`report.compare`（承包商比价表）。
2. **入口**：对象页工具栏下的「导出 / 打印」区（每个格式一个按钮 = 打开声明的动作并把 `format` 预填好）；
   视图级导出（比价表）在视图页上。机制只做摆位，不懂内容。
3. **内容**：`host.report(spec)`（`app-shell.mjs` 的**序列化机制**：CSV / 自带样式的可打印 HTML + 内容指纹 sha256），
   `spec` 的 `columns/rows/facts` 全部由**插件自己**从它那一侧的账本行拼出（谁的事实谁导出）；上限有名
   （5000 行 / 4 MiB，超限**如实拒**，不截断成半份台账）。行内带 `source` / `ledger_seq` / `payload_sha256` 这类锚
   ⇒ 打印出来也能逐行对回账本（验证脚本就是这么比的）。
4. **打印**：导出结果在**预览弹层**里给出「打印」（走浏览器打印对话框：导出文档放进隐藏 iframe 打印，
   打印的是那份文档而不是界面；界面另有一份 `@media print` 兜底）+「下载这份文件」。
   `result.export` 是客户端认得的标准形状（`{filename,format,content_type,content,rows,digest}`）。

## 11 沙盘（演示数据）—— 机制细节与边界

### 11.1 机制（外壳）与声明（插件）的分工

1. **外壳只做两件事**：① 把"这一侧的读/写路径"整体切到**沙盘目录**；② 按插件声明的顺序把步骤
   dispatch 到**同一个动作总线**。外壳**不认识任何业务步骤**（它不出现任何插件 id 与领域名词）。
2. **场景由插件声明**：`surface.scenario({plugin_id, id, scenario, scenario_title, title, view?, order,
   steps:[{action, input?, as?:{side}, capture?, optional?, note?}], hint?})`（`ui-surface.mjs` 的第 ⑨ 类）。
   同一 `scenario` 键的多个贡献按 `order` 串成一条流程（例：`demo.procurement` =
   发包（`domain/rfq`）→ 备报价 + 人签提交（`domain/quote-prepare`）→ 比价（`domain/compare`）→
   授标 + PO（`domain/commitments`））。
3. **入参取值令牌**（机制，不认识字段含义）：`$actor` = 这一步的**演示身份**；`$last.<点分路径>` / `$cap.<名字>.<点分路径>`
   = 上一步 / 更早某步（声明了 `capture`）回执 `result` 里的值 ⇒ 步骤之间不必手抄 id。
4. **`optional:true`** = 这一步失败**不算整条流程失败**（照旧往下跑，失败原样记进回执的 `optional_failures`）。

### 11.2 隔离：沙盘账本不是真实账本（这是本节的硬判据）

1. 状态落 `<ui_shared>/sandbox/state.json`（目录 0700 / 文件 **0600**、原子写、有界：身份 ≤ 32 条），
   按**会话身份**分条：`{<human>: {on, actors:{<side>: <演示身份名>}, scenario, seeded_at}}`（未登录 ⇒ `identity-required`）。
2. 沙盘目录 `<ui_shared>/sandbox/<身份>/`：`contractor/`、`supplier/` 各自的 `ledger.jsonl` + 待办件目录 + 投递信封。
   打开时 `host.config.ledger_*` / `host.sharedDir` / `host.rows()` / `host.publicRows()` **全部**解析到沙盘那一份
   —— 不是"过滤掉真实数据"，而是**没有第二条路径**（写者的 `--ledger` 也来自同一处，所以写也只进沙盘）。
3. **不是第二条事实写路径**：动作仍走同一个动作总线、同一批唯一写者、同一张待办件形状；差别只有目录。
4. **清空** = 删掉那个身份的沙盘目录 + 关掉 `on`（`sandbox.clear` 动作，需确认）；真实账本、真实待办件**零改动**。
5. **沙盘里的人签**：由机制生成并固定的**演示身份**（`actors[side]`，如 `demo-supplier`）发起；本方那一步用会话身份。
   真实面上这条替换**不存在**（HTTP 请求仍只认会话身份，`signer-mismatch` 一字未改）——沙盘是机制层的
   演示数据生成器，且它的账本是沙盘账本（不是合同事实）。
6. **边界（如实登记）**：名册/协作存储与附件存储仍指向真实目录（演示场景不使用它们）；沙盘不接受
   改角色/传附件这类副作用。

### 11.3 界面入口（不看文档就能用）

1. 工作台首屏第一块面板就是「演示数据（沙盘）」（`system/webui-sandbox` 机制贡献，`order:-98`），
   列出可用场景与逐步骤的 `action` 清单 + **「造一组演示数据」**一键按钮；打开后同一面板给出
   **「清空沙盘（回真实面）」**。两侧视图底部各有一块同功能面板（`order:98`）。
2. 入口是两个**动作**（`sandbox.seed` / `sandbox.clear`），走的是同一个动作总线 —— 沙盘**没有独立路由**。
3. 沙盘状态在 `/api/ui/surface` 的 `sandbox` 段自述（场景、声明者、步骤、状态文件、为什么不是账本事实）。

## 12 窄屏 / 触控 / 可访问性 —— 实测与测量值

1. **表格在小屏是可操作形态**：≤560px 时表格自动变**卡片**（每个 `<td>` 带 `data-label`，列名跟着值走；
   行内动作在卡片底部），可编辑格直接是整行宽度的输入框（`inputmode`/`enterkeyhint` 按列类型给）；
   561–900px 保持表格但**关键列与动作列吸边**（横滚时不跑掉）；任何横向可滚的容器都给**看得见的滑动提示**
   （渐变 + 一行字）。逃生门：给表格加 `q-keep-table` 就保持表格形态。
2. **弹层不溢出**：手机上弹层是**全屏单页**（标题 + 可滚正文 + **吸底**按钮，`q-modal-body`/`q-modal-foot`），
   确认页在窄屏**标签在上、值在下**；桌面仍是居中卡片（`max-height: 88vh`，卡片自己不滚、正文滚）。
3. **触控替代**：`pointer: coarse` 下所有可点目标 ≥44px（`⠿`/`▾`/`✕`/勾选框都有足够命中区）；
   顶栏「命令」按钮是命令面板的**触控入口**（键名 `⌘K` 退到 tooltip 与副标题里）；动作条在窄屏是**单行可滑**
   （不再是一屏按钮墙）；工具条/标签页/状态栏在窄屏都是单行可滑（状态栏不再换行成 300px 高）。
4. **键盘与屏幕阅读器**：省跳链接是第一个 Tab 站；弹层打开时给 `#q-app` 加 `inert` + `aria-labelledby`
   （焦点陷阱与"背景读不到"都靠浏览器原生 inert）、Tab 在弹层内循环、**关闭后焦点回到打开它的元素**；
   `main`/`banner`/`contentinfo` 地标齐备；实测可访问性树里 118 个交互节点**零无名**。
5. **对比度 ≥ WCAG AA**：主题 token 按 WCAG 2.1 算过（`--accent`/`--bad` 本批上调以过 `--accent-soft` 上的 4.5），
   实测 390/1440 两宽度共 800+ 处可见文字**零不达标**（最低 5.5）。

测量与复跑：`tmp/p7-a11y-out.txt` 与 `tmp/p7-report.md`（三宽度走查的命令写在报告内）。

## 13 采购单的投递与回签 —— 逐条判据

1. **发 PO 即投递**：唯一写者 `commitment-apply.py --step po` 落 `po/issued` 后写**两侧各一条 `po/distributed`**
   （承包商侧=分发登记，与 `rfq/distributed` 同形；供应商侧=收件登记，带逐行 `lines`+追溯链+签发人+执行前提）
   + 交换面信封 `exchange/po-deliveries.json`。**无第二条写路径**（宿主只落 0600 待办件）。
2. **收件人判据在写之前**（拒绝 ⇒ 账本与信封零新增）：被投递方账本要读得出 realm 且**就是中标报价的提交者**
   （`po-recipient-unknown` / `po-recipient-not-the-bidder`）。交期窗口/送货地址由发 PO 的人给，没给就照实缺。
3. **供应商侧视图**：`po.inbox` + 对象页上的 `po.object-received` / `po.object-lines-received` / `po.prereqs`；
   行只来自**本侧账本**的投递登记（投给别家的 PO 不在本侧账本里）；导出 `po.export-received` + 声明
   `report.po-received`；附件面板因此能挂**回签件**。
4. **回签 = 人签人工门**：`po.acknowledge` → `--step acknowledge`；门①本侧要有投递登记
   （`po-not-delivered-to-you`）②承包商要有同 `po_id` 的 `po/issued` ③署名==会话身份且侧只能来自会话
   （`cross-side-action`）。落两侧各一条 `po/acknowledged`（重签幂等）；不改 PO 行与价。
5. **沙盘**：`demo.procurement` 第 12 步 = 供应商回签（`optional: true`）；沙盘两侧由机制生成的演示身份驱动
   （见本文件 §11.2 第 5 条），侧判据在沙盘里按 `host.sandbox.actors[side]` 判，**真实面无此替换**。
6. **登记**：`po/distributed` / `po/acknowledged` 进 `docs/design/02-domain-model.md` §4 与 `docs/design/05-events.md` §3。

## 0 主文件 §0 的另两条原话（逐字保留）

> "现在的状况是用户打开 microsoft teams 能做到的都比你这个 Webui 要多、用户没有任何理由使用这个产品而不是 microsoft teams，这说明你的 webui 彻底是错误的、失败的。"
> "把 UI 写成一个**人类可用、易用、功能完善的产品**。"

## 5 主文件 §5 的逐条路线（原文）

1. **P0**：应用壳 + 注册面 + **一条真实闭环**（供应商：看包 → 备报价 → 签名提交；承包商：发 RFQ → 比价 → 批准 → 授标）。
   真起服务、真点、真回读账本。
2. **P1**：剩余双方流程逐条搬进 GUI（答疑/催报/变更/PO/审计导出/审批队列/授权区间）。
3. **P2**：可用性打磨（键盘、命令面板、深链、空态与错误态文案、可访问性、布局持久化）。
4. **验收**用真实用户视角（subagent 扮采购员/销售走一遍）；凡"必须回终端才能做完"的步骤算 **UI 缺陷**。

## 7 补充：主文件 §7 的完整口径（auth 推导 / 偏好服务端化 / 邮件入口 / 人签门 / 一份报价一签）

## 7. 台账与持久化（口径以本节为准）

1. **`/api/routes` 的 `auth` 是真实值**（不再写 `none`）：业务路由（`${prefix}/<侧>/…`）**按路径推导**为 `identity-session`（与 `code/identity.mjs#gateBusinessRoute` **同一判据**）；`none` 只给真公开入口；表里给 `auth_basis`。**别手抄**（抄的会漂）。
2. **偏好/已读/布局/筛选整份在服务端**（按身份，见 §9），**不是账本事实**。
3. **邮件通道有界面入口**：工作台面板 + **界内配置表单**（POST `${prefix}/mail/config/`）→ `identity-mail-apply.py` → 唯一落盘者 `config-apply.py` 写 YAML（干跑 → 0600 待办件 → 落盘；凭据永不回显）；**`/workspace/config.yaml` 只读**。
4. **人签动作的服务端身份门**：凡声明 `permission: 'human-signature'` 的动作，`POST ${prefix}/api/action/<id>` 上**服务端**校验「已登录 + 入参 `signature` == 会话身份」（401 `identity-required` / 403 `signer-mismatch`，账本零新增）；界面**不代签、不写账本**；这条门**一次也没放松**（批量见 §19）。
5. **一份报价 = 一次人签**：整表**一次提交** ⇒ **一条**草稿（`quote/drafted` 带逐行 `lines[]`），人签**一签提交整份**（多行报价标量 `item_id`/`unit_price_cents` 留空）；单行报价 body **逐字节不变**（12 键）；缺行/改行**有名拒绝**（`pending-tampered`/`line-item-not-found`/`draft-tampered`，账本零新增）。

**禁止**：界面不得成为第二条事实写路径；不得手抄 `auth`；不得把偏好类文件当账本事实。**真源**：`src/system/webui/docs/identity-and-selfservice.md`、`docs/design/19-mail-contract.md`；形状/有界/拒绝码见归档 §7-§8。

## 8 补充：主文件 §8 的完整口径（名册与角色）

## 8. 名册与角色：「同事」= **名册里的人**（不是「登录过的人」），角色**限动作**而非限视图

1. **名册是权威取值处**：`<ui_shared>/people/roster.json`（0700/**0600**、原子写、有界、超限**如实拒**），按**侧**分片（`side` 只由会话给）；**不进账本**（名册/角色/额度是**可改的运营配置**不是合同事实）。
2. **`@提及`/指派/转交都从名册取值**（候选与校验同源 `GET /api/people/suggest`）；**未知名字如实拒**（`unknown-colleague`；跨侧 `@` ⇒ `cross-side-mentioned`）；**登录即登记**（第一次登录即进名册、角色「待指派」＝有名字没权限）。
3. **按角色限动作**（服务端判据，在任何执行之前；拒绝 ⇒ **账本与待办件零新增**）：转交别人的活 ⇒ `transfer-not-yours`；额度超我角色的 `approval_limit_cents` ⇒ `role-limit-exceeded`（给出金额/额度/**该找哪个角色**）；有管理员之后改人/改角色/改策略**只有管理员**（`admin-required`）。
4. **角色不改变签署权**（结构性）：额度/角色判据跑在「署名 == 会话身份」**之后**、插件自己的服务端一半**之前** —— 它**只能否决、不能放开**；角色再高也不能替别人签、也不能跳过人工门（§7.4 一字未动）。

**禁止**：不得把名册/角色/额度写进账本或当模型可见输入；角色只能收紧不能放开动作。**真源**：`src/system/webui/docs/people-and-roles.md`；复跑 `python3 tmp/p5-people-verify.py`；逐条规则见归档 §8。

## 9 主文件 §9 的完整口径（偏好 / 已读 / 布局 / 筛选）

## 9. 通知偏好 / 已读 / **布局** / 筛选：**整份**服务端化（按身份）

1. `GET|POST ${prefix}/api/ui/notif-state`（`POST` **整体替换**）：已读集合、静音的插件、最低级别、**面板布局（顺序/折叠/隐藏，按「视图+对象类」分桶）**、筛选片**全部**落 `<ui_shared>/webui/notif-state.json`（0700/0600、原子写、有界、洗净；坏形状丢掉并**如实计数**）。
2. **按会话身份隔离**：换浏览器/换设备读回同一份（"跨设备仍在"）；身份之间互不可见；未登录 ⇒ 401 `identity-required`（界面如实说"只在本浏览器有效"，localStorage 降为**离线镜像**）。
3. **只读路由的方法围栏**：只应为 `GET` 的路由收到非 GET ⇒ **405 + `method-not-allowed` + 响应头 `Allow: GET`**，且**先按方法判据拒绝、再做身份校验**（顺序反了会变 401，"只读路由不接受写"就失效）。机检：`tools/verify.sh quote-draft` 第 ③ 条（拿 `/api/routes` 逐条 POST）。

**真源**：`src/system/webui/docs/people-and-roles.md`、`collab-and-roster-resilience.md` §4。
