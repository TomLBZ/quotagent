# ADR-0024 承诺 / 发 PO 必须**消费**一扇别人批过的门（不得自签自批）

Status: accepted

## Problem

`AGENTS.md` 规则 3 与 INV-005 说「对外承诺必须经人工门」，`29 §15` 说「人签门只认会话」。但 2026-09-23 的
**第二次终局验收实测**（`tmp/p47-shots/REPORT.md` §0.5 / 表 11–12）发现：授标承诺与发 PO 的「人门」**是自签自批**。

- 唯一写者 `src/domain/commitments/tools/commitment-apply.py` 在**同一次落账**里先
  `approvals.request(scope=award.commit, ref=<意向>, approvers=[actor])`，紧接着
  `approvals.decide(..., by=actor, decision='granted')`，再落 `award/committed`（发 PO 同形，`scope=po.issue`）。
- 于是「有批准记录」成立，**主管没有否决权**：他不批，承包商照样能签（实测 `seq 23–25`：`ap-0007`
  `approvers=[human:liwei]` + `granted decided_by=human:liwei` + `award/committed.approval_id=ap-0007` 同一秒）。
- 主管**真正批过**的那扇门（`ap-0001`，`decided_by=human:limin`）**不被任何下游引用**；而四问一屏查到的
  「谁批的」是署名者自己 —— **界面上看不出来**（比卡住更危险：产品主张被证伪而无人察觉）。
- 服务层的 `ApprovalService.require()` 只答「有没有一条适用于这个 ref 的批准记录」，**不答门与署名者的关系**；
  所以这个缺口不是某个写者写错了参数，而是**判据缺一层**。

## Decision

1. **人门判据只有一处**（`src/system/approval/code/approval.py#signoff_verdict`，写者与服务层共用；
   服务侧入口 `verify_signoff`，选择器 `select_signoff`，`ApprovalService.signoff()`）：一扇门能被 `signer`
   这次署名消费，必须同时满足
   ① `scope`+`ref` 对得上被批对象（FR-APPROVE-002，不可跨动作复用）；② 状态 `granted`；
   ③ 批的人是人（`decided_by` 以 `human:` 开头）；④ **批的人不是这次署名的人**；
   ⑤ 开单时点名了审批人（`approvers`，ADR-0022 的派分事实）⇒ 批的人必须是点名的那位
   （旧行没有 `approvers` ⇒ 只按 ①–④ 对账，回执**如实标**「开单时未点名审批人」）。
2. **只消费，不自造**：`commitment-apply.py --step commit|po` 在**任何写动作之前**只从**本侧账本**里挑一扇
   已存在的门（`ApprovalService.records()` 的重放结果，取**最后一扇**通过的）。挑不到 ⇒ **具名拒**
   （`approval-required` / `approval-not-granted` / `approval-denied` / `approval-aborted` /
   `approver-must-differ` / `approver-not-named` / `approver-not-human`）+ `next_action`（去哪儿开单、该找谁批），
   **账本零新增**（`ledger_added: 0`，两侧都不新增）。
3. **服务层也是同一判据**（结构性，不只 GUI）：`CommitmentGate.commit_award` / `issue_po` 在
   `require()` 之后调 `verify_signoff(...)`，`signer = self.actor`。任何调用方（测试、将来别的通道）都绕不过。
4. **自签自批 = 显式运营开关，默认关闭**：`<ui-shared>/commitments/policy.json` 的
   `{"allow_self_approval": true}`（普通文件、0600、只认真布尔；**文件不存在 = 关闭**）。形状不合法 ⇒
   `policy-malformed`（rc 2，**不当作关闭**：静默忽略一个坏开关等于让人以为开关开着）。
   开关**打开**且没有可消费的门时，写者才按老办法自行开单+批准，并在回执与界面上**如实写**
   「本次批准来自**你本人署名**（自签自批：显式开关已开）」（回执字段 `self_approved` / `gate.approver_is_signer`）。
5. **界面如实（门没被真正用上就不装作有）**：授标链两列「人门：承诺 / 发 PO」（可提交 / 你自己批的 / 还在等谁）
   与「谁签的 · 谁批的」；PO 对象页「谁批的 vs 谁签的（人门成立吗）」；「已决定的门」多一列
   「被谁消费（下游署名 vs 谁批的）」+ 计数 `approver_differs` / `not_consumed`；动作回执把人门那段提到最外层。
6. **账本格式零变更**：不新增事件类型、不改任何既有 body 键（旧行一字不动）；变的只是**判据与界面读数**
   —— 这条 ADR 登记的就是这处**语义变更**（AGENTS.md 规则 8）。

## Consequences

- 主管的否决权成为**结构性事实**：他不批（或驳回、终止），下游就落不了账（实测：无门 ⇒ `approval-required`、
  自签自批 ⇒ `approver-must-differ`，两次都**两侧账本 sha256 逐字节一致**）。
- 「谁批的 ≠ 谁签的」在账本里可逐行对账：`award/committed` / `po/issued` 的 `approved_by`（= 门的 `decided_by`）
  与那一行的 `actor`（署名）**不是同一个人**；旧数据里这两者相同 ⇒ 界面如实标「同一个人（自签自批）」（**不美化历史**）。
- 正例的代价：**承诺与发 PO 各需要一次开单 + 一次他人批准**（两次动作），回执里 `ledger_added` 从 3 变 1
  （少落两条 `approval/*` 行：门本来就存在，不该重复开）。
- 沙盘演示必须跟着改：沙盘的演示身份是**按档位**生成的（`actors[side]`，每档一个，不建名册）⇒ 承诺链里
  「另一个人」借 `home` 档生成 `demo-home`（沙盘面板步骤表写「（home 侧）」）。沙盘**不放宽判据**：
  没有门 / 自签自批在沙盘里同样被具名拒（`docs/design/29-webui-gui-app.md` §11 真源 + `sandbox-and-demo.md` §6）。
- 反向兼容的边界：旧账本（P47 之前/之中的行）**照旧可读**——旧门没有 `approvers` ⇒ 按 ①–④ 判；已被
  `award/committed` 消费的旧行**不会被追溯否定**（我们不重写历史，只在界面上把「同一个人」标出来）。

## Alternatives rejected

- **给审批队列加一条「事后追认」**：追认不解决「他不批也能签」，只是事后补一张纸。
- **把开关做成界面上的勾选框**：那等于把判据降级成「点一下就能过」，人门自证作废（与 §2/§16 的纪律冲突）。
- **只改写者、不改服务层**：GUI 之外的调用方（测试、脚本、将来的通道）仍能自签自批 —— 判据就成了某一条路径的习俗。
- **要求 `approvers` 非空才算门**（更严）：会把 ADR-0022 之前的旧门一刀切死；本决策选择「旧门按 ①–④ 判 + 如实
  标『未点名』」，判据变强但**不追溯否定历史**。
- **新增事件类型**（如 `approval/consumed`）：账本格式变更面更大（事件表/命名表/读侧全族），而「消费」完全
  可由既有行推出（下游事实带 `approval_id`）⇒ 不新增。

## Revisit conditions

1. 若业务上出现**必须多人会签**的承诺（两个以上批准人），`approvers`/`decided_by` 要升级为结构 ⇒ 那时新写 ADR。
2. 若 `allow_self_approval` 开关在真实部署里被长期打开，说明「另有其人」这一前提不成立 ⇒ 要重审产品主张
   （而不是把它悄悄放宽）。
3. 若将来有**跨侧审批**的合法业务（例如供应商侧的人批承包商的承诺门），`signoff_verdict` 的 ④ 要扩展为
   「批的人 ≠ 署名的人」之外的**角色判据**（名册角色），那时新写 ADR 并同步 `people-and-roles.md`。
