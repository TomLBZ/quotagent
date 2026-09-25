/** Real configured model provider. Every complete input/output is account-ledger backed. */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { parse } = require('yaml')
export const name = 'product-ai'
export const inject = ['store']
export function apply(ctx, config = {}) {
  const controllers = new Set()
  const settings = () => {
    const filename = config.configFile || process.env.QUOTAGENT_CONFIG || '/workspace/config.yaml'
    const doc = existsSync(filename) ? parse(readFileSync(filename,'utf8')) : {}
    const llm = doc.llm || {}, provider = llm.provider || 'openai', entry = doc.api_keys?.[provider] || {}
    const key = process.env[entry.env || 'QUOTAGENT_AI_KEY'] || entry.value || ''
    return {provider,model:process.env.QUOTAGENT_AI_MODEL || llm.model || entry.default_model || '',
      key,baseUrl:process.env.QUOTAGENT_AI_URL || entry.base_url || 'https://api.openai.com/v1',
      effort:llm.reasoning_effort,extra:{...llm.extra_body,...entry.extra_body},timeout:Number(llm.timeout_s || 180)*1000}
  }
  const status = () => { const s = settings(); return {available:!!(s.key && s.model),provider:s.provider,model:s.model} }
  const complete = async (user,{messages,tools,purpose='assistant'}) => {
    const s = settings()
    if (!s.key || !s.model) throw new Error('AI provider is not configured. Ask your administrator to connect a model.')
    const request = {model:s.model,messages,stream:false,...s.extra}
    if (tools?.length) { request.tools=tools; request.tool_choice='auto' }
    if (s.effort && !['none','off','disabled'].includes(String(s.effort))) request.reasoning_effort=s.effort
    else if (s.provider === 'deepseek') request.thinking={type:'disabled'}
    const endpoint = s.baseUrl.replace(/\/$/,'') + '/chat/completions'
    const callId = randomUUID()
    await ctx.store.append(user.id,'agent/model-requested',{callId,purpose,provider:s.provider,endpoint,request},{actor:`agent:${user.id}`})
    const controller = new AbortController(); controllers.add(controller)
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
      const message = error.name === 'AbortError' ? 'The model took too long. Please try again.' : error.message.replaceAll(s.key,'[redacted]')
      await ctx.store.append(user.id,'agent/model-failed',{callId,error:message},{actor:`agent:${user.id}`})
      throw new Error(message)
    } finally { clearTimeout(timer); controllers.delete(controller) }
  }
  ctx.provide('ai',{complete,status})
  ctx.effect(()=>()=>{ for(const controller of controllers) controller.abort(); controllers.clear() })
}
