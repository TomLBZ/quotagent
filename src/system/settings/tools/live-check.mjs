import assert from 'node:assert/strict'
const base=(process.env.BASE_URL || 'http://127.0.0.1:8610/quotagent')+'/api'
const login=async email=>{const response=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'demo1234'})});assert(response.ok);return response.headers.get('set-cookie').split(';')[0]}
const admin=await login('admin@demo.local'), user=await login('supplier@demo.local')
const call=async(cookie,path,body,method=body?'PATCH':'GET')=>{const response=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert(response.ok,JSON.stringify(result));return result}
const initial=await call(user,'/settings/ai');assert(initial.configuredSecrets.includes('apiKey'));assert.equal(initial.values.apiKey,'')
await call(user,'/settings/ai',{values:{apiKey:'demo-settings-test-key',model:'configuration-test-model'}})
const privateView=await call(user,'/settings/ai');assert.equal(privateView.values.apiKey,'');assert.equal(privateView.values.model,'configuration-test-model')
const provider=await call(user,'/assistant');assert.equal(provider.provider.model,'configuration-test-model')
const globalView=await call(admin,'/settings/ai');assert.notEqual(globalView.values.model,'configuration-test-model')
await call(user,'/settings/ai',{reset:true});assert.equal((await call(user,'/settings/ai')).values.model,initial.values.model)
await call(user,'/settings/assistant',{values:{language:'zh',responseLength:'detailed',instructions:'Prefer complete scope with delivery included.'}})
assert.equal((await call(user,'/settings/assistant')).values.language,'zh')
await call(user,'/settings/assistant',{reset:true})
const plugins=await call(admin,'/plugins');for(const name of ['webui','settings','agent-runtime','plugin-manager','procurement'])assert(plugins.plugins.some(p=>p.id===name&&p.status==='active'),name)
assert(plugins.plugins.some(p=>p.name==='AI model provider'&&p.configurable));assert(plugins.plugins.some(p=>p.repoId==='system/mail'&&p.status==='available'))
console.log(JSON.stringify({ok:true,checks:['credential masked','per-account credential/model consumed by provider','global defaults unchanged','reset to inherited defaults','preferences save/read','real native and repository plugin inventory'],plugins:plugins.plugins.length}))
