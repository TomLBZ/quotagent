import {randomUUID} from 'node:crypto'
export const name='action-center'
export const inject=['store','web','accounts']
export const provides=['actions']
const now=()=>new Date().toISOString()
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const copy=value=>structuredClone(value)
export async function apply(ctx){
 const executors=new Map(),inflight=new Map(),controllers=new Set()
 let notifications=null,disposed=false
 ctx.inject(['notifications'],child=>{notifications=child.notifications;child.effect(()=>()=>{notifications=null})})
 const notify=async(user,input)=>{try{await notifications?.push(user,input)}catch(error){await ctx.store.append(user.id,'actions/notification-failed',{actionId:input.sourceId,error:String(error.message).slice(0,500)},{actor:'system:actions'}).catch(()=>{})}}
 const owner=user=>{if(!user?.id)fail('Sign in to review actions.',401);return user.id}
 const list=user=>ctx.store.list(owner(user),'review-actions').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
 const get=(user,id)=>{const item=ctx.store.get(owner(user),'review-actions',id);if(!item)fail('This action is not available in your account.',404);return item}
 const save=(user,item,event)=>ctx.store.put(owner(user),'review-actions',{...item,updatedAt:now()},{actor:user.id,event})
 const register=definition=>{
  if(!definition.kind||typeof definition.execute!=='function')throw new Error('Action handlers require kind and execute.')
  if(executors.has(definition.kind))throw new Error('Action handler already registered: '+definition.kind)
  executors.set(definition.kind,definition);return()=>executors.delete(definition.kind)
 }
 let proposalQueue=Promise.resolve()
 const proposeOne=async(user,input)=>{
  owner(user);if(disposed)fail('Action center is restarting.',503)
  if(!executors.has(input.kind))fail('The plugin for this action is not available.',409)
  if(input.idempotencyKey){const old=list(user).find(row=>row.idempotencyKey===input.idempotencyKey);if(old)return old}
  if(!input.input||typeof input.input!=='object'||Array.isArray(input.input))fail('An action needs structured input.')
  const action={id:randomUUID(),kind:input.kind,title:String(input.title||executors.get(input.kind).label||input.kind).slice(0,180),summary:String(input.summary||'').slice(0,4000),input:copy(input.input),source:copy(input.source||null),runId:input.runId||null,idempotencyKey:input.idempotencyKey||null,status:'pending',createdAt:now(),proposedBy:input.source&&!['human','human-retry'].includes(input.source.kind)?'agent':'user',decision:null,result:null,error:null}
  const saved=await save(user,action,'actions/proposed')
  await notify(user,{type:'review',title:'Ready for your review',body:action.title,sourceId:action.id,dedupeKey:'review:'+action.id,link:{view:'approvals',actionId:action.id}})
  return saved
 }
 const propose=(user,input)=>{const operation=proposalQueue.then(()=>proposeOne(user,input));proposalQueue=operation.catch(()=>{});return operation}
 const approve=async(user,id,input={})=>{
  owner(user);if(!ctx.accounts.can(user,'workspace:write'))fail('This account cannot approve external actions.',403)
  if(input.confirmed!==true)fail('Confirm this exact action before continuing.')
  const key=user.id+':'+id;if(inflight.has(key))return inflight.get(key)
  const action=get(user,id)
  if(action.status==='succeeded')return action
  if(action.status!=='pending')fail('Only pending actions can be approved. Review the current result first.',409)
  const executor=executors.get(action.kind);if(!executor)fail('Enable the plugin that owns this action before approving.',409)
  const controller=new AbortController();controllers.add(controller)
  const operation=(async()=>{
   const executing=await save(user,{...action,status:'executing',decision:{choice:'approved',actorId:user.id,at:now()},startedAt:now()},'actions/approved')
   try{
    const result=await executor.execute(user,copy(action.input),copy(executing),{signal:controller.signal})
    const saved=await save(user,{...executing,status:'succeeded',finishedAt:now(),result:copy(result??{ok:true})},'actions/succeeded')
    await notify(user,{type:'action',title:'Action completed',body:action.title,sourceId:id,dedupeKey:'action-completed:'+id,link:{view:'approvals',actionId:id}})
    return saved
   }catch(error){
    const uncertain=controller.signal.aborted||error.uncertain||error.deliveryUnknown
    return save(user,{...executing,status:uncertain?'uncertain':'failed',finishedAt:now(),error:String(error.message||error).slice(0,2000)},uncertain?'actions/delivery-uncertain':'actions/failed')
   }finally{controllers.delete(controller);inflight.delete(key)}
  })();inflight.set(key,operation);return operation
 }
 const reject=async(user,id,{reason=''}={})=>{
  const key=user.id+':'+id;if(inflight.has(key))fail('A decision for this action is already being processed.',409)
  const action=get(user,id);if(action.status!=='pending')fail('Only a pending action can be declined.',409)
  const operation=save(user,{...action,status:'rejected',decision:{choice:'rejected',actorId:user.id,at:now(),reason:String(reason).slice(0,2000)}},'actions/rejected').finally(()=>inflight.delete(key))
  inflight.set(key,operation);return operation
 }
 const retry=async(user,id)=>{const action=get(user,id);if(!['failed','uncertain','rejected'].includes(action.status))fail('Only a declined, failed or uncertain action can be proposed again.');return propose(user,{...action,idempotencyKey:null,source:{kind:'human-retry',previousActionId:id},summary:action.summary+(action.status==='uncertain'?' Previous delivery was uncertain; check the destination before approving again.':'')})}
 ctx.provide('actions',{register,propose,list,get,approve,reject,retry})
 for(const user of ctx.accounts.list())for(const action of list(user))if(action.status==='executing')await save(user,{...action,status:'uncertain',error:'Execution was interrupted. Check the destination before retrying.',finishedAt:now()},'actions/delivery-uncertain')
 ctx.effect(()=>async()=>{disposed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...inflight.values()]);executors.clear()})
 ctx.effect(()=>ctx.web.contribute({id:'approvals',label:'Review actions',icon:'check',roles:['contractor','supplier','admin'],order:60}))
 ctx.effect(()=>ctx.web.route('GET','/actions',({user})=>({actions:list(user)})))
 ctx.effect(()=>ctx.web.route('GET','/actions/:id',({user,params})=>({action:get(user,params.id)})))
 ctx.effect(()=>ctx.web.route('POST','/actions/:id/approve',async({user,params,body})=>({ok:true,action:await approve(user,params.id,body)}),{capability:'workspace:write'}))
 ctx.effect(()=>ctx.web.route('POST','/actions/:id/reject',async({user,params,body})=>({ok:true,action:await reject(user,params.id,body)}),{capability:'workspace:write'}))
 ctx.effect(()=>ctx.web.route('POST','/actions/:id/retry',async({user,params})=>({ok:true,action:await retry(user,params.id)}),{capability:'workspace:write'}))
}
