/**
 * 进树模块：`webui`（WebUI 插件，每方视角一个路由）。
 *
 * 用户要求（2026-09-21）：
 *   · 项目的每个功能都应由**插件**提供 → 本文件是 cordis 插件（manifest 同其它进树模块）；
 *   · WebUI 要能**从现有 dashboard 访问** → 由工作区 `ws-gateway` 以路由前缀转发（见 `docs/work/deployment-manual.md`）；
 *   · **不同 routes 提供双方视角可见的不同 UI** → `/quotagent/contractor/*` 与 `/quotagent/supplier/*`；
 *   · 私域不出 realm → 每个视角只在**自己的白名单**里投影（供应商视角永远拿不到承包商私域键）。
 *
 * 零残留（A2）：HTTP server 由 `ctx.effect()` 注册，dispose 即 `server.close()`（端口释放）。
 */
import { createServer } from 'node:http'
import { array, number, object, string } from '../lib/std-schema.mjs'
import { openLedger } from '../lib/ledger-view.mjs'

export const name = 'webui'

export const inject = ['ledgerView', 'projection', 'governor']   // + 运行期准入（governor 是独立插件）

export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const usedServices = ['ledgerView', 'projection', 'governor']

export const provides = ['webui']

export const Config = object({
  route_prefix: string().default('/quotagent'),
  listen_host: string().default('127.0.0.1'),
  port: number().default(8093),
  views: array(string()).default(['contractor', 'supplier']),
  page_title: string().default('quotagent 控制台'),
  // 每个视角**读自己的账本**（结构性隔离：对方的账本根本不在本视角的读取路径上）
  ledger_contractor: string().default(''),
  ledger_supplier: string().default(''),
})

const html = (title, body, prefix) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}
code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}
nav a{margin-right:1rem}</style></head><body><nav>
<a href="${prefix}/">总览</a><a href="${prefix}/contractor/">承包商视角</a><a href="${prefix}/supplier/">供应商视角</a>
<a href="${prefix}/api/status">/api/status</a><a href="${prefix}/api/health">/api/health</a>
</nav><h1>${title}</h1>${body}</body></html>`

export function apply(ctx, config) {
  const projection = ctx.projection            // 投影服务（真源在 host/modules/projection.mjs）
  const rules = projection.rules
  const prefix = config.route_prefix.replace(/\/$/, '')
  // 视角 → 账本：配了自有账本就用它（结构性隔离），否则退回注入的只读视图（fixture/单账本模式）
  const ledgerOf = (view) => {
    const own = view === 'contractor' ? config.ledger_contractor : config.ledger_supplier
    return own ? openLedger(own) : ctx.ledgerView
  }

  const rowsFor = (view) => {
    const { publicRows, audit } = projection.projectWithAudit(view, ledgerOf(view).rows())
    if (audit.length) {
      // 审计只走 stderr（宿主日志）；响应体里不得出现私域键名
      console.error(`[webui] ${view} 视角抑制 ${audit.length} 行：${audit.map((item) => item.suppressed_key).join(',')}`)
    }
    return publicRows
  }

  const governor = ctx.governor
  const server = createServer(async (req, res) => {
    try {
      // 运行期准入（独立插件 governor）：背压 → 429 + Retry-After（**可解释**）；超时 → 504；其它 → 500。
      // 默认配置（capacity 64 / timeout 5s）等价于直通，升级路径零影响。
      const key = `webui:${String(req.url ?? '/').split('?')[0]}`
      const routed = await governor.run({ key, fn: async () => handle(req, res) }).catch((err) => sendGovernorError(res, err))
      return routed === null ? undefined : routed?.result
    } catch (err) {
      // 服务不得被单个请求杀死（实测教训）：先尽量回 500，再自报日志
      console.error(`[webui] 请求处理失败 ${req.url}：${String(err).slice(0, 160)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal-error', detail: String(err).slice(0, 120) }) + '\n')
      } else {
        res.end()
      }
      return undefined
    }
  })

  const handle = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname
    const send = (code, type, payload) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(payload)
    }
    const json = (code, payload) => send(code, 'application/json; charset=utf-8',
      JSON.stringify(payload, null, 2) + '\n')

    if (path === '/api/health') return json(200, { status: 'ok', service: 'quotagent-webui' })
    if (path === '/api/status') {
      const ledgers = {}
      for (const view of config.views) {
        const ledger = ledgerOf(view)
        try {
          const report = ledger.verify()
          ledgers[view] = { path: ledger.path, count: report.count, healthy: report.ok, head: report.head }
        } catch (err) {
          ledgers[view] = { path: ledger.path, healthy: false, reason: String(err).slice(0, 80) }
        }
      }
      return json(200, { service: 'quotagent-webui', route_prefix: prefix, views: config.views,
        ledgers, routes: config.views.map((view) => `${prefix}/${view}/`) })
    }
    const viewMatch = path.match(/^\/([a-z]+)\/?$/)
    if (viewMatch && rules[viewMatch[1]]) {
      const view = viewMatch[1]
      const rows = rowsFor(view)
      const table = `<table><tr><th>seq</th><th>type</th><th>摘要</th><th>ts</th></tr>${
        rows.slice(-40).reverse().map((row) => row.suppressed
          ? `<tr><td>${row.seq}</td><td>${row.type}</td><td>（已抑制：${row.reason}）</td><td></td></tr>`
          : `<tr><td>${row.seq}</td><td>${row.type}</td><td>${row.summary || ''}</td><td>${row.ts || ''}</td></tr>`).join('')}</table>`
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · ${rules[view].title}`,
          `<p>本视角只显示 <code>${rules[view].types.join(' ')}</code> 的事件；`
          + `供应商视角显式拒收私域键 <code>${rules.supplier.privateKeys.join(' ')}</code>。</p>`
          + `<p>JSON：<code>${prefix}/${view}/api/events</code></p>${table}`, prefix))
    }
    const viewApi = path.match(/^\/([a-z]+)\/api\/events\/?$/)
    if (viewApi && rules[viewApi[1]]) {
      const rows = rowsFor(viewApi[1])   // 一次请求只投影一次（原先算两遍：canary 采样会翻倍，实测发现）
      return json(200, { view: viewApi[1], count: rows.length, events: rows })
    }
    if (path === '/' || path === '') {
      const rows = config.views.filter((view) => rules[view]).map((view) => {
        const ledger = ledgerOf(view)
        let report = { count: 0, ok: false }
        try { report = ledger.verify() } catch (err) { report = { count: 0, ok: false, reason: String(err).slice(0, 60) } }
        return `<li><a href="${prefix}/${view}/">${rules[view].title}</a>（${report.count} 条，链自洽=${report.ok}）</li>`
      }).join('')
      return send(200, 'text/html; charset=utf-8', html(config.page_title,
        `<ul>${rows}</ul>`
        + '<p>本 UI 由 cordis 插件 <code>webui</code> 提供；每个视角读**自己的**账本，宿主不写账本。</p>', prefix))
    }
    return json(404, { error: 'not-found', path, hint: `可用：${prefix}/ / ${prefix}/contractor/ / ${prefix}/supplier/ / ${prefix}/api/status` })
  }

  // 零残留：server 是 fiber 的 effect，dispose 即关闭（端口释放）
  ctx.effect(() => () => new Promise((resolve) => server.close(resolve)))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.listen_host, () => {
      // port=0 → 由内核分配临时端口；实际端口**必须**从 server.address() 读（fixture 靠它做 HTTP 检查）
      const port = server.address().port
      ctx.provide('webui', {
        url: `http://${config.listen_host}:${port}${prefix}/`,
        port,
        prefix,
        viewUrl: (view) => `http://${config.listen_host}:${port}${prefix}/${view}/`,
        rules,                       // 真源：projection 插件
      })
      resolve()
    })
  })
}

/**
 * 运行期错误的 HTTP 映射（**纯函数**，便于单测）：背压 → 429 + `Retry-After`；超时 → 504；其它 → 500。
 * 返回 `null` 表示"已在此处结束响应"，调用方据此短路。抽出来是为了让映射本身可被断言（不依赖慢请求）。
 */
export function sendGovernorError(res, err) {
  const code = err?.code
  const write = (status, payload, headers = {}) => {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      res.end(JSON.stringify(payload) + '\n')
    } else { res.end() }
  }
  if (code === 'backpressure') {
    const detail = err.detail ?? {}
    return write(429, { error: 'backpressure', reason: detail.reason, retry_after_ms: detail.retry_after_ms,
      next_action: detail.next_action },
    { 'retry-after': String(Math.ceil((detail.retry_after_ms ?? 0) / 1000)) }), null
  }
  if (code === 'timeout') return write(504, { error: 'timeout', detail: String(err.message).slice(0, 120) }), null
  return write(500, { error: 'internal-error', detail: String(err?.message).slice(0, 120) }), null
}
