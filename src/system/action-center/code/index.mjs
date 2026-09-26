import {createActions} from './service.mjs'
export const name='action-center'
export const inject=['store','web','accounts']
export const provides=['actions']
export async function apply(ctx){
 const actions=createActions({store:ctx.store,accounts:ctx.accounts,teams:()=>ctx.get('teams'),notifications:()=>ctx.get('notifications')})
 ctx.provide('actions',actions);await actions.recover()
 ctx.effect(()=>()=>actions.dispose())
 ctx.effect(()=>{const timer=setInterval(()=>actions.age().catch(()=>{}),60000);timer.unref();return()=>clearInterval(timer)})
 ctx.effect(()=>ctx.web.contribute({id:'approvals',label:'Review actions',icon:'check',roles:['contractor','supplier','admin'],order:60}))
 const route=(method,path,handler,options={})=>ctx.effect(()=>ctx.web.route(method,path,handler,options))
 route('GET','/actions',({user})=>({actions:actions.list(user),batches:actions.batches(user)}))
 route('POST','/actions/batch',async({user,body})=>({ok:true,receipt:await actions.startBatch(user,body)}),{capability:'workspace:write'})
 route('POST','/actions/batch/:id/control',async({user,params,body})=>({ok:true,receipt:await actions.controlBatch(user,params.id,body)}),{capability:'workspace:write'})
 route('GET','/actions/:id',({user,params})=>({action:actions.get(user,params.id)}))
 for(const operation of ['approve','reject','retry','nominate','grant','remind'])route('POST',`/actions/:id/${operation}`,async({user,params,body})=>({ok:true,action:await actions[operation](user,params.id,body)}),{capability:'workspace:write'})
}
