import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from '../../../../host/node_modules/playwright/index.mjs'
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8620/quotagent/'
const directory = process.env.EVIDENCE_DIR || 'tmp/agent-experience/usage/browser'
mkdirSync(directory, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })
const checks = [], errors = [], contexts = []
const number = value => new Intl.NumberFormat().format(value)
async function login(email) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); contexts.push(context)
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
  await page.goto(baseUrl); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill('demo1234'); await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.locator('.sidebar').waitFor()
  const usageButton = page.locator('.sidebar').getByRole('button', { name: 'AI usage', exact: true })
  for (const name of ['Personalize', 'More tools']) {
    if (await usageButton.isVisible()) break
    const group = page.locator('.sidebar').getByRole('button', { name, exact: true })
    if (await group.isVisible() && await group.getAttribute('aria-expanded') !== 'true') await group.click()
  }
  await usageButton.click()
  await page.locator('.usage-summary').waitFor(); return page
}
async function apply(page) { const loaded = page.waitForResponse(response => response.url().includes('/api/usage?') && response.status() === 200); await page.getByRole('button', { name: 'Apply filters', exact: true }).click(); await loaded; await page.locator('.usage-summary').waitFor() }
try {
  const page = await login('contractor@demo.local')
  const own = await (await page.request.get(new URL('api/usage', baseUrl).href)).json()
  assert.ok(own.summary.calls > 0); assert.ok(own.summary.tokens.total.value > 0)
  assert.equal(await page.locator('.usage-stat').first().locator('strong').innerText(), number(own.summary.calls))
  assert.ok((await page.locator('.usage-stat').nth(1).innerText()).includes(number(own.summary.tokens.total.value)))
  assert.equal(await page.getByLabel('Usage scope', { exact: true }).count(), 0)
  assert.equal((await page.request.get(new URL('api/usage?scope=all', baseUrl).href)).status(), 403)
  await page.screenshot({ path: `${directory}/account-usage.png`, fullPage: true }); checks.push('Actual account history and reported token totals displayed; aggregate access denied')
  await page.getByLabel('Chart metric', { exact: true }).selectOption('cachedInput')
  assert.equal(await page.locator('.usage-chart').getAttribute('aria-label'), 'Cached input by UTC date')
  await page.getByLabel('Group by', { exact: true }).selectOption('Purpose')
  assert.ok(await page.locator('.usage-breakdown tbody tr').count() > 0)
  await page.getByLabel('Model', { exact: true }).selectOption(own.options.model[0]); await apply(page)
  await page.getByLabel('Status', { exact: true }).selectOption('failed'); await apply(page)
  assert.match(await page.locator('.usage-coverage').innerText(), /no reported total/)
  await page.screenshot({ path: `${directory}/unknown-usage.png`, fullPage: true }); checks.push('Model/status filters preserve unknown counts; cache chart and purpose grouping work')
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click(); await page.locator('.usage-day').first().waitFor()
  const firstLabel = await page.locator('.usage-day').first().getAttribute('aria-label'), selectedDay = firstLabel.slice(0, 10)
  await page.locator('.usage-day').first().click(); await page.locator('.usage-summary').waitFor()
  assert.equal(await page.getByLabel('From (UTC)', { exact: true }).inputValue(), selectedDay)
  assert.equal(await page.getByLabel('To (UTC)', { exact: true }).inputValue(), selectedDay)
  await page.getByRole('button', { name: 'Model settings', exact: true }).click(); await page.getByRole('dialog', { name: 'AI model connection settings', exact: true }).waitFor(); await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  checks.push('Clicking a chart day selects its UTC range; model settings opens directly')
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${directory}/mobile-usage.png`, fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Usage page fits mobile viewport')
  const supplier = await login('supplier@demo.local'), supplierData = await (await supplier.request.get(new URL('api/usage', baseUrl).href)).json()
  assert.equal(await supplier.locator('.usage-stat').first().locator('strong').innerText(), number(supplierData.summary.calls))
  assert.ok(supplierData.calls.every(call => call.accountId === 'supplier-demo')); checks.push('Supplier sees only its own call history')
  const admin = await login('admin@demo.local')
  await admin.getByLabel('Usage scope', { exact: true }).selectOption('all'); await apply(admin)
  await admin.getByLabel('Account', { exact: true }).waitFor(); await admin.getByLabel('Group by', { exact: true }).selectOption('Account')
  assert.ok(await admin.locator('.usage-breakdown tbody tr').count() >= 2)
  await admin.screenshot({ path: `${directory}/admin-aggregate.png`, fullPage: true })
  await admin.getByLabel('Account', { exact: true }).selectOption('supplier-demo'); await apply(admin)
  assert.equal(await admin.locator('.usage-stat').first().locator('strong').innerText(), number(supplierData.summary.calls))
  checks.push('Admin aggregate and account filters match the account-owned usage totals')
  assert.deepEqual(errors, [])
  const report = { ok: true, baseUrl, checks, javascriptErrors: errors, historical: { accountCalls: own.summary.calls, reportedTotal: own.summary.tokens.total.value, unknownCalls: own.summary.unknownCalls }, checkedAt: new Date().toISOString() }
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} finally { for (const context of contexts) await context.close(); await browser.close() }
