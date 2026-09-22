/**
 * t284-authority-gate —— **「授权区间」**（`host/modules/authority-band.mjs` + 它在 `webui` 里的两条路由
 * `/<view>/authority/`、`/<view>/api/authority`）的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 为什么要有这一条：P-12 的原话是「谈判让步的**授权区间不可见**」—— 人不敢批（不知道底线）或批过头。
 * 所以正确性判据**必须**是"金额与限额一比就能手算对上"，而不是"页面上有个框"。本门的期望值全部是
 * **按夹具手算的整数分**（写在断言旁边），绝不拿插件的输出当期望。
 *
 * 断言（≥14 条，每条写清"什么情况下必须变红"）：
 *   1  契约正控：manifest + 本批常量齐备（`unit=cents` / 闭合的 `REASONS`/`REFUSAL_CODES`/`STATUSES`/
 *      `BLOCKED_BY_VALUES` / `REGISTERED_ROLES` 与 `host/lib/config-keys.mjs` 的 `authority.bands.*` 登记
 *      **逐字一致** / 升级命令形状）；只 import ../lib 白名单（或 node:）；源码 0 个脚本字面量
 *   2  挂载正控：服务面**恰 3 个只读方法**（`check`/`config`/`meta`）、dispose 后 effect 归零
 *   3  **三例边界值逐条对账**（本门最核心的一条）：恰等于限额（500000/500000 ⇒ 在区间内、越界 0 分）、
 *      超一分（500001 ⇒ 越界 1 分、要求角色升到 lead、出升级命令）、差一分（499999 ⇒ 在区间内）——
 *      三例的 `inside_band`/`over_by`/`required_role`/`next_role` 全部等于**手算值**
 *   4  谁能批到多少：`bands` 全表 3 条（按限额升序）+ `within` 覆盖列表逐条手算（含 `remaining_cents`）；
 *      金额超过**所有**角色时 `within` 空、`required_role`/`next_role` 留空 —— 但仍然给升级命令（不编人名）
 *   5  **未配置不得编限额**：角色没登记 / 限额为 `null` / 配置快照缺失 / 单位声明非 `cents` 四类一律
 *      `unconfigured=true` + 有名 reason + `required_role`/`next_role` 为空 + `inside_band=null` + 无升级命令；
 *      并且 `null`（未配置）与 `0`（人明确登记"一分也不能批"）是**两件事**
 *   6  金额非法**三类**拒绝：负数 / 非整数（浮点、小数串、科学计数、null）/ 超上限（AMOUNT_MAX+1）
 *      各自给具体 `code` + 非空 `next_action` + **不给结论**（`inside_band=null`、无升级命令）；
 *      **非空转对照**：同批合法金额（含恰等于 AMOUNT_MAX）照旧给结论
 *   7  **越界必出升级命令且命令真存在**：越界 ⇒ `escalate_cmd` 非空、以 `tools/verify.sh <门名>` 开头，
 *      该门名**真的出现在** `tools/verify.sh help` 的输出里（本门真跑那个命令）；人工签署命令指向
 *      `src/quotagent/g1side.py`（文件真存在）；**双向**：不越界时 `escalate_cmd` 为空
 *   8  **插件不能批准**（硬负控）：服务面里没有任何 `approve/decide/grant/submit/ack/allow/reject` 类方法、
 *      `meta.can_approve=false`、每条输出都带 `can_approve=false` + 非空 `approval_note`、源码里 0 个审批方法
 *   9  确定性：同输入两次逐字节一致 / 键序打乱一致 / 跨实例一致 / 两个墙钟入口（`payload.now`/`config.now`）
 *      给任何值输出都不变 / 冻结输入不抛错 / 输出里没有时间键
 *   10 有界与诚实：`max_roles` 夹取（3 ⇒ 只读 3 条并如实报 `roles_omitted`；0 ⇒ 下界 1；1000 ⇒ 上界 8）；
 *      11 条角色输入 ⇒ 8 条 + `truncated=true`；金额上限边界（`AMOUNT_MAX` 可判、+1 拒）
 *   11 **私域哨兵零泄漏**：同一键集、不同私域值 ⇒ 输出**逐字节一致**；哨兵与私域键名 0 命中；
 *      坏角色名的 `authority.bands.*` 键（含哨兵）**读都不读**；非空转对照：哨兵确实在输入里
 *   12 零写面 / 不读账本 / 不取墙钟：静态扫描（写/读文件、账本、墙钟、随机、网络、子进程、事件、定时器）
 *      + **扫描器非空转对照**；`privacy` 四项如实申报
 *   13 宿主侧契约（静态）：两条新路由 + **四道页面**子导航入口（`subNav` 与 `anchorNav` 两处声明、
 *      运维/系统管理两道各传两个入口）+ 上手页有「授权区间在哪里配」段 + 模板 0 内联脚本 / 0 内联事件
 *   14 **真 HTTP 正控**（in-process 挂真 `webui` + 真依赖模块 + **临时配置夹具**）：两视角页面/JSON 四条 URL
 *      都 200、`/api/routes` 登记两条新路由且 `auth=none`；页面/JSON 的结论与**手算**一致
 *   15 **真 HTTP 负控 + 改配置前后结论不同**：未配置实例（配置指向不存在的文件）⇒ `unconfigured=true`、
 *      `required_role`/`next_role` 空、`bands` 空；把**临时**配置里的 buyer 限额从 500000 改成 500001
 *      ⇒ **同一个金额**的结论从「越界」翻成「在区间内」（同一进程、同一 URL）；只读 ⇒ 夹具文件前后
 *      逐字节一致；响应 **0 行脚本 / 0 内联事件**；夹具里**确实**有私域哨兵而响应 0 命中；提权后
 *      `/admin/` 子导航含入口；未提权 `/admin/` 仍 401 固定体
 *   16 **单点变异**：4 处变异各自必须让**指定的**场景变红（且变异必须真的改了字节）
 *   17 防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `authority-band.mjs` 与 `webui.mjs`
 *      字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t284-authority-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
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
const TARGET = join(HERE, 'modules', 'authority-band.mjs')
const WEBUI = join(HERE, 'modules', 'webui.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href
const VERIFY_SH = join(HERE, '..', 'tools', 'verify.sh')
const G1SIDE = join(HERE, '..', 'src', 'quotagent', 'g1side.py')

// 门自己注入的**假** admin token：只为取第四道页面（提权后）的子导航入口。
const T284_TOKEN = 't284-gate-token-9c1a'
process.env.QUOTAGENT_ADMIN_TOKEN_T284 = T284_TOKEN

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

const mod = await import(pathToFileURL(TARGET).href)

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
  const dir = mkdtempSync(join(tmpdir(), 't284-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `authority-band.mut-${tag}.mjs`)
  writeFileSync(file, mutatedSource, 'utf8')
  const mutant = await import(`${pathToFileURL(file).href}?v=${tag}`)
  const mounted = await mountWith(raw, mutant)
  return { ...mounted, mutant, file, dir }
}

/** 单点变异：找不到/多于一处的"变异"是**假变异**（返回 null，调用方必须判红）。 */
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
// 夹具 + **手算表**（先把数字量出来再写进断言：写错门就红）
//   区间登记（整数分）：buyer = 500000、lead = 2000000、director = 10000000
//   三例边界（同一个角色 buyer、同一份登记）：
//     ① 恰等于限额 500000 ⇒ inside_band=true、over_by=0、required=buyer、next=lead、**无**升级命令
//     ② 超一分     500001 ⇒ inside_band=false、over_by=1、required=lead、next=lead、**有**升级命令
//     ③ 差一分     499999 ⇒ inside_band=true、over_by=0、required=buyer、next=lead、**无**升级命令
//   within（覆盖本金额的角色，限额升序、remaining = 限额 − 金额）：
//     金额 500001 ⇒ lead（剩 1499999）、director（剩 9499999）
//     金额 2000001 ⇒ director（剩 7999999）
//     金额 999999999999（> 所有限额）⇒ 空表，required/next 都留空
//   required_role = 覆盖本金额的**最低权限**角色（least privilege）；next_role = 比当前角色限额更高、
//     且**真的批得到**本金额的最小限额角色。
// ===========================================================================
const HAND_BANDS = { buyer: 500000, lead: 2000000, director: 10000000 }
const cfgFor = (over = {}) => ({ 'authority.unit': 'cents', 'authority.currency': 'CNY',
  'authority.bands.buyer': HAND_BANDS.buyer, 'authority.bands.lead': HAND_BANDS.lead,
  'authority.bands.director': HAND_BANDS.director, ...over })
const HAND_BOUNDARY = [
  { label: '①恰等于限额', role: 'buyer', amount: 500000, inside: true, over: 0, required: 'buyer', next: 'lead', esc: false },
  { label: '②超一分', role: 'buyer', amount: 500001, inside: false, over: 1, required: 'lead', next: 'lead', esc: true },
  { label: '③差一分', role: 'buyer', amount: 499999, inside: true, over: 0, required: 'buyer', next: 'lead', esc: false },
]
const HAND_WITHIN = {
  500001: [['lead', 2000000, 1499999], ['director', 10000000, 9499999]],
  2000001: [['director', 10000000, 7999999]],
  999999999999: [],
}
const HAND_AMOUNT_MAX = 1000000000000
const HAND_SENTINELS = ['AUTH-SENTINEL-8f31', 'PRIVATE-NOTE-SENTINEL-7f', 'RESERVE-LIMIT-SENTINEL-4b',
  '987654321', 'INTERNAL-AUTH-NOTE-5c']
const PRIVATE_NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:']
const HAND_UNCONFIGURED_REASONS = ['config-missing', 'unit-unsupported', 'role-missing', 'band-unconfigured']

/** 4 处单点变异（各自只改一处；`mustRed` 是"必须变红"的那条场景）。 */
const SCENARIOS = ['三例边界值手算对账', '未配置不得编限额', '越界必出升级命令', '金额非法三类拒绝']
const MUTATIONS = [
  { name: '变异1：角色没登记时**落回一个限额**（编一个：拿最高限额当他的区间）',
    find: '  const own = cfg.bands.find((item) => item.role === role) ?? null',
    replace: '  const own = cfg.bands.find((item) => item.role === role)'
      + ' ?? (cfg.bands.length > 0 ? cfg.bands[cfg.bands.length - 1] : null)',
    mustRed: '未配置不得编限额' },
  { name: '变异2：越界也不给升级命令（页面只报越界、不告诉人怎么办）',
    find: 'over_by: overBy, escalate_cmd: ESCALATE_COMMAND,',
    replace: "over_by: overBy, escalate_cmd: '',",
    mustRed: '越界必出升级命令' },
  { name: '变异3：金额不校验非整数（小数也拿去比区间）',
    find: '  const parsed = parseAmount(payload.amount)',
    replace: "  const parsed = typeof payload.amount === 'number'\n"
      + '    ? { ok: true, value: payload.amount }\n'
      + '    : parseAmount(payload.amount)',
    mustRed: '金额非法三类拒绝' },
  { name: '变异4：边界判定改成严格小于（恰等于限额被判成越界）',
    find: '  const inside = amount <= own.limit_cents',
    replace: '  const inside = amount < own.limit_cents',
    mustRed: '三例边界值手算对账' },
]

/** 四条"必须红"的场景各自的判据（基线必须全真，否则变异变红说明不了任何事）。 */
const factsFor = async (mountFn) => {
  const base = await mountFn({})
  const handle = base.box.handle
  const run = (payload) => handle.check(payload)
  const facts = {}

  // ---- ① 三例边界值手算对账 ----
  try {
    const rows = HAND_BOUNDARY.map((hand) => {
      const out = run({ view: 'contractor', role: hand.role, amount: hand.amount, config: cfgFor() })
      return { hand, out }
    })
    facts['三例边界值手算对账'] = rows.every(({ hand, out }) =>
      out.amount === hand.amount && out.unit === 'cents' && out.inside_band === hand.inside
      && out.over_by === hand.over && out.required_role === hand.required && out.next_role === hand.next
      && (hand.esc ? out.escalate_cmd.length > 0 : out.escalate_cmd === '')
      && out.unconfigured === false && out.degraded === (hand.esc === true)
      && (hand.esc ? out.reason === 'over-band' : out.reason === '')
      && out.can_approve === false)
      // 独立性：三例必须给出**不同**的中间结论（否则"值全对"可能是巧合）
      && rows[1].out.inside_band === false && rows[0].out.inside_band === true && rows[2].out.inside_band === true
      && rows[1].out.over_by === 1 && rows[0].out.over_by === 0 && rows[2].out.over_by === 0
  } catch (err) { facts['三例边界值手算对账'] = `threw:${err.name}` }

  // ---- ② 未配置不得编限额 ----
  try {
    const cases = [
      run({ view: 'contractor', role: 'agent', amount: 1, config: cfgFor() }),                    // 角色没登记
      run({ view: 'contractor', amount: 1, config: cfgFor() }),                                   // 没给角色
      run({ view: 'contractor', role: 'buyer', amount: 1 }),                                      // 配置快照缺失
      run({ view: 'contractor', role: 'buyer', amount: 1, config: cfgFor({ 'authority.unit': 'yuan' }) }),
    ]
    facts['未配置不得编限额'] = cases.every((out) => out.unconfigured === true && out.inside_band === null
      && out.required_role === '' && out.next_role === '' && out.over_by === null
      && out.escalate_cmd === '' && out.escalate_human_cmd === ''
      && HAND_UNCONFIGURED_REASONS.includes(out.reason) && out.can_approve === false)
      // 四种原因的**码不重复**（四类各自有名，不是一句含糊的"未配置"）
      && new Set(cases.map((out) => out.reason)).size === 4
      // null ≠ 0：人明确登记 0 分 ⇒ 那是"已配置"（0 分限额下 1 分就是越界 1 分）
      && (() => {
        const zero = run({ view: 'contractor', role: 'buyer', amount: 1, config: cfgFor({ 'authority.bands.buyer': 0 }) })
        const zeroAtZero = run({ view: 'contractor', role: 'buyer', amount: 0, config: cfgFor({ 'authority.bands.buyer': 0 }) })
        return zero.unconfigured === false && zero.inside_band === false && zero.over_by === 1
          && zeroAtZero.inside_band === true && zeroAtZero.over_by === 0
      })()
  } catch (err) { facts['未配置不得编限额'] = `threw:${err.name}` }

  // ---- ③ 越界必出升级命令 ----
  try {
    const over = run({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor() })
    const inside = run({ view: 'contractor', role: 'buyer', amount: 500000, config: cfgFor() })
    facts['越界必出升级命令'] = over.escalate_cmd.startsWith('tools/verify.sh ')
      && over.escalate_cmd.includes('#') && over.escalate_human_cmd.includes('quotagent.g1side')
      && over.blocked_by === 'human-gate-required' && over.status === 'over-band'
      && inside.escalate_cmd === '' && inside.escalate_human_cmd === '' && inside.blocked_by === ''
  } catch (err) { facts['越界必出升级命令'] = `threw:${err.name}` }

  // ---- ④ 金额非法三类拒绝 ----
  try {
    const bad = [
      run({ view: 'contractor', role: 'buyer', amount: -1, config: cfgFor() }),
      run({ view: 'contractor', role: 'buyer', amount: 500000.5, config: cfgFor() }),
      run({ view: 'contractor', role: 'buyer', amount: HAND_AMOUNT_MAX + 1, config: cfgFor() }),
    ]
    const good = run({ view: 'contractor', role: 'buyer', amount: HAND_AMOUNT_MAX, config: cfgFor() })
    facts['金额非法三类拒绝'] = bad[0].code === 'amount-negative' && bad[1].code === 'amount-not-an-integer'
      && bad[2].code === 'amount-out-of-range'
      && bad.every((out) => out.inside_band === null && out.escalate_cmd === '' && out.next_action.length > 10
        && out.status === 'input-rejected')
      && good.code === '' && good.status === 'over-band'
  } catch (err) { facts['金额非法三类拒绝'] = `threw:${err.name}` }

  return facts
}

try {
  // ---------- 1. 契约正控 ----------
  const imports = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  const keysText = sourceOf(join(HERE, 'lib', 'config-keys.mjs'))
  const registeredInKeys = [...keysText.matchAll(/'(authority\.bands\.[a-z0-9_-]+)':/g)]
    .map((match) => match[1].slice('authority.bands.'.length)).sort()
  const manifest = {
    name: mod.name === 'authority-band' && mod.provides.length === 1 && mod.provides[0] === 'authorityBand',
    engine: mod.ENGINE === 'rules' && mod.ENGINE_NOTE.includes('不能批准'),
    unit: mod.MONEY_UNIT === 'cents' && mod.SUPPORTED_UNITS.length === 1 && mod.SUPPORTED_UNITS[0] === 'cents',
    statuses: JSON.stringify(mod.STATUSES)
      === JSON.stringify(['inside-band', 'over-band', 'unconfigured', 'input-rejected']),
    reasons: mod.REASONS.length === 10 && mod.REASONS.includes('over-band') && mod.REASONS.includes('band-unconfigured'),
    refusals: mod.REFUSAL_CODES.length === 9 && !mod.REFUSAL_CODES.includes('over-band'),
    blockedBy: JSON.stringify(mod.BLOCKED_BY_VALUES) === JSON.stringify(['', 'human-gate-required',
      'authority-unconfigured', 'input-rejected']),
    // 登记的角色必须与 config-keys.mjs 的 `authority.bands.*` 逐字一致（防两侧漂移）
    roles: JSON.stringify([...mod.REGISTERED_ROLES].sort()) === JSON.stringify(registeredInKeys),
    keysMatch: registeredInKeys.length === 3 && mod.BAND_PREFIX === 'authority.bands.'
      && mod.UNIT_KEY === 'authority.unit' && mod.CURRENCY_KEY === 'authority.currency'
      && mod.FALLBACK_ROLE_KEY === 'authority.fallback_role'
      && mod.ESCALATION_NOTE_KEY === 'authority.escalation_note',
    escalate: mod.ESCALATE_COMMAND.startsWith('tools/verify.sh ')
      && mod.ESCALATE_HUMAN_COMMAND.includes('python3 -m quotagent.g1side')
      && mod.APPROVAL_NOTE.includes('不能'),
    ignored: JSON.stringify(mod.IGNORED_NOW_INPUTS) === JSON.stringify(['payload.now', 'config.now']),
    fn: typeof mod.checkOf === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 与常量齐备（`unit=cents` / 闭合的 `REASONS`/`REFUSAL_CODES`/`STATUSES`/'
    + '`BLOCKED_BY_VALUES` / `REGISTERED_ROLES` 与 `host/lib/config-keys.mjs` 的 `authority.bands.*` **逐字一致** / '
    + '升级命令形状 / `ignored_now_inputs`）+ `checkOf` 是函数；只 import ../lib 白名单（或 node:）；'
    + '源码里 0 个脚本字面量',
  manifestBad.length === 0 && importLeaks.length === 0 && !originalSource.includes(scriptNeedle) && hookReady,
  `问题键=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；`
  + `含脚本字面量=${originalSource.includes(scriptNeedle)}；解析钩子=${hookReady ? '已装' : '不可用'}；`
  + `登记角色（config-keys）=${JSON.stringify(registeredInKeys)}；字节=${Buffer.byteLength(originalSource)}`)

  // ---------- 2. 挂载 + 零残留 ----------
  const EXPECTED_KEYS = ['check', 'config', 'meta', 'requests']   // 3 个只读方法 + 1 个声明清单（服务面即此）
  const probe = await mountWith({})
  const methods = Object.keys(probe.box.handle ?? {}).sort()
  const probeEffects = probe.fiber.getEffects().length
  await probe.fiber.dispose()
  const probeAfter = probe.fiber.getEffects().length
  check('2 挂载正控：`ctx.provide(\'authorityBand\')` 拿得到句柄，服务面**恰 4 个键**（`check` / `config` / `meta` '
    + '三个只读方法 + `requests` 声明清单）且不含任何审批类方法；dispose 后 effect 归零',
  typeof probe.box.handle?.check === 'function' && JSON.stringify(methods) === JSON.stringify(EXPECTED_KEYS)
  && typeof probe.box.handle?.requests?.includes === 'function' && probeEffects > 0 && probeAfter === 0,
  `句柄键=${methods.join('|')}（期望 ${EXPECTED_KEYS.join('|')}）；requests=${JSON.stringify(probe.box.handle?.requests)}；`
  + `effect ${probeEffects} → ${probeAfter}`)

  const live = await mountWith({})
  const runCheck = (payload) => live.box.handle.check(payload)
  const meta = live.box.handle.meta()

  // ---------- 3. 三例边界值逐条对账（核心）----------
  const boundaryRows = HAND_BOUNDARY.map((hand) => {
    const out = runCheck({ view: 'contractor', role: hand.role, amount: hand.amount, config: cfgFor() })
    const ok = out.inside_band === hand.inside && out.over_by === hand.over
      && out.required_role === hand.required && out.next_role === hand.next
      && (hand.esc ? out.escalate_cmd.length > 0 : out.escalate_cmd === '')
    return `${hand.label}（${hand.role} 限额 ${HAND_BANDS[hand.role]} 分、金额 ${hand.amount} 分）手算：`
      + `在区间内=${hand.inside} 越界 ${hand.over} 分 需 ${hand.required} 批 / 下一个能批的人 ${hand.next}`
      + ` / 升级命令 ${hand.esc ? '有' : '无'} ｜实得：在区间内=${out.inside_band} 越界 ${out.over_by} 分`
      + ` 需 ${out.required_role || '（空）'} 批 / 下一个 ${out.next_role || '（空）'} / 升级命令 `
      + `${out.escalate_cmd === '' ? '无' : '有'} ｜${ok ? '一致' : '**不一致**'}`
  })
  const boundaryIndependent = runCheck({ view: 'contractor', role: 'buyer', amount: 499999, config: cfgFor() }).inside_band === true
    && runCheck({ view: 'contractor', role: 'buyer', amount: 500000, config: cfgFor() }).inside_band === true
    && runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor() }).inside_band === false
  check('3 **三例边界值逐条对账**（本门最核心的一条）：恰等于限额（500000/500000）与超一分（500001）、'
    + '差一分（499999）三例的 `inside_band`/`over_by`/`required_role`/`next_role`/有无升级命令'
    + '**全部等于手算值**；且三例的结论确实不同（不是一句"都对"混过去）',
  boundaryRows.every((line) => line.endsWith('一致')) && boundaryIndependent,
  boundaryRows.join('；'))

  // ---------- 4. 谁能批到多少（bands / within 全表手算）----------
  const withinRows = Object.entries(HAND_WITHIN).map(([amountText, hand]) => {
    const out = runCheck({ view: 'contractor', role: 'buyer', amount: Number(amountText), config: cfgFor() })
    const got = out.within.map((item) => `${item.role}/${item.limit_cents}/${item.remaining_cents}`)
    const want = hand.map(([role, limit, remaining]) => `${role}/${limit}/${remaining}`)
    return `金额 ${amountText} ⇒ 手算 ${JSON.stringify(want)} ｜实得 ${JSON.stringify(got)}`
      + ` ｜${JSON.stringify(want) === JSON.stringify(got) ? '一致' : '**不一致**'}`
  })
  const overAll = runCheck({ view: 'contractor', role: 'buyer', amount: 999999999999, config: cfgFor() })
  const bandsListed = runCheck({ view: 'contractor', role: 'buyer', amount: 0, config: cfgFor() }).bands
  check('4 **谁能批到多少**：`bands` 全表 3 条（按限额升序 buyer/lead/director = 500000/2000000/10000000）'
    + '；`within` 覆盖列表逐条手算（金额 500001 ⇒ lead 剩 1499999、director 剩 9499999；2000001 ⇒ director '
    + '剩 7999999；超过所有限额 ⇒ **空表**且 `required_role`/`next_role` 都留空 —— 不编一个人名，'
    + '但**仍然**给升级命令）',
  withinRows.every((line) => line.endsWith('一致'))
  && JSON.stringify(bandsListed.map((item) => `${item.role}/${item.limit_cents}`))
    === JSON.stringify(['buyer/500000', 'lead/2000000', 'director/10000000'])
  && overAll.within.length === 0 && overAll.required_role === '' && overAll.next_role === ''
  && overAll.escalate_cmd.length > 0 && overAll.status === 'over-band' && overAll.unconfigured === false,
  withinRows.join('；') + `；全表=${JSON.stringify(bandsListed.map((item) => item.role))}；`
  + `超过所有限额 ⇒ within=${overAll.within.length} required=${overAll.required_role || '（空）'} `
  + `next=${overAll.next_role || '（空）'} 升级命令=${overAll.escalate_cmd === '' ? '无（**问题**）' : '有'}`)

  // ---------- 5. 未配置不得编限额 ----------
  const unconfiguredCases = [
    ['角色没登记（agent）', { view: 'contractor', role: 'agent', amount: 1, config: cfgFor() }],
    ['角色登记为 null（lead）', { view: 'contractor', role: 'lead', amount: 1, config: cfgFor({ 'authority.bands.lead': null }) }],
    ['配置快照缺失', { view: 'contractor', role: 'buyer', amount: 1 }],
    ['配置快照不是对象', { view: 'contractor', role: 'buyer', amount: 1, config: 'nope' }],
    ['单位声明非 cents（yuan）', { view: 'contractor', role: 'buyer', amount: 1, config: cfgFor({ 'authority.unit': 'yuan' }) }],
    ['没给角色', { view: 'contractor', amount: 1, config: cfgFor() }],
  ]
  const unconfiguredRows = unconfiguredCases.map(([label, payload]) => {
    const out = runCheck(payload)
    const ok = out.unconfigured === true && out.inside_band === null && out.over_by === null
      && out.required_role === '' && out.next_role === '' && out.escalate_cmd === ''
      && HAND_UNCONFIGURED_REASONS.includes(out.reason) && out.degraded === true
      && out.status === 'unconfigured' && out.can_approve === false
    return `${label}→${out.reason}/unconfigured=${out.unconfigured}/required='${out.required_role}'/next='${out.next_role}'`
      + `/inside=${out.inside_band}/esc='${out.escalate_cmd}'｜${ok ? '一致' : '**不一致**'}`
  })
  const zeroBand = runCheck({ view: 'contractor', role: 'buyer', amount: 1, config: cfgFor({ 'authority.bands.buyer': 0 }) })
  const zeroAtZero = runCheck({ view: 'contractor', role: 'buyer', amount: 0, config: cfgFor({ 'authority.bands.buyer': 0 }) })
  check('5 **未配置不得编限额**（硬负控）：角色没登记 / 限额为 `null` / 配置快照缺失 / 快照不是对象 / '
    + '单位声明非 `cents` / 没给角色 六类 ⇒ `unconfigured=true` + **有名** reason + '
    + '`required_role`/`next_role` **都为空** + `inside_band=null` + **无升级命令**（不编结论、不编命令）；'
    + '且 `null`（未配置）与 `0`（人明确登记"一分也不能批"）是**两件事**：0 分限额下 1 分 ⇒ 越界 1 分、0 分 ⇒ 在区间内',
  unconfiguredRows.every((line) => line.endsWith('一致'))
  && zeroBand.unconfigured === false && zeroBand.inside_band === false && zeroBand.over_by === 1
  && zeroAtZero.inside_band === true && zeroAtZero.over_by === 0,
  unconfiguredRows.join('；') + `；零限额对照：1 分 ⇒ unconfigured=${zeroBand.unconfigured}/越界 ${zeroBand.over_by} 分、`
  + `0 分 ⇒ 在区间内=${zeroAtZero.inside_band}`)

  // ---------- 6. 金额非法三类拒绝 ----------
  const badAmounts = [
    ['负数 -1', -1, 'amount-negative'],
    ['负数串 "-500"', '-500', 'amount-negative'],
    ['浮点 500000.5', 500000.5, 'amount-not-an-integer'],
    ['小数串 "500000.5"', '500000.5', 'amount-not-an-integer'],
    ['科学计数 "5e5"', '5e5', 'amount-not-an-integer'],
    ['非数字串 "abc"', 'abc', 'amount-not-an-integer'],
    ['null', null, 'amount-missing'],
    ['空串 ""', '', 'amount-missing'],
    ['超上限 AMOUNT_MAX+1', HAND_AMOUNT_MAX + 1, 'amount-out-of-range'],
  ]
  const badRows = badAmounts.map(([label, amount, code]) => {
    const out = runCheck({ view: 'contractor', role: 'buyer', amount, config: cfgFor() })
    const ok = out.code === code && out.reason === code && out.next_action.length > 10
      && out.inside_band === null && out.over_by === null && out.escalate_cmd === ''
      && out.status === 'input-rejected' && out.required_role === '' && out.next_role === ''
    return `${label} ⇒ ${out.code}（期望 ${code}）/next_action ${out.next_action.length} 字/inside=${out.inside_band}`
      + `｜${ok ? '一致' : '**不一致**'}`
  })
  const goodAmounts = [
    ['整数串 "500000"', '500000', 'inside-band'],
    ['恰等于 AMOUNT_MAX', HAND_AMOUNT_MAX, 'over-band'],
    ['0 分', 0, 'inside-band'],
  ]
  const goodRows = goodAmounts.map(([label, amount, status]) => {
    const out = runCheck({ view: 'contractor', role: 'buyer', amount, config: cfgFor() })
    return `${label} ⇒ ${out.status}（期望 ${status}）`
  })
  check('6 金额非法**三类**拒绝（负数 / 非整数 / 超上限），每类给**具体 code** + 非空 `next_action` + '
    + '**不给结论**（`inside_band=null`、无升级命令、`required_role`/`next_role` 空）；'
    + '**非空转对照**：同批合法金额（整数串 / 0 分 / 恰等于 AMOUNT_MAX）照旧给结论',
  badRows.every((line) => line.endsWith('一致'))
  && goodRows.every((line) => /⇒ (inside-band|over-band)（期望 (inside-band|over-band)）/.test(line)),
  [...badRows, ...goodRows].join('；'))

  // ---------- 7. 越界必出升级命令 + 命令真存在 ----------
  let helpOut = ''
  let helpErr = ''
  try {
    helpOut = execFileSync('sh', [VERIFY_SH, 'help'], { encoding: 'utf8', timeout: 60000 })
  } catch (err) {
    helpErr = `${err.name}:${String(err.message).slice(0, 80)}`
  }
  const gateName = mod.ESCALATE_COMMAND.replace('tools/verify.sh ', '').split(/\s+/)[0]
  const humanGateName = mod.ESCALATE_HUMAN_COMMAND.includes('quotagent.g1side') ? 'quotagent.g1side' : ''
  const overCase = runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor() })
  const insideCase = runCheck({ view: 'contractor', role: 'buyer', amount: 500000, config: cfgFor() })
  check('7 **越界必出升级命令、且命令真存在**：越界 ⇒ `escalate_cmd` 以 `tools/verify.sh <门名>` 开头，'
    + '该门名**真的出现在** `tools/verify.sh help` 的输出里（本门真跑那个命令）；人工签署命令指向 '
    + '`quotagent.g1side`（`src/quotagent/g1side.py` 文件真存在）；`blocked_by=human-gate-required`；'
    + '**双向**：不越界时 `escalate_cmd` 与 `escalate_human_cmd` 都为空（不发无用命令）',
  overCase.escalate_cmd.startsWith('tools/verify.sh ') && gateName.length > 1
  && helpOut.includes(gateName) && helpErr === ''
  && existsSync(G1SIDE) && humanGateName === 'quotagent.g1side'
  && overCase.escalate_human_cmd.includes('.py') === false
  && overCase.escalate_human_cmd.includes('python3') && overCase.blocked_by === 'human-gate-required'
  && insideCase.escalate_cmd === '' && insideCase.escalate_human_cmd === '',
  `门名=${gateName}（help 里找到=${helpOut.includes(gateName)}；help stderr=${helpErr || '无'}）；`
  + `越界命令=${JSON.stringify(overCase.escalate_cmd)}；人工签署=${JSON.stringify(overCase.escalate_human_cmd)}；`
  + `g1side.py 存在=${existsSync(G1SIDE)}；不越界时 esc='${insideCase.escalate_cmd}'`)

  // ---------- 8. 插件不能批准 ----------
  const APPROVAL_METHODS = ['approve', 'decide', 'grant', 'submit', 'ack', 'allow', 'reject', 'veto', 'sign']
  const methodHits = APPROVAL_METHODS.filter((name) => methods.includes(name))
  const approvalOutputs = [
    runCheck({ view: 'contractor', role: 'buyer', amount: 500000, config: cfgFor() }),
    overCase, insideCase,
    runCheck({ view: 'contractor', role: 'agent', amount: 1, config: cfgFor() }),
    runCheck({ view: 'contractor', role: 'buyer', amount: -1, config: cfgFor() }),
  ]
  const approvalHits = APPROVAL_METHODS.filter((name) => new RegExp(`(^|\\s)${name}\\s*=`, 'm').test(originalSource))
  check('8 **插件不能批准**（硬负控）：服务面里没有任何 `approve/decide/grant/submit/ack/allow/reject` 类方法'
    + '（方法集恰 `check|config|meta`）、`meta.can_approve=false`、**每一条输出**都带 `can_approve=false` '
    + '与含「不能」字样的 `approval_note`、源码里 0 处审批方法定义',
  methodHits.length === 0 && meta.can_approve === false
  && approvalOutputs.every((out) => out.can_approve === false && out.approval_note.includes('不能'))
  && approvalHits.length === 0 && String(meta.approval_note).includes('不能'),
  `方法集=${methods.join('|')}；审批类命中=${methodHits.join(',') || '无'}；`
  + `每条输出 can_approve=false=${approvalOutputs.filter((out) => out.can_approve === false).length}/${approvalOutputs.length}；`
  + `源码审批方法定义=${approvalHits.join(',') || '无'}；meta.can_approve=${meta.can_approve}`)

  // ---------- 9. 确定性 ----------
  const payload = { view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor() }
  const d1 = JSON.stringify(runCheck(payload))
  const d2 = JSON.stringify(runCheck(payload))
  const shuffled = { config: cfgFor(), amount: 500001, role: 'buyer', view: 'contractor' }
  const d3 = JSON.stringify(runCheck(shuffled))
  const reversedConfig = Object.fromEntries(Object.entries(cfgFor()).reverse())
  const d4 = JSON.stringify(runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: reversedConfig }))
  const clockA = await mountWith({ now: '2001-01-01T00:00:00Z' })
  const clockB = await mountWith({ now: '2038-01-01T00:00:00Z' })
  const d5 = JSON.stringify(clockA.box.handle.check({ ...payload, now: '1999-01-01T00:00:00Z' }))
  const d6 = JSON.stringify(clockB.box.handle.check(payload))
  const other = await mountWith({})
  const d7 = JSON.stringify(other.box.handle.check(payload))
  const frozen = JSON.stringify(runCheck(deepFreeze(JSON.parse(JSON.stringify(payload)))))
  const timeKeys = /"(ts|at|now|time|elapsed|date|generated_at)"\s*:/.test(d1)
  check('9 确定性负控：同输入两次**逐字节一致** / 键序打乱一致 / 配置键序逆序一致 / 跨实例一致 / '
    + '两个墙钟入口（载荷 `now` 与配置 `now`）给任何值输出都不变 / **冻结输入**不抛错'
    + '（严格模式下任何对入参的写入都会抛 TypeError ⇒ 证明没偷偷改调用方的载荷）/ 输出里没有时间键',
  d1 === d2 && d2 === d3 && d3 === d4 && d4 === d5 && d5 === d6 && d6 === d7 && frozen === d1
  && d1.length > 600 && !timeKeys,
  `两次=${d1 === d2} 键序=${d2 === d3} 配置逆序=${d3 === d4} 墙钟A=${d4 === d5} 墙钟B=${d5 === d6} `
  + `跨实例=${d6 === d7} 冻结输入=${frozen === d1} 长度=${d1.length} 含时间键=${timeKeys}`)

  // ---------- 10. 有界 ----------
  const manyConfig = { 'authority.unit': 'cents' }
  for (let index = 0; index < 11; index += 1) manyConfig[`authority.bands.r${String(index).padStart(2, '0')}`] = 100 * (index + 1)
  const cap3 = await mountWith({ max_roles: 3 })
  const cap0 = await mountWith({ max_roles: 0 })
  const cap1000 = await mountWith({ max_roles: 1000 })
  const cap3Out = cap3.box.handle.check({ view: 'contractor', role: 'r00', amount: 100, config: manyConfig })
  const cap0Out = cap0.box.handle.check({ view: 'contractor', role: 'r00', amount: 100, config: manyConfig })
  const cap1000Out = cap1000.box.handle.check({ view: 'contractor', role: 'r00', amount: 100, config: manyConfig })
  const manyOut = runCheck({ view: 'contractor', role: 'r00', amount: 100, config: manyConfig })
  const maxBoundary = runCheck({ view: 'contractor', role: 'buyer', amount: HAND_AMOUNT_MAX, config: cfgFor() })
  check('10 有界与诚实：`max_roles` 夹取（在**同一份 11 条角色**的输入上：3 ⇒ 只读 3 条并**如实报** '
    + '`roles_omitted=8`、0 ⇒ 下界 1 条、1000 ⇒ 上界 8 条）；默认 8 ⇒ 读 8 条 + `roles_omitted=3` + '
    + '`truncated=true`（省略照实报，不静默丢）；读入的角色**确定性**（按键名字典序取前 N）；'
    + '金额上限边界：恰等于 AMOUNT_MAX 可判（over-band）、AMOUNT_MAX+1 拒（`amount-out-of-range`）',
  cap3Out.counts.roles_configured === 3 && cap3Out.counts.roles_omitted === 8 && cap3Out.truncated === true
  && JSON.stringify(cap3Out.bands.map((item) => item.role)) === JSON.stringify(['r00', 'r01', 'r02'])
  && cap0Out.counts.roles_configured === 1 && cap0Out.counts.roles_omitted === 10
  && cap1000Out.counts.roles_configured === 8 && cap1000Out.counts.roles_omitted === 3
  && manyOut.counts.roles_configured === 8 && manyOut.counts.roles_omitted === 3 && manyOut.truncated === true
  && manyOut.bands.length === 8 && maxBoundary.status === 'over-band'
  && runCheck({ view: 'contractor', role: 'buyer', amount: HAND_AMOUNT_MAX + 1, config: cfgFor() }).code === 'amount-out-of-range',
  `max_roles=3 ⇒ 读 ${cap3Out.counts.roles_configured}（${cap3Out.bands.map((item) => item.role).join(',')}）`
  + `/省略 ${cap3Out.counts.roles_omitted}（truncated=${cap3Out.truncated}）；`
  + `max_roles=0 ⇒ 读 ${cap0Out.counts.roles_configured}/省略 ${cap0Out.counts.roles_omitted}；`
  + `max_roles=1000 ⇒ 读 ${cap1000Out.counts.roles_configured}/省略 ${cap1000Out.counts.roles_omitted}；`
  + `默认 ⇒ 读 ${manyOut.counts.roles_configured}/省略 ${manyOut.counts.roles_omitted}；`
  + `AMOUNT_MAX=${HAND_AMOUNT_MAX} ⇒ ${maxBoundary.status}`)

  // ---------- 11. 私域哨兵零泄漏 ----------
  const privateBase = { cost_floor: 1, markup_pct: 12.5, reserve_price: 2, cost_model: 'x', 'private:note': 'y',
    'authority.bands.BUYER-SENT': HAND_BANDS.buyer }
  const privateDirty = { cost_floor: HAND_SENTINELS[0], markup_pct: 99.5, reserve_price: HAND_SENTINELS[2],
    cost_model: HAND_SENTINELS[1], 'private:note': HAND_SENTINELS[4],
    'authority.bands.BUYER-SENT': HAND_BANDS.buyer + 1 }
  const cleanText = JSON.stringify(runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor(privateBase) }))
  const dirtyText = JSON.stringify(runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor(privateDirty) }))
  const dirtyHits = HAND_SENTINELS.filter((needle) => dirtyText.includes(needle))
  const dirtyKeys = PRIVATE_NEEDLES.filter((needle) => dirtyText.includes(needle))
  const inputHits = HAND_SENTINELS.filter((needle) => JSON.stringify(privateDirty).includes(needle))
  const badRoleKept = runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor(privateDirty) }).bands
  check('11 **私域哨兵零泄漏（两面）**：同一键集、不同私域值 ⇒ 输出**逐字节一致**（不是"藏起来"，是根本没读）；'
    + '哨兵与私域键名 0 命中；坏角色名的 `authority.bands.*` 键（含哨兵）**读都不读**（不进区间表、不回显）；'
    + '**非空转对照**：哨兵确实在输入里（命中 ≥3）',
  dirtyText === cleanText && dirtyHits.length === 0 && dirtyKeys.length === 0 && inputHits.length >= 3
  && badRoleKept.length === 3 && !badRoleKept.some((item) => item.role.includes('SENT'))
  && runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor(privateBase) }).privacy.private_keys_read === false,
  `逐字节一致=${dirtyText === cleanText}；哨兵命中=${dirtyHits.join(',') || '无'}；私域键名命中=${dirtyKeys.join(',') || '无'}；`
  + `输入对照=${inputHits.length} 个哨兵；区间表=${badRoleKept.map((item) => item.role).join('|')}`)

  // ---------- 12. 零写面 / 不取墙钟 ----------
  const FORBIDDEN = ['writeFile', 'appendFile', 'createWriteStream', 'readFileSync', 'openLedger', 'ledger',
    'Date.now', 'new Date', 'Math.random', 'process.env', 'fetch(', 'spawn', 'execFile', 'setInterval(',
    'setTimeout(', 'ctx.on(', 'ctx.events', 'child_process', 'require(', 'http.request', 'net.connect']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(originalSource)
  const selfTest = scan(`const t = set${'Timeout'}(() => {}, 1); open${'Ledger'}(p); await fetch${'('}(u)`)
  const privacyProbe = runCheck(payload).privacy
  check('12 零写面负控：产物**零写面、不读账本、不联网、不调模型、不取墙钟**（无写/读文件、账本、墙钟、随机、'
    + '网络、子进程、事件订阅、定时器）；`privacy` 四项如实申报；扫描器**非空转**（对照样本必须命中 ≥3）',
  hits.length === 0 && selfTest.length >= 3 && privacyProbe.model_calls === 0
  && privacyProbe.network_calls === 0 && privacyProbe.clock_reads === 0
  && privacyProbe.private_keys_read === false
  && JSON.stringify(runCheck(payload).ignored_now_inputs) === JSON.stringify(['payload.now', 'config.now']),
  `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}；`
  + `privacy=${JSON.stringify(privacyProbe)}`)

  // ---------- 13. 宿主侧契约（静态）----------
  const routeOk = /\/api\/authority/.test(webuiSource) && /\/authority\//.test(webuiSource)
    && webuiSource.includes('authority.check(') && webuiSource.includes('authorityConfigSnapshot')
  const navDecls = webuiSource.split('data-authority-link').length - 1
  const navLabels = ['授权区间（承包商）', '授权区间（供应商）'].every((label) => webuiSource.includes(label))
  const startPageOk = webuiSource.includes('授权区间在哪里配') && webuiSource.includes('authority.bands.&lt;角色&gt;')
  const webuiCode = webuiSource.split('\n').filter((line) => !line.trim().startsWith('//')
    && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n')
  check('13 宿主侧契约（静态）：两条新路由（`/<view>/authority/` 与 `/<view>/api/authority`）都在 webui 里、'
    + '宿主用只读配置快照（`authorityConfigSnapshot`）驱动插件；**四道页面**子导航入口齐（`subNav` 与 '
    + '`anchorNav` 两处声明 + 运维/系统管理两道各传两个入口标签）；`/start/` 上手页有「授权区间在哪里配」段；'
    + '页面模板 **0 内联脚本 / 0 内联事件**（扫描器非空转）',
  routeOk && navDecls >= 2 && navLabels && startPageOk
  && !webuiCode.includes(scriptNeedle) && !inlineEvent.test(webuiCode)
  && (scriptNeedle === '<scr' + 'ipt' && inlineEvent.test('<a onclick="x()">')),
  `路由=${routeOk} 导航声明=${navDecls} 入口标签=${navLabels} 上手页段=${startPageOk}；`
  + `webui 含脚本字面量=${webuiCode.includes(scriptNeedle)} 含内联事件=${inlineEvent.test(webuiCode)}`)

  // ---------- 14/15. 真 HTTP ----------
  const fixtureDir = mkdtempSync(join(tmpdir(), 't284-http-'))
  const contractorLedger = join(fixtureDir, 'contractor.jsonl')
  const supplierLedger = join(fixtureDir, 'supplier.jsonl')
  const yamlPath = join(fixtureDir, 'config.yaml')
  const uiShared = join(fixtureDir, 'ui-shared')
  mkdirSync(uiShared, { recursive: true })
  const ledgerRows = [
    { seq: 1, type: 'rfq/published', correlation_id: 'pkg-015', actor: 'agent:sourcing',
      ts: '2026-09-21T15:00:00Z', realm: 'contractor:con-B', body: { package_id: 'pkg-015', rev: 1 } },
  ]
  writeFileSync(contractorLedger, ledgerRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  writeFileSync(supplierLedger, ledgerRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  /** 临时受管配置夹具（**绝不碰真 /workspace/config.yaml**）：哨兵写在别的**已登记**键上。 */
  const yamlFor = (buyerLimit) => ['project:',
    '  authority.unit: cents',
    '  authority.currency: CNY',
    `  authority.bands.buyer: ${buyerLimit}`,
    '  authority.bands.lead: 2000000',
    '  authority.bands.director: 10000000',
    '  authority.fallback_role: director',
    "  authority.escalation_note: '越界请找业主代表走终端人工门'",
    `  transport.dir: '${HAND_SENTINELS[0]}'`,
    '  pricing.markup_pct: 987654321',
    ''].join('\n')
  writeFileSync(yamlPath, yamlFor(500000), 'utf8')

  const httpCtx = new Context()
  await httpCtx.plugin(EventsService)
  httpCtx.provide('ledgerView', { path: '(t284-fixture)', rows: () => [], count: () => 0,
    verify: () => ({ ok: true, checked: 0, count: 0, head: 'sha256:' + '0'.repeat(64) }), byType: () => [] })
  const httpBox = {}
  const mountReal = async (file, raw, service, name, override = null) => {
    const loaded = await import(pathToFileURL(join(HERE, 'modules', file)).href)
    await httpCtx.plugin({
      name: `${name}#t284`,
      inject: loaded.inject ?? [],
      Config: loaded.Config,
      apply: async (inner, config) => {
        const originalProvide = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) httpBox[service] = v; return originalProvide(s, v) }
        await loaded.apply(inner, override ? { ...config, ...override } : config)
      },
    }, loaded.Config.parse(raw))
    return loaded
  }
  await mountReal('governor.mjs', {}, 'governor', 'governor')
  await mountReal('audit-hook.mjs', { capacity: 20 }, 'audit', 'audit-hook')
  await mountReal('canary.mjs', { weight_bps: 0 }, 'canary', 'canary')
  await mountReal('observability.mjs', {}, 'observability', 'observability')
  await mountReal('price-history.mjs', { key_field: 'supplier_id' }, 'priceHistory', 'price-history')
  await mountReal('evidence-summary.mjs', {}, 'evidenceSummary', 'evidence-summary')
  await mountReal('circuit-breaker.mjs', {}, 'breaker', 'circuit-breaker')
  await mountReal('ops-view.mjs', {}, 'opsView', 'ops-view')
  await mountReal('evolve-journal.mjs', {}, 'evolveJournal', 'evolve-journal')
  await mountReal('supplier-scorecard.mjs', {}, 'supplierScorecard', 'supplier-scorecard')
  await mountReal('approval-digest.mjs', {}, 'approvalDigest', 'approval-digest')
  await mountReal('retention-view.mjs', {}, 'retentionView', 'retention-view')
  await mountReal('pipeline-view.mjs', {}, 'pipelineView', 'pipeline-view')
  await mountReal('admin-view.mjs', { admin_snapshot: '' }, 'adminView', 'admin-view')
  await mountReal('admin-guard.mjs', { token_env: 'QUOTAGENT_ADMIN_TOKEN_T284' }, 'adminGuard', 'admin-guard')
  await mountReal('plugin-market.mjs', { modules_dir: join(HERE, 'modules'),
    inventory: join(HERE, '..', 'docs', 'design', '14-plugin-inventory.md'), user_space: '' }, 'pluginMarket', 'plugin-market')
  await mountReal('user-plugin-manager.mjs', { root: join(HERE, '..', 'user-space') }, 'userPluginManager', 'user-plugin-manager')
  // 配置与凭据（config-view）：受管配置文件指向**临时夹具**（不读、更不写真 /workspace/config.yaml）
  await mountReal('config-view.mjs', {}, 'configView', 'config-view',
    { config_file: yamlPath, config_inbox: '', config_status: '', config_ledger: '', runtime_overrides: '' })
  await mountReal('mail-view.mjs', { mail_state: '', ui_shared: '' }, 'mailView', 'mail-view')
  await mountReal('bid-heuristics.mjs', {}, 'bidHeuristics', 'bid-heuristics')
  await mountReal('advice-panel.mjs', {}, 'advicePanel', 'advice-panel')
  await mountReal('gate-timeline.mjs', {}, 'gateTimeline', 'gate-timeline')
  await mountReal('authority-band.mjs', {}, 'authorityBand', 'authority-band')
  await mountReal('rfq-deadline.mjs', {}, 'rfqDeadline', 'rfq-deadline')
  // 同批新增的 `quote-prepare`（webui 的 inject 依赖它）：同为 domain 插件，默认配置即可
  await mountReal('quote-prepare.mjs', {}, 'quotePrepare', 'quote-prepare')
  await mountReal('ui-feedback.mjs', { ui_shared: '' }, 'uiFeedback', 'ui-feedback')
  const projection = await import(pathToFileURL(join(HERE, 'modules', 'projection.mjs')).href)
  await httpCtx.plugin({ name: 'projection#t284', inject: [], Config: projection.Config,
    apply: (inner, config) => projection.apply(inner, config) }, projection.Config.parse({}))
  const webui = await import(pathToFileURL(WEBUI).href)
  const httpFiber = await httpCtx.plugin({
    name: 'webui#t284',
    inject: webui.inject,
    Config: webui.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'webui') httpBox.webui = v; return originalProvide(s, v) }
      await webui.apply(inner, config)
    },
  }, webui.Config.parse({ port: 0, route_prefix: '/t284', ledger_contractor: contractorLedger,
    ledger_supplier: supplierLedger, ui_shared: uiShared }))
  const base = httpBox.webui.url.replace(/\/$/, '')
  const get = async (path) => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, text: await res.text() }
  }
  const parse = (text) => { try { return JSON.parse(text) } catch { return {} } }

  const routes = parse((await get('/api/routes')).text).routes ?? []
  const authRoutes = routes.filter((row) => String(row.path).includes('/authority'))
  const pageExact = await get('/contractor/authority/?amount=500000&role=buyer')
  const jsonExact = await get('/contractor/api/authority?amount=500000&role=buyer')
  const pageOver = await get('/contractor/authority/?amount=500001&role=buyer')
  const jsonOver = await get('/supplier/api/authority?amount=500001&role=buyer')
  const jsonUnder = await get('/supplier/api/authority?amount=499999&role=buyer')
  const jExact = parse(jsonExact.text)
  const jOver = parse(jsonOver.text)
  const jUnder = parse(jsonUnder.text)
  const pageContract = [pageExact.text, pageOver.text].every((text) => text.includes('data-authority="result"')
    && text.includes('data-authority-unit="cents"') && text.includes('data-authority-engine="rules"')
    && text.includes('data-authority-can-approve="false"') && text.includes('data-authority-bands="1"')
    && text.includes('data-subnav="contractor"') && text.includes('data-authority-link="1"')
    && text.includes('data-authority-config-where="1"') && !text.includes(scriptNeedle)
    && !inlineEvent.test(text))
  check('14 **真 HTTP 正控**（in-process 挂真 `webui` + 真依赖模块 + **临时配置夹具**）：两视角页面/JSON '
    + '**四条** URL 都 **200**；`/api/routes` 登记这四条新路由且 `auth=none`；'
    + '页面/JSON 的结论与**手算一致**（500000 ⇒ 在区间内、越界 0；500001 ⇒ 越界 1 分、要求角色 lead、'
    + '下一个 lead；499999 ⇒ 在区间内）；页面有口径/结论/区间表/「在哪里配」/子导航入口；'
    + '**0 行脚本 / 0 内联事件**',
  authRoutes.length === 4 && authRoutes.every((row) => row.auth === 'none')
  && pageExact.status === 200 && jsonExact.status === 200 && pageOver.status === 200 && jsonOver.status === 200
  && jExact.inside_band === true && jExact.over_by === 0 && jExact.escalate_cmd === ''
  && jOver.inside_band === false && jOver.over_by === 1 && jOver.required_role === 'lead' && jOver.next_role === 'lead'
  && jOver.escalate_cmd.startsWith('tools/verify.sh ') && jOver.can_approve === false
  && jUnder.inside_band === true && jUnder.over_by === 0 && pageContract,
  `status=${pageExact.status}/${jsonExact.status}/${pageOver.status}/${jsonOver.status}；路由=`
  + `${JSON.stringify(authRoutes.map((row) => `${row.method} ${row.path} ${row.auth}`))}；`
  + `500000 ⇒ inside=${jExact.inside_band}/越界 ${jExact.over_by}；500001 ⇒ inside=${jOver.inside_band}/越界 ${jOver.over_by}`
  + `/需 ${jOver.required_role}/下一个 ${jOver.next_role}；499999 ⇒ inside=${jUnder.inside_band}；页面契约=${pageContract}`)

  const yamlHashBefore = sha256(sourceOf(yamlPath))
  const configuredProbe = await get('/contractor/api/authority?amount=1&role=buyer')   // 配置夹具在（buyer=500000）
  // --- 改配置前后：**同一个金额**结论必须不同（临时夹具改写，不碰真 config.yaml）---
  writeFileSync(yamlPath, yamlFor(500001), 'utf8')
  const afterEdit = await get('/contractor/api/authority?amount=500001&role=buyer')
  const jAfter = parse(afterEdit.text)
  const yamlHashAfterEdit = sha256(sourceOf(yamlPath))
  // --- 未配置实例（真 HTTP 同一条 URL）：把临时夹具**移走** ⇒ 配置读不到 ⇒ 登记全为 null ⇒ unconfigured=true ---
  const yamlStash = join(fixtureDir, 'config.yaml.stash')
  writeFileSync(yamlStash, sourceOf(yamlPath), 'utf8')
  const { renameSync, unlinkSync } = await import('node:fs')
  unlinkSync(yamlPath)
  const missingJson = await get('/contractor/api/authority?amount=500001&role=buyer')
  const missingPage = await get('/contractor/authority/?amount=500001&role=buyer')
  const jMissing = parse(missingJson.text)
  // 还原夹具（逐字节）并确认同一条 URL 又回到「在区间内」（证明刚才那次确实是"配置读不到"）
  writeFileSync(yamlPath, readFileSync(yamlStash, 'utf8'), 'utf8')
  renameSync(yamlStash, join(fixtureDir, 'config.yaml.used'))
  const restored = await get('/contractor/api/authority?amount=500001&role=buyer')
  const jRestored = parse(restored.text)
  const sentinelInYaml = HAND_SENTINELS.filter((needle) => sourceOf(yamlPath).includes(needle))
  const sensitiveResponses = [pageExact.text, jsonExact.text, pageOver.text, jsonOver.text,
    afterEdit.text, missingPage.text, missingJson.text]
  const sensitiveHits = HAND_SENTINELS.filter((needle) => sensitiveResponses.some((text) => text.includes(needle)))
  const privateHits = PRIVATE_NEEDLES.filter((needle) => sensitiveResponses.some((text) => text.includes(needle)))
  const pagesClean = sensitiveResponses.every((text) => !text.includes(scriptNeedle) && !inlineEvent.test(text))
  // 第四道（admin）子导航：提权后页面里要有授权区间入口
  const elevate = await fetch(`${base}/admin/api/elevate`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${T284_TOKEN}` })
  const cookie = (elevate.headers.get('set-cookie') ?? '').split(';')[0]
  const adminAnonymous = await get('/admin/')
  const adminPage = await fetch(`${base}/admin/`, { headers: { cookie } })
  const adminText = await adminPage.text()
  check('15 **真 HTTP 负控 + 改配置前后结论不同**：把**临时**配置夹具里的 buyer 限额从 500000 改成 500001 ⇒ '
    + '**同一个金额 500001** 的结论从「越界」翻成「在区间内」（同一进程、同一 URL ⇒ 配置是真读的）；'
    + '把夹具**移走**（配置读不到）⇒ 同一 URL 变成 `unconfigured=true` + `band-unconfigured` + '
    + '`required_role`/`next_role` 空 + `bands` 空 + 页面出「未配置」块（**不编限额**）；把夹具逐字节还原 ⇒ '
    + '同一 URL 又回到「在区间内」（证明降级来自"配置读不到"，不是页面坏了）；'
    + '响应 **0 行脚本 / 0 内联事件**；夹具里**确实**有私域哨兵而七份响应 0 命中；'
    + '提权后 `/admin/` 子导航含 `data-authority-link`；未提权 `/admin/` 仍 **401 固定体**',
  configuredProbe.status === 200 && parse(configuredProbe.text).inside_band === true
  && jAfter.inside_band === true && jAfter.over_by === 0 && jAfter.escalate_cmd === ''
  && parse(afterEdit.text).amount === 500001 && yamlHashBefore !== yamlHashAfterEdit
  && sourceOf(yamlPath).includes('authority.bands.buyer: 500001')      // 还原的是"改后"那份（逐字节）
  && missingJson.status === 200 && jMissing.unconfigured === true && jMissing.reason === 'band-unconfigured'
  && jMissing.required_role === '' && jMissing.next_role === '' && jMissing.inside_band === null
  && jMissing.escalate_cmd === '' && jMissing.bands.length === 0
  && missingPage.text.includes('data-authority-unconfigured-note="1"')
  && jRestored.inside_band === true && jRestored.unconfigured === false
  && sentinelInYaml.length >= 2 && sensitiveHits.length === 0 && privateHits.length === 0
  && pagesClean && adminAnonymous.status === 401 && adminText.includes('data-authority-link="1"')
  && adminText.includes('data-subnav="admin"') && adminPage.status === 200,
  `夹具 sha 前=${yamlHashBefore.slice(0, 12)}… 改后=${yamlHashAfterEdit.slice(0, 12)}…（变了=${yamlHashBefore !== yamlHashAfterEdit}）；`
  + `改前 500001 ⇒ inside=${jOver.inside_band}；改后同金额 ⇒ inside=${jAfter.inside_band}/越界 ${jAfter.over_by}；`
  + `移走夹具 ⇒ unconfigured=${jMissing.unconfigured}/reason=${jMissing.reason}/bands=${jMissing.bands.length}/`
  + `required='${jMissing.required_role}'/next='${jMissing.next_role}'/页面未配置块=${missingPage.text.includes('data-authority-unconfigured-note="1"')}；`
  + `还原后 ⇒ inside=${jRestored.inside_band}/unconfigured=${jRestored.unconfigured}；夹具哨兵=${sentinelInYaml.length} 个/`
  + `响应命中=${sensitiveHits.join(',') || '无'}；私域键名命中=${privateHits.join(',') || '无'}；页面干净=${pagesClean}；`
  + `admin 未提权=${adminAnonymous.status}/提权后=${adminPage.status} 含入口=${adminText.includes('data-authority-link="1"')}`)

  await httpFiber.dispose()

  // ---------- 16. 单点变异 ----------
  const realFacts = await factsFor((config) => mountWith(config))
  const realAllTrue = SCENARIOS.every((name) => realFacts[name] === true)
  check('16 变异基线：四条场景（三例边界值手算对账 / 未配置不得编限额 / 越界必出升级命令 / 金额非法三类拒绝）'
    + '在**真产物**上全真（否则变异变红说明不了任何事：基线本来就是红的）',
  realAllTrue, `基线=${JSON.stringify(realFacts)}`)

  const mutationReport = []
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
    const fake = mutated === null || mutated === originalSource
    if (fake) {
      mutationReport.push(`${mutation.name}→假变异`)
      check(`16 变异：${mutation.name}`, false,
        `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
      continue
    }
    const facts = await factsFor((config) => mountMutant(mutated, config))
    const red = SCENARIOS.filter((name) => facts[name] !== true)
    mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
    check(`16 变异：${mutation.name}`, red.includes(mutation.mustRed),
      `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts)}；`
      + `字节已变=${mutated !== originalSource}`)
  }

  // ---------- 17. 防假变异 + 还原 ----------
  const fakeGuard = applyMutation(originalSource, '这一段源码里根本不存在-T284-ANCHOR', 'x')
  const selfAnchor = originalSource.includes('export const REGISTERED_ROLES') ? 'export const REGISTERED_ROLES' : 'export const name'
  const selfMutation = applyMutation(originalSource, selfAnchor, selfAnchor)
  check('17 防假变异（自检）：找不到唯一锚点的"变异"必须被判定为**假变异**（返回 null），'
    + '把锚点替换成它自己也不算变异 —— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

  const afterHash = sha256(sourceOf(TARGET))
  const afterWebui = sha256(sourceOf(WEBUI))
  check('17 还原：本门全程**没有写过产品树** —— `host/modules/authority-band.mjs` 与 `host/modules/webui.mjs` '
    + '跑完之后与跑之前**逐字节一致**（变异只写在临时目录的副本里；夹具配置也只写在临时目录里）',
  afterHash === originalHash && sourceOf(TARGET) === originalSource && afterWebui === webuiHash,
  `authority-band sha256 前=${originalHash.slice(0, 16)}… 后=${afterHash.slice(0, 16)}…；`
  + `webui 未变=${afterWebui === webuiHash}；变异小结=${mutationReport.join('；')}`)

  for (const mounted of [live, other, clockA, clockB, cap3, cap0, cap1000]) {
    try { await mounted.fiber.dispose() } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 300)}`)
}

finish()
