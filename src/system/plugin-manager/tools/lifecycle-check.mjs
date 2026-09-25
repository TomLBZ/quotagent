/** Focused Cordis lifecycle check; no model request or real account state. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '../../../../host/node_modules/cordis/lib/index.js'
import * as manager from '../code/index.mjs'
import * as agent from '../../agent-runtime/code/product.mjs'
import * as studio from '../../plugin-studio/code/product.mjs'
import * as settings from '../../settings/code/index.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
mkdirSync(resolve(root, 'tmp'), { recursive: true })
const data = mkdtempSync(resolve(root, 'tmp/plugin-manager-'))
const ctx = new Context()
const routes = []
const register = (list, item) => { list.push(item); return () => { const index = list.indexOf(item); if (index >= 0) list.splice(index, 1) } }
const core = await ctx.plugin({ name: 'check-core', apply(child) {
  child.provide('web', { route: (method, path, handler, options) => register(routes, { method, path, handler, options }),
    contribute: () => () => {}, extension: () => () => {} })
  child.provide('store', { root: data, list: () => [], get: () => null })
  child.provide('accounts', { get: () => ({ preferences: {} }), can: () => true })
} })
const settingsFiber = await ctx.plugin(settings)
const baseRoutes = routes.length
const providerConfig = { configFile: join(data, 'unconfigured-model.yaml') }
let managerFiber = await ctx.plugin(manager)
let agentFiber = await ctx.plugin(agent, providerConfig)
let studioFiber = await ctx.plugin(studio)
ctx.plugins.register({ id: 'agent-runtime', module: agent, fiber: agentFiber, config: providerConfig, provides: ['ai', 'assistant'], configurationId: 'ai' })
ctx.plugins.register({ id: 'plugin-studio', module: studio, fiber: studioFiber })
const admin = { id: 'admin-check', role: 'admin' }
let rows = ctx.plugins.list(admin)
assert.equal(rows.find(row => row.id === 'agent-runtime').status, 'active')
assert.equal(rows.find(row => row.id === 'agent-runtime').configurable, true)
assert(rows.some(row => row.parentId === 'agent-runtime' && row.provides.includes('ai')))
assert(rows.some(row => row.parentId === 'agent-runtime' && row.provides.includes('assistant')))
assert(rows.some(row => row.parentId === 'plugin-studio' && row.provides.includes('studioRuntime')))
assert(rows.some(row => row.repoId === 'system/mail' && row.status === 'available' && !row.lifecycleAllowed))
assert(routes.find(row => row.path === '/plugins' && row.options.admin))
const activeRoutes = routes.length
await assert.rejects(ctx.plugins.setEnabled('agent-runtime', false), /dependent plugins first/)
await ctx.plugins.setEnabled('plugin-studio', false)
assert.equal(ctx.get('studioRuntime'), undefined)
assert(routes.length < activeRoutes)
await ctx.plugins.setEnabled('agent-runtime', false)
assert.equal(ctx.get('ai'), undefined)
assert.equal(ctx.get('assistant'), undefined)
assert.equal(ctx.plugins.enabled('agent-runtime'), false)
await assert.rejects(ctx.plugins.setEnabled('plugin-studio', true), /required services first/)
await managerFiber.dispose()
managerFiber = await ctx.plugin(manager)
assert.equal(ctx.plugins.enabled('agent-runtime'), false)
assert.equal(ctx.plugins.enabled('plugin-studio'), false)
ctx.plugins.register({ id: 'agent-runtime', module: agent, fiber: null, config: providerConfig, provides: ['ai', 'assistant'], configurationId: 'ai' })
ctx.plugins.register({ id: 'plugin-studio', module: studio, fiber: null })
await ctx.plugins.setEnabled('agent-runtime', true)
await ctx.plugins.setEnabled('plugin-studio', true)
assert(ctx.get('ai'))
assert(ctx.get('studioRuntime'))
assert.equal(routes.length, activeRoutes)
rows = ctx.plugins.list(admin)
const result = { ok: true, checks: ['live nested Cordis inventory', 'configuration association', 'historical mail distinct',
  'admin route ownership', 'dependency refusal', 'actual disposal removes services/routes', 'persisted disable across restart',
  'actual remount restores services/routes', 'manager unload disposes managed fibers'],
  runtime: rows.filter(row => row.status === 'active').map(({ id, provides, parentId }) => ({ id, provides, parentId })),
  repositoryAvailable: rows.filter(row => row.status === 'available').length,
  state: JSON.parse(readFileSync(join(data, 'plugin-manager/state.json'), 'utf8')) }
await managerFiber.dispose()
assert.equal(ctx.get('ai'), undefined)
assert.equal(ctx.get('studioRuntime'), undefined)
assert.equal(routes.length, baseRoutes)
await settingsFiber.dispose()
assert.equal(routes.length, 0)
await core.dispose()
console.log(JSON.stringify(result, null, 2))
