// Focused state-machine checks use a controlled model; public browser evidence uses the real provider.
import assert from 'node:assert/strict'
import {createWorkflows,normalizePlan} from '../code/engine.mjs'
import {createMemory} from '../code/memory.mjs'
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const wait=async(predicate,label)=>{for(let i=0;i<300;i++){if(predicate())return;await sleep(5)}throw new Error('Timed out: '+label)}
const records=new Map(),events=[],proposals=[],executors=new Map(),disposers=[],inputs=[]
const user={id:'account-one',role:'contractor'},other={id:'account-two',role:'supplier'}
const table=(realm,collection)=>{const key=realm+':'+collection;if(!records.has(key))records.set(key,new Map());return records.get(key)}
const store={list:(realm,collection)=>structuredClone([...table(realm,collection).values()]),get:(realm,collection,id)=>structuredClone(table(realm,collection).get(id)),put:async(realm,collection,record,options)=>{table(realm,collection).set(record.id,structuredClone(record));events.push({realm,collection,record:structuredClone(record),options});return record}}
const plan={title:'Compare the quotation',summary:'Check complete scope and commercial terms independently.',steps:[{id:'scope',title:'Check scope',role:'Scope analyst',task:'Read the scope and ask for the required delivery date.',dependsOn:[]},{id:'terms',title:'Check terms',role:'Commercial analyst',task:'Check supplied payment terms.',dependsOn:[]}]}
let mode='normal',maxParallel=0,inflight=0
const ctx={store,accounts:{can:()=>true,list:()=>[user,other],get:id=>({id,preferences:{legacyDelivery:'Ask before assuming delivery'}})},settings:{get:()=>({reviewPlan:true,parallelism:3})},effect:fn=>disposers.push(fn()),actions:{register:definition=>{executors.set(definition.kind,definition);return()=>executors.delete(definition.kind)},propose:async(u,input)=>{const proposal={id:'proposal-'+proposals.length,ownerId:u.id,status:'pending',...input};proposals.push(proposal);return proposal}},assistant:{definitions:()=>[{type:'function',function:{name:'procurement_workspace',parameters:{type:'object',properties:{}}}}],invoke:async(u,request)=>({rfqs:[{id:'rfq-one',title:'Cabling RFQ'}],trust:'account-data'})},ai:{complete:async(u,request)=>{
 inputs.push(structuredClone({...request,signal:undefined}))
 if(request.purpose.endsWith(':planner'))return {role:'assistant',content:JSON.stringify(plan)}
 if(request.purpose.endsWith(':synthesis'))return {role:'assistant',content:'Scope and commercial findings, based on the human delivery date.'}
 inflight++;maxParallel=Math.max(maxParallel,inflight)
 try{
  if(mode==='blocked')await new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true})})
  await sleep(25)
  if(request.purpose.includes(':scope:')&&!request.messages.some(message=>message.content?.includes('HUMAN ANSWER / FEEDBACK:')))
   return {role:'assistant',content:null,tool_calls:[{id:'question-call',type:'function',function:{name:'ask_workflow_human',arguments:JSON.stringify({question:'What delivery date should we use?',reason:'No required date is in the source.'})}}]}
  return {role:'assistant',content:request.purpose.includes(':scope:')?'The human confirmed October 15; scope references rfq-one.':'Payment terms are net 30; no offer has been accepted.'}
 }finally{inflight--}
}}}
const memory=createMemory(ctx),engine=createWorkflows(ctx,{memory})
await memory.importLegacy(user);const legacy=memory.list(user)[0];assert.equal(legacy.source.kind,'legacy-preference');await memory.importLegacy(user);assert.equal(memory.list(user).length,1);await memory.remove(user,legacy.id);await memory.importLegacy(user);assert.equal(memory.list(user).length,0,'Archived legacy preferences cannot resurrect');assert.equal(memory.list(user,{archived:true}).length,1)
const suggested=await memory.suggest(user,{key:'Payment terms',value:'Prefer net 30',source:{kind:'assistant',reference:'Explicit human request'}})
assert.equal(memory.context(user).length,0,'Unapproved model memory must not enter context')
assert.equal(suggested.action.input.view,'approvals')
await executors.get('memory.save').execute(user,suggested.proposal.input,suggested.proposal)
assert.equal(memory.context(user)[0].source.approvalId,suggested.proposal.id)
assert.equal(memory.context(other).length,0)
const saved=memory.list(user)[0];await memory.put(user,{id:saved.id,key:saved.key,value:'Net 30, flag prepayment',source:{kind:'human'}})
assert.equal(memory.list(user)[0].history[0].value,'Prefer net 30')
const run=await engine.start(user,{objective:'Compare Cabling RFQ and ask me for the missing delivery date.'})
await wait(()=>engine.get(user,run.id).status==='awaiting-plan','plan checkpoint')
assert.equal(inputs.filter(input=>input.purpose.endsWith(':agent')).length,0,'Workers must not start before approval')
await engine.control(user,run.id,{action:'resume',text:'Prioritize complete scope.'})
await wait(()=>engine.get(user,run.id).status==='waiting-input','human question')
assert.equal(maxParallel,2,'Independent agents must overlap in execution')
assert.equal(engine.get(user,run.id).question.text,'What delivery date should we use?')
await sleep(40)
await engine.control(user,run.id,{action:'answer',text:'Use October 15 as the required date.'})
await wait(()=>engine.get(user,run.id).status==='completed','synthesis')
const finished=engine.get(user,run.id)
assert.equal(new Set(finished.steps.map(step=>step.agentId)).size,2)
assert.ok(finished.traces.some(trace=>trace.event==='human-answered'))
assert.ok(inputs.some(input=>input.messages.some(message=>message.content?.includes('Net 30, flag prepayment'))),'Reviewed memory must enter actual provider input')
assert.ok(inputs.filter(input=>input.purpose.includes(':terms:')).every(input=>!input.messages.some(message=>message.role==='assistant'&&message.content?.includes('Scope references'))),'Independent agents do not share their conversations')
assert.throws(()=>engine.get(other,run.id),/not found/)
await memory.remove(user,saved.id);assert.equal(memory.context(user).length,0);assert.equal(memory.list(user,{archived:true}).length,2)
mode='blocked';const cancelled=await engine.start(user,{objective:'Pause while agents work',checkpoint:false});await wait(()=>engine.get(user,cancelled.id).steps.some(step=>step.status==='running'),'running agents');await engine.control(user,cancelled.id,{action:'cancel'});await sleep(30);assert.equal(engine.get(user,cancelled.id).status,'cancelled');assert.equal(engine.get(user,cancelled.id).result,undefined)
const interrupted=await engine.start(user,{objective:'Recover unfinished work',checkpoint:false});await wait(()=>engine.get(user,interrupted.id).steps.some(step=>step.status==='running'),'interrupted run');await engine.dispose();assert.equal(engine.get(user,interrupted.id).status,'paused')
const recovered=createWorkflows(ctx,{memory});await recovered.recover();assert.equal(recovered.get(user,interrupted.id).status,'paused');assert.equal(recovered.get(user,interrupted.id).steps.some(step=>step.status==='running'),false)
assert.throws(()=>normalizePlan({steps:[{id:'a',title:'A',role:'A',task:'A',dependsOn:['b']},{id:'b',title:'B',role:'B',task:'B',dependsOn:['a']}]}),/circular/)
await recovered.dispose();for(const dispose of disposers)dispose?.()
console.log(JSON.stringify({ok:true,checks:['Legacy preference migration is idempotent and preserves archive tombstones','Memory requires explicit approval and preserves provenance/history','Account isolation and archived memory exclusion','Human plan and question checkpoints','Independent agents overlap in separate contexts','Human feedback and reviewed memory enter model inputs','Cancellation prevents completion; unload retains recoverable task state','Invalid task dependencies rejected'],maxParallel,modelCalls:inputs.length,ledgerRecords:events.length},null,2))
