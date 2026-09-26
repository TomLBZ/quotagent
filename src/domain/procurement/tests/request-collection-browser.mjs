import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {chromium} from '../../../../host/node_modules/playwright/index.mjs'

const base=process.env.BASE_URL||'http://127.0.0.1:8645/quotagent/',output=process.env.EVIDENCE_DIR||'tmp/product-evidence/request-collection/local';mkdirSync(output,{recursive:true})
const stamp=Date.now(),prefix=`[Request list check] ${stamp}`,checks=[],responses=[],errors=[],created=[],report={base,prefix}
const browser=await chromium.launch({headless:true,executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']}),page=await browser.newPage({viewport:{width:1460,height:1080}});page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message))
page.on('response',async response=>{if(!response.url().includes('/api/collections/requests'))return;try{responses.push({url:response.url(),status:response.status(),body:await response.json()})}catch{}})
const shot=name=>page.screenshot({path:`${output}/${name}.png`,fullPage:true})
async function write(path,label,method='POST',scope=page){const pending=page.waitForResponse(response=>response.url().endsWith('/api/'+path)&&response.request().method()===method);await scope.getByRole('button',{name:label,exact:true}).click();const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));return body}
async function queryChange(action,check){const next=page.waitForResponse(async response=>{if(!response.url().includes('/api/collections/requests?')||response.request().method()!=='GET')return false;try{return check(await response.json())}catch{return false}});await action();const result=await(await next).json();await page.waitForFunction(count=>document.querySelectorAll('.rfq-card').length===count,result.query.sent);return result}
try{
  await page.goto(base);await page.getByRole('button',{name:'Create an account',exact:true}).click()
  for(const [label,value]of [['Your name','Collection owner '+stamp],['Company','Collection fixture '+stamp],['Email address',`collection-${stamp}@local.test`],['Password','collection-fixture-pass']])await page.getByLabel(label,{exact:true}).fill(value)
  await write('auth/register','Create workspace');await page.getByRole('navigation',{name:'Main navigation'}).waitFor();await page.getByRole('button',{name:'Not now',exact:true}).click({timeout:800}).catch(()=>{})
  await page.goto(base+'#rfqs')
  for(let index=0;index<11;index++){
    await page.getByRole('button',{name:'New request',exact:true}).click();const form=page.getByRole('dialog',{name:'Create a request for quotation',exact:true})
    await form.getByLabel('Request title',{exact:true}).fill(`${prefix} ${String(index).padStart(2,'0')}`);await form.getByLabel('Project brief',{exact:true}).fill(index%2?'Steel panels':'Timber panels');await form.getByLabel('Currency',{exact:true}).selectOption(index%2?'GBP':'USD');await form.getByLabel('Item 1 description',{exact:true}).fill('Panel')
    created.push((await write('workspace/create-rfq','Save request draft')).rfq);await page.getByRole('button',{name:'All requests',exact:true}).click()
  }
  let result=await queryChange(()=>page.getByLabel('Rows per page',{exact:true}).selectOption('10'),result=>result.query.total===11&&result.query.sent===10)
  assert.equal(result.query.pages,2);await queryChange(()=>page.getByLabel('Sort by',{exact:true}).selectOption('title'),result=>result.query.applied.sort==='title'&&result.query.sent===10)
  assert.deepEqual(await page.locator('.rfq-card h3').allTextContents(),created.slice(0,10).map(row=>row.title))
  result=await queryChange(()=>page.getByRole('button',{name:'Next page',exact:true}).click(),result=>result.query.page===2);assert.deepEqual(result.rows.map(row=>row.id),[created[10].id]);await shot('01-second-page')
  checks.push('Eleven requests created solely through GUI are rendered ten then one, with server totals/page metadata and deterministic title order; no silent truncation')

  await page.getByText('Filters, saved view & export columns',{exact:true}).click()
  result=await queryChange(()=>page.getByLabel('Filter Currency',{exact:true}).selectOption('GBP'),result=>result.query.applied.filters.currency?.equals==='GBP');assert.equal(result.query.matched,5);assert.equal(result.query.page,1)
  await queryChange(()=>page.getByLabel('Sort direction',{exact:true}).selectOption('desc'),result=>result.query.applied.direction==='desc')
  const exportFields=page.getByRole('group',{name:'CSV export columns'});await exportFields.getByLabel('Title',{exact:true}).check();await exportFields.getByLabel('Currency',{exact:true}).check()
  await write('collections/requests/preferences','Save view','PATCH');await page.reload();await page.getByLabel('Search requests',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.rfq-card').length===5)
  assert.deepEqual(await page.locator('.rfq-card h3').allTextContents(),created.filter((_,index)=>index%2).reverse().map(row=>row.title));await page.getByText('Filters, saved view & export columns',{exact:true}).click();assert.equal(await page.getByLabel('Filter Currency',{exact:true}).inputValue(),'GBP');assert.equal(await page.getByLabel('Sort direction',{exact:true}).inputValue(),'desc')
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export matching CSV',exact:true}).click();const file=await download;await file.saveAs(`${output}/requests.csv`);const csv=readFileSync(`${output}/requests.csv`,'utf8');assert(csv.startsWith('"Title","Currency"'));assert.equal(csv.trim().split('\r\n').length,6);assert(!csv.includes('USD'));await shot('02-saved-filter-and-export')
  checks.push('Column currency filter searches whole source; saved descending personal view survives reload; exported CSV has exactly selected columns and all five matching rows')

  const opened=created[9];await page.locator('.rfq-card').filter({has:page.getByRole('heading',{name:opened.title,exact:true})}).click();await page.getByRole('heading',{name:opened.title,exact:true}).waitFor();await page.getByRole('button',{name:'Edit draft',exact:true}).click()
  const form=page.getByRole('dialog',{name:'Edit request draft',exact:true}),title=form.getByLabel('Request title',{exact:true});await title.fill(opened.title+' unsaved');await title.focus();const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/workspace')&&response.request().method()==='GET');await refreshed;assert.equal(await title.inputValue(),opened.title+' unsaved');assert(await title.evaluate(element=>element===document.activeElement));await shot('03-detail-unsaved-edit-preserved');await form.getByRole('button',{name:'Cancel',exact:true}).click()
  checks.push('A paged card opens the correct authorized detail; an unsaved edited request title and focus survive background workspace refresh')
  assert.deepEqual(errors,[]);Object.assign(report,{ok:true,checks,errors,ids:created.map(row=>row.id),at:new Date().toISOString()})
}catch(error){Object.assign(report,{ok:false,error:error.stack,checks,errors});await shot('failure').catch(()=>{});writeFileSync(`${output}/failure.txt`,await page.locator('body').innerText().catch(()=>''));process.exitCode=1}
finally{writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');writeFileSync(`${output}/responses.json`,JSON.stringify(responses,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.close()}
