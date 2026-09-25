import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'product-plugin-studio'
export const inject = ['web', 'store', 'accounts', 'ai']
export const provides = ['studio']

const COLLECTION = 'studio-plugins'
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max)
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const copy = value => JSON.parse(JSON.stringify(value))
const now = () => new Date().toISOString()
const idOf = () => `plugin-${randomUUID()}`
const COLOR = /^(#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s]+\))$/

const generationPrompt = `You design useful personal plugins for a quotation workspace.
Respond with exactly one JSON object, no markdown: {"name":"short descriptive name","description":"one sentence","kind":"theme|widget|skill","spec":{...}}.
Choose theme for visual customization, widget for a personal dashboard panel, skill for reusable automation/workflow.
Theme spec: {"accent":"#hex","background":"#hex","surface":"#hex","text":"#hex","radius":"12px"}. All colors must be CSS hex colors with strong legibility and pleasant contrast. A theme must respect the user's requested colors/mood.
Widget spec: {"title":"...","body":"helpful content specific to the request","items":["..."]}. Do not invent live business metrics; this is a personal reference panel. For live tasks choose skill.
Skill spec: {"prompt":"a complete reusable instruction for the assistant to execute using its current account's live workspace context and tools","steps":["short action steps"]}. Skills should automate analysis, extraction, draft preparation, and follow-up planning. They cannot publish quotations, award orders, approve changes, or make financial commitments without human review. Incorporate the user's concrete requested routine and preferences.
Generate substantive useful content; do not merely repeat the request. Do not include credentials, file paths, code, or unrelated features.`

function parseDescriptor(message) {
  const text = typeof message === 'string' ? message : String(message?.content ?? '')
  const jsonText = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  let descriptor
  try { descriptor = JSON.parse(jsonText) } catch {
    const start = jsonText.indexOf('{')
    const end = jsonText.lastIndexOf('}')
    try { descriptor = JSON.parse(jsonText.slice(start, end + 1)) } catch {
      fail('The model returned an incomplete plugin. Please retry the request.', 502)
    }
  }
  if (!descriptor || !['theme', 'widget', 'skill'].includes(descriptor.kind)) {
    fail('The model did not return a supported plugin type. Please retry.', 502)
  }
  const result = { name: clean(descriptor.name, 100), description: clean(descriptor.description, 800),
    kind: descriptor.kind, spec: {} }
  if (!result.name) fail('The model returned a plugin without a name. Please retry.', 502)
  const spec = descriptor.spec ?? {}
  if (result.kind === 'theme') {
    for (const key of ['accent', 'background', 'surface', 'text']) {
      if (!COLOR.test(clean(spec[key], 80))) fail(`The generated theme needs a valid ${key} color. Please retry.`, 502)
      result.spec[key] = clean(spec[key], 80)
    }
    const radius = String(spec.radius ?? '12px')
    result.spec.radius = /^\d{1,2}(?:px|rem)$/.test(radius) ? radius : '12px'
  } else if (result.kind === 'widget') {
    result.spec = { title: clean(spec.title || result.name, 160), body: clean(spec.body, 6000),
      items: Array.isArray(spec.items) ? spec.items.slice(0, 20).map(value => clean(value, 500)) : [] }
    if (!result.spec.body && !result.spec.items.length) fail('The generated widget is empty. Please retry.', 502)
  } else {
    result.spec = { prompt: clean(spec.prompt, 12000),
      steps: Array.isArray(spec.steps) ? spec.steps.slice(0, 15).map(value => clean(value, 1000)) : [] }
    if (!result.spec.prompt) fail('The generated skill needs executable instructions. Please retry.', 502)
  }
  return result
}

/** Compile the model-generated descriptor into an executable Cordis plugin.
 * The module itself registers its account-scoped contribution; fiber disposal
 * removes the registration. Its source is persisted and returned for review. */
export function moduleSource(plugin) {
  const descriptor = { id: plugin.id, name: plugin.name, description: plugin.description,
    kind: plugin.kind, spec: plugin.spec, ownerId: plugin.ownerId, global: plugin.global,
    createdAt: plugin.createdAt }
  const scope = plugin.global ? '*' : plugin.ownerId
  return `// Generated from your requested plugin descriptor. Loaded by Cordis.\n`
    + `export const name = ${JSON.stringify(plugin.id)};\n`
    + `export const inject = ['web'];\n`
    + `export const descriptor = ${JSON.stringify(descriptor, null, 2)};\n`
    + `export function apply(ctx) {\n`
    + `  ctx.effect(() => ctx.web.extension(${JSON.stringify(scope)}, descriptor));\n`
    + `}\n`
}

export async function apply(ctx, config = {}) {
  const root = join(config.root ?? ctx.store.root, 'plugin-artifacts')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const mounted = new Map()
  let disposed = false
  let assistant = null
  const records = () => ctx.store.list('system', COLLECTION).filter(plugin => !plugin.deleted)
  const lookup = id => {
    const plugin = ctx.store.get('system', COLLECTION, id)
    if (!plugin || plugin.deleted) fail('Plugin not found.', 404)
    return plugin
  }
  const save = async (plugin, actor, event) => {
    const record = { ...plugin, updatedAt: now() }
    await ctx.store.put('system', COLLECTION, record, { actor, event })
    return record
  }
  const artifactDir = plugin => join(root, plugin.ownerId.replace(/[^\w-]/g, '_'), plugin.id)
  const writeArtifact = plugin => {
    const dir = artifactDir(plugin)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const source = moduleSource(plugin)
    writeFileSync(join(dir, 'index.mjs'), source, { mode: 0o600 })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: plugin.id, version: '1.0.0',
      layer: plugin.global ? 'system' : 'userspace', entry: 'index.mjs', provides: [],
      description: plugin.description, kind: plugin.kind, ownerId: plugin.ownerId }, null, 2) + '\n', { mode: 0o600 })
    if (plugin.kind === 'skill') {
      const skill = `---\nname: ${JSON.stringify(plugin.name)}\ndescription: ${JSON.stringify(plugin.description)}\n---\n\n`
        + `${plugin.spec.prompt}\n\n${(plugin.spec.steps ?? []).map((step, i) => `${i + 1}. ${step}`).join('\n')}\n`
      writeFileSync(join(dir, 'SKILL.md'), skill, { mode: 0o600 })
    }
    return { source, file: join(dir, 'index.mjs') }
  }
  const mount = async plugin => {
    if (disposed) fail('Plugin studio is restarting. Please retry.', 503)
    const previous = mounted.get(plugin.id)
    if (previous) { await previous.dispose(); mounted.delete(plugin.id) }
    const { file } = writeArtifact(plugin)
    const module = await import(`${pathToFileURL(file).href}?v=${randomUUID()}`)
    const fiber = await ctx.plugin(module)
    mounted.set(plugin.id, fiber)
    return fiber
  }
  const unmount = async id => {
    const fiber = mounted.get(id)
    if (fiber) await fiber.dispose()
    mounted.delete(id)
  }
  const publicPlugin = plugin => {
    const visible = copy(plugin)
    delete visible.generationPrompt
    return { ...visible, source: moduleSource(plugin),
      loaded: mounted.has(plugin.id), ownerName: ctx.accounts.get(plugin.ownerId)?.name ?? 'Community',
      artifact: `${plugin.id}/index.mjs`, ...(plugin.kind === 'skill' ? { skillFile: `${plugin.id}/SKILL.md` } : {}) }
  }
  const list = user => {
    const all = records()
    const mine = all.filter(plugin => plugin.ownerId === user.id || plugin.global)
    return {
      plugins: (user.role === 'admin' ? all : mine).map(publicPlugin),
      market: all.filter(plugin => plugin.published || plugin.global).map(publicPlugin),
      skills: mine.filter(plugin => plugin.kind === 'skill').map(publicPlugin),
    }
  }
  const canManage = (user, plugin) => {
    if (plugin.global && user.role !== 'admin') fail('Only administrators manage global plugins.', 403)
    if (user.role !== 'admin' && plugin.ownerId !== user.id) fail('This plugin belongs to another account.', 403)
  }
  const generate = async (user, input = {}) => {
    if (!ctx.accounts.can(user, 'plugins:manage')) fail('Plugin creation is disabled for this account.', 403)
    const prompt = clean(input.prompt, 12000)
    if (!prompt) fail('Describe the plugin or workflow you want to create.')
    const response = await ctx.ai.complete(user, { purpose: 'plugin-generation', messages: [
      { role: 'system', content: generationPrompt },
      { role: 'user', content: `Account type: ${user.role}.\nRequest: ${prompt}` },
    ] })
    const descriptor = parseDescriptor(response)
    const plugin = { id: idOf(), ...descriptor, ownerId: user.id, enabled: true,
      published: false, global: false, createdAt: now(), generationPrompt: prompt }
    writeArtifact(plugin)
    await mount(plugin)
    try {
      const saved = await save(plugin, user.id, 'studio/plugin-created')
      return { ok: true, plugin: publicPlugin(saved), ...list(user) }
    } catch (error) {
      await unmount(plugin.id)
      throw error
    }
  }
  const run = async (user, id, input = {}) => {
    if (!ctx.accounts.can(user, 'plugins:manage')) fail('Plugin management is disabled for this account.', 403)
    if (!ctx.accounts.can(user, 'assistant:use')) fail('The assistant is disabled for this account.', 403)
    const plugin = lookup(id)
    if (plugin.ownerId !== user.id && !plugin.global) fail('Install this skill before running it.', 403)
    if (plugin.kind !== 'skill') fail('Only workflow skills can be run.')
    if (!plugin.enabled || !mounted.has(plugin.id)) fail('Load this skill before running it.')
    if (!assistant?.chat) fail('The assistant is starting. Please retry shortly.', 503)
    const result = await assistant.chat(user, {
      message: `Run my saved workflow "${plugin.name}":\n${plugin.spec.prompt}`
        + (plugin.spec.steps?.length ? `\n\nWorkflow steps:\n${plugin.spec.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}` : ''),
      ...(input.rfqId ? { rfqId: input.rfqId } : {}),
    })
    await ctx.store.append(user.id, 'studio/skill-ran', { pluginId: id, name: plugin.name }, { actor: user.id })
    return { ok: true, ...result }
  }
  const execute = async (user, id, action, input = {}) => {
    if (!ctx.accounts.can(user, 'plugins:manage')) fail('Plugin management is disabled for this account.', 403)
    const plugin = lookup(id)
    if (action === 'run') return run(user, id, input)
    if (action === 'install') {
      if (!plugin.published && !plugin.global && plugin.ownerId !== user.id) fail('This plugin has not been published.', 403)
      const existing = records().find(row => row.ownerId === user.id && row.originId === plugin.id && !row.global)
      if (existing) return execute(user, existing.id, 'load')
      if (plugin.ownerId === user.id && !plugin.global) return execute(user, id, 'load')
      const installed = { ...plugin, id: idOf(), ownerId: user.id, originId: plugin.id,
        enabled: true, global: false, published: false, createdAt: now() }
      delete installed.generationPrompt
      await mount(installed)
      const saved = await save(installed, user.id, 'studio/plugin-installed')
      return { ok: true, plugin: publicPlugin(saved), ...list(user) }
    }
    if (action === 'promote') {
      if (user.role !== 'admin') fail('Only administrators can make a plugin a global default.', 403)
      if (plugin.global) return execute(user, id, 'load')
      const existing = records().find(row => row.global && row.originId === plugin.id)
      if (existing) return execute(user, existing.id, 'load')
      const promoted = { ...plugin, id: idOf(), ownerId: user.id, originId: plugin.id,
        enabled: true, published: true, global: true, createdAt: now() }
      await mount(promoted)
      const saved = await save(promoted, user.id, 'studio/plugin-promoted')
      return { ok: true, plugin: publicPlugin(saved), ...list(user) }
    }
    canManage(user, plugin)
    let next
    if (action === 'load') {
      await mount(plugin)
      next = await save({ ...plugin, enabled: true }, user.id, 'studio/plugin-loaded')
    } else if (action === 'unload') {
      await unmount(id)
      next = await save({ ...plugin, enabled: false }, user.id, 'studio/plugin-unloaded')
    } else if (action === 'publish') {
      next = await save({ ...plugin, published: true }, user.id, 'studio/plugin-published')
    } else if (action === 'delete') {
      await unmount(id)
      next = await save({ ...plugin, enabled: false, published: false, deleted: true }, user.id, 'studio/plugin-deleted')
    } else fail('Unknown studio action.', 404)
    return { ok: true, plugin: publicPlugin(next), ...list(user) }
  }
  ctx.provide('studio', { list, generate, execute, run })
  for (const plugin of records().filter(row => row.enabled)) {
    try { await mount(plugin) } catch (error) {
      console.error(`[studio] Could not restore ${plugin.id}: ${error.message}`)
    }
  }
  ctx.effect(() => () => {
    disposed = true
    mounted.clear()
  })
  const route = (method, path, handler, options) => ctx.effect(() => ctx.web.route(method, path, handler, options))
  route('GET', '/studio', ({ user }) => list(user))
  route('POST', '/studio/generate', ({ user, body }) => generate(user, body), { capability: 'plugins:manage' })
  route('POST', '/studio/:id/:action', ({ user, params, body }) => execute(user, params.id, params.action, body), { capability: 'plugins:manage' })
  ctx.effect(() => ctx.web.contribute({ id: 'extensions', label: 'Plugin studio', icon: 'sparkles',
    roles: ['contractor', 'supplier', 'admin'], order: 60 }))
  ctx.inject(['assistant'], child => {
    assistant = child.assistant
    child.effect(() => () => { assistant = null })
    for (const [toolName, description, forceSkill] of [
      ['create_personal_plugin', 'Build and load a personal UI theme or dashboard widget from the user’s request. The result is a real Cordis plugin visible in Plugin studio.', false],
      ['create_workflow_skill', 'Create and save a reusable workflow skill for process automation. The user can run it from Plugin studio.', true],
    ]) {
      child.effect(() => child.assistant.tool({ name: toolName, description,
        roles: ['contractor', 'supplier', 'admin'],
        parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Complete description of the desired plugin or repeatable workflow.' } }, required: ['prompt'], additionalProperties: false },
        execute: async (user, args) => {
          const result = await generate(user, { prompt: `${forceSkill ? 'Create a reusable workflow skill (kind=skill). ' : ''}${args.prompt}` })
          return { ok: true, plugin: result.plugin, message: `${result.plugin.name} is ready and loaded in your workspace.`,
            action: { type: 'navigate', target: 'extensions', label: 'Open plugin studio' } }
        },
      }))
    }
  })
}
