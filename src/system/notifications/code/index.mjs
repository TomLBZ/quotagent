import {randomUUID,createHash} from 'node:crypto'
export const name='product-notifications'
export const inject=['store','web','accounts','settings']
export const provides=['notifications']
const now=()=>new Date().toISOString(),copy=value=>structuredClone(value),weight={info:0,warning:1,error:2},hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail=message=>{throw Object.assign(new Error(message),{status:400})}
export function apply(ctx){
 const listeners=new Set(),queues=new Map();let disposed=false
 ctx.effect(()=>ctx.settings.define({id:'notifications',name:'Notifications',scope:'account',description:'Activity stays in your history. Alert preferences control the header count and connected reminders.',fields:[{key:'enabled',label:'Show in-app notification alerts',type:'boolean'},{key:'minSeverity',label:'Minimum alert severity',type:'select',options:['info','warning','error']},{key:'mutedSources',label:'Muted alert source IDs',type:'text',description:'Comma-separated source IDs, shown on each activity card. History remains available.'}],defaults:{enabled:true,minSeverity:'info',mutedSources:''}}))
 const account=user=>{if(!user?.id)fail('Sign in to read notifications.');return user.id}
 const level=value=>Object.hasOwn(weight,value)?value:'info'
 const source=input=>{const supplied=input.source||{},pluginId=String(supplied.pluginId||input.pluginId||input.link?.view||'unspecified').slice(0,100);return{pluginId,panelId:String(supplied.panelId||input.link?.view||'').slice(0,100),label:String(supplied.label||pluginId).slice(0,160),sourceId:String(supplied.sourceId||input.sourceId||'').slice(0,200),attribution:supplied.pluginId||input.pluginId?'explicit':input.link?.view?'origin-view':'unspecified'}}
 const normalize=row=>{const origin=source(row),reports=row.reports||[{id:hash({origin,id:row.id}),...origin,level:level(row.level),reportedAt:row.createdAt}];return{...row,level:level(row.level),sources:row.sources||[origin],reports,mergedCount:reports.length}}
 const list=user=>ctx.store.list(account(user),'notifications').map(normalize).sort((a,b)=>weight[b.level]-weight[a.level]||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id))
 const preferences=user=>ctx.settings.get(user,'notifications')
 const visible=(item,settings)=>{const muted=new Set(String(settings.mutedSources||'').split(',').map(value=>value.trim()).filter(Boolean));return weight[item.level]>=weight[settings.minSeverity||'info']&&!item.sources.every(source=>muted.has(source.pluginId))}
 const matches=(item,query={})=>(!query.unread||query.unread==='false'||!item.readAt)&&(!query.level||item.level===query.level)&&(!query.type||item.type===query.type)&&(!query.source||item.sources.some(source=>source.pluginId===query.source))&&(!query.q||[item.title,item.body,item.type,...item.sources.map(source=>source.label)].join(' ').toLowerCase().includes(String(query.q).toLowerCase()))
 const window=(user,query={})=>{const records=list(user),settings=preferences(user),filtered=records.filter(item=>matches(item,query)),limit=Math.min(100,Math.max(1,Math.floor(Number(query.limit)||25))),pages=Math.max(1,Math.ceil(filtered.length/limit)),page=Math.min(pages,Math.max(1,Math.floor(Number(query.page)||1))),offset=(page-1)*limit,unreadTotal=records.filter(item=>!item.readAt).length,unread=records.filter(item=>!item.readAt&&visible(item,settings)).length
  return{notifications:filtered.slice(offset,offset+limit),enabled:settings.enabled,unread,unreadTotal,total:records.length,produced:records.reduce((sum,row)=>sum+row.mergedCount,0),merged:records.reduce((sum,row)=>sum+Math.max(0,row.mergedCount-1),0),visible:records.filter(item=>visible(item,settings)).length,remaining:Math.max(0,filtered.length-offset-limit),suppressedUnread:unreadTotal-unread,matched:filtered.length,matchedUnread:filtered.filter(row=>!row.readAt).length,page,pages,limit,offset,shown:Math.min(limit,filtered.length-offset),start:filtered.length?offset+1:0,end:Math.min(filtered.length,offset+limit),sources:[...new Set(records.flatMap(row=>row.sources.map(source=>source.pluginId)))].sort(),types:[...new Set(records.map(row=>row.type))].sort(),preferences:settings}}
 const serial=(user,operation)=>{const id=account(user),result=(queues.get(id)||Promise.resolve()).then(()=>{if(disposed)fail('Notifications are reloading.');return operation()});const settled=result.catch(()=>{});queues.set(id,settled);result.finally(()=>{if(queues.get(id)===settled)queues.delete(id)}).catch(()=>{});return result}
 const push=async(user,input)=>{
  const result=await serial(user,async()=>{const realm=account(user),origin=source(input),report={...origin,level:level(input.level||input.severity),reportedAt:now()},reportId=input.reportId?hash({origin,sourceReportId:String(input.reportId)}):hash({origin,level:report.level,title:input.title,body:input.body,link:input.link});report.id=reportId;if(input.reportId)report.sourceReportId=String(input.reportId)
   const previous=input.dedupeKey?list(user).find(row=>row.dedupeKey===input.dedupeKey):null
   if(previous?.reports.some(item=>item.id===reportId))return{notice:previous,notify:false}
   const escalated=previous&&weight[report.level]>weight[previous.level],sources=previous?.sources||[];if(!sources.some(item=>hash(item)===hash(origin)))sources.push(origin)
   const notice=previous?{...previous,sources,reports:[...previous.reports,report],mergedCount:previous.mergedCount+1,updatedAt:now(),...(escalated?{level:report.level,readAt:null,title:String(input.title||previous.title).slice(0,180),body:String(input.body||previous.body).slice(0,4000),link:copy(input.link||previous.link)}:{})}:{id:randomUUID(),type:String(input.type||'activity'),level:report.level,title:String(input.title||'New activity').slice(0,180),body:String(input.body||'').slice(0,4000),link:copy(input.link||{}),sourceId:input.sourceId||null,dedupeKey:input.dedupeKey||null,createdAt:now(),readAt:null,sources,reports:[report],mergedCount:1}
   await ctx.store.put(realm,'notifications',notice,{event:previous?'notifications/merged':'notifications/created',actor:'system:notifications'});return{notice,notify:!previous||escalated}
  })
  if(result.notify&&!disposed)for(const listener of listeners)try{await listener(user,copy(result.notice))}catch(error){await ctx.store.append(user.id,'notifications/delivery-failed',{id:result.notice.id,error:String(error.message).slice(0,300)},{actor:'system:notifications'})}
  return result.notice
 }
 const read=(user,id)=>serial(user,async()=>{const notice=ctx.store.get(account(user),'notifications',id);if(!notice)fail('Notification not found.');if(notice.readAt)return normalize(notice);return normalize(await ctx.store.put(user.id,'notifications',{...notice,readAt:now()},{event:'notifications/read',actor:user.id}))})
 const readMatched=async(user,query={})=>{const rows=list(user).filter(item=>!item.readAt&&matches(item,query));for(const item of rows)await read(user,item.id);return{ok:true,marked:rows.length}}
 const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)}
 ctx.provide('notifications',{list,window,push,read,readMatched,subscribe,preferences,visible})
 ctx.effect(()=>()=>{disposed=true;listeners.clear();return Promise.allSettled([...queues.values()])})
 ctx.effect(()=>ctx.web.contribute({id:'notifications',label:'Notifications',icon:'bell',roles:['contractor','supplier','admin'],order:65}))
 ctx.effect(()=>ctx.web.route('GET','/notifications',({user,query})=>window(user,Object.fromEntries(query||[]))))
 ctx.effect(()=>ctx.web.route('POST','/notifications/read-all',({user,body})=>readMatched(user,body.filters||{})))
 ctx.effect(()=>ctx.web.route('POST','/notifications/:id/read',async({user,params})=>({ok:true,notification:await read(user,params.id)})))
}
