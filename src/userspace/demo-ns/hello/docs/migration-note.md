# 迁移留档：`user-space/demo-ns/hello/` → `src/userspace/demo-ns/hello/`（阶段 5.1）

本文件是**留档**，不是实现：它逐字保存收敛前那份旧实现，并说明为什么删得下手。

## 收敛前的旧实现（逐字，12 行，`user-space/demo-ns/hello/index.mjs`，sha256 以恢复脚本为准）

```js
// 用户空间插件（演示）：只在自己的命名空间里注册服务；不碰平台保留名，不写别人目录。
export const name = 'hello'
export const inject = []
export const provides = ['bucket', 'status']
export const Config = undefined

export const apply = (ctx, config) => {
  const store = new Map()                       // 独立 instance 的状态：只在本次挂载里可见
  ctx.provide('bucket', {
    put: (k, v) => { store.set(String(k), String(v)); return { ok: true, size: store.size } },
    get: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
  })
  ctx.provide('status', { version: config?.version ?? '1.0.0', ns: config?.ns ?? 'demo-ns' })
}
```

（旧实现删于迁移本批；仓库历史里仍可回取：`git log --diff-filter=D -- 'user-space/demo-ns/hello/index.mjs'`。
旧目录本身从不入库 —— `.gitignore` 的 `user-space/` 规则把它当作运行时产物。）

## 为什么删得下手（不丢内容、不丢能力）

| 旧实现的每一条能力 | 收敛后的落点 |
|---|---|
| `provide('bucket')` → 装载期命名空间化 `demo-ns.hello.bucket` | `code/index.mjs` 同名服务（同一命名空间键） |
| `bucket.put/get` | 同（另加 `size()`，是超集） |
| `provide('status')` → `demo-ns.hello.status` | 同（另加 `plugin: 'hello'` 字段，是超集） |
| 独立 instance 状态（`new Map()`） | 同（仍在 `apply` 里建，卸载即随实例消失） |
| 由隔离内核装载（`host/lib/user-space.mjs`） | **仍然可**：插件在拿到 `config.prefix` 时注册基础名 `bucket`/`status`，由该内核命名空间化（不重复加前缀） |

超集之外**新增**的两件事（不是删掉的东西）：① 平台装载器路径（自己注册
`demo-ns.hello.<svc>`，供 `tools/plugin.sh` 六动词与运行期装卸用）；② 向 WebUI 注册面提交一个只读区块。

## 事实源纪律（本批的收敛结论）

- 唯一事实源：`src/userspace/demo-ns/hello/`。
- `user-space/` = 指向 `src/userspace/` 的**兼容链接**（tracked symlink；旧路径的读方不必改一行）。
- 两份用户插件（本插件 + `con-a/quote-trend`）的产物字节与声明哈希都没变（见 `plugin.json.sha256` 与
  `docs/work/evidence/EV-1xx` 的原始行）。
