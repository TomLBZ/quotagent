# 通知窗口与跨面板去重：**如实计数 + 真能翻到底**，同一件事不重复占位

<!-- 预算：16 KB（`docs/design/12-documentation-standard.md` §1 的 `src/*/*/docs/*.md` 行）。
     口径真源：`docs/design/29-webui-gui-app.md` §3（注册面）§9（偏好/已读在服务端）。
     本页讲**机制怎么用、怎么验、数字是多少**。P14 的原始读数与截图在 `tmp/p14-shots/`。 -->

## 0. 一句话

> 通知中心以前只给你**前 600 条**（`NOTIF_CAP`），顶栏却写「共 600 条 · 第 1/24 页」—— 后台实际产出 6328 条，
> 被截掉的 5728 条**哪儿都点不到**，数只躲在状态栏「更多」的折叠里。现在通知中心走的是**和面板同一套
> 服务端窗口**：服务端在**全量条目**上筛选→排序→分页，**只回这一页**，并把在全集上算出来的数字一并给出。
> 界面上照实写「共 N 条 · 已显示 N 条 · 剩余 M 条」—— N 与 `/api/ui/status` 的「通知」那一行**同源**，
> 点「末页 ⏭」能一直翻到底。另一半：同一批人工门被两块面板各列一次（本侧计数 2×），现在**跨面板按对象去重**。

## 1. 通知窗口（机制，插件一行不改）

```
GET /api/ui/notifications?w=1&pq={"notify":{"size":25,"page":0,"kw":"","chip":"all|unread|todo|bad",
                                            "tag":"","level":"info|warn|bad","muted":["<插件 id>"]}}
GET /api/ui/notifications?w=1&pq={"notify":{…,"keys":true}}     ← 「全部标已读」按需取命中全集的行 id
GET /api/ui/notifications                                       ← **不带窗口 = 旧口径**（整份 + 上限 600 条）
```

* `w=1` 才开窗口：响应只回**这一页**（`items`），并把 `query` 一起给（`produced` 产出 / `visible` 符合偏好 /
  `matched` 命中 / `size`·`page`·`pages` / `start`·`end` / `rest` = **还没翻到的条数** / `level_counts` /
  `chip_counts` / `tag_counts` / `matched_keys` 按需）。
* **不带 `w` 的调用一字不变**（脚本/旧客户端仍拿到整份 + `NOTIF_CAP` 截断），只是回执里多了 `stats`
  （`produced` / `returned` / `cap` / `dropped` / `windowed:false`）—— 截断**不再静默**。
* **口径**：`已显示` = `query.end`（按页推进**已经到过**的条数）、`剩余` = `query.rest`；翻到末页时剩余为 0。
  筛选/关键字**只改"看到哪些"**，不改条数口径，也不写任何东西（§5 负控逐文件证明）。
* **同一件事只出一条**（机制）：聚合时按 `id` 合并（`count` = ×N、`plugins` = 谁报的、级别取更急的一档）。
  这条以前在客户端做；服务端分页之后做在服务端，否则同一条会在两页里各出现一次。
* **未读**由服务端按**会话身份**存的已读集合算（`/api/ui/notif-state` 的 `read`，0600 文件）。
  **未登录 ⇒ `unread.known=false`**：界面如实说"未读只按本页算"，不猜、不冒充、也不泄漏别人的已读。
* 排序与客户端旧口径一致：**急的在前，然后按时刻倒序**（稳定全序 ⇒ 同一页永远是同一批条目，翻页不跳行）。

## 2. 界面（`assets/app.js`）：数字照抄服务端，不自算

`renderNotify()` 把服务端给的数字贴在 `data-notify-*` 上（可机器对账）：

| 属性 | 含义 |
|---|---|
| `data-count-produced` / `data-notify-produced` | **共 N 条（后台产出）** —— 与状态栏「通知」那一行同值 |
| `data-count-shown` / `data-notify-shown` | 已显示 N 条（`query.end`） |
| `data-count-rest` / `data-notify-rest` | 剩余 M 条（`query.rest`，末页为 0） |
| `data-count-matched` / `data-count-window` | 当前筛选命中 / 本页条数 |
| `data-page` / `data-pages` / `data-page-size` | 第 P/PP 页 · 每页多少（10/25/50/100/250） |
| `data-unread` / `data-unread-known` | 未读（服务端读数）；`0` = 未登录时**只按本页算** |
| `data-q-server` / `data-q-fetching` | 服务端窗口 · 正在取这一页（数字仍是上一次的，不冒充已更新） |

* 关键字 / 筛选片 / 级别 / 静音 / 每页 / 翻页**每次都只重取这一页**（不会把全量拉下来）。
* **打开即把本页标为已读**（与邮件客户端一致）：登录时先 `POST /api/ui/notif-state`（立即）**再**取一次这一页
  ⇒ 界面上的"未读"与每条的小圆点是同一时刻的读数，不自相矛盾。
* 「全部标已读（N）」= 当前筛选命中的**全部**（按需向服务端要一次 `keys=true` 的命中行 id）；命中超过
  服务端一次给的行数上限时服务端**如实说**（`matched_keys_capped`），界面不静默给一半。命中条数超过
  **已读记录的容量**（本浏览器 500 / 服务端 1000，见 §5）时这一颗**禁用并写明原因** —— 与其标完丢记录，不如说清。
* 弹层结构按外壳既有口径：卡片 = flex 列（`max-height 88vh`）＋ `.q-modal-body` 是**正文**（唯一可滚的块），
  底部计数/翻页条**吸底**。列表不再自己再滚一遍（两层滚动条会让"到底还有没有下一条"没法回答）。

## 3. 跨面板去重（机制，判据由插件给）

**症状**（P13 实测）：`system/approval#gate.todo` 与 `domain/commitments#home.gates` 把**同一批人工门**
各列一遍 ⇒ 承包商侧「有 2404 件需要你处理」里 1200 件是**重复占位**（同侧真值是 1204）。

**口径**（`app-shell.mjs#foldPanelDuplicates`）：

1. 条目带 **`dedupe_key`**（不透明串，插件自己给，如 `gate:ap-pending-0001`）时才参与；键相同 ⇒ 认作同一件事。
2. **只跨面板**（`panel_id` 不同）：同一块面板内部的重复是那个插件自己的事，外壳不动。
3. 先出现的赢（面板按 `order` 排 ⇒ "更该由谁来说这件事"由插件用顺序表达）；输的那条**不丢信息**：
   `merged_count` + `also_from[{panel_id,plugin_id}]` 写在赢的那条上，级别取**更急的一档**，
   缺的 `ref`/`action`/`bucket`/`preset`/`label` **补上** ⇒ **合并后仍能点进对象页、仍能一键发起那个动作**。
4. 去重发生在**开窗口之前**（在面板给的全量条目上）⇒ `共 N` / 卡片头计数 / 桶计数全部按**合并后**算。
5. 读数在 `/api/ui/surface` 的 `io.dedupe`（口径自述 + `reading{deduped, panels}`）与 `io.last_render.deduped`。

**点得进去**这一条要求每一步都成立，所以还修了两处**声明/落点**：

* 门条目的 `ref` 必须带 `view`（例：`{kind:'gate', id, view:'contractor'}`）：不写时深链按"当前页的视角"拼，
  从工作台点过去会落在 `home` 视角 —— 那里没注册 `gate` 对象类，只会如实说"本视图里没有这个对象"。
* 面板/工作台/表格行的对象深链声明 `data-v`，点击处理**以这一条自己声明的视角为准**（与 `refLink()` 拼
  `href` 同一条规则）—— 以前 href 写着 `/app/contractor/gate/…`、点下去却跳到当前视角。

## 4. 实测（同一份数据、同一段探针；`tmp/p14-shots/probe-{before,after}.json`）

数据目录 `tmp/p14-run`（= `tmp/p13-run` 的副本：400 包 / 3200 报价登记 / 两侧账本 md5 全程不变）；
修前 = HEAD `db12c0f` 的检出（`/tmp/p14-head`，端口 8462），修后 = 本批（端口 8461）。**同一台机器、同一份数据、同一段探针。**

| 读数 | 修前 | 修后 |
|---|---|---|
| 通知中心顶栏（承包商 `wanglei`） | 「共 600 条 · 第 1/24 页」 | 「共 6336 条（后台产出）· 已显示 25 条 · 剩余 6311 条 · 命中 6336 · 未读 6286 · 第 1/254 页」 |
| 状态栏「通知」那一行 | 产出 6328 条 · 返回 600（上限 600，截掉 5728） | 产出 6336 条 · 通知窗口可翻到底：共 6336 条 · 第 1/254 页 · 已读记录 61 条（服务端） |
| 翻到末页（真点「末页 ⏭」） | 不存在（`w`/`pq` 被忽略，还是那 600 条） | **第 254/254 页 · 已显示 6336 · 剩余 0 · 本页 11 条**（`rfq:SCALE-PKG-0390…0400`，与第 1 页**零重叠**） |
| 关键字搜索 | 只在 600 条里找 | 在**全集**上找（例：`ap-pending-0001` ⇒ 命中 2 / 1 页） |
| 工作台卡片头（承包商 `wanglei`） | 有 **2404** 件需要你处理 | 有 **1204** 件（`gate.todo` 1200 合并 + `home.gates` 只剩 2 条） |
| 两块门面板 | `gate.todo` 1200 + `home.gates` 1202（同一批门各列一次） | `gate.todo` **1200（每条「合并 2 块」）** + `home.gates` **2（`deduped:1200` + 去重说明）** |
| 工作台卡片头（供应商 `guqi`） | 7 | **7**（未受影响：那些条目对供应商本来都是 `info`） |

截图（`tmp/p14-shots/`）：`p14-07-workbench-before-2404.png` → `p14-05-workbench-after-1204.png`；
`p14-08-home-gates-before-1202.png` → `p14-06-home-gates-after-dedupe-note.png`；
`p14-09-notify-center-before-600.png` → `p14-03-notify-window-page1-after.png` + `p14-04-notify-window-lastpage-after.png`；
`p14-10-status-notify-after.png`（状态栏那一行）、`p14-11-gate-object-from-merged-item.png`（从合并后的条目点进对象页）。

## 5. 边界与已知限制（如实登记）

1. **服务端仍要构建全量条目**（口径没变：谁的事实谁给）：窗口省掉的是**下发字节**与"把全量交给客户端"，
   不是服务端的读取量。通知聚合仍有 5 s 级短 TTL 备忘（`notify_cache_ms`），任何动作会立刻清掉它。
2. **已读记录的容量是 500（本浏览器）/ 1000（服务端）**：标得再多也只保留最近那些（既有口径）。
   因此「全部标已读」在命中条数超过容量时**禁用**并写明原因，只留「标记本页 N 条」。
3. **未登录时未读只按本页算**（`unread.known=false`）：服务端不知道谁读过什么，界面照实说。
4. **通知中心里同一个门仍可能出现两条**：`system/approval` 报的 id 是 `gate:<视角>:<门 id>`、
   `domain/commitments` 报的是 `gate:<门 id>`，**不是同一个 id** ⇒ 外壳的"同一件事只出一条"认不出来。
   本批只收口了**面板**的重复占位（2404→1204）；要收口通知中心这一条，得让两个插件用同一个 id
   或声明同一个 `dedupe_key`（门未超时的场合只有 ≤ 超时门数量那么多条，本批如实登记、未改）。
5. **`已显示` 的语义**：按页推进"已经到过"的条数（跳页直接到末页时它等于全部）——
   它就是 `query.end`，不是"用户逐条看过"的意思。

## 6. 复跑（真起服务、真造规模、真截图；**不碰真实账本**）

```bash
cp -a tmp/p13-run tmp/p14-run                              # 夹具：400 包 / 3200 报价登记（私有数据目录）
git archive HEAD | tar -x -C /tmp/p14-head                 # 修前的检出（前后对比用）
ln -s $PWD/host/node_modules /tmp/p14-head/host/node_modules
nohup sh tmp/p14-shots/start.sh 8461 $PWD/tmp/p14-run $PWD            > tmp/p14-shots/server-after.log &
nohup sh tmp/p14-shots/start.sh 8462 $PWD/tmp/p14-run /tmp/p14-head   > tmp/p14-shots/server-before.log &
python3 tmp/p14-shots/probe.py 8461 after                  # 通知窗口/去重的逐项读数（探针）
python3 tmp/p14-shots/probe.py 8462 before                 # 修前同一段探针（对照）
python3 tmp/p14-shots/negative.py                          # 负控 10/10（未登录 401 / 越侧 403 / 读不写账本 / 坏参数）
python3 tmp/p11-reconcile.py --base http://127.0.0.1:8461/quotagent   # 存量对账 132/132（窗口机制没被改坏）
python3 tmp/p11-negative.py --base http://127.0.0.1:8461/quotagent --ledger-dir tmp/p14-run  # 存量负控 11/11
python3 src/system/webui/tests/check-webui.py              # 存量门（47/47）
# 浏览器侧（真点真截）：登录 wanglei → 工作台 → 「通知」→ 末页 ⏭ → 面板里「打开 审批门 … →」
```

## 7. 同一条通知怎么"走得比浏览器更远"：**邮件摘要**

通知中心只在页面里 ⇒ 人不在浏览器时没人提醒他。同一份「按身份聚合后的通知」现在可以经**邮件**送出：
外壳只提供**投影**（`host.digest()`：标题 / 下一步 / 来源 / 深链 / 计数，**不带通知正文** + 逐条扫私域哨兵），
投递与判定在 `system/mail`（开关默认关、按身份 0600、去重 + 节流、走既有 SMTP 通道、**不写账本**）。
口径、边界与真跑读数见 `src/system/mail/docs/notification-digest.md`（复跑 `python3 tmp/p19-shots/verify-digest.py`，16/16）。
