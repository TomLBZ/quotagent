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
 *   7  **越界必出升级入口且入口真存在**：越界 ⇒ `escalate_cmd` 非空、指到 GUI 动作 `authority.escalate`，
 *      该门名**真的出现在** `tools/verify.sh help` 的输出里（本门真跑那个命令）；人工签署命令指向
 *      `gate.grant` / `gate.deny`）；**双向**：不越界时 `escalate_cmd` 为空
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
 *      都 200、`/api/routes` 登记两条新路由且 `auth=identity-session`；页面/JSON 的结论与**手算**一致
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
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
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/authority-band.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const TARGET = join(HERE, '..', 'src', 'domain', 'authority-band', 'code', 'authority-band.mjs')
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/webui.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const WEBUI = join(HERE, '..', 'src', 'system', 'webui', 'code', 'webui.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href
const VERIFY_SH = join(HERE, '..', 'tools', 'verify.sh')
/** 产品面**绝不允许**出现的「教用户回终端」痕迹（旧口径 `ESCALATE_*` 的残留物，见 29 §2）。 */
const NOISE_TOKENS = ['g1side', 'PYTHONPATH', '终端', '命令行']

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
    facts['越界必出升级命令'] = over.escalate_cmd.includes('authority.escalate')
      && over.escalate_cmd.includes('审批队列') && over.escalate_human_cmd.includes('gate.grant')
      && over.escalate_human_cmd.includes('gate.deny')
      && NOISE_TOKENS.every((t) => !over.escalate_cmd.includes(t) && !over.escalate_human_cmd.includes(t))
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
  // 先改读方（EV-177）：`host/lib/config-keys.mjs` 已搬进 `src/system/config/code/`，旧路径只剩薄重导
  // ⇒ 按源码文本判据必须指实体（读旧路径会在 8 行转发上读不到任何登记）。
  const keysText = sourceOf(join(HERE, '..', 'src', 'system', 'config', 'code', 'config-keys.mjs'))
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
    // ★ 本批改判据（29 §2 / AGENTS.md 规则 12）：`ESCALATE_COMMAND` / `ESCALATE_HUMAN_COMMAND` 从
    //   「终端命令」（`tools/verify.sh gates` / `PYTHONPATH=src python3 -m quotagent.g1side …`）改成
    //   **GUI 里真能点的动作**；判据不弱于原来：必须指名那三个动作 id，且 0 命中回终端痕迹。
    escalate: mod.ESCALATE_COMMAND.includes('authority.escalate')
      && mod.ESCALATE_HUMAN_COMMAND.includes('gate.grant') && mod.ESCALATE_HUMAN_COMMAND.includes('gate.deny')
      && mod.APPROVAL_NOTE.includes('不能')
      && NOISE_TOKENS.every((t) => !mod.ESCALATE_COMMAND.includes(t)
        && !mod.ESCALATE_HUMAN_COMMAND.includes(t) && !mod.APPROVAL_NOTE.includes(t)),
    ignored: JSON.stringify(mod.IGNORED_NOW_INPUTS) === JSON.stringify(['payload.now', 'config.now']),
    fn: typeof mod.checkOf === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  check('1 契约正控：manifest 与常量齐备（`unit=cents` / 闭合的 `REASONS`/`REFUSAL_CODES`/`STATUSES`/'
    + '`BLOCKED_BY_VALUES` / `REGISTERED_ROLES` 与 `host/lib/config-keys.mjs` 的 `authority.bands.*` **逐字一致** / '
    + '升级入口指向 GUI 动作 `authority.escalate` / `gate.grant` / `gate.deny`（且 0 命中回终端痕迹）'
    + ' / `ignored_now_inputs`）+ `checkOf` 是函数；只 import ../lib 白名单（或 node:）；'
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

  // ---------- 7. 越界必出升级入口 + 入口真存在（★ 改判据：命令 → GUI 动作） ----------
  // 旧断言是「`escalate_cmd` 以 `tools/verify.sh <门名>` 开头，且该门名出现在 `verify.sh help` 输出里；
  // 人工签署命令指向 `quotagent.g1side`（`src/quotagent/g1side.py` 真存在）」—— 那是「把人教回终端」的
  // 产品面口径，与 `docs/design/29-webui-gui-app.md` §2 + AGENTS.md 规则 12 冲突。改成**接新位置**：
  //   · `escalate_cmd` 必须指到 GUI 动作 **`authority.escalate`**（越界一键把这件事提成人工门）；
  //   · `escalate_human_cmd` 必须指到审批队列那两键 **`gate.grant` / `gate.deny`**（谁在哪批）；
  //   · 两条 + `approval_note` **0 命中** g1side / PYTHONPATH / 终端 / 命令行；
  //   · **「入口真存在」的非空转判据**：这两个动作 id 必须**真的注册在证据里**（下面读
  //     `src/domain/authority-band/code/ui.mjs` 的动作声明 + `src/system/approval/code/ui.mjs` 的
  //     `gate.grant` / `gate.deny` 声明）—— 动作 id 打错与旧口径里命令名打错一样判红。
  const uiText = sourceOf(join(HERE, '..', 'src', 'domain', 'authority-band', 'code', 'ui.mjs'))
  const approvalUiText = sourceOf(join(HERE, '..', 'src', 'system', 'approval', 'code', 'ui.mjs'))
  const registeredActions = {
    'authority.escalate': /id:\s*'authority\.escalate'/.test(uiText),
    'gate.grant': /id:\s*'gate\.grant'/.test(approvalUiText) || approvalUiText.includes("'gate.grant'"),
    'gate.deny': approvalUiText.includes("'gate.deny'"),
  }
  const missingActions = Object.entries(registeredActions).filter(([, ok]) => !ok).map(([id]) => id)
  const overCase = runCheck({ view: 'contractor', role: 'buyer', amount: 500001, config: cfgFor() })
  const insideCase = runCheck({ view: 'contractor', role: 'buyer', amount: 500000, config: cfgFor() })
  const overText = `${overCase.escalate_cmd} ${overCase.escalate_human_cmd}`
  const overNoise = NOISE_TOKENS.filter((t) => overText.includes(t))
  check('7 **越界必出升级入口、且入口真存在**：越界 ⇒ `escalate_cmd` 指到 GUI 动作 `authority.escalate`、'
    + '`escalate_human_cmd` 指到审批队列的 `gate.grant` / `gate.deny`（**两个动作 id 真的注册在证据文件里**；'
    + '本门真读那两份 `ui.mjs`），两条 + `approval_note` 里 g1side / PYTHONPATH / 终端 / 命令行 **0 命中**；'
    + '`blocked_by=human-gate-required`；**双向**：不越界时两条都为空（不发无用入口）',
  overCase.escalate_cmd.includes('authority.escalate') && overCase.escalate_human_cmd.includes('gate.grant')
  && overCase.escalate_human_cmd.includes('gate.deny') && missingActions.length === 0
  && overNoise.length === 0 && overCase.blocked_by === 'human-gate-required'
  && !overCase.approval_note.includes('不能') === false
  && NOISE_TOKENS.every((t) => !overCase.approval_note.includes(t))
  && insideCase.escalate_cmd === '' && insideCase.escalate_human_cmd === '',
  `越界入口=${JSON.stringify(overCase.escalate_cmd)}；人工决定=${JSON.stringify(overCase.escalate_human_cmd)}；`
  + `动作注册=${JSON.stringify(registeredActions)}（缺=${missingActions.join(',') || '无'}）；`
  + `命中回终端痕迹=${overNoise.join(',') || '无'}；不越界时 esc='${insideCase.escalate_cmd}'`)

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

  // ---------- 13. 宿主侧契约（静态，★ 改判据：旧页退役 ⇒ 接新位置） ----------
  // 旧断言是「两条 SSR 路由 + 宿主用 `authorityConfigSnapshot` 驱动插件 + 四道页面子导航入口
  // + 页面模板 0 内联脚本」。旧页已按 29 §2 退役为 **303 → `/app/<view>/`**，宿主那份配置快照
  // （`authorityConfigSnapshot`）也随页删掉 —— 读数现在由**插件自己的面板**给。改判据（不弱于原来）：
  //   ① 两条旧路由仍在 `/api/routes` 里登记（写明「已退役 303」）；
  //   ② `data-authority-link` 入口仍在，且**目标已接到新位置**（`href="${prefix}/app/${view}/"`），
  //      系统管理道里仍传两个入口标签（与 `subNav` 那处一并算）；
  //   ③ 入口指到的两个动作（`authority.check` / `authority.escalate`）**真的声明在插件的 `ui.mjs` 里**
  //      —— 这是「入口真存在」的非空转判据（动作 id 打错与旧口径里命令名打错一样判红）；
  //   ④ `/start/` 上手页仍有「授权区间在哪里配」段；
  //   ⑤ webui 非注释代码里 0 行脚本字面量 / 0 内联事件（扫描器非空转）。
  const routeDecls = webuiSource.includes("`${prefix}/${v}/authority/`, method: 'GET'")
    && webuiSource.includes("`${prefix}/${v}/api/authority`, method: 'GET'")
    && webuiSource.includes('RETIRED_SUBVIEWS') && /authority: '[^']*授权区间/.test(webuiSource)
  const navDecls = webuiSource.split('data-authority-link').length - 1
  const navLabels = ['授权区间（承包商 · GUI）', '授权区间（供应商 · GUI）'].every((label) => webuiSource.includes(label))
  const navToGui = webuiSource.includes('href="${prefix}/app/${view}/" data-authority-link="1"')
  const startPageOk = webuiSource.includes('授权区间在哪里配') && webuiSource.includes('authority.bands.&lt;角色&gt;')
  const actionsDeclared = /id:\s*'authority\.check'/.test(uiText) && /id:\s*'authority\.escalate'/.test(uiText)
  const webuiCode = webuiSource.split('\n').filter((line) => !line.trim().startsWith('//')
    && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n')
  check('13 宿主侧契约（静态，**旧页退役 ⇒ 接新位置**）：两条旧路由仍在 `/api/routes` 里登记为「已退役 303 → '
    + '`/app/<view>/`」；**四道页面**的子导航入口仍在（`data-authority-link`，目标已接到 GUI：'
    + '`href="…/app/<view>/"`）且系统管理道仍传两个入口标签；入口指到的两个动作 '
    + '`authority.check` / `authority.escalate` **真的声明在插件 `ui.mjs` 里**；`/start/` 上手页有'
    + '「授权区间在哪里配」段；webui 非注释代码 **0 行脚本字面量 / 0 内联事件**（扫描器非空转）',
  routeDecls && navDecls >= 2 && navLabels && navToGui && startPageOk && actionsDeclared
  && !webuiCode.includes(scriptNeedle) && !inlineEvent.test(webuiCode)
  && (scriptNeedle === '<scr' + 'ipt' && inlineEvent.test('<a onclick="x()">')),
  `路由登记=${routeDecls} 导航声明=${navDecls} 目标接 GUI=${navToGui} 入口标签=${navLabels} `
  + `动作真声明=${actionsDeclared} 上手页段=${startPageOk}；`
  + `webui 含脚本字面量=${webuiCode.includes(scriptNeedle)} 含内联事件=${inlineEvent.test(webuiCode)}`)

  // ---------- 14/15. 真 HTTP（★ 改判据：页面/JSON → **真动作总线上的 action**） ----------
  // 旧断言读的是 `/contractor/authority/?amount=…` 的 SSR 页与 `/api/authority` 的 JSON；
  // 那两条路由已退役。等价判据换成**在真动作总线上真跑 `authority.check`**（同一份 `checkOf` 口径，
  // 而且多了「动作真的注册、真的能被调用、回执形状真的对」这三层）—— 判据不弱于原来：
  //   · 四条旧路由 303 + Location；`/api/routes` 仍登记四条（`auth=identity-session`）；
  //   · 承接面板 `authority.bands` / `authority.bands.supplier` 真的注册在两侧视图上，带两个真动作；
  //   · 三例边界值（500000 / 500001 / 499999）经 action 回执**与手算一致**；
  //   · 改临时配置夹具 ⇒ 同一金额结论翻转；移走夹具 ⇒ `unconfigured`（不编限额）；
  //   · 哨兵 0 命中、0 行脚本 / 0 内联事件、提权后 `/admin/` 子导航仍含 `data-authority-link`。
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
    "  authority.escalation_note: '越界请找业主代表（GUI 审批队列里人签）'",
    `  transport.dir: '${HAND_SENTINELS[0]}'`,
    '  pricing.markup_pct: 987654321',
    ''].join('\n')
  // 夹具的 mtime 显式往前推：插件自己那份只读快照按 `mtimeMs + size` 备忘，而 `yamlFor(500000)` 与
  // `yamlFor(500001)` **字节长度相同** ⇒ 时间戳粒度粗时会命中旧快照、让「改配置前后结论不同」偶发判红。
  const fixtureStamp = [Math.floor(Date.now() / 1000) + 3600]
  const writeYaml = (text) => {
    writeFileSync(yamlPath, text, 'utf8')
    fixtureStamp[0] += 5
    utimesSync(yamlPath, fixtureStamp[0], fixtureStamp[0])
  }
  writeYaml(yamlFor(500000))
  // 插件自己的只读配置快照按 `QUOTAGENT_UI_CONFIG` → 缺省 `/workspace/config.yaml` 解析
  // ⇒ 本门把**本进程**的这个环境变量指向**临时夹具**（真 `/workspace/config.yaml` 只读、一字未动）。
  // 这正是「界面上的读数真的来自受管配置」这条判据的机检形态：改夹具 ⇒ 同一条 action 结论翻转。
  const previousUiConfig = process.env.QUOTAGENT_UI_CONFIG
  process.env.QUOTAGENT_UI_CONFIG = yamlPath

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
  // 身份会话（P3：`/contractor/**`、`/supplier/**` 有了**路由级身份门槛**）——
  // 本门**先登录再取业务路由**：判据从「谁能打开」变成「**登录后按侧放行**」，断言一条不删、一条不放松。
  const SESSIONS = {}
  const loginAs = async (side) => {
    if (SESSIONS[side]) return SESSIONS[side]
    const res = await fetch(`${base}/identity/login?format=json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: `gate-t284-${side}`, side }).toString(),
    })
    const text = await res.text()
    const cookie = String(res.headers.get('set-cookie') ?? '').split(';')[0]
    if (res.status !== 200 || !cookie.startsWith('qa_identity=')) {
      throw new Error(`门夹具登录失败：side=${side} status=${res.status} body=${text.slice(0, 200)}`)
    }
    SESSIONS[side] = cookie
    return cookie
  }
  const cookieFor = async (path) => {
    const side = /^\/(contractor|supplier)(?:\/|$)/.exec(String(path))?.[1]
    return side ? { cookie: await loginAs(side) } : {}
  }
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: await cookieFor(path) })
    return { status: res.status, text: await res.text() }
  }
  const rawGet = async (path, accept) => {
    const res = await fetch(`${base}${path}`, { headers: { ...(await cookieFor(path)), accept },
      redirect: 'manual' })
    return { status: res.status, location: String(res.headers.get('location') ?? ''), text: await res.text() }
  }
  const act = async (actionId, view, input) => {
    const res = await fetch(`${base}/api/action/${actionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(await cookieFor(`/${view}/`)) },
      body: JSON.stringify({ view, input: { ...input, confirm_ack: '1' } }) })
    const text = await res.text()
    let doc = {}
    try { doc = JSON.parse(text) } catch { doc = {} }
    return { status: res.status, text, doc }
  }
  // 身份门槛本身也要机检（P3：未登录拒 / 登录后按侧放行 / 越侧 403）
  const anonJson = await fetch(`${base}/contractor/api/authority`, { headers: { accept: 'application/json' } })
  const anonJsonBody = await anonJson.text()
  const anonHtml = await fetch(`${base}/contractor/authority/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  const anonLocation = String(anonHtml.headers.get('location') ?? '')
  const crossSidePath = 'supplier/authority/'
  const crossSide = await fetch(`${base}/${crossSidePath}`, { headers: { cookie: await loginAs('contractor') } })
  const crossBody = await crossSide.text()
  const sameSide = await rawGet('/contractor/authority/', 'text/html')
  check('身份门槛（P3，与退役前逐字一致）：未登录取业务路由 ⇒ API 401 `identity-required` + `next`、浏览器 303 回 `/identity/?next=…`；'
    + '登录后**按侧放行**（同侧 ⇒ **303 → `/t284/app/contractor/`**：旧页不再返回内容）、'
    + '**越侧 403 `side-mismatch`**（不回落成「能看」）',
  anonJson.status === 401 && anonJsonBody.includes('identity-required') && anonJsonBody.includes('"next"')
  && anonHtml.status === 303 && anonLocation.includes('/t284/identity/?next=')
  && crossSide.status === 403 && crossBody.includes('side-mismatch')
  && sameSide.status === 303 && sameSide.location.endsWith('/t284/app/contractor/'),
  `未登录 JSON=${anonJson.status} HTML=${anonHtml.status} location=${anonLocation.slice(0, 60)}；`
  + `越侧=${crossSide.status} 含 side-mismatch=${crossBody.includes('side-mismatch')}；`
  + `同侧=${sameSide.status} → ${sameSide.location}`)
  const parse = (text) => { try { return JSON.parse(text) } catch { return {} } }

  const routes = parse((await get('/api/routes')).text).routes ?? []
  const authRoutes = routes.filter((row) => String(row.path).includes('/authority'))
  const retiredRows = []
  for (const view of ['contractor', 'supplier']) {
    for (const [suffix, accept] of [['/authority/', 'text/html'], ['/api/authority', 'application/json']]) {
      const res = await rawGet(`/${view}${suffix}`, accept)
      retiredRows.push({ path: `/${view}${suffix}`, status: res.status, location: res.location,
        ok: res.status === 303 && res.location.endsWith(`/${view}/`) })
    }
  }
  const carrierIds = { contractor: 'authority.bands', supplier: 'authority.bands.supplier' }
  const panels = { view: null }
  const panelsOf = async (view) => (parse((await get(`/api/ui/panels?view=${view}`)).text).panels ?? [])
  const contractorPanels = await panelsOf('contractor')
  const supplierPanels = await panelsOf('supplier')
  const carrierOf = (list, id) => list.find((panel) => (panel.panel_id ?? panel.id) === id) ?? null
  const carriersOk = ['contractor', 'supplier'].every((view) => {
    const panel = carrierOf(view === 'contractor' ? contractorPanels : supplierPanels, carrierIds[view])
    return Boolean(panel) && (panel.actions ?? []).includes('authority.check')
      && (panel.actions ?? []).includes('authority.escalate')
  })
  // 三例边界值：经**真动作总线**（`authority.check`）回读，与手算逐项对账
  const actExact = await act('authority.check', 'contractor', { role: 'buyer', amount: 500000 })
  const actOver = await act('authority.check', 'contractor', { role: 'buyer', amount: 500001 })
  const actUnder = await act('authority.check', 'supplier', { role: 'buyer', amount: 499999 })
  const rExact = actExact.doc.result ?? {}
  const rOver = actOver.doc.result ?? {}
  const rUnder = actUnder.doc.result ?? {}
  const actionContract = [actExact, actOver, actUnder].every((call) => call.status === 200
    && (call.doc.result ?? {}).unit === 'cents' && (call.doc.result ?? {}).can_approve === false)
  check('14 **真 HTTP 正控（旧页退役 ⇒ 接新位置）**：四条旧路由（`/t284/<view>/authority/` 与 '
    + '`/t284/<view>/api/authority`）一律 **303 + Location 落在同侧 GUI 视图页**；`/api/routes` 仍登记这四条且 '
    + '`auth=identity-session`；**承接这件事的 GUI 面板真的注册在两侧视图上**（`authority.bands` / '
    + '`authority.bands.supplier`，各带 `authority.check` / `authority.escalate`）；'
    + '结论经**真动作总线**回读且与**手算一致**（500000 ⇒ 在区间内、越界 0；500001 ⇒ 越界 1 分、要求角色 lead、'
    + '下一个 lead；499999 ⇒ 在区间内）；动作回执 0 行脚本 / 0 内联事件',
  retiredRows.every((row) => row.ok) && authRoutes.length === 4
  && authRoutes.every((row) => row.auth === 'identity-session')
  && carriersOk && actionContract
  && rExact.status === 'inside-band' && rExact.over_by === 0
  && rOver.status === 'over-band' && rOver.over_by === 1 && rOver.required_role === 'lead' && rOver.next_role === 'lead'
  && rUnder.status === 'inside-band' && rUnder.over_by === 0
  && ![actExact, actOver, actUnder].some((call) => call.text.includes(scriptNeedle) || inlineEvent.test(call.text)),
  `旧路由=${JSON.stringify(retiredRows.map((row) => `${row.path}→${row.status}${row.location}`))}；`
  + `路由=${JSON.stringify(authRoutes.map((row) => `${row.method} ${row.path} ${row.auth}`))}；承接面板=${carriersOk}；`
  + `500000 ⇒ ${rExact.status}/越界 ${rExact.over_by}；500001 ⇒ ${rOver.status}/越界 ${rOver.over_by}`
  + `/需 ${rOver.required_role}/下一个 ${rOver.next_role}；499999 ⇒ ${rUnder.status}`)

  const yamlHashBefore = sha256(sourceOf(yamlPath))
  // --- 改配置前后：**同一个金额**结论必须不同（临时夹具改写，不碰真 config.yaml）---
  writeYaml(yamlFor(500001))
  const afterEdit = await act('authority.check', 'contractor', { role: 'buyer', amount: 500001 })
  const rAfter = afterEdit.doc.result ?? {}
  const yamlHashAfterEdit = sha256(sourceOf(yamlPath))
  // --- 未配置实例（真 HTTP 同一条 action）：把临时夹具**移走** ⇒ 配置读不到 ⇒ 登记全为 null ⇒ unconfigured ---
  const yamlStash = join(fixtureDir, 'config.yaml.stash')
  writeFileSync(yamlStash, sourceOf(yamlPath), 'utf8')
  const { renameSync, unlinkSync } = await import('node:fs')
  unlinkSync(yamlPath)
  const missingCall = await act('authority.check', 'contractor', { role: 'buyer', amount: 500001 })
  const rMissing = missingCall.doc.result ?? {}
  // 还原夹具（逐字节）并确认同一条 action 又回到「在区间内」（证明刚才那次确实是"配置读不到"）
  writeYaml(readFileSync(yamlStash, 'utf8'))
  renameSync(yamlStash, join(fixtureDir, 'config.yaml.used'))
  const restored = await act('authority.check', 'contractor', { role: 'buyer', amount: 500001 })
  const rRestored = restored.doc.result ?? {}
  const sentinelInYaml = HAND_SENTINELS.filter((needle) => sourceOf(yamlPath).includes(needle))
  const sensitiveResponses = [actExact.text, actOver.text, actUnder.text, afterEdit.text,
    missingCall.text, JSON.stringify(contractorPanels), JSON.stringify(supplierPanels),
    ...retiredRows.map((row) => row.text ?? '')]
  const sensitiveHits = HAND_SENTINELS.filter((needle) => sensitiveResponses.some((text) => text.includes(needle)))
  const privateHits = PRIVATE_NEEDLES.filter((needle) => sensitiveResponses.some((text) => text.includes(needle)))
  const noiseHits = NOISE_TOKENS.filter((token) => sensitiveResponses.some((text) => text.includes(token)))
  const pagesClean = sensitiveResponses.every((text) => !text.includes(scriptNeedle) && !inlineEvent.test(text))
  // 第四道（admin）子导航：提权后页面里要有授权区间入口（目标已接到 GUI）
  const elevate = await fetch(`${base}/admin/api/elevate`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${T284_TOKEN}` })
  const cookie = (elevate.headers.get('set-cookie') ?? '').split(';')[0]
  const adminAnonymous = await get('/admin/')
  const adminPage = await fetch(`${base}/admin/`, { headers: { cookie } })
  const adminText = await adminPage.text()
  check('15 **真 HTTP 负控 + 改配置前后结论不同**：把**临时**配置夹具里的 buyer 限额从 500000 改成 500001 ⇒ '
    + '**同一个金额 500001** 的结论从「越界」翻成「在区间内」（同一进程、同一条 action ⇒ 配置是真读的）；'
    + '把夹具**移走**（配置读不到）⇒ 同一条 action 变成 `unconfigured=true` + `band-unconfigured` + '
    + '`required_role`/`next_role` 空 + `bands` 空（**不编限额**）；把夹具逐字节还原 ⇒ 同一条 action 又回到'
    + '「在区间内」（证明降级来自"配置读不到"，不是接口坏了）；所有响应与**承接面板载荷** **0 行脚本 / 0 内联事件**、'
    + '`终端` / `g1side` / `PYTHONPATH` / `命令行` **0 命中**；夹具里**确实**有私域哨兵而响应 0 命中；'
    + '提权后 `/admin/` 子导航含 `data-authority-link`（目标已是 GUI）；未提权 `/admin/` 仍 **401 固定体**',
  rAfter.status === 'inside-band' && rAfter.over_by === 0
  && (afterEdit.doc.result ?? {}).amount === 500001 && yamlHashBefore !== yamlHashAfterEdit
  && sourceOf(yamlPath).includes('authority.bands.buyer: 500001')      // 还原的是"改后"那份（逐字节）
  && missingCall.status === 200 && rMissing.unconfigured === true && rMissing.status === 'unconfigured'
  && missingCall.doc.code === 'authority-unconfigured'
  && rMissing.required_role === '' && rMissing.next_role === '' && rMissing.over_by === null
  && (rMissing.bands ?? []).length === 0
  && typeof missingCall.doc.next_action === 'string' && missingCall.doc.next_action.length > 10
  && rRestored.status === 'inside-band' && rRestored.unconfigured === false
  && sentinelInYaml.length >= 2 && sensitiveHits.length === 0 && privateHits.length === 0 && noiseHits.length === 0
  && pagesClean && adminAnonymous.status === 401 && adminText.includes('data-authority-link="1"')
  && adminText.includes('data-subnav="admin"') && adminPage.status === 200,
  `夹具 sha 前=${yamlHashBefore.slice(0, 12)}… 改后=${yamlHashAfterEdit.slice(0, 12)}…（变了=${yamlHashBefore !== yamlHashAfterEdit}）；`
  + `改前 500001 ⇒ ${rOver.status}；改后同金额 ⇒ ${rAfter.status}/越界 ${rAfter.over_by}；`
  + `移走夹具 ⇒ unconfigured=${rMissing.unconfigured}/${rMissing.status}/code=${missingCall.doc.code}/`
  + `bands=${(rMissing.bands ?? []).length}/required='${rMissing.required_role}'/next='${rMissing.next_role}'；`
  + `还原后 ⇒ ${rRestored.status}/unconfigured=${rRestored.unconfigured}；夹具哨兵=${sentinelInYaml.length} 个/`
  + `响应命中=${sensitiveHits.join(',') || '无'}；私域键名命中=${privateHits.join(',') || '无'}；`
  + `回终端痕迹命中=${noiseHits.join(',') || '无'}；响应干净=${pagesClean}；`
  + `admin 未提权=${adminAnonymous.status}/提权后=${adminPage.status} 含入口=${adminText.includes('data-authority-link="1"')}`)

  if (previousUiConfig === undefined) delete process.env.QUOTAGENT_UI_CONFIG
  else process.env.QUOTAGENT_UI_CONFIG = previousUiConfig

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
