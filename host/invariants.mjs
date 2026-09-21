/**
 * 宿主强制不变量 H5/H6 的机检（`tools/verify.sh invariants` 的 Node 侧半场）。
 *
 * 依据：评审 C §4.2 的 H1..H10 与 `ADR-0014 §7`——H1/H2/H3/H5/H6 五条必须由**宿主强制**，
 * 每条带一个**会变红的负控**（不是口头声明：把违规场景真跑出来、断言检测器报红）。
 *
 *   H5 冻结面：`kernel-*` 条目不可 patch（含人也不能改 INV-010）；且**否决必须由宿主显式安装**
 *              （没有 hook 就没有否决——用"裸 context 直接 fiber.update"作为负控证明这一点）。
 *   H6 卸载残留：dispose 后 effect 数为 0 **且**资源计数器差分全 0（订阅/定时器都不许漏）。
 *
 * 用**生产白名单**（`host/lib/schema.mjs`）与生产校验器（`host/lib/frozen.mjs`），不另造一份。
 * 插件装载/卸载的写法与已验证的 `host/smoke.mjs` 一致（`await ctx.plugin(...)`、`c.fiber.effect(...)`）。
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService, RegistryService } from 'cordis'
import { createRequire } from 'node:module'
import { validate, FROZEN_BY } from './lib/frozen.mjs'
import { digestOf } from './lib/config.mjs'
import { SCHEMA } from './lib/schema.mjs'

const require_ = createRequire(import.meta.url)
const facts = { cordis_version: require_('cordis/package.json').version, node: process.version, checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}
const ok = (result) => (result.violations || []).length === 0
const rules = (result) => (result.violations || []).map((item) => item.rule)

// ---------- H5：冻结面（生产白名单 + 生产校验器） ----------
const base = { norm: { tolerance_bps: 5 }, compare: { weights: { price: 0.6 } } }
const authorized = validate(SCHEMA, { norm: { tolerance_bps: 7 } }, 'bundle:industry-3pl', base)
const forgedKernel = validate(SCHEMA, { kernel: { realm: 'supplier:x' } }, 'human:zhang', base)
const forgedKernelByAgent = validate(SCHEMA, { kernel: { realm: 'supplier:x' } }, 'agent:planner', base)
const humanOnlyByAgent = validate(SCHEMA, { approval: { timeout_s: 10 } }, 'agent:planner', base)
const unknownKey = validate(SCHEMA, { mystery: { key: 1 } }, 'bundle:industry-3pl', base)

check('H5 正控：授权来源改登记键（norm.tolerance_bps）被接受', ok(authorized),
  `reasons=${JSON.stringify(authorized.reasons)}`)
check('H5 负控：`kernel.*` 伪造更新被拒（理由 frozen —— 含人也不能改 INV-010）',
  !ok(forgedKernel) && rules(forgedKernel).includes('frozen') && forgedKernel.by === FROZEN_BY,
  `rules=${JSON.stringify(rules(forgedKernel))}`)
check('H5 负控：agent 更新 `kernel.*` 同样被拒', !ok(forgedKernelByAgent),
  `rules=${JSON.stringify(rules(forgedKernelByAgent))}`)
check('H5 负控：`humanOnly` 区间的 agent 更新被拒（human-only）',
  !ok(humanOnlyByAgent) && rules(humanOnlyByAgent).includes('human-only'),
  `rules=${JSON.stringify(rules(humanOnlyByAgent))}`)
check('H5 负控：白名单外的陌生键被拒（unknown-key；H10）',
  !ok(unknownKey) && rules(unknownKey).includes('unknown-key'), `rules=${JSON.stringify(rules(unknownKey))}`)

const live = structuredClone(base)
const before = digestOf(live)
if (ok(forgedKernel)) Object.assign(live, forgedKernel.value ?? {})
check('H5 负控：被拒的更新不得改变配置（摘要前后一致）', digestOf(live) === before,
  `${before.slice(0, 20)}… → ${digestOf(live).slice(0, 20)}…`)

// 否决必须**显式安装**：裸 context 上直接 fiber.update 不会有任何否决（负控证明这条不变量不是自动成立的）
const bare = new Context()
await bare.plugin(EventsService)
await bare.plugin(RegistryService)
let bareEvents = 0
const bareFiber = await bare.plugin({
  name: 'bare',
  apply(c) {
    c.fiber.effect(() => () => { bareEvents += 1 })
  },
}, { mystery: { key: 1 } })
let bareUpdateError = null
try {
  await bareFiber.update({ mystery: { key: 2 } })
} catch (err) {
  bareUpdateError = String(err).slice(0, 80)
}
check('H5 负控：**没有安装否决 hook** 时 `fiber.update` 不会因白名单/冻结面被拦（故否决必须由宿主显式安装）',
  bareUpdateError === null,
  `update error=${bareUpdateError}；配置未变则需靠已安装的 hook`)

// ---------- H6：卸载残留 ----------
const counters = { timers: 0, subscriptions: 0 }
const makePlugin = (leak) => ({
  name: leak ? 'leaky' : 'clean',
  apply(c, config = {}) {
    c.fiber.effect(() => {
      counters.subscriptions += 1
      return () => {
        counters.subscriptions -= 1
      }
    })
    if (config.leak) {
      counters.timers += 1
      setInterval(() => {}, 1000) // 故意泄漏：没有对应 dispose
    } else {
      const handle = setInterval(() => {}, 1000)
      counters.timers += 1
      c.fiber.effect(() => () => {
        clearInterval(handle)
        counters.timers -= 1
      })
    }
  },
})

const cleanCtx = new Context()
await cleanCtx.plugin(EventsService)
const cleanFiber = await cleanCtx.plugin(makePlugin(false), { leak: false })
const effectsBefore = cleanFiber.getEffects().length
await cleanFiber.dispose()
await new Promise((resolve) => setTimeout(resolve, 20))
const effectsAfter = cleanFiber.getEffects().length
check('H6 正控：干净插件 dispose 后 effect 数为 0 且资源计数差分全 0',
  effectsBefore > 0 && effectsAfter === 0 && counters.timers === 0 && counters.subscriptions === 0,
  `effects ${effectsBefore} → ${effectsAfter}；counters=${JSON.stringify(counters)}`)

const leakCtx = new Context()
await leakCtx.plugin(EventsService)
const leakFiber = await leakCtx.plugin(makePlugin(true), { leak: true })
await leakFiber.dispose()
await new Promise((resolve) => setTimeout(resolve, 20))
check('H6 负控：泄漏定时器的插件被检出（资源计数差分非 0 → 检查器必须报红）',
  counters.timers > 0, `counters=${JSON.stringify(counters)}（>0 才算检出）`)

console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] host invariants H5/H6: ${failures} 项未通过`)
} else {
  console.error('[PASS] host invariants H5/H6')
}
process.exit(failures ? 1 : 0)
