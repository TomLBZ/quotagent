# domain/advice 的 WebUI 区块契约（对外契约）

真源规则：`docs/design/27-plugin-architecture.md` §6（注入式 UI 契约）、`docs/design/28-plugin-requirements-and-run.md`；
机制实现：`host/lib/ui-slot.mjs`（只做机制，不含任何业务语义）。

## 本插件提交了什么

| 字段 | 值 | 含义 |
|---|---|---|
| `plugin_id` | `domain/advice` | 注册者（`层次/插件`；门据此断言"谁注册的"） |
| `slot` | `page.contractor` | 槽位（闭合集合，见机制层的 `SLOTS`） |
| `order` | `20` | 同槽位内排序（越小越靠前；同 `order` 按 `plugin_id` 字典序，稳定可复现） |
| `title` | `决策建议（domain/advice 插件注册的只读区块）` | 页面上"这个块是谁的"线索 |
| `render` | `() => ({ok:true, html})` | 只读渲染；数据来自本插件的运行期服务面 `advicePanel.meta()` / `advise(undefined)` |

注册通过 `ctx.inject(['uiSlots'], (scope) => scope.effect(() => scope.uiSlots.register({...})))` 完成：
依赖就绪才注册，**依赖消失自动 dispose**（区块随之从页面消失，不留残留）。

## 机制层会拒绝什么（都在页面上指名报出，不静默吞）

| 情形 | 代码 | 页面表现 |
|---|---|---|
| `plugin_id` 形状非法 / 层名非法 | `illegal-plugin-id` | 注册失败（不渲染该块） |
| 槽位不在闭合集合里 | `unknown-slot` | 注册失败 |
| `order` 越界 / `title` 空或超长 / `render` 不是函数 | `invalid-order` / `invalid-title` / `invalid-render` | 注册失败 |
| 同一 `(slot, plugin_id)` 用**不同形状**重复注册 | `duplicate-registration` | 注册失败（不许悄悄覆盖） |
| 区块 HTML 含 `<script` / 内联事件属性 / `javascript:` URL | `inline-script-refused` | 该块不渲染，页面出"区块被拒收"+ 代码 |
| `render` 抛错或返回形状不对 | `block-render-failed` | 该块不渲染，页面出"区块未能渲染"+ reason |

## WebUI 一侧知道什么（这条是硬边界）

WebUI 只做两件事：把注册面提供出去、在槽位上按 `order` 拼接**别人注册的** HTML。
它**不知道**：本插件是什么、这个区块是业务还是别的、`advice`/`建议`/`比价` 这些词的含义。
机检口径（`tools/verify.sh plugin-lifecycle`）：`host/modules/webui.mjs` 里出现 `domain/advice`、`决策建议`
或本区块标题 **0 次**；含 `uiSlots` 的机制行逐行扫业务名词 **0 命中**。

## 只读性

`render` 只调用本插件的纯函数服务面（`meta()`/`advise()`），不读账本、不取墙钟、不写文件、不联网；
`GET /<prefix>/api/ui/blocks` 只回执注册**元数据**（`plugin_id/slot/order/title`），不含区块正文。
