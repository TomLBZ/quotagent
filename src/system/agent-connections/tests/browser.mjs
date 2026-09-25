import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { chromium } = require('playwright')
const base = process.env.QUOTAGENT_BROWSER_URL || 'http://127.0.0.1:8620/quotagent/'
const fixture = process.env.QUOTAGENT_PROTOCOL_FIXTURE_URL || 'http://127.0.0.1:8621'
const evidence = resolve(process.env.QUOTAGENT_CONNECTION_EVIDENCE || 'tmp/product-evidence/agent-connections/local')
mkdirSync(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(18000)
const prefix = `Local protocol ${new Date().toISOString().slice(11, 19)}`, names = { mcp: `${prefix} MCP`, a2a: `${prefix} A2A` }
const screenshot = name => page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true })
const openConnection = async name => { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Agent connections', exact: true }).click(); await page.locator('.connections-list button').filter({ hasText: name }).click(); await page.getByRole('heading', { name, exact: true }).waitFor() }
const approve = async () => { await page.getByRole('heading', { name: 'Review actions', exact: true }).waitFor(); await page.getByRole('button', { name: 'Approve & execute', exact: true }).click(); await page.locator('.review-detail .badge').filter({ hasText: 'succeeded' }).waitFor(); return page.locator('.review-receipt').innerText() }
const addConnection = async (protocol, name, url) => {
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Connection name', { exact: true }).fill(name); await dialog.getByLabel('Protocol', { exact: true }).selectOption(protocol)
  await dialog.getByLabel(protocol === 'mcp' ? 'MCP endpoint URL' : 'Agent base URL', { exact: false }).fill(url)
  await dialog.getByText('Authentication (optional)', { exact: true }).click(); await dialog.getByLabel('Bearer token', { exact: true }).fill('local-fixture-token')
  await dialog.getByRole('button', { name: 'Add connection', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await page.getByRole('heading', { name, exact: true }).waitFor()
  await page.getByRole('button', { name: 'Discover capabilities', exact: true }).click(); await page.getByRole('button', { name: 'Refresh capabilities', exact: true }).waitFor()
}
try {
  await page.goto(base); await page.getByLabel('Email address').fill('contractor@demo.local'); await page.getByLabel('Password', { exact: true }).fill('demo1234'); await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Agent connections', exact: true }).click()
  await addConnection('mcp', names.mcp, `${fixture}/mcp`)
  await page.getByRole('tab', { name: 'Tools (2)', exact: true }).waitFor(); checks.push('MCP connection creation and real discovery from GUI')
  await page.getByRole('button', { name: 'Credentials', exact: true }).click(); await page.getByText('A token is saved.', { exact: true }).waitFor(); assert.equal(await page.getByRole('dialog').getByLabel('Bearer token', { exact: false }).inputValue(), ''); await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); checks.push('Saved credential is masked in account settings')
  await page.getByRole('tab', { name: 'Resources (1)' }).click(); await page.getByRole('button', { name: 'Read resource', exact: true }).click(); await page.getByText('Allow 3 working days for delivery. Confirm unloading access.', { exact: true }).first().waitFor()
  await page.getByRole('tab', { name: 'Prompts (1)' }).click(); await page.locator('.connection-capabilities summary').filter({ hasText: 'quote-checklist' }).click(); await page.getByLabel('project', { exact: true }).fill('School extension'); await page.getByRole('button', { name: 'Get prompt', exact: true }).click(); await page.getByText('Review School extension: quantities, freight, tax, lead time, exclusions.', { exact: true }).first().waitFor(); checks.push('Resource reading and prompt arguments return real remote content')
  await page.getByRole('tab', { name: 'Tools (2)' }).click(); await page.locator('.connection-capabilities summary').filter({ hasText: 'Landed cost' }).click(); await page.getByLabel('quantity', { exact: true }).fill('30'); await page.getByLabel('unitPrice', { exact: true }).fill('80'); await page.getByLabel('freight', { exact: true }).fill('120'); await screenshot('mcp-discovery-form')
  await page.getByRole('button', { name: 'Review tool call', exact: true }).click(); await page.locator('.review-exact').filter({ hasText: 'landed_cost' }).waitFor(); await screenshot('mcp-review'); assert.match(await approve(), /2520/); await screenshot('mcp-result'); checks.push('Reviewed MCP tool invocation produces 2520 and durable receipt')
  await openConnection(names.mcp)
  await addConnection('a2a', names.a2a, fixture); await page.getByRole('heading', { name: 'Local freight specialist', exact: true }).waitFor(); await page.getByLabel('Task for the remote agent', { exact: false }).fill('Estimate freight for 30 panels.'); await screenshot('a2a-card'); await page.getByRole('button', { name: 'Review and send task', exact: true }).click(); assert.match(await approve(), /TASK_STATE_INPUT_REQUIRED/)
  await openConnection(names.a2a); await page.getByText('Which delivery city should I use?', { exact: true }).first().waitFor(); await screenshot('a2a-input-required'); await page.getByRole('button', { name: 'Refresh task', exact: true }).click(); await page.getByLabel('Your reply', { exact: true }).fill('London'); await page.getByRole('button', { name: 'Review reply', exact: true }).click(); assert.match(await approve(), /TASK_STATE_COMPLETED/)
  await openConnection(names.a2a); await page.getByText('Confirmed delivery location: London. Estimated freight: 120 USD.', { exact: true }).first().waitFor(); await screenshot('a2a-completed'); checks.push('A2A input-required status, real query, reviewed same-task reply and artifact')
  await page.getByLabel('Task for the remote agent', { exact: false }).fill('wait for longer freight research'); await page.getByRole('button', { name: 'Review and send task', exact: true }).click(); assert.match(await approve(), /TASK_STATE_WORKING/); await openConnection(names.a2a); await page.getByRole('button', { name: 'Review cancellation', exact: true }).click(); assert.match(await approve(), /TASK_STATE_CANCELED/); checks.push('A2A task cancellation requires review and changes remote task state')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('button', { name: /I’m a supplier/ }).click(); await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Agent connections', exact: true }).click(); assert.equal(await page.getByText(names.mcp, { exact: true }).count(), 0); assert.equal(await page.getByText(names.a2a, { exact: true }).count(), 0); checks.push('Supplier account cannot see contractor connections')
  await screenshot('supplier-private'); assert.deepEqual(errors, [])
  const report = { ok: true, base, fixture, names, checks, jsErrors: errors, checkedAt: new Date().toISOString() }; writeFileSync(`${evidence}/report.json`, pretty(report)); console.log(JSON.stringify(report))
} catch (error) { await screenshot('failure').catch(() => {}); writeFileSync(`${evidence}/failure.json`, pretty({ error: error.message, checks, errors, text: await page.locator('body').innerText() })); throw error }
finally { await browser.close() }
function pretty(value) { return JSON.stringify(value, null, 2) + '\n' }
