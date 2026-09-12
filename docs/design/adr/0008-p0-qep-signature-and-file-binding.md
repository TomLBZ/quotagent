# ADR-0008 P0 的 QEP 落地细节：签名机制与文件投递绑定

Status: accepted

## Problem

`08-trust-and-security.md` §6 要求"每方一对 Ed25519 密钥"，但 ADR-0007 规定 P0 只用标准库，
而标准库没有可用的非对称签名原语（`hashlib`/`hmac` 只提供对称与哈希）。同时 P0 必须把 QEP 的
"传输无关"落到一个可用绑定上（文件投递），并明确报文如何落账。这三件事都以**字节**形式出现在证据与账本里，
属于协议落地语义；按 `AGENTS.md` 规则 8（协议与账本格式变更必须新增 ADR）必须成文，否则后续每一轮都在猜。

## Decision

1. **签名机制（P0）**：`signature = "hmac-sha256:<key_id>:<hex>"`，密钥为参与方各自的共享密钥
   （`KeyStore`）。接口形状与 Ed25519 版本一致（`sign(participant, payload)` /
   `verify(participant, payload, signature)`），P1 换成 `ed25519:<key_id>:<base64>` 只需替换
   `KeyStore` 实现（T-202 / T-304）。验签覆盖除 `signature` 外的整个信封（规范化 JSON），与 `03` §2 一致。
   **P0 不得主张跨方不可否认性**：共享密钥意味着持有密钥的一方也能生成对方的签名；
   P0 提供的是"篡改可检出、来源错误可发现"，不是对外举证能力。
2. **文件投递绑定（P0）**：
   - 目录：`<root>/<participant>/{inbox,rejected}/`；
   - 命名：`<seq:06d>-<msg_id>.qep.json`（`msg_id` 为 26 字符 ULID 形态，Crockford base32 时间前缀）；
   - 原子写：先写 `<最终名>.tmp` 并 fsync，再 `os.replace()` 到最终名——**最终名出现即内容完整**，
     读取方只认 `*.qep.json`（忽略 `*.tmp`），因此不需要任何锁；
   - 坏文件不静默丢弃：解析失败者移入 `rejected/` 并留下 `*.reason`（含原因），供运维与审计读取。
3. **落账事件**：`kernel/qep-sent`（含完整信封，供崩溃后重发与 `prev_hash` 链恢复）、
   `kernel/qep-received`（msg_id / seq / body_hash 引用）、`kernel/qep-duplicate-dropped`（幂等命中留痕）、
   `kernel/qep-rejected`（结构/版本/签名/承诺批准不满足即拒收留痕）。事件类型已在 `05-events.md` §2 与
   `02-domain-model.md` §4 登记。
4. **去重两层**（`03` §5）：先按 `msg_id` 已见即丢弃；再由账本按
   `(correlation_id, type, body_hash)` 兜底。两层命中都写 `kernel/qep-duplicate-dropped`（带 `attempt` 序号），
   因此"重复投递不产生第二条事实"是**可审计的**，而不是静默丢弃。
5. **出站链**：`seq` 单调递增，`prev_hash` 指向上一条已发送报文的 `body_hash`；两者在端点构造时从账本
   `kernel/qep-sent` 重放恢复（`03` §7），因此崩溃后重发的 `msg_id` 与 `body_hash` 不变。
6. **承诺门前置**：`class=commitment` 且 `approvals` 为空 → 拒收；批准记录的 `by` 必须以 `human:` 开头
   （代签禁止），且必须带 `scope` / `at`（FR-QEP-002 / FR-APPROVE-001 / INV-005）。
7. **waterfall 声明必须给出短路理由**：`declare(name, "waterfall")` 无理由即报错，且默认事件表中每个
   waterfall 事件都必须在 `05-events.md` §5 拦截点总表有登记（FR-EVT-003 的机检形态，见 AC-EVT-002）。

## Consequences

**正向**

- P0 不引入任何依赖即可完成"构造 / 验签 / 篡改可检出 / 幂等投递 / 原子落盘"，AC 可在任意 Python 3.9+ 复跑。
- 签名接口形状与 P1 的 Ed25519 一致，替换点只有 `KeyStore` 一处。
- 重复投递与坏文件都有留痕；`seq` 空洞可从文件名枚举发现。

**负向**

- 共享密钥不具备不可否认性；P0 的信任结论不能用于对外举证（P1 补齐）。
- `rejected/` 需要人工巡检（P1 起纳入告警）。
- 文件投递的吞吐/延迟上限低，只适合 mock 与低并发现场（P1 relay 解决）。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| P0 用纯 Python 自实现 Ed25519 | 手写密码学是不可测的高风险项；P0 的目标是数据结构与流程正确，不是密码学强度 |
| P0 只留哈希不签名 | AC-QEP-001 要求"改动任一字段导致验签失败"；只留哈希缺少来源维度，且 P1 的验签回归没有基线 |
| 用对称加密（AES）替代签名 | 目标是完整性与来源可检，不是机密性；且标准库同样没有 AES 原语 |
| 文件名直接用 `msg_id` | 需要 `seq` 前缀保证按投递顺序枚举，06 位序号也便于人工巡检发现空洞 |
| 用文件锁保证半写不可读 | 锁在崩溃后不可靠；临时名 + rename 在 POSIX 上是原子的，且无需读取方配合 |

## Revisit conditions

1. T-202 / T-208 落地 Ed25519 与密钥轮换后，本 ADR 第 1 条被取代（新写 ADR 记录算法切换与过渡期）。
2. 若现场只能以邮件附件投递（V-011 的结论），文件名与 MIME 约定需新增 ADR。
3. 若 `kernel/qep-duplicate-dropped` 的噪声超过总事件量 5%，改为聚合计数事件（保留可审计性）。
