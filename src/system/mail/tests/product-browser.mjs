/** GUI-only configuration, receiving, drafting, attachment extraction and human approval. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url)),{chromium}=require('playwright')
const base=process.env.BASE_URL||'http://127.0.0.1:8620/quotagent/',phase=process.env.PHASE||'all'
const fixture=JSON.parse(readFileSync(process.env.FIXTURE_FILE||'tmp/product-evidence/external-connections/fixture/connection.json','utf8'))
const output=resolve(process.env.EVIDENCE_DIR||'tmp/product-evidence/external-connections/browser');mkdirSync(output,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']})
const report={base,phase,at:new Date().toISOString(),transport:'fictitious loopback IMAP/SMTP/Telegram API; never forwards',checks:[],screenshots:[],browserErrors:[]}
const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',error=>report.browserErrors.push(error.message))
const receipt=async()=>await(await fetch(fixture.statusUrl)).json()
const screenshot=async name=>{await page.screenshot({path:join(output,`${name}.png`),fullPage:true});report.screenshots.push(name+'.png')}
async function setting(dialog,label,value){const field=dialog.locator('label.field').filter({has:page.getByText(label,{exact:true})}).locator('input,select,textarea');if(await field.evaluate(element=>element.tagName==='SELECT'))await field.selectOption(String(value));else await field.fill(String(value))}
async function finishSettings(dialog){await dialog.getByRole('button',{name:'Save settings',exact:true}).click();await dialog.getByText('Settings saved.',{exact:true}).waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).click()}
try{
  await page.goto(base);await page.getByRole('button',{name:'I’m a contractor'}).click()
  if(phase!=='telegram'){
    await page.getByRole('button',{name:'Email',exact:true}).click();await page.getByRole('button',{name:'Email settings',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'Email connection settings',exact:true});await dialog.getByText('Enable this account’s email connection',{exact:true}).waitFor()
    await dialog.locator('.studio-boolean-field').filter({hasText:'Enable this account’s email connection'}).locator('input').check()
    for(const [label,value]of [['Sender name','Fixture buyer'],['Sender email address','buyer@fixture.invalid'],['IMAP host','127.0.0.1'],['IMAP port',fixture.imapPort],['IMAP encryption','plain'],['IMAP username','fixture'],['IMAP app password','fixture-password'],['Sent folder (optional)','Sent'],['SMTP host','127.0.0.1'],['SMTP port',fixture.smtpPort],['SMTP encryption','plain'],['SMTP username','fixture'],['SMTP app password','fixture-password']])await setting(dialog,label,value)
    await finishSettings(dialog)
    const before=await receipt()
    await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.locator('.mail-test-result').getByText(/Connected and authenticated/).first().waitFor()
    assert.equal((await receipt()).smtpSent,before.smtpSent)
    await page.getByRole('button',{name:'Sync email',exact:true}).click();await page.locator('.mail-list-item').filter({hasText:'Riverside cabling offer'}).first().waitFor({timeout:30000})
    await page.locator('.mail-list-item').filter({hasText:'Riverside cabling offer'}).first().click();await page.locator('.mail-reader').getByText('cabling-offer.xlsx',{exact:true}).waitFor()
    await screenshot('01-inbox-with-real-mime-attachment');report.checks.push('Configured account IMAP/SMTP through GUI, tested auth without sending, synchronized actual IMAP fixture email and attached XLSX.')
    await page.locator('.mail-attachments article').getByRole('button',{name:'Extract items',exact:true}).click();await page.getByLabel('Imported item 1 quantity',{exact:true}).waitFor();assert.equal(await page.getByLabel('Imported item 1 quantity',{exact:true}).inputValue(),'1500');await screenshot('02-email-attachment-to-editable-items')
    await page.getByRole('button',{name:'Email',exact:true}).click();await page.locator('.mail-list-item').filter({hasText:'Riverside cabling offer'}).first().click();await page.getByRole('button',{name:'Reply',exact:true}).click()
    const compose=page.getByRole('dialog',{name:'Reply by email',exact:true});await compose.getByLabel('Email message',{exact:true}).fill('Thanks for your cabling offer. Please confirm installation and testing are included. This is a local fixture reply.')
    await compose.getByRole('button',{name:'Review send',exact:true}).click();await page.getByRole('button',{name:'Approve & execute',exact:true}).waitFor();assert.equal((await receipt()).smtpSent,before.smtpSent)
    await screenshot('03-email-human-review-before-send');await page.getByRole('button',{name:'Approve & execute',exact:true}).click();await page.getByText('Action completed.',{exact:true}).waitFor({timeout:30000})
    const after=await receipt();assert.equal(after.smtpSent,before.smtpSent+1);assert.match(after.smtpMessages.at(-1).source,/confirm installation/)
    await screenshot('04-email-smtp-receipt');report.checks.push('Attachment became editable line items. Reply draft/proposal sent nothing; explicit approval delivered exactly one email to loopback SMTP.')
  }
  if(phase!=='mail'){
    await page.getByRole('button',{name:'Telegram',exact:true}).click();await page.getByRole('button',{name:'Telegram settings',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'Telegram bot settings',exact:true});await dialog.getByText('Enable Telegram for this account',{exact:true}).waitFor();await dialog.locator('.studio-boolean-field').filter({hasText:'Enable Telegram for this account'}).locator('input').check()
    await setting(dialog,'Bot token','fixture-token');await setting(dialog,'Default recipient chat ID (optional)','4242');await finishSettings(dialog)
    const before=await receipt();await page.getByRole('button',{name:'Test bot',exact:true}).click();await page.getByRole('heading',{name:'@quotagent_fixture_bot',exact:true}).waitFor();assert.equal((await receipt()).telegramSent,before.telegramSent)
    await page.getByRole('button',{name:'Receive messages',exact:true}).click();await page.locator('.telegram-chat').filter({hasText:'Fixture supplier'}).first().waitFor();await page.locator('.telegram-chat').filter({hasText:'Fixture supplier'}).first().click()
    await page.getByRole('link',{name:'telegram-offer.csv',exact:true}).waitFor();await screenshot('05-telegram-received-text-and-document')
    const offer=page.locator('.telegram-bubble').filter({hasText:'Offer attached'});await offer.getByRole('button',{name:'Extract items',exact:true}).click();await page.getByLabel('Imported item 1 description',{exact:true}).waitFor();assert.equal(await page.getByLabel('Imported item 1 description',{exact:true}).inputValue(),'Valve');await screenshot('06-telegram-document-to-items')
    await page.getByRole('button',{name:'Telegram',exact:true}).click();await page.locator('.telegram-chat').filter({hasText:'Fixture supplier'}).first().click();await page.locator('.telegram-bubble').filter({hasText:'Offer attached'}).getByRole('button',{name:'Reply',exact:true}).click()
    const compose=page.getByRole('dialog',{name:'Reply on Telegram',exact:true});await compose.getByLabel('Telegram message',{exact:true}).fill('Thanks. We are reviewing the valve offer. This is a local fixture reply.')
    await compose.getByRole('button',{name:'Review send',exact:true}).click();await page.getByRole('button',{name:'Approve & execute',exact:true}).waitFor();assert.equal((await receipt()).telegramSent,before.telegramSent)
    await screenshot('07-telegram-human-review-before-send');await page.getByRole('button',{name:'Approve & execute',exact:true}).click();await page.getByText('Action completed.',{exact:true}).waitFor({timeout:30000});assert.equal((await receipt()).telegramSent,before.telegramSent+1)
    await screenshot('08-telegram-send-receipt');report.checks.push('Configured/tested bot through GUI; received text/document over fixture HTTP API, extracted CSV, then sent one reply only after human approval.')
  }
  await page.getByRole('button',{name:'Notifications',exact:true}).click();await page.getByRole('heading',{name:'Notifications',exact:true}).waitFor();await screenshot('09-in-app-notifications')
  assert.equal(report.browserErrors.length,0);report.ok=true;console.log(JSON.stringify(report,null,2))
}catch(error){report.error=error.stack;await screenshot('failure');console.error(JSON.stringify(report,null,2));process.exitCode=1}
finally{writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await browser.close()}
