// User journeys use only browser controls on BASE_URL; no direct business API writes.
import { chromium } from '../host/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const base = (process.env.BASE_URL || 'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'') + '/'
const out = resolve(process.env.EVIDENCE_DIR || 'tmp/product-evidence/public')
mkdirSync(out,{recursive:true})
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const report = {base,startedAt:new Date().toISOString(),checks:[],errors:[]}
let current
const assert = (condition,message) => { if(!condition) throw new Error(message);report.checks.push(message) }
async function login(email) {
 const context = await browser.newContext({viewport:{width:1440,height:1000}})
 const page = await context.newPage(); page.setDefaultTimeout(20000)
 page.on('pageerror',e=>report.errors.push(e.message))
 await page.goto(base)
 await page.getByLabel('Email address').fill(email)
 await page.getByLabel('Password',{exact:true}).fill('demo1234')
 await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('navigation',{name:'Main navigation'}).waitFor()
 return page
}
async function nav(page,name) { await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click() }
async function requestDetail(page,title) { await page.reload();await page.getByRole('navigation',{name:'Main navigation'}).waitFor();await nav(page,'Requests');await page.getByText(title,{exact:true}).first().click() }
async function confirm(page) { const modal=page.getByRole('dialog');await modal.getByRole('button',{name:'Confirm & continue'}).click();await modal.waitFor({state:'hidden'}) }
try {
 const buyer=await login('contractor@demo.local');current=buyer
 const supplier=await login('supplier@demo.local')
 assert(!(await supplier.getByRole('button',{name:'New request',exact:true}).count()),'Supplier has only supplier actions')
 assert(!(await buyer.getByRole('button',{name:'Administration',exact:true}).count()),'Client navigation has no administration')
 const title=`[Demo] Community centre lighting · ${Date.now().toString().slice(-6)}`
 report.project=title
 await buyer.getByRole('button',{name:'New request',exact:true}).first().click()
 const form=buyer.getByRole('dialog')
 await form.getByLabel('Request title').fill(title)
 await form.getByLabel('Project brief').fill('Supply LED panels and occupancy sensors for the community centre. Delivery included; 3-year warranty.')
 await form.getByLabel('Item 1 description').fill('LED panel 36W')
 await form.getByLabel('Item 1 quantity').fill('100')
 await form.getByLabel('Item 1 unit').fill('each')
 await form.getByRole('button',{name:'Add item'}).click()
 await form.getByLabel('Item 2 description').fill('Occupancy sensor')
 await form.getByLabel('Item 2 quantity').fill('25')
 await form.getByLabel('Item 2 unit').fill('each')
 await form.getByRole('checkbox',{name:/Summit Supply/}).check()
 await form.getByRole('button',{name:'Save request draft'}).click()
 await buyer.getByRole('button',{name:'Publish request',exact:true}).click()
 await confirm(buyer)
 await buyer.getByText('Published',{exact:true}).first().waitFor();assert(true,'Contractor creates and publishes RFQ in GUI')
 current=supplier
 await requestDetail(supplier,title)
 await supplier.getByRole('button',{name:'Prepare quote',exact:true}).first().click()
 const q=supplier.getByRole('dialog')
 await q.getByLabel('Unit price for LED panel 36W',{exact:true}).fill('18.50')
 await q.getByLabel('Private cost for LED panel 36W',{exact:true}).fill('12.00')
 await q.getByLabel('Unit price for Occupancy sensor',{exact:true}).fill('11.00')
 await q.getByLabel('Private cost for Occupancy sensor',{exact:true}).fill('7.00')
 await q.getByLabel('Lead time (days)').fill('14')
 await q.getByLabel('Payment terms').fill('Net 30')
 await q.getByRole('button',{name:'Save quotation draft'}).click()
 await supplier.getByRole('button',{name:'Review & submit',exact:true}).click()
 await confirm(supplier)
 await supplier.getByText('Submitted',{exact:true}).first().waitFor();assert(true,'Supplier prepares and submits quote in GUI')
 current=buyer
 await requestDetail(buyer,title)
 assert((await buyer.locator('body').innerText()).includes('$2,125.00'),'Buyer sees exact submitted total of 2125.00')
 assert(!(await buyer.getByText('Private cost / unit',{exact:true}).count()),'Buyer does not see private supplier cost fields')
 await buyer.screenshot({path:out+'/comparison.png',fullPage:true})
 await buyer.getByRole('button',{name:'Award & issue order',exact:true}).click()
 await confirm(buyer)
 await nav(buyer,'Orders')
 await buyer.getByText(title,{exact:true}).first().waitFor();assert(true,'Buyer approves award and issues order in GUI')
 current=supplier
 await supplier.reload();await nav(supplier,'Orders')
 const order=supplier.locator('.order-card').filter({hasText:title})
 await order.getByRole('button',{name:'Acknowledge order',exact:true}).click()
 await confirm(supplier)
 await order.getByText('Acknowledged',{exact:true}).waitFor();assert(true,'Supplier acknowledges purchase order in GUI')
 await order.getByRole('button',{name:'Propose change',exact:true}).click()
 const change=supplier.getByRole('dialog')
 await change.getByLabel('Change title').fill('Additional delivery visit')
 await change.getByLabel('What changed, and why?').fill('Buyer requested one additional scheduled delivery visit.')
 const number=change.locator('input[type=number]');await number.fill('75')
 await change.getByRole('button',{name:/Send change proposal/}).click();await change.waitFor({state:'hidden'})
 current=buyer
 await buyer.reload();await nav(buyer,'Orders')
 const buyerOrder=buyer.locator('.order-card').filter({hasText:title})
 await buyerOrder.getByRole('button',{name:'Approve change',exact:true}).click()
 await confirm(buyer)
 await buyerOrder.getByText('$2,200.00',{exact:true}).first().waitFor();assert(true,'Approved change updates order to 2200.00')
 await buyer.screenshot({path:out+'/order.png',fullPage:true})
 await nav(buyer,'Messages')
 await buyer.getByText(title,{exact:true}).first().click()
 await buyer.getByLabel('Message',{exact:true}).fill('Please confirm the delivery window for next Tuesday.')
 await buyer.getByRole('button',{name:'Send message',exact:true}).click()
 assert(await buyer.getByText('Please confirm the delivery window for next Tuesday.',{exact:true}).count()>0,'Contextual project message sent in GUI')
 const admin=await login('admin@demo.local');current=admin
 assert(await admin.getByRole('heading',{name:/Keep everyone moving/}).count()>0,'Separate administrator account opens user management')
 assert(!(await admin.getByRole('navigation').getByRole('button',{name:'Requests',exact:true}).count()),'Admin has server management, no client business view')
 await admin.screenshot({path:out+'/admin.png',fullPage:true})
 current=buyer
 await buyer.setViewportSize({width:390,height:844});await buyer.reload()
 assert(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile has no page-wide horizontal overflow')
 await buyer.screenshot({path:out+'/mobile.png',fullPage:true})
 assert(report.errors.length===0,'No browser JavaScript errors')
 report.ok=true
} catch(error) {
 report.ok=false;report.failure=error.stack
 if(current) {await current.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});writeFileSync(out+'/failure.txt',await current.locator('body').innerText().catch(()=>''))}
} finally {
 report.finishedAt=new Date().toISOString();writeFileSync(out+'/journey.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1
}
