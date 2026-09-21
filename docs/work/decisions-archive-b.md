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

