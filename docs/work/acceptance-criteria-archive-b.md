# 验收标准归档 B（第一批之后的又一批较早行；主文件在 `acceptance-criteria.md`）

<!-- budget: 32 KB（与主文件同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

本文件是 `docs/work/acceptance-criteria.md` 的归档（**批次 B**，承接 `acceptance-criteria-archive.md` 批次 A）。
**主文件仍是契约正文**（运行器契约、当前阶段的 AC 行与证据制度都在那里）。**归档不是豁免区**：

- **门的口径**：`AC-<域>-<NNN>` 的定义可以落在主文件，也可以落在本文件（以及同目录下任何
  `acceptance-criteria-archive*.md`）。`docs/work/acceptance-criteria.md` + 这些归档 = 门的
  **AC 定义集合**；`tools/check-docs.py` 按该集合判 ID 完整性、预算与 FR↔AC 覆盖，
  `tools/check-ac-registry.py` 按同一集合判「**phase 恰为 P0** 的 AC 必须已在 `qa list` 注册」。
- **搬进归档的行仍受全部断言约束**：ID 引用必须解析、文件必须在预算内、不得是孤儿 AC；
  门的输出里会打印它读了哪些归档（`archives=[...]`），并**断言归档文件确实被读到**
  （归档 0 条 AC 行即判失败），所以"归档"不可能是绕过校验的后门。
- **逐字搬走**：下面每一行与它在主文件里时**逐字节相同**（含证据引用与命令），只换了所在文件。

**选入规则**（可复核）：主文件里 phase（第二个单元格）**不为 `P0`**、且由 git 引入时间
**≤ 2026-09-21T15:04:59Z** 的 AC 行，按引入时间升序（同批保持原文件行序）整行搬入。**`P0` 行一律留在主文件**（最保守）；
`AC-DESIGN-001..003`（文档门自身的判据、主文件 §1 散文逐条点名）与 `AC-NEGO-001`
（`docs/design/17-negotiation-contract.md` 明文「不得修改」）留主文件。
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
