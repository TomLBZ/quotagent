import {randomUUID,createHash} from 'node:crypto'
const clean=(value,max=2000)=>String(value ?? '').trim().slice(0,max)
const fail=message=>{throw Object.assign(new Error(message),{status:400})}
export function createMemory(ctx){
  const list=(user,{archived=false}={})=>ctx.store.list(user.id,'agent-memory').filter(record=>archived?record.archived:!record.archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
  const context=user=>list(user).map(({id,key,value,source,revision,updatedAt})=>({id,key,value,source,revision,updatedAt}))
  async function put(user,input={},options={}){
    const key=clean(input.key,120),value=clean(input.value,5000)
    if(!key||!value)fail('Give the memory a name and a value.')
    const previous=input.id?ctx.store.get(user.id,'agent-memory',input.id):null
    if(input.id&&!previous&&!options.allowNewId)fail('Memory was not found in your account.')
    const source={kind:'human',...input.source,accountId:user.id}
    const record={id:previous?.id || (options.allowNewId?input.id:randomUUID()),key,value,source,revision:(previous?.revision||0)+1,archived:false,
      createdAt:previous?.createdAt || new Date().toISOString(),updatedAt:new Date().toISOString(),
      history:[...(previous?.history||[]),...(previous?[{key:previous.key,value:previous.value,source:previous.source,revision:previous.revision,updatedAt:previous.updatedAt}]:[])]}
    await ctx.store.put(user.id,'agent-memory',record,{actor:options.actor || `human:${user.id}`,event:'agent-memory/saved'})
    return record
  }
  async function remove(user,id){
    const previous=ctx.store.get(user.id,'agent-memory',id)
    if(!previous)fail('Memory was not found in your account.')
    const record={...previous,archived:true,revision:previous.revision+1,updatedAt:new Date().toISOString()}
    await ctx.store.put(user.id,'agent-memory',record,{actor:`human:${user.id}`,event:'agent-memory/archived'})
    return {ok:true}
  }
  const suggest=async(user,input={})=>{
    const key=clean(input.key,120),value=clean(input.value,5000)
    if(!key||!value)fail('A memory suggestion needs a name and value.')
    const proposal=await ctx.actions.propose(user,{kind:'memory.save',title:`Remember: ${key}`,summary:value,
      input:{key,value,source:{kind:'assistant',...input.source,accountId:user.id}},source:input.source?.kind || 'assistant',runId:input.source?.runId})
    return {proposal,action:{type:'navigate',label:'Review memory suggestion',input:{view:'approvals',actionId:proposal.id}}}
  }
  const migrations=new Map()
  async function importLegacy(user){
    if(migrations.has(user.id))return migrations.get(user.id)
    const task=(async()=>{
      const preferences=ctx.accounts.get(user.id)?.preferences || {}
      for(const [key,original] of Object.entries(preferences)){
        const id='legacy-'+createHash('sha256').update(key).digest('hex').slice(0,32)
        // The tombstone is intentional: neither edits nor archive may be undone by migration.
        if(ctx.store.get(user.id,'agent-memory',id))continue
        const value=typeof original==='string'?original:JSON.stringify(original)
        if(!clean(key,120)||!clean(value,5000))continue
        await put(user,{id,key,value,source:{kind:'legacy-preference',reference:`Existing account preference: ${key}`,legacyKey:key}},{allowNewId:true,actor:'system:agent-workflows'})
      }
    })()
    migrations.set(user.id,task)
    try{await task}finally{migrations.delete(user.id)}
  }
  ctx.effect(()=>ctx.actions.register({kind:'memory.save',label:'Save account memory',execute:(user,input,action)=>put(user,{...input,source:{...input.source,approvedBy:user.id,approvalId:action.id}})}))
  return {list,context,put,remove,suggest,importLegacy}
}
