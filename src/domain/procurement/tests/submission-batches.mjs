import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
import * as actionsPlugin from '../../../system/action-center/code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import {authoredFixtureInput} from './declared-scope-fixture.mjs'
const buyer={id:'buyer',role:'contractor',name:'Buyer',email:'buyer@batch.local'},supplier={id:'supplier',role:'supplier',name:'Supplier',email:'supplier@batch.local'},member={id:'member',role:'supplier',name:'Colleague',email:'member@batch.local'},outsider={id:'outsider',role:'supplier',name:'Other',email:'other@batch.local'},users=[buyer,supplier,member,outsider],routes=[],checks=[]
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/submission-batches-'))
async function mount(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin({name:'batch-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:user=>!user.permissions?.includes('workspace:read-only')});inner.provide('web',{route:(...args)=>{routes.push(args);return()=>routes.splice(routes.indexOf(args),1)},contribute:()=>()=>{}})}}));for(const plugin of[storePlugin,teamsPlugin,actionsPlugin,procurementPlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}));return{ctx,dispose:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}}
let mounted=await mount(),ctx=mounted.ctx
try{
 const run=(user,action,input)=>ctx.procurement.execute(user,action,authoredFixtureInput(action,input))
 const invite=await ctx.teams.invite(supplier,{email:member.email,roleId:'lead'});await ctx.teams.answerInvite(member,invite.id,true);await ctx.teams.select(member,supplier.id)
 async function draft(title){const rfq=(await run(buyer,'create-rfq',{title,items:[{id:'x',description:'Fixture unit',quantity:1,unit:'each'}],supplierIds:[supplier.id]})).rfq;await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true});const quote=(await run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'x',unitPrice:20,cost:12}]})).quote;return{rfq,quote}}
 const a=await draft('BatchA'),b=await draft('BatchB'),c=await draft('BatchC stale');const amendment=(await run(buyer,'save-amendment',{rfqId:c.rfq.id,expectedRevision:1,description:'Revised current scope',reason:'Explicit scope changed'})).amendment;await run(buyer,'publish-amendment',{id:amendment.id,confirmed:true})
 const prepared=(await ctx.procurement.prepareSubmissions(member,{quoteIds:[a.quote.id,b.quote.id,c.quote.id,'another-party-quote']})).batch
 assert.equal(prepared.status,'partial');assert.equal(prepared.items.length,4);assert.deepEqual(prepared.items.map(row=>row.status),['prepared','prepared','failed','failed']);assert.match(prepared.items[2].error,/older request/);assert.match(prepared.items[3].error,/not available/);assert.equal(prepared.ownerId,supplier.id);assert.equal(prepared.createdBy,member.id);assert.equal(ctx.store.list(buyer.id,'quotes').length,0);assert.equal(ctx.procurement.submissionBatches(outsider).length,0)
 assert(ctx.store.events(supplier.id).some(row=>row.type==='procurement/submission-item-prepared'&&row.actor==='human:member'))
 checks.push('Actual accepted supplier teammate prepares four selected drafts in supplier realm: two exact reviews and separate stale/unavailable failures; actual actor retained, no quote submitted and unrelated realm sees nothing')
 const repeated=(await ctx.procurement.prepareSubmissions(member,{quoteIds:[a.quote.id,b.quote.id]})).batch;assert(repeated.items.every(row=>row.reused));assert.equal(ctx.actions.list(member).filter(row=>row.kind==='procurement.commit').length,2)
 await assert.rejects(ctx.procurement.prepareSubmissions({...supplier,permissions:['workspace:read-only']},{quoteIds:[a.quote.id]}),/authorized supplier/);await assert.rejects(ctx.procurement.prepareSubmissions(buyer,{quoteIds:[a.quote.id]}),/authorized supplier/)
 checks.push('Repeat selection reuses matching pending frozen reviews rather than creating duplicates; read-only and contractor accounts cannot prepare supplier submissions')
 await run(supplier,'save-quote',{...b.quote,id:b.quote.id,expectedRevision:b.quote.revision,notes:'Changed after the earlier human review was prepared.'})
 const receipt=await ctx.actions.batch(member,{ids:prepared.items.filter(row=>row.actionId).map(row=>row.actionId),operation:'approve',confirmed:true})
 assert.equal(receipt.status,'completed');assert.equal(receipt.items[0].ok,true);assert.equal(receipt.items[1].ok,false);assert.match(receipt.items[1].error,/changed after/);assert.equal(ctx.store.list(buyer.id,'quotes').length,1);assert.equal(ctx.store.get(buyer.id,'quotes',a.quote.id).items[0].cost,undefined)
 const fresh=(await ctx.procurement.prepareSubmissions(member,{quoteIds:[b.quote.id]})).batch;assert.notEqual(fresh.items[0].actionId,prepared.items[1].actionId);const second=await ctx.actions.approve(member,fresh.items[0].actionId,{confirmed:true});assert.equal(second.status,'succeeded');assert.equal(ctx.store.list(buyer.id,'quotes').length,2)
 checks.push('Explicit human batch decision sends only unchanged exact offer through signed QEP; edited draft fails its frozen review individually, can be prepared afresh and submitted without repeating the successful quote or leaking private costs')
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx;const history=ctx.procurement.submissionBatches(member);assert.equal(history.length,3);assert.equal(history.find(row=>row.id===prepared.id).items[0].actionStatus,'succeeded');assert.equal(history.find(row=>row.id===prepared.id).items[1].actionStatus,'failed');assert.equal(ctx.store.list(buyer.id,'quotes').length,2)
 checks.push('Real native remount retains original partial preparations, per-item failed/succeeded review outcomes, both received quotations and actual team actor provenance')
 const report={ok:true,root,checks,ids:{batch:prepared.id,reviewBatch:receipt.id,quotes:[a.quote.id,b.quote.id]},at:new Date().toISOString()};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{await mounted.dispose()}
