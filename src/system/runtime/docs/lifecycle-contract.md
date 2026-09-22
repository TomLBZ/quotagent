# 生命周期契约（六动词）—— `tools/plugin.sh`

规则真源：`docs/design/27-plugin-architecture.md` §4（六动词表 + 一行命令示例）；
实现：`code/plugin-registry.mjs`（纯逻辑 + 真装载）与 `tools/plugin-lifecycle.mjs`（CLI / 运行时进程）。
本页是**对外契约**：调用方只依赖这里写的东西（命令、字段名、原因码）。

## 1. 一行命令

```bash
tools/plugin.sh list [--layer system|domain|userspace] [--json]
tools/plugin.sh status <插件>      # 插件 id 一律 `层次/插件`（userspace 写 `userspace/<ns>/<plugin>`）
tools/plugin.sh load   <插件> [--config '{...}']
tools/plugin.sh reload <插件>
tools/plugin.sh unload <插件>
tools/plugin.sh deps   <插件>
tools/plugin.sh --runtime start|stop|status      # 运行时进程管理（**不属于**插件六动词）
```

纪律（ADR-0013 帧纪律）：**stdout 只放机器可读结果**（默认一行一条 JSON；`list --json` 是一份文档），
日志走 stderr。退出码：`0` 成功 / `1` 有 `code` 的失败 / `2` 用法或环境错误（不得当作通过）。

## 2. "装载"到底发生在哪里（这条最容易被误解，明写）

`load/reload/unload/status` 的真事发生在**一个常驻运行时进程**里（unix socket：`<root>/tmp/plugin-runtime/runtime.sock`）：

| 事实 | 怎么来的 |
|---|---|
| `uid` / `fiber_state` | cordis `fiber.uid` / `fiber.state`（内核值，不是本工具编的） |
| `effects.count` / `labels` | `fiber.getEffects()`（真实 effect 列表；卸载后回读必须为 0） |
| `keys` | 入口模块的**真实导出名**（排序）——装载是不是真 import 了入口，看这一栏 |
| `instance` | `<插件>#<n>`：本运行期内该插件的实例序号（`reload` 必须 +1） |

运行时进程**按需拉起**、**不写任何文件**（状态只在它内存里，所以不存在"记录说已装载但其实没有"）；
它不在时 `status` 如实报 `runtime.running=false`，`load` 会顺手拉起它（幂等）。
`list` / `deps` 是只读目录扫描，**不需要**运行时（不 import 任何插件）。

为什么共用一个 root Context：cordis 的 `fiber.uid` 计数器是**每个 registry 各自从 1 开始**的，
每次 `new Context()` 会让两个实例拿到同一个数字（`host/lib/user-space.mjs` 已记过这个坑）；
共用 root Context 之后 `uid` 单调递增，`reload` 才拿得到"新实例（新 uid）"。

## 3. 每个动词的输出（字段名是契约）

| 动词 | 成功体（节选） | 失败体（`code` 闭合集合） |
|---|---|---|
| `list` | `{ok, verb:'list', root, layer, count, plugins:[{id,layer,ns,name,version,description,provides,entry,kind,migration,valid,reason,status,uid,deps_ready,deps_direct,deps_missing,deps_unresolved,cycle}], degraded:[{id,reason,next_action}]}` | `illegal-layer`（`--layer` 非法） |
| `status` | 同 `list` 的一项 + `last_error` + `runtime{pid,uptime_ms,socket,loaded}` | `unknown-plugin`（+ `candidates`）/ `illegal-layer` / `not-a-plugin` |
| `load` | `{ok, verb:'load', id, layer, uid, from_uid, instance, fiber_state, entry, kind, keys, provides, effects{count,labels}, depends_on, missing_targets, unresolved_services, next_action, runtime}` | `already-loaded` / `unknown-plugin` / `illegal-layer` / `not-a-plugin` / `import-failed` / `mount-failed` / `cordis-missing` |
| `reload` | 同 `load`，且 `from_uid` 非空、`uid != from_uid`、`instance` 递增 | `not-loaded`（未装载就没有"先卸后装"）/ `mount-failed`（重载拿到同一个 uid/instance） |
| `unload` | `{ok, verb:'unload', id, from_uid, disposed:true, effects_before, effects_after, zero_effects, runtime, next_action}` | `not-loaded`（可重复：重复 unload 就是这条） |
| `deps` | `{ok, verb:'deps', id, code:null, direct, closure, order, cycle:null, unresolved_services, missing_targets, next_action}` | `dependency-cycle`（+ **环上的 id**）/ `unknown-plugin` / `illegal-layer` |

原因码（清单级，进 `plugins[].reason` 与 `degraded[].reason`）：`manifest-missing` / `manifest-unreadable` /
`manifest-not-json` / `manifest-not-an-object` / `manifest-too-large` / `manifest-missing-fields` /
`name-mismatch` / `layer-mismatch` / `ns-missing` / `artifact-missing`。

语义要点（与 27 §4.1 逐条对齐）：

- **依赖未就绪 ⇒ 非激活，不是失败**：`deps_ready=false` + `deps_missing`/`deps_unresolved` 列出来；
  装载照样成功（入口 import 成功），只是它注册的服务在依赖到位前不生效（`ctx.inject` 的语义）。
- **卸载零残留**：`unload` 在运行时进程里 `fiber.dispose()` 之后**回读** effects；不为 0 ⇒ `zero_effects=false`
  并在 `next_action` 里指名"真残留，必须查"（对齐 `AC-PLUGIN-001` / `FR-PLUGIN-003`）。
- **不迁移任何内存状态**：`reload` 是新 fiber，不带任何旧状态（新 uid / 新 instance）。
- **目录即清单**：`src/<层>/<插件>/` 里没有 `plugin.json` 的目录 **不是插件**（`list` 不枚举，
  `load` 报 `not-a-plugin`）；目录不存在 ⇒ 空列表（不是错误）。

## 4. 写面（谁可以写什么）

| 位置 | 允许 |
|---|---|
| `tools/plugin-lifecycle.mjs` | `tmp/plugin-runtime/{runtime.sock,runtime.pid,runtime.log}` —— **唯一写入者**（`plugin.json.permissions.writes` 已声明） |
| `code/plugin-registry.mjs` | **零写面**（不写任何文件；只读插件目录） |
| 每个插件的 `code/` | 只写自己目录（`permissions.writes: own-dir`）；`ledger` 一律 `none` |
| 账本 | 谁都不写（H1：账本只由 Python 侧写） |

`--root <目录>`（或 `$QUOTAGENT_PLUGIN_ROOT`）把同一套动词跑在另一个仓库根上：门用它造夹具根
（环状依赖 / 坏清单）与变异根，产品树因此**不被写**。宿主内核解析顺序：
`$QUOTAGENT_CORDIS` → `<root>/host/node_modules/cordis` → 裸 `cordis`（阶段 4.4 宿主依赖搬进本插件后收敛）。

## 5. 运行期装卸（`--live`）：装进**正在服务的那个进程**

§2 的六个动词把插件挂进一个**独立的常驻运行时进程**（`tmp/plugin-runtime/`）—— 装载事实活在那里，
页面看不见。`--live` 走的是另一条路：把插件挂进**长驻 WebUI 进程自身的 ctx**，于是：

```bash
tools/plugin.sh load   userspace/demo-ns/badge --live    # 也支持 reload / unload / status / list / deps
./run plugin load userspace/demo-ns/badge                # 同一个东西（./run 只是转发）
```

| 事实 | 怎么来的 |
|---|---|
| `control:"live"` | 回执里的模式标记（与 §3 的常驻运行时进程回执区分开：那是 `runtime{…}`） |
| `uid` / `instance` / `effects` | 与 §2 同一套（cordis 内核实测）；`reload` 必须给**新 uid**，且 `from_effects` 可查 |
| 页面区块 | 插件注册的只读区块**真的出现在页面上**（`data-ui-block="<插件 id>"`）；卸载后消失且**页面其余部分逐字节不变**（门 `plugin-lifecycle` 的 L 段用 sha256 对比） |

实现：`src/system/runtime/code/live-control.mjs`（机制）+ `src/system/runtime/tools/plugin-live.mjs`（客户端）。
控制通道是一条**注册到路由注册面**的 HTTP 路由（`host/lib/ui-route.mjs`，webui 只提供注册面，不认识它是什么）：

```
POST <prefix>/api/plugins/control      # 头：X-Plugin-Control-Token；体：{"verb":…,"id":…,"confirm":true}
```

### 5.1 围栅（四道，全部 fail-closed；"防 agent 误操作"是设计目标）

| # | 围栅 | 违反时的 `code`（+ HTTP 状态） |
|---|---|---|
| ① | **控制令牌**：`$QUOTAGENT_PLUGIN_CONTROL_TOKEN` 或 0600 文件 `<root>/../config/quotagent-plugin-control-token`；**没配 = 整条通道关闭** | `plugin-control-disabled`（503）；令牌不匹配/缺头 ⇒ `plugin-control-unauthorized`（403） |
| ② | **显式确认**：`load/reload/unload` 必须带 `{"confirm":true}` | `confirmation-required`（409） |
| ③ | **层锁定**：`system/**`（宿主 harness 自己）不许热插拔 | `layer-locked`（403） |
| ④ | **只认显式动词与显式 id**：未知动词、未注册路径一律有名拒绝（不通配、不猜） | `unknown-verb`（400）/ `unknown-plugin`（404） |

令牌**只比 sha256 摘要**（`crypto.timingSafeEqual`），**不回显、不落盘**；客户端没令牌时**就地**拒绝
（`plugin-control-disabled` + next_action），不去猜一个默认值。

### 5.2 零写面与失败语义

- 运行期装卸**只改宿主内存里的装配**：不写文件、不写账本、不联网（门 L13 在整轮装卸前后比对
  `src/**`+`host/**` 与数据根，逐字节不变）。
- 失败一律给 `code` + `reason` + `next_action`（`unknown-plugin` 带候选列表；`already-loaded` 指路 `reload`；
  `not-loaded` 指路 `load`；`mount-failed` 带原因）。
- 回执里带 `token_source`（`env` / `file:0600` / `absent` / `file:mode-XXX-refused`）——**只报来源，不报值**。

### 5.3 与 §2 的分工（诚实标注）

| 场景 | 用哪条路 |
|---|---|
| 只想验证插件本身能不能装（含依赖/effects/uid），与页面无关 | §2 常驻运行时进程（`tmp/plugin-runtime/`，可跑在任意 `--root` 上） |
| 要看"装进去之后页面真的变了"，或让**正在服务用户的进程**用上这个插件 | §5 `--live`（只能跑在本仓那个真服务上） |
| 重启服务 | 两条路的装载事实都在内存里，重启即清空（没有"第二份记录"，所以不存在记录与现实的漂移） |
