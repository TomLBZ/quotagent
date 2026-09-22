# userspace/demo-ns/hello 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`。
本文件**只引用 ID，不复制正文**。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-USERPLUG-001 | 用户空间插件在自己的命名空间里登记（`plugin.json` 是唯一登记真源） | `tools/verify.sh user-space` |
| FR-USERPLUG-002 | 写面只有自己的文件根（本插件零文件写入，写面=内存 Map） | `tools/verify.sh user-space` |
| FR-USERPLUG-006 | 服务键命名空间化 `<ns>.<plugin>.<svc>`；平台保留名结构性拒绝 | `tools/verify.sh user-space` |
| FR-USERPLUG-009 | 插件自包含：独立 instance、不消费平台服务（本插件的区块走**注册面**，不是耦合） | `tools/verify.sh user-space` |
| AC-PLUGIN-005 | 六动词生命周期在本插件上真跑（含幂等与拒绝路径） | `tools/verify.sh plugin-lifecycle` |
| AC-PLUGIN-006 | 注册的只读区块在页面上真出现，且 webui 源文件 0 次出现本插件 id/标题 | `tools/verify.sh plugin-lifecycle` |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 用户空间的装载/卸载/隔离内核 | `system/user-plugin-manager`（`host/lib/user-space.mjs`） |
| 提权为系统级 | `system/admin` + 人工门（ADR-0016） |
| 页面槽位与排序机制 | `system/webui`（机制在 `host/lib/ui-slot.mjs`） |
