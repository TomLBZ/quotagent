/**
 * user-space —— **用户空间插件的隔离内核**（T-268 产物；D-060：进程内独立 `Context`，**不是**独立进程）。
 * 契约（逐字）：`docs/work/plans/p3-spec.json` 的 FR-USERPLUG-001..012 / AC-USERPLUG-001..012；
 * 设计：`docs/design/22-plugin-market-and-user-space.md`；围栏门：`host/t268-user-space-gate.mjs`。
 *
 * 分工（本文件只做宿主侧的纪律，不碰事实层）：
 *   · 只读扫描 `user-space/<ns>/<plugin>/plugin.json`（登记真源）→ 有界、确定性；单条坏清单不拖倒整次扫描；
 *     目录不存在 → **空**（不是报错也不是降级）；目录在却读不出来 → `degraded:true` + `reason` + `next_action`；
 *   · 装载一个用户空间插件：**新起一个 `Context`**（自带 registry/events/logger → 独立 fiber 与独立 effect 列表），
 *     动态 import 它的产物，把三件宿主服务（文件根 / 凭据作用域 / 实例状态）**命名空间化**地提供给它；
 *   · 卸载 = dispose **该 fiber**（effects 归零）；重载 = 先卸后装，得到**新 instance（新 uid）**，不迁移任何内存状态。
 *
 * 隔离四件套（FR-USERPLUG-006）怎么落地（四条都由门里的正控看着）：
 *   ① 独立 instance：每个实例一个 `new Context()` + 一个 fiber；两个 ns 的同名插件 uid 不同、可分别卸载，
 *      且各自的服务只在自己那个 root 里可见（平台 ctx 取不到）；
 *   ② 独立命名空间：插件注册的服务键一律 `<ns>.<plugin>.<service>`（`namespaceKey`）；平台保留名
 *      （`approval`/`ledger*`/`kernel.*` … 见 `RESERVED_SERVICES`）**结构性拒绝**（抛错，不是文档纪律）；
 *   ③ 独立文件根：文件服务在装载期绑定 `<root>/<ns>/<plugin>/`，任何路径先解析再判定 ——
 *      `..`、绝对路径、符号链接越界一律拒（`user-space-outside-ns`）；
 *   ④ 独立凭据作用域：只解析 `cred:<ns>/<plugin>:*`（`resolveCredential`），借别人的前缀一律拒（`value` 为 null + `reason`）。
 *
 * 本批**不做**的事（避免越权，H1：宿主不写账本）：
 *   · **零写面**：本文件不写任何文件；`assertWrite` 只回答"这个目标合不合法"并给出待办载荷，**不落盘**
 *     （落盘与落账本由 Python 侧做）；
 *   · 不订阅平台事件、不起子进程、不联网、不取墙钟、不随机、不注册定时器（静态负控逐条扫）；
 *   · 提权（写 `host/modules/`）不在这里：管理面只产出待办载荷，真正写入属下一批（ADR-0016 / FR-USERPLUG-010）。
 *
 * 口径备忘（宁可说清楚，也不伪装）：
 *   · `handle.uid` 是**宿主实例号** `<ns>.<plugin>#<n>`（进程内单调）。为什么不用 cordis 的 `fiber.uid`：
 *     每个实例一个独立 `Context`，而 cordis 的 uid 计数器是**每个 registry（root）各自从 1 开始**的，
 *     跨 Context 不可比（两个实例都会是 1）；`fiber_uid` 一并给出，但**不作跨实例身份**用；
 *   · `scan` 的 `counts.plugins` 是**夹取前**的真值（`namespaces[]` 里各 plugins 之和 = `counts.plugins - omitted`）：
 *     展示可以有界，数字不许悄悄变小；
 *   · 服务键只收**基础名**（不带 `.`）：`provide('status')` → `<ns>.<plugin>.status`；写全名（`a.b.c`）即拒。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 实体搬迁（迁移阶段 5，本批 `EV-178`）：`host/lib/user-space.mjs` →
// `src/system/user-plugin-manager/code/user-space.mjs`；旧路径 `host/lib/user-space.mjs` 只剩**薄重导**。
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')   // code/ → 插件 → 层 → src → 仓库根

/**
 * 解析 cordis（宿主内核）：`$QUOTAGENT_CORDIS` → `host/node_modules/cordis`（仓库内）→ 裸 `cordis`。
 * 理由同 `src/system/evolution/code/evolution.mjs`：实体在 `src/` 下，裸名上溯不到 `host/node_modules/`
 * （实测 `ERR_MODULE_NOT_FOUND`）。顺序与 `src/system/runtime/code/plugin-registry.mjs` 的 `loadCordis`
 * **同一套**；依赖声明在 `src/system/user-plugin-manager/plugin.json` 的 `dependencies`。
 */
async function loadCordis() {
  const candidates = []
  if (process.env.QUOTAGENT_CORDIS) candidates.push(process.env.QUOTAGENT_CORDIS)
  candidates.push(join(REPO_ROOT, 'host', 'node_modules', 'cordis', 'lib', 'index.js'))
  candidates.push('cordis')
  const tried = []
  for (const candidate of candidates) {
    try {
      const mod = candidate.startsWith('/') || candidate.includes('node_modules')
        ? await import(pathToFileURL(candidate).href)
        : await import(candidate)
      if (typeof mod.Context === 'function') return mod
      tried.push(`${candidate}: 无 Context 导出`)
    } catch (err) {
      tried.push(`${candidate}: ${String(err && err.message).slice(0, 80)}`)
    }
  }
  throw new Error(`cordis-missing（宿主内核未就绪）：${tried.join(' | ')}；`
    + '跑 `tools/cordis.sh install` 或设 $QUOTAGENT_CORDIS')
}

const { Context } = await loadCordis()

/** 平台**保留服务名**：用户空间插件注册或覆盖这些名字一律拒（FR-USERPLUG-006 ②）。 */
export const RESERVED_SERVICES = ['approval', 'ledger', 'ledgerView', 'kernel', 'kernelBridge', 'webui',
  'projection', 'governor', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager']
/** 保留**前缀**：`kernel.*` / `ledger*` 这类家族名也算被平台占用。 */
export const RESERVED_PREFIXES = ['kernel.', 'ledger']
/** 宿主向每个被载插件提供的服务（同样命名空间化，避免与插件自有服务撞键）。 */
export const HOST_SERVICES = ['files', 'credentials', 'state']
/** 一次扫描最多收多少个插件（有界；超出在 `omitted` 报数，`counts.plugins` 仍是真值）。 */
export const MAX_PLUGINS = 50
/** 单份 `plugin.json` 的字节上限（超过即判该条非法，不读进内存）。 */
export const MAX_MANIFEST_BYTES = 65536
/** 登记真源与产物默认名（设计 22 §1：一个插件一个目录）。 */
export const MANIFEST = 'plugin.json'
export const ENTRY = 'index.mjs'
/** `plugin.json` 必填字段（缺一个即 `invalid:true`，不登记）。 */
export const REQUIRED_FIELDS = ['name', 'version', 'provides']
/** ns / plugin 名形状（小写字母开头，允许数字与连字符；**不允许** `.`、`/`、`..`）。 */
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
/** 服务基础名形状（首个字母开头；**不允许** `.`：命名空间化由 `namespaceKey` 负责）。 */
export const SERVICE_RE = /^[a-z][A-Za-z0-9-]{0,63}$/
/** 提权引用的形状（ADR-0016：人工门的 `approval_ref`）。 */
export const APPROVAL_RE = /^ap-\d{4}$/
/** 未提升为系统级的插件：跨 ns 装载一律拒（FR-USERPLUG-012）。 */
export const ELEVATION_CODE = 'user-plugin-not-elevated'

/** `scan` 的降级原因码（闭合集合；门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['user-space-root-unconfigured', 'user-space-root-not-a-directory',
  'user-space-root-unreadable', 'user-space-scan-failed']
/** 单条清单/产物的原因码（进 `plugins[].reason`，**不**升级为整次扫描降级）。 */
export const ENTRY_REASONS = ['manifest-unreadable', 'manifest-not-json', 'manifest-not-an-object',
  'manifest-missing-fields', 'manifest-too-large', 'artifact-missing', 'artifact-unreadable',
  'artifact-hash-mismatch']
/** 拒绝码（`user-plugin-manager` 的 `load/unload/reload` 与文件/凭据/状态服务共用同一张表）。 */
export const REFUSAL_CODES = ['user-space-outside-ns', 'artifact-outside-write-surface', 'user-plugin-not-elevated',
  'manifest-invalid', 'plugin-not-found', 'already-loaded', 'not-loaded', 'manager-disposed',
  'service-name-reserved', 'service-key-invalid', 'service-key-conflict', 'state-scope-refused',
  'connection-without-credential', 'credential-missing', 'credential-scope-refused', 'credential-key-invalid',
  'credential-empty', 'load-failed']

/** 每个原因码/拒绝码对应的下一步（固定映射 → 输出确定；门断言映射覆盖闭合集合）。 */
const NEXT_ACTIONS = {
  'user-space-root-unconfigured': '给 user-plugin-manager 配置 root（它必须指向仓库的 user-space/ 目录）',
  'user-space-root-not-a-directory': '检查 root 配置：它必须指向 user-space/ 目录本身，而不是某个文件',
  'user-space-root-unreadable': '检查 user-space/ 的权限与挂载：读不出来时不得当作"零插件"',
  'user-space-scan-failed': '重试并逐个核对 user-space/<ns>/<plugin>/plugin.json；本内核不猜也不掩盖',
  'manifest-unreadable': '修好该插件的 plugin.json 或移除该目录（读不出来不得静默少报）',
  'manifest-not-json': '把 plugin.json 改成合法 JSON（非法 JSON 只影响这一条，不拖倒整次扫描）',
  'manifest-not-an-object': 'plugin.json 顶层必须是对象（数组/字符串/数字都不算清单）',
  'manifest-missing-fields': '补齐必填字段（name/version/provides）后重新登记',
  'manifest-too-large': '把 plugin.json 缩到 64 KiB 以内（清单是登记真源，不是正文载体）',
  'artifact-missing': '产物文件不存在：补齐 manifest 里 artifact 指向的文件',
  'artifact-unreadable': '产物文件读不出来（权限/编码）：修好后再登记',
  'artifact-hash-mismatch': '产物与清单声明的 sha256 不一致：重新登记（或按告警处理被改动过的产物）',
  'user-space-outside-ns': '写面/装载面只有 user-space/<ns>/<plugin>/：把目标改回本插件目录',
  'artifact-outside-write-surface': '自进化的可写面只有 host/modules/：不要把 target 指到 user-space/',
  'user-plugin-not-elevated': '跨 ns 装载需要先提权（管理员在系统 UI 走人工门 + 影子哈希一致）',
  'manifest-invalid': '先修好 plugin.json（形状与必填字段），再装载',
  'plugin-not-found': '确认 ns/plugin 名与 user-space/ 下的目录一致（本内核不做名字模糊匹配）',
  'already-loaded': '先 unload 再 load（要换新实例用 reload）',
  'not-loaded': '该插件当前没有装载（先 load；reload 需要它已经在跑）',
  'manager-disposed': '管理面插件已被卸载：已装载的插件照常运行，新装载需要重新装配管理面',
  'service-name-reserved': '换一个服务基础名：平台保留名（approval/ledger*/kernel.* 等）不得注册或覆盖',
  'service-key-invalid': '服务基础名必须是 [a-z][A-Za-z0-9-]*，且不带点（命名空间由宿主加）',
  'service-key-conflict': '该服务键已被注册：换名字，或先卸载占用的实例',
  'state-scope-refused': '实例状态不跨 instance 共享：只读写本实例的状态',
  'connection-without-credential': '凭据未下发（cred:<ns>/<plugin>:*）：不得自称已连接，先报 available:false',
  'credential-missing': '在作用域内下发该凭据（cred:<ns>/<plugin>:<key>）后再连接',
  'credential-scope-refused': '只解析本插件作用域的凭据（cred:<ns>/<plugin>:*）；借别人的前缀一律拒',
  'credential-key-invalid': '凭据键是不带冒号的基础名（作用域前缀由宿主加）',
  'credential-empty': '凭据值为空串：等同未下发（不得当成可用凭据）',
  'load-failed': '装载抛错：看返回的 reason（本内核把失败如实报出，不伪装成功）',
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))
const posix = (path) => String(path).split('\\').join('/')
const nextActionOf = (code) => NEXT_ACTIONS[code] ?? ''

/** 编码错误（`code` 是给调用方用的机器可读名，不是给人看的散文）。 */
const coded = (code, detail = '') => {
  const error = new Error(`[${code}] ${detail}`)
  error.code = code
  error.detail = detail
  return error
}

/** 拒绝载荷：与成功载荷**同形**（`ok`/`code`/`reason`/`next_action`），调用方不必分支解析。 */
const refusalOf = (code, reason = '') => ({
  ok: false, code, reason: reason || code, next_action: nextActionOf(code),
})

const inside = (root, target) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)

/** 解析到**真实路径**（`..` 与符号链接都在这里被摊平）；不存在时逐级向上找到最近的已存在祖先。 */
const realpathOf = (path) => {
  let current = resolve(path)
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return join(realpathSync(current), posix(resolve(path)).slice(posix(resolve(current)).length))
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      current = parent
    }
  }
  return resolve(path)
}

/** 找出路径里的 `user-space` 段（返回该段的绝对路径；不在用户空间树里 → null）。 */
export const userSpaceRootOf = (path) => {
  const parts = posix(resolve(String(path ?? ''))).split('/')
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] === 'user-space') return parts.slice(0, index + 1).join('/') || '/'
  }
  return null
}

export const isReserved = (service) => RESERVED_SERVICES.includes(service)
  || RESERVED_PREFIXES.some((prefix) => String(service).startsWith(prefix))

/**
 * 服务键：`<ns>.<plugin>.<service>`（FR-USERPLUG-006 ②）。
 * ns/plugin/service 任何一个形状不对，或 service 是平台保留名 → **抛错**（不是静默改名）。
 */
export const namespaceKey = (ns, plugin, service) => {
  if (!NAME_RE.test(String(ns))) throw coded('service-key-invalid', `非法 ns：${String(ns)}`)
  if (!NAME_RE.test(String(plugin))) throw coded('service-key-invalid', `非法 plugin：${String(plugin)}`)
  if (typeof service !== 'string' || !SERVICE_RE.test(service)) {
    throw coded('service-key-invalid', `非法服务名：${String(service)}（只收不带点的基础名）`)
  }
  if (isReserved(service)) throw coded('service-name-reserved', `平台保留名不得注册或覆盖：${service}`)
  return `${ns}.${plugin}.${service}`
}

/**
 * 写面判定（FR-USERPLUG-002 / FR-USERPLUG-011 两个方向）。
 * `root` 是**写者的自有面**：用户空间插件是 `user-space/<ns>/<plugin>/`，自进化是 `host/modules/`。
 * 判定：
 *   · 目标在自有面内（含符号链接摊平后）→ `{ok:true, code:''}`；
 *   · 写者自己就在用户空间树里（用户空间侧）→ 越界即 `user-space-outside-ns`
 *     （写 host/modules、src、tools、别人的 ns、仓库外路径都是这个码）；
 *   · 写者不在用户空间树里（平台/自进化侧）→ 越界即 `artifact-outside-write-surface`
 *     （target 指到 `user-space/...` 或 `src/` 等任何非自有面都是这个码）。
 */
export const assertWriteSurface = (target, root) => {
  const rootPath = resolve(String(root ?? ''))
  const targetPath = typeof target === 'string' && target.trim() !== ''
    ? (isAbsolute(target) ? resolve(target) : resolve(rootPath, target))
    : null
  const rootInUserSpace = userSpaceRootOf(rootPath) !== null
  const code = rootInUserSpace ? 'user-space-outside-ns' : 'artifact-outside-write-surface'
  if (targetPath === null) {
    return { ...refusalOf(code, 'target-empty'), target: '', root: posix(rootPath), in_user_space: rootInUserSpace }
  }
  const lexical = inside(rootPath, targetPath)
  const real = inside(realpathOf(rootPath), realpathOf(targetPath))
  if (lexical && real) {
    return { ok: true, code: '', reason: '', next_action: '', target: posix(targetPath), root: posix(rootPath),
      in_user_space: rootInUserSpace }
  }
  const reason = lexical ? 'symlink-escapes-write-surface' : 'target-escapes-write-surface'
  return { ...refusalOf(code, reason), target: posix(targetPath), root: posix(rootPath), in_user_space: rootInUserSpace }
}

/** 凭据作用域前缀：`cred:<ns>/<plugin>:`（FR-USERPLUG-006 ④）。 */
export const credentialScope = (ns, plugin) => {
  if (!NAME_RE.test(String(ns))) throw coded('credential-key-invalid', `非法 ns：${String(ns)}`)
  if (!NAME_RE.test(String(plugin))) throw coded('credential-key-invalid', `非法 plugin：${String(plugin)}`)
  return `cred:${ns}/${plugin}:`
}

/**
 * 只解析**本插件作用域**的凭据：`env['cred:<ns>/<plugin>:<key>']`。
 * 其它一律拒绝（`ok:false` + `value:null` + 有名 `reason` + `next_action`）：
 *   · 借别人的 `cred:` 前缀（键里带冒号）→ `credential-scope-refused`；
 *   · 作用域内没有这个键 → `credential-missing`；空串 → `credential-empty`；
 *   · 未加作用域的裸键（如 `SMTP_TOKEN`）**永远解析不到**（本函数只按前缀查表）。
 */
export const resolveCredential = (env, ns, plugin, key) => {
  const prefix = credentialScope(ns, plugin)
  const scope = prefix.slice(0, -1)
  if (typeof key !== 'string' || key.trim() === '') {
    return { ...refusalOf('credential-key-invalid', 'credential-key-empty'), value: null, name: '', scope }
  }
  if (key.includes(':')) {
    return { ...refusalOf('credential-scope-refused', 'credential-key-carries-foreign-scope'), value: null,
      name: '', scope }
  }
  const table = isPlain(env) ? env : {}
  const scoped = `${prefix}${key}`
  if (!(scoped in table)) {
    return { ...refusalOf('credential-missing', 'credential-not-delivered'), value: null, name: key, scope }
  }
  const value = table[scoped]
  if (typeof value !== 'string' || value === '') {
    return { ...refusalOf('credential-empty', 'credential-value-empty'), value: null, name: key, scope }
  }
  return { ok: true, code: '', reason: '', next_action: '', value, name: key, scope }
}

/** 一条清单 → `{name, version, dir, manifest, sha256, invalid, reason}`（**不抛**：坏条目只坏自己）。 */
const readEntry = (ns, plugin, dir) => {
  const base = { name: plugin, ns, version: '', dir: posix(dir), manifest: null, sha256: '', invalid: false, reason: '' }
  const bad = (reason) => ({ ...base, invalid: true, reason, next_action: nextActionOf(reason) })
  let text = null
  try {
    text = readFileSync(join(dir, MANIFEST), 'utf8')
  } catch {
    return bad('manifest-unreadable')
  }
  if (typeof text !== 'string') return bad('manifest-unreadable')
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) return bad('manifest-too-large')
  let manifest = null
  try {
    manifest = JSON.parse(text)
  } catch {
    return bad('manifest-not-json')                    // 单个非法 JSON 只影响这一条，不拖倒整次扫描
  }
  if (!isPlain(manifest)) return bad('manifest-not-an-object')
  const missing = REQUIRED_FIELDS.filter((field) => manifest[field] === undefined)
  if (missing.length > 0) return bad('manifest-missing-fields')
  const artifactRel = typeof manifest.artifact === 'string' && manifest.artifact.trim() !== ''
    ? manifest.artifact.trim()
    : ENTRY
  let artifact = null
  try {
    artifact = readFileSync(resolve(dir, artifactRel), 'utf8')   // 绝对路径以 `resolve` 为准（`join` 会拼在目录后面）
  } catch {
    return { ...bad(artifactRel === ENTRY ? 'artifact-missing' : 'artifact-unreadable'), manifest,
      version: String(manifest.version) }
  }
  const hash = sha256(artifact)
  const declared = typeof manifest.sha256 === 'string' ? manifest.sha256.trim().toLowerCase() : ''
  if (declared !== '' && declared !== hash) {
    return { ...bad('artifact-hash-mismatch'), manifest, version: String(manifest.version), sha256: hash }
  }
  return { ...base, manifest, version: String(manifest.version), sha256: hash, invalid: false, reason: '' }
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 空/降级结果**同一形状**（门断言两者键集合一致 —— "读不到"不得看起来像"健康的零"）。 */
const scanResult = ({ namespaces = [], degraded = false, reason = '', omitted = 0, invalid = 0, total = 0 }) => ({
  namespaces,
  counts: { namespaces: namespaces.length, plugins: total, invalid },
  degraded,
  reason,
  next_action: nextActionOf(reason),
  truncated: omitted > 0,
  omitted,
})

/**
 * 只读扫描 `user-space/<ns>/<plugin>/`：有界（`MAX_PLUGINS`）、确定性（名称序）、**零写面**。
 *   · 目录不存在 → 空结果（`degraded:false`：零插件 ≠ 读不到）；
 *   · 路径存在但不是目录 / 读不出来 → `degraded:true` + 有名 `reason` + `next_action`（**不**冒充健康）；
 *   · 单个 `plugin.json` 非法 → 该条 `invalid:true` + `reason`，其余照常。
 */
export const scan = (root) => {
  try {
    if (typeof root !== 'string' || root.trim() === '') {
      return scanResult({ degraded: true, reason: 'user-space-root-unconfigured' })
    }
    const dir = resolve(root)
    let stat = null
    try {
      stat = statSync(dir)
    } catch {
      stat = null
    }
    if (stat === null) return scanResult({})                     // 不存在 → 空（不是报错，也不是降级）
    if (!stat.isDirectory()) return scanResult({ degraded: true, reason: 'user-space-root-not-a-directory' })
    let nsNames = null
    try {
      nsNames = readdirSync(dir)
    } catch {
      return scanResult({ degraded: true, reason: 'user-space-root-unreadable' })
    }
    const namespaces = []
    let omitted = 0
    let invalid = 0
    let total = 0
    for (const ns of [...nsNames].sort(byName)) {
      if (!NAME_RE.test(ns)) continue
      const nsPath = join(dir, ns)
      if (!isDir(nsPath)) continue
      let pluginNames = []
      try {
        pluginNames = readdirSync(nsPath)
      } catch {
        continue                                                  // 单个 ns 读不到：跳过（不拖倒整次扫描）
      }
      const plugins = []
      for (const plugin of [...pluginNames].sort(byName)) {
        if (!NAME_RE.test(plugin)) continue
        const pluginDir = join(nsPath, plugin)
        if (!isDir(pluginDir)) continue
        total += 1
        if (total > MAX_PLUGINS) {
          omitted += 1                                            // 有界：超出不读、只报数
          continue
        }
        const entry = readEntry(ns, plugin, pluginDir)
        if (entry.invalid) invalid += 1
        plugins.push(entry)
      }
      namespaces.push({ ns, plugins })
    }
    return scanResult({ namespaces, omitted, invalid, total })
  } catch {
    return scanResult({ degraded: true, reason: 'user-space-scan-failed' })   // 兜底：宁可说读失败，也不报"零"
  }
}

/** 进程内的宿主实例号（`<ns>.<plugin>#<n>`）；见文件头"口径备忘"。 */
let INSTANCE_SEQ = 0
const nextUid = (ns, plugin) => `${ns}.${plugin}#${INSTANCE_SEQ += 1}`

/** 每个 instance **一份**的可变状态（隔离四件套：不跨 instance 共享可变对象）。 */
const freshState = () => ({ writes: 0, value: null, created: '' })

/** 文件服务：绑定在插件自己的目录上；读取与写面判定都必须先解析路径。 */
const makeFileService = ({ dir, ns, plugin, refuse }) => {
  const dirPath = resolve(dir)
  const dirReal = realpathOf(dirPath)
  const escapes = (rel) => {
    if (typeof rel !== 'string' || rel.trim() === '') return true
    if (isAbsolute(rel)) return true                              // 绝对路径：一律拒
    const target = resolve(dirPath, rel)
    const targetReal = realpathOf(target)
    const lexical = inside(dirPath, target)
    const real = inside(dirReal, targetReal)                      // `..` 与符号链接都在这里被摊平
    return !(lexical && real)
  }
  const outside = () => refuse('user-space-outside-ns', 'path-escapes-plugin-root')
  return {
    root: posix(dirPath),
    scope: `user-space/${ns}/${plugin}`,
    resolve: (rel) => (escapes(rel) ? outside() : { ok: true, code: '', reason: '', path: posix(resolve(dirPath, rel)) }),
    read: (rel) => {
      if (escapes(rel)) return outside()
      const path = resolve(dirPath, rel)
      try {
        const text = readFileSync(path, 'utf8')
        return { ok: true, code: '', reason: '', path: posix(path), rel, bytes: Buffer.byteLength(text, 'utf8'),
          sha256: sha256(text), text }
      } catch {
        return { ok: false, ...refusalOf('manifest-invalid', 'file-unreadable'), path: posix(path) }
      }
    },
    /** 写面判定：**不落盘**（落盘由 Python 侧做），只回答"目标合不合法" + 待办载荷。 */
    assertWrite: (rel) => {
      if (escapes(rel)) return outside()
      const path = resolve(dirPath, rel)
      return { ok: true, code: '', reason: '', kind: 'user-space-write', rel, path: posix(path),
        root: posix(dirPath) }
    },
  }
}

/** 凭据服务：只暴露本插件作用域（`cred:<ns>/<plugin>:*`）。 */
const makeCredentialService = ({ env, ns, plugin }) => ({
  scope: credentialScope(ns, plugin).slice(0, -1),
  resolve: (key) => resolveCredential(env, ns, plugin, key),
  has: (key) => resolveCredential(env, ns, plugin, key).ok,
})

/** 实例状态服务：只服务**本实例**的 uid；问别人的 instance → 拒 + 留痕（不跨 instance 共享）。 */
const makeStateService = ({ uid, ns, plugin, state, refuse }) => ({
  uid,
  ns,
  plugin,
  get: () => state.value,
  set: (value) => {
    state.value = value
    state.writes += 1
    return { ok: true, code: '', uid, writes: state.writes }
  },
  writes: () => state.writes,
  read: (instance) => (instance === uid
    ? { ok: true, code: '', uid, value: state.value }
    : { ...refuse('state-scope-refused', 'instance-state-not-shared'), uid }),
})

/**
 * 装载一个用户空间插件（FR-USERPLUG-006/012/003/004；D-060）。
 * 返回 `{handle, unload}`；被拒时 `handle` 为 null 且 `refusal` 带 `code`/`reason`/`next_action`（**不伪装成功**）。
 * `onEvent` 是宿主侧的留痕回调（本文件不写账本、不订阅事件：事件由调用方交给 Python 侧落账）。
 */
export const loadPlugin = async (rootCtx, options = {}) => {
  const refuse = (code, reason = '') => refusalOf(code, reason)
  const { root = '', ns = '', plugin = '', env = {}, onEvent = null } = options
  const events = []
  const emit = (event) => {
    events.push(event)
    if (typeof onEvent === 'function') {
      try {
        onEvent(event)
      } catch {
        /* 留痕回调自己炸了，不该把装载拖下水 */
      }
    }
  }
  const refused = (code, reason = '') => {
    const payload = refuse(code, reason)
    emit({ kind: 'userplugin/refused', ns, plugin, code: payload.code, reason: payload.reason,
      next_action: payload.next_action })
    return { handle: null, refusal: payload, unload: async () => refuse('not-loaded'), events: () => [...events] }
  }
  if (rootCtx !== null && rootCtx !== undefined && typeof rootCtx?.get !== 'function') {
    return refused('load-failed', 'root-ctx-not-a-context')
  }
  if (!NAME_RE.test(String(ns)) || !NAME_RE.test(String(plugin))) {
    return refused('user-space-outside-ns', 'namespace-or-plugin-name-invalid')   // `../x` 这类名字在此被挡
  }
  const rootPath = resolve(String(root ?? ''))
  const dir = resolve(rootPath, ns, plugin)
  if (!inside(rootPath, dir)) return refused('user-space-outside-ns', 'target-escapes-root')
  if (!isDir(dir)) return refused('plugin-not-found', 'plugin-dir-missing')
  const manifestPath = join(dir, MANIFEST)
  let manifestText = null
  try {
    manifestText = readFileSync(manifestPath, 'utf8')
  } catch {
    return refused('manifest-invalid', 'manifest-unreadable')
  }
  let manifest = null
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    return refused('manifest-invalid', 'manifest-not-json')
  }
  if (!isPlain(manifest)) return refused('manifest-invalid', 'manifest-not-an-object')
  const missing = REQUIRED_FIELDS.filter((field) => manifest[field] === undefined)
  if (missing.length > 0) return refused('manifest-invalid', `manifest-missing-fields:${missing.join(',')}`)
  // 跨 ns：清单声明的属主 ns 与所在地 ns 不一致 → 该插件是被别人装载的，必须先提权
  const owner = typeof manifest.ns === 'string' && manifest.ns.trim() !== '' ? manifest.ns.trim() : ns
  if (owner !== ns && manifest.elevated !== true) {
    return refused(ELEVATION_CODE, `cross-namespace-load:${owner}->${ns}`)
  }
  // 产物：先过写面判定（越界即拒，**什么也不装载**），再核哈希
  const artifactRel = typeof manifest.artifact === 'string' && manifest.artifact.trim() !== ''
    ? manifest.artifact.trim()
    : ENTRY
  const surface = assertWriteSurface(resolve(dir, artifactRel), dir)
  if (!surface.ok) return refused(surface.code, 'artifact-' + surface.reason)
  let artifactText = null
  try {
    artifactText = readFileSync(resolve(dir, artifactRel), 'utf8')
  } catch {
    return refused('manifest-invalid', 'artifact-missing')
  }
  const artifactHash = sha256(artifactText)
  const declared = typeof manifest.sha256 === 'string' ? manifest.sha256.trim().toLowerCase() : ''
  if (declared !== '' && declared !== artifactHash) return refused('manifest-invalid', 'artifact-hash-mismatch')
  let mod = null
  try {
    mod = await import(pathToFileURL(resolve(dir, artifactRel)).href)
  } catch (error) {
    return refused('load-failed', `import-failed:${String(error?.code ?? error?.name)}`)
  }
  if (typeof mod?.apply !== 'function') return refused('manifest-invalid', 'artifact-not-a-plugin')

  // ---- 隔离内核：新起一个 Context（独立 registry/events/logger → 独立 fiber 与 effect 列表）----
  const iso = new Context()
  const uid = nextUid(ns, plugin)
  const state = freshState()
  const stateKey = namespaceKey(ns, plugin, 'state')
  const filesKey = namespaceKey(ns, plugin, 'files')
  const credentialsKey = namespaceKey(ns, plugin, 'credentials')
  const registered = []
  const rawServices = new Map()
  const verdicts = new Map()
  const stateService = makeStateService({ uid, ns, plugin, state, refuse: (code, reason) => {
    const payload = refuse(code, reason)
    emit({ kind: 'userplugin/refused', ns, plugin, code: payload.code, reason: payload.reason,
      next_action: payload.next_action, uid })
    return payload
  } })
  const files = makeFileService({ dir, ns, plugin, refuse: (code, reason) => {
    const payload = refuse(code, reason)
    emit({ kind: 'userplugin/refused', ns, plugin, code: payload.code, reason: payload.reason,
      next_action: payload.next_action, uid })
    return payload
  } })
  const credentials = makeCredentialService({ env, ns, plugin })

  /** 连接真相由**宿主**给：插件自称 `connected:true` 却没有作用域内凭据 → 拒 + 留痕（FR-USERPLUG-007 ④）。 */
  const verdictFor = (base) => {
    if (verdicts.has(base)) return verdicts.get(base)
    const raw = rawServices.get(base)
    let claim = null
    try {
      claim = raw && typeof raw.connection === 'function' ? raw.connection() : null
    } catch {
      claim = null
    }
    const claimKey = typeof claim?.credential_key === 'string' ? claim.credential_key
      : (typeof manifest.credential_key === 'string' ? manifest.credential_key : '')
    const claimsConnected = isPlain(claim) && claim.connected === true
    const cred = resolveCredential(env, ns, plugin, claimKey)
    let verdict = null
    if (claimsConnected && !cred.ok) {
      const payload = refuse('connection-without-credential', cred.reason)
      emit({ kind: 'userplugin/refused', ns, plugin, code: payload.code, reason: payload.reason,
        next_action: payload.next_action, uid, claimed_connected: true })
      verdict = { available: false, connected: false, claimed_connected: true, reason: cred.reason,
        code: payload.code, next_action: payload.next_action }
    } else if (!cred.ok) {
      verdict = { available: false, connected: false, claimed_connected: false, reason: cred.reason,
        code: cred.code, next_action: cred.next_action }
    } else {
      verdict = { available: claimsConnected, connected: claimsConnected, claimed_connected: claimsConnected,
        credential: cred.name, reason: claimsConnected ? '' : 'plugin-not-connected',
        code: '', next_action: claimsConnected ? '' : nextActionOf('credential-missing') }
    }
    verdicts.set(base, verdict)
    return verdict
  }

  const wrapper = {
    name: `${ns}/${plugin}`,
    inject: [...(Array.isArray(mod.inject) ? mod.inject : []), filesKey, credentialsKey, stateKey],
    // 装载器**自己**校验插件的 `Config`（然后把手头这三件一起交给它）：这样"宿主给的前缀/服务键"
    // 不必挤进插件自己的配置模式里（挤进去会让严格 schema 的插件无法装载）。
    apply: async (inner, raw) => {
      let ownConfig = isPlain(raw) ? raw.plugin ?? {} : {}
      try {
        if (mod.Config && typeof mod.Config.parse === 'function') ownConfig = mod.Config.parse(ownConfig)
      } catch (error) {
        throw coded('manifest-invalid', `plugin-config-refused:${String(error?.message).slice(0, 80)}`)
      }
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        const key = namespaceKey(ns, plugin, service)               // 保留名/非法名在此抛错（结构性拒绝）
        if (registered.includes(key)) throw coded('service-key-conflict', key)
        registered.push(key)
        rawServices.set(service, value)
        // 与"连接"相关的服务交出**宿主核验过的**视图：插件不能把"已连接"直接塞给消费者
        const facade = isPlain(value) && typeof value.connection === 'function'
          ? { ...value, connection: () => verdictFor(service) }
          : value
        return originalProvide(key, facade)
      }
      try {
        await mod.apply(inner, {
          ...(isPlain(ownConfig) ? ownConfig : {}),
          ns,
          plugin,
          prefix: `${ns}.${plugin}`,
          root: posix(dir),
          services: { files: filesKey, credentials: credentialsKey, state: stateKey },
        })
      } finally {
        inner.provide = originalProvide
      }
    },
  }
  let fiber = null
  let hostFiber = null
  try {
    // 宿主服务面先上市（**同一隔离 root** 里的兄弟 fiber）：插件声明的 inject 立刻可满足，
    // 不会因为"服务由插件自己的 apply 提供"而永远停在 pending（实测踩过：state=0）。
    hostFiber = await iso.plugin({
      name: `host-services:${ns}/${plugin}`,
      inject: [],
      apply: (inner) => {
        inner.provide(filesKey, files)
        inner.provide(credentialsKey, credentials)
        inner.provide(stateKey, stateService)
      },
    }, {})
    fiber = await iso.plugin(wrapper, { plugin: options.pluginConfig ?? {} })
    // 依赖没落地 → cordis 让插件停在 pending（`provide` 不会执行）。那是"装载失败"，不是"装载成功但没事干"。
    if (fiber.state !== 2) {
      const stopped = fiber.state
      await fiber.dispose()
      await hostFiber.dispose()
      return refused('load-failed', `plugin-not-active:state=${stopped}`)
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && REFUSAL_CODES.includes(error.code) ? error.code : 'load-failed'
    const payload = refuse(code, String(error?.detail ?? error?.message ?? error).slice(0, 120))
    emit({ kind: 'userplugin/refused', ns, plugin, code: payload.code, reason: payload.reason,
      next_action: payload.next_action })
    return { handle: null, refusal: payload, unload: async () => refuse('not-loaded'), events: () => [...events] }
  }
  const connectionBase = typeof manifest.connection_service === 'string' && manifest.connection_service.trim() !== ''
    ? manifest.connection_service.trim()
    : (Array.isArray(manifest.provides) && manifest.provides.length > 0 ? manifest.provides[0] : '')
  let unloaded = false
  const unload = async () => {
    if (unloaded) return { ok: false, code: 'not-loaded', reason: 'not-loaded', next_action: nextActionOf('not-loaded'), effects: 0 }
    unloaded = true
    await fiber.dispose()
    const effects = fiber.getEffects().length
    if (hostFiber) await hostFiber.dispose()      // 宿主服务面也一起回收（隔离 root 不留 effect）
    emit({ kind: 'userplugin/unloaded', ns, plugin, uid, effects })
    return { ok: true, code: '', reason: '', next_action: '', uid, effects }
  }
  const handle = {
    uid,
    ns,
    plugin,
    dir: posix(dir),
    root: posix(rootPath),
    manifest,
    artifact: posix(resolve(dir, artifactRel)),
    artifact_sha256: artifactHash,
    fiber_uid: fiber.uid,
    platform_ctx: rootCtx ?? null,
    context: fiber.ctx,
    serviceKeys: [...registered].sort(),
    serviceKeys_for: (service) => namespaceKey(ns, plugin, service),
    effects: () => fiber.getEffects().length,
    connection: () => verdictFor(connectionBase),
    services: { files, credentials, state: stateService },
    unload, reload: (overrides = {}) => reload(handle, overrides),
  }
  emit({ kind: 'userplugin/loaded', ns, plugin, uid, service_keys: [...registered].sort(),
    effects: fiber.getEffects().length })
  return { handle, unload, events: () => [...events] }
}

/**
 * 重载（FR-USERPLUG-003）：先 unload 该 fiber，再装载 —— **新 instance（新 uid）**，
 * **不迁移任何内存状态**（状态是每个 instance 一份的 `freshState()`：重载后草稿必然为空，而不是旧值）。
 */
export const reload = async (existingHandle, overrides = {}) => {
  if (!existingHandle || typeof existingHandle.unload !== 'function') {
    const payload = refusalOf('not-loaded', 'no-handle-to-reload')
    return { handle: null, refusal: payload, unload: async () => payload, previous_uid: null }
  }
  const previousUid = existingHandle.uid
  const previousEffects = typeof existingHandle.effects === 'function' ? existingHandle.effects() : null
  const before = typeof existingHandle.services?.state?.get === 'function'
    ? existingHandle.services.state.get() : null
  await existingHandle.unload()
  const next = await loadPlugin(existingHandle.platform_ctx ?? null, {
    root: overrides.root ?? existingHandle.root,
    ns: overrides.ns ?? existingHandle.ns,
    plugin: overrides.plugin ?? existingHandle.plugin,
    env: overrides.env ?? {},
    onEvent: overrides.onEvent ?? null,
  })
  return { ...next, previous_uid: previousUid, previous_effects: previousEffects, previous_state: before }
}
