# ADR-0022 人工门的派分事实（审批人与超时策略）随开单落账本 body

Status: accepted

## Problem

`ApprovalService.request()` 在内存里就把一个门的**派分事实**定了下来（`approvers` / `timeout_policy` /
`timeout_s` / `escalate_to` / `requested_at`，形状见 ADR-0010 §1），但落账时 `_append()` 只写 7 键：
`approval_id` / `scope` / `ref` / `payload_hash` / `status` / `decided_by` / `comment`。
于是"账本可见"与"服务可见"给出两个不同的答案（仓库在 2026-09-22 实测到以下四条）：

1. **「卡在谁」读不出来**：待批队列的面板（`gate.queue`）、工作台（`gate.todo`）与通知源（`notify.gates`）
   读的都是**账本行**（宿主 `host.rows(view)`），而 `approval/requested` 行不带 `approvers` ——
   界面只能如实标一句「账本行未带审批人」。只有升级/委托**之后**（`approval/escalated` 的 body 带
   `approvers`/`escalated_to`）才可回读，即"待办看得见、却看不出该催谁"。
2. **「超时剩余 / 该催谁」同样读不出来**：`timeout_s` 与 `escalate_to` 只在内存里，
   界面只能给出「已超时？是/否」这种粗粒度，算不出倒计时。
3. **文档声明 ⊃ 实现**：`docs/design/05-events.md` §3 声明 `approval/requested` 的 body 应带**超时策略**，
   而实现里没有；这类漂移没有任何门会发现（事件门只比事件名与 @mode）。
4. **同一事实两个真源**：`ApprovalService.queue_view()` 说得出"卡在谁、超时策略、已等多久"，
   而 UI 走账本读取路径得不到同样答案 —— 直接违反规则 2 的读法（模型/界面可见的输入必须能由
   append-only 账本重建）。

## Decision

1. **账本 body 追加 5 个派分事实键**（`GATE_FACT_KEYS`）：
   `approvers` / `timeout_policy` / `timeout_s` / `escalate_to` / `requested_at`。
   `_append()` 原有 7 键的键名与取值**逐字节不变**，新键追加在其后；值为 `None` 的键（如未指定
   `escalate_to`）**不进 body**，不留空噪声。
2. **追加型，不改旧行语义**：旧账本行没有这 5 个键 ⇒ 读侧一律按缺省处理
   （`ApprovalService.replay()` 的 `setdefault`、`queue_view()` 的 `.get(..., DEFAULT)`、
   宿主 `src/system/approval/code/ui.mjs` 的 `gatesOf()` 用 `?? previous.X` 向前回溯）。
   因此**同一本旧账本**在改前/改后读出来的待批队列逐字段一致（旧行"读不出来"仍是读不出来，
   只是不再把它写成"账本行未带"这种口径缺陷）。
3. **不新增事件类型**：`approval/requested|granted|denied|reminded|escalated|aborted` 的名称与 `@mode`
   一个不动（事件门照常同表比对）。`src/system/approval/tools/gate-actions.py` 的升级/委托/终止写
   `{**last_body, ...}` ⇒ 这些后续行**自动**带上这组键，工具一行不用改。
4. **载荷仍只出指纹**：`payload` 只落 `payload_hash`；`summary`（由 payload 派生）与 `reason` 正文
   **不进账本** —— 与本仓"凭据正文与私钥一律不进账本、只出哈希与计数"的既有纪律一致。
5. **文档按实现校正**：`docs/design/05-events.md` §3 的 `approval/requested` 行写清 body 实际带的键
   （7 个旧键 + 5 个派分事实），并明说载荷正文与摘要不进账本。
6. **服务面签名不动**：`request/decide/sweep/queue_view/get/pending/records/chain/granted/require`
   的参数与返回值一字不改；`ApprovalService` 仍是唯一生产者（GUI 侧只 spawn 唯一写者，
   不新增写路径）。

## Consequences

- 界面能答的三个问题（**卡在谁 / 超时策略与倒计时 / 该催谁**）在**开单后即可回读**：
  面板多一列「超时剩余（按事实时刻）」，「卡在谁」直接来自账本 body；升级/委托之后
  `approvers` 被 `approval/escalated` 改写，历史由行序列自证。
- 账本每行 `approval/*` 体积略增（≤ 5 个短键），哈希链按既有公式重算，**旧行哈希不受影响**
  （append-only：新行新哈希，旧行字节未动）。跨方无需重新对齐：`approval/*` 不在 QEP 交换面上。
- 收益的代价是"门的派分事实现在是**账本事实**"：改派只能靠**追加**行（升级/委托），不能原地改 ——
  这与"一条事实一次写入"的既有形态一致，不是新约束。
- 验证：`tools/verify.sh events`（事件表与文档一致）、`tools/verify.sh webui`、
  `tools/verify.sh plugin-lifecycle`、`tools/verify.sh docs`；真 HTTP 回读见本批 `tmp/` 下的验证脚本输出
  （开单 → 回读账本 body → 面板显示「卡在谁 / 超时剩余」）。

## Alternatives rejected

- **只改界面（让 UI 去调 `queue_view()` 而不是读账本）**：GUI 的快照是账本投影，加一条"必须问服务进程"
  的读取路径就会给同一条事实造第二个真源；且宿主与 Python 服务不同进程（GUI 动作一次一进程），
  这条路在重启后就没有答案。
- **新增事件类型**（如 `approval/assigned`）：本轮不需要新类型就能表达（追加键即可），
  而新类型要动事件表、命名表与文档三处，且是账本格式的**更大**变更面。
- **把 `summary` / `flags` / `confidence` 一并写进 body**：`summary` 由 payload 派生，
  写进账本会破坏"载荷只出指纹"的既有纪律；后两者本来就在服务面与队列视图里，不属于"读不出来"的缺口。
- **在读侧推断审批人**（从 `scope` 或授权区间表猜一个人）：会"编人名"，违反本仓"读不出来不编"的纪律。

## Revisit conditions

1. 若出现**并行会签**（一个门要多个角色各自落账批准），`approvers` 需要升级为
   `{role, human, at}` 之类的结构 ⇒ 那时新写一条 ADR（追加键的语义变更，不得原地改）。
2. 若超时策略需要**按角色/金额动态取**（而不是开单时定死），本 ADR 的"开单时定死"要重审。
3. 若"给人看的一行摘要"被证明必须可由账本回读（而不是只出 `payload_hash`），
   需要一条独立 ADR 说明该摘要为何不构成私域泄漏面（现在不写，是因为它由载荷派生）。
