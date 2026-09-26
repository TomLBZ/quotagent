import {authoredFixtureInput} from './declared-scope-fixture.mjs'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
import * as actionsPlugin from '../../../system/action-center/code/index.mjs'
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/procurement-negotiation-')),checks=[]
const buyer={id:'buyer',role:'contractor',name:'Buyer'},supplier={id:'supplier',role:'supplier',name:'Supplier'},users=[buyer,supplier]
async function mount(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin({name:'negotiation-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true});inner.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})}}));for(const plugin of[storePlugin,actionsPlugin,procurementPlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}));return{ctx,dispose:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}}
let mounted=await mount(),ctx=mounted.ctx
try{
 const run=(user,action,input,options)=>ctx.procurement.execute(user,action,authoredFixtureInput(action,input),options)
 const rfq=(await run(buyer,'create-rfq',{title:'Private bounded negotiation',items:[{id:'panel',description:'Panel',quantity:10,unit:'each'}],supplierIds:[supplier.id]})).rfq;await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
 const quote=(await run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'panel',unitPrice:20,cost:12}],paymentTerms:'Net30'})).quote;await run(supplier,'submit-quote',{id:quote.id,confirmed:true})
 await assert.rejects(run(supplier,'open-negotiation',{quoteId:quote.id,itemId:'panel',policy:{}}),/Minimum authorized/)
 const policy={maxRounds:5,maxConcessionPercent:20,minimumCostUpliftPercent:50,minUnitPrice:10,maxUnitPrice:25,costSource:'quote'}
 const thread=(await run(supplier,'open-negotiation',{quoteId:quote.id,itemId:'panel',policy})).thread
 assert.equal(thread.openingBasis.floorCents,1800);assert(thread.openingBasis.costs.sourceRef.hash)
 await assert.rejects(run(supplier,'revise-negotiation-policy',{threadId:thread.id,policy,reason:'Model override'},{agent:true}),/cannot commit/)
 await assert.rejects(run(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:10,reason:'Too large reduction'},{agent:true}),error=>error.code==='CONCESSION_LIMIT')
 await assert.rejects(run(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:17.5,reason:'Below sourced floor'},{agent:true}),error=>error.code==='PRIVATE_FLOOR')
 assert.equal(ctx.procurement.snapshot(supplier).negotiationThreads[0].attempts,2);assert.deepEqual(ctx.procurement.snapshot(supplier).negotiationRounds.map(row=>row.attemptNo),[1,2]);assert.equal(ctx.procurement.snapshot(buyer).negotiationThreads.length,0)
 checks.push('Explicit policy and sourced private costs are required; model cannot change limits; per-attempt concession cap and exact cost×1.5 floor reject with durable attempt1/2 and no counterparty disclosure')

 const pending=await run(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:19,reason:'Offer a measured reduction for a confirmed delivery window'},{agent:true});assert.equal(pending.round.attemptNo,3);assert.equal(ctx.procurement.snapshot(supplier).quotes.length,1)
 await assert.rejects(run(supplier,'apply-negotiation',{threadId:thread.id,roundId:pending.round.id,reviewActionId:pending.proposal.id}),/exact active human review/)
 const approved=await ctx.actions.approve(supplier,pending.proposal.id,{confirmed:true});assert.equal(approved.status,'succeeded',approved.error);const revision=approved.result.quote;assert.equal(revision.status,'draft');assert.equal(revision.items[0].unitPrice,19);assert.equal(ctx.store.get(buyer.id,'quotes',revision.id),undefined);assert.equal(ctx.store.get(buyer.id,'quotes',quote.id).items[0].unitPrice,20)
 await run(supplier,'submit-quote',{id:revision.id,confirmed:true});assert.equal(ctx.store.get(buyer.id,'quotes',revision.id).items[0].unitPrice,19);assert.equal(ctx.store.get(buyer.id,'quotes',revision.id).items[0].cost,undefined);assert.equal(ctx.store.list(buyer.id,'negotiation-rounds').length,0)
 checks.push('Even an in-band price change requires exact human action execution; approval prepares a private revision only; separate human submission shares19 while costs, private floors and attempts remain in supplier realm')

 const stale=await run(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:18.5,reason:'Further negotiated adjustment'})
 await run(supplier,'revise-negotiation-policy',{threadId:thread.id,policy:{...policy,maxConcessionPercent:15},reason:'Human narrows next-round authority'})
 const refused=await ctx.actions.approve(supplier,stale.proposal.id,{confirmed:true});assert.equal(refused.status,'failed');assert.match(refused.error,/policy changed/)
 const final=await run(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:18.5,reason:'Fresh review under revised limit'});assert.equal(final.round.attemptNo,5)
 await assert.rejects(run(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:18.75,reason:'One attempt too many'}),error=>error.code==='ROUND_LIMIT')
 assert.equal(ctx.procurement.snapshot(supplier).negotiationThreads[0].attempts,6)
 checks.push('Policy revisions invalidate pending proposals without resetting attempts; permitted round5 and rejected over-budget attempt6 preserve their order and reasons')

 const buyerThread=(await run(buyer,'open-negotiation',{quoteId:revision.id,itemId:'panel',policy:{maxRounds:2,maxConcessionPercent:20,minimumCostUpliftPercent:0,minUnitPrice:10,maxUnitPrice:30}})).thread
 const target=await run(buyer,'request-negotiation',{threadId:buyerThread.id,toUnitPrice:20,reason:'Ask for improved delivery terms at this target'})
 assert.equal(ctx.procurement.snapshot(supplier).messages.length,0);const sent=await ctx.actions.approve(buyer,target.proposal.id,{confirmed:true});assert.equal(sent.status,'succeeded',sent.error);assert.match(ctx.procurement.snapshot(supplier).messages[0].text,/Nonbinding price request/);assert.equal(ctx.procurement.snapshot(buyer).orders.length,0)
 await run(supplier,'close-negotiation',{threadId:thread.id,outcome:'limit-reached',reason:'Stop after the declared budget'})
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx;const restored=ctx.procurement.snapshot(supplier);assert.equal(restored.negotiationThreads[0].attempts,6);assert.equal(restored.negotiationThreads[0].status,'closed');assert.equal(restored.negotiationRounds.length,6)
 await assert.rejects(ctx.procurement.execute(supplier,'request-negotiation',{threadId:thread.id,toUnitPrice:18,reason:'Cannot resume closed thread'}),/closed/)
 checks.push('Contractor target is an exact reviewed nonbinding message, with no order or invented supplier floor; closure and all six attempts survive actual store remount')
 const interrupted=(await run(supplier,'open-negotiation',{quoteId:revision.id,itemId:'panel',policy})).thread
 const originalPut=ctx.store.put;let held=true
 ctx.store.put=async(...args)=>{if(held&&args[1]==='negotiation-threads'&&args[2].id===interrupted.id&&args[2].attempts===1){held=false;throw new Error('Injected interruption after durable attempt')}return originalPut(...args)}
 try{await assert.rejects(run(supplier,'request-negotiation',{threadId:interrupted.id,toUnitPrice:18.5,reason:'Durable attempt before summary interruption'}),/Injected interruption/)}finally{ctx.store.put=originalPut}
 assert.equal(ctx.store.get(supplier.id,'negotiation-threads',interrupted.id).attempts,0);assert.equal(ctx.procurement.snapshot(supplier).negotiationThreads.find(row=>row.id===interrupted.id).attempts,1)
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx
 const resumed=await run(supplier,'request-negotiation',{threadId:interrupted.id,toUnitPrice:18.75,reason:'Next attempt after actual restart'});assert.equal(resumed.round.attemptNo,2);assert.equal(ctx.store.list(supplier.id,'negotiation-rounds').filter(row=>row.threadId===interrupted.id).length,2)
 checks.push('Injected interruption after durable attempt but before thread summary retains its number across store remount; the next attempt is2 and history is not overwritten')
 const report={ok:true,root,checks,ids:{rfq:rfq.id,quote:quote.id,revision:revision.id,thread:thread.id},at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{await mounted.dispose()}
