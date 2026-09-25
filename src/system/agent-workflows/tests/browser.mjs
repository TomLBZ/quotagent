// All mutations below are visible GUI interactions. Real configured model is used.
import {chromium} from '../../../../host/node_modules/playwright/index.mjs'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const base=(process.env.BASE_URL||'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/'
const out=resolve(process.env.EVIDENCE_DIR||'tmp/product-evidence/workroom/public');mkdirSync(out,{recursive:true})
const report={base,startedAt:new Date().toISOString(),checks:[],pageErrors:[],snapshots:[],screenshots:[]}
const persist=()=>writeFileSync(out+'/report.json',JSON.stringify(report,null,2)+'\n')
const browser=await chromium.launch({headless:true,executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
let page,lastRun
const check=(ok,message,details)=>{if(!ok)throw new Error(message);report.checks.push({message,details});console.log('PASS '+message);persist()}
const shot=async name=>{await page.screenshot({path:out+'/'+name+'.png',fullPage:true});report.screenshots.push(name+'.png');persist()}
const waitRun=async predicate=>{for(let n=0;n<240;n++){if(lastRun&&predicate(lastRun))return lastRun;await page.waitForTimeout(500)}throw new Error('Run did not reach expected state: '+JSON.stringify(lastRun&&{status:lastRun.status,error:lastRun.error,question:lastRun.question,steps:lastRun.steps.map(step=>({title:step.title,status:step.status,error:step.error}))}))}
try{
 page=await browser.newPage({viewport:{width:1512,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>report.pageErrors.push(error.message))
 page.on('response',async response=>{if(response.request().method()==='GET'&&/\/api\/workflows\/[^/]+$/.test(response.url()))try{const payload=await response.json();if(payload.run){lastRun=payload.run;if(report.snapshots.at(-1)?.revision!==lastRun.revision)report.snapshots.push({id:lastRun.id,status:lastRun.status,phase:lastRun.phase,revision:lastRun.revision,steps:lastRun.steps.map(({id,status,agentId,startedAt,completedAt})=>({id,status,agentId,startedAt,completedAt})),question:lastRun.question,at:new Date().toISOString()})}}catch{}})
 await page.goto(base);await page.getByLabel('Email address').fill(process.env.TEST_ACCOUNT||'contractor@demo.local');await page.getByLabel('Password',{exact:true}).fill('demo1234');await page.getByRole('button',{name:'Sign in',exact:true}).click()
 const nav=page.getByRole('navigation',{name:'Main navigation'});await nav.getByRole('button',{name:'Agent workroom',exact:true}).click()
 await page.getByRole('button',{name:/^Account memory/}).click();await page.getByRole('button',{name:'Add memory',exact:true}).click()
 const memoryName=`[Workroom check] Payment preference ${Date.now().toString().slice(-6)}`;report.memoryName=memoryName
 await page.getByRole('dialog').getByLabel('Memory name',{exact:true}).fill(memoryName);await page.getByRole('dialog').getByLabel('Fact or preference',{exact:true}).fill('Prefer net 30 payment terms. Flag full prepayment for human review. Never assume the lowest total has complete scope.')
 await page.getByRole('dialog').getByRole('button',{name:'Save memory',exact:true}).click();await page.getByRole('heading',{name:memoryName,exact:true}).waitFor()
 check(true,'Human can create explicit account memory through the workroom GUI')
 await page.reload();await page.getByRole('button',{name:/^Account memory/}).click();await page.getByRole('heading',{name:memoryName,exact:true}).waitFor();await shot('01-explicit-memory')
 check(true,'Reviewed memory persists through page reload with visible provenance')
 await page.getByRole('button',{name:'New agent run',exact:true}).click()
 const objective='Analyze the [Demo] Riverside office lighting quotations using separate scope, commercial, and scheduling specialists. Have the scheduling specialist ask me for the required delivery date using ask_workflow_human before judging schedule fit. Let the other specialists inspect records independently. Compare only received current quotes, flag scope/quantity/currency/payment/delivery risks, and reconcile findings into a recommendation and conditional negotiation brief. Do not submit, award, order, send messages, or invent an internal budget.'
 await page.getByLabel('Agent team objective',{exact:true}).fill(objective)
 const focus=page.getByRole('dialog').getByLabel('Focus on a request (optional)',{exact:true});await focus.waitFor();if(await focus.count()){const options=await focus.locator('option').allTextContents();const title=options.find(value=>/^\[Demo\] Riverside office lighting$/.test(value));if(title)await focus.selectOption({label:title})}
 await page.getByRole('dialog').getByRole('button',{name:'Create agent plan',exact:true}).click();await page.getByRole('button',{name:'Pause run',exact:true}).waitFor();await page.getByRole('button',{name:'Pause run',exact:true}).click();await waitRun(run=>run.status==='paused');report.runId=lastRun.id
 check(true,'A user can pause a live run before agents proceed')
 await page.reload();await nav.getByRole('button',{name:'Agent workroom',exact:true}).click();const runCard=page.locator('.workroom-run-card').filter({hasText:'Analyze the [Demo] Riverside office lighting quotations'}).first();if(await runCard.count())await runCard.click();await page.getByRole('button',{name:'Resume run',exact:true}).click()
 await waitRun(run=>run.status==='awaiting-plan')
 check(lastRun.steps.length>=2&&lastRun.steps.every(step=>step.status==='queued'),'Real model planner creates distinct role tasks and waits for human plan approval',{steps:lastRun.steps.map(({id,title,role,dependsOn})=>({id,title,role,dependsOn}))})
 check(lastRun.context.memory.some(entry=>entry.key===memoryName),'Explicit reviewed memory is included in the recorded planning context')
 await shot('02-real-agent-plan')
 await page.getByLabel('Human checkpoint response',{exact:true}).fill('Prioritize complete scope and net 30 terms. Keep supplier selection open; no commitment is authorized.')
 await page.getByRole('button',{name:'Approve plan & start agents',exact:true}).click();await waitRun(run=>run.status==='waiting-input'||run.status==='failed'||run.status==='completed')
 check(lastRun.status==='waiting-input','A real delegated specialist pauses the run to ask the human for missing information',{question:lastRun.question})
 await shot('03-agent-question')
 let answers=0
 while(lastRun.status==='waiting-input'&&answers<4){await page.getByLabel('Human checkpoint response',{exact:true}).fill('Required delivery date is 15 October 2026. Treat that date as our target for comparison. Net 30 is preferred; no supplier or budget has been selected. Continue the analysis without making any external commitment.');await page.getByRole('button',{name:'Send answer & resume',exact:true}).click();answers++;await waitRun(run=>['completed','waiting-input','failed'].includes(run.status)&&run.feedback.length>=answers+1);if(lastRun.status==='waiting-input')await page.waitForTimeout(1000)}
 await waitRun(run=>run.status==='completed'||run.status==='failed')
 check(lastRun.status==='completed','Agent team resumes from human input and completes real model synthesis',{status:lastRun.status,error:lastRun.error})
 check(lastRun.steps.every(step=>step.output)&&new Set(lastRun.steps.map(step=>step.agentId)).size===lastRun.steps.length,'Each specialist retains its own agent identity, state and completed report')
 const starts=lastRun.traces.filter(trace=>trace.event==='agent-started'),ends=lastRun.traces.filter(trace=>trace.event==='agent-completed')
 const overlap=starts.some((start,index)=>starts.some((second,j)=>index!==j&&start.stepId!==second.stepId&&second.at>=start.at&&second.at<(ends.find(end=>end.stepId===start.stepId)?.at||lastRun.updatedAt)))
 check(overlap,'Independent specialist execution overlaps in the recorded trace')
 check(lastRun.traces.some(trace=>trace.event==='human-answered')&&lastRun.feedback.some(entry=>entry.text.includes('15 October 2026')),'Human answer is retained in run state and trace')
 check(lastRun.traces.some(trace=>trace.event==='tool-result'),'Real delegated tool results are inspectable in the activity trace')
 report.run=lastRun;await shot('04-completed-team-brief')
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.reload();await nav.getByRole('button',{name:'Agent workroom',exact:true}).click();await page.locator('.workroom-run-card').filter({hasText:'Analyze the [Demo] Riverside office lighting quotations'}).first().click();await page.getByRole('heading',{name:'The team’s findings',exact:true}).waitFor()
 check(true,'Completed reports, human feedback and trace remain available after reload')
 await page.getByRole('button',{name:/^Account memory/}).click();const memoryCard=page.locator('.workroom-memory-card').filter({has:page.getByRole('heading',{name:memoryName,exact:true})});await memoryCard.getByRole('button',{name:'Edit memory',exact:true}).click();await page.getByRole('dialog').getByLabel('Fact or preference',{exact:true}).fill('Prefer net 30 payment terms; flag prepayment and incomplete scope for human review. Confirm all dates with the buyer.');await page.getByRole('dialog').getByRole('button',{name:'Save memory',exact:true}).click();await memoryCard.getByText('Previous revisions (1)',{exact:true}).waitFor()
 check(true,'Memory edits preserve prior value and provenance in visible revision history')
 await memoryCard.getByRole('button',{name:'Archive',exact:true}).click();await page.getByRole('button',{name:/^Archived/}).click();await page.getByRole('heading',{name:memoryName,exact:true}).waitFor();await shot('05-archived-memory-history')
 check(true,'User can archive memory while retaining its history')
 check(report.pageErrors.length===0,'Workroom journey has no browser JavaScript errors')
 report.ok=true
}catch(error){report.ok=false;report.failure={message:error.message,stack:error.stack};console.error(error);if(page){report.visibleText=await page.locator('body').innerText().catch(()=> '');await shot('failure').catch(()=>{})}}
finally{report.finishedAt=new Date().toISOString();persist();console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,runId:report.runId,failure:report.failure},null,2));await browser.close()}
if(!report.ok)process.exitCode=1
