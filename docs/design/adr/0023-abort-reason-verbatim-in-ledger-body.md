# ADR-0023 终止（`approval/aborted`）的理由正文进账本 body

Status: accepted

## Problem

审计型产品的底线是**一屏答出「谁、何时、为什么、依据哪一行」**。`approval/aborted` 在 2026-09-23 的
主管视角走查（`tmp/p41-shots/REPORT.md` §4.2 / §5.2）里两处答不出：

1. **「为什么作废」答不出**：人做的终止只在账本里留 `reason_sha256`，**理由正文只活在 0600 待办件里**
   （`src/system/approval/tools/gate-actions.py --step abort`）。待办件一旦归档/换机/被清理，这条门的
   「为什么」就永久不可回读 —— 而它正是唯一能解释"这次意图为什么作废"的事实。
2. **「谁决定的」空白**：`gate.decided` 面板读 `decided_by`，而终止行写的是 `aborted_by` ⇒ 面板对
   aborted 行永远空着（账本里其实有 `aborted_by`）。
3. **文档与实现两侧都没有把这件事说全**：`docs/design/05-events.md` 只声明显式给过键名的 6 个事件，
   `approval/aborted`/`granted`/`denied`/`escalated`/`reminded` 的 body 键集**一个都没声明**；
   既有的事件门（`tools/verify.sh events`）只比**事件名与 @mode**，body 键集漂移没有任何门会发现
   （ADR-0022 §Problem 第 3 条已实测过这条）。本批的逐字机检（`tmp/p42-shots/body-keys-audit.py`；
   P44 已搬到仓内固定位置 `src/system/repo-gate/tools/body-keys-audit.py`，判据未改 —— 只加了一个可选的
   `--json PATH`）把这条缺口量化成表：`approval/*` 全族「未声明」+ 同一事件多个写者给出不同键集。

## Decision

1. **人做的终止在 `approval/aborted` 行追加 `comment` 键 = 理由正文逐字**（与 `approval/denied.comment`
   同口径、同键名），`reason_sha256` **保留**：它仍是那份 0600 待办件的完整性锚点（正文与哈希可互证）。
   写入点只有一处：`src/system/approval/tools/gate-actions.py` 的 abort 分支（唯一落账本者）。
2. **追加型，不改旧行**：旧账本行没有 `comment` ⇒ 读侧按缺省处理，并**如实**显示
   「账本只带理由哈希 `sha256:…`，正文在 0600 待办件里」；旧行一个字节不动（append-only，哈希链不受影响）。
   跨方无需重新对齐：`approval/*` 不在 QEP 交换面上。
3. **超时策略触发的作废（`ApprovalService.sweep()` 的 abort 分支）不写理由、也不写署名**：
   那里**没有人类理由**，`comment` 保持空串、`aborted_by` 不写 —— 读侧据此如实显示
   「这条是超时策略 abort 的自动作废，没有人写过理由」。**不替它编一句**（与"不得读不出来就编"同纪律）。
4. **不新增事件类型**：`approval/aborted` 的名称与 `@mode`（emit/durable）一个不动，事件门照常同表比对；
   本变更只是**同一事件的 body 多一个追加键**。
5. **界面四问全部从账本回读**（`src/system/approval/code/ui.mjs` 的 `gate.decided`）：
   「谁决定的」= `decided_by || aborted_by`（都没有 ⇒ 如实写"未记录署名"并把账本行 `actor` 摆出来）；
   「决定时刻」= `decided_at || aborted_at || 账本行 ts`；「为什么」= `comment` 逐字（缺 ⇒ 如实说明多寡）；
   「依据」= 该门**最后一次写入**的账本行（`seq` + 事件名 + `actor`）。**缺就写缺，不编。**
6. **文档按实现校正**：`05-events.md` §3 的 `approval/aborted` 行写清 body 追加键（含 `comment`），
   并注明超时作废那一支没有理由正文；本 ADR 登记账本格式的这一处追加变更（AGENTS.md 规则 8）。

## Consequences

- 主管/审批人一屏可答：**谁终止的（`aborted_by`）、何时（`aborted_at`/行 `ts`）、为什么（`comment` 逐字）、
  依据哪一行（`seq` + 事件名）**；PO → 承诺 → 意向 → 报价 → **人工门**五段回溯的末段也自动显示真理由
  （那段读的就是 `comment`，读侧一行未改）。
- 账本每行 `approval/aborted` 体积略增（≤ 1 个理由字符串），**新行新哈希、旧行字节未动**。
- 收益的代价：**理由正文现在是账本事实**，一旦落账不可删改（append-only）。因此"终止理由"里不得写
  凭据/私钥/对方私域正文 —— 与"凭据正文与私钥一律不进账本"的既有纪律一致；要撤回只能再开一个门。
- 反向兼容的边界：读侧必须**同时**接受两种形状（有 `comment` 的新行 / 只有 `reason_sha256` 的旧行），
  且对后者**不许静默降级成"没有意见"** —— 要说出"账本里只有哈希、正文在待办件里"。

## Alternatives rejected

- **新增事件类型**（如 `approval/abort-reasoned`）：账本格式变更面更大（动事件表、命名表与文档三处），
  而"同一事件多一个追加键"已能表达；且新增类型会逼所有读侧（门时间线、周报、PO 回溯、投影）各加一条分支。
- **只改界面**（把 0600 待办件读回来显示）：待办件是**权限件**、会被归档/清理，且界面读它等于给同一条
  事实造第二个真源（服务重启后就没有答案）；理由不在账本 ⇒ 任何"看起来答得出"都是界面自述，不是事实。
- **换一个新键名放理由**（如 `reason`/`note`）：`comment` 已是全仓既有读侧口径（`approval/denied` 的
  意见、PO 回溯链的"为什么"、门对象页的"为什么"），换名只会让读侧多一个分支、多一处漂移面。
- **给超时作废也补一句 `comment`**（如"超时自动作废"）：那是把机器行为伪装成人类理由；读侧宁可如实
  显示"没有人写过理由"，判据看 `timeout_policy`/`requested_at`/行 `ts` 即可推出来。

## Revisit conditions

1. 若终止理由被证明**可能包含不得进账本的内容**（对方私域正文、成本、凭据），本决策要改成
   "账本只出摘要 + 待办件引用（哈希）"，并新写一条 ADR（账本格式语义变更，不得原地改）。
2. 若未来给终止引入**枚举原因码**（`code` 字段），`comment`（自由文本）与 `code`（可统计）并存的语义
   要重审：两者都进 body 还是只在服务面留 code。
3. 若出现**多方会签式终止**（多个署名者各自终止），`aborted_by` 需要升级为结构 ⇒ 那时新写 ADR。
