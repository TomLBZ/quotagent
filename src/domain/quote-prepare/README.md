# domain/quote-prepare —— 报价草稿写闭环（插件骨架）

一句话职责：把「员工填了单价点了提交、浏览器回一页 200、什么都没发生」变成**真写闭环**：浏览器只落 0600 待办件，唯一写账本者是 Python 侧，**签名只能由人**。

## 形态（诚实标注：本批只落骨架 + 转发入口，实体尚未搬迁）

| 项 | 现在的落点 | 什么时候变 |
|---|---|---|
| 入口 `code/index.mjs` | **wrapper/重导出**：`export *` 自 `host/modules/quote-prepare.mjs` | 阶段 4.1 把实体搬进本目录 `code/`，wrapper 删掉 |
| 实体实现 | `host/modules/quote-prepare.mjs`（**未移动**） | 阶段 4.1 |
| 唯一写账本者 | `tools/quote-draft.py`（落 `quote/drafted`）、`tools/quote-sign.py`（签名只能由人） | 阶段 1.2 |
| 本插件自己的检查资产 | `tests/check-quote-draft-route.py`、`tests/checks_qprep.py`（迁移阶段 4.1 先行：旧位置只剩薄转发） | 已落 |
| 围栏门 | `host/t286-quote-draft-gate.mjs`（**未移动**） | 阶段 4.3 |
| 需求行 | 定义仍在 `docs/work/functional-requirements.md`；归属行在 `docs/work/plugin-requirements-map.md` | 阶段 5.5 |

## 提供的能力

| 服务键 | 方法面 | 谁在用 |
|---|---|---|
| `quotePrepare` | 只读派生草稿（恰 8 键服务面，**无** `sign` / `approve` / `submit` / `send`） | 宿主 WebUI 的报价准备页与 `<供应商>/api/prepare` 路由 |

写动作的落点：浏览器 → 宿主只落 0600 待办件（账本零新增）→ 唯一写者落账本 → 两侧登记（双向可见）。

## 用法（一行命令）

```bash
tools/plugin.sh list --layer domain --json      # 枚举（本插件应在列）
tools/plugin.sh status domain/quote-prepare     # 装载状态 / 依赖是否就绪 / effects 计数
tools/verify.sh quote-draft                     # 围栏门 + 真路由门（两半都跑）
tools/verify.sh ac AC-QUOTE-001                 # 本插件的 AC（无 Node 也能跑的那一半）
```

## 纪律（本插件的硬边界）

- **不代签**：草稿恒为「待签署」；签名走 `tools/quote-sign.py` 且只认 `human:*`。
- **不落账本**：宿主侧账本零新增；账本唯一写者是声明过的 Python 工具。
- **不编行项目**：目录读不出来如实降级，不补默认单价。
- **页面 0 内联脚本**：区块与页面模板都不含内联脚本。

## 不变量

- 插件 id = `domain/quote-prepare`；层 = `domain`（出现本领域业务判定：这份报价能不能提交、谁来签）。
- `entry` 必须存在（`code/index.mjs`）；`plugin.json` 是唯一登记真源。
