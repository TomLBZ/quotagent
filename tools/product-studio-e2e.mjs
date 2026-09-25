// Public user journey. All state-changing actions use visible browser controls.
import { chromium } from '../host/node_modules/playwright/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const base = (process.env.BASE_URL || 'https://novara.remoteblossom.com/quotagent').replace(/\/$/,'')+'/'
const out = resolve(process.env.EVIDENCE_DIR || 'tmp/product-evidence/public-studio')
mkdirSync(out,{recursive:true})
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const recheck = process.env.STUDIO_RECHECK_SKILL === '1'
const report = recheck ? JSON.parse(readFileSync(out+'/report.json','utf8')) : {base,startedAt:new Date().toISOString(),checks:[],pageErrors:[],artifacts:{}}
if(recheck) report.skillRecheckStartedAt=new Date().toISOString()
let current
const persist = () => writeFileSync(out+'/report.json',JSON.stringify(report,null,2)+'\n')
const check = (condition,message,details) => {if(!condition)throw new Error(message);report.checks.push({message,...(details ? {details} : {})});console.log('PASS '+message);persist()}
const shot = async (page,name) => {await page.screenshot({path:out+'/'+name+'.png',fullPage:true});report.artifacts[name]=name+'.png';persist()}
async function login(email){const context=await browser.newContext({viewport:{width:1512,height:982}});const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push({email,error:e.message}));await page.goto(base);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('demo1234');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).waitFor();return page}
async function studio(page){await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Plugin studio',exact:true}).click();await page.getByRole('heading',{name:'Your workspace. Your way.'}).waitFor()}
const accent = page => page.locator('.product').evaluate(el=>getComputedStyle(el).getPropertyValue('--accent').trim().toLowerCase())
async function waitAccent(page,value,equal=true){await page.waitForFunction(({value,equal})=>{const actual=getComputedStyle(document.querySelector('.product')).getPropertyValue('--accent').trim().toLowerCase();return equal ? actual===value : actual!==value},{value,equal},{timeout:30000})}
const card = (page,name) => page.locator('.plugin-card').filter({has:page.getByRole('heading',{name,exact:true})})
async function generate(page,prompt,name){await page.getByRole('textbox',{name:'Describe an extension',exact:true}).fill(prompt);await page.getByRole('button',{name:'Create with AI',exact:true}).click();await card(page,name).waitFor({timeout:150000});return card(page,name)}
const stamp=Date.now().toString().slice(-7)
const themeName=`[Public check] Orchid theme ${stamp}`,toolName=`[Public check] Quote total ${stamp}`,skillName=`[Public check] Morning review ${stamp}`
if(!recheck) report.names={themeName,toolName,skillName}
try {
 if(recheck) {
  const owner=await login('supplier2@demo.local');current=owner;await studio(owner)
  const before=await owner.locator('.assistant-message.from-assistant').count()
  await card(owner,report.names.skillName).getByRole('button',{name:'Run skill',exact:true}).click()
  await owner.waitForFunction(before=>document.querySelectorAll('.assistant-message.from-assistant').length>before,before,{timeout:150000})
  const reply=await owner.locator('.assistant-message.from-assistant').last().innerText()
  check(/Riverside/i.test(reply),'Saved skill re-run after restart uses actual Riverside project context',{reply})
  report.skillRecheck={reply,hasQuoteAmount:/5,?292/.test(reply),hasLighting:/lighting/i.test(reply),hasCabling:/cabling/i.test(reply),at:new Date().toISOString()}
  const shotIndex=String(Math.max(0,...Object.keys(report.artifacts).map(name=>parseInt(name,10)||0))+1).padStart(2,'0')
  await shot(owner,`${shotIndex}-saved-skill-riverside-context`)
  check(report.pageErrors.length===0,'Saved skill re-run has no browser JavaScript errors')
  report.ok=true
 } else {

 const owner=await login('supplier2@demo.local');current=owner;await studio(owner)
 const other=await login('supplier@demo.local')
 const ownerOriginal=await accent(owner),otherOriginal=await accent(other)
 check(true,'Two supplier accounts sign in through the public URL',{ownerOriginal,otherOriginal})
 const theme=await generate(owner,`Create a personal UI theme named exactly "${themeName}". Use accent #b83f75, background #fbf6ff, surface #ffffff, text #26334e, radius 14px. Keep strong readable contrast.`,themeName)
 await waitAccent(owner,ownerOriginal,false);const generatedAccent=await accent(owner)
 await other.reload();await other.getByRole('navigation',{name:'Main navigation'}).waitFor()
 check(await accent(other)===otherOriginal,'Generated theme applies only to its owning account',{generatedAccent,ownerOriginal,otherOriginal})
 await shot(owner,'01-personal-theme-enabled');await shot(other,'02-other-account-unchanged')
 await theme.getByRole('button',{name:'Disable',exact:true}).click();await waitAccent(owner,ownerOriginal)
 check(true,'Disabling a personal theme restores the previous appearance')
 await shot(owner,'03-personal-theme-disabled')
 await theme.getByRole('button',{name:'Enable',exact:true}).click();await waitAccent(owner,generatedAccent)
 await theme.getByRole('button',{name:'Publish to market',exact:true}).click();await theme.getByText('Shared with the community',{exact:true}).waitFor()
 check(true,'User publishes their real generated extension to the marketplace')
 await studio(other);await other.getByRole('button',{name:/^Marketplace/}).click()
 const shared=card(other,themeName);await shared.waitFor();await shared.getByRole('button',{name:'Install in my workspace',exact:true}).click();await waitAccent(other,generatedAccent)
 check(true,'Another account installs the published extension through marketplace UI')
 await other.getByRole('button',{name:/^My extensions/}).click();await card(other,themeName).getByRole('button',{name:'Disable',exact:true}).click();await waitAccent(other,otherOriginal)
 const admin=await login('admin@demo.local');current=admin
 await admin.getByRole('button',{name:'Administration',exact:true}).click()
 const original=admin.locator('.admin-extension').filter({hasText:themeName}).filter({has:admin.getByRole('button',{name:'Promote globally',exact:true})}).first()
 await original.getByRole('button',{name:'Promote globally',exact:true}).click()
 const global=admin.locator('.admin-extension').filter({hasText:themeName}).filter({has:admin.getByText('Global default',{exact:true})})
 await global.waitFor();await other.reload();await other.getByRole('navigation',{name:'Main navigation'}).waitFor();await waitAccent(other,generatedAccent)
 check(true,'Administrator promotes a user extension to a global default',{globalAccent:await accent(other)})
 await shot(admin,'04-admin-global-promotion');await shot(other,'05-global-theme-on-other-account')
 await global.getByRole('button',{name:'Disable',exact:true}).click()
 await other.reload();await other.getByRole('navigation',{name:'Main navigation'}).waitFor();await waitAccent(other,otherOriginal)
 check(true,'Administrator disables the global plugin and account appearance restores')
 current=owner;await owner.reload();await studio(owner)
 await generate(owner,`Create an interactive calculator named exactly "${toolName}". It must have exactly two numeric input fields: "Quantity" default 3 and "Unit price" default 12.5. The implementation must compute quantity * unitPrice, rounded to two decimals. Return summary "Quotation total" and rows [{label:"Total",value:calculatedTotal}]. This must be an executable calculator plugin, not a static reference widget and not a workflow skill.`,toolName)
 const tool=card(owner,toolName);await tool.getByRole('button',{name:'Open tool',exact:true}).click()
 const dialog=owner.getByRole('dialog')
 await dialog.getByLabel('Quantity',{exact:true}).fill('7');await dialog.getByLabel('Unit price',{exact:true}).fill('19.5');await dialog.getByRole('button',{name:'Run tool',exact:true}).click()
 await dialog.getByLabel('Utility result',{exact:true}).waitFor();let result=await dialog.getByLabel('Utility result',{exact:true}).innerText()
 check(result.includes('136.5'),'Generated JavaScript utility computes 7 × 19.5 = 136.5 in the GUI',{result})
 await dialog.getByLabel('Quantity',{exact:true}).fill('4');await dialog.getByLabel('Unit price',{exact:true}).fill('25');await dialog.getByRole('button',{name:'Run tool',exact:true}).click()
 await owner.waitForFunction(()=>document.querySelector('[aria-label="Utility result"]')?.textContent?.includes('100'))
 result=await dialog.getByLabel('Utility result',{exact:true}).innerText();check(result.includes('100'),'Generated utility recomputes after user changes input',{result})
 await shot(owner,'06-generated-utility-real-result')
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await tool.getByRole('button',{name:'View details',exact:true}).click();await owner.getByRole('dialog').getByText('Review generated plugin source',{exact:true}).click()
 check((await owner.getByRole('dialog').innerText()).includes('export'),'Generated executable Cordis source is reviewable from the UI')
 await shot(owner,'07-generated-source-review');await owner.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
 await generate(owner,`Create a saved workflow skill named exactly "${skillName}". When run, review only my account's existing open RFQs and quote drafts, summarize the next two practical actions with source request names and due dates, and remind me of missing information. Do not create plugins, send any messages, submit quotations or make commitments.`,skillName)
 const before=await owner.locator('.assistant-message.from-assistant').count()
 await card(owner,skillName).getByRole('button',{name:'Run skill',exact:true}).click()
 await owner.waitForFunction(before=>document.querySelectorAll('.assistant-message.from-assistant').length>before,before,{timeout:150000})
 const reply=await owner.locator('.assistant-message.from-assistant').last().innerText()
 check(reply.length>40,'Saved workflow skill runs a real contextual assistant turn',{reply})
 await shot(owner,'08-saved-skill-run')
 await theme.getByRole('button',{name:'Disable',exact:true}).click();await waitAccent(owner,ownerOriginal)
 check(report.pageErrors.length===0,'Public studio journey has no browser JavaScript errors')
 report.ok=true
 }
} catch(error){report.ok=false;report.failure={message:error.message,stack:error.stack};console.error(error);if(current){await shot(current,'failure').catch(()=>{});report.failure.visibleText=await current.locator('body').innerText().catch(()=> '')}}
finally{report.finishedAt=new Date().toISOString();persist();console.log(JSON.stringify(report,null,2));await browser.close()}
if(!report.ok)process.exitCode=1
