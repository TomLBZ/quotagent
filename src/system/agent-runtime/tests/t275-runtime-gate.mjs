/**
 * t275-runtime-gate —— T-275「agent 运行期插件（上下文 / 记忆 / harness）」三件产物的**围栏门**
 * （宿主侧人工维护，**不由被围对象自己写**）。
 *
 * 契约：`docs/design/24-agent-runtime-plugins.md`（四层记忆边界表 / 被否决方案 / 未决项）；
 * 规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md` §1/§2；`06 §4` 的记忆四层。
 *
 * 被围对象（三件，都在树内，没有 tmp 候选阶段）：
 *   · `host/modules/agent-context.mjs` —— 上下文装配（`provides: ['agentContext']`）；
 *   · `host/modules/agent-memory.mjs`  —— 四层记忆（`provides: ['agentMemory']`）；
 *   · `host/modules/agent-harness.mjs` —— 有界 harness 骨架 + 宿主内存决策日志（`provides: ['agentHarness']`）。
 * 三件产物的**实际加载路径、字节数与 sha256 写进第 1 条断言的 detail**（变异自证就是靠这一行确认
 * "红的是我改的那一份"，而不是"看着红"）。
 *
 * 断言（23 条：22 条 + 空集合守卫；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：三件产物的 manifest 齐备（name/provides/inject=[]/usedServices=[]/Config/apply/fixture），
 *     且打印实际加载路径/字节数/sha256（三者互不相同）
 *   2 agent-context 挂载：provide 拦截拿得到句柄（键**恰好** 6 个）；dispose 后 `ctx.get` 不存在、effect 归零
 *   3 agent-memory 挂载：句柄键**恰好** 10 个（四层 + 统一入口 + 只读视图）
 *   4 agent-harness 挂载：句柄键**恰好** 7 个（plan/step/log/reset/stats/config/events）
 *   5 反例①（会话落盘请求被拒）：`persist({layer:'session'})`、带 `persist:true` 的会话写入、以及
 *     对**任何**层的 persist 一律拒（有名 code + next_action + `disk_written:false`）；会话正文（哨兵）
 *     在**仓库树里检索不到**（不落盘）；留痕里带着 `memory-session-persist-refused`
 *   6 反例②（policy 由 agent 写入被拒）：`agent:`/空 actor/`system:` 全拒（`memory-policy-human-only`）；
 *     `human:alice` 通过；agent 的 `propose` **只产提案**（patch 里没有该键）
 *   7 反例③（跨方/对手侧数据不得进上下文）：私域条目、对手侧条目、跨 realm 条目三例全拒（有名 code +
 *     next_action）；**被拒内容的正文一个字都不出现在输出里**（哨兵不在 items/inputs/refusals 里）
 *   8 反例④（上限确实生效且截断计数诚实）：上下文 12 条 → 出 8、omitted 4，而 `counts.items` 仍是**真值 12**、
 *     `counts.bytes` 是**夹取前**字节数；超长条目被夹（`clipped`）而 `item.bytes` 仍是原文真值；
 *     harness 20 步 → 计划 8 步、omitted 12、`counts.steps` 仍是真值 20；会话层满即拒（不驱逐）
 *   9 来源登记面：未登记来源的条目拒（`context-unregistered-source`）；重复登记/畸形来源拒；登记后装配成功
 *  10 引用与假设：无 `citations` 的条目拒（`context-missing-citations`）；`[假设]` 条目**存在但不进决策链**
 *  11 降级与"空 ≠ 读不到"：来源一件没登记 → `degraded:true` + 有名 reason + next_action；登记了但没条目 →
 *     `degraded:false` 且 `reason='context-empty'`、`ok:false`；两种情形**同形状**（键集相同）
 *  12 确定性：同输入两次 `assemble()` 字节一致、跨实例一致、**条目顺序颠倒不改输出**、冻结输入不抛、
 *     入参不被改写（不读墙钟、不随机）
 *  13 项目记忆 = 账本投影（**只读**）：直接写拒（`memory-project-readonly`）；`rebuild(rows)` 两次字节一致；
 *     清缓存后重建**逐字节一致**（丢缓存不丢事实）；私域行与别的 realm 的行被排除且**计数报出**
 *  14 跨方只走协议：直接读/写另一侧一律拒（两个码都带 next_action）；协议信封缺字段拒；
 *     带信封的 `applyProtocol` 通过（`via:'qep'`、`ledger_written:false`），信封里的私域条目仍被排除
 *  15 记忆写入必须有 `citations` + 跨 realm 不进本 realm 记忆（INV-008 在宿主侧同样成立）
 *  16 harness 有界：步号不在计划内拒、载荷超字节拒（报 bytes/limit）、超步数拒（`harness-max-steps-reached`）、
 *     未 plan 就 step 拒；同输入两次 `plan()` 的 `objective_digest` 与步表**字节一致**
 *  17 harness 决策日志在**宿主内存**的环缓冲：容量固定、满了丢最旧并**计数**（不静默丢）、
 *     条目一律 `in_memory:true`/`persisted:false`/`ledger_written:false`；跑完仓库树里**没有新文件**
 *  18 harness 日志**不得出现凭据**：凭据形状载荷整步拒（`harness-credential-refused`），日志只留字段名，
 *     日志文本与仓库树里都检索不到凭据哨兵
 *  19 静态负控：三件产物零写文件/零子进程/零网络/零事件订阅/零随机/零墙钟/零定时器/零账本调用
 *     —— 且扫描器**非空转**（合成坏源码必须命中）
 *  20 配置契约负控：未知键/错误类型/非对象入参一律被拒；默认值；越界夹取（1e9→上限、-5→0、NaN→默认）
 *  21 卸载零残留：三件各自 dispose 后服务键消失、effect 归零，且**新动作一律拒**（`*-disposed`）且不报 ok:true
 *  22 四类反例留痕汇总：四条反例各自都留下 `agentrt/<层>-refused` 事件（code + next_action 齐全）
 *  23 空集合守卫（一条都没跑 = 红）
 *
 * 变异模式（单点变异自证，自带防假变异）：`node host/t275-runtime-gate.mjs --mutate <1..4>`
 *   ① 会话落盘不再被拒 ② 策略层不再只人写（去掉 human: 校验）③ 私域/对手侧不再拒 ④ 硬上限不生效且
 *   截断计数不诚实（步数不夹取 + omitted 恒 0）。
 *   每处都：锚点必须**恰好命中 1 次** → 变异后字节必须变 → 就地写回目标产物 → 起子进程跑本门（默认模式）
 *   → 必须 exit 1 且**首条 FAIL** 有名、且子进程第 1 条断言的 detail 里出现**变异后**的 sha256 →
 *   `finally` 还原并核对 sha256 与原始**逐字节一致**；任一步不满足即 exit 1（防假变异）。
 *
 * 用法：`node host/t275-runtime-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）；
 *       `node host/t275-runtime-gate.mjs --mutate <1..4>`（单点变异自证）。
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 */
// `cordis` 是宿主私有的裸名依赖：搬迁后本文件不在 `host/` 下，改为按**显式解析**导入
// （见下方 `CORDIS_URL`；与搬迁前 Node 从 `host/node_modules` 上溯到的是同一份）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { Buffer } from 'node:buffer'
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
const GATE_PATH = join(HERE, 't275-runtime-gate.mjs')
const CONTEXT_PATH = join(HERE, 'modules', 'agent-context.mjs')
const MEMORY_PATH = join(HERE, 'modules', 'agent-memory.mjs')
const HARNESS_PATH = join(HERE, 'modules', 'agent-harness.mjs')

/** 凭据哨兵（绝不写进任何日志/输出；只用于"检索不到"的断言） */
const SECRET = 'ZZ-T275-CREDENTIAL-SENTINEL-ZZ'
/** 私域/对手侧正文哨兵（绝不进上下文） */
const PRIVATE_SENTINEL = 'ZZ-T275-PRIVATE-COST-MODEL-ZZ'
const PEER_SENTINEL = 'ZZ-T275-PEER-QUOTE-ZZ'
/** 会话草稿哨兵（**只在内存**：仓库树里必须检索不到） */
const SESSION_SENTINEL = 'ZZ-T275-SESSION-DRAFT-ZZ'

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail: String(detail) }) }
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const short = (text) => sha256(text).slice(0, 16)
const posix = (path) => String(path).split('\\').join('/')
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const json = (value) => JSON.stringify(value)
const utf8 = (text) => Buffer.byteLength(text, 'utf8')

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红（「没跑到」不得当成「通过」）
  if (CHECKS.length === 0) {
    check('23 空集合守卫：门至少跑了一条断言（反例：门只打印了 JSON 却没跑断言）', false, 'CHECKS 为空')
  }
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, json({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 只读工具：扁平产物加载 / 挂载 / 目录遍历 / 静态扫描
// ---------------------------------------------------------------------------
const loadArtifact = async (path) => {
  const source = readFileSync(path, 'utf8')
  return { mod: await import(pathToFileURL(path).href), source, path, bytes: utf8(source), sha256: sha256(source) }
}

const mountWith = async (mod, raw = {}) => {
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

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__'])
/** 目录遍历（跳过 .git/node_modules/.venv/__pycache__；可额外排除个别文件）。 */
const walkFiles = (root, skip = new Set()) => {
  const out = []
  const visit = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of [...entries].sort()) {
      if (SKIP_DIRS.has(entry)) continue
      const path = join(dir, entry)
      let stat = null
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) visit(path)
      else if (!skip.has(path)) out.push(posix(path))
    }
  }
  visit(root)
  return out.sort()
}
/** 在目录树里检索一段文本（只读；用于"不落盘/不进日志"的断言）。 */
const scanTreeText = (root, needle, skip = new Set()) => walkFiles(root, skip)
  .filter((path) => {
    try {
      return readFileSync(path, 'utf8').includes(needle)
    } catch {
      return false
    }
  })

/** 静态扫描（只扫三件产物；扫的是**产物**，不是本门）。只读被允许，写面/进程/网络/事件/随机/墙钟/定时器/账本一律不许。 */
const NEEDLES = ['writeFileSync', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdirSync', 'rmSync',
  'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'truncateSync', 'chmodSync', 'symlinkSync', 'openSync',
  'child_process', 'execSync', 'execFileSync', 'spawnSync', 'spawn(', 'fork(', 'fetch(', 'node:http', 'node:https',
  'node:net', 'node:dgram', 'worker_threads', 'Date.now', 'new Date', 'setTimeout(', 'setInterval(', 'setImmediate(',
  'Math.random', 'process.env', 'ctx.events', 'events.on(', 'events.emit(', '.emit(', 'ctx.on(', 'ledger.append',
  'appendEvent', 'EventBus', 'require(']
const scanSource = (src, needles = NEEDLES) => needles.filter((needle) => src.includes(needle))
const PLANTED = 'const a = Date.now(); setInterval(() => {}, 1); fs.writeFileSync("x"); spawn("sh"); '
  + 'process.env.TOKEN; Math.random(); fetch("http://x")'

// ---------------------------------------------------------------------------
// 变异模式（单点变异自证）：`--mutate <1..4>`
// ---------------------------------------------------------------------------
const MUTATIONS = [
  { id: 1, target: MEMORY_PATH, label: '会话落盘不再被拒（`persist` 对 session 直接放行）',
    anchor: "    if (layer === 'session') {\n      return refuse('memory-session-persist-refused', 'session-memory-never-persisted',\n        { layer, disk_written: false, ledger_written: false })\n    }",
    replace: "    if (layer === 'session') {\n      return { ok: true, code: '', reason: '', next_action: '', layer,\n        disk_written: false, ledger_written: false }\n    }" },
  { id: 2, target: MEMORY_PATH, label: '策略层不再只人写（去掉 `human:` 前缀校验）',
    anchor: '    if (!actor.startsWith(policyPrefix)) {',
    replace: '    if (false) {' },
  { id: 3, target: CONTEXT_PATH, label: '私域/对手侧数据不再被拒（`inadmissible` 恒放行）',
    anchor: '  const inadmissible = (entry, source) => {',
    replace: '  const inadmissible = (entry, source) => {\n    return null' },
  { id: 4, target: HARNESS_PATH, label: '硬上限不生效且截断计数不诚实（步数不夹取 + omitted 恒 0）',
    anchor: '    const planned = steps.slice(0, maxSteps)\n    const omitted = steps.length - planned.length',
    replace: '    const planned = steps.slice(0, steps.length)\n    const omitted = 0' },
]

const emitMutation = (payload, code) => { writeSync(1, json(payload) + '\n'); process.exit(code) }

const runMutation = (id) => {
  const spec = MUTATIONS.find((item) => item.id === id)
  if (!spec) emitMutation({ ok: false, mutation: id, error: `未知变异编号 ${id}（只支持 1..4）` }, 2)
  const pristine = readFileSync(spec.target, 'utf8')
  const pristineSha = sha256(pristine)
  const anchorHits = pristine.split(spec.anchor).length - 1
  if (anchorHits !== 1) {
    emitMutation({ ok: false, mutation: id, anchor_hits: anchorHits, target: posix(spec.target),
      error: `锚点命中 ${anchorHits} 次（防假变异要求恰好 1 次）：${spec.anchor.slice(0, 90)}` }, 1)
  }
  const mutated = pristine.replace(spec.anchor, spec.replace)
  if (mutated === pristine) {
    emitMutation({ ok: false, mutation: id, anchor_hits: anchorHits,
      error: '变异后字节未变（防假变异：锚点命中了却没改动）' }, 1)
  }
  const mutatedSha = sha256(mutated)
  // 另存一份原始字节（万一还原失败还有救）
  const rescue = join(ROOT, 'tmp', 't275-mutants', `mutation-${id}.orig.mjs`)
  mkdirSync(dirname(rescue), { recursive: true })
  writeFileSync(rescue, pristine, 'utf8')
  let child = null
  try {
    writeFileSync(spec.target, mutated, 'utf8')
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: HERE, encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024 })
  } finally {
    writeFileSync(spec.target, pristine, 'utf8')          // 无论子进程怎么结束都还原
  }
  const restoredSha = sha256(readFileSync(spec.target, 'utf8'))
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
    target: posix(spec.target),
    bytes: { pristine: utf8(pristine), mutated: utf8(mutated) },
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flagValue = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null
}
if (argv.includes('--mutate')) runMutation(Number(flagValue('--mutate')))

const contextArtifact = await loadArtifact(CONTEXT_PATH)
const memoryArtifact = await loadArtifact(MEMORY_PATH)
const harnessArtifact = await loadArtifact(HARNESS_PATH)
const C = contextArtifact.mod
const M = memoryArtifact.mod
const H = harnessArtifact.mod

/** 只读：产物树里的文本检索一律排除本门自己（哨兵常量写在门里） */
const TREE_SKIP = new Set([GATE_PATH, CONTEXT_PATH, MEMORY_PATH, HARNESS_PATH])
const PRODUCT_DIR = join(HERE, 'modules')
const TREE_ROOT = join(ROOT, 'host')
const TREE_BEFORE = walkFiles(TREE_ROOT)

/** 构造 N 条普通条目（payload 形如 `条目-<n>`）。 */
const ownEntries = (count, source = 'ledger-main') => Array.from({ length: count }, (_, index) => ({
  source, key: `k${String(index).padStart(2, '0')}`, payload: `条目-${index}`, citations: ['ledger:1'],
}))

try {
  // ---------- 1. 契约正控 ----------
  const shapeOf = (mod, expected) => ({
    name: mod?.name === expected.name,
    provides: Array.isArray(mod?.provides) && mod.provides.join(',') === expected.provides,
    inject: Array.isArray(mod?.inject) && mod.inject.length === 0,
    usedServices: Array.isArray(mod?.usedServices) && mod.usedServices.length === 0,
    Config: typeof mod?.Config?.parse === 'function' && typeof mod?.Config?.['~standard']?.validate === 'function',
    apply: typeof mod?.apply === 'function',
    fixture: typeof mod?.fixture?.sample === 'function',
  })
  const shapes = [
    shapeOf(C, { name: 'agent-context', provides: 'agentContext' }),
    shapeOf(M, { name: 'agent-memory', provides: 'agentMemory' }),
    shapeOf(H, { name: 'agent-harness', provides: 'agentHarness' }),
  ]
  const badShape = shapes.flatMap((shape, index) => Object.entries(shape)
    .filter(([, ok]) => !ok).map(([key]) => `${['context', 'memory', 'harness'][index]}.${key}`))
  const distinct = new Set([contextArtifact.sha256, memoryArtifact.sha256, harnessArtifact.sha256]).size === 3
  check('1 契约正控：三件产物 manifest 齐备（name/provides/inject=[]/usedServices=[]/Config/apply/fixture）'
    + '且互不相同；打印实际加载路径/字节数/sha256（变异自证靠这一行）',
  badShape.length === 0 && distinct,
  `context=${posix(contextArtifact.path)}（${contextArtifact.bytes} 字节，sha256=${short(contextArtifact.source)}…）；`
  + `memory=${posix(memoryArtifact.path)}（${memoryArtifact.bytes} 字节，sha256=${short(memoryArtifact.source)}…）；`
  + `harness=${posix(harnessArtifact.path)}（${harnessArtifact.bytes} 字节，sha256=${short(harnessArtifact.source)}…）；`
  + `问题键=${badShape.join(',') || '无'}`)

  // ---------- 2/3/4. 挂载与句柄键 ----------
  const ctxMain = await mountWith(C, { realm: 'contractor', max_items: 8, max_bytes: 64 })
  const context = ctxMain.box.handle
  const CTX_KEYS = ['assemble', 'config', 'events', 'registerSource', 'sources', 'stats']
  const ctxKeys = Object.keys(context ?? {}).sort()
  check('2 agent-context 挂载：provide 拦截拿得到句柄（键**恰好** assemble/config/events/registerSource/'
    + 'sources/stats）；effect 已注册（>0）、服务可在 ctx 里取到',
  ctxKeys.join('|') === CTX_KEYS.join('|') && ctxMain.ctx.get('agentContext') === context
  && ctxMain.fiber.getEffects().length > 0,
  `句柄键=${json(ctxKeys)}；ctx.get 一致=${ctxMain.ctx.get('agentContext') === context}；`
  + `effect=${ctxMain.fiber.getEffects().length}；config=${json(context?.config?.())}`)

  const memMain = await mountWith(M, { realm: 'contractor', max_items: 8, max_bytes: 64 })
  const memory = memMain.box.handle
  const MEM_KEYS = ['config', 'cross_party', 'events', 'persist', 'policy', 'project', 'read', 'session', 'stats',
    'write']
  const memKeys = Object.keys(memory ?? {}).sort()
  check('3 agent-memory 挂载：句柄键**恰好** config/cross_party/events/persist/policy/project/read/session/'
    + 'stats/write（四层 + 统一入口 + 只读视图）；每层都声明"谁能写"',
  memKeys.join('|') === MEM_KEYS.join('|') && memMain.ctx.get('agentMemory') === memory
  && memMain.fiber.getEffects().length > 0
  && json(memory.stats().writable_by) === json({ session: 'agent', project: 'ledger-projection',
    policy: 'human-only', cross_party: 'protocol' })
  && memory.project.readonly === true,
  `句柄键=${json(memKeys)}；谁能写=${json(memory.stats().writable_by)}；project.readonly=${memory.project.readonly}`)

  const hsMain = await mountWith(H, { max_steps: 8, max_bytes: 64, ring_size: 4 })
  const harness = hsMain.box.handle
  const HARNESS_KEYS = ['config', 'events', 'log', 'plan', 'reset', 'stats', 'step']
  const harnessKeys = Object.keys(harness ?? {}).sort()
  check('4 agent-harness 挂载：句柄键**恰好** config/events/log/plan/reset/stats/step；'
    + 'limits 是硬上限声明（max_steps/max_bytes/ring_size）',
  harnessKeys.join('|') === HARNESS_KEYS.join('|') && hsMain.ctx.get('agentHarness') === harness
  && hsMain.fiber.getEffects().length > 0
  && json(harness.stats().limits) === json({ max_steps: 8, max_bytes: 64, ring_size: 4 }),
  `句柄键=${json(harnessKeys)}；limits=${json(harness.stats().limits)}`)

  // ---------- 5. 反例①：会话落盘请求被拒 ----------
  const sessionDraft = memory.session.set({ key: 'draft', text: SESSION_SENTINEL, citations: ['ledger:1'] })
  const persistSession = memory.persist({ layer: 'session' })
  const persistProject = memory.persist({ layer: 'project' })
  const persistGarbage = memory.persist({ layer: 'nope' })
  const persistRaw = memory.persist(42)
  const writeFlagged = memory.write({ layer: 'session', key: 'draft2', text: 'again', citations: ['ledger:1'],
    persist: true })
  const memEvents1 = memory.events()
  const memRefusals1 = memEvents1.filter((event) => event.code === 'memory-session-persist-refused')
  const diskHits = scanTreeText(TREE_ROOT, SESSION_SENTINEL, TREE_SKIP)
  check('5 反例①（会话落盘请求被拒）：`persist({layer:session})` 与带 `persist:true` 的会话写入一律拒'
    + '（`memory-session-persist-refused` + next_action + `disk_written:false`）；对别的层与畸形入参也一律拒'
    + '（`memory-disk-write-refused`）；会话正文（哨兵）**在仓库树里检索不到**（不落盘）；留痕带 code + next_action',
  sessionDraft.ok === true && sessionDraft.in_memory === true && sessionDraft.persisted === false
  && persistSession.ok === false && persistSession.code === 'memory-session-persist-refused'
  && String(persistSession.next_action).length > 0 && persistSession.disk_written === false
  && persistSession.ledger_written === false
  && persistProject.ok === false && persistProject.code === 'memory-disk-write-refused'
  && persistGarbage.ok === false && persistGarbage.code === 'memory-disk-write-refused'
  && persistRaw.ok === false && persistRaw.code === 'memory-disk-write-refused'
  && writeFlagged.ok === false && writeFlagged.code === 'memory-session-persist-refused'
  && memRefusals1.length >= 2 && memRefusals1.every((event) => String(event.next_action).length > 0)
  && diskHits.length === 0 && memory.stats().disk_written === 0 && memory.stats().resume.persisted === 0
  && memory.read({ layer: 'session', key: 'draft' }).entry.payload === SESSION_SENTINEL
  && TREE_BEFORE.join('|') === walkFiles(TREE_ROOT).join('|'),
  `会话写入=${json({ ok: sessionDraft.ok, in_memory: sessionDraft.in_memory, persisted: sessionDraft.persisted })}；`
  + `persist(session)=${persistSession.code}；persist(project)=${persistProject.code}；`
  + `persist(畸形)=${persistGarbage.code}/${persistRaw.code}；带 persist 标志的写入=${writeFlagged.code}；`
  + `哨兵在树里命中=${json(diskHits)}；会话内容仍在内存=${memory.read({ layer: 'session', key: 'draft' }).entry.payload === SESSION_SENTINEL}；`
  + `文件清单未变=${TREE_BEFORE.join('|') === walkFiles(TREE_ROOT).join('|')}`)

  // ---------- 6. 反例②：policy 由 agent 写入被拒 ----------
  const policyAgent = memory.policy.write({ actor: 'agent:sourcing', key: 'concession_limit', value: 0.9,
    citations: ['ledger:1'] })
  const policyEmpty = memory.policy.write({ actor: '', key: 'concession_limit', value: 0.9, citations: ['ledger:1'] })
  const policySystem = memory.policy.write({ actor: 'system:kron', key: 'concession_limit', value: 0.9,
    citations: ['ledger:1'] })
  const policyViaWrite = memory.write({ layer: 'policy', actor: 'agent:evolve', key: 'concession_limit',
    value: 0.9, citations: ['ledger:1'] })
  const proposal = memory.policy.propose({ actor: 'agent:evolve', key: 'concession_limit', value: 0.9,
    citations: ['ledger:2'] })
  const policyAfterProposal = memory.policy.read('concession_limit')
  const policyHuman = memory.policy.write({ actor: 'human:alice', key: 'concession_limit', value: 0.9,
    citations: ['ledger:3'] })
  const policyEvents = memory.events().filter((event) => event.code === 'memory-policy-human-only')
  check('6 反例②（policy 由 agent 写入被拒）：`agent:` / 空 actor / `system:` 一律拒'
    + '（`memory-policy-human-only` + next_action）；agent 只能 `propose`（产提案载荷、`written:false`、'
    + 'patch 里没有这个键）；`human:alice` 写入通过（正控：不是"一律不许写"）',
  policyAgent.ok === false && policyAgent.code === 'memory-policy-human-only'
  && String(policyAgent.next_action).length > 0
  && policyEmpty.ok === false && policyEmpty.code === 'memory-policy-human-only'
  && policySystem.ok === false && policySystem.code === 'memory-policy-human-only'
  && policyViaWrite.ok === false && policyViaWrite.code === 'memory-policy-human-only'
  && proposal.ok === true && proposal.kind === 'policy-patch-proposal' && proposal.written === false
  && policyAfterProposal === null
  && policyHuman.ok === true && policyHuman.written_by === 'human:alice'
  && policyEvents.length >= 4,
  `agent 写入=${policyAgent.code}；空 actor=${policyEmpty.code}；system=${policySystem.code}；`
  + `统一入口=${policyViaWrite.code}；提案=${json({ kind: proposal.kind, written: proposal.written, key: proposal.key })}；`
  + `提案后 patch=${json(policyAfterProposal)}；人类写入=${json({ ok: policyHuman.ok, by: policyHuman.written_by })}`)

  // ---------- 7. 反例③：跨方/对手侧数据不得进上下文 ----------
  context.registerSource({ id: 'ledger-main', kind: 'ledger-projection', realm: 'contractor' })
  context.registerSource({ id: 'supplier-cost', kind: 'project-knowledge', realm: 'supplier:sup-A',
    visibility: 'private' })
  context.registerSource({ id: 'peer-quotes', kind: 'ledger-projection', realm: 'supplier:sup-A',
    visibility: 'peer' })
  context.registerSource({ id: 'relay-view', kind: 'ledger-projection', realm: 'relay:r-1', visibility: 'own' })
  const mixed = context.assemble({ turn: 't-mixed', entries: [
    { source: 'ledger-main', key: 'rfq-summary', payload: '包已发布（本 realm 可见面）', citations: ['ledger:1'] },
    { source: 'supplier-cost', key: 'cost-model', payload: PRIVATE_SENTINEL, citations: ['ledger:9'] },
    { source: 'peer-quotes', key: 'peer-quote', payload: PEER_SENTINEL, citations: ['ledger:8'] },
    { source: 'relay-view', key: 'relay-note', payload: PEER_SENTINEL, citations: ['ledger:7'] },
  ] })
  const mixedText = json(mixed)
  const refusedCodes = mixed.refusals.map((item) => item.code)
  check('7 反例③（跨方/对手侧数据不得进上下文）：私域条目（`visibility:private`）、对手侧条目'
    + '（`visibility:peer`）、**别的 realm 的 own 条目**三例全拒（有名 code + next_action）；'
    + '**被拒正文一个字都不出现在输出里**（私域/对手侧哨兵都不在 items/inputs/refusals 里）；'
    + '只有本 realm 条目进了上下文',
  mixed.ok === true && mixed.items.length === 1 && mixed.items[0].source === 'ledger-main'
  && mixed.counts.refused === 3 && mixed.counts.entries === 4
  && refusedCodes.filter((code) => code === 'context-private-refused').length === 1
  && refusedCodes.filter((code) => code === 'context-cross-party-refused').length === 2
  && mixed.refusals.every((item) => String(item.next_action).length > 0)
  && !mixedText.includes(PRIVATE_SENTINEL) && !mixedText.includes(PEER_SENTINEL)
  && !json(mixed.inputs).includes('cost-model') && !json(mixed.inputs).includes('peer-quote')
  && context.events().some((event) => event.code === 'context-private-refused')
  && context.events().some((event) => event.code === 'context-cross-party-refused'),
  `items=${json(mixed.items.map((item) => item.key))}；refusals=${json(refusedCodes)}；`
  + `refused=${mixed.counts.refused}/${mixed.counts.entries}；inputs=${json(mixed.inputs)}；`
  + `私域哨兵出现在输出里=${mixedText.includes(PRIVATE_SENTINEL)}；对手侧哨兵=${mixedText.includes(PEER_SENTINEL)}`)

  // ---------- 8. 反例④：上限确实生效且截断计数诚实 ----------
  const twelve = ownEntries(12)
  const preBytes = twelve.reduce((sum, entry) => sum + utf8(entry.payload), 0)
  const boundedView = context.assemble({ turn: 't-twelve', entries: twelve })
  const longView = context.assemble({ turn: 't-long', entries: [
    { source: 'ledger-main', key: 'long', payload: 'x'.repeat(300), citations: ['ledger:1'] } ] })
  const planned20 = harness.plan({ objective: '把 20 步计划压到上限内', steps: Array.from({ length: 20 },
    (_, index) => ({ action: `step-${index}` })) })
  for (let index = 0; index < 8; index += 1) memory.session.set({ key: `s${index}`, text: `草稿${index}`,
    citations: ['ledger:1'] })
  const sessionNinth = memory.session.set({ key: 's8', text: '第九条', citations: ['ledger:1'] })
  check('8 反例④（上限确实生效且截断计数诚实）：上下文 12 条 → 出 8、`omitted=4`、`truncated:true`，'
    + '而 `counts.items`/`counts.admitted` 仍是**夹取前真值 12**、`counts.bytes` 是夹取前字节数'
    + '（`items.length + omitted === counts.items`）；300 字节条目被夹到 ≤ max_bytes 且 `clipped:1`，'
    + '而 `item.bytes` 仍是原文真值；harness 20 步 → 计划 8 步、`omitted=12`、`counts.steps` 仍是真值 20；'
    + '会话层满即拒（`memory-session-full`，不驱逐、不静默丢）',
  boundedView.items.length === 8 && boundedView.omitted === 4 && boundedView.truncated === true
  && boundedView.counts.items === 12 && boundedView.counts.admitted === 12 && boundedView.counts.bytes === preBytes
  && boundedView.items.length + boundedView.omitted === boundedView.counts.items
  && boundedView.clipped === 0
  && longView.items.length === 1 && longView.clipped === 1 && longView.items[0].bytes === 300
  && utf8(longView.items[0].payload) <= 64 && longView.counts.bytes === 300
  && planned20.ok === true && planned20.steps.length === 8 && planned20.omitted === 12
  && planned20.truncated === true && planned20.counts.steps === 20
  && sessionNinth.ok === false && sessionNinth.code === 'memory-session-full'
  && memory.stats().counts.session === 8,
  `上下文：items=${boundedView.items.length} omitted=${boundedView.omitted} counts.items=${boundedView.counts.items} `
  + `counts.bytes=${boundedView.counts.bytes}（手算 ${preBytes}）truncated=${boundedView.truncated}；`
  + `超长条目：bytes=${json(longView.items[0]?.bytes)} 夹后=${utf8(longView.items[0]?.payload ?? '')} clipped=${longView.clipped}；`
  + `harness：steps=${planned20.steps.length} omitted=${planned20.omitted} counts.steps=${json(planned20.counts.steps)}；`
  + `会话第 9 条=${sessionNinth.code}（size=${memory.stats().counts.session}）`)

  // ---------- 9. 来源登记面 ----------
  const unknownSource = context.assemble({ turn: 't-unknown', entries: [
    { source: 'nowhere', key: 'x', payload: '正文', citations: ['ledger:1'] } ] })
  const duplicate = context.registerSource({ id: 'ledger-main', kind: 'ledger-projection' })
  const badId = context.registerSource({ id: '../host', kind: 'session' })
  const badKind = context.registerSource({ id: 'mystery', kind: 'guess' })
  const badVisibility = context.registerSource({ id: 'mystery2', kind: 'session', visibility: 'whatever' })
  const goodSource = context.registerSource({ id: 'session-log', kind: 'session', realm: 'contractor' })
  const goodAssembled = context.assemble({ turn: 't-good', entries: [
    { source: 'session-log', key: 'goal', payload: '本轮目标：核对比价口径', citations: ['ledger:2'] } ] })
  check('9 来源登记面：未登记来源的条目拒（`context-unregistered-source` + next_action）；重复登记、'
    + '畸形 id、非法 kind、非法 visibility 全拒（`context-source-duplicate`/`context-source-invalid`）；'
    + '登记成功后的装配 `ok:true`、`inputs` 与 `items` 的 ref 一一对应',
  unknownSource.refusals.length === 1 && unknownSource.refusals[0].code === 'context-unregistered-source'
  && String(unknownSource.refusals[0].next_action).length > 0 && unknownSource.items.length === 0
  && duplicate.ok === false && duplicate.code === 'context-source-duplicate'
  && badId.ok === false && badId.code === 'context-source-invalid'
  && badKind.ok === false && badKind.code === 'context-source-invalid'
  && badVisibility.ok === false && badVisibility.code === 'context-source-invalid'
  && goodSource.ok === true && goodAssembled.ok === true && goodAssembled.items.length === 1
  && json(goodAssembled.inputs) === json(goodAssembled.items.map((item) => item.ref))
  && json(context.sources().map((item) => item.id))
    === json(['ledger-main', 'peer-quotes', 'relay-view', 'session-log', 'supplier-cost']),
  `未登记来源=${json(unknownSource.refusals.map((item) => item.code))}；重复登记=${duplicate.code}；`
  + `畸形 id=${badId.code}；非法 kind=${badKind.code}；非法 visibility=${badVisibility.code}；`
  + `登记成功=${goodSource.ok}；装配=${goodAssembled.ok}；inputs=${json(goodAssembled.inputs)}；`
  + `已登记来源=${json(context.sources().map((item) => item.id))}`)

  // ---------- 10. 引用与假设 ----------
  const noCitations = context.assemble({ turn: 't-nocite', entries: [
    { source: 'ledger-main', key: 'guess', payload: '我觉得应该 90 元', citations: [] },
    { source: 'ledger-main', key: 'guess2', payload: '没有引用字段' } ] })
  const assumptionView = context.assemble({ turn: 't-assume', entries: [
    { source: 'ledger-main', key: 'thickness', payload: '[假设] 图纸壁厚 3mm（待人工确认）',
      citations: ['ledger:4'] } ] })
  check('10 引用与假设：无 `citations` 的条目一律拒（`context-missing-citations` + next_action，'
    + '两条都拒）；`[假设]` 条目**存在**（`assumption:true`）但 `in_decision_chain:false`（不进决策链）',
  noCitations.items.length === 0 && noCitations.counts.refused === 2
  && noCitations.refusals.every((item) => item.code === 'context-missing-citations'
    && String(item.next_action).length > 0)
  && assumptionView.items.length === 1 && assumptionView.items[0].assumption === true
  && assumptionView.items[0].in_decision_chain === false,
  `无引用两条=${json(noCitations.refusals.map((item) => item.code))}；`
  + `假设条目=${json(assumptionView.items.map((item) => ({ assumption: item.assumption,
    in_decision_chain: item.in_decision_chain })))}`)

  // ---------- 11. 降级与"空 ≠ 读不到" ----------
  const noSourcesMount = await mountWith(C, { realm: 'contractor' })
  const noSourcesView = noSourcesMount.box.handle.assemble({ turn: 't', entries: [] })
  const emptyView = context.assemble({ turn: 't', entries: [] })
  const invalidView = context.assemble(42)
  await noSourcesMount.fiber.dispose()
  check('11 降级与"空 ≠ 读不到"：来源一件没登记 → `degraded:true` + 有名 reason + next_action；'
    + '登记了来源但这条没给条目 → `degraded:false` 且 `reason=\'context-empty\'`；入参不是对象 → '
    + '`degraded:true` + `context-payload-invalid`；**三种情形都与正常输出同形状**（键集相同）、'
    + '**空上下文一律 `ok:false`**（不得报假绿）',
  noSourcesView.degraded === true && noSourcesView.reason === 'context-no-sources'
  && String(noSourcesView.next_action).length > 0 && noSourcesView.ok === false
  && emptyView.degraded === false && emptyView.reason === 'context-empty' && emptyView.ok === false
  && emptyView.counts.items === 0 && emptyView.truncated === false
  && invalidView.degraded === true && invalidView.reason === 'context-payload-invalid'
  && json(Object.keys(noSourcesView).sort()) === json(Object.keys(emptyView).sort())
  && json(Object.keys(emptyView).sort()) === json(Object.keys(invalidView).sort())
  && json(Object.keys(emptyView).sort()) === json([...C.OUTPUT_KEYS].sort()),
  `无来源=${json({ degraded: noSourcesView.degraded, reason: noSourcesView.reason, ok: noSourcesView.ok })}；`
  + `空装配=${json({ degraded: emptyView.degraded, reason: emptyView.reason, ok: emptyView.ok, items: emptyView.counts.items })}；`
  + `畸形入参=${json({ degraded: invalidView.degraded, reason: invalidView.reason })}；`
  + `同形状=${json(Object.keys(emptyView).sort())}`)

  // ---------- 12. 确定性 ----------
  const payload12 = { turn: 't-det', entries: [
    { source: 'ledger-main', key: 'b', payload: '第二条', citations: ['ledger:2'] },
    { source: 'session-log', key: 'a', payload: '第一条', citations: ['ledger:1'] },
  ] }
  const detOnce = json(context.assemble(payload12))
  const detTwice = json(context.assemble(payload12))
  const reversed = json(context.assemble({ turn: 't-det', entries: [...payload12.entries].reverse() }))
  const before = json(payload12)
  const frozenCopy = JSON.parse(before)
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) deepFreeze(item)
      Object.freeze(value)
    }
    return value
  }
  let frozenOk = true
  try {
    deepFreeze(frozenCopy)
    json(context.assemble(frozenCopy))
  } catch {
    frozenOk = false
  }
  const mirror = await mountWith(C, { realm: 'contractor', max_items: 8, max_bytes: 64 })
  const mirrorHandle = mirror.box.handle
  for (const source of context.sources()) mirrorHandle.registerSource({ ...source })
  const mirrorView = json(mirrorHandle.assemble(payload12))
  await mirror.fiber.dispose()
  check('12 确定性：同输入两次 `assemble()` **字节一致**、跨实例一致、**条目顺序颠倒不改输出**、'
    + '冻结输入不抛、入参不被改写（不读墙钟、不随机、不读环境变量）',
  detOnce === detTwice && detTwice === reversed && frozenOk && json(payload12) === before
  && mirrorView === detOnce && detOnce.length > 10,
  `两次一致=${detOnce === detTwice}（${detOnce.length} 字节）；顺序颠倒一致=${detTwice === reversed}；`
  + `跨实例一致=${mirrorView === detOnce}；冻结输入不抛=${frozenOk}；入参未被改写=${json(payload12) === before}`)

  // ---------- 13. 项目记忆 = 账本投影（只读） ----------
  const projectWrite = memory.write({ layer: 'project', key: 'x', text: '想直接写项目记忆' })
  const rebuild1 = json(memory.project.rebuild(M.SAMPLE_ROWS))
  const rebuild2 = json(memory.project.rebuild(M.SAMPLE_ROWS))
  memory.project.clearCache()
  const afterClear = memory.project.read()
  const rebuild3 = json(memory.project.rebuild(M.SAMPLE_ROWS))
  const projection = memory.project.read()
  const extraRow = memory.project.rebuild([...M.SAMPLE_ROWS, { type: 'x/extra', realm: 'contractor' }])
  memory.project.rebuild(M.SAMPLE_ROWS)
  check('13 项目记忆 = 账本投影（只读）：直接写一律拒（`memory-project-readonly` + next_action）；'
    + '`rebuild(rows)` 两次字节一致；**清缓存后重建逐字节一致**（丢缓存不丢事实）；换个输入摘要必变'
    + '（投影确实覆盖内容，不是常量）；私域行与别的 realm 的行被排除且计数报出（不静默）',
  projectWrite.ok === false && projectWrite.code === 'memory-project-readonly'
  && String(projectWrite.next_action).length > 0
  && rebuild1 === rebuild2 && afterClear === null && rebuild3 === rebuild1
  && extraRow.projection.rows_included === 3 && extraRow.projection.digest !== projection.digest
  && memory.stats().project_digest === projection.digest
  && projection.rows_in === 4 && projection.rows_included === 2
  && json(projection.excluded) === json({ cross_realm: 1, private: 1, invalid: 0 })
  && projection.readonly === true && projection.source === 'ledger-projection'
  && String(projection.digest).length === 64 && rebuild1.length > 10,
  `直接写=${projectWrite.code}；两次一致=${rebuild1 === rebuild2}；清缓存后 read=${json(afterClear)}；`
  + `重建一致=${rebuild3 === rebuild1}；换输入摘要变=${extraRow.projection.digest !== projection.digest}；`
  + `投影=${json({ rows_in: projection.rows_in, rows_included: projection.rows_included,
    excluded: projection.excluded, digest: String(projection.digest).slice(0, 16) + '…' })}`)

  // ---------- 14. 跨方只走协议 ----------
  const crossRead = memory.cross_party.read()
  const crossWrite = memory.cross_party.write({ key: 'peer-pricing' })
  const crossViaWrite = memory.write({ layer: 'cross_party', key: 'peer-pricing' })
  const crossViaRead = memory.read({ layer: 'cross_party', key: 'peer-pricing' })
  const envelopeBad = memory.cross_party.applyProtocol({ entries: [] })
  const envelopeOk = memory.cross_party.applyProtocol({ message_id: 'm-1', base_revision: 3, entries: [
    { key: 'delivery-term', payload: '交付条款：T+30' },
    { key: 'peer-private', payload: PEER_SENTINEL, visibility: 'private' } ] })
  check('14 跨方只走协议：直接读/写另一侧一律拒（`memory-cross-party-direct-read-refused` / '
    + '`memory-cross-party-direct-write-refused`，都带 next_action）；信封缺字段拒'
    + '（`memory-protocol-envelope-invalid`）；带信封的 `applyProtocol` 通过（`via:\'qep\'`、'
    + '`ledger_written:false`），信封里的私域条目仍被排除（`memory-cross-realm-refused`）',
  crossRead.ok === false && crossRead.code === 'memory-cross-party-direct-read-refused'
  && String(crossRead.next_action).length > 0
  && crossWrite.ok === false && crossWrite.code === 'memory-cross-party-direct-write-refused'
  && crossViaWrite.ok === false && crossViaRead.ok === false
  && envelopeBad.ok === false && envelopeBad.code === 'memory-protocol-envelope-invalid'
  && envelopeOk.ok === true && envelopeOk.via === 'qep' && envelopeOk.stored === 1
  && envelopeOk.ledger_written === false && envelopeOk.refused_entries.length === 1
  && envelopeOk.refused_entries[0].code === 'memory-cross-realm-refused'
  && !json(envelopeOk).includes(PEER_SENTINEL),
  `直接读=${crossRead.code}；直接写=${crossWrite.code}；统一入口=${crossViaWrite.code}/${crossViaRead.code}；`
  + `信封缺字段=${envelopeBad.code}；协议通过=${json({ ok: envelopeOk.ok, via: envelopeOk.via,
    stored: envelopeOk.stored, refused: envelopeOk.refused_entries })}；哨兵出现=${json(envelopeOk).includes(PEER_SENTINEL)}`)

  // ---------- 15. citations 必需 + 跨 realm 不进记忆 ----------
  const sessionNoCite = memory.session.set({ key: 'nocite', text: '无引用' })
  const policyNoCite = memory.policy.write({ actor: 'human:alice', key: 'nocite', value: 1 })
  const proposeNoCite = memory.policy.propose({ actor: 'agent:x', key: 'nocite', value: 1 })
  const foreignWrite = memory.session.set({ key: 'foreign', text: '别家的成本模型', citations: ['ledger:1'],
    realm: 'supplier:sup-A' })
  const privateWrite = memory.session.set({ key: 'private', text: '私域草稿', citations: ['ledger:1'],
    visibility: 'private' })
  check('15 记忆写入必须有 `citations`：无引用的会话写入/策略写入/提案一律拒'
    + '（`memory-missing-citations` + next_action）；跨 realm 条目与私域条目不进本 realm 记忆'
    + '（`memory-cross-realm-refused`；INV-008 在宿主侧同样成立）',
  sessionNoCite.ok === false && sessionNoCite.code === 'memory-missing-citations'
  && policyNoCite.ok === false && policyNoCite.code === 'memory-missing-citations'
  && proposeNoCite.ok === false && proposeNoCite.code === 'memory-missing-citations'
  && foreignWrite.ok === false && foreignWrite.code === 'memory-cross-realm-refused'
  && String(foreignWrite.next_action).length > 0
  && privateWrite.ok === false && privateWrite.code === 'memory-cross-realm-refused'
  && memory.stats().keys.session.includes('foreign') === false,
  `无引用会话=${sessionNoCite.code}；无引用策略=${policyNoCite.code}；无引用提案=${proposeNoCite.code}；`
  + `跨 realm=${foreignWrite.code}；私域=${privateWrite.code}；会话键=${json(memory.stats().keys.session)}`)

  // ---------- 16. harness 有界 ----------
  const planAgain = harness.plan({ objective: '把 20 步计划压到上限内', steps: Array.from({ length: 20 },
    (_, index) => ({ action: `step-${index}` })) })
  const noPlanMount = await mountWith(H, { max_steps: 8, max_bytes: 64, ring_size: 4 })
  const noPlanStep = noPlanMount.box.handle.step(0, {})
  const emptyPlan = noPlanMount.box.handle.plan({ objective: '没有步骤', steps: [] })
  const noObjective = noPlanMount.box.handle.plan({ objective: '   ', steps: [{ action: 'a' }] })
  const badStep = noPlanMount.box.handle.plan({ objective: '坏步骤', steps: [{ action: '' }] })
  await noPlanMount.fiber.dispose()
  const plannedSame = json(planAgain.steps) === json(planned20.steps)
  && planAgain.objective_digest === planned20.objective_digest
  const stepNotPlanned = harness.step(99, {})
  const stepNegative = harness.step(-1, {})
  const stepTooLarge = harness.step(0, { blob: 'x'.repeat(200) })
  const eightSteps = []
  for (let index = 0; index < 8; index += 1) eightSteps.push(harness.step(index, { n: index }))
  const stepOver = harness.step(0, { n: 99 })
  check('16 harness 有界：未 plan 就 step 拒、空计划/无目标/坏步骤拒；步号不在计划内拒'
    + '（`harness-step-not-planned`）；载荷超字节拒（`harness-payload-too-large` + 报 bytes/limit）；'
    + '走满 `max_steps` 后再走拒（`harness-max-steps-reached`）；同输入两次 `plan()` 的摘要与步表字节一致',
  noPlanStep.ok === false && noPlanStep.code === 'harness-payload-invalid'
  && emptyPlan.ok === false && emptyPlan.code === 'harness-plan-empty'
  && noObjective.ok === false && noObjective.code === 'harness-objective-missing'
  && badStep.ok === false && badStep.code === 'harness-steps-invalid'
  && stepNotPlanned.ok === false && stepNotPlanned.code === 'harness-step-not-planned'
  && stepNegative.ok === false && stepNegative.code === 'harness-step-not-planned'
  && stepTooLarge.ok === false && stepTooLarge.code === 'harness-payload-too-large'
  && stepTooLarge.bytes === 211 && stepTooLarge.limit === 64
  && eightSteps.every((item) => item.ok === true)
  && stepOver.ok === false && stepOver.code === 'harness-max-steps-reached'
  && plannedSame,
  `未 plan=${noPlanStep.code}；空计划=${emptyPlan.code}；无目标=${noObjective.code}；坏步骤=${badStep.code}；`
  + `越界步号=${stepNotPlanned.code}/${stepNegative.code}；超字节=${stepTooLarge.code}（${stepTooLarge.bytes}>${stepTooLarge.limit}）；`
  + `八步=${json(eightSteps.map((item) => item.ok))}；超上限=${stepOver.code}；两次计划一致=${plannedSame}`)

  // ---------- 17. 决策日志在宿主内存的环缓冲 ----------
  const ringStats = harness.stats()
  const ringLog = harness.log()
  const seqs = ringLog.map((entry) => entry.seq)
  const ringOk = ringStats.ring.capacity === 4 && ringStats.ring.size === 4
  && ringStats.ring.dropped === ringStats.resume.steps - ringStats.ring.capacity
  && ringStats.log_entries === ringStats.ring.capacity
  && seqs.length === 4 && seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])
  && ringLog.every((entry) => entry.in_memory === true && entry.persisted === false
    && entry.ledger_written === false && typeof entry.action === 'string')
  && ringStats.log_persistent === false && ringStats.disk_written === 0 && ringStats.ledger_written === 0
  && json(ringLog).length > 10 && walkFiles(TREE_ROOT).join('|') === TREE_BEFORE.join('|')
  check('17 harness 决策日志在**宿主内存**的环缓冲：容量固定（4）、满了丢最旧并**计数**（`dropped` 看得见，'
    + '不静默丢）、序号单调、条目一律 `in_memory:true`/`persisted:false`/`ledger_written:false`；'
    + '跑完**仓库树里没有新文件**（日志不落盘、不落账本）',
  ringOk,
  `环=${json(ringStats.ring)}；序号=${json(seqs)}；dropped=${ringStats.ring.dropped}（成功步=${ringStats.resume.steps}）；`
  + `log_persistent=${ringStats.log_persistent}；disk_written=${ringStats.disk_written}；`
  + `树里无新文件=${walkFiles(TREE_ROOT).join('|') === TREE_BEFORE.join('|')}；日志=${json(ringLog[0])}`)

  // ---------- 18. 日志里不得出现凭据 ----------
  // 先重下一轮计划（`plan()` 复位步计数）：凭据步要被**凭据判定**拦下，而不是被"步数用完"拦下
  harness.plan({ objective: '凭据不进日志', steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }] })
  const credKey = harness.step(0, { api_key: SECRET })
  const credValue = harness.step(1, { note: 'cred:supplier/x:smtp' })
  const credNested = harness.step(2, { deep: { token: SECRET }, ok: 1 })
  const logText = json(harness.log())
  const treeSecret = scanTreeText(TREE_ROOT, SECRET, TREE_SKIP)
  check('18 harness 日志**不得出现凭据**：凭据形状载荷整步拒（`harness-credential-refused`）'
    + '且 `redacted_fields` 只给**字段名**；日志文本与仓库树里都检索不到凭据哨兵；'
    + '`stats().credential_values_in_log === 0`',
  credKey.ok === false && credKey.code === 'harness-credential-refused'
  && json(credKey.redacted_fields) === json(['api_key'])
  && credValue.ok === false && credValue.code === 'harness-credential-refused'
  && json(credValue.redacted_fields) === json(['note'])
  && credNested.ok === false && credNested.code === 'harness-credential-refused'
  && json(credNested.redacted_fields) === json(['deep.token'])
  && String(credKey.next_action).length > 0
  && !logText.includes(SECRET) && !logText.includes('cred:supplier/x:smtp') && treeSecret.length === 0
  && harness.stats().credential_values_in_log === 0,
  `键名命中=${credKey.code}${json(credKey.redacted_fields)}；值命中=${credValue.code}${json(credValue.redacted_fields)}；`
  + `嵌套命中=${credNested.code}${json(credNested.redacted_fields)}；日志含哨兵=${logText.includes(SECRET)}；`
  + `树里命中凭据哨兵=${json(treeSecret)}；入环条数=${harness.log().length}`)

  // ---------- 19. 静态负控 ----------
  const contextHits = scanSource(contextArtifact.source)
  const memoryHits = scanSource(memoryArtifact.source)
  const harnessHits = scanSource(harnessArtifact.source)
  const plantedHits = scanSource(PLANTED)
  check('19 静态负控：三件产物零写文件/零子进程/零网络/零事件订阅/零随机/零墙钟/零定时器/零账本调用'
    + '（只读 fs 与 `createHash` 允许）；扫描器**非空转**（合成坏源码必须命中 ≥5 处）',
  contextHits.length === 0 && memoryHits.length === 0 && harnessHits.length === 0 && plantedHits.length >= 5,
  `context 命中=${contextHits.join(',') || '无'}；memory 命中=${memoryHits.join(',') || '无'}；`
  + `harness 命中=${harnessHits.join(',') || '无'}；非空转对照命中 ${plantedHits.length} 处=${plantedHits.slice(0, 6).join(',')}`)

  // ---------- 20. 配置契约负控 ----------
  const refuses = (mod, raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const ctxDefaults = C.Config.parse({})
  const memDefaults = M.Config.parse({})
  const harnessDefaults = H.Config.parse({})
  const zeroMount = await mountWith(C, { realm: 'contractor', max_items: -5, max_bytes: 0 })
  zeroMount.box.handle.registerSource({ id: 'ledger-main', kind: 'ledger-projection' })
  const zeroView = zeroMount.box.handle.assemble({ turn: 't', entries: ownEntries(12) })
  const zeroStats = zeroMount.box.handle.stats()
  await zeroMount.fiber.dispose()
  const hugeMount = await mountWith(C, { realm: 'contractor', max_items: 1e9, max_bytes: 1e9 })
  const hugeStats = hugeMount.box.handle.stats()
  hugeMount.box.handle.registerSource({ id: 'ledger-main', kind: 'ledger-projection' })
  const hugeView = hugeMount.box.handle.assemble({ turn: 't', entries: [] })
  await hugeMount.fiber.dispose()
  const nanMount = await mountWith(C, { realm: 'contractor', max_items: Number.NaN })
  const nanStats = nanMount.box.handle.stats()
  await nanMount.fiber.dispose()
  check('20 配置契约负控：三件插件的未知键/错误类型/非对象入参一律被拒（不得静默放行）；'
    + '默认值 realm=contractor / max_items=8 / max_bytes（2048、1024、512）；越界夹取（1e9→上限、-5→0、'
    + 'NaN→默认）——`max_items=-5` 时一条都不出但 `counts.items` 仍是真值 12',
  refuses(C, { realm: 'contractor', typo: 1 }) === 'refused' && refuses(C, { max_items: 'many' }) === 'refused'
  && refuses(C, 42) === 'refused' && refuses(M, { nope: 1 }) === 'refused' && refuses(M, 42) === 'refused'
  && refuses(H, { nope: 1 }) === 'refused' && refuses(H, 42) === 'refused'
  && ctxDefaults.realm === 'contractor' && ctxDefaults.max_items === 8 && ctxDefaults.max_bytes === 2048
  && memDefaults.max_items === 8 && memDefaults.max_bytes === 1024
  && memDefaults.policy_actor_prefix === 'human:'
  && harnessDefaults.max_steps === 8 && harnessDefaults.max_bytes === 512 && harnessDefaults.ring_size === 16
  && zeroStats.limits.max_items === 0 && zeroStats.limits.max_bytes === 0 && zeroView.items.length === 0
  && zeroView.omitted === 12 && zeroView.counts.items === 12 && zeroView.truncated === true
  && hugeStats.limits.max_items === 4096 && hugeStats.limits.max_bytes === 262144
  && hugeView.degraded === false && hugeView.reason === 'context-empty'
  && nanStats.limits.max_items === 8 && nanStats.limits.max_bytes === 2048,
  `未知键=${refuses(C, { realm: 'contractor', typo: 1 })}；错类型=${refuses(C, { max_items: 'many' })}；`
  + `非对象=${refuses(C, 42)}/${refuses(M, 42)}/${refuses(H, 42)}；默认=${json({ ctx: ctxDefaults,
    mem: memDefaults, harness: harnessDefaults })}；-5→items=${zeroView.items.length} omitted=${zeroView.omitted} `
  + `counts.items=${zeroView.counts.items}；1e9→${json(hugeStats.limits)}；NaN→${json(nanStats.limits)}`)

  // ---------- 21. 卸载零残留 + disposed 拒 ----------
  const effectsBeforeDispose = [ctxMain.fiber.getEffects().length, memMain.fiber.getEffects().length,
    hsMain.fiber.getEffects().length]
  await ctxMain.fiber.dispose()
  await memMain.fiber.dispose()
  await hsMain.fiber.dispose()
  const afterDispose = [ctxMain.fiber.getEffects().length, memMain.fiber.getEffects().length,
    hsMain.fiber.getEffects().length]
  const ctxAfterDispose = context.assemble({ turn: 't', entries: ownEntries(2) })
  const memAfterDispose = memory.write({ layer: 'session', key: 'x', text: '写不动了', citations: ['ledger:1'] })
  const memPersistAfterDispose = memory.persist({ layer: 'session' })
  const harnessAfterDispose = harness.plan({ objective: '再起一轮', steps: [{ action: 'a' }] })
  const harnessStepAfterDispose = harness.step(0, {})
  check('21 卸载零残留：三件各自 dispose 后 `ctx.get` 取不到、effect 归零，且**新动作一律拒**'
    + '（`context-disposed` / `memory-disposed` / `harness-disposed`）且**绝不报 ok:true**（拒绝不伪装成功）',
  effectsBeforeDispose.every((count) => count > 0) && afterDispose.every((count) => count === 0)
  && ctxMain.ctx.get('agentContext') === undefined && memMain.ctx.get('agentMemory') === undefined
  && hsMain.ctx.get('agentHarness') === undefined
  && ctxAfterDispose.ok === false && ctxAfterDispose.degraded === true && ctxAfterDispose.reason === 'context-disposed'
  && memAfterDispose.ok === false && memAfterDispose.code === 'memory-disposed'
  && memPersistAfterDispose.ok === false && harnessAfterDispose.ok === false
  && harnessAfterDispose.code === 'harness-disposed' && harnessStepAfterDispose.ok === false
  && harnessStepAfterDispose.code === 'harness-disposed',
  `effect ${json(effectsBeforeDispose)} → ${json(afterDispose)}；ctx.get=${json([ctxMain.ctx.get('agentContext'),
    memMain.ctx.get('agentMemory'), hsMain.ctx.get('agentHarness')])}；dispose 后=${json([ctxAfterDispose.reason,
    memAfterDispose.code, memPersistAfterDispose.code, harnessAfterDispose.code, harnessStepAfterDispose.code])}`)

  // ---------- 22. 四类反例留痕汇总 ----------
  const allEvents = [...ctxMain.box.handle.events(), ...memMain.box.handle.events(),
    ...hsMain.box.handle.events()]
  const required = ['memory-session-persist-refused', 'memory-policy-human-only', 'context-private-refused',
    'context-cross-party-refused', 'harness-max-steps-reached', 'harness-credential-refused']
  const covered = required.filter((code) => allEvents.some((event) => event.code === code))
  const traceable = allEvents.filter((event) => event.code !== undefined)
  check('22 四类反例留痕汇总：①会话落盘被拒（`memory-session-persist-refused`）②策略由 agent 写入被拒'
    + '（`memory-policy-human-only`）③私域/对手侧不进上下文（`context-private-refused` / '
    + '`context-cross-party-refused`）④上限生效（`harness-max-steps-reached`）与凭据不进日志'
    + '（`harness-credential-refused`）**各自都留下了** `agentrt/<层>-refused` 事件，且**每条都带 code 与'
    + ' next_action**（留痕真源是内存事件流；落账本由 Python 侧做，H1）',
  covered.length === required.length && traceable.length >= required.length
  && traceable.every((event) => String(event.code).length > 0 && String(event.next_action).length > 0)
  && [...new Set(allEvents.map((event) => event.kind))].every((kind) => String(kind).startsWith('agentrt/')),
  `留痕 ${allEvents.length} 条；六类覆盖=${json(covered)}；带 code+next_action 的=${traceable.length}/${allEvents.length}；`
  + `事件种类=${json([...new Set(allEvents.map((event) => event.kind))])}`)
} catch (error) {
  check('门执行异常（不得静默通过）', false, `${error.name}: ${String(error.message).slice(0, 240)}`)
}

finish()
