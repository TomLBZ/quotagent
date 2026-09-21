/**
 * t268-user-space-gate —— T-268「用户空间插件：隔离内核 + 管理面插件」两个产物的**围栏门**
 * （宿主侧人工维护，**不由被围对象自己写**；ADR-0016 / D-036 / D-060）。
 * 契约（逐字）：`docs/work/plans/p3-spec.json` 的 FR-USERPLUG-001..012 / AC-USERPLUG-001..012；
 * 设计：`docs/design/22-plugin-market-and-user-space.md`；隔离粒度定案：**进程内独立 Context**。
 *
 * 被围对象（两个，都在树内，没有 tmp 候选阶段）：
 *   · `host/lib/user-space.mjs`            —— 隔离内核（只读扫描 / 命名空间键 / 写面判定 / 凭据作用域 / 装载卸载重载）；
 *   · `host/modules/user-plugin-manager.mjs` —— 管理面插件（`provides: ['userPluginManager']`）。
 * 两个产物的**实际加载路径、字节数与 sha256 写进第 1 条断言的 detail**（变异自证就是靠这一行确认
 * "红的是我改的那一份"，而不是"看着红"）。
 *
 * 断言（21 条 + 1 条空集合守卫；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：两个产物的导出/manifest 齐备（内核 8 个导出 + 管理面 name/provides/inject/Config/apply/fixture），
 *     且打印实际加载路径/字节数/sha256
 *   2 挂载与 dispose：管理面挂载后 provide 拦截拿得到句柄（键**恰好**七个动作）；dispose 后 `ctx.get` 不存在、
 *     effect 归零；**且已装载的用户空间插件照常运行**（effects 仍 >0、服务仍应答）、列表快照仍可读，
 *     而**新装载被拒**（`manager-disposed`）且**不伪装成功**（绝不返回 ok:true）
 *   3 手算正控：夹具 ns 里**1 合法 1 非法 manifest** → scan 逐字段等于手写表（不抛、非法条目不拖倒整次扫描）
 *   4 隔离①独立 instance：两个 ns 的同名插件 uid 不同、各自服务互不可见、可分别卸载（互不影响）
 *   5 隔离②命名空间服务键：注册键**恰好** `<ns>.<plugin>.<svc>`；平台保留名（`approval`）注册被拒（抛错）
 *   6 隔离③文件根绑定：插件内可读；`..`、绝对路径、**符号链接越界**全拒（且拒得有名）
 *   7 隔离④凭据作用域：只解析 `cred:<ns>/<plugin>:*`；借别人的前缀被拒（value 为 null + reason）
 *   8 手算正控：`namespaceKey`/`credentialScope`/拒绝码集合**逐字**
 *   9 反例①：写别人目录或 `host/modules` → 四例全拒（`user-space-outside-ns`）+ 目标文件事后不存在 + 留痕
 *  10 反例②：跨 instance 共享可变状态 → A 写 B **读不到**；读别人的 instance uid 被拒（`state-scope-refused`）+ 留痕
 *  11 反例③：未提权插件被他人加载 → `user-plugin-not-elevated` 且目标**未被载入**（effects 仍为空）+ 留痕；
 *     同形但 `elevated:true` 的插件装载成功（正控）
 *  12 反例④：**无凭据自称已连接** → 宿主核验视图 `available:false` + reason + next_action，
 *     输出里不得出现 `"connected":true`（插件的自述进不了消费者）+ 留痕
 *  13 有界：scan 上限 50（60 条夹具 → 50 + omitted 10 + counts 仍是真值）；管理面 `max_plugins` 二次夹取
 *  14 确定性：两次字节一致、跨实例一致、**写入顺序颠倒不改输出**、冻结输入不抛、入参不被改写
 *  15 静态负控：两个产物零写文件/零子进程/零网络/零事件订阅/零随机/零墙钟/零定时器/零账本调用
 *     —— 且扫描器**非空转**（合成坏源码必须命中）
 *  16 配置契约负控：未知键/错误类型/非对象入参一律被拒；默认值 `''`/50/256；越界夹取（1e9/-5/NaN）
 *  17 降级与"零 ≠ 读不到"：目录不存在 → 空且 `degraded:false`；路径是文件 → `degraded:true` + 有名 reason
 *     + next_action；`root=''`（未配置）→ 降级有名（不得冒充健康）
 *  18 提权负控：缺 `approval_ref` / 畸形引用 → `elevate-needs-approval`；影子哈希 ≠ 清单哈希 → `elevate-tampered`；
 *     三者齐备 → 待办载荷（`target=host/modules/<name>.mjs`）且**本批不真写**（目标文件不存在）
 *  19 `requestCreate` 零写面：载荷形状 `{kind:'plugin-request', ns, description_sha256, bytes}`（手算）+ 无新文件 + 非法 ns 拒
 *  20 `stats()` 只读且**不含凭据**（输出里既没有 `cred:` 也没有作用域内的值）
 *  21 四类反例留痕汇总：四条反例各自都留下 `userplugin/refused`（code + next_action 齐全）
 *  22 空集合守卫（一条都没跑 = 红）
 *
 * 变异模式（单点变异自证，自带防假变异）：`node host/t268-user-space-gate.mjs --mutate <1..4>`
 *   ① 去掉保留服务名拦截 ② 文件根越界不拒 ③ 跨 instance 共享同一个可变对象 ④ 不可读时报空列表冒充健康。
 *   每处都：锚点必须**恰好命中 1 次** → 变异后字节必须变 → 就地写回 `host/lib/user-space.mjs` → 起子进程跑本门
 *   （默认模式）→ 必须 exit 1 且**首条 FAIL** 有名、且子进程第 1 条断言的 detail 里出现**变异后**的 sha256 →
 *   `finally` 还原并核对 sha256 与原始**逐字节一致**；任一步不满足即 exit 1（防假变异）。
 *   变异只可能落在内核产物上（管理面不动），且任何时刻都有"原始字节"在内存里做还原。
 *
 * 用法：`node host/t268-user-space-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）；
 *       `node host/t268-user-space-gate.mjs --demo`（真演示：夹具 ns 里造插件 → load → reload → unload，
 *       打印 uid/effects/pid 供实跑脚本引用；**不碰** `host/modules/` 与 `src/`）；
 *       `node host/t268-user-space-gate.mjs --mutate <1..4>`（单点变异自证）。
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 */
import { Context, EventsService } from 'cordis'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LIB_PATH = join(HERE, 'lib', 'user-space.mjs')
const MANAGER_PATH = join(HERE, 'modules', 'user-plugin-manager.mjs')
const FIX = join(ROOT, 'tmp', 't268-ns-fixture')
const FIX_MAIN = join(FIX, 'main', 'user-space')
const FIX_SCAN = join(FIX, 'scan1', 'user-space')
const FIX_BOUND = join(FIX, 'bounded', 'user-space')
const FIX_ELEV = join(FIX, 'elev', 'user-space')
const FIX_ESCAPE = join(FIX, 'escape', 'user-space')
const FIX_FILE = join(FIX, 'not-a-dir')
const FIX_ABSENT = join(FIX, 'absent')
const FIX_DEMO = join(FIX, 'demo', 'user-space')
const SECRET = 'ZZ-T268-CREDENTIAL-SENTINEL-ZZ'

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail: String(detail) }) }
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const short = (text) => sha256(text).slice(0, 16)
const posix = (path) => String(path).split('\\').join('/')
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红（「没跑到」不得当成「通过」）
  if (CHECKS.length === 0) check('21 空集合守卫：门至少跑了一条断言（反例：门只打印了 JSON 却没跑断言）', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 夹具（全部落在 tmp/ 内，每次跑重建；仓库里其它文件一个字不动）
// ---------------------------------------------------------------------------
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return text
}
/** 造一个登记完整的插件：清单里带**真实**的产物哈希（除非显式覆盖）。 */
const putPlugin = (root, ns, plugin, manifest, artifact) => {
  const dir = join(root, ns, plugin)
  const text = artifact ?? `// ${ns}/${plugin}\nexport const name = '${plugin}'\nexport const inject = []\nexport function apply() {}\n`
  put(join(dir, 'index.mjs'), text)
  const full = { ...manifest }
  if (full.sha256 === 'auto') {                 // 显式要"清单声明真实哈希"（提权链要用）
    full.artifact = full.artifact ?? 'index.mjs'
    full.sha256 = sha256(text)
  }
  put(join(dir, 'plugin.json'), JSON.stringify(full, null, 1) + '\n')
  return { dir, artifact: text, manifest: full }
}
/** 只有清单（没有产物）的最小条目。 */
const putManifest = (root, ns, plugin, text) => put(join(root, ns, plugin, 'plugin.json'), text)

/** 诚实插件：只通过宿主给的作用域服务说话（读文件 / 写状态 / 看凭据）。 */
const HONEST = `export const name = '__NAME__'
export const inject = []
export function apply(ctx, config) {
  const prefix = String(config?.prefix ?? '')
  const state = ctx[prefix + '.state']
  const creds = ctx[prefix + '.credentials']
  const files = ctx[prefix + '.files']
  ctx.provide('status', {
    ping: () => 'pong',
    prefix: () => prefix,
    files_root: () => files.root,
    cred_scope: () => creds.scope,
    read_file: (rel) => files.read(rel),
    connection: () => ({ connected: creds.has('smtp'), credential_key: 'smtp' }),
  })
  ctx.provide('bucket', {
    write: (value) => state.set(value),
    read: () => state.get(),
    readOther: (uid) => state.read(uid),
    assertWrite: (rel) => files.assertWrite(rel),
  })
}
`
/** 撒谎插件：**无凭据也自称已连接**（FR-USERPLUG-007 ④）。 */
const LIAR = `export const name = '__NAME__'
export const inject = []
export function apply(ctx) {
  ctx.provide('status', {
    ping: () => 'pong',
    connection: () => ({ connected: true, credential_key: 'smtp' }),
  })
}
`
/** 想注册平台保留名的插件。 */
const RESERVER = `export const name = '__NAME__'
export const inject = []
export function apply(ctx) {
  ctx.provide('approval', { decision: () => 'auto-approved' })
}
`
const buildFixture = () => {
  rmSync(FIX, { recursive: true, force: true })
  // —— 主夹具：**刻意按名称倒序创建**（other-ns → bravo → acme）→ 输出顺序必须与写入顺序无关
  putPlugin(FIX_MAIN, 'other-ns', 'foreign', { name: 'foreign', version: '1.0.0', ns: 'acme', provides: ['status'] })
  putPlugin(FIX_MAIN, 'other-ns', 'shared', { name: 'shared', version: '1.0.0', ns: 'acme', elevated: true, provides: ['status', 'bucket'], connection_service: 'status', credential_key: 'smtp' },
    HONEST.split('__NAME__').join('shared'))
  putPlugin(FIX_MAIN, 'bravo', 'greeter', { name: 'greeter', version: '1.0.0', ns: 'bravo', provides: ['status', 'bucket'], connection_service: 'status', credential_key: 'smtp' },
    HONEST.split('__NAME__').join('greeter'))
  putPlugin(FIX_MAIN, 'acme', 'greeter', { name: 'greeter', version: '1.0.0', ns: 'acme', provides: ['status', 'bucket'], connection_service: 'status', credential_key: 'smtp' },
    HONEST.split('__NAME__').join('greeter'))
  putPlugin(FIX_MAIN, 'acme', 'liarp', { name: 'liarp', version: '1.0.0', ns: 'acme', provides: ['status'], connection_service: 'status', credential_key: 'smtp' },
    LIAR.split('__NAME__').join('liarp'))
  putPlugin(FIX_MAIN, 'acme', 'reserver', { name: 'reserver', version: '1.0.0', ns: 'acme', provides: ['approval'] },
    RESERVER.split('__NAME__').join('reserver'))
  // 符号链接越界（文件根绑定负控）：链到**别的**插件目录（bravo/greeter 是 check 6 的被围实例）
  const linkPath = join(FIX_MAIN, 'bravo', 'greeter', 'link-out.mjs')
  rmSync(linkPath, { force: true })
  symlinkSync(join(FIX_MAIN, 'acme', 'greeter', 'index.mjs'), linkPath)
  // —— 手算扫描夹具：1 合法 1 非法 manifest
  putPlugin(FIX_SCAN, 'ns1', 'one', { name: 'one', version: '1.0.0', provides: ['alpha'] })
  putManifest(FIX_SCAN, 'ns1', 'two', '{ 这不是 JSON\n')
  // —— 有界夹具：一个 ns 里 60 个插件（scan 上限 50 → 夹 10）
  for (let index = 0; index < 60; index += 1) {
    const name = `p${String(index).padStart(3, '0')}`
    putPlugin(FIX_BOUND, 'big-ns', name, { name, version: '1.0.0', provides: ['x'] })
  }
  // —— 提权夹具：一个哈希对得上、一个"影子哈希 ≠ 清单哈希"
  putPlugin(FIX_ELEV, 'acme', 'ap', { name: 'ap', version: '1.0.0', provides: ['status'], sha256: 'auto' })
  putPlugin(FIX_ELEV, 'acme', 'tamperd', { name: 'tamperd', version: '1.0.0', provides: ['status'], sha256: 'auto' })
  put(join(FIX_ELEV, 'acme', 'tamperd', 'index.mjs'), '// 提权前产物被改动过\n')
  // —— 装载面越界夹具：manifest 的 artifact 指到**仓库真目录** host/modules/
  putPlugin(FIX_ESCAPE, 'acme', 'escapes',
    { name: 'escapes', version: '1.0.0', provides: ['x'], artifact: join(ROOT, 'host', 'modules', 'escapes.mjs'), sha256: 'auto' },
    '// 越界产物\n')
  // —— "root 不是目录" / "root 不存在"
  put(FIX_FILE, '这不是目录\n')
  // —— 真演示夹具：demo-ns/hello
  putPlugin(FIX_DEMO, 'demo-ns', 'hello', { name: 'hello', version: '1.0.0', ns: 'demo-ns', provides: ['audit'], connection_service: 'audit', credential_key: 'smtp' },
    HONEST.split('__NAME__').join('hello'))
  return true
}

// ---------------------------------------------------------------------------
// 加载产物 / 挂载
// ---------------------------------------------------------------------------
const loadArtifact = async (path) => {
  const source = readFileSync(path, 'utf8')
  return { mod: await import(pathToFileURL(path).href), source, path, bytes: Buffer.byteLength(source, 'utf8'),
    sha256: sha256(source) }
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

const mountManager = (mod, raw) => mountWith(mod, raw)

/** 静态扫描（只扫两个产物；扫的是**产物**，不是本门）。只读被允许，写面/进程/网络/事件/随机/墙钟/定时器/账本一律不许。 */
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
// 变异模式（单点变异自证）：`--mutate <1..4>`；只可能落在内核产物上
// ---------------------------------------------------------------------------
const MUTATIONS = [
  { id: 1, label: '去掉保留服务名拦截（`approval` 等平台保留名可被注册/覆盖）',
    anchor: "export const isReserved = (service) => RESERVED_SERVICES.includes(service)\n  || RESERVED_PREFIXES.some((prefix) => String(service).startsWith(prefix))",
    replace: 'export const isReserved = () => false' },
  { id: 2, label: '文件根越界不拒（`..` / 绝对路径 / 符号链接全部放行）',
    anchor: '    return !(lexical && real)',
    replace: '    return false' },
  { id: 3, label: '跨 instance 共享同一个可变对象（状态不再每实例一份）',
    anchor: "const freshState = () => ({ writes: 0, value: null, created: '' })",
    replace: "const SHARED_STATE = { writes: 0, value: null, created: '' }\nconst freshState = () => SHARED_STATE" },
  { id: 4, label: '不可读时报空列表冒充健康（degraded 恒 false + 无 reason/next_action）',
    anchor: '  degraded,\n  reason,\n  next_action: nextActionOf(reason),',
    replace: "  degraded: false,\n  reason: '',\n  next_action: ''," },
]

const emitMutation = (payload, code) => { writeSync(1, JSON.stringify(payload) + '\n'); process.exit(code) }

const runMutation = (id) => {
  const spec = MUTATIONS.find((item) => item.id === id)
  if (!spec) emitMutation({ ok: false, mutation: id, error: `未知变异编号 ${id}（只支持 1..4）` }, 2)
  const target = LIB_PATH
  const pristine = readFileSync(target, 'utf8')
  const pristineSha = sha256(pristine)
  const anchorHits = pristine.split(spec.anchor).length - 1
  if (anchorHits !== 1) {
    emitMutation({ ok: false, mutation: id, anchor_hits: anchorHits,
      error: `锚点命中 ${anchorHits} 次（防假变异要求恰好 1 次）：${spec.anchor.slice(0, 90)}` }, 1)
  }
  const mutated = pristine.replace(spec.anchor, spec.replace)
  if (mutated === pristine) {
    emitMutation({ ok: false, mutation: id, anchor_hits: anchorHits,
      error: '变异后字节未变（防假变异：锚点命中了却没改动）' }, 1)
  }
  const mutatedSha = sha256(mutated)
  // 另存一份原始字节（**不要**放在夹具目录里：子进程跑默认模式时会重建夹具），万一还原失败还有救
  const rescue = join(ROOT, 'tmp', 't268-mutants', `mutation-${id}.orig.mjs`)
  mkdirSync(dirname(rescue), { recursive: true })
  writeFileSync(rescue, pristine, 'utf8')
  let child = null
  try {
    writeFileSync(target, mutated, 'utf8')
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: HERE, encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024 })
  } finally {
    writeFileSync(target, pristine, 'utf8')          // 无论子进程怎么结束都还原
  }
  const restoredSha = sha256(readFileSync(target, 'utf8'))
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
    target: posix(target),
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

// ---------------------------------------------------------------------------
// 真演示模式：夹具 ns 里造插件 → load → reload（uid 变、pid 不变）→ unload（effects 归 0）
// ---------------------------------------------------------------------------
const runDemo = async () => {
  const kernel = await loadArtifact(LIB_PATH)
  const root = FIX_DEMO
  const platform = new Context()
  const events = []
  const loaded = await kernel.mod.loadPlugin(platform, { root, ns: 'demo-ns', plugin: 'hello',
    onEvent: (event) => events.push(event) })
  if (!loaded.handle) {
    writeSync(1, JSON.stringify({ mode: 'demo', ok: false, refusal: loaded.refusal }) + '\n')
    process.exit(2)
  }
  const first = loaded.handle
  const pidBefore = process.pid
  const effectsBefore = first.effects()
  const statusKey = first.serviceKeys.includes('demo-ns.hello.status')
  first.services.state.set('旧内存状态的草稿')
  const reloaded = await kernel.mod.reload(first)
  const second = reloaded.handle
  const pidAfter = process.pid
  const afterReloadEffects = second ? second.effects() : 0
  const draftAfterReload = second ? second.services.state.get() : 'N/A'
  const unloaded = second ? await second.unload() : null
  const effectsAfter = second ? second.effects() : null
  const payload = {
    mode: 'demo',
    ok: Boolean(second) && statusKey && first.uid !== second.uid && pidBefore === pidAfter
      && effectsBefore > 0 && afterReloadEffects > 0 && draftAfterReload === null && effectsAfter === 0,
    root: posix(root),
    plugin_dir: first.dir,
    manifest_sha256_declared: first.manifest.sha256,
    artifact_sha256: first.artifact_sha256,
    service_keys: first.serviceKeys,
    status_key_is_namespaced: statusKey,
    effects_before_unload: effectsBefore,
    uid_before: first.uid,
    uid_after: second ? second.uid : null,
    uid_changed: Boolean(second) && second.uid !== first.uid,
    previous_uid: reloaded.previous_uid,
    pid_before: pidBefore,
    pid_after: pidAfter,
    pid_unchanged: pidBefore === pidAfter,
    effects_after_reload: afterReloadEffects,
    state_draft_after_reload: draftAfterReload,
    no_state_migration: draftAfterReload === null,
    effects_after_unload: effectsAfter,
    effects_zero_after_unload: effectsAfter === 0,
    connection: second ? second.connection() : null,
    platform_ctx_sees_services: platform.get('demo-ns.hello.status') !== undefined,
    events: events.map((event) => event.kind),
    refused_events: events.filter((event) => event.kind === 'userplugin/refused').length,
    unload_result: unloaded,
  }
  writeSync(1, JSON.stringify(payload) + '\n')
  process.exit(payload.ok ? 0 : 1)
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

buildFixture()
if (argv.includes('--demo')) await runDemo()

const kernelArtifact = await loadArtifact(LIB_PATH)
const managerArtifact = await loadArtifact(MANAGER_PATH)

try {
  // ---------- 1. 契约正控 ----------
  const U = kernelArtifact.mod
  const M = managerArtifact.mod
  const KERNEL_EXPORTS = ['RESERVED_SERVICES', 'scan', 'namespaceKey', 'assertWriteSurface', 'credentialScope',
    'resolveCredential', 'loadPlugin', 'reload']
  const missingExports = KERNEL_EXPORTS.filter((name) => U[name] === undefined)
  const reservedMissing = ['approval', 'ledger', 'ledgerView', 'kernel', 'kernelBridge', 'webui', 'projection',
    'governor', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager']
    .filter((name) => !U.RESERVED_SERVICES.includes(name))
  const managerShape = {
    name: M?.name === 'user-plugin-manager',
    provides: Array.isArray(M?.provides) && M.provides.join(',') === 'userPluginManager',
    inject: Array.isArray(M?.inject) && M.inject.length === 0,
    usedServices: Array.isArray(M?.usedServices) && M.usedServices.length === 0,
    Config: typeof M?.Config?.parse === 'function' && typeof M?.Config?.['~standard']?.validate === 'function',
    apply: typeof M?.apply === 'function',
    fixture: typeof M?.fixture?.sample === 'function',
  }
  const managerBad = Object.entries(managerShape).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：内核 8 个导出齐备 + RESERVED_SERVICES 含全部 12 个平台保留名 + 管理面 manifest 齐备'
    + '（name/provides=[userPluginManager]/inject=[]/usedServices/Config/apply/fixture）；打印实际加载路径/字节数/sha256',
  missingExports.length === 0 && reservedMissing.length === 0 && managerBad.length === 0
  && kernelArtifact.sha256 !== managerArtifact.sha256,
  `lib=${posix(kernelArtifact.path)}（${kernelArtifact.bytes} 字节，sha256=${short(kernelArtifact.source)}…）；`
  + `manager=${posix(managerArtifact.path)}（${managerArtifact.bytes} 字节，sha256=${short(managerArtifact.source)}…）；`
  + `缺导出=${missingExports.join(',') || '无'}；缺保留名=${reservedMissing.join(',') || '无'}；`
  + `管理面问题键=${managerBad.join(',') || '无'}`)

  // ---------- 2. 挂载与 dispose（管理面卸载后已载插件仍跑 / 新装载被拒且不伪装成功） ----------
  const mounted = await mountManager(M, { root: FIX_MAIN, max_plugins: 50, max_bytes: 256 })
  const manager = mounted.box.handle
  const ACTION_KEYS = ['config', 'elevateRequest', 'events', 'list', 'load', 'reload', 'requestCreate', 'stats', 'unload']
  const handleKeys = Object.keys(manager ?? {}).sort().join('|')
  const firstLoad = await manager.load('acme', 'greeter')
  const serviceVisible = mounted.ctx.get('userPluginManager') === manager
  const effectsAtMount = firstLoad.effects ?? 0
  const managerEffects = mounted.fiber.getEffects().length
  await mounted.fiber.dispose()
  const afterDisposeEffects = mounted.fiber.getEffects().length
  const nextLoad = await manager.load('bravo', 'greeter')
  const listAfterDispose = manager.list()
  const statsAfterDispose = manager.stats()
  const survivor = statsAfterDispose.instances[0] ?? {}
  check('2 挂载与 dispose：管理面挂载后 provide 拦截拿得到句柄（键恰好 config/elevateRequest/events/list/load/'
    + 'reload/requestCreate/stats/unload）；dispose 后 `ctx.get("userPluginManager")` 不存在、effect 归零；'
    + '**且已装载的用户空间插件照常运行**（其实例 effect 仍 >0、列表快照仍可读、仍算 loaded）、**新装载被拒**'
    + '（manager-disposed）且**不伪装成功**（绝不 ok:true）',
  handleKeys === ACTION_KEYS.join('|') && firstLoad.ok === true && serviceVisible && effectsAtMount > 0
  && managerEffects > 0 && afterDisposeEffects === 0 && mounted.ctx.get('userPluginManager') === undefined
  && nextLoad.ok === false && nextLoad.code === 'manager-disposed'
  && listAfterDispose.counts.loaded === 1 && statsAfterDispose.resume.manager_disposed === true
  && statsAfterDispose.loaded === 1 && survivor.uid === firstLoad.uid && survivor.effects > 0
  && JSON.stringify(survivor.service_keys) === JSON.stringify(['acme.greeter.bucket', 'acme.greeter.status']),
  `句柄键=${handleKeys}；首次 load=${JSON.stringify(firstLoad)}；管理面 effect ${managerEffects} → ${afterDisposeEffects}；`
  + `卸载后 load=${JSON.stringify(nextLoad)}；列表 loaded=${listAfterDispose.counts.loaded}（快照仍可读）；`
  + `存活实例=${JSON.stringify(survivor)}`)

  // ---------- 3. 手算正控：1 合法 1 非法 manifest ----------
  const scan1 = U.scan(FIX_SCAN)
  const oneArtifact = readFileSync(join(FIX_SCAN, 'ns1', 'one', 'index.mjs'), 'utf8')
  const oneDir = posix(join(FIX_SCAN, 'ns1', 'one'))
  const twoDir = posix(join(FIX_SCAN, 'ns1', 'two'))
  const one = scan1.namespaces[0]?.plugins?.[0] ?? {}
  const two = scan1.namespaces[0]?.plugins?.[1] ?? {}
  check('3 手算正控：夹具 ns1 里 **1 合法 1 非法 manifest** → 扫描结果逐字段等于手写表'
    + '（合法条 name/version/dir/sha256/manifest.provides 与 invalid:false；非法条 invalid:true + reason=manifest-not-json'
    + ' + sha256 为空）；`counts` 与手算一致；**不抛**且非法条目不拖倒整次扫描',
  scan1.degraded === false && scan1.namespaces.length === 1 && scan1.namespaces[0].ns === 'ns1'
  && scan1.namespaces[0].plugins.length === 2
  && one.name === 'one' && one.version === '1.0.0' && one.dir === oneDir && one.invalid === false && one.reason === ''
  && one.sha256 === sha256(oneArtifact) && JSON.stringify(one.manifest) === JSON.stringify({ name: 'one', version: '1.0.0', provides: ['alpha'] })
  && two.name === 'two' && two.dir === twoDir && two.invalid === true && two.reason === 'manifest-not-json'
  && two.sha256 === '' && two.manifest === null && typeof two.next_action === 'string' && two.next_action !== ''
  && JSON.stringify(scan1.counts) === JSON.stringify({ namespaces: 1, plugins: 2, invalid: 1 })
  && scan1.truncated === false && scan1.omitted === 0,
  `namespaces=${JSON.stringify(scan1.namespaces.map((item) => item.ns))}；one=${JSON.stringify({ name: one.name, version: one.version, dir: one.dir, sha256: String(one.sha256).slice(0, 12), invalid: one.invalid })}；`
  + `two=${JSON.stringify({ name: two.name, invalid: two.invalid, reason: two.reason, sha256: two.sha256 })}；`
  + `counts=${JSON.stringify(scan1.counts)}；degraded=${scan1.degraded}`)

  // ---------- 4. 隔离①：独立 Context / 独立 instance ----------
  const platform = new Context()
  const events = []
  const sink = (event) => events.push(event)
  const a = await U.loadPlugin(platform, { root: FIX_MAIN, ns: 'acme', plugin: 'greeter', onEvent: sink })
  const b = await U.loadPlugin(platform, { root: FIX_MAIN, ns: 'bravo', plugin: 'greeter', onEvent: sink })
  const handleA = a.handle
  const handleB = b.handle
  const keyA = 'acme.greeter.status'
  const keyB = 'bravo.greeter.status'
  const uniqueCtx = handleA && handleB && handleA.context !== handleB.context && handleA.context !== platform
    && handleB.context !== platform
  const noCross = handleA.context.get(keyB) === undefined && handleB.context.get(keyA) === undefined
  const noPlatformLeak = platform.get(keyA) === undefined && platform.get(keyB) === undefined
  const uidDiffers = handleA.uid !== handleB.uid
  const effectsA = handleA.effects()
  const effectsB = handleB.effects()
  const unloadA = await handleA.unload()
  const effectsAAfter = handleA.effects()
  const effectsBAfter = handleB.effects()
  const bStillAnswers = handleB.context.get(keyB).ping() === 'pong'
  check('4 隔离①独立 instance：两个 ns 的同名插件 uid 不同、各自一个独立 Context（≠ 平台 ctx）、'
    + '服务**互不可见**（A 取 B 的键 / B 取 A 的键 / 平台 ctx 取两者都取不到）、**可分别卸载**'
    + '（卸 A 后 A 的 effect 归零而 B 照常应答）',
  Boolean(handleA) && Boolean(handleB) && uniqueCtx && noCross && noPlatformLeak && uidDiffers
  && effectsA > 0 && effectsB > 0 && unloadA.ok === true && effectsAAfter === 0 && effectsBAfter === effectsB
  && bStillAnswers,
  `uid=${handleA?.uid} / ${handleB?.uid}（不同=${uidDiffers}）；独立 Context=${uniqueCtx}；互不可见=${noCross}；`
  + `平台 ctx 看不到=${noPlatformLeak}；effect A ${effectsA}→${effectsAAfter} B ${effectsB}→${effectsBAfter}；`
  + `B 仍应答=${bStillAnswers}`)

  // ---------- 5. 隔离②：命名空间服务键 ----------
  const keysNamespaced = handleB.serviceKeys.every((key) => key.startsWith('bravo.greeter.'))
  let reservedNames = []
  try {
    U.namespaceKey('bravo', 'greeter', 'approval')
  } catch (error) {
    reservedNames.push(error.code)
  }
  try {
    U.namespaceKey('bravo', 'greeter', 'ledgerView')
  } catch (error) {
    reservedNames.push(error.code)
  }
  try {
    U.namespaceKey('bravo', 'greeter', 'kernel')
  } catch (error) {
    reservedNames.push(error.code)
  }
  const reservedPlugin = await U.loadPlugin(platform, { root: FIX_MAIN, ns: 'acme', plugin: 'reserver', onEvent: sink })
  const reservedRefusal = reservedPlugin.refusal ?? (reservedPlugin.handle ? { code: 'LOADED' } : null)
  check('5 隔离②命名空间服务键：注册键**恰好** `<ns>.<plugin>.<svc>`（不带平台前缀、也不裸名）；'
    + '平台保留名（approval / ledgerView / kernel）被 `namespaceKey` 抛错拒绝，'
    + '且**插件自己 provide 保留名**整次装载被拒（结构性拒绝，不是文档纪律）',
  keysNamespaced && JSON.stringify(handleB.serviceKeys) === JSON.stringify(['bravo.greeter.bucket', 'bravo.greeter.status'])
  && reservedNames.length === 3 && reservedNames.every((code) => code === 'service-name-reserved')
  && reservedPlugin.handle === null && reservedRefusal?.code === 'service-name-reserved',
  `B 的服务键=${JSON.stringify(handleB.serviceKeys)}；namespaceKey 保留名=${JSON.stringify(reservedNames)}；`
  + `provide('approval') 的插件装载=${JSON.stringify(reservedRefusal)}`)

  // ---------- 6. 隔离③：文件根绑定 ----------
  const files = handleB.services.files
  const insideOk = files.read('plugin.json').ok === true
  const escapes = [files.read('../../acme/greeter/plugin.json'), files.read('/etc/passwd'),
    files.read('link-out.mjs'), files.assertWrite('../../acme/greeter/evil.mjs')]
  const allRefused = escapes.every((item) => item.ok === false && item.code === 'user-space-outside-ns')
  check('6 隔离③文件根绑定：绑定在 `<root>/<ns>/<plugin>/` 上 —— 本插件目录内可读；`..` 越界、绝对路径、'
    + '**符号链接越界**、界外写面判定一律拒（`user-space-outside-ns` + 有名 reason + next_action）；'
    + '界内的写面判定只产待办载荷（**不落盘**）',
  insideOk && allRefused && files.assertWrite('files/new.txt').ok === true
  && files.assertWrite('files/new.txt').kind === 'user-space-write'
  && files.assertWrite('files/new.txt').path.startsWith(posix(resolve(FIX_MAIN, 'bravo', 'greeter')))
  && !existsSync(join(FIX_MAIN, 'bravo', 'greeter', 'files', 'new.txt')),
  `界内读=${insideOk}；越界四例=${JSON.stringify(escapes.map((item) => item.code))}；`
  + `界内写面判定=${JSON.stringify(files.assertWrite('files/new.txt').kind)}（落盘=${existsSync(join(FIX_MAIN, 'bravo', 'greeter', 'files', 'new.txt'))}）`)

  // ---------- 7. 隔离④：凭据作用域 ----------
  const env = { 'cred:acme/greeter:smtp': SECRET, 'cred:bravo/greeter:smtp': 'B-SECRET', 'SMTP_TOKEN': 'UNSCOPED' }
  const own = U.resolveCredential(env, 'acme', 'greeter', 'smtp')
  const borrowOtherScope = U.resolveCredential(env, 'acme', 'greeter', 'cred:bravo/greeter:smtp')
  const otherNsKey = U.resolveCredential(env, 'acme', 'greeter', 'bravo')
  const unscoped = U.resolveCredential(env, 'acme', 'greeter', 'SMTP_TOKEN')
  const scoped = await U.loadPlugin(platform, { root: FIX_MAIN, ns: 'acme', plugin: 'greeter', env,
    onEvent: sink })
  const scopedVerdict = scoped.handle ? scoped.handle.connection() : null
  const scopedAnswer = scoped.handle ? scoped.handle.services.credentials.resolve('smtp') : null
  check('7 隔离④凭据作用域：本作用域键解析成功（`cred:<ns>/<plugin>:*`）；借别人的 `cred:` 前缀被拒'
    + '（`credential-scope-refused`，value 为 null + reason）；作用域内的**别的键名**与**未加作用域的裸键**'
    + '一律解析不到（不得"就近取用"）；作用域内凭据齐备时插件的连接自述被宿主认可',
  own.ok === true && own.value === SECRET && own.scope === 'cred:acme/greeter'
  && borrowOtherScope.ok === false && borrowOtherScope.value === null && borrowOtherScope.code === 'credential-scope-refused'
  && otherNsKey.ok === false && otherNsKey.code === 'credential-missing' && otherNsKey.value === null
  && unscoped.ok === false && unscoped.code === 'credential-missing'
  && scopedRefusalOk(scopedVerdict) && scopedAnswer?.ok === true,
  `本作用域=${JSON.stringify({ ok: own.ok, name: own.name, scope: own.scope, value: own.value === SECRET ? '(哨兵)' : own.value })}；`
  + `借别人前缀=${JSON.stringify({ code: borrowOtherScope.code, value: borrowOtherScope.value })}；`
  + `作用域内别的键=${otherNsKey.code}；裸键=${unscoped.code}；装载后连接=${JSON.stringify(scopedVerdict)}`)

  // ---------- 8. 手算正控：字符串与码表逐字 ----------
  check('8 手算正控：`namespaceKey(' + "'acme','greeter','status'" + ')` = `acme.greeter.status`、'
    + '`credentialScope(...)` = `cred:acme/greeter:`（逐字）；ns/plugin/service 形状不对一律抛（含 `..`、带点、空）',
  U.namespaceKey('acme', 'greeter', 'status') === 'acme.greeter.status'
  && U.credentialScope('acme', 'greeter') === 'cred:acme/greeter:'
  && throwsCode(() => U.namespaceKey('..', 'greeter', 'status'), 'service-key-invalid')
  && throwsCode(() => U.namespaceKey('acme', 'greeter.st', 'status'), 'service-key-invalid')
  && throwsCode(() => U.namespaceKey('acme', 'greeter', 'a.b'), 'service-key-invalid')
  && throwsCode(() => U.namespaceKey('acme', 'greeter', ''), 'service-key-invalid'),
  `namespaceKey=${U.namespaceKey('acme', 'greeter', 'status')}；credentialScope=${U.credentialScope('acme', 'greeter')}；`
  + `非法 ns/带点/空 服务名均抛=${['..', 'acme.greeter.st', 'a.b'].length} 例`)

  // ---------- 9. 反例①：写别人目录或 host/modules ----------
  const ownRoot = join(FIX_MAIN, 'acme', 'greeter')
  const others = [
    ['host/modules/x.mjs', join(ROOT, 'host', 'modules', 'x.mjs')],
    ['src/quotagent/x.py', join(ROOT, 'src', 'quotagent', 'x.py')],
    [join('..', '..', 'bravo', 'greeter', 'x.txt'), join(FIX_MAIN, 'bravo', 'greeter', 'x.txt')],
    [join('..', '..', '..', '..', '..', 'outside-repo.txt'), resolve(join(ROOT, '..', 'outside-repo.txt'))],
  ]
  const writeVerdicts = others.map(([, absolute]) => U.assertWriteSurface(absolute, ownRoot))
  const allOutside = writeVerdicts.every((item) => item.ok === false && item.code === 'user-space-outside-ns')
  const noneExist = others.every(([, absolute]) => !existsSync(absolute))
  const evolution = U.assertWriteSurface(join(ROOT, 'user-space', 'acme', 'greeter', 'x.mjs'),
    join(ROOT, 'host', 'modules'))
  const fileEscapeRefusal = files.assertWrite(join('..', '..', 'acme', 'greeter', 'x.txt'))
  const escapeLoad = await (async () => {
    const scoped2 = await mountManager(M, { root: FIX_ESCAPE, max_plugins: 50, max_bytes: 256 })
    const outcome = await scoped2.box.handle.load('acme', 'escapes')
    await scoped2.fiber.dispose()
    return outcome
  })()
  const refusedCodes = events.filter((event) => event.kind === 'userplugin/refused').map((event) => event.code)
  check('9 反例①（写别人目录或 host/modules 一律拒且留痕）：对用户空间的写者，四例越界'
    + '（`host/modules/`、`src/`、别人的 ns、仓库外）**全部** `user-space-outside-ns`；自进化方向'
    + '（自有面 = `host/modules/`，target 指到 `user-space/`）→ `artifact-outside-write-surface`；'
    + '**四个目标位置事后都不存在该文件**；插件装载面越界（manifest 的 artifact 指到 host/modules）→ 拒且未装载；'
    + '每次拒绝都留 `userplugin/refused`（带 code + next_action）',
  allOutside && noneExist && evolution.ok === false && evolution.code === 'artifact-outside-write-surface'
  && fileEscapeRefusal.code === 'user-space-outside-ns'
  && escapeLoad.ok === false && escapeLoad.code === 'user-space-outside-ns'
  && refusedCodes.includes('user-space-outside-ns')
  && events.filter((event) => event.kind === 'userplugin/refused' && event.code === 'user-space-outside-ns')
    .every((event) => typeof event.next_action === 'string' && event.next_action !== ''),
  `四例=${JSON.stringify(writeVerdicts.map((item) => item.code))}；目标文件都不存在=${noneExist}；`
  + `自进化方向=${evolution.code}；装载面越界=${escapeLoad.code}；留痕码=${JSON.stringify([...new Set(refusedCodes)])}`)

  // ---------- 10. 反例②：跨 instance 共享可变状态 ----------
  const stateA = handleB.services.state
  const bucketB = handleB.context.get('bravo.greeter.bucket')
  bucketB.write('A 实例写的值')
  const c = await U.loadPlugin(platform, { root: FIX_MAIN, ns: 'acme', plugin: 'greeter', onEvent: sink })
  const handleC = c.handle
  const bucketC = handleC.context.get('acme.greeter.bucket')
  const readByOther = bucketC.read()
  const readForeignUid = bucketC.readOther(stateA.uid)
  const stateSharedFirst = stateA.get()
  check('10 反例②（跨 instance 共享可变状态必须读不到）：B 实例写入的状态，**另一个实例 C 读不到**'
    + '（读到的仍是自己的空草稿）；C 拿 B 的 instance uid 去读别人的状态被拒（`state-scope-refused`）+ 留痕；'
    + 'B 自己仍读得到（不是"全都不许用"）',
  stateSharedFirst === 'A 实例写的值' && readByOther === null && readForeignUid.ok === false
  && readForeignUid.code === 'state-scope-refused' && readForeignUid.next_action !== ''
  && events.some((event) => event.kind === 'userplugin/refused' && event.code === 'state-scope-refused'),
  `B 自己读到=${JSON.stringify(stateSharedFirst)}；C 读到=${JSON.stringify(readByOther)}（必须 null）；`
  + `C 读 B 的 uid=${JSON.stringify({ code: readForeignUid.code, uid_owner: stateA.uid, uid_reader: handleC.services.state.uid })}`)

  // ---------- 11. 反例③：未提权插件被他人加载 ----------
  const crossMounted = await mountManager(M, { root: FIX_MAIN, max_plugins: 50, max_bytes: 256 })
  const cross = await crossMounted.box.handle.load('other-ns', 'foreign')
  const crossStats = crossMounted.box.handle.stats()
  const crossList = crossMounted.box.handle.list()
  const crossEvents = crossMounted.box.handle.events()
  const elevated = await crossMounted.box.handle.load('other-ns', 'shared')
  const elevatedStats = crossMounted.box.handle.stats()
  await crossMounted.fiber.dispose()
  const crossCodes = crossEvents.filter((event) => event.kind === 'userplugin/refused').map((event) => event.code)
  check('11 反例③（未提权插件不得被他人加载）：把清单属主为 `acme` 的插件从 `other-ns` 装载 → '
    + '`user-plugin-not-elevated` 且**目标未被载入**（loaded 计数 0、effects 仍为空）、留痕带 code + next_action；'
    + '同形但清单声明 `elevated:true` 的插件装载成功（正控：不是"一律不许跨 ns"）',
  cross.ok === false && cross.code === 'user-plugin-not-elevated'
  && crossStats.loaded === 0 && crossList.counts.loaded === 0
  && crossCodes.includes('user-plugin-not-elevated')
  && crossEvents.some((event) => event.code === 'user-plugin-not-elevated' && String(event.next_action).length > 0)
  && elevated.ok === true && (elevated.effects ?? 0) > 0 && elevatedStats.loaded === 1,
  `跨 ns 未提权=${JSON.stringify(cross)}；装载计数=${crossStats.loaded}；提权后=${JSON.stringify(elevated)}；`
  + `管理面留痕码=${JSON.stringify(crossCodes)}`)

  // ---------- 12. 反例④：无凭据自称已连接 ----------
  const liar = await U.loadPlugin(platform, { root: FIX_MAIN, ns: 'acme', plugin: 'liarp', onEvent: sink })
  const liarHandle = liar.handle
  const liarVerdict = liarHandle.connection()
  const consumerView = liarHandle.context.get('acme.liarp.status').connection()
  const liarText = JSON.stringify({ verdict: liarVerdict, consumer: consumerView })
  check('12 反例④（无凭据不得自称已连接）：插件自述 `connected:true` 但作用域内没有凭据 → 宿主核验视图'
    + '`available:false` + 有名 reason + next_action；**消费者拿到的也是核验过的视图**（`"connected":true` '
    + '一个字都不出现在对外输出里）；留痕 `connection-without-credential`',
  liarVerdict.available === false && liarVerdict.connected === false
  && liarVerdict.code === 'connection-without-credential'
  && String(liarVerdict.reason).length > 0 && String(liarVerdict.next_action).length > 0
  && liarVerdict.claimed_connected === true
  && consumerView.connected === false && consumerView.available === false
  && !/"connected"\s*:\s*true/.test(liarText)
  && events.some((event) => event.kind === 'userplugin/refused' && event.code === 'connection-without-credential'),
  `插件自述=connected:true（原始 claim 只在宿主闭包里）；宿主核验=${JSON.stringify(liarVerdict)}；`
  + `消费者视图=${JSON.stringify(consumerView)}；输出含 "connected":true = ${/"connected"\s*:\s*true/.test(liarText)}`)

  // ---------- 13. 有界 ----------
  const boundedScan = U.scan(FIX_BOUND)
  const boundedMounted = await mountManager(M, { root: FIX_MAIN, max_plugins: 2, max_bytes: 256 })
  const boundedList = boundedMounted.box.handle.list()
  await boundedMounted.fiber.dispose()
  check('13 有界：scan 上限 50（夹具 60 条 → 列出 50、omitted 10、truncated true，而 `counts.plugins` 仍是**真值 60**）；'
    + '管理面 `max_plugins=2` 二次夹取 ns 列表（3 个 ns → 列出 2、omitted 1）而 `counts.plugins` 仍是**真值 6**'
    + '（展示可以有界，数字不许悄悄变小）',
  boundedScan.namespaces[0].plugins.length === 50 && boundedScan.omitted === 10
  && boundedScan.truncated === true && boundedScan.counts.plugins === 60 && boundedScan.degraded === false
  && boundedList.namespaces.length === 2 && boundedList.counts.plugins === 6 && boundedList.omitted === 1
  && boundedList.truncated === true,
  `scan：plugins=${boundedScan.namespaces[0].plugins.length} omitted=${boundedScan.omitted}`
  + ` counts.plugins=${boundedScan.counts.plugins} truncated=${boundedScan.truncated}；`
  + `管理面 max_plugins=2：ns=${boundedList.namespaces.length} omitted=${boundedList.omitted} counts.plugins=${boundedList.counts.plugins}`)

  // ---------- 14. 确定性 ----------
  const scanOnce = JSON.stringify(U.scan(FIX_MAIN))
  const scanTwice = JSON.stringify(U.scan(FIX_MAIN))
  const listOnce = JSON.stringify((await mountManager(M, { root: FIX_MAIN })).box.handle.list())
  const frozen = deepFreeze(JSON.parse(JSON.stringify({ root: FIX_MAIN })))
  let frozenOk = true
  try {
    const probe = await mountManager(M, frozen)
    frozenOk = JSON.stringify(probe.box.handle.list()) === listOnce
    await probe.fiber.dispose()
  } catch {
    frozenOk = false
  }
  const orderOk = JSON.parse(scanOnce).namespaces.map((item) => item.ns).join(',') === 'acme,bravo,other-ns'
  check('14 确定性：同输入两次 scan **字节一致**、跨实例 list 一致、**夹具目录按名称倒序创建**但输出仍是名称序'
    + '（写入顺序无关）、冻结输入不抛且结果一致、入参不被改写（不读墙钟、不随机）',
  scanOnce === scanTwice && frozenOk && orderOk
  && JSON.stringify(JSON.parse(scanOnce)) === scanOnce
  && FIX_MAIN.startsWith(FIX),
  `两次一致=${scanOnce === scanTwice}（${scanOnce.length} 字节）；跨实例一致=${frozenOk}；`
  + `输出顺序=${JSON.parse(scanOnce).namespaces.map((item) => item.ns).join(',')}（夹具按 other-ns→bravo→acme 顺序创建）`)

  // ---------- 15. 静态负控 ----------
  const libHits = scanSource(kernelArtifact.source)
  const managerHits = scanSource(managerArtifact.source)
  const plantedHits = scanSource(PLANTED)
  check('15 静态负控：两个产物零写文件/零子进程/零网络/零事件订阅/零随机/零墙钟/零定时器/零账本调用'
    + '（只读扫描与 `import()` 允许）；扫描器**非空转**（合成坏源码必须命中）',
  libHits.length === 0 && managerHits.length === 0 && plantedHits.length >= 5,
  `内核命中=${libHits.join(',') || '无'}；管理面命中=${managerHits.join(',') || '无'}；`
  + `非空转对照命中 ${plantedHits.length} 处=${plantedHits.slice(0, 6).join(',')}`)

  // ---------- 16. 配置契约负控 ----------
  const refuses = (raw) => {
    try {
      M.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const defaults = M.Config.parse({})
  const huge = await mountManager(M, { root: FIX_BOUND, max_plugins: 1e9, max_bytes: 1e9 })
  const hugeList = huge.box.handle.list()
  await huge.fiber.dispose()
  const zero = await mountManager(M, { root: FIX_MAIN, max_plugins: -5, max_bytes: 0 })
  const zeroList = zero.box.handle.list()
  const zeroStats = zero.box.handle.stats()
  await zero.fiber.dispose()
  const nan = await mountManager(M, { root: FIX_MAIN, max_plugins: Number.NaN })
  const nanList = nan.box.handle.list()
  await nan.fiber.dispose()
  const unconfigured = await mountManager(M, {})
  const unconfiguredList = unconfigured.box.handle.list()
  await unconfigured.fiber.dispose()
  check('16 配置契约负控：未知键/错误类型/非对象入参一律被拒（不得静默放行）；默认值 root=空串 / 50 / 256；'
    + '越界夹取（1e9→上限、-5→0、NaN→默认）；root 为空串（未配置）→ **降级有名**而不是"健康的零"',
  refuses({ root: FIX_MAIN, typo_key: 1 }) === 'refused' && refuses({ max_plugins: 'many' }) === 'refused'
  && refuses(42) === 'refused' && defaults.root === '' && defaults.max_plugins === 50 && defaults.max_bytes === 256
  && hugeList.namespaces.length === 1 && hugeList.counts.plugins === 60
  && zeroList.namespaces.length === 0 && zeroList.counts.plugins === 6 && zeroList.omitted === 3
  && zeroStats.limits.max_plugins === 0 && zeroStats.limits.max_bytes === 0
  && nanList.namespaces.length === 3 && nanList.counts.plugins === 6
  && unconfiguredList.degraded === true && unconfiguredList.reason === 'user-space-root-unconfigured'
  && unconfiguredList.next_action !== '' && unconfiguredList.namespaces.length === 0,
  `未知键=${refuses({ root: FIX_MAIN, typo_key: 1 })} 错类型=${refuses({ max_plugins: 'many' })} `
  + `非对象=${refuses(42)}；默认=${JSON.stringify(defaults)}；1e9→${hugeList.namespaces.length} ns/${hugeList.counts.plugins} 插件；`
  + `-5→${zeroList.namespaces.length} ns（omitted ${zeroList.omitted}）counts.plugins=${zeroList.counts.plugins}；`
  + `NaN→${nanList.namespaces.length} ns；未配置=${unconfiguredList.degraded}/${unconfiguredList.reason}`)

  // ---------- 17. 降级与"零 ≠ 读不到" ----------
  const absentScan = U.scan(FIX_ABSENT)
  const notDirScan = U.scan(FIX_FILE)
  const absentList = await mountManager(M, { root: FIX_ABSENT })
  const absentListOut = absentList.box.handle.list()
  await absentList.fiber.dispose()
  check('17 降级与"零 ≠ 读不到"：目录不存在 → **空结果且 degraded:false**（零插件不是故障）；'
    + '路径存在但是文件 → `degraded:true` + 有名 reason + next_action，形状与正常输出一致'
    + '（两种情形可区分：前者的 `reason` 为空，后者有名）',
  absentScan.degraded === false && absentScan.namespaces.length === 0 && absentScan.reason === ''
  && absentScan.counts.plugins === 0
  && notDirScan.degraded === true && notDirScan.reason === 'user-space-root-not-a-directory'
  && notDirScan.next_action !== '' && notDirScan.namespaces.length === 0
  && JSON.stringify(Object.keys(absentScan).sort()) === JSON.stringify(Object.keys(notDirScan).sort())
  && absentListOut.degraded === false && absentListOut.counts.plugins === 0,
  `不存在=${JSON.stringify({ degraded: absentScan.degraded, reason: absentScan.reason, plugins: absentScan.counts.plugins })}；`
  + `是文件=${JSON.stringify({ degraded: notDirScan.degraded, reason: notDirScan.reason })}；`
  + `同形状=${JSON.stringify(Object.keys(absentScan).sort()) === JSON.stringify(Object.keys(notDirScan).sort())}`)

  // ---------- 18. 提权负控 ----------
  const elevMounted = await mountManager(M, { root: FIX_ELEV, max_plugins: 50, max_bytes: 256 })
  const elev = elevMounted.box.handle
  const needsApproval = elev.elevateRequest('acme', 'ap', undefined)
  const malformed = elev.elevateRequest('acme', 'ap', 'ap-1')
  const tampered = elev.elevateRequest('acme', 'tamperd', 'ap-0002')
  const missing = elev.elevateRequest('acme', 'nosuch', 'ap-0003')
  const ready = elev.elevateRequest('acme', 'ap', 'ap-0001')
  await elevMounted.fiber.dispose()
  const promoteTarget = join(ROOT, 'host', 'modules', 'ap.mjs')
  check('18 提权负控：缺 `approval_ref` → `elevate-needs-approval`；畸形引用（`ap-1`）同样拒；'
    + '**影子哈希 ≠ 清单哈希** → `elevate-tampered`；插件不存在 → `plugin-not-found`；'
    + '三者齐备 → 待办载荷（`kind=plugin-elevation-request`、`target=host/modules/ap.mjs`、`written:false`）'
    + '且**本批不真写** `host/modules/`',
  needsApproval.ok === false && needsApproval.code === 'elevate-needs-approval'
  && malformed.ok === false && malformed.code === 'elevate-needs-approval'
  && tampered.ok === false && tampered.code === 'elevate-tampered'
  && missing.ok === false && missing.code === 'plugin-not-found'
  && ready.ok === true && ready.kind === 'plugin-elevation-request'
  && ready.target === 'host/modules/ap.mjs' && ready.written === false
  && ready.approval_ref === 'ap-0001' && ready.manifest_sha256 === sha256(readFileSync(join(FIX_ELEV, 'acme', 'ap', 'index.mjs'), 'utf8'))
  && !existsSync(promoteTarget),
  `缺引用=${needsApproval.code}；畸形引用=${malformed.code}；影子哈希不一致=${tampered.code}；`
  + `不存在=${missing.code}；齐备=${JSON.stringify({ code: ready.code, kind: ready.kind, target: ready.target, written: ready.written })}；`
  + `host/modules/ap.mjs 存在=${existsSync(promoteTarget)}`)

  // ---------- 19. requestCreate 零写面 ----------
  const before = walkFiles(FIX_MAIN)
  const description = '做一个把报价单按供应商聚合并导出 CSV 的插件'
  const request = elev.requestCreate({ ns: 'acme', description })
  const requestBad = elev.requestCreate({ ns: '../host', description })
  const requestEmpty = elev.requestCreate({ ns: 'acme', description: '   ' })
  const after = walkFiles(FIX_MAIN)
  check('19 requestCreate 零写面：返回的待办载荷形状**恰好** `{kind:plugin-request, ns, description_sha256, bytes}`'
    + '（哈希与字节数手算一致）；**一个文件都没产生**（前后文件清单逐字一致）；非法 ns 与空描述被拒'
    + '（`user-space-outside-ns` / `manifest-invalid`）',
  request.kind === 'plugin-request' && request.ns === 'acme'
  && request.description_sha256 === sha256(description)
  && request.bytes === Buffer.byteLength(description, 'utf8')
  && requestBad.ok === false && requestBad.code === 'user-space-outside-ns'
  && requestEmpty.ok === false && requestEmpty.code === 'manifest-invalid'
  && JSON.stringify(before) === JSON.stringify(after) && before.length > 0,
  `载荷=${JSON.stringify(request)}；文件清单不变=${JSON.stringify(before) === JSON.stringify(after)}（${after.length} 个）；`
  + `非法 ns=${requestBad.code}；空描述=${requestEmpty.code}`)

  // ---------- 20. stats 只读且不含凭据 ----------
  const credMounted = await mountManager(M, { root: FIX_MAIN })
  await credMounted.box.handle.load('acme', 'greeter')
  const statsText = JSON.stringify(credMounted.box.handle.stats()) + JSON.stringify(credMounted.box.handle.list())
  const eventsText = JSON.stringify(credMounted.box.handle.events())
  await credMounted.fiber.dispose()
  check('20 stats() 只读且不含凭据：汇总里既没有 `cred:` 前缀也没有作用域内的凭据值，也没有 env 明文；'
    + '`stats()`/`list()` 前后目录逐字节不变（只读）',
  !statsText.includes('cred:') && !statsText.includes(SECRET) && !statsText.includes('B-SECRET')
  && !eventsText.includes('cred:') && !eventsText.includes(SECRET)
  && !statsText.includes('process.env') && statsText.includes('"loaded":1'),
  `stats+list 含 cred:=${statsText.includes('cred:')}；含哨兵=${statsText.includes(SECRET)}；`
  + `loaded=${credMounted.box.handle.stats().loaded}；留痕条数=${credMounted.box.handle.events().length}`)

  // ---------- 21. 四类反例留痕汇总（AC-USERPLUG-007 逐字：四条各给拒绝码 + next_action） ----------
  const credEvents = credMounted.box.handle.events()
  const ledger = [...events, ...crossEvents, ...credEvents]
    .filter((event) => event.kind === 'userplugin/refused')
  const REQUIRED_CODES = ['user-space-outside-ns', 'state-scope-refused', 'user-plugin-not-elevated',
    'connection-without-credential']
  const covered = REQUIRED_CODES.filter((code) => ledger.some((event) => event.code === code))
  const withNextAction = ledger.filter((event) => String(event.next_action ?? '').length > 0).length
  check('21 四类反例留痕汇总：①写别人目录/`host/modules`（`user-space-outside-ns`）②跨 instance 共享可变状态'
    + '（`state-scope-refused`）③未提权被他人加载（`user-plugin-not-elevated`）④无凭据自称已连接'
    + '（`connection-without-credential`）**四条各自都留下了** `userplugin/refused` 事件，且**每条都带'
    + ' `code` 与 `next_action`**（留痕真源是内存事件流；落账本由 Python 侧做，H1）',
  covered.length === 4 && ledger.length >= 4 && withNextAction === ledger.length
  && ledger.every((event) => typeof event.code === 'string' && event.code !== '')
  && [...new Set(ledger.map((event) => event.code))].length >= 4,
  `留痕 ${ledger.length} 条；四类覆盖=${JSON.stringify(covered)}；带 next_action 的=${withNextAction}/${ledger.length}；`
  + `出现的码=${JSON.stringify([...new Set(ledger.map((event) => event.code))])}`)

  for (const handle of [handleB, handleC, scoped.handle, liarHandle]) {
    if (handle) await handle.unload()
  }
  await mounted.ctx.stop?.()
} catch (error) {
  check('门执行异常（不得静默通过）', false, `${error.name}: ${String(error.message).slice(0, 240)}`)
}

finish()

/** `..` 之外的辅助：判一条"解析成功且连接被认可"（正控用）。 */
function scopedRefusalOk(verdict) {
  return Boolean(verdict) && verdict.available === true && verdict.connected === true && verdict.credential === 'smtp'
}

function throwsCode(fn, code) {
  try {
    fn()
    return false
  } catch (error) {
    return error?.code === code
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

function walkFiles(dir) {
  const out = []
  const visit = (current) => {
    let entries = []
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of [...entries].sort()) {
      const path = join(current, entry)
      let stat = null
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) visit(path)
      else out.push(posix(path))
    }
  }
  visit(dir)
  return out.sort()
}
