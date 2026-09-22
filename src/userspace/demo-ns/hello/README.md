# userspace/demo-ns/hello —— 用户空间演示插件（插件骨架）

一句话职责：演示"使用者本人用自然语言让 agent 产出的插件"落进新布局后的形状 ——
在**自己的命名空间**里注册只读服务，并向 WebUI 注册面提交一个只读区块；**不改平台、不碰保留名、零写面**。

## 阶段 1 的形态（诚实标注：本插件是**实体搬迁**，不是 wrapper）

| 项 | 现在的落点 | 说明 |
|---|---|---|
| 入口 `code/index.mjs` | **实体实现**（本插件只有 1 个代码文件，本批直接搬） | 阶段 5.1 把运行时根收敛成"gitignore + 跟踪的 EXAMPLE" |
| 原运行时副本 | `user-space/demo-ns/hello/`（**未动**，仍被现有 `user-space` 门与市场门扫） | 阶段 5.1 收敛（本批不改 `user-space/**`） |
| 服务键 | 基础名 `bucket` / `status` → 装载期命名空间化 `demo-ns.hello.bucket` / `demo-ns.hello.status` | 用户空间约定，不改 |

## 提供的能力（只读）

| 服务键 | 方法 | 写面 |
|---|---|---|
| `demo-ns.hello.bucket` | `put(k,v)` / `get(k)` / `size()` | 只在**内存 Map**（独立 instance 状态），不落盘 |
| `demo-ns.hello.status` | 自述对象 `{version, ns, plugin}` | 无 |

装载后本插件向 WebUI 的**注入式注册面**提交一个只读区块（槽位 `page.supplier`，`order=30`）——
契约见 `docs/ui-block-contract.md`。区块只**读**自己的服务状态；没写入过就如实显示 `null`，不编造。

## 用法（一行命令）

```bash
tools/plugin.sh list --layer userspace --json   # 枚举用户空间插件（本插件应在列）
tools/plugin.sh status userspace/demo-ns/hello  # 装载状态 / 依赖 / effects
tools/plugin.sh load   userspace/demo-ns/hello  # 装载
tools/plugin.sh reload userspace/demo-ns/hello  # 重载（新实例、新 uid）
tools/plugin.sh unload userspace/demo-ns/hello  # 卸载（effects 归零；可重复）
tools/plugin.sh deps   userspace/demo-ns/hello  # 依赖闭包（→ webui）
```

## 纪律

- **写面只有自己的 ns 根**（`permissions.writes = own-ns-root`）；本批代码里**没有任何文件写入**。
- 平台保留服务名（`approval` / `ledger*` / `kernel.*` / `webui` …）一律不碰（见 `host/lib/user-space.mjs` 的 `RESERVED_SERVICES`）。
- 零第三方依赖、纯标准库/ESM；不起子进程、不联网、不取随机、不起定时器。

## 本批的已知偏差（登记，不假装）

本批把这个样板**挂进平台 ctx**（`host/cli.mjs` 的 webui 动作）来证明注册面机制 ——
用户空间的"独立 `Context`"装载（`host/lib/user-space.mjs`）由阶段 5.1/5.2 收敛；
独立 `Context` 里看不到平台的 `uiSlots` 服务，两步必须一起做（登记在 `docs/work/evidence/EV-165-plugin-lifecycle.txt`）。
