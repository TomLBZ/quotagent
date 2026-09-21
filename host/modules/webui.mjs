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

export const inject = ['ledgerView']        // 账本只读视图（生产由 host/lib/ledger-view.mjs 提供）

export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const usedServices = ['ledgerView']

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

/**
 * 视角投影白名单（**私域边界的机检形态**）：不在白名单里的键一律不出现。
 * `privateKeys` 是要**显式拒收**的承包商私域键（供应商视角连出现都不许）。
 */
export const VIEW_RULES = {
  contractor: {
    title: '承包商视角',
    types: ['rfq/', 'quote/', 'compare/', 'award/', 'po/', 'change/', 'approval/', 'capacity/', 'terms/'],
    privateKeys: [],
    fields: ['seq', 'type', 'correlation_id', 'actor', 'ts', 'summary'],
  },
  supplier: {
    title: '供应商视角',
    types: ['rfq/', 'quote/', 'award/', 'po/', 'change/', 'clarification/'],
    privateKeys: ['calendar:private', 'cost_floor', 'markup_pct', 'profiles', 'bidders_private',
      'authorized_band', 'internal_notes'],
    fields: ['seq', 'type', 'correlation_id', 'ts', 'summary'],
  },
}

const PRIVATE_MARK = 'private'

/** 逐条投影：先按事件类型过滤，再按字段白名单裁剪，最后**显式拒收私域键**。 */
export function project(view, rows) {
  return projectWithAudit(view, rows).publicRows
}

/**
 * 投影 + **服务端审计**。
 *
 * 关键纪律：抑制原因**对外必须是通用的**（`private-field-suppressed`）——把私域键名写进
 * 对方视角的响应里，本身就是一次泄漏（本仓实测：`reason: private:cost_floor` 会把键名送到供应商页面）。
 * 具体键名只出现在 `audit[]` 里，调用方只能写日志/上报，不得放进响应体。
 */
export function projectWithAudit(view, rows) {
  const rule = VIEW_RULES[view]
  if (!rule) throw new Error(`[unknown-view] ${view}`)
  const audit = []
  const publicRows = rows
    .filter((row) => rule.types.some((prefix) => String(row.type).startsWith(prefix)))
    .map((row) => {
      const out = {}
      for (const field of rule.fields) {
        if (row[field] !== undefined) out[field] = row[field]
      }
      out.summary = summarize(row.body)
      const serialized = JSON.stringify(out).toLowerCase()
      for (const secret of rule.privateKeys) {
        if (serialized.includes(secret.toLowerCase())) {
          audit.push({ seq: row.seq, type: row.type, suppressed_key: secret, view })
          return { seq: row.seq, type: row.type, suppressed: true, reason: 'private-field-suppressed' }
        }
      }
      return out
    })
  return { publicRows, audit }
}

function summarize(body) {
  if (!body || typeof body !== 'object') return ''
  const keys = Object.keys(body).filter((key) => !key.toLowerCase().includes(PRIVATE_MARK))
  return keys.slice(0, 6).map((key) => {
    const value = body[key]
    // `typeof null === 'object'`：必须判空，否则 Object.keys(null) 抛错（实测过一次：单个 null 字段
    // 就让整个 UI 进程退出）——这类崩溃必须由下方请求级兜底 + 断言双重防住
    const text = (value !== null && typeof value === 'object')
      ? `{${Object.keys(value).slice(0, 3).join(',')}}` : String(value)
    return `${key}=${text.slice(0, 40)}`
  }).join(' ')
}

const html = (title, body, prefix) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}
code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}
nav a{margin-right:1rem}</style></head><body><nav>
<a href="${prefix}/">总览</a><a href="${prefix}/contractor/">承包商视角</a><a href="${prefix}/supplier/">供应商视角</a>
<a href="${prefix}/api/status">/api/status</a><a href="${prefix}/api/health">/api/health</a>
</nav><h1>${title}</h1>${body}</body></html>`

export function apply(ctx, config) {
  const prefix = config.route_prefix.replace(/\/$/, '')
  // 视角 → 账本：配了自有账本就用它（结构性隔离），否则退回注入的只读视图（fixture/单账本模式）
  const ledgerOf = (view) => {
    const own = view === 'contractor' ? config.ledger_contractor : config.ledger_supplier
    return own ? openLedger(own) : ctx.ledgerView
  }

  const rowsFor = (view) => {
    const { publicRows, audit } = projectWithAudit(view, ledgerOf(view).rows())
    if (audit.length) {
      // 审计只走 stderr（宿主日志）；响应体里不得出现私域键名
      console.error(`[webui] ${view} 视角抑制 ${audit.length} 行：${audit.map((item) => item.suppressed_key).join(',')}`)
    }
    return publicRows
  }

  const server = createServer((req, res) => {
    try {
      return handle(req, res)
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
    if (viewMatch && VIEW_RULES[viewMatch[1]]) {
      const view = viewMatch[1]
      const rows = rowsFor(view)
      const table = `<table><tr><th>seq</th><th>type</th><th>摘要</th><th>ts</th></tr>${
        rows.slice(-40).reverse().map((row) => row.suppressed
          ? `<tr><td>${row.seq}</td><td>${row.type}</td><td>（已抑制：${row.reason}）</td><td></td></tr>`
          : `<tr><td>${row.seq}</td><td>${row.type}</td><td>${row.summary || ''}</td><td>${row.ts || ''}</td></tr>`).join('')}</table>`
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · ${VIEW_RULES[view].title}`,
          `<p>本视角只显示 <code>${VIEW_RULES[view].types.join(' ')}</code> 的事件；`
          + `供应商视角显式拒收私域键 <code>${VIEW_RULES.supplier.privateKeys.join(' ')}</code>。</p>`
          + `<p>JSON：<code>${prefix}/${view}/api/events</code></p>${table}`, prefix))
    }
    const viewApi = path.match(/^\/([a-z]+)\/api\/events\/?$/)
    if (viewApi && VIEW_RULES[viewApi[1]]) {
      return json(200, { view: viewApi[1], count: rowsFor(viewApi[1]).length, events: rowsFor(viewApi[1]) })
    }
    if (path === '/' || path === '') {
      const rows = config.views.filter((view) => VIEW_RULES[view]).map((view) => {
        const ledger = ledgerOf(view)
        let report = { count: 0, ok: false }
        try { report = ledger.verify() } catch (err) { report = { count: 0, ok: false, reason: String(err).slice(0, 60) } }
        return `<li><a href="${prefix}/${view}/">${VIEW_RULES[view].title}</a>（${report.count} 条，链自洽=${report.ok}）</li>`
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
        rules: VIEW_RULES,
      })
      resolve()
    })
  })
}
