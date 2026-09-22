# 功能需求（FR）

<!-- budget: 32 KB. 每条 FR 必须有优先级、所属阶段、关联 AC；无 AC 的 FR 不得进入实现 -->

## 0. 读法

- ID：`FR-<域>-<NNN>`；优先级：`must`（不做则阶段不成立）· `should`（阶段内应做）· `could`（可延后）。
- 阶段：P0 mock · P1 mvp demo · P2 product（定义见 `roadmap.md`）。
- 每条需求都引用 `acceptance-criteria.md` 中的 AC；**AC 未定义的需求不得实现**（AGENTS.md 规则 6）。
- 较早的非 P0 行在 `functional-requirements-archive*.md`（同目录；批次与选入规则见各归档头）。**归档仍受门校验**：主文件 + 归档 = 门的 **FR 定义集合**。
- 服务与事件细节见 `../design/04-services-catalog.md` 与 `../design/05-events.md`，本文件不重复定义。

## 1. 验证清单（V）：未验证的假设

**规则**：凡标 `[假设]` 的设计断言都必须在这里有一条 V 记录。V 未验证前，相关设计不得升格为
"已确认事实"，相关指标不得设目标值。

| ID | 假设 | 验证方式 | 判定标准 | 影响 |
|---|---|---|---|---|
| V-001 | 澄清往返是报价周期的主要耗时来源 | 现场访谈 2 家承包商 + 3 家供应商，抽样 5 个已结项包 | 澄清耗时占比 ≥ 20% 则成立 | 决定 `ctx.clarify` 的优先级 |
| V-002 | 供应商愿意提交结构化报价（对称性假设） | 用 S1 场景模板做 3 次盲测，看供应商是否接受模板与字段 | ≥ 2/3 接受则成立 | 决定 P1 是否有意义 |
| V-003 | 采购方接受"AI 排序建议 + 人工签署" | 与 2 名采购负责人评审 S1 比价结果 | ≥ 1 名愿意在真实包上试用则成立 | 决定 `ctx.compare` 的推广路径 |
| V-004 | 包边界在澄清后会被修改（需版本化） | 抽样 10 个历史包的 rev 次数 | 平均 rev > 1 则成立 | 决定 RFQ 版本化的复杂度投入 |
| V-005 | 变更争议主要源于"原报价未条目化" | 抽取 10 份历史变更单的争议描述 | ≥ 5 份提到单价/条目缺失则成立 | 决定 `change` 与报价条目化的强绑定 |
| V-006 | 规模上界（条目 ≤2000、投标人 ≤50、事件 ≤10^6） | 向现场索取真实项目统计 | 超出则修订 `10-nonfunctional.md` §8 | 决定性能预算与存储选型 |
| V-007 | 协作确是跨法人（非同一集团内部） | 确认参与方法律关系与结算主体 | 跨法人则 ADR-0001/0003 前提成立 | 影响隔离模型与账本同步 |
| V-008 | 电子证据在审计中的采信标准 | 咨询 1 名审计/法务 | 明确采信要求则修订 `09` §4 | 决定证据包形态 |
| V-009 | 异常低价判定的合理阈值 | 用历史中标数据做分布分析 | 形成分布结论则写入策略 patch | 决定 guard 默认值 |
| V-010 | 留存期与销毁策略要求 | 咨询合规 | 得到明确期限则写入项目 patch | 决定存储与留存实现 |
| V-011 | 邮件/文件投递在双方间实际可用 | 与一家供应商做一次真实投递演练 | 成功送达并可校验签名则成立 | 决定 P1 绑定选择 |
| V-012 | 供应商侧最痛的是"读包 + 澄清 + 重复录入" | 访谈 3 家供应商 | ≥ 2 家认同则成立 | 决定供应商侧功能排序 |

## 2. 内核域

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-LEDGER-001 | 提供 append-only 账本，含哈希链；事件一经追加不可修改 | must | P0 | AC-AUDIT-001 |
| FR-LEDGER-002 | 从账本可重建任意时点投影（全量与增量） | must | P0 | AC-AUDIT-002 |
| FR-LEDGER-003 | 账本启动与每次追加后校验哈希链，失败即停发 | must | P0 | AC-AUDIT-001 |
| FR-LEDGER-004 | 同一 `(correlation_id, type, body_hash)` 不产生第二条事实 | must | P0 | AC-QEP-002 |
| FR-EVT-001 | 事件五模式分发（emit/parallel/serial/bail/waterfall） | must | P0 | AC-EVT-001 |
| FR-EVT-002 | 监听器注册返回 disposer，卸载后自动注销 | must | P0 | AC-PLUGIN-001 |
| FR-EVT-003 | waterfall 不调 `next()` 即短路，且短路点必须在文档登记 | must | P0 | AC-EVT-002 |
| FR-PLUGIN-001 | 插件装载/卸载，依赖未就绪不得激活；**宿主侧同一套接口**（`tools/plugin.sh` 六动词） | must | P0 | AC-PLUGIN-001、AC-PLUGIN-005 |
| FR-PLUGIN-002 | 依赖变化自动触发消费者重载/失活，不自动迁移草稿 | must | P0 | AC-PLUGIN-002 |
| FR-PLUGIN-003 | 卸载后无残留订阅、定时器、外部通知 | must | P0 | AC-PLUGIN-001 |
| FR-PLUGIN-005 | 插件向 WebUI 的**注入式注册面**提交自己的区块/路由声明；WebUI 只做机制（槽位 / 排序 / 静态资源前缀），不含任何业务语义与插件名 | must | P2 | AC-PLUGIN-006 |
| FR-QEP-001 | 构造/校验/签名/验签 QEP 信封 | must | P0 | AC-QEP-001 |
| FR-QEP-002 | 承诺类报文缺人工批准即拒收 | must | P0 | AC-APPROVE-002 |
| FR-QEP-004 | 至少一次投递 + 幂等去重 | must | P0 | AC-QEP-002 |

## 2.1 运行时与运行器（P0 S0.1）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RUNTIME-001 | 仓库内自包含运行时：实现仅依赖 Python 3.9+ 标准库；解释器由仓库内脚本解析（仓库 `.venv` 优先，可被 `QUOTAGENT_PY` 覆盖）；运行不写仓库外文件；**一键运行**（`./run up|down|status|doctor`） | must | P0 | AC-RUNTIME-001、AC-RUNTIME-010 |
| FR-RUNTIME-002 | CLI 骨架：`python -m quotagent.qa` 提供 `ac`/`suite`/`list` 入口；AC 报告为机器可读 JSON，退出码 0=通过、1=断言失败、2=未知入口 | must | P0 | AC-RUNTIME-002 |

## 3. 共享能力域

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-NORM-001 | 单位、币种与汇率时点、含税口径、计量规则归一化 | must | P0 | AC-NORM-001 |
| FR-NORM-002 | 不可归一即拒绝并留痕，不得猜测兜底 | must | P0 | AC-NORM-002 |
| FR-NORM-003 | 报价条目与询价清单条目对齐（含 `additional` 标记） | must | P0 | AC-NORM-003 |
| FR-NORM-004 | 包版本与报价版本一致性门（不一致不得进比价） | must | P0 | AC-COMPARE-001 |
| FR-CLARIFY-001 | 澄清工单绑定包版本与条目引用 | must | P0 | AC-CLARIFY-001 |
| FR-APPROVE-001 | 人工门：请求、批准、拒绝、代签禁止 | must | P0 | AC-APPROVE-001 |
| FR-APPROVE-002 | 批准绑定 scope，不可跨动作复用 | must | P0 | AC-APPROVE-002 |
| FR-GUARD-002 | 漏项检测（清单对齐） | must | P0 | AC-GUARD-001 |
| FR-GUARD-005 | 报价正文注入与私域泄露检测；护栏只产 Flag 不否决 | must | P0 | AC-GUARD-003 |

## 4. 承包商侧

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RFQ-001 | 创建采购包：范围、接口、计量规则、交付物、除外责任 | must | P0 | AC-RFQ-001 |
| FR-RFQ-002 | 清单条目 CRUD 与校验（单位属计量规则表、必须有唯一接口责任方） | must | P0 | AC-RFQ-001 |
| FR-RFQ-003 | 发布产生不可变版本；修改必须升版并给字段级 delta | must | P0 | AC-RFQ-002 |
| FR-COMPARE-001 | 归一化报价 → TCO 折算（价格/交期/付款条件/质保/偏差） | must | P0 | AC-COMPARE-002 |
| FR-COMPARE-002 | 排序建议：权重来自策略 patch；同输入同输出 | must | P0 | AC-COMPARE-002 |
| FR-COMPARE-003 | 每个数值必须有引用链（账本条目 + 清单条目） | must | P0 | AC-COMPARE-003 |
| FR-AWARD-002 | 供应商确认 + 承包商人工签署 → 承诺；缺一即抛错 | must | P0 | AC-AWARD-001 |

## 5. 供应商侧

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-INTAKE-001 | 从包中抽取清单条目与规格引用，逐条给出 `item_id` | must | P0 | AC-INTAKE-001 |
| FR-INTAKE-002 | 缺项检测与疑问清单生成（人工确认后才外发） | must | P0 | AC-INTAKE-002 |
| FR-INTAKE-003 | 无引用的抽取结果标记为 `[假设]` 等待人工确认 | must | P0 | AC-INTAKE-002 |
| FR-COST-001 | 成本构成按条目与成本要素（材料/人工/机具/管理/风险/税/财务） | must | P0 | AC-COST-001 |
| FR-COST-002 | 成本模型为私域，永不出 realm | must | P0 | AC-TRUST-001 |
| FR-PRICE-001 | 定价流水线产出 PriceProposal（Intent），越界即请求批准 | must | P0 | AC-PRICE-001 |
| FR-PRICE-002 | 最终报价数字必须人工确定 | must | P0 | AC-PRICE-001 |
| FR-DEV-001 | 偏差捕捉（技术/商务/进度/范围）与影响量化 | must | P0 | AC-DEV-001 |

## 6. 协作与治理

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-NEGO-001 | 有限轮次谈判：轮次上限与让步上限来自策略 patch | could | P2 | AC-NEGO-001 、AC-NEGO-003 |
| FR-NEGO-002 | 任何价格让步必须人工批准 | must | P2 | AC-NEGO-001 、AC-NEGO-003 |
| FR-EVAL-003 | 指标采集与基线报告 | must | P0 | AC-EVAL-002 |
| FR-INTEG-001 | 文件投递绑定（原子写 + 命名约定） | must | P0 | AC-INTEG-001 |
| FR-EVOLVE-007 | 提供自进化流水的只读归纳（提案/影子/门两态/晋升/回滚/canary 进出 + 最近事件），只出计数不出正文 | must | P2 | AC-EVOLVE-005 |
| FR-RFQ-008 | **「来不及回 RFQ：谁还没回 / 还差多久 / 催了没有」**（domain 插件 `rfq-deadline`，正面回答 P-10「截止时间与催报**没有入口**」与 P-04「被迫「等回到电脑前再算」、**错过截止**」）：吃调用方给的白名单事实载荷（本视角 `rfq/published`、`rfq/distributed`、`quote/submitted`、`rfq/promised` 行 + `as_of` + 邮件通道事实），每条 RFQ 派生 `{rfq_id, subject, due_ts, due_basis, responded, silent, overdue, remaining_seconds, severity, next_action, blocked_by}`（**恰 11 键**）。**回文时限来自事实行**（`rfq/published.quote_by` 或 `rfq/promised.due_at`，取事实 ts 最晚的那条）、**`remaining_seconds = due_ts − as_of`（绝不取墙钟）**：两个墙钟入口读都不读 ⇒ 同一份快照在任何「当前时间」下输出**逐字节一致**。**没凭据不得假装能发**：通道 `available=false` 时 `blocked_by` 写清「**无法代发**」与通道 reason，输出里不出现任何「发过了」的表述（`can_send=false`）。**竞标人名册是业主私域**：非业主视角对 `invited`/`quotes` **读都不读**（带名单与不带名单输出逐字节一致），`responded` 与 `sourcing.coverage()` **同一口径**。无数据 ⇒ `degraded` + 有名 reason + 条目为空；有界（`max_items` 夹取 + 如实报 `omitted`）；确定性；零写面（不读账本、不发信、不取墙钟）。路由 `GET /quotagent/<view>/deadlines/`（SSR，**脚本只来自受信来源**）、`GET /quotagent/<view>/api/deadlines`、`POST /quotagent/<view>/deadlines/promise`（宿主**只落一条 0600 待办件**：发言人 + 承诺回文时限 + RFQ id + 原话 sha256，**账本零新增**；202 + `next_action`），并挂进四道页面子导航；`tools/rfq-promise.py` 是**唯一落账本者**（落 `rfq/promised`，body **恰 6 键**、不含原话正文与凭据；待办件移入 `applied/`；幂等 `duplicates`；拒绝码各自给 code + next_action） | must | P2 | AC-RFQ-006 |
| FR-RFQ-009 | **「供应商看不到自己的 RFQ 包」的根因修复：被邀供应商在自己的视角里看得到**发给它的**包事实**（投递信封 + 收件人作用域 + 字段级白名单；**字段白名单逐字段列在** `docs/design/26-rfq-delivery-visibility.md` §2，本行不复述）：`rfq/*` 事实只落在**发送方 realm**（实测：供应商那本账本里 `rfq/*` **0 行**）⇒ 供应商看不到要报的包、@rev、报价截止。修法**不跨读对方账本**：读**投递信封**（发送方放进共享交换目录的交付件），按 `delivered_to` 做**收件人作用域**（身份**只来自本视角自己的账本** `realms()`；0 个 ⇒ `no-identity`，多于 1 个 ⇒ `ambiguous-identity` fail-closed），再按字段白名单投影（✓ `package_id`/`rev`/`quote_by`/`clarify_by`/`items[{item_id,code,qty,unit}]`/`currency`/`delivered_at`/发放对象只出自己，**恰 9 键**；✗ 承包商私域与他家供应商数据**读都不读**）+ **两道结构性负控**（出现任何非我发放对象/私域键名 ⇒ 整条抑制 + 服务端审计）⇒ **带哨兵与不带哨兵输出逐字节一致**、他家代号与他家包 **0 命中**；承包商侧**不得减少**（他不读投递信封）。派生行 `type=rfq/published`、`seq: null`；确定性、有界（+`omitted`）、**降级 7 个有名 reason**；纯函数零写面。组装：`host/modules/projection.mjs` + `host/lib/ledger-view.mjs` 的 `realms()` + `host/modules/webui.mjs` 的只读装配与首页投递块（脚本只来自受信来源）+ `--rfq-delivery` | must | P2 | AC-RFQ-007 |
| FR-QUOTE-001 | **「把报价准备好（草稿）：行项目 / 单价 / 交期 / 备注」**（domain 插件 `quote-prepare`，正面回答「**员工填了单价点了提交、浏览器回一页 200、什么都没发生**」这条最伤信任的假成功）：铁律是**浏览器不得直接签署人工动作**（`quote.submit` 只能由人/CLI 签），但**不需要签名的写动作必须在 APP 里真做成** —— 闭环三段各自可验证：① 准备（SSR 页；`GET` 与 `POST` 同路径）；② 宿主 `POST` **只落一条 0600 待办件**（目录 0700、原子写，**账本零新增**；**202** + `next_action`，**绝不**返回与 GET 相同的 200 页面）；③ `tools/quote-draft.py` 是**唯一落账本者**，落 `quote/drafted`（**非签名动作**：不是 `quote/submitted`；body **恰 12 键**、**不含备注正文与凭据**）、待办件移入 `applied/`、幂等 `duplicates`、拒绝码各自给 `code` + `next_action`。**字段级**校验：`view`/`rfq_id`/`item_id`/`unit_price_cents`（**整数分**）/`lead_time_days`/`prepared_by`（`human:*`）/`currency`/`note` 八个字段各自给 `{field, code, message, next_action}`（拒绝码是**闭合集合**；越界**不夹取**、备注**不截断**）。行项目目录从**本视角事实**里逐条按键读（`items[]`/`item_ids[]`/`item_id`/`lines[].item_id`），读不出来 ⇒ `degraded` + 有名 reason，**不编行项目**；数值非法/行项目不存在/待办件被改过一律拒且**零写账本**。**双向可见**：同一份草稿**两侧登记**，供应商侧与承包商侧各自从**自己的**账本投影回读（行项目 / 单价 / 状态恒为**待签署** / 引用），承包商侧读到「**供应商 X 已准备报价（待签署）**」。**签署入口**：页面上给**可复制**的 CLI 命令（真实 RFQ / 行项目 / 金额整数分）+ 明说「**本 APP 不代签**」（`data-signature-required="1"`、`can_sign=false`、服务面无 `approve`/`decide`/`submit`/`send`）。宿主侧围栏：只应为 `GET` 的路由收到非 GET ⇒ **405 + `Allow: GET`** + `{ok:false,code:"method-not-allowed",next_action}`；页面 **脚本只来自受信来源** | must | P2 | AC-QUOTE-001 |
| FR-USERPLUG-010 | P2 | 用户空间插件**提权**为系统级插件：管理面只产待办载荷（零写面）；真正写树由 `tools/userplugin-elevate.py` 执行 —— 必须**人类 actor** + `ap-NNNN` 人工门引用 + **影子哈希与现算产物哈希一致**（陈旧载荷/被改产物一律拒绝）；目标只能是 `<name>.mjs`，**已存在即拒绝（不覆盖）**，越界写面不可达 | AC-USERPLUG-010 |
| FR-UXWEB-001 | P2 | **WebUI 是完整 GUI 应用，不是只读说明书**（真源 `docs/design/29-webui-gui-app.md`）：提供可长期使用的应用外壳（多视图 / 导航 / 命令面板 / 通知 / 快捷键 / 深链）与**注册面** —— 插件注册视图·区块 / 交互方式 / 动作与命令（含服务端一半）/ 通知与状态即可实现任意功能；外壳 0 业务语义、0 插件 id；**允许前端框架** | AC-UXWEB-001 |
| FR-UXWEB-002 | P2 | **双方流程逐条可在 GUI 内闭环**（29 §4）：承包商（发 RFQ → 催报答疑 → 收报价 → 比价 → 人工门 → 授标 → PO → 变更让步 → 审计导出）与供应商（看包 → 澄清 → 备报价 → 签名提交 → 谈判 → 承诺交期 → 中标/落标确认）每一步可点 / 可等 / 可催 / 可签且真落账本或 0600 待办件（仍过人工门与唯一写者） | AC-UXWEB-001 |
| FR-CONFIG-001 | P2 | **插件/项目配置可 UI 更改并持久化**：宿主侧只读总览（每键 `source`(`default|file|env|runtime`) / `shadowed_by` / `editable`）+ **干跑预览**（零落盘零生效）；保存只落 **0600 待处理项**（宿主零写面），由 `tools/config-apply.py` **原子写** `/workspace/config.yaml`（临时文件 + rename，失败回滚）并落账本 `config/changed|refused`；支持 `--init` 从模板生成配置文件（即"支持配置文件初始化"） | AC-CONFIG-001 |
| FR-CONFIG-002 | P2 | **凭据可 UI 提交且只写不回显**：状态视图只给 `configured` / `source` / `required_mode` / `fingerprint_first8` / `next_action`；提交与轮换**绝不回显值**；未提权对配置与凭据的 11 条路径一律 **401 同形**（无 oracle、不泄漏键名）；YAML 只实现**声明清楚的子集**，锚点/别名/多文档等一律拒并给 reason（不静默糊掉） | AC-CONFIG-001 |
| FR-MAIL-001 | P2 | **邮件收发由插件提供**（`services/mail_transport.py`，标准库 `smtplib`/`imaplib`）：SMTP 参数与 IMAP 参数从配置读（**环境变量优先于** `/workspace/config.yaml`）；**未配置必须如实报未连接**（`available:false` + reason + next_action，且给出与"连不上"**可区分**的 reason），配置了就真能收发；凭据不进日志/账本正文/异常消息 | AC-MAIL-001 |
| FR-MAIL-002 | P2 | 邮件相关配置键**进白名单**（⇒ 既有配置 UI 可直接改并持久化到 YAML，不新增第二条写路径）；宿主侧只读视图 `host/modules/mail-view.mjs`（队列计数 / 最近结果与 reason / `available` / `next_action`，零写面）+ `GET /quotagent/ops/mail/`（脚本只来自受信来源）与 `GET /quotagent/api/mail` | AC-MAIL-002 |
| FR-VIZ-001 | P2 | **比价 heuristics 可视化（domain 插件）**：把候选按**可调权重**（价格/交期/付款/质保/偏差）排序，并给出**每项的贡献分解**与确定性的"如何提升排名"提示；权重越界**夹取并回显**（归一后和为一）；有界并诚实报 `omitted`；**私域零泄漏**（供应商侧不得因排名暗示标底：带私域键的行整行跳过并报数，带哨兵与不带哨兵的输出**逐字节一致**）；页面 SSE 交互（`<form method=get>`，无内联脚本） | AC-VIZ-001 |
| FR-ADV-001 | P2 | **AI agent 决策建议层（domain 插件 `advice-panel`）**：吃调用方给的**白名单结构化载荷**（本视角的截止 / 待批人工门 / `bid-heuristics` 同口径的比价行 / 通道声明；**不读账本、不联网、不调模型**），按**五条确定性规则**（① 截止临近或已过期 ② 比价得分极差过大 ③ 等待人工门 ④ 凭据缺口导致的阻塞 ⑤ 供应商侧如何提升排名）派生"下一步"：每条给 `severity`(high\|medium\|low) / `why` / **非空 `basis`**（指向载荷真键，如 `deadlines[pkg-1].due_at`）/ `next_action`（**可直接复制的命令或路由**：人工门给 `python3 -m quotagent.g1side ...`、比价给 `/<view>/heuristics/?w_<分量>=1`、凭据缺口**逐字节照抄**通道声明里的 `next_action`，**不假装能发**）/ `blocked_by`。**诚实分层**：输出恒带 `engine="rules"` 与文案"本页建议由确定性规则从投影/快照派生，不含模型推测"；**无可分数据不编建议**（空投影 → `degraded:true` + 有名 `reason` + `items:[]`；"载荷不能用"与"数据齐但无可建议项"是两个 reason）；有界（`max_items` + 如实报 `omitted`/`truncated`）、确定性（同输入两次逐字节一致，且与入参键序/条目顺序无关）、**私域零泄漏**（条目上多出来的键读都不读：带哨兵与不带哨兵输出逐字节一致）；路由 `GET /quotagent/<view>/advice/`（SSR，**脚本只来自受信来源**）与 `GET /quotagent/<view>/api/advice`，并挂进四道页面子导航 | AC-ADV-001 |
| FR-UIFB-001 | P2 | **WebUI 自适应闭环（反馈 → 新版本 → 自动重载 → 提示"请刷新"）**：每页渲染 `data-ui-revision="rN"`（版本号**只来自落盘的 `versions.json`**，宿主从不凭空递增）；`/<view>/feedback` 是 SSR 页（`<textarea>` + POST），提交**只落一条 0600 待办件**（含用户**原话正文** + sha256 + 视图名，宿主**账本零新增**）并回 202 + id + `next_action`；`tools/ui-feedback-apply.py` 是**唯一落账本者**（重算产物哈希 → 原子写版本状态 → 落 `ui/feedback-applied`，body **不含反馈正文**；幂等、拒绝路径给具体 code）；版本落后时页面顶部出现 `data-ui-stale="true"` 横幅（"已更新到 rM，请刷新页面" + `<form method=get>` 的"我已刷新"，`?seen=rM` 即消），版本相同**不得**出现横幅；运维观察面只读、有界、确定性（`degraded` 有名 reason） | AC-UIFB-001 |
| FR-GATE-001 | P2 | **「审批等多久 / 变更单到底是谁卡着」**（domain 插件 `gate-timeline`，正面回答两条 human problem：「审批人等不到」与「变更单扯皮」）：吃调用方给的**白名单事实载荷**（本视角的 `approval/*` / `change/*` 行 + `as_of`），派生 ① **还在等的人工门** `{id,kind,subject,owner,age_seconds,age_basis,consequence,next_action,blocked_by}`（挂了多久 / **口径** / 卡在谁手里（队列里的真审批人，没有就如实说 `unassigned`）/ 再等下去会发生什么（`remind|escalate|abort` 各自说清，**没有"超时自动批准"这一项**）/ 下一步）与 ② **变更单时间线** `{id,state,owed_by,waiting_since,basis,next_action}`（状态 / **谁欠谁一个动作** / 从哪条事件起在等 / 以账本事件与计数引用为凭）。**`age_seconds` 的口径 = `as_of − approval/requested 事实 ts`（绝不取墙钟）**：两个墙钟入口（`payload.now` / `config.now`）**读都不读**，所以同一份快照在任何"当前时间"下输出逐字节一致。**本插件永远不能批准**：服务面里没有 `approve/decide/grant/submit` 这类方法（`meta.can_approve=false`），`nudge()` 只产催办载荷（`requested_action="nudge"`）→ 路由 `GET /quotagent/<view>/gates/`（SSR，**脚本只来自受信来源**）、`GET /quotagent/<view>/api/gates`、`POST /quotagent/<view>/gates/nudge`（宿主**只落一条 0600 待办件**：用户原话 + 目标门 id + sha256，**账本零新增**；202 + `next_action`），并挂进四道页面子导航；`tools/gate-nudge.py` 是**唯一落账本者**（校验目标门在本视图投影里且**尚未被决定** → 落 `gate/nudged`，body 恰 5 键、**不含理由正文**；待办件移入 `applied/`；幂等 `duplicates`；四种拒绝码各给 code + next_action）；**空投影 → `degraded:true` + 有名 reason + 两个列表都为 0**（不编）；有界、确定性、私域零泄漏 | AC-GATE-001 |
| FR-GATE-002 | P2 | **变更单逐行明细**（`gate-timeline` 规则 ⑤）：`/<view>/changes/<id>/` 与 `/<view>/api/changes/<id>` 逐行给原量×原价→新量×新价→差额（整数分）、行小计与总计差额、每行 `basis`；缺依据的行**不计入小计**（列 `basis_missing`）；无可用行 ⇒ degraded+reason+明细空；未知 id ⇒ 404+`next_action`；私域列仅业主侧可见 | AC-GATE-002 |
| FR-AUTH-001 | P2 | **「授权区间」**（domain 插件 `authority-band`，正面回答 P-12「谈判让步的授权区间不可见」：谁能批到多少 / 越界怎么办 / 下一个能批的人是谁）：吃调用方给的**白名单载荷**（`view` + **金额（整数分）** + 角色 + **只读配置快照**里的 `authority.*` 键；**不读账本、不读文件、不联网、不调模型、不取墙钟**），输出 `{amount, unit:"cents", within[{role,limit_cents,remaining_cents}], bands[], required_role, next_role, over_by, escalate_cmd, inside_band, blocked_by, unconfigured, basis, engine:"rules", degraded, reason}`：① **谁能批到多少** = 区间全表 + 覆盖本金额的角色（least privilege 的 `required_role`）；② **下一个能批的人是谁** = 比当前角色限额更高且**真的批得到**本金额的最小限额角色；③ **越界必须走人工门**：越界时给**可直接复制**的升级命令（`tools/verify.sh gates` **真存在** + 终端人工签署命令），并明说**本插件不能批准、不能放行**（`can_approve=false`，服务面无 `approve/decide/submit` 这类方法）；④ **未配置不得编限额**：`authority.bands.<角色>` 未登记 / 为 `null` / 快照缺失 / 单位声明非 `cents` ⇒ `unconfigured=true` + 有名 `reason` + `required_role`/`next_role` **都为空**（`null`（未配置）与 `0`（人明确登记"一分也不能批"）是两件事）；⑤ 金额非法（负数 / 非整数 / 超上限）⇒ 具体 `code` + `next_action`；配置进白名单（`authority.unit` / `authority.currency` / `authority.bands.<角色>` / `authority.fallback_role` / `authority.escalation_note`，**人工专属键** ⇒ 既有配置 UI 可直接改并持久化、YAML 可直接初始化）；路由 `GET /quotagent/<view>/authority/`（SSR，**脚本只来自受信来源**）与 `GET /quotagent/<view>/api/authority`，并挂进四道页面子导航；有界、确定性、私域零泄漏 | AC-AUTH-001 |

## 6.1 用户诉求（12 条；可追溯表见同目录 `requirements-traceability.md`）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-USREQ-001 | **UI 不得只做信息聚合：每一步都要在 APP 内闭环（含写操作）**。原话：「…不离开 APP 就能完成**每一步**工作（含写操作）」。写操作有真落点（202 + 0600 待办件，账本零新增）。验收: webui / config-route / gates / rfq-deadline / ui-feedback 门（现存**四类**写各 202）。缺:「步骤→路由→动作」登记表。 | must | P2 | AC-UXWEB-001、AC-CONFIG-001、AC-RFQ-006 |
| FR-USREQ-002 | **视觉不得像「上世纪的表单」，要像现代 app**。原话：「视觉不得像『上世纪的表单』，要像现代 app」。含义: 布局/密度/组件/状态可见性达现代 Web app 水平，不是裸表格堆叠。验收: 判据真源 `docs/design/29-webui-gui-app.md` §1/§4；视觉本身无命令。缺: 可机检视觉基线（design token + `data-*` 断言）或人工评审（V + 签署人）；**不得**标 done。 | must | P2 | AC-UXWEB-001 |
| FR-USREQ-003 | **模拟真正的员工（承包商采购员 / 供应商报价员），不是「上帝视角的检察员」**。原话：「模拟**真正的员工**…而非『上帝视角的检察员』」。含义: 两侧以岗位身份各自跑日常工作流（读包→澄清→报价→比价/审批），用各自的账本。验收: g1 门（两真进程 + 走查 14 判据）只覆盖「各自跑完工作流」+ 私域互不可见。缺: 每侧「员工的一天」任务清单。 | must | P2 | AC-EVAL-001、AC-INTEG-006 |
| FR-USREQ-004 | **dashboard 接线**。原话：「服务列表不堆链接；**projects & routes** 下要有项目路由入口；项目 webui 是**独立运行的 app**」。含义: 项目 UI 是独立进程（自有端口/健康）；projects & routes 区有项目路由入口，只认服务自述 `GET <prefix>/api/routes`。载体（**跨仓**）: `services/services.json`、`services/dashboard/dashboard.py`、`tools/webui-serve.py`。验收: webui 门（自述路由 + 双方视角不同路由）；dashboard 侧本仓无门。缺: 跨仓机检。 | must | P2 | AC-UXWEB-001 |
| FR-USREQ-005 | **webui 是面向用户的 app（一般用户不熟 CLI），不是一堆报告**。原话：「webui 的定位是**面向用户的 app**（一般用户不熟 CLI），不是一堆报告」。含义: 页面按用户任务组织（**完整 GUI 应用**：视图/面板/动作/通知 + 上手入口），不是报告堆叠。验收: 真源 29 §1/§4（**仅通过 GUI** 走完全部业务流程）；现存只读面仍由 `tools/verify.sh webui` 守卫。缺:「用户不需要 CLI」的端到端机检。 | must | P2 | AC-UXWEB-001、AC-UIFB-001 |
| FR-USREQ-006 | **cron 没待处理反馈时不得发垃圾消息**。原话：「cron **没待处理反馈时不得发垃圾消息**」。含义: 反馈闭环 cron 只认**确定性探测器**（`ui-feedback-monitor.sh`：输出与上次相同 ⇒ 调度器跳过、不发消息），待办 0 时输出恰一行 `pending=0`。验收: `qa ac AC-USREQ-006`（确定性 + 两 TZ 一致 + 空待办恰一行 + 非空转）。缺: 调度器真跳过的跨仓机检。 | must | P2 | AC-USREQ-006 |
| FR-USREQ-007 | **需求必须持久化进合同文档**。原话：「需求必须**持久化进合同文档**（不是『记住』）」。含义: 每条需求在合同文档里有 FR 行（原话引用 + 可验收含义 + 验收方式），并配需求→实现→证据可追溯表。验收: docs 门 + coverage 门 + `requirements-traceability.md` 逐行状态带证据列。缺: 可追溯表自身的门。 | must | P2 | AC-DESIGN-001、AC-DESIGN-003 |
| FR-USREQ-008 | **UI 上必须看得到：插件市场、agent panel、可交互业务逻辑插件、自进化**。原话：「UI 上必须看得到：**插件市场、agent panel、可交互业务逻辑插件、自进化**」。含义: 四类都真页面可见 —— `plugin-market` 页；`/quotagent/admin/` 阻塞与进度区；`gate-timeline`/`authority-band`/`rfq-deadline`/`advice-panel` 的 `/<view>/...` 页；`evolve-journal` + `/api/ops`。验收: plugin-market / admin-route / webui 门。缺: 四类同一屏的汇总入口机检。 | must | P2 | AC-MARKET-001、AC-ADMIN-001、AC-EVOLVE-005 |
| FR-USREQ-009 | **插件一律由插件提供（含需凭据的邮件插件）；配置要能 UI 更改 + 持久化 + YAML 初始化**。原话：「插件一律由插件提供…插件配置要能 **UI 更改 + 持久化 + 配置文件（YAML）初始化**」。含义: 能力面（含邮件收发）由插件提供；配置有 UI 读写路径（干跑 → 0600 待办件 → 原子写 `config.yaml`）+ `--init` 生成 YAML。验收: config-route / mail-transport 门。缺:「每件插件都有配置面」的双向机检。 | must | P2 | AC-CONFIG-001、AC-MAIL-002 |
| FR-USREQ-010 | **每个功能模块可独立演进（自进化）；cordis 能做的直接用 cordis 最新版，不重造轮子**。原话：「每个功能模块可**独立演进**（自进化）；cordis 能做的直接用 cordis 最新版，不重造轮子」。含义: 插件各自装卸、独立演进（提案→影子→门→canary→晋升/回滚）；宿主能力优先用 cordis（钉住 4.0.0-rc.10）。验收: evolution / cordis / modules / user-space 门。缺:「cordis 已有而我方重造」的反向机检。 | must | P2 | AC-EVOLVE-001、AC-USERPLUG-003 |
| FR-USREQ-011 | **webui 可从 dashboard 访问；不同 routes 提供双方各自视角，而不是只有一条 route**。原话：「…**不同 routes 提供双方各自视角**，而不是只有一条 route」。含义: gateway 把 `/quotagent` 路由到独立 webui 服务，且 `/<view>/...` 多道多路由。验收: webui 门（**双方视角各自可达且是不同路由** + 两视角事件集合不同 + 私域负控）+ admin-route 门。缺: 从 dashboard 点进 `/quotagent` 的跨仓机检。 | must | P2 | AC-UXWEB-001、AC-ADMIN-001 |
| FR-USREQ-012 | **「AI agent 的决策建议」由 subagent 模拟双方交互需求并做成系统级插件供应**。原话：「AI agent 的决策建议」由 subagent…做成**系统级插件供应**。含义: 建议层是系统级插件（subagent 产出 → 既有提权路径进树），且**不能批准、不假装能发**。载体 `advice-panel.mjs`、`userplugin-elevate.py`。验收: advice / user-space 门。缺:「建议→动作」一键闭环机检。 | must | P2 | AC-ADV-001、AC-USERPLUG-010 |

## 7. 阶段分布（用于排期）

| 阶段 | must 数 | 核心内容 |
|---|---|---|
| P0 | 35 | 内核四件套 + 运行时/CLI 骨架 + 归一化 + 单进程端到端闭环 + 指标基线 |
| P1 | 24 | 双侧进程 + QEP 同步 + 澄清广播 + 护栏 + 审计重建 + 场景集 |
| P2 | 12 | 邮件/ERP 接入 + 谈判 + 自进化流水线 + 留存合规 |
