import {createSettings} from './service.mjs'
export const name='product-settings'
export const inject=['store','web','accounts']
export const provides=['settings']
export async function apply(ctx,config={}){
 const settings=await createSettings(ctx,config);ctx.provide('settings',settings);ctx.effect(()=>()=>settings.dispose())
 const route=(method,path,handler)=>ctx.effect(()=>ctx.web.route(method,path,handler))
 const context=query=>{const value=query?.get('context');if(!value)return{};try{return JSON.parse(value)}catch{throw Object.assign(new Error('Invalid configuration scope context.'),{status:400})}}
 ctx.effect(()=>ctx.web.contribute({id:'plugin-settings',label:'Plugin settings',icon:'settings',roles:['contractor','supplier','admin'],order:70}))
 route('GET','/settings',({user})=>({settings:settings.list(user)}))
 route('GET','/settings/export',({user,query})=>settings.exportYaml(user,{template:query.get('template')==='true',id:query.get('id')||undefined,scope:query.get('scope')||undefined,context:context(query)}))
 route('GET','/settings/history',({user})=>({history:settings.history(user),initialization:settings.initializationStatus(user)}))
 route('POST','/settings/preview',({user,body})=>settings.preview(user,body))
 route('POST','/settings/apply',({user,body})=>settings.apply(user,body))
 route('POST','/settings/import/preview',({user,body})=>settings.importPreview(user,body))
 route('POST','/settings/import/apply',({user,body})=>settings.importApply(user,body))
 route('GET','/settings/:id',({user,params,query})=>settings.view(user,params.id,context(query),query.get('scope')||undefined))
 route('PATCH','/settings/:id',({user,params,body})=>settings.save(user,params.id,body))
}
