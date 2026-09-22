#!/usr/bin/env node
/**
 * tools/plugin-lifecycle.mjs —— 「一切皆插件」的**六动词**实现（`tools/plugin.sh` 是它的薄入口）。
 *
 *   list | status <插件> | load <插件> | reload <插件> | unload <插件> | deps <插件>
 *
 * 规则真源：`docs/design/27-plugin-architecture.md` §4；契约：`src/system/runtime/docs/lifecycle-contract.md`。
 *
 * 为什么有"运行时进程"（这是本文件唯一一处不显然的设计，先说清楚）：
 *   `load` 的语义是"**把插件入位**"，而 `plugin.sh` 每调一次就是一个新进程 —— 装载事实必须活在一个
 *   **常驻进程**里才谈得上"入位"与"unload 真移除"。所以：
 *     · `load/reload/unload/status` 通过 unix socket 让一个**常驻运行时进程**做真事：
 *       真 `import` 入口 → 真 `ctx.plugin()` 拿到 fiber（uid/state/getEffects 都是内核实测值）；
 *       卸载 = `fiber.dispose()` 后回读 effects 是否归零；
 *     · 运行时进程按需自动拉起（`--serve` 模式，pid/socket/log 都在 `<root>/tmp/plugin-runtime/`），
 *       它**不写任何文件**；状态只活在它的内存里（**没有第二份记录**，所以不存在"记录说已装载但其实没有"）；
 *     · 运行时不在（容器重建、被清进程）⇒ `status` 如实报 `runtime: not-running` + `loaded:false`，
 *       `load` 会顺手把它拉起来（幂等）。
 *   `list` / `deps` 是**只读目录扫描**，不需要运行时（不 import 任何插件）。
 *
 * 本文件是 `tmp/plugin-runtime/**` 的**唯一写入者**（见 `plugin.json.permissions`）。
 * 帧纪律（ADR-0013）：stdout 只放机器可读结果（JSONL 或单行 JSON），日志走 stderr。
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LAYERS, VERBS, createRootContext, depsClosure, entryKind, findPlugin, mount, repoRootOf, scan, unmount
} from '../code/plugin-registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = (root) => join(root, 'tmp', 'plugin-runtime')
// cordis FiberState 的取值 → 名字（装载报告里给人看的那一栏用名字，不用数字）。
const FIBER_STATE = { 0: 'PENDING', 1: 'LOADING', 2: 'ACTIVE', 3: 'FAILED', 4: 'DISPOSED', 5: 'UNLOADING' }
const SOCKET_PATH = (root) => join(RUNTIME_DIR(root), 'runtime.sock')
const PID_PATH = (root) => join(RUNTIME_DIR(root), 'runtime.pid')
const LOG_PATH = (root) => join(RUNTIME_DIR(root), 'runtime.log')

const out = (payload, { pretty = false } = {}) =>
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`)
const log = (text) => process.stderr.write(`[plugin-lifecycle] ${text}\n`)
const refuse = (verb, code, id, reason, next_action, extra = {}) =>
  ({ ok: false, verb, id: id ?? null, code, reason, next_action, ...extra })

/** 参数解析（手写：只认契约里写的旗标，未知旗标一律拒 —— 不许"悄悄忽略"）。 */
function parseArgs(argv) {
  const args = { verb: null, id: null, layer: null, json: false, pretty: false, root: null, config: {},
    runtime: null, serve: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') args.json = true
    else if (token === '--pretty') args.pretty = true
    else if (token === '--serve') args.serve = true
    else if (token === '--layer') args.layer = argv[++index] ?? null
    else if (token === '--root') args.root = argv[++index] ?? null
    else if (token === '--config') {
      const raw = argv[++index] ?? '{}'
      try { args.config = JSON.parse(raw) } catch { return { error: `--config 不是合法 JSON：${raw}` } }
    } else if (token === '--runtime') args.runtime = argv[++index] ?? null
    else if (token === '--help' || token === '-h') args.help = true
    else if (token.startsWith('-')) return { error: `未知旗标：${token}` }
    else rest.push(token)
  }
  if (args.help) return args
  if (args.serve) return args
  if (args.runtime !== null) return args
  args.verb = rest[0] ?? null
  args.id = rest[1] ?? null
  if (args.verb === null) return { error: '缺少动词' }
  if (!VERBS.includes(args.verb)) return { error: `未知动词：${args.verb}` }
  if (args.verb !== 'list' && (args.id === null || args.id === '')) return { error: `${args.verb} 需要 <插件>` }
  return args
}

const USAGE = `用法: tools/plugin.sh <动词> [参数]
  动词: ${VERBS.join(' | ')}
  list   [--layer system|domain|userspace] [--json]   枚举（默认一行一条 JSON；--json 一份文档）
  status <插件>                                       装载状态 / 依赖是否就绪 / effects 计数 / 最近一次错误
  load   <插件> [--config '{...}']                    装载（真 import + 真挂进运行时进程）
  reload <插件>                                       先卸后装 ⇒ 新实例（新 uid），不迁移任何内存状态
  unload <插件>                                       卸载并归零 effects/订阅（可重复）
  deps   <插件>                                       依赖闭包（depends_on + inject 的传递闭包；有环给环上的 id）
  通用旗标: --root <目录>（默认仓库根）· --pretty · --runtime start|stop|status（运行时进程管理，不属于插件六动词）`

// ---------------------------------------------------------------------------------------------
// 运行时进程（server 侧）：状态只在内存里；不写任何文件
// ---------------------------------------------------------------------------------------------
async function serve(root) {
  const loaded = new Map()          // plugin id → {handle, record}
  const state = { ctx: null, seq: new Map() }   // 共用 root Context + 每插件的实例序号（新实例 = 新序号）
  const startedAt = Date.now()
  const socketPath = SOCKET_PATH(root)
  mkdirSync(RUNTIME_DIR(root), { recursive: true })
  // 单实例：先探活（真有人答 ping 就退出，让调用方用那个进程）；否则清掉陈旧 socket 再绑定。
  const alive = await pingOnce(socketPath)
  if (alive) { log(`运行时已在（pid=${alive.runtime?.pid}），本进程退出`); return }
  try { unlinkSync(socketPath) } catch { /* 本来就没有 */ }
  const server = net.createServer((connection) => {
    let buffer = ''
    connection.on('data', async (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let request = null
      try { request = JSON.parse(line) } catch { /* 下面统一回 usage */ }
      let response = null
      try {
        response = await handleRequest(request, { root, loaded, startedAt, socketPath, state })
      } catch (err) {
        response = { ok: false, code: 'usage', reason: String(err && err.message).slice(0, 200),
          next_action: '这是运行时进程的兜底错误：看 tmp/plugin-runtime/runtime.log' }
      }
      connection.end(`${JSON.stringify(response)}\n`)
    })
  })
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(socketPath, ok) })
  try { chmodSync(socketPath, 0o600) } catch { /* 尽力而为 */ }
  writeFileSync(PID_PATH(root), `${process.pid}\n`, { mode: 0o600 })
  log(`运行时进程就绪 pid=${process.pid} socket=${socketPath} root=${root}`)
  const shutdown = () => { server.close(); try { writeFileSync(PID_PATH(root), '') } catch {} ; process.exit(0) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // 常驻：**不返回**（返回会让 main 结束、进程带着已绑定的 socket 退出 —— 这就是"就绪然后立刻消失"的成因）。
  await new Promise(() => {})
}

async function handleRequest(request, { root, loaded, startedAt, socketPath, state }) {
  const op = request?.op
  const runtime = () => ({ pid: process.pid, uptime_ms: Date.now() - startedAt, socket: socketPath,
    loaded: [...loaded.keys()].sort() })
  const ensureContext = async () => {
    if (state.ctx !== null) return { ok: true, ctx: state.ctx }
    const created = await createRootContext(root)
    if (created.ok) state.ctx = created.ctx
    return created
  }
  const nextInstance = (id) => {
    state.seq.set(id, (state.seq.get(id) ?? 0) + 1)
    return `${id}#${state.seq.get(id)}`
  }
  if (op === 'ping') return { ok: true, op, runtime: runtime() }
  if (op === 'status' || op === 'load' || op === 'reload' || op === 'unload' || op === 'deps' || op === 'list') {
    const scanned = scan(root)
    if (op === 'list') {
      const items = scanned.plugins.filter((item) => request.layer === null || item.layer === request.layer)
      return { ok: true, op, runtime: runtime(),
        plugins: items.map((item) => describe(item, loaded, scanned)) , degraded: scanned.degraded }
    }
    const found = findPlugin(scanned, request.id)
    if (!found.ok) return { ...found, verb: op, runtime: runtime() }
    const plugin = found.plugin
    if (op === 'status') {
      const record = loaded.get(plugin.id)
      return { ok: true, op, id: plugin.id, ...describe(plugin, loaded, scanned), runtime: runtime(),
        last_error: record?.last_error ?? null }
    }
    if (op === 'deps') {
      const closure = depsClosure(scanned, plugin.id)
      return { ok: closure.ok, verb: op, id: plugin.id, code: closure.code ?? null,
        direct: closure.direct, closure: closure.closure, order: closure.order, cycle: closure.cycle ?? null,
        unresolved_services: closure.unresolved ?? [], missing_targets: closure.missing ?? [],
        next_action: closure.ok ? '依赖闭包已给出（顺序即拓扑序：先装后面的）'
          : `环：${(closure.cycle ?? []).join(' → ')}（去掉其中一条 depends_on）`, runtime: runtime() }
    }
    if (op === 'unload') {
      const entry = loaded.get(plugin.id)
      if (entry === undefined) {
        return { ...refuse(op, 'not-loaded', plugin.id, `未装载：${plugin.id}`,
          '先 `tools/plugin.sh load …`（本动词可重复：重复 unload 就是这条 not-loaded）'), runtime: runtime() }
      }
      const verdict = await unmount(entry.handle)
      loaded.delete(plugin.id)
      return { ok: true, verb: op, id: plugin.id, from_uid: entry.record.uid, ...verdict,
        runtime: runtime(), next_action: verdict.zero_effects
          ? '已卸载且 effects 归零（可再次 load 得到新实例）'
          : '卸载后 effects 不为 0：真残留，必须查（AC-PLUGIN-001）' }
    }
    if (op === 'reload' && loaded.get(plugin.id) === undefined) {
      return { ...refuse(op, 'not-loaded', plugin.id, `未装载：${plugin.id}`,
        'reload 的语义是"先卸后装"：先 `load` 一次'), runtime: runtime() }
    }
    // load / reload：真装载（reload 先真卸）
    let fromUid = null
    let fromInstance = null
    if (op === 'reload') {
      const previous = loaded.get(plugin.id)
      fromUid = previous.record.uid
      fromInstance = previous.record.instance
      const verdict = await unmount(previous.handle)
      loaded.delete(plugin.id)
      if (!verdict.zero_effects) {
        return { ...refuse(op, 'mount-failed', plugin.id, '重载前卸载未归零 effects',
          '查该插件的 ctx.effect 是否有未返回 disposer 的注册'), runtime: runtime() }
      }
    } else if (loaded.get(plugin.id) !== undefined) {
      return { ...refuse(op, 'already-loaded', plugin.id, `已在装载：${plugin.id}`,
        '要得到新实例用 `tools/plugin.sh reload <插件>`（reload = 先卸后装）'), runtime: runtime() }
    }
    const mounted = await mount(plugin, { root, config: request.config ?? {}, ctx: (await ensureContext()).ctx ?? null })
    if (!mounted.ok) return { ...mounted, verb: op, runtime: runtime() }
    const instance = nextInstance(plugin.id)
    loaded.set(plugin.id, { handle: mounted, record: { uid: mounted.uid, instance, entry: plugin.manifest.entry } })
    const closure = depsClosure(scanned, plugin.id)
    const payload = { ok: true, verb: op, id: plugin.id, layer: plugin.layer, uid: mounted.uid,
      from_uid: fromUid, instance,
      fiber_state: FIBER_STATE[mounted.state] ?? String(mounted.state),
      entry: plugin.manifest.entry, kind: mounted.kind,
      keys: mounted.keys, provides: plugin.manifest.provides,
      effects: mounted.effects, depends_on: closure.direct, missing_targets: closure.missing,
      unresolved_services: closure.unresolved,
      next_action: '装载后再 `status` 可回读 uid/effects；要热替换用 `reload`（新 uid，不迁移内存状态）',
      runtime: runtime() }
    if (op === 'reload' && (mounted.uid === fromUid || instance === fromInstance)) {
      payload.ok = false
      payload.code = 'mount-failed'
      payload.reason = '重载拿到了同一个 uid（不是新实例）'
      payload.next_action = '查 cordis fiber 是否被复用（reload 必须是新 fiber）'
    }
    return payload
  }
  return { ok: false, code: 'usage', op: op ?? null, reason: `未知 op：${JSON.stringify(op)}`,
    next_action: `用 ${VERBS.join('/')} 之一` }
}

/** 插件的一句话描述（list/status 共用；全部来自清单与实测装载表）。 */
function describe(plugin, loaded, scanned) {
  const entry = loaded?.get(plugin.id)
  const uid = entry?.record?.uid ?? null
  const closure = depsClosure(scanned, plugin.id)
  return {
    id: plugin.id, layer: plugin.layer, ns: plugin.ns ?? null,
    name: plugin.manifest?.name ?? plugin.plugin, version: plugin.manifest?.version ?? null,
    description: plugin.manifest?.description ?? null, provides: plugin.manifest?.provides ?? [],
    entry: plugin.manifest?.entry ?? null, kind: plugin.manifest?.entry ? entryKind(plugin.manifest.entry) : null,
    migration: plugin.manifest?.migration ?? null,
    valid: !plugin.invalid, reason: plugin.reason ?? null, next_action: plugin.next_action ?? null,
    status: uid === null ? 'not-loaded' : 'loaded', uid,
    deps_ready: closure.ok && (closure.missing ?? []).length === 0 && (closure.unresolved ?? []).length === 0,
    deps_direct: closure.direct, deps_missing: closure.missing, deps_unresolved: closure.unresolved,
    cycle: closure.cycle ?? null,
  }
}

// ---------------------------------------------------------------------------------------------
// 客户端侧：确保运行时在 → 发一条请求 → 打印
// ---------------------------------------------------------------------------------------------
function request(root, payload, timeoutMs = 8000) {
  return new Promise((ok, fail) => {
    const socket = net.createConnection(SOCKET_PATH(root))
    let data = ''
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      socket.destroy()
      if (error) fail(error); else ok(value)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('运行时请求超时')))
    socket.on('error', (err) => finish(err))
    socket.on('data', (chunk) => { data += chunk.toString('utf8') })
    socket.on('end', () => {
      const line = data.trim().split('\n').filter(Boolean).pop()
      if (!line) return finish(new Error('运行时没有回包（进程可能刚退出）'))
      try { finish(null, JSON.parse(line)) } catch (err) { finish(err) }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
  })
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** 探活（连得上且回 `{ok:true}` 才算在）：用来实现"单实例"与"陈旧 socket 清理"。 */
function pingOnce(socketPath, timeoutMs = 500) {
  return new Promise((ok) => {
    const socket = net.createConnection(socketPath)
    let data = ''
    let done = false
    const finish = (value) => { if (!done) { done = true; socket.destroy(); ok(value) } }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('data', (chunk) => { data += chunk.toString('utf8') })
    socket.on('end', () => {
      const line = data.trim().split('\n').filter(Boolean).pop()
      try { finish(line ? JSON.parse(line) : null) } catch { finish(null) }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'ping' })}\n`))
  })
}

/** 确保运行时进程在（按需拉起；幂等）。 */
async function ensureRuntime(root) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const pong = await request(root, { op: 'ping' })
      if (pong?.ok) return { ok: true, runtime: pong.runtime }
    } catch { /* 下面拉起 */ }
    mkdirSync(RUNTIME_DIR(root), { recursive: true })
    const fd = (() => { try { return openSync(LOG_PATH(root), 'a') } catch { return 'ignore' } })()
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', '--root', root],
      { detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
    for (let wait = 0; wait < 50; wait += 1) {
      await sleep(100)
      try {
        const pong = await request(root, { op: 'ping' })
        if (pong?.ok) return { ok: true, runtime: pong.runtime, spawned: child.pid }
      } catch { /* 继续等 */ }
    }
    log(`运行时拉起失败（第 ${attempt + 1} 次）：看 ${LOG_PATH(root)}`)
  }
  return { ok: false, code: 'cordis-missing',
    next_action: `运行时进程起不来：看 ${LOG_PATH(root)}（或设 $QUOTAGENT_PLUGIN_RUNTIME_LOG）` }
}

function require_fd(path) {
  return openSync(path, 'a')
}

async function runtimeControl(root, action) {
  if (action === 'status') {
    try {
      const pong = await request(root, { op: 'ping' })
      if (pong?.ok) return { ok: true, op: 'runtime.status', runtime: pong.runtime }
    } catch { /* 不在 */ }
    return { ok: true, op: 'runtime.status', runtime: { running: false, pid: null, socket: SOCKET_PATH(root) },
      next_action: '运行时不在（容器重建/被清进程后会这样）：任何 load 都会按需把它拉起来' }
  }
  if (action === 'start') {
    const ensured = await ensureRuntime(root)
    return { ok: ensured.ok, op: 'runtime.start', runtime: ensured.runtime ?? null,
      next_action: ensured.ok ? '运行时已就绪' : ensured.next_action }
  }
  if (action === 'stop') {
    let pid = null
    try { pid = Number(readFileSync(PID_PATH(root), 'utf8').trim()) } catch { /* 没有 pid 文件 */ }
    let pong = null
    try { pong = await request(root, { op: 'ping' }) } catch { /* 不在 */ }
    if (!pong?.ok) {
      return { ok: true, op: 'runtime.stop', runtime: { running: false }, stopped: false,
        next_action: '运行时本来就不在（不是错误）' }
    }
    try { process.kill(pong.runtime.pid, 'SIGTERM') } catch (err) {
      return { ok: false, op: 'runtime.stop', code: 'usage', reason: String(err.message).slice(0, 120),
        next_action: `手动 kill ${pong.runtime.pid}` }
    }
    for (let wait = 0; wait < 30; wait += 1) {
      await sleep(100)
      try { await request(root, { op: 'ping' }); } catch { return { ok: true, op: 'runtime.stop',
        runtime: { running: false, pid: pong.runtime.pid, pid_file: pid }, stopped: true,
        next_action: '运行时已停（下次 load 会重新拉起）' } }
    }
    return { ok: false, op: 'runtime.stop', code: 'usage', reason: 'SIGTERM 后运行时仍未退出',
      next_action: `手动 kill -9 ${pong.runtime.pid}` }
  }
  return { ok: false, op: 'runtime', code: 'usage', reason: `未知 --runtime 动作：${action}`,
    next_action: '--runtime start|stop|status' }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.error) {
    out(refuse(null, 'usage', null, args.error, 'tools/plugin.sh --help 看用法'))
    return 2
  }
  if (args.help) { process.stdout.write(`${USAGE}\n`); return 0 }
  const root = resolve(args.root ?? process.env.QUOTAGENT_PLUGIN_ROOT ?? repoRootOf(HERE))
  if (args.serve) { await serve(root); return 0 }
  if (args.runtime !== null) {
    const result = await runtimeControl(root, args.runtime)
    out(result, { pretty: args.pretty })
    return result.ok ? 0 : 1
  }

  if (args.verb === 'list' || args.verb === 'deps') {
    // 只读扫描：不需要运行时（不 import 任何插件）
    const scanned = scan(root)
    if (args.layer !== null && !LAYERS.includes(args.layer)) {
      out(refuse(args.verb, 'illegal-layer', args.id, `层名非法：${args.layer}`,
        `层只认 ${LAYERS.join(' | ')}`, { candidates: LAYERS }))
      return 1
    }
    if (args.verb === 'list') {
      const items = scanned.plugins.filter((item) => args.layer === null || item.layer === args.layer)
        .map((item) => describe(item, null, scanned))
      if (args.json) {
        out({ ok: true, verb: 'list', root, layer: args.layer, count: items.length, plugins: items,
          degraded: scanned.degraded })
      } else {
        for (const item of items) out(item)
      }
      return 0
    }
    const found = findPlugin(scanned, args.id)
    if (!found.ok) { out({ ...found, verb: 'deps' }); return 1 }
    const closure = depsClosure(scanned, args.id)
    out({ ok: closure.ok, verb: 'deps', id: args.id, code: closure.code ?? null, direct: closure.direct,
      closure: closure.closure, order: closure.order, cycle: closure.cycle ?? null,
      unresolved_services: closure.unresolved, missing_targets: closure.missing,
      next_action: closure.ok ? '依赖闭包已给出（顺序即拓扑序）'
        : `环：${(closure.cycle ?? []).join(' → ')}（去掉其中一条 depends_on）` }, { pretty: args.pretty })
    return closure.ok ? 0 : 1
  }

  // status/load/reload/unload：需要运行时
  const ensured = await ensureRuntime(root)
  if (!ensured.ok) { out({ ok: false, verb: args.verb, id: args.id, ...ensured }); return 1 }
  let response = null
  try {
    response = await request(root, { op: args.verb, id: args.id, config: args.config })
  } catch (err) {
    out(refuse(args.verb, 'usage', args.id, `运行时请求失败：${String(err.message).slice(0, 160)}`,
      `看 ${LOG_PATH(root)}；必要时 tools/plugin.sh --runtime stop 再试`))
    return 1
  }
  out(response, { pretty: args.pretty })
  return response.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    log(String(err && err.stack ? err.stack : err))
    process.exit(2)
  })
}
