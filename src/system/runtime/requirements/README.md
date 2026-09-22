# system/runtime 需求（**本插件自己的** FR/AC 行 + 每条的可执行验收命令）

规则真源：`docs/design/28-plugin-requirements-and-run.md` §1；归属真源 = `docs/design/15-requirements-coverage.md`。
本文件**只引用 ID，不复制正文**。

## 归属行（本插件承载的需求）

| ID | 一句话（本插件承担的部分） | 可执行验收命令 |
|---|---|---|
| FR-RUNTIME-001 | 仓库内自包含运行时：解释器由仓库内脚本解析；运行不写仓库外文件 | `tools/verify.sh smoke` |
| FR-RUNTIME-002 | CLI 骨架：入口与报告口径（退出码 0/1/2） | `tools/verify.sh ac AC-RUNTIME-002` |
| FR-PLUGIN-001 | 插件装载/卸载；依赖未就绪不得激活（**非激活**，不是崩） | `tools/verify.sh plugin-lifecycle` |
| FR-PLUGIN-002 | 依赖变化自动触发消费者重载/失活，不自动迁移草稿 | `tools/verify.sh plugin-lifecycle` |
| FR-PLUGIN-003 | 卸载后无残留订阅、定时器、外部通知（effects 归零） | `tools/verify.sh plugin-lifecycle` |
| AC-PLUGIN-005 | 六动词真跑（含幂等与拒绝路径；重载得到新 uid） | `tools/verify.sh plugin-lifecycle` |
| AC-RUNTIME-010 | 一键运行契约：`./run up|down|status|doctor`；凭据缺失不阻塞 `up`；`doctor` 逐项给 `next_action` | `tools/verify.sh run-once` |

## 本插件不承载

| 事项 | 归属 |
|---|---|
| 心跳/就绪探活与工作区服务托管 | 工作区 `ws-gateway`（仓库外，见 `docs/work/deployment-manual.md`） |
| 配置与凭据的落盘 | `system/config` + `tools/config-apply.py` |
| 插件目录/清单的**规则文本** | `docs/design/27-plugin-architecture.md`（本插件只实现它） |
