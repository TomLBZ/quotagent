// Reproduce disk-write latency at cancellation and at the next specialist's start.
// These deterministic barriers exercise ordering; no model output is presented as real-provider evidence.
import assert from 'node:assert/strict'
const {createWorkflows}=await import(process.env.ENGINE_UNDER_TEST||'../code/engine.mjs')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
const until=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await sleep(5)}throw new Error('State barrier was not reached')}
const user={id:'cancellation-test',role:'supplier'}
function harness({blockWorkers=true,gateRecord}={}){
 const records=new Map(),events=[],calls=[],entered=deferred(),release=deferred();let gated=false
 const table=collection=>{if(!records.has(collection))records.set(collection,new Map());return records.get(collection)}
 const store={list:(_,collection)=>structuredClone([...table(collection).values()]),get:(_,collection,id)=>structuredClone(table(collection).get(id)),put:async(_,collection,record,options)=>{
  if(!gated&&collection==='workflow-runs'&&gateRecord?.(record)){gated=true;entered.resolve(record);await release.promise}
  table(collection).set(record.id,structuredClone(record));events.push({collection,record:structuredClone(record),options});return record
 }}
 const steps=['scope','commercial','schedule','integrity'].map(id=>({id,title:id,role:id+' specialist',task:'Read source evidence',dependsOn:[]}))
 const ctx={store,accounts:{can:()=>true,list:()=>[user]},settings:{get:()=>({reviewPlan:false,parallelism:3})},assistant:{definitions:()=>[],invoke:()=>({})},ai:{complete:async(_,request)=>{
  calls.push(request.purpose)
  if(request.purpose.endsWith(':planner'))return {role:'assistant',content:JSON.stringify({title:'Four specialists',summary:'Inspect independently',steps})}
  if(request.purpose.endsWith(':synthesis'))return {role:'assistant',content:'Completed summary'}
  if(blockWorkers)await new Promise((_,reject)=>{if(request.signal.aborted)reject(new Error('Cancelled'));else request.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true})})
  return {role:'assistant',content:'Verified bounded findings'}
 }}}
 const engine=createWorkflows(ctx,{memory:{context:()=>[]}})
 return {engine,store,records,events,calls,entered,release}
}
const checks=[]
// The old job's finally handler runs while the cancelled write is still waiting on storage.
{
 const h=harness({gateRecord:record=>record.status==='cancelled'}),run=await h.engine.start(user,{objective:'Inspect the account',checkpoint:false})
 await until(()=>h.calls.filter(purpose=>purpose.endsWith(':agent')).length===3)
 const cancelling=h.engine.control(user,run.id,{action:'cancel'});await h.entered.promise;await sleep(30)
 h.release.resolve();await cancelling;await sleep(30)
 const final=h.engine.get(user,run.id),cancelIndex=final.traces.findIndex(trace=>trace.event==='cancelled')
 assert.equal(final.status,'cancelled')
 assert.ok(final.steps.every(step=>step.status==='cancelled'),'A cancelled run cannot retain or acquire a working task')
 assert.equal(h.calls.filter(purpose=>purpose.endsWith(':agent')).length,3,'Abort completion must not launch another worker before cancellation is durable')
 assert.equal(final.traces.slice(cancelIndex+1).some(trace=>trace.event==='agent-started'),false,'No worker may start after the human cancellation event')
 await assert.rejects(()=>h.engine.control(user,run.id,{action:'resume'}),/already finished/)
 await h.engine.dispose();checks.push('Delayed cancellation write cannot relaunch the aborted job or leave any worker active')
}
// Cancellation arrives after independent workers finish while the next queued worker's state write is in flight.
{
 const h=harness({blockWorkers:false,gateRecord:record=>record.steps?.find(step=>step.id==='integrity')?.status==='running'}),run=await h.engine.start(user,{objective:'Inspect the account',checkpoint:false})
 await h.entered.promise;const cancelling=h.engine.control(user,run.id,{action:'cancel'});await sleep(10);h.release.resolve();await cancelling;await sleep(20)
 const final=h.engine.get(user,run.id)
 assert.deepEqual(final.steps.map(step=>step.status),['completed','completed','completed','cancelled'])
 assert.equal(h.calls.some(purpose=>purpose.includes(':integrity:')),false,'Cancelled queued worker must not call the provider')
 assert.equal(final.traces.some(trace=>trace.event==='agent-started'&&trace.stepId==='integrity'),false,'Aborted start transition must not claim the next worker started')
 await h.engine.dispose();checks.push('Cancellation at the next-worker transition retains completed reports and prevents provider execution')
}
// Historical stale task states are corrected with an appended event, not by editing the old record history.
{
 const h=harness(),old={id:'previously-cancelled',ownerId:user.id,status:'cancelled',revision:5,createdAt:new Date().toISOString(),steps:[{id:'complete',status:'completed',output:'Saved report'},{id:'stale',status:'running'}]}
 await h.store.put(user.id,'workflow-runs',old,{event:'fixture'});await h.engine.recover();const restored=h.engine.get(user,old.id)
 assert.equal(restored.status,'cancelled');assert.deepEqual(restored.steps.map(step=>step.status),['completed','cancelled']);assert.equal(restored.revision,6)
 assert.ok(restored.traces.some(trace=>trace.event==='cancellation-reconciled'));assert.equal(h.calls.length,0)
 await h.engine.dispose();checks.push('Startup reconciles historical cancelled task states without replaying work or losing reports')
}
console.log(JSON.stringify({ok:true,checks},null,2))
