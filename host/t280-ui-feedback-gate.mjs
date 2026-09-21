/**
 * t280-ui-feedback-gate —— WebUI 反馈闭环（`ui-feedback` 插件）的**围栏门**（宿主侧人工维护，不由被围对象自己写）。
 *
 * 被围对象：`host/modules/ui-feedback.mjs`（provides `uiFeedback`）+ 它在 `webui` 里的三条路由
 * （`GET/POST /<prefix>/<view>/feedback`、`GET /<prefix>/ops/ui-feedback/`、`GET /<prefix>/api/ui-feedback`）
 * 与**服务端可判**的"请刷新"横幅（每页 `data-ui-revision`）。
 *
 * 断言（22 条，每条都写清"什么情况下必须变红"）：
 *   1. 契约正控：manifest 齐备（name/inject/provides/Config/usedServices）+ 源码里 **0 个脚本字面量**
 *   2. 零写面负控：写文件/账本/子进程/网络/墙钟/随机/定时器逐类断言（含扫描器**非空转对照**）
 *   3. 版本事实正控：`versions.json` 缺失 → 全视图 `r0`；写入后**按落盘事实**读出来（不凭空递增）
 *   4. 提交正控：原话**逐字**留在 0600 待办件里（`text` 逐字节相等 + sha256/bytes 自查一致）
 *   5. 提交负控：待办件权限**恰为 0600**；**账本零新增**（目录里没有账本文件、文件数只多这一条）
 *   6. 负控：拒绝路径给**具体 code + next_action**（空正文/超长/未知视图），code 在闭合集合里
 *   7. 观察面：待处理计数 / 最近一次处理结果与 reason / 各视图版本号 / available / degraded+reason
 *   8. 负控：`degraded` **有名 reason**（缺失与损坏是**两个**不同的 reason）且正常时 `degraded:false`
 *   9. 负控：观察面**确定性**（两次 GET 逐字节一致、snapshot 两次一致）且**有界**（omitted 报数）
 *  10. 负控：观察面**不出反馈正文**（正文只在 0600 待办件里）
 *  11-14. **真 HTTP**（in-process 挂载真 `webui` + 真依赖模块 + 夹具账本）：
 *      反馈页 200/含 textarea+POST 表单、提交 202、提交后 ops 计数 **+1**、
 *      横幅**两个方向**（版本不同⇒有 `data-ui-stale="true"` 与"已更新到 rM，请刷新页面"；版本相同⇒**不得**出现）、
 *      `?seen=rM` 后横幅消失、页面**仍 0 行脚本 / 0 内联事件**、未知视图 404
 *  15-19. **单点变异**：4 处变异各自必须让**指定的**断言变红（且变异必须真的改了字节），
 *      全程 `host/modules/ui-feedback.mjs` 字节不变（变异只写在临时目录的副本里）
 *  20-22. 防假变异自检 + 还原字节一致 + 空集合守卫
 *
 * 输出：**一行** JSON `{"checks":[{name,ok,detail}],"passed":N,"total":N,"failures":N}`；全绿 exit 0。
 * 用法：`node host/t280-ui-feedback-gate.mjs`（cwd 无关：路径都由 import.meta.url 推出）。
 */
import { Context, EventsService } from 'cordis'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, 'modules', 'ui-feedback.mjs')
const SCHEMA_URL = pathToFileURL(join(HERE, 'lib', 'std-schema.mjs')).href

const CHECKS = []
const check = (name, ok, detail = '') => { CHECKS.push({ name, ok: Boolean(ok), detail }) }
const finish = () => {
  // 空集合守卫：一条断言都没跑 = 红的（"没跑到"不得当成"通过"）
  if (CHECKS.length === 0) check('空集合守卫：门至少跑了一条断言', false, 'CHECKS 为空')
  const failures = CHECKS.filter((item) => !item.ok).length
  writeSync(1, JSON.stringify({ checks: CHECKS, passed: CHECKS.length - failures, total: CHECKS.length, failures }) + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

// 解析钩子：变异体在**临时目录**里跑，也要解析到同一个 `../lib/std-schema.mjs`（无双实例）
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
const mod = await import(pathToFileURL(TARGET).href)

const SCRIPT_NEEDLE = '<scr' + 'ipt'
const INLINE_EVENT = /\son[a-z]+\s*=/i
const modeOf = (path) => statSync(path).mode & 0o777

/** 挂载：照抄产物声明的 `inject`，包装 `provide` 抓句柄。`ui_shared` 一律指向**夹具临时目录**。 */
const mountWith = async (file, raw = {}) => {
  const loaded = file === TARGET ? mod : await import(`${pathToFileURL(file).href}?v=${sha256(sourceOf(file)).slice(0, 8)}`)
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = { handle: null }
  await ctx.plugin({
    name: `${loaded.name}#t280`,
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
  return { ctx, box, loaded }
}

/** 单点变异：找不到/多于一处的"变异"是**假变异**（返回 null，调用方必须判红）。 */
const applyMutation = (text, find, replace) => {
  const count = text.split(find).length - 1
  if (count !== 1 || find === replace || !replace) return null
  return text.replace(find, replace)
}

const tmpRoot = mkdtempSync(join(tmpdir(), 't280-'))
let fixtureSeq = 0
/** 每个场景一个新夹具目录：`<dir>/ui-shared/ui-feedback/`（版本事实与待办件都在这里）。 */
const freshFixture = () => {
  fixtureSeq += 1
  const dir = join(tmpRoot, `fx-${fixtureSeq}`)
  mkdirSync(join(dir, 'ui-feedback'), { recursive: true })
  return { dir, feedbackDir: join(dir, 'ui-feedback'), versions: join(dir, 'ui-feedback', 'versions.json') }
}
const writeVersions = (fx, payload) => writeFileSync(fx.versions,
  JSON.stringify(payload, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
const versionsFor = (pairs) => ({
  schema: 1, generated_at: '2026-09-21T19:00:00Z',
  views: Object.fromEntries(Object.entries(pairs).map(([view, revision]) => [view, {
    revision, artifact_sha256: revision === 'r0' ? '' : `sha256:${'a'.repeat(64)}`,
    applied_at: revision === 'r0' ? '' : '2026-09-21T19:00:00Z' }])),
  latest: { revision: 'r0', view: '' }, applied: [], counts: { applied: 0 }, note: '门夹具',
})
const VERSIONS_OF = (fx) => { try { return JSON.parse(readFileSync(fx.versions, 'utf8')) } catch { return null } }

const TEXT = '报价表里看不到交期，得来回翻页。\n第二行：希望按交期排序（带换行与全角标点）🙂'
const viewDirEntries = (fx) => {
  try { return readdirSync(fx.feedbackDir).sort() } catch { return [] }
}
const pendingFiles = (fx) => viewDirEntries(fx).filter((name) => name.startsWith('fb-') && name.endsWith('.json'))
const versionsSnapshot = (fx, handle, limitOverride = null) => {
  const snap = handle.snapshot()
  return limitOverride === null ? snap : { ...snap, queue: { ...snap.queue, limit: limitOverride } }
}

/**
 * 场景事实（**变异体会被逐条重跑这些场景**）：每个键就是一处可被单点变异打红的事实。
 * 只依赖句柄（不涉 HTTP），因此可以挂很多次也不慢。
 */
const scenarioFacts = async (handle, fx) => {
  const out = {}
  // ① 版本事实只从落盘读：没有 versions.json → r0
  out['revision-from-disk'] = handle.revisionOf('contractor') === 'r0' && handle.latestOf().number === 0
  writeVersions(fx, versionsFor({ contractor: 'r2', supplier: 'r1' }))
  out['revision-from-disk'] = out['revision-from-disk']
    && handle.revisionOf('contractor') === 'r2' && handle.revisionOf('supplier') === 'r1'
    && handle.latestOf().revision === 'r2'
  // ② 横幅：版本不同 ⇒ 有（含文案与 GET 表单）；版本相同 ⇒ 无
  const staleSupplier = handle.decorate('/supplier/', '')
  const freshContractor = handle.decorate('/contractor/', '')
  out['stale-banner'] = staleSupplier.stale === true
    && staleSupplier.banner.includes('data-ui-stale="true"')
    && staleSupplier.banner.includes('已更新到 r2，请刷新页面')
    && staleSupplier.banner.includes('<form method="get"') && staleSupplier.banner.includes('name="seen"')
    && staleSupplier.banner.includes('我已刷新')
    && freshContractor.stale === false && freshContractor.banner === ''
    && freshContractor.revision === 'r2'
  // ③ 版本相同 ⇒ 不得出现横幅（另一个方向）
  writeVersions(fx, versionsFor({ contractor: 'r2', supplier: 'r2' }))
  const sameSupplier = handle.decorate('/supplier/', '')
  out['same-version-no-banner'] = sameSupplier.stale === false && sameSupplier.banner === ''
    && sameSupplier.revision === 'r2'
  // ④ `?seen=rM` ⇒ 横幅消失（服务端可判，不靠 JS）
  writeVersions(fx, versionsFor({ contractor: 'r3', supplier: 'r2' }))
  out['seen-hides-banner'] = handle.decorate('/supplier/', 'r3').stale === false
    && handle.decorate('/supplier/', 'r2').stale === true
  // ⑤ 提交：原话逐字 + 0600 + 版本号不因提交而变
  const before = handle.revisionOf('contractor')
  const submitted = handle.submitFeedback('contractor', TEXT)
  out['submit-accepted'] = submitted.ok === true && submitted.bytes === Buffer.byteLength(TEXT, 'utf8')
    && /^fb-contractor-[0-9a-f]{12}$/.test(String(submitted.id))
    && String(submitted.next_action).includes('ui-feedback-apply.py') && handle.revisionOf('contractor') === before
  const file = join(fx.feedbackDir, `${submitted.id}.json`)
  let record = null
  try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { record = null }
  out['verbatim-and-0600'] = record !== null && record.text === TEXT
    && record.text_sha256 === `sha256:${sha256(TEXT)}` && record.bytes === Buffer.byteLength(TEXT, 'utf8')
    && record.view === 'contractor' && record.submitted_at === ''
    && modeOf(file) === 0o600
  // ⑥ 拒绝路径：具体 code + next_action
  const empty = handle.submitFeedback('contractor', '   ')
  const unknown = handle.submitFeedback('ghost', 'x')
  const long = handle.submitFeedback('contractor', 'x'.repeat(5000))
  const codes = mod.SUBMISSION_CODES
  out['refusal-codes'] = empty.code === 'empty-feedback' && unknown.code === 'view-unknown'
    && long.code === 'feedback-too-long' && ![empty, unknown, long].some((item) => item.ok === true)
    && [empty, unknown, long].every((item) => typeof item.next_action === 'string' && item.next_action.length > 5
      && codes.includes(item.code))
  // ⑦ 有界：3 条待办件、上限 2 ⇒ 只列 2 条且 omitted=1
  writeFileSync(join(fx.feedbackDir, 'fb-contractor-00000000000a.json'), JSON.stringify({ schema: 1, kind: 'ui-feedback',
    view: 'contractor', text: 'a', text_sha256: `sha256:${sha256('a')}`, bytes: 1, submitted_at: '' }, null, 1))
  writeFileSync(join(fx.feedbackDir, 'fb-supplier-00000000000b.json'), JSON.stringify({ schema: 1, kind: 'ui-feedback',
    view: 'supplier', text: 'b', text_sha256: `sha256:${sha256('b')}`, bytes: 1, submitted_at: '' }, null, 1))
  const snap = handle.snapshot()
  out['bounded-omitted'] = snap.queue.pending === 3 && snap.queue.items.length === 2 && snap.queue.omitted === 1
    && snap.queue.limit === 2 && snap.bounded === true
  // ⑧ 观察面不出反馈正文
  out['no-body-leak'] = JSON.stringify(snap).includes(TEXT) === false
    && !handle.opsPage().includes(TEXT) && snap.privacy.feedback_bodies_included === false
  // ⑨ degraded 有名 reason（缺失 / 损坏 / 正常三种可分辨）
  const fxMissing = freshFixture()
  const missing = await mountWith(TARGET, { ui_shared: fxMissing.dir, views: ['contractor', 'supplier'], pending_limit: 2 })
  const missingSnap = missing.box.handle.snapshot()
  writeVersions(fxMissing, { schema: 1 })
  writeFileSync(fxMissing.versions, '{ 这不是 JSON', 'utf8')
  const corruptSnap = missing.box.handle.snapshot()
  const healthySnap = handle.snapshot()
  out['degraded-reasons'] = missingSnap.degraded === true && missingSnap.reason === 'versions-missing'
    && corruptSnap.degraded === true && corruptSnap.reason === 'versions-unreadable'
    && missingSnap.reason !== corruptSnap.reason
    && typeof missingSnap.next_action === 'string' && missingSnap.next_action.length > 10
    && mod.DEGRADED_REASONS.includes(missingSnap.reason) && mod.DEGRADED_REASONS.includes(corruptSnap.reason)
    && healthySnap.degraded === false && healthySnap.reason === null && healthySnap.available === true
  await missing.ctx.stop?.()
  return out
}

/** 变异体的场景事实：夹具**独立**（不能借用真产物的夹具状态）。 */
const mutantFacts = async (file) => {
  const fx = freshFixture()
  const mounted = await mountWith(file, { ui_shared: fx.dir, views: ['contractor', 'supplier'], pending_limit: 2 })
  const facts = await scenarioFacts(mounted.box.handle, fx)
  await mounted.ctx.stop?.()
  return facts
}

const SCENARIOS = ['revision-from-disk', 'stale-banner', 'same-version-no-banner', 'seen-hides-banner',
  'submit-accepted', 'verbatim-and-0600', 'refusal-codes', 'bounded-omitted', 'no-body-leak', 'degraded-reasons']

const MUTATIONS = [
  { name: 'M1 横幅属性翻转（data-ui-stale 写成 false）', mustRed: 'stale-banner',
    find: '<div data-ui-stale="true" style="', replace: '<div data-ui-stale="false" style="' },
  { name: 'M2 版本号不再读落盘事实（永远 r0）', mustRed: 'revision-from-disk',
    find: 'return typeof revision === \'string\' && /^r\\d+$/.test(revision) ? revision : REVISION_ZERO',
    replace: 'return REVISION_ZERO' },
  { name: 'M3 横幅判据放宽（版本相同也判落后）', mustRed: 'same-version-no-banner',
    find: '&& latest.number > revisionNumber(revision) && String(seen ?? \'\') !== latest.revision',
    replace: '&& latest.number >= revisionNumber(revision) && String(seen ?? \'\') !== latest.revision' },
  { name: 'M4 待办件权限放宽（0600 → 0644）', mustRed: 'verbatim-and-0600',
    find: 'chmodSync(tmp, 0o600)', replace: 'chmodSync(tmp, 0o644)' },
]

try {
  // ---------- 1. 契约正控（manifest + 零脚本字面量 + 写面白名单） ----------
  const manifestBad = []
  if (mod.name !== 'ui-feedback') manifestBad.push(`name=${mod.name}`)
  if (!Array.isArray(mod.provides) || !mod.provides.includes('uiFeedback')) manifestBad.push('provides')
  if (JSON.stringify(mod.usedServices) !== JSON.stringify(mod.inject)) manifestBad.push('usedServices≠inject')
  if (typeof mod.Config?.['~standard']?.validate !== 'function') manifestBad.push('Config')
  const importSpecs = [...originalSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  const importLeaks = importSpecs.filter((spec) => !spec.startsWith('node:') && !spec.startsWith('../lib/'))
  check('1 契约正控：manifest 齐备（name=ui-feedback / provides=uiFeedback / usedServices==inject / Config 实现 '
    + 'standard-schema）、只 import 内建与 `../lib/`，且源码里 **0 个脚本字面量**',
  manifestBad.length === 0 && importLeaks.length === 0 && !originalSource.includes(SCRIPT_NEEDLE) && hookReady,
  `manifest 问题=${manifestBad.join(',') || '无'}；越界 import=${importLeaks.join(',') || '无'}；`
  + `含脚本字面量=${originalSource.includes(SCRIPT_NEEDLE)}；解析钩子=${hookReady ? '已装' : '不可用'}；`
  + `字节=${Buffer.byteLength(originalSource)}`)

  // ---------- 2. 零写面负控（含扫描器非空转对照） ----------
  const FORBIDDEN = ['appendFileSync', 'createWriteStream', 'openLedger', 'ledger.jsonl', 'child_process',
    'spawn(', 'execFile', 'fetch(', 'Date.now', 'new Date', 'Math.random', 'setTimeout(', 'setInterval(',
    'process.env', 'readFile(', 'writeFile(']
  const scan = (text) => FORBIDDEN.filter((needle) => text.includes(needle))
  const writeHits = scan(originalSource)
  const selfTest = scan(`append${'FileSync'}(p, x); open${'Ledger'}(p); Date${'.now'}()`)
  const allowedWrites = ['writeFileSync', 'chmodSync', 'renameSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'statSync']
  check('2 零写面负控：产物**不写账本**（无 openLedger / ledger.jsonl）、不起子进程、不联网、不取墙钟、不取随机数；'
    + '写面只有待办件（写函数白名单：' + allowedWrites.join('/') + '），且扫描器**非空转**（对照样本必须命中）',
  writeHits.length === 0 && selfTest.length >= 3,
  `产物命中=${writeHits.join(',') || '无'}；对照样本命中=${selfTest.join(',') || '（空转！）'}`)

  // ---------- 3/4/5/6/7/8/9/10. 句柄级场景（真产物，夹具目录）----------
  const liveFx = freshFixture()
  const live = await mountWith(TARGET, { ui_shared: liveFx.dir, views: ['contractor', 'supplier'], pending_limit: 2 })
  const liveFacts = await scenarioFacts(live.box.handle, liveFx)
  check('3 版本事实正控：`versions.json` 缺失时全视图 `r0`；写入 r2/r1 后**按落盘事实**读出（宿主从不递增版本号）',
    liveFacts['revision-from-disk'],
    `夹具=${liveFx.versions}`)
  check('4 正控：提交后**原话逐字**留在待办件里（`text` 逐字节相等 + `text_sha256`/`bytes` 自查一致 + `submitted_at` 为空）'
    + '且提交**不改版本号**、`next_action` 明确指向唯一落账本者',
  liveFacts['submit-accepted'] && liveFacts['verbatim-and-0600'],
  `accepted=${liveFacts['submit-accepted']} 逐字+0600=${liveFacts['verbatim-and-0600']}`)
  check('5 负控：待办件权限**恰为 0600**（宿主只落这一条、不写账本、不动别的文件）',
    liveFacts['verbatim-and-0600'] && !viewDirEntries(liveFx).includes('ledger.jsonl'),
  `目录=${JSON.stringify(viewDirEntries(liveFx))}；待办件=${JSON.stringify(pendingFiles(liveFx))}`)
  check('6 负控：拒绝路径给**具体 code + next_action**（空正文 / 未知视图 / 超长各自一个码，且都在闭合集合里、'
    + '一律 `ok:false`）',
  liveFacts['refusal-codes'], `codes=${JSON.stringify(mod.SUBMISSION_CODES)}`)
  const opsText = live.box.handle.opsPage()
  check('7 正控：观察面齐备（待处理计数 / 最近一次处理结果与 reason / 各视图版本号 / available / degraded+reason）'
    + '—— 五个面在页面上都有可机检的落点，且**只读**（不提供任何提交口子）',
  opsText.includes('data-ui-feedback-pending=') && opsText.includes('最近一次处理结果')
  && opsText.includes('各视图版本号') && opsText.includes('data-ui-feedback="versions"')
  && (opsText.includes('data-ui-feedback="degraded"') || opsText.includes('data-ui-feedback="available"'))
  && !opsText.includes('<form method="post"'),
  `pending 标记=${opsText.includes('data-ui-feedback-pending=')} 最近一次=${opsText.includes('最近一次处理结果')} `
  + `版本表=${opsText.includes('data-ui-feedback="versions"')} 无 POST 口子=${!opsText.includes('<form method="post"')}`)
  check('8 负控：`degraded` **有名 reason** —— 事实缺失与事实损坏是**两个不同的 reason**，正常时 `degraded:false` '
    + '+ `reason:null` + `available:true`（不假装可用）',
  liveFacts['degraded-reasons'], `reason 闭合集合=${JSON.stringify(mod.DEGRADED_REASONS)}`)
  check('9 负控：观察面**有界**（3 条待办件 / 上限 2 → 只列 2 条、`omitted=1` 照实报数）',
    liveFacts['bounded-omitted'], `snapshot=${JSON.stringify(live.box.handle.snapshot().queue).slice(0, 200)}`)
  check('10 负控：观察面**不出反馈正文**（正文只留在 0600 待办件里；`privacy.feedback_bodies_included=false`）',
    liveFacts['no-body-leak'], `snapshot 含正文=${JSON.stringify(live.box.handle.snapshot()).includes(TEXT)}`)

  // ---------- 11-14. 真 HTTP（真 webui + 真依赖模块 + 夹具账本） ----------
  const HB_FIXTURE = [
    { seq: 1, type: 'rfq/published', correlation_id: 'pkg-1', ts: '2026-09-21T10:00:00Z',
      body: { package_id: 'pkg-1', rev: 1 } },
    { seq: 2, type: 'quote/submitted', correlation_id: 'q-1', ts: '2026-09-21T11:00:00Z',
      body: { quote_id: 'q-1', cost_floor: 70000, lines: [{ item_id: 'L-001', unit_price: 100 }] } },
  ]
  const httpLedger = {
    path: '/tmp/t280-fixture-ledger.jsonl',
    rows: () => HB_FIXTURE,
    verify: () => ({ ok: true, count: HB_FIXTURE.length, head: 'sha256:' + 'b'.repeat(64) }),
  }
  const httpFx = freshFixture()
  const httpCtx = new Context()
  await ctxPlugin(httpCtx)
  httpCtx.provide('ledgerView', httpLedger)
  const httpBox = {}
  const mountReal = async (file, raw, service, name) => {
    const loaded = await import(pathToFileURL(join(HERE, 'modules', file)).href)
    await httpCtx.plugin({
      name: `${name}#t280`,
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
  await mountReal('admin-guard.mjs', { token_env: 'QUOTAGENT_ADMIN_TOKEN_T280' }, 'adminGuard', 'admin-guard')
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
  await mountReal('ui-feedback.mjs', { route_prefix: '/t280', ui_shared: httpFx.dir,
    views: ['contractor', 'supplier'], pending_limit: 2 }, 'uiFeedback', 'ui-feedback')
  const projection = await import(pathToFileURL(join(HERE, 'modules', 'projection.mjs')).href)
  await httpCtx.plugin({ name: 'projection#t280', inject: [], Config: projection.Config,
    apply: (inner, config) => projection.apply(inner, config) }, projection.Config.parse({}))
  const webui = await import(pathToFileURL(join(HERE, 'modules', 'webui.mjs')).href)
  const httpFiber = await httpCtx.plugin({
    name: 'webui#t280',
    inject: webui.inject,
    Config: webui.Config,
    apply: async (inner, config) => {
      const originalProvide = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'webui') httpBox.webui = v; return originalProvide(s, v) }
      await webui.apply(inner, config)
    },
  }, webui.Config.parse({ port: 0, route_prefix: '/t280' }))
  const base = httpBox.webui.url.replace(/\/$/, '')
  const get = async (path) => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, text: await res.text() }
  }
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', body })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { status: res.status, text, json }
  }
  const pendingCountOf = (text) => {
    const match = /data-ui-feedback-pending="(\d+)"/.exec(text)
    return match ? Number(match[1]) : null
  }
  const listed = (fx) => viewDirEntries(fx)

  // 11. 反馈页 + 路由登记
  const feedbackPage = await get('/contractor/feedback')
  const routesRes = await get('/api/routes')
  let routeRows = []
  try { routeRows = JSON.parse(routesRes.text).routes ?? [] } catch { routeRows = [] }
  const feedbackRoutes = routeRows.filter((row) => String(row.path).endsWith('/feedback'))
  check('11 真 HTTP 正控：`/t280/<view>/feedback` 200 且是真 SSR 页面（`<textarea name="text"` + '
    + '`<form method="post"` 提交），路由表登记了反馈/观察面路由且 `auth` 全是 `none`',
  feedbackPage.status === 200 && feedbackPage.text.includes('<textarea name="text"')
  && feedbackPage.text.includes('<form method="post" action="/t280/contractor/feedback">')
  && feedbackPage.text.includes('data-ui-revision="r0"')
  && feedbackRoutes.length === 4 && feedbackRoutes.every((row) => row.auth === 'none')
  && feedbackRoutes.some((row) => row.method === 'POST')
  && routeRows.some((row) => String(row.path).endsWith('/ops/ui-feedback/') && row.auth === 'none')
  && routeRows.some((row) => String(row.path).endsWith('/api/ui-feedback') && row.auth === 'none'),
  `status=${feedbackPage.status}；路由命中=${JSON.stringify(feedbackRoutes.map((row) => `${row.method} ${row.path}`))}`)

  // 12. 提交 → 202 + id + next_action → 计数 +1 → 文件 0600
  const beforeFiles = listed(httpFx)
  const beforeOps = pendingCountOf((await get('/ops/ui-feedback/')).text)
  const submitted = await post('/contractor/feedback', `text=${encodeURIComponent(TEXT)}`)
  const afterOps = pendingCountOf((await get('/ops/ui-feedback/')).text)
  const afterFiles = listed(httpFx)
  const newFiles = afterFiles.filter((name) => !beforeFiles.includes(name))
  const json = submitted.json ?? {}
  const newFile = newFiles.length === 1 ? join(httpFx.feedbackDir, newFiles[0]) : ''
  let fileRecord = null
  try { fileRecord = JSON.parse(readFileSync(newFile, 'utf8')) } catch { fileRecord = null }
  check('12 真 HTTP 正控：`POST /t280/<view>/feedback` → **202** + 待办件 id + `next_action`；待办件**恰为 0600**、'
    + '原话逐字落盘、**账本零新增**（目录只多这一条、没有账本文件）、提交后观察面**待处理计数 +1**',
  submitted.status === 202 && json.ok === true && /^fb-contractor-[0-9a-f]{12}$/.test(String(json.id))
  && typeof json.next_action === 'string' && json.next_action.includes('ui-feedback-apply.py')
  && newFiles.length === 1 && fileRecord !== null && fileRecord.text === TEXT
  && fileRecord.text_sha256 === `sha256:${sha256(TEXT)}`
  && modeOf(newFile) === 0o600 && !afterFiles.includes('ledger.jsonl') && !afterFiles.includes('versions.json')
  && beforeOps === 0 && afterOps === 1,
  `status=${submitted.status} id=${json.id}；提交前计数=${beforeOps} → 提交后计数=${afterOps}；`
  + `新文件=${JSON.stringify(newFiles)} mode=${newFile ? modeOf(newFile).toString(8) : 'n/a'}；`
  + `目录=${JSON.stringify(afterFiles)}`)

  // 13. 横幅两个方向（真 HTTP）
  writeVersions(httpFx, versionsFor({ contractor: 'r2', supplier: 'r1' }))
  const stalePage = await get('/supplier/')
  const freshPage = await get('/contractor/')
  const staleOk = stalePage.text.includes('data-ui-stale="true"')
    && stalePage.text.includes('已更新到 r2，请刷新页面')
    && stalePage.text.includes('<form method="get" action="/t280/supplier/">')
    && stalePage.text.includes('name="seen" value="r2"') && stalePage.text.includes('我已刷新')
    && stalePage.text.includes('data-ui-revision="r1"')
  const freshOk = !freshPage.text.includes('data-ui-stale') && freshPage.text.includes('data-ui-revision="r2"')
  check('13 真 HTTP 负控/正控（**方向一**）：最新已应用版本 r2 > supplier 的 r1 ⇒ supplier 页顶部出现 '
    + '`data-ui-stale="true"` 横幅（含"已更新到 r2，请刷新页面"与 `<form method=get>` 的"我已刷新"）；'
    + '同一时刻 contractor 页（r2 == r2）**不得**出现横幅',
  stalePage.status === 200 && freshPage.status === 200 && staleOk && freshOk,
  `supplier 横幅=${staleOk} contractor 无横幅=${freshOk}；`
  + `banner 原文=${JSON.stringify(String(stalePage.text).slice(String(stalePage.text).indexOf('<body>') + 6, 
    String(stalePage.text).indexOf('<body>') + 260))}`)
  const seenPage = await get('/supplier/?seen=r2')
  check('13b 真 HTTP 负控：点"我已刷新"带上 `?seen=r2` ⇒ 横幅消失（**服务端可判，不靠 JS**）',
    seenPage.status === 200 && !seenPage.text.includes('data-ui-stale')
    && seenPage.text.includes('data-ui-revision="r1"'),
    `含横幅=${seenPage.text.includes('data-ui-stale')}`)

  writeVersions(httpFx, versionsFor({ contractor: 'r2', supplier: 'r2' }))
  const samePage = await get('/supplier/')
  check('14 真 HTTP 负控（**方向二**）：版本相同（r2 == r2）⇒ 供应商页**不得**出现横幅，但 `data-ui-revision` 照常写 r2',
    !samePage.text.includes('data-ui-stale') && samePage.text.includes('data-ui-revision="r2"'),
    `含横幅=${samePage.text.includes('data-ui-stale')} 版本=${(/"data-ui-revision="([^"]+)"/.exec(samePage.text) || [])[0]}`)

  // 15. 0 脚本 / 0 内联事件（含观察面与有横幅的页面）+ 观察面确定性 + 拒绝码 + 未知视图 404
  writeVersions(httpFx, versionsFor({ contractor: 'r2', supplier: 'r1' }))
  const versionsHashAtEnd = sha256(readFileSync(httpFx.versions, 'utf8'))
  const bannerPages = { feedback: (await get('/supplier/feedback')).text, ops: (await get('/ops/ui-feedback/')).text,
    stale: (await get('/supplier/')).text, overview: (await get('/supplier/')).text }
  const scripty = Object.entries(bannerPages).filter(([, text]) => text.includes(SCRIPT_NEEDLE) || INLINE_EVENT.test(text))
  const scriptSelfTest = (`<a onclick="x()"></a>`).includes(SCRIPT_NEEDLE) || INLINE_EVENT.test('<a onclick="x()"></a>')
  check('15 真 HTTP 负控：反馈页 / 观察面 / 带横幅的页面**都 0 行脚本 / 0 内联事件**（零 JS 是机检事实），'
    + '且扫描器非空转',
  scripty.length === 0 && scriptSelfTest
  && !bannerPages.ops.includes('onclick') && !bannerPages.stale.includes('onload'),
  `命中=${JSON.stringify(scripty.map(([name]) => name))}；扫描器对照=${scriptSelfTest}`)
  const opsFirst = await get('/ops/ui-feedback/')
  const opsSecond = await get('/ops/ui-feedback/')
  check('15b 真 HTTP 正控：观察面**确定性**（同输入两次 GET **逐字节一致**；`/api/ui-feedback` 也两次一致）',
    opsFirst.text === opsSecond.text && opsFirst.status === 200
    && (await get('/api/ui-feedback')).text === (await get('/api/ui-feedback')).text,
    `观测面两次一致=${opsFirst.text === opsSecond.text} 长度=${opsFirst.text.length}`)
  const emptyPost = await post('/contractor/feedback', 'text=')
  const longPost = await post('/contractor/feedback', `text=${'x'.repeat(5000)}`)
  const ghostPage = await get('/ghost/feedback')
  check('15c 真 HTTP 负控：空正文 → 400 `empty-feedback`、超长 → 400 `feedback-too-long`（都给 `next_action`）、'
    + '未知视图 `/ghost/feedback` → 404（不得静默当页面返回）',
  emptyPost.status === 400 && emptyPost.json?.code === 'empty-feedback' && Boolean(emptyPost.json?.next_action)
  && longPost.status === 400 && longPost.json?.code === 'feedback-too-long' && Boolean(longPost.json?.next_action)
  && ghostPage.status === 404,
  `empty=${emptyPost.status}/${emptyPost.json?.code} long=${longPost.status}/${longPost.json?.code} ghost=${ghostPage.status}`)

  // 16. 宿主零写面（HTTP 层）：反馈页面读来读去不改任何文件；只有提交那条 0600 待办件是新增
  const finalFiles = listed(httpFx)
  const finalVersionsHash = sha256(readFileSync(httpFx.versions, 'utf8'))
  check('16 负控：整轮 HTTP 跑完，`ui-shared/ui-feedback/` 里只有**提交落下的那一条 0600 待办件** + 门自己写的 '
    + '`versions.json`（宿主**从不写它**：跑完哈希与门写下的逐字节一致），没有账本文件 —— '
    + '宿主写面只有待办件，横幅的版本号读的是落盘事实',
  finalFiles.filter((name) => name.startsWith('fb-')).length === 1 && finalFiles.includes(newFiles[0])
  && !finalFiles.includes('ledger.jsonl') && finalVersionsHash === versionsHashAtEnd
  && modeOf(join(httpFx.feedbackDir, newFiles[0])) === 0o600,
  `目录=${JSON.stringify(finalFiles)}；host 待办件 mode=${modeOf(join(httpFx.feedbackDir, newFiles[0])).toString(8)}；`
  + `versions.json 未被宿主改写=${finalVersionsHash === versionsHashAtEnd}`)
  await httpFiber.dispose()

  // ---------- 17-19. 单点变异（4 处全部变红 + 防假变异 + 原文件字节不变） ----------
  const realAllTrue = SCENARIOS.every((name) => liveFacts[name] === true)
  check('17 变异前基线：十条场景在**真产物**上全真（否则变异变红说明不了任何事：基线本来就是红的）',
    realAllTrue, `基线=${JSON.stringify(liveFacts)}`)
  const mutationReport = []
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originalSource, mutation.find, mutation.replace)
    if (mutated === null) {
      mutationReport.push(`${mutation.name}→假变异（锚点不唯一或字节没变）`)
      check(`18 变异：${mutation.name}`, false, '假变异：找不到唯一锚点或字节没变')
      continue
    }
    const dir = mkdtempSync(join(tmpdir(), 't280-mut-'))
    const file = join(dir, `ui-feedback.mut-${sha256(mutated).slice(0, 8)}.mjs`)
    writeFileSync(file, mutated, 'utf8')
    const facts = await mutantFacts(file)
    const red = SCENARIOS.filter((name) => facts[name] === false)
    mutationReport.push(`${mutation.name} → 红=${red.join('/') || '（没有变红！）'}`)
    check(`18 变异：${mutation.name}`, red.includes(mutation.mustRed),
      `必须红的是「${mutation.mustRed}」；实际红=${red.join(',') || '无'}；字节已变=${mutated !== originalSource}；变异体=${file}`)
  }
  const fakeGuard = applyMutation(originalSource, '这一段源码里根本不存在-MUTATION-ANCHOR', 'x')
  const anchor = originalSource.includes('export const provides') ? 'export const provides' : 'export const name'
  const selfMutation = applyMutation(originalSource, anchor, anchor)
  check('19 防假变异（自检）：找不到唯一锚点的"变异"必须被判为**假变异**（返回 null）；把锚点替换成它自己也不算变异 '
    + '—— 否则"变异后门还绿"会被误读成"门很稳"',
  fakeGuard === null && selfMutation === null,
  `不存在的锚点→${fakeGuard === null ? '已判假变异' : '竟然通过'}；自我替换→${selfMutation === null ? '已判假变异' : '竟然通过'}`)

  // ---------- 20. 还原：本门全程没有写过产品树 ----------
  const afterHash = sha256(sourceOf(TARGET))
  check('20 还原：本门全程**没有写过产品树** —— `host/modules/ui-feedback.mjs` 跑完之后与跑之前**逐字节一致**'
    + '（变异只写在临时目录的副本里）',
  afterHash === originalHash && originalSource === sourceOf(TARGET),
  `sha256 前=${originalHash.slice(0, 16)}… 后=${afterHash.slice(0, 16)}…；变异小结=${mutationReport.join('；')}`)

  // ---------- 21. 空集合守卫：场景与断言都不许为空 ----------
  check('21 空集合守卫：场景表与断言表都非空（"没跑到"不得算通过）',
    SCENARIOS.length >= 10 && CHECKS.length >= 14,
    `场景 ${SCENARIOS.length} 条；断言 ${CHECKS.length} 条`)

  // ---------- 22. 版本事实与横幅不靠 JS：装饰是纯字符串（源码里没有前端求值口子） ----------
  check('22 负控：横幅/版本提示**全在服务端算好**（源码里没有 `eval(` / `Function(` / `innerHTML` / JSON 回填脚本），'
    + '`data-ui-revision` 与 `data-ui-stale` 都是服务端渲染的字面量',
  !['eval(', 'Function(', 'innerHTML'].some((needle) => originalSource.includes(needle)),
  `命中=${['eval(', 'Function(', 'innerHTML'].filter((needle) => originalSource.includes(needle)).join(',') || '无'}`)

  for (const fiber of [live]) {
    try { await fiber.ctx.stop?.() } catch { /* 卸载失败不影响断言结果 */ }
  }
} catch (err) {
  check('门执行异常（不得静默通过）', false, `${err.name}: ${String(err.message).slice(0, 300)}`)
}

finish()

/** cordis 的 EventsService 在门里统一挂一处（写成一个函数，避免重复 import 出错）。 */
async function ctxPlugin(ctx) {
  await ctx.plugin(EventsService)
  return ctx
}
