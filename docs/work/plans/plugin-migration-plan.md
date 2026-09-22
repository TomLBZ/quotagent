# 插件化迁移计划（分阶段、逐文件、每阶段可单独提交与验证）

<!-- budget: 32 KB（docs/work/plans/*.md 行，本批新增）。逐文件映射表在 plugin-file-map.md。 -->

**本批只落规范与计划，不动任何代码/门/测试**（铁律）。本页是执行清单：目标结构、阶段划分、每阶段的验收命令、风险点与对账口径。
规则真源：`docs/design/27-plugin-architecture.md`（架构与目录规范）、`docs/design/28-plugin-requirements-and-run.md`（需求归属 + 一键运行契约）；
决策：ADR-0020、ADR-0021。

## 1. 目标结构

```
src/
  system/<plugin>/     # 34 个：kernel kernel-bridge runtime repo-gate qa-runner norm measures realm approval
                       #         mail relay retention eval evidence evolution canary market config admin storage
                       #         projection governor audit-hook observability timeline circuit-breaker budget-guard
                       #         idempotency-guard ops-view pipeline-view user-plugin-manager ui-feedback webui
  domain/<plugin>/     # 25 个：rfq rfq-deadline sourcing intake compare guard costmodel pricing quotes commitments
                       #         deviation capacity change clarify faq negotiation sync terms export
                       #         gate-timeline authority-band advice bid-heuristics supplier-scorecard price-history
                       #         （+ 在飞 quote-prepare）
  userspace/<ns>/<plugin>/   # 用户动态开发；运行时根（沿用 user-space/ 的 gitignore 语义）
tools/                 # 只留 5 个薄入口：verify.sh run.sh runtime.sh bootstrap.sh cordis.sh（+ 计划新增 plugin.sh）
docs/                  # 位置不变（本批新增 27/28/ADR-0020/0021/本计划/映射表/事实源落点表）
```
每个插件内部的完备形态（`plugin.json` + `README.md` + `requirements/` + `docs/` + `code/` + `tools/` + `tests/` + `data/`）见 27 §2.1。

## 2. 阶段划分（每阶段 = 一次可独立提交、可独立回读的批次）

### 阶段 0 —— 规范与骨架（无行为变更）

| # | 内容 | 验收 |
|---|---|---|
| 0.1 | 本批文档：`27`/`28`/ADR-0020/ADR-0021/本计划/`plugin-file-map.md`/`spec-persistence.md` | `tools/verify.sh docs` 绿（含预算表新增的 `docs/work/plans/*.md`、`src/{system,domain}/*/docs/*.md` 两行） |
| 0.2 | 建空骨架目录 `src/system/<plugin>/`、`src/domain/<plugin>/`、`src/userspace/`，每目录只放 `README.md`（一句话职责）+ `plugin.json`（27 §3.1 必填字段） | 新增 `tools/plugin.sh list --json` 能枚举（`plugins` 门扩到三层：目录 ↔ 清单 ↔ 矩阵） |
| 0.3 | Python 包名守卫：断言 `importlib.util.find_spec("system"/"domain"/"userspace")` 在目标解释器上仍为 `None`，且 `PYTHONPATH=src` 时 `import system.kernel` 可用 | 新增一条 AC（`qa ac`）与一条围栏门；在 Python 3.13 上实测三项均为 `None`（本批已量，见 27 §9 未决 1） |
| 0.4 | `.gitignore` 同步：`user-space/` → `src/userspace/` 的运行时根；确认 `/lib/` 规则不吞 `src/system/*/lib`（该规则只匹配仓库根） | `git status --porcelain` 在骨架提交后为空 |
| 0.5 | 预算表路径同步（12 文档标准 §1）：加 `docs/work/plans/*.md`(32 KB)、`src/{system,domain}/*/docs/*.md`(16 KB)；阶段 4 再改 `host/*.md` 行 | `tools/verify.sh docs` 的"受检文件数"随迁移单调变化，且没有"新目录逃出预算" |

**为什么 0.2 先建空壳**：`load/reload/unload` 需要一个稳定的清单来源；先有清单与枚举，后续每搬一个插件都能立刻被 `list` 看见（进度可机检）。

### 阶段 1 —— 叶子先搬：`tools/**` 与 `src/quotagent/qa/**`（不动被检查的代码）

理由：门名是接口（`tools/verify.sh <门>`），实现路径是内部细节；先搬实现，能验证"门名不变"这条纪律本身。

| # | 内容 | 验收 |
|---|---|---|
| 1.1 | `tools/check-*.py|sh`、`tools/g1-walkthrough.py`、`tools/v-kit.sh`、`tools/manual-check.py` → `src/system/{repo-gate,<plugin>}/tests/`（逐文件见映射表） | `tools/verify.sh all` 全绿；门名集合逐字不变（§5 R-2 的对比脚本） |
| 1.2 | 落账本/落盘工具（`config-apply.py`、`gate-nudge.py`、`rfq-promise.py`、`quote-draft.py`、`quote-sign.py`、`ui-feedback-apply.py`、`userplugin-*.py`、`admin-apply.py`、`evolve-record.py`、`refresh-*.py`）→ 各插件 `tools/`，**唯一写者身份随行**（`plugin.json.permissions.ledger`） | 写路径门（`config-route`/`gates`/`rfq-deadline`/`quote-draft`/`ui-feedback`/`user-space`）逐条真跑真回读 |
| 1.3 | `src/quotagent/qa/checks_*.py` → 各插件 `tests/`；`registry.py`/`__main__.py`/`__init__.py` → `src/system/qa-runner/` | `tools/verify.sh ac <AC-ID>` 抽查 ≥ 10 条跨插件 AC；`tools/verify.sh g1` 绿 |
| 1.4 | `tools/verify.sh` 的 `case` 分支里的实现路径改为新路径（**门名一个都不改**） | `tools/verify.sh help` 输出的门名集合 == 迁移前快照（逐字节） |

### 阶段 2 —— `src/quotagent/services/**` → `src/{system,domain}/<plugin>/code/`

| # | 内容 | 验收 |
|---|---|---|
| 2.1 | 17 个 domain 服务先搬（`rfq`/`intake`/`compare`/…），每个搬完立刻跑它自己的 AC | 该插件 `requirements/README.md` 的验收命令逐条真跑 |
| 2.2 | 13 个 system 服务后搬（`norm`/`measures`/`realm`/`approval`/`mail`/`relay`/`retention`/`eval`/`admin`） | `tools/verify.sh ac` 全量 + `tools/verify.sh bridge` |
| 2.3 | 合并类拆分：`mail.py` + `mail_transport.py` 同插件；`retention.py` + `retention_exec.py` 同插件；`evaldata.py`/`evalmetrics.py`/`scenarios.py` → `system/eval` | 相关 AC 与 `coverage` 矩阵的承载体列同步 |

### 阶段 3 —— 内核与运行时（冻结面，最后搬）

| # | 内容 | 验收 |
|---|---|---|
| 3.1 | `src/quotagent/kernel/**` → `src/system/kernel/code/`（含 `plugin.py`） | `tools/verify.sh events`、`invariants`、`ac-registry`、`p0-no-node` |
| 3.2 | `bridge.py` → `src/system/kernel-bridge/code/`；`paths.py`/`__init__.py` → `src/system/runtime/code/`；`g1side.py` → `src/system/repo-gate/` | `tools/verify.sh bridge`、`cordis`、`g1` |

**为什么最后搬内核**：内核被全部插件 import（`FR-LEDGER-*`/`FR-EVT-*`/`FR-QEP-*` 的承载体），先搬它等于一次改所有引用；冻结面（ADR-0002）改动最小化。

### 阶段 4 —— `host/**` → 插件目录（宿主侧）

| # | 内容 | 验收 |
|---|---|---|
| 4.1 | `host/modules/<stem>.mjs` → `src/{system,domain}/<plugin>/code/`；`host/modules/index.mjs` → `src/system/runtime/code/plugin-index.mjs`（"目录即清单"需改成按层扫描） | `tools/verify.sh modules`（fixture A1..A6 全量）、`wiring`、`plugins` |
| 4.2 | `host/lib/*.mjs` → 使用它的插件目录（`bridge.mjs`/`supervisor.mjs`→kernel-bridge；`config*.mjs`/`schema*.mjs`/`frozen.mjs`→config/kernel；`canary*.mjs`→canary；`evolution.mjs`→evolution；`user-space.mjs`→user-plugin-manager；`ledger-view.mjs`→kernel） | `cordis`、`modules`、`config-route`、`user-space`、`evolution` |
| 4.3 | 围栏门 `host/<plugin>.mjs` 与 `host/t2NN-*-gate.mjs` → 各插件 `tests/` | 每个宿主门的命令逐条真跑（`verify.sh` 门名不变） |
| 4.4 | `host/{package.json,package-lock.json,README.md,smoke.mjs,cli.mjs,profiles.mjs}` → `src/system/runtime/`；`node_modules` 位置随之迁移；`tools/cordis.sh` 的 `$ROOT/host` 改指新位置 | `tools/cordis.sh install|smoke`；`tools/verify.sh cordis`；`.gitignore` 的 `node_modules/` 规则仍覆盖 |
| 4.5 | `host/CONFIG.md` → `src/system/config/`；预算表 `host/*.md` 行改为新路径行 | `tools/verify.sh docs` |

### 阶段 5 —— 用户空间、一键运行、注入式 UI（用户可见的三件事）

| # | 内容 | 验收 |
|---|---|---|
| 5.1 | `user-space/**` → `src/userspace/**` + gitignore 语义确定（运行时根忽略 + 跟踪 `EXAMPLE/`，见 27 §9 未决 2） | `tools/verify.sh user-space`、`plugin-market` |
| 5.2 | `tools/plugin.sh` 六动词（27 §4）在 system/domain 上真可达：`list/status/deps` 先做，`load/reload/unload` 后做 | 新增门 `plugins-lifecycle`（含负控：未装载卸载 ⇒ `not-loaded`；卸载后 effects 归零） |
| 5.3 | **注入式 UI 契约**落地：`webui` 改为槽位 + 注册表；把 8 个业务插件的区块/路由/载荷装配从 `webui.mjs` 移回各自插件 | `webui` 门新增四条（27 §6.3）；卸载一个业务插件后其路由消失、页面其余部分逐字节不变 |
| 5.4 | **一键运行契约**实现：`./run up|down|status|logs|doctor|config init`（契约原文见 28 §3.1） | 新增门 `run-once`：清洁副本 + 空 HOME + 断网跑 `./run up` ⇒ `/healthz` 200、`down` 释放端口、二次 `up` 幂等 |
| 5.5 | 判据 A7（需求归属合法性）+ 覆盖矩阵"承载体"列由文件路径改为插件 id（源文件进证据列） | `tools/verify.sh coverage`（A1–A7） |

依赖序：5.3 依赖 4.x（webui 与业务插件都已在新位置）；5.4 依赖 4.4（宿主入口新位置）；5.2 依赖 0.2（清单）与 4.1。

## 3. 复算与对账（迁移前后必须逐字节一致或逐条可解释）

```bash
# 门名集合快照（前后对比，必须逐字相同）
tools/verify.sh help | sed -n '2p' > tmp/gate-names.before     # 迁移前
tools/verify.sh help | sed -n '2p' > tmp/gate-names.after      # 迁移后
diff tmp/gate-names.before tmp/gate-names.after                # 期望：无输出

# 逐文件映射的可复算性（本批实测：256 个路径 → 251 迁移 + 5 保留，未映射 0）
git ls-files src host tools user-space | wc -l                 # 本批：250（+ user-space 磁盘 6 = 256）

# 定义集合规模（迁移不得改变任何一条需求）
grep -chE '^\| FR-' docs/work/functional-requirements*md | paste -sd+ | bc   # 165
grep -chE '^\| AC-' docs/work/acceptance-criteria*md | paste -sd+ | bc       # 133
```

**搬运方式**：一律 `git mv`（保留 `git log --follow` 可追溯），禁止 `rm` + 新建；一次提交只搬一个插件或一个阶段的一个子项。

## 4. 每阶段的通用完成条件

1. `tools/verify.sh all` 全绿（含 12 道既有门）；
2. 门名集合逐字不变（§3）；
3. 该阶段涉及的 AC **逐条真跑**（不接受"以前绿过"）；
4. 文档引用更新（`docs/**` 里的路径引用、`docs/design/14-plugin-inventory.md` 的模块清单行、`15-requirements-coverage.md` 的承载体列）；
5. `docs/work/progress-checklist.md` 加行 + `docs/work/evidence/EV-1xx-*.txt` 留原始输出；
6. 只 `git add` 本阶段改的文件；commit 信息写清阶段号；push 后 `git ls-remote` 回读。

## 5. 风险点（按危险度排序，逐条给缓解与判据）

| # | 风险 | 具体位置（本批实测） | 缓解 / 判据 |
|---|---|---|---|
| R-1 | **路径引用大面积失效**：文档与门里以路径为断言的地方（3022 处 ID 引用 + 大量文件路径） | `docs/design/15-requirements-coverage.md` 的"承载体"列、`14-plugin-inventory.md` 的"只改本文件"列、各 `tests/` 脚本里的相对路径 | 承载体列在阶段 5.5 改为插件 id；阶段内用脚本列出"引用了被搬路径的文件"清单，逐条核对 |
| R-2 | **门与脚本里的硬编码路径** | `tools/verify.sh`（`$ROOT/host/...`、`python3 tools/check-*.py`）、`tools/cordis.sh`（`$ROOT/host`）、`tools/run.sh`（`PYTHONPATH=src`）、`tools/bootstrap.sh`（`$VENV`）、`tools/check-clean-copy.py` | 门名不变 + 每阶段跑 `verify.sh all`；`cordis.sh` 与 `verify.sh` 的 `HOST=`/路径变量改为单一常量 |
| R-3 | **`verify.sh` 子命令改名**（等于砸掉所有人的入口） | `tools/verify.sh` 的 `case` 分支（本批实测 66 个门名） | §3 的门名快照对比，逐字节；任何门名变更必须走 ADR |
| R-4 | **Python 包名与 `PYTHONPATH` 变化** | `src/system`/`src/domain` 作为顶层包；`tools/run.sh` 的 `PYTHONPATH=src` | 阶段 0.3 的守卫测试；已在 Python 3.13 实测 `find_spec` 无冲突 |
| R-5 | **运行期数据根被"顺路"搬动** ⇒ 历史账本读不到 | 账本目录、`tmp/`、`host-root`、`user-space/<ns>/<plugin>/data/` | 硬规则：**迁移只搬代码，不搬数据根**；数据根路径由配置给出，禁止在代码里硬编码新路径 |
| R-6 | **`.gitignore` 与预算表漂移**（曾发生：`lib/` 规则吞掉 `host/lib/*.mjs`；`tmp/**` 混进文档门判据） | `.gitignore`（`/lib/`、`tmp/`、`user-space/`）、`docs/design/12-documentation-standard.md` §1 预算表 | 阶段 0.4/0.5 逐条同步；文档门"受检文件数"与"预算行数"一起看 |
| R-7 | **在飞批次与本阶段冲突**（同一工作树） | 本批实测工作树里有未提交的在飞文件（`quote-prepare` 等 8 个源文件） | 每阶段开始前 `git status --porcelain` 必须只剩本阶段文件；有在飞批次时先隔离（worktree/stash），不并行改同一路径 |
| R-8 | **`host/t*-gate.mjs` 与 `host/<plugin>.mjs` 同位重名** 搬进 `tests/` 后重名 | 例如 `canary.mjs`/`canary-dispatch.mjs`/`bridge-canary.mjs` 同归 canary | 文件名保持原样（同名不同命，脚本用全名调用）；搬完逐个真跑 |
| R-9 | **门与被围对象同目录后的独立性**（"门不能由被围对象自己写"靠什么机检） | 全部 `tests/` 门 | 阶段 0.2/5.5 登记为待设计项（`T-312` 子项）；过渡期靠 `clean-copy` 门 + 评审 |
| R-10 | **`host/modules/index.mjs` 的"目录即清单"在分层后失效** | 它现在只扫平铺的 `host/modules/` | 阶段 4.1 改为按 `src/{system,domain}/*/plugin.json` 扫描；`plugins` 门的双向断言扩到三层 |

## 6. 与既有文档/门的配合（不得重复造）

| 事项 | 真源 | 本计划怎么用 |
|---|---|---|
| 模块清单 | `docs/design/14-plugin-inventory.md`（`tools/verify.sh plugins`） | 每搬一个模块，改它的行与"独立演进时改哪里"列 |
| 需求归属 | `docs/design/15-requirements-coverage.md`（`tools/verify.sh coverage`） | 阶段 5.5 把承载体列改为插件 id |
| 桥协议 | `docs/design/13-cordis-bridge.md` | 阶段 3/4 搬桥与宿主时按它核对 |
| 用户空间隔离 | `docs/design/22-plugin-market-and-user-space.md` | 阶段 5.1/5.2 的契约不变，只搬路径 |
| 事实源落点 | `docs/work/plans/spec-persistence.md`（本批新增） | 规格类散件已落到哪、还剩什么缺口，逐条可查 |
| 一键运行 | `docs/work/deployment-manual.md` | 阶段 5.4 实现后同步部署手册的命令面 |
