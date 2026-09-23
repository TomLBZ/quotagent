# domain/authority-band —— 授权区间（插件骨架）

一句话职责：把「谁能批到多少 / 越界怎么办 / 下一个能批的人是谁」变成页面上可看的区间与可复制的升级命令；金额一律用**整数分**比较，未配置时**不编限额**。

## 形态（诚实标注：本批只落骨架 + 转发入口，实体尚未搬迁）

| 项 | 现在的落点 | 什么时候变 |
|---|---|---|
| 入口 `code/index.mjs` | **wrapper/重导出**：`export *` 自 `host/modules/authority-band.mjs` | 阶段 4.1 把实体搬进本目录 `code/`，wrapper 删掉 |
| 实体实现 | `host/modules/authority-band.mjs`（**未移动**） | 阶段 4.1 |
| 本插件自己的检查资产 | `tests/check-authority-route.py`（迁移阶段 4.1 先行：旧位置 `tools/check-authority-route.py` 只剩薄转发） | 已落 |
| 围栏门 | `host/t284-authority-gate.mjs`（**未移动**） | 阶段 4.3 |
| 需求行 | 定义仍在 `docs/work/functional-requirements.md`；归属行在 `docs/work/plugin-requirements-map.md` | 阶段 5.5 |

## 提供的能力

| 服务键 | 方法面 | 谁在用 |
|---|---|---|
| `authorityBand` | 只读派生：区间表 + 越界结论 + 升级入口（确定性规则） | GUI 面板 `authority.bands`（两侧）+ 动作 `authority.check` / `authority.escalate`；批准动作**不在本插件**（在审批队列里人签） |

## 用法（一行命令）

```bash
tools/plugin.sh list --layer domain --json       # 枚举（本插件应在列）
tools/plugin.sh status domain/authority-band     # 装载状态 / 依赖是否就绪 / effects 计数
tools/verify.sh authority                        # 围栏门 + 真路由门（两半都跑）
```

## 纪律（本插件的硬边界）

- **不能批准**：服务面无审批类方法、`can_approve=false`（人工门只能由人签）。
- **不编限额**：配置里没有的区间如实报 `unconfigured`，`required_role` / `next_role` 留空。
- **零写面**：不写文件、不写账本（`permissions.ledger = none`）。
- **不取墙钟**：`payload.now` / `config.now` 两个入口读都不读。

## 不变量

- 插件 id = `domain/authority-band`；层 = `domain`（出现本领域业务判定：谁能批到多少）。
- `entry` 必须存在（`code/index.mjs`）；`plugin.json` 是唯一登记真源。
