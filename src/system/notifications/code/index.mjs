import {randomUUID} from 'node:crypto'
export const name='product-notifications'
export const inject=['store','web','accounts','settings']
export const provides=['notifications']
const now=()=>new Date().toISOString()
export function apply(ctx){
 const listeners=new Set()
 ctx.effect(()=>ctx.settings.define({id:'notifications',name:'Notifications',scope:'account',description:'Choose how new activity appears in your workspace.',fields:[{key:'enabled',label:'Show in-app notifications',type:'boolean'}],defaults:{enabled:true}}))
 const account=user=>{if(!user?.id)throw new Error('Sign in to read notifications.');return user.id}
 const list=user=>ctx.store.list(account(user),'notifications').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
 const push=async(user,input)=>{
  const realm=account(user)
  if(input.dedupeKey){const previous=list(user).find(row=>row.dedupeKey===input.dedupeKey);if(previous)return previous}
  const notice={id:randomUUID(),type:String(input.type||'activity'),title:String(input.title||'New activity').slice(0,180),body:String(input.body||'').slice(0,4000),link:structuredClone(input.link||{}),sourceId:input.sourceId||null,dedupeKey:input.dedupeKey||null,createdAt:now(),readAt:null}
  await ctx.store.put(realm,'notifications',notice,{event:'notifications/created',actor:'system:notifications'})
  for(const listener of listeners)try{await listener(user,structuredClone(notice))}catch(error){await ctx.store.append(realm,'notifications/delivery-failed',{id:notice.id,error:String(error.message).slice(0,300)},{actor:'system:notifications'})}
  return notice
 }
 const read=async(user,id)=>{
  const notice=ctx.store.get(account(user),'notifications',id);if(!notice)throw new Error('Notification not found.')
  if(notice.readAt)return notice
  return ctx.store.put(user.id,'notifications',{...notice,readAt:now()},{event:'notifications/read',actor:user.id})
 }
 const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)}
 ctx.provide('notifications',{list,push,read,subscribe})
 ctx.effect(()=>()=>listeners.clear())
 ctx.effect(()=>ctx.web.contribute({id:'notifications',label:'Notifications',icon:'bell',roles:['contractor','supplier','admin'],order:65}))
 ctx.effect(()=>ctx.web.route('GET','/notifications',({user})=>{const records=list(user);return{notifications:records,unread:records.filter(row=>!row.readAt).length,enabled:ctx.settings.get(user,'notifications').enabled}}))
 ctx.effect(()=>ctx.web.route('POST','/notifications/:id/read',async({user,params})=>({ok:true,notification:await read(user,params.id)})))
 ctx.effect(()=>ctx.web.route('POST','/notifications/read-all',async({user})=>{for(const item of list(user))if(!item.readAt)await read(user,item.id);return{ok:true}}))
}
