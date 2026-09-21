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
