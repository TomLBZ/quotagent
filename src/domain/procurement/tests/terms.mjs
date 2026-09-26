import {authoredFixtureInput} from './declared-scope-fixture.mjs'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
import * as actionsPlugin from '../../../system/action-center/code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import {configureReviewer,grantAndSign} from './review-fixture.mjs'

mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/procurement-terms-')),routes=[],checks=[]
const buyer={id:'buyer',role:'contractor',name:'Buyer',email:'buyer@terms.local'},supplier={id:'supplier',role:'supplier',name:'Supplier',email:'supplier@terms.local'},reviewer={id:'reviewer',role:'contractor',name:'Reviewer',email:'reviewer@terms.local'},users=[buyer,supplier,reviewer]
async function mount(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin({name:'terms-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:()=>true});inner.provide('web',{route:(...args)=>{routes.push(args);return()=>routes.splice(routes.indexOf(args),1)},contribute:()=>()=>{}})}}));for(const plugin of[storePlugin,teamsPlugin,actionsPlugin,procurementPlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}));return{ctx,dispose:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}}
let mounted=await mount(),ctx=mounted.ctx
try{
 const run=(user,action,input,options)=>ctx.procurement.execute(user,action,authoredFixtureInput(action,input),options)
 await configureReviewer(ctx,buyer,reviewer)
 const library=(await run(buyer,'save-term',{key:'site-access',label:'Site access',family:'delivery',text:'Supplier books delivery 48 hours ahead',defaultFor:'request'})).term
 let rfq=(await run(buyer,'create-rfq',{title:'Term decision fixture',items:[{id:'panel',description:'Panel',quantity:10,unit:'each'}],supplierIds:[supplier.id],requirements:{paymentDays:30}})).rfq
 assert.equal(rfq.terms[0].text,library.text);assert(rfq.termsBasis.applied[0].sourceRef.hash)
 const second=(await run(buyer,'save-term',{...library,id:library.id,text:'Supplier books delivery 72 hours ahead',expectedRevision:library.revision})).term
 assert.equal(ctx.procurement.snapshot(buyer).termVersions.length,2);assert.equal(ctx.store.get(buyer.id,'rfqs',rfq.id).terms[0].text,library.text)
 await run(buyer,'archive-term',{id:second.id,expectedRevision:second.revision});assert.equal(ctx.procurement.snapshot(buyer).termLibrary[0].active,false)
 await assert.rejects(run(buyer,'save-term',{key:'bad',family:'other',label:'Agent policy',text:'A model cannot change defaults'},{agent:true}),/cannot commit/)
 checks.push('Human term library versions and archives survive as separate facts; missing private draft term gets exact sourced default; later revision does not rewrite the request; agents cannot author policy')

 await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true})
 let quote=(await run(supplier,'save-quote',{rfqId:rfq.id,terms:[{key:'site-access',label:'Site access',family:'delivery',text:'Supplier books delivery 24 hours ahead'}],commercial:{paymentDays:45},items:[{id:'panel',unitPrice:20,cost:12}]})).quote
 await run(supplier,'submit-quote',{id:quote.id,confirmed:true})
 let differences=ctx.procurement.snapshot(buyer).termConflicts.filter(row=>row.quoteId===quote.id);assert.equal(differences.length,2);assert(differences.every(row=>!row.decision));assert.equal(ctx.store.get(buyer.id,'quotes',quote.id).termsBasis,undefined)
 await assert.rejects(run(buyer,'propose-award',{quoteId:quote.id,reason:'Without decisions',confirmed:true}),/Resolve each/)
 const resolve=resolution=>run(buyer,'resolve-terms',{quoteId:quote.id,quoteRevision:quote.revision,rfqRevision:1,decisions:differences.map(row=>({key:row.key,resolution,reason:'Explicit owner decision about this exception'})),confirmed:true})
 await resolve('require-revision');await assert.rejects(run(buyer,'propose-award',{quoteId:quote.id,reason:'Still requires revision',confirmed:true}),/Resolve each/)
 await resolve('accept-offer');const intent=(await run(buyer,'propose-award',{quoteId:quote.id,reason:'Exceptions checked by responsible buyer',confirmed:true})).awardIntent
 assert.equal(intent.termExceptions.length,2);assert.equal(ctx.store.get(supplier.id,'award-intents',intent.id).termExceptions.length,2)
 checks.push('Required/offered textual and numeric terms remain distinct; unresolved or revision-required differences block selection; explicit human acceptance carries exact exceptions and sources into signed QEP intent')

 await run(supplier,'confirm-award',{id:intent.id,confirmed:true})
 const proposal=await routes.find(row=>row[0]==='POST'&&row[1]==='/workspace/review/:action')[2]({user:buyer,params:{action:'sign-order'},body:{id:intent.id}})
 const signed=await grantAndSign(ctx,buyer,reviewer,proposal),order=signed.order
 assert.equal(order.termExceptions.length,2);assert.equal(order.terms[0].text,quote.terms[0].text);assert.equal(order.requiredTerms[0].text,library.text);assert.equal(ctx.store.get(supplier.id,'orders',order.id).termExceptions[0].reason,order.termExceptions[0].reason)
 await assert.rejects(ctx.store.exchange(buyer.id,supplier.id,'orders',{...order,terms:[{key:'site-access',label:'Changed',family:'delivery',text:'Unreviewed'}]}),/No recorded human decision/)
 checks.push('Supplier confirmation and independent reviewer grant produce a PO retaining offered terms, original requirements and reasoned exceptions; unreviewed changed contract terms cannot reuse the original human decision')

 const nextRfq=(await run(buyer,'create-rfq',{title:'Stale term decisions',items:[{id:'x',description:'X',quantity:1,unit:'each'}],supplierIds:[supplier.id],terms:rfq.terms})).rfq;await run(buyer,'publish-rfq',{id:nextRfq.id,confirmed:true})
 let next=(await run(supplier,'save-quote',{rfqId:nextRfq.id,items:[{id:'x',unitPrice:2}]})).quote;await run(supplier,'submit-quote',{id:next.id,confirmed:true})
 const difference=ctx.procurement.snapshot(buyer).termConflicts.find(row=>row.quoteId===next.id)
 const oldInput={quoteId:next.id,quoteRevision:next.revision,rfqRevision:1,decisions:[{key:difference.key,resolution:'accept-offer',reason:'Accept explicitly missing delivery declaration'}],confirmed:true};await run(buyer,'resolve-terms',oldInput)
 next=(await run(supplier,'save-quote',{id:next.id,rfqId:nextRfq.id,expectedRevision:next.revision,notes:'New source revision'})).quote;await run(supplier,'submit-quote',{id:next.id,confirmed:true});await assert.rejects(run(buyer,'resolve-terms',oldInput),/changed/);await assert.rejects(run(buyer,'propose-award',{quoteId:next.id,reason:'Reuse stale decision',confirmed:true}),/Resolve each/)
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx;assert.equal(ctx.procurement.snapshot(buyer).orders.find(row=>row.id===order.id).termExceptions.length,2);assert.equal(ctx.procurement.snapshot(buyer).termVersions.length,2);assert(ctx.procurement.snapshot(buyer).termConflicts.find(row=>row.quoteId===next.id).decision===null)
 checks.push('Quote revision invalidates old decisions and requires fresh review; real store remount preserves library history, accepted PO exceptions and unresolved current-source differences')
 const report={ok:true,root,checks,ids:{rfq:rfq.id,quote:quote.id,order:order.id},at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{await mounted.dispose()}
