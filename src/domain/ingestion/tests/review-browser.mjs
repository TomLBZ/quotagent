// All business writes are visible GUI actions; saved responses are evidence only.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {chromium} from '../../../../host/node_modules/playwright/index.mjs'
const base=process.env.BASE_URL||'http://127.0.0.1:8660/quotagent/',output=process.env.EVIDENCE_DIR||'tmp/agent-experience/ingestion-review/browser'
mkdirSync(output,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],checks=[],report={base,at:new Date().toISOString()}
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000)
const shot=name=>page.screenshot({path:`${output}/${name}.png`,fullPage:true,animations:'disabled'})
async function save(){const pending=page.waitForResponse(response=>response.url().includes('/api/ingestion/ingest-')&&response.request().method()==='PATCH');await page.getByRole('button',{name:'Save reviewed extraction',exact:true}).click();const response=await pending;assert.equal(response.status(),200);return(await response.json()).document}
try{
 await page.goto(base);await page.getByRole('button',{name:'Create an account',exact:true}).click()
 for(const[label,value]of[['Your name','Source review'],['Company','Source review fixtures'],['Email address',`source-review-${Date.now()}@local.test`],['Password','review-fixture-pass']])await page.getByLabel(label,{exact:true}).fill(value)
 await page.getByLabel('Your workspace',{exact:true}).selectOption('contractor');await page.getByRole('button',{name:'Create workspace',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).waitFor();await page.getByRole('button',{name:'Not now',exact:true}).click({timeout:1000}).catch(()=>{})
 await page.goto(base+'#ingestion');await page.getByLabel('Upload source files').setInputFiles({name:'missing-details.csv',mimeType:'text/csv',buffer:Buffer.from('Description,Quantity,Unit\nValve,,\n')})
 await page.getByText('What is the quantity for Valve?',{exact:true}).waitFor();await page.getByText('What is the unit for Valve?',{exact:true}).waitFor();await shot('01-private-source-questions')
 assert.equal(await page.getByRole('button',{name:'Create private RFQ draft',exact:true}).isDisabled(),true)
 await page.getByLabel('Imported item 1 quantity',{exact:true}).fill('2');await page.getByLabel('Imported item 1 unit',{exact:true}).fill('each');let document=await save();assert.equal(document.questions.length,0);assert.equal(document.itemReviews[0].kind,'referenced')
 checks.push('Actual uploaded CSV retains row references and generates missing quantity/unit questions; incomplete private draft unavailable, saved corrections resolve questions')
 await page.getByRole('button',{name:'Add item',exact:true}).click();await page.getByLabel('Imported item 2 description',{exact:true}).fill('Authored spare');await page.getByLabel('Imported item 2 quantity',{exact:true}).fill('1');await page.getByLabel('Imported item 2 unit',{exact:true}).fill('each');document=await save();assert.equal(document.itemReviews[1].kind,'assumption');await page.getByText('Assumption — needs confirmation',{exact:true}).waitFor()
 const refused=page.waitForResponse(response=>response.url().endsWith('/import'));await page.getByRole('button',{name:'Create private RFQ draft',exact:true}).click();assert.equal((await refused).status(),400);await page.getByText('Confirm the labelled assumptions using Save reviewed extraction before creating a draft.',{exact:true}).waitFor();await shot('02-unconfirmed-assumption')
 await page.getByLabel('Confirm assumption Authored spare',{exact:true}).check();document=await save();assert.equal(document.itemReviews[1].confirmed,true)
 await page.getByLabel('Imported item 2 quantity',{exact:true}).fill('3');await page.getByText('Assumption — needs confirmation',{exact:true}).waitFor();document=await save();assert.equal(document.itemReviews[1].confirmed,false)
 await page.getByLabel('Confirm assumption Authored spare',{exact:true}).check();document=await save();assert.equal(document.itemReviews[1].confirmed,true);await shot('03-exact-value-confirmation')
 checks.push('Unsourced manually authored item is labelled assumption; server refuses unconfirmed import; explicit checkbox+save records human confirmation; changed quantity invalidates it')
 await page.reload();await page.getByText('Assumption · confirmed by you for these saved values.',{exact:true}).waitFor();await page.getByRole('button',{name:'Create private RFQ draft',exact:true}).click();await page.getByText('Private RFQ draft created',{exact:true}).waitFor();await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=0);await shot('04-mobile-reviewed-draft')
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[])
 checks.push('Reload preserves exact source review; confirmed assumptions enter a private RFQ draft only; 390px page stays within viewport; no JavaScript errors')
 Object.assign(report,{ok:true,checks,errors})
}catch(error){Object.assign(report,{ok:false,error:error.stack,checks,errors});await shot('failure').catch(()=>{});writeFileSync(`${output}/failure.txt`,await page.locator('body').innerText());process.exitCode=1}
finally{writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await browser.close()}
