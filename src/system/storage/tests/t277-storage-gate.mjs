/**
 * t277-storage-gate —— T-277「存储（文件管理 + 极简键值表）」两件产物的**围栏门**
 * （宿主侧人工维护，**不由被围对象自己写**）。
 *
 * 契约：`docs/design/25-storage-plugins.md`（租户隔离 / "存储不得成为第二条事实写路径" /
 * 文件面与数据库面的接口与上界 / 被否决方案 / 未决项）；
 * 规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md` §1/§2/§3/§6。
 *
 * 被围对象（两件）：
 *   · `tools/storage.py`        —— **Python 侧唯一写入者**（文件管理面 + 极简键值表）；
 *   · `host/modules/storage-view.mjs` —— 宿主侧**只读**聚合（`provides: ['storageView']`）。
 * 两件的**实际路径、字节数与 sha256 写进第 1 条断言的 detail**（变异自证就是靠这一行确认
 * "红的是我改的那一份"，而不是"看着红"）。
 *
 * 口径备忘（写清楚，免得读者以为门在自欺）：
 *   · **本门会起子进程**（`python3 tools/storage.py ...`）：门是**测试台**，不是宿主服务 ——
 *     第 7 条断言的"零写面"是冲着**被围的宿主模块**说的（静态扫描 + 非空转对照），
 *     而第 3/4/5/6/8/9/17 条必须**真跑** Python 侧才算验证（只断言"应该被拒"不算通过）。
 *   · **所有临时写都落在 `os.tmpdir()` 的 mkdtemp 里**：不碰产品树、不碰 `tmp/storage/`、
 *     **绝不往真账本 `tmp/ui-shared/**` 写任何字节**（第 8 条逐字节核对真账本目录）。
 *   · 只有第 5/6 条会**故意**制造"半写行 / 超长行 / 越界符号链"（模拟别的写入方或崩溃），
 *     因为"报破条数"必须有个破的样本才验得出来；这些样本全部落在临时目录里。
 *
 * 断言（19 条 + 空集合守卫；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：`tools/storage.py` 能编译、声明上界表与拒绝码闭合集合（每条码都有 next_action）；
 *     `storage-view` manifest 齐备；打印两件产物的路径/字节/sha256（变异自证靠这一行）
 *   2 storage-view 挂载：provide 拦截拿得到句柄（键**恰好** config/headline/snapshot）；dispose 前 effect>0
 *   3 Python 侧正控（**真跑**）：open-append/read-tail/list-files/stat + put/get/scan/delete
 *     （版本号递增、墓碑事件、`values_included:false`、`ledger_written:false`），磁盘上确实落了文件
 *   4 反例①（**跨租户读写被拒**）：`../<别的 ns>/...` 的写与读、非法 ns 名一律 `storage-outside-ns`
 *     + next_action；**且磁盘上没有任何新文件、哨兵在整棵树里检索不到**（只断言返回错误不算通过）
 *   5 反例②（**`../` / 绝对路径 / 符号链越界被拒**）：三种形态全 `storage-path-escape`；
 *     越界符号链**不被跟随**（`list-files` 只报名 + 计数 `counts.escaped`，外部文件正文与 sha256 一个都不出）；
 *     根外与 ns 根外**事后都不存在**目标文件；`..` 即使解析后仍在根里也拒
 *   6 反例③（**超界读取被截断且报破条数**）：42 行（含 1 条超长行 + 1 条半写行）→ `--limit 5` 出 5 行、
 *     `omitted=36`、**`broken_lines=1`**、`clipped_lines=1`（被夹行的 `bytes` 仍是真值）；
 *     `--limit` 缺失/0 → `storage-unbounded-read`；`--limit 999` → `storage-limit-exceeded`；
 *     超长 append → `storage-limit-exceeded` 且文件字节未变
 *   7 反例④（**host 模块零写面**）：静态扫描 `storage-view.mjs` 零写文件/零子进程/零网络/零随机/
 *     零墙钟/零定时器/零事件订阅/零账本调用；不出现 `tools/storage.py`（不调 Python）；
 *     扫描器**非空转**（合成坏源码必须命中 ≥5 处）
 *   8 拒写事实三类：`--ledger` 声明的路径、仓库内 `tmp/ui-shared/<realm>/ledger.jsonl`（绝对构造 +
 *     名字叫 `ledger.jsonl` 的相对构造）、`user-space/` 里别人的 ns → 全 `storage-fact-path`；
 *     且**本用例自己触及的事实区目标**（白名单：`--ledger` 指的那份账本、它构造的 snapshot 输出目标、
 *     它指过去的"别人的 ns"）保持原样、目标不存在。
 *     **反向自证（不空转）**：把事实区判据（`_inside_zone`）的两层形态循环各回退成只取词法形态
 *     （= `user-space` 为符号链接时的旧失效形态）写进 `tmp/` 下的变体副本 ⇒ f5/f6 必须被放行
 *     ⇒ 本断言在那种形态下**必红**；`--mutate 5` 就是这条的反向对照（改产品树后跑本门必须 exit 1）。
 *     **前提（实测踩到，必须写在判据里）**：事实区可能被**无关写入者**（运行中服务 / 定时任务：
 *     线上 webui 会按需重写 `pipeline.json`/`admin.json`/`retention-plan.json`，平台反馈会往
 *     `ui-feedback/` 落回执，内核账本由服务自己追加）在**任何时刻**改写 ⇒ 本断言**只覆盖本用例
 *     触及的目标**（全程快照对比），不拿"整个事实区字节/清单不变"当判据（那是把无关写入者算成本
 *     工具写的：假红）。账本类目标退化为**只增不改**（无关写入者只会追加；本工具的写一定带哨兵，
 *     由哨兵检索兜底），非账本类目标要求逐字节不变
 *   9 快照 → 只读聚合正控：真跑 `snapshot --out` → storage-view 读它，`counts` 与**独立遍历**（本门自己走一遍树）
 *     的手算一致；两次字节一致、跨实例一致
 *   10 按键白名单投影（负控）：注入含哨兵的快照（正文 / 路径原文 / 凭据）→ 输出里一个都不出现；
 *     租户键集**恰好**六格、顶层键集**恰好**固定表；畸形租户被丢并**计数** `invalid_tenants`；
 *     数字类型不对归 0 并计入 `clipped`
 *   11 有界与截断诚实：12 租户 + `max_tenants=4` → 出 4、`omitted_tenants=8`、`counts.tenants` 仍是真值 12；
 *     字符串超 `max_bytes` 被夹并计数
 *   12 降级与"空 ≠ 读不到"：未配/不可读/超上限/坏 JSON/非对象 → `degraded:true` + 有名 reason + next_action；
 *     合法零租户 → `degraded:false` + `reason='storage-empty'`；六种情形**同形状**且都不报"健康"
 *   13 租户范围：`{ns}` 只出本租户（别的租户名字一个字都不出现），`counts` 仍是全体真值 +
 *     `omitted_tenants` 报出；范围指到不存在的 ns → `storage-scope-empty`（不是降级）；范围形状非法 → 拒
 *   14 确定性：同输入两次字节一致、租户顺序颠倒不改输出、冻结输入不抛、入参不被改写、跨实例一致
 *   15 配置负控：未知键/错类型/非对象入参被拒；默认值（snapshot=''、max_tenants=64、max_bytes=128）；
 *     越界夹取（1e9→上限、-5→0、NaN→默认）
 *   16 卸载零残留：dispose 后 `ctx.get` 取不到、effect 归零、新动作一律拒（`storage-view-disposed`）且不抛
 *   17 Python 侧可用性不伪装："未配 / 不是目录" → `storage-unavailable` + 有名 reason；"确实没有"（空租户 /
 *     没这个键 / 路径缺席）→ `ok:true` + 有名 reason（两种情形必须可区分）
 *   18 拒绝留痕汇总：整轮跑下来的**每一条**拒绝都在闭合码集合里且都带 `next_action`
 *   19 全局层（事实区零写入，**白名单口径**）：本用例运行期间**没有任何写入落到事实区** ——
 *     白名单内（本用例触及的目标）按第 8 条的规则必须原样；白名单外的变化**不判红**，但**如实
 *     计数并打印**（无关写入者：运行中服务 / 定时任务）。判据本身**非空转自证**（8 组合成样本：
 *     追加/改写/截断/哨兵/凭空出现/消失/无变化，期望的红绿逐条核对）
 *   20 空集合守卫（一条都没跑 = 红）
 *
 * 变异模式（单点变异自证，自带防假变异）：`node host/t277-storage-gate.mjs --mutate <1..5>`
 *   ① `tools/storage.py`：跨租户分支被短路（`../<别的 ns>/x` 不再拒）
 *   ② `tools/storage.py`：符号链越界判定被短路（越界符号链被放行 → 写到根外）
 *   ③ `tools/storage.py`：`read_tail` 不再夹取 limit、`omitted` 恒 0（截断计数不诚实）
 *   ④ `host/modules/storage-view.mjs`：偷加写面（`node:fs` 的写 API 出现在源码里）
 *   每处都：锚点必须**恰好命中 1 次** → 变异后字节必须变 → 就地写回目标产物 → 起子进程跑本门（默认模式）
 *   → 必须 exit 1 且**首条 FAIL** 有名、且子进程第 1 条断言的 detail 里出现**变异后**的 sha256 →
 *   `finally` 还原并核对 sha256 与原始**逐字节一致**；任一步不满足即 exit 1（防假变异）。
 *
 * 用法：`node host/t277-storage-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）；
 *       `node host/t277-storage-gate.mjs --mutate <1..4>`（单点变异自证）。
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 */
// `cordis` 是宿主私有的裸名依赖：搬迁后本文件不在 `host/` 下，改为按**显式解析**导入
// （见下方 `CORDIS_URL`；与搬迁前 Node 从 `host/node_modules` 上溯到的是同一份）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
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
const GATE_PATH = join(HERE, 't277-storage-gate.mjs')
const MODULE_PATH = join(HERE, 'modules', 'storage-view.mjs')
const PY_PATH = join(ROOT, 'tools', 'storage.py')
const PY = process.env.QUOTAGENT_PYTHON || 'python3'
const UI_SHARED = join(ROOT, 'tmp', 'ui-shared')
const USER_SPACE = join(ROOT, 'user-space')
const DEFAULT_ROOT_DIR = join(ROOT, 'tmp', 'storage')

/** 哨兵（只用于"检索不到"的断言；绝不写进任何给宿主的输出） */
const SECRET = 'ZZ-T277-CREDENTIAL-SENTINEL-ZZ'
const BODY_SENTINEL = 'ZZ-T277-BODY-SENTINEL-ZZ'
const PATH_SENTINEL = '/srv/zz-t277-path-sentinel/private/kv.jsonl'

const CHECKS = []
const REFUSALS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail: String(detail) }) }
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const short = (text) => sha256(text).slice(0, 16)
const posix = (path) => String(path).split('\\').join('/')
const json = (value) => JSON.stringify(value)
const utf8 = (text) => Buffer.byteLength(text, 'utf8')
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红（「没跑到」不得当成「通过」）
  if (CHECKS.length === 0) {
    check('20 空集合守卫：门至少跑了一条断言（反例：门只打印了 JSON 却没跑断言）', false, 'CHECKS 为空')
  }
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, json({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures })
    + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 只读工具：挂载 / Python 驱动 / 目录遍历与哈希
// ---------------------------------------------------------------------------
const loadArtifact = async (path) => {
  const source = readFileSync(path, 'utf8')
  return { mod: await import(pathToFileURL(path).href), source, path, bytes: utf8(source),
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
  return { ctx, fiber, box, handle: box.handle }
}

const SCRATCH = mkdtempSync(join(tmpdir(), 't277-storage-'))
const ROOT_A = join(SCRATCH, 'storage-a')      // 正控 + 反例①②
const ROOT_B = join(SCRATCH, 'storage-b')      // 反例③（破行/超长行）
const ROOT_C = join(SCRATCH, 'storage-c')      // 干净的快照根（第 9 条）
const OUTSIDE = join(SCRATCH, 'outside')

/** 真跑 Python 侧：`python3 tools/storage.py <args...>`（只读 stdout 的最后一行 JSON）。 */
const pyRun = (args) => {
  const proc = spawnSync(PY, [PY_PATH, ...args], { cwd: ROOT, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024 })
  const stdout = String(proc.stdout ?? '')
  const lines = stdout.trim().split('\n').filter(Boolean)
  let payload = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])
      if (isPlain(parsed) && 'code' in parsed) {
        payload = parsed
        break
      }
    } catch { /* 不是 JSON 行就继续往前找 */ }
  }
  if (payload && payload.ok === false && typeof payload.code === 'string') REFUSALS.push(payload)
  return { status: proc.status, payload, stdout, stderr: String(proc.stderr ?? '') }
}

/**
 * 真跑**指定脚本**（反向自证用）：与 `pyRun` 同形状，但**不记入 REFUSALS**
 * —— 变异体/对照实体的输出不得污染第 18 条的拒绝码汇总。
 */
const pyRunVariant = (scriptPath, args) => {
  const proc = spawnSync(PY, [scriptPath, ...args], { cwd: ROOT, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024 })
  const stdout = String(proc.stdout ?? '')
  const lines = stdout.trim().split('\n').filter(Boolean)
  let payload = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])
      if (isPlain(parsed) && 'code' in parsed) {
        payload = parsed
        break
      }
    } catch { /* 不是 JSON 行就继续往前找 */ }
  }
  return { status: proc.status, payload, stdout, stderr: String(proc.stderr ?? '') }
}

/** 只读遍历（**不跟随越界符号链**）：返回 `[{rel, bytes}]`，稳定排序。 */
const walkStorage = (root) => {
  const out = []
  const realRoot = realpathSync(root)
  const visit = (dir) => {
    for (const name of [...readdirSync(dir)].sort()) {
      const path = join(dir, name)
      let real = null
      try {
        real = realpathSync(path)
      } catch {
        continue
      }
      if (!(real === realRoot || real.startsWith(realRoot + sep))) continue
      let stat = null
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) visit(path)
      else out.push({ rel: posix(relative(root, path)), bytes: stat.size })
    }
  }
  visit(root)
  return out.sort((left, right) => (left.rel < right.rel ? -1 : (left.rel > right.rel ? 1 : 0)))
}

/** 一棵树的逐字节指纹（`rel:sha256:bytes` 列表；用于"我们的临时根零变化"的断言）。 */
const treeDigest = (root, skip = new Set()) => {
  if (!existsSync(root)) return []
  return walkStorage(root).filter((item) => !skip.has(item.rel)).map((item) => {
    const text = readFileSync(join(root, item.rel), 'utf8')
    return `${item.rel}:${sha256(text)}:${item.bytes}`
  })
}

/**
 * 事实区（`tmp/ui-shared/**` + `user-space/**`）里**本用例自己触及的目标集合**（白名单）。
 *
 * 只有这些路径的变化才可能意味着"本工具写了事实区"；白名单外的变化一律来自**无关写入者**
 * （线上服务 / 定时任务：账本由服务自己追加、派生快照 JSON 由服务按需重写、平台反馈往
 * `ui-feedback/` 落回执）—— 不判红，但如实计数并打印（便于以后定位）。
 *
 * 白名单的构成就是本门第 8 条真跑出来的那几个目标：
 *   · `contractor/ledger.jsonl` —— `--ledger` 声明的路径（f1 的目标、f7 的 `--out` 目标）
 *   · `supplier/ledger.jsonl`   —— 用绝对路径构造的事实区目标（f3）
 *   · `contractor/bogus.json`   —— 构造的 snapshot 输出目标（f7，必须不存在）
 *   · `user-space/zz-t277-other` —— root 指过去的"别人的 ns"（f5，必须不存在）
 */
const FACT_ROOTS = [UI_SHARED, USER_SPACE]
const WHITELIST = new Map([
  [UI_SHARED, ['contractor/ledger.jsonl', 'supplier/ledger.jsonl', 'contractor/bogus.json']],
  [USER_SPACE, ['zz-t277-other']],
])

/** 白名单里属于"账本类"的目标：别的合法写入者只会**追加**（判据 = 只增不改 + 无哨兵）。 */
const APPEND_ONLY = new Set(['contractor/ledger.jsonl', 'supplier/ledger.jsonl'])

/** 事实区一棵树的逐字节指纹（`rel → sha256`；用于"白名单外变化"的计数与打印）。 */
const factDigest = (root) => new Map((existsSync(root) ? walkStorage(root) : [])
  .map((item) => [item.rel, sha256(readFileSync(join(root, item.rel), 'utf8'))]))

/** 白名单目标的快照状态（`{exists, text}`；目录或不可读 → `text=null`，只按存在性判）。 */
const factTargetState = (root, rel) => {
  const path = join(root, rel)
  if (!existsSync(path)) return { exists: false, text: null }
  try {
    return { exists: true, text: readFileSync(path, 'utf8') }
  } catch {
    return { exists: true, text: null }
  }
}

/**
 * 白名单目标**是否被本用例写过**：`null` = 没写（绿），否则返回必须变红的原因。
 * 判据（每条都是"这个工具真的往事实区写了"的充分证据）：
 *   · 本不存在 → 出现（本用例只会**被拒**，不可能创建）；存在 → 消失（本工具不删事实）
 *   · 正文里出现本门哨兵（本门任何一次事实区写入尝试都带哨兵，这是兜底）
 *   · 账本类：只增不改（无关写入者只会追加；head 被改 = 改写；变短 = 截断）
 *   · 非账本类：逐字节不变
 */
const whitelistViolation = (before, after, appendOnly) => {
  if (!before.exists && after.exists) return '白名单目标原不存在、现在出现了'
  if (before.exists && !after.exists) return '白名单目标原来存在、现在没了'
  if (!before.exists && !after.exists) return null
  if (before.text === null || after.text === null) {
    return before.text === after.text ? null : '白名单目标的类型/可读性变了'
  }
  if ([BODY_SENTINEL, SECRET, PATH_SENTINEL].some((needle) => after.text.includes(needle))) {
    return '白名单目标正文里出现本门哨兵（= 本工具真的写了它）'
  }
  if (appendOnly) {
    return after.text.startsWith(before.text) ? null : '白名单账本被改写（不是只在尾部追加）'
  }
  return after.text === before.text ? null : '白名单目标逐字节变了'
}

/**
 * 判据的**非空转自证**：合成样本逐条核对期望的红/绿。
 * 没有这组对照，"判据恒绿"与"事实区真的没被写"就分不开（第 7 条扫描器用的是同一条纪律）。
 */
const state = (exists, text) => ({ exists, text })
const WHITELIST_SELF_TEST = [
  ['账本被无关写入者**只追加** → 不判红（这正是解耦的目的）',
    state(true, 'a\n'), state(true, 'a\nb\n'), true, false],
  ['账本 head 被改写 → 红', state(true, 'a\n'), state(true, 'x\na\n'), true, true],
  ['账本被截断 → 红', state(true, 'a\nb\n'), state(true, 'a\n'), true, true],
  [`账本里出现本门哨兵 → 红`, state(true, 'a\n'), state(true, `a\n${BODY_SENTINEL}\n`), true, true],
  ['非账本目标被改写 → 红', state(true, '{}'), state(true, '{ }'), false, true],
  ['非账本目标逐字节没变 → 不判红', state(true, '{}'), state(true, '{}'), false, false],
  ['本用例构造的目标凭空出现 → 红', state(false, null), state(true, '{}'), false, true],
  ['本用例构造的目标消失 → 红', state(true, '{}'), state(false, null), false, true],
]
const selfTestBad = WHITELIST_SELF_TEST.filter(([, before, after, appendOnly, expectRed]) =>
  Boolean(whitelistViolation(before, after, appendOnly)) !== expectRed)
const SELF_TEST_DETAIL = `${WHITELIST_SELF_TEST.length - selfTestBad.length}/${WHITELIST_SELF_TEST.length}`
  + ` 与预期一致（追加不判红 / 改写·截断·哨兵·凭空出现·消失 判红）`

/**
 * 白名单**全程快照对比**的裁决：白名单内的变化 = 红；白名单外的变化 = 如实计数（不判红）。
 * 两个返回字段各自进 detail，便于以后出现"门红"时一眼看到谁动了事实区。
 */
const factVerdict = () => {
  const violations = []
  const unrelated = []
  for (const root of FACT_ROOTS) {
    const allow = new Set(WHITELIST.get(root) ?? [])
    for (const [rel, before] of FACT_TARGETS_BEFORE.get(root) ?? []) {
      const bad = whitelistViolation(before, factTargetState(root, rel), APPEND_ONLY.has(rel))
      if (bad) violations.push(`${posix(relative(ROOT, join(root, rel)))}：${bad}`)
    }
    const digestBefore = FACT_DIGEST_BEFORE.get(root) ?? new Map()
    const digestAfter = factDigest(root)
    for (const rel of new Set([...digestBefore.keys(), ...digestAfter.keys()])) {
      if (allow.has(rel)) continue
      if (digestBefore.get(rel) === digestAfter.get(rel)) continue
      const kind = digestBefore.has(rel) ? (digestAfter.has(rel) ? '改写' : '消失') : '新增'
      unrelated.push(`${kind} ${posix(relative(ROOT, join(root, rel)))}`)
    }
  }
  const shown = unrelated.slice(0, 6)
  return { violations, unrelated, shown,
    text: `${unrelated.length} 处白名单外变化（不判红，如实计数）：`
      + `${shown.length ? shown.join('、') : '无'}${unrelated.length > shown.length ? ' …' : ''}` }
}

/** 在目录树里检索一段文本（只读）。 */
const scanTreeText = (root, needle) => (existsSync(root) ? walkStorage(root) : [])
  .filter((item) => {
    try {
      return readFileSync(join(root, item.rel), 'utf8').includes(needle)
    } catch {
      return false
    }
  }).map((item) => item.rel)

// ---------------------------------------------------------------------------
// 变异模式（单点变异自证）：`--mutate <1..4>`
// ---------------------------------------------------------------------------
const MUTATIONS = [
  { id: 1, target: PY_PATH, label: '跨租户不再被拒（`_target` 的 cross-ns 分支被短路）',
    anchor: '        if _inside(root_path, candidate) and not _inside(ns_root, candidate):\n'
      + '            return None, _refuse("storage-outside-ns", "cross-ns-path", ns=ns, rel=rel)',
    replace: '        if False:\n'
      + '            return None, _refuse("storage-outside-ns", "cross-ns-path", ns=ns, rel=rel)' },
  { id: 2, target: PY_PATH, label: '符号链越界不再被拒（`_target` 的 symlink 分支被短路）',
    anchor: '    if not _inside(ns_real, cand_real):\n'
      + '        return None, _refuse("storage-path-escape", "symlink-escapes-ns-root", ns=ns, rel=rel)',
    replace: '    if False:\n'
      + '        return None, _refuse("storage-path-escape", "symlink-escapes-ns-root", ns=ns, rel=rel)' },
  { id: 3, target: PY_PATH, label: '截断计数不诚实（read_tail 不夹 limit 且 omitted 恒 0）',
    anchor: '    window = decoded[-limit:]\n    omitted = len(decoded) - len(window)',
    replace: '    window = decoded\n    omitted = 0' },
  { id: 4, target: MODULE_PATH, label: '宿主模块偷加写面（`node:fs` 的写 API 进了源码）',
    anchor: "export const name = 'storage-view'",
    replace: "import { writeFileSync } from 'node:fs'\nexport const name = 'storage-view'" },
  // ⑤ 本题修的那个真缺陷的**反向对照**：把事实区判据回退成搬迁前的**词法形态**（`user-space` 是指向
  // `src/userspace/` 的符号链接 ⇒ `_inside(USER_SPACE, <realpath>)` 恒假）。变异后第 8 条必红。
  { id: 5, target: PY_PATH, label: '事实区判据退回词法形态（`user-space` 符号链接下第 8 条失效）',
    anchor: '    for root in _zone_forms(zone):\n        for item in _zone_forms(target):',
    replace: '    for root in _zone_forms(zone)[:1]:\n        for item in _zone_forms(target)[:1]:' },
]

const emitMutation = (payload, code) => { writeSync(1, json(payload) + '\n'); process.exit(code) }

const runMutation = (id) => {
  const spec = MUTATIONS.find((item) => item.id === id)
  if (!spec) emitMutation({ ok: false, mutation: id, error: `未知变异编号 ${id}（只支持 1..5）` }, 2)
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
  // 另存一份原始字节（万一还原失败还有救）；放在临时目录里，不碰产品树
  const rescueDir = mkdtempSync(join(tmpdir(), 't277-mutant-'))
  writeFileSync(join(rescueDir, `mutation-${id}.orig`), pristine, 'utf8')
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
    target: posix(relative(ROOT, spec.target)),
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

const pyArtifact = { path: PY_PATH, source: readFileSync(PY_PATH, 'utf8') }
const modArtifact = await loadArtifact(MODULE_PATH)
const S = modArtifact.mod

/**
 * 整轮跑下来，产品树侧的"零变化"基线。
 * 事实区**只记本用例触及目标的全文**（白名单）+ 整棵树指纹（仅用于**计数**白名单外的变化），
 * 不把"整个事实区逐字节不变"当判据 —— 理由见文件头第 8 条的前提。
 */
const FACT_DIGEST_BEFORE = new Map(FACT_ROOTS.map((root) => [root, factDigest(root)]))
const FACT_TARGETS_BEFORE = new Map(FACT_ROOTS.map((root) => [root,
  (WHITELIST.get(root) ?? []).map((rel) => [rel, factTargetState(root, rel)])]))
const DEFAULT_ROOT_BEFORE = treeDigest(DEFAULT_ROOT_DIR)
const MODULE_TREE_BEFORE = treeDigest(join(HERE, 'modules'))
const MOUNTS = []

/** 造一个挂载（登记进 MOUNTS，第 16 条统一卸载）。 */
const mount = async (raw) => {
  const instance = await mountWith(S, raw)
  MOUNTS.push([raw, instance])
  if (instance.handle === null) throw new Error(`storage-view 没 provide 出句柄（raw=${json(raw)}）`)
  return instance
}

/** 造一份可注入的租户条目（形状与 Python 侧快照一致）。 */
const tenant = (ns, index) => ({ ns, files: index, file_bytes: index * 10, tables: 1, keys: index,
  last_write: '2026-09-21T00:00:00Z', file_samples: [{ rel: PATH_SENTINEL, body: BODY_SENTINEL }],
  table_samples: [{ table: 'kv', value: BODY_SENTINEL }], credentials: { token: SECRET },
  value: BODY_SENTINEL, path: PATH_SENTINEL })

try {
  // ---------- 1. 契约正控 ----------
  const compile = spawnSync(PY, ['-m', 'py_compile', posix(relative(ROOT, PY_PATH))], { cwd: ROOT,
    encoding: 'utf8' })
  const limitsRun = pyRun(['limits'])
  const LIMITS = limitsRun.payload?.limits ?? {}
  const CODES = limitsRun.payload?.codes ?? []
  const CODES_EXPECTED = ['storage-outside-ns', 'storage-path-escape', 'storage-fact-path',
    'storage-unbounded-read', 'storage-limit-exceeded', 'storage-unavailable', 'storage-schema-refused']
  const LIMITS_EXPECTED = { max_line_bytes: 4096, max_file_bytes: 1048576, max_tail_lines: 200,
    max_value_bytes: 4096, max_keys_per_table: 4096, max_tables: 32, max_tenant_bytes: 8388608 }
  const limitsBad = Object.entries(LIMITS_EXPECTED).filter(([key, value]) => LIMITS[key] !== value)
  const nextActionBad = CODES.filter((code) => String(limitsRun.payload?.next_actions?.[code] ?? '') === '')
  const shape = {
    name: S?.name === 'storage-view',
    provides: Array.isArray(S?.provides) && S.provides.join(',') === 'storageView',
    inject: Array.isArray(S?.inject) && S.inject.length === 0,
    usedServices: Array.isArray(S?.usedServices) && S.usedServices.length === 0,
    Config: typeof S?.Config?.parse === 'function' && typeof S?.Config?.['~standard']?.validate === 'function',
    apply: typeof S?.apply === 'function',
    fixture: typeof S?.fixture?.sample === 'function',
  }
  const shapeBad = Object.entries(shape).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：`tools/storage.py` 能编译 + 上界表与拒绝码闭合集合（每条码都有 next_action）；'
    + '`storage-view` manifest 齐备（name/provides/inject=[]/usedServices=[]/Config/apply/fixture）；'
    + '打印两件产物的路径/字节/sha256（变异自证靠这一行）',
  compile.status === 0 && limitsBad.length === 0 && json(CODES) === json(CODES_EXPECTED)
  && nextActionBad.length === 0 && shapeBad.length === 0,
  `storage.py=${posix(relative(ROOT, PY_PATH))}（${utf8(pyArtifact.source)} 字节，`
  + `sha256=${short(pyArtifact.source)}…）py_compile=${compile.status}；`
  + `storage-view.mjs=${posix(relative(ROOT, MODULE_PATH))}（${modArtifact.bytes} 字节，`
  + `sha256=${short(modArtifact.source)}…）；上界差异=${json(limitsBad)}；`
  + `码表一致=${json(CODES) === json(CODES_EXPECTED)}（${CODES.length} 条）；缺 next_action=${json(nextActionBad)}；`
  + `manifest 问题键=${json(shapeBad)}；默认根=${limitsRun.payload?.default_root}`)

  // ---------- 2. 挂载与句柄 ----------
  const base = await mount({ snapshot: '' })
  const viewKeys = Object.keys(base.handle).sort()
  const VIEW_KEYS = ['config', 'headline', 'snapshot']
  check('2 storage-view 挂载：provide 拦截拿得到句柄（键**恰好** config/headline/snapshot）；'
    + 'effect 已注册（>0）、服务可在 ctx 里取到、config() 报的是夹取后的配置',
  json(viewKeys) === json(VIEW_KEYS) && base.ctx.get('storageView') === base.handle
  && base.fiber.getEffects().length > 0 && json(base.handle.config()) === json({ snapshot: '',
    max_tenants: 64, max_bytes: 128 }),
  `句柄键=${json(viewKeys)}；ctx.get 一致=${base.ctx.get('storageView') === base.handle}；`
  + `effect=${base.fiber.getEffects().length}；config=${json(base.handle.config())}`)

  // ---------- 3. Python 侧正控（真跑） ----------
  const r3 = {
    a1: pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel', 'logs/run.log',
      '--text', '第一行', '--text', '第二行']),
    t1: pyRun(['--root', ROOT_A, 'read-tail', '--ns', 'acme', '--rel', 'logs/run.log', '--limit', '5']),
    p1: pyRun(['--root', ROOT_A, 'put', '--ns', 'acme', '--table', 'kv', '--key', 'k1',
      '--value', 'v1', '--at', '2026-09-21T00:00:00Z']),
    p2: pyRun(['--root', ROOT_A, 'put', '--ns', 'acme', '--table', 'kv', '--key', 'k1', '--value', 'v2']),
    p3: pyRun(['--root', ROOT_A, 'put', '--ns', 'acme', '--table', 'kv', '--key', 'k2', '--value', 'v3']),
    g1: pyRun(['--root', ROOT_A, 'get', '--ns', 'acme', '--table', 'kv', '--key', 'k1']),
    sc: pyRun(['--root', ROOT_A, 'scan', '--ns', 'acme', '--table', 'kv']),
    d1: pyRun(['--root', ROOT_A, 'delete', '--ns', 'acme', '--table', 'kv', '--key', 'k1']),
    g2: pyRun(['--root', ROOT_A, 'get', '--ns', 'acme', '--table', 'kv', '--key', 'k1']),
    st: pyRun(['--root', ROOT_A, 'stat', '--ns', 'acme', '--rel', 'logs/run.log']),
    lf: pyRun(['--root', ROOT_A, 'list-files', '--ns', 'acme']),
    empty: pyRun(['--root', ROOT_A, 'list-files', '--ns', 'zz-never-used']),
  }
  const logPath = join(ROOT_A, 'acme', 'logs', 'run.log')
  const tablePath = join(ROOT_A, 'acme', 'db', 'kv.jsonl')
  check('3 Python 侧正控（真跑）：open-append 两行 → read-tail 回读；put 两次 → 版本号递增到 2；'
    + 'get 回读最新值；scan 出键但 `values_included:false`；delete 写**墓碑**（版本 3、键仍不再出现）；'
    + 'stat/list-files 的计数与磁盘一致；每次写都 `ledger_written:false`（存储不落账本）',
  r3.a1.payload?.ok === true && r3.a1.payload?.lines === 2 && r3.a1.payload?.ledger_written === false
  && r3.t1.payload?.lines?.length === 2 && r3.t1.payload?.lines?.[0]?.text === '第一行'
  && r3.t1.payload?.counts?.lines_seen === 2 && r3.p1.payload?.version === 1
  && r3.p2.payload?.version === 2 && r3.p2.payload?.seq === 2 && r3.p3.payload?.version === 1
  && r3.p2.payload?.ledger_written === false && r3.g1.payload?.value === 'v2'
  && r3.g1.payload?.version === 2 && r3.sc.payload?.counts?.keys === 2
  && r3.sc.payload?.values_included === false && r3.sc.payload?.keys?.length === 2
  && r3.d1.payload?.deleted === true && r3.d1.payload?.tombstone_written === true
  && r3.d1.payload?.version === 3 && r3.d1.payload?.revision === 4 && r3.g2.payload?.found === false
  && r3.g2.payload?.ok === true && r3.g2.payload?.reason === 'key-not-found'
  && r3.st.payload?.bytes === 20 && r3.st.payload?.lines === 2 && r3.lf.payload?.counts?.files === 2
  && r3.lf.payload?.counts?.tables === 1 && r3.lf.payload?.degraded === false
  && r3.empty.payload?.ok === true && r3.empty.payload?.reason === 'namespace-empty'
  && r3.empty.payload?.counts?.files === 0 && existsSync(logPath) && existsSync(tablePath)
  && readFileSync(tablePath, 'utf8').split('\n').filter(Boolean).length === 4,
  `open-append=${json({ ok: r3.a1.payload?.ok, lines: r3.a1.payload?.lines, bytes: r3.a1.payload?.bytes_written })}；`
  + `read-tail=${json(r3.t1.payload?.counts)}；put 版本=${json([r3.p1.payload?.version,
    r3.p2.payload?.version, r3.p3.payload?.version])}；get=${json({ value: r3.g1.payload?.value,
    version: r3.g1.payload?.version })}；scan=${json({ keys: r3.sc.payload?.counts?.keys,
    values_included: r3.sc.payload?.values_included })}；delete=${json({ deleted: r3.d1.payload?.deleted,
    version: r3.d1.payload?.version, revision: r3.d1.payload?.revision })}；`
  + `get(删后)=${json({ ok: r3.g2.payload?.ok, found: r3.g2.payload?.found, reason: r3.g2.payload?.reason })}；`
  + `stat=${json({ bytes: r3.st.payload?.bytes, lines: r3.st.payload?.lines })}；`
  + `list-files=${json(r3.lf.payload?.counts)}；空租户=${json({ ok: r3.empty.payload?.ok,
    reason: r3.empty.payload?.reason })}；磁盘上落了=${existsSync(logPath) && existsSync(tablePath)}`)

  // ---------- 4. 反例①：跨租户读写被拒 ----------
  const alphaOwn = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'alpha', '--rel', 'logs/own.log',
    '--text', 'alpha 自己的行（正控：本租户可写）'])
  const treeBefore4 = walkStorage(ROOT_A)
  const xWrite = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'beta', '--rel',
    '../alpha/logs/secret.log', '--text', BODY_SENTINEL])
  const xRead = pyRun(['--root', ROOT_A, 'read-tail', '--ns', 'beta', '--rel',
    '../alpha/logs/own.log', '--limit', '5'])
  const xNs = pyRun(['--root', ROOT_A, 'list-files', '--ns', '../alpha'])
  const xNs2 = pyRun(['--root', ROOT_A, 'put', '--ns', 'Alpha', '--table', 'kv', '--key', 'k',
    '--value', 'x'])
  const xStat = pyRun(['--root', ROOT_A, 'stat', '--ns', 'beta', '--rel', 'logs/../../alpha/logs/x'])
  const treeAfter4 = walkStorage(ROOT_A)
  const sentinelHits4 = scanTreeText(ROOT_A, BODY_SENTINEL)
  const crossCodes = [xWrite.payload?.code, xRead.payload?.code, xNs.payload?.code, xNs2.payload?.code,
    xStat.payload?.code]
  check('4 反例①（**跨租户读写被拒**）：`../<别的 ns>/...` 的写与读、非法 ns 名（`../alpha`/`Alpha`）、'
    + '跨租户 stat 一律 `storage-outside-ns` + next_action；**且磁盘零新文件、跨租户哨兵在整棵树里'
    + '检索不到、alpha 的 own.log 一个字节没变**（只断言返回错误不算通过）',
  alphaOwn.payload?.ok === true
  && crossCodes.every((code) => code === 'storage-outside-ns')
  && [xWrite, xRead, xNs, xNs2, xStat].every((item) => String(item.payload?.next_action ?? '').length > 0)
  && json(treeBefore4) === json(treeAfter4) && sentinelHits4.length === 0
  && !existsSync(join(ROOT_A, 'acme', 'secret.log')) && !existsSync(join(ROOT_A, 'acme', 'logs', 'secret.log'))
  && readFileSync(join(ROOT_A, 'alpha', 'logs', 'own.log'), 'utf8') === 'alpha 自己的行（正控：本租户可写）\n',
  `本租户正控=${json({ ns: 'alpha', ok: alphaOwn.payload?.ok })}；`
  + `跨租户码=${json(crossCodes)}；next_action 齐=${[xWrite, xRead, xNs, xNs2, xStat]
    .every((item) => String(item.payload?.next_action ?? '').length > 0)}；`
  + `树未变=${json(treeBefore4) === json(treeAfter4)}（${treeAfter4.length} 个文件）；`
  + `哨兵命中=${json(sentinelHits4)}；alpha/own.log 未变=${readFileSync(join(ROOT_A, 'alpha', 'logs',
    'own.log'), 'utf8') === 'alpha 自己的行（正控：本租户可写）\n'}`)

  // ---------- 5. 反例②：`../` / 绝对路径 / 符号链越界被拒 ----------
  mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(join(OUTSIDE, 'leak.log'), BODY_SENTINEL + '\n', 'utf8')
  const symlinkDirOk = (() => {
    try {
      symlinkSync(OUTSIDE, join(ROOT_A, 'acme', 'link'), 'dir')
      symlinkSync(join(OUTSIDE, 'leak.log'), join(ROOT_A, 'acme', 'linkfile'), 'file')
      return true
    } catch {
      return false                                  // 造不出符号链 = 反例缺样本 → 本条必须红
    }
  })()
  const treeBefore5 = walkStorage(ROOT_A)
  const e1 = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel', '../../etc/passwd',
    '--text', 'x'])
  const e2 = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel',
    join(SCRATCH, 'absolute-target.log'), '--text', 'x'])
  const e3 = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel', 'logs/../deep.log',
    '--text', 'x'])
  const e4 = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel', 'link/escape.log',
    '--text', BODY_SENTINEL])
  const e5 = pyRun(['--root', ROOT_A, 'read-tail', '--ns', 'acme', '--rel', 'linkfile', '--limit', '5'])
  const lf5 = pyRun(['--root', ROOT_A, 'list-files', '--ns', 'acme'])
  const treeAfter5 = walkStorage(ROOT_A)
  const escapeCodes = [e1.payload?.code, e2.payload?.code, e3.payload?.code, e4.payload?.code,
    e5.payload?.code]
  const leaked = existsSync(join(OUTSIDE, 'escape.log'))
  const leakText = json(lf5.payload)
  check('5 反例②（**`../` / 绝对路径 / 符号链越界被拒**）：逃出存储根、绝对路径、'
    + '`..`（`logs/../deep.log` 即使解析后仍在根里也拒）、经符号链写到根外、经符号链读到根外 '
    + '五个形态全 `storage-path-escape` + next_action；**越界符号链不被跟随**'
    + '（`list-files` 把它只报名、计数 `counts.escaped`，外部文件正文/sha256 一个都不出）；'
    + '根外的目标文件**事后不存在**',
  symlinkDirOk && escapeCodes.every((code) => code === 'storage-path-escape')
  && [e1, e2, e3, e4, e5].every((item) => String(item.payload?.next_action ?? '').length > 0)
  && !leaked && !existsSync(join(SCRATCH, 'absolute-target.log'))
  && json(treeBefore5) === json(treeAfter5)
  && lf5.payload?.counts?.escaped >= 2 && json(lf5.payload?.escaped_symlinks) === json(['link', 'linkfile'])
  && (lf5.payload?.files ?? []).every((item) => item.rel !== 'linkfile' && !item.rel.startsWith('link/'))
  && lf5.payload?.degraded === true && lf5.payload?.reason === 'symlinks-escaped-ns-root'
  && !leakText.includes(BODY_SENTINEL) && !leakText.includes(sha256(BODY_SENTINEL + '\n')),
  `符号链可构造=${symlinkDirOk}；五形态码=${json(escapeCodes)}；`
  + `根外目标存在=${leaked || existsSync(join(SCRATCH, 'absolute-target.log'))}；`
  + `树未变=${json(treeBefore5) === json(treeAfter5)}；list-files escaped=${json({
    counts: lf5.payload?.counts, escaped_symlinks: lf5.payload?.escaped_symlinks,
    reason: lf5.payload?.reason })}；`
  + `外部正文泄漏=${leakText.includes(BODY_SENTINEL)}；外部 sha256 泄漏=${leakText.includes(sha256(BODY_SENTINEL + '\n'))}`)

  // ---------- 6. 反例③：超界读取被截断且报破条数 ----------
  const bigRel = 'logs/big.log'
  for (let index = 0; index < 40; index += 1) {
    pyRun(['--root', ROOT_B, 'open-append', '--ns', 'acme', '--rel', bigRel,
      '--text', `行-${String(index).padStart(2, '0')}`])
  }
  const bigPath = join(ROOT_B, 'acme', bigRel)
  // 门**故意**制造"别的写入方"才能造出来的两种破样本（模拟崩溃/绕过上界），全部落在临时目录里
  appendFileSync(bigPath, 'Y'.repeat(6000) + '\n', 'utf8')          // 超长行（> max_line_bytes）
  appendFileSync(bigPath, 'torn-tail-without-newline', 'utf8')      // 半写行（末尾没有换行）
  const sizeBefore = statSync(bigPath).size
  const overAppend = pyRun(['--root', ROOT_B, 'open-append', '--ns', 'acme', '--rel', 'logs/over.log',
    '--text', 'Z'.repeat(5000)])
  const sizeAfter = existsSync(join(ROOT_B, 'acme', 'logs', 'over.log'))
    ? statSync(join(ROOT_B, 'acme', 'logs', 'over.log')).size : 0
  const tail6 = pyRun(['--root', ROOT_B, 'read-tail', '--ns', 'acme', '--rel', bigRel, '--limit', '5'])
  const noLimit = pyRun(['--root', ROOT_B, 'read-tail', '--ns', 'acme', '--rel', bigRel])
  const zeroLimit = pyRun(['--root', ROOT_B, 'read-tail', '--ns', 'acme', '--rel', bigRel, '--limit', '0'])
  const hugeLimit = pyRun(['--root', ROOT_B, 'read-tail', '--ns', 'acme', '--rel', bigRel, '--limit', '999'])
  const badClip = pyRun(['--root', ROOT_B, 'read-tail', '--ns', 'acme', '--rel', bigRel, '--limit', '5',
    '--max-line-bytes', '0'])
  const longLine = (tail6.payload?.lines ?? []).find((item) => item.bytes === 6000)
  check('6 反例③（**超界读取被截断且报破条数**）：42 行（40 正常 + 1 超长 + 1 半写）→ `--limit 5` '
    + '出 5 行、`omitted=36`、**`broken_lines=1`**（半写行被丢且**报数**）、`clipped_lines=1`'
    + '（被夹行 `bytes` 仍是真值 6000、夹后 ≤ 4096）、`truncated:true`、`degraded:true`；'
    + '`--limit` 缺失/0 → `storage-unbounded-read`；`--limit 999` → `storage-limit-exceeded`；'
    + '`--max-line-bytes 0`（夹取窗口本身越界）→ `storage-limit-exceeded`（否则会静默夹成空正文）；'
    + '超长 append → `storage-limit-exceeded`（报 bytes/limit）且**文件字节未变**',
  tail6.payload?.lines?.length === 5 && tail6.payload?.omitted === 36
  && tail6.payload?.counts?.lines_seen === 42 && tail6.payload?.counts?.lines_ok === 41
  && tail6.payload?.broken === 1 && tail6.payload?.counts?.broken_lines === 1
  && tail6.payload?.torn_tail === true && tail6.payload?.clipped === 1
  && tail6.payload?.counts?.clipped_lines === 1 && tail6.payload?.truncated === true
  && tail6.payload?.degraded === true && tail6.payload?.reason === 'log-torn-tail'
  && longLine !== undefined && longLine.clipped === true && utf8(longLine.text) <= 4096
  && tail6.payload?.lines?.length + tail6.payload?.omitted + tail6.payload?.broken
    === tail6.payload?.counts?.lines_seen
  && noLimit.payload?.code === 'storage-unbounded-read' && noLimit.payload?.reason === 'limit-missing'
  && zeroLimit.payload?.code === 'storage-unbounded-read' && zeroLimit.payload?.reason === 'limit-not-positive'
  && hugeLimit.payload?.code === 'storage-limit-exceeded' && hugeLimit.payload?.limit === 999
  && badClip.payload?.code === 'storage-limit-exceeded'
  && badClip.payload?.reason === 'max-line-bytes-out-of-range'
  && overAppend.payload?.code === 'storage-limit-exceeded'
  && overAppend.payload?.bytes === 5001 && overAppend.payload?.limit === 4096 && sizeAfter === 0
  && sizeBefore > 6000,
  `tail=${json({ lines: tail6.payload?.lines?.length, omitted: tail6.payload?.omitted,
    broken: tail6.payload?.broken, clipped: tail6.payload?.clipped,
    counts: tail6.payload?.counts, truncated: tail6.payload?.truncated,
    degraded: tail6.payload?.degraded, reason: tail6.payload?.reason })}；`
  + `超长行=${json({ bytes: longLine?.bytes, clipped: longLine?.clipped,
    clipped_bytes: longLine ? utf8(longLine.text) : null })}；`
  + `无 limit=${json({ code: noLimit.payload?.code, reason: noLimit.payload?.reason })}；`
  + `夹取窗口越界=${json({ code: badClip.payload?.code, reason: badClip.payload?.reason })}；`
  + `limit 0=${json({ code: zeroLimit.payload?.code, reason: zeroLimit.payload?.reason })}；`
  + `limit 999=${json({ code: hugeLimit.payload?.code })}；`
  + `超长 append=${json({ code: overAppend.payload?.code, bytes: overAppend.payload?.bytes,
    limit: overAppend.payload?.limit })}；over.log 字节=${sizeAfter}（写前 0）`)

  // ---------- 7. 反例④：host 模块零写面 ----------
  const NEEDLES = ['writeFileSync', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdirSync',
    'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'truncateSync', 'chmodSync',
    'symlinkSync', 'openSync', 'child_process', 'execSync', 'execFileSync', 'spawnSync', 'spawn(',
    'fork(', 'fetch(', 'node:http', 'node:https', 'node:net', 'node:dgram', 'worker_threads',
    'Date.now', 'new Date', 'setTimeout(', 'setInterval(', 'setImmediate(', 'Math.random',
    'process.env', 'ctx.events', 'events.on(', 'events.emit(', '.emit(', 'ctx.on(', 'ledger.append',
    'appendEvent', 'EventBus', 'require(']
  const PLANTED = 'const a = Date.now(); setInterval(() => {}, 1); fs.writeFileSync("x"); spawn("sh"); '
    + 'process.env.TOKEN; Math.random(); fetch("http://x"); events.on("y", () => {}); '
    + 'spawnSync("python3", ["tools/storage.py"])'
  const scanSource = (source) => NEEDLES.filter((needle) => source.includes(needle))
  const modHits = scanSource(modArtifact.source)
  const plantedHits = scanSource(PLANTED)
  const modImports = [...modArtifact.source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort()
  check('7 反例④（**host 模块零写面**）：静态扫描 `storage-view.mjs` 零写文件 / 零子进程 / 零网络 / '
    + '零随机 / 零墙钟 / 零定时器 / 零事件订阅 / 零账本调用，且**只 import（读 API + 配置构造器）**'
    + '（`node:fs` 与 `../lib/std-schema.mjs`）—— 宿主**不调 Python**、不自己遍历存储树；'
    + '扫描器**非空转**（合成坏源码命中 ≥5 处）',
  modHits.length === 0 && plantedHits.length >= 5 && modArtifact.source.length > 1000
  && json(modImports) === json(['../lib/std-schema.mjs', 'node:fs']),
  `模块命中=${json(modHits)}；import 白名单=${json(modImports)}；非空转对照命中 ${plantedHits.length} 处=`
  + `${json(plantedHits.slice(0, 8))}；模块字节=${modArtifact.bytes}`)

  // ---------- 8. 拒写事实三类 ----------
  const ledgerPath = join(UI_SHARED, 'contractor', 'ledger.jsonl')
  const userSpaceOther = join(USER_SPACE, 'zz-t277-other')
  const f1 = pyRun(['--root', ROOT_A, '--ledger', ledgerPath, 'open-append', '--ns', 'acme', '--rel',
    ledgerPath, '--text', BODY_SENTINEL])
  const f2 = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel', 'logs/ledger.jsonl',
    '--text', BODY_SENTINEL])
  const f3 = pyRun(['--root', ROOT_A, 'open-append', '--ns', 'acme', '--rel',
    join(UI_SHARED, 'supplier', 'ledger.jsonl'), '--text', BODY_SENTINEL])
  const f4 = pyRun(['--root', UI_SHARED, 'list-files', '--ns', 'contractor'])
  const f5 = pyRun(['--root', join(USER_SPACE, 'zz-t277-other'), 'list-files', '--ns', 'acme'])
  const f6 = pyRun(['--root', join(USER_SPACE, 'acme'), 'list-files', '--ns', 'beta'])
  const f7 = pyRun(['--root', ROOT_A, '--ledger', ledgerPath, 'snapshot', '--out',
    join(UI_SHARED, 'contractor', 'bogus.json')])
  const v8 = factVerdict()
  const DEFAULT_ROOT_AFTER = treeDigest(DEFAULT_ROOT_DIR)
  const factCodes = [f1, f2, f3, f4, f5, f6, f7].map((item) => item.payload?.code)
  const ledgerSentinel = scanTreeText(UI_SHARED, BODY_SENTINEL)
  // ---- 反向自证（**不空转**）：把事实区判据回退成搬迁前的**词法形态**（`user-space` 是符号链接 ⇒
  // `_inside(USER_SPACE, <realpath>)` 恒假的旧行为），写进 `tmp/` 下的**变体副本**（产品树不动）。
  // 副本放在 `tmp/` 顶层是**必须的**：实体的 `ROOT = Path(__file__).resolve().parents[1]` 要靠
  // 「父目录的父目录 = 仓库根」=> 只有这样 UI_SHARED / USER_SPACE 才与对照实体同一片事实区。
  // 回退后 f5/f6 必须**不再**返回 `storage-fact-path` ⇒ 证明这两条绿是真判出来的（不是"没跑到"）。
  const LEXICAL_FROM = '    for root in _zone_forms(zone):\n        for item in _zone_forms(target):\n'
  const LEXICAL_TO = '    for root in _zone_forms(zone)[:1]:\n        for item in _zone_forms(target)[:1]:\n'
  const entitySource = readFileSync(PY_PATH, 'utf8')
  const mutantAnchorUnique = entitySource.split(LEXICAL_FROM).length === 2
  const MUTANT = join(ROOT, 'tmp', `t277-storage-lexical-only-${process.pid}.py`)
  if (mutantAnchorUnique) {
    mkdirSync(join(ROOT, 'tmp'), { recursive: true })
    writeFileSync(MUTANT, entitySource.replace(LEXICAL_FROM, LEXICAL_TO))
  }
  const m5 = mutantAnchorUnique
    ? pyRunVariant(MUTANT, ['--root', join(USER_SPACE, 'zz-t277-other'), 'list-files', '--ns', 'acme'])
    : null
  const m6 = mutantAnchorUnique
    ? pyRunVariant(MUTANT, ['--root', join(USER_SPACE, 'acme'), 'list-files', '--ns', 'beta'])
    : null
  const mutantCodes = [m5, m6].map((item) => (item ? item.payload?.code : '<未跑>'))
  const mutantProbe = mutantAnchorUnique
    ? pyRunVariant(MUTANT, ['limits'])   // 探测副本真的从**仓库根**起算（否则"放行"会因为路径算错而不是判据失效）
    : null
  const mutantRootOk = String(mutantProbe?.payload?.user_space ?? '') === posix(USER_SPACE)
  if (mutantAnchorUnique) rmSync(MUTANT, { force: true })
  // 变体把事实区判据回退成词法形态 ⇒ f5/f6 必须被**放行**（码为空）⇒ 「七种构造全 storage-fact-path」必红。
  const mutantMustPass = mutantAnchorUnique && mutantRootOk && mutantCodes.every((code) => code === '')
  check('8 拒写事实三类：①`--ledger` 声明的路径（含当目标与当 snapshot 输出）②仓库内 '
    + '`tmp/ui-shared/<realm>/ledger.jsonl`（绝对构造 + 名字叫 `ledger.jsonl` 的相对构造）'
    + '③`user-space/` 里别人的 ns（root 指过去 / 或 root 是本 ns 却操作别人的 ns）'
    + '—— 七种构造全 `storage-fact-path` + next_action；'
    + '**且本用例自己触及的事实区目标（白名单）保持原样**（`--ledger` 指的那份账本与绝对路径'
    + '构造的那份账本**只增不改**、无本门哨兵；构造的 snapshot 输出目标与"别人的 ns"**必须不存在**）、'
    + '哨兵检索不到。**前提：事实区可能被无关写入者（运行中服务 / 定时任务）改动 ⇒ 本断言只覆盖'
    + '本用例触及的目标，全程快照对比**（不拿"整个事实区清单/字节不变"当判据，那是把无关写入者'
    + '算成本工具写的假红；白名单外的变化由第 19 条如实计数并打印）。'
    + '**反向自证（不空转）**：把 `_inside_zone` 的两层形态循环各回退成**只取词法形态**'
    + '（= `user-space` 为符号链接时的旧失效形态）写进 tmp 下的变体副本 ⇒ f5/f6 必须被放行'
    + '（代码为空）⇒ 本断言在那种形态下**必红**；对照实体（本仓 `tools/storage.py`）则一律拒。',
  factCodes.every((code) => code === 'storage-fact-path')
  && [f1, f2, f3, f4, f5, f6, f7].every((item) => String(item.payload?.next_action ?? '').length > 0)
  && v8.violations.length === 0 && ledgerSentinel.length === 0
  && !existsSync(join(UI_SHARED, 'contractor', 'bogus.json')) && !existsSync(userSpaceOther)
  && json(DEFAULT_ROOT_BEFORE) === json(DEFAULT_ROOT_AFTER)
  && mutantAnchorUnique && mutantMustPass,
  `七种构造码=${json(factCodes)}；白名单目标违规=${v8.violations.length} 条`
  + `${v8.violations.length ? `（${json(v8.violations)}）` : ''}；`
  + `白名单目标=${json([...WHITELIST.get(UI_SHARED), ...WHITELIST.get(USER_SPACE)])}；`
  + `哨兵命中=${json(ledgerSentinel)}；`
  + `bogus.json 存在=${existsSync(join(UI_SHARED, 'contractor', 'bogus.json'))}；`
  + `别人 ns 目录存在=${existsSync(userSpaceOther)}；`
  + `默认存储根指纹一致=${json(DEFAULT_ROOT_BEFORE) === json(DEFAULT_ROOT_AFTER)}；`
  + `反向自证：锚点唯一=${mutantAnchorUnique}、变体副本的根正确=${mutantRootOk}、`
  + `词法变体下的 f5/f6 码=${json(mutantCodes)}`
  + `（必须为空 ⇒ 对照下本断言必红；对照实体实测 rc=${m5 ? m5.status : '<未跑>'}/${m6 ? m6.status : '<未跑>'}）；`
  + `${v8.text}`)

  // ---------- 9. 快照 → 只读聚合正控（独立遍历对照） ----------
  pyRun(['--root', ROOT_C, 'open-append', '--ns', 'acme', '--rel', 'logs/a.log', '--text', '第一行'] )
  pyRun(['--root', ROOT_C, 'open-append', '--ns', 'acme', '--rel', 'logs/a.log', '--text', '第二行'])
  pyRun(['--root', ROOT_C, 'put', '--ns', 'acme', '--table', 'kv', '--key', 'a', '--value', '1'])
  pyRun(['--root', ROOT_C, 'put', '--ns', 'acme', '--table', 'kv', '--key', 'b', '--value', '2'])
  pyRun(['--root', ROOT_C, 'open-append', '--ns', 'beta', '--rel', 'logs/b.log', '--text', '乙方一行'])
  const snapOut = join(SCRATCH, 'snap', 'snapshot.json')
  const snapRun = pyRun(['--root', ROOT_C, 'snapshot', '--out', snapOut])
  const walkedC = walkStorage(ROOT_C)
  const walkedBytes = walkedC.reduce((sum, item) => sum + item.bytes, 0)
  const m9 = await mount({ snapshot: snapOut })
  const v9a = m9.handle.snapshot()
  const v9b = m9.handle.snapshot()
  const m9b = await mount({ snapshot: snapOut })
  const v9c = m9b.handle.snapshot()
  check('9 快照 → 只读聚合正控（真跑）：`snapshot --out` 写出快照 → storage-view 读它，'
    + '`counts`（租户/文件/字节/表/键）与本门**独立遍历**树的手算一致、`degraded:false`；'
    + '两次 `snapshot()` 字节一致、跨实例一致；租户按名字稳定排序',
  snapRun.payload?.ok === true && existsSync(snapOut) && snapRun.payload?.out_bytes > 0
  && v9a.degraded === false && v9a.counts.tenants === 2 && v9a.counts.files === walkedC.length
  && v9a.counts.file_bytes === walkedBytes && v9a.counts.tables === 1 && v9a.counts.keys === 2
  && json(v9a.tenants.map((item) => item.ns)) === json(['acme', 'beta'])
  && json(v9a) === json(v9b) && json(v9a) === json(v9c)
  && v9a.tenants.every((item) => json(Object.keys(item).sort()) === json([...S.TENANT_KEYS].sort())),
  `快照=${json({ ok: snapRun.payload?.ok, out_bytes: snapRun.payload?.out_bytes,
    counts: snapRun.payload?.counts, degraded: snapRun.payload?.degraded })}；`
  + `独立遍历=${json({ files: walkedC.length, bytes: walkedBytes })}；`
  + `视图 counts=${json(v9a.counts)}；租户=${json(v9a.tenants)}；两次一致=${json(v9a) === json(v9b)}；`
  + `跨实例一致=${json(v9a) === json(v9c)}`)

  // ---------- 10. 按键白名单投影（负控） ----------
  const tainted = {
    generated_at: '',
    limits: { max_line_bytes: 4096, max_tables: 32, evil: SECRET },
    root: PATH_SENTINEL,
    tenants: [
      { ...tenant('alpha', 3), ns: 'alpha' },
      { ...tenant('bad/../ns', 1), ns: 'bad/../ns' },
      { ...tenant('gamma', 1), ns: 'gamma', files: '3', file_bytes: -1, tables: null, keys: 2.5,
        last_write: 'nope', secret: SECRET },
      'not-an-object',
    ],
    credentials: { token: SECRET },
  }
  const m10 = await mount({ snapshot: 'x' })
  const v10 = m10.handle.snapshot(tainted)
  const v10text = json(v10)
  const alphaTenant = v10.tenants.find((item) => item.ns === 'alpha')
  const gammaTenant = v10.tenants.find((item) => item.ns === 'gamma')
  check('10 按键白名单投影（负控）：快照里塞满正文 / 路径原文 / 凭据与额外键 → 输出里'
    + '**一个都不出现**；租户键集**恰好**六格、顶层键集**恰好**固定表；畸形租户（非法 ns / 非对象）'
    + '被丢并**计数** `invalid_tenants`；数字类型不对归 0 并计入 `clipped`（不静默改值）',
  json(v10.tenants.map((item) => item.ns)) === json(['alpha', 'gamma'])
  && v10.counts.invalid_tenants === 2 && v10.counts.tenants === 2
  && json(Object.keys(v10).sort()) === json([...S.OUTPUT_KEYS].sort())
  && json(Object.keys(alphaTenant).sort()) === json([...S.TENANT_KEYS].sort())
  && gammaTenant.files === 0 && gammaTenant.file_bytes === 0 && gammaTenant.tables === 0
  && gammaTenant.keys === 0 && gammaTenant.last_write === '' && v10.clipped >= 4
  && !v10text.includes(SECRET) && !v10text.includes(BODY_SENTINEL) && !v10text.includes(PATH_SENTINEL)
  && !v10text.includes('file_samples') && !v10text.includes('credentials')
  && json(Object.keys(v10.limits).sort()).includes('max_line_bytes')
  && !('evil' in v10.limits) && !('root' in v10),
  `租户=${json(v10.tenants.map((item) => item.ns))}（丢 ${v10.counts.invalid_tenants} 条）；`
  + `顶层键=${json(Object.keys(v10).sort())}；gamma=${json(gammaTenant)}；clipped=${v10.clipped}；`
  + `凭据哨兵出现=${v10text.includes(SECRET)}；正文哨兵=${v10text.includes(BODY_SENTINEL)}；`
  + `路径哨兵=${v10text.includes(PATH_SENTINEL)}；limits=${json(v10.limits)}`)

  // ---------- 11. 有界与截断诚实 ----------
  const twelve = { tenants: Array.from({ length: 12 }, (_, index) => tenant(`t${String(index).padStart(2, '0')}`, index)) }
  const m11 = await mount({ max_tenants: 4 })
  const v11 = m11.handle.snapshot(twelve)
  const m11b = await mount({ max_tenants: 0 })
  const v11b = m11b.handle.snapshot(twelve)
  const m11c = await mount({ max_bytes: 8 })
  const v11c = m11c.handle.snapshot({ tenants: [tenant('long-long-long-long-ns', 1)] })
  const expectedFiles = twelve.tenants.reduce((sum, item) => sum + item.files, 0)
  check('11 有界与截断诚实：12 租户 + `max_tenants=4` → 出 4、`omitted_tenants=8`、`truncated:true`，'
    + '而 `counts.tenants`/`counts.files` 仍是**夹取前真值**（`tenants.length + omitted === counts.tenants`）；'
    + '`max_tenants=0` → 一条都不出但计数值不变；字符串超 `max_bytes` 被夹并计入 `clipped`',
  v11.tenants.length === 4 && v11.omitted_tenants === 8 && v11.truncated === true
  && v11.counts.tenants === 12 && v11.counts.files === expectedFiles
  && v11.tenants.length + v11.omitted_tenants === v11.counts.tenants
  && v11b.tenants.length === 0 && v11b.omitted_tenants === 12 && v11b.counts.tenants === 12
  && v11c.tenants.length === 1 && v11c.clipped >= 1 && v11c.truncated === true
  && utf8(v11c.tenants[0].ns) <= 8 && utf8(v11c.tenants[0].last_write) <= 8,
  `max_tenants=4：${json({ shown: v11.tenants.length, omitted: v11.omitted_tenants,
    counts: v11.counts, truncated: v11.truncated })}（手算 files=${expectedFiles}）；`
  + `max_tenants=0：${json({ shown: v11b.tenants.length, omitted: v11b.omitted_tenants,
    counts_tenants: v11b.counts.tenants })}；`
  + `max_bytes=8：${json({ ns: v11c.tenants[0]?.ns, last_write: v11c.tenants[0]?.last_write,
    clipped: v11c.clipped, ns_bytes: utf8(v11c.tenants[0]?.ns ?? '') })}`)

  // ---------- 12. 降级与"空 ≠ 读不到" ----------
  const badJson = join(SCRATCH, 'bad.json')
  const nonObject = join(SCRATCH, 'nonobj.json')
  const emptyJson = join(SCRATCH, 'empty.json')
  writeFileSync(badJson, '{ 这不是 JSON', 'utf8')
  writeFileSync(nonObject, '[1,2,3]', 'utf8')
  writeFileSync(emptyJson, json({ tenants: [], limits: {} }), 'utf8')
  const m12a = await mount({})
  const m12b = await mount({ snapshot: join(SCRATCH, 'nope.json') })
  const m12c = await mount({ snapshot: badJson })
  const m12d = await mount({ snapshot: nonObject })
  const m12e = await mount({ snapshot: emptyJson })
  const m12f = await mount({ snapshot: 'x' })
  const unconfigured = m12a.handle.snapshot()
  const missing = m12b.handle.snapshot()
  const malformed = m12c.handle.snapshot()
  const nonObj = m12d.handle.snapshot()
  const noTenants = m12e.handle.snapshot()
  const injectedBad = m12f.handle.snapshot({ nope: 1 })
  const shapes = [unconfigured, missing, malformed, nonObj, noTenants, injectedBad]
    .map((item) => json(Object.keys(item).sort()))
  check('12 降级与"空 ≠ 读不到"：未配 / 路径不存在 / 坏 JSON / 顶层不是对象 / 注入源没 tenants →'
    + '`degraded:true` + 有名 reason + next_action；合法的**零租户** → `degraded:false` 且'
    + '`reason=\'storage-empty\'`（"确实没有"与"读不到"可区分）；六种情形**同形状**（键集合一致）、'
    + '且都不带任何"健康绿"字段',
  unconfigured.degraded === true && unconfigured.reason === 'storage-snapshot-unconfigured'
  && missing.degraded === true && missing.reason === 'storage-snapshot-unreadable'
  && malformed.degraded === true && malformed.reason === 'storage-snapshot-malformed'
  && nonObj.degraded === true && nonObj.reason === 'storage-snapshot-malformed'
  && injectedBad.degraded === true && injectedBad.reason === 'storage-snapshot-malformed'
  && [unconfigured, missing, malformed, nonObj, injectedBad]
    .every((item) => String(item.next_action).length > 0 && S.DEGRADED_REASONS.includes(item.reason))
  && noTenants.degraded === false && noTenants.reason === 'storage-empty'
  && noTenants.tenants.length === 0 && noTenants.counts.tenants === 0
  && new Set(shapes).size === 1
  && json(Object.keys(noTenants).sort()) === json([...S.OUTPUT_KEYS].sort())
  && [...S.DEGRADED_REASONS].every((reason) => typeof reason === 'string'),
  `未配=${json({ degraded: unconfigured.degraded, reason: unconfigured.reason })}；`
  + `路径不存在=${missing.reason}；坏 JSON=${malformed.reason}；非对象=${nonObj.reason}；`
  + `注入源无 tenants=${injectedBad.reason}；零租户=${json({ degraded: noTenants.degraded,
    reason: noTenants.reason, tenants: noTenants.tenants.length })}；同形状=${new Set(shapes).size === 1}；`
  + `键集=${shapes[0]}`)

  // ---------- 13. 租户范围（scope） ----------
  const scopedProto = { ...tainted, tenants: tainted.tenants }
  const scoped = m10.handle.snapshot({ ...scopedProto, ns: 'alpha' })
  const diskScoped = m9.handle.snapshot({ ns: 'beta' })
  const scopedEmpty = m10.handle.snapshot({ ...scopedProto, ns: 'delta' })
  const scopedBad = m10.handle.snapshot({ ...scopedProto, ns: '../alpha' })
  check('13 租户范围：`{ns}` 只出本租户（**别的租户的名字一个字都不出现**），而 `counts` 仍是'
    + '**全体真值** + `omitted_tenants` 报出被挡掉多少；范围指到不存在的 ns → `storage-scope-empty`'
    + '（**不是**降级）；范围形状非法 → `degraded:true` + `storage-scope-invalid`；磁盘模式也吃 scope',
  scoped.tenants.length === 1 && scoped.tenants[0].ns === 'alpha'
  && scoped.counts.tenants === 2 && scoped.omitted_tenants === 1 && scoped.truncated === true
  && !json(scoped).includes('gamma') && !json(scoped).includes(BODY_SENTINEL)
  && diskScoped.tenants.length === 1 && diskScoped.tenants[0].ns === 'beta'
  && diskScoped.counts.tenants === 2 && diskScoped.degraded === false
  && scopedEmpty.tenants.length === 0 && scopedEmpty.degraded === false
  && scopedEmpty.reason === 'storage-scope-empty' && scopedEmpty.counts.tenants === 2
  && scopedBad.degraded === true && scopedBad.reason === 'storage-scope-invalid'
  && String(scopedBad.next_action).length > 0 && scopedBad.tenants.length === 0,
  `scope=alpha：${json({ tenants: scoped.tenants.map((item) => item.ns), counts: scoped.counts,
    omitted: scoped.omitted_tenants, truncated: scoped.truncated })}；`
  + `别的租户名泄漏=${json(scoped).includes('gamma')}；磁盘 scope=beta：${json({
    tenants: diskScoped.tenants.map((item) => item.ns), degraded: diskScoped.degraded })}；`
  + `scope 不存在=${json({ reason: scopedEmpty.reason, degraded: scopedEmpty.degraded })}；`
  + `scope 非法=${json({ reason: scopedBad.reason, degraded: scopedBad.degraded })}`)

  // ---------- 14. 确定性 ----------
  const detPayload = { ...tainted }
  const snapshotPayload = json(detPayload)
  const detOnce = json(m10.handle.snapshot(detPayload))
  const detTwice = json(m10.handle.snapshot(detPayload))
  const detReverse = json(m10.handle.snapshot({ ...tainted, tenants: [...tainted.tenants].reverse() }))
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) deepFreeze(item)
      Object.freeze(value)
    }
    return value
  }
  let frozenOk = true
  try {
    deepFreeze(JSON.parse(json(tainted)))
    m10.handle.snapshot(JSON.parse(json(tainted)))
  } catch {
    frozenOk = false
  }
  const m14 = await mount({})
  const mirror = json(m14.handle.snapshot(tainted))
  const clockFree = !/Date|now|getTime|performance|Math\.random/.test(modArtifact.source
    .split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n'))
  check('14 确定性：同输入两次 `snapshot()` 字节一致、**租户顺序颠倒不改输出**、跨实例一致、'
    + '冻结输入不抛、入参不被改写；源码里**没有任何取墙钟/随机**的调用（注释不算，静态扫一遍代码行）',
  detOnce === detTwice && detTwice === detReverse && mirror === detOnce && frozenOk
  && json(detPayload) === snapshotPayload && detOnce.length > 100 && clockFree,
  `两次一致=${detOnce === detTwice}（${detOnce.length} 字节）；顺序颠倒一致=${detTwice === detReverse}；`
  + `跨实例一致=${mirror === detOnce}；冻结输入不抛=${frozenOk}；入参未被改写=${json(detPayload) === snapshotPayload}；`
  + `源码无墙钟/随机=${clockFree}`)

  // ---------- 15. 配置负控 ----------
  const refuses = (raw) => {
    try {
      S.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const defaults = S.Config.parse({})
  const m15a = await mount({ max_tenants: 1e9 })
  const m15b = await mount({ max_tenants: -5 })
  const m15c = await mount({ max_tenants: Number.NaN })
  const m15d = await mount({ max_bytes: 1e9 })
  const clamped = [m15a.handle.config().max_tenants, m15b.handle.config().max_tenants,
    m15c.handle.config().max_tenants, m15d.handle.config().max_bytes]
  check('15 配置负控：未知键 / 错类型 / 非对象入参一律被拒（不得静默放行）；默认值 '
    + 'snapshot=\'\' / max_tenants=64 / max_bytes=128；越界夹取（1e9→上限、-5→0、NaN→默认）',
  refuses({ typo: 1 }) === 'refused' && refuses({ max_tenants: 'many' }) === 'refused'
  && refuses(42) === 'refused' && refuses([]) === 'refused'
  && defaults.snapshot === '' && defaults.max_tenants === 64 && defaults.max_bytes === 128
  && json(clamped) === json([1000, 0, 64, 4096]),
  `未知键=${refuses({ typo: 1 })}；错类型=${refuses({ max_tenants: 'many' })}；`
  + `非对象=${refuses(42)}/${refuses([])}；默认=${json(defaults)}；夹取=${json(clamped)}`)

  // ---------- 16. 卸载零残留 ----------
  const effectsBefore = MOUNTS.map(([, instance]) => instance.fiber.getEffects().length)
  for (const [, instance] of MOUNTS) await instance.fiber.dispose()
  const effectsAfter = MOUNTS.map(([, instance]) => instance.fiber.getEffects().length)
  const afterDispose = base.handle.snapshot()
  let headlineThrew = false
  try {
    base.handle.headline()
  } catch {
    headlineThrew = true
  }
  const contextGone = MOUNTS.every(([, instance]) => instance.ctx.get('storageView') === undefined)
  check('16 卸载零残留：全部实例 dispose 后 `ctx.get` 取不到、effect 归零，且**新动作一律拒**'
    + '（`storage-view-disposed` + next_action）且不抛（拒绝不伪装成功）',
  effectsBefore.every((count) => count > 0) && effectsAfter.every((count) => count === 0)
  && contextGone && afterDispose.degraded === true && afterDispose.reason === 'storage-view-disposed'
  && String(afterDispose.next_action).length > 0 && headlineThrew === false,
  `effect ${json(effectsBefore)} → ${json(effectsAfter)}；ctx.get 全消失=${contextGone}；`
  + `dispose 后=${json({ degraded: afterDispose.degraded, reason: afterDispose.reason })}；`
  + `headline 抛错=${headlineThrew}`)

  // ---------- 17. Python 侧可用性不伪装 ----------
  const notADir = join(SCRATCH, 'not-a-dir')
  writeFileSync(notADir, 'x', 'utf8')
  const u1 = pyRun(['--root', '', 'list-files', '--ns', 'acme'])
  const u2 = pyRun(['--root', notADir, 'list-files', '--ns', 'acme'])
  const absent = pyRun(['--root', ROOT_A, 'stat', '--ns', 'acme', '--rel', 'logs/never.log'])
  const absentKey = pyRun(['--root', ROOT_A, 'get', '--ns', 'acme', '--table', 'kv', '--key', 'never'])
  check('17 Python 侧可用性不伪装：未配 root / root 不是目录 → `storage-unavailable` + 有名 reason'
    + ' + next_action（**不得**用"看起来健康的空"冒充可用）；"确实没有"（空租户 / 没这个键 / 路径缺席）'
    + '→ `ok:true` + 有名 reason —— 两种情形必须可区分；且默认存储根没被碰过',
  u1.payload?.code === 'storage-unavailable' && u1.payload?.reason === 'root-unconfigured'
  && u2.payload?.code === 'storage-unavailable' && u2.payload?.reason === 'root-not-a-directory'
  && [u1, u2].every((item) => String(item.payload?.next_action ?? '').length > 0)
  && absent.payload?.ok === true && absent.payload?.exists === false
  && absent.payload?.reason === 'path-absent'
  && absentKey.payload?.ok === true && absentKey.payload?.found === false
  && absentKey.payload?.reason === 'key-not-found'
  && r3.empty.payload?.reason === 'namespace-empty'
  && json(DEFAULT_ROOT_BEFORE) === json(treeDigest(DEFAULT_ROOT_DIR)),
  `未配=${json({ code: u1.payload?.code, reason: u1.payload?.reason })}；`
  + `不是目录=${json({ code: u2.payload?.code, reason: u2.payload?.reason })}；`
  + `路径缺席=${json({ ok: absent.payload?.ok, exists: absent.payload?.exists,
    reason: absent.payload?.reason })}；`
  + `键缺席=${json({ ok: absentKey.payload?.ok, found: absentKey.payload?.found,
    reason: absentKey.payload?.reason })}；空租户=${json({ ok: r3.empty.payload?.ok,
    reason: r3.empty.payload?.reason })}；默认存储根未变=${json(DEFAULT_ROOT_BEFORE)
    === json(treeDigest(DEFAULT_ROOT_DIR))}`)

  // ---------- 18. 拒绝留痕汇总 ----------
  const codesSeen = [...new Set(REFUSALS.map((item) => item.code))]
  const unknown = codesSeen.filter((code) => !CODES.includes(code))
  const missingAction = REFUSALS.filter((item) => String(item.next_action ?? '').length === 0)
  check('18 拒绝留痕汇总：整轮跑下来的**每一条**拒绝（本门真跑出来的，不是声明）都在闭合码集合里，'
    + '且都带非空 `next_action`；四类反例各自的码都在其中（①跨租户 ②越界 ③无界/超界读 ④事实路径）',
  REFUSALS.length >= 10 && unknown.length === 0 && missingAction.length === 0
  && ['storage-outside-ns', 'storage-path-escape', 'storage-unbounded-read', 'storage-limit-exceeded',
    'storage-fact-path', 'storage-unavailable'].every((code) => codesSeen.includes(code)),
  `本轮拒绝 ${REFUSALS.length} 次；码集合=${json(codesSeen)}；越界码=${json(unknown)}；`
  + `缺 next_action=${missingAction.length} 条；`
  + `模块树未变=${json(MODULE_TREE_BEFORE) === json(treeDigest(join(HERE, 'modules')))}`)

  // ---------- 19. 全局层：事实区零写入（白名单口径） ----------
  const v19 = factVerdict()
  const ledgerSentinel19 = scanTreeText(UI_SHARED, BODY_SENTINEL)
  const userSpaceSentinel19 = scanTreeText(USER_SPACE, BODY_SENTINEL)
  const uiFiles19 = walkStorage(UI_SHARED).length
  const userFiles19 = walkStorage(USER_SPACE).length
  check('19 全局层（**事实区零写入**，白名单口径）：本用例运行期间**没有任何写入落到事实区** —— '
    + '白名单内（本用例触及的目标：`--ledger` 指的那份账本、绝对构造的那份账本、构造的 snapshot '
    + '输出目标、"别人的 ns"）逐字节不变 / 账本类只增不改 + 无本门哨兵；**白名单外的变化不判红，'
    + '但如实计数并打印**（无关写入者：运行中服务 / 定时任务）。**前提：事实区可能被无关写入者改动 '
    + '⇒ 本判据只覆盖本用例触及的目标，全程快照对比**（改写/截断/凭空出现/消失/哨兵 都必须变红）；'
    + '判据**非空转自证**：8 组合成样本（追加/改写/截断/哨兵/改写非账本/无变化/凭空出现/消失）'
    + '逐条核对期望的红绿',
  v19.violations.length === 0 && selfTestBad.length === 0
  && ledgerSentinel19.length === 0 && userSpaceSentinel19.length === 0,
  `白名单目标违规=${v19.violations.length} 条`
  + `${v19.violations.length ? `（${json(v19.violations)}）` : ''}；`
  + `事实区哨兵命中=${json([...ledgerSentinel19, ...userSpaceSentinel19])}；`
  + `${v19.text}；非空转自证=${SELF_TEST_DETAIL}`
  + `${selfTestBad.length ? `（偏差 ${json(selfTestBad.map(([label]) => label))}）` : ''}；`
  + `全程对比的树规模=tmp/ui-shared ${uiFiles19} 个文件 / user-space ${userFiles19} 个文件`)

  // 收尾：被围的模块树必须零变化（门上变异模式会写回来，这里确认"跑完是干净的"）
  const moduleTreeAfter = treeDigest(join(HERE, 'modules'))
  if (json(moduleTreeAfter) !== json(MODULE_TREE_BEFORE)) {
    check('20 门跑完模块树零变化（防"忘了还原"）', false,
      `模块树指纹变了：before=${MODULE_TREE_BEFORE.length}项 after=${moduleTreeAfter.length}项`)
  }
} catch (error) {
  check('门执行异常（不得静默通过）', false, `${error.name}: ${String(error.message).slice(0, 240)}`)
} finally {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch { /* 临时目录删不掉不影响判定 */ }
}

finish()
