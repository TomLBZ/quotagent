# 投递事实的行项目读数（坏行不静默丢）

<!-- 预算：16 KB（`src/*/*/docs/*.md`）。机制真源：`src/system/projection/code/projection.mjs`
     （纯函数 `projectDeliveries`）+ `src/system/projection/code/ui.mjs`（把读数摆上屏的那一半）。
     口径真源：`docs/design/29-webui-gui-app.md` §22/§23；复跑见本文 §4 与 `tmp/p33-shots/REPORT.md`。 -->

## 0 一句话

投影层读 `spec.items[]` 时，**读不成一行的条目照样不进视图**（白名单与私域纪律一个字不放宽），
但**丢了几条 / 为什么 / 怎么修**必须逐条报出来 —— 修前那里是一句静默的 `filter(isPlainDelivery)`，
下游拿到的是一个**已经干净**的数组，「这份包有 3 条行项目」与「信封里有 5 条、2 条读不出来」长得一模一样。

## 1 判据（一个字不放宽的部分）

* 坏行**不参与任何输出**：它不进 `rfq.items`（`RFQ_ITEM_KEYS` 仍是恰 4 键 `item_id/code/qty/unit`），
  也不参与 `rfq` 的 `JSON.stringify` ⇒ 信封层的两条**结构性负控**（非我的发放对象 / 私域键名）判据不变。
* 坏行**不回显取值**：读数是「条数 + **闭合集合里的具名原因** + **常量修法文案**」。
  回显内容等于把白名单外的东西搬到屏幕上（实测：往坏行里写 `cost_floor=<哨兵>` ⇒ 该哨兵在
  `/api/ui/panels?view=supplier`、`/supplier/api/events` 两处 **0 命中**）。
* 「**丢**」与「**夹取**」是两件事，分开给（把"信封坏了"说成"行项目太多"是另一种不诚实）：
  `items_dropped` = 读不成行的条数；`items_omitted` = 好行但超过每包上限（`max_items`）的条数。
* 行项目层的降级**不等于**整份视角降级：`degraded`（整份读不出来）与 `item_degraded`（有坏行被跳过、
  好行照出）是两个旗标。混用会让下游把**好行**也当成"没读到"。

## 2 形状（读数的落点）

| 落点 | 含义 |
|---|---|
| `counts.items_dropped` | 本次读到（发给本视角）的信封里，坏行总条数 |
| `item_degraded` / `item_dropped_reason` / `item_dropped_note` | 顶层：有没有坏行、具名原因、人话读数（丢几条 / 为什么 / 怎么修） |
| `packages[].items_declared` | 信封里**声明**的条数（源数组长度） |
| `packages[].items_dropped` / `items_dropped_reasons[]` / `items_dropped_reason` / `items_dropped_note` / `items_dropped_fix` | 逐包读数与修法 |
| `ITEM_DROP_REASONS`（导出常量） | **闭合集合**（当前 `['item-not-an-object']`）：降级一律有名，不是含糊的一句话 |
| `ITEM_DROP_NOTES`（导出常量） | 原因 → `{what, fix}` 的人话文案（常量，故不回显取值） |
| 面板 `projection.delivery-truth` | 把上面的读数摆到屏幕（供应商视角；`not_data: true` —— 它是读数不是业务数据） |

## 3 显示层（谁把读数摆出来）

* `code/ui.mjs` 注册的面板 `projection.delivery-truth`（视图 `supplier`，走 `/api/ui/panels?view=supplier`
  ⇒ 渲染在 `/app/supplier/`）逐包给：声明条数 / 读到条数 / 丢了几条 / 为什么 / 怎么修；有坏行 ⇒ 面板
  `degraded: true` + `reason: items-dropped:N`（好行照列，不是把整块藏起来）。读不到信封/认不出 realm ⇒
  **具名降级**（`no-delivery-target` / `delivery-unreadable` / `no-ledger-identity`），绝不把"读不到"
  画成"没有包"。
* 显示层**不重算**作用域与白名单：它调的就是投影层那份纯函数（`host.service('projection')`），
  与宿主装配（`webui.mjs`）**同一真源**，界面侧不另抄一份规则。
* 界面侧的 realm 取值与 `domain/quote-prepare` / `domain/commitments` **逐条同源**
  （行级 `realm` → 投递登记 `po|rfq/distributed` 的 `recipient(s)`），对不上就如实降级而不是猜一个身份。

## 4 复跑（真跑；夹具是 tmp 下的副本，真实账本一个字节不碰）

```bash
python3 tmp/p33-shots/make-bad-envelope.py        # 造好行 / 坏行两份信封（坏行 4 条，其中一条带私域哨兵）
node    tmp/p33-shots/before-after.mjs            # 纯函数前后对比（修前无此读数 / 修后 4 条 + 原因 + 修法）
python3 tmp/p33-shots/route-before-after.py       # 路由级前后对比（/api/ui/panels?view=supplier）
sh      tmp/p33-shots/start-8453.sh &             # 起服务（坏信封夹具）
python3 tmp/p33-shots/receipts-bad.py 8453        # 面板读数 + 私域/哨兵负控（0 命中）+ 非空转对照
tools/verify.sh rfq-visibility                    # 投影层自己的门
```

原始输出与截图落 `tmp/p33-shots/`（报告 `tmp/p33-shots/REPORT.md`）。

## 5 边界（如实登记）

* **SSR 首页的抓手未接**：`/supplier/`（旧 SSR 页）里那个 `data-rfq-items-dropped` 仍是 `0` ——
  它是 `src/system/webui/code/webui.mjs#rfqInboxHtml` 从**已经过投影的** `pkg.rfq.items` 上重算的，
  而该文件不在 P33 的改动面内。读数本身**已经就位**（`packages[].items_dropped`），接上它是一行的事
  （见报告 §边界登记）。GUI 侧（`/app/supplier/`）已按本文 §3 上屏。
* 行项目层的闭合集合目前只有一个原因（`item-not-an-object`）；形状按"可能不止一个"给
  （`items_dropped_reasons[]` 是逐原因的清单）。
