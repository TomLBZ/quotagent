import {writeFileSync,readFileSync} from 'node:fs'
import {browserHarness} from '../../../src/system/file-store/tests/browser-helpers.mjs'
const h=await browserHarness('jev-independent'),stage=process.env.STAGE||'inspect'
const save=(name,value)=>writeFileSync(`${h.directory}/${name}.json`,JSON.stringify(value,null,2))
const capture=async(page,name)=>{await page.screenshot({path:`${h.directory}/${name}.png`,fullPage:true,animations:'disabled'});writeFileSync(`${h.directory}/${name}.txt`,await page.locator('body').innerText())}
const advisor=async page=>{const wait=page.waitForResponse(r=>r.url().endsWith('/api/advisor')&&r.request().method()==='GET');await h.nav(page,'Quotation advisor');const data=await(await wait).json();await page.getByRole('heading',{name:'Quotation advisor',exact:true}).waitFor();return data}
const result=page=>page.getByRole('region',{name:'Saved assessment'})
const newTask=async(page,mode,id)=>{await page.getByRole('button',{name:'New',exact:true}).click();const form=page.getByRole('form',{name:'New quotation assessment'});await form.getByLabel('Assessment task',{exact:true}).selectOption(mode);await form.getByLabel('Request for quotation',{exact:true}).selectOption(id);return form}
const assess=async(page,name)=>{const start=Date.now(),row=await h.click(page,'advisor/assess','Assess with Jev');save(name,{observedAt:new Date().toISOString(),elapsedMs:Date.now()-start,assessment:row});await result(page).waitFor();await capture(page,name);return row}
try{
 const supplier=stage==='supplier',page=await h.login(supplier?'supplier@demo.local':'contractor@demo.local');page.setDefaultTimeout(90000)
 const data=await advisor(page),hasOffer=row=>data.quotes.some(q=>q.rfqId===row.id&&!q.stale&&['submitted','awarded'].includes(q.status)),rfq=data.rfqs.find(row=>/Riverside/i.test(row.title)&&hasOffer(row))||data.rfqs.find(hasOffer)
 if(!rfq)throw new Error('No existing current request is available')
 if(stage==='inspect'){
  save('01-current-context',{observedAt:new Date().toISOString(),rfq,quotes:data.quotes.filter(q=>q.rfqId===rfq.id),status:data.status,history:data.assessments.map(({id,mode,title,status,review})=>({id,mode,title,status,review}))});await capture(page,'01-advisor-entry')
  const row=data.assessments.find(a=>a.mode==='shortlist'&&a.status==='completed');if(row){await page.locator('.advisor-history-list>button').filter({hasText:row.title}).first().click();await result(page).waitFor();save('02-existing-shortlist',row);await result(page).getByText('Exact source snapshot and questions',{exact:true}).click();await capture(page,'02-existing-shortlist')}
  console.log(JSON.stringify({stage,rfq,quotes:data.quotes.filter(q=>q.rfqId===rfq.id),historicalShortlist:row?.answers},null,2))
 }else if(stage==='claims'){
  const form=await newTask(page,'field-check',rfq.id)
  await form.getByLabel('Source text',{exact:true}).fill('[Independent evaluation 2026-09-28] Supplied offer passage: The luminaires carry a three-year warranty. Installation is excluded from this offer. Packaging is included.')
  await form.getByLabel('Claims to check',{exact:true}).fill('The supplied passage says the luminaires have a three-year warranty.\nThe supplied passage includes installation in this offer.\nThe supplied passage states that delivery is guaranteed tomorrow.')
  const row=await assess(page,'03-independent-claims');await result(page).getByText('Exact source snapshot and questions',{exact:true}).click();await result(page).getByText('Answer probabilities',{exact:true}).nth(2).click();await capture(page,'04-claims-source-probabilities')
  await result(page).getByLabel('Review note (optional)',{exact:true}).fill('Independent evaluation: checked the three explicit claims against the supplied passage; this private annotation does not approve any supplier commitment.')
  await h.click(page,'advisor/review','Dismiss suggestion');await page.reload();await result(page).getByRole('heading',{name:'Review history',exact:true}).waitFor();await capture(page,'05-private-review-reloaded');console.log(JSON.stringify({stage,id:row.id,status:row.status,answers:row.answers,requiresReview:row.requiresReview},null,2))
 }else if(stage==='supplier'){
  const quote=data.quotes.find(q=>q.rfqId===rfq.id&&!q.stale&&!['withdrawn','superseded'].includes(q.status));if(!quote)throw new Error('No supplier quotation available')
  save('06-supplier-context',{rfq,quote,status:data.status,shortlistControlCount:await page.getByRole('option',{name:'Suggest a shortlist',exact:true}).count(),history:data.assessments.map(a=>({id:a.id,mode:a.mode,title:a.title}))})
  const form=await newTask(page,'quote-review',rfq.id);await form.getByLabel('Quotation to review',{exact:true}).selectOption(quote.id);await form.getByLabel('Additional context (optional)',{exact:true}).fill('[Independent evaluation 2026-09-28] Identify whether this supplied quotation explicitly deviates from the saved request. Missing information must stay unknown. Do not infer a promise or change the offer.')
  const row=await assess(page,'07-supplier-review');await result(page).getByText('Exact source snapshot and questions',{exact:true}).click();await capture(page,'08-supplier-source');await result(page).locator('.advisor-sources').getByRole('button',{name:'Open source',exact:true}).last().click();await page.waitForTimeout(800);await capture(page,'09-supplier-open-quote');console.log(JSON.stringify({stage,id:row.id,status:row.status,answers:row.answers,requiresReview:row.requiresReview},null,2))
 }else if(stage==='legacy'){
  const id='00e6a0af-5b5b-4c18-8574-b51e00bb6e96';await page.goto(h.base+'#advisor?context='+encodeURIComponent(JSON.stringify({assessmentId:id})));await result(page).getByText('Earlier source-check method.',{exact:true}).waitFor();await result(page).getByText('Exact saved input and questions',{exact:true}).click();await capture(page,'15-legacy-scope-warning');const response=await page.request.get(new URL('api/advisor/assessment?id='+id,h.base).href);save('15-legacy-record',await response.json());console.log(JSON.stringify({stage,id,warningVisible:true}))
 }else if(stage==='assistant-read'){
  await h.nav(page,'Agent workspace');await page.getByRole('button',{name:/^Review Jev assessment/}).last().waitFor({timeout:10000});await capture(page,'12-assistant-completed-link');await page.getByRole('button',{name:/^Review Jev assessment/}).last().click();await result(page).waitFor();await capture(page,'13-assistant-saved-assessment');await result(page).getByText(/^(Exact passage and questions|Exact source snapshot and questions)$/).click();await capture(page,'14-assistant-exact-source');console.log(JSON.stringify({stage,openedSavedAssessment:true}))
 }else if(stage==='assistant'){
  await h.nav(page,'Agent workspace')
  const prompt=`[Independent Jev evaluation 2026-09-28] Use the assess_quotation tool for authorized request ${rfq.id} (${rfq.title}), mode field-check. First read the current procurement workspace. Source text: "The offer includes packaging. Installation is expressly excluded." Explicit claims: ["The offer includes packaging.", "The offer includes installation.", "The offer states a five-year warranty."] Save one private Jev assessment, summarize its actual typed results and uncertainty, and provide the link to the saved assessment. Do not send, publish, award or change quotation terms.`
  save('10-assistant-prompt',{prompt,at:new Date().toISOString(),rfq});await page.getByLabel('Message your AI assistant',{exact:true}).fill(prompt)
  const start=Date.now(),response=await h.click(page,'assistant/chat','Send to AI assistant');save('10-assistant-dispatch',response)
  const deadline=Date.now()+180000;let current
  while(Date.now()<deadline){await page.waitForTimeout(1200);const response=await page.request.get(new URL('api/assistant',h.base).href);current=await response.json();if(current.run&&!['running'].includes(current.run.status))break}
  save('11-assistant-result',{elapsedMs:Date.now()-start,state:current});await capture(page,'11-assistant-result')
  const last=page.locator('.assistant-message.from-assistant').last();if(await last.locator('.tool-details>summary').count()){await last.locator('.tool-details>summary').click();await capture(page,'12-assistant-tools')}
  const link=page.getByRole('button',{name:/^Review Jev assessment/}).last();await link.waitFor({timeout:10000});await link.click();await result(page).waitFor();await capture(page,'13-assistant-saved-assessment');await result(page).getByText(/^(Exact passage and questions|Exact source snapshot and questions)$/).click();await capture(page,'14-assistant-exact-source')
  console.log(JSON.stringify({stage,status:current?.run?.status,runId:current?.run?.id,tools:current?.run?.results.map(r=>({name:r.name,callId:r.callId})),last:current?.messages?.at(-1)?.content},null,2))
 }
 await h.finish({stage,rfq,allWrites:'GUI; private assessments and private review only'})
}catch(error){await h.fail(error);throw error}finally{await h.close()}
