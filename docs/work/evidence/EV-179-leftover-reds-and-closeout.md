# EV-179 清遗留红 + 收尾（T-329）

<!-- budget: 8 KB（`docs/work/evidence/*.md`）。原始输出（逐门 rc/passed/total、反向验证、status 原文）见本文件；不复制模板。 -->

## ① 六个围栅门：跟重导链读到**真实体**（不放宽白名单）

**共同根因（HEAD 上即红）**：`host/modules/<x>.mjs` 自搬迁起是**薄重导**（实体在 `src/<层>/<插件>/code/`，中间经
`host/lib/entity-<x>.mjs` 一跳），而门的「被检查产物」= 只读第一跳 ⇒ ①按源码文本判的断言在 8 行重导上**静默判绿**；
②正常的**链目标** `../lib/entity-<x>.mjs` 被误判成「越界 import」（第 1 条断言红）。

**修法（口径收紧而非放宽）**：每个门加 `moduleChain(entry)` —— 只有**纯重导**（除注释外恰好一行 `export * from '<spec>'`）
才算一跳；`source` = **整条链的文本**（静态副作用扫描也一起读穿）；import 白名单**逐文件判**：链目标**只在该跳文件里**豁免，
实体自己写的任何 spec 照原白名单逐字判。**断言条数一格未减**（6 道门全部与修前相同）。

| 门 | 修前 rc / 失败详情 | 修后 rc / passed/total | 反向验证（往**真实体**加一条未声明 import） |
|---|---|---|---|
| `approval-digest` | rc=1，第 1 条 `ok:false`（`越界=../lib/entity-approval-digest.mjs`）9/10 | rc=0 **10/10** | `import * as zzUndeclaredProbe from '../../../../host/lib/schema.mjs'` ⇒ rc=1、红 1 条、还原一致 |
| `budget-guard` | rc=1，负控⑥ `ok:false`（`'Date.now(' 出现 0 次`、`不符合默认时钟形状`）9/10 | rc=0 **10/10** | 真实体加 `node:fs` ⇒ rc=1、红 1 条（负控⑥）、还原一致 |
| `supplier-scorecard` | rc=1，第 1 条（`越界 import=../lib/entity-supplier-scorecard.mjs`）9/10 | rc=0 **10/10** | 同探针 ⇒ rc=1、红 1 条、还原一致 |
| `plugin-market` | rc=1，第 1 条（`越界 import=../lib/entity-plugin-market.mjs`）12/13 | rc=0 **13/13** | 同探针 ⇒ rc=1、红 1 条、还原一致 |
| `pipeline-view` | rc=1，第 1 条（`越界 import=../lib/entity-pipeline-view.mjs`）12/13 | rc=0 **13/13** | 同探针 ⇒ rc=1、红 1 条、还原一致 |
| `retention-view` | rc=1，第 1 条（`越界 import=../lib/entity-retention-view.mjs`）11/12 | rc=0 **12/12** | 同探针 ⇒ rc=1、红 1 条、还原一致 |

**第二半边（链上的一跳被偷改也要红）**：往 `host/lib/entity-approval-digest.mjs` 加一条未声明 import ⇒ 该跳**不再是纯重导**
⇒ 跟链停在那一跳、它自己的 spec 一并按普通 import 判 ⇒ `approval-digest` rc=1、第 1 条红；还原后 rc=0（10/10）。
**明细可见性**：6 道门的第 1 条 detail 现在都打印 `链=[host/modules/x.mjs → host/lib/entity-x.mjs → src/…/code/x.mjs]（3 跳）`。

## ② `tools/**` 非薄入口再搬 10 项（基线 13 → 3）

搬运清单（旧 ⇒ 新；旧位置一律 `runpy` 薄转发 236–254 B）：`check-run-once.py`/`check-run-clone.py` → `src/system/runtime/tests/`；
`config-apply.py` → `src/system/config/tools/`；`g1-walkthrough.py` → `src/system/repo-gate/tests/`；
`mutate-ui-views.py`/`refresh-ui-snapshots.py`/`ui-seed-pipeline.py`/`webui-serve.py` → `src/system/webui/tools/`；
`quote-draft.py`/`quote-sign.py` → `src/domain/quote-prepare/tools/`。

**先改读方（按路径装载/调用被检查实体，共 20 处）**：`check-config-route.py`、`check-mail-transport.py`(×3)、`mail_transport.py`、
`check-ui-seed.py`(×3)、`checks_ui_snapshot.py`、`checks_config.py`、`checks_qprep.py`(×2)、`check-quote-draft-route.py`、
`check-pipeline-route.py`、`check-run-once.py`、`ui-seed-pipeline.py`、`webui-serve.py`(×3)、`mutate-ui-views.py`(×3 变异锚点)、
`ws-integrate.py`、`run`。余 3 项**逐条留名不搬**：`manual-check.py`（契约面 0 调用者）、`netblock.c`（`run-clone` 按仓库路径编译）、
`v-kit.sh`（`.sh` 转发还要 `git add --chmod=+x`）。

**对拍（HEAD 干净 worktree `/tmp/qa-baseline` vs 本树，逐门 rc 与 passed/total）**：plugin-assets 16/16、plugins 5/5、
config-route 22/22、mail-transport 27/27、mail 20/20、ui-seed 17/17、quote-draft 14/14、webui 51/51、storage 19/19、
retention 22/22、pipeline-route 18/18、invariants 22/22、wiring 5/5、events rc=0、evolution rc=0、evolve-module 61/61、
run-once rc=0 PASS（两树同）、**ui-mutate 4/4 且 rc=0（两树同）**、ac-registry rc=0（两树同）、`g1` 两树都 rc=1
（**HEAD 即红**：`tools/audit-verify.py` 被直接 exec 而无执行位 ⇒ `Exec format error`；与本批无关，未改）。
> `ui-mutate` 对拍：HEAD 侧先把 `mutate-ui-views.py` 里**硬编码的** `ROOT` 指到基线树（该行写死
> `/workspace/projects/quotagent`，属既有不可移植缺陷），两边各跑 4 处变异 ⇒ **M1–M4 全红且还原一致**。

## ③ 补承载 4 个（53 → 57/63）

| 插件 | 接法 | `status` |
|---|---|---|
| `domain/compare` | 新增 `code/index.mjs`（对 `./compare.mjs` 的薄包装；`provides=[compare]` 与实体一致） | `valid:true`、`kind: esm` |
| `system/kernel-bridge` | 新增 `code/index.mjs`（薄包装）；`provides` 占位键 → 实体真实服务键 **`bridge`** | `valid:true`、`kind: esm` |
| `system/qa-runner` | 新增 `code/__init__.py`（Python 装载面，重导出 `quotagent.qa.registry`，`__all__` 11 名，实测可独立执行） | `valid:true`、`kind: python` |
| `system/repo-gate` | `entry` **指到插件根下的实现** `tests/check-plugin-assets.py`（本插件的实现是 11 个独立可执行的门，**没有一个模块面可包装** ⇒ 不造 `code/` 包装） | `valid:true`、`kind: python` |

**未做（需设计决定，只登记待定理由）**：`system/webui`（接入口会让 `plugin-lifecycle` 的 **A13/A14** 的
`missing_targets/deps_missing == ["system/webui"]` 与**变异 6** 三条**同时失去对照** = 放宽 ⇒ 需人工定：入口是否就是
`webui.mjs`、`uiSlots` 算不算对外服务键、A13/A14 改指哪个未迁移目标）、`system/admin`（两个实体各自自述服务键）、
`agent-runtime`（3 个）、`canary`（2 个）、`eval`（3 个 Python）、`kernel`（9 个，ADR-0002 冻结）、`mail`（视图 vs 服务本体）。
七条理由均写进各自 `requirements/README.md` 的「落地状态（`code/`）」节。

## ④ 历史引用清账

- `docs/design/14-plugin-inventory.md`：`tools/{config-apply,quote-draft,quote-sign,refresh-ui-snapshots}.py` → 事实路径
  （28631 B，headroom 41；路径变长的字节由**同批删重复叙述**吸收：`（本行）`、`（**唯一落账本者**）` 的冗余强调）。
- `docs/design/15-requirements-coverage.md`：同上 → 事实路径（28668 B，headroom 4；吸收来源＝两行**逐字重复**的
  「围栏门 22/22 … 避免两处重复」括号缩成「（逐条计数与断言在 §2 的格子里）」，删重复不删事实）。
- `docs/design/14-plugin-inventory-archive.md`：事实路径 + **已归位**标注（历史附录允许）。
- `docs/work/plugin-requirements-map.md`（30255 B）、`docs/work/plugin-requirements-deviations.md`（4149 B）：事实路径。
- `docs/work/plans/plugin-file-map.md`：§分类 A 节 10 行 → `插件·已搬`、**待搬 13 → 3**、基线 3；`plugin-file-map-batches.md`
  批次台账补本批。
- **范围与限制（如实）**：只同步**本批搬走**的 `tools/**` 10 项；更早批次的 `host/modules/<x>.mjs` 写法保留（该路径作为
  **宿主模块路径**这一事实未变＝薄重导），且 `docs/design/*.md` 的 28 KB 预算在 14/15 上只剩 41 B / 4 B（**无法**再放宽）。
- `docs` 门：本批首次跑红**只因 `EV-179` 未落地**（`未解析的 ID 引用 1 个：EV-179 ← …`）；本文件落盘后转绿。

## ⑤ 收尾

20 道门（含上述 6 个）+ `run-clone`（提交后，校验 HEAD）+ `clean-copy`：逐门 rc/passed-total、`git status` 原文、commit
SHA 与 `git ls-remote` 回读见本文件**追加节**（提交后写）。
