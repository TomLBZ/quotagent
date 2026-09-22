/**
 * 宿主侧桥客户端（ADR-0013 §1-2）：spawn 内核子进程，走 NDJSON/stdio 协议帧。
 *
 * 纪律（可执行断言）：**stdout 只读协议帧**，内核日志在 stderr；内核首帧是 `kernel/hello`；
 * 宿主回 `bridge.init`；**accept_bridge 交集为空 → 内核退出码 2，账本零新增**。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const BRIDGE_VERSION = '1.0'
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** 内核端点：常驻子进程 + 帧读写（一行一帧）。 */
export class BridgeClient {
  constructor({ repoRoot, realm, ledger, profile = '', factSurface = 'closed', node = null }) {
    this.repoRoot = repoRoot
    this.realm = realm
    this.ledger = ledger
    this.profile = profile
    this.factSurface = factSurface
    this.node = node
    this.child = null
    this.hello = null
    this.ready = null
    this.stderr = []
    this.frames = []
    this.exitCode = null
  }

  start() {
    const env = { ...process.env }
    if (this.node) env.QUOTAGENT_NODE = this.node
    this.child = spawn(join(this.repoRoot, 'tools', 'run.sh'),
      ['-m', 'quotagent.bridge', '--serve', '--realm', this.realm, '--ledger', this.ledger,
       '--profile', this.profile, '--fact-surface', this.factSurface],
      { cwd: this.repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this._decode(this.child.stdout, (frame) => { this.frames.push(frame) })
    this._decode(this.child.stderr, (frame) => { this.stderr.push(frame) }, true)
    this.child.on('exit', (code) => { this.exitCode = code })
    return this
  }

  _decode(stream, onFrame, isLog = false) {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        if (isLog) { onFrame({ log: line }); continue }
        try { onFrame(JSON.parse(line)) } catch { onFrame({ parse_error: line.slice(0, 120) }) }
      }
    })
  }

  send(frame) { this.child.stdin.write(JSON.stringify(frame) + '\n') }
  sendRaw(text) { this.child.stdin.write(text.endsWith('\n') ? text : text + '\n') }

  /** 等一帧：name 为期望的帧名（或 predicate）。 */
  async waitFor(name, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    const match = typeof name === 'function' ? name : (frame) => frame.n === name
    for (;;) {
      const found = this.frames.find(match)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`等待帧 ${String(name)} 超时（已收 ${this.frames.length} 帧）`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** 标准握手：读 hello → 回 init → 收 ready（或版本不兼容时收 error 并等退出码）。 */
  async handshake({ acceptBridge = [BRIDGE_VERSION], wantEvents = [], profile = this.profile } = {}) {
    this.hello = (await this.waitFor('kernel/hello')).p
    if (!acceptBridge.some((v) => v === this.hello.bridge.version)) {
      this.send({ v: 1, n: 'bridge.init', p: { accept_bridge: acceptBridge, profile, want_events: wantEvents } })
      const error = await this.waitFor('error')
      return { ok: false, code: error.p.code, error, exitCode: await this.waitForExit() }
    }
    this.send({ v: 1, n: 'bridge.init', p: { accept_bridge: acceptBridge, profile, want_events: wantEvents } })
    this.ready = (await this.waitFor('bridge.ready')).p
    return { ok: true, hello: this.hello, ready: this.ready }
  }

  async call(method, params = {}, { id = 1, timeoutMs = 15000 } = {}) {
    this.send({ v: 1, n: 'method', p: { id, m: method, params } })
    return this.waitFor((frame) => frame.n === 'result' || frame.n === 'error', timeoutMs)
  }

  async callRaw(frame) { this.send(frame); return this.waitFor((f) => f.n === 'result' || f.n === 'error') }

  async waitForExit(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (this.exitCode === null) {
      if (Date.now() > deadline) throw new Error('等待内核退出超时')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return this.exitCode
  }

  shutdown() { this.send({ v: 1, n: 'bridge.shutdown', p: {} }) }

  async stop() {
    if (this.child && this.exitCode === null) { try { this.child.stdin.end() } catch { /* 已关 */ } }
    return this.waitForExit().catch(() => this.exitCode)
  }
}

export const ledgerExists = (path) => existsSync(path)
