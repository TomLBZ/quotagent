# userspace/demo-ns/hello 的 WebUI 区块契约（对外契约）

真源规则：`docs/design/27-plugin-architecture.md` §6；机制实现：`host/lib/ui-slot.mjs`。

## 本插件提交了什么

| 字段 | 值 |
|---|---|
| `plugin_id` | `userspace/demo-ns/hello` |
| `slot` | `page.supplier` |
| `order` | `30`（同槽位内按 order、再按 plugin_id 字典序） |
| `title` | `用户空间插件区块（demo-ns.hello 注册的只读区块）` |
| `render` | `() => ({ok:true, html})`，内容来自本插件自己的 `demo-ns.hello.status` 与一次只读 `bucket.get('ping')` |

注册路径与 `domain/advice` 同形（`ctx.inject(['uiSlots'], …)` + `scope.effect(...)`）：依赖消失自动反注册。

## 用户空间特有的两条纪律

1. **不碰平台保留名**：区块里的所有数据都来自本插件自己的服务（`demo-ns.hello.*`）；
   注册面（`uiSlots`）是**平台提供的机制**，插件只提交声明，不写入任何平台状态。
2. **零写面**：`render` 只读内存 Map 与自述对象；没有写入过就显示 `null`（**不编造**值），不落盘、不写账本。

## WebUI 一侧知道什么

WebUI 只知道"有个区块挂在 `page.supplier` 上、`order=30`、标题是什么"；它**不知道**
`demo-ns`/`hello` 是什么、这个区块是不是用户空间插件。机检口径见 `tools/verify.sh plugin-lifecycle` 的
"webui 零业务耦合"两条（源文件 0 命中 + 机制行 0 业务名词）。
