# 功能需求归档 B（2026-09-22 批次；主文件在 `functional-requirements.md`，批次 A 在 `functional-requirements-archive.md`）

<!-- budget: 32 KB（与主文件同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

本文件是 `docs/work/functional-requirements.md` 的**第二份归档**（口径与归档 A 相同：主文件 + 同目录
`functional-requirements-archive*.md` = 门的 **FR 定义集合**；归档不是豁免区 —— ID 完整性、预算、
FR↔AC 无孤儿照查，`tools/check-fr-coverage.py` 的覆盖矩阵同样逐条覆盖）。`tools/check-docs.py`
会打印 `fr_archives=[...]`，并对「归档 0 条 FR 定义行」判失败。

**选入规则**（可复核）：主文件里 阶段**不为 `P0`**、且 git 引入时间落在
**`2026-09-21T04:34:36Z` < t ≤ `2026-09-21T15:33:47Z`** 的 FR 行（`git log --reverse -p` 每条 FR
首次出现的时间；下界就是归档 A 的上界 ⇒ 两份归档不重不漏），按主文件原行序**整行逐字**搬入本文件。
例外（留主文件；均为本批 12 条用户诉求的既有载体行或合同保护行）：
`FR-NEGO-001`/`FR-NEGO-002`（`docs/design/17-negotiation-contract.md` 明文「FR 原文不动」）、
`FR-EVOLVE-007`（自进化在 UI 可见）、`FR-USERPLUG-010`（提权为系统级插件）。
本批用户诉求的可追溯表（`docs/work/requirements-traceability.md`）引用到 `FR-UX-004`/`FR-UX-005`、
`FR-MARKET-*`、`FR-AGENTRT-*` 时，其定义处就是本文件（不是主文件）。
`P0` 行一律留主文件（最保守）；`V-001..V-012`（§1 验证清单）不搬 —— `V-` 只认主文件。

## 6. 协作与治理（搬自主文件同名节）

| ID | 需求 | 优先级 | 阶段 | 关联 AC |
|---|---|---|---|---|
| FR-RUNTIME-003 | 提供宿主运行期决策留痕：按事件前缀订阅、有界环形流水、去重键与账本同形；**不写账本、不写文件** | must | P2 | AC-RUNTIME-003 |
| FR-RUNTIME-004 | 提供运行期窗口成本预算准入：整数微元记账、窗口滚动、超预算拒绝**可解释**（区分"等窗口有用"与"等也没用"） | must | P2 | AC-RUNTIME-004 |
| FR-RUNTIME-005 | 提供运行期熔断：连续失败达阈值即快速失败，冷却后半开有界试探，拒绝带状态与重试时间 | must | P2 | AC-RUNTIME-005 |
| FR-RUNTIME-006 | 提供运行期准入与等待：可解释的限流/背压拒绝、显式超时（超时是错误不是静默重试）、有界重试、判定不依赖墙钟 | must | P2 | AC-RUNTIME-006 |
| FR-RUNTIME-007 | 提供运行期观测的**只读聚合**（准入/留痕/分流三源合一）：只给聚合数字与阶段，不出条目正文、不写账本 | must | P2 | AC-RUNTIME-007 |
| FR-RUNTIME-008 | 提供按 realm 的**有界**事件时间线（幂等去重、卸载即注销、零残留），供 UI 与排障读取 | must | P2 | AC-RUNTIME-008 |
| FR-RUNTIME-009 | 提供运行期请求**幂等判重**：同请求不重复打下游；失败结果是 replay 而非复用成成功 | must | P2 | AC-RUNTIME-009 |
| FR-EVIDENCE-006 | 提供账本证据面的只读统计（按类型计数、关联数、带引用行数、时间跨度），只输出计数不输出正文 | must | P2 | AC-EVIDENCE-003 |
| FR-PRICE-003 | 提供按供应商的历史价格描述统计（次数、最低/中位/最高、最新、离散趋势），只读且**不参与决策** | must | P2 | AC-PRICE-002 |
| FR-RFQ-007 | 提供按采购包的应标覆盖率与缺口清单（未应标名单、低于下限的包、临期/逾期包），只读且**不猜名单** | must | P2 | AC-RFQ-005 |
| FR-EVAL-005 | 提供按供应商的绩效记分卡（次数、价格分布、交期均值、偏差标记），只读且**不产出评分或排名** | must | P2 | AC-EVAL-003 |
| FR-UX-004 | 提供运维视角的只读快照（中间件状态 + 熔断 + 证据面聚合 + 人可读摘要），**不属于任何一方**、不出正文与私域键 | must | P2 | AC-RUNTIME-010 |
| FR-UX-005 | 提供运维快照的定期落盘（谈判/FAQ/邮件三域计数与最近事件），供宿主**只读**展示；快照不得含正文与私域键，且不含 `generated_at` 之外的时间键 | must | P2 | AC-UI-002 、AC-UI-003 |
| FR-ADMIN-001 | 新增第四道 UI 道 `/quotagent/admin/`（系统管理）：未提权时不得输出任何面板内容，只给与失败同形的统一拒绝体 | should | P2 | AC-ADMIN-001 |
| FR-ADMIN-002 | 任一道 UI 都提供管理员 token 提权入口；token 只经当次表单请求体提交，不回显、不写前端存储、不进 HTML/JS、不入账本、不出现在 URL 与日志 | should | P2 | AC-ADMIN-002 |
| FR-ADMIN-003 | 提权后可切换到任意一道 UI（含回切）；切换只改导航与道可见性，不改变任何字段白名单——管理员身份不得成为看到私域键的新路径 | should | P2 | AC-ADMIN-003 |
| FR-ADMIN-004 | 系统管理面板可见 agent 进度与阻塞（含插件需求与缺凭据两类），清单由 Python 判定器从真来源生成，计数只读并标注口径 | should | P2 | AC-ADMIN-004 |
| FR-ADMIN-006 | 阻塞状态机只允许 `blocked→pending→resolved/rejected/expired`，转移只能由 Python 侧写账本产生；宿主只读；非法转移一律拒绝且不留部分效果 | must | P2 | AC-ADMIN-006 |
| FR-ADMIN-007 | 提权粒度两档：会话级决定道可见性与切换，请求级决定一切写类提交（缺 token 即拒）；两档都无超时自动批准/自动解除，过期只减权不增权 | must | P2 | AC-ADMIN-007 |
| FR-ADMIN-008 | 提权失败一律统一响应（缺 token/错 token/过期会话/未启用/冷却五类同形），不含 token 及其可逆派生；连续失败达阈值进入有界冷却，冷却期不产生任何成功 | must | P2 | AC-ADMIN-008 |
| FR-ADMIN-009 | 反例：无 token 不得提权；非 admin token 一律被拒且不泄露（无 oracle）；被拒不产生会话，也不在宿主留下任何提交文件 | must | P2 | AC-ADMIN-009 |
| FR-ADMIN-010 | token 校验只在服务端：来源限于环境变量或 0600 文件，先 sha256 归一再用恒定时间比较；token 不得出现在 HTML/JS 响应、快照文件、账本行与宿主日志四处 | must | P2 | AC-ADMIN-010 |
| FR-ADMIN-005 | 阻塞可在 UI 内解除：提交落为宿主侧「待处理项」（0600），由 Python 侧消费并落账完成；**提交瞬间宿主侧账本零新增**，宿主永不写账本 | should | P2 | AC-ADMIN-005 |
| FR-MARKET-001 | 插件列表本身由插件提供：只读聚合三真源（目录/清单/用户空间），逐项给 source 与 wired；未装配显式 unwired 不得隐藏；空列表报 degraded | must | P2 | AC-MARKET-001、AC-MARKET-006 |
| FR-MARKET-002 | 市场目录与已装载项必须分开；未过门/未晋升产物不得进"可安装项"；每条可安装带 install_ref，无引用一律拒 | must | P2 | AC-MARKET-002 |
| FR-MARKET-003 | 三源不一致即报 inconsistent + 逐项差异，不得取其一静默 | must | P2 | AC-MARKET-003 |
| FR-MARKET-004 | 市场只读零副作用：不装载/不下载/不写文件/不起子进程/不写账本；"安装/提权"只产指向既有门的引用 | must | P2 | AC-MARKET-004 |
| FR-MARKET-005 | 有界且确定性：条数上界、稳定排序、不含正文与私域键；超界截断并报被丢条数 | should | P2 | AC-MARKET-005 |
| FR-MARKET-006 | 不可用不得伪装：degraded + reason + next_action，不得返回"看起来健康的零插件清单" | must | P2 | AC-MARKET-006 |
| FR-USERPLUG-002 | 写面只有 `user-space/<ns>/<plugin>/`：写 `host/modules/`、`src/`、`tools/`、别人 ns、仓库外一律拒且目标不存在 | must | P2 | AC-USERPLUG-002、AC-USERPLUG-012 |
| FR-USERPLUG-003 | 自动重载：产物/清单变化只重载该插件（pid 不变、新 uid），不迁移旧内存状态 | must | P2 | AC-USERPLUG-003 |
| FR-USERPLUG-004 | 自动卸载零残留：effects 归零、不影响其它用户空间与平台插件 | must | P2 | AC-USERPLUG-004 |
| FR-USERPLUG-006 | 隔离四件套：独立 instance / 独立服务命名空间（含保留名禁用）/ 独立文件根（挂载期绑定）/ 独立凭据作用域 | must | P2 | AC-USERPLUG-006 |
| FR-USERPLUG-007 | 四类反例必须结构性拒绝并留痕（写别人目录 / 跨 instance 共享状态 / 未提权被他人加载 / 无凭据自称已连接） | must | P2 | AC-USERPLUG-007 |
| FR-USERPLUG-008 | 管理本身也是插件（list/load/unload/reload/请求/提权请求）；卸载管理面后已装载插件照常运行，新装载被拒且不伪装成功 | must | P2 | AC-USERPLUG-008 |
| FR-USERPLUG-009 | 不耦合进平台：不得改内核/服务层与已晋升产物，只能经已登记服务面 inject；未登记服务名即拒 | must | P2 | AC-USERPLUG-009 |
| FR-USERPLUG-011 | 未提权不可被他人加载（跨 ns → `user-plugin-not-elevated` 且未载入） | must | P2 | AC-USERPLUG-011 |
| FR-USERPLUG-012 | 两个方向都封死：自进化 target→`user-space/` 拒；用户空间 target→`host/modules/` 拒 | must | P2 | AC-USERPLUG-012 |
| FR-USERPLUG-001 | 自然语言需求 → 产出用户空间插件 → **完成即自动进列表**（无人工搬运）；真源 `user-space/<ns>/<plugin>/plugin.json`；落 `userplugin/created`（含 `source_prompt_digest` 与产物哈希），同哈希幂等 | must | P2 | AC-USERPLUG-001 |
| FR-USERPLUG-005 | P2 | 用户空间插件的**迭代与回滚**：版本号递增才允许产物变更（同版本不能对应两个产物）；回滚只能回到历史里真实存在过的版本，且**只有磁盘内容已还原成该版本**时才登记 —— 账本不记不真的事 | AC-USERPLUG-005 |
| FR-AGENTRT-006 | P2 | **有界 + 显式降级**（运行期插件）：上下文切片条数/记忆条目数/单条字节数上界必须声明；超界**截断并报被丢条数**（不得静默丢）；无法组装时 `degraded:true` + `reason` + `next_action`；**空上下文不得报 `ok:true`**（"确实没内容"与"没组装出来"必须可区分） | AC-AGENTRT-006 |
| FR-AGENTRT-007 | P2 | **各自独立装卸、卸载零残留**：三件运行期插件可分别装载/卸载/重载；卸载后无订阅/定时器/句柄残留（各件都有 `*-disposed` 留痕）；**卸载记忆插件不丢事实** —— 项目记忆的来源是账本（Python 侧重放），与插件是否在跑无关 | AC-AGENTRT-007 |
| FR-AGENTRT-002 | P2 | **记忆四层边界**（运行期插件）：①会话记忆只在进程内、**永不落盘**；②项目记忆是**账本的可重建投影**（丢缓存不丢事实：删掉快照重建后逐字节一致），重放**只读**账本；③策略记忆**只人类可写**；④跨方共识**只走协议**（不得由本插件合并） | AC-AGENTRT-002 |
| FR-STORAGE-001 | P2 | **文件管理由插件提供**（Python 侧 `tools/storage.py` 唯一写入者；宿主侧只读观察面 `storage-view`）：按 ns 分区根、append-only 日志、`stat` 返回与磁盘一致的 `sha256`；`..`/绝对路径/符号链逃逸一律拒且**根外目标不存在**；读取必须有界并诚实报破 | AC-STORAGE-001 |
| FR-STORAGE-004 | P2 | 存储**跨租户隔离**：`ns` 逃逸与 `rel` 跨根一律拒（`storage-outside-ns`），且越权尝试后**哨兵在磁盘上不存在**；存储写不产生账本行、账本字节零改动（不得成为第二条事实写路径） | AC-STORAGE-004 |
| FR-STORAGE-006 | P2 | 存储提供**只读观察面**（容量/计数/失败次数）供自进化 `observe` 使用：有界、确定性、不出正文与私域键；**读它不改任何状态** | AC-STORAGE-006 |
