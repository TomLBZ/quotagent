import {createHash} from 'node:crypto'
const clone=value=>structuredClone(value)
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value
export const payloadHash=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
const brief=(value,max=1000)=>String(value??'').trim().slice(0,max)
const refOf=event=>({realm:event.realm,seq:event.seq,hash:event.entry_hash})
function pageLink(value){if(!value||typeof value.view!=='string'||!/^[\w-]+$/.test(value.view))return null;return Object.fromEntries(Object.entries(value).filter(([key,item])=>key==='view'||(/^(?:[A-Za-z]\w*(?:Id|Key)|tab)$/.test(key)&&['string','number','boolean'].includes(typeof item)&&String(item).length<=240)))}
export function createProvenance({store,realmIds}){
 const recorded=(allowed,ref)=>{
  if(!ref||!allowed.has(ref.realm))fail('A review source is outside the current account or party workspace.',403)
  if(!Number.isSafeInteger(ref.seq)||ref.seq<1||typeof ref.hash!=='string')fail('A review source needs its exact recorded sequence and digest.')
  const event=store.events(ref.realm).find(row=>row.seq===ref.seq)
  if(!event||event.entry_hash!==ref.hash)fail('A review source no longer matches its recorded event. Prepare a fresh proposal.',409)
  return event
 }
 const capture=(user,input)=>{
  const allowed=new Set(realmIds(user)),sources=input.preview?.sources??[],rawRisks=input.preview?.risks
  if(!Array.isArray(sources)||sources.length>32)fail('A review can capture at most 32 explicit source references.')
  if(rawRisks!==undefined&&(!Array.isArray(rawRisks)||rawRisks.length>50))fail('Review risk flags must be an array of at most 50 explicit flags.')
  const references=sources.map((source,index)=>{
   const event=recorded(allowed,source.ref),body=event.body
   if(source.collection&&body?.collection!==source.collection||source.recordId&&body?.record?.id!==source.recordId)fail('A review source reference identifies a different record.',409)
   return{key:String(index),label:brief(source.label||source.recordId||event.type,180),collection:source.collection||body?.collection||null,recordId:source.recordId||body?.record?.id||null,ref:{...refOf(event),realm:source.ref.realm},type:event.type,at:event.ts,link:pageLink(source.link)}
  })
  const flags=(rawRisks||[]).map((value,index)=>{const message=typeof value==='string'?value:value?.message||value?.description||value?.label;if(!brief(message))fail('Every declared risk flag needs a readable message.');return{id:brief(value?.id||value?.code||'flag-'+index,120),message:brief(message,2000),severity:typeof value==='object'&&['info','warning','high'].includes(value.severity)?value.severity:'warning',source:typeof value==='object'?brief(value.source||'',180):''}})
  return{version:'quotagent/action-provenance/v1',references,risks:{state:rawRisks===undefined?'not-assessed':'supplied',flags},limitations:references.length?[]:['The owning plugin did not supply upstream record references.']}
 }
 const proposal=(action,allowed)=>{const realm=action.realmId||action.ownerId;if(!allowed.has(realm))fail('The proposal ledger is no longer available to this account.',403);return store.events(realm).find(event=>event.type==='actions/proposed'&&event.body?.collection==='review-actions'&&event.body.record?.id===action.id)}
 const inspect=(user,action)=>{
  const allowed=new Set(realmIds(user)),event=proposal(action,allowed),original=event?.body?.record?.provenance,captured=original?.version==='quotagent/action-provenance/v1',computed=payloadHash(action.input),proposalHash=event?.body?.record?.inputHash||null
  const references=(captured?original.references:[]).map(source=>{try{recorded(allowed,source.ref);return{...clone(source),available:true}}catch(error){return{...clone(source),available:false,reason:error.status===403?'Current account access no longer includes this source realm.':'The captured source event is currently unavailable or changed.'}}})
  return{actionId:action.id,ownerPlugin:typeof action.source==='object'?action.source?.plugin||action.kind:action.kind,sourceKind:typeof action.source==='string'?action.source:action.source?.kind||'human proposal',
   payload:{algorithm:'SHA-256',serialization:'sorted-key JSON/v1',recorded:action.inputHash||null,computed,state:!action.inputHash||!proposalHash?'unmeasured':action.inputHash===computed&&proposalHash===action.inputHash?'matches':'mismatch',matches:!!action.inputHash&&!!proposalHash&&action.inputHash===computed&&proposalHash===action.inputHash},
   proposal:event?{key:'proposal',label:'Original proposal',type:event.type,at:event.ts,ref:{...refOf(event),realm:action.realmId||action.ownerId},available:true}:null,
   capture:captured?'recorded':'historical-unmeasured',references,risks:captured?clone(original.risks):{state:'not-assessed',flags:[]},
   limitations:captured?clone(original.limitations):['This historical proposal did not capture upstream source references. Its frozen input is retained; current records are not substituted.'],
   previousActionId:action.source?.previousActionId||null,runId:action.runId||null}
 }
 const source=(user,action,key)=>{
  const allowed=new Set(realmIds(user));let event
  if(key==='proposal'){event=proposal(action,allowed);if(!event)fail('The original proposal event is unavailable.',404)}
  else{const value=proposal(action,allowed)?.body?.record?.provenance?.references?.find(row=>row.key===key);if(!value)fail('This source is not captured by the selected action.',404);event=recorded(allowed,value.ref)}
  return{event:clone(event),notice:'This is the original recorded source. A matching local digest does not establish the truth of an external claim.'}
 }
 return{capture,inspect,source}
}
