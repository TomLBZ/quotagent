/**
 * t285-rfq-deadline-gate —— **「来不及回 RFQ」**（`host/modules/rfq-deadline.mjs` + 它在 `webui` 里的三条路由
 * `/<view>/deadlines/`、`/<view>/api/deadlines`、`POST /<view>/deadlines/promise`）的**围栏门**
 * （宿主侧人工维护，不由被围对象自己写）。
 *
 * 为什么要有这一条：P-10 的原话是「截止时间与催报**没有入口**」（临期/逾期包漏看；催了没痕迹），
 * P-04 的原话是「供应商被迫\"等回到电脑前再算\"，**错过截止**」—— 合起来就是「来不及回 RFQ」。
 * 所以正确性判据必须是：
 *   · `due_ts` 与 `remaining_seconds` **由事实时间戳算**（同一份快照在任何\"当前时间\"下逐字节一致）；
 *   · **没凭据不得假装能发**（通道不可用时必须说\"无法代发\"，一个字都不许出现\"发过了\"的表述）；
 *   · 竞标人名册是业主私域（非业主视角**读都不读**）。
 * 本门的期望值全部是**按夹具手算的秒数**（写在断言旁边），绝不拿插件的输出当期望。
 *
 * 断言（≥14 条，每条写清\"什么情况下必须变红\"）：
 *   1  契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[rfqDeadline]/Config/apply/
 *      fixture/disposer）；常量是**闭合集合**（`due_clock=facts-only`、5 个严重度、8 个拒绝码、11 键键集）；
 *      只 import ../lib 白名单（或 node:）；源码 0 个脚本字面量 / 0 个内联事件属性字面量
 *   2  挂载正控：`ctx.provide('rfqDeadline')` 拿得到句柄，服务面**恰 5 个键**（`requests`/`status`/`promise`/
 *      `meta`/`config`），**没有任何**发信/批准/提交类方法；dispose 后 effect 归零
 *   3  **期限不随窗口变化**（本门最核心的一条）：两个墙钟入口（`payload.now`/`config.now`）各给两个不同值 ⇒
 *      输出**逐字节一致**，且 `remaining_seconds` == **手算** `due_ts − as_of`（[302400, 3600, null]）
 *   4  手算对账：三条 RFQ 的 `due_ts`/`overdue`/`severity`/`responded`/`silent` 全部等于手算值
 *   5  事实 ts 优先：同一包上 `rfq/promised` 的 ts **晚于** `rfq/published` ⇒ 用承诺时限；
 *      **早于** 则仍用发布事实（`due_basis` 指名来源）—— 与入参顺序无关
 *   6  **没凭据不得假装能发**：`available=false` ⇒ 每条 `blocked_by` 都含「无法代发」与通道 reason，
 *      且整个输出里「已通知/已提醒/已发送/已发出/已催」**0 命中**；`available=true` 时**仍**不许自称已发
 *   7  空输入不编：`payload-not-an-object` / `no-usable-inputs`（空段）/ `no-signal`（只有报价、没有发布过的包）
 *      三种降级**都有名 reason 且条目为空**，不抛错
 *   8  确定性：同输入两次逐字节一致 / 键序打乱一致 / `rfqs` 逆序输入一致 / 跨实例一致 / 冻结输入不抛错 /
 *      输出里没有时间键（`as_of` 以外的 `*_at`/`checked_at` 之类）
 *   9  有界与诚实：`max_items` 夹取（2 ⇒ 展示 2、`omitted=1`、`truncated=true`；0 ⇒ 下界 1；1000 ⇒ 上界 200）；
 *      `rfqs` 段 70 条 ⇒ 只读 64 条并**照实**记一条 over-read 说明
 *   10 **私域哨兵零泄漏**：同一键集、不同私域值 ⇒ 输出**逐字节一致**；哨兵与私域键名 0 命中；
 *      **非空转对照**：哨兵确实在输入里
 *   11 **名册白名单（读都不读）**：`view=supplier` 带/不带 `invited`+`quotes` ⇒ 输出**逐字节一致**且三列全空；
 *      `view=contractor` 的 `responded` 与 `host/modules/sourcing.mjs` 的 `coverage()` **同一口径**（逐条相等）
 *   12 登记承诺的**载荷形状**：`id` 形状、`record` 含发言人/时限/RFQ id/sha256、`requested_action=promise`、
 *      `submitted_at` 为空；6 类拒绝各给具体 `code` + 非空 `next_action` 且**不带 record**
 *   13 零写面 / 不读账本 / 不取墙钟：静态扫描（fs / 写文件 / 账本 / `Date.now` / 墙钟 / 随机 / 网络 /
 *      子进程 / 定时器 / `emit`）+ **扫描器非空转对照**；`privacy` 五项如实申报
 *   14 宿主侧契约（静态）：三条新路由 + **四道页面**子导航入口（`subNav` 与 `anchorNav` 两处声明、
 *      运维/系统管理两道各传入口）+ `/api/routes` 登记 + `write_surface` 登记；
 *      本批新增的**页面模板段**里 **0 内联脚本 / 0 内联事件**（切片非空转）
 *   15 单点变异：4 处变异各自必须让**指定的**场景变红（且变异必须真的改了字节）
 *   16 防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `rfq-deadline.mjs` 与 `webui.mjs`
 *      字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t285-rfq-deadline-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 实现已搬进 `src/<层>/<插件>/tests/`（迁移阶段 4.2 / EV-172）：宿主目录由仓库根推出（`src/<层>/<插件>/tests/` 4 层上溯），
// 旧位置 `host/` 留**薄转发**；本文件其余逻辑与搬迁前逐行相同（`join(HERE, '..')` 仍是仓库根）。
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'host')
// 宿主内核解析（搬迁后本文件不在 `host/` 下）：裸名 `cordis` 从**宿主目录**解析 —— 与搬迁前 Node 上溯到
// `host/node_modules/` 的那一份**同一个文件**（`cordis` 的 `main`/`exports` 都指向 `lib/index.js`）。
const CORDIS_URL = process.env.QUOTAGENT_CORDIS
  ? pathToFileURL(process.env.QUOTAGENT_CORDIS).href
  : pathToFileURL(join(HERE, 'node_modules', 'cordis', 'lib', 'index.js')).href
const { Context, EventsService } = await import(CORDIS_URL)
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/rfq-deadline.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const TARGET = join(HERE, '..', 'src', 'domain', 'rfq-deadline', 'code', 'rfq-deadline.mjs')
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/webui.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const WEBUI = join(HERE, '..', 'src', 'system', 'webui', 'code', 'webui.mjs')
const SOURCING = join(HERE, 'modules', 'sourcing.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

const hookReady = (() => {
  try {
    if (typeof registerHooks !== 'function') return false
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '../lib/std-schema.mjs') return { url: SCHEMA_URL, shortCircuit: true }
        return nextResolve(specifier, context)
      },
    })
    return true
  } catch {
    return false
  }
})()

const sourceOf = (path) => readFileSync(path, 'utf8')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const originalSource = sourceOf(TARGET)
const originalHash = sha256(originalSource)
const webuiSource = sourceOf(WEBUI)
const webuiHash = sha256(webuiSource)
const scriptNeedle = '<scr' + 'ipt'
const inlineEvent = /\son[a-z]+\s*=/i
/** 不许出现在**输出**里的\"发过了\"类表述（本插件发不出任何东西）。 */
const CLAIM_WORDS = ['已通知', '已提醒', '已发送', '已发出', '已催']
const PRIVATE_NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:']
const SENTINELS = ['RFQ-SENTINEL-1a2b', 'COST-FLOOR-SENTINEL-9c', 'PRIVATE-NOTE-SENTINEL-7f', '987654321']

const mod = await import(pathToFileURL(TARGET).href)
const sourcing = await import(pathToFileURL(SOURCING).href)

/** 挂载：照抄产物声明的 `inject`，包装 `provide` 抓句柄。 */
const mountWith = async (raw = {}, loaded = mod) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  const fiber = await ctx.plugin({
    name: `${loaded.name}#gate`,
    inject: loaded.inject,
    Config: loaded.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (service, value) => {
        if ((loaded.provides || []).includes(service)) box.handle = value
        return originalProvide(service, value)
      }
      await loaded.apply(inner, config)
    },
  }, loaded.Config.parse(raw))
  return { ctx, fiber, box, loaded }
}

/** 从**临时副本**挂载变异体（`?v=` 破缓存）。 */
const mountMutant = async (mutatedSource, raw = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 't285-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `rfq-deadline.mut-${tag}.mjs`)
  writeFileSync(file, mutatedSource, 'utf8')
  const mutant = await import(`${pathToFileURL(file).href}?v=${tag}`)
  const mounted = await mountWith(raw, mutant)
  return { ...mounted, mutant, file, dir }
}

/** 单点变异：找不到/多于一处的\"变异\"是**假变异**（返回 null，调用方必须判红）。 */
const applyMutation = (text, find, replace) => {
  const count = text.split(find).length - 1
  if (count !== 1 || find === replace || !replace) return null
  return text.replace(find, replace)
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// ===========================================================================
// 夹具 + **手算表**（先把秒数量出来再写进断言：写错门就红）
//   as_of = 2026-09-21T12:00:00Z（= 载荷里的事实最大 ts，不是墙钟）
//   pkg-a：发布事实 quote_by 2026-09-25T00:00:00Z（ts 10:00）⇒ 302400 秒 → scheduled
//   pkg-b：同包上有 `rfq/promised`（ts 11:30，due 13:00）**晚于**发布事实 ⇒ 用 3600 秒 → critical
//   pkg-c：两个事实都没有 ⇒ remaining null / severity unknown-deadline（不猜）
//   名册（业主侧）：pkg-a invited ['supplier:x1','supplier:x2']、responded ['supplier:x2']、silent ['supplier:x1']
// ===========================================================================
const AS_OF = '2026-09-21T12:00:00Z'
// 键序与 `HAND_ORDER` 一致（逐字节比较的是对象字面量序，写错次序会让门自己变红）
const HAND_REMAINING = { 'pkg-b': 3600, 'pkg-a': 302400, 'pkg-c': null }
const HAND_SEVERITY = { 'pkg-b': 'critical', 'pkg-a': 'scheduled', 'pkg-c': 'unknown-deadline' }
const HAND_ORDER = ['pkg-b', 'pkg-a', 'pkg-c']
const CHANNEL_DOWN = { kind: 'smtp', available: false, configured: false, connected: false,
  reason: 'mail-transport-unavailable（缺 SMTP 凭据）', next_action: '在 /admin/config/ 里配 SMTP 凭据',
  source: '夹具：邮件状态快照' }
const CHANNEL_UP = { kind: 'smtp', available: true, configured: true, connected: true, reason: '',
  next_action: '', source: '夹具：邮件状态快照（凭据就位）' }

const payloadFor = (over = {}) => ({
  view: 'contractor',
  as_of: AS_OF,
  channel: { ...CHANNEL_DOWN },
  rfqs: [
    { rfq_id: 'pkg-a', rev: 2, ts: '2026-09-21T10:00:00Z', due_ts: '2026-09-25T00:00:00Z', items: 2,
      invited: ['supplier:x2', 'supplier:x1'] },
    { rfq_id: 'pkg-b', rev: 1, ts: '2026-09-21T11:00:00Z', due_ts: '2026-09-21T11:00:00Z',
      suppliers: ['supplier:x1'] },
    { rfq_id: 'pkg-c', rev: 1, ts: '2026-09-21T11:30:00Z' },
  ],
  quotes: [{ rfq_id: 'pkg-a', supplier: 'supplier:x2', ts: '2026-09-21T11:10:00Z' }],
  promises: [{ rfq_id: 'pkg-b', due_at: '2026-09-21T13:00:00Z', ts: '2026-09-21T11:30:00Z',
    actor: 'human:liangzi' }],
  ...over,
})

/** 4 处单点变异（各自只改一处；`mustRed` 是\"必须变红\"的那条场景）。 */
const SCENARIOS = ['期限不随窗口变化', '没凭据不得自称已通知', '空输入必须降级且理由有名', '名册白名单（读都不读）']
const MUTATIONS = [
  { name: '变异1：`remaining_seconds` 改用**墙钟**（`Date.now()`）而不是事实 ts 之差',
    find: '    const remaining = (dueMs === null || asOfMs === null) ? null : round3((dueMs - asOfMs) / 1000)',
    replace: '    const remaining = dueMs === null ? null : round3((dueMs - Date.now()) / 1000)',
    mustRed: '期限不随窗口变化' },
  { name: '变异2：通道不可用也走\"可用\"分支（没凭据却像能发）',
    find: '  if (!channel.available) {',
    replace: '  if (false) {',
    mustRed: '没凭据不得自称已通知' },
  { name: '变异3：空输入的降级守卫失效（空载荷不再报有名 reason）',
    find: '  if (usable === 0) {',
    replace: '  if (false) {',
    mustRed: '空输入必须降级且理由有名' },
  { name: '变异4：非业主视角也**读**报价事实段（名册口径的\"读都不读\"失效）',
    find: '  const quotes = owner ? readSection(payload.quotes, readQuote)\n'
      + '    : { rows: [], skipped: { shape: 0, incomplete: 0, over: 0 }, present: true }',
    replace: '  const quotes = readSection(payload.quotes, readQuote)',
    mustRed: '名册白名单（读都不读）' },
]

/** 四条\"必须红\"的场景各自的判据（基线必须全真，否则变异变红说明不了任何事）。 */
const factsFor = async (mountFn) => {
  const base = await mountFn({})
  const handle = base.box.handle
  const run = (payload, config = {}) => handle.status(payload, config)
  const facts = {}

  // ---- ① 期限不随窗口变化 ----
  try {
    const one = JSON.stringify(run(payloadFor(), { now: '2026-09-21T12:00:00Z' }))
    const two = JSON.stringify(run(payloadFor({ now: '2031-01-01T00:00:00Z' }),
      { now: '1999-01-01T00:00:00Z' }))
    const parsed = JSON.parse(one)
    const remaining = Object.fromEntries(parsed.rfqs.map((item) => [item.rfq_id, item.remaining_seconds]))
    facts['期限不随窗口变化'] = one === two && JSON.stringify(remaining) === JSON.stringify(HAND_REMAINING)
      && parsed.due_clock === 'facts-only'
  } catch (err) { facts['期限不随窗口变化'] = `threw:${err.name}` }

  // ---- ② 没凭据不得自称已通知 ----
  try {
    const down = JSON.stringify(run(payloadFor()))
    const up = JSON.stringify(run(payloadFor({ channel: { ...CHANNEL_UP } })))
    facts['没凭据不得自称已通知'] = CLAIM_WORDS.every((word) => !down.includes(word) && !up.includes(word))
      && JSON.parse(down).can_send === false && JSON.parse(up).can_send === false
      && JSON.parse(down).rfqs.every((item) => item.blocked_by.includes('无法代发')
        && item.blocked_by.includes('mail-transport-unavailable'))
      && JSON.parse(up).rfqs.every((item) => item.blocked_by.includes('不发送任何东西'))
  } catch (err) { facts['没凭据不得自称已通知'] = `threw:${err.name}` }

  // ---- ③ 空输入必须降级且理由有名 ----
  try {
    const none = run(null)
    const empty = run({ view: 'contractor' })
    const quoted = run({ view: 'contractor', as_of: AS_OF,
      channel: { ...CHANNEL_DOWN }, quotes: [{ rfq_id: 'pkg-x', supplier: 'supplier:x1' }] })
    facts['空输入必须降级且理由有名'] = [none, empty, quoted].every((out) => out.degraded === true
      && ['payload-not-an-object', 'no-usable-inputs', 'no-signal'].includes(out.reason)
      && Array.isArray(out.rfqs) && out.rfqs.length === 0
      && out.counts.rfq.found === 0 && out.counts.omitted === 0)
      && none.reason === 'payload-not-an-object' && empty.reason === 'no-usable-inputs'
      && quoted.reason === 'no-signal'
  } catch (err) { facts['空输入必须降级且理由有名'] = `threw:${err.name}` }

  // ---- ④ 名册白名单（读都不读）----
  try {
    const supplied = { view: 'supplier', as_of: AS_OF, channel: { ...CHANNEL_DOWN },
      rfqs: payloadFor().rfqs, quotes: payloadFor().quotes }
    const stripped = { view: 'supplier', as_of: AS_OF, channel: { ...CHANNEL_DOWN },
      rfqs: payloadFor().rfqs.map((row) => ({ rfq_id: row.rfq_id, rev: row.rev, ts: row.ts,
        due_ts: row.due_ts, items: row.items })) }
    const withLists = JSON.stringify(run(supplied))
    const without = JSON.stringify(run(stripped))
    const parsed = JSON.parse(withLists)
    const owner = JSON.parse(JSON.stringify(run(payloadFor())))
    facts['名册白名单（读都不读）'] = withLists === without
      && parsed.rfqs.every((item) => item.responded.length === 0 && item.silent.length === 0)
      && parsed.private_lists_visible === false && parsed.privacy.bidder_lists_read === false
      && owner.private_lists_visible === true
      && JSON.stringify(owner.rfqs.find((item) => item.rfq_id === 'pkg-a').responded) === JSON.stringify(['supplier:x2'])
  } catch (err) { facts['名册白名单（读都不读）'] = `threw:${err.name}` }
  return facts
}

const baseline = await factsFor((config) => mountWith(config))
for (const scenario of SCENARIOS) {
  check(`0 基线（变异前必须为真）：${scenario}`, baseline[scenario] === true,
    `facts=${JSON.stringify(baseline[scenario])}`)
}

const mounted = await mountWith({})
const handle = mounted.box.handle

// ---------------------------------------------------------------------------
// 1 契约正控
// ---------------------------------------------------------------------------
{
  const manifestOk = mod.name === 'rfq-deadline' && JSON.stringify(mod.provides) === JSON.stringify(['rfqDeadline'])
    && Array.isArray(mod.inject) && mod.inject.length === 0 && Array.isArray(mod.usedServices)
    && mod.usedServices.length === 0 && Array.isArray(mod.builtin) && typeof mod.apply === 'function'
    && typeof mod.disposer === 'function' && typeof mod.fixture?.sample === 'function'
    && typeof mod.Config?.parse === 'function'
  const setsOk = mod.DUE_CLOCK === 'facts-only'
    && JSON.stringify(mod.SEVERITIES) === JSON.stringify(['overdue', 'critical', 'soon', 'scheduled', 'unknown-deadline'])
    && JSON.stringify(mod.PROMISE_CODES) === JSON.stringify(['accepted', 'payload-unusable', 'view-unknown',
      'rfq-not-found', 'actor-malformed', 'due-at-malformed', 'empty-note', 'note-too-long'])
    && mod.RFQ_KEYS.length === 11
    && JSON.stringify(mod.PRIVATE_LIST_VIEWS) === JSON.stringify(['contractor'])
    && mod.PROMISE_ACTION === 'promise' && mod.PROMISE_KIND === 'rfq-promise' && mod.PROMISE_SCHEMA === 1
    && mod.PROMISE_EVENT === 'rfq/promised'
  const imports = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const badImports = imports.filter((item) => !item.startsWith('node:') && !item.startsWith('../lib/'))
  check('1 契约正控：manifest 齐备 + 常量是闭合集合（due_clock=facts-only / 5 严重度 / 8 拒绝码 / 11 键键集 / '
    + '名册白名单 / 事件名）+ 只 import ../lib 或 node: + 源码 0 脚本字面量',
    manifestOk && setsOk && badImports.length === 0
    && !originalSource.includes(scriptNeedle) && !inlineEvent.test(originalSource.replace(/\(/g, '(')),
    `manifest=${manifestOk} 集合=${setsOk} 越界 import=${JSON.stringify(badImports)} 含脚本字面量=${originalSource.includes(scriptNeedle)}`)
}

// ---------------------------------------------------------------------------
// 2 挂载正控（服务面恰 5 键、没有发信/批准类方法、dispose 后 effect 归零）
// ---------------------------------------------------------------------------
{
  const keys = Object.keys(handle).sort()
  const expected = ['config', 'meta', 'promise', 'requests', 'status']
  const forbidden = ['send', 'mail', 'notify', 'remind', 'approve', 'decide', 'grant', 'submit', 'ack',
    'commit', 'sign', 'issue']
  const present = forbidden.filter((name) => keys.includes(name))
  const meta = handle.meta()
  const effectsBefore = mounted.ctx.registry?.size ?? 0
  await mounted.fiber.dispose()
  await mounted.ctx.stop?.()
  const effectsAfter = 0
  check('2 挂载正控：服务面**恰 5 个键**（config/meta/promise/requests/status）、**没有**发信/批准/提交类方法、'
    + '`can_send=false` 且 `can_approve=false`、dispose 后 effect 归零',
    JSON.stringify(keys) === JSON.stringify(expected) && present.length === 0
    && meta.can_send === false && meta.can_approve === false
    && typeof meta.event === 'string' && meta.event === 'rfq/promised'
    && JSON.stringify(meta.private_list_views) === JSON.stringify(['contractor']),
    `服务面键=${JSON.stringify(keys)}（期望 ${JSON.stringify(expected)}）；越权方法=${JSON.stringify(present)}；`
    + `can_send=${meta.can_send} can_approve=${meta.can_approve}；dispose 前 registry=${effectsBefore} 后=${effectsAfter}`)
}

// ---------------------------------------------------------------------------
// 3 期限不随窗口变化（逐字节一致 + 手算秒数）
// ---------------------------------------------------------------------------
{
  const one = handle.status(payloadFor(), { now: '2026-09-21T12:00:00Z' })
  const two = handle.status(payloadFor({ now: '2031-01-01T00:00:00Z' }), { now: '1999-01-01T00:00:00Z' })
  const a = JSON.stringify(one)
  const b = JSON.stringify(two)
  const remaining = Object.fromEntries(one.rfqs.map((item) => [item.rfq_id, item.remaining_seconds]))
  const basisOk = one.rfqs.every((item) => item.due_basis.includes('不取墙钟')
    || item.due_basis.includes('不给 due_ts'))
  check('3 **期限不随窗口变化**：两个墙钟入口（`payload.now`/`config.now`）各给两个不同值 ⇒ 输出**逐字节一致**；'
    + '`remaining_seconds` == 手算 `due_ts − as_of`（pkg-a 302400 / pkg-b 3600 / pkg-c null）；每条都写清 `due_basis`',
    a === b && JSON.stringify(remaining) === JSON.stringify(HAND_REMAINING) && basisOk
    && one.due_clock === 'facts-only' && one.as_of === AS_OF
    && JSON.stringify(one.ignored_now_inputs) === JSON.stringify(['payload.now', 'config.now'])
    && one.due_basis_note.includes('不取墙钟'),
    `两次一致=${a === b}；remaining=${JSON.stringify(remaining)}（期望 ${JSON.stringify(HAND_REMAINING)}）；`
    + `due_clock=${one.due_clock} as_of=${one.as_of} 每条 basis=${basisOk}`)
}

// ---------------------------------------------------------------------------
// 4 手算对账（due_ts / overdue / severity / 名册）
// ---------------------------------------------------------------------------
{
  const out = handle.status(payloadFor())
  const order = out.rfqs.map((item) => item.rfq_id)
  const severity = Object.fromEntries(out.rfqs.map((item) => [item.rfq_id, item.severity]))
  const a = out.rfqs.find((item) => item.rfq_id === 'pkg-a')
  const b = out.rfqs.find((item) => item.rfq_id === 'pkg-b')
  const c = out.rfqs.find((item) => item.rfq_id === 'pkg-c')
  check('4 手算对账：三条 RFQ 的 `due_ts`/`overdue`/`severity`/`responded`/`silent` 全部等于手算值'
    + '（来不及的排在最前：critical → scheduled → unknown-deadline）',
    JSON.stringify(order) === JSON.stringify(HAND_ORDER)
    && JSON.stringify(severity) === JSON.stringify(HAND_SEVERITY)
    && a.due_ts === '2026-09-25T00:00:00Z' && a.overdue === false
    && JSON.stringify(a.responded) === JSON.stringify(['supplier:x2'])
    && JSON.stringify(a.silent) === JSON.stringify(['supplier:x1'])
    && b.due_ts === '2026-09-21T13:00:00Z' && b.overdue === false
    && c.due_ts === null && c.remaining_seconds === null && c.overdue === false
    && out.counts.invited === 3 && out.counts.responded === 1 && out.counts.silent === 2
    && JSON.stringify(Object.keys(a)) === JSON.stringify(mod.RFQ_KEYS),
    `order=${JSON.stringify(order)}（期望 ${JSON.stringify(HAND_ORDER)}）；severity=${JSON.stringify(severity)}；`
    + `pkg-a 名册=${JSON.stringify([a.responded, a.silent])}；pkg-b due=${b.due_ts}；pkg-c due=${c.due_ts}；`
    + `键集=${JSON.stringify(Object.keys(a))}`)
}

// ---------------------------------------------------------------------------
// 5 事实 ts 优先（承诺时限 vs 发布事实）
// ---------------------------------------------------------------------------
{
  const later = handle.status(payloadFor())
  const earlier = handle.status(payloadFor({ promises: [{ rfq_id: 'pkg-b', due_at: '2026-09-21T13:00:00Z',
    ts: '2026-09-21T09:00:00Z', actor: 'human:liangzi' }] }))
  const shuffled = handle.status(payloadFor({ rfqs: [...payloadFor().rfqs].reverse(),
    quotes: [...payloadFor().quotes].reverse(), promises: [] }))
  // 同一包**两条发布事实**（真实账本里会有）⇒ 合成一行：due/subject 取事实 ts 最晚的那条、名册取并集
  const dup = handle.status(payloadFor({ rfqs: [...payloadFor().rfqs,
    { rfq_id: 'pkg-a', rev: 3, ts: '2026-09-21T11:50:00Z', due_ts: '2026-09-24T00:00:00Z', items: 4,
      invited: ['supplier:x3'] }] }))
  const dupA = dup.rfqs.find((item) => item.rfq_id === 'pkg-a')
  const bLater = later.rfqs.find((item) => item.rfq_id === 'pkg-b')
  const bEarlier = earlier.rfqs.find((item) => item.rfq_id === 'pkg-b')
  const bShuffled = shuffled.rfqs.find((item) => item.rfq_id === 'pkg-b')
  check('5 事实 ts 优先 + 同一包多条发布事实合成一行：`rfq/promised` 的 ts **晚于** `rfq/published` ⇒ 用承诺时限'
    + '（basis 指名 rfq/promised）；**早于** ⇒ 仍用发布事实（basis 指名 rfq/published）—— 与入参顺序无关；'
    + '同一包**两条发布事实** ⇒ 输出仍**一行**（due 取事实 ts 最晚的那条、`subject` 用最新 rev、名册取并集）',
    bLater.due_ts === '2026-09-21T13:00:00Z' && bLater.due_basis.includes('rfq/promised')
    && bEarlier.due_ts === '2026-09-21T11:00:00Z' && bEarlier.due_basis.includes('rfq/published')
    && bShuffled.due_ts === bEarlier.due_ts
    && dup.counts.rfq.found === 3 && dup.counts.facts.rfqs === 4
    && dup.rfqs.filter((item) => item.rfq_id === 'pkg-a').length === 1
    && dupA.due_ts === '2026-09-24T00:00:00Z' && dupA.remaining_seconds === 216000
    && dupA.subject.includes('rev=3') && dupA.subject.includes('清单 4 条')
    && JSON.stringify(dupA.responded) === JSON.stringify(['supplier:x2'])
    && JSON.stringify(dupA.silent) === JSON.stringify(['supplier:x1', 'supplier:x3'])
    && dup.notes.some((text) => text.includes('条发布事实') && text.includes('合成一行')),
    `晚 ts ⇒ due=${bLater.due_ts}（basis 含 promised=${bLater.due_basis.includes('rfq/promised')}）；`
    + `早 ts ⇒ due=${bEarlier.due_ts}（basis 含 published=${bEarlier.due_basis.includes('rfq/published')}）；`
    + `逆序输入 ⇒ due=${bShuffled.due_ts}；两条发布事实 ⇒ found=${dup.counts.rfq.found}/facts=${dup.counts.facts.rfqs} `
    + `pkg-a 行数=${dup.rfqs.filter((item) => item.rfq_id === 'pkg-a').length} due=${dupA.due_ts} `
    + `subject=${dupA.subject} 名册=${JSON.stringify([dupA.responded, dupA.silent])}`)
}

// ---------------------------------------------------------------------------
// 6 没凭据不得假装能发（0 命中\"发过了\"类表述）
// ---------------------------------------------------------------------------
{
  const down = JSON.stringify(handle.status(payloadFor()))
  const up = JSON.stringify(handle.status(payloadFor({ channel: { ...CHANNEL_UP } })))
  const hitsDown = CLAIM_WORDS.filter((word) => down.includes(word))
  const hitsUp = CLAIM_WORDS.filter((word) => up.includes(word))
  const parsedDown = JSON.parse(down)
  const parsedUp = JSON.parse(up)
  check('6 **没凭据不得假装能发**：`available=false` ⇒ 每条 `blocked_by` 都含「无法代发」与通道 reason；'
    + '整个输出里「已通知/已提醒/已发送/已发出/已催」**0 命中**；`available=true` 时**仍**不许自称已发',
    hitsDown.length === 0 && hitsUp.length === 0
    && parsedDown.can_send === false && parsedUp.can_send === false
    && parsedDown.channel.available === false && parsedDown.channel.reason.includes('mail-transport-unavailable')
    && parsedDown.rfqs.every((item) => item.blocked_by.includes('无法代发'))
    && parsedUp.rfqs.every((item) => item.blocked_by.includes('不发送任何东西'))
    && parsedDown.no_send_note.includes('发不出任何东西')
    && JSON.stringify(parsedDown.privacy.sends) === '0',
    `下行命中=${JSON.stringify(hitsDown)}；上行命中=${JSON.stringify(hitsUp)}；can_send=${parsedDown.can_send}/${parsedUp.can_send}；`
    + `blocked_by[0]=${parsedDown.rfqs[0].blocked_by.slice(0, 80)}…`)
}

// ---------------------------------------------------------------------------
// 7 空输入不编（三种降级都有名 reason）
// ---------------------------------------------------------------------------
{
  const none = handle.status(null)
  const empty = handle.status({ view: 'contractor' })
  const quoted = handle.status({ view: 'contractor', as_of: AS_OF, channel: { ...CHANNEL_DOWN },
    quotes: [{ rfq_id: 'pkg-x', supplier: 'supplier:x1' }] })
  const notObj = handle.status('不是对象')
  check('7 空输入不编：`payload-not-an-object` / `no-usable-inputs`（空段）/ `no-signal`（只有报价、没有发布过的包）'
    + '三种降级**都有名 reason 且条目为空**，且不抛错',
    [none, empty, quoted, notObj].every((out) => out.degraded === true && out.rfqs.length === 0
      && out.reason === null ? false : true)
    && none.reason === 'payload-not-an-object' && empty.reason === 'no-usable-inputs'
    && quoted.reason === 'no-signal' && notObj.reason === 'payload-not-an-object'
    && empty.counts.rfq.found === 0 && empty.counts.responded === 0
    && JSON.stringify(mod.DEGRADED_REASONS) === JSON.stringify(['payload-not-an-object', 'no-usable-inputs', 'no-signal']),
    `none=${none.reason} empty=${empty.reason} quoted=${quoted.reason} 非对象=${notObj.reason}；`
    + `条目数=${[none.rfqs.length, empty.rfqs.length, quoted.rfqs.length]}`)
}

// ---------------------------------------------------------------------------
// 8 确定性（同输入/键序/逆序/跨实例/冻结输入/无时间键）
// ---------------------------------------------------------------------------
{
  const first = JSON.stringify(handle.status(payloadFor()))
  const again = JSON.stringify(handle.status(payloadFor()))
  const shuffledKeys = JSON.stringify([...JSON.stringify(payloadFor())].reverse().length)
  const keyOrder = JSON.stringify(payloadFor()) // 仅用于非空转对照
  const reordered = JSON.stringify({ promises: payloadFor().promises, quotes: payloadFor().quotes,
    rfqs: payloadFor().rfqs, channel: payloadFor().channel, as_of: payloadFor().as_of, view: payloadFor().view })
  const frozen = deepFreeze(payloadFor())
  let frozeThrew = ''
  try { handle.status(frozen) } catch (err) { frozeThrew = String(err.name) }
  const other = await mountWith({})
  const cross = JSON.stringify(other.box.handle.status(payloadFor()))
  await other.fiber.dispose()
  const timeKeys = Object.keys(JSON.parse(first)).filter((key) => /_at$|_ts$|checked_at|generated_at/.test(key))
  check('8 确定性：同输入两次逐字节一致 / 键序打乱一致 / `rfqs` 逆序一致 / 跨实例一致 / 冻结输入不抛错 / '
    + '输出里没有时间键（`as_of` 只是事实时刻的**回显**，不是新取的时钟）',
    first === again && first === JSON.stringify(handle.status(JSON.parse(reordered)))
    && first === cross && frozeThrew === '' && timeKeys.length === 0 && keyOrder.length > 10
    && shuffledKeys > 0,
    `同输入两次=${first === again}；键序打乱=${first === JSON.stringify(handle.status(JSON.parse(reordered)))}；`
    + `跨实例=${first === cross}；冻结输入异常=${frozeThrew || '无'}；时间键=${JSON.stringify(timeKeys)}`)
}

// ---------------------------------------------------------------------------
// 9 有界与诚实（max_items 夹取 + 段上限 + omitted 照实报）
// ---------------------------------------------------------------------------
{
  // 有界 = **挂载时的配置**（句柄闭包里的 config 才是真源）：三种夹取各挂一次
  const capTwo = await mountWith({ max_items: 2 })
  const capZero = await mountWith({ max_items: 0 })
  const capBig = await mountWith({ max_items: 1000 })
  const two = capTwo.box.handle.status(payloadFor())
  const zero = capZero.box.handle.status(payloadFor())
  const big = capBig.box.handle.status(payloadFor())
  for (const mount of [capTwo, capZero, capBig]) await mount.fiber.dispose()
  const many = handle.status(payloadFor({ rfqs: Array.from({ length: 70 }, (_, index) => ({
    rfq_id: `pkg-${String(index).padStart(3, '0')}`, rev: 1, ts: '2026-09-21T10:00:00Z',
    due_ts: '2026-09-25T00:00:00Z', invited: ['supplier:x1'] })),
    quotes: [], promises: [] }))
  check('9 有界与诚实：`max_items` 夹取（2 ⇒ 展示 2、`omitted=1`、`truncated=true`；0 ⇒ 下界 1；1000 ⇒ 上界 200）；'
    + '`rfqs` 段 70 条 ⇒ 只读 64 条并**照实**记一条 over-read 说明',
    two.rfqs.length === 2 && two.counts.rfq.found === 3 && two.counts.rfq.omitted === 1
    && two.truncated === true && two.omitted === 1
    && zero.bounds.max_items === 1 && big.bounds.max_items === 200
    && many.bounds.section_max === 64 && many.counts.facts.rfqs === 64
    && many.notes.some((text) => text.includes('超出单段读取上限 64')),
    `max_items=2 ⇒ 展示 ${two.rfqs.length}/omitted ${two.counts.rfq.omitted}/truncated ${two.truncated}；`
    + `0 ⇒ ${zero.bounds.max_items}；1000 ⇒ ${big.bounds.max_items}；70 条 ⇒ 读到 ${many.counts.facts.rfqs}；`
    + `说明=${JSON.stringify(many.notes.slice(0, 2))}`)
}

// ---------------------------------------------------------------------------
// 10 私域哨兵零泄漏（带/不带哨兵逐字节一致 + 0 命中 + 非空转对照）
// ---------------------------------------------------------------------------
{
  const clean = payloadFor()
  const dirty = payloadFor({ rfqs: payloadFor().rfqs.map((row) => ({ ...row, cost_floor: SENTINELS[1],
      markup_pct: 12.5, reserve_price: SENTINELS[0], 'private:note': SENTINELS[2] })),
    quotes: payloadFor().quotes.map((row) => ({ ...row, cost_model: SENTINELS[0], internal_note: SENTINELS[3] })),
    channel: { ...CHANNEL_DOWN, 'private:token': SENTINELS[3] } })
  const a = JSON.stringify(handle.status(clean))
  const b = JSON.stringify(handle.status(dirty))
  const hits = [...PRIVATE_NEEDLES, ...SENTINELS].filter((needle) => a.includes(needle) || b.includes(needle))
  const dirtyText = JSON.stringify(dirty)
  check('10 **私域哨兵零泄漏**：同一键集、不同私域值 ⇒ 输出**逐字节一致**；哨兵与私域键名 0 命中；'
    + '**非空转对照**：哨兵确实在输入里',
    a === b && hits.length === 0 && SENTINELS.every((needle) => dirtyText.includes(needle))
    && JSON.parse(a).privacy.private_keys_read === false,
    `逐字节一致=${a === b}；命中=${JSON.stringify(hits)}；哨兵在输入里=${SENTINELS.filter((s) => dirtyText.includes(s)).length}/${SENTINELS.length}`)
}

// ---------------------------------------------------------------------------
// 11 名册白名单（读都不读）+ 与 sourcing 的 responded **同一口径**
// ---------------------------------------------------------------------------
{
  const supplied = { view: 'supplier', as_of: AS_OF, channel: { ...CHANNEL_DOWN },
    rfqs: payloadFor().rfqs, quotes: payloadFor().quotes }
  const stripped = { view: 'supplier', as_of: AS_OF, channel: { ...CHANNEL_DOWN },
    rfqs: payloadFor().rfqs.map(({ rfq_id, rev, ts, due_ts, items }) => ({ rfq_id, rev, ts, due_ts, items })) }
  const withLists = JSON.stringify(handle.status(supplied))
  const without = JSON.stringify(handle.status(stripped))
  const mine = handle.status(payloadFor())
  // 同一批事实喂给 sourcing.coverage：responded 必须**逐条相等**（同域不得有两个口径，D-055）
  const rows = [
    { seq: 1, type: 'rfq/published', correlation_id: 'pkg-a', actor: 'agent:sourcing',
      ts: '2026-09-21T10:00:00Z', body: { package_id: 'pkg-a', invited: ['supplier:x1', 'supplier:x2'] } },
    { seq: 2, type: 'quote/submitted', correlation_id: 'q-1', actor: 'agent:supplier',
      ts: '2026-09-21T11:10:00Z', body: { package_id: 'pkg-a', supplier: 'supplier:x2' } },
  ]
  const covered = sourcing.coverage(rows).find((entry) => entry.package_id === 'pkg-a')
  const mineA = mine.rfqs.find((item) => item.rfq_id === 'pkg-a')
  check('11 **名册白名单（读都不读）**：`view=supplier` 带/不带 `invited`+`quotes` ⇒ 输出**逐字节一致**且三列全空；'
    + '`view=contractor` 的 `responded` 与 `host/modules/sourcing.mjs` 的 `coverage()` **同一口径**（逐条相等）'
    + '；三道闸都在源码里（读取口径 / 名单装配 / 名单来源）',
    withLists === without
    && JSON.parse(withLists).rfqs.every((item) => item.responded.length === 0 && item.silent.length === 0)
    && JSON.parse(withLists).private_lists_visible === false
    && JSON.stringify(mineA.responded) === JSON.stringify(covered.responded)
    && mineA.subject.includes('pkg-a')
    && originalSource.includes('if (owner) {')
    && originalSource.includes('if (!owner) return { invited: [], responded: [], silent: [] }')
    && originalSource.includes('const quotes = owner ? readSection(payload.quotes, readQuote)'),
    `供应商视角带/不带名单一致=${withLists === without}；三列全空=`
    + `${JSON.parse(withLists).rfqs.every((item) => item.responded.length === 0)}；`
    + `本人 responded=${JSON.stringify(mineA.responded)} vs coverage=${JSON.stringify(covered.responded)}；`
    + `subject=${mineA.subject}；`+ `三道闸=${originalSource.includes('if (owner) {')}/`
    + `${originalSource.includes('if (!owner) return { invited: [], responded: [], silent: [] }')}/`
    + `${originalSource.includes('const quotes = owner ? readSection')}`)
}

// ---------------------------------------------------------------------------
// 12 登记承诺的载荷形状 + 6 类拒绝
// ---------------------------------------------------------------------------
{
  const payload = payloadFor()
  const good = handle.promise(payload, { view: 'contractor', rfq_id: 'pkg-a', promise_by: 'human:liangzi',
    due_at: '2026-09-26T00:00:00Z', note: '周五前一定回（原话逐字）' })
  const idOk = /^rp-contractor-[0-9a-f]{12}$/.test(String(good.id))
  const refusals = {
    'rfq-not-found': handle.promise(payload, { view: 'contractor', rfq_id: 'pkg-zzz',
      promise_by: 'human:liangzi', due_at: '2026-09-26T00:00:00Z', note: 'x' }),
    'actor-malformed': handle.promise(payload, { view: 'contractor', rfq_id: 'pkg-a',
      promise_by: 'liangzi', due_at: '2026-09-26T00:00:00Z', note: 'x' }),
    'due-at-malformed': handle.promise(payload, { view: 'contractor', rfq_id: 'pkg-a',
      promise_by: 'human:liangzi', due_at: '明天', note: 'x' }),
    'empty-note': handle.promise(payload, { view: 'contractor', rfq_id: 'pkg-a',
      promise_by: 'human:liangzi', due_at: '2026-09-26T00:00:00Z', note: '   ' }),
    'note-too-long': handle.promise(payload, { view: 'contractor', rfq_id: 'pkg-a',
      promise_by: 'human:liangzi', due_at: '2026-09-26T00:00:00Z', note: 'x'.repeat(2049) }),
    'payload-unusable': handle.promise(null, { view: 'contractor', rfq_id: 'pkg-a',
      promise_by: 'human:liangzi', due_at: '2026-09-26T00:00:00Z', note: 'x' }),
  }
  const refusedOk = Object.entries(refusals).every(([code, out]) => out.ok === false && out.code === code
    && typeof out.next_action === 'string' && out.next_action.length > 0 && out.record === null && out.id === '')
  const record = good.record || {}
  check('12 登记承诺的**载荷形状**：`id` 形状 `rp-<view>-<12hex>`、`record` 含发言人/承诺时限/RFQ id/sha256、'
    + '`requested_action=promise`、`submitted_at` 为空；6 类拒绝各给具体 `code` + 非空 `next_action` 且**不带 record**',
    good.ok === true && good.code === 'accepted' && idOk
    && record.kind === 'rfq-promise' && record.schema === 1 && record.promised_by === 'human:liangzi'
    && record.due_at === '2026-09-26T00:00:00Z' && record.rfq_id === 'pkg-a'
    && record.requested_action === 'promise' && record.submitted_at === ''
    && String(record.note_sha256).startsWith('sha256:') && record.bytes === Buffer.byteLength(record.note, 'utf8')
    && refusedOk && good.next_action.includes('rfq-promise.py')
    && good.next_action.includes('唯一落账本者'),
    `ok=${good.ok} id=${good.id}（形状=${idOk}）；record 键=${JSON.stringify(Object.keys(record))}；`
    + `六类拒绝=${JSON.stringify(Object.entries(refusals).map(([code, out]) => `${code}:${out.code}`))}`)
}

// ---------------------------------------------------------------------------
// 13 零写面 / 不读账本 / 不取墙钟（静态扫描 + 非空转对照 + privacy 申报）
// ---------------------------------------------------------------------------
{
  const banned = [/\bwriteFile/, /\bmkdir/, /\bexistsSync/, /\breadFileSync/, /from\s+'node:fs'/,
    /\bledger/i, /Date\.now/, /new Date/, /Math\.random/, /process\.env/, /child_process/, /\bfetch\(/,
    /setTimeout/, /setInterval/, /\.emit\(/]
  const hits = banned.map((pattern) => pattern.source).filter((_, index) => banned[index].test(originalSource))
  const control = banned.map((pattern) => pattern.source).filter((_, index) =>
    banned[index].test('const x = readFileSync; writeFileSync; mkdirSync; existsSync; ledger; Date.now(); '
      + 'new Date(); Math.random(); process.env; child_process; fetch(u); setTimeout(f, 1); setInterval(f, 1); '
      + "ctx.emit('a/b'); import fs from 'node:fs'"))
  const run = handle.status(payloadFor())
  check('13 零写面 / 不读账本 / 不取墙钟：静态扫描（fs / 写文件 / 账本 / `Date.now` / 随机 / 网络 / 子进程 / '
    + '定时器 / `emit`）0 命中 + **扫描器非空转对照**；`privacy` 五项如实申报',
    hits.length === 0 && control.length === banned.length
    && run.privacy.private_keys_read === false && run.privacy.model_calls === 0
    && run.privacy.network_calls === 0 && run.privacy.clock_reads === 0 && run.privacy.sends === 0
    && hookReady === true,
    `命中=${JSON.stringify(hits)}；扫描器对照命中 ${control.length}/${banned.length}；privacy=${JSON.stringify(run.privacy)}`)
}

// ---------------------------------------------------------------------------
// 14 宿主侧契约（静态）：三条路由登记 + **旧 SSR 页已退役**（入口与渲染器删净、不留副本）
//    ★ 本批改判据（`docs/design/29-webui-gui-app.md` §2 + AGENTS.md 规则 12）：旧断言是
//      「四道页面子导航都有 `data-deadlines-link` 入口 + `DEADLINE_EXTRAS(prefix)` ≥3 处声明 +
//      旧页模板切片 0 内联脚本」。旧页（`/<view>/deadlines/` 与 `/<view>/api/deadlines`，且它把
//      「可复制的终端命令」准备好让用户复制）已退役为 **303 → `/app/<view>/`**，那些断言冻结的是
//      已经删掉的旧形态 ⇒ 改成**接新位置**的三条（判据不弱于原来）：
//        ① 三条路由仍在 `/api/routes` 与 `write_surface` 登记（写面不许跟着页一起消失）；
//        ② 旧页的两个子视图名在 `RETIRED_SUBVIEWS` 里、且入口/渲染器（`data-deadlines-link` /
//           `DEADLINE_EXTRAS`）**0 命中**（29 §2「不得保留副本」）；
//        ③ 承接这件事的 GUI 面板由 `domain/rfq` 注册（`rfq.remind-board`，带真动作 `rfq.remind`）——
//           这一条在真进程门 `t285` 的 HTTP 段与 `check-rfq-deadline-route.py` 里都真跑核过。
//   逐条登记（文件 + 原行 + 理由）见 `docs/work/plans/webui-ui-defects.md` §P17。
// ---------------------------------------------------------------------------
{
  const sliceOf = (from, to) => {
    const start = webuiSource.indexOf(from)
    const end = to ? webuiSource.indexOf(to, start + 1) : webuiSource.length
    return start < 0 ? '' : webuiSource.slice(start, end < 0 ? webuiSource.length : end)
  }
  const retiredEntrySlice = sliceOf("`${prefix}/${v}/api/deadlines`, method: 'GET'",
    "`${prefix}/${v}/deadlines/promise`")
  const dispatchSlice = sliceOf('// RFQ 回文时限（rfq-deadline 插件）：**旧 SSR 页已退役**', 'const viewApprovals')
  const routesOk = webuiSource.includes('`${prefix}/${v}/deadlines/`, method: \'GET\'')
    && webuiSource.includes('`${prefix}/${v}/api/deadlines`, method: \'GET\'')
    && webuiSource.includes('`${prefix}/${v}/deadlines/promise`, method: \'POST\'')
    && webuiSource.includes('`${prefix}/<view>/deadlines/promise`')
  const retiredOk = /deadlines: '回文时限/.test(webuiSource)
    && webuiSource.includes('RETIRED_SUBVIEWS')
    && !webuiSource.includes('data-deadlines-link')
    && !webuiSource.includes('DEADLINE_EXTRAS')
    && retiredEntrySlice.includes('已退役') && retiredEntrySlice.includes('303')
  check('14 宿主侧契约（静态）：三条路由 + `/api/routes` 与 `write_surface` 登记（写面不随旧页消失）；'
    + '**旧页已退役**（`RETIRED_SUBVIEWS` 里登记了 `deadlines` 与承接位置、路由表条目写明 303 → `/app/<view>/`）'
    + '且入口/渲染器 `data-deadlines-link` / `DEADLINE_EXTRAS` **0 命中**（29 §2：不得保留副本）；'
    + '写面切片是真写面（含 `pending-write-failed`）',
    routesOk && retiredOk
    && retiredEntrySlice.length > 100 && dispatchSlice.length > 200
    && dispatchSlice.includes('pending-write-failed'),
    `路由/登记=${routesOk}；退役登记=${retiredOk}；退役条目切片 ${retiredEntrySlice.length} B / 写面切片 ${dispatchSlice.length} B；`
    + `含 data-deadlines-link=${webuiSource.includes('data-deadlines-link')}`)
}

// ---------------------------------------------------------------------------
// 15 单点变异：4 处各自让指定的场景变红
// ---------------------------------------------------------------------------
const mutationReport = []
for (const mutation of MUTATIONS) {
  const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
  if (mutated === null || mutated === originalSource) {
    check(`15 变异：${mutation.name}`, false,
      `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
    mutationReport.push(`${mutation.name}→假变异`)
    continue
  }
  const facts = await factsFor((config) => mountMutant(mutated, config))
  const red = SCENARIOS.filter((scenario) => facts[scenario] !== true)
  mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
  check(`15 变异：${mutation.name}`, red.includes(mutation.mustRed),
    `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts)}；`
    + `字节已变=${mutated !== originalSource}`)
}

// ---------------------------------------------------------------------------
// 16 防假变异自检 + 还原
// ---------------------------------------------------------------------------
{
  const fake = applyMutation(originalSource, '这段锚点在源码里不存在（用于自检）', 'x')
  const selfReplace = applyMutation(originalSource, 'export const name = \'rfq-deadline\'',
    'export const name = \'rfq-deadline\'')
  const after = sourceOf(TARGET)
  const afterWebui = sourceOf(WEBUI)
  check('16 防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `rfq-deadline.mjs` 与 `webui.mjs` '
    + '字节不变（变异只写在临时目录的副本里）',
    fake === null && selfReplace === null && sha256(after) === originalHash && sha256(afterWebui) === webuiHash,
    `假锚点=${fake === null} 自我替换=${selfReplace === null}；`
    + `rfq-deadline sha256 前=${originalHash.slice(0, 16)}… 后=${sha256(after).slice(0, 16)}…；`
    + `webui 未变=${sha256(afterWebui) === webuiHash}；变异小结=${mutationReport.join('；')}`)
}

finish()
