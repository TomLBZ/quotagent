# 员工工作流驱动的 UI 重做规格（UI Workflow Rework）

- 状态：**规格 + 实测证据（未实现）**。本文件不改代码、不改门、不改 AC/FR 定义。
- 起因（用户原话，逐字）：「你的UI设计逻辑不对，首先视觉效果很差像是上世纪的表单，不像一个APP。其次，你目前UI提供的功能说到底只有信息聚合，报价双方都无法在UI上做出任何有效的行为。你可以用subagent试图用这个UI做事情，会发现什么都做不了。你应该用subagent模拟真正的承包商的采购员工、供应商的报价员工等等，而不是某种上帝视角的检察员。你要从双方员工的实际工作内容出发，让他们不离开本APP就能够完成所有的、每一步的工作内容，而不只是检查信息。」
- 与既有文档的关系：`tmp/` 阶段的三份草稿（`gui-交互规格` / `ux-双方痛点与交互需求` / `config-凭据UX规格`，均为 `.md.txt`，见 T-303 与 **T-220** 系列规划的 GUI 批次）给的是**路由表与痛点分类**；本文件给的是**以两个员工的每一步工作为单位**的实测缺口 + 目标页面 + 可机检断言 + 视觉规格。落表关系见 §6。
- 事实基线：2026-09-22，服务 `127.0.0.1:8093`（`host/cli.mjs webui --ui-shared tmp/ui-shared`），写探针在沙箱实例 `127.0.0.1:8099`（`--ui-shared tmp/ui-rework-probe`，真 `tmp/ui-shared` 的副本）上做。
- 原始证据：`docs/work/evidence/EV-158-ui-workflow-rework.txt`（含逐步骤命令与逐字响应、假成功 sha 对照、账本前后 sha、视觉 26 页量测）。

---

## 0. 结论（先给数字）

两个角色各按真实工作链逐步走完，**能完整完成的步骤 = 0**：

| 角色 | 工作链 | 步骤数 | **能做到的步骤** | **卡住的步骤** | 探测性动作（31 / 27 次）中卡住或假成功 |
|---|---|---|---|---|---|
| 承包商采购员 | 开 RFQ → 收报价 → 比价 → 选标 → 发 PO → 变更单 | 6 | **0** | **6** | **20 / 31**（其中 1 次是「假成功」） |
| 供应商报价员 | 收 RFQ → 报价/改报 → 澄清 → 确认中标 → 处理变更 | 5 | **0** | **5** | **16 / 27** |
| 合计 | — | 11 | **0** | **11** | 36 / 58 = 62% |

「能做到」的判据不是「页面能不能打开」（页面几乎都能打开，且很好看地列出了账本事实），而是**这一步的员工动作能不能产生一条推进流程的事实**（对照账本 sha 与页面事实）。全部 58 次探测跑完，两侧账本 `contractor 34 行 / supplier 20 行`、sha 逐字节不变——**没有任何一次网页动作推进了状态**。唯二真能闭环的是：

1. `POST /quotagent/<view>/gates/nudge`（催办）与
2. `POST /quotagent/<view>/deadlines/promise`（登记承诺）

两条都**只落一条 0600 待办件、账本零新增**，必须再跑一条终端命令（`tools/gate-nudge.py` / `tools/rfq-promise.py`）才会落账；而 `nudge` 在真实状态下**不可用**（见 §1.3 第 4 条），`promise` 对供应商**不可用**（见 §1.3 第 2 条）。也就是说：**这套 UI 给两个员工的可用动作 = 0 个**，与用户的判断一致。

---

> **本规格共三部分（单文件超 32 KB 预算，按 `docs/design/12-documentation-standard.md` §1 的"拆文件"优先序拆开）：**
> ① `docs/work/plans/ui-workflow-rework.md` = §0 结论 + §1 实测证据 + §2 缺口清单；
> ② `docs/work/plans/ui-workflow-rework-part2.md` = §3 目标交互规格（两个角色每一步的页面/控件/写操作/双向闭环/人工门呈现）；
> ③ `docs/work/plans/ui-workflow-rework-part3.md` = §4 视觉规格 + §5 分批建议 + §6 与既有文档的关系 + §7 未决。
> 原始证据：`docs/work/evidence/EV-158-ui-workflow-rework.txt`。
## 1. 实测证据（怎么验的、验出什么）

### 1.1 逐步骤实测表（摘要，全文见 EV-158）

命令前缀一律 `curl -s -X <METHOD> http://127.0.0.1:8093/quotagent<PATH>`（写探针在 `8099`）。判定口径：

- `能看` = `GET` 200（只读页面/JSON）；
- `无此页面` = `GET` 404（**这个动作在 UI 上没有入口**）；
- `卡住：没有写路由` = `POST` 404（连一个能接住这个动作的端点都没有）；
- `卡住：写路由存在但当前不可用` = `POST` 404 且带业务拒绝码（`gate-not-found` / `rfq-not-found`）；
- **`假成功`** = `POST` 200 且响应体与同一个 `GET` **逐字节相同**（动作没发生、HTTP 也没报错——比 404 更坏，因为人无法从响应判断自己成没成功）。

| 角色 | 步骤 | 员工要做的动作 → HTTP | 判定 |
|---|---|---|---|
| 承包商采购员 | C1 开 RFQ | 打开包列表 `GET /contractor/rfq/` → 404；发布包 `POST /contractor/rfq/publish` → 404；`POST /contractor/rfq` → 404；`POST /contractor/packages` → 404；只有 `GET /contractor/api/events?type=rfq/` 200 能**看**已发布事实 | **卡住**（全 4 个入口不存在） |
| 承包商采购员 | C2 收报价 | `GET /contractor/quotes/` 200 能看；签收 `POST /contractor/quotes/receive` 404；接受 `POST /contractor/quotes/q-ui-seed/accept` 404；`GET /contractor/api/quotes` 404 | **卡住** |
| 承包商采购员 | C3 比价 | `GET /contractor/heuristics/?w_price=…` 200（改 URL 参数就能重排，**不落任何事实**）；`POST /contractor/heuristics` → **200 假成功**；`POST /contractor/compare/export` 404；`POST /contractor/compare` 404 | **卡住**（含 1 次假成功） |
| 承包商采购员 | C4 选标 | `GET /contractor/award/` 404；`POST /contractor/award/intent` 404；`POST /contractor/award/commit` 404；`POST /contractor/quotes/<id>/award` 404 | **卡住** |
| 承包商采购员 | C5 发 PO | `GET /contractor/po/` 404；`POST /contractor/po/issue` 404；`POST /contractor/award/aw-0001/po` 404；`GET /contractor/po/po-0001/` 404 | **卡住** |
| 承包商采购员 | C6 变更单 | `GET /contractor/changes/chg-0001/` 200（逐行明细，只读）；`POST …/propose` 404；`POST …/approve` 404（符合铁律）；`POST /contractor/changes` 404 | **卡住**（只能看明细 + 催办） |
| 供应商报价员 | S1 收 RFQ | `GET /supplier/` 200 但正文写「本视角暂无 RFQ 事件」；`GET /supplier/api/events?type=rfq/` 200 但 6 条里 **0 条 `rfq/*`**；`GET /supplier/rfq/` 404；`POST /supplier/rfq/ack` 404；`GET /supplier/deadlines/` 200 但 `degraded=no-usable-inputs`、`RFQ 条目 0 条` | **卡住**（**连要报的包都看不见**） |
| 供应商报价员 | S2 报价/改报 | `POST /supplier/quotes/submit` 404；`POST /supplier/quotes/q-ui-seed/amend` 404；`POST …/requote` 404；`POST /supplier/quote` 404；`POST /supplier/quotes` → **200 假成功** | **卡住**（含 1 次假成功） |
| 供应商报价员 | S3 澄清 | `GET /supplier/clarifications/` 200 能看 2 条历史；`POST …/ask` 404；`POST …/ct-0001/answer` 404；`POST /supplier/clarify` 404；**承包商侧 `GET /contractor/clarifications/` → 404**（问了也没人答） | **卡住** |
| 供应商报价员 | S4 确认中标 | `GET /supplier/gates/` 200；`POST /supplier/award/confirm` 404；`POST /supplier/award/aw-0001/confirm` 404；`POST /supplier/commitments/confirm` 404；`POST …/accept-award` 404 | **卡住** |
| 供应商报价员 | S5 处理变更 | `GET /supplier/changes/chg-0001/` → **404 页面**（本视角根本没有变更单）；`POST …/accept` 404；`POST …/ack` 404 | **卡住** |
| 两个角色 | ★ 催办 / 登记承诺 / 反馈 | `POST /contractor/gates/nudge`（ap-0001/ap-0002/awin-0001/ap-0007 四个 id 全试）→ **404 `gate-not-found`**；`POST /supplier/deadlines/promise id=pkg-g1` → **404 `rfq-not-found`**；`POST /contractor/deadlines/promise id=pkg-g1` → **202 accepted**（落 0600 待办件）；`POST /supplier/feedback` → **202**（产品反馈，不是业务动作） | 催办 4/4 不可用；承诺 1/2 可用；反馈可用 |

> 账本对照（全部请求跑完 vs 跑前）：`contractor 34 行 sha256:20782771447a5583` 不变；`supplier 20 行 sha256:85c400e522ebe4bf` 不变。

### 1.2 只有两条真闭环（且两条都要人再跑一次终端）

`POST /contractor/deadlines/promise` 是唯一能在**沙箱里**真闭环的路径，实测：

```sh
# ① 网页（只落 0600 待办件，账本零新增）
curl -s -X POST http://127.0.0.1:8099/quotagent/contractor/deadlines/promise \
  -d 'id=pkg-g1' -d 'by=human:con-probe' -d 'due_at=2026-09-26T00:00:00Z' -d 'note=周五前必回'
# → HTTP 202 {"ok":true,"code":"accepted","id":"rp-contractor-9391b234327a", …}
#    next_action: "跑 python3 tools/rfq-promise.py --now <ISO8601> 消费待办件（**唯一落账本者**…）"

# ② 终端（唯一落账本者）
python3 tools/rfq-promise.py --ui-shared tmp/ui-rework-probe --view contractor --now 2026-09-22T07:00:00Z
# → {"applied":[{"ledger":"…/contractor/ledger.jsonl","body_keys":["actor","due_at","ok","promise_sha256","rfq_id","view"], …}],"ledger_added":1, …}
# 账本 34 → 35 行，sha 由 20782771447a5583 → 8c4e85b00687bccf

# ③ 页面事实随之改变
curl -s http://127.0.0.1:8099/quotagent/contractor/api/deadlines
# → rfqs[0].due_ts="2026-09-26T00:00:00Z"，due_basis 点名取自事实 `rfq/promised`（ts=2026-09-22T07:00:00Z），
#   silent=["supplier:g1"]，remaining_seconds=320400
```

**这就是本仓库唯一被证明可行的"网页能做事"的形状**（宿主只落 0600 待办件 → Python 侧唯一落账本 → 页面按事实重派生）。§3 的全部新写面都按这个形状设计，不发明第二种。

但同一条路径在**供应商侧是死的**：

```sh
curl -s -X POST http://127.0.0.1:8099/quotagent/supplier/deadlines/promise \
  -d 'id=pkg-g1' -d 'by=human:sup-probe' -d 'due_at=2026-09-26T00:00:00Z' -d 'note=周五前回'
# → HTTP 404 {"code":"rfq-not-found","id":"",
#    "next_action":"包 pkg-g1 不在**本视角投影**的 RFQ 列表里（可能写错、或不属于本视角）→
#                  不改任何状态、**账本零新增**；看 /quotagent/supplier/deadlines/ 列出的真 id 再登记"}
```

而供应商自己的 `deadlines` 页面同时写着：「本视角投影里没有发布过的 RFQ（`rfq/published` 一行都没有）」「RFQ 条目 0 条（不是页面坏了）」。**页面指路去另一个页面拿 id，那个页面说自己一个 id 都没有** —— 这是死循环，不是缺一步。

### 1.3 卡住的最关键 5 步（逐条原文）

**第 1 条｜供应商读不到自己要报的包（整条链的起点断了）**
`GET /quotagent/supplier/` 页面原文：

> 最新 RFQ 包：—（本视角暂无 RFQ 事件）

`GET /quotagent/supplier/api/events` 实测 `count=6`，类型分布 `{'quote/submitted': 1, 'quote/cost-built': 1, 'quote/price-proposed': 1, 'quote/human-approved': 1, 'clarification/asked': 1, 'clarification/answered': 1}` —— **`rfq/*` 一条都没有**（承包商侧同一时刻 `count=21`，含 `rfq/published` / `rfq/distributed×2` / `rfq/amended`）。投影把 `rfq/*` 整类挡在供应商视角之外，于是供应商看不到包、看不到 `@rev`、看不到报价截止、看不到改版。

**第 2 条｜供应商唯一能点的业务动作，一提交就是 404（且页面自己也给不出可用的 id）**
`POST /quotagent/supplier/deadlines/promise` 的逐字响应（原文见 §1.2）；同一页面 `GET /quotagent/supplier/api/deadlines` 的逐字降级文案：

> 降级（**不冒充健康、也不给你编条目**）：`no-usable-inputs` —— RFQ 条目 0 条。本视角投影里还没有可供派生的 `rfq/*`、`quote/submitted` 事实行（不是页面坏了）。

**第 3 条｜「下一步（可复制）」不是一个员工能做的动作，而是一条跨角色的走查脚本（原样跑必失败）**
`GET /quotagent/contractor/api/gates` 里 `chg-0001` 的 `next_action` 逐字是：

> `PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3   # 提出变更请求（同阶段落 change/proposed + change/priced）`

原样在仓库根跑：

```
$ PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3
[contractor] 缺少对方产物: /workspace/projects/quotagent/tmp/manual/contractor/08-award-intent.json
```

即：告诉**采购员**去跑**供应商侧**的第 3 相位；而该相位要先有**承包商侧**第 4 相位写出的文件。这不是「一个动作一条命令」的产品 CLI，是有强阶段耦合的走查脚本（`contractor_1..4` × `supplier_1..3`，每个相位读上一步写进共享目录的 JSON）。采购员在网页上点不出 `change/proposed`。

**第 4 条｜唯一的业务写面「催办」，在真实状态下 100% 不可用**
`GET /quotagent/contractor/gates/` 页面原文：

> 还在等的人工门（0 条） 当前没有"还在等"的人工门（口径：本视角投影里最后一条 `approval/*` 不是 granted/denied/aborted）；生成口径下共有 0 条。

实测 4 个 id 全拒：

```
$ curl -s -X POST …/contractor/gates/nudge -d 'id=ap-0001&reason=现场催一下'   → 404 gate-not-found
$ curl -s -X POST …/contractor/gates/nudge -d 'id=ap-0002&reason=现场催一下'   → 404 gate-not-found
$ curl -s -X POST …/contractor/gates/nudge -d 'id=awin-0001&reason=授标流程催一下' → 404 gate-not-found
$ curl -s -X POST …/contractor/gates/nudge -d 'id=ap-0007&reason=现场催一下'   → 404 gate-not-found
```

拒绝体逐字（`ap-0002`）：

> `门 ap-0002 不在**本视角投影**的待办门列表里（可能已决、或不属于本视角）→ 不改任何状态、**账本零新增**；看 /quotagent/contractor/gates/ 列出的真 id 再催`

**而页面表单的 placeholder 示例恰恰是 `ap-0007`** —— 照抄示例必 404。同一页面的 gates 表是空的，所以「去列出真 id 再催」这一步在这里是空操作。页面**看起来**有这个能力（有表单、有按钮、有等价 curl），实际一次也用不了。

**第 5 条｜写动作的「假成功」：200 + 与 GET 逐字节相同**
实测（真服务 8093）：

```
$ curl -s http://127.0.0.1:8093/quotagent/contractor/quotes/ -o /tmp/a.html
$ curl -s -X POST http://127.0.0.1:8093/quotagent/contractor/quotes/ -d 'item=L-001&price=80' -o /tmp/b.html
GET  bytes=3935 sha256=…
POST bytes=3935 sha256=…        ← 两者 sha256 完全相同
```
同形还有 `POST /contractor/heuristics`（7882 B，相同）、`POST /supplier/quotes`（4393 B，相同）、`POST /supplier/clarifications`（3944 B，相同）。对员工的意思是：**他在报价页上"填了单价提交"，浏览器给他 200 和一页正常页面，然后什么都没发生**——账本没动、对方没收到、页面没变。这是本 UI 目前对"想做事的人"的默认反馈。

### 1.4 为什么「能看」也救不了（结构性原因）

`GET /quotagent/api/routes` 的逐字 `write_surface`：

```json
{
  "browser_writable": ["/quotagent/admin/**", "/quotagent/<view>/gates/nudge",
                        "/quotagent/<view>/deadlines/promise"],
  "note": "浏览器永远不能签的五个动作：批准 / 提交报价 / 定标 / 发 PO / 变更批准（人工门在终端）；"
          "宿主也不发信（`rfq-deadline` 的 `can_send=false`）：登记承诺只落 0600 待办件"
}
```
路由表实测：**总 67 条，GET 54 / POST 13**；13 条 POST 里 6 条是 admin 系统管理、6 条是 `<view>/{gates/nudge,deadlines/promise,feedback}`、1 条是提权。**业务动作的写路由 = 3 个**（nudge / promise / feedback），且三者都不是任何一个员工工作链上的推进动作（催办不推进门、承诺不发信、反馈是产品意见）。

另外两条被页面自己明说的硬阻断：

- **发不出去**：`GET /quotagent/ops/mail/` 与 `GET /api/mail` 实测 `smtp.available=false`、`reason=mail-smtp-unconfigured`，计数 `queued=2 / refused=2 / sent=0`。所以"开 RFQ 并通知供应商"这一动作在通道层面就不可能——页面诚实写了（「不能替你发信」），但没有给你任何**替代路径**（比如"导出通知文本给供应商"）。
- **授权区间没配**：`GET /supplier/authority/`（与 contractor 侧同形）实测 `unconfigured=true`、`已登记的授权区间（0 条）`、`覆盖本金额的角色（0 条）`，页面明说「本插件**不会替你编一个限额**」。员工想知道"这笔 17 万我能不能定"，UI 给不出结论（这本身是诚实的设计，但意味着"权限区间"目前是空白，不是能力）。

---

## 2. 缺口清单（按角色、按步骤，条条可施工）

字段含义：**缺什么** → **为什么不能做（实测）** → **在哪层加** → **最小可做的下一步（一次一批能落地的最小切片）**。
层次代号：`投影` = `host/modules/webui.mjs` 的 realm/白名单投影；`插件` = `host/modules/<domain>.mjs`；`路由` = `host/modules/webui.mjs` 的路由表段；`表单` = SSR HTML；`消费` = Python 侧 `tools/*.py`（唯一落账本者）；`权限` = realm/authority/人工门呈现；`通道` = `services/mail_transport.py` / 快照。

### 2.1 承包商采购员

| # | 步骤 | 缺什么 | 为什么不能做（实测） | 在哪层加 | 最小可做的下一步 |
|---|---|---|---|---|---|
| C-gap-1 | C1 开 RFQ | 建包/发/分发三个动作的页面与写路由 | `GET /contractor/rfq/` 404、`POST /contractor/rfq/publish` 404、`POST /contractor/packages` 404 | 路由 + 表单 + 消费 | 只做**建包草稿**一条：`GET /contractor/packages/new` 表单 → `POST /contractor/packages/new` 落 0600 待办件 `tmp/ui-shared/rfq-drafts/<id>.json`（**发布仍走终端**，与五个不可签动作精神一致） |
| C-gap-2 | C1 开 RFQ | 通道不可用时的替代动作 | `mail.smtp.available=false`、`can_send=false` | 通道 + 表单 | 在包详情页加「导出通知正文（可复制）」区块：把包 id/rev/截止/收件人拼成纯文本 + `<textarea readonly>`，**不做任何"已通知"的声明** |
| C-gap-3 | C2 收报价 | 报价的「签收 / 退回 / 要求补件」状态与写路由 | `POST /contractor/quotes/receive` 404；`GET /contractor/api/quotes` 404 | 投影 + 路由 + 表单 + 消费 | 先加 `GET /contractor/api/quotes`（只读 JSON，与页面同口径），让"我到底收到几条"可机检；再加 `POST /contractor/quotes/<id>/review`（`accept`/`reject`/`need-info` 三态）落待办件 |
| C-gap-4 | C3 比价 | 真正的比较表（行=条目，列=供应商）与导出 | 只有 `heuristics` 权重页（改 URL 参数重排，不落事实）；`POST /contractor/compare/export` 404 | 路由 + 表单 + 消费 | `GET /contractor/compare/?package_id=` 只读比较表（数据源用已有 `compare/rank-computed` 事实 + `quotes` 投影）→ 再加 `GET /contractor/compare/export.csv?package_id=` 静态导出 |
| C-gap-5 | C3 比价 | 权重选择能不能"被记住" | `POST /contractor/heuristics` 是**假成功**（200 且与 GET 逐字节相同） | 路由 + 消费 | 把权重视为**事实**：`POST /contractor/compare/weights`（表单）→ 待办件 → Python 落 `compare/weights-set`；页面顶部显示"当前权重来自事实 ts=…" |
| C-gap-6 | C4 选标 | 授标意向（可撤回、无义务）的入口 | `GET /contractor/award/` 404；`POST /contractor/award/intent` 404 | 路由 + 表单 + 消费 | `POST /contractor/award/intent`（`package_id`+`quote_id`+行级选择）→ 待办件 → Python `CommitmentGate.intent()`。**这是唯一可以让网页"真的做事"的选标切片**（意向不产生义务、可撤回） |
| C-gap-7 | C4 选标 | 「准备批准载荷 + 可复制命令」的组件（网页不签，但要让采购员少打错字） | 现在只有一句静态警告「五件事永远在终端做人签」，不给命令、不给 payload | 权限 + 表单 | 在授标详情页加 `data-human-gate-action="award.commit"` 区块：列出 `intent_id`/`approval_id`/金额/行数 + `<pre>` 可复制命令（含 sha256 便于人核对） |
| C-gap-8 | C5 发 PO | PO 的列表/详情/载荷 | `GET /contractor/po/` 404、`POST /contractor/po/issue` 404、`GET /contractor/po/<id>/` 404 | 路由 + 表单 + 权限 | 只做**只读** `GET /contractor/po/`（列 `po/issued` 事实 + 行来源链 `trace_mode`）与 `GET /contractor/po/new?award_id=` 的**载荷准备页**；签发命令交终端 |
| C-gap-9 | C6 变更单 | 提出变更的表单（现在只能看别人的变更） | `POST /contractor/change/<id>/propose` 404；"下一步"指向跨角色走查脚本（§1.3 第 3 条） | 表单 + 消费 | `GET /contractor/changes/new?quote_id=` 行级表单（原单价×原量 → 新量，**原单价只读引用**）→ `POST` 落待办件 → Python `ChangeService.propose()`；P0 只支持"加行/改量"，不支持改单价 |
| C-gap-10 | C6 变更单 | 承包商侧看不到澄清工单 | `GET /contractor/clarifications/` **404**（供应商侧有，承包商侧没有） | 路由 + 投影 | 镜像一条 `GET /contractor/clarifications/`（同一份 SSR 子视图生成函数，白名单按视角不同） |
| C-gap-11 | ★ 催办 | 催办在真实状态下不可用 + 表单示例是死 id | 4/4 id 全部 `gate-not-found`；页面 placeholder 写 `ap-0007` | 表单 + 插件 | ① 表单的候选 id 改成**服务端渲染的 `<select>`**（取自本视角投影里真正还在等/还欠动作的 id，**空集时把表单换成"当前没有可催的门"**而不是留一个必 404 的表单）；② 把 placeholder 死例子换成"从上面列表里选" |

### 2.2 供应商报价员

| # | 步骤 | 缺什么 | 为什么不能做（实测） | 在哪层加 | 最小可做的下一步 |
|---|---|---|---|---|---|
| S-gap-1 | S1 收 RFQ | **供应商看不到自己被邀请的包**（根因，先修这条） | `GET /supplier/` → 「本视角暂无 RFQ 事件」；`/supplier/api/events` 6 条里 0 条 `rfq/*`；`/supplier/deadlines/` → `no-usable-inputs` | 投影 + 权限 | 在 `host/modules/webui.mjs` 的视角白名单里，为 `rfq/distributed` / `rfq/published` 增加**按 recipients 命中本 actor 才可读**的白名单键（`package_id` / `rev` / `quote_by` / `sent_at` / `subject`），其余键一律不出。这是**唯一一处既有铁律允许的投影放宽**（它是"发给我的件"，不是业主私域），且必须与 `supplier` 私域键负控断言同批复跑 |
| S-gap-2 | S1 收 RFQ | 包的读页与「认收」 | `GET /supplier/rfq/` 404、`POST /supplier/rfq/ack` 404 | 路由 + 表单 + 消费 | `GET /supplier/packages/<id>/`（包正文要点 + 条目表 + rev + 截止）与 `POST /supplier/packages/<id>/ack`（→ 待办件 → Python 落 `rfq/acknowledged`）。**认收不是承诺**，是"我收到了、我看过 rev 几" |
| S-gap-3 | S2 报价/改报 | 报价表单（条目级）与提交 | `POST /supplier/quotes/submit` 404、`/amend` 404、`/requote` 404；`POST /supplier/quotes` 是**假成功** | 路由 + 表单 + 消费 + 权限 | 分两批：① `GET /supplier/packages/<id>/quote` 只读报价表（把现有 `quote/*` 事实按条目铺开）；② `POST` 落草稿待办件（**提交行为本身属"五个不可签"之一，网页只准备载荷 + 可复制命令**，见 §3.5） |
| S-gap-4 | S2 报价/改报 | 「已提交、等 Python 侧落账」的可验证结果 | 现在提交后什么都看不到，也无法区分"成功"与"假成功" | 表单 + 路由 | 统一待办件徽标：提交后页面顶部显示 `data-pending="<sha256 前 8 位>"` + 待办件落点路径 + `next_action`；并新增只读 `GET /supplier/api/pending`（列本视角未消费的待办件） |
| S-gap-5 | S3 澄清 | 提问/回答的写路由 | `POST /supplier/clarifications/ask` 404、`/ct-0001/answer` 404；`POST /supplier/clarifications` 假成功 | 路由 + 表单 + 消费 | `POST /supplier/clarifications/ask`（`question` + `refs` 条目多选）与 `POST …/<ticket>/answer` → 待办件 → Python `ClarificationService.ask()/answer()`；**答完自动进对方视角**（§3.4 闭环） |
| S-gap-6 | S4 确认中标 | 本视角根本没有「授标」这一屏 | `GET /supplier/award/` 未定义；`/supplier/api/events` 无 `award/*`；`/supplier/gates/` 的变更/门都是 0 | 投影 + 路由 | 先把 `award/intent-proposed`（命中本供应商的那条）与 `award/committed` 的白名单键投影进供应商视角，再开 `GET /supplier/award/` |
| S-gap-7 | S4 确认中标 | 「确认中标」这个承诺动作的入口 | `POST /supplier/award/<id>/confirm` 404、`/supplier/commitments/confirm` 404 | 表单 + 消费 + 权限 | 网页只准备**声明载荷**（`POST /supplier/award/<id>/confirm-payload` → 待办件，含 `supplier_confirmed` 声明与发言人），由 `tools/award-confirm.py` 落 `award/supplier-confirmed`；网页永不"签收"（§3.5） |
| S-gap-8 | S5 处理变更 | 供应商看不到变更单 | `GET /supplier/changes/chg-0001/` → **404 页面**；`/supplier/api/events` 无 `change/*` | 投影 + 路由 | 先把命中本供应商的 `change/proposed|priced|approved` 白名单键投影进供应商视角（**不含任何金额之外的私域键**），再镜像 `GET /supplier/changes/<id>/` |
| S-gap-9 | S5 处理变更 | 接受/异议的写路由 | `POST /supplier/change/<id>/accept` 404、`POST /supplier/changes/<id>/ack` 404 | 路由 + 表单 + 消费 | `POST /supplier/changes/<id>/respond`（`accept` \| `dispute` + 理由 + 行级勾选）→ 待办件 → Python 落 `change/supplier-responded`；**变更批准仍是人签** |
| S-gap-10 | 两侧 | 澄清无人可答 / 门无人可催 | 承包商侧澄清页 404；gates 0 条 | 路由 + 表单 | 见 C-gap-10、C-gap-11 |

### 2.3 跨角色（不属于某一步，但会卡住任意一步）

| # | 缺什么 | 为什么不能做 | 在哪层加 | 最小可做的下一步 |
|---|---|---|---|---|
| X-gap-1 | 待办件的**可观察性**：员工无法知道"我提交的东西现在在哪、卡在谁手里" | 现在只有 `POST` 返回的 JSON 里有 `next_action`，页面不留痕（`/ops/ui-feedback/` 只覆盖产品反馈） | 路由 + 视图 | 新增 `GET /<view>/pending/`（SSR 表：待办件 id / 动作 / 落点 / 提交时间事实 / `next_action`）与 `GET /<view>/api/pending` |
| X-gap-2 | 两条链的**交接点**没有界面 | 供应商看不到包（S-gap-1）、承包商看不到澄清（C-gap-10）、承包商看不到谁没回（名单在 deadline 页但供应商侧空） | 投影 + 路由 | 先把 S-gap-1 做完，再让 `GET /contractor/deadlines/` 的 `silent` 名单可点进对应包行 |
| X-gap-3 | 授权区间的**空态**没有任何"下一步" | `/supplier/authority/` 与 `/contractor/authority/` 都是 `unconfigured`；页面说"去 `/quotagent/admin/config/` 配"，但业务用户进不去 admin 道（要 token） | 权限 + 视图 | 在两个业务视角的 authority 页加一行**只读**提示：`authority.bands.*` 未配置 → 显示"未经配置，任何金额都得走人工门" + 一条可复制的"请管理员配置"的请求文本（**不**给 admin 链接当捷径） |
| X-gap-4 | 邮件通道不可用时没有替代 | `available=false`、`sent=0`；依赖通道的动作（催报/通知）全断 | 通道 + 表单 | 所有"通知类"动作降级为 **payload 准备 + 可复制正文**（与 C-gap-2 同款组件），页面明确写"未发送" |

---


---

**§1 的逐步骤全文、假成功 sha 对照、账本前后 sha、26 页视觉量测见 `docs/work/evidence/EV-158-ui-workflow-rework.txt`。**
**§3 目标交互规格见 `docs/work/plans/ui-workflow-rework-part2.md`；§4 视觉规格见 `docs/work/plans/ui-workflow-rework-part3.md`。**
