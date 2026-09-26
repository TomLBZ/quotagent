import {authoredFixtureInput} from './declared-scope-fixture.mjs'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as settingsPlugin from '../../../system/settings/code/index.mjs'
import * as teamsPlugin from '../../../system/teams/code/index.mjs'
import * as exchangePlugin from '../../../system/exchange-workbench/code/index.mjs'
import * as procurementPlugin from '../code/index.mjs'
const buyer={id:'buyer',name:'Buyer',role:'contractor',email:'buyer@test.local'},supplier={id:'supplier',name:'Supplier',role:'supplier',email:'supplier@test.local'},member={id:'member',name:'Member',role:'contractor',email:'member@test.local'},observer={id:'observer',name:'Observer',role:'contractor',email:'observer@test.local'},other={id:'other',name:'Other',role:'contractor',email:'other@test.local'},users=[buyer,supplier,member,observer,other]
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/procurement-context-')),routes=[],checks=[]
async function mount(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin({name:'context-fixture',apply(inner){inner.provide('accounts',{list:()=>structuredClone(users),get:id=>structuredClone(users.find(row=>row.id===id)),can:user=>!user.permissions?.includes('workspace:read-only')});inner.provide('web',{route:(...args)=>{routes.push(args);return()=>routes.splice(routes.indexOf(args),1)},contribute:()=>()=>{}})}}));for(const plugin of [storePlugin,settingsPlugin,teamsPlugin,procurementPlugin,exchangePlugin])fibers.push(await ctx.plugin(plugin,plugin===storePlugin?{root}:{}));return{ctx,procurement:fibers[4],dispose:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}}
let mounted=await mount(),ctx=mounted.ctx
try{
 const run=(user,action,input)=>ctx.procurement.execute(user,action,authoredFixtureInput(action,input)),save=(user,scope,context,values)=>ctx.settings.save(user,'procurement',{scope,context,values})
 assert(ctx.settings.list(buyer).some(row=>row.id==='procurement'))
 const project=(await run(buyer,'save-project',{name:'Northern site',currency:'GBP'})).project,section=(await run(buyer,'save-section',{projectId:project.id,name:'Lighting'})).section,otherProject=(await run(buyer,'save-project',{name:'Other site',currency:'USD'})).project
 assert.equal(ctx.procurement.defaults(buyer,{projectId:project.id}).values.currency,'GBP')
 await save(buyer,'account',{}, {currency:'HKD',requestBrief:'Account brief'})
 await save(buyer,'workspace',{workspaceId:buyer.id},{currency:'EUR',requestBrief:'Workspace brief',quoteLeadDays:3})
 await save(buyer,'project',{workspaceId:buyer.id,projectId:project.id},{requestBrief:'Project brief'})
 const context={workspaceId:buyer.id,projectId:project.id,sectionId:section.id}
 await save(buyer,'section',context,{currency:'SGD',requestBrief:'Section brief'})
 const defaults=ctx.procurement.defaults(buyer,context);assert.equal(defaults.values.currency,'SGD');assert.equal(defaults.provenance.requestBrief.layer,'section');assert(defaults.provenance.requestBrief.shadowed.some(row=>row.layer==='account'))
 const rfq=(await run(buyer,'create-rfq',{title:'Scoped defaults fixture',projectId:project.id,sectionId:section.id,items:[{id:'panel',description:'Panel',quantity:10,unit:'each'}],supplierIds:[supplier.id]})).rfq
 assert.equal(rfq.description,'Section brief');assert.equal(rfq.currency,'SGD');assert.equal(rfq.draftDefaults.applied.description.source.layer,'section')
 await save(buyer,'section',context,{requestBrief:'Later section brief'})
 const edited=(await run(buyer,'create-rfq',{id:rfq.id,title:'Updated title only',expectedRevision:rfq.revision})).rfq;assert.equal(edited.description,'Section brief');assert.equal(edited.draftDefaults.applied.description.value,'Section brief')
 const explicit=(await run(buyer,'create-rfq',{title:'Explicit blank',projectId:project.id,sectionId:section.id,description:'',currency:'USD',items:[{description:'Unit',quantity:1}],supplierIds:[]})).rfq;assert.equal(explicit.description,'');assert.equal(explicit.currency,'USD')
 checks.push('Actual schema/account/workspace/project/section precedence and per-key origins; project currency fallback; applied draft basis retained; later configuration never rewrites existing draft or explicit blank')
 for(const [person,roleId]of [[member,'buyer'],[observer,'observer']]){const invite=await ctx.teams.invite(buyer,{email:person.email,roleId});await ctx.teams.answerInvite(person,invite.id,true);await ctx.teams.select(person,buyer.id)}
 await save(member,'section',context,{requestBrief:'Colleague section note'})
 assert.equal(ctx.settings.view(member,'procurement',context).provenance.requestBrief.changedBy,member.id)
 await assert.rejects(save(observer,'section',context,{requestBrief:'Not authorized'}),/read-only/)
 assert.throws(()=>ctx.procurement.defaults(other,context),/active member/)
 assert.throws(()=>ctx.procurement.defaults(buyer,{projectId:otherProject.id,sectionId:section.id}),/section of this project/)
 const teammate=(await run(member,'create-rfq',{title:'Team default fixture',projectId:project.id,sectionId:section.id,items:[{description:'Unit',quantity:1}],supplierIds:[]})).rfq;assert.equal(teammate.ownerId,buyer.id);assert.equal(teammate.description,'Colleague section note');assert(ctx.store.events(buyer.id).some(event=>event.actor==='human:member'&&event.body.record?.id===teammate.id))
 checks.push('Only explicit active party membership grants shared defaults; write authority, foreign realm and wrong section parent refuse; source identifies actual colleague while record remains party-owned')
 await save(supplier,'account',{}, {quoteLeadDays:21,quotePaymentTerms:'Net45',quoteNotes:'Supplier instructions'})
 await run(buyer,'publish-rfq',{id:rfq.id,confirmed:true});const quote=(await run(supplier,'save-quote',{rfqId:rfq.id,items:[{id:'panel',unitPrice:20,cost:12}]})).quote
 assert.equal(quote.leadDays,21);assert.equal(quote.paymentTerms,'Net45');assert.equal(quote.notes,'Supplier instructions');assert.equal(quote.draftDefaults.context.workspaceId,supplier.id)
 await save(supplier,'account',{}, {quoteLeadDays:7,quoteNotes:'New notes'})
 const unchanged=(await run(supplier,'save-quote',{id:quote.id,rfqId:rfq.id,expectedRevision:quote.revision,privateNotes:'Internal editing only'})).quote;assert.equal(unchanged.leadDays,21);assert.equal(unchanged.notes,'Supplier instructions')
 const empty=(await run(supplier,'save-quote',{rfqId:rfq.id,paymentTerms:'',notes:'',leadDays:0,items:[{id:'panel',unitPrice:22}]})).quote;assert.equal(empty.notes,'');assert.equal(empty.paymentTerms,'');assert.equal(empty.leadDays,0)
 assert.throws(()=>ctx.procurement.defaults(supplier,context),/active member|own contractor/)
 await run(supplier,'submit-quote',{id:quote.id,confirmed:true});const publicQuote=ctx.store.get(buyer.id,'quotes',quote.id);assert.equal(publicQuote.draftDefaults,undefined);assert.equal(publicQuote.items[0].cost,undefined)
 checks.push('Supplier consumes only its own default sources, retains existing fields and explicit zero/blank; private preparation provenance and costs never enter the submitted public quote')
 let peer=(await ctx.exchange.savePeer(buyer,{name:'Independent supplier',peerRealm:'remote-supplier',role:'supplier',mode:'http',channel:'fixture-remote',endpoint:'http://127.0.0.1:9/receive',enabled:true})).peer
 assert(!ctx.procurement.snapshot(buyer).contacts.some(row=>row.id==='remote-supplier'))
 peer=(await ctx.exchange.savePeer(buyer,{id:peer.id,pairingSecret:'local-fixture-shared-key-123456'})).peer
 const contact=ctx.procurement.snapshot(member).contacts.find(row=>row.id==='remote-supplier');assert(contact.external);assert.equal(contact.sourceRealm,buyer.id);assert(contact.sourceRef.hash);assert.equal(ctx.accounts.get(contact.id),undefined)
 assert(!ctx.procurement.snapshot(other).contacts.some(row=>row.id===contact.id))
 const remote=(await run(buyer,'create-rfq',{title:'Explicit paired invitation',items:[{description:'Unit',quantity:1}],supplierIds:[contact.id]})).rfq
 const pendingDraft=(await run(buyer,'create-rfq',{title:'Route disappears before review',items:[{description:'Unit',quantity:1}],supplierIds:[contact.id]})).rfq
 await ctx.exchange.savePeer(buyer,{id:peer.id,enabled:false})
 await assert.rejects(run(buyer,'create-rfq',{title:'Disabled peer',items:[{description:'Unit',quantity:1}],supplierIds:[contact.id]}),/active supplier/)
 assert(!ctx.procurement.snapshot(buyer).contacts.some(row=>row.id===contact.id));assert(ctx.procurement.snapshot(buyer).rfqs.some(row=>row.id===remote.id))
 const queued=await run(buyer,'publish-rfq',{id:remote.id,confirmed:true});assert.equal(queued.deliveryPending,true);assert(queued.deliveries.every(row=>row.status==='queued'))
 await ctx.exchange.removePeer(buyer,peer.id);const approvalCount=ctx.store.events(buyer.id).filter(row=>row.type==='procurement/human-approved').length;await assert.rejects(run(buyer,'publish-rfq',{id:pendingDraft.id,confirmed:true}),/counterparty delivery route/);assert.equal(ctx.store.get(buyer.id,'rfqs',pendingDraft.id).status,'draft');assert.equal(ctx.store.events(buyer.id).filter(row=>row.type==='procurement/human-approved').length,approvalCount)
 checks.push('Only enabled paired metadata exposes an external contact with real source reference; no fake account or unrelated workspace contact; disabling removes new invitations and queues existing approved handoff; removed route refuses before approval or publication')
 await mounted.dispose();mounted=await mount();ctx=mounted.ctx
 assert.equal(ctx.procurement.defaults(buyer,context).values.requestBrief,'Colleague section note');assert.equal(ctx.procurement.snapshot(supplier).quotes.find(row=>row.id===quote.id).leadDays,21)
 await mounted.procurement.dispose();assert(!ctx.settings.list(buyer).some(row=>row.id==='procurement'));assert(!routes.some(row=>row[1]==='/workspace/draft-defaults'))
 checks.push('Real ledger remount reconstructs scoped provenance and draft basis; native unload removes schema, scope providers and routes')
 console.log(JSON.stringify({ok:true,root,checks,ids:{project:project.id,section:section.id,rfq:rfq.id,quote:quote.id},at:new Date().toISOString()},null,2))
}finally{await mounted.dispose()}
