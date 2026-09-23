# 批量动作的**动作运行时**（真异步 · 限并发 · 不丢工作）· 唯一写者闸门

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md` §19/§20（规则真源不在本页）；
     本页只讲 **P21 的实现与实测**：批量动作怎么从"同步串行"变成"真异步/限并发"、
     代价是什么（写者闸门）、进度与逐条结果落在哪、复跑命令与原始读数在哪。
     读数与截图：`tmp/p21-shots/`（P21）、`tmp/p23-shots/`（P23 复跑：中断恢复全链 + 夹具错根因）；行为回归：`tmp/p21-shots/scale-out.txt`（A–F 全绿）。 -->

## 0 一句话

**批量动作（一次署名 · 逐份落账的那几颗）的服务端一半搬进了一个 worker 线程**：
插件代码照旧同步跑、照旧 `spawnSync` 唯一写者，但阻塞的只是那个线程 —— 主线程照常服务别人的翻页与写。
代价是一条**must**：写者之间必须显式互斥（`writer.queue` 票据 + `writer.lock` 原子争锁），
因为 Python 侧唯一写者 append JSONL 时不是并发安全的；没有这条闸门，实测会出现**重复 seq / 断链 ⇒ 账本冻结**。
进度与逐条结果落 `<ui_shared>/webui/jobs.json`（0600、原子写、有界）⇒ 刷新或进程崩了都读得回"这一批到哪了"。

## 1 机制（都在 `code/app-shell.mjs`，零业务语义）

| 件 | 位置 | 判据 |
|---|---|---|
| **认"这是批量动作"** | `batchIdsOf(action, input)` | 注册面声明 `action.input.bulk === 'ids'` 且 `input.ids` 非空 —— **不认插件 id、不认业务名词** |
| **动作运行时** | `ACTION_RUNTIME_ENTRY` + `runInActionRuntime()` | worker 线程里 `import` 磁盘上那个 `code/ui.mjs`、用只含机制的 `host` 注册、再调它自己的 `server(ctx, input)`；`spawnSync` 阻塞的是 worker 不是主线程 |
| **并发上限** | `job_concurrency`（默认 1，`QUOTAGENT_UI_JOB_CONCURRENCY`） | 批量之间排队；**动作不被拒**（拒绝只给渲染重读，见 §20 ④） |
| **唯一写者闸门** | `WRITER_GATE` / `writerGateTicket` / `writerGateTry` / `writerGateTakeSync` | 文件锁 + FIFO 票据：主线程动作**动作级**取放（`await`，不阻塞事件循环）、worker **逐次写者调用**取放（`Atomics.wait`）；批量动作不取动作级闸门（否则与 worker 互等 ⇒ 死锁），退回主线程执行时才现取 |
| **进度** | `jobOnProgress()` | worker 每跑一次写者发两条进度（`writer-start` / `writer-done`，带 `--<x>-id` 那个值当"正在处理哪一条"）；主线程更新记录并按 150ms 节流落盘 |
| **逐条结果** | `jobItemsOf()` / `jobCountsOf()` | 从插件自己的 `result.results[]` / `result.batch` **照抄**（`where`/`code`/`ledger_added`/`reason`/`next_action`），机制不做任何判定 |
| **读回** | `GET /api/ui/jobs`（只读，POST 孪生 405 + `Allow: GET`） | `running`（正在跑的那一批：`done/total`、`active.target`）+ `recent`（含 `interrupted` + `pending_ids`/`refused_ids`）；**按会话身份隔离**、未登录 401 |
| **界面侧** | `code/assets/app.js` | 提交期间轮询 `/api/ui/jobs` 显示"正在逐份落账 N/M · 当前是哪一条"；回执弹层给「只重试被拒/未完成的 N 份」；`batch-too-large` 给「只签前 N 份」（N 取服务端自己说的那个数） |

**语义一条没松**（这是本批的红线，实测见 §3）：一次署名、**逐份落账**（每份各跑一次 `quote-sign.py --draft-id`）、
每份**可独立拒绝**、部分失败**逐条**如实、幂等（`already-signed`，账本零新增）、一次上限 50 具名拒（`batch-too-large`）。
机制**不重写插件判据**：运行时里跑的就是同一份 `code/ui.mjs`。

**运行时只拿到机制**：`config` / `sharedDir` / `now` / `runPython` / `stage`（与主线程**同一个** `pendingPayload()` 纯函数
⇒ 同名待命件判据不漂）/ `writerReceipt` / `receiptFileName` / `rows`（只读 JSONL）；
`digest`/`report`/`collab`/`people`/`service` 这些拿不到的会**抛错**，主线程据此**回退到原样执行**（`wrote:false` 才回退；
已经动过手的绝不重跑冒充新结果 —— 那会造出重复）。

## 2 代价与边界（如实登记）

1. **写者必须排队**（§0 的 must）：批量进行中，另一个人的**单条写**要等到当前那一条写完（FIFO 票据，实测 p50 ≈ 300ms），
   不排队就会撞坏账本链。只读（翻页/通知/状态）**完全不排队**。
2. **运行时的 host 面**是"机制的那一半"：批量动作目前只用到 `runPython`/`stage`/`writerReceipt`/`sharedDir`/`now`/`config`。
   将来某个批量动作用到 `host.digest()` 这类运行时拿不到的能力 ⇒ 该动作会自动**回退主线程执行**（结果一样，只是会冻结），
   `io.jobs.inline_fallback` 会 +1 并在日志里说明 —— 不静默。
3. **并发读可能撞上写者的 append**（真异步的固有面）：读路径（`rows()`）不做加锁；P21 压测中批量期间发出的
   121 次翻页/读请求全部成功（没有撕裂行）。要彻底消除这一面得让读也进闸门（那会把读变慢，本批没做）。
4. **中断与恢复**（P23 真跑读数见 §5.2）：进程被杀之后，`jobs.json` 里那一条还写着 `running`；下一次读
   （`jobsLoad()`）把**上一个进程**的 `running/queued` 改成 `interrupted`，并用进度里的写者回执推出 `pending_ids`
   （没跑过的那些）与 `refused_ids`（跑过但被写者拒的）——**当场落盘**，所以刷新/换设备读回的是同一份"到哪了"。
   界面据此摆「上一批没有跑完 + 只重试剩的 N 份」。
   **如实面**：重试是**新的一批**（新 `job.id`），旧的中断记录保留它的 `pending_ids`（那是历史）⇒ 提示条
   每次加载会重现（点「知道了」关掉即可）；重试幂等（已落账的报 `duplicates`、账本零新增），所以那是噪音不是错误。
5. **worker 不是第二个写路径**：它不认账本、不 import 任何账本写入 API，`spawnSync` 的仍是那个唯一写者。

## 3 实测（真跑；夹具是私有数据目录，真实账本零新增）

一次调用 50 份真草稿，另一个客户端同时翻页 + 写（`tmp/p21-shots/scale-concurrent.py`）：

| 读数 | P20（同步串行） | P21（动作运行时） |
|---|---|---|
| 批量期间**另一个客户端的翻页** | **11 703 ms**（1 条，0 条完成） | **p50 6 ms / p95 199 ms / max 213 ms**（121 条，全完成） |
| 批量期间**另一个客户端的写** | **11 704 ms**（1 条，0 条完成） | **p50 303 ms / p95 354 ms / max 407 ms**（51 条，全完成） |
| 50 份端到端（无并发负载） | 11.65 s | **6.69 s**（134 ms/份，P23 复跑）；同批代码 P21 那次读到 **12.93 s**（259 ms/份，`tmp/p21-shots/batch-timing.txt`）——两次都在 11.7 s 的下界之上、量级由 11.7 s 降到 6.7–12.9 s，**如实并列** |
| 40 份端到端 | 4.27 s（43 条） | **4.28 s**（107 ms/份，`runtime=worker`；`tmp/p23-shots/fixed-run.txt`） |
| 30 份端到端（跑到第 4 份时被杀） | — | **中断恢复**：`interrupted total=30 done=4 pending=26` ⇒ 只重试 26 份 ⇒ `applied 25 / duplicates 1`、账本 **supplier +75 / contractor +25**、重复落账 **0**（§5.2） |
| 账本链 | （批量期间写者互斥，无人并发） | **两侧链完整**（`ok:true`，595 / 402 行）—— 闸门生效的判据 |

**没有闸门时的反证**（同一批代码，只去掉闸门）：50 份批量与另一客户端的 `rfq.publish` 并发写 ⇒ 供应商账本出现
重复 `seq 309` / 断链 ⇒ 写者自己发现并**冻结账本**（`ledger-frozen`，49/50 被拒）。读数：
`tmp/p21-shots/concurrent-broken-chain.json`、本页 §4。这条反证就是"闸门是必需的、不是优化"的判据。

## 4 复跑

```bash
# 夹具（私有目录，绝不碰真实账本）
mkdir -p tmp/p21-scale-run && sh tmp/p21-shots/start.sh 8462 $(pwd)/tmp/p21-scale-run
python3 tmp/p21-shots/seed-scale.py                      # 45 包 / 45 份待签草稿 / 12 条门
python3 tmp/p21-shots/scale-verify.py --port 8462 --data tmp/p21-scale-run   # A–F 行为回归（全绿才继续）
python3 tmp/p20-shots/seed-drafts.py --port 8462 --n 60 --start 2000 --out tmp/p21-shots/p21-more-ids.json
python3 tmp/p21-shots/scale-concurrent.py --port 8462 --take 50 --ids tmp/p21-shots/p21-more-ids.json
# 端到端耗时 + 部分失败只重试被拒项 + 进程中断（工作不丢）
python3 tmp/p21-shots/batch-timing.py --port 8463 --data tmp/p21-scale2-run
# 停服务（按端口，不盲用 pkill）
python3 tmp/p21-shots/stop-by-port.py 8462 --kill
```

**P23 复跑（中断恢复那条，一条命令跑完 40/50 份 + 只重试被拒项 + SIGKILL 恢复）**：

```bash
sh tmp/p23-shots/start.sh 8472 $(pwd)/tmp/p23-run          # 私有数据目录，绝不碰真实账本
python3 tmp/p21-shots/seed-scale.py --port 8472            # 45 包 / 45 份待签草稿 / 12 条门
python3 tmp/p23-shots/batch-timing.py --port 8472 --data tmp/p23-run   # 退出码 0 = PASS（读数 fixed-run.txt）
python3 tmp/p23-shots/reconcile.py  --data tmp/p23-run     # 两侧账本行数对账（不重复落账）
python3 tmp/p23-shots/probe-jobs-shape.py --port 8472 --data tmp/p23-run  # 抓一次 running[0] 的键集
```

`batch-timing.py` 与 `batch-timing-bug.py` 只差**三行变量名**（见 §5.3），后者是"复现那个夹具错"用的负控。

## 5 P23 的读数、字段清单与一次夹具错的根因

### 5.1 字段清单与配置项（主文件 §19/§20 与归档只给判据，形状在这里）

* `GET /api/ui/jobs` 的响应：`running[]` / `recent[]`（每项 = `jobDescribe()`：`id/action/title/plugin_id/
  actor/side/view/status/total/ids/started_at/finished_at/ms/code/ok/reason/next_action/items/progress/done/
  applied/duplicates/refused/ledger_added/pending_ids/refused_ids/runtime/runtime_note`）、`io`（`started/done/
  failed/interrupted/offloaded_items/running/peak_running/inline_fallback/concurrency/running_now/queued`）、
  `concurrency`、`file`、`schema`。
* `progress[]` 两种行：`{phase:'writer-start', tool, target, at}` 与 `{phase:'writer-done', target, code,
  ledger_added, ms, at}`（`code` 非空 = 这一条被写者拒了 ⇒ 恢复时进 `refused_ids`）。
* `jobs.json` 的**有界**：`JOB_LIMITS = {keep 12, items 200, progress 24, target_chars 80}`；进度节流 150 ms。
  ⚠ `progress 24` 意味着**长批次早期的写者回执会被滚掉** ⇒ 恢复时推出来的 `pending_ids` 会**偏大**（把做过的
  也算进去），这正是"只重试剩下的"必须幂等的原因（做过的会如实报 `duplicates`）——P23 的 26 份里就有 1 份如此。
* 配置项：`QUOTAGENT_UI_JOB_CONCURRENCY`（默认 1）/ `QUOTAGENT_UI_JOB_TIMEOUT_MS`（默认 0 ⇒ 按份数推）/
  `QUOTAGENT_UI_WRITER_WAIT_MS`（默认 120000）/ `QUOTAGENT_UI_NOTIFY_CACHE_MS`（默认 5000）/ `QUOTAGENT_UI_SHED_MS`（默认 3000）。

### 5.2 中断恢复全链读数（真跑，`tmp/p23-shots/fixed-run.txt`）

| 步 | 读数 |
|---|---|
| ① 30 份批量跑到第 4 份时 **SIGKILL** | 客户端只看到连接断（`RemoteDisconnected`）——正是要修的场景 |
| ② 重启（**同一份夹具，只改了三行变量名**） | 登录 200（对照：见 §5.3） |
| ③ `GET /api/ui/jobs` | `status=interrupted total=30 done=4 applied=0 refused=0 pending=26 progress=8` + 自述 `runtime_note` |
| ④ **只重试 `pending_ids` 那 26 份** | `HTTP 200 code=batch-submitted`、逐条 `applied 25 / duplicates 1 / refused 0`、账本 **supplier +75（=25×3）/ contractor +25（=25×1）** |
| ⑤ 不重复落账 | `quote/submitted` **155 条 / 155 个不同草稿、重复 0**（`tmp/p23-shots/reconcile.txt`） |
| ⑥ 链完整性 | 两侧 `ok:true`（595 / 402 行） |
| ⑦ 只重试被拒项（另一条用例） | 5 真 + 3 假 ⇒ `applied 5 / refused 3`（`batch-partial`）⇒ 再提那 3 份 ⇒ 仍 3 条具名拒、**两侧 +0** |
| ⑧ 界面侧 | 提交期间轮询进度「正在逐份落账 N/M」；重启后摆「上一批没有跑完：…还没做的 26 份（进程中断过）」+「只重试剩下的 26 份」（截图 `tmp/p23-shots/p23-narrow-844x390.png`） |

### 5.3 一次**夹具错**的根因：SIGKILL 后 login 报 `ENAMETOOLONG`（不是产品缺陷）

**现象**：上一批在其私有夹具下注册过一条待查 —— SIGKILL 后重启的服务上 `POST /identity/login` 稳定回
`400 {"code":"session-write-failed","reason":"Error: ENAMETOOLONG: name too long, mkdir
'<仓库根>/{'id': 'job-…"}`，而仓库根目录里还多出一个 166 B 长的空目录
`{'id': 'job-…'plugin_id': 'domain`。

**根因（已复现，机制可复核）**：夹具 `batch-timing.py` 把**数据目录**存进变量 `run`，随后在"等这批真跑起来"的
探针循环里**复用了同一个变量名**装 HTTP 响应里的那一批：

```python
run = ROOT / args.data                                    # ← 数据目录
for _ in range(60):
    _c, seen, _m = request(probe, base, "/api/ui/jobs")
    run = (seen.get("running") or [{}])[0] or {}          # ← 覆盖成 `running[0]`（job 记录的 repr）
...
subprocess.Popen(["sh", start.sh, str(args.port), str(run)], ...)   # ← 于是把 job 记录当数据目录传下去
```

`start.sh` 把第 2 个参数当 `RUN`，散给 `--ui-shared`/`--ledger-*`/… ⇒ 服务**带着 3.3 KB 的参数启动**，
`identity` 的会话目录变成 `<工作目录>/{'id': 'job-…`（>4096 B 的路径 + 里面还夹着 `/`）⇒ `mkdir` 先建出
第一个分量、再因后面的分量过长而 `ENAMETOOLONG` ⇒ 登录必失败。`/proc/<pid>/cmdline` 里能逐字看到这件事。

**为什么产品侧没有这个取值路径**（判据，逐条可查）：

1. `ui_shared` 的唯一来源是 **CLI 参数 / 环境变量 / 默认值**（`host/cli.mjs` 四处
   `String(args['ui-shared'] ?? process.env.QUOTAGENT_UI_SHARED ?? 'tmp/ui-shared')`）——**没有任何一处从
   文件内容推导路径**；插件只是被注入配置，不参与推导。
2. `jobs.json` 的读取面**只有一处**（`app-shell.mjs#jobsReadDoc()` 的 `readFileSync(jobFile())`），它只取
   `doc.jobs` 数组，之后只进 `jobsLoad()/jobsOf()` ⇒ **序列化成 HTTP 响应体**；响应体不是 argv/env。
3. `identity.mjs#saveSessions` 的目录 = `join(sharedDir, 'identity')`，而 `sharedDir = resolve(root, config.ui_shared)`
   —— 路径的唯一输入就是第 1 条那三处。
4. 被喂进去的那个字符串的形状本身就是"HTTP 响应体"：它带 `pending_ids`/`done`/`refused_ids`/`runtime`/
   `runtime_note`（**只由 `jobDescribe()` 产生**，jobs.json 里根本没有这些键），而缺 `active`/`heartbeat_at`/
   `pid`/`saved_at`/`updated_at`/`writers_done`（只在文件里的内部记账）。P23 还把"进行中的 `running[0]` 键集"
   与"复现时 argv 里那个值的键集"逐一比对过：**28 : 28 全等**（`tmp/p23-shots/shape-probe.txt`）。
5. **修法与负控**：只改那三行变量名（`run` → `active`），其余一个字没动 —— 同一份夹具、同一批数据、
   同一串用例：**修前 FAIL（login 400 + ④-1 红）→ 修后 PASS（0 失败）**。`tmp/p23-shots/fixture-fix.diff`
   就是全部改动；**原始夹具 `tmp/p21-shots/batch-timing.py` 也已同样修好**（免下一个人再踩），
   `tmp/p23-shots/batch-timing-bug.py` 保留为可复跑的负控（它当初在仓库根目录留下的空目录已删）。

**复跑命令**（复现根因）：

```bash
sh tmp/p23-shots/start.sh 8472 $(pwd)/tmp/p23-run && python3 tmp/p21-shots/seed-scale.py --port 8472
python3 tmp/p23-shots/batch-timing-bug.py --port 8472 --data tmp/p23-run --only-interrupt   # 复现（traceback + 400）
python3 tmp/p23-shots/rootcause-proof.py                                                    # 根因证据链
python3 tmp/p23-shots/batch-timing.py     --port 8472 --data tmp/p23-run                    # PASS
```
