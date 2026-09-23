# 已决定的门：谁、何时、为什么、依据哪一行（终止理由进账本）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = 完整 GUI 应用）、`AGENTS.md` 规则 11/12；
     账本格式变更 = `docs/design/adr/0023-abort-reason-verbatim-in-ledger-body.md`（追加键，旧行一字不动）。 -->

本页讲**怎么用 / 判据在哪 / 实测读数**：终止（`approval/aborted`）的**理由正文**怎么进账本、已决定的门
（批准 / 驳回 / **终止**）的四问（谁 / 何时 / 为什么 / 依据哪一行）怎么一屏答出、**旧行**（本批之前写入的）
怎么如实呈现，以及**仍做不到**的逐条。复跑见 §4。

## 0. 一句话

审计型产品的底线是「一屏答出**谁、何时、为什么、依据哪一行**」。P41 走查（`tmp/p41-shots/REPORT.md` §4.2/§5.2）
登记了两处空白：① 终止只落 `reason_sha256`，理由正文只活在 **0600 待办件**里 ⇒「为什么作废」答不出；
② `gate.decided` 对 aborted 行读 `decided_by`，而账本里写的是 `aborted_by` ⇒「谁决定的」空着。
本批：**人做的终止把理由正文逐字写进 `approval/aborted.comment`**（与 `approval/denied.comment` 同口径，
**追加键**：不新增事件类型、旧行一个字节不动，ADR-0023），界面四问全部**从账本回读**，缺什么就如实写缺什么。

## 1. 账本事实（键集与新旧行差异）

| 生产者 | 写入的行 | body 键（与本族基底的关系） |
|---|---|---|
| `ApprovalService._append`（唯一写体） | `approval/requested` 及其后同 id 的事件 | 7 基底键 `approval_id`/`scope`/`ref`/`payload_hash`/`status`/`decided_by`/`comment` + 派分事实键 `approvers`/`timeout_policy`/`timeout_s`/`escalate_to`/`requested_at`（ADR-0022；值为 `None` 不写） |
| `tools/gate-actions.py --step abort`（人做的终止） | `approval/aborted` | 上一行 body **+** `action`/`status='aborted'`/`aborted_by`/`aborted_at`/`last_action_at`/`reason_sha256`/**`comment`（理由正文逐字）**/`note` |
| `ApprovalService.sweep()` 的 abort 分支（超时作废） | `approval/aborted` | 同上基底，但 **`comment` 空、不写 `aborted_by`** —— 那里没有人类理由（读侧如实说"没有人写过理由"，不替它编） |

**新增/沿用的键与读侧口径**

- `comment`：人写的理由正文**逐字**（终止、驳回、批准都用同一个键）。它是「为什么」的**唯一事实源**。
- `reason_sha256`：**保留**。它是那份 0600 待办件的完整性锚点（正文与哈希可互证），**不是**理由正文。
- `aborted_by` / `aborted_at`：终止的署名与时刻（终止**不写** `decided_by` —— 作废既不是批准也不是拒绝）。
- **旧行**（本批之前写入的）：`comment` 为空或只有 `reason_sha256`。读侧**如实**说
  「账本只带理由哈希 `sha256:…`，正文在 0600 待办件里」，**不编造、不改写历史**（append-only，旧行字节未动）。

**迁移后写入的新行（原样摘录，`tmp/p42-run/sandbox/human_limin/contractor/ledger.jsonl` seq 19）**：

```json
{"seq": 19, "type": "approval/aborted", "actor": "human:limin", "ts": "2026-09-23T09:53:27.831Z",
 "body": {"approval_id": "ap-0002", "scope": "award.commit", "ref": "aw-2026-0009",
  "payload_hash": "sha256:813e…", "status": "aborted", "decided_by": null,
  "comment": "对方把单价写成了不含税、我们按含税签的；这条承诺作废，让对方重报后再开新门（作废既不是批准也不是拒绝）",
  "approvers": ["human:limin"], "timeout_policy": "abort", "timeout_s": 86400.0,
  "requested_at": "2026-09-23T09:53:16Z", "action": "abort", "aborted_by": "human:limin",
  "aborted_at": "2026-09-23T09:53:27.831Z", "last_action_at": "2026-09-23T09:53:27.831Z",
  "reason_sha256": "sha256:cb62…", "note": "作废本次意图（需重新发起）；不得解释为批准或拒绝"}}
```

**本批之前写入的旧行（原样摘录，`tmp/p42-run/contractor/ledger.jsonl` seq 15，行内**逐字节未动**）**：

```json
{"seq": 15, "type": "approval/aborted", "actor": "human:limin", "ts": "2026-09-23T09:26:35.586Z",
 "body": {"approval_id": "ap-0006", …, "comment": "", "aborted_by": "human:limin",
  "aborted_at": "2026-09-23T09:26:35.586Z", "reason_sha256": "sha256:cd4c4ac6198c07f5a48f0a5d6b7942c7bf02d5e02c08c9b8204be5cb81a86ded", …}}
```

## 2. 界面：四问一屏可答（`gate.decided` / `gate.decided.supplier`）

`src/system/approval/code/ui.mjs` 的「已决定的门」面板列（每列都注明取自哪个账本键）：

| 列 | 取自账本 | 缺的时候（**如实**，不编） |
|---|---|---|
| 结论 | 最后一次 `approval/*` 事件名 + `status` | — |
| 谁决定的（账本署名） | `decided_by`（批准/驳回）；**`aborted_by`**（终止） | `（未记录署名：这一行没带 aborted_by/decided_by；账本行 actor=…）` |
| 决定时刻（账本事实） | `decided_at` → `aborted_at` → **账本行 `ts`** | `（账本行没带时刻）` |
| 为什么（账本 comment / 如实说明） | `comment` 逐字 | 有 `reason_sha256` ⇒「账本只带理由哈希 …，正文在 0600 待办件里，本批之前写入的旧行；不编造」；终止且无哈希 ⇒「账本没有理由正文：超时策略 abort 的自动作废，没有人写过理由」 |
| 依据（账本行） | 该门**最后一次写入**的账本行：`seq` + 事件名 + `actor` | `#—` |

**门对象页**（`/app/<view>/gate/<id>/`，注册者 `domain/commitments`）本来就按
`decided_by || aborted_by || 行 actor` 兜底并且读 `comment` 作「为什么（意见正文）」—— 所以**理由正文一进账本，
那一页自动显示真理由**（本批未改该文件；实测见 §3）。

## 3. 实测（真跑：界面 + 账本原始行）

| 场景 | 界面读数（原文） | 账本原始行 |
|---|---|---|
| **旧行**终止（`ap-0006`，本批之前写入） | 谁决定的 `human:limin`（取自 `aborted_by`）、决定时刻 `2026-09-23T09:26:35.586Z`、为什么「（账本只带理由哈希 sha256:cd4c4ac6… —— 本批之前写入的旧行，正文在 0600 待办件里；不编造）」、依据 `#15 approval/aborted · actor=human:limin` | seq 15，`comment` 为空、`reason_sha256` 在（**未动**） |
| **新行**终止（`ap-0007`，界面「终止这个门」+ 理由） | 谁 `human:limin`、何时 `09:49:20.342Z`、为什么＝理由逐字、依据 `#17 approval/aborted · actor=human:limin` | seq 17，`comment` = 理由逐字 + `aborted_by`/`aborted_at`/`reason_sha256` |
| 开单→终止（沙盘，界面命令面板 `gate.request` + 行内「终止这个门」） | 回执「本次账本 +1 行 · (abort) · 已终止…**理由正文逐字进了 `approval/aborted.comment`**…」 | seq 18/19（见 §1 摘录） |
| **门对象页**（`ap-0002`，已终止） | 请求人 `human:limin` · 请求时刻 `09:53:16Z` · 点名的审批人 `human:limin` · 谁批的/什么时候 `human:limin @ 09:53:27.831Z（aborted）` · **为什么（意见正文）＝理由逐字** | 同上 seq 19 |
| **PO → 报价与门五段**（沙盘 `po-0001`） | `人工门（谁批 / 何时 / 为什么）` = `granted · 谁批的 human:limin · 什么时候 … · 为什么 沙盘演示`；四段链接 `award`/`intent`/`quote`/`gate` 全 **200**（可点） | `po/issued` + `award/committed` + `award/intent-proposed` + `quote/submitted` + `approval/granted` |
| 旧行驳回（`ap-0002` 真实面） | 谁 `human:limin`、何时 `09:21:50.046Z`、为什么「PO 金额与承诺不一致，先核账再签」（逐字） | seq 5，`comment` = 理由逐字（旧口径已如此） |

截图（逐步）：`tmp/p42-shots/41-abort-receipt.png`（终止回执）、`43-decided-panel-rows.png`（已决定的门：
旧 aborted 与 新 aborted 并排）、`46-gate-opened.png`、`47-abort-receipt-final.png`、`48-gate-object-aborted.png`
（门对象页四问）、`44/45/49-*.png`（沙盘造/清）。

## 4. 复跑

```sh
sh tmp/p42-shots/p42-start.sh                       # 端口 8484、数据目录 tmp/p42-run、私有受管配置
python3 src/system/repo-gate/tools/body-keys-audit.py   # 事件 body 键集逐字机检（§6；P44 搬进仓内，判据未改）
python3 tmp/p42-shots/panel-probe.py                # 面板四问 + 旧行呈现（只读，打印 JSON）
# P44 复跑（写者面收口 + 读侧对照）：tmp/p44-shots/{p44-start.sh,p44-writer-face-real-run.py,p44-panel-probe.py}
# 停服务：按端口拿 PID 再 kill（不要用 pkill -f "…8484"）
PID=$(ps -eo pid,cmd | grep "[c]li.mjs webui" | grep -F -- "--port 8484 " | awk '{print $1}'); kill $PID
```

## 5. 仍做不到 / 不在本批可改面内（如实登记）

1. **超时作废没有人类理由**（`sweep()` 的 abort 分支）：这是**有意**的 —— 不编一句"为什么"。界面对这类行
   写「没有理由正文：超时策略 abort 的自动作废，没有人写过理由」，并给出 `timeout_policy`/`请求时刻`/行 `ts`
   供人自行推断（判据不在界面里编）。
2. **门对象页的状态文案**显示账本里的英文状态（`aborted`）而不是「已终止」（该页在
   `src/domain/commitments/code/ui.mjs`，不在本批可改面内）；**谁/何时/为什么三问已经齐**（§3）。
3. **同一事件多个写者的键集不同**（逐字机检的「多写者形状不同」类偏差）：**P44 已把两个越界写者收回** ——
   `src/domain/quote-prepare/tools/quote-sign.py` 与 `src/system/webui/tools/identity-mail-apply.py` 不再自己拼
   `approval/requested` / `approval/granted` 的 body，改为**调 `ApprovalService.request()/decide()`**
   （键集/门号/署名口径与队列、门对象页、`gate-actions.py` 同源）⇒ 由这条路开的门在队列里**答得出
   「卡在谁 / 超时剩余」**。门号仍是**确定性派生**（同一份草稿/配置 ⇒ 同一个 `ap-NNNN`），做法是把服务的
   计数器推到该号前一号，**不重造 id 生成器**、不改既有回执字段。
   机检里**仍剩 3 条**「多写者形状不同」，逐条写清为何（写者不在本批可改面内，且事实本来就不同）：

   | 事件 | 两个/三个写者 | 为什么留着 |
   |---|---|---|
   | `approval/aborted` | `ApprovalService.sweep()`（超时，12 键） / `tools/gate-actions.py`（人，`**上一行 body` + 8 键） | 超时作废**没有人类理由**（不写 `aborted_by`/`comment`），人的终止**有**（ADR-0023）——键集不同是事实；`gate-actions.py` 不在本批可改面内 |
   | `approval/escalated` | `ApprovalService.sweep()`（超时，12 键） / `tools/gate-actions.py`（人的升级/委托，`**上一行 body` + 8 个追加键） | 同上；两边都不是新事件类型，读侧按缺省处理 |
   | `quote/submitted` | `quote-sign.py` 提交行（多行带 `lines`） / `quote-sign.py` 承包商登记行（多 `supplier`） / `code/commitments.py#submit_quote`（9 键） | 后两个写者（`domain/commitments/code/**`）不在本批可改面内；三行的键集差异是**登记面 vs 事实面**的设计 |
4. **`05-events.md` 的 body 声明**：**P44 已补齐** —— `approval/granted`/`denied`/`reminded`/`escalated` 现在逐行声明
   （前三者 = 与 `approval/requested` **同一写体、同一键集** 12 键；`escalated` = 两个生产者的并集 20 键，逐条点名），
   `quote/submitted`（16 键）、`quote/drafted`（14 键）、`evidence/retention-archived`（3 键）也从「计数式/散文式」
   改成**逐条给键名**。判定口径 = 「声明 = 实现」，机检现在只剩上表那 3 条（**声明与实现的键集已经逐字对齐**）。
5. **队列金额列 / 卡头按审批人算**：属于并发批次在改的同一文件（`src/system/approval/code/ui.mjs`），本页不表态。

## 6. 逐字机检：`docs/design/05-events.md` 的 body 声明 ↔ 实现

脚本：**仓内固定位置** `src/system/repo-gate/tools/body-keys-audit.py`（只读、AST 解析落账写者；P44 从
`tmp/p42-shots/` 搬进来，**判据一行未改**，只把输出改成可选 `--json PATH`）。复跑：

```sh
python3 src/system/repo-gate/tools/body-keys-audit.py            # stdout；rc=1 = 有偏差
python3 src/system/repo-gate/tools/body-keys-audit.py --json /tmp/body-keys.json
```

判据：声明侧只认表格行说明列里以 `body …` 开头的段（反引号键名，截到句末；
含 `/` 的反引号 token 是事件名不算键；写「与 `X` **同基底**」的行**继承** X 行声明的键，继承关系打印在输出里）；
实现侧解析 `.append(<事件>, <body>)`（含模块常量事件名、局部变量与 `**` 展开、`Service._append` 原地重拼 body
与「原样包装」两种形态）；偏差分四类：`未声明` / `声明了没写` / `写了没声明` / `多写者形状不同`。

**P44 对判据做过的唯一一处修正（准确性，不是放松）**：同名变量在**同一个函数里被赋值两次**时（`gate-actions.py`
的 `body` 在 escalate 与 abort 两个分支各赋一次），原实现取「最后一次赋值」⇒ 会把 abort 那一支的键集算到
`escalated` 头上（声明永远对不上实现）。现在按**调用点的行号取"该行之前最近的一次"赋值**。实测效果：只有
`approval/escalated` 的键集从**错的 18** 变成**真的 20**（`approval/aborted` 及其它事件一字不变）；
**偏差计数不因这处修正而变少**（它只让"声明了没写/写了没声明"两条真正归零）。

偏差表（P44 收口后，**13 条 → 3 条**）：

| # | 事件 | 偏差 | 处置 |
|---|---|---|---|
| ① | `approval/aborted` | 文档**未声明** body 键集 | **P42 已补**（18 键，含「同基底」继承）⇒ 归零 |
| ② | `approval/aborted`/`escalated` | 两个写者键集不同（`gate-actions.py` 8/9 键 / `Service._append` 12 键） | **留着**（事实不同：人的动作 vs 超时；写者不在可改面）—— §5.3 逐条写清 |
| ③ | `approval/granted`/`denied`/`reminded`/`escalated` | 文档未逐行声明 | **P44 已补**：逐行声明（12/12/12/20 键，按实现抄）⇒ 归零 |
| ④ | `approval/requested` | 写了没声明：`requested_by`/`submitted_at`/`summary`（来自**自己拼 body** 的写者） | **P44 已收口**：那两个写者改成调 `ApprovalService` ⇒ 这三个键不再产生，`approval/requested` 只由服务写（12 键）= 声明 ⇒ 归零 |
| ⑤ | `quote/submitted` | 多写者 3 种键集（声明侧另缺 13 键） | 声明**已补齐**（16 键）；形状差异留着（第三个写者不在可改面） |
| ⑥ | `quote/drafted` | 计数式声明，12 个键名未逐条声明 | **P44 已补**：逐条给 14 键 + 计数仍是 14 ⇒ 归零 |
| ⑦ | `evidence/retention-archived` | 只有散文式声明 | **P44 已补**：逐条给 3 键（写者 `src/system/retention/**` 不在可改面，声明侧照实现写）⇒ 归零 |
| ⑧ | `gate/nudged` / `rfq/promised` | **无偏差**（声明 5/6 键，实现逐字一致） | 复核通过（**非空转对照**：判据真的在比键集） |

机检当前读数：**3 条偏差**，全部是「多写者形状不同」，逐条理由见 §5.3；**没有任何一条**是
「声明了没写 / 写了没声明 / 计数不符」。原始输出：`tmp/p44-shots/audit-after.txt`（修前 = `audit-before.txt`）。
