# 需求归属（userspace/con-a/quote-trend）

本插件的需求来源是**使用者的原话**（`plugin.json.created_from`），它不发明平台级需求；下面这些 FR 是它
落地时**必须同时满足**的平台纪律（逐条可在门里复现）：

| FR | 本插件怎么满足 | 在哪能被验 |
|---|---|---|
| FR-USERPLUG-001 | 用户自己决定业务功能，不耦合进平台：`inject=[]`，不消费任何平台服务 | `tools/verify.sh user-space` |
| FR-USERPLUG-002 | 写面只有自己的文件根：只 append `data/observations.jsonl`，不写平台/别人的 ns/仓库外 | `tools/verify.sh user-space`、`storage` |
| FR-USERPLUG-006 | 服务只注册在自己命名空间（`con-a.quote-trend.*`），平台保留名一个不碰 | `tools/plugin.sh status`、`user-space` |
| FR-USERPLUG-009 | 自包含：纯标准库 ESM、零第三方、零子进程/网络/随机/定时器 | `tools/verify.sh user-space`（静态负控） |
| FR-STORAGE-006 | 观测日志是**只读面 + append-only 写面**：`observationLog.path()/stats()` 只读 | `tools/verify.sh storage` |
