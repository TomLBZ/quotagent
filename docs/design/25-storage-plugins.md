# 25 存储（文件管理 + 数据库）—— 契约

<!-- budget: 28 KB（`docs/design/*.md` 统一预算，见 12-documentation-standard.md §1） -->

**状态：已实现（合同=本文；代码=`tools/storage.py` + `host/modules/storage-view.mjs`；机检=`host/t277-storage-gate.mjs`）。**
规划与需求背景见 `23-agent-runtime-and-storage-plugins.md` §1/§2（存储插件的既定设计）与
`22-plugin-market-and-user-space.md`（用户空间隔离四件套）。
**本文件刻意不写需求/验收 ID 记号**：文档门要求引用的 ID 必须在定义文件里存在，未落表就写 ID 等于
用一条指向空气的验证命令冒充已登记（与 22/23/24 同一纪律）。

## 1. 两件产物、一句话分工

| 产物 | 角色 | 干什么 |
|---|---|---|
| `tools/storage.py` | **Python 侧唯一写入者**（标准库） | 文件管理面（append-only 日志）+ 数据库面（极简键值表）；落盘只在这里发生 |
| `host/modules/storage-view.mjs` | **宿主侧只读聚合**（`provides: ['storageView']`） | 读 **Python 侧写出的快照**，按租户出六格计数；零写面、零子进程、不取墙钟 |

宿主**不自己遍历存储树**：它只读那份快照（`tools/storage.py snapshot --out <path>`，默认 `tmp/storage/snapshot.json`）。
理由不是"懒"，而是**避免第二份口径**：计数、上界、路径判定若在两侧各写一遍，早晚漂移（本项目为同类
"两处真源"付过成本）。宿主模块的 import 白名单在门里断言（只有 `node:fs` 的读 API 与配置构造器）。

存储根：`--root`，默认 `tmp/storage/`。一个租户一个根，布局固定：

```
<root>/<ns>/files/**          文件管理面（append-only 日志；一层一层目录都由本工具建）
<root>/<ns>/db/<table>.jsonl  数据库面（append-only 事件行）
<root>/snapshot.json          Python 侧写出的只读统计快照（派生副本，丢了可重建）
```

## 2. 租户隔离（`ns` = 租户）

一个 ns 只能落/读 `<root>/<ns>/` 里的东西。判定在**每个动作的最前面**做，顺序即优先级
（先判事实路径，否则真原因会被"逃逸"掩盖）：

1. **事实路径** → `storage-fact-path`（见 §3）；
2. **绝对路径** → `storage-path-escape`（`rel` 只收相对路径，绝对路径一律拒）；
3. **`..`** → `storage-path-escape`（**即使解析后仍在本 ns 根里也拒** —— 严于"恰好没逃出去"）；
4. **容器**（词法 + `realpath` 双重判定）：解析后在存储根里、但不在本 ns 根里 → `storage-outside-ns`（跨租户）；
   连存储根都出了 → `storage-path-escape`；词法在内而真实路径在外（符号链）→ `storage-path-escape`；
5. **深度**：ns 根以下超过 `max_path_depth`（8）→ `storage-limit-exceeded`。

拒绝码是**闭合集合**（7 条，`storage.py limits` 逐条给出；每条都有固定 `next_action`，门断言非空）：

| 码 | 含义 | 典型形态 |
|---|---|---|
| `storage-outside-ns` | 跨租户 / 非法 ns 名 | `--ns beta --rel ../alpha/logs/x.log`；`--ns ../alpha`；`--ns Alpha` |
| `storage-path-escape` | 逃出本 ns 根 | `../../etc/passwd`；绝对路径；`logs/../x`；经符号链写到/读到根外 |
| `storage-fact-path` | 目标是**事实路径** | `--ledger` 声明的路径；`tmp/ui-shared/<realm>/ledger.jsonl`；`user-space/` 别人的 ns |
| `storage-unbounded-read` | 无界读取 | 读日志不给 `--limit`（或 0 / 负数 / 非整数） |
| `storage-limit-exceeded` | 超声明上界 | 单条/单次/单文件/表数/键数/事件数/`--limit` 超上限 |
| `storage-unavailable` | 存储不可用 | root 未配 / root 不是目录 / ns 根不是目录 / 写失败 |
| `storage-schema-refused` | 声明式接口之外 | raw SQL / 连接串形状的入参；表名、键名形状不对 |

两条**不许伪装**的口径（门各一条断言）：

- **"确实没有" ≠ "读不到"**：空租户 → `ok:true` + `reason='namespace-empty'`；没这个键 →
  `ok:true` + `found:false` + `reason='key-not-found'`；路径缺席 → `ok:true` + `exists:false`。
  而"读不出来"一律 `storage-unavailable` + 有名 reason（前者 `ok:true`、后者 `ok:false`，结构性可区分）。
- **越界符号链不被跟随**：本租户里指向根外的符号链，`list-files` **只报名**（`escaped_symlinks`）并
  计数（`counts.escaped`）、置 `degraded:true` + `reason='symlinks-escaped-ns-root'`，
  外部文件的正文与 sha256 **一个都不出**（门用外部哨兵文件验两个方向）。

## 3. 存储不得成为第二条事实写路径

- **事实只进账本**（账本由 Python 内核独占写入）。存储**只放非事实**内容：缓存、中间产物、索引、附件。
  由此推出：存储的写操作**不产生账本行**（每次写返回 `ledger_written:false`），也不得删除账本行
  （账本行永不销毁；销毁派生副本只能走既有的留存门）。
- **三类事实路径一律拒**（`storage-fact-path`，且拒绝时磁盘**零变化**）：
  1. `--ledger <path>` **声明**的路径（含其子树）—— 被声明即不可碰，包括当 `snapshot --out` 的落点；
  2. 仓库内 `tmp/ui-shared/<realm>/ledger.jsonl`（**绝对构造**与**名字叫 `ledger.jsonl` 的相对构造**
     两个方向都拒 —— 后者是"就近落盘"最常见的形态）；
  3. 仓库 `user-space/` 树里**别人的 ns**：`--root` 指过去即拒；`--root` 是本 ns 却操作别人的 ns 也拒。
- **判据对符号链接形态同样成立**（`EV-174` / `D-077`）：`user-space` 是**指向 `src/userspace/` 的兼容符号
  链接**（阶段 5.1 的单一事实源）⇒ 事实区判据必须把**词法路径**（`<root>/user-space/…`）与**真实路径**
  （`<root>/src/userspace/…`）**两种形态交叉各判一次**（`tools/storage.py` 的 `_inside_zone`）。
  只比一种形态会让第 3 类拒绝**整条失效**（实测：`--root user-space/<别人的 ns>` 的**写**被放行，
  真在 `src/userspace/` 下落了文件 —— 收紧前 `_inside(USER_SPACE, <realpath>)` 恒假）。
- **快照是派生副本**：`snapshot.json` 只放计数与样本（可从存储树重建），丢了不丢事实；
  宿主只读它。**快照本身也不是事实**：不得把账本内容搬进快照来"方便宿主"。
- **证明方式**：门在跑完这些拒绝构造之后，对事实区做**按事实的核对**：① 每份 `ledger.jsonl`
  逐字节一致（sha256）；② 事实区与用户空间的**文件清单不变**（没有新文件）；③ 哨兵检索不到；
  ④ 攻击目标路径确实不存在 —— 只断言"返回了错误码"不算通过。
  **口径说明**：事实区里同时住着派生的快照 JSON（`pipeline.json`/`admin.json`/`retention-plan.json`），
  别的组件会按需重写它们（实测观察到），所以"零变化"不能拿整个目录的内容当判据 —— 那会把
  "别人重写派生副本"误判成"本工具写了事实区"（假红）。

## 4. 文件管理面：四个动作 + 声明上界

| 动作（CLI） | 语义 | 关键性质 |
|---|---|---|
| `open-append --ns --rel [--text]...` | 打开/创建本租户日志并追加若干行 | 每行 = **一次 `os.write` + `O_APPEND` + `fsync`**（行级原子、不劈行、不重写历史）；**写前判定**：任何一行超界 → **整批拒**（一行都不写） |
| `read-tail --ns --rel --limit N` | 读日志尾部的**有界窗口** | `limit` 必填（`1..200`）；截断**必报数**（见下） |
| `list-files --ns` | 列出本租户文件（稳定排序） | 条数有界；空租户有名 reason；越界符号链只报名 |
| `stat --ns --rel` | 报一个目标的状态（**不写**） | 缺席 = `exists:false`（"确实没有"） |

**截断与"报破条数"（`read-tail` 的诚实计数，字段名就是契约）**：

- `counts.lines_seen` / `lines_ok` / `lines_returned` / `lines_omitted`：物理行数 / 可解析行数 / 返回行数 / 窗口外被丢行数；
- **`broken_lines`（破条数）**：半写行（末尾没有换行的残行）+ 非法 UTF-8 行。它们**不应用、不返回**，
  但**必须报出来**（`torn_tail` 另给布尔），并置 `degraded:true` + 有名 reason；
- `clipped_lines`：被夹到 `--max-line-bytes` 的行数 —— 而每行的 `bytes` 仍是**原文真值**（夹后长度另看 `text`）；
  `--max-line-bytes` 本身必须落在 `1..max_line_bytes`（越界即拒：否则会把正文静默夹成空）；
- `truncated` = 有 omitted / clipped / broken 三者之一 → 置真；`omitted + returned + broken === lines_seen`（门逐项断言）。

**声明上界**（`python3 tools/storage.py limits` 是机读真源；门按真值断言）：

| 上界 | 值 | 覆盖 |
|---|---|---|
| `max_line_bytes` | 4096 B | 单条日志行（含换行） |
| `max_append_bytes` | 16384 B | 单次 `open-append` 批总量 |
| `max_file_bytes` | 1048576 B | 单文件（也是 `read-tail` 的读取上界：超了显式拒，不静默读半份） |
| `max_path_depth` | 8 | ns 根以下的路径深度 |
| `max_tail_lines` / `max_list_entries` / `max_scan_keys` / `max_hash_files` | 200 / 200 / 200 / 8 | 一次读取/列举的条数与哈希预算 |
| `max_scan_files` | 4096 | 一次目录遍历最多看多少条（超出即拒，不静默少数） |
| `max_tenant_bytes` | 8388608 B | 单租户总字节（写前判定） |

## 5. 数据库面：极简键值表（底层 JSONL，append-only 事件 + 内存重放）

- **事件行**（一行一条事件，`sort_keys` 序列化，UTF-8）：`{"seq": n, "op": "put"|"delete", "key": k,
  "value": v, "version": n, "at": "<调用方给的时间戳>"}`。`at` **由调用方传入**（本工具不读墙钟）。
- **重放**：读全表事件行 → 顺序应用 → 当前值集合。`put` 覆盖写 = 新事件（版本号 +1）；
  `delete` = **墓碑事件**（版本号 +1，键不再出现在当前值里）；**不销毁任何历史行**。
- **接口**（声明式，无 raw SQL、无连接串、无"跑一段查询"这类入口）：

| 动作 | 返回（成功时） | 拒绝/缺席 |
|---|---|---|
| `put --ns --table --key --value [--at]` | `version` / `seq` / `revision` / `value_bytes` | 键不在且表满 → `table-key-cap`；表数满 → `table-cap`；事件数满 → `table-event-cap` |
| `get --ns --table --key` | `found:true` + `value` + `version` | 键不在 → `ok:true` + `found:false` + `key-not-found` |
| `delete --ns --table --key` | `deleted:true` + `tombstone_written:true` + `version` | 键不在 → `ok:true` + `deleted:false`（**不写无意义的墓碑**） |
| `scan --ns --table [--limit]` | `keys[]`（键名/版本/`value_bytes`）+ `counts` | `values_included:false`（**扫表不出值正文**） |

- **破行**：事件日志里的半写行与非法行**不应用**并计入 `broken_rows`（`get`/`scan` 都会报，且置
  `degraded:true` + 有名 reason）；**尾行残缺时拒绝写入**（`storage-unavailable` + `event-log-torn`）——
  在残行后面追加会把两行拼成一条，宁可拒也不污染。
- **上界**：单值 `max_value_bytes`(4096)、单行 `max_row_bytes`(5120)、键名 `max_key_bytes`(256)、
  单表 `max_keys_per_table`(4096) 与 `max_events_per_table`(20000)、单 ns `max_tables`(32)、
  重放上界 `max_replay_events`(20000)。超界**拒**（报 bytes/limit），不静默截断值。
- **键名形状**：基础名（`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`）—— **不带冒号**，所以借别人凭据作用域
  前缀（`cred:<ns>/<plugin>:*`）那种形状在这里就被挡掉。

## 6. 宿主侧只读面（`storageView`）

- **只读**：不写文件、不起子进程（**不调 Python**）、不联网、不随机、不取墙钟、不注册定时器、
  不订阅事件、不写账本（门第 7 条静态扫描 + 非空转对照）。
- **按键白名单投影**：每个租户**恰好六格** —— `ns` / `files` / `file_bytes` / `tables` / `keys` /
  `last_write`；顶层键集合也是固定表。快照里多出来的东西（文件路径原文、`file_samples` 正文、
  凭据形状的键值、`root`、`credentials`…）**一个都不进输出**。
  形状即过滤：`ns` 必须匹配租户名形状（否则整条丢并计数 `invalid_tenants`）；数字必须是有限非负整数
  （否则归 0 并计入 `clipped`）；`last_write` 必须匹配 `YYYY-MM-DDTHH:MM:SSZ`（否则归一为空串并计数）。
  归一化**必计数**：不许悄悄改值，也不许悄悄丢整条。
- **有界且计数诚实**：租户条数封顶 `max_tenants`（默认 64），字符串按 UTF-8 字节夹到 `max_bytes`
  （默认 128）→ `truncated:true`、`omitted_tenants`/`clipped` 报数；`counts` 是**夹取前**真值
  （`tenants.length + omitted_tenants === counts.tenants`）。
- **租户范围**：`snapshot({ns})` 只出该租户，别的租户的名字一个字都不出现；而 `counts` 仍报**全体真值** +
  `omitted_tenants`。范围指到不存在的 ns → `reason='storage-scope-empty'`（**不是降级**，快照是读得通的）；
  范围形状非法 → `degraded:true` + `storage-scope-invalid`。
- **降级与"空 ≠ 读不到"**：未配 / 不可读 / 超 4 MiB / 不是 JSON / 顶层不是对象 / 快照自己 degraded →
  `degraded:true` + 有名 reason + `next_action`；**合法但零租户** → `degraded:false` 且
  `reason='storage-empty'`。六种情形**同形状**（键集合一致），绝不抛、也绝不返回"看起来健康的零"。
- **确定性**：不读墙钟、不随机；租户按名字稳定排序（与快照里的顺序无关）；同输入两次字节一致、跨实例一致。
- **不可用不得伪装**：没有快照路径就 `storage-snapshot-unconfigured`；快照读不出来是
  `storage-snapshot-unreadable` —— 两种都与"零租户"可区分。

## 7. 被否决的方案（4 项，含理由）

1. **让宿主侧直接读写存储（或让 `storage-view` 自己遍历存储树算计数）** → 否决：宿主零写面是硬边界，
   而且"谁在数"会变成两份实现（宿主一份、Python 一份），计数口径一定漂移。
   **落在实现上**：宿主只读快照；静态扫描把写文件 / 子进程 / 随机 / 墙钟 / 定时器 / 事件订阅逐条封死；
   import 白名单在门里断言。
2. **这一批就上 SQLite / 连接串后端（或接受 raw SQL 形状入参）** → 否决：本批的目标是**接口与隔离**。
   带连接串与查询串的入口等于把"跨 ns 结构性保证"降级成"靠调用方自觉"（隔离就不再有结构），
   而后端选择仍是未决项（§8.1）。**落在实现上**：只有声明式动作；`raw SQL`/`DSN` 形状的入参一律
   `storage-schema-refused`；表名/键名形状固定。
3. **允许无 `limit` 的全文读取（或"默认读到底，让调用方自己看着办"）** → 否决：无界读取等于把
   内存当上限，还会把"截断了多少"这件事变成没人知道。**落在实现上**：`read-tail` 的 `limit` 必填且封顶，
   截断必报数（`omitted`/`clipped`/**`broken_lines`**），`omitted + returned + broken === lines_seen`。
4. **允许把存储根指到 `tmp/ui-shared/` 或账本目录（"方便宿主就近读"）** → 否决：那正是"第二条事实写路径"
   的诞生方式 —— 一旦允许就近落盘，事实与派生副本混在同一个目录里，谁写的、谁该销毁就再也说不清；
   账本行永不销毁这条也不再有结构保证。**落在实现上**：三类事实路径一律 `storage-fact-path`，
   且门做**白名单口径**的事实区比对：只对**本用例自己触及的目标**（`--ledger` 指的那份账本、
   它构造的 snapshot 输出目标、"别人的 ns"）要求逐字节不变（账本类退化为"只增不改"+ 无哨兵），
   白名单外的变化（运行中服务 / 定时任务写派生副本与回执）**不判红但如实计数并打印**——
   把"整个事实区清单/字节不变"当判据会让无关写入者变成假红（实测踩到）。

## 8. 未决项（3 项，需人确认）

1. **后端选择**：本批只做接口与隔离，底层是"JSONL 事件行 + 内存重放"。文件型 JSONL 在多大体量下
   会被 SQLite 类后端替代（重放上界现在是 20000 事件/表）未定；换后端必须保持本文的声明式接口与
   ns 隔离逐条不变。
2. **租户配额从哪来**：`max_tenant_bytes` 现在是常量。真实配额（按 profile？按管理员下发？按租户分级？）
   没定 —— 现状只能保证"超界拒"，不能保证"配额合理"。
3. **快照的刷新触发与归属**：宿主不取墙钟，所以它**不可能**自己决定"什么时候刷新"。
   谁在何时跑 `storage.py snapshot`（CLI 手工？内核定时？每次写后？）未定；现状是"谁跑谁负责"，
   宿主只如实报它读到的那一份（含 `storage-snapshot-unreadable`）。

## 9. 机检与证据

```
python3 -m py_compile tools/storage.py          # 语法闸（门第 1 条也跑一遍）
python3 tools/storage.py limits                 # 声明上界表 + 拒绝码闭合集合（门按真值断言）
node --check host/modules/storage-view.mjs host/t277-storage-gate.mjs
node host/t277-storage-gate.mjs                 # 一行 JSON：{checks, passed, total, failures}；全绿 exit 0
node host/t277-storage-gate.mjs --mutate 1..4   # 单点变异自证（锚点恰好 1 次 + 变异后字节必变 +
                                                # 首条 FAIL 有名 + 第 1 条断言打印的是变异后的 sha256 +
                                                # finally 还原后逐字节一致）
```

门的 19 条断言里**必含四类反例**（跨租户读写被拒 / `..`·绝对路径·符号链越界被拒 / 超界读取被截断且
**报破条数** / 宿主模块零写面），另有：**全局层"事实区零写入"（白名单口径）**、本用例触及目标的
快照对比、快照→只读聚合的**独立遍历对照**、白名单投影负控（正文/路径/凭据哨兵）、有界与截断诚实、
降级可区分性、租户范围、确定性、配置负控、卸载零残留、Python 侧"可用性不伪装"与拒绝留痕汇总。
四处单点变异各自证明一条反例真的会红；白名单判据另有 8 组合成样本的**非空转自证**
（账本追加不判红 / 改写·截断·哨兵·凭空出现·消失判红）。
门覆盖的价值不在条数，而在于**每条都写清了"什么情况下必须变红"**。
