# 沙盘与演示数据（不看文档也能看见一条真实流转）

<!-- 预算：16 KB。机制真源：`docs/design/29-webui-gui-app.md` §11；本页讲**怎么用**与**边界**。 -->

沙盘解决的问题：新人打开应用，看到的第一屏是"你现在该做什么"，但**看不到一条真实流转长什么样**。
沙盘用一个按钮把 `包 → 报价 → 比价 → 授标 → PO` 真跑一遍（真动作、真唯一写者、真账本事件），
数据落在**沙盘目录**里，随时一键清空 —— **真实账本零新增**。

## 1. 怎么用（三步，全在界面上）

1. **先登录**（一个名字 + 属于哪一侧）：沙盘按**会话身份**分条存放（谁造的谁清），未登录时按钮会如实
   告诉你 `identity-required` 并给出登录地址。
2. **工作台首屏「演示数据（沙盘）」面板** →「造一组演示数据」（会再确认一次）→ 约 1 秒后得到一条完整流转：
   - 承包商侧：`已发布的 RFQ（DEMO-PKG-001）`、`收到的报价（逐行）`、`比价排名`、`授标链`、`采购单（PO）`；
   - 供应商侧：「发给我的 RFQ 包」、`我的草稿`、`已提交的报价`、`发给我的授标意向`。
   面板里的"场景"一行会**逐步骤列出动作 id**，点开前你就知道它会跑什么。
   **每次点都是"从零造一遍"**：机制先把**你这个身份自己的**沙盘目录清掉再跑（回执 `reset` 段如实写
   `existed` 与 `removed_dir`；真实账本/待办件一字未动）。所以**不清空直接再点一次**也得到一条完整
   流转，不会在上一轮的沙盘上叠加（不清会退化成幂等回执：`drafted +0` / 没有新 intent
   ⇒ 第 9 步 `award.confirm` 拿不到 `intent_id`、演示断在半路 —— P37 实测登记）。
3. 看完点**「清空沙盘（回真实面）」**：删掉沙盘目录并关掉沙盘 —— 真实账本、真实待办件一个字节都没动过。
   清空后可以随时再「造一组」，每次都从零开始。

两侧视图底部也有同一块面板（造 / 清在同一处，不用回工作台）。

## 2. 沙盘里到底是什么（口径）

| 问题 | 答案 |
|---|---|
| 数据是真的吗 | **是**。走的是**同一个动作总线**、同一批唯一写者、同一张待办件形状 —— 只是账本/待办件/投递信封的**路径**换成了沙盘目录 |
| 落在哪 | `<ui_shared>/sandbox/<身份>/`：`contractor/ledger.jsonl`、`supplier/ledger.jsonl`、各侧待办件目录、投递信封 |
| 状态存哪 | `<ui_shared>/sandbox/state.json`（目录 0700 / 文件 **0600**、原子写、按身份分条、有界 ≤32 条） |
| 真实账本会动吗 | **不会**。沙盘打开时 `host.config.ledger_*`、`host.sharedDir`、`host.rows()` 全部解析到沙盘路径；写者的 `--ledger` 也来自同一处 ⇒ 写也只进沙盘 |
| 的人签是谁签的 | 沙盘里每一步由机制生成并固定的**演示身份**（本侧那一步用**你的**会话身份，对方那一侧用 `demo-<侧>`，**同一个侧还可以有第二个人** `demo-approver`）。**真实面上这条替换不存在**：HTTP 动作请求仍只认会话身份，`signer-mismatch` 一字未改 |
| 它进账本吗（真实口径） | 沙盘账本**是**账本事件（同一批写者写的），但它**不是真实账本那一份**；`/api/ui/surface` 的 `sandbox` 段自述了 `why_not_ledger` |
| 名册/协作/附件 | 名册与协作**也切到沙盘目录那一份**（P50：机制按需另建同一个 store，只是 `ui_shared` 指沙盘目录）⇒ 沙盘能造一份**临时名册**（含同侧的第二个演示身份），随「清空沙盘」一起删；**附件仍是真实面**（演示场景不用它）—— 如实登记的边界 |

## 3. 场景由插件声明（插件作者看这一节）

外壳不认识任何业务步骤；场景是**声明**出来的（`ui-surface.mjs` 的第 ⑨ 类 `scenario`）：

```js
surface.scenario({ plugin_id: me, id: 'scenario.rfq-publish', scenario: 'demo.procurement',
  scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO', title: '① 发包（承包商发起）',
  view: 'contractor', order: 10, hint: '发一包：包 id / 条目 / 邀请 realm 都用演示值',
  steps: [{ action: 'rfq.publish', input: { package_id: 'DEMO-PKG-001', /* … */ actor: '$actor',
    confirm_ack: '1' } }] })
```

- `scenario` 是**分组键**：多个插件各自贡献自己那一段，按 `order` 串成一条流程（本仓已就位的四段见
  `domain/rfq`、`domain/quote-prepare`、`domain/compare`、`domain/commitments` 的 `code/ui.mjs`）。
- `steps[].as = {side, human?}`：这一步由**哪一侧**发起（`side`）；**同侧还想换人**时给 `human`
  （P50：值必须是本次沙盘**声明的**演示身份之一，否则这一步被拒 `unknown-sandbox-actor` —— 不静默换成别人）。
- `steps[].capture = '<名字>'`：把这一步的回执留下，后面的步骤用 `$cap.<名字>.<字段>` 取；
  `$last.<字段>` 取**上一步**的；`$actor` = 这一步的演示身份；`$actors.<键>` = 本次演示的某个身份
  （键就是 `actors` 里的键：`contractor` / `supplier` / `home` / `contractor:2`）——
  开单时点名**另一个人**批就用它：`approvers: '$actors.contractor:2'`。
- `steps[].optional = true`：这一步失败**不算整条流程失败**（照旧往下跑，失败原样记进回执的
  `optional_failures` 并在面板上如实说明）。**本仓的演示流程里没有 `optional` 步骤**：P40 修掉写者
  只认单行报价形状的根因（`prepared_of` 按 29 §7.5 认 `lines[]`）之后，`compare.save-weights` 在
  多行报价的沙盘里也**真能落一条 `compare/rank-computed`** —— 它现在是**必过**的一步，失败就是真失败
  （照实报，不吞）。P49 又补了一件事：它在**界面上**的入口（引导区/行内/命令面板）也真的能开出来了
  —— 见 `entry-policy-and-empty-state.md` §6。
- 步骤的 `input` 里**不要**写死人名：一律用 `$actor`（HTTP 面上没人能替你签，沙盘里机制也不接受乱填的署名）。

## 4. 自述与复跑

- `GET /api/ui/surface` 的 `sandbox` 段：`plugin_id` / `state_file` / `dir` / `max_actors` / `scenarios[]`
  （每个场景的步骤、声明者、`optional`）/ `why_not_ledger` / `http.note`（沙盘**没有独立路由**，
  入口就是 `sandbox.seed`、`sandbox.clear` 两个动作）。
- 机检：`python3 tmp/p7-sandbox-verify.py`（真起服务、真 cookie 会话、真写者；断言未登录被拒、
  **步数与顺序 = `/api/ui/surface` 里插件声明的场景（P48 起 **16 步**：包→报价×2→比价+落评估→授标链→
  **开承诺门→另一个人批→承诺**→**开 PO 门→另一个人批**→PO→回签；两道门是真门，见 §6）
  且每一步都 ok**、沙盘账本含 8 类事件、**真实账本 sha256 前后一致**、面板只出沙盘数据、权限 0600/0700、
  清空后目录消失且真实账本仍逐字节一致）。退出码 0 = 全通过（本轮修前 11/23、修后 23/23）。

## 4b. 两条机制级前提（沙盘"一键造数据"必须有的，缺一条就卡死或被拒）

沙盘是**外壳机制**，它把整条场景丢回**同一个动作总线** —— 这条"动作里再 dispatch 动作"的路，把两条
既有机制逼出了必须显式处理的情形（都不是判据放松，而是把口径说清）：

1. **唯一写者闸门按"异步链"可重入**（`code/app-shell.mjs` 的 `WRITER_GATE_CHAIN`）：
   外层 `sandbox.seed` 先取到闸门，`runScenario` 再把每一步 dispatch 回总线 ⇒ 内层若再取**同一把锁**
   就是**自己等自己**（持有者是本进程、锁又不陈旧）——实测挂满 120 s 报 `writer-gate-timeout`、
   第 1 步 `rfq.publish` 根本没开始、账本零新增。现在的判据：**同一条异步链上已持有同一把锁** ⇒
   内层只标记 `reentrant`（**不取票、不放锁**，放开由最外层那次做）。互斥一字未改：并发请求各在自己的
   异步链上，仍被同一把文件锁挡在外面（反面量过一次：6 个并发写动作全部成功、`timeouts=0`、
   `reentrant=0`、两侧账本无重复 `seq`、无断链 —— `tmp/p37-shots/gate-concurrency-probe.py`）。
2. **场景步骤自己带上"读到的那一版"**（`runActionInner(..., {chainSeeded: true})`）：
   与界面同一条纪律（29 §14：界面把"你看到的那一版"填进 `expected_version` 再保存）。演示里
   "另一家候选"的第二次 `quote.draft` 打的是**同一个对象**（`quote-draft` = 我方对这份包的报价草稿）
   ⇒ 不带版本会被乐观并发闸判 `object-changed`（演示第 4 步自 P14 起一直红的真因）。现在由机制在
   派发前把**当前那一版**填进去：沙盘里只有这条链在写、而且它整段持着写者闸门 ⇒ "读到"与"派发"
   之间插不进别人的写。**HTTP 入口一个字都没变**（界面怎么带版本还怎么带）。
3. **闸门锁面 = 本会话的有效数据目录**（`code/app-shell.mjs#writerGateFace()` → `effective().dir`）：
   主线程动作与动作运行时（worker）**同一来源**取锁 —— 沙盘打开时两半都锁
   `<ui_shared>/sandbox/<身份>/webui/writer.lock`、关着时都锁 `<ui_shared>/webui/writer.lock`。
   改前是主线程按真实 `sharedDir`、worker 按 `effective().dir` ⇒ **两个锁面**：同一个沙盘里
   "批量（worker）"与"单条写（主线程）"各锁各的（沙盘账本反而没有互斥），而且**跨面互相干扰**
   （真实面持锁会挡住沙盘面的写）。**跨面本来就不需要互斥**：两个面写的是两份账本
   （`effective().config.ledger_*` 各指一份文件）⇒ 只要各自面内互斥即可。
   读数（改前树 vs 本树，同一套探针）：`tmp/p38-shots/gate-faces-probe.py`（本树，29/29：
   真实面 6 并发 + 沙盘面 6 并发全 ok、两侧账本无重复 `seq`/无断链、`timeouts` 0、跨面持锁 0 干扰、
   持沙盘锁时批量（worker）逐条 `writer-gate-timeout`）；对照 `tmp/p38-shots/gate-faces-before-probe.py`
   （改前树：持沙盘锁时沙盘面的单条写**照样成功**、同刻 worker 却逐条被拒 ⇒ 两个锁面共存）。

## 5. 想知道"沙盘模式是不是开着"

- 顶栏「身份」旁边没有额外徽标时，看**面板/状态栏读数**：沙盘打开时那块面板第一行是
  `沙盘已打开（N 条可用场景）` 并给出沙盘目录与演示身份；关着时是 `沙盘未打开（你现在看的是真实数据）`。
- 程序化核对：`host.sandbox`（插件侧）给出 `{on, actors, human, dir}`；
  `GET /api/ui/surface` → `sandbox` 段给出存储自述。

## 6. 人门在沙盘里的样子（P48 → P50：同侧的**两个**演示身份 + 临时名册）

承诺与发 PO **只消费一扇别人批过的门**（判据见 `identity-and-selfservice.md` §人门）。P48 时沙盘的演示身份
**按档位**生成（`actors[side]`）、**不建名册** ⇒ 同侧造不出第二个人，只能借 `home` 档造"批门的人"（`demo-home`）。
P50 把这件事做正：会话所属侧多一个演示身份 **`demo-approver`**（键 `contractor:2`），并给它造一份**临时名册**：

| 机制 | 判据/读数 |
|---|---|
| 第二个演示身份 | `actors = {<会话侧>: <你>, '<会话侧>:2': 'demo-approver', <其它侧>: 'demo-<侧>'}`；场景里用 `as: {side, human:'demo-approver'}` 让某一步由它发起 |
| 临时名册 | `<沙盘目录>/people/roster.json`（**0600**，与真实名册同一套结构）：`limin`（角色照抄真实名册，**不抬高**）、`demo-approver`（角色 `supervisor`，额度按出厂角色表）、`demo-supplier`。名册/协作/`@提及`/角色校验在沙盘作用域里都读这一份 |
| 读到的证据 | 沙盘作用域里的「人员名册与角色」面板写「本侧在册成员（2 人）：@demo-approver（主管）@limin（待指派）」；真实名册里**没有** `demo-approver` |
| 真实面零改动 | 两侧账本 + `people/roster.json` + `collab/<侧>.json` 的 sha256 在 `seed` 前后、`clear` 前后**逐字节一致**；`clear` 之后沙盘目录不存在（零残留） |

演示出来的读数与真实面**同形**（实测沙盘账本）：`approval/requested`（`actor=human:limin`、
`approvers=[human:demo-approver]`）→ `approval/granted`（`decided_by=human:demo-approver`）→
`award/committed`（`actor=human:limin`、`approved_by=human:demo-approver`）⇒ 面板写「**谁批的 ≠ 谁签的**」，
而且批的人**就在同一侧**（不是借对面档）。沙盘**不放宽任何判据**：没有门、或批的人就是署名者 ⇒ 写者照样
具名拒（`approval-required` / `approver-must-differ`），账本零新增。复跑：
`python3 tmp/p50-shots/p50-sandbox.py --port <端口>`（读数 `tmp/p50-shots/p50-sandbox-log.jsonl`，
截图 `tmp/p50-shots/21-sandbox-two-actors.png`）。
