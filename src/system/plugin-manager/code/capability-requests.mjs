import {randomUUID} from 'node:crypto'
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const clean=(value,max=2000)=>String(value??'').trim().slice(0,max)
const permissions=[{id:'assistant:use',label:'Use the AI assistant',flag:'assistant:disabled'},{id:'workspace:write',label:'Edit business records',flag:'workspace:read-only'},{id:'plugins:manage',label:'Create personal extensions',flag:'plugins:disabled'}]
export const name='capability-requests'
export const inject=['store','accounts','web']
export const provides=['capabilityRequests']
export async function apply(ctx){
 let disposed=false,queue=Promise.resolve()
 const now=()=>new Date().toISOString(),serial=work=>{if(disposed)return Promise.reject(new Error('Capability requests is reloading.'));const task=queue.catch(()=>{}).then(work);queue=task.catch(()=>{});return task}
 const current=user=>{const person=ctx.accounts.get(user?.id);if(!person||person.disabled)fail('Sign in to manage capability requests.',401);return person}
 const admin=user=>{const person=current(user);if(person.role!=='admin')fail('Only the separate administrator can decide this request.',403);return person}
 const save=(person,record,event)=>ctx.store.put('system','capability-requests',{...record,updatedAt:now()},{actor:person.id,event:'capabilities/'+event})
 const notify=async(id,input)=>{const person=ctx.accounts.get(id);if(!person||person.disabled)return;try{await ctx.get('notifications')?.push(person,{...input,link:{view:person.role==='admin'?'plugins':'settings',requestId:input.sourceId}})}catch(error){await ctx.store.append('system','capabilities/notification-failed',{requestId:input.sourceId,error:clean(error.message,500)},{actor:'system:capability-requests'})}}
 const list=user=>{const person=current(user);return ctx.store.list('system','capability-requests').filter(row=>person.role==='admin'||row.requesterId===person.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(row=>({...row,requesterName:ctx.accounts.get(row.requesterId)?.name||row.requesterName}))}
 const get=(user,id)=>{const row=list(user).find(row=>row.id===id);if(!row)fail('This request is not available in your account.',404);return row}
 const options=user=>{
  const person=current(user)
  return {permissions:permissions.map(({id,label})=>({id,label,available:ctx.accounts.can(person,id)})),plugins:(ctx.get('plugins')?.list(person)||[]).filter(row=>!row.parentId&&row.lifecycleAllowed).map(row=>({id:row.id,label:row.name,active:row.enabled})),configuration:(ctx.get('settings')?.list(person)||[]).map(schema=>({id:schema.id,label:schema.title||schema.name||schema.id}))}
 }
 const request=(user,input)=>serial(async()=>{
  const person=current(user),reason=clean(input.reason);if(!reason)fail('Explain what you need to do and what is blocked.')
  if(!['permission','plugin','configuration'].includes(input.kind))fail('Choose access, an application plugin or configuration guidance.')
  const choices=options(person),choice=choices[{permission:'permissions',plugin:'plugins',configuration:'configuration'}[input.kind]].find(row=>row.id===input.target)
  if(!choice)fail('Choose a currently registered capability or settings page.')
  const duplicate=list(person).find(row=>row.kind===input.kind&&row.target===input.target&&['pending','blocked','awaiting-requester'].includes(row.status));if(duplicate)return duplicate
  if(input.previousId)get(person,input.previousId)
  const record={id:randomUUID(),requesterId:person.id,requesterName:person.name,kind:input.kind,target:choice.id,label:choice.label,reason,status:'pending',createdAt:now(),expiresAt:new Date(Date.now()+14*86400000).toISOString(),previousId:input.previousId||null,decisions:[]}
  await save(person,record,'requested')
  for(const account of ctx.accounts.list().filter(row=>row.role==='admin'))await notify(account.id,{type:'capability-request',title:'Capability request: '+record.label,body:person.name+' requested administrative help.',sourceId:record.id,dedupeKey:'capability-request:'+record.id+':'+account.id})
  return record
 })
 const decide=(user,id,input)=>serial(async()=>{
  const person=admin(user),record=get(person,id),requester=ctx.accounts.get(record.requesterId)
  if(!['pending','blocked','awaiting-requester'].includes(record.status))fail('This request already has a final outcome. Ask for a new request.')
  if(Date.parse(record.expiresAt)<=Date.now())fail('This request expired without any access change.')
  const reason=clean(input.reason);if(!reason)fail('Record the reason for this decision.')
  const choice=input.choice;if(!['grant','reject','guide'].includes(choice))fail('Choose grant, reject or provide guidance.')
  const decision={actorId:person.id,choice,reason,at:now()};let status,error=null,verification=null
  if(choice==='reject')status='rejected'
  else if(choice==='guide'){status='awaiting-requester';verification={kind:'guidance',reportedBy:person.id}}
  else{
   if(input.confirmed!==true)fail('Confirm the exact account or application change.')
   if(!requester||requester.disabled)fail('The requester account is no longer active.')
   try{
    if(record.kind==='permission'){
     const permission=permissions.find(row=>row.id===record.target)
     if(!permission)fail('This permission is no longer registered.')
     await ctx.accounts.update(requester.id,{permissions:requester.permissions.filter(flag=>flag!==permission.flag)},{admin:true})
     if(!ctx.accounts.can(ctx.accounts.get(requester.id),permission.id))fail('The account still lacks this permission.')
     verification={kind:'permission',target:permission.id,available:true};status='resolved'
    }else if(record.kind==='plugin'){
     await ctx.get('plugins').setEnabled(record.target,true)
     const plugin=ctx.get('plugins').list(person).find(row=>row.id===record.target)
     if(!plugin?.enabled)fail('The requested plugin is still inactive.')
     verification={kind:'plugin',target:record.target,active:true};status='resolved'
    }else fail('Provide configuration guidance. The requester confirms when it works.')
   }catch(cause){status='blocked';error=clean(cause.message)}
  }
  const saved=await save(person,{...record,status,error,verification,decisions:[...record.decisions,decision],...(status==='resolved'?{resolvedAt:now()}: {})},status==='awaiting-requester'?'guidance-provided':status==='resolved'?'resolved':status==='blocked'?'blocked':'decided')
  await notify(requester?.id,{type:'capability-request',title:'Capability request '+status.replaceAll('-',' '),body:reason,sourceId:id,dedupeKey:'capability-decision:'+id+':'+saved.updatedAt});return saved
 })
 const confirm=(user,id,input)=>serial(async()=>{
  const person=current(user),record=get(person,id)
  if(record.requesterId!==person.id||record.status!=='awaiting-requester')fail('Only the requester can confirm this guidance resolved the issue.')
  if(Date.parse(record.expiresAt)<=Date.now())fail('This request expired. Prepare a new request if help is still needed.')
  if(input.confirmed!==true)fail('Confirm that the requested capability is working.')
  return save(person,{...record,status:'resolved',resolvedAt:now(),verification:{kind:'requester-report',reportedBy:person.id,at:now(),reason:clean(input.reason)}},'resolved')
 })
 const expire=()=>serial(async()=>{for(const record of ctx.store.list('system','capability-requests'))if(['pending','blocked','awaiting-requester'].includes(record.status)&&Date.parse(record.expiresAt)<=Date.now())await save({id:'system:capability-requests'},{...record,status:'expired',expiredAt:now()},'expired')})
 ctx.provide('capabilityRequests',{list,options,request,decide,confirm,expire})
 const route=(method,path,handler,opts={})=>ctx.effect(()=>ctx.web.route(method,path,handler,opts))
 route('GET','/capability-requests',({user})=>({requests:list(user),options:options(user)}))
 route('POST','/capability-requests',async({user,body})=>({ok:true,request:await request(user,body)}))
 route('POST','/capability-requests/:id/decide',async({user,params,body})=>({ok:true,request:await decide(user,params.id,body)}),{admin:true})
 route('POST','/capability-requests/:id/confirm',async({user,params,body})=>({ok:true,request:await confirm(user,params.id,body)}))
 ctx.inject(['assistant'],child=>child.effect(()=>child.assistant.tool({name:'capability_request_status',description:'Read your own administrative capability requests and available access/configuration choices. This tool never changes permissions or sends requests.',effect:'read',roles:['contractor','supplier','admin'],parameters:{type:'object',properties:{}},execute:user=>({requests:list(user),options:options(user)})})))
 ctx.effect(()=>{const timer=setInterval(()=>expire().catch(()=>{}),60000);timer.unref();return()=>clearInterval(timer)})
 ctx.effect(()=>async()=>{disposed=true;await queue})
 await expire()
}
