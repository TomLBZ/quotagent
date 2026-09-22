/**
 * t286-quote-draft-gate —— **「不要假成功」+ 报价草稿写闭环** 的**围栏门**
 * （`host/modules/quote-prepare.mjs` + 它在 `webui` 里的路由 `GET|POST /quotagent/supplier/quotes/prepare/`）。
 *
 * 为什么要有这一条：本仓铁律是**浏览器不得直接签署人工动作**（`quote.submit` 只能由人/CLI 签），
 * 但这不等于「浏览器什么都做不了」。实测过最伤信任的一条假成功：
 *   `curl -s GET /quotagent/contractor/quotes/` 与 `curl -s -X POST 同路径 -d 'item=L-001&price=80'`
 *   返回**逐字节相同**的 200 页面（两者 bytes=3935、sha256 相同）——
 *   员工填了单价点了提交，浏览器给一页正常页面，**什么都没发生**。
 * 所以正确性判据必须是：
 *   · 只应为 `GET` 的路由收到非 GET ⇒ **405 + `Allow: GET` + `method-not-allowed`**，**绝不**把 POST 当 GET；
 *   · **不需要签名的写动作必须在 APP 里真做成**：准备 → 0600 待办件（202）→ Python 侧落 `quote/drafted`；
 *   · 写动作的**签名**仍只能在终端由 `human:*` 做（本插件 `can_sign=false`，服务面没有签名/提交/发信方法）。
 * 本门的期望值全部**手算/逐字取自被围对象的契约常量**，绝不拿插件的输出当期望。
 *
 * 断言（每条写清「什么情况下必须变红」）：
 *   1  契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[quotePrepare]/Config/apply/fixture）；
 *      常量是**闭合集合**（`event=quote/drafted`、`kind`、`action`、12 个字段级错误码、3 个降级 reason、
 *      8 个表单字段名、上下界键集）；只 import `../lib` 白名单（或 node:）；源码 0 个脚本字面量 /
 *      0 个内联事件属性字面量（扫描器带非空转对照）
 *   2  挂载正控：`ctx.provide('quotePrepare')` 拿得到句柄，服务面**恰 8 个键**
 *      （`fields`/`limits`/`views`/`meta`/`privacy`/`prepare`/`validate`/`handoff`），
 *      **没有任何** `sign`/`approve`/`decide`/`submit`/`send`/`commit` 这类方法；`meta.can_sign=false`
 *   3  **草稿恒为「待签署」**：`quote/drafted` 行的状态恒为 `awaiting-signature`/`待签署`；
 *      输出里不出现 `quote/submitted`（**没签名就不叫已提交**）
 *   4  **字段级错误码与拒绝码闭合**：越界单价 ⇒ `unit-price-out-of-range`（**不夹取**）、非整数 ⇒
 *      `unit-price-not-integer`、交期越界 ⇒ `lead-time-out-of-range`、`agent:` 发言人 ⇒ `prepared-by-required`、
 *      备注超字节 ⇒ `note-too-long`、视角不允许 ⇒ `view-not-allowed`；每个错误都有非空 `next_action`
 *   5  **行项目读不出来不编**：空载荷 ⇒ `degraded=true` + 有名 reason + 目录为空（不抛错）
 *   6  **行项目存在性校验**：目录里有 `L-001`，提交 `L-999` ⇒ `item-not-found`（**不猜、不默认**）
 *   7  **确定性**：同一载荷两次**逐字节一致**；键序打乱一致；跨实例一致；冻结输入不抛错；
 *      `payload.now` / `config.now` 两个墙钟入口**读都不读**（给任何值输出都不变）
 *   8  **私域哨兵零泄漏**：事实行里塞进私域键与哨兵 ⇒ 输出**逐字节一致**且哨兵 0 命中（非空转对照）
 *   9  **有界**：草稿数夹取到 `max_drafts` 且如实报；`handoff` 的命令里含 `tools/quote-sign.py`、
 *      `human:`、`ap-NNNN` 三个真实参数（**可复制**）
 *   10 **零写面 / 不读账本 / 不取墙钟**：静态扫描（fs / 写文件 / 账本 / `Date.now` / 随机 / 网络 /
 *      子进程 / 定时器）+ 扫描器非空转对照；`privacy` 五项如实申报
 *   11 **宿主侧契约（静态）**：`webui` 里 `GET|POST /<prepare-view>/quotes/prepare/` 两条路由、
 *      405 围栏（`method-not-allowed` + `allow` 头）、`data-signature-required="1"`、
 *      以及**本批新增的页面模板段**里 0 内联脚本 / 0 内联事件（切片非空转）
 *   12 单点变异：4 处变异各自必须让**指定的**场景变红（且变异必须真的改了字节）
 *   13 防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `quote-prepare.mjs` 与 `webui.mjs`
 *      字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t286-quote-draft-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, 'modules', 'quote-prepare.mjs')
const WEBUI = join(HERE, 'modules', 'webui.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../lib/std-schema.mjs') return { url: SCHEMA_URL, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const sourceOf = (path) => readFileSync(path, 'utf8')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const originalSource = sourceOf(TARGET)
const originalHash = sha256(originalSource)
const webuiSource = sourceOf(WEBUI)
const webuiHash = sha256(webuiSource)
const scriptNeedle = '<scr' + 'ipt'
const inlineEvent = /\son[a-z]+\s*=/i

/** 只应为 GET 的路由被 POST 时必须出现的拒绝码（宿主围栏的抓手）。 */
const METHOD_CODE = 'method-not-allowed'
/** 私域哨兵：塞进事实行后，输出必须逐字节不变且 0 命中。 */
const PRIVATE_NEEDLES = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model', 'private:']
const SENTINELS = ['QUOTE-SENTINEL-1a2b', 'COST-FLOOR-SENTINEL-9c', 'PRIVATE-NOTE-SENTINEL-7f', '987654321']

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
  const dir = mkdtempSync(join(tmpdir(), 't286-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `quote-prepare.mut-${tag}.mjs`)
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
// 夹具（**手写的事实载荷**：行项目 L-001/L-002、参考单价 86.00/11.50 元 ⇒ 8600/1150 分）
// ===========================================================================
const AS_OF = '2026-09-21T12:00:00Z'
const HAND_ITEMS = ['L-001', 'L-002']
const HAND_RFQS = ['pkg-g1']
const HAND_PRICE_CENTS = { 'L-001': 8600, 'L-002': 1150 }

const factsFor = ({ withDraft = false, withSentinel = false, drafts = 0 } = {}) => {
  const rows = [
    { type: 'rfq/published', ts: '2026-09-21T10:00:00Z', package_id: 'pkg-g1', rev: 2,
      items: [{ item_id: 'L-001' }, { item_id: 'L-002' }] },
    { type: 'quote/submitted', ts: '2026-09-21T11:00:00Z', package_id: 'pkg-g1',
      lines: [{ item_id: 'L-001', unit_price: 86.0 }, { item_id: 'L-002', unit_price: 11.5 }] },
  ]
  if (withSentinel) {
    rows.push({ type: 'quote/submitted', ts: '2026-09-21T11:30:00Z', package_id: 'pkg-g1',
      item_id: 'L-001', unit_price: 86.0, cost_floor: SENTINELS[1], markup_pct: 12.5,
      reserve_price: SENTINELS[0], cost_model: SENTINELS[1], 'private:note': SENTINELS[2],
      supplier: SENTINELS[3] })
  }
  const draftRows = []
  const count = withDraft ? Math.max(1, drafts) : drafts
  for (let index = 0; index < count; index += 1) {
    draftRows.push({ type: 'quote/drafted', ts: '2026-09-21T12:00:00Z',
      quote_draft_id: `qd-supplier-${String(index).padStart(12, '0')}`, rfq_id: 'pkg-g1',
      item_id: index % 2 === 0 ? 'L-001' : 'L-002', unit_price_cents: index % 2 === 0 ? 8600 : 1150,
      lead_time_days: 7 + index, currency: 'CNY', prepared_by: 'human:zhang', ok: true,
      supplier: 'supplier:g1', note_sha256: 'a'.repeat(64) })
  }
  return { view: 'supplier', as_of: AS_OF, facts: [...rows, ...draftRows] }
}

const formOf = (fields) => ({ get: (key) => fields[key] })

const validForm = (over = {}) => ({ rfq_id: 'pkg-g1', item_id: 'L-001', unit_price_cents: '8600',
  lead_time_days: '7', prepared_by: 'human:zhang', currency: 'CNY', note: '交期可谈；含运费', ...over })

const codesOf = (out) => (out.errors || []).map((item) => item.code)
const fieldOf = (out, name) => (out.errors || []).find((item) => item.field === name) || {}

/** 4 处单点变异（各自只改一处；`mustRed` 是"必须变红"的那条场景）。 */
const SCENARIOS = ['草稿恒为待签署', '字段级错误码与拒绝码闭合', '行项目读不出来不编', '行项目存在性校验']
const MUTATIONS = [
  { name: '变异1：草稿状态直接写成 `submitted`（**没签名却自称已提交**）',
    find: "      status: 'awaiting-signature',",
    replace: "      status: 'submitted',",
    mustRed: '草稿恒为待签署' },
  { name: '变异2：单价的**越界守卫**失效（越界不拒、直接落一条你以为没过界的价格）',
    find: '    if (!(unitPrice >= limits.unit_price_cents_min && unitPrice <= limits.unit_price_cents_max)) {',
    replace: '    if (false) {',
    mustRed: '字段级错误码与拒绝码闭合' },
  { name: '变异3：**行项目目录读不出来也不说**（空载荷反而被当成健康）',
    find: '  if (hasCatalogue) {',
    replace: '  if (true) {',
    mustRed: '行项目读不出来不编' },
  { name: '变异4：**行项目存在性校验**失效（目录里没有的 item_id 也放行）',
    find: '  } else if (catalogue.items.length > 0 && !catalogue.items.some((row) => row.item_id === itemId)) {',
    replace: '  } else if (false) {',
    mustRed: '行项目存在性校验' },
]

/** 四条"必须红"的场景各自的判据（基线必须全真，否则变异变红说明不了任何事）。 */
const factsForScenario = async (mountFn) => {
  const base = await mountFn({})
  const handle = base.box.handle
  const payload = factsFor({ withSentinel: true, withDraft: true })
  const prepared = handle.prepare(payload)
  // 场景 1：草稿恒为待签署（输出里不出现 quote/submitted）
  const draftText = JSON.stringify(prepared.drafts)
  const sc1 = prepared.drafts.length > 0
    && prepared.drafts.every((row) => row.status === 'awaiting-signature' && row.status_text === '待签署')
    && !draftText.includes('quote/submitted')
  // 场景 2：单价越界必须给 unit-price-out-of-range（且拒绝码闭合）
  const over = handle.validate({ view: 'supplier', form: formOf(validForm({ unit_price_cents: '99999999999' })),
    payload })
  const sc2 = over.ok === false && fieldOf(over, 'unit_price_cents').code === 'unit-price-out-of-range'
  // 场景 3：空载荷必须降级且 reason 有名
  const empty = handle.prepare({ view: 'supplier', as_of: AS_OF, facts: [] })
  const sc3 = empty.degraded === true && empty.reason === 'no-item-catalogue' && empty.catalogue.items.length === 0
  // 场景 4：目录里没有的 item_id 必须被拒（item-not-found）
  const miss = handle.validate({ view: 'supplier', form: formOf(validForm({ item_id: 'L-999' })), payload })
  const sc4 = miss.ok === false && fieldOf(miss, 'item_id').code === 'item-not-found'
  const scenarios = { '草稿恒为待签署': sc1, '字段级错误码与拒绝码闭合': sc2,
    '行项目读不出来不编': sc3, '行项目存在性校验': sc4 }
  return { scenarios, red: SCENARIOS.filter((name) => scenarios[name] !== true) }
}

// ===========================================================================
// 1 契约正控
// ===========================================================================
const IMPORT_RE = /^\s*import\s[^\n]*from\s+'([^']+)'/gm
const imports = [...originalSource.matchAll(IMPORT_RE)].map((match) => match[1])
const badImports = imports.filter((spec) => !spec.startsWith('../lib/') && !spec.startsWith('node:'))
const fieldsNames = mod.FIELDS.map((field) => field.name)
const HAND_FIELDS = ['rfq_id', 'item_id', 'unit_price_cents', 'lead_time_days', 'prepared_by', 'currency', 'note']
const HAND_ERRORS = ['view-not-allowed', 'rfq-id-malformed', 'rfq-not-found', 'item-id-malformed',
  'item-not-found', 'unit-price-not-integer', 'unit-price-out-of-range', 'lead-time-not-integer',
  'lead-time-out-of-range', 'prepared-by-required', 'currency-malformed', 'note-too-long']
const HAND_LIMITS = ['unit_price_cents_min', 'unit_price_cents_max', 'lead_time_days_min', 'lead_time_days_max',
  'note_bytes_max', 'money_unit']
const manifestOk = typeof mod.name === 'string' && mod.name === 'quote-prepare'
  && Array.isArray(mod.inject) && mod.inject.length === 0
  && Array.isArray(mod.builtin) && mod.builtin.length === 0
  && Array.isArray(mod.usedServices) && mod.usedServices.length === 0
  && Array.isArray(mod.provides) && mod.provides.join(',') === 'quotePrepare'
  && typeof mod.Config === 'object' && typeof mod.apply === 'function'
  && typeof mod.fixture === 'object' && typeof mod.fixture.sample === 'function'
const constOk = mod.ENGINE === 'rules' && mod.EVENT === 'quote/drafted' && mod.KIND === 'quote-draft'
  && mod.ACTION === 'draft' && mod.SCHEMA === 1 && mod.MONEY_UNIT === 'cents'
  && mod.DEFAULT_CURRENCY === 'CNY' && mod.PENDING_PREFIX === 'qd-'
  && JSON.stringify(mod.ERROR_CODES) === JSON.stringify(HAND_ERRORS)
  && JSON.stringify(fieldsNames) === JSON.stringify(HAND_FIELDS)
  && HAND_LIMITS.slice(0, 5).every((key) => typeof mod.LIMITS[key] === 'number')
  && HAND_LIMITS[5] === 'money_unit' && mod.MONEY_UNIT === 'cents'
  && (mod.DEGRADED_REASONS || []).length === 3
check('1 契约正控：manifest 齐备（name/inject/builtin/usedServices/provides=[quotePrepare]/Config/apply/fixture）；'
  + '常量是**闭合集合**（`quote/drafted` / `quote-draft` / `draft` / 12 个字段级错误码 / 7 个表单字段名 / 上下界键集）；'
  + '只 import `../lib` 白名单（或 `node:`）；源码 0 个脚本字面量 / 0 个内联事件属性字面量（扫描器非空转）',
  manifestOk && constOk && badImports.length === 0
  && !originalSource.includes(scriptNeedle) && !inlineEvent.test(originalSource)
  && `<a ${scriptNeedle}>`.includes(scriptNeedle) && scriptNeedle === '<script'
  && inlineEvent.test('<a onclick="x()">'),
  `manifest=${manifestOk} 常量=${constOk}；越界 import=${JSON.stringify(badImports)}；`
  + `错误码=${JSON.stringify(mod.ERROR_CODES)}；字段=${JSON.stringify(fieldsNames)}`)

// ===========================================================================
// 2 挂载正控
// ===========================================================================
const HAND_KEYS = ['fields', 'handoff', 'limits', 'meta', 'prepare', 'privacy', 'validate', 'views']
const FORBIDDEN = ['sign', 'approve', 'decide', 'submit', 'send', 'commit']
const base = await mountWith({})
const handle = base.box.handle
const serviceKeys = handle ? Object.keys(handle).sort() : []
const forbidden = serviceKeys.filter((key) => FORBIDDEN.some((word) => key.toLowerCase().includes(word)))
const meta = handle.meta()
check('2 挂载正控：`ctx.provide(\'quotePrepare\')` 拿得到句柄，服务面**恰 8 个键**；'
  + '**没有任何** `sign`/`approve`/`decide`/`submit`/`send`/`commit` 这类方法；`meta.can_sign=false`、'
  + '`signature_required=true`、`can_submit=false`、`sends=0`',
  Boolean(handle) && JSON.stringify(serviceKeys) === JSON.stringify(HAND_KEYS)
  && forbidden.length === 0 && meta.can_sign === false && meta.signature_required === true
  && meta.can_submit === false && meta.sends === 0 && meta.event === 'quote/drafted',
  `键=${JSON.stringify(serviceKeys)}；禁止词命中=${JSON.stringify(forbidden)}；can_sign=${meta.can_sign}`)

// ===========================================================================
// 3 草稿恒为「待签署」
// ===========================================================================
const prepared = handle.prepare(factsFor({ withDraft: true, drafts: 3 }))
const dbgText = JSON.stringify(prepared.drafts)
check('3 **草稿恒为「待签署」**：`quote/drafted` 行的状态恒为 `awaiting-signature` / `待签署`；'
  + '输出里不出现 `quote/submitted`（**没签名就不叫已提交**——「草稿」与「报价」是两件事）',
  prepared.drafts.length === 3
  && prepared.drafts.every((row) => row.status === 'awaiting-signature' && row.status_text === '待签署')
  && !dbgText.includes('quote/submitted') && HAND_ITEMS.includes(prepared.drafts[0].item_id)
  && prepared.counts.drafts === 3,
  `草稿 ${prepared.drafts.length} 条：${JSON.stringify(prepared.drafts.map((row) => [row.item_id, row.unit_price_cents, row.status]))}`)

// ===========================================================================
// 4 字段级错误码与拒绝码闭合
// ===========================================================================
const payload = factsFor({ withSentinel: true })
const cases = [
  ['unit_price_cents', '99999999999', 'unit-price-out-of-range'],
  ['unit_price_cents', '86.00', 'unit-price-not-integer'],
  ['lead_time_days', '99999', 'lead-time-out-of-range'],
  ['lead_time_days', '7.5', 'lead-time-not-integer'],
  ['prepared_by', 'agent:bot', 'prepared-by-required'],
  ['currency', 'cny', 'currency-malformed'],
  ['note', 'x'.repeat(2001), 'note-too-long'],
]
const wrong = []
const detailRows = []
for (const [field, value, code] of cases) {
  const out = handle.validate({ view: 'supplier', form: formOf(validForm({ [field]: value })), payload })
  const hit = fieldOf(out, field)
  detailRows.push(`${field}=${String(value).slice(0, 12)}→${hit.code || '(无)'}`)
  if (out.ok !== false || hit.code !== code || !String(hit.next_action || '').trim()) {
    wrong.push(`${field}:${hit.code}/${hit.next_action}`)
  }
}
const viewOut = handle.validate({ view: 'contractor', form: formOf(validForm()), payload })
const allCodesInSet = cases.every(([, , code]) => mod.ERROR_CODES.includes(code))
check('4 **字段级错误码与拒绝码闭合**：越界单价 ⇒ `unit-price-out-of-range`（**不夹取**）、非整数 ⇒ '
  + '`unit-price-not-integer`、交期越界/非整数 ⇒ `lead-time-*`、`agent:` 发言人 ⇒ `prepared-by-required`、'
  + '币种 ⇒ `currency-malformed`、备注超字节 ⇒ `note-too-long`、视角不允许 ⇒ `view-not-allowed`；'
  + '每个错误都有**非空 `next_action`** 且 code 全部落在 `ERROR_CODES` 里（闭合集合）',
  wrong.length === 0 && allCodesInSet
  && fieldOf(viewOut, 'view').code === 'view-not-allowed' && viewOut.ok === false
  && (viewOut.errors || []).every((item) => item.next_action && item.message),
  `不达标记=${JSON.stringify(wrong)}；逐条=${detailRows.join(' / ')}；view=${fieldOf(viewOut, 'view').code}`)

// ===========================================================================
// 5 行项目读不出来不编
// ===========================================================================
const emptyRun = handle.prepare({ view: 'supplier', as_of: AS_OF, facts: [] })
const notObject = handle.prepare('nope')
check('5 **行项目读不出来不编**：空载荷 ⇒ `degraded=true` + 有名 reason（`no-item-catalogue`）+ 目录为空，'
  + '**不抛错、也不编行项目**；非对象载荷 ⇒ `payload-not-an-object`（同一条纪律，不炸服务）',
  emptyRun.degraded === true && emptyRun.reason === 'no-item-catalogue'
  && emptyRun.catalogue.items.length === 0 && emptyRun.catalogue.rfq_ids.length === 0
  && emptyRun.drafts.length === 0
  && notObject.degraded === true && notObject.reason === 'payload-not-an-object'
  && mod.DEGRADED_REASONS.includes(emptyRun.reason) && mod.DEGRADED_REASONS.includes(notObject.reason),
  `空=${emptyRun.degraded}/${emptyRun.reason}/items=${emptyRun.catalogue.items.length}；`
  + `非对象=${notObject.degraded}/${notObject.reason}`)

// ===========================================================================
// 6 行项目存在性校验（目录来自**本视角事实**）
// ===========================================================================
const catalogue = handle.prepare(payload).catalogue
const dbg = handle.validate({ view: 'supplier', form: formOf(validForm({ item_id: 'L-999' })), payload })
const good = handle.validate({ view: 'supplier', form: formOf(validForm()), payload })
const rfqMiss = handle.validate({ view: 'supplier', form: formOf(validForm({ rfq_id: 'pkg-zzz' })), payload })
check('6 **行项目存在性校验**：目录里的行项目与**手算**一致（`L-001`/`L-002`，参考单价 `8600`/`1150` 分，'
  + '由 `lines[].unit_price` 元 → 整数分）；目录里有 `L-001`，提交 `L-999` ⇒ `item-not-found`；'
  + 'RFQ 引用不在事实里 ⇒ `rfq-not-found`；合法的**通过**并给出草稿载荷（非空转对照）',
  JSON.stringify(catalogue.items.map((row) => row.item_id)) === JSON.stringify(HAND_ITEMS)
  && JSON.stringify(catalogue.rfq_ids) === JSON.stringify(HAND_RFQS)
  && catalogue.items.find((row) => row.item_id === 'L-001').unit_price_cents === HAND_PRICE_CENTS['L-001']
  && catalogue.items.find((row) => row.item_id === 'L-002').unit_price_cents === HAND_PRICE_CENTS['L-002']
  && fieldOf(dbg, 'item_id').code === 'item-not-found' && dbg.ok === false
  && fieldOf(rfqMiss, 'rfq_id').code === 'rfq-not-found'
  && good.ok === true && good.record.unit_price_cents === 8600 && good.record.note_sha256 === ''
  && good.record.submitted_at === '' && good.record.kind === 'quote-draft',
  `目录=${JSON.stringify(catalogue.items.map((row) => [row.item_id, row.unit_price_cents]))}；`
  + `未知行项目=${fieldOf(dbg, 'item_id').code}；未知 RFQ=${fieldOf(rfqMiss, 'rfq_id').code}；`
  + `合法=${good.ok}/${good.record && good.record.unit_price_cents}`)

// ===========================================================================
// 7 确定性（含两个墙钟入口读都不读）
// ===========================================================================
const runOnce = (extra = {}) => JSON.stringify(handle.prepare({ ...factsFor({ withSentinel: true }), ...extra }))
const once = runOnce()
const twice = runOnce()
const shuffledKeys = JSON.stringify((() => {
  const source = factsFor({ withSentinel: true })
  return handle.prepare({ as_of: source.as_of, facts: source.facts, view: source.view })   // 键序不同、内容相同
})())
const nowOne = runOnce({ now: '2026-01-01T00:00:00Z' })
const nowTwo = runOnce({ now: '2031-12-31T23:59:59Z' })
const other = await mountWith({})
const cross = JSON.stringify(other.box.handle.prepare(factsFor({ withSentinel: true })))
const frozenOk = (() => {
  const frozen = deepFreeze(factsFor({ withSentinel: true }))
  try { return JSON.stringify(handle.prepare(frozen)) === once } catch { return false }
})()
check('7 **确定性**：同一载荷两次**逐字节一致**；键序打乱一致；跨实例一致；冻结输入不抛错；'
  + '载荷里的 `now` **读都不读**（给两个相隔五年的值，输出逐字节不变）；`Config` 里**没有** `now` 键；'
  + '输出里没有 `checked_at` 这类时间键',
  once === twice && once === shuffledKeys && once === cross && frozenOk
  && once === nowOne && once === nowTwo && !/"checked_at"|"generated_at"|"elapsed"/.test(once)
  && !('now' in (mod.Config.dict || {})) && !/\bnow\b/i.test(once),
  `两次一致=${once === twice} 键序=${once === shuffledKeys} 跨实例=${once === cross} `
  + `冻结=${frozenOk}；载荷 now：${once === nowOne}/${once === nowTwo}；`
  + `Config 含 now=${'now' in (mod.Config.dict || {})}`)

// ===========================================================================
// 8 私域哨兵零泄漏
// ===========================================================================
const clean = JSON.stringify(handle.prepare(factsFor({ withDraft: true, drafts: 2 })))
const dirtyPayload = factsFor({ withDraft: true, drafts: 2, withSentinel: true })
const dirty = JSON.stringify(handle.prepare(dirtyPayload))
const hits = [...PRIVATE_NEEDLES, ...SENTINELS].filter((needle) => dirty.includes(needle))
check('8 **私域哨兵零泄漏**：同一键集、不同私域值 ⇒ 输出**逐字节一致**；私域键名与哨兵 0 命中；'
  + '**非空转对照**：哨兵确实在输入里（`JSON.stringify(payload)` 含哨兵）',
  clean === dirty && hits.length === 0
  && SENTINELS.every((needle) => JSON.stringify(dirtyPayload).includes(needle))
  && PRIVATE_NEEDLES.every((needle) => JSON.stringify(dirtyPayload).includes(needle)),
  `逐字节一致=${clean === dirty}；命中=${JSON.stringify(hits)}；`
  + `哨兵在输入里=${SENTINELS.filter((needle) => JSON.stringify(dirtyPayload).includes(needle))}`)

// ===========================================================================
// 9 有界 + 签署入口可复制
// ===========================================================================
const many = handle.prepare(factsFor({ drafts: 40 }))
const draft = { rfq_id: 'pkg-g1', item_id: 'L-001', unit_price_cents: 8600, quote_draft_id: 'qd-supplier-0123456789ab' }
const hand = handle.handoff({ view: 'supplier', draft })
const command = String((hand.commands || [])[0] || '')
check('9 **有界**：草稿数夹取到 `max_drafts`（40 ⇒ 32）且如实报条数；`handoff` 的命令里含 '
  + '`tools/quote-sign.py` / `human:` / `--now` / 草稿 id 四个**真实参数**（可直接复制，且**不含**'
  + '本工具不认识的参数），并明说 `can_sign=false`、`data-signature-required=1`',
  many.drafts.length === 32 && hand.can_sign === false && hand.required === true
  && hand.data_signature_required === '1' && command.includes('tools/quote-sign.py')
  && command.includes('human:') && command.includes('--now') && !command.includes('--approval-ref')
  && command.includes(draft.quote_draft_id) && String(hand.why).includes('不代签')
  && hand.rfq_id === 'pkg-g1' && hand.item_id === 'L-001' && hand.unit_price_cents === 8600,
  `草稿夹取=${many.drafts.length}；命令=${command.replace(/\n/g, ' ⏎ ')}`)

// ===========================================================================
// 10 零写面 / 不读账本 / 不取墙钟（静态）
// ===========================================================================
const WRITE_PATTERNS = [/from\s+'node:fs'/, /require\('fs'\)/, /writeFile/, /appendFile/, /mkdir/, /renameSync/,
  /child_process/, /spawn\(/, /exec\(/, /node:net/, /fetch\(/, /XMLHttpRequest/, /node:http/,
  /Date\.now/, /new Date/, /Math\.random/, /setTimeout/, /setInterval/, /process\.hrtime/,
  /Ledger\b/, /ledger\.jsonl/, /readFileSync/, /process\.env/, /\.append\(/]
const staticHits = WRITE_PATTERNS.filter((pattern) => pattern.test(originalSource)).map((pattern) => String(pattern))
const privacy = handle.privacy()
check('10 **零写面 / 不读账本 / 不取墙钟**：静态扫描（fs / 写文件 / 账本 / `Date.now` / 随机 / 网络 / '
  + '子进程 / 定时器 / `process.env`）0 命中，**扫描器非空转对照**（把同样模式套到注入的探针串上能命中）；'
  + '`privacy` 五项如实申报（`writes=0` / `sends=0` / `reads_clock=false` / `reads_ledger=false` / `calls_model=false`）',
  staticHits.length === 0 && privacy.writes === 0 && privacy.sends === 0
  && privacy.reads_clock === false && privacy.reads_ledger === false && privacy.calls_model === false
  && privacy.signs === false && privacy.approves === false && privacy.note_body_written === false
  && WRITE_PATTERNS.filter((pattern) => pattern.test("const T = ['node:fs', 'Date.now()', 'ledger.jsonl', 'new Ledger('")).length >= 3,
  `静态命中=${JSON.stringify(staticHits)}；privacy=${JSON.stringify(privacy)}`)

// ===========================================================================
// 11 宿主侧契约（静态）
// ===========================================================================
const hostNeedles = ['/^\\/([a-z]+)\\/quotes\\/prepare\\/?$/', METHOD_CODE, 'allow: \'GET\'',
  'data-signature-required=', 'quote-drafts', 'tools/quote-draft.py',
  'GET_ONLY_PATTERNS', 'WRITE_PATTERNS']
const hostMissing = hostNeedles.filter((needle) => !webuiSource.includes(needle))
// 签署命令由**插件**产出（不在宿主里硬编码路径）：两个工具名必须在插件源码里
const toolMissing = ['tools/quote-draft.py', 'tools/quote-sign.py']
  .filter((needle) => !originalSource.includes(needle))
const prepSliceStart = webuiSource.indexOf('报价草稿（`quote-prepare` domain 插件')
const prepSliceEnd = webuiSource.indexOf('const PREP_FACT_KEYS')
const prepSlice = prepSliceStart >= 0 && prepSliceEnd > prepSliceStart
  ? webuiSource.slice(prepSliceStart, prepSliceEnd) : ''
const pageSliceStart = webuiSource.indexOf('const prepPageHtml =')
const pageSliceEnd = webuiSource.indexOf('const submitDraft =')
const pageSlice = pageSliceStart >= 0 && pageSliceEnd > pageSliceStart
  ? webuiSource.slice(pageSliceStart, pageSliceEnd) : ''
check('11 **宿主侧契约（静态）**：`webui` 里两条 `GET|POST /<prepare-view>/quotes/prepare/` 路由、'
  + '405 围栏（`method-not-allowed` + `Allow: GET`）、`data-signature-required` 页面标记、'
  + '两个 Python 侧工具名都在；**本批新增的页面模板段**里 **0 行脚本 / 0 内联事件**'
  + '（切片非空转：段长度 > 500 且扫描器对探针能命中）',
  hostMissing.length === 0 && toolMissing.length === 0
  && prepSlice.length > 500 && pageSlice.length > 500
  && !pageSlice.includes(scriptNeedle) && !inlineEvent.test(pageSlice)
  && !prepSlice.includes(scriptNeedle) && !inlineEvent.test(prepSlice)
  && pageSlice.includes('method="post"') && pageSlice.includes('</form>'),
  `缺抓手=${JSON.stringify(hostMissing)}；插件里缺工具名=${JSON.stringify(toolMissing)}；页切片长度=${pageSlice.length}；`
  + `页里含脚本=${pageSlice.includes(scriptNeedle)} 含内联事件=${inlineEvent.test(pageSlice)} `
  + `含 post 表单=${pageSlice.includes('method="post"')} 含 </form>=${pageSlice.includes('</form>')}；`
  + `准备段长度=${prepSlice.length} 含脚本=${prepSlice.includes(scriptNeedle)} 含内联事件=${inlineEvent.test(prepSlice)}`)

// ===========================================================================
// 12 单点变异
// ===========================================================================
const baseline = await factsForScenario(mountWith)
check('12 基线（变异前必须为真）：4 条"必须红"的场景在原始源码上全真 —— 否则变异变红说明不了任何事',
  SCENARIOS.every((name) => baseline.scenarios[name] === true),
  `场景=${JSON.stringify(baseline.scenarios)}`)

const mutationReport = []
for (const mutation of MUTATIONS) {
  const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
  if (mutated === null || mutated === originalSource) {
    check(`12 变异：${mutation.name}`, false,
      `假变异：锚点唯一性=${mutated !== null} 字节已变=${mutated !== originalSource}`)
    mutationReport.push(`${mutation.name}→假变异`)
    continue
  }
  const facts = await factsForScenario((raw) => mountMutant(mutated, raw))
  const red = facts.red
  mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
  check(`12 变异：${mutation.name}`, red.includes(mutation.mustRed),
    `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；四条场景=${JSON.stringify(facts.scenarios)}；`
    + `字节已变=${mutated !== originalSource}`)
}

// ===========================================================================
// 13 防假变异自检 + 还原
// ===========================================================================
const falseFind = applyMutation(originalSource, '这段源码里根本不存在这一行', 'x')
const selfReplace = applyMutation(originalSource, mutationFind(), mutationFind())
function mutationFind() { return MUTATIONS[0].find }
const afterSource = sourceOf(TARGET)
const afterWebui = sourceOf(WEBUI)
check('13 防假变异自检 + 还原：找不到唯一锚点 / 自我替换一律判**假变异**（返回 null）；'
  + '全程 `quote-prepare.mjs` 与 `webui.mjs` **字节不变**（变异只写在临时目录的副本里，不污染仓库）',
  falseFind === null && selfReplace === null
  && sha256(afterSource) === originalHash && sha256(afterWebui) === webuiHash
  && afterSource === originalSource,
  `假锚点=${falseFind} 自我替换=${selfReplace}；`
  + `quote-prepare 未变=${sha256(afterSource) === originalHash} webui 未变=${sha256(afterWebui) === webuiHash}；`
  + `变异小结=${mutationReport.join('；')}`)

finish()
