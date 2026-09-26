import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import * as store from '../../workspace-store/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as files from '../code/index.mjs'
import * as actions from '../../action-center/code/index.mjs'
import * as notifications from '../../notifications/code/index.mjs'
import * as evidence from '../../evidence/code/product.mjs'
import * as attachments from '../../attachments/code/product.mjs'
import * as retention from '../../retention/code/product.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
export const users=[{id:'buyer',name:'Fixture buyer',role:'contractor'},{id:'supplier',name:'Fixture supplier',role:'supplier'},{id:'other',name:'Other buyer',role:'contractor'},{id:'admin',name:'Administrator',role:'admin'}].map(row=>({...row,email:`${row.id}@example.test`,permissions:[]}))
export const [buyer,supplier,other,admin]=users
export async function mount(root){const ctx=new Context(),fibers=[],routes=[],navigation=[];const register=(rows,value)=>{rows.push(value);return()=>rows.splice(rows.indexOf(value),1)};const add=async(plugin,config={})=>{const fiber=await ctx.plugin(plugin,config);assert.equal(fiber.state,2);fibers.push(fiber);return fiber}
 await add({name:'artifact-fixture-host',apply(inner){inner.provide('accounts',{get:id=>users.find(row=>row.id===id),list:()=>structuredClone(users),can:(user,capability)=>!(user.permissions||[]).includes('workspace:read-only')});inner.provide('web',{route:(...args)=>register(routes,args),collection:(...args)=>register(routes,args),contribute:item=>register(navigation,item)})}})
 await add(store,{root});await add(settings);await add(files);await add(notifications);await add(actions)
 await add({name:'fixture-readable-business-objects',inject:['store'],apply(inner){inner.provide('procurement',{realm:user=>user.id,snapshot:user=>Object.fromEntries(['rfqs','quotes','orders','changes'].map(key=>[key,inner.store.list(user.id,key)]))})}})
 await add(evidence);await add(attachments);await add(retention)
 return{ctx,add,routes,navigation,close:async()=>{for(const fiber of fibers.reverse())await fiber.dispose();assert.equal(routes.length,0);assert.equal(navigation.length,0);for(const key of ['evidence','attachments','retention','files','store'])assert.equal(ctx.get(key),undefined)}}
}
export async function sourceObjects(ctx){const rfq={id:'rfq-fixture',ownerId:buyer.id,supplierIds:[supplier.id],title:'Fixture RFQ',status:'published',revision:1,items:[{id:'item',description:'Item',unit:'each',quantity:1}]};for(const user of [buyer,supplier])await ctx.store.put(user.id,'rfqs',rfq,{event:'fixture/readable-object',actor:'fixture'});return rfq}
