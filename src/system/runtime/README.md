# system/runtime —— 运行时插件（插件骨架）

一句话职责：仓库内**自包含运行时**（解释器解析 / 一键运行）＋「一切皆插件」的**六动词生命周期**实现。

## 阶段 1 的形态（诚实标注：一半新增、一半仍是 wrapper）

| 项 | 现在的落点 | 说明 |
|---|---|---|
| 生命周期实现（**新增**） | `code/plugin-registry.mjs`（纯逻辑 + 真 `cordis` 装载）、`tools/plugin-lifecycle.mjs`（六动词 CLI，`tmp/plugin-runtime/**` 的唯一写入者） | 阶段 1 本批写的新东西，不是搬迁 |
| 解释器解析 | `tools/runtime.sh`（**未移动**） | 阶段 3.2 实体搬迁 |
| Python 入口（`PYTHONPATH=src`） | `tools/run.sh`（**未移动**） | 阶段 3.2 |
| 仓库内 `.venv` | `tools/bootstrap.sh`（**未移动**） | 阶段 3.2 |
| 路径解析 | `src/quotagent/paths.py`（**未移动**） | 阶段 3.2 |
| 一键运行 | 仓库根 `./run`（本批新增，包装既有载体） | 见 `docs/design/28-plugin-requirements-and-run.md` §3 |
| 宿主依赖 | `host/node_modules/cordis@4.0.0-rc.10`（本插件不 import 裸名 `cordis`：`code/plugin-registry.mjs` 的 `loadCordis` 按"$QUOTAGENT_CORDIS → host/node_modules → 裸名"解析） | 阶段 4.4 搬进本插件 |

`code/index.mjs` 的 `EXISTING_CARRIERS` 列出这些既有载体，门 `plugin-lifecycle` 断言**它们真的存在**
（防"wrapper 指向空气"）；`runtimeFacts()` 只**重导出**事实（解释器解析顺序 / 宿主依赖 / 第三方依赖零），不复制逻辑。

## 提供的能力

| 服务键 | 方法 | 说明 |
|---|---|---|
| `pluginLifecycle` | `scan()` / `plugin(id)` / `deps(id)` / `facts()` / `verbs()` | 只读注册面：其它插件问"有哪些插件 / 依赖闭包是什么"，不必自己扫目录 |

装载/卸载**不在**服务面里（它是 CLI + 运行时进程的事）：服务面只读，写面只有一个工具。

## 用法（一行命令）

```bash
tools/plugin.sh list --json                      # 枚举（三层；--layer 过滤）
tools/plugin.sh status system/runtime            # 状态 / 依赖 / effects
tools/plugin.sh load   system/runtime            # 装载（真 import + 真挂进运行时进程）
tools/plugin.sh reload system/runtime            # 新实例（新 uid）
tools/plugin.sh unload system/runtime            # 卸载（effects 归零；可重复）
tools/plugin.sh deps   system/runtime            # 依赖闭包
tools/plugin.sh --runtime status                 # 运行时进程管理（不属于插件六动词）
```

## 纪律

- **宿主零写面**：`code/` 只读目录、不写文件；唯一写入者是 `tools/plugin-lifecycle.mjs`
  （`tmp/plugin-runtime/` 下的 socket/pid/log，`permissions.writes` 已声明）。
- Python 侧零第三方（ADR-0007）；宿主侧第三方只有 `cordis`（ADR-0012），不由本插件引入。
- 门：`tools/verify.sh plugin-lifecycle`（六动词 + 拒绝路径 + 4 处单点变异）、`tools/verify.sh run-once`（一键运行契约）。
