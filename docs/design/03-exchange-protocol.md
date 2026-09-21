# 03 QEP：Quote Exchange Protocol

<!-- budget: 24 KB. 变更本协议必须新增 ADR（AGENTS.md 规则 8） -->

## 1. 目标与硬约束

| 目标 | 约束的由来 |
|---|---|
| 传输无关 | 现实中双方可能只有邮件或共享目录；协议不得依赖某种基础设施存在 |
| 无中心权威 | 双方各自持有账本，任何一方离线都能继续本地推进（只是对外步骤挂起） |
| 离线/乱序容忍 | 现场网络与人工节奏不可控 |
| 幂等 | 同一条报文重复到达不得产生第二条事实 |
| 可审计 | 每条报文可独立验证（哈希 + 签名），且与本地账本条目一一对应 |
| 不静默降级 | 版本不兼容必须显式拒绝（P7） |
| 承诺不可伪造 | 只有带人工批准记录的报文能推进 Commitment（P2/ADR-0004） |

## 2. 信封（Envelope）

```json
{
  "qep_version": "1.0",
  "msg_id": "01J...ULID",
  "correlation_id": "01J...ULID",
  "seq": 42,
  "prev_hash": "sha256:...",
  "sent_at": "2026-09-11T22:40:00Z",
  "sender": { "participant_id": "sup-A", "kind": "supplier", "realm": "supplier:sup-A", "agent_id": "price-agent@1.3.0" },
  "recipients": ["con-B"],
  "refs": { "package_id": "pkg-014", "rfq_rev": 2, "quote_id": "q-0007", "ticket_id": "t-0003" },
  "type": "quote/submitted",
  "class": "fact",
  "body_hash": "sha256:...",
  "body": { "...": "见 §3" },
  "approvals": [ { "by": "human:zhang", "at": "2026-09-11T22:39:12Z", "scope": "quote.submit", "sig": "..." } ],
  "signature": "ed25519:..."
}
```

**字段规则**

- `class ∈ {fact, intent, commitment}`：决定接收方可以如何反应（§4.3）。
- `refs.rfq_rev` 为 fact 类报价报文**必填**：接收方据此做版本一致性检查（P6）。
- `approvals` 为空或缺失时，`class=commitment` 的报文一律拒收（不是警告，是拒收）。
- `body_hash` 覆盖规范化后的 `body`（键排序、无空白、UTF-8 NFC）。
- `prev_hash` 指向本方账本中上一条已发送报文的 `body_hash`，形成链，用于检测篡改与丢失。
- `signature` 覆盖除 `signature` 外的整个信封。
- P0 的签名机制与文件投递命名/原子写规则见 ADR-0008；落账事件 `kernel/qep-sent` /
  `kernel/qep-received` / `kernel/qep-duplicate-dropped` 见 `05-events.md` §2。

## 3. 报文体类型

| type | class | 必要 body 字段 | 接收方动作 |
|---|---|---|---|
| `rfq/published` | fact | `package{...}`, `line_items[]` | 建立包版本；通知己方 intake |
| `rfq/amended` | fact | `rev`, `changes[]`（逐条目的字段级 delta） | 冻结旧版本报价；标记"基于过期版本"的草稿 |
| `clarification/asked` | fact | `ticket_id`, `question`, `refs[item_ids]` | 建立澄清工单 |
| `clarification/answered` | fact | `ticket_id`, `answer`, `broadcast_to[]`（必须包含全部在册投标人） | 校验广播完整性；缺失即拒收 |
| `quote/submitted` | fact | `quote{...}`（含 `rfq_rev`、条目、偏差、有效期、交期） | 入账；触发归一化 |
| `quote/revised` | fact | `quote_id`, `supersedes`, `delta{}` | 追加新版本，旧版永久保留 |
| `quote/withdrawn` | fact | `quote_id`, `reason` | 入账；从比价候选移除 |
| `award/intent` | intent | `quote_id`, `reason_refs[]` | 记录意向；**不产生义务**；可就复 |
| `award/confirmed` / `award/declined` | fact | `intent_id` | 推进或关闭授标 |
| `award/committed` | commitment | `intent_id`, `approved_by`, `terms` | 产生采购义务；唯一能派生 PO |
| `po/issued` | commitment | `award_id`, `lines[]`, `terms` | 对齐订单 |
| `change/proposed` | intent | `ref_quote_lines[]`, `delta`, `basis_unit_price_ref` | 建立变更议题 |
| `change/approved` | commitment | `change_id`, `delta_amount`, `approved_by` | 变更生效 |
| `evidence/pack-request` | intent | `scope`, `period` | 请求审计包 |
| `evidence/pack` | fact | `events[]`, `merkle_root` | 审计留存 |
| `relay/receipt` | fact | `msg_id`, `received_at`, `body_hash` | 投递确认（用于重发判定） |

## 4. 账本同步：三方协调 + 字段权威方

### 4.1 Cordis 给的原型与其局限

`代码` `cordis/packages/include/src/journal.ts:195-242` 的 `reconcile(journal, base, theirs, fileOwned)`
做了 base / theirs / journal 三方协调，冲突策略是"**文件赢**"并有上报。可直接借用的部分：
三方输入、逐键判定、冲突上报、合并折叠（`mergeRecords`）。

不可直接借用的部分：**跨组织没有"共享文件"这个赢家**。两端都在写，必须另立仲裁规则 → ADR-0003。

### 4.2 同步算法（每方本地执行）

```
输入: base(上次双方共识 revision 向量), mine(本地未同步 journal), theirs(对方 journal)
1. 逐字段取三值 b/m/t，分类:
   m==t           → 一致，确认
   m!=b, t==b     → 我方改，采纳
   t!=b, m==b     → 对方改，采纳
   m!=b, t!=b, m!=t → 冲突 → 交 §4.3 权威方规则
2. 权威方胜出者写入本地账本（事件类型 `sync/merged`），败者产出 `sync/conflict` 事件
3. 冲突若涉及 class=commitment 字段 → 一律不自动合并，转人工裁决，状态挂起
4. 生成新的 base（revision 向量），双方各存一份
```

### 4.3 字段权威方矩阵（默认值，可由项目 patch 覆盖）

| 字段族 | 权威方 | 理由 |
|---|---|---|
| 包范围 / 清单条目 / 工程量 / 单位 / 计量规则 / 接口责任 | 承包商 | 发包方定义工作内容 |
| 规格引用与图纸版本 | 承包商 | 图纸由业主/设计方控制 |
| 成本构成 / 利润率 / 内部产能 | 供应商（且不外发） | 供应商私域 |
| 单价 / 条目金额 / 偏差声明 / 除外责任 / 交期承诺 | 供应商 | 报价是供应商的承诺 |
| 付款条款 / 质保 / 罚则 / 验收标准 | 承包商 | 合同条款由发包方拟定 |
| 澄清问题 | 提问方 | 谁问谁拥有 |
| 澄清答案 | 承包商 | 解释权在发包方 |
| 交期日历 / 里程碑 | 双方各自维护己方日历；承诺以报文为准 | 日历是私域，承诺是交互 |
| 审批记录 | 各自本方 | 不可代签 |

**规则**：任何一方对其**非权威字段**的本地修改都不会外发，而是产出 `intent/suggestion`
（建议）供对方采纳；这样数据主权与"我想改对方的东西"这两个需求同时成立。

### 4.4 冲突上报与裁决

`sync/conflict` 报文含：`entry_id`、`field`、`mine/theirs/base` 值、`authority`、`auto_resolution`。
- 非承诺字段：按矩阵自动解决，仅留痕。
- 承诺字段或矩阵未覆盖：`resolution=pending_human`，双方各自挂起该条目的推进，直到
  人工在双方一侧各留一次批准记录（两侧都有才算成立，避免单边伪造）。

## 5. 幂等、顺序与重发

| 机制 | 规则 |
|---|---|
| 去重 | `(msg_id)` 已见即丢弃；`(correlation_id, type, body_hash)` 相同视为同一事实 |
| 顺序 | `seq` 单调递增；出现空洞 → 停止推进依赖该 seq 的条目并请求重发，不跳号处理 |
| 重发 | 发送方在未收到 `relay/receipt` 超过阈值后重发同一 `msg_id`（内容不变，哈希不变） |
| 乱序到达 | 允许；但不允许"越过空洞的状态跃迁"（例如未收到 `rfq/amended` 就收到基于 rev=2 的报价 → 挂起） |
| 投递 | 至少一次语义 + 幂等 = 实际一次；不做 exactly-once 假设 |
| 回执 | 接收方应用成功后回 `relay/receipt{msg_id,seq,ack_by,at}`（**传输确认**，不承载业务语义）；发送方在未收到回执超过阈值后重发同一 `msg_id` |
| 控制类报文 | `relay/receipt` 与 `relay/resend-request` 是**控制类**：不互相回执（否则无界乒乓），且不计入待回执集合 |

> 实现口径：`capabilities()` 交换 `qep_versions[]`/`features[]`；协商结果取版本交集最大值；特性取交集，差异落 `kernel/qep-degraded`；`approval_chain_v2`/`signature_verify`/`version_binding` 缺失即**拒绝**（不可降级）。落账事件：`kernel/qep-gap-detected`、`kernel/qep-gap-filled`、`kernel/qep-degraded`、`kernel/qep-resent`（见 `05-events.md` §2）。

## 6. 版本协商

1. 双方在通信建立时交换 `capabilities{qep_versions[], features[]}`。
2. 取 `qep_versions` 交集的最大值；交集为空 → 拒绝通信并产出 `qep/rejected`（附双方版本列表）。
3. `features`（如 `pack_deltas`、`approval_chain_v2`）不匹配时，**降级到双方都支持的最小特性集并显式记录**；
   这不违反"不静默降级"，因为它有账本事件，且不改变已承诺义务的语义。
4. 版本升级流程：新增版本号 → 双方各自支持新旧两版一个过渡期 → 过渡期内新报文用新版本、
   旧版本报文仍可读 → 过渡期结束后旧版本报文只读归档（不改写历史）。

## 7. 崩溃与中断恢复

- 每方账本是**唯一权威**：崩溃后重放账本重建投影，未同步的 journal 从账本中尚未标记
  `synced` 的事件重建（幂等，重复同步无害）。
- 发送侧：崩溃前已追加但未发送的事件在恢复后重发（`msg_id` 不变，因此不会造成重复事实）。
- 接收侧：已接收但未入账的报文保存在 `inbox/`，恢复后按 `seq` 与去重规则补入。
- **不做"内存里正在算的报价"的恢复**：草稿属于 Intent，允许丢失；重建草稿的成本远低于
  错误恢复一个半成品报价的风险（P8 的推论）。

## 8. 安全要点（细节见 08）

- 每方独立密钥对；`signature` 用 Ed25519；密钥轮换通过 `participant/key-rotated` 报文宣告，
  旧密钥保留验签能力一个过渡期。
- 重放防护：`msg_id` + `sent_at` 窗口 + `prev_hash` 链。
- relay 只做转发与存证，**不持有私域数据**；relay 可被替换为共享目录或邮件附件而不改语义。

## 9. 与 Cordis 的差异一览（供审阅者快速比对）

| 维度 | Cordis（`include`） | QEP |
|---|---|---|
| 参与方 | 单进程内的配置层与运行时 | 两个独立组织 |
| 冲突赢家 | 文件赢 | 字段权威方 + 承诺类转人工 |
| 作用对象 | 条目（EntryOptions）与键 | 领域实体字段 + 履历事件 |
| 幂等 | 进程内幂等 | 需显式 `msg_id`/`body_hash` |
| 传输 | 内存/文件系统 | 文件、HTTP、邮件皆可 |
| 信任 | 同一信任域 | 跨信任域，需签名与批准链 |
