// Real official-SDK protocol fixtures. Deterministic local services, not AI providers.
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server')
const { z } = require('zod')
const { AgentCard, Task, TaskStatusUpdateEvent, TaskState } = require('@a2a-js/sdk')
const { DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext, AgentEvent } = require('@a2a-js/sdk/server')
export async function startFixtures({ port = 0, token = 'local-fixture-token', host = '127.0.0.1' } = {}) {
  const calls = [], sockets = new Set(), legacy = new Map()
  const makeMcp = () => {
    const server = new McpServer({ name: 'Quotagent local quotation tools', version: '1.0.0' })
    server.registerTool('landed_cost', { title: 'Landed cost', description: 'Local protocol fixture: calculate quantity × unit price + freight.', inputSchema: z.object({ quantity: z.number(), unitPrice: z.number(), freight: z.number() }), annotations: { readOnlyHint: true } }, async input => { calls.push({ kind: 'tool', input }); const total = input.quantity * input.unitPrice + input.freight; return { content: [{ type: 'text', text: `Landed cost: ${total}` }], structuredContent: { total } } })
    server.registerTool('refuse', { description: 'Return a tool failure for error handling verification.' }, async () => ({ isError: true, content: [{ type: 'text', text: 'Fixture refused this operation.' }] }))
    server.registerResource('delivery-guide', 'fixture://delivery-guide', { description: 'Delivery guidance from the local fixture.', mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, text: 'Allow 3 working days for delivery. Confirm unloading access.', mimeType: 'text/plain' }] }))
    server.registerPrompt('quote-checklist', { description: 'Prepare a quotation completeness checklist.', argsSchema: z.object({ project: z.string() }) }, ({ project }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review ${project}: quantities, freight, tax, lead time, exclusions.` } }] }))
    return server
  }
  const modern = createMcpHandler(makeMcp, { responseMode: 'sse', legacy: 'stateless' })
  let baseUrl, a2a, card
  const taskStore = new InMemoryTaskStore()
  const executor = {
    async execute(context, bus) {
      const user = context.userMessage, text = user.parts.map(part => part.content?.value || '').join(' ')
      calls.push({ kind: 'a2a-send', input: text, taskId: context.taskId, contextId: context.contextId })
      const waiting = text.includes('wait'), continuation = Boolean(context.task)
      const state = waiting ? 'TASK_STATE_WORKING' : continuation ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_INPUT_REQUIRED'
      const answer = waiting ? 'Research is in progress.' : continuation ? `Confirmed delivery location: ${text}. Estimated freight: 120 USD.` : 'Which delivery city should I use?'
      const task = Task.fromJSON({ id: context.taskId, contextId: context.contextId, status: { state, timestamp: new Date().toISOString(), message: { messageId: randomUUID(), role: 'ROLE_AGENT', taskId: context.taskId, contextId: context.contextId, parts: [{ text: answer }] } }, history: [...(context.task?.history || []).map(message => ({ ...message })), user], artifacts: continuation ? [{ artifactId: randomUUID(), name: 'Freight estimate', parts: [{ text: answer }] }] : [] })
      // fromJSON expects wire messages; retain already-decoded message history explicitly.
      task.history = [...(context.task?.history || []), user]
      bus.publish(AgentEvent.task(task))
    },
    async cancelTask(taskId, bus) {
      calls.push({ kind: 'a2a-cancel', taskId })
      bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId, status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() } })))
      bus.finished()
    },
  }
  const server = createServer(async (req, res) => {
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Fixture requires its test bearer token."}'); return }
      const url = new URL(req.url, baseUrl)
      if (url.pathname === '/.well-known/agent-card.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(AgentCard.toJSON(card))); return }
      if (url.pathname === '/sse' && req.method === 'GET') {
        const id = randomUUID(), sdk = makeMcp()
        const transport = { start: async () => {}, send: async message => { res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`) }, close: async () => { res.end(); legacy.delete(id) } }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`)
        await sdk.connect(transport); legacy.set(id, { sdk, transport }); req.on('close', () => { legacy.delete(id); sdk.close().catch(() => {}) }); return
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      if (url.pathname === '/messages') { const session = legacy.get(url.searchParams.get('sessionId')); if (!session) { res.writeHead(404); res.end(); return } session.transport.onmessage?.(JSON.parse(body)); res.writeHead(202); res.end(); return }
      if (url.pathname === '/a2a') {
        const response = await a2a.handle(body.toString(), new ServerCallContext({ requestedVersion: req.headers['a2a-version'] || '1.0' }))
        res.writeHead(200, { 'content-type': 'application/json', 'A2A-Version': '1.0' }); res.end(JSON.stringify(response)); return
      }
      if (url.pathname === '/mcp') {
        const request = new Request(url, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body }) })
        const response = await modern.fetch(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body) for await (const chunk of response.body) res.write(chunk)
        res.end(); return
      }
      res.writeHead(404); res.end('Not found')
    } catch (error) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(port, host, resolve)); baseUrl = `http://${host}:${server.address().port}`
  card = AgentCard.fromJSON({ name: 'Local freight specialist', description: 'Deterministic A2A protocol fixture: requests a delivery city, then returns a freight estimate. No external messages or commitments.', version: '1.0.0', supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'freight', name: 'Freight estimate', description: 'Ask for an estimate, then reply with the delivery city.', tags: ['quotation', 'delivery'], examples: ['Estimate freight for 30 panels.'] }] })
  const handler = new DefaultRequestHandler(card, taskStore, executor, undefined, undefined, undefined, undefined, undefined, { keepBusAliveStates: [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_WORKING] })
  a2a = new JsonRpcTransportHandler(handler)
  return { baseUrl, token, calls, close: async () => { for (const session of legacy.values()) await session.sdk.close(); await modern.close?.(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixtures({ port: Number(process.env.QUOTAGENT_FIXTURE_PORT || 8621), token: process.env.QUOTAGENT_FIXTURE_TOKEN || 'local-fixture-token' })
  console.log(JSON.stringify({ fixture: 'official-sdk-local-only', url: fixture.baseUrl, mcp: `${fixture.baseUrl}/mcp`, legacySse: `${fixture.baseUrl}/sse`, a2a: fixture.baseUrl }))
  process.on('SIGTERM', async () => { await fixture.close(); process.exit() })
}
