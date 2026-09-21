/**
 * WebUI 插件的 HTTP 级检查（`tools/verify.sh webui`）。
 *
 * 起真实 HTTP 服务（临时端口）并用真实请求断言双方视角；每条含负控：
 *   1. `/api/health` 与 `/api/status`（含账本健康性，来自 Python 侧链校验）
 *   2. `/contractor/` 与 `/supplier/` 两个**不同路由**各自可访问，且标题/事件集合不同（不同视角不同 UI）
 *   3. **私域负控**：源数据里塞进承包商私域键（`cost_floor`/`markup_pct`/`calendar:private`）后，
 *      供应商视角**必须看不到**（被抑制或过滤），而承包商视角**能看到**（非空转对照）
 *   4. 未知视角 → 404（不得静默返回空页面）
 *   5. dispose 后端口释放（零残留），再次监听同一端口成功
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { createServer as probeServer } from 'node:net'
import { apply as webuiApply, Config as webuiConfig, sendGovernorError } from './modules/webui.mjs'
import { Config as projectionConfig, apply as projectionApply, project, projectWithAudit, VIEW_RULES } from './modules/projection.mjs'
import { Config as governorConfig, apply as governorApply } from './modules/governor.mjs'
import { Config as auditConfig, apply as auditApply } from './modules/audit-hook.mjs'
import { Config as canaryConfig, apply as canaryApply } from './modules/canary.mjs'
import { Config as obsConfig, apply as obsApply } from './modules/observability.mjs'
import { Config as historyConfig, apply as historyApply } from './modules/price-history.mjs'
import { Config as evConfig2, apply as evApply2 } from './modules/evidence-summary.mjs'
import { Config as brConfig3, apply as brApply3 } from './modules/circuit-breaker.mjs'
import { Config as opsConfig3, apply as opsApply3 } from './modules/ops-view.mjs'
import { Config as jConfig3, apply as jApply3 } from './modules/evolve-journal.mjs'
import { Config as scConfig3, apply as scApply3 } from './modules/supplier-scorecard.mjs'
import { Config as apConfig3, apply as apApply3 } from './modules/approval-digest.mjs'
import { Config as rvConfig3, apply as rvApply3 } from './modules/retention-view.mjs'
import { Config as pvConfig3, apply as pvApply3 } from './modules/pipeline-view.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

// 源数据：一条"干净"事件 + 一条带**承包商私域**的事件（供应商绝不能看到）
const RAW = [
  { seq: 1, type: 'rfq/published', correlation_id: 'pkg-014', actor: 'agent:sourcing', ts: '2026-09-21T10:00:00Z',
    body: { package_id: 'pkg-014', rev: 1, items: 2 } },
  { seq: 2, type: 'quote/submitted', correlation_id: 'q-0007', actor: 'human:liangzi', ts: '2026-09-21T11:00:00Z',
    body: { quote_id: 'q-0007', total_amount: 101000 } },
  { seq: 3, type: 'compare/rank-computed', correlation_id: 'pkg-014', actor: 'agent:sourcing',
    ts: '2026-09-21T12:00:00Z',
    body: { evaluation_id: 'sha256:abc', cost_floor: 88000, markup_pct: 12.5, 'calendar:private': { available: 220 } } },
  { seq: 4, type: 'award/committed', correlation_id: 'awin-1', actor: 'human:liangzi', ts: '2026-09-21T13:00:00Z',
    body: { award_id: 'aw-0001', quote_id: 'q-0007' } },
  // 关键构造：事件类型在供应商可见白名单里，但 body 混进了承包商私域键（`cost_floor`）
  { seq: 5, type: 'quote/submitted', correlation_id: 'q-0008', actor: 'agent:sourcing', ts: '2026-09-21T14:00:00Z',
    body: { quote_id: 'q-0008', total_amount: 99000, cost_floor: 70000 } },
]
// 价格序列用例：RAW 里补一条带 `body.lines[]` 的行（真数据流不能只靠"形状对"来假装）
RAW.push({ seq: 999, type: 'quote/submitted', ts: '2026-09-21T00:00:00Z', realm: 'contractor:con-B',
  body: { quote_id: 'q-hist-1', lines: [{ item_id: 'L-001', unit_price: 11 }, { item_id: 'L-001', unit_price: 13 },
    { item_id: 'L-002', unit_price: 22 }] } })

// 绩效记分卡用例：RAW 里再补一条带 `supplier_id` 的行（门必须喂真数据才验得出"真接上了"）
RAW.push({ seq: 998, type: 'quote/submitted', ts: '2026-09-21T01:00:00Z', realm: 'contractor:con-B',
  body: { quote_id: 'q-sc-1', supplier_id: 'sup-A',
    lines: [{ item_id: 'L-009', unit_price: 88, lead_time_days: 5 },
      { item_id: 'L-009', unit_price: 92, lead_time_days: 7 }] } })

// 待批摘要用例：RAW 里补一条 `approval/requested`（门必须喂真数据）
RAW.push({ seq: 997, type: 'approval/requested', ts: '2026-09-21T00:30:00Z', realm: 'contractor:con-B',
  body: { approval_id: 'ap-777', action: 'quote.submit', waited_seconds: 7200, model_confidence: 0.72,
    timeout_policy: 'remind', summary: '不该外泄的正文' } })

const ledgerStub = (rows) => ({
  path: '/tmp/stub-ledger.jsonl',
  rows: () => rows,
  verify: () => ({ ok: true, count: rows.length, head: 'sha256:' + 'a'.repeat(64) }),
})

const ctx = new Context()
await ctx.plugin(EventsService)
// 让 webui 能 inject 到 ledgerView：在**根 ctx** provide（fixture stub）
ctx.provide('ledgerView', ledgerStub(RAW))

const projectionBox = {}
const projectionFiber = await ctx.plugin({
  name: 'projection#probe',
  inject: [],
  Config: projectionConfig,
  apply: async (inner, config) => {
    const original = inner.provide.bind(inner)
    inner.provide = (service, value) => { if (service === 'projection') projectionBox.handle = value; return original(service, value) }
    await projectionApply(inner, config)
  },
}, projectionConfig.parse({}))

const governorMount = (name, sink) => ({
  name, inject: [], Config: governorConfig,
  apply: async (inner, config) => {
    const original = inner.provide.bind(inner)
    inner.provide = (service, value) => { if (service === 'governor') sink.handle = value; return original(service, value) }
    await governorApply(inner, config)
  },
})
const gbox = {}
/** 观测来源 + 聚合（T-236）：三者都必须先挂，webui 的 inject 依赖它们。 */
const obsBox = {}
const mountObs = async (targetCtx) => {
  const wrap = async (mod, cfg, service, key) => {
    await targetCtx.plugin({
      // inject 必须**照抄模块声明**：包装挂载里写 inject: [] 会让模块取不到依赖（实测报 without inject）
      name: `${service}#probe`, inject: mod.inject ?? [], Config: mod.Config,
      apply: async (inner, c) => {
        const original = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) obsBox[key] = v; return original(s, v) }
        await mod.apply(inner, c)
      },
    }, mod.Config.parse(cfg))
  }
  await wrap({ apply: auditApply, Config: auditConfig }, { capacity: 200 }, 'audit', 'audit')
  await wrap({ apply: canaryApply, Config: canaryConfig }, { weight_bps: 0 }, 'canary', 'canary')
  await wrap({ apply: obsApply, Config: obsConfig, inject: ['governor', 'audit', 'canary'] }, {}, 'observability', 'obs')
  await wrap({ apply: historyApply, Config: historyConfig, inject: [] }, { key_field: 'supplier_id' }, 'priceHistory', 'history')
  await wrap({ apply: evApply2, Config: evConfig2, inject: [] }, {}, 'evidenceSummary', 'evidence')
  await wrap({ apply: brApply3, Config: brConfig3, inject: [] }, {}, 'breaker', 'breaker')
  await wrap({ apply: opsApply3, Config: opsConfig3, inject: ['observability', 'breaker', 'evidenceSummary'] }, {}, 'opsView', 'ops')
  await wrap({ apply: jApply3, Config: jConfig3, inject: [] }, {}, 'evolveJournal', 'journal')
  await wrap({ apply: scApply3, Config: scConfig3, inject: [] }, {}, 'supplierScorecard', 'scorecard')
  await wrap({ apply: apApply3, Config: apConfig3, inject: [] }, {}, 'approvalDigest', 'approvals')
  await wrap({ apply: rvApply3, Config: rvConfig3, inject: [] }, {}, 'retentionView', 'retention')
  await wrap({ apply: pvApply3, Config: pvConfig3, inject: [] }, {}, 'pipelineView', 'pipeline')
}
await mountObs(ctx)

const gfiber = await ctx.plugin(governorMount('governor#probe', gbox),
  governorConfig.parse({ capacity: 64, timeout_ms: 5000 }))

// T-245：喂一个**临时自进化账本**，让运维页的自进化流水有真数据可归纳（同时验泄漏负控）
const evolvePath = join(mkdtempSync(join(tmpdir(), 'wui-evolve-')), 'ledger.jsonl')
writeFileSync(evolvePath, [
  JSON.stringify({ type: 'evolve/proposed', body: { id: 'p-x', note: '正文不该外泄' } }),
  JSON.stringify({ type: 'evolve/gated', body: { verdict: 'rejected', reasons: ['r1'], cost_floor: 777 } }),
  JSON.stringify({ type: 'evolve/promoted', body: { approval_ref: 'ap-9' } }),
].join('\n') + '\n', 'utf8')

const box = {}
const fiber = await ctx.plugin({
  name: 'webui#probe',
  inject: ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView'],   // 与 webui 模块声明的 inject 保持一致
  Config: webuiConfig,
  apply: async (inner, config) => {
    const original = inner.provide.bind(inner)
    inner.provide = (service, value) => { if (service === 'webui') box.handle = value; return original(service, value) }
    await webuiApply(inner, config)
  },
}, { port: 0, route_prefix: '/quotagent', ledger_evolve: evolvePath })

const base = box.handle.url.replace(/\/$/, '')
const get = async (path) => {
  const res = await fetch(`${base}${path}`)
  const text = await res.text()
  return { status: res.status, text }
}

// 1. 健康与状态
const health = await get('/api/health')
check('WebUI 正控：`/api/health` 返回 ok（工作区服务契约）',
  health.status === 200 && JSON.parse(health.text).status === 'ok', `status=${health.status}`)
const status = await get('/api/status')
const statusJson = JSON.parse(status.text)
check('WebUI 正控：`/api/status` 给出路由前缀、视角列表与**两侧账本各自**的健康性（链校验来自 Python 侧）',
  status.status === 200 && statusJson.route_prefix === '/quotagent' && statusJson.routes?.length === 2
  && Object.values(statusJson.ledgers ?? {}).every((item) => item.healthy === true),
  // 失败详情必须**安全求值**：断言为假时也要能打印响应体。实测踩到：detail 里 `Object.keys(undefined)`
  // 会在断言失败时把整个检查脚本崩掉，把真因（响应体）盖住——这正是本轮排查变慢的原因。
  `status=${status.status} routes=${JSON.stringify(statusJson.routes)} `
  + `ledgers=${JSON.stringify(Object.keys(statusJson.ledgers ?? {}))} body=${String(status.text).slice(0, 140)}`)

// 2. 两个视角：不同路由、不同内容
const contractor = await get('/contractor/')
const supplier = await get('/supplier/')
check('WebUI 正控：双方视角各自可达且是**不同路由**（`/quotagent/contractor/` 与 `/quotagent/supplier/`）',
  contractor.status === 200 && supplier.status === 200
  && contractor.text.includes('承包商视角') && supplier.text.includes('供应商视角'),
  `contractor=${contractor.status} supplier=${supplier.status}`)
const contractorApi = await get('/contractor/api/events')
const supplierApi = await get('/supplier/api/events')
const cJson = JSON.parse(contractorApi.text)
const sJson = JSON.parse(supplierApi.text)
if (!Array.isArray(cJson.events)) {
  check('诊断：/contractor/api/events 响应体', false,
    `status=${contractorApi.status} body=${String(contractorApi.text).slice(0, 200)}`)
}
check('WebUI 正控：两视角看到的事件集合不同（承包商含 compare/*，供应商不含）',
  (cJson.events ?? []).length > (sJson.events ?? []).length
  && (cJson.events ?? []).some((item) => String(item.type).startsWith('compare/'))
  && !(sJson.events ?? []).some((item) => String(item.type).startsWith('compare/')),
  `contractor=${cJson.count} 条 supplier=${sJson.count} 条`)

// 3. 私域负控（含非空转对照）
const supplierText = JSON.stringify(sJson)
const contractorText = JSON.stringify(cJson)
const leaked = VIEW_RULES.supplier.privateKeys.filter((key) => supplierText.includes(key))
check('私域**负控**：供应商视角看不到承包商私域键（`cost_floor`/`markup_pct`/`calendar:private`）',
  leaked.length === 0, `泄漏=${JSON.stringify(leaked)}`)
const contractorShows = ['cost_floor', 'markup_pct'].filter((key) => contractorText.includes(key))
check('私域**非空转对照**：同一批私域数据在承包商视角**可见**（证明确实在源里，供应商看不到不是因为"什么都没有"）',
  contractorShows.length >= 1 && !supplierText.includes('cost_floor'),
  `承包商视角可见=${JSON.stringify(contractorShows)}；供应商视角含 cost_floor=${supplierText.includes('cost_floor')}`)
const supplierProjection = projectWithAudit('supplier', RAW)
const projectedSupplier = supplierProjection.publicRows
const projectedContractor = project('contractor', RAW)
check('私域负控：投影层把"可见类型但含私域键"的行标为 suppressed，且**对外原因通用**（键名不外泄）',
  projectedSupplier.some((row) => row.suppressed && row.reason === 'private-field-suppressed')
  && !JSON.stringify(projectedSupplier).includes('cost_floor')
  && supplierProjection.audit.some((item) => item.suppressed_key.includes('cost_floor')),
  `suppressed=${projectedSupplier.filter((row) => row.suppressed).length} 行；`
  + `对外原因=${[...new Set(projectedSupplier.filter((row) => row.suppressed).map((row) => row.reason))].join(',')}；`
  + `审计（仅服务端）=${supplierProjection.audit.map((item) => item.suppressed_key).join(',')}`)
check('私域对照：同一行的私域内容在承包商投影里保留（两侧规则不同，不是一刀切）',
  JSON.stringify(projectedContractor).includes('cost_floor')
  && !projectedContractor.some((row) => row.suppressed),
  `contractor suppressed=${projectedContractor.filter((row) => row.suppressed).length}`)

// 3b. 健壮性负控：投影阶段遇到病态数据（body 里有 null 字段 / 不可序列化值）时，
//     服务**必须**继续存活（回 500 或正常投影），绝不能整个进程退出
const BROKEN = [
  ...RAW,
  { seq: 6, type: 'rfq/published', correlation_id: 'pkg-015', actor: 'agent:sourcing', ts: '2026-09-21T15:00:00Z',
    body: { package_id: 'pkg-015', nothing: null, nested: { deep: null } } },
]
const brokenBox = {}
const brokenCtx = new Context()
await brokenCtx.plugin(EventsService)
brokenCtx.provide('ledgerView', ledgerStub(BROKEN))
await brokenCtx.plugin(governorMount('governor#broken', {}), governorConfig.parse({ capacity: 64, timeout_ms: 5000 }))
await mountObs(brokenCtx)
// 投影服务也要提供（webui 的 inject 依赖它；fixture 里只验"坏数据不杀服务"，投影用真实插件）
await brokenCtx.plugin({
  name: 'projection#broken',
  inject: [],
  Config: projectionConfig,
  apply: (inner, cfg) => projectionApply(inner, cfg),
}, projectionConfig.parse({}))
const brokenFiber = await brokenCtx.plugin({
  name: 'webui#broken',
  inject: ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView'],
  Config: webuiConfig,
  apply: async (inner, config) => {
    const original = inner.provide.bind(inner)
    inner.provide = (service, value) => { if (service === 'webui') brokenBox.handle = value; return original(service, value) }
    await webuiApply(inner, config)
  },
}, { port: 0, route_prefix: '/quotagent' })
const brokenBase = brokenBox.handle.url.replace(/\/$/, '')
const brokenView = await fetch(`${brokenBase}/contractor/`)
const brokenText = await brokenView.text()
const stillAlive = await fetch(`${brokenBase}/api/health`)
check('健壮性负控：账本含 null 字段时服务**不崩**（请求级兜底），随后 /api/health 仍可用',
  stillAlive.status === 200 && (brokenView.status === 200 || brokenView.status === 500),
  `视图 status=${brokenView.status}（${brokenText.slice(0, 40)}…）健康 status=${stillAlive.status}`)
await brokenFiber.dispose()

// 4c. T-236：运行期观测路由（只读、双方视角都可见）
const obsRes = await get('/api/obs')
let obsJson = {}
try { obsJson = JSON.parse(obsRes.text) } catch (err) { obsJson = {} }
check('观测正控：/api/obs 返回 200 且含 governor/audit/canary 三个来源的统计（不含私域）',
  obsRes.status === 200 && (obsJson.observability?.sources ?? []).length === 3
  && typeof obsJson.summary === 'string' && !obsRes.text.includes('private:')
  && typeof obsJson.observability?.governor?.stats?.admitted === 'number',
  `status=${obsRes.status} sources=${(obsJson.observability?.sources ?? []).join(',')} summary=${String(obsJson.summary).slice(0, 60)}`)

// 4d. T-238：自进化产出的插件（price-history）在双方视角都可见
const hist = await get('/contractor/api/history')
let histJson = {}
try { histJson = JSON.parse(hist.text) } catch (err) { histJson = {} }
const supHist = await get('/supplier/api/history')
check('价格序列正控：/contractor/api/history 与 /supplier/api/history 都 200（**双方视角各自可见**），'
  + '形状来自自进化插件 price-history，且响应里不含私域键',
  hist.status === 200 && supHist.status === 200 && typeof histJson.groups === 'number'
  && Array.isArray(histJson.series) && histJson.groups >= 1
  && histJson.series.every((item) => typeof item.median === 'number' && ['up', 'down', 'flat'].includes(item.trend))
  && String(histJson.source).includes('price-history')
  && !hist.text.includes('cost_floor') && !hist.text.includes('private:'),
  `status=${hist.status}/${supHist.status} groups=${histJson.groups} source=${String(histJson.source).slice(0, 40)}`)

// 4e. T-240：账本证据面（第二个自进化产出）在双方视角都可见，且不出正文
const ev1 = await get('/contractor/api/evidence')
let ev1Json = {}
try { ev1Json = JSON.parse(ev1.text) } catch (err) { ev1Json = {} }
const ev2 = await get('/supplier/api/evidence')
check('证据面正控：/contractor/api/evidence 与 /supplier/api/evidence 都 200，含行数/类型数/关联数/时间跨度，'
  + '来源为自进化插件 evidence-summary，且不输出正文',
  ev1.status === 200 && ev2.status === 200 && (ev1Json.summary?.rows ?? 0) >= 1
  && Array.isArray(ev1Json.summary?.by_type) && ev1Json.summary.by_type.length >= 1
  && typeof ev1Json.summary?.span?.first === 'string'
  && String(ev1Json.source).includes('evidence-summary')
  && !/"body"\s*:/.test(ev1.text) && !ev1.text.includes('private:'),
  `status=${ev1.status}/${ev2.status} rows=${ev1Json.summary?.rows} types=${ev1Json.summary?.by_type?.length}`)

// 4f. T-244：第三条视角道（运维视角）—— 不属于任何一方，且不出正文/私域
const opsPage = await get('/ops/')
const opsApi = await get('/api/ops')
let opsJson = {}
try { opsJson = JSON.parse(opsApi.text) } catch (err) { opsJson = {} }
check('运维视角正控：/ops/ 与 /api/ops 都 200，含运行期（governor/breaker/canary）与**各视角**证据面聚合，'
  + '来源为自进化插件 ops-view，且不出正文/私域',
  opsPage.status === 200 && opsApi.status === 200 && opsPage.text.includes('运维视角')
  && typeof opsJson.runtime?.governor?.admitted === 'number' && typeof opsJson.breaker?.stats?.opened === 'number'
  && ['contractor', 'supplier'].every((v) => (opsJson.evidence_by_view?.[v]?.rows ?? -1) >= 0)
  && String(opsJson.source).includes('ops-view')
  && !/"body"\s*:/.test(opsApi.text) && !opsApi.text.includes('private:'),
  `page=${opsPage.status} api=${opsApi.status} perView=${Object.keys(opsJson.evidence_by_view ?? {}).join(',')}`)

// 4g. T-245：运维视角里的"自进化流水"（第五个自进化产出归纳真账本，且不出正文）
const evRes = await get('/api/ops')
let evJson = {}
try { evJson = JSON.parse(evRes.text) } catch (err) { evJson = {} }
const jr = evJson.evolve_journal ?? {}
check('自进化流水正控：/api/ops 含 evolve_journal，计数与喂入的账本一致（提案1/门拒1/晋升1），'
  + '来源为自进化插件 evolve-journal，且**不出正文与私域键**',
  evRes.status === 200 && jr.proposed === 1 && jr.gated?.rejected === 1 && jr.promoted === 1
  && jr.gated?.total === 1 && String(jr.last_event).startsWith('evolve/')
  && !evRes.text.includes('正文不该外泄') && !evRes.text.includes('cost_floor') && !/"body"\s*:/.test(evRes.text),
  `status=${evRes.status} proposed=${jr.proposed} rejected=${jr.gated?.rejected} promoted=${jr.promoted} last=${jr.last_event}`)

// 4h. T-247：供应商绩效记分卡（subagent 产出）在双方视角可见，且不出正文/私域
const sc1 = await get('/contractor/api/scorecard')
let scJson = {}
try { scJson = JSON.parse(sc1.text) } catch (err) { scJson = {} }
const sc2 = await get('/supplier/api/scorecard')
check('绩效记分卡正控：/contractor/api/scorecard 与 /supplier/api/scorecard 都 200，含按供应商聚合的绩效面，'
  + '来源为 subagent 产出并晋升的 supplier-scorecard，且不出正文/私域',
  sc1.status === 200 && sc2.status === 200 && Array.isArray(scJson.scorecard) && scJson.scorecard.length >= 1
  && typeof scJson.scorecard[0].quote_count === 'number'
  && String(scJson.source).includes('supplier-scorecard')
  && !/"body"\s*:/.test(sc1.text) && !sc1.text.includes('private:') && !sc1.text.includes('cost_floor'),
  `status=${sc1.status}/${sc2.status} groups=${scJson.groups}`)

// 4k. T-260：谈判/FAQ/邮件三域在运维道可见（Python 写快照，宿主只读聚合）
const pp = await get('/api/pipeline')
let ppJson = {}
try { ppJson = JSON.parse(pp.text) } catch (err) { ppJson = {} }
check('三域流水正控：/api/pipeline 200，含谈判/FAQ/邮件三域计数与 transport 三件，且不出正文与私域',
  pp.status === 200 && ppJson.pipeline && Array.isArray(ppJson.pipeline.views)
  && typeof (ppJson.pipeline.transport || {}).available === 'boolean'
  && typeof (ppJson.pipeline.transport || {}).reason === 'string'
  && typeof (ppJson.pipeline.transport || {}).next_action === 'string'
  && !/"body"\s*:/.test(pp.text) && !pp.text.includes('private:') && !pp.text.includes('reserve_price'),
  `status=${pp.status} degraded=${ppJson.pipeline?.degraded} transport=${JSON.stringify(ppJson.pipeline?.transport || {})?.slice(0, 60)}`)

// 4j. T-254：留存计划在运维视角可见（判定在 Python 侧；宿主只读落盘文件并交给 retention-view 聚合）
const rt = await get('/api/retention')
let rtJson = {}
try { rtJson = JSON.parse(rt.text) } catch (err) { rtJson = {} }
check('留存计划正控：/api/retention 200，含计数/动作分布/人类可读摘要，且不出正文与私域键',
  rt.status === 200 && rtJson.retention && typeof rtJson.headline === 'string'
  && Array.isArray(rtJson.retention.action_mix) && typeof rtJson.retention.pending_approvals === 'number'
  && !/"body"\s*:/.test(rt.text) && !rt.text.includes('private:') && !rt.text.includes('reserve_price'),
  `status=${rt.status} headline=${String(rtJson.headline).slice(0, 40)} degraded=${rtJson.retention?.degraded}`)

// 4i. T-250：人工门待批摘要（subagent 产出）在双方视角可见，且不出正文/私域
const ap1 = await get('/contractor/api/approvals')
let apJson = {}
try { apJson = JSON.parse(ap1.text) } catch (err) { apJson = {} }
const ap2 = await get('/supplier/api/approvals')
check('待批摘要正控：/contractor/api/approvals 与 /supplier/api/approvals 都 200，含待批总数与等待时长分桶，'
  + '来源为 subagent 产出并晋升的 approval-digest，且不出正文/私域',
  ap1.status === 200 && ap2.status === 200 && (apJson.digest?.total ?? 0) >= 1
  && Array.isArray(apJson.digest?.by_age) && apJson.digest.by_age.length >= 1
  && String(apJson.source).includes('approval-digest')
  && !ap1.text.includes('不该外泄的正文') && !/"body"\s*:/.test(ap1.text) && !ap1.text.includes('private:'),
  `status=${ap1.status}/${ap2.status} total=${apJson.digest?.total} age=${JSON.stringify(apJson.digest?.by_age)}`)

// 4. 未知视角
const unknown = await get('/nonexistent/')
check('WebUI 负控：未知路径/视角返回 404 且带可用路径提示（不得静默空页面）',
  unknown.status === 404 && unknown.text.includes('可用'), `status=${unknown.status}`)

// 4b. T-234：governor 作用在 UI 请求路径上（背压 → 429 + Retry-After，不是 500/挂起）
// 桶名要按**应用实际用的 key** 取：req.url 带路由前缀，硬编码 webui:/api/health 会落到另一个桶（实测踩到）
const bkey = Object.keys(gbox.handle.stats().buckets).find((k) => k.endsWith('/api/health'))
if (!bkey) throw new Error('找不到 /api/health 的桶（说明请求没走 governor）')
const beforeBuckets = JSON.stringify(gbox.handle.stats().buckets)
for (let i = 0; i < 70; i++) gbox.handle.admit({ key: bkey })          // 占满该路由额度（70 > capacity 64）
const afterBuckets = JSON.stringify(gbox.handle.stats().buckets)
const pressured = await fetch(`${base}/api/health`)
const pressuredBody = await pressured.text()
check('T-234 正控：额度耗尽时 UI 返回 **429 + Retry-After**（可解释的背压，不是 500/挂起）',
  pressured.status === 429 && Boolean(pressured.headers.get('retry-after'))
  && JSON.parse(pressuredBody).error === 'backpressure',
  `status=${pressured.status} retry-after=${pressured.headers.get('retry-after')} `
  + `body=${pressuredBody.slice(0, 70)} buckets=${beforeBuckets}→${afterBuckets} refused=${gbox.handle.stats().refused}`)
gbox.handle.release({ key: bkey, cost: 64 })
const recovered = await get('/api/health')
check('T-234 正控：归还额度后同一路由恢复 200（背压不是"永久封路"）',
  recovered.status === 200, `status=${recovered.status}`)

// 4c. T-234：错误映射的单测（429/504/500 三档；不依赖慢请求就能断言）
const fakeRes = () => {
  const captured = { status: null, headers: null, body: null }
  return { headersSent: false, captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(body) { captured.body = body } }
}
const bpRes = fakeRes()
sendGovernorError(bpRes, { code: 'backpressure', detail: { reason: 'credit-exhausted', retry_after_ms: 50, next_action: 'wait' } })
const toRes = fakeRes()
sendGovernorError(toRes, { code: 'timeout', message: '调用超时（5ms）' })
const otherRes = fakeRes()
sendGovernorError(otherRes, { code: 'whatever', message: 'boom' })
check('T-234 正控：错误映射三档（背压→429+Retry-After / 超时→504 / 其它→500）可在单测层断言',
  bpRes.captured.status === 429 && bpRes.captured.headers['retry-after'] === '1'
  && JSON.parse(bpRes.captured.body).error === 'backpressure'
  && toRes.captured.status === 504 && JSON.parse(toRes.captured.body).error === 'timeout'
  && otherRes.captured.status === 500,
  `429=${bpRes.captured.status} retry-after=${bpRes.captured.headers?.['retry-after']} 504=${toRes.captured.status} 500=${otherRes.captured.status}`)

// 5. 零残留：dispose 后端口释放，可被重新监听
const port = box.handle.port
await fiber.dispose()
await projectionFiber.dispose()
await gfiber.dispose()
await new Promise((resolve) => setTimeout(resolve, 50))
const freed = await new Promise((resolve) => {
  const probe = probeServer()
  probe.once('error', () => resolve(false))
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
})
const gone = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => false).catch(() => true)
check('零残留：dispose 后 HTTP 服务关闭且**端口释放**（可被重新监听）',
  freed && gone, `port=${port} 可重监听=${freed}`)

console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] webui: ${failures} 项未通过`)
} else {
  console.error(`[PASS] webui（${facts.checks.length} 条断言，含私域负控与零残留）`)
}
process.exit(failures ? 1 : 0)
