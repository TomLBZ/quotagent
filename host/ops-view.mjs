/**
 * ops-view 的围栏门（`tools/verify.sh ops-view`）：宿主侧**人工维护**，不由被围对象自己写（ADR-0016 / D-036）。
 *
 * 覆盖：
 *   1. 形状：运维快照含 runtime（governor/audit/canary）、breaker、evidence，且 sources 声明三源
 *   2. **组合而非自算**：runtime.governor 与来源 `observability` 的统计逐字段相等（不许自己另立口径）
 *   3. 输入即事实：`rows` 由调用方给 —— 给 2 行就报 2 行，空数组就报 0（**不编**）
 *   4. 只读无副作用：反复取快照/摘要不改变任何来源的统计
 *   5. 确定性：同状态两次快照**字节一致**（不用墙钟/随机）
 *   6. 不泄漏：快照里没有条目正文、没有私域键名（运维视角也是视角，同样受投影纪律约束）
 *   7. 降级：来源处于"有问题"状态（额度耗尽 / 熔断打开）时仍可读，并**如实**带出这些事实
 *   8. 零残留：不订阅事件/不注册定时器/不写文件（静态扫描）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { readFileSync } from 'node:fs'
import { apply as opsApply, Config as opsConfig } from './modules/ops-view.mjs'
import { apply as obsApply, Config as obsConfig } from './modules/observability.mjs'
import { apply as breakerApply, Config as breakerConfig } from './modules/circuit-breaker.mjs'
import { apply as evApply, Config as evConfig } from './modules/evidence-summary.mjs'
import { apply as governorApply, Config as governorConfig } from './modules/governor.mjs'
import { apply as auditApply, Config as auditConfig } from './modules/audit-hook.mjs'
import { apply as canaryApply, Config as canaryConfig } from './modules/canary.mjs'

const REALM = 'contractor:con-B'
const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

/** 挂六个来源 + ops-view（每个都用 provide 拦截拿句柄：根 ctx 看不到插件提供的服务） */
const mount = async () => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const mountOne = async (mod, cfg, service, key) => {
    await ctx.plugin({
      name: `${service}#probe`, inject: mod.inject ?? [], Config: mod.Config,
      apply: async (inner, c) => {
        const original = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) box[key] = v; return original(s, v) }
        await mod.apply(inner, c)
      },
    }, mod.Config.parse(cfg))
  }
  await mountOne({ apply: governorApply, Config: governorConfig, inject: [] }, { capacity: 4, key: 'ops' }, 'governor', 'governor')
  await mountOne({ apply: auditApply, Config: auditConfig, inject: [] }, { capacity: 8, realms: [REALM] }, 'audit', 'audit')
  await mountOne({ apply: canaryApply, Config: canaryConfig, inject: [] }, { weight_bps: 0, realms: [REALM] }, 'canary', 'canary')
  await mountOne({ apply: obsApply, Config: obsConfig, inject: ['governor', 'audit', 'canary'] }, {}, 'observability', 'obs')
  await mountOne({ apply: breakerApply, Config: breakerConfig, inject: [] }, { key: 'ops', failure_threshold: 2, cooldown_ms: 1000 }, 'breaker', 'breaker')
  await mountOne({ apply: evApply, Config: evConfig, inject: [] }, {}, 'evidenceSummary', 'evidence')
  const fiber = await ctx.plugin({
    name: 'ops-view#probe', inject: ['observability', 'breaker', 'evidenceSummary'], Config: opsConfig,
    apply: async (inner, c) => {
      const original = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'opsView') box.ops = v; return original(s, v) }
      await opsApply(inner, c)
    },
  }, opsConfig.parse({}))
  return { ctx, box, fiber }
}

const a = await mount()
const rows = [{ type: 'rfq/published', correlation_id: 'c-1', ts: '2026-09-21T00:00:00Z', refs: [] },
  { type: 'quote/submitted', correlation_id: 'c-1', ts: '2026-09-21T02:00:00Z', refs: ['ledger:1'] }]

// --- 1. 形状 ---
const snap = a.box.ops.snapshot({ rows })
check('形状正控：快照含 runtime（governor/audit/canary）+ breaker + evidence，并声明三源',
  snap.view === 'ops' && ['governor', 'audit', 'canary'].every((k) => k in snap.runtime)
  && typeof snap.breaker.stats.allowed === 'number' && typeof snap.evidence.rows === 'number'
  && snap.sources.join(',') === 'observability,breaker,evidenceSummary',
  `view=${snap.view} sources=${snap.sources.join(',')}`)

// --- 2. 组合而非自算 ---
const direct = a.box.obs.snapshot()
check('组合正控：runtime.governor 与来源 `observability` 的统计**逐字段相等**（不许自己另立口径）',
  JSON.stringify(snap.runtime.governor) === JSON.stringify(direct.governor.stats),
  `gov keys=${Object.keys(snap.runtime.governor).join('|')}`)

// --- 3. 输入即事实 ---
const zero = a.box.ops.snapshot({ rows: [] })
check('输入即事实：给 2 行报 2 行、给空数组报 0 行（**不编**，也不去别处捞数据）',
  snap.evidence.rows === 2 && snap.evidence.types === 2 && zero.evidence.rows === 0,
  `rows=${snap.evidence.rows}/${zero.evidence.rows} types=${snap.evidence.types}`)

// --- 4. 只读无副作用 ---
const before = JSON.stringify(a.box.obs.snapshot()) + JSON.stringify(a.box.breaker.stats())
a.box.ops.snapshot({ rows }); a.box.ops.summary({ rows })
const after = JSON.stringify(a.box.obs.snapshot()) + JSON.stringify(a.box.breaker.stats())
check('只读正控：反复取快照/摘要**不改变**任何来源的统计（观测无副作用）', before === after,
  `before==after=${before === after}`)

// --- 5. 确定性 ---
const s1 = JSON.stringify(a.box.ops.snapshot({ rows }))
const s2 = JSON.stringify(a.box.ops.snapshot({ rows }))
check('确定性正控：同状态两次快照**字节一致**（不使用墙钟/随机）', s1 === s2, `len=${s1.length} equal=${s1 === s2}`)

// --- 6. 不泄漏 ---
a.box.audit.record({ type: 'approval/granted', correlation_id: 'c-9', realm: REALM, source: 'decision',
  body: { note: '这里是正文', cost_floor: 123 } })
const leak = JSON.stringify(a.box.ops.snapshot({ rows: a.box.audit.decisions({ limit: 5 }) }))
check('泄漏负控：快照里**没有条目正文、没有私域键名**（运维视角同样受投影纪律约束）',
  !leak.includes('这里是正文') && !leak.includes('cost_floor') && !/"body"\s*:/.test(leak) && !/private:/i.test(leak),
  `contains_body=${/"body"\s*:/.test(leak)}`)

// --- 7. 降级 ---
while (a.box.governor.admit({ key: 'ops' }).admitted) { /* 耗尽额度 */ }
a.box.breaker.record({ key: 'ops', ok: false })
a.box.breaker.record({ key: 'ops', ok: false })     // 阈值 2 → 打开
const degraded = a.box.ops.snapshot({ rows })
check('降级正控：来源"有问题"（额度耗尽 / 熔断打开）时快照仍可读，并**如实**带出这些事实',
  degraded.runtime.governor.refused >= 1 && degraded.breaker.buckets.ops === 'open'
  && degraded.breaker.stats.opened >= 1,
  `gov.refused=${degraded.runtime.governor.refused} breaker=${degraded.breaker.buckets.ops} opened=${degraded.breaker.stats.opened}`)

// --- 8. 零残留 ---
const src = readFileSync(new URL('./modules/ops-view.mjs', import.meta.url), 'utf8')
const forbidden = ['ctx.on(', 'ctx.events.on(', 'setInterval(', 'setTimeout(', 'writeFile', 'appendFile']
  .filter((needle) => src.includes(needle))
check('零残留负控：模块不订阅事件/不注册定时器/不写文件（纯组合，无副作用）',
  forbidden.length === 0, `forbidden=${forbidden.join(',') || '无'}`)

// --- 9. 摘要可读且覆盖四源 ---
const text = a.box.ops.summary({ rows })
check('摘要正控：人类可读摘要覆盖 governor/breaker/canary/evidence 四段（运维一眼看清系统状态）',
  typeof text === 'string' && ['governor', 'breaker', 'canary', 'evidence'].every((k) => text.includes(k)),
  text.slice(0, 120))

await a.fiber.dispose()
console.log(JSON.stringify({ ...facts, passed: facts.checks.length - failures, total: facts.checks.length, failures }, null, 2))
process.exit(failures === 0 ? 0 : 1)
