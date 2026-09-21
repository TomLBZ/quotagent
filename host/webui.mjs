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
import { apply as webuiApply, Config as webuiConfig } from './modules/webui.mjs'
import { Config as projectionConfig, apply as projectionApply, project, projectWithAudit, VIEW_RULES } from './modules/projection.mjs'

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

const box = {}
const fiber = await ctx.plugin({
  name: 'webui#probe',
  inject: ['ledgerView', 'projection'],   // 与 webui 模块声明的 inject 保持一致
  Config: webuiConfig,
  apply: async (inner, config) => {
    const original = inner.provide.bind(inner)
    inner.provide = (service, value) => { if (service === 'webui') box.handle = value; return original(service, value) }
    await webuiApply(inner, config)
  },
}, { port: 0, route_prefix: '/quotagent' })

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
// 投影服务也要提供（webui 的 inject 依赖它；fixture 里只验"坏数据不杀服务"，投影用真实插件）
await brokenCtx.plugin({
  name: 'projection#broken',
  inject: [],
  Config: projectionConfig,
  apply: (inner, cfg) => projectionApply(inner, cfg),
}, projectionConfig.parse({}))
const brokenFiber = await brokenCtx.plugin({
  name: 'webui#broken',
  inject: ['ledgerView', 'projection'],
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

// 4. 未知视角
const unknown = await get('/nonexistent/')
check('WebUI 负控：未知路径/视角返回 404 且带可用路径提示（不得静默空页面）',
  unknown.status === 404 && unknown.text.includes('可用'), `status=${unknown.status}`)

// 5. 零残留：dispose 后端口释放，可被重新监听
const port = box.handle.port
await fiber.dispose()
await projectionFiber.dispose()
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
