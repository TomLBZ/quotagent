import fs from 'node:fs'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const base='tmp/jev-2026-09-28/independent/',out=base+'retained/'
const parse=path=>JSON.parse(fs.readFileSync(base+path)),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
fs.mkdirSync(out+'recheck',{recursive:true})
const old=parse('11-assistant-result.json'),fresh=parse('recheck/11-assistant-result.json')
const assessment=x=>x.state.run.results.find(row=>row.name==='assess_quotation').result.data
const earlier=assessment(old),latest=assessment(fresh),legacy=parse('recheck/15-legacy-record.json')
assert.equal(parse('10-assistant-prompt.json').prompt,parse('recheck/10-assistant-prompt.json').prompt)
assert.deepEqual(Object.keys(latest.state).sort(),['claims','text'])
assert.deepEqual(latest.state.text,earlier.state.text);assert.deepEqual(latest.state.claims,earlier.state.claims)
assert.deepEqual(Object.values(latest.answers).map(a=>a.choice),['supported','contradicted','unknown'])
assert.equal(latest.requiresReview,true)
for(const key of ['id','state','questions','answers','review','reviews','createdAt','finishedAt','requestSha256','callId','requiresReview','uncertainties'])assert.deepEqual(legacy[key],earlier[key],`Legacy ${key} changed`)
const copies=['assessment.md','replay.mjs','retain.mjs','01-current-context.json','02-existing-shortlist.json','02-existing-shortlist.png','02-existing-shortlist.txt','03-independent-claims.json','03-independent-claims.png','04-claims-source-probabilities.png','05-private-review-reloaded.png','06-supplier-context.json','07-supplier-review.json','07-supplier-review.png','09-supplier-open-quote.png','10-assistant-prompt.json','12-assistant-completed-link.png','13-assistant-saved-assessment.png','recheck/10-assistant-prompt.json','recheck/13-assistant-saved-assessment.png','recheck/14-assistant-exact-source.png','recheck/15-legacy-record.json','recheck/15-legacy-scope-warning.png']
for(const path of copies)fs.copyFileSync(base+path,out+path)
for(const [path,x,release]of [['11-assistant-result.json',old,'19683f182a49270b5fa0de7df7dfee38db77ae3f'],['recheck/11-assistant-result.json',fresh,'c737f100a7dbdb063dd5d288e726f4467424e0a5']]){
 const bytes=fs.readFileSync(base+path),run=x.state.run,last=x.state.messages.at(-1)
 const focused={scope:'Extracted current assistant turn and complete Jev tool result only. Earlier chat history and the unrelated full procurement snapshot omitted; original raw file retained unchanged in ignored tmp.',source:path,sourceSha256:hash(bytes),release,elapsedMs:x.elapsedMs,run:{id:run.id,status:run.status,message:run.message,createdAt:run.createdAt,finishedAt:run.finishedAt},tools:run.results.map(r=>r.name==='assess_quotation'?r:{name:r.name,callId:r.callId,resultOmitted:'Unrelated complete workspace snapshot; actual tool name retained.'}),assistant:last}
 delete focused.assistant.tools
 fs.writeFileSync(out+path,JSON.stringify(focused,null,2))
}
const summary={at:new Date().toISOString(),scope:'Independent public GUI evaluation, not a human study',revisions:{initial:'19683f182a49270b5fa0de7df7dfee38db77ae3f',recheck:'c737f100a7dbdb063dd5d288e726f4467424e0a5'},ownJevCalls:4,ownAssistantTasks:2,checks:{originalAndRecheckPromptsExactlyEqual:true,sourceTextAndClaimsExactlyEqual:true,correctedStateOnlyTextAndClaims:true,correctedTypedClaims:['supported','contradicted','unknown'],missingEvidenceRequiresReview:true,originalStoredEvidenceAndResultUnchanged:true,savedLinkOpened:true,legacyScopeWarningVisible:true},initialAssessmentId:earlier.id,correctedAssessmentId:latest.id,initialRunId:old.state.run.id,correctedRunId:fresh.state.run.id,remainingObservedLimitation:'Corrected chat prose says packing terms are not stated despite source packaging inclusion; typed result is correct.',harnessOnlyCorrections:['Initial RFQ selection restricted to requests with current offers','Saved action accessible name includes Ready for your review','Corrected source details renamed Exact passage and questions'],browsersClosed:true,reportBytes:fs.statSync(out+'assessment.md').size}
fs.writeFileSync(out+'summary.json',JSON.stringify(summary,null,2));assert(summary.reportBytes<=8192)
const inventory={at:summary.at,files:{}};for(const file of [...copies,'11-assistant-result.json','recheck/11-assistant-result.json','summary.json']){const b=fs.readFileSync(out+file);inventory.files[file]={bytes:b.length,sha256:hash(b)}}fs.writeFileSync(out+'integrity.json',JSON.stringify(inventory,null,2));console.log(JSON.stringify(summary,null,2))
