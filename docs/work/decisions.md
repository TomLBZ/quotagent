# 决策日志（P1 起）

<!-- budget: 32 KB。一行一决策；重大架构决策另有 ADR；评审原文在 docs/work/reviews/（.txt） -->

规则：

1. 每行必须有**依据**（数据、评审、指令或 ADR 编号）与**决策者**（`human:` / `agent:<角色>`）。
2. 用户 2026-09-12 指令：人工批准原则上默认通过；**独立 agent 的评审结论可代替人类决策**，
   但必须留下本日志 + 评审原文（`docs/work/reviews/`）+ （架构级）ADR。
3. 不可被自动化移除的人的门（`07` §6）仍然成立：**V 项结论、G0/G1 签署、承诺类动作的批准**只能由人签，
   agent 不得代填；被"假设通过"的项必须显式标 `not_a_conclusion`。

| 编号 | 日期 | 决策 | 依据 | 决策者 | 影响 |
|---|---|---|---|---|---|
| D-001 | 2026-09-12 | 宿主层**直接依赖 cordis 4.0.0-rc.10**（npm `latest`），取代 ADR-0001"不引入其代码"条款 | 用户指令（不重复造轮子）+ 实测安装与语义探针 EV-038 | `human:用户指令` + `agent:B7` | ADR-0012；`host/`、`tools/cordis.sh`、`tools/verify.sh cordis` |
| D-002 | 2026-09-12 | 边界：**cordis 管组合，Python 管事实**（账本唯一写者）；宿主不得直接写账本 | ADR-0012 + 评审 A（R1/R3 风险） | `agent:review-cordis`（B7 复核接受） | ADR-0012/0013；桥接与 profiles 的实现约束 |
| D-003 | 2026-09-12 | 桥接 = **stdio NDJSON JSON-RPC v1**（`tools/run.sh -m quotagent.bridge --serve`），带 `kernel/hello` 版本握手与信用窗口背压 | 评审 A §3（传输/帧/握手/错误码/背压） | `agent:review-cordis`（B7 复核接受） | ADR-0013；批次 B3/B4 的实现与 AC |
| D-004 | 2026-09-12 | 宿主**默认只发意图/命令**（`intents_only`）；`commit` 面永不暴露；`fact` 面 P1 默认关 | 评审 A × 评审 C 的差异（A 允许受限 fact、C 主张 intents_only）；取更保守者 | `agent:review-cordis` + `agent:review-evolution`（B7 裁决） | ADR-0013；安全边界（INV-005 在桥路径下成立） |
| D-005 | 2026-09-12 | P1 推进前提：**假设 V-001..V-012 全部通过**（用户指令）；`register.json` 保持 `open` 并新增 `planning_assumptions`（标 `not_a_conclusion`） | 用户指令 | `human:用户指令` + `agent:B7` | ADR-0014；T-117 仍待人工签字，G0 仍待人工签署 |
| D-006 | 2026-09-12 | MVP 判据与削减顺序取评审 B 的 **MVP 线 + C1..C8**；"绝不许假"清单（8 项）同期生效 | 评审 B §1/§6 | `agent:review-p1-plan`（B7 复核接受） | ADR-0014；批次验收与演示脚本 |
| D-007 | 2026-09-12 | P1 执行顺序取评审 B 的 **16 批依赖序**（B1 文档缺口 → B2 进程分离 → B3 桥 → B4 协议 → … → B16 手册与 g1） | 评审 B §2/§3 | `agent:review-p1-plan`（B7 复核接受） | `progress-checklist` 推进顺序；写冲突面单批持有 |
| D-008 | 2026-09-12 | 每模块独立演进的边界与 10 条宿主强制不变量（H1..H10）采信评审 C；P1 只交付"可演进骨架"（清单 8 条），canary/自动晋升留 P2 | 评审 C §1/§2/§5 | `agent:review-evolution`（B7 复核接受） | ADR-0014 的 P1 交付清单；后续 T-305 自进化前置 |

## 待人工裁决（不得由 agent 决定）

- V 项正式结论与 G0/G1 签署（`docs/work/validation/register.json`）。
- D-005 的假设若被真实结论推翻，受影响功能需重新定范围（记录为新决策行，不回改历史行）。
| D-009 | 桥的帧名（`method`/`result`/`error`/`bridge.credit`/`bridge.ready`）在 ADR-0013 之上由 `13-cordis-bridge.md` §2 定稿（ADR 只固定了传输与握手） | ADR-0013 §1 只定"一行一帧"；实现需要具体帧名，定稿落在设计层文档，便于升级时逐条比对 | agent:arch | 改帧名需同步宿主与 AC |
| D-010 | `fact` 面未开放时的错误码复用 `commit-refused`，由 `next_action` 与 `data.cls` 区分（fact→需放宽 ADR；commit→只走交互式 CLI） | 错误码表在 ADR-0013 §4 是**固定**的，新增码需改 ADR；两处语义都是"该面不可用" | agent:arch | 若新增 `surface-closed` 码，需先改 ADR 与两条 AC |
| D-011 | 重启后的锚点语义 = 宿主观测到的 `(seq, head)`：账本**落后**（seq 更小）、同 seq 的 `entry_hash` 不同、锚点不在链中、或链路校验失败 → 落 `kernel/bridge-fault` 并降只读；账本**超前**不算 fault（宿主只是没看到尾巴，用 `ledger.read` 补齐） | 若把"超前"也当异常，正常崩溃重启会被误判为回滚，导致不必要的只读降级 | agent:arch | 语义若变，AC-INTEG-006 的锚点断言与 ADR-0013 §6 需同改 |
| D-012 | 回执（`relay/receipt`）是**传输确认**而非业务事实：由接收方在应用成功后签名回发，发送方据此清账；`relay/receipt` 与 `relay/resend-request` 属**控制类**，不互相回执、不计入待回执 | 若回执也回执回执，双方会陷入无界乒乓（实测第一版就是这样）；把回执当业务事实又会污染事实账本 | agent:arch | 若引入批量回执或聚合 ack，需同步改 `03` §5 与 AC-QEP-003 |
| D-013 | 新增 `tools/check-ac-registry.py`（入口 `tools/verify.sh ac-registry`）：**phase 恰为 P0 的文档 AC 必须已有注册断言**，未到期（P1/P2/P0-P1）只报告不失败；反向捕获"注册了但文档没有"的孤儿 AC | 实测发现 `AC-CLARIFY-001` 在 `acceptance-criteria.md` 里标着 P0 却从未有断言（文档门只查文档，查不出这种漂移） | agent:arch | 若某 P0 AC 需要延后，须改文档 phase 或在 checklist 里写明理由 |
| D-014 | 事件派发统一走 `EventBus.dispatch()`（按事件的 `@mode` 选分发器）；服务不得自行 `emit(bail 事件)` | 实测暴露：`compare` 用 emit 派发 bail 模式的 `rfq/version-mismatch`，一旦挂上事件总线就抛 `EventModeError` —— 而 AC-COMPARE-001 当时没挂总线，所以漏了；修法把「按模式派发」下沉到总线并**同时给 AC-COMPARE-001/AC-EVT-001 补断言**（覆盖漏洞与 bug 一起修） | agent:arch | 新增服务写事件前先查 `05-events.md` 的 @mode；AC 里凡涉及事件派发的路径都要挂总线 |

## D-015 — 文档声明的事件名与事件表不一致时，以「名称+模式双向一致」为硬要求（2026-09-21）

- 背景：`05-events.md` 写 `award/confirm-requested`，`kernel/events.py` 写 `award/commit-requested`；文档用通配 `evolve/*` 声明族而事件表登记具体名。两侧各自"看起来对"，任何一方照着自己写都不会报错。
- 裁决：**声明即登记、登记即声明**——文档声明的事件必须在事件表存在（同名同模式），事件表登记的事件必须在文档声明；后续阶段的事件在文档说明列标「规划中」由机检放行（阶段到位必须登记，且登记后模式仍须一致）。
- 落地：`tools/check-events.py` + `verify.sh events`，含双向负控（改任一侧都变红）。
- 理由：这类漂移没有运行时症状，只有"有人按文档写代码"时才暴露；机检是唯一可靠的拦截点。

## D-016 — 比较表导出以 CSV 交付，`.xlsx` 不在 P1（2026-09-21）

- 背景：roadmap S1.13 写「CSV/Excel」（FR-UX-003 同）。内核/服务层受"仅用标准库"约束，手写 xlsx（zip + OOXML）属于重复造轮子，引入 `openpyxl` 又会打破零依赖约束。
- 裁决：P1 交付 **CSV**（stdlib `csv`，带 UTF-8 BOM 使 Excel 双击不乱码，列头稳定）；`.xlsx` 若确需，由**宿主层**（Node/cordis 侧，可正常用第三方库）承接，不在内核。
- 后果：FR-UX-003 的"Excel"按"Excel 可直接打开的 CSV"满足；需求方若要原生 xlsx，走宿主层或另开 ADR。

## D-017 — RFQ 包体不进账本：跨进程靠"侧内操作日志"重放（2026-09-21）

- 背景：`rfq/published` / `rfq/amended` 事件只带**哈希、条目数、截止时间**，不含包体；`RfqService` 的已发布快照只在内存里。于是"重启/换进程后从账本重放本 realm 状态"（`06` §7）对 RFQ 并不成立——跨阶段的两个真进程走查第一次跑就在 `amend` 处失败。
- 现状处理：走查里承包商侧把自己做过的 `publish`/`amend` 记在**侧内操作日志**（`tmp/g1-shared/contractor/rfq-ops.json`）里，下一阶段按同一顺序重放（确定性，得到同样的 rev 与快照哈希）。这是**补齐**，不是兜底：日志是侧内产物，账本仍是事实源。
- 记在这里的原因：这是 P1 的一处**已知限制**，必须显式可见；`04 §ctx.rfq` 的"不变量"只保证"已发布字段不可原地改"，不保证"包体可从账本重建"。
- 后续（P2 候选）：把包体做成**内容寻址对象**并让 `rfq/*` 事件携带对象地址（而非只带哈希），这样侧与宿主都能从账本重建；或由宿主层的对象存储承担。改动面：`kernel/ledger.py` 的条目类型、`services/rfq.py`、`03` 的报文表——需要新 ADR。

## D-018 Jev 只做“建议层”，不进判定层（T-223，2026-09-21T08:22:34Z）

- 结论：模型 `Jev`（TypeSafe AI，System One 评估模型）确实存在且接口为“state + 类型化问题 → 类型化答案 +
  置信度”。本项目**可将其用于建议类判定**（澄清分流、异常打标、偏离分级、路由建议、字段预筛），
  **禁止**用于演化门判定、账本事实生成、替代人工门、算术与期限计算。
- 依据：一手来源核验（`docs/work/evidence/EV-060-jev-primary-sources.txt`）与报告
  `docs/analysis/jev-model-research.md`；本仓既有纪律：演化门指标不得为模型自评（`host/lib/evolution.mjs`
  负控）、账本唯一写入者是内核（`ADR-0007`）、人工门前置（`AC-APPROVE-003`）。
- 接入三纪律（若做 `T-224`）：模型可见 ⟺ 账本可见；建议不改变任何既有判定；外部不可达时主流程照常。
- 状态：`accepted`（由独立 agent 调研 + 本 agent 复核得出，非人工批准；用户 2026-09-21 明示批准以调研结论推进）。

## D-019 subagent 交付插件：授权范围与复核纪律（T-226/T-227，2026-09-21T08:26:41Z）

- 授权：用户 2026-09-21 明示"可以用 subagents 制作一些 domain based 插件或者中间件满足一些具体业务逻辑"、
  "允许 subagent 做决策，留下明确的决策记录即可"。据此把两个**新增插件**整文件交给独立 subagent 编写。
- 边界：subagent 只能新建 `host/modules/<name>.mjs` 一个文件；不得改检查器、清单、ADR、门、其它模块；
  不得改文档。父 agent 负责接线、文档、证据与提交。
- 复核（父 agent 实测，非转述）：`tools/verify.sh modules` 73/73（A1..A6，含内建 mixin 负控、零残留、
  确定性、跨模块 import、config 负控）；`tools/verify.sh plugins` 4/4；静态扫描无跨模块 import、
  无文件/网络副作用（唯一命中的 `Date.now` 是注释里"绝不用"的说明）。
- 交付：`host/modules/sourcing.mjs`（领域插件：RFQ 覆盖率/缺口/临期，纯函数只读账本行）、
  `host/modules/timeline.mjs`（中间件：按 realm 的时间线环形缓冲，幂等去重、零残留、无定时器）。
- 复核发现的边界：`sourcing` 只读账本行、不做数值推断；`timeline` 不产生业务事实（事实仍以 Python 账本为准）。

## D-020 自进化产出插件：可写面、门信号与晋升门槛（T-227，2026-09-21T08:39:42Z）

- 决定：自进化可以产出插件（`host/modules/<name>.mjs`），但**只能写这一个目录**；门信号必须是**真跑出来的**
  模块 fixture A1..A6（`expected_effect.metric == 'fixture:module'`），不接受模型自评；晋升仍需人工
  `approval_ref`；提案后被改动过（哈希不符）拒绝晋升；回滚只删自有且内容未被他人改动的那一份。
- 依据：用户 2026-09-21 指令「可以用自进化的方式制作插件或中间件…使每一个功能模块都可分别独立演进」；
  既有纪律：`ADR-0002`（内核不可自改）、评审 C `§5.2/§5.3`、`ADR-0014 §7.1` 第 7 条（不许自动晋升）。
- 落地：`host/lib/evolution.mjs`（`makeModuleProposal`/`shadowArtifact`/`gateModule`/`promoteModule`/`rollbackModule`）
  + `host/evolution.mjs` 冒烟扩展；`check-modules.mjs` 新增 `--module-dir`（影子目录）与**空集合守卫 A0**。
- 修自己引入的三个缺陷：① `--module` 按模块**导出的 name** 过滤，坏产物的 name 没改 → fixture 返回 0/0
  （"空集合"看着像通过）→ 已加 A0 守卫；② fixture 子进程非零退出是**预期负控路径**，改用 `spawnSync` 取 stdout；
  ③ 模块装配抛错时 `catch` 引用 try 内 `const name` → ReferenceError → 改用循环内 `let currentName`。
- 记录：`ADR-0016`；证据 `EV-063`。

## D-021 canary 的方向性：扩大上线面要人批准，缩小上线面不用（T-229，2026-09-21T08:42:42Z）

- 决定：进入 canary 与"从 canary 升全量"**都要**人工 `approval_ref`；退出 canary / 回滚**不要**
  （`decide()` 直接返回 `{action, automatic, approval_required}`，方向性由插件自己解释，调用方不得自行解释）。
- 理由：自动化系统的危险来自"自己给自己扩权"。机器可以自动踩刹车，不能自动踩油门。
- 判定口径：错误率 / 延迟 p95 / 成本均值三条，任一条相对 base 退化超阈值即建议回滚；样本不足不给结论；
  只有 base 退化时不得回滚 canary（见 `ADR-0017`）。
- 顺带修一处会随事件扩张而漂移的实现：`tools/evolve-record.py` 原先**手抄一份** `evolve/*` 白名单，
  新增 canary 事件后事件门绿但该脚本拒收 —— 改为从 `kernel/events.py` 的 `DEFAULT_TABLE` **派生**（单一真源），
  派生失败才退回显式白名单（不静默放宽）。
- 记录：`ADR-0017`；证据 `EV-064`。

## D-022 canary 接线到真实入口：投影独立成插件 + 失败隔离语义（T-230，2026-09-21T08:49:26Z）

- 决定：把"谁看到什么字段"从 `webui` 里抽成**独立插件** `projection`（`provides: ['projection']`），
  `webui` 改为 `inject: ['ledgerView', 'projection']`；宿主用 `host/lib/canary-dispatch.mjs` 把 canary 的
  分桶接到**真实请求路径**（UI 的视角投影）上，每次请求都回灌样本给判定器。
- 失败隔离语义（`host/canary-dispatch.mjs`）：**候选实现抛错 → 回退 base 且如实记 `ok:false`**；
  **base 抛错 → 原样抛出**（不得静默回退掩盖真实故障）。这条由 `canary-route` 门的负控守住。
- 零影响升级：`weight_bps = 0` 时全部走 base，输出与未接线时字节一致（端到端断言）。
- 顺带修两个真问题：① UI 处理一个 `/api/events` 请求**投影了两次**（`count` 与 `events` 各算一遍）→
  一次请求只投影一次（否则 canary 采样翻倍、判定失真）；② **线上服务重启才发现** `cli.mjs` 里 webui 的挂载
  包装 `inject` 没跟着加 `projection` → 服务起不来（`cannot get property "projection" without inject`）。
  后者只在"真的重启服务"时暴露，说明"门全绿"不等于"服务能起"——已作为纪律记入本批次。
- 记录：`ADR-0017 §4`（本决定补上其"已知限制"里那一条）；证据 `EV-065`。

## D-023 canary 的样本来自**真实桥调用**（T-231，2026-09-21T08:52:39Z）

- 决定：把 canary 分桶接到宿主→内核的**真实调用路径**上——新插件 `host/modules/bridge-canary.mjs`
  （`provides: ['canary-dispatch']`）对外提供 `register({base, candidate})` 与 `call(method, params)`；
  `host/cli.mjs bridge` 新增 `--canary-weight <bps>`（默认 **0 = 零影响**）与 `--candidate-module <path>`
  （候选实现，形如晋升产物的入口）。调用结果（成败/回退）回灌给 `canary` 的判定器。
- 为什么单独成插件：`kernel-bridge` 是**声明面**（暴露/拒绝哪些方法），不该知道"上线策略"；
  canary 在多数 profile 里不挂，所以调用面分流器独立装配（各自独立演进）。
- **同形契约**：候选必须与 base 同签名、同返回结构；形不对不会在分流器里被抓住，而是在调用方炸 TypeError
  （实测踩到：候选返回 `{jsonrpc,...}` 而 base 返回桥帧 `{n, p:{id,m,result}}`）。接候选前先用
  `verify.sh bridge-canary` 的夹具验形状。
- 纪律重申：**注册了不等于用上了**——`--method` 路径必须真走分流器（本轮先写了"注册但没走"的假接线，
  实测发现后改为真走）；`--canary-weight 0` 时行为与未接线完全一致。
- 记录：证据 `EV-066`（含真实桥调用下 `lane=canary` 且候选真的服务了这次调用的原始输出）。

## D-024 运行期中间件成插件：准入/背压/超时/有界重试（T-232，2026-09-21T08:55:09Z）

- 决定：把运行期关注点做成**独立插件** `governor`（`provides: ['governor']`），与 `canary` 互补——
  canary 决定"去哪条道"，governor 决定"放不放行、等多久、失败重试几次"。
- 三条纪律（均有负控）：① **拒绝可解释**（`reason` + `retry_after_ms` + `next_action`，不返回裸 false）；
  ② **超时是显式错误**（`code=timeout`，不许静默重试到成功；超时后额度归还，不永久泄漏）；
  ③ **重试有界**（配置超过 `retry_limit` 直接拒绝；业务错误重试用尽后原样抛出）。
- 不写任何东西：不碰账本、不写文件；决策不依赖真实时间（`setClock()` 可注入假时钟 → 判定可复现）。
- 与既有纪律的关系：`kernel-bridge` 的 `credit_window` 是**协议声明**（桥的契约），governor 是**运行期执行**
  （谁在什么时候放行）——两者不重复：前者是"桥承诺的窗口"，后者是"宿主实际的准入"。
- 记录：证据 `EV-067`（9 条断言 + 假时钟确定性）。

## D-025 运行期审计流水**不是**账本（T-233，2026-09-21T08:57:14Z）

- 决定：新增中间件插件 `audit-hook`（`provides: ['audit']`）记录**宿主运行期的决策现场**（关注前缀
  `approval/ award/ po/ change/ evolve/ canary/`；也接受 `source: 'decision'` 的显式记账）。
- **边界写死**：账本是事实（Python 唯一写入者，append-only + 哈希链）；audit 流水是观测（内存环形缓冲、
  进程结束即消失、**不写文件、不写账本**）。任何需要成为事实的东西必须由 Python 侧落账（H1）。
  机检负控：整段运行前后指定账本的**字节与 mtime 不变**。
- 一致性细节：去重键与账本**同形** `(type, correlation_id, body_hash)` —— 同一件事不会记两条；
  有界（容量可配，丢最旧并计数）；realm 白名单外一律不记（观测也不许越界）；dispose 即注销订阅（零残留）。
- 接线：`cli.mjs bridge` 在启用 canary 时把这次决策记进 audit 并随命令输出回读（`audit.slice`）。
- 记录：证据 `EV-068`。

## D-026 未完成的接线：`governor` → UI 真实 HTTP 路径（T-234 现状，2026-09-21T09:07:06Z）

**结论：T-234 未完成，已回退接线（门红不留树）。** 本文记录已核实的事实与剩余问题，供下一步从证据继续。

- 目标：把 `governor` 接进 `webui` 的请求处理（背压 → 429 + `Retry-After`；超时 → 504），使限流/超时在 UI 真实路径上生效。
- 已核实的事实（本轮实测）：
  1. `governor` 插件本身没问题：`verify.sh governor` 9/9；在最小组合（`ledgerView` + `projection` + `governor` + `webui`，
     有 wrapper 与无 wrapper 两种）里 `/api/status` 与 `/contractor/api/events` **都返回 200 且形状正确**。
  2. 接线后 `verify.sh webui` 红，且症状会移动：先 `/api/status`，后 `/contractor/api/events`，
     最终定位到**探针里 `webui#broken` 那个 ctx 没挂 `governor`** → 该 ctx 里 webui 注入不到 → 插件 pending → 拿不到句柄。
     给它补挂载后，`webui` 门从"崩溃"变为可完整运行（**5/12**，即 7 条仍失败，尚未定位）。
- 已定的纪律（本轮教训，继续适用）：**断言失败详情必须安全求值**——`Object.keys(undefined)` 会在断言为假时把
  整个检查脚本崩掉、盖住真因。检查器已按此改（`host/webui.mjs`：`status`/`events` 两处诊断均改为安全访问并打印响应体）。
- 剩余问题（下一步从这里开始，不要再盲改）：
  1. 用改好的检查器跑一次，**打印 7 条失败各自的响应体**（现在能看到 `status=…body=…`），先确认是 429/504/500 还是形状问题；
  2. 若是 429：核对 `key` 是否按请求分桶、成功路径是否 `release`（`run()` 在成功时归还额度）；
  3. 若是 500：看 `handle()` 在 `await governor.run(...)` 包装下的异常路径（包装改变了返回语义，需确认 `handle` 的同步抛错仍被外层 catch 捕获）。
- 影响面：本决定**不改变任何既有行为**（接线已回退）；`governor` 仍只在其自身门内被验证，**尚未在 UI 路径生效**。

### D-026 追加证据（2026-09-21T09:09:04Z）：请求期 ctx 代理报错，下一步的假设已明确

再次接线后跑检查器，**拿到了失败响应的原文**（这正是上一轮补的"安全求值 + 打印响应体"起作用）：
`{"error":"internal-error","detail":"Error: cannot get property \"governor\" without inject"}`，
全部 7 条失败都是**同一原因**（所有路由 500）。

关键矛盾（下一步从这里切入）：`host/modules/webui.mjs` 里 `inject` 声明**确实**已含 `governor`
（第 18/22 行），`const governor = ctx.governor` 也在 `apply` 顶部；但报错发生在**请求期**，
且是 cordis 的 ctx 代理抛的（不是 `undefined.run` 那种 TypeError）。

⇒ 假设一（优先验）：**探针/CLI 用的"包装挂载"把 `apply` 与 fiber 的 inject 解析错开**——
生产路径是 `ctx.plugin(module, config)` 直接挂模块，而检查器与 CLI 走 `apply(inner, cfg)` 的包装。
**下一步：先用"不加包装、直接 `ctx.plugin(webuiModule, config)`"的最小脚本复现**；若直接挂载通过，
则问题在包装模式（需要给包装补 fiber 级 inject），而不是 `governor` 接线本身。
假设二：`ctx` 被闭包跨 epoch 复用（`ledgerOf()` 里的 `ctx.ledgerView` 就是**请求期**读取，且它现在是通的），
说明请求期读取本身可行——差异只在 `governor` 是新加的服务名，需确认包装 ctx 的 inject 列表确实生效。

接线仍**已回退**（门红不留树）；`governor` 只在其自身门内被验证，尚未在 UI 路径生效。

## D-027 T-234 根因与收口：`governor` 的自引用（2026-09-21T09:11:03Z）

**根因（已定位并修复）**：`host/modules/governor.mjs` 的方法内部用 `ctx.governor.admit/release` **自引用**。
当模块以"包装挂载"（探针/CLI 为了抓句柄都用这个模式）被挂时，包装的 ctx 里**没有** `governor` 注入 →
请求期访问该属性会被 cordis 的 ctx 代理拒绝，报 `cannot get property "governor" without inject`（全路由 500）。
修法：**本地句柄自引用**（`const handle = {...}`，方法内用 `handle.admit/release`，最后 `ctx.provide('governor', handle)`），
不再经由 ctx 查自己。修后 `verify.sh webui` **11/11**、`verify.sh governor` **9/9**。

**纪律（本轮三次踩坑的共同形状）**：模块**不要靠 `ctx.<自己>` 取自己**——包装挂载/多实例场景下 ctx 里未必有自己；
一律用本地常量引用。这条适用于所有进树模块。

**已完成**：`governor` 已接进 UI 的真实 HTTP 路径（`webui` 注入 `governor`，请求经 `governor.run` 包装），
`cli.mjs webui` 动作挂载 `governor`（`--capacity`/`--timeout-ms` 可调），线上服务重启后三路由 200。

**未完成（如实登记）**：**429/504 的 HTTP 映射尚未端到端断言**。我在检查器里加过一条"额度耗尽 → 429 + Retry-After"
的断言，但它实测返回 200（未确证原因），按"不确证不写绿"的纪律**撤掉了该断言**，并把本条留在 D-027。
语义层（背压/超时/有界重试）由 `verify.sh governor` 9/9 覆盖；缺的是"UI 路径上的 HTTP 状态码映射"这一层。

### D-027 收口（2026-09-21T09:16:17Z）：`governor` 已在 UI 真实路径生效，三档映射全部有断言

**补充真因（"429 没触发"的原因）**：检查器占额度时用的 key 是 `webui:/api/health`，而**应用侧**的 key 是
`webui:/quotagent/api/health`（`req.url` 带路由前缀）→ 落到**不同的桶**，所以额度没被占住、返回 200。
修法：按 `stats().buckets` 里**实际的桶名**取 key（不硬编码前缀）。

**最终状态（均已实测）**：
- `verify.sh webui` **14/14**：含 ① 背压 **端到端**（额度耗尽 → 429 + `Retry-After`，且归还后恢复 200）；
  ② 错误映射三档（背压→429 / 超时→504 / 其它→500）**单元级**断言（抽成纯函数 `sendGovernorError` 后可直测，不依赖慢请求）。
- `governor` **9/9**、`modules` 144/144、docs/plugins/events 全绿；线上服务重启后三路由 200、公网 200。
- 清单 T-234 → **done**。

## D-028 T-235 未完成：把 canary 自动回滚接到真实命令路径（现状与教训，2026-09-21T09:19:47Z）

**目标**：`cli.mjs bridge` 支持 canary 探针（批量真实调用）→ 退化时**自动回滚**（安全动作免批准）→ 落账 + 审计留痕。

**已实测通过的部分（有价值，暂未入库）**：
1. **进入 canary 的人工门**：`--canary-weight > 0` 而缺 `--canary-approval ap-NNNN` 时**直接拒绝**并给出
   ADR-0017 的理由（实测输出已确认）——"扩大上线面要人批准"在真实命令上成立。
2. **探针采样两侧**：`bridge-canary.call` 支持 `key` 覆盖后，60 次探针得到 base 23 / canary 15（实测），
   说明"单方法探针只落一条道 → 判定永远样本不足"这个坑是真的，修法（按探针索引取键）也有效。

**未完成**：CLI 的自动回滚路径**仍有报错**（连续 4 次都是**声明顺序/TDZ** 类问题：
`canaryDecision`、`candidatePath`、审计块早于声明引用等），最后一处未定位。按"门红不留树"的纪律，
本批次的两处改动**已全部回退**，工作树恢复到此前的绿状态。

**教训（同一形状已出现 5 次，值得固化为纪律）**：在 `cli.mjs` 这种**单个巨大 `main()` 函数**里，
新逻辑必须以「先声明、后用」为铁律——`const/let` 的 TDZ 与"用在声明之前"是本轮反复卡住的原因，
且**只会在真跑时暴露**（`node --check` 是语法检查，抓不到 TDZ）。
下一步：把 CLI 的 canary 段抽成**独立函数**（`runCanaryProbe(...)`），参数显式传入，从结构上消灭这类错误。

## D-029 T-235 分两步走：编排 lib 已完成并测过，CLI 接线待做（2026-09-21T09:21:23Z）

**已完成（入库）**：`host/lib/canary-run.mjs` —— canary 探针与自动回滚的**编排**，参数显式传入、结果显式返回：
`runCanary({canary, dispatch, method, params, probeCount, approval_ref, proposal_id})`
→ `{decision, exited, samples, last_result, last_lane}`。方向性照 `ADR-0017`：
**进 canary 缺人工引用直接拒绝**（`CanaryApprovalRequired`），**退化自动回滚不需要批准**。

机检（`verify.sh bridge-canary` **11/11**，新增 3 条）：
1. 缺 `approval_ref` → 拒绝且**不进入** canary；
2. 40 次探针 → 两侧都有样本（base/canary 均 > 0）→ 退化判定 → **自动回滚**（`automatic=true`、`approval_required=false`）；
3. 候选不退化 → **不回滚**（推荐只是建议，仍停在 canary，不擅自扩大上线面）。

**为什么这样拆**：`cli.mjs` 是一个巨大的 `main()`，本轮在同一处连续踩到 5 类低级错误
（TDZ/声明顺序 ×4、`ctx.<自己>` 作用域 ×1）。把编排抽成 lib 后它可被单测；CLI 侧只剩**三行接线**。

**待做（下一步，已定位到具体细节）**：
1. CLI 的 canary 句柄必须**从插件自己的 ctx 捕获**（`ctx.canary` 从根 ctx 取不到 → `[canary-run] 需要 canary 服务`），
   与 `webui` 的挂载包装同一手法；
2. `bridge` 动作里 `canaryProbe = runCanary({...})`，取 `last_result` 作为本命令的输出帧；
3. `CanaryApprovalRequired` → `emit(..., 2)`；
4. 回滚时把 `evolve/canary-exited` 交 `tools/evolve-record.py` 落账 + 往 audit 流水记一条 `decision`。

## D-030 T-235 完成：canary 探针 + 退化自动回滚已接真实命令路径（2026-09-21T09:24:23Z）

**命令**：`node host/cli.mjs bridge --profile <p> --method <m> [--params ...] --canary-weight <bps>
--canary-approval ap-NNNN --canary-probe <N> [--candidate-module <path>]`

**实测（EV-070）**：
1. `--canary-weight 5000` 但缺 `--canary-approval` → **exit 2**，理由指向 ADR-0017，且**没有进入** canary；
2. `--canary-approval ap-0099 --canary-probe 40 --candidate-module tmp/cand-flaky.mjs`（候选在偶数探针抛错）→
   `lane=canary`、11 次回退、判定 **rollback**（错误率 0 → 5000 bp）→ **自动退出 canary**
   （`automatic=true`、`approval_required=false`）→ 账本新增 `evolve/canary-exited`（`automatic=true`，seq 9）。

**这条纪律的方向性**（写死）：**扩大上线面（进入 canary）必须有人工引用；缩小上线面（回滚）自动执行、免批准**。

**两个真根因（都会让"看起来接好了"的功能其实没接）**：
1. **`ctx.<自己>` 与块作用域**：canary 句柄必须从**插件自己的 ctx** 捕获（根 ctx 看不到插件提供的服务）；
   编排 lib 的导入必须放在**函数作用域**——放进 `if` 块会让 `catch` 报 `CanaryApprovalRequired is not defined`。
   → 同类错误（TDZ/作用域）在本轮同一处共出现 **6 次**，`node --check` 全部抓不到。
2. **探针的分桶键**：`bridge-canary.call` 的键是稳定的 `${name}:${method}`，**40 次探针会全部落同一条道**
   → 判定永远"样本不足"，看着像"canary 没生效"。→ 新增 `opts.key` 覆盖（探针用 `probe:<method>:<i>`），
   生产路径不传 `opts`，键仍稳定。**"探针必须能同时采样两侧"是这条功能能成立的前提。**

## D-031 T-236：运行期观测独立成插件，并从 WebUI 双方视角暴露（2026-09-21T09:28:09Z）

**形态**：新插件 `host/modules/observability.mjs`（`provides: ['observability']`，`inject: ['governor','audit','canary']`）
把三个**运行期**中间件的状态聚成一个**只读**快照：`governor`（准入/超时/完成/失败）、`audit`（留痕统计）、
`canary`（阶段 + 两侧样本）。暴露路径：`/quotagent/api/obs`（双方视角都可见）。

**四条纪律（都写进机检，不是注释里的口号）**：
1. **观测不是第二本账**：不写账本（H1）、不写文件、不订阅事件、不注册定时器（静态扫描 + 重挂载干净）；
2. **无副作用**：反复取快照/摘要**不改变**任何来源的统计；
3. **确定性**：同一状态下两次快照**字节一致**（不使用墙钟/随机）；
4. **不成为侧信道**：快照里没有条目正文、没有私域键名（"私域键名泄漏到对方视角"这个坑本项目踩过，B20/B21）。

**装配点**：`webui` profile（`host/profiles.mjs`）与 CLI 的 `webui` 动作；CLI 里 `audit-hook`（容量 200）与
`canary`（**权重 0 = 零影响**）也一并挂上，因为观测要读它们。

**本轮踩到并固化的两个坑**（都属于"包装挂载"的家族，和 D-027 同源）：
1. 包装挂载里写 `inject: []` 会让模块**取不到自己的依赖**（报 `cannot get property "..." without inject`）——
   包装必须**照抄模块声明的 inject**；合成模块对象（`{apply, Config}`）还必须显式带上 `inject` 字段，
   否则 `mod.inject` 是 `undefined`，静默退回 `[]`（**这个静默退化最危险：代码看着对，插件永远 pending**）。
2. `inject` 里声明了依赖，**fixture 就必须能给 stub**（`host/check-modules.mjs` 的 STUBS 表）——
   否则 `verify.sh modules` 直接红。新增依赖 = 同步补两处（stub 表 + 装配点）。

## D-032 T-237：自进化流程真实产出第一个进树插件（price-history）（2026-09-21T09:33:36Z）

**这不是"机制演示"，是机制第一次被真正使用**：B24（`b4fec9a`）交付了"产出插件产物"的能力与负控，
但此前**从没有**任何进树插件是由这条路径产出的——机制没被用过本身就是缺口。

**流程（全部复用既有机制，不另起一套）**：
提案（必填字段 + 可写面 + 效果口径固定 `fixture:module` + 必须带账本引用）→ 影子写入（真实目录零改动）
→ **真跑 fixture A1..A6**（子进程 `check-modules.mjs --module-dir 影子`，13/13）→ 五项门
（fixture / INV / s1..s4 场景集 / 预算 / 人工介入率不上升）→ 带 `approval_ref` + 影子哈希一致 → 晋升。
四个 `evolve/*` 事件由 **Python 侧**写账本（H1）。

**门真的拦下过一次**（这就是它有价值的地方）：首次干跑 `verdict=rejected`，唯一失败项是"反例集"，
真因是 `verify.sh suite` **需要场景名**、空跑必然非 0 —— 修正为 **s1..s4 四个场景全绿**才算过。

**产出物**：`host/modules/price-history.mjs`（只读领域插件：按供应商的价格序列描述统计 + 离散趋势，
纯函数、无 I/O、无事件、无人工门、确定性）。已登记进插件清单并挂到 `webui` profile。

**追溯链（新增门）**：`tools/check-evolved-module.py` + `verify.sh evolve-module`（6/6）——
被追踪的 `docs/work/evolution-log.json` 里每条产出记录的 `artifact_hash` 必须与**当前进树文件**的
sha256 一致；文件被偷改或产出被删 → 门红。**自进化能写入的目录，必须有一条可机检的追溯链。**

**驱动器的位置纪律**：`tools/evolve-module.mjs`（独立脚本）而不是塞进 `cli.mjs` 的巨型 `main()`——
T-235 的教训（同一处 6 次声明顺序/作用域错误）说明"新逻辑进 CLI 主函数"是这个项目的高风险动作。
