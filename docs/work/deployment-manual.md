# 部署与操作手册（一页能跑起来）

<!-- budget: 32 KB（docs/work/*.md）；本页刻意保持一页可读完 -->

> 目标读者：**未参与开发**的工程师。全部命令在仓库根目录执行，不需要联网、不需要装任何第三方库。
> 本页的每一段都在一个**干净副本**里按顺序实跑过（证据：`docs/work/evidence/EV-055-*.txt`）。

## 0. 需要什么

| 需要 | 说明 |
|---|---|
| Python | **3.9+**（本仓实测 3.13）。解释器由 `tools/runtime.sh` 解析：`$QUOTAGENT_PY` → 仓库 `.venv` → 工作区工具链 → `PATH`；每个候选都会**真跑一段代码**验证，不接受同名包装器 |
| Node | **可选**。只有宿主层（cordis 装配与桥的宿主侧，`host/`）需要；纯内核 + 服务 + CLI 不需要 Node |
| 磁盘 | 仓库自身很小；运行期临时产物只落 `tmp/`（已 gitignore），**不写仓库外任何文件** |

## 1. 三步确认环境（30 秒）

```sh
tools/bootstrap.sh --check     # 只做解释器解析与自检，不创建 .venv
tools/verify.sh smoke          # 运行时自检：解释器解析 + 仅标准库 + 临时目录可写
tools/verify.sh docs           # 文档门：ID 引用、预算、FR↔AC 覆盖
```

想用仓库内的虚拟环境（可选，仍不需要联网装包）：

```sh
tools/bootstrap.sh             # 在 <repo>/.venv 下建 venv（--without-pip），写入运行时清单并冒烟
```

## 2. 跑一轮真实的双人流程（演示用，约 1–2 分钟）

```sh
python3 tools/g1-walkthrough.py
```

这一步会**起两个真进程**（承包商侧、供应商侧，各有自己的 realm 与账本），只通过 `tmp/g1-shared/`
共享目录交换文件，走完一轮八个动作：**发布 → 澄清广播 → 升版 → 报价 → 比价与 Flag → 授标 → 变更 →
审计包独立验证**。脚本最后按 `ADR-0014 §3` 的 MVP 判据逐条打印 `[ok]/[FAIL]`，并给出阶段时间线
（每个阶段一个进程、各自账本条目数）。退出码 `0` = 全部判据通过。

想手动看单侧每一步（每段都是一个独立进程）：

```sh
rm -rf tmp/manual && mkdir -p tmp/manual
PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 1   # 发布 + 分发
PYTHONPATH=src python3 -m quotagent.g1side supplier   tmp/manual 1   # 澄清提问
PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 2   # 作答广播 + 升版
PYTHONPATH=src python3 -m quotagent.g1side supplier   tmp/manual 2   # 报价（过人工门）
PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 3   # 比价 + 导出 + 授标意向
PYTHONPATH=src python3 -m quotagent.g1side supplier   tmp/manual 3   # 授标确认 + 变更请求
PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 授标承诺 + 变更生效 + 审计包
```

## 3. 验收门（要判定"能不能交付"时跑这个）

```sh
tools/verify.sh g1
```

它会依次跑：`events`（文档↔事件表一致性）→ `ac-registry`（AC 注册完整性）→ `audit`（审计包独立验证）→
`v`（人工验证登记表完整性）→ **全量 AC（`qa all`）** → **`g1-walkthrough.py`**（两个真进程的端到端走查）。
最后打印 `[ok] 阶段门 G1：MVP 判据全部可机检项通过`。单条 AC 可用 `tools/verify.sh ac <AC-ID>`。

## 4. 运行约束（不要绕过）

- **承诺类动作只能在两侧各自的人工门内发生**：桥（宿主 ↔ 内核）**只开 `read`/`compute`**，
  `quote.submit` / `award.commit` / `po.issue` / `change.approve` / `approval.decide` 只声明、**永不暴露**；
  调用即 `commit-refused` 并留痕。要提交报价/授标/发 PO，就在本侧用 CLI 走"请求批准 → 人签 → 提交"。
- **账本是唯一事实源**：批准记录、订单、授标承诺都从账本重放；`approval/*` 事件缺失时承诺路径会抛错。
- **同一账本文件同一时刻只能有一个 `Ledger` 实例在写**（两个实例各自从 `seq 1` 开始 → 哈希链断）。
- **私域字段不出 realm**：对外产物、模型输入、视图三处都不带对方不可见字段。

## 5. 排障

| 现象 | 原因与处理 |
|---|---|
| `无可用 Python 解释器` | 设 `QUOTAGENT_PY=/path/to/python3`，或先跑 `tools/bootstrap.sh` |
| `bridge.init` 报 `version-mismatch` | 帧里的 `accept_bridge` 必须是**版本字符串**（如 `["1.0"]`），不是数字 |
| `哈希链校验失败 / 账本已冻结` | 同一账本被两个写入者（或手工改过文件）；从 `docs/work/evidence/` 的包重放，不要手改账本 |
| `UnknownApproval` | 该批准不在**本侧账本**里（跨侧/跨 realm 的批准不通用），或账本被换过 |
| 门 `p0-no-node` 红 | 只在**非 P1** 阶段用于校验 P0 集合；若同时改了 AC 注册表，先跑 `tools/verify.sh ac-registry` |

## 6. 演示脚本（30–40 分钟，命令行）

1. `tools/verify.sh smoke && tools/verify.sh docs`（环境与文档：2 分钟）
2. `python3 tools/g1-walkthrough.py`（两个真进程走完一轮：5 分钟，逐条读判据）
3. `tools/verify.sh ac AC-APPROVE-002`（承诺面绕不过人工门：对抗性演示）
4. `tools/verify.sh ac AC-TRUST-001`（私域三处不可见：含非空转负控）
5. `tools/verify.sh audit`（审计包独立验证 + 篡改必失败）
6. `tools/run.sh -m quotagent.qa suite s4`（反例集全部被拦并留痕）
7. `tools/verify.sh g1`（总门：全量 AC + 走查，作为收尾）

## WebUI 与工作区接入（T-222）

WebUI 是 **cordis 插件** `webui`（`host/modules/webui.mjs`），由工作区服务 `quotagent` 拉起
（`tools/webui-serve.py`：带 `--healthz` 时走工作区健康契约，否则先跑一次 `g1-walkthrough.py --keep-shared`
拿到**真实**两侧账本，再 `exec` node 起 UI —— UI 展示的就是 MVP 门产出的数据）。

```bash
python3 tools/ws-integrate.py        # 幂等接入：登记服务+路由，并回读校验（直连 / 经网关 / dashboard 路由表）
curl -s http://127.0.0.1:8093/quotagent/api/health      # 直连
curl -s http://127.0.0.1:80/quotagent/api/status        # 经工作区网关（与 dashboard 同源）
# 公网（Cloudflare → 云端 NPM → ZT → 主机 NPM → ws-gateway）：https://<dashboard 域名>/quotagent/
```

- 双方视角：`/quotagent/contractor/`（承包商）与 `/quotagent/supplier/`（供应商）。
- 工作区清单 `/workspace/services/services.json` 里 `quotagent` 是**顶层服务键**（与 `dashboard` 同级），
  路由写在 `gateway.routes`；改完需**重启 gateway**（它启动时读路由表）。
- 门：`tools/verify.sh webui`（11 条断言：健康契约、两侧路由与内容差异、私域负控与非空转对照、
  坏数据不杀服务、dispose 后端口释放）。

### canary 接线与"必须重启"的纪律（T-230）

- UI 的视角投影由**独立插件** `projection` 提供，`webui` 注入它；canary 的分流就是作用在这条真实路径上
  （`host/lib/canary-dispatch.mjs`：按 key 选实现、回灌样本；候选失败回退 base，base 失败原样抛）。
- **改完宿主代码必须真的重启服务并回读**：本轮实测过——门全绿但 `cli.mjs` 的 `inject` 漏了 `projection`，
  `ws-gateway restart` 后服务起不来。命令：
  `python3 -c` 杀旧进程后 `/workspace/bin/ws-gateway start quotagent`（"already healthy" 不会重载代码），
  再 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8093/quotagent/api/health` 回读。

## P2 现状：三条视角道、桥路径中间件与门清单（T-249 更新）

### 1. 三条视角道（同一个网关前缀，从现有 dashboard 可达）

| 路由 | 谁看 | 看什么 |
|---|---|---|
| `/quotagent/contractor/` | 承包商 | **自己的账本**（投影白名单）：事件表 + 价格序列表 + 绩效记分卡 + 账本证据面 |
| `/quotagent/supplier/` | 供应商 | **自己的账本**：同上；私域键（`cost_floor` 等）在源头拒收 |
| `/quotagent/ops/` | 运维 | **不属于任何一方**：运行期中间件状态（governor/breaker/canary/audit）+ 各视角证据面聚合 + 自进化流水 |

本机自检（服务起在 8093）：
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8093/quotagent/api/health
curl -s http://127.0.0.1:8093/quotagent/contractor/api/scorecard | head -20
curl -s http://127.0.0.1:8093/quotagent/api/ops | head -30
```

### 2. JSON 接口一览

| 接口 | 内容 |
|---|---|
| `/quotagent/api/health` · `/api/status` | 存活 / 视角与账本健康（链自洽） |
| `/quotagent/api/obs` | 运行期观测（governor 准入 / audit 留痕 / canary 分流） |
| `/quotagent/api/ops` | 运维视角：`runtime` + `breaker` + `evidence_by_view`（按视角分别聚合）+ `evolve_journal` |
| `/quotagent/<view>/api/events` | 该视角的事件（已投影，只含公开字段） |
| `/quotagent/<view>/api/history` | 价格序列（按行项目：次数/最低/中位/最高/最新/趋势） |
| `/quotagent/<view>/api/evidence` | 账本证据面（行数/类型数/关联数/带引用行数/时间跨度） |
| `/quotagent/<view>/api/scorecard` | 供应商绩效记分卡（报价次数/价格分布/平均交期/偏差标记数） |

### 3. 桥调用路径上的中间件（顺序写死）

`idempotency-guard 判重 → circuit-breaker 准入 → 真调用 → breaker.record + idem.finish`

```bash
# 同一请求连发 3 次：只有第一次真的打下游，后两次复用结论
node host/cli.mjs bridge --profile contractor-ops --method ledger.count --idem-probe 3
# 6 个**不同**请求（params 带 probe 索引）：用来观察熔断/准入计数
node host/cli.mjs bridge --profile contractor-ops --method ledger.count --repeat 6
```

**语义区别（不要混）**：`--repeat N` = N 个**不同**请求；`--idem-probe N` = **同一**请求 N 次。
三个中间件分工：`governor` 管额度（放不放行/等多久/重试几次）、`breaker` 管连续失败就切断、
`idempotency-guard` 管"同一件事是不是已经做过"。

### 4. 门清单（`tools/verify.sh <门>`，全部 exit=0 才算绿）

`docs` · `plugins` · `modules` · `wiring` · `governor` · `bridge-canary` · `canary` · `canary-route` ·
`audit-hook` · `observability` · `breaker` · `breaker-route` · `idem-route` · `ops-view` · `evolve-journal` ·
`evolve-module` · `supplier-scorecard` · `idempotency-guard` · `webui` · `cordis` · `events` · `invariants` ·
`evolution` · `ac-registry` · `audit` · `v` · `p0-no-node` · `bridge` · `g1`（+ `clean-copy` 在干净副本里复跑关键门）

### 5. 自进化的日常操作（新增/演进一个插件）

```bash
# 1) 写候选产物（cordis 插件，须含 name/apply/Config/fixture）+ 一份围栏门（人工维护）
# 2) 干跑：提案 → 影子 → 真跑 fixture A1..A6 → 五项门
tools/cordis.sh run ../tools/evolve-module.mjs --source-file tmp/<产物>.mjs --name <name> --dry-run --evidence-refs EV-083
# 3) 带人工引用晋升（写入面仅 host/modules/）
tools/cordis.sh run ../tools/evolve-module.mjs --source-file tmp/<产物>.mjs --name <name> --approval-ref ap-0xxx --evidence-refs EV-083
# 4) 追溯与审计
tools/verify.sh evolve-module     # 产出记录里的哈希必须与进树文件一致（偷改即红）
docs/work/evolution-log.json      # 产出日志；tmp/evolve/ledger.jsonl 是账本（evolve/* 事件）
```

### 6. 排障（本仓库真实踩过的坑，按顺序查）

1. **网关 `start/restart` 报 "already healthy" 不会换代码**：先杀掉 8093 上的进程再 `ws-gateway ensure quotagent`，
   否则你会对着**旧进程**验证新功能。
2. **插件起不来 / `cannot get property "x" without inject`**：挂载包装的 `inject` 必须**照抄模块声明的 inject**；
   合成模块对象必须显式带 `inject` 字段（写 `inject: []` 会让模块取不到依赖）。
3. **`inject` 里新增了依赖**：四处同步（模块自身 / `host/check-modules.mjs` 的 STUBS / 门 `host/webui.mjs` 两处挂载 /
   `host/canary-dispatch.mjs` + `host/cli.mjs`），`tools/verify.sh wiring` 会机检。
4. **自己构造"看起来像下游返回"的对象**：必须与桥帧**同形** `{n, p:{id, m, result, error}}`（同形契约）。
5. **报告类脚本输出被截断**：不要用 `process.exit()`（大输出会截断）；用**带回调写入、回调里退出**。
6. **canary 探针"永远样本不足"**：探针键必须随索引变化（固定键会把所有探针送进同一条道）。
7. **AC 里不要写"相对当下的绝对时刻"**：门会随墙上时间自己变红/变绿。

## 三域运维面板（谈判 / FAQ / 邮件）

- 路由：`/quotagent/api/pipeline`（运维道）；页面上是 `<prefix>/ops/` 的「三域流水」区块。
- 数据来源（**分工**）：`tools/refresh-ui-snapshots.py` 从三个服务的 `replay()` **重建计数**，
  写 `tmp/ui-shared/pipeline.json`（**只读账本**）；宿主插件 `pipeline-view` 只做只读聚合。
  宿主**不**直连内核桥，也不自己算留存/谈判/FAQ 的判定。
- **刷新时机**：`tools/webui-serve.py` 在 **g1 走查 seed 之后**以及**每次健康探测**时各刷一次
  （走查会清空 `tmp/ui-shared/`，不补这一下面板会长期 `degraded`）。
- `transport` 字段：由 `services/mail_transport.py` 的**真实状态**派生（`services/mail.py` 的 `transport`
  就是它）。**没配凭据就是不可用**（`available:false` + `reason=mail-smtp-unconfigured`），
  配齐但还没真发过是 `mail-smtp-unprobed`，连不上是 `smtp-unreachable` —— 三种情形**分得开**。

## 邮件域（SMTP / IMAP）—— 真的收发于何时发生

- **真收发只在 Python 侧**：`src/quotagent/services/mail_transport.py`（纯标准库 `smtplib`/`imaplib`）。
  宿主（`host/**`）**不联网、不起子进程**，只读一份状态快照。
- **路由**：`GET /quotagent/ops/mail/`（页面，**0 行 `<script>`**）与 `GET /quotagent/api/mail`（JSON）。
  数据来源：`tools/refresh-ui-snapshots.py` 把「`mail/*` 账本计数」+「`mail_transport` 的真实状态」
  写成 `tmp/ui-shared/mail.json`，宿主插件 `mail-view` 只做有界只读投影（坏快照 → `degraded` + 有名 reason）。
- **配置键**（`host/lib/config-keys.mjs` + `host/lib/schema.mjs` 已登记，配置 UI 可直接改）：
  `mail.smtp.host/port/from/username/password/security`、`mail.imap.host/port/username/password/mailbox/security`、
  `mail.timeout_seconds`、`mail.max_messages`。端点与账号是**人工专属键**（改它们要带 `ap-NNNN` 人工引用）。
- **优先级**：环境变量（`QUOTAGENT_MAIL_SMTP_HOST` … 或配置 UI 的通用覆盖名 `QUOTAGENT_CONFIG_MAIL__SMTP__HOST`）
  **优先于** `/workspace/config.yaml` 的 `project` 段点分键；口令建议走环境变量（写进 YAML 等于明文落盘）。
- **凭据永不出门**：口令/账号在账本、响应体、日志、状态快照里出现次数为 0（异常消息也洗过）；
  收信有界（条数 + 单封返回体），被夹时如实报 `truncated`/`clipped`。
- **证据**：`tools/verify.sh mail-transport`（回环假 SMTP/IMAP 真收发的原始行 + 哨兵计数）。

### 面板数字是"演示种子"数据（重要）

`tmp/ui-shared/` 是**演示/联调账本**，不是生产数据。其中的谈判/FAQ/邮件事件由
`tools/ui-seed-pipeline.py` 用**真服务**跑出（写入者一律是 `human:ui-seed` / `agent:ui-seed`），
目的：让面板能端到端展示真实数据流。**读取这些数字时请记住它们来自演示种子。**

### 业务双方视角：谈判轮次与 FAQ 条目

- `/<view>/api/negotiation`：该视角的谈判计数（线程/轮次/被拒）与最近轮次（`thread_id#attempt(status)`）。
- `/<view>/api/faq`：该视角的 FAQ 条目计数（含涉及版本）与最近条目（`entry_id@rev<N>`）。
- 两者都**只读**快照切片（`tmp/ui-shared/pipeline.json`），**不出正文与私域键**；判定在 `services/*`。
- 页面（`/<view>/`）上对应「谈判轮次（本视角）」与「FAQ（本视角）」两个区块。

### 三域快照的两个口径（别混着读）

- **计数**（`negotiate.threads/rounds/rejected`、`faq.entries`）：走**服务回放**，只统计被服务跟踪的对象 —— 权威口径。
- **最近列表**（`negotiate.recent[]`、`faq.recent[]`）：走**账本原始行**，按 `seq` 倒序、至多 5 条 —— "最近发生了什么"。

两者**可以不一致**（例如计数 1、列表 5 条）。**读法**：计数看规模，列表看动态；不要用列表长度推计数。

## 门清单（44 道，全部可用 `tools/verify.sh <名>` 单独跑）

```text
ac-registry  approval-digest  audit-hook  breaker  breaker-route  bridge  bridge-canary  budget-guard  budget-route  canary  canary-route  clean-copy  cordis  coverage  docs  events  evolution  evolve-journal  evolve-module  faq  g1  governor  idem-route  idempotency-guard  invariants  mail  mail-transport  modules  negotiation  observability  ops-view  p0-no-node  pipeline-route  pipeline-view  plugins  retention  retention-view  smoke  supplier-scorecard  ui-mutate  ui-seed  v  webui  wiring
```

- 一键全套：`tools/verify.sh all`（不含 `ui-mutate` —— 它要跑 4 次真门，约 4 分钟，变更视图/快照实现时手动跑）。
- `clean-copy` 校验的是 **HEAD**（不是工作树）：所以正确次序是
  `verify.sh docs && <本批相关门>` → `git commit` → `git push` → **对新 HEAD 跑 `clean-copy`**。
- `ui-mutate`：逐处偷改实现，验证对应门**真的会红**（自带防假变异）。性质类断言（有界/定序/投影/幂等/只读）
  写完必须跑一次它。

### 系统管理道（admin，给 deployer / installer / admin）

- 入口：`/quotagent/admin/`（公网同前缀）。**未提权一律 401 固定体 `{"error":"unauthorized"}`**，
  与"未知子路径"同形（缺 token / 错 token / 未启用 / 会话过期 / 冷却中 五类不做区分，无 oracle）。
- 提权：任意一道 UI（`/contractor/`、`/supplier/`）页面底部有**管理员 token 表单**，
  或直接 `POST /quotagent/admin/api/elevate`（`token=<值>`，表单体）。成功后拿到
  `qa_admin=<不透明 id>`（`HttpOnly; SameSite=Strict; Path=/quotagent/admin`，非 token 派生）。
- 面板：`GET /quotagent/admin/api/blocks` → `{blocks, counts, progress, degraded, reason, next_action}`
  ——阻塞与进度都来自 **Python 侧真源**（`.agents/state.json` 的阻塞/人工项 + 进度清单 + 三域快照的 transport 不可用）。
  计数带 `counts.source` 口径说明；**源读不到就 `degraded=true`**，不会用"零阻塞"冒充健康。
- 切视角：`GET /quotagent/admin/api/switch?to=<contractor|supplier|ops|admin>` → 302。
  **切换只改导航与道可见性，不改变任何字段白名单**——管理员身份不是看到私域键的新路径。
- **token 供给（唯一两条链，都不进仓库、不进 argv、不进日志）**：
  1. 本机：`/workspace/config/quotagent-admin-token`（权限必须 **600**；本机已生成一个随机值，
     可自行替换：`printf '%s\n' '<新值>' > /workspace/config/quotagent-admin-token && chmod 600 …`）；
  2. 编排：环境变量 `QUOTAGENT_ADMIN_TOKEN`（由 `ws-gateway` 传进服务，服务再注入子进程环境）。
  没配 = **未启用**（fail-closed），并且面板会把"管理员 token 未配置"本身当成一条阻塞显示。
- 排障：提权一直 401 时，先看 `/workspace/logs/quotagent.log` 有没有
  `忽略 …：权限 0o644 不是 600` 或 `读 token 失败`；权限不对会被**拒绝加载**（不是静默使用）。
- **无暗门**：不存在"超时自动批准/自动解除"；会话过期只减权，已解除的阻塞与账本不受影响。

### 在 UI 内解阻塞（T-265 闭环）

1. 面板每条阻塞右侧有「提交材料」表单（或直接 `POST /quotagent/admin/api/blocks/<block_id>/resolve`，
   带会话与 `material=<值>`）→ 202；材料落在 `tmp/ui-shared/admin-submissions/<block_id>.json`（**0600**）。
   **此时账本没有任何新增**（宿主不写账本），面板上也**不会**假称已解决。
2. 由人（或经批准的操作）执行消费——这是唯一写账本的一步：
   `python3 tools/admin-apply.py --inbox tmp/ui-shared/admin-submissions \
      --ledger tmp/ui-shared/admin/ledger.jsonl --approval-ref ap-NNNN --actor human:<人名> --now <ISO>`
   落 `admin/block-pending` + `admin/block-resolved`（**body 不含凭据值，也不含字段名**），源件移入 `applied/`；重复消费幂等。
3. 快照刷新带上 `--resolutions tmp/ui-shared/admin/ledger.jsonl`（`ws-gateway` 探活钩子已带），
   面板随后显示 `blocked` 递减、`resolved` 递增。
4. 反例：缺 `--approval-ref` → 退出码 2 且拒绝（人工门不可绕过）；无会话提交 → 401。
5. 已知边界：`approval_ref` 目前**只校验形状**（`ap-NNNN`），尚未与批准记录对照（登记 T-265b2）；
   凭据提交后**不会**自动接进服务（如 SMTP 传输仍需 T-259）。

### 门清单更新
`tools/verify.sh help` 打印全部（从脚本自身解析，不再手写）。本轮新增 `admin-route`。
