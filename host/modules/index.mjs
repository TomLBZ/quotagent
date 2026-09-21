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

/** 目录里所有模块文件名（不含 `index.mjs` 自身，按名字排序 → 确定性）。 */
export const moduleFiles = () => readdirSync(HERE)
  .filter((file) => file.endsWith('.mjs') && file !== 'index.mjs')
  .sort()

/** 动态加载全部模块，返回 `{ name, file, module }` 列表。 */
export async function loadModules({ only = null } = {}) {
  const out = []
  for (const file of moduleFiles()) {
    if (only && !only.includes(file.replace(/\.mjs$/, ''))) continue
    const module = await import(pathToFileURL(join(HERE, file)).href)
    out.push({ name: module.name ?? file.replace(/\.mjs$/, ''), file, module })
  }
  return out
}
