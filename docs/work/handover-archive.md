# 交接归档（主文件在 `handover.md`）

<!-- budget: 32 KB（同受 `docs/design/12-documentation-standard.md` §1 的 `docs/work/*.md` 约束） -->

**为什么有这一份**：`docs/work/handover.md` 的预算是 **1024 B**（`12-documentation-standard.md` §1），逐批细节
写进主文件会立刻超预算。机制与 FR/AC/T/清单/矩阵**同一套**：主文件 + 本归档 = **交接文档集合**，门
`tools/verify.sh docs` 读集合，并断言主文件里的每个 `§N` 指针在本文件里有**对应小节且小节非空**
（抽掉小节的标题行 ⇒ 门必红）。**细节逐字搬到这里，不删事实**；主文件只留「现在在哪 / 下一步唯一动作 / 不变量」。

## 1 本批（`EV-180`/`T-330`）：最后两个真遗留 + 收尾

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

## 2 上一批（`EV-179`/`T-329`）：清遗留红 + 收尾

- ① 6 道围栅门（approval-digest / budget-guard / supplier-scorecard / plugin-market / pipeline-view / retention-view）
  改为**跟重导链读到真实体**（断言条数一格未减；反向 6/6 必红 + 链上一跳被偷改也红）。
- ② `tools/**` 非薄入口再搬 **10** 项（13 → 3；旧处 `runpy` 薄转发；先改读方 20 处）。
- ③ 补承载 **4**（compare / kernel-bridge / qa-runner / repo-gate）⇒ **57/63**。
- ④ 历史引用清账（14 / 15 / 映射表 / 偏差表 / 文件地图 → 事实路径；14-archive 标「已归位」）。

## 3 更早批次

逐批的原始证据与结论在 `docs/work/evidence/`（索引：`INDEX.md` / `INDEX-P2.md` / `INDEX-P2-archive*.md`）；任务行与
状态在 `docs/work/progress-checklist.md`（较早的行在 `progress-checklist-archive.md`）。
