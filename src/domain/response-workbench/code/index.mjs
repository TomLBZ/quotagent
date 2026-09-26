import {createResponses} from './service.mjs'
import {documentHtml,reportHtml,reportText,reportCsv} from './exports.mjs'
export const name='response-workbench'
export const inject=['store','accounts','web','procurement','settings','actions','notifications']
export const provides=['responses']
export function apply(ctx,config={}){
 ctx.effect(()=>ctx.settings.define({id:'responses',name:'Response tracking',scope:'account',description:'Private coverage target and in-app deadline reminders. External messages always require review.',fields:[{key:'minimumResponses',label:'Desired current responses',type:'number',min:1,max:50},{key:'soonHours',label:'Due-soon window (hours)',type:'number',min:1,max:720},{key:'notifications',label:'Record automatic in-app deadline reminders',type:'boolean'}],defaults:{minimumResponses:2,soonHours:24,notifications:true},validate:values=>{if(!Number.isInteger(values.minimumResponses)||!Number.isFinite(values.soonHours))throw new Error('Choose a whole response target and numeric reminder window.')}}))
 const responses=createResponses(ctx,config);ctx.provide('responses',responses)
 ctx.effect(()=>ctx.store.exchangePolicy(responses.policy));ctx.effect(()=>ctx.actions.register({kind:'responses.send',label:'Reviewed response or reminder',execute:responses.execute}))
 ctx.effect(()=>{const timer=setInterval(()=>responses.tick().catch(()=>{}),Math.max(1000,config.intervalMs||60000));timer.unref();return()=>clearInterval(timer)})
 ctx.effect(()=>()=>responses.dispose())
 const route=(method,path,handler,options={})=>ctx.effect(()=>ctx.web.route(method,path,handler,options))
 route('GET','/responses',({user,query})=>responses.state(user,Object.fromEntries(query)))
 route('GET','/responses/object',({user,query})=>responses.objectState(user,Object.fromEntries(query)))
 route('POST','/responses/read',({user,body})=>responses.read(user,body))
 route('POST','/responses/propose',({user,body})=>responses.propose(user,body),{capability:'workspace:write'})
 route('GET','/responses/report',({user,query})=>responses.report(user,Object.fromEntries(query)))
 route('GET','/responses/print',({user,query,res})=>{const document=responses.document(user,Object.fromEntries(query));res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');res.end(documentHtml(document))})
 route('GET','/responses/report/export',({user,query,res})=>{const report=responses.report(user,Object.fromEntries(query)),format=query.get('format')||'txt',mime=format==='html'?'text/html':format==='csv'?'text/csv':'text/plain';res.setHeader('content-type',mime+'; charset=utf-8');res.setHeader('cache-control','no-store');if(format!=='html')res.setHeader('content-disposition',`attachment; filename="recorded-activity.${format==='csv'?'csv':'txt'}"`);res.end(format==='html'?reportHtml(report):format==='csv'?reportCsv(report):reportText(report))})
 ctx.effect(()=>ctx.web.contribute({id:'responses',label:'Responses & receipts',icon:'clock',roles:['contractor','supplier'],order:34}))
 ctx.inject(['assistant'],inner=>{const register=tool=>inner.effect(()=>inner.assistant.tool(tool));register({name:'response_coverage',effect:'read',sourceTrust:'external',roles:['contractor','supplier'],description:'Read source-derived current response coverage, exact deadlines, promises and read receipts within this party. Other bidders are never visible to suppliers.',parameters:{type:'object',properties:{asOf:{type:'string',description:'Explicit ISO timestamp for deterministic due calculations'}}},execute:(user,input)=>responses.state(user,input)});register({name:'prepare_response_review',effect:'proposal',roles:['contractor','supplier'],description:'Prepare an exact supplier response-time promise or contractor reminder for human approval. Does not send. Use only requested recipient/time/text, never infer authority.',parameters:{type:'object',properties:{type:{type:'string',enum:['promise','reminder']},rfqId:{type:'string'},dueAt:{type:'string'},note:{type:'string'},toId:{type:'string'},text:{type:'string'}},required:['type','rfqId']},execute:(user,input,context)=>responses.propose(user,input,context)})})
}
