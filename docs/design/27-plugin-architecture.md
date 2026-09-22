# 27 插件架构与目录规范（硬规范）

<!-- budget: 28 KB（`docs/design/*.md` 行）。本页是"一切皆插件"的规则真源；模块现状清单在 14，需求归属在 28。 -->

本页把用户 2026-09-22 的架构指令写成**可机检的硬规范**。规则一旦与实现冲突，以实现或本页的"缺口登记"回答，不得靠记忆。
决策记录：ADR-0020（本页 §1/§2/§3/§5/§6/§7）、ADR-0021（需求归属，见 `28-plugin-requirements-and-run.md`）。

## 1. 三层分类与判定规则

### 1.1 层定义

| 层 | 路径 | 是什么 | 写面 / 信任级别 | 谁生产 |
|---|---|---|---|---|
| system | `src/system/<plugin>/` | 系统级插件：平台能力（数据库、文件、邮件、通知、市场、自进化、WebUI、账本、内核…） | 可写自己目录；**内核插件冻结**（ADR-0002）；账本写入仍只由 Python 侧承担（H1） | 人 + 自进化（需人工门 + 影子 + 门，ADR-0016/0017） |
| domain | `src/domain/<plugin>/` | 领域插件：出现本领域业务语义（RFQ、报价、比价、授权、变更、时限…） | 可写自己目录；不得成为第二条事实写路径 | 人 + 自进化 |
| userspace | `src/userspace/<ns>/<plugin>/` | 用户动态开发的插件：一位用户/租户用自然语言让 agent 产出 | **只写自己 ns 的文件根**（`..`/绝对路径/符号链接越界即拒）；服务键 `<ns>.<plugin>.<svc>`；平台保留名结构性拒绝 | 用户（经 agent），可经人工门提权为 system（`userplugin/elevated`） |

### 1.2 判定规则（三条问句，按序问完即可定层）

1. **它是否产出本领域的业务判定**（谁该中标、谁欠谁一个动作、这笔钱多少）？是 ⇒ `domain`；否 ⇒ 下一问。
2. **它是否是平台设施**（账本/事件/证据/投影/限流/熔断/预算/存储/市场/管理/配置/WebUI/自进化）？是 ⇒ `system`；否 ⇒ 它不是插件（是库或数据）。
3. **它的生产者是不是"使用者本人"**（写面在 `src/userspace/<ns>/`、且没有过人工门提权）？是 ⇒ `userspace`；否 ⇒ 回到第 2 问。

细则：**中间件也是插件**（`governor`/`circuit-breaker`/`budget-guard`/`idempotency-guard`/`timeline`/`audit-hook` 都归 system）；**门的缔造者与门的对象不能是同一个插件**（门放在被围插件的 `tests/` 里，但仍由仓库纪律约束不得自我放宽，参见 `docs/work/decisions-archive.md` 中"门不能由被围对象自己写"）。

### 1.3 当前清单（逐文件映射见 `docs/work/plans/plugin-file-map.md`）

- **system：34 个**（按 id 排序）：`admin` `agent-runtime` `approval` `audit-hook` `budget-guard` `canary` `circuit-breaker` `config` `eval` `evidence` `evolution` `governor` `idempotency-guard` `kernel` `kernel-bridge` `mail` `market` `measures` `norm` `observability` `ops-view` `pipeline-view` `projection` `qa-runner` `realm` `relay` `repo-gate` `retention` `runtime` `storage` `timeline` `ui-feedback` `user-plugin-manager` `webui`
- **domain：25 个**：`advice` `authority-band` `bid-heuristics` `capacity` `change` `clarify` `commitments` `compare` `costmodel` `deviation` `export` `faq` `gate-timeline` `guard` `intake` `negotiation` `price-history` `pricing` `quotes` `rfq` `rfq-deadline` `sourcing` `supplier-scorecard` `sync` `terms`（+ 在飞未提交的 `quote-prepare` = 26）
- **userspace：2 个命名空间**：`con-a/quote-trend`、`demo-ns/hello`（运行时根 `src/userspace/` 沿用 `user-space/` 的 gitignore 语义，见 §7 未决 2）

### 1.4 用户点名但**尚未成立**的系统级插件（缺口，登记不假装）

| 用户点名 | 现状 | 结论 |
|---|---|---|
| `database` | 无 Python/宿主数据库插件；存储侧只有 `storage`（文件+键值观察面）与规划中的 `file-store`/`db-store` | cordis 上游已有 `@cordisjs/plugin-database@4.1.1`（含 sqlite/memory/postgres/mongo/mysql 驱动）；**宿主侧优先直接用上游**，Python 侧不得引入（ADR-0007） |
| `filesystem` | 等价能力在 `storage`（文件根 + 原子写 + 逃逸拒绝） | 用例 `system/storage`；上游无对应文件系统插件（`@cordisjs/fs` 是浏览器 ponyfill，不适用） |
| `notification` | 无独立插件；通知语义分散在 `ui-feedback`（页面横幅）与 `mail`（外发） | **待建** `system/notification`；上游已有 `@cordisjs/plugin-notifier@0.8.0`，宿主侧优先直接用 |

## 2. 单插件标准目录布局

### 2.1 目录树（每个插件一模一样；不是"建议"）

```
src/<层>/<plugin>/
  plugin.json            # 插件自述清单（§3）—— 唯一登记真源
  README.md              # 一句话职责 + 提供的能力 + 用法（≤ 4 KB）
  requirements/
    README.md            # 本插件自己的 FR/AC 行 + 每条的可执行验收命令（≤ 16 KB；超则拆 requirements/*.md）
  docs/                  # 使用规范 / 契约（可选；有对外契约必须有）
    <topic>.md
  code/                  # 实现（Python 为 *.py，宿主为 *.mjs；禁止跨插件 import）
    <name>.py | <name>.mjs
  tools/                 # 本插件自己的可执行工具（写账本者只能在这里）
    <tool>.py
  tests/                 # 本插件自己的门与用例（围栏门 + 真路由门）
    gate.mjs | check_<x>.py
  data/                  # 运行期数据根（gitignored；userspace 必绑自己的文件根）
```

命名规则：`<plugin>` 必须匹配 `NAME_RE = ^[a-z][a-z0-9-]{0,31}$`（与 `host/lib/user-space.mjs` 同一正则，不新增第二套）；条目文件名 = 插件 id（`code/compare.py`），门文件名带测试对象（`tests/t279-heuristics-gate.mjs`）。

### 2.2 各位置的硬约束

| 位置 | 约束 | 为什么 |
|---|---|---|
| `code/` | 只允许 import：本插件 `code/`、其它插件的**公开面**（`plugin.json.provides` 对应的服务键）、标准库/已登记第三方（§5.3） | "可独立装卸"的前提是依赖是显式的 |
| `requirements/` | 只写本插件自己的 FR/AC；**不得复制**其它插件行（引用写 ID） | 一处一事实；矩阵才是归属真源 |
| `tests/` | 至少 1 条围栏门 + 1 条"真对象"门（真进程/真回读/真文件），并含**负控**（把实现改坏必须红） | 门不是橡皮图章（沿用本仓既有纪律） |
| `tools/` | 若该工具有写账本能力，**它必须是该账本唯一写者**，并在 `plugin.json.permissions` 声明 | 账本唯一写者（H1）不可被插件边界稀释 |
| `docs/` | 对外契约（路由、请求/响应形状、字段白名单）必须写；内部实现细节不写 | agent 靠文档而不是靠读实现来使用插件 |

### 2.3 一个插件的"完成定义"（DoD，六项全绿才算存在）

1. `plugin.json` 合法（§3）；2. `code/` 可被独立装载与卸载（§4），卸载后 effects 归零（对齐 `AC-PLUGIN-001`）；
3. `requirements/README.md` 有归属行且能在覆盖矩阵里对上；4. `tests/` 全绿且至少一条负控见过红；
5. `docs/` 有对外契约（若对外）；6. 在 `docs/design/14-plugin-inventory.md` 有一行（模块清单真源）。

## 3. 插件自述清单（manifest）与最小契约

清单文件名固定 `plugin.json`，**复用** userspace 既有约定（`host/lib/user-space.mjs` 的 `MANIFEST`/`NAME_RE`/`MAX_MANIFEST_BYTES=65536`），三层共用一张清单。

### 3.1 最小契约（必填，缺一即非法）

| 字段 | 类型 | 含义 | 校验 |
|---|---|---|---|
| `name` | string | 插件 id | `NAME_RE` |
| `version` | string | 语义化版本 | 存在即合法；缺 ⇒ `manifest-missing-fields` |
| `layer` | `system`\|`domain`\|`userspace` | 层（§1） | 必须与所在目录一致 |
| `provides` | string[] | 对外服务键（**基础名**，不带 `.`） | userspace 侧自动命名空间化为 `<ns>.<plugin>.<svc>` |
| `entry` | string | 入口相对路径（缺省 `code/`，python 为 `__init__.py`，宿主为 `index.mjs`） | 文件必须存在（否则 `artifact-missing`） |
| `description` | string | 一句话职责（写给人看，命令 `status` 回显） | 非空 |

### 3.2 可选字段（有则必须被消费，不许写了不用）

| 字段 | 含义 |
|---|---|
| `ns` | userspace 命名空间（userspace 层必填） |
| `inject` | 依赖的**其它插件的服务键**（宿主侧等价于 cordis `inject`）；未就绪 ⇒ 非激活（对齐 `FR-PLUGIN-001`） |
| `depends_on` | 依赖的插件 id（用于拓扑排序与 `deps` 命令；与 `inject` 是"服务级 vs 插件级"两种粒度） |
| `external_deps` | 第三方依赖：`{ "npm": {...}, "pypi": {...} }`，必须同时给锁文件路径（§5.3） |
| `permissions` | 写面声明：`{"writes": ["own-dir","request-file"], "ledger": "none"\|"sole-writer"}`；默认 `ledger: none` |
| `frozen` | `true` ⇒ 该插件的配置键永不接受自动更新（对齐 `internal/update` 的 `frozen` 语义与 `INV-010`） |
| `requirements` | 本插件承载的 FR id 列表（与覆盖矩阵双向核对） |
| `tests` | 门命令列表（例如 `["tools/verify.sh bid-heuristics"]`） |
| `source` | `human`\|`evolve`\|`user-space`（与 `docs/design/14-plugin-inventory.md` 的 `source` 一致） |
| `sha256` / `files` | 产物哈希与是否带文件（自进化追溯用；userspace 既有字段） |

### 3.3 兼容与迁移

- userspace 既有清单（`created_from`/`source_prompt_digest`/`data_file`/`interface`）是**可选字段的超集**，不做重命名；
- system/domain 侧新增 `layer`/`inject`/`depends_on`/`permissions` 四个字段即为三层统一；
- 清单是"可有可无的装饰"这件事被明确否决：没有 `plugin.json` 的目录**不是插件**（`list` 不枚举它，`load` 报 `not-a-plugin`）。

## 4. 生命周期接口与一行命令

### 4.1 六个动词（唯一接口；三个层同一套）

| 动词 | 语义 | 失败语义 |
|---|---|---|
| `list` | 枚举全部插件（默认三层；`--layer` 过滤），逐项给 `id/layer/version/provides/status` | 目录不存在 ⇒ 空（不是错误）；目录在却读不出 ⇒ `degraded:true` + 有名 `reason` + `next_action` |
| `status <id>` | 该插件是否已装载、依赖是否就绪、effects 计数、最近一次错误 | 未知 id ⇒ `unknown-plugin` + 候选列表 |
| `load <id>` | 装载（cordis：`ctx.plugin()`；userspace：新起独立 `Context`） | 依赖未就绪 ⇒ 非激活（不是失败）；已在装载 ⇒ `already-loaded` |
| `reload <id>` | 先卸后装，得到**新实例（新 uid）**，不迁移任何内存状态 | 未装载 ⇒ `not-loaded` |
| `unload <id>` | 卸载并归零 effects/订阅/定时器（`AC-PLUGIN-001`） | 未装载 ⇒ `not-loaded` |
| `deps <id>` | 打印依赖闭包（`inject` + `depends_on` 的传递闭包） | 有环 ⇒ `dependency-cycle` + 环上的 id |

### 4.2 一行命令（agent 可直接跑；`<verb>` 取 §4.1）

```bash
tools/plugin.sh list --layer domain --json     # 枚举（JSON，一行一条）
tools/plugin.sh status domain/compare          # 状态
tools/plugin.sh load  domain/bid-heuristics    # 装载
tools/plugin.sh reload domain/bid-heuristics   # 热重载（新实例）
tools/plugin.sh unload domain/bid-heuristics   # 卸载
tools/plugin.sh deps  domain/bid-heuristics    # 依赖闭包（可视化插件 → webui）
```

纪律：`<id>` 一律写 `层次/插件`（userspace 写 `userspace/<ns>/<plugin>`）；**所有动词都必须能在一步内完成**（不改中心清单、不改 profile 文件、不重启进程）；
`--json` 输出一行一条 JSON（沿用 ADR-0013 的帧纪律：stdout 只放机器可读结果，日志走 stderr）。

### 4.3 现状（诚实标注，不假装已实现）

| 能力 | system | domain | userspace |
|---|---|---|---|
| list/status | `tools/plugin.sh list/status`（真扫 `src/{system,domain}/*/plugin.json`；目录即清单） | 同左 | 同左（`src/userspace/<ns>/<plugin>/plugin.json`） |
| load/reload/unload | `tools/plugin.sh load/reload/unload`：**真 import 入口 + 真挂进常驻运行时进程**（`uid`/`state`/`effects` 都是 cordis 内核实测；`reload` 新实例、`unload` 回读 effects 归零） | 同左 | 同左（接口同一套；独立 `Context` 装载仍是 `user-plugin-manager` 的既有实现） |
| 依赖闭包 | `tools/plugin.sh deps`（`depends_on` + `inject` 服务键的传递闭包；有环给环上的 id） | 同左 | 同左 |

⇒ §4.2 的六动词**已全部落地**（实现 `src/system/runtime/`，门 `tools/verify.sh plugin-lifecycle`，EV-165）。
**仍未做**（诚实标注）：① 宿主**长驻服务（WebUI 进程）里逐插件装卸**（今天由 `host/profiles.mjs` 启动期静态装配；收口见阶段 5.2）；
② `./run` 的 `logs` 与 `config init` 两个动词（阶段 5.4 的剩余项）；③ 依赖闭包**自动拓扑装配**（今天只回答闭包，不代装）。
本规范要求的是**接口收敛**：三个层最终都由 `tools/plugin.sh` 一个入口驱动。

## 5. 依赖规则

### 5.1 允许

- 插件依赖**其它插件的公开面**（`inject` 写服务键；`depends_on` 写插件 id）；依赖是显式的，未就绪时的正确行为是"非激活"，不是"崩"（`FR-PLUGIN-001/002`）。
- 插件依赖**第三方**（用户原话："插件可以有各自的依赖（例如 webui 可以依赖前端框架）"）：宿主侧写进 `plugin.json.external_deps` + 锁文件；Python 侧默认零第三方。
- 插件依赖**本插件自己的** `tools/`/`tests/`/`data/`。

### 5.2 禁止（三条，全部可机检）

1. **禁止 `webui` 耦合**：`src/system/webui/` 里不得出现任何插件 id、业务名词或字段绑定（§6）。
2. **禁止跨插件直接 import/引用实现文件**：`code/` 只能 import 本插件与公开面；跨插件的"实现级"引用即违规（`tools/verify.sh wiring` 的方向）。
3. **禁止第二条事实写路径**：除内核账本与各插件声明的唯一写者外，任何插件不得写账本（H1）；`permissions.ledger` 默认 `none`。

### 5.3 第三方依赖的准入（与 ADR-0007 的关系，必须明说）

ADR-0007 定的是"**运行环境仅标准库、不引入第三方运行时依赖**"，理由是现场机器无法保证安装与网络。本节与它**不冲突**，因为准入条件更严：

1. 新增第三方依赖必须：① 有 ADR；② 有锁文件；③ 有"一键运行在离线机器上仍成立"的证据（§28 §3）；
2. Python 侧：默认零第三方（内核与领域插件都不加）；
3. 宿主侧：可加，但只能落在**该插件自己的 `plugin.json.external_deps`** 里，且不得成为新的进程外写入者；
4. 已存在的唯一第三方是 `cordis@4.0.0-rc.10`（ADR-0012），它是宿主层，不是插件依赖。

## 6. 注入式 UI 契约（webui 不耦合业务）

用户原话："插件可以依赖其他插件，例如 heuristics_visualizer 可以依赖 webui 来注入自身的视觉元素。**不需要让 webui 耦合展示其他插件的 UI 或者耦合某种具体的业务逻辑**。"

### 6.1 契约（webui 提供注册面；插件提交自己的东西）

| webui 提供 | 插件提交 | webui 知道什么 |
|---|---|---|
| 槽位（`slot`）：`nav.<view>`、`page.<view>`、`api.<view>`、`admin.<section>` | 一段区块 HTML 生成函数 + 该区块的只读数据投影（白名单载荷） | 只知道"有个区块、挂在这个槽位、属于这个前缀" |
| 路由注册：`POST /<prefix>/ui/register`（一次注册，幂等） | `{plugin_id, slot, route, method, auth, what}` | 只做路由表登记与可达性核对（`/api/routes`），不懂 `what` 的业务含义 |
| 静态资源位：`/<prefix>/assets/<plugin_id>/` | 插件自带 CSS/JS 文件（**页面模板仍 0 内联脚本**） | 只按前缀静态服务 |
| 主题 token：CSS 变量（`docs/work/plans/ui-workflow-rework-part3.md` §4.2 的 token） | 插件样式只用 token，不写死颜色/字号 | 只发 token |

### 6.2 允许 / 禁止（逐条可机检）

| 允许 | 禁止 |
|---|---|
| 插件向 webui 注册区块/路由/资源 | webui 里出现插件 id / 业务名词（比价、授权区间、时限、变更…） |
| 插件声明"我依赖 webui"（`inject: ["webui"]` 或 `depends_on: ["webui"]`） | 插件直接改 `webui` 的模板文件 |
| webui 按槽位顺序渲染（顺序由注册时的 `order` 决定，不由业务语义决定） | webui 为某插件做字段白名单/私域过滤（那是 `projection` 的职责） |
| 注册失败 ⇒ 该区块不渲染并如实报错（有名 reason） | 注册失败静默吞掉、或 webui 兜底编造区块 |

### 6.3 机检要点（本批不改门，作为迁移后的判据要求）

1. 静态扫描 `src/system/webui/code/**`：出现 `src/domain/*` 的插件 id 或领域名词 ⇒ 红；
2. 注册表驱动：`/api/routes` 的条目数 = 各插件注册数之和（漏一门抓得到，沿用既有 `webui` 门"新增路由没登记"的口径）；
3. 卸载一个业务插件后，`/api/routes` 里它的路由消失且页面其余部分逐字节不变；
4. 页面模板 0 内联脚本（既有断言）。

## 7. cordis 边界：直接用 cordis vs 自研

版本钉死 `cordis@4.0.0-rc.10`（`src/system/runtime/package.json`，见 ADR-0012）。下列"已提供"以**实测**为准：
`host/node_modules/cordis/lib/*.d.ts`（`lib/index.js` 的导出面）与 npm registry 查询（`@cordisjs` 命名空间，2026-09-22）。

### 7.1 直接用 cordis 核心（**不重造**）

| 能力 | cordis 提供 | 用法（本仓锚点） |
|---|---|---|
| 组合与依赖注入 | `Context.plugin()` / `inject()` / `RegistryService`（`resolve/get/has/delete/size`） | `host/cli.mjs`、`host/profiles.mjs`；插件写成 `{name, inject, provides, Config, apply}` |
| 插件生命周期与可回滚副作用 | `fiber.effect()` / `dispose()` / `DisposableList`（`fiber.d.ts`） | `host/lib/user-space.mjs` 的"独立 Context + fiber"；卸载零残留（`AC-PLUGIN-001`） |
| 事件五模式 | `EventsService.emit/parallel/serial/bail/waterfall/on` | 桥接语义按 ADR-0012 的载荷约定；Python 侧 `kernel/events.py` 是内核等价物 |
| 配置 schema | `Plugin.Config` + `@standard-schema/spec ^1.1.0` | `host/lib/std-schema.mjs`、各模块 `Config` |
| 配置热更新可否决 | `fiber.update()` + `internal/update` 瀑布（守卫不调 `next()` 即否决 ⇒ 配置不变、插件不重启） | `host/lib/config.mjs` + `host/lib/frozen.mjs`（`FR-PLUGIN-004`） |
| 日志 | `LoggerService` | 日志走 stderr（帧纪律） |
| 服务自省 | `ReflectService`、`symbols` | 自省/调试用 |

### 7.2 cordis **生态已提供**、我方当前自研 ⇒ 登记为"可替换"（不许说成"必须自研"）

| 上游包（版本为 2026-09-22 registry 的 latest） | 覆盖我方哪个自研件 | 结论 |
|---|---|---|
| `@cordisjs/plugin-loader@1.0.0-rc.7`（cordis 的**可选 peer 依赖**，本仓未装） | `host/modules/index.mjs`（目录即清单）+ `host/lib/user-space.mjs` 的装载/卸载 | **可替换**：宿主侧动态装卸优先采用上游；替换前先写 ADR（涉及隔离四件套的语义） |
| `@cordisjs/plugin-hmr@1.1.0` | `tools/verify.sh user-space` 的重载路径 | 可替换（热重载） |
| `@cordisjs/plugin-database@4.1.1` + 驱动（`-sqlite@5.1.1`/`-memory@4.1.1`/…） | 规划中的 `db-store` | **宿主侧优先直接用**；Python 侧不引（ADR-0007） |
| `@cordisjs/plugin-server@1.7.0`、`@cordisjs/plugin-server-acl@1.0.1` | `tools/webui-serve.py` 的 HTTP 服务 | **可替换/可组合**：WebUI 的 HTTP 层不需要自研 |
| `@cordisjs/plugin-http@1.5.2`（+ `-socks`/`-proxy-agent`） | 自研 `urllib` 封装（若有） | 宿主侧优先直接用 |
| `@cordisjs/plugin-notifier@0.8.0` | 待建的 `system/notification` | **宿主侧优先直接用**（Python 侧仍自研，因为发信要走账本） |
| `@cordisjs/mail@0.2.1` + `@cordisjs/plugin-mail-smtp@0.2.1`（nodemailer） | `src/system/mail`（Python：`mail.py`/`mail_transport.py`） | **判为不可直接替换**：本仓邮件是账本事实（`mail/*` 事件 + 唯一写者），MTA 只是它的一种传输；可把 SMTP 传输换成上游（需 ADR） |
| `@cordisjs/plugin-market@0.5.1` | `host/modules/plugin-market.mjs` | 部分可替换（市场 UI/清单来源不同）；本仓的"三真源一致"是本领域要求，保留 |
| `@cordisjs/plugin-webui@0.8.2`（+ `-logger-webui`/`-server-webui`/…） | `src/system/webui` 的页面框架 | **可替换候选**（Node 侧 console 框架）；本仓 SSR 契约（0 内联脚本、四道视角）须先对齐才可换 |
| `@cordisjs/plugin-insight@4.5.1` | `tools/check-plugin-inventory.py` 的依赖图能力 | 可复用于可视化；本仓的"清单↔模块双向"仍自研 |
| `@cordisjs/plugin-timer@1.1.3`、`-env@1.0.1`、`-cli@1.1.2`、`@cordisjs/schema@0.1.1` | 定时/环境/CLI/schema 自研件 | 宿主侧优先直接用 |

> 标注：上表**包名与版本**来自 npm registry 查询（一手元数据，原始输出见 `docs/work/evidence/EV-162-*.txt` 与 `tmp/arch-batch/npm-cordis.json`）；
> **用法（API 形状）**为 `[假设]`——本仓未安装这些包，未做代码级核实。任何替换都必须先做一次 spike（真装真跑）再写 ADR。

### 7.3 两边都不提供 ⇒ 必须自研（本领域语义）

账本/规范化/证据包（`kernel`）、交换协议 QEP、私域投影（`projection`）、人工门（`approval`）、realm 隔离、
比价与守卫（`compare`/`guard`）、变更与承诺（`change`/`commitments`）、自进化流水线与 canary（`evolution`/`canary`）、
"账本唯一写者"（H1）、"私域不出 realm"（INV 族）。**这些不是轮子，是本项目的产品**。

### 7.4 明确不迁移

Python 内核（必须保持仅标准库可运行，ADR-0007）与账本写路径（Python 独占）**不因 cordis 生态而改**；
宿主层可以换上游插件，但**不得**出现第二条事实写路径（§5.2 第 3 条）。

## 8. 本页的验收

| 断言 | 命令 |
|---|---|
| 预算与路径一致（$2.1 的布局不把文档挤出预算） | `tools/verify.sh docs` |
| 插件↔清单↔装配双向一致 | `tools/verify.sh plugins`；`tools/verify.sh modules`；`tools/verify.sh wiring` |
| 每个插件至少归属 1 条 FR/AC | `tools/verify.sh coverage` |
| 生命周期六动词可达 | `tools/plugin.sh list --json`（已实现）；门 `tools/verify.sh plugin-lifecycle`（EV-165） |
| 卸载零残留（三层同一判据） | `tools/verify.sh user-space`（用户空间既有实现）；`plugin-lifecycle` 门对三层同一套接口断言 effects 归零 |
| webui 零业务耦合 | §6.3 的四条**已加入** `tools/verify.sh plugin-lifecycle`（`host/modules/webui.mjs` 0 次出现样板插件 id/标题 + 机制行 0 业务名词 + 两页 0 内联脚本 + 注册面只读路由 405） |
| cordis 边界不漂移 | §7 的包名/版本与 `src/system/runtime/package.json`、锁文件一致 |

## 9. 未决

1. **`src/system`/`src/domain` 的 Python 包名**：已实测 Python 3.13 下 `find_spec("system"/"domain"/"userspace")` 均为 `None`（无 stdlib 冲突）；仍需在迁移阶段加一条守卫测试（换解释器/换环境后重测）。
2. **`src/userspace/` 是否随源码入库**：现状 `user-space/` 被 gitignore（运行时产物）。迁移后建议"运行时根 gitignore + 一个跟踪的 `EXAMPLE/` 参考实现"，需在阶段 0 定。
3. **`tools/` 保留几个入口**：本规范保留 `verify.sh`/`run.sh`/`runtime.sh`/`bootstrap.sh`/`cordis.sh` 五个薄入口 + 新增 `plugin.sh`；是否把 `plugin.sh` 也并入 `verify.sh`，等接口收敛后再定。
4. **门与被围插件同目录的独立性**：门搬到 `tests/` 后，"门不能由被围对象自己写"这条靠什么机检（现在靠评审 + `clean-copy` 门），待设计（登记为 `T-312` 子项）。
