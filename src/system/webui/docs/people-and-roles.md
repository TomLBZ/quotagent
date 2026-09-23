# 人员名册与角色（「同事」= 名册里的人，不是「登录过的人」）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md` §8（名册/角色）与 §9（偏好·布局服务端化）。
     本页讲**怎么用**：名册放哪、怎么维护、@提及/指派/转交 怎么取值、按角色限动作在哪判、怎么复跑。 -->

## 0. 一句话

界面上的「同事」原来是**登录过的人**（活跃会话 + 协作记录里出现过的人）推出来的 ⇒ 名单取决于谁碰巧开过页面，
单位里真实的人反而进不来；也没有任何地方能表达"谁是采购员/主管""谁的直属上级是谁""这一步只有主管能批"。
现在：**名册是权威取值处**（同侧成员 + 角色 + 直属关系），`@提及 / 指派 / 转交`的候选与校验都从它来；
**角色只用来限动作**（谁能批超额、谁有资格转交别人的活），**不改变签署权**。

## 1. 名册放在哪、什么形状

- **文件**：`<ui_shared>/people/roster.json`（目录 **0700** / 文件 **0600**、原子写、有界）。
  界面里「人员名册与角色」面板会显示这份文件的路径与权限。
- **按侧隔离**：每个人带 `side`；一侧的进程/身份**读不到另一侧**的人与额度（`GET /api/people/roster` 按
  **会话所属侧**读；名册维护动作也不许改对面那侧的人 ⇒ `cross-side-member`）。
- **为什么不在账本里**（逐条理由也写在 `code/people.mjs` 文件头）：账本是**合同事实**的 append-only 记录；
  名册/额度是**可改的运营配置**（换人、调额度要能立刻生效），写进账本会改变事件类型目录/证据包哈希/审计
  取证语义，并会把"名册与额度"变成**模型可见输入**。它不进投影、不进 QEP、不进模型输入。
- **形状**（`schema: quotagent/people-roster/v1`）：

```json
{ "roles": [ {"id":"buyer","label":"采购员","rank":10,"approval_limit_cents":0} ],
  "members": { "wanglei": {"name":"wanglei","side":"contractor","role":"buyer",
    "title":"采购一组","reports_to":"limin","active":true,"source":"roster"} },
  "policy": { "transfer": {"enabled":true,"actions":["collab.assign"],
      "override_roles":["supervisor","admin"]},
    "amount_limit": {"enabled":true,"rules":{
      "change.approve":{"object_field":"change_id",
        "fact":{"type":"change/priced","id_field":"change_id","amount_key":"delta_amount","unit":"major"}}}} } }
```

- **额度口径**：`approval_limit_cents` = 这个角色**单独**能批到的金额上限（**整数分**）；`null`/缺省 = **不限**。
  ⚠️ `0` 与"不限"语义相反（`0` = 一分超额都不许批），界面与接口都按这个口径显示。

## 2. 在界面上维护（零终端）

工作台 / 承包商 / 供应商视图都有两块面板：**「人员名册与角色（本侧）」**（我是谁/我的角色/我的额度/直属上级/
直接向我汇报/本侧在册成员/角色表/名册文件）与**「名册表（逐行可改）」**（每人一行，行内动作按名字预填）。

| 动作（命令面板 ⌘K 或工具栏「名册」组） | 干什么 |
|---|---|
| `名册：加人` | 把人加进本侧名册（名字 / 角色 / 职务 / 直属上级） |
| `名册：改角色 / 直属 / 在职` | 只改填了的项；取消勾选"在职" = **停用**（离场，历史留痕，不再进候选名单） |
| `名册：停用（离岗）` | 同上（单独入口）；名册里**唯一的管理员**不能被停用（`role-in-use`） |
| `名册：设定角色` | 加/改角色：标签、等级（比大小）、**审批额度（整数分；留空=不限）** |
| `名册：删除角色` | 还有人在用的角色删不掉（`role-in-use`，会列出是谁）—— 不许悄悄把人降级 |
| `名册：策略（越权转交 / 按角色限动作）` | 谁能转交别人的活（`transfer.override_roles`）；额度规则表（动作 id → 金额从哪条事实取） |

**登录即登记**：一个名字第一次在某一侧登录 ⇒ 自动进名册，角色 = **「待指派」**（有名字、**没有权限**）。
他进得来、看得到，等主管在名册里补角色；**名册里没有、也从没登录过**的名字仍然会被拒（`unknown-colleague`）。

**谁能改名册**：本侧名册里**还没有管理员**时，本侧登录的人可以先配（bootstrap，面板上如实说明）；
一旦有了管理员，改人/改角色/改策略**只有管理员**能做（`admin-required`）—— 免得采购员自己把自己升上去。

## 3. `@提及 / 指派 / 转交` 从名册取值（带自动补全）

- **自动补全**：`GET /api/people/suggest`（只读、按会话侧）；外壳的字段声明 `suggest_url` ⇒ 客户端渲染
  `<datalist>` 原生候选（键盘上下选，也可以照旧手敲）；`mention_suggest_url` ⇒ 在长文本正文里打 `@` 弹出候选，
  点一下/回车就插进去。候选的 `value` 就是入参值（`limin`），`label` 带角色与在线状态。
- **指派 / 转交**：`to` 必须是**本侧在册成员**，否则 `unknown-colleague`（拒绝时列出本侧名册）。
- **`@同事`**：正文里的 `@<名字>` 命中名册 ⇒ 通知到人；跨侧名字 ⇒ `cross-side-mentioned`（拒）；
  名册里没有 ⇒ 进 `unresolved`（**不假装通知到了**）。

## 4. 按角色**限动作**（不是限视图）

两条判据都在**服务端**，都在「动作真正执行之前」生效（拒绝时账本与待办件**零新增**）：

1. **转交别人的活**（`collab.assign` 已经有人接手时）：只有**归我**（当前指派给我）或**我指派的**
   （当前指派是我下的）才能转交；否则要 `policy.transfer.override_roles` 里的角色（默认 `supervisor`/`admin`），
   且理由必填（拒绝码 `transfer-not-yours`，回执里给出当前指派给谁/由谁指派/我是什么角色）。
2. **额度**（`policy.amount_limit.rules`）：规则声明「哪个动作 + 金额从**哪条事实**取 + 单位（`major` 元 / `minor` 分）」；
   动作金额超过**我的角色**额度 ⇒ `role-limit-exceeded`，回执里给出金额、我的额度、**该找哪个角色**。
   金额取不到时按 `unknown_amount`（默认 `refuse`：宁可拦下一次也不放过越权）。

**角色不改变签署权**（结构性，不靠评审）：额度判据在 `/api/action/<id>` 的「署名 == 会话身份」之后、
插件自己的服务端一半之前；它**只能否决**，不能放开 —— 主管也不能替别人签、不能跳过人工门。

## 5. 通知偏好 / 已读 / 布局 / 筛选**全部服务端化**

- **接口**：`GET|POST /api/ui/notif-state`（`POST` 整体替换）；落 `<ui_shared>/webui/notif-state.json`
  （目录 0700 / 文件 **0600**、原子写、有界、洗净：形状不对的**丢掉并如实计数**在 `dropped` 里）。
- **归属**：按**会话身份**（`human:<名字>`）⇒ **换浏览器、换设备仍在**（读回同一份文件）；身份之间互不可见；
  未登录 ⇒ 401（那时界面如实说明"只在本浏览器有效"，localStorage 降为离线镜像）。
- **含**：已读集合、静音的插件、最低级别、**面板布局（顺序 / 折叠 / 隐藏，按「视图+对象类」分桶）**、筛选片选择。
- **不是什么**：偏好不是业务承诺 ⇒ **不进账本**（`ledger: zero-management`）。

## 6. 只读路由的方法围栏（405）

`/api/collab/{hub,object,store}`、`/api/people/{roster,suggest,store}` 等**只读**路由收到非 GET ⇒
**405 + `method-not-allowed` + 响应头 `Allow: GET`**，且**先按方法判据拒绝**、再做身份校验（顺序反了会变成 401，
"只读路由不接受写"这条契约就失效）。机检：`tools/verify.sh quote-draft` 的第 ③ 条（拿 `/api/routes` 逐条 POST）。

## 7. 复跑与证据

```bash
python3 tmp/p5-people-verify.py     # 自造夹具（g1side 走查）+ 独立服务（8290）+ 4 个真实身份 + 55 条断言
```

覆盖：名册可读/按侧隔离/未登录 401、@提及与补全（未知名字如实拒）、转交受限（归我/我指派的/角色 override）、
按角色限动作（额度读**真事实**；越权拒绝且**账本零新增**）、角色不改变签署权（`signer-mismatch`）、
偏好/布局换"浏览器"仍在且按身份隔离、六条只读路由 405 契约 + `/api/routes` 全表走查、
`/workspace/config.yaml` 字节不变。截图见 `tmp/p5-shots/`。

## 8. 已知边界（如实清单）

1. 名册是**界面级配置**（`host.now()` 的时间戳，不是账本事实时刻）；有界（成员 200 / 角色 24，超出**如实拒**）。
2. 「登录即登记」会让每个登录过的名字进名册（角色「待指派」）—— 这是**故意**的：进得来、但**没有权限**；
   不需要的人由管理员在名册里停用。
3. `unknown_amount: refuse` 时，**事实还没落账**的动作会被额度判据拦下（这是"宁可拦一次"的选择，可在界面改）。
4. 名册**不是**权威人事系统：它没有与上游 HR 同步，也不做离职流程；它是"这一侧的人怎么协作"的配置面。

## 9. 主管/审批人视角的一日走查（P41：只用手界面、空数据）

复跑 `sh tmp/p41-shots/p41-start.sh`（端口 8480、私有数据目录与私有受管配置，**不碰** `/workspace/config.yaml`）；
逐步截图 `tmp/p41-shots/*.png`、完整清单与复现 `tmp/p41-shots/REPORT.md`。走通的一段：登录 → 名册加人 /
改角色 / 设角色额度 / 策略 → 审批队列（批准 / 驳回 / **批量一次署名逐条落账** / 催办 / 升级 / 委托 / 终止）→
越界提门再回头批 → 从一条 PO 回溯报价与**人工门**（五段）→ 周报五项 + 逐行对账。

**两套额度不是一回事**（最容易被读混）：`authority.bands.<角色>`（buyer/lead/director，读受管 YAML，业务界面
**没有**入口）管「这一笔钱谁能批」；名册角色额度（`approval_limit_cents` + `policy.amount_limit.rules`，界面上
可改、**立刻生效**）管「谁能执行受额度限制的动作」。两处口径与角色名都不同，面板 note 已写明。

**仍做不到（外壳/写者面，明细见报告）**：**终止（abort）的理由正文现在逐字进账本**
（`approval/aborted.comment`，ADR-0023）⇒「为什么作废」已能答出，`已决定的门` 里 aborted 行的
「谁决定的」也按 `aborted_by` 兜底不再空白（口径与实测见 `decided-gates-and-abort-reason.md`）；
授权区间面板读的是 `QUOTAGENT_UI_CONFIG`/`/workspace/config.yaml`，**不是** `--config-file`
（壳配置不带 `config_file`）⇒ 用 `--config-file` 起的服务会显示"未配置"而实际配好了（已在插件侧优先取宿主给的路径）。
**`award.commit` / `po.issue` 自动开的那条门，账本行 `actor` 仍是写者默认值 `agent:approval`**
（`src/domain/commitments/tools/commitment-apply.py:530/654/813` 三处 `ApprovalService(ledger=ledger)`
没把已解析出来的 `actor` 传进去；一行修法 = `ApprovalService(ledger=ledger, actor=actor)`）——
写者面不在 P43 可改面内 ⇒ 只登记；界面侧改为**如实标注**（见 §10「请求人不是人」条）。

## 10. 角色/额度术语：**唯一映射**（P43）

两套角色 id **不是同一套**（不改口径、不抹平差异）—— 界面上「人话在前、内部 id 在括号」，
机读面（动作入参、`result`、配置键）照旧用内部 id：

| 在哪 | 内部 id（机读面） | 界面人话 | 管什么 | 真源 |
|---|---|---|---|---|
| 授权区间 | `buyer` / `lead` / `director` | 采购员 / 主管 / 管理员 | **这一笔钱**谁能批（越界找谁） | 受管 YAML `authority.bands.<角色>`（`system/authority-band`） |
| 名册角色额度 | `pending` / `buyer` / `supervisor` / `admin` | 待指派 / 采购员 / 主管 / 管理员 | 谁能**执行受额度限制的动作**（`role-limit-exceeded`） | `<ui_shared>/people/roster.json` 的 `roles[]`（界面上可改、立刻生效） |

**映射只有一份**：`src/domain/authority-band/code/ui.mjs` 的 `ROLE_TERMS`（+ `roleTerm`/`roleIdOf`/`roleOptions`/`roleCell`）；
审批队列、状态栏、授权区间面板都从它取词；动作的 `role` 入参**同时认** `buyer`、`采购员`、`采购员（buyer）` 三种写法
（判据一条）。**`lead`（授权区间的主管档）与 `supervisor`（名册的主管）不是同一个角色 id**，改一处不影响另一处 ——
面板 note 把这条对照逐条写出来，不靠一句"两套口径"让用户自己猜。

**请求人不是人（如实标注）**：`award.commit` / `po.issue` 自动开门的账本行 `actor = agent:approval`（写者面，见 §9）；
门对象页的「请求人」照账本原样显示，**不编一个人类名字**；这条门的署名仍能在 `award/committed.approved_by` /
`po/issued.approved_by` 上逐行读回（批准人 = 会话身份）。

**P43 已修（同一批走查的三条「会误判」）**：① **队列有金额列与越界标识**（`gate.queue` 新增「金额（整数分）」
与「越界？（与「授权区间」同一口径）」两列：金额取自 `award/committed` / `po/issued` / `change/priced` 的账本事实、
口径逐行写在「取自哪条事实」里，取不到就写「取不到」；越界判据用**同一个** `checkOf`、参照角色 = 已登记限额最小的
那一档）；② **工作台只算「点名我的」**（`gate.todo` 与 `commitments#home.gates`：点的是别人的名 ⇒ 降成信息、
写明"你批会被 `approver-not-named` 拒"、**不给「去批准」按钮**，并给「审批队列」按「卡在谁」筛的入口；
未登录时如实说"判定不出来"）；③ **回执/拒绝文案里不再露 CLI 旗标**（`--step escalate/delegate` →
「升级 / 委托」；写者原文留在 `result.writer_text` 里可查）。复跑与截图见 §9 报告 + `tmp/p43-shots/`。
