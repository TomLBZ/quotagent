/** Business writes use only the browser UI. BASE_URL may point at the deployed public app. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fixtures} from '../../ingestion-engines/tests/fixtures.mjs'
const require=createRequire(new URL('../../../../host/package.json',import.meta.url))
const {chromium}=require('playwright')
const base=process.env.BASE_URL || 'http://127.0.0.1:8611/quotagent/'
const output=resolve(process.env.EVIDENCE_DIR || 'tmp/product-evidence/ingestion')
const source=resolve('tmp/ingestion-fixtures');await fixtures(source);mkdirSync(output,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:'/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']})
const observations={base,at:new Date().toISOString(),screenshots:[],browserErrors:[],checks:[]}
let active
async function pageFor(role){const context=await browser.newContext({viewport:{width:1440,height:1100}});const page=await context.newPage();active=page;page.on('pageerror',error=>observations.browserErrors.push(error.message));await page.goto(base);await page.getByRole('button',{name:role==='contractor'?'I’m a contractor':'I’m a supplier'}).click();await page.getByRole('button',{name:'Ingest documents',exact:true}).click();return page}
async function screenshot(page,name){const filename=`${name}.png`;await page.screenshot({path:join(output,filename),fullPage:true});observations.screenshots.push(filename)}
async function waitItems(page){await page.getByLabel('Imported item 1 description',{exact:true}).waitFor({timeout:40000});assert.equal(await page.getByLabel('Imported item 1 quantity',{exact:true}).inputValue(),'1500');assert.equal(await page.getByLabel('Imported item 2 quantity',{exact:true}).inputValue(),'48')}
try {
  const buyer=await pageFor('contractor')
  await buyer.getByLabel('Ingestion engine',{exact:true}).selectOption('auto')
  await buyer.getByLabel('Upload source files').setInputFiles(join(source,'cabling-offer.eml'))
  await waitItems(buyer)
  await buyer.getByRole('button',{name:'Attachments 1',exact:true}).click()
  await buyer.getByText('2 rows extracted',{exact:true}).waitFor()
  observations.checks.push('Contractor uploaded real MIME email; XLSX attachment produced two editable rows.')
  await screenshot(buyer,'01-email-attachment')
  await buyer.getByRole('button',{name:'Editable items 2',exact:true}).click()
  await buyer.getByRole('button',{name:'Extract with AI',exact:true}).click()
  await buyer.getByText('AI extraction is ready for review.',{exact:true}).waitFor({timeout:180000})
  await waitItems(buyer)
  assert.equal(await buyer.locator('.ingest-source-quote').count(),2)
  observations.checks.push('Live AI extracted both line items with source excerpts and correct quantities.')
  await buyer.getByLabel('Request title',{exact:true}).fill('Browser-reviewed Riverside cabling request')
  await screenshot(buyer,'02-ai-reviewed-email-items')
  await buyer.getByRole('button',{name:'Create private RFQ draft',exact:true}).click()
  await buyer.getByText('Private RFQ draft created',{exact:true}).waitFor({timeout:30000})
  await buyer.getByRole('button',{name:'Open draft',exact:true}).click()
  await buyer.getByRole('heading',{name:'Browser-reviewed Riverside cabling request',exact:true}).waitFor()
  assert.match(await buyer.locator('body').innerText(),/Draft/)
  await screenshot(buyer,'03-private-rfq-draft')
  observations.checks.push('Contractor created and opened private RFQ draft via GUI; did not publish.')

  await buyer.getByRole('button',{name:'Ingest documents',exact:true}).click()
  const previewFiles=['cabling-offer.csv','cabling-offer.docx','cabling-offer.pdf','mixed-headings.xlsx','empty-attachment.eml']
  await buyer.getByLabel('Upload source files').setInputFiles(previewFiles.map(filename=>join(source,filename)))
  await buyer.locator('.ingest-document-link').filter({hasText:'empty-attachment.eml'}).first().waitFor({timeout:60000})
  for(const filename of previewFiles){
    await buyer.locator('.ingest-document-link').filter({hasText:filename}).first().click()
    await buyer.getByRole('heading',{name:filename,exact:true}).waitFor()
    if(filename==='empty-attachment.eml'){
      assert.equal(await buyer.getByLabel('Imported item 1 description',{exact:true}).inputValue(),'Useful valve')
      await buyer.getByText(/Attachment empty.csv could not be stored.*empty/).waitFor()
    } else await waitItems(buyer)
    if(filename==='cabling-offer.csv'){
      await buyer.getByRole('button',{name:'Source rows 2',exact:true}).click()
      await buyer.getByRole('button',{name:'Map columns',exact:true}).click()
      await buyer.getByRole('button',{name:'Apply column mapping',exact:true}).click()
      await waitItems(buyer)
    }
    if(filename==='cabling-offer.pdf'){
      await buyer.getByRole('button',{name:'Source text',exact:true}).click()
      assert.match(await buyer.locator('.ingest-source-text').innerText(),/Page 1[\s\S]*CAT6 cable/)
    }
    await screenshot(buyer,`06-preview-${filename.replace(/\./g,'-')}`)
  }
  observations.checks.push('GUI multi-upload previews CSV (with manual mapping), DOCX, text PDF and mixed-heading Excel; empty email attachment warns while preserving the usable body.')

  const supplier=await pageFor('supplier')
  await supplier.getByLabel('Ingestion engine',{exact:true}).selectOption('auto')
  await supplier.getByLabel('Upload source files').setInputFiles(join(source,'cabling-offer.xlsx'))
  await waitItems(supplier)
  const options=await supplier.getByLabel('Match an incoming RFQ',{exact:true}).locator('option').allTextContents()
  const cabling=options.find(label=>/cabling/i.test(label));assert.ok(cabling,'Demo cabling RFQ must be available')
  await supplier.getByLabel('Match an incoming RFQ',{exact:true}).selectOption({label:cabling})
  assert.ok(await supplier.getByLabel('Match imported item 1',{exact:true}).inputValue())
  assert.ok(await supplier.getByLabel('Match imported item 2',{exact:true}).inputValue())
  await supplier.getByLabel('Payment terms',{exact:true}).fill('Net 30')
  await supplier.getByLabel('Lead time (days)',{exact:true}).fill('12')
  await supplier.getByLabel('Imported item 1 private cost',{exact:true}).fill('1.20')
  await supplier.locator('label.field').filter({hasText:'Reviewed offer currency'}).locator('select').selectOption('EUR')
  await supplier.getByRole('button',{name:'Create private quote draft',exact:true}).click()
  await supplier.getByText(/This extraction is priced in EUR, but the RFQ uses USD/).waitFor()
  await supplier.locator('label.field').filter({hasText:'Reviewed offer currency'}).locator('select').selectOption('USD')
  await supplier.getByLabel('Imported item 1 unit',{exact:true}).fill('box')
  await supplier.getByRole('button',{name:'Create private quote draft',exact:true}).click()
  await supplier.getByText(/is priced per box, but the RFQ requests m/).waitFor()
  await screenshot(supplier,'04a-explicit-unit-review')
  await supplier.getByLabel('Imported item 1 unit',{exact:true}).fill('m')
  observations.checks.push('GUI refuses currency and unit mismatches; user explicitly restores reviewed USD/m values before import.')
  await screenshot(supplier,'04-supplier-spreadsheet-review')
  await supplier.getByRole('button',{name:'Create private quote draft',exact:true}).click()
  await supplier.getByText('Private quote draft created',{exact:true}).waitFor({timeout:30000})
  await supplier.getByRole('button',{name:'Open draft',exact:true}).click()
  await supplier.getByText('$3,156.00',{exact:true}).first().waitFor()
  await screenshot(supplier,'05-private-quote-draft')
  observations.checks.push('Supplier imported XLSX, matched two RFQ lines, added own cost and terms, opened $3,156 private quote; did not submit.')
  assert.equal(observations.browserErrors.length,0)
  console.log(JSON.stringify({ok:true,...observations},null,2))
} catch(error) {observations.error=error.stack;if(active)await screenshot(active,'failure');console.error(JSON.stringify(observations,null,2));process.exitCode=1}
finally {writeFileSync(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');await browser.close()}
