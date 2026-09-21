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

## D-033 T-238：自进化产出的插件接进 WebUI 双方视角（2026-09-21T09:38:05Z）

**做了什么**：`price-history`（T-237 由自进化流程产出的插件）现在**真的在用户可见路径上工作**：
· 每条视角页面多一块**价格序列表**（按行项目：次数/最低/中位/最高/最新/趋势）；
· 两个新路由 `/quotagent/contractor/api/history` 与 `/quotagent/supplier/api/history`（**双方视角各自可见**，
  输入只来自本视角已经过投影的公开行）。

**边界与做法**：
1. **不改已晋升产物**：`price-history.mjs` 有哈希追溯（`verify.sh evolve-module`），改它就会红——这是**特性不是障碍**。
   需要的"按行项目分组"通过**装配时配置**（`key_field`）与 **UI 侧展平**（`body.lines[]` → 一行一个价格点）实现；
   分组键在 UI 响应里统一叫 `group`（插件的字段名 `supplier_id` 属实现细节，不外泄命名）。
2. **只喂公开投影**：价格序列输入取自 `projection` 之后的行，私域键在源头就被截掉（机检断言响应里无私域键）。
3. **取不到就不编**：行里没有 `unit_price` 就跳过；一组都没有就显示"暂无可比价格行"，不造数字（P6）。

**新增机检**：`verify.sh webui` 16/16 —— 新断言要求**双方视角**的 `/api/history` 都 200、`source` 指向自进化插件、
响应里不含私域键。`modules` 门同步补 `priceHistory` 的 fixture stub（新增依赖必须同步 stub 表，这是 D-031 记过的规则）。

## D-034 T-239：自进化产出路径可重复 + 补上"同类失败转人工"的真护栏（2026-09-21T09:41:18Z）

**可重复性证明**：用**同一个**驱动脚本（`tools/evolve-module.mjs`，本轮只为护栏改了参数喂入，流程未改）
产出并晋升了第二个插件 `host/modules/evidence-summary.mjs`（账本"证据面"的只读统计：按类型计数、
关联数、带引用行数、时间跨度）。四个 `evolve/*` 事件照旧落账本；产出日志现有两条记录。

**补上的真缺口（重要）**：`makeModuleProposal` 有个 `history` 参数用于"同类连续失败 ≥ 2 → 强制转人工"，
但驱动脚本**从来没喂过它** → 这条护栏**形同虚设**（等于不存在）。现在改为**从账本读**被门拒过的
`evolve/gated` 记录构造 history（H1：host 只读账本，写入仍由 Python 负责）。实测输出
`same_kind_history={total: 1, failed: 1}` —— 护栏活了；再拒一次即 `same-kind-escalated`。
**教训：参数存在 ≠ 机制生效；凡是"护栏"，都必须有一条会被触发的机检。**

**追溯门的两处加固（都是实测出来的）**：
1. 记录里的哈希可能带 `sha256:` 前缀 → 校验器**归一化后比较**（让工具容忍两种写法，而不是让数据迁就工具）；
2. 增加**偷改负控**：向已晋升产物追加一行注释 → `verify.sh evolve-module` **立刻红**（exit=1）；还原后复绿。
   —— 追溯链不是文档里的声明，是会红的断言。

## D-035 T-240：第二个自进化产出也接入 WebUI；固化"新增依赖要同步四处"（2026-09-21T09:43:28Z）

**做了什么**：`evidence-summary`（T-239 由自进化产出的插件）现在在双方视角都可见：
`/quotagent/<view>/api/evidence` + 页面上的"账本证据面"区块（行数 / 类型数 / 关联数 / 带引用行数 / 时间跨度）。
输入只用**公开投影后的行**（type/ts/correlation_id/refs 都在白名单内），**不输出正文**（机检正则断言 `"body":` 不存在）。

**分工写清（避免两个插件被做成重复轮子）**：`observability` 看的是**运行期内存状态**（准入/留痕/分流），
`evidence-summary` 看的是**落盘事实**（账本内容）。两者都在 UI 上，但回答的是不同问题。

**固化：给 `webui` 新增一个依赖，必须同步四处**（本项目已为此付过三次成本，本轮写进 pitfalls）：
1. `host/modules/webui.mjs` 的 `inject` / `usedServices` / 请求期本地句柄（D-027：不按请求查 ctx）；
2. `host/check-modules.mjs` 的 **STUBS 表**（fixture 必须能 stub 模块声明的每个依赖，否则 modules 门直接红）；
3. `host/webui.mjs` 的**两处挂载**（主 probe + brokenCtx）与它们的 `inject` 列表；
4. `host/canary-dispatch.mjs` 的 e2e 挂载（它也要挂 webui，漏一处就红）+ `host/cli.mjs` 的运行期挂载与输出。

## D-036 T-241：自进化产出第一个**中间件**（circuit-breaker），围栏门由人写（2026-09-21T09:47:22Z）

**第三次走同一路径**（驱动脚本未改），产出 `host/modules/circuit-breaker.mjs`：运行期熔断。
此前两个产出都是**领域插件**；本轮覆盖用户要求里的另一半——"**插件或中间件**"。

**职责边界写死（防止三个中间件重叠）**：
· `governor` = 按**额度**限流 / 显式超时 / 有界重试（放不放行、等多久、重试几次）；
· `canary` = 请求**去哪条道**（base/候选）+ 退化判定；
· `breaker` = 按**失败**切断（连续失败达阈值 → 快速失败；冷却后半开试探，试探失败**立刻重开**）。

**纪律**：冷却用**注入时钟**判断、**不注册定时器**（零残留机检）；判定与真实时间无关（假时钟下同序列
两次字节一致）；拒绝永远可解释（`reason` + `retry_after_ms` + `next_action`），不返回裸 false。

**门的所有权（重要）**：产物由自进化写入（可写面仅 `host/modules/`，ADR-0016），但
**围栏门 `host/breaker.mjs` 由宿主侧人工维护** —— **门不能由被围的对象自己写**，
否则"自进化"会退化成"自己给自己发合格证"。`verify.sh breaker` 10/10（含 4 条负控）。

**本轮自身过失（写进记录）**：落档脚本因门输出 JSON **缺 `passed` 键**而崩，导致 EV/D 未随代码一起提交，
而提交信息却声称已落档 → 已补齐并统一门输出形状。教训：**提交信息必须与实际内容一致**。

## D-037 T-242：自进化产出的中间件真正上线（熔断接进调用路径）（2026-09-21T09:49:33Z）

**做了什么**：`circuit-breaker`（T-241 自进化产出）现在接在 `cli.mjs bridge` 的**真实调用路径**上：
调用前 `allow()` → 调用 → `record({ok})`；打开期间**快速失败、不打下游**；拒绝可解释
（`reason=circuit-open` + `retry_after_ms` + `next_action`）；统计如实（`allowed + refused == 调用次数`）。
新增 `--repeat N`（同进程内连续调用才能累积失败）与 `--breaker-threshold/--breaker-cooldown-ms`。

**顺序写死**：**熔断判定 → 准入（governor）→ 调用**。理由：熔断是"下游已经不可信"的判据，
先判它才不会白白占用准入额度，也才不会把请求送进正在崩的下游。

**门分两层（都要）**：
· 单元门 `verify.sh breaker`（10/10）：证明**逻辑**对（阈值/半开/重开/有界/确定性/零残留）；
· 端到端门 `verify.sh breaker-route`（4/4）：证明**真的接在路径上**（T-231 抓到过"注册了但没接线"的假接线，
  所以"接没接上"必须用真命令验，不能靠代码审读）。

**本轮自身过失（如实记录）**：接线**同一处连踩三次**——① 挂载块被放进 canary 的条件分支（无 canary 参数时不执行
→ 句柄 null）；② 移出后引用了分支里才创建的 `ctx`（ReferenceError）；③ 改为**熔断器自己的 ctx** 才通。
**教训：中间件的挂载必须无条件、并用独立 ctx**，不要借用其它分支的上下文（与 D-029「把编排抽成 lib」同源：
巨型 `main()` 里的作用域问题只有真跑才暴露）。

## D-038 T-243：第四个自进化产出 —— 运维视角插件（第三个视角）（2026-09-21T09:51:37Z）

**为什么需要第三个视角**：项目已有两个**业务视角**（contractor / supplier，各自只见自己的账本与投影）。
运维关心的是另一个问题——"系统现在健康吗？谁在拦流量？账本证据面如何？"这类视图**不属于任何一方**：
混进业务视角会污染对方可见面，也会让运维信息被业务视角的权限写法绑住。→ 单独成插件（`ops-view`）。

**只组合、不自算**（机检断言）：运维快照里的 `runtime.governor` 与来源 `observability` 的统计**逐字段相等**，
不许自己另立口径；输入即事实（`rows` 由调用方给，给 0 行就报 0，不去别处捞数据）。

**纪律照旧**：只读（不写账本/文件）、不订阅事件、不注册定时器、不用墙钟（两次快照字节一致）、
**不输出条目正文与私域键**——运维视角也是视角，同样受投影纪律约束（这条被机检钉住）。

**自进化现状**：产出日志 4 条（`price-history` / `evidence-summary` / `circuit-breaker` / `ops-view`），
其中 2 个领域插件、1 个中间件（已接真实调用路径）、1 个视角插件（下一步挂路由）。
四次都走**同一个**驱动脚本与门槛，围栏门各自人工维护（D-036 的所有权纪律）。

## D-039 T-244：第三条视角道（运维）上线；"不同 routes → 不同视角 UI"齐备（2026-09-21T09:54:04Z）

**三条道**（都由插件提供）：
· `/quotagent/contractor/`、`/quotagent/supplier/` —— 业务双方，**各读自己的账本**（结构性隔离 + 投影白名单）；
· `/quotagent/ops/`（+ `/quotagent/api/ops`）—— 运维，**不属于任何一方**：运行期中间件状态 + **各视角**证据面聚合。

**关键做法（避免"运维视角变成越权视角"）**：
1. 运维页**不显示**条目正文与私域键（机检正则断言 `"body":` 不存在、无私域键名）；
2. 证据面按**视角分别聚合**（`evidence_by_view.contractor/supplier`），不做"合并成一个总数"的偷懒写法——
   合并会掩盖"某一侧账本异常"这类运维最需要看到的事实；
3. `ops-view` 只做组合（D-038），webui 只做路由与渲染，职责不混淆。

**落地清单照 D-035 走，一次通过**：新增依赖（`opsView` + 它依赖的 `breaker`）在四处同步——
模块自身、modules 门的 STUBS 表、门（webui.mjs）的两处挂载、canary e2e 与 CLI 运行期挂载；
另加插件清单与 `webui` profile 装配点。**这份清单是被三次成本换来的，本轮第一次做到"一次过"**。

## D-040 T-245：第五个自进化产出（evolve-journal）——把"自进化流水"接进运维视角（2026-09-21T09:57:10Z）

**做了什么**：`evolve-journal`（自进化产出）归纳**自进化账本**（`evolve/*` 事件）：提案/影子/门两态
（passed·rejected）/晋升/回滚/canary 进·出/最近事件。运维页新增"自进化流水"区块，`/api/ops` 新增 `evolve_journal` 段。

**为什么重要**：canary 的决策与自动回滚是本项目**最重要的安全机制**，但在此之前只能在命令输出里看到。
现在运维能直接回答："最近有没有东西被门拦下？有没有自动回滚过？"——机制不再"只存在于日志里"。

**边界（机检钉住）**：只给**计数**，绝不输出条目正文（喂进 `cost_floor` 与敏感正文，断言响应里都不出现）；
有界（`recent_limit` 超上界被夹住，摘要不得退化成全量转储）；未知事件类型**如实登记**且不崩
（事件表会演进，归纳器不能被它绊倒）；确定性（不解析时间、不用墙钟，两次字节一致）；
零残留（不订阅事件、不注册定时器、**不读写文件**——只吃调用方给的行）。

**这一轮的接线再次一次通过**（D-035 的四处清单 + 一处新学的：**门里要有真数据**——
本轮给门喂了临时自进化账本，否则断言只能验"形状对"，验不出"真的接上了"）。

## D-041 T-246：把"新增依赖要同步四处"的人肉清单变成机检（verify.sh wiring）（2026-09-21T09:58:53Z）

**问题**：给 `webui` 新增一个依赖，历史上要手工同步四处（D-035 / pitfalls-runtime）。本项目为此**付过三次成本**，
而且这份清单只要留在记忆里，早晚会漏——尤其当插件由**自进化**产出时，接线更容易被忽略。

**做法**：新增 `tools/check-module-wiring.py` + `verify.sh wiring`（5/5），机检四件事：
A. 任何模块 `inject` 的服务，STUBS 表里都有 stub；B1/B2. `webui` 的每个依赖在门与 e2e 里都有挂载；
C. 在 CLI 的 webui 动作里都有提供者；D. **反向**：STUBS 里不许有"没人 inject"的孤儿。

**第一次运行就抓到真问题**：`bridge` 与 `compare` 是**孤儿 stub**（没有任何模块 inject 它们）——
典型的"历史残留让人以为在用"。已清除，复跑全绿。

**为什么这比"再写一遍清单"重要**：清单是**给人看**的（会过期、会被忽略），门是**会红**的。
本项目的既有教训都指向同一句话——**参数/文档/清单存在 ≠ 机制生效；必须有会被触发的机检**（D-034 同源）。

## D-042 T-247：让 subagents 生产插件（2 件）+ 抓到 process.exit() 截断 stdout 的真 bug（2026-09-21T10:19:10Z）

**用户指令**："批准使用subsgents讨论、执行代替人工执行"、"可以用subagents制作…插件或者中间件"。
此前 5 个自进化产物都是主 agent 手写；本轮派 **2 个 subagent 并行**各产出一件（领域 + 中间件），
授权范围写死为"只写 `tmp/<产物>.mjs` 与 `host/<门>.mjs`"，**不得动仓库其它文件**。

**复核纪律（D-019）**：subagent 自述**不算事实**。父侧自己跑了三件：语法检查、纪律静态扫描、
**两个门与官方 fixture（影子目录）**——全绿后才进入晋升。晋升仍走同一条流程（ap-0105 / ap-0106）。
两个 subagent 自己写的围栏门也一并纳入 `verify.sh`（**门的所有权**：谁写不重要，"必须存在且会红"才重要，
本轮两个门都做了变异测试自证非橡皮图章）。

**抓到的真 bug（基础设施级，值得记）**：`host/check-modules.mjs` 末尾用 `process.exit()`；
报告涨到 54 KB 后 **stdout 未刷完即被截断** → 包装器拿到坏 JSON（`Unterminated string`）→ `modules` 门红。
**修法**：`process.exitCode = …`（让 Node 自己刷完再退出）。教训：**大输出 + `process.exit()` = 输出截断**；
凡是"门红但看着数据没问题"的情况，先怀疑**输出/管道**这一层。

**接线状态如实区分**：`supplier-scorecard` **已接线**（WebUI 双方视角 + 门内真数据断言）；
`idempotency-guard` **未接线**，在插件清单里**显式标注**并从 webui 角色装配列表移除 ——
宁可明说未接线，也不假装它已经在用（这正是本项目 `plugins` 门存在的意义）。

### D-042 附：同一轮修掉的第二个真缺陷 —— AC 的"只在某个钟点前才成立"（时间耦合）

`AC-APPROVE-003` 把超时扫描时刻**硬编码**在 `2026-09-21T10:02:00Z`，而被批项的 `requested_at` 取真实时钟。
于是它**只在真实时间早于该时刻时才可能通过**：本会话早些时候 `g1 = 57/57`，过了 10:02Z 就必然 56/57。
修法是把扫描时刻改为**相对该项 requested_at 推算**，**断言数量/内容/强度一字未改**。

**纪律**（与本项目既有教训同源）：**AC 断言里不得出现"相对当下的绝对时刻"**——
要么注入假时钟，要么以数据自身的时刻为基准推算。否则门会随墙上时间自己变红/变绿，
而"门自己会漂"比"门红"更危险（会让人怀疑门、进而绕过门）。

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
