/**
 * evolve-journal 的围栏门（`tools/verify.sh evolve-journal`）：宿主侧**人工维护**，不由被围对象自己写。
 *
 * 覆盖：
 *   1. 分类正确：混合流水 → 各类计数与门的两态（passed/rejected）都对
 *   2. **不输出正文**：喂进带敏感字段的行，输出里既没有那个值、也没有 `"body"` 键
 *   3. 输入即事实：空输入 → 全 0、`last_event=null`（不编、不去别处捞）
 *   4. 有界：`recent` 长度 ≤ `recent_limit`；配置超上界被**夹住**（摘要不得退化成全量转储）
 *   5. 未知事件如实登记（`unknown_types`），且**不因未知类型崩**（可演进：事件表会变）
 *   6. 确定性：同输入两次字节一致（不解析时间、不用墙钟）
 *   7. 零残留：不订阅事件/不注册定时器/不读文件/不写文件（静态扫描）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { readFileSync } from 'node:fs'
import { apply as journalApply, Config as journalConfig, KNOWN } from './modules/evolve-journal.mjs'

const facts = { checks: [] }
let failures = 0
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
}

const mount = async (conf = {}) => {
  const ctx = new Context()
  await ctx.plugin(EventsService)
  const box = {}
  const fiber = await ctx.plugin({
    name: 'evolve-journal#probe', inject: [], Config: journalConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'evolveJournal') box.handle = value; return original(service, value) }
      await journalApply(inner, cfg)
    },
  }, journalConfig.parse(conf))
  return { ctx, box, fiber }
}

const flow = [
  { type: 'evolve/proposed', body: { id: 'p1', source: 'fixture:module' } },
  { type: 'evolve/shadowed', body: { id: 'p1', shadow_path: 'tmp/x' } },
  { type: 'evolve/gated', body: { verdict: 'rejected', reasons: ['r1', 'r2'], secret_hint: 'cost_floor=123' } },
  { type: 'evolve/gated', body: { verdict: 'passed', reasons: [] } },
  { type: 'evolve/promoted', body: { approval_ref: 'ap-0100', written_to: 'host/modules/x.mjs' } },
  { type: 'evolve/canary-entered', body: { proposal_id: 'p1', approval_ref: 'ap-0100' } },
  { type: 'evolve/canary-exited', body: { reason: 'auto-rollback:错误率上升', automatic: true } },
  { type: 'evolve/rolled-back', body: { id: 'p1' } },
  { type: 'evolve/something-new', body: { whatever: '未来新增的事件类型' } },
]

const a = await mount({ recent_limit: 3 })
const out = a.box.handle.summarize(flow)

// --- 1. 分类正确 ---
check('分类正控：各类计数与门的两态（passed/rejected）都正确',
  out.rows === flow.length && out.proposed === 1 && out.shadowed === 1
  && out.promoted === 1 && out.rolled_back === 1
  && out.gated.total === 2 && out.gated.passed === 1 && out.gated.rejected === 1
  && out.canary.entered === 1 && out.canary.exited === 1
  && out.by_type.length === 8,
  `rows=${out.rows} gated=${out.gated.passed}/${out.gated.rejected} canary=${out.canary.entered}/${out.canary.exited}`)

// --- 2. 不输出正文 ---
const text = JSON.stringify(out)
check('泄漏负控：输出里**没有条目正文**（喂了 cost_floor 也不许出现，且没有 `"body"` 键）',
  !text.includes('cost_floor') && !/"body"\s*:/.test(text) && out.privacy.entry_bodies_included === false,
  `contains_body=${/"body"\s*:/.test(text)} contains_cost_floor=${text.includes('cost_floor')}`)

// --- 3. 输入即事实 ---
const empty = a.box.handle.summarize([])
check('输入即事实：空输入 → 全 0 且 last_event=null（不编、不去别处捞数据）',
  empty.rows === 0 && empty.promoted === 0 && empty.last_event === null && empty.gated.total === 0,
  `rows=${empty.rows} last=${empty.last_event}`)

// --- 4. 有界 ---
const bounded = await mount({ recent_limit: 99 })
const big = bounded.box.handle.summarize(flow)
check('有界上限正控：`recent_limit` 超上界时被**夹住**（摘要不得退化成全量转储）',
  big.recent.length <= 10 && out.recent.length <= 3,
  `recent(99→${big.recent.length}) recent(3→${out.recent.length})`)

// --- 5. 未知事件如实登记且不崩 ---
check('可演进正控：未知事件类型被如实登记进 `unknown_types`，且不因它崩',
  out.unknown_types.length === 1 && out.unknown_types[0] === 'evolve/something-new'
  && KNOWN.length >= 7 && out.last_event === 'evolve/something-new',
  `unknown=${out.unknown_types.join(',')} last=${out.last_event}`)

// --- 6. 确定性 ---
const d1 = JSON.stringify(a.box.handle.summarize(flow))
const d2 = JSON.stringify(a.box.handle.summarize(flow))
check('确定性正控：同输入两次输出**字节一致**（不解析时间、不用墙钟）', d1 === d2 && d1.length > 100,
  `len=${d1.length} equal=${d1 === d2}`)

// --- 7. 零残留（含"不读文件"） ---
const src = readFileSync(new URL('./modules/evolve-journal.mjs', import.meta.url), 'utf8')
const forbidden = ['ctx.on(', 'ctx.events.on(', 'setInterval(', 'setTimeout(', 'writeFile', 'appendFile',
  'readFile', 'existsSync'].filter((needle) => src.includes(needle))
check('零残留负控：不订阅事件/不注册定时器/不读写文件（只吃调用方给的行）',
  forbidden.length === 0, `forbidden=${forbidden.join(',') || '无'}`)

await a.fiber.dispose(); await bounded.fiber.dispose()
console.log(JSON.stringify({ ...facts, passed: facts.checks.length - failures, total: facts.checks.length, failures }, null, 2))
process.exit(failures === 0 ? 0 : 1)
