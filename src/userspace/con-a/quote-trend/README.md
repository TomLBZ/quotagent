# userspace/con-a/quote-trend —— 用户空间插件（报价趋势记录）

一句话职责：**按项目维度记录每次报价金额，并算出涨跌方向与差值**（用户原话见 `plugin.json.created_from`）。

## 提供的能力（只读面 + 一个 append-only 写面）

| 服务键 | 方法 | 写面 |
|---|---|---|
| `con-a.quote-trend.quoteTrend` | `record(project_id, amount_minor, at_iso)` / `trend(project_id)` | 只追加到自己的数据文件 |
| `con-a.quote-trend.observationLog` | `path()` / `stats()` | 无（只读） |

- 数据文件：`data/observations.jsonl`（**append-only**，一行一条 `{project_id, amount_minor, at}`；从不改写已有行）。
- 拒绝码只有一条：`invalid-observation`（形状不对就**不写文件**，逐条给 reason）。
- 确定性：不读墙钟、不看时区；同输入两次 `trend()` 逐字节一致。

## 一行命令（六动词；`--live` = 装进**运行中的服务**）

```bash
tools/plugin.sh list --layer userspace --json      # 枚举（本插件应在列）
tools/plugin.sh status userspace/con-a/quote-trend
tools/plugin.sh load   userspace/con-a/quote-trend
tools/plugin.sh reload userspace/con-a/quote-trend
tools/plugin.sh unload userspace/con-a/quote-trend
```

## 谁在用它（不假装）

- 隔离内核路径（`host/lib/user-space.mjs`）：`tools/verify.sh user-space` 用**夹具**验证隔离四件套；本插件在
  磁盘上真跑过一轮（`docs/work/evidence/EV-137-t269-user-space-chain-live.txt`）。
- 平台装载器路径（`src/system/runtime/`）：`tools/plugin.sh` 的六动词按目录即清单枚举它。
- 管理面（`/quotagent/admin/api/user-plugins`）：按用户空间根扫描它（清单字段 `name/version/provides` 齐备）。

## 迁移（阶段 5.1，本批）

唯一事实源 = `src/userspace/con-a/quote-trend/`；旧的 `user-space/` 位置改成了指向 `src/userspace/` 的
**兼容链接**。本次只搬位置（**字节不变**：`code/index.mjs` 仍是 11742 字节、
sha256 = `dffeff77fbf497048efd0b4c5f592025821efb56441925adf9e57c94c8086db7`，与 `plugin.json.sha256` 一致），
`data/observations.jsonl` 原样随行（297 字节，sha256 = `33f46dbe63904e125a1ceff59369beccc63c13d4b42b332e3fb5062c777368fe`）。

一处**行为差异的诚实标注**：本插件在被**直接挂载**（宿主没给 `config.root`）时用自己的产物目录当文件根 ——
搬到标准布局后该目录由 `<插件>/index.mjs` 的目录变成 `<插件>/code/`，于是自管路径也随之变成
`code/data/observations.jsonl`。宿主给文件服务/`config.root` 的路径（隔离内核、平台装载器、真跑链）
**不受影响**，数据文件仍在 `<插件>/data/observations.jsonl`。
