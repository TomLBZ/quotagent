# EV-180 最后两个真遗留 + 收尾（`T-330`）

四件：① 修 `g1` 全链的**索引执行位**真缺陷 ② 四份文档的预算压力按归档机制解除 ③ `tools/**` 非薄入口 3 → 1
④ 全门全绿 + 提交后 `run-clone`/`clean-copy` + push 回读。提交后原始输出：`EV-180-post-commit.txt`。

## 一、`g1` 全链：索引执行位真缺陷（修前红 → 修后绿）

### 1.1 缺陷（修前实测，工作树）

```
$ env -u QUOTAGENT_PLUGIN_CONTROL_TOKEN tools/verify.sh audit        # 修前
  "detail": "OSError: [Errno 8] Exec format error: '/workspace/projects/quotagent/tools/audit-verify.py'"
  FAIL 执行异常 — OSError: [Errno 8] Exec format error: …            （exit_code 2）
```

根因：`AC-AUDIT-004` 的判定器 `src/system/evidence/tests/checks_audit.py` **三处**把
`str(REPO_ROOT / "tools" / "audit-verify.py")` 当 argv[0] 起进程；而该文件在 HEAD 里是 `100644` 且**无 shebang**
⇒ 工作树里 `Exec format error`，新克隆里是权限拒绝。修法两步：补 `#!/usr/bin/env python3` + **索引里**置 `100755`。

### 1.2 谁被当可执行调用（扫描法：全树找 argv[0] 形态的直接执行点，覆盖 `tools/**`、`src/**/tools/**`、根 `run`、`*.sh`）

| 文件 | 索引执行位（修前 → 修后） | 判定 |
|---|---|---|
| `tools/audit-verify.py` | **`100644` → `100755`** | 唯一缺陷：被 `checks_audit.py` 直接 exec |
| `tools/verify.sh`、`run`、`tools/{run,cordis,plugin,runtime,bootstrap,v-kit}.sh`、`src/system/ui-feedback/tools/*.sh` | `100755` → 未动 | 本来就有执行位 |
| 其余 `tools/*.py`（薄转发） | `100644` → 未动 | 经解释器调用 ⇒ 不需要执行位 |

```
$ git ls-tree HEAD tools/audit-verify.py      # 修前（968de24）
100644 blob 25775d7f1d2c6e5a23740b70323aed47b98eca66	tools/audit-verify.py
$ git ls-tree af496d7 tools/audit-verify.py   # 修后（本批提交）
100755 blob 5eba8619d314b8cafb5b6f480e7c6f8b9c08b470	tools/audit-verify.py
```

**为什么"只 chmod 工作树"没用**：本机工作树在 SMB 上、所有文件都显示 `-rwxrwxrwx`，`ls -l` 看不出差别；
仓库记的是**索引/tree 的 mode 位** ⇒ 判据是 `git ls-files -s` / `git ls-tree HEAD`，落库靠 `git add --chmod=+x`。

### 1.3 干净副本实测（`git archive` 解到仓库外）

修前（`968de24` 副本）：`g1` **红**在更早的位置 —— `FAIL 执行异常 — OSError: [Errno 8] Exec format error`，`rc=1`。
修后（本批提交副本）：同一条命令走完 —— 门全绿、走查 14/14；`全量 AC` 的 3 条红 `AC-AGENTRT-002/006/007`
**上一提交的副本同样红**（那边还多红一条 `AC-AUDIT-004` = 本批修掉的缺陷），故与本批无关，逐条归因见
`EV-180-post-commit.txt` §二（不掩盖、不顺手改）。

## 二、四份文档的预算压力：归档 + 反向验证

四个主文件都贴着硬预算（15 **4 B** slack、14 **41 B**、进度清单 **23 B**、handover **11 B**）。按
`12-documentation-standard.md` §1 的减法顺序（删重复 → 删叙述 → **拆到归档** → 才谈提高预算），**先让门认归档集合、
再逐字搬行**（与 `EV-155`/`EV-164`/`EV-167` 同一套机制）：

| 主文件 | 修前 | 搬走（整行逐字） | 修后 | 归档 | 门的集合口径 |
|---|---|---|---|---|---|
| `docs/design/15-requirements-coverage.md` | 28668/28672 | §1 末段 28 行 4375 B | **24621** | 新建 `15-requirements-coverage-archive.md` | 本批**新增**：主文件 + `15-…-archive*.md`，小节取**并集**；A0「归档存在且贡献定义行」 |
| `docs/design/14-plugin-inventory.md` | 28631/28672 | 18 行 3048 B（承载现状 + 三层插件逐行表） | **25976** | `14-plugin-inventory-archive.md` §6 | 既有（清单文档集合） |
| `docs/work/progress-checklist.md` | 32745/32768 | 20 行 6055 B（最老 `done` 行） | 27127（+`T-330` = 28858） | `progress-checklist-archive.md` 文末追加 | 既有（T 定义集合） |
| `docs/work/handover.md` | 1013/1024 | 逐批细节段 | **967** | 新建 `handover-archive.md` | 本批**新增**：**指针型** —— 每个 `§N` 指针必须有**非空小节** |

搬走那一段的 sha256（可与 `git show` 对拍）：15 `6052687150ef3a9721…`、14 `8a17d8970a07a0ec96…`、
清单 `e7019c9d6fd12aed4e…`。口径同步写进 `12-documentation-standard.md` §2 与三个门脚本头。

### 2.1 反向验证：四个归档各抽一行/一节 ⇒ 门必红（在 `tmp/` 的整树副本里做，产品树不受影响）

| 例 | 变异（整行删） | 基线 → 变异后 | 命中的断言（原始行） |
|---|---|---|---|
| A | 15 归档删 `| FR-AGENTRT-007 | …` | `coverage` rc=0 → 1 | `FAIL: 矩阵对 FR 文档**双向全覆盖**… \| 缺 1 条['FR-AGENTRT-007']` |
| B | 14 归档删 `| \`src/quotagent/services/*.py\` | …` | `plugins` 5/5 → **4/5** | `[FAIL] P3 Python 功能归属…` + `未归属=['admin_blocks','capacity','clarify',…]` |
| C | 清单归档删 `| T-275 | …` | `docs` PASS → FAIL(1) | `[FAIL] 未解析的 ID 引用 1 个…` + `- T-275 ← …` |
| D | handover 归档删 `## 1 本批（…）` 标题行 | `docs` PASS → FAIL(1) | `[FAIL] 交接文档集合（主文件 + 归档）` + `指针 §1 在归档里找不到对应标题` |

- 15 那道门还**内建**了同一例负控（"删归档里一条 FR 行 ⇒ 必红"）：每次跑门都自证归档不是豁免区。
- **如实记录一次失败的选择**：B 例第一次删的是 §6 表里一行（`| \`src/system/runtime/\`（\`system/runtime\`） |`），
  `plugins` **仍 PASS** —— 该门断言是**集合级**的（每个服务名在整份集合里出现即可），删一行不会让名字消失；
  换成上面那行（独占 19 个服务名）才红。两处原始输出在 `tmp/reverse-180b/`。这是判据边界，不是漏洞。

## 三、`tools/**` 非薄入口 3 → 1

| 资产 | 新家（归属插件） | 旧位置 | 读方改动 | 执行位 |
|---|---|---|---|---|
| `netblock.c` | `src/system/runtime/tests/netblock.c` | `#include` 薄转发（566 B / 实体 4237 B） | `check-run-once.py` 跟到实体 | `100644`（`.c` 不需要） |
| `v-kit.sh` | `src/system/repo-gate/tools/v-kit.sh` | `exec sh` 薄转发（424 B / 实体 2814 B） | `v` 门新增"材料打包器在位"断言；人手命令 `tools/v-kit.sh V-002` 实测 rc=0、一行未改 | 实体 `100755`、旧转发仍 `100755` |

留顶层**唯一**一个：**`manual-check.py`** —— 契约面（`verify.sh` / `qa/*.py` / 各插件 `tests/`、`tools/`）里
**0 个调用者**；`plugin-assets` 的 PA6 要求"已搬资产仍被契约面引用"，搬走即孤儿 ⇒ **不搬**，如实登记在
`plugin-file-map.md` §分类 与 `plugin-file-map-batches.md` §「非薄入口数的加减史」。本批把
`BASELINE_NONTHIN` 从 3 **收紧到 1**；PA7 实测：**非薄入口 == 待搬集合 1 项，双向一致**。

## 四、门与提交后

- 提交：功能提交 **`af496d7`**；提交后实测见 `EV-180-post-commit.txt`。
- `git status --porcelain`：提交前 **25 行（全部已暂存、0 未暂存/未跟踪）** → 提交后 **0 行**。
- **23 道门（提交前，最终树）全绿**（逐门原始行见 `EV-180-post-commit.txt` §五）：`coverage` 9/9、`plugins` 5/5、
  `webui` 51/51、`modules` 521/521、`wiring` 5/5、`invariants` 22/22、`storage` 19/19、`plugin-assets` 16/16、
  `plugin-requirements` 18/18、`plugin-lifecycle` 66/66、`evolve-module` 61/61、`run-once` 34/34、
  **`g1` 绿**（走查 14/14）、`approval-digest`/`budget-guard`/`supplier-scorecard` 各 10/10、
  `plugin-market`/`pipeline-view` 各 13/13、`retention-view` 12/12、`p0-no-node`（63 条 AC 无 Node 全绿）；
  `docs`、`ac-registry`、`events`、`evolution` 四门 rc=0 / PASS。
- **提交后**：`run-clone` **20/20**、`clean-copy` **PASS**（15 道门在干净副本里全绿）、`git status` **0 行**、
  push 后 `git ls-remote` 回读与本地一致（逐字见 `EV-180-post-commit.txt`）。
