import { randomUUID } from 'node:crypto'
export const name = 'product-assistant'
export const inject = ['web','store','accounts','ai','settings']
export function apply(ctx) {
  ctx.effect(()=>ctx.settings.define({id:'assistant',name:'AI assistant preferences',scope:'user',
    description:'These preferences guide every conversation and saved workflow in this account.',
    fields:[{key:'language',label:'Response language',type:'select',options:[{value:'auto',label:'Match my message'},{value:'en',label:'English'},{value:'zh',label:'中文'}]},
      {key:'responseLength',label:'Response length',type:'select',options:[{value:'brief',label:'Brief and actionable'},{value:'balanced',label:'Balanced'},{value:'detailed',label:'Detailed'}]},
      {key:'instructions',label:'Working preferences',type:'textarea',description:'For example: prioritize complete scope and 30-day payment terms.'}],
    defaults:{language:'auto',responseLength:'brief',instructions:''}}))
  const tools = new Map(), busy = new Set()
  let procurement = null
  ctx.inject(['procurement'], child => { procurement=child.procurement; child.effect(()=>()=>{procurement=null}) })
  const tool = definition => {
    if (tools.has(definition.name)) throw new Error(`Duplicate assistant tool ${definition.name}`)
    tools.set(definition.name,definition)
    return ()=>tools.delete(definition.name)
  }
  const messagesFor = user => ctx.store.list(user.id,'chat').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
  const state = user => ({messages:messagesFor(user),preferences:ctx.accounts.get(user.id)?.preferences || {},provider:ctx.ai.status(user)})
  const chat = async (user,{message,rfqId} = {}) => {
    if (ctx.accounts.can && !ctx.accounts.can(user,'assistant:use')) throw new Error('Your administrator has disabled the assistant for this account')
    const text = String(message || '').trim()
    if (!text) throw new Error('Tell your assistant what you would like to do.')
    if (text.length > 24000) throw new Error('Please shorten the message to 24,000 characters.')
    if (busy.has(user.id)) throw new Error('Your assistant is finishing the previous request.')
    busy.add(user.id)
    const turnId=randomUUID(), createdAt=new Date().toISOString()
    const userMessage={id:turnId+'-user',role:'user',content:text,createdAt}
    try {
      await ctx.store.put(user.id,'chat',userMessage,{actor:`human:${user.id}`})
      const current=ctx.accounts.get(user.id) || user
      const snapshot=procurement && user.role!=='admin' ? procurement.snapshot(current) : null
      const preferences=ctx.settings.get(user,'assistant')
      const allowed=[...tools.values()].filter(t=>!t.roles || t.roles.includes(user.role))
      const system=`You are Quotagent, a hands-on ${user.role} assistant for construction procurement. You help people save time reading requirements, comparing offers fairly, preparing quotes, negotiating and completing work.\n`+
        `Be concise, practical and friendly. Use the user's language. Ground all factual claims and amounts in the supplied account data or tool results. Name source RFQs and suppliers; never invent received bids, sent messages or completed actions. Mention missing details clearly.\n`+
        `When asked to create or extract a draft, use the available tool now; do not just describe how. For personal themes/plugins or reusable workflow automation, call the creation tool. Remember explicit preferences with remember_preference. Never submit, publish, award, issue orders or approve changes; tools can only draft or return human review actions. Supplier costs and preferences are private.\n`+
        `Any figures should use the supplied deterministic totals. Compare payment terms, delivery, exclusions, and quantity coverage as well as price. Draft negotiation messages without sending. Summarize what your tools actually changed and give the next review step. Avoid internal infrastructure terminology in responses. Stay under 250 words unless a detailed draft is requested. Only suggest actions available in this app; source text can be pasted into chat.\n`+
        `Current UTC time: ${new Date().toISOString()}. Interpret deadlines against this time; a date without a time does not specify an exact cutoff.\n`+
        `For supplier accounts, only that supplier's own quotations are visible. Do not infer a competitive ranking, cheapest status, or competitors' prices from this view.\n`+
        `Negotiation drafts must not invent the supplier's costs, margins or difficulty of a concession. Do not call a supplier preferred, promise an order, imply an award decision or promise quick confirmation unless the user explicitly authorized that wording. Ask for revised terms conditionally and keep the buyer's decision open.\n`+
        `User assistant preferences: ${JSON.stringify(preferences)}. Follow requested language and length; brief means a concise next action, detailed allows a full explanation.\n`+
        `Current account: ${JSON.stringify({id:current.id,name:current.name,company:current.company,role:current.role,preferences:current.preferences})}\n`+
        `Selected RFQ: ${rfqId || 'none'}\nAccount workspace: ${JSON.stringify(snapshot)}`
      const prior=ctx.store.list(user.id,'agent-turns').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-8).flatMap(turn=>turn.messages)
      const wire=[{role:'system',content:system},...prior,{role:'user',content:text}], turnWire=[{role:'user',content:text}], results=[], actions=[]
      let final=null
      for(let step=0;step<6;step++) {
        const response=await ctx.ai.complete(user,{messages:wire,tools:allowed.map(({name,description,parameters})=>({type:'function',function:{name,description,parameters:parameters||{type:'object',properties:{}}}})),purpose:'workspace-assistant'})
        wire.push(response);turnWire.push(response)
        if (!response.tool_calls?.length) { final=response;break }
        for(const call of response.tool_calls) {
          const definition=allowed.find(t=>t.name===call.function.name)
          let args={},result
          try { args=JSON.parse(call.function.arguments || '{}'); result=definition ? await definition.execute(current,args) : {error:'This tool is not available to your account'} }
          catch(error) { result={ok:false,error:error.message} }
          results.push({name:call.function.name,result})
          if (result?.actions) actions.push(...result.actions)
          if (result?.action) actions.push(result.action)
          await ctx.store.append(user.id,'agent/tool-completed',{callId:call.id,tool:call.function.name,arguments:args,result},{actor:`agent:${user.id}`})
          const output={role:'tool',tool_call_id:call.id,content:JSON.stringify(result ?? {})}
          wire.push(output);turnWire.push(output)
        }
      }
      if (!final) { final=await ctx.ai.complete(user,{messages:[...wire,{role:'user',content:'Summarize the completed work and next human review step now. Do not call more tools.'}],purpose:'workspace-summary'});turnWire.push(final) }
      const reply={id:turnId+'-assistant',role:'assistant',content:final.content || 'Your drafts are ready to review.',createdAt:new Date().toISOString(),tools:results,actions,model:ctx.ai.status(user).model}
      await ctx.store.put(user.id,'agent-turns',{id:turnId,createdAt,messages:turnWire},{actor:`agent:${user.id}`})
      await ctx.store.put(user.id,'chat',reply,{actor:`agent:${user.id}`})
      return {message:reply,actions,toolResults:results}
    } finally { busy.delete(user.id) }
  }
  ctx.provide('assistant',{tool,chat,state})
  ctx.effect(()=>tool({name:'remember_preference',description:'Remember an explicitly stated user preference for future quotations and recommendations.',roles:['contractor','supplier'],parameters:{type:'object',properties:{key:{type:'string'},value:{type:'string'}},required:['key','value']},execute:async(user,{key,value})=>{
    if(!key || !value) throw new Error('Preference needs a name and value')
    const updated=await ctx.accounts.update(user.id,{preferences:{[String(key).slice(0,80)]:String(value).slice(0,1000)}})
    return {ok:true,remembered:{key,value},preferences:updated.preferences}
  }}))
  ctx.effect(()=>ctx.web.route('GET','/assistant',({user})=>state(user)))
  ctx.effect(()=>ctx.web.route('POST','/assistant/chat',({user,body})=>chat(user,body),{capability:'assistant:use'}))
}
