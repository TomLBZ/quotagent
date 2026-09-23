# EV-173 — 迁移阶段 4.2 续批 + `qa` 检查搬家 + 阶段 5 第一小片（`T-322`）

本批搬走 **40 个实体**（① 围栅门 10 + ② `qa` 检查 21 + ③ 内核模块 9），逐项清单（含旧位置字节数）与**每一行搬前/搬后原文**在 `EV-173-batch3-raw.json`（`inventory` / `gate_pairwise` / `ac_pairwise` /`gate_detail_diff`；`.md` 有 8 KB 预算，原文放 JSON 里，口径与 `EV-172-relocation.json` 相同）。

## 一、三类清单（40 项实体）

- **① 10 个围栅门**：`host/*-gate.mjs` 至此 **20/20 全部搬完**（旧位置 5 行薄转发，`verify.sh` 分支一行未改）。
- **② 21 个 `qa` 检查**：`src/quotagent/qa/<f>.py` → `src/<归属插件>/tests/<f>.py`（旧位置 `importlib` 薄转发）。
- **③ 9 个内核模块**（阶段 5 第一小片）→ `src/system/kernel/code/`（旧路径留薄重导；逐条字节守恒见 §三）。

三类各自的**逐项**清单（旧路径 / 新路径 / 归属插件 / 旧位置字节数）在 `EV-173-batch3-raw.json` 的 `inventory`（40 行）+ 分类表 `docs/work/plans/plugin-file-map.md` §分类。

## 二、① 围栅门：搬前 / 搬后逐项对拍（原始行）

```text
gate=pipeline-view   搬前 rc=0 13/13(fail=0)   搬后 rc=0 13/13(fail=0)
gate=plugin-market   搬前 rc=0 13/13(fail=0)   搬后 rc=0 13/13(fail=0)
gate=user-space      搬前 rc=0 21/21(fail=0)   搬后 rc=0 21/21(fail=0)
gate=agent-runtime   搬前 rc=0 22/22(fail=0)   搬后 rc=0 22/22(fail=0)
gate=storage         搬前 rc=1 18/19(fail=1)   搬后 rc=1 18/19(fail=1)
gate=bid-heuristics  搬前 rc=0 32/32(fail=0),12/12(fail=0)   搬后 rc=0 32/32(fail=0),12/12(fail=0)
gate=advice          搬前 rc=0 30/30(fail=0),14/14(fail=0)   搬后 rc=0 30/30(fail=0),14/14(fail=0)
gate=gates           搬前 rc=0 33/33(fail=0),11/11(fail=0)   搬后 rc=0 33/33(fail=0),11/11(fail=0)
gate=change-detail   搬前 rc=0 22/22(fail=0),9/9(fail=0)   搬后 rc=0 22/22(fail=0),9/9(fail=0)
t271-admin-direct（本门此前无人跑 ⇒ 直跑）: 搬前 rc=0 18/18(fail=0)   搬后 rc=0 18/18(fail=0)
admin-route 的 python 半边（HEAD 干净副本 → 本树）: 搬前 rc=0 13/13(fail=0)   搬后 rc=0 13/13(fail=0)
```

对拍判据（`tmp/pair/cmp.py`）：**blob 数、passed/total/failures、每条断言的名称与 ok、掩掉端口/pid/耗时/临时目录后的 detail** 逐项比 ⇒ 全部 `counts_same=True names_same=True ok_same=True`，残余 detail 差异只有 2 处且都与搬迁无关（`t271` 的会话 cookie 每次随机、`storage` 第 9 条的租户 `last_write` 墙钟）。

**`storage` 门搬前就是红的（rc=1、18/19、第 8 条）**，原因与搬迁无关（符号链接事实区判据），见 §五。

## 三、③ 内核：旧导入路径仍可用的实测行（原文）

```text
运行中的 Ledger.append 的 co_filename = <仓库根>/src/system/kernel/code/ledger.py
运行中的 EventBus.emit  的 co_filename = <仓库根>/src/system/kernel/code/events.py
模块 __doc__ 首行 = ctx.events：五模式事件分发（`docs/design/05-events.md`）。
模块 __file__（导入面） = <仓库根>/src/quotagent/kernel/events.py
```

实体字节守恒（搬前 = `git show HEAD:`，搬后 = 新位置）：

```text
kernel/__init__.py  HEAD(实体)=c72cf82d1768ed96  新位置=c72cf82d1768ed96  相同
kernel/canon.py  HEAD(实体)=27c5d7bfc106f049  新位置=27c5d7bfc106f049  相同
kernel/delivery.py  HEAD(实体)=3d7c2545e4837631  新位置=3d7c2545e4837631  相同
kernel/events.py  HEAD(实体)=fa2645028fc29a9c  新位置=fa2645028fc29a9c  相同
kernel/evidence.py  HEAD(实体)=dd01e35b28fff1cf  新位置=dd01e35b28fff1cf  相同
kernel/ledger.py  HEAD(实体)=aa08a59ff3b71756  新位置=aa08a59ff3b71756  相同
kernel/modelgate.py  HEAD(实体)=2ac8400ca7a6efdf  新位置=2ac8400ca7a6efdf  相同
kernel/plugin.py  HEAD(实体)=fbc64ccb9fae62b6  新位置=fbc64ccb9fae62b6  相同
kernel/qep.py  HEAD(实体)=7c31cf23761fae9d  新位置=7c31cf23761fae9d  相同
```

本批为此改的三处**读方**（只改读哪一份文件，不改判据）：

- `tools/check-events.py`：`EVENTS_MODULE` → `src/system/kernel/code/events.py`（旧路径没有默认事件表可解析）。
- `src/quotagent/qa/checks_runtime.py`：P0 扫描面 = 内核实体目录 + 旧薄重导目录 + 服务 + `paths.py`，并新增非空转下界（实体目录 ≥8 个 `.py`）⇒ 判据只增不减。
- `tools/check-clean-copy.py`：自足性清单**新增**实体路径（旧路径保留）⇒ 只增不减。

## 四、② `qa` 检查：逐项对拍（原始行见 JSON `ac_pairwise`）

31 条相关 AC（29 条 + `AC-AGENTRT-002` + `AC-QUOTE-001`）**全部**`names_same=True ok_same=True`，detail 差异逐条可解释：

- 围栅门字节数 `+673 B`（搬迁补丁：`cordis` 改按宿主目录显式解析 + HERE 由仓库根推出）—— 4 条 AC 的 detail 里有它。
- `AC-MAIL-001` 的 `module` 由 `quotagent.qa.checks_mail` 变 `quotagent.qa.checks_mail._impl`（`importlib` 薄转发的装载名，与既有的 `checks_qprep._impl` 同形）。
- `AC-AGENTRT-002`：仓库根、探针的「真源码路径形状」、检查器自身哈希三处随搬家变化。
- **`AC-QUOTE-001` / `AC-UIFB-001` 由红转绿**（修真缺陷，见下）。

### 三个真缺陷

- **已修 A（AC-QUOTE-001）**：上一批（EV-172）把 `t286-quote-draft-gate.mjs` 搬走后，`checks_qprep.py` 仍按 `host/t286-quote-draft-gate.mjs` 读门 ⇒ 读到 243 B 薄转发 ⇒「五件产物齐备」断言实测红（`gate=243B`）。修法 = 读**实体** ⇒ 搬后 `gate=30265B`、`pass 7/7`。
- **已修 B（AC-UIFB-001）**：同源（`t280` 239 B 薄转发 ⇒ `gate marks=[]`）⇒ 修后`gate=33382B`、`gate marks=['MUTATIONS', 'mustRed', '假变异']`、`pass 8/8`。
- **已修 C（同源，防患）**：本批搬走的 `t275/t279/t281/t282/t283` 也各有检查器按旧路径读门（`checks_agentrt*` / `checks_viz` / `checks_adv` / `checks_gate`）⇒ 同批一并改成读实体，否则 `p0-no-node`（含 P2 的 AC）会跟着红。
- **登记（未修，非本批范围）**：`tools/storage.py` 的事实区判据 `USER_SPACE = ROOT / "user-space"` 在阶段 5.1（EV-168）把 `user-space` 改成**指向 `src/userspace` 的符号链接**后失效：判据拿**未解析**的 `user-space` 与**已 realpath 的**目标比 ⇒ `_inside()` 恒假。实测未解析/已解析两种 root 都不给 `storage-fact-path`（返回 `namespace-empty`），⇒ `verify.sh storage` 第 8 条红、18/19。**搬前就是红的**（与搬迁无关）；本批只搬不修（一次改两件事会掩盖搬迁影响），登记为遗留。

## 五、门的结果（提交前的工作树，`env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN`）

```text
（待提交后追加）
```

提交**之后**（校验 HEAD 的那一类门，`run-clone` 在 `git archive HEAD` 解出的仓库外干净副本里真跑）：

```text
RUNCLONE rc=0
[ok]   K10-2 变异：变异2：把健康检查改成不检查（探针恒真）（必须让指定断言变红；变异体 == 原件 + 单点替换）
[ok]   K10-3 变异：变异3：把 down 改成不释放端口（收不到本次启动的 pid ⇒ 不回收）（必须让指定断言变红；变异体 == 原件 + 单点替换）
[ok]   K10-4 变异：变异4：doctor 把缺失的依赖报成 ok（假装能跑）（必须让指定断言变红；变异体 == 原件 + 单点替换）
[ok]   K10-0 基线（未变异）在同一序列上**不红**（否则四处变异变红都是空转）
[ok]   K10-5 全过程**产品树字节不变**（变异只写在仓库外的副本里；`./run` 与原件逐字节一致）
RESULT: PASS（run-clone 门 20/20）
--- 提交后 git status --porcelain 原文 ---
（以上为原文；行数=0）
```

## 六、两半边验证 + 提交后 `git status --porcelain`（原文）

```text
（待提交后追加）
```

## 七、没验证的东西

```text
（待提交后追加）
```
