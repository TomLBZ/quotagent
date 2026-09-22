# system/storage 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`；
逐插件唯一指针（机检 `tools/verify.sh plugin-requirements`）：`docs/work/plugin-requirements-map.md`。
本文件**只引用 ID，不复制正文**（一处一事实）。

> **本文件的位置**：就是 27 §2.1 的**标准位置**（`src/system/storage/requirements/README.md`）—— `T-318` 期间它曾在
> `docs/work/plugin-requirements-system-storage.md`，`T-321` 用 `git mv` 归位（**内容逐字节不变**；逐条 sha256 与归位台账见映射表 §4.2 与
> `docs/work/evidence/EV-172-*`）。
> **当初为什么放 `docs/work/`**（实测，非推测）：那时 `plugin-registry` 的 `depsClosure` 把「目录存在」当
> 「插件存在」，先建裸目录会让 `plugin-lifecycle` 的 A13/A14 变红；`T-321` 已**收紧**该处（27 §2.4）⇒ 现在可以建了。

## 用途（一句话）

平台存储：按命名空间分区的文件管理 + 键值表（Python 侧唯一写入者）+ 宿主侧**只读**观察面，
写不产生账本行（不得成为第二条事实写路径，H1）。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-STORAGE-001 | 文件管理由插件提供：按 ns 分区根、append-only 日志、`stat.sha256` 与磁盘一致、逃逸一律拒 | `tools/verify.sh storage` |
| FR-STORAGE-004 | 跨租户隔离：`ns` 逃逸与 `rel` 跨根一律拒且**根外不产生任何字节**（哨兵验证） | `tools/verify.sh storage` |
| FR-STORAGE-006 | 只读观察面（容量/计数/失败次数）供自进化 `observe` 用；有界、确定性、读它不改状态 | `tools/verify.sh storage` |

## 对外契约（provides / 依赖）

| 面 | 内容 |
|---|---|
| provides | `storageView`（宿主只读视图 `host/modules/storage-view.mjs`）；Python 侧服务面 `storage`（`tools/storage.py`，**唯一写入者**） |
| 依赖 | `system/config`（数据根与 ns 名单来自只读配置快照）；不 import 其它插件的实现文件（27 §5.2） |
| 写面 | Python 侧：自己的数据根（`permissions.writes = ["own-dir"]`）；宿主侧：**零写面**（只读快照） |
| 门 | `tools/verify.sh storage`（`AC-STORAGE-001` / `AC-STORAGE-004` / `AC-STORAGE-006`；含"无关写入者解耦"的第 8 条收窄与第 19 条全局层断言，见 `docs/work/evidence/` 的 T-277 批次） |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 账本（唯一事实写路径） | `system/kernel`（`FR-LEDGER-*`） |
| 私域投影与字段白名单 | `system/projection`（`FR-UX-002`） |
| 配置键的落盘与初始化 | `system/config`（`FR-CONFIG-001/002`） |
| 宿主数据库插件 | 未成立（`docs/design/27-plugin-architecture.md` §1.4：宿主侧优先用上游 `@cordisjs/plugin-database`，Python 侧不引） |
