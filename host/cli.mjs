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
import { makeConfigHostPlugin, requestUpdate, digestOf } from './lib/config.mjs'
import { SCHEMA } from './lib/schema.mjs'
import { PROFILES, profileDir } from './profiles.mjs'

const require_ = createRequire(import.meta.url)
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
         actions: ['boot', 'status', 'config-update'], cordis_version: CORDIS_VERSION })
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
