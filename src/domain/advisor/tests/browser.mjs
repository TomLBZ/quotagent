import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {browserHarness} from '../../../system/file-store/tests/browser-helpers.mjs'

const h=await browserHarness('jev-advisor'),records=[],resume=process.env.RESUME_AFTER_MODES==='1',cancelOnly=process.env.CANCEL_ONLY==='1',resumeClarificationId=process.env.RESUME_CLARIFICATION_ID
const mark=message=>{h.checks.push(message);writeFileSync(`${h.directory}/progress.json`,JSON.stringify({at:new Date().toISOString(),checks:h.checks,records},null,2));console.log(message)}
let buyer,settingsChanged=false,fixture
const shot=(page,name)=>page.screenshot({path:`${h.directory}/${name}.png`,animations:'disabled'})
const result=page=>page.getByRole('region',{name:'Saved assessment'})
async function advisor(page){const heading=page.getByRole('heading',{name:'Quotation advisor',exact:true});if(await heading.isVisible())await page.reload({waitUntil:'domcontentloaded'});else await h.nav(page,'Quotation advisor');await heading.waitFor();const response=await page.request.get(new URL('api/advisor',h.base).href),data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));return data}
async function newTask(page,mode,rfqId){await page.getByRole('button',{name:'New',exact:true}).click();const form=page.getByRole('form',{name:'New quotation assessment'});await form.getByLabel('Assessment task',{exact:true}).selectOption(mode);await form.getByLabel('Request for quotation',{exact:true}).selectOption(rfqId);return form}
async function assess(page){const row=await h.click(page,'advisor/assess','Assess with Jev');records.push({id:row.id,mode:row.mode,status:row.status,model:row.model,callId:row.callId,answers:row.answers,requiresReview:row.requiresReview,requestSha256:row.requestSha256});await result(page).waitFor();return row}
async function settings(page){await page.getByRole('button',{name:'Advisor settings',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Quotation advisor settings',exact:true});await dialog.getByLabel('Jev model',{exact:true}).waitFor();return dialog}
async function updateSettings(page,trigger){const pending=page.waitForResponse(response=>response.url().endsWith('/api/settings/advisor')&&response.request().method()==='PATCH');pending.catch(()=>{});await trigger();const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));return body}
async function closeSettings(page){await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('heading',{name:'Quotation advisor',exact:true}).waitFor()}
async function restore(page){await settings(page);await updateSettings(page,()=>page.getByRole('button',{name:/^(Restore defaults|Use default settings)$/}).click());await closeSettings(page);settingsChanged=false}
async function slowProvider(){
  const observed={requests:0,canceled:0,dummyKeyOnly:true},server=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk)
    observed.requests++;observed.dummyKeyOnly&&=request.headers.authorization==='Bearer local-browser-fixture-key'
    if(!observed.dummyKeyOnly){response.writeHead(403);response.end('{}');return}
    const timer=setTimeout(()=>{response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:'Bounded slow local protocol fixture expired'}))},15000)
    response.on('close',()=>{clearTimeout(timer);if(!response.writableEnded)observed.canceled++})
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  return{server,observed,url:`http://127.0.0.1:${server.address().port}/v1`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)})}
}
try{
  buyer=await h.login(process.env.CONTRACTOR_EMAIL||'contractor@demo.local');buyer.setDefaultTimeout(90000);buyer.setDefaultNavigationTimeout(20000)
  if(resume){await advisor(buyer);await restore(buyer)}
  const before=await advisor(buyer),rfq=before.rfqs.find(row=>before.quotes.some(quote=>quote.rfqId===row.id&&!quote.stale&&['submitted','awarded'].includes(quote.status)))
  assert(rfq,'Use a real authorized request fixture');assert.equal(before.status.available,true,'Configure the actual provider or local protocol service before this journey')
  const ownSettings=await buyer.request.get(new URL('api/settings/advisor',h.base).href),settingState=await ownSettings.json()
  assert.equal(ownSettings.status(),200);assert.equal(settingState.hasOverrides,false,'Use an account without existing advisor overrides; the fixture restores shared defaults')
  let form,clarification
  if(!cancelOnly){
  if(!resume){
  if(!resumeClarificationId){
  form=await newTask(buyer,'clarification',rfq.id)
  await form.getByLabel('Clarification text',{exact:true}).fill('请确认这批灯具能否在两周内送达工地，交期是什么？')
  clarification=await assess(buyer);assert.equal(clarification.status,'completed');assert.equal(clarification.answers.topic.type,'choice');assert.equal(clarification.answers.urgent.type,'noul')
  if(process.env.EXPECTED_CLARIFICATION_TOPIC)assert.equal(clarification.answers.topic.choice,process.env.EXPECTED_CLARIFICATION_TOPIC)
  const urgency=result(buyer).locator('.advisor-answer').filter({has:buyer.getByRole('heading',{name:'Urgency',exact:true})})
  await urgency.getByText('Probability that the statement is true',{exact:true}).waitFor();assert.equal(await urgency.getByText('Model confidence:',{exact:false}).count(),0)
  await result(buyer).getByText('Exact source snapshot and questions',{exact:true}).click();assert((await result(buyer).locator('.advisor-sources pre').innerText()).includes('请确认这批灯具'))
  await result(buyer).getByLabel('Review note (optional)',{exact:true}).fill('Reviewed the stated delivery question. This is a private routing suggestion, not a delivery promise.')
  await h.click(buyer,'advisor/review','Accept suggestion privately');await result(buyer).getByRole('heading',{name:'Review history',exact:true}).waitFor()
  await buyer.reload();await result(buyer).getByText('Reviewed the stated delivery question.',{exact:false}).waitFor()
  await shot(buyer,'01-typed-clarification-private-review')
  mark('Configured provider processes Chinese clarification; typed choice confidence and Noul probability are distinct; exact state and private acceptance survive reload')
  }else{
    const response=await buyer.request.get(new URL(`api/advisor/assessment?id=${encodeURIComponent(resumeClarificationId)}`,h.base).href);clarification=await response.json();assert.equal(response.status(),200);assert.equal(clarification.status,'completed');assert.equal(clarification.mode,'clarification');assert.equal(clarification.rfqId,rfq.id);assert.equal(clarification.review?.decision,'accepted')
    const index=[...before.assessments].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).findIndex(row=>row.id===clarification.id);assert(index>=0);await buyer.locator('.advisor-history-list>button').nth(index).click();await result(buyer).waitFor();records.push({id:clarification.id,mode:clarification.mode,status:clarification.status,model:clarification.model,callId:clarification.callId,answers:clarification.answers,requiresReview:clarification.requiresReview,requestSha256:clarification.requestSha256,reusedRecordedResult:true})
    if(process.env.EXPECTED_CLARIFICATION_TOPIC)assert.equal(clarification.answers.topic.choice,process.env.EXPECTED_CLARIFICATION_TOPIC)
    mark('Continued from the exact completed/accepted clarification after a heading-selector interruption; saved actual provider result inspected without repeating its call')
  }

  await result(buyer).locator('.advisor-sources').getByRole('button',{name:'Open source',exact:true}).first().click();await buyer.getByRole('heading',{name:rfq.title,level:1,exact:true}).waitFor()
  await buyer.getByRole('button',{name:'Assess with Jev',exact:true}).first().click();form=buyer.getByRole('form',{name:'New quotation assessment'});assert.equal(await form.getByLabel('Request for quotation',{exact:true}).inputValue(),rfq.id)
  const quotes=before.quotes.filter(row=>row.rfqId===rfq.id&&!row.stale&&!['withdrawn','superseded'].includes(row.status)),quote=quotes[0];assert(quote,'The fixture needs a current visible quotation')
  await form.getByLabel('Assessment task',{exact:true}).selectOption('quote-review');await form.getByLabel('Quotation to review',{exact:true}).selectOption(quote.id)
  const reviewed=await assess(buyer);assert.equal(reviewed.status,'completed');assert.equal(reviewed.answers.deviation.type,'score');await result(buyer).getByText('Ordinal score — not a monetary amount',{exact:true}).waitFor()
  await result(buyer).getByRole('button',{name:'Dismiss suggestion',exact:true}).click();await result(buyer).locator('.advisor-review-history').getByText('dismissed',{exact:true}).waitFor()
  await shot(buyer,'02-quote-review-score-and-sources')
  mark('Source navigation opens the actual RFQ; contextual Jev entry preserves its identity; quote review displays ordinal score/criteria and records private dismissal')

  form=await newTask(buyer,'shortlist',rfq.id);await form.getByLabel('Your shortlist priorities',{exact:true}).fill('Prefer the shortest explicitly stated delivery lead time among current received offers. If the scope or delivery evidence is insufficient, suggest no match. Do not award an order.')
  const shortlisted=await assess(buyer);assert.equal(shortlisted.status,'completed');assert.equal(shortlisted.answers.candidate.type,'choice');assert(Object.hasOwn(shortlisted.questions.candidate.criteria,'none'))
  form=await newTask(buyer,'field-check',rfq.id);await form.getByLabel('Source text',{exact:true}).fill('Supplier statement: The offered luminaires include a five-year warranty. Delivery timing is not stated.')
  await form.getByLabel('Claims to check',{exact:true}).fill('The supplier statement includes a five-year warranty.\nThe supplier guarantees delivery tomorrow.')
  const checked=await assess(buyer);assert.equal(checked.status,'completed');assert.equal(Object.keys(checked.answers).length,2);await result(buyer).getByRole('heading',{name:'The supplier statement includes a five-year warranty.',exact:true}).waitFor()
  await result(buyer).getByText('Assessment criteria',{exact:true}).first().click();await shot(buyer,'03-explicit-claims')
  mark('Contractor shortlist requires human-authored priorities and includes no-match; source-check renders both explicitly entered claims with typed answers and inspectable criteria')

  }else{
    const prior=Object.fromEntries(['clarification','quote-review','shortlist','field-check'].map(mode=>[mode,before.assessments.find(row=>row.mode===mode&&row.status==='completed'&&row.rfqId===rfq.id)]))
    assert(Object.values(prior).every(Boolean),'Resume requires the four actual completed GUI assessments in this workspace')
    for(const row of Object.values(prior)){
      await buyer.locator('.advisor-history-list>button').filter({hasText:row.title}).first().click();await result(buyer).waitFor()
      const response=await buyer.request.get(new URL(`api/advisor/assessment?id=${row.id}`,h.base).href),saved=await response.json();assert.equal(response.status(),200);assert.equal(saved.status,'completed')
      records.push({id:saved.id,mode:saved.mode,status:saved.status,model:saved.model,callId:saved.callId,answers:saved.answers,requiresReview:saved.requiresReview,requestSha256:saved.requestSha256,reusedRecordedResult:true})
    }
    clarification=prior.clarification;assert.equal(clarification.review?.decision,'accepted');assert.equal(prior['quote-review'].review?.decision,'dismissed');assert(Object.hasOwn(prior.shortlist.questions.candidate.criteria,'none'));assert.equal(Object.keys(prior['field-check'].answers).length,2)
    if(process.env.EXPECTED_CLARIFICATION_TOPIC)assert.equal(clarification.answers.topic.choice,process.env.EXPECTED_CLARIFICATION_TOPIC)
    mark('Resumed after settings-selector interruption: four earlier real GUI assessments remain completed and inspectable, including private acceptance/dismissal, no-match shortlist criteria and two explicit claims; no model call repeated')
  }
  let dialog=await settings(buyer);await dialog.getByLabel('Enable Jev assessments',{exact:false}).uncheck();settingsChanged=true;await updateSettings(buyer,()=>dialog.getByRole('button',{name:'Save settings',exact:true}).click());await closeSettings(buyer)
  await buyer.getByRole('button',{name:'New',exact:true}).click();await buyer.locator('.advisor-availability').getByText('Unavailable',{exact:true}).waitFor();assert.equal(await buyer.getByRole('button',{name:'Assess with Jev',exact:true}).isDisabled(),true)
  await buyer.locator('.advisor-availability').getByRole('button',{name:'Continue quotation work',exact:true}).click();await buyer.getByRole('button',{name:'New request',exact:true}).waitFor();await advisor(buyer);await restore(buyer)
  mark('Disabling only this account’s evaluator visibly disables new assessments while ordinary Requests remain available; shared defaults restored through GUI')

  if(process.env.TEST_UNAVAILABLE==='1'){
    dialog=await settings(buyer);await dialog.getByLabel('TypeSafe API base URL',{exact:true}).fill('http://127.0.0.1:1/v1');await dialog.getByLabel('TypeSafe API key',{exact:true}).fill('local-browser-fixture-key');settingsChanged=true;await updateSettings(buyer,()=>dialog.getByRole('button',{name:'Save settings',exact:true}).click());await closeSettings(buyer)
    form=await newTask(buyer,'clarification',rfq.id);await form.getByLabel('Clarification text',{exact:true}).fill('When can the requested equipment be delivered?')
    const unavailable=await assess(buyer);assert.equal(unavailable.status,'unavailable');assert.deepEqual(unavailable.answers,{})
    await result(buyer).getByRole('heading',{name:'Assessment unavailable',exact:true}).waitFor();await shot(buyer,'04-provider-unavailable-no-fallback');await restore(buyer)
    mark('Actual unreachable local endpoint records unavailable with no fabricated answer; the failed record stays inspectable and account connection overrides are reset')
  }
  await buyer.setViewportSize({width:390,height:844});await buyer.waitForTimeout(400);assert(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Advisor fits390px');await shot(buyer,'05-mobile-advisor')
  const supplier=await h.login(process.env.SUPPLIER_EMAIL||'supplier@demo.local');supplier.setDefaultTimeout(90000);const own=await advisor(supplier)
  assert(!own.assessments.some(row=>records.some(record=>record.id===row.id)),'Contractor assessment history must not appear to supplier')
  assert.equal(await supplier.getByRole('option',{name:'Suggest a shortlist',exact:true}).count(),0)
  const supplierRfq=own.rfqs.find(row=>row.id===rfq.id)||own.rfqs[0];form=await newTask(supplier,'field-check',supplierRfq.id);await form.getByLabel('Source text',{exact:true}).fill('The quotation expressly excludes installation.');await form.getByLabel('Claims to check',{exact:true}).fill('Installation is included in the quoted scope.')
  const ownCheck=await assess(supplier);assert.equal(ownCheck.status,'completed');assert.equal(Object.keys(ownCheck.answers).length,1);await shot(supplier,'06-supplier-private-check')
  mark('390px page has no document overflow; supplier sees its own records and claims check, with no contractor shortlist control or contractor assessment history')
  await buyer.setViewportSize({width:1440,height:1100});await advisor(buyer);await buyer.getByRole('button',{name:'AI usage',exact:true}).click();await buyer.getByLabel('Provider',{exact:true}).selectOption('typesafe')
  const usageLoaded=buyer.waitForResponse(response=>response.url().includes('/api/usage?')&&response.status()===200);await buyer.getByRole('button',{name:'Apply filters',exact:true}).click();const usage=await(await usageLoaded).json();assert(usage.calls.some(call=>call.callId===clarification.callId));assert(usage.calls.every(call=>call.provider==='typesafe'));await shot(buyer,'09-typesafe-usage-receipts')
  await h.nav(buyer,'Help & getting started');await buyer.getByLabel('Search Help',{exact:true}).fill('Jev');await buyer.getByRole('button',{name:/Review quotations with Jev/}).click();await buyer.getByRole('heading',{name:'Review quotations with Jev',exact:true}).waitFor();await buyer.getByText('Jev is a structured evaluator, not a text or arithmetic generator.',{exact:false}).waitFor();await shot(buyer,'10-jev-help');await buyer.getByRole('button',{name:'Open quotation advisor',exact:true}).click();await buyer.getByRole('heading',{name:'Quotation advisor',exact:true}).waitFor()
  mark('AI usage filters actual TypeSafe call receipts including the saved assessment; Jev Help describes limits and its action opens the advisor')
  }
  if(process.env.TEST_CANCEL==='1'||cancelOnly){
    console.log('Cancellation fixture: starting HTTP listener');fixture=await slowProvider();console.log('Cancellation fixture: listener ready');await buyer.setViewportSize({width:1440,height:1100});console.log('Cancellation fixture: opening advisor');await advisor(buyer)
    console.log('Cancellation fixture: opening settings');const dialog=await settings(buyer);await dialog.getByLabel('TypeSafe API base URL',{exact:true}).fill(fixture.url);await dialog.getByLabel('TypeSafe API key',{exact:true}).fill('local-browser-fixture-key');settingsChanged=true;await updateSettings(buyer,()=>dialog.getByRole('button',{name:'Save settings',exact:true}).click());await closeSettings(buyer)
    console.log('Cancellation fixture: personal endpoint configured');form=await newTask(buyer,'clarification',rfq.id);await form.getByLabel('Clarification text',{exact:true}).fill('This local cancellation fixture asks when delivery can occur.')
    const completed=buyer.waitForResponse(response=>response.url().endsWith('/api/advisor/assess')&&response.request().method()==='POST')
    await form.getByRole('button',{name:'Assess with Jev',exact:true}).click()
    await result(buyer).getByRole('heading',{name:'Assessment in progress',exact:true}).waitFor({timeout:10000})
    assert.equal(await result(buyer).getByRole('heading',{name:'Assessment unavailable',exact:true}).count(),0)
    assert.equal(await result(buyer).getByRole('button',{name:'New assessment from these sources',exact:true}).count(),0)
    await shot(buyer,'07-pending-with-owned-stop')
    const stopped=await h.click(buyer,'advisor/cancel','Stop assessment'),original=await(await completed).json()
    assert.equal(stopped.status,'interrupted');assert.equal(original.id,stopped.id);assert.equal(original.status,'interrupted');records.push({id:stopped.id,mode:stopped.mode,status:stopped.status,callId:stopped.callId,providerFixture:true})
    await result(buyer).getByRole('heading',{name:'Assessment interrupted',exact:true}).waitFor()
    await buyer.waitForTimeout(2200);assert.equal(fixture.observed.requests,1);assert.equal(fixture.observed.canceled,1);assert.equal(fixture.observed.dummyKeyOnly,true)
    await buyer.reload();await result(buyer).getByRole('heading',{name:'Assessment interrupted',exact:true}).waitFor();await shot(buyer,'08-interrupted-retained')
    await restore(buyer)
    mark('Real slow loopback provider receives one request with a personal dummy key; exact client correlation opens In progress with Stop, cancel aborts that call and retains interrupted history across reload; polling never resends; shared defaults restored')
  }
  await h.finish({records,providerMode:process.env.PROVIDER_MODE||'configured provider; identify real versus local protocol fixture in release evidence',semantics:clarification?{clarificationTopic:clarification.answers.topic.choice}:undefined,cancellationFixture:fixture?.observed,resumedAfterModes:resume,resumedClarificationId:resumeClarificationId||undefined,cancellationOnly:cancelOnly,allWrites:'GUI; assessments/private reviews and reversible personal settings only'})
}catch(error){writeFileSync(`${h.directory}/error.json`,JSON.stringify({error:error.stack,checks:h.checks,records},null,2));console.error(error);await h.fail(error);throw error}
finally{
  if(settingsChanged&&buyer)try{const dialog=buyer.getByRole('dialog');if(await dialog.count())await dialog.getByRole('button',{name:'Close',exact:true}).click();await advisor(buyer);await restore(buyer)}catch(error){writeFileSync(`${h.directory}/settings-cleanup-error.txt`,error.stack);console.error('Personal advisor settings cleanup failed:',error.message)}
  if(fixture)await fixture.close()
  await h.close()
}
