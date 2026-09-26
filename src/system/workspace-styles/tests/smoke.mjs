import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'
import * as store from '../../workspace-store/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as styles from '../code/index.mjs'
import * as guide from '../../user-guide/code/index.mjs'
import {groupNavigation} from '../code/navigation.mjs'
import {presentation} from '../code/presets.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
const users=[{id:'style-buyer',role:'contractor'},{id:'style-vendor',role:'supplier'},{id:'style-admin',role:'admin'}]
mkdirSync(resolve('tmp'),{recursive:true});const root=mkdtempSync(resolve('tmp/workspace-experience-'))
async function runtime(){
 const ctx=new Context(),fibers=[],routes=[],navigation=[]
 const add=(list,item)=>{list.push(item);return()=>list.splice(list.indexOf(item),1)}
 const mount=async(plugin,config)=>{const fiber=await ctx.plugin(plugin,config);fibers.push(fiber);return fiber}
 await mount({name:'experience-fixture',apply(ctx){ctx.provide('accounts',{list:()=>users,get:id=>users.find(user=>user.id===id),can:()=>true});ctx.provide('web',{route:(...args)=>add(routes,args),contribute:item=>add(navigation,item)})}})
 await mount(store,{root});await mount(settings);const styleFiber=await mount(styles),guideFiber=await mount(guide)
 return {ctx,routes,navigation,styleFiber,guideFiber,close:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}
}
let run=await runtime()
try{
 const {ctx}=run,buyer=users[0],vendor=users[1],admin=users[2]
 assert.deepEqual(ctx.workspaceStyles.get(buyer).preferences,{layout:'focus',palette:'calm',density:'comfortable'})
 await ctx.settings.save(buyer,'workspace-styles',{values:{layout:'classic',palette:'ocean',density:'compact'}})
 await ctx.settings.save(admin,'workspace-styles',{values:{palette:'warm'}})
 assert.equal(ctx.workspaceStyles.get(vendor).preferences.palette,'calm','Admin and buyer preferences never become another account’s defaults')
 assert.equal(ctx.workspaceStyles.get(buyer).preferences.palette,'ocean')
 await assert.rejects(ctx.settings.save(buyer,'workspace-styles',{values:{layout:'unknown'}}),/valid/i)
 assert.equal(presentation({layout:'classic'},'admin').landingPage,'admin');assert.equal(presentation({layout:'classic'},'supplier').landingPage,'workspace');assert.equal(presentation({layout:'focus'},'admin').landingPage,'agent')
 for(const user of users){const data=ctx.userGuide.get(user);assert.equal(data.role,user.role);assert.equal(data.tour.steps.length,4);assert.ok(data.topics.length>5);assert.ok(data.topics.some(topic=>topic.id==='reviews'));assert.ok(!data.topics.some(topic=>topic.id===(user.role==='admin'?'supplier-work':'admin-work')))}
 assert.ok(ctx.userGuide.get(buyer).topics.some(topic=>topic.id==='contractor-work'));assert.ok(!ctx.userGuide.get(vendor).topics.some(topic=>topic.id==='contractor-work'))
 await ctx.userGuide.progress(buyer,{status:'active',step:2});await ctx.userGuide.progress(vendor,{status:'dismissed',step:1})
 await assert.rejects(ctx.userGuide.progress(buyer,{status:'active',step:99}),/step/i)
 await assert.rejects(ctx.userGuide.progress(buyer,{status:'invalid'}),/state/i)
 assert.equal(ctx.userGuide.get(admin).progress.status,'new')
 assert.equal(ctx.userGuide.get({...buyer,role:'supplier'}).progress.status,'new','Guide progress is separate when an account changes its client role')
 const ids=['agent','workroom','approvals','workspace','rfqs','quotes','orders','messages','ingestion','mail','telegram','connections','extensions','workspace-style','ai-usage','plugin-settings','notifications','help','settings','third-party-calendar']
 const grouped=groupNavigation(ids.map(id=>({id,label:id}))),flattened=[...grouped.primary,...grouped.sections.flatMap(section=>section.items),...grouped.utilities].map(item=>item.id)
 assert.equal(new Set(flattened).size,ids.length);assert.equal(flattened.length,ids.length);assert.equal(grouped.sections.find(section=>section.id==='more').items[0].id,'third-party-calendar')
 assert.ok(ctx.store.events(buyer.id).some(event=>event.type==='user-guide/progress-saved'))
 await run.close();run=await runtime()
 assert.equal(run.ctx.workspaceStyles.get(buyer).preferences.palette,'ocean','Style survives store/runtime restart')
 assert.equal(run.ctx.userGuide.get(buyer).progress.step,2,'Active guide resumes after restart')
 await run.ctx.userGuide.progress(buyer,{status:'completed',step:3});await run.ctx.userGuide.progress(buyer,{status:'active',step:0});assert.equal(run.ctx.userGuide.get(buyer).progress.status,'active','Replay is explicit and does not touch business collections')
 await run.styleFiber.dispose();await run.guideFiber.dispose()
 assert.ok(!run.routes.some(([,path])=>path.startsWith('/workspace-style')||path.startsWith('/user-guide')))
 assert.ok(!run.navigation.some(item=>['workspace-style','help'].includes(item.id)))
 assert.throws(()=>run.ctx.settings.get(buyer,'workspace-styles'),/not registered/);assert.throws(()=>run.ctx.settings.get(buyer,'user-guide'),/not registered/)
 console.log(JSON.stringify({ok:true,root,checks:['native Cordis registrations','account/admin preference isolation','valid preset selection','three role-specific guides','role/account progress isolation','durable restart and replay','all known and unknown pages remain reachable','effect/schema/routes/navigation disposal']}))
}finally{await run.close()}
