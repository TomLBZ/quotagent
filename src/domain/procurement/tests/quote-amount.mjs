import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Context } from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import { authoredFixtureInput } from './declared-scope-fixture.mjs'

const buyer = { id: 'buyer', role: 'contractor', name: 'Buyer', email: 'buyer@amount.local' }
const supplier = { id: 'supplier', role: 'supplier', name: 'Supplier', email: 'supplier@amount.local' }
const member = { id: 'member', role: 'supplier', name: 'Member', email: 'member@amount.local' }
const outsider = { id: 'outsider', role: 'contractor', name: 'Outsider', email: 'outsider@amount.local' }
const rival = { id: 'rival', role: 'supplier', name: 'Rival', email: 'rival@amount.local' }
const admin = { id: 'admin', role: 'admin', name: 'Admin', email: 'admin@amount.local' }
const users = [buyer, supplier, member, outsider, rival, admin], checks = [], results = []
mkdirSync('tmp', { recursive: true })
const root = mkdtempSync(resolve('tmp/quote-amount-'))

async function mount() {
  const ctx = new Context(), tools = new Map(), fibers = []
  fibers.push(await ctx.plugin({ name: 'amount-fixture', apply(inner) {
    inner.provide('accounts', { list: () => structuredClone(users), get: id => structuredClone(users.find(row => row.id === id)), can: () => true })
    inner.provide('web', { route: () => () => {}, contribute: () => () => {} })
    inner.provide('assistant', { tool: tool => { assert(!tools.has(tool.name)); tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  } }))
  for (const plugin of [storePlugin, teamsPlugin, procurementPlugin]) fibers.push(await ctx.plugin(plugin, plugin === storePlugin ? { root } : {}))
  return { ctx, tools, procurementFiber: fibers.at(-1), dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}
let mounted = await mount(), ctx = mounted.ctx
const tool = () => mounted.tools.get('calculate_quote_amount')
const calculate = (user, quote, percentage) => tool().execute(user, { quoteId: quote.id, quoteRevision: quote.revision, percentage })
const run = (user, action, input) => ctx.procurement.execute(user, action, authoredFixtureInput(action, input))
async function quoteFor(total, title) {
  const rfq = (await run(buyer, 'create-rfq', { title, currency: 'USD', items: [{ id: 'x', description: 'Authored amount fixture unit', unit: 'each', quantity: 1 }], supplierIds: [supplier.id, rival.id] })).rfq
  await run(buyer, 'publish-rfq', { id: rfq.id, confirmed: true })
  const quote = (await run(supplier, 'save-quote', { rfqId: rfq.id, items: [{ id: 'x', unitPrice: total, cost: 0.01 }], paymentTerms: '30% deposit; 70% after delivery', privateNotes: 'PRIVATE-CALCULATOR-FIXTURE' })).quote
  return { rfq, quote }
}
const eventCounts = () => users.map(user => ctx.store.events(user.id).length)

try {
  assert.equal(tool().effect, 'read'); assert.deepEqual(tool().roles, ['contractor', 'supplier'])
  assert.deepEqual(tool().parameters.required, ['quoteId', 'quoteRevision', 'percentage'])
  const a = await quoteFor(5532, 'Actual 5532 source quotation')
  assert.throws(() => calculate(buyer, a.quote, '30'), { code: 'QUOTE_AMOUNT_UNAVAILABLE' })
  await run(supplier, 'submit-quote', { id: a.quote.id, confirmed: true })
  const before = eventCounts(), result = calculate(buyer, a.quote, '30')
  assert.equal(result.base, '5532.00'); assert.equal(result.amount, '1659.60'); assert.equal(result.remainder, '3872.40')
  assert.equal(result.amountMinorUnits, '165960'); assert.equal(result.currency, 'USD'); assert.equal(result.interpretation, 'illustrative-calculation')
  assert.match(result.summary, /does not establish an agreed deposit or payment schedule/)
  const source = ctx.store.events(buyer.id).find(row => row.seq === result.source.ref.seq)
  assert.equal(source.entry_hash, result.source.ref.hash); assert.equal(source.body.record.total, 5532); assert.equal(source.body.record.revision, a.quote.revision)
  assert.deepEqual(result.action.input, { view: 'quotes', workspaceId: buyer.id, quoteId: a.quote.id, rfqId: a.rfq.id })
  assert(!JSON.stringify(result).includes('PRIVATE-CALCULATOR-FIXTURE')); assert(!JSON.stringify(result).includes('cost'))
  assert.deepEqual(eventCounts(), before); results.push(result)
  checks.push('Native disposable read-tool registration, actual received QEP quotation 5532 × 30% = 1659.60 plus 3872.40 remainder, exact source ledger reference and GUI-readable summary; no business event or private cost disclosure')

  const b = await quoteFor(5292, 'Full and fractional amount'), c = await quoteFor(0.05, 'Half-cent rounding')
  for (const [quote, percentage, amount, remainder] of [[b.quote, '100', '5292.00', '0.00'], [b.quote, '0', '0.00', '5292.00'], [b.quote, '12.345678', '653.33', '4638.67'], [c.quote, '50', '0.03', '0.02'], [c.quote, '30', '0.02', '0.03']]) {
    const actual = calculate(supplier, quote, percentage)
    assert.equal(actual.amount, amount); assert.equal(actual.remainder, remainder)
    assert.equal(BigInt(actual.amountMinorUnits) + BigInt(actual.remainderMinorUnits), BigInt(actual.baseMinorUnits)); results.push(actual)
  }
  assert.equal(calculate(supplier, b.quote, 12.5).amount, '661.50')
  for (const percentage of ['', null, -1, Infinity, '100.000001', '0.1234567', '1e2', '30%', {}, true]) assert.throws(() => calculate(supplier, b.quote, percentage), { code: 'QUOTE_AMOUNT_INPUT' })
  assert.throws(() => tool().execute(supplier, { quoteId: b.quote.id, quoteRevision: b.quote.revision, percentage: '30', total: 10800 }), /base must come from the stored quotation/)
  assert.throws(() => tool().execute(supplier, { quoteId: b.quote.id, percentage: '30' }), /current quotation revision/)
  checks.push('Exact BigInt fractional percentage and half-up cent arithmetic at 0/100%, two half-cent cases, conserved remainder, finite numeric compatibility, and refusal of omitted/invalid/overspecified rates or a caller-provided total')

  const changed = (await run(supplier, 'save-quote', { ...a.quote, id: a.quote.id, expectedRevision: a.quote.revision, items: [{ id: 'x', unitPrice: 5555, cost: 0.01 }] })).quote
  assert.throws(() => calculate(supplier, a.quote, '30'), { code: 'QUOTE_AMOUNT_STALE' })
  assert.equal(calculate(supplier, changed, '30').amount, '1666.50')
  // The recipient correctly retains its last received offer until the new revision is submitted.
  assert.equal(calculate(buyer, a.quote, '30').amount, '1659.60')
  await run(supplier, 'submit-quote', { id: changed.id, confirmed: true })
  assert.throws(() => calculate(buyer, a.quote, '30'), { code: 'QUOTE_AMOUNT_STALE' })
  assert.equal(calculate(buyer, changed, '30').amount, '1666.50')
  const replacement = (await run(supplier, 'save-quote', { rfqId: a.rfq.id, items: [{ id: 'x', unitPrice: 5560 }] })).quote
  await run(supplier, 'submit-quote', { id: replacement.id, confirmed: true })
  assert.throws(() => calculate(buyer, changed, '30'), { code: 'QUOTE_AMOUNT_STALE' })
  const amendment = (await run(buyer, 'save-amendment', { rfqId: a.rfq.id, expectedRevision: 1, description: 'Explicitly changed request scope.', reason: 'Human-authored revised source.' })).amendment
  await run(buyer, 'publish-amendment', { id: amendment.id, confirmed: true })
  assert.throws(() => calculate(supplier, replacement, '30'), { code: 'QUOTE_AMOUNT_STALE' })
  checks.push('Editing a quotation invalidates the earlier supplier revision, receipt updates invalidate the earlier buyer revision, superseded offers and amended request scope refuse; an unsent private edit cannot silently replace a buyer’s received source')

  for (const person of [outsider, rival, member]) assert.throws(() => calculate(person, b.quote, '30'), { code: 'QUOTE_AMOUNT_UNAVAILABLE' })
  assert.throws(() => calculate(admin, b.quote, '30'), /supplier or contractor workspace/)
  const invitation = await ctx.teams.invite(supplier, { email: member.email, roleId: 'lead' })
  await ctx.teams.answerInvite(member, invitation.id, true); await ctx.teams.select(member, supplier.id)
  const counts = eventCounts(), colleague = calculate(member, b.quote, '30')
  assert.equal(colleague.source.ref.realm, supplier.id); assert.equal(colleague.amount, '1587.60'); assert.deepEqual(eventCounts(), counts)
  checks.push('Uninvited contractor, rival supplier, unjoined colleague and admin cannot read the quote; explicitly joined supplier teammate uses authorized party source and a read changes no realm')

  const retainedRef = calculate(supplier, b.quote, '100').source.ref
  await mounted.dispose(); assert.equal(mounted.tools.size, 0)
  mounted = await mount(); ctx = mounted.ctx
  const restored = calculate(member, b.quote, '100')
  assert.equal(restored.amount, '5292.00'); assert.deepEqual(restored.source.ref, retainedRef)
  await mounted.procurementFiber.dispose(); assert(!mounted.tools.has('calculate_quote_amount'))
  checks.push('Actual Cordis/store remount reconstructs the same amount, source sequence/hash and selected joined workspace; procurement unload disposes the calculator registration')
  const report = { ok: true, root, checks, results, at: new Date().toISOString() }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2))
} finally { await mounted.dispose() }
