/** Native Cordis inventory and actual lifecycle for registered application plugins. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'plugin-manager'
export const inject = ['web', 'store', 'accounts']
export const provides = ['plugins']

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const REQUIRED = new Set(['webui', 'workspace-store', 'accounts', 'settings', 'plugin-manager'])
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const keys = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.keys(value || {})
const unique = values => [...new Set(values.filter(Boolean))]
const active = fiber => fiber?.state === 2
const ownedServices = fiber => Object.entries(fiber?.store || {})
  .filter(([, impl]) => impl.fiber === fiber).map(([key]) => key)
const CHILDREN = {
  'product-ai': { name: 'AI model provider', source: 'src/system/agent-runtime/code/product-ai.mjs', configurationId: 'ai' },
  'product-assistant': { name: 'Workspace assistant', source: 'src/system/agent-runtime/code/product-assistant.mjs', configurationId: 'assistant' },
  'personal-utility-runtime': { name: 'Generated utility runtime', source: 'src/system/plugin-studio/code/tool-runtime.mjs' },
}

function discover(root) {
  const manifests = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name === 'plugin.json') {
        try {
          const manifest = JSON.parse(readFileSync(path, 'utf8'))
          const repoId = relative(join(root, 'src'), dirname(path)).split('\\').join('/')
          manifests.push({ ...manifest, repoId, source: relative(root, path).split('\\').join('/') })
        } catch (error) {
          manifests.push({ name: relative(root, dirname(path)), source: relative(root, path),
            repoId: relative(join(root, 'src'), dirname(path)), description: `Manifest could not be read: ${error.message}` })
        }
      }
    }
  }
  if (existsSync(join(root, 'src'))) walk(join(root, 'src'))
  return manifests.sort((a, b) => a.repoId.localeCompare(b.repoId))
}

export function apply(ctx, config = {}) {
  const root = resolve(config.repositoryRoot || ROOT)
  const directory = join(config.root || ctx.store.root, 'plugin-manager')
  const file = join(directory, 'state.json')
  mkdirSync(directory, { recursive: true })
  let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { enabled: {} }
  state.enabled ||= {}
  const entries = new Map()
  let settings = null
  let disposed = false
  let operation = Promise.resolve()
  ctx.inject(['settings'], child => {
    settings = child.settings
    child.effect(() => () => { settings = null })
  })
  const persist = () => {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }
  const enabled = id => REQUIRED.has(id) || state.enabled[id] !== false
  const fibers = () => [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
  const ownerOf = fiber => {
    let cursor = fiber
    const seen = new Set()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      for (const entry of entries.values()) if (entry.fiber === cursor) return entry
      const parent = cursor.parent?.fiber
      if (parent === cursor) break
      cursor = parent
    }
    return null
  }
  const servicesOf = entry => {
    const provided = [...entry.provides]
    for (const fiber of fibers()) if (ownerOf(fiber) === entry) provided.push(...ownedServices(fiber))
    entry.provides = unique(provided)
    return entry.provides
  }
  const manifestFor = options => discover(root).find(row => row.repoId === options.repoId
    || (row.name === options.id && (!options.layer || row.layer === options.layer)))
  const register = options => {
    if (!options?.id || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(options.id)) fail('Plugin IDs must be slash-free.')
    if (entries.has(options.id)) fail(`Plugin ${options.id} is already registered.`, 409)
    const manifest = manifestFor(options)
    const entry = { ...options, name: options.name || manifest?.name || options.module?.name || options.id,
      description: options.description || manifest?.description || '', version: options.version || manifest?.version || '',
      layer: options.layer || manifest?.layer || 'system', repoId: options.repoId || manifest?.repoId,
      source: options.source || manifest?.source || '', config: options.config || {},
      essential: options.essential === true || REQUIRED.has(options.id),
      dependencies: unique(options.dependencies || keys(options.module?.inject)),
      provides: unique(options.provides || options.module?.provides || keys(options.module?.provide)
        .concat(manifest?.provides || [])),
      managedMount: false,
    }
    entries.set(entry.id, entry)
    servicesOf(entry)
    return async () => {
      if (entries.get(entry.id) !== entry) return
      entries.delete(entry.id)
      if (entry.managedMount && entry.fiber) await entry.fiber.dispose()
    }
  }
  const schemasFor = user => {
    const result = settings?.list(user) || []
    return Array.isArray(result) ? result : result.settings || result.schemas || []
  }
  const list = user => {
    const schemas = new Set(schemasFor(user).map(schema => schema.id))
    const allFibers = fibers()
    const rows = []
    for (const entry of entries.values()) {
      const isActive = active(entry.fiber)
      const lifecycleAllowed = !entry.essential && !!entry.module
      const configurationId = entry.configurationId || (schemas.has(entry.id) ? entry.id : null)
      rows.push({ id: entry.id, name: entry.name, description: entry.description, version: entry.version,
        layer: entry.layer, status: isActive ? 'active' : 'disabled', enabled: isActive,
        requestedEnabled: enabled(entry.id), configurable: !!configurationId && schemas.has(configurationId),
        configurationId, essential: entry.essential, dependencies: [...entry.dependencies],
        provides: servicesOf(entry), source: entry.source, repoId: entry.repoId, lifecycleAllowed,
        reason: entry.essential ? 'Required core service; lifecycle is managed by the server.'
          : !entry.module ? 'This runtime plugin has no registered reloadable module.'
          : !isActive && entry.fiber && enabled(entry.id) ? 'Waiting for dependencies or plugin activation failed.' : '',
        runtimeState: entry.fiber?.state ?? null,
      })
    }
    for (const fiber of allFibers) {
      const owner = ownerOf(fiber)
      if ([...entries.values()].some(entry => entry.fiber === fiber)) continue
      const runtimeName = fiber.runtime?.name
      // Anonymous ctx.inject callbacks are effects of their owner, not separate plugins.
      if (!runtimeName || /^plugin-[0-9a-f-]+$/.test(runtimeName)) continue
      const metadata = CHILDREN[runtimeName] || {}
      const configurationId = metadata.configurationId || null
      rows.push({ id: `runtime:${owner?.id || 'root'}:${fiber.uid}`, name: metadata.name || runtimeName,
        description: `Native Cordis child plugin${owner ? ` managed by ${owner.name}` : ''}.`,
        layer: owner?.layer || 'system', status: active(fiber) ? 'active' : 'disabled', enabled: active(fiber),
        configurable: !!configurationId && schemas.has(configurationId), configurationId,
        essential: false, dependencies: keys(fiber.inject), provides: ownedServices(fiber),
        source: metadata.source || owner?.source || runtimeName, parentId: owner?.id || null,
        lifecycleAllowed: false, reason: owner ? `Load or unload ${owner.name} to manage this child plugin.`
          : 'Managed by its Cordis parent context.', runtimeState: fiber.state,
      })
    }
    const registered = new Set([...entries.values()].map(entry => entry.repoId).filter(Boolean))
    for (const manifest of discover(root)) {
      if (registered.has(manifest.repoId)) continue
      const mail = manifest.repoId === 'system/mail'
      rows.push({ id: `library:${manifest.repoId.replaceAll('/', ':')}`, name: manifest.name,
        description: mail ? 'Historical SMTP/IMAP mail adapter and read-only operations view. It is not loaded in this application. Email document ingestion is a separate current plugin.' : manifest.description || '',
        version: manifest.version || '', layer: manifest.layer || manifest.repoId.split('/')[0],
        status: 'available', enabled: false, configurable: false, configurationId: null,
        essential: false, dependencies: keys(manifest.inject || manifest.dependencies),
        provides: manifest.provides || [], source: manifest.source, repoId: manifest.repoId,
        lifecycleAllowed: false,
        reason: 'Available in the repository; not registered for the current application runtime. Its entry and dependencies need integration before it can be loaded here.',
      })
    }
    return rows
  }
  const mutate = async (id, value) => {
    if (disposed) fail('Plugin manager is restarting.', 503)
    const entry = entries.get(id)
    if (!entry) fail('This repository plugin is not registered for runtime management.', 404)
    if (entry.essential) fail('This core plugin is required by the running application.', 409)
    if (!entry.module) fail('No reloadable module was registered for this plugin.', 409)
    if (value) {
      if (!active(entry.fiber)) {
        const missing = entry.dependencies.filter(dependency => !ctx.root.get(dependency)
          && !active(entries.get(dependency)?.fiber))
        if (missing.length) fail(`Enable the required services first: ${missing.join(', ')}.`, 409)
        if (entry.fiber) await entry.fiber.dispose()
        entry.fiber = await ctx.root.plugin(entry.module, entry.config)
        entry.managedMount = true
        if (!active(entry.fiber)) {
          await entry.fiber.dispose()
          entry.fiber = null
          fail(`Plugin ${entry.name} did not activate. Check its configuration and dependencies.`, 409)
        }
      }
    } else if (entry.fiber) {
      const provided = new Set(servicesOf(entry))
      const dependents = [...entries.values()].filter(other => other !== entry && active(other.fiber)
        && other.dependencies.some(dependency => dependency === id || provided.has(dependency)))
      if (dependents.length) fail(`Disable dependent plugins first: ${dependents.map(other => other.name).join(', ')}.`, 409)
      await entry.fiber.dispose()
      entry.fiber = null
    }
    state.enabled[id] = value
    persist()
    return { ok: true, id, enabled: value }
  }
  const setEnabled = (id, value) => {
    const task = operation.then(() => mutate(id, value))
    operation = task.catch(() => {})
    return task
  }
  ctx.provide('plugins', { register, enabled, list, setEnabled })
  ctx.effect(() => ctx.web.route('GET', '/plugins', ({ user }) => ({ plugins: list(user),
    generatedPlugins: { owner: 'plugin-studio', section: 'extensions', note: 'Generated account and global plugins are managed in Plugin Studio.' },
  }), { admin: true }))
  ctx.effect(() => ctx.web.route('POST', '/plugins/:id/:action', async ({ user, params }) => {
    if (!['enable', 'disable'].includes(params.action)) fail('Choose enable or disable.', 404)
    await setEnabled(params.id, params.action === 'enable')
    return { ok: true, plugins: list(user) }
  }, { admin: true }))
  ctx.effect(() => async () => {
    disposed = true
    await operation
    await Promise.allSettled([...entries.values()].filter(entry => entry.managedMount && entry.fiber)
      .map(entry => entry.fiber.dispose()))
    entries.clear()
  })
}
