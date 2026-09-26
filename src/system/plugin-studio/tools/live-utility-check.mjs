/** Narrow live-provider demonstration: generated code, numeric behavior and lifecycle.
 * Run from repository root: node src/system/plugin-studio/tools/live-utility-check.mjs
 * Uses an isolated local data directory and makes one actual model generation request. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as web from '../../webui/code/product-server.mjs'
import * as store from '../../workspace-store/code/index.mjs'
import * as accounts from '../../accounts/code/product.mjs'
import * as ai from '../../agent-runtime/code/product-ai.mjs'
import * as procurement from '../../../domain/procurement/code/index.mjs'
import * as installedRuntime from '../../installed-plugins/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as studio from '../code/product.mjs'

const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { Context } = require('cordis')
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const evidenceDir = resolve(repo, 'tmp/product-evidence')
mkdirSync(evidenceDir, { recursive: true })
const resume = process.argv[2] === '--resume' ? process.argv[3] : ''
const data = resume ? resolve(repo, resume) : mkdtempSync(resolve(repo, 'tmp/live-generated-utility-'))
const ctx = new Context(), fibers = []
const prompt = `Develop an interactive landed-cost calculator as a calculator plugin. Write actual JavaScript implementation.
Use these exact numeric input field names/defaults: quantity=10, unitPrice=100, shipping=50, insurance=20, dutyPercent=5, taxPercent=10.
Compute base=quantity*unitPrice+shipping+insurance; duty=base*dutyPercent/100; tax=(base+duty)*taxPercent/100; total=base+duty+tax; unitCost=total/quantity.
Return named numeric keys total, unitCost, duty, tax rounded to two decimal places, rfqCount equal to workspace.rfqs.length, plus a readable summary and rows of the calculation.
Reject a non-positive quantity with a clear error. Do not access any external APIs. This should be executable custom source, not a static widget or an agent skill.`
try {
  for (const [plugin, config] of [[web, {}], [store, { root: data }], [accounts, {}], [settings, {}], [ai, {}], [procurement, {}], [installedRuntime, {}], [studio, {}]]) {
    fibers.push(await ctx.plugin(plugin, config))
  }
  const owner = ctx.accounts.get('contractor-demo')
  const other = ctx.accounts.get('supplier-demo')
  const admin = ctx.accounts.get('admin-demo')
  if (!resume) await ctx.procurement.execute(owner, 'create-rfq', { title: 'Private utility scope check', description: 'Unpublished owner-only requirement',
    currency: 'USD', items: [{ id: 'item-1', description: 'Private scope', quantity: 10, unit: 'each' }], supplierIds: [] })
  const plugin = resume ? ctx.studio.list(owner).plugins.find(row => row.kind === 'calculator' && !row.global)
    : (await ctx.studio.generate(owner, { prompt })).plugin
  if (!plugin) throw new Error('No generated utility found in the supplied resume directory.')
  if (!plugin.enabled) await ctx.studio.execute(owner, plugin.id, 'load')
  assert.equal(plugin.kind, 'calculator')
  assert.ok(plugin.spec.code.includes('function'))
  assert.match(plugin.source, /config\.attach/)
  assert.equal(ctx.studioRuntime.list(owner).length, 1)
  assert.equal(ctx.studioRuntime.list(other).length, 0)
  const first = await ctx.studio.run(owner, plugin.id, { input: {} })
  assert.equal(first.result.total, 1235.85)
  assert.equal(first.result.unitCost, 123.59)
  assert.equal(first.result.duty, 53.5)
  assert.equal(first.result.tax, 112.35)
  assert.equal(first.result.rfqCount, ctx.procurement.snapshot(owner).rfqs.length)
  const secondInput = { quantity: 2, unitPrice: 200, shipping: 20, insurance: 0, dutyPercent: 0, taxPercent: 5 }
  const second = await ctx.studio.run(owner, plugin.id, { input: secondInput })
  assert.equal(second.result.total, 441)
  assert.equal(second.result.unitCost, 220.5)
  let invalidRejected = false
  try {
    const invalid = await ctx.studio.run(owner, plugin.id, { input: { quantity: 0 } })
    invalidRejected = Boolean(invalid.result?.error || invalid.result?.ok === false)
  } catch { invalidRejected = true }
  assert.ok(invalidRejected, 'A non-positive quantity must produce a clear error, either as result.error or an exception.')
  await ctx.studio.execute(owner, plugin.id, 'publish')
  const installed = await ctx.studio.execute(other, plugin.id, 'install')
  const installedResult = await ctx.studio.run(other, installed.plugin.id, { input: secondInput })
  assert.equal(installedResult.result.total, 441)
  assert.equal(installedResult.result.rfqCount, ctx.procurement.snapshot(other).rfqs.length)
  const promoted = await ctx.studio.execute(admin, plugin.id, 'promote')
  const globalResult = await ctx.studio.run(other, promoted.plugin.id, { input: secondInput })
  assert.equal(globalResult.result.total, 441)
  assert.equal(globalResult.result.rfqCount, ctx.procurement.snapshot(other).rfqs.length)
  await ctx.studio.execute(owner, plugin.id, 'unload')
  assert.equal(ctx.studioRuntime.list(owner).some(row => row.id === plugin.id), false)
  assert.equal(ctx.web.extensions(owner).some(row => row.id === plugin.id), false)
  await assert.rejects(() => ctx.studio.run(owner, plugin.id, { input: {} }), /Enable this extension/)
  const evidence = { ok: true, generatedAt: new Date().toISOString(), command: 'node src/system/plugin-studio/tools/live-utility-check.mjs' + (resume ? ` --resume ${resume}` : ''),
    data, provider: ctx.ai.status(), pluginId: plugin.id, name: plugin.name, generatedCode: plugin.spec.code,
    first: first.result, changedInputs: second.result, installed: installedResult.result, global: globalResult.result,
    checks: ['actual model-generated JavaScript', 'Cordis callable registration', 'numeric results for two inputs',
      'invalid quantity error', 'calling-account-only workspace', 'publish/install preserves executable behavior',
      'admin promotion preserves executable behavior', 'unload removes both UI and callable effects'] }
  writeFileSync(resolve(evidenceDir, 'generated-utility-live.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, pluginId: plugin.id, firstTotal: first.result.total, secondTotal: second.result.total,
    evidence: 'tmp/product-evidence/generated-utility-live.json', checks: evidence.checks }))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
