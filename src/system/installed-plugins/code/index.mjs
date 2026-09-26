import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import * as utilityRuntime from '../../plugin-studio/code/tool-runtime.mjs'
import {COLLECTION,copy,clean,fail,now,idOf,parseDescriptor,descriptorOf} from '../../plugin-studio/code/descriptor.mjs'
import {artifacts,hash} from './artifacts.mjs'
export const name='installed-plugin-runtime'
export const inject=['web','store','accounts']
export const provides=['installedPlugins','studioRuntime']
export async function apply(ctx,config={}){
 const archive=artifacts(ctx,config),mounted=new Map(),registered=new Map();let disposed=false,pending=Promise.resolve(),assistant=null,procurement=null,utilities=null
 const serialize=task=>{const result=pending.then(()=>{if(disposed)fail('The installed runtime is unavailable.',503);return task()});pending=result.catch(()=>{});return result}
 const records=()=>ctx.store.list('system',COLLECTION).filter(row=>!row.deleted)
 const lookup=id=>{const row=ctx.store.get('system',COLLECTION,id);if(!row||row.deleted)fail('Installed extension not found.',404);return row}
 const lineage=plugin=>{let current=plugin;const seen=new Set();while(current.originId&&!seen.has(current.id)){seen.add(current.id);const parent=ctx.store.get('system',COLLECTION,current.originId);if(!parent)return current.lineageId||current.originId;current=parent}return current.lineageId||current.id}
 const save=async(plugin,actor,event)=>{const record={...plugin,updatedAt:now()};await ctx.store.put('system',COLLECTION,record,{actor,event});return record}
 const canManage=(user,plugin)=>{if(!ctx.accounts.can(user,'plugins:manage'))fail('Extension management is disabled for this account.',403);if(plugin.global&&user.role!=='admin')fail('Only administrators manage global extensions.',403);if(user.role!=='admin'&&plugin.ownerId!==user.id)fail('This extension belongs to another account.',403)}
 const canRead=(user,plugin)=>{if(!user?.id||user.role!=='admin'&&plugin.ownerId!==user.id&&!plugin.global)fail('Install this extension in your own workspace first.',403)}
 const isActive=plugin=>!!plugin.enabled&&mounted.has(plugin.id)
 const newest=(a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))||b.id.localeCompare(a.id)
 const activeFirst=(a,b)=>Number(isActive(b))-Number(isActive(a))||newest(a,b)
 const scopeKey=plugin=>`${plugin.global?'*':plugin.ownerId}:${lineage(plugin)}`
 const trials=()=>ctx.store.list('system','studio-canaries')
 const activeTrial=id=>trials().find(row=>row.pluginId===id&&row.status==='active')
 const selectedTrial=(user,id)=>{const trial=activeTrial(id);return trial?.cohortIds.includes(user.id)?trial:null}
 const attach=(descriptor,options={})=>{
  const key=options.runtimeId||descriptor.id;if(registered.has(key))fail('This extension revision is already attached.',409)
  const audience=options.audience||[descriptor.global?'*':descriptor.ownerId],disposers=[]
  const visible={...copy(descriptor),id:key,installedId:descriptor.id,enabled:true,updatedAt:options.updatedAt||descriptor.createdAt,artifactHash:options.sourceHash,trialId:options.trialId||null}
  try{
   for(const owner of audience)disposers.push(ctx.web.extension(owner,{...visible,ownerId:owner==='*'?descriptor.ownerId:owner,global:owner==='*'}))
   if(descriptor.kind==='calculator')disposers.push(utilities.register(audience.length===1?audience[0]:'*',visible,descriptor.spec.code))
   registered.set(key,{pluginId:descriptor.id,revisionId:descriptor.revisionId,sourceHash:options.sourceHash,contentHash:descriptor.contentHash,audience:[...audience]})
  }catch(error){for(const dispose of disposers.reverse())dispose();throw error}
  return()=>{for(const dispose of disposers.reverse())dispose();registered.delete(key)}
 }
 const unmount=async key=>{const active=mounted.get(key);if(active)await active.fiber.dispose();mounted.delete(key)}
 const mountRevision=async(plugin,revision,{key=plugin.id,audience,trialId=null,current=true}={})=>{
  const verified=archive.verify(plugin,revision);if(!verified.ok)fail('The revision artifact is inconsistent; inspect its differences.',409)
  const file=current?archive.install(plugin,revision):archive.files(plugin,revision).source
  await unmount(key)
  const module=await import(`${pathToFileURL(file).href}?instance=${randomUUID()}`)
  const fiber=await ctx.plugin(module,{attach,runtimeId:key,audience:audience||[plugin.global?'*':plugin.ownerId],trialId,sourceHash:revision.sourceHash,updatedAt:trialId?now():plugin.updatedAt||revision.createdAt})
  if(fiber.state!==2){await fiber.dispose();fail('The extension revision could not activate.',409)}
  mounted.set(key,{fiber,revisionId:revision.id,sourceHash:revision.sourceHash});return fiber
 }
 const activate=async(plugin,revision,actor,event='studio/plugin-configured')=>{
  const before=ctx.store.get('system',COLLECTION,plugin.id),old=before?.revisionId?archive.get(plugin.id,before.revisionId):null
  try{if(plugin.enabled)await mountRevision(plugin,revision);else archive.install(plugin,revision)
   const record=await save({...plugin,...revision.descriptor,revisionId:revision.id,revisionNumber:revision.number,contentHash:revision.contentHash,artifactHash:revision.sourceHash},actor,event)
   if(plugin.enabled)for(const previous of records().filter(row=>row.id!==plugin.id&&scopeKey(row)===scopeKey(plugin)&&(row.enabled||mounted.has(row.id)))){await unmount(previous.id);await save({...previous,enabled:false},actor,'studio/plugin-unloaded')}
   return record
  }catch(error){if(old){try{if(before.enabled)await mountRevision(before,old);else archive.install(before,old);await save(before,actor,'studio/revision-activation-reverted')}catch(restoreError){await save({...before,enabled:false,runtimeError:`Activation failed and baseline could not be restored: ${restoreError.message}`},actor,'studio/revision-restore-failed')}}else await unmount(plugin.id);throw error}
 }
 const baseline=async plugin=>{
  if(plugin.revisionId)return archive.get(plugin.id,plugin.revisionId)
  const legacySourceHash=archive.retainLegacy(plugin),revision=await archive.create({...plugin,lineageId:lineage(plugin)},plugin,{actor:'system:installed-plugins',reason:'Imported current unversioned installation',origin:legacySourceHash?{legacySourceHash}:null})
  archive.install(plugin,revision)
  await ctx.store.put('system',COLLECTION,{...plugin,lineageId:lineage(plugin),revisionId:revision.id,revisionNumber:revision.number,contentHash:revision.contentHash,artifactHash:revision.sourceHash,updatedAt:plugin.updatedAt||plugin.createdAt},{actor:'system:installed-plugins',event:'studio/revision-imported'});return revision
 }
 const publicPlugin=(plugin,user)=>{
  const trial=user&&selectedTrial(user,plugin.id),revision=plugin.revisionId?archive.get(plugin.id,trial?.candidateRevisionId||plugin.revisionId):null,visible=copy(plugin);delete visible.generationPrompt
  return{...visible,...revision?.descriptor,lineageId:lineage(plugin),scope:plugin.global?'global':'personal',canManage:!!user&&(user.role==='admin'||!plugin.global&&plugin.ownerId===user.id),source:revision?.source||'',enabled:isActive(plugin),loaded:mounted.has(plugin.id),ownerName:ctx.accounts.get(plugin.ownerId)?.name||'Community',revisionId:revision?.id,revisionNumber:revision?.number,artifactHash:revision?.sourceHash,contentHash:revision?.contentHash,baselineRevisionId:plugin.revisionId,canary:trial?{id:trial.id,revisionNumber:revision.number,status:trial.status}:null,artifact:`${plugin.id}/index.mjs`,...(plugin.kind==='skill'?{skillFile:`${plugin.id}/SKILL.md`}:{})}
 }
 const list=user=>{
  const groups=new Map();for(const plugin of records()){const key=lineage(plugin);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(plugin)}
  const choose=rows=>[...rows].sort((a,b)=>{const priority=p=>p.ownerId===user.id&&!p.global?(isActive(p)?0:2):p.global?(isActive(p)?1:3):(isActive(p)?4:5);return priority(a)-priority(b)||newest(a,b)})[0],plugins=[],market=[]
  for(const[key,instances]of groups){const visible=instances.filter(p=>user.role==='admin'||p.ownerId===user.id||p.global);if(visible.length){const selected=choose(visible);plugins.push({...publicPlugin(selected,user),scopeLabels:visible.map(p=>p.global?'Global default':`Personal · ${ctx.accounts.get(p.ownerId)?.name||'User'}`),instances:visible.sort(activeFirst).map(p=>publicPlugin(p,user))})}
   const published=instances.filter(p=>p.published||p.global);if(published.length){const source=published.find(p=>p.id===key)||published.find(p=>!p.global)||published[0],installed=choose(instances.filter(p=>p.ownerId===user.id&&!p.global||p.global));market.push({...publicPlugin(source,user),installed:!!installed,installedId:installed?.id||null,installedEnabled:!!installed&&isActive(installed),installationScope:installed?(installed.global?'global':installed.id===key?'owner':'personal'):null})}}
  plugins.sort(newest);market.sort(newest);return{plugins,market,skills:plugins.filter(p=>p.kind==='skill')}
 }
 const get=(user,id)=>{const plugin=lookup(id);canRead(user,plugin);return publicPlugin(plugin,user)}
 const history=(user,id)=>{const plugin=lookup(id);canManage(user,plugin);const activated=new Set(ctx.store.events('system').filter(event=>event.body?.collection===COLLECTION&&event.body?.record?.id===id).map(event=>event.body.record.revisionId));activated.add(plugin.revisionId);return{plugin:publicPlugin(plugin,user),revisions:archive.list(id).map(revision=>({...revision,active:revision.id===plugin.revisionId,everActive:activated.has(revision.id)}))}}
 const inventory=(user,{limit=100,offset=0}={})=>{
  limit=Math.max(1,Math.min(200,Number(limit)||100));offset=Math.max(0,Number(offset)||0)
  const rows=records().filter(plugin=>user.role==='admin'||plugin.ownerId===user.id||plugin.global).sort((a,b)=>a.id.localeCompare(b.id)).map(plugin=>{
   const revision=plugin.revisionId?archive.get(plugin.id,plugin.revisionId):null,checked=revision?archive.verify(plugin,revision,{current:true}):{differences:[{field:'record.revisionId',expected:'An imported immutable revision',actual:null}],actual:{}},live=registered.get(plugin.id)||null,differences=[...checked.differences]
   if(revision)for(const[field,expected,actual]of[['record.artifactHash',revision.sourceHash,plugin.artifactHash],['record.contentHash',revision.contentHash,plugin.contentHash],['record.revisionNumber',revision.number,plugin.revisionNumber],['record.descriptorHash',revision.contentHash,hash(descriptorOf(plugin))]])if(expected!==actual)differences.push({field,expected,actual:actual??null})
   if(plugin.enabled&&(!live||live.revisionId!==plugin.revisionId))differences.push({field:'live.revisionId',expected:plugin.revisionId,actual:live?.revisionId||null})
   if(live&&revision&&live.sourceHash!==revision.sourceHash)differences.push({field:'live.sourceHash',expected:revision.sourceHash,actual:live.sourceHash})
   if(!plugin.enabled&&live)differences.push({field:'live.enabled',expected:false,actual:true})
   return{id:plugin.id,kind:plugin.kind,scope:plugin.global?'global':'personal',ownerId:plugin.ownerId,revisionNumber:revision?.number||null,revisionId:plugin.revisionId||null,enabled:!!plugin.enabled,status:differences.length?'inconsistent':'consistent',recorded:{sourceHash:revision?.sourceHash||null,manifestHash:revision?.manifestHash||null,contentHash:revision?.contentHash||null},artifact:checked.actual,live:live?{revisionId:live.revisionId,sourceHash:live.sourceHash}:null,origin:revision?.origin||null,differences}
  })
  return{scope:'generated installed artifacts',items:rows.slice(offset,offset+limit),total:rows.length,offset,limit,truncated:Math.max(0,rows.length-offset-limit),inconsistent:rows.filter(row=>row.status==='inconsistent').length}
 }
 const create=(user,descriptor,options={})=>serialize(async()=>{
  if(!ctx.accounts.can(user,'plugins:manage'))fail('Extension creation is disabled for this account.',403)
  const plugin={id:idOf(),...parseDescriptor({content:JSON.stringify(descriptor)}),ownerId:user.id,enabled:true,published:false,global:false,createdAt:now(),...options};plugin.lineageId=lineage(plugin)
  const revision=await archive.create(plugin,plugin,{actor:user.id,reason:options.reason||'Created extension',origin:options.origin||null});const saved=await activate(plugin,revision,user.id,options.event||'studio/plugin-created');return{ok:true,plugin:publicPlugin(saved,user),...list(user)}
 })
 const ensureNoTrial=id=>{if(activeTrial(id))fail('Finish or roll back the active trial before changing this extension.',409)}
 const configure=(user,id,input={})=>serialize(async()=>{
  const plugin=lookup(id);canManage(user,plugin);ensureNoTrial(id);if(input.expectedRevisionId&&input.expectedRevisionId!==plugin.revisionId)fail('This extension changed while you were editing. Reopen the latest revision.',409)
  const descriptor=parseDescriptor({content:JSON.stringify({name:input.name??plugin.name,description:input.description??plugin.description,kind:plugin.kind,spec:{...plugin.spec,...input.spec}})})
  if(hash(descriptorOf(descriptor))===plugin.contentHash)return{ok:true,plugin:publicPlugin(plugin,user),...list(user)}
  const revision=await archive.create({...plugin,lineageId:lineage(plugin)},descriptor,{actor:user.id,reason:clean(input.reason||'Human configuration edit',500)})
  const saved=await activate(plugin,revision,user.id);return{ok:true,plugin:publicPlugin(saved,user),...list(user)}
 })
 const stage=(user,id,descriptor,options={})=>serialize(async()=>{const plugin=lookup(id);canManage(user,plugin);if(options.baseRevisionId&&plugin.revisionId!==options.baseRevisionId)fail('The proposal baseline has changed. Create a revision against the current extension.',409);const valid=parseDescriptor({content:JSON.stringify(descriptor)});if(valid.kind!==plugin.kind)fail('A revision must keep the extension kind. Create a separate extension for a different capability.');return archive.create({...plugin,lineageId:lineage(plugin)},valid,{...options,actor:user.id})})
 const restore=(user,id,revisionId,{reason='Human revision restore'}={})=>serialize(async()=>{const plugin=lookup(id);canManage(user,plugin);ensureNoTrial(id);const revision=archive.get(id,revisionId),saved=await activate(plugin,revision,user.id,'studio/revision-restored');await ctx.store.append('system','studio/revision-restore-verified',{pluginId:id,revisionId:revision.id,sourceHash:revision.sourceHash,reason},{actor:user.id});return{ok:true,plugin:publicPlugin(saved,user),...list(user)}})
 const cloneInstall=async(user,source,{global=false}={})=>{
  const revision=archive.get(source.id,source.revisionId),origin={pluginId:source.id,revisionId:revision.id,contentHash:revision.contentHash,sourceHash:revision.sourceHash}
  const plugin={...source,...revision.descriptor,id:idOf(),ownerId:user.id,originId:source.id,lineageId:lineage(source),enabled:true,global,published:global,createdAt:now(),originRevision:origin};delete plugin.generationPrompt;delete plugin.revisionId;delete plugin.revisionNumber
  const own=await archive.create(plugin,revision.descriptor,{actor:user.id,reason:global?'Promoted independent global copy':'Installed independent account copy',origin});return activate(plugin,own,user.id,global?'studio/plugin-promoted':'studio/plugin-installed')
 }
 const mutate=(user,id,action,input={})=>serialize(async()=>{
  const plugin=lookup(id);if(!ctx.accounts.can(user,'plugins:manage'))fail('Extension management is disabled for this account.',403)
  if(action==='install'){if(!plugin.published&&!plugin.global&&plugin.ownerId!==user.id)fail('This extension has not been published.',403);const existing=records().filter(row=>row.ownerId===user.id&&!row.global&&lineage(row)===lineage(plugin)).sort(activeFirst)[0];if(existing){ensureNoTrial(existing.id);const next=await activate({...existing,enabled:true},archive.get(existing.id,existing.revisionId),user.id,'studio/plugin-loaded');return{ok:true,plugin:publicPlugin(next,user),...list(user)}}const next=await cloneInstall(user,plugin);return{ok:true,plugin:publicPlugin(next,user),...list(user)}}
  if(action==='promote'){if(user.role!=='admin')fail('Only administrators can promote a global default.',403);const existing=records().filter(row=>row.global&&lineage(row)===lineage(plugin)).sort(activeFirst)[0];if(existing){const next=await activate({...existing,enabled:true},archive.get(existing.id,existing.revisionId),user.id,'studio/plugin-loaded');return{ok:true,plugin:publicPlugin(next,user),...list(user)}}const next=await cloneInstall(user,plugin,{global:true});return{ok:true,plugin:publicPlugin(next,user),...list(user)}}
  canManage(user,plugin);ensureNoTrial(id);let next
  if(action==='load')next=await activate({...plugin,enabled:true},archive.get(id,plugin.revisionId),user.id,'studio/plugin-loaded')
  else if(action==='unload'||action==='delete'){await unmount(id);next=await save({...plugin,enabled:false,...(action==='delete'?{deleted:true,published:false}:{})},user.id,action==='delete'?'studio/plugin-deleted':'studio/plugin-unloaded')}
  else if(action==='publish')next=await save({...plugin,published:true},user.id,'studio/plugin-published')
  else fail('Unknown installed extension action.',404)
  return{ok:true,plugin:publicPlugin(next,user),...list(user)}
 })
 const observations=id=>ctx.store.list('system','studio-canary-observations').filter(row=>row.canaryId===id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
 const finishTrial=async(trial,actor,reason='Human trial rollback')=>{
  trial=ctx.store.get('system','studio-canaries',trial.id)||trial
  if(trial.status!=='active')return trial
  const plugin=lookup(trial.pluginId),revision=archive.get(plugin.id,trial.baselineRevisionId);await unmount(trial.id)
  await activate(plugin,revision,actor,'studio/revision-restored')
  const observed=observations(trial.id),failed=observed.some(row=>row.outcome==='fail'),record={...trial,status:'rolled-back',finishedAt:now(),reason,outcome:failed?'failed':observed.length?'observed':'unmeasured',rollbackVerified:archive.verify(plugin,revision,{current:true}).ok&&mounted.get(plugin.id)?.revisionId===revision.id,observationCount:observed.length}
  await ctx.store.put('system','studio-canaries',record,{actor,event:'studio/canary-rolled-back'});return record
 }
 const startTrial=(user,id,revisionId,input={})=>serialize(async()=>{
  const plugin=lookup(id);canManage(user,plugin);ensureNoTrial(id);if(!isActive(plugin))fail('Enable the baseline extension before starting a trial.')
  const revision=archive.get(id,revisionId);if(revision.id===plugin.revisionId)fail('Choose a different candidate revision.')
  const cohortIds=[...new Set(input.cohortIds||[user.id])];if(!cohortIds.length||cohortIds.length>20)fail('Choose between one and twenty trial accounts.')
  if(!plugin.global&&(cohortIds.length!==1||cohortIds[0]!==plugin.ownerId))fail('A personal extension trial stays in its owner’s account.',403)
  if(cohortIds.some(id=>!ctx.accounts.get(id)))fail('A selected trial account no longer exists.')
  const number=(value,fallback,min,max)=>{const n=Number(value??fallback);if(!Number.isFinite(n)||n<min||n>max)fail('Choose valid trial observation limits.');return n}
  const limits={maxErrors:number(input.maxErrors,0,0,20),maxLatencyMs:number(input.maxLatencyMs,plugin.kind==='skill'?120000:1000,1,300000),maxHumanRate:number(input.maxHumanRate,1,0,1),maxObservations:number(input.maxObservations,20,1,100),minutes:number(input.minutes,30,1,1440)}
  const trial={id:`trial-${randomUUID()}`,pluginId:id,ownerId:plugin.ownerId,startedBy:user.id,baselineRevisionId:plugin.revisionId,candidateRevisionId:revision.id,proposalId:input.proposalId||null,cohortIds,limits,status:'active',startedAt:now(),expiresAt:new Date(Date.now()+limits.minutes*60000).toISOString()}
  await mountRevision(plugin,revision,{key:trial.id,audience:cohortIds,trialId:trial.id,current:false})
  try{await ctx.store.put('system','studio-canaries',trial,{actor:user.id,event:'studio/canary-started'})}catch(error){await unmount(trial.id);throw error}return trial
 })
 const observe=(user,trialId,input={},internal=false)=>serialize(async()=>{
  const trial=ctx.store.get('system','studio-canaries',trialId);if(!trial||trial.status!=='active')fail('This trial is no longer active.',409);if(!trial.cohortIds.includes(user.id))fail('This account is outside the trial cohort.',403)
  if(!['pass','fail'].includes(input.outcome))fail('Choose an observed result.')
  const row={id:randomUUID(),canaryId:trial.id,pluginId:trial.pluginId,accountId:user.id,kind:internal?'execution':'human-preview',outcome:input.outcome,needsHuman:!!input.needsHuman,durationMs:internal?input.durationMs??null:null,note:clean(input.note,2000),createdAt:now(),revisionId:trial.candidateRevisionId}
  await ctx.store.put('system','studio-canary-observations',row,{actor:user.id,event:'studio/canary-observed'})
  const rows=observations(trial.id),errors=rows.filter(item=>item.outcome==='fail').length,rate=rows.filter(item=>item.needsHuman).length/rows.length
  const exceeded=errors>trial.limits.maxErrors||row.durationMs!==null&&row.durationMs>trial.limits.maxLatencyMs||rate>trial.limits.maxHumanRate
  const ended=exceeded||rows.length>=trial.limits.maxObservations
  const next=ended?await finishTrial(trial,'system:installed-plugins',exceeded?'Observed limit exceeded; automatic rollback':'Observation window completed; baseline restored'):trial
  return{observation:row,trial:next,automaticRollback:ended}
 })
 const rollback=(user,trialId,input={})=>serialize(async()=>{const trial=ctx.store.get('system','studio-canaries',trialId);if(!trial)fail('Trial not found.',404);canManage(user,lookup(trial.pluginId));return finishTrial(trial,user.id,clean(input.reason||'Human trial rollback',500))})
 const run=async(user,id,input={})=>{
  const plugin=lookup(id);canRead(user,plugin);if(!ctx.accounts.can(user,'plugins:manage'))fail('Extension execution is disabled for this account.',403);if(!isActive(plugin))fail('Enable this extension before running it.')
  const trial=selectedTrial(user,id),revision=archive.get(id,trial?.candidateRevisionId||plugin.revisionId),descriptor=revision.descriptor,start=performance.now();let result
  if(input.expectedRevisionId&&input.expectedRevisionId!==revision.id)fail('This tool changed while it was open. Reopen it to review the current inputs.',409)
  try{
   if(descriptor.kind==='calculator'){
    const raw=input.input??{};if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('Utility input must be an object.')
    const values=utilityRuntime.normalizeInput(descriptor,raw)
    const workspace=user.role!=='admin'&&procurement?procurement.snapshot(ctx.accounts.get(user.id)): {rfqs:[],quotes:[],orders:[],messages:[],changes:[],contacts:[],stats:{},comparison:[]}
    result={ok:true,result:utilities.run(user,trial?.id||id,values,workspace)};await ctx.store.append(user.id,'studio/tool-ran',{pluginId:id,revisionId:revision.id,name:descriptor.name,input:values,workspace,result:result.result},{actor:user.id})
   }else if(descriptor.kind==='skill'){
    if(!ctx.accounts.can(user,'assistant:use'))fail('The assistant is disabled for this account.',403);if(!assistant?.chat)fail('Enable the assistant before running this skill.',503)
    result={ok:true,...await assistant.chat(user,{message:`Run my saved workflow "${descriptor.name}":\n${descriptor.spec.prompt}${descriptor.spec.steps?.length?'\n\nWorkflow steps:\n'+descriptor.spec.steps.map((step,i)=>`${i+1}. ${step}`).join('\n'):''}`,...(input.rfqId?{rfqId:input.rfqId}:{})})};await ctx.store.append(user.id,'studio/skill-ran',{pluginId:id,revisionId:revision.id,name:descriptor.name,runId:result.run?.id,status:result.run?.status},{actor:user.id})
   }else fail('Only workflow skills and generated tools can be run.')
   if(trial){const failed=!!result.result?.error||result.run?.status==='failed',observed=await observe(user,trial.id,{outcome:failed?'fail':'pass',needsHuman:result.run?.status==='paused',durationMs:Math.round(performance.now()-start),note:failed?'Execution reported a failure.':'Actual installed extension execution completed.'},true);result.trial=observed.trial}
   return result
  }catch(error){if(trial)try{await observe(user,trial.id,{outcome:'fail',durationMs:Math.round(performance.now()-start),note:error.message},true)}catch{}throw error}
 }
 const workspace=user=>user.role!=='admin'&&procurement?procurement.snapshot(ctx.accounts.get(user.id)):{rfqs:[],quotes:[],orders:[],messages:[],changes:[],contacts:[],stats:{},comparison:[]};
 const verify=(user,id,revisionId)=>{const plugin=lookup(id);canManage(user,plugin);return archive.verify(plugin,archive.get(id,revisionId))};
 const revision=(user,id,revisionId)=>{const plugin=lookup(id);canManage(user,plugin);return archive.get(id,revisionId)}
 const trialView=(user,id)=>{const plugin=lookup(id);canManage(user,plugin);return trials().filter(row=>row.pluginId===id).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map(trial=>({...trial,observations:observations(trial.id)}))}
 ctx.provide('installedPlugins',{attach,list,get,lookup,lineage,isActive,create,configure,mutate,run,history,revision,verify,workspace,stage,restore,inventory,startTrial,observe,rollback,trials:trialView,publicPlugin,artifactRoot:archive.root})
 await ctx.plugin(utilityRuntime)
 ctx.inject(['studioRuntime'],child=>{utilities=child.studioRuntime;child.effect(()=>()=>{utilities=null})})
 ctx.inject(['assistant'],child=>{assistant=child.assistant;child.effect(()=>()=>{assistant=null})})
 ctx.inject(['procurement'],child=>{procurement=child.procurement;child.effect(()=>()=>{procurement=null})})
 for(const plugin of records())await baseline(plugin)
 const restored=new Set();for(const plugin of records().filter(row=>row.enabled).sort(newest)){const scope=scopeKey(plugin);if(restored.has(scope)){await save({...plugin,enabled:false},'system:installed-plugins','studio/plugin-unloaded');continue}restored.add(scope);try{await mountRevision(plugin,archive.get(plugin.id,plugin.revisionId))}catch(error){await save({...plugin,enabled:false,runtimeError:error.message},'system:installed-plugins','studio/revision-restore-failed')}}
 for(const trial of trials().filter(row=>row.status==='active')){try{await finishTrial(trial,'system:installed-plugins','Runtime restarted; baseline restored before further trial decisions')}catch(error){await ctx.store.put('system','studio-canaries',{...trial,status:'restore-failed',error:error.message,finishedAt:now()},{actor:'system:installed-plugins',event:'studio/canary-restore-failed'})}}
 const route=(method,path,handler,options)=>ctx.effect(()=>ctx.web.route(method,path,handler,options))
 route('GET','/installed-plugins',({user})=>({...list(user),activeTrials:trials().filter(row=>row.status==='active'&&row.cohortIds.includes(user.id)).map(row=>({id:row.id,pluginId:row.pluginId,candidateRevisionId:row.candidateRevisionId,expiresAt:row.expiresAt}))}))
 route('GET','/installed-plugins/inventory',({user,query})=>inventory(user,{limit:query.get('limit'),offset:query.get('offset')}))
 route('POST','/installed-plugins/:id/run',({user,params,body})=>run(user,params.id,body),{capability:'plugins:manage'})
 route('POST','/installed-plugins/trials/:id/observe',({user,params,body})=>observe(user,params.id,body))
 ctx.effect(()=>ctx.web.contribute({id:'installed-tools',label:'Installed tools',icon:'grid',roles:['contractor','supplier','admin'],order:61}))
 ctx.effect(()=>{const timer=setInterval(()=>{for(const trial of trials().filter(row=>row.status==='active'&&row.expiresAt<now()))serialize(()=>finishTrial(trial,'system:installed-plugins','Trial time window ended; baseline restored')).catch(()=>{})},5000);return()=>clearInterval(timer)})
 ctx.effect(()=>async()=>{disposed=true;await pending;await Promise.allSettled([...mounted.values()].map(entry=>entry.fiber.dispose()));mounted.clear();registered.clear()})
}
