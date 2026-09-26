import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'

mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/structured-scope-')),ctx=new Context(),checks=[],fibers=[]
const buyer={id:'buyer',role:'contractor',name:'Buyer'},supplier={id:'supplier',role:'supplier',name:'Supplier'},users=[buyer,supplier]
fibers.push(await ctx.plugin({name:'scope-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true});inner.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})}}));fibers.push(await ctx.plugin(storePlugin,{root}));fibers.push(await ctx.plugin(procurementPlugin))
const run=(user,action,input)=>ctx.procurement.execute(user,action,input)
try{
  const scope={measurementRules:[{id:'length',name:'Installed cable length',dimension:'length',units:[{unit:'m',factor:1},{unit:'cm',factor:0.01},{unit:'bundle',factor:5}]}],interfaces:[{id:'supply',name:'Cable supply and delivery',responsibilityOwner:''}],deliverables:'Labelled cable drums delivered to site',exclusions:'Installation is excluded'}
  let rfq=(await run(buyer,'create-rfq',{title:'Structured cable supply',scope,items:[{id:'cable',description:'Cable',quantity:10,unit:'m',measurementRuleId:'length',interfaceId:'supply'}],supplierIds:[supplier.id]})).rfq
  const before=ctx.store.events(buyer.id).length;await assert.rejects(run(buyer,'publish-rfq',{id:rfq.id,confirmed:true}),/responsibility owner/);assert.equal(ctx.store.events(buyer.id).length,before);assert.equal(ctx.store.get(buyer.id,'rfqs',rfq.id).status,'draft')
  scope.interfaces[0].responsibilityOwner='Supplier';rfq=(await run(buyer,'create-rfq',{id:rfq.id,scope,expectedRevision:rfq.revision})).rfq
  await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true});const received=ctx.store.get(supplier.id,'rfqs',rfq.id);assert.deepEqual(received.scope,rfq.scope);assert.equal(received.items[0].interfaceId,'supply')
  checks.push('Incomplete responsibility remains an editable private draft; structured publication refuses before approval; explicit owner, measurement rule, deliverables and exclusions travel in actual signed QEP')

  const quote=(await run(supplier,'save-quote',{rfqId:rfq.id,commercial:{deviations:[{category:'technical',itemId:'cable',description:'Test insulation standard',priceImpact:'',timeImpactDays:2}]},items:[{id:'cable',unitPrice:0,cost:3,offered:{quantity:1000,unit:'cm',unitPrice:0.05}},{id:'extra-labels',classification:'additional',description:'Spare labels',scopeReason:'Optional spare label pack included in this offer',quantity:1,unit:'pack',unitPrice:2,cost:1}]})).quote
  assert.equal(quote.items[0].unitPrice,5);assert.equal(quote.items[0].total,50);assert.equal(quote.total,52);assert.equal(quote.items[0].normalization.source.quantity,1000)
  await run(supplier,'submit-quote',{id:quote.id,confirmed:true});const publicQuote=ctx.store.get(buyer.id,'quotes',quote.id);assert.equal(publicQuote.items[0].normalization.source.unit,'cm');assert.equal(publicQuote.items[1].classification,'additional');assert.equal(publicQuote.items[0].cost,undefined);assert.equal(publicQuote.commercial.deviations[0].category,'technical');assert.equal(publicQuote.commercial.deviations[0].priceImpact,undefined);assert.equal(publicQuote.commercial.deviations[0].timeImpactDays,2);assert(ctx.procurement.snapshot(buyer).comparison[0].risks.some(row=>row.includes('Additional scope')))
  checks.push('Declared cm→m conversion retains original1000cm×0.05 and exact normalized10m×5; additional pack is separately classified and included; QEP excludes private costs and comparison flags added scope')

  await assert.rejects(run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'cable',unitPrice:1}],commercial:{deviations:[{category:'guessed',description:'Invalid type'}]}}),/deviation category/)
  const supplierEvents=ctx.store.events(supplier.id).length
  await assert.rejects(run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'cable',unitPrice:2,offered:{quantity:10,unit:'kg',unitPrice:2}}]}),/compatible measurement/)
  assert.equal(ctx.store.events(supplier.id).length,supplierEvents+1);assert.equal(ctx.store.events(supplier.id).at(-1).type,'procurement/normalization-refused');assert(ctx.store.events(supplier.id).at(-1).body.nextAction)
  await assert.rejects(run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'cable',unitPrice:1,quantity:9}]}),/quantity must match/)
  await assert.rejects(run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'cable',unitPrice:0,offered:{quantity:2,unit:'bundle',unitPrice:0.01}}]}),/fractional cent/)
  const alternative=(await run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'alternate-cable',classification:'alternative',sourceItemId:'cable',description:'Precut cable set',scopeReason:'Two prefabricated sets replace the original cable line',quantity:2,unit:'set',unitPrice:24}]})).quote
  await run(supplier,'submit-quote',{id:alternative.id,confirmed:true});assert.equal(ctx.store.get(buyer.id,'quotes',alternative.id).items[0].sourceItemId,'cable');assert(ctx.procurement.snapshot(buyer).comparison[0].risks.some(row=>row.includes('Alternative scope')))
  checks.push('Unknown/incompatible units and unauthorized base quantity changes refuse with a durable local explanation; explicit alternative has a distinct identity, original line reference and visible scope risk')

  const amendment=(await run(buyer,'save-amendment',{rfqId:rfq.id,expectedRevision:1,scope:{...scope,deliverables:'Revised delivery includes lifting'},reason:'Clarify lifting responsibility'})).amendment
  assert(amendment.delta.some(row=>row.field==='scope'));await run(buyer,'publish-amendment',{id:amendment.id,confirmed:true});assert.equal(ctx.store.get(supplier.id,'rfqs',rfq.id).scope.deliverables,'Revised delivery includes lifting');assert(ctx.procurement.snapshot(buyer).quotes.find(row=>row.id===alternative.id).stale)
  checks.push('Structured scope amendments create field-level deltas, publish immutable revision2 and stale the old-scope quotations')
  const cutoff=(await run(buyer,'create-rfq',{title:'Explicit clarification cutoff',deadline:'2099-01-02',clarifyDeadline:'2020-01-01T12:00',items:[{id:'p',description:'Panel',quantity:1,unit:'each'}],supplierIds:[supplier.id]})).rfq
  assert.equal(cutoff.clarifyDeadline,'2020-01-01T12:00:00.000Z');await run(buyer,'publish-rfq',{id:cutoff.id,confirmed:true});assert.equal(ctx.store.get(supplier.id,'rfqs',cutoff.id).clarifyDeadline,cutoff.clarifyDeadline)
  const questionsBefore=ctx.store.list(supplier.id,'clarifications').length;await assert.rejects(run(supplier,'ask-clarification',{rfqId:cutoff.id,question:'Late question',confirmed:true}),/deadline has passed/);assert.equal(ctx.store.list(supplier.id,'clarifications').length,questionsBefore)
  await assert.rejects(run(buyer,'save-amendment',{rfqId:cutoff.id,expectedRevision:1,clarifyDeadline:'2099-01-03T12:00',reason:'Invalid deadline order'}),/later than/)
  const cutoffChange=(await run(buyer,'save-amendment',{rfqId:cutoff.id,expectedRevision:1,clarifyDeadline:'2099-01-01T12:00',reason:'Explicitly reopen clarification window'})).amendment
  await run(buyer,'publish-amendment',{id:cutoffChange.id,confirmed:true});const question=(await run(supplier,'ask-clarification',{rfqId:cutoff.id,rfqRevision:2,question:'Question in amended window',confirmed:true})).clarification;assert.equal(question.rfqRevision,2)
  checks.push('Typed technical deviation retains declared two-day impact and unknown price impact; unknown category refuses. Published UTC clarification cutoff blocks late questions until a reviewed amendment extends it; cutoff cannot exceed quote deadline')
  const report={ok:true,root,checks,ids:{rfq:rfq.id,quote:quote.id,alternative:alternative.id},at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
