# userspace/demo-ns/hello —— 用户空间演示插件

一句话职责：演示"使用者本人用自然语言让 agent 产出的插件"落进三层布局后的形状 ——
在**自己的命名空间**里注册只读服务，并向 WebUI 注册面提交一个只读区块；**不改平台、不碰保留名、零写面**。

## 阶段 5.1 的形态（唯一事实源；旧位置是兼容链接）

| 项 | 现在的落点 | 说明 |
|---|---|---|
| 唯一事实源 | `src/userspace/demo-ns/hello/`（`git ls-files` 可见） | 旧的 `user-space/` 已改成指向 `src/userspace/` 的**兼容链接**（旧路径的读方不用改） |
| 旧实现 | 旧 `user-space/demo-ns/hello/index.mjs`（12 行）已删 | 逐字留档在 `docs/migration-note.md`；其能力是本插件现在的**子集** |
| 入口 `code/index.mjs` | **实体实现**（唯一一份） | 同时满足两份装载器，见下 |
| 服务键 | `demo-ns.hello.bucket` / `demo-ns.hello.status` | 平台装载器路径：插件自己加前缀；隔离内核路径：插件给基础名、由内核加前缀 |

## 提供的能力（只读）

| 服务键 | 方法 | 写面 |
|---|---|---|
| `demo-ns.hello.bucket` | `put(k,v)` / `get(k)` / `size()` | 只在**内存 Map**（独立 instance 状态），不落盘 |
| `demo-ns.hello.status` | 自述对象 `{version, ns, plugin}` | 无 |

装载后本插件向 WebUI 的**注入式注册面**提交一个只读区块（槽位 `page.supplier`，`order=30`）——
契约见 `docs/ui-block-contract.md`。区块只**读**自己的服务状态；没写入过就如实显示 `null`，不编造。

## 用法（一行命令；六动词）

```bash
tools/plugin.sh list --layer userspace --json   # 枚举用户空间插件（本插件应在列）
tools/plugin.sh status userspace/demo-ns/hello  # 装载状态 / 依赖 / effects
tools/plugin.sh load   userspace/demo-ns/hello  # 装载（常驻运行时进程）
tools/plugin.sh reload userspace/demo-ns/hello  # 重载（新实例、新 uid）
tools/plugin.sh unload userspace/demo-ns/hello  # 卸载（effects 归零；可重复）
tools/plugin.sh deps   userspace/demo-ns/hello  # 依赖闭包（→ webui）
# `--live` = 装进**运行中的服务**（见 src/system/runtime/docs/lifecycle-contract.md §4）
```

## 纪律

- **写面只有自己的 ns 根**（`permissions.writes = own-ns-root`）；本插件代码里**没有任何文件写入**。
- 平台保留服务名（`approval` / `ledger*` / `kernel.*` / `webui` …）一律不碰（见 `host/lib/user-space.mjs` 的 `RESERVED_SERVICES`）。
- 零第三方依赖、纯标准库/ESM；不起子进程、不联网、不取随机、不起定时器。

## 已知偏差（登记，不假装）

本插件在**启动期**被静态装配进平台 ctx（`host/cli.mjs` 的 webui 动作）—— 所以它能证明注册面机制可用，
但**证明不了**"运行中的服务能真装卸"；后者的取证对象是 `userspace/demo-ns/badge`（不在任何启动装配里，
只能由运行期控制通道装载）。独立 `Context` 装载（`host/lib/user-space.mjs`）与平台装载器（`plugin-registry.mjs`）
今天**并存**：本插件的 `code/index.mjs` 用 `config.prefix` 判别两条路径（互斥），不产生第二份实现。
