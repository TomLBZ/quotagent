# 决策归档 B（较早的一批；正文未改，为控制单文件预算而拆分 —— 见 `12-documentation-standard.md` §1）

## D-015 — 文档声明的事件名与事件表不一致时，以「名称+模式双向一致」为硬要求（2026-09-21）

- 背景：`05-events.md` 写 `award/confirm-requested`，`kernel/events.py` 写 `award/commit-requested`；文档用通配 `evolve/*` 声明族而事件表登记具体名。两侧各自"看起来对"，任何一方照着自己写都不会报错。
- 裁决：**声明即登记、登记即声明**——文档声明的事件必须在事件表存在（同名同模式），事件表登记的事件必须在文档声明；后续阶段的事件在文档说明列标「规划中」由机检放行（阶段到位必须登记，且登记后模式仍须一致）。
- 落地：`tools/check-events.py` + `verify.sh events`，含双向负控（改任一侧都变红）。
- 理由：这类漂移没有运行时症状，只有"有人按文档写代码"时才暴露；机检是唯一可靠的拦截点。


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

## D-045 T-250：两件 subagent 产出上线（待批摘要 → 双方视角；预算守卫 → 桥路径）（2026-09-21T10:37:56Z）

**产出与核验**：`approval-digest`（人工门**待批摘要**）与 `budget-guard`（**窗口成本预算准入**）由两个 subagent
并行生产（只许写 `tmp/` 产物与 `host/<门>.mjs`）；父侧自己跑语法/纪律扫描/**两套门 10+10**/**官方 fixture 13+13**
（D-019：subagent 自述不算事实）后才晋升（`ap-0107`/`ap-0108`）。两件都附**变异测试自证**（各 4 处变异全红）。

**接线与硬证据**：
· `budget-guard` → 桥调用路径，顺序写死 **idem 判重 → budget 计费 → breaker 准入 → 真调用**。
  `verify.sh budget-route` 5/5：预算 2 / 每次 1 / 4 个请求 → 后两次被拒，**且只有 2 个请求打到下游**
  （`breaker.allowed = 2`）—— 这是"被拒的请求没有浪费下游"的可机检证据。
  拒绝理由区分 **`budget-exceeded`（等窗口有用）** 与 **`cost-exceeds-budget`（等也没用）**：
  **拒绝要能指导下一步动作**，不是裸 `false`。
· `approval-digest` → 双方视角 `/quotagent/<view>/api/approvals` + 页面"待批事项（人工门）"区块。
  待批状态由账本行的**最后一条** `approval/*` 事件推导（granted/aborted 即不再待批），纯只读；
  只输出计数与时长，**不出正文**（机检断言）。人工门是 P8 的核心纪律，此前**宿主侧完全看不到待批队列**。

**四个中间件的分工（写死，互不重叠）**：`governor` 管**并发额度**、`breaker` 管**连续失败切断**、
`idempotency-guard` 管**同一件事是否做过**、`budget-guard` 管**窗口内花了多少钱**。

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

## D-043 T-248：幂等守卫真正上线（桥调用路径）+ 同形契约再次踩坑（2026-09-21T10:22:44Z）

**做了什么**：`idempotency-guard`（subagent 产出、T-247 晋升）接进 `cli.mjs bridge` 的真实调用路径：
调用前 `begin()` 判重（`fresh`/`duplicate-inflight`/`duplicate-done`/`replay`）→ 重复的**不执行**、
给出可解释结论并复用；调用后 `finish({ok, result_digest})` 落完成态。新增 `--idem-probe N`（同请求连发）便于验证。

**硬证据（端到端门 5/5）**：同一请求连发 3 次 → `reused=2`、`last=duplicate-done`，
而**熔断器的 `allowed` 计数 = 1** —— 也就是"**只打了一次下游**"（这是"没有重复执行"的可机检证据，不是自述）。
失败请求连发 2 次 → 第二次判 `replay`（允许重试），**绝不是** `duplicate-done`（失败不得被复用成成功）。

**分工（三个中间件各管一段，不重叠）**：`governor` 管**额度**（放不放行/等多久/重试几次）、
`breaker` 管**连续失败就切断**、`idempotency-guard` 管**同一件事是不是已经做过**。

**本轮又踩了一次"同形契约"（D-023 老坑）**：我自己造的"复用帧"写成 `{n, id, m, result}`，
而桥帧形状是 `{n, p:{id,m,result,error}}` → 调用方读 `call.p.id` 直接 TypeError（实测 exit=3）。
**教训**：只要是自己构造"看起来像下游返回"的对象，**先核对形状契约**，
否则"为了不重复执行而造的替代返回"会变成新的故障源。

### D-043 附：同一条路径上多个中间件的**语义干扰**（门抓到的）

装上幂等层后，`breaker-route` 门立刻变红：它用 `--repeat 6` 表示"6 次独立调用"，
而幂等层把"同方法 + 同参数"认作**同一请求** → 第 2 次起变为复用，`allowed` 从 6 掉到 1。
这不是 bug，而是**语义定义不清**。现在写死：
· `--repeat N` = N 个**不同**请求（params 带 `probe` 索引）；· `--idem-probe N` = **同一**请求 N 次。

**纪律**：当多个中间件串在同一路径上（governor → breaker → idempotency → 调用），
**每个旋钮的语义都要显式定义**，并且**要有门**去读它；否则一个中间件的正确行为会被另一个中间件的门
误判成"回归"，最终导致有人为了"让门变绿"而关掉正确的那个中间件。

<!-- D-074 批次（预算）：以下 4 段自 decisions.md 逐字移入，正文未改 -->

## D-063 版本语义：**同版本不能对应两个产物**；回滚**必须由哈希确认**，否则不记账

1. 内容变了但 `plugin.json` 的 `version` 没递增 → **拒绝**（`version-not-bumped`），而不是默默再记一条
   `upgraded`。理由：否则"回滚到 1.0.0"**指向哪个产物是不确定的**（冒烟第一版就踩了：两条历史都叫 1.0.0）。
2. 登记 `rolled-back` 前必须 `磁盘内容哈希 == 目标版本哈希`。**账本不许记不真的事**：第一版只检查
   "当前内容没被偷改"就记账，于是出现过"账本说已回滚到 1.0.0、磁盘还是 1.1.0"。改成显式分支：
   `rollback-content-not-restored` / `rollback-refused-modified` / `rollback-target-unknown` / `rollback-noop`。
   连带结论：**要还原的是"整个版本目录"**（`plugin.json` + 产物），只回退产物文件不算还原。
**代价/未决**：调用方或宿主必须先完成还原、再登记（两步）；**版本快照由谁保存**未定（登记 T-267b2c）。

## D-064 提权必须"人类 actor + 新鲜证据"；**已存在的模块不许覆盖**

· `--actor` 必须是 `human:<id>`：**agent 不能给自己的产出提权**（否则"人工门"就是装饰）。载荷里有 `ap-NNNN`
  不等于批准，还得由人类发起这一次提权。
· **影子哈希要用"现在"重算的值**：载荷是旧的、或产物被改过 → `shadow-hash-mismatch` 拒绝。理由：晋升是
  不可逆的写树动作，不能用陈旧证据。
· 目标**已存在即拒绝**（`target-exists`），不覆盖树里的模块 —— 覆盖会把"谁改的、从哪来的"变成不可追溯。
· `--promote-dir` 默认 `host/modules`；夹具可指向临时目录以**真跑写入路径**而不污染产品树。
· **演示纪律**：提权演示用**临时账本**。若往真账本写 `userplugin/elevated` 而模块其实没进树，
  那就是往唯一事实源里写假账 —— 宁可只演示到"写进临时目录 + 临时账本"。

## D-066 交付"部分实现"时：只落**已实现且可验证**的那条，其余留在规格里并写清缺什么

运行期插件（T-275）交回后，P3 规格里的 `AGENTRT-001..007` 并不是全都能落表：
· 能落：AC-AGENTRT-006（已落表）（有界 + 显式降级：截断报数、`degraded`+`reason`+`next_action`、空上下文可区分）；
· **不能落**：规格里的 AGENTRT-002（缺"删缓存后项目记忆由账本重建且逐字节一致"）、AGENTRT-007（缺"卸载记忆插件后
  项目记忆仍可重建"）、AGENTRT-001/003/004/005（缺引用重建核对 / `citations` 强制 / 拦截点接线 / 自进化信号源）。
**纪律**：不为了让数字好看把它们标 done；留在 `p3-spec.json` 里（`landed:false`）当待办。
**另**：三件模块在插件清单的接线列**显式写「未接线」**（门允许这条出口）——"宿主侧就绪但还没挂进 profile"是事实，
比假装挂上强；挂 profile 属下一批。

## D-067 投影的**闭集与口径**都要对着真数据核一遍；替换没生效不许报成功

三件事（都在同一小时内被我自己的验证抓出来）：
1. **闭集不能猜**：我第一版把"项目记忆"的事件闭集写成 `rfq/issued`/`approval/decided` 这类**我想当然的名字**，
   而真账本里是 `rfq/published`/`approval/granted`/`award/committed`…… → 投影**恒为空** ✗。
   空投影会让 AC 变成**空转绿灯**（最危险的一种绿）。纪律：写闭集前先 `Counter` 一遍真数据的 `type`。
2. **realm 是前缀不是全等**：真行的 realm 形如 `contractor:con-B`，我用 `== realm` 过滤 → 11 条全被丢掉 ✗。
   改为"相等或以 `<realm>:` 开头"。
3. **替换要断言生效**：我的注册脚本 `s.replace(...)` 没命中（目标串少了行尾注释），却照样打印 `+ 注册` ✗ →
   结果是"看起来加上了、其实没加"。纪律：**每次文本替换后 assert 命中**，否则报错退出（本次已对后续替换这么做）。
**共同点**：都是"我以为"对上"真数据"时的失败 —— 与 D-065（哈希口径）同类。

