import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Context } from '../../../../host/node_modules/cordis/lib/index.js'
import * as settings from '../code/index.mjs'
import * as provider from '../../agent-runtime/code/product-ai.mjs'
for (const name of ['QUOTAGENT_AI_MODEL','QUOTAGENT_AI_URL','QUOTAGENT_AI_KEY']) delete process.env[name]
const requests = [], events = [], records = new Map()
const server = createServer(async (req,res) => {
  let body='';for await (const chunk of req)body+=chunk
  requests.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(body)})
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'dummy endpoint ok'}}]}))
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const port=server.address().port
const sharedUrl=`http://127.0.0.1:${port}/shared/v1`, personalUrl=`http://127.0.0.1:${port}/personal/v1`
const sharedKey='dummy-shared-review-key', personalKey='dummy-personal-review-key'
mkdirSync(resolve('tmp'),{recursive:true})
const root=mkdtempSync(resolve('tmp/provider-scope-'))
const configFile=join(root,'model.json')
writeFileSync(configFile,JSON.stringify({llm:{provider:'review',model:'dummy-model'},api_keys:{review:{value:sharedKey,base_url:sharedUrl,env:'QUOTAGENT_UNUSED_REVIEW_MODEL_KEY'}}}))
const ctx=new Context()
const core=await ctx.plugin({name:'credential-review-core',apply(child){
  child.provide('web',{route:()=>()=>{},contribute:()=>()=>{}})
  child.provide('accounts',{can:()=>true})
  child.provide('store',{root,get:(realm,collection,id)=>structuredClone(records.get(`${realm}:${collection}:${id}`)),
    put:async(realm,collection,value)=>{records.set(`${realm}:${collection}:${value.id}`,structuredClone(value));events.push({realm,collection,value})},
    append:async(realm,type,value)=>events.push({realm,type,value})})
}})
const sf=await ctx.plugin(settings), pf=await ctx.plugin(provider,{configFile})
const user={id:'review-client',role:'supplier'}, admin={id:'review-admin',role:'admin'}
const call=()=>ctx.ai.complete(user,{messages:[{role:'user',content:'Verify dummy response'}],purpose:'local-review'})
try {
  assert.equal(ctx.ai.status(user).available,true)
  assert.deepEqual(ctx.settings.view(user,'ai').configuredSecrets,['apiKey'])
  assert.equal(ctx.settings.view(user,'ai').values.apiKey,'')
  await call()
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/shared/v1/chat/completions');assert.equal(requests[0].authorization,`Bearer ${sharedKey}`)
  await ctx.settings.save(user,'ai',{values:{timeoutSeconds:90}})
  await call();assert.equal(requests.length,2);assert.equal(requests[1].authorization,`Bearer ${sharedKey}`)
  await ctx.settings.save(user,'ai',{values:{baseUrl:personalUrl}})
  assert.equal(ctx.ai.status(user).available,false)
  assert.deepEqual(ctx.settings.view(user,'ai').configuredSecrets,[])
  await assert.rejects(call(),/Plugin settings/);assert.equal(requests.length,2)
  await ctx.settings.save(user,'ai',{values:{apiKey:personalKey}})
  await call();assert.equal(requests.length,3);assert.equal(requests[2].path,'/personal/v1/chat/completions');assert.equal(requests[2].authorization,`Bearer ${personalKey}`)
  await ctx.settings.save(user,'ai',{values:{apiKey:''}})
  await call();assert.equal(requests[3].authorization,`Bearer ${personalKey}`)
  await ctx.settings.save(user,'ai',{clearSecrets:['apiKey']})
  assert.equal(ctx.ai.status(user).available,false);await assert.rejects(call(),/Plugin settings/);assert.equal(requests.length,4)
  await ctx.settings.save(user,'ai',{reset:true})
  assert.equal(ctx.ai.status(user).available,true)
  await call();assert.equal(requests.length,5);assert.equal(requests[4].path,'/shared/v1/chat/completions');assert.equal(requests[4].authorization,`Bearer ${sharedKey}`)
  await ctx.settings.save(user,'ai',{values:{provider:'different-provider'}})
  assert.equal(ctx.ai.status(user).available,false);await assert.rejects(call(),/Plugin settings/);assert.equal(requests.length,5)
  assert(!JSON.stringify(ctx.settings.list(user)).includes(sharedKey))
  assert(!JSON.stringify(ctx.settings.list(admin)).includes(personalKey))
  assert(!JSON.stringify(events).includes(sharedKey));assert(!JSON.stringify(events).includes(personalKey))
  const saved=JSON.parse(readFileSync(join(root,'settings/credentials.json'),'utf8'))
  assert(!Object.values(saved[user.id]?.ai || {}).includes(personalKey))
  const result={ok:true,checks:['shared connection sends shared credential to shared endpoint','nonconnection override preserves shared access',
    'personal endpoint without own key blocks before request','own endpoint receives only personal key','blank preserves existing key',
    'clear blocks request','reset restores shared connection','provider-only override also requires own key','settings views and ledger records omit credentials'],
    outgoingRequests:requests.map(request=>({path:request.path,credential:request.authorization===`Bearer ${sharedKey}`?'shared':'personal'}))}
  writeFileSync('tmp/product-evidence/ai-credential-review.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally {
  await pf.dispose();await sf.dispose();await core.dispose()
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
