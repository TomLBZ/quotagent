/**
 * t260-pipeline-gate —— T-260「P2 三域流水线只读运维视图」候选产物 `pipeline-view` 的**围栏门**
 * （宿主侧人工维护，不由被围对象自己写；ADR-0016 / D-036）。契约见 `docs/design/20-pipeline-snapshot-contract.md` §2/§3，
 * 本门覆盖 §4 ①（宿主插件围栏门）。
 *
 * 被围对象：`pipeline-view`（tmp 阶段是 `./../tmp/t260-pipeline-view.mjs`，晋升后是 `./modules/pipeline-view.mjs`）。
 * 两阶段都能跑：先试进树产物，再回退到候选源码；**实际加载到的绝对路径、字节数与 sha256 写进第 1 条断言的 detail**
 * （变异自证就是靠这一行确认「红的是我改的那一份」，而不是"看着红"）。
 *
 * 已知坑（必须处理，否则直接 ERR_MODULE_NOT_FOUND）：候选按契约 `import ... from '../lib/std-schema.mjs'`，
 * 而从 `tmp/` 看 `../lib` = **仓库根**的 `lib/`，它并不存在（仓库根 `lib/` 是运行时产物目录，被 .gitignore 忽略）。
 * 这里照抄本仓既有做法（`tools/evolve-module.mjs` 的影子目录、`host/t247-idem-gate.mjs`、
 * `host/t254-retention-view-gate.mjs`）：在 gitignored 的 `tmp/t260-pipeline-gate-shadow/` 里把 `host/lib`
 * 软链过去、把候选**按字节复制**进去，再 import 影子里的那一份，并断言「复制前后字节一致」。
 * 影子只落在 `tmp/` 内，仓库里其它文件一个字不动。
 *
 * 断言（13 条 + 1 条空集合守卫；其中 7 条是**负控**；每条都写清「什么情况下必须变红」）：
 *   1 契约正控：manifest 齐备（name/provides=['pipelineView']/inject=[]/builtin/usedServices/Config/apply/fixture）
 *      + 只 import `../lib` 白名单 + 打印实际加载路径/字节数/sha256/影子副本字节一致
 *   2 挂载与 dispose：provide 拦截拿得到句柄（键恰好 headline/snapshot）；dispose 后 ctx.get 不存在、effect 归零
 *   3 手算正控：**两视角三域**的计数/合计/通道/最近事件逐字段等于手算表（不用实现验实现），且不转发绝对时刻
 *   4 只组合不自算正控：计数与明细故意不一致 → 照抄计数；快照**声明**的合计与视角之和故意不一致 → 照抄声明值
 *   5 通道三档正/负控：三档全 true 才 true；任一档 false → false + 第一处非空 reason；声明畸形 → malformed
 *   6 降级负控：20 种畸形输入（非对象/缺 views/空 views/视角非对象/缺域/计数类型错/负数/NaN/revs 非数组/
 *      revs 含非数字/transport 畸形/last 畸形/totals 畸形）→ **不抛**、degraded:true、全零同形状、reason 有名
 *   7 有界负控：max_views 夹取（视角夹取 + omitted_views 计数 + 合计仍含被夹掉的视角）；max_recent 夹取
 *      recent 与每视角 revs；max_bytes 夹取 headline（≤ 字节上限且是前缀；0 → 空串）
 *   8 确定性负控：两次字节一致、跨实例一致、**写入顺序颠倒不改输出**、冻结输入不抛、入参不被改写
 *   9 静态负控：候选源码零副作用（墙钟/定时器/文件读写/事件订阅/随机/环境变量/直接 import 运行时内建）
 *      + 扫描器**非空转**对照
 *  10 私域与正文负控：哨兵（键名与键值两路）+ `private:`/`body`/`subject`/`reserve_price`/`cost_model`/
 *      `signature` 一个都不出现在输出里，且被过滤处统一显示 (redacted)
 *  11 配置契约负控：未知键/错误类型/非对象入参一律被拒；默认值 4/3/512；越界夹取（1e9→64、-5→0、NaN→默认、5.7→5）
 *  12 headline 正控：手写期望串逐字一致 + 三域都在 + 字节 ≤ max_bytes
 *  13 真数据正控：另一主体产出的 Python 写入器在**真账本**上的真实快照 → 计数/合计/通道/最近事件等于手算表
 *     （D-040：门里喂真数据，不是手抄的形状）
 *  14 空集合守卫（一条都没跑 = 红）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0，否则 exit 1。
 * 用法：`node host/t260-pipeline-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
// `cordis` 是宿主私有的裸名依赖：搬迁后本文件不在 `host/` 下，改为按**显式解析**导入
// （见下方 `CORDIS_URL`；与搬迁前 Node 从 `host/node_modules` 上溯到的是同一份）。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const IN_TREE = join(HERE, 'modules', 'pipeline-view.mjs')            // 晋升后的位置
const FROM_TMP = join(ROOT, 'tmp', 't260-pipeline-view.mjs')          // ← './../tmp/t260-pipeline-view.mjs'
const SHADOW = join(ROOT, 'tmp', 't260-pipeline-gate-shadow')

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail: String(detail) }) }

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红的（「没跑到」不得当成「通过」，本仓已有教训）
  if (CHECKS.length === 0) check('13 空集合守卫：门至少跑了一条断言（反例：门只打印了 JSON 却没跑断言）', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures,
    total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * 被检查产物的**源码链**（跟到**真实体**）：`host/modules/<x>.mjs` 自搬迁（阶段 4.2/5）起可能是**薄重导**
 * ——实体在 `src/<层>/<插件>/code/<x>.mjs`，中间经 `host/lib/entity-<x>.mjs` 一跳。
 *
 * 为什么必须跟：① 按**源码文本**判的断言在 8 行的重导文件上会**静默判绿**（manifest / inject / 静态
 * 副作用扫描全都在实体里）；② 只读第一跳会把正常的**链目标** `../lib/entity-<x>.mjs` 误判成「越界 import」。
 *
 * 口径**收紧而非放宽**：只有**纯重导**（除注释外恰好一行 `export * from '<spec>'`）才算一跳；某一跳的
 * `<spec>` 是**链的结构**，只在该跳文件里豁免（实体自己写的任何 spec 照原白名单逐字判）。整条链的文本
 * 一起纳入扫描 ⇒ 实体藏在一跳之后也逃不掉；某一跳若**不纯**，跟链立刻停在那一跳（它自己的 spec 就按普通 import 判）。
 */
const RE_EXPORT_LINE = /^\s*export \* from '([^']+)'\s*$/
const reExportTarget = (text) => {
  const lines = text.split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
  if (lines.length !== 1) return null          // 除注释外还有别的语句 ⇒ **不是**一跳（不跟）
  const match = lines[0].match(RE_EXPORT_LINE)
  return match ? match[1] : null
}
const moduleChain = (entry) => {
  const files = [entry]
  const links = []
  const seen = new Set([entry])
  let current = entry
  let text = readFileSync(current, 'utf8')
  for (let hop = 0; hop < 8; hop += 1) {
    const spec = reExportTarget(text)          // `null` ⇒ 到底了（这一跳不是纯重导）
    if (spec === null) break
    const next = resolve(dirname(current), spec)
    if (seen.has(next) || !existsSync(next)) break
    links.push(spec)          // 只有**纯重导**的一跳才把目标记为链结构（实体自己写的同一个 spec 不算）
    seen.add(next)
    current = next
    text = readFileSync(current, 'utf8')
    files.push(current)
  }
  return {
    files, links, entity: current,
    text: files.map((file) => readFileSync(file, 'utf8')).join('\n'),
    per_file: files.map((file, index) => ({
      file,
      specs: [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]),
      link: links[index] ?? null,
    })),
  }
}
/** 链的人可读写法（仓库根相对），只用于 detail 打印。 */
const chainLabel = (files) => files.map((file) => file.replace(`${join(HERE, '..')}/`, '')).join(' → ')

/** 定位并加载产物：晋升前从 tmp/（经影子目录），晋升后直接是同目录的 modules/。 */
const loadArtifact = async () => {
  if (existsSync(IN_TREE)) {
    const chain = moduleChain(IN_TREE)          // 跟重导链读到**真实体**（`source` = 整条链的文本）
    return { mod: await import(pathToFileURL(IN_TREE).href), source: chain.text, chain,
      path: IN_TREE, copied: null }
  }
  if (!existsSync(FROM_TMP)) return null
  mkdirSync(join(SHADOW, 'modules'), { recursive: true })
  const libLink = join(SHADOW, 'lib')
  if (!existsSync(libLink)) symlinkSync(join(ROOT, 'host', 'lib'), libLink, 'dir')
  const copyPath = join(SHADOW, 'modules', 'pipeline-view.mjs')
  copyFileSync(FROM_TMP, copyPath)
  const source = readFileSync(FROM_TMP, 'utf8')
  const copied = readFileSync(copyPath, 'utf8') === source
  const chain = moduleChain(copyPath)           // 同一条口径：影子副本也跟链
  return { mod: await import(pathToFileURL(copyPath).href), source: chain.text, chain, path: FROM_TMP, copied, copyPath }
}

/** 挂载：照抄产物声明的 `inject`（写成 [] 会让它取不到依赖），并包装 `provide` 抓句柄。 */
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

const shapeOf = (obj) => Object.keys(obj).sort().join('|')

// ---------------------------------------------------------------------------
// 探针数据。手算表全部**先写死**（不用实现算出来的值来验实现）。
// ---------------------------------------------------------------------------

/** 真形状快照（§2 的键名与域内字段；两个视角、三域齐全）。 */
const SNAPSHOT = {
  generated_at: '2026-09-21T12:02:00Z',
  totals: { threads: 5, rounds: 7, rejected: 3, entries: 3, queued: 2, refused: 1 },
  views: {
    contractor: {
      negotiate: { threads: 3, open: 1, closed: 2, rounds: 4, rejected: 2,
        last: { thread_id: 'nt-0001', kind: 'round', attempt_no: 2 } },
      faq: { entries: 2, revs: [1, 2], last: { entry_id: 'fq-0001', rfq_rev: 2 } },
      mail: { queued: 1, refused: 1,
        transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' } },
    },
    supplier: {
      negotiate: { threads: 2, open: 1, closed: 1, rounds: 3, rejected: 1,
        last: { thread_id: 'nt-0002', kind: 'round-rejected', attempt_no: 3 } },
      faq: { entries: 1, revs: [3], last: { entry_id: 'fq-0002', rfq_rev: 3 } },
      mail: { queued: 1, refused: 0,
        transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' } },
    },
  },
}
/** 手算表（照 SNAPSHOT 逐字段数出来；视角顺序＝视角名排序 → contractor 在前）。 */
const HAND_VIEWS = [
  { view: 'contractor', negotiate: { threads: 3, open: 1, closed: 2, rounds: 4, rejected: 2 },
    faq: { entries: 2, revs: [1, 2] },
    mail: { queued: 1, refused: 1, transport_available: false, transport_reason: 'mail-transport-unavailable' } },
  { view: 'supplier', negotiate: { threads: 2, open: 1, closed: 1, rounds: 3, rejected: 1 },
    faq: { entries: 1, revs: [3] },
    mail: { queued: 1, refused: 0, transport_available: false, transport_reason: 'mail-transport-unavailable' } },
]
const HAND_TOTALS = { threads: 5, rounds: 7, rejected: 3, entries: 3, queued: 2, refused: 1 }
/** 最近事件：视角名序 → 每视角 negotiate 在前、faq 在后；max_recent=3 → 4 取 3，夹掉 1。 */
const HAND_RECENT = [
  { view: 'contractor', domain: 'negotiate', ref: 'nt-0001', kind: 'round', seq: 2 },
  { view: 'contractor', domain: 'faq', ref: 'fq-0001', kind: '', seq: 2 },
  { view: 'supplier', domain: 'negotiate', ref: 'nt-0002', kind: 'round-rejected', seq: 3 },
]
const HAND_OMITTED_RECENT = 1
const HAND_TRANSPORT = { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' }
const HAND_HEADLINE = '管道 · contractor: 谈判 3线程/4轮/拒 2 · FAQ 2条 · 邮件 排队 1/拒 1'
  + ' | supplier: 谈判 2线程/3轮/拒 1 · FAQ 1条 · 邮件 排队 1/拒 0 · 通道不可用(mail-transport-unavailable)'

const mailFalse = () => ({ available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' })
const mailTrue = () => ({ available: true })

/** 只组合不自算探针：**计数与明细故意不一致**，且**声明的合计 ≠ 视角之和**。
 *  手算：视角 threads 相加 = 40（但声明 99）；rejected 视角 7（但声明 0）；entries 9 只配 1 个修订号。
 *  重算的实现会把这些改成 40/7/… → 本条变红。 */
const MISMATCH = {
  generated_at: '2026-09-21T12:02:00Z',
  totals: { threads: 99, rounds: 1, rejected: 0, entries: 0, queued: 0, refused: 0 },
  views: {
    contractor: {
      negotiate: { threads: 40, open: 0, closed: 0, rounds: 1, rejected: 7, last: null },
      faq: { entries: 9, revs: [4], last: null },
      mail: { queued: 7, refused: 0, transport: mailFalse() },
      body: '这条是正文（不该被读，也不该出现）',
    },
  },
}
const HAND_MISMATCH_TOTALS = { threads: 99, rounds: 1, rejected: 0, entries: 0, queued: 0, refused: 0 }

/** 快照**没给**合计 → 只做跨视角相加，并在 `totals_source` 明示 `summed`。 */
const NO_TOTALS = {
  views: {
    contractor: { negotiate: { threads: 3, open: 1, closed: 2, rounds: 4, rejected: 2, last: null },
      faq: { entries: 2, revs: [], last: null }, mail: { queued: 1, refused: 1, transport: mailFalse() } },
    supplier: { negotiate: { threads: 2, open: 1, closed: 1, rounds: 3, rejected: 1, last: null },
      faq: { entries: 1, revs: [], last: null }, mail: { queued: 1, refused: 0, transport: mailFalse() } },
  },
}

/** 通道三档探针。 */
const transportPayload = (contractor, supplier, top) => ({
  ...(top === undefined ? {} : { transport: top }),
  views: {
    contractor: { negotiate: { threads: 0, open: 0, closed: 0, rounds: 0, rejected: 0, last: null },
      faq: { entries: 0, revs: [], last: null }, mail: { queued: 0, refused: 0, transport: contractor } },
    supplier: { negotiate: { threads: 0, open: 0, closed: 0, rounds: 0, rejected: 0, last: null },
      faq: { entries: 0, revs: [], last: null }, mail: { queued: 0, refused: 0, transport: supplier } },
  },
})
const ALL_TRUE = transportPayload(mailTrue(), mailTrue(), mailTrue())
const MIXED = transportPayload(mailTrue(), mailFalse(), mailTrue())          // 一档说 false → 必须 false
const TOP_DISSENT = transportPayload(mailTrue(), mailTrue(), mailFalse())    // 顶层说 false → 必须 false
const MALFORMED_DECL = transportPayload(mailTrue(), mailTrue(), { available: 'false' })
const UNDECLARED = {
  views: {
    contractor: { negotiate: { threads: 0, open: 0, closed: 0, rounds: 0, rejected: 0, last: null },
      faq: { entries: 0, revs: [], last: null }, mail: { queued: 0, refused: 0 } },
  },
}

/** 有界探针：五个视角（**写入顺序刻意与视角名顺序相反**）、每视角 2 个修订号、negotiate/faq 各一条最近事件。 */
const BOUND_NAMES = ['contractor', 'exchange', 'ops', 'relay', 'supplier']
const BOUND_PAYLOAD = { views: {} }
for (const name of [...BOUND_NAMES].reverse()) {
  BOUND_PAYLOAD.views[name] = {
    negotiate: { threads: 1, open: 0, closed: 1, rounds: 1, rejected: 0,
      last: { thread_id: `nt-${name}`, kind: 'round', attempt_no: 1 } },
    faq: { entries: 1, revs: [1, 2], last: { entry_id: `fq-${name}`, rfq_rev: 1 } },
    mail: { queued: 1, refused: 0, transport: mailTrue() },
  }
}
/** 手算（max_views=2 / max_recent=1）：展示前两条（视角名序）contractor、exchange；
 *  omitted_views=3；合计**含被夹掉的视角**（5×1）；recent 10 条取 1 夹 9；
 *  每视角 revs `[1,2]` 取尾 1（`[2]`）夹 1 —— 但 revs 只出现在**展示出来的**视角里，故 2×1=2；
 *  → omitted_recent = 9 + 2 = 11。 */
const HAND_BOUND = { omitted_views: 3, omitted_recent: 11,
  totals: { threads: 5, rounds: 5, rejected: 0, entries: 5, queued: 5, refused: 0 },
  shown: ['contractor', 'exchange'], first_recent: 'nt-contractor' }

// ---------------------------------------------------------------------------
// 真数据（**另一主体产出的 Python 写入器 `tools/refresh-ui-snapshots.py` 在真账本上的真实输出**，
// 不是手抄的形状；D-040「门里必须喂真数据」）。标记区内是逐字段原样的 JSON（键已排序，便于逐字节比对）。
//
// 生成方式（写入器只读账本；账本是我用真内核 API 写的 scratch，判定的重建交给三个服务的 replay）：
//   PYTHONPATH=src python3 - <<'PY'
//   from quotagent.kernel.events import EventBus
//   from quotagent.kernel.ledger import Ledger
//   ledger = Ledger(SCRATCH / "ui.jsonl", realm="contractor:con-B")
//   for kind, body in [("negotiate/opened", {"thread_id": "nt-0001", "package_id": "pkg-014", "rfq_rev": 2}),
//                      ("negotiate/round", {"thread_id": "nt-0001", "attempt_no": 1, "round_key": "neg:sha256:aa"}),
//                      ("negotiate/round-rejected", {"thread_id": "nt-0001", "attempt_no": 2,
//                        "code": "concession-below-floor", "reason": "低于底线", "next_action": "重算底线",
//                        "subject": "ZZ-SENTINEL-PRIVATE-ZZ"}),
//                      ("negotiate/closed", {"thread_id": "nt-0001", "outcome": "accepted", "body": "ZZ-SENTINEL-PRIVATE-ZZ"}),
//                      ("faq/entry-published", {"entry_id": "fq-0001", "package_id": "pkg-014", "rfq_rev": 2,
//                        "question_norm": "sha256:bb", "reserve_price": "ZZ-SENTINEL-PRIVATE-ZZ"}),
//                      ("mail/queued", {"message_id": "ml-0001", "kind": "rfq-notice", "package_id": "pkg-014",
//                        "rfq_rev": 2, "to": ["s@example.com"], "subject": "ZZ-SENTINEL-PRIVATE-ZZ"}),
//                      ("mail/refused", {"message_id": "ml-0001", "reason": "mail-transport-unavailable",
//                        "next_action": "配置凭据后接入", "transport_available": False})]:
//       ledger.append(kind, body, correlation_id="x", actor="agent:test")
//   PY
//   python3 tools/refresh-ui-snapshots.py --views contractor --shared-dir <SCRATCH>
//   → <SCRATCH>/pipeline.json
// 手算表（从上面那七条事件数出来；视角只有一个 —— 生产里默认是两个视角）：
//   谈判：threads 1（opened）、rounds 1（round）、rejected 1（round-rejected）、closed 1、open 0
//   FAQ：entries 1（entry-published）、revs [2]（rfq_rev=2）
//   邮件：queued 1、refused 1、transport.available=false + reason + next_action（本轮没有发信能力，只能这么报）
//   最近事件：negotiate.last={thread_id:nt-0001, kind:closed}（写入器不给 attempt_no → 序号 null，不补）
//            faq.last={entry_id:fq-0001, rfq_rev:2}
//   无 totals 段 → 合计只能跨视角相加（这里只有一个视角）= 上面六项
// ---------------------------------------------------------------------------
const REAL_SNAPSHOT = /* T260-REAL-FIXTURE-START */
{
 "generated_at": "2026-09-21T12:07:20Z",
 "views": {
  "contractor": {
   "faq": {
    "entries": 1,
    "last": { "entry_id": "fq-0001", "rfq_rev": 2 },
    "revs": [2]
   },
   "mail": {
    "queued": 1,
    "refused": 1,
    "transport": { "available": false, "next_action": "配置 SMTP/IMAP 凭据后接入", "reason": "mail-transport-unavailable" }
   },
   "negotiate": {
    "closed": 1,
    "last": { "kind": "closed", "thread_id": "nt-0001" },
    "open": 0,
    "rejected": 1,
    "rounds": 1,
    "threads": 1
   }
  }
 }
}
/* T260-REAL-FIXTURE-END */
const HAND_REAL = {
  views: [{ view: 'contractor', negotiate: { threads: 1, open: 0, closed: 1, rounds: 1, rejected: 1 },
    faq: { entries: 1, revs: [2] },
    mail: { queued: 1, refused: 1, transport_available: false, transport_reason: 'mail-transport-unavailable' } }],
  totals: { threads: 1, rounds: 1, rejected: 1, entries: 1, queued: 1, refused: 1 },
  transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' },
  recent: [{ view: 'contractor', domain: 'negotiate', ref: 'nt-0001', kind: 'closed', seq: null },
    { view: 'contractor', domain: 'faq', ref: 'fq-0001', kind: '', seq: 2 }],
  headline: '管道 · contractor: 谈判 1线程/1轮/拒 1 · FAQ 1条 · 邮件 排队 1/拒 1 · 通道不可用(mail-transport-unavailable)',
}

const SENTINEL = 'SENTINEL-PIPELINE-7c1'
/** 私域/正文探针：哨兵同时放在**键名**、**值**、以及保留字段（id/kind）里；
 *  视角名带控制字符 → 只放行清洗后的形式。形状合法 → 不得降级（否则"全零"会把泄漏藏起来）。 */
const DIRTY = {
  generated_at: '2026-09-21T12:02:00Z',
  body: `${SENTINEL}-body`,
  subject: `${SENTINEL}-subject`,
  'private:note': `${SENTINEL}-private-top`,
  reserve_price: `${SENTINEL}-price`,
  cost_model: `${SENTINEL}-cost`,
  signature: `${SENTINEL}-signature`,
  totals: { threads: 1, rounds: 1, rejected: 0, entries: 1, queued: 1, refused: 1 },
  views: {
    ['contractor\u0001']: {
      negotiate: { threads: 1, open: 0, closed: 1, rounds: 1, rejected: 0,
        last: { thread_id: `private:nt=${SENTINEL}`, kind: `${SENTINEL}-kind-body`, attempt_no: 1 },
        body: `${SENTINEL}-negbody`, reserve_price: `${SENTINEL}-vprice` },
      faq: { entries: 1, revs: [1], last: { entry_id: `${SENTINEL}-subject`, rfq_rev: 1 } },
      mail: { queued: 1, refused: 1, subject: `${SENTINEL}-mail`,
        transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' } },
      cost_model: `${SENTINEL}-viewcost`,
    },
  },
}

/** 静态扫描（只扫候选源码；扫的是**产物**，不是本门） */
const NEEDLES = ['Date.now', 'new Date', 'setInterval(', 'setTimeout(', 'readFileSync', 'writeFileSync',
  'appendFile', 'ctx.events', 'ctx.on(', 'Math.random', 'process.env', "from 'node:"]
const scanSource = (src, needles = NEEDLES) => needles.filter((needle) => src.includes(needle))

/** 畸形输入（降级负控）：每条都预期不抛 + degraded:true + 全零 */
const SHAPED = () => ({ negotiate: { threads: 1, open: 0, closed: 1, rounds: 1, rejected: 0, last: null },
  faq: { entries: 1, revs: [1], last: null }, mail: { queued: 1, refused: 0, transport: mailFalse() } })
const mangle = (mutate) => { const view = SHAPED(); mutate(view); return { views: { contractor: view } } }
const BROKEN = [
  ['null', null, 'snapshot-not-an-object', 0],
  ['undefined', undefined, 'snapshot-not-an-object', 0],
  ['数字 42', 42, 'snapshot-not-an-object', 0],
  ['字符串', 'pipeline', 'snapshot-not-an-object', 0],
  ['数组', [SHAPED()], 'snapshot-not-an-object', 0],
  ['空对象（缺 views）', {}, 'snapshot-views-missing', 0],
  ['views 是数组', { views: [] }, 'snapshot-views-missing', 0],
  ['views 为空对象', { views: {} }, 'snapshot-views-empty', 0],
  ['视角非对象', { views: { contractor: 42 } }, 'snapshot-view-shape-invalid', 1],
  ['缺 mail 域', { views: { contractor: { negotiate: SHAPED().negotiate, faq: SHAPED().faq } } },
    'snapshot-view-shape-invalid', 1],
  ['计数类型错（字符串）', mangle((v) => { v.negotiate.threads = '3' }), 'snapshot-view-shape-invalid', 1],
  ['计数为负', mangle((v) => { v.negotiate.rounds = -1 }), 'snapshot-view-shape-invalid', 1],
  ['计数为 NaN', mangle((v) => { v.mail.queued = Number.NaN }), 'snapshot-view-shape-invalid', 1],
  ['revs 非数组', mangle((v) => { v.faq.revs = 'x' }), 'snapshot-view-shape-invalid', 1],
  ['revs 含非数字', mangle((v) => { v.faq.revs = [1, '2'] }), 'snapshot-view-shape-invalid', 1],
  ['transport 非对象', mangle((v) => { v.mail.transport = 42 }), 'snapshot-view-shape-invalid', 1],
  ['transport.available 非布尔', mangle((v) => { v.mail.transport = { available: 'false' } }),
    'snapshot-view-shape-invalid', 1],
  ['last 非对象', mangle((v) => { v.negotiate.last = 42 }), 'snapshot-view-shape-invalid', 1],
  ['totals 非对象', { ...NO_TOTALS, totals: 'x' }, 'snapshot-totals-invalid', 0],
  ['totals 缺键', { ...NO_TOTALS, totals: { threads: 1 } }, 'snapshot-totals-invalid', 0],
]

const artifact = await loadArtifact()
const fibers = []
let mod = null

try {
  // ---------- 1. 契约正控（含实际加载路径 / 字节数 / sha256） ----------
  const source = artifact ? artifact.source : ''
  const chain = artifact ? artifact.chain : { files: [], links: [], per_file: [] }
  const imports = chain.per_file.flatMap((entry) => entry.specs)
  // 逐文件判：链目标（`../lib/entity-<x>.mjs` 那一跳）**只在该跳文件里**豁免；实体自己写的任何 spec
  // 都要过白名单 —— `spec !== entry.link` 一格没松，只是把重导链**读穿了**。
  const importLeaks = chain.per_file.flatMap((entry) =>
    entry.specs.filter((spec) => !(spec === '../lib/std-schema.mjs') && spec !== entry.link))
  mod = artifact ? artifact.mod : null
  const manifest = {
    name: mod?.name === 'pipeline-view',
    inject: Array.isArray(mod?.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod?.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod?.usedServices) && mod.usedServices.length === 0,
    provides: Array.isArray(mod?.provides) && mod.provides.join(',') === 'pipelineView',
    Config: typeof mod?.Config?.parse === 'function' && typeof mod?.Config?.['~standard']?.validate === 'function',
    apply: typeof mod?.apply === 'function',
    fixture: typeof mod?.fixture?.sample === 'function',
    domains: Array.isArray(mod?.VIEW_DOMAINS) && mod.VIEW_DOMAINS.join(',') === 'negotiate,faq,mail',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 齐备（name/provides=[pipelineView]/inject=[]/builtin/usedServices/Config/apply/fixture/三域）'
    + '且只 import ../lib 白名单（打印实际加载路径/字节数/sha256）',
  mod !== null && manifestBad.length === 0 && importLeaks.length === 0
  && !imports.some((spec) => spec.startsWith('node:')),
  `载入=${artifact ? artifact.path : '未加载'}；字节=${Buffer.byteLength(source, 'utf8')}；`
  + `sha256=${sha256(source).slice(0, 16)}…；影子副本字节一致=${artifact?.copied === null ? '（无影子，进树产物）' : artifact?.copied}；`
  + `链=[${chainLabel(chain.files)}]（${chain.files.length} 跳）；`
  + `imports=${imports.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；问题键=${manifestBad.join(',') || '无'}`)
  if (!mod) finish()

  // ---------- 2. 挂载正控 + 卸载（effect 回收） ----------
  const probe = await mountWith(mod, {})
  fibers.push(probe.fiber)
  const effectsBefore = probe.fiber.getEffects().length
  const probeHandle = probe.box.handle
  const handleKeys = Object.keys(probeHandle ?? {}).sort().join('|')
  const methodsOk = Boolean(probeHandle) && handleKeys === 'headline|snapshot'
    && typeof probe.ctx.get('pipelineView')?.snapshot === 'function'
  await probe.fiber.dispose()
  const effectsAfter = probe.fiber.getEffects().length
  check('2 挂载与 dispose：cordis 挂载后 provide 拦截拿得到句柄（键恰好 headline/snapshot）；'
    + 'dispose 后 ctx.get(\'pipelineView\') 不存在且 effect 归零',
  methodsOk && effectsBefore > 0 && effectsAfter === 0 && probe.ctx.get('pipelineView') === undefined,
  `句柄键=${handleKeys || '空'}；effect ${effectsBefore} → ${effectsAfter}；`
  + `dispose 后 ctx.get=${String(probe.ctx.get('pipelineView'))}`)

  const live = await mountWith(mod, {})
  fibers.push(live.fiber)
  const view = live.box.handle

  // ---------- 3. 手算正控（真形状快照） ----------
  const before = JSON.stringify(SNAPSHOT)
  const snap = view.snapshot(SNAPSHOT)
  const viewsOk = JSON.stringify(snap.views) === JSON.stringify(HAND_VIEWS)
  const totalsOk = JSON.stringify(snap.totals) === JSON.stringify(HAND_TOTALS)
    && snap.totals_source === 'payload'
  const recentOk = JSON.stringify(snap.recent) === JSON.stringify(HAND_RECENT)
  const transportOk = JSON.stringify(snap.transport) === JSON.stringify(HAND_TRANSPORT)
  const flagsOk = snap.degraded === false && snap.omitted_views === 0 && snap.bounded === true
    && snap.omitted_recent === HAND_OMITTED_RECENT && snap.source === 'pipeline-view'
    && snap.privacy.entry_bodies_included === false && snap.privacy.private_keys_included === false
  const text = JSON.stringify(snap)
  const timeOk = !text.includes('generated_at') && !/\d{4}-\d{2}-\d{2}/.test(text)
    && !text.includes(SNAPSHOT.generated_at)
  check('3 手算正控：两视角三域计数 + 合计（照抄声明）+ 通道三档全 false → false 带 reason/next_action + '
    + '最近事件（视角名序、negotiate 在前）逐字段等于手算表，且**不转发绝对时刻**（连 generated_at 都不带）',
  viewsOk && totalsOk && recentOk && transportOk && flagsOk && timeOk
  && JSON.stringify(SNAPSHOT) === before && badNumbers(snap).length === 0,
  `views=${viewsOk ? '逐字段一致' : JSON.stringify(snap.views)}；totals=${JSON.stringify(snap.totals)}/${snap.totals_source}；`
  + `transport=${JSON.stringify(snap.transport)}；recent=${snap.recent.map((item) => item.ref).join(',')}`
  + `（夹掉 ${snap.omitted_recent}）；degraded=${snap.degraded} bounded=${snap.bounded}；无时刻=${timeOk}`)

  // ---------- 4. 只组合不自算（照抄计数与声明合计） ----------
  const mismatch = view.snapshot(MISMATCH)
  const summed = view.snapshot(NO_TOTALS)
  check('4 只组合不自算正控：计数与明细不一致时**照抄计数**（threads 仍 40、entries 仍 9）；'
    + '声明的合计与视角之和故意不一致时**照抄声明值**（threads 99 而不是 40、rejected 0 而不是 7，'
    + '`totals_source=payload`）；未声明合计才跨视角相加并标注 `summed`（threads 3+2=5）',
  JSON.stringify(mismatch.totals) === JSON.stringify(HAND_MISMATCH_TOTALS)
  && mismatch.totals_source === 'payload'
  && mismatch.views.length === 1 && mismatch.views[0].negotiate.threads === 40
  && mismatch.views[0].negotiate.rejected === 7 && mismatch.views[0].faq.entries === 9
  && mismatch.views[0].mail.queued === 7 && mismatch.degraded === false && mismatch.recent.length === 0
  && JSON.stringify(summed.totals) === JSON.stringify(HAND_TOTALS) && summed.totals_source === 'summed',
  `声明线程合计=${mismatch.totals.threads}（手算声明 99，重算会变 40）；`
  + `声明 rejected=${mismatch.totals.rejected}（手算 0，重算会变 7）；视角 threads=${mismatch.views[0].negotiate.threads}；`
  + `视角 entries=${mismatch.views[0].faq.entries}/revs=${JSON.stringify(mismatch.views[0].faq.revs)}；`
  + `无合计时=${JSON.stringify(summed.totals)}/${summed.totals_source}`)

  // ---------- 5. 通道三档（正控 + 负控） ----------
  const allTrue = view.snapshot(ALL_TRUE)
  const mixed = view.snapshot(MIXED)
  const topDissent = view.snapshot(TOP_DISSENT)
  const malformed = view.snapshot(MALFORMED_DECL)
  const undeclared = view.snapshot(UNDECLARED)
  const transportProbeOk = allTrue.transport.available === true && allTrue.transport.reason === ''
  && allTrue.transport.next_action === ''
  && mixed.transport.available === false && mixed.transport.reason === 'mail-transport-unavailable'
  && mixed.transport.next_action === '配置 SMTP/IMAP 凭据后接入'
  && topDissent.transport.available === false && topDissent.transport.reason === 'mail-transport-unavailable'
  && malformed.transport.available === false && malformed.transport.reason === 'transport-declaration-malformed'
  && undeclared.transport.available === false && undeclared.transport.reason === 'transport-undeclared'
  check('5 通道三档正/负控：三档（顶层 transport / 顶层 mail.transport / 各视角 mail.transport）全 true 才 true；'
    + '**任一档 false → false** 且取第一处非空 reason/next_action（视角档先于顶层档）；声明畸形 → malformed；'
    + '一处都没有 → undeclared（宁可说不清楚，也不报可用）',
  transportProbeOk,
  `三档全 true → ${JSON.stringify(allTrue.transport)}；视角一档 false → ${JSON.stringify(mixed.transport)}；`
  + `顶层一档 false → ${JSON.stringify(topDissent.transport)}；畸形 → ${malformed.transport.reason}；`
  + `未声明 → ${undeclared.transport.reason}`)

  // ---------- 6. 降级负控 ----------
  const healthyShape = shapeOf(snap)
  const healthyTotalsShape = shapeOf(snap.totals)
  const reasons = new Set(mod.DEGRADED_REASONS ?? [])
  let degradedOk = true
  let degradedDetail = ''
  for (const [label, payload, reason, omittedViews] of BROKEN) {
    let out = null
    let text2 = ''
    try {
      out = view.snapshot(payload)
      text2 = view.headline(payload)
    } catch (err) {
      degradedOk = false
      degradedDetail = `${label} 抛出 ${err.name}: ${String(err.message).slice(0, 60)}`
      break
    }
    const zero = Object.values(out.totals).every((value) => value === 0)
      && out.views.length === 0 && out.recent.length === 0 && out.omitted_recent === 0
      && out.totals_source === 'none' && out.bounded === false
    const ok = out.degraded === true && zero && out.omitted_views === omittedViews
      && out.transport.available === false && out.transport.reason === reason && reasons.has(reason)
      && out.source === 'pipeline-view' && shapeOf(out) === healthyShape
      && shapeOf(out.totals) === healthyTotalsShape && badNumbers(out).length === 0
      && typeof text2 === 'string' && !/\d/.test(text2) && text2 === view.headline(null)
    if (!ok) {
      degradedOk = false
      degradedDetail = `${label} → degraded=${out.degraded} 零=${zero} omitted=${out.omitted_views}`
        + `（手算 ${omittedViews}）reason=${out.transport.reason}（手算 ${reason}）同形状=${shapeOf(out) === healthyShape}`
        + ` headline="${text2}"`
      break
    }
  }
  const goodZero = view.snapshot(transportPayload(mailFalse(), mailFalse(), undefined))
  check('6 降级负控：20 种畸形输入（非对象/缺 views/空 views/视角非对象/缺域/计数类型错/负数/NaN/revs 非数组/'
    + 'revs 含非数字/transport 畸形/last 畸形/totals 畸形）**一律不抛**、degraded:true、全零且与正常输出**同形状**、'
    + '`omitted_views` 等于被拒视角数、降级 headline 不含数字；合法零计数快照**不**被误判降级',
  degradedOk && goodZero.degraded === false && goodZero.views.length === 2 && goodZero.totals.threads === 0,
  `坏输入全部降级=${degradedOk}（共 ${BROKEN.length} 种）${degradedDetail ? `；首个不合规：${degradedDetail}` : ''}；`
  + `合法零计数快照 degraded=${goodZero.degraded}（视角数 ${goodZero.views.length}）`)

  // ---------- 7. 有界负控 ----------
  const bound2 = await mountWith(mod, { max_views: 2, max_recent: 1 })
  fibers.push(bound2.fiber)
  const small = bound2.box.handle.snapshot(BOUND_PAYLOAD)
  const bound0 = await mountWith(mod, { max_views: 0 })
  fibers.push(bound0.fiber)
  const none = bound0.box.handle.snapshot(BOUND_PAYLOAD)
  const tight = await mountWith(mod, { max_bytes: 12 })
  fibers.push(tight.fiber)
  const clipped = tight.box.handle.headline(SNAPSHOT)
  const zeroBytes = await mountWith(mod, { max_bytes: 0 })
  fibers.push(zeroBytes.fiber)
  const tightOk = Buffer.byteLength(clipped, 'utf8') <= 12 && HAND_HEADLINE.startsWith(clipped)
    && clipped.length > 0 && Buffer.byteLength(HAND_HEADLINE.slice(0, clipped.length + 1), 'utf8') > 12
  check('7 有界负控：max_views=2 + 五个视角（写入顺序与视角名顺序相反）→ 只列视角名序前两条、'
    + 'omitted_views=3、**合计仍含被夹掉的视角**（5×1）；max_recent=1 → recent 10 取 1、'
    + 'omitted_recent=11（recent 夹 9 + 两个被展示视角的 revs 各夹 1）、每视角 revs 只留 [2]；'
    + 'max_views=0 → 视角空但合计照旧；'
    + 'max_bytes=12 → 是完整摘要的前缀且 ≤12 字节（不劈开多字节字符）；max_bytes=0 → 空串',
  small.omitted_views === HAND_BOUND.omitted_views && small.views.map((row) => row.view).join(',')
  === HAND_BOUND.shown.join(',') && JSON.stringify(small.totals) === JSON.stringify(HAND_BOUND.totals)
  && small.omitted_recent === HAND_BOUND.omitted_recent && small.recent.length === 1
  && small.recent[0].ref === HAND_BOUND.first_recent
  && JSON.stringify(small.views[0].faq.revs) === '[2]' && small.bounded === true && small.degraded === false
  && none.views.length === 0 && none.omitted_views === 5 && none.totals.threads === 5
  && tightOk && zeroBytes.box.handle.headline(SNAPSHOT) === '',
  `max_views=2 → ${small.views.map((row) => row.view).join(',')}（手算 ${HAND_BOUND.shown.join(',')}）`
  + ` omitted_views=${small.omitted_views}（手算 3）totals.threads=${small.totals.threads}（手算 5）；`
  + `max_recent=1 → recent=${small.recent.length} omitted_recent=${small.omitted_recent}（手算 11）`
  + ` revs=${JSON.stringify(small.views[0].faq.revs)}；max_views=0 → 视角 ${none.views.length} omitted=${none.omitted_views}`
  + ` totals.threads=${none.totals.threads}；max_bytes=12 → "${clipped}"（${Buffer.byteLength(clipped, 'utf8')} 字节，`
  + `前缀=${HAND_HEADLINE.startsWith(clipped)}）；max_bytes=0 → "${zeroBytes.box.handle.headline(SNAPSHOT)}"`)

  // ---------- 8. 确定性负控 ----------
  const once = JSON.stringify(view.snapshot(SNAPSHOT))
  const twice = JSON.stringify(view.snapshot(SNAPSHOT))
  const other = await mountWith(mod, { max_views: 4, max_recent: 3, max_bytes: 512 })
  fibers.push(other.fiber)
  const otherSnap = JSON.stringify(other.box.handle.snapshot(SNAPSHOT))
  const reversed = { totals: SNAPSHOT.totals, views: { supplier: SNAPSHOT.views.supplier, contractor: SNAPSHOT.views.contractor } }
  const reversedSnap = JSON.stringify(view.snapshot(reversed))
  const frozen = deepFreeze(JSON.parse(JSON.stringify(SNAPSHOT)))
  let frozenOk = true
  try {
    frozenOk = JSON.stringify(view.snapshot(frozen)) === once
  } catch {
    frozenOk = false
  }
  check('8 确定性负控：同输入两次 snapshot **字节一致**、跨实例一致、**视角写入顺序颠倒不改输出**、'
    + '冻结输入不抛且结果一致、入参不被改写（不读墙钟、不随机）',
  once === twice && once === otherSnap && once === reversedSnap && frozenOk
  && view.headline(SNAPSHOT) === view.headline(SNAPSHOT) && badNumbers(view.snapshot(SNAPSHOT)).length === 0,
  `两次一致=${once === twice}（${once.length} 字节）；跨实例一致=${once === otherSnap}；`
  + `顺序颠倒一致=${once === reversedSnap}；冻结输入一致=${frozenOk}`)

  // ---------- 9. 静态负控 ----------
  const hits = scanSource(source)
  const planted = "const a = Date.now(); setInterval(() => {}, 1); fs.readFileSync('x'); ctx.events.on('y')"
  const plantedHits = scanSource(planted)
  check('9 静态负控：候选源码零副作用（墙钟/定时器/文件读写/事件订阅/随机/环境变量/直接 import 运行时内建）'
    + '—— 且扫描器**非空转**（在合成的坏源码上必须命中）',
  hits.length === 0 && plantedHits.length >= 4,
  `命中=${hits.join(',') || '无'}；非空转对照命中 ${plantedHits.length} 处=${plantedHits.join(',')}`)

  // ---------- 10. 私域与正文负控 ----------
  const dirtySnap = view.snapshot(DIRTY)
  const dirtyText = JSON.stringify(dirtySnap) + view.headline(DIRTY)
  const forbiddenKeys = ['body', 'subject', 'reserve_price', 'cost_model', 'signature']
    .filter((key) => new RegExp(`"${key}"\\s*:`).test(dirtyText))
  const leaks = [SENTINEL, ...forbiddenKeys].filter((needle) => dirtyText.includes(needle))
  check('10 私域与正文负控：哨兵（键名与键值两路）+ private:/body/subject/reserve_price/cost_model/signature '
    + '一个都不出现在输出里（保留字段里的标记值被清洗），且被过滤处统一显示 (redacted)；形状合法 → 不得降级',
  leaks.length === 0 && !dirtyText.includes('private:') && dirtyText.includes('(redacted)')
  && dirtySnap.degraded === false && dirtySnap.views.length === 1
  && dirtySnap.views[0].view === '(redacted)' && dirtySnap.recent[0].ref === '(redacted)'
  && !dirtyText.includes('\u0001'),
  `泄漏=${leaks.join(',') || '无'}；含 private:=${dirtyText.includes('private:')}；`
  + `含 (redacted)=${dirtyText.includes('(redacted)')}；视角名=${dirtySnap.views[0].view}；`
  + `recent=${JSON.stringify(dirtySnap.recent)}`)

  // ---------- 11. 配置契约负控 ----------
  const refuses = (raw) => {
    try {
      mod.Config.parse(raw)
      return 'accepted'
    } catch {
      return 'refused'
    }
  }
  const unknownKey = refuses({ max_views: 3, typo_key: 1 })
  const wrongType = refuses({ max_bytes: 'many' })
  const notObject = refuses(42)
  const defaults = mod.Config.parse({})
  const huge = await mountWith(mod, { max_views: 1e9, max_bytes: 1e9 })
  fibers.push(huge.fiber)
  const many = huge.box.handle.snapshot(BOUND_PAYLOAD)
  const negative = await mountWith(mod, { max_views: -5, max_recent: -5 })
  fibers.push(negative.fiber)
  const negSnap = negative.box.handle.snapshot(BOUND_PAYLOAD)
  const fractional = await mountWith(mod, { max_views: 5.7 })
  fibers.push(fractional.fiber)
  const rightSnap = fractional.box.handle.snapshot(BOUND_PAYLOAD)
  const nanViews = await mountWith(mod, { max_views: Number.NaN })
  fibers.push(nanViews.fiber)
  const nanSnap = nanViews.box.handle.snapshot(BOUND_PAYLOAD)
  check('11 配置契约负控：未知键/错误类型/非对象入参一律被拒（不得静默放行）；默认值 4/3/512；'
    + 'max_views 越界夹取（1e9→64：五视角全列；-5→0：视角空、omitted_views=5；5.7→5：五视角全列）；'
    + 'max_recent=-5→0（recent 与 revs 都空）；NaN→默认',
  unknownKey === 'refused' && wrongType === 'refused' && notObject === 'refused'
  && defaults.max_views === 4 && defaults.max_recent === 3 && defaults.max_bytes === 512
  && many.views.length === 5 && many.omitted_views === 0
  && negSnap.views.length === 0 && negSnap.omitted_views === 5 && negSnap.recent.length === 0
  && JSON.stringify(negSnap.views) === '[]' && rightSnap.views.length === 5
  && nanSnap.views.length === 4 && nanSnap.omitted_views === 1 && nanSnap.recent.length === 3,
  `未知键=${unknownKey} 错类型=${wrongType} 非对象=${notObject}；默认=${defaults.max_views}/${defaults.max_recent}/`
  + `${defaults.max_bytes}；1e9 → ${many.views.length} 条 omitted=${many.omitted_views}；-5 → ${negSnap.views.length} 条`
  + `（omitted=${negSnap.omitted_views} recent=${negSnap.recent.length}）；5.7 → ${rightSnap.views.length} 条；`
  + `NaN → ${nanSnap.views.length} 条（显示 4 视角，omitted=${nanSnap.omitted_views}）`)

  // ---------- 12. headline 正控 ----------
  const headline = view.headline(SNAPSHOT)
  const digits = headline.match(/\d+/g) ?? []
  // 手算数字段（按出现顺序）：contractor 3/4/2 + FAQ 2 + 邮件 1/1；supplier 2/3/1 + FAQ 1 + 邮件 1/0
  const HAND_DIGITS = ['3', '4', '2', '2', '1', '1', '2', '3', '1', '1', '1', '0']
  const domainsShown = ['contractor', 'supplier', '谈判', 'FAQ', '邮件', '通道'].filter((token) => headline.includes(token))
  check('12 headline 正控：手写期望串逐字一致（含三域与通道一格）、字节数 ≤ max_bytes、数字段与手算一致',
  headline === HAND_HEADLINE && digits.join(',') === HAND_DIGITS.join(',')
  && Buffer.byteLength(headline, 'utf8') <= 512 && domainsShown.length === 6,
  `headline="${headline}"（数字=${digits.join('/')}，字节=${Buffer.byteLength(headline, 'utf8')}）；`
  + `要素=${domainsShown.join(',')}`)
  // ---------- 13. 真数据正控（另一主体产出的 Python 写入器的真实快照） ----------
  const real = view.snapshot(REAL_SNAPSHOT)
  const realText = JSON.stringify(real) + view.headline(REAL_SNAPSHOT)
  const realDomains = real.views[0] ? ['negotiate', 'faq', 'mail'].filter((key) => key in real.views[0]) : []
  const realSentinel = 'ZZ-SENTINEL-PRIVATE-ZZ'
  check('13 真数据正控：`tools/refresh-ui-snapshots.py` 在**真账本**上的真实快照 → 三域计数/合计/通道/最近事件'
    + '逐字段等于手算表（与 AC-UI-002 的手算同源：线程 1 / 轮 1 / 拒 1 / FAQ 1 / 邮件 1-1）、`transport.available=false`'
    + '（本轮没有发信能力，只能这么报）、写入器丢掉的哨兵与私域键一个都不出现（真数据不是"手抄的形状"）',
  JSON.stringify(real.views) === JSON.stringify(HAND_REAL.views)
  && JSON.stringify(real.totals) === JSON.stringify(HAND_REAL.totals) && real.totals_source === 'summed'
  && JSON.stringify(real.transport) === JSON.stringify(HAND_REAL.transport)
  && JSON.stringify(real.recent) === JSON.stringify(HAND_REAL.recent)
  && view.headline(REAL_SNAPSHOT) === HAND_REAL.headline
  && real.degraded === false && real.omitted_views === 0 && real.bounded === false
  && realDomains.join(',') === 'negotiate,faq,mail' && badNumbers(real).length === 0
  && !realText.includes(realSentinel) && !realText.includes('private:')
  && !/"body"\s*:/.test(realText) && !/"subject"\s*:/.test(realText),
  `views=${JSON.stringify(real.views)}；totals=${JSON.stringify(real.totals)}（${real.totals_source}）；`
  + `transport=${JSON.stringify(real.transport)}；recent=${JSON.stringify(real.recent)}；`
  + `headline="${view.headline(REAL_SNAPSHOT)}"；三域=${realDomains.join(',')}；degraded=${real.degraded}`)
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 200)}`)
}

for (const fiber of fibers) {
  try {
    await fiber.dispose()
  } catch { /* 卸载失败不影响断言结果 */ }
}

finish()
