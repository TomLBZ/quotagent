# ADR-0019 谈判轮次与让步的边界

- 状态：accepted（2026-09-21T11:23:47Z）
- 依据：需求 `FR-NEGO-001`、`FR-NEGO-002`；约束 `FR-PRICE-002`、`FR-CAP-002`、`INV-008`、D-018、D-042
- 设计：`docs/design/16-negotiation-design.md` · 契约：`docs/design/17-negotiation-contract.md`
- 事件：`negotiate/*`（`negotiate/round` 为既有「规划中」条目，不改名不改模式）

## 1. 决定

1. **一轮 = 对一个条目的一次价格让步提议**；身份键 `(thread_id, attempt_no)`，被拒的尝试也占号（便于复算与追责）。
   线程以 `correlation_id = thread_id` 把整族 `negotiate/*` 串起来。
2. **只谈价格**：数量走包升版、交期属 `FR-CAP-002` firm 语义、条款归条款族 —— 越界维度直接拒（`UnsupportedMoveDimension`）。
3. **让步空间只来自既有事实**：底线 = 既有成本模型 `unit_cost()["excl_tax"]` × (1 + `negotiate.min_margin_pct`/100)；
   区间取既有 `pricing.authorized_band.*`。三个新键缺任一即拒（`NegotiationPolicyMissing`），**不兜默认值**；
   边界以 `negotiate/bounds-declared` 落账（带 `policy_hash` + `cost_artifact_ref`）→ **可复算**。
4. **让步必过人工门**（`FR-NEGO-002`）：恰好一个新增 scope `negotiate.price-concession`，
   `ref = "{thread_id}:a{attempt_no}"`；超时仍只有 remind/escalate/abort，**无自动批准**；
   越界/越限是**拒绝**而不是"过门"（拒绝也要落 `negotiate/round-rejected`，含 code/reason/next_action）。
5. **承诺出口不变**：本服务**不产生义务**（无 commitment 事件、无 PO、无对外发报价）。
6. **`negotiate/*` 家族**：`bounds-declared`(emit) · `opened`(emit) · `round`(serial, intent) ·
   `round-rejected`(bail) · `closed`(emit)；无 `waterfall`。

## 2. 被否决的选项

- **用 `nego/*` 命名**：与 `05-events.md` 已登记的 `negotiate/round` 冲突 → 否决（"声明即登记"要求同族同前缀）。
- **让步空间由模型/启发式生成**：`D-018` 已定"精确数值必须留在内核侧" → 否决。
- **越界让步走人工门放行**：会把"超过授权带宽"变成可批准事项 → 否决（越界就是越界）。
- **轮次上限只记在内存**：重启即失效 → 否决，上限来自账本重建（`replay()`）。
- **把被拒轮次不落账**：会丢追责链 → 否决（`round-rejected` 必须落）。

## 3. 后果

- 好处：谈判全程可复算、可审计；代理人**不能**自行越过人给的底线与带宽。
- 代价：每次让步都要一次人工门（人工成本换安全性）；数量/交期维度暂不支持（见 P2 切片）。

## 4. 机检（≥15 条，实现轮次交付）

越界/越限/越带宽逐条拒并落拒绝事件 · 缺门必拒（`ApprovalRequired`）· 轮次上限从账本重建 ·
`recompute` 逐字节可复现且私域不出 realm · 同 `(thread_id, attempt_no)` 重复提交幂等或冲突 ·
账本链仍真 · 事件两侧登记一致（`tools/check-events.py`）。
