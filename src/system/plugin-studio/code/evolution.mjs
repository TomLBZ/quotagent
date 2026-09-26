import {randomUUID} from 'node:crypto'
import {hash} from '../../installed-plugins/code/artifacts.mjs'
import {clean,copy,fail,now,parseDescriptor,descriptorOf,generationPrompt} from './descriptor.mjs'
import {compileUtility,runCompiled,normalizeInput} from './tool-runtime.mjs'
const uid=prefix=>`${prefix}-${randomUUID()}`
const same=(a,b)=>hash(a??null)===hash(b??null)
const number=(value,fallback,min,max)=>{const result=Number(value??fallback);if(!Number.isFinite(result)||result<min||result>max)fail(`Enter a number between ${min} and ${max}.`);return result}
export function descriptorDiff(before,after,path='') {
 const keys=new Set([...Object.keys(before||{}),...Object.keys(after||{})]),result=[]
 for(const key of keys){const a=before?.[key],b=after?.[key],field=path?`${path}.${key}`:key;if(same(a,b))continue;if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b))result.push(...descriptorDiff(a,b,field));else result.push({field,before:a??null,after:b??null})}
 return result
}
export function createEvolution(ctx,rt,{complete,alive}) {
 const list=(user,collection,id)=>ctx.store.list(user.id,collection).filter(row=>!id||row.pluginId===id)
 const save=(user,collection,record,event)=>ctx.store.put(user.id,collection,record,{actor:user.id,event})
 const manage=(user,id)=>{rt.history(user,id);return rt.lookup(id)}
 const get=(user,collection,id)=>{const row=ctx.store.get(user.id,collection,id);if(!row)fail('This evolution record does not belong to this account.',404);manage(user,row.pluginId);return row}
 const feedbackRecord=(user,id)=>get(user,'studio-feedback',id)
 const proposalRecord=(user,id)=>get(user,'studio-proposals',id)
 const cases=(user,id)=>list(user,'studio-cases',id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
 const reports=(user,id)=>list(user,'studio-shadow-reports',id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
 const review=(user,report)=>list(user,'studio-shadow-reviews',report.pluginId).filter(row=>row.reportId===report.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]||null
 const attempts=(user,feedback)=>list(user,'studio-attempts',feedback.pluginId).filter(row=>row.feedbackId===feedback.id)
 const failure=async(user,feedback,phase,message)=>{const row={id:uid('attempt'),pluginId:feedback.pluginId,feedbackId:feedback.id,phase,message:clean(message,2000),createdAt:now()};await save(user,'studio-attempts',row,'studio/proposal-attempt-failed');const failed=attempts(user,feedback).length-(feedback.reviewedFailureCount||0);await save(user,'studio-feedback',{...feedback,failedAttempts:attempts(user,feedback).length,status:failed>=3?'needs-human':'open',updatedAt:now()},'studio/feedback-updated')}
 const feedback=async(user,id,input={})=>{manage(user,id);const body=String(input.body??'');if(!body.trim())fail('Describe the improvement or problem.');if(body.length>12000)fail('Keep feedback within 12,000 characters.');const row={id:uid('feedback'),pluginId:id,body,bodyHash:hash(body),view:clean(input.view||'extensions',100),source:input.source?copy(input.source):{kind:'human-gui'},status:'open',failedAttempts:0,createdAt:now()};await save(user,'studio-feedback',row,'studio/feedback-recorded');return row}
 const retry=async(user,id,input={})=>{const row=feedbackRecord(user,id);const note=clean(input.note,2000);if(!note)fail('Record your review and the changed approach before retrying.');const next={...row,status:'open',humanReview:note,reviewedFailureCount:attempts(user,row).length,reviewedAt:now()};await save(user,'studio-feedback',next,'studio/feedback-human-reviewed');return next}
 const propose=async(user,id,input={})=>{
  const plugin=manage(user,id),feedbackItem=feedbackRecord(user,input.feedbackId);if(feedbackItem.pluginId!==id)fail('Choose feedback for this extension.');if(feedbackItem.status==='needs-human')fail('Three attempts failed. Review the feedback and record a changed approach before retrying.',409)
  const proposalId=uid('proposal'),baseline=rt.revision(user,id,plugin.revisionId)
  try{
   let answer=input.descriptor?{descriptor:input.descriptor,rationale:input.rationale,expectedEffect:input.expectedEffect,risks:input.risks,rollbackPlan:input.rollbackPlan}:null
   if(!answer){const response=await complete(user,{purpose:'plugin-revision-proposal',messages:[{role:'system',content:`${generationPrompt}\nThis time return {"descriptor": the full revised descriptor, "rationale":"why the change addresses feedback", "expectedEffect":{"metric":"accepted-case-rate","minimumDelta":0,"description":"concrete expected improvement"},"risks":["..."],"rollbackPlan":"restore the current immutable revision"}. Keep the kind unchanged. This is an inactive proposal; never claim it was deployed or tested.`},{role:'user',content:JSON.stringify({current:baseline.descriptor,feedback:feedbackItem.body,humanReview:feedbackItem.humanReview||null})}]});const text=String(response?.content??response).replace(/^\s*```(?:json)?/,'').replace(/```\s*$/,'');try{answer=JSON.parse(text)}catch{fail('The model returned an incomplete revision proposal. Please retry.',502)}}
   alive();const descriptor=parseDescriptor({content:JSON.stringify(answer.descriptor)}),diff=descriptorDiff(baseline.descriptor,descriptor);if(!diff.length)fail('The proposal does not change this extension. Refine the feedback.')
   const rationale=clean(answer.rationale||feedbackItem.body,3000),risks=Array.isArray(answer.risks)?answer.risks.map(item=>clean(item,1000)).filter(Boolean).slice(0,12):[clean(answer.risks||'This revision needs paired testing and a limited live trial.',1000)]
   const candidate=await rt.stage(user,id,descriptor,{baseRevisionId:baseline.id,proposalId,reason:`Feedback ${feedbackItem.id}: ${clean(feedbackItem.body,300)}`})
   const row={id:proposalId,pluginId:id,feedbackId:feedbackItem.id,baseRevisionId:baseline.id,candidateRevisionId:candidate.id,target:{layer:'plugin',instanceId:id,ownerId:plugin.ownerId,global:!!plugin.global},diff,rationale,expectedEffect:{metric:'accepted-case-rate',minimumDelta:number(answer.expectedEffect?.minimumDelta,0,0,1),description:clean(answer.expectedEffect?.description||'Resolve the recorded feedback without regressing retained examples.',2000)},risks,rollbackPlan:clean(answer.rollbackPlan||`Restore ${baseline.id}; existing account copies remain independent.`,2000),evidence:[{kind:'feedback',id:feedbackItem.id,hash:feedbackItem.bodyHash},{kind:'baseline',id:baseline.id,sourceHash:baseline.sourceHash}],status:'proposed',createdAt:now()}
   await save(user,'studio-proposals',row,'studio/proposal-recorded');await save(user,'studio-feedback',{...feedbackItem,status:'proposed',lastProposalId:row.id,updatedAt:now()},'studio/feedback-updated');return row
  }catch(error){await failure(user,feedbackItem,'proposal',error.message);throw error}
 }
 const addCase=async(user,id,input={})=>{
  const plugin=manage(user,id);if(cases(user,id).length>=100)fail('This extension already retains 100 cases. Create a separate test target for a new corpus; retained counterexamples cannot be deleted.')
  const title=clean(input.title,180);if(!title)fail('Name this example or counterexample.');let values=input.input??{};if(plugin.kind==='calculator'&&(!values||typeof values!=='object'||Array.isArray(values)))fail('Enter the tool inputs for this case.');if(plugin.kind==='skill')values={request:clean(values.request,12000)}
  let workspace=rt.workspace(user),origin=null
  if(input.eventId){const event=ctx.store.events(user.id).find(event=>event.id===input.eventId||event.event_id===input.eventId);if(!event||event.type!=='studio/tool-ran'||event.body.pluginId!==id||!event.body.workspace)fail('Choose a recorded execution with a frozen workspace.');values=event.body.input;workspace=event.body.workspace;origin={eventId:input.eventId,revisionId:event.body.revisionId}}
  const hasExpected=Object.hasOwn(input,'expected'),expectError=!!input.expectError
  const row={id:uid('case'),pluginId:id,title,input:copy(values),workspace:copy(workspace),workspaceHash:hash(workspace),counterexample:!!input.counterexample,hasExpected,expected:hasExpected?copy(input.expected):null,expectError,origin,createdAt:now()}
  await save(user,'studio-cases',row,'studio/shadow-case-recorded');return row
 }
 const invoke=async(user,descriptor,test,purpose)=>{
  const started=performance.now();let output=null,error=null,tokens=descriptor.kind==='skill'?null:0,deterministic=true
  try{if(descriptor.kind==='calculator'){const script=compileUtility(descriptor.spec.code),effectiveInput=normalizeInput(descriptor,test.input);output=runCompiled(script,effectiveInput,test.workspace);const repeated=runCompiled(script,effectiveInput,test.workspace);deterministic=same(output,repeated)}
   else if(descriptor.kind==='skill'){
    const response=await complete(user,{purpose,messages:[{role:'system',content:'This is a model-only shadow replay. Use only the recorded input below. There are no tools and no external actions. Return the requested analysis/draft, identify missing information, and do not claim any commitment occurred.'},{role:'user',content:JSON.stringify({workflow:descriptor.spec,testInput:test.input,workspace:test.workspace})}]});output=String(response?.content??response)
    const events=ctx.store.events(user.id),request=events.findLast(event=>event.type==='agent/model-requested'&&event.body?.purpose===purpose),receipt=events.findLast(event=>event.type==='agent/model-completed'&&event.body?.callId===request?.body?.callId),usage=receipt?.body?.response?.usage
    if(Number.isFinite(usage?.total_tokens))tokens=usage.total_tokens;else if(Number.isFinite(usage?.prompt_tokens)&&Number.isFinite(usage?.completion_tokens))tokens=usage.prompt_tokens+usage.completion_tokens
   }else output=copy(descriptor.spec)
  }catch(err){error=err.message}
  const expectedPass=test.expectError?!!error:test.hasExpected?!error&&same(output,test.expected):null
  return{output,error,durationMs:Math.round((performance.now()-started)*100)/100,tokens,deterministic,expectedPass}
 }
 const shadow=async(user,id,input={})=>{
  const proposal=proposalRecord(user,id),corpus=cases(user,proposal.pluginId);if(!corpus.length)fail('Add at least one frozen test case first.');if(!corpus.some(row=>row.counterexample))fail('Retain at least one counterexample representing the issue before testing.')
  if(corpus.length>20&&rt.lookup(proposal.pluginId).kind==='skill')fail('Model replay is limited to twenty retained cases per skill to keep the paired run bounded.')
  const baseline=rt.revision(user,proposal.pluginId,proposal.baseRevisionId),candidate=rt.revision(user,proposal.pluginId,proposal.candidateRevisionId),idReport=uid('shadow'),limits={maxLatencyMs:number(input.maxLatencyMs,baseline.descriptor.kind==='skill'?120000:1000,1,300000),maxTokens:number(input.maxTokens,baseline.descriptor.kind==='skill'?20000:0,0,2000000)}
  const started={id:idReport,pluginId:proposal.pluginId,proposalId:id,status:'running',kind:baseline.descriptor.kind,mode:baseline.descriptor.kind==='calculator'?'actual bounded utility execution':baseline.descriptor.kind==='skill'?'model-only prompt replay without tools':'paired visual specification preview',baselineRevisionId:baseline.id,candidateRevisionId:candidate.id,caseIds:corpus.map(row=>row.id),limits,createdAt:now()};await save(user,'studio-shadow-reports',started,'studio/shadow-started')
  const pairs=[]
  try{for(const test of corpus){alive();const before=await invoke(user,baseline.descriptor,test,`${idReport}:${test.id}:baseline`),after=await invoke(user,candidate.descriptor,test,`${idReport}:${test.id}:candidate`);pairs.push({caseId:test.id,title:test.title,counterexample:test.counterexample,workspaceHash:test.workspaceHash,input:test.input,baseline:before,candidate:after})}}catch(error){await save(user,'studio-shadow-reports',{...started,status:'interrupted',pairs,error:clean(error.message,2000),finishedAt:now()},'studio/shadow-interrupted');throw error}
  const artifactsValid=rt.verify(user,proposal.pluginId,baseline.id).ok&&rt.verify(user,proposal.pluginId,candidate.id).ok
  const report={...started,status:'awaiting-review',pairs,artifactsValid,finishedAt:now()};await save(user,'studio-shadow-reports',report,'studio/shadow-completed');return{...report,gates:gates(user,proposal,report,null)}
 }
 const gates=(user,proposal,report,assessment)=>{
  const pairs=report.pairs||[],reviews=assessment?.assessments||[],complete=pairs.length>0&&pairs.every(pair=>{const row=reviews.find(item=>item.caseId===pair.caseId);return row&&['baselineAccept','candidateAccept','baselineNeedsHuman','candidateNeedsHuman'].every(key=>typeof row[key]==='boolean')})
  const accepted=(pair,side)=>{const observed=pair[side];return observed.expectedPass===false?false:observed.expectedPass===true?true:!!reviews.find(row=>row.caseId===pair.caseId)?.[`${side}Accept`]}
  const baseRate=complete?pairs.filter(row=>accepted(row,'baseline')).length/pairs.length:null,candidateRate=complete?pairs.filter(row=>accepted(row,'candidate')).length/pairs.length:null
  const invariants=report.artifactsValid&&pairs.every(row=>row.baseline.deterministic&&row.candidate.deterministic)&&report.status!=='running'
  const counters=pairs.filter(row=>row.counterexample),totalTokens=pairs.reduce((sum,row)=>sum+(row.candidate.tokens||0),0),tokensMeasured=pairs.every(row=>row.candidate.tokens!==null),latency=Math.max(0,...pairs.map(row=>row.candidate.durationMs))
  const humanRate=side=>complete?reviews.filter(row=>row[`${side}NeedsHuman`]).length/pairs.length:null
  const status=value=>value===null?'unmeasured':value?'passed':'failed'
  const result=[{id:'quality',label:'Target quality does not regress',status:status(complete?candidateRate>=baseRate+proposal.expectedEffect.minimumDelta:null),detail:complete?`Accepted examples: ${baseRate*100}% → ${candidateRate*100}%; required gain ${proposal.expectedEffect.minimumDelta*100} points.`:'Classify both observed results for every case.'},
   {id:'invariants',label:'Supported capability invariants',status:status(invariants),detail:'Immutable artifacts, validated capability schema, isolated bounded execution and observed repeatability for utility replay. This does not rerun kernel or QEP verification.'},
   {id:'counterexamples',label:'Retained counterexamples pass',status:status(complete&&counters.length?counters.every(pair=>accepted(pair,'candidate')):null),detail:`${counters.length} retained counterexamples; expected assertions cannot be overridden by a human score.`},
   {id:'resources',label:'Measured resource budgets',status:status(tokensMeasured?totalTokens<=report.limits.maxTokens&&latency<=report.limits.maxLatencyMs:null),detail:`Candidate total tokens: ${tokensMeasured?totalTokens:'unavailable'} / ${report.limits.maxTokens}; maximum measured replay latency ${latency} ms / ${report.limits.maxLatencyMs} ms. No monetary cost estimate is inferred.`},
   {id:'intervention',label:'Human intervention does not increase',status:status(complete?humanRate('candidate')<=humanRate('baseline'):null),detail:complete?`Reviewed intervention rate: ${humanRate('baseline')*100}% → ${humanRate('candidate')*100}%.`:'Record whether each result would need human intervention.'}]
  return{allPassed:result.every(row=>row.status==='passed'),items:result}
 }
 const assess=async(user,id,input={})=>{
  const report=get(user,'studio-shadow-reports',id),proposal=proposalRecord(user,report.proposalId);if(!report.pairs?.length)fail('Wait for paired replay to finish.')
  const assessments=(input.assessments||[]).map(row=>({caseId:row.caseId,baselineAccept:row.baselineAccept,candidateAccept:row.candidateAccept,baselineNeedsHuman:row.baselineNeedsHuman,candidateNeedsHuman:row.candidateNeedsHuman}))
  if(assessments.length!==report.pairs.length||new Set(assessments.map(row=>row.caseId)).size!==assessments.length||report.pairs.some(pair=>!assessments.some(row=>row.caseId===pair.caseId)))fail('Review every paired case exactly once.')
  for(const row of assessments)if(['baselineAccept','candidateAccept','baselineNeedsHuman','candidateNeedsHuman'].some(key=>typeof row[key]!=='boolean'))fail('Choose a result and intervention classification for every side.')
  const row={id:uid('review'),reportId:id,pluginId:report.pluginId,proposalId:proposal.id,assessments,note:clean(input.note,2000),createdAt:now()};row.gates=gates(user,proposal,report,row);await save(user,'studio-shadow-reviews',row,'studio/shadow-reviewed')
  if(!row.gates.allPassed)await failure(user,feedbackRecord(user,proposal.feedbackId),'shadow',row.gates.items.filter(item=>item.status!=='passed').map(item=>item.label).join('; '))
  return row
 }
 const passing=(user,proposal)=>{const report=reports(user,proposal.pluginId).find(row=>row.proposalId===proposal.id&&row.status==='awaiting-review'),assessment=report&&review(user,report);if(!assessment||!gates(user,proposal,report,assessment).allPassed)fail('Complete all five paired evaluation checks before a live trial or deployment.',409);if(!same(report.caseIds,cases(user,proposal.pluginId).map(row=>row.id)))fail('Retained cases changed. Rerun paired evaluation before continuing.',409);if(rt.lookup(proposal.pluginId).revisionId!==proposal.baseRevisionId)fail('The live baseline changed. Create a new proposal against the current revision.',409);return{report,assessment}}
 const startTrial=async(user,id,input={})=>{const proposal=proposalRecord(user,id);passing(user,proposal);return rt.startTrial(user,proposal.pluginId,proposal.candidateRevisionId,{...input,proposalId:id})}
 const deploy=async(user,id)=>{const proposal=proposalRecord(user,id),proof=passing(user,proposal),trial=rt.trials(user,proposal.pluginId).find(row=>row.proposalId===id&&row.status==='rolled-back'&&row.rollbackVerified&&row.outcome==='observed'&&row.observations.length&&!row.observations.some(item=>item.outcome==='fail'));if(!trial)fail('Complete an observed trial and verify restoration of the baseline before making this revision current.',409);const result=await rt.restore(user,proposal.pluginId,proposal.candidateRevisionId,{reason:`Human approved proposal ${id} after ${proof.report.id} and rollback ${trial.id}`});await save(user,'studio-proposals',{...proposal,status:'activated',activatedAt:now(),reportId:proof.report.id,trialId:trial.id},'studio/proposal-activated');const fb=feedbackRecord(user,proposal.feedbackId);await save(user,'studio-feedback',{...fb,status:'resolved',resolvedAt:now()},'studio/feedback-resolved');return result}
 const detail=(user,id)=>{
  const history=rt.history(user,id),proposals=list(user,'studio-proposals',id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),allReports=reports(user,id).map(report=>{const proposal=proposals.find(row=>row.id===report.proposalId),assessment=review(user,report);return{...report,review:assessment,gates:proposal?gates(user,proposal,report,assessment):null}})
  return{...history,feedback:list(user,'studio-feedback',id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),proposals,cases:cases(user,id),reports:allReports,trials:rt.trials(user,id),attempts:list(user,'studio-attempts',id),cohortAccounts:history.plugin.global&&user.role==='admin'?ctx.accounts.list().map(({id,name,role})=>({id,name,role})):[{id:user.id,name:user.name||user.id,role:user.role}]}
 }
 const summary=user=>{
  const groups={feedback:'studio-feedback',proposals:'studio-proposals',cases:'studio-cases',reports:'studio-shadow-reports',attempts:'studio-attempts'},counts={},recent=[]
  for(const[kind,collection]of Object.entries(groups)){const rows=list(user,collection);counts[kind]=rows.length;for(const row of rows)recent.push({id:row.id,kind,pluginId:row.pluginId,status:row.status||null,createdAt:row.createdAt})}
  const assessments=list(user,'studio-shadow-reviews');counts.shadowPasses=assessments.filter(row=>row.gates.allPassed).length;counts.shadowFailures=assessments.filter(row=>!row.gates.allPassed).length;counts.activations=list(user,'studio-proposals').filter(row=>row.status==='activated').length
  const trials=ctx.store.list('system','studio-canaries').filter(row=>row.ownerId===user.id||row.startedBy===user.id);counts.trials=trials.length;counts.activeTrials=trials.filter(row=>row.status==='active').length;counts.rollbacks=trials.filter(row=>row.rollbackVerified).length
  for(const row of trials)recent.push({id:row.id,kind:'trial',pluginId:row.pluginId,status:row.status,createdAt:row.startedAt,finishedAt:row.finishedAt||null,observations:row.observationCount||0,rollbackVerified:!!row.rollbackVerified})
  return{counts,recent:recent.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)).slice(0,20),recentLimit:20,totalRecent:recent.length,truncated:Math.max(0,recent.length-20)}
 }

 return{feedback,retry,propose,addCase,shadow,assess,startTrial,deploy,detail,summary}
}
