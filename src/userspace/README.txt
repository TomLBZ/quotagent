user-space/ —— **兼容链接**（已迁移；唯一事实源是 `src/userspace/`）

本目录现在是指向 `src/userspace/` 的符号链接。为什么留着它：旧路径被这些读方引用着
（`tools/webui-serve.py` 的 `--user-space-root` / `--market-user-space`、`host/lib/user-space.mjs` 的默认根、
若干宿主门与 `tools/storage.py`）—— 留一个链接就不必让它们各自改一遍，而**事实源只有一处**：
`src/userspace/**`（可 `git ls-files src/userspace` 直接看到）。

· 插件布局：`src/userspace/<ns>/<plugin>/{plugin.json, README.md, requirements/, docs/, code/, tools/, tests/, data/}`
  —— 硬规范 `docs/design/27-plugin-architecture.md` §2.1；清单最小契约见同文档 §3.1。
· 一行命令（六动词）：`tools/plugin.sh list|status|load|reload|unload|deps`；
  装进**运行中的服务**加 `--live`（运行期装卸契约见 `src/system/runtime/docs/lifecycle-contract.md`）。
· 隔离四件套（独立 instance / 独立服务命名空间 `<ns>.<plugin>.<svc>` / 独立文件根 / 独立凭据作用域）：
  `host/lib/user-space.mjs`；详细契约 `docs/design/22-plugin-market-and-user-space.md`。
· 提权（用户空间插件 → 系统级插件，必须过人工门 + ADR-0016 五条 AND + 影子哈希一致）：
  `tools/userplugin-elevate.py`；写入面仍是 `host/modules/`，并落 `userplugin/elevated` + `evolve/promoted`。

迁移事实（本批，阶段 5.1）：两份用户插件（`con-a/quote-trend`、`demo-ns/hello`）的产物字节与声明哈希
**未变**（详见各自 `docs/migration-note.md`）；`demo-ns/hello` 的旧 12 行实现在其 `docs/migration-note.md` 里逐字留档。
