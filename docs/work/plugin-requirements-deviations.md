# 插件归属与 28 家族表的偏差登记（映射表 §3 的表，拆出以守住 32 KB 预算）

真源：归属真源 = `docs/design/15-requirements-coverage.md`（ADR-0021 §2）；家族表方案 = `docs/design/28-plugin-requirements-and-run.md` §2.2/§2.3/§2.4。
本文件是 `docs/work/plugin-requirements-map.md` §3 的那张表**整表逐字搬来**（同批 `T-318`：映射表 + 58 行位置登记让主文件 36.5 KB > 32 KB 预算，
按 `docs/design/12-documentation-standard.md` §1 的处理顺序「删重复 → 删叙述 → 拆文件」拆出；**语义不变**，机检命令不变）。
> 28 的家族表是**方案**，`15-requirements-coverage.md` 是**归属真源**；两者不一致时以真源为准并逐条登记在此，**不修改 28 的原文**。
> 除下表所列，其余 FR 与 28 家族表逐条一致。

| FR | 28 家族表说 | 本表归属 | 为什么（证据） |
|---|---|---|---|
| FR-QEP-007 | system/kernel（QEP 整族） | `domain/sync` | 承载体实测 `src/quotagent/services/sync.py` 的 `SyncService.reconcile`；AC 家族 `AC-SYNC-001` 在 28 §2.3 已归 `domain/sync`，27 §1.3 把 `sync` 单列为 domain 插件 |
| FR-NORM-004 | system/norm（NORM 整族） | `domain/quotes` | 承载体实测 `services/quotes.py`（`QuoteBook.on_amended`）；"包版本与报价版本一致性门"的执行件是报价簿，归 `domain/quotes` |
| FR-RFQ-006 | domain/rfq-deadline | `domain/quotes` | 承载体实测 `services/quotes.py`（标 superseded + 重报请求）；28 §2.2 与 §2.4.2 对该族 006/008 的写法自相矛盾（见下一行） |
| FR-RFQ-008 | system/projection（§2.2 与 §2.4.2 同写） | `domain/rfq-deadline` | 判为 28 的笔误：FR 文本点名 domain 插件 `rfq-deadline`，15 §2 亦写 `rfq-deadline`，且有独立围栏门 `tools/verify.sh rfq-deadline` 与 23/23+11/11 证据 |
| FR-EVIDENCE-004 | system/evidence（EVIDENCE 整族） | `system/retention` | 承载体实测 `services/retention.py` + `retention_exec.py`，有独立门 `tools/verify.sh retention` 与独立视图 `host/modules/retention-view.mjs`；27 §1.3 把 `retention` 单列为 system 插件 |
| FR-UX-001 | system/webui（UX 整族） | `system/approval` | 承载体实测 `services/approval.py` 的 `queue_view()`；15 §2 亦把 `FR-UX-001` 记在 `approval-digest` 行 |
| FR-UX-002 | system/webui | `system/projection` | 15 §2 显式把 `FR-UX-002` 与 `AC-TRUST-001` 记在 `projection` 行；私域字段过滤的机制面是投影 |
| FR-UX-003 | system/webui | `domain/export` | 承载体实测 `services/export.py`（比价表 CSV 导出） |
| FR-UX-004 | system/webui | `system/ops-view` | 承载体实测 `host/modules/ops-view.mjs`（运维视角只读快照，"不属于任何一方"） |
| FR-PLUGIN-005 | 28 §2.2 只数了 PLUGIN 4 条（本 FR 晚于 28 成立） | `system/webui` | 27 §6 的"注入式 UI 契约"由 webui 提供注册面；承载体实测 `host/lib/ui-slot.mjs` + `host/modules/webui.mjs`，门 `tools/verify.sh plugin-lifecycle` 的 C/D 组 |
| FR-USREQ-001..011 | 28 §2.4.3 是**多插件**列表（无唯一归属） | 取该表**首个**插件为主归属（001/002/004/005/011 → `system/webui`；003 → `system/runtime`；006 → `system/ui-feedback`；007 → `system/repo-gate`；008 → `system/market`；009 → `system/config`；010 → `system/evolution`） | 唯一指针要求"每条 FR 只出现一次"；共同参与方**不删**，写在证据列 |
| 插件自己的 `requirements/`（含 `plugin.json.requirements`）| — | 主归属仍以本表为准 | 插件文件里对某条 FR 的声明是"本插件承担的**部分**"（27 §2.1 允许），**不是**主归属：例 `src/system/runtime/requirements/README.md` 声明 `FR-PLUGIN-001/002/003`；`src/userspace/demo-ns/hello`、`demo-ns/badge`、`con-a/quote-trend` 的 `plugin.json` 各声明 `FR-USERPLUG-*` 等。唯一指针只看本表与矩阵 |
