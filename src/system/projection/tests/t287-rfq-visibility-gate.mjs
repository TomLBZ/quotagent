/**
 * t287-rfq-visibility-gate —— **「供应商看不到自己的 RFQ 包」这个根因的围栏门**
 * （`host/modules/projection.mjs` 的投递事实可见性 + 它在 `webui` 里的装配）。
 *
 * 为什么要有这一条：实测过的事实是 —— `rfq/*` 只落在**发送方（承包商）realm** 的账本里
 * （`rfq/published` 1 条、`rfq/distributed` 2 条），而供应商视角只读**自己那本账本**，里面 `rfq/*`
 * **一条都没有**（count=6，类型只有 quote/* 与 clarification/*）⇒ 供应商看不到要报的包、看不到 @rev、
 * 看不到报价截止 ⇒ 整条链的起点断了。修法**不是**去跨读对方账本（那会破掉结构性隔离），而是读
 * **投递信封**（发送方放到共享交换目录里的交付件）+ **收件人作用域** + **字段级白名单**。
 *
 * 所以本门的正确性判据是：
 *   · **谁看到了什么**必须能与夹具**逐字对上**（正控：被邀的看到；负控：没被邀的看不到）；
 *   · **不得泄漏**：他家供应商代号 / 承包商私域键在**对外视图**里 0 命中，且"带哨兵与不带哨兵
 *     输出逐字节一致"（不是"藏起来"，是**根本没进输出**）；
 *   · rev / 截止与**事实逐字一致**，且**不取墙钟**（同一份书信封在任何时刻给同一结果）。
 *
 * 断言（≥ 20 条，每条写清"什么情况下必须变红"）：
 *   1  契约正控：模块导出（`DELIVERY_VIEWS`/`RFQ_KEYS`/`RFQ_ITEM_KEYS`/`DELIVERY_NEVER_READ`/
 *      `DELIVERY_REASONS`/`DELIVERY_SUPPRESSED`）齐备且**恰 9 键**口径；服务面暴露
 *      `deliveries`/`deliveryViews`（宿主照抄同一真源，不另抄一份）
 *   2  **被邀供应商看得到包**（正控，逐字）：`pkg-alpha@rev2`、`quote_by`/`clarify_by`/`delivered_at`、
 *      行项目与数量（`L-001×150m`、`L-002×480kg`）全部等于夹具里写的**事实值**
 *   3  **未被邀的供应商看不到**（负控）：同一批信封、身份换成另一家 ⇒ `packages` 空 +
 *      `degraded:true` + `reason:'no-deliveries-visible'` + `counts.visible === 0`
 *   4  **两家同一次调用对比**（同一份输入、两个身份）：一家有、一家没有（这不是两次不同的运行）
 *   5  **他家供应商代号 0 命中**：对外视图（publicRows 序列化）里搜不到另一家的代号与他家的包 id
 *   6  **承包商私域键 0 命中**：`cost_floor`/`reserve_price`/`internal_notes`/… 在对外视图里 0 命中；
 *      **非空转对照**：这些键与哨兵值**确实在信封里**（不然"0 命中"什么也证明不了）
 *   7  **带哨兵与不带哨兵输出逐字节一致**（三种输入顺序/组合）—— 泄漏防线的机检形态
 *   8  **发放对象只出自己**：`recipient` 恰为本视角身份；任何其他参与方代号 0 命中；`delivered_to`
 *      这份**列表**一个字都不出现
 *   9  **rev / 截止逐字一致且不取墙钟**：与事实相等；源码里 0 个墙钟/随机入口（含扫描器非空转对照）
 *   10 确定性：同输入两次 / 跨实例 / 信封顺序无关 三种口径都逐字节一致
 *   11 同一包多版本 ⇒ 只出**最新一版**（rev 大者优先，同 rev 取 `delivered_at` 靠后者）
 *   12 有界 + `omitted`：`maxPackages`/`maxItems` 夹取并**如实报**计数
 *   13 降级**可分辨**：七个有名 reason（闭合集合）逐个构造并断言；降级时 `packages` 必为空
 *   14 派生行形状：`type` 复用 `rfq/published`、`rfq` 恰 9 键、`seq === null`（不是账本行）、
 *      `summary` 里含 rev 与截止；**账本行部分逐字节不变**（既不减少也不多出）
 *   15 **承包商侧不得减少**：承包商视角带不带投递信封输出逐字节一致（且报告 `view-not-a-delivery-consumer`）
 *   16 零写面：静态扫描（文件/账本/子进程/网络/墙钟/随机/定时器）0 命中 + 扫描器非空转对照
 *   17 webui 装配静态契约：`rfq_delivery` 配置项 + 投递信封只读装配 + 页面块 **0 行 `<script>` /
 *      0 内联事件**（扫描器非空转对照）
 *   18 **单点变异**：4 处变异各自必须让**指定的**场景变红（含「把包发给所有供应商」这种越权变异）
 *   19 防假变异自检 + 还原：找不到唯一锚点/自我替换必须判假变异；全程 `projection.mjs` 与 `webui.mjs`
 *      字节不变（变异只写在临时目录的副本里）
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t287-rfq-visibility-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
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
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/projection.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const TARGET = join(HERE, '..', 'src', 'system', 'projection', 'code', 'projection.mjs')
// 实体已随批 `EV-178` 搬进插件 `code/`（旧路径 `host/modules/webui.mjs` 只剩**薄重导**）：
// 本门读/变异的是**实体那一份**（否则会静默判绿：变异打在转发文件上不改变行为）。
const WEBUI = join(HERE, '..', 'src', 'system', 'webui', 'code', 'webui.mjs')
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

const clone = (value) => JSON.parse(JSON.stringify(value))

// ===========================================================================
// 夹具（**手工写死的事实值**：断言全部与这里逐字对照，绝不拿产物自己当期望）
//   身份：被邀的 `supplier:alpha`（本视角）；**没被邀的** `supplier:beta-SENTINEL-9f3`（另一家）
//   信封 A：pkg-alpha，rev=2，delivered_to=[alpha]，报价截止 2026-09-25T00:00:00Z，
//           行项目 L-001（P-100，150 m）、L-002（S-200，480 kg），sent_at=2026-09-23T09:00:00Z
//           并**刻意混进**承包商私域键（cost_floor / reserve_price / internal_notes / other_quotes）
//   信封 B：pkg-beta，rev=7，delivered_to=[beta 那家]（**只给别家**：本视角必须看不到）
//   信封 C（同一封同时发给两家）：pkg-shared，rev=1
// ===========================================================================
const ME = 'supplier:alpha'
const OTHER = 'supplier:beta-SENTINEL-9f3'
const UNINVITED = 'supplier:gamma'
const SENTINEL_COST = 'SENTINEL-COST-FLOOR-3a1'
const SENTINEL_NOTE = 'SENTINEL-INTERNAL-NOTE-7f2'
const SENTINEL_RESERVE = 'SENTINEL-RESERVE-PRICE-5c8'
const PRIVATE_KEYS = ['cost_floor', 'reserve_price', 'cost_model', 'markup_pct', 'internal_notes',
  'other_quotes', 'bidders_private', 'authorized_band', 'internal_score', 'calendar:private', 'profiles']
const ALPHA_QUOTE_BY = '2026-09-25T00:00:00Z'
const ALPHA_CLARIFY_BY = '2026-09-23T00:00:00Z'
const ALPHA_SENT = '2026-09-23T09:00:00Z'
const ALPHA_ITEMS = [['L-001', 'P-100', 'm', 150], ['L-002', 'S-200', 'kg', 480]]

const ENV_ALPHA = {
  delivered_to: [ME], rev: 2, sent_at: ALPHA_SENT, snapshot_hash: 'sha256:' + '9'.repeat(64),
  spec: {
    package_id: 'pkg-alpha', currency: 'CNY',
    deadlines: { clarify_by: ALPHA_CLARIFY_BY, quote_by: ALPHA_QUOTE_BY },
    items: ALPHA_ITEMS.map(([item_id, code, unit, qty]) => ({ item_id, code, unit, qty })),
    // 承包商私域（**读都不读**）；带哨兵值便于扫 0 命中
    cost_floor: SENTINEL_COST, reserve_price: SENTINEL_RESERVE, internal_notes: SENTINEL_NOTE,
    other_quotes: [{ supplier: OTHER, unit_price: 99 }], bidders_private: [OTHER],
  },
}
const ENV_BETA = {
  delivered_to: [OTHER], rev: 7, sent_at: '2026-09-24T09:00:00Z',
  spec: {
    package_id: 'pkg-beta', currency: 'CNY',
    deadlines: { clarify_by: '2026-09-24T00:00:00Z', quote_by: '2026-09-26T00:00:00Z' },
    items: [{ item_id: 'L-777', code: 'BETA-ONLY', unit: 'kg', qty: 777 }],
    internal_notes: SENTINEL_NOTE,
  },
}
const ENV_SHARED = {
  delivered_to: [ME, OTHER], rev: 1, sent_at: '2026-09-22T09:00:00Z',
  spec: {
    package_id: 'pkg-shared', currency: 'CNY',
    deadlines: { clarify_by: '2026-09-22T00:00:00Z', quote_by: '2026-09-27T00:00:00Z' },
    items: [{ item_id: 'L-003', code: 'S-300', unit: 'kg', qty: 30 }],
  },
}
/** 本视角账本里的**普通行**（用来证明"账本行一条不多、一条不少"）。 */
const LEDGER_ROWS = [
  { seq: 1, type: 'quote/submitted', correlation_id: 'q-1', actor: 'agent:supplier',
    ts: '2026-09-22T10:00:00Z', body: { quote_id: 'q-1', lines: [{ item_id: 'L-001', unit_price: 86 }] } },
  { seq: 2, type: 'clarification/asked', correlation_id: 'q-1', actor: 'agent:supplier',
    ts: '2026-09-22T11:00:00Z', body: { question_id: 'c-1' } },
]
const CONTRACTOR_ROWS = [
  { seq: 1, type: 'rfq/published', correlation_id: 'pkg-alpha', actor: 'agent:sourcing',
    ts: ALPHA_SENT, body: { package_id: 'pkg-alpha', rev: 2, items: 2, cost_floor: 700 } },
  { seq: 2, type: 'compare/rank-computed', correlation_id: 'pkg-alpha', actor: 'agent:sourcing',
    ts: '2026-09-23T12:00:00Z', body: { evaluation_id: 'e-1', cost_floor: 700, markup_pct: 12.5 } },
]

const mod = await import(pathToFileURL(TARGET).href)

/** 挂载：照抄产物声明的 `inject`，包装 `provide` 抓句柄。 */
const mountWith = async (loaded = mod, ctx) => {
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
  }, loaded.Config.parse({}))
  return { ctx, fiber, box, loaded }
}

const mountFesh = async (loaded = mod) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  return mountWith(loaded, ctx)
}

/** 从**临时副本**挂载变异体（`?v=` 破缓存）；原文件一个字节都不动。 */
const mountMutant = async (mutatedSource) => {
  const dir = mkdtempSync(join(tmpdir(), 't287-mut-'))
  const tag = sha256(mutatedSource).slice(0, 8)
  const file = join(dir, `projection.mut-${tag}.mjs`)
  writeFileSync(file, mutatedSource, 'utf8')
  const mutant = await import(`${pathToFileURL(file).href}?v=${tag}`)
  const ctx = new Context()
  await ctx.plugin(EventsService)
  return await mountWith(mutant, ctx)
}

/** 单点变异：找不到/多于一处的"变异"是**假变异**（返回 null，调用方必须判红）。 */
const applyMutation = (text, find, replace) => {
  const count = text.split(find).length - 1
  if (count !== 1 || find === replace || !replace) return null
  return text.replace(find, replace)
}

const mounted = await mountFesh()
const handle = mounted.box.handle
const api = {
  /** 投递事实报告 + 同一次投影的对外行（两者来自**同一次**调用，不重复投影）。 */
  A: (envelopes, realms = [ME], options) => {
    const out = handle.projectWithAudit('supplier', LEDGER_ROWS, { deliveries: envelopes, realms, ...options })
    return { ...out.deliveries, publicRows: out.publicRows, audit: out.audit }
  },
  raw: (view, rows, options) => handle.projectWithAudit(view, rows, options),
}
const rowsJson = (result) => JSON.stringify(result.publicRows)
const count = (text, needle) => text.split(needle).length - 1

// ===========================================================================
// 1. 契约正控
// ===========================================================================
const {
  DELIVERY_VIEWS, DELIVERY_ROW_TYPE, RFQ_KEYS, RFQ_ITEM_KEYS, DELIVERY_NEVER_READ, DELIVERY_REASONS,
  DELIVERY_SUPPRESSED, DELIVERY_BASIS, projectDeliveries,
} = mod
const imports = [...originalSource.matchAll(/^import\s.+from\s+'([^']+)'/gm)].map((m) => m[1])
const importsOk = imports.length > 0 && imports.every((item) => item.startsWith('../lib/') || item.startsWith('node:'))
check('1 契约正控：导出齐备（`DELIVERY_VIEWS` = 消费投递事实的视角 / `RFQ_KEYS` **恰 9 键** / '
  + '`RFQ_ITEM_KEYS` 4 键 / `DELIVERY_NEVER_READ` / `DELIVERY_REASONS` / `DELIVERY_SUPPRESSED` / `DELIVERY_BASIS`）；'
  + '源码只 import `../lib/*` 或 `node:*`，且**不** import `node:fs`/`node:child_process`/`node:net`'
  + '（投影是纯函数：文件由宿主读、信封由调用方给）',
  Array.isArray(DELIVERY_VIEWS) && DELIVERY_VIEWS.includes('supplier') && DELIVERY_VIEWS.length === 1
  && DELIVERY_ROW_TYPE === 'rfq/published' && RFQ_KEYS.length === 9 && RFQ_ITEM_KEYS.length === 4
  && RFQ_KEYS.includes('recipient') && RFQ_KEYS.includes('rev') && RFQ_KEYS.includes('quote_by')
  && DELIVERY_NEVER_READ.includes('cost_floor') && DELIVERY_NEVER_READ.includes('other_quotes')
  && DELIVERY_REASONS.length === 7 && DELIVERY_SUPPRESSED.length === 2 && DELIVERY_BASIS === 'delivery-envelope'
  && typeof projectDeliveries === 'function' && importsOk
  && !/^import\s.+from\s+'node:(fs|child_process|net|http|os)'/m.test(originalSource),
  `DELIVERY_VIEWS=${JSON.stringify(DELIVERY_VIEWS)} RFQ_KEYS=${RFQ_KEYS.length} 键 `
  + `RFQ_ITEM_KEYS=${RFQ_ITEM_KEYS.length} 键 imports=${imports.join(',')}`)
check('1b 服务面正控：投影句柄暴露 `deliveries`（纯函数入口）与 `deliveryViews`（**宿主照抄同一真源**，'
  + '不在 webui 里另抄一份视角清单）',
  typeof handle.deliveries === 'function' && Array.isArray(handle.deliveryViews)
  && handle.deliveryViews.length === DELIVERY_VIEWS.length
  && handle.deliveryViews.includes('supplier'),
  `handle keys=${Object.keys(handle).join(',')} deliveryViews=${JSON.stringify(handle.deliveryViews)}`)

// ===========================================================================
// 2–4. 正控 / 负控 / 同一次调用对比
// ===========================================================================
const alpha = api.A([ENV_ALPHA], [ME])
const alphaRow = alpha.publicRows.find((row) => row.rfq && row.rfq.package_id === 'pkg-alpha')
const alphaRfq = alphaRow?.rfq ?? {}
const itemsText = JSON.stringify(alphaRfq.items ?? [])
const alphaItemsOk = ALPHA_ITEMS.every(([item_id, code, unit, qty]) => (alphaRfq.items ?? [])
  .some((item) => item.item_id === item_id && item.code === code && item.unit === unit && item.qty === qty))
check('2 **被邀供应商看得到包**（正控，逐字）：`pkg-alpha@rev2` 可见，`quote_by`/`clarify_by`/`delivered_at` '
  + '与夹具里的**事实值**逐字相等，行项目与数量齐（`L-001×150m`、`L-002×480kg`）',
  alpha.degraded === false && alpha.packages.length === 1 && alpha.identity === ME
  && alphaRfq.package_id === 'pkg-alpha' && alphaRfq.rev === 2 && alphaRfq.recipient === ME
  && alphaRfq.quote_by === ALPHA_QUOTE_BY && alphaRfq.clarify_by === ALPHA_CLARIFY_BY
  && alphaRfq.delivered_at === ALPHA_SENT && alphaRfq.currency === 'CNY' && alphaRfq.basis === DELIVERY_BASIS
  && alphaItemsOk && JSON.stringify(Object.keys(alphaRfq)) === JSON.stringify(RFQ_KEYS),
  `degraded=${alpha.degraded} packages=${alpha.packages.length} rfq=${JSON.stringify(alphaRfq)}`)

// **同一份输入**、换身份（第三家 `supplier:gamma`：**任何一封信封里都没有它**）：必须什么都看不到（负控）
const gamma = api.A([ENV_ALPHA, ENV_BETA, ENV_SHARED], [UNINVITED])
const other = api.A([ENV_ALPHA, ENV_BETA, ENV_SHARED], [OTHER])
check('3 **未被邀的供应商看不到**（负控）：同一批信封、身份换成 `supplier:gamma`（三封信封的 '
  + '`delivered_to` 里都没有它）⇒ `packages` 空 + `degraded:true` + `reason:"no-deliveries-visible"` '
  + '（别人收到了什么是别人的事，我这边是"没有发给我"这个有名状态）',
  gamma.degraded === true && gamma.reason === 'no-deliveries-visible' && gamma.packages.length === 0
  && gamma.counts.visible === 0 && gamma.identity === UNINVITED
  && !JSON.stringify(gamma).includes('pkg-alpha') && !JSON.stringify(gamma).includes('pkg-beta'),
  `degraded=${gamma.degraded} reason=${gamma.reason} visible=${gamma.counts.visible} 含 pkg-alpha=`
  + `${JSON.stringify(gamma).includes('pkg-alpha')}`)

// 同一批输入、**同一次调用**里三家对比（不是两次不同的运行）
const alphaAll = api.A([ENV_ALPHA, ENV_BETA, ENV_SHARED], [ME])
const alphaIds = alphaAll.packages.map((pkg) => pkg.rfq.package_id)
const gammaIds = gamma.packages.map((pkg) => pkg.rfq.package_id)
const otherIds = other.packages.map((pkg) => pkg.rfq.package_id)
check('4 **同一次调用里三方对比**：被邀的那家看到 `pkg-alpha` 与"同时发给两家"的 `pkg-shared`；'
  + '没被邀的那家**一个包都看不到**；而另一家（`supplier:beta-SENTINEL-9f3`）看到的是**它自己**的 '
  + '`pkg-beta` + `pkg-shared`（作用域是**按身份**的，不是"把所有人都挡住"这种空转）',
  JSON.stringify(alphaIds) === JSON.stringify(['pkg-alpha', 'pkg-shared']) && gammaIds.length === 0
  && JSON.stringify(otherIds) === JSON.stringify(['pkg-beta', 'pkg-shared']),
  `被邀的看到=${JSON.stringify(alphaIds)}；没被邀的看到=${JSON.stringify(gammaIds)}；`
  + `另一家看到=${JSON.stringify(otherIds)}`)

// ===========================================================================
// 5–8 泄漏负控（全部在**对外视图** publicRows 上判）
// ===========================================================================
const alphaView = rowsJson(alphaAll)
const alphaReport = JSON.stringify(alphaAll)
const otherHits = []
for (const needle of [OTHER, 'pkg-beta', 'BETA-ONLY', 'L-777']) {
  if (alphaView.includes(needle)) otherHits.push(needle)
}
check('5 **他家供应商代号 / 他家的包 0 命中**：对外视图（`publicRows` 序列化）里搜不到另一家的代号'
  + '（`supplier:beta-SENTINEL-9f3`）、他家的包 id 与他家的行项目',
  otherHits.length === 0 && alphaView.includes('pkg-alpha'),
  `命中=${JSON.stringify(otherHits)}（应为空）；同一次视图里含 pkg-alpha=${alphaView.includes('pkg-alpha')}`)

const privateHits = PRIVATE_KEYS.filter((key) => alphaView.includes(key))
const sentinelHits = [SENTINEL_COST, SENTINEL_NOTE, SENTINEL_RESERVE].filter((needle) => alphaView.includes(needle))
const fixtureHasSentinels = [SENTINEL_COST, SENTINEL_NOTE, SENTINEL_RESERVE, OTHER]
  .every((needle) => JSON.stringify([ENV_ALPHA, ENV_BETA, ENV_SHARED]).includes(needle))
check('6 **承包商私域键与哨兵值 0 命中**（对外视图）：`cost_floor`/`reserve_price`/`internal_notes`/'
  + '`other_quotes`/`bidders_private`/… 与三个哨兵值都搜不到；**非空转对照**：这些键与哨兵**确实在信封里**'
  + '（否则"0 命中"什么也证明不了）',
  privateHits.length === 0 && sentinelHits.length === 0 && fixtureHasSentinels
  && JSON.stringify(ENV_ALPHA).includes('cost_floor'),
  `私域键命中=${JSON.stringify(privateHits)}；哨兵命中=${JSON.stringify(sentinelHits)}；`
  + `夹具里确实有哨兵=${fixtureHasSentinels}`)

const variants = {
  '只有发给我的那封': api.A([ENV_ALPHA], [ME]),
  '我的那封 + 别家的那封（哨兵：别家的包与私域都在里面）': api.A([ENV_ALPHA, ENV_BETA], [ME]),
  '我的那封 + 双人封': api.A([ENV_ALPHA, ENV_SHARED], [ME]),
  '我的那封 + 双人封 + 别家的那封（顺序打乱）': api.A([clone(ENV_SHARED), ENV_BETA, ENV_ALPHA], [ME]),
  '只有别家的那封（我没有被邀到任何包）': api.A([ENV_BETA], [ME]),
}
const variantRows = Object.fromEntries(Object.entries(variants).map(([name, result]) => [name, rowsJson(result)]))
const withoutSentinel = variantRows['只有发给我的那封']
const sharedBaseline = variantRows['我的那封 + 双人封']
/** [带哨兵, 同基线的"不带哨兵"] 两对：加了"只发给别家"的信封后必须逐字节不变。 */
const sentinelPairs = [
  [variantRows['我的那封 + 别家的那封（哨兵：别家的包与私域都在里面）'], withoutSentinel],
  [variantRows['我的那封 + 双人封 + 别家的那封（顺序打乱）'], sharedBaseline],
]
check('7 **带哨兵与不带哨兵输出逐字节一致**：往输入里加"只发给别家"的那封（里面写着私域哨兵），'
  + '本视角的对外视图**逐字节不变**；**非空转对照**：加一封"同时发给两家"的信封**必须**改变视图'
  + '（按身份作用域，不是把一切挡住）',
  sentinelPairs.every(([withS, base]) => withS === base) && sharedBaseline !== withoutSentinel
  && sharedBaseline.includes('pkg-shared')
  && variants['只有别家的那封（我没有被邀到任何包）'].packages.length === 0
  && variants['只有别家的那封（我没有被邀到任何包）'].reason === 'no-deliveries-visible',
  `不带哨兵 sha256=${sha256(withoutSentinel).slice(0, 12)}… 各变体=${JSON.stringify(
    Object.entries(variantRows).map(([name, view]) => [name, sha256(view).slice(0, 12)]))}`)

const receipientPerRow = alphaAll.publicRows.filter((row) => row.rfq)
const recipientsOk = receipientPerRow.every((row) => row.rfq.recipient === ME
  && JSON.stringify(Object.keys(row.rfq)) === JSON.stringify(RFQ_KEYS))
check('8 **发放对象只出自己**：每一行的 `recipient` 恰为本视角身份、`rfq` 恰 9 键（**没有第 10 个键**'
  + '藏着一份名单）；`delivered_to` 这份**列表**在对外视图里一个字都不出现（连"另有几家"的计数也不出 '
  + '—— 竞标人名册是业主私域）；其他参与方代号 0 命中',
  alphaView.includes(`"recipient":"${ME}"`) && count(alphaView, ME) === receipientPerRow.length
  && count(alphaView, 'delivered_to') === 0 && count(alphaView, OTHER) === 0
  && count(alphaView, `"recipient":"${OTHER}"`) === 0 && recipientsOk
  && !alphaView.includes('delivered_to')
  && alphaAll.packages.every((pkg) => !('delivered_to' in pkg.rfq) && !('recipients' in pkg.rfq))
  && !('delivered_to' in alphaAll) && !('recipients' in alphaAll),
  `行数=${receipientPerRow.length}；本视角身份出现次数=${count(alphaView, ME)}；`
  + `delivered_to 命中=${count(alphaView, 'delivered_to')}；他家代号命中=${count(alphaView, OTHER)}；`
  + `每行 recipient 与键集合规=${recipientsOk}`)

// ===========================================================================
// 9–10. 逐字一致 / 不取墙钟 / 确定性
// ===========================================================================
const clockPatterns = [/\bnew\s+Date\b/, /Date\.now/, /performance\.now/, /Math\.random/,
  /setTimeout/, /setInterval/]
const clockHits = clockPatterns.filter((pattern) => pattern.test(originalSource))
const clockScannerWorks = clockPatterns.some((pattern) => pattern.test('const t = new Date().toISOString()'))
check('9 **rev / 截止逐字一致且不取墙钟**：三个时间字段与事实逐字相等（上面第 2 条也已逐字对账）；'
  + '投影源码里 0 个墙钟/随机入口（`new Date` / `Date.now` / `performance.now` / `Math.random` / 定时器），'
  + '**扫描器非空转对照**（拿一段含 `new Date()` 的样本必须能扫到）',
  clockHits.length === 0 && clockScannerWorks && alphaRfq.delivered_at === ALPHA_SENT
  && alphaRfq.quote_by === ALPHA_QUOTE_BY && alphaRfq.clarify_by === ALPHA_CLARIFY_BY,
  `源码命中=${JSON.stringify(clockHits.map(String))}；扫描器能扫到样本=${clockScannerWorks}`)

const again = api.A([ENV_ALPHA], [ME])
const secondMount = await mountFesh()
const crossInstance = secondMount.box.handle.projectWithAudit('supplier', LEDGER_ROWS,
  { deliveries: [ENV_ALPHA], realms: [ME] })
const shuffled = api.A([ENV_ALPHA, clone(ENV_SHARED)], [ME])
const ordered = api.A([clone(ENV_SHARED), ENV_ALPHA], [ME])
check('10 确定性：同输入两次逐字节一致 / 跨实例一致 / **信封顺序无关**（两份输入顺序互换后逐字节一致）；'
  + '输入对象被深拷贝后结果不变（不依赖对象身份）',
  rowsJson(again) === rowsJson(alpha) && rowsJson(crossInstance) === rowsJson(alpha)
  && rowsJson(shuffled) === rowsJson(ordered)
  && JSON.stringify(again.counts) === JSON.stringify(alpha.counts),
  `两次一致=${rowsJson(again) === rowsJson(alpha)} 跨实例=${rowsJson(crossInstance) === rowsJson(alpha)} `
  + `顺序无关=${rowsJson(shuffled) === rowsJson(ordered)}`)
await secondMount.fiber.dispose()

// ===========================================================================
// 11–14. 多版本 / 有界 / 降级 / 派生行形状
// ===========================================================================
const older = { ...clone(ENV_ALPHA), rev: 1, sent_at: '2026-09-20T09:00:00Z' }
const newer = { ...clone(ENV_ALPHA), rev: 3, sent_at: '2026-09-24T09:00:00Z' }
const multi = api.A([older, ENV_ALPHA, newer], [ME])
const sameRev = api.A([{ ...clone(ENV_ALPHA), rev: 2, sent_at: '2026-09-01T00:00:00Z' }, newer], [ME])
check('11 同一包多版本 ⇒ 只出**最新一版**（rev 大者优先；rev 相同时取 `delivered_at` 靠后者）：'
  + 'rev 1/2/3 三份输入只出 rev3；rev2(旧 sent_at) + rev3 ⇒ 出 rev3',
  multi.packages.length === 1 && multi.packages[0].rfq.rev === 3
  && sameRev.packages.length === 1 && sameRev.packages[0].rfq.rev === 3,
  `多版本输出=${JSON.stringify(multi.packages.map((pkg) => [pkg.rfq.package_id, pkg.rfq.rev]))}；`
  + `同 rev 取新=${JSON.stringify(sameRev.packages.map((pkg) => pkg.rfq.rev))}`)

const capped = api.A([ENV_ALPHA, ENV_BETA, ENV_SHARED], [ME], { maxPackages: 1 })
const itemCap = { ...clone(ENV_ALPHA), spec: { ...clone(ENV_ALPHA.spec), items: [
  { item_id: 'L-001', code: 'P-100', unit: 'm', qty: 150 }, { item_id: 'L-002', code: 'S-200', unit: 'kg', qty: 480 }] } }
const cappedItems = api.A([itemCap], [ME], { maxItems: 1 })
check('12 有界 + `omitted`：`maxPackages=1` ⇒ 只出 1 个包、`omitted=1`、`bounded=true`、'
  + '`truncated=true`（本视角实际被发到 2 个包）；`maxItems=1` ⇒ 每包 1 条行项目 + `items_omitted=1`',
  capped.packages.length === 1 && capped.omitted === 1 && capped.bounded === true && capped.truncated === true
  && capped.counts.visible === 2
  && cappedItems.packages[0].rfq.items.length === 1 && cappedItems.counts.items_omitted === 1
  && cappedItems.bounded === true,
  `包夹取=${capped.packages.length} omitted=${capped.omitted} bounded=${capped.bounded} `
  + `visible=${capped.counts.visible}；行项目夹取=${cappedItems.packages[0].rfq.items.length} `
  + `items_omitted=${cappedItems.counts.items_omitted}`)

const degradeCases = [
  ['view-not-a-delivery-consumer', () => handle.projectWithAudit('contractor', CONTRACTOR_ROWS,
    { deliveries: [ENV_ALPHA], realms: ['contractor:g1'] }).deliveries],
  ['no-identity', () => api.A([ENV_ALPHA], [])],
  ['ambiguous-identity', () => api.A([ENV_ALPHA], [ME, OTHER])],
  ['identity-malformed', () => api.A([ENV_ALPHA], ['SUPPLIER-ALPHA'])],
  ['payload-not-an-object', () => api.A('not-an-array', [ME])],
  ['no-deliveries', () => api.A([], [ME])],
  ['no-deliveries-visible', () => api.A([ENV_BETA], [ME])],
]
const degradeRows = degradeCases.map(([reason, run]) => {
  const report = run()
  const ok = report?.degraded === true && report.reason === reason && report.packages.length === 0
    && DELIVERY_REASONS.includes(reason)
  return { reason, ok, got: `${report?.degraded}/${report?.reason}` }
})
check('13 降级**可分辨**（七个有名 reason，闭合集合）：`view-not-a-delivery-consumer`（承包商侧不读投递）/ '
  + '`no-identity`（本视角账本还没事实）/ `ambiguous-identity`（本视角账本里出现两个 realm，fail-closed）/ '
  + '`identity-malformed`（身份形状不合法）/ `payload-not-an-object` / `no-deliveries`（没有任何信封）/ '
  + '`no-deliveries-visible`（有信封但没有发给本视角的）—— 每个都 `degraded:true` + 有名 reason + 包为空',
  degradeRows.every((item) => item.ok) && degradeRows.length === DELIVERY_REASONS.length,
  degradeRows.map((item) => `${item.reason}=${item.ok ? 'ok' : `**${item.got}**`}`).join(' · '))

const plain = api.raw('supplier', LEDGER_ROWS)
const withDelivery = api.raw('supplier', LEDGER_ROWS, { deliveries: [ENV_ALPHA], realms: [ME] })
const ledgerPart = (result) => JSON.stringify(result.publicRows.filter((row) => !row.rfq))
const derivedRows = withDelivery.publicRows.filter((row) => row.rfq)
check('14 派生行形状与"账本行不受影响"：派生行 `type="rfq/published"`、`rfq` 恰 9 键、`seq === null`'
  + '（**不是账本行**，不冒充 seq）、`summary` 里含 rev 与报价截止；**账本行部分逐字节不变**'
  + '（带不带投递信封，本视角自己账本的那些行一条不多、一条不少）',
  derivedRows.length === 1 && derivedRows[0].type === 'rfq/published' && derivedRows[0].seq === null
  && Object.keys(derivedRows[0].rfq).length === 9
  && String(derivedRows[0].summary).includes('rev=2') && String(derivedRows[0].summary).includes(ALPHA_QUOTE_BY)
  && ledgerPart(withDelivery) === ledgerPart(plain) && plain.deliveries === null
  && withDelivery.publicRows.length === plain.publicRows.length + 1,
  `派生行=${JSON.stringify(derivedRows.map((row) => [row.type, row.seq, Object.keys(row.rfq).length]))}；`
  + `summary=${String(derivedRows[0]?.summary).slice(0, 90)}；账本行不变=${ledgerPart(withDelivery) === ledgerPart(plain)}`)

// ===========================================================================
// 15–17. 承包商侧不得减少 / 零写面 / webui 装配静态契约
// ===========================================================================
const contractorPlain = api.raw('contractor', CONTRACTOR_ROWS)
const contractorWith = api.raw('contractor', CONTRACTOR_ROWS, { deliveries: [ENV_ALPHA], realms: ['contractor:g1'] })
check('15 **承包商侧不得减少、也不得多出供应商私域**：承包商视角带不带投递信封**输出逐字节一致**'
  + '（供应商侧的那份信封对他不产生任何一行），且报告如实说 `view-not-a-delivery-consumer`',
  rowsJson(contractorWith) === rowsJson(contractorPlain)
  && contractorWith.deliveries.reason === 'view-not-a-delivery-consumer'
  && !rowsJson(contractorWith).includes('pkg-alpha"') // 承包商自己的 rfq/published 来自它自己的账本，不是信封
  || (rowsJson(contractorWith) === rowsJson(contractorPlain)
    && contractorWith.deliveries.reason === 'view-not-a-delivery-consumer'),
  `逐字节一致=${rowsJson(contractorWith) === rowsJson(contractorPlain)} `
  + `reason=${contractorWith.deliveries.reason}（承包商自己的账本行里本来就有 pkg-alpha 的 rfq/published）`)

const writePatterns = [/from\s+'node:(fs|child_process|net|http|os)'/, /require\(/, /writeFile/, /appendFile/,
  /execSync/, /execFile/, /spawn\(/, /fetch\(/, /\bprocess\./, /\bnew\s+Date\b/, /Math\.random/]
const writeHits = writePatterns.filter((pattern) => pattern.test(originalSource))
const writeScannerWorks = writePatterns.some((pattern) => pattern.test("import { readFileSync } from 'node:fs'"))
check('16 **零写面 / 不读文件 / 不取墙钟**（静态扫描）：投影源码里没有 `node:fs`/子进程/网络/`process.`/'
  + '墙钟/随机；**扫描器非空转对照**（拿一段含 `import ... node:fs` 的样本必须能扫到）',
  writeHits.length === 0 && writeScannerWorks,
  `源码命中=${JSON.stringify(writeHits.map(String))}；扫描器能扫到样本=${writeScannerWorks}`)

const inboxTemplate = webuiSource.slice(webuiSource.indexOf('data-rfq="inbox"'),
  webuiSource.indexOf('const inProgressBlock'))
const inboxTemplateOk = inboxTemplate.length > 200 && !inboxTemplate.includes(scriptNeedle)
  && !inlineEvent.test(inboxTemplate) && !inboxTemplate.includes('method="post"')
const webuiWiringOk = webuiSource.includes("rfq_delivery: string().default('')")
  && webuiSource.includes('const deliveryEnvelopes')
  && webuiSource.includes('deliveryViews ?? []')
  && webuiSource.includes("typeof ledger.realms === 'function'")
  && webuiSource.includes("data-rfq-degraded=") && webuiSource.includes('data-rfq-reason=')
  && webuiSource.includes('data-rfq-omitted=')
check('17 webui 装配静态契约：`rfq_delivery` 配置项 + 投递信封**只读**装配（`deliveryEnvelopes`）+ 身份来自'
  + '本视角账本（`realms()`）+ 页面投递块带 `data-rfq-degraded/reason/omitted` 抓手；'
  + '页面块本身 **0 行 `<script>` / 0 内联事件 / 0 写动作（POST）**（扫描器非空转对照）',
  inboxTemplateOk && webuiWiringOk && inlineEvent.test(' on' + 'click="x"'),
  `模板长度=${inboxTemplate.length} 含脚本=${inboxTemplate.includes(scriptNeedle)} `
  + `含内联事件=${inlineEvent.test(inboxTemplate)} 含 POST=${inboxTemplate.includes('method="post"')} `
  + `装配齐备=${webuiWiringOk}`)

// ===========================================================================
// 18–19. 单点变异 + 防假变异 + 还原
// ===========================================================================
/** 五条"必须红"的场景（基线必须全真，否则变异变红说明不了任何事）。 */
const scenarioReport = (handleLike) => {
  const apiOf = (envelopes, realms = [ME], options) => {
    const out = handleLike.projectWithAudit('supplier', LEDGER_ROWS, { deliveries: envelopes, realms, ...options })
    return { ...out.deliveries, publicRows: out.publicRows }
  }
  const envelopes = [ENV_ALPHA, ENV_BETA, ENV_SHARED]
  const a = apiOf(envelopes, [ME])
  const g = apiOf(envelopes, [UNINVITED])
  const caps = apiOf(envelopes, [ME], { maxPackages: 1 })
  const viewA = rowsJson(a)
  const rowsWithRfq = a.publicRows.filter((row) => row.rfq)
  const rfq = rowsWithRfq.find((row) => row.rfq.package_id === 'pkg-alpha')?.rfq ?? {}
  return {
    'S1 被邀供应商看得到包': JSON.stringify(a.packages.map((pkg) => pkg.rfq.package_id))
      === JSON.stringify(['pkg-alpha', 'pkg-shared']),
    'S2 未被邀供应商看不到': g.packages.length === 0 && g.degraded === true
      && g.reason === 'no-deliveries-visible' && g.counts.visible === 0,
    'S3 他家供应商代号与私域键 0 命中': !viewA.includes(OTHER) && !viewA.includes('pkg-beta')
      && !viewA.includes('BETA-ONLY') && !viewA.includes('L-777')
      && PRIVATE_KEYS.every((key) => !viewA.includes(key)),
    'S4 发放对象只出自己': rowsWithRfq.length === 2
      && rowsWithRfq.every((row) => row.rfq.recipient === ME && Object.keys(row.rfq).length === 9)
      && !viewA.includes('delivered_to'),
    'S5 rev/截止逐字一致（不取墙钟）': rfq.rev === 2 && rfq.quote_by === ALPHA_QUOTE_BY
      && rfq.clarify_by === ALPHA_CLARIFY_BY && rfq.delivered_at === ALPHA_SENT,
    'S6 有界如实报 omitted': caps.packages.length === 1 && caps.omitted === 1 && caps.bounded === true,
  }
}
const baseline = scenarioReport(handle)
check('18 变异基线：六条场景（S1 被邀看得到 / S2 未被邀看不到 / S3 他家代号与私域 0 命中 / '
  + 'S4 发放对象只出自己 / S5 rev 截止逐字一致 / S6 有界如实报 omitted）在**真产物**上全真'
  + '（否则"变异变红"说明不了任何事：基线本来就是红的）',
  Object.values(baseline).every(Boolean),
  JSON.stringify(baseline))

const MUTATIONS = [
  { name: '变异1：**把包发给所有供应商**（越权：去掉收件人作用域判定 ⇒ 谁都能看到任何一份信封）',
    find: '    if (!to.includes(me)) continue',
    replace: '    if (false) continue',
    mustRed: 'S2 未被邀供应商看不到' },
  { name: '变异2：发放对象不再只出自己（`recipient` 取整份 `delivered_to` 名单）',
    find: '      recipient: me,                                    // 发放对象：**只出"我"**',
    replace: "      recipient: (Array.isArray(raw.delivered_to) ? raw.delivered_to : []).join('、'),",
    mustRed: 'S1 被邀供应商看得到包' },
  { name: '变异3：把整份 `delivered_to` 当成第 10 个键塞进 `rfq`（"另有几家"随之外泄）',
    find: '      delivered_at: text(raw.sent_at),',
    replace: '      delivered_at: text(raw.sent_at),\n      delivered_to: to,',
    mustRed: 'S4 发放对象只出自己' },
  { name: '变异4：报价截止改成**墙钟推算**（不再逐字取事实里的 `quote_by`）',
    find: '      quote_by: text(deadlines.quote_by),',
    replace: '      quote_by: new Date(Date.now() + 86400000).toISOString(),',
    mustRed: 'S5 rev/截止逐字一致（不取墙钟）' },
]
const mutationReport = []
let mutationsOk = true
for (const mutation of MUTATIONS) {
  const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
  if (mutated === null) {
    mutationsOk = false
    mutationReport.push(`${mutation.name}→假变异`)
    check(`18 变异：${mutation.name}`, false,
      `假变异：锚点唯一性=${mutated !== null}（锚点必须**恰出现一次**且替换后字节真的变了）`)
    continue
  }
  const mountedMutant = await mountMutant(mutated)
  let red = []
  try {
    const scenario = scenarioReport(mountedMutant.box.handle)
    red = Object.entries(scenario).filter(([, ok]) => !ok).map(([name]) => name)
  } catch (err) {
    red = [`[抛错] ${String(err).slice(0, 60)}`]
  }
  await mountedMutant.fiber.dispose()
  const ok = red.includes(mutation.mustRed) && mutated !== originalSource
  mutationsOk = mutationsOk && ok
  mutationReport.push(`${mutation.name}→变红场景=${JSON.stringify(red)}（必须含「${mutation.mustRed}」）`)
  check(`18 变异：${mutation.name}`, ok,
    `必须红的场景=${mutation.mustRed}；实际变红=${JSON.stringify(red)}；字节已变=${mutated !== originalSource}`
    + '（越权/泄漏型变异由**两道结构性负控**兜住 ⇒ 表现常常是"该看到的看不到了"，那是 fail-closed 的必然' 
    + '结果，不是"门很稳"）')
}
check('18 变异小结：4 处单点变异各自让**指定的**场景变红（含"把包发给所有供应商"这种越权变异：'
  + '去掉收件人作用域 ⇒ 没被邀的那家立刻看到别人的包 ⇒ S2 红，且他家代号/他家包随之出现在我的视图里 ⇒ S3 也红）',
  mutationsOk && mutationReport.length === 4
  && mutationReport[0].includes('S3 他家供应商代号与私域键 0 命中'),
  mutationReport.join('；'))

const fakeGuard = applyMutation(originalSource, '这行根本不存在', 'x')
const selfMutation = applyMutation(originalSource, "export const name = 'projection'", "export const name = 'projection'")
check('19 防假变异（自检）：找不到唯一锚点的"变异"必须被判**假变异**（返回 null），'
  + '把锚点替换成它自己也不算变异 —— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

const afterSource = sourceOf(TARGET)
const afterWebui = sourceOf(WEBUI)
check('19b 还原与隔离：跑完整门之后 `projection.mjs` 与 `webui.mjs` 与跑之前**逐字节一致**'
  + '（变异只写在临时目录的副本里）；`registerHooks` 可用性如实记录（false 时本门在**同目录原始导入**下跑）',
  sha256(afterSource) === originalHash && sha256(afterWebui) === webuiHash,
  `projection 未变=${sha256(afterSource) === originalHash}；webui 未变=${sha256(afterWebui) === webuiHash}；`
  + `hooks=${hookReady}`)

finish()
