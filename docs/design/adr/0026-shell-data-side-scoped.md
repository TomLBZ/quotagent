# ADR-0026 GUI 外壳共享、**数据按会话侧隔离**（`/app/<侧>/**` 与 `/api/ui/panels|object` 的侧门）

Status: accepted

## Problem

`29 §7` 与 `29 §15` 都写着「侧的判定只认会话」：静态业务路由（`/contractor/**`、`/supplier/**`）未登录拒、
越侧 `403 side-mismatch`（`identity.mjs#gateBusinessRoute`）。但 GUI 应用外壳走的是另一族路径：

- `/app/<view>/` 是**公开入口**（`/api/routes` 里 `auth: none`），`view` 由 **URL** 给；
- 数据由 `/api/ui/panels?view=<view>`、`/api/ui/object?view=<view>` 下发，`view` 是**请求参数**。

P50 实测（同一份数据根、两侧账本都有内容）：拿**承包商身份**（或干脆**不登录**）请求
`/api/ui/panels?view=supplier` 能拿到 **32 行**供应商侧面板数据（`quote.drafts` / `po.inbox` /
`people.roster-supplier` …），`/api/ui/object?view=supplier&kind=po&id=…` 也能拿到对象页头与事实项。
**外壳 HTML 共享本身不是问题**（它不含数据），问题是**数据面没有按会话侧隔离**：换一个 URL 参数就能看
对方那一半。这与 ADR-0024/§15 的产品主张（"侧只认会话"）直接冲突，也说明"`/app/**` 是公开入口"这条
台账口径**不等于**"它的数据对谁都公开"。

## Decision

1. **同一份判据、两处挂载**：`/app/<业务侧>/[<kind>/<id>/]` 用与静态业务路由**同一个函数**
   （`identity.gateBusinessRoute`）：未登录 ⇒ 浏览器 303 去登录 / JSON 401 `identity-required`；
   越侧 ⇒ **403 `side-mismatch`**（不回落成"能看"）。
2. **数据面按会话侧**：`/api/ui/panels`、`/api/ui/object` 的 `view` 是业务侧时，**登录了但不是这一侧** ⇒
   403 `side-mismatch`（同一个 `code`）。
3. **无会话 ⇒ 数据行不下发，机制面照旧**：面板清单/列/动作/口径（"这一页有什么"）继续下发，
   **行/条目/文件 + 派分计数一概清空**并带 `rows_withheld`（含"拦下几行"）与如实 `reason`
   （`app-shell.mjs#withRowsGate`）。**不把它做成 401**：那会把"机制自述"与"数据"一起关掉，也让
   "这一页有什么"在未登录时消失（29 §23 的空态正是靠面板清单渲染）。
4. **非业务视图（`home` 工作台）的行跟着会话侧**：`host.rows(view)` 对非业务视图按 `ctx.identity.side`
   解析（`rowViewFor`），无会话 ⇒ 空 —— 工作台是"我今天要做什么"，不是"两边合在一起看"。
5. **`cross-side-action` 保持第二道防线**：动作服务端一半里 `ctx.view ≠ ctx.identity.side` ⇒ 具名拒
   （写动作在写之前拒、账本零新增）；GUI 正常路径下页面已被 ① 挡住，手搓请求仍会撞上它。
6. **PWA 离线壳只覆盖"网络不可用"**：`sw.js` 的导航回退**不再**把 4xx/5xx 当成离线（否则 403
   `side-mismatch` 会被换成一份离线壳，用户会把"服务端不让你看"读成"你现在离线"）。

## Consequences

- 修后读数：承包商会话 `/api/ui/panels?view=supplier` ⇒ 403（行数 0）；匿名 ⇒ 200 + **行数 0**（面板数
  17/40/37 照旧）；`/app/supplier/`（承包商会话，HTML）⇒ 403 `side-mismatch`；`/app/supplier/`（匿名）
  ⇒ 303 去登录。机检不变量：**无会话或越侧时，拉任一视图的行数恒为 0**。
- **不放松任何既有判据**：业务路由、动作总线的人签门、写者与账本语义一字未动；`/api/routes` 那张表
  仍写 `auth: none`（本批只**追加**门槛，不改台账）。
- 边界（如实登记）：`html` 形状的面板不做行门（它们自渲染一段说明/状态块）；`/api/ui/notifications`
  匿名仍返回条目（29 §17 的 `unread.known=false` 本就预留匿名读）—— 两者都记在
  `src/system/webui/docs/side-scoped-shell-data.md` §4。

## Alternatives rejected

- **只在文档与界面上写"外壳共享、数据按会话侧隔离"**：实测行数**不是** 0（32 行），写这句话就是撒谎；
  P50 的前提是"要么拦、要么证 0"，而"证 0"在这份数据根上不成立。
- **把 `/api/ui/panels` 无会话时改 401**：会让插件自己的路由检查（`src/domain/*/tests/check-*-route.py`
  逐条断言"承接面板注册在两侧视图上"）无谓变红，且"机制自述"不再可读 —— 关掉的信息比要保护的多。
- **只拦 HTML 路由**：那只是把入口藏起来 —— `/api/ui/panels?view=…` 用 curl 照样能拉；数据面的拒绝才是
  真正的执行点。
- **把两侧账本合并成一份再按侧过滤**：会动账本结构与投影口径（ADR 面更大），而侧门与账本结构无关。

## Revisit conditions

1. 若出现**合法的跨侧只读**需求（例如主管要一眼看两边），应新增一个**具名的**跨侧视图（显式授权 +
   界面标注），而不是把 `view` 参数放开 ⇒ 那时新写 ADR。
2. 若通知面也要按侧隔离，先定 §17 的口径变更（含"未登录是否还能读到条目"）⇒ 新写 ADR。
3. 若将来 `home` 工作台要同时展示两侧摘要，先定义"跨侧聚合视图"的授权与标注，再改 `rowViewFor`。
