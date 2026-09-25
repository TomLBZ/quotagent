// Read-only extraction of the durable evidence behind a GUI workroom run.
import {readFileSync,writeFileSync} from 'node:fs'
const [ledgerFile,reportFile]=process.argv.slice(2)
if(!ledgerFile||!reportFile)throw new Error('Usage: node ledger-evidence.mjs <account-ledger.jsonl> <browser-report.json>')
const report=JSON.parse(readFileSync(reportFile,'utf8')),rows=readFileSync(ledgerFile,'utf8').trim().split('\n').map(line=>JSON.parse(line))
const runId=report.runId||report.run?.id
const calls=rows.filter(row=>row.type==='agent/model-requested'&&row.body.purpose?.startsWith(`workflow:${runId}:`))
const callIds=new Set(calls.map(row=>row.body.callId)),replies=rows.filter(row=>row.type==='agent/model-completed'&&callIds.has(row.body.callId)),failures=rows.filter(row=>row.type==='agent/model-failed'&&callIds.has(row.body.callId))
const state=rows.filter(row=>row.body.collection==='workflow-runs'&&row.body.record.id===runId).at(-1)?.body.record
const traces=rows.filter(row=>row.body.collection==='workflow-traces'&&row.body.record.runId===runId)
if(!state||!calls.length||!replies.length)throw new Error('Missing durable run or actual provider events')
const stages=Object.fromEntries([...new Set(calls.map(row=>row.body.purpose.split(':').slice(2).join(':')))].map(stage=>[stage,calls.filter(row=>row.body.purpose.split(':').slice(2).join(':')===stage).length]))
const check=(ok,message)=>{if(!ok)throw new Error(message)}
check(state.status==='completed','Run must have a persisted completed state')
check(new Set(state.steps.map(step=>step.agentId)).size===state.steps.length,'Workers need distinct identities')
check(traces.some(row=>row.body.record.event==='human-answered'),'Missing persisted human answer')
check(calls.some(row=>row.body.request.messages.some(message=>message.content?.includes('15 October 2026'))),'Human answer missing from provider requests')
check(calls.some(row=>row.body.request.messages.some(message=>message.content?.includes(report.memoryName))),'Reviewed memory missing from provider requests')
const actions=rows.filter(row=>row.body.record?.runId===runId&&row.body.collection==='review-actions')
const proof={ok:true,ledger:ledgerFile,runId,ownerId:state.ownerId,status:state.status,steps:state.steps.map(({id,title,role,agentId,status,startedAt,completedAt})=>({id,title,role,agentId,status,startedAt,completedAt})),providerRequests:calls.length,providerReplies:replies.length,providerFailures:failures.map(row=>({seq:row.seq,error:row.body.error})),models:[...new Set(calls.map(row=>row.body.request.model))],stages,traceCount:traces.length,traceEvents:[...new Set(traces.map(row=>row.body.record.event))],toolNames:[...new Set(traces.filter(row=>row.body.record.event==='tool-result').map(row=>row.body.record.details.tool))],memoryVisibleToModel:true,humanAnswerVisibleToModel:true,externalActions:actions.map(row=>({id:row.body.record.id,kind:row.body.record.kind,status:row.body.record.status})),ledgerSequence:{first:calls[0].seq,last:rows.filter(row=>row.body.record?.id===runId).at(-1)?.seq},recordedAt:new Date().toISOString()}
const target=reportFile.replace(/[^/]+$/,'ledger-proof.json');writeFileSync(target,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2))
