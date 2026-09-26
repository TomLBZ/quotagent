import {fillDeclaredScope} from './declared-scope-fixture.mjs'
// All business writes originate from visible GUI controls. Response capture is evidence only.
import assert from 'node:assert/strict'
import { chromium } from '../../../../host/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
const base = process.env.BASE_URL || 'http://127.0.0.1:8640/quotagent/'
const evidence = process.env.EVIDENCE_DIR || 'tmp/product-evidence/rfq-lifecycle/local'
mkdirSync(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })
const pages = [], errors = [], checks = [], receipts = [], stamp = new Date().toISOString().replace(/[:.]/g, '-')
const previous = process.env.RFQ_RECHECK_REPORT ? JSON.parse(readFileSync(process.env.RFQ_RECHECK_REPORT,'utf8')) : null
const title = previous?.title || `[RFQ lifecycle check] Lighting ${stamp}`, projectName = previous?.projectName || `[RFQ lifecycle check] Hospital ${stamp}`
const field = (page, label) => page.locator('label.field').filter({ has: page.getByText(label, { exact: true }) }).locator('input,textarea,select').first()
const shot = (page, name) => page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true, animations: 'disabled' })
async function mutation(page, action, trigger) {
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/workspace/${action}`) && response.request().method() === 'POST')
  await trigger(); const response = await pending, body = await response.json()
  assert.equal(response.status(), 200, `${action}: ${JSON.stringify(body)}`)
  receipts.push({ action, response: body }); return body
}
async function login(email) {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1100 } }); pages.push(page)
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
  await page.goto(base); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill('demo1234')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('navigation', { name: 'Main navigation' }).waitFor()
  await page.getByRole('button', { name: 'Not now', exact: true }).click({ timeout: 2500 }).catch(() => {})
  return page
}
async function navigate(page, name) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' }), target = nav.getByRole('button', { name, exact: true })
  if (!await target.isVisible()) await nav.locator('.ws-nav-group').filter({ has: page.getByRole('button', { name, exact: true, includeHidden: true }) }).locator('.ws-group-toggle').click()
  await target.click()
}
async function openRequest(page) {
  await navigate(page, 'Requests'); const search = page.getByLabel('Search requests'); await search.fill(title)
  await page.getByRole('button').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).click()
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
}
async function confirm(page, action) { return mutation(page, action, () => page.getByRole('button', { name: 'Confirm & continue', exact: true }).click()) }
try {
  const buyer = await login('contractor@demo.local'), supplier = await login('supplier@demo.local'), second = await login('supplier2@demo.local')
  if(previous) {
    await openRequest(buyer);await buyer.getByText('REQUEST FOR QUOTATION · REVISION 2',{exact:true}).waitFor();await buyer.getByRole('button',{name:'Revisions',exact:true}).click();await buyer.getByText(/Revision 1 ·/).waitFor();await buyer.getByText(/Revision 2 ·/).waitFor();await shot(buyer,'restart-published-history')
    await buyer.getByRole('button',{name:'Shared clarifications',exact:true}).click();await buyer.getByText('Include commissioning, certification and operator training for all twelve panels and two sensors.',{exact:true}).waitFor();await shot(buyer,'restart-shared-answer')
    await openRequest(supplier);await supplier.getByRole('button',{name:'My quotes',exact:true}).click();await supplier.getByText('Request revision 2',{exact:true}).waitFor();await shot(supplier,'restart-current-rebid')
    await openRequest(second);await second.getByRole('button',{name:'Shared clarifications',exact:true}).click();await second.getByText('Include commissioning, certification and operator training for all twelve panels and two sensors.',{exact:true}).waitFor();await shot(second,'restart-other-supplier')
    assert.deepEqual(errors,[]);const report={ok:true,base,rfqId:previous.rfqId,title,readOnly:true,checks:['Published revision1/2 history survives process restart','Current revision2 quotation remains visible','Reviewed shared answer survives for contractor and both suppliers'],jsErrors:errors,completedAt:new Date().toISOString()};writeFileSync(`${evidence}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
  } else {
  await navigate(buyer, 'Requests'); await buyer.getByRole('button', { name: 'Projects & sections', exact: true }).click()
  await field(buyer, 'Project name').fill(projectName); await field(buyer, 'Default currency').fill('GBP'); await field(buyer, 'Calendar & delivery guidance').fill('Private project note: daytime deliveries after induction.')
  await mutation(buyer, 'save-project', () => buyer.getByRole('button', { name: 'Save project', exact: true }).click())
  await field(buyer, 'Section name').fill('Electrical services'); await field(buyer, 'Section description').fill('First-floor lighting')
  await mutation(buyer, 'save-section', () => buyer.getByRole('button', { name: 'Save section', exact: true }).click())
  await shot(buyer, '01-project-section'); await buyer.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await buyer.getByRole('button', { name: 'New request', exact: true }).click(); await field(buyer, 'Project').selectOption({ label: projectName }); await field(buyer, 'Section').selectOption({ label: 'Electrical services' })
  await field(buyer, 'Request title').fill(title); await field(buyer, 'Project brief').fill('Supply panels. Clarify commissioning before quote; scope may change after room layout review.')
  await buyer.getByLabel('Item 1 description', { exact: true }).fill('40 W LED panel'); await buyer.getByLabel('Item 1 quantity', { exact: true }).fill('10')
  await buyer.locator('.supplier-options label').filter({ hasText: 'supplier@demo.local' }).getByRole('checkbox').check()
  await buyer.locator('.supplier-options label').filter({ hasText: 'supplier2@demo.local' }).getByRole('checkbox').check()
  await fillDeclaredScope(buyer)
  const created = await mutation(buyer, 'create-rfq', () => buyer.getByRole('button', { name: 'Save request draft', exact: true }).click())
  assert.equal(created.rfq.currency, 'GBP'); assert.equal(created.rfq.projectName, projectName)
  await buyer.getByRole('button', { name: 'Publish request', exact: true }).click(); await confirm(buyer, 'publish-rfq')
  await shot(buyer, '02-published-scope'); checks.push('GUI project and section; private draft; reviewed publication to both suppliers')
  await openRequest(supplier); await supplier.getByRole('button', { name: 'Prepare quote', exact: true }).click()
  await supplier.getByLabel('Unit price for 40 W LED panel', { exact: true }).fill('20'); await supplier.getByLabel('Private cost for 40 W LED panel', { exact: true }).fill('12')
  const draft = await mutation(supplier, 'save-quote', () => supplier.getByRole('button', { name: 'Save quotation draft', exact: true }).click())
  await supplier.getByRole('button', { name: 'Review & submit', exact: true }).click(); await confirm(supplier, 'submit-quote')
  await supplier.getByRole('button', { name: 'Shared clarifications', exact: true }).click(); await supplier.getByRole('button', { name: 'Ask a clarification', exact: true }).click()
  await field(supplier, 'Clarification question').fill('Does the scope include commissioning and certification?')
  await supplier.getByRole('checkbox', { name: '40 W LED panel', exact: true }).check(); await supplier.getByRole('button', { name: 'Review question', exact: true }).click()
  await shot(supplier, '03-question-human-review'); await mutation(supplier, 'ask-clarification', () => supplier.getByRole('button', { name: 'Confirm & send question', exact: true }).click())
  await openRequest(buyer); await buyer.getByRole('button', { name: 'Shared clarifications', exact: true }).click()
  await buyer.getByRole('button', { name: 'Draft an answer', exact: true }).click(); await field(buyer, 'Draft answer').fill('Include commissioning, certification and operator training in the quoted price.')
  await mutation(buyer, 'save-clarification-answer', () => buyer.getByRole('button', { name: 'Save private answer', exact: true }).click())
  await openRequest(second); await second.getByRole('button', { name: 'Shared clarifications', exact: true }).click()
  assert.equal(await second.getByText('Include commissioning, certification and operator training in the quoted price.', { exact: true }).count(), 0)
  await buyer.getByRole('button', { name: 'Review & broadcast answer', exact: true }).click(); await shot(buyer, '04-answer-human-review'); await confirm(buyer, 'broadcast-clarification')
  await buyer.getByRole('button', { name: 'Save answer to FAQ', exact: true }).click(); await buyer.getByRole('button', { name: 'Saved in FAQ', exact: true }).waitFor()
  await openRequest(second); await second.getByRole('button', { name: 'Shared clarifications', exact: true }).click(); await second.getByText('Include commissioning, certification and operator training in the quoted price.', { exact: true }).waitFor()
  await shot(second, '05-shared-answer-other-supplier'); checks.push('Submitted quote; private supplier question and buyer answer; explicit broadcast received by second supplier; source-linked FAQ')
  await buyer.getByRole('button', { name: 'Draft amendment', exact: true }).click(); await field(buyer, 'Reason for amendment').fill('Updated room plan requires two more panels and occupancy sensors.')
  await buyer.getByLabel('Item 1 quantity', { exact: true }).fill('12'); await buyer.getByRole('button', { name: 'Add item', exact: true }).click()
  await buyer.getByLabel('Item 2 description', { exact: true }).fill('Occupancy sensor'); await buyer.getByLabel('Item 2 quantity', { exact: true }).fill('2')
  await buyer.getByLabel('Item 2 measurement rule',{exact:true}).selectOption({label:'Authored fixture quantity · each'})
  await buyer.getByLabel('Item 2 responsibility interface',{exact:true}).selectOption({label:'Supply the authored request items · Supplier'})
  const amendment = await mutation(buyer, 'save-amendment', () => buyer.getByRole('button', { name: 'Save amendment draft', exact: true }).click())
  await shot(buyer, '06-private-amendment-delta'); await buyer.getByRole('button', { name: 'Review & publish amendment', exact: true }).click(); await confirm(buyer, 'publish-amendment')
  await buyer.getByRole('button', { name: 'Compare offers', exact: true }).click(); await buyer.getByText('Rebid needed · scope changed', { exact: true }).waitFor()
  assert.equal(await buyer.getByRole('button', { name: 'Awaiting current rebid', exact: true }).isDisabled(), true)
  await shot(buyer, '07-old-quote-blocked'); checks.push('Private amendment delta review; published revision2; old quote visibly retained and award disabled')
  await openRequest(supplier); await supplier.getByRole('button', { name: 'Shared clarifications', exact: true }).click(); await supplier.getByText(/Request amended to revision 2/).waitFor()
  await shot(supplier, '08-question-reopened'); await supplier.getByRole('button', { name: 'My quotes', exact: true }).click(); await supplier.getByRole('button', { name: 'Prepare rebid', exact: true }).click()
  assert.equal(await supplier.getByLabel('Unit price for 40 W LED panel', { exact: true }).inputValue(), '20')
  assert.equal(await supplier.getByLabel('Unit price for Occupancy sensor', { exact: true }).inputValue(), '')
  await supplier.getByLabel('Unit price for Occupancy sensor', { exact: true }).fill('30'); await shot(supplier, '09-rebid-current-scope')
  const rebid = await mutation(supplier, 'save-quote', () => supplier.getByRole('button', { name: 'Save quotation draft', exact: true }).click())
  assert.equal(rebid.quote.rfqRevision, 2); assert.equal(rebid.quote.total, 300)
  await supplier.getByRole('button', { name: 'Review & submit', exact: true }).click(); await confirm(supplier, 'submit-quote')
  await openRequest(buyer); await buyer.getByRole('button', { name: 'Compare offers', exact: true }).click(); await buyer.getByRole('button', { name: 'Propose award', exact: true }).waitFor()
  assert.equal(await buyer.getByRole('button', { name: 'Propose award', exact: true }).isEnabled(), true)
  await shot(buyer, '10-current-rebid-comparable')
  await buyer.getByRole('button', { name: 'Shared clarifications', exact: true }).click(); await buyer.getByRole('button', { name: 'Draft an answer', exact: true }).click()
  await field(buyer, 'Reuse a saved FAQ').selectOption({ label: 'Does the scope include commissioning and certification?' })
  assert.match(await field(buyer, 'Draft answer').inputValue(), /operator training/)
  await field(buyer, 'Draft answer').fill('Include commissioning, certification and operator training for all twelve panels and two sensors.')
  await mutation(buyer, 'save-clarification-answer', () => buyer.getByRole('button', { name: 'Save private answer', exact: true }).click())
  await buyer.getByRole('button', { name: 'Review & broadcast answer', exact: true }).click(); await confirm(buyer, 'broadcast-clarification')
  await shot(buyer, '11-faq-reuse-reviewed'); checks.push('Amendment reopens prior answer; rebid keeps old prices by itemID and new item blank; revision2 quote becomes comparable; FAQ reused and re-reviewed')
  await buyer.setViewportSize({ width: 390, height: 844 }); await buyer.getByRole('button', { name: 'Revisions', exact: true }).click(); await shot(buyer, '12-mobile-revision-history')
  const overflow = await buyer.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)
  assert.equal(overflow, false, 'Mobile page must not horizontally overflow')
  assert.deepEqual(errors, [])
  const report = { ok: true, base, title, projectName, rfqId: created.rfq.id, firstQuoteId: draft.quote.id, amendmentId: amendment.amendment.id, rebidQuoteId: rebid.quote.id, checks, jsErrors: errors, mobileOverflow: overflow, completedAt: new Date().toISOString() }
  writeFileSync(`${evidence}/report.json`, JSON.stringify(report, null, 2) + '\n'); writeFileSync(`${evidence}/responses.json`, JSON.stringify(receipts, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  }
} catch (error) {
  for (const [i, page] of pages.entries()) { await shot(page, `failure-${i}`).catch(() => {}); writeFileSync(`${evidence}/failure-${i}.txt`, await page.locator('body').innerText().catch(() => '')) }
  writeFileSync(`${evidence}/failure.json`, JSON.stringify({ error: error.stack, checks, errors, receipts }, null, 2) + '\n'); throw error
} finally { await browser.close() }
