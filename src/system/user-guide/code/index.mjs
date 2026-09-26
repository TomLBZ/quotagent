import {tours,forRole} from './content.mjs'
export const name='product-user-guide'
export const inject=['store','web','settings']
export const provides=['userGuide']
const fail=message=>{throw Object.assign(new Error(message),{status:400})}
export function apply(ctx){
 ctx.effect(()=>ctx.settings.define({id:'user-guide',name:'Getting started & Help',scope:'account',description:'Choose whether a new workspace shows a short getting-started invitation. You can replay the walkthrough from Help at any time.',defaults:{showWelcome:true},fields:[{key:'showWelcome',label:'Show first-use welcome',type:'boolean'}]}))
 const role=user=>{if(!user?.id||!tours[user.role])fail('Sign in to open your workspace guide.');return user.role}
 const get=user=>{const current=role(user);return{role:current,preferences:ctx.settings.get(user,'user-guide'),progress:ctx.store.get(user.id,'user-guide',current)||{id:current,status:'new',step:0},tour:structuredClone(tours[current]),topics:forRole(current)}}
 const progress=async(user,input={})=>{
  const current=role(user),before=get(user).progress,status=input.status??before.status,step=input.step??before.step
  if(!['new','active','dismissed','completed'].includes(status))fail('Choose a valid walkthrough state.')
  if(!Number.isInteger(step)||step<0||step>=tours[current].steps.length)fail('Choose a valid walkthrough step.')
  await ctx.store.put(user.id,'user-guide',{id:current,status,step,updatedAt:new Date().toISOString()},{actor:user.id,event:'user-guide/progress-saved'})
  return get(user)
 }
 ctx.provide('userGuide',{get,progress})
 ctx.effect(()=>ctx.web.contribute({id:'help',label:'Help & getting started',icon:'file',roles:['contractor','supplier','admin'],order:90}))
 ctx.effect(()=>ctx.web.route('GET','/user-guide',({user})=>get(user)))
 ctx.effect(()=>ctx.web.route('POST','/user-guide/progress',async({user,body})=>({ok:true,...await progress(user,body)})))
}
