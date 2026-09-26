import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {Context} from '../../../../host/node_modules/cordis/lib/index.js'
import * as web from '../code/product-server.mjs'
import * as store from '../../workspace-store/code/index.mjs'
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/web-conflict-')),ctx=new Context(),fibers=[]
try{
 fibers.push(await ctx.plugin(web,{port:0,host:'127.0.0.1'}));fibers.push(await ctx.plugin(store,{root}));fibers.push(await ctx.plugin({name:'conflict-account',apply(child){child.provide('accounts',{resolve:()=>({id:'editor',role:'contractor'}),can:()=>true})}}))
 await ctx.store.put('editor','drafts',{id:'draft',revision:1,description:'First draft'})
 ctx.effect(()=>ctx.web.route('POST','/draft',({user,body})=>ctx.store.put(user.id,'drafts',body.record,{expectedRevision:body.expectedRevision})))
 const {port}=await ctx.web.listen(),url=`http://127.0.0.1:${port}/quotagent/api/draft`
 const post=body=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const updated=await post({expectedRevision:1,record:{id:'draft',revision:2,description:'Colleague edit'}});assert.equal(updated.status,200)
 const before=ctx.store.events('editor').length,response=await post({expectedRevision:1,record:{id:'draft',revision:2,description:'Unsaved editor draft'}}),body=await response.json()
 assert.equal(response.status,409);assert.equal(body.code,'REVISION_CONFLICT');assert.equal(body.details.currentRevision,2);assert.equal(body.details.current.description,'Colleague edit');assert.match(body.nextAction,/Review the current version/);assert.equal(ctx.store.events('editor').length,before)
 console.log(JSON.stringify({ok:true,root,checks:['Actual ledger compare-and-save conflict crosses native HTTP with 409, code, next action and current revision/record','A stale form write appends no fact and leaves the colleague record intact']},null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
