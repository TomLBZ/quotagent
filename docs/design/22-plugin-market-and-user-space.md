# 22 插件市场与用户空间插件 —— 规划

**状态：规划（未实现）。** FR 已入正式需求文档；AC 全文见 `docs/work/plans/p3-acceptance-spec.json`。

**编号与全文**：本批 41 条需求与 42 条验收条目的 **ID 与全文**在 `docs/work/plans/p3-spec.json`（含每条建议的验证命令与证据文件）。**本文件刻意不写 ID 记号**：文档门要求引用的 ID 必须在定义文件里存在，而 AC 只有在门与证据真实存在时才能合法落表 —— 未落表就写 ID，等于用一条指向空气的验证命令冒充已登记（宁可慢，不造假）。

## 1. 目标

- **插件列表/市场本身是插件**（`plugin-market`）：只读聚合三真源（`host/modules/*.mjs`、`14-plugin-inventory.md`、
  `user-space/*/*/plugin.json`），逐项给 `source`(human/evolve/user-space) 与 `wired`；三源不一致必须**报不一致**。
- **用户空间插件全生命周期**：用户在 agent panel 用自然语言描述 → agent 产出插件 → **完成即自动进列表** →
  自动重载/卸载/迭代/回滚；**管理面本身也是插件**（`user-plugin-manager`）。
- **隔离四件套**：独立 instance（独立 Context/fiber/effects）、独立命名空间（服务键 `<ns>.<plugin>.<svc>`，
  禁用平台保留名如 `approval`/`ledger*`/`kernel.*`）、独立文件根（挂载期绑定，`..` 与符号链接越界即拒）、
  独立凭据作用域（只解析 `cred:<ns>/<plugin>:*`）。
- **提权**：管理员把用户空间插件提为系统级 —— 必须过**人工门 + ADR-0016 五条 AND + 影子哈希一致**，
  写入面仍是 `host/modules/`，并落 `userplugin/elevated` + `evolve/promoted`，随后补 `14` 登记行。

## 2. 写面封死（两个方向）

- 自进化 target 指到 `user-space/` → `artifact-outside-write-surface`；
- 用户空间装载 target 指到 `host/modules/` 或 `src/` 或**别人 ns** → `user-space-outside-ns`，且目标不存在。

## 3. 规划中的机检

`verify.sh plugin-market` / `user-space`（新建，各含内建负控）＋复用 `plugins`/`modules`/`wiring`/`coverage`/
`evolution`/`evolve-module`/`clean-copy`/`invariants`。**新目录** `user-space/<ns>/<plugin>/` 进 `.gitignore`。
事件两侧登记（`05-events.md` + `kernel/events.py`）：`userplugin/created|loaded|reloaded|unloaded|upgraded|rolled-back|elevation-requested|elevated|refused`。
市场**零写面**（不落账、不写文件）。

## 4. 被否决的选项

- 进程/容器级隔离 → **本批不做**（见未决 1），先做进程内独立 Context + 命名空间 + 文件根。
- 用户空间插件直接改 `host/modules/` 或已晋升产物 → 否决（D-053：已晋升产物不改）。
- 市场允许"下载/安装"动作 → 否决：市场只读，安装只产**指向既有门的引用**（`install_ref`）。
- 用户空间插件可直接注册平台服务名 → 否决：命名空间化 + 保留名拒绝。

## 5. 未决（需用户确认）

1. **隔离粒度**：当前设计是"同一进程内独立 Context"，不是独立进程/容器。
   要做到"防串用"是否够？（独立进程会显著改变宿主装配与自进化的影子真跑方式。）
2. `user-space/` 是否整体 gitignore（当前建议：是）。
3. 市场是否要出现在 UI（哪一道：ops 还是 admin）。
4. 用户空间插件的凭据从哪来（系统面板下发？用户自填？）

## 6. 需求行（FR-MARKET / FR-USERPLUG）

| FR 条目 | **插件列表本身由插件提供**：新增 `host/modules/plugin-market.mjs`，`provides: ['pluginMarket']`，只读聚合三类真源（① `host/modules/*.mjs` 目录 ② `docs/design/14-plugin-inventory.md` 的登记行 ③ `user-space/<ns>/<plugin>/plugin.json` 清单），逐项给出 `source`（`human` / `evolve` / `user-space`）、`wired`（被哪些 profile 装配）与 `provides`；未装配项显式标 `unwired`，**不得隐藏**；列表为空必须报 `degraded`（与"读不到"可区分） | must | P2 | AC 条目、AC 条目 |
| FR 条目 | **市场目录与已装载项必须分开呈现**：尚未过门/尚未晋升的产物（影子目录、`user-space/<ns>/<plugin>/.shadow/`、未带 `approval_ref` 的提案产物）**不得**出现在"可安装项"里；市场中每一条"可安装"必须携带 `install_ref`（指向 ADR-0016 的 `promoteModule` 或用户空间装载路径），**无引用的安装项一律拒绝** | must | P2 | AC 条目 |
| FR 条目 | 三源**不一致即报不一致**：同一插件名在目录/清单/用户空间清单之间哈希、版本或装配状态不同时输出 `inconsistent:true` 与逐项差异；**不得取其一而静默** | must | P2 | AC 条目 |
| FR 条目 | 市场是**只读面**：不装载、不下载、不写文件、不启动子进程、不写账本；"安装/提权"只产出**指向既有门的引用**，市场自身不得落任何产物 | must | P2 | AC 条目 |
| FR 条目 | 市场视图**有界且确定性**：条数上界、稳定排序（同输入同输出）、不含正文与私域键；超上界即截断并报 `truncated:true` 与被丢条数 | should | P2 | AC 条目 |
| FR 条目 | 市场**不可用时不得伪装**：真源不可读 → `degraded:true` + `reason` + `next_action`，**不得返回"看起来健康的零插件清单"**（零插件 ≠ 读不到，两种情形必须可区分） | must | P2 | AC 条目 |

| FR 条目 | **自然语言 → 产插件 → 自动进列表**：用户在 agent panel 用自然语言描述需求，agent 产出用户空间插件；产出完成即**自动登记进用户空间管理列表**（无需人工搬运/手工注册动作）。登记真源 = `user-space/<ns>/<plugin>/plugin.json`，并落 `userplugin/created`（含 `source_prompt_digest` 与产物 `sha256`）；同哈希重复登记**幂等** | must | P2 | AC 条目 |
| FR 条目 | **写面只有 `user-space/<ns>/<plugin>/`**：写其它路径（`host/modules/`、`src/`、`tools/`、别人的 ns 目录、仓库外路径）一律拒绝（`user-space-outside-ns`），且**目标文件不得出现**；不得"就近落盘" | must | P2 | AC 条目、AC 条目 |
| FR 条目 | **自动重载**：产物或清单变化即触发**该插件**重载（不重启进程、不影响其它插件）；重载得到**新 instance**（新 fiber uid），**不迁移旧内存状态**（沿用 ADR-0015「生效即重启」语义） | must | P2 | AC 条目 |
| FR 条目 | **自动卸载零残留**：卸载后订阅/定时器/文件句柄/服务注册全部回收，且**不影响**其它用户空间插件与平台插件的既有运行 | must | P2 | AC 条目 |
| FR 条目 | **迭代/改进 = 新版本**：每次迭代产出版本号 + 内容哈希 + 上一版本引用（历史可查）；旧版本可**回滚**；回滚只撤自己拥有的内容（内容被他人改过即拒 `rollback-refused-modified`） | must | P2 | AC 条目 |
| FR 条目 | **隔离四件套**：①独立 instance（独立 `Context`/fiber 与独立 effect 列表）②独立命名空间（服务键 `<ns>.<plugin>.<service>`，**不得注册或覆盖平台已占用的服务名**，尤其 `approval`/`ledger*`/`kernel.*`）③独立文件根（挂载期绑定 `user-space/<ns>/<plugin>/`，解析后越界即拒）④独立凭据作用域（只解析 `cred:<ns>/<plugin>:*`） | must | P2 | AC 条目 |
| FR 条目 | **四类反例必须被结构性拒绝**（不是靠文档纪律）：①写别人目录 ②跨 instance 共享可变状态 ③未提权插件被他人加载 ④**无凭据时自称"已连接"**。四类均拒绝并留痕（`userplugin/refused`，带 `code` 与 `next_action`） | must | P2 | AC 条目 |
| FR 条目 | **管理本身也是插件**：新增 `host/modules/user-plugin-manager.mjs`（`provides: ['userPluginManager']`，动作 `list`/`load`/`unload`/`reload`/`elevate-request`）；**管理面卸载后已装载插件照常运行**（新装载被拒且拒绝不伪装成功） | must | P2 | AC 条目 |
| FR 条目 | **不耦合进平台**：用户空间插件不得改内核/服务层，**不得改 `host/modules/` 里已晋升产物**（D-053：已晋升产物不改，要新行为就加新插件），只能通过已在 `14-plugin-inventory.md` 登记的服务面 `inject` 消费平台能力；未登记服务名即拒 | must | P2 | AC 条目 |
| FR 条目 | **提权**（管理员在系统 UI 把用户空间插件升为系统级供他人使用）：①人工门 `approval_ref`（无则拒）②过 ADR-0016 的五条 AND 门（对**影子产物真跑** fixture A1..A6）③影子哈希与清单哈希一致（不一致即 `elevate-tampered`）④写入面仍是 `host/modules/` ⑤落 `userplugin/elevated` + `evolve/promoted` 并在 `14-plugin-inventory.md` 补行 | must | P2 | AC 条目 |
| FR 条目 | **两个方向都封死**：用户空间路径不得写 `host/modules/`（`makeModuleProposal` 的 target 指向 `user-space/...` → `artifact-outside-write-surface`），用户空间装载路径不得写 `host/modules/`（→ `user-space-outside-ns`）；任一方向能通过即视为不满足 | must | P2 | AC 条目 |
| FR 条目 | **未提权不可被他人加载**：跨 ns 加载未提权插件 → `user-plugin-not-elevated` 且目标未被载入（effects 仍为空）；提权后按普通进树插件被任意 profile 装配，并受 `wiring`/`modules`/`plugins` 三门的既有约束 | must | P2 | AC 条目 |

## 7. 验收条目（AC-MARKET / AC-USERPLUG，摘要；全文见 JSON）

- `pluginMarket` 服务由插件提供且列表**非空**（空列表必须 `degraded`）；列表里的每个进树模块都带 `source`（`human`/`evolve`/`user-space`）与 `wired`（profile 名单，缺者显式 `unwired`）；卸载 `plugin-…
- 市场"可安装项"与已装载项**分开**；负控：把影子目录/未晋升产物放进可安装候选 → **不得出现**（或出现即 `install_ref` 为空并被拒）；每条可安装项带 `install_ref` 指向既有门；无引用的安装请求被拒且不落产物
- 三种不一致各造一次（目录有/清单无、清单有/目录无、用户空间清单哈希 ≠ 产物哈希）→ 输出 `inconsistent:true` + 逐项差异；**不得**取其一静默通过
- 连读市场面前后：`host/modules/*.mjs` 与 `src/**/*.py` 逐字节与个数不变、无新文件、账本行数零新增、无子进程；四个 profile 的 `config_digest` 不变
- 同输入两次输出除时间键外逐字节一致；条数超上界即 `truncated:true` 且带被丢条数；正文与私域哨兵均不出现
- 真源不可读 → `degraded:true` + `reason` + `next_action`；**与"真的零插件"可区分**（前者的 `degraded=true`、后者 `degraded=false` 且列表为空）；两种情形都不得报 `ok:true` 掩盖

- 给定一段自然语言描述，产出 `user-space/<ns>/<plugin>/plugin.json` 且**在无人工搬运步骤**下出现在管理列表（list 命中）；落 `userplugin/created`（含 `source_prompt_digest` + 产物 `sha256`）；同哈希…
- 写面负控四例：target 指向 `host/modules/`、`src/`、`user-space/<other-ns>/`、仓库外路径 → 全部 `user-space-outside-ns`；**且四个目标位置事后都不存在该文件**（只断言"抛错"不算通过）
- 改某插件产物 → 只有该插件重启：其 fiber uid 变化、**其它插件 uid 与配置摘要不变**、进程 pid 不变；重启后旧内存状态**不迁移**（断言草稿为空，而不是旧值）
- unload 后 effects 归零、订阅不再收到事件、定时器停止触发、文件句柄关闭；**其它插件**（同 ns 与平台插件）的 effect 计数与行为逐项不变
- v2 产出后历史含 v1（版本号 + 哈希 + 父引用，可查）；回滚到 v1 成功且**只撤自有内容**；把产物改一字再回滚 → `rollback-refused-modified` 且文件仍在（两个方向都断言）
- 隔离四件套各一条：①两个 ns 的同名插件 instance uid 不同且可分别卸载（互不影响）②服务键命名空间化，且**注册平台保留名（`approval`）被拒**③文件根绑定后 `../` 与符号链接越界均被拒 ④凭据只解析本 ns 前缀（借别人的 `cred:` 前缀被拒）
- **四条反例全拒且留痕**：①写别人目录 ②跨 instance 共享可变状态（A 实例写、B 实例读到 → 必须读不到，即无共享）③未提权插件被他人加载 ④**无凭据时装已连接**（返回 `connected:true` 即失败，必须 `available:false` + `reason` + …
- `user-plugin-manager` 可装卸；装载后 `list/load/unload/reload` 可用；**卸载管理面后**已装载插件仍在跑（事件仍派发、列表快照仍可读），但新装载被拒且拒绝**不伪装成功**（不得返回 `ok:true`）
- 装载/卸载若干用户空间插件前后：`host/modules/*.mjs`（含已晋升产物）与 `src/**/*.py` 逐字节不变；账本新增事件类型**只在 `userplugin/*` 白名单内**；用户插件 `inject` 未登记服务名即拒
- 提权全链三负一正：无 `approval_ref` → `elevate-needs-approval`；门未过（坏产物 inject 写内建 mixin，影子 fixture 真红）→ `elevate-gate-failed`；影子哈希 ≠ 清单哈希 → `elevate-tampered`；三…
- 跨 ns 加载**未提权**插件 → `user-plugin-not-elevated` 且目标未被载入（effects 仍为空）；同一插件提权后按进树插件被 profile 装配成功并过 `wiring`/`modules`/`plugins`
- 两个方向都封死：①`makeModuleProposal` 的 target = `user-space/<ns>/<plugin>/` → `artifact-outside-write-surface`；②用户空间装载路径的 target = `host/modules/` → `user-sp…
