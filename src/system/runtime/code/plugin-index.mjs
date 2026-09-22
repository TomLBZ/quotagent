/**
 * 进树模块的**自动发现**入口：目录即清单。
 *
 * 纪律（用户 2026-09-21："项目的每个功能都应被插件提供" + "每个功能模块可分别独立演进"）：
 *   · 新增一个功能 = 新增一个 `host/modules/<name>.mjs`（cordis 插件），**不需要**改中心清单；
 *   · 每个模块自带 `fixture.sample()` 采样点（A5 确定性断言用），因此新插件也不改检查器；
 *   · 模块与 profile 的装配关系仍在 `host/profiles.mjs`（组成即数据，ADR-0015），
 *     本文件只负责"发现有哪些模块可用"，不决定谁被挂载。
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 实体搬迁（迁移阶段 5，本批 `EV-178`）：本文件从 `host/modules/index.mjs` 搬到
// `src/system/runtime/code/plugin-index.mjs`，旧路径只剩**薄重导**。**语义一格未改**：目录即清单的真源
// 仍是仓库里的 `host/modules/`（`code/` → 插件 → 层 → `src/` → 仓库根，共 4 层上溯）；
// 「新增一个功能 = 新增一个 `host/modules/<name>.mjs`」这条纪律不变（搬完实体后，那里是薄重导，
// 但**新增文件即新增插件**的性质不变 —— 自动发现仍只看目录，不看清单）。
const MODULES_DIR = join(HERE, '..', '..', '..', '..', 'host', 'modules')

/** 目录里所有模块文件名（不含 `index.mjs` 自身，按名字排序 → 确定性）。 */
export const moduleFiles = () => readdirSync(MODULES_DIR)
  .filter((file) => file.endsWith('.mjs') && file !== 'index.mjs')
  .sort()

/** 动态加载全部模块，返回 `{ name, file, module }` 列表。 */
export async function loadModules({ only = null } = {}) {
  const out = []
  for (const file of moduleFiles()) {
    if (only && !only.includes(file.replace(/\.mjs$/, ''))) continue
    const module = await import(pathToFileURL(join(MODULES_DIR, file)).href)
    out.push({ name: module.name ?? file.replace(/\.mjs$/, ''), file, module })
  }
  return out
}
