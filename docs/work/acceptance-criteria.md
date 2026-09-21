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
| AC-AUDIT-005 | P2 | 留存**执行侧**：派生副本销毁真的发生、账本落 `evidence/retention-copy-purged`（body 只出 target/sha256/bytes，不得含被销毁内容）、读侧封存后不可再读、越界路径与缺人工门批准一律拒绝且目标仍在、重复执行幂等（AC-AUDIT-003 管计划侧，本条管执行侧，两者合起来覆盖 FR-EVIDENCE-004） | `qa ac AC-AUDIT-005` | 见 `evidence/EV-088` |
| AC-NEGO-003 | P2 | 谈判轮次与让步（服务层）：正常链落 `negotiate/round`；越界/越限/越带宽被拒**且落**`negotiate/round-rejected`；缺人工门必拒且不落轮次；轮次上限从账本重建；`recompute` 逐字节可复现；同 `(thread_id, attempt_no)` 幂等或冲突；**不产生任何义务**；账本链仍真 | `qa ac AC-NEGO-003` | 见 `evidence/EV-092` |
| AC-FAQ-001 | P2 | 澄清 FAQ 的沉淀与复用（`FR-CLARIFY-004` 的机检）：同版本命中返回条目；**跨版本一律 `hit=false` 且不返回任何条目内容**（复用不得跨版本，AC-CLARIFY-004 的正面）；命中是纯读（不改票单/不改状态）；非 `human:` 发布被拒且不落 `entry-published`；跨 realm 条目不可见；私域键不进条目；`replay()` 可从账本重建 | `qa ac AC-FAQ-001` | 见 `evidence/EV-093` |
| AC-MAIL-001 | P2 | 邮件集成（无凭据部分）：`compose` 确定性且可被解析回来；头注入被拒**且不落账**；无传输实现时 `deliver()` 返回 `unavailable` + `reason` + `next_action` 并落 `mail/refused`，**账本无 `mail/sent`**；同键重复 `enqueue` 幂等；私域哨兵不进报文与账本；`text/*` 附件带 sha256、其它类型被拒；`parse` 纯函数且畸形输入不崩；跨 realm 候选不可见；`replay()` 可重建；不产生义务；账本链仍真 | `qa ac AC-MAIL-001` | 见 `evidence/EV-094` |
| AC-MAIL-002 | P2 | 结构性事实：transport/mail/只读视图/键白名单/门脚本五件齐备；未配置与连不上**各有专属 reason**（不是笼统失败）；异常消息洗过（redact/scrub）；邮件键已在白名单（≥6 条 ⇒ 配置 UI 可改并持久化）；宿主只读视图零写面且无 `<script>`；`verify.sh mail-transport` 已挂；视图模块可加载且导出预期符号 | `tools/verify.sh ac AC-MAIL-002` | EV-146 |
| AC-VIZ-001 | P2 | 比价 heuristics：改一个权重→**排名与得分必变**（权重敏感非空转）；权重越界夹取并回显、归一后和为一；**私域哨兵（reserve_price/cost_model/cost_floor/markup_pct/private:/bidders_private/authorized_band/internal_notes）在两视角页面与 JSON、以及换权重后的页面上命中 0 次**；有界报 `omitted`、降级有 reason；宿主零写面；新页面**仍 0 行内联脚本** | `tools/verify.sh ac AC-VIZ-001` + `tools/verify.sh bid-heuristics` | EV-147 |
| AC-PIPELINE-001 | P2 | 运维道可见 P2 新服务：`pipeline-view` 只组合不自算、降级优先、有界、确定性、零 I/O、不出正文与私域；`GET /api/pipeline` 200 且含谈判/FAQ/邮件三域，`transport.available=false`（本轮无发信能力只能这么报） | `tools/verify.sh pipeline-route` | 见 `evidence/EV-095` |
| AC-UIFB-001 | P2 | 见 EV-148（0600 待办件 / 横幅两方向 / 幂等 / 三拒绝码） | `tools/verify.sh ui-feedback` | EV-148 |
| AC-UI-002 | P2 | 运维快照写入器（Python 侧）形状合规：两视角齐全、删不掉 `generated_at` 之外的时间键、无私域与正文、**只读账本（不新增行）**、同输入两次除 `generated_at` 外一致 | `qa ac AC-UI-002` | 见 `evidence/EV-095` |
| AC-UI-003 | P2 | UI 演示种子（`tools/ui-seed-pipeline.py`）：用**真服务**种出三域事件且 `added>0`；**再跑幂等**（`added==0` 且账本逐字节不变）；快照里两视角三域计数**全部非 0**（面板不是空面板）；写入者一律 `human:ui-seed`/`agent:ui-seed`（不冒充业务主体） | `tools/verify.sh ui-seed` | 见 `evidence/EV-096` |
| AC-ADMIN-001 | P2 | 第四道未提权不出内容：`/quotagent/admin/`、`/admin/api/blocks`、`/admin/api/session` 三路在无 token 且无会话时 401，body 逐字节等于固定体 `{"error":"unauthorized"}`（与未知子路径同形），响应里搜不到任何 block_id/计数/面板字段；同进程内三道行为不变（webui 回归绿） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-002 | P2 | 提权端点契约：`POST /quotagent/admin/api/elevate` 用正确 token → 200 且 `Set-Cookie` 为 `HttpOnly; SameSite=Strict; Path=/quotagent/admin` 的不透明随机 id（≥128 bit，非 token 派生）；响应体与页面里搜不到 token；提权前后账本零变化（宿主不写账本） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-003 | P2 | 切视角不改字段面：`GET /admin/api/switch?to=supplier` → 302 到 `/quotagent/supplier/`；已提权会话下 `/supplier/` 与 `/supplier/api/events` 的响应与同夹具**未提权**请求逐字节相同（管理员身份不得成为看到私域键的新路径） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-004 | P2 | 面板是真数据：阻塞清单由 Python 判定器从**真来源**（任务登记表 blocked 行 + 服务自述不可用原因）生成，至少 2 条且 kind 含 `plugin-request`（Jev 建议层）与 `credential`（邮件缺 SMTP/IMAP 凭据）；计数只读、标注口径来源、不得由列表长度推计数（D-056）；快照幂等且不含正文与私域键；源缺失/损坏 → 降级不崩不猜 | `tools/verify.sh ac AC-ADMIN-004` | 见 `evidence/EV-132` |
| AC-ADMIN-006 | P2 | 状态机与唯一写者（Python 侧）：只接受 `blocked→pending→resolved/rejected/expired`；非法转移（跳过 pending、回退、自环等）全部拒绝且账本零新增；合法转移产出 `admin/block-*` 事件载荷且**必须带 `human:` 批准引用**（人工门不可绕过）；时钟推后任意时长结果字节不变（不存在超时自动批准） | `tools/verify.sh ac AC-ADMIN-006` | 见 `evidence/EV-132` |
| AC-ADMIN-007 | P2 | 粒度与无暗门：会话过期后 `/admin/*` 回到统一拒绝体、切换失效，但已 resolved 的阻塞与账本不受影响；会话有效但写类提交不带 token → 401；把时钟推过任意时长 → 阻塞仍 blocked、账本无 resolved 行（源码级 + 行为双证「无超时即成功」分支） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-008 | P2 | 失败不泄露 + 有界退避：缺 token / 错 token / 会话过期 / 管理道未启用 / 冷却中 五类响应**逐字节相同**；日志尾部搜不到正确 token；连续失败 5 次进入冷却，冷却期内正确 token 也拒、冷却结束不自动提权、冷却不产生任何面板内容或提交写入 | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-009 | P2 | 反例（机检）：①无 token 调提权端点 → 拒绝且无会话 cookie；②以「接近正确」的三种 token 提权 → 一律拒绝，响应体不含所提交 token、不含正确 token、无 oracle；③被拒后 `/admin/api/blocks` 仍 401 | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-010 | P2 | token 存储与校验（服务端）：只从环境变量或 0600 文件读（0644 文件被拒 = file-insecure-mode；缺失 = 未启用）；先 sha256 归一再用恒定时间比较定长摘要（**源码级**断言无前缀/切片比较）；token 与其摘要（连前 8 位）在响应、快照、日志、页面四处均搜不到 | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
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

| AC-ADV-001 | P2 | **决策建议层的确定性、溯源与诚实**：`advise(payload)` 对同一份白名单载荷**两次逐字节一致**（且与入参键序/条目顺序无关、跨实例一致、输出无时间键）；每条建议 `basis` **非空**且每个 token 都解析回载荷真键（`as_of` 或 `<段>[<id>].<键>`，四种篡改必须判假）；输出恒带 `engine="rules"` + 「不含模型推测」文案 + `privacy`（model_calls=0 / network_calls=0 / private_keys_read=false）；**空投影 → `degraded:true` + 有名 reason + `items:[]`**（「载荷不能用」与「数据齐但无可建议项」两个 reason 可区分，且**不抛错**）；有界（`max_items` 夹取 + `shown + omitted = generated`）；私域哨兵 0 命中且**带哨兵与不带哨兵逐字节一致**；围栏门真跑 `failures:0`、断言 ≥14，含 **4 处单点变异全部变红**（有界 / 空数据守卫 / basis 断链 / engine 篡改）与防假变异自检、跑完产品树字节不变；真 HTTP：两视角页面与 JSON 200、四道页面子导航含入口、页面 **0 行 `<script>` / 0 内联事件**、**两视角建议不同**、同一 URL 两次逐字节一致 | `tools/verify.sh ac AC-ADV-001` + `tools/verify.sh advice`（围栏门 + 真路由门） | 见 `evidence/EV-150` |
| AC-GATE-001 | P2 | **「审批等多久 / 变更单谁卡着」的口径、溯源与诚实**：`timeline(payload)` 对同一份载荷**两次逐字节一致**（键序/条目逆序/跨实例都一致、输出无时间键）；**等待时长不来自墙钟** —— 两个墙钟入口（`payload.now`/`config.now`）各给两个不同值，输出**逐字节不变**且 `age_seconds` 等于手算 `as_of − requested 事实 ts`（已 granted/denied/aborted 的门**不进**等待列表）；每条门键集恰 9 键、带非空 `age_basis` 与 `consequence`（三种超时策略各自说清，**没有"会批准"这种话**）；**每条变更单带非空 `basis`** 且每个 token 解析回载荷真键（不存在的 ref/键/坏形状/空 basis/不存在的事件类型五种篡改必须判假）；`owed_by` 用队列里的真审批人、没有就 `human:unassigned`（不编人名）；**插件不能批准**（句柄方法恰 `config|meta|nudge|requests|timeline`、无审批类方法、`meta.can_approve=false`、催办载荷 `requested_action="nudge"` 且记录里无审批字段）；**空投影 → `degraded:true` + 有名 reason + 两列表为 0** 且不抛错（"载荷不能用"与"数据齐但无可报项"两个 reason 可区分）；有界（两段各自截断 + `omitted` + `max_items` 夹取）；私域哨兵 0 命中且**带哨兵与不带哨兵逐字节一致**；围栏门真跑 `failures:0`、断言 ≥14，含 **4 处单点变异全部变红**（age 改用墙钟 / 空投影守卫失效 / basis 断链 / 句柄多出 approve 方法）与防假变异自检、跑完产品树字节不变；真 HTTP：两视角页面与 JSON 200、三条路由 `auth=none`、四道页面子导航含入口、页面 **0 行 `<script>` / 0 内联事件**、催办 POST **202** + 待办件**恰 0600** + 原话逐字 + 宿主账本零新增、真跑 `gate-nudge.py` 落 `gate/nudged`（body 恰 5 键、不含理由正文）且 `/api/status` 计数 **6 → 7**、幂等 `duplicates` + 账本零新增、拒绝路径 `gate-not-found`/`pending-tampered` 给 code | `tools/verify.sh ac AC-GATE-001` + `tools/verify.sh gates`（围栏门 + 真路由门） | 见 `evidence/EV-153` |

## 7. 证据制度

1. 每条 AC 执行后，原始输出存 `docs/work/evidence/EV-<NNN>-<AC-ID>.txt`（追加头部：时间、
   命令、commit、退出码）。
2. `progress-checklist.md` 中该任务的 `evidence` 列指向 EV 编号。
3. **没有证据的 AC 不得标 passed**（AGENTS.md 规则 6）。
4. 门（G0/G1/G2）签署时，签署人只需核对证据文件存在且断言与结论一致。
