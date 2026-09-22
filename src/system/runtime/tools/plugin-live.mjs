#!/usr/bin/env node
/**
 * tools/plugin-live.mjs —— 运行期装卸的**客户端**（`tools/plugin.sh <动词> <插件> --live` 的实现）。
 *
 *   status|load|reload|unload|list|deps  <插件> [--port N] [--prefix P] [--json] [--pretty]
 *
 * 它做的事只有三件（薄入口纪律）：
 *   ① 解析目标：运行中服务的控制通道 `POST http://127.0.0.1:<port><prefix>/api/plugins/control`；
 *   ② 取控制令牌（**只报来源、永不回显**）：`$QUOTAGENT_PLUGIN_CONTROL_TOKEN` → 0600 文件；没有就地拒绝
 *      （`plugin-control-disabled` + next_action —— 不假装成功，也不去猜一个默认值）；
 *   ③ 把服务端的回执原样打出来（帧纪律：stdout 只放机器可读结果，日志走 stderr）。
 *
 * 为什么客户端与服务端共用一份 `resolveToken`：令牌来源只允许有一处定义（`live-control.mjs`）。
 * 退出码：0 = 服务端 ok / 1 = 有名失败（含服务没起）/ 2 = 用法或环境错误。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VERBS, MUTATING, resolveToken } from '../code/live-control.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const USAGE = `用法: tools/plugin.sh <动词> <插件> --live [--port N] [--prefix P] [--json] [--pretty]
  动词: ${VERBS.join(' | ')}（与常驻运行时进程那条路径同一套动词）
  · <插件> 写 \`层次/插件\`（userspace 写 \`userspace/<ns>/<plugin>\`）
  · 控制令牌来源（只报来源、不回显）：$QUOTAGENT_PLUGIN_CONTROL_TOKEN → 0600 文件
    $QUOTAGENT_PLUGIN_CONTROL_TOKEN_FILE（缺省 <root>/../config/quotagent-plugin-control-token）
  · 服务地址：$QUOTAGENT_WEBUI_PORT / $QUOTAGENT_WEBUI_PREFIX（缺省 8093 / /quotagent）
`

function parseArgs(argv) {
  const args = { verb: null, id: null, root: null, port: null, prefix: null, pretty: false, help: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--pretty') args.pretty = true
    else if (token === '--root') args.root = argv[++index] ?? null
    else if (token === '--port') args.port = argv[++index] ?? null
    else if (token === '--prefix') args.prefix = argv[++index] ?? null
    else if (token === '--json') continue
    else if (token === '--help' || token === '-h') args.help = true
    else if (token.startsWith('-')) return { error: `未知旗标：${token}` }
    else rest.push(token)
  }
  if (args.help) return args
  args.verb = rest[0] ?? null
  args.id = rest[1] ?? null
  if (args.verb === null) return { error: '缺少动词' }
  if (!VERBS.includes(args.verb)) return { error: `未知动词：${args.verb}` }
  if (args.verb !== 'list' && (args.id === null || args.id === '')) return { error: `${args.verb} 需要 <插件>` }
  return args
}

const out = (payload, pretty) => process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`)

async function main(argv) {
  const args = parseArgs(argv)
  if (args.error) {
    out({ ok: false, verb: null, code: 'usage', reason: args.error,
      next_action: 'tools/plugin.sh --help 或 tools/plugin.sh <动词> <插件> --live --help' })
    return 2
  }
  if (args.help) { process.stdout.write(USAGE); return 0 }
  const root = resolve(args.root ?? resolve(HERE, '..', '..', '..', '..'))
  const port = String(args.port ?? process.env.QUOTAGENT_WEBUI_PORT ?? '8093')
  const prefix = String(args.prefix ?? process.env.QUOTAGENT_WEBUI_PREFIX ?? '/quotagent').replace(/\/$/, '')
  const expected = resolveToken({ root })
  if (expected.token === '') {
    out({ ok: false, verb: args.verb, id: args.id, code: 'plugin-control-disabled',
      reason: `运行期装卸通道关闭（令牌来源：${expected.source}）`,
      token_source: expected.source,
      next_action: '在这台机器上配控制令牌后重启服务：0600 文件 '
        + `${expected.path}（或 env QUOTAGENT_PLUGIN_CONTROL_TOKEN）；不配则这条通道整体不存在` })
    return 1
  }
  const url = `http://127.0.0.1:${port}${prefix}/api/plugins/control`
  let response = null
  try {
    response = await fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-control-token': expected.token },
      body: JSON.stringify({ verb: args.verb, id: args.id, confirm: true }) })
  } catch (err) {
    out({ ok: false, verb: args.verb, id: args.id, code: 'service-not-running',
      reason: `连不上运行中的服务（${url}）：${String(err && err.message ? err.message : err).slice(0, 120)}`,
      token_source: expected.source,
      next_action: './run up 起服务后重试（或核对 --port/--prefix 与 $QUOTAGENT_WEBUI_PORT）' })
    return 1
  }
  let payload = null
  const text = await response.text()
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { ok: false, code: 'usage', reason: '服务端回执不是 JSON',
      next_action: `看 tmp/run/webui-${port}.log 的尾部（原始回执前 120 字：${String(text).slice(0, 120)}）` }
  }
  const merged = { ...payload, http_status: response.status, url, verb: args.verb, id: args.id,
    confirm: MUTATING.includes(args.verb) ? true : null }
  out(merged, args.pretty)
  return payload.ok === true ? 0 : 1
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`[plugin-live] ${String(err && err.stack ? err.stack : err)}\n`)
  process.exit(2)
})
