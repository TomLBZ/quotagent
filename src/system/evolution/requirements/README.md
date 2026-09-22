# system/evolution 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/evolution/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-evolution.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

自进化流水线：提案 → 影子重放 → 五条门 → 人工晋升 / 自动回滚（ADR-0016/ADR-0017），
**自进化只能写 `host/modules/`**（内核与服务层不可自改）。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-EVOLVE-001 | 提案结构（target/diff/rationale/expected_effect/risks/rollback_plan） | `tools/verify.sh evolution` |
| FR-EVOLVE-002 | 影子重放与指标对比 | `tools/verify.sh evolution` |
| FR-EVOLVE-003 | 评测门五条同时满足（含人工介入率不上升） | `tools/verify.sh evolution` |
| FR-EVOLVE-004 | 自改范围限制：内核不可 patch；自改附提案 ID | `tools/verify.sh evolution` |
| FR-EVOLVE-006 | 提案失败三次转人工 | `tools/verify.sh evolution` |
| FR-EVOLVE-007 | 自进化流水的**只读归纳**（提案/影子/门两态/晋升/回滚/canary 进出 + 最近事件，只出计数不出正文） | `tools/verify.sh evolve-journal` · `evolve-module` |
| FR-USREQ-010 | 「每个功能模块可独立演进」；cordis 能做的直接用 cordis（不重造） | `tools/verify.sh evolution` · `cordis` · `modules` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `evolution`（门骨架 `host/lib/evolution.mjs`）、`evolveJournal`（只读归纳视图 `host/modules/evolve-journal.mjs`） |
| 依赖 | `system/evidence`（门的证据面）、`system/eval`（指标与反例集，`expected_effect.metric` 固定为 `fixture:module`）、人工门 `system/approval`（晋升必须带 `approval_ref`） |
| 写面 | 唯一产物写者 `host/modules/`（经 `tools/evolve-record.py` 落账本 `evolve/*`）；**不得**改内核与 `src/quotagent/services/**` |
| 门 | `tools/verify.sh evolution`（27 条断言，含 7 条负控）· `evolve-journal` · `evolve-module`（产物哈希追溯）· `cordis` |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| canary 真实路由分流与自动回滚判定 | `system/canary`（`FR-EVOLVE-005`；宿主侧 `host/modules/canary.mjs` + `host/modules/bridge-canary.mjs`） |
| 评测指标与反例集本身 | `system/eval`（`FR-EVAL-001..004`） |
| 人工门（谁能签、签什么） | `system/approval`（`FR-APPROVE-*`） |
| 提案产出的业务插件各自的语义 | 各业务插件（如 `domain/price-history`、`system/ops-view`） |
| 需求归属与 FR 映射 | `system/repo-gate`（`docs/work/plugin-requirements-map.md`） |

## 落地状态（`code/`）

<!-- 本行由批 `EV-177` 登记：入口 + 实体都在本插件 `code/` 下，`plugin.json` 的 `entry` = `code/index.mjs`。 -->

- `code:` **已落地** —— 实体 `code/evolve-journal.mjs`（本批随宿主模块搬迁进 `code/`，**字节守恒**，`evolve-module` 逐字节校验）+
  入口 `code/index.mjs`（只把实体公开面**重导出**：`export *` 的绑定是活的，无业务语义、无写面）。
- `provides:` `evolveJournal`（实体自述的真实服务键；占位键已改写）。
- 实测：`tools/plugin.sh status system/evolution` ⇒ `valid:true`、`reason:null`；`load` 真进口（`effects` 非 0）、`unload` 后 `effects_after:0`。

## 自进化产物的追链（`EV-177`）

本插件的实体 `code/evolve-journal.mjs` 是**自进化产出**（`docs/work/evolution-log.json` 里 `name=evolve-journal` 那条），
`artifact_hash` 钉住它的字节。本批搬迁把 12 个产物搬进各自插件的 `code/`，**同批同步了日志的 `artifact_path` 与
`artifact_hash`**，并提供两件可复跑校验：

- 门形态：`tools/verify.sh evolve-module` ⇒ `check-evolved-module.py` **按日志的 `artifact_path` 读**（缺该字段才回落到
  `host/modules/<name>.mjs`），并把「旧路径只是薄重导」折进原断言（断言条数不变）。
- 独立脚本：`python3 src/system/evolution/tests/check-evolution-log-path.py` —— 日志里**每条记录**的 sha256 与当前实体
  逐字节相等；末行打印 `{"TOTAL": n, "FAIL": 0}`。**反向自证**（改动只写在 `tmp/` 副本里）：把日志指回旧路径 ⇒ 12 条全红；
  把实体翻转一个字节 ⇒ 1 条红。

