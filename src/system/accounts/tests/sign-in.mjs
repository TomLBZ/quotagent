import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'
import * as web from '../../webui/code/product-server.mjs'
import * as store from '../../workspace-store/code/index.mjs'
import * as accounts from '../code/product.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{Context}=require('cordis'),ctx=new Context(),fibers=[]
mkdirSync('tmp',{recursive:true});const root=mkdtempSync(resolve('tmp/sign-in-')),clock={now:Date.now()}
const mount=async(module,config)=>{const fiber=await ctx.plugin(module,config);assert.equal(fiber.state,2);fibers.push(fiber)}
try{
 await mount(web,{port:0});await mount(store,{root});await mount(accounts,{loginClock:()=>clock.now});const address=await ctx.web.listen(),url=`http://127.0.0.1:${address.port}/quotagent/api/auth/login`
 const login=async(email,password)=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')}}
 const missing=await login('missing@local.test','bad'),wrong=await login('contractor@demo.local','bad');assert.equal(missing.status,401);assert.deepEqual(missing.body,wrong.body);assert.equal(missing.cookie,null)
 for(let i=1;i<5;i++)await login(' CONTRACTOR@demo.local ','bad')
 const blocked=await login('contractor@demo.local','demo1234');assert.equal(blocked.status,401);assert.deepEqual(blocked.body,wrong.body);assert.equal(blocked.cookie,null)
 assert.equal((await login('supplier@demo.local','demo1234')).status,200)
 clock.now+=29999;assert.equal((await login('contractor@demo.local','demo1234')).status,401);clock.now+=1
 const recovered=await login('contractor@demo.local','demo1234');assert.equal(recovered.status,200);assert.match(recovered.cookie,/qa_session=/)
 assert.equal((await login('contractor@demo.local','bad')).status,401);assert.equal((await login('contractor@demo.local','demo1234')).status,200)
 console.log(JSON.stringify({ok:true,root,checks:['Actual HTTP generic failure has no session; five normalized failures prevent even correct credentials during bounded cooldown','A separate account remains available; injected 30-second expiry requires explicit login and a successful login resets failure history']},null,2))
}finally{for(const fiber of fibers.reverse())await fiber.dispose()}
