import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as utilityRuntime from './tool-runtime.mjs'

export const name = 'product-plugin-studio'
export const inject = ['web', 'store', 'accounts', 'ai']
export const provides = ['studio', 'studioRuntime']

const COLLECTION = 'studio-plugins'
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max)
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const copy = value => JSON.parse(JSON.stringify(value))
const now = () => new Date().toISOString()
const idOf = () => `plugin-${randomUUID()}`
const COLOR = /^(#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s]+\))$/

const generationPrompt = `You design useful personal plugins for a quotation workspace.
Respond with exactly one JSON object, no markdown: {"name":"short descriptive name","description":"one sentence","kind":"theme|widget|skill|calculator","spec":{...}}.
Choose theme for visual customization, widget for a personal reference panel, skill for a reusable agent workflow, calculator for an interactive custom utility that computes, transforms, analyzes, or formats data with user inputs. A calculator is not limited to arithmetic: it can implement any useful synchronous pure JavaScript function.
Theme spec: {"accent":"#hex","background":"#hex","surface":"#hex","text":"#hex","radius":"12px"}. All colors must be CSS hex colors with strong legibility and pleasant contrast. A theme must respect the user's requested colors/mood.
Widget spec: {"title":"...","body":"helpful content specific to the request","items":["..."]}. Do not invent live business metrics; this is a personal reference panel. For live tasks choose skill.
Skill spec: {"prompt":"a complete reusable instruction for the assistant to execute using its current account's live workspace context and tools","steps":["short action steps"]}. Skills should automate analysis, extraction, draft preparation, and follow-up planning. They cannot publish quotations, award orders, approve changes, or make financial commitments without human review. Incorporate the user's concrete requested routine and preferences.
Calculator spec: {"title":"...","fields":[{"name":"camelCaseInputName","label":"Readable label including units","type":"number|text","default":0}],"code":"function(input, workspace) { ... return { summary: 'Readable result', rows: [{label:'Description', value:123}], ...namedResults }; }"}. Write the COMPLETE actual JavaScript implementation yourself, with all formulas and logic needed for the user's request. The source is executed as written, not interpreted as a template. User input fields and function input keys must match exactly. Numeric fields receive numbers. It may read ONLY the provided account workspace snapshot: {rfqs,quotes,orders,messages,changes,contacts,stats,comparison}; RFQ item fields are {id,description,quantity,unit}, quote items additionally have unitPrice and private cost when owned by that supplier. Handle missing data helpfully. Return a JSON-serializable object; use concise summary and rows with label/value for readability, plus named numeric results when appropriate. It must be synchronous and pure: no import, network, files, process, eval, timers, external libraries, or external actions. Use standard JavaScript/Math/JSON, validate meaningful input ranges, and round money to 2 decimals when relevant. Never invent current account data. Infer formulas from the request and state assumptions in output when needed.
Generate substantive useful content; do not merely repeat the request. Do not include credentials, file paths, or unrelated features.`

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
  if (!descriptor || !['theme', 'widget', 'skill', 'calculator'].includes(descriptor.kind)) {
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
  } else if (result.kind === 'calculator') {
    if (!Array.isArray(spec.fields) || spec.fields.length > 24) fail('The generated utility needs a field list with at most 24 inputs.', 502)
    const names = new Set()
    const fields = spec.fields.map(field => {
      const name = clean(field.name, 64)
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name)) fail('The generated utility has an invalid or duplicate input name.', 502)
      names.add(name)
      if (!['number', 'text'].includes(field.type)) fail('Generated utility inputs must be numbers or text.', 502)
      const value = field.type === 'number' ? Number(field.default ?? 0) : clean(field.default, 6000)
      if (field.type === 'number' && !Number.isFinite(value)) fail('A generated numeric default is invalid.', 502)
      return { name, label: clean(field.label || name, 160), type: field.type, default: value }
    })
    const code = String(spec.code ?? '').trim()
    try { utilityRuntime.compileUtility(code) } catch (error) {
      fail(`The generated utility needs a correction: ${error.message}. Please retry.`, 502)
    }
    result.spec = { title: clean(spec.title || result.name, 160), fields, code }
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
    kind: plugin.kind, spec: plugin.spec, lineageId: plugin.lineageId || plugin.originId || plugin.id, ownerId: plugin.ownerId, global: plugin.global,
    enabled: true, createdAt: plugin.createdAt, updatedAt: plugin.updatedAt || plugin.createdAt }
  const scope = plugin.global ? '*' : plugin.ownerId
  return `// Generated from your requested plugin descriptor. Loaded by Cordis.\n`
    + `export const name = ${JSON.stringify(plugin.id)};\n`
    + `export const inject = ${JSON.stringify(plugin.kind === 'calculator' ? ['web', 'studioRuntime'] : ['web'])};\n`
    + `export const descriptor = ${JSON.stringify(descriptor, null, 2)};\n`
    + `export function apply(ctx) {\n`
    + `  ctx.effect(() => ctx.web.extension(${JSON.stringify(scope)}, descriptor));\n`
    + (plugin.kind === 'calculator' ? `  ctx.effect(() => ctx.studioRuntime.register(${JSON.stringify(scope)}, descriptor, descriptor.spec.code));\n` : '')
    + `}\n`
}

export async function apply(ctx, config = {}) {
  const root = join(config.root ?? ctx.store.root, 'plugin-artifacts')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const mounted = new Map()
  let pending = Promise.resolve()
  const serialize = task => {
    const result = pending.then(task)
    pending = result.catch(() => {})
    return result
  }
  let disposed = false
  let actions = null
  ctx.inject(['actions'], child => {
    actions=child.actions
    child.effect(()=>()=>{actions=null})
    child.effect(()=>child.actions.register({kind:'studio.generate',label:'Create personal plugin',execute:async(user,input)=>{const result=await generate(user,input);return{...result,action:{type:'navigate',label:'Open plugin studio',input:{view:'extensions'}}}}}))
  })
  let assistant = null
  let procurement = null
  let utilities = null
  await ctx.plugin(utilityRuntime)
  ctx.inject(['studioRuntime'], child => {
    utilities = child.studioRuntime
    child.effect(() => () => { utilities = null })
  })
  ctx.inject(['procurement'], child => {
    procurement = child.procurement
    child.effect(() => () => { procurement = null })
  })
  const records = () => ctx.store.list('system', COLLECTION).filter(plugin => !plugin.deleted)
  const lineage = plugin => {
    let current=plugin;const seen=new Set()
    while(current?.originId && !seen.has(current.id)) {seen.add(current.id);const parent=ctx.store.get('system',COLLECTION,current.originId);if(!parent)return current.originId;current=parent}
    return current?.id || plugin.id
  }
  const newestFirst = (a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
    || String(b.id).localeCompare(String(a.id))
  const isActive = plugin => !!plugin.enabled && mounted.has(plugin.id)
  const activeFirst = (a, b) => Number(isActive(b)) - Number(isActive(a)) || newestFirst(a, b)
  const scopeKey = plugin => `${plugin.global ? '*' : plugin.ownerId}:${lineage(plugin)}`
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
  const mount = async (plugin, actor = 'system:plugin-studio') => {
    plugin={...plugin,lineageId:lineage(plugin)}
    if (disposed) fail('Plugin studio is restarting. Please retry.', 503)
    const previous = mounted.get(plugin.id)
    if (previous) { await previous.dispose(); mounted.delete(plugin.id) }
    const { file } = writeArtifact(plugin)
    const module = await import(`${pathToFileURL(file).href}?v=${randomUUID()}`)
    const fiber = await ctx.plugin(module)
    if (fiber.state !== 2) {
      await fiber.dispose()
      fail('The plugin could not activate. Please review its configuration.', 409)
    }
    mounted.set(plugin.id, fiber)
    // Replace older instances in this exact account/global scope, retaining their records and artifacts.
    for (const previous of records().filter(row => row.id !== plugin.id && scopeKey(row) === scopeKey(plugin)
      && (row.enabled || mounted.has(row.id)))) {
      await unmount(previous.id)
      await save({ ...previous, enabled: false }, actor, 'studio/plugin-unloaded')
    }
    return fiber
  }
  const unmount = async id => {
    const fiber = mounted.get(id)
    if (fiber) await fiber.dispose()
    mounted.delete(id)
  }
  const publicPlugin = (plugin,user) => {
    const visible = copy(plugin)
    delete visible.generationPrompt
    return { ...visible, lineageId:lineage(plugin),scope:plugin.global?'global':'personal',canManage:!!user && (user.role==='admin' || !plugin.global && plugin.ownerId===user.id), source: moduleSource({...plugin,lineageId:lineage(plugin)}),
      enabled: isActive(plugin), loaded: mounted.has(plugin.id), ownerName: ctx.accounts.get(plugin.ownerId)?.name ?? 'Community',
      artifact: `${plugin.id}/index.mjs`, ...(plugin.kind === 'skill' ? { skillFile: `${plugin.id}/SKILL.md` } : {}) }
  }
  const list = user => {
    const all=records(), groups=new Map()
    for(const plugin of all) {const key=lineage(plugin);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(plugin)}
    const choose = rows => [...rows].sort((a,b)=>{
      const priority=p=>p.ownerId===user.id&&!p.global?(isActive(p)?0:2):p.global?(isActive(p)?1:3):(isActive(p)?4:5)
      return priority(a)-priority(b)||newestFirst(a,b)
    })[0]
    const plugins=[],market=[]
    for(const [key,instances] of groups) {
      const visible=instances.filter(p=>user.role==='admin'||p.ownerId===user.id||p.global)
      if(visible.length) {
        const selected=choose(visible)
        plugins.push({...publicPlugin(selected,user),scopeLabels:visible.map(p=>p.global?'Global default':`Personal · ${ctx.accounts.get(p.ownerId)?.name || 'User'}`),
          instances:visible.sort(activeFirst).map(p=>publicPlugin(p,user))})
      }
      const published=instances.filter(p=>p.published || p.global)
      if(published.length) {
        const source=published.find(p=>p.id===key)||published.find(p=>!p.global)||published[0]
        const installed=choose(instances.filter(p=>p.ownerId===user.id&&!p.global||p.global))
        market.push({...publicPlugin(source,user),installed:!!installed,installedId:installed?.id || null,installedEnabled:!!installed&&isActive(installed),
          installationScope:installed?(installed.global?'global':installed.id===key?'owner':'personal'):null})
      }
    }
    const order=(a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))
    return {plugins:plugins.sort(order),market:market.sort(order),skills:plugins.filter(p=>p.kind==='skill')}
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
    await mount(plugin, user.id)
    try {
      const saved = await save(plugin, user.id, 'studio/plugin-created')
      return { ok: true, plugin: publicPlugin(saved,user), ...list(user) }
    } catch (error) {
      await unmount(plugin.id)
      throw error
    }
  }
  const run = async (user, id, input = {}) => {
    if (!ctx.accounts.can(user, 'plugins:manage')) fail('Plugin management is disabled for this account.', 403)
    const plugin = lookup(id)
    if (plugin.ownerId !== user.id && !plugin.global) fail('Install this plugin before running it.', 403)
    if (!plugin.enabled || !mounted.has(plugin.id)) fail('Load this plugin before running it.')
    if (plugin.kind === 'calculator') {
      if (!utilities) fail('The utility runtime is starting. Please retry.', 503)
      const raw = input.input ?? {}
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Utility input must be an object.')
      const values = Object.fromEntries(plugin.spec.fields.map(field => {
        const supplied = raw[field.name] ?? field.default
        const value = field.type === 'number' ? Number(supplied) : String(supplied).slice(0, 24000)
        if (field.type === 'number' && !Number.isFinite(value)) fail(`Enter a valid number for ${field.label}.`)
        return [field.name, value]
      }))
      const workspace = user.role !== 'admin' && procurement ? procurement.snapshot(ctx.accounts.get(user.id))
        : { rfqs: [], quotes: [], orders: [], messages: [], changes: [], contacts: [], stats: {}, comparison: [] }
      const result = utilities.run(user, id, values, workspace)
      await ctx.store.append(user.id, 'studio/tool-ran', { pluginId: id, name: plugin.name, input: values, result }, { actor: user.id })
      return { ok: true, result }
    }
    if (plugin.kind !== 'skill') fail('Only workflow skills and generated utilities can be run.')
    if (!ctx.accounts.can(user, 'assistant:use')) fail('The assistant is disabled for this account.', 403)
    if (!assistant?.chat) fail('The assistant is starting. Please retry shortly.', 503)
    const result = await assistant.chat(user, {
      message: `Run my saved workflow "${plugin.name}":\n${plugin.spec.prompt}`
        + (plugin.spec.steps?.length ? `\n\nWorkflow steps:\n${plugin.spec.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}` : ''),
      ...(input.rfqId ? { rfqId: input.rfqId } : {}),
    })
    await ctx.store.append(user.id, 'studio/skill-ran', { pluginId: id, name: plugin.name }, { actor: user.id })
    return { ok: true, ...result }
  }
  const perform = async (user, id, action, input = {}) => {
    if (!ctx.accounts.can(user, 'plugins:manage')) fail('Plugin management is disabled for this account.', 403)
    const plugin = lookup(id)
    if (action === 'run') return run(user, id, input)
    if (action === 'install') {
      if (!plugin.published && !plugin.global && plugin.ownerId !== user.id) fail('This plugin has not been published.', 403)
      const existing = records().filter(row => row.ownerId === user.id && lineage(row) === lineage(plugin) && !row.global).sort(activeFirst)[0]
      if (existing) return perform(user, existing.id, 'load')
      if (plugin.ownerId === user.id && !plugin.global) return perform(user, id, 'load')
      const installed = { ...plugin, id: idOf(), ownerId: user.id, originId: plugin.id,
        enabled: true, global: false, published: false, createdAt: now() }
      delete installed.generationPrompt
      await mount(installed, user.id)
      const saved = await save(installed, user.id, 'studio/plugin-installed')
      return { ok: true, plugin: publicPlugin(saved,user), ...list(user) }
    }
    if (action === 'promote') {
      if (user.role !== 'admin') fail('Only administrators can make a plugin a global default.', 403)
      if (plugin.global) return perform(user, id, 'load')
      const existing = records().filter(row => row.global && lineage(row) === lineage(plugin)).sort(activeFirst)[0]
      if (existing) return perform(user, existing.id, 'load')
      const promoted = { ...plugin, id: idOf(), ownerId: user.id, originId: plugin.id,
        enabled: true, published: true, global: true, createdAt: now() }
      await mount(promoted, user.id)
      const saved = await save(promoted, user.id, 'studio/plugin-promoted')
      return { ok: true, plugin: publicPlugin(saved,user), ...list(user) }
    }
    canManage(user, plugin)
    let next
    if (action === 'load') {
      await mount(plugin, user.id)
      next = await save({ ...plugin, enabled: true }, user.id, 'studio/plugin-loaded')
    } else if (action === 'unload') {
      await unmount(id)
      next = await save({ ...plugin, enabled: false }, user.id, 'studio/plugin-unloaded')
    } else if (action === 'publish') {
      next = await save({ ...plugin, published: true }, user.id, 'studio/plugin-published')
    } else if (action === 'configure') {
      const descriptor=parseDescriptor({content:JSON.stringify({name:input.name ?? plugin.name,description:input.description ?? plugin.description,
        kind:plugin.kind,spec:{...plugin.spec,...input.spec}})})
      const updated={...plugin,...descriptor}
      if(plugin.enabled) {
        try {await mount(updated, user.id)} catch(error) {await mount(plugin, user.id);throw error}
      } else writeArtifact(updated)
      next=await save(updated,user.id,'studio/plugin-configured')
    } else if (action === 'delete') {
      await unmount(id)
      next = await save({ ...plugin, enabled: false, published: false, deleted: true }, user.id, 'studio/plugin-deleted')
    } else fail('Unknown studio action.', 404)
    return { ok: true, plugin: publicPlugin(next,user), ...list(user) }
  }
  const execute = (user, id, action, input = {}) => action === 'run' ? run(user, id, input)
    : serialize(() => perform(user, id, action, input))
  ctx.provide('studio', { list, generate, execute, run })
  const restoredScopes = new Set()
  for (const plugin of records().filter(row => row.enabled).sort(newestFirst)) {
    const scope = scopeKey(plugin)
    if (restoredScopes.has(scope)) continue
    restoredScopes.add(scope)
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
      ['create_personal_plugin', 'Design, implement and load a personal theme, reference widget or executable utility/calculator from the user’s request. For custom tools, the model writes actual JavaScript implementation and input fields. The result is a real Cordis plugin visible in Plugin studio.', false],
      ['create_workflow_skill', 'Create and save a reusable workflow skill for process automation. The user can run it from Plugin studio.', true],
    ]) {
      child.effect(() => child.assistant.tool({ name: toolName, description, effect:'write',
        propose:async(user,args,context)=>{
          if(!actions)throw new Error('Enable Human action review to create a plugin from external source content.')
          const action=await actions.propose(user,{kind:'studio.generate',title:forceSkill?'Create a workflow skill':'Create a personal plugin',summary:args.prompt,input:{prompt:`${forceSkill?'Create a reusable workflow skill (kind=skill). ':''}${args.prompt}`},source:{kind:'assistant',tool:toolName},runId:context.runId})
          return{ok:true,message:'Review this source-assisted plugin request before creating it.',action:{type:'navigate',label:'Review plugin request',input:{view:'approvals',actionId:action.id}}}
        },
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
