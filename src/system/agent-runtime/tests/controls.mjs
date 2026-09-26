import assert from 'node:assert/strict'
import { createConversations } from '../code/conversations.mjs'
const user={id:'buyer',role:'contractor'},other={id:'supplier',role:'supplier'}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
const until=async test=>{for(let i=0;i<200;i++){if(test())return;await sleep(5)}throw new Error('Checkpoint was not reached')}
const never=signal=>new Promise((_,reject)=>{if(signal.aborted)reject(new Error('Aborted'));else signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true})})
const answer=content=>({role:'assistant',content})
const toolResponse={role:'assistant',content:null,tool_calls:[1,2].map(n=>({id:`call-${n}`,type:'function',function:{name:'draft',arguments:JSON.stringify({number:n})}}))}
function harness({model,tool,gate}={}){
  const records=new Map(),events=[],calls=[],executions=[]
  const table=(realm,collection)=>{const key=realm+':'+collection;if(!records.has(key))records.set(key,new Map());return records.get(key)}
  const store={list:(realm,collection)=>structuredClone([...table(realm,collection).values()]),get:(realm,collection,id)=>structuredClone(table(realm,collection).get(id)),events:realm=>structuredClone(events.filter(event=>event.realm===realm)),put:async(realm,collection,record,options={})=>{
    await gate?.(collection,record,options)
    table(realm,collection).set(record.id,structuredClone(record));events.push({realm,type:options.event,body:{collection,record:structuredClone(record)}})
  }}
  const ctx={store,accounts:{list:()=>[user,other],can:()=>true},ai:{complete:async(who,request)=>{calls.push({who:who.id,workspaceOwnerId:who.workspaceOwnerId,...request});return model?model(request,calls.length):answer('Done')}}}
  const hooks={prepare:async(_,{message})=>({wire:[{role:'user',content:message}]}),definitions:()=>[],status:()=>({model:'fixture'}),invoke:async(who,request)=>{executions.push({...request,workspaceOwnerId:who.workspaceOwnerId});return tool?tool(request):{ok:true,summary:'Draft saved'}}}
  const engine=createConversations(ctx,hooks)
  return {engine,ctx,hooks,store,records,events,calls,executions}
}
const checks=[]
{
  const h=harness({model:(req,n)=>n===1?never(req.signal):answer('Followed guidance')})
  const {run}=await h.engine.start(user,{message:'Compare my offers'})
  await until(()=>h.calls.length===1)
  assert.throws(()=>h.engine.control(other,run.id,{action:'stop'}),/not available/)
  assert.equal(h.calls[0].signal.aborted,false,'A different account cannot abort the provider request')
  await h.engine.control(user,run.id,{action:'resume'})
  assert.equal(h.calls.length,1,'Resume on a running task must be idempotent')
  await h.engine.control(user,run.id,{action:'pause'})
  assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.engine.get(user,run.id).status,'paused')
  await h.engine.control(user,run.id,{action:'steer',message:'Focus on lead times'})
  assert.equal(h.calls.length,1);assert.equal(h.engine.get(user,run.id).status,'paused')
  await h.engine.control(user,run.id,{action:'resume'})
  await until(()=>h.engine.get(user,run.id).status==='completed')
  assert.ok(h.calls[1].messages.some(message=>message.content==='Focus on lead times'))
  assert.equal(h.store.list(user.id,'chat').length,3)
  assert.throws(()=>h.engine.get(other,run.id),/not available/)
  assert.equal(JSON.stringify(h.engine.get(user,run.id)).includes('"wire"'),false)
  await h.engine.dispose();checks.push('Pause aborts the provider; durable paused guidance is consumed only after Resume; views are account scoped')
}
{
  const toolEntered=deferred(),release=deferred(),h=harness({model:(_,n)=>n===1?toolResponse:answer('Two drafts saved'),tool:async request=>{if(request.arguments.number===1){toolEntered.resolve();await release.promise}return {ok:true,number:request.arguments.number}}})
  const {run}=await h.engine.start(user,{message:'Prepare two drafts'});await toolEntered.promise
  const pausing=h.engine.control(user,run.id,{action:'pause'})
  await until(()=>h.engine.get(user,run.id).status==='paused');release.resolve();await pausing
  assert.equal(h.executions.length,1);assert.equal(h.engine.get(user,run.id).results.length,1)
  await h.engine.control(user,run.id,{action:'resume'});await until(()=>h.engine.get(user,run.id).status==='completed')
  assert.deepEqual(h.executions.map(call=>call.arguments.number),[1,2])
  await h.engine.dispose();checks.push('In-flight tool receipt survives Pause; Resume executes only the remaining tool')
}
{
  const entered=deferred(),release=deferred();let gated=false
  const h=harness({model:(req,n)=>n===1?never(req.signal):answer('Unexpected'),gate:async(collection,record,options)=>{if(!gated&&collection==='assistant-runs'&&options.event==='assistant/paused'){gated=true;entered.resolve();await release.promise}}})
  const {run}=await h.engine.start(user,{message:'Wait for instructions'});await until(()=>h.calls.length===1)
  const stopping=h.engine.control(user,run.id,{action:'stop'});await entered.promise;await sleep(20);release.resolve();await stopping
  assert.equal(h.engine.get(user,run.id).status,'stopped');assert.equal(h.calls.length,1)
  await assert.rejects(()=>h.engine.control(user,run.id,{action:'resume'}),/finished/)
  const next=await h.engine.start(user,{message:'New task'});await until(()=>h.engine.get(user,next.run.id).status==='completed')
  await h.engine.dispose();checks.push('Delayed stop writes cannot relaunch work; Stop is terminal and new tasks remain usable')
}
{
  const h=harness({model:(request,n)=>n===1?never(request.signal):answer('Revised direction')})
  const {run}=await h.engine.start(user,{message:'Inspect prices'});await until(()=>h.calls.length===1)
  await h.engine.control(user,run.id,{action:'steer',message:'Compare delivery instead'})
  await until(()=>h.engine.get(user,run.id).status==='completed')
  assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.calls[1].messages.at(-1).content,'Compare delivery instead')
  await h.engine.dispose();checks.push('Guidance while working aborts obsolete reasoning and automatically continues with the new direction')
}
{
  const h=harness(),id='interrupted',createdAt=new Date().toISOString()
  await h.store.put(user.id,'assistant-runs',{id,ownerId:user.id,accountRole:user.role,status:'running',phase:'tools',createdAt,message:'Draft',wire:[toolResponse],turnWire:[toolResponse],pendingTools:toolResponse.tool_calls,toolIndex:0,executingTool:{id:'call-1',name:'draft'},results:[],actions:[],modelSteps:1,revision:1})
  await h.engine.recover();assert.equal(h.engine.get(user,id).status,'paused');assert.equal(h.engine.get(user,id).results[0].result.uncertain,true)
  await h.engine.control(user,id,{action:'resume'});await until(()=>h.engine.get(user,id).status==='completed')
  assert.deepEqual(h.executions.map(call=>call.arguments.number),[2])
  await h.engine.dispose();checks.push('Restart never repeats an uncertain tool; its explicit unknown result is retained before remaining work resumes')
}
{
  const h=harness({model:req=>never(req.signal)})
  const {run}=await h.engine.start(user,{message:'Long task'});await until(()=>h.calls.length===1);await h.engine.dispose()
  assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.engine.get(user,run.id).status,'paused')
  await assert.rejects(()=>h.engine.start(user,{message:'Too late'}),/reloading/)
  checks.push('Disposal aborts active requests, settles jobs and preserves a paused restart checkpoint')
}
{
  let selected='first-team'
  const h=harness({model:(request,n)=>n===1?never(request.signal):n===2?toolResponse:answer('Scoped task completed')})
  h.hooks.prepare=async(_,{message})=>({workspaceOwnerId:selected,workspaceName:'First Team',wire:[{role:'user',content:message}]})
  const {run}=await h.engine.start(user,{message:'Prepare drafts in this team'})
  await until(()=>h.calls.length===1)
  await h.engine.control(user,run.id,{action:'pause'});selected='other-team'
  await h.engine.control(user,run.id,{action:'resume'})
  await until(()=>h.engine.get(user,run.id).status==='completed')
  assert(h.calls.every(call=>call.workspaceOwnerId==='first-team'))
  assert(h.executions.every(call=>call.workspaceOwnerId==='first-team'))
  assert.equal(h.store.list(user.id,'agent-turns')[0].workspaceOwnerId,'first-team')
  await h.engine.dispose();checks.push('Team scope is captured durably; switching selected workspace while paused never retargets model/tool work or conversation history')
}
{
  let role='contractor'
  const h=harness({model:(request,n)=>n===1?never(request.signal):answer('New perspective')})
  h.ctx.accounts.get=id=>({id,role})
  const {run}=await h.engine.start(user,{message:'Buyer perspective'})
  await until(()=>h.calls.length===1);await h.engine.control(user,run.id,{action:'pause'});role='supplier'
  await assert.rejects(()=>h.engine.control(user,run.id,{action:'resume'}),error=>error.code==='account-role-changed')
  await assert.rejects(()=>h.engine.control(user,run.id,{action:'steer',message:'Reuse this buyer context'}),error=>error.code==='account-role-changed')
  assert.equal(h.calls.length,1);await h.engine.control(user,run.id,{action:'stop'})
  const next=await h.engine.start(user,{message:'New supplier task'});await until(()=>h.engine.get(user,next.run.id).status==='completed');assert.equal(h.engine.get(user,next.run.id).accountRole,'supplier')
  assert.equal(h.store.list(user.id,'agent-turns')[0].accountRole,'contractor');assert.equal(h.store.list(user.id,'agent-turns')[1].accountRole,'supplier')
  await h.engine.dispose();checks.push('Role changes reject Resume and guidance without model/tool dispatch; Stop remains available and new task captures current perspective')
}
console.log(JSON.stringify({ok:true,checks},null,2))
