# ADR-0013 cordis 宿主与 Python 内核的桥接协议（NDJSON over stdio v1）

Status: accepted

## Problem

ADR-0012 定了"cordis 管组合、Python 管事实"，但没有定**怎么通信**。这决定了三件事的可行性：
(a) 人工门与账本唯一写者这两条不变量能不能在跨进程后仍然成立；(b) 崩溃/背压/半确认等故障下
账实是否一致；(c) 桥本身怎么被 repo 的 AC 体系证明（不能只靠"跑起来看看"）。

依据：独立 agent 评审（`docs/work/reviews/agent-review-cordis-integration.txt`，`docs/work/decisions.md`
D-003/D-004）。

## Decision

1. **传输与帧**：宿主用
   `spawn(root/tools/run.sh, ['-m','quotagent.bridge','--serve','--realm',realm,'--ledger',path])`
   启动**常驻**内核子进程（复用 ADR-0007 §2 的解释器解析契约；Python 侧实现落 `src/quotagent/bridge.py`）。
   协议走 stdin/stdout：**一行一个 JSON 对象**（NDJSON、UTF-8、无缩进、无内嵌换行），单帧上限 8 MiB
   （超限即 `invalid-request` 并断开，避免内存放大；分片留待后续 ADR）。**stdout 只承载协议帧**
   （进入桥模式后 Python 的 `print`/日志一律改走 stderr——这条本身是可执行断言）。
2. **版本协商（不兼容即拒绝，不降级）**：内核首帧 `{"v":1,"n":"kernel/hello","p":{...}}`，含
   `bridge.version/min_supported`、`kernel.version`、`qep_versions[]`、`features[]`、
   `events[]`（`{name,mode,durable}`，唯一真源在 Python 侧 `05-events.md` §2 的声明表）、
   `methods[]`（`{m,cls}`）、`ledger{path,head,seq,healthy}`、`realms[]`。
   宿主回 `bridge.init{accept_bridge:[...],profile,want_events,want_methods}`；
   **`accept_bridge ∩ 内核支持` 为空即以退出码 2 终止**（与 ADR-0006 §3 同构）。
   特性级降级必须落账 `kernel/bridge-degraded`（含缺失项与原因），**永不静默降级**；
   且**批准链、版本绑定、签名校验三项不可降级**（沿用 ADR-0006 §4）。
3. **方法面按 `cls` 四级，`commit` 面永不暴露**：
   - `read`（`ledger.read`/投影/证据读取）、`compute`（`norm`/`compare`/`guard`/`tco` 等纯计算）、
     `fact`（追加**已登记**的 fact 事件、`qep.receive/send`，必须带 `source` 标记，幂等靠去重键）、
     `commit`（承诺类与人工签署：`approval.decide`、`quote.submit`、`award.commit`、`po.issue`、
     `change.approve`）。
   - **`commit` 面不暴露给宿主**；调用即拒并落 `kernel/bridge-rejected`。人工签署只走交互式 Python CLI。
   - **`fact` 面 P1 默认关闭**（取评审 C 的更保守 `intents_only`；由评审 A 提出的受限 `fact` 面
     要放宽需另写 ADR 说明必要性）。
   - 由 Python 侧注入 `realm` 与操作者身份：**身份永不自我声明**（宿主不能自称 `human:*`）。
4. **错误码固定**：`invalid-request`（帧非法/超限/未知字段）、`unknown-method`、`commit-refused`、
   `version-mismatch`、`ledger-unhealthy`、`deadline-exceeded`、`backpressure`、`kernel-crashed`。
   错误响应必须带 `code` 与 `next_action`（沿用 P0 的拒绝语义：给出可行动的下一步）。
5. **背压**：`hello` 带 `credit_window`（默认 256），宿主每消费 N 条通知回 `bridge.credit`。
   窗口耗尽时：**durable 事件不可丢**（它们已在账本里，退化为"待补齐"），**live 通知可丢但必须落
   `kernel/bridge-backpressure`**（含丢弃计数与时间窗）；补齐用 `ledger.read{from_seq:last_acked+1}`。
   同一连接上响应优先于通知（避免事件洪水把一次 `compare.rank` 拖过性能预算）。
6. **启动/关闭/崩溃**：启动失败**不写账本**，退出码 3；关闭 `shutdown → SIGTERM → SIGKILL` 且不留孤儿；
   重启预算 3 次/30s，超预算**降为只读**（拒 `fact`/`commit`，保 `read`/`compute`）。
   重启后账本锚点（`head/seq`）不一致时先要求 `verify_chain`，失败即只读（ADR-0007 §6 的停发语义）。
   在途请求一律记为 **unknown（不得当成功）**；重发靠 `(correlation_id,type,body_hash)` 去重幂等。
7. **新增内核事件**（登记到 `05-events.md` 与 `02-domain-model.md` §4）：
   `kernel/bridge-degraded`、`kernel/bridge-rejected`、`kernel/bridge-backpressure`、
   `kernel/bridge-restarted`（emit/durable）、`kernel/bridge-fault`（emit/live）。
8. **桥自身的验收**：新增一组 AC（在 T-202 批次随 `acceptance-criteria.md` 与对应 FR 一起登记编号，
   本 ADR 不预先占用编号）：协议与五模式一致性（版本不符→退出码 2）、故障注入（SIGKILL/洪水/断连 →
   哈希链仍真、已 ack 的 durable 零丢失、live 有留痕、重发不产生第二条事实）、
   **承诺面不可达（对抗性：宿主尝试 commit 面必须被拒且留痕）**、直跑 vs 经桥的 digest 字节一致。
   入口 `tools/verify.sh bridge`。同时扩展 AC-RUNTIME-001 的断言：**无 Node 环境时 P0 的 34 条 AC
   与文档门必须全绿**（P0 不因引入宿主而失去可复跑性）。

## Consequences

**正向**

- 不变量在跨进程后仍有单一执行者：账本唯一写者、身份注入、`commit` 面不暴露，宿主无从绕过人工门。
- 背压与故障语义建立在既有 durable/live 分野上，不发明新概念；"unknown 不得当成功"避免账实背离。
- 桥是可机检对象（协议帧、错误码、故障注入），可以用 AC 证明而不是"看起来能跑"。
- P0 保持可复跑（无 Node 也全绿），引入宿主不牺牲可复现性。

**负向**

- 多了一层进程与协议：排障面变大，需要 `kernel/bridge-*` 事件支撑观测。
- `intents_only` 让宿主在 P1 无法直接产生业务事实，部分能力必须绕回 Python CLI（体验上更"重"）。
- 8 MiB 单帧上限对超大包不友好（分片留待后续 ADR）。
- 双运行时下"同一事件表两处存在"的风险靠"唯一真源在 Python + 启动即比对"压住，但要求纪律。

## Alternatives rejected

| 方案 | 否决理由 |
|---|---|
| 宿主直接以 Python 进程内嵌（`child_process` 里要求同一进程） | 无法隔离语义权威；等于让宿主拿到 `commit` 面的可能 |
| HTTP/端口式桥 | 引入监听端口与网络面（防火墙、鉴权、CSRF 面），掉线语义比 stdio 复杂；P1 无收益 |
| AF_UNIX socket | 帧格式相同但无额外收益，且跨平台/容器里路径与权限处理更麻烦（留 P2 备选） |
| 宿主直接写账本（或复制一份账本逻辑） | 违反 INV-001 与规则 2 的唯一写者；历史可被两条路径同时改 |
| 一次性放开整个方法面（含 `commit`）以简化实现 | 直接破坏 INV-005；桥会成为绕过人工门的新入口 |
| 版本不匹配时降级通信 | 与 ADR-0006 的"不兼容即拒绝"冲突；静默降级会让两侧语义悄悄分叉 |

## Revisit conditions

1. `fact` 面确有 P1 必要（例如宿主侧产生"已登记 fact"的采集事件）→ 另写 ADR 放宽，并补对抗性 AC。
2. 单帧 8 MiB 或吞吐成为瓶颈 → 引入分片/流式帧的 ADR，并更新桥接 AC。
3. cordis 发布正式版或 `@cordisjs/plugin-loader` 进入稳定线 → 升级后在 `host/README.md` 记录差异。
4. T-201/T-202 落地后若发现"响应优先于通知"仍不足以保证性能预算，重新评估连接级流控参数。
