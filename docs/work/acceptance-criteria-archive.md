# 验收标准归档 A（较早的一批；主文件在 `acceptance-criteria.md`）

<!-- budget: 32 KB（与主文件同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

本文件是 `docs/work/acceptance-criteria.md` 的归档。**主文件仍是契约正文**（运行器契约、当前阶段的
AC 行与证据制度都在那里）。**归档不是豁免区**：

- **门的口径**：`AC-<域>-<NNN>` 的定义可以落在主文件，也可以落在本文件（以及同目录下任何
  `acceptance-criteria-archive*.md`）。`docs/work/acceptance-criteria.md` + 这些归档 = 门的
  **AC 定义集合**；`tools/check-docs.py` 按该集合判 ID 完整性、预算与 FR↔AC 覆盖，
  `tools/check-ac-registry.py` 按同一集合判「**phase 恰为 P0** 的 AC 必须已在 `qa list` 注册」。
- **搬进归档的行仍受全部断言约束**：ID 引用必须解析、文件必须在预算内、不得是孤儿 AC、
  P0 行仍必须注册。门的输出里会打印它读了哪些归档（`archives=[...]`），并**断言归档文件确实被读到**
  （归档 0 条 AC 行即判失败），所以"归档"不可能是绕过校验的后门。
- **逐字搬走**：下面每一行与它在主文件里时**逐字节相同**（含证据引用与命令），只换了所在文件。

**选入规则**（可复核）：主文件里 phase **不为 `P0`**、且由 git 引入时间 **≤ 2026-09-21T10:46:22Z**
的 AC 行，按引入时间升序（同批保持原文件行序）整行搬入。**`P0` 行一律留在主文件**（最保守）；
`AC-NEGO-001` 因 `docs/design/17-negotiation-contract.md` 明文「不得修改」而留主文件；
`AC-DESIGN-001..003`（文档门自身的判据、主文件 §1 散文逐条点名）留主文件。

## 2. 内核（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-AUDIT-003 | P2 | 销毁策略生效后目标事件不可再读且销毁动作本身有账本事件 | `qa ac AC-AUDIT-003` |
| AC-AUDIT-004 | P1 | 审计包带签名与包含证明，且能用独立入口（不接触原账本）验证：篡改任一字段即失败、错误密钥即失败、无签名包在 `--require-signature` 下失败并给出定位 | `qa ac AC-AUDIT-004`（入口 `tools/verify.sh audit`） |
| AC-PLUGIN-003 | P1 | 更新配置时否决者生效：配置未变、插件未重启 | `qa ac AC-PLUGIN-003` |
| AC-QEP-003 | P1 | 人为丢包造成 `seq` 空洞时，依赖该序号的跃迁被挂起并发出重发请求 | `qa ac AC-QEP-003` |
| AC-QEP-004 | P1 | 版本交集为空时通信被拒绝且落 `kernel/qep-rejected`；特性降级有账本事件 | `qa ac AC-QEP-004` |
| AC-SYNC-001 | P1 | 双方修改同一非承诺字段 → 按权威方合并；修改承诺字段 → 挂起转人工；两种情况均留痕 | `qa ac AC-SYNC-001` |

## 3. 归一化与比价（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-COMPARE-004 | P1 | 导出的比较表与账本数据一致（逐行核对），含 Flag 与差异说明 | `qa ac AC-COMPARE-004` |

## 4. 澄清、审批与护栏（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-CLARIFY-002 | P1 | 答案广播名单缺少任一在册投标人 → 工单不得关闭（INV-006） | `qa ac AC-CLARIFY-002` |
| AC-CLARIFY-003 | P1 | 包升版后相关工单自动重开，且旧答案标记为"针对旧版本" | `qa ac AC-CLARIFY-003` |
| AC-CLARIFY-004 | P2 | FAQ 命中不影响回答的版本绑定（复用不得跨版本） | `qa ac AC-CLARIFY-004` |
| AC-APPROVE-003 | P1 | 待批期间 agent 可继续其他工作；超时策略三选一生效且**不存在自动批准** | `qa ac AC-APPROVE-003` |
| AC-GUARD-001 | P0/P1 | 异常低价与漏项样本被标 Flag，且 Flag 不改变排序或状态（只标注） | `qa ac AC-GUARD-001` |
| AC-GUARD-002 | P1 | 产能冲突与条款冲突样本被标 Flag 并提请人工 | `qa ac AC-GUARD-002` |

## 5. 承包商侧与供应商侧（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-RFQ-003 | P1 | 分发记录可回答"谁在何时收到哪个版本" | `qa ac AC-RFQ-003` |
| AC-RFQ-004 | P1 | 包升版后基于旧版本的报价被标记为过期（`stale` + 旧/新版本号、可审计不清除），不进入排序（`compare` 输出里以 `quote_superseded` 显式排除），并产生重报请求 | `qa ac AC-RFQ-004` |
| AC-CAP-001 | P1 | `firm` 交期在有效期内不可由模型变更；冲突只提请人工 | `qa ac AC-CAP-001` |
| AC-TERMS-001 | P1 | 条款冲突被标注并提请人工，不静默取其一 | `qa ac AC-TERMS-001` |
| AC-AWARD-001 | P0/P1 | 缺供应商确认或缺人工签署时，`commit` 抛错；意向可撤回且无义务 | `qa ac AC-AWARD-001` |
| AC-AWARD-002 | P1 | PO 只能由承诺派生；手工构造 PO 被拒绝 | `qa ac AC-AWARD-002` |
| AC-CHANGE-001 | P1 | 变更请求必须引用原报价条目与单价基准，缺引用即拒绝 | `qa ac AC-CHANGE-001` |
| AC-CHANGE-002 | P1 | 变更差额可按原单价复算；未经批准的变更不影响任何金额 | `qa ac AC-CHANGE-002` |

## 6. 评测与自进化（搬自主文件同名节）

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-EVAL-001 | P0/P1 | 同输入重放两次结果完全一致（确定性）；S1..S4 全绿 | `qa suite s1..s4` |
| AC-EVOLVE-001 | P2 | 提案含全部必填字段；影子重放产出指标对比 | `qa ac AC-EVOLVE-001` |
| AC-EVOLVE-002 | P2 | 门五条同时满足才放行；任一不满足则拒绝晋升 | `qa ac AC-EVOLVE-002` |
| AC-EVOLVE-003 | P2 | 对 `kernel/*` 的 patch 被拒绝（INV-010）；canary 越界触发自动回滚且 effect 全回收 | `qa ac AC-EVOLVE-003` |
| AC-EVOLVE-004 | P2 | 同类提案第三次失败后必须转人工（不再自动重试） | `qa ac AC-EVOLVE-004` |
| AC-INTEG-002 | P1 | relay 不解析 body（对其注入篡改会被验签发现）；relay 不可达时排队重试 | `qa ac AC-INTEG-002` |
| AC-INTEG-004 | P1 | 桥的协议与版本协商：内核首帧自述能力清单（与 Python 声明表一致）；只暴露 read/compute；版本不兼容→退出码 2 且账本零新增；降级留痕；确定性错误码 + `next_action`；stdout 只有协议帧 | `qa ac AC-INTEG-004`（入口 `tools/verify.sh bridge`） |
| AC-INTEG-005 | P1 | 承诺面不可达（对抗性）：宿主调 commit 面被拒且落 `kernel/bridge-rejected`；宿主播报 `human:*` 被拒（身份由内核注入）；`fact` 面默认关闭；read/compute 仍可用 | `qa ac AC-INTEG-005` |
| AC-INTEG-006 | P1 | 桥的故障语义：SIGKILL 后哈希链仍真且 durable 零丢失、重启留痕；在途请求记 unknown；重启预算 3/30s 超限降只读（只关 fact/commit）；背压丢 live 必留痕（计数 + 时间窗）且 durable 可补齐；锚点不在链中→`kernel/bridge-fault` + 只读；无孤儿；启动失败退出码 3 且账本零新增 | `qa ac AC-INTEG-006`（入口 `tools/verify.sh bridge`） |
| AC-INTEG-003 | P2 | 邮件发送失败不落账为"已发送"（账实一致） | `qa ac AC-INTEG-003` |
| AC-TRUST-001 | P0/P1 | 对方私域字段在本侧投影、模型输入、视图中三处均不存在（INV-008） | `qa ac AC-TRUST-001` |

| ID | 阶段 | 断言 | 命令 | 证据 |
|---|---|---|---|---|
| AC-RUNTIME-003 | P2 | FR-RUNTIME-003：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（audit-hook 门 7/7） | 见 `evidence/EV-068` |
| AC-RUNTIME-004 | P2 | FR-RUNTIME-004：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（budget-guard 门 10/10 + budget-route 门 5/5） | 见 `evidence/EV-085` |
| AC-RUNTIME-005 | P2 | FR-RUNTIME-005：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（breaker 门 10/10 + breaker-route 门 4/4） | 见 `evidence/EV-077` |
| AC-RUNTIME-006 | P2 | FR-RUNTIME-006：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（governor 门 9/9） | 见 `evidence/EV-067` |
| AC-RUNTIME-007 | P2 | FR-RUNTIME-007：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（observability 门 6/6） | 见 `evidence/EV-071` |
| AC-RUNTIME-008 | P2 | FR-RUNTIME-008：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（modules 门 248/248） | 见 `evidence/EV-038` |
| AC-RUNTIME-009 | P2 | FR-RUNTIME-009：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（idempotency-guard 门 10/10 + idem-route 门 5/5） | 见 `evidence/EV-083` |
| AC-EVIDENCE-003 | P2 | FR-EVIDENCE-006：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（evolve-module 追溯门 11/11 + webui 21/21） | 见 `evidence/EV-075` |
| AC-EVOLVE-005 | P2 | FR-EVOLVE-007：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（evolve-journal 门 7/7） | 见 `evidence/EV-080` |
| AC-PRICE-002 | P2 | FR-PRICE-003：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（evolve-module 追溯门 11/11 + webui 21/21） | 见 `evidence/EV-073` |
| AC-RFQ-005 | P2 | FR-RFQ-007：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（modules 门 248/248） | 见 `evidence/EV-039` |
| AC-EVAL-003 | P2 | FR-EVAL-005：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（supplier-scorecard 门 10/10 + webui 21/21） | 见 `evidence/EV-082` |
| AC-RUNTIME-010 | P2 | FR-UX-004：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（ops-view 门 9/9 + webui 21/21） | 见 `evidence/EV-079` |
| AC-PLUGIN-004 | P2 | FR-PLUGIN-004：上条 FR 的机检断言（由对应围栏门与端到端门覆盖） | `tools/verify.sh`（coverage 门 + plugins 门 + evolve-module 门） | 见 `evidence/EV-086` |

## 7. 第二批搬运（批次 B；搬自主文件 §6「评测与自进化」）

<!-- 选入规则（批次 B，可复核）：主文件里 phase **不为 `P0`**、且由 git 引入时间
     ≤ 2026-09-21T13:55:02Z 的 AC 行，按引入时间升序（同批保持原文件行序）整行搬入；
     **搬到主文件 ≤ 28 KiB（28×1024 = 28672 B）之下**并为本批新增 AC 行留出余量即停。
     `P0` 行一律留主文件（与批次 A 同一套纪律）。逐字搬走：下面每一行与它在主文件里时**逐字节相同**。 -->

| ID | 阶段 | 断言 | 命令 |
|---|---|---|---|
| AC-AUDIT-005 | P2 | 留存**执行侧**：派生副本销毁真的发生、账本落 `evidence/retention-copy-purged`（body 只出 target/sha256/bytes，不得含被销毁内容）、读侧封存后不可再读、越界路径与缺人工门批准一律拒绝且目标仍在、重复执行幂等（AC-AUDIT-003 管计划侧，本条管执行侧，两者合起来覆盖 FR-EVIDENCE-004） | `qa ac AC-AUDIT-005` | 见 `evidence/EV-088` |
| AC-NEGO-003 | P2 | 谈判轮次与让步（服务层）：正常链落 `negotiate/round`；越界/越限/越带宽被拒**且落**`negotiate/round-rejected`；缺人工门必拒且不落轮次；轮次上限从账本重建；`recompute` 逐字节可复现；同 `(thread_id, attempt_no)` 幂等或冲突；**不产生任何义务**；账本链仍真 | `qa ac AC-NEGO-003` | 见 `evidence/EV-092` |
| AC-FAQ-001 | P2 | 澄清 FAQ 的沉淀与复用（`FR-CLARIFY-004` 的机检）：同版本命中返回条目；**跨版本一律 `hit=false` 且不返回任何条目内容**（复用不得跨版本，AC-CLARIFY-004 的正面）；命中是纯读（不改票单/不改状态）；非 `human:` 发布被拒且不落 `entry-published`；跨 realm 条目不可见；私域键不进条目；`replay()` 可从账本重建 | `qa ac AC-FAQ-001` | 见 `evidence/EV-093` |
| AC-MAIL-001 | P2 | 邮件集成（无凭据部分）：`compose` 确定性且可被解析回来；头注入被拒**且不落账**；无传输实现时 `deliver()` 返回 `unavailable` + `reason` + `next_action` 并落 `mail/refused`，**账本无 `mail/sent`**；同键重复 `enqueue` 幂等；私域哨兵不进报文与账本；`text/*` 附件带 sha256、其它类型被拒；`parse` 纯函数且畸形输入不崩；跨 realm 候选不可见；`replay()` 可重建；不产生义务；账本链仍真 | `qa ac AC-MAIL-001` | 见 `evidence/EV-094` |
| AC-PIPELINE-001 | P2 | 运维道可见 P2 新服务：`pipeline-view` 只组合不自算、降级优先、有界、确定性、零 I/O、不出正文与私域；`GET /api/pipeline` 200 且含谈判/FAQ/邮件三域，`transport.available=false`（本轮无发信能力只能这么报） | `tools/verify.sh pipeline-route` | 见 `evidence/EV-095` |
| AC-UI-002 | P2 | 运维快照写入器（Python 侧）形状合规：两视角齐全、删不掉 `generated_at` 之外的时间键、无私域与正文、**只读账本（不新增行）**、同输入两次除 `generated_at` 外一致 | `qa ac AC-UI-002` | 见 `evidence/EV-095` |
| AC-ADMIN-001 | P2 | 第四道未提权不出内容：`/quotagent/admin/`、`/admin/api/blocks`、`/admin/api/session` 三路在无 token 且无会话时 401，body 逐字节等于固定体 `{"error":"unauthorized"}`（与未知子路径同形），响应里搜不到任何 block_id/计数/面板字段；同进程内三道行为不变（webui 回归绿） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-002 | P2 | 提权端点契约：`POST /quotagent/admin/api/elevate` 用正确 token → 200 且 `Set-Cookie` 为 `HttpOnly; SameSite=Strict; Path=/quotagent/admin` 的不透明随机 id（≥128 bit，非 token 派生）；响应体与页面里搜不到 token；提权前后账本零变化（宿主不写账本） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-003 | P2 | 切视角不改字段面：`GET /admin/api/switch?to=supplier` → 302 到 `/quotagent/supplier/`；已提权会话下 `/supplier/` 与 `/supplier/api/events` 的响应与同夹具**未提权**请求逐字节相同（管理员身份不得成为看到私域键的新路径） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-004 | P2 | 面板是真数据：阻塞清单由 Python 判定器从**真来源**（任务登记表 blocked 行 + 服务自述不可用原因）生成，至少 2 条且 kind 含 `plugin-request`（Jev 建议层）与 `credential`（邮件缺 SMTP/IMAP 凭据）；计数只读、标注口径来源、不得由列表长度推计数（D-056）；进度数字里的 `phase`/`next_task` **与真源 `.agents/state.json` 逐字比**（判据里**不写死阶段名**：把真源 `phase` 换成另一个值，输出必须跟着换 —— 硬编码阶段名的判据在这条下必红）；快照幂等且不含正文与私域键；源缺失/损坏 → 降级不崩不猜 | `tools/verify.sh ac AC-ADMIN-004` | 见 `evidence/EV-132` |
| AC-ADMIN-006 | P2 | 状态机与唯一写者（Python 侧）：只接受 `blocked→pending→resolved/rejected/expired`；非法转移（跳过 pending、回退、自环等）全部拒绝且账本零新增；合法转移产出 `admin/block-*` 事件载荷且**必须带 `human:` 批准引用**（人工门不可绕过）；时钟推后任意时长结果字节不变（不存在超时自动批准） | `tools/verify.sh ac AC-ADMIN-006` | 见 `evidence/EV-132` |
| AC-ADMIN-007 | P2 | 粒度与无暗门：会话过期后 `/admin/*` 回到统一拒绝体、切换失效，但已 resolved 的阻塞与账本不受影响；会话有效但写类提交不带 token → 401；把时钟推过任意时长 → 阻塞仍 blocked、账本无 resolved 行（源码级 + 行为双证「无超时即成功」分支） | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-008 | P2 | 失败不泄露 + 有界退避：缺 token / 错 token / 会话过期 / 管理道未启用 / 冷却中 五类响应**逐字节相同**；日志尾部搜不到正确 token；连续失败 5 次进入冷却，冷却期内正确 token 也拒、冷却结束不自动提权、冷却不产生任何面板内容或提交写入 | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-009 | P2 | 反例（机检）：①无 token 调提权端点 → 拒绝且无会话 cookie；②以「接近正确」的三种 token 提权 → 一律拒绝，响应体不含所提交 token、不含正确 token、无 oracle；③被拒后 `/admin/api/blocks` 仍 401 | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |
| AC-ADMIN-010 | P2 | token 存储与校验（服务端）：只从环境变量或 0600 文件读（0644 文件被拒 = file-insecure-mode；缺失 = 未启用）；先 sha256 归一再用恒定时间比较定长摘要（**源码级**断言无前缀/切片比较）；token 与其摘要（连前 8 位）在响应、快照、日志、页面四处均搜不到 | `tools/verify.sh admin-route` | 见 `evidence/EV-132` |

