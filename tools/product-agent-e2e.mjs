// Public GUI journey: create an account, extract an RFQ and supplier quote with live AI.
import { chromium } from '../host/node_modules/playwright/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const base=(process.env.BASE_URL||'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/'
const out=process.env.EVIDENCE_DIR||'tmp/product-evidence/public-agent';mkdirSync(out,{recursive:true})
const previous=process.env.RESUME==='1' ? JSON.parse(readFileSync(out+'/journey.json','utf8')) : null
const report={base,startedAt:previous?.startedAt || new Date().toISOString(),checks:previous?.checks || [],turns:previous?.turns || [],errors:[]}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const check=(ok,text)=>{if(!ok)throw new Error(text);report.checks.push(text)}
let current
async function page(){const context=await browser.newContext({viewport:{width:1512,height:1000}});const p=await context.newPage();p.setDefaultTimeout(25000);p.on('pageerror',e=>report.errors.push(e.message));await p.goto(base);return p}
async function nav(p,name){await (name==='Settings' ? p.getByRole('button',{name,exact:true}) : p.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true})).click()}
async function ask(p,text){await p.getByLabel('Message your AI assistant').fill(text);const response=p.waitForResponse(r=>r.url().endsWith('/api/assistant/chat')&&r.request().method()==='POST',{timeout:150000});await p.getByRole('button',{name:'Send to AI assistant',exact:true}).click();const r=await response;const body=await r.json();report.turns.push({prompt:text,response:body});check(r.ok(),'Live assistant request completed');await p.locator('.assistant-thinking').waitFor({state:'hidden'});return body}
async function confirm(p){const d=p.getByRole('dialog');await d.getByRole('button',{name:'Confirm & continue'}).click();await d.waitFor({state:'hidden'})}
try{
 const stamp=Date.now().toString().slice(-8),email=previous?.account || `public-check-${stamp}@demo.local`,title=previous?.project || `[Public check] AI library fit-out ${stamp}`
 report.account=email;report.project=title
 const buyer=await page();current=buyer
 if(previous){await buyer.getByLabel('Email address').fill(email);await buyer.getByLabel('Password',{exact:true}).fill('demo1234');await buyer.getByRole('button',{name:'Sign in',exact:true}).click();await buyer.getByRole('navigation',{name:'Main navigation'}).waitFor()}else{
 await buyer.getByRole('button',{name:'Create an account',exact:true}).click()
 await buyer.getByLabel('Your name',{exact:true}).fill('Casey Public Check')
 await buyer.getByLabel('Company',{exact:true}).fill('Demo Library Construction')
 await buyer.getByLabel('Email address').fill(email)
 await buyer.getByLabel('Password',{exact:true}).fill('demo1234')
 await buyer.getByRole('button',{name:'Create workspace',exact:true}).click()
 await buyer.getByRole('navigation',{name:'Main navigation'}).waitFor()
 check(true,'New contractor account created entirely in GUI')
 const draft=await ask(buyer,`Remember that I prefer Net 30 payment terms. Extract and create an editable RFQ draft now from this brief: Title exactly "${title}". Supply 40 LED strip lights 12W and 12 occupancy sensors, quantity unit each, USD, delivery in 21 days. Invite Summit Supply. Describe missing delivery address as to be confirmed. Do not publish or send anything.`)
 check(draft.toolResults?.some(t=>t.name==='remember_preference'&&t.result?.ok),'Explicit preference stored by real agent tool')
 check(draft.toolResults?.some(t=>t.name==='draft_rfq'&&!t.result?.error),'Real AI extracted brief into persistent RFQ draft')
 }
 await nav(buyer,'Requests');await buyer.locator('.rfq-card').filter({hasText:title}).click()
 await buyer.getByRole('cell',{name:/LED strip light.*12\s*W/i}).first().waitFor()
 check((await buyer.locator('body').innerText()).includes('Occupancy sensor')||(await buyer.locator('body').innerText()).includes('occupancy sensor'),'Extracted items visible in request GUI')
 await buyer.screenshot({path:out+'/extracted-request.png',fullPage:true})
 if(await buyer.getByRole('button',{name:'Publish request',exact:true}).count()){await buyer.getByRole('button',{name:'Publish request',exact:true}).click();await confirm(buyer)}
 await buyer.getByText('Published',{exact:true}).first().waitFor();check(true,'Human reviews and publishes AI-created draft')
 await nav(buyer,'Settings');await buyer.getByText(/Net 30/).first().waitFor();check(true,'Remembered preference visible in settings')
 await buyer.reload();await buyer.getByText(/Net 30/).first().waitFor();check(true,'Preference persists across page reload')
 const supplier=await page();current=supplier
 await supplier.getByLabel('Email address').fill('supplier@demo.local');await supplier.getByLabel('Password',{exact:true}).fill('demo1234');await supplier.getByRole('button',{name:'Sign in',exact:true}).click()
 await supplier.getByRole('navigation',{name:'Main navigation'}).waitFor();await nav(supplier,'Requests');await supplier.locator('.rfq-card').filter({hasText:title}).click()
 const quote=await ask(supplier,`Prepare a private quotation draft for selected RFQ "${title}" now. Price LED strip lights 12W at $16.25 per unit, private unit cost $10; price occupancy sensors at $9.50 per unit, private unit cost $6. Lead time 14 days, payment Net 30, delivery included. Use exact request quantities. Do not submit.`)
 check(quote.toolResults?.some(t=>t.name==='draft_quote'&&!t.result?.error),'Supplier AI creates quote draft from authorized price/cost guidance')
 await supplier.getByRole('button',{name:'Review & submit',exact:true}).waitFor();check((await supplier.locator('body').innerText()).includes('$764.00'),'AI-created quote GUI shows exact total 764.00')
 await supplier.screenshot({path:out+'/supplier-ai-quote.png',fullPage:true})
 await supplier.getByRole('button',{name:'Review & submit',exact:true}).click();await confirm(supplier)
 check(true,'Supplier human reviews and submits AI-created quote')
 current=buyer;await nav(buyer,'Requests');await buyer.locator('.rfq-card').filter({hasText:title}).click();await buyer.getByText('$764.00',{exact:true}).first().waitFor()
 check(true,'Contractor sees supplier AI quote after human submission')
 await nav(buyer,'Settings');await buyer.getByLabel('Workspace type').selectOption('supplier');await buyer.getByRole('button',{name:'Save changes',exact:true}).click();await buyer.getByText('Your account settings have been saved.',{exact:true}).waitFor()
 await buyer.reload();await buyer.getByRole('navigation',{name:'Main navigation'}).waitFor()
 check(!(await buyer.getByRole('button',{name:'New request',exact:true}).count()),'Saved role switch exposes only supplier business actions')
 await nav(buyer,'Settings');check(await buyer.getByLabel('Workspace type').inputValue()==='supplier','Account role persists across reload')
 await buyer.getByLabel('Workspace type').selectOption('contractor');await buyer.getByRole('button',{name:'Save changes',exact:true}).click()
 check(!report.errors.length,'No browser JavaScript errors');report.ok=true
}catch(e){report.ok=false;report.failure=e.stack;if(current){await current.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});writeFileSync(out+'/failure.txt',await current.locator('body').innerText().catch(()=>''))}}
finally{report.finishedAt=new Date().toISOString();writeFileSync(out+'/journey.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({...report,turns:report.turns.map(t=>({prompt:t.prompt,tools:t.response.toolResults?.map(x=>x.name)}))},null,2));if(!report.ok)process.exitCode=1}
