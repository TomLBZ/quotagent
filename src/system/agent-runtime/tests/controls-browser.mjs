// Visible GUI interactions only; the configured provider performs the reasoning.
import {chromium} from '../../../../host/node_modules/playwright/index.mjs'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const base=(process.env.BASE_URL||'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/'
const out=resolve(process.env.EVIDENCE_DIR||'tmp/agent-experience/controls-public');mkdirSync(out,{recursive:true})
const report={base,startedAt:new Date().toISOString(),checks:[],pageErrors:[],runs:[]}
const persist=()=>writeFileSync(out+'/report.json',JSON.stringify(report,null,2)+'\n')
const browser=await chromium.launch({headless:true,executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
let page,run
const check=(condition,message)=>{if(!condition)throw new Error(message);report.checks.push(message);console.log('PASS '+message);persist()}
const waitRun=async predicate=>{for(let n=0;n<300;n++){if(run&&predicate(run))return run;await page.waitForTimeout(500)}throw new Error('Expected task status; last '+JSON.stringify(run))}
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>report.pageErrors.push(error.message))
 page.on('response',async response=>{if(response.request().method()==='GET'&&response.url().endsWith('/api/assistant'))try{const payload=await response.json();run=payload.run;if(run&&report.runs.at(-1)?.revision!==run.revision)report.runs.push({id:run.id,status:run.status,phase:run.phase,revision:run.revision,results:run.results?.length,error:run.error})}catch{}})
 await page.goto(base+'#agent');await page.getByLabel('Email address').fill(process.env.TEST_ACCOUNT||'supplier2@demo.local');await page.getByLabel('Password',{exact:true}).fill('demo1234');await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('heading',{name:'Your AI teammate',exact:true}).waitFor();await page.waitForTimeout(800)
 if(await page.getByRole('button',{name:'Dismiss getting started',exact:true}).count())await page.getByRole('button',{name:'Dismiss getting started',exact:true}).click()
 if(run&&!['completed','stopped'].includes(run.status)){await page.getByRole('button',{name:'Stop task',exact:true}).click();await waitRun(run=>run.status==='stopped')}
 check(await page.getByLabel('Message your AI assistant').count()===1,'Agent workspace mounts one conversation composer')
 const input=page.getByLabel('Message your AI assistant'),send=page.getByRole('button',{name:'Send to AI assistant',exact:true})
 await input.fill('Review my incoming quotation requests and prepare a detailed comparison of scope questions, lead time assumptions, missing information and possible next steps. Do not create or send anything. I will provide further guidance shortly.');await send.click()
 await page.getByRole('button',{name:'Pause task',exact:true}).click();await waitRun(run=>run.status==='paused');const id=run.id
 check(true,'User can pause a running assistant request from the conversation')
 await page.reload();await page.getByRole('button',{name:'Resume task',exact:true}).waitFor();await waitRun(run=>run.id===id&&run.status==='paused')
 check(true,'Paused task survives browser reload with Resume and Stop controls')
 await input.fill('Change direction: give only three short delivery-risk questions I should ask the buyer. Start your answer with CONTROLS-VERIFIED. Do not use tools or change records.');await page.getByRole('button',{name:'Send guidance to AI assistant',exact:true}).click()
 await page.getByText('Guidance saved. Resume when ready.',{exact:true}).waitFor();check(run.status==='paused','Additional guidance stays visible and does not resume a paused task')
 await page.screenshot({path:out+'/01-paused-guidance.png',fullPage:true})
 await page.getByRole('button',{name:'Resume task',exact:true}).click();await waitRun(run=>['completed','failed'].includes(run.status));check(run.status==='completed','Real model completes the resumed conversation')
 await page.locator('.assistant-message.from-assistant').filter({hasText:'CONTROLS-VERIFIED'}).last().waitFor();check(true,'Actual model answer follows the additional guidance')
 await page.screenshot({path:out+'/02-guided-answer.png',fullPage:true})
 await input.fill('Prepare a detailed supplier-side quotation review checklist covering all commercial and delivery risks. Do not create or send anything.');await send.click();await page.getByRole('button',{name:'Stop task',exact:true}).click();await waitRun(run=>run.status==='stopped');const stopped=run.id
 await page.reload();await waitRun(run=>run.id===stopped&&run.status==='stopped');check(await page.getByRole('button',{name:'Resume task',exact:true}).count()===0,'Stopped task stays stopped after reload and has no Resume action')
 await input.fill('Reply with exactly: Ready for a new task.');await send.click();await waitRun(run=>run.id!==stopped&&run.status==='completed');check(true,'User can send a new follow-up after stopping a task')
 check(report.pageErrors.length===0,'Conversation controls produce no browser JavaScript errors')
 await page.screenshot({path:out+'/03-new-followup.png',fullPage:true});report.ok=true
}catch(error){report.ok=false;report.failure={message:error.message,stack:error.stack};console.error(error);if(page){report.visibleText=await page.locator('body').innerText().catch(()=> '');await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{})}}
finally{report.finishedAt=new Date().toISOString();persist();await browser.close();console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,failure:report.failure},null,2))}
if(!report.ok)process.exitCode=1
