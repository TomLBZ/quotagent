import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as settingsPlugin from '../../../system/settings/code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import * as actionsPlugin from '../../../system/action-center/code/index.mjs'
import * as procurementPlugin from '../../procurement/code/index.mjs'
import * as commercialPlugin from '../code/index.mjs'
import { defaultPolicy, calculateEvaluation } from '../code/evaluation.mjs'
import { multiply, schedulePlan } from '../code/arithmetic.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { Context } = require('cordis')
mkdirSync('tmp',{recursive:true}); const root=mkdtempSync(resolve('tmp/commercial-smoke-'))
const buyer={id:'buyer',name:'Buyer',role:'contractor',email:'buyer@example.test'},one={id:'supplier-one',name:'One',role:'supplier',email:'one@example.test'},two={id:'supplier-two',name:'Two',role:'supplier',email:'two@example.test'},other={id:'other',name:'Other buyer',role:'contractor'},admin={id:'admin',role:'admin'}
const member={id:'member',name:'Buyer analyst',role:'contractor',email:'member@example.test'},users=[buyer,one,two,other,admin,member],routes=[],tools=[],navigation=[],checks=[]
for(const user of users)user.email ||= `${user.id}@example.test`
async function mount(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin({name:'test-services',apply(inner){const add=(list,value)=>{list.push(value);return()=>list.splice(list.indexOf(value),1)};inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(user=>user.id===id)),can:user=>!user.permissions?.includes('workspace:read-only')});inner.provide('web',{route:(...args)=>add(routes,args),contribute:item=>add(navigation,item)});inner.provide('assistant',{tool:tool=>add(tools,tool)})}}));for(const plugin of [storePlugin,settingsPlugin,teamsPlugin,actionsPlugin,procurementPlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}));const commercial=await ctx.plugin(commercialPlugin);return {ctx,commercial,dispose:async()=>{await commercial.dispose();for(const fiber of fibers.reverse())await fiber.dispose()}}}
let mounted=await mount(),ctx=mounted.ctx
try{
 const invitation=await ctx.teams.invite(buyer,{email:member.email,roleId:'lead'});await ctx.teams.answerInvite(member,invitation.id,true);await ctx.teams.select(member,buyer.id)
 const run=(user,action,input,context)=>ctx.commercial.execute(user,action,input,context),business=(user,action,input)=>ctx.procurement.execute(user,action,input)
 const items=[{id:'panel',description:'LED panel',quantity:10,unit:'each'}]
 const {rfq}=await business(buyer,'create-rfq',{title:'Commercial fixture',currency:'GBP',items,supplierIds:[one.id,two.id],requirements:{deliveryBy:'2026-10-20',paymentDays:30,warrantyMonths:12,penaltyPercent:2}})
 await business(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
 const terms={taxMode:'inclusive',freight:0,advancePercent:0,paymentDays:30,warrantyMonths:12,penaltyPercent:2,validityUntil:'2027-12-01',deliveryBinding:'firm',deviations:[]}
 let q1=(await business(one,'save-quote',{rfqId:rfq.id,rfqRevision:1,items:[{id:'panel',unitPrice:100,cost:55}],leadDays:10,commercial:terms})).quote
 let q2=(await business(two,'save-quote',{rfqId:rfq.id,rfqRevision:1,currency:'EUR',items:[{id:'panel',unitPrice:80}],leadDays:30,commercial:{...terms,taxMode:'exclusive',taxRate:10,freight:20,advancePercent:50,paymentDays:10,warrantyMonths:6,penaltyPercent:0,deviations:[{description:'Alternative finish',priceImpact:-10},{description:'Certification impact not known'}]}})).quote
 const costInput={quoteId:q1.id,items:[{itemId:'panel',material:40,labor:10,equipment:5,overhead:10,risk:2,finance:1,tax:20,source:'Private factory worksheet, fixture'}]}
 const costs=(await run(one,'save-costs',costInput)).costs
 assert.equal(costs.total,747.78);assert.equal(costs.items[0].factors.overhead.amount,55);assert.equal(costs.items[0].factors.finance.amount,6.05);assert.equal(costs.items[0].factors.tax.amount,124.63)
 await assert.rejects(run(one,'save-costs',{...costInput,items:[{...costInput.items[0],risk:''}]}),/required/)
 assert.equal(multiply(100_000_000,0.00000001),1)
 await ctx.settings.save(one,'commercial',{values:{minimumMarginPercent:25}})
 let proposal=await run(one,'propose-prices',{quoteId:q1.id,targetMarginPercent:20},{agent:true,source:'workflow',runId:'pricing-run'})
 assert.equal(proposal.proposal.belowFloor,true);assert.equal(proposal.approval.proposedBy,'agent');assert.equal(proposal.approval.runId,'pricing-run');assert.equal(ctx.procurement.snapshot(one).quotes[0].items[0].unitPrice,100)
 await assert.rejects(ctx.actions.approve(one,proposal.approval.id,{}),/Confirm/)
 await run(one,'save-terms',{quoteId:q1.id,commercial:{...terms,freight:25}})
 const stale=await ctx.actions.approve(one,proposal.approval.id,{confirmed:true});assert.equal(stale.status,'failed');assert.match(stale.error,/changed|Rebuild/)
 await run(one,'save-costs',costInput);proposal=await run(one,'propose-prices',{quoteId:q1.id,targetMarginPercent:20})
 assert.equal(proposal.proposal.subtotal,934.7);assert.equal(proposal.proposal.total,959.7)
 const approved=await ctx.actions.approve(one,proposal.approval.id,{confirmed:true});assert.equal(approved.status,'succeeded',approved.error)
 const priceApplied=ctx.procurement.snapshot(one).quotes[0];assert.equal(priceApplied.total,959.7);assert.equal(priceApplied.status,'draft')
 await ctx.actions.approve(one,proposal.approval.id,{confirmed:true});assert.equal(ctx.procurement.snapshot(one).quotes[0].revision,priceApplied.revision)
 checks.push('Seven sourced cost factors, exact cents, explicit missing versus zero; below-floor human review, workflow attribution, stale refusal, exact tax/freight preview, idempotent draft application')
 const beforeLead=priceApplied.leadDays
 await run(one,'save-calendar',{unit:'hours',unitsPerDay:8,workingDays:[1,2,3,4,5],source:'Factory availability fixture',exceptions:[{date:'2026-10-05',units:0}]})
 const planInput={quoteId:q1.id,startDate:'2026-10-05',targetDate:'2026-10-07',tasks:[{id:'make',name:'Fabricate',effort:16,minDays:1,dependsOn:[]},{id:'inspect',name:'Inspect',effort:8,minDays:1,dependsOn:['make'],dueDate:'2026-10-07'}]}
 const plan=(await run(one,'save-plan',planInput)).plan;assert.equal(plan.schedule.finishDate,'2026-10-08');assert.equal(plan.schedule.flags.length,2);assert.deepEqual(plan.schedule.criticalPath,['make','inspect'])
 const overlap=(await run(one,'save-plan',{...planInput,targetDate:'2026-10-09',tasks:[{id:'other',name:'Other work',effort:8,minDays:1}]})).plan;assert.equal(overlap.schedule.finishDate,'2026-10-09')
 await assert.rejects(run(one,'save-plan',{...planInput,tasks:[{id:'a',name:'A',effort:1,minDays:1,dependsOn:['b']},{id:'b',name:'B',effort:1,minDays:1,dependsOn:['a']}]}),/cycle/)
 await run(one,'archive-plan',{id:plan.id});await run(one,'archive-plan',{id:overlap.id})
 assert.equal(ctx.procurement.snapshot(one).quotes[0].leadDays,beforeLead)
 checks.push('Capacity exceptions, dependencies, milestone shortage, other-plan reservations, cycle rejection and archival release; firm quotation lead time unchanged')
 q1=(await business(one,'save-quote',{id:q1.id,rfqId:rfq.id,rfqRevision:1,items:[{id:'panel',unitPrice:100,cost:74.78}],leadDays:10,commercial:terms})).quote
 await business(one,'submit-quote',{id:q1.id,confirmed:true});await business(two,'submit-quote',{id:q2.id,confirmed:true})
 assert.equal(ctx.procurement.snapshot(buyer).quotes.find(row=>row.id===q2.id).total,900)
 await run(buyer,'save-policy',{rfqId:rfq.id,policy:{...defaultPolicy,timeCostPerDay:10,warrantyCostPerMonth:5,source:'Fixture policy'}})
 await run(buyer,'save-fx',{from:'EUR',to:'GBP',rate:1.2,effectiveAt:'2026-10-01T00:00:00Z',expiresAt:'2026-10-01T10:00:00Z',source:'Expired fixture rate'})
 const evaluationInput={rfqId:rfq.id,currency:'GBP',asOf:'2026-10-01T12:00:00Z'}
 let evaluation=(await run(buyer,'evaluate',evaluationInput)).evaluation
 assert.equal(evaluation.rows.find(row=>row.quoteId===q2.id).amounts.price.value,null)
 await run(buyer,'save-fx',{from:'EUR',to:'GBP',rate:1.2,effectiveAt:'2026-10-01T10:30:00Z',expiresAt:'2026-10-02T12:00:00Z',source:'Reviewed current fixture rate'})
 await run(buyer,'save-reference',{description:'LED panel',unit:'each',unitPrice:300,currency:'GBP',observedAt:'2026-09-30T12:00:00Z',source:'Manual comparable fixture'})
 evaluation=(await run(buyer,'evaluate',evaluationInput)).evaluation
 const row1=evaluation.rows.find(row=>row.quoteId===q1.id),row2=evaluation.rows.find(row=>row.quoteId===q2.id)
 assert.equal(row1.amounts.price.value,1000);assert.equal(row1.amounts.payment.value,6.58);assert.equal(row1.tco.value,1006.58)
 assert.equal(row2.amounts.price.value,1080);assert.equal(row2.amounts.delivery.value,110);assert.equal(row2.amounts.payment.value,1.18);assert.equal(row2.amounts.warranty.value,30);assert.equal(row2.amounts.deviation.value,-12);assert.equal(row2.tco.value,1209.18)
 assert.equal(row2.unquantifiedDeviations.length,1);assert.equal(row1.rank.value,1);assert(row1.flags.some(row=>row.kind==='reference-price-anomaly'));assert(row2.flags.some(row=>row.kind==='payment-conflict'))
 assert.equal((await run(buyer,'evaluate',evaluationInput)).evaluation.id,evaluation.id)
 for(const row of evaluation.rows)for(const measure of [...Object.values(row.amounts),row.tco,row.score,row.rank])for(const source of measure.citations){const event=ctx.store.events(buyer.id).find(event=>event.seq===source.seq);assert(event);assert.equal(source.hash,event.entry_hash);assert.equal(event.body.record.id,source.recordId)}
 const withoutFlags=structuredClone(evaluation.basis);withoutFlags.references=[];withoutFlags.policy.lowPricePercent=0
 assert.deepEqual(calculateEvaluation(withoutFlags).rows.map(row=>row.score.value),evaluation.rows.map(row=>row.score.value),'Flags must not affect arithmetic/score')
 // Explicit price-only then warranty-only policies give different deterministic ranking on controlled exact snapshots.
 const alternate=structuredClone(evaluation.basis);alternate.quotes.find(row=>row.id===q1.id).commercial.warrantyMonths=0;alternate.quotes.find(row=>row.id===q2.id).commercial.warrantyMonths=24
 alternate.policy.weights={price:100,delivery:0,payment:0,warranty:0,deviation:0};const byPrice=calculateEvaluation(alternate)
 alternate.policy.weights={price:0,delivery:0,payment:0,warranty:100,deviation:0};const byWarranty=calculateEvaluation(alternate)
 assert.notEqual(byPrice.rows.find(row=>row.rank.value===1).quoteId,byWarranty.rows.find(row=>row.rank.value===1).quoteId)
 await run(buyer,'save-assumptions',{quoteId:q2.id,commercial:{freight:0},source:'Explicit fixture assumption'})
 const assumption=ctx.commercial.state(buyer).assumptions[0];assert.equal(assumption.commercial.freight,0)
 const changed=structuredClone(evaluation.basis);changed.assumptions={[q2.id]:{...assumption,quoteRevision:0}};assert(calculateEvaluation(changed).rows.find(row=>row.quoteId===q2.id).flags.some(flag=>flag.kind==='stale-assumptions'))
 checks.push('Five exact TCO components, exclusive tax/freight not double-counted, timestamp-valid FX, unknowns distinct from zero, immutable content identity, all citations resolvable, weight-driven ranking, warning independence and stale assumption refusal')
 const history=ctx.commercial.state(buyer).history;assert.equal(history.length,2);assert.equal(history[0].quoteCount,1);assert.equal(history[0].trend,'insufficient history');assert(history.every(row=>!Object.hasOwn(row,'rank')&&!Object.hasOwn(row,'score')))
 assert.equal(ctx.commercial.state(one).history.length,1);assert.equal(ctx.commercial.state(two).costs.length,0);assert.equal(ctx.commercial.state(buyer).costs.length,0);assert(!JSON.stringify(ctx.commercial.state(buyer)).includes('Private factory worksheet'))
 assert.throws(()=>ctx.commercial.state(admin),/supplier or contractor/);await assert.rejects(run(other,'save-policy',{rfqId:rfq.id,policy:defaultPolicy}),/available/);await assert.rejects(run(two,'save-costs',costInput),/available/)
 const {order}=await business(buyer,'award',{quoteId:q1.id,confirmed:true})
 assert(ctx.commercial.state(buyer).referencePrices.some(row=>row.kind==='award'&&row.sourceRef.collection==='orders'))
 await run(buyer,'save-erp-mapping',{columns:{poNumber:'po_number',itemId:'item_id',quantity:'quantity',unitPrice:'unit_price',currency:'currency'},identityIds:true,orderMap:[],itemMap:[]})
 const exported=ctx.commercial.exportCsv(buyer,'orders'),imported=(await run(buyer,'import-erp',{csv:exported,filename:'round-trip.csv'})).import
 assert.equal(imported.status,'matched');assert.equal(imported.rows[0].quantity,10);assert.equal(imported.rows[0].unitPrice,100)
 const broken=(await run(buyer,'import-erp',{csv:'po_number,item_id,quantity,unit_price\nUNKNOWN,UNKNOWN,10,100\n',filename:'bad-mapping.csv'})).import
 assert.equal(broken.status,'needs-review');assert.equal(broken.rows[0].raw.po_number,'UNKNOWN');assert.equal(broken.rows[0].status,'mapping-error');assert.match(broken.raw,/UNKNOWN/)
 const report=(await run(buyer,'create-report',{from:'2026-01-01',to:'2099-12-31'})).report
 assert.equal(report.quoteCount,2);assert.equal(report.orderCount,1);assert.equal(report.valueByCurrency[0].value,1000);assert.match(ctx.commercial.exportCsv(buyer,'report',report.id),/order/)
 const memberState=ctx.commercial.state(member);assert.equal(memberState.quotes.length,2);assert.equal(memberState.evaluations.length,0);assert.equal(memberState.history[0].entries[0].sourceRef.realm,buyer.id)
 await run(member,'save-policy',{rfqId:rfq.id,policy:defaultPolicy});const memberAnalysis=(await run(member,'evaluate',evaluationInput)).evaluation;assert.equal(memberAnalysis.basis.sources.rfq.realm,buyer.id);assert.equal(memberAnalysis.sourceRef.realm,member.id);assert.equal(ctx.commercial.state(buyer).policies[0].policy.source,'Fixture policy')
 checks.push('Own-realm descriptive supplier history without ratings; costs/competitors isolated; awarded source fallback; explicit ERP export/import, retained failed mapping and currency-separated report')
 // Frozen received scope can be excluded without mutating an awarded RFQ.
 const staleBasis=structuredClone(evaluation.basis);staleBasis.quotes[0].stale=true;const excluded=calculateEvaluation(staleBasis);assert.equal(excluded.excluded.length,1);assert.equal(excluded.rows.length,1)
 const evaluationId=evaluation.id
 await mounted.commercial.dispose();assert.equal(ctx.get('commercial'),undefined);assert(!routes.some(row=>row[1].startsWith('/commercial')));assert(!tools.some(tool=>tool.name==='commercial_workspace'));assert(!navigation.some(row=>row.id==='commercial'));assert(!ctx.settings.list(one).some(row=>row.id==='commercial'))
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx
 assert(ctx.commercial.state(buyer).evaluations.some(row=>row.id===evaluationId));assert.equal(ctx.commercial.state(one).costs[0].total,747.78)
 const tool=tools.find(tool=>tool.name==='commercial_workspace');assert(tool);assert.equal(tool.effect,'read');assert.equal(tool.execute(one,{}).costs[0].sourceRef.recordId,`cost-${q1.id}`)
 checks.push('RFQ stale scope excluded; native unload removes service/routes/navigation/settings/tools; actual ledger remount reconstructs costs/evaluations/source references')
 const result={passed:checks.length,checks,root,at:new Date().toISOString()};writeFileSync(resolve(root,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}finally{await mounted.dispose()}
