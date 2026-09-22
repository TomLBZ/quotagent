# EV-172 每个插件自带测试与需求 → **实体标准布局**（`T-321`）

三件事：① 收紧「目录存在 ≠ 插件存在」（产品代码 + 门）② 58 份需求文档 `git mv` 进标准布局
③ 10 个围栅门搬进各自 `tests/`（旧位置留薄转发）。**逐条机器记录**（58 条 from→to / sha256 / 字节 / 表头编辑前后）：
同目录 `EV-172-relocation.json`（本文件只放原始行与样例，避免重复占正文预算）。

## 一 `scan`/`depsClosure` 的**收紧**（改前 vs 改后；同一条命令、同一个夹具根）

夹具 `tmp/pl-tighten`：`src/domain/advice`（`depends_on: ["system/webui"]`）+ `src/system/webui/` = **裸目录**（无 `plugin.json`）。

**改前**（`depsClosure` 把「目录存在」当「插件存在」= 已登记的坑）：
```
$ tools/plugin.sh deps domain/advice --root $PWD/tmp/pl-tighten
{"ok":true,…,"direct":["system/webui"],"closure":["system/webui"],"order":["domain/advice","system/webui"],…,"missing_targets":[],…} rc=0
$ tools/plugin.sh list --json --root $PWD/tmp/pl-tighten
count 2 ; ids [('system/webui', False, 'manifest-missing'), ('domain/advice', True, None)]     ← 裸目录被枚举成插件
```
↑ 裸目录让依赖被当成"已就绪"（`plugin-lifecycle` 的 A13/A14 会因此变红）。

**改后**（同一夹具、同一命令）：
```
$ tools/plugin.sh deps domain/advice --root $PWD/tmp/pl-tighten
{"ok":true,…,"direct":["system/webui"],"closure":[],"order":["domain/advice"],…,"missing_targets":["system/webui"],…} rc=0
$ tools/plugin.sh status system/webui --root $PWD/tmp/pl-tighten
{"ok":false,"code":"unknown-plugin","id":"system/webui","reason":"没有这个插件：system/webui","next_action":"用 `tools/plugin.sh list --json` 看有哪些；目录里没有 plugin.json 的目录不是插件","candidates":[],"verb":"status",…} rc=1
$ tools/plugin.sh list --json --root $PWD/tmp/pl-tighten
count 1 ; not_plugins=[{"id":"system/webui","reason":"manifest-missing"}] ; degraded=[… "not_a_plugin": true …]
```
↑ 假插件**不算存在**（依赖如实记 `missing_targets`）、`status` **判为不存在**（rc=1）。

**再叠一次真插件目录**（`plugin.json` 最小契约齐备 + `entry` 文件真实存在）⇒ 正常识别：
```
$ tools/plugin.sh deps domain/advice --root $PWD/tmp/pl-tighten
{…,"closure":["system/webui"],"order":["domain/advice","system/webui"],…,"missing_targets":[]…} rc=0
$ tools/plugin.sh list --json --root $PWD/tmp/pl-tighten
count 2 ; ids ['system/webui','domain/advice'] ; not_plugins [] ; degraded []
```
**代码**：`src/system/runtime/code/plugin-registry.mjs` 的 `scan()`（没有 `plugin.json` ⇒ 只进 `not_plugins`/`degraded`，
**不进** `plugins`）与 `depsClosure()` 的 `known`（只含 `!item.invalid` ⇒ 只认**合法清单**，`entry` 不存在的不算）。
**门**：`plugin-lifecycle` 新增 A3c/A15/A16/A17/A18（真跑夹具、逐条贴原始行）+ 变异 5/6（分别把这两处改回去必须变红；**6 处变异全红**）。

## 二 58 份需求文档归位（**字节守恒**）

`git mv docs/work/plugin-requirements-<层>-<插件>.md → src/<层>/<插件>/requirements/README.md`，搬前后 **sha256 与字节逐条相同**
（58/58 `conserved=true`，全表在 `EV-172-relocation.json`）。样例：
- `src/system/kernel/requirements/README.md` 5180 B sha256 84c87d5fbb9c4228… ← 搬前 `docs/work/plugin-requirements-system-kernel.md`（sha256 相同=True）
- `src/system/webui/requirements/README.md` 4209 B sha256 6014c5bcaebbe76f… ← 搬前 `docs/work/plugin-requirements-system-webui.md`（sha256 相同=True）
- `src/domain/rfq/requirements/README.md` 3287 B sha256 10e2ca5d7900ec36… ← 搬前 `docs/work/plugin-requirements-domain-rfq.md`（sha256 相同=True）

复核：`python3 -c "import json;d=json.load(open('docs/work/evidence/EV-172-relocation.json'));print(len(d['documents']), all(x['conserved'] for x in d['documents']))"  # 58 True`

另：54 个插件补**最小 `plugin.json`**（只含 name/version/layer/provides/entry/description；`entry=code/index.mjs`
尚未随实体搬迁落地 ⇒ `plugin.sh list` 如实报 54 条 `degraded: artifact-missing`，9 个实体插件 `valid`）。
58 份文档的**表头自述**同步改成「本文件就在标准位置」（逐文件前后 sha/字节见 JSON 的 `header_edit`）。

## 三 10 个围栅门搬进各自 `tests/`（逐项搬前/搬后对拍）

| 门（`verify.sh` 名） | 旧位置（现为薄转发） | 新位置 | 转发体积 | 退出码 前→后 | 判定 passed/total |
|---|---|---|---|---|---|
| `idempotency-guard（10/10）` | `host/t247-idem-gate.mjs` | `src/system/idempotency-guard/tests/t247-idem-gate.mjs` | 339 B/5 行 | 0 → 0 |
| `supplier-scorecard（10/10）` | `host/t247-scorecard-gate.mjs` | `src/domain/supplier-scorecard/tests/t247-scorecard-gate.mjs` | 351 B/5 行 | 0 → 0 |
| `budget-guard（10/10）` | `host/t250-budget-gate.mjs` | `src/system/budget-guard/tests/t250-budget-gate.mjs` | 333 B/5 行 | 0 → 0 |
| `approval-digest（10/10）` | `host/t250-approval-gate.mjs` | `src/system/approval/tests/t250-approval-gate.mjs` | 329 B/5 行 | 0 → 0 |
| `quote-draft（17/17）` | `host/t286-quote-draft-gate.mjs` | `src/domain/quote-prepare/tests/t286-quote-draft-gate.mjs` | 345 B/5 行 | 0 → 0 |
| `ui-feedback（28/28）` | `host/t280-ui-feedback-gate.mjs` | `src/system/ui-feedback/tests/t280-ui-feedback-gate.mjs` | 341 B/5 行 | 0 → 0 |
| `retention-view（12/12）` | `host/t254-retention-view-gate.mjs` | `src/system/retention/tests/t254-retention-view-gate.mjs` | 343 B/5 行 | 0 → 0 |
| `rfq-visibility（26/26）` | `host/t287-rfq-visibility-gate.mjs` | `src/system/projection/tests/t287-rfq-visibility-gate.mjs` | 345 B/5 行 | 0 → 0 |
| `rfq-deadline（23/23）` | `host/t285-rfq-deadline-gate.mjs` | `src/domain/rfq-deadline/tests/t285-rfq-deadline-gate.mjs` | 345 B/5 行 | 0 → 0 |
| `authority（22/22）` | `host/t284-authority-gate.mjs` | `src/domain/authority-band/tests/t284-authority-gate.mjs` | 343 B/5 行 | 0 → 0 |

> 对拍口径：`tools/verify.sh <门名>` 真跑，比 **退出码 + 输出** —— 10 条分支的输出在**掩掉 `port=`/`pid=`/耗时**后逐字节相同
> （唯一残余差异：`budget-guard` 一处墙钟测量 `真实耗时 0.030ms → 0.032ms`）。门名 / 门数 / `verify.sh` 分支**一行未改**。
> **搬后首次真红并修**：`supplier-scorecard` 的候选产物按 `import.meta.url` 解析 ⇒ 搬后指到 `src/**/tests/modules/…`（红）；
> 已把候选基准改成**宿主目录**（新增 `HOST_URL`，语义与搬前相同），复跑 rc=0、判定 10/10 不变。
> `plugin-assets` 基线**未放宽**（PA7：`tools/**` 非薄入口 64 ≤ 基线 64）；§分类 的 10 行改「插件·已搬」+ 新增「阶段 4.2 已搬」小节，
> 剩下 10 个（`t260/t267/t268/t271/t275/t277/t279/t281/t282/t283`）登记为**下批**。
