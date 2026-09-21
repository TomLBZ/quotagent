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
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { array, number, object, string } from '../lib/std-schema.mjs'
import { openLedger } from '../lib/ledger-view.mjs'

export const name = 'webui'

export const inject = ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback']   // 每个都是独立插件（准入 / 观测 / 视图 / 系统管理 / 市场 / 配置与凭据 / 邮件 / 比价 heuristics / 反馈闭环）

export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const usedServices = ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback']

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
  ledger_evolve: string().default(''),   // 自进化账本（运维视角读它的**归纳**，不出正文）
  retention_plan: string().default(''),  // 留存计划的**绝对路径**（生产 cwd≠仓库根，相对路径会读不到）
  pipeline_snapshot: string().default(''),  // 三域快照的**绝对路径**（同上）
  admin_snapshot: string().default(''),     // 系统管理快照（阻塞/进度）的**绝对路径**（同上）
  admin_inbox: string().default(''),        // 待处理提交目录（宿主写这里；Only Python 消费，账号不写账本）
})

const html = (title, body, prefix) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}
code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}
nav a{margin-right:1rem}details{margin:.6rem 0}summary{cursor:pointer}</style></head><body><nav>
<a href="${prefix}/">总览</a><a href="${prefix}/start/">上手（token／配置放哪里？）</a>
<a href="${prefix}/contractor/">承包商视角</a><a href="${prefix}/supplier/">供应商视角</a>
<a href="${prefix}/ops/">运维视角</a>
<a href="${prefix}/admin/">系统管理</a><a href="${prefix}/api/status">/api/status</a><a href="${prefix}/api/health">/api/health</a>
</nav><h1>${title}</h1>${body}</body></html>`

/**
 * 道内子视图（**静态声明**，P0-3）：`/<view>/<sub>/`。
 * 新增子视图必须同步三处：本表、`/api/routes`、门 `host/webui.mjs`（否则门抓不到"新增路由没登记"）。
 * 供应商道**没有** evidence（有 clarifications）：两道的子视图清单本来就不同，不是笔误。
 */
export const SUBVIEWS = {
  contractor: ['events', 'quotes', 'approvals', 'evidence'],
  supplier: ['events', 'quotes', 'approvals', 'clarifications'],
}

/** 子视图中文名（导航与标题用；键必须与 SUBVIEWS 完全对应）。 */
const SUB_TITLE = { events: '事件', quotes: '报价', approvals: '待批', evidence: '证据面', clarifications: '澄清' }

/** 分页/筛选的**夹取口径**（写死一处；回显的 applied 即真值，请求值一并报出便于人工核对）。 */
const LIMIT_DEFAULT = 20
const LIMIT_MAX = 200
const PAGE_DEFAULT = 1
const SORTS = ['desc', 'asc']
const SORT_DEFAULT = SORTS[0]
const LIMIT_CHOICES = [10, 20, 50, 200]

/** ops / admin 两道的道内导航（本步不新增子路由，用**页内锚点**：一跳可达这件事本身保留）。 */
const OPS_SECTIONS = [['runtime', '运行期'], ['pipeline', '三域流水'], ['mail', '邮件（SMTP/IMAP）'], ['retention', '留存计划'],
  ['evolve', '自进化'], ['evidence', '证据面']]
const ADMIN_SECTIONS = [['blocks', '阻塞清单'], ['progress', '进度'], ['config', '配置与凭据'],
  ['user-plugins', '用户空间插件'], ['market', '插件市场']]

/** HTML 转义：页面全部由字符串拼装，任何来自账本/快照/参数表的字节都必须先过这里。 */
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 整数解析：只认十进制整数字面量（`-1` 认；`2.5` / `abc` / 空 → null = "不是整数"，不猜）。 */
const intOrNull = (value) => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return /^-?\d+$/.test(text) ? Number(text) : null
}

/** 道内子导航：能回**该道其它子视图 + 首页**（`data-subnav` 是门的抓手，也是"道内互跳"的机检形态）。 */
const subNav = (prefix, view, current) => {
  const links = [`<a href="${prefix}/${view}/">首页</a>`]
  for (const sub of SUBVIEWS[view] ?? []) {
    links.push(`<a href="${prefix}/${view}/${sub}/"${sub === current ? ' aria-current="page"' : ''}>${SUB_TITLE[sub] ?? sub}</a>`)
  }
  // 比价 heuristics（T-279）：业务方看得见、点得到（新页面本身零内联脚本）
  links.push(`<a href="${prefix}/${view}/heuristics/" data-heuristics-link="1"${current === 'heuristics' ? ' aria-current="page"' : ''}>比价口径</a>`)
  return `<nav data-subnav="${view}">${links.join(' ')}</nav>`
}

/** 页内锚点导航（ops / admin 两道；同样带 `data-subnav` 抓手）。 */
const anchorNav = (view, home, sections, extras = []) => `<nav data-subnav="${view}">${[`<a href="${home}">首页</a>`]
  .concat(sections.map(([id, label]) => `<a href="${home}#${id}">${label}</a>`))
  .concat(extras.map(([href, label]) => `<a href="${href}" data-heuristics-link="1">${label}</a>`))
  .join(' ')}</nav>`


/** 上手页（**未提权也能看**）：三步上手 + 提权 token 放哪里 + 配置/凭据放哪里 + 四个视图能做什么。
 *  只讲机制与命令，**不显示任何状态位/凭据值**（宿主零写面、零凭据）。 */
function onboardingHtml(prefix, views) {
  const rows = views.map((v) => {
    const can = { contractor: '看本侧待办/事件/报价/待批摘要；准备批准材料（**批准本身在终端做人签**）',
      supplier: '看本侧待办/事件/自己的报价；提交澄清与报价草稿（**提交与定标在终端做人签**）',
      ops: '三域流水、留存计划、自进化日志、证据索引（只读）',
      admin: '提权后：插件市场、用户空间插件装卸/迭代、阻塞提交、跨道切换（**写操作只落待处理项，由 Python 侧消费**）' }
    return `<tr><td><code>${prefix}/${v}/</code></td><td>${can[v] ?? '（未登记）'}</td></tr>`
  }).join('')
  return `<h2>三步上手</h2>
<ol>
<li><b>先看今天要处理的</b>：<a href="${prefix}/contractor/">承包商视角</a> ·
<a href="${prefix}/supplier/">供应商视角</a>（这两页各只有一个视图，不需要登录）。</li>
<li><b>要以管理员身份操作时，先提权</b>：见下节「管理员 token 放哪里」。</li>
<li><b>要改成自己的配置／接自己的凭据</b>：见下节「配置与凭据放哪里」。</li>
</ol>
<h2>管理员 token 放哪里</h2>
<p>token **不在这个页面里**，也不在浏览器里；它只有两条来源（二选一，环境变量优先）：</p>
<pre>① 环境变量：   QUOTAGENT_ADMIN_TOKEN=&lt;你的随机串&gt;   （Hermes 容器里可用 /workspace/config.yaml 或部署脚本注入）
② 0600 文件：  /workspace/config/quotagent-admin-token   （可用 QUOTAGENT_ADMIN_TOKEN_FILE 覆盖路径）
   生成示例：  head -c 32 /dev/urandom | base64 &gt; /workspace/config/quotagent-admin-token &amp;&amp; chmod 600 /workspace/config/quotagent-admin-token</pre>
<p>文件权限**不是 0600 会被拒绝加载**（fail-closed）；两条链都没有 = 管理员功能未启用，
系统管理面板会把这件事本身当成一条阻塞项报出来（「available:false」 + 「next_action」）。</p>
<p>放好之后这样验证：<code>curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8093/quotagent/admin/</code>
→ <code>401</code> = 未提权（正常，说明门卫在工作）；提权请在 <a href="${prefix}/contractor/">任一侧页面</a>下方的表单里粘贴 token，
成功后 cookie 只对 <code>${prefix}/admin/**</code> 生效。</p>
<h2>配置与凭据放哪里</h2>
<pre>项目/插件配置（YAML）： /workspace/config.yaml          ← 字段名见 /quotagent/admin/api/config（提权后）
                        · 只有 tools/config-apply.py 写它（原子写 + 回滚 + 只看受管段 project:/plugins:/credentials:）
                        · 子集：顶层/嵌套映射 + 标量 + 简单列表 + 内联 {}/[]；锚点/多文档/块标量会被**拒**（不静默糊掉）
管理员 token（凭据）：  /workspace/config/quotagent-admin-token（0600，路径可用 QUOTAGENT_ADMIN_TOKEN_FILE 覆盖）
用户空间插件凭据：      作用域键 cred:&lt;ns&gt;/&lt;plugin&gt;:&lt;key&gt;（插件只能解析自己作用域内的键）</pre>
<p>提权后打开 <a href="${prefix}/admin/config/">配置与凭据页</a>：三层（项目/插件/凭据）一屏，每键给
<code>source</code>（default/file/env/runtime）与 <code>shadowed_by</code>；凭据页只显示「已配置/未配置 + 来源 + 必须的权限 + 指纹前 8 位 + 下一步」，
**永不显示值**。页面上可以先"干跑"（零落盘零生效）再提交；提交只落一个 0600 待处理项，**由 Python 侧消费后才生效**。</p>
<p>需要凭据才能工作的功能（**在接上之前一律如实报未连接，不会假装健康**）：</p>
<pre>· 邮件收发（SMTP/IMAP）：未配置 → mail 传输 available:false / reason=mail-transport-unavailable / next_action=配置凭据后接入
· Jev 建议层：未配置 key → 面板里作为一条阻塞项出现（不是在日志里悄悄失败）</pre>
<p>阻塞项可以在 <a href="${prefix}/admin/">系统管理面板</a>里**直接提交解决**（提交只落一个 0600 待处理项，
由 Python 侧消费并落账本 「admin/block-resolved」；宿主自己不写账本）。</p>
<h2>四个视图各能做什么</h2>
<table><tr><th>路由</th><th>能做什么</th></tr>${rows}</table>
<p><small>机器可读的路由表：<a href="${prefix}/api/routes">${prefix}/api/routes</a>。
需要人签的动作（批准、提交报价、定标、发 PO、变更批准）**永远只在终端**完成 —— 浏览器只帮你准备好材料，
不会替你签。</small></p>`
}


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

  const obs = ctx.observability   // 本地句柄（D-027：不按请求去 ctx 里查自己依赖的服务）
  const history = ctx.priceHistory
  const evidence = ctx.evidenceSummary   // 账本证据面（第二个自进化产出，T-239）
  const ops = ctx.opsView               // 运维视角（第四个自进化产出，T-243）
  const journal = ctx.evolveJournal     // 自进化流水（第五个自进化产出，T-245）
  const scorecard = ctx.supplierScorecard   // 供应商绩效记分卡（subagent 产出，T-247）
  const approvals = ctx.approvalDigest      // 人工门待批摘要（subagent 产出，T-250）
  const retention = ctx.retentionView       // 留存计划的只读聚合（subagent 产出，T-254）
  const pipeline = ctx.pipelineView         // 三域运维快照的只读聚合（subagent 产出，T-260）
  const adminGuard = ctx.adminGuard         // 管理员 token / 会话 / 冷却（subagent 产出，T-272）
  const adminView = ctx.adminView           // 系统管理快照的只读聚合（同上）
  const pluginMarket = ctx.pluginMarket      // 插件列表/市场的只读聚合（subagent 产出，T-267）
  const userPlugins = ctx.userPluginManager  // 用户空间插件管理面（subagent 产出，T-268）
  const configView = ctx.configView          // 配置与凭据的可视面 + 干跑 + 待处理项（本批新增模块）
  const mailView = ctx.mailView              // 邮件域（SMTP/IMAP）的只读运维视图（**本批新增模块**）
  const bid = ctx.bidHeuristics              // 比价 heuristics（domain 插件，T-279）：只做算术，不读账本
  const feedback = ctx.uiFeedback            // WebUI 反馈闭环（ui-feedback 插件）：版本事实只读 + 只落 0600 待办件

  /** 三域快照（谈判/FAQ/邮件）：由 Python 侧写入 `tmp/ui-shared/pipeline.json`，宿主只读。 */
  const pipelinePayload = () => {
    const file = String(config.pipeline_snapshot ?? '') ||
      join(String(config.ui_shared ?? 'tmp/ui-shared'), 'pipeline.json')
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { return null }
  }

  /**
   * 留存计划：**判定在 Python 侧**（`services/retention.py`），由维护任务落到
   * `tmp/ui-shared/retention-plan.json`；这里只读文件并交给 `retention-view` 聚合。
   * 文件缺失或损坏 → 交给插件降级（degraded），**不自己算留存**。
   */
  const retentionPlanOf = (view) => {
    const file = String(config.retention_plan ?? '') ||
      join(String(config.ui_shared ?? 'tmp/ui-shared'), 'retention-plan.json')
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const entry = parsed?.views?.[view]
      return entry?.plan ?? null
    } catch (err) {
      return null
    }
  }
  /**
   * 邮件状态：**读取与形状门都在 Python 侧产出的快照上**（`mail-view` 插件只读那一个文件）。
   * 宿主不做任何"邮件通不通"的判断：`degraded` 时如实显示原因与下一步，不猜。
   */
  const mailSnapshot = () => mailView.read()
  /** 邮件页（**0 行 `<script>`**：只读展示 + 一个指向 JSON 的链接；交互留给已登记的配置表单）。 */
  const mailHtml = () => {
    const snap = mailSnapshot()
    const counts = snap.counts || {}
    const rows = (snap.views || []).map((row) => `<tr><td>${esc(row.view)}</td><td>${row.queued}</td>`
      + `<td>${row.refused}</td><td>${row.sent}</td><td>${row.parsed}</td></tr>`).join('')
    const serviceRow = (name, value) => `<tr><td>${name}</td><td>${value.configured ? '已配置' : '未配置'}</td>`
      + `<td>${value.connected ? '已连接' : '未连接'}</td><td>${value.available ? '可用' : '不可用'}</td>`
      + `<td><code>${esc(value.reason || '—')}</code></td><td>${esc(value.next_action || '—')}</td></tr>`
    const attempts = (snap.attempts || []).map((item) => `<tr><td>${esc(item.kind)}</td><td>${esc(item.service)}</td>`
      + `<td>${item.ok ? '成功' : '失败'}</td><td><code>${esc(item.reason || '—')}</code></td>`
      + `<td><code>${esc(item.message_id || '—')}</code></td></tr>`).join('')
    const last = snap.last_attempt
    return `<p>本视图**只读**：数据来自 Python 侧快照（<code>services/mail_transport</code> 的状态文件 + 
<code>mail/*</code> 账本计数），由插件 <code>mail-view</code> 投影。宿主**不联网、不发信、不写账本**，也不显示任何凭据值。</p>`
      + `<p>JSON：<code>${prefix}/api/mail</code></p>`
      + (snap.degraded
        ? `<p><b>降级</b>：<code>${esc(snap.reason)}</code> → ${esc(snap.next_action)}`
          + `${snap.state_file ? `（快照文件：<code>${esc(snap.state_file)}</code>）` : ''}</p>`
        : `<p>${esc(snap.headline || '')}</p>`)
      + `<h3 id="counts">队列计数（Python 侧账本）</h3>`
      + `<table data-mail="counts"><thead><tr><th>排队</th><th>被拒</th><th>已发</th><th>入站解析</th>`
      + `<th>合计来源</th></tr></thead><tbody><tr><td>${counts.queued ?? 0}</td><td>${counts.refused ?? 0}</td>`
      + `<td>${counts.sent ?? 0}</td><td>${counts.parsed ?? 0}</td><td>${esc(snap.totals_source || 'none')}</td>`
      + `</tr></tbody></table>`
      + `<h3 id="channel">传输通道（SMTP 发信 / IMAP 收信）</h3>`
      + `<table data-mail="transport"><thead><tr><th>通道</th><th>配置</th><th>连接</th><th>可用</th><th>原因</th>`
      + `<th>下一步</th></tr></thead><tbody>`
      + serviceRow('SMTP', snap.smtp || {}) + serviceRow('IMAP', snap.imap || {})
      + `</tbody></table>`
      + `<p><small>"可用"只按**证据**给：配置齐了还不够，要有一次真实发送/收信成功（否则原因位写 
<code>mail-smtp-unprobed</code>）；没配就是 <code>mail-smtp-unconfigured</code>，两者**不是**同一件事。</small></p>`
      + `<h3 id="attempts">最近一次尝试与尝试记录</h3>`
      + (last ? `<p>最近一次：<b>${esc(last.kind)}</b> / ${esc(last.service)} / ${last.ok ? '成功' : '失败'} `
        + `（原因 <code>${esc(last.reason || '—')}</code>；消息 <code>${esc(last.message_id || '—')}</code>）</p>`
        : `<p>还没有任何发送/收信尝试记录（Python 侧每次真尝试都会更新状态快照）。</p>`)
      + (attempts
        ? `<table data-mail="attempts"><thead><tr><th>动作</th><th>通道</th><th>结果</th><th>原因</th>`
          + `<th>消息</th></tr></thead><tbody>${attempts}</tbody></table>`
        : '')
      + `<h3 id="views">按视角（账本计数）</h3>`
      + (rows ? `<table data-mail="views"><thead><tr><th>视角</th><th>排队</th><th>被拒</th><th>已发</th>`
        + `<th>入站解析</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>本份快照里没有视角计数。</p>')
      + `<p><small>本页 **0 行 <code>&lt;script&gt;</code>、0 内联事件**：读用链接，改配置用已登记的 
<code>${prefix}/admin/config/</code> 表单（宿主只落 0600 待处理项，由 Python 侧消费）。</small></p>`
  }

  /**
   * 从账本行推导**当前仍待批**的事项：按 `approval_id` 取该项的**最后一条** `approval/*` 事件，
   * 若最后状态是 granted/aborted 就不算待批。只读、只用公开行（门里断言响应不含正文与私域键）。
   */
  const pendingApprovals = (view) => {
    const last = new Map()
    for (const row of ledgerOf(view).rows()) {
      const type = String(row?.type ?? '')
      if (!type.startsWith('approval/')) continue
      const id = String(row?.body?.approval_id ?? row?.approval_id ?? '')
      if (!id) continue
      last.set(id, row)
    }
    return [...last.values()].filter((row) => {
      const type = String(row.type)
      return type !== 'approval/granted' && type !== 'approval/aborted'
    })
  }
  /** 自进化账本行的只读读取（读不到就当空：运维页不能因为账本还没生成而崩） */
  const evolveRows = () => {
    if (!config.ledger_evolve) return []
    try { return openLedger(config.ledger_evolve).rows() } catch (err) { return [] }
  }
  /**
   * 价格序列的输入：**原始行**的 `body.lines[]`，但只取非私域字段（`item_id` / `unit_price`）。
   * 为什么要用原始行：投影层只保留 `seq/type/summary/ts`，价格明细会被截掉（实测 groups=0）。
   * 为什么这样仍然安全：只输出这两个字段，其中任何一个都不在本视角的 `privateKeys` 里；
   * 并且这里**额外做一次私域键过滤**（纵深防御，与本文件既有的"抑制原因对外通用"同一纪律）。
   */
  const priceRows = (view) => {
    const rule = rules[view] || { privateKeys: [] }
    return ledgerOf(view).rows().flatMap((row) => {
      const lines = row && row.body && Array.isArray(row.body.lines) ? row.body.lines : []
      return lines
        .filter((line) => line && line.item_id !== undefined && line.unit_price !== undefined
          && !Object.keys(line).some((key) => rule.privateKeys.includes(key)))
        .map((line) => ({ supplier_id: String(line.item_id), unit_price: line.unit_price }))
    })
  }
  /** price-history 插件按 `key_field` 分组；UI 侧把分组键统一叫 group（插件字段名是实现细节） */
  const seriesView = (view) => history.bySupplier(priceRows(view))
    .map((item) => ({ group: item.supplier_id, count: item.count, min: item.min, median: item.median,
      max: item.max, latest: item.latest, trend: item.trend }))

  // ==========================================================================================
  // 比价 heuristics（T-279）：**为什么这家排在这里** + 双方**自己调权重**。
  //   · 打分与解释在 `host/modules/bid-heuristics.mjs`（domain 插件，只做算术、不读账本）；
  //   · 本文件只做两件事：把**本视角自己的**公开行**映射成候选**（白名单字段，逐行审阅）、渲染页面；
  //   · 候选字段映射（**只读投影后的公开行**；私域键的行整行跳过，只取下列字段的**真值**）：
  //       代号   `body.supplier_id` → `body.quote_id` → 行 `correlation_id`
  //       行项目 `line.item_id` / `body.item_id`（**归一按行项目分组**：不同行项目的单价不可比）
  //       单价   `line.unit_price`（行项目报价）/ `body.final_price`·`body.proposed_price`（报价级单价）
  //       交期   `body.lead_time_days`                    （天）
  //       付款条件 `body.payment_terms_offered.days` / `body.payment_terms.days`（净账期天数）
  //       质保   `body.warranty_months` / `line.warranty_months`（月）
  //       偏差   `body.deviation_count` / `body.deviations[]` 长度（计数）
  //     取不到的字段**不补默认值**（插件里记进 missing，不当 0）。
  // ==========================================================================================
  const HEURISTICS_FACTORS = [
    ['price', '单价', 'w_price'], ['delivery', '交期', 'w_delivery'], ['payment', '付款条件', 'w_payment'],
    ['warranty', '质保', 'w_warranty'], ['deviation', '偏差计数', 'w_deviation'],
  ]
  /**
   * 私域防线（**纵深防御**）：本视角的 `privateKeys` + `private` 字样**一律**跳过；
   * 另外几个已知私域键名只在**要防另一方的视角**上额外跳过 —— 承包商视角没有"要防的另一方"，
   * 不该把**自己**账本里带私域键的行从自己的比价页上藏起来（那会变成"悄悄少了几家候选"）。
   */
  const VIEW_EXTRA_PRIVATE_KEYS = { supplier: ['reserve_price', 'cost_model', 'cost_floor', 'markup_pct'] }
  const hasPrivateKey = (value, view) => {
    if (!value || typeof value !== 'object') return false
    const rule = rules[view] || { privateKeys: [] }
    const extra = VIEW_EXTRA_PRIVATE_KEYS[view] ?? []
    return Object.keys(value).some((key) => {
      const lowered = key.toLowerCase()
      return (rule.privateKeys ?? []).includes(key) || lowered.includes('private') || extra.includes(lowered)
    })
  }
  const numField = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  /** 净账期天数：数字直接用；对象取 `days`（其余形状按"取不到"处理，不猜）。 */
  const netDays = (value) => {
    const direct = numField(value)
    if (direct !== undefined) return direct
    if (value && typeof value === 'object' && !Array.isArray(value)) return numField(value.days)
    return undefined
  }
  /** 偏差计数：数字优先；数组取长度（"有几条偏差"这件事本身就是计数，不是判定）。 */
  const deviationCount = (value) => {
    const direct = numField(value)
    if (direct !== undefined) return direct
    return Array.isArray(value) ? value.length : undefined
  }
  /**
   * 本视角的候选：只读自己的账本行 → 只取上文那 6 个字段（带私域键的行整行跳过）。
   * 返回 `{ list, skipped }`：**被跳过的条数必须在页面上报出来**（否则就成了"悄悄少了几家候选"）。
   */
  const heuristicsCandidates = (view) => {
    const out = []
    let skipped = 0
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) { skipped += 1; continue }   // 行体带私域 → 连这行都不进候选
      const lines = Array.isArray(body.lines) ? body.lines : []
      const textOf = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
      const code = [body.supplier_id, body.quote_id, row?.correlation_id]
        .map((value) => (typeof value === 'string' ? value.trim() : '')).find((text) => text !== '')
      if (!code) continue
      const shared = {
        code,
        lead_time_days: numField(body.lead_time_days),
        payment_terms: netDays(body.payment_terms_offered) ?? netDays(body.payment_terms),
        warranty_months: numField(body.warranty_months),
        deviation_count: deviationCount(body.deviation_count) ?? deviationCount(body.deviations),
      }
      for (const line of lines) {
        if (!line || typeof line !== 'object' || Array.isArray(line)) continue
        if (hasPrivateKey(line, view)) continue         // 行项目带私域 → 跳过该行项目
        out.push({
          ...shared,
          item: textOf(line.item_id),
          unit_price: numField(line.unit_price),
          lead_time_days: shared.lead_time_days ?? numField(line.lead_time_days),
          warranty_months: shared.warranty_months ?? numField(line.warranty_months),
          deviation_count: shared.deviation_count ?? deviationCount(line.deviation_count),
        })
      }
      // 报价级单价（账本里 `quote/price-proposed` / `quote/human-approved` 的形状：`item_id` + 单价）：
      // 行项目明细在别的行上时，这一条也要能进候选（否则这些账本上比价页会是空的）
      if (lines.length === 0) {
        const item = textOf(body.item_id)
        const unitPrice = numField(body.final_price) ?? numField(body.proposed_price)
        if (item !== undefined && unitPrice !== undefined) out.push({ ...shared, item, unit_price: unitPrice })
      }
    }
    // 同一代号出现多次 = 该供应商的多个行项目报价：**按代号聚合取最优**没有口径依据（谁最优？），
    // 所以这里保持"一行一个候选"的原始形状，并把代号重复的事实报在 counts 里（页面自述）。
    return { list: out, skipped }
  }
  /** 权重参数解析：只放行有限数；不是数字的参数**不进 payload**（页面上如实报出请求原值）。 */
  const heuristicsWeights = (url) => {
    const weights = {}
    const notes = []
    const submitted = {}
    for (const [, label, param] of HEURISTICS_FACTORS) {
      const raw = url.searchParams.get(param)
      submitted[param] = raw ?? ''
      if (raw === null || String(raw).trim() === '') continue
      const value = Number(String(raw).trim())
      if (!Number.isFinite(value)) { notes.push(`${param}=${raw} 不是有限数 → 该分量用默认权重（未参与本次排名）`); continue }
      weights[param.replace(/^w_/, '')] = value
    }
    return { weights, notes, submitted }
  }
  const heuristicsLabel = (factor) => (HEURISTICS_FACTORS.find(([name]) => name === factor) ?? [factor, factor])[1]
  const heuristicsRun = (view, url) => {
    const parsed = heuristicsWeights(url)
    const candidates = heuristicsCandidates(view)
    const payload = bid.rank({ weights: parsed.weights, candidates: candidates.list })
    const codes = new Set(candidates.list.map((item) => item.code))
    return { parsed, payload,
      counts: { ...payload.counts, codes: codes.size, factor_values: candidates.list.length,
        skipped_private: candidates.skipped },
      notes: [...parsed.notes, ...(payload.clamp_notes ?? [])] }
  }
  /** 页面（SSR，**零内联脚本**：权重输入是 `<form method=get>`，预设是 `<a>` 链接）。 */
  const heuristicsHtml = (view, url) => {
    const { parsed, payload, counts, notes } = heuristicsRun(view, url)
    const weightInputs = HEURISTICS_FACTORS.map(([factor, label, param]) => {
      const current = parsed.submitted[param] !== '' ? parsed.submitted[param] : String(payload.weights_applied[factor] ?? '')
      return `<label>${label} <input name="${param}" value="${esc(current)}" size="5"></label>`
    }).join(' ')
    const presets = [['price', '只看单价'], ['delivery', '只看交期'], ['payment', '只看付款条件'],
      ['warranty', '只看质保'], ['deviation', '只看偏差']]
      .map(([factor, label]) => `<a href="${prefix}/${view}/heuristics/?w_${factor}=1">${label}</a>`).join(' · ')
    const weightRow = HEURISTICS_FACTORS.map(([factor, label]) =>
      `<td data-weight="${factor}">${esc(label)}：${esc(payload.weights_applied[factor] ?? '—')}` +
      `<br><small>提交 ${esc(parsed.submitted[`w_${factor}`] === '' ? '（未提交）' : parsed.submitted[`w_${factor}`])}</small></td>`).join('')
    const rows = payload.rows.map((row) => `<tr data-row="${esc(row.code)}" data-rank="${row.rank}">`
      + `<td>${row.rank}</td><td><code>${esc(row.code)}</code></td><td data-score="${row.score}">${row.score}</td>`
      + HEURISTICS_FACTORS.map(([factor]) => `<td data-contribution="${factor}">${row.contributions[factor]}</td>`).join('')
      + `<td>${esc((row.coverage?.present ?? []).map(heuristicsLabel).join('/') || '—')}</td>`
      + `<td>${esc((row.coverage?.missing ?? []).map(heuristicsLabel).join('/') || '无（五个因子都取得到）')}</td>`
      + `<td>${esc(row.item ?? '—')}</td>`
      + `<td>${esc(row.hint ?? '')}</td></tr>`).join('')
    const header = `<tr><th>名次</th><th>代号</th><th>得分<br><small>越高越前</small></th>`
      + HEURISTICS_FACTORS.map(([factor, label]) => `<th>${label}<br><small>贡献点</small></th>`).join('')
      + `<th>可用因子</th><th>缺失因子</th><th>行项目</th><th>如何提升排名</th></tr>`
    const degradedText = `<p class="degraded" data-degraded="1">降级（**不冒充健康**）：<code>${esc(payload.reason)}</code>`
      + ` → 本次没有可排名的候选（数据来源见下）。这不是页面坏了。</p>`
    return subNav(prefix, view, 'heuristics')
      + `<p><a href="${prefix}/${view}/">← 回 ${rules[view].title}</a> · JSON：<code>${prefix}/${view}/api/heuristics</code>`
      + ` （参数同本页：<code>w_price</code>/<code>w_delivery</code>/<code>w_payment</code>/<code>w_warranty</code>/<code>w_deviation</code>）</p>`
      + `<p>本页让双方看到**为什么这家排在这里**，并**自己调权重**。数据只来自<b>本视角自己的公开投影行</b>`
      + `（本插件不读账本、不写账本、不落任何文件）；排序口径与 Python 侧 <code>services/compare.py</code> 同名同向`
      + `（五个分量 = 单价 / 交期 / 付款条件 / 质保 / 偏差计数），同权重下**名次一致**。</p>`
      + `<form method="get" action="${prefix}/${view}/heuristics/">${weightInputs} `
      + `<button type="submit">用这组权重排名</button></form>`
      + `<p>预设：${presets} · <a href="${prefix}/${view}/heuristics/">恢复默认权重</a>`
      + `（预设与手填都走 <code>form method=get</code> / 链接，浏览器里不需要脚本）</p>`
      + `<h3 id="weights">① 本次生效的权重（归一后和为一）</h3>`
      + `<table data-heuristics="weights">${weightRow}</table>`
      + `<p data-normalized-sum="1">归一后权重和 = <code>${esc(payload.weights_applied ? payload.normalized_sum : '—')}</code>`
      + `（契约：与 1 的绝对差 ≤ <code>${esc(payload.normalization?.tolerance)}</code>；越界权重被夹取并回显在下面）</p>`
      + (notes.length
        ? `<ul class="clamp" data-clamp="${notes.length}">${notes.map((note) => `<li>夹取：${esc(note)}</li>`).join('')}</ul>`
        : `<p class="clamp" data-clamp="0">夹取：无（本次请求的权重都是 [0,1] 内的有限数）</p>`)
      + `<h3 id="ranking">② 排名（贡献分解）</h3>`
      + `<p data-heuristics="counts">候选 <b>${counts.candidates}</b> 条（其中可排名 <b>${counts.usable}</b>、`
      + `代号 <b>${counts.codes}</b> 个、行项目报价 <b>${counts.factor_values}</b> 条）；`
      + `本次显示 <b>${counts.ranked}</b> 条；截断 <b>${payload.truncated}</b>（超上限被丢 <b>${payload.omitted}</b> 条，`
      + `上限来自插件配置 <code>max_candidates</code>）；数据不完整的候选 <b>${counts.incomplete}</b> 条`
      + `（缺失因子共 ${counts.missing_factors} 个，缺失因子**不计分也不当成 0**）；`
      + `取不到任何因子的候选 <b>${counts.excluded_invalid}</b> 条（不进排名）；`
      + `完全相同的候选去重 <b>${counts.duplicates ?? 0}</b> 条；`
      + `带私域键、整行跳过的行 <b>${counts.skipped_private}</b> 条（跳过就要说出来，不悄悄少候选）；`
      + `行项目 <b>${counts.items}</b> 个（归一基数：<code>${esc(payload.baseline)}</code> —— `
      + `<code>per-item</code> 表示**同一行项目内的候选才互相比较**，不同行项目的单价不可比）。</p>`
      + (payload.degraded ? degradedText
        : (rows ? `<table data-heuristics="rows">${header}${rows}</table>`
          : `<p class="empty" data-empty="1" data-empty-reason="no-rows">本次没有可排名的候选：`
            + (counts.zero_weight > 0
              ? `本次权重只落在候选**取不到**的因子上（被这样排除的候选 <b>${counts.zero_weight}</b> 条）`
                + ` —— 换一组权重，或等对方的报价里带上那些字段`
              : '本视角账本里没有可分解为五分量的报价行（不是页面坏了）')
            + `。</p>`))
      + `<p class="applied" data-applied="1">当前已应用：权重 ${esc(JSON.stringify(payload.weights_applied))}；`
      + `得分范围 0–100（越高越前）；贡献点之和 == 得分（绝对容差 ${esc(payload.point_tolerance)}）</p>`
      + `<p><small>分数与贡献点是**无量纲**的（极差归一后的加权份额），页面**不显示别人报价的绝对值、`
      + `也不显示任何差值** —— 名次与份额都不该被用来反推对方的口径或底价。</small></p>`
  }
  /** JSON（机器可读；与页面同参数、同数据、同口径）。 */
  const heuristicsJson = (view, url) => {
    const { payload, counts, notes } = heuristicsRun(view, url)
    return { view, source: 'bid-heuristics（domain 插件：只做算术，不读账本、不写账本）',
      rows: payload.rows, baseline: payload.baseline,
      weights_applied: payload.weights_applied, weights_requested: payload.weights_requested,
      normalized_sum: payload.normalized_sum, normalization: payload.normalization,
      point_tolerance: payload.point_tolerance, counts, truncated: payload.truncated, omitted: payload.omitted,
      degraded: payload.degraded, reason: payload.reason, clamp_notes: notes, factors: payload.factors,
      note: '五个分量的贡献点（无量纲）；极差归一按行项目分组（baseline=per-item 时同项才互相比较）；'
        + '同权重下与 services/compare.py 名次一致；只输出白名单字段（行项目/代号/名次/分数/贡献/缺失/提示），'
        + '不出任何绝对量级与私域键' }
  }

  // ==========================================================================================
  // P0-3 道内子视图：全部只读 GET，交互只用 `<form method=get>` + `<a>`（0 JS / 0 内联事件）。
  // 数据**只**来自现有服务与注入参数（本视角账本投影 / approval-digest / evidence-summary），
  // 宿主不重算任何业务口径。筛选/排序/翻页必须**非空转**：同参数不同值 → 结果必须不同。
  // ==========================================================================================

  /** 参数解析 + **夹取**（每一处夹取都进 notes，页面上必须报出来）。 */
  const parseParams = (url) => {
    const notes = []
    const limitRaw = url.searchParams.get('limit')
    let limit = LIMIT_DEFAULT
    if (limitRaw !== null && String(limitRaw).trim() !== '') {
      const value = intOrNull(limitRaw)
      if (value === null || value < 1) notes.push(`limit=${limitRaw} 不是 ≥1 的整数 → 回落默认 ${LIMIT_DEFAULT}`)
      else if (value > LIMIT_MAX) {
        limit = LIMIT_MAX
        notes.push(`limit=${limitRaw} 超过上限 → 夹取到 ${LIMIT_MAX}`)
      } else limit = value
    }
    const sortRaw = url.searchParams.get('sort') ?? url.searchParams.get('order')
    let sort = SORT_DEFAULT
    if (sortRaw !== null && String(sortRaw).trim() !== '') {
      const value = String(sortRaw).trim().toLowerCase()
      if (SORTS.includes(value)) sort = value
      else notes.push(`sort=${sortRaw} 不在 ${SORTS.join('/')} 内 → 回落默认 ${SORT_DEFAULT}`)
    }
    return { limit, sort, notes,
      q: String(url.searchParams.get('q') ?? '').trim(),
      type: String(url.searchParams.get('type') ?? '').trim(),
      pageRaw: url.searchParams.get('page'), offsetRaw: url.searchParams.get('offset') }
  }

  /** 筛选：`q` 命中（类型/摘要/关联号/键）与 `type`（事件类型片段）。空条件 = 不筛（非空转的前提）。 */
  const filterRows = (rows, params) => {
    const needle = params.q.toLowerCase()
    const typeNeedle = params.type.toLowerCase()
    return rows.filter((row) => (needle === '' || row.haystack.toLowerCase().includes(needle))
      && (typeNeedle === '' || String(row.type).toLowerCase().includes(typeNeedle)))
  }

  /** 排序：`desc`（默认，新→旧）/ `asc`（旧→新）按 `order`（账本行 = seq；聚合行 = 源内序号）。 */
  const sortRows = (rows, sort) => {
    const direction = sort === 'asc' ? 1 : -1
    return [...rows].sort((left, right) => (left.order === right.order ? 0 : (left.order < right.order ? -direction : direction)))
  }

  /** 翻页：**同一有序数组切片** → 不重叠、不丢行（夹取后的 page/offset 就是回显的真值）。 */
  const paginate = (rows, params) => {
    const notes = [...params.notes]
    const total = rows.length
    const maxPage = Math.max(1, Math.ceil(total / params.limit))
    let page = PAGE_DEFAULT
    const offsetRaw = params.offsetRaw
    if (offsetRaw !== null && String(offsetRaw).trim() !== '') {
      const value = intOrNull(offsetRaw)
      if (value === null || value < 0) notes.push(`offset=${offsetRaw} 不是 ≥0 的整数 → 回落第 ${PAGE_DEFAULT} 页`)
      else {
        const clamped = Math.min(value, (maxPage - 1) * params.limit)
        if (clamped !== value) notes.push(`offset=${offsetRaw} 超过最后一页起点 → 夹取到 ${clamped}`)
        page = Math.floor(clamped / params.limit) + 1
      }
    } else if (params.pageRaw !== null && String(params.pageRaw).trim() !== '') {
      const value = intOrNull(params.pageRaw)
      if (value === null || value < 1) notes.push(`page=${params.pageRaw} 不是 ≥1 的整数 → 回落第 ${PAGE_DEFAULT} 页`)
      else if (value > maxPage) {
        page = maxPage
        notes.push(`page=${params.pageRaw} 超过总页数 → 夹取到第 ${maxPage} 页`)
      } else page = value
    }
    const offset = (page - 1) * params.limit
    return { page, offset, maxPage, total, slice: rows.slice(offset, offset + params.limit), notes }
  }

  /** 账本行 → 子视图行：只输出**本视角字段白名单**内的字段（投影之外再兜一层，抑制行不出正文）。 */
  const ledgerRowsOf = (view, rows) => {
    const allowed = new Set(rules[view]?.fields ?? [])
    return rows.map((row, index) => {
      const summary = row.suppressed ? `（已抑制：${row.reason}）` : String(row.summary ?? '')
      const values = { seq: row.seq, type: row.type, correlation_id: row.correlation_id, actor: row.actor, ts: row.ts, summary }
      for (const field of Object.keys(values)) if (!allowed.has(field)) values[field] = ''
      return { key: String(row.seq ?? index + 1), type: String(row.type ?? ''),
        order: typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : index + 1, values,
        // 关键词命中的字段面：seq / 类型 / 关联号 / ts / 摘要（缺的**不**留 "undefined" 这种字面量）
        haystack: [row.seq, row.type, row.correlation_id, row.ts, summary]
          .filter((value) => value !== null && value !== undefined && String(value) !== '').join(' ') }
    })
  }

  const LEDGER_COLUMNS = [['seq', 'seq'], ['type', 'type'], ['correlation_id', '关联号'], ['actor', 'actor'],
    ['ts', 'ts'], ['summary', '摘要']]

  /** 子视图数据源：**只读**现有服务/注入参数（不新增口径、不自己算业务数）。 */
  const subSource = (view, sub, publicRows) => {
    if (sub === 'events') {
      return { rows: ledgerRowsOf(view, publicRows), what: '本视角全部事件（公开投影后的行）',
        columns: (rules[view]?.fields ?? []).map((field) => ({ key: field, label: (LEDGER_COLUMNS.find(([k]) => k === field) ?? [field, field])[1] })) }
    }
    if (sub === 'quotes' || sub === 'clarifications') {
      const prefixOf = sub === 'quotes' ? 'quote/' : 'clarification/'
      const picked = publicRows.filter((row) => String(row.type).startsWith(prefixOf))
      return { rows: ledgerRowsOf(view, picked), what: `本视角 ${prefixOf}* 事件（公开投影后的行）`,
        columns: (rules[view]?.fields ?? []).map((field) => ({ key: field, label: (LEDGER_COLUMNS.find(([k]) => k === field) ?? [field, field])[1] })) }
    }
    if (sub === 'approvals') {
      const pending = pendingApprovals(view)
      const digest = approvals.digest(pending)
      const policies = approvals.byPolicy(pending)
      return { rows: digest.by_action.map((item, index) => ({ key: item.action, type: 'approval', order: index + 1,
          values: { action: item.action, count: item.count }, haystack: `${item.action} ${item.count}` })),
        columns: [{ key: 'action', label: '动作' }, { key: 'count', label: '待批数' }],
        what: '人工门待批摘要（approval-digest 聚合：只出 counting 与 id/动作/等待，不出正文）',
        extra: `<h3>聚合口径（approval-digest）</h3><p>入参 <b>${digest.rows}</b> 行 / 计入 <b>${digest.total}</b> 项 /`
          + ` 跳过 <b>${digest.skipped}</b> 行；按等待时长 ${digest.by_age.map((b) => `${b.bucket}=${b.count}`).join(' · ')}；`
          + `策略 ${policies.map((p) => `${p.policy}=${p.count}`).join(' · ') || '—'}；超过 ${digest.limits.stale_hours}h 的 `
          + `<b>${digest.stale}</b> 项</p>`
          + (digest.oldest ? `<p>最久等待：<code>${esc(digest.oldest.id)}</code>（${esc(digest.oldest.action)}，`
            + `${Math.round(digest.oldest.waited_seconds / 3600)} 小时）</p>` : '<p>当前没有可计项的待批（reason=<code>no-pending-approvals</code>）</p>')
          + `<p>JSON：<code>${prefix}/${view}/api/approvals</code></p>` }
    }
    if (sub === 'evidence') {
      const summary = evidence.summarize(publicRows)
      return { rows: summary.by_type.map((item, index) => ({ key: item.type, type: item.type, order: index + 1,
          values: { type: item.type, count: item.count }, haystack: `${item.type} ${item.count}` })),
        columns: [{ key: 'type', label: '事件类型' }, { key: 'count', label: '行数' }],
        what: '账本证据面（evidence-summary 聚合；输入 = 本视角公开投影后的行）',
        extra: `<h3>证据面聚合</h3><p>共 <b>${summary.rows}</b> 行 / <b>${summary.types}</b> 种类型 / `
          + `<b>${summary.correlations}</b> 个关联 / <b>${summary.rows_with_refs}</b> 行带引用；时间跨度 `
          + `<code>${esc(summary.span.first ?? '—')} → ${esc(summary.span.last ?? '—')}</code></p>`
          + `<p>JSON：<code>${prefix}/${view}/api/evidence</code></p>` }
    }
    return { rows: [], columns: [], what: '（未登记的子视图）' }
  }

  const tableOf = (rows, columns) => `<table data-rows="${rows.length}"><tr>`
    + columns.map((column) => `<th>${esc(column.label)}</th>`).join('') + '</tr>'
    + rows.map((row) => `<tr data-row="${esc(row.key)}">`
      + columns.map((column) => `<td>${esc(row.values[column.key] ?? '')}</td>`).join('') + '</tr>').join('')
    + '</table>'

  /** 空结果必须**显式说明**："筛选无结果" 与 "本视图暂无数据" 是两件事，都不许看起来像坏页面。 */
  const emptyHtml = (view, sub, params, sourceTotal) => {
    const filtered = params.q !== '' || params.type !== ''
    const reason = filtered ? 'no-match' : 'no-rows'
    const text = filtered
      ? `筛选无结果：当前条件（q=${params.q || '-'} / type=${params.type || '-'}）在 ${sourceTotal} 行数据里命中 0 行 ——`
        + `这是筛选结果，不是页面坏了`
      : `本子视图暂无数据：${sourceTotal} 行数据源里没有该类型的事件 —— 不是页面坏了`
    return `<p class="empty" data-empty="1" data-empty-reason="${reason}">${esc(text)}。`
      + `<a href="${prefix}/${view}/${sub}/">清除筛选</a></p>`
  }

  /** 子视图页面（P0-3）：顶部道内子导航 + GET 筛选表单 + 表 + 底部 applied 回显（含夹取说明）。 */
  const subviewPage = (view, sub, url) => {
    const publicRows = rowsFor(view)
    const source = subSource(view, sub, publicRows)
    const params = parseParams(url)
    const page = paginate(sortRows(filterRows(source.rows, params), params.sort), params)
    const applied = `limit=${params.limit} offset=${page.offset} page=${page.page} sort=${params.sort} `
      + `q=${params.q === '' ? '-' : esc(params.q)} type=${params.type === '' ? '-' : esc(params.type)} `
      + `命中=${page.slice.length} 过滤后=${page.total} 数据源=${source.rows.length} 总页数=${page.maxPage}`
    const form = `<form method="get" action="${prefix}/${view}/${sub}/">`
      + `<label>关键词 <input name="q" value="${esc(params.q)}" size="14"></label> `
      + `<label>类型 <input name="type" value="${esc(params.type)}" size="10" placeholder="如 quote/"></label> `
      + `<label>排序 <select name="sort">${SORTS.map((item) => `<option value="${item}"${item === params.sort ? ' selected' : ''}>${item}</option>`).join('')}</select></label> `
      + `<label>每页 <select name="limit">${LIMIT_CHOICES.map((item) => `<option value="${item}"${item === params.limit ? ' selected' : ''}>${item}</option>`).join('')}</select></label> `
      + `<label>页 <input name="page" value="${page.page}" size="3"></label> `
      + `<button type="submit">应用筛选</button></form>`
    return html(`${config.page_title} · ${rules[view].title} · ${SUB_TITLE[sub] ?? sub}`,
      subNav(prefix, view, sub)
      + `<p><a href="${prefix}/${view}/">← 回 ${rules[view].title}</a> · `
      + `<a href="${prefix}/${view}/${sub}/?limit=${LIMIT_MAX}&page=1">一次看 ${LIMIT_MAX} 行</a> · `
      + `<a href="${prefix}/${view}/${sub}/">清除筛选/排序/翻页</a></p>`
      + `<p>数据来源：${source.what}。本页**只读**：不发写请求、不写账本、无脚本。</p>`
      + form
      + (page.slice.length ? tableOf(page.slice, source.columns) : emptyHtml(view, sub, params, source.rows.length))
      + (source.extra ?? '')
      + `<p class="applied" data-applied="1">当前筛选已应用：${applied}</p>`
      + (page.notes.length
        ? `<ul class="clamp" data-clamp="${page.notes.length}">${page.notes.map((note) => `<li>夹取：${esc(note)}</li>`).join('')}</ul>`
        : `<p class="clamp" data-clamp="0">夹取：无（本次请求的参数都在允许范围内）</p>`), prefix)
  }
  /**
   * 视角首页（P0-2 重排）：第一屏**固定三块**
   *   `data-block="pending-approvals"` → 今天要处理的（待批事项）+ 筛选/下钻表单
   *   `data-block="in-progress"`       → 进行中（最新 RFQ / 报价数 / 比价 / 偏差标记 / 价格组）+ 表单
   *   `data-block="health"`            → 异常与健康（证据面 / 链自洽 / 被抑制行 / 快照新鲜度）+ 表单
   * 其余细节（记分卡 / 谈判 / FAQ / 价格表 / 原始事件 / 提权表单）下沉 `<details>`：
   * 展开才占屏，但**既有标记与提权入口一个不少**（FR-ADMIN-002）。
   * 每块里"能做的动作"必须是**表单/链接**（筛选、翻页、跳子视图），不是一句说明文字。
   */
  const viewPageHtml = (view) => {
    const rows = rowsFor(view)
    const suppressed = rows.filter((row) => row.suppressed).length
    let report = { ok: false, count: rows.length }
    try { report = ledgerOf(view).verify() } catch (err) { report = { ok: false, count: rows.length, reason: String(err).slice(0, 80) } }
    const summary = evidence.summarize(rows)
    const pending = pendingApprovals(view)
    const digest = approvals.digest(pending)
    const oldest = approvals.oldest(pending)
    const scores = scorecard.bySupplier(ledgerOf(view).rows())
    const flags = scores.reduce((sum, item) => sum + (typeof item.deviation_count === 'number' ? item.deviation_count : 0), 0)
    const series = seriesView(view)
    const medians = series.map((item) => item.median).filter((value) => typeof value === 'number')
    const payload = pipelinePayload() || {}
    const slice = (payload.views || {})[view] || {}
    const neg = slice.negotiate || {}
    const faq = slice.faq || {}
    const reversed = [...rows].reverse()
    const lastOf = (type) => reversed.find((row) => String(row.type).startsWith(type)) ?? null
    const lastRfq = lastOf('rfq/')
    const lastCompare = lastOf('compare/')
    const lastRow = rows.length ? rows[rows.length - 1] : null
    const quoteCount = rows.filter((row) => String(row.type).startsWith('quote/')).length
    const sortForm = (target, label) => `<form method="get" action="${prefix}/${view}/${target}/">`
      + `<label>关键词 <input name="q" size="12"></label> `
      + `<label>排序 <select name="sort"><option value="desc" selected>新→旧</option><option value="asc">旧→新</option></select></label> `
      + `<label>每页 <select name="limit"><option value="20" selected>20</option><option value="50">50</option><option value="200">200</option></select></label> `
      + `<button type="submit">${label}</button></form>`

    const pendingBlock = `<section data-block="pending-approvals">
<h2>待批事项（人工门）· 待我处理</h2>
<p>由 subagent 产出、经自进化流程晋升的插件 <code>approval-digest</code> 归纳：共 <b>${digest.total}</b> 项待批；
按等待时长 ${digest.by_age.map((bucket) => `${bucket.bucket}=${bucket.count}`).join(' · ')}；
超过 ${digest.limits.stale_hours}h 的 <b>${digest.stale}</b> 项</p>
${oldest ? `<p>最久等待：<code>${esc(oldest.id)}</code>（${esc(oldest.action)}，${Math.round(oldest.waited_seconds / 3600)} 小时）</p>`
    : '<p>当前没有待批事项（reason=<code>no-pending-approvals</code>）—— 不是空表，是队列真的空了。</p>'}
${sortForm('approvals', '看待批')}
<p><a href="${prefix}/${view}/approvals/">全部待批（可筛选/翻页）→</a> ·
<a href="${prefix}/${view}/approvals/?limit=200&amp;page=1">一次看 200 行 →</a> ·
<a href="${prefix}/admin/">系统管理（提权后可达）</a></p>
</section>`

    const inProgressBlock = `<section data-block="in-progress">
<h2>进行中</h2>
<p>最新 RFQ 包：${lastRfq ? `<code>seq ${esc(lastRfq.seq)}</code> ${esc(lastRfq.summary || lastRfq.type)}` : '—（本视角暂无 RFQ 事件）'}</p>
<p>报价 <b>${quoteCount}</b> 条 · 比价评估 ${lastCompare
      ? `<code>seq ${esc(lastCompare.seq)}（${esc(lastCompare.type)}）</code>` : '—（本视角不可见 compare/*）'}
· 偏差标记 <b>${flags}</b> 个 · 价格序列 <b>${series.length}</b> 组${medians.length
      ? `（跨组中位 ${Math.min(...medians)}–${Math.max(...medians)}，来自 price-history）` : ''}</p>
${sortForm('quotes', '看报价')}
<p><a href="${prefix}/${view}/quotes/">报价与行项目 →</a> ·
<a href="${prefix}/${view}/events/?type=quote/">只看 quote/* 事件 →</a></p>
</section>`

    const healthBlock = `<section data-block="health">
<h2>异常与健康 · 账本证据面</h2>
<p>由自进化产出的插件 <code>evidence-summary</code> 计算：共 <b>${summary.rows}</b> 行 / <b>${summary.types}</b> 种类型 /
<b>${summary.correlations}</b> 个关联 / <b>${summary.rows_with_refs}</b> 行带引用；时间跨度
<code>${esc(summary.span.first ?? '—')}</code> → <code>${esc(summary.span.last ?? '—')}</code>；
链自洽 <b>${report.ok}</b>（${report.count} 条）</p>
<p>最后事件：${lastRow ? `<code>seq ${esc(lastRow.seq)} ${esc(lastRow.type)}</code>` : '—'} ·
本视角被抑制行 <b>${suppressed}</b> 行 · 快照声明的生成时间
<code>${esc(payload.generated_at ?? '缺失（degraded）')}</code>（快照由 Python 侧写、宿主只读；宿主不读墙钟）</p>
${sortForm('events', '筛查事件')}
<p><a href="${prefix}/${view}/events/">原始事件 →</a> ·
<a href="${prefix}/${view}/evidence/?limit=200&amp;page=1">证据面与类型分布 →</a> ·
<a href="${prefix}/api/status">/api/status</a> · <a href="${prefix}/ops/">运维视角</a></p>
</section>`

    const scoreHtml = `<details><summary>供应商绩效记分卡（折叠）</summary>`
      + (scores.length
        ? `<h3>供应商绩效记分卡</h3><p>由 subagent 产出、经自进化流程晋升的插件 <code>supplier-scorecard</code> 计算</p>`
          + `<table><tr><th>供应商</th><th>报价次数</th><th>最低</th><th>中位</th><th>最高</th><th>平均交期(天)</th><th>偏差标记</th></tr>${
            scores.map((item) => `<tr><td>${esc(item.supplier_id)}</td><td>${esc(item.quote_count)}</td><td>${esc(item.min_unit_price)}</td>`
              + `<td>${esc(item.median_unit_price)}</td><td>${esc(item.max_unit_price)}</td><td>${esc(item.avg_lead_time_days)}</td>`
              + `<td>${esc(item.deviation_count)}</td></tr>`).join('')}</table>`
        : '<h3>供应商绩效记分卡</h3><p>（本视角暂无可聚合的供应商行）</p>')
      + `</details>`

    const domainHtml = `<details><summary>谈判轮次与 FAQ（折叠）</summary>`
      + `<h3>谈判轮次（本视角）</h3><p>线程 <b>${neg.threads ?? 0}</b> / 轮次 <b>${neg.rounds ?? 0}</b> / 被拒 <b>${neg.rejected ?? 0}</b></p>`
      + `<p>最近：<code>${esc((neg.recent || []).map((item) => `${item.thread_id}#${item.attempt_no}(${item.status ?? '—'})`).join(' · ') || '—')}</code></p>`
      + `<h3>FAQ（本视角）</h3><p>条目 <b>${faq.entries ?? 0}</b>（版本 ${esc((faq.revs || []).join('、') || '—')}）</p>`
      + `<p>最近：<code>${esc((faq.recent || []).map((item) => `${item.entry_id}@rev${item.rfq_rev}`).join(' · ') || '—')}</code></p>`
      + `<p>JSON：<code>${prefix}/${view}/api/negotiation</code> · <code>${prefix}/${view}/api/faq</code></p></details>`

    const priceHtml = `<details><summary>价格序列（按行项目，折叠）</summary><h3>价格序列（按行项目）</h3>`
      + `<p>由自进化产出的插件 <code>price-history</code> 计算</p>`
      + (series.length
        ? `<table><tr><th>行项目</th><th>次数</th><th>最低</th><th>中位</th><th>最高</th><th>最新</th><th>趋势</th></tr>${
          series.map((item) => `<tr><td>${esc(item.group)}</td><td>${esc(item.count)}</td><td>${esc(item.min)}</td>`
            + `<td>${esc(item.median)}</td><td>${esc(item.max)}</td><td>${esc(item.latest)}</td><td>${esc(item.trend)}</td></tr>`).join('')}</table>`
        : '<p>（本视角账本里暂无可比价格行）</p>')
      + `</details>`

    const rawHtml = `<details><summary>最近事件（原始表，最多 40 行，折叠）</summary><h3>最近事件</h3>`
      + `<table><tr><th>seq</th><th>type</th><th>摘要</th><th>ts</th></tr>${
        rows.slice(-40).reverse().map((row) => row.suppressed
          ? `<tr><td>${esc(row.seq)}</td><td>${esc(row.type)}</td><td>（已抑制：${esc(row.reason)}）</td><td></td></tr>`
          : `<tr><td>${esc(row.seq)}</td><td>${esc(row.type)}</td><td>${esc(row.summary || '')}</td><td>${esc(row.ts || '')}</td></tr>`).join('')}</table>`
      + `<p><a href="${prefix}/${view}/events/">带筛选/翻页的事件子视图 →</a></p></details>`

    const elevateHtml = `<details><summary>系统管理提权（业务用户无需使用；入口保留）</summary>
<h3>管理员提权</h3>
<form method="post" action="${prefix}/admin/api/elevate">
<label>管理员 token（提权为系统管理）：<input name="token" type="password" autocomplete="off"></label>
<button type="submit">提权</button></form>
<p>token 只经当次请求体提交、不回显；cookie 只对 <code>${prefix}/admin/**</code> 生效。token 放哪里见
<a href="${prefix}/start/">上手页</a>。</p></details>`

    return html(`${config.page_title} · ${rules[view].title}`,
      subNav(prefix, view, null)
      + `<p>本视角只显示 <code>${(rules[view].types ?? []).join(' ')}</code> 的事件；`
      + `供应商视角显式拒收私域键 <code>${rules.supplier.privateKeys.join(' ')}</code>。</p>`
      + `<p>JSON：<code>${prefix}/${view}/api/events</code> · <code>${prefix}/${view}/api/history</code> · <code>${prefix}/${view}/api/evidence</code></p>`
      + pendingBlock + inProgressBlock + healthBlock
      + scoreHtml + domainHtml + priceHtml + rawHtml + elevateHtml, prefix)
  }
  // ==========================================================================================
  // 配置与凭据（P0 配置/凭据 UI 化）：**数据与判定在 `host/modules/config-view.mjs` 与 Python 侧
  // `tools/config-apply.py`**；本文件只做路由与 HTML 渲染。
  //   · 零 `<script>`、零内联事件：读 = `<form method=get>` + `<a>`，写 = `<form method=post>`；
  //   · 凭据永不回显：页面/JSON 里都没有"值"字段；提交控件是 `type=password` 且**没有 `value` 属性**；
  //   · 宿主只落 0600 待处理项（真落盘由 Python 侧做）：所以页面必须写清"提交 ≠ 生效"。
  // ==========================================================================================
  /** 表单值 → 标量（页面只能用字符串提交；强转规则写死在页面说明里，**权威判定仍在 Python 侧**）。 */
  const coerceScalar = (raw) => {
    const text = String(raw ?? '').trim()
    if (text === 'true') return true
    if (text === 'false') return false
    if (/^-?\d+$/.test(text)) return Number(text)
    if (/^-?\d*\.\d+$/.test(text)) return Number(text)
    return text
  }
  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  /** 表单 / JSON 两种提交形状 → 一个 patch（JSON 是**带类型**的机器接口；表单是人工入口）。
   *  `opts.layerHint/targetHint`：路由已经知道层与目标（`/credentials/<name>`、`/plugins/<ns>/<plugin>`）时用它们，
   *  免得让调用方再在 body 里重复一遍（JSON 型 body 缺 target 时按 hint 补上）。 */
  const patchOf = (body, contentType, opts = {}) => {
    const { layerHint = null, targetHint = null } = opts
    if (String(contentType ?? '').includes('json')) {
      try {
        const parsed = JSON.parse(String(body || '{}'))
        if (!isPlainObject(parsed)) return null
        if (targetHint) {
          parsed.target = targetHint
          parsed.layer = parsed.layer ?? layerHint ?? 'plugin'
        }
        return parsed
      } catch (err) { return null }
    }
    const form = new URLSearchParams(String(body ?? ''))
    const layer = layerHint ?? String(form.get('layer') ?? 'project')
    if (layer === 'credential') {
      return { layer, target: targetHint ?? String(form.get('name') ?? ''),
        fields: { value: String(form.get('value') ?? '') } }
    }
    if (layer === 'plugin') {
      const target = targetHint ?? `${String(form.get('ns') ?? '').trim()}/${String(form.get('plugin') ?? '').trim()}`
      const field = String(form.get('field') ?? '').trim()
      return { layer: 'plugin', target, fields: field === '' ? {} : { [field]: coerceScalar(form.get('value')) } }
    }
    const key = String(form.get('key') ?? '').trim()
    const humanRef = String(form.get('human_approval_ref') ?? '').trim()
    return { layer: 'project', target: 'project', fields: key === '' ? {} : { [key]: coerceScalar(form.get('value')) },
      ...(humanRef === '' ? {} : { human_approval_ref: humanRef }) }
  }
  /** 配置与凭据一屏（三层总览 + 凭据状态 + 审计 + 干跑/提交表单；**只读渲染，不含任何凭据值**）。 */
  const configPageHtml = () => {
    const data = configView.overview()
    const creds = configView.credentials()
    const audit = configView.audit()
    const keyRows = (data.project || []).map((row) => `<tr data-key="${esc(row.key)}"><td><code>${esc(row.key)}</code></td>`
      + `<td>${esc(row.value === null || row.value === undefined ? '—' : String(row.value))}</td>`
      + `<td>${esc(row.layer)}</td><td><b>${esc(row.source)}</b></td>`
      + `<td>${esc(row.shadowed_by ?? '—')}</td><td>${esc(row.sources.join('+'))}</td>`
      + `<td>${row.frozen ? '冻结（永拒）' : (row.human_only ? '人工专属（需 ap-NNNN）' : (row.editable ? '可改' : '只读'))}</td>`
      + `<td>${esc(row.type)}</td></tr>`).join('')
    const pluginRows = (data.plugin || []).flatMap((row) => row.keys.map((item) => `<tr data-plugin="${esc(row.target)}">`
      + `<td><code>${esc(row.target)}</code></td><td><code>${esc(item.key)}</code></td>`
      + `<td>${esc(item.value === null || item.value === undefined ? '—' : String(item.value))}</td>`
      + `<td>${esc(item.source)}</td><td>${esc(item.shadowed_by ?? '—')}</td></tr>`)).join('')
    const editableKeys = (data.project || []).filter((row) => row.editable).map((row) => row.key)
    const humanKeys = (data.project || []).filter((row) => row.human_only && !row.frozen).map((row) => row.key)
    // 干跑的键下拉 = **可编辑键 ∪ 人工专属键**（后者本来就靠同一表单里的「人工引用」字段放行；
    // 只列可编辑键会让"人工专属但确实要改"的键（如 mail.smtp.host）在这张表单里选不到 —— 那不是纪律，是漏项）。
    const selectableKeys = Array.from(new Set([...editableKeys, ...humanKeys]))
    const credRows = (creds.rows || []).map((row) => `<tr data-credential="${esc(row.name)}">`
      + `<td><code>${esc(row.name)}</code></td><td><b>${row.configured ? '已配置' : '未配置'}</b></td>`
      + `<td>${esc(row.source)}</td><td>${esc(row.required_mode)}</td>`
      + `<td>${esc(row.fingerprint_first8 ?? '—')}</td><td>${esc(row.env || '—')}</td>`
      + `<td>${esc(row.file || '—')}${row.file_mode ? `（${esc(row.file_mode)}）` : ''}</td>`
      + `<td>${esc(row.next_action)}</td>`
      + `<td><form method="post" action="${prefix}/admin/api/credentials/${encodeURIComponent(row.name)}">`
      + `<input type="password" name="value" autocomplete="off" placeholder="只写不回显" size="12">`
      + `<button type="submit">提交</button></form></td></tr>`).join('')
    const auditRows = (audit.rows || []).map((row) => `<tr data-audit="${esc(row.seq)}"><td>${esc(row.seq)}</td>`
      + `<td><code>${esc(row.type)}</code></td><td>${esc(row.ts ?? '')}</td><td>${esc(row.actor ?? '')}</td>`
      + `<td>${esc(row.layer ?? '')}</td><td><code>${esc(row.target ?? '')}</code></td>`
      + `<td><code>${esc(row.key_path ?? '')}</code></td>`
      + `<td>${esc(String(row.old_digest ?? '—').slice(0, 18))}</td><td>${esc(String(row.new_digest ?? '—').slice(0, 18))}</td>`
      + `<td>${esc(row.approval_ref ?? '—')}</td><td>${esc(row.fingerprint_first8 ?? '—')}</td></tr>`).join('')
    const degraded = data.degraded || creds.snapshot.available === false
    return anchorNav('admin', `${prefix}/admin/`, ADMIN_SECTIONS)
      + `<p><a href="${prefix}/admin/">← 回系统管理</a> · <a href="${prefix}/start/">上手（token/配置放哪里？）</a> · `
      + `JSON：<code>${prefix}/admin/api/config</code> · <code>${prefix}/admin/api/credentials</code> · `
      + `<code>${prefix}/admin/api/config/audit</code></p>`
      + (degraded ? `<p class="degraded" data-degraded="1">降级（**不冒充健康**）：配置层 <code>${esc(data.reason || '—')}</code>；`
        + `凭据状态快照 <code>${esc(creds.snapshot.reason || '—')}</code> → ${esc(data.next_action || creds.snapshot.next_action)}</p>` : '')
      + `<h3 id="config">① 三层配置总览（项目 / 插件 / 凭据）</h3>`
      + `<p>受管配置文件：<code>${esc(data.config_file)}</code>（宿主**只读**，真落盘由 Python 侧 <code>tools/config-apply.py</code> 做）。`
      + `每键给 <code>source</code>（default / file / env / runtime）与 <code>shadowed_by</code>（被本行压住的层）。`
      + `凭据行**永不显示值**：只有"已配置/未配置 + 来源 + 必须的权限 + 指纹前 8 位 + 下一步"。</p>`
      + `<p>层顺序（低 → 高）：default → file → env → runtime。运行期覆盖：`
      + `${data.runtime.configured ? esc(data.runtime.keys.join(' ')) : '无（' + esc(data.runtime.reason) + '）'}；`
      + `待处理项：<b>${data.pending.count}</b> 件${data.pending.configured ? '' : `（${esc(data.pending.reason)}）`}。</p>`
      + `<table data-layer="project"><thead><tr><th>键</th><th>值</th><th>层</th><th>source</th><th>shadowed_by</th>`
      + `<th>同现层</th><th>可否改</th><th>类型</th></tr></thead><tbody>${keyRows}</tbody></table>`
      + `<h3 id="plugins">② 插件配置（键 = <code>&lt;ns&gt;/&lt;plugin&gt;</code>）</h3>`
      + (pluginRows ? `<table data-layer="plugin"><thead><tr><th>插件</th><th>字段</th><th>值</th><th>source</th>`
        + `<th>shadowed_by</th></tr></thead><tbody>${pluginRows}</tbody></table>` : '<p>（配置文件里暂无 <code>plugins:</code> 段内容）</p>')
      + `<h3 id="credentials">③ 凭据（只写不回显）</h3>`
      + `<p>任何响应体里凭据值出现次数 = 0；指纹前 8 位来自 Python 侧状态快照（宿主不读凭据值）。`
      + `提交只落一个 0600 待处理项，**由 Python 侧消费后才生效**。</p>`
      + `<table data-layer="credential"><thead><tr><th>名称</th><th>状态</th><th>来源</th><th>必须权限</th>`
      + `<th>指纹前 8</th><th>env</th><th>文件（权限）</th><th>下一步</th><th>提交新值</th></tr></thead>`
      + `<tbody>${credRows}</tbody></table>`
      + `<h3 id="write">④ 改配置 / 干跑（dry-run）与提交</h3>`
      + `<p>表单提交的值按标量强转（<code>true/false</code> → 布尔，整数/小数 → 数字，其余字符串）；`
      + `权威判定在 Python 侧，同一套白名单（<code>host/lib/schema.mjs</code> + <code>host/lib/config-keys.mjs</code>）。</p>`
      + `<form method="post" action="${prefix}/admin/api/config/preview"><b>干跑（零落盘零生效）</b>：`
      + `<label>键 <select name="key">${selectableKeys.map((key) => `<option value="${esc(key)}">${esc(key)}</option>`).join('')}</select></label> `
      + `<label>值 <input name="value" size="14"></label> `
      + `<label>人工引用（人工专属键用） <select name="human_approval_ref"><option value="">（无）</option>`
      + `${humanKeys.map((key) => `<option value="ap-0000">ap-0000 / ${esc(key)}</option>`).join('')}</select></label> `
      + `<button type="submit">干跑</button></form>`
      + `<form method="post" action="${prefix}/admin/api/config/project"><b>提交项目配置</b>（只落 0600 待处理项）：`
      + `<label>键 <input name="key" size="28" placeholder="pricing.markup_pct"></label> `
      + `<label>值 <input name="value" size="14"></label> `
      + `<label>人工引用 <input name="human_approval_ref" size="10" placeholder="ap-NNNN（人工专属键必填）"></label> `
      + `<button type="submit">提交</button></form>`
      + `<form method="post" action="${prefix}/admin/api/config/plugins"><b>提交插件配置</b>：`
      + `<label>ns <input name="ns" size="10"></label> <label>plugin <input name="plugin" size="12"></label> `
      + `<label>字段 <input name="field" size="14"></label> <label>值 <input name="value" size="12"></label> `
      + `<button type="submit">提交</button></form>`
      + `<h3 id="semantics">⑤ 改完怎么生效（别等踩坑）</h3>`
      + `<p>项目配置 = 同进程 cordis 配置（热加载会**重启该插件 fiber**：接受即重置该模块的运行期状态）；`
      + `插件配置 = **重载**实例（新 uid，草稿丢失）；凭据 = 落 0600 文件后触发 re-apply（env 供给的只能重起进程）。</p>`
      + `<h3 id="audit">⑥ 变更审计（只读；来源：Python 侧账本）</h3>`
      + (audit.degraded ? `<p>降级：<code>${esc(audit.reason)}</code> → ${esc(audit.next_action)}</p>`
        : `<p>共 <b>${audit.total}</b> 行（显示 ${audit.rows.length} 行，省略 ${audit.omitted}）；`
          + `账本行**不含值**（只有键名与新旧摘要）；被拒的变更各 1 行 <code>config/refused</code>。</p>`
          + `<table data-layer="audit"><thead><tr><th>seq</th><th>类型</th><th>ts</th><th>actor</th><th>层</th>`
          + `<th>target</th><th>键路径</th><th>旧摘要</th><th>新摘要</th><th>人工引用</th><th>指纹前 8</th>`
          + `</tr></thead><tbody>${auditRows}</tbody></table>`)
      + `<p><small>本页 **0 行 <code>&lt;script&gt;</code>、0 内联事件**：读用 GET 表单/链接，写用 POST 表单；`
      + `宿主不写文件（除 0600 待处理项）、不写账本、不取墙钟。</small></p>`
  }
  const handle = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname
    const send = (code, type, payload, extraHeaders = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extraHeaders })
      res.end(decorateHtml(type, payload))
    }
    /**
     * HTML 装饰（`ui-feedback` 插件，服务端可判、**不靠 JS**）：
     * 每页 `<html>` 上写 `data-ui-revision="rN"`；当**最新已应用版本 > 本视图的版本**时，
     * 在页面顶部插 `data-ui-stale="true"` 横幅（"已更新到 rM，请刷新页面" + `<form method=get>` 的
     * "我已刷新"，带上 `?seen=rM` → 横幅消失）。版本号只来自落盘事实（插件里读 `versions.json`）。
     * 装饰失败**不得**让页面崩：记一行 stderr，原样返回。
     */
    const decorateHtml = (type, payload) => {
      if (typeof payload !== 'string' || !String(type).startsWith('text/html')) return payload
      if (!payload.includes('<html lang="zh">')) return payload
      try {
        const deco = feedback.decorate(path, url.searchParams.get('seen') ?? '')
        const out = payload.replace('<html lang="zh">',
          `<html lang="zh" data-ui-revision="${esc(deco.revision)}" data-ui-view="${esc(deco.scope)}">`)
        return deco.stale ? out.replace('<body>', `<body>${deco.banner}`) : out
      } catch (err) {
        console.error(`[webui] ui-feedback 装饰失败（页面原样返回）：${String(err).slice(0, 120)}`)
        return payload
      }
    }
    /** 反馈提交的读体：**有界**（超上界如实拒，不截断成另一份正文）。 */
    const readFeedbackBody = (done) => {
      let data = ''
      let over = false
      req.on('data', (chunk) => {
        if (data.length + chunk.length > 65536) over = true
        else if (!over) data += chunk
      })
      req.on('end', () => done(over ? null : data))
      req.on('error', () => done(null))
    }
    // 回调式读体（本处理函数不是 async：不引入 await，避免吞掉异常）
    const readBody = (done) => {
      let data = ''
      req.on('data', (chunk) => { if (data.length < 16384) data += chunk })
      req.on('end', () => done(data))
      req.on('error', () => done(''))
    }
    const json = (code, payload) => send(code, 'application/json; charset=utf-8',
      JSON.stringify(payload, null, 2) + '\n')
    /** 配置/凭据提交的回执状态码：受理 202 / 被拒 409 / 未配 inbox 503 / 写失败 500（原因在 next_action 里）。 */
    const configAnswer = (out) => {
      const code = out?.ok ? 202
        : (out?.code === 'inbox-unconfigured' ? 503 : (out?.code === 'inbox-write-failed' ? 500 : 409))
      return json(code, out)
    }

    if (path === '/api/routes') {
      // 路由表（**静态声明**，只列本模块真的在服务的路由；新增路由必须同步这里）
      return json(200, {
        service: 'quotagent-webui', route_prefix: prefix, source: 'host/modules/webui.mjs',
        views: config.views,
        routes: [
          { path: `${prefix}/`, method: 'GET', auth: 'none', what: '总览（各视图健康与账本校验）' },
          { path: `${prefix}/start/`, method: 'GET', auth: 'none', what: '上手：三步 + token/配置/凭据放哪里' },
          ...config.views.map((v) => ({ path: `${prefix}/${v}/`, method: 'GET', auth: 'none', what: `${v} 视角首页` })),
          { path: `${prefix}/api/health`, method: 'GET', auth: 'none', what: '健康' },
          { path: `${prefix}/api/status`, method: 'GET', auth: 'none', what: '状态与账本校验' },
          { path: `${prefix}/api/obs`, method: 'GET', auth: 'none', what: '运行期观测（只读）' },
          // 邮件域（SMTP/IMAP）：页面 + 只读 JSON；数据来自 Python 侧快照（宿主不联网、不发信）
          { path: `${prefix}/ops/mail/`, method: 'GET', auth: 'none', what: '邮件域只读页（队列计数 / 最近一次尝试与 reason / available / next_action；零内联脚本）' },
          { path: `${prefix}/api/mail`, method: 'GET', auth: 'none', what: '邮件域只读 JSON（来源 Python 侧快照；不含凭据值）' },
          // 比价 heuristics（T-279）：双方各自可见、可自己调权重看名次怎么变（页面零内联脚本）
          ...config.views.filter((v) => rules[v]).flatMap((v) => [
            { path: `${prefix}/${v}/heuristics/`, method: 'GET', auth: 'none',
              what: `${v} 道的比价 heuristics 页（权重输入 + 名次 + 每项贡献分解 + 如何提升排名；w_price 等五个参数）` },
            { path: `${prefix}/${v}/api/heuristics`, method: 'GET', auth: 'none',
              what: `${v} 道的比价 heuristics JSON（参数同页面；只出白名单字段，不出绝对量级与私域键）` },
          ]),
          { path: `${prefix}/api/routes`, method: 'GET', auth: 'none', what: '本表' },
          // WebUI 反馈闭环（ui-feedback 插件）：SSR 表单页（**0 内联脚本**）+ 只落 0600 待办件 + 只读观察面
          ...config.views.flatMap((v) => [
            { path: `${prefix}/${v}/feedback`, method: 'GET', auth: 'none',
              what: `${v} 道的反馈页（textarea + POST 提交；每页带 data-ui-revision，落后时顶部出"请刷新"横幅）` },
            { path: `${prefix}/${v}/feedback`, method: 'POST', auth: 'none',
              what: `${v} 反馈提交（**只落 0600 待办件**、账本零新增；202 + 待办件 id + next_action）` },
          ]),
          { path: `${prefix}/ops/ui-feedback/`, method: 'GET', auth: 'none',
            what: '反馈观察面（待处理计数 / 最近一次处理结果与 reason / 各视图版本号 / available / degraded+reason；有界、确定性）' },
          { path: `${prefix}/api/ui-feedback`, method: 'GET', auth: 'none', what: '反馈观察面 JSON（只读；不含反馈正文）' },
          // 道内子视图（P0-3）：只读 GET + `<form method=get>` 筛选/翻页/排序（无脚本）
          ...Object.entries(SUBVIEWS).flatMap(([view, subs]) => subs.map((sub) => ({
            path: `${prefix}/${view}/${sub}/`, method: 'GET', auth: 'none',
            what: `${view} 道的 ${sub} 子视图（limit/page/sort/q/type 参数；夹取后回显 applied）`,
          }))),
          { path: `${prefix}/admin/api/session`, method: 'GET', auth: 'admin-session', what: '会话探测' },
          { path: `${prefix}/admin/api/elevate`, method: 'POST', auth: 'token', what: '用管理员 token 换不透明会话（cookie 只对 admin 前缀生效）' },
          { path: `${prefix}/admin/api/blocks`, method: 'GET', auth: 'admin-session', what: '阻塞与进度面板' },
          { path: `${prefix}/admin/api/blocks/<block_id>/resolve`, method: 'POST', auth: 'admin-session', what: '提交解阻塞（只落 0600 待处理项，Python 侧消费）' },
          { path: `${prefix}/admin/api/market`, method: 'GET', auth: 'admin-session', what: '插件市场（只读）' },
          { path: `${prefix}/admin/api/user-plugins`, method: 'GET', auth: 'admin-session', what: '用户空间插件列表' },
          { path: `${prefix}/admin/api/user-plugins/<load|unload|reload>`, method: 'POST', auth: 'admin-session', what: '装载/卸载/重载（命名空间实例）' },
          // 配置与凭据（P0）：页面 + 只读总览 + 干跑（零落盘）+ 只落待处理项 + 审计（只读）
          { path: `${prefix}/admin/config/`, method: 'GET', auth: 'admin-session', what: '配置与凭据一屏（三层 source/shadowed_by + 凭据状态 + 干跑 + 审计）' },
          { path: `${prefix}/admin/api/config`, method: 'GET', auth: 'admin-session', what: '三层配置总览 JSON（项目/插件/凭据；每键 source/shadowed_by/editable）' },
          { path: `${prefix}/admin/api/config/preview`, method: 'POST', auth: 'admin-session', what: '干跑：白名单 + 类型 + 人工门 + diff（零落盘零生效）' },
          { path: `${prefix}/admin/api/config/project`, method: 'POST', auth: 'admin-session', what: '提交项目配置（只落 0600 待处理项；202 + payload_sha256）' },
          { path: `${prefix}/admin/api/config/plugins`, method: 'POST', auth: 'admin-session', what: '提交插件配置（target = <ns>/<plugin>；只落待处理项）' },
          { path: `${prefix}/admin/api/config/audit`, method: 'GET', auth: 'admin-session', what: '配置变更审计（只读；来源 Python 侧账本）' },
          { path: `${prefix}/admin/api/credentials`, method: 'GET', auth: 'admin-session', what: '凭据状态（configured/source/required_mode/指纹前 8/next_action；**不出值**）' },
          { path: `${prefix}/admin/api/credentials/<name>`, method: 'POST', auth: 'admin-session', what: '提交/轮换凭据（只写不回显：响应只有 ok + next_action）' }],
        write_surface: { browser_writable: [`${prefix}/admin/**`],
          note: '浏览器永远不能签的五个动作：批准 / 提交报价 / 定标 / 发 PO / 变更批准（人工门在终端）' },
      })
    }
    // WebUI 反馈闭环（ui-feedback 插件）：反馈页（GET）/ 提交（POST，只落 0600 待办件、账本零新增）/ 观察面（只读）
    const feedbackPath = /^\/([A-Za-z0-9-]+)\/feedback\/?$/.exec(path)
    if (feedbackPath && config.views.includes(feedbackPath[1])) {
      const view = feedbackPath[1]
      if (String(req.method) === 'POST') {
        return readFeedbackBody((data) => {
          if (data === null) {
            return json(413, { service: 'ui-feedback', ok: false, code: 'feedback-too-long', view,
              next_action: '请求体超过 65536 字节：宿主**不截断**（截断会合成另一份正文），请把反馈拆小后重提' })
          }
          const form = new URLSearchParams(data)
          const out = feedback.submitFeedback(view, form.get('text') ?? form.get('feedback') ?? '')
          const code = out.ok ? 202 : (out.code === 'pending-write-failed' ? 500
            : (out.code === 'ui-shared-unresolved' ? 503 : 400))
          return json(code, { service: 'ui-feedback', ...out, view })
        })
      }
      return send(200, 'text/html; charset=utf-8', feedback.feedbackPage(view, url.search))
    }
    if (path === '/ops/ui-feedback' || path === '/ops/ui-feedback/') {
      return send(200, 'text/html; charset=utf-8', feedback.opsPage())
    }
    if (path === '/api/ui-feedback') return json(200, feedback.snapshot())
    if (path === '/start' || path === '/start/') {
      // 上手页：**未提权也能看**（只讲机制与命令，不显示任何状态位与凭据值）
      send(200, 'text/html; charset=utf-8',
        '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + '<title>quotagent 上手</title><style>body{font-family:system-ui,sans-serif;margin:1.5rem;max-width:60rem}'
        + 'code,pre{background:#f3f3f3;padding:.1em .3em;border-radius:3px}pre{padding:.6rem;overflow:auto}'
        + 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.35rem .5rem;'
        + 'text-align:left;font-size:13px}nav a{margin-right:1rem}</style></head><body>'
        + `<nav><a href="${prefix}/">总览</a><a href="${prefix}/start/">上手</a>`
        + `<a href="${prefix}/contractor/">承包商视角</a><a href="${prefix}/supplier/">供应商视角</a>`
        + `<a href="${prefix}/ops/">运维视角</a>`
        + `<a href="${prefix}/admin/">系统管理</a></nav>`
        + '<h1>quotagent 上手</h1>' + onboardingHtml(prefix, config.views) + '</body></html>')
    }
    if (path === '/api/health') return json(200, { status: 'ok', service: 'quotagent-webui' })
    if (path === '/api/obs') {
      // 运行期观测（只读）：governor 准入 / audit 留痕 / canary 分流——双方视角都可见（不含私域）
      const snap = obs.snapshot()
      return json(200, { service: 'quotagent-webui', observability: snap, summary: obs.summary() })
    }
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
    if (path === '/ops/' || path === '/ops') {
      // 运维视角：不属于任何一方（业务视角各读自己的账本；运维看的是"系统整体"）
      const runtime = ops.snapshot({ rows: [] })
      const perView = Object.fromEntries(config.views.filter((view) => rules[view])
        .map((view) => [view, ops.snapshot({ rows: rowsFor(view) }).evidence]))
      const rowsHtml = config.views.filter((view) => rules[view]).map((view) => {
        const ev = perView[view]
        return `<tr><td>${view}</td><td>${ev.rows}</td><td>${ev.types}</td><td>${ev.correlations}</td>`
          + `<td>${ev.rows_with_refs}</td><td>${ev.span.first ?? '—'} → ${ev.span.last ?? '—'}</td></tr>`
      }).join('')
      const g = runtime.runtime.governor
      const b = runtime.breaker.stats
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · 运维视角`,
          `<p>本视角**不属于任何一方**：只看系统整体（运行期中间件状态 + 各视角账本的证据面聚合），不显示条目正文与私域键。</p>`
          + anchorNav('ops', `${prefix}/ops/`, OPS_SECTIONS,
            [[`${prefix}/contractor/heuristics/`, '比价口径（承包商）'], [`${prefix}/supplier/heuristics/`, '比价口径（供应商）']])
          + `<p>JSON：<code>${prefix}/api/ops</code></p>`
          + `<h3 id="runtime">运行期</h3><p>${ops.summary({ rows: [] })}</p>`
          + `<table><tr><th>governor</th><th>breaker</th></tr>`
          + `<tr><td>admitted=${g.admitted ?? 0} refused=${g.refused ?? 0} timeouts=${g.timeouts ?? 0} failed=${g.failed ?? 0}</td>`
          + `<td>allowed=${b.allowed ?? 0} refused=${b.refused ?? 0} opened=${b.opened ?? 0} closed=${b.closed ?? 0}</td></tr></table>`
          + `<h3 id="pipeline">三域流水（谈判 / FAQ / 邮件）</h3><p>由 subagent 产出并晋升的插件 <code>pipeline-view</code> 聚合：<b>${pipeline.headline(pipelinePayload())}</b></p>`
          + `<p><a href="${prefix}/ops/mail/">邮件域（SMTP/IMAP）专页</a>：队列计数 / 最近一次真尝试的结果与 reason / `
          + `available / next_action（数据来自 Python 侧快照；宿主只读，不联网不发信）。</p>`
          + `<p>邮件（运输通道聚合）：运输通道 <b>${(pipeline.snapshot(pipelinePayload()).transport || {}).available ? '可用' : '不可用'}</b>`
          + `——由 <code>pipeline-view</code> 从三域快照的通道声明归并；**未配置凭据时必须报不可用**（配置后由 <code>services/mail_transport</code> 的真实状态派生）</p>`
          + `<h3 id="retention">留存计划（只读）</h3><p>判定在 Python 侧（<code>services/retention.py</code>），由 subagent 产出并晋升的插件 <code>retention-view</code> 聚合：<b>${retention.headline(retentionPlanOf('contractor'))}</b></p>`
          + `<p>账本行永不销毁；销毁只作用于派生副本，不可重建物须过人工门（ADR-0018）</p>`
          + `<h3 id="evolve">自进化流水</h3><p>由自进化产出的插件 <code>evolve-journal</code> 归纳（只给计数，不出正文）</p>`
          + (() => {
            const ev = journal.summarize(evolveRows())
            return `<p>提案 <b>${ev.proposed}</b> / 影子 <b>${ev.shadowed}</b> / 门 <b>${ev.gated.passed}</b> 过 `
              + `<b>${ev.gated.rejected}</b> 拒 / 晋升 <b>${ev.promoted}</b> / 回滚 <b>${ev.rolled_back}</b> / `
              + `canary 进 <b>${ev.canary.entered}</b> 出 <b>${ev.canary.exited}</b>；最近 <code>${ev.last_event ?? '—'}</code></p>`
          })()
          + `<h3 id="evidence">各视角账本证据面（聚合）</h3>`
          + `<table><tr><th>视角</th><th>行数</th><th>类型数</th><th>关联数</th><th>带引用行</th><th>时间跨度</th></tr>${rowsHtml}</table>`,
          prefix))
    }
    if (path === '/api/ops') {
      const runtime = ops.snapshot({ rows: [] })
      const perView = Object.fromEntries(config.views.filter((view) => rules[view])
        .map((view) => [view, ops.snapshot({ rows: rowsFor(view) }).evidence]))
      return json(200, { view: 'ops', source: 'ops-view（自进化产出的插件）', summary: ops.summary({ rows: [] }),
        runtime: runtime.runtime, breaker: runtime.breaker, evidence_by_view: perView,
        evolve_journal: journal.summarize(evolveRows()),
        retention: retention.snapshot(retentionPlanOf('contractor')),
        retention_headline: retention.headline(retentionPlanOf('contractor')),
        note: '运维视角：不属于任何一方；只给聚合数字与状态，不给条目正文/私域键' })
    }
    const viewMatch = path.match(/^\/([a-z]+)\/?$/)
    if (viewMatch && rules[viewMatch[1]]) {
      // 第一屏三块 + 其余下沉 <details>（细节见 viewPageHtml 的注释）
      return send(200, 'text/html; charset=utf-8', viewPageHtml(viewMatch[1]))
    }
    // 道内子视图（P0-3）：`/<view>/<sub>/`——全部 GET、只读、无脚本；筛选/排序/翻页走查询参数
    const subMatch = path.match(/^\/([a-z]+)\/([a-z-]+)\/?$/)
    if (subMatch && rules[subMatch[1]] && (SUBVIEWS[subMatch[1]] ?? []).includes(subMatch[2])) {
      return send(200, 'text/html; charset=utf-8', subviewPage(subMatch[1], subMatch[2], url))
    }
    const viewEvidence = path.match(/^\/([a-z]+)\/api\/evidence\/?$/)
    if (viewEvidence && rules[viewEvidence[1]]) {
      const view = viewEvidence[1]
      // 证据面只统计**公开投影后的行**（type/ts/correlation_id/refs 都在白名单内），不出正文
      const summary = evidence.summarize(rowsFor(view))
      return json(200, { view, source: 'evidence-summary（自进化产出的插件）', summary,
        note: '账本证据面：按类型计数 / 关联数 / 带引用行数 / 时间跨度；只统计公开投影后的行' })
    }
    const viewDomain = path.match(/^\/([a-z]+)\/api\/(negotiation|faq)\/?$/)
    if (viewDomain && rules[viewDomain[1]]) {
      const view = viewDomain[1]
      const domain = viewDomain[2]
      const slice = ((pipelinePayload() || {}).views || {})[view] || {}
      // URL 用业务词（negotiation/faq），快照用域键（negotiate/faq）—— 这里显式对照，别靠名字凑巧相同
      const DOMAIN_KEY = { negotiation: 'negotiate', faq: 'faq' }
      const data = slice[DOMAIN_KEY[domain]] || null
      const out = { view, domain, source: '三域快照（Python 侧写，宿主只读；判定在 services/*）',
        degraded: !data, note: '只给计数与最近事件的 id/序号/状态；不出正文与私域键' }
      if (data) {
        out.counts = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'number'))
        // **按键投影**而不是原样透传：即使快照里混进正文/私域键，也不出这条路由
        // （D-033/D-053 的"不出正文与私域"在宿主侧也要成立，不能只靠写入器规矩）
        const RECENT_KEYS = { negotiation: ['thread_id', 'attempt_no', 'status'], faq: ['entry_id', 'rfq_rev'] }[domain]
        out.recent = (Array.isArray(data.recent) ? data.recent : []).slice(0, 5)
          .map((row) => Object.fromEntries(RECENT_KEYS.filter((k) => row && Object.prototype.hasOwnProperty.call(row, k)).map((k) => [k, row[k]])))
      }
      return json(200, out)
    }
    if (/^\/api\/pipeline\/?$/.test(path)) {
      const payload = pipelinePayload()
      const snap = pipeline.snapshot(payload)
      return json(200, { source: 'pipeline-view（subagent 产出、经自进化流程晋升）+ 三域服务（Python 侧写快照）',
        pipeline: snap, headline: pipeline.headline(payload),
        note: '谈判/FAQ/邮件三域只给计数与最近事件 id；**本轮没有发信能力**，故 transport.available 恒为 false' })
    }
    if (/^\/api\/retention\/?$/.test(path)) {
      const plan = retentionPlanOf('contractor') ?? retentionPlanOf('supplier')
      const snap = retention.snapshot(plan)
      return json(200, { source: 'retention-view（subagent 产出、经自进化流程晋升）+ services/retention.py（判定）',
        retention: snap, headline: retention.headline(plan),
        note: '留存计划是**判定**不是执行：账本行永不销毁；销毁只作用于派生副本且不可重建物须过人工门' })
    }
    if (/^\/api\/mail\/?$/.test(path)) {
      // 邮件域只读 JSON：投影由 `mail-view` 插件做（形状门/白名单/夹取/降级都在那里），这里只放行
      const snap = mailSnapshot()
      return json(200, { source: snap.source, mail: snap,
        note: '队列计数与最近一次尝试来自 Python 侧快照（mail_transport 状态文件 + mail/* 账本行）；'
          + '宿主只读文件、不联网、不发信、不写账本，响应里**没有**任何凭据值（快照里也没有）' })
    }
    if (path === '/ops/mail' || path === '/ops/mail/') {
      // 邮件页：**0 行 `<script>`**、0 内联事件（读用链接；改配置在已登记的 /admin/config/ 表单里）
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · 邮件（SMTP / IMAP）`,
          `<nav data-subnav="ops"><a href="${prefix}/ops/">运维首页</a>`
          + `<a href="${prefix}/ops/mail/" aria-current="page">邮件（SMTP/IMAP）</a>`
          + `<a href="${prefix}/api/mail">/api/mail</a></nav>`
          + mailHtml()))
    }
    const viewHeuristics = path.match(/^\/([a-z]+)\/api\/heuristics\/?$/)
    if (viewHeuristics && rules[viewHeuristics[1]]) {
      // 比价 heuristics（只读）：候选与权重进插件，名次与贡献解释出响应；宿主不写任何东西
      return json(200, heuristicsJson(viewHeuristics[1], url))
    }
    const viewHeuristicsPage = path.match(/^\/([a-z]+)\/heuristics\/?$/)
    if (viewHeuristicsPage && rules[viewHeuristicsPage[1]]) {
      // 页面：SSR + `<form method=get>` 调权重（零内联脚本；改权重这件事本身也不产生任何写入）
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · ${rules[viewHeuristicsPage[1]].title} · 比价口径`,
          heuristicsHtml(viewHeuristicsPage[1], url), prefix))
    }
    const viewApprovals = path.match(/^\/([a-z]+)\/api\/approvals\/?$/)
    if (viewApprovals && rules[viewApprovals[1]]) {
      const view = viewApprovals[1]
      const rows = pendingApprovals(view)
      const digest = approvals.digest(rows)
      return json(200, { view, source: 'approval-digest（subagent 产出、经自进化流程晋升）',
        digest, by_policy: approvals.byPolicy(rows), oldest: approvals.oldest(rows),
        note: '当前仍待批的事项摘要（按 approval_id 取最后状态推导）；只给计数与等待时长，不出正文' })
    }
    const viewScore = path.match(/^\/([a-z]+)\/api\/scorecard\/?$/)
    if (viewScore && rules[viewScore[1]]) {
      const view = viewScore[1]
      // 与价格序列同因：投影层只留 seq/type/summary/ts，记分卡要的 supplier_id/单价会被截掉 →
      // 所以喂**原始行**，但只输出聚合（门里断言响应不含正文与私域键）
      const groups = scorecard.bySupplier(ledgerOf(view).rows())
      return json(200, { view, source: 'supplier-scorecard（subagent 产出、经自进化流程晋升）',
        groups: groups.length, scorecard: groups,
        note: '按供应商聚合的绩效面（报价次数/价格分布/交期均值/偏差标记数）；输入只来自本视角的公开投影' })
    }
    const viewHistory = path.match(/^\/([a-z]+)\/api\/history\/?$/)
    if (viewHistory && rules[viewHistory[1]]) {
      const view = viewHistory[1]
      const series = seriesView(view)
      return json(200, { view, source: 'price-history（自进化产出的插件）', groups: series.length,
        series, note: '按行项目聚合的价格序列描述统计；输入只来自本视角的公开投影' })
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
        `<ul>${rows}</ul><ul><li><a href="${prefix}/ops/">运维视角</a>（系统整体：运行期中间件 + 各视角证据面聚合）</li></ul>`
        + '<p>本 UI 由 cordis 插件 <code>webui</code> 提供；每个视角读**自己的**账本，宿主不写账本。</p>', prefix))
    }
    // ---- 系统管理道（admin）：未提权一律**统一拒绝体**（缺 token / 错 token / 未启用 / 会话过期 / 冷却 五类同形） ----
    const deny = () => send(401, 'application/json; charset=utf-8', '{"error":"unauthorized"}')
    const adminHtml = (data) => {
      const rows = (data.blocks || []).map((b) => `<tr><td><code>${b.block_id}</code></td><td>${b.kind}</td>`
        + `<td>${b.reason}</td><td>${b.required_action}</td>`
        + `<td><form method="post" action="${prefix}/admin/api/blocks/${encodeURIComponent(b.block_id)}/resolve">`
        + `<input type="hidden" name="kind" value="${b.kind}">`
        + `<input name="material" type="password" autocomplete="off" placeholder="凭据/材料" size="14">`
        + `<button type="submit">提交</button></form>`
        + `<span class="dim">（提交只落待处理项；落账本要人工批准引用）</span></td></tr>`).join('')
      const switchLinks = Object.keys(rules).map((v) => `<a href="${prefix}/admin/api/switch?to=${v}">${v}</a>`).join(' · ')
      return `${anchorNav('admin', `${prefix}/admin/`, ADMIN_SECTIONS,
        [[`${prefix}/contractor/heuristics/`, '比价口径（承包商）'], [`${prefix}/supplier/heuristics/`, '比价口径（供应商）']])}`
        + `${data.degraded ? `<p>降级：<code>${data.reason ?? ''}</code> —— ${data.next_action ?? ''}</p>` : ''}`
        + `<h3 id="progress">进度与口径来源</h3>`
        + `<p>进度：阶段 <b>${data.progress?.phase ?? '—'}</b> · 下一步 <b>${data.progress?.next_task ?? '—'}</b>`
        + ` · 已完 <b>${data.progress?.done ?? 0}</b> / 待做 <b>${data.progress?.todo ?? 0}</b></p>`
        + `<h3 id="blocks">阻塞清单</h3>`
        + `<p>阻塞 <b>${data.counts?.blocked ?? 0}</b> 条（口径：${data.counts?.source ?? '—'}）</p>`
        + `<table><thead><tr><th>block</th><th>kind</th><th>原因</th><th>需要你做的事</th><th>提交材料</th></tr></thead><tbody>${rows}</tbody></table>`
        + `<p>切换视角：${switchLinks}</p>`
        + (() => { const c = configView.overview(); const cr = configView.credentials()
          return `<h3 id="config">配置与凭据（一屏）</h3>`
            + `<p>受管配置文件 <code>${esc(c.config_file)}</code>：项目键 <b>${c.counts.project}</b> / 插件 <b>${c.counts.plugins}</b>`
            + ` / 凭据 <b>${c.counts.credentials}</b>（已配置 <b>${(cr.rows || []).filter((r) => r.configured).length}</b>）`
            + ` · 待处理项 <b>${c.counts.pending}</b> 件${c.degraded ? ` · <b>降级</b>：${esc(c.reason)}` : ''}</p>`
            + `<p><a href="${prefix}/admin/config/">打开配置与凭据页 →</a>`
            + `（三层 source/shadowed_by、凭据状态与指纹前 8 位、干跑、变更审计；凭据只写不回显）</p>` })()
        + (() => { const u = userPlugins.list(); return `<h3 id="user-plugins">用户空间插件（管理面本身也是插件）</h3>`
            + `<p>命名空间 <b>${(u.namespaces || []).length}</b> 个 · 插件 <b>${u.counts?.plugins ?? 0}</b> · 已装载 <b>${u.counts?.loaded ?? 0}</b>${u.degraded ? ` · <b>降级</b>：${u.reason ?? ''}` : ''}</p>`
            + (u.namespaces || []).map((n) => `<p><code>${n.ns}</code>：` + (n.plugins || []).map((p) =>
                `<code>${p.name}@${p.version ?? '-'}</code> <form style="display:inline" method="post" action="${prefix}/admin/api/user-plugins/load">`
                + `<input type="hidden" name="ns" value="${n.ns}"><input type="hidden" name="plugin" value="${p.name}">`
                + `<button type="submit">装载</button></form>`).join(' ') + `</p>`).join('')
            + `<p>向 agent 提需求（本平台侧只登记待办；产出与落账本由 agent / Python 侧完成）：</p>`
            + `<form method="post" action="${prefix}/admin/api/user-plugins/request">`
            + `<input name="ns" placeholder="命名空间" size="10"><input name="description" placeholder="你想让它做什么" size="40">`
            + `<button type="submit">提需求</button></form>` })()
        + (() => { const m = pluginMarket.snapshot(); return `<h3 id="market">插件市场（只读）</h3>`
            + `<p>共 <b>${m.counts?.total ?? 0}</b> 项（人工 ${m.counts?.human ?? 0} / 自进化 ${m.counts?.evolve ?? 0} / 用户空间 ${m.counts?.user_space ?? 0}）；未装配 <b>${m.counts?.unwired ?? 0}</b>；三源一致 <b>${!m.inconsistent}</b></p>`
            + `<p>${(m.differences || []).map((d) => `<code>${d}</code>`).join(' · ') || '（无差异）'}</p>` })()
    }
    if (/^\/admin\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return send(200, 'text/html; charset=utf-8', html('系统管理', adminHtml(adminView.snapshot()), prefix))
    }
    if (/^\/admin\/api\/session\/?$/.test(path)) {
      return adminGuard.authorized(req).ok ? json(200, { ok: true, view: 'admin' }) : deny()
    }
    if (/^\/admin\/api\/elevate\/?$/.test(path) && String(req.method) === 'POST') {
      return readBody((body) => {
        const submitted = new URLSearchParams(body).get('token') ?? ''
        const out = adminGuard.elevate(submitted)
        if (!out || !out.ok) return deny()        // 失败五类同形：不区分、不泄露、不给 oracle
        send(200, 'application/json; charset=utf-8', '{"ok":true,"view":"admin"}', { 'set-cookie': out.cookie })
      })
    }
    if (/^\/admin\/api\/blocks\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, adminView.snapshot())
    }
    if (/^\/admin\/api\/blocks\/[^/]+\/resolve\/?$/.test(path) && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      const blockId = decodeURIComponent(path.split('/')[4] ?? '')
      return readBody((body) => {
        const form = new URLSearchParams(body)
        const fields = {}
        const RESERVED = ['token', 'kind']   // 保留键：不算用户提交的字段（否则只带 kind 的空提交会被误判为有内容）
        for (const [k, v] of form.entries()) { if (!RESERVED.includes(k) && String(v) !== '') fields[k] = String(v) }
        if (Object.keys(fields).length === 0) return json(400, { error: 'no-fields', hint: '至少提交一个字段' })
        const keys = Object.keys(fields).sort()
        const canonical = JSON.stringify(Object.fromEntries(keys.map((k) => [k, fields[k]])))
        const payloadSha = createHash('sha256').update(canonical).digest('hex')
        const bytes = Buffer.byteLength(canonical)
        const record = { block_id: blockId, kind: String(form.get('kind') ?? 'other'), submitted_at: new Date().toISOString(),
          submitted_by: 'admin-session', fields, payload_sha256: payloadSha, bytes, schema: 1 }
        // 只落待处理项（0600、原子写）；**账本零新增**（宿主不写账本），也不回显任何字段值
        const dir = String(config.admin_inbox ?? '')
        if (dir === '') return json(503, { error: 'inbox-unconfigured', hint: '服务未配置 admin_inbox（宿主侧待处理目录）' })
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          try { chmodSync(dir, 0o700) } catch (err) { /* 同上：FS 不支持时尽力而为 */ }
          const tmp = `${dir}/.${blockId}.${process.pid}.tmp`
          writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 })
          try { chmodSync(tmp, 0o600) } catch (err) { /* FS 不支持 POSIX 位时尽力而为 */ }
          renameSync(tmp, `${dir}/${blockId}.json`)
          try { rmSync(tmp, { force: true }) } catch (err) { /* 已 rename 成功，残留清理尽力而为 */ }
        } catch (err) {
          return json(500, { error: 'inbox-write-failed', detail: String(err).slice(0, 120) })
        }
        return send(202, 'application/json; charset=utf-8',
          JSON.stringify({ ok: true, block_id: blockId, payload_sha256: payloadSha, bytes,
            next_action: '等待 Python 侧消费：tools/admin-apply.py --approval-ref ap-NNNN --actor human:<人名>（宿主不写账本）' }))
      })
    }
    if (/^\/admin\/api\/market\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, pluginMarket.snapshot())
    }
    // ---- 用户空间插件（管理面本身是插件 user-plugin-manager）：全部需会话；宿主只落待办件，不写账本 ----
    // 同步/异步统一应答：管理面 load/unload/reload 可能返回 Promise（`out.ok` 在 Promise 上读不到）
    const answer = (out, okCode = 200, badCode = 409) => {
      const finish = (value) => {
        const good = Boolean(value && (value.ok === undefined ? value.uid || value.effects !== undefined : value.ok))
        return json(good ? okCode : badCode, value ?? { ok: false, code: 'no-result' })
      }
      return out && typeof out.then === 'function' ? out.then(finish).catch((err) => json(500, { error: 'manager-failed', detail: String(err).slice(0, 120) })) : finish(out)
    }
    const userReq = (dir) => (record) => {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
        const key = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16)
        const tmp = `${dir}/.${key}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 })
        try { chmodSync(tmp, 0o600) } catch (err) { /* 同上 */ }
        renameSync(tmp, `${dir}/req-${key}.json`)
        return key
      } catch (err) { return null }
    }
    if (/^\/admin\/api\/user-plugins\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, userPlugins.list())
    }
    if (/^\/admin\/api\/user-plugins\/(load|unload|reload|request|elevate)\/?$/.test(path) && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      const action = path.split('/')[4]
      return readBody((body) => {
        const form = new URLSearchParams(body)
        const ns = String(form.get('ns') ?? '').trim()
        const plugin = String(form.get('plugin') ?? '').trim()
        if (action === 'load' || action === 'unload' || action === 'reload') {
          return answer(userPlugins[action](ns, plugin))
        }
        if (action === 'request') {
          const description = String(form.get('description') ?? '').trim()
          if (description === '') return json(400, { error: 'no-description', hint: '描述你想让 agent 开发的插件功能' })
          const payload = { ...(userPlugins.requestCreate({ ns, description }) || {}),
            description: description.slice(0, 2000), requested_at: new Date().toISOString() }
          const key = userReq(String(config.admin_inbox ?? '').replace(/admin-submissions$/, 'user-plugin-requests'))(payload ?? {})
          return json(key ? 202 : 500, key ? { ok: true, request_id: key, next_action: '等待 Python 侧消费并记录 userplugin/created（宿主不写账本）' } : { error: 'request-write-failed' })
        }
        const approvalRef = String(form.get('approval_ref') ?? '').trim()
        const payload = userPlugins.elevateRequest(ns, plugin, approvalRef)
        const ok = payload && payload.ok !== false
        const key = ok ? userReq(String(config.admin_inbox ?? '').replace(/admin-submissions$/, 'user-plugin-elevations'))(payload ?? {}) : null
        return json(ok && key ? 202 : 409, ok ? { ok: true, elevation_id: key, payload } : (payload ?? { ok: false }))
      })
    }
    // ---- 配置与凭据（P0）：页面 + JSON + 干跑 + 只落待处理项 ----
    // 未提权一律 `deny()`（**与其它 admin 路由逐字节同形**：不给"这个子路由存在吗"这种可探测差异）。
    if (/^\/admin\/config\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return send(200, 'text/html; charset=utf-8', configPageHtml())
    }
    if (/^\/admin\/api\/config\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, configView.overview())
    }
    if (/^\/admin\/api\/config\/audit\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, configView.audit())
    }
    if (/^\/admin\/api\/config\/preview\/?$/.test(path) && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      return readBody((body) => {
        const patch = patchOf(body, req.headers['content-type'])
        if (!patch) return json(400, { error: 'bad-patch', hint: '提交 JSON（带类型）或表单（layer/key/value…）' })
        return json(200, configView.preview(patch))    // 干跑：**零落盘零生效**
      })
    }
    if (/^\/admin\/api\/config\/project\/?$/.test(path) && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      return readBody((body) => {
        const patch = patchOf(body, req.headers['content-type'])
        if (!patch) return json(400, { error: 'bad-patch', hint: '提交 JSON（带类型）或表单（key/value）' })
        return configAnswer(configView.submitProject({ fields: patch.fields ?? {},
          human_approval_ref: String(patch.human_approval_ref ?? '') }))
      })
    }
    const pluginConfigMatch = path.match(/^\/admin\/api\/config\/plugins(?:\/([^/]+)\/([^/]+))?\/?$/)
    if (pluginConfigMatch && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      const forced = pluginConfigMatch[1] && pluginConfigMatch[2]
        ? `${decodeURIComponent(pluginConfigMatch[1])}/${decodeURIComponent(pluginConfigMatch[2])}` : null
      return readBody((body) => {
        const patch = patchOf(body, req.headers['content-type'], { layerHint: 'plugin', targetHint: forced })
        if (!patch) return json(400, { error: 'bad-patch', hint: '提交 JSON（带类型）或表单（ns/plugin/field/value）' })
        return configAnswer(configView.submitPlugin(String(patch.target ?? ''), { fields: patch.fields ?? {} }))
      })
    }
    if (/^\/admin\/api\/credentials\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, configView.credentials())     // 每项 configured/source/required_mode/指纹前 8/next_action
    }
    const credentialMatch = path.match(/^\/admin\/api\/credentials\/([^/]+)\/?$/)
    if (credentialMatch && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      const name = decodeURIComponent(credentialMatch[1])
      return readBody((body) => {
        // 两种形状都收：表单 `value=<值>` 或 JSON `{value}` / `{fields:{value}}`（**都不回显**）
        const patch = patchOf(body, req.headers['content-type'], { layerHint: 'credential', targetHint: name })
        const value = patch?.fields?.value ?? patch?.value ?? ''
        const out = configView.submitCredential(name, String(value))
        // **只写不回显**：响应体里只有 ok 与 next_action（连提交摘要都不回）
        const code = out.ok ? 202 : (out.code === 'inbox-unconfigured' ? 503 : (out.code === 'inbox-write-failed' ? 500 : 409))
        return json(code, { ok: Boolean(out.ok), next_action: out.next_action })
      })
    }
    if (/^\/admin\/(config|api\/(config|credentials))(\/|$)/.test(path)) return deny()   // 其余子路径：与未提权同形

    if (/^\/admin\/api\/switch\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      const to = String(url.searchParams.get('to') ?? '')
      if (!Object.prototype.hasOwnProperty.call(rules, to)) return json(400, { error: 'unknown-view', hint: Object.keys(rules).join(' / ') })
      return send(302, 'text/plain; charset=utf-8', '', { location: `${prefix}/${to}/` })
    }
    return json(404, { error: 'not-found', path, hint: `可用：${prefix}/ / ${prefix}/contractor/ / ${prefix}/supplier/ / ${prefix}/ops/ / ${prefix}/ops/mail/ / ${prefix}/api/status / ${prefix}/api/obs / ${prefix}/api/ops / ${prefix}/api/retention / ${prefix}/api/pipeline / ${prefix}/api/mail / ${prefix}/<view>/api/history / ${prefix}/<view>/api/evidence / ${prefix}/<view>/api/scorecard / ${prefix}/<view>/api/approvals / ${prefix}/<view>/api/negotiation / ${prefix}/<view>/api/faq / ${prefix}/<view>/heuristics/ / ${prefix}/<view>/api/heuristics / ${prefix}/admin/ / ${prefix}/admin/api/blocks / ${prefix}/admin/api/elevate / ${prefix}/admin/api/switch?to=<view>` })
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
