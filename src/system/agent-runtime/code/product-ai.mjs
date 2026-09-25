/** Real configured model provider. Every complete input/output is account-ledger backed. */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { parse } = require('yaml')
export const name = 'product-ai'
export const inject = ['store','settings']
export function apply(ctx, config = {}) {
  const controllers = new Set()
  const legacySettings = () => {
    const filename = config.configFile || process.env.QUOTAGENT_CONFIG || '/workspace/config.yaml'
    const doc = existsSync(filename) ? parse(readFileSync(filename,'utf8')) : {}
    const llm = doc.llm || {}, provider = llm.provider || 'openai', entry = doc.api_keys?.[provider] || {}
    const key = process.env[entry.env || 'QUOTAGENT_AI_KEY'] || entry.value || ''
    return {provider,model:process.env.QUOTAGENT_AI_MODEL || llm.model || entry.default_model || '',
      key,baseUrl:process.env.QUOTAGENT_AI_URL || entry.base_url || 'https://api.openai.com/v1',
      effort:llm.reasoning_effort,extra:{...llm.extra_body,...entry.extra_body},timeout:Number(llm.timeout_s || 180)*1000}
  }
  ctx.effect(()=>ctx.settings.define({id:'ai',name:'AI model connection',scope:'user',
    description:'Use the shared model connection or provide your own. A different provider or endpoint requires your own API key. Leave an existing key blank to keep it.',
    fields:[{key:'provider',label:'Provider name',type:'text',required:true},{key:'model',label:'Model',type:'text'},
      {key:'baseUrl',label:'API base URL',type:'text',required:true,description:'OpenAI-compatible endpoint, including /v1 when required.'},
      {key:'apiKey',label:'API key',type:'password'},
      {key:'timeoutSeconds',label:'Request timeout (seconds)',type:'number',min:5,max:300}],
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
  const complete = async (user,{messages,tools,purpose='assistant',signal}) => {
    const s = settings(user)
    if (!s.key || !s.model) throw new Error('Open Plugin settings → AI model connection to add a model and API key, or restore the shared defaults.')
    const request = {model:s.model,messages,stream:false,...s.extra}
    if (tools?.length) { request.tools=tools; request.tool_choice='auto' }
    if (s.effort && !['none','off','disabled'].includes(String(s.effort))) request.reasoning_effort=s.effort
    else if (s.provider === 'deepseek') request.thinking={type:'disabled'}
    const endpoint = s.baseUrl.replace(/\/$/,'') + '/chat/completions'
    const callId = randomUUID()
    await ctx.store.append(user.id,'agent/model-requested',{callId,purpose,provider:s.provider,endpoint,request},{actor:`agent:${user.id}`})
    const controller = new AbortController(); controllers.add(controller)
    const abort=()=>controller.abort(signal?.reason)
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})
    const timer = setTimeout(()=>controller.abort(),s.timeout)
    try {
      const response = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${s.key}`},body:JSON.stringify(request),signal:controller.signal})
      const payload = await response.json()
      if (!response.ok) throw new Error(`Model provider returned ${response.status}: ${String(payload.error?.message || 'request failed').slice(0,300)}`)
      await ctx.store.append(user.id,'agent/model-completed',{callId,response:payload},{actor:`agent:${user.id}`})
      const message = payload.choices?.[0]?.message
      if (!message) throw new Error('The model returned no response. Please try again.')
      return message
    } catch(error) {
      const message = error.name === 'AbortError' ? (signal?.aborted?'This agent task was cancelled.':'The model took too long. Please try again.') : error.message.replaceAll(s.key,'[redacted]')
      await ctx.store.append(user.id,'agent/model-failed',{callId,error:message},{actor:`agent:${user.id}`})
      throw new Error(message)
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort);controllers.delete(controller) }
  }
  ctx.provide('ai',{complete,status})
  ctx.effect(()=>()=>{ for(const controller of controllers) controller.abort(); controllers.clear() })
}
