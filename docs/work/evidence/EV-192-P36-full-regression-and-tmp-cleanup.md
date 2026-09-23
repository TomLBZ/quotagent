# EV-192 — P36 全量回归（套件 + 逐门 rc + 双岗位走查）与 `tmp/` 清理

<!-- budget: 8 KB。原始输出全在 `tmp/p36-shots/`：`gates{,2}/summary.tsv`（两轮逐门 rc）、`suite{,2}.*`、`wt-*`、`sb-verify{,2}.txt`、
     `tmp-cleanup-plan.json`、`tmp-refs{2,3-cjk}.json`；复跑 `run-gates{,2}.sh`。 -->

判据真源：`AGENTS.md` 规则 11/12、`docs/design/29-webui-gui-app.md` §2/§21、`docs/design/12-documentation-standard.md` §1。
范围：只读回归 + `tmp/` 清理；**不改产品行为、不动 `tools/verify.sh`、不新建门/测试、不 commit**。

## 0 结论

- **套件** `suite s1..s4`：`status=pass`、16/16 断言、`rc=0`（两轮）。
- **逐门 58/59 绿**；红 **3**：`clean-copy`、`evolve-module`、`p0-no-node`；另 `g1` 红（内含 `qa all`）。**无一是清理引入**（§2）。
  全量 AC `qa all` = **81/83**（红：`AC-ADV-001`、`AC-GATE-002`）。
- **双岗位走查**：`verify-identity`（登录 + 两侧 + 人签 + 负控）**49/49 全绿**；沙盘 `seed` 红（`writer-gate-timeout`，P21 引入，§2.4）。
- **清理**：`du -sh tmp` **4.4 G → 183 M**；删 1045 个顶层条目 + `tmp/ac/` 下 1064 个一次性目录；`git status` 行数不变（`tmp/` gitignored）。

## 1 逐门 rc

红：`clean-copy=1`、`evolve-module=1`、`p0-no-node=1`（`g1=1`）；**其余 56 门全 0**（两轮表 = `tmp/p36-shots/gates{,2}/summary.tsv`）。

## 2 红的归因（逐条给反证）

**2.1 `p0-no-node`（⇒ 连带 `clean-copy`）—— 本轮系列引入（P16 `f919a6b`）。**
`AC-ADV-001` 注册断言 `src/domain/advice/tests/checks_adv.py:114` 仍要求实体含 `/advice/`、`/api/advice`、`data-advice-link`
—— P16 已退役的旧只读页（29 §21.1：旧路由 ⇒ 303 → `/app/<view>/`）。反证：
`e6687c3`（P16 前）⇒ `exit 0`、`routes=True`；`f919a6b`（P16）与 HEAD ⇒ `exit 1`、`routes=False`。
并行门已按 §21.5 改判据且不放松（`check-advice-route.py` 的 303+Location+承接面板、`t281` 31/31）——漏的是 **AC 注册那一条**。
`clean-copy` 的失败门清单就是 `['无 Node 下的 P0']`（同根因，非第二缺陷）。

**2.2 `AC-GATE-002` —— 同类，P17 `7bd9756` 引入。**
`src/domain/gate-timeline/tests/checks_gate.py:372` 仍要求 `data-change-detail-link`；该抓手由 P17 删除，而 P17 只改了**路由门**
（`check-change-detail-route.py`/`t283`）。该 AC 其余 7 条断言全绿。

**2.3 `evolve-module` —— 本轮引入（P31/P32 `663a387`）。**
`docs/work/evolution-log.json` 记 `retention-view` = `96a1dda2…`/10158 B；`663a387` 改了
`src/system/retention/code/retention-view.mjs`（→`a1ba5786…`/11283 B）**但没更新记录** ⇒「哈希与产出记录一致」红。
反证：`git show 3a40f56:… | sha256sum` = 记录值。**未擅改产物或记录**（§5）。

**2.4 沙盘 `sandbox.seed` —— 本轮引入（P21/P22 `81e0d02`）。**
HEAD 真跑：`POST sandbox.seed` ⇒ `HTTP 400 · 120.0s · writer-gate-timeout`，第 1 步 `rfq.publish` 未开始、账本零新增，
理由 `另一个写者已经写了 120021ms（排队第 ? 位）`；`tmp/p7-run/webui/writer.queue/` **空且无 `writer.lock`** ⇒ 领票与等待循环看的不是同一队列目录。
反证（archive 快照 + 真服务 + 同一脚本）：`e6687c3`（P21 前）第 1 步 `ok=True +3 行`；`81e0d02` 与 HEAD 第 1 步即红。
⇒ **P21 写者闸门打断沙盘 seed**（29 §11「一键造演示数据」当前不可用）；次要既有红：第 4 步自 P14 起撞乐观并发闸。

## 3 清理

**判据**：被活文档（`src/**`、`docs/design/**`、`docs/work/**`（除 `evidence/`）、`.agents/**`、`tools/**`）引用 = 留；
当前批次证据（`p33-shots/`、`p34-shots/`、`p36-shots/`）+ `README.md` = 留；**派生整树/变异树/旧夹具树/0 消费者一次性产物 = 删**。

- **删 1045 个顶层条目**（名单 = `tmp-cleanup-plan.json`）：`plugin-assets-*` **55 份变异整树**（~4.4 G，最大项）、整树副本（`manual-check/quotagent`、`ss33`）、
  旧夹具与 scratch（`*-run/`、`*-fixture*/`、`p0-no-node.*/`、`*-route/`、`t*-mutant*`）、探针输出（778 个）、旧批次报告草稿（12 个）。
- **删 `tmp/ac/` 下 1064 个一次性目录**（`paths.new_scratch` 纪律是「用完自清」，残留即旧轮次垃圾）。
- **留 407 个顶层条目**：110 个有活消费者（文档点名的可重跑脚本与产地，如 `p26-verify.py`、`p13-shots/ux/shape-test.mjs`、`p18/p19-shots/verify*`、
  `gui-{walkthrough,readback}.py`、`verify-identity.py`、`run-shared/`、`ui-shared/`、`g1-shared/`、`arch-batch/`）+ 当前批次证据 + `README.md`；
  另**留 295 个顶层一次性脚本（1.6 MB，0 活消费者）**——按「保留可重跑脚本」留，**登记为后续可清候选**。
- **删 3 个逐字节副本**（删前 `cmp` 实测 `IDENTICAL`）：`tmp/{ux-双方痛点与交互需求,gui-交互规格,config-凭据UX规格}.md.txt`；
  同步改 `docs/work/plans/spec-persistence.md`（#1/#4/#6 括注、#13、G-5、§4 复核命令）与 `tmp/README.md`。
- **门自带泄漏（已登记，未改门）**：`plugin-assets` 每次跑 `mkdtemp` 造 7 份整树副本**且不清理** ⇒ 每跑一次留 ~75 MB（本轮把两次门跑新造的 2 份也删了）。
- **误删（并发写者）**：同工作树另有 agent 正写 P35（08:09–08:18 持续改动）；清理按 08:06 引用快照执行，删掉它 08:1x 才被引用的
  `tmp/p35-shots/`（233 KB：`make-fixtures.py`/`attachments-probe.py`/`memo-probe.py`/`run-concurrent.py`）⇒ `retention-and-storage.md` 4 条死引用。**本轮不回填**（该文件正被并发编辑）。

## 4 死引用普查（0 消费者 = 除历史 `docs/work/evidence/**` 外无引用）

- **登记不动（`src/**`、`docs/design/**`、`.agents/**` 不在本任务可改面）**：§2.1、§2.2，以及指向已清 tmp 脚本/产物的「复跑」指针 ——
  `retention/tests/checks_retention*.py`、`negotiation/tests/checks_negotiation.py`、`faq/tests/checks_faq.py`、`mail/tests/checks_mail.py`（各自指向已删的 `tmp/*-mutate.py`）、
  `authority-band/code/ui.mjs`（`p16-verify.py`，实体已搬 `tmp/p16-shots/`）、`webui/code/assets/app.css`（`p7-a11y-verify.py`，全仓已无）、  `.agents/skills/…/pitfalls-parallel-agents.md`、`docs/design/15-requirements-coverage.md`（`t251-{fr,plugin}-map.md`）、
  `docs/work/plans/plugin-migration-plan.md`（`gate-names.{before,after}`）、`reviews/agent-review-*.txt`（`decisions/*.md`）、`decisions-archive-b.md`（`g1-shared/contractor/rfq-ops.json`）。
- **按需生成、非死引用**：`tmp/storage/snapshot.json`、`tmp/v-kit/<V-ID>/`、`tmp/scratch/*`、`tmp/ui-shared/*`、`tmp/plugin-runtime/state.json`、`tmp/<门名>-gate/`。
- **0 消费者源文件**：仅 `src/system/webui/tools/gui-{walkthrough,unload}.py`（与 `tmp/` 同名文件逐字节相同 / 仅 2 行 docstring 漂移，文档却指向 `tmp/` 那份）⇒ 登记不动。

## 5 双岗位走查与待裁决

走查：① `bash tmp/verify-identity/run-server.sh` + `tmp/verify-identity.py`（登录 + 双岗位 + 人签 + 负控）⇒ **rc=0、49/49 断言**（`tmp/p36-shots/verify-identity.out`）；
② `gui-walkthrough.py --base …:8391`（旧夹具，不带会话）⇒ 发包/投递/备草稿/比价/面板回读 200 且真落账（两侧 3+2 行），人签步 401 `identity-required`（非流程红）；
③ 沙盘 `p7-sandbox-verify.py` ⇒ **rc=1（11/23）**：§2.4 外，`clear`、0600/0700、真实账本逐字节不变全绿。

待裁决（本轮不动）：1) §2.1/§2.2 两条旧形态断言按 29 §2.3 + 规则 12 应删/改（等价不弱判据已在路由门与 `t281`/`t283`），**改门由主 agent/人决定**；
2) §2.3 产出记录 vs 产物不一致（走自进化流程重记或回退产物）；3) §2.4 查 `app-shell.mjs` 的 `writerGateTicket/Try` 与沙盘 `withSandboxEntry` 是否解析到同一 shared dir；
4) `src/system/webui/tools/gui-*.py` 与 `tmp/` 副本二选一；5) 被误删的 `tmp/p35-shots/`。
