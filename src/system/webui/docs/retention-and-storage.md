# 坏账本与坏环境下的**如实降级**（读数闸门 · 坏行计数 · 写不进去怎么说）

<!-- 预算：12 KB（`src/*/*/docs/*.md`）。口径真源：`docs/design/29-webui-gui-app.md` §16/§20（禁用「坏文件说成空的」）。
     机制真源：`src/system/webui/code/webui.mjs`（`ledgerFileGate`/`tolerantLedgerRead`/`memoLedger` 的
     `health()`）、`src/system/webui/code/app-shell.mjs`（动作运行时的 `rowsOfFile`）、
     `src/system/attachments/code/attachments.mjs`（`list()` 的 `counts.unreadable`）。
     逐条读数（17 个场景 × 修前/修后 + 原始输出）与复跑命令：`tmp/p34-shots/REPORT.md`、`tmp/p34-shots/matrix-*.json`。 -->

## 0 一句话口径

> 账本是一份**外部文件**：它可能半截、可能是乱码、可能根本读不出来、可能被换成设备节点。
> 宿主在这四种情况下都必须**照实说**（具名 reason + 下一步），**好行照列、坏行逐条计数**，
> 并且**绝不用一张空表顶替「读不出来」** —— 「空」和「读不出来」在屏幕上必须长得不一样。

上游 `lib/ledger-view.mjs#rows()` 是**裸读**（`split('\n').map(JSON.parse)`）：一行坏 ⇒ 抛；
路径若是 FIFO/字符设备 ⇒ **永久阻塞**（Node 主线程被占死，连对面那一侧的请求也不作答）。
本层只加读数闸门与容错读，**不改账本、不改事件语义、不写任何文件**。

## 1 读数闸门（先看路径，再读内容）

| 情况 | 具名 code | 屏幕说法（原文见 §3） |
|---|---|---|
| 文件不存在 | `ledger-missing` | 「读不到账本文件（ENOENT）…这一侧还没有账本」 |
| 不是普通文件（FIFO/设备/目录） | `ledger-not-a-regular-file` | 「账本路径不是普通文件…宿主拒绝从这里读（设备/FIFO 会一直读下去、把内存吃光），也不猜它的内容」 |
| 超过整份读入上限（64 MiB） | `ledger-too-large` | 「宿主不把 64 MiB 以上的账本整份读进内存（会吃光内存）；先用 Python 侧工具按 seq 分页/归档」 |
| 读得到但打不开（EACCES 等） | `ledger-unreadable` | 「账本读不出来（EACCES）…**读**这一侧的进程要能读」 |

闸门跑在**上游裸读之前** ⇒ 一个 FIFO 或 `/dev/full` 再也不会让服务挂住/被内存压死；
链校验（`verify()`）同样先过闸门：非普通文件/超大/不存在时**不把路径喂给 Python 侧**（否则它会同样读不完）。

## 2 坏行的降级（唯一入口、逐条计数、不静默丢）

`tolerantLedgerRead(path)` 与上游 `rows()` **同一投影形状**（`seq/type/correlation_id/actor/ts/body`），
差别只在坏行：坏行**跳过并记数**（`dropped` + `first_bad_line`），`realm` 照同一判据取（`realms()` 降级时也用它）。
**好数据走上游原路**（`raw.rows()`，逐字节一致）—— 只有上游抛了才走容错读，所以健康账本一个字节都没变。

得到的两类降级：

| code | 触发 | 读数 |
|---|---|---|
| `ledger-lines-unreadable` | 上游 `rows()` 抛（半截 JSON / UTF-8 被截断 / 读权限） | `dropped`（坏行数）、`first_bad_line`、`lines`（非空行数）、`bytes` |
| 闸门那四条（§1） | 路径本身不行 | `dropped: 0`（**不是 0 条坏行，是整个读不出来**） |

纪律（与 `row-action-prefill.md` §4 同源）：

1. **好行照列** —— 一行坏数据不该让整块面板 `data-failed`，更不该让整页 500；
2. **坏行逐条计数并如实报出来**（屏幕上写「另有 N 行读不出来，第一处在第 M 行」）；
3. **源本身不行 ⇒ 那是「读不出来」，不是「零行」**（两种状态的措辞在 §3 里是分开的两句）；
4. 链是否自洽**不由宿主算**：仍走 Python 侧 `verify_report()`（坏行时 `ok:false`），宿主只把结论贴出来。

## 3 读数落在哪里（页面 / JSON / 读数面）

* **`GET /api/status`**：`ledgers[<view>]` 在**降级时**多出 `degraded:{code,dropped,first_bad_line,lines,reason,next_action}`
  并把已有的 `reason` 换成**人话原因**；**健康账本的响应逐字节不变**（`webui` 门 E11 把这份响应按字节冻住，
  所以这里是"只在降级时加键"，不是改口径）。
* **视角首页的健康块**：多一段 `<p class="degraded" data-ledger-degraded="1" data-ledger-code="…"
  data-ledger-dropped="…" data-ledger-first-bad-line="…">` —— 人话原因 + 计数 + **下一步**（可直接抄走）。
* **`/api/ui/surface` 的 `io.ledger.degraded[]`**：本进程内出现过的降级路径（`view/path/code/dropped/first_bad_line`）——
  只为可对账，健康时不出现。
* **动作运行时**（批量动作的 worker 线程，`app-shell.mjs#rowsOfFile`）：坏行也逐条计数，条数**落运行时日志**
  `<ui_shared>/webui/action-runtime.log`（`ledger-lines-dropped path dropped=N kept=M`），
  这样一行坏数据不会让整批动作"运行时退出而没有结果"。

## 4 写不进去怎么说（磁盘满 / 只读目录 / 权限）

写面的**唯一写者**闸门不变；本层只保证「写不进去」被如实报出、且**账本零新增**：

* **数据目录只读（0555）**：`POST /api/action/…` ⇒ `400 writer-gate-failed`
  + `reason: EACCES: permission denied, open '<ui_shared>/webui/writer.lock'`
  + `next_action: 修 <ui_shared>/webui/writer.queue 所在目录的权限后重提（本动作什么都没做）`。
* **账本路径指向 `/dev/full`（磁盘满的等价设备）**：append 真拿到 `errno 28 No space left on device`；
  宿主侧因为**先过闸门**而根本不去读它 ⇒ 服务照常，降级条目 `ledger-not-a-regular-file` 上屏。
* **`ledger_added`**：拒绝路径上是 `null`（"什么都没落"）—— 见 §6 的如实登记。

## 5 中断与并发（宿主侧不拿墙钟当事实）

| 场景 | 判据 | 读数（P34 实测） |
|---|---|---|
| 写入中途 SIGKILL | 下一个进程必须能起来、能读、能说清"尾巴那一行读不出来" | writer `rc=-9`；`/api/status` `dropped=1 first_bad_line=298`；`/contractor/` 200 + 降级段落；链 `ok:false` |
| 两进程争同一数据目录 | 唯一写者闸门是**跨进程**的（文件锁 + FIFO 票据） | 两进程同时 `rfq.publish` 都 200；账本 297→301 行、**无重复 seq、无坏行、链 ok** |
| 时钟跳变（宿主进程 ±6h/+26h） | **账本派生读数一字不变**（宿主不读墙钟当事实） | `/api/status` sha 三次全等 `4936e5aa4db62418`、面板行数 749 三次全等、周报面板完全一致 |

时钟跳变的**真源**是"周报只读、`as_of` = 账本最大 `ts`"（29 §22 ④）：宿主进程的墙钟被整体平移 ±小时，
周报与状态面**不跟着变**；写者的时刻来自 Python 侧（真实墙钟），这正是"两侧时钟可以不一致"的形状。

## 6 附件索引的坏条目（同一入口的另一处）

`<ui_shared>/attachments/index.json` 的 `attachments` 里混进 `null`/字符串/数组时：
`list()` 现在给 `counts.unreadable`（**只在 >0 时出现**）+ 一句 `note`（「好条照列、坏条已跳过并计数（不静默丢）」），
**好条目照列**；`stats()` 的 `entries` 本来就是全量计数。同一 sha256 被多个文件名指向时，
列表按**内容寻址**给出多条（同一份字节一份正文），下载逐条按 sha256 自校验。

## 7 复跑（只动 `/tmp/p34-fx/` 下的副本；真账本零改动）

```bash
python3 tmp/p34-shots/make-fixtures.py                 # 17 个「坏数据/坏环境」变体（各报注入前后 sha256）
python3 tmp/p34-shots/run-matrix.py --tag before --root /tmp/p34-head   # 修前（git archive HEAD 副本）
python3 tmp/p34-shots/run-matrix.py --tag after  --root "$(pwd)"             # 修后（工作树）
python3 tmp/p34-shots/probe-evidence.py half utf8 perm0000 fifo chardev   # 屏幕上的降级原文
python3 tmp/p34-shots/scenario-runtime.py interrupt|twoproc|clock         # 中断 / 两进程 / 时钟跳变
python3 tmp/p34-shots/scenario-chardev.py --tag before|after               # ENOSPC 与无界读
python3 tmp/p34-shots/check-pollution.py               # 读数是不是本批自己的服务（防串台）
python3 tmp/p34-shots/stop-mine.py                     # 按端口收尾（只杀带 p34-fx 的进程）
```

## 8 已知限制（如实登记，不假装完成）

1. **`/workspace` 是 ZFS `nfs4acl` ⇒ mode 位不生效**：`chmod 0000` 在那里仍可读。坏权限场景的夹具因此建在
   `/tmp/p34-fx/`（脚本里用 `P34_FX_ROOT` 覆盖）。⇒ 本机**不能**用 mode 位兑现「名册/偏好/回执/待办件 0600」这条纪律：
   真源是 ACL，要运维在 ACL 层钉（本批不改鉴权、不碰 ACL）。**另外**：即使文件系统判 mode 位，
   「把目录设成只读」也拦不住**属主进程** —— 服务会 `chmodSync(dir, 0o700)` 把自己的目录改回来再写
   （`identity#saveSessions`）；真拦得住的是 EROFS/只读挂载或 ACL（实测：只有它**不**去 chmod 的
   `<ui_shared>/webui/` 让写者闸门报 EACCES）。
2. **上限 64 MiB 是宿主侧整份读入的取舍**：超过就具名拒读（不静默截断），而不是流式分页 —— 大账本要先用
   Python 侧工具归档/分页。这个数写死在 `webui.mjs`（`LEDGER_READ.max_bytes`）。
3. **`ledger_added` 在拒绝路径上是 `null` 不是 `0`**：屏幕文案说"本动作什么都没做"，但没有一个机器可读的 `0`。
   改它要动写者回执形状（`writerReceipt`），本批没动。
4. **附件 `versions()` 与 `visibleObjects()` 的坏行只跳过、没上屏计数**：前者只过滤非对象条目、后者注释写明
   "账本行的真源不在这里"。要补计数得再动这两处的返回形状。
5. **`/api/attachments/*` 在账本是 FIFO 时会读它**（`visibleObjects` 有 `isFile()` 闸门，故不会阻塞；
   但那条路径的降级只有 `sources[].reason='unreadable'`，没有屏幕读数）。
6. **本批不新建门/测试**（按要求）：全部验证脚本在 `tmp/p34-shots/`，不进 `docs/work/evidence/`。
