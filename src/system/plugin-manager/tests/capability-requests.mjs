import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as store from '../../workspace-store/code/index.mjs'
import * as accounts from '../../accounts/code/product.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as requests from '../code/capability-requests.mjs'
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/capability-requests-')),ctx=new Context(),fibers=[],routes=[],notices=[]
let pluginEnabled=false,pluginBlocked=true
const add=(list,item)=>{list.push(item);return()=>list.splice(list.indexOf(item),1)}
const mount=async(module,config)=>{const fiber=await ctx.plugin(module,config);fibers.push(fiber);assert.equal(fiber.state,2);return fiber}
const checks=[]
try{
 await mount({name:'request-fixtures',apply(child){child.provide('web',{prefix:'/quotagent',route:(...args)=>add(routes,args),contribute:()=>()=>{}});child.provide('plugins',{list:()=>[{id:'optional',name:'Optional business helper',lifecycleAllowed:true,enabled:pluginEnabled}],setEnabled:async()=>{if(pluginBlocked)throw new Error('Required provider is unavailable');pluginEnabled=true}});child.provide('notifications',{push:async(user,input)=>notices.push({to:user.id,...input})})}})
 await mount(store,{root});await mount(accounts);await mount(settings);ctx.settings.define({id:'client-setup',scope:'account',title:'Client setup',fields:[],defaults:{}});let fiber=await mount(requests)
 const buyer=ctx.accounts.get('contractor-demo'),supplier=ctx.accounts.get('supplier-demo'),admin=ctx.accounts.get('admin-demo')
 await ctx.accounts.update(buyer.id,{permissions:['assistant:disabled']},{admin:true})
 const requested=await ctx.capabilityRequests.request(buyer,{kind:'permission',target:'assistant:use',reason:'Need to prepare quotation drafts'})
 assert.equal(ctx.accounts.can(buyer,'assistant:use'),false);assert.equal(ctx.capabilityRequests.list(supplier).length,0);assert.equal(ctx.capabilityRequests.list(admin).length,1)
 await assert.rejects(ctx.capabilityRequests.decide(buyer,requested.id,{choice:'grant',confirmed:true,reason:'Self approval'}),/administrator/)
 const granted=await ctx.capabilityRequests.decide(admin,requested.id,{choice:'grant',confirmed:true,reason:'Quotation work authorized'})
 assert.equal(granted.status,'resolved');assert.equal(ctx.accounts.can(buyer,'assistant:use'),true);assert.equal(granted.verification.available,true)
 checks.push('Actual account permission stays blocked until a separate administrator explicitly grants it; unrelated clients cannot see request reasons')
 const plugin=await ctx.capabilityRequests.request(buyer,{kind:'plugin',target:'optional',reason:'Need optional helper'})
 let decision=await ctx.capabilityRequests.decide(admin,plugin.id,{choice:'grant',confirmed:true,reason:'Enable shared helper'});assert.equal(decision.status,'blocked');assert.match(decision.error,/provider/);assert.equal(pluginEnabled,false)
 pluginBlocked=false;decision=await ctx.capabilityRequests.decide(admin,plugin.id,{choice:'grant',confirmed:true,reason:'Provider is now available'});assert.equal(decision.status,'resolved');assert.equal(pluginEnabled,true);assert.equal(decision.decisions.length,2)
 checks.push('Plugin activation uses the registered lifecycle operation; a failed operation retains a blocked receipt and a successful retry records actual active state')
 const guidance=await ctx.capabilityRequests.request(supplier,{kind:'configuration',target:'client-setup',reason:'Need connection setup help'})
 await ctx.capabilityRequests.decide(admin,guidance.id,{choice:'guide',reason:'Open Client setup and use your local test service'})
 await assert.rejects(ctx.capabilityRequests.confirm(admin,guidance.id,{confirmed:true}),/Only the requester/)
 const confirmed=await ctx.capabilityRequests.confirm(supplier,guidance.id,{confirmed:true,reason:'The connection now works'});assert.equal(confirmed.verification.kind,'requester-report')
 checks.push('Guidance never claims automatic configuration success; only the requester confirms the observed outcome')
 const denied=await ctx.capabilityRequests.request(buyer,{kind:'permission',target:'workspace:write',reason:'Need an explicit policy answer'});await ctx.capabilityRequests.decide(admin,denied.id,{choice:'reject',reason:'Keep the existing policy'})
 const renewed=await ctx.capabilityRequests.request(buyer,{kind:'permission',target:'workspace:write',reason:'Reconsider for the next project',previousId:denied.id});assert.notEqual(renewed.id,denied.id);assert.equal(renewed.previousId,denied.id)
 await ctx.store.put('system','capability-requests',{...renewed,expiresAt:'2000-01-01T00:00:00Z'},{event:'fixture/expiry'});await ctx.capabilityRequests.expire();assert.equal(ctx.capabilityRequests.list(buyer).find(row=>row.id===renewed.id).status,'expired')
 const events=ctx.store.events('system');assert(events.some(event=>event.type==='capabilities/expired'));assert(!JSON.stringify(events).includes('demo1234'))
 await fiber.dispose();assert.equal(ctx.get('capabilityRequests'),undefined);assert(!routes.some(([,path])=>path.startsWith('/capability-requests')))
 fiber=await mount(requests);assert.equal(ctx.capabilityRequests.list(admin).length,5);assert.equal(ctx.capabilityRequests.list(buyer).find(row=>row.id===requested.id).status,'resolved')
 checks.push('Rejection, linked fresh request and expiry never grant access; durable receipts survive native unload/reload without residual routes or credentials')
 console.log(JSON.stringify({ok:true,root,checks,notifications:notices.length},null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
