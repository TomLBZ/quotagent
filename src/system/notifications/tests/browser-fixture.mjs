/** Creates synthetic notification history in an explicitly isolated browser-test data directory. */
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import * as store from '../../workspace-store/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as notifications from '../code/index.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis'),root=resolve(process.env.FIXTURE_DATA||'tmp/agent-experience/g9-browser-data')
if(!root.includes('/tmp/agent-experience/g9-'))throw new Error('Use an isolated g9 test directory.')
const ctx=new Context(),user={id:'contractor-demo',role:'contractor'},fibers=[]
try{for(const[module,config]of [[{name:'notification-browser-fixture',apply(child){child.provide('accounts',{list:()=>[user],get:()=>user,can:()=>true});child.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})}},{}],[store,{root}],[settings,{}],[notifications,{}]])fibers.push(await ctx.plugin(module,config))
for(let i=0;i<61;i++)await ctx.notifications.push(user,{type:'fixture',title:`Pagination fixture ${String(i).padStart(2,'0')}`,body:'Synthetic local browser evidence, not a procurement event.',dedupeKey:'g9-page-'+i,source:{pluginId:'pagination-fixture',panelId:'test',sourceId:'fixture-'+i}})
for(const pluginId of ['fixture-one','fixture-two'])await ctx.notifications.push(user,{title:'Paired source fixture',type:'fixture',level:'warning',body:'Same local test event reported by two plugins.',dedupeKey:'g9-paired',source:{pluginId,panelId:'test',sourceId:'paired'}})
console.log(JSON.stringify({ok:true,root,total:ctx.notifications.window(user).total,produced:ctx.notifications.window(user).produced}))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
