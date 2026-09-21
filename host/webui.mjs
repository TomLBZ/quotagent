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
import { Config as agConfig3, apply as agApply3 } from './modules/admin-guard.mjs'
import { Config as avConfig3, apply as avApply3 } from './modules/admin-view.mjs'
import { Config as pmConfig3, apply as pmApply3 } from './modules/plugin-market.mjs'
import { Config as upConfig3, apply as upApply3 } from './modules/user-plugin-manager.mjs'
import { Config as cvConfig3, apply as cvApply3 } from './modules/config-view.mjs'
import { Config as mvConfig3, apply as mvApply3 } from './modules/mail-view.mjs'
import { Config as bhConfig3, apply as bhApply3 } from './modules/bid-heuristics.mjs'
import { Config as fbConfig3, apply as fbApply3 } from './modules/ui-feedback.mjs'
import { Config as advConfig3, apply as advApply3 } from './modules/advice-panel.mjs'
import { Config as gtConfig3, apply as gtApply3 } from './modules/gate-timeline.mjs'
import { Config as abConfig3, apply as abApply3 } from './modules/authority-band.mjs'
import { Config as rdConfig3, apply as rdApply3 } from './modules/rfq-deadline.mjs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 门自己注入的**假** admin token：只为在夹具里取到第四道页面（`/quotagent/admin/`）的 HTML。
// 值不落任何文件、不出本进程；admin-guard 在 apply() 时读它（见 admin-guard 的 configured）。
const GATE_TOKEN = 'gate-token-p0a-9d21'
process.env.QUOTAGENT_ADMIN_TOKEN = GATE_TOKEN

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

// P0 配置与凭据（config-view）夹具：**临时**配置文件（受管段 + 非受管段；后者必须被原样保留）。
// 门**绝不**碰真实 `/workspace/config.yaml`（那里有用户自己的配置）。
const cvFixtureDir = mkdtempSync(join(tmpdir(), 'wui-config-'))
const cvConfigPath = join(cvFixtureDir, 'config.yaml')
const cvConfigRaw = [
  '# 夹具：受管段（project/plugins）+ 非受管段（other）',
  'project:',
  '  pricing.markup_pct: 20',
  '  transport.kind: relay',
  'plugins:',
  '  "demo/demo-plugin":',
  '    markup_pct: 9',
  'other:',
  '  notes: 非受管段必须被原样保留',
].join('\n') + '\n'
writeFileSync(cvConfigPath, cvConfigRaw, 'utf8')
// 真实配置文件（用户的）在本门全程必须**字节不变**：宿主配置面只读，门也不许动它
const REAL_CONFIG_PATH = '/workspace/config.yaml'
const realHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const realConfigBefore = existsSync(REAL_CONFIG_PATH) ? realHash(REAL_CONFIG_PATH) : null

// 邮件域（mail-view）夹具：**只读快照文件**。刻意塞进三类"不该出现"的东西做负控：
//   ① 私域/正文标记（`private:` / `cost_model` / `signature`）→ 必须被洗成 (redacted)；
//   ② 快照里多出来的键（`password` / `body`）→ 投影**读都不读**（键名白名单）；
//   ③ 哨兵串 `MAIL-FIXTURE-LEAK-9f` → 响应体里出现次数必须为 0。
const mailFixtureDir = mkdtempSync(join(tmpdir(), 'wui-mail-'))
const mailFixture = join(mailFixtureDir, 'mail.json')
const MAIL_LEAK = 'MAIL-FIXTURE-LEAK-9f'
writeFileSync(mailFixture, JSON.stringify({
  schema: 1,
  generated_at: '2026-09-21T12:00:00Z',
  service: 'mail',
  totals: { queued: 3, refused: 2, sent: 1, parsed: 1 },
  views: {
    contractor: { queued: 2, refused: 2, sent: 1, parsed: 1, body: `${MAIL_LEAK}-body` },
    supplier: { queued: 1, refused: 0, sent: 0, parsed: 0, subject: `${MAIL_LEAK}-subject` },
  },
  transport: {
    smtp: { configured: true, connected: false, available: false,
      reason: 'smtp-unreachable', next_action: '确认 mail.smtp.host / port 可达后重试',
      password: `${MAIL_LEAK}-credential` },
    imap: { configured: false, connected: false, available: false,
      reason: 'mail-imap-unconfigured', next_action: '把 IMAP 接入点配置：mail.imap.host / port' },
    last_attempt: { kind: 'send', service: 'smtp', ok: false, reason: 'smtp-unreachable',
      next_action: `private:${MAIL_LEAK}-signature`, message_id: 'ml-0001' },
    attempts: [
      { kind: 'send', service: 'smtp', ok: false, reason: 'smtp-unreachable', next_action: '确认端口' },
      { kind: 'fetch', service: 'imap', ok: true, reason: '', next_action: '' },
    ],
  },
  note: `${MAIL_LEAK}-note`,
}), 'utf8')

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
  await wrap({ apply: avApply3, Config: avConfig3, inject: [] }, {}, 'adminView', 'admin-view')
  await wrap({ apply: upApply3, Config: upConfig3, inject: [] }, { root: process.cwd() + '/user-space' }, 'userPluginManager', 'user-plugin-manager')
  await wrap({ apply: pmApply3, Config: pmConfig3, inject: [] },
    { modules_dir: process.cwd() + '/host/modules', inventory: process.cwd() + '/docs/design/14-plugin-inventory.md', user_space: '' },
    'pluginMarket', 'plugin-market')
  await wrap({ apply: agApply3, Config: agConfig3, inject: [] }, { token_env: 'QUOTAGENT_ADMIN_TOKEN' }, 'adminGuard', 'admin-guard')
  // 配置与凭据（config-view）：文件指向夹具临时目录（**不读真文件**），inbox 也让夹具自己定
  await wrap({ apply: cvApply3, Config: cvConfig3, inject: [] },
    { config_file: cvConfigPath, config_inbox: join(cvFixtureDir, 'config-submissions'),
      config_status: join(cvFixtureDir, 'config-status.json'), config_ledger: join(cvFixtureDir, 'config-ledger.jsonl') },
    'configView', 'config-view')
  // 邮件域（mail-view，本批新增）：快照指向夹具临时文件（**不读真快照**）→ 页面/JSON 有真数据可断言
  await wrap({ apply: mvApply3, Config: mvConfig3, inject: [] },
    { mail_state: mailFixture, ui_shared: mailFixtureDir }, 'mailView', 'mail')
  // 比价 heuristics（T-279）：webui 的 inject 需要它（wiring 门 B1）
  await wrap({ apply: bhApply3, Config: bhConfig3, inject: [] }, {}, 'bidHeuristics', 'bid-heuristics')
  // 决策建议层（本批）：webui 的 inject 需要它（wiring 门 B1）；纯函数插件，无需夹具输入
  await wrap({ apply: advApply3, Config: advConfig3, inject: [] }, {}, 'advicePanel', 'advice-panel')
  // 审批等多久 / 变更单谁卡着（本批）：webui 的 inject 需要它（wiring 门 B1）；纯函数插件，无需夹具输入
  await wrap({ apply: gtApply3, Config: gtConfig3, inject: [] }, {}, 'gateTimeline', 'gate-timeline')
  // 授权区间（本批）：webui 的 inject 需要它（wiring 门 B1）；纯函数插件（只读配置快照），无需夹具输入
  await wrap({ apply: abApply3, Config: abConfig3, inject: [] }, {}, 'authorityBand', 'authority-band')
  // RFQ 回文时限（本批）：webui 的 inject 需要它（wiring 门 B1）；纯函数插件，无需夹具输入
  await wrap({ apply: rdApply3, Config: rdConfig3, inject: [] }, {}, 'rfqDeadline', 'rfq-deadline')
  // WebUI 反馈闭环（ui-feedback）：版本事实指向**夹具临时目录**（不读真 `tmp/ui-shared`）→
  // 版本事实缺失 ⇒ 全视图 `r0`、无横幅，门的其它断言与机器状态无关（确定性）
  const fbFixtureDir = mkdtempSync(join(tmpdir(), 'wui-fb-'))
  await wrap({ apply: fbApply3, Config: fbConfig3, inject: [] },
    { ui_shared: fbFixtureDir, views: ['contractor', 'supplier'], pending_limit: 3 }, 'uiFeedback', 'ui-feedback')
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

// T-262：业务视角断言必须**自带夹具快照** —— 干净副本里没有 tmp/ 演示数据
// （第一版靠真 `tmp/ui-shared/pipeline.json`，clean-copy 门立刻报 webui 23/25 红）
const pipeFixtureDir = mkdtempSync(join(tmpdir(), 'wui-pipe-'))
const pipeFixture = join(pipeFixtureDir, 'pipeline.json')
const pipeRec = (n) => Array.from({ length: n }, (_, i) => ({
  thread_id: `nt-000${i + 1}`, attempt_no: i + 1, status: 'conceded',
  body: 'SECRET-BODY-不该外泄', drift: 'private:必须过滤',   // 哨兵：路由必须按键投影，不得原样透传
}))
const pipeFaqRec = (n) => Array.from({ length: n }, (_, i) => ({
  entry_id: `fq-000${i + 1}`, rfq_rev: i + 1, subject: 'SECRET-SUBJECT', note: 'private:必须过滤',
}))
writeFileSync(pipeFixture, JSON.stringify({
  generated_at: '2026-09-21T12:00:00Z',
  totals: { threads: 2, rounds: 2, rejected: 2, entries: 2, queued: 2, refused: 2 },
  views: Object.fromEntries(['contractor', 'supplier'].map((v) => [v, {
    negotiate: { threads: 1, open: 0, closed: 1, rounds: 1, rejected: 1, recent: pipeRec(5) },
    faq: { entries: 1, revs: [1], recent: pipeFaqRec(5) },
    mail: { queued: 1, refused: 1, transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' } },
  }])),
}), 'utf8')

const box = {}
const fiber = await ctx.plugin({
  name: 'webui#probe',
  inject: ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback', 'advicePanel', 'gateTimeline', 'authorityBand', 'rfqDeadline'],   // 与 webui 模块声明的 inject 保持一致
  Config: webuiConfig,
  apply: async (inner, config) => {
    const original = inner.provide.bind(inner)
    inner.provide = (service, value) => { if (service === 'webui') box.handle = value; return original(service, value) }
    await webuiApply(inner, config)
  },
}, { port: 0, route_prefix: '/quotagent', ledger_evolve: evolvePath, pipeline_snapshot: pipeFixture })

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
  inject: ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback', 'advicePanel', 'gateTimeline', 'authorityBand', 'rfqDeadline'],
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

// 4l. T-262：谈判轮次与 FAQ 条目在**业务双方视角**可见（渲染只读快照；判定在 Python 侧）
const nva = await get('/contractor/api/negotiation')
const nvb = await get('/supplier/api/negotiation')
let nvJson = {}
try { nvJson = JSON.parse(nva.text) } catch (err) { nvJson = {} }
check('业务视角·谈判正控：双方 /<view>/api/negotiation 都 200，含计数与最近轮次，且不出正文/私域',
  nva.status === 200 && nvb.status === 200 && nvJson.counts && Array.isArray(nvJson.recent)
  && !/"body"\s*:/.test(nva.text) && !nva.text.includes('private:') && !nva.text.includes('reserve_price'),
  `status=${nva.status}/${nvb.status} counts=${JSON.stringify(nvJson.counts)} recent=${(nvJson.recent || []).length}`)
// 夹具负控：快照里放了 SECRET/private: 哨兵，路由必须按键投影掉；且列表有界（夹具 5 条）
check('业务视角·谈判投影：recent 按键投影（thread_id/attempt_no/status），哨兵 body/private 不得出现，且 ≤5 条',
  !nvJson.recent?.some((r) => Object.keys(r).some((k) => !['thread_id', 'attempt_no', 'status'].includes(k)))
  && (nvJson.recent || []).length > 0 && (nvJson.recent || []).length <= 5
  && !nva.text.includes('SECRET-BODY') && !nva.text.includes('private:'),
  `keys=${JSON.stringify((nvJson.recent || []).map((r) => Object.keys(r)))} n=${(nvJson.recent || []).length}`)
const fqa = await get('/contractor/api/faq')
let fqJson = {}
try { fqJson = JSON.parse(fqa.text) } catch (err) { fqJson = {} }
check('业务视角·FAQ 投影：recent 按键投影（entry_id/rfq_rev），subject/private 哨兵不得出现，且 ≤5 条',
  !fqJson.recent?.some((r) => Object.keys(r).some((k) => !['entry_id', 'rfq_rev'].includes(k)))
  && (fqJson.recent || []).length > 0 && (fqJson.recent || []).length <= 5
  && !fqa.text.includes('SECRET-SUBJECT') && !fqa.text.includes('private:'),
  `keys=${JSON.stringify((fqJson.recent || []).map((r) => Object.keys(r)))} n=${(fqJson.recent || []).length}`)
check('业务视角·FAQ 正控：/<view>/api/faq 200，含条目计数与最近条目，且不出正文/私域',
  fqa.status === 200 && fqJson.counts && Array.isArray(fqJson.recent)
  && !/"body"\s*:/.test(fqa.text) && !fqa.text.includes('private:'),
  `status=${fqa.status} counts=${JSON.stringify(fqJson.counts)} recent=${(fqJson.recent || []).length}`)

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

// ============================================================================
// P0-2 / P0-3 门扩充（**只增不改**：上面 27 条一字不动）
//   E2   四道页面 0 <script> / 0 内联事件属性；子视图页面同形
//   E2b  八个新子路由各 200 且带道内子导航 + GET 表单
//   E4   第一屏三个 data-block 锚点存在且顺序正确
//   E5   筛选非空转（不同参数值 → 不同响应体 + 不同行集合）
//   E6   空结果**显式说明**「筛选无结果」
//   E7   分页不重叠 + 不丢行（与全量集合自证比对）
//   E8   applied 回显（含夹取后的真值）
//   E9   排序非空转（同一行集合、不同行序）
//   E10  私域哨兵负控（子视图页面）+ 非空转对照
//   E11  既有 JSON 路由**字节不变**（夹具内确定性路由，逐字节 sha256）
//   E12  三条非确定路由（内含实时计数 / 读 Python 快照）顶层键集不变
//   E13  四道页面都有道内子导航，且「上手」入口保留
//   E14  从 dashboard 到达不变
// ============================================================================
const P02_SUBVIEWS = {
  contractor: ['events', 'quotes', 'approvals', 'evidence'],
  supplier: ['events', 'quotes', 'approvals', 'clarifications'],
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const getBytes = async (path) => {
  const res = await fetch(`${base}${path}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, buf, text: buf.toString('utf8') }
}
const rowsOf = (text) => [...String(text).matchAll(/data-row="([^"]*)"/g)].map((match) => match[1])
const appliedOf = (text) => {
  const match = String(text).match(/当前筛选已应用：([^<]*)/)
  return match ? match[1].trim() : ''
}
const INLINE_EVENT = /\son[a-z]+\s*=/i

// E2：四道页面（admin 道用门自己注入的假 token 真提权拿页面，否则第四道是 401 固定体，断言会空转）
const homePage = await get('/')
const adminElevate = await fetch(`${base}/admin/api/elevate`, { method: 'POST', body: `token=${GATE_TOKEN}` })
const adminCookie = String(adminElevate.headers.get('set-cookie') ?? '').split(';')[0]
const adminPage = await fetch(`${base}/admin/`, { headers: { cookie: adminCookie } })
const adminText = await adminPage.text()
// 第四道（真实 webui 的 /admin/，提权后）必须是**真面板**而不是坏页面：既有的逗号连写曾让响应体只剩 `NaN`
check('P0-2/E13b 真 webui 的第四道（`/admin/`，门内提权后）**真的是面板**：含阻塞清单与进度区、'
  + '含用户空间插件与插件市场两块，且响应体不是 `NaN`/空（这是回归锁：曾因返回链里的逗号连写整块面板变成 `NaN`）',
  adminPage.status === 200 && adminText.includes('阻塞清单') && adminText.includes('进度与口径来源')
  && adminText.includes('用户空间插件') && adminText.includes('插件市场') && adminText !== 'NaN',
  `status=${adminPage.status} len=${adminText.length} 含阻塞清单=${adminText.includes('阻塞清单')} `
  + `含市场=${adminText.includes('插件市场')} 体就是 NaN=${adminText === 'NaN'}`)
const fourPages = [['/', homePage], ['/contractor/', contractor], ['/supplier/', supplier],
  ['/ops/', opsPage], ['/admin/', { status: adminPage.status, text: adminText }]]
const scripty = fourPages.filter(([, page]) => page.text.includes('<script'))
const handlery = fourPages.filter(([, page]) => INLINE_EVENT.test(page.text))
check('P0-2/E2 四道页面（含 admin 道真提权）仍 **0 行 `<script>` 且 0 个内联事件属性**'
  + '（零 JS 是机检事实：交互只允许 `<form method=get>` 与 `<a>`）',
  fourPages.every(([, page]) => page.status === 200) && scripty.length === 0 && handlery.length === 0
  && adminElevate.status === 200,
  `status=${fourPages.map(([name, page]) => `${name}=${page.status}`).join(' ')}；提权 status=${adminElevate.status}；`
  + `含 <script>=${scripty.map(([name]) => name).join(',') || '无'}；含内联事件=${handlery.map(([name]) => name).join(',') || '无'}`)

// E2b / E2c：八个新子路由
const subPages = {}
for (const [view, subs] of Object.entries(P02_SUBVIEWS)) {
  for (const sub of subs) subPages[`/${view}/${sub}/`] = await get(`/${view}/${sub}/`)
}
const subBad = Object.entries(subPages).filter(([, res]) => res.status !== 200)
const subNoNav = Object.entries(subPages).filter(([path, res]) => !res.text.includes(`data-subnav="${path.split('/')[1]}"`))
const subNoForm = Object.entries(subPages).filter(([, res]) => !/<form method="get"/.test(res.text))
check('P0-3/E2b 八个新子路由**各返回 200**，页面里有**道内子导航**（`data-subnav`）与 `<form method="get">` 筛选表单'
  + '（无 JS 也能用；`/supplier/evidence/` 不在清单里是**有意**的：供应商道是 clarifications）',
  subBad.length === 0 && subNoNav.length === 0 && subNoForm.length === 0 && Object.keys(subPages).length === 8,
  `status=${Object.entries(subPages).map(([path, res]) => `${path}=${res.status}`).join(' ')}；`
  + `缺子导航=${subNoNav.map(([path]) => path).join(',') || '无'}；缺 GET 表单=${subNoForm.map(([path]) => path).join(',') || '无'}`)
const subScripty = Object.entries(subPages).filter(([, res]) => res.text.includes('<script') || INLINE_EVENT.test(res.text))
check('P0-3/E2c 子视图页面同样 **0 `<script>` / 0 内联事件属性**（新页面不得偷偷引入脚本）',
  subScripty.length === 0, `命中=${subScripty.map(([path]) => path).join(',') || '无'}`)

// 4m（本批）：邮件域（SMTP/IMAP）的只读视图 —— 页面 + JSON 都真读 Python 侧快照
const mailPage = await get('/ops/mail/')
const mailApi = await get('/api/mail')
let mailJson = {}
try { mailJson = JSON.parse(mailApi.text) } catch (err) { mailJson = {} }
const mailSnap = mailJson.mail || {}
check('邮件域正控：`/ops/mail/` 200 且是**真页面**（道内导航 + 队列计数/通道表/尝试表），'
  + '`/api/mail` 200 且给出 queue 计数 / available / reason / next_action 与最近一次尝试'
  + '（数据来自 Python 侧快照；宿主只读文件、不联网、不发信）',
  mailPage.status === 200 && mailApi.status === 200
  && mailPage.text.includes('data-subnav="ops"') && mailPage.text.includes('data-mail="counts"')
  && mailPage.text.includes('data-mail="transport"') && mailPage.text.includes('data-mail="attempts"')
  && !mailPage.text.includes('<script') && !INLINE_EVENT.test(mailPage.text)
  && mailSnap.degraded === false && mailSnap.counts?.sent === 1 && mailSnap.counts?.queued === 3
  && mailSnap.smtp?.available === false && typeof mailSnap.smtp?.reason === 'string'
  && mailSnap.smtp.reason.length > 0
  && typeof mailSnap.smtp?.next_action === 'string' && mailSnap.smtp.next_action.length > 8
  && mailSnap.last_attempt?.reason === 'smtp-unreachable'
  && Array.isArray(mailSnap.attempts) && mailSnap.attempts.length >= 1
  && !mailPage.text.includes('<script'),
  `status=${mailPage.status}/${mailApi.status} counts=${JSON.stringify(mailSnap.counts)} `
  + `smtp=${JSON.stringify(mailSnap.smtp)} last=${JSON.stringify(mailSnap.last_attempt)}`)

check('邮件域**负控**（私域与凭据不出这条路由）：快照里刻意混进的 `password` 与 `body`/`subject` 键'
  + '（键名白名单外）**读都不读**；带 `private:`/`signature` 的 next_action 被洗成 `(redacted)`；'
  + '哨兵串在整个响应体里出现次数为 0（反例：原样透传快照 → 凭据/正文经运维页外泄）',
  !mailPage.text.includes(MAIL_LEAK) && !mailApi.text.includes(MAIL_LEAK)
  && !mailApi.text.includes('"password"') && !mailApi.text.includes('"body"')
  && !mailApi.text.includes('private:') && mailApi.text.includes('(redacted)'),
  `哨兵在页面=${mailPage.text.includes(MAIL_LEAK)} 在 JSON=${mailApi.text.includes(MAIL_LEAK)} `
  + `JSON 含 password=${mailApi.text.includes('"password"')} 含 (redacted)=${mailApi.text.includes('(redacted)')}`)

// E4：第一屏三块（contractor / supplier）
const P02_BLOCKS = ['pending-approvals', 'in-progress', 'health']
const blockBad = []
const blockReport = []
for (const [name, page] of [['/contractor/', contractor], ['/supplier/', supplier]]) {
  const at = P02_BLOCKS.map((block) => page.text.indexOf(`data-block="${block}"`))
  const counts = P02_BLOCKS.map((block) => (page.text.match(new RegExp(`data-block="${block}"`, 'g')) || []).length)
  const ordered = at.every((index) => index >= 0) && at[0] < at[1] && at[1] < at[2]
  const single = counts.every((count) => count === 1)
  const asSection = P02_BLOCKS.every((block) => page.text.includes(`<section data-block="${block}">`))
  blockReport.push(`${name}: 位置=${JSON.stringify(at)} 出现次数=${JSON.stringify(counts)} 顺序正确=${ordered} 都是<section>=${asSection}`)
  if (!(ordered && single && asSection)) blockBad.push(name)
}
check('P0-2/E4 第一屏三个 `data-block` 锚点（pending-approvals → in-progress → health）**各一次、顺序正确**、'
  + '且都挂在 `<section>` 上（顺序错了 → 第一屏的顺序就错了）',
  blockBad.length === 0, blockReport.join('；'))

// E5：筛选非空转（同一参数下不同值 → 结果必须不同）
const evAll = await get('/contractor/events/')
const evQuote = await get('/contractor/events/?q=quote')
const evRfq = await get('/contractor/events/?q=rfq')
const rowsAll = rowsOf(evAll.text)
const rowsQuote = rowsOf(evQuote.text)
const rowsRfq = rowsOf(evRfq.text)
check('P0-3/E5 筛选**非空转**：`?q=quote` 与 `?q=rfq` 响应体不同、行集合不同，且都**严格小于**不带筛选的全量'
  + '（同一参数不同值必须给出不同结果，否则筛选只是装饰）',
  evAll.status === 200 && evQuote.status === 200 && evRfq.status === 200
  && evQuote.text !== evRfq.text
  && rowsQuote.length > 0 && rowsRfq.length > 0 && rowsQuote.join(',') !== rowsRfq.join(',')
  && rowsQuote.length < rowsAll.length && rowsRfq.length < rowsAll.length,
  `全量=${rowsAll.length} 行；q=quote→${rowsQuote.length} 行[${rowsQuote.join(',')}]；`
  + `q=rfq→${rowsRfq.length} 行[${rowsRfq.join(',')}]`)

// E6：空结果显式说明（两种空法都要说清楚：筛掉的和本来就没有的）
const evNone = await get('/contractor/events/?q=zzzz-no-such-thing')
const clrEmpty = await get('/supplier/clarifications/')   // 夹具里供应商侧没有任何 clarification/* 行
check('P0-3/E6 空结果**显式说明**（不是看起来像坏页面）：`?q=<无命中>` → 200 + `data-empty` + 0 行 + 文案点名「筛选无结果」；'
  + '数据源本来就没有的（夹具里 `/supplier/clarifications/`）→ 另一条文案「本子视图暂无数据」+ `data-empty-reason="no-rows"`'
  + '（两种空法不许混成一条、也不许留白）',
  evNone.status === 200 && rowsOf(evNone.text).length === 0
  && evNone.text.includes('data-empty="1"') && evNone.text.includes('data-empty-reason="no-match"')
  && evNone.text.includes('筛选无结果')
  && clrEmpty.status === 200 && rowsOf(clrEmpty.text).length === 0
  && clrEmpty.text.includes('data-empty="1"') && clrEmpty.text.includes('data-empty-reason="no-rows"')
  && clrEmpty.text.includes('本子视图暂无数据'),
  `无命中：status=${evNone.status} 行数=${rowsOf(evNone.text).length} 含「筛选无结果」=${evNone.text.includes('筛选无结果')}；`
  + `本来没有：status=${clrEmpty.status} 行数=${rowsOf(clrEmpty.text).length} `
  + `含「本子视图暂无数据」=${clrEmpty.text.includes('本子视图暂无数据')}`)

// E7 / E7b：分页不重叠 + 不丢行
const pageOne = await get('/contractor/events/?limit=2&page=1')
const pageTwo = await get('/contractor/events/?limit=2&page=2')
const r1 = rowsOf(pageOne.text)
const r2 = rowsOf(pageTwo.text)
const overlap = r1.filter((key) => r2.includes(key))
check('P0-3/E7 分页**不重叠**：`?limit=2&page=1` 与 `?limit=2&page=2` 的行集合**交集为空**，且各 2 行',
  pageOne.status === 200 && pageTwo.status === 200 && r1.length === 2 && r2.length === 2 && overlap.length === 0,
  `page1=[${r1.join(',')}] page2=[${r2.join(',')}] 交集=[${overlap.join(',')}]`)
const walked = []
for (let page = 1; page <= Math.max(1, Math.ceil(rowsAll.length / 2)); page += 1) {
  const res = await get(`/contractor/events/?limit=2&page=${page}`)
  walked.push(...rowsOf(res.text))
}
const duplicated = walked.filter((key, index) => walked.indexOf(key) !== index)
check('P0-3/E7b 分页**不丢行**：逐页（limit=2）取回的行**并集 == 全量行集合**，且跨页无重复'
  + '（自证：同一夹具的同一账本投影）',
  duplicated.length === 0 && walked.length === rowsAll.length && rowsAll.length >= 4
  && JSON.stringify([...walked].sort()) === JSON.stringify([...rowsAll].sort()),
  `逐页取回 ${walked.length} 行 / 全量 ${rowsAll.length} 行；重复=[${duplicated.join(',')}]；`
  + `并集=[${[...walked].sort().join(',')}]`)

// E8：applied 回显（夹取后的真值）
const clamped = await get('/contractor/events/?limit=99999&sort=DROP&page=-1')
const clampedApplied = appliedOf(clamped.text)
check('P0-3/E8 `applied` 回显存在且是**夹取后的真值**：limit 99999→200、sort DROP→desc、page -1→1，'
  + '夹取过程也在页面上报清（请求值原样出现，便于人工核对）',
  clamped.status === 200 && clampedApplied.includes('limit=200') && !clampedApplied.includes('99999')
  && clampedApplied.includes('sort=desc') && clampedApplied.includes('page=1')
  && clamped.text.includes('99999') && clamped.text.includes('DROP'),
  `applied=「${clampedApplied}」；夹取说明里含原值=${clamped.text.includes('99999')}/${clamped.text.includes('DROP')}`)
const negLimit = await get('/contractor/events/?limit=-1')
check('P0-3/E8b 非法/越界 `limit` 夹取到**默认 20** 并在 applied 回显（`limit=-1`）',
  negLimit.status === 200 && appliedOf(negLimit.text).includes('limit=20'),
  `applied=「${appliedOf(negLimit.text)}」`)

// E9：排序非空转
const ascPage = await get('/contractor/events/?sort=asc')
const descPage = await get('/contractor/events/?sort=desc')
const ascRows = rowsOf(ascPage.text)
const descRows = rowsOf(descPage.text)
check('P0-3/E9 排序**非空转**：`sort=asc` 与 `sort=desc` 的**行集合相同、行序不同**（响应体也不同）',
  ascPage.status === 200 && descPage.status === 200
  && [...ascRows].sort().join(',') === [...descRows].sort().join(',')
  && ascRows.join(',') !== descRows.join(',') && ascPage.text !== descPage.text,
  `asc=[${ascRows.join(',')}] desc=[${descRows.join(',')}]`)

// E10：私域哨兵负控（子视图页面）+ 非空转对照
const P02_SENTINELS = ['cost_floor', 'markup_pct', 'calendar:private', 'bidders_private', 'private:',
  'reserve_price', 'cost_model']
const supplierSubPages = Object.entries(subPages).filter(([path]) => path.startsWith('/supplier/'))
const leaks = []
for (const [path, res] of supplierSubPages) {
  for (const needle of P02_SENTINELS) if (res.text.includes(needle)) leaks.push(`${path}:${needle}`)
}
check('P0-3/E10 私域**负控**：供应商侧四个子视图页面里搜不到私域哨兵（' + P02_SENTINELS.join(' / ') + '）；'
  + '**非空转对照**：同一批数据在承包商侧子视图里可见（证明源里确实有，不是\"什么都没有\"）',
  leaks.length === 0 && evAll.text.includes('cost_floor'),
  `供应商侧命中=${leaks.join(',') || '无'}；承包商 /contractor/events/ 含 cost_floor=${evAll.text.includes('cost_floor')}`)

// E11：既有 JSON 路由字节不变（夹具内确定性路由）
const FROZEN_SHA = {
  '/api/health': 'd7cc1159637ab26f7a24ab32ad9474578573afbc50e8a4eebd84a24e3c867f7b',
  '/api/status': '6aee6ecf98d18b6a882d476b3c3d72d9c3ab19f229496fb49984a4ee74ee721f',
  '/api/pipeline': '52b5553c4a5741610e24d61d83431c91bcb88913fc9b22aed3b2c512108c0d7c',
  '/contractor/api/events': '8e109436cd6f47bc5ad0bbd63f71dabac13f60e5264739f95af121fcee30de81',
  '/supplier/api/events': '978e49abb74f5ec6cf60309a89eca654cd99599a17bf11976361919b7fc894bd',
  '/contractor/api/evidence': 'e7eeade9618a5ba45da8bc354c33456e651d55b9a28b37991abc7da36b7601fc',
  '/supplier/api/evidence': '8e964775bdeb98deb6c53f3be68fae4785e9c2e0b8ec1ab0cbeb3164dd79f60e',
  '/contractor/api/history': 'c8397ff6d8da31273c651548194208547c9e87ac7b75d05bbb68647c2112c1f5',
  '/supplier/api/history': '8342f5f75053785932f73c390939d5f84419e344420b063476a11e829b4aec5d',
  '/contractor/api/approvals': 'da2ea5cb5652504479b1c0fbed466692f21a98f7ecfc9145f1c81eef420497ec',
  '/supplier/api/approvals': '5763b641e0e31cdd6858ba4387510b71c6495c03e9f1c027095ff295a2bb3643',
  '/contractor/api/scorecard': 'b061b79e2d401af5b8734d25ac6302482893c8aba19e3ce0d16ecbb8cc5896a0',
  '/supplier/api/scorecard': 'f90d113b23d85998299fb193d82667c2e1af357da042d2c6e6e68de2b56cfe17',
  '/contractor/api/negotiation': 'eee3b89df35d4d64f3c720e38f199de6c6b79a7892e819ca0059e6652fefddbf',
  '/supplier/api/negotiation': 'a92cbdb36ff13fb04ae99ee42b6ad85fc9d3c5fbb7b27a47867ee4437386d7b2',
  '/contractor/api/faq': '8368207200a683e3a80dbac63b6a3535306430b33e8517fd166f15cfe4395675',
  '/supplier/api/faq': '42bd0dfaec4ed5a77f1df50b9ee1753025d16ea254f760b70f8f6d053de98053',
}
const byteBad = []
const byteSeen = []
for (const [path, want] of Object.entries(FROZEN_SHA)) {
  const res = await getBytes(path)
  const got = sha256(res.buf)
  byteSeen.push(`${path}=${got}`)
  if (res.status !== 200 || got !== want) byteBad.push(`${path}(status=${res.status} sha256=${got})`)
}
check('P0-2/E11 既有 JSON 路由**字节不变**（' + Object.keys(FROZEN_SHA).length
  + ' 条夹具内确定性路由，逐字节 sha256 比对；基线取自**改动前**的同一夹具运行）',
  byteBad.length === 0,
  byteBad.length ? `不一致=${byteBad.join(' ')}` : `全部逐字节一致：${byteSeen.join(' ')}`)

// E12：非确定三条（内含实时计数 / 读 Python 侧快照文件）→ 不比字节，比**顶层键集**
const FROZEN_KEYS = {
  '/api/retention': ['source', 'retention', 'headline', 'note'],
  '/api/obs': ['service', 'observability', 'summary'],
  '/api/ops': ['view', 'source', 'summary', 'runtime', 'breaker', 'evidence_by_view', 'evolve_journal',
    'retention', 'retention_headline', 'note'],
}
const keyBad = []
for (const [path, keys] of Object.entries(FROZEN_KEYS)) {
  const res = await get(path)
  let body = {}
  try { body = JSON.parse(res.text) } catch (err) { body = {} }
  const got = Object.keys(body).sort().join(',')
  if (res.status !== 200 || got !== [...keys].sort().join(',')) keyBad.push(`${path}(status=${res.status} keys=${got})`)
}
check('P0-2/E12 三条**不可逐字节比对**的路由（内含实时请求计数 / 读 Python 侧写的快照）**顶层键集不变**：'
  + Object.keys(FROZEN_KEYS).join(' · ') + '（字节不变在 E11 里证；这三条用键集防守，避免门自己变成 flaky）',
  keyBad.length === 0, keyBad.join(' ') || `键集一致：${Object.keys(FROZEN_KEYS).join(' ')}`)

// E13：四道页面的道内子导航 + 上手入口
const navBad = []
for (const [name, view, page] of [['/', null, homePage], ['/contractor/', 'contractor', contractor],
  ['/supplier/', 'supplier', supplier], ['/ops/', 'ops', opsPage], ['/admin/', 'admin', { status: adminPage.status, text: adminText }]]) {
  const subOk = view === null || page.text.includes(`data-subnav="${view}"`)
  const startOk = page.text.includes('/quotagent/start/') && page.text.includes('上手')
  if (!(subOk && startOk)) navBad.push(`${name}(子导航=${subOk} 上手入口=${startOk})`)
}
check('P0-2/E13 四道页面都有**道内导航**（`data-subnav`：能回该道其它子视图 + 首页），'
  + '且「上手（token／配置放哪里？）」入口一处不少（总览页只需保留上手入口）',
  navBad.length === 0, `不达标=${navBad.join(',') || '无'}`)

// E14：从 dashboard 到达不变
check('P0-2/E14 从现有 dashboard 到达**不变**：总览页仍含四道链接（含运维视角）',
  homePage.status === 200 && ['contractor', 'supplier', 'ops']
    .every((view) => homePage.text.includes(`/quotagent/${view}/`)),
  `status=${homePage.status} 含运维视角=${homePage.text.includes('/quotagent/ops/')}`)

// ---- P0 配置与凭据（E15–E18 形态）：未提权同形 / 页面 0 script / 干跑零落盘 / 提交只落 0600 待处理项 ----
const CFG_READ = ['/admin/config/', '/admin/api/config', '/admin/api/credentials', '/admin/api/config/audit']
const cfgUnauth = []
for (const target of CFG_READ) {
  const res = await fetch(`${base}${target}`)
  cfgUnauth.push({ path: target, status: res.status, body: await res.text() })
}
for (const target of ['/admin/api/config/preview', '/admin/api/config/project',
  '/admin/api/config/plugins', '/admin/api/credentials/mail_smtp']) {
  const res = await fetch(`${base}${target}`, { method: 'POST', body: 'key=pricing.markup_pct&value=1' })
  cfgUnauth.push({ path: target, status: res.status, body: await res.text() })
}
const cfgUnauthBody = '{"error":"unauthorized"}'
check('P0-config/E15 配置与凭据的**四个读端点 + 四个写端点**未提权一律 401 且 body 逐字节等于固定体'
  + '（同形：不区分"路由不存在/缺 token/未启用"，不给 oracle）',
  cfgUnauth.every((item) => item.status === 401 && item.body === cfgUnauthBody),
  cfgUnauth.map((item) => `${item.path}=${item.status}`).join(' ')
  + `；body 去重=${[...new Set(cfgUnauth.map((item) => item.body))].length} 种`)

const cfgPageRes = await fetch(`${base}/admin/config/`, { headers: { cookie: adminCookie } })
const cfgPageText = await cfgPageRes.text()
const cfgApiRes = await fetch(`${base}/admin/api/config`, { headers: { cookie: adminCookie } })
const cfgApi = JSON.parse(await cfgApiRes.text())
const cfgProjectRow = (cfgApi.project || []).find((row) => row.key === 'pricing.markup_pct') || {}
const cfgCredRow = (cfgApi.credentials || []).find((row) => row.name === 'mail_smtp') || {}
check('P0-config/E16 配置与凭据页（提权后）**200 且 0 行 `<script>` / 0 内联事件**；一屏含三层'
  + '（`data-layer="project"` / `"plugin"` / `"credential"`）+ `source` / `shadowed_by` / `editable`；'
  + 'JSON 总览里每键给 source/shadowed_by/editable，凭据行给 required_mode 与 next_action 且**没有值字段**',
  cfgPageRes.status === 200 && !cfgPageText.includes('<script') && !INLINE_EVENT.test(cfgPageText)
  && cfgPageText.includes('data-layer="project"') && cfgPageText.includes('data-layer="credential"')
  && cfgApiRes.status === 200 && cfgApi.layers?.join(',') === 'project,plugin,credential'
  && typeof cfgProjectRow.source === 'string' && ['default', 'file', 'env', 'runtime'].includes(cfgProjectRow.source)
  && cfgProjectRow.shadowed_by !== undefined && typeof cfgProjectRow.editable === 'boolean'
  && cfgCredRow.required_mode === '0600' && typeof cfgCredRow.next_action === 'string'
  && cfgCredRow.next_action.length > 0 && cfgCredRow.value === undefined && cfgCredRow.value_present === false,
  `page=${cfgPageRes.status} 长度=${cfgPageText.length}；JSON project 行 source=${cfgProjectRow.source} `
  + `值=${cfgProjectRow.value} shadowed_by=${JSON.stringify(cfgProjectRow.shadowed_by)} editable=${cfgProjectRow.editable}；`
  + `凭据 mail_smtp configured=${cfgCredRow.configured} required_mode=${cfgCredRow.required_mode} `
  + `有 value 字段=${Object.prototype.hasOwnProperty.call(cfgCredRow, 'value')}`)

// 干跑：白名单拒 + **夹具配置文件字节零变化**（零落盘）
const cfgBefore = sha256(Buffer.from(cvConfigRaw))
const previewBad = await fetch(`${base}/admin/api/config/preview`, { method: 'POST', headers: { cookie: adminCookie,
  'content-type': 'application/json' }, body: JSON.stringify({ layer: 'project', target: 'project', fields: { 'nope.key': 1 } }) })
const previewBadJson = JSON.parse(await previewBad.text())
const previewFrozen = await fetch(`${base}/admin/api/config/preview`, { method: 'POST', headers: { cookie: adminCookie,
  'content-type': 'application/json' }, body: JSON.stringify({ layer: 'project', target: 'project', fields: { 'kernel.x': 1 } }) })
const previewFrozenJson = JSON.parse(await previewFrozen.text())
const previewOk = await fetch(`${base}/admin/api/config/preview`, { method: 'POST', headers: { cookie: adminCookie,
  'content-type': 'application/json' }, body: JSON.stringify({ layer: 'project', target: 'project', fields: { 'pricing.markup_pct': 12.5 } }) })
const previewOkJson = JSON.parse(await previewOk.text())
const cfgAfter = sha256(Buffer.from(cvConfigRaw))
check('P0-config/E17 干跑（`preview`）**零落盘零生效**：未知键 → 拒（reasons 含 `unknown-key`）；`kernel.*` → 拒'
  + '（`vetoed_by=frozen`）；合法键 → 出 diff（含 old/new 与两个摘要）；三种情况下**夹具配置文件字节零变化**'
  + '（本门另有一条断言：真 `/workspace/config.yaml` 在本门全程字节不变）',
  previewBad.status === 200 && previewBadJson.accepted === false
  && (previewBadJson.reasons || []).some((item) => item.code === 'unknown-key')
  && previewFrozenJson.vetoed_by === 'frozen'
  && previewOkJson.accepted === true && (previewOkJson.diff || []).length === 1
  && previewOkJson.diff[0].old !== undefined && previewOkJson.diff[0].new === 12.5
  && previewOkJson.diff[0].new_digest !== previewOkJson.diff[0].old_digest
  && cfgBefore === cfgAfter,
  `unknown=${previewBad.status}/${previewBadJson.accepted} frozen=${previewFrozenJson.vetoed_by} `
  + `ok=${previewOkJson.accepted}/diff=${(previewOkJson.diff || []).length} 文件字节不变=${cfgBefore === cfgAfter}`)

// 提交：202 + payload_sha256 + next_action；只落 0600 待处理项（落在夹具 inbox，账本零新增在 config-route 门细验）
const submitProject = await fetch(`${base}/admin/api/config/project`, { method: 'POST', headers: { cookie: adminCookie,
  'content-type': 'application/json' }, body: JSON.stringify({ fields: { 'pricing.markup_pct': 12.5 } }) })
const submitJson = JSON.parse(await submitProject.text())
const cfgInboxDir = join(cvFixtureDir, 'config-submissions')
const pendingFiles = existsSync(cfgInboxDir) ? readdirSync(cfgInboxDir).filter((name) => name.endsWith('.json')) : []
const pendingModes = pendingFiles.map((name) => (statSync(join(cfgInboxDir, name)).mode & 0o777).toString(8))
check('P0-config/E18 提交项目配置 → **202** + `payload_sha256`（64 位小写 hex）+ `next_action`（说明"宿主不写文件不写账本"）；'
  + '宿主只落 **0600** 待处理项（目录 0700），且**干跑提到的键值不上盘**（配置文件字节仍不变）',
  submitProject.status === 202 && typeof submitJson.payload_sha256 === 'string'
  && /^[0-9a-f]{64}$/.test(submitJson.payload_sha256) && String(submitJson.next_action).includes('config-apply.py')
  && pendingFiles.length === 1 && pendingModes.every((mode) => mode === '600')
  && sha256(Buffer.from(cvConfigRaw)) === cfgAfter,
  `status=${submitProject.status} payload_sha256=${String(submitJson.payload_sha256).slice(0, 16)}… `
  + `待处理项=${pendingFiles.join(',')} 权限=${pendingModes.join(',')} 配置文件字节不变=${sha256(Buffer.from(cvConfigRaw)) === cfgAfter}`)


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

// P0-config/E19 真配置文件在你的机器上**字节不变**（宿主只读 + 门自己也不动它）：这是"别把用户配置弄丢"的机检形态
const realConfigAfter = existsSync(REAL_CONFIG_PATH) ? realHash(REAL_CONFIG_PATH) : null
check('P0-config/E19 真实 `/workspace/config.yaml` 在本门全程**字节不变**（宿主配置面只读；门用夹具文件而不是它）',
  realConfigAfter === realConfigBefore,
  `before=${String(realConfigBefore).slice(0, 16)}… after=${String(realConfigAfter).slice(0, 16)}… 存在=${existsSync(REAL_CONFIG_PATH)}`)

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
