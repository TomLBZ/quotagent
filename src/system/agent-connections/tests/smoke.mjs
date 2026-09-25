import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import * as store from '../../workspace-store/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as actions from '../../action-center/code/index.mjs'
import * as notifications from '../../notifications/code/index.mjs'
import * as connections from '../code/index.mjs'
import { startFixtures } from './fixtures.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { Context } = require('cordis')
const fixture = await startFixtures(), ctx = new Context(), routes = [], tools = [], nav = [], fibers = []
const users = [{ id: 'connection-buyer', name: 'Buyer', role: 'contractor' }, { id: 'connection-supplier', name: 'Supplier', role: 'supplier' }, { id: 'connection-admin', name: 'Admin', role: 'admin' }], [buyer, supplier, admin] = users
const add = (list, value) => { list.push(value); return () => list.splice(list.indexOf(value), 1) }
const mount = async (...args) => { const fiber = await ctx.plugin(...args); fibers.push(fiber); return fiber }
mkdirSync('tmp', { recursive: true }); const root = mkdtempSync(resolve('tmp/connections-smoke-'))
try {
  await mount({ name: 'fixture-services', apply(ctx) { ctx.provide('accounts', { list: () => structuredClone(users), get: id => users.find(user => user.id === id), can: () => true }); ctx.provide('web', { route: (...args) => add(routes, args), contribute: item => add(nav, item) }); ctx.provide('assistant', { tool: item => add(tools, item) }) } })
  await mount(store, { root }); await mount(settings); await mount(notifications); await mount(actions)
  const fiber = await mount(connections)
  const create = async (protocol, path, transport) => (await ctx.connections.save(buyer, { name: `${protocol}-${transport || 'auto'}`, protocol, transport, url: fixture.baseUrl + path, credentials: { bearerToken: fixture.token } })).connection
  const modern = await create('mcp', '/mcp', 'streamable-http')
  const discovery = await ctx.connections.discover(buyer, modern.id)
  assert.equal(discovery.connection.discovery.tools.length, 2); assert.equal(discovery.connection.discovery.resources.length, 1); assert.equal(discovery.connection.discovery.prompts.length, 1)
  const resource = await ctx.connections.run(buyer, modern.id, { operation: 'resource', input: { uri: 'fixture://delivery-guide' } }); assert.match(resource.result.contents[0].text, /3 working days/)
  const prompt = await ctx.connections.run(buyer, modern.id, { operation: 'prompt', input: { name: 'quote-checklist', arguments: { project: 'Warehouse' } } }); assert.match(prompt.result.messages[0].content.text, /Warehouse/)
  const proposal = await ctx.connections.run(buyer, modern.id, { operation: 'tool', input: { name: 'landed_cost', arguments: { quantity: 30, unitPrice: 80, freight: 120 } } })
  assert.equal(proposal.approval.source.kind, 'human')
  assert.equal(fixture.calls.length, 0, 'No outbound tool invocation before human review')
  const approved = await ctx.actions.approve(buyer, proposal.approval.id, { confirmed: true })
  assert.equal(approved.status, 'succeeded', approved.error); assert.equal(approved.result.result.structuredContent.total, 2520)
  await ctx.actions.approve(buyer, proposal.approval.id, { confirmed: true }); assert.equal(fixture.calls.length, 1, 'Repeated approval does not repeat remote call')
  const refusal = await ctx.connections.run(buyer, modern.id, { operation: 'tool', input: { name: 'refuse', arguments: {} } })
  assert.equal((await ctx.actions.approve(buyer, refusal.approval.id, { confirmed: true })).status, 'failed')
  const legacy = await create('mcp', '/sse', 'sse'); await ctx.connections.discover(buyer, legacy.id)
  const legacyCall = await ctx.connections.run(buyer, legacy.id, { operation: 'tool', input: { name: 'landed_cost', arguments: { quantity: 2, unitPrice: 10, freight: 5 } } })
  assert.equal((await ctx.actions.approve(buyer, legacyCall.approval.id, { confirmed: true })).result.result.structuredContent.total, 25)
  const a2a = await create('a2a', '', 'auto'), card = await ctx.connections.discover(buyer, a2a.id)
  assert.equal(card.connection.discovery.protocolVersion, '1.0'); assert.equal(card.connection.discovery.card.skills[0].id, 'freight')
  const send = await ctx.connections.run(buyer, a2a.id, { operation: 'send', input: { message: 'Estimate freight for 30 panels.' } })
  const sent = await ctx.actions.approve(buyer, send.approval.id, { confirmed: true }); assert.equal(sent.status, 'succeeded', sent.error)
  const task = sent.result.task; assert.equal(task.status, 'TASK_STATE_INPUT_REQUIRED')
  const queried = await ctx.connections.run(buyer, a2a.id, { operation: 'query', input: { taskId: task.id } }); assert.equal(queried.task.remoteTaskId, task.remoteTaskId)
  const reply = await ctx.connections.run(buyer, a2a.id, { operation: 'send', input: { taskId: task.id, message: 'London' } })
  const completed = await ctx.actions.approve(buyer, reply.approval.id, { confirmed: true }); assert.equal(completed.status, 'succeeded', completed.error); assert.equal(completed.result.task.status, 'TASK_STATE_COMPLETED'); assert.equal(completed.result.task.remoteTaskId, task.remoteTaskId); assert.match(completed.result.task.task.artifacts[0].parts[0].text, /120 USD/)
  const working = await ctx.connections.run(buyer, a2a.id, { operation: 'send', input: { message: 'wait for a longer research task' } }), work = await ctx.actions.approve(buyer, working.approval.id, { confirmed: true })
  const cancellation = await ctx.connections.run(buyer, a2a.id, { operation: 'cancel', input: { taskId: work.result.task.id } }), canceled = await ctx.actions.approve(buyer, cancellation.approval.id, { confirmed: true })
  assert.equal(canceled.status, 'succeeded', canceled.error); assert.equal(canceled.result.task.status, 'TASK_STATE_CANCELED')
  assert.equal(ctx.connections.list(supplier).length, 0); assert.throws(() => ctx.connections.get(supplier, modern.id), /not found/)
  assert.throws(() => ctx.settings.get(supplier, modern.configurationId), /account|available|owner|access/i)
  assert.ok(!ctx.settings.list(admin).some(schema => schema.id === modern.configurationId), 'Admin does not inherit private connection credentials')
  assert.ok(!JSON.stringify(ctx.store.events(buyer.id)).includes(fixture.token), 'Credentials are absent from the ledger')
  assert.ok(ctx.notifications.list(buyer).some(row => /needs your input/.test(row.title)))
  assert.equal(tools.filter(tool => tool.name.includes('agent_connection')).length, 4)
  const history = await tools.find(tool => tool.name === 'read_agent_connection').execute(buyer, { connectionId: a2a.id, operation: 'history', input: {} })
  assert.equal(history.tasks.length, 2); assert.equal(history.trust, 'external'); assert.equal(approved.result.action.input.view, 'connections')
  const delegated = await tools.find(tool => tool.name === 'propose_agent_connection_call').execute(buyer, { connectionId: modern.id, operation: 'tool', input: { name: 'landed_cost', arguments: { quantity: 1, unitPrice: 2, freight: 3 } } }, { source: 'workflow', runId: 'protocol-smoke-run', stepId: 'cost' })
  assert.equal(delegated.approval.runId, 'protocol-smoke-run'); assert.equal(delegated.approval.source.kind, 'workflow'); assert.equal(delegated.approval.source.stepId, 'cost')
  await fiber.dispose(); assert.ok(!routes.some(([, path]) => path.startsWith('/connections'))); assert.ok(!tools.some(tool => tool.name.includes('agent_connection')))
  const restored = await mount(connections); assert.ok(ctx.settings.list(buyer).some(schema => schema.id === modern.configurationId)); assert.equal(ctx.connections.detail(buyer, a2a.id).tasks.length, 2); await restored.dispose()
  console.log(JSON.stringify({ ok: true, root, checks: ['official SDK MCP2026 StreamableHTTP SSE responses and legacy SSE', 'tools/resources/prompts discovery and real calls', 'review-before-call and no duplicate approval', 'tool errors fail actions', 'A2A1.0 card, send, query, input-required reply, artifacts, cancel', 'private connection settings and credential-free ledger', 'notifications, restart recovery, complete effect disposal'], remoteCalls: fixture.calls.length }))
} finally { for (const fiber of fibers.reverse()) await fiber.dispose(); await fixture.close() }
