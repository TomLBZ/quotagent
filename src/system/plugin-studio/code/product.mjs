import {clean,fail,parseDescriptor,generationPrompt} from './descriptor.mjs'
import {createEvolution} from './evolution.mjs'
export {moduleSource} from './descriptor.mjs'
export const name='product-plugin-studio'
export const inject=['web','store','accounts','ai','installedPlugins']
export const provides=['studio']
export async function apply(ctx) {
 const rt=ctx.installedPlugins,controllers=new Set();let disposed=false,actions=null
 const alive=()=>{if(disposed)fail('Plugin studio is unavailable. Installed tools remain active.',503)}
 const complete=async(user,input)=>{alive();const controller=new AbortController();controllers.add(controller);try{return await ctx.ai.complete(user,{...input,signal:controller.signal})}finally{controllers.delete(controller)}}
 const list=user=>rt.list(user),run=(user,id,input)=>rt.run(user,id,input)
 const generate=async(user,input={})=>{alive();if(!ctx.accounts.can(user,'plugins:manage'))fail('Plugin creation is disabled for this account.',403);const prompt=clean(input.prompt,12000);if(!prompt)fail('Describe the plugin or workflow you want to create.');const response=await complete(user,{purpose:'plugin-generation',messages:[{role:'system',content:generationPrompt},{role:'user',content:`Account type: ${user.role}.\nRequest: ${prompt}`}]});alive();return rt.create(user,parseDescriptor(response),{generationPrompt:prompt})}
 const evolution=createEvolution(ctx,rt,{complete,alive})
 const execute=(user,id,action,input={})=>{alive();if(action==='run')return run(user,id,input);if(action==='configure')return rt.configure(user,id,input);return rt.mutate(user,id,action,input)}
 ctx.provide('studio',{list,generate,execute,run,evolution})
 ctx.inject(['actions'],child=>{actions=child.actions;child.effect(()=>()=>{actions=null});child.effect(()=>child.actions.register({kind:'studio.generate',label:'Create personal plugin',execute:async(user,input)=>{const result=await generate(user,input);return{...result,action:{type:'navigate',label:'Open plugin studio',input:{view:'extensions'}}}}}))})
 ctx.effect(()=>()=>{disposed=true;for(const controller of controllers)controller.abort(new Error('Plugin studio unloaded'));controllers.clear()})
 const route=(method,path,handler,options)=>ctx.effect(()=>ctx.web.route(method,path,handler,options)),write={capability:'plugins:manage'}
 route('GET','/studio',({user})=>list(user))
 route('GET','/studio/evolution/summary',({user})=>evolution.summary(user))
 route('GET','/studio/evolution/:id',({user,params})=>evolution.detail(user,params.id))
 route('POST','/studio/evolution/:id/feedback',({user,params,body})=>evolution.feedback(user,params.id,body),write)
 route('POST','/studio/evolution/:id/propose',({user,params,body})=>evolution.propose(user,params.id,body),write)
 route('POST','/studio/evolution/:id/cases',({user,params,body})=>evolution.addCase(user,params.id,body),write)
 route('POST','/studio/evolution/:id/restore',({user,params,body})=>{const revisions=rt.history(user,params.id).revisions;if(!revisions.some(row=>row.id===body.revisionId&&row.everActive))fail('Use a reviewed proposal to activate an untested candidate. Restore selects a previously active revision.',409);return rt.restore(user,params.id,body.revisionId,body)},write)
 route('POST','/studio/feedback/:id/retry',({user,params,body})=>evolution.retry(user,params.id,body),write)
 route('POST','/studio/proposals/:id/shadow',({user,params,body})=>evolution.shadow(user,params.id,body),write)
 route('POST','/studio/proposals/:id/trial',({user,params,body})=>evolution.startTrial(user,params.id,body),write)
 route('POST','/studio/proposals/:id/deploy',({user,params})=>evolution.deploy(user,params.id),write)
 route('POST','/studio/shadows/:id/review',({user,params,body})=>evolution.assess(user,params.id,body),write)
 route('POST','/studio/trials/:id/rollback',({user,params,body})=>rt.rollback(user,params.id,body),write)
 route('POST','/studio/generate',({user,body})=>generate(user,body),write)
 route('POST','/studio/:id/:action',({user,params,body})=>execute(user,params.id,params.action,body),write)
 ctx.effect(()=>ctx.web.contribute({id:'extensions',label:'Plugin studio',icon:'sparkles',roles:['contractor','supplier','admin'],order:60}))
  ctx.inject(['assistant'], child => {
    child.effect(()=>child.assistant.tool({name:'inspect_extension_evolution',description:'Inspect an owned or administrator-managed extension current descriptor/revision, source hashes, proposal status and evaluation activity. With no pluginId, return bounded metadata inventory and pipeline counts.',effect:'read',roles:['contractor','supplier','admin'],parameters:{type:'object',properties:{pluginId:{type:'string'}},additionalProperties:false},execute:async(user,args)=>{const result=args.pluginId?(()=>{const detail=evolution.detail(user,args.pluginId);return{plugin:detail.plugin,proposals:detail.proposals.map(({id,status,baseRevisionId,candidateRevisionId})=>({id,status,baseRevisionId,candidateRevisionId})),summary:evolution.summary(user)}})():{inventory:rt.inventory(user,{limit:50}),summary:evolution.summary(user)};await ctx.store.append(user.id,'studio/revision-inspected',result,{actor:`agent:${user.id}`});return result}}))
    child.effect(()=>child.assistant.tool({name:'propose_extension_revision',description:'Record improvement feedback and create an inactive AI revision proposal for an owned extension. Never activates or approves changes. Return the review screen for human comparison, retained examples and limited trial.',effect:'draft',roles:['contractor','supplier','admin'],parameters:{type:'object',properties:{pluginId:{type:'string'},feedback:{type:'string'}},required:['pluginId','feedback'],additionalProperties:false},execute:async(user,args,context={})=>{const feedback=await evolution.feedback(user,args.pluginId,{body:args.feedback,view:'agent',source:{kind:'assistant',runId:context.runId||null}}),proposal=await evolution.propose(user,args.pluginId,{feedbackId:feedback.id});return{ok:true,proposal,message:'The proposed revision is inactive. Review its changes and evaluation before any live trial.',action:{type:'navigate',label:'Review extension proposal',input:{view:'extensions',pluginId:args.pluginId}}}}}))
    for (const [toolName, description, forceSkill] of [
      ['create_personal_plugin', 'Design, implement and load a personal theme, reference widget or executable utility/calculator from the user’s request. For custom tools, the model writes actual JavaScript implementation and input fields. The result is a real Cordis plugin visible in Plugin studio.', false],
      ['create_workflow_skill', 'Create and save a reusable workflow skill for process automation. The user can run it from Plugin studio.', true],
    ]) {
      child.effect(() => child.assistant.tool({ name: toolName, description, effect:'write',
        propose:async(user,args,context)=>{
          if(!actions)throw new Error('Enable Human action review to create a plugin from external source content.')
          const action=await actions.propose(user,{kind:'studio.generate',title:forceSkill?'Create a workflow skill':'Create a personal plugin',summary:args.prompt,input:{prompt:`${forceSkill?'Create a reusable workflow skill (kind=skill). ':''}${args.prompt}`},source:{kind:'assistant',tool:toolName},runId:context.runId})
          return{ok:true,message:'Review this source-assisted plugin request before creating it.',action:{type:'navigate',label:'Review plugin request',input:{view:'approvals',actionId:action.id}}}
        },
        roles: ['contractor', 'supplier', 'admin'],
        parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Complete description of the desired plugin or repeatable workflow.' } }, required: ['prompt'], additionalProperties: false },
        execute: async (user, args) => {
          const result = await generate(user, { prompt: `${forceSkill ? 'Create a reusable workflow skill (kind=skill). ' : ''}${args.prompt}` })
          return { ok: true, plugin: result.plugin, message: result.plugin.enabled ? `${result.plugin.name} is ready and loaded in your workspace.` : `${result.plugin.name} already exists and is disabled. You can enable it from Plugin studio.`,
            action: { type: 'navigate', target: 'extensions', label: 'Open plugin studio' } }
        },
      }))
    }
  })
}
