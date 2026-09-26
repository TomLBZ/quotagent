import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import * as storePlugin from '../../workspace-store/code/index.mjs'
import * as settingsPlugin from '../../settings/code/index.mjs'
import * as providerPlugin from '../code/product-ai.mjs'
import {stable} from '../code/provider-policy.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis')
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/provider-dispatch-')),received=[],ctx=new Context(),fibers=[],user={id:'dispatch-buyer',role:'contractor'}
const fixture=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push(raw);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Recorded protocol fixture response'}}],usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}}))})
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
const mount=async(module,config)=>{const fiber=await ctx.plugin(module,config);assert.equal(fiber.state,2);fibers.push(fiber);return fiber}
try{
 await mount({name:'dispatch-fixture-services',apply(child){child.provide('web',{route:()=>()=>{},contribute:()=>()=>{}});child.provide('accounts',{list:()=>[user],get:()=>user,can:()=>true})}})
 await mount(storePlugin,{root});await mount(settingsPlugin);await mount(providerPlugin)
 await ctx.settings.save(user,'ai',{values:{provider:'dispatch-fixture',model:'fixture',baseUrl:`http://127.0.0.1:${fixture.address().port}/v1`,apiKey:'local-only-fixture'}})
 const input={messages:[{role:'user',content:'Quantity 12.5; café; 施工; exact newline\nsecond line'}],purpose:'dispatch-proof',runId:'fixture-run',requestKey:'dispatch-once'}
 await ctx.ai.complete(user,input);await ctx.ai.complete(user,input);assert.equal(received.length,1)
 const events=ctx.store.events(user.id),requested=events.find(event=>event.type==='agent/model-requested'),boundary=events.find(event=>event.type==='agent/model-dispatched')
 assert(requested.seq<boundary.seq);assert.equal(boundary.body.callId,requested.body.callId);assert.equal(boundary.body.serialization,'json-key-sorted/v1');assert.equal(JSON.stringify(stable(requested.body.request)),received[0]);assert.equal(boundary.body.requestSha256,createHash('sha256').update(received[0]).digest('hex'));assert.equal(boundary.body.requestBytes,Buffer.byteLength(received[0],'utf8'));assert.equal(events.filter(event=>event.type==='agent/model-dispatched').length,1);assert(!JSON.stringify(events).includes('local-only-fixture'))
 const report={ok:true,root,checks:['Actual loopback HTTP request exactly reconstructs from ledger using declared serialization, including Unicode and newlines','Pre-dispatch event binds actual UTF8 bytes/hash to call/run/attempt without credentials; idempotent replay performs no second HTTP dispatch'],bytes:boundary.body.requestBytes,sha256:boundary.body.requestSha256};writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose();await new Promise(resolve=>fixture.close(resolve))}
