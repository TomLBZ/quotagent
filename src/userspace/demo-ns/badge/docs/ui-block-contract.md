# userspace/demo-ns/badge 的 WebUI 区块契约

真源规则：`docs/design/27-plugin-architecture.md` §6；机制：`host/lib/ui-slot.mjs`。

| 字段 | 值 |
|---|---|
| `plugin_id` | `userspace/demo-ns/badge` |
| `slot` | `page.supplier` |
| `order` | `40`（同槽位内按 order、再按 plugin_id 字典序 ⇒ 排在 hello（30）之后） |
| `title` | `运行期装载演示区块（demo-ns.badge 注册的只读区块）` |
| `render` | `() => ({ok:true, html})`，内容来自本插件自己的 `demo-ns.badge.status` 与 `stamp.count()` |

## 与 hello 的关键差别（这是它存在的理由）

hello 在启动期被静态装配（`host/cli.mjs`），所以它能证明的是"注册面机制可用"；
badge **不在**任何启动装配里，所以它能证明的是"**运行中的服务能真装卸**"：
装载后页面上真出现 `data-ui-block="userspace/demo-ns/badge"`，卸载后该段消失、页面其余部分逐字节不变
（门 L 段用 sha256 对比；这正是 `docs/work/plans/plugin-migration-plan.md` §5.3 那条判据的落地）。

零内联脚本由机制结构性保证：区块 HTML 里出现 `<script`/内联事件属性/`javascript:` 一律**拒收**。
