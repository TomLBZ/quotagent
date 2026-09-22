# 验收标准（AC）

<!-- budget: 32 KB. 每条 AC 必须是可执行命令 + 明确断言；没有命令的 AC 是愿望，不算标准 -->

## 0. 运行器契约（实现期遵守）

```sh
python -m quotagent.qa ac AC-NORM-001        # 单条 AC，打印 JSON {ac, status, assertions[], evidence_refs[]}
python -m quotagent.qa suite s1              # 一个场景集
tools/verify.sh ac AC-NORM-001               # 同上（仓库内运行时入口，自带 sys.path）
tools/verify.sh smoke                        # 运行时自检（解释器解析 / 标准库依赖 / 临时目录）
tools/verify.sh g0|g1|g2                      # 阶段门：跑该门要求的全部 AC，返回非零表示未通过
tools/verify.sh cordis                       # 宿主层冒烟（cordis 五模式/effect/重载，ADR-0012）
tools/verify.sh v                            # V-001..V-012 登记表校验（S0.15）
tools/verify.sh docs                         # 文档门（当前阶段即可运行）
```

运行器实现在 `src/quotagent/qa/`（每条 AC 一个断言函数，注册进注册表），
解释器解析与 `.venv` 创建见 `../design/adr/0007-p0-runtime-and-ledger-format.md`。

- 退出码 0 = 通过；非零 = 失败，且必须给出**首个失败断言的具体差异**。
- 每次执行把原始输出写入 `docs/work/evidence/EV-<NNN>-<AC-ID>.txt`（或 `.json`），
  再在 `progress-checklist.md` 里引用该证据编号。
- AC 是**可执行的**：不允许"人工检查一下"作为断言，除非该 AC 明确标 `manual` 并给出人工步骤与签署人。

## 1. 当前可执行（设计期）

| ID | 断言 | 命令 | 状态 |
|---|---|---|---|
| AC-DESIGN-001 | 所有 ID 引用（FR/AC/T/ADR/INV/V/NFR）都在其定义文件中存在；无 `xxx`/`TODO` 占位 | `tools/verify.sh docs` | 见 `evidence/EV-001` |
| AC-DESIGN-002 | 每个受预算约束的文件不超预算（`../design/12-documentation-standard.md` §1） | `tools/verify.sh docs` | 见 `evidence/EV-001` |
| AC-DESIGN-003 | 每条 FR 至少引用一条已定义的 AC，且 AC 至少被一条 FR 引用（双向无孤儿） | `tools/verify.sh docs` | 见 `evidence/EV-001` |

**AC-DESIGN-001..003 在代码实现前即可运行**，是本仓库"文档也是可验证制品"的最低保障。

## 1.1 运行时与运行器（P0 S0.1）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-RUNTIME-001 | P0 | `src/` 只导入标准库；干净副本（不含 `.venv`/`tmp`）用裸解释器可跑 `tools/verify.sh docs` 与 CLI；`tools/bootstrap.sh` 幂等且运行产物只落 `.venv/`、`tmp/`；跑完后门的**契约文档集合**不变（临时副本不在门的扫描范围内 —— 真契约文档一个不少、临时副本不参与判定，见 D-072） | `qa ac AC-RUNTIME-001` |
| AC-RUNTIME-002 | P0 | CLI 契约：`qa ac` 输出 `{ac, status, assertions[], evidence_refs[]}`；退出码 0/1/2；未知 AC 与未实现场景集返回 2（不伪装通过）；`qa list` 覆盖本批 AC | `qa ac AC-RUNTIME-002` |

## 2. 内核

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-AUDIT-001 | P0 | 篡改任意一条历史事件后 `verify_chain()` 返回假；审计包独立验证失败 | `qa ac AC-AUDIT-001` |
| AC-AUDIT-002 | P0 | 对随机抽样的 20 次模型调用，`rebuild(inputs) == observed_inputs` 全部相等 | `qa ac AC-AUDIT-002` |
| AC-EVT-001 | P0 | 五模式各自的分发顺序与返回值符合 `../design/05-events.md` §1 的判据 | `qa ac AC-EVT-001` |
| AC-EVT-002 | P0 | waterfall 监听器不调 `next()` 时下游不被执行；该短路在 `../design/05-events.md` §5 拦截点总表有登记，且默认事件表的每个 waterfall 事件都在表内 | `qa ac AC-EVT-002` |
| AC-PLUGIN-001 | P0 | 装载后 `effects()` 非空；卸载后 `effects()` 为空且无残留定时器/订阅 | `qa ac AC-PLUGIN-001` |
| AC-PLUGIN-002 | P0 | 使某依赖失活后，消费者转为非激活；恢复后自动重载且不迁移草稿 | `qa ac AC-PLUGIN-002` |
| AC-QEP-001 | P0 | 信封构造后可验签；改动任一字段导致验签失败 | `qa ac AC-QEP-001` |
| AC-QEP-002 | P0 | 同一报文投递 3 次只产生 1 条事实；重发不改变 `msg_id` 与 `body_hash` | `qa ac AC-QEP-002` |

## 3. 归一化与比价

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-NORM-001 | P0 | 含税/不含税、不同单位、不同币种的混合报价归一后金额误差在声明容差内（容差取自 `MeasureRule.tolerance_bps`，随结果与账本事件留存） | `qa ac AC-NORM-001` |
| AC-NORM-002 | P0 | 缺计量规则或汇率时点不可得 → 拒绝并给出理由；**不产生**结果 | `qa ac AC-NORM-002` |
| AC-NORM-003 | P0 | 报价条目全部对齐到清单条目或被标为 `additional`；未对齐条目不被静默丢弃 | `qa ac AC-NORM-003` |
| AC-COMPARE-001 | P0 | 报价 `rfq_rev` 与包版本不一致时该报价不进入排序，并产生 `rfq/version-mismatch` | `qa ac AC-COMPARE-001` |
| AC-COMPARE-002 | P0 | 同输入两次排序结果完全一致；TCO 各分量可按策略 patch 复算 | `qa ac AC-COMPARE-002` |
| AC-COMPARE-003 | P0 | `Evaluation` 中每个数值都有引用链；人为删掉一条引用后校验失败 | `qa ac AC-COMPARE-003` |

## 4. 澄清、审批与护栏

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-CLARIFY-001 | P0 | 工单必带 `rfq_rev` 与条目引用；无引用的工单被拒绝 | `qa ac AC-CLARIFY-001` |
| AC-APPROVE-001 | P0 | 批准记录只能由人产生；尝试以 agent 身份签署被拒绝 | `qa ac AC-APPROVE-001` |
| AC-APPROVE-002 | P0 | 无批准记录时：提交报价/授标承诺/发 PO 三条路径全部抛错（INV-005） | `qa ac AC-APPROVE-002` |
| AC-GUARD-003 | P0 | S4 反例（注入/漏项/虚假产能/伪造批准）全部被拦且有账本留痕 | `qa ac AC-GUARD-003` |

## 5. 承包商侧与供应商侧

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-RFQ-001 | P0 | 清单条目缺计量规则或接口无唯一责任方 → 校验失败 | `qa ac AC-RFQ-001` |
| AC-RFQ-002 | P0 | 已发布版本字段无法原地修改；`amend` 产生新版本与字段级 delta | `qa ac AC-RFQ-002` |
| AC-INTAKE-001 | P0 | 抽取结果逐条带 `item_id`；无引用者进入 `[假设]` 待确认 | `qa ac AC-INTAKE-001` |
| AC-INTAKE-002 | P0 | 缺项检测能覆盖人为删减的条目；疑问清单需人工确认后才外发 | `qa ac AC-INTAKE-002` |
| AC-COST-001 | P0 | 成本构成可按要素分解且可解释；私域服务在对方 realm 取不到值（与 AC-TRUST-001 同测） | `qa ac AC-COST-001` |
| AC-PRICE-001 | P0 | 定价产出为 Intent；越界（超授权区间）无条件请求批准；最终数字需人确认 | `qa ac AC-PRICE-001` |
| AC-DEV-001 | P0 | 未标 `impact` 的偏差不参与 TCO；偏差类别与影响可查 | `qa ac AC-DEV-001` |
| AC-NEGO-001 | P2 | 轮次与让步上限生效；任何价格让步需要人工批准 | `qa ac AC-NEGO-001` |

## 6. 评测与自进化

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-EVAL-002 | P0 | 指标基线报告可生成，且人员可读；反例集只增不减（删除被拒绝） | `qa ac AC-EVAL-002` |
| AC-INTEG-001 | P0 | 文件投递为原子写（临时文件 + rename）；半写文件不被读取 | `qa ac AC-INTEG-001` |
| AC-MAIL-002 | P2 | 结构性事实：transport/mail/只读视图/键白名单/门脚本五件齐备；未配置与连不上**各有专属 reason**（不是笼统失败）；异常消息洗过（redact/scrub）；邮件键已在白名单（≥6 条 ⇒ 配置 UI 可改并持久化）；宿主只读视图零写面且无 `<script>`；`verify.sh mail-transport` 已挂；视图模块可加载且导出预期符号 | `tools/verify.sh ac AC-MAIL-002` | EV-146 |
| AC-VIZ-001 | P2 | 比价 heuristics：改一个权重→**排名与得分必变**（权重敏感非空转）；权重越界夹取并回显、归一后和为一；**私域哨兵（reserve_price/cost_model/cost_floor/markup_pct/private:/bidders_private/authorized_band/internal_notes）在两视角页面与 JSON、以及换权重后的页面上命中 0 次**；有界报 `omitted`、降级有 reason；宿主零写面；新页面**仍 0 行内联脚本** | `tools/verify.sh ac AC-VIZ-001` + `tools/verify.sh bid-heuristics` | EV-147 |
| AC-UIFB-001 | P2 | 见 EV-148（0600 待办件 / 横幅两方向 / 幂等 / 三拒绝码） | `tools/verify.sh ui-feedback` | EV-148 |
| AC-ADMIN-005 | P2 | UI 内解阻塞闭环：带 token 的 `POST /admin/api/blocks/<id>/resolve` → 202 且**宿主侧账本零新增**（业务账本哈希逐一不变）、只在 `tmp/ui-shared/admin-submissions/` 落一条 **0600** 待处理项（含 payload_sha256/bytes，响应不回显材料）；Python 侧 `tools/admin-apply.py` 消费（**缺 `human:` 批准引用一律拒且账本零新增**）后落 `admin/block-pending`+`admin/block-resolved`（body 恰 7 键，**不含凭据值也不含字段名**）、幂等（同哈希重跑零新增）、源件移入 `applied/`；判定器带 `resolutions_path` 时该 block 从活动列表移除且 `counts.resolved` +1（不传时与旧行为逐字节一致） | `tools/verify.sh ac AC-ADMIN-005`（端到端另见 `verify.sh admin-route`） | 见 `evidence/EV-133` |
| AC-MARKET-001 | P2 | pluginMarket 服务由插件提供且列表非空（空列表必 degraded）；每个进树模块都带 source(human/evolve/user-space) 与 wired（找不到即显式 false，不隐藏）；卸载 plugin-market 后其它插件照常运行 | `tools/verify.sh plugin-market` | 见 `evidence/EV-134` |
| AC-MARKET-002 | P2 | 可安装项与已装载项分开；负控：影子/未晋升产物放进候选**不得出现**；每条可安装带 install_ref 指向既有门；无引用的安装请求被拒且不落产物 | `tools/verify.sh plugin-market` | 见 `evidence/EV-134` |
| AC-MARKET-003 | P2 | 三种不一致各造一次（目录有/清单无、清单有/目录无、用户空间清单哈希≠产物哈希）→ `inconsistent:true` + 逐项差异，不得取其一静默通过 | `tools/verify.sh plugin-market` | 见 `evidence/EV-134` |
| AC-MARKET-004 | P2 | 连读市场面前后 `host/modules/*.mjs` 与 `src/**/*.py` 逐字节与个数不变、无新文件、账本零新增、无子进程、四 profile config_digest 不变 | `tools/verify.sh plugin-market` + `clean-copy` + `invariants` | 见 `evidence/EV-134` |
| AC-MARKET-005 | P2 | 同输入两次输出除时间键外逐字节一致；超上界即 `truncated:true` 并带被丢条数；正文与私域哨兵均不出现 | `tools/verify.sh plugin-market` + `webui` | 见 `evidence/EV-134` |
| AC-MARKET-006 | P2 | 源不可读 → `degraded:true` + reason + next_action；与"真零插件"可区分；两种情形都不许报 ok:true 掩盖 | `tools/verify.sh plugin-market` | 见 `evidence/EV-134` |
| AC-USERPLUG-002 | P2 | 写面负控四例：target = `host/modules/`、`src/`、别人 ns、仓库外 → 全部拒绝（码区分 `user-space-outside-ns` / `artifact-outside-write-surface`），**且四个目标位置事后都不存在该文件** | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-003 | P2 | 重载：改产物后只有该插件重启（新 uid，pid 不变），不迁移旧内存状态（断言草稿为 null 而非旧值） | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-004 | P2 | 卸载零残留：effects 归零、订阅不再收事件、句柄关闭；其它用户空间与平台插件的 effects 与行为逐项不变 | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-006 | P2 | 隔离四件套：①两 ns 同名插件 uid 不同且可分别卸载 ②服务键命名空间化且注册平台保留名（如 `approval`）被拒 ③文件根绑定后 `..`/绝对路径/符号链接越界均拒 ④凭据只解析本 ns 前缀 | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-007 | P2 | 四类反例结构性拒绝并留痕（`userplugin/refused` 带 code + next_action）：①写别人目录 ②跨 instance 共享可变状态 ③未提权插件被他人加载 ④**无凭据自称已连接** | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-008 | P2 | 管理面本身是插件：卸载它之后**已装载的用户空间插件照常运行**（effects 仍 >0、列表快照仍可读），新装载被拒且不伪装成功 | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-009 | P2 | 不耦合进平台：装载/卸载前后 `host/modules/**/*.mjs` 与 `src/**/*.py` 逐文件 sha256 不变；未登记服务名 inject 即拒 | `tools/verify.sh user-space` + `evolve-module` + `wiring` | 见 `evidence/EV-135` |
| AC-USERPLUG-011 | P2 | 跨 ns 加载**未提权**插件 → `user-plugin-not-elevated` 且未载入（effects 仍空） | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-012 | P2 | 两个方向都封死：自进化 target 指到 `user-space/` → `artifact-outside-write-surface`；用户空间装载 target 指到 `host/modules/` → `user-space-outside-ns` | `tools/verify.sh user-space` | 见 `evidence/EV-135` |
| AC-USERPLUG-001 | P2 | 提需求 → 产出用户空间插件 → **无人工搬运即出现在管理列表**（真 `scan()` 命中）；落一条 `userplugin/created`（body 含 `source_prompt_digest` 与 `artifact_sha256`，**不含需求正文**）；幂等（重跑标 duplicates、账本零新增、退出码 0）；manifest 非法 → `userplugin/refused`（code=manifest-invalid）且不落 created；待办件自述（description_sha256）与正文不符 → 拒绝且不因此创建账本文件  | `tools/verify.sh ac AC-USERPLUG-001` | 见 `evidence/EV-136` |
| AC-USERPLUG-005 | P2 | 用户空间插件迭代/回滚：版本递增才落 `userplugin/upgraded`（带 `prev`）；回滚只有在**磁盘内容哈希 == 目标版本哈希**时才落 `userplugin/rolled-back`，否则 `version-not-bumped` / `rollback-content-not-restored` / `rollback-refused-modified` / `rollback-target-unknown` / `rollback-noop`；账本里不存在"不真"的回滚记录 | `tools/verify.sh ac AC-USERPLUG-005` | EV-138 |
| AC-USERPLUG-010 | P2 | 提权（用户空间 → 系统级）：agent 发起 → `approval-ref-not-human`；引用形状错 → `approval-ref-malformed`；缺引用 → `elevate-needs-approval`；产物哈希与载荷不一致 → `shadow-hash-mismatch`；目标已存在 → `target-exists`（逐字节不覆盖）；清单 name 越界 → `target-name-mismatch`；人类 actor + 哈希一致 → **真写**并落 `userplugin/elevated`（含 `artifact_sha256`/`shadow_sha256`/`approval_ref`/`actor`）；六次拒绝全部零写账本 | `tools/verify.sh ac AC-USERPLUG-010` | EV-139 |
| AC-AGENTRT-006 | P2 | 运行期插件三件（agent-context/agent-memory/agent-harness）**零写面/零外部副作用**（写文件/子进程/网络/随机/定时器逐类断言）；四层记忆名字与三类关键拒绝码齐全；**有界与降级契约**（`truncated`+`omitted`、`degraded`+`reason`+`next_action`、空上下文可区分）在源码与围栏门里都成立；围栏门真跑 `failures:0` 且断言 ≥22（四类反例 + 4 处变异自证）；无 Node 环境**降级而非变红** | `tools/verify.sh ac AC-AGENTRT-006` + `tools/verify.sh agent-runtime` | EV-140 |
| AC-AGENTRT-007 | P2 | **不加载任何宿主插件**也能从账本重放项目记忆（两次逐字节一致、账本零改动）；三件模块各自有 dispose 实现痕迹（扫描器非空转：空文件不命中）；三件 `provides` 互不重叠且 `inject` 为空；围栏门真跑 `failures:0` 且三件都登记了 `*-disposed` 留痕（无 Node 降级为静态断言） | `tools/verify.sh ac AC-AGENTRT-007` | EV-143 |
| AC-AGENTRT-002 | P2 | 记忆四层边界：项目记忆由账本重放**两次逐字节一致**、删掉快照重建仍逐字节一致（丢缓存不丢事实）、每条都带 `citations`、**账本字节零改动**、账本不可读 → `ledger-unreadable` 拒绝（不伪装空投影）；会话层静态零写面 + 磁盘上检索不到会话哨兵；策略只人写/跨方只走协议由围栏门真跑（无 Node **降级**为源码级断言） | `tools/verify.sh ac AC-AGENTRT-002` | EV-141 |
| AC-STORAGE-001 | P2 | 本租户日志可写且 `stat` 的 `sha256` 与磁盘一致；`..`/绝对路径/符号链三例全拒且**根外目标一个都不存在**；有界读取 `limit=5` 恰返回 5 行且 `omitted` 恰等于被丢行数 | `tools/verify.sh ac AC-STORAGE-001` | EV-142 |
| AC-STORAGE-004 | P2 | 三种越权形态（`ns=../beta`、`ns=beta/../alpha`、`rel=../beta/x`）一律 `storage-outside-ns`，且越权尝试后哨兵与越权文件**在磁盘上不存在**（不是只返回错误）；存储写不产生账本行、账本字节零改动；往声明的事实路径写被拒 | `tools/verify.sh ac AC-STORAGE-004` | EV-142 |
| AC-STORAGE-006 | P2 | 只读观察面（`snapshot`）两次输出逐字节一致（确定性）；**读前后存储树字节数不变**（读它不改状态）；输出里不出现日志正文与私域哨兵 | `tools/verify.sh ac AC-STORAGE-006` | EV-142 |
| AC-UXWEB-001 | P2 | 模块导出 `SUBVIEWS`（子视图单点定义）；第一屏三块 `data-block` 锚点齐备且顺序正确；页面模板**无 `<script>`、无内联事件属性**且交互用 `<form method=get>`；`data-subnav` 与「上手」入口都在；空结果带 `data-empty`；子视图清单 8 条（HTTP 行为另由 `tools/verify.sh webui` 44/44 举证）| `tools/verify.sh ac AC-UXWEB-001` + `tools/verify.sh webui` | EV-144 |
| AC-CONFIG-001 | P2 | 配置/凭据 UI：11 条路径未提权 **401 同形（唯一 body）**；带会话 `/admin/config/` 200 且**0 行 `<script>`**、`/admin/api/config` 200（三层 + 每键 source/shadowed_by/editable）；干跑预览**不落盘**（真 `/workspace/config.yaml` sha256 前后一致）；提交只落 **0600** 待处理项且账本零新增；`config-apply.py` 原子写 + 回滚 + 幂等；账本事件 body 与全部响应体里**凭据哨兵出现 0 次**；YAML 不支持的构造被拒且给 reason | `tools/verify.sh ac AC-CONFIG-001` + `tools/verify.sh config-route` | EV-145 |
| AC-RFQ-006 | P2 | **「来不及回 RFQ」的口径、诚实与真交互**：`status(payload)` 同输入两次**逐字节一致**（键序打乱/条目逆序/跨实例/冻结输入不抛错/输出无时间键）；**回文时限不来自墙钟** —— 两个墙钟入口（`payload.now`/`config.now`）各给两个不同值，输出**逐字节不变**，且 `remaining_seconds` 等于手算 `due_ts − as_of`（事实 ts 之差），`due_ts` 取自事实行（`rfq/published.quote_by` 或 `rfq/promised.due_at`，取事实 ts 最晚的那条；`due_basis` 指名来源）；每条 RFQ 键集**恰 11 键**（`rfq_id/subject/due_ts/due_basis/responded/silent/overdue/remaining_seconds/severity/next_action/blocked_by`）；**没凭据不得假装能发** —— 通道 `available=false` ⇒ 每条 `blocked_by` 写清「无法代发」与通道 reason，且整个输出里「已通知/已提醒/已发送/已发出/已催」**0 命中**（`can_send=false`；通道可用时也**不**自称已发）；**竞标人名册是业主私域** —— 非业主视角对 `invited`/`quotes` **读都不读**（带名单与不带名单输出逐字节一致、三列恒空），业主侧 `responded` 与 `host/modules/sourcing.mjs` 的 `coverage()` **同一口径**；**空投影 → `degraded:true` + 有名 reason + 条目为空** 且不抛错（「载荷不能用」与「数据齐但无发布过的包」两个 reason 可区分）；有界（`max_items` 夹取 + 段上限 64 + 如实报 `omitted`/`truncated`）；私域哨兵 0 命中且带哨兵与不带哨兵**逐字节一致**；**插件发不了任何东西、也批不了任何东西**（服务面恰 5 键、`can_send=false`/`can_approve=false`）；围栏门 23/23（≤14 条即红），含 **4 处单点变异全红**（期限改用墙钟 / 通道不可用走「可用」分支 / 空输入守卫失效 / 非业主视角读报价段）与防假变异自检、跑完产品树字节不变；真 HTTP：两视角页面与 JSON 200、三条路由 `auth=none`、四道页面子导航含入口、页面 **0 行 `<script>` / 0 内联事件**、登记承诺 POST **202** + 待办件**恰 0600** + 原话逐字 + 发言人/时限/RFQ id 齐备 + 宿主账本零新增、真跑 `rfq-promise.py` 落 `rfq/promised`（body 恰 6 键、不含原话正文）且 `/api/status` 计数 **5 → 6**、**承诺真的改变页面口径**（`due_basis` 换 `rfq/promised`）、幂等 `duplicates` + 账本零新增、拒绝路径 `rfq-not-found`/`pending-tampered` 给 code | `tools/verify.sh rfq-deadline` | EV-157 |

| AC-ADV-001 | P2 | **决策建议层的确定性、溯源与诚实**：`advise(payload)` 对同一份白名单载荷**两次逐字节一致**（且与入参键序/条目顺序无关、跨实例一致、输出无时间键）；每条建议 `basis` **非空**且每个 token 都解析回载荷真键（`as_of` 或 `<段>[<id>].<键>`，四种篡改必须判假）；输出恒带 `engine="rules"` + 「不含模型推测」文案 + `privacy`（model_calls=0 / network_calls=0 / private_keys_read=false）；**空投影 → `degraded:true` + 有名 reason + `items:[]`**（「载荷不能用」与「数据齐但无可建议项」两个 reason 可区分，且**不抛错**）；有界（`max_items` 夹取 + `shown + omitted = generated`）；私域哨兵 0 命中且**带哨兵与不带哨兵逐字节一致**；围栏门真跑 `failures:0`、断言 ≥14，含 **4 处单点变异全部变红**（有界 / 空数据守卫 / basis 断链 / engine 篡改）与防假变异自检、跑完产品树字节不变；真 HTTP：两视角页面与 JSON 200、四道页面子导航含入口、页面 **0 行 `<script>` / 0 内联事件**、**两视角建议不同**、同一 URL 两次逐字节一致 | `tools/verify.sh ac AC-ADV-001` + `tools/verify.sh advice`（围栏门 + 真路由门） | 见 `evidence/EV-150` |
| AC-GATE-001 | P2 | **「审批等多久 / 变更单谁卡着」的口径、溯源与诚实**：`timeline(payload)` 对同一份载荷**两次逐字节一致**（键序/条目逆序/跨实例都一致、输出无时间键）；**等待时长不来自墙钟** —— 两个墙钟入口（`payload.now`/`config.now`）各给两个不同值，输出**逐字节不变**且 `age_seconds` 等于手算 `as_of − requested 事实 ts`（已 granted/denied/aborted 的门**不进**等待列表）；每条门键集恰 9 键、带非空 `age_basis` 与 `consequence`（三种超时策略各自说清，**没有"会批准"这种话**）；**每条变更单带非空 `basis`** 且每个 token 解析回载荷真键（不存在的 ref/键/坏形状/空 basis/不存在的事件类型五种篡改必须判假）；`owed_by` 用队列里的真审批人、没有就 `human:unassigned`（不编人名）；**插件不能批准**（句柄方法恰 `change_detail|config|meta|nudge|requests|timeline`、无审批类方法、`meta.can_approve=false`、催办载荷 `requested_action="nudge"` 且记录里无审批字段）；**空投影 → `degraded:true` + 有名 reason + 两列表为 0** 且不抛错（"载荷不能用"与"数据齐但无可报项"两个 reason 可区分）；有界（两段各自截断 + `omitted` + `max_items` 夹取）；私域哨兵 0 命中且**带哨兵与不带哨兵逐字节一致**；围栏门真跑 `failures:0`、断言 ≥14，含 **4 处单点变异全部变红**（age 改用墙钟 / 空投影守卫失效 / basis 断链 / 句柄多出 approve 方法）与防假变异自检、跑完产品树字节不变；真 HTTP：两视角页面与 JSON 200、三条路由 `auth=none`、四道页面子导航含入口、页面 **0 行 `<script>` / 0 内联事件**、催办 POST **202** + 待办件**恰 0600** + 原话逐字 + 宿主账本零新增、真跑 `gate-nudge.py` 落 `gate/nudged`（body 恰 5 键、不含理由正文）且 `/api/status` 计数 **6 → 7**、幂等 `duplicates` + 账本零新增、拒绝路径 `gate-not-found`/`pending-tampered` 给 code | `tools/verify.sh ac AC-GATE-001` + `tools/verify.sh gates`（围栏门 + 真路由门） | 见 `evidence/EV-153` |
| AC-GATE-002 | P2 | **变更单逐行明细的口径与对账**（`gate-timeline` 规则 ⑤，正面回答 P-14「差额看不到明细、对账靠回忆」）：`change_detail(payload)` 对**同一张单**逐行给出 `line_id/desc/qty_before/unit_price_before/amount_before/qty_after/unit_price_after/amount_after/delta_amount/delta_pct/basis`（键集恰 11 键）+ 行小计与总计差额；**金额一律整数分**（`money_unit="cents"`），`amount = qty × unit_price`、`delta_amount = amount_after − amount_before`、`delta_pct` 由**整数分位 half-up**（远离零，`rounding="half-up-to-cent"`）算出、分母为 0 记 `null`（**不猜百分比**）；**缺依据不得编数**：缺原量/原价/新量/新价（或值不是整数件/整数分、或同一 `line_id` 重复）⇒ 列入 `basis_missing` 且**排除出小计**（页面/JSON 明说「未纳入小计的行」）；**整张单无任何可用行 ⇒ `degraded:true` + 有名 reason（`no-usable-lines`）+ 明细为空 + 小计三个数记 `null`**（不是 0），未知 id ⇒ `change-not-found` + `next_action`，非对象载荷 ⇒ `payload-not-an-object`（三个 reason 闭合且可区分）；确定性（两次逐字节一致 / 键序打乱一致 / **行顺序逆序**一致 / 跨实例一致 / 两个墙钟入口读都不读 / 冻结输入不抛错 / 输出无时间键）；有界（`max_items` 夹取 + 单张单读取上限 64 + 如实报 `omitted`/`lines_not_read`，**截断只影响展示、不改小计口径**）；**私域白名单两面都扫**：承包商侧看得见自己的私域列，供应商侧带哨兵与不带哨兵输出**逐字节一致**且哨兵与键名 0 命中（非空转对照）；围栏门真跑 `failures:0`、断言 ≥12，含 **4 处单点变异全部变红**（金额改用除法 / 缺依据行计入小计 / 私域列对全部视角回显 / 无可用行不判降级）与防假变异自检、跑完产品树字节不变；真 HTTP：`GET /quotagent/<view>/changes/<id>/`（SSR）与 `GET /quotagent/<view>/api/changes/<id>` 两视角 200、页面与 JSON 的数字与**手算的整数分**逐行一致、未知 id 页面与 JSON 都 **404 + `next_action`**、变更单列表每一行链到自己的明细页、四道页面子导航仍含入口、**0 行 `<script>` / 0 内联事件**、两条路由**只读**（GET 前后账本零新增） | `tools/verify.sh ac AC-GATE-002` + `tools/verify.sh change-detail`（围栏门 + 真路由门） | 见 `evidence/EV-154` |
| AC-AUTH-001 | P2 | **授权区间的判定、越界升级与诚实默认**：`check(payload)` 同输入两次**逐字节一致**（键序打乱/跨实例/墙钟入口读都不读/冻结输入不抛错/无时间键）；**三例边界值手算对账**（恰等于限额 500000/500000 ⇒ 在区间内、越界 0 分；超一分 500001 ⇒ 越界 1 分、要求角色升到 lead、出升级命令；差一分 499999 ⇒ 在区间内）；**未配置不得编限额**（角色没登记 / 限额 `null` / 快照缺失 / 单位非 `cents` ⇒ `unconfigured=true` + 有名 reason + `required_role`/`next_role` 空 + `inside_band=null`；`null` ≠ `0`）；**越界必出可复制的升级命令**（`tools/verify.sh gates` 真在 `verify.sh help` 里 + `g1side.py` 真存在）；**插件不能批准**（无审批类方法 + `can_approve=false`）；金额非法三类 ⇒ 具体 `code`+`next_action` 且不给结论；有界（`roles_omitted`/`truncated` 如实报）；私域哨兵 0 命中且带哨兵与不带哨兵**逐字节一致**；围栏门 22/22（4 处变异全红、还原字节一致）；真 HTTP：四条 200、三例与手算一致、**改配置前后同一金额结论不同**（临时配置；真 `config.yaml` 指纹不变）、未配置 ⇒ 角色字段空、只读（账本零新增）、0 内联脚本 | `tools/verify.sh authority` | 见 `evidence/EV-156` |

| AC-USREQ-006 | P2 | **cron 没待处理反馈时不得发垃圾消息**（`FR-USREQ-006`）：探测器 `tools/ui-feedback-monitor.sh` 同一状态下**两次运行（并换 TZ）逐字节一致**（否则「输出相同 ⇒ 调度器跳过」不成立）；**无时间/随机源**（静态扫 `$RANDOM`/`date`/`$$`/`$SECONDS`）；待办 0 时输出**恰一行 `pending=0`**、不含任何消息措辞；**非空转**：真造 2 条待办 ⇒ `pending=2` + ids，且待办变化输出**跟着变**；tick 的静默半边（`[ $n -eq 0 ] && exit 0` 在最后一条 echo 之前）。两态都在 `QUOTAGENT_ROOT` 指向的**隔离根**上真跑（不读源码猜、不动真 `tmp/ui-shared/`） | `tools/verify.sh ac AC-USREQ-006` | EV-159 |

## 7. 证据制度

1. 每条 AC 执行后，原始输出存 `docs/work/evidence/EV-<NNN>-<AC-ID>.txt`（追加头部：时间、
   命令、commit、退出码）。
2. `progress-checklist.md` 中该任务的 `evidence` 列指向 EV 编号。
3. **没有证据的 AC 不得标 passed**（AGENTS.md 规则 6）。
4. 门（G0/G1/G2）签署时，签署人只需核对证据文件存在且断言与结论一致。
