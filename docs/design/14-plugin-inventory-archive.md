# 14 插件清单 · 归档（库层 / Python 侧 / 工作区服务 / 自进化流程）

<!-- budget: 28 KB（`docs/design/*.md` 行）。本页是 `docs/design/14-plugin-inventory.md` 的**归档**：
     主文件里原本的 §2（宿主库层）§3（Python 侧功能）§4（工作区服务）§5（自进化产出的插件）**整节逐字**搬到这里，
     腾出预算给"三层插件（`src/<层>/<插件>/`）"的新行（T-316 批次）。 -->

**归档不是豁免区**（与 FR/AC/T 同一套机制，见 `docs/design/12-documentation-standard.md` §2）：
主文件 + 本归档（`14-plugin-inventory-archive*.md`）= `tools/check-plugin-inventory.py` 的**清单文档集合**，
两侧受同一套断言（P1 目录↔清单双向、P3 `services/*.py` 功能有归属）；**归档 0 条登记行 = 硬失败**（空读不许通过）。
搬行时**整节整行逐字**搬（不改写、不摘要），搬后不改变任何断言语义。

## 2. 宿主库层（`host/lib/*.mjs`，不直接对外提供服务）

| 库 | 职责 | 谁依赖 |
|---|---|---|
| `host/lib/config.mjs` | profile 配置装载（三档可改性） | `cli.mjs`、各 profile |
| `host/lib/frozen.mjs` | 冻结面判定（`kernel.*` 含人也不能改，INV-010） | `cli.mjs`、`invariants.mjs` |
| `host/lib/schema.mjs` | 可改键白名单唯一真源 | `host/lib/config.mjs` |
| `host/lib/std-schema.mjs` | 极简 standard-schema 构造器（cordis 不导出 Schema） | 全部模块 |
| `host/lib/bridge.mjs` | 桥客户端（首帧 hello、方法面分级） | `kernel-bridge.mjs`、`cli.mjs` |
| `host/lib/supervisor.mjs` | 重启预算/在途请求/孤儿进程（AC-INTEG-006） | `cli.mjs supervise` |
| `host/lib/evolution.mjs` | 演化门骨架（提案/影子/门/晋升/回滚，T-220） | `evolution.mjs` |
| `host/lib/canary-dispatch.mjs` | 把 canary 分流接到真实请求路径（按 key 选实现、回灌样本、**候选失败回退 base / base 失败原样抛**） | `canary` 及其调用方（`webui` 路径） |
| `host/lib/ledger-view.mjs` | 只读账本视图（H1：宿主不写账本） | `webui.mjs`、`cli.mjs webui` |

## 3. Python 侧功能（`src/quotagent/`，每个服务也是一个可独立演进的单元）

| 层 | 归属 | 说明 |
|---|---|---|
| `src/quotagent/kernel/*.py` | 内核（账本唯一写入者、事件总线、插件宿主、QEP、交付） | 内核不可自改（ADR-0002）；`kernel.*` 冻结面 |
| `src/quotagent/services/*.py` | 业务服务（measures/norm/rfq/intake/realm/approval/costmodel/pricing/commitments/deviation/compare/guard/evaldata/evalmetrics/scenarios/relay/sync/clarify/quotes/capacity/terms/change/export/retention/retention_exec/negotiation/faq/**mail**/**mail_transport**/admin_blocks）——`negotiation.py`（谈判轮次与让步，T-256）、`faq.py`（澄清 FAQ 沉淀与复用，T-257）、`mail.py`（邮件集成无凭据部分，T-258，**发信边界**）、**`mail_transport.py`（邮件的真实传输层：SMTP 发信 / IMAP 收信，纯标准库；env 优先于配置文件的 `project` 段点分键 `mail.smtp.*`/`mail.imap.*`；没配就报 `mail-*-unconfigured`、配了连不上就报 `smtp-unreachable`/`imap-auth-failed` …；凭据不进日志/账本/异常消息；收信有界并报截断；每次真尝试原子写状态快照供宿主只读——本批新增）**——`retention.py`（留存与销毁判定器，T-252）当前只实现**判定**：其 AC-AUDIT-003 含"销毁生效后不可再读"，**执行侧未实现故该 AC 未标绿**，执行侧见清单 T-253 | 每个文件 = 一个功能单元；新增服务必须带 AC（`tools/verify.sh ac-registry`） |
| `src/quotagent/qa/checks_*.py` | 各 AC 的断言实现 | 改导入清单后必须立刻跑 `tools/verify.sh ac-registry` |
| `src/quotagent/g1side.py`、`src/quotagent/bridge.py` | 走查单侧进程 / 内核桥端点 | 见 `docs/work/deployment-manual.md` |

## 4. 工作区服务（本机基础设施，见 `docs/work/deployment-manual.md`）

| 服务 | 提供者 | 备注 |
|---|---|---|
| `quotagent`（工作区网关路由 `/quotagent`） | `src/system/webui/tools/webui-serve.py` → cordis 插件 `webui`（**已归位**：`tools/webui-serve.py` 现只剩薄转发，实体在 `src/system/webui/tools/`，本批 `EV-179`） | 幂等接入脚本 `tools/ws-integrate.py` |

## 5. 自进化产出的插件（`ADR-0016` / `T-227`）

新增功能有两条合法来源：**人写**（`T-2xx` 批次）与**自进化提案**。后者走：

1. `makeModuleProposal`（`host/lib/evolution.mjs`）绑定产物路径 / `sha256` 内容哈希 / 字节数；
2. 产物先写**影子目录**，用 `node host/check-modules.mjs --module <name> --module-dir <shadow>/modules` **真跑** A1..A6；
3. `gateModule` 五条 AND（fixture 全绿 / 不变量 / 反例集 / 预算 / 人工介入率不升）；
4. `promoteModule` 写真实 `host/modules/`，**必须**带人工 `approval_ref`（`ap-NNNN`）且影子哈希与提案一致；
5. 回滚只删自有产物（内容被他人改过则拒绝）。

不变量：**自进化只能写 `host/modules/`**（内核/服务层不可自改）；门里的 `expected_effect.metric` 固定为
`fixture:module`（不接受模型自评）；晋升后必须在本表补一行并至少被一个 profile 装配，否则 `tools/verify.sh plugins` 会红。

机检：`tools/verify.sh evolution`（27 条断言，含 7 条负控）。

## 6. 三层插件（`src/<层>/<插件>/`，自 `T-321`/`T-329` 起）

**承载体现状（`EV-178` 末实测，逐条可复算）**：**53/63 已接承载**（`code/index.mjs` 或 `code/__init__.py` 真实存在
⇒ `plugin.sh list` 报 `valid:true`；本批新接 **5 个 ESM + 19 个 Python** 入口）；**10 个仍无入口**（如实报
`degraded: artifact-missing`）：**8 个**是「多实体插件，'哪个实体当入口'未定」（`system/admin`、`system/agent-runtime`、
`system/canary`、`system/eval`、`system/kernel-bridge`、`system/mail`、`system/webui`、`domain/compare`），
**2 个**的实现在插件根而非 `code/`（`system/repo-gate`、`system/qa-runner` —— 跨插件的**平台门/AC 运行器**，
落 `code: 待实现`）。**不假装已实现**。

| 插件（目录 / id） | 提供的能力 | 提供者服务名 | 被哪些装配 | 独立演进时改哪里 |
|---|---|---|---|---|
| `src/system/runtime/`（`system/runtime`） | 仓库内自包含运行时 + 六动词生命周期 + 一键运行 `./run` | `pluginLifecycle` | 运行时进程（`tools/plugin.sh`） | 只改本插件 `code/`（规则文本在 27） |
| `src/domain/advice/`（`domain/advice`） | 决策建议层：没有可分的数据就不给建议 | `advicePanel` | wrapper → `host/modules/advice-panel.mjs`（阶段 4.1 实体搬迁） | 只改本插件 `code/` + 围栏门 |
| `src/userspace/demo-ns/hello/`（`userspace/demo-ns/hello`） | 用户空间样板：命名空间服务 + 只读区块，零写面 | `bucket`、`status` | 宿主运行时（副本 `user-space/demo-ns/hello/`） | 只改本插件目录（隔离四件套在 `host/lib/user-space.mjs`） |
| `src/system/webui/` | 双方视角 WebUI + 注入式 UI 注册面（0 业务语义） | `webui`、`uiSlots` | `webui` profile | 实体已落 `code/webui.mjs`（`EV-178`；旧路径薄重导） |
| `src/system/storage/` | 按 ns 分区的文件管理 + 键值表 + 只读观察面 | `storageView` / `storage` | `storage` profile | 实体已落 `code/storage-view.mjs` + `tools/storage.py`（`EV-177`/`EV-178`；旧路径薄重导/薄转发） |
| `src/system/market/` | 插件市场：三真源只读聚合（逐项 `source`/`wired`） | `pluginMarket` | `webui`（系统管理道） | 实体已落 `code/plugin-market.mjs`（`EV-177`；旧路径薄重导） |
| `src/system/evolution/` | 自进化流水线 + 流水只读归纳 | `evolution` / `evolveJournal` | `webui`（运维道与管理道） | 实体已落 `code/evolution.mjs`（`EV-178`，裸 `cordis` 由模块内显式解析）+ `code/evolve-journal.mjs` |
| `src/system/mail/` | 邮件真收发（SMTP/IMAP）+ 只读运维视图 | `mailView` / `mail`、`mail_transport` | `webui`（运维道邮件的运维视图） | 实体已落 `code/mail.py`·`mail_transport.py`·`mail-view.mjs`（旧路径薄重导） |
| `src/system/kernel/` | 平台内核：唯一账本写者 + 事件总线 + QEP + 插件宿主 + 交付绑定 | `ledger`、`events`、`qep`、`plugin`、`delivery` | 内核进程（经 `kernel-bridge.mjs`） | 阶段 3.1；**内核不可自改**（ADR-0002） |
