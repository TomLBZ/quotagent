# EV-177 — 搬迁与收剩批（四件）：① `host/lib/**` **13 个** ② 自进化产物**追链搬迁 12 个** ③ `tools/**` 非薄入口 **12 项** ④ **12 个**插件补真实承载

> 命令一律带 `env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN`；`run-clone`/`clean-copy` **校验 HEAD** ⇒ 提交后跑。
> 搬前基线取自**纯 HEAD 干净副本**（`git archive HEAD`；副本 `tools/*.sh` 是 100644 ⇒ `sh tools/verify.sh <门>`）。

## 一、① `host/lib/**` 13 个文件 → 归属插件 `code/`（旧导入路径**实测仍可用**）

| 旧路径 | 新路径（归属插件） |
|---|---|
| `host/lib/bridge.mjs` / `supervisor.mjs` | `src/system/kernel-bridge/code/` |
| `host/lib/canary-dispatch.mjs` / `canary-run.mjs` | `src/system/canary/code/` |
| `host/lib/config.mjs` / `config-keys.mjs` / `config-ui.mjs` / `schema.mjs` / `std-schema.mjs` | `src/system/config/code/` |
| `host/lib/frozen.mjs` / `ledger-view.mjs` | `src/system/kernel/code/` |
| `host/lib/ui-route.mjs` / `ui-slot.mjs` | `src/system/webui/code/` |

旧位置一律写**薄重导**。**"旧导入路径仍可用"实测**：逐文件 `import('./host/lib/<x>.mjs')` 比导出名集合
（含 `name/provides/inject/usedServices/builtin` 逐字段）：

```text
{"old_import":"host/lib/bridge.mjs","ok":true,"keys_before":4,"keys_after":4,"exports_identical":true}
…（13 项 + 2 个未搬对照，共 15 行全 true）
{"TOTAL":15,"FAIL":0}
```

**先改读方（6 处）**——按**源码文本**读这几个文件的读点必须指实体，否则读到 8 行转发：`tools/config-apply.py`（keys+schema）、
`tools/check-run-once.py`、`tools/check-config-route.py`、`tools/check-mail-transport.py`（keys+schema）、
`src/system/mail/tests/checks_mail_transport.py`、`src/system/config/tests/checks_config.py`、`src/domain/authority-band/tests/t284-authority-gate.mjs`。
**实测红→绿**：`config-route` `12/13 → 22/22`；`mail-transport` 真跑 `config-apply --init` 报 `host/lib/config-keys.mjs 解析为空` ⇒ 修后 `27/27`；
`p0-no-node` 的 `AC-CONFIG-001` 报 `keys_bytes=489`（= 转发大小）⇒ 修后绿。
**搬迁补丁 2 处**：`config.mjs` 的 `./frozen.mjs` → `../lib/frozen.mjs`（跨插件 sibling）；
`ledger-view.mjs` 的自相对 `ROOT` `'..','..'` → `'..','..','..','..'`（不改则 `repoRoot` 落到 `src/system` ⇒
`/api/status` 读不到账本计数，实测 `rfq-deadline` 路由半 `9/11` ⇒ 修后 `11/11`）。

## 二、② 自进化产物**追链搬迁 12 个**（sha256 被 `evolution-log.json` 钉住）

`price-history / evidence-summary / circuit-breaker / ops-view / evolve-journal / supplier-scorecard / idempotency-guard /
approval-digest / budget-guard / retention-view / pipeline-view / plugin-market`
⇒ `src/<层>/<插件>/code/<name>.mjs`，**字节守恒 12/12**（`git show HEAD:host/modules/<n>.mjs` 的 sha256 == 新实体）。
两半边：`host/modules/<n>.mjs` → `host/lib/entity-<n>.mjs` → 实体（12 条链，逐条 `keys_head_vs_entity/thin=True`）：

```text
{"name":"price-history","bytes_conserved":true,"head_sha":"edf4fc3cb4f124c4","new_sha":"edf4fc3cb4f124c4","keys_count":10,"ok":true}
…（12 行）
{"TOTAL":12,"FAIL":0,"rows":12}
```

日志**同步追链**：每条记录新增 `artifact_path`（= 新路径）并把 `artifact_hash`/`bytes` 由**当前实体重算**写回
（`proposal_id`/`approval_ref`/`gate`/`fixture` 一字未改）。**可复跑校验** = `src/system/evolution/tests/check-evolution-log-path.py`
（日志里每条记录 sha256 与当前实体逐字节相等），门 `tools/verify.sh evolve-module` 同步改为**按日志的 `artifact_path` 读**，
并把"旧路径只是薄重导"折进原断言（条数不变 61/61）。

**正向（真树）**：`python3 src/system/evolution/tests/check-evolution-log-path.py` ⇒ 12 行全 `"ok": true`，末行 `{"TOTAL": 12, "FAIL": 0}`，rc=0。
**反向（必红，tmp/ 最小副本内改动，产品树不动）**——`tmp/ev177-chain-negative`：

```text
{"mutant":"N1 追链前形态（日志指旧路径 host/modules/<name>.mjs）","checker":"check-evolved-module.py","rc":1,"expect":"rc=1 必红","tail":"... \"passed\": 25,"}
{"mutant":"N1 追链前形态（日志指旧路径 host/modules/<name>.mjs）","checker":"check-evolution-log-path.py","rc":1,"tail":"{\"TOTAL\": 12, \"FAIL\": 12}"}
{"mutant":"N2 实体翻转一个字节（src/domain/price-history/code/price-history.mjs）","checker":"check-evolved-module.py","rc":1,"tail":"... \"passed\": 60,"}
{"mutant":"N2 实体翻转一个字节（src/domain/price-history/code/price-history.mjs）","checker":"check-evolution-log-path.py","rc":1,"tail":"{\"TOTAL\": 12, \"FAIL\": 1}"}
{"TOTAL":4,"FAIL":0}
```

## 三、③ `tools/**` 非薄入口 12 项 → 各插件 `tests/`（旧处薄转发、门 rc 与 passed/total 逐项不变）

`check-admin-route / check-budget-route / check-pipeline-route / check-rfq-deadline-route / check-ui-seed /
check-mail-transport / check-config-route / check-ui-feedback / check-modules / check-evolved-module /
check-plugin-requirements / check-plugin-assets`。实现只改一处：`Path(__file__).resolve().parents[1]` → `parents[4]`；
`tools/verify.sh` 门名与分支**一行未改**。`plugin-assets` 同步：`RELOCATED 96 → 108`、`BASELINE_NONTHIN 42 → 30`（**收紧**）。

| 门 | 搬前（HEAD 副本 / 同工作树搬前） | 搬后 | 同 |
|---|---|---|---|
| `admin-route` | 13/13 | 13/13 | ✅ |
| `budget-route` | 5/5 | 5/5 | ✅ |
| `pipeline-route` | 18/18 | 18/18 | ✅ |
| `rfq-deadline` | 23/23 + 11/11 | 23/23 + 11/11 | ✅ |
| `ui-seed` | 17/17 | 17/17 | ✅ |
| `mail-transport` | 27/27 | 27/27 | ✅ |
| `config-route` | 22/22 | 22/22 | ✅ |
| `ui-feedback` | 11/11 | 11/11 | ✅ |
| `modules` | 521/521 | 521/521 | ✅ |
| `evolve-module` | 61/61 | 61/61 | ✅ |
| `plugin-requirements` | 18/18 | 18/18 | ✅ |
| `plugin-assets` | 14/14 | **14/14**（PA1 108 / PA7 30 ≤ 基线 30 / PA6 71 门名） | ✅ |

**两半边（逐项）**：旧位置 = 薄转发（标记 + ≤20 行 + ≤1200 B + 指向目标 + 非实体）；目标 = `src/<层>/<插件>/tests/<f>`
存在且**非空**；`plugin-assets` 的 PA1/PA2/PA3/PA5/PA7 逐条断言在 108 项上全通过（就是"两半边"的机检形态）。

## 四、④ 12 个插件补**真实承载**（**不新造功能**）

入口 `code/index.mjs` 只 `export *` 重导出本插件 `code/<实体>` 的公开面 + 透传自述
`inject/provides/usedServices/Config`；`plugin.json` 的 `provides` 改**真实服务键**、补 `migration`，`requirements/README.md`
的「落地状态」一节改写。**实测**：

```text
$ tools/plugin.sh status <12 个 id>  ⇒ 12/12 valid=True reason=None kind=esm deps_ready=True
  provides=[priceHistory|evidenceSummary|breaker|opsView|evolveJournal|supplierScorecard|idempotency|
            approvalDigest|budgetGuard|retentionView|pipelineView|pluginMarket]
$ tools/plugin.sh load system/market  ⇒ rc=0 fiber_state=ACTIVE effects={"count":1,"labels":["ctx.provide(\"pluginMarket\")"]}
$ tools/plugin.sh unload system/market ⇒ effects_before=1 effects_after=0 zero_effects=true
```

## 五、门（17 道 + 本批改到的门）与提交

工作树：`docs` PASS · `coverage` 8/8 · `ac-registry` rc=0 · `plugins` 5/5 · `webui` 51/51 · `modules` 521/521 ·
`wiring` **5/5**（29 个服务；`ops-view` 的 inject 经重导解析回来） · `invariants` 22/22 · `events` rc=0 · `storage` 19/19 ·
`plugin-assets` 14/14 · `plugin-requirements` 18/18 · `plugin-lifecycle` 66/66 · `p0-no-node` rc=0 · `run-once` 34/34 ·
`evolution` rc=0 · `evolve-module` 61/61。
**本批改到的读方**（防静态断言在薄重导上静默判绿）：`check-module-wiring.py` 的 `module_source()` 跟重导链、
`host/check-modules.mjs` 的 `moduleSource()` 链式拼接（A1/A4/A6 一起跟到实体）。

提交：`3a40f56`（功能提交）；提交前后 `git status --porcelain` 原文：提交前 168 行（全第一列已暂存）/ 提交后 **0 行**；
`git ls-remote` 回读 `3a40f56 = refs/heads/main`；提交后 `run-clone` **20/20**、`clean-copy` PASS。
