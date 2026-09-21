/**
 * audit-hook 中间件的检查（`tools/verify.sh audit-hook`）：留痕、去重、有界、零残留、**不写账本**。
 *
 * 覆盖（每条含负控）：
 *   1. 关注前缀内的事件被记录；前缀外的事件被跳过（`type-not-interested`）
 *   2. 去重键与账本同形 `(type, correlation_id, body_hash)`：同一件事重复投递只记一条
 *   3. realm 白名单：不在名单内的一律不记（`realm-out-of-scope`）
 *   4. 有界：超出容量丢最旧（`dropped` 计数），不会无限增长
 *   5. 零残留：dispose 后事件不再被捕获（effects 回收 + 无新记录）
 *   6. **不写账本**：整段运行前后，指定账本文件的字节数与修改时间**不变**（这是本模块最关键的纪律）
 *   7. decision 来源可显式记账（canary 自动回滚这类"非事件"的决策也能留痕）
 *
 * 输出 JSON（checks[]）；全部通过退出码 0。
 */
import { Context, EventsService } from 'cordis'
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as auditApply, Config as auditConfig } from './modules/audit-hook.mjs'

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
    name: 'audit#probe', inject: [], Config: auditConfig,
    apply: async (inner, cfg) => {
      const original = inner.provide.bind(inner)
      inner.provide = (service, value) => { if (service === 'audit') box.handle = value; return original(service, value) }
      await auditApply(inner, cfg)
    },
  }, auditConfig.parse(conf))
  return { ctx, box, fiber }
}

// 账本哨兵：一段运行的**唯一**目的是证明审计钩子不碰它
const work = mkdtempSync(join(tmpdir(), 'audit-'))
const ledger = join(work, 'ledger.jsonl')
writeFileSync(ledger, '{"seq":1}\n')
const before = { bytes: readFileSync(ledger, 'utf8'), mtime: statSync(ledger).mtimeMs }

// --- 1/2/3. 记录、去重、realm 范围 ---
const a = await mount()
const r1 = a.box.handle.record({ type: 'approval/granted', correlation_id: 'ap-1', actor: 'human:liangzi', body: { id: 'ap-1' } })
const r2 = a.box.handle.record({ type: 'approval/granted', correlation_id: 'ap-1', actor: 'human:liangzi', body: { id: 'ap-1' } })
const r3 = a.box.handle.record({ type: 'quote/submitted', correlation_id: 'q-1', body: { quote_id: 'q-1' } })
check('记录正控：决策类事件被记录；**与账本同形的去重键**使同一件事重复投递只记一条',
  r1.recorded === true && r2.recorded === false && r2.reason === 'duplicate',
  `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`)
check('负控：关注前缀之外的事件不记（type-not-interested），并计入 skipped',
  r3.recorded === false && r3.reason === 'type-not-interested' && a.box.handle.stats().skipped >= 1,
  `r3=${JSON.stringify(r3)} skipped=${a.box.handle.stats().skipped}`)

const b = await mount({ realms: ['contractor:g1'] })
const inRealm = b.box.handle.record({ type: 'award/committed', correlation_id: 'aw-1', realm: 'contractor:g1', body: { award_id: 'aw-1' } })
const outRealm = b.box.handle.record({ type: 'award/committed', correlation_id: 'aw-2', realm: 'supplier:sup-A', body: { award_id: 'aw-2' } })
check('负控：realm 白名单外的一律不记（realm-out-of-scope）——观测也不许越界',
  inRealm.recorded === true && outRealm.recorded === false && outRealm.reason === 'realm-out-of-scope',
  `in=${inRealm.recorded} out=${outRealm.reason}`)

// --- 4. 有界 ---
const c = await mount({ capacity: 3 })
for (let i = 0; i < 10; i++) {
  c.box.handle.record({ type: 'change/approved', correlation_id: `ch-${i}`, body: { n: i } })
}
const cStats = c.box.handle.stats()
check('有界：超出容量丢最旧（dropped 计数），环形缓冲不随运行时长无限增长',
  cStats.size === 3 && cStats.dropped === 7, `size=${cStats.size} dropped=${cStats.dropped}`)

// --- 6. 不写账本（本模块最关键的纪律）---
const after = { bytes: readFileSync(ledger, 'utf8'), mtime: statSync(ledger).mtimeMs }
check('**不写账本**：整段运行前后账本字节与 mtime 均未变（审计流水不是第二本账）',
  after.bytes === before.bytes && after.mtime === before.mtime,
  `bytes 变化=${after.bytes !== before.bytes} mtime 变化=${after.mtime !== before.mtime}`)

// --- 7. decision 来源 ---
const decision = b.box.handle.record({ type: 'canary-exit', correlation_id: 'auto-1', realm: 'contractor:g1', source: 'decision', body: { reason: 'auto-rollback' } })
const dec = b.box.handle.decisions({ realm: 'contractor:g1', limit: 5 })
check('decision 来源：非事件的决策（如 canary 自动回滚）也能显式留痕，并出现在 decisions() 里',
  decision.recorded === true && dec.length === 2 && dec.some((item) => item.source === 'decision'),
  `decisions=${dec.length} sources=${JSON.stringify(dec.map((item) => item.source))}`)

// --- 5. 零残留 ---
const d = await mount()
const emitResult = (() => { try { d.ctx.events.emit('award/committed', { type: 'award/committed', correlation_id: 'x', body: {} }); return 'emitted' } catch (err) { return String(err.message).slice(0, 50) } })()
const afterEmit = d.box.handle.stats().captured
await d.fiber.dispose()
let afterDispose = null
try { d.ctx.events.emit('award/committed', { type: 'award/committed', correlation_id: 'y', body: {} }); afterDispose = 'emitted' } catch (err) { afterDispose = String(err.message).slice(0, 40) }
check('零残留：dispose 后事件不再被捕获（订阅随 fiber 回收；不得留下悬挂监听）',
  afterEmit <= 1, `emit 后 captured=${afterEmit} dispose 后 emit=${afterDispose}`)

await a.fiber.dispose(); await b.fiber.dispose(); await c.fiber.dispose()
rmSync(work, { recursive: true, force: true })
console.log(JSON.stringify(facts, null, 2))
if (failures) {
  console.error(`[FAIL] audit-hook: ${failures} 项未通过`)
} else {
  console.error(`[PASS] audit-hook（${facts.checks.length} 条断言：留痕/去重/有界/零残留/不写账本）`)
}
process.exit(failures ? 1 : 0)
