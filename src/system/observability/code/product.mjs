import {mkdirSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
export const name='native-observability'
export const inject=['web','store','accounts','settings']
export const provides=['operations']
const fail=(message,status=403)=>{throw Object.assign(new Error(message),{status})}
const admin=user=>{if(user?.role!=='admin')fail('Sign in to the separate administrator account to inspect application operations.')}
const countStates=rows=>rows.reduce((result,row)=>{const key=['pending','running','paused','completed','failed','canceled','uncertain','awaiting-review','granted','succeeded','queued','delivered','held','conflict','rejected','active','proposed','deployed','rolled-back','needs-human'].includes(row.status)?row.status:'other';result[key]=(result[key]||0)+1;return result},{})
export function apply(ctx,config={}){
 const directory=join(ctx.store.root,'operations'),filename=join(directory,'summary.json');let timer,disposed=false,lastError=null
 const sample=user=>{
  admin(user);const health=ctx.store.health(),owners=ctx.accounts.list(),available=[],unavailable=[],totals={events:0,requests:0,completed:0,failed:0,unknown:0,active:0,queued:0,retries:0},circuits={},collections={},eventFamilies={},sources={ledger:'workspace-store',plugins:ctx.get('plugins')?'plugin-manager':'unavailable',provider:ctx.get('aiRuntime')?'agent-runtime':'unavailable'}
  for(const owner of owners){if(health[owner.id]?.healthy===false){unavailable.push({code:health[owner.id].code||'LEDGER_UNAVAILABLE'});continue}
   try{const keys=['review-actions','clarifications','faqs','workflow-runs','exchange-outbox','exchange-inbox','studio-proposals','studio-feedback','studio-shadow-reports','provider-requests','mail-messages','evidence-exports','evidence-rebuilds'],events=ctx.store.events(owner.id),records=Object.fromEntries(keys.map(key=>[key,ctx.store.list(owner.id,key)])),runtime=ctx.get('aiRuntime')?ctx.get('aiRuntime').stats(owner):null;available.push(owner.id);totals.events+=events.length;for(const event of events){const prefix=event.type.split('/')[0];eventFamilies[prefix]=(eventFamilies[prefix]||0)+1}
    for(const key of keys){const rows=records[key],states=countStates(rows);collections[key]||={total:0,states:{}};collections[key].total+=rows.length;for(const [state,count] of Object.entries(states))collections[key].states[state]=(collections[key].states[state]||0)+count}
    if(runtime){for(const key of ['requests','completed','failed','retries'])totals[key]+=runtime.counts[key]||0;totals.unknown+=records['provider-requests'].filter(row=>['pending','interrupted'].includes(row.status)).length;totals.active+=runtime.capacity.active;totals.queued+=runtime.capacity.queued;for(const row of runtime.circuits)circuits[row.state]=(circuits[row.state]||0)+1}
   }catch(error){if(available.at(-1)===owner.id)available.pop();unavailable.push({code:error.code||'SOURCE_UNAVAILABLE'})}
  }
  let sharedRuntime;try{const trials=ctx.store.list('system','studio-canaries');sharedRuntime={available:true,trials:trials.length,states:countStates(trials)}}catch{sharedRuntime={available:false,trials:null,states:null}}
  const plugins=ctx.get('plugins')?ctx.get('plugins').list(user).filter(row=>row.status!=='available').map(row=>({id:row.id,status:row.status,parentId:row.parentId||null})):null
  return {generatedAt:new Date().toISOString(),source:'native-cordis-and-ledger-projections',coverage:{totalAccounts:owners.length,availableAccounts:available.length,unavailableAccounts:unavailable.length,complete:unavailable.length===0,unavailable},sources,totals:{...totals,...(!ctx.get('aiRuntime')?{requests:null,completed:null,failed:null,unknown:null,active:null,queued:null,retries:null}:{})},circuits,collections,eventFamilies,plugins,sharedRuntime,process:{uptimeSeconds:Math.round(process.uptime()),residentBytes:process.memoryUsage().rss},snapshot:{enabled:ctx.settings.get(user,'operations').periodicSnapshots,lastError},scope:'Application operational metadata only; counts cover readable active account realms. No account record bodies or private values.'}
 }
 const timeline=user=>{
  if(!user?.id)fail('Sign in to inspect your event timeline.',401)
  const realms=new Set([user.id]);if(user.role!=='admin'&&ctx.get('teams'))for(const workspace of ctx.get('teams').list(user))if(workspace.side===user.role)realms.add(workspace.id)
  return [...realms].flatMap(realm=>ctx.store.events(realm).map(event=>({id:realm+':'+event.seq,realm,sequence:event.seq,type:event.type,at:event.ts,hash:event.entry_hash}))).sort((a,b)=>String(b.at).localeCompare(String(a.at))||b.sequence-a.sequence)
 }
 const persist=()=>{const owner=ctx.accounts.list().find(user=>user.role==='admin'&&!user.disabled);if(!owner)return null;const snapshot=sample(owner);if(!ctx.settings.get(owner,'operations').periodicSnapshots)return snapshot;mkdirSync(directory,{recursive:true,mode:0o700});const temporary=join(directory,randomUUID()+'.tmp');writeFileSync(temporary,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});renameSync(temporary,filename);lastError=null;return snapshot}
 const poll=()=>{if(disposed)return;try{persist()}catch{lastError='The derived operations snapshot could not be refreshed.'}const owner=ctx.accounts.list().find(user=>user.role==='admin'&&!user.disabled),seconds=owner?ctx.settings.get(owner,'operations').snapshotSeconds:30;timer=setTimeout(poll,config.pollMs||seconds*1000);timer.unref?.()}
 ctx.effect(()=>ctx.settings.define({id:'operations',name:'Operations metadata',scope:'admin',defaults:{periodicSnapshots:true,snapshotSeconds:30},fields:[{key:'periodicSnapshots',label:'Write periodic operational snapshots',type:'boolean'},{key:'snapshotSeconds',label:'Snapshot interval (seconds)',type:'number',min:10,max:3600}]}))
 ctx.provide('operations',{sample,timeline,persist})
 ctx.effect(()=>ctx.web.contribute({id:'operations',label:'Operations & timeline',icon:'clock',roles:['contractor','supplier','admin'],order:78}))
 ctx.effect(()=>ctx.web.route('GET','/operations',({user})=>sample(user),{admin:true}))
 ctx.effect(()=>ctx.web.route('GET','/operations/export',({user})=>({filename:'operations-summary.json',mime:'application/json',content:JSON.stringify(sample(user),null,2)+'\n'}),{admin:true}))
 ctx.effect(()=>ctx.web.collection({id:'event-timeline',label:'Account event timeline',roles:['contractor','supplier','admin'],columns:[{key:'realm',label:'Workspace',type:'enum'},{key:'sequence',label:'Sequence',type:'number'},{key:'type',label:'Event type',type:'enum'},{key:'at',label:'Recorded at',type:'date'},{key:'hash',label:'Chain hash',type:'text'}],defaults:{size:25},load:timeline}))
 ctx.effect(()=>{if(config.poll!==false)poll();return()=>{disposed=true;clearTimeout(timer);if(existsSync(filename))unlinkSync(filename)}})
}
