/** Explicitly opt-in real TypeSafe acceptance on isolated fictional business records. */
import assert from 'node:assert/strict'
import{mkdtempSync,mkdirSync,writeFileSync}from'node:fs'
import{resolve}from'node:path'
import{createHash}from'node:crypto'
import{performance}from'node:perf_hooks'
import{Context}from'../../../../host/node_modules/cordis/lib/index.js'
import * as store from '../../../system/workspace-store/code/index.mjs'
import * as settings from '../../../system/settings/code/index.mjs'
import * as controls from '../../../system/agent-runtime/code/provider-controls.mjs'
import * as usage from '../../../system/agent-runtime/code/product-usage.mjs'
import * as procurement from '../../procurement/code/index.mjs'
import * as advisor from '../code/index.mjs'
import{authoredFixtureInput}from'../../procurement/tests/declared-scope-fixture.mjs'
import{stable}from'../../../system/agent-runtime/code/provider-policy.mjs'
if(process.env.JEV_LIVE!=='1')throw new Error('Set JEV_LIVE=1 to authorize the configured TypeSafe requests for these fictional records.')
const buyer={id:'jev-live-buyer',name:'Fictional contractor',role:'contractor'},supplier={id:'jev-live-supplier',name:'Fictional supplier',role:'supplier'},users=[buyer,supplier],ctx=new Context(),fibers=[],checks=[],cases=[],root=mkdtempSync(resolve('tmp/jev-live-')),directory=resolve(process.env.EVIDENCE_DIR||'tmp/jev-2026-09-28')
mkdirSync(directory,{recursive:true})
fibers.push(await ctx.plugin({name:'live-identity',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true});inner.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})}}))
for(const plugin of[store,settings,controls,usage,procurement,advisor])fibers.push(await ctx.plugin(plugin,plugin===store?{root}:{}))
const run=(user,action,input)=>ctx.procurement.execute(user,action,authoredFixtureInput(action,input))
const quality=[['price','这个单价超过预算，请问批量采购能否给折扣？'],['price','报价每套250元，可以降到230元吗？'],['delivery','请确认这批灯具能否在10月15日前送到工地？如果赶不上，请提供最早交货日期。'],['delivery','生产完成后运输到现场需要多少天？'],['terms','合同里的保修期只有一年，我们要求三年保修，请确认责任范围。'],['terms','能否把付款条件从全额预付改为验收后30天付款？'],['quality','该灯具是否符合IP65防护等级，并提供检测报告？'],['quality','请确认电缆的阻燃等级和导体材质是否符合技术规格。'],['other','谢谢，收到。']]
try{
 assert.equal(ctx.jev.status(buyer).available,true)
 const rfq=(await run(buyer,'create-rfq',{title:'Fictional full lighting package / 完整灯具包',currency:'USD',description:'Supply the explicitly listed IP65 luminaires, deliver to site and exclude installation. Quotation is for evaluation only.',items:Array.from({length:16},(_,i)=>({id:'lamp-'+i,description:`IP65 lamp type ${i+1}, declared 4000K specification`,unit:'each',quantity:12+i})),supplierIds:[supplier.id]})).rfq
 await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
 const quote=(await run(supplier,'save-quote',{rfqId:rfq.id,items:rfq.items.map((row,i)=>({id:row.id,unitPrice:250+i,cost:180+i})),leadDays:21,paymentTerms:'Net30 after delivery',privateNotes:'PRIVATE-LIVE-COST-NOTES',notes:'IP65 lamps supplied as described. Installation excluded. Confirm freight and tax separately.'})).quote
 await run(supplier,'submit-quote',{id:quote.id,confirmed:true})
 const unchanged=JSON.stringify(ctx.procurement.snapshot(buyer).comparison)
 for(const[expected,text]of quality){const start=performance.now(),result=await ctx.advisor.assess(buyer,{mode:'clarification',rfqId:rfq.id,text});cases.push({expected,text,status:result.status,model:result.model,topic:result.answers.topic,urgent:result.answers.urgent,durationMs:Math.round(performance.now()-start),matchesExpected:result.answers.topic?.choice===expected,requiresReview:result.requiresReview,assessmentId:result.id,error:result.error||null});assert.equal(result.status,'completed',result.error)}
 const start=performance.now(),review=await ctx.advisor.assess(buyer,{mode:'quote-review',rfqId:rfq.id,quoteId:quote.id}),durationMs=Math.round(performance.now()-start)
 assert.equal(review.status,'completed',review.error);assert.equal(review.state.request.items.length,16);assert.equal(review.state.quote.items.length,16);assert(!JSON.stringify(review).includes('PRIVATE-LIVE-COST-NOTES'));assert.equal(unchanged,JSON.stringify(ctx.procurement.snapshot(buyer).comparison))
 const events=ctx.store.events(buyer.id),requests=events.filter(row=>row.type==='advisor/model-requested'),responses=events.filter(row=>row.type==='advisor/model-completed'),receipts=events.filter(row=>row.type==='agent/model-usage'&&row.body.provider==='typesafe')
 assert.equal(requests.length,10);assert.equal(responses.length,10);assert.equal(receipts.length,10)
 for(const request of requests){const wire=JSON.stringify(stable(request.body.request));assert.equal(createHash('sha256').update(wire).digest('hex'),request.body.requestSha256);assert.equal(Buffer.byteLength(wire),request.body.requestBytes);assert(!wire.includes('"cost"'))}
 checks.push('Actual configured TypeSafe model completed nine labelled Chinese clarification cases; exact observed labels/confidence/latency retained, finite sample only')
 checks.push('Complete16-line RFQ and received16-line quotation assessed without truncation; all typed model questions and provider answers retained; private cost excluded and deterministic comparison unchanged')
 checks.push('All10 complete request bytes reconstruct to recorded SHA256 and size; actual input/output usage receipts reach existing provider accounting, no fabricated zero usage')
 const result={ok:true,command:'JEV_LIVE=1 node src/domain/advisor/tests/live.mjs',at:new Date().toISOString(),checks,scope:'Real configured TypeSafe endpoint, fictional native Cordis/Python/QEP business records. This is a small task-specific sample, not a model-quality guarantee.',quality:{samples:cases.length,matched:cases.filter(row=>row.matchesExpected).length,cases},completeReview:{durationMs,...review},requests:requests.map(row=>row.body),responses:responses.map(row=>row.body),usage:receipts.map(row=>row.body)}
 writeFileSync(directory+'/live.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,checks,quality:{samples:cases.length,matched:result.quality.matched},completeReview:{durationMs,model:review.model,requestItems:review.state.request.items.length,quoteItems:review.state.quote.items.length,answers:review.answers},evidence:directory+'/live.json'},null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
