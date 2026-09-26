import { createTeams } from './service.mjs'
export const name='party-teams'
export const inject=['store','accounts','web']
export const provides=['teams']
export function apply(ctx){
  const teams=createTeams({store:ctx.store,accounts:ctx.accounts,notifications:()=>ctx.get('notifications'),procurement:()=>ctx.get('procurement'),actions:()=>ctx.get('actions')})
  ctx.provide('teams',teams)
  ctx.effect(()=>()=>teams.dispose())
  ctx.effect(()=>ctx.web.contribute({id:'team',label:'My day & team',icon:'users',roles:['contractor','supplier'],order:15}))
  const route=(method,path,handler,options={})=>ctx.effect(()=>ctx.web.route(method,path,handler,options))
  route('GET','/teams',({user,query})=>teams.state(user,{commentsLimit:Number(query.get('commentsLimit'))||100}))
  route('GET','/teams/authority',({user,query})=>teams.authority(user,query.has('amount')?Number(query.get('amount')):null,query.get('currency')||'USD',query.get('workspaceId')||undefined))
  route('POST','/teams/select',async({user,body})=>({ok:true,workspace:await teams.select(user,body.ownerId)}))
  const actions={invite:(user,input)=>teams.invite(user,input),'answer-invitation':(user,input)=>teams.answerInvite(user,input.id,input.accept===true),'update-member':teams.updateMember,'propose-policy':teams.proposePolicy,'decide-policy':(user,input)=>teams.decidePolicy(user,input.id,input),'apply-policy':(user,input)=>teams.applyPolicy(user,input.id),assign:teams.assign,'complete-assignment':(user,input)=>teams.completeAssignment(user,input.id),follow:teams.follow,comment:teams.comment}
  route('POST','/teams/:action',async({user,params,body})=>{
    const action=actions[params.action]
    if(!action)throw new Error('This team action is not available.')
    return {ok:true,result:await action(user,body)}
  },{capability:'workspace:write'})
  ctx.inject(['assistant'],child=>{
    child.effect(()=>child.assistant.tool({name:'team_work_context',description:'Read the explicitly selected party team, your assignments, mentions and reviewed authority. Unconfigured limits are unknown; this tool cannot approve anything.',effect:'read',roles:['contractor','supplier'],parameters:{type:'object',properties:{}},execute:user=>teams.state(user)}))
  })
}
