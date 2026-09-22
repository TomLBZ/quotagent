# 12 文档标准（写入前先读这一页）

<!-- budget: 10 KB. 本页定义预算、ID 体系与写作规则；规则真源仍是 AGENTS.md -->

## 1. 预算（硬）

| 文件 | 预算 |
|---|---|
| `AGENTS.md` | 4096 B |
| `README.md` | 4096 B |
| `docs/work/handover.md` | 1024 B |
| `docs/design/00-overview.md` | 16 KB |
| `docs/design/*.md` | 28 KB |
| `docs/analysis/*.md` | 24 KB |
| `docs/design/adr/*.md` | 8 KB |
| `docs/work/*.md` | 32 KB |
| `docs/work/plans/*.md` | 48 KB |
| `docs/work/plans/plugin-migration-plan.md` | 32 KB |
| `docs/work/plans/spec-persistence.md` | 32 KB |
| `docs/work/plans/ui-workflow-rework.md` | 32 KB |
| `docs/work/plans/ui-workflow-rework-part2.md` | 32 KB |
| `docs/work/plans/ui-workflow-rework-part3.md` | 32 KB |
| `src/*/*/README.md` | 4 KB |
| `src/*/*/docs/*.md` | 16 KB |
| `src/*/*/requirements/*.md` | 16 KB |
| `docs/work/validation/*.md` | 16 KB |
| `docs/work/reviews/*.md` | 16 KB |
| `docs/work/validation/templates/*.md` | 8 KB |
| `docs/work/evidence/*.md` | 8 KB |
| `host/*.md` | 4 KB |
| `.agents/skills/*/SKILL.md` | 8 KB |
| `.agents/skills/*/references/*.md` | 8 KB |

超预算时的处理顺序：**删重复 → 删叙述 → 拆文件 → 才考虑提高预算**（提高预算需在提交信息里说明）。

预算表新增行（2026-09-22 架构规范批次）：`docs/work/plans/*.md`、`src/*/*/README.md`、`src/*/*/docs/*.md`、`src/*/*/requirements/*.md`。
理由：`docs/work/plans/` 此前**没有任何预算行**（`docs/work/*.md` 只匹配该层，不匹配子目录）= 门的盲区；插件子目录是本批新增的目录族，
必须在**第一次写入之前**就有预算行，否则"新目录逃出预算"就是把门改松。规则见 `docs/design/27-plugin-architecture.md` §2.1。

**预算表调整（2026-09-22 迁移阶段 4.1 批次，唯一一次放宽，逐条可复核）**：`docs/work/plans/*.md` 行 **32 KB → 48 KB**，
因为 `plugin-file-map.md` 追加了「分类」章节（143 行逐项分类表 + 8 行搬迁示范表，见该文件 §分类）。
**放宽面被钉死**：`docs/work/plans/` 下既有 5 个文件各加一条**具体路径**预算行（32 KB）—— 门的取法是
`effective = min(通配行, 具体行)`（`tools/check-docs.py` `check_budgets`），**具体行只能收紧不能放宽**，
所以本次放宽**只对 `plugin-file-map.md` 与将来新加的文件生效**，既有 5 个文件的预算一格未松（实测占用均 ≤ 27 KB）。
今后不再以"表更长了"为由放宽：超预算仍按上面的删除顺序处理。

**门的扫描范围（D-072）= 契约文档集合**：全仓 `.md` 减去 `.git/ .venv/ tmp/ node_modules/ __pycache__/`
下的临时/派生文件。临时副本（`tmp/ac/**`、`tmp/clean-copy/**` 这类整树副本）**不是判据**；
契约文档在读窗口里消失仍判红（不跳过）。

## 2. ID 体系（跨文档引用必须用 ID，不用页码或"前面提到"）

| 前缀 | 含义 | 定义处 |
|---|---|---|
`FR-<域>-<NNN>` | 功能需求 | `docs/work/functional-requirements.md` + 同目录 `functional-requirements-archive*.md`（主文件 + 归档 = 门的 FR 定义集合；归档不豁免任何断言；`V-` 只认主文件） |
`AC-<域>-<NNN>` | 验收标准（含可执行命令） | `docs/work/acceptance-criteria.md` + 同目录 `acceptance-criteria-archive*.md`（主文件 + 归档 = 门的 AC 定义集合；归档不豁免任何断言） |
`T-<NNN>` | 实现任务 | `docs/work/progress-checklist.md` + 同目录 `progress-checklist-archive*.md`（主文件 + 归档 = 门的 T 定义集合；归档不豁免任何断言） |
`V-<NNN>` | 待现场验证的假设 | `docs/work/functional-requirements.md` §验证清单 |
`INV-<NNN>` | 系统不变量（可机检断言） | `docs/design/04-services-catalog.md` §6 |
`ADR-<NNNN>` | 架构决策 | `docs/design/adr/` |
`EV-<NNN>` | 证据条目 | `docs/work/evidence/` |
`NFR-<域>-<NNN>` | 非功能需求 | `docs/design/10-nonfunctional.md` |

引用一律写 ID 或相对路径链接（可机检），不写"见上文"。

**归档集合（口径，唯一真源是各门脚本里的常量）**：下表之外还有三处"文档集合 = 主文件 + 同目录 `*-archive*.md`"——
`docs/design/14-plugin-inventory.md` + `14-plugin-inventory-archive*.md`（门 `tools/verify.sh plugins`）、
`docs/design/15-requirements-coverage.md` + `15-requirements-coverage-archive*.md`（门 `tools/verify.sh coverage`）、
`docs/work/handover.md` + `handover-archive*.md`（门 `tools/verify.sh docs`；这是一个**指针型**集合：判据是主文件里
每个 `§N` 指针在归档里有**对应小节且小节非空**）。集合内的归档**不是豁免区**：搬进去的行受同一套断言约束，
"归档 0 条定义行 / 0 节"是硬失败。**超预算时的减法顺序**：删重复 → 删叙述 → 拆到归档 → 才考虑提高预算
（提高预算需在提交信息里说明，且既有文件的**具体路径**预算行只能收紧不能放宽）。

**用户诉求的落点**（本仓不靠"记住"）：用户原话对应的需求 = `docs/work/functional-requirements.md` §6.1 的
`FR-USREQ-<NNN>` 行（每行含**原话短引 + 可验收含义 + 验收方式**），其 需求→实现→证据 状态表在
`docs/work/requirements-traceability.md`（状态只能 `done`/`partial`/`missing`，且必须有证据列支撑）。

## 3. 写作规则

1. **一处一事实**：同一事实只在一处定义，其余位置用链接或 ID 引用。
2. **标注来源**：代码路径（含行号）、论文/规范、`[二手]`（未经核实的二手信息）、
   `[假设]`（待现场验证）、`[推断]`（由已知推出的推测）。无标注的断言视为缺陷。
3. **不写叙事**：不记录评审过程、不写"我们曾考虑"，决策理由进 ADR。
4. **具体名词优先**：写"报价版本与包版本不一致时拒绝进入比价"，不写"保证一致性问题得到处理"。
5. **表格优先于清单**：本仓库的读者包含 agent，表格更易被机器解析。
6. **不用装饰性符号**：不要 emoji、不要 ASCII 艺术、不要"!!!"。
7. **一段一行**（物理行即段落），便于 diff 与机器解析。

## 4. 设计记录（何时写 ADR）

必须写 ADR 的情况（AGENTS.md 规则 8）：协议格式、账本事件语义、内核边界、信任模型、
自进化可写面、实现栈选择。

不必写：纯文档措辞调整、任务状态更新、场景数据补充。

ADR 状态取值：`proposed` / `accepted` / `superseded by ADR-NNNN`。
**superseded 不得原地改语义**：新写一条 ADR 并在旧条目头行标注。

## 5. Agent 维护检查清单（提交前自查）

- [ ] 引用的 ID 都存在（`FR`/`AC`/`T`/`ADR`/`INV`）
- [ ] 新增事实都有来源标注或 `[假设]` 标记
- [ ] 文件未超预算
- [ ] 改动涉及协议/账本/内核 → 已写 ADR
- [ ] 本轮工作已更新 `progress-checklist` 与 `handover`
- [ ] 已 commit 并 push，且读回远端 refs 确认
