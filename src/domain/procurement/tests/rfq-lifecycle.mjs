import {authoredFixtureInput} from './declared-scope-fixture.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import { configureReviewer, grantAndSign } from './review-fixture.mjs'
import * as actionsPlugin from '../../../system/action-center/code/index.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { Context } = require('cordis')
mkdirSync('tmp', { recursive: true })
const root = mkdtempSync(resolve('tmp/rfq-lifecycle-'))
const buyer = { id: 'buyer', name: 'Buyer', role: 'contractor', email: 'buyer@example.test' }
const one = { id: 'supplier-one', name: 'One', role: 'supplier', email: 'one@example.test' }
const two = { id: 'supplier-two', name: 'Two', role: 'supplier', email: 'two@example.test' }
const outsider = { id: 'other-buyer', name: 'Other buyer', role: 'contractor', email: 'other@example.test' }
const reviewer = {id:'reviewer',name:'Reviewer',role:'contractor',email:'reviewer@example.test'}
const users = [buyer, one, two, outsider, reviewer], tools = [], routes = []
async function mount() {
  const ctx = new Context(), fibers = []
  fibers.push(await ctx.plugin({ name: 'test-services', apply(inner) {
    const add = (list, item) => { list.push(item); return () => list.splice(list.indexOf(item), 1) }
    inner.provide('accounts', { list: () => structuredClone(users), get: id => structuredClone(users.find(user => user.id === id)), can: () => true })
    inner.provide('web', { route: (...args) => add(routes, args), contribute: () => () => {} })
    inner.provide('assistant', { tool: tool => add(tools, tool) })
  } }))
  fibers.push(await ctx.plugin(storePlugin, { root })); fibers.push(await ctx.plugin(teamsPlugin)); fibers.push(await ctx.plugin(actionsPlugin)); fibers.push(await ctx.plugin(procurementPlugin))
  return { ctx, dispose: async () => { for (const fiber of [...fibers].reverse()) await fiber.dispose() } }
}
let mounted = await mount(), ctx = mounted.ctx
const checks = []
try {
  await configureReviewer(ctx,buyer,reviewer,'GBP')
  const service = ctx.procurement, run = (user, action, input, options) => service.execute(user, action, authoredFixtureInput(action,input), options)
  const missingImpacts = service.normalizeCommercial({}, { deviations: [{ description: 'Needs review', priceImpact: '', timeImpactDays: '' }] }, []).deviations[0]
  assert.equal(missingImpacts.priceImpact, undefined); assert.equal(missingImpacts.timeImpactDays, undefined)
  assert.throws(() => service.normalizeCommercial({}, { taxRate: true }, []), /explicit number/)
  assert.throws(() => service.normalizeCommercial({}, { freight: ' ' }, []), /explicit number/)
  const { project } = await run(buyer, 'save-project', { name: 'Hospital redevelopment', currency: 'GBP', calendar: 'Deliver weekdays after induction.' })
  const { section } = await run(buyer, 'save-section', { projectId: project.id, name: 'Electrical services', description: 'Phase one' })
  assert.equal(service.snapshot(one).projects.length, 0)
  await assert.rejects(run(outsider, 'save-section', { projectId: project.id, name: 'Unauthorized' }), /not available/)
  const items = [{ id: 'panel', description: '40W LED panel', quantity: 10, unit: 'each' }]
  const { rfq } = await run(buyer, 'create-rfq', { title: 'Versioned lighting', projectId: project.id, sectionId: section.id, currency: 'GBP', items, supplierIds: [one.id, two.id], requirements: { deliveryBy: '2026-12-01', warrantyMonths: 36 } })
  await run(buyer, 'create-rfq', { id: rfq.id, description: 'Private edit should not make a public version.' })
  await run(buyer, 'publish-rfq', { id: rfq.id, confirmed: true })
  assert.equal(service.snapshot(one).rfqs[0].publishedRevision, 1)
  assert.equal(service.snapshot(one).rfqVersions.length, 1)
  assert.equal(service.snapshot(one).rfqs[0].projectName, project.name)
  assert.equal(service.snapshot(one).rfqs[0].requirements.warrantyMonths, 36)
  assert.deepEqual(service.snapshot(one).rfqs[0].supplierIds, [one.id])
  const { quote } = await run(one, 'save-quote', { rfqId: rfq.id, rfqRevision: 1, items: [{ id: 'panel', unitPrice: 20, cost: 12 }], leadDays: 7, paymentTerms: 'Net30', commercial: { taxMode: 'exclusive', taxRate: 20, freight: 25, validityUntil: '2026-12-15', advancePercent: 10, deliveryBinding: 'firm', deviations: [{ itemId: 'panel', description: 'Alternative housing', priceImpact: -2, timeImpactDays: 1 }] } })
  const staleDraft = (await run(two, 'save-quote', { rfqId: rfq.id, items: [{ id: 'panel', unitPrice: 21 }], leadDays: 9, paymentTerms: 'Net30' })).quote
  await run(one, 'submit-quote', { id: quote.id, confirmed: true })
  assert.equal(quote.subtotal, 200); assert.equal(quote.total, 265); assert.equal(quote.priceBreakdown.taxAmount, 40)
  assert.equal(service.normalizeQuotePrice([{quantity:10,unitPrice:20}],{taxMode:'exclusive',taxRate:20,freight:25}).total,265)
  assert.equal(service.snapshot(buyer).quotes[0].commercial.freight, 25)
  assert.equal(service.snapshot(buyer).quotes[0].items[0].cost, undefined)
  assert.equal(service.snapshot(buyer).comparison.length, 1)
  const expired = (await run(two, 'save-quote', {rfqId:rfq.id,items:[{id:'panel',unitPrice:22}],commercial:{validityUntil:'2000-01-01'}})).quote
  await assert.rejects(run(two,'submit-quote',{id:expired.id,confirmed:true}),/expired/)
  const untaxed = (await run(two, 'save-quote', {rfqId:rfq.id,items:[{id:'panel',unitPrice:22}],commercial:{taxMode:'exclusive'}})).quote
  await assert.rejects(run(two,'submit-quote',{id:untaxed.id,confirmed:true}),/tax rate/)
  checks.push('Private project/section ownership; public labels only; initial publication revision; public commercial whitelist and cost exclusion')
  const { clarification } = await run(one, 'ask-clarification', { rfqId: rfq.id, question: 'Is commissioning included?', itemIds: ['panel'], rfqRevision: 1, confirmed: true })
  assert.equal(service.snapshot(two).clarifications.length, 0, 'Unanswered supplier question stays private to asker and buyer')
  await run(buyer, 'save-clarification-answer', { id: clarification.id, answer: 'Include commissioning and certification.', rfqRevision: 1 }, { agent: true })
  assert.equal(service.snapshot(one).clarifications[0].draftAnswer, undefined)
  assert.equal(service.snapshot(two).clarifications.length, 0)
  await assert.rejects(run(buyer, 'broadcast-clarification', { id: clarification.id, confirmed: true }, { agent: true }), /cannot commit/)
  const prepare = tools.find(tool => tool.name === 'prepare_rfq_lifecycle_review')
  const proposed = await prepare.execute(buyer, { action: 'broadcast-clarification', id: clarification.id }, { source: 'workflow', runId: 'test-run' })
  assert.equal(proposed.proposal.runId, 'test-run')
  assert.equal(proposed.proposal.input.preview.recipients.length, 2)
  await run(buyer, 'save-clarification-answer', { id: clarification.id, answer: 'Include commissioning, certification and training.' })
  const refused = await ctx.actions.approve(buyer, proposed.proposal.id, { confirmed: true })
  assert.equal(refused.status, 'failed'); assert.match(refused.error, /changed after/)
  const actualExchange = ctx.store.exchange
  let once = true
  ctx.store.exchange = async (...args) => { if (once && args[1] === two.id && args[2] === 'clarifications') { once = false; throw new Error('Temporary supplier delivery failure') }; return actualExchange(...args) }
  await assert.rejects(run(buyer, 'broadcast-clarification', { id: clarification.id, confirmed: true }), /Temporary/)
  assert.equal(service.snapshot(buyer).clarifications[0].status, 'broadcasting', 'Partial broadcast must not close')
  await run(buyer, 'broadcast-clarification', { id: clarification.id, confirmed: true })
  ctx.store.exchange = actualExchange
  for (const user of [one, two]) {
    const ticket = service.snapshot(user).clarifications[0]
    assert.equal(ticket.status, 'closed'); assert.match(ticket.answer, /training/)
    assert.equal(ticket.askerId, undefined); assert.equal(ticket.deliveredIds, undefined); assert.equal(ticket.draftAnswer, undefined)
  }
  const { faq } = await run(buyer, 'save-faq', { clarificationId: clarification.id })
  assert.equal(faq.source.rfqRevision, 1); assert.equal(service.snapshot(two).faqs.length, 0)
  checks.push('Private agent answer; frozen review rejects edits; interrupted broadcast remains open and retries; complete anonymized shared answer; source-linked account FAQ')
  const changedItems = [{ ...items[0], quantity: 12 }, { id: 'sensor', description: 'Occupancy sensor', quantity: 2, unit: 'each' }]
  const amendment = (await run(buyer, 'save-amendment', { rfqId: rfq.id, expectedRevision: 1, items: changedItems, reason: 'Add two panels and sensors for revised room plan.' }, { agent: true })).amendment
  const competing = (await run(buyer, 'save-amendment', { rfqId: rfq.id, expectedRevision: 1, description: 'Competing draft', reason: 'Another revision' })).amendment
  assert.equal(service.snapshot(one).rfqs[0].items.length, 1, 'Saved amendment must stay private')
  await assert.rejects(run(buyer, 'publish-amendment', { id: amendment.id }), /confirm/)
  await run(buyer, 'publish-amendment', { id: amendment.id, confirmed: true })
  const buyerData = service.snapshot(buyer)
  assert.equal(buyerData.rfqs[0].publishedRevision, 2); assert.equal(buyerData.rfqVersions.length, 2)
  assert.equal(buyerData.rfqVersions.find(row => row.publishedRevision === 1).snapshot.items[0].quantity, 10)
  assert.equal(buyerData.quotes[0].stale, true); assert.equal(buyerData.comparison.length, 0)
  for (const user of [one, two]) {
    const data = service.snapshot(user)
    assert.equal(data.rfqs[0].publishedRevision, 2); assert.equal(data.rebidRequests[0].rfqRevision, 2)
    assert.equal(data.clarifications[0].status, 'open'); assert.equal(data.clarifications[0].answer, undefined)
    assert.match(data.clarifications[0].previousAnswers[0].answer, /training/)
  }
  await assert.rejects(run(buyer, 'publish-amendment', { id: competing.id, confirmed: true }), /changed after/)
  await assert.rejects(run(one, 'submit-quote', { id: quote.id, confirmed: true }), /Rebid/)
  await assert.rejects(run(two, 'submit-quote', { id: staleDraft.id, confirmed: true }), /Rebid/)
  await assert.rejects(run(buyer, 'propose-award', { quoteId: quote.id, reason:'Cannot award stale scope', confirmed: true }), /older request/)
  await assert.rejects(run(one, 'save-quote', { rfqId: rfq.id, rfqRevision: 1, items: [{ id: 'panel', unitPrice: 20 }] }), /changed to revision/)
  await assert.rejects(run(buyer, 'save-amendment', { rfqId: rfq.id, expectedRevision: 2, supplierIds: [one.id], reason: 'Remove other supplier' }), /keep all previously/)
  checks.push('Immutable public versions; private amendment; stale quote comparison, submit and award refusal; old-scope concurrency refusal; complete rebid and reopened-answer provenance')
  const rebid = (await run(one, 'save-quote', { rfqId: rfq.id, rfqRevision: 2, commercial: {taxMode:'exclusive',taxRate:20,freight:25,warrantyMonths:36}, items: [{ id: 'panel', unitPrice: 20, cost: 12 }, { id: 'sensor', unitPrice: 30 }], leadDays: 10, paymentTerms: 'Net30' })).quote
  await run(one, 'submit-quote', { id: rebid.id, confirmed: true })
  assert.equal(service.snapshot(buyer).comparison.length, 1); assert.equal(service.snapshot(buyer).comparison[0].total, 385)
  await run(buyer, 'save-clarification-answer', { id: clarification.id, faqId: faq.id })
  assert.equal(service.snapshot(buyer).clarifications[0].answerSource.id, faq.id)
  assert.equal(service.snapshot(one).clarifications[0].status, 'open', 'FAQ reuse is a private draft, not auto-broadcast')
  await run(buyer, 'broadcast-clarification', { id: clarification.id, confirmed: true })
  await run(buyer, 'archive-faq', { id: faq.id })
  assert.equal(service.snapshot(buyer).faqs[0].status, 'archived')
  assert.ok(!JSON.stringify(ctx.store.events(two.id)).includes('supplier-one'), 'Another supplier identity must not enter recipient ledger')
  const intent=(await run(buyer,'propose-award',{quoteId:rebid.id,reason:'Current complete scope',confirmed:true})).awardIntent
  await run(one,'confirm-award',{id:intent.id,confirmed:true})
  const proposal=await tools.find(tool=>tool.name==='prepare_commitment').execute(buyer,{action:'sign-order',id:intent.id},{source:'human'})
  const {order}=await grantAndSign(ctx,buyer,reviewer,proposal)
  assert.equal(order.total,385); assert.equal(order.priceBreakdown.taxAmount,60); assert.equal(service.snapshot(one).orders[0].total,385)
  const before = service.snapshot(buyer)
  await mounted.dispose(); assert.equal(tools.length, 0); assert.equal(routes.length, 0)
  mounted = await mount(); ctx = mounted.ctx
  const after = ctx.procurement.snapshot(buyer)
  for (const key of ['rfqs', 'quotes', 'projects', 'sections', 'clarifications', 'rfqVersions', 'amendments', 'faqs', 'rebidRequests']) assert.deepEqual(after[key], before[key], `Restart reconstructs ${key}`)
  checks.push('Current-scope rebid restores comparison; FAQ reuse remains private; archive retained; real Ledger/QEP replay and effect disposal')
  console.log(JSON.stringify({ ok: true, checks, root, rfqId: rfq.id, quoteId: rebid.id, ledgerEvents: ctx.store.events(buyer.id).length }, null, 2))
} finally { await mounted.dispose() }
