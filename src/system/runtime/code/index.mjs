/**
 * 进树插件入口：`src/system/runtime/`（**阶段 1**：契约工具是本批**新增**，宿主运行时载体仍是 wrapper）。
 *
 * 本插件的两块东西，先说清哪个是"新写的"、哪个是"还没搬的"：
 *   ① **新增**（阶段 1 本批）：`code/plugin-registry.mjs` + `tools/plugin-lifecycle.mjs`
 *      —— 「一切皆插件」的六动词实现（目录即清单 / 最小契约校验 / 依赖闭包 / 真装载 / 真卸载）。
 *      规则真源 `docs/design/27-plugin-architecture.md` §1–§4；契约见本插件 `docs/lifecycle-contract.md`。
 *   ② **仍是 wrapper**：仓库内自包含运行时的既有载体 `tools/runtime.sh`（解释器解析）、
 *      `tools/run.sh`（PYTHONPATH=src 入口）、`tools/bootstrap.sh`（仓库内 .venv）、
 *      `src/quotagent/paths.py`（路径解析）、根目录 `./run`（一键运行）—— 阶段 3.2 实体搬迁；
 *      本文件**只重导出**它们的公开事实（`runtimeFacts()`），不复制逻辑（一处一事实）。
 *
 * 装配（`host/cli.mjs` 与 `./run`）通过 `ctx.plugin()` 挂本插件；装载后提供只读服务面 `pluginLifecycle`：
 * 其它插件可以问"有哪些插件 / 这个插件在哪一层 / 它的依赖闭包是什么"，而**不必**自己扫目录。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import * as registry from './plugin-registry.mjs'

export * from './plugin-registry.mjs'

export const name = 'runtime'
export const inject = []
export const provides = ['pluginLifecycle']
export const builtin = []
export const usedServices = []
export const Config = undefined

/** 仓库根（从本文件上溯 4 层：`src/system/runtime/code/` → 仓库根）。 */
export const REPO_ROOT = registry.repoRootOf(fileURLToPath(import.meta.url))

/**
 * 既有运行时载体（**只列存在与否与路径**，不复制它们的内容）：阶段 3.2 实体搬迁前，这里就是"实现还在哪"的真源。
 * 门 `plugin-lifecycle` 据此断言"wrapper 指向的文件真的存在"（不存在 ⇒ 红，防"wrapper 指向空气"）。
 */
export const EXISTING_CARRIERS = ['tools/runtime.sh', 'tools/run.sh', 'tools/bootstrap.sh',
  'src/quotagent/paths.py', 'run']

export const runtimeFacts = (root = REPO_ROOT) => ({
  root,
  carriers: EXISTING_CARRIERS.map((rel) => ({ path: rel, present: existsSync(join(root, rel)) })),
  interpreter_order: ['$QUOTAGENT_PY', '.venv/bin/python', '$WS_VENV/bin/python', 'PATH'],
  host_dependency: 'cordis@4.0.0-rc.10（host/node_modules，阶段 4.4 搬进本插件）',
  python_third_party: '零（ADR-0007）',
})

/** 装载：把**只读**注册表面（目录即清单 + 依赖闭包）提供给其它插件。 */
export function apply(ctx, config) {
  const root = config?.root ?? REPO_ROOT
  ctx.provide('pluginLifecycle', {
    root,
    /** 全部插件（目录即清单；`plugins[].invalid` 为真的目录不是插件）。 */
    scan: () => registry.scan(root),
    /** 某插件（按 id）或 `{ok:false, code}` 拒收体。 */
    plugin: (id) => registry.findPlugin(registry.scan(root), id),
    /** 依赖闭包（`depends_on` + `inject` 服务键；有环给环上的 id）。 */
    deps: (id) => registry.depsClosure(registry.scan(root), id),
    /** 运行时事实（解释器解析顺序 / 宿主依赖 / 既有载体在不在）。 */
    facts: () => runtimeFacts(root),
    /** 本插件不做装载/卸载：那是 `tools/plugin-lifecycle.mjs`（唯一写入者）与运行时进程的事。 */
    verbs: () => [...registry.VERBS],
  })
}

export function disposer() {
  return () => {}
}
