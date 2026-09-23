# 审批的「批准 / 驳回」与三个新入口（授权区间 / 证据包 / 谈判）

<!-- 预算：16 KB。口径真源：`docs/design/29-webui-gui-app.md`（WebUI = 完整 GUI 应用）与 `AGENTS.md` 规则 11/12。 -->

本页讲**怎么用**与**判据在哪**：审批队列里怎么真批/真驳、`gate.queue` 的两处呈现缺陷怎么修的，
以及授权区间 / 证据包导出验证 / 谈判 / 用户空间自助面在 APP 内的入口。复跑见 §6。

## 0. 一句话

`system/approval` 的队列此前**只能催办/升级/委托/终止** —— 而"批准 / 驳回"是审批队列存在的唯一理由
（P15 走查登记的 P1 缺陷）。现在门卡片**行内**两键：**批准**（`approval/granted`）与**驳回**
（`approval/denied`，必留理由）。同时把三个此前只能在旧页/终端做的事搬进 APP：**授权区间**、
**证据包导出/验证**、**谈判**，以及业务侧看得见的**用户空间插件自助面**。

## 1. 批准 / 驳回（审批队列）

### 1.1 谁在落账（界面不写账本）

| 环节 | 是什么 | 在哪 |
|---|---|---|
| 界面 | 只把「这条门 + 我这个署名」落成 **0600 待办件** 并 spawn 写者 | `src/system/approval/code/ui.mjs`（`gate.grant` / `gate.deny`） |
| 唯一写者 | 复核待办件 + 全部业务判定 + 落账 | `src/system/approval/tools/gate-actions.py --step grant|deny` |
| 语义 | `ApprovalService.decide()`（**只有一份**） | `src/system/approval/code/approval.py` |
| 事件 | 既有事件，**不新增类型**：`approval/granted` / `approval/denied` | `docs/design/05-events.md` |

人签的**服务端门**在机制层（`POST ${prefix}/api/action/<id>` 对 `permission: 'human-signature'` 的动作）：
未登录 ⇒ `401 identity-required`；入参 `signature` ≠ 会话身份 ⇒ **`403 signer-mismatch`**，账本零新增。
**界面不代签、不写账本**（29 §3「唯一写者不变」）。

### 1.2 判定顺序（全部在写之前；任一不通过 ⇒ **账本零新增**）

| # | 判据 | 拒绝码 | 说明 |
|---|---|---|---|
| ① | 门真的**在本账本**里 | `gate-not-found` | 不猜、不凭 URL 拼一个门 id |
| ② | 该门**还没被决定** | `gate-already-decided` | 已 granted/denied/aborted 的门**不能重批**（也不许用催办/升级/终止绕过） |
| ③ | 署名的人**就是开单时点名的审批人** | `approver-not-named` | 审批权在开单那一刻已定（`approvers` 随 `approval/requested` 落账，ADR-0022）；旧门没点名审批人 ⇒ 按缺省放行（不凭空编一个审批人，也不把旧门锁死） |
| ④ | 驳回应留理由 | `reason-required`（界面层同时有 `validation-failed`/必填校验） | 理由**逐字**落 `approval/denied.comment` |
| ⑤ | 署名 / 侧别 | `human-required`；`cross-side-action` | 写者要 `human:` 前缀；**侧只认会话**（`view` 是请求体给的，动作总线上"侧"不许由请求体决定） |

### 1.3 幂等（两级，都要）

1. **同一份载荷**再点一次：待办件逐字节一致 ⇒ `already-applied`、**账本零新增**（写者比对归档件的重算哈希）。
   界面回执的 `code` 是 `already-applied`，`next_action` 明说"以「已决定的门」里读到的状态为准"。
2. **已决定的门**换一份新载荷再批 ⇒ `gate-already-decided`、**账本零新增**。

### 1.4 `gate.queue` 的两处呈现缺陷（P15 登记）

| 缺陷 | 修法 | 判据 |
|---|---|---|
| 行内动作字段名 `gate_id` ≠ 行键 `id`/`approval_id` ⇒ 从行里点动作要**手抄门 id** | 行对象里补 `gate_id`（与 `id`/`approval_id` 恒等）；动作的入参字段仍叫 `gate_id` | 行内点「批准」时表单里的「门 id」**已填好**（截图 `tmp/p16-shots/p16-01-*.png`；机检见 §6 ①④-a） |
| 降级原因**第一行是机器码**（外站外壳原样渲染 `reason`） | 面板的 `reason` 写**人话**，机器码放括号里（如「这一侧现在没有待批的门（机器码 `no-pending-gate`；已决定 1602 条…）」） | §6 的 ④-b：样本面板的 `reason` **首字符必须是汉字**（裸机器码会被判红） |

**新增面板**：`gate.decided` / `gate.decided.supplier` —— 已决定的门**留痕可回读**（谁在何时、什么意见），
批完不必去翻账本 JSONL。列里的 `决定时刻` 是账本行的 `ts`，`意见` 逐字来自 `comment`。

### 1.5 批量人签（**一次署名 → 逐份/逐条落账**）

现实里一天几十份草稿、队列里十几条门，逐个点一次是磨人的。所以**多选**之后一次署名办一整批 —— 但
**落账仍是一份（条）一次**，没有任何"一个动作落多条"的旁路：

| 面板 | 批量动作 | 每一条落什么 | 写者（**逐条各跑一次**） |
|---|---|---|---|
| 「我的草稿（待签署）」（供应商道） | `quote.submit-batch` | 每份各落 `approval/requested` → `approval/granted` → `quote/submitted`（+ 承包商侧一条登记） | `src/domain/quote-prepare/tools/quote-sign.py`（`--draft-id` 一次一个） |
| 「审批队列」（两侧） | `gate.decide-batch`（`grant` / `deny`） | 每条门各落 `approval/granted` 或 `approval/denied` | `src/system/approval/tools/gate-actions.py --step grant|deny`（`--request` 一次一件） |

判据与单条动作**同一条**，一条没松：署名仍**一次**且人签门在动作总线上原样生效（未登录 401 /
署名 ≠ 会话身份 403 / `agent:*` 拒）；每条**各自判定**（写者自己判：`draft-not-found` / `gate-not-found` /
`gate-already-decided` / `approver-not-named`）⇒ **一条被拒不影响其余条**。回执**逐条如实**放在
`result.results[]`（`{where: applied|duplicates|refused, code, ledger_added, reason, next_action}`），
汇总句形如「5 份：已签 2 份 · 已经签过（幂等）3 份 · 被拒 0 份（本次账本 +8 行）—— <逐条>」——
**不是**"全成/全败"的二选一；有落账就不是失败（`ok=true`，部分被拒时 `code=batch-partial`）。
**幂等**：同一批原样重签 ⇒ `already-signed` / `already-applied`（写者按归档摘要逐字节比对）⇒ 账本零新增。
一次最多 50 条（`batch-too-large` 具名拒绝）；批量驳回必须留理由（`empty-reason`）。
复跑：`python3 tmp/p18-shots/verify.py`（A 报价批 / B 门批 / C 负控 / D 幂等，四组全绿）。
**规模 + 并发 + 真手机宽度（390px）下的实测、缺陷与已做的文案修**：见
`src/system/webui/docs/scale-batch-and-narrow-screen.md`（含 50 上限 × 跨页全选、
40+3 逐条回执、并发冻结读数、勾选不跨页、390px 全流程逐步截图清单）。

### 1.6 变更单的**逐行明细页**入口（GUI 侧，DEF-037）

旧的变更单列表长在已退役的 `/gates/` 页上，那页每行有 `data-change-detail-link` → `/<view>/changes/<id>/`；
页退役后 GUI 的变更列表**没有**指向明细页的链接（明细页与 `change-detail` 门都还在、真跑）。
现在两侧各补一个 `html` 面板给出每条的入口（`change.detail-links` / `exchange.change-detail-links`），
href 就是那页真地址（逐行 原量×原价 → 新量×新价、行差额与小计，**整数分**、half-up 到分位）；
列表行内的「打开 →」（`ref.kind='change'`）仍指向**对象页**（逐行差异 + 批准判定）。两者互补。

## 2. 授权区间（谁能批到多少 / 越界找谁）

- **面板** `authority.bands` / `authority.bands.supplier`（两侧）：登记的角色 + 限额（**整数分**）+
  配置键 + 「这一行到底什么意思」；**每个行内两个动作**。
- **动作**：
  - `authority.check`（只读，账本零新增）：填 `role` + `amount`（整数分）⇒ 结论
    「在区间内 / **越界多少** / 未配置」+ `required_role`（最低权限者）+ `next_role`（下一个能批的人）；
  - `authority.escalate`（人签）：越界时**一键把这件事提成人工门**（`approval/requested`，
    scope = `authority.escalate`），再把门交给点名的人 —— 门开出来后去「审批队列」**批准/驳回**它。
- **口径来自哪里**：`authority-band` 插件自己的确定性规则（`checkOf`，只读配置快照，**不读账本、
  不取墙钟、不能批准**）；配置快照读**受管 YAML** 的 `authority.*` 行（`QUOTAGENT_UI_CONFIG` →
  缺省 `/workspace/config.yaml`；`authority.*` 之外的键**读都不读**）。
- **未配置 = 一律走人工门，绝不等于"额度无限"**；`null`（未配置）与 `0`（人明确登记"一分也不能批"）是两件事。
- **本插件不能批准**：`can_approve=false` 一字未改 —— 改判定的**只有**审批队列里的批准/驳回。
- **旧 SSR 页不再是唯一去处**：`gate.escalate` 的字段帮助已改指向本面板（旧页仍活着，见 §5）。

## 3. 证据包：导出与验证

- **面板** `evidence.surface` / `.supplier`：本侧账本的**导出留痕**（`evidence/pack-exported`：谁在何时
  导了哪一段、`pack_hash`、Merkle 根）+ 行内「验证一个包」。
- **动作**：
  - `evidence.export`（人签）：`from_seq` / `to_seq`（**0 = 到当时最后一行**）/ `scope` ⇒
    唯一写者 `src/system/evidence/tools/evidence-pack-export.py`：只读账本切片 → 落 **0600** 包文件
    （`<ui_shared>/evidence-packs/<包 id>.json`）→ 账本追加**一条既有事件** `evidence/pack-exported`。
    冻结的账本**拒绝**导出对外证据；切片超 20000 行**如实拒**（不截半份台账）。
  - `evidence.verify`（只读）：`evidence-pack-verify.py` 逐项给 pass/fail（哈希链 / Merkle 根 /
    leafs / 清单计数与边界 / `manifest_hash` / `pack_hash` / 签名**存在性**），失败指出**第一处**。
- **对象页 / 深链**：`/app/<view>/evidence-pack/<包 id>/` 把**逐项验证结果**摊成一页（可分享）；
  改过的包在那一页里显示"验证没通过 + 是哪一项"。未提供密钥时**不把"有签名"当"签名通过"**（既有语义）。
- **幂等**：同一份载荷再点 ⇒ `already-applied`、**包与账本都零新增**。

## 4. 谈判（线程 / 轮次 / 让步门）

- **面板** `negotiate.threads` / `.supplier`：线程卡片 —— 挂的包与条目、对手方、状态、
  **已用轮次 / 还剩几轮**、**让步边界**（底线 floor / 上沿 ceiling / 单次上限 %）、最近一轮、上一轮被拒的原话。
  底线/上沿按 `negotiate/bounds-declared` 的 `cost_baseline`/`min_margin_pct`/`band` **复算**（与服务的
  `_bounds_from_declaration` 同一公式；账本 body 不带这两个派生值），复算只用于展示，判定永远在服务里。
- **面板** `negotiate.rounds` / `.supplier`：轮次时间轴 —— 逐轮 `from → to`、Δ%、是否在授权区间内、
  过的人工门、以及**被拒轮次的原话**（`negotiate/round-rejected` 的 `code`/`reason`/`next_action`）。
  **被拒的尝试也占轮次号**（契约 §1），所以"还剩几轮"按尝试数算。
- **动作**（写者 = `src/domain/negotiation/tools/negotiate-actions.py`，语义仍在 `NegotiationService`）：
  1. `negotiate.request-concession`（人签）：为一轮**请求人工批准** ⇒ `approval/requested`
     （scope 恰 `negotiate.price-concession`，ref 恰 `<线程>:a<第几次>`）；
  2. 去**审批队列**由点名的审批人**批准**（就是 §1 那两键）；
  3. `negotiate.round`（人签）：提交这一轮（带上那一次的 `approval_id`）⇒ `negotiate/round`；
     判定链（维度 → 轮次上限 → 让步幅度 → 底线 → 区间 → 人工门）在服务里跑，越界**不落 round**
     而是落 `negotiate/round-rejected` 留痕 + 具名拒（`concession-over-limit` / `concession-below-floor` /
     `concession-out-of-band` / `round-limit-exceeded` / `approval-required` …）；
  4. `negotiate.close`（人签）：关闭线程 ⇒ `negotiate/closed`（**不产生义务**：无承诺、无 PO、无对外报价）。
- **不读墙钟**：写者给 `--now`（服务的 `write_ts` 覆盖落账时刻；不给时逐字节与改前一致）。

## 5. 用户空间插件自助面（业务侧看得见）

- **面板** `userspace.mine` / `.supplier`：**你的命名空间**（`user-space/<名字>` 存在就是它，否则
  `u-<名字>`，与身份面同一条判据）、用户空间里的命名空间与插件、**装没装**（判据 = **注册面里有没有
  它的贡献**，不另记状态），以及**只对自己命名空间**开放的「装载 / 卸载」按钮（表单打到既有路由
  `${prefix}/plugins/{load,unload}`，判据仍在服务端：跨命名空间 ⇒ `not-my-namespace`）。
- **它不新造写面**：面板只读目录 + 问注册面；装卸走既有路由与既有管理面，卸载后自建视图一起消失（规则 1）。

## 6. 复跑（真跑 + 截图）

```bash
python3 tmp/p16-shots/p16-reset.py          # 夹具复位（p15-run 副本 + 真谈判线程）
sh tmp/p16-shots/p16-boot.sh boot 8470      # 起走查服务（夹具配置 tmp/p16-shots/p16-fixture-config.yaml）
python3 tmp/p16-shots/p16-verify.py         # 27 条断言：①批准/驳回 ②负控 ③三个入口 ④字段名与降级文案
python3 tmp/p16-shots/direct-writer.py tmp/p16-run       # 写者直测（含 agent 代签、越权、幂等）
python3 tmp/p16-shots/direct-evidence.py tmp/p16-run     # 证据包导出/验证直测（含改包负控）
python3 tmp/p16-shots/direct-negotiation.py tmp/p16-run  # 谈判三步直测（含越限负控）
sh tmp/p16-shots/p16-boot.sh stop 8470
```

机器可读：`tmp/p16-shots/p16-verify.json`；人话报告：`tmp/p16-shots/p16-verify.txt`；
截图：`tmp/p16-shots/p16-*.png`（队列行内两键 / 预填表单 / 回执 / 已决定回读 / 授权区间 / 越界开门 /
证据面 / 包对象页逐项验证 / 谈判线程与轮次 / 用户空间自助面 / 降级人话）。

## 7. 已知遗留（**不在本批可改面内**，如实登记，不假装修完）

1. **其余插件的降级原因仍是裸机器码**：`calendar-not-set`（capacity）、`no-query`/`no-ticket`（rfq）、
   `no-lost-notice`（clarify）等**仍由各插件自己的 `ui.mjs` 给出** —— 它们的文件不在本批可改面内；
   §1.4 的口径（人话第一行 + 机器码在括号）已在**本批新增/修改的面板**里落地，其余按同一口径逐步替换。
2. **`config-view` 的文件层按点分扁平键取值**（`hasOwnProperty(fileLayer, 'authority.bands.buyer')`），
   而 `./run config init` 与 `tools/config-apply.py` 渲染的是**嵌套** YAML ⇒ 它的"source"列对嵌套写的
   文件键会显示成 `default`。本批的授权区间面板**在自己的 `ui.mjs` 里先 `flattenDoc`（同一个模块导出的
   同一个函数）再交给 `projectView`**，所以两种写法都读得到；`src/system/config/**` 不在本批可改面内，
   没有动它。
3. **落账时刻**：界面动作走 `host.now()`（外壳机制给的时间），与既有各动作同一口径；写者本身**不读墙钟**
   （`--now` 必填）。
4. **旧 SSR 页仍然活着**（`/<view>/authority/`、`/<view>/gates/` 等）：APP 内现在有等价入口（本页 §2–§4），
   旧页的退役与"教用户回终端"文案的清理属于外壳文件（`code/webui.mjs`），不在本批可改面内。
