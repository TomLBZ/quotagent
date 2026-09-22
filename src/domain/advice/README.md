# domain/advice —— 决策建议层（插件骨架）

一句话职责：把「看得到事实但不知道下一步该干什么」变成一条条**可复制、可溯源**的命令/路由；确定性规则引擎（`engine=rules`），**没有可分的数据就不给建议**。

## 阶段 1 的形态（诚实标注：本插件是 wrapper，不是实体搬迁）

| 项 | 现在的落点 | 什么时候变 |
|---|---|---|
| 入口 `code/index.mjs` | **wrapper/重导出**：`export *` 自 `host/modules/advice-panel.mjs`，并在其 `apply` 之上加一个只读区块注册 | 阶段 4.1 把 `host/modules/advice-panel.mjs` 实体搬进本目录 `code/`，wrapper 删掉 |
| 实体实现 | `host/modules/advice-panel.mjs`（**未移动**，本批不动它） | 阶段 4.1 |
| 围栏门 | `host/t281-advice-gate.mjs` + `tools/check-advice-route.py`（**未移动**）；入口契约由 `tools/verify.sh plugin-lifecycle` 现扫 | 阶段 4.3 |
| 需求行 | 仍定义在 `docs/work/functional-requirements.md` / `acceptance-criteria.md`；本插件的 `requirements/README.md` 只**引用 ID** | 阶段 5.5（归属列改为插件 id） |

## 提供的能力

| 服务键 | 方法 | 谁在用 |
|---|---|---|
| `advicePanel` | `advise(payload)` / `meta()` / `config()` | `host/modules/webui.mjs` 的建议页与建议 JSON（`/<view>/advice/`、`/<view>/api/advice`） |

装载后本插件还会向 WebUI 的**注入式注册面**提交一个只读区块（`page.contractor`，`order=20`）——
契约见 `docs/ui-block-contract.md`；WebUI 只知道"有个区块挂在这个槽位上"，**不知道**它是什么。

## 用法（一行命令）

```bash
tools/plugin.sh list --layer domain --json      # 枚举（本插件应在列）
tools/plugin.sh status domain/advice            # 装载状态 / 依赖是否就绪 / effects 计数
tools/plugin.sh load   domain/advice            # 装载（真 import 入口，记 uid 与 effects）
tools/plugin.sh reload domain/advice            # 先卸后装 ⇒ **新实例（新 uid）**
tools/plugin.sh unload domain/advice            # 卸载（effects 归零、可重复）
tools/plugin.sh deps   domain/advice            # 依赖闭包（本插件 → webui）
```

## 纪律（本插件的硬边界）

- **零写面**：不写文件、不写账本、不订阅事件、不起子进程、不联网、不调模型；`permissions.ledger = none`。
- **不读账本**：只吃调用方给的结构化载荷（连 `fs` 都不 import）。
- **不取墙钟**：确定性由实体实现的规则保证（`Date` 一次都不用）。
- **注册的区块只读**：内容来自本插件自己的运行期服务面（`meta()` / `advise(undefined)`），拿不到服务就**如实报未就绪**，不编内容。

## 不变量

- 插件 id = `domain/advice`；层 = `domain`（出现在本领域的业务判定里：给谁什么下一步）。
- `entry` 必须存在（`code/index.mjs`）；`plugin.json` 是**唯一登记真源**（`list`/`status` 都读它）。
