# 迁移留档：`user-space/con-a/quote-trend/` → `src/userspace/con-a/quote-trend/`（阶段 5.1）

## 搬了什么

| 旧路径 | 新路径 | 字节 | sha256 |
|---|---|---|---|
| `user-space/con-a/quote-trend/index.mjs` | `src/userspace/con-a/quote-trend/code/index.mjs` | 11742（未变） | `dffeff77fbf497048efd0b4c5f592025821efb56441925adf9e57c94c8086db7`（未变） |
| `user-space/con-a/quote-trend/plugin.json` | `src/userspace/con-a/quote-trend/plugin.json` | 变（合并清单：加 `layer`/`entry`，`artifact` 改指 `code/index.mjs`） | — |
| `user-space/con-a/quote-trend/data/observations.jsonl` | `src/userspace/con-a/quote-trend/data/observations.jsonl` | 297（未变） | `33f46dbe63904e125a1ceff59369beccc63c13d4b42b332e3fb5062c777368fe`（未变） |

## 为什么 `artifact` 要改指 `code/index.mjs`

标准目录布局（`docs/design/27-plugin-architecture.md` §2.1）把实现放在 `code/`。搬的是**同一份字节**，
只改了清单里的指针与目录位置 —— 所以 `plugin.json.sha256` 仍等于产物实测哈希（装载器会核这一条：
`host/lib/user-space.mjs` 的 `artifact-hash-mismatch`）。

## 与 `docs/work/plans/plugin-file-map.md` 的一处偏差（如实登记）

那份附件表把本插件的映射写成 `user-space/con-a/quote-trend/index.mjs → src/userspace/con-a/quote-trend/index.mjs`
（相对路径不变）。本批按硬规范 §2.1 落成 `code/index.mjs`，因此该行已同步更新（同一附件表的表尾注记）。
