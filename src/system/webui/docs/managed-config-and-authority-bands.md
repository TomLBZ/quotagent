# 受管配置路径**真下传**到插件 + 授权区间变更的**人工门 + 另一人复核**（P49 → P50）

<!-- 预算：16 KB（`docs/design/12-documentation-standard.md` §1 的 `src/*/*/docs/*.md` 行）。
     口径真源：`docs/design/29-webui-gui-app.md` §7（配置/凭据的界面入口）与 §15（人门必须被真正消费）；
     ADR：`docs/design/adr/0025-authority-band-change-needs-second-approver.md`。
     本页讲三件事的**机制、判据与真跑读数**：① 受管 YAML 的路径怎么从 `./run` 一路到插件手里；
     ② 「谁能批到多少」怎么在界面里改（人工门 + **另一人**复核，不得自提自批）；
     ③ 写路径仍是既有唯一落盘者。修前/修后读数与截图在 `tmp/p50-shots/`。 -->

## 0. 一句话

P49 修好了两件事的一半：路径只通了「宿主 → 插件」（`./run up --config-file X` **没下传**，CLI 传参断在
服务进程那一节），登记入口是**自助**的（请求人与批准人同一人）。
P50 把它们收口：**① `./run --config-file` 全链下传**（run → 服务进程 → `host/cli.mjs` → 插件；
面板显示、`host.config.config_file`、`authority.bands.*` 生效**三处一致**）；
**② 授权区间变更 = 人工门 + 另一人复核**（`scope=config.authority` 的门由**提交人之外**的人批准，
判据与承诺/发 PO 的「人门」**同一处实现**；自签自批只能由**默认关闭**的运营开关打开，且界面如实写）。

## 1. 受管配置路径的取值链（机制）

**传参链**（P50 补的是前两节，后三节 P49 已有）：

| # | 环节 | 机制 |
|---|---|---|
| 1 | `./run up --config-file X` | `do_up` 把 X 放进**服务进程环境** `QUOTAGENT_UI_CONFIG`（**没给这个旗标 ⇒ 一个字节都不设**，缺省链一字未改；`QUOTAGENT_CONFIG_FILE` 故意不采纳 —— config-view 不认它） |
| 2 | `src/system/webui/tools/webui-serve.py` | 非空时给 `host/cli.mjs` 显式加 `--config-file X`（服务是 Python 包装 + `execve`，argv 与环境都从这一处定） |
| 3 | `host/cli.mjs` | 把 `--config-file` 交给外壳插件 `Config.config_file`（**只搬运**，不解释路径）；配置面 `config-view` 读的是同一个值 |
| 4 | `src/system/webui/code/webui.mjs#resolveManagedConfigFile` | 取值链：宿主显式给 → **配置面**（唯一落盘者的入口）→ 本进程参数 → `QUOTAGENT_UI_CONFIG` → 缺省 `<缺省路径>`；结果**两处落地**：`host.config.config_file`（插件读）与进程级只读事实 `globalThis.__QUOTAGENT_MANAGED_CONFIG_FILE` |
| 5 | 插件（`domain/authority-band` 等） | 面板/动作按 `host.config.config_file` 读同一份文件，并**把实际读的路径写在界面上**（`hint` + 机读 `readout`） |

> **为什么必须有"进程级"那一层**（P49 实测的真因）：装载面按 `<file>?v=<mtime>` import 插件代码
> （`app-shell.mjs#moduleVersionOf`），而 `domain/authority-band/code/ui.mjs` 里的 `authoritySnapshot()`
> 也被 `system/approval/code/ui.mjs` **import**（审批队列的「越界？」列）⇒ 两边是**两个模块实例**，
> 模块级变量不共享。进程级事实让两处读同一份文件（实测：面板 `buyer=500000`、队列同一笔钱「未配置」⇒ 修后同结论）。

## 2. 授权区间变更：**人工门 + 另一人复核**（`authority.bands.set` / `authority.bands.apply`）

| 环节 | 谁做 | 判据/读数 |
|---|---|---|
| ① 提交 `authority.bands.set` | 提交人（人签，`permission: human-signature`） | 身份门（署名 == 会话身份）→ 白名单（只收 `authority.bands.<角色>`，角色必须在唯一登记表里）→ 类型（`integer`）→ **点名另一个复核人**（本侧名册里除自己以外的人）→ 落 `approval/requested`（`scope=config.authority`、`ref=authority-band:<request_id>`）+ **0600 暂存件**（`<ui-shared>/authority-bands/pending/<request_id>.json`）。**受管配置一个字节都不改**（暂存件**不进** config 收件箱 ⇒ 唯一落盘者扫不到"还没人批"的件） |
| ② 复核 `gate.grant` / `gate.deny` | **另一个人**（在「审批队列」里） | 队列逐行写「待批的区间变更：把 采购员（buyer）的限额改成 N 分」「谁提交的（批的人必须不是他）」（读那份 0600 暂存件，读不到就如实说读不到）；批准落 `approval/granted`（既有事件、既有写者 `gate-actions.py`），**决定人 == 署名的那个人** |
| ③ 落盘 `authority.bands.apply` | 任何人（人签） | **唯一判据** `ApprovalService.signoff/select_signoff`（`signoff_verdict` ①–⑤，与承诺/发 PO **同一处实现**）：引用对得上 / 已 granted / 批的人是人 / **批的人 ≠ 提交的人** / 批的人是开单时点名的那位。通过 → 0600 待办件 → **唯一落盘者** `src/system/config/tools/config-apply.py` 原子写 + 回读校验 + 失败回滚（只重写受管三段，非受管段逐字节保留），回执给受管文件 sha256 前后 |
| 放行开关 | 运营侧文件（**界面没有**） | `<ui-shared>/authority-bands/policy.json` 的 `{"allow_self_approval": true}`：**默认关闭**（不存在 = 关）；坏形状 ⇒ `policy-malformed`（**不当作关闭**）。开着时 ③ 回执**如实写**「批准人 == 提交人（自签自批：显式开关已开）」 |

**具名拒**（全部**账本零新增、文件零改动**）：`self-approval-not-allowed`（只点名自己）、
`no-other-approver`（没点名且本侧名册里没有第二个人）、`approval-required` / `approval-not-granted` /
`approval-denied` / `approval-aborted` / `approver-must-differ` / `approver-not-named` /
`approver-not-human`（都来自 `signoff_verdict`，写者与界面照抄同一串词）、`already-applied`（幂等）、
`staged-tampered`（暂存件与这次字段/摘要对不上）、`policy-malformed`。

## 3. 真跑读数（同一份受管 YAML 与数据根；`./run up --config-file …` 起的服务）

**① 三处一致**（`./run up --port 8605 --config-file <仓库根>/tmp/p50-run/managed-config.yaml …`；下表取自走查最终态，
`buyer` 的值在那一路走查里先改成 220000 再改成 210000，两次都以"另一人复核"为前提）：

| 读数 | 值 |
|---|---|
| 界面（面板 `hint` 原文） | `本面板读的受管配置 = <仓库根>/tmp/p50-run/managed-config.yaml` |
| `host.config.config_file`（面板机读 `readout.host_config_file`） | `<仓库根>/tmp/p50-run/managed-config.yaml` |
| 进程级事实 / env / 最终生效（同一次读） | 三者与上面**同值**（`readout` 逐字段） |
| `authority.bands.*` 生效 | 面板行 `采购员（buyer） 210000`／`主管（lead） 9000000`；`authority.check(300000)` ⇒ `越界 90000 分`（`next_role=lead`）、`check(420000)` ⇒ `越界 210000 分` —— **与受管 YAML 里的数字逐条对得上** |
| **不带** `--config-file` 起（另一端口） | `readout` = `host_config_file=/workspace/config.yaml`、`env=''`、生效 `/workspace/config.yaml` ⇒ **缺省链一字未改** |
| 真 `<缺省路径>` 的 sha256 | 全程 `6cf43d027a612244…`（**逐字节未动**） |

**② 人工门 + 另一人复核**（提交人 `human:limin`、复核人 `human:liwei`；读数原文见 `tmp/p50-shots/p50-bands-log.jsonl`）：

| 步 | 动作 | 读数 |
|---|---|---|
| 1 | 提交人**点名自己**提交 | 拒 `self-approval-not-allowed`：「授权区间变更要**另一个人**复核，自提自批不算人工门」；账本零新增 |
| 2 | 提交人提交给 `human:liwei`（250000 分） | `band-change-submitted`；门 `ap-7489`；**账本 +1 行**；受管 YAML **未改**（sha 仍 `4bd7ea91…`） |
| 3 | 还没批就落盘 | 拒 `approval-not-granted`：「门 ap-7489 还在等（卡在 human:liwei）」；账本零新增 |
| 4 | 复核人看队列 | 行原文：`待批的区间变更：把 采购员（buyer）的限额改成 250000 分（= 2500.00 元）`｜`谁提交的 human:limin`｜`批的人必须不是提交人 human:limin` |
| 5 | 复核人批准（`gate.grant`） | `approval/granted`，决定人 `human:liwei`；账本 +1；再点一次 ⇒ `gate-already-decided`（零新增） |
| 6 | 提交人落盘（`authority.bands.apply`） | `band-change-applied`：受管文件 sha256 `4bd7ea91… → d6b81788…`；`谁批的 human:liwei ≠ 谁提交的 human:limin`；待办件 0600、消费后移入 `applied/` |
| 7 | 幂等：再点一次 | `already-applied`（账本零新增） |
| 8 | 生效核对 | `authority.check(300000)` ⇒ `越界 80000 分`（300000-220000，`next_role=lead`）|
| 9 | 开关坏形状 | `policy-malformed`（**不当作关闭**）；零落盘 |
| 10 | 开关打开（0600 显式写 `{"allow_self_approval": true}`） | 自签自批**被允许**，且回执 `self_approved: true`、`self_approval_note` 明写「⚠ 自签自批：运营侧显式开关已开」；落盘后 sha `d6b81788… → 6d23c964…` |
| 11 | 删掉开关（默认关闭） | 再提交同样被拒 `self-approval-not-allowed` |

截图：`11`~`15` 是 P49 的（路径下传与界内入口）；P50 新增 `16-authority-panel.png`（面板说它读哪一份）、
`17-band-submit-form.png`（① 的字段：角色 / 新限额 / **点名给谁复核** / 署名）、`18-queue-band-change.png`
（队列里那条待批的区间变更 + 「谁提交的」两列）。

## 4. 仍做不到 / 边界（如实登记）

1. **复核人候选来自名册**：本侧名册里没有第二个人时，① 会具名拒 `no-other-approver` 并让你"先让同事
   登录一次（登录即登记）或去「人员名册与角色」加人"。**沙盘例外**：沙盘会给同期演示造一份**临时名册**
   （第二个演示身份 `demo-approver`，见 `sandbox-and-demo.md` §6），所以演示里这条路走得通。
2. **门号仍是确定性派生**（同一份提交 ⇒ 同一个 `ap-NNNN`，`--approval-ref` 可对账）；审批队列里的门
   **超时不会自动批准**（`timeout_policy` 只有 remind/escalate/abort，ADR-0022 一字未改）。
3. **供应商侧不能改**：两个动作只注册在承包商道（改限额不是投标方的事）；供应商侧的同一块面板是**看**的
   那一面（`authority.check` / `authority.escalate` 照旧两侧都有）。
4. **本插件仍不能批准任何事**：它只提交变更与消费别人的批准；改判定的那一签永远在「审批队列」里由人签。

## 5 角色下拉送**机读值**、屏幕显示人话（P52）

P51 实测：两个动作的 `role` select 的 `option.value` 是**人话标签整个字符串**（
`Array.from(s.options).map(o => [o.value, o.text])` = `[["采购员（buyer）","采购员（buyer）"], …]`）——
写者两种写法都认，所以功能没坏；但请求体里出现的是给人看的字符串，**按码判定的脚本/运维会猜错**
（同一个字段在机读面应该是 `buyer`）。

修法（两处，都不碰判据）：
① 机制层（`src/system/webui/code/ui-surface.mjs#optionList` + `code/assets/app.js#fieldHtml`）：`select` 的
`options` 现在接受 `{value, label}` —— **value 是机读值、label 是人话**，界面渲染
`<option value="buyer">采购员（buyer）</option>`；字符串写法照旧（值 == 显示）。
② 本插件：`roleOptions()` 改成 `[{value:'buyer', label:'采购员（buyer）'}, …]`（`roleIdOf` 三种写法
——id / 人话 / 人话（id）——**照旧都认**，既有调用方、门、脚本一个字节不用改）。

**读数（P52 真跑）**：`authority.bands.set` 表单里下拉送出的 `role` = `buyer`（修前 = `采购员（buyer）`）；
同一条提交（`buyer` → 250000 分）走完「提交 → 另一人复核 → 落盘」，与修前逐字一致（回执、账本行、
受管 YAML sha 都对得上）。原始读数见 `tmp/p52-shots/REPORT.md`。
