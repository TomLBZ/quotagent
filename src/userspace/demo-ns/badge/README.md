# userspace/demo-ns/badge —— 运行期装卸的演示/取证插件

一句话职责：证明**运行中的服务能真装卸插件** —— 它不在任何启动装配里，只能由运行期控制通道装进来；
装进来后它注册的只读区块必须真出现在页面上，卸掉后必须消失且页面其余部分逐字节不变。

## 提供的能力

| 服务键 | 方法 | 写面 |
|---|---|---|
| `demo-ns.badge.stamp` | `mark(label)` / `last()` / `count()` | 只在内存（本次挂载的实例），不落盘 |
| `demo-ns.badge.status` | 自述对象 `{version, ns, plugin, mounted}` | 无 |

注册的区块：槽位 `page.supplier`、`order=40`、标题见 `plugin.json`/代码里的 `BLOCK`
（与 `userspace/demo-ns/hello` 同槽位、order 更大 ⇒ 排在它后面）。

## 怎么装它（**只有**运行期路径）

```bash
# 需要运行中的服务（./run up 起）+ 控制令牌（见 src/system/runtime/docs/lifecycle-contract.md §4）
tools/plugin.sh load   userspace/demo-ns/badge --live
curl -s http://127.0.0.1:8093/quotagent/supplier/ | grep -o 'data-ui-block="[^"]*"'
tools/plugin.sh unload userspace/demo-ns/badge --live
```

## 纪律

- **零写面**：不写文件、不写账本、不联网、不取随机、不起定时器、不读墙钟（静态负控与 hello 同口径）。
- 平台保留名（`approval` / `ledger*` / `kernel.*` / `webui` …）一律不碰。
- 两份装载器同一份实现：拿到 `config.prefix`（隔离内核路径）就注册基础名 `stamp`/`status`，由它命名空间化。
