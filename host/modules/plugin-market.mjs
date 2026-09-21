/**
 * plugin-market —— **插件市场/清单的只读聚合视图**（T-267 候选产物；晋升后落 `host/modules/plugin-market.mjs`）。
 *
 * 契约（逐字）：`docs/work/plans/p3-spec.json` 的 FR-MARKET-001..006 与 AC-MARKET-001..006；
 * 设计：`docs/design/22-plugin-market-and-user-space.md` §1/§6；围栏门：`host/t267-market-gate.mjs`。
 *
 * 为什么需要它：`14-plugin-inventory.md` 是"功能有归属"的登记真源，`host/modules/*.mjs` 是进树事实，
 * `user-space/<ns>/<plugin>/plugin.json` 是用户空间登记真源 —— 三者此前**从没有人对过账**。
 * 本模块把三个真源并成一张只读清单：谁是人写的、谁是自进化产的、谁来自用户空间、谁**没被任何 profile 装配**。
 *
 * 纪律（每条都有 `host/t267-market-gate.mjs` 的断言看着）：
 *   · **只读面**（FR-MARKET-004）：只 `readdir`/`readFile`；不写文件、不下载、不起子进程、不写账本、
 *     不订阅事件、不注册定时器；对进树模块**只构造路径、不读它的源码**（不解析、不 import）；
 *     "安装/提权"只输出指向既有门的**引用**，本模块自身不落任何产物；
 *   · **只组合、不自算**（FR-MARKET-001）：`provides` 与装配状态**照抄**清单行/`plugin.json`，
 *     不从模块源码重新推导（重算等于另立口径，也等于把"清单没登记"这件事抹平）；
 *   · **三源不一致即报**（FR-MARKET-003）：仅目录有 / 仅清单有 / 仅用户空间有 / 与用户空间同名 /
 *     哈希不一致 / 哈希不可校验 / 清单重复登记 / 用户空间重复登记 —— 一律进 `differences` 并置
 *     `inconsistent:true`；**不得取其一静默**；
 *   · **降级优先**（FR-MARKET-006）：源不可读/坏/某个用户空间清单读不出来 → `degraded:true` + `reason`
 *     + `next_action`，形状与正常输出**同一形状**、绝不抛异常，也绝不返回"看起来健康的零插件清单"；
 *     **零插件 ≠ 读不到**：前者的 `degraded=true`，后者（三个源都读得通、确实一件都没有）`degraded=false`
 *     但 `reason` 仍显式写 `sources-empty`（AC-MARKET-006 逐字要求两者可区分，且两种情形都不许报"健康"）；
 *   · **有界**（FR-MARKET-005）：条数封顶 `max_items`（超出在 `omitted_items` 报数）、`provides` 与
 *     `differences` 的字符串按 UTF-8 字节夹到 `max_bytes`（超出在 `clipped` 报数）→ `truncated:true`；
 *     `counts` 是**夹取前**的真值（`counts.total === items.length + omitted_items`）——展示可以有界，
 *     数字不许悄悄变小；
 *   · **确定性**：不读墙钟、不随机；条目按名称→来源→路径稳定排序，差异按**固定的种类顺序**拼接 →
 *     同一份输入两次 `snapshot()` **字节一致**；
 *   · **注入模式**（`snapshot(sources)`）：三个真源可由调用方在内存里给出（**零 I/O**）—— `fixture.sample`
 *     （A5 确定性）与围栏门的手算正控都吃它；生产模式不给参数，从 `Config` 的三个路径只读。
 *
 * 口径备忘（确定性优先，逐字照需求，不做主观例外）：
 *   · `source` 判定：目录有且清单行里出现 `自进化` / `subagent` / `ap-` → `evolve`；用户空间源 →
 *     `user-space`；其余 → `human`。**已知代价**：`canary` 行的能力描述写的是"自进化产物的真实路由分流"，
 *     按字面口径会被判成 `evolve`（真实数据下 evolve=14 / human=11）。口径宁可粗糙也不加"看起来应该"的例外，
 *     门里把这一项单独断言出来，不藏。
 *   · `wired`：清单行的"装配"列非空（且不是"未接线/未装配/unwired"这类显式空写）**或**
 *     profile 名单里有这个名字 → `true`；两处都找不到 → **显式 false**（进 `counts.unwired`，不隐藏）。
 *   · profile 名单来自 `<modules_dir>/../profiles.mjs`（按 `modules: [...]` 抽取，不 file-import 它）；
 *     读不到就退回清单列，**不降级、不猜**。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'plugin-market'
export const inject = []            // 纯函数插件：三个真源由 Config 给路径（或调用方在内存里给）
export const builtin = []
export const usedServices = []
export const provides = ['pluginMarket']

export const Config = object({
  modules_dir: string().default(''),     // 真源 ①：目录里的 `*.mjs` 文件名
  inventory: string().default(''),       // 真源 ②：清单文档的登记行（`docs/design/14-plugin-inventory.md`）
  user_space: string().default(''),      // 真源 ③：`*/plugin.json`（目录不存在 → 按空处理，不是降级）
  max_items: number().default(200),      // 条目数上限（有界）
  max_bytes: number().default(256),      // 每个 `provides`/`differences` 字符串的 UTF-8 字节上限（有界）
})

/** 输出里的 `source` 字段（门据此确认"这份输出是谁给的"）。 */
const SOURCE_NAME = 'plugin-market'
/** 条目字段白名单（按键投影：多余的键一个都不出）。 */
export const ITEM_KEYS = ['name', 'source', 'wired', 'provides', 'file']
/** `counts` 键（顺序即输出顺序）。 */
export const COUNT_KEYS = ['human', 'evolve', 'user_space', 'total', 'unwired']
/** 顶层键（降级与正常输出**同形状**；门断言两者形状一致）。 */
export const OUTPUT_KEYS = ['items', 'counts', 'inconsistent', 'differences', 'truncated', 'omitted_items',
  'clipped', 'degraded', 'reason', 'next_action', 'source']
/** 目录里**不是插件**的文件（模块发现入口；口径抄 `tools/check-plugin-inventory.py` 与 `host/check-modules.mjs`）。 */
export const NON_PLUGIN_FILES = ['index.mjs']
/** `source` 枚举（顺序即 `counts` 里的三格）。 */
export const SOURCE_KINDS = ['human', 'evolve', 'user-space']
/** 清单行标记：出现即认**自进化**来源（`ap-` 覆盖"带过人工引用的自进化产物"）。 */
export const EVOLVE_MARKERS = ['自进化', 'subagent', 'ap-']
/** 装配列"没有装配"的**精确**写法。 */
export const UNWIRED_EXACT = ['', '-', '—', '–', '无', '（无）', '(无)', '没有', '未装配', '未接线',
  'unwired', 'none', 'N/A', 'n/a']
/** 装配列里"没有装配"的**子串**标记（"未接线"等写在一句话里也算）。 */
export const UNWIRED_MARKERS = ['未接线', '未装配', 'unwired']
/** 降级原因码（闭合集合；门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['modules-dir-unreadable', 'inventory-unreadable', 'inventory-malformed',
  'user-space-unreadable', 'user-space-malformed', 'market-read-failed']
/** 空结果的诊断码：**不是**降级（三个源都可读，只是确实一件都没有）。 */
export const EMPTY_REASON = 'sources-empty'
/** 用户空间清单文件名（设计 22 §1 的登记真源）。 */
export const USER_MANIFEST = 'plugin.json'
/** 差异种类（顺序＝输出顺序；门按这个顺序断言）。 */
export const DIFFERENCE_KINDS = ['仅目录有', '仅清单有', '仅用户空间有', '与用户空间同名', '哈希不一致',
  '哈希不可校验', '清单重复登记', '用户空间重复登记']
/** service 名形状（清单"提供者服务名"列的照抄白名单：`webui`、`priceHistory`、`canary-dispatch` 都过）。 */
export const SERVICE_RE = /^[a-z][A-Za-z0-9]*(?:-[a-z][A-Za-z0-9]*)*$/
/** 每个降级原因码对应的下一步（固定映射 → 输出确定；门断言映射覆盖闭合集合）。 */
const NEXT_ACTIONS = {
  'modules-dir-unreadable': '检查 plugin-market 的 modules_dir 配置：它必须指向宿主模块目录（host/modules）',
  'inventory-unreadable': '检查 inventory 配置：它必须指向 docs/design/14-plugin-inventory.md',
  'inventory-malformed': '清单文档不是可读文本（含 NUL/二进制）：从版本库重新取回 14-plugin-inventory.md',
  'user-space-unreadable': '检查 user_space 目录的权限与布局（<ns>/<plugin>/plugin.json）',
  'user-space-malformed': '用户空间里至少有一个 plugin.json 读不出来：修好它或移除该插件目录（不得静默少报）',
  'market-read-failed': '重试并逐个核对三个真源；本模块不猜也不掩盖（这是最后的兜底路径）',
}
/** 零插件的下一步（空结果必须给方向，不许交一份"看起来健康的零"）。 */
const EMPTY_NEXT_ACTION = '确认 modules_dir 指向宿主的模块目录：零插件清单要么是配置指错了目录，'
  + '要么是这批插件尚未进树'
const DEGRADED_HEADLINE = '插件市场不可用：不猜，不列条目'

/** 差异种类 → 键名（在 `buildView` 里按 DIFFERENCE_KINDS 的顺序取用）。 */
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

/** 配置夹取：非有限数回落到默认值，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符，结果字节数必然 ≤ maxBytes）。 */
const clip = (text, maxBytes) => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const posix = (path) => String(path).split('\\').join('/')

/** 用户空间清单读不出来 → 上层降级（**不得**当成"这个插件不存在"静默少报）。 */
const malformed = (detail) => {
  const error = new Error(`[user-space-malformed] ${detail}`)
  error.code = 'user-space-malformed'
  return error
}

const statOf = (path) => {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

const isDir = (path) => {
  const stat = statOf(path)
  return Boolean(stat) && stat.isDirectory()
}

/** 清单行标记 → 自进化来源（整行扫描：能力列/演进列里写都算）。 */
export const hasEvolveMarker = (text) => EVOLVE_MARKERS.some((marker) => String(text ?? '').includes(marker))

/** 装配列判定：精确空写或含"未接线/未装配/unwired"→ 没装配；其余（含 profile 名）→ 有装配。 */
export const isWiredCell = (wiring) => {
  const text = String(wiring ?? '').trim()
  if (UNWIRED_EXACT.includes(text)) return false
  return !UNWIRED_MARKERS.some((marker) => text.includes(marker))
}

/** 反引号里的标识串（service 名）——只放行 SERVICE_RE 形状，天然排除路径与占位词。 */
const backticked = (text) => [...String(text ?? '').matchAll(/`([^`]+)`/g)]
  .map((match) => match[1].trim())
  .filter((token) => SERVICE_RE.test(token))

/**
 * 读一条清单行 → `{name, file, provides, wiring, evolve}` 或 null。
 * **只认** §1 表里形如 `| `host/modules/<name>.mjs` | 能力 | 服务名 | 装配 | 演进 |` 的行：
 * 第一格必须是指向 `modules/` 的 `.mjs` 路径（清单里 §2 的 `host/lib/*.mjs`、§3 的 Python 行不是插件清单行）。
 * `provides` 里写成"见模块 `provides`"的地方**不猜**——照抄结果为 []（清单没给服务名就是没给）。
 */
export const readInventoryRow = (line) => {
  const trimmed = String(line ?? '').trim()
  if (!trimmed.startsWith('|')) return null
  const parts = trimmed.split('|')
  const cells = parts.slice(1, parts.length - 1).map((cell) => cell.trim())
  const match = /([A-Za-z0-9_./-]*)modules\/([A-Za-z0-9_-]+)\.mjs/.exec(cells[0] ?? '')
  if (!match) return null
  const declared = cells[2] ?? ''
  return {
    name: match[2],
    file: posix(`${match[1]}modules/${match[2]}.mjs`),
    provides: declared.includes('见') ? [] : backticked(declared),
    wiring: cells[3] ?? '',
    evolve: hasEvolveMarker(trimmed),
  }
}

export const readInventory = (text) => String(text ?? '').split(/\r?\n/)
  .map((line) => readInventoryRow(line))
  .filter((row) => row !== null)

/**
 * 读 profile 的装配名单（可选第二真源：`<modules_dir>/../profiles.mjs`）。
 * 读不到 → 空集合：装配判定退回清单行的"装配"列（清单是登记真源，**不降级、不猜**）。
 */
export const readProfileRefs = (modulesDir) => {
  const refs = new Set()
  if (!modulesDir) return refs
  try {
    const text = readFileSync(join(dirname(modulesDir), 'profiles.mjs'), 'utf8')
    for (const match of text.matchAll(/modules:\s*\[([^\]]*)\]/g)) {
      for (const item of match[1].matchAll(/'([^']+)'/g)) refs.add(item[1])
    }
  } catch {
    /* 没有 profiles.mjs：装配只看清单列（不进 degraded，也不在 differences 里编一条） */
  }
  return refs
}

/**
 * 造一条用户空间条目：`plugin.json` 是登记真源，字段**照抄**（不自算）。
 * `artifactText` 为 null 表示"拿不到产物正文"（磁盘读不到 / 内存模式没给）。
 * 清单不是合法 JSON / 不是对象 → 抛（上层降级：读不出来不许当成"没有这一项"）。
 */
const userEntry = ({ ns, plugin, file, jsonText, artifactText = null, readArtifact = null }) => {
  let json = null
  try {
    json = JSON.parse(jsonText)
  } catch {
    throw malformed(`plugin.json 不是合法 JSON：${file}`)
  }
  if (!isPlain(json)) throw malformed(`plugin.json 不是对象：${file}`)
  const declaredName = typeof json.name === 'string' ? json.name.trim() : ''
  const declared = typeof json.sha256 === 'string' ? json.sha256.trim() : ''
  let artifact = typeof artifactText === 'string' ? artifactText : null
  if (declared !== '' && artifact === null && typeof readArtifact === 'function') {
    const relative = typeof json.artifact === 'string' ? json.artifact.trim() : ''
    if (relative !== '' && !relative.includes('..')) {
      try {
        artifact = readArtifact(relative)
      } catch {
        artifact = null
      }
    }
  }
  const hash = declared === ''
    ? 'none'
    : (artifact === null ? 'unverifiable' : (sha256(artifact) === declared ? 'ok' : 'mismatch'))
  return {
    name: declaredName || plugin || ns,
    ns,
    file,
    provides: Array.isArray(json.provides) ? json.provides.filter((item) => typeof item === 'string') : [],
    hash,
  }
}

/** 读一个用户空间插件目录（清单 + 产物正文，哈希校验用）。读不出来 → 抛（上层降级）。 */
const diskUserEntry = ({ ns, plugin, dir }) => {
  const file = posix(join(dir, USER_MANIFEST))
  let jsonText = null
  try {
    jsonText = readFileSync(join(dir, USER_MANIFEST), 'utf8')
  } catch {
    throw malformed(`plugin.json 读不出来：${file}`)
  }
  return userEntry({ ns, plugin, file, jsonText,
    readArtifact: (relative) => readFileSync(join(dir, relative), 'utf8') })
}

/** 扫用户空间：一层 `<ns>/plugin.json` 与两层 `<ns>/<plugin>/plugin.json` 都收（两种布局互不重叠）。 */
const scanUserSpace = (dir) => {
  const out = []
  for (const ns of readdirSync(dir).sort(byName)) {
    const nsPath = join(dir, ns)
    if (!isDir(nsPath)) continue
    const names = readdirSync(nsPath)
    if (names.includes(USER_MANIFEST)) {
      out.push(diskUserEntry({ ns, plugin: '', dir: nsPath }))
      continue
    }
    for (const plugin of [...names].sort(byName)) {
      const pluginPath = join(nsPath, plugin)
      if (!isDir(pluginPath)) continue
      if (readdirSync(pluginPath).includes(USER_MANIFEST)) out.push(diskUserEntry({ ns, plugin, dir: pluginPath }))
    }
  }
  return out
}

/** 注入模式的用户空间条目（`{ns, plugin, json_text, artifact_text?}`）：清单缺失即算"读不出来"。 */
const memoryUserEntries = (entries) => entries.map((entry) => {
  if (!isPlain(entry)) throw malformed('注入的用户空间条目必须是对象')
  const ns = typeof entry.ns === 'string' ? entry.ns : ''
  const plugin = typeof entry.plugin === 'string' ? entry.plugin : ''
  const file = typeof entry.file === 'string' && entry.file
    ? entry.file
    : posix(join(ns, plugin, USER_MANIFEST))
  return userEntry({ ns, plugin, file,
    jsonText: typeof entry.json_text === 'string' ? entry.json_text : '',
    artifactText: typeof entry.artifact_text === 'string' ? entry.artifact_text : null })
})

const pluginNames = (entries) => [...new Set(entries)]
  .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs') && !NON_PLUGIN_FILES.includes(entry))
  .map((entry) => entry.slice(0, -'.mjs'.length))
  .sort(byName)

/**
 * 把已读到的四个源并成一张清单 —— **唯一**产出 `items`/`counts`/`differences` 的地方。
 * 走到这里说明三个真源都读成功（读失败在上层就降级了），所以这里不再有 degraded 分支。
 */
const buildView = ({ modulesDir, dirNames, rows, userItems, profileRefs, maxItems, maxBytes }) => {
  const rowByName = new Map()
  const duplicatedRows = []
  for (const row of rows) {
    if (rowByName.has(row.name)) {
      duplicatedRows.push(row.name)
      continue
    }
    rowByName.set(row.name, row)
  }
  const userByName = new Map()
  const duplicatedUsers = []
  for (const item of userItems) {
    if (userByName.has(item.name)) {
      duplicatedUsers.push(item.name)
      continue
    }
    userByName.set(item.name, item)
  }
  /** 装配状态：清单行的"装配"列 **或** profile 名单里找到引用 → true；都找不到 → 显式 false（不隐藏）。 */
  const wiredOf = (name, row) => profileRefs.has(name) || isWiredCell(row ? row.wiring : '')
  const inDir = new Set(dirNames)
  const items = []
  for (const name of dirNames) {
    const row = rowByName.get(name) ?? null
    items.push({ name, source: row && row.evolve ? 'evolve' : 'human', wired: wiredOf(name, row),
      provides: row ? [...row.provides] : [], file: posix(join(modulesDir, `${name}.mjs`)) })
  }
  for (const name of [...rowByName.keys()].sort(byName)) {
    if (inDir.has(name)) continue
    const row = rowByName.get(name)
    items.push({ name, source: row.evolve ? 'evolve' : 'human', wired: wiredOf(name, row),
      provides: [...row.provides], file: row.file })
  }
  for (const name of [...userByName.keys()].sort(byName)) {
    const item = userByName.get(name)
    items.push({ name, source: 'user-space', wired: wiredOf(name, rowByName.get(name) ?? null),
      provides: [...item.provides], file: item.file })
  }
  // 稳定排序：名称 → 来源 → 路径（与目录/清单/用户空间的**遍历顺序**无关）
  const ordered = items.sort((left, right) => byName(left.name, right.name)
    || byName(left.source, right.source) || byName(left.file, right.file))
  const names = (list) => [...list].sort(byName)
  const onlyDir = names(dirNames.filter((name) => !rowByName.has(name)))
  const onlyInventory = names([...rowByName.keys()].filter((name) => !inDir.has(name)))
  const onlyUser = names([...userByName.keys()].filter((name) => !inDir.has(name) && !rowByName.has(name)))
  const sameAsUser = names([...userByName.keys()].filter((name) => inDir.has(name) || rowByName.has(name)))
  const hashMismatch = names([...userByName.values()].filter((item) => item.hash === 'mismatch').map((item) => item.name))
  const hashUnverifiable = names([...userByName.values()].filter((item) => item.hash === 'unverifiable').map((item) => item.name))
  const grouped = { 仅目录有: onlyDir, 仅清单有: onlyInventory, 仅用户空间有: onlyUser, 与用户空间同名: sameAsUser,
    哈希不一致: hashMismatch, 哈希不可校验: hashUnverifiable, 清单重复登记: names(duplicatedRows),
    用户空间重复登记: names(duplicatedUsers) }
  const differences = DIFFERENCE_KINDS.flatMap((kind) => grouped[kind].map((name) => `${kind}: ${name}`))
  const inconsistencies = differences.length > 0
  let clipped = 0
  const clipList = (list) => list.map((text) => {
    const out = clip(text, maxBytes)
    if (out !== text) clipped += 1
    return out
  })
  const everything = ordered.map((item) => ({ ...item, provides: clipList(item.provides) }))
  const clippedDifferences = clipList(differences)
  const shown = everything.slice(0, maxItems)
  const omitted = everything.length - shown.length
  const counts = {
    'human': everything.filter((item) => item.source === 'human').length,
    evolve: everything.filter((item) => item.source === 'evolve').length,
    user_space: everything.filter((item) => item.source === 'user-space').length,
    total: everything.length,
    unwired: everything.filter((item) => item.wired === false).length,
  }
  return {
    items: shown,
    counts,
    inconsistent: inconsistencies,
    differences: clippedDifferences,
    truncated: omitted > 0 || clipped > 0,
    omitted_items: omitted,
    clipped,
    degraded: false,
    reason: everything.length === 0 ? EMPTY_REASON : '',
    next_action: everything.length === 0 ? EMPTY_NEXT_ACTION : '',
    source: SOURCE_NAME,
  }
}

export function apply(ctx, config) {
  const modulesDir = typeof config?.modules_dir === 'string' ? config.modules_dir.trim() : ''
  const inventoryPath = typeof config?.inventory === 'string' ? config.inventory.trim() : ''
  const userSpaceDir = typeof config?.user_space === 'string' ? config.user_space.trim() : ''
  const maxItems = clampInt(config?.max_items, 200, 0, 100000)
  const maxBytes = clampInt(config?.max_bytes, 256, 0, 1048576)
  const degraded = (reason, nextAction = NEXT_ACTIONS[reason]) => ({
    items: [],
    counts: { 'human': 0, evolve: 0, user_space: 0, total: 0, unwired: 0 },
    inconsistent: false,
    differences: [],
    truncated: false,
    omitted_items: 0,
    clipped: 0,
    degraded: true,
    reason,
    next_action: nextAction,
    source: SOURCE_NAME,
  })

  /** 生产模式：从 `Config` 的三个路径只读。 */
  const fromDisk = () => {
    if (!modulesDir) return degraded('modules-dir-unreadable')
    let entries = null
    try {
      entries = readdirSync(modulesDir)
    } catch {
      return degraded('modules-dir-unreadable')
    }
    if (!Array.isArray(entries)) return degraded('modules-dir-unreadable')
    if (!inventoryPath) return degraded('inventory-unreadable')
    let text = null
    try {
      text = readFileSync(inventoryPath, 'utf8')
    } catch {
      return degraded('inventory-unreadable')
    }
    if (typeof text !== 'string' || text.includes('\u0000')) return degraded('inventory-malformed')
    let userItems = []
    if (userSpaceDir) {
      const stat = statOf(userSpaceDir)
      if (stat === null) {
        userItems = []                                  // 契约：不存在 → 空（不是降级）
      } else if (!stat.isDirectory()) {
        return degraded('user-space-unreadable')        // 配了路径却不是目录：显式拒绝，不静默当空
      } else {
        try {
          userItems = scanUserSpace(userSpaceDir)
        } catch (error) {
          return degraded(error?.code === 'user-space-malformed' ? 'user-space-malformed' : 'user-space-unreadable')
        }
      }
    }
    return buildView({ modulesDir, dirNames: pluginNames(entries), rows: readInventory(text), userItems,
      profileRefs: readProfileRefs(modulesDir), maxItems, maxBytes })
  }

  /** 注入模式（**零 I/O**）：三个真源由调用方在内存里给出；形状与生产模式同一形状。 */
  const fromInput = (sources) => {
    if (!isPlain(sources)) return degraded('modules-dir-unreadable')
    if (!Array.isArray(sources.dir_names)) return degraded('modules-dir-unreadable')
    if (typeof sources.inventory_text !== 'string') return degraded('inventory-unreadable')
    if (sources.inventory_text.includes('\u0000')) return degraded('inventory-malformed')
    let userItems = []
    try {
      userItems = memoryUserEntries(Array.isArray(sources.user_space) ? sources.user_space : [])
    } catch (error) {
      return degraded(error?.code === 'user-space-malformed' ? 'user-space-malformed' : 'user-space-unreadable')
    }
    const dir = typeof sources.modules_dir === 'string' ? sources.modules_dir : modulesDir
    const refs = Array.isArray(sources.profile_refs)
      ? new Set(sources.profile_refs.filter((item) => typeof item === 'string'))
      : new Set()
    return buildView({ modulesDir: dir, dirNames: pluginNames(sources.dir_names), rows: readInventory(sources.inventory_text),
      userItems, profileRefs: refs, maxItems, maxBytes })
  }

  /** 只读快照：不给参数就走磁盘（生产模式）；给了内存源就走注入模式（fixture/门手算）。绝不抛。 */
  const snapshot = (sources) => {
    try {
      return sources === undefined || sources === null ? fromDisk() : fromInput(sources)
    } catch {
      return degraded('market-read-failed')            // 最后兜底：宁可报"读失败"也不抛、也不报零
    }
  }

  /** 一行人类可读摘要（受 `max_bytes` 字节夹取；降级时不带任何数字）。 */
  const headline = (sources) => {
    const snap = snapshot(sources)
    if (snap.degraded) return clip(`${DEGRADED_HEADLINE}（${snap.reason}）`, maxBytes)
    if (snap.items.length === 0) return clip('插件市场：零插件（三个真源都读得通，确实一件都没有）', maxBytes)
    return clip(`插件市场 ${snap.counts.total} 项（human ${snap.counts.human}/evolve ${snap.counts.evolve}`
      + `/user-space ${snap.counts.user_space}）；未装配 ${snap.counts.unwired}；`
      + `${snap.inconsistent ? '三源不一致' : '三源一致'}`
      + `${snap.truncated ? `；已截断（丢 ${snap.omitted_items} 条/夹 ${snap.clipped} 串）` : ''}`, maxBytes)
  }

  ctx.provide('pluginMarket', { snapshot, headline })
}

/** fixture 的内存源（形状与生产模式的三个真源一致；**零 I/O** → A5 确定性可复现）。 */
const SAMPLE_SOURCES = {
  modules_dir: 'host/modules',
  dir_names: ['gamma.mjs', 'alpha.mjs', 'index.mjs', 'beta.mjs'],
  inventory_text: ['| 插件（文件） | 提供的能力 | 提供者服务名 | 被哪些 profile 装配 | 独立演进时改哪里 |',
    '|---|---|---|---|---|',
    '| `host/modules/alpha.mjs` | 甲 | `alphaService` | `webui` | 只改本文件 |',
    '| `host/modules/beta.mjs` | 乙 | `betaService` | `contractor-ops` | **subagent 产出** |',
    '| `host/modules/delta.mjs` | 丁（清单有、目录无） | `deltaService` | 未接线 | 只改本文件 |'].join('\n'),
  user_space: [{ ns: 'ns1', plugin: 'omega', json_text: '{"name":"omega","provides":["omegaService"]}' }],
}

export const fixture = {
  sources: SAMPLE_SOURCES,
  sample: (handle) => ({
    snap: handle.snapshot(SAMPLE_SOURCES),
    again: handle.snapshot(SAMPLE_SOURCES),
    text: handle.headline(SAMPLE_SOURCES),
  }),
}
