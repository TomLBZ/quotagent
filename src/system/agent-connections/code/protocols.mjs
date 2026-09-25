import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { Client, StreamableHTTPClientTransport, SSEClientTransport } = require('@modelcontextprotocol/client')
const { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } = require('@a2a-js/sdk/client')
const { SendMessageRequest, GetTaskRequest, CancelTaskRequest, Task, Message } = require('@a2a-js/sdk')

export function endpoint(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Enter a complete http:// or https:// endpoint URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP endpoint; enter credentials in the separate credential fields.')
  if (url.hash) throw new Error('Endpoint URLs cannot contain a fragment.')
  if ([...url.searchParams.keys()].some(key => /token|secret|password|api[-_]?key|credential/i.test(key))) throw new Error('Put access tokens in the credential fields, not in the endpoint URL.')
  return url.href
}
export function credentialHeaders(values = {}) {
  let headers = {}
  if (values.headers) {
    try { headers = JSON.parse(values.headers) } catch { throw new Error('Extra headers must be a JSON object of header names and string values.') }
    if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.values(headers).some(value => typeof value !== 'string')) throw new Error('Extra headers must be a JSON object of strings.')
  }
  if (values.bearerToken) headers.Authorization = `Bearer ${values.bearerToken}`
  return Object.fromEntries(new Headers(headers).entries())
}
export function remoteFetch(headers, signal) {
  return async (url, options = {}) => {
    const merged = new Headers(options.headers)
    for (const [key, value] of Object.entries(headers)) merged.set(key, value)
    // A persistent SSE GET must outlive the ordinary request timeout. Bound its
    // connection establishment; the SDK and plugin own the established stream.
    const streamingGet = (!options.method || options.method === 'GET') && merged.get('accept')?.includes('text/event-stream')
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('Remote connection timed out.')), 60000)
    timer.unref?.()
    const signals = [signal, options.signal, streamingGet ? deadline.signal : AbortSignal.timeout(60000)].filter(Boolean)
    try { return await fetch(url, { ...options, headers: merged, redirect: 'error', signal: AbortSignal.any(signals) }) }
    finally { clearTimeout(timer) }
  }
}
const json = value => JSON.parse(JSON.stringify(value))
async function pages(client, method, key) {
  const rows = []; let cursor
  for (let page = 0; page < 20; page++) {
    const result = await client[method](cursor ? { cursor } : {})
    rows.push(...(result[key] || [])); cursor = result.nextCursor
    if (!cursor) return rows
  }
  throw new Error(`The server returned more than 20 pages of ${key}; narrow the server's exposed catalog.`)
}
export async function openMcp(connection, credentials, signal) {
  const headers = credentialHeaders(credentials), fetchImpl = remoteFetch(headers, signal)
  const client = new Client({ name: 'quotagent', version: '1.0.0' }, {
    capabilities: {}, versionNegotiation: { mode: connection.transport === 'sse' ? 'legacy' : 'auto', probe: { timeoutMs: 10000, maxRetries: 0 } },
  })
  const options = { requestInit: { headers }, fetch: fetchImpl }
  const transport = connection.transport === 'sse' ? new SSEClientTransport(new URL(connection.url), options) : new StreamableHTTPClientTransport(new URL(connection.url), options)
  try { await client.connect(transport, { timeout: 20000 }) } catch (error) { await client.close().catch(() => {}); throw error }
  return {
    close: () => client.close(),
    async discover() {
      const capabilities = client.getServerCapabilities() || {}
      const [tools, resources, prompts, resourceTemplates] = await Promise.all([
        capabilities.tools ? pages(client, 'listTools', 'tools') : [],
        capabilities.resources ? pages(client, 'listResources', 'resources') : [],
        capabilities.prompts ? pages(client, 'listPrompts', 'prompts') : [],
        capabilities.resources ? pages(client, 'listResourceTemplates', 'resourceTemplates') : [],
      ])
      return json({ server: client.getServerVersion(), protocolVersion: client.getNegotiatedProtocolVersion(), era: client.getProtocolEra(), capabilities, tools, resources, prompts, resourceTemplates })
    },
    async invoke(operation, input, requestSignal) {
      const options = { signal: requestSignal, timeout: 60000 }
      if (operation === 'tool') return json(await client.callTool({ name: input.name, arguments: input.arguments || {} }, options))
      if (operation === 'resource') return json(await client.readResource({ uri: input.uri }, options))
      if (operation === 'prompt') return json(await client.getPrompt({ name: input.name, arguments: input.arguments || {} }, options))
      throw new Error('Unsupported MCP operation.')
    },
  }
}
export async function openA2a(connection, credentials, signal) {
  const fetchImpl = remoteFetch(credentialHeaders(credentials), signal), legacyCompat = { enabled: true }
  const resolver = new DefaultAgentCardResolver({ fetchImpl, legacyCompat })
  const card = await resolver.resolve(connection.url, connection.cardPath || undefined)
  // Cards can advertise other origins. Credentials are only sent to the configured origin.
  const origin = new URL(connection.url).origin
  const boundFetch = (url, options) => {
    if (new URL(url).origin !== origin) throw new Error('The agent advertises an endpoint on another origin. Configure that origin as a separate connection to authorize its credentials.')
    return fetchImpl(url, options)
  }
  const factory = new ClientFactory({ cardResolver: resolver, transports: [new JsonRpcTransportFactory({ fetchImpl: boundFetch, legacyCompat }), new RestTransportFactory({ fetchImpl: boundFetch, legacyCompat })] })
  const client = await factory.createFromAgentCard(card)
  const taskJson = value => Task.toJSON(value)
  return {
    close: async () => {},
    async discover() { return { card: json(card), protocolVersion: client.protocolVersion, transport: client.transport.protocolName } },
    async invoke(operation, input, requestSignal) {
      const options = { signal: requestSignal }
      if (operation === 'send') {
        const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: input.message }], ...(input.remoteTaskId ? { taskId: input.remoteTaskId, contextId: input.contextId } : {}) }, configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'], historyLength: 20 } })
        const response = await client.sendMessage(request, options)
        // The SDK exposes a task/message result union (not the wire oneof wrapper).
        return 'status' in response ? { task: taskJson(response) } : { message: Message.toJSON(response) }
      }
      if (operation === 'query') return { task: taskJson(await client.getTask(GetTaskRequest.fromJSON({ id: input.remoteTaskId, historyLength: 20 }), options)) }
      if (operation === 'cancel') return { task: taskJson(await client.cancelTask(CancelTaskRequest.fromJSON({ id: input.remoteTaskId }), options)) }
      throw new Error('Unsupported A2A operation.')
    },
  }
}
