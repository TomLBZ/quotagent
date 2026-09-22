# domain/gate-timeline —— 人工门与变更单的时间线（插件骨架）

一句话职责：把「审批等多久 / 变更单到底是谁卡着」变成页面上可看的**时间线**与可复制的下一步命令；`age` 只由事实时间戳之差派生（墙钟入口读都不读），**插件不能批准**。

## 形态（诚实标注：本批只落骨架 + 转发入口，实体尚未搬迁）

| 项 | 现在的落点 | 什么时候变 |
|---|---|---|
| 入口 `code/index.mjs` | **wrapper/重导出**：`export *` 自 `host/modules/gate-timeline.mjs` | 阶段 4.1 把实体搬进本目录 `code/`，wrapper 删掉 |
| 实体实现 | `host/modules/gate-timeline.mjs`（**未移动**） | 阶段 4.1 |
| 本插件自己的检查资产 | `tests/check-gate-timeline-route.py`、`tests/check-change-detail-route.py`（迁移阶段 4.1 先行：旧位置只剩薄转发） | 已落 |
| 围栏门 | `host/t282-gate-timeline-gate.mjs`、`host/t283-change-detail-gate.mjs`（**未移动**） | 阶段 4.3 |
| 需求行 | 定义仍在 `docs/work/functional-requirements.md`；归属行在 `docs/work/plugin-requirements-map.md` | 阶段 5.5 |

## 提供的能力

| 服务键 | 方法面 | 谁在用 |
|---|---|---|
| `gateTimeline` | 只读投影（`approvals` / `changes` 两节 + 每条 `basis` + 可复制命令） | 宿主 WebUI 的门时间线与变更明细页；催办落账本由唯一写者 `tools/gate-nudge.py` 承担 |

## 用法（一行命令）

```bash
tools/plugin.sh list --layer domain --json      # 枚举（本插件应在列）
tools/plugin.sh status domain/gate-timeline     # 装载状态 / 依赖是否就绪 / effects 计数
tools/verify.sh gates                           # 围栏门 + 真路由门（两半都跑）
tools/verify.sh change-detail                   # 变更单逐行明细（同一插件的第二个门）
```

## 纪律（本插件的硬边界）

- **不能批准**：服务面无审批类方法；`can_approve=false`（人工门只能由人签）。
- **零写面**：不写账本（`permissions.ledger = none`）；催办是另一个声明过的唯一写者。
- **不取墙钟**：`age_seconds = as_of − 事实 ts`；两个不同 `now` 入口给的输出逐字节一致。

## 不变量

- 插件 id = `domain/gate-timeline`；层 = `domain`（出现本领域业务判定：谁卡着、还有多久、催了没有）。
- `entry` 必须存在（`code/index.mjs`）；`plugin.json` 是唯一登记真源。
