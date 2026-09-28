import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const base=process.argv[2],out=process.argv[3],checks=[]
for(const [role,email]of [['contractor','contractor@demo.local'],['supplier','supplier@demo.local'],['admin','admin@demo.local']]){
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'demo1234'})});assert.equal(login.status,200,role+' login');const cookie=login.headers.get('set-cookie').split(';')[0]
 const paths=['/bootstrap','/user-guide','/settings','/usage','/actions','/evidence',...(role==='admin'?['/plugins','/operations']:['/advisor','/workspace','/responses','/responses/metrics','/exchange','/exchange/mail/state','/mail','/attachments','/retention'])]
 for(const path of paths){const response=await fetch(base+'/api'+path,{headers:{cookie}});let value;try{value=await response.json()}catch{throw new Error(role+' '+path+' did not return JSON')};checks.push({role,path,status:response.status});assert.equal(response.status,200,role+' '+path+': '+(value.error||''));if(path==='/bootstrap'){assert.equal(value.user.role,role);assert.equal(value.navigation.some(row=>row.id==='advisor'),role!=='admin')}if(path==='/advisor'){assert.equal(value.status.provider,'typesafe');assert.equal(value.status.available,true);assert(value.modes.length>2)}}
}
const health=await(await fetch(base+'/api/health')).json();assert.equal(health.ok,true)
const report={ok:true,base,at:new Date().toISOString(),checks,health,scope:'Committed release with a copied production data directory. Only login and reads; no business writes, provider calls or external sends requested.'};writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:true,readChecks:checks.length,roles:3,health}))
