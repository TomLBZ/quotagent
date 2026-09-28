import * as provider from './provider.mjs'
import {createAdvisor} from './service.mjs'
export const name='advisor'
export const inject=['store','accounts','web','procurement','settings','aiRuntime','usage']
export const provides=['advisor']
export async function apply(ctx,config={}){
 await ctx.plugin(provider,config)
 const advisor=createAdvisor(ctx);await advisor.recover();ctx.provide('advisor',advisor);ctx.effect(()=>()=>advisor.dispose())
 const route=(method,path,handler,options={})=>ctx.effect(()=>ctx.web.route(method,path,handler,options))
 route('GET','/advisor',({user})=>advisor.state(user))
 route('GET','/advisor/assessment',({user,query})=>advisor.get(user,query.get('id')))
 route('POST','/advisor/assess',({user,body})=>advisor.assess(user,body),{capability:'assistant:use'})
 route('POST','/advisor/cancel',({user,body})=>advisor.cancel(user,body.id),{capability:'assistant:use'})
 route('POST','/advisor/review',({user,body})=>advisor.review(user,body),{capability:'workspace:write'})
 ctx.effect(()=>ctx.web.contribute({id:'advisor',label:'Quotation advisor',icon:'spark',roles:['contractor','supplier'],order:33}))
 ctx.inject(['assistant'],inner=>inner.effect(()=>inner.assistant.tool({name:'assess_quotation',effect:'draft',sourceTrust:'external',roles:['contractor','supplier'],description:'Ask Jev for typed advisory clarification routing, quotation anomaly/deviation review, contractor shortlist, or source claim checking. Read current procurement_workspace first. Saves a private assessment and source receipts, never changes terms or approves a commitment. Show uncertainty; do not treat suggestions as facts. For shortlist supply the user’s explicit priorities. Field-check uses only the explicit pasted source text as evidence for the supplied claims; absent details are unknown. Its linked RFQ is organizational/access metadata, never evidence of supplier statements.',parameters:{type:'object',additionalProperties:false,required:['mode','rfqId'],properties:{mode:{type:'string',enum:['clarification','quote-review','shortlist','field-check']},rfqId:{type:'string'},quoteId:{type:'string'},text:{type:'string'},claims:{type:'array',maxItems:12,items:{type:'string'}}}},execute:(user,input,context)=>advisor.assess(user,input,context)})))
}
