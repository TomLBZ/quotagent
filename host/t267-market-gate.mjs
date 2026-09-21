/**
 * t267-market-gate —— T-267「插件市场只读聚合视图」候选产物 `plugin-market` 的**围栏门**
 * （宿主侧人工维护，**不由被围对象自己写**；ADR-0016 / D-036）。
 * 契约：`docs/work/plans/p3-spec.json` 的 FR-MARKET-001..006 / AC-MARKET-001..006，
 * 设计：`docs/design/22-plugin-market-and-user-space.md` §1/§6，清单行形状：`docs/design/14-plugin-inventory.md` §1。
 *
 * 被围对象：`plugin-market`（tmp 阶段是 `./../tmp/t267-market.mjs`，晋升后是 `./modules/plugin-market.mjs`）。
 * 两阶段都能跑：**实际加载到的绝对路径、字节数与 sha256 写进第 1 条断言的 detail**
 * （变异自证就是靠这一行确认"红的是我改的那一份"，而不是"看着红"）。
 *
 * 已知坑（必须处理，否则直接 ERR_MODULE_NOT_FOUND）：候选按契约 `import ... from '../lib/std-schema.mjs'`，
 * 而从 `tmp/` 看 `../lib` = **仓库根**的 `lib/`，它并不存在。这里照抄本仓既有做法
 * （`tools/evolve-module.mjs` 的影子目录、`host/t260-pipeline-gate.mjs`、`host/t254-retention-view-gate.mjs`）：
 * 在 gitignored 的 `tmp/t267-market-gate-shadow/` 里把 `host/lib` 软链过去、把候选**按字节复制**进去，
 * 再 import 影子里的那一份，并断言"复制前后字节一致"。影子只落在 `tmp/` 内，仓库里其它文件一个字不动。
 *
 * 断言（13 条 + 1 条空集合守卫；其中 8 条是**负控**；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：manifest 齐备（name/provides=['pluginMarket']/inject=[]/builtin/usedServices/Config/apply/fixture）
 *     + 只 import 白名单 + 打印实际加载路径/字节数/sha256/影子副本字节一致
 *   2 挂载与 dispose：provide 拦截拿得到句柄（键恰好 headline/snapshot）；dispose 后 `ctx.get('pluginMarket')`
 *     不存在、effect 归零，**且同进程里其它插件照常运行**（AC-MARKET-001 末句）
 *   3 手算正控：**真夹具目录**里造齐三个真源（目录 5 个 .mjs + 清单 5 行 + 用户空间 4 份 plugin.json），
 *     条目逐字段、counts、differences、truncated 全部等于手写表（不用实现验实现）
 *   4 只组合不自算：清单列/plugin.json 里写什么就输出什么（模块文件里明写 `provides = ['LIED-SERVICE']`
 *     也不得被采用）；装配状态来自清单"装配"列**或** profile 名单（zeta 的清单列是空的、profile 里有它 → wired=true）
 *   5 三源不一致正控：目录有/清单无、清单有/目录无、用户空间与目录同名、用户空间哈希 ≠ 产物哈希
 *     → `inconsistent:true` 且 differences **逐条点名**（不得取其一静默）
 *   6 降级负控：6 种坏源（目录不存在/目录配置为空/清单不存在/清单含 NUL/用户空间一项读不出来/用户空间不是目录）
 *     与 5 种注入畸形 → **不抛**、degraded:true、全零同形状、`reason` 有名、`next_action` 非空、降级摘要不含数字；
 *     与"**真的零插件**"（三个源都读得通、确实一件都没有）**可区分**（后者 degraded=false + reason=sources-empty）；
 *     「源为空三分之一」（一个源可读却一件都没有）**不降级**但必须点名 + 空格在 counts 里显式为 0
 *   7 有界负控：max_items 夹取（items 2 / omitted_items 8 / **counts 仍是真值 10**）、max_items=0、
 *     max_bytes=8（provides 与 differences 逐串夹取，clipped 手算 16）、max_bytes=0
 *   8 确定性负控：两次 snapshot **字节一致**、跨实例一致、注入输入冻结不抛、入参不被改写、条目顺序＝名称序
 *   9 静态负控：候选源码零写面（写文件/子进程/网络/事件订阅/随机/墙钟/定时器/账本调用）—— 且扫描器**非空转**
 *  10 按键白名单与零泄漏：条目/顶层/counts 的键**恰好**是白名单；用户空间清单里的
 *     body/subject/private:/reserve_price 哨兵一个都不出现在输出里
 *  11 配置契约负控：未知键/错误类型/非对象入参一律被拒；默认值 200/256（五个键都在）；越界夹取（1e9/0/-5/7.9/NaN）
 *  12 headline 正控：夹具下逐字一致（含三源计数/未装配/不一致提示）+ 字节 ≤ max_bytes
 *  13 真数据正控：真 `host/modules/` + 真 `docs/design/14-plugin-inventory.md`（另一主体维护的真源）
 *     → items 37 / counts 12-25-0-37-0/ 三源一致 / 与 `15-requirements-coverage.md` §2 的插件名集合**逐名一致**
 *  14 空集合守卫（一条都没跑 = 红）
 *
 * 变异模式（单点变异自证，自带防假变异）：`node host/t267-market-gate.mjs --mutate <1..4>`
 *   ① 去掉有界夹取 ② 三源不一致不报 ③ 源不可读时报全零冒充健康 ④ wired 找不到也报 true。
 *   每处都：锚点必须**恰好命中 1 次** → 变异后字节必须变 → 就地写回候选 → 起子进程跑本门（默认模式）→
 *   必须 exit 1 且**首条 FAIL** 有名、且子进程第 1 条断言的 detail 里出现**变异后**的 sha256（证明红的是那一份）→
 *   `finally` 还原并核对 sha256 与原始**逐字节一致**；任一步不满足即 exit 1（防假变异）。
 *   只允许就地变异 `tmp/` 下的候选（进树产物拒绝变异）。
 *
 * 用法：`node host/t267-market-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）；
 *       `node host/t267-market-gate.mjs --real`（只打印真数据摘要，供实跑脚本引用）。
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 */
import { Context, EventsService } from 'cordis'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IN_TREE = join(HERE, 'modules', 'plugin-market.mjs')            // 晋升后的位置
const FROM_TMP = join(ROOT, 'tmp', 't267-market.mjs')                 // ← './../tmp/t267-market.mjs'
const SHADOW = join(ROOT, 'tmp', 't267-market-gate-shadow')

// 夹具（全部落在 tmp/ 内，每次跑重建；仓库里其它文件一个字不动）
const FIX = join(ROOT, 'tmp', 't267-market-gate-fixture')
const FIX_MODULES = join(FIX, 'modules')
const FIX_INVENTORY = join(FIX, 'inventory.md')
const FIX_USER_SPACE = join(FIX, 'user-space')
const FIX_PROFILES = join(FIX, 'profiles.mjs')
const EMPTY_FIX = join(ROOT, 'tmp', 't267-market-gate-empty')
const MAL_FIX = join(ROOT, 'tmp', 't267-market-gate-malformed')
const ABSENT = join(ROOT, 'tmp', 't267-market-gate-absent')
const REAL_MODULES = join(ROOT, 'host', 'modules')
const REAL_INVENTORY = join(ROOT, 'docs', 'design', '14-plugin-inventory.md')
const REAL_COVERAGE = join(ROOT, 'docs', 'design', '15-requirements-coverage.md')

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail: String(detail) }) }

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const shapeOf = (obj) => Object.keys(obj).sort().join('|')
const F = (path) => String(path).split('\\').join('/')
/** 门自己的 UTF-8 字节夹取（用来手算"被夹到 8 字节"的期望值；与被围对象各写各的）。 */
const byteClip = (text, maxBytes) => {
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

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红的（「没跑到」不得当成「通过」，本仓已有教训）
  if (CHECKS.length === 0) check('14 空集合守卫：门至少跑了一条断言（反例：门只打印了 JSON 却没跑断言）', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures,
    total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

/** 定位并加载产物：晋升前从 tmp/（经影子目录），晋升后直接是同目录的 modules/。 */
const loadArtifact = async () => {
  if (existsSync(IN_TREE)) {
    return { mod: await import(pathToFileURL(IN_TREE).href), source: readFileSync(IN_TREE, 'utf8'),
      path: IN_TREE, copied: null }
  }
  if (!existsSync(FROM_TMP)) return null
  mkdirSync(join(SHADOW, 'modules'), { recursive: true })
  const libLink = join(SHADOW, 'lib')
  if (!existsSync(libLink)) symlinkSync(join(ROOT, 'host', 'lib'), libLink, 'dir')
  const copyPath = join(SHADOW, 'modules', 'plugin-market.mjs')
  copyFileSync(FROM_TMP, copyPath)
  const source = readFileSync(FROM_TMP, 'utf8')
  const copied = readFileSync(copyPath, 'utf8') === source
  return { mod: await import(pathToFileURL(copyPath).href), source, path: FROM_TMP, copied, copyPath }
}

/**
 * 挂载：照抄产物声明的 `inject`（写成 [] 会让它取不到依赖），包装 `provide` 抓句柄；
 * 同时在**同一个 Context** 里挂一个见证插件与一个消费者，用来断言"卸载本插件后其它插件照常运行"。
 */
const mountWith = async (mod, raw = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null, witness: null }
  const witnessFiber = await ctx.plugin({
    name: 'gate-witness',
    inject: [],
    apply: (inner) => { inner.provide('witnessService', { ping: () => 'pong' }) },
  })
  const consumer = async () => {
    consumerSeq += 1
    const seen = { value: null }
    await ctx.plugin({ name: `gate-consumer-${consumerSeq}`, inject: ['witnessService'],
      apply: (inner) => { seen.value = inner.witnessService } })
    return seen.value
  }
  const witnessBefore = await consumer()
  const wrapper = {
    name: `${mod.name}#gate`,
    inject: mod.inject,
    Config: mod.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((mod.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await mod.apply(inner, config)
    },
  }
  const fiber = await ctx.plugin(wrapper, mod.Config.parse(raw))
  return { ctx, fiber, box, witnessFiber, witnessBefore, consumer }
}
let consumerSeq = 0

/** 递归找非有限数（`JSON.stringify` 会把 NaN 写成 null，扫 JSON 文本抓不到）。 */
const badNumbers = (value, path = '') => {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path || '(root)']
  if (Array.isArray(value)) return value.flatMap((item, index) => badNumbers(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => badNumbers(item, path ? `${path}.${key}` : key))
  }
  return []
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// ---------------------------------------------------------------------------
// 夹具：三个真源各造一份（目录 / 清单文档 / 用户空间），形状照真实世界的文件。
// 手算表全部**先写死**（不用实现算出来的值来验实现）。
// ---------------------------------------------------------------------------
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}
const freshDir = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch { /* 不存在就不用删 */ }
  mkdirSync(dir, { recursive: true })
}

const FIX_INVENTORY_TEXT = [
  '# 夹具清单（T-267 围栏门自造；列形状照 docs/design/14-plugin-inventory.md §1）',
  '',
  '| 插件（文件） | 提供的能力 | 提供者服务名 | 被哪些 profile 装配 | 独立演进时改哪里 |',
  '|---|---|---|---|---|',
  '| `host/modules/alpha.mjs` | 甲（目录里有文件） | `alphaService` | `webui` | 只改本文件 |',
  '| `host/modules/beta.mjs` | 乙 | `betaService` | `contractor-ops` | **subagent 产出** |',
  '| `host/modules/delta.mjs` | 丁（清单有、目录无） | `deltaService` | 未接线 | 只改本文件 |',
  '| `host/modules/gamma.mjs` | 丙（目录里有文件） | `gammaService` | `webui`、`contractor-ops` | 只改本文件 |',
  '| `host/modules/zeta.mjs` | 己（装配只写在 profile 名单里） | `zetaService` |  | 只改本文件 |',
  '',
  '## 2. 库（不是插件清单行：不得被算进条目）',
  '',
  '| 库 | 职责 |',
  '|---|---|',
  '| `host/lib/config.mjs` | 夹具行（**必须被忽略**） |',
].join('\n')
const FIX_PROFILES_TEXT = [
  '/** 夹具 profile（T-267 门用）：`zeta` 只在这里被装配；`ghost-not-a-module` 反证"不得凭空造条目"。 */',
  'export const PROFILES = {',
  "  'fixture-host': {",
  "    modules: ['zeta', 'alpha', 'ghost-not-a-module'],",
  '  },',
  '}',
].join('\n')
const FIX_PSI_HASH = 'f'.repeat(64)   // 故意与产物内容 sha256 不符 → 哈希不一致

const buildFixture = () => {
  freshDir(FIX)
  // 目录（写入顺序刻意与名称顺序相反；含非插件文件 index.mjs；alpha.mjs 里明写一句假 provides）
  const files = [
    ['zeta.mjs', 'export const name = \'zeta\'\n'],
    ['index.mjs', '/* 模块发现入口：不是插件，不得进条目 */\n'],
    ['gamma.mjs', 'export const name = \'gamma\'\n'],
    ['eta.mjs', 'export const name = \'eta\'\n'],
    ['beta.mjs', 'export const name = \'beta\'\n'],
    ['alpha.mjs', 'export const name = \'alpha\'\nexport const provides = [\'LIED-SERVICE\']\n'],
  ]
  for (const [name, text] of files) put(join(FIX_MODULES, name), text)
  put(FIX_PROFILES, FIX_PROFILES_TEXT)
  put(FIX_INVENTORY, FIX_INVENTORY_TEXT)
  put(join(FIX_USER_SPACE, 'ns1', 'gamma', 'plugin.json'),
    JSON.stringify({ name: 'gamma', provides: ['gammaUserService'], note: '与目录同名' }))
  put(join(FIX_USER_SPACE, 'ns1', 'omega', 'plugin.json'),
    JSON.stringify({ name: 'omega', provides: ['omegaServiceWithAVeryLongName0123456789'] }))
  put(join(FIX_USER_SPACE, 'ns2', 'psi', 'plugin.json'),
    JSON.stringify({ name: 'psi', provides: ['psiService'], artifact: 'artifact.mjs', sha256: FIX_PSI_HASH }))
  put(join(FIX_USER_SPACE, 'ns2', 'psi', 'artifact.mjs'), 'PSI-ARTIFACT-BODY')
  put(join(FIX_USER_SPACE, 'ns3', 'plugin.json'), JSON.stringify({ name: 'lam', provides: ['lamService'] }))
  mkdirSync(join(FIX_USER_SPACE, 'ns4', 'empty-dir'), { recursive: true })   // 没有 plugin.json → 不得进条目

  // "真的零插件"夹具（三个源都读得通、确实一件都没有）
  freshDir(join(EMPTY_FIX, 'modules'))
  put(join(EMPTY_FIX, 'inventory.md'), '# 空清单（可读、0 行）\n')

  // "清单损坏"与"用户空间一项读不出来"夹具
  put(join(MAL_FIX, 'inventory-nul.md'), '| `host/modules/alpha.mjs` | 甲 | `alphaService` | `webui` |\n\u0000\n')
  put(join(MAL_FIX, 'user-space', 'ns', 'bad', 'plugin.json'), '{ 不是 JSON')
}

const FIX_CONFIG = { modules_dir: FIX_MODULES, inventory: FIX_INVENTORY, user_space: FIX_USER_SPACE,
  max_items: 200, max_bytes: 256 }
/** 手算表：条目按（名称 → 来源 → 路径）排序；`file` 的构造口路径见产物契约。 */
const FIX_ITEMS = [
  { name: 'alpha', source: 'human', wired: true, provides: ['alphaService'], file: `${F(FIX_MODULES)}/alpha.mjs` },
  { name: 'beta', source: 'evolve', wired: true, provides: ['betaService'], file: `${F(FIX_MODULES)}/beta.mjs` },
  { name: 'delta', source: 'human', wired: false, provides: ['deltaService'], file: 'host/modules/delta.mjs' },
  { name: 'eta', source: 'human', wired: false, provides: [], file: `${F(FIX_MODULES)}/eta.mjs` },
  { name: 'gamma', source: 'human', wired: true, provides: ['gammaService'], file: `${F(FIX_MODULES)}/gamma.mjs` },
  { name: 'gamma', source: 'user-space', wired: true, provides: ['gammaUserService'],
    file: `${F(FIX_USER_SPACE)}/ns1/gamma/plugin.json` },
  { name: 'lam', source: 'user-space', wired: false, provides: ['lamService'],
    file: `${F(FIX_USER_SPACE)}/ns3/plugin.json` },
  { name: 'omega', source: 'user-space', wired: false, provides: ['omegaServiceWithAVeryLongName0123456789'],
    file: `${F(FIX_USER_SPACE)}/ns1/omega/plugin.json` },
  { name: 'psi', source: 'user-space', wired: false, provides: ['psiService'],
    file: `${F(FIX_USER_SPACE)}/ns2/psi/plugin.json` },
  { name: 'zeta', source: 'human', wired: true, provides: ['zetaService'], file: `${F(FIX_MODULES)}/zeta.mjs` },
]
const FIX_COUNTS = { 'human': 5, evolve: 1, user_space: 4, total: 10, unwired: 5 }
const FIX_DIFFERENCES = ['仅目录有: eta', '仅清单有: delta', '仅用户空间有: lam', '仅用户空间有: omega',
  '仅用户空间有: psi', '与用户空间同名: gamma', '哈希不一致: psi']
const FIX_HEADLINE = '插件市场 10 项（human 5/evolve 1/user-space 4）；未装配 5；三源不一致'

/** 真数据手算表（真 `host/modules/` 26 个 .mjs − 非插件 index.mjs = 25 个插件；真清单 25 行，无缺无多）。 */
const REAL_COUNTS = { 'human': 12, evolve: 25, user_space: 0, total: 37, unwired: 0 }

/** 静态扫描（只扫候选源码；扫的是**产物**，不是本门）。只读被允许（FR-MARKET-002 的真源就是文件），
 *  写面/进程/网络/事件/随机/墙钟/定时器/账本一律不许出现。 */
const NEEDLES = ['writeFileSync', 'writeFile(', 'appendFile', 'createWriteStream', 'mkdirSync', 'rmSync',
  'rmdirSync', 'unlinkSync', 'unlink(', 'renameSync', 'copyFileSync', 'truncateSync', 'fs.truncate', 'openSync',
  'chmodSync', 'symlinkSync', 'child_process', 'execFile', 'execSync', 'spawn', 'fork(', 'fetch(', 'node:http',
  'node:https', 'node:net', 'node:dgram', 'worker_threads', 'Date.now', 'new Date', 'setTimeout(', 'setInterval(',
  'setImmediate(', 'Math.random', 'process.env', 'ctx.events', 'ctx.on(', 'ctx.emit', 'ctx.parallel', 'ctx.serial',
  'ctx.bail', 'ctx.waterfall', 'ledger', '.emit(']
const scanSource = (src, needles = NEEDLES) => needles.filter((needle) => src.includes(needle))

// ---------------------------------------------------------------------------
// 变异模式（单点变异自证）：`--mutate <1..4>`
// ---------------------------------------------------------------------------
const MUTATIONS = [
  { id: 1, label: '去掉有界夹取（条目不再封顶 max_items）',
    anchor: 'const shown = everything.slice(0, maxItems)',
    replace: 'const shown = everything' },
  { id: 2, label: '三源不一致不报（differences 清空 + inconsistent 恒 false）',
    anchor: '  const inconsistencies = differences.length > 0',
    replace: "  const inconsistencies = false\n  differences.length = 0" },
  { id: 3, label: '源不可读时报全零冒充健康（degraded false + 无 reason/next_action）',
    anchor: '    degraded: true,\n    reason,\n    next_action: nextAction,',
    replace: "    degraded: false,\n    reason: '',\n    next_action: ''," },
  { id: 4, label: 'wired 找不到也报 true（未装配被隐藏）',
    anchor: "  const wiredOf = (name, row) => profileRefs.has(name) || isWiredCell(row ? row.wiring : '')",
    replace: '  const wiredOf = () => true' },
]

const emitMutation = (payload, code) => { writeSync(1, JSON.stringify(payload) + '\n'); process.exit(code) }

const runMutation = (id) => {
  const spec = MUTATIONS.find((item) => item.id === id)
  if (!spec) emitMutation({ ok: false, mutation: id, error: `未知变异编号 ${id}（只支持 1..4）` }, 2)
  const target = artifact ? F(artifact.path) : null
  if (!target || !target.startsWith(F(join(ROOT, 'tmp')))) {
    emitMutation({ ok: false, mutation: id, error: `拒绝就地变异：目标必须是 tmp/ 下的候选（当前 ${String(target)}）` }, 2)
  }
  const pristine = readFileSync(target, 'utf8')
  const pristineSha = sha256(pristine)
  const anchorHits = pristine.split(spec.anchor).length - 1
  if (anchorHits !== 1) {
    emitMutation({ ok: false, mutation: id, anchor_hits: anchorHits,
      error: `锚点命中 ${anchorHits} 次（防假变异要求恰好 1 次）：${spec.anchor.slice(0, 80)}` }, 1)
  }
  const mutated = pristine.replace(spec.anchor, spec.replace)
  if (mutated === pristine) emitMutation({ ok: false, mutation: id, anchor_hits: anchorHits,
    error: '变异后字节未变（防假变异：锚点命中了却没改动）' }, 1)
  const mutatedSha = sha256(mutated)
  let child = null
  try {
    writeFileSync(target, mutated, 'utf8')
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: HERE, encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024 })
  } finally {
    writeFileSync(target, pristine, 'utf8')          // 无论子进程怎么结束都还原
  }
  const restoredSha = sha256(readFileSync(target, 'utf8'))
  // 子进程输出：最后一行能解析成 {checks:[...]} 的 JSON
  const lines = String(child.stdout ?? '').trim().split('\n').filter(Boolean)
  let report = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])
      if (Array.isArray(parsed.checks)) { report = parsed; break }
    } catch { /* 不是 JSON 行就继续往前找 */ }
  }
  const failed = report ? report.checks.filter((item) => !item.ok) : []
  const firstFail = failed[0] ?? null
  const loaderDetail = report ? String(report.checks[0]?.detail ?? '') : ''
  const loaderSawMutated = loaderDetail.includes(mutatedSha.slice(0, 16))
  const restoredIdentical = restoredSha === pristineSha
  const ok = child.status === 1 && failed.length > 0 && loaderSawMutated && restoredIdentical
  emitMutation({
    ok,
    mutation: id,
    label: spec.label,
    anchor_hits: anchorHits,
    target,
    bytes: { pristine: Buffer.byteLength(pristine, 'utf8'), mutated: Buffer.byteLength(mutated, 'utf8') },
    sha256: { pristine: pristineSha, mutated: mutatedSha, restored: restoredSha },
    child_exit: child.status,
    child_passed: report ? report.passed : null,
    child_total: report ? report.total : null,
    first_fail: firstFail ? firstFail.name : null,
    first_fail_detail: firstFail ? String(firstFail.detail).slice(0, 400) : null,
    loader_saw_mutated_file: loaderSawMutated,
    restored_bytes_identical: restoredIdentical,
    all_failures: failed.map((item) => item.name),
  }, ok ? 0 : 1)
}

const artifact = await loadArtifact()
const argv = process.argv.slice(2)
const flagValue = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null
}
const mutateId = flagValue('--mutate')

if (mutateId !== null) runMutation(Number(mutateId))

/** `--real`：只打印真数据摘要（供实跑脚本引用；不打夹具、不改任何真实文件）。 */
if (argv.includes('--real')) {
  if (!artifact) {
    writeSync(1, JSON.stringify({ mode: 'real', error: '产物未加载' }) + '\n')
    process.exit(2)
  }
  const mounted = await mountWith(artifact.mod, { modules_dir: REAL_MODULES, inventory: REAL_INVENTORY,
    user_space: join(ROOT, 'tmp', 't267-market-gate-no-user-space') })
  const snap = mounted.box.handle.snapshot()
  writeSync(1, JSON.stringify({ mode: 'real', artifact: F(artifact.path),
    sources: { modules_dir: F(REAL_MODULES), inventory: F(REAL_INVENTORY),
      user_space: 'tmp/t267-market-gate-no-user-space（不存在 → 按空，不是降级）' },
    counts: snap.counts, items: snap.items, inconsistent: snap.inconsistent, differences: snap.differences,
    truncated: snap.truncated, omitted_items: snap.omitted_items, clipped: snap.clipped,
    degraded: snap.degraded, reason: snap.reason, next_action: snap.next_action,
    headline: mounted.box.handle.headline() }) + '\n')
  await mounted.fiber.dispose()
  process.exit(0)
}

const fibers = []
let mod = null

try {
  // ---------- 1. 契约正控（含实际加载路径 / 字节数 / sha256） ----------
  const source = artifact ? artifact.source : ''
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const ALLOWED_IMPORTS = ['../lib/std-schema.mjs', 'node:crypto', 'node:fs', 'node:path']
  const importLeaks = imports.filter((spec) => !ALLOWED_IMPORTS.includes(spec))
  mod = artifact ? artifact.mod : null
  const manifest = {
    name: mod?.name === 'plugin-market',
    inject: Array.isArray(mod?.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod?.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod?.usedServices) && mod.usedServices.length === 0,
    provides: Array.isArray(mod?.provides) && mod.provides.join(',') === 'pluginMarket',
    Config: typeof mod?.Config?.parse === 'function' && typeof mod?.Config?.['~standard']?.validate === 'function',
    apply: typeof mod?.apply === 'function',
    fixture: typeof mod?.fixture?.sample === 'function',
    keys: Array.isArray(mod?.ITEM_KEYS) && mod.ITEM_KEYS.join(',') === 'name,source,wired,provides,file'
      && Array.isArray(mod?.COUNT_KEYS) && mod.COUNT_KEYS.join(',') === 'human,evolve,user_space,total,unwired'
      && Array.isArray(mod?.OUTPUT_KEYS) && mod.OUTPUT_KEYS.length === 11
      && Array.isArray(mod?.DIFFERENCE_KINDS) && mod.DIFFERENCE_KINDS.length === 8
      && Array.isArray(mod?.DEGRADED_REASONS) && mod.DEGRADED_REASONS.length >= 6
      && mod?.EMPTY_REASON === 'sources-empty'
      && Array.isArray(mod?.NON_PLUGIN_FILES) && mod.NON_PLUGIN_FILES.join(',') === 'index.mjs',
    readers: typeof mod?.readInventoryRow === 'function' && typeof mod?.readProfileRefs === 'function'
      && typeof mod?.isWiredCell === 'function' && typeof mod?.hasEvolveMarker === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 齐备（name/provides=[pluginMarket]/inject=[]/builtin/usedServices/Config/apply/'
    + 'fixture/键白名单/导出读函数）且只 import 白名单（打印实际加载路径/字节数/sha256/影子副本字节一致）',
  mod !== null && manifestBad.length === 0 && importLeaks.length === 0,
  `载入=${artifact ? F(artifact.path) : '未加载'}；字节=${Buffer.byteLength(source, 'utf8')}；`
  + `sha256=${sha256(source).slice(0, 16)}…；影子副本字节一致=${artifact?.copied === null ? '（无影子，进树产物）' : artifact?.copied}；`
  + `imports=${imports.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；问题键=${manifestBad.join(',') || '无'}`)
  if (!mod) finish()

  buildFixture()

  // ---------- 2. 挂载正控 + 卸载（effect 回收 + 其它插件照常运行） ----------
  const probe = await mountWith(mod, {})
  fibers.push(probe.fiber)
  const effectsBefore = probe.fiber.getEffects().length
  const probeHandle = probe.box.handle
  const handleKeys = Object.keys(probeHandle ?? {}).sort().join('|')
  const witnessEffectsBefore = probe.witnessFiber.getEffects().length
  const methodsOk = Boolean(probeHandle) && handleKeys === 'headline|snapshot'
    && typeof probe.ctx.get('pluginMarket')?.snapshot === 'function'
  await probe.fiber.dispose()
  const effectsAfter = probe.fiber.getEffects().length
  const witnessAfter = await probe.consumer()
  const witnessOk = probe.witnessBefore?.ping?.() === 'pong' && witnessAfter?.ping?.() === 'pong'
    && probe.witnessFiber.getEffects().length === witnessEffectsBefore
  check('2 挂载与 dispose：cordis 挂载后 provide 拦截拿得到句柄（键恰好 headline/snapshot）；dispose 后 '
    + '`ctx.get(\'pluginMarket\')` 不存在且 effect 归零，**同进程里其它插件照常运行**（AC-MARKET-001 末句）',
  methodsOk && effectsBefore > 0 && effectsAfter === 0 && probe.ctx.get('pluginMarket') === undefined && witnessOk,
  `句柄键=${handleKeys || '空'}；effect ${effectsBefore} → ${effectsAfter}；`
  + `dispose 后 ctx.get=${String(probe.ctx.get('pluginMarket'))}；见证服务 dispose 前后=${witnessOk}`
  + `（effect ${witnessEffectsBefore} → ${probe.witnessFiber.getEffects().length}）`)

  const live = await mountWith(mod, FIX_CONFIG)
  fibers.push(live.fiber)
  const market = live.box.handle

  // ---------- 3. 手算正控（真夹具目录：三个真源都在磁盘上） ----------
  const fix = market.snapshot()
  const fixJson = JSON.stringify(fix.items)
  const itemsOk = fixJson === JSON.stringify(FIX_ITEMS)
  const countsOk = JSON.stringify(fix.counts) === JSON.stringify(FIX_COUNTS)
  const diffsOk = JSON.stringify(fix.differences) === JSON.stringify(FIX_DIFFERENCES)
  const flagsOk = fix.inconsistent === true && fix.truncated === false && fix.omitted_items === 0
    && fix.clipped === 0 && fix.degraded === false && fix.reason === '' && fix.next_action === ''
    && fix.source === 'plugin-market'
  check('3 手算正控：真夹具目录里三个真源（目录 5 个 .mjs / 清单 5 行 / 用户空间 4 份 plugin.json）→ '
    + '条目（名称/来源/装配/provides/路径）逐字段、counts、differences、truncated 全部等于手写表',
  itemsOk && countsOk && diffsOk && flagsOk && badNumbers(fix).length === 0,
  `条目=${itemsOk ? '逐字段一致' : `实际 ${fixJson}`}（手算 ${FIX_ITEMS.length} 条）；`
  + `counts=${JSON.stringify(fix.counts)}（手算 ${JSON.stringify(FIX_COUNTS)}）；`
  + `differences=${diffsOk ? '逐条一致' : JSON.stringify(fix.differences)}；inconsistent=${fix.inconsistent}`
  + ` truncated=${fix.truncated} clipped=${fix.clipped}`)

  // ---------- 4. 只组合不自算 ----------
  const alphaItem = fix.items.find((item) => item.name === 'alpha' && item.source === 'human')
  const zetaItem = fix.items.find((item) => item.name === 'zeta')
  const deltaItem = fix.items.find((item) => item.name === 'delta')
  const lies = /LIED-SERVICE/.test(JSON.stringify(fix))
  const composeOk = alphaItem?.provides.join(',') === 'alphaService' && !lies
    && zetaItem?.wired === true                       // 清单"装配"列是空的 → 只能来自 profile 名单
    && deltaItem?.wired === false                     // 清单写"未接线" → 显式 false
    && fix.items.some((item) => item.source === 'user-space' && item.provides.join(',') === 'omegaServiceWithAVeryLongName0123456789')
    && fix.items.filter((item) => item.name === 'gamma').length === 2   // 两源各一条，不合并、不覆盖
    && !fix.items.some((item) => item.name === 'ghost-not-a-module')    // profile 里的名字不得凭空造条目
    && fix.counts.total === 10
  check('4 只组合不自算：`provides` 照抄清单列/plugin.json（模块文件里明写 `provides=[\'LIED-SERVICE\']` 也不得采用）；'
    + '装配状态来自清单"装配"列**或** profile 名单（zeta 清单列空、profile 有 → true；delta 写"未接线" → 显式 false）；'
    + '同名两源并存（gamma 两条）；profile 里的陌生名字不得凭空造条目',
  composeOk,
  `alpha.provides=${JSON.stringify(alphaItem?.provides)}（模块源码里写的是 LIED-SERVICE）；`
  + `zeta.wired=${zetaItem?.wired}（清单列空、profile 命中）；delta.wired=${deltaItem?.wired}（清单写"未接线"）；`
  + `输出里出现 LIED-SERVICE=${lies}；gamma 条目数=${fix.items.filter((item) => item.name === 'gamma').length}；`
  + `幽灵条目=${fix.items.some((item) => item.name === 'ghost-not-a-module')}`)

  // ---------- 5. 三源不一致正控 ----------
  const kinds = mod.DIFFERENCE_KINDS
  const named = (needle) => fix.differences.includes(needle)
  const threeWayOk = fix.inconsistent === true
    && named('仅目录有: eta') && named('仅清单有: delta') && named('与用户空间同名: gamma') && named('哈希不一致: psi')
    && fix.differences.every((text) => kinds.some((kind) => text.startsWith(`${kind}: `)))
    && fix.differences.length === FIX_DIFFERENCES.length
  const emptySource = null   // 探针：空三源不用于本断言（真零在下方第 6 条专门负控）
  const dupRow = market.snapshot({ dir_names: [], inventory_text: [
    '| `host/modules/twin.mjs` | 甲 | `twinService` | `webui` | 只改本文件 |',
    '| `host/modules/twin.mjs` | 乙 | `twinService2` | `webui` | 只改本文件 |',
  ].join('\n'), user_space: [] })
  const dupOk = JSON.stringify(dupRow.differences) === JSON.stringify(['仅清单有: twin', '清单重复登记: twin'])
    && dupRow.items.length === 1 && dupRow.items[0].provides.join(',') === 'twinService'
  check('5 三源不一致正控：目录有/清单无、清单有/目录无、用户空间与目录同名、用户空间哈希 ≠ 产物哈希 '
    + '→ `inconsistent:true` 且 differences **逐条点名**（不得取其一静默）；清单重复登记也点名且首行胜出',
  threeWayOk && dupOk,
  `inconsistent=${fix.inconsistent}；differences=${JSON.stringify(fix.differences)}；`
  + `重复登记探针=${JSON.stringify(dupRow.differences)}（条目 ${dupRow.items.length} 条）`)

  // ---------- 6. 降级负控 ----------
  const healthyShape = shapeOf(fix)
  const healthyCountsShape = shapeOf(fix.counts)
  const reasons = new Set(mod.DEGRADED_REASONS ?? [])
  const BROKEN = [
    ['模块目录不存在', { modules_dir: ABSENT, inventory: FIX_INVENTORY }, 'modules-dir-unreadable'],
    ['模块目录配置为空', { modules_dir: '', inventory: FIX_INVENTORY }, 'modules-dir-unreadable'],
    ['清单文件不存在', { modules_dir: FIX_MODULES, inventory: join(ABSENT, 'nope.md') }, 'inventory-unreadable'],
    ['清单损坏（含 NUL）', { modules_dir: FIX_MODULES, inventory: join(MAL_FIX, 'inventory-nul.md') }, 'inventory-malformed'],
    ['用户空间一项读不出来', { modules_dir: FIX_MODULES, inventory: FIX_INVENTORY,
      user_space: join(MAL_FIX, 'user-space') }, 'user-space-malformed'],
    ['用户空间路径不是目录', { modules_dir: FIX_MODULES, inventory: FIX_INVENTORY,
      user_space: FIX_INVENTORY }, 'user-space-unreadable'],
  ]
  let degradedOk = true
  let degradedDetail = ''
  for (const [label, raw, reason] of BROKEN) {
    let out = null
    let text = ''
    try {
      const mounted = await mountWith(mod, raw)
      fibers.push(mounted.fiber)
      out = mounted.box.handle.snapshot()
      text = mounted.box.handle.headline()
    } catch (err) {
      degradedOk = false
      degradedDetail = `${label} 抛出 ${err.name}: ${String(err.message).slice(0, 60)}`
      break
    }
    const zero = Object.values(out.counts).every((value) => value === 0) && out.items.length === 0
      && out.differences.length === 0 && out.omitted_items === 0 && out.clipped === 0
    const ok = out.degraded === true && zero && out.reason === reason && reasons.has(reason)
      && typeof out.next_action === 'string' && out.next_action.length > 0 && out.inconsistent === false
      && out.truncated === false && out.source === 'plugin-market' && shapeOf(out) === healthyShape
      && shapeOf(out.counts) === healthyCountsShape && badNumbers(out).length === 0
      && typeof text === 'string' && !/\d/.test(text) && text.length > 0
    if (!ok) {
      degradedOk = false
      degradedDetail = `${label} → degraded=${out.degraded} 零=${zero} reason=${out.reason}（手算 ${reason}）`
        + ` next_action="${out.next_action}" 同形状=${shapeOf(out) === healthyShape} headline="${text}"`
      break
    }
  }
  const injectedBroken = [
    ['注入：非对象', (handle) => handle.snapshot('x')],
    ['注入：缺 dir_names', (handle) => handle.snapshot({ inventory_text: '' })],
    ['注入：清单不是字符串', (handle) => handle.snapshot({ dir_names: [], inventory_text: 7 })],
    ['注入：用户空间清单缺 json_text', (handle) => handle.snapshot({ dir_names: [], inventory_text: '',
      user_space: [{ ns: 'n', plugin: 'p' }] })],
    ['注入：清单含 NUL', (handle) => handle.snapshot({ dir_names: [], inventory_text: '\u0000' })],
  ]
  let injectedOk = true
  for (const [label, call] of injectedBroken) {
    try {
      const out = call(market)
      if (out.degraded !== true || out.items.length !== 0) { injectedOk = false; degradedDetail = `${label} 未降级` }
    } catch (err) {
      injectedOk = false
      degradedDetail = `${label} 抛出 ${err.name}`
    }
  }
  // "真的零插件"：三个源都读得通、确实一件都没有 → degraded=false + reason=sources-empty（与"读不到"可区分）
  const zero = await mountWith(mod, { modules_dir: join(EMPTY_FIX, 'modules'),
    inventory: join(EMPTY_FIX, 'inventory.md'), user_space: join(EMPTY_FIX, 'no-user-space') })
  fibers.push(zero.fiber)
  const zeroSnap = zero.box.handle.snapshot()
  const zeroOk = zeroSnap.degraded === false && zeroSnap.items.length === 0
    && zeroSnap.reason === mod.EMPTY_REASON && zeroSnap.next_action.length > 0
    && zeroSnap.counts.total === 0 && zeroSnap.inconsistent === false && shapeOf(zeroSnap) === healthyShape
  // 「源为空三分之一」（一个源**可读**却一件都没有）：不得降级（可读 ≠ 读不到），但必须逐条点名、
  // 空那一格在 counts 里显式为 0 —— 不得静默假装三源一致。
  const twoRows = ['| `host/modules/one.mjs` | 甲 | `oneService` | `webui` | 只改本文件 |',
    '| `host/modules/two.mjs` | 乙 | `twoService` | `webui` | 只改本文件 |'].join('\n')
  const soloRow = '| `host/modules/solo.mjs` | 甲 | `soloService` | `webui` | 只改本文件 |'
  const dirEmpty = market.snapshot({ dir_names: [], inventory_text: twoRows, user_space: [] })
  const invEmpty = market.snapshot({ dir_names: ['solo.mjs'], inventory_text: '', user_space: [] })
  const userEmpty = market.snapshot({ dir_names: ['solo.mjs'], inventory_text: soloRow, user_space: [] })
  const thirdEmptyOk = dirEmpty.degraded === false && dirEmpty.inconsistent === true
    && JSON.stringify(dirEmpty.differences) === JSON.stringify(['仅清单有: one', '仅清单有: two'])
    && dirEmpty.counts.total === 2
    && invEmpty.degraded === false && JSON.stringify(invEmpty.differences) === JSON.stringify(['仅目录有: solo'])
    && invEmpty.counts.total === 1
    && userEmpty.degraded === false && userEmpty.inconsistent === false
    && userEmpty.counts.user_space === 0 && userEmpty.counts.total === 1
  check('6 降级负控：6 种坏源（目录不存在/目录配置为空/清单不存在/清单含 NUL/用户空间一项读不出来/用户空间不是目录）'
    + '与 5 种注入畸形 → **一律不抛**、degraded:true、全零**同形状**、`reason` 有名、`next_action` 非空、'
    + '降级摘要不含数字；且与"**真的零插件**"**可区分**（后者 degraded=false + reason=sources-empty + 方向仍给出）；'
    + '「源为空三分之一」（一个源可读却一件都没有）不降级但必须点名 + 空格在 counts 里显式为 0',
  degradedOk && injectedOk && zeroOk && thirdEmptyOk,
  `坏源全部降级=${degradedOk}（共 ${BROKEN.length} 种）注入畸形=${injectedOk}（${injectedBroken.length} 种）`
  + `${degradedDetail ? `；首个不合规：${degradedDetail}` : ''}；真零插件：degraded=${zeroSnap.degraded}`
  + ` reason=${zeroSnap.reason} items=${zeroSnap.items.length} next_action="${zeroSnap.next_action}"；`
  + `空三分之一点名=${thirdEmptyOk}（目录空→${JSON.stringify(dirEmpty.differences)}；清单空→`
  + `${JSON.stringify(invEmpty.differences)}；用户空间空格=${userEmpty.counts.user_space}）`)

  // ---------- 7. 有界负控 ----------
  const bound2 = await mountWith(mod, { ...FIX_CONFIG, max_items: 2 })
  fibers.push(bound2.fiber)
  const small = bound2.box.handle.snapshot()
  const none = await mountWith(mod, { ...FIX_CONFIG, max_items: 0 })
  fibers.push(none.fiber)
  const noneSnap = none.box.handle.snapshot()
  const tight = await mountWith(mod, { ...FIX_CONFIG, max_bytes: 8 })
  fibers.push(tight.fiber)
  const tightSnap = tight.box.handle.snapshot()
  const zeroBytes = await mountWith(mod, { ...FIX_CONFIG, max_bytes: 0 })
  fibers.push(zeroBytes.fiber)
  const zeroSnap2 = zeroBytes.box.handle.snapshot()
  const bytesShort = [...tightSnap.items.flatMap((item) => item.provides), ...tightSnap.differences]
    .every((text) => Buffer.byteLength(text, 'utf8') <= 8)
  const prefixOk = tightSnap.items.find((item) => item.name === 'omega').provides[0]
      === byteClip('omegaServiceWithAVeryLongName0123456789', 8)
    && tightSnap.differences.every((text, index) => text === byteClip(FIX_DIFFERENCES[index], 8))
    && JSON.stringify(tightSnap.items.find((item) => item.name === 'alpha').provides)
      === JSON.stringify([byteClip('alphaService', 8)])
  const boundOk = small.items.length === 2 && small.items[0].name === 'alpha' && small.items[1].name === 'beta'
    && small.omitted_items === 8 && small.truncated === true
    && JSON.stringify(small.counts) === JSON.stringify(FIX_COUNTS)     // counts 是**夹取前**的真值
    && small.counts.total === small.items.length + small.omitted_items
    && noneSnap.items.length === 0 && noneSnap.omitted_items === 10
    && JSON.stringify(noneSnap.counts) === JSON.stringify(FIX_COUNTS)
    && tightSnap.clipped === 16 && tightSnap.truncated === true && bytesShort && prefixOk
    && zeroSnap2.items.every((item) => item.provides.every((text) => text === ''))
    && zeroSnap2.differences.every((text) => text === '') && zeroSnap2.inconsistent === true
  check('7 有界负控：max_items=2 → 只列前两条、omitted_items=8、**counts 仍是真值 10**'
    + '（counts.total = items.length + omitted_items）；max_items=0 → 条目空但 counts 照旧；'
    + 'max_bytes=8 → provides 与 differences 逐串夹到 ≤8 字节且是前缀（clipped 手算 16）；'
    + 'max_bytes=0 → 串全空但 inconsistent 仍为 true（夹取不得抹掉不一致信号）',
  boundOk,
  `max_items=2 → ${small.items.map((item) => item.name).join(',')} omitted=${small.omitted_items}`
  + ` counts=${JSON.stringify(small.counts)}；max_items=0 → 条目 ${noneSnap.items.length} omitted=${noneSnap.omitted_items}`
  + ` counts.total=${noneSnap.counts.total}；max_bytes=8 → clipped=${tightSnap.clipped}（手算 16）`
  + ` omega.provides=${JSON.stringify(tightSnap.items.find((item) => item.name === 'omega').provides)}`
  + ` differences[0]="${tightSnap.differences[0]}"；max_bytes=0 → inconsistent=${zeroSnap2.inconsistent}`)

  // ---------- 8. 确定性负控 ----------
  const once = JSON.stringify(market.snapshot())
  const twice = JSON.stringify(market.snapshot())
  const other = await mountWith(mod, { ...FIX_CONFIG })
  fibers.push(other.fiber)
  const otherOnce = JSON.stringify(other.box.handle.snapshot())
  const sample = mod.fixture.sources
  const sampleBefore = JSON.stringify(sample)
  const frozen = deepFreeze(JSON.parse(sampleBefore))
  let frozenOk = true
  try {
    frozenOk = JSON.stringify(market.snapshot(frozen)) === JSON.stringify(market.snapshot(sample))
  } catch {
    frozenOk = false
  }
  const orderOk = fix.items.map((item) => `${item.name}/${item.source}`).join('|')
    === [...FIX_ITEMS].map((item) => `${item.name}/${item.source}`).join('|')
  check('8 确定性负控：同输入两次 snapshot **字节一致**、跨实例一致、注入输入冻结不抛、入参不被改写、'
    + '条目顺序＝（名称→来源→路径）稳定序（与目录/清单/用户空间的遍历顺序无关）',
  once === twice && once === otherOnce && frozenOk && JSON.stringify(sample) === sampleBefore && orderOk,
  `两次一致=${once === twice}（${once.length} 字节）；跨实例一致=${once === otherOnce}；`
  + `冻结输入一致=${frozenOk}；入参未被改写=${JSON.stringify(sample) === sampleBefore}；顺序稳定=${orderOk}`)

  // ---------- 9. 静态负控 ----------
  const hits = scanSource(source)
  const planted = "const a = Date.now(); setInterval(() => {}, 1); fs.writeFileSync('x'); ctx.events.on('y');"
    + " spawn('z'); Math.random(); ctx.emit('e')"
  const plantedHits = scanSource(planted)
  check('9 静态负控：候选源码零写面（写文件/子进程/网络/事件订阅/随机/墙钟/定时器/账本调用）'
    + '—— 且扫描器**非空转**（在合成的坏源码上必须命中 ≥6 处）',
  hits.length === 0 && plantedHits.length >= 6,
  `命中=${hits.join(',') || '无'}；非空转对照命中 ${plantedHits.length} 处=${plantedHits.join(',')}`)

  // ---------- 10. 按键白名单与零泄漏 ----------
  const SENTINEL = 'SENTINEL-MARKET-9f3'
  const dirty = market.snapshot({
    dir_names: ['clean.mjs'],
    inventory_text: '| `host/modules/clean.mjs` | 甲 | `cleanService` | `webui` | 只改本文件 |',
    user_space: [{ ns: 'ns', plugin: 'dirty', json_text: JSON.stringify({ name: 'dirty', provides: ['dirtyService'],
      body: `${SENTINEL}-body`, subject: `${SENTINEL}-subject`, 'private:note': `${SENTINEL}-private`,
      reserve_price: `${SENTINEL}-price`, cost_model: `${SENTINEL}-cost`, signature: `${SENTINEL}-sig`,
      content: `${SENTINEL}-content`, note: '这一条不该出现在输出里' }) }],
  })
  const dirtyText = JSON.stringify(dirty) + market.headline({
    dir_names: ['clean.mjs'],
    inventory_text: '| `host/modules/clean.mjs` | 甲 | `cleanService` | `webui` | 只改本文件 |',
    user_space: [],
  })
  const itemKeys = dirty.items.map((item) => shapeOf(item)).join(';')
  const forbidden = ['body', 'subject', 'reserve_price', 'cost_model', 'signature', 'content']
    .filter((key) => new RegExp(`"${key}"\\s*:`).test(JSON.stringify(dirty)))
  const whitelistOk = itemKeys.split(';').every((shape) => shape === 'file|name|provides|source|wired')
    && shapeOf(dirty) === [...mod.OUTPUT_KEYS].sort().join('|')
    && shapeOf(dirty.counts) === [...mod.COUNT_KEYS].sort().join('|')
    && dirty.items.some((item) => item.provides.join(',') === 'dirtyService')
  check('10 按键白名单与零泄漏：条目键恰好 name/source/wired/provides/file、顶层键恰好 11 个、counts 键恰好 5 个；'
    + '用户空间清单里的 body/subject/private:/reserve_price/cost_model/signature 哨兵一个都不出现在输出里'
    + '（合法 provides 照常透出，不得过度脱敏、也不得降级）',
  !dirtyText.includes(SENTINEL) && !dirtyText.includes('private:') && forbidden.length === 0 && whitelistOk
  && dirty.degraded === false && dirty.items.length === 2,
  `哨兵出现=${dirtyText.includes(SENTINEL)}；private: 出现=${dirtyText.includes('private:')}；`
  + `本该被丢弃的键出现=${forbidden.join(',') || '无'}；条目键=${itemKeys}；顶层键数=${Object.keys(dirty).length}；`
  + `provides 透出=${JSON.stringify(dirty.items.map((item) => item.provides))}`)

  // ---------- 11. 配置契约负控 ----------
  const refuses = (raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const defaults = mod.Config.parse({})
  const huge = await mountWith(mod, { ...FIX_CONFIG, max_items: 1e9, max_bytes: 1e9 })
  fibers.push(huge.fiber)
  const hugeSnap = huge.box.handle.snapshot()
  const negative = await mountWith(mod, { ...FIX_CONFIG, max_items: -5, max_bytes: -5 })
  fibers.push(negative.fiber)
  const negSnap = negative.box.handle.snapshot()
  const fractional = await mountWith(mod, { ...FIX_CONFIG, max_items: 7.9 })
  fibers.push(fractional.fiber)
  const fracSnap = fractional.box.handle.snapshot()
  const nanViews = await mountWith(mod, { ...FIX_CONFIG, max_items: Number.NaN, max_bytes: Number.NaN })
  fibers.push(nanViews.fiber)
  const nanSnap = nanViews.box.handle.snapshot()
  check('11 配置契约负控：未知键/错误类型/非对象入参一律被拒（不得静默放行）；默认值 200/256 且五个键齐备；'
    + '越界夹取（max_items 1e9→全 10 条；-5→0 条但 counts 真值 10；7.9→7 条；NaN→默认 200）',
  refuses({ max_items: 3, typo_key: 1 }) === 'refused' && refuses({ max_bytes: 'many' }) === 'refused'
  && refuses(42) === 'refused' && Object.keys(defaults).join(',') === 'modules_dir,inventory,user_space,max_items,max_bytes'
  && defaults.max_items === 200 && defaults.max_bytes === 256
  && hugeSnap.items.length === 10 && hugeSnap.omitted_items === 0
  && negSnap.items.length === 0 && negSnap.omitted_items === 10 && negSnap.counts.total === 10
  && fracSnap.items.length === 7 && fracSnap.omitted_items === 3
  && nanSnap.items.length === 10 && nanSnap.clipped === 0,
  `未知键=${refuses({ max_items: 3, typo_key: 1 })} 错类型=${refuses({ max_bytes: 'many' })} 非对象=${refuses(42)}；`
  + `默认=${JSON.stringify(defaults)}；1e9 → ${hugeSnap.items.length} 条；-5 → ${negSnap.items.length} 条`
  + `（counts.total=${negSnap.counts.total}）；7.9 → ${fracSnap.items.length} 条；NaN → ${nanSnap.items.length} 条 clipped=${nanSnap.clipped}`)

  // ---------- 12. headline 正控 ----------
  const headline = market.headline()
  const degradedHeadline = (await mountWith(mod, { modules_dir: ABSENT, inventory: FIX_INVENTORY }))
  fibers.push(degradedHeadline.fiber)
  const brokenText = degradedHeadline.box.handle.headline()
  check('12 headline 正控：夹具下摘要逐字一致（含三源计数/未装配数/不一致提示）、字节 ≤ max_bytes、'
    + '降级摘要不含数字也不为空',
  headline === FIX_HEADLINE && Buffer.byteLength(headline, 'utf8') <= 256
  && !/\d/.test(brokenText) && brokenText.length > 0,
  `headline="${headline}"（手算 "${FIX_HEADLINE}"，${Buffer.byteLength(headline, 'utf8')} 字节）；`
  + `降级摘要="${brokenText}"`)

  // ---------- 13. 真数据正控 ----------
  const realMount = await mountWith(mod, { modules_dir: REAL_MODULES, inventory: REAL_INVENTORY,
    user_space: join(ROOT, 'tmp', 't267-market-gate-no-user-space') })
  fibers.push(realMount.fiber)
  const real = realMount.box.handle.snapshot()
  const realNames = real.items.map((item) => item.name)
  const coverageText = readFileSync(REAL_COVERAGE, 'utf8')
  const coverageSection = coverageText.split('## 2. 插件归属')[1].split('## 3.')[0]
  const coverageNames = coverageSection.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|')[1].trim())
    .filter((name) => name !== '' && name !== '插件' && !/^-+$/.test(name))
    .sort()
  const evolveNames = real.items.filter((item) => item.source === 'evolve').map((item) => item.name)
  const realOk = JSON.stringify(real.counts) === JSON.stringify(REAL_COUNTS)
    && real.items.length === 37 && real.inconsistent === false && JSON.stringify(real.differences) === '[]'
    && real.truncated === false && real.clipped === 0 && real.degraded === false && real.reason === ''
    && !realNames.includes('index')                                   // 模块发现入口不是插件
    && real.items.every((item) => item.wired === true)
    && JSON.stringify([...realNames].sort()) === JSON.stringify(coverageNames)
    && evolveNames.includes('canary')                                 // 字面口径：其能力描述含"自进化产物"
    && real.items.find((item) => item.name === 'pipeline-view')?.provides.join(',') === 'pipelineView'
    && real.items.find((item) => item.name === 'supplier-scorecard')?.provides.length === 0
    && real.items.find((item) => item.name === 'webui')?.source === 'human'
    && real.items.find((item) => item.name === 'pipeline-view')?.file === F(join(REAL_MODULES, 'pipeline-view.mjs'))
  check('13 真数据正控：真 `host/modules/` + 真 `docs/design/14-plugin-inventory.md`（另一主体维护的真源）'
    + '→ items 37 / counts 12-25-0-37-0/ 三源一致 / 无截断；条目名集合与 `15-requirements-coverage.md` §2 '
    + '的插件归属表**逐名一致**（第二个鼻子）；`index.mjs` 不进条目；`supplier-scorecard` 的清单列写的是'
    + '"见模块 provides" → provides 照抄为 []（不猜）',
  realOk,
  `counts=${JSON.stringify(real.counts)}（手算 ${JSON.stringify(REAL_COUNTS)}）items=${real.items.length}`
  + ` inconsistent=${real.inconsistent} differences=${JSON.stringify(real.differences)}`
  + ` truncated=${real.truncated} 未装配=${real.items.filter((item) => !item.wired).length}`
  + `；与 15 §2 逐名一致=${JSON.stringify([...realNames].sort()) === JSON.stringify(coverageNames)}（${coverageNames.length} 名）`
  + `；evolve=${evolveNames.length} 含 canary=${evolveNames.includes('canary')}`
  + `；pipeline-view.provides=${JSON.stringify(real.items.find((item) => item.name === 'pipeline-view')?.provides)}`
  + ` supplier-scorecard.provides=${JSON.stringify(real.items.find((item) => item.name === 'supplier-scorecard')?.provides)}`)
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 200)}`)
}

for (const fiber of fibers) {
  try {
    await fiber.dispose()
  } catch { /* 卸载失败不影响断言结果 */ }
}

finish()
