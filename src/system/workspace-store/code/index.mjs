import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcile, acceptPublic } from './reconcile.mjs'
export const name = 'workspace-store'
export const inject = []
const copy = value => value === undefined ? undefined : structuredClone(value)
const valid = body => body?.schema==='quotagent/workspace-record/v1' && typeof body.collection==='string' && body.collection && body.record && typeof body.record.id==='string' && body.record.id
export async function apply(ctx, config = {}) {
 const root=resolve(config.root||'tmp/product-data');mkdirSync(root,{recursive:true})
 const child=spawn(config.python||process.env.QUOTAGENT_PYTHON||'python3',[fileURLToPath(new URL('./bridge.py',import.meta.url)),root],{stdio:['pipe','pipe','pipe']})
 const pending=new Map(),records=new Map(),history=new Map(),policies=new Map(),transports=new Map(),receiving=new Map(),controllers=new Set()
 let sequence=0,disposed=false,failure=null,health={}
 const absorb=events=>{for(const [realm,rows]of Object.entries(events||{})){if(!history.has(realm))history.set(realm,[]);if(!records.has(realm))records.set(realm,new Map());for(const row of rows){if(history.get(realm).some(previous=>previous.seq===row.seq))continue;history.get(realm).push(row);if(!valid(row.body))continue;const body=row.body;if(!records.get(realm).has(body.collection))records.get(realm).set(body.collection,new Map());records.get(realm).get(body.collection).set(body.record.id,body.record)}}}
 const fail=error=>{failure=error;for(const task of pending.values())task.reject(error);pending.clear()}
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{let response,task;try{response=JSON.parse(line);task=pending.get(response.id);if(!task)return;pending.delete(response.id);absorb(response.events);if(response.health)health=response.health;response.ok?task.resolve(response.value):task.reject(Object.assign(new Error(response.error),{code:response.code,status:response.status,nextAction:response.nextAction,details:response.details}))}catch(error){if(task)task.reject(error);else fail(error)}})
 child.stderr.on('data',data=>console.error('[store]',data.toString().slice(0,1000)));child.on('error',fail);child.on('exit',()=>fail(new Error('Ledger adapter stopped')))
 const request=payload=>new Promise((resolve,reject)=>{if(disposed||failure)return reject(failure||new Error('Store unloaded'));const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({...payload,rpcId:id})+'\n',error=>{if(error){pending.delete(id);reject(error)}})})
 ctx.effect(()=>()=>{disposed=true;for(const controller of controllers)controller.abort();transports.clear();policies.clear();lines.close();child.kill();fail(new Error('Store unloaded'))})
 const capabilities=await request({op:'hello',protocol:'quotagent-store/2'});await request({op:'init'})
 const assertReadable=realm=>{const state=health[realm];if(state&&state.healthy===false)throw Object.assign(new Error(state.message||'This account ledger is unavailable.'),{status:503,code:state.code||'LEDGER_UNAVAILABLE',nextAction:state.nextAction||'Preserve the ledger and ask an administrator to inspect storage integrity.',details:{realm}})}
 const list=(realm,collection)=>{assertReadable(realm);return copy([...(records.get(realm)?.get(collection)?.values()||[])])}
 const get=(realm,collection,id)=>{assertReadable(realm);return copy(records.get(realm)?.get(collection)?.get(id))}
 const policyFor=collection=>[...policies.values()].find(policy=>policy.collections.includes(collection))
 const register=(map,definition)=>{if(map.has(definition.id))throw new Error(`Duplicate registration ${definition.id}`);map.set(definition.id,definition);return()=>{if(map.get(definition.id)===definition)map.delete(definition.id)}}
 async function processPackage(realm,packageValue,options={}){
  const inspected=await request({op:'inspect-package',realm,package:packageValue})
  const inbox=await request({op:'receive-package',realm,package:packageValue})
  if(inspected.control||inbox.control||inbox.status!=='received')return inbox
  const policy=policyFor(inspected.collection)
  const verdict=policy?await policy.validate({...inspected,peer:options.peer}):policies.size?{ok:false,message:'No mounted domain plugin accepts this public collection.'}:{ok:true}
  const merged=reconcile(inspected,policy)
  const outcome=!verdict.ok?'rejected':merged.conflicts.length?'conflict':'applied'
  return request({op:'settle-inbox',realm,id:inbox.id,expectedHash:inspected.localHash,outcome,record:merged.record,conflicts:merged.conflicts,decisions:merged.decisions,message:!verdict.ok?verdict.message:merged.conflicts.length?'Concurrent or unknown-authority changes need human review.':null})
 }
 async function receivePackage(realm,packageValue,options={}){
  const previous=receiving.get(realm)||Promise.resolve()
  const work=previous.catch(()=>{}).then(async()=>{
   const result=await processPackage(realm,packageValue,options),released=[]
   for(let pass=0;pass<100;pass++){
    let progress=false
    for(const row of list(realm,'exchange-inbox').filter(row=>row.status==='held'&&row.from===packageValue.envelope.sender.realm&&row.channel===packageValue.channel).sort((a,b)=>(a.seq||0)-(b.seq||0))){const next=await processPackage(realm,row.package,options);if(next.status!=='held'){progress=true;released.push(next)}}
    if(!progress)break
   }
   return {...result,released}
  })
  receiving.set(realm,work);try{return await work}finally{if(receiving.get(realm)===work)receiving.delete(realm)}
 }
 const deliveryResult=row=>({record:copy(row.envelope?.body?.record),msgId:row.id,received:row.status==='delivered',status:row.status,queued:['queued','failed','held','conflict'].includes(row.status),error:row.error||undefined,nextAction:row.nextAction||undefined})
 async function retryDelivery(realm,id,options={}){
  const row=get(realm,'exchange-outbox',id);if(!row)throw Object.assign(new Error('Delivery not found'),{status:404})
  if(row.status==='delivered'||row.control)return deliveryResult(row)
  const transport=[...transports.values()].find(item=>item.handles?.(row)),controller=new AbortController();controllers.add(controller)
  try{
   if(row.channel!=='local'&&!transport)return deliveryResult(row)
   await request({op:'attempt',realm,id,status:'queued',started:true})
   const exported=await request({op:'package',realm,id})
   const response=row.channel==='local'?await receivePackage(row.to,exported.package,options):await transport.deliver({from:realm,to:row.to,delivery:row,package:exported.package,signal:controller.signal})
   const receipts=[...(response?.receipts||[]),response?.receipt,...(response?.released||[]).map(item=>item.receipt)].filter(Boolean).sort((a,b)=>a.envelope.seq-b.envelope.seq)
   for(const receipt of receipts)await receivePackage(realm,receipt,options)
   if(!receipts.length&&response?.status!=='held')await request({op:'attempt',realm,id,status:'queued',error:'Awaiting the recipient’s signed receipt.',nextAction:'Import the receipt or retry the exact original package.'})
   else if(response?.status==='held')await request({op:'attempt',realm,id,status:'held',error:'Earlier messages are missing at the recipient.',nextAction:'Deliver earlier queued messages first, then retry.'})
  }catch(error){await request({op:'attempt',realm,id,status:'failed',error:error.message,nextAction:error.nextAction||'Retry this delivery; the reviewed business record and signed message will be reused.'})}
  finally{controllers.delete(controller)}
  return deliveryResult(get(realm,'exchange-outbox',id))
 }
 const service={root,capabilities:copy(capabilities),list,get,events:realm=>{assertReadable(realm);return copy(history.get(realm)||[])},health:()=>copy(health),
  put:(realm,collection,record,options={})=>request({op:'put',realm,collection,record,...options}),append:(realm,type,body,options={})=>request({op:'append',realm,type,body,...options}),
  exchangePolicy:policy=>register(policies,policy),exchangeTransport:transport=>register(transports,transport),
  configurePeer:(realm,peer,channel,secret)=>request({op:secret?'configure-peer':'clear-peer',realm,peer,channel,secret}),
  package:(realm,id)=>request({op:'package',realm,id}),markDelivery:(realm,id,options)=>request({op:'attempt',realm,id,...options}),deliveryState:realm=>({outbox:list(realm,'exchange-outbox'),inbox:list(realm,'exchange-inbox')}),receivePackage,retryDelivery,
  async exchange(from,to,collection,record,options={}){
   const policy=policyFor(collection),metadata=policy?await policy.prepare({from,to,collection,record,options}):{type:options.type||'workspace/record-transferred',eventClass:options.eventClass||'fact',refs:options.refs||{},approvals:options.approvals||[]}
   let channel=options.channel||'local',manual=!!options.manual
   for(const transport of transports.values()){const selected=await transport.select?.({from,to,collection,record,options});if(selected){channel=selected.channel;manual=selected.mode==='manual';break}}
   const queued=await request({op:'queue',realm:from,to,collection,record,metadata,channel,actor:options.actor})
   return manual?deliveryResult(queued):retryDelivery(from,queued.id,options)
  },
  async resolveConflict(realm,id,{actor,acceptIncoming=false}={}){
   const row=get(realm,'exchange-inbox',id);if(!row||row.status!=='conflict')throw Object.assign(new Error('There is no unresolved conflict'),{status:409})
   if(!actor||!acceptIncoming)throw Object.assign(new Error('A signed-in human must explicitly accept the exact received record; alternative terms must be reviewed and reissued by the business owner.'),{status:409})
   const inspected=await request({op:'inspect-package',realm,package:row.package}),policy=policyFor(inspected.collection),verdict=policy?await policy.validate(inspected):{ok:true}
   if(!verdict.ok)throw Object.assign(new Error(verdict.message),{status:409})
   await request({op:'append',realm,type:'exchange/conflict-approved',body:{msgId:id,humanId:actor,recordHash:inspected.recordHash,originalBodyHash:row.package.envelope.body_hash,conflicts:row.conflicts,decision:'accept-exact-received'},actor:`human:${actor}`})
   return request({op:'settle-inbox',realm,id,expectedHash:inspected.localHash,outcome:'applied',record:acceptPublic(inspected.local,inspected.record,inspected.base),resolve:true,resolvedBy:actor})
  },
  projection(realm,{seq,time,collection}={}){assertReadable(realm);const output=new Map();for(const event of history.get(realm)||[]){if(seq!==undefined&&event.seq>Number(seq)||time&&event.ts>time||!valid(event.body)||collection&&event.body.collection!==collection)continue;const key=event.body.collection;if(!output.has(key))output.set(key,new Map());output.get(key).set(event.body.record.id,event.body.record)}return copy(Object.fromEntries([...output].map(([key,rows])=>[key,[...rows.values()]])))},
 }
 ctx.provide('store',service)
}
