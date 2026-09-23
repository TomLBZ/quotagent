# EV-194 · P46：三处遗留收尾（请求人 / 计数器根因 / 预算与索引）+ 两支审计尺子进仓

<!-- budget: 8 KB（`docs/work/evidence/*.md`）。原始输出全在 `tmp/p46-shots/`：`counter-probe{.py,.txt}`、
     `identity-requested-by-{check.py,result.txt,result.json}`（三个夹具的服务日志 `service-{A,B,C}.log`）、
     `claim-audit-*.{json,stderr}`、`body-keys-audit.txt`、`gates.txt`、`ws/`（夹具账本）。 -->

判据真源：`AGENTS.md` 规则 11/12、`docs/design/29-webui-gui-app.md`（本批新增 §24）、`docs/design/05-events.md`。
范围：`src/system/webui/code/identity.mjs`（一行）、`src/system/approval/code/approval.py`（根因）、
`src/system/repo-gate/tools/**`（两支尺子）、`docs/work/{handover*,progress-checklist*,evidence/**}`、`docs/design/29*`。
**不新建门/测试、不改 `host/**` 与 `tools/verify.sh`、不动账本/事件类型集。**

## 0 结论

1. **待办卡/门对象页的「请求人」修好**：`body.requested_by ?? row.actor` —— 新口径行显示**真身份**，旧行照账本、不编人名。
   端到端（真起服务 + 真登录 + 真读接口）三个夹具全过（§1）。
2. **计数器根因修好**：`ApprovalService.__init__` 的 `_counter = 0` 挪到 `replay()` **之前**（顺序反了会抹掉重放算出的
   最大序号 ⇒ 每进程从 `ap-0001` 起 ⇒ **重号**）。同账本正/反两边实测：修后 `ap-0275`、旧顺序 `ap-0001`（重号复现）。
3. **两支审计尺子进仓**（`src/system/repo-gate/tools/`）：事件 body 键集 + 承诺↔实现；任意 cwd 可跑；
   **什么时候跑 / 怎么读 / 偏差怎么处置**写在 29 **§24**（主文件）+ 归档 §24（读数）。
4. **预算与索引**：`handover.md` 仍 ≤1024 B（细节入归档 §2）、`progress-checklist.md` 补 T-332/T-333（腾字节 =
   T-318/T-319 整行搬入归档）、证据索引**补齐 EV-190/191/192**（此前从未登记）+ EV-193 行同步 + 新增 EV-194 行。

## 1 `identity.mjs` 待办卡「请求人」（一行）

- 改动（**逐行列清**：只这一处的值变了）：`src/system/webui/code/identity.mjs:408`
  `detail.requested_by: body.requested_by ?? null` ⇒ `body.requested_by ?? row.actor ?? null`。
- 为什么：P44 起 `ApprovalService._append` 拼的 body **不再带** `requested_by`（服务口径 12 键），请求人只在
  **那一行的 `actor`** 里 ⇒ 旧写法对新门恒为 `null`（P45 遗留）。与门对象页**同一口径**（`commitments/code/ui.mjs`
  的 `gate.object-<view>` 面板用 `firstBody.requested_by || first.actor`）—— 本行只是把待办卡那半边补齐。
- 端到端读数（夹具 = **真账本行的逐字节副本**，不编造任何字段；命令见 §5）：

| 夹具 | 真账本来源 | 行形状 | 界面「请求人」 | 修前会是 |
|---|---|---|---|---|
| A | `tmp/p42-run/contractor/ledger.jsonl` | 新门（服务口径，body 无 `requested_by`），`actor=human:wanglei` | `human:wanglei` | `null` |
| B | `tmp/p27-shots/run/supplier/ledger.jsonl`（去掉目标门配对的 `approval/granted` 行以造出 pending） | 旧口径行（自拼 body，含 `requested_by`） | `human:p21-supplier` | 同左（未变） |
| C | `tmp/p10-run/contractor/ledger.jsonl` | 旧服务行（body 无 `requested_by`），`actor=agent:approval` | `agent:approval`（**照账本**） | `null` |

  门对象页与待办卡**逐条同值**（A `ap-0002` / B `ap-3647` / C `ap-pending-0001`）；C 的 400 扇同形，逐条在
  `identity-requested-by-result.json`。**未登记派分口径的门不进列表**（A 的 `ap-0007`（`authority.escalate`）
  仍不出现 —— 前端不猜该谁批）。

## 2 服务侧计数器根因（`src/system/approval/code/approval.py`）

- 改动：`self._counter = 0` 从 `replay()` **之后**挪到**之前**（无账本时保持 0；`replay()` 算最大序号那一步
  是既有语义，一行未改）。上一批只能在 4 个写者各留 `bump_counter()` 兜底（当时服务在不可改面），本批修根因。
- 正/反两边（`tmp/p46-shots/counter-probe.txt`；账本已用门号 `ap-0001/0007/0091/0274`）：修后 `replay` 后
  `_counter=274` ⇒ 新门 **`ap-0275`**；换回旧顺序（`replay` 后再置 0）⇒ 新门 **`ap-0001`** = 与账本里已存在的门
  **重号**（同账本重复号数 1）；新行 `requested_by` 实测 = 传进来的 `actor`。
- 兜底现状（**未改**，属本批不可改面）：`commitment-apply.py`/`change-apply.py`/`quote-review.py`/`gate-actions.py`
  各有幂等的 `bump_counter()`，`quote-sign.py` 显式推门号；本批后它们成**冗余兜底**，注释里「服务在不可改面」
  已过时 ⇒ 下一批连注释一起收口（§6）。

## 3 两支尺子进仓

| 尺子 | 位置 | 判据 | 本批读数（任意 cwd） |
|---|---|---|---|
| 事件 body 键集 | `src/system/repo-gate/tools/body-keys-audit.py` | `05-events.md` 声明 ↔ 落账 `body` 键集（`ast` 找写者） | **rc=1，偏差 3**（全是「多写者形状不同」：`approval/aborted`、`approval/escalated`、`quote/submitted`；另一半写者不在可改面，见 `decided-gates-and-abort-reason.md` §5.3） |
| 承诺↔实现 | `src/system/repo-gate/tools/claim-impl-audit.py` | probe 全命中 ⇒ 承接；任一未命中 ⇒ 缺口（**不写成已实现**）；显式 `drift` ⇒ 漂移（带证据） | **rc=0，158 条 = 承接 153 / 缺口 0 / 漂移 5**（P46 补 `C158` = §24 的登记本身），清单写回 `EV-193-claim-matrix.tsv` |

- 承诺真源搬进仓内固定位置 `docs/work/evidence/EV-193-claims.json`（此前脚本与真源都在会被清掉的 `tmp/p45-shots/`）；
  `runner_source`（脚本源码副本）**删除** —— 脚本已进仓，留副本就是会漂的第二份。
- **两者都不是门**（`tools/verify.sh` 无对应分支）：本批没有新建门；何时跑/怎么读/偏差处置 = 29 §24。

## 4 文档腾字节与索引补齐

- `handover.md`：重写为当前状态（P44/P45/P46 之后）且 ≤1024 B；细节搬 `handover-archive.md` **§2**（主文件的每个
  `§N` 指针在归档里有非空小节 —— `docs` 门的交接集合断言照旧）。
- `progress-checklist.md`：补 **T-332**（P44/P45 写者面收口 + 29 对账，`EV-193`）与 **T-333**（本批，`EV-194`）；
  腾字节 = `T-318`/`T-319` 整行逐字搬入 `progress-checklist-archive.md`（追加在文末，与既有各批同口径）。
- `INDEX-P2-c.md`：补齐 **EV-190/191/192** 三行 + `EV-193` 行同步 P46 读数 + 新增 `EV-194` 行。
- `29` 主文件/归档：新增 §24；腾字节靠删重复/叙述（能力叙述压缩、删 §12 重复的「真源」句等），**判据与禁止一条未删**。

## 5 复跑命令与门 rc

```bash
python3 tmp/p46-shots/counter-probe.py                    # 计数器正/反两边（rc=0）
python3 tmp/p46-shots/identity-requested-by-check.py      # 三夹具：真起服务 + 真登录 + 真读接口（rc=0）
python3 src/system/repo-gate/tools/body-keys-audit.py     # rc=1 = 3 条多写者形状不同
python3 src/system/repo-gate/tools/claim-impl-audit.py    # rc=0 = 158 条、缺口 0
tools/run.sh tools/check-docs.py                          # 预算/ID/引用
tools/verify.sh docs|webui|plugin-assets|events|gates      # 逐门 rc = tmp/p46-shots/gates.txt
```

## 6 未覆盖 / 风险

- 四处 `bump_counter()`（`src/domain/**/tools/**`，不可改面）现为冗余兜底且注释过时 —— 下一批收口（只改注释与调用点）。
- 两支尺子都是**静态口径**：body 键集尺子用 `ast` 解析写者形状、承诺尺子命中「实现位置」，都不起服务、不开浏览器。
- 夹具 B 为造出 pending **未纳入**配对的 `approval/granted` 行（原账本里该门已被批准）；行本身逐字节未改，没有编造字段。
- `tmp/**` 是临时区：本页引用的脚本/读数会被清理轮次删掉；进仓的两支尺子不受影响。
