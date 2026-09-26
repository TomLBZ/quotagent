import { randomUUID } from 'node:crypto'
import {recoveryRows} from './realm-health.mjs'
import {accountRole,assertPerspective} from './perspective.mjs'

const now = () => new Date().toISOString()
const terminal = new Set(['completed', 'stopped'])
const collection = 'assistant-runs'
const cleanText = value => {
  const text = String(value || '').trim()
  if (!text) throw new Error('Tell your assistant what you would like to do.')
  if (text.length > 24000) throw new Error('Please shorten the message to 24,000 characters.')
  return text
}

/** Account-owned durable execution. Commands and checkpoint writes have separate queues
 * so a human can abort a model immediately while an earlier disk write is settling. */
export function createConversations(ctx, hooks) {
  const locks = new Map(), commands = new Map(), jobs = new Map(), controllers = new Map()
  let disposed = false
  const queue = (map, key, work) => {
    const next = (map.get(key) || Promise.resolve()).catch(() => {}).then(work)
    map.set(key, next)
    next.finally(() => { if (map.get(key) === next) map.delete(key) }).catch(() => {})
    return next
  }
  const lock = (user, work) => queue(locks, user.id, work)
  const get = (user, id) => {
    const run = ctx.store.get(user.id, collection, id)
    if (!run || run.ownerId !== user.id) throw new Error('This assistant task is not available.')
    return run
  }
  const all = user => ctx.store.list(user.id, collection).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const current = user => all(user).findLast(run => !terminal.has(run.status)) || all(user).at(-1) || null
  const view = run => run && Object.fromEntries(['id','status','phase','createdAt','updatedAt','finishedAt','message','rfqId','workspaceOwnerId','workspaceName','accountRole','error','notice','results','actions','revision','modelSteps','reply','contextReceipt','stopReason','errorDetail'].map(key => [key, run[key]]))
  const save = (user, run, event) => {
    run.updatedAt = now(); run.revision = (run.revision || 0) + 1
    return ctx.store.put(user.id, collection, run, {event: `assistant/${event}`, actor: `agent:${user.id}`})
  }
  const update = (user, id, event, modify, signal) => lock(user, async () => {
    const run = get(user, id)
    if (signal && (disposed || signal.aborted || run.status !== 'running')) return null
    await modify(run)
    await save(user, run, event)
    return run
  })
  const push = (run, message) => { run.wire.push(message); run.turnWire.push(message) }
  const result = (run, call, value) => {
    run.results.push({name: call.function.name, callId: call.id, result: value})
    if (value?.trust === 'external') run.externalContext = true
    const data = value?.trust === 'external' ? value.data : value
    if (data?.actions) run.actions.push(...data.actions)
    if (data?.action) run.actions.push(data.action)
    push(run, {role:'tool', tool_call_id:call.id, content:JSON.stringify(value ?? {})})
    run.toolIndex++; run.executingTool = null
  }
  const discardPending = run => {
    for (const call of (run.pendingTools || []).slice(run.toolIndex || 0)) result(run, call, {ok:false, skipped:true, message:'Not executed: the user changed or stopped this task.'})
    run.pendingTools = []; run.toolIndex = 0; run.phase = 'model'
  }
  const finish = (user, id, response, signal) => update(user, id, 'completed', async run => {
    const reply = {id:id+'-assistant',runId:id,role:'assistant',content:response.content || 'Your drafts are ready to review.',createdAt:now(),tools:run.results,actions:run.actions,model:hooks.status(user).model}
    await ctx.store.put(user.id, 'agent-turns', {id,createdAt:run.createdAt,workspaceOwnerId:run.workspaceOwnerId,workspaceName:run.workspaceName,accountRole:run.accountRole,messages:run.turnWire}, {actor:`agent:${user.id}`})
    await ctx.store.put(user.id, 'chat', reply, {actor:`agent:${user.id}`})
    run.reply=reply; run.status='completed'; run.phase='complete'; run.finishedAt=now(); run.error=''; run.notice=''
  }, signal)

  async function execute(user, id, signal) {
    try {
      while (!disposed && !signal.aborted) {
        const run = get(user, id)
        assertPerspective(ctx,user,run)
        const taskUser={...user,role:run.accountRole,...(run.workspaceOwnerId?{workspaceOwnerId:run.workspaceOwnerId}:{})}
        if (run.status !== 'running') break
        if (run.phase === 'finish') { await finish(user,id,run.final,signal); break }
        if (run.phase === 'tools') {
          const call = run.pendingTools[run.toolIndex]
          if (!call) { await update(user,id,'model-checkpoint',r=>{r.phase='model';r.pendingTools=[];r.toolIndex=0},signal); continue }
          const ready = await update(user,id,'tool-started',r=>{r.executingTool={id:call.id,name:call.function.name,startedAt:now()}},signal)
          if (!ready || signal.aborted || disposed) break
          let value
          try {
            value = await hooks.invoke(taskUser,{name:call.function.name,arguments:JSON.parse(call.function.arguments || '{}'),context:{source:'assistant',turnId:id,runId:id,callId:call.id,userMessage:run.message,externalContext:run.externalContext,signal}})
          } catch (error) { value={ok:false,error:error.message,...(signal.aborted?{uncertain:true,message:'This tool was interrupted. Check its records before repeating the action.'}:{})} }
          // A tool already in progress may finish after pause. Keep its receipt,
          // but the next iteration cannot launch another tool while paused.
          await update(user,id,'tool-completed',r=>result(r,call,value))
          continue
        }
        const summary = run.modelSteps >= 6
        const response = await ctx.ai.complete(taskUser,{
          messages:summary ? [...run.wire,{role:'user',content:'Summarize the completed work and next human review step now. Do not call more tools.'}] : run.wire,
          ...(!summary?{tools:hooks.definitions(user)}:{}),purpose:summary?'workspace-summary':'workspace-assistant',signal,runId:id,requestKey:`assistant:${id}:${run.revision}`,contextReceipt:run.contextReceipt,
        })
        assertPerspective(ctx,user,run)
        await update(user,id,'model-checkpoint',r=>{
          r.modelSteps++; push(r,response)
          if (response.tool_calls?.length && !summary) { r.pendingTools=response.tool_calls; r.toolIndex=0; r.phase='tools' }
          else {r.final=response; r.phase='finish'}
        },signal)
      }
    } catch (error) {
      if (!signal.aborted && !disposed) await update(user,id,'failed',run=>{run.status='failed';run.error=error.message;run.stopReason=error.code||'task-failed';run.errorDetail=error.detail||null;run.notice=error.detail?.nextAction||'Your completed work is saved. Resume to retry the unfinished step.'},signal)
    }
  }
  const launch = (user,id) => {
    if (disposed || jobs.has(id)) return
    const controller=new AbortController(); controllers.set(id,controller)
    const job=execute(user,id,controller.signal).finally(()=>{if(jobs.get(id)===job){jobs.delete(id);controllers.delete(id)}})
    jobs.set(id,job)
    job.catch(error=>console.error('[assistant]',error.message))
  }
  const authorize = user => {
    if (disposed) throw new Error('The assistant is reloading. Please try again.')
    if (ctx.accounts.can && !ctx.accounts.can(user,'assistant:use')) throw new Error('Your administrator has disabled the assistant for this account.')
  }
  const start = (user,{message,rfqId}={}) => queue(commands,user.id,async()=>{
    user={...user,role:accountRole(ctx,user)}
    authorize(user); const text=cleanText(message)
    const active=current(user)
    if(active && !terminal.has(active.status)) throw new Error('Resume or stop the current task, or add guidance to it.')
    const id=randomUUID(),createdAt=now(),prepared=await hooks.prepare(user,{message:text,rfqId,runId:id})
    const run={id,ownerId:user.id,accountRole:user.role,status:'running',phase:'model',createdAt,message:text,rfqId:rfqId||null,
      workspaceOwnerId:prepared.workspaceOwnerId,workspaceName:prepared.workspaceName,contextReceipt:prepared.contextReceipt,wire:prepared.wire,turnWire:[{role:'user',content:text}],results:[],actions:[],pendingTools:[],toolIndex:0,modelSteps:0,externalContext:false,revision:0}
    await lock(user,async()=>{
      await ctx.store.put(user.id,'chat',{id:id+'-user',runId:id,role:'user',content:text,createdAt},{actor:`human:${user.id}`})
      await save(user,run,'started')
    })
    launch(user,id); return {run:view(run)}
  })
  const control = (user,id,{action,message}={}) => {
    authorize(user)
    if(!['pause','resume','stop','steer'].includes(action))throw new Error('Choose pause, resume, stop or add guidance.')
    const guidance=action==='steer'?cleanText(message):null
    get(user,id)
    // Abort before entering either queue; no pending checkpoint may start work.
    if(action!=='resume')controllers.get(id)?.abort()
    return queue(commands,user.id,async()=>{
      authorize(user)
      if(action!=='resume')controllers.get(id)?.abort()
      const before=get(user,id)
      if(terminal.has(before.status)) {
        if(action==='pause'||action==='stop')return {run:view(before)}
        throw new Error('This task has finished. Send a new message to continue.')
      }
      if(['resume','steer'].includes(action))assertPerspective(ctx,user,before)
      if(action==='resume'){
        if(before.status==='running')return {run:view(before)}
        await jobs.get(id)
        const settled=get(user,id)
        if(terminal.has(settled.status))return {run:view(settled)}
        const next=await update(user,id,'resumed',run=>{run.status='running';run.error='';run.stopReason=null;run.errorDetail=null;run.notice='Resuming saved work.'})
        launch(user,id);return {run:view(next)}
      }
      await update(user,id,'paused',run=>{run.status='paused';run.stopReason='human-pause';run.notice=run.executingTool?'Pausing after the current tool finishes. Completed work will be kept.':'Paused. Your progress is saved.'})
      await jobs.get(id)
      if(action==='pause'){
        const next=await update(user,id,'paused',run=>{run.notice='Paused. Your progress is saved.'})
        return {run:view(next)}
      }
      const next=await update(user,id,action==='stop'?'stopped':'steered',async run=>{
        discardPending(run)
        if(action==='stop'){
          run.status='stopped';run.stopReason='human-stop';run.phase='complete';run.finishedAt=now();run.notice='Stopped. Completed drafts and review actions are kept.'
          const content='Task stopped at your request. Completed work is retained; no further steps will run.'
          push(run,{role:'assistant',content})
          await ctx.store.put(user.id,'agent-turns',{id,createdAt:run.createdAt,workspaceOwnerId:run.workspaceOwnerId,workspaceName:run.workspaceName,accountRole:run.accountRole,messages:run.turnWire},{actor:`human:${user.id}`})
          await ctx.store.put(user.id,'chat',{id:id+'-stopped',runId:id,role:'assistant',content,createdAt:now(),tools:run.results,actions:run.actions},{actor:`human:${user.id}`})
        }else{
          push(run,{role:'user',content:guidance});run.message+='\n\nAdditional guidance: '+guidance;run.modelSteps=0;run.error=''
          run.status=before.status==='running'?'running':'paused';run.notice=run.status==='running'?'Using your additional guidance.':'Guidance saved. Resume when ready.'
          await ctx.store.put(user.id,'chat',{id:randomUUID(),runId:id,role:'user',content:guidance,createdAt:now(),steering:true},{actor:`human:${user.id}`})
        }
      })
      if(next.status==='running')launch(user,id)
      return {run:view(next)}
    })
  }
  const recover = async () => {
    for (const user of ctx.accounts.list()) for (const run of recoveryRows(ctx.store,user.id,collection)) if(!terminal.has(run.status)) {
      await update(user,run.id,'recovered',r=>{
        if(r.executingTool){
          const receipt=ctx.store.events(user.id).findLast(event=>event.type==='agent/tool-completed' && event.body?.runId===r.id && event.body?.callId===r.executingTool.id)
          const call=r.pendingTools[r.toolIndex]
          if(call)result(r,call,receipt?.body.result ?? {ok:false,uncertain:true,message:'The application restarted during this tool. Inspect its records before repeating it; it was not automatically run again.'})
        }
        r.status='paused';r.notice='Recovered after a restart. Review saved progress, then resume.'
      })
    }
  }
  const dispose = async () => {
    disposed=true;for(const controller of controllers.values())controller.abort()
    await Promise.allSettled([...jobs.values(),...commands.values()])
    for(const user of ctx.accounts.list())for(const run of recoveryRows(ctx.store,user.id,collection))if(run.status==='running')await update(user,run.id,'paused',r=>{r.status='paused';r.notice='Assistant reloaded. Resume your saved task when ready.'})
    await Promise.allSettled([...locks.values()]);jobs.clear();controllers.clear();locks.clear();commands.clear()
  }
  const chat = async (user,input) => {
    const {run}=await start(user,input); await jobs.get(run.id)
    const final=get(user,run.id)
    return {run:view(final),message:final.reply||null,actions:final.actions,toolResults:final.results}
  }
  return {start,control,chat,current:user=>view(current(user)),get:(user,id)=>view(get(user,id)),recover,dispose}
}
