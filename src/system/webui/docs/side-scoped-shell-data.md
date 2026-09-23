# 外壳共享、**数据按会话侧隔离**（P50：`/app/<侧>/**` 与 `/api/ui/panels|object` 的侧门）

<!-- 预算：16 KB（`docs/design/12-documentation-standard.md` §1 的 `src/*/*/docs/*.md` 行）。
     口径真源：`docs/design/29-webui-gui-app.md` §7（台账与持久化）与 §15（身份/会话/自助面）；
     判据只有一处：`src/system/webui/code/identity.mjs#gateBusinessRoute`（业务路由与 GUI 外壳**同一个函数**）。
     修前/修后读数与截图在 `tmp/p50-shots/`（原始读数 `p50-probe-log.jsonl`）。 -->

## 0. 一句话

修前：`/app/**` 是**公开入口**（`/api/routes` 里写 `auth: none`），而 `view` 是 **URL/请求参数**给的 ——
于是「拿承包商身份（或干脆不登录）打开 `${prefix}/app/supplier/`、再请求
`/api/ui/panels?view=supplier`」能拿到**供应商侧的取数行**（实测 32 行，含 `quote.drafts` / `po.inbox` /
`people.roster-supplier`）。外壳 HTML 共享本身没问题（它不含数据），**数据面没有按会话侧隔离**才是缺陷。
现在：**同一份判据**（登录 + 会话属于该侧）同时钉在①外壳路由与②数据路由上；
**无会话 ⇒ 数据行一概不下发**（面板清单/列/动作/口径照旧，机制面不装死）。

## 1. 判据（一处实现，两处挂载）

```
identity.gateBusinessRoute(req, { side: view, next, wantsHtml })
  ├─ 未登录：浏览器 ⇒ 303 → ${prefix}/identity/?next=<原地址>；API/JSON ⇒ 401 identity-required
  ├─ 登录了但不是这一侧 ⇒ 403 side-mismatch（**不回落成"能看"**）
  └─ 其它 ⇒ null（放行）
```

| 位置 | 挂法 | 效果 |
|---|---|---|
| `/app/<业务侧>/[<kind>/<id>/]` | 与静态业务路由**同一个函数**（`webui.mjs#replyIdentityGate` 也同一份渲染） | 未登录 303/401；**越侧 403**（HTML 客户端拿到那张"需要身份 · side-mismatch"页） |
| `/api/ui/panels`、`/api/ui/object` 的 `view` 参数 | `webui.mjs#sideVerdict`（登录了才判：`who.side !== view` ⇒ 403 `side-mismatch`） | 越侧的**数据请求**直接拒（账本零新增）；非业务视图（`home`）不适用侧判据 |
| 面板行（无会话） | `app-shell.mjs#withRowsGate` | 行/条目/文件 + 派分计数清空并标 `rows_withheld`（**面板清单照旧**） |
| 行源归属 | `app-shell.mjs#rowViewFor` + `host.rows(view, viewer)` | 业务侧视图 = 它自己；其它视图（`home` 工作台）= **会话所属侧**；无会话 = 空 |

**为什么无会话不是 401 而是"清单照旧、行不下发"**：面板清单是**机制自述**（这一页有哪些面板、有哪些
动作/列、口径是什么）——「这一页有什么」与「这一页的数据」是两件事；数据才是会话侧的资产。界面上按
29 §23 的空态渲染那句 `reason`（截图 `20-anon-rows-withheld.png`：每块面板写「未登录：数据行不下发
（不是「这里没有数据」）」）。**跨侧（登录了但不是这一侧）仍然是硬 403**，因为那是"别人拿你的身份看"。

## 2. `/app/**` 与 `cross-side-action` 的关系（**何时触发，测清了**）

`cross-side-action` 是**动作服务端一半里**的判据：`ctx.view`（请求体给的视图）≠ `ctx.identity.side`
（会话侧）⇒ 具名拒，**写动作在写之前拒、账本零新增**。全仓声明它的动作（grep `cross-side-action`）：

| 插件 | 动作 | 修后实测（会话=contractor，请求体 view=supplier） |
|---|---|---|
| `system/approval` | `gate.grant` / `gate.deny` / `gate.decide-batch` | 400 `cross-side-action`（"侧只认会话（请求体改不动我是谁）"） |
| `domain/authority-band` | `authority.bands.set` / `authority.escalate` | 400 `cross-side-action` |
| `domain/commitments` | `award.confirm` / `po.acknowledge`（`sideGuard`） | 400 `cross-side-action` |
| `domain/negotiation` | 谈判三个步骤动作 | 400 `cross-side-action` |
| `system/evidence` | `evidence.export` | 400 `cross-side-action` |
| — | `authority.check`（只读、与侧无关） | **200**（不声明这条判据 ⇒ 不触发） |

读数：`tmp/p50-shots/p50-probe-log.jsonl` 的 `crossact.*` 4 条（8 个动作逐条 400 + 1 个只读动作 200）；
两侧账本 sha256 前后一致。**触发条件 = 请求体里的 `view` 与会话侧不一致**（`confirm_ack` 要先给，否则
先被机制的 `confirm-required` 挡在门外 —— 那是**另一层**门，与侧无关）。
**GUI 正常路径下不会再产生这个组合**：页面本身已经被①挡住（越侧的页面打不开），动作按钮只出现在
本侧那一页上；手搓请求（或别的客户端）仍会撞上这条判据 —— 它是**第二道**防线，不是唯一一道。

## 3. 修前 / 修后读数（同一份数据根：两侧账本各有内容）

| 请求（承包商会话 `human:limin`；或匿名） | 修前 | 修后 |
|---|---|---|
| `/app/contractor/`（HTML） | 200 | 200 |
| `/app/supplier/`（HTML，承包商会话） | **200 外壳**（页面照常渲染，数据面没拦） | **403** `side-mismatch`（`19-cross-side-403.png`） |
| `/app/supplier/`（HTML，匿名） | 200 | **303 → `/identity/?next=…`** |
| `/api/ui/panels?view=supplier`（承包商会话） | 200，**32 行** | **403** `side-mismatch`（行数 0） |
| `/api/ui/panels?view=contractor`（承包商会话） | 200，30 行 | 200，77 行（本人这一侧，口径未变） |
| `/api/ui/panels?view=*`（匿名） | 200（home 32 行 / contractor 30 行 / supplier 32 行） | 200，**行一律 0** + `rows_withheld`（面板数 17/40/37 照旧） |
| `/api/ui/object?view=supplier&kind=po&id=po-0001`（承包商会话） | 200，`found:true` + 事实项 8 条 | 403 `side-mismatch` |
| `/api/ui/object?view=contractor…`（匿名） | 200 + 事实项 | 200，`facts: []` + `header_withheld`（标题与 id 照旧） |
| `host.rows('home')`（承包商会话） | rowsFor('home')（固定那一本账） | **会话所属侧**（contractor） |

**机检不变量**（本批的口径）：`无会话` 或 `view ≠ 会话侧` 时，**拉任一视图的行数恒为 0**
（`tmp/p50-shots/p50-probe.py --phase cross2/cross2anon` 的 `rows` 字段，逐次打印）。

## 4. 边界（如实登记，不假装已闭合）

1. **`html` 形状的面板不做行门**：它们由插件自渲染一段 HTML（实测匿名下 6 块：`mail.channel`、
   `userspace.mine*`、`po.detail`、`change.detail-links` —— 内容是**通道状态/链接**这类机制读数，
   不是某一侧的取数行）。判据覆盖的是**行/条目/文件 + 派分计数**；`html` 面板若有朝一日装上侧数据，
   要在那个插件自己的 `data()` 里按 `ctx.identity.side` 收敛（本文件是它的口径出处）。
2. **通知面不在本批口径内**：`/api/ui/notifications` 匿名仍返回条目（实测 6 条；29 §17 的真源里
   「未登录 ⇒ `unread.known=false`」本就预留了匿名读）。**如实登记为同族未闭合项**，本批不改它
   （改它会牵动另一批的 16 条断言）。
3. **`/api/ui/blocks`、`/api/ui/surface`、`/api/ui/jobs`、`/api/people/*`、`/api/collab/*`**：
   前两个是机制自述/自研报（不含某一侧的取数行）；后四个**本来就按会话侧拒**（匿名 401，
   见 §7.3/§8/§16 的真源），本批一字未改。
4. **PWA 离线壳**：`sw.js` 的导航回退**只在网络错误时**发生（P50 修：4xx/5xx 原样返回）——
   否则一个 403 `side-mismatch` 会被换成"离线壳"，用户会把"服务端不让你看"读成"现在离线"。

## 5. 复跑

```sh
cd <仓库根>
./run up --port 8605 --config-file "$PWD/tmp/p50-run/managed-config.yaml" --data-dir "$PWD/tmp/p50-run/shared"
python3 tmp/p50-shots/p50-probe.py --port 8605 --phase cross2        # 带会话（含越侧 403）
python3 tmp/p50-shots/p50-probe.py --port 8605 --phase cross2 --anon # 匿名（行数为 0）
python3 tmp/p50-shots/p50-probe.py --port 8605 --phase crossact      # cross-side-action 何时触发
# 停服务（按端口拿 PID；不用 pkill by name）
PID=$(ps -eo pid,cmd | grep "[c]li.mjs webui" | grep -F -- "--port 8605 " | awk '{print $1}'); kill $PID
```
