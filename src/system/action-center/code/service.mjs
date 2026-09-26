import {randomUUID,createHash} from 'node:crypto'
const copy=value=>structuredClone(value)
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const clean=(value,max=2000)=>String(value??'').trim().slice(0,max)
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value
const hash=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
const waiting=new Set(['pending','awaiting-review','granted'])

export function createActions({store,accounts,teams=()=>null,notifications=()=>null,clock=()=>Date.now()}){
 const executors=new Map(),locks=new Map(),controllers=new Set(),leases=new Map(),batchJobs=new Map(),batchQueues=new Map()
 let disposed=false
 const now=()=>new Date(clock()).toISOString()
 const person=user=>{if(!user?.id)fail('Sign in to review actions.',401);return accounts.get?.(user.actorId||user.id)||user}
 const serial=(key,work)=>{
  if(disposed)return Promise.reject(new Error('Action center is restarting.'))
  const task=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(work);locks.set(key,task)
  task.finally(()=>{if(locks.get(key)===task)locks.delete(key)}).catch(()=>{});return task
 }
 const notify=async(accountId,input)=>{
  const user=accounts.get?.(accountId)||accounts.list().find(row=>row.id===accountId);if(!user||user.disabled)return
  try{await notifications()?.push(user,input)}catch(error){await store.append(accountId,'actions/notification-failed',{actionId:input.sourceId,error:clean(error.message,500)},{actor:'system:actions'}).catch(()=>{})}
 }
 const save=(actor,item,event)=>store.put(item.realmId||item.ownerId,'review-actions',{...item,updatedAt:now()},{actor:actor.id,event:'actions/'+event})
 const scoped=(user,action)=>action.workspaceId?{...person(user),workspaceOwnerId:action.workspaceId}:person(user)
 const authorizeRead=(user,action)=>{
  const actor=person(user)
  if(action.side&&action.side!==actor.role)fail('This action belongs to a different account perspective.',404)
  if(action.workspaceId){const scope=teams()?.scope(actor,action.workspaceId);if(!scope||scope.team.side!==action.side)fail('This action is not available in your account.',404)}
  else if(action.ownerId&&action.ownerId!==actor.id)fail('This action is not available in your account.',404)
  return actor
 }
 const realmIds=user=>{
  const actor=person(user),ids=new Set([actor.id]);if(actor.role!=='admin'&&teams())for(const team of teams().list(actor))ids.add(team.id)
  return [...ids]
 }
 const raw=(user,id)=>{
  for(const realmId of realmIds(user)){const row=store.get(realmId,'review-actions',id);if(row){const action={ownerId:realmId,realmId,...row};authorizeRead(user,action);return action}}
  fail('This action is not available in your account.',404)
 }
 const metadata=(user,action)=>{
  const actor=authorizeRead(user,action),independent=action.review?.independent===true
  let authority=null,reviewers=[]
  if(independent){authority=teams().authority(scoped(actor,action),action.review.amount,action.review.currency,action.workspaceId);reviewers=authority.people.filter(row=>row.accountId!==action.proposerId)}
  const writable=accounts.can(actor,'workspace:write')&&(!action.workspaceId||teams().scope(actor,action.workspaceId).role.canWrite)
  return {...action,ageMinutes:Math.max(0,Math.floor((clock()-Date.parse(action.createdAt))/60000)),proposerName:accounts.get?.(action.proposerId)?.name||action.proposerId||actor.name,reviewerName:accounts.get?.(action.reviewerId)?.name||action.reviewerId||null,
   authority,reviewers,canNominate:writable&&independent&&action.proposerId===actor.id&&['pending','awaiting-review'].includes(action.status),canGrant:writable&&independent&&action.reviewerId===actor.id&&action.proposerId!==actor.id&&action.status==='awaiting-review',canSign:writable&&(independent?action.proposerId===actor.id&&action.status==='granted':action.status==='pending'),canReject:writable&&waiting.has(action.status)&&(!independent||[action.proposerId,action.reviewerId].includes(actor.id)),canRemind:writable&&['awaiting-review','granted'].includes(action.status)&&[action.proposerId,action.reviewerId].includes(actor.id)}
 }
 const list=user=>realmIds(user).flatMap(realmId=>store.list(realmId,'review-actions').map(row=>({ownerId:realmId,realmId,...row}))).filter(row=>{try{authorizeRead(user,row);return true}catch{return false}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(row=>metadata(user,row))
 const get=(user,id)=>metadata(user,raw(user,id))
 const register=definition=>{
  if(!definition.kind||typeof definition.execute!=='function')throw new Error('Action handlers require kind and execute.')
  if(executors.has(definition.kind))throw new Error('Action handler already registered: '+definition.kind)
  executors.set(definition.kind,definition);return()=>executors.delete(definition.kind)
 }
 const describe=async(user,definition,input)=>{
  const value=await definition.review?.(user,copy(input));if(!value?.independent)return null
  if(!teams())fail('Enable team authority before preparing this commitment.',409)
  if(!Number.isSafeInteger(value.amount)||value.amount<0)fail('An independent review needs an exact nonnegative amount in cents.')
  const state=teams().scope(user,value.workspaceId)
  if(!state.role.canWrite||!accounts.can(state.person,'workspace:write'))fail('Your team role cannot propose this commitment.',403)
  if(!value.action||!value.object?.id||!value.fingerprint)fail('The owning plugin must bind this review to an action, record and revision.')
  return {...copy(value),workspaceId:state.team.id,side:state.team.side,policyRevision:state.team.policyRevision,policyCurrency:state.team.policy.currency,timeoutMinutes:state.team.policy.timeoutMinutes,timeoutPolicy:state.team.policy.timeoutPolicy}
 }
 const propose=(user,input)=>serial('proposals',async()=>{
  const actor=person(user),definition=executors.get(input.kind);if(!definition)fail('The plugin for this action is not available.',409)
  if(!input.input||typeof input.input!=='object'||Array.isArray(input.input))fail('An action needs structured input.')
  const review=await describe(user,definition,input.input),realmId=review?.workspaceId||actor.id
  if(input.idempotencyKey){const old=store.list(realmId,'review-actions').find(row=>row.idempotencyKey===input.idempotencyKey&&row.proposerId===actor.id);if(old)return metadata(user,{realmId,ownerId:realmId,...old})}
  const action={id:randomUUID(),realmId,ownerId:realmId,workspaceId:review?.workspaceId||null,side:review?.side||actor.role,kind:input.kind,kindLabel:definition.label||'Review action',title:clean(input.title||definition.label||input.kind,180),summary:clean(input.summary,4000),input:copy(input.input),inputHash:hash(input.input),source:copy(input.source||null),runId:input.runId||null,idempotencyKey:input.idempotencyKey||null,status:'pending',createdAt:now(),proposerId:actor.id,proposedBy:input.source&&!['human','human-retry'].includes(input.source.kind)?'agent':'user',review,reviewerId:null,decision:null,grant:null,result:null,error:null}
  const saved=await save(actor,action,'proposed');await notify(actor.id,{type:'review',title:review?'Choose an independent reviewer':'Ready for your review',body:action.title,sourceId:action.id,dedupeKey:'review:'+action.id,link:{view:'approvals',actionId:action.id}});return metadata(user,saved)
 })
 const checkWrite=(user,action)=>{
  const actor=authorizeRead(user,action);if(!accounts.can(actor,'workspace:write')||action.workspaceId&&!teams().scope(actor,action.workspaceId).role.canWrite)fail('This account cannot decide external actions.',403);return actor
 }
 const currentPolicy=(user,action)=>{
  if(action.review.timeoutPolicy==='expire'&&action.dueAt&&Date.parse(action.dueAt)<=clock())fail('The review waiting period expired. Prepare a fresh review.',409)
  const state=teams().scope(user,action.workspaceId)
  if(state.team.policyRevision!==action.review.policyRevision)fail('Authority policy changed. Prepare a fresh review under the current policy.',409)
  return state
 }
 const nominate=(user,id,input={})=>serial('action:'+id,async()=>{
  const action=raw(user,id),actor=checkWrite(user,action)
  if(!action.review?.independent||!['pending','awaiting-review'].includes(action.status))fail('Only an unsigned independent review can be nominated.',409)
  if(![action.proposerId,action.reviewerId].includes(actor.id))fail('Only the proposer or current reviewer may nominate a colleague.',403)
  if(action.reviewerId&&!clean(input.reason))fail('Explain why this review is being delegated.')
  currentPolicy(actor,action)
  const target=accounts.get?.(input.reviewerId);if(!target||target.id===action.proposerId)fail('Choose a different active colleague as reviewer.')
  const authority=teams().authority(target,action.review.amount,action.review.currency,action.workspaceId)
  if(!authority.within||!accounts.can(target,'workspace:write'))fail('This colleague does not have sufficient authority for this amount and currency.')
  const saved=await save(actor,{...action,status:'awaiting-review',reviewerId:target.id,nominatedAt:now(),dueAt:new Date(clock()+action.review.timeoutMinutes*60000).toISOString(),lastReminderAt:null,delegations:[...(action.delegations||[]),{from:action.reviewerId,to:target.id,actorId:actor.id,reason:clean(input.reason),at:now()}]},action.reviewerId?'delegated':'nominated')
  await notify(target.id,{type:'review',title:'Independent decision requested',body:action.title,sourceId:id,dedupeKey:`review-nomination:${id}:${saved.updatedAt}`,link:{view:'approvals',actionId:id}});return metadata(user,saved)
 })
 const grant=(user,id,input={})=>serial('action:'+id,async()=>{
  const action=raw(user,id),actor=checkWrite(user,action)
  if(input.confirmed!==true)fail('Confirm this exact independent decision.')
  if(action.status!=='awaiting-review'||action.reviewerId!==actor.id||action.proposerId===actor.id)fail('Only the nominated different reviewer can grant this action.',403)
  currentPolicy(actor,action)
  const authority=teams().authority(actor,action.review.amount,action.review.currency,action.workspaceId);if(!authority.within)fail('Your current authority does not cover this amount and currency.')
  if(action.inputHash!==hash(action.input))fail('The reviewed action content changed. Prepare a fresh proposal.',409)
  const saved=await save(actor,{...action,status:'granted',grant:{id:randomUUID(),actorId:actor.id,at:now(),reason:clean(input.reason),policyRevision:action.review.policyRevision,inputHash:action.inputHash,fingerprint:action.review.fingerprint,amount:action.review.amount,currency:action.review.currency},dueAt:new Date(clock()+action.review.timeoutMinutes*60000).toISOString(),lastReminderAt:null},'independent-granted')
  await notify(action.proposerId,{type:'review',title:'Ready for your signature',body:action.title,sourceId:id,dedupeKey:'review-granted:'+id,link:{view:'approvals',actionId:id}});return metadata(user,saved)
 })
 const approve=(user,id,input={})=>serial('action:'+id,async()=>{
  const action=raw(user,id),actor=checkWrite(user,action)
  if(input.confirmed!==true)fail('Confirm this exact action before continuing.')
  if(action.status==='succeeded')return metadata(user,action)
  const independent=action.review?.independent
  if(independent){
   if(action.status!=='granted'||action.proposerId!==actor.id)fail('The proposer signs only after a different nominated reviewer grants the exact action.',409)
   currentPolicy(actor,action)
   const reviewer=accounts.get(action.grant?.actorId)
   if(!reviewer||reviewer.id!==action.reviewerId||reviewer.id===actor.id||!accounts.can(reviewer,'workspace:write'))fail('The independent reviewer is no longer available.')
   if(!teams().authority(reviewer,action.review.amount,action.review.currency,action.workspaceId).within)fail('The reviewer no longer has sufficient authority.')
   if(action.grant.inputHash!==hash(action.input)||action.grant.fingerprint!==action.review.fingerprint||action.grant.policyRevision!==action.review.policyRevision)fail('The grant no longer matches this action.',409)
  }else if(action.status!=='pending')fail('Only pending actions can be approved. Review the current result first.',409)
  const definition=executors.get(action.kind);if(!definition)fail('Enable the plugin that owns this action before approving.',409)
  const controller=new AbortController();controllers.add(controller)
  const executing=await save(actor,{...action,status:'executing',decision:{choice:independent?'signed':'approved',actorId:actor.id,at:now(),reason:clean(input.reason)},startedAt:now()},independent?'signed':'approved')
  leases.set(id,{actorId:actor.id,action:executing})
  try{
   const result=await definition.execute(scoped(actor,action),copy(action.input),copy(executing),{signal:controller.signal})
   const saved=await save(actor,{...executing,status:'succeeded',finishedAt:now(),result:copy(result??{ok:true})},'succeeded')
   await notify(actor.id,{type:'action',title:'Action completed',body:action.title,sourceId:id,dedupeKey:'action-completed:'+id,link:{view:'approvals',actionId:id}})
   return metadata(user,saved)
  }catch(error){
   const uncertain=controller.signal.aborted||error.uncertain||error.deliveryUnknown
   return metadata(user,await save(actor,{...executing,status:uncertain?'uncertain':'failed',finishedAt:now(),error:clean(error.message||error)},uncertain?'delivery-uncertain':'failed'))
  }finally{controllers.delete(controller);leases.delete(id)}
 })
 const authorizeCommitment=async(user,{action,id,input})=>{
  if(!['award','sign-order','approve-change'].includes(action))return
  const lease=leases.get(input?.reviewActionId),actor=person(user)
  if(!lease||lease.actorId!==actor.id)fail('Prepare this commitment in Review actions, nominate a colleague, then sign the granted action.',409)
  const reviewed=lease.action
  if(!reviewed.review?.independent||reviewed.status!=='executing'||reviewed.review.action!==action||reviewed.review.object.id!==id||reviewed.workspaceId!==(user.workspaceOwnerId||user.id))fail('This independent grant belongs to a different commitment.',409)
  currentPolicy(actor,reviewed)
  return {reviewActionId:reviewed.id,grantId:reviewed.grant.id,reviewerId:reviewed.grant.actorId,signerId:actor.id}
 }
 const reject=(user,id,{reason=''}={})=>serial('action:'+id,async()=>{
  const action=raw(user,id),actor=checkWrite(user,action)
  if(!waiting.has(action.status))fail('Only an unfinished review can be declined.',409)
  if(action.review?.independent&&![action.proposerId,action.reviewerId].includes(actor.id))fail('Only the proposer or nominated reviewer may end this review.',403)
  const saved=await save(actor,{...action,status:'rejected',decision:{choice:actor.id===action.proposerId?'terminated':'rejected',actorId:actor.id,at:now(),reason:clean(reason)}},'rejected')
  await notify(action.proposerId,{type:'review',title:'Review declined',body:clean(reason)||action.title,sourceId:id,dedupeKey:'review-rejected:'+id,link:{view:'approvals',actionId:id}});return metadata(user,saved)
 })
 const retry=async(user,id)=>{
  const action=raw(user,id),actor=checkWrite(user,action)
  if(action.proposerId&&action.proposerId!==actor.id)fail('Ask the proposer to prepare another attempt.',403)
  if(!['failed','uncertain','rejected','expired'].includes(action.status))fail('Only a declined, failed, expired or uncertain action can be proposed again.')
  return propose(scoped(actor,action),{...action,idempotencyKey:null,source:{kind:'human-retry',previousActionId:id},summary:action.summary+(action.status==='uncertain'?' Previous delivery was uncertain; check the destination before approving again.':'')})
 }
 const remind=async(user,id,{reason=''}={})=>serial('action:'+id,async()=>{
  const action=raw(user,id),actor=checkWrite(user,action)
  if(!['awaiting-review','granted'].includes(action.status)||![action.proposerId,action.reviewerId].includes(actor.id))fail('Only a participant can remind an unfinished review.')
  const saved=await save(actor,{...action,lastReminderAt:now(),reminders:[...(action.reminders||[]),{actorId:actor.id,reason:clean(reason),at:now()}]},'reminded')
  await notify(action.status==='granted'?action.proposerId:action.reviewerId,{type:'review',title:'Review reminder',body:clean(reason)||action.title,sourceId:id,dedupeKey:'review-reminder:'+id+':'+now(),link:{view:'approvals',actionId:id}});return metadata(user,saved)
 })
 const age=async()=>{
  const candidates=accounts.list().flatMap(user=>store.list(user.id,'review-actions')).filter(action=>['awaiting-review','granted'].includes(action.status)&&action.dueAt&&Date.parse(action.dueAt)<=clock())
  for(const candidate of candidates)await serial('action:'+candidate.id,async()=>{
   const action=store.get(candidate.realmId,'review-actions',candidate.id);if(!action||!['awaiting-review','granted'].includes(action.status)||Date.parse(action.dueAt)>clock())return
   const actor={id:'system:actions'},nextDue=new Date(clock()+action.review.timeoutMinutes*60000).toISOString()
   if(action.review.timeoutPolicy==='expire'){await save(actor,{...action,status:'expired',finishedAt:now(),decision:{choice:'expired',at:now(),actorId:actor.id,reason:'The review waiting period elapsed without a signature.'}},'expired');await notify(action.proposerId,{type:'review',title:'Review expired without approval',body:action.title,sourceId:action.id,dedupeKey:'review-expired:'+action.id,link:{view:'approvals',actionId:action.id}});return}
   let reviewerId=action.reviewerId,escalation=null
   if(action.review.timeoutPolicy==='escalate'&&action.status==='awaiting-review'){
    try{
     const reviewer=accounts.get(reviewerId),state=teams().scope(reviewer,action.workspaceId),limit=role=>role.limit==='unlimited'?Infinity:role.limit??-1
     const authority=teams().authority(reviewer,action.review.amount,action.review.currency,action.workspaceId)
     const target=authority.people.find(row=>row.accountId!==action.proposerId&&row.accountId!==reviewerId&&limit(state.team.policy.roles.find(role=>role.id===row.roleId))>limit(state.role))
     if(target){reviewerId=target.accountId;escalation={from:action.reviewerId,to:reviewerId,actorId:actor.id,at:now(),reason:'Waiting review escalated to a higher authority role.'}}
    }catch{}
   }
   const saved=await save(actor,{...action,reviewerId,dueAt:nextDue,lastReminderAt:now(),...(escalation?{delegations:[...(action.delegations||[]),escalation]}:{}),ageNotices:[...(action.ageNotices||[]),{at:now(),outcome:escalation?'escalated':'reminded',reason:action.review.timeoutPolicy==='escalate'&&!escalation?'No eligible higher reviewer; current participant reminded.':'Waiting period elapsed.'}]},escalation?'escalated':'age-reminded')
   await notify(action.status==='granted'?action.proposerId:reviewerId,{type:'review',title:escalation?'Review escalated to you':'A review is waiting',body:action.title,sourceId:action.id,dedupeKey:'review-aged:'+action.id+':'+saved.updatedAt,link:{view:'approvals',actionId:action.id}})
  }).catch(async error=>store.append(candidate.realmId,'actions/aging-failed',{actionId:candidate.id,error:clean(error.message)},{actor:'system:actions'}))
 }
 const batchGet=(user,id)=>{const record=store.get(person(user).id,'action-batches',id);if(!record)fail('This batch is not available in your account.',404);return record}
 const batchUpdate=(user,id,patch,event='batch-progress')=>{
  const key=person(user).id+':'+id,task=(batchQueues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const prior=batchGet(user,id),next={...prior,...(typeof patch==='function'?patch(prior):patch),updatedAt:now()}
   await store.put(person(user).id,'action-batches',next,{actor:person(user).id,event:'actions/'+event});return next
  });batchQueues.set(key,task);task.finally(()=>{if(batchQueues.get(key)===task)batchQueues.delete(key)}).catch(()=>{});return task
 }
 const launchBatch=(user,id)=>{
  const key=person(user).id+':'+id;if(batchJobs.has(key)||disposed)return
  const task=(async()=>{
   while(!disposed){
    const batch=batchGet(user,id);if(batch.status!=='running')break
    const next=batch.ids.find(actionId=>!batch.items.some(item=>item.id===actionId));if(!next){await batchUpdate(user,id,{status:'completed',currentId:null,finishedAt:now()},'batch-completed');break}
    await batchUpdate(user,id,{currentId:next})
    let item
    try{
     const method={approve,grant,reject,remind,nominate,retry}[batch.operation],action=await method(user,next,batch.input)
     item={id:next,status:action.status,ok:!['failed','uncertain'].includes(action.status),resultActionId:action.id,error:action.error||null}
    }catch(error){item={id:next,status:'blocked',ok:false,error:clean(error.message)}}
    await batchUpdate(user,id,current=>({items:[...current.items,item],currentId:null,...(disposed?{status:'paused'}:{})}))
   }
  })().catch(async error=>batchUpdate(user,id,{status:'paused',error:clean(error.message)})).finally(()=>batchJobs.delete(key));batchJobs.set(key,task)
 }
 const startBatch=async(user,{ids,operation,confirmed,reason,reviewerId})=>{
  if(!Array.isArray(ids)||!ids.length||ids.length>100)fail('Select between 1 and 100 review items.')
  if(!['approve','grant','reject','remind','nominate','retry'].includes(operation))fail('Choose an available batch decision.')
  if(['approve','grant'].includes(operation)&&confirmed!==true)fail('Confirm the selected exact actions before continuing.')
  const actor=person(user),receipt={id:randomUUID(),operation,ids:[...new Set(ids)],input:{confirmed,reason:clean(reason),reviewerId:reviewerId||null},createdAt:now(),actorId:actor.id,status:'running',items:[],currentId:null,authorization:{actorId:actor.id,at:now(),items:ids.map(id=>{try{const action=raw(user,id);return{id,inputHash:action.inputHash}}catch{return{id,unavailable:true}}})}}
  await store.put(actor.id,'action-batches',receipt,{actor:actor.id,event:'actions/batch-started'});launchBatch(user,receipt.id);return receipt
 }
 const batch=async(user,input)=>{const result=await startBatch(user,input);await batchJobs.get(person(user).id+':'+result.id);return batchGet(user,result.id)}
 const controlBatch=async(user,id,{action,confirmed,reason}={})=>{
  const prior=batchGet(user,id)
  if(['completed','cancelled'].includes(prior.status))fail('This batch finished. Select failed items for a new deliberate attempt.')
  if(action==='resume'){
   if(confirmed!==true)fail('Confirm resuming only the remaining unattempted items.')
   await batchJobs.get(person(user).id+':'+id)
   await batchUpdate(user,id,{status:'running',error:null,resumedAt:now()},'batch-resumed');launchBatch(user,id)
  }else if(['pause','cancel'].includes(action))await batchUpdate(user,id,{status:action==='pause'?'paused':'cancelled',control:{action,actorId:person(user).id,reason:clean(reason),at:now()}},'batch-'+action)
  else fail('Choose pause, resume or cancel.')
  return batchGet(user,id)
 }
 const recover=async()=>{
  for(const user of accounts.list()){
   for(const action of store.list(user.id,'review-actions'))if(action.status==='executing')await save({id:'system:actions'},{ownerId:user.id,realmId:user.id,...action,status:'uncertain',error:'Execution was interrupted. Check the destination before retrying.',finishedAt:now()},'delivery-uncertain')
   for(const batch of store.list(user.id,'action-batches'))if(batch.status==='running'||batch.currentId){
    let items=batch.items
    if(batch.currentId&&!items.some(item=>item.id===batch.currentId)){
     let action;try{action=raw(user,batch.currentId)}catch{}
     const ok=action?.status==='succeeded'||batch.operation==='grant'&&action?.status==='granted'
     items=[...items,{id:batch.currentId,status:ok?action.status:'uncertain',ok,resultActionId:batch.currentId,error:ok?null:'Interrupted batch item; inspect its action receipt before any new attempt.'}]
    }
    await batchUpdate(user,batch.id,{status:'paused',currentId:null,items,error:'The application restarted. Review receipts, then resume only the unattempted items.'},'batch-recovered')
   }
  }
 }
 const dispose=async()=>{disposed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...locks.values(),...batchJobs.values(),...batchQueues.values()]);for(const user of accounts.list())for(const batch of store.list(user.id,'action-batches'))if(batch.status==='running')await batchUpdate(user,batch.id,{status:'paused',error:'The action center was unloaded. Review and resume when ready.'},'batch-suspended');executors.clear();leases.clear()}
 return {register,propose,list,get,approve,reject,retry,nominate,grant,remind,authorizeCommitment,age,batch,startBatch,controlBatch,batchGet,batches:user=>store.list(person(user).id,'action-batches'),recover,dispose}
}
