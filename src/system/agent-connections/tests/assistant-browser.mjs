// Explicit live-model check. The remote destination is the local protocol fixture.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { chromium } = require('playwright')
const base = process.env.QUOTAGENT_BROWSER_URL || 'http://127.0.0.1:8620/quotagent/', evidence = resolve(process.env.QUOTAGENT_CONNECTION_EVIDENCE || 'tmp/product-evidence/agent-connections/assistant')
mkdirSync(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(20000)
try {
  await page.goto(base); await page.getByLabel('Email address').fill('contractor@demo.local'); await page.getByLabel('Password', { exact: true }).fill('demo1234'); await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Agent connections', exact: true }).click()
  const connection = await page.locator('.connections-list button').filter({ hasText: /Local protocol.*MCP/ }).last().locator('strong').innerText()
  const prompt = `Use my MCP connection named "${connection}" to prepare a landed-cost tool call for my review. Send only quantity 30, unit price 80 and freight 120 to its calculator. Do not send any workspace data. Do not just calculate locally; prepare the remote tool action and stop for my approval.`
  await page.getByRole('textbox', { name: 'Message your AI assistant', exact: true }).fill(prompt)
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/assistant/chat') && response.request().method() === 'POST', { timeout: 180000 })
  await page.getByRole('button', { name: 'Send to AI assistant', exact: true }).click(); const response = await responsePromise, body = await response.json()
  assert.equal(response.status(), 200, body.error)
  const steps = body.toolResults || body.message?.tools || [], proposal = steps.find(step => step.name === 'propose_agent_connection_call')
  assert.ok(proposal?.result?.pending, JSON.stringify(steps.map(step => ({ name: step.name, result: step.result?.error }))))
  assert.equal(proposal.result.approval.input.payload.name, 'landed_cost'); assert.deepEqual(proposal.result.approval.input.payload.arguments, { quantity: 30, unitPrice: 80, freight: 120 })
  await page.getByRole('button', { name: /Review remote action/ }).last().click(); await page.getByRole('heading', { name: 'Review actions', exact: true }).waitFor(); await page.screenshot({ path: `${evidence}/ai-remote-review.png`, fullPage: true })
  await page.getByRole('button', { name: 'Approve & execute', exact: true }).click(); await page.locator('.review-detail .badge').filter({ hasText: 'succeeded' }).waitFor(); assert.match(await page.locator('.review-receipt').innerText(), /2520/)
  await page.screenshot({ path: `${evidence}/ai-remote-result.png`, fullPage: true })
  const report = { ok: true, base, connection, model: body.message?.model, tools: steps.map(step => step.name), approvedResult: 2520, exactOutboundArguments: proposal.result.approval.input.payload.arguments, checkedAt: new Date().toISOString() }
  writeFileSync(`${evidence}/report.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} catch (error) { await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }).catch(() => {}); throw error }
finally { await browser.close() }
