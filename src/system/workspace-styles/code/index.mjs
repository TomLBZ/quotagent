import {defaults,layouts,palettes} from './presets.mjs'
export const name='product-workspace-styles'
export const inject=['web','settings']
export const provides=['workspaceStyles']
export function apply(ctx){
 ctx.effect(()=>ctx.settings.define({id:'workspace-styles',name:'Workspace style',scope:'account',description:'Choose the layout, colors and spacing for your own workspace.',defaults,fields:[
  {key:'layout',label:'Workspace layout',type:'select',options:layouts.map(item=>({value:item.id,label:item.name}))},
  {key:'palette',label:'Color palette',type:'select',options:palettes.map(item=>({value:item.id,label:item.name}))},
  {key:'density',label:'Spacing',type:'select',options:[{value:'comfortable',label:'Comfortable'},{value:'compact',label:'Compact'}]},
 ]}))
 const get=user=>({preferences:ctx.settings.get(user,'workspace-styles'),presets:{layouts,palettes}})
 ctx.provide('workspaceStyles',{get})
 ctx.effect(()=>ctx.web.contribute({id:'workspace-style',label:'Workspace style',icon:'sun',roles:['contractor','supplier','admin'],order:73}))
 ctx.effect(()=>ctx.web.route('GET','/workspace-style',({user})=>get(user)))
}
