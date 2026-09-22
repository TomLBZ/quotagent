# ADR-0021 需求必须归属到插件（不存在"产品整体"的功能性需求）

Status: accepted

## Problem

本仓的需求自 P0 起以"产品整体"口径写在 `docs/work/functional-requirements.md`：一条 FR 说"系统应当 X"，
而 X 的提供者靠读者去猜。后果可查：

1. `docs/design/15-requirements-coverage.md` 的"承载体"列写的是**文件路径**（`src/quotagent/services/compare.py`），
   不是插件 —— 搬迁一次目录，矩阵的每一行都要重写，且"谁负责"这个问题在文件级没有答案；
2. §4 那张"本次新增的 P2 需求（12 件无归属插件）"表就是症状：12 件插件先实现、后补需求归属；
3. 「每个功能模块可独立演进」无法机检：没有归属，就没有"改这个插件会动到谁的哪些需求"的闭包；
4. 每批实现由 subagent 分头做时，无法按插件切分工作（切分单位是"文件"而不是"插件"）。

用户 2026-09-22 指令（逐字）：
- "整理产品需求，**不存在所谓的『产品整体』的功能性需求。所有功能性需求都应该由某个插件提供**。"
- "可以将需求合理分类，总结成若干系统级或 domain 级插件，然后给**每个插件写独立的需求文档**、让独立的 subagent 实现。"

## Decision

1. **硬规则**：每条功能性需求（`FR-*`）与每条验收标准（`AC-*`）都必须有一个**归属插件**，写作 `层次/插件-id`
   （`system/webui`、`domain/compare`、`userspace/con-a/quote-trend`），并映射到目标路径 `src/<层次>/<插件>/`。
   规则真源：`docs/design/28-plugin-requirements-and-run.md` §1/§2。
2. **归属真源是覆盖矩阵**：`docs/design/15-requirements-coverage.md` 是"需求 ↔ 插件"的机检落点（`tools/verify.sh coverage`）。
   每个插件的需求文档 `src/<层次>/<插件>/requirements/README.md` **只写该插件自己的 FR/AC 与验收命令**，不复制其它插件的内容
   （一处一事实）；矩阵与插件需求文档互为索引。
3. **命名方案**：新家族 = 插件 id 的纯字母大写形式（`compare` → `FR-COMPARE-NNN`；`bid-heuristics` → `FR-VIZ-NNN`，
   见已有 `FR-VIZ-001` 与 `AC-VIZ-001`）。家族名**不带数字**（门只认 `[A-Z]+-\d{3}` 形态，见 `docs/work/plans/ux2-index.json` 的 `naming` 记法与 D-069）。
4. **现有 FR/AC 号不改名，只补归属**（可复核的理由）：改号会同时打断 133 条 AC 的 `FR↔AC` 覆盖、93 条归档 FR 行、
   3022 处 ID 引用与全部 `EV-` 证据的可追溯链；而"缺归属"是**数据缺失**，不是命名错误。因此：
   - 40 个 FR 家族 + 45 个 AC 家族 → 归属插件，逐家族映射表见 28 §2.2/§2.3（覆盖全部 165 条 FR 行与 133 条 AC 行）；
   - 跨插件家族（`FR-INTEG-*`、`FR-RFQ-*`、`FR-RUNTIME-*`、`FR-EVAL-*` 等）逐条拆到具体插件，见 28 §2.4；
   - `FR-USREQ-001..012` 是"用户诉求族"，不新增插件：改由 `docs/work/requirements-traceability.md` 的**插件归属列**逐条指向 `src/<层次>/<插件>/`。
5. **归档与门的配合**：主文件 + `functional-requirements-archive*.md` **同为定义集合**（既有口径，不改）；
   归属行写在覆盖矩阵与插件需求文档里，因此"把一行搬进归档"不改变它的归属，也不需要动门。
6. **待建判据（本批不改门）**：`tools/check-fr-coverage.py` 的 A1–A6 之外需再加一条
   A7「每条 FR/AC 的归属必须是合法插件标识，且该插件目录存在」；本 ADR 只定规则与数据，判据实现登记为 `T-312` 的子项，
   **本批不修改任何门与测试**（铁律）。

## Consequences

- 每批工作可以按插件切分给独立 subagent（切分单位 = `src/<层次>/<插件>/`），"改这个插件"的边界由目录给定。
- `webui` 不再是需求的承载体：`FR-UX-*`/`FR-UXWEB-*` 的归属写 `system/webui`，但业务功能的归属写各自插件，`webui` 只出现在"注册面"上下文里（27 §6）。
- 代价：`15-requirements-coverage.md` 的"承载体"列需要从"文件路径"演进为"插件 id（+ 源文件）"；迁移期两者并存，A2/A5 仍按插件 id 对齐，文件路径退为**证据**列而不是判据。
- `docs/design/14-plugin-inventory.md`（模块清单）与覆盖矩阵（需求清单）是两个不同的真源：前者回答"有哪些插件、被谁装配"，后者回答"每个需求归谁"；两者都以插件 id 为键，可交叉核对。

## How to verify

- `tools/verify.sh coverage`：A1 双向全覆盖（FR 定义集合 ↔ 矩阵）、A2/A5（每个插件有行、且至少归属 1 条 FR/AC）、A3 承载体真实存在、A6 内建负控。
- `tools/verify.sh docs`：家族名合法（ID 正则）、无占位符、预算、FR↔AC 无孤儿。
- 逐家族映射的完整性：`docs/work/plans/plugin-file-map.md` 的规则覆盖 251 个路径 + 5 个保留入口 = 256 个（0 未映射），可复核命令在 `docs/work/plans/plugin-migration-plan.md` §3。
- 覆盖数据（本批实测，见 `docs/work/evidence/EV-162-*.txt`）：FR 定义集合 **165** 行 / 40 家族；AC 定义集合 **133** 行 / 45 家族；`docs/work/plans/p3-spec.json` 的 41 条需求里 **34** 条已在定义集合、7 条为已登记缺口（同一份 spec 的 42 条 AC 里 34 条已在）。

## Revisit conditions

1. 若某个插件的需求文档大到超预算（`docs/design/*.md` 28 KB / `docs/work/*.md` 32 KB），按标准 §1 的顺序处理（删重复 → 删叙述 → 拆文件）。
2. 若"一个插件服务两个不同领域"（既有 `FR-INTEG-003` 同时被 `system/mail` 与桥接路径承载这类情况）持续增加，则需要引入"能力（capability）"级归属，而不是继续用插件级归属硬套。
3. 若 A7 判据实现后发现"归属合法但插件不存在"成规模，需要先补插件骨架再收紧判据（避免把迁移期判红当作实现错误）。
