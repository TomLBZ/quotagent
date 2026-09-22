# EV-181 — 干净副本 3 条真红 + 7 个多实体插件 `entry` 收口 + 可移植性扫描

原始行：`docs/work/evidence/EV-181-raw.txt`（逐条命令 + 原文）。任务行：`T-331`。决策：`D-078`..`D-085`。

> **并发写入者声明（必须先读）**：本批执行期间，**同一个工作树**里有另一个 subagent 在改同一批文件
> （系统在多处报 `modified by sibling subagent 'sa-0-…'`；`src/system/webui/code/index.mjs` 被对方在
> 我验证窗口内整份改写，文件头写的是对方的 `EV-181` 文本）。凡「产品树字节不变」类自证，本文件如实标注
> 哪一处因此**不成立**；凡对方先落盘的改动（例如 4 处硬编码修复、PA9 本体），逐处注明归属。

## ① 三条干净副本红的根因、最小复现、修法

**根因**（不是判据）：`AC-AGENTRT-002/006/007` 的三条断言都真跑同一个围栏门
`t275-runtime-gate.mjs`（实体在 `src/system/agent-runtime/tests/`），而该门在顶层 `import` 宿主的
`cordis`，解析目标是 **gitignored** 的 `host/node_modules/cordis/lib/index.js`。
`git archive HEAD` 的干净副本里该目录不存在 ⇒ `ERR_MODULE_NOT_FOUND`、rc=1 ⇒ 断言红
（原始行：`total=None failures=None rc=1`）。工作树里因为本机装过依赖，所以一直看着是绿的。

**为什么同一副本里「单独跑绿 / 全量跑红」**：全量按 `sorted(REGISTRY)` 顺序跑，`AC-AGENTRT-*` 排在第 5–7 行，
而排在后面的 `AC-INTEG-*`（`checks_bridge.py`）走 `tools/cordis.sh run` ⇒ `install_deps` **顺手把
`host/node_modules` 装上了**。所以全量跑完再单独重跑就绿 —— 这是**顺序**，不是判据差异。

**最小复现（两条命令，独立可复跑）**：`EV-181-raw.txt` ① 段：fresh `git archive HEAD` 副本里
`tools/run.sh -m quotagent.qa all` ⇒ `全量 AC：82/85 通过；失败 ['AC-AGENTRT-002','AC-AGENTRT-006','AC-AGENTRT-007']`；
紧接着 `ls -d host/node_modules` ⇒ 已存在；再单独跑 `ac AC-AGENTRT-002` ⇒ `[PASS]`。

**修法（判据一格未改）**：三条 AC 真跑门一律走 `tools/cordis.sh run t275-runtime-gate.mjs`（先幂等
`install_deps` 再 `exec node host/t275-runtime-gate.mjs` → 薄转发到实体），与既有约定一致
（`checks_bridge` / `check-webui.py` / `check-canary.py` / `check-audit-hook.py`）；`_node()` 的
「无 Node ⇒ 明说降级」分支不变；`failures:0` 且断言数 ≥22 的门槛不变。装不上依赖时 `cordis.sh` 非零退出
⇒ 拿不到 JSON ⇒ 照旧判红（**不是**把红改绿）。
**实测**：干净副本（无 `node_modules`）三条 `[PASS]`；把修复还原成裸 `node <实体>` ⇒ 三条 `[FAIL]`。

## ② 7 个多实体插件：`entry` 决定、门侧替代锚点、断言总数、反向验证

**决定（逐条理由与被否决选项 = `decisions.md` `D-078`..`D-084`）**：`system/webui`+`system/mail` = 重导出
**唯一自述服务的实体**（`webui.mjs` ⇒ `['webui','uiSlots']`；`mail-view.mjs` ⇒ `['mailView']`）；
`system/admin`（`adminGuard`+`adminView`）、`system/agent-runtime`（`agentContext`+`agentMemory`+`agentHarness`）、
`system/canary`（`canary`+`canary-dispatch`，`canary` 先装）= **机制组合入口**（按序 `ctx.plugin()`，零业务语义
零写面，不替成员解析配置）；`system/eval`、`system/kernel` = **Python 承载入口** `code/__init__.py`
（宿主侧 0 个 ESM 服务实体，造 `index.mjs` 只能是空壳 = 造功能）。
结果：`plugin.sh list --json` ⇒ **`valid` 56 → 63**（`degraded: artifact-missing` 7 → 0）；
5 个 ESM 入口逐个 `plugin.sh load` 真装载（`uid`/`fiber_state`/`effects` 来自 cordis 内核实测；
`webui` 因 `inject` 一串宿主服务而如实 `PENDING`，不是崩）。

**门侧替代锚点（不做就等于放宽门）**：`plugin-lifecycle` 的 `A13/A14` 原本锚在「真根上 `system/webui`
**未迁移**」这个**状态事实**上。`webui` 接上入口后：只这两条变红（`missing_targets=[]`、`deps_ready=True`；
门 64/66）⇒ 改成
① 真根 **正控**：`direct/closure/order/missing_targets` 逐项断言（`A13`）、`deps_ready=True` + `deps_missing=[]`
+ `deps_direct=['system/webui']`（`A14`）；
② **对照根负控**（`A13b`/`A14b`）：`make_anchor_root()` 复制**真 `domain/advice`** + 真 `system/webui/plugin.json`
**字节**（`shutil.copyfile`），但**不放入口文件** ⇒ `artifact-missing`；断言 `missing_targets==['system/webui']`、
`closure==[]`、`order==['domain/advice']`、`ok:true`（不崩）、`status.deps_ready==false`、`status=='not-loaded'`，
且未就绪**原因有名**（`valid:false` + `reason='artifact-missing'`）。与 `A15/A16`（裸目录 / 清单缺字段）互补，
是第三种目标形态；负控由**构造**保证，不再随仓库演进变绿。
**断言总数**：`plugin-lifecycle` **66 → 68**（只增不减）。**变异 6 未失对照**：它跑在夹具根上、`invalid_dirs`
自己造 invalid 目标，与真根 webui 是否合法无关（实测 `F6 [ok]`）。
**反向验证**：对照根里补上入口 ⇒ `A13b/A14b` 红；把真 `webui/code/index.mjs` 移走 ⇒ `A13/A14` 红。
（本轮该自证的「产品树字节不变」一句**不成立**：并发写入者在窗口内改写了该文件；结论不受影响，见 raw ③ 段。）

## ③ 硬编码路径扫描 + 新增门断言

**扫描**（全仓 tracked 的码/配置面：`*.py|*.mjs|*.js|*.sh|*.json|*.c|*.h|*.yaml|*.yml|*.toml|*.ini|*.cfg` + 根入口 `run`）：
**142 处**绝对值命中，三类 —— ① **部署挂载点**（`/workspace/config.yaml`、`/workspace/config/*`、
`/workspace/runtime/node`、`/workspace/bin/activate.sh`、`/workspace/services/services.json`）= 合法（产品路径，
均可 env 覆盖）；② `tmp/` 夹具与 `$ROOT/tmp/**` = 合法（仓库内临时）；③ **checkout 根字面量** = 真缺陷类，
**4 处已修**：`tools/manual-check.py`、`src/system/webui/tools/mutate-ui-views.py`、
`src/system/ui-feedback/tools/ui-feedback-monitor.sh`、`.../ui-feedback-tick.sh`（都改成「由本文件位置上溯推出
+ `QUOTAGENT_ROOT` 仍可覆盖」）。**归属**：这 4 处修复与 PA9 本体由**并发写入者先落盘**，本 agent 复核（`git diff`
逐处读过）+ 复跑门通过。
**新增门断言（`plugin-assets`）**：
- 正向：`PA9` 扫描面加**无扩展名的根入口 `run`**（`**/*.sh` 匹配不到它，而 `./run up` 正是「克隆即跑」第一层）
  ⇒ 765 个文件、0 处命中；`PA9b` **扫描面自证**（逐条点名必扫文件，含 `run`，漏一个即红）。
- 反向：`F9` 往 `run` 里写死仓库根 ⇒ `PA9` 必红（红项 `['PA9']`）；与既有 `F8`（`tools/**` 内的同类变异）
  一起证明扫描面与判据都非空转。门：**20/20 PASS**。

## ④ 本批没验证的东西（诚实清单）

见交接主文件的「下一步唯一动作」；逐条列在回答里（① 未在**提交后**的 HEAD 干净副本上复跑这三条 AC 与
`run-clone`/`clean-copy`；② `plugin.sh load` 的 5 个新入口未做「卸载零残留」的逐插件围栏；
③ 并发写入者的改动未经我逐行审阅，只复核了与本批相关的 4 处修复与 PA9/PA9b；④ 「产品树字节不变」
在 A13/A14 反向验证那一轮被并发写破坏，未重跑到干净为止）。
