import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,chmodSync,rmSync} from 'node:fs'
import {join,resolve,sep} from 'node:path'
export const name='sandbox'
export const inject=['store','web','accounts']
export const provides=['sandbox']
const clone=value=>structuredClone(value),now=()=>new Date().toISOString(),fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const descriptor={id:'sandbox',label:'Demo sandbox',icon:'layers',roles:['contractor','supplier','admin'],order:74}
export function apply(ctx,config={}){
 const directory=resolve(ctx.store.root,'.sandbox-control'),dataDirectory=resolve(ctx.store.root,'.sandboxes'),stateFile=join(directory,'state.json'),scenarios=new Map(),runtimes=new Map(),creating=new Map(),pending=new Map();let disposed=false
 mkdirSync(directory,{recursive:true,mode:0o700});mkdirSync(dataDirectory,{recursive:true,mode:0o700});chmodSync(directory,0o700);chmodSync(dataDirectory,0o700)
 const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{}
 const persist=()=>{const temporary=stateFile+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,stateFile)}
 const guard=user=>{if(!user?.id)fail('Sign in to use a demo sandbox.',401);if(!['contractor','supplier'].includes(user.role))fail('Open a contractor or supplier account to explore that client perspective.',403)}
 const pathFor=id=>{const value=resolve(dataDirectory,createHash('sha256').update(id).digest('hex').slice(0,32));if(!value.startsWith(dataDirectory+sep))fail('Invalid sandbox directory.');return value}
 const view=user=>{if(!user?.id)fail('Sign in to view your sandbox.',401);const saved=state[user.id],scenario=saved&&scenarios.get(saved.scenarioId);return{active:!!saved?.active,available:!!scenario,phase:saved?.phase||'empty',accountRole:user.role,scenarioId:saved?.scenarioId||null,scenarioName:scenario?.name||saved?.scenarioName||null,createdAt:saved?.createdAt||null,updatedAt:saved?.updatedAt||null,error:saved?.error||null,steps:clone(saved?.steps||[]),result:clone(saved?.result||null),hasData:!!saved||existsSync(pathFor(user.id)),scope:'All tabs signed into this account use the same demo mode.',scenarios:[...scenarios.values()].filter(row=>!row.roles||row.roles.includes(user.role)).map(({id,name,description,steps})=>({id,name,description,steps:clone(steps)}))}}
 const serial=(user,fn)=>{const result=(pending.get(user.id)||Promise.resolve()).catch(()=>{}).then(()=>{if(disposed)fail('The sandbox plugin is unloading.',409);return fn()});const settled=result.catch(()=>{});pending.set(user.id,settled);settled.finally(()=>{if(pending.get(user.id)===settled)pending.delete(user.id)});return result}
 const stop=async id=>{if(creating.has(id))await creating.get(id).catch(()=>{});const runtime=runtimes.get(id);if(!runtime)return;runtime.accepting=false;await runtime.dispose();runtimes.delete(id)}
 const runtime=async user=>{
  const saved=state[user.id];if(!saved?.active)fail('Demo mode is not active.',409);if(saved.accountRole!==user.role)fail('Your account perspective changed. Exit this demo and start a new one.',409)
  const definition=scenarios.get(saved.scenarioId);if(!definition)fail('The demo scenario plugin is unavailable. Exit demo mode or enable its plugin.',503)
  const existing=runtimes.get(user.id);if(existing?.accepting)return existing
  if(creating.has(user.id))return creating.get(user.id);const operation=(async()=>{const created=await definition.create({root:pathFor(user.id),role:user.role,ownerId:user.id,prefix:ctx.web.prefix,descriptor:clone(descriptor)});if(disposed||scenarios.get(saved.scenarioId)!==definition){await created.dispose();fail('The sandbox plugin unloaded during startup.',409)}created.accepting=true;runtimes.set(user.id,created);if(saved.phase==='unavailable'){saved.phase=saved.result?'ready':'failed';saved.error=null;saved.updatedAt=now();persist()}return created})();creating.set(user.id,operation);try{return await operation}finally{creating.delete(user.id)}
 }
 const enter=async(user,input={})=>{guard(user);return serial(user,async()=>{if(input.confirmed!==true)fail('Review the demo steps and confirm that their participants and approvals are simulated.');const definition=scenarios.get(input.scenarioId||state[user.id]?.scenarioId);if(!definition||definition.roles&&!definition.roles.includes(user.role))fail('Choose an available demonstration scenario.');const reset=input.reset!==false||!state[user.id];if(Object.keys(state).length>=32&&!state[user.id])fail('The 32-account demo limit is reached. An existing participant must clear their own demo before another can be created.',409)
   if(reset){await stop(user.id);rmSync(pathFor(user.id),{recursive:true,force:true})}else if(!state[user.id].result)fail('This demo did not finish generating. Reset and start a fresh example.',409);else if(state[user.id].scenarioId!==definition.id||state[user.id].accountRole!==user.role)fail('Start a fresh demo for the chosen scenario and perspective.',409)
   state[user.id]={...(reset?{}:state[user.id]),active:true,phase:reset?'seeding':'opening',scenarioId:definition.id,scenarioName:definition.name,accountRole:user.role,createdAt:reset?now():state[user.id].createdAt,updatedAt:now(),error:null,...(reset?{steps:[],result:null}:{})};persist()
   try{const child=await runtime(user);if(reset){const result=await child.seed(async step=>{state[user.id].steps.push(clone(step));state[user.id].updatedAt=now();persist()});state[user.id].result=clone(result)}state[user.id].phase='ready';state[user.id].updatedAt=now();persist();return{ok:true,...view(user)}}catch(error){state[user.id].phase='failed';state[user.id].error=String(error.message).slice(0,500);state[user.id].updatedAt=now();persist();throw error}
  })}
 const leave=async(user,{clear=false,confirmed=false}={})=>{if(!user?.id)fail('Sign in to leave your demo sandbox.',401);return serial(user,async()=>{if(clear&&!confirmed)fail('Confirm clearing your isolated demo data.');await stop(user.id);if(clear){rmSync(pathFor(user.id),{recursive:true,force:true});delete state[user.id]}else if(state[user.id])Object.assign(state[user.id],{active:false,updatedAt:now()});persist();return{ok:true,...view(user)}})}
 const registerScenario=definition=>{if(!/^[\w.-]+$/.test(definition.id||'')||scenarios.has(definition.id)||typeof definition.create!=='function')throw new Error('A demo scenario requires a unique ID and native runtime factory.');scenarios.set(definition.id,definition);return async()=>{scenarios.delete(definition.id);for(const[id,row]of Object.entries(state))if(row.scenarioId===definition.id)await stop(id)}}
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
 ctx.effect(()=>ctx.web.intercept(async({user,req,res,apiPath})=>{
  if(!user||!state[user.id]?.active||apiPath.startsWith('/sandbox/')||apiPath==='/sandbox'||apiPath.startsWith('/auth/'))return false
  try{if(pending.has(user.id))await pending.get(user.id);const current=state[user.id];if(!current?.active)fail('Demo mode just ended. Reload before continuing.',409);const child=await runtime(user);if(!child.accepting)fail('The demo is resetting. Retry after it is ready.',409);await child.handle(req,res);return true}
  catch(error){if(state[user.id]?.active&&state[user.id].error!==error.message){Object.assign(state[user.id],{phase:'unavailable',error:String(error.message).slice(0,500),updatedAt:now()});persist()}if(apiPath==='/bootstrap')json(res,200,{user:{id:'sandbox-unavailable-'+user.id,role:user.role,name:'Demo unavailable',company:'Isolated demo workspace',email:'demo@invalid.local',permissions:[],preferences:{},sandbox:true},navigation:[descriptor],extensions:[],ui:{refreshSeconds:8,maxRequestMb:32},sandbox:{active:true,error:error.message}});else json(res,error.status||503,{ok:false,error:'Demo workspace unavailable: '+error.message,nextAction:'Use Demo sandbox → Exit demo to return to your live workspace.'});return true}
 }))
 ctx.provide('sandbox',{registerScenario,status:view,start:enter,leave,rootFor:user=>pathFor(user.id),runtime:user=>runtimes.get(user.id)})
 ctx.effect(()=>ctx.web.contribute(descriptor))
 const route=(method,path,handler)=>ctx.effect(()=>ctx.web.route(method,path,handler))
 route('GET','/sandbox/status',({user})=>view(user))
 route('POST','/sandbox/start',({user,body})=>enter(user,body))
 route('POST','/sandbox/exit',({user})=>leave(user))
 route('POST','/sandbox/clear',({user,body})=>leave(user,{clear:true,confirmed:body.confirmed}))
 ctx.effect(()=>()=>{disposed=true;return(async()=>{await Promise.allSettled([...pending.values(),...creating.values()]);await Promise.allSettled([...runtimes.keys()].map(stop));scenarios.clear()})()})
}
