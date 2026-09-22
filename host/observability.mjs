/**
 * observability 插件的检查（`tools/verify.sh observability`）：每条正控 + 负控。
 *
 * 覆盖：
 *   1. 聚合形状：三个来源（governor / audit / canary）的统计与阶段都在快照里（缺一个就是假接线）
 *   2. **只读**：调用 `snapshot()` **不改变**任何来源的统计（观测不能有副作用）
 *   3. **确定性**：同一状态下两次 `snapshot()` 字节一致（不依赖墙钟/随机）
 *   4. **不泄漏**：快照里没有条目正文、没有私域键名（观测是一条侧信道，必须干净）
 *   5. **降级**：来源处于"出问题"的状态（额度耗尽 / 有丢弃）时快照仍可读，且把事实如实带出来
 *   6. 零残留：卸载后服务不再提供（再挂一次是干净的）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { readFileSync } from 'node:fs'
import { apply as governorApply, Config as governorConfig } from './modules/governor.mjs'
import { apply as auditApply, Config as auditConfig } from './modules/audit-hook.mjs'
import { apply as canaryApply, Config as canaryConfig } from './modules/canary.mjs'
import { apply as obsApply, Config as obsConfig } from './modules/observability.mjs'

const REALM = 'contractor:con-B'
const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

/** 挂三个来源 + observability；每个来源都用 provide 拦截拿句柄（根 ctx 看不到插件提供的服务）。 */
const mount = async (conf = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const mountOne = async (mod, cfg, service, key) => {
    const apply = mod.apply
    await ctx.plugin({
      name: `${service}#probe`, inject: [], Config: mod.Config,
      apply: async (inner, c) => {
        const original = inner.provide.bind(inner)
        inner.provide = (s, v) => { if (s === service) box[key] = v; return original(s, v) }
        await apply(inner, c)
      },
    }, mod.Config.parse(cfg))
  }
  await mountOne({ apply: governorApply, Config: governorConfig }, { capacity: 4, key: 'obs', ...(conf.governor ?? {}) }, 'governor', 'governor')
  await mountOne({ apply: auditApply, Config: auditConfig }, { capacity: 8, realms: [REALM], ...(conf.audit ?? {}) }, 'audit', 'audit')
  await mountOne({ apply: canaryApply, Config: canaryConfig }, { weight_bps: 5000, min_samples: 2, realms: [REALM] }, 'canary', 'canary')
  const obsFiber = await ctx.plugin({
    name: 'observability#probe', inject: ['governor', 'audit', 'canary'], Config: obsConfig,
    apply: async (inner, c) => {
      const original = inner.provide.bind(inner)
      inner.provide = (s, v) => { if (s === 'observability') box.obs = v; return original(s, v) }
      await obsApply(inner, c)
    },
  }, obsConfig.parse(conf.observability ?? {}))
  return { ctx, box, obsFiber }
}

// --- 1. 聚合形状 ---
const a = await mount()
const snapA = a.box.obs.snapshot()
const gKeys = Object.keys(snapA.governor.stats)
check('形状正控：快照含三个来源的统计与 canary 阶段（缺一个即为假接线）',
  snapA.view === 'runtime-observability' && snapA.sources.join(',') === 'governor,audit,canary'
  && ['admitted', 'refused', 'timeouts', 'completed', 'failed'].every((k) => gKeys.includes(k))
  && typeof snapA.audit.stats.captured === 'number'
  && snapA.canary.state.phase === 'base',
  `view=${snapA.view} sources=${snapA.sources.join(',')} govKeys=${gKeys.join('|')} phase=${snapA.canary.state.phase}`)

// --- 2. 只读：观测不能有副作用 ---
const before = JSON.stringify(a.box.audit.stats())
const govBefore = JSON.stringify(a.box.governor.stats())
a.box.obs.snapshot()
a.box.obs.summary()
const after = JSON.stringify(a.box.audit.stats())
const govAfter = JSON.stringify(a.box.governor.stats())
check('只读正控：反复取快照/摘要**不改变**任何来源的统计（观测无副作用）',
  before === after && govBefore === govAfter, `audit ${before} → ${after}`)

// --- 3. 确定性 ---
const s1 = JSON.stringify(a.box.obs.snapshot())
const s2 = JSON.stringify(a.box.obs.snapshot())
check('确定性正控：同一状态下两次快照**字节一致**（不使用墙钟/随机）',
  s1 === s2, `len=${s1.length} equal=${s1 === s2}`)

// --- 4. 不泄漏 ---
const body = '这里是报文正文：cost_floor=123; supplier_list=...'
a.box.audit.record({ type: 'approval/granted', correlation_id: 'c-1', realm: REALM, body, source: 'decision' })
const leak = JSON.stringify(a.box.obs.snapshot())
check('泄漏负控：快照里**没有条目正文、没有私域键名**（观测不得成为侧信道）',
  !leak.includes('cost_floor') && !leak.includes('这里是报文正文')
  && !/"[a-z_]*body"\s*:/.test(leak) && !/private:/i.test(leak),
  `contains_body_kv=${/"[a-z_]*body"\s*:/.test(leak)}`)

// --- 5. 降级：来源出问题时仍可读，且把事实带出来 ---
const b = await mount({ audit: { capacity: 2 } })
b.box.audit.record({ type: 'approval/granted', correlation_id: 'c-1', realm: REALM, source: 'decision' })
b.box.audit.record({ type: 'approval/granted', correlation_id: 'c-1', realm: REALM, source: 'decision' })  // 去重
for (let i = 0; i < 5; i++) b.box.audit.record({ type: 'approval/granted', correlation_id: `c-${i + 2}`, realm: REALM, source: 'decision' })
const c1 = b.box.governor.admit({ key: 'obs' })
while (b.box.governor.admit({ key: 'obs' }).admitted) { /* 耗尽额度 */ }
const snapB = b.box.obs.snapshot()
check('降级正控：来源"有问题"（去重/丢弃/额度耗尽）时快照仍可读，并**如实**带出这些事实',
  snapB.audit.stats.deduped >= 1 && snapB.audit.stats.dropped >= 1 && snapB.governor.stats.refused >= 1
  && c1.admitted === true,
  `deduped=${snapB.audit.stats.deduped} dropped=${snapB.audit.stats.dropped} refused=${snapB.governor.stats.refused}`)

// --- 6. 零残留：不订阅事件、不注册定时器；卸载后重挂载是干净的 ---
// 静态扫描必须跟到**实体**（本批 `EV-177` 起 `host/modules/<stem>.mjs` 可能是**薄重导**：实体在
// `src/<层>/<插件>/code/`；读转发文件会让"零写面 / 零定时器 / 不订阅事件"这类断言在 8 行重导上**静默判绿**）。
const moduleSource = (relative) => {
  let current = new URL(relative, import.meta.url)
  let text = readFileSync(current, 'utf8')
  for (let hop = 0; hop < 8; hop += 1) {
    const match = text.match(/^\s*export \* from '([^']+)'/m)
    if (!match) break
    current = new URL(match[1], current)
    text = readFileSync(current, 'utf8')
  }
  return text
}
const src = moduleSource('./modules/observability.mjs')
const forbidden = ['ctx.on(', 'ctx.events.on(', 'setInterval(', 'setTimeout(', 'writeFile', 'appendFile']
  .filter((needle) => src.includes(needle))
await b.obsFiber.dispose()
const c = await mount()   // 卸载后再挂：必须是干净的一份（不残留上一份的状态）
check('零残留负控：模块不订阅事件/不注册定时器/不写文件；卸载后可干净重挂',
  forbidden.length === 0 && c.box.obs.snapshot().audit.stats.captured === 0
  && c.box.obs.snapshot().canary.state.phase === 'base',
  `forbidden=${forbidden.join(',') || '无'} remount_captured=${c.box.obs.snapshot().audit.stats.captured}`)

await a.ctx.stop?.()
await b.ctx.stop?.()

console.log(JSON.stringify({ ...facts, total: facts.checks.length, failures }, null, 2))
process.exit(failures === 0 ? 0 : 1)
