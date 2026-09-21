# 运行时陷阱（宿主/桥/shell）

> 门与流程类陷阱在 [`pitfalls.md`](pitfalls.md)。

- **cordis 的注册/派发必须在插件 fiber 内**：在根 context 上 `events.on(...)` 或 `events.bail(...)` 会
  `TypeError: Cannot read properties of null (reading '_hooks')`（根 fiber 为 null）。写宿主插件时，
  监听器一律在 `apply(ctx)` 里注册。
- **别自造 `internal/update`**：cordis 内置了配置更新链（`fiber.update()` → `waterfall(fiber,'internal/update',…)`，
  链尾才落 `fiber.config` 并 `restart()`；监听器不调 `next()` 即短路=否决）。自造同名事件会与内置语义打架，
  正确做法是只写规则、复用上游链路（ADR-0015）。
- **`tools/*.sh` 是 POSIX sh**：`${@:2}`、`[[ ]]` 之类 bash 写法会 `Bad substitution`；传参用 `shift` + `"$@"`。
- **先写再读**：`Ledger` 在构造时加载文件，之后由别的实例写进去的记录它看不到——采集指标/校验前
  必须**在写入之后**再构造（或用新实例读）账本，否则指标 basis 全是 0。
- **cordis 的 `inject` 不能写内建 mixin**：`inject: ['events']` 会让插件**永远停在 pending**（`apply` 根本不执行），而 `inject: []` 与 `inject: ['norm']` 都正常 —— `ctx.events` 是 mixin，不是可 inject 的服务。写进 inject 不会报错，只会"什么都不发生"。同理：provided service 要在**插件自己的 ctx** 里取（外部取抛 "without inject"），fixture 想拿句柄就包装 `ctx.provide` 抓。

## 给宿主插件新增一个依赖：必须同步四处（T-236 → T-240 付了三次成本）

1. 模块自身：`inject`、`usedServices`、以及**请求期用的本地句柄**（`const x = ctx.x`，见 D-027）。
2. `host/check-modules.mjs` 的 STUBS 表：fixture 必须能 stub 每个被声明的依赖，否则 `verify.sh modules` 直接红。
3. `host/webui.mjs`（门）的**两处**挂载（主 probe + brokenCtx），两处 `inject` 都要同步。
4. `host/canary-dispatch.mjs` 的 e2e 挂载 + `host/cli.mjs` 的运行期挂载与输出（漏一处，对应门就红）。
附带纪律：包装挂载必须**照抄模块声明的 inject**（写 `inject: []` 会让模块取不到依赖）；合成模块对象
（`{apply, Config}`）必须**显式带 inject 字段**，否则 `mod.inject` 是 undefined、静默退回 `[]`（最危险）。
- **改服务入口脚本后必须真重启并回读**：`py_compile` / `node --check` 只能抓语法，抓不到"调用了未定义的函数"（本轮在 `webui-serve.py` 里先写了 `probe()` 的调用、函数定义却没落盘 → `NameError` → 健康探测失败 → 服务起不来、公网 502）。另外**相对路径在生产 cwd 下会失效**：宿主读落盘文件一律走**绝对路径**（由服务脚本以参数/环境变量传入，同既有 ledger 参数做法）。

- **断言不得依赖未跟踪数据**（`tmp/` 下的演示账本/快照都是 gitignored）：门里的断言若读它们，
  干净副本里必然红（`clean-copy` 门就是抓这个的）。正解：门**自带夹具**（mkdtemp 写夹具 + 挂载时传路径），
  断言只依赖自己造的数据；真数据非空的断言放**另一个**门（跑真种子的那个）。
- **`clean-copy` 校验的是 HEAD，不是工作树**：所以它**不能**放进"提交前"的 `&&` 链（会死锁：HEAD 里还没有修复）。
  正确次序：`verify.sh docs && <本批相关门>` → `git commit` → `push` → **对新的 HEAD 跑 `verify.sh clean-copy`** →
  若红则再修再提交。看到它红就提交是错的（我这轮犯过）。
- **多 agent 并行时不要 `git add -A`**：会把 subagent **在途**的编辑一起提交（提交信息与范围不符），
  也会让正在跑的门瞬时变红。按文件显式 `git add <我改的>`。
- **路由/适配层要按键白名单投影，不要原样透传**：上游（哪怕是自己写的写入器）混进正文或私域键时，
  透传就等于泄漏。投影 + 在夹具里放哨兵（`SECRET-BODY`/`private:`）当负控。
- **性质类断言写完必须当场变异自证**（有界 / 定序 / 投影 / 幂等 / 只读 / 不写账本）：改一处实现 →
  门必须真红 → 还原并核对 sha256。抓不到偷改的断言只是装饰（`verify.sh ui-mutate`，D-057）。
  变异脚本要**自带防假变异**（锚点未命中或字节没变 → 判"假变异"并失败），并放 `tools/` 挂成门
  —— 放 `tmp/` 会被 gitignore，证据得能再跑一次才算证据。
