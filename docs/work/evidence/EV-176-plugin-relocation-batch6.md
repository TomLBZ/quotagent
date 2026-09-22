# EV-176 — 搬迁收剩批：① `tools/**` **12 项** ② `host/modules/*.mjs` **13 个实体** ③ **7 个**插件补真实承载

> 逐项清单与机制说明在 [`plugin-file-map-batches.md`](../plans/plugin-file-map-batches.md)（§阶段 4.2 续搬（二）/
> §阶段 5 第四小片）。全部命令带 `env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN`；`run-clone`/`clean-copy` **校验 HEAD** ⇒ 提交后跑。

## 一、① 12 项 `tools/**` → `src/<层>/<插件>/tests/`（旧位置只剩薄转发）

**实现只改一处**：`ROOT` 推导 `parent.parent`/`parents[1]` → `parents[4]`；门名与 `verify.sh` 分支一行未改。

| 门 | 搬前（rc / 摘要） | 搬后 | 同 |
|---|---|---|---|
| `docs` | `rc=0` `RESULT: PASS` | 同 | ✅ |
| `coverage` | `rc=0` `"passed":8,"total":8` | `8/8` | ✅ |
| `ac-registry` | `rc=0` 输出 4 行逐字节相同 | 同 | ✅ |
| `plugins` | `rc=0` `RESULT: PASS（插件清单门 5/5）` | 同 | ✅ |
| `webui` | `rc=0` `RESULT: PASS（webui 门 51/51）` | 同 | ✅ |
| `wiring` | `rc=0` `"passed":5,"total":5` | `5/5` | ✅ |
| `invariants` | `rc=0` `宿主强制不变量：22/22 通过` | 同 | ✅ |
| `events` | `rc=0` `文档与事件表完全一致（名称与模式）` | 同 | ✅ |
| `v` | `rc=0` `RESULT: PASS` | 同 | ✅ |
| `clean-copy` | `rc=0` `RESULT: PASS（15 道门在干净副本里全绿；已提交内容自足可复现）` | 同 | ✅ |
| `bid-heuristics` | `rc=0` `"passed":12,"total":12` | `12/12` | ✅ |
| `idem-route` | `rc=0` `"passed":5,"total":5` | `5/5` | ✅ |

口径（先量后写）：前 8 门的「搬前」行取自本批开工时同一工作树实测（`tmp/gate-before-suite/*.out`）；
`v`/`clean-copy`/`bid-heuristics`/`idem-route` 的「搬前」行 = 把 `git show HEAD:tools/<f>` 放回旧路径后实测
（字节与搬前那份相同），跑完即复原薄转发。
`plugin-assets` 同步：`RELOCATED` **84 → 96**；`BASELINE_NONTHIN` **54 → 42**（**收紧**，非放宽）；§分类 A 节 12 行
`插件·待搬 → 插件·已搬`（PA7 明细：`非薄入口 == 待搬集合 42 项，且 ≤ 基线 42`）。

## 二、② 13 个 `host/modules/*.mjs` 实体 → `src/<层>/<插件>/code/`

**字节守恒 13/13**（`HEAD:host/modules/<stem>.mjs` == `hash-object src/<插件>/code/<stem>.mjs`；逐条 blob 见台账）。
**旧导入路径仍可用（实测）**：13 项逐个比较「旧薄重导 / 新实体 / 搬前原样（`tmp/head-check/`）」三者的导出名集合
与 `name/provides/inject/usedServices/Config/fixture`：

```text
{"stem":"norm.mjs","keys":"Config,apply,builtin,convert,disposer,inject,name,provides,usedServices",
 "exports_identical_old_new":true,"exports_identical_vs_HEAD":true,...}
{"TOTAL":13,"FAIL":0,"rows":13}
```

**两半边**：`host/modules/<stem>.mjs` = `export * from '../lib/entity-<stem>.mjs'`；`host/lib/entity-<stem>.mjs`
= `export * from 'src/<层>/<插件>/code/<stem>.mjs'`（过一跳的理由：`modules` 门的 A6 按**源码文本**只允许宿主模块
import `./` 与 `../lib/`）。实体里的 `../lib/…` **逐字未改** ⇒ 每插件目录一条过渡软链
`src/<层>/<插件>/lib -> ../../../host/lib`（10 条）。
**先改读方再搬 10 处**（否则静态断言在薄重导上**静默判绿**）：`t279`/`t277`/`t275`/`t271`/`t268` +
`checks_agentrt(.py/_lifecycle.py/_memory.py)`、`checks_viz.py`、`checks_config.py`。

**受影响门（搬后实测，rc 全 0）**：`modules` 521/521 · `wiring` 5/5 · `webui` 51/51 · `invariants` 22/22 ·
`plugin-lifecycle` 66/66 · `plugin-market` 13/13 · `storage` 19/19（报告里路径已是 `src/system/storage/code/…`）·
`agent-runtime` 22/22（三件路径已是 `src/system/agent-runtime/code/…`）· `governor` 9/9 · `mail` 20/20 ·
`mail-transport` 27/27 · `canary` 11/11 · `bridge-canary` 11/11 · `canary-route` 8/8 · `retention` 22/22 ·
`retention-view` 12/12 · `ops-view` 9/9 · `evolve-journal` 7/7 · `observability` 6/6 · `audit-hook` 7/7 ·
`supplier-scorecard` 10/10 · `pipeline-view` 13/13 · `approval-digest` 10/10 · `budget-guard` 10/10 ·
`idempotency-guard` 10/10 · `breaker` 10/10 · `breaker-route` 4/4 · `budget-route` 5/5 · `idem-route` 5/5 ·
`evolve-module` 61/61 · `evolution` 31/31 · `admin-route`/`user-space`/`config-route`/`bid-heuristics` rc=0。

## 三、③ 7 个插件补**真实承载**（不新造功能）

入口 `code/index.mjs` 只把**已在 `code/` 的实体**重导出（`export *` 活绑定）+ 透传
`inject/provides/usedServices/Config/apply`；`plugin.json` 的 `provides` 改为实体自述的**真实服务键**。

```text
$ tools/plugin.sh status system/norm|domain/sourcing|system/governor   ⇒ valid=True reason=None kind=esm
  provides=['norm'|'sourcing'|'governor'] deps_ready=True
$ tools/plugin.sh status system/config|system/storage|system/user-plugin-manager|domain/bid-heuristics
  ⇒ valid=True reason=None kind=esm provides=['configView'|'storageView'|'userPluginManager'|'bidHeuristics']
$ tools/plugin.sh load domain/bid-heuristics ⇒ rc=0 uid=2 fiber_state=ACTIVE effects=1（ctx.provide("bidHeuristics")）
$ tools/plugin.sh unload domain/bid-heuristics ⇒ effects_after=0 zero_effects=true
```

其余 **47 个**未接入口的插件逐个在自己的 `requirements/README.md` 新增「落地状态（`code/`）」一节**如实标注**
（`部分落地` / `待实现`；不拼装、不造功能）。7 个入口全文只有 import/重导出/透传，**零业务语义、零写面**。

## 四、18 道门（含本批改到的门）在工作树上全绿

`docs` PASS · `coverage` 8/8 · `ac-registry` rc=0 · `plugins` 5/5 · `webui` 51/51 · `modules` 521/521 ·
`wiring` 5/5 · `invariants` 22/22 · `events` rc=0 · `storage` 19/19 · `plugin-assets` **14/14** ·
`plugin-requirements` 18/18 · `plugin-lifecycle` 66/66 · `p0-no-node` rc=0 · `run-once` **34/34** ·
`ac AC-COMPARE-004` rc=0；提交后：`clean-copy` rc=0、`run-clone`（见 §五）。
`run-once` 首跑 33/34（`R11-0` 基线红 `#6=True`）——**真因是环境残留**（`tmp/run/` 有 628 个历史
`webui-<端口>.log`，`free_port()` 撞上其一 ⇒ `logs` 基线不再是 `log-missing`）；清残留日志与两个门夹具进程后
**复跑 34/34**（`tmp/` gitignored；门与产品树一行未改）。

## 五、提交前后的 `git status --porcelain`、commit、push 回读

