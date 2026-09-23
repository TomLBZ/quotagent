# 并发下的表现：卡死怎么**定位**、怎么修、读数是多少（P13）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = 完整 GUI 应用）；本页只讲**性能/并发**：
     热点在哪、修了什么、修前修后的可复跑读数、正确性怎么证、边界在哪。 -->

本页回答五件事：**卡死的现场**（可复跑）、**CPU 热点在哪**（`node --cpu-prof` 原始读数）、
**改了什么**（三处机制，不动内核、不改语义）、**修前修后逐项读数**、**正确性怎么证**（不会读到旧值）。
原始证据都在 `tmp/p13-shots/`。

## 0. 一句话口径

> 卡死不是"并发太多"，是**同一份账本被反复读+解析、同步占满唯一的主线程**：
> 打开一页会把 1.6 MB 的账本读+parse **几十上百遍**（忙时 CPU 的 ~87% 花在这里）。
> 修法 = 按 `(路径, mtime, size)` **备忘"投影后的行"**（一次渲染只读一次盘）+ 通知聚合加**短 TTL 备忘**
> + 万一还是过载就**明确拒绝新到的重读请求**（`429 + Retry-After`，如实说"服务端忙"）。
> 并发仍然并发：没有把谁排进单道队列，也没有关掉任何功能。

## 1. 卡死的现场（先能复现，才谈得上修）

`tmp/p13-concurrent.py`：N 个并发客户端（各自独立 cookie 会话）在同一份规模数据上做**混合动作** ——
首屏 `panels?w=1`、`notifications`（界面每 15 s 轮询的那条）、`status`、翻页、关键字搜索、点列头排序、
两个写动作（`export.columns` / `collab.toggle-watch`），外加一个**独立健康探针**线程每 1.5 s 打一次
`/api/ui/status`（用来区分"某个大请求慢"与"服务端对所有人都没反应"）。

**修前（HEAD=46de365 的原样代码，6 客户端 / 3 轮 / 20 s 判 stall，`tmp/p13-shots/concurrent-before.json`）**：

| 类别 | n | p50 | p95 | max |
|---|---|---|---|---|
| notifications | 6 | **34.6 s** | 45.9 s | **53.7 s** |
| status | 6 | **24.4 s** | 37.2 s | **46.1 s** |
| panels-first | 6 | 3.8 s | 5.8 s | 6.5 s |
| 健康探针 | 3 | 14.9 s | — | **44.0 s** |

判定：**服务端卡死**（健康探针也超时 ⇒ 不是"某个请求慢"，是对所有人无响应）；跑满 66.7 s 才完成 54 条请求
（脚本按"累计 4 次 stall"提前收工）。与 P12 记录的"`/api/ui/status` 50 s 无响应、进程 100% CPU 37 分钟、
只能 kill"是同一条现场。

## 2. 定位：CPU 热点在哪（**先定位再修**）

`node --cpu-prof --cpu-prof-interval=500` 抓修前代码在**同一段并发负载下**的 profile，
`tmp/p13-prof-analyze.py` 按**自用时（self time）**聚合（读数：`tmp/p13-shots/cpu-before.json`）：

| 自用时占比 | 位置 | 是什么 |
|---|---|---|
| **27.2 %** | `src/system/kernel/code/ledger-view.mjs:20` | `read()` 里**逐行 `JSON.parse`** |
| **22.9 %** | `node:fs:473 readFileSync` | 把整份账本**从盘上重新读一遍** |
| 4.2 % | `ledger-view.mjs:18 read()` | 行切分/组装 |
| 2.1 % | `readFileUtf8` | UTF-8 解码 |
| 1.9 % | GC | 上面这些临时对象的账 |
| 4.5 % | `child_process spawnSync` | 插件自己的 Python 只读调用（**不是**主因） |

按文件汇总：`ledger-view.mjs` 31.9 % + `node:fs` 22.9 % + native 里的解码 2.1 % ⇒ **忙时 CPU 的约 87 %
花在"把同一份账本重新读+parse"上**（idle 35 % 不算）。为什么这么多遍：

* `webui.mjs` 的 `ledgerOf(view)` 每次调用都 `openLedger(path)` —— 这个闭包里**只有 `verify()` 有 mtime 缓存**，
  `rows()` 每次都真读盘 + 逐行 parse；
* 而 `rowsOf(view)` 被 `host.rows(view)` 在**每块面板**（27 块）、**每个通知源**（13 个）、**每个状态项**里各调一次；
* 一切**同步**跑在 Node 唯一主线程上 ⇒ 一个请求的渲染期间，别的请求连事件循环都进不来（"并发"退化成排队）。

**这把尺子是可读的**：`/api/ui/surface` 的 `io.ledger` 给出 `memo_hits / parses / ms / bytes`。
修前形态 = **每次提问都真读一遍**；修后同一段负载下 `memo_hits` 241 次、`parses` 只 2 次（见 §4）。

## 3. 改了什么（三处机制；不动内核、不改语义、不关功能）

1. **账本只读备忘**（`code/webui.mjs`）：按 `(路径, mtimeMs, size)` 缓存"投影后的行"（`rows()`），
   文件没变就直接复用；`rows()` 每次返回**新数组**（元素对象是同一个只读投影）。
   账本 append-only ⇒ 任何一次落账都会让 mtime/size 变 ⇒ **不会读到旧值**（§5 有写入后读回的实测）。
   同理缓存了**投递信封**与**投影结果**（纯函数，输入没变就复用）。
2. **通知聚合短 TTL 备忘**（`code/app-shell.mjs`）：键 = 会话身份 + 沙盘目录（通知源按人给"我的/@我/我关注的"），
   TTL 默认 5 s（`QUOTAGENT_UI_NOTIFY_CACHE_MS` / 配置 `notify_cache_ms`，**0 = 关**）；
   **任何一次动作/落待办件/清只读缓存都会清掉它**；命中与否、缓存龄在 `io.notify` 与状态栏里如实记账。
3. **渲染准入（背压）**（`code/app-shell.mjs` + `code/webui.mjs`）：判据是**事件循环真的滞后了多少**
   （`perf_hooks.monitorEventLoopDelay`）。滞后 ≥ 阈值（`QUOTAGENT_UI_SHED_MS` / 配置 `shed_ms`，默认 3000ms，
   **0 = 关**）时，新到的**重读**请求回 `429 + Retry-After` + `{code:'ui-busy', loop_lag_ms, retry_after_ms,
   next_action}` —— **不当场开始读**（不占队列、不读半份数据）。
   只对重读路由生效：**动作（`/api/action/*`）、身份、偏好读写、健康与静态资源一律不拒**。
   界面（`assets/app.js`）按 `Retry-After` 自动重试（有界），并在状态栏把连接灯切成"服务端忙（等 X ms 重试 ·
   滞后 Y ms）"—— 三个状态（正常 / 忙 / 失败）长得不一样、互不冒充。

## 4. 修前 / 修后（同一份数据、同一批请求、同一台机器）

数据目录 `tmp/p13-run`（= `tmp/p12-run` 的副本：承包/供应商账本 6865 / 8150 行，3200 条报价登记）。
修前 = HEAD 原样；修后 = 本批改动。**每次对比都用刚起的干净服务**（避免把积压算成"渲染慢"）。

**① 单客户端、顺序请求（`tmp/p13-probe-routes.py` / `tmp/p13-probe-shapes.py`）**

| 路由 | 修前 | 修后 | 变化 |
|---|---|---|---|
| `/api/ui/notifications` | **8.89 s** | **0.094 s** | −98.9 % |
| `/api/ui/panels?view=contractor`（**全量** 6.9 MB） | 1.42 s | 0.165 s | −88.4 % |
| `/api/ui/panels?view=contractor&w=1`（**界面默认 URL**） | 0.82 s | 0.108 s | −86.8 % |
| `/api/ui/panels?view=supplier&w=1` | — | 0.039 s | — |
| `/api/ui/status` | 0.96 s | 0.668 s | −30 %（剩下的是一次插件自己的只读 Python 调用） |
| `/api/ui/object?...&w=1` | 0.14 s | 0.070 s | −50 % |

**② 首屏字节/行（这层没变，见 §6 ② —— 它本来就已经是窗口化的）**

| 形态 | 字节 | 下发行 | 面板给了几行 |
|---|---|---|---|
| 界面默认 URL（`w=1`，承包商） | **271,340 B** | **295** | 9,900 |
| 不带 `w` 的全量（脚本/旧客户端） | 6,916,846 B | 9,900 | 9,900 |
| 界面默认 URL（`w=1`，供应商） | **183,105 B** | **218** | 8,220 |
| 不带 `w` 的全量（供应商） | 4,402,495 B | 8,220 | 8,220 |

**③ 并发（6 客户端 / 3 轮；`tmp/p13-shots/concurrent-after.json`）** —— 修前那份因 stall 提前收工，
这里给"跑满"的读数：

| 类别 | 修前 p50 / max | 修后 p50 / p95 / max |
|---|---|---|
| notifications | 34.6 / 53.7 s | **0.39 / 1.29 / 1.30 s** |
| status | 24.4 / 46.1 s | **0.13 / 0.36 / 0.40 s** |
| panels-first | 3.78 / 6.52 s | **0.94 / 1.42 / 1.42 s** |
| page / search / sort | 1.32 / 0.63 / 0.62 s | **0.12 / 0.13 / 0.11 s** |
| 写动作（偏好 / 协作） | — | 0.03–0.07 s（p95 ≤ 0.69 s） |
| **健康探针** | 14.9 / 44.0 s | **1.30 / 1.88 / 1.68 s** |

修后：**144 条请求全部完成、0 次 stall、墙钟 7.67 s**（修前：66.7 s 才 54 条且判"卡死"）。
再加码（**12 客户端 × 4 轮 = 372 条**，`concurrent-after12.json`）：0 stall、墙钟 16.2 s、最大 2.12 s、
健康探针最大 2.23 s。

**④ 浏览器里真量（真 Chrome，`/app/<view>/`）**

| 读数 | 修前 | 修后（空闲） | 修后（同刻 4 个客户端在压） |
|---|---|---|---|
| 承包商首屏就绪（导航 → 最后一次重画） | 11.5 s（P12：9.0 s / 4 人在线 38.6 s） | **951 ms** | — |
| 供应商首屏就绪 | 38.6 s（P12，4 人在线） | **899 ms** | **1,347 ms** |
| 首屏 `notifications` 请求 | 10,200 ms | 709 ms | 210 ms |
| 首屏 `status` 请求 | 11,146 ms | 729 ms | 229 ms |
| 首屏 `panels?w=1` | 1,381 ms | 647 ms | 81 ms |
| 3200 行面板点「单价」列头 → 重画完 | 690 ms（空闲）/ **6,858 ms**（P12，4 浏览器） | **135 ms** | — |
| 页面内读数 | `rows_api` 304 / `rows_full_server` 9,909 | `rows_api` 295 / `rows_full_server` 9,900 | 同 |

排序那 135 ms 里只有**一次**该面板的窗口请求（`only=rfq.responses`，22,854 B）——
p12 那份 6.9 s 是**排队**（服务端被通知聚合占住），不是本地排序慢。

## 5. 正确性：性能不得换来错的数字，也不得读到旧值

1. **与"全量基线"逐项对账（HTTP 层，`tmp/p11-reconcile.py`）**：服务端窗口 vs 不带 `w` 的全量基线，
   132/132 条一致（8 块表的默认窗口、4 组关键字、3 组数值区间、2 组枚举、2 组组合、0 命中、
   3 列 × 升/降/取消、5 组翻页 + 越界夹取 + `size=0`、桶筛选、小计、坏参数、`only` 未知 ⇒ 404、
   不带 `w` ⇒ 整份下发）。证据 `tmp/p13-shots/reconcile-http.json`。
2. **浏览器层对账（真打字/真点列头/真翻页，`tmp/p11-reconcile-browser.js`）**：31/31 条一致
   （读 `data-count-*` 与 DOM 行，与第二份独立实现比）。证据 `tmp/p13-shots/reconcile-browser.json`。
   *坑（如实记）：* 查询状态（关键字/排序/每页行数）**按身份镜像到服务端**，所以**先手工点过排序**再跑这个
   对账脚本，前两条"第一页=全量前 25 行"会失败 —— 那是**基线没带上你的排序**，不是窗口算错；
   点一下「清空查询」再跑即 31/31（本轮就是这么拿到全绿的）。
3. **写入之后不许读旧值（`tmp/p13-stale-check.py`，5/5）**：在副本目录上跑真写动作 `exchange.ask`
   （唯一写者 `clarify-apply.py`）⇒ 两侧账本 md5 都变了（6865→6866 / 8150→8151）⇒ 下一次读**重新读盘**
   （`io.ledger.parses` 2→3）且**这次写进去的唯一标记出现在读回的面板数据里**。证据 `stale-check.json`。
4. **负控（`tmp/p11-negative.py`，11/11）**：未登录 401 `identity-required`、越侧 403 `side-mismatch`、
   替别人署名 403 `signer-mismatch`、一串只读窗口请求（含 `keys=true` / `size=0` / 坏参数）前后
   **账本 md5、待办件目录、偏好逐个一致**、供应商视图不泄漏承包商专属面板。
5. **背压本身的两条正负控（`tmp/p13-busy-verify.py`）**：低阈值（40ms）下 12 条并发重读确有被拒的
   （`429 + Retry-After: 1`，体里带 `loop_lag_ms=104 ≥ shed_ms=40` 与"多久后重试"），**同刻动作/身份/偏好/健康全 200**；
   `shed_ms=0`（关闭）时同样的突发**一条都不拒**。
6. **存量门**：`python3 src/system/webui/tests/check-webui.py` → **PASS（webui 门 47/47）**（含 T-234 背压那条）。

## 6. 两件如实要说清的事（否则读到这页的人会误解）

1. **"客户端默认走窗口化"其实 P11 就已经生效了**（`assets/app.js` 的 `panelsUrl()` 恒带 `w=1`，
   首屏 `loadAll()` 也用它；浏览器实测 `server_windowed_panels` 26/27、`rows_api` 295 vs `rows_full_server` 9,900）。
   **6.9 MB 是"不带 `w` 的全量路由"**（脚本/旧客户端走的那条，行为一字未改）。
   本批对"首屏下发"这一层的贡献是：**服务端不再为了算这一页把账本读上百遍**（服务端仍会构建全量行再截窗口，
   这是 §7 的已知限制）。
2. **"3200 行排序 6.9 s"不是本地排序慢**：空闲时 690 ms、4 浏览器在压时 6.86 s，修后 135 ms；
   客户端点列头只重取**那一块**（`only=` + `pq=`，22,854 B），排序在服务端全集上算。

## 7. 边界（如实登记，不假装完成）

1. **服务端仍要构建全量行**：`rows_full = 9,900` 行是插件 `data(ctx)` 自己给的（口径没变，谁的事实谁给）；
   备忘省掉的是"重复读盘+解析"，不是"构建行"。要让服务端只为窗口构建行，得改插件的数据产出方式
   （未做，属于插件层）。
2. **单进程仍是单线程**：修的是"每个请求贵 10 倍"，不是"同时能跑几个"。真到容量上限时，背压会开始
   `429`（界面照实说忙），而不是无限排队。
3. **通知备忘是 5 s 级别的**：同一身份 5 s 内的两次聚合复用同一份结果（命中在状态栏里写明缓存龄）；
   动作/标已读会**立刻**清掉它。跨身份不复用。
4. **状态栏那条 `status` 的 0.67 s** 是插件自己的只读 Python 调用（`spawnSync` 一次），本批未动
   （不在授权改动范围内）。
5. **沙盘路径不受备忘影响**：沙盘的账本/待办件走 `app-shell.mjs` 自己的 `sandboxRows()`，
   与 `webui.mjs` 的备忘无交集。

## 8. 复跑（全部真跑；不新建门/测试，脚本都在 `tmp/`；**不碰真实账本**）

```bash
cp -a tmp/p12-run tmp/p13-run                       # 规模数据（400 包 / 3200 报价登记 / 15010 行账本）
sh tmp/p13-boot.sh boot 8450 tmp/p13-run            # 起服务（stop 同一个脚本）
python3 tmp/p13-probe-routes.py 8450 contractor      # 逐路由字节/耗时（修前修后的同一把尺子）
python3 tmp/p13-probe-shapes.py 8450                 # 窗口形态 vs 全量：字节/行数
python3 tmp/p13-probe-panels.py 8450 contractor      # 逐面板：全量行 / 下发行 / 有没有走窗口
python3 tmp/p13-read-io.py 8450                      # io.ledger（memo_hits/parses）/ io.admission / io.notify
python3 tmp/p13-concurrent.py --phase after --clients 6 --rounds 3 --stall-s 20
python3 tmp/p11-reconcile.py --base http://127.0.0.1:8450/quotagent --out tmp/p13-shots/reconcile-http.json
python3 tmp/p11-negative.py --base http://127.0.0.1:8450/quotagent --ledger-dir tmp/p13-run
python3 tmp/p13-stale-check.py --port 8451 --dir tmp/p13-write-run     # 写入后读回（备忘必须失效）
QUOTAGENT_UI_SHED_MS=40 sh tmp/p13-boot.sh boot 8452 tmp/p13-run && python3 tmp/p13-busy-verify.py 8452 --expect-shed
python3 src/system/webui/tests/check-webui.py        # 存量门（47/47）
# 热点复现（要 profile 时）：P13_CPU_PROF=$PWD/tmp/p13-prof sh tmp/p13-boot.sh boot 8453 tmp/p13-run
#   …跑负载…；kill -INT <node pid> 写出 .cpuprofile，然后：
python3 tmp/p13-prof-analyze.py 'tmp/p13-prof/*.cpuprofile' --out tmp/p13-shots/cpu.json
```
