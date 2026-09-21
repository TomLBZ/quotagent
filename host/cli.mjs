#!/usr/bin/env node
/**
 * 宿主 CLI（T-201 / S1.1）：启停一个 profile、更新它的配置、查状态。
 * **stdout 只输出一行 JSON**（机器可读；日志走 stderr）——沿用 ADR-0013 的帧纪律。
 *
 *   tools/cordis.sh run cli.mjs boot          --profile contractor-ops --root DIR [--hold SECONDS]
 *   tools/cordis.sh run cli.mjs status        --profile contractor-ops --root DIR
 *   tools/cordis.sh run cli.mjs config-update --profile contractor-ops --root DIR \
 *        --patch '{"compare":{"weights":{"price":0.5}}}' --source human:zhang --reason "..."
 *
 * 配置更新走 cordis **原生** `fiber.update()` + `internal/update` 瀑布：
 * 守卫不调 `next()` 即否决 → 配置不变、插件不重启（FR-PLUGIN-004）。
 */
import { Context, EventsService, RegistryService } from 'cordis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { makeConfigHostPlugin, requestUpdate, digestOf } from './lib/config.mjs'
import { SCHEMA } from './lib/schema.mjs'
import { PROFILES, profileDir } from './profiles.mjs'
import { BridgeClient, BRIDGE_VERSION, ledgerExists } from './lib/bridge.mjs'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORDIS_VERSION = require_('cordis/package.json').version

const parseArgs = (argv) => {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(token)
  }
  return out
}

const emit = (payload, code = 0) => {
  process.stdout.write(JSON.stringify(payload) + '\n')
  process.exit(code)
}

const args = parseArgs(process.argv.slice(2))
const action = args._[0] ?? 'help'
if (action === 'help') {
  emit({ ok: true, action: 'help', profiles: Object.keys(PROFILES),
         actions: ['boot', 'status', 'config-update', 'bridge'], cordis_version: CORDIS_VERSION,
         bridge_version: BRIDGE_VERSION })
}
const profileName = args.profile
if (!profileName) emit({ ok: false, error: '缺少 --profile' }, 2)
const profile = PROFILES[profileName]
if (!profile) emit({ ok: false, error: `未知 profile: ${profileName}`, known: Object.keys(PROFILES) }, 2)
const root = args.root ?? join(process.cwd(), 'tmp', 'host-root')
const dir = profileDir(root, profileName)
const configPath = join(dir, 'config.json')
const ledgerPath = join(dir, profile.ledger)

const bootHost = async () => {
  mkdirSync(dir, { recursive: true })
  const onDisk = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null
  const initial = onDisk ?? profile.config
  const state = { schema: SCHEMA, history: [] }
  const persist = (config) => {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    state.persistedDigest = digestOf(config)
    return true
  }
  const ctx = new Context()
  await ctx.plugin(EventsService)
  await ctx.plugin(RegistryService)
  const fiber = await ctx.plugin(makeConfigHostPlugin({ state, persist, profile: profileName }), initial)
  return { ctx, fiber, state }
}

const describe = (state) => ({
  ok: true,
  action,
  profile: profileName,
  role: profile.role,
  label: profile.label,
  realm: profile.realm,
  ledger: ledgerPath,
  dir,
  pid: process.pid,
  node: process.version,
  cordis_version: CORDIS_VERSION,
  modules: profile.modules,
  sidecar: profile.sidecar,
  fiber_uid: state.uid,
  config_epoch: state.epoch,
  config_digest: state.digest,
  config_file: configPath,
  config_file_exists: existsSync(configPath),
})

const main = async () => {
  if (action === 'status') {
    const onDisk = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null
    emit({ ok: true, action: 'status', profile: profileName, realm: profile.realm, dir,
           config_file_exists: Boolean(onDisk), config_digest_on_disk: onDisk ? digestOf(onDisk) : null,
           ledger_exists: existsSync(ledgerPath), pid: process.pid })
  }

  const { fiber, state } = await bootHost()

  if (action === 'boot') {
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(state.config, null, 2) + '\n', 'utf8')
    const hold = Number(args.hold ?? 0)
    process.stdout.write(JSON.stringify(describe(state)) + '\n')
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold * 1000))
    return
  }

  if (action === 'bridge') {
    const accept = String(args.accept ?? BRIDGE_VERSION).split(',').map((s) => s.trim()).filter(Boolean)
    const wantEvents = String(args['want-events'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const ledgerPath = join(dir, profile.ledger)
    mkdirSync(dir, { recursive: true })
    const client = new BridgeClient({ repoRoot: REPO_ROOT, realm: profile.realm, ledger: ledgerPath,
                                      profile: profileName, node: process.env.QUOTAGENT_NODE ?? null }).start()
    const handshake = await client.handshake({ acceptBridge: accept, wantEvents, profile: profileName })
    if (!handshake.ok) {
      const code = await client.stop()
      emit({ ok: false, action: 'bridge', phase: 'handshake', profile: profileName, realm: profile.realm,
             accept_bridge: accept, error: handshake.error.p, exit_code: code,
             ledger_path: ledgerPath, ledger_exists: ledgerExists(ledgerPath),
             stderr_log_lines: client.stderr.length })
    }
    let call = null
    if (args.method) {
      const params = args.params ? JSON.parse(args.params) : {}
      if (args.claim) params.source = args.claim
      const frame = await client.call(String(args.method), params, { id: Number(args.id ?? 1) })
      call = frame
    }
    client.shutdown(); const code = await client.stop()
    const errorFrame = call && call.n === 'error' ? call.p : null
    emit({ ok: Boolean(call ? call.n === 'result' : true), action: 'bridge', phase: 'call',
           profile: profileName, realm: profile.realm, ledger_path: ledgerPath,
           hello: handshake.hello ? {
             bridge: handshake.hello.bridge, kernel: handshake.hello.kernel,
             qep_versions: handshake.hello.qep_versions, features: handshake.hello.features,
             events_count: handshake.hello.events.length, methods: handshake.hello.methods.map((m) => m.m),
             methods_refused: handshake.hello.methods_refused.map((m) => m.m),
             ledger: handshake.hello.ledger, realms: handshake.hello.realms,
             max_frame_bytes: handshake.hello.max_frame_bytes, credit_window: handshake.hello.credit_window } : null,
           ready: handshake.ready ?? null,
           call: call ? { n: call.n, id: call.p.id, m: call.p.m ?? null,
                          result: call.p.result ?? null, error: errorFrame ? { code: errorFrame.code,
                          message: errorFrame.message, next_action: errorFrame.next_action,
                          data: errorFrame.data } : null } : null,
           method: args.method ?? null, claim: args.claim ?? null,
           exit_code: code, stderr_log_lines: client.stderr.length,
           stdout_frames_only: client.frames.every((f) => f.n || f.parse_error === undefined) })
  }

  if (action === 'config-update') {
    if (!args.patch) emit({ ok: false, error: '缺少 --patch <json>' }, 2)
    let patch
    try { patch = JSON.parse(args.patch) } catch (err) { emit({ ok: false, error: `--patch 不是合法 JSON: ${err.message}` }, 2) }
    const beforeFile = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
    const result = await requestUpdate(fiber, state, patch,
      { source: args.source ?? 'unknown', reason: args.reason ?? '' })
    const afterFile = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
    emit({
      ok: true, action: 'config-update', profile: profileName, realm: profile.realm,
      source: args.source ?? 'unknown', reason: args.reason ?? '', patch,
      accepted: result.accepted, vetoed_by: result.vetoed_by, reasons: result.reasons,
      digest_before: result.digest_before, digest_after: result.digest_after,
      epoch_before: result.epoch_before, epoch_after: result.epoch_after,
      restarted: result.restarted,
      config_file_changed: beforeFile !== afterFile,
      pid: process.pid,
    })
  }

  emit({ ok: false, error: `未知 action: ${action}（可用 boot|status|config-update|help）` }, 2)
}

main().catch((err) => emit({ ok: false, error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` }, 3))
