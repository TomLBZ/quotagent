# ADR-0025 授权区间变更必须**另一个人**批过才生效（不得自提自批）

Status: accepted

## Problem

`AGENTS.md` 规则 3 与 `29 §15`：对外承诺与**改判定**的事必须经人工门。P49 给「授权区间（谁能批到多少）」
补上了界内登记入口（`authority.bands.set`），但那条路是**自助**的：`src/system/config/tools/authority-bands-apply.py`
在**一次运行**里 `ApprovalService.request()` 之后立刻 `ApprovalService.decide(by=session_human)` —— 请求人与
批准人是**同一个人**。于是：

- 「谁改的」答得出，但**没有第二个人**看过这次改动：一个人可以在同一秒里把「这笔钱谁能批」的限额改掉，
  而界面上写着"已批准"（审批队列里那条门从头到尾没有第二个人参与）；
- 与 P48 刚立的同一条产品主张**自相矛盾**：承诺 / 发 PO 已经要求"批的人 ≠ 署名的人"（ADR-0024），
  而**决定这些限额**的那条路却是自签自批 —— 门槛更低的那一环反而更松。

## Decision

1. **两段式**：`--step request` 提交（身份门 → 白名单/类型门 → **点名另一个复核人** → 落
   `approval/requested`（`scope=config.authority`、`ref=authority-band:<request_id>`）+ 一份 **0600 暂存件**），
   `--step apply` 落盘（复核通过后由人再签一次）。**提交这一步不写受管 YAML**，暂存件也**不进** config 收件箱
   （唯一落盘者扫不到"还没人批"的件）。
2. **判据只有一处**：落盘只消费一扇**已 granted、且批的人不是提交人、是人、是开单时点名的那位**的门 ——
   直接调 `src/system/approval/code/approval.py#signoff_verdict` / `select_signoff`（ADR-0024 的同一处实现），
   **不新造第二套词**：`approval-required` / `approval-not-granted` / `approval-denied` / `approval-aborted` /
   `approver-must-differ` / `approver-not-named` / `approver-not-human`，一律**账本零新增、文件零改动**。
3. **复核发生在审批队列**（既有唯一写者 `gate-actions.py --step grant|deny`，既有事件 `approval/granted` /
   `approval/denied`）：队列那一行**逐字给出要批什么**（读那份 0600 暂存件：哪一档、改成多少分、谁提交的、
   "批的人必须不是他"）—— 复核人答不出「我在批什么」就没法负责地批。读不到暂存件就**如实说读不到**
   （不替它编额度）。
4. **唯一放行开关**：`<ui-shared>/authority-bands/policy.json` 的 `{"allow_self_approval": true}`
   （普通文件、0600、只认真布尔；**不存在 = 关闭**；坏形状 ⇒ `policy-malformed`，**不当作关闭**）。
   打开时落盘回执**如实写**「批准人 == 提交人（自签自批：显式开关已开）」，界面上**没有**开它的按钮
   （与 ADR-0024 §4 同一条纪律）。
5. **账本格式零变更**：不新增事件类型、不改任何既有 body 键；变的是**判据与界面读数**（AGENTS.md 规则 8）。

## Consequences

- 「谁能批多少」的改动从此需要**两个人**（一个人提交、另一个人批准）；只有 `human:` 的署名能批（P8 的
  「agent 不得代批」不变）。
- 复核人候选来自**名册**（`<ui_shared>/people/roster.json`，本侧、除自己以外的人）：名册里没有第二个人时
  提交会被具名拒 `no-other-approver`（界面给下一步：让同事登录一次或在名册里加人）—— 这是**判据变紧**的
  必然代价，如实呈现而不是偷偷放行。
- 沙盘演示必须能造出「同一个侧的另一个人」：机制因此给会话所属侧多生成一个演示身份 `demo-approver`
  （P50 item ④）并写一份**临时名册**（`<沙盘目录>/people/roster.json`，随「清空沙盘」一起删；真实名册
  **零改动**）。
- 旧路径（P49 的单次自助登记）**不再存在**：同一条命令不写 `--step` 时按 `request` 走（**不落盘**），
  想落盘必须有人先批 —— 这处行为变更会让"老命令直接改配置"的调用方拿到 `approval-not-granted`（具名拒），
  而不是静默落盘。

## Alternatives rejected

- **保留自助登记、只在界面上写一句"这不是双人复核"**：那是把产品主张降级成免责声明；ADR-0024 已经否决过
  同类做法（"把开关做成界面上的勾选框"）。
- **让复核人直接改配置（`gate.grant` 时落盘）**：会把"批准"与"写受管 YAML"耦合成一条新写路径，
  且 0600 待办件的物化时机失去唯一处；本决策保持"人工门事实 → 待办件 → 唯一落盘者"三段不变。
- **新增事件类型（`config/authority-approved`）**：账本格式变更面过大；门与署名在既有 `approval/*` 行里
  已经完备（"谁批的/谁提交的"可从 `decided_by` 与开单行读出）。

## Revisit conditions

1. 若业务上要求**多个角色会签**才能改限额，`approvers` 要升级为结构（与 ADR-0024 的同一条件）⇒ 那时新写 ADR。
2. 若 `allow_self_approval` 在真实部署里被长期打开，说明"另有其人"这一前提不成立 ⇒ 重审产品主张。
3. 若将来授权区间的取值搬出受管 YAML（例如改为名册角色额度统一管），本条判据要跟着换载体 ⇒ 新写 ADR。
