# 交接归档（主文件在 `handover.md`）

<!-- budget: 32 KB（同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

**为什么有这一份**：`docs/work/handover.md` 的预算是 **1024 B**（`12-documentation-standard.md` §1），逐批细节
写进主文件会立刻超预算。机制与 FR/AC/T/清单/矩阵**同一套**：主文件 + 本归档 = **交接文档集合**，门
`tools/verify.sh docs` 读集合，并断言主文件里的每个 `§N` 指针在本文件里有**对应小节且小节非空**
（抽掉小节的标题行 ⇒ 门必红）。**细节逐字搬到这里，不删事实**；主文件只留「现在在哪 / 下一步唯一动作 / 不变量」。

## 0 WebUI 口径纠正（用户 2026-09-22 指令，`D-086`）

用户明确指出：WebUI **不是**账本投影、**不是**只读路由、**不是**只提供注册面的说明书，而是**完整的 GUI 应用**
（类比 VS Code / DeepSeek harness 的 GUI）；插件通过注册**UI 元素 / 交互方式 / 动作与命令 / 业务逻辑钩子 /
通知与状态**贡献**任意功能**；**验收标准 = 承包商与供应商仅通过 GUI 走完全部业务流程（含写操作）**；
允许前端框架。现状（像说明书、只有查询功能）被判定为失败：用户没有理由用它而不是 Teams。
同时明确：**推进真实业务功能是唯一重要的事**，门禁/测试只是安全带，与需求冲突或只冻旧形态的测试与门
**直接删除**（存在不等于合理），不得为「门全绿」牺牲功能推进。

落地：`AGENTS.md` §11/§12 · `docs/design/29-webui-gui-app.md`（定义/禁止/架构/双方流程/路线/验收）·
`27 §6`、`14-archive`、`src/system/webui/requirements/README.md` 改指 29 · 旧判据（UI 快照门 / seed 门 /
ui-mutate 门 /「三块锚点 + 0 JS」式 AC）按 29 §2 删除。提交 `80865ae`。

## 1 本批（`EV-181`）：干净副本 3 条真红 + 7 个 `entry` 收口 + 可移植性扫描

① **干净副本 3 条真红**（`AC-AGENTRT-002/006/007`）：根因**不是**判据，而是**宿主依赖** —— 三条 AC 的围栏门
`t275-runtime-gate.mjs`（实体在 `src/system/agent-runtime/tests/`）`import` 宿主的 `cordis`，解析到 gitignored 的
`host/node_modules/cordis/lib/index.js`；`git archive HEAD` 的干净副本里它不存在 ⇒ `ERR_MODULE_NOT_FOUND`、rc=1
（工作树里装过依赖所以看着绿）。最小复现：fresh 副本里 `tools/run.sh -m quotagent.qa all` ⇒ `82/85`，红的三条是
AGENTRT；跑完 `ls -d host/node_modules` **已存在**（靠后的 `AC-INTEG-*` 走 `cordis.sh run` 顺手装上了）——
「单独重跑就绿」正是**顺序**造成的。修法：三条 AC 真跑门一律走 `tools/cordis.sh run t275-runtime-gate.mjs`
（幂等 `install_deps`；`checks_bridge`/`check-webui.py`/`check-canary.py` 早就是这套约定），**判据一格未改**
（仍是 `failures:0` 且断言数 ≥22）。实测：干净副本（无 `node_modules`）三条绿；把修复还原成裸 `node <实体>`
⇒ 三条必红。原始行见 `EV-181-raw.txt`。

② **7 个多实体插件收口 ⇒ `63/63 valid`**：`system/{webui,mail}` 入口重导出**唯一自述服务的实体**；
`system/{admin,agent-runtime,canary}` 是**机制组合**入口（按序把平级成员插件交给宿主，零业务语义零写面）；
`system/{eval,kernel}` 用 **Python 承载入口** `code/__init__.py`（宿主侧 0 个 ESM 服务实体，造 `index.mjs` 只能是
空壳）。逐条理由与被否决的选项 = `decisions.md` 的 `D-078`..`D-084`。**门侧替代锚点（必做，否则等于放宽门）**：
`plugin-lifecycle` 的 `A13/A14` 原本以「真根上 `system/webui` **未迁移**」这个**状态事实**为锚 —— 接上入口后
必须改指：真根改判**正控**（`closure==['system/webui']`、`missing_targets==[]`、`deps_ready==true`），
「目标无效 ⇒ 不算就绪 + 非激活不崩」搬到**对照根**上用**真实 id + 真实清单字节**重造（`A13b/A14b`：清单合法、
入口文件不存在 ⇒ `artifact-missing`）⇒ 断言 **66 → 68**（只增不减）。**变异 6 没有失去对照**（它跑在夹具根上、
自己造 invalid 目标，与真根无关；实测仍 `[ok]`）。

③ **硬编码路径扫描**（全仓 tracked 码/配置面，142 处命中，三类：部署挂载点（合法，均有 env 覆盖）/
`tmp` 夹具（合法）/ **checkout 根字面量**）：**4 处真缺陷已修**（`tools/manual-check.py`、
`src/system/webui/tools/mutate-ui-views.py`、`src/system/ui-feedback/tools/ui-feedback-{monitor,tick}.sh` ——
全部改成「由本文件位置上溯推出 + env 仍可覆盖」）。门侧：`plugin-assets` 的 **PA9** 扫描面补上
**没有扩展名的根入口 `run`**（`**/*.sh` 的盲区，而它正是「克隆即跑」的第一层），新增 **PA9b 扫描面自证**
（逐条点名必扫文件，漏一个即红）与 **F9**（往 `run` 里写死仓库根 ⇒ PA9 必红）；门 20/20。
⚠ 归属：4 处修复与 PA9 本体由**并发写入者**（同一工作树里的另一 subagent）先落盘，本 agent 复核 + 追加
PA9b/F9；本批「产品树字节不变」类的自证因此有一处**不成立**（对方在验证窗口里改写了
`src/system/webui/code/index.mjs`），如实记录在 `EV-181-raw.txt`。

## 2 上一批（`EV-180`/`T-330`）：最后两个真遗留 + 收尾

① **`g1` 全链真缺陷**：`tools/audit-verify.py` 在 HEAD 里是 `100644` 且**无 shebang**，而 `AC-AUDIT-004`
（`src/system/evidence/tests/checks_audit.py` 三处 `subprocess.run([str(REPO_ROOT / "tools" / "audit-verify.py"), …])`）
把它当 argv[0] **直接 exec** —— 工作树里 `OSError: [Errno 8] Exec format error`，新克隆里是权限拒绝。修法：加
shebang + **在索引里**置 `100755`（`git add --chmod=+x`；只 chmod 工作树不进仓库 ⇒ 无效）。实测：`git archive HEAD`
干净副本里修前 `tools/verify.sh g1` 红（`Exec format error`）、修后绿。

② **文档预算**（四份都到硬预算边缘）：15 覆盖矩阵 4 B、14 插件清单 41 B、进度清单 23 B、handover 11 B。按归档
机制**先门后搬行**：① 覆盖矩阵先给门加"文档集合 + 归档非空"（`check-fr-coverage.py`：主文件 +
`15-requirements-coverage-archive*.md`，小节取**并集**；新增 A0 与"删归档行必红"的内建负控）② 14 / 进度清单 /
handover 各自的集合机制照旧（14 与清单的集合早已存在，handover 的集合是本批新增的断言）。搬行一律**整行逐字**，
每个归档都做**反向验证**（抽掉归档里一行 ⇒ 门必红）。

③ **`tools/**` 非薄入口 3 → 1**：`netblock.c`（→ `src/system/runtime/tests/`）与 `v-kit.sh`
（→ `src/system/repo-gate/tools/`）整份搬走、旧处只留薄转发；`manual-check.py` **不搬**（契约面 0 调用者 ⇒
搬了就是孤儿，`plugin-assets` 的 PA6 会红）。留顶层的名单与理由写在 `docs/work/plans/plugin-file-map.md`。

④ 收尾：23 道门全绿 + 提交后 `run-clone` / `clean-copy`、`EV-180` 证据、清单/交接/state 同步、push 后回读远端。

⑤ **下一步那个"为什么"**：`webui` 接入口会让 `plugin-lifecycle` 的 **A13/A14** 与**变异 6** 失去对照
（`depsClosure` 把"目录存在"当"插件存在"，实测 41/44 → 43/44）；把门改松不是选项，所以必须**人工**定入口。

## 3 上一批（`EV-179`/`T-329`）：清遗留红 + 收尾

- ① 6 道围栅门（approval-digest / budget-guard / supplier-scorecard / plugin-market / pipeline-view / retention-view）
  改为**跟重导链读到真实体**（断言条数一格未减；反向 6/6 必红 + 链上一跳被偷改也红）。
- ② `tools/**` 非薄入口再搬 **10** 项（13 → 3；旧处 `runpy` 薄转发；先改读方 20 处）。
- ③ 补承载 **4**（compare / kernel-bridge / qa-runner / repo-gate）⇒ **57/63**。
- ④ 历史引用清账（14 / 15 / 映射表 / 偏差表 / 文件地图 → 事实路径；14-archive 标「已归位」）。

## 4 更早批次

逐批的原始证据与结论在 `docs/work/evidence/`（索引：`INDEX.md` / `INDEX-P2.md` / `INDEX-P2-archive*.md`）；任务行与
状态在 `docs/work/progress-checklist.md`（较早的行在 `progress-checklist-archive.md`）。
