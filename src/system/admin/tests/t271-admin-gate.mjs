/**
 * t271-admin-gate —— admin 道宿主侧两个产物（`admin-guard` 鉴权插件 + `admin-view` 只读视图）的
 * **围栅门**（宿主侧人工维护，不由被围对象自己写；ADR-0016 / D-036）。
 *
 * 被围对象（都在进树目录，`host/modules/`）：
 *   · `admin-guard.mjs` —— token 校验 / 会话 / 有界冷却 / 统一拒绝；
 *   · `admin-view.mjs`  —— 阻塞清单 + 进度计数的只读投影。
 * 实际加载到的绝对路径、字节数与 sha256 写进第 1 条断言的 detail（变异自证靠这一行确认「红的是我改的
 * 那一份」，而不是"看着红"）。
 *
 * 本门**自己造夹具**（`tmp/t271-admin-gate-fixtures/`，gitignored）：快照文件按写入器契约逐字段写出来，
 * 不依赖 `tmp/` 里的任何演示数据；手算值（`HAND_*`）是**不看实现**写下来的。
 *
 * 断言（18 条；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：两个 manifest 齐备 + import 白名单 + 打印实际加载路径/字节数/sha256
 *   2 挂载/卸载正控：句柄键恰好是声明契约；dispose 后 `ctx.get` 不存在、effect 归零、**会话表归零**
 *   3 统一拒绝体逐字节负控：五类失败（未启用/缺 token/错 token/会话过期/冷却中）同状态同 body（逐字节），
 *     只有内部 `reason` 不同，且 body 里没有 `reason` 字段、没有 token
 *   4 无 token 不成会话负控：空/缺 token 一律拒且**没有 cookie**；0600 文件来源可用、0644 文件来源视为未启用
 *   5 错误 token 无 oracle 负控：四种"接近正确"的提交 → 输出**逐字节相同**，响应里搜不到提交值与原 token
 *   6 提权正控：真 token → 200 语义 + `Set-Cookie` 四件（名字/HttpOnly/SameSite=Strict/Path）+
 *     会话 id 与 token 无派生关系（长度 ≥128 bit、不含 token）+ 切道白名单正负控
 *   7 会话过期回拒负控：假时钟推过 TTL → 回到统一拒绝体、会话计数归零；再推任意时长也不会复活
 *   8 冷却负控：连 5 次失败进入冷却；冷却内**正确 token 也拒**、已提权会话一并作废；
 *     冷却结束**不自动提权**（必须重新提交）、再提交正确 token 才成功（有界，不是永久锁死）
 *   9 无暗门负控（假时钟推过任意时长）：未提权时无论时钟怎么推都没有任何 ok / 会话；
 *     源码级断言：没有定时器、没有 auto-* 提权分支
 *  10 快照手算正控：真样例快照 → blocks/counts/progress 逐条等于手算值、键集恰好是输出白名单
 *  11 只组合不自算正控：counts 与 blocks 故意不一致 → **照抄 counts**（不重算、不用列表长度冒充计数）
 *  12 快照降级负控：10 类缺失/坏形状 → 不抛、`degraded:true`+有名 reason+next_action、全零同键集、
 *     headline 无数字；**合法零计数不降级**；没有任何一条降级被当成健康（「零阻塞冒充健康」是必红项）
 *  13 有界负控：blocks/refs 越上限只列前 N 条并在 omitted_* 报数（计数一条不少）
 *  14 确定性负控：同输入两次 project/snapshot **字节一致**、跨实例一致、冻结输入不抛错且一致
 *  15 泄漏负控：私域/正文键（键名与键值、进度里的非法键名、计数里的额外键）一个都不出现；
 *     被过滤的保留字段统一 `(redacted)`
 *  16 静态负控：两模块源码零写文件/子进程/网络/事件/随机/定时器/账本调用；guard 的墙钟只出现一次；
 *     比较路径只有 sha256 + 恒定时间比较（没有字符串前缀类比较）；扫描器**非空转**对照
 *  17 配置契约负控：未知键/错误类型/非对象入参被拒；默认值与越界夹取逐条断言
 *  18 token 四处不出现（宿主侧四搜）：stats/config/elevate/authorized/unauthorized 全部串起来
 *     都搜不到 token、也搜不到它的 sha256 摘要（连前 8 位都没有）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 * 用法：`node host/t271-admin-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
// `cordis` 是宿主私有的裸名依赖：搬迁后本文件不在 `host/` 下，改为按**显式解析**导入
// （见下方 `CORDIS_URL`；与搬迁前 Node 从 `host/node_modules` 上溯到的是同一份）。
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 实现已搬进 `src/<层>/<插件>/tests/`（迁移阶段 4.2 的续搬，EV-173）：宿主目录由仓库根推出
// （`src/<层>/<插件>/tests/` 4 层上溯），旧位置 `host/` 留**薄转发**；
// 本文件其余逻辑与搬迁前逐行相同（`join(HERE, '..')` 仍是仓库根）。
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'host')
// 宿主内核解析（搬迁后本文件不在 `host/` 下）：裸名 `cordis` 从**宿主目录**解析 —— 与搬迁前 Node 上溯到
// `host/node_modules/` 的那一份**同一个文件**（`cordis` 的 `main`/`exports` 都指向 `lib/index.js`）。
const CORDIS_URL = process.env.QUOTAGENT_CORDIS
  ? pathToFileURL(process.env.QUOTAGENT_CORDIS).href
  : pathToFileURL(join(HERE, 'node_modules', 'cordis', 'lib', 'index.js')).href
const { Context, EventsService } = await import(CORDIS_URL)
const ROOT = join(HERE, '..')
// 两个实体已随批 `EV-176` 搬进插件 `code/`（旧路径只剩薄重导）：本门读的是实体那一份。
const GUARD_PATH = join(ROOT, 'src', 'system', 'admin', 'code', 'admin-guard.mjs')
const VIEW_PATH = join(ROOT, 'src', 'system', 'admin', 'code', 'admin-view.mjs')
const FIX = join(ROOT, 'tmp', 't271-admin-gate-fixtures')

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const finish = () => {
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  process.stdout.write(JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures,
    total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

const TOKEN_ENV = 'QUOTAGENT_T271_TOKEN'
const ABSENT_ENV = 'QUOTAGENT_T271_ABSENT'
const TOKEN = 't271-token-4f3c9b21e7a5d608-not-a-real-secret'
process.env[TOKEN_ENV] = TOKEN

mkdirSync(FIX, { recursive: true })
const writeFixture = (name, payload) => {
  const path = join(FIX, name)
  writeFileSync(path, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1), 'utf8')
  return path
}

/** 挂载：照抄产物声明的 `inject`（写成 [] 会让它取不到依赖），并包装 `provide` 抓句柄。 */
const mountWith = async (mod, raw) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
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
  return { ctx, fiber, box }
}

const keySet = (obj) => Object.keys(obj ?? {}).sort().join('|')
const firstSegment = (setCookie) => String(setCookie).split(';')[0]
const cookieHeader = (setCookie) => ({ headers: { cookie: firstSegment(setCookie) } })
const shapeKeySet = (obj) => Object.keys(obj ?? {}).sort().join('|')

// ---------------------------------------------------------------------------
// 手算夹具（**不看实现**写下来的）
// ---------------------------------------------------------------------------

/** 合法快照：2 条真阻塞（plugin-request / credential）+ 声明的计数与进度。 */
const GOOD_SNAPSHOT = {
  generated_at: '2026-09-21T12:00:00Z',
  counts: { blocked: 2, pending: 0, resolved: 1, rejected: 0, expired: 0 },
  counts_source: 'registry+ledger',
  blocks: [
    { block_id: 'blk-advisor-1', kind: 'plugin-request', state: 'blocked',
      reason: 'Jev 建议层插件未落地', required_action: '人工决定排期', refs: ['progress-checklist'] },
    { block_id: 'blk-mail-1', kind: 'credential', state: 'blocked',
      reason: '缺 SMTP/IMAP 凭据', required_action: '在面板内提交凭据', refs: ['FR-INTEG-003'] },
  ],
  progress: { done: 41, todo: 7, blocked: 2, source: 'registry' },
}
const HAND_COUNTS = { blocked: 2, pending: 0, resolved: 1, rejected: 0, expired: 0, source: 'registry+ledger' }
const HAND_PROGRESS = { blocked: 2, done: 41, todo: 7, source: 'registry' }
const HAND_BLOCKS = [
  { block_id: 'blk-advisor-1', kind: 'plugin-request', state: 'blocked',
    reason: 'Jev 建议层插件未落地', required_action: '人工决定排期', refs: ['progress-checklist'] },
  { block_id: 'blk-mail-1', kind: 'credential', state: 'blocked',
    reason: '缺 SMTP/IMAP 凭据', required_action: '在面板内提交凭据', refs: ['FR-INTEG-003'] },
]
const OUTPUT_KEYS = ['blocks', 'bounded', 'counts', 'degraded', 'next_action', 'omitted_blocks',
  'omitted_refs', 'privacy', 'progress', 'reason', 'source'].sort().join('|')
const STATES = ['blocked', 'pending', 'resolved', 'rejected', 'expired']
const BLOCK_KEYS = ['block_id', 'kind', 'reason', 'refs', 'required_action', 'state'].sort().join('|')
const COUNTS_KEYS = [...STATES, 'source'].sort().join('|')
const BLOCK_KEYS_ORDERED = ['block_id', 'kind', 'state', 'reason', 'required_action', 'refs']

/** 只组合不自算探针：counts 说 blocked=7，列表只给 1 条 → 必须照抄 7（重算就会变成 1）。 */
const MISMATCH_SNAPSHOT = {
  counts: { blocked: 7, pending: 3, resolved: 9, rejected: 1, expired: 0 },
  counts_source: 'ledger',
  blocks: [{ block_id: 'only-one', kind: 'credential', state: 'blocked', reason: 'r', required_action: 'a',
    refs: [] }],
  progress: { done: 5, todo: 5, source: 'ledger' },
}

/** 有界探针：10 条阻塞，每条 3 个 refs。 */
const BOUND_SNAPSHOT = {
  counts: { blocked: 10, pending: 0, resolved: 0, rejected: 0, expired: 0 },
  counts_source: 'registry',
  blocks: Array.from({ length: 10 }, (_, index) => ({ block_id: `bound-${index + 1}`, kind: 'credential',
    state: 'blocked', reason: `r${index + 1}`, required_action: 'a', refs: [`ref-a-${index + 1}`,
      `ref-b-${index + 1}`, `ref-c-${index + 1}`] })),
  progress: { done: 1, source: 'registry' },
}
const MANY_SNAPSHOT = {
  counts: { blocked: 1200, pending: 0, resolved: 0, rejected: 0, expired: 0 },
  counts_source: 'registry',
  blocks: Array.from({ length: 1200 }, (_, index) => ({ block_id: `many-${index + 1}`, kind: 'credential',
    state: 'blocked', reason: 'r', required_action: 'a', refs: [] })),
  progress: { done: 1, source: 'registry' },
}

/** 泄漏探针：私域/正文当**键名**与**键值**放；进度里塞非法键名；计数里塞额外键。 */
const SENTINEL = 'SENTINEL-ADMIN-7b2'
const DIRTY_SNAPSHOT = {
  generated_at: '2026-09-21T00:00:00Z',
  counts: { blocked: 1, pending: 0, resolved: 0, rejected: 0, expired: 0,
    'private:note': `${SENTINEL}-counts` },
  counts_source: 'registry',
  blocks: [
    { block_id: 'dirty-1', kind: `private:cost_model=${SENTINEL}`, state: 'blocked',
      reason: `body=${SENTINEL}`, required_action: 'clean-action',
      refs: [`subject=${SENTINEL}`, `body=${SENTINEL}-ref`, 'ref-ok-1'],
      body: `${SENTINEL}-body`, cost_floor: `${SENTINEL}-floor`, 'private:cost': `${SENTINEL}-private` },
    { block_id: `dirty\u00002${SENTINEL}`, kind: 'credential', state: `blocked\u0001${SENTINEL}`,
      reason: 'clean-reason', required_action: 'a', refs: [] },
  ],
  progress: { done: 1, caliber: 'registry', phase: 'phase-ok', next_task: `body=${SENTINEL}`,
    sources: { registry: 'ok', 'private:foo': 'secret' }, 'private:foo': 1, body: 2, 'not a key!': 3,
    nested: { a: 1 } },
}

// 静态扫描needs（只扫候选源码；扫的是**产物**，不是本门）
const WRITE_NEEDLES = ['writeFileSync', 'appendFile', 'createWriteStream', 'unlinkSync', 'unlink(',
  'mkdirSync', 'rmSync', 'truncate', 'child_process', 'execFile', 'execSync', 'spawn', 'fetch(',
  'createServer', 'XMLHttpRequest', 'ctx.events', 'ctx.on(', 'setInterval(', 'setTimeout(',
  'Math.random', 'ledger', 'append(']
const VIEW_NEEDLES = [...WRITE_NEEDLES, 'Date.now', 'new Date', 'process.env', 'node:http']
const GUARD_NEEDLES = [...WRITE_NEEDLES, 'node:http', 'node:fs/promises']
const scanSource = (src, needles) => needles.filter((needle) => src.includes(needle))
/** 字符串比较类写法（前缀/切片/下标）—— token 比较**只能**走摘要 + 恒定时间比较。 */
const COMPARE_NEEDLES = ['startsWith(', 'substring(', 'indexOf(', 'charAt(', 'localeCompare(']
/** 「时间到了就通过」这类暗门分支（ASCII 记号，避免扫描到注释里否认它的话）。 */
const AUTO_DOOR_NEEDLES = ['autoApprove', 'auto_approve', 'autoElevate', 'auto_elevate', 'autoGrant',
  'grantWithoutToken', 'allowWithoutToken', 'waitFor']

const fibers = []
const guardSource = readFileSync(GUARD_PATH, 'utf8')
const viewSource = readFileSync(VIEW_PATH, 'utf8')
let guard = null
let view = null

try {
  const guardMod = await import(pathToFileURL(GUARD_PATH).href)
  const viewMod = await import(pathToFileURL(VIEW_PATH).href)

  // ---------- 1. 契约正控 ----------
  const importsOf = (src) => [...src.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const guardImports = importsOf(guardSource)
  const viewImports = importsOf(viewSource)
  const ALLOWED = { guard: ['node:crypto', 'node:fs', '../lib/std-schema.mjs'],
    view: ['node:fs', '../lib/std-schema.mjs'] }
  const badImports = [...guardImports.filter((s) => !ALLOWED.guard.includes(s)),
    ...viewImports.filter((s) => !ALLOWED.view.includes(s))]
  const manifestOf = (mod, name, service) => mod.name === name
    && Array.isArray(mod.inject) && mod.inject.length === 0
    && Array.isArray(mod.builtin) && mod.builtin.length === 0
    && Array.isArray(mod.usedServices) && mod.usedServices.length === 0
    && Array.isArray(mod.provides) && mod.provides.join(',') === service
    && typeof mod.Config?.parse === 'function'
    && typeof mod.Config?.['~standard']?.validate === 'function'
    && typeof mod.apply === 'function' && typeof mod.fixture?.sample === 'function'
  const manifestBad = [
    ...(manifestOf(guardMod, 'admin-guard', 'adminGuard') ? [] : ['admin-guard']),
    ...(manifestOf(viewMod, 'admin-view', 'adminView') ? [] : ['admin-view']),
  ]
  check('1 契约正控：两模块 manifest 齐备（name/inject=[]/builtin/usedServices/provides/Config/apply/fixture）'
    + '且只 import 白名单（打印实际加载路径/字节数/sha256）',
  manifestBad.length === 0 && badImports.length === 0,
  `guard=${GUARD_PATH}（${Buffer.byteLength(guardSource, 'utf8')} 字节，sha256=${sha256(guardSource).slice(0, 16)}…，`
  + `imports=${guardImports.join(',')}）；view=${VIEW_PATH}（${Buffer.byteLength(viewSource, 'utf8')} 字节，`
  + `sha256=${sha256(viewSource).slice(0, 16)}…，imports=${viewImports.join(',')}）；`
  + `manifest 问题=${manifestBad.join(',') || '无'}；越界 import=${badImports.join(',') || '无'}`)

  // ---------- 2. 挂载正控 + 卸载（含会话表回收） ----------
  const probeG = await mountWith(guardMod, {})
  fibers.push(probeG.fiber)
  const effectsBefore = probeG.fiber.getEffects().length
  const guardKeys = keySet(probeG.box.handle)
  const probeV = await mountWith(viewMod, {})
  fibers.push(probeV.fiber)
  const viewKeys = keySet(probeV.box.handle)
  const disposeG = await mountWith(guardMod, { token_env: TOKEN_ENV })
  fibers.push(disposeG.fiber)
  const disposeSession = disposeG.box.handle.elevate(TOKEN)
  const sessionsBeforeDispose = disposeG.box.handle.stats().sessions
  await disposeG.fiber.dispose()
  const sessionsAfterDispose = disposeG.box.handle.stats().sessions
  await probeG.fiber.dispose()
  await probeV.fiber.dispose()
  const guardGone = probeG.ctx.get('adminGuard') === undefined
  const viewGone = probeV.ctx.get('adminView') === undefined
  check('2 挂载/卸载正控：句柄键恰好是声明契约；dispose 后 `ctx.get` 不存在、effect 归零、会话表归零'
    + '（未卸载时能提权出会话 → 说明「会话在内存、随 fiber 回收」而不是靠进程退出兜底）',
  guardKeys === 'authorized|config|elevate|logout|setClock|stats|switchAllowed|unauthorized'
  && viewKeys === 'headline|project|snapshot'
  && effectsBefore > 0 && probeG.fiber.getEffects().length === 0 && probeV.fiber.getEffects().length === 0
  && guardGone && viewGone && disposeSession.ok === true && sessionsBeforeDispose === 1
  && sessionsAfterDispose === 0,
  `guard 句柄键=${guardKeys}；view 句柄键=${viewKeys}；effect ${effectsBefore} → `
  + `${probeG.fiber.getEffects().length}/${probeV.fiber.getEffects().length}；`
  + `dispose 后 ctx.get：adminGuard=${String(probeG.ctx.get('adminGuard'))} adminView=${String(probeV.ctx.get('adminView'))}；`
  + `卸载前后会话=${sessionsBeforeDispose} → ${sessionsAfterDispose}`)
  if (!guardMod || !viewMod) finish()

  // ---------- 3. 统一拒绝体逐字节（五类失败） ----------
  const gNotEnabled = await mountWith(guardMod, { token_env: ABSENT_ENV, token_file: '' })
  fibers.push(gNotEnabled.fiber)
  const gMissingToken = await mountWith(guardMod, { token_env: TOKEN_ENV })
  fibers.push(gMissingToken.fiber)
  const gWrongToken = await mountWith(guardMod, { token_env: TOKEN_ENV })
  fibers.push(gWrongToken.fiber)
  const gExpired = await mountWith(guardMod, { token_env: TOKEN_ENV, session_ttl_ms: 1000 })
  fibers.push(gExpired.fiber)
  const boxExpired = { now: 1000000 }
  gExpired.box.handle.setClock(() => boxExpired.now)
  const sExpired = gExpired.box.handle.elevate(TOKEN)
  boxExpired.now += 5000
  const gCooldown = await mountWith(guardMod, { token_env: TOKEN_ENV, failure_threshold: 5,
    cooldown_ms: 1000, max_cooldown_ms: 60000 })
  fibers.push(gCooldown.fiber)
  const boxCooldown = { now: 2000000 }
  gCooldown.box.handle.setClock(() => boxCooldown.now)
  const sCooldown = gCooldown.box.handle.elevate(TOKEN)
  for (let i = 0; i < 5; i += 1) gCooldown.box.handle.elevate('definitely-wrong')

  const DENIALS = {
    '未启用': gNotEnabled.box.handle.elevate(TOKEN),
    '缺 token': gMissingToken.box.handle.elevate(undefined),
    '错 token': gWrongToken.box.handle.elevate('definitely-wrong'),
    '会话过期': gExpired.box.handle.authorized(cookieHeader(sExpired.cookie)),
    '冷却中': gCooldown.box.handle.elevate(TOKEN),
  }
  const denialList = Object.entries(DENIALS)
  const bodies = denialList.map(([, out]) => out.body)
  const statuses = denialList.map(([, out]) => out.status)
  const reasons = denialList.map(([, out]) => out.reason)
  const headerKeys = denialList.map(([, out]) => keySet(out.headers))
  check('3 统一拒绝体逐字节负控：五类失败（未启用/缺 token/错 token/会话过期/冷却中）状态相同、'
    + 'body **逐字节相同**（无区分字段）、只用内部 reason 区分；body 里没有 reason、没有 token',
  statuses.every((code) => code === 401) && new Set(bodies).size === 1
  && bodies[0] === guardMod.UNAUTHORIZED_BODY && denialList.every(([, out]) => out.ok === false)
  && new Set(headerKeys).size === 1 && new Set(reasons).size === 5
  && !bodies[0].includes('reason') && !bodies[0].includes(TOKEN)
  && guardMod.UNAUTHORIZED_STATUS === 401,
  `status=${JSON.stringify(statuses)}；body 去重后 ${new Set(bodies).size} 种=${JSON.stringify(bodies[0])}；`
  + `reason=${JSON.stringify(reasons)}（五类互不相同，只给门与宿主日志）`)

  // ---------- 4. 无 token 不成会话（+ 0600 文件来源） ----------
  const gBlank = await mountWith(guardMod, { token_env: TOKEN_ENV })
  fibers.push(gBlank.fiber)
  const blankMissing = gBlank.box.handle.elevate(undefined)
  const blankEmpty = gBlank.box.handle.elevate('')
  const blankStats = gBlank.box.handle.stats()
  const insecurePath = join(FIX, 'token-0644')
  writeFileSync(insecurePath, `${TOKEN}\n`)
  chmodSync(insecurePath, 0o644)
  const gInsecure = await mountWith(guardMod, { token_env: ABSENT_ENV, token_file: insecurePath })
  fibers.push(gInsecure.fiber)
  const insecureOut = gInsecure.box.handle.elevate(TOKEN)
  const securePath = join(FIX, 'token-0600')
  writeFileSync(securePath, `${TOKEN}\n`)
  chmodSync(securePath, 0o600)
  const gFileToken = await mountWith(guardMod, { token_env: ABSENT_ENV, token_file: securePath })
  fibers.push(gFileToken.fiber)
  const fileOut = gFileToken.box.handle.elevate(TOKEN)
  check('4 无 token 不成会话负控：缺/空 token 一律拒且**没有 cookie**（stats.elevated 仍 0）；'
    + '0600 文件来源可用；0644 文件来源视为未启用（仍走统一拒绝体）',
  blankMissing.ok === false && blankEmpty.ok === false
  && blankMissing.cookie === undefined && blankEmpty.cookie === undefined
  && blankStats.elevated === 0 && blankStats.sessions === 0
  && insecureOut.ok === false && insecureOut.body === guardMod.UNAUTHORIZED_BODY
  && gInsecure.box.handle.stats().token_source === 'file-insecure-mode'
  && fileOut.ok === true && String(fileOut.cookie).includes('Path=/quotagent/admin')
  && gFileToken.box.handle.stats().token_source === 'file',
  `缺 token → ok=${blankMissing.ok} cookie=${String(blankMissing.cookie)}；空 token → ok=${blankEmpty.ok}；`
  + `stats.elevated=${blankStats.elevated} sessions=${blankStats.sessions}；`
  + `0644 文件 → ok=${insecureOut.ok} source=${gInsecure.box.handle.stats().token_source}；`
  + `0600 文件 → ok=${fileOut.ok} source=${gFileToken.box.handle.stats().token_source}`)

  // ---------- 5. 错误 token 无 oracle ----------
  const gOracle = await mountWith(guardMod, { token_env: TOKEN_ENV })
  fibers.push(gOracle.fiber)
  const tokenShaHex = sha256(TOKEN)
  const VARIANTS = {
    '合法长度错内容': 'x'.repeat(TOKEN.length),
    '正确 token 的 sha256 十六进制': tokenShaHex,
    '正确 token 去末字符': TOKEN.slice(0, -1),
    '正确 token 加一字符': `${TOKEN}x`,
  }
  const oracleOuts = Object.entries(VARIANTS).map(([label, value]) => ({ label, value,
    out: gOracle.box.handle.elevate(value) }))
  const oracleTexts = oracleOuts.map((item) => JSON.stringify(item.out))
  const oracleLeaks = oracleOuts.filter((item) => oracleTexts[oracleOuts.indexOf(item)]
    .includes(item.value) || oracleTexts[oracleOuts.indexOf(item)].includes(TOKEN)
    || oracleTexts[oracleOuts.indexOf(item)].includes(tokenShaHex.slice(0, 16))).map((item) => item.label)
  check('5 错误 token 无 oracle 负控：四种「接近正确」的提交（等长错内容 / 正确值的 sha256 / 去末字符 / '
    + '加一字符）→ 输出**逐字节相同**（同 reason 同 body），响应里搜不到提交值、原 token 与其摘要前 16 位',
  new Set(oracleTexts).size === 1 && oracleLeaks.length === 0
  && oracleOuts.every((item) => item.out.ok === false && item.out.reason === 'token-mismatch'
    && item.out.status === 401 && item.out.body === guardMod.UNAUTHORIZED_BODY),
  `四种输出去重后 ${new Set(oracleTexts).size} 种；reason=${JSON.stringify(oracleOuts.map((i) => i.out.reason))}；`
  + `泄漏=${oracleLeaks.join(',') || '无'}；body=${JSON.stringify(oracleOuts[0].out.body)}`)

  // ---------- 6. 提权正控（真 token） ----------
  const gOk = await mountWith(guardMod, { token_env: TOKEN_ENV, session_ttl_ms: 60000 })
  fibers.push(gOk.fiber)
  const boxOk = { now: 5000000 }
  gOk.box.handle.setClock(() => boxOk.now)
  guard = gOk.box.handle
  const session = guard.elevate(TOKEN)
  const authorized = guard.authorized(cookieHeader(session.cookie))
  const guardConfig = guard.config()
  const switchOk = guard.switchAllowed('supplier')
  const switchBad = guard.switchAllowed('../../etc/passwd')
  const cookie = String(session.cookie)
  check('6 提权正控：真 token → ok + `Set-Cookie` 四件齐（qa_admin/HttpOnly/SameSite=Strict/Path=/quotagent/admin）、'
    + '会话 id ≥128 bit 且**不含 token**（非派生）；带该 cookie 的 authorized 通过；切道白名单正负控',
  session.ok === true && cookie.includes('qa_admin=') && cookie.includes('HttpOnly')
  && cookie.includes('SameSite=Strict') && cookie.includes('Path=/quotagent/admin')
  && typeof session.session_id === 'string' && session.session_id.length >= 22
  && session.session_id !== TOKEN && !session.session_id.includes(TOKEN)
  && authorized.ok === true && authorized.views.join(',') === 'contractor,supplier,ops,admin'
  && session.expires_at === boxOk.now + 60000 && guardConfig.admin_path === '/quotagent/admin'
  && switchOk.ok === true && switchOk.to === '/quotagent/supplier/'
  && switchBad.ok === false && switchBad.reason === 'view-not-allowed',
  `cookie="${cookie}"；session_id 长度=${session.session_id.length}（192 bit）；`
  + `authorized=${authorized.ok} views=${authorized.views.join(',')}；`
  + `switch supplier → ${switchOk.to}；switch 越界 → ok=${switchBad.ok}（${switchBad.reason}）`)

  // ---------- 7. 会话过期回拒 ----------
  boxExpired.now += 10 ** 12
  const expiredAgain = gExpired.box.handle.authorized(cookieHeader(sExpired.cookie))
  const expiredStats = gExpired.box.handle.stats()
  check('7 会话过期回拒负控：假时钟推过 TTL → 回到统一拒绝体（status/body 与其它四类相同）、会话计数归零；'
    + '再推 1e12 ms 也不会复活（过期只减权）',
  DENIALS['会话过期'].status === 401 && DENIALS['会话过期'].body === guardMod.UNAUTHORIZED_BODY
  && DENIALS['会话过期'].reason === 'session-expired' && expiredAgain.ok === false
  && expiredAgain.body === guardMod.UNAUTHORIZED_BODY && expiredStats.sessions === 0
  && expiredStats.sessions_expired >= 1,
  `过期后 authorized（再推 1e12 ms）→ ok=${expiredAgain.ok} reason=${expiredAgain.reason}；`
  + `sessions=${expiredStats.sessions} sessions_expired=${expiredStats.sessions_expired}`)

  // ---------- 8. 冷却（有界、正确 token 也拒、结束不自动提权） ----------
  const coolStats = gCooldown.box.handle.stats()
  const coolSessionAfter = gCooldown.box.handle.authorized(cookieHeader(sCooldown.cookie))
  boxCooldown.now += 60000
  const coolEndedStats = gCooldown.box.handle.stats()
  const oldCookieAfter = gCooldown.box.handle.authorized(cookieHeader(sCooldown.cookie))
  const reElevate = gCooldown.box.handle.elevate(TOKEN)
  const coolConfig = gCooldown.box.handle.config()
  check('8 冷却负控：连 5 次失败进入冷却（cooldown_active）；冷却内**正确 token 也拒**、已提权会话一并作废'
    + '（sessions 归零）；冷却结束**不自动提权**（elevated 计数不增、旧会话不复活），必须重新提交才成功；'
    + '冷却时长有界（≤ max_cooldown_ms）',
  coolStats.cooldown_active === true && coolStats.sessions === 0 && coolStats.dropped_by_cooldown >= 1
  && DENIALS['冷却中'].reason === 'cooldown' && coolSessionAfter.ok === false
  && coolEndedStats.cooldown_active === false && coolEndedStats.elevated === 1
  && oldCookieAfter.ok === false && reElevate.ok === true
  && coolConfig.cooldown_ms <= coolConfig.max_cooldown_ms && reElevate.session_id !== sCooldown.session_id
  && boxCooldown.now === 2060000,
  `冷却中：cooldown_active=${coolStats.cooldown_active} sessions=${coolStats.sessions} `
  + `dropped_by_cooldown=${coolStats.dropped_by_cooldown}；正确 token → reason=${DENIALS['冷却中'].reason}；`
  + `旧会话 → ok=${coolSessionAfter.ok}；冷却结束 → active=${coolEndedStats.cooldown_active} `
  + `elevated=${coolEndedStats.elevated}（未自动提权）旧会话=${oldCookieAfter.ok}；重新提交 → ${reElevate.ok}；`
  + `冷却窗口=${coolConfig.cooldown_ms}ms ≤ 上限 ${coolConfig.max_cooldown_ms}ms`)

  // ---------- 9. 无暗门（假时钟推过任意时长） ----------
  const gNoDoor = await mountWith(guardMod, { token_env: TOKEN_ENV })
  fibers.push(gNoDoor.fiber)
  const boxNoDoor = { now: 0 }
  gNoDoor.box.handle.setClock(() => boxNoDoor.now)
  let everOk = false
  for (const step of [1, 1000, 10 ** 9, 10 ** 12, 315360000000, 10 ** 15]) {
    boxNoDoor.now += step
    for (const raw of ['qa_admin=abc', `qa_admin=${'A'.repeat(32)}`, 'qa_admin=forged-session']) {
      if (gNoDoor.box.handle.authorized({ headers: { cookie: raw } }).ok) everOk = true
    }
    if (gNoDoor.box.handle.elevate(undefined).ok) everOk = true
    if (gNoDoor.box.handle.elevate('still-wrong').ok) everOk = true
  }
  const noDoorStats = gNoDoor.box.handle.stats()
  const autoDoorHits = scanSource(guardSource, AUTO_DOOR_NEEDLES)
  check('9 无暗门负控（假时钟推过任意时长：1/1e3/1e9/1e12/十年/1e15 ms）：未提权时没有任何 ok、没有会话、'
    + 'elevated 恒 0；源码级断言：没有定时器、没有 auto-* 提权分支（「等待」永不变成「成功」）',
  everOk === false && noDoorStats.elevated === 0 && noDoorStats.sessions === 0
  && noDoorStats.cooldowns >= 1 && autoDoorHits.length === 0
  && !guardSource.includes('setTimeout') && !guardSource.includes('setInterval'),
  `任意时长后是否出现过 ok=${everOk}；elevated=${noDoorStats.elevated} sessions=${noDoorStats.sessions}；`
  + `期间冷却触发 ${noDoorStats.cooldowns} 次（冷却只减权，不产生任何成功）；`
  + `源码暗门记号=${autoDoorHits.join(',') || '无'}；时钟推到=${boxNoDoor.now}`)

  // ---------- 10. 快照手算正控 ----------
  const goodPath = writeFixture('admin-good.json', GOOD_SNAPSHOT)
  const vGood = await mountWith(viewMod, { admin_snapshot: goodPath })
  fibers.push(vGood.fiber)
  view = vGood.box.handle
  const goodSnap = view.snapshot()
  const goodProjected = view.project(GOOD_SNAPSHOT)
  const blockKeySets = goodSnap.blocks.map(keySet)
  check('10 快照手算正控：真样例快照 → blocks 逐条等于手算值（含 refs）、counts 照抄 + 口径来源、'
    + 'progress 照抄；键集恰好是输出白名单；snapshot() 与 project(同一 payload) 一致',
  JSON.stringify(goodSnap.blocks) === JSON.stringify(HAND_BLOCKS)
  && JSON.stringify(goodSnap.counts) === JSON.stringify(HAND_COUNTS)
  && JSON.stringify(goodSnap.progress) === JSON.stringify(HAND_PROGRESS)
  && goodSnap.degraded === false && goodSnap.reason === '' && goodSnap.next_action === ''
  && goodSnap.omitted_blocks === 0 && goodSnap.omitted_refs === 0 && goodSnap.bounded === false
  && goodSnap.source === 'admin-view' && goodSnap.privacy.entry_bodies_included === false
  && keySet(goodSnap) === OUTPUT_KEYS && new Set(blockKeySets).size === 1
  && blockKeySets[0] === BLOCK_KEYS && keySet(goodSnap.counts) === COUNTS_KEYS
  && JSON.stringify(goodSnap) === JSON.stringify(goodProjected),
  `blocks=${goodSnap.blocks.length}（${goodSnap.blocks.map((b) => b.block_id).join(',')}）；`
  + `counts=${JSON.stringify(goodSnap.counts)}；progress=${JSON.stringify(goodSnap.progress)}；`
  + `键集==白名单=${keySet(goodSnap) === OUTPUT_KEYS}；块键集=${blockKeySets[0]}`)

  // ---------- 11. 只组合不自算 ----------
  const mismatchPath = writeFixture('admin-mismatch.json', MISMATCH_SNAPSHOT)
  const vMismatch = await mountWith(viewMod, { admin_snapshot: mismatchPath })
  fibers.push(vMismatch.fiber)
  const mismatchSnap = vMismatch.box.handle.snapshot()
  check('11 只组合不自算正控：counts 说 blocked=7 但列表只给 1 条 → **照抄 counts**（仍 7，不重算成 1，'
    + '也不用列表长度冒充计数，D-056）；progress 同样照抄',
  mismatchSnap.counts.blocked === 7 && mismatchSnap.counts.resolved === 9
  && mismatchSnap.blocks.length === 1 && mismatchSnap.counts.pending === 3
  && JSON.stringify(mismatchSnap.progress) === JSON.stringify({ done: 5, todo: 5, source: 'ledger' }),
  `counts.blocked=${mismatchSnap.counts.blocked}（手算 7）blocks=${mismatchSnap.blocks.length} 条；`
  + `counts=${JSON.stringify(mismatchSnap.counts)}`)

  // ---------- 12. 降级负控 ----------
  const BROKEN = [
    ['未配置路径', null],
    ['文件缺失', join(FIX, 'does-not-exist.json')],
    ['坏 JSON', writeFixture('bad-json.json', '{not json at all')],
    ['非对象（数组）', writeFixture('array.json', [1, 2, 3])],
    ['blocks 非数组', writeFixture('blocks-not-array.json', { blocks: {}, counts: { blocked: 1 },
      counts_source: 'registry', progress: { done: 1, source: 'registry' } })],
    ['计数非法（字符串）', writeFixture('counts-bad.json', { blocks: [], counts: { blocked: '5' },
      counts_source: 'registry', progress: { done: 1, source: 'registry' } })],
    ['计数为空对象（不得当成健康零）', writeFixture('counts-empty.json', { blocks: [], counts: {},
      counts_source: 'registry', progress: { done: 1, source: 'registry' } })],
    ['计数缺口径来源', writeFixture('counts-no-source.json', { blocks: [],
      counts: { blocked: 0, pending: 0, resolved: 0, rejected: 0, expired: 0 },
      progress: { done: 1, source: 'registry' } })],
    ['进度一个数字都没有', writeFixture('progress-no-number.json', { blocks: [],
      counts: { blocked: 0, pending: 0, resolved: 0, rejected: 0, expired: 0 }, counts_source: 'registry',
      progress: { source: 'registry' } })],
    ['进度缺口径来源', writeFixture('progress-no-source.json', { blocks: [],
      counts: { blocked: 0, pending: 0, resolved: 0, rejected: 0, expired: 0 }, counts_source: 'registry',
      progress: { done: 1 } })],
  ]
  let degradeOk = true
  let degradeDetail = ''
  const zeroShape = Object.fromEntries([...STATES.map((state) => [state, 0]), ['source', 'unavailable']])
  for (const [label, path] of BROKEN) {
    const boxed = await mountWith(viewMod, path ? { admin_snapshot: path } : {})
    fibers.push(boxed.fiber)
    let out = null
    let text = ''
    try {
      out = boxed.box.handle.snapshot()
      text = boxed.box.handle.headline()
    } catch (err) {
      degradeOk = false
      degradeDetail = `${label} 抛出 ${err.name}`
      break
    }
    const zero = Object.values(out.counts).every((value) => value === 0)
    const healthy = out.degraded === true && out.reason !== '' && out.next_action !== ''
      && out.blocks.length === 0 && out.omitted_blocks === 0 && out.bounded === false
      && JSON.stringify(out.counts) === JSON.stringify(zeroShape)
      && keySet(out) === OUTPUT_KEYS && Object.keys(out.progress).join(',') === 'source'
      && !/\d/.test(text) && viewMod.DEGRADED_REASONS.includes(out.reason)
    if (!healthy) {
      degradeOk = false
      degradeDetail = `${label} → degraded=${out.degraded} reason=${out.reason} counts=${JSON.stringify(out.counts)} headline="${text}"`
      break
    }
  }
  const legalZero = await mountWith(viewMod, { admin_snapshot: writeFixture('legal-zero.json', {
    blocks: [], counts: { blocked: 0, pending: 0, resolved: 0, rejected: 0, expired: 0 },
    counts_source: 'registry', progress: { done: 0, source: 'registry' } }) })
  fibers.push(legalZero.fiber)
  const legalZeroSnap = legalZero.box.handle.snapshot()
  // 互操作正控：兄弟写入器（`tools/refresh-admin-snapshot.py`）声明的形状 —— counts 把口径放在
  // `counts.source`、进度把口径放在 `progress.caliber`（并按 `sources` 的键名兜底），进度带 phase/next_task。
  // 口径必须**各读各的**（不得借另一处的口径冒充）→ 不得误判降级，也不得丢进度里的声明型字段。
  const interop = await mountWith(viewMod, { admin_snapshot: writeFixture('admin-interop.json', {
    generated_at: '2026-09-21T12:00:00Z',
    counts: { blocked: 2, pending: 1, resolved: 3, rejected: 0, expired: 0, source: 'registry+facts' },
    blocks: [{ block_id: 'b1', kind: 'credential', state: 'blocked', reason: 'r', required_action: 'a', refs: [] }],
    progress: { phase: 'P3 落地', next_task: 'T-272', done: 41, todo: 7, by_status: { done: 41 },
      checklist_rows: 120, caliber: 'progress-checklist+services',
      sources: { registry: 'ok', mail: 'unavailable' } } }) })
  fibers.push(interop.fiber)
  const interopSnap = interop.box.handle.snapshot()
  const derived = await mountWith(viewMod, { admin_snapshot: writeFixture('admin-derived.json', {
    counts: { blocked: 0, pending: 0, resolved: 0, rejected: 0, expired: 0 }, counts_source: 'registry',
    blocks: [], progress: { done: 1, sources: { registry: 'ok', mail: 'unavailable' } } }) })
  fibers.push(derived.fiber)
  const derivedSnap = derived.box.handle.snapshot()
  check('12 快照降级负控：10 类缺失/坏形状 → **不抛**、degraded:true + 有名 reason（闭合集合）+ next_action、'
    + '全零且与正常输出**同键集**、headline 无数字；合法零计数**不**降级；'
    + '没有任何一条降级被当成健康（「读不到」不得显示成「零阻塞」）；'
    + '互操作：计数口径读 `counts.source`、进度口径读 `progress.caliber`（或由 `sources` 键名拼出）'
    + '各读各的，进度里的声明型字段照常投影、嵌套对象与非法键名一律丢弃',
  degradeOk && legalZeroSnap.degraded === false
  && JSON.stringify(legalZeroSnap.counts) === JSON.stringify({ ...zeroShape, source: 'registry' })
  && legalZeroSnap.blocks.length === 0
  && interopSnap.degraded === false && interopSnap.counts.source === 'registry+facts'
  && JSON.stringify(interopSnap.progress) === JSON.stringify({ checklist_rows: 120, done: 41, todo: 7,
    phase: 'P3 落地', next_task: 'T-272', source: 'progress-checklist+services' })
  && derivedSnap.degraded === false
  && JSON.stringify(derivedSnap.progress) === JSON.stringify({ done: 1, source: 'mail+registry' }),
  `10 类坏输入全部降级=${degradeOk}${degradeDetail ? `；首个不合规：${degradeDetail}` : ''}；`
  + `合法零计数 → degraded=${legalZeroSnap.degraded} counts=${JSON.stringify(legalZeroSnap.counts)}；`
  + `互操作（counts.source + progress.caliber）→ degraded=${interopSnap.degraded} `
  + `counts.source=${interopSnap.counts.source} progress=${JSON.stringify(interopSnap.progress)}；`
  + `无 source/caliber 时由 sources 键名拼标签 → ${derivedSnap.progress.source}；`
  + `降级原因闭合集合=${viewMod.DEGRADED_REASONS.length} 个`)

  // ---------- 13. 有界负控 ----------
  const boundPath = writeFixture('admin-bound.json', BOUND_SNAPSHOT)
  const vBound3 = await mountWith(viewMod, { admin_snapshot: boundPath, max_blocks: 3, max_refs: 1 })
  fibers.push(vBound3.fiber)
  const bound3 = vBound3.box.handle.snapshot()
  const vBound0 = await mountWith(viewMod, { admin_snapshot: boundPath, max_blocks: 0 })
  fibers.push(vBound0.fiber)
  const bound0 = vBound0.box.handle.snapshot()
  check('13 有界负控：max_blocks=3 + 10 条 → 只列前 3 条、omitted_blocks=7；max_refs=1 → 每块只留 1 个 ref、'
    + 'omitted_refs 报数；max_blocks=0 → 不列任何块、omitted_blocks=10（计数一条不少，仍照抄 counts）',
  bound3.blocks.length === 3 && bound3.omitted_blocks === 7 && bound3.bounded === true
  && bound3.blocks.map((item) => item.block_id).join(',') === 'bound-1,bound-2,bound-3'
  && bound3.blocks.every((item) => item.refs.length === 1) && bound3.omitted_refs === 6
  && bound3.counts.blocked === 10
  && bound0.blocks.length === 0 && bound0.omitted_blocks === 10 && bound0.bounded === true
  && bound0.counts.blocked === 10,
  `max_blocks=3 → ${bound3.blocks.length} 条（${bound3.blocks.map((b) => b.block_id).join(',')}）`
  + `omitted_blocks=${bound3.omitted_blocks} omitted_refs=${bound3.omitted_refs}；`
  + `max_blocks=0 → ${bound0.blocks.length} 条 omitted_blocks=${bound0.omitted_blocks}；`
  + `counts.blocked=${bound3.counts.blocked}（照抄，不受有界影响）`)

  // ---------- 14. 确定性负控 ----------
  const once = JSON.stringify(view.snapshot())
  const twice = JSON.stringify(view.snapshot())
  const vOther = await mountWith(viewMod, { admin_snapshot: goodPath })
  fibers.push(vOther.fiber)
  const otherSnap = JSON.stringify(vOther.box.handle.snapshot())
  const frozenPayload = JSON.parse(JSON.stringify(GOOD_SNAPSHOT))
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item)
      Object.freeze(value)
    }
    return value
  }
  freeze(frozenPayload)
  let frozenOk = true
  try {
    frozenOk = JSON.stringify(view.project(frozenPayload)) === once
  } catch (err) {
    frozenOk = false
  }
  check('14 确定性负控：同一实例两次 snapshot() **字节一致**、跨实例一致、冻结输入不抛错且结果一致、'
    + 'headline 两次一致（不读墙钟、不随机、不依赖输入顺序）',
  once === twice && once === otherSnap && frozenOk
  && view.headline() === view.headline() && once.length > 100,
  `两次一致=${once === twice}（${once.length} 字节）；跨实例一致=${once === otherSnap}；`
  + `冻结输入一致=${frozenOk}；headline 两次一致=${view.headline() === view.headline()}`)

  // ---------- 15. 泄漏负控 ----------
  const dirtySnap = view.project(DIRTY_SNAPSHOT)
  const dirtyText = JSON.stringify(dirtySnap)
  const dirtyHeadline = view.headline()
  const dirtyBlockKeys = new Set(dirtySnap.blocks.flatMap((item) => Object.keys(item)))
  const leaked = [SENTINEL, 'private:', '"body"', 'cost_floor', 'reserve_price', 'subject', '"nested"',
    '"sources"', '"by_status"']
    .filter((needle) => dirtyText.includes(needle))
  const handProgress = { done: 1, phase: 'phase-ok', next_task: '(redacted)', source: 'registry' }
  check('15 泄漏负控：私域/正文的**键名与键值**（含计数里的额外键、进度里的非法键名与非数字、'
    + '嵌套对象 `sources`/`by_status`、控制字符）一个都不出现在输出里；被过滤的保留字段统一 `(redacted)`'
    + '（干净字段照常可读）；块键/计数键/进度键都落在白名单内',
  leaked.length === 0 && dirtyText.includes('(redacted)') && dirtySnap.counts.blocked === 1
  && keySet(dirtySnap.counts) === COUNTS_KEYS && dirtyBlockKeys.size <= BLOCK_KEYS.split('|').length
  && [...dirtyBlockKeys].sort().join('|') === BLOCK_KEYS_ORDERED.slice().sort().join('|')
  && JSON.stringify(dirtySnap.progress) === JSON.stringify(handProgress)
  && JSON.stringify(dirtySnap.blocks[0].refs) === JSON.stringify(['(redacted)', '(redacted)', 'ref-ok-1'])
  && !dirtyHeadline.includes(SENTINEL),
  `泄漏=${leaked.join(',') || '无'}；含 (redacted)=${dirtyText.includes('(redacted)')}；`
  + `块 refs=${JSON.stringify(dirtySnap.blocks[0].refs)}（干净 ref 照常可读）；`
  + `progress=${JSON.stringify(dirtySnap.progress)}（手算 ${JSON.stringify(handProgress)}）；`
  + `counts 键集=${keySet(dirtySnap.counts)}；块键集=${[...dirtyBlockKeys].sort().join('|')}`)

  // ---------- 16. 静态负控 ----------
  // 只扫**可执行代码**（剥掉注释）：注释里对纪律的说明不是证据，代码才是（本仓纪律：声明即事实）。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/gm, '$1')
  const guardCode = stripComments(guardSource)
  const viewCode = stripComments(viewSource)
  const guardHits = scanSource(guardCode, GUARD_NEEDLES)
  const viewHits = scanSource(viewCode, VIEW_NEEDLES)
  const compareHits = scanSource(guardCode, COMPARE_NEEDLES)
  const planted = "const a = Date.now(); setInterval(() => {}, 1); fs.writeFileSync('x'); "
    + "ctx.events.on('y'); Math.random(); spawn('ls'); ledger.append(); process.env.X"
  const plantedHits = scanSource(stripComments(planted), [...GUARD_NEEDLES, 'Date.now', 'process.env'])
  // 墙钟只在**默认时钟的定义处**出现（每次出现都必须落在定义 clock 的那一行）；决策一律走 clock()
  const clockLines = guardCode.split('\n').filter((line) => line.includes('Date.now'))
  const clockLinesOk = clockLines.length >= 1 && clockLines.length <= 3
    && clockLines.every((line) => line.includes('clock'))
  // 最强的一条 H1 断言：**连注释带数据**，两个文件里都不出现账本一词（没有账本路径，也没有账本服务句柄）
  const ledgerWordFiles = [['admin-guard', guardSource], ['admin-view', viewSource]]
    .filter(([, src]) => src.includes('ledger')).map(([name]) => name)
  check('16 静态负控：两模块源码（剥注释后的可执行代码）零写文件/子进程/网络/事件/随机/定时器/账本调用'
    + '（无写账本路径 = H1；连注释带数据都不出现账本一词）；guard 只读墙钟一次且仅用于默认时钟'
    + '（可被 setClock 替换）；token 比较只有 sha256 + 恒定时间比较（没有字符串前缀/切片类比较）；'
    + '扫描器**非空转**对照',
  guardHits.length === 0 && viewHits.length === 0 && compareHits.length === 0
  && ledgerWordFiles.length === 0 && clockLinesOk
  && guardCode.includes('timingSafeEqual') && guardCode.includes("createHash('sha256')")
  && guardCode.includes('setClock') && plantedHits.length >= 8,
  `guard 命中=${guardHits.join(',') || '无'}；view 命中=${viewHits.join(',') || '无'}；`
  + `比较类写法命中=${compareHits.join(',') || '无'}；`
  + `墙钟只在 ${clockLines.length} 行默认时钟定义里出现（每行都定义 clock）=${clockLinesOk}：`
  + `${clockLines.map((line) => line.trim().slice(0, 54)).join(' | ')}；`
  + `全文件出现账本一词的文件=${ledgerWordFiles.join(',') || '无'}；`
  + `非空转对照命中 ${plantedHits.length}/9 处=${plantedHits.join(',')}`)

  // ---------- 17. 配置契约负控 ----------
  const refuses = (mod, raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch (err) {
      return 'refused'
    }
  }
  const viewDefaults = viewMod.Config.parse({})
  const guardDefaults = guardMod.Config.parse({})
  const manyPath = writeFixture('admin-many.json', MANY_SNAPSHOT)
  const bigBlocks = await mountWith(viewMod, { admin_snapshot: manyPath, max_blocks: 1e9 })
  fibers.push(bigBlocks.fiber)
  const manySnap = bigBlocks.box.handle.snapshot()
  const negativeBlocks = await mountWith(viewMod, { admin_snapshot: boundPath, max_blocks: -5 })
  fibers.push(negativeBlocks.fiber)
  const negSnap = negativeBlocks.box.handle.snapshot()
  const nanBlocks = await mountWith(viewMod, { admin_snapshot: manyPath, max_blocks: NaN })
  fibers.push(nanBlocks.fiber)
  const nanSnap = nanBlocks.box.handle.snapshot()
  const fractional = await mountWith(viewMod, { admin_snapshot: boundPath, max_blocks: 5.7 })
  fibers.push(fractional.fiber)
  const fractionalSnap = fractional.box.handle.snapshot()
  const zeroThreshold = await mountWith(guardMod, { token_env: TOKEN_ENV, failure_threshold: 0 })
  fibers.push(zeroThreshold.fiber)
  const zeroThresholdFirst = zeroThreshold.box.handle.elevate('wrong-once')
  check('17 配置契约负控：两模块未知键/错误类型/非对象入参一律被拒（不得静默放行）；默认值逐条断言；'
    + 'max_blocks 越界夹取（1e9→1000 只列 1000、omitted 200；-5→0；NaN→默认 20；5.7→5）；'
    + 'failure_threshold 夹取（0→1：一次失败即冷却）',
  refuses(viewMod, { typo_key: 1 }) === 'refused' && refuses(viewMod, { max_blocks: 'many' }) === 'refused'
  && refuses(viewMod, 42) === 'refused' && refuses(guardMod, { typo_key: 1 }) === 'refused'
  && refuses(guardMod, { views: 'supplier' }) === 'refused' && refuses(guardMod, 42) === 'refused'
  && viewDefaults.max_blocks === 20 && viewDefaults.max_refs === 4 && viewDefaults.max_bytes === 256
  && viewDefaults.admin_snapshot === '' && guardDefaults.failure_threshold === 5
  && guardDefaults.cooldown_ms === 30000 && guardDefaults.token_env === 'QUOTAGENT_ADMIN_TOKEN'
  && guardDefaults.views.join(',') === 'contractor,supplier,ops,admin'
  && manySnap.blocks.length === 1000 && manySnap.omitted_blocks === 200
  && negSnap.blocks.length === 0 && negSnap.omitted_blocks === 10
  && nanSnap.blocks.length === 20 && fractionalSnap.blocks.length === 5
  && zeroThresholdFirst.ok === false && zeroThreshold.box.handle.stats().cooldown_active === true,
  `未知键/错类型/非对象：view=${refuses(viewMod, { typo_key: 1 })}/${refuses(viewMod, { max_blocks: 'many' })}/`
  + `${refuses(viewMod, 42)}，guard=${refuses(guardMod, { typo_key: 1 })}/${refuses(guardMod, { views: 'supplier' })}/`
  + `${refuses(guardMod, 42)}；默认 max_blocks=${viewDefaults.max_blocks} max_refs=${viewDefaults.max_refs} `
  + `max_bytes=${viewDefaults.max_bytes}；1e9 → ${manySnap.blocks.length} 条 omitted=${manySnap.omitted_blocks}；`
  + `-5 → ${negSnap.blocks.length} 条；NaN → ${nanSnap.blocks.length} 条；5.7 → ${fractionalSnap.blocks.length} 条；`
  + `threshold=0 → 一次失败即 cooldown_active=${zeroThreshold.box.handle.stats().cooldown_active}`)

  // ---------- 18. token 四处不出现（宿主侧四搜） ----------
  const surfaces = [JSON.stringify(guard.stats()), JSON.stringify(guard.config()), JSON.stringify(session),
    JSON.stringify(authorized), JSON.stringify(guard.unauthorized()), guard.unauthorized().body,
    cookie, session.session_id, JSON.stringify(oracleTexts), JSON.stringify(DENIALS)]
  const blob = surfaces.join('\n')
  const summaryText = CHECKS.map((item) => item.detail).join('\n')
  check('18 token 四处不出现（宿主侧四搜）：stats/config/elevate/authorized/unauthorized/cookie/五类拒绝体'
    + '全部串起来都搜不到 token，也搜不到它的 sha256 摘要（连前 8 位都没有）；本门自身输出里同样没有',
  !blob.includes(TOKEN) && !blob.includes(tokenShaHex) && !blob.includes(tokenShaHex.slice(0, 16))
  && !blob.includes(tokenShaHex.slice(0, 8)) && !guardSource.includes(TOKEN) && !viewSource.includes(TOKEN)
  && !JSON.stringify(view.snapshot()).includes(TOKEN) && !summaryText.includes(TOKEN)
  && surfaces.join('').length > 200,
  `搜索面 ${surfaces.join('').length} 字节；含 token=${blob.includes(TOKEN)}；`
  + `含 sha256=${blob.includes(tokenShaHex)}；含摘要前 8 位=${blob.includes(tokenShaHex.slice(0, 8))}；`
  + `token 来源标签（允许、非派生）=${guard.stats().token_source}`)
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 240)}`)
}

for (const fiber of fibers) {
  try {
    await fiber.dispose()
  } catch { /* 卸载失败不影响断言结果 */ }
}

finish()
