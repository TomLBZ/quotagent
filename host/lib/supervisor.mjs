/**
 * 内核进程监督者（T-217，ADR-0013 §6）：重启预算、锚点比对、只读降级、在途请求记 unknown、关闭不留孤儿。
 *
 * 契约：
 *   · 崩溃重启预算 **3 次/30s**；超预算 → 降为**只读**（拒 fact/commit，保 read/compute）；
 *   · 重启后锚点（`ledger.head/seq`）与宿主记录不一致 → 内核落 `kernel/bridge-fault` 并自行降只读；
 *   · **在途请求一律记 unknown（不得当成功）**；
 *   · 关闭顺序 `bridge.shutdown → SIGTERM → SIGKILL`，并断言进程确实消失（无孤儿）；
 *   · 启动失败（退出码 3）**不写账本**。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { BRIDGE_VERSION } from './bridge.mjs'

export const RESTART_BUDGET = 3
export const RESTART_WINDOW_MS = 30_000
export const SHUTDOWN_GRACE_MS = 1500

export class KernelSupervisor {
  constructor({ repoRoot, realm, ledger, profile = '', node = null, acceptBridge = [BRIDGE_VERSION],
                creditWindow = null, factSurface = 'closed', session = '' }) {
    this.repoRoot = repoRoot
    this.realm = realm
    this.ledger = ledger
    this.profile = profile
    this.node = node
    this.acceptBridge = acceptBridge
    this.creditWindow = creditWindow
    this.factSurface = factSurface
    this.session = session || `s-${Date.now()}`
    this.restarts = 0
    this.restartStamps = []
    this.readOnly = false
    this.anchor = null
    this.inFlight = new Map()
    this.unknown = []
    this.child = null
    this.frames = []
    this.errors = []
    this.logs = []
    this.stderrRaw = []
    this.crashes = []
    this.orphan = null
  }

  // ---------------------------------------------------------------- 进程
  start({ extraArgs = [] } = {}) {
    const env = { ...process.env }
    if (this.node) env.QUOTAGENT_NODE = this.node
    const args = ['-m', 'quotagent.bridge', '--serve', '--realm', this.realm, '--ledger', this.ledger,
                  '--profile', this.profile, '--session', this.session,
                  '--restarts', String(this.restarts), '--fact-surface', this.factSurface]
    if (this.anchor) args.push('--anchor', this.anchor, '--anchor-seq', String(this.anchorSeq ?? 0))
    if (this.readOnly) args.push('--read-only')
    if (this.creditWindow) args.push('--credit-window', String(this.creditWindow))
    this.child = spawn(join(this.repoRoot, 'tools', 'run.sh'), args,
      { cwd: this.repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this._decode(this.child.stdout, false)
    this._decode(this.child.stderr, true)
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal }
      const open = [...this.inFlight.values()].filter((item) => item.state === 'in-flight')
      for (const item of open) {
        item.state = 'unknown'
        this.unknown.push({ id: item.id, method: item.method, reason: 'kernel-exited-before-reply', exit: code, signal })
      }
    })
    return this
  }

  _decode(stream, isLog) {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        if (isLog) { this.logs.push(line); this.stderrRaw.push(line); continue }
        let frame
        try { frame = JSON.parse(line) } catch { this.errors.push({ parse_error: line.slice(0, 120) }); continue }
        this.frames.push(frame)
        if (frame.n === 'error') this.errors.push(frame.p)
      }
    })
  }

  send(frame) { this.child.stdin.write(JSON.stringify(frame) + '\n') }

  async waitFor(predicate, timeoutMs = 15000) {
    const test = typeof predicate === 'function' ? predicate : (frame) => frame.n === predicate
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.find(test)
      if (found) return found
      if (this.exit) throw new Error(`内核已退出（${JSON.stringify(this.exit)}），未等到帧`)
      if (Date.now() > deadline) throw new Error('等待帧超时')
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }

  async waitForExit(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (!this.exit) {
      if (Date.now() > deadline) throw new Error('等待内核退出超时')
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return this.exit
  }

  /** 握手：hello → init → ready（或版本不兼容 → 退出码 2）。 */
  async handshake() {
    const hello = (await this.waitFor('kernel/hello')).p
    this.hello = hello
    this.anchor = hello.ledger.head
    this.anchorSeq = hello.ledger.seq
    const init = { accept_bridge: this.acceptBridge, profile: this.profile, want_events: [] }
    if (this.creditWindow) init.credit_window = this.creditWindow
    this.send({ v: 1, n: 'bridge.init', p: init })
    if (!this.acceptBridge.includes(hello.bridge.version)) {
      const error = await this.waitFor('error')
      return { ok: false, code: error.p.code, hello, exit: await this.waitForExit() }
    }
    this.ready = (await this.waitFor('bridge.ready')).p
    return { ok: true, hello, ready: this.ready }
  }

  // ---------------------------------------------------------------- 调用与崩溃
  async call(method, params = {}, { id = null, timeoutMs = 15000 } = {}) {
    const callId = id ?? this.inFlight.size + 1
    this.inFlight.set(callId, { id: callId, method, params, state: 'in-flight', at: Date.now() })
    this.send({ v: 1, n: 'method', p: { id: callId, m: method, params } })
    const frame = await this.waitFor((f) => (f.n === 'result' || f.n === 'error') && f.p.id === callId, timeoutMs)
    this.inFlight.get(callId).state = frame.n === 'result' ? 'done' : 'refused'
    // 成功调用后刷新"最后观测到的锚点"（用于重启时的回滚/替换检测）
    const seen = this.frames.filter((f) => f.n === 'result' && f.p.m === 'ledger.head').pop()
    if (seen?.p?.result?.head) { this.anchor = seen.p.result.head; this.anchorSeq = seen.p.result.seq }
    return frame
  }

  kill(signal = 'SIGKILL') {
    if (this.child && !this.exit) this.child.kill(signal)
    return this
  }

  /** 崩溃后重启：预算 3 次/30s，超预算 → 只读降级。 */
  async restart() {
    const now = Date.now()
    this.restartStamps = this.restartStamps.filter((stamp) => now - stamp < RESTART_WINDOW_MS)
    this.restartStamps.push(now)
    this.restarts += 1
    if (this.restartStamps.length > RESTART_BUDGET) {
      this.readOnly = true
      this.readOnlyReason = 'restart-budget-exceeded'
    }
    this.child = null
    this.exit = null
    this.frames = []
    this.errors = []
    this.start()
    const handshake = await this.handshake()
    return { restarts: this.restarts, window_used: this.restartStamps.length, read_only: this.readOnly,
             ok: handshake.ok, ready: handshake.ready ?? null }
  }

  async credit(n) { this.send({ v: 1, n: 'bridge.credit', p: { n } }) }

  async shutdown() {
    if (!this.child || this.exit) return { exit: this.exit, escalated: [] }
    const escalated = []
    this.send({ v: 1, n: 'bridge.shutdown', p: {} })
    const graceful = await Promise.race([
      this.waitForExit(SHUTDOWN_GRACE_MS).then(() => true).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
    ])
    if (!graceful) {
      escalated.push('SIGTERM'); this.kill('SIGTERM')
      const term = await Promise.race([
        this.waitForExit(SHUTDOWN_GRACE_MS).then(() => true).catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
      ])
      if (!term) { escalated.push('SIGKILL'); this.kill('SIGKILL'); await this.waitForExit(SHUTDOWN_GRACE_MS).catch(() => null) }
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    this.orphan = this.pidAlive()
    return { exit: this.exit, escalated, orphan: this.orphan }
  }

  pidAlive() {
    const pid = this.child?.pid
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  status() {
    return { session: this.session, restarts: this.restarts, window_used: this.restartStamps.length,
             read_only: this.readOnly, anchor: this.anchor, anchor_seq: this.anchorSeq,
             unknown_in_flight: this.unknown, orphan: this.orphan,
             frames: this.frames.length, errors: this.errors.length,
             events: this.frames.filter((f) => f.n === 'event').length }
  }
}
