# 证据索引归档 B（P2 product；主文件在 `INDEX-P2.md`）

<!-- budget: 8 KB（docs/work/evidence/*.md，见 docs/design/12-documentation-standard.md §1） -->

本文件是 `docs/work/evidence/INDEX-P2.md` 的**第二份归档分册**（最早的 `INDEX-P2-archive.md` 已到
7692/8192 B）：主文件与各分册合计仍是同一份索引，行**整行逐字**搬入、内容未改。

| 证据 | 内容 | 关联 | 阶段 |
|---|---|---|---|
| EV-168 | **运行期装卸（`--live`）+ `user-space` 单一源 + `./run logs|config init`**（`T-317`）：① 运行中的服务真能装卸：`tools/plugin.sh <动词> <插件> --live`／`./run plugin …` → 控制通道 `POST <prefix>/api/plugins/control`（注册在**路由注册面** `host/lib/ui-route.mjs`）→ 在长驻 webui 自身 ctx 树里真装 ⇒ 装载后其只读区块**真出现在页面上**（`data-ui-block=…`），卸载后消失且**页面其余部分逐字节不变**（sha256，迁移计划 §5.3 那条未验断言）；`reload` 新 uid 且 effects 3→3 不泄漏；四道围栅 fail-closed（令牌不配 = 通道关闭 / 显式 confirm / system 层锁 / 只认显式动词与 id）；装卸全程零写面 ② 修真缺陷：`inner.provide = …` 抓句柄污染**全树** provide ⇒ 后装载插件把服务注册在别人 fiber 上、卸载留残注册（运行期再装载必红）→ 改 `ctx.get(...)` + 门 D5 ③ `user-space/**`→`src/userspace/**` **单一源**（兼容符号链接；产物字节/哈希未变）④ `./run logs`（路径 + 有界尾部；缺日志如实失败）与 `config init`（只含白名单键 36 个、不覆盖已有真配置、指纹 + 逐条 next_action、0600、不写账本）⑤ 门：`plugin-lifecycle` 44→**59/59**、`run-once` 18→**34/34**（8 处变异全红 + 基线不红 + 产品树字节不变）、`user-space` 21/21，docs/ac-registry/webui 51/51/modules/wiring 5/5/plugins 5/5/coverage 8/8 全绿；空 HOME + 断网（`tools/netblock.c` 垫片，含非空转自证）下 up 成功、不写 HOME、零次非回环连接尝试 | AC-PLUGIN-001/005/006, AC-RUNTIME-010 / T-317 | P2 |
| EV-169 | **52 个插件逐个补齐独立需求文档 + 位置口径定案**（`T-318`，只动文档 + 一处门的变异锚点）：① 63/63 插件都有独立需求文档 —— 52 份新写 + 6 份核心改名统一带层前缀（`docs/work/plugin-requirements-<层>-<插件>.md`，模板与逐段口径见映射表 §4；每份含 用途 / 归属行（FR + 承载体 + 关联 AC + 可跑命令）/ provides 与依赖（实测 import）/ 门（证据列展开）/ 现状与缺口）② **缺口 52 → 0**（映射表 §5 复算命令算出，不手写）③ **位置口径定案**（27 §2.4 + 映射表 §4）：不先建裸目录（反向验证实测：裸 `src/system/webui/` 让 `deps` 的 `missing_targets` 从 `["system/webui"]` 变 `[]`，`plugin.sh list` 把假目录枚举成 `manifest-missing`）⇒ 文档落 `docs/work/`、建目录时 `git mv`，§4.2 逐条登记 58 份位置偏差 ④ 映射表 §3 偏差表整表拆到 `plugin-requirements-deviations.md`（守住 32 KB）⑤ **互证**：58 份文档的 FR 行集合 == 映射表认领集合（并集 166、缺 0、重复 0；引用的 AC/门名都在定义集合与 `verify.sh` 里）⑥ 六道门全绿（在本批提交树的干净副本上复跑：`plugin-requirements` 17/17、`docs` PASS、`plugin-lifecycle` 59/59、`coverage` 8/8、`ac-registry`、`plugins` 5/5） | AC-DESIGN-001 / AC-PLUGIN-004 / T-318 | P2 |
