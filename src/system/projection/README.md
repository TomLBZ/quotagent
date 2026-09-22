# system/projection —— 私域投影（插件骨架）

一句话职责：把「谁能看到哪一行、哪几个字段」变成**确定性、可机检**的规则（收件人作用域 + 字段级白名单）；派生行只增不减，账本行不增不减。

## 形态（诚实标注：本批只落骨架 + 转发入口，实体尚未搬迁）

| 项 | 现在的落点 | 什么时候变 |
|---|---|---|
| 入口 `code/index.mjs` | **wrapper/重导出**：`export *` 自 `host/modules/projection.mjs` | 阶段 4.1 把实体搬进本目录 `code/`，wrapper 删掉 |
| 实体实现 | `host/modules/projection.mjs`（**未移动**） | 阶段 4.1 |
| 本插件自己的检查资产 | `tests/check-rfq-visibility-route.py`（迁移阶段 4.1 先行：旧位置 `tools/check-rfq-visibility-route.py` 只剩薄转发） | 已落 |
| 围栏门 | `host/t287-rfq-visibility-gate.mjs`（**未移动**） | 阶段 4.3 |
| 需求行 | 定义仍在 `docs/work/functional-requirements.md`；归属行在 `docs/work/plugin-requirements-map.md` | 阶段 5.5 |

## 提供的能力

| 服务键 | 方法面 | 谁在用 |
|---|---|---|
| `projection` | `project(view, rows, options)` / `projectWithAudit(...)` | 宿主 WebUI 的**视角投影装配**（`src/system/webui/code/webui.mjs`；WebUI 本身是完整 GUI，见 `docs/design/29-webui-gui-app.md`）与真路由门 |

## 用法（一行命令）

```bash
tools/plugin.sh list --layer system --json     # 枚举（本插件应在列）
tools/plugin.sh status system/projection       # 装载状态 / 依赖是否就绪 / effects 计数
tools/plugin.sh deps   system/projection       # 依赖闭包
tools/verify.sh rfq-visibility                 # 本插件的真路由门（围栏 + 真 HTTP 两半都跑）
```

## 纪律（本插件的硬边界）

- **零写面**：不写文件、不写账本（`permissions.ledger = none`）；字段过滤只读调用方给的载荷。
- **不编内容**：读不出来的字段如实进 `omitted`，不补默认值、不猜。
- **一处一事实**：规则文本在 `docs/design/26-rfq-delivery-visibility.md`，本文件不复述。

## 不变量

- 插件 id = `system/projection`；层 = `system`（平台设施：私域投影与 realm 隔离，见 `docs/design/27-plugin-architecture.md` §1.2）。
- `entry` 必须存在（`code/index.mjs`）；`plugin.json` 是唯一登记真源（`list`/`status` 都读它）。
