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

> 较早的小节（D-042…D-054）已按预算机制整段逐字搬进 `docs/work/decisions-archive-c.md`（本批 `EV-181`）。

## D-065 跨语言"同一份哈希"必须**写死同一个口径**，并保留对旧口径的识别

宿主 `scan()` 的产物哈希 = **清单里 `artifact` 指向的那个文件**（这里即 `index.mjs`）的 sha256；
Python 侧我第一版用 `sha256(index.mjs + plugin.json)` 拼接 —— 于是线上提权时"影子哈希一致"永远不成立，
Python 侧如实拒绝（`shadow-hash-mismatch`）。**拒绝是对的**（宁可不晋升，也不凭不一致的证据晋升）。
修法：
· Python 侧 `artifact_hash()` 改为与宿主**逐字节同构**（同一文件、同一编码、同一 `sha256:` 前缀）；
· 同时保留 `legacy_artifact_hash()`（旧拼接口径）**只用于识别历史记录** —— 否则"口径改了"会被误判成
  "内容变了"，从而往账本里写一条假的 `upgraded`；
· 夹具（AC-USERPLUG-010）的哈希也随之对齐，避免"测试自己就是不同口径的样本"。
**代价**：口径变更需要一次兼容读取（已实现），且**两侧都必须改**；以后新增哈希字段先问"谁算的、算哪些字节"。

## D-068 存储：**隔离是路径强制的**，调用者身份不在这一层；写检查前先量真行为

1. **"跨租户"要先定义清楚**：我第一版断言"用 `ns=beta` 写 beta 的根必须被拒" ✗ —— 那本来就是 beta 自己的地盘，
   允许才对。真正要拒的是**越权形态**：`ns=../beta`、`ns=beta/../alpha`、`ns=alpha & rel=../beta/x`
   （实测都返回 `storage-outside-ns` ✓，且磁盘上没有残留 ✓）。
2. **`--ns` 是调用方自称**：`tools/storage.py` **不做调用者身份校验**。真正的身份约束在宿主/用户空间内核层
   （`credentialScope` / `assertWriteSurface`）—— 登记为本层**已知边界**，不当成"已解决"。
3. **先量真行为再写断言的又一条**：`open-append --text` 不接受带换行的文本（工具自己补行）；
   键值表落在 `<root>/<ns>/db/<table>.jsonl`。我第一版凭想象写路径 → `FileNotFoundError` ✗（同 D-067）。

## D-069 落表前先核 ID 家族的**语法**：门的正则是 `[A-Z]+-\d{3}`，带数字的家族会静默落空

三份 UX 规格里用的草稿编号是 草稿编号（`UX2` 家族）（`UX2` 带数字）。我照抄落表后：
· `tools/check-ac-registry.py` 的行正则 `^\|\s*(AC-[A-Z]+-\d{3})\s*\|` **匹配不上**（该家族的编号）
  → 门报「注册表里有、文档里没有」（我第一反应是"行格式写错了"，其实**是 ID 语法**）；
· `coverage` 门同样报「伪造 2 条 FR」。
**做法**：草稿编号落地时**转成纯字母家族**（本次家族名 UX2 → UXWEB，落表为 UXWEB 家族的 001/002 与 001），
并在索引里写明这条转写规则；**不许改门的正则去迁就草稿**（那等于放宽门）。
**更一般**：门是用正则解析文档的 —— 新家族的 ID、新表格、新字段，**先看门怎么解析再落笔**（与 D-067/D-068 同类）。

## D-070 宿主"零写面"的**准确边界**：不得写账本/产品树；可以写自己的 0600 待处理项

写 AC 时我第一版断言"宿主侧一次写文件都不许" ✗ —— 但那与**既有已接受**的做法冲突：管理面（admin 提交、
用户空间插件提需求/提权、配置保存）一律是"宿主落一个 **0600 待处理项**，由 Python 侧消费"。
**准确的不变量**是三条，全部可机检：
1. 宿主写入必须带 `mode: 0o600`（文件）与 `0o700`（目录）；
2. 宿主**不得**写账本（H1）；
3. 产品树（`host/modules/**`、`docs/**`、`user-space/**`）只有 Python 侧的落盘者能改。
**另一处**：我把落盘者的"回滚"写成字符串 `rollback`、"0600" 写成 `mode=0o600` ✗ —— 实际是 `os.replace(bak, file)`
还原与 `chmod`。**又一条同源教训**：断言里的关键字符串要**从真源码里量**，不要凭印象写（D-067/D-068/D-069 同类）。

## D-071 判据不得覆盖**无关写入者**：围栏门只断言"本用例触及的目标"，另留全局层 + 计数

两条"门偶尔红"同类教训：**判据范围大于"本用例的影响面"就会把别人算成自己**。
1. `storage` 门第 8 条原本断言"整个事实区清单/账本字节不变"✗ —— 但运行中 webui（启动参数就是那两份 ledger）
   与定时任务随时写 `tmp/ui-shared/**`、`user-space/**`。**做法**：白名单 = 本用例触及的目标，账本类退化为
   **只增不改**（本工具的写必带哨兵，哨兵规则兜底），前提写进断言名与 detail；**另留一条全局层断言**：
   白名单内必须原样，白名单外变化**不判红但如实计数并打印**；判据自带 8 组合成样本非空转自证 + 负控。
2. `p0-no-node` 用 `>/dev/null 2>&1` 丢掉子进程输出 ✗ —— 红了也查不出。**做法**：输出落
   `tmp/p0-no-node.<mktemp>/`、失败原样回显 + 给路径、**连续两次红才算真红**（首红次绿只警示）。
   **丢掉证据比判红更贵**。真因（量出来的）：文档门 `md_files()` 扫全仓 `.md`（含 `tmp/**`，267 个里 166 个
   在 tmp/），别的门做整树副本时 `read_text` 抛 `FileNotFoundError` → 文档门红 → 内嵌跑它的 AC 红。
   **未改文档门**（它把"tmp 副本也算扫描范围"当设计前提用），残留风险如实记入 EV-151 §三。
   第 2 批（本批）**已落地**：文档门扫描范围收窄为"契约文档集合"+ 契约文档消失仍判红 —— 见 D-072 与 EV-152。

## D-072 门的判据按"契约文档集合"定义：临时副本不进判据，契约文档读不到仍判红

D-071 第 3 条（判据不得覆盖无关写入者）在**文档门**上的落地。旧 `md_files()` = `ROOT.rglob("*.md")`
（只排 `.git`），把 `tmp/**` 的 166/267 个 .md 也算判据；而 `qa ac AC-RUNTIME-001`（整树副本到
`tmp/ac/<rand>/clean/`）与 `clean-copy`（`tmp/clean-copy/`）就在扫描窗口里创建/删除这些文件。
**量出来的**（EV-151 §三 + EV-152 §二）：同条件 12 次 `verify.sh docs`，旧门在 `tmp/**` .md churn 下
**11/12 红**（churn 更快时 **12/12 红**）；新门 **12/12 绿**，12 次里"契约文档 98 个"恒定、被排除的临时
.md 数在 170~178 间跳动（churn 真在窗口内）。崩溃帧明细见 EV-152 §二。
**选 (a) 收窄扫描范围**（不选"读不到就跳过"），三条理由：
1. 临时副本**不是契约文档** —— AC-RUNTIME-001 的"干净副本"口径（`checks_runtime.py` 的 IGNORE_DIRS）
   本来就排除 `tmp/.venv/node_modules/__pycache__`；把副本算进判据 = 判据范围大于本用例的影响面。
2. "读不到就跳过"让门**依赖别人的写入节律**，还把"临时副本消失"与"真契约文档被删"混为一谈 ——
   后者必须红，跳过等于把缺陷当通过（放宽）。
3. 跳过治不了半拷文件：副本写到一半读到**截断内容**（引用数/预算偏小），那是更隐的假绿。
**边界（不放宽）**：契约文档在读窗口里消失**仍然判红**，只把裸 traceback 换成指名道姓的失败
（`read_md` → `[FAIL] 契约文档在扫描窗口里消失（不跳过，判红）: <path>`，退出码仍 1）。实测：仪表化
拉长读窗口后删 `docs/work/roadmap.md` → exit 1 且失败行指名该文件（同跑法不删 → exit 0）。
**断言语义同步收紧为更精确的口径**：`AC-RUNTIME-001` 那条从"跑完后门扫描范围不变"（=全仓 .md 267）
改为"跑完后门扫描的**契约文档集合**不变"，并新增"门自报扫描数 == AC 独立测得的契约文档数"与
"集合仍含门的全部定义文件"。实测非空转：AC 跑期间移走 `USER-GOALS.md` 或 `metrics-baseline.md`
→ 断言红并给出 `diff=[...]`。
**代价**：`tmp/` 下若真有该检查的 markdown，门不再看它 —— 契约文档一律在 `docs/ .agents/ host/`
与根部，`tmp/` 只放临时产物。范围写进 `12-documentation-standard.md` §1。

## D-073 同一秒的 requested+granted 不得两面说法不一（实测修正，2026-09-21）

**现象**：人工门在同一秒内被 `requested` 与 `granted` 两条事件覆盖时，宿主侧面板说"待批"，而 Python 侧复算是"已决" ⇒ **同一事实两套说法**（本仓最忌的那类不一致）。
**修法**：以"两条事件同秒 ⇒ 视为已决"为口径统一两侧（门与 Python 侧独立复算一致），修正后线上待批门数 2 → 0，且与 Python 侧独立复算逐条一致。
**教训**：时间戳只到秒时，"同一秒内有序事件"必须显式定序或用计数兜底，不能让两侧各自解释。

## D-074 判据只认「契约源」：AC-AGENTRT-002 的会话哨兵扫描改成契约源集合 + 反向断言（2026-09-22）

**缺陷 D-073**（清单 `progress-checklist.md` 的门缺陷行；注意与本文 D-073「同一秒 requested+granted」**编号历史撞车**，不擅自重编号）：
`AC-AGENTRT-002` 的「⑤ 会话哨兵不落盘」断言扫 `tmp/`、`host/`、`user-space/` 时，把**本检查自己源码的副本**
（`tmp/usreq-clean/src/quotagent/qa/checks_agentrt_memory.py`）判成"会话落盘"命中 ⇒ `g1` 红。根因两条：
① 判据范围含**临时副本**（D-071 第 3 条"判据不得覆盖无关写入者"）② 哨兵是**连续字面量**（检查器自身也是命中源）。
**决策**：判据口径改为**契约源集合** = 全树减去 `.git/.venv/tmp/node_modules/__pycache__`（按**相对扫描根**的路径分量判定，不是绝对路径），
与 D-071/D-072 的 `tools/check-docs.py` `SCAN_EXCLUDE_DIRS`、`checks_runtime.py` `IGNORE_DIRS` **同源**；哨兵改**分片拼接**；
**同时新增反向断言**证明收窄的不是扫描强度：真源码路径含哨兵 ⇒ 必命中、仅 `tmp/` 派生副本含哨兵 ⇒ 不命中、
副本字节还原后与真源逐字节一致（⑤b）；并断言扫描器自身不含哨兵字面量（⑤c）。
**实测（EV-164）**：仓库内有 `tmp/` 整树副本时该 AC 绿、`p0-no-node` 全绿；整仓副本里往 `src/` 真源码注入哨兵 ⇒ 红（exit 1，指名命中文件）；
把排除集撤空 ⇒ 红（复现 D-073 原貌）；把哨兵写回连续字面量 ⇒ ⑤/⑤c 红。
**同类口径第三次落地**：判据的"影响面"必须 ≤ 本用例自己的写入面（D-071 → D-072 → D-074）。

## D-075 迁移阶段 1：六动词的"装载"落在一个常驻运行时进程里；注入式 UI 只提供机制（2026-09-22）

**背景**：`tools/plugin.sh` 每调一次就是一个新进程，而"装载"必须活在一个**常驻**进程里才谈得上"入位"与"unload 真移除"。

**决定**：
1. `list`/`deps` 是**只读目录扫描**（不 import 任何插件，不需要运行时）；`load/reload/unload/status` 通过 unix socket
   让一个**常驻运行时进程**做真事（真 `import` 入口 → 真 `ctx.plugin()`；`uid`/`state`/`getEffects()` 都是 cordis 内核实测）。
   运行时进程**按需拉起**、**零写面**（状态只在内存里 ⇒ 不存在"记录说已装载但其实没有"）；
   socket/pid/log 在 `tmp/plugin-runtime/`，唯一写入者是 `tools/plugin-lifecycle.mjs`。
2. 全部插件挂进**同一个 root Context**：cordis 的 `fiber.uid` 计数器是**每个 registry 各自从 1 开始**的，
   每次 `new Context()` 会让两个实例拿到同一个数字（`host/lib/user-space.mjs` 已记过这个坑）⇒ `reload` 拿不到"新 uid"。
3. 注入式 UI：`host/lib/ui-slot.mjs` 只做**机制**（槽位闭合集合 / 排序 / 装配 / 拒收内联脚本 / 指名报错），
   `host/modules/webui.mjs` 只提供注册面与通用拼接；**机制文件与机制行里 0 个插件 id、0 个业务名词**（门逐行扫）。
4. 插件注册用 `ctx.inject(['uiSlots'], …)`（**动态依赖**）而不是 `inject: ['uiSlots']`：
   `uiSlots` 由 `webui` 提供，而 `webui` 的静态 `inject` 里有业务插件 ⇒ 静态 inject 会成环。

**实测踩到并已修的三条（都写进了实现注释与门）**：
① 给 `ctx.provide` **赋值**（本仓既有 idiom）会让该 context 在 dispose 之后再也挂不上插件
（`cannot create effect on inactive context`）⇒ 改成用动态 inject 拿自己提供的服务（并**装载期快照** service 对象：
渲染期再读会抛 `cannot get required service … in inactive context`）；
② `scope.effect()` 的回调必须返回**函数**；返回"带 `dispose` 字段的对象"会被 cordis 当普通值丢掉 ⇒
卸载后留下指向已死实例的区块（门 E5 就是查这条：装载即注册、卸载即反注册，0 残留）；
③ fixture 根里必须让 `host/` 出现在同一个相对位置（样板 wrapper 是相对 path 指向 `host/modules/*.mjs` 的）⇒ 用符号链接。

**判据**：`tools/verify.sh plugin-lifecycle`（43/43，含 4 处单点变异全红 + 产品树字节不变）与 `tools/verify.sh run-once`
（15→18/18，含 4 处变异全红 + 双击 `status` 逐字节一致）；证据 EV-165 / EV-166。

## D-076 运行期装卸（`--live`）：装进正在服务的那只进程；`user-space` 收敛为兼容链接（2026-09-22）

**决定**：① 运行期装卸挂在**宿主自身的 ctx 树**里（`tools/plugin.sh … --live` → `POST <prefix>/api/plugins/control`
（路由注册面 `host/lib/ui-route.mjs`）→ `src/system/runtime/code/live-control.mjs`）—— 只有这样才能让插件的
`ctx.inject(['uiSlots'])` 解析得到，"装载后区块真上页面"才成立；再起一个进程只能证明"能 import"。② 四道围栅
**fail-closed**：控制令牌（不配 = 通道整体关闭；只比 sha256 摘要、不回显不落盘）/ 显式 `confirm` / `system/**`
层锁 / 只认显式动词与 id。③ `--live` 与常驻运行时进程**并行**（前者要页面、后者要可跑在任意 `--root`），两条路的
装载事实都只在内存里。④ `user-space` → `src/userspace/**` 收敛为**唯一源**：旧位置改成指向它的**符号链接**
（`.gitignore` 的 `user-space/` 只匹配目录 ⇒ 链接入库），旧路径的 12 处读方一行不动。

**实测坑（已写进源码注释与门）**：① `host/cli.mjs` 用 `inner.provide = …` 抓句柄会污染**全树** provide ⇒
之后装载的插件把服务注册在**别人的 fiber** 上、卸载留残注册（运行期再装载必红）；正解 `ctx.get(...)`，
门 D5 扫"webui 装配段 0 处 monkey-patch"；② 断网验收里 `NO_PROXY` 不能留空（否则本机健康检查走死代理）；
③ 变异夹具的 `config init` 目标路径必须每次全新。

**判据**：`plugin-lifecycle`（44→**59/59**）与 `run-once`（18→**34/34**，8 处变异全红）；细节与原始行见
`docs/work/evidence/EV-168-live-plugin-lifecycle-and-userspace.txt`、清单 T-317。

## D-077 事实区判据必须对**符号链接形态**同样成立（存储那次遗留红的根因与收紧方向）（2026-09-22）

**问题**：`user-space` 收敛成指向 `src/userspace/` 的**兼容符号链接**（D-076 ④）之后，`tools/storage.py`
的事实区判据在做 `_inside(USER_SPACE, <realpath>)` 比较 —— 左边是**词法路径**（`<root>/user-space`）、
右边是**真实路径**（`<root>/src/userspace/…`）⇒ 恒假 ⇒ 「`user-space/` 里别人的 ns」整类拒绝**失效**
（`verify.sh storage` 第 8 条里两种构造的返回码为空，门 18/19）。修前实测：`--root user-space/zz-t277-other
open-append …` 返回 `ok:true`，**真在 `src/userspace/` 下落了文件** —— 即"存储成了第二条事实写路径"。

**决定**：① 事实区一律用 `_inside_zone(zone, target)` 判：把「zone 的**两种形态**（词法 + 真实）×
目标的**两种形态**」**交叉各判一次**，任一命中即命中 —— **收紧方向**，只可能多判成事实区；`_root_path` /
`_target` / `snapshot` 的 4 处单形态比较全部换掉，`snapshot --out` 另加"落点在 `user-space/` ⇒ 拒"。
② 判据自身要**非空转**：门第 8 条内嵌**反向自证**（词法形态的变体副本**必须放行**那两个构造）+
新增 `--mutate 5`（改产品实体后跑门必须 exit 1、首个 FAIL = 第 8 条、还原 sha256 逐字节一致）。
③ **一般规则**：判两条路径是否同属一片区域时，只要任一侧可能是符号链接，就必须**把两种形态都算**；
"改完看着还是绿的"不算证据 —— 先量真行为（本批正是先量出"真写了 2 B"）。

**判据**：`storage` **18/19 → 19/19**；`--mutate 5` 与修前/修后三条构造的原始行见
`docs/work/evidence/EV-174-batch4-raw.json`；契约同步 `docs/design/25-storage-plugins.md` §3。

## D-078 `system/webui` 接上入口：入口 = 唯一自述服务的 ESM 实体（2026-09-22）

- 决定：`entry` = `code/index.mjs`（只重导出既有实体 `code/webui.mjs`，透传 `inject`/`provides`/`Config`）；
  `provides` 由占位键 `['webui']` 改为实体自述的 `['webui','uiSlots']`。
- 理由：`uiSlots`（注入式 UI 注册面）是**实体自己声明的服务键**，不写进清单会让服务索引与实体自述不符。
- 被否决：①入口取 `ui-slot.mjs`/`ui-route.mjs`（机制件，无 `provides`/`apply`，不是插件）②`provides` 只留 `['webui']`（与实体自述不符）③不接，让占位键长期留在树里（`degraded: artifact-missing` 从"事实"退化成"没做完"）。
- 连带（必做，否则等于放宽门）：`plugin-lifecycle` 的 A13/A14 原本以「真根上 `system/webui` **未迁移**」为锚点 ⇒
  本批改指**对照根**（真 id + 真清单字节 + `entry` 文件缺失 ⇒ `artifact-missing`），并在真根上补**正控**
  （`missing_targets == []`、`closure == ['system/webui']`、`deps_ready == true`）；断言只增不减。

## D-079 `system/admin` 接上入口：**机制组合**（两个平级成员插件）（2026-09-22）

- 决定：`entry` = `code/index.mjs`，`apply` 按序把 `code/admin-guard.mjs`（`adminGuard`）与
  `code/admin-view.mjs`（`adminView`）交给宿主；`provides` = 两者并集。
- 理由：本目录里是**两个各自独立的 cordis 插件**（各有 `apply`/`provides`/`Config`），不是「一个服务 + 支持库」；
  宿主里它们本来就是两个平级模块（`host/modules/admin-guard.mjs`、`admin-view.mjs`）。
- 被否决：①只挑一个当入口（另一个的服务键在服务索引里永远 `unresolved`，`load` 也只装半个插件）
  ②把目录拆成两个插件（63 个插件数量与需求归属是冻结事实，拆目录会连带改归属真源）
  ③不接（`provides` 长期是占位键 `['admin']`，与实体自述不符）。
- 机制组合**不新造语义**：本文件不做判断、不算数、不读文件、不写任何东西；也不替成员解析配置（成员按自己的 `Config` 取默认值装载）。

## D-080 `system/agent-runtime` 接上入口：**机制组合**（三个平级成员插件）（2026-09-22）

- 决定：`entry` = `code/index.mjs`，`apply` 按 name 字典序装载 `agent-context`/`agent-harness`/`agent-memory`；
  `provides` = 三者并集（`agentContext`/`agentHarness`/`agentMemory`）。
- 理由：三者 `inject` 全空、互不依赖，宿主里本来就是三个平级模块；**「各自独立装卸」这条性质不变**
  （由 `AC-AGENTRT-007` 单独围栏：卸载零残留、卸载后事实不丢）。
- 被否决：①只挑一个当入口（另两个的服务键永远 `unresolved`）②拆成三个插件（同 D-079 的理由）③不接。

## D-081 `system/canary` 接上入口：**机制组合**（`canary` + `bridge-canary`）（2026-09-22）

- 决定：`entry` = `code/index.mjs`，先装 `canary.mjs`（`canary`）、再装 `bridge-canary.mjs`
  （`canary-dispatch`，声明 `inject: ['canary']`）；`provides` = 两者并集。
- 理由：`canary-dispatch.mjs`/`canary-run.mjs` 是**库**（导出 `makeDispatcher`/`runCanary`，无 `apply`、无 `provides`）
  ⇒ 不是入口候选；两个真插件都必须被装到，否则"接线文件不接线"这个已知限制会长期留着。
- 被否决：①只装 `canary.mjs` ②把库文件当入口（不是插件）③不接（占位键 `['canary']` 与实体自述不符）。

## D-082 `system/mail` 接上入口：ESM 视图实体当入口，Python 真收发不经入口（2026-09-22）

- 决定：`entry` = `code/index.mjs`（重导出 `code/mail-view.mjs`，`provides=['mailView']`）。
- 理由：与 `system/approval`（ESM + Python 并存）**同一口径** —— 有 ESM 实体时，入口 = 那个宿主可装载的实体；
  SMTP/IMAP 真收发在 Python 侧 `code/mail.py`·`mail_transport.py`（宿主**不**经 cordis 装载它们，见 27 §7.1）。
- 被否决：①入口 = `code/__init__.py` 只重导 Python 面（宿主侧就丢掉了 `mailView` 这个真服务键，运维视图装不上）
  ②不接（占位键 `['mail']` 既不是 Python 模块名也不是服务键）。

## D-083 `system/eval` 接上入口：**Python 承载入口**（宿主侧 0 个 ESM 实体）（2026-09-22）

- 决定：`entry` = `code/__init__.py`（新建，只重导出既有实体 `code/evaldata.py`·`evalmetrics.py`·`scenarios.py`，
  与 19 个 Python 承载插件同形）；`provides` 沿用插件名键 `['eval']`（Python 承载插件的既有口径）。
- 理由：本插件在宿主侧**没有任何** `provides`/`apply` 的 `.mjs` ⇒ 写 `code/index.mjs` 只能是空壳或新造的宿主面 = **造功能** ✗；
  而 Python 承载入口是仓库既有的合法形态（`entryKind` = `python`）。
- 被否决：①造一个空的 `code/index.mjs`（假入口）②把 `provides` 改成三个 Python 模块名（宿主侧不经 cordis 解析它们，属于把"模块名"冒充"服务键"）③不接。

## D-084 `system/kernel` 接上入口：入口 = **内核包自己的** `code/__init__.py`（2026-09-22）

- 决定：`entry` = `code/__init__.py`（**已存在**的包初始化文件，不是新造）；`provides` 沿用 `['kernel']`。
- 理由：本插件在宿主侧没有 ESM 服务实体（`code/frozen.mjs`·`code/ledger-view.mjs` 是机制件，无 `provides`）；
  内核只经 `kernel-bridge` 的 stdio 通道被使用，宿主不经 cordis 装载它 ⇒ 用包初始化文件当 `entry` 是**如实**的。
- 边界（不因本决定放宽）：**内核不可自改**（ADR-0002）—— 接上 `entry` 只表示"这个插件的实现在 `code/`"，不表示
  内核成为可热插拔的宿主插件；卸载/装载内核仍不在任何门的判据内。
- 被否决：①造 `code/index.mjs` 包一层 ESM 面（内核没有宿主侧服务键可导，属造功能）②不接（`degraded: artifact-missing`
  反而掩盖"Python 实现在树里"这个事实）。

## D-085 干净副本的宿主依赖口径 + 扫描面自证（2026-09-22）

- ① **干净副本三条红**（`AC-AGENTRT-002/006/007`）的根因是**宿主依赖**：三条 AC 的围栏门 `import`
  gitignored 的 `host/node_modules/cordis` ⇒ `ERR_MODULE_NOT_FOUND`（rc=1）；工作树里装过依赖所以看着绿。
  裁决：AC 真跑围栏门一律走 `tools/cordis.sh run`（幂等 `install_deps`；与 `checks_bridge`/`check-webui.py`/
  `check-canary.py` 同一既有约定），**判据一格未改**（仍是 `failures:0` 且断言数 ≥22）；`_node()` 的
  「无 Node ⇒ 明说降级」不变。一般规则：**判据不许依赖真根上的偶然状态** —— 同一副本里「单独跑绿 /
  全量跑红」只是**顺序**造成的（靠后的 `AC-INTEG-*` 走 `cordis.sh run` 顺手把依赖装上）。
- ② **扫描面必须自证**：PA9 的扫描面原本是 `src/**`/`host/**`/`tools/**`/`**/*.sh` —— 匹配不到**没有扩展名**
  的仓库根入口 `run`，而它正是「克隆即跑」的第一层。裁决：扫描面加 `run`；新增 **PA9b**（逐条点名必扫文件，
  漏一个即红）；**F9** 往 `run` 里写死仓库根 ⇒ PA9 必红。
- 判据：干净副本（无 `node_modules`）三条 AC 绿、把修复还原成裸 `node <实体>` ⇒ 三条必红；
  `plugin-assets` PA9/PA9b 正向 0 处命中 + F8/F9 反向必红；`plugin-lifecycle` 68/68。

## D-086 WebUI = 完整 GUI 应用（不是账本投影/只读路由）；业务功能优先于门禁（2026-09-22）

- 用户指令（原话与完整口径见 `docs/design/29-webui-gui-app.md`）：WebUI 必须是**完整的 GUI 应用**，插件注册
  视图/交互/动作与命令/业务逻辑钩子/通知与状态即可实现任意功能；**验收 = 双方仅通过 GUI 走完全部业务流程
  （含写操作）**；旧口径与旧判据（UI 快照门/seed 门/ui-mutate 门、「三块锚点 + 0 JS」式 AC）**一律删除、
  不留副本**；门禁与测试只是安全带，**推进业务功能是唯一重要的事**。
- 落地：`AGENTS.md` §11/§12；口径真源 `29`；`27 §6`、`14-archive`、webui `requirements/README.md` 改指 29。
