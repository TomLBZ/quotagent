# EV-179 清遗留红 + 收尾（T-329）

<!-- budget: 8 KB。逐门原始行 / status 原文 / SHA / ls-remote 见同目录 `EV-179-closeout-raw.json`（.json 无 md 预算）。 -->

## ① 六个围栅门：跟重导链读到**真实体**（不放宽白名单）

**根因（HEAD 上即红）**：`host/modules/<x>.mjs` 搬迁后是**薄重导**（实体在 `src/<层>/<插件>/code/`，经
`host/lib/entity-<x>.mjs` 一跳），门却只读第一跳 ⇒ ①按源码文本判的断言在 8 行重导上**静默判绿**；②正常的
**链目标**被误判成「越界 import」。**修法**：加 `moduleChain()` —— 只有**纯重导**才算一跳、`source` = 整条链的
文本（静态副作用扫描一起读穿）、链目标**只在该跳文件里**豁免；**断言条数 6/6 一格未减**。

| 门 | 修前 rc / 失败详情 | 修后 rc / passed-total | 反向验证（真实体加未声明 import） |
|---|---|---|---|
| `approval-digest` | rc=1，第 1 条 `ok:false`（`越界=../lib/entity-approval-digest.mjs`）9/10 | rc=0 **10/10** | rc=1、红 1 条、还原一致 |
| `budget-guard` | rc=1，负控⑥ `ok:false`（`Date.now(` 出现 0 次 ⇒ 不符默认时钟形状）9/10 | rc=0 **10/10** | rc=1、红 1 条（负控⑥） |
| `supplier-scorecard` | rc=1，第 1 条（`越界 import=../lib/entity-supplier-scorecard.mjs`）9/10 | rc=0 **10/10** | rc=1、红 1 条 |
| `plugin-market` | rc=1，第 1 条（`越界 import=../lib/entity-plugin-market.mjs`）12/13 | rc=0 **13/13** | rc=1、红 1 条 |
| `pipeline-view` | rc=1，第 1 条（`越界 import=../lib/entity-pipeline-view.mjs`）12/13 | rc=0 **13/13** | rc=1、红 1 条 |
| `retention-view` | rc=1，第 1 条（`越界 import=../lib/entity-retention-view.mjs`）11/12 | rc=0 **12/12** | rc=1、红 1 条 |

探针 = 往**真实体**追加 `import * as zzUndeclaredProbe from '../../../../host/lib/schema.mjs'`（budget-guard 用 `node:fs`，它的判据是禁字扫描）；每次跑完按原字节还原并核对 sha256。
**第二半边**：往**链上的一跳**（`host/lib/entity-approval-digest.mjs`）加未声明 import ⇒ 该跳不再纯 ⇒ 跟链停在
那一跳、其 spec 一并按普通 import 判 ⇒ rc=1；还原后 rc=0。**可观察**：6 道门第 1 条 detail 现在打印
`链=[host/modules/x.mjs → host/lib/entity-x.mjs → src/…/code/x.mjs]（3 跳）`。

## ② `tools/**` 非薄入口再搬 10 项（13 → 3）

旧 ⇒ 新（旧位置一律 `runpy` 薄转发 236–254 B）：`check-run-once.py`/`check-run-clone.py`→`src/system/runtime/tests/`；
`config-apply.py`→`src/system/config/tools/`；`g1-walkthrough.py`→`src/system/repo-gate/tests/`；
`mutate-ui-views.py`/`refresh-ui-snapshots.py`/`ui-seed-pipeline.py`/`webui-serve.py`→`src/system/webui/tools/`；
`quote-draft.py`/`quote-sign.py`→`src/domain/quote-prepare/tools/`。实现只改一处（`ROOT` `parents[1]`→`parents[4]`）。
**先改读方 20 处**：check-config-route、check-mail-transport(×3)、mail_transport、check-ui-seed(×3)、checks_ui_snapshot、
checks_config、checks_qprep(×2)、check-quote-draft-route、check-pipeline-route、check-run-once、ui-seed-pipeline(×1 内引)、
webui-serve(×3 内引)、mutate-ui-views(×3 变异锚点)、ws-integrate、`run`（`webui-serve` 事实路径）。
**余 3 不给入口**：`manual-check.py`（契约面 0 调用者 ⇒ 搬了成孤儿）、`netblock.c`（`run-clone` 按仓库路径编译）、
`v-kit.sh`（`.sh` 转发还要 `git add --chmod=+x`）。

**对拍**（HEAD 干净 worktree `/tmp/qa-baseline` vs 本树，逐门 rc 与 passed/total）：plugin-assets 16/16、plugins 5/5、
config-route 22/22、mail-transport 27/27、mail 20/20、ui-seed 17/17、quote-draft 14/14、webui 51/51、storage 19/19、
retention 22/22、pipeline-route 18/18、invariants 22/22、wiring 5/5、events rc=0、evolution rc=0、evolve-module 61/61、
run-once rc=0、**ui-mutate 4/4 且 rc=0**、ac-registry rc=0 —— **全部相同**。`g1` 两树都 rc=1（**HEAD 即红**：
`tools/audit-verify.py` 被直接 exec 而无执行位 ⇒ `Exec format error`；与本批无关、未改）。
> ui-mutate 对拍：该文件里 `ROOT` 是**硬编码** `<仓库根>`（既有不可移植缺陷）⇒ HEAD 侧对拍前
> 只把这一行指到基线树（产品语义未动），两边各跑 4 处变异，**M1–M4 全红且还原一致**。

## ③ 补承载 4 个（53 → 57/63）

`domain/compare`（新增 `code/index.mjs` 薄包装 `./compare.mjs`；`provides=[compare]` 与实体一致）、
`system/kernel-bridge`（`code/index.mjs` 薄包装；`provides` 占位键→实体真实服务键 **`bridge`**）、
`system/qa-runner`（`code/__init__.py` Python 装载面，重导出 `quotagent.qa.registry`，`__all__` 11 名、实测可独立执行；
**如实说明**：平台运行器、非宿主插件，`provides` 只是必填名字）、`system/repo-gate`（`entry` **指插件根下的实现**
`tests/check-plugin-assets.py` —— 本插件的实现是 11 个独立可执行的门、**没有模块面可包装**，故不造 `code/` 包装）。
四者 `tools/plugin.sh status` 都 `valid:true`（compare/kernel-bridge `kind=esm`；qa-runner/repo-gate `kind=python`）。

**未做（需设计决定，只登记待定理由，不代做）**：`system/webui`（接入口会让 `plugin-lifecycle` 的 **A13/A14**
`missing_targets/deps_missing == ["system/webui"]` 与**变异 6** 三条**同时失去对照** = 放宽 ⇒ 需人工定：入口是否就是
`webui.mjs`、`uiSlots` 算不算对外服务键、A13/A14 改指哪个未迁移目标）、`system/admin`（两个实体各自自述服务键）、
`agent-runtime`（3 个）、`canary`（2 个）、`eval`（3 个 Python）、`kernel`（9 个，ADR-0002 冻结）、`mail`（视图 vs 服务本体）。
七条理由写进各自 `requirements/README.md` 的「落地状态（`code/`）」节。

## ④ 历史引用清账

事实路径写入：`14-plugin-inventory.md`（28631 B）、`15-requirements-coverage.md`（28668 B）、
`14-plugin-inventory-archive.md`（5447 B，标**已归位**）、`plugin-requirements-map.md`（30255 B）、
`plugin-requirements-deviations.md`（4149 B）、`plugin-file-map.md` §分类（A 节 10 行→已搬、**待搬 13→3**、基线 3）。
**预算未放宽**：14/15 的两条 28 KB 行只剩 41 B / 4 B，路径变长的字节由**同批删重复叙述**吸收（删的都是逐字重复的
括号指引，事实一个没删）；`min(通配, 具体)` 下要把具体行抬到 28 KB 以上**不会生效**，抬通配行才是放宽 ⇒ 没做。
**范围限制（如实）**：只同步**本批搬走**的 `tools/**` 10 项；更早批次的 `host/modules/<x>.mjs` 写法保留 ——
该路径作为**宿主模块路径**仍是事实（薄重导），且 28 KB 预算已无空间。
`docs` 门本批首次跑红**只因 `EV-179` 未落地**（`未解析的 ID 引用 1 个`）；本文件落盘后转绿。

## ⑤ 收尾

- 功能提交 **`21d60af`**；提交前 `git status --porcelain`（`git add -A` 之后）**67 行**（全部第一列已暂存，
  无未跟踪残留、无仓库外路径）；提交后 `git status --porcelain` **0 行**（原文见 raw.json）。
- 23 道门（含本批 6 道）逐门 rc/passed-total 见 raw.json `gates_23`：docs/coverage/ac-registry/plugins/webui/modules/
  wiring/invariants/events/storage/plugin-assets/plugin-requirements/plugin-lifecycle/evolution/evolve-module/p0-no-node/
  run-once/approval-digest/budget-guard/supplier-scorecard/plugin-market/pipeline-view/retention-view —— **全绿**。
- 提交后：`run-clone` **rc=0 / PASS 20/20**；`clean-copy` **rc=0 / PASS（15 道门在干净副本里全绿）**。
- **实测到并修掉一处真回归**：新 Python 载体的注释里出现字面量 `cordis` ⇒ `AC-RUNTIME-001` 的扫描
  （`src/{system,domain}/*/code/*.py`）判红 ⇒ `p0-no-node` rc=1（隔离重试两次都红）；改写该注释后 AC 与门都转绿。
- push 与 `git ls-remote` 回读原文见 raw.json `push`（本轮 push 后写）。
