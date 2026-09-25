// Read-only revisit of the receipts left by browser.mjs after fixture connections are removed.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from '../../../../host/node_modules/playwright/index.mjs'

const baseUrl = process.env.QUOTAGENT_BROWSER_URL || 'http://127.0.0.1:8620/quotagent/'
const evidence = process.env.QUOTAGENT_CONNECTION_EVIDENCE || 'tmp/product-evidence/agent-connections/removed-history'
mkdirSync(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(baseUrl)
  await page.getByLabel('Email address').fill(process.env.QUOTAGENT_BROWSER_EMAIL || 'contractor@demo.local')
  await page.getByLabel('Password', { exact: true }).fill(process.env.QUOTAGENT_BROWSER_PASSWORD || 'demo1234')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  for (const protocol of ['MCP', 'A2A']) {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Review actions', exact: true }).click()
    await page.getByRole('button', { name: 'All activity', exact: true }).click()
    await page.locator('.review-list-row').filter({ hasText: new RegExp(`${protocol === 'MCP' ? 'Call tool at' : 'Send task to'} Local protocol.*${protocol}`) }).first().click()
    await page.getByRole('button', { name: 'Open connection results', exact: true }).click()
    const detail = page.locator('.connection-detail')
    await detail.getByText('Removed', { exact: true }).waitFor()
    await detail.getByText('This connection was removed.', { exact: false }).waitFor()
    assert.match(await detail.innerText(), protocol === 'MCP' ? /2520/ : /120 USD/)
    assert.equal(await detail.getByRole('button').count(), 0, 'Removed history has no settings, edit or remote-operation buttons')
    assert.equal(await page.locator('.connections-list button').filter({ hasText: /Local protocol/ }).count(), 0, 'Removed fixtures stay out of the active connection list')
    await page.screenshot({ path: `${evidence}/${protocol.toLowerCase()}-removed-history.png`, fullPage: true })
    checks.push(`${protocol} completed receipt opens owner-readable removed history with results and no operations`)
  }
  assert.deepEqual(errors, [])
  const report = { ok: true, baseUrl, checks, javascriptErrors: errors, checkedAt: new Date().toISOString() }
  writeFileSync(`${evidence}/report.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await browser.close() }
