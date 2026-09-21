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
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeConfigHostPlugin, requestUpdate, digestOf } from './lib/config.mjs'
import { SCHEMA } from './lib/schema.mjs'
import { PROFILES, profileDir } from './profiles.mjs'
import { BridgeClient, BRIDGE_VERSION, ledgerExists } from './lib/bridge.mjs'
import { KernelSupervisor } from './lib/supervisor.mjs'

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
         actions: ['boot', 'status', 'config-update', 'bridge', 'supervise'], cordis_version: CORDIS_VERSION,
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
  if (action === 'webui') {
    // WebUI 插件（每方视角一个路由）。宿主**不写账本**：只读视图 + Python 侧链校验（H1）。
    const { openLedger } = await import('./lib/ledger-view.mjs')
    const { apply: webuiApply, Config: webuiConfig } = await import('./modules/webui.mjs')
    const { VIEW_RULES } = await import('./modules/projection.mjs')
    const ctx = new Context()
    await ctx.plugin(EventsService)
    // 运行期准入（独立插件）先挂：webui 的 inject 依赖它
    const { apply: governorApply, Config: governorConfig } = await import('./modules/governor.mjs')
    await ctx.plugin({ name: 'governor', inject: [], Config: governorConfig,
      apply: (inner, cfg) => governorApply(inner, cfg) },
      governorConfig.parse({ capacity: Number(args.capacity ?? 64), timeout_ms: Number(args['timeout-ms'] ?? 5000) }))
    // 投影服务（独立插件）必须先挂：webui 的 inject 依赖它
    const { apply: projectionApply, Config: projectionConfig } = await import('./modules/projection.mjs')
    await ctx.plugin({
      name: 'projection',
      inject: [],
      Config: projectionConfig,
      apply: (inner, cfg) => projectionApply(inner, cfg),
    }, projectionConfig.parse({}))
    const contractorLedger = String(args['ledger-contractor'] ?? ledgerPath)
    ctx.provide('ledgerView', openLedger(contractorLedger))
    const box = {}
    const fiber = await ctx.plugin({
      name: 'webui',
      inject: ['ledgerView', 'projection', 'governor'],   // 投影是独立插件（host/modules/projection.mjs），必须一起注入
      Config: webuiConfig,
      apply: async (inner, config) => {
        const original = inner.provide.bind(inner)
        inner.provide = (service, value) => { if (service === 'webui') box.handle = value; return original(service, value) }
        await webuiApply(inner, config)
      },
    }, {
      port: Number(args.port ?? 8093),
      listen_host: String(args.host ?? '127.0.0.1'),
      route_prefix: String(args.prefix ?? '/quotagent'),
      views: String(args.views ?? 'contractor,supplier').split(',').map((item) => item.trim()).filter(Boolean),
      ledger_contractor: contractorLedger,
      ledger_supplier: String(args['ledger-supplier'] ?? ''),
    })
    // 注意：这里**不能**用 emit()（它写完就 process.exit）——UI 是常驻服务
    process.stdout.write(JSON.stringify({ ok: true, action: 'webui', profile: profileName, pid: process.pid,
           url: box.handle?.url, port: box.handle?.port, prefix: box.handle?.prefix,
           views: Object.keys(VIEW_RULES), routes: (box.handle ? Object.keys(VIEW_RULES) : [])
             .map((view) => box.handle.viewUrl(view)),
           ledgers: { contractor: contractorLedger, supplier: String(args['ledger-supplier'] ?? '') },
           note: '每方视角读自己的账本（结构性隔离）+ 投影白名单（纵深防御）；宿主不写账本' }) + '\n')
    // 保活：直到收到信号（ws-gateway 以 SIGTERM 停服）
    await new Promise((resolve) => {
      const stop = async () => { await fiber.dispose(); resolve() }
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
    })
    return
  }
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
    // canary 接线（可选）：`--canary-weight <bps>` > 0 时，真实桥调用按 canary 分桶走 base/候选。
    // 默认 0 = 全部走 base，行为与未接线时完全一致（升级路径安全）。
    let canaryDispatch = null
    let canaryProbe = null   // {decision, exited, samples}
    // 编排 lib 的导入必须在**函数作用域**（放 if 块里会让 catch 看不到 → CanaryApprovalRequired is not defined）
    const { runCanary, CanaryApprovalRequired } = await import('./lib/canary-run.mjs')
    let auditSlice = null
    const canaryWeight = Number(args['canary-weight'] ?? 0)
    if (canaryWeight > 0 || args['candidate-module']) {
      const ctx = new Context()
      await ctx.plugin(EventsService)
      const { apply: canaryApply, Config: canaryConfig } = await import('./modules/canary.mjs')
      const cbox = {}
      await ctx.plugin({ name: 'canary', inject: [], Config: canaryConfig,
        apply: async (inner, cfg) => {
          const originalProvide = inner.provide.bind(inner)
          inner.provide = (service, value) => {
            if (service === 'canary') cbox.handle = value
            return originalProvide(service, value)
          }
          await canaryApply(inner, cfg)
        } }, canaryConfig.parse({ weight_bps: canaryWeight }))
      const { apply: bcApply, Config: bcConfig } = await import('./modules/bridge-canary.mjs')
      const dbox = {}
      await ctx.plugin({ name: 'bridge-canary', inject: ['canary'], Config: bcConfig,
        apply: async (inner, cfg) => {
          const original = inner.provide.bind(inner)
          inner.provide = (service, value) => { if (service === 'canary-dispatch') dbox.handle = value; return original(service, value) }
          await bcApply(inner, cfg)
        } }, bcConfig.parse({ realm: profile.realm, name: `bridge:${profileName}` }))
      const candidatePath = args['candidate-module'] ? String(args['candidate-module']) : null
      const candidate = candidatePath ? (await import(pathToFileURL(resolve(REPO_ROOT, candidatePath)).href)).call : null
      dbox.handle.register({ base: (method, params) => client.call(method, params), candidate,
        candidate_name: candidatePath ?? '' })
      canaryDispatch = { weight_bps: canaryWeight, candidate: candidatePath, dispatch: dbox.handle, canary: cbox.handle }
      // 审计留痕（观测用，**不是账本**）：把这次 canary 决策记进 audit 流水，随命令输出回读
      const { apply: auditApply, Config: auditConfig } = await import('./modules/audit-hook.mjs')
      const abox = {}
      await ctx.plugin({ name: 'audit-hook', inject: [], Config: auditConfig,
        apply: async (inner, cfg) => {
          const original = inner.provide.bind(inner)
          inner.provide = (service, value) => { if (service === 'audit') abox.handle = value; return original(service, value) }
          await auditApply(inner, cfg)
        } }, auditConfig.parse({}))
      abox.handle.record({ type: 'canary/dispatch-registered', correlation_id: `bridge:${profileName}`,
        realm: profile.realm, source: 'decision',
        body: { weight_bps: canaryWeight, candidate: candidatePath ?? null } })
      auditSlice = abox.handle
    }
    const handshake = await client.handshake({ acceptBridge: accept, wantEvents, profile: profileName })
    if (!handshake.ok) {
      const code = await client.stop()
      emit({ ok: false, action: 'bridge', phase: 'handshake', profile: profileName, realm: profile.realm,
             accept_bridge: accept, error: handshake.error.p, exit_code: code,
             ledger_path: ledgerPath, ledger_exists: ledgerExists(ledgerPath),
             stderr_log_lines: client.stderr.length })
    }
    if (canaryDispatch) {
      const stats = canaryDispatch.dispatch.stats()
      process.stderr.write(`[bridge-canary] 接线：weight=${canaryDispatch.weight_bps}bps 候选=${canaryDispatch.candidate ?? '（无）'} stats=${JSON.stringify(stats)}\n`)
    }
    let call = null
    let call_lane = null
    let call_fallback = false
    if (args.method) {
      const params = args.params ? JSON.parse(args.params) : {}
      if (args.claim) params.source = args.claim
      // 真走分流器（不是"注册了就完事"）：--canary-weight > 0 时由 canary 决定走 base 还是候选。
      // 候选抛出时 dispatcher 回退 base，调用方仍拿到正确答案（失败隔离）。
      let frame
      if (canaryDispatch) {
        // 编排在 lib 里（D-029）：进（需人工引用）→ 探针 → 判定 → 退化自动回滚（安全动作免批准）
        try {
          canaryProbe = runCanary({
            canary: canaryDispatch.canary,
            dispatch: canaryDispatch.dispatch,
            method: String(args.method),
            params,
            probeCount: Number(args['canary-probe'] ?? 1),
            approval_ref: String(args['canary-approval'] ?? ''),
            proposal_id: String(args['candidate-module'] ?? `bridge:${profileName}`),
          })
        } catch (err) {
          if (err instanceof CanaryApprovalRequired) {
            emit({ ok: false, action: 'bridge', phase: 'canary-enter', profile: profileName,
                   error: err.message, code: err.code }, 2)
          }
          throw err
        }
        frame = await canaryProbe.last_result
        call_lane = canaryProbe.last_lane
        call_fallback = canaryProbe.samples.fallbacks > 0
        // 退化（自动回滚）落账：账本唯一写入者是 Python 侧（H1），宿主只触发工具；工具失败不掩盖回滚事实
        if (canaryProbe.exited) {
          const { spawnSync } = await import('node:child_process')
          const body = JSON.stringify({ proposal_id: canaryProbe.exited.proposal_id ?? null,
            reason: canaryProbe.exited.reason ?? 'auto-rollback', automatic: true,
            verdict: canaryProbe.decision?.verdict ?? null })
          const out = spawnSync('python3', [join(REPO_ROOT, 'tools', 'evolve-record.py'),
            '--event', 'evolve/canary-exited', '--body', body], { cwd: REPO_ROOT, encoding: 'utf8' })
          canaryProbe.ledger_record = out.status === 0
            ? { ok: true, event: 'evolve/canary-exited' }
            : { ok: false, event: 'evolve/canary-exited', detail: (out.stderr || out.stdout || '').trim().slice(0, 200) }
        }
      } else {
        frame = await client.call(String(args.method), params, { id: Number(args.id ?? 1) })
      }
      call = frame
    }
    client.shutdown(); const code = await client.stop()
    const errorFrame = call && call.n === 'error' ? call.p : null
    emit({ ok: Boolean(call ? call.n === 'result' : true), action: 'bridge', phase: 'call',
           profile: profileName, realm: profile.realm, ledger_path: ledgerPath,
           call_lane, call_fallback,
           canary: canaryProbe ? { decision: canaryProbe.decision, exited: canaryProbe.exited,
             samples: canaryProbe.samples, ledger_record: canaryProbe.ledger_record ?? null } : null,
           audit: auditSlice ? { records: auditSlice.decisions({ limit: 5 }).length, stats: auditSlice.stats(),
             slice: auditSlice.decisions({ limit: 5 }).map((item) => ({ type: item.type, source: item.source, summary: item.summary })) } : null,
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

  if (action === 'supervise') {
    // 故障注入场景（供 AC-INTEG-006 驱动）：宿主侧监督者按 ADR-0013 §6 的语义把结果一次交清。
    const scenario = String(args.scenario ?? 'crash-restart')
    const sceneRoot = join(dir, `scene-${scenario}`)
    mkdirSync(sceneRoot, { recursive: true })
    const ledgerPath = join(sceneRoot, 'ledger.jsonl')
    const common = { repoRoot: REPO_ROOT, realm: profile.realm, ledger: ledgerPath, profile: profileName,
                     node: process.env.QUOTAGENT_NODE ?? null, session: `s-${scenario}` }
    const report = { ok: true, action: 'supervise', scenario, profile: profileName, realm: profile.realm,
                     ledger_path: ledgerPath }

    if (scenario === 'crash-restart') {
      const sup = new KernelSupervisor(common).start()
      await sup.handshake()
      await sup.call('approval.decide', { approval_id: 'pre-crash' })   // 制造一条 durable 条目
      const before = await sup.call('ledger.read', { from_seq: 1 })
      const durableBefore = before.p.result.entries.map((entry) => entry.type)
      sup.kill('SIGKILL')
      const killed = await sup.waitForExit()
      const revived = await sup.restart()
      const after = await sup.call('ledger.read', { from_seq: 1 })
      const verify = await sup.call('ledger.verify', {})
      const status = await sup.call('bridge.status', {})
      const shutdown = await sup.shutdown()
      Object.assign(report, {
        killed_signal: killed.signal, restarts: revived.restarts, read_only_after: revived.read_only,
        durable_before: durableBefore,
        durable_after: after.p.result.entries.map((entry) => entry.type),
        hash_chain_ok: verify.p.result.report.ok,
        verify_first_bad_seq: verify.p.result.report.first_bad_seq ?? null,
        kernel_status: status.p.result,
        unknown_in_flight: sup.unknown,
        shutdown,
      })
      report.ledger_entries = after.p.result.entries.map((entry) => ({ seq: entry.seq, type: entry.type }))
      emit(report)
    }

    if (scenario === 'crash-in-flight') {
      const sup = new KernelSupervisor(common).start()
      await sup.handshake()
      sup.kill('SIGSTOP')                           // 先冻结：该请求必然拿不到回帧（确定性的"在途"）
      await new Promise((resolve) => setTimeout(resolve, 20))
      const pending = sup.call('ledger.count', {}, { id: 77, timeoutMs: 5000 })
      pending.catch(() => null)                     // 在途请求：崩溃后不得当成功
      await new Promise((resolve) => setTimeout(resolve, 30))
      sup.kill('SIGKILL')
      await sup.waitForExit()
      const revived = await sup.restart()
      const count = await sup.call('ledger.count', {})
      const shutdown = await sup.shutdown()
      Object.assign(report, { restarts: revived.restarts, unknown_in_flight: sup.unknown,
                              ambiguous_request_id: 77,
                              in_flight_state: sup.inFlight.get(77)?.state ?? null,
                              after_restart_count: count.p.result.count, shutdown })
      emit(report)
    }

    if (scenario === 'restart-budget') {
      const sup = new KernelSupervisor(common).start()
      await sup.handshake()
      const rounds = []
      for (let i = 0; i < 4; i++) {
        sup.kill('SIGKILL'); await sup.waitForExit()
        const revived = await sup.restart()
        const readCall = await sup.call('ledger.count', {})
        const commitCall = await sup.call('approval.decide', { approval_id: `post-${i}` })
        rounds.push({ round: i + 1, read_only: revived.read_only, window_used: revived.window_used,
                      read_ok: readCall.n === 'result',
                      commit_code: commitCall.n === 'error' ? commitCall.p.code : null,
                      commit_read_only: commitCall.n === 'error' ? Boolean(commitCall.p.data?.read_only) : false })
      }
      const shutdown = await sup.shutdown()
      Object.assign(report, { rounds, read_only: sup.readOnly, shutdown })
      emit(report)
    }

    if (scenario === 'backpressure') {
      const sup = new KernelSupervisor({ ...common, creditWindow: 1 }).start()
      await sup.handshake()
      for (let i = 1; i <= 6; i++) await sup.call('approval.decide', { approval_id: `bp-${i}` })
      const midStatus = await sup.call('bridge.status', {})
      await sup.credit(50)
      const afterCredit = await sup.call('bridge.status', {})
      const read = await sup.call('ledger.read', { from_seq: 1 })
      const shutdown = await sup.shutdown()
      Object.assign(report, {
        kernel_status_under_backpressure: midStatus.p.result,
        kernel_status_after_credit: afterCredit.p.result,
        ledger_entries: read.p.result.entries.map((entry) => ({ seq: entry.seq, type: entry.type })),
        backpressure_bodies: read.p.result.entries.filter((entry) => entry.type === 'kernel/bridge-backpressure')
                                     .map((entry) => entry.body),
        durable_recoverable: read.p.result.entries.filter((entry) => entry.type === 'kernel/bridge-rejected').length,
        shutdown,
      })
      emit(report)
    }

    if (scenario === 'orphan') {
      const sup = new KernelSupervisor(common).start()
      await sup.handshake()
      const pid = sup.child.pid
      const aliveBefore = sup.pidAlive()
      const shutdown = await sup.shutdown()
      Object.assign(report, { pid, alive_during: aliveBefore, alive_after: sup.pidAlive(),
                              exit_code: shutdown.exit?.code ?? null, shutdown })
      emit(report)
    }

    if (scenario === 'anchor-mismatch') {
      const sup = new KernelSupervisor(common).start()
      await sup.handshake()
      await sup.call('approval.decide', { approval_id: 'a-1' })
      const shutdown1 = await sup.shutdown()
      const stale = 'sha256:' + 'ab'.repeat(32)
      // 第二次启动：宿主给一个**不在链中**的锚点（历史被替换的等价情形）
      const sup3 = new KernelSupervisor({ ...common })
      sup3.anchor = stale
      sup3.start()
      await sup3.handshake()
      const status = await sup3.call('bridge.status', {})
      const readCall = await sup3.call('ledger.count', {})
      const commitCall = await sup3.call('approval.decide', { approval_id: 'a-2' })
      const shutdown3 = await sup3.shutdown()
      Object.assign(report, { stale_anchor: stale, first_shutdown: shutdown1, kernel_status: status.p.result,
                              read_ok: readCall.n === 'result',
                              commit_code: commitCall.n === 'error' ? commitCall.p.code : null,
                              commit_read_only: Boolean(commitCall.p.data?.read_only), shutdown: shutdown3 })
      emit(report)
    }

    if (scenario === 'startup-failure') {
      const badLedger = join(sceneRoot, 'as-directory')
      mkdirSync(badLedger, { recursive: true })          // 账本路径是目录 → 打开即失败
      const sup = new KernelSupervisor({ ...common, ledger: badLedger }).start()
      const exit = await sup.waitForExit(15000).catch((err) => ({ error: String(err) }))
      Object.assign(report, { ok: false, bad_ledger: badLedger, exit_code: exit?.code ?? null,
                              orphan: sup.pidAlive(), frames: sup.frames.length,
                              ledger_written: ledgerExists(join(badLedger, 'ledger.jsonl')) })
      emit(report)
    }

    emit({ ok: false, error: `未知 scenario: ${scenario}`, known: ['crash-restart', 'crash-in-flight',
           'restart-budget', 'backpressure', 'orphan', 'anchor-mismatch', 'startup-failure'] }, 2)
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

main().catch((err) => emit({ ok: false, error: `${err?.name ?? 'Error'}: ${err?.message ?? err}`,
  // 调试栈：只在 QUOTAGENT_DEBUG=1 时给（默认输出保持稳定、可机检）
  stack: process.env.QUOTAGENT_DEBUG ? String(err?.stack ?? '').split('\n').slice(0, 6) : undefined }, 3))
