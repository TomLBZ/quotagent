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

<!-- 本行由批 `EV-176` 逐插件如实登记（机检口径见 `docs/work/plans/plugin-file-map.md` §分类）。 -->

- `code:` **待实现** —— 实现对**已存在**于 `host/modules/`（`evolve-journal.mjs`），本批未给它做入口；`entry` 仍如实报 `degraded: artifact-missing`；**不新造功能**。
