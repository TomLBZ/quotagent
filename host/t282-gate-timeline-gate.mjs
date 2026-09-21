/**
 * t282-gate-timeline-gate —— **「审批等多久 / 变更单到底是谁卡着」**（`host/modules/gate-timeline.mjs`
 * + 它在 `webui` 里的三条路由）的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 断言（27 条，含负控、非空转对照与**单点变异**；每条都写清"什么情况下必须变红"）：
 *   1  契约正控：manifest 齐备 + 只 import ../lib 白名单（或 node:）+ 源码里 0 个脚本字面量
 *   2  挂载正控：provide 拦截拿得到句柄（timeline/nudge/meta/config）；dispose 后 effect 归零
 *   3  诚实分层正控：`engine=rules` + `engine_note` 与模块常量逐字一致；`privacy` 四项（含 `clock_reads=0`）
 *   4  **「等了多久」的口径不来自墙钟**（本门最核心的一条）：同一份快照在**两个不同 `now` 入口**
 *      （载荷 `payload.now` / 配置 `config.now`，各给两个不同的值）下输出**逐字节一致**，
 *      且 `age_seconds` 等于**手算**的「as_of − requested 事实 ts」
 *   5  口径自述正控：每条门都带非空 `age_basis`（含 `as_of` 与本门 requested 的事实 ts）+
 *      输出里 `age_clock="facts-only"` + `ignored_now_inputs` 列出被忽略的两个墙钟入口
 *   6  门条目形状正控：键集恰 9 键、`owner`/`kind`/`subject`/`consequence`/`next_action` 非空、id 唯一
 *   7  排序与计数正控：门按「等得最久」在前（同长按 id 字典序）、变更单按「谁欠动作」在前；计数逐项手算对齐
 *   8  超时策略后果正控（**再等下去会发生什么**）：`escalate`/`remind`/`abort` 与未知策略各自说清，
 *      三种策略里**没有**"超时自动批准"这句话
 *   9  **每条变更单都有 `basis`** 正控：非空且每个 token 都解析回载荷真键（`changes[...]`/`approvals[...]`/
 *      `events[...].count`）；**非空转对照**：坏 ref / 坏键 / 坏形状 / 空 basis 四种篡改必须判假
 *  10  变更状态机正控：`priced`/`approved`/`rejected`（**先 priced 后 rejected 以 rejected 为准**）/`unknown`
 *  11  「谁欠谁一个动作」正控：`priced` + 有对应 `change.approve` 门 → 用队列里的**真审批人**；
 *      没有对应门 → `human:unassigned`（不编人名）；`proposed`→`contractor-agent`；`approved`→`none`
 *  12  **插件不能批准**（硬负控）：句柄方法集合恰为六个（`change_detail|config|meta|nudge|requests|timeline`）、
 *      没有任何审批类方法、`meta.can_approve=false`、
 *      催办记录 `requested_action="nudge"` 且记录里没有任何审批类字段名
 *  13  催办载荷正控：含**用户原话逐字**、目标门 id、独立重算的 sha256、id 形状；同一（门+理由）→ 同一 id
 *  14  催办拒绝路径正控：`gate-not-found`/`empty-reason`/`reason-too-long`/`view-unknown`/`payload-unusable`
 *      各自给具体 code + 非空 next_action，且 `record` 为 null（拒绝时**不产任何落盘载荷**）
 *  15  **空投影不编**（硬负控）：空/非对象/坏形状/缺字段一律 `degraded:true` + 有名 reason +
 *      **两个列表都为 0**，且不抛错；"载荷不能用"与"数据齐但无可报项"是**两个不同**的 reason
 *  16  确定性负控：同输入两次逐字节一致 / 键序打乱一致 / 条目顺序打乱一致 / 跨实例一致 / 输出无时间键
 *  17  私域哨兵零泄漏负控：带哨兵与不带哨兵输出**逐字节一致**、哨兵 0 命中（输入对照组必须命中）
 *  18  有界与 `omitted` 诚实负控：`max_items` 夹取并回显；两段各自截断；`shown+omitted==found`；
 *      `by_state`/`by_policy` 之和 == 生成条数
 *  19  零写面/不读账本负控（静态扫描 + **扫描器非空转对照**）
 *  20  配置不得静默放行（未知键/错类型/非对象/翻转 const）+ bounds 回显
 *  21  fixture 纯读取 + 冻结输入不抛错
 *  22  **真 HTTP**（in-process 挂真 `webui` + 真依赖模块 + 夹具账本）：两视角 gates 页/JSON 200；
 *      `/api/routes` 登记三条路由且 `auth=none`；**四道页面**子导航都有 `data-gates-link`
 *  23  真 HTTP 正控：承包商侧真数据（门 + 变更单 + 逐条 next_action）、**供应商侧空投影** →
 *      页面 `data-gates-degraded="1"` + 两列表计数 0；页面 **0 行脚本 / 0 内联事件**
 *  24  真 HTTP 催办 POST：202 + 待办件 **恰 0600** + 原话逐字 + sha256 + **账本零新增**（夹具逐字节不变）；
 *      同一 URL 两次 GET 逐字节一致（HTTP 层的"不随窗口变"）
 *  25  真 HTTP 负控：夹具里**确实有**私域哨兵，而两视角 gates 页/JSON 里哨兵 0 命中；未提权 admin 仍 401 固定体
 *  26  **单点变异**：4 处变异各自必须让**指定的**场景变红（且变异必须真的改了字节）
 *  27  防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `gate-timeline.mjs` 与 `webui.mjs`
 *      字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t282-gate-timeline-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, 'modules', 'gate-timeline.mjs')
const WEBUI = join(HERE, 'modules', 'webui.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

// 门自己注入的**假** admin token：只为取第四道页面（`/t282/admin/`，提权后）的子导航。
const T282_TOKEN = 't282-gate-token-4c7d'
process.env.QUOTAGENT_ADMIN_TOKEN_T282 = T282_TOKEN

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// 产物加载：先装解析钩子（把 `../lib/std-schema.mjs` 指到真库），再动态 import。
// 变异体在**临时目录**里跑（绝不写产品树）→ 也依赖这个钩子才解析得到同一个库（无双实例）。
// ---------------------------------------------------------------------------
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
const webuiHash = sha256(sourceOf(WEBUI))

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

/** 从**临时副本**挂载变异体（`?v=` 破缓存；返回句柄）。 */
const mountMutant = async (mutatedSource, raw = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 't282-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `gate-timeline.mut-${tag}.mjs`)
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
// 夹具 + 手算表（**先把数字量出来再写进断言**：写错门就红）
// ===========================================================================
/**
 * 综合载荷（`as_of=2026-09-25T12:00:00Z`），手算：
 *   ① 门：
 *      ap-0001 requested 10:00 → age **7200**；policy=escalate / timeout_s=3600 ⇒ **已超时** ⇒ "转给人类上级"
 *      ap-0002 requested 11:00 → age **3600**；policy=remind / timeout_s=86400 ⇒ 未超时，再等 82800 秒
 *      ap-0003 requested 11:30 → age **1800**；policy=abort / timeout_s=900 ⇒ 已超时 ⇒ "作废"
 *      ap-0005 requested 11:50 → age **600**；policy='weird'（认不出）⇒ 按"绝不自动批准"处理
 *      ap-0004 已被 granted（11:40）⇒ **不进等待列表**（已决的门不是"还在等"）
 *   ② 变更单（排序口径：priced → proposed → rejected → approved → unknown，同状态按 id）：
 *      chg-0001 proposed 10:30 + priced 11:00 ⇒ `priced`（对应门 ap-0003 的 ref=chg-0001 ⇒ 真审批人 human:caiwu）
 *      chg-0002 priced 11:20 ⇒ `priced`（没有对应的 change.approve 门 ⇒ human:unassigned）
 *      chg-0003 priced 11:25 + rejected 11:26 ⇒ `rejected`（owed_by=proposer）
 *      chg-0004 approved 11:45 ⇒ `approved`（owed_by=none）
 */
const FULL = {
  view: 'contractor',
  as_of: '2026-09-25T12:00:00Z',
  approvals: [
    { approval_id: 'ap-0001', type: 'approval/requested', ts: '2026-09-25T10:00:00Z', scope: 'award.commit',
      ref: 'awin-1', summary: '授标承诺', approvers: ['human:liangzi'], timeout_policy: 'escalate',
      timeout_s: 3600, escalate_to: 'human:boss' },
    { approval_id: 'ap-0002', type: 'approval/requested', ts: '2026-09-25T11:00:00Z', scope: 'po.issue',
      ref: 'po-1', summary: '发 PO', timeout_policy: 'remind', timeout_s: 86400 },
    { approval_id: 'ap-0003', type: 'approval/requested', ts: '2026-09-25T11:30:00Z', scope: 'change.approve',
      ref: 'chg-0001', summary: '变更批准', approvers: ['human:caiwu'], timeout_policy: 'abort', timeout_s: 900 },
    { approval_id: 'ap-0004', type: 'approval/requested', ts: '2026-09-25T11:35:00Z', scope: 'quote.submit',
      ref: 'q-1', summary: '报价提交', timeout_policy: 'remind', timeout_s: 60 },
    { approval_id: 'ap-0004', type: 'approval/granted', ts: '2026-09-25T11:40:00Z', scope: 'quote.submit',
      ref: 'q-1', summary: '报价提交', timeout_policy: 'remind', timeout_s: 60 },
    { approval_id: 'ap-0005', type: 'approval/requested', ts: '2026-09-25T11:50:00Z', scope: 'mystery.scope',
      ref: 'x-1', summary: '来源不明', timeout_policy: 'weird', timeout_s: 60 },
  ],
  changes: [
    { change_id: 'chg-0001', type: 'change/proposed', ts: '2026-09-25T10:30:00Z', quote_id: 'q-1',
      basis_unit_price_refs: ['q-1#L-001:unit_price'] },
    { change_id: 'chg-0001', type: 'change/priced', ts: '2026-09-25T11:00:00Z', quote_id: 'q-1',
      delta_amount: 1720, basis_unit_price_refs: ['q-1#L-001:unit_price'] },
    { change_id: 'chg-0002', type: 'change/priced', ts: '2026-09-25T11:20:00Z', quote_id: 'q-1', delta_amount: 80 },
    { change_id: 'chg-0003', type: 'change/priced', ts: '2026-09-25T11:25:00Z', quote_id: 'q-2', delta_amount: 40 },
    { change_id: 'chg-0003', type: 'change/rejected', ts: '2026-09-25T11:26:00Z', quote_id: 'q-2',
      code: 'basis-mismatch' },
    { change_id: 'chg-0004', type: 'change/approved', ts: '2026-09-25T11:45:00Z', quote_id: 'q-1', delta_amount: 90,
      approved_by: 'human:liangzi', approval_id: 'ap-0000' },
  ],
}
const HAND_GATES = ['ap-0001', 'ap-0002', 'ap-0003', 'ap-0005']
const HAND_AGES = [7200, 3600, 1800, 600]
const HAND_POLICY = { remind: 1, escalate: 1, abort: 1, unknown: 1 }
const HAND_CHANGES = ['chg-0001', 'chg-0002', 'chg-0003', 'chg-0004']
const HAND_STATES = ['priced', 'priced', 'rejected', 'approved']
const HAND_OWED = ['human:caiwu', 'human:unassigned', 'proposer', 'none']
const GATE_KEYS = 'age_basis|age_seconds|blocked_by|consequence|id|kind|next_action|owner|subject'
const CHANGE_KEYS = 'basis|id|next_action|owed_by|state|waiting_since'
/** 审批动作词（**词首锚定**）：句柄上出现一个以它们开头的方法/键 ⇒ 本插件"能批准"，必须变红。
 *  为什么锚定词首：`commit_scopes` / `submitted_at` 这些**描述性字段名**里出现动作词是正常的
 *  （它们说的正是"这些动作只能在终端做人签"），只有**可调用/可触发的动作面**才是纪律问题。 */
const APPROVE_WORDS = /^(approve|decide|grant|submit|sign|ack|commit|accept)/i
/** 催办载荷里**绝不允许**出现的审批类字段（催办 ≠ 批准）。 */
const APPROVAL_FIELDS = ['approval_id', 'status', 'granted', 'decision', 'decided_by', 'approved_by', 'approve']

/** basis 解析（门自己实现，用来证明"每条变更单都指向载荷里的真键"）。 */
const resolveToken = (payload, token) => {
  if (token === 'as_of') return typeof payload?.as_of === 'string' && payload.as_of.trim() !== ''
  let parts = /^changes\[([^\]]+)\]\.([a-z_]+)$/.exec(String(token))
  if (parts) {
    const row = (payload?.changes ?? []).find((item) => item && String(item.change_id) === parts[1])
    return Boolean(row) && Object.prototype.hasOwnProperty.call(row, parts[2])
  }
  parts = /^approvals\[([^\]]+)\]\.([a-z_]+)$/.exec(String(token))
  if (parts) {
    const row = (payload?.approvals ?? []).find((item) => item && String(item.approval_id) === parts[1])
    return Boolean(row) && Object.prototype.hasOwnProperty.call(row, parts[2])
  }
  parts = /^events\[([^\]]+)\]\.count$/.exec(String(token))
  if (parts) {
    const type = parts[1]
    const rows = [...(payload?.approvals ?? []), ...(payload?.changes ?? [])]
      .filter((item) => item && String(item.type) === type)
    return rows.length > 0
  }
  return false
}
const basisOk = (payload, item) => Array.isArray(item.basis) && item.basis.length > 0
  && item.basis.every((token) => resolveToken(payload, token))

/**
 * 变异体要跑的四条场景（真产物必须**四条全真**）。
 * `mountFn` 是"给一份配置，给出一个实例"的工厂（真产物用 `mountWith`，变异体用 `mountMutant`）。
 */
const SCENARIOS = ['age 来自事实 ts', '空投影不编', '每条都有 basis', '不得批准']
const factsFor = async (mountFn) => {
  const base = await mountFn({})
  const clockA = await mountFn({ now: '2020-01-01T00:00:00Z' })
  const clockB = await mountFn({ now: '2036-12-31T23:59:59Z' })
  const json = (handle, payload) => JSON.stringify(handle.timeline(payload))
  const facts = {}
  // ① 墙钟入口（载荷 / 配置）各给两个不同值 ⇒ 输出必须逐字节一致，且 age 等于手算值
  const reference = json(base.box.handle, FULL)
  const gates = base.box.handle.timeline(FULL).gates
  facts['age 来自事实 ts'] = reference === json(clockA.box.handle, FULL)
    && reference === json(clockB.box.handle, FULL)
    && reference === json(base.box.handle, { ...FULL, now: '1999-01-01T00:00:00Z' })
    && gates.length === HAND_GATES.length
    && gates.every((item, index) => item.age_seconds === HAND_AGES[index])
  // ② 空投影不编：degraded + 有名 reason + 两个列表都为 0
  const empty = base.box.handle.timeline({ view: 'contractor' })
  facts['空投影不编'] = empty.degraded === true && HAND_REASONS.includes(empty.reason)
    && empty.gates.length === 0 && empty.changes.length === 0
  // ③ 每条都有 basis：变更单 basis 可溯源 + 门的 age_basis 写清口径
  const full = base.box.handle.timeline(FULL)
  facts['每条都有 basis'] = full.changes.length === HAND_CHANGES.length
    && full.changes.every((item) => basisOk(FULL, item))
    && full.gates.every((item) => typeof item.age_basis === 'string'
      && item.age_basis.includes('as_of') && item.age_basis.includes('requested'))
  // ④ 不得批准：句柄方法面 + 自述 + 催办载荷里都不能有审批动作
  const keys = Object.keys(base.box.handle)
  const meta = base.box.handle.meta()
  const record = base.box.handle.nudge(FULL, { gate_id: 'ap-0001', reason: 'r' }).record
  facts['不得批准'] = !keys.some((key) => APPROVE_WORDS.test(key))
    && base.box.handle.approve === undefined && base.box.handle.decide === undefined
    && base.box.handle.submit === undefined
    && meta.can_approve === false && Object.values(meta).every((value) => typeof value !== 'function')
    && record?.requested_action === 'nudge'
    && !Object.keys(record ?? {}).some((key) => APPROVAL_FIELDS.includes(key))
  return facts
}
const HAND_REASONS = ['payload-not-an-object', 'no-usable-inputs', 'no-signal']

/** 4 处单点变异（各自只改一处；`mustRed` 是"必须变红"的那条场景）。 */
const MUTATIONS = [
  { name: '变异1：age 改从 config.now（墙钟）算 —— 等待时长随"当前时间"漂移',
    find: '    const ageSeconds = round3((asOfMs - requestedMs) / 1000)',
    replace: '    const ageSeconds = round3((isoMs(options.now) ?? (asOfMs - requestedMs)) / 1000)',
    mustRed: 'age 来自事实 ts' },
  { name: '变异2：空投影守卫失效（没数据也报 degraded:false）',
    find: '  degraded: extra.reason !== null,',
    replace: '  degraded: false,',
    mustRed: '空投影不编' },
  { name: '变异3：变更单不再带 basis（凭据断链）',
    find: '    const basis = [`changes[${id}].type`, `changes[${id}].ts`, `events[${last.type}].count`]',
    replace: '    const basis = []',
    mustRed: '每条都有 basis' },
  { name: '变异4：句柄多出一个 approve 方法（插件"能批准"了）',
    find: "  ctx.provide('gateTimeline', handle)",
    replace: "  ctx.provide('gateTimeline', { ...handle, approve: () => ({ ok: true, granted: true }) })",
    mustRed: '不得批准' },
]

try {
  // ---------- 1. 契约正控 ----------
  const imports = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = imports.filter((spec) => !(spec === '../lib/std-schema.mjs' || spec.startsWith('node:')))
  const manifest = {
    name: mod.name === 'gate-timeline',
    inject: Array.isArray(mod.inject) && mod.inject.length === 0,
    builtin: Array.isArray(mod.builtin) && mod.builtin.length === 0,
    usedServices: Array.isArray(mod.usedServices) && mod.usedServices.length === 0,
    provides: JSON.stringify(mod.provides) === JSON.stringify(['gateTimeline']),
    config: typeof mod.Config?.['~standard']?.validate === 'function',
    apply: typeof mod.apply === 'function',
    fixture: typeof mod.fixture?.sample === 'function',
    engine: mod.ENGINE === 'rules',
    note: typeof mod.ENGINE_NOTE === 'string' && mod.ENGINE_NOTE.includes('不取墙钟'),
    clock: mod.AGE_CLOCK === 'facts-only',
    ageBasis: typeof mod.AGE_BASIS_NOTE === 'string' && mod.AGE_BASIS_NOTE.includes('as_of'),
    nowInputs: JSON.stringify(mod.IGNORED_NOW_INPUTS) === JSON.stringify(['payload.now', 'config.now']),
    sections: JSON.stringify(mod.SECTIONS) === JSON.stringify(['approvals', 'changes']),
    reasons: JSON.stringify(mod.DEGRADED_REASONS) === JSON.stringify(HAND_REASONS),
    nudgeCodes: JSON.stringify(mod.NUDGE_CODES) === JSON.stringify(['accepted', 'view-unknown', 'gate-not-found',
      'empty-reason', 'reason-too-long', 'payload-unusable']),
    action: mod.NUDGE_ACTION === 'nudge' && mod.NUDGE_KIND === 'gate-nudge' && mod.NUDGE_SCHEMA === 1,
    policies: JSON.stringify(mod.TIMEOUT_POLICIES) === JSON.stringify(['remind', 'escalate', 'abort']),
    resolved: JSON.stringify(mod.RESOLVED_APPROVAL_EVENTS)
      === JSON.stringify(['approval/granted', 'approval/denied', 'approval/aborted']),
    states: JSON.stringify(mod.CHANGE_STATES) === JSON.stringify(['proposed', 'priced', 'approved', 'rejected', 'unknown']),
    commands: ['quote.submit', 'award.commit', 'po.issue', 'change.approve'].every((scope) =>
      typeof mod.GATE_COMMANDS[scope] === 'string' && mod.GATE_COMMANDS[scope].includes('python3')
      && mod.GATE_COMMANDS[scope].includes('quotagent.g1side')),
    // 本批（规则 ⑤ 逐行明细）：金额口径 / 闭合的明细降级原因 / 11 键 / 私域视图白名单（围栏变宽=变红）
    detailMoney: mod.MONEY_UNIT === 'cents' && mod.ROUNDING === 'half-up-to-cent'
      && typeof mod.MONEY_NOTE === 'string' && mod.MONEY_NOTE.includes('整数分'),
    detailReasons: JSON.stringify(mod.DETAIL_REASONS)
      === JSON.stringify(['payload-not-an-object', 'change-not-found', 'no-usable-lines']),
    detailKeys: Array.isArray(mod.DETAIL_KEYS) && mod.DETAIL_KEYS.length === 11
      && mod.DETAIL_KEYS.includes('delta_pct') && mod.DETAIL_KEYS.includes('basis'),
    detailPrivate: JSON.stringify(mod.PRIVATE_COLUMN_VIEWS) === JSON.stringify(['contractor'])
      && Array.isArray(mod.PRIVATE_KEY_MARKS) && mod.PRIVATE_KEY_MARKS.length === 4,
    detailFn: typeof mod.changeDetailOf === 'function',
  }
  const manifestBad = Object.entries(manifest).filter(([, ok]) => !ok).map(([key]) => key)
  const scriptNeedle = '<scr' + 'ipt'
  check('1 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[gateTimeline]/Config/apply/fixture/'
    + 'ENGINE/ENGINE_NOTE/AGE_CLOCK/AGE_BASIS_NOTE/IGNORED_NOW_INPUTS/两段/闭合的降级原因与催办 code/'
    + '三条超时策略/已决事件/五个变更状态/四条真 CLI/**逐行明细口径：`MONEY_UNIT="cents"`（整数分）与 '
    + 'half-up-to-cent / 闭合的 DETAIL_REASONS / 11 键 / 私域视图白名单**），且只 import ../lib 白名单'
    + '（或 node:），源码里 0 个脚本字面量',
  manifestBad.length === 0 && importLeaks.length === 0 && !originalSource.includes(scriptNeedle) && hookReady,
  `载入=${TARGET}；问题键=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；`
  + `含脚本字面量=${originalSource.includes(scriptNeedle)}；解析钩子=${hookReady ? '已装' : '不可用'}；`
  + `字节=${Buffer.byteLength(originalSource)}`)

  // ---------- 2. 挂载 + 零残留 ----------
  const probe = await mountWith({})
  const probeEffects = probe.fiber.getEffects().length
  const handle = probe.box.handle
  const methodsOk = Boolean(handle) && typeof handle.timeline === 'function' && typeof handle.nudge === 'function'
    && typeof handle.meta === 'function' && typeof handle.config === 'function'
  await probe.fiber.dispose()
  const probeAfter = probe.fiber.getEffects().length
  check('2 挂载正控：cordis 挂载后 provide 拦截拿得到句柄（timeline/nudge/meta/config），dispose 后 effect 归零',
    methodsOk && probeEffects > 0 && probeAfter === 0,
    `句柄键=${Object.keys(handle ?? {}).join('|') || '空'}；effect ${probeEffects} → ${probeAfter}`)

  const live = await mountWith({})
  const timeline = (payload) => live.box.handle.timeline(payload)
  const mountedCache = new Map()
  const withConfig = async (config, payload) => {
    const key = JSON.stringify(config)
    if (!mountedCache.has(key)) mountedCache.set(key, await mountWith(config))
    return mountedCache.get(key).box.handle.timeline(payload)
  }

  // ---------- 3. 诚实分层 ----------
  const full = timeline(FULL)
  const meta = live.box.handle.meta()
  check('3 诚实分层正控：输出与句柄自述都写死 `engine="rules"`、`engine_note` 与模块导出常量逐字一致，'
    + '`privacy` 四项如实申报（0 次模型调用 / 0 次网络 / 未读私域键 / **0 次读墙钟**）',
  full.engine === 'rules' && full.engine_note === mod.ENGINE_NOTE && full.engine_note.includes('不含模型推测')
  && meta.engine === 'rules' && meta.engine_note === mod.ENGINE_NOTE
  && full.privacy?.model_calls === 0 && full.privacy?.network_calls === 0
  && full.privacy?.private_keys_read === false && full.privacy?.clock_reads === 0
  && !/概率|模型判的|AI 判/.test(full.engine_note),
  `engine=${full.engine}；note=${full.engine_note}；privacy=${JSON.stringify(full.privacy)}`)

  // ---------- 4. age 不来自墙钟（核心） ----------
  const clockPayload = { ...FULL, now: '1999-01-01T00:00:00Z' }
  const clockPayload2 = { ...FULL, now: '2049-12-31T23:59:59Z' }
  const jsonLive = JSON.stringify(full)
  const clockCfg = await withConfig({ now: '2020-01-01T00:00:00Z' }, FULL)
  const clockCfg2 = await withConfig({ now: '2036-12-31T23:59:59Z' }, FULL)
  const payloadClockSame = jsonLive === JSON.stringify(timeline(clockPayload))
    && jsonLive === JSON.stringify(timeline(clockPayload2))
  const configClockSame = jsonLive === JSON.stringify(clockCfg) && jsonLive === JSON.stringify(clockCfg2)
  const agesHand = JSON.stringify(full.gates.map((item) => item.id)) === JSON.stringify(HAND_GATES)
    && JSON.stringify(full.gates.map((item) => item.age_seconds)) === JSON.stringify(HAND_AGES)
  check('4 **「等了多久」的口径不来自墙钟**（本门最核心的一条）：同一份快照在两个不同 `now` 入口'
    + '（载荷 `payload.now` / 配置 `config.now`，各给两个不同的值）下输出**逐字节一致**，'
    + '且 `age_seconds` 等于手算的「as_of(12:00) − requested 事实 ts」= [7200, 3600, 1800, 600]',
  payloadClockSame && configClockSame && agesHand && jsonLive.length > 800,
  `载荷 now 两个值一致=${payloadClockSame}；配置 now 两个值一致=${configClockSame}；`
  + `手算 age=${JSON.stringify(full.gates.map((item) => item.age_seconds))}；实得 id=${JSON.stringify(full.gates.map((item) => item.id))}`)

  // ---------- 5. 口径自述 ----------
  const basisLines = full.gates.map((item) => item.age_basis)
  const basisOkAll = basisLines.every((line) => typeof line === 'string' && line.includes('as_of')
    && line.includes('不取墙钟') && /\d{4}-\d{2}-\d{2}T/.test(line))
  check('5 口径自述正控：每条门都带非空 `age_basis`（含 `as_of`、本门 requested 的事实 ts 与"不取墙钟"字样），'
    + '输出里 `age_clock="facts-only"`，且 `ignored_now_inputs` 列出被忽略的两个墙钟入口',
  basisOkAll && full.age_clock === 'facts-only' && full.age_basis_note === mod.AGE_BASIS_NOTE
  && JSON.stringify(full.ignored_now_inputs) === JSON.stringify(['payload.now', 'config.now']),
  `示例 age_basis=${String(basisLines[0]).slice(0, 120)}…；age_clock=${full.age_clock}`)

  // ---------- 6. 门条目形状 ----------
  const keysFixed = full.gates.every((item) => Object.keys(item).sort().join('|') === GATE_KEYS)
  const shapeBad = full.gates.filter((item) => !(typeof item.owner === 'string' && item.owner.length > 1
    && typeof item.kind === 'string' && item.kind.length > 2
    && typeof item.subject === 'string' && item.subject.length > 3
    && typeof item.consequence === 'string' && item.consequence.length > 8
    && typeof item.next_action === 'string' && item.next_action.includes('quotagent.g1side')
    && typeof item.blocked_by === 'string' && item.blocked_by.includes('不能代签')
    && Number.isFinite(item.age_seconds) && item.age_seconds >= 0))
  const changeKeysFixed = full.changes.every((item) => Object.keys(item).sort().join('|') === CHANGE_KEYS)
  const idUnique = new Set(full.gates.map((item) => item.id)).size === full.gates.length
    && new Set(full.changes.map((item) => item.id)).size === full.changes.length
  check('6 门条目形状正控：键集**恰 9 键**（id/kind/subject/owner/age_seconds/age_basis/consequence/'
    + 'next_action/blocked_by）、owner/subject/consequence 非空、next_action 指向**真 CLI**、'
    + '`blocked_by` 必须写明"不能代签"、age_seconds 是 ≥0 的有限数；变更单键集恰 6 键；两类 id 各自唯一',
  keysFixed && changeKeysFixed && shapeBad.length === 0 && idUnique
  && full.gates.length === HAND_GATES.length && full.changes.length === HAND_CHANGES.length,
  `门键集固定=${keysFixed} 变更键集固定=${changeKeysFixed}；异常门=${shapeBad.length}；id 唯一=${idUnique}；`
  + `门=${full.gates.length} 变更单=${full.changes.length}`)

  // ---------- 7. 排序与计数 ----------
  check('7 排序与计数正控：门按"等得最久"在前（同长按 id 字典序）、变更单按"谁欠动作"在前；'
    + '`counts` 逐项手算对齐（门 4/4/0、变更 4/4/0、策略 1/1/1/1、状态 priced2/approved1/rejected1）',
  JSON.stringify(full.gates.map((item) => item.id)) === JSON.stringify(HAND_GATES)
  && JSON.stringify(full.changes.map((item) => item.id)) === JSON.stringify(HAND_CHANGES)
  && JSON.stringify(full.counts.gates) === JSON.stringify({ found: 4, shown: 4, omitted: 0 })
  && JSON.stringify(full.counts.changes) === JSON.stringify({ found: 4, shown: 4, omitted: 0 })
  && JSON.stringify(full.counts.by_policy) === JSON.stringify(HAND_POLICY)
  && full.counts.by_state.priced === 2 && full.counts.by_state.approved === 1
  && full.counts.by_state.rejected === 1 && full.counts.by_state.proposed === 0
  && full.counts.shown === 8 && full.counts.omitted === 0 && full.truncated === false && full.degraded === false
  && full.reason === null,
  `门序=${JSON.stringify(full.gates.map((item) => item.id))}；变更序=${JSON.stringify(full.changes.map((item) => item.id))}；`
  + `counts=${JSON.stringify(full.counts)}；degraded=${full.degraded}/${full.reason}`)

  // ---------- 8. 超时策略后果 ----------
  const byId = Object.fromEntries(full.gates.map((item) => [item.id, item]))
  const consequenceOk = byId['ap-0001'].consequence.includes('转给人类上级')
    && byId['ap-0001'].consequence.includes('已超过超时阈值')
    && byId['ap-0002'].consequence.includes('再等约 82800 秒') && byId['ap-0002'].consequence.includes('remind')
    && byId['ap-0003'].consequence.includes('作废')
    && byId['ap-0005'].consequence.includes('绝不自动批准')
  const noAutoGrant = full.gates.every((item) => /不批准|不是批准|不自动批准/.test(item.consequence))
    && !full.gates.some((item) => /会自动批准|将自动批准|则自动批准/.test(item.consequence))
  check('8 超时策略后果正控（**再等下去会发生什么**）：escalate+已超时 → "转给人类上级"；remind+未超时 → '
    + '"再等约 82800 秒"；abort+已超时 → "作废（需重新发起）"；认不出的策略 → "按绝不自动批准处理"；'
    + '**三条策略里没有"会批准"这种话**',
  consequenceOk && noAutoGrant && full.gates.length === 4,
  `ap-0001=${byId['ap-0001'].consequence.slice(0, 60)}…；ap-0002=${byId['ap-0002'].consequence.slice(0, 40)}…；`
  + `ap-0005=${byId['ap-0005'].consequence.slice(0, 40)}…`)

  // ---------- 9. 每条变更单都有 basis（含非空转对照） ----------
  const basisBad = full.changes.filter((item) => !basisOk(FULL, item))
  const counterexamples = [
    resolveToken(FULL, 'changes[chg-9999].state'),
    resolveToken(FULL, 'changes[chg-0001].no_such_key'),
    resolveToken(FULL, 'changes chg-0001 state'),
    basisOk(FULL, { basis: [] }),
    resolveToken(FULL, 'events[mystery/type].count'),
  ]
  check('9 **每条变更单都有 `basis`** 正控：非空且每个 token 都解析回载荷真键'
    + '（`changes[<id>].<键>` / `approvals[<id>].<键>` / `events[<事件类型>].count`）；'
    + '**非空转对照**：不存在的 ref / 不存在的键 / 坏形状 / 空 basis / 不存在的事件类型 五种篡改都必须判假',
  basisBad.length === 0 && counterexamples.every((item) => item === false)
  && full.changes.every((item) => item.basis.filter((token) => token.startsWith('events[')).length === 1),
  `不达标条=${basisBad.length}；对照全部判假=${counterexamples.every((item) => item === false)}；`
  + `示例 basis=${JSON.stringify(full.changes[0].basis)}`)

  // ---------- 10. 状态机 ----------
  const states = full.changes.map((item) => item.state)
  const rejectedWins = timeline({ view: 'contractor', as_of: FULL.as_of, changes: [
    { change_id: 'chg-9', type: 'change/priced', ts: '2026-09-25T11:00:00Z', delta_amount: 1 },
    { change_id: 'chg-9', type: 'change/rejected', ts: '2026-09-25T11:01:00Z', code: 'basis-mismatch' },
  ] })
  const unknownState = timeline({ view: 'contractor', as_of: FULL.as_of, changes: [
    { change_id: 'chg-8', type: 'change/mystery', ts: '2026-09-25T11:00:00Z' },
  ] })
  check('10 变更状态机正控：proposed+priced → `priced`；approved → `approved`；'
    + '**先 priced 后 rejected 以 rejected 为准**；认不出的类型 → `unknown` 并留一条说明（不猜）',
  JSON.stringify(states) === JSON.stringify(HAND_STATES)
  && rejectedWins.changes[0].state === 'rejected' && rejectedWins.changes[0].basis.length >= 3
  && unknownState.changes[0].state === 'unknown'
  && JSON.stringify(unknownState.notes).includes('不在变更状态机里'),
  `实得状态=${JSON.stringify(states)}；期望=${JSON.stringify(HAND_STATES)}；`
  + `rejected 覆盖=${rejectedWins.changes[0].state}；unknown=${unknownState.changes[0].state}`)

  // ---------- 11. 谁欠谁一个动作 ----------
  const owed = full.changes.map((item) => item.owed_by)
  check('11 「谁欠谁一个动作」正控：`priced` 且有对应 `change.approve` 门 → 用队列里的**真审批人**'
    + '（`human:caiwu`）；`priced` 但没有对应门 → `human:unassigned`（不编人名，并留说明）；'
    + '`proposed`→`contractor-agent`；`rejected`→`proposer`；`approved`→`none`',
  JSON.stringify(owed) === JSON.stringify(HAND_OWED) && full.changes[1].owed_by === 'human:unassigned'
  && JSON.stringify(full.notes).includes('欠谁签如实记 unassigned')
  && full.changes[0].waiting_since === '2026-09-25T11:00:00Z'
  && full.changes[3].waiting_since === '2026-09-25T11:45:00Z',
  `实得 owed_by=${JSON.stringify(owed)}；期望=${JSON.stringify(HAND_OWED)}；说明=${JSON.stringify(full.notes).slice(0, 120)}`)

  // ---------- 11b. 已决判据（与账本追加序一致，避免"页面说待批、Python 说已决"） ----------
  const sameSecond = timeline({ view: 'contractor', as_of: FULL.as_of, approvals: [
    { approval_id: 'ap-s1', type: 'approval/requested', ts: '2026-09-25T11:59:00Z', scope: 'po.issue',
      ref: 'po-s1', timeout_policy: 'remind', timeout_s: 60 },
    { approval_id: 'ap-s1', type: 'approval/granted', ts: '2026-09-25T11:59:00Z', scope: 'po.issue', ref: 'po-s1' },
  ] })
  const reopened = timeline({ view: 'contractor', as_of: FULL.as_of, approvals: [
    { approval_id: 'ap-s2', type: 'approval/requested', ts: '2026-09-25T09:00:00Z', scope: 'po.issue', ref: 'po-s2',
      timeout_policy: 'remind', timeout_s: 60 },
    { approval_id: 'ap-s2', type: 'approval/granted', ts: '2026-09-25T09:30:00Z', scope: 'po.issue', ref: 'po-s2' },
    { approval_id: 'ap-s2', type: 'approval/requested', ts: '2026-09-25T11:00:00Z', scope: 'po.issue', ref: 'po-s2',
      timeout_policy: 'remind', timeout_s: 60 },
  ] })
  check('11b 已决判据正控（**与账本语义对齐**）：请求与决定落在**同一时刻**（同 ts）⇒ 以**终态**为准、'
    + '**不算还在等**（否则页面说"待批"、Python 侧说"已决"，同一件事两个口径）；决定之后又出现新的请求 ⇒ '
    + '仍算还在等，且**等待起点 = 最后一次请求**（重开的门重新计时：11:00 那条，不是 09:00 那条）',
  sameSecond.gates.length === 0 && sameSecond.changes.length === 0 && sameSecond.reason === 'no-signal'
  && reopened.gates.length === 1 && reopened.gates[0].id === 'ap-s2'
  && reopened.gates[0].age_seconds === 3600,
  `同刻 requested+granted → 门=${sameSecond.gates.length}（期望 0）；决定后重开 → 门=${reopened.gates.length}`
  + `（期望 1）age=${reopened.gates.map((item) => item.age_seconds)}（期望 [3600]：as_of 12:00 − 最后一次请求 11:00）`)

  // ---------- 12. 插件不能批准（硬负控） ----------
  const HANDLE_KEYS = 'change_detail|config|meta|nudge|requests|timeline'
  const handleKeys = Object.keys(live.box.handle).sort().join('|')
  const noApproveWords = !Object.keys(live.box.handle).some((key) => APPROVE_WORDS.test(key))
    && Object.values(meta).every((value) => typeof value !== 'function') && meta.can_approve === false
  const absent = ['approve', 'decide', 'grant', 'submit', 'sign', 'ack', 'commit', 'accept']
    .every((name) => live.box.handle[name] === undefined)
  const nudgeRun = live.box.handle.nudge(FULL, { gate_id: 'ap-0001', reason: '现场催一下' })
  const record = nudgeRun.record
  check('12 **插件不能批准**（硬负控）：句柄方法集合恰为 `change_detail|config|meta|nudge|requests|timeline`，'
    + '没有任何 `approve/decide/grant/submit/sign/ack/commit/accept` 方法；`meta.can_approve=false`；'
    + '催办载荷里只有 `requested_action="nudge"`，且记录与自述里都没有任何审批类字段名',
  handleKeys === HANDLE_KEYS && noApproveWords && absent
  && typeof live.box.handle.change_detail === 'function'
  && record?.requested_action === 'nudge'
  && !Object.keys(record ?? {}).some((key) => APPROVAL_FIELDS.includes(key))
  && String(nudgeRun.next_action).includes('tools/gate-nudge.py')
  && !/granted/.test(JSON.stringify(nudgeRun.record)),
  `句柄键=${handleKeys}；无审批方法=${absent && noApproveWords}；can_approve=${meta.can_approve}；`
  + `记录的 requested_action=${record?.requested_action}`)

  // ---------- 13. 催办载荷 ----------
  const REASON = '这批料已经到场了，等您签字才能开工（原话逐字）'
  const nudgeA = live.box.handle.nudge(FULL, { gate_id: 'ap-0001', reason: REASON })
  const nudgeB = live.box.handle.nudge(FULL, { gate_id: 'ap-0001', reason: REASON })
  const digest = 'sha256:' + sha256(REASON)
  check('13 催办载荷正控：含**用户原话逐字**、目标门 id、独立重算一致的 `reason_sha256`、字节数、'
    + '`submitted_at` 为空（宿主不取墙钟）；id 形状 `gn-<view>-<12hex>`；**同一（门+理由）→ 同一 id**（幂等）',
  nudgeA.ok && nudgeA.code === 'accepted' && nudgeA.record.reason === REASON
  && nudgeA.record.gate_id === 'ap-0001' && nudgeA.record.view === 'contractor'
  && nudgeA.record.reason_sha256 === digest && nudgeA.record.bytes === Buffer.byteLength(REASON, 'utf8')
  && nudgeA.record.submitted_at === '' && /^gn-contractor-[0-9a-f]{12}$/.test(nudgeA.id)
  && nudgeA.id === nudgeB.id && nudgeB.record.reason_sha256 === digest
  && String(nudgeA.next_action).includes('tools/gate-nudge.py'),
  `code=${nudgeA.code} id=${nudgeA.id} sha=${nudgeA.record?.reason_sha256} bytes=${nudgeA.record?.bytes}；`
  + `同（门+理由）同 id=${nudgeA.id === nudgeB.id}`)

  // ---------- 14. 催办拒绝路径 ----------
  const longReason = 'x'.repeat(3000)
  const refusals = {
    'gate-not-found': live.box.handle.nudge(FULL, { gate_id: 'ap-9999', reason: 'r' }),
    'empty-reason': live.box.handle.nudge(FULL, { gate_id: 'ap-0001', reason: '   ' }),
    'reason-too-long': live.box.handle.nudge(FULL, { gate_id: 'ap-0001', reason: longReason }),
    'view-unknown': live.box.handle.nudge({ ...FULL, view: '' }, { gate_id: 'ap-0001', reason: 'r' }),
    'payload-unusable': live.box.handle.nudge('nope', { gate_id: 'ap-0001', reason: 'r' }),
  }
  const refusalBad = Object.entries(refusals).filter(([code, out]) => out.code !== code || out.ok !== false
    || typeof out.next_action !== 'string' || out.next_action.trim() === '' || out.record !== null
    || out.id !== '')
  check('14 催办拒绝路径正控：`gate-not-found`（门不在本视角投影的待办列表里）/`empty-reason`/'
    + '`reason-too-long`/`view-unknown`/`payload-unusable` 各自给**具体 code + 非空 next_action**，'
    + '且 `record` 为 null（拒绝时**不产任何落盘载荷**）',
  refusalBad.length === 0 && Object.keys(refusals).length === 5
  && refusals['gate-not-found'].next_action.includes('ap-9999'),
  `不合格=${JSON.stringify(refusalBad.map(([code]) => code))}；`
  + `codes=${JSON.stringify(Object.values(refusals).map((item) => item.code))}`)

  // ---------- 15. 空投影不编（硬负控） ----------
  const emptyCases = [
    ['空对象', { view: 'contractor' }], ['undefined', undefined], ['null', null], ['字符串', 'garbage'],
    ['数字', 42], ['空数组段', { view: 'supplier', approvals: [], changes: [] }],
    ['坏形状段', { view: 'supplier', approvals: ['x', 7, null], changes: [null, 'y'] }],
    ['缺关键字段', { view: 'supplier', approvals: [{ scope: 'award.commit' }], changes: [{ type: 'change/priced' }] }],
  ]
  const emptyReport = []
  let emptyThrew = null
  for (const [label, payload] of emptyCases) {
    try {
      const out = timeline(payload)
      const okCase = out.degraded === true && HAND_REASONS.includes(out.reason)
        && out.gates.length === 0 && out.changes.length === 0
      emptyReport.push(`${label}→${out.degraded}/${out.reason}/门=${out.gates.length}/变更=${out.changes.length}`)
      if (!okCase) emptyReport.push(`!! ${label} 形状不对：${JSON.stringify(out).slice(0, 80)}`)
    } catch (err) { emptyThrew = `${label}: ${err.name}` }
  }
  const noSignal = timeline({ view: 'contractor', as_of: FULL.as_of, approvals: [
    { approval_id: 'ap-9', type: 'approval/requested', ts: '2026-09-25T10:00:00Z', scope: 'x', timeout_policy: 'remind' },
    { approval_id: 'ap-9', type: 'approval/granted', ts: '2026-09-25T11:00:00Z', scope: 'x' },
  ] })
  check('15 **空投影不编**（硬负控）：空载荷 / 非对象 / 坏形状 / 缺关键字段一律 `degraded:true` + **有名** reason '
    + '+ **两个列表都为 0**，且不抛错；"载荷不能用"（no-usable-inputs）与"数据齐但无可报项"（no-signal）'
    + '是**两个不同**的 reason（不许含糊成一条）',
  emptyThrew === null && emptyReport.every((line) => !line.startsWith('!!'))
  && noSignal.degraded === true && noSignal.reason === 'no-signal'
  && noSignal.gates.length === 0 && noSignal.changes.length === 0
  && full.degraded === false && full.reason === null,
  `抛错=${emptyThrew ?? '无'}；${emptyReport.join(' | ')}；no-signal→${noSignal.reason}；正常=${full.degraded}`)

  // ---------- 16. 确定性 ----------
  const d1 = JSON.stringify(timeline(FULL))
  const d2 = JSON.stringify(timeline(FULL))
  const shuffled = { changes: FULL.changes, as_of: FULL.as_of, approvals: FULL.approvals, view: FULL.view }
  const d3 = JSON.stringify(timeline(shuffled))
  const reversed = { ...FULL, approvals: [...FULL.approvals].reverse(), changes: [...FULL.changes].reverse() }
  const d4 = JSON.stringify(timeline(reversed))
  const other = await mountWith({})
  const d5 = JSON.stringify(other.box.handle.timeline(FULL))
  const timeKeys = /"(ts|at|now|time|elapsed|date|generated_at)"\s*:/.test(d1)
  check('16 确定性负控：同输入两次逐字节一致 / **键序打乱**一致 / **条目顺序打乱**一致 / 跨实例一致 / '
    + '输出里没有时间字段（`as_of` 是入参事实的回显，不是本层取的时钟）',
  d1 === d2 && d2 === d3 && d3 === d4 && d4 === d5 && d1.length > 800 && !timeKeys,
  `两次一致=${d1 === d2}；键序一致=${d2 === d3}；条目逆序一致=${d3 === d4}；跨实例一致=${d4 === d5}；`
  + `长度=${d1.length}；含时间键=${timeKeys}`)

  // ---------- 17. 私域哨兵 ----------
  const SENTINELS = ['COST-MODEL-SENTINEL-9a', 'PRIVATE-NOTE-SENTINEL-7f', 'RESERVE-PRICE-SENTINEL-4b', '987654321']
  const DIRTY = {
    ...FULL,
    approvals: FULL.approvals.map((item) => ({ ...item, 'private:note': SENTINELS[1], reserve_price: 987654321 })),
    changes: FULL.changes.map((item) => ({ ...item, cost_model: SENTINELS[0], bidders_private: '内部',
      authorized_band: { min_unit_price: 1, max_unit_price: 2 }, internal_notes: '内部备注' })),
  }
  const cleanRun = JSON.stringify(timeline(FULL))
  const dirtyRun = JSON.stringify(timeline(DIRTY))
  const hitInOutput = SENTINELS.filter((needle) => dirtyRun.includes(needle))
  const hitInInput = SENTINELS.filter((needle) => JSON.stringify(DIRTY).includes(needle))
  const privateKeyNames = ['private:note', 'reserve_price', 'cost_model', 'bidders_private', 'authorized_band',
    'internal_notes']
  const keyLeaks = privateKeyNames.filter((needle) => dirtyRun.includes(needle))
  check('17 私域哨兵负控：加在条目上的私域键（`private:*`/`reserve_price`/`cost_model`/`bidders_private`/'
    + '`authorized_band`/`internal_notes`）**读都不读** → 带哨兵与不带哨兵输出**逐字节一致**、哨兵与键名 0 命中；'
    + '**非空转对照**：同一批哨兵在输入里确实存在',
  hitInOutput.length === 0 && keyLeaks.length === 0 && hitInInput.length >= 3 && cleanRun === dirtyRun
  && dirtyRun.includes('ap-0001'),
  `输出命中=${hitInOutput.join(',') || '无'}；键名命中=${keyLeaks.join(',') || '无'}；`
  + `输入命中（对照）=${hitInInput.join(',')}；逐字节一致=${cleanRun === dirtyRun}`)

  // ---------- 18. 有界与 omitted ----------
  const cap = await withConfig({ max_items: 2 }, FULL)
  const big = await withConfig({ max_items: 1000 }, FULL)
  const low = await withConfig({ max_items: 0 }, FULL)
  let badLimit = null
  try { badLimit = await withConfig({ max_items: 'many' }, FULL) } catch (err) { badLimit = { refused: err.message.slice(0, 60) } }
  const policySum = Object.values(cap.counts.by_policy).reduce((acc, value) => acc + value, 0)
  const stateSum = Object.values(cap.counts.by_state).reduce((acc, value) => acc + value, 0)
  check('18 有界与 `omitted` 诚实负控：`max_items` 夹取生效（0 → 下界 1；1000 → 上界 200；非数字 → 回落 20）；'
    + '**两段各自截断**并如实报 `omitted`/`truncated`；`shown+omitted==found`；`by_policy`/`by_state` 之和 '
    + '== 生成条数（截断只影响展示，不改口径）',
  cap.gates.length === 2 && cap.changes.length === 2 && cap.omitted === 4 && cap.truncated === true
  && cap.counts.gates.omitted === 2 && cap.counts.changes.omitted === 2
  && cap.counts.shown + cap.counts.omitted === cap.counts.gates.found + cap.counts.changes.found
  && big.gates.length === 4 && big.changes.length === 4 && big.omitted === 0 && big.truncated === false
  && low.gates.length === 1 && low.changes.length === 1 && low.omitted === 6
  && policySum === 4 && stateSum === 4
  && badLimit !== null && (badLimit.refused !== undefined || badLimit.gates.length === 4),
  `上限 2 → 门 ${cap.gates.length}/变更 ${cap.changes.length} omitted=${cap.omitted} truncated=${cap.truncated}；`
  + `策略和=${policySum} 状态和=${stateSum}；上限 1000 → ${big.omitted}；上限 0 → ${low.omitted}；`
  + `'many' → ${badLimit.refused === undefined ? '回落默认' : `挂载即拒：${badLimit.refused}`}`)

  // ---------- 19. 零写面 / 不读账本 ----------
  const FORBIDDEN = ['writeFile', 'appendFile', 'createWriteStream', 'mkdirSync', 'rmSync', 'renameSync',
    'readFileSync', 'openLedger', 'ledger', 'Date.now', 'new Date', 'Math.random', 'process.env', 'fetch(',
    'spawn', 'execFile', 'setInterval(', 'setTimeout(', 'ctx.on(', 'ctx.events', 'child_process', 'require(',
    'http.request', 'net.connect']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const hits = scan(originalSource)
  const selfTest = scan(`const tick = set${'Interval'}(() => {}, 1); open${'Ledger'}(p); await fetch${'('}(u)`)
  check('19 零写面负控：产物**零写面、不读账本、不联网、不调模型、不取墙钟**（无写/读文件、账本、墙钟、'
    + '随机、网络、子进程、事件订阅、定时器）且扫描器**非空转**（对照样本必须命中 ≥3）',
  hits.length === 0 && selfTest.length >= 3,
  `产物命中=${hits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}`)

  // ---------- 20. 配置不得静默放行 ----------
  const refuses = (raw) => { try { mod.Config.parse(raw); return 'accepted' } catch { return 'refused' } }
  const defaults = mod.Config.parse({})
  const boundsRun = await withConfig({}, FULL)
  check('20 负控：配置不得静默放行（未知键 / 错类型 / 非对象入参一律被拒；空配置给出默认值；'
    + '`deterministic` 是 const 键，翻转即拒）；`bounds` 回显解析后的真值',
  refuses({ mystery_key: 1 }) === 'refused' && refuses({ max_items: 'many' }) === 'refused'
  && refuses(42) === 'refused' && refuses({ deterministic: false }) === 'refused'
  && defaults.max_items === 20 && defaults.route_prefix === '/quotagent' && defaults.now === ''
  && defaults.deterministic === true
  && JSON.stringify(boundsRun.bounds) === JSON.stringify({ max_items: 20, sections: ['approvals', 'changes'],
    reason_max_bytes: 2048 }),
  `未知键=${refuses({ mystery_key: 1 })} 错类型=${refuses({ max_items: 'many' })} 非对象=${refuses(42)} `
  + `翻转 const=${refuses({ deterministic: false })}；默认=${JSON.stringify(defaults)}；`
  + `bounds=${JSON.stringify(boundsRun.bounds)}`)

  // ---------- 21. fixture 纯读取 ----------
  const reference = JSON.stringify(timeline(FULL))
  const first = JSON.stringify(mod.fixture.sample(live.box.handle))
  const second = JSON.stringify(mod.fixture.sample(live.box.handle))
  const frozen = JSON.stringify(timeline(deepFreeze(JSON.parse(JSON.stringify(FULL)))))
  check('21 正控：fixture 纯读取（连跑两次逐字节一致、不改变句柄行为），且**冻结输入**不抛错'
    + '（ESM 严格模式下任何对入参的写入都会抛 TypeError → 证明没偷偷改调用方的载荷）',
  first === second && first.length > 80 && frozen === reference && JSON.stringify(timeline(FULL)) === reference,
  `fixture 两次一致=${first === second} 长度=${first.length}；冻结输入一致=${frozen === reference}`)

  // ---------- 22-25. 真 HTTP ----------
  const fixtureDir = mkdtempSync(join(tmpdir(), 't282-http-'))
  const contractorLedger = join(fixtureDir, 'contractor.jsonl')
  const supplierLedger = join(fixtureDir, 'supplier-empty.jsonl')   // 不写文件 = 空投影
  const uiShared = join(fixtureDir, 'ui-shared')
  mkdirSync(uiShared, { recursive: true })
  const SENTINEL_ROW = { cost_floor: 987654321, markup_pct: 12.5, reserve_price: 'RESERVE-PRICE-SENTINEL-4b',
    'private:note': 'PRIVATE-NOTE-SENTINEL-7f', cost_model: 'COST-MODEL-SENTINEL-9a' }
  const httpRows = [
    { seq: 1, type: 'approval/requested', correlation_id: 'awin-1', actor: 'agent:approval',
      ts: '2026-09-21T08:00:00Z', realm: 'contractor:con-B',
      body: { approval_id: 'ap-0007', scope: 'award.commit', ref: 'awin-1', summary: '授标承诺',
        approvers: ['human:liangzi'], timeout_policy: 'escalate', timeout_s: 3600, escalate_to: 'human:boss' } },
    { seq: 2, type: 'approval/requested', correlation_id: 'po-1', actor: 'agent:approval',
      ts: '2026-09-21T09:00:00Z', realm: 'contractor:con-B',
      body: { approval_id: 'ap-0009', scope: 'po.issue', ref: 'po-1', timeout_policy: 'remind', timeout_s: 86400 } },
    { seq: 3, type: 'approval/requested', correlation_id: 'q-1', actor: 'agent:approval',
      ts: '2026-09-21T07:00:00Z', realm: 'contractor:con-B',
      body: { approval_id: 'ap-0001', scope: 'quote.submit', ref: 'q-1', timeout_policy: 'remind', timeout_s: 60 } },
    { seq: 4, type: 'approval/granted', correlation_id: 'q-1', actor: 'human:liangzi',
      ts: '2026-09-21T07:30:00Z', realm: 'contractor:con-B',
      body: { approval_id: 'ap-0001', scope: 'quote.submit', ref: 'q-1' } },
    { seq: 5, type: 'change/priced', correlation_id: 'chg-0001', actor: 'agent:change',
      ts: '2026-09-21T10:00:00Z', realm: 'contractor:con-B',
      body: { change_id: 'chg-0001', quote_id: 'q-1', delta_amount: 1720,
        basis_unit_price_refs: ['q-1#L-001:unit_price'] } },
    // 私域行：带 `private:` 命名的键 → 整行跳过，但夹具文件里**确实有哨兵**
    { seq: 6, type: 'quote/submitted', correlation_id: 'q-private', actor: 'agent:supplier',
      ts: '2026-09-21T11:30:00Z', realm: 'contractor:con-B',
      body: { quote_id: 'q-private', lines: [{ item_id: 'L-001', qty: 10, unit_price: 60 }], ...SENTINEL_ROW } },
  ]
  writeFileSync(contractorLedger, httpRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const ledgerHash = sha256(readFileSync(contractorLedger, 'utf8'))

  const httpCtx = new Context()
  await httpCtx.plugin(EventsService)
  const httpBox = {}
  httpCtx.provide('ledgerView', { path: '(t282-fixture)', rows: () => [], count: () => 0,
    verify: () => ({ ok: true, checked: 0, count: 0, head: 'sha256:' + '0'.repeat(64) }), byType: () => [] })
  const mountReal = async (file, raw, service, name) => {
    const loaded = await import(pathToFileURL(join(HERE, 'modules', file)).href)
    await httpCtx.plugin({
      name: `${name}#t282`,
      inject: loaded.inject ?? [],
      Config: loaded.Config,
      apply: async (inner, config) => {
        const originalProvide = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) httpBox[service] = v; return originalProvide(s, v) }
        await loaded.apply(inner, config)
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
  await mountReal('admin-guard.mjs', { token_env: 'QUOTAGENT_ADMIN_TOKEN_T282' }, 'adminGuard', 'admin-guard')
  await mountReal('admin-view.mjs', { admin_snapshot: '' }, 'adminView', 'admin-view')
  await mountReal('plugin-market.mjs', { modules_dir: join(HERE, 'modules'),
    inventory: join(HERE, '..', 'docs', 'design', '14-plugin-inventory.md'), user_space: '' }, 'pluginMarket', 'plugin-market')
  await mountReal('user-plugin-manager.mjs', { root: join(HERE, '..', 'user-space') }, 'userPluginManager', 'user-plugin-manager')
  await mountReal('config-view.mjs', {}, 'configView', 'config-view')
  await mountReal('mail-view.mjs', { mail_state: '', ui_shared: '' }, 'mailView', 'mail-view')
  await mountReal('bid-heuristics.mjs', {}, 'bidHeuristics', 'bid-heuristics')
  await mountReal('advice-panel.mjs', {}, 'advicePanel', 'advice-panel')
  await mountReal('gate-timeline.mjs', {}, 'gateTimeline', 'gate-timeline')
  await mountReal('authority-band.mjs', {}, 'authorityBand', 'authority-band')
  await mountReal('rfq-deadline.mjs', {}, 'rfqDeadline', 'rfq-deadline')
  await mountReal('ui-feedback.mjs', { ui_shared: '' }, 'uiFeedback', 'ui-feedback')
  const projection = await import(pathToFileURL(join(HERE, 'modules', 'projection.mjs')).href)
  await httpCtx.plugin({ name: 'projection#t282', inject: [], Config: projection.Config,
    apply: (inner, config) => projection.apply(inner, config) }, projection.Config.parse({}))
  const webui = await import(pathToFileURL(WEBUI).href)
  const httpFiber = await httpCtx.plugin({
    name: 'webui#t282',
    inject: webui.inject,
    Config: webui.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'webui') httpBox.webui = v; return originalProvide(s, v) }
      await webui.apply(inner, config)
    },
  }, webui.Config.parse({ port: 0, route_prefix: '/t282', ledger_contractor: contractorLedger,
    ledger_supplier: supplierLedger, ui_shared: uiShared }))
  const base = httpBox.webui.url.replace(/\/$/, '')
  const get = async (path) => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, text: await res.text() }
  }
  const INLINE_EVENT = /\son[a-z]+\s*=/i
  const countOf = (text, attr) => {
    const found = new RegExp(`data-gates-${attr}="(\\d+)"`).exec(String(text))
    return found ? Number(found[1]) : null
  }
  const reasonOfPage = (text) => (/data-gates-degraded="1"[\s\S]{0,400}?<code>([^<]*)<\/code>/.exec(text) ?? [])[1] ?? ''

  const routes = JSON.parse((await get('/api/routes')).text)
  const gateRoutes = (routes.routes ?? []).filter((item) => String(item.path).includes('/gates'))
  const contractorPage = await get('/contractor/gates/')
  const supplierPage = await get('/supplier/gates/')
  const contractorJson = await get('/contractor/api/gates')
  const supplierJson = await get('/supplier/api/gates')
  const cj = JSON.parse(contractorJson.text)
  const sj = JSON.parse(supplierJson.text)
  const navOk = contractorPage.text.includes('data-subnav="contractor"')
    && contractorPage.text.includes('data-gates-link="1"')
  check('22 真 HTTP 正控：`/t282/<view>/gates/` 与 `/<view>/api/gates` 两视角各自 200；`/api/routes` 登记了'
    + '页面/JSON/催办 POST **三条路由且 `auth=none`**；页面含道内子导航与「审批与变更」入口、'
    + '`data-age-clock="facts-only"` 与口径那句话、逐条 `data-gate-next-action`；JSON 契约齐备'
    + '（engine/age_clock/age_basis_note/ignored_now_inputs/gates/changes/counts/bounds/degraded/reason）',
  contractorPage.status === 200 && supplierPage.status === 200 && contractorJson.status === 200
  && supplierJson.status === 200 && gateRoutes.length === 6
  && gateRoutes.every((item) => item.auth === 'none')
  && gateRoutes.filter((item) => item.method === 'GET').length === 4
  && gateRoutes.filter((item) => item.method === 'POST').length === 2
  && navOk && contractorPage.text.includes('data-age-clock="facts-only"')
  && contractorPage.text.includes(mod.AGE_BASIS_NOTE)
  && contractorPage.text.includes('data-gate-next-action="ap-0007"')
  && cj.engine === 'rules' && cj.age_clock === 'facts-only'
  && cj.ignored_now_inputs.join(',') === 'payload.now,config.now'
  && Array.isArray(cj.gates) && cj.gates.length === 2 && Array.isArray(cj.changes) && cj.changes.length === 1
  && cj.degraded === false && typeof cj.omitted === 'number' && typeof cj.truncated === 'boolean',
  `status=${contractorPage.status}/${supplierPage.status}/${contractorJson.status}/${supplierJson.status}；`
  + `路由=${JSON.stringify(gateRoutes.map((item) => `${item.method} ${item.path}`))}；入口=${navOk}；`
  + `承包商门=${cj.gates?.length}（ap-0007 已决的 ap-0001 不进列表）变更=${cj.changes?.length}；`
  + `age=${JSON.stringify(cj.gates?.map((item) => item.age_seconds))}`)

  const scripty = [contractorPage, supplierPage].filter((page) => page.text.includes(scriptNeedle)
    || INLINE_EVENT.test(page.text))
  const jsonScripty = [contractorJson, supplierJson].filter((page) => page.text.includes(scriptNeedle))
  const scriptSelfTest = (`<a onclick="x()"></a>`).includes(scriptNeedle) || INLINE_EVENT.test('<a onclick="x()"></a>')
  const supplierEmpty = countOf(supplierPage.text, 'gate-count') === 0
    && countOf(supplierPage.text, 'change-count') === 0
  check('23 真 HTTP 正控 + 负控：承包商侧真数据（2 条待批门 + 1 张变更单，`degraded:false`）；'
    + '**供应商侧空投影** → 页面 `data-gates-degraded="1"` + 有名 reason + **两个列表计数都为 0**、'
    + 'JSON `gates:[]`/`changes:[]`；两视角的**页面与 JSON 都 0 行脚本 / 0 内联事件**（扫描器非空转）',
  scripty.length === 0 && jsonScripty.length === 0 && scriptSelfTest
  && sj.degraded === true && sj.reason === 'no-usable-inputs' && sj.gates.length === 0 && sj.changes.length === 0
  && supplierPage.text.includes('data-gates-degraded="1"')
  && reasonOfPage(supplierPage.text) === 'no-usable-inputs' && supplierEmpty
  && countOf(contractorPage.text, 'gate-count') === 2 && countOf(contractorPage.text, 'change-count') === 1,
  `含脚本=${scripty.length}；JSON 含脚本=${jsonScripty.length}；对照=${scriptSelfTest}；`
  + `供应商 degraded=${sj.degraded}/${sj.reason} 门=${sj.gates.length} 变更=${sj.changes.length}；`
  + `页面计数（承包商 门=${countOf(contractorPage.text, 'gate-count')} 变更=${countOf(contractorPage.text, 'change-count')}｜`
  + `供应商 门=${countOf(supplierPage.text, 'gate-count')} 变更=${countOf(supplierPage.text, 'change-count')}）`)

  const REASON_HTTP = '这批料已经到场了，等您签字才能开工'
  const posted = await fetch(`${base}/contractor/gates/nudge`, { method: 'POST',
    body: `id=ap-0007&reason=${encodeURIComponent(REASON_HTTP)}` })
  const postedText = await posted.text()
  let postedJson = {}
  try { postedJson = JSON.parse(postedText) } catch { postedJson = {} }
  const nudgeFile = join(uiShared, 'gate-nudges', `${postedJson.id}.json`)
  let nudgeMode = -1
  let nudgeRecord = {}
  try {
    nudgeMode = statSync(nudgeFile).mode & 0o777
    nudgeRecord = JSON.parse(readFileSync(nudgeFile, 'utf8'))
  } catch { nudgeMode = -1 }
  const ledgerAfterPost = sha256(readFileSync(contractorLedger, 'utf8'))
  const againPage = await get('/contractor/gates/')
  const againJson = await get('/contractor/api/gates')
  check('24 真 HTTP 催办 POST：202 + 待办件 id + `next_action`；待办件**恰 0600**、**原话逐字**、'
    + 'sha256 由门独立重算一致、`submitted_at` 为空；**账本零新增**（夹具逐字节不变）；'
    + '同一 URL 两次 GET **逐字节一致**（HTTP 层的"不随窗口变"）',
  posted.status === 202 && postedJson.ok === true && postedJson.code === 'accepted'
  && /^gn-contractor-[0-9a-f]{12}$/.test(String(postedJson.id))
  && typeof postedJson.next_action === 'string' && postedJson.next_action.includes('tools/gate-nudge.py')
  && nudgeMode === 0o600 && nudgeRecord.reason === REASON_HTTP && nudgeRecord.gate_id === 'ap-0007'
  && nudgeRecord.view === 'contractor' && nudgeRecord.requested_action === 'nudge'
  && nudgeRecord.reason_sha256 === 'sha256:' + sha256(REASON_HTTP)
  && nudgeRecord.submitted_at === '' && ledgerAfterPost === ledgerHash
  && againPage.text === contractorPage.text && againJson.text === contractorJson.text,
  `POST=${posted.status} id=${postedJson.id} code=${postedJson.code}；mode=${'0' + nudgeMode.toString(8)}；`
  + `原话逐字=${nudgeRecord.reason === REASON_HTTP}；账本未变=${ledgerAfterPost === ledgerHash}；`
  + `页面两次一致=${againPage.text === contractorPage.text}；next_action=${String(postedJson.next_action).slice(0, 60)}…`)

  const elevate = await fetch(`${base}/admin/api/elevate`, { method: 'POST', body: `token=${T282_TOKEN}` })
  const adminCookie = String(elevate.headers.get('set-cookie') ?? '').split(';')[0]
  const adminPage = await fetch(`${base}/admin/`, { headers: { cookie: adminCookie } })
  const adminText = await adminPage.text()
  const navPages = { contractor: contractorPage.text, supplier: supplierPage.text, ops: (await get('/ops/')).text,
    admin: adminText }
  const navMissing = Object.entries(navPages).filter(([, text]) => !text.includes('data-gates-link="1"'))
    .map(([name]) => name)
  const NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:', 'bidders_private',
    'internal_notes', 'authorized_band', ...SENTINELS]
  const supplierGates = supplierPage.text + supplierJson.text
  const contractorGates = contractorPage.text + contractorJson.text
  const hitsSupplier = NEEDLES.filter((needle) => supplierGates.includes(needle))
  const hitsContractor = NEEDLES.filter((needle) => contractorGates.includes(needle))
  const fixtureHas = SENTINELS.filter((needle) => readFileSync(contractorLedger, 'utf8').includes(needle))
  const homeCode = await get('/contractor/')
  const adminCode = await get('/admin/')
  check('25 真 HTTP 正控 + 负控：**四道页面**（承包商/供应商/运维/系统管理）的子导航里都有「审批与变更」入口，'
    + '第四道是提权后的真面板；两视角 gates 页/JSON 里私域键名与哨兵 **0 命中**（这类键连读都不读），'
    + '**非空转对照**：同一批哨兵确实写在夹具账本文件里；既有路由没被弄坏，且未带 cookie 的 `/admin/` 仍 401 固定体',
  navMissing.length === 0 && elevate.status === 200 && adminPage.status === 200
  && adminText.includes('审批与变更（承包商）') && hitsSupplier.length === 0 && hitsContractor.length === 0
  && fixtureHas.length >= 3 && homeCode.status === 200 && adminCode.status === 401
  && adminCode.text.trim() === '{"error":"unauthorized"}',
  `缺入口的道=${navMissing.join(',') || '无'}；提权=${elevate.status}；admin 页=${adminPage.status}；`
  + `供应商命中=${hitsSupplier.join(',') || '无'}；承包商命中=${hitsContractor.join(',') || '无'}；`
  + `夹具里确实有哨兵=${fixtureHas.join(',')}；admin 未提权=${adminCode.status}`)

  await httpFiber.dispose()

  // ---------- 26-27. 单点变异 ----------
  const realFacts = await factsFor((config) => mountWith(config))
  const realAllTrue = SCENARIOS.every((name) => realFacts[name] === true)
  check('26 变异前基线：四条场景（age 来自事实 ts / 空投影不编 / 每条都有 basis / 不得批准）在**真产物**上全真'
    + '（否则变异变红就说明不了任何事：基线本来就是红的）',
  realAllTrue, `基线=${JSON.stringify(realFacts)}`)

  const mutationReport = []
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
    const fake = mutated === null || mutated === originalSource
    if (fake) {
      mutationReport.push(`${mutation.name}→假变异（找不到唯一锚点或字节没变）`)
      check(`27 变异：${mutation.name}`, false,
        `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
      continue
    }
    const facts = await factsFor((config) => mountMutant(mutated, config))
    const red = SCENARIOS.filter((name) => facts[name] === false)
    mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
    check(`27 变异：${mutation.name}`, red.includes(mutation.mustRed),
      `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts)}；`
      + `字节已变=${mutated !== originalSource}`)
  }

  const fakeGuard = applyMutation(originalSource, '这一段源码里根本不存在-MUTATION-ANCHOR', 'x')
  const selfAnchor = mutationAnchorForSelfTest(originalSource)
  const selfMutation = applyMutation(originalSource, selfAnchor, selfAnchor)
  check('27 防假变异（自检）：找不到唯一锚点的"变异"必须被判定为**假变异**（返回 null），'
    + '把锚点替换成它自己也不算变异 —— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

  const afterHash = sha256(sourceOf(TARGET))
  const afterWebui = sha256(sourceOf(WEBUI))
  check('27 还原：本门全程**没有写过产品树** —— `host/modules/gate-timeline.mjs` 与 `host/modules/webui.mjs` '
    + '跑完之后与跑之前**逐字节一致**（变异只写在临时目录的副本里）',
  afterHash === originalHash && sourceOf(TARGET) === originalSource && afterWebui === webuiHash,
  `gate-timeline sha256 前=${originalHash.slice(0, 16)}… 后=${afterHash.slice(0, 16)}…；`
  + `webui 未变=${afterWebui === webuiHash}；变异小结=${mutationReport.join('；')}`)

  for (const mounted of [live, other, ...mountedCache.values()]) {
    try { await mounted.fiber.dispose() } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 300)}`)
}

finish()

/** 给"自我替换"那条自检用的锚点：取源码里真实存在的一段（拿真源码量，不凭印象写）。 */
function mutationAnchorForSelfTest(text) {
  const anchor = 'export const AGE_CLOCK'
  return text.includes(anchor) ? anchor : 'export const name'
}
