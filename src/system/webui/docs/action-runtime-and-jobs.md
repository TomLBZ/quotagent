# 批量动作的**动作运行时**（真异步 · 限并发 · 不丢工作）· 唯一写者闸门

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md` §19/§20（规则真源不在本页）；
     本页只讲 **P21 的实现与实测**：批量动作怎么从"同步串行"变成"真异步/限并发"、
     代价是什么（写者闸门）、进度与逐条结果落在哪、复跑命令与原始读数在哪。
     读数与截图：`tmp/p21-shots/`；行为回归：`tmp/p21-shots/scale-out.txt`（A–F 全绿）。 -->

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
4. **中断**：进程被杀之后，`jobs.json` 里那一条还写着 `running`；下一次读（`jobsLoad()`）把**上一个进程**的
   `running/queued` 改成 `interrupted`，并用进度里的写者回执推出 `pending_ids`（没跑过的那些）与 `refused_ids`。
5. **worker 不是第二个写路径**：它不认账本、不 import 任何账本写入 API，`spawnSync` 的仍是那个唯一写者。

## 3 实测（真跑；夹具是私有数据目录，真实账本零新增）

一次调用 50 份真草稿，另一个客户端同时翻页 + 写（`tmp/p21-shots/scale-concurrent.py`）：

| 读数 | P20（同步串行） | P21（动作运行时） |
|---|---|---|
| 批量期间**另一个客户端的翻页** | **11 703 ms**（1 条，0 条完成） | **p50 6 ms / p95 199 ms / max 213 ms**（121 条，全完成） |
| 批量期间**另一个客户端的写** | **11 704 ms**（1 条，0 条完成） | **p50 303 ms / p95 354 ms / max 407 ms**（51 条，全完成） |
| 50 份端到端（无并发负载） | 11.65 s | **12.93 s**（259 ms/份，`runtime=worker`） |
| 40 份端到端 | 4.27 s（43 条） | 见 `tmp/p21-shots/batch-timing.txt` |
| 账本链 | （批量期间写者互斥，无人并发） | **两侧链完整**（1122/664 行 `ok:true`）—— 闸门生效的判据 |

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
