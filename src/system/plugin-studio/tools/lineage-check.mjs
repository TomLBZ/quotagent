import assert from 'node:assert/strict'
import { Context } from '../../../../host/node_modules/cordis/lib/index.js'
import * as settings from '../../settings/code/index.mjs'
import * as installed from '../../installed-plugins/code/index.mjs'
import * as studio from '../code/product.mjs'
import * as web from '../../webui/code/product-server.mjs'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const ctx = new Context()
mkdirSync(resolve('tmp'),{recursive:true})
const root = mkdtempSync(resolve('tmp/studio-lineage-'))
const rows = new Map()
const events = []
const key = (realm, collection, id) => `${realm}:${collection}:${id}`
const user={id:'client',role:'contractor',name:'Client'}, admin={id:'admin',role:'admin',name:'Admin'}
const core=await ctx.plugin({name:'review-core',apply(child){
  child.provide('store',{root,events:()=>[],get:(realm,collection,id)=>structuredClone(rows.get(key(realm,collection,id))),
    list:(realm,collection)=>[...rows.entries()].filter(([id])=>id.startsWith(`${realm}:${collection}:`)).map(([,value])=>structuredClone(value)),
    put:async(realm,collection,value,options)=>{events.push({id:value.id,event:options?.event});rows.set(key(realm,collection,value.id),structuredClone(value))},append:async()=>{}})
  child.provide('accounts',{can:()=>true,get:id=>id==='admin'?admin:{...user,id},resolve:()=>null})
  child.provide('ai',{complete:async()=>{throw Error('No model request during review')}})
}})
const webFiber=await ctx.plugin(web)
const settingsFiber=await ctx.plugin(settings)
ctx.settings.define({id:'review',scope:'user',fields:[{key:'secret',label:'Secret',type:'password'},{key:'delimiter',label:'Delimiter',type:'select',options:['auto','\t']}],defaults:{secret:'default-review-secret',delimiter:'auto'}})
try {await ctx.settings.save(user,'review',{values:{delimiter:'\t'}});console.log('tab: accepted')}catch(error){console.log('tab:',error.message)}
await ctx.settings.save(admin,'review',{values:{secret:'shared-review-secret'}})
await ctx.settings.save(user,'review',{values:{secret:'personal-review-secret'}})
await ctx.settings.save(user,'review',{values:{secret:''}})
console.log('blank keeps personal:',ctx.settings.get(user,'review').secret==='personal-review-secret')
await ctx.settings.save(user,'review',{clearSecrets:['secret']})
console.log('clear effective empty:',ctx.settings.get(user,'review').secret==='')
await ctx.settings.save(user,'review',{reset:true})
console.log('reset inherits shared:',ctx.settings.get(user,'review').secret==='shared-review-secret')
const spec={accent:'#101010',background:'#ffffff',surface:'#eeeeee',text:'#000000',radius:'12px'}
const original={id:'original',kind:'theme',spec,name:'Shared theme',description:'Review fixture',ownerId:'originator',enabled:true,published:true,global:false,createdAt:'2026-01-01T00:00:00Z'}
const global={...original,id:'global',originId:'original',ownerId:'admin',global:true}
const personal={...original,id:'personal',originId:'original',ownerId:'client',published:false,enabled:false}
for (const row of [original,global,personal]) await ctx.store.put('system','studio-plugins',row)
const runtimeFiber=await ctx.plugin(installed)
const studioFiber=await ctx.plugin(studio)
console.log('disabled personal + active global:',JSON.stringify({visible:ctx.studio.list(user).plugins.map(p=>({id:p.id,enabled:p.enabled,scope:p.scope})),effects:ctx.web.extensions(user).map(p=>({id:p.id,enabled:p.enabled})),market:ctx.studio.list(user).market.map(p=>({installedId:p.installedId,installedEnabled:p.installedEnabled,installationScope:p.installationScope}))}))
assert.equal(ctx.studio.list(user).plugins[0].id,'global')
assert.equal(ctx.studio.list(user).market[0].installedId,'global')
assert.equal(ctx.studio.list(user).market[0].installedEnabled,true)
assert(ctx.studio.list(user).plugins[0].instances.some(p=>p.id==='personal' && p.canManage && !p.enabled))
assert.deepEqual(ctx.web.extensions(user).map(p=>p.id),['global'])
await ctx.studio.execute(user,'personal','load')
await ctx.studio.execute(user,'personal','configure',{spec:{accent:'#ffee00'}})
console.log('configure remount effect:',ctx.web.extensions(user).find(p=>p.id==='personal')?.spec.accent)
assert.equal(ctx.web.extensions(user).find(p=>p.id==='personal')?.spec.accent,'#ffee00')
const older={...personal,id:'older-personal',enabled:true,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-03T00:00:00Z',spec:{...spec,accent:'#111111'}}
const newer={...personal,id:'newer-personal',enabled:true,createdAt:'2026-01-02T00:00:00Z',updatedAt:'2026-01-02T00:00:00Z',spec:{...spec,accent:'#222222'}}
rows.delete(key('system','studio-plugins','personal'))
for(const row of [older,newer])await ctx.store.put('system','studio-plugins',row)
await studioFiber.dispose()
assert(ctx.web.extensions(user).length, 'Installed effects survive Studio unload')
await runtimeFiber.dispose()
const restoredRuntime=await ctx.plugin(installed)
const restored=await ctx.plugin(studio)
console.log('duplicate restored choice:',JSON.stringify({visible:ctx.studio.list(user).plugins.map(p=>({id:p.id,accent:p.spec.accent})),effects:ctx.web.extensions(user).map(p=>({id:p.id,accent:p.spec.accent}))}))
assert.equal(ctx.studio.list(user).plugins[0].id,'older-personal')
assert.deepEqual(ctx.web.extensions(user).map(p=>p.id),['older-personal'])
assert.equal(ctx.store.get('system','studio-plugins','newer-personal').enabled,false)
assert(events.some(event=>event.id==='newer-personal' && event.event==='studio/plugin-unloaded'))
await ctx.studio.execute(user,'newer-personal','load')
assert.equal(ctx.store.get('system','studio-plugins','older-personal').enabled,false)
assert.deepEqual(ctx.web.extensions(user).map(p=>p.id),['newer-personal'])
assert.equal(ctx.studio.list(user).plugins[0].id,'newer-personal')
const beforeInstall=ctx.store.list('system','studio-plugins').length
await ctx.studio.execute(user,'original','install')
assert.equal(ctx.store.list('system','studio-plugins').length,beforeInstall)
assert.equal(ctx.studio.list(user).plugins[0].id,'newer-personal')
await ctx.studio.execute(user,'newer-personal','unload')
assert.equal(ctx.studio.list(user).plugins[0].id,'global')
assert.deepEqual(ctx.web.extensions(user).map(p=>p.id),['global'])
await Promise.all([ctx.studio.execute(user,'older-personal','load'),ctx.studio.execute(user,'newer-personal','load')])
assert.equal(ctx.store.list('system','studio-plugins').filter(p=>p.ownerId==='client' && p.enabled).length,1)
assert.deepEqual(ctx.web.extensions(user).map(p=>p.id),['newer-personal'])
console.log('PASS: active fallback, live remount, deterministic restore, duplicate retirement event, scope replacement, idempotent install, concurrent loads')
await restored.dispose();await restoredRuntime.dispose();await settingsFiber.dispose();await webFiber.dispose();await core.dispose()
