import assert from 'node:assert/strict'
import { chromium } from '../../../../host/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
const base=process.env.BASE_URL||'https://novara.remoteblossom.com/quotagent/',evidence=process.env.EVIDENCE_DIR||'tmp/product-evidence/procurement-proposals/public'
mkdirSync(evidence,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'}),page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[]
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000)
try{
 await page.goto(base);await page.getByLabel('Email address').fill('supplier2@demo.local');await page.getByLabel('Password',{exact:true}).fill('demo1234');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).waitFor()
 const prompt='For the Riverside office lighting request in my workspace, prepare a clarification message to the inviting contractor asking them to confirm the delivery window and unloading instructions. Save it for human review only; do not send anything and do not propose a price change.'
 await page.getByRole('textbox',{name:'Message your AI assistant'}).fill(prompt)
 const pending=page.waitForResponse(response=>response.url().endsWith('/api/assistant/chat')&&response.request().method()==='POST',{timeout:180000})
 await page.getByRole('button',{name:'Send to AI assistant'}).click();const response=await pending,body=await response.json();assert.equal(response.status(),200,body.error)
 const steps=body.toolResults||[],proposal=steps.find(step=>step.name==='draft_message')?.result
 assert.ok(proposal?.proposal?.id,JSON.stringify(steps));assert.equal(proposal.proposal.kind,'procurement.commit');assert.equal(proposal.action.input.actionId,proposal.proposal.id)
 await page.getByRole('button',{name:/Review procurement action/}).last().click();await page.locator('.procurement-proposal-preview').waitFor()
 const preview=await page.locator('.procurement-proposal-preview').innerText();assert.match(preview,/delivery/i);assert.match(preview,/unloading/i);assert.match(preview,/Northstar|contractor/i)
 await page.screenshot({path:`${evidence}/message-review.png`,fullPage:true});await page.getByLabel('Decision note (optional)').fill('Public browser verification: reviewed draft only; no message should be sent.');await page.getByRole('button',{name:'Decline action',exact:true}).click();await page.locator('.review-detail .badge').filter({hasText:'rejected'}).waitFor();await page.screenshot({path:`${evidence}/declined.png`,fullPage:true})
 assert.deepEqual(errors,[]);const report={ok:true,base,account:'supplier2@demo.local',model:body.message?.model,tools:steps.map(step=>step.name),actionId:proposal.proposal.id,preview,decision:'rejected; nothing sent',jsErrors:errors,checkedAt:new Date().toISOString()};writeFileSync(`${evidence}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}catch(error){await page.screenshot({path:`${evidence}/failure.png`,fullPage:true}).catch(()=>{});throw error}finally{await browser.close()}
