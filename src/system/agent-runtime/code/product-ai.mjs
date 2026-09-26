/** Real configured model provider. Every complete input/output is account-ledger backed. */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import * as runtimeControls from './provider-controls.mjs'
import {AdmissionError,retryDelay,stable} from './provider-policy.mjs'
import {normalizeUsage} from './product-usage.mjs'
import {boundSourceMessages} from './context.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { parse } = require('yaml')
export const name = 'product-ai'
export const inject = ['store','settings']
export async function apply(ctx, config = {}) {
  await ctx.plugin(runtimeControls, config.controls || {})
  const runtime = ctx.get('aiRuntime')
  const controllers = new Set()
  const legacySettings = () => {
    if(config.inheritDefaults===false)return {origins:Object.fromEntries(['provider','model','baseUrl','apiKey','timeoutSeconds'].map(key=>[key,{source:'default',reference:'Isolated AI connection defaults; operator environment/file inheritance disabled'}])),provider:'openai',model:'',key:'',baseUrl:'https://api.openai.com/v1',extra:{},timeout:180000}
    const filename = config.configFile || process.env.QUOTAGENT_CONFIG || '/workspace/config.yaml'
    const doc = existsSync(filename) ? parse(readFileSync(filename,'utf8')) : {}
    const llm = doc.llm || {}, provider = llm.provider || 'openai', entry = doc.api_keys?.[provider] || {}
    const keyVariable=entry.env||'QUOTAGENT_AI_KEY', key = process.env[keyVariable] || entry.value || ''
    const source=(variable,present,path)=>variable&&process.env[variable]?{source:'environment',reference:variable}:present?{source:'file',reference:filename+'#'+path}:{source:'default',reference:'AI connection plugin default'}
    const origins={provider:source(null,llm.provider,'llm.provider'),model:source('QUOTAGENT_AI_MODEL',llm.model||entry.default_model,llm.model?'llm.model':'api_keys.'+provider+'.default_model'),baseUrl:source('QUOTAGENT_AI_URL',entry.base_url,'api_keys.'+provider+'.base_url'),apiKey:source(keyVariable,entry.value,'api_keys.'+provider+'.value'),timeoutSeconds:source(null,llm.timeout_s,'llm.timeout_s')}
    return {origins,provider,model:process.env.QUOTAGENT_AI_MODEL || llm.model || entry.default_model || '',
      key,baseUrl:process.env.QUOTAGENT_AI_URL || entry.base_url || 'https://api.openai.com/v1',
      effort:llm.reasoning_effort,extra:{...llm.extra_body,...entry.extra_body},timeout:Number(llm.timeout_s || 180)*1000}
  }
  ctx.effect(()=>ctx.settings.define({id:'ai',name:'AI model connection',scope:'user',
    description:'Use the shared model connection or provide your own. A different provider or endpoint requires your own API key. Leave an existing key blank to keep it.',
    fields:[{key:'provider',label:'Provider name',type:'text',required:true},{key:'model',label:'Model',type:'text'},
      {key:'baseUrl',label:'API base URL',type:'text',required:true,description:'OpenAI-compatible endpoint, including /v1 when required.'},
      {key:'apiKey',label:'API key',type:'password'},
      {key:'timeoutSeconds',label:'Request timeout (seconds)',type:'number',min:5,max:300}],
    origins:()=>legacySettings().origins,
    defaults:()=>{const s=legacySettings();return {provider:s.provider,model:s.model,baseUrl:s.baseUrl,apiKey:s.key,timeoutSeconds:s.timeout/1000}},
    resolve:(values,{user,globalValues,overriddenKeys})=>{
      const changed=values.provider!==globalValues.provider || values.baseUrl.replace(/\/$/,'')!==globalValues.baseUrl.replace(/\/$/,'')
      return user && user.role!=='admin' && changed && !overriddenKeys.includes('apiKey') ? {...values,apiKey:''} : values
    },
    validate:values=>{let url;try{url=new URL(values.baseUrl)}catch{throw new Error('Enter a valid model API base URL.')}
      if(!['https:','http:'].includes(url.protocol))throw new Error('Model connections require an HTTP or HTTPS URL.')},
  }))
  const settings = user => {const legacy=legacySettings(),configured=ctx.settings.get(user,'ai')
    const sameConnection=configured.provider===legacy.provider && configured.baseUrl.replace(/\/$/,'')===legacy.baseUrl.replace(/\/$/,'')
    return {...legacy,extra:sameConnection?legacy.extra:{},effort:sameConnection?legacy.effort:undefined,
      provider:configured.provider,model:configured.model,baseUrl:configured.baseUrl,key:configured.apiKey,timeout:configured.timeoutSeconds*1000}}
  const status = user => { const s = settings(user); return {available:!!(s.key && s.model),provider:s.provider,model:s.model} }
  const complete = async (user,{messages,tools,purpose='assistant',signal,runId=null,requestKey=null,contextReceipt=null}) => {
    const s = settings(user)
    if (!s.key || !s.model) throw new Error('Open Plugin settings → AI model connection to add a model and API key, or restore the shared defaults.')
    const limits=runtime.config(user),bounded=boundSourceMessages(messages,limits),request={model:s.model,messages:bounded.messages,stream:false,...s.extra}
    contextReceipt=bounded.receipt||contextReceipt
    if(contextReceipt)await ctx.store.append(user.id,'agent/context-assembled',{runId,purpose,...contextReceipt},{actor:`agent:${user.id}`})
    if(tools?.length){request.tools=tools;request.tool_choice='auto'}
    if(s.effort&&!['none','off','disabled'].includes(String(s.effort)))request.reasoning_effort=s.effort
    else if(s.provider==='deepseek')request.thinking={type:'disabled'}
    delete request.max_tokens;delete request.max_completion_tokens;request[limits.outputLimitParameter]=limits.maxOutputTokens
    const wireBody=JSON.stringify(stable(request)),serialization='json-key-sorted/v1',requestSha256=createHash('sha256').update(wireBody).digest('hex'),requestBytes=Buffer.byteLength(wireBody,'utf8')
    const endpoint=s.baseUrl.replace(/\/$/,'')+'/chat/completions',callId=randomUUID(),startedAt=new Date().toISOString(),attemptUsage=[]
    let responseValue=null,outcome='failed',failure=null,result=null
    const redact=message=>String(message).replaceAll(s.key,'[redacted]').slice(0,1000)
    try{
      result=await runtime.run(user,{connection:s,request,purpose,signal,runId,requestKey,callId},async lease=>{
        if(requestBytes>limits.maxContextBytes)throw new AdmissionError('context-too-large','This complete model request exceeds the configured context byte limit.',{status:413,nextAction:'Narrow the source/task or increase the explicit context limit. Required instructions were not silently truncated.'})
        await ctx.store.append(user.id,'agent/model-requested',{callId,purpose,runId,provider:s.provider,endpoint,request,serialization,contextReceipt:contextReceipt||null},{actor:`agent:${user.id}`})
        for(let attempt=0;;attempt++){
          await lease.attempt()
          const controller=new AbortController();controllers.add(controller);let timedOut=false
          const abort=()=>controller.abort(lease.signal.reason);if(lease.signal.aborted)abort();else lease.signal.addEventListener('abort',abort,{once:true})
          const timer=setTimeout(()=>{timedOut=true;controller.abort()},s.timeout)
          let response,payload
          try{
            await ctx.store.append(user.id,'agent/model-dispatched',{callId,runId,attempt:attempt+1,serialization,requestSha256,requestBytes},{actor:`agent:${user.id}`})
            response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${s.key}`},body:wireBody,signal:controller.signal})
            try{payload=await response.json()}catch{throw new AdmissionError('invalid-provider-response','The provider did not return a valid JSON response.',{status:502})}
            attemptUsage.push(payload.usage??null);responseValue=payload
            if(!response.ok){
              lease.attemptOutcome(false)
              const error=new AdmissionError(`http-${response.status}`,`Model provider returned ${response.status}: ${redact(payload.error?.message||'request failed')}`,{status:response.status,nextAction:response.status===401||response.status===403?'Review the model connection credentials.':'Inspect the provider response; retry explicitly if appropriate.'})
              error.providerOutcomeRecorded=true
              if([429,503].includes(response.status)&&attempt<lease.config.maxRetries){const retry=retryDelay(response,attempt,{baseDelayMs:lease.config.retryBaseMs,maxDelayMs:lease.config.retryMaxWaitMs});if(retry.withinLimit){await lease.retry({...retry,httpStatus:response.status,nextAttempt:attempt+2});await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);lease.signal.removeEventListener('abort',abort);reject(new AdmissionError('canceled','The retry wait was canceled.',{status:409}))},timer=setTimeout(()=>{lease.signal.removeEventListener('abort',abort);resolve()},retry.delayMs);if(lease.signal.aborted)abort();else lease.signal.addEventListener('abort',abort,{once:true})});continue}error.detail.retryAfterMs=retry.delayMs;error.detail.waitingHelps=true;error.detail.nextAction='The provider requested a longer wait than automatic retries allow. Retry explicitly after that interval.'}
              throw error
            }
            const message=payload.choices?.[0]?.message
            if(!message)throw new AdmissionError('invalid-provider-response','The model returned no response. Please try again.',{status:502})
            lease.attemptOutcome(true)
            await ctx.store.append(user.id,'agent/model-completed',{callId,response:payload,runId,attempts:attempt+1},{actor:`agent:${user.id}`})
            const counts=attemptUsage.map(normalizeUsage),keys=Object.keys(normalizeUsage()),tokens=Object.fromEntries(keys.map(key=>[key,counts.every(row=>row[key]!==null)?counts.reduce((sum,row)=>sum+row[key],0):null]))
            return{message,tokens,completeUsage:counts.every(row=>row.input!==null&&row.output!==null&&row.total!==null),usage:payload.usage||null,usageCoverage:{attempts:attemptUsage.length,knownAttempts:counts.filter(row=>row.total!==null).length,unknownAttempts:counts.filter(row=>row.total===null).length}}
          }catch(error){
            if(lease.signal.aborted)throw new AdmissionError('canceled','This agent task was cancelled.',{status:409,nextAction:'Resume saved work or start another request deliberately.'})
            if(!error.providerOutcomeRecorded)lease.attemptOutcome(false)
            if(timedOut)throw new AdmissionError('provider-timeout','The provider exceeded its request timeout. No automatic retry was made.',{status:504,nextAction:'Inspect completed work and retry explicitly, or adjust the model timeout.'})
            if(error instanceof AdmissionError)throw error
            throw new AdmissionError('provider-network-error',redact(error.message||'Provider connection failed.'),{status:502,nextAction:'Delivery to the provider may be uncertain. Inspect saved work and retry explicitly.'})
          }finally{clearTimeout(timer);lease.signal.removeEventListener('abort',abort);controllers.delete(controller)}
        }
      })
      outcome='completed';return result.message
    }catch(error){failure=error;if(error.detail?.replayed)throw error;outcome=error.code==='canceled'||signal?.aborted?'canceled':'failed';await ctx.store.append(user.id,'agent/model-failed',{callId,error:redact(error.message),code:error.code||'provider-error',detail:error.detail||null,status:outcome,canceled:outcome==='canceled',runId,attempts:error.attempts||attemptUsage.length},{actor:`agent:${user.id}`});throw error
    }finally{
      // Replayed identities reuse the original measured receipt instead of counting a new model call.
      if(!failure?.detail?.replayed&&(!result||result.callId===callId))await ctx.get('usage')?.record(user,{callId,provider:s.provider,model:responseValue?.model||s.model,purpose,status:outcome,startedAt,finishedAt:new Date().toISOString(),usage:responseValue?.usage??null,tokens:result?.tokens,cost:result?.cost||null,runId,attempts:result?.attempts||failure?.attempts||0,stopReason:failure?.code||null,usageCoverage:result?.usageCoverage||null})
    }
  }
  ctx.provide('ai',{complete,status})
  ctx.effect(()=>()=>{ for(const controller of controllers) controller.abort(); controllers.clear() })
}
