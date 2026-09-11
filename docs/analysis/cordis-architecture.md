# Cordis 架构的代码级分析

<!-- budget: 24 KB. 证据基准: cordiverse/cordis @ f8ea3cd (2026-09-08, "chore: bump versions") -->

## 0. 范围与方法

本文只写可从源码或论文原文核实的事实。证据来源两类，文中分别标注：

- `代码` — 路径相对 `cordiverse/cordis` 仓库；行号对应上面的 commit。
- `论文` — *A Programming Paradigm for Spatiotemporal Composability*，arXiv:2608.25512
  （2026-08-26 提交，92 页，作者 Yifan Shi / Wei Zhang / Tianyi Cui，单位北京大学与 DeepSeek-AI；
  摘要原文已核实）。论文的正式仓库 `cordiverse/paper` 目前只有一个 README 占位。

凡属第三方博客/二手解读的说法，一律标注 `[二手]` 且不作为设计依据。凡属推测，标 `[推断]`。

**取证命令（可复现）**

```bash
git clone --depth 1 git@github.com:cordiverse/cordis.git
find packages/core/src -name '*.ts' | xargs wc -l
```

## 1. 仓库结构

```
packages/core           Context / Fiber / Service / Registry / Reflect / Events / Logger
packages/loader         声明式条目树、配置协调、group、isolate realm
packages/include        配置片段 include、patch、journal（三方协调）
packages/hmr            热模块替换
packages/group          条目分组
packages/timer          定时器（可撤销资源）
packages/logger-console 控制台日志
packages/create / utils 脚手架与工具
```

`代码` core 源码规模（行数）：`registry.ts` 214、`context.ts` 78、`utils.ts` 282、`reflect.ts` 283、
`fiber.ts` 496、`events.ts` 188、`service.ts` 80、`logger.ts` 246、`index.ts` 7。

两点必须说清楚：`代码` 根 `README.md` 自述「API is not yet stable and may change without notice」；
`代码` `packages/loader/README.md` 只有一行，**官方文档仍在建设中**——要判断语义只能读源码，
这正是本文存在的理由。

## 2. 运行模型：五个概念与它们的落点

### 2.1 Context 是容器，不是基类（`context.ts`）

`代码` `context.ts:36-49`：根 Context 构造时只做五件事——建立 `isolate` / `intercept` 两个
原型链字典，用 `ReflectService.handler` 把自己包成 Proxy，然后挂上 `fiber`、`reflect`、
`registry`、`events`、`logger`。整个类 78 行。

`代码` `context.ts:55-77`：`extend()` 用 `Object.create` 造影子上下文；`isolate(name, label)` 为
一个名字建立独立符号域；`intercept(name, config)` 沿原型链累积配置覆盖。

**含义：上下文是一份可继承的"环境字典 + 两个覆盖层"，不是类继承树。** 这使"同一份代码在不同
项目/不同租户/不同环境下跑出不同行为"成为配置问题，而不是分支问题（见 §4.3 的 realm）。

### 2.2 Fiber 是"一个插件实例的生命周期 + 它的全部副作用"（`fiber.ts`）

`代码` `fiber.ts:78-85` 定义六个状态：`PENDING / LOADING / ACTIVE / FAILED / DISPOSED / UNLOADING`。

`代码` `fiber.ts:277-340` 是整套设计的心脏——`effect(execute, label)`：

- `execute` 立即执行，返回的 disposer 被收集；卸载或手动调用时**逆序**执行；
- 重复调用 disposer 是 no-op；
- 支持 `Promise`、同步/异步可迭代对象（生成器可边产出边注册）；
- 已卸载的 fiber 上再注册会抛 `CordisError('INACTIVE_EFFECT')`。

**含义：副作用不是"要注意清理"，而是"注册时就交出清理函数"。** 这是可安全热插拔的全部前提。

### 2.3 依赖是声明式的，不是编排式的（`registry.ts` + `fiber.ts`）

`代码` `registry.ts:17-40` `@Inject()` 装饰器在类或方法上声明依赖（可带 config 覆盖）；
`registry.ts:189-213` `plugin()` 把插件挂到上下文，解析 `plugin.inject` 后建 Fiber。

`代码` `fiber.ts:385-397` `_refresh()` 把依赖状态编码成一个 **epoch 字符串**：把它所有
`inject` 依赖所在 fiber 的 `uid` 拼起来；任一依赖缺失 → epoch 置为 `INACTIVE`。

`代码` `fiber.ts:399-415` `_setEpoch()` 比较新旧 epoch：从 `INACTIVE` 变为可用即 `_reload()`，
反过来即 `_unload()`；用 `inertia` 串行化，避免并发重载打架。

**含义：加载顺序不是启动脚本，而是依赖关系的结果。** 依赖上下线会自动带动消费者重启，
且 `_reload`/`_unload` 互为镜像（`fiber.ts:417-460`），失败只 `logger.error` 不炸进程。

### 2.4 服务可见性由依赖检查强制（`reflect.ts`）

`代码` `reflect.ts:62-100` Proxy 的 `get` 拦截：访问一个未在自己 `inject` 列表里声明的服务，
抛 `cannot get property "x" without inject`；查找时沿父 fiber 上溯，并逐层比较 `isolate` 键，
跨隔离域拿不到。

`代码` `reflect.ts:177-229` `provide()` 注册服务本身就是一个 effect：disposer 里删 store、
`notify()`、然后 `await` 所有依赖者收敛——**先通知依赖者，再清理自己**，避免"服务没了但消费者还在用"。

**含义：服务边界是运行时不变量，不是团队约定。** 取不到就是取不到，不存在"偷偷 import 实现"。

### 2.5 事件是唯一的横切扩展点（`events.ts`）

`代码` `events.ts:14` 五种分发模式：`emit | parallel | serial | bail | waterfall`。
`代码` `events.ts:89-132` 逐一实现；`waterfall` 是环绕中间件——监听者收到 `(...args, next)`，
调用 `next()` 委托下游，不调用即短路。

`代码` `events.ts:134-167` `on()` / `once()` 内部都走 `ctx.fiber.effect(...)`：**监听器是副作用，
随 fiber 卸载自动注销**，不需要手写 off。

`代码` `events.ts:178-188` 框架自身也用同一套事件表：`internal/service`、`internal/update`、
`internal/dispatch`、`internal/get/set` 等。

**含义：策略（拦截、改写、审批、配额）一律走事件，能力调用一律走服务方法。** 这条分工是
"不改内核就能加行为"的关键（`论文` 亦将此称为 context 对 effect 与 coeffect 的统一中介）。

## 3. 生命周期：激活 / 失效 / 重载 / 卸载

`代码` `fiber.ts:229-273` `_execute()` 是唯一的执行入口，负责解释 effect 的合法形状
（函数 / thenable / 可迭代 / 异步可迭代），非法形状抛 `TypeError('Invalid effect')`；
异步迭代时每次循环前检查 epoch 是否已变（`fiber.ts:263`），已变立即停止。

`代码` `fiber.ts:417-460` 重载与卸载的镜像关系：`_reload` 执行 effect，若期间 epoch 又变则转入
`_unload`；`_unload` 逆序清理，若期间 epoch 又变则转回 `_reload`。`inertia` 保证两者不并发。

`代码` `fiber.ts:478-495` `update(config, noSave)` 先跑 `internal/update` **waterfall**，
允许监听者否决或替换重启——热更新（HMR）就是挂在这条 waterfall 上的一个消费者。

`代码` `fiber.ts:462-476` `await()` 等待当前转换结束并**重新抛出**启动错误，`restart()` 是
"先卸载再按现配置重载"。

**含义：运行时的每一次变更都收敛到同一套 epoch 机制，因此"改配置→重载→失败回滚"是框架内置行为，
不需要每个插件自己实现。** 这正是我们敢于让 agent 在线自进化的依据（见设计文档 07）。

## 4. 声明式装配：把"系统组成"变成可协调的数据

### 4.1 条目树按 id 做 diff（`loader`）

`代码` `loader/src/config/group.ts`：`EntryGroup.update(config)` 以 `id` 为键比较新旧条目列表，
新增者 `create`、消失者 `remove`；`代码` `config/group.ts:create` 里更新父引用与 options，
保证条目被移到别的组后归属跟随。

### 4.2 隔离域与配置覆盖（`loader/src/config/isolate.ts`）

`代码` `isolate.ts:22-60` 定义 `Realm`（Symbol 域）、`LocalRealm`（后缀 `#<entryId>`）、
`GlobalRealm`。`代码` `config/isolate.ts` 还允许条目自带 `isolate` 与 `intercept` 字段。

**含义：同构能力可以按条目各自实例化**——多项目、多租户、多参与方各自持有独立服务命名空间，
互不串味。这是本系统做"承包商侧/供应商侧数据主权"的直接抓手。

### 4.3 patch 与 journal：运行时改动如何与文件协调（`include`）

`代码` `include/src/patch.ts:47-109` `applyPatches()` 先 `structuredClone` 基线再叠加 patch；
patch 可整体替换某条目的 config，也可 `insert` 到某个 group。
`代码` `patch.ts:141-184` `PatchIndex` 记录"某个条目的某个键归谁所有"：文件、某个 patch、
还是某次运行时插入。`代码` `patch.ts:191-261` `routeJournal()` 据此把运行时改动写回正确的所有者。

`代码` `include/src/journal.ts:195-242` `reconcile()` 是**三方协调**：`base`（上次共识）、
`theirs`（新文件）、`journal`（运行时累积的未落盘改动）。冲突策略明确：**文件赢**——
冲突键从 journal 删除并上报；`mergeRecords()`（`journal.ts:45-62`）把同一 id 的多次改动折叠，
"创建后又删除"的记录直接消失。

**含义：这套语义可以直接搬到"双方各自账本 + 远端来的改动"的同步上。** 详见设计文档 03 与 ADR-0003。

## 5. 理论映射（论文摘要原文）

`论文` 两个正交维度：**时间可组合性**（组件移除时其副作用可完全回退）与**空间可组合性**
（组件间依赖可声明并被响应式管理）；实现手段是把经典的 effect 与 coeffect 提升为运行时机制：
**revertible effects**（每次上下文变换携带运行时保存的逆）与 **reactive coeffects**
（每次上下文变化按组件的 coeffect 规格分类，驱动其激活/失活）；再把两者统一成单一 context 类型，
所有 effect/coeffect 都经它中介，称为 **context paradigm**；由此给出动态组合演算，把可组合性
从单个组件提升到整个交错组件系统。论文声称实现于 Cordis（含 effect 追踪、coeffect 解析、
声明式加载器与配置协调、热模块替换），并以 Koishi 插件生态为案例。

实现对应关系（`代码` 侧）：

| 论文概念 | 代码落点 |
|---|---|
| revertible effect | `fiber.ts:277-340`（disposer 收集与逆序执行）+ `reflect.ts:177-229`（provide 是 effect） |
| reactive coeffect | `inject` 声明 + `fiber.ts:385-415`（epoch 比较）+ `reflect.ts:207-229`（notify 反向扫描消费者） |
| 单一 context 类型 | `context.ts:55-77`（`extend` 影子上下文，隔离与配置覆盖都在同一类型上） |
| 声明式组件加载与配置协调 | `loader`（条目树 id diff）+ `include`（patch/journal 三方协调） |
| 热模块替换 | `hmr` 包 + `fiber.ts:482` 的 `internal/update` waterfall 否决点 |

## 6. 边界与限制（诚实清单）

1. `论文` 摘要本身即是形式化声明；`[推断]` 形式化保证能否覆盖真实异构系统（跨进程、跨组织、
   外部不可回退动作）不在此文范畴。**撤回一个已发出的采购承诺，不是回滚一个函数。**
2. 代码层面：`README.md` 明确 API 未稳定；`loader/README.md` 无文档；`_updateState` 处留 `FIXME internal/fiber-info`；
   `reflect.ts` 内有 `TODO enhance error message`。
3. **可撤销 ≠ 可证明正确**：框架只保证你交出的 disposer 会被调用；disposer 是否真能清干净是你的责任。
4. **不是沙箱**：Cordis 不隔离不受信的代码，隔离域（realm）是命名空间语义而非安全边界。
5. **没有跨进程/跨组织语义**：Cordis 是单进程内框架；跨组织协作必须由我们自己在协议层设计
   （设计文档 03 的 QEP）。
6. `[二手]` 第三方解读提到的 "Koishi 4000+ 插件验证"、"DeepSeek Harness 220k star" 等数字来自
   博客与 GitHub 页面快照，未经独立核实；引用时须标明来源与时间。
7. `论文` 提到的 N-Coord / SynTagma / neXus FIH 黑板等概念**不在论文摘要中出现**，来自某个第三方
   分析页面，未核实，本文不作为设计依据。

## 7. 结论（对本文档集的意义）

Cordis 提供的不是"一个 agent 框架"，而是**一套让系统组成可被安全改写、且每次改写都自动收敛的
运行时纪律**。对一个"由 agent 长期在线实现并自我改进"的采购-报价系统，这恰好是关键能力：
能力可热插拔、依赖自动协调、副作用随插件卸载全部回收、组成以数据形式存在文件里可被 agent 编辑。
本设计据此展开，映射见 `cordis-design-strengths.md`，落地见 `../design/01-architecture.md`。
