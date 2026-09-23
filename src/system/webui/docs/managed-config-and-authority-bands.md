# 受管配置路径**真下传**到插件 + 授权区间的**界内登记入口**（P49）

<!-- 预算：16 KB（`docs/design/12-documentation-standard.md` §1 的 `src/*/*/docs/*.md` 行）。
     口径真源：`docs/design/29-webui-gui-app.md` §7（配置/凭据的界面入口）与 §23（入口策略）。
     本页讲两件事的**机制、判据与真跑读数**：① 受管 YAML 的路径怎么到插件手里；② 「谁能批到多少」
     怎么在界面里登记（写路径仍是既有唯一落盘者）。修前/修后读数与截图在 `tmp/p49-shots/`。 -->

## 0. 一句话

修前：主管在界面上答不出「**这笔钱越没越界**」—— ①「授权区间」面板读的是**缺省路径** `/workspace/config.yaml`
（而服务是用 `--config-file` 起的、真受管配置是别的一份），②就算读对了，界面上也**只有看、没有登记**。
现在：受管配置路径由外壳解析一次、**同时**交给每个插件（`host.config.config_file`）与进程级只读事实；
「授权区间」多了一个**界内登记动作**（人签 → 人工门事实 → 0600 待办件 → 唯一落盘者落 YAML），
登记完「面板」「审批队列的越界列」「`authority.check`」三处**下一次读**就按同一份文件算。

## 1. 受管配置路径的取值链（机制，`webui.mjs#resolveManagedConfigFile`）

按顺序取**第一个非空**的值（返回的一定是一个路径字符串）：

1. 宿主显式给 webui 模块的那一份（`Config.config_file`；`host/cli.mjs` 目前不传 ⇒ 通常为空）；
2. **配置面**读的那一份（`configView.stats().config_file`）—— 它是**唯一落盘者**
   （`src/system/config/tools/config-apply.py`）的入口，"写哪儿"以它为准；`host/cli.mjs` 的
   `--config-file` / `QUOTAGENT_UI_CONFIG` 先到它那里；
3. 本进程参数 `--config-file`（`host/cli.mjs webui --config-file …`：与 ② 同一份，② 缺席时的兜底）；
4. 环境 `QUOTAGENT_UI_CONFIG`；5. 缺省 `/workspace/config.yaml`。

**只有一个真源**（②优先于③④）：否则界面会"读一份、写另一份"，那正是修前的缺陷形态。
解析结果两处落地：`host.config.config_file`（插件面板/动作读它）与**进程级只读事实**
`globalThis.__QUOTAGENT_MANAGED_CONFIG_FILE`（`MANAGED_CONFIG_GLOBAL_KEY`，`apply` 的 disposer 会删掉它）。

> **为什么必须有"进程级"这一层**（P49 实测的真因）：装载面按 `<file>?v=<mtime>` import 插件代码
> （`app-shell.mjs#moduleVersionOf`），而 `domain/authority-band/code/ui.mjs` 里的 `authoritySnapshot()`
> 也被 `system/approval/code/ui.mjs` **import**（审批队列的「越界？」列）⇒ 两边是**两个模块实例**，
> 模块级变量不共享：队列那一份拿到空路径 ⇒ 退回 `/workspace/config.yaml`。实测：面板显示
> `buyer=500000`，队列同一笔钱仍写「未配置」。进程级事实让两处读同一份文件。

**界面必须把"实际读的那一份"写出来**（两种状态都要看得见）：降级时写在面板的 `reason` 里
（「本页读的受管配置：<路径>」）；**登记好之后**（不再是降级态）写在面板 `hint`（界面上那句
"这块怎么用"）里 —— 终局 DOM 原文：`本面板读的受管配置 = <仓库根>/tmp/p49-run/managed-config.yaml`。

## 2. 授权区间的**界内登记入口**（`authority.bands.set`）

| 环节 | 谁做 | 判据/读数 |
|---|---|---|
| 入口 | `domain/authority-band/code/ui.mjs` | **工具栏**（无上下文需求 ⇒ 直接进动作条）+ 面板每行的行内「登记 / 改这一档的授权区间」（按整行预填角色与该档现值） |
| 权限 | 机制（`webui.mjs` 的动作路由） | `permission: 'human-signature'`：未登录 401 `identity-required`；`signature` ≠ 会话身份 403 `signer-mismatch`（**账本零新增**） |
| 白名单 | 插件 + `config-keys.mjs` | 只收 `authority.bands.<角色>`；角色必须在**唯一登记表**里（不造第二份），类型必须是 `integer` |
| 人工门事实 | `authority-bands-apply.py` → `ApprovalService` | `approval/requested` → `approval/granted`，`scope=config.authority`，门号**确定性派生** `ap-NNNN`（可对账）—— **这条门记录的是"谁改的"**：请求人与批准人是同一人（本人在场自助），**不是双人复核**（界面上与 `result` 里都这么写） |
| 0600 待办件 | 同一个脚本 | `cfg-<request_id>.json`（权限**恰 0600**；`payload_sha256`/`bytes` 用落盘者自己的规范化器重算） |
| 落盘 | **唯一落盘者** `src/system/config/tools/config-apply.py` | 原子写 + 回读校验 + 失败回滚；只重写受管三段（`project:`/`plugins:`/`credentials:`），**非受管段逐字节保留** |
| 台账 | 配置账本 | `config/changed`（`key_path=authority.bands.<角色>`、`approval_ref=ap-NNNN`；**只记摘要，不记值**） |

**动作回执**（真跑原文）：`已受理 本次账本 +3 行 · (band-registered) · 已写进受管配置 <路径>
（受管文件 sha256 ccfff16f6b6f → 4bd7ea9188e7，账本 +3 行）`（+3 = 2 行人门事实 + 1 行 `config/changed`）。

## 3. 真跑读数（同一份数据；修前 = `git archive HEAD` 起的 8586，修后 = 工作树 8587）

受管 YAML 由 `--config-file` 指向 `tmp/p49-run/managed-config.yaml`（真 `/workspace/config.yaml` **只读**）。

| 读数 | 修前（8586） | 修后（8587） |
|---|---|---|
| 「授权区间」面板说它读哪一份 | `本页读的受管配置：/workspace/config.yaml`（**错的**：服务用的是 `--config-file` 那一份） | `本页读的受管配置：<仓库根>/tmp/p49-run/managed-config.yaml` |
| 受管 YAML 里登记 `buyer=500000` 后 | 面板/队列仍说「未配置」（读的是缺省路径） | 面板行 `采购员（buyer） 500000`；队列同一笔：`在区间内（最严的一档 采购员 限额 500000 分覆盖这笔）` |
| `authority.check(420000)` | `unconfigured` | `在区间内（还差 — 分到限额）` |
| 队列「越界？」列（`ap-0002`，420000 分） | `未配置（一条 authority.bands.* 都没登记…）` | 同上，与 `authority.check` **同一结论** |
| **界内**登记：`buyer 500000 → 300000`（行内入口，人签） | 没有这个入口（`authority.bands.set` 不存在） | 回执「已受理 本次账本 +3 行」；受管 YAML `authority.bands.buyer: 300000`；非受管段 `notes.keep_me` 原样保留 |
| 改完之后的两处读数 | — | 队列：`越界 120000 分 ⇒ 下一个能批的是 主管（lead）`；`authority.check(420000)`：`越界 120000 分`（`next_role=lead`）—— **同一结论** |
| `/workspace/config.yaml` 的 sha256 | `6cf43d027a612244…` | **`6cf43d027a612244…`（全程逐字节未动）** |
| 0600 待办件 | — | `cfg-cbe0f67475239e11.json`，权限 `-rw-------`，消费后移入 `applied/` |

**复跑**：`sh tmp/p49-shots/start.sh <树根> <端口> <数据目录> <受管YAML> <日志名>`；截图与原始读数
见 `tmp/p49-shots/REPORT.md` §2。**登记动作不放松任何判据**：署名仍必须等于会话身份（服务端门），
越界的出路仍是人工门（本插件不能批准）。

## 4. 边界与仍做不到的（如实登记）

1. **`./run up --config-file X` 仍不下传**：`run`（装配脚本）既没把 `--config-file` 传给 `webui-serve.py`，
   也没把 `QUOTAGENT_CONFIG_FILE` 放进服务进程环境 ⇒ 走 `./run` 起的服务仍然是缺省路径。本批的**可改面**
   不含 `run`/`webui-serve.py`（另有 agent 在改别的面），故按"登记不隐藏"记在这里：要么加一行
   `QUOTAGENT_UI_CONFIG=$CONFIG_FILE`，要么用 `node host/cli.mjs webui --config-file <YAML>` 起服务
   （后者已在 `tools/verify.sh authority` 的端到端门里用）。
   注意 `QUOTAGENT_CONFIG_FILE`（`run` 的 doctor/init 约定）**故意不采纳**：config-view 不认它，
   采纳就会造出"读一份写另一份"的新分歧。
2. **登记的门是自助的**：请求人与批准人同一人（与邮件配置那条路 `identity-mail-apply.py` 同一口径）。
   它证明"谁改的"，**不是**双人复核；界面上（确认页 + 回执的 `self_approval_note`）照实写出来。
3. **供应商侧不能改**：`authority.bands.set` 只注册在承包商道（改限额不是投标方的事），
   供应商侧的同一块面板是**看**的那一面（`authority.check` / `authority.escalate` 照旧两侧都有）。
4. **新增角色仍要走登记表**：角色集合的真源是 `src/system/config/code/config-keys.mjs` 的
   `authority.bands.*` 三行；界面上只能挑登记过的角色（不在这里造角色）。
