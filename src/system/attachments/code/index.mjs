/**
 * `system/attachments` 的**装载面**（cordis 插件入口）：把对象级附件的 HTTP 路由**注册进路由注册面**
 * （`uiRoutes`，见 `src/system/webui/code/ui-route.mjs`）—— 不改 `webui.mjs` 的静态路由表。
 *
 * 为什么走注册面（`docs/design/27-plugin-architecture.md` §6.1 + `docs/design/29-webui-gui-app.md` §3）：
 * 插件要加 HTTP 路由就该往注册面注册；注册面只认"谁在哪条路径上注册了什么"，不懂业务。
 * 本插件注册十条（前六条是真入口，后四条是**同路径的方法围栏**，与 webui 的"只读路由不接受写"同口径）：
 *
 *   POST /api/attachments/upload    上传（原始字节；或 JSON + base64）—— 会话身份 + 侧校验 + 上限/类型/名字
 *   GET  /api/attachments/list      某个对象上**本侧能看到的**附件（元数据：名字/大小/sha256/上传人/时间/版本）
 *   POST /api/attachments/list      ⇒ 405 + `Allow: GET`（只读路径不接受写：免得"POST 了却像成功"）
 *   GET  /api/attachments/file      取件（**下载的唯一入口**；Content-Disposition + X-Attachment-Sha256）
 *   POST /api/attachments/file      ⇒ 405 + `Allow: GET`
 *   GET  /api/attachments/versions  同名附件的**版本链**（谁在何时换了哪一版；旧版仍可下载）
 *   POST /api/attachments/versions  ⇒ 405 + `Allow: GET`
 *   GET  /api/attachments/preview   **界内预览**（图片 / PDF / 文本；inline + nosniff；其余类型 415 如实说）
 *   POST /api/attachments/preview   ⇒ 405 + `Allow: GET`
 *   POST /api/attachments/delete    删除（**留痕**：墓碑 + trash/ + journal.jsonl）
 *   GET|POST /api/attachments/store 自述读数（落点/权限/上限/版本与预览口径/为什么不是账本）
 *
 * **身份由会话给**（`identity.mjs` 的 `whoOf` 是"这次请求是谁"的唯一判据，本文件不重抄一遍 cookie/会话解析）：
 * 侧**不由**查询串决定 ⇒ 一侧的身份读不到/下不了另一侧的件（结构性隔离，不是过滤）。
 *
 * 写面纪律：本文件只写自己的附件目录（`attachments.mjs` 里 0600/0700 + 原子写），**账本零新增**；
 * 只 spawn 无、只读自己的索引。请求体由本文件**自己**有界读取（不经过 webui 的 16 KiB 读体夹取——
 * 那里会**静默截断**，而截断等于把一份被切掉的文件当完整件存下来）。
 */
import { attachmentStore, REFUSAL_CODES, STATUS_FOR, LIMITS, VISIBILITIES, OBJECT_POLICY,
  PREVIEW_KINDS } from './attachments.mjs'
// **身份的唯一判据来自身份面自己**（读 `code/identity.mjs` 的 `whoOf`；只读，不重抄一遍 cookie/会话解析）：
// 重抄一份解析会在"会话格式/过期语义"上漂移，而"这次请求是谁"必须是同一处判据。
// 这是**只读依赖**：本插件不登录、不写会话、不改它的任何语义（`createIdentity` 的构造过程零写面）。
import { createIdentity } from '../../webui/code/identity.mjs'

export const name = 'attachments'
export const inject = []
export const builtin = []
/** 本插件提供的服务键（`attachments` = 上面那个存储/权限面）。 */
export const provides = ['attachments']
/** 它用到的注册面（宿主据此断言装配；`uiRoutes` 由 `webui` 提供）。 */
export const usedServices = ['uiRoutes']

/** 本插件自己的配置（**不 import 别的插件的实现文件**：只做字符串归一 + 缺省值）。 */
export const DEFAULT_CONFIG = {
  root: '', prefix: '/quotagent', ui_shared: 'tmp/ui-shared', ledger_contractor: '', ledger_supplier: '',
  rfq_delivery: '',
}
export const Config = {
  defaults: DEFAULT_CONFIG,
  parse(input = {}) {
    const out = { ...DEFAULT_CONFIG }
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (input !== null && typeof input === 'object' && input[key] !== undefined && input[key] !== null) {
        out[key] = String(input[key])
      }
    }
    return out
  },
}

/** 路由表（**在本文件里就是一张表**：路径/方法/说明/判据，逐条给 `auth` 供 `/api/routes` 台账用）。 */
export const ROUTES = [
  { method: 'POST', path: '/api/attachments/upload', auth: 'identity-session',
    what: '上传对象级附件（RFQ 包/报价/变更/PO）：会话身份 + 侧 + 对象可见性 + 上限/类型/文件名判据；'
      + '正文落 0600 内容寻址存储，索引只记元数据，**账本零新增**' },
  { method: 'GET', path: '/api/attachments/list', auth: 'identity-session',
    what: '某个对象上本侧可见的附件（名字/大小/sha256/上传人/时间/可见性；含已删除的墓碑）' },
  { method: 'POST', path: '/api/attachments/list', auth: 'none',
    what: '方法围栏：只读路径（GET）收到 POST ⇒ 405 + Allow: GET' },
  { method: 'GET', path: '/api/attachments/file', auth: 'identity-session',
    what: '取件（下载的唯一入口）：交付件要对侧是该对象当事方；本侧内部件永不出本侧；正文 sha256 自校验' },
  { method: 'POST', path: '/api/attachments/file', auth: 'none',
    what: '方法围栏：只读路径（GET）收到 POST ⇒ 405 + Allow: GET（不把写当读处理）' },
  { method: 'GET', path: '/api/attachments/versions', auth: 'identity-session',
    what: '同一对象上**同名附件的版本链**（谁在何时换了哪一版；每条版本都有 id/sha256/上传人/时刻，'
      + '旧版仍可下载；只回本侧可见的条目）' },
  { method: 'POST', path: '/api/attachments/versions', auth: 'none',
    what: '方法围栏：只读路径（GET）收到 POST ⇒ 405 + Allow: GET' },
  { method: 'GET', path: '/api/attachments/preview', auth: 'identity-session',
    what: '**界内预览**（不下载也能看）：只做图片 / PDF / 文本（浏览器自带渲染器，同源、不引外网依赖）；'
      + '身份与侧判据与下载**同一套**；其余类型 ⇒ 415 preview-type-not-allowed + 下载入口；不写账本' },
  { method: 'POST', path: '/api/attachments/preview', auth: 'none',
    what: '方法围栏：只读路径（GET）收到 POST ⇒ 405 + Allow: GET' },
  { method: 'POST', path: '/api/attachments/delete', auth: 'identity-session',
    what: '删除附件（**留痕**：索引墓碑 + trash/ 原件 + journal.jsonl 一行；只能删自己上传的）' },
  { method: 'GET', path: '/api/attachments/store', auth: 'none',
    what: '附件存储自述（落点/权限/上限/对象类策略/为什么不是账本；只有聚合读数，没有文件名）' },
  { method: 'POST', path: '/api/attachments/store', auth: 'none',
    what: '方法围栏：只读路径（GET）收到 POST ⇒ 405 + Allow: GET' },
]

/** 上传体的兜底上限（读取时用；比存储上限留一点 base64/表单开销的余量）。 */
export const BODY_SLACK = 512 * 1024

const jsonType = 'application/json; charset=utf-8'
const flat = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)

/**
 * 有界读体（**本插件自己读**）：超上限 ⇒ 拒（413 + 有名 code），并**销毁连接**；
 * 绝不截断成"半份正文"当完整件存下来（与 `app-shell.mjs` 的 `readBody` 同一纪律）。
 */
function readBounded(req, limit, done) {
  const chunks = []
  let size = 0
  let over = false
  req.on('data', (chunk) => {
    if (over) return
    size += chunk.length
    if (size > limit) {
      over = true
      chunks.length = 0
      try { req.destroy() } catch (err) { /* 连接已断：下面的 done 仍会给出指名回执 */ }
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => done(over ? null : Buffer.concat(chunks), over))
  req.on('error', () => done(null, over))
  req.on('aborted', () => done(null, over))
}

export function apply(ctx, config = {}) {
  const root = String(config.root ?? '') || process.cwd()
  const prefix = String(config.prefix ?? '/quotagent').replace(/\/$/, '')
  const store = attachmentStore({ root, sharedDir: String(config.ui_shared ?? 'tmp/ui-shared'),
    ledgerContractor: String(config.ledger_contractor ?? ''), ledgerSupplier: String(config.ledger_supplier ?? ''),
    delivery: String(config.rfq_delivery ?? ''), log: (msg) => console.error(msg) })
  // 身份面只用来解析"这次请求是谁"（只读 `whoOf`；本插件不登录、不写会话）
  const identity = createIdentity({ root, prefix, config: { ui_shared: String(config.ui_shared ?? 'tmp/ui-shared'),
    ledger_contractor: String(config.ledger_contractor ?? ''),
    ledger_supplier: String(config.ledger_supplier ?? '') }, shell: null })
  ctx.provide('attachments', store)

  /** 取会话身份 ⇒ `{ok, human, side}` 或 401 回执（**侧只认会话**，不认查询串/请求体）。 */
  const whoOf = (request) => {
    const who = identity.whoOf(request.req)
    if (!who.ok) {
      return { ok: false, payload: { ok: false, code: who.code ?? 'identity-required', reason: who.reason,
        next_action: who.next_action, attachment_rule: '附件按**会话所属侧**隔离：未登录时读不到、传不了、删不了' },
        status: STATUS_FOR['identity-required'] }
    }
    return { ok: true, human: who.human, side: who.side, name: who.name }
  }

  const refuse = (request, out, extra = {}) => request.json(STATUS_FOR[out.code] ?? 400,
    { ok: false, code: out.code, reason: out.reason, next_action: out.next_action, ...extra })

  const methodsNotAllowed = (request, allow) => {
    const payload = { ok: false, service: 'quotagent-attachments', code: 'method-not-allowed',
      method: String(request.req?.method ?? ''), path: request.path, allow,
      next_action: `这条路径是**只读**的（${allow}）：${allow === 'GET' ? '取件/列表用 GET' : '用 POST'}` }
    return request.send(405, jsonType, JSON.stringify(payload, null, 2) + '\n', { allow })
  }

  ctx.inject(['uiRoutes'], (scope) => {
    const registered = []
    for (const route of ROUTES) {
      scope.effect(() => {
        const verdict = scope.uiRoutes.register({ ...route, handler: HANDLERS[route.path][route.method]({
          store, whoOf, refuse, methodsNotAllowed, prefix,
        }) })
        registered.push({ ...route, ok: verdict.ok === true, code: verdict.code })
        if (verdict.ok !== true) {
          console.error(`[attachments] 路由注册被拒：${route.method} ${route.path} → ${verdict.code}`
            + `（${flat(verdict.reason)}）`)
        }
        return verdict.ok === true ? verdict.dispose : () => {}
      })
    }
    console.error(`[attachments] 附件路由 ${registered.filter((item) => item.ok).length}/${ROUTES.length} 条已注册`
      + `（存储 ${store.dir}，0600/0700，账本零新增）`)
  })
  // 纪律：**不返回任何值**（cordis 把 apply 的返回值当 effect；返回普通对象 = TypeError: Invalid effect）
  return undefined
}

/** 逐条路由的处理器（构造式：把机制句柄给进去，返回 `handler(request)`）。 */
/** 异步回调里的兜底：机制层不替插件编响应，但**绝不让插件把整个服务进程带崩**（如实报 500 + reason）。 */
const crash = (request, err) => request.json(500, { ok: false, service: 'quotagent-attachments',
  code: 'attachment-handler-failed', reason: flat(err, 200),
  next_action: '这是附件插件自己的处理器抛错（如实报、不编替代内容）：看宿主日志定位' })

export const HANDLERS = {
  '/api/attachments/upload': {
    POST: ({ store, whoOf, refuse, prefix }) => (request) => {
      const who = whoOf(request)
      if (!who.ok) return request.json(who.status, who.payload)
      const query = request.url.searchParams
      const limit = Math.floor(store.currentLimits().max_bytes) + BODY_SLACK
      const isJson = String(request.req.headers['content-type'] ?? '').includes('json')
      return new Promise((resolve) => {
        readBounded(request.req, limit, (buffer, over) => {
          try {
            if (over) {
              return resolve(refuse(request, { code: 'attachment-too-large',
                reason: `请求体超过读取上限（${limit} 字节）：**不截断**——截断会把半份文件当完整件存下来`,
                next_action: `上传单文件上限 ${Math.round(store.currentLimits().max_bytes / 1024)} KiB`
                  + '（见 /api/attachments/store 的 limits）' }, { limit_bytes: limit }))
            }
            if (buffer === null) {
              return resolve(request.json(400, { ok: false, code: 'attachment-empty',
                reason: '请求体没有读到任何内容（连接中断或被销毁）',
                next_action: '重发一次；大文件请分片或压缩后再传' }))
            }
            let payload = null
            let body = buffer
            if (isJson) {
              try { payload = JSON.parse(buffer.toString('utf8')) } catch (err) {
                return resolve(request.json(400, { ok: false, code: 'invalid-json',
                  reason: `JSON 解析失败：${flat(err, 120)}`,
                  next_action: 'POST JSON：{"kind":"po","id":"PO-1","name":"spec.pdf","content_base64":"…"}'
                    + '（或直接 POST 原始字节 + 查询串 kind/id/name）' }))
              }
              if (payload && typeof payload.content_base64 === 'string') {
                body = Buffer.from(payload.content_base64, 'base64')
                if (body.length > store.currentLimits().max_bytes) {
                  return resolve(refuse(request, { code: 'attachment-too-large',
                    reason: `文件 ${body.length} 字节超过上限 ${store.currentLimits().max_bytes} 字节`,
                    next_action: '拆小或压缩后再传' }, { limit_bytes: store.currentLimits().max_bytes }))
                }
              } else if (payload && typeof payload.content === 'string') {
                body = Buffer.from(payload.content, 'utf8')
              }
            }
            const pick = (key) => {
              const fromQuery = query.get(key)
              if (fromQuery !== null && fromQuery !== '') return fromQuery
              const fromBody = payload && typeof payload[key] === 'string' ? payload[key] : ''
              return fromBody
            }
            const out = store.put({ side: who.side, actor: who.human, kind: pick('kind'), id: pick('id'),
              name: pick('name'), visibility: pick('visibility'), body })
            if (!out.ok) return resolve(refuse(request, out, { side: who.side }))
            const entry = out.entry
            const downloadUrl = `${prefix}/api/attachments/file?id=${encodeURIComponent(entry.id)}`
            // **多版本**的读数原样回执（`version` = 这一份是第几版、`supersedes` = 取代了谁、
            // `unchanged` = 同一份字节再传 ⇒ 就是同一条、`attachment-unchanged`）；界面/脚本都不必自己推。
            return resolve(request.json(201, { ok: true, service: 'quotagent-attachments', action: 'upload',
              code: out.code ?? 'uploaded', attachment: entry,
              version: out.version ?? (Number(entry.version) || 1),
              supersedes: out.supersedes ?? '', superseded_by: entry.superseded_by ?? '',
              unchanged: out.unchanged === true, preview_kind: out.preview_kind ?? entry.preview_kind ?? null,
              previewable: entry.previewable === true, sha256_verified: entry.sha256, ledger_added: 0,
              download_url: downloadUrl, preview_url: entry.previewable
                ? `${prefix}/api/attachments/preview?id=${encodeURIComponent(entry.id)}` : '',
              versions_url: `${prefix}/api/attachments/versions?kind=${encodeURIComponent(entry.object?.kind ?? '')}`
                + `&id=${encodeURIComponent(entry.object?.id ?? '')}`,
              delete_url: `${prefix}/api/attachments/delete`,
              next_action: out.next_action
                ?? `对方（若是交付件）在该对象的附件面板里就能看到并下载：${downloadUrl}`,
              note: out.note ?? '正文不进账本：只落 0600 存储'
                + '（index.json 记 sha256/大小/文件名/上传人/对象关联/版本）' }))
          } catch (err) {
            return resolve(crash(request, err))
          }
        })
      })
    },
  },
  '/api/attachments/list': {
    GET: ({ store, whoOf, refuse }) => (request) => {
      const who = whoOf(request)
      if (!who.ok) return request.json(who.status, who.payload)
      const query = request.url.searchParams
      const out = store.list({ side: who.side, kind: String(query.get('kind') ?? ''),
        id: String(query.get('id') ?? '') })
      if (!out.ok) return refuse(request, out)
      return request.json(200, { ok: true, service: 'quotagent-attachments', side: who.side,
        object: { kind: out.kind, id: out.id }, files: out.files, counts: out.counts,
        visibility_rule: '本侧内部件（visibility=side）永不出本侧；交付件（both）对方是该对象当事方才可见',
        next_action: out.files.length ? '' : '还没有附件：在附件面板里拖文件进来（或点「选择文件」）' })
    },
    POST: ({ methodsNotAllowed }) => (request) => methodsNotAllowed(request, 'GET'),
  },
  '/api/attachments/file': {
    GET: ({ store, whoOf, refuse }) => (request) => {
      const who = whoOf(request)
      if (!who.ok) return request.json(who.status, who.payload)
      const out = store.get({ side: who.side, id: String(request.url.searchParams.get('id') ?? '') })
      if (!out.ok) return refuse(request, out, { side: who.side })
      const entry = out.entry
      const safeName = String(entry.name).replace(/[^\x20-\x7e\u00a0-\uffff]/g, '_').replace(/["\\]/g, '_')
      // 一律 `attachment` 下载（不在浏览器里内联渲染用户上传的内容）+ nosniff + 附件校验头
      return request.send(200, entry.content_type, out.body, {
        'content-disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        'content-length': String(out.body.length),
        'x-attachment-id': entry.id, 'x-attachment-sha256': entry.sha256,
        'x-attachment-bytes': String(entry.bytes), 'x-attachment-uploader': entry.uploader,
        'x-attachment-visibility': entry.visibility,
        // **多版本**：下载哪一版、是不是最新（旧版也能下 ⇒ 这里如实说是第几版）
        'x-attachment-version': String(entry.version ?? 1),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      })
    },
    POST: ({ methodsNotAllowed }) => (request) => methodsNotAllowed(request, 'GET'),
  },
  '/api/attachments/versions': {
    GET: ({ store, whoOf, refuse, prefix }) => (request) => {
      const who = whoOf(request)
      if (!who.ok) return request.json(who.status, who.payload)
      const query = request.url.searchParams
      const out = store.versions({ side: who.side, kind: String(query.get('kind') ?? ''),
        id: String(query.get('id') ?? '') })
      if (!out.ok) return refuse(request, out, { side: who.side })
      const fileUrl = (id) => `${prefix}/api/attachments/file?id=${encodeURIComponent(id)}`
      const groups = out.groups.map((group) => ({ ...group,
        versions: group.versions.map((version) => ({ ...version, download_url: fileUrl(version.id),
          preview_url: version.previewable && !version.deleted
            ? `${prefix}/api/attachments/preview?id=${encodeURIComponent(version.id)}` : '' })) }))
      return request.json(200, { ok: true, service: 'quotagent-attachments', side: who.side,
        object: { kind: out.kind, id: out.id }, groups, counts: out.counts, rule: out.rule,
        ledger_added: 0,
        next_action: out.counts.versioned_groups
          ? '同名附件里有多版：逐条版本都有一个下载地址（旧版**不覆盖**、仍可下）'
          : '这个对象上还没有「同名多版」：同名文件再传一次就会多出一版（旧版保留）' })
    },
    POST: ({ methodsNotAllowed }) => (request) => methodsNotAllowed(request, 'GET'),
  },
  '/api/attachments/preview': {
    GET: ({ store, whoOf, prefix }) => (request) => {
      const who = whoOf(request)
      if (!who.ok) return request.json(who.status, who.payload)
      const query = request.url.searchParams
      const maxBytes = Number(query.get('max_bytes') ?? '')
      const out = store.preview({ side: who.side, id: String(query.get('id') ?? ''),
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0 })
      if (!out.ok) {
        const entry = out.attachment ?? null
        return request.json(STATUS_FOR[out.code] ?? 400, { ok: false, service: 'quotagent-attachments',
          code: out.code, reason: out.reason, next_action: out.next_action,
          side: who.side, preview_kinds: out.preview_kinds ?? PREVIEW_KINDS,
          attachment: entry ? { id: entry.id, name: entry.name, preview_kind: null } : null,
          download_url: entry ? `${prefix}/api/attachments/file?id=${encodeURIComponent(entry.id)}` : '',
          note: '界内预览**不下载也能看**，但它只做图片 / PDF / 文本：其余类型如实说不预览（不假装加载中）' })
      }
      const entry = out.entry
      const safeName = String(entry.name).replace(/[^\x20-\x7e\u00a0-\uffff]/g, '_').replace(/["\\]/g, '_')
      // 一律 `inline`（**要的就是在界内看**）；`nosniff` + CSP 挡住"把纯文本当 HTML 渲染"
      return request.send(200, out.inline_content_type, out.body, {
        'content-disposition': `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        'content-length': String(out.body.length),
        'x-attachment-id': entry.id, 'x-attachment-sha256': entry.sha256,
        'x-attachment-bytes': String(entry.bytes), 'x-attachment-uploader': entry.uploader,
        'x-attachment-visibility': entry.visibility, 'x-attachment-version': String(entry.version),
        'x-preview-kind': out.kind, 'x-preview-truncated': out.truncated ? '1' : '0',
        'x-preview-bytes': String(out.previewed_bytes), 'x-preview-total-bytes': String(out.total_bytes),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        'cache-control': 'private, no-store',
      })
    },
    POST: ({ methodsNotAllowed }) => (request) => methodsNotAllowed(request, 'GET'),
  },
  '/api/attachments/delete': {
    POST: ({ store, whoOf, refuse }) => (request) => {
      const who = whoOf(request)
      if (!who.ok) return request.json(who.status, who.payload)
      const limit = Math.floor(store.currentLimits().max_bytes) + BODY_SLACK
      return new Promise((resolve) => {
        readBounded(request.req, Math.min(limit, 64 * 1024), (buffer, over) => {
          try {
            if (over || buffer === null) {
              return resolve(request.json(400, { ok: false, code: 'delete-body-unreadable',
                reason: '删除请求体读不到（只收 JSON {"id":"att-…"}）',
                next_action: 'POST JSON：{"id":"att-<12 位十六进制>"}' }))
            }
            let payload = {}
            const raw = buffer.toString('utf8').trim()
            if (raw !== '') {
              try { payload = JSON.parse(raw) } catch (err) {
                return resolve(request.json(400, { ok: false, code: 'invalid-json',
                  reason: flat(err, 120), next_action: 'POST JSON：{"id":"att-…"}' }))
              }
            }
            const wanted = String(payload.id ?? request.url.searchParams.get('id') ?? '')
            const out = store.remove({ side: who.side, actor: who.human, id: wanted,
              reason: String(payload.reason ?? '') })
            if (!out.ok) return resolve(refuse(request, out, { side: who.side }))
            return resolve(request.json(200, { ok: true, service: 'quotagent-attachments', action: 'delete',
              attachment: out.entry, trace: out.trace, moved_to_trash: out.moved, ledger_added: 0,
              note: out.note,
              next_action: '删除已留痕（墓碑 + journal.jsonl）。要再传一份，重新上传即可' }))
          } catch (err) {
            return resolve(crash(request, err))
          }
        })
      })
    },
  },
  '/api/attachments/store': {
    GET: ({ store, prefix }) => (request) => request.json(200, { ...store.describe(), prefix,
      http: { upload: `${prefix}/api/attachments/upload`, list: `${prefix}/api/attachments/list`,
        file: `${prefix}/api/attachments/file?id=<id>`, preview: `${prefix}/api/attachments/preview?id=<id>`,
        versions: `${prefix}/api/attachments/versions?kind=<对象类>&id=<对象 id>`,
        delete: `${prefix}/api/attachments/delete` },
      refusal_codes: REFUSAL_CODES, visibilities: VISIBILITIES,
      object_kinds: Object.keys(OBJECT_POLICY),
      routes: ROUTES.map((route) => ({ method: route.method, path: `${prefix}${route.path}`, auth: route.auth })),
      note: '只给**聚合读数**（没有文件名、没有对象 id）：这一条是公开自述，用来对账"附件没进账本"'
        + '与"上限/策略是什么"' }),
    POST: ({ methodsNotAllowed }) => (request) => methodsNotAllowed(request, 'GET'),
  },
}

export const LIMITS_PUBLIC = LIMITS
