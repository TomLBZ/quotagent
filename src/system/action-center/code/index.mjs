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
 if(ctx.web.collection)ctx.effect(()=>ctx.web.collection({id:'review-actions',label:'Review actions',roles:['contractor','supplier','admin'],columns:[{key:'title',label:'Action',type:'text'},{key:'status',label:'Status',type:'enum'},{key:'kindLabel',label:'Kind',type:'enum'},{key:'attention',label:'Attention',type:'enum'},{key:'decision',label:'Decision owner',type:'enum'},{key:'createdAt',label:'Created',type:'date'},{key:'ageMinutes',label:'Age minutes',type:'number'}],defaults:{size:25,filters:{attention:{equals:'open'}}},load:user=>actions.list(user).map(row=>({...row,attention:['pending','awaiting-review','granted','executing'].includes(row.status)?'open':'closed',decision:row.canSign||row.canGrant||row.canNominate?'mine':'other'}))}))
 route('GET','/actions/batches',({user})=>({batches:actions.batches(user)}))
 route('GET','/actions/selection',({user,query})=>{const ids=[...new Set((query.get('ids')||'').split(',').filter(Boolean))];if(ids.length>50)throw new Error('Review at most 50 selected actions in one batch.');return {actions:ids.map(id=>actions.get(user,id))}})
 route('GET','/actions',({user})=>({actions:actions.list(user),batches:actions.batches(user)}))
 route('POST','/actions/batch',async({user,body})=>({ok:true,receipt:await actions.startBatch(user,body)}),{capability:'workspace:write'})
 route('POST','/actions/batch/:id/control',async({user,params,body})=>({ok:true,receipt:await actions.controlBatch(user,params.id,body)}),{capability:'workspace:write'})
 route('GET','/actions/:id',({user,params})=>({action:actions.get(user,params.id)}))
 for(const operation of ['approve','reject','retry','nominate','grant','remind'])route('POST',`/actions/:id/${operation}`,async({user,params,body})=>({ok:true,action:await actions[operation](user,params.id,body)}),{capability:'workspace:write'})
}
