/** Focused integration exercise using the real Cordis and Python Ledger/QEP adapter. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from './index.mjs'

const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { Context } = require('cordis')
mkdirSync(resolve('tmp'), { recursive: true })
const root = mkdtempSync(resolve('tmp/procurement-smoke-'))
const context = new Context()
const users = [
  { id: 'smoke-contractor', name: 'Buyer', company: 'Builder', role: 'contractor', email: 'buyer@example.test', preferences: { secret: 'buyer-private' } },
  { id: 'smoke-supplier', name: 'Supplier', company: 'Supply Co', role: 'supplier', email: 'supplier@example.test', preferences: { secret: 'supplier-private' } },
  { id: 'smoke-second', name: 'Second', company: 'Second Co', role: 'supplier', email: 'second@example.test', preferences: {} },
  { id: 'admin-demo', name: 'Admin', role: 'admin', email: 'admin@demo.local', preferences: {} },
  { id: 'contractor-demo', name: 'Demo buyer', company: 'Northstar', role: 'contractor', email: 'contractor@demo.local', preferences: {} },
  { id: 'supplier-demo', name: 'Demo supplier', company: 'Summit', role: 'supplier', email: 'supplier@demo.local', preferences: {} },
  { id: 'supplier2-demo', name: 'Demo second', company: 'Atlas', role: 'supplier', email: 'supplier2@demo.local', preferences: {} },
]
const routes = [], navigation = [], tools = []
const push = (list, entry) => { list.push(entry); return () => list.splice(list.indexOf(entry), 1) }
const foundation = await context.plugin({ name: 'smoke-foundation', apply(ctx) {
  ctx.provide('accounts', { list: () => structuredClone(users), get: id => structuredClone(users.find(user => user.id === id)) })
  ctx.provide('web', { route: (...args) => push(routes, args), contribute: entry => push(navigation, entry) })
  ctx.provide('assistant', { tool: entry => push(tools, entry) })
} })
const storeFiber = await context.plugin(storePlugin, { root })
let fiber = await context.plugin(procurementPlugin)
try {
  const service = context.procurement
  const [buyer, supplier, second] = users
  const demoBuyer = users.find(user => user.id === 'contractor-demo')
  const demoData = service.snapshot(demoBuyer)
  assert.equal(demoData.rfqs.length, 2, 'Built-in demo opens with lighting and cabling RFQs')
  assert.equal(demoData.comparison.length, 2, 'Built-in demo opens with two supplier bids')
  assert.ok(demoData.rfqs.every(rfq => rfq.demo && rfq.title.startsWith('[Demo]')))
  assert.equal(service.snapshot(buyer).rfqs.length, 0, 'Ordinary accounts start empty')
  const create = await service.execute(buyer, 'create-rfq', { title: 'Smoke account-owned quotation', description: 'Real QEP journey',
    currency: 'USD', supplierIds: [supplier.id, second.id], items: [{ id: 'x', description: 'Decimal quantity', quantity: 1.5, unit: 'm' }] })
  const rfq = create.rfq
  const updated = await service.execute(buyer, 'create-rfq', { id: rfq.id, description: 'Editable extracted draft, real QEP journey' })
  assert.equal(updated.rfq.id, rfq.id)
  assert.equal(updated.rfq.description, 'Editable extracted draft, real QEP journey')
  assert.equal(updated.rfq.supplierIds.length, 2)
  await assert.rejects(service.execute({ ...buyer, permissions: ['workspace:read-only'] }, 'create-rfq', { id: rfq.id }, { agent: true }), /read-only/)
  assert.equal(service.snapshot(supplier).rfqs.length, 0, 'Draft must stay private')
  await assert.rejects(service.execute(buyer, 'publish-rfq', { id: rfq.id }), /confirm/)
  await service.execute(buyer, 'publish-rfq', { id: rfq.id, confirmed: true })
  await assert.rejects(service.execute(buyer, 'create-rfq', { id: rfq.id, title: 'Edit published' }), /unpublished/)
  assert.equal(service.snapshot(supplier).rfqs[0].id, rfq.id)
  assert.equal(service.snapshot(second).rfqs[0].id, rfq.id)
  const draft = await service.execute(supplier, 'save-quote', { rfqId: rfq.id,
    items: [{ id: 'x', unitPrice: 0.33, cost: 0.12 }], leadDays: 14, paymentTerms: 'Net 30', privateNotes: 'supplier-private-note' })
  assert.equal(draft.quote.total, 0.5, 'Round 1.5 × 0.33 once to cents')
  assert.equal(service.snapshot(buyer).quotes.length, 0, 'Quote draft must stay private')
  await service.execute(supplier, 'submit-quote', { id: draft.quote.id, confirmed: true })
  const buyerData = service.snapshot(buyer)
  assert.equal(buyerData.comparison[0].total, 0.5)
  assert.equal(buyerData.quotes[0].items[0].cost, undefined)
  assert.equal(buyerData.quotes[0].privateNotes, undefined)
  assert.ok(!JSON.stringify(buyerData.contacts).includes('supplier-private'))
  assert.ok(!JSON.stringify(context.store.events(buyer.id)).includes('supplier-private-note'))
  await service.execute(supplier, 'send-message', { rfqId: rfq.id, toId: buyer.id, text: 'Scope confirmed.', kind: 'clarification' })
  assert.equal(service.snapshot(buyer).messages[0].text, 'Scope confirmed.')
  const revised = await service.execute(supplier, 'save-quote', { rfqId: rfq.id,
    items: [{ id: 'x', unitPrice: 0.3, cost: 0.12 }], leadDays: 10, paymentTerms: 'Net 30' })
  await service.execute(supplier, 'submit-quote', { id: revised.quote.id, confirmed: true })
  assert.equal(service.snapshot(buyer).comparison.length, 1, 'Only latest submitted revision is ranked')
  assert.equal(service.snapshot(buyer).comparison[0].total, 0.45)
  await assert.rejects(service.execute(buyer, 'award', { quoteId: revised.quote.id, confirmed: true }, { agent: true }), /cannot commit/)
  const { order } = await service.execute(buyer, 'award', { quoteId: revised.quote.id, confirmed: true })
  assert.equal(service.snapshot(supplier).orders[0].id, order.id)
  assert.equal(service.snapshot(supplier).quotes.find(row => row.id === revised.quote.id).status, 'awarded')
  assert.equal(service.snapshot(supplier).quotes.find(row => row.id === revised.quote.id).items[0].cost, 0.12)
  await service.execute(supplier, 'acknowledge-order', { id: order.id, confirmed: true })
  assert.equal(service.snapshot(buyer).orders[0].status, 'acknowledged')
  const { change } = await service.execute(supplier, 'propose-change', { orderId: order.id, title: 'Add delivery', amount: 2.15 })
  assert.equal(service.snapshot(buyer).orders[0].total, 0.45)
  await service.execute(buyer, 'approve-change', { id: change.id, confirmed: true })
  assert.equal(service.snapshot(supplier).orders[0].total, 2.6)
  await service.execute(buyer, 'approve-change', { id: change.id, confirmed: true })
  assert.equal(service.snapshot(buyer).orders[0].total, 2.6, 'Duplicate approval must not add twice')
  assert.ok(service.exportCsv(buyer, rfq.id).includes('0.45'))
  await service.execute(buyer, 'seed-demo')
  const count = service.snapshot(buyer).rfqs.length
  const before = context.store.events(buyer.id).length
  assert.equal((await service.execute(buyer, 'seed-demo')).duplicate, true)
  assert.equal(service.snapshot(buyer).rfqs.length, count)
  assert.equal(context.store.events(buyer.id).length, before, 'Second demo load must append no records')
  await assert.rejects(service.execute(second, 'save-quote', { rfqId: 'unknown', items: [] }), /not available/)
  const draftTool = tools.find(tool => tool.name === 'draft_message')
  assert.ok(draftTool, 'Assistant tools registered through a Cordis child context')
  const proposal = await draftTool.execute(supplier, { rfqId: rfq.id, toId: buyer.id, text: 'Negotiation draft only' })
  assert.equal(proposal.action.action, 'send-message')
  assert.ok(!service.snapshot(buyer).messages.some(row => row.text === 'Negotiation draft only'))
  console.log(JSON.stringify({ ok: true, checks: 'real-ledger-QEP; two recipients; private drafts/costs/preferences; exact totals; revision supersession; human order/acknowledgment/change; idempotency; tool proposals',
    rfqs: count, registeredTools: tools.length, registeredRoutes: routes.length, root }))
  await fiber.dispose()
  assert.equal(routes.length, 0)
  assert.equal(navigation.length, 0)
  assert.equal(tools.length, 0)
  console.log('Cordis disposal: routes, navigation and tools removed.')
  const eventCounts = users.map(user => context.store.events(user.id).length)
  fiber = await context.plugin(procurementPlugin)
  assert.deepEqual(users.map(user => context.store.events(user.id).length), eventCounts, 'Remount must not seed again or alter existing work')
  assert.deepEqual(context.procurement.snapshot(demoBuyer).rfqs, demoData.rfqs)
  assert.equal(context.procurement.snapshot(buyer).orders[0].total, 2.6, 'Remount preserves existing commitments')
  console.log('Startup demo: two bids immediately available; new accounts empty; remount appends no events and preserves orders.')
} finally {
  await fiber.dispose()
  await storeFiber.dispose()
  await foundation.dispose()
}
