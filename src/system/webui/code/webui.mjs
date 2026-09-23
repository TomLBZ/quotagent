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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { array, number, object, string } from '../lib/std-schema.mjs'
import { openLedger } from '../lib/ledger-view.mjs'
// 注入式 UI 注册面（**机制**，见 host/lib/ui-slot.mjs）：本文件不知道任何区块是什么、由谁注册。
// 用户原话（逐字）："不需要让 webui 耦合展示其他插件的 UI 或者耦合某种具体的业务逻辑。"
import { createSlotRegistry, SLOTS as UI_SLOTS } from '../lib/ui-slot.mjs'
// 注入式 UI 的**路由注册面**（机制，见 host/lib/ui-route.mjs）：与槽位面姊妹 —— 插件自己注册 HTTP 路由
// （27 §6.1 把"路由注册"列为 webui 必须提供的注册面之一）。本文件不知道任何路由的业务含义。
import { createRouteRegistry } from '../lib/ui-route.mjs'
// GUI **应用外壳**（机制；见 `docs/design/29-webui-gui-app.md`）：多视图/导航/命令面板/通知中心/状态栏/深链/
// 快捷键 + 动作总线。本文件只把它挂上路由；功能全部由插件通过注册面贡献（`code/ui.mjs` 发现式装载）。
import { createAppShell } from './app-shell.mjs'
// 身份与会话 + 三个「仅本人可见」的自助面（DEF-001/003/025/026）。它**注册到既有的路由注册面**
// （`uiRoutes`），本文件只多三行接线（见下面 `createIdentity(...)` / `identity.register(uiRoutes)`）。
import { createIdentity } from './identity.mjs'

export const name = 'webui'

export const inject = ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback', 'advicePanel', 'gateTimeline', 'authorityBand', 'rfqDeadline', 'quotePrepare']   // 每个都是独立插件（准入 / 观测 / 视图 / 系统管理 / 市场 / 配置与凭据 / 邮件 / 比价 heuristics / 反馈闭环 / 决策建议 / 审批与变更时间线 / 授权区间 / RFQ 回文时限）

export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const usedServices = ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'adminGuard', 'adminView', 'pluginMarket', 'userPluginManager', 'configView', 'mailView', 'bidHeuristics', 'uiFeedback', 'advicePanel', 'gateTimeline', 'authorityBand', 'rfqDeadline', 'quotePrepare']

export const provides = ['webui', 'uiSlots']    // `uiSlots` = 注入式 UI 的注册面（机制；不含业务语义）

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
  admin_snapshot: string().default(''),     // 系统管理快照（阻塞/进度）的**绝对路径**（同上）
  admin_inbox: string().default(''),        // 待处理提交目录（宿主写这里；Only Python 消费，账号不写账本）
  ui_shared: string().default('tmp/ui-shared'),  // 宿主侧共享目录（`gate-nudges/` = 催办待办件；与 ui-feedback 同口径）
  // RFQ **投递信封**的位置（发送方放到共享交换目录里的交付件：`{delivered_to, rev, sent_at, spec}`）。
  // 修「供应商看不到自己的 RFQ 包」这个根因：被邀供应商的投影里要能看到**发给它的**包事实。
  // 可以是**一个文件**（单包）或一个**目录**（读其中 `*.json`，按文件名排序、有界）。
  // 缺省空 = 没有投递来源（视图如实报 degraded + reason，不编数据）。
  rfq_delivery: string().default(''),
  rfq_delivery_max: number().default(8),    // 每视角最多展示几个包（有界；超出如实报 omitted）
  // 只读工具调用的**缓存窗口**（毫秒；机制层）：同一组 `(工具, 参数)` 的只读调用在这个窗口内只 spawn 一次。
  // 插件要显式声明 `host.runPython(tool, args, { read: true })` 才会进缓存；任何一次动作/落待办件都会清空缓存。
  python_cache_ms: number().default(3000),
  // 注入式 UI 的槽位闭合集合（机制层）：插件只能注册到这些槽位；新增槽位改 host/lib/ui-slot.mjs。
  ui_slots: array(string()).default([...UI_SLOTS]),
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

/**
 * **退役的旧 SSR 页**（`docs/design/29-webui-gui-app.md` §2「旧口径一律删除，不得保留副本」）。
 *
 * 这四页（`/<view>/advice/` 决策建议、`/<view>/deadlines/` 回文时限、`/<view>/gates/` 审批与变更时间线、
 * `/<view>/authority/` 授权区间）都是「说明书式只读页」：页面把**终端命令**准备好让用户复制
 * （`python3 -m quotagent.g1side …`、`PYTHONPATH=src …`、「五件事永远在终端做人签」、「批准只走终端人工门」），
 * 与用户要求「双方仅通过 GUI 走完全部业务流程」正面冲突，且它们的功能已由 GUI 面板 + 动作承接：
 *   · `advice` → `rfq.remind-board`（谁没回 / 已催几次）/`compare.ranking`（贡献与提升方式）/
 *     `gate.queue`（等多久、卡在谁）/`mail.channel`（为什么发不出去），动作 `rfq.remind`、
 *     `gate.escalate`、`exchange.rev-amend`；
 *   · `deadlines` → `rfq.remind-board`（回文时限与催报，双方）+ 动作 `rfq.remind`、
 *     `exchange.promise`（供应商「我要晚点回」）、`exchange.inbox`（认收）；
 *   · `gates` → 面板 `gate.queue`（**行内「批准 / 驳回」，人签**）/ `gate.decided`（已决定的门留痕）/
 *     `gate.todo`（工作台「要人决定的事」），动作 `gate.grant` / `gate.deny` / `gate.nudge` /
 *     `gate.escalate` / `gate.delegate` / `gate.abort`；变更单**逐行明细**仍在 `/<view>/changes/<id>/`；
 *   · `authority` → 面板 `authority.bands`，动作 `authority.check`（只读：谁能批到多少 / 越界多少 /
 *     下一个能批的人是谁）与 `authority.escalate`（人签：越界**一键开人工门**，门开出来后去审批队列批准/驳回）。
 *
 * **旧地址不 404**：`303 → ${prefix}/app/<view>/`（GUI 视图页；该侧承接这些功能的插件面板就在那一页上）。
 * 未登录 / 跨侧语义**一字未改**（仍走 `identity.gateBusinessRoute`：401 或 303 → `/identity/?next=…`）。
 * 写面（`POST /<view>/deadlines/promise`、`POST /<view>/gates/nudge`）**不拆**（它们是动作，不是旧页）。
 */
const RETIRED_SUBVIEWS = {
  advice: '决策建议（确定性规则派生的「下一步」已并入 GUI 面板：回文时限与催报 / 比价名次与贡献 / 审批队列 / 邮件通道）',
  deadlines: '回文时限（谁没回、已催几次、还剩多久）—— 面板 `rfq.remind-board`，动作 `rfq.remind` / `exchange.promise`',
  gates: '审批与变更时间线（人工门等了多久 / 卡在谁手里 / 变更单谁欠一个动作）—— '
    + '面板 `gate.queue`（行内「批准 / 驳回」，人签）与 `gate.decided`（已决定的门留痕），'
    + '动作 `gate.grant` / `gate.deny` / `gate.nudge` / `gate.escalate`',
  authority: '授权区间（谁能批到多少 / 越界找谁）—— 面板 `authority.bands`，动作 `authority.check`（只读）'
    + '与 `authority.escalate`（人签：越界一键开人工门）',
}

/** 分页/筛选的**夹取口径**（写死一处；回显的 applied 即真值，请求值一并报出便于人工核对）。 */
const LIMIT_DEFAULT = 20
const LIMIT_MAX = 200
const PAGE_DEFAULT = 1
const SORTS = ['desc', 'asc']
const SORT_DEFAULT = SORTS[0]
const LIMIT_CHOICES = [10, 20, 50, 200]

/**
 * **假成功围栏**（本批）：只应为 `GET` 的路由收到其它方法时，返回 **405 + `Allow: GET`** 与同形 JSON
 * （`{ok:false, code:'method-not-allowed', next_action}`），**绝不**把 POST 当 GET 处理。
 *
 * 为什么必须做（实测，逐字）：`curl -s GET /quotagent/contractor/quotes/` 与
 * `curl -s -X POST 同路径 -d 'item=L-001&price=80'` 返回**逐字节相同**的 200 页面
 * （两者 bytes=3935、sha256 相同）。⇒ 员工填了单价点提交，浏览器给一页正常页面，
 * **什么都没发生**（账本没动、对方没收到、页面没变）—— 这是最伤信任的一条，必须由宿主结构性禁止。
 *
 * 两张表都是**静态声明**：新增只读路由必须同步 `GET_ONLY_PATTERNS`，新增写路由必须同步
 * `WRITE_PATTERNS`。门（`host/webui.mjs`）拿 `/api/routes` **逐条反向对照**：路由表里 `method=GET`
 * 且没有同路径 POST 行的，POST 必须 405；路由表里 `method=POST` 的，POST 必须**不是**该 code
 * （非空转对照）—— 漏一处就红。
 */
const GET_ONLY_PATTERNS = [
  /^\/?$/,                                                     // 工作台首屏（GUI 外壳）
  /^\/start\/?$/,
  /^\/api\/(health|status|obs|ops|mail|retention|routes|ui-feedback|ui\/blocks)\/?$/,
  /^\/api\/ui\/(surface|panels|notifications|status|object|plugins)\/?$/,   // GUI 外壳：注册面自述 / 面板数据 / 通知 / 状态 / **对象页** / 插件清单
  // **只读**自述/查询路由：协作面与名册面（`side` 一律取会话）。它们必须在**任何处理器之前**按方法判据
  // 拒绝非 GET（否则会先撞上处理器里的身份校验 ⇒ 返回 401 而不是 405 + `Allow: GET`）。
  /^\/api\/collab\/(store|object|hub)\/?$/,
  /^\/api\/people\/(roster|suggest|store)\/?$/,
  /^\/assets\/[A-Za-z0-9._-]+$/,                                // GUI 外壳自己的客户端资源（只来自本服务）
  /^\/manifest\.webmanifest$/,                                  // PWA 清单（机制；相对 URL ⇒ 任意前缀都对）
  /^\/sw\.js$/,                                                 // PWA Service Worker（离线壳；必须落在前缀根上才拿到 scope）
  /^\/app(\/[A-Za-z0-9._%<>-]+)*\/?$/,                          // GUI 深链（工作台/各视图/**对象** `/app/<view>/<kind>/<id>/`）
  // 上面这条也认**路由表里的占位形式**（`<view>`/`<kind>`/`<id>`，含被百分号编码的 `%3C…%3E`）：反向对照门会拿
  // `/api/routes` 的 path 逐条 POST，占位形式若落不到这张表就会变成 404 而不是 405 —— 那等于"只读路由对写方法不表态"。
  // 真实请求里的 `<`/`>`/`%` 一律被浏览器编码成安全字符，所以放宽字符集不会把真实路径误判成只读。
  /^\/ops\/?$/,
  /^\/ops\/mail\/?$/,
  /^\/ops\/ui-feedback\/?$/,
  /^\/[a-z]+\/?$/,                                             // 视角首页（含 /contractor/ /supplier/ /ops/ /admin/）
  /^\/admin\/config\/?$/,
  /^\/admin\/api\/(session|blocks|market|user-plugins|config|credentials)\/?$/,
  /^\/admin\/api\/config\/audit\/?$/,
  /^\/[a-z]+\/(events|quotes|approvals|evidence|clarifications|feedback)\/?$/,   // 道内子视图 + 反馈页
  /^\/[a-z]+\/(heuristics|advice|gates|authority|deadlines)\/?$/,
  /^\/[a-z]+\/changes\/[A-Za-z0-9_.:-]+\/?$/,
  /^\/[a-z]+\/api\/(events|evidence|negotiation|faq|heuristics|advice|gates|authority|deadlines|scorecard|history|approvals)\/?$/,
  /^\/[a-z]+\/api\/changes\/[A-Za-z0-9_.:-]+\/?$/,
  // 身份与会话 + 自助面的**读**侧（`identity.mjs`）：写侧在 WRITE_PATTERNS 里，这里只冻读形态
  /^\/identity\/(me)?\/?$/,
  /^\/inbox(\/api)?\/?$/,
  /^\/sign\/?$/,
  /^\/plugins\/?$/,
  /^\/[a-z]+\/inbox(\/api)?\/?$/,
]

/** **真的会处理写**的路径（POST 白名单）：只有这几条能把请求变成一条待办件或一次状态变化。 */
const WRITE_PATTERNS = [
  /^\/api\/action\/[A-Za-z0-9._-]+\/?$/,                       // GUI 动作总线（插件自己的服务端一半）
  /^\/api\/ui\/plugins\/[^/]+\/unload\/?$/,                    // 撤销一个插件的全部 UI 贡献（可卸载）
  /^\/api\/ui\/plugins\/[^/]+\/(load|reload)\/?$/,             // **运行期装载/热重载**（改插件 UI 不必重启进程）
  /^\/admin\/api\/elevate\/?$/,
  /^\/admin\/api\/blocks\/[^/]+\/resolve\/?$/,
  /^\/admin\/api\/user-plugins\/(load|unload|reload|request|elevate)\/?$/,
  /^\/admin\/api\/config\/(preview|project)\/?$/,
  /^\/admin\/api\/config\/plugins(?:\/[^/]+\/[^/]+)?\/?$/,
  /^\/admin\/api\/credentials\/[^/]+\/?$/,
  /^\/[a-z]+\/gates\/nudge\/?$/,
  /^\/[a-z]+\/deadlines\/promise\/?$/,
  /^\/[a-z]+\/feedback\/?$/,
  /^\/[a-z]+\/quotes\/prepare\/?$/,                            // 报价草稿（只有准备视角有这一步）
  /^\/api\/ui\/notif-state\/?$/,                                // 通知偏好/已读的服务端化（0600 落盘，按会话身份）
  // 身份与会话 + 自助面（`identity.mjs` 注册到路由注册面的那几条；**只落待办件/委托唯一写者**）
  /^\/identity\/(login|logout)\/?$/,                           // 登录/登出（服务端会话 0600 + cookie）
  /^\/sign\/(quote|award)\/?$/,                                // 人签（署名必须等于会话身份）
  /^\/mail\/config\/?$/,                                       // 邮件配置（干跑 → 0600 待办件 → config-apply.py）
  /^\/plugins\/(load|unload|reload)\/?$/,                      // 自己的用户空间插件自助装卸
]

/** 该路径是不是「只应为 GET」的（收到非 GET ⇒ 405）。 */
const isGetOnlyRoute = (path) => GET_ONLY_PATTERNS.some((pattern) => pattern.test(path))
/** 该路径是不是**真的会处理写**的（收到 POST ⇒ 放行；其余落到各自的处理器）。 */
const isWriteRoute = (path) => WRITE_PATTERNS.some((pattern) => pattern.test(path))

/**
 * **业务路由的 `auth` 真实值**（`/api/routes` 台账口径；D-… 与 `code/identity.mjs#gateBusinessRoute` 同源）。
 *
 * 为什么要有这个名字：身份门槛（DEF-001）落地后，`/contractor/**` 与 `/supplier/**` 的静态业务路由**不再免鉴权**
 * —— 未登录 ⇒ 401 `identity-required`（API）/ `303 → /identity/?next=…`（浏览器），登录了不是这一侧 ⇒ 403
 * `side-mismatch`。台账里继续写 `auth: 'none'` 就是**对身份面撒谎**（读台账的人会以为它们公开）。
 * 所以：凡落在**两条业务道**前缀下的路由，`auth` 一律标成下面这个真实值（在 `/api/routes` 输出时按路径推导，
 * 新增业务路由不会漏标 —— 不必也不会有人去手抄一遍）。
 */
export const AUTH_BUSINESS = 'identity-session'
/** 业务道（**与路由级身份门槛同一集合**：`identity.mjs#gateBusinessRoute` 只对这两侧表态）。 */
export const BUSINESS_SIDES = ['contractor', 'supplier']

/** ops / admin 两道的道内导航（本步不新增子路由，用**页内锚点**：一跳可达这件事本身保留）。 */
const OPS_SECTIONS = [['runtime', '运行期'], ['mail', '邮件（SMTP/IMAP）'], ['retention', '留存计划'],
  ['evolve', '自进化'], ['evidence', '证据面']]
const ADMIN_SECTIONS = [['blocks', '阻塞清单'], ['progress', '进度'], ['config', '配置与凭据'],
  ['user-plugins', '用户空间插件'], ['market', '插件市场']]

/** HTML 转义：页面全部由字符串拼装，任何来自账本/快照/参数表的字节都必须先过这里。 */
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * **P32：外部行数组的唯一读数入口**（口径见 `src/system/webui/docs/row-action-prefill.md` §4）。
 *
 * 为什么必须有它：对**外部给的行数组**（账本 `body.lines` / 投递信封 `spec.items` / 工具 JSON 的 `rows` /
 * 服务面回的快照行）做 `map`/`for-of` 时**直接把元素当对象读属性**（`row.code`），数组里只要混进
 * **一条** `null`/字符串/数字/嵌套数组，读属性就抛 `TypeError` —— 面板侧外壳把 `panel.data()` 抛错
 * 判成**整块 `data-failed`**（这一块整体消失），SSR 路由侧则是**这一页 500**。
 *
 * 纪律：坏行**逐条计数**（`bad`，调用方必须把它显示出来）、**好行照列**；源本身**不是数组** ⇒
 * `list:false`（那是「读不出来」，不是「零行」—— 两者不许长得一样）。
 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, rows: [], all: 0, bad: 0 }
  const rows = []
  let bad = 0
  for (const row of value) { if (isRow(row)) rows.push(row); else bad += 1 }
  return { list: true, rows, all: value.length, bad }
}
/** 坏行的屏幕说法：**不静默丢**（好行照列、坏行如实报数）。 */
const droppedNote = (read, what = '行') => (read.bad > 0
  ? `<p class="degraded" data-degraded="1" data-rows-dropped="${read.bad}">另有 <b>${read.bad}</b> 条${what}`
    + `读不出来（形状异常：不是对象）—— 好行照列，坏条已跳过并计数（不静默丢）。</p>`
  : '')

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
  // 审批与变更 / 授权区间：**旧 SSR 页已退役**（`RETIRED_SUBVIEWS`）—— 入口**接新位置**：
  // 指向 GUI 视图页（`${prefix}/app/<view>/`），该侧承接这些功能的插件面板就在那一页上。
  // 抓手（`data-gates-link` / `data-authority-link`）保留：门的判据仍是「入口存在且指向真位置」，
  // 只是目标从旧页换成了 GUI（旧页现在 303 到同一个地方）。
  links.push(`<a href="${prefix}/app/${view}/" data-gates-link="1"${current === 'gates' ? ' aria-current="page"' : ''}>审批队列（GUI）</a>`)
  links.push(`<a href="${prefix}/app/${view}/" data-authority-link="1"${current === 'authority' ? ' aria-current="page"' : ''}>授权区间（GUI）</a>`)
  // 退役的旧页**不再出现在导航里**：`/<view>/advice/`（决策建议）、`/<view>/deadlines/`（回文时限）、
  // `/<view>/gates/`（审批与变更）、`/<view>/authority/`（授权区间）已按 `docs/design/29-webui-gui-app.md` §2
  // 退役 —— 旧地址 303 → GUI（`/app/<view>/`），见 RETIRED_SUBVIEWS。
  return `<nav data-subnav="${view}">${links.join(' ')}</nav>`
}

/** 页内锚点导航（ops / admin 两道；同样带 `data-subnav` 抓手）。
 *  `extras` 是比价口径入口（带 `data-heuristics-link`），`gateExtras` 是审批与变更入口
 *  （带 `data-gates-link`），`authorityExtras` 是授权区间入口（带 `data-authority-link`）
 *  —— 三种入口的抓手分开，免得门把其中一个当成另一个的证据。
 *  （`advice` / `deadlines` 两个入口已随旧页退役：见 `RETIRED_SUBVIEWS`。） */
const anchorNav = (view, home, sections, extras = [], gateExtras = [], authorityExtras = []) =>
  `<nav data-subnav="${view}">${[`<a href="${home}">首页</a>`]
  .concat(sections.map(([id, label]) => `<a href="${home}#${id}">${label}</a>`))
  .concat(extras.map(([href, label]) => `<a href="${href}" data-heuristics-link="1">${label}</a>`))
  .concat(gateExtras.map(([href, label]) => `<a href="${href}" data-gates-link="1">${label}</a>`))
  .concat(authorityExtras.map(([href, label]) => `<a href="${href}" data-authority-link="1">${label}</a>`))
  .join(' ')}</nav>`


/** 上手页（**未提权也能看**）：三步上手 + 提权 token 放哪里 + 配置/凭据放哪里 + 四个视图能做什么。
 *  只讲机制与命令，**不显示任何状态位/凭据值**（宿主零写面、零凭据）。 */
function onboardingHtml(prefix, views) {
  const rows = views.map((v) => {
    const can = { contractor: '看本侧待办/事件/报价/待批摘要；批准与变更在 GUI 里人签（`/app/contractor/` 的审批队列 / 变更列表）',
      supplier: '看本侧待办/事件/自己的报价；提交澄清与报价草稿；人签提交在 GUI 的签名对话框里',
      ops: '运行期中间件、邮件域、留存计划、自进化日志、证据索引（只读）',
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
<h2>授权区间在哪里配（谁能批到多少）</h2>
<p><b>改哪里</b>：同一张 <a href="${prefix}/admin/config/">配置与凭据页</a> → 「项目」表里的这几行（都是 <b>人工专属键</b>：
提交要带 <code>ap-NNNN</code> 人工引用，agent 改不动）：</p>
<pre>authority.bands.&lt;角色&gt;   ← 这个角色**能批到多少**（**整数分**：500000 = 5000.00 元）；null = 未配置
authority.unit            ← 计量单位声明（只认 cents：本系统不做元/分换算）
authority.currency        ← 币种声明（只声明、不换算）
authority.fallback_role   ← 超出所有角色区间时的升级兜底角色（**不**用来补一个限额）
authority.escalation_note ← 越界升级时给办理人看的一句话（空 = 用标准文案）</pre>
<p><b>也可以直接写 YAML</b>（受管段 <code>project:</code>，写法与上面逐字一致）——下面的片段可以直接抄进
<code>/workspace/config.yaml</code>（**唯一落盘者是 <code>tools/config-apply.py</code>**，宿主只落 0600 待办件）：</p>
<pre>project:
  authority.unit: cents
  authority.currency: CNY
  authority.bands.buyer: 500000
  authority.bands.lead: 2000000
  authority.bands.director: 10000000
  authority.fallback_role: director
  authority.escalation_note: 越界请找业主代表（越界时页面给出下一角色；批准在 GUI 里人签）</pre>
<p><b>配完在哪看</b>：<a href="${prefix}/app/contractor/">承包商的工作台（GUI）</a>与
<a href="${prefix}/app/supplier/">供应商的工作台（GUI）</a>里的<b>「授权区间」面板</b>—— 填一个金额（**整数分**）与角色，
面板会告诉你「落在谁的区间里 / 越界多少 / 下一个能批的人是谁」；越界就点面板里的
「提交给下一角色审批」（动作 <code>authority.escalate</code>）一键开人工门，批准 / 驳回在上面的
<b>审批队列</b>里由点名的人签（本插件只算、不批）。</p>
<p><b>没配会怎样（诚实默认）</b>：面板**不会**给你编一个限额 —— 它报 <code>unconfigured</code> 并把
<code>required_role</code>/<code>next_role</code> 留空，同时告诉你到哪一行去登记。另外：<b>越界一律走人工门</b>，
该面板**不能批准任何东西**（批准在 GUI 里由登录身份人签：动作带 <code>permission=human-signature</code>，
服务端校验署名 == 会话身份）。</p>
<p>需要凭据才能工作的功能（**在接上之前一律如实报未连接，不会假装健康**）：</p>
<pre>· 邮件收发（SMTP/IMAP）：未配置 → mail 传输 available:false / reason=mail-transport-unavailable / next_action=配置凭据后接入
· Jev 建议层：未配置 key → 面板里作为一条阻塞项出现（不是在日志里悄悄失败）</pre>
<p>阻塞项可以在 <a href="${prefix}/admin/">系统管理面板</a>里**直接提交解决**（提交只落一个 0600 待处理项，
由 Python 侧消费并落账本 「admin/block-resolved」；宿主自己不写账本）。</p>
<h2>四个视图各能做什么</h2>
<table><tr><th>路由</th><th>能做什么</th></tr>${rows}</table>
<p><small>机器可读的路由表：<a href="${prefix}/api/routes">${prefix}/api/routes</a>。
需要人签的动作（批准、提交报价、定标、发 PO、变更批准）在 GUI 里由**本人签名对话框**完成
（动作声明 <code>permission=human-signature</code>，服务端校验署名 == 会话身份）；界面只**发起**，
落账本的仍是既有唯一写者 —— 界面不代签、不写账本。</small></p>`
}


export function apply(ctx, config) {
  const projection = ctx.projection            // 投影服务（真源在 host/modules/projection.mjs）
  const rules = projection.rules
  const prefix = config.route_prefix.replace(/\/$/, '')
  /**
   * **账本只读备忘的读数**（P13；只为"前后可对账"）。
   * `memo_hits` = 这次进程内"本视角的行"被问到几次、其中几次走了备忘（没有重新读文件）；
   * `parses` = 真正读盘 + 逐行 JSON.parse 的次数；`ms` = 这些 parse 累计花的时间。
   * 修前的实测形态：`parses` 与 `memo_hits+parses` 相等（每一次提问都真读一遍）；
   * 修后：`parses` 只在账本真的变了（mtime/size）时才 +1。读数经 `/api/ui/surface` 的 `io` 暴露。
   */
  const ledgerStats = { memo_hits: 0, parses: 0, bytes: 0, ms: 0, paths: 0, projections: 0, projection_hits: 0 }
  // ---- 注入式 UI 注册面（**机制**） ------------------------------------------------
  // 本文件只做两件通用的事：① 把注册面 `uiSlots` 提供出去（谁都可以注册区块/路由声明）；
  // ② 在页面的**槽位**上把"别人注册的区块"按 `order` 拼进去。它**不知道**任何区块是什么、
  // 属于哪个插件、里面是业务还是别的 —— 那一层由 `host/lib/ui-slot.mjs` 的校验与插件自己的 render 决定。
  // 纪律：注册失败**不静默吞**（页面出现指名错误块）、插件提交的 HTML 带脚本一律**拒收**。
  const uiSlots = createSlotRegistry({ slots: config.ui_slots })
  ctx.effect(() => () => uiSlots.dispose())      // 卸载即释放注册表（零残留）
  const slotsHtmlOf = (view) => uiSlots.render(`page.${view}`)
  // 路由注册面（**机制**，与槽位面同构）：`host/lib/ui-route.mjs` 只管"谁在哪条路径上注册了什么"，
  // 本文件只做两件通用的事：① 请求进来时查表（精确匹配，命中了就把响应权交给注册者）；
  // ② 把动态路由与静态路由登记在同一张 `/api/routes` 表里。**不解读**任何路由的语义。
  const uiRoutes = createRouteRegistry()
  ctx.effect(() => () => uiRoutes.dispose())     // 卸载即释放（注册者随之失去服务，零残留）
  // ---- GUI 应用外壳（机制） --------------------------------------------------------------
  // 外壳自己**零业务语义**：它只把注册面（`ui-surface.mjs`）上的贡献装配成可点的界面，并把动作请求交给
  // 插件自己的**服务端一半**。写动作仍只能由 Python 侧唯一写者落账本（外壳只落 0600 待办件 + spawn）。
  const repoRoot = new URL('../../../..', import.meta.url).pathname
  const shell = createAppShell({
    root: repoRoot,
    prefix,
    views: ['home', ...config.views],
    config,
    // 本视角**账本行**（结构性隔离：每个视角只读自己的账本；与 webui.mjs 既有各特性同一口径）+
    // **公开投影行**（白名单在 projection 插件）—— 两者都交给插件，由插件按自己领域知识挑字段。
    rowsOf: (view) => (rules[view] ? ledgerOf(view).rows() : []),
    publicRowsOf: (view) => (rules[view] ? projectionOf(view).publicRows : []),
    slots: uiSlots,
    // 宿主自己注入的服务句柄（机制：按名字取；外壳不知道它们的业务含义）
    services: { quotePrepare: ctx.quotePrepare, bidHeuristics: ctx.bidHeuristics, gateTimeline: ctx.gateTimeline,
      rfqDeadline: ctx.rfqDeadline, approvalDigest: ctx.approvalDigest, projection: ctx.projection },
    // **账本只读备忘的读数**（本批新增，只为可对账）：`/api/ui/surface` 的 io 会把"这次渲染
    // 真读了几遍账本 / 备忘命中几次"如实报出来 —— 修前修后的差别必须是可复跑的读数，不是形容词。
    ledgerStats,
    log: (msg) => console.error(msg),
  })
  ctx.effect(() => () => shell.surface.dispose())
  // ---- 身份与会话（DEF-001/003/025/026）：**注册进既有的路由注册面**，本文件不认识它的任何面 ----
  // 只做两件事：① 建它（把外壳、宿主服务句柄交给它）；② 让它把路由注册进 `uiRoutes`。
  const identity = createIdentity({ root: repoRoot, prefix, config, shell, people: shell.people,
    services: { userPluginManager: ctx.userPluginManager, configView: ctx.configView }, log: (msg) => console.error(msg) })
  const identityRoutes = identity.register(uiRoutes)
  // ---- **同侧协作**（指派/转交、关注、评论与 @同事、活动流、我的/我指派的/全部）的装配 -------------------
  // 外壳先建、身份面后建 ⇒ 协作面要的两样东西（会话文件 ⇒ 本侧同事名单；合法侧 ⇒ 哪些视图是业务侧视图）
  // 只能在这里补上。协作数据落 `<ui_shared>/collab/<side>.json`（0600，按侧隔离），**不进账本**：
  // 它是人对界面的协同痕迹，不是合同事实（逐条理由见 `src/system/webui/code/collab.mjs` 文件头）。
  const collabWiring = shell.configureCollab({ sessionsFile: identity.paths.sessions_file,
    sides: identity.sides.map((side) => side.id), views: config.views })
  console.error(`[webui] 协作面：视图 ${collabWiring.views.join('/') || '（无）'}`
    + ` · 对象类 ${collabWiring.kinds.join('/') || '（暂无）'} · 对象面板 ${collabWiring.object_panels} 组`
    + ` · 存储 ${shell.collab.describe().dir}（0600，按侧隔离，不进账本）`)
  // ---- **人员名册与角色**的装配（机制）----------------------------------------------------------------
  // 为什么：界面上原来那个「同事」是从**登录过的人**推出来的 ⇒ 名单取决于谁碰巧开过页面，单位里真实的人
  // 反而进不来，也没有任何地方能表达"谁是采购员/主管""谁的直属上级是谁""这一步只有主管能批"。
  // 现在：名册是**真源**（`<ui_shared>/people/roster.json`，0600、按侧隔离、原子写），@提及/指派/转交都从它取值；
  // 角色只用来**限动作**（`people.guardAction` 在动作的服务端一半之前否决），**不改变签署权**
  // （人签仍是「署名 == 会话身份」，见 §7.4）。它同样不是账本事实：名册/额度是**可改的配置**。
  const peopleWiring = shell.configurePeople({ sessionsFile: identity.paths.sessions_file,
    sides: identity.sides.map((side) => side.id), views: config.views })
  console.error(`[webui] 名册面：视图 ${peopleWiring.views.join('/') || '（无）'} · 面板 ${peopleWiring.panels} 组`
    + ` · 存储 ${shell.people.describe().file}（0600，按侧隔离，不进账本）`
    + ` · 角色 ${shell.people.describe().roles.map((role) => role.id).join('/')}`)
  // ---- 通知偏好 / 已读 / **布局** / **筛选**的**服务端化**（机制）------------------------------------
  // 为什么：已读集合 / 静音 / 级别门槛 / **面板布局（顺序·折叠·隐藏）** / **筛选片选择**原先只存在浏览器
  // localStorage 里（`quotagent.notif` / `.layout` / `.filters`）⇒ 换浏览器、换设备就重来（P3 走查如实登记的
  // 第 4 条摩擦）。现在它们**整份**按身份落服务端。
  // 落点：`<ui_shared>/webui/notif-state.json`（目录 0700 / 文件 **0600**、原子写、有界）。
  // 归属：**按会话身份**（`human:<名字>`，由身份 cookie 解析）—— 未登录 ⇒ 401 `identity-required`：
  // 不落盘、不伪造身份、不把「谁读过什么」「谁的布局」记到别人名下。它**不是账本事实**（偏好不是业务承诺）。
  const NOTIF_SCHEMA = 'quotagent/webui-client-state/v2'
  const NOTIF_LEVELS = ['info', 'warn', 'bad']
  const NOTIF_BOUNDS = { read: 1000, muted: 50, id_bytes: 200, muted_bytes: 64,
    layout_keys: 80, layout_items: 80, layout_id_bytes: 120, filters: 64, filter_bytes: 64 }
  // `resolve`（不是 `join`）：`ui_shared` 可能是**绝对路径**（生产就是），`join` 会把绝对路径拼在后面
  // —— 实测踩过：写成 join 会落出 `<repo>/workspace/projects/<repo>/tmp/...` 这种鬼路径（写成 `resolve` 才是
  // 「绝对路径覆盖前缀」的语义，与 `identity.mjs` 的 `sharedDir` 同一口径）。
  const notifDir = resolve(repoRoot, String(config.ui_shared ?? 'tmp/ui-shared'), 'webui')
  // 落点由**这一行**定：`app-shell.mjs` 的 `notifStateFilePath()`（摘要读"未读几条"用）与之同值 ——
  // 改路径时两处一起改（两边都有这条注释）。
  const notifFile = join(notifDir, 'notif-state.json')
  const notifEmpty = () => ({ schema: NOTIF_SCHEMA, identities: {} })
  const notifRead = () => {
    try {
      const doc = JSON.parse(readFileSync(notifFile, 'utf8'))
      if (doc && typeof doc === 'object' && !Array.isArray(doc) && typeof doc.identities === 'object'
        && doc.identities !== null && !Array.isArray(doc.identities)) return { schema: NOTIF_SCHEMA,
        identities: doc.identities }
    } catch (err) { /* 缺失/坏文件 ⇒ 空文档（不猜、不抛） */ }
    return notifEmpty()
  }
  /**
   * 有界 + 洗净：id 只留字符串（≤ 200 字节，超出**丢掉**并如实计入 `dropped`）、去重、截到上限。
   * 同一套口径也管**布局**（每键的 order/collapsed/hidden 数组）与**筛选**（键 → 值）：
   * 形状不对的一律**丢掉**（不猜、不截断成另一份状态），丢了多少如实报在 `dropped` 里。
   */
  const notifSanitize = (raw) => {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const rawRead = Array.isArray(source.read) ? source.read : []
    const cut = rawRead.filter((item) => typeof item !== 'string'
      || Buffer.byteLength(item, 'utf8') > NOTIF_BOUNDS.id_bytes).length
    const read = [...new Set(rawRead.filter((item) => typeof item === 'string'
      && item.trim() !== '' && Buffer.byteLength(item, 'utf8') <= NOTIF_BOUNDS.id_bytes))]
    const over = Math.max(0, read.length - NOTIF_BOUNDS.read)
    const muted = [...new Set((Array.isArray(source.muted) ? source.muted : [])
      .filter((item) => typeof item === 'string' && item.trim() !== ''
        && Buffer.byteLength(item, 'utf8') <= NOTIF_BOUNDS.muted_bytes))]
      .slice(0, NOTIF_BOUNDS.muted)
    const level = NOTIF_LEVELS.includes(source.min_level) ? source.min_level : 'info'
    const clean = (value) => (typeof value === 'string' && value.trim() !== ''
      && Buffer.byteLength(value, 'utf8') <= NOTIF_BOUNDS.layout_id_bytes) ? value : ''
    let layoutDropped = 0
    const layout = {}
    const rawLayout = source.layout && typeof source.layout === 'object' && !Array.isArray(source.layout)
      ? source.layout : {}
    for (const [key, value] of Object.entries(rawLayout).slice(0, NOTIF_BOUNDS.layout_keys)) {
      if (typeof key !== 'string' || key.trim() === '' || !value || typeof value !== 'object'
        || Array.isArray(value)) { layoutDropped += 1; continue }
      const list = (name) => {
        const items = Array.isArray(value[name]) ? value[name] : []
        const kept = [...new Set(items.map(clean).filter((item) => item !== ''))]
        layoutDropped += Math.max(0, items.length - kept.length) + Math.max(0, kept.length - NOTIF_BOUNDS.layout_items)
        return kept.slice(0, NOTIF_BOUNDS.layout_items)
      }
      layout[key] = { order: list('order'), collapsed: list('collapsed'), hidden: list('hidden') }
    }
    let filtersDropped = 0
    const filters = {}
    const rawFilters = source.filters && typeof source.filters === 'object' && !Array.isArray(source.filters)
      ? source.filters : {}
    for (const [key, value] of Object.entries(rawFilters).slice(0, NOTIF_BOUNDS.filters)) {
      if (typeof key !== 'string' || key.trim() === '') { filtersDropped += 1; continue }
      const plain_ = (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        ? String(value) : ''
      if (plain_ === '' || Buffer.byteLength(plain_, 'utf8') > NOTIF_BOUNDS.filter_bytes) { filtersDropped += 1; continue }
      filters[key] = plain_
    }
    return { state: { read: read.slice(-NOTIF_BOUNDS.read), muted, min_level: level, layout, filters },
      dropped: { malformed: cut, over: over + Math.max(0,
        (Array.isArray(source.muted) ? source.muted.length : 0) - muted.length),
      layout: layoutDropped, filters: filtersDropped } }
  }
  const notifWrite = (doc) => {
    try {
      mkdirSync(notifDir, { recursive: true, mode: 0o700 })
      try { chmodSync(notifDir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmp = join(notifDir, `.notif-state.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify({ schema: NOTIF_SCHEMA, identities: doc.identities }, null, 1) + '\n',
        { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)                          // 显式：不受 umask 影响（偏好文件必须**恰为** 0600）
      renameSync(tmp, notifFile)
      return { ok: true, file: notifFile, mode: '0600' }
    } catch (err) {
      return { ok: false, code: 'notif-state-write-failed', reason: String(err).slice(0, 160),
        next_action: '先修 <ui_shared>/webui 目录权限（通知偏好文件必须 0600）' }
    }
  }
  /** 读一个身份的服务端通知状态（没有 ⇒ 空状态；**不伪造**别的身份的记录）。 */
  const notifStateOf = (req) => {
    const who = identity.whoOf(req)
    if (!who.ok) {
      return { status: 401, body: { ok: false, code: who.code, reason: who.reason,
        next_action: who.next_action, source: 'none',
        note: '未登录时通知偏好只在本浏览器里有效（localStorage）；登录后**落服务端**（0600），跨设备仍在' } }
    }
    const doc = notifRead()
    const stored = doc.identities[who.human]
    return { status: 200, body: { ok: true, identity: who.human, side: who.side, source: stored ? 'server' : 'empty',
      state: stored ?? { read: [], muted: [], min_level: 'info', layout: {}, filters: {} },
      file: notifFile, mode: '0600', bounds: NOTIF_BOUNDS,
      note: '通知偏好 / 已读 / **面板布局** / **筛选片**按**会话身份**落在服务端（0600 文件）：'
        + '换浏览器、换设备仍在；它不是账本事实（偏好不是业务承诺）。' } }
  }
  /**
   * 这次请求的会话身份在服务端存的**已读 id 集合**（通知窗口据此算"未读"；**不改任何东西**）。
   * 未登录 ⇒ `null`：服务端不知道谁读过什么（那时界面如实说"未读只按本页算"，不猜、不冒充）。
   */
  const notifReadSetOf = (req) => {
    const who = identity.whoOf(req)
    if (!who.ok) return null
    const stored = notifRead().identities[who.human]
    return Array.isArray(stored?.read) ? stored.read : []
  }
  /** 写一个身份的服务端通知状态（整体替换：标为已读/未读都要能生效）。 */
  const notifSave = (req, payload) => {
    const who = identity.whoOf(req)
    if (!who.ok) {
      return { status: 401, body: { ok: false, code: who.code, reason: who.reason,
        next_action: who.next_action } }
    }
    const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload.state && typeof payload.state === 'object' ? payload.state : payload) : {}
    const { state, dropped } = notifSanitize({ read: raw.read, muted: raw.muted,
      min_level: raw.min_level ?? raw.minLevel, layout: raw.layout ?? payload?.layout,
      filters: raw.filters ?? payload?.filters })
    const doc = notifRead()
    doc.identities[who.human] = { ...state, saved_at: new Date().toISOString() }
    // 有界：最多留 64 个身份（丢最久没更新的 —— 丢的是偏好，不是事实）
    const names = Object.keys(doc.identities)
    if (names.length > 64) {
      names.sort((left, right) => String(doc.identities[left]?.saved_at ?? '')
        .localeCompare(String(doc.identities[right]?.saved_at ?? '')))
      for (const old of names.slice(0, names.length - 64)) delete doc.identities[old]
    }
    const written = notifWrite(doc)
    if (!written.ok) return { status: 500, body: { ok: false, ...written } }
    return { status: 200, body: { ok: true, identity: who.human, side: who.side, source: 'server',
      state, dropped, file: written.file, mode: written.mode,
      note: '已写到服务端（0600）：换浏览器/换设备后仍在（读回同一份文件）' } }
  }
  console.error(`[webui] 身份与会话路由：${identityRoutes.routes.filter((row) => row.ok).length} 条已注册`
    + `${identityRoutes.ok ? '' : `（有被拒：${identityRoutes.routes.filter((row) => !row.ok)
      .map((row) => `${row.method} ${row.path}=${row.code}`).join(',')}）`}`)
  // 插件贡献的**发现式装载**（任何插件放 `code/ui.mjs` 就会被装载；装载失败如实记日志，不静默吞）
  Promise.resolve(shell.loadContributions()).then((summary) => {
    const bad = summary.filter((row) => row.ok === false)
    console.error(`[webui] GUI 贡献装载：${summary.length} 个插件`
      + `${bad.length ? `，其中失败 ${bad.map((row) => row.plugin_id).join(',')}` : '，全部成功'}`)
  }).catch((err) => console.error(`[webui] GUI 贡献装载异常：${String(err).slice(0, 160)}`))
  // 视角 → 账本：配了自有账本就用它（结构性隔离），否则退回注入的只读视图（fixture/单账本模式）
  //
  // ---- 账本只读**备忘**（P13：并发卡死定位到的热点就在这一行下面）------------------------------------
  // 定位（真跑 `node --cpu-prof` 抓的 self time，原始读数 `tmp/p13-shots/cpu-before.json`）：
  // 一次页面渲染的**忙时 CPU 有 ~87% 花在"把同一份账本重新读一遍 + 逐行 JSON.parse"**上 ——
  //   `ledger-view.mjs:20`（JSON.parse 那一行）27.2% + `node:fs readFileSync` 22.9%
  //   + `ledger-view.mjs:18 read` 4.2% + `readFileUtf8` 2.1%（另有 1.9% GC 是这些临时对象的账），
  // 因为 `rowsOf(view)` 每次都被 `host.rows(view)` 重新调一遍：**每块面板、每个通知源、每个状态项
  // 各一次**（`openLedger()` 每次都新建一个闭包，里面只有 `verify()` 有 mtime 缓存，`rows()` 没有）。
  // 于是打开一页 = 把 1.6 MB 的账本读+parse 几十上百遍；而这一切**同步**跑在 Node 唯一的主线程上
  // ⇒ 整个进程被占死：6 个并发客户端实测 notifications p50 34.6s / `/api/ui/status` 46s /
  // 独立健康探针 44s 无响应（`tmp/p13-shots/concurrent-before.json`），与 P12 记录的"100% CPU、
  // status 50s 无响应、只能 kill"同源。
  //
  // 修法（机制层，**不动内核**、不改任何语义、不限制功能）：按 **(路径, mtimeMs, size)** 备忘
  // "投影后的行"，只有文件真的变了才重新读。账本是 append-only ⇒ 任何一次落账都会让 mtime/size 变，
  // 所以备忘**不会读到旧值**；`rows()` 每次返回**新数组**（只是元素对象共用，而调用方拿到的都是
  // 只读投影，仓库里没有任何一处就地改行对象或就地 sort 返回的数组）。字面量、字段、顺序与修前逐字节一致。
  const ledgerMemo = new Map()            // 路径 → { stamp, rows, realms, degraded }
  /**
   * **P34：账本文件读数的加固层**（口径 = `src/system/webui/docs/retention-and-storage.md` §坏账本）。
   *
   * 上游 `lib/ledger-view.mjs#rows()` 是**裸读**（`split('\n').map(JSON.parse)`）：一行读不出来
   * （半截 JSON / UTF-8 被截断 / 权限 0000）它**抛**，而面板侧对 `data()` 抛错的处理是整块 `data-failed`
   * / SSR 侧是整页 500；路径若是 FIFO/字符设备则**永久阻塞**（事件循环被占死）。
   * 这里只加一层**读数闸门 + 容错读**：好行走上游原路（逐字节一致），坏行**逐条计数、好行照列**，
   * 读不出来**照实说**（具名 reason + 下一步）——不改账本、不改事件语义、不写任何文件。
   */
  const LEDGER_READ = { max_bytes: 64 * 1024 * 1024 }
  /** 闸门：只读**普通文件**（不存在 ⇒ ledger-missing；FIFO/设备/目录 ⇒ 具名拒绝；超大 ⇒ 拒绝整份读）。 */
  const ledgerFileGate = (path) => {
    let info = null
    try { info = statSync(path) } catch (err) {
      const code = String(err?.code ?? 'unknown')
      return { ok: false, code: code === 'ENOENT' ? 'ledger-missing' : 'ledger-stat-failed',
        reason: `读不到账本文件（${code}）：${path}`,
        next_action: code === 'ENOENT'
          ? '确认这一侧的账本路径（--ledger-contractor / --ledger-supplier）指向真的要读的那份文件；'
            + '文件还没生成时不编造任何事实，界面照实说"这一侧还没有账本"'
          : '先修这个路径的可达性（权限/挂载），再重读这一页' }
    }
    if (!info.isFile()) {
      return { ok: false, code: 'ledger-not-a-regular-file',
        reason: `账本路径不是普通文件（是 ${info.isDirectory() ? '目录' : '设备/FIFO/套接字'}）：${path}`,
        next_action: '账本必须是 NDJSON 普通文件：宿主拒绝从这里读（设备/FIFO 会一直读下去、把内存吃光；目录读不出行），'
          + '也不猜它的内容 —— 先把它指回真的账本文件' }
    }
    if (info.size > LEDGER_READ.max_bytes) {
      return { ok: false, code: 'ledger-too-large',
        reason: `账本 ${info.size} B 超过宿主整份读入的上限 ${LEDGER_READ.max_bytes} B（${path}）`,
        next_action: `宿主不把 ${Math.round(LEDGER_READ.max_bytes / 1048576)} MiB 以上的账本整份读进内存（会吃光内存）；`
          + '先用 Python 侧工具按 seq 分页/归档这一份，或把上限调到与现场相符' }
    }
    return { ok: true, info }
  }
  /**
   * 容错读：与 `lib/ledger-view.mjs#rows()` **同一投影形状**（seq/type/correlation_id/actor/ts/body），
   * 差别只在坏行 —— 坏行跳过并**计数**（`dropped` + 第一处行号），`realm` 也照同一判据取（realms 用）。
   */
  const tolerantLedgerRead = (path) => {
    // **只在普通文件上读**（FIFO/设备会一直读下去或永久阻塞：连容错读也不碰它们）
    let info = null
    try { info = statSync(path) } catch (err) {
      return { ok: false, code: 'ledger-stat-failed', reason: `读不到账本文件（${err?.code ?? 'unknown'}）：${path}`,
        next_action: '先修这个路径的可达性（权限/挂载），再重读这一页',
        rows: [], realms: [], dropped: 0, first_bad_line: 0, lines: 0, bytes: 0 }
    }
    if (!info.isFile()) {
      return { ok: false, code: 'ledger-not-a-regular-file',
        reason: `账本路径不是普通文件：${path}`,
        next_action: '账本必须是 NDJSON 普通文件；宿主既不读设备/FIFO，也不猜它的内容',
        rows: [], realms: [], dropped: 0, first_bad_line: 0, lines: 0, bytes: 0 }
    }
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch (err) {
      const code = String(err?.code ?? 'unknown')
      return { ok: false, code: 'ledger-unreadable', reason: `账本读不出来（${code}）：${path}`,
        next_action: code === 'EACCES' || code === 'EPERM'
          ? '账本权限不足：请运维把它改成可读（账本写入方 0600 是纪律，但**读**这一侧的进程要能读）'
          : '先修这一份账本的可读性（权限/挂载/文件系统），再重读这一页 —— 面板不拿空表顶替',
        rows: [], realms: [], dropped: 0, first_bad_line: 0, lines: 0, bytes: 0 }
    }
    const rows = []
    const realms = new Set()
    let dropped = 0
    let firstBad = 0
    let lines = 0
    const parts = text.split('\n')
    for (let at = 0; at < parts.length; at += 1) {
      const line = parts[at]
      if (line.trim() === '') continue
      lines += 1
      let row = null
      try { row = JSON.parse(line) } catch (err) { row = null }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        dropped += 1
        if (!firstBad) firstBad = at + 1
        continue
      }
      rows.push({ seq: row.seq, type: row.type, correlation_id: row.correlation_id,
        actor: row.actor, ts: row.ts, body: row.body })
      if (typeof row.realm === 'string' && row.realm.trim() !== '') realms.add(row.realm.trim())
    }
    return { ok: true, code: '', reason: '', next_action: '', rows, realms: [...realms].sort(),
      dropped, first_bad_line: firstBad, lines, bytes: Buffer.byteLength(text, 'utf8') }
  }
  /** 坏行的**屏幕说法**（不静默丢：好行照列、坏行报数 + 指到第一处行号）。 */
  const ledgerDegradedOf = (path) => {
    const memo = ledgerViews.get(resolve(path))
    const health = typeof memo?.health === 'function' ? memo.health() : null
    return health?.degraded ?? null
  }
  const ledgerStampOf = (path) => {
    try {
      const stat = statSync(path)
      return `${stat.mtimeMs}:${stat.size}`
    } catch (err) {
      return `missing:${String(err?.code ?? 'unknown')}`
    }
  }
  const memoLedger = (path, view) => {
    const raw = openLedger(path)
    const fresh = () => {
      const stamp = ledgerStampOf(path)
      const hit = ledgerMemo.get(path)
      if (hit && hit.stamp === stamp) {
        ledgerStats.memo_hits += 1
        // 同一块面板一次渲染里会问好几次"本视角的行"：第 2 次起就走这里（这是本批性能的来源）
        return hit
      }
      const started = Date.now()
      // ---- P34：先过读数闸门（非普通文件/超大/不存在 ⇒ 具名降级，**不进**上游裸读）----
      const gate = ledgerFileGate(path)
      let rows = []
      let degraded = null
      let tolerant = null
      if (gate.ok) {
        try {
          rows = raw.rows()               // 好数据走**上游原路**（逐字节一致，一个字都不改）
        } catch (err) {
          // 一行读不出来（半截 JSON / UTF-8 截断 / EACCES）⇒ 容错读：坏行计数、好行照列
          tolerant = tolerantLedgerRead(path)
          rows = tolerant.rows
          degraded = tolerant.ok
            ? { code: 'ledger-lines-unreadable', dropped: tolerant.dropped,
              first_bad_line: tolerant.first_bad_line, lines: tolerant.lines, bytes: tolerant.bytes,
              reason: `${path} 有 ${tolerant.dropped} 行读不出来（第一处在第 ${tolerant.first_bad_line} 行）`
                + `：${String(err?.message ?? err).slice(0, 120)}`,
              next_action: '好行照列（这一页的其它数字都来自它们）；坏行**不猜、不丢**：'
                + '先按行号去修那一行（半截/编码截断的尾部常见于写入中断），或用 Python 侧账本工具核对链' }
            : { code: tolerant.code, dropped: 0, first_bad_line: 0, lines: 0, bytes: 0,
              reason: tolerant.reason, next_action: tolerant.next_action }
        }
      } else {
        degraded = { code: gate.code, dropped: 0, first_bad_line: 0, lines: 0, bytes: 0,
          reason: gate.reason, next_action: gate.next_action }
      }
      ledgerStats.parses += 1
      ledgerStats.ms += Date.now() - started
      try { ledgerStats.bytes += statSync(path).size } catch (err) { /* 读不到就不记账 */ }
      if (degraded) {                       // **不静默**：降级路径进读数面（`/api/ui/surface` 的 io.ledger）
        ledgerStats.degraded = ledgerStats.degraded ?? []
        ledgerStats.degraded.push({ view, path, code: degraded.code, dropped: degraded.dropped,
          first_bad_line: degraded.first_bad_line })
      }
      const entry = { stamp, rows, realms: null, degraded, tolerant }
      ledgerMemo.set(path, entry)
      return entry
    }
    return {
      path, view,
      rows: () => fresh().rows.slice(),
      realms: () => {
        const entry = fresh()
        if (entry.realms === null) {
          if (entry.degraded) {
            // 降级时**不碰**上游裸读（FIFO/设备会永久阻塞）：用同一份容错读的 realm
            const read = entry.tolerant ?? tolerantLedgerRead(path)
            entry.realms = Array.isArray(read.realms) ? read.realms : []
          } else {
            try { entry.realms = raw.realms() } catch (err) {
              const read = tolerantLedgerRead(path)
              entry.realms = Array.isArray(read.realms) ? read.realms : []
            }
          }
        }
        return entry.realms.slice()
      },
      count: () => {
        const entry = fresh()
        if (entry.degraded) return entry.rows.length       // 坏行时：好行的条数（不拿上游的抛顶替）
        return raw.count()
      },
      byType: (prefix) => {
        const entry = fresh()
        if (entry.degraded) return entry.rows.filter((row) => String(row.type).startsWith(prefix))
        return raw.byType(prefix)
      },
      /** 降级读数（`null` = 这一份账本读得干干净净）：坏行条数/第一处行号/人话原因与下一步。 */
      health: () => ({ degraded: fresh().degraded }),
      verify: () => {
        const gate = ledgerFileGate(path)
        if (!gate.ok) {
          // 非普通文件/超大/不存在：**不**把路径喂给 Python 侧链校验（FIFO 会读不完、超大文件会打满内存）
          return { ok: false, checked: 0, count: 0, reason: gate.code }
        }
        return raw.verify()
      },
    }
  }
  const ledgerViews = new Map()
  const projectionMemo = new Map()       // (视角 + 账本戳 + 投递戳) → 投影结果（纯函数，可缓存）
  const ledgerOf = (view) => {
    const own = view === 'contractor' ? config.ledger_contractor : config.ledger_supplier
    if (!own) return ctx.ledgerView      // 夹具/单账本模式：注入的只读视图（没有文件可 stamp，原样透传）
    const key = resolve(own)
    let memo = ledgerViews.get(key)
    if (!memo) {
      memo = memoLedger(own, view)
      ledgerViews.set(key, memo)
      ledgerStats.paths = ledgerViews.size
    }
    return memo
  }

  const rowsFor = (view) => projectionOf(view).publicRows

  /**
   * 投递信封（**只读、有界、确定性**）：发送方放进共享交换目录的交付件，每份形如
   * `{delivered_to: [...], rev, sent_at, snapshot_hash, spec: {...}}`（真供应商进程在 g1 走查里读的
   * 就是这份文件 —— 见 `src/quotagent/g1side.py` 的 `_read(shared, "contractor", "01-package")`）。
   *
   * 纪律：宿主**只读**这些文件（零写面）；读不到 / 坏文件 ⇒ 不加猜测、不编包（投影侧如实报 skipped）。
   * 目录形态按**文件名排序**且有界（`RFQ_DELIVERY_MAX_FILES`）：同一批文件在任何时刻给出同一结果。
   */
  const RFQ_DELIVERY_MAX_FILES = 64
  // 投递信封的**只读备忘**（同一件东西一次渲染只读一次）：按"目标路径 + 该文件的
  // mtime/size"（目录时另加"目录 mtime + 文件数"）判有没有变。信封是**发送方写的文件**，
  // 变了就重读 —— 不缓存"变化前"的内容。
  const deliveryMemo = { key: '', value: null }
  const deliveryEnvelopes = () => {
    const target = String(config.rfq_delivery ?? '').trim()
    if (target === '') return []
    let files = [target]
    try {
      if (!existsSync(target)) return []
      if (statSync(target).isDirectory()) {
        files = readdirSync(target).filter((name) => name.endsWith('.json')).sort()
          .slice(0, RFQ_DELIVERY_MAX_FILES).map((name) => join(target, name))
      }
    } catch (err) {
      console.error(`[webui] 投递信封目录不可读（按无投递处理）：${String(err).slice(0, 120)}`)
      return []
    }
    const key = `${target}\u0000${files.map((file) => ledgerStampOf(file)).join('\u0000')}`
    if (deliveryMemo.key === key && deliveryMemo.value) return deliveryMemo.value.slice()
    const out = []
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed)
      } catch (err) {
        console.error(`[webui] 投递信封不可解析（跳过，不猜）：${file}`)
      }
    }
    deliveryMemo.key = key
    deliveryMemo.value = out
    return out.slice()
  }

  /**
   * 本视角的**一次**投影：账本公开行 + （只对声明消费投递事实的视角）**发给本视角的** RFQ 包事实。
   * 身份来自**本视角自己的账本**（`realms()`），绝不来自信封 —— 否则等于让发送方决定收件人是谁。
   */
  const projectionOf = (view) => {
    const ledger = ledgerOf(view)
    // 投影是**纯函数**（本视角账本行 + 发给本视角的投递信封 + realm + 上限）：输入没变就复用。
    // 与账本备忘同一把尺子（mtime:size）⇒ 账本一变，投影立刻重算，不会给出旧白名单结果。
    const stamp = typeof ledger.path === 'string' ? ledgerStampOf(ledger.path) : ''
    const usesDelivery = (projection.deliveryViews ?? []).includes(view)
    const cacheKey = `${view}\u0000${ledger.path ?? ''}\u0000${stamp}\u0000${usesDelivery ? 'delivery' : ''}`
      + `\u0000${config.rfq_delivery_max ?? ''}`
    const cached = ledger.path && projectionMemo.get(cacheKey)
    if (cached) {
      ledgerStats.projection_hits = (ledgerStats.projection_hits ?? 0) + 1
      return { ...cached, publicRows: cached.publicRows.slice() }
    }
    const realms = typeof ledger.realms === 'function' ? ledger.realms() : []
    const deliveries = usesDelivery ? deliveryEnvelopes() : undefined
    const out = projection.projectWithAudit(view, ledger.rows(), { deliveries, realms,
      maxPackages: config.rfq_delivery_max })
    if (out.audit.length) {
      // 审计只走 stderr（宿主日志）；响应体里不得出现私域键名
      console.error(`[webui] ${view} 视角抑制 ${out.audit.length} 行：${out.audit.map((item) => item.suppressed_key).join(',')}`)
    }
    for (const item of out.deliveries?.audit ?? []) {
      console.error(`[webui] ${view} 视角投递事实抑制：${item.reason}（package_id=${item.package_id}）`)
    }
    if (ledger.path) {
      ledgerStats.projections = (ledgerStats.projections ?? 0) + 1
      projectionMemo.set(cacheKey, out)
    }
    return { ...out, publicRows: out.publicRows.slice() }
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
  const adminGuard = ctx.adminGuard         // 管理员 token / 会话 / 冷却（subagent 产出，T-272）
  const adminView = ctx.adminView           // 系统管理快照的只读聚合（同上）
  const pluginMarket = ctx.pluginMarket      // 插件列表/市场的只读聚合（subagent 产出，T-267）
  const userPlugins = ctx.userPluginManager  // 用户空间插件管理面（subagent 产出，T-268）
  const configView = ctx.configView          // 配置与凭据的可视面 + 干跑 + 待处理项（本批新增模块）
  const mailView = ctx.mailView              // 邮件域（SMTP/IMAP）的只读运维视图（**本批新增模块**）
  const bid = ctx.bidHeuristics              // 比价 heuristics（domain 插件，T-279）：只做算术，不读账本
  // `ctx.advicePanel`（决策建议）仍在 `inject` 里，但**本文件已不再调用它**：它的旧 SSR 页
  // （`/<view>/advice/`）本批按 29 §2 退役（见 `RETIRED_SUBVIEWS`），GUI 面板承接同一件事。
  const gates = ctx.gateTimeline             // 审批等多久 / 变更单谁卡着（domain 插件）：只吃白名单载荷，不读账本、不取墙钟
  const authority = ctx.authorityBand        // 授权区间（domain 插件，本批）：只读配置快照（authority.* 键），不读账本、不取墙钟、**不能批准**
  const deadline = ctx.rfqDeadline           // RFQ 回文时限（domain 插件，本批）：只吃白名单事实载荷，不读账本、不发信、不取墙钟、**不能代发**
  const prepare = ctx.quotePrepare           // 报价草稿（domain 插件，本批）：只吃白名单事实载荷，不读账本、不写文件、不取墙钟、**不能签名**
  const feedback = ctx.uiFeedback            // WebUI 反馈闭环（ui-feedback 插件）：版本事实只读 + 只落 0600 待办件

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
      + `<p><small><b>改配置不用跳 admin 道</b>：邮件（SMTP/IMAP）配置的界面入口在 `
      + `<a href="${prefix}/mail/config/" data-mail-config-link="1">${prefix}/mail/config/</a>`
      + `（**运维侧身份**登录后可改并持久化：干跑 → 0600 待办件 → <code>config-apply.py</code> 落 YAML；`
      + `凭据只写不回显）；GUI 工作台首屏也有一块「邮件通道」面板指向它。`
      + `本页 **0 行 <code>&lt;script&gt;</code>、0 内联事件**：读用链接，写面在身份页。</small></p>`
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
    // P32：`payload.rows` 是**工具/插件服务面给的行数组**（不是本文件构造的）⇒ 走唯一读数入口
    const ranked = readRows(payload.rows)
    const rows = ranked.rows.map((row) => `<tr data-row="${esc(row?.code)}" data-rank="${row?.rank}">`
      + `<td>${esc(row?.rank)}</td><td><code>${esc(row?.code)}</code></td><td data-score="${esc(row?.score)}">${esc(row?.score)}</td>`
      + HEURISTICS_FACTORS.map(([factor]) => `<td data-contribution="${factor}">${esc(row?.contributions?.[factor])}</td>`).join('')
      + `<td>${esc((row?.coverage?.present ?? []).map(heuristicsLabel).join('/') || '—')}</td>`
      + `<td>${esc((row?.coverage?.missing ?? []).map(heuristicsLabel).join('/') || '无（五个因子都取得到）')}</td>`
      + `<td>${esc(row?.item ?? '—')}</td>`
      + `<td>${esc(row?.hint ?? '')}</td></tr>`).join('')
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
      + droppedNote(ranked, '候选')
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

  // 决策建议层（`advice-panel` 插件）：**旧 SSR 页已退役**（`RETIRED_SUBVIEWS`：`/<view>/advice/` 与
  // `/<view>/api/advice` 现为 303 → `/app/<view>/`）。本文件只留下**一处仍在用的读法**：`adviceChannels`
  // （邮件通道声明，被 `deadlineChannelOf` 复用）；插件仍在 `inject` 里（与 `host/webui.mjs` 的 inject
  // 镜像同源，收口要连门一起改 —— 已登记在 `docs/work/plans/webui-ui-defects.md`）。
  /** 事实时刻：本视角投影里最大的 `ts`（没有可解析的 `ts` 就是 null ⇒ 调用方不给时间类结论，不猜时钟）。 */
  const lastTsOf = (rows) => rows.map((row) => (typeof row?.ts === 'string' && row.ts.trim() !== '' ? row.ts.trim() : null))
    .filter((ts) => ts !== null).sort().pop() ?? null

  /** 通道声明：**邮件域快照**（与 `/api/mail` 同一个来源 —— `mail-view` 的只读投影）里 SMTP（发信链）那一档。
   *  来源与判定都没变（`services/mail_transport`），只是不再经过已退役的三域流水快照（29 §2）；
   *  IMAP 是收信链，与「这份约定能不能发出去」无关，故不在这条声明里。 */
  const adviceChannels = (view) => {
    const snap = mailSnapshot() || {}
    const out = []
    // 快照本身读不到 / 形状不对（`degraded`）⇒ **没有声明**：不拿全零的降级形状去冒充"通道不可用"
    // （与旧口径一致：快照里没有那一档 ⇒ 不做通道建议）
    if (snap.degraded === true) return out
    for (const [label, decl] of [['mail', snap.smtp]]) {
      if (!decl || typeof decl !== 'object' || Array.isArray(decl) || typeof decl.available !== 'boolean') continue
      if (out.some((item) => item.name === label)) continue
      out.push({ name: label, available: decl.available,
        reason: typeof decl.reason === 'string' ? decl.reason : '',
        next_action: typeof decl.next_action === 'string' ? decl.next_action : '' })
    }
    return out
  }

  // ==========================================================================================
  // 审批等多久 / 变更单到底是谁卡着（`gate-timeline` domain 插件，本批）
  //   · 正面回答两条 human problem：① 人工门挂了多久 / 卡在谁手里 / 再等下去会怎样 / 下一步；
  //     ② 每张变更单现在什么状态 / 谁欠谁一个动作 / 以哪条账本事件为凭。
  //   · 本文件只做一件事：把**本视角自己的行**过滤成白名单载荷（带私域键的行整行跳过并报数），
  //     派生全在 `host/modules/gate-timeline.mjs`（不读账本、不写文件、**不取墙钟**、不调模型）。
  //   · `as_of` = 本视角行里最大的 `ts`（**事实时刻**，不是墙钟）—— 等待时长因此可复算、不随刷新漂移。
  //   · 写面只有一处：`POST /<view>/gates/nudge` 落**一条 0600 待办件**（含用户原话 + 目标门 id +
  //     sha256），**账本零新增**（H1）；唯一落账本者是 `tools/gate-nudge.py`（落 `gate/nudged`，
  //     只记"谁在什么时候催过哪个门"，**不改门的判定**）。
  // ==========================================================================================
  const GATES_CAP = 64        // 喂给插件的每段条目上限（有界；两段各自截断，插件如实报 omitted）
  /** 人工门事件行的白名单投影（只读这几个键；带私域键的行整行跳过并计数）。 */
  const gateApprovalRows = (view) => {
    const out = []
    let skipped = 0
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) { skipped += 1; continue }
      if (!String(row?.type ?? '').startsWith('approval/')) continue
      out.push({ approval_id: body.approval_id, type: row.type, ts: row?.ts, scope: body.scope, ref: body.ref,
        summary: body.summary, approvers: body.approvers, escalate_to: body.escalate_to,
        timeout_policy: body.timeout_policy, timeout_s: body.timeout_s })
    }
    return { rows: out, skipped }
  }
  /** 变更单事件行的白名单投影（**不读 `lines`**：逐行明细不是本页的口径来源）。 */
  const gateChangeRows = (view) => {
    const out = []
    let skipped = 0
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) { skipped += 1; continue }
      if (!String(row?.type ?? '').startsWith('change/')) continue
      out.push({ change_id: body.change_id, type: row.type, ts: row?.ts, quote_id: body.quote_id,
        delta_amount: body.delta_amount, basis_unit_price_refs: body.basis_unit_price_refs,
        basis_unit_price_ref: body.basis_unit_price_ref, approved_by: body.approved_by,
        approval_id: body.approval_id, code: body.code })
    }
    return { rows: out, skipped }
  }
  const gatesPayload = (view) => {
    const approvals = gateApprovalRows(view)
    const changes = gateChangeRows(view)
    return {
      view,
      // **事实时刻**：本视角投影里最大的 ts（没有可解析的 ts 就是 null ⇒ 插件拒绝给等待时长，不猜时钟）
      as_of: lastTsOf(ledgerOf(view).rows()),
      approvals: approvals.rows.slice(0, GATES_CAP),
      changes: changes.rows.slice(0, GATES_CAP),
    }
  }
  /** 催办提交：插件只产载荷，**宿主只落一条 0600 待办件**（账本零新增；唯一落账本者是 Python 侧）。 */
  const submitNudge = (view, form) => {
    const out = gates.nudge(gatesPayload(view), { view, gate_id: String(form.get('id') ?? form.get('gate_id') ?? '').trim(),
      reason: form.get('reason') ?? '' })
    if (!out.ok) return { ...out, file: '' }
    const dir = join(String(config.ui_shared ?? '').trim(), 'gate-nudges')
    if (String(config.ui_shared ?? '').trim() === '') {
      return { ...out, ok: false, code: 'pending-write-failed', file: '',
        next_action: '宿主未配置 ui_shared：无法确定待办件目录，拒绝写任何地方' }
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const file = join(dir, `${out.id}.json`)
      if (existsSync(file)) {
        return { ...out, duplicate: true, file: `gate-nudges/${out.id}.json`,
          next_action: `待办件已存在（同一份门 + 理由）：跑 tools/gate-nudge.py --now <ISO8601> 消费它（唯一落账本者）` }
      }
      const tmp = join(dir, `.${out.id}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(out.record, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)                      // 显式 chmod：不受 umask 影响（待办件必须**恰为** 0600）
      renameSync(tmp, file)
      return { ...out, duplicate: false, file: `gate-nudges/${out.id}.json` }
    } catch (err) {
      return { ...out, ok: false, code: 'pending-write-failed', file: '',
        next_action: `待办件写失败（${String(err && err.code ? err.code : err).slice(0, 40)}）：先修目录权限再重提` }
    }
  }

  // ==========================================================================================
  // 变更单**逐行明细**（`gate-timeline` 插件的规则 ⑤，同一个插件不另起）：
  //   `GET /<view>/changes/<id>/`（SSR）+ `GET /<view>/api/changes/<id>`（JSON）
  //   · 本文件只做一件事：把**本视角自己的**这张变更单的行过滤成白名单载荷（带私域键的行整行跳过并报数），
  //     派生全在插件里（金额**整数分**、缺依据的行**排除出小计**、私域列白名单、有界、确定性）；
  //   · 这两条路由**零写面**（账本零新增）、不取墙钟（`as_of` = 本视角投影里最大的 **事实 ts**）；
  //   · 未知变更单 id ⇒ **404** + `next_action`（指向列表页拿真 id，不猜 id、也不编行）。
  // ==========================================================================================
  /** 账本行的字段名别名（`services/change.py` 的既有写法：`ref_line`/`old_qty`/`new_unit_price`/`basis_unit_price`）。 */
  const CHANGE_LINE_ALIASES = {
    line_id: ['line_id', 'ref_line'],
    desc: ['desc', 'description'],
    qty_before: ['qty_before', 'old_qty'],
    unit_price_before: ['unit_price_before', 'old_unit_price', 'basis_unit_price'],
    qty_after: ['qty_after', 'new_qty'],
    unit_price_after: ['unit_price_after', 'new_unit_price'],
  }
  /**
   * **账本侧的金额是元**（`services/change.py` 的行里是小数元，如 `86.0`），而本页与插件的口径是
   * **整数分**（`money_unit=cents`）—— 折算由宿主这一处做，口径是 **half-up 到分位**
   * （`rounding=half-up-to-cent`：第 3 位小数 ≥5 就进位、负值远离零），全程**字符串 + 整数**运算，
   * **不引入浮点漂移**；认不出的形状（科学计数法等）返回 `null` ⇒ 交给插件记成**缺依据**（不猜）。
   */
  const centsOf = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return centsOf(String(value))
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null
    const negative = text.startsWith('-')
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.')
    const digits = (fraction + '000').slice(0, 3)
    const cents = Number(whole) * 100 + Number(digits.slice(0, 2))
    const rounded = Number(digits.slice(2)) >= 5 ? cents + 1 : cents
    return negative ? -rounded : rounded
  }
  /** 数量**只认整数件**（`150` / `150.0` → 150）；`12.5` 这类非整数件返回 `null`（缺依据，不悄悄圆）。 */
  const countOf = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? value : null
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (!/^-?\d+(\.0+)?$/.test(text)) return null
    return Math.trunc(Number(text))
  }
  const PRIVATE_LINE_MARKS = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model']
  /**
   * 行级私域列：**只有"没有要防的另一方"的视角**（`VIEW_EXTRA_PRIVATE_KEYS` 为空且本视角
   * `privateKeys` 为空，如承包商）才把自己的私域列带上；另一侧返回 `null` ⇒ 连键名都不带。
   */
  const privateLineColumns = (line, view) => {
    const rule = rules[view] || { privateKeys: [] }
    if (((rule.privateKeys ?? []).length > 0) || ((VIEW_EXTRA_PRIVATE_KEYS[view] ?? []).length > 0)) return null
    const out = {}
    for (const key of Object.keys(line)) {
      const lowered = key.toLowerCase()
      if (lowered.includes('private') || PRIVATE_LINE_MARKS.includes(lowered)) out[key] = line[key]
    }
    return out
  }
  /** `body.lines` → 白名单行（字段名走别名表；**金额折算成整数分**、数量只认整数件；私域列按上一条规则
   *  带上或丢掉）——有界（同 `GATES_CAP`）。 */
  const changeLineRows = (raw, view) => {
    // P32：**跳过就要说出来**（不静默丢）—— 返回 `{rows, dropped, over}` 而不是只回数组；
    // `dropped` = 坏形状（非对象）条数、`over` = 超出单张单读取上限 `GATES_CAP` 而没读的条数。
    if (!Array.isArray(raw)) return { rows: [], dropped: 0, over: 0 }
    const out = []
    let dropped = 0
    const over = Math.max(0, raw.length - GATES_CAP)
    for (const line of raw.slice(0, GATES_CAP)) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) { dropped += 1; continue }
      const pick = (names) => {
        for (const name of names) {
          if (line[name] !== undefined && line[name] !== null) return line[name]
        }
        return null
      }
      const row = { line_id: pick(CHANGE_LINE_ALIASES.line_id), desc: pick(CHANGE_LINE_ALIASES.desc) ?? '',
        qty_before: countOf(pick(CHANGE_LINE_ALIASES.qty_before)),
        unit_price_before: centsOf(pick(CHANGE_LINE_ALIASES.unit_price_before)),
        qty_after: countOf(pick(CHANGE_LINE_ALIASES.qty_after)),
        unit_price_after: centsOf(pick(CHANGE_LINE_ALIASES.unit_price_after)) }
      const extra = privateLineColumns(line, view)
      if (extra !== null) for (const key of Object.keys(extra)) row[key] = extra[key]
      out.push(row)
    }
    return { rows: out, dropped, over }
  }
  /** 本视角的这一张变更单：**以最后一条带行清单的 `change/*` 事实行为真源**（账本只增不改 ⇒ 现行版本）；
   *  批准/拒绝这类事件**本身不带行清单**，所以不能拿"最后一条事件"当明细来源 —— 没有带行的行才退回最后一条
   *  （那种情况会如实说 `no-usable-lines`，而不是拿别的行凑数）。 */
  const changeDetailPayload = (view, id) => {
    let last = null
    let withLines = null
    let skipped = 0
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) { skipped += 1; continue }
      if (!String(row?.type ?? '').startsWith('change/')) continue
      if (String(body.change_id ?? '').trim() !== id) continue
      const lineRead = changeLineRows(body.lines, view)
      const entry = { type: row.type, ts: row?.ts, quote_id: body.quote_id,
        lines: lineRead.rows, dropped: lineRead.dropped, over: lineRead.over }
      last = entry
      if (Array.isArray(body.lines) && body.lines.length > 0) withLines = entry
    }
    const source = withLines === null ? last : withLines
    return { view, as_of: lastTsOf(ledgerOf(view).rows()), skipped_rows: skipped,
      dropped_rows: source === null ? 0 : (source.dropped ?? 0),
      over_rows: source === null ? 0 : (source.over ?? 0),
      change: source === null ? null
        : { change_id: id, quote_id: source.quote_id ?? '', ts: source.ts ?? '', lines: source.lines } }
  }
  const changeDetailRun = (view, id) => {
    const payload = changeDetailPayload(view, id)
    const run = gates.change_detail(payload)
    // **不静默丢**（P32）：webui 侧 `changeLineRows` 也会跳过坏形状的行 / 超上限的行 —— 跳过就要说出来
    const notes = [...(run.notes ?? [])]
    if (payload.dropped_rows > 0) notes.push(`change.lines 有 ${payload.dropped_rows} 条形状不对（不是对象）`
      + ' → 整条跳过（不猜）；好行照列')
    if (payload.over_rows > 0) notes.push(`change.lines 有 ${payload.over_rows} 条超出本页单张单读取上限 `
      + `${GATES_CAP} → 未读（有界，照实报）`)
    return { ...run, notes: notes.sort(), dropped_lines: payload.dropped_rows, lines_not_read: payload.over_rows }
  }
  /** JSON（机器可读；与页面同数据、同口径；金额单位与舍入口径一起给）。 */
  const changeDetailJson = (view, id) => {
    const run = changeDetailRun(view, id)
    const meta = gates.meta()
    return { view, change_id: id, service: 'gate-timeline',
      source: 'gate-timeline（domain 插件规则 ⑤：确定性规则；不读账本、不写账本、不取墙钟、不调模型）',
      engine: run.engine, engine_note: run.engine_note, as_of: run.as_of, as_of_basis: '本视角投影里最大的 ts（事实时刻）',
      money_unit: run.money_unit, rounding: run.rounding, money_note: run.money_note, line_keys: run.line_keys,
      lines: run.lines, basis_missing: run.basis_missing, subtotal: run.subtotal,
      private_columns: run.private_columns, private_columns_note: run.private_columns_note,
      counts: run.counts, bounds: run.bounds, truncated: run.truncated, omitted: run.omitted,
      degraded: run.degraded, reason: run.reason, next_action: run.next_action, notes: run.notes,
      privacy: run.privacy, ignored_now_inputs: run.ignored_now_inputs,
      meta: { engine: meta.engine, money_unit: meta.money_unit, rounding: meta.rounding,
        detail_reasons: meta.detail_reasons, line_keys: meta.line_keys,
        private_column_views: meta.private_column_views, can_approve: meta.can_approve },
      note: '金额一律**整数分**（money_unit=cents）参与运算、不出现浮点；`delta_amount = amount_after − amount_before`；'
        + '`delta_pct` 由整数分位 half-up 舍入（分母为 0 记 null）。**缺依据的行不得编数**：'
        + '缺原量/原价/新量/新价（或值不是整数件/整数分）的行列入 `basis_missing` 并**排除出小计**；'
        + '整张单一行可用都没有 ⇒ `degraded:true` + 有名 reason + 明细为空 + 小计记 null（不编 0 冒充「没变」）。'
        + '私域列只有业主侧看得见自己的；其余视角**读都不读**（带私域列与不带私域列输出逐字节一致）。'
        + '未知 id ⇒ 404 + `next_action`。' }
  }
  /** 页面（SSR，**零内联脚本**：数字、口径、依据全在 `<table>`/`<code>` 里，没有一行 JS）。 */
  const changeDetailHtml = (view, id, run) => {
    // P32：`run.lines` 是**插件服务面给的行数组**（gate-timeline 的逐行明细）⇒ 走唯一读数入口
    const linesRead = readRows(run.lines)
    const lineRows = linesRead.rows.map((line) => `<tr data-detail-line="${esc(line?.line_id)}"`
      + ` data-detail-usable="1" data-detail-delta="${esc(String(line?.delta_amount))}"`
      + ` data-detail-amount-before="${esc(String(line?.amount_before))}"`
      + ` data-detail-amount-after="${esc(String(line?.amount_after))}">`
      + `<td><code>${esc(line?.line_id)}</code><br><small>${esc(line?.desc)}</small></td>`
      + `<td>${esc(String(line?.qty_before))} × <b>${esc(String(line?.unit_price_before))}</b>`
      + ` = <b>${esc(String(line?.amount_before))}</b></td>`
      + `<td>${esc(String(line?.qty_after))} × <b>${esc(String(line?.unit_price_after))}</b>`
      + ` = <b>${esc(String(line?.amount_after))}</b></td>`
      + `<td><b>${esc(String(line?.delta_amount))}</b></td>`
      + `<td>${line?.delta_pct === null ? '<code>null</code>（原价为 0：分母 0 不猜百分比）'
        : `${esc(String(line?.delta_pct))}%`}</td>`
      + `<td data-detail-basis="${esc((line?.basis ?? []).join(' '))}">`
      + `${(line?.basis ?? []).map((token) => `<code>${esc(token)}</code>`).join(' ')}</td></tr>`).join('')
    const missingRows = run.basis_missing.map((item) => `<tr data-detail-missing="${esc(item.line_id)}"`
      + ` data-detail-missing-reason="${esc(item.reason)}">`
      + `<td><code>${esc(item.line_id)}</code></td>`
      + `<td>${item.missing.length > 0 ? item.missing.map((key) => `<code>${esc(key)}</code>`).join(' ') : '—'}</td>`
      + `<td><code>${esc(item.reason)}</code></td><td>${esc(item.note ?? '')}</td></tr>`).join('')
    const privateBlock = run.private_columns.length > 0
      ? `<h3 id="private">你自己的私域列（只有本视角看得见；另一侧连读都不读）</h3>`
        + `<table data-detail-private="1">${run.private_columns.map((item) => `<tr data-detail-private-line="${esc(item.line_id)}">`
          + `<td><code>${esc(item.line_id)}</code></td><td><code>${esc(item.key)}</code></td>`
          + `<td>${esc(String(item.value))}</td></tr>`).join('')}</table>`
      : ''
    return subNav(prefix, view, 'gates')
      // 「回列表」不再指向已退役的旧页（`/<view>/gates/` 现在 303）：直接去 GUI 视图页
      + `<p><a href="${prefix}/app/${view}/" data-detail-back="1">← 回 GUI 工作台（审批队列 / 变更）</a>`
      + ` · JSON：<code>${prefix}/${view}/api/changes/${esc(id)}</code></p>`
      + `<p data-change-detail="${esc(id)}" data-money-unit="${esc(run.money_unit)}"`
      + ` data-rounding="${esc(run.rounding)}"><b>金额口径</b>：${esc(run.money_note)}</p>`
      + `<p>参照事实时刻 <code>as_of=${esc(run.as_of ?? '（本视角还没有可解析的事件 ts）')}</code>`
      + `（= 本视角投影里最大的 <code>ts</code>，**不是墙钟**）；被忽略的墙钟入口：`
      + `<code>${esc(run.ignored_now_inputs.join(', '))}</code>（给它们任何值，本页数字都不变）。</p>`
      + (run.degraded
        ? `<p class="degraded" data-change-detail-degraded="1"><b>降级（不给你编行）</b>：`
          + `<code>${esc(run.reason)}</code> —— ${esc(run.next_action)}</p>`
        : '')
      + droppedNote(linesRead, '逐行明细')
      + (run.dropped_lines > 0
        ? `<p class="degraded" data-degraded="1" data-rows-dropped="${run.dropped_lines}">另有 `
          + `<b>${run.dropped_lines}</b> 条逐行明细读不出来（形状异常：不是对象）—— 好行照列，坏条已跳过并计数（不静默丢）。</p>`
        : '')
      + `<h3 id="lines">逐行明细（<b data-detail-line-count="${run.counts.lines_shown}">${run.counts.lines_shown}</b> 行；`
      + `可用 <b data-detail-usable-count="${run.counts.lines_usable}">${run.counts.lines_usable}</b> 行）</h3>`
      + (run.lines.length
        ? `<table data-detail="lines"><tr><th>行</th><th>原量 × 原单价 = 原金额（分）</th>`
          + `<th>新量 × 新单价 = 新金额（分）</th><th>差额（分）</th><th>差额%</th><th>依据（basis）</th></tr>`
          + `${lineRows}</table>`
        : '<p data-detail="lines-none">没有可核对的可用行（缺依据的行不会被拿来凑数）。</p>')
      + `<p data-detail-subtotal="1">行小计（**只含可用行**）：`
      + `原金额 <b data-subtotal-before>${run.subtotal.amount_before === null ? 'null' : esc(String(run.subtotal.amount_before))}</b>`
      + ` → 新金额 <b data-subtotal-after>${run.subtotal.amount_after === null ? 'null' : esc(String(run.subtotal.amount_after))}</b>`
      + `；**总计差额** <b data-subtotal-delta>${run.subtotal.delta_amount === null ? 'null' : esc(String(run.subtotal.delta_amount))}</b> 分`
      + `（${run.subtotal.delta_pct === null ? '<code>null</code>' : `${esc(String(run.subtotal.delta_pct))}%`}），`
      + `口径：<code>money_unit=${esc(run.money_unit)}</code> / <code>rounding=${esc(run.rounding)}</code>；`
      + `可用行 <b>${run.subtotal.lines}</b> 行。</p>`
      + `<h3 id="missing">未纳入小计的行（<b data-detail-missing-count="${run.basis_missing.length}">`
      + `${run.basis_missing.length}</b> 行）</h3>`
      + (run.basis_missing.length
        ? `<p>下表这些行**未纳入小计**（缺依据不得编数：宁可少算，也不编一个数）。</p>`
          + `<table data-detail="missing"><tr><th>行</th><th>缺哪个事实</th><th>原因码</th><th>说明</th></tr>`
          + `${missingRows}</table>`
        : '<p data-detail="missing-none">没有未纳入小计的行（每一行都有四件依据）。</p>')
      + `<p data-detail-private-note="1">${esc(run.private_columns_note)}</p>`
      + privateBlock
      + (run.notes.length
        ? `<ul data-detail="notes">${run.notes.map((text) => `<li>${esc(text)}</li>`).join('')}</ul>`
        : '<p data-detail="notes">说明：无（本次每一行都进了派生）</p>')
      + `<h3 id="next">下一步（可复制）</h3><pre>${esc(run.next_action)}</pre>`
      + `<p><small>**本页 0 行脚本、0 内联事件**：明细全部是服务端算好的数字与依据；`
      + `看这张单**不需要**任何审批动作 —— 变更生效要由**本人**在 GUI 里人签（<code>change.approve</code>，`
      + `署名 == 会话身份、服务端校验），界面不会替你签。</small></p>`
  }

  // ==========================================================================================
  // RFQ 回文时限（`rfq-deadline` domain 插件，本批）—— **「来不及回 RFQ：谁还没回 / 还差多久 /
  //   为什么发不出去」**（P-10「截止时间与催报没有入口」+ P-04「被迫回电脑前再算」的原话）：
  //   · 本文件只做一件事：把**本视角自己的行**过滤成白名单载荷（键白名单读取；名册三列的私域口径
  //     由插件声明 `meta.private_list_views`，宿主照抄），派生全在 `host/modules/rfq-deadline.mjs`
  //     （不读账本、不写文件、**不取墙钟**、不发信、不调模型）。
  //   · `as_of` = 本视角行里最大的 `ts`（**事实时刻**，不是墙钟）—— 剩余时长因此可复算、不随刷新漂移。
  //   · 写面只有一处：`POST /<view>/deadlines/promise` 落**一条 0600 待办件**（含**发言人**、
  //     **承诺回文时限**、RFQ id、原话的 sha256），**账本零新增**（H1）；唯一落账本者是
  //     `tools/rfq-promise.py`（落 `rfq/promised`，body **不含正文与凭据**）。
  //   · **本页一个字节都发不出去**：没有邮件凭据时报 `available=false` 与「无法代发」的事实，
  //     不出现任何\"发过了\"的表述（`meta.can_send=false`）。
  // ==========================================================================================
  const DEADLINE_CAP = 64        // 喂给插件的每段条目上限（有界；三段各自截断，插件如实报 omitted）
  /** 邮件通道事实：先认**邮件域快照**里 SMTP（发信链）那一档的声明（与 adviceChannels 同一口径），
   *  快照缺失才落到它的 `smtp` 明细；两处都没有 ⇒ **未声明 = 不可用**（不猜能发）。 */
  const deadlineChannelOf = (view) => {
    const declared = adviceChannels(view).find((item) => item.name === 'mail')
    if (declared) {
      return { kind: 'mail', configured: declared.available === true, connected: declared.available === true,
        available: declared.available === true,
        reason: declared.reason || (declared.available ? '' : 'transport-unavailable'),
        next_action: declared.next_action || '',
        source: '邮件域快照（mail-view 只读投影）的 smtp 声明（Python 侧写，宿主只读）' }
    }
    const snap = mailSnapshot() || {}
    const smtp = snap.smtp || {}
    return { kind: 'smtp', configured: smtp.configured === true, connected: smtp.connected === true,
      available: smtp.available === true,
      reason: smtp.reason || (smtp.available === true ? '' : 'mail-transport-unavailable'),
      next_action: smtp.next_action || '',
      source: '邮件状态快照（Python 侧写，宿主只读）' }
  }
  /** 本视角的 RFQ 事实行（`rfq/published` + 分发事实 `rfq/distributed`）；名册只有业主侧才装配。 */
  const deadlineRfqRows = (view) => {
    const owner = (deadline.meta().private_list_views ?? []).includes(view)
    const recipients = new Map()       // package_id → 分发事实里的收件人（「谁在何时收到哪个版本」）
    const rows = []
    let skipped = 0
    const refOf = (body, row) => [body.package_id, body.rfq_id, row?.correlation_id]
      .map((value) => (typeof value === 'string' ? value.trim() : '')).find((text) => text !== '')
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) { skipped += 1; continue }
      const type = String(row?.type ?? '')
      if (type === 'rfq/distributed') {
        const ref = refOf(body, row)
        if (!ref) continue
        const list = Array.isArray(body.recipients) ? body.recipients : []
        const bucket = recipients.get(ref) ?? new Set()
        for (const who of list) { if (typeof who === 'string' && who.trim() !== '') bucket.add(who.trim()) }
        recipients.set(ref, bucket)
        continue
      }
      if (type !== 'rfq/published') continue
      const ref = refOf(body, row)
      if (!ref) continue
      rows.push({ ref, rev: body.rev, ts: row?.ts, due_ts: body.quote_by, items: body.items,
        title: typeof body.subject === 'string' ? body.subject : (typeof body.title === 'string' ? body.title : null),
        declared: owner ? (body.invited ?? body.suppliers) : null })
    }
    // 发布行按包 id 字典序（确定性与入参顺序无关），名册 = 发布事实里的名单 ∪ 分发事实的收件人
    return { rows: rows.sort((left, right) => (left.ref < right.ref ? -1 : (left.ref > right.ref ? 1 : 0)))
      .map((item) => {
        const extra = owner ? [...(recipients.get(item.ref) ?? new Set())] : []
        const declared = Array.isArray(item.declared) ? item.declared
          : (typeof item.declared === 'string' ? [item.declared] : [])
        const invited = owner ? [...new Set([...declared, ...extra])].sort() : []
        return { rfq_id: item.ref, rev: item.rev, ts: item.ts, due_ts: item.due_ts, items: item.items,
          subject: item.title, invited }
      }), skipped }
  }
  /** 本视角的报价事实行（只读归属键 + 供应商 + ts：**私域列读都不读**）。 */
  const deadlineQuoteRows = (view) => {
    const out = []
    let skipped = 0
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) { skipped += 1; continue }
      if (String(row?.type ?? '') !== 'quote/submitted') continue
      out.push({ rfq_id: [body.package_id, body.rfq_id, row?.correlation_id]
        .map((value) => (typeof value === 'string' ? value.trim() : '')).find((text) => text !== '') ?? null,
        package_id: body.package_id, correlation_id: row?.correlation_id,
        supplier: typeof body.supplier === 'string' ? body.supplier : null, actor: row?.actor, ts: row?.ts })
    }
    return { rows: out, skipped }
  }
  /** 本视角的承诺事实行（`rfq/promised`：**唯一落账本者** `tools/rfq-promise.py` 落的那种）。 */
  const deadlinePromiseRows = (view) => {
    const out = []
    for (const row of ledgerOf(view).rows()) {
      const body = row && typeof row.body === 'object' && row.body !== null ? row.body : {}
      if (hasPrivateKey(body, view)) continue
      if (String(row?.type ?? '') !== 'rfq/promised') continue
      out.push({ rfq_id: [body.rfq_id, body.package_id, row?.correlation_id]
        .map((value) => (typeof value === 'string' ? value.trim() : '')).find((text) => text !== '') ?? null,
        due_at: body.due_at, ts: row?.ts, actor: body.actor })
    }
    return out
  }
  const deadlinePayload = (view) => {
    const rfqs = deadlineRfqRows(view)
    const quotes = deadlineQuoteRows(view)
    return {
      view,
      // **事实时刻**：本视角投影里最大的 ts（没有可解析的 ts 就是 null ⇒ 插件拒绝给剩余时长，不猜时钟）
      as_of: lastTsOf(ledgerOf(view).rows()),
      channel: deadlineChannelOf(view),
      rfqs: rfqs.rows.slice(0, DEADLINE_CAP),
      quotes: quotes.rows.slice(0, DEADLINE_CAP),
      promises: deadlinePromiseRows(view).slice(0, DEADLINE_CAP),
    }
  }
  const submitPromise = (view, form) => {
    const out = deadline.promise(deadlinePayload(view), {
      view,
      rfq_id: String(form.get('id') ?? form.get('rfq_id') ?? '').trim(),
      promise_by: String(form.get('by') ?? form.get('promise_by') ?? '').trim(),
      due_at: String(form.get('due_at') ?? '').trim(),
      note: form.get('note') ?? '',
    })
    if (!out.ok) return { ...out, file: '' }
    const shared = String(config.ui_shared ?? '').trim()
    if (shared === '') {
      return { ...out, ok: false, code: 'pending-write-failed', file: '',
        next_action: '宿主未配置 ui_shared：无法确定待办件目录，拒绝写任何地方' }
    }
    const dir = join(shared, 'rfq-promises')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const file = join(dir, `${out.id}.json`)
      if (existsSync(file)) {
        return { ...out, duplicate: true, file: `rfq-promises/${out.id}.json`,
          next_action: `待办件已存在（同一份 RFQ + 发言人 + 时限 + 原话）：跑 tools/rfq-promise.py --now <ISO8601> 消费它（唯一落账本者）` }
      }
      const tmp = join(dir, `.${out.id}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(out.record, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)                      // 显式 chmod：不受 umask 影响（待办件必须**恰为** 0600）
      renameSync(tmp, file)
      return { ...out, duplicate: false, file: `rfq-promises/${out.id}.json` }
    } catch (err) {
      return { ...out, ok: false, code: 'pending-write-failed', file: '',
        next_action: `待办件写失败（${String(err && err.code ? err.code : err).slice(0, 40)}）：先修目录权限再重提` }
    }
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

  // ==========================================================================================
  // 报价草稿（`quote-prepare` domain 插件，本批）—— **「把报价准备好：行项目 / 单价 / 交期 / 备注」**
  //   · 为什么要有这一步：**「员工填了单价、点了提交，浏览器回一页 200，什么都没发生」**是最伤信任的
  //     一条。本仓铁律「浏览器不得直接签署人工动作」不等于「浏览器什么都做不了」：**不需要签名的写动作
  //     必须在 APP 里真做成**。所以这里把闭环拆成三段，每段各自可验证：
  //       ① 准备（本页）：把「员工想报的这份报价」变成一条**结构化草稿载荷**，字段级校验；
  //       ② 落待办件（宿主）：`POST /<supplier>/quotes/prepare/` **只落一条 0600 待办件**（目录 0700、
  //          原子写），**账本零新增**（H1：宿主没有写账本的能力），回 202 + `next_action`；
  //       ③ 落账本（Python 侧 `tools/quote-draft.py`，**唯一落账本者**）：落 `quote/drafted`
  //          （**非签名动作**：只表示「报价已准备好」，body 不含备注正文）。
  //   · **双向可见性**：`quote/drafted` 在供应商账本（本方事实）与承包商账本（「供应商 X 已准备报价
  //     （待签署）」）各落一条；两侧页面都从**自己的**账本投影里读，不互相读对方的账本。
  //   · 「下一步（签署）」区域给**可复制的** CLI 命令（真实 RFQ / 行项目 / 金额整数分），并写清
  //     **本 APP 不代签**（页面标记 `data-signature-required="1"`，服务面 `can_sign=false`）。
  //   · 页面 **0 行脚本 / 0 内联事件**：全是 SSR 表格与文本。
  // ==========================================================================================
  /** 白名单事实键（多出来的键读都不读）。 */
  const PREP_FACT_KEYS = ['package_id', 'quote_id', 'supplier', 'item_id', 'item_ids', 'items', 'lines',
    'quote_draft_id', 'rfq_id', 'ok', 'currency', 'prepared_by', 'note_sha256', 'lines_sha256',
    'unit_price_cents', 'lead_time_days', 'line_count']
  /** 只读这两类事实行（草稿的目录与报价都从它们派生）。 */
  const PREP_ROW_TYPES = ['rfq/', 'quote/']
  /** 「准备报价」这一步属于哪个视角（真源在插件配置里；默认 `supplier`）。 */
  const prepView = () => (prepare.views()[0] ?? 'supplier')

  /** 本视角账本的 `realm`（供应商身份的真源；读不出来就空着，**不猜**）。
   *  口径：优先用只读视图的 `realms()`（它按设计保留 realm）；旧视图（fixture stub）没有这个方法时
   *  退回逐行读 `realm` 字段。 */
  const realmOf = (view) => {
    try {
      const ledger = ledgerOf(view)
      if (typeof ledger.realms === 'function') {
        const found = ledger.realms()
        if (Array.isArray(found) && found.length > 0) return String(found[0]).trim()
      }
      const row = ledger.rows()
        .find((item) => item && typeof item.realm === 'string' && item.realm.trim() !== '')
      return row ? row.realm.trim() : ''
    } catch (err) { return '' }
  }

  /** 白名单事实行：只读 `rfq/*` 与 `quote/*`；带私域键的行**整行跳过**（与其它道同一口径）。 */
  const prepFacts = (view) => {
    const out = []
    // P32：账本行是**外部给的**（NDJSON 文件）⇒ 走唯一读数入口，不再裸读元素属性。
    // 上游 `ledger-view#rows()` 只构造对象行 ⇒ 这里的 `bad` 结构性为 0（没有新增丢弃：非对象行
    // 本来就被下面的 `PREP_ROW_TYPES` 判据挡掉）；显式化是为了「漏一条坏形状 = 这条事实读不出来」
    // 而不是「整页崩」。
    for (const row of readRows(ledgerOf(view).rows()).rows) {
      const type = String((row && row.type) ?? '')
      if (!PREP_ROW_TYPES.some((prefix) => type.startsWith(prefix))) continue
      const raw = row && row.body
      const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      if (hasPrivateKey(body, view)) continue
      const fact = { type, ts: row.ts }
      for (const key of PREP_FACT_KEYS) {
        if (body[key] === undefined || body[key] === null) continue
        fact[key] = body[key]
      }
      // 草稿 id 的规范位置是 `correlation_id`（行 body 里也会写一份，缺了就用它兜底）
      if (type.startsWith('quote/drafted') && fact.quote_draft_id === undefined
        && typeof row.correlation_id === 'string') fact.quote_draft_id = row.correlation_id
      if (type.startsWith('quote/drafted')) fact.ok = body.ok === true
      out.push(fact)
      if (out.length >= 256) break
    }
    return out
  }
  const prepPayload = (view) => ({ view, as_of: lastTsOf(ledgerOf(view).rows()), facts: prepFacts(view) })
  const prepRun = (view) => prepare.prepare(prepPayload(view))

  /** 结构化行的**规范化 JSON**：与 `tools/quote-draft.py` 的 `canonical_lines()` 逐字节一致。
   *  单行（无 `lines`）5 键；**多行**（`lines` 非空）`{currency, lines[], rfq_id}` —— 键序必须是排序后的顺序
   *  （写者用 `json.dumps(sort_keys=True)`；`JSON.stringify` 只保留插入顺序）。 */
  const PREP_CANON = (record) => {
    const rows = Array.isArray(record.lines) && record.lines.length ? record.lines : null
    if (rows) {
      // 键序 = **字典序**（currency < lines < rfq_id）：写者 `json.dumps(sort_keys=True)`，
      // `JSON.stringify` 只保留插入顺序 —— 顺序写错就是另一个哈希（会被写者按 pending-tampered 拒）。
      return JSON.stringify({ currency: String(record.currency ?? ''),
        lines: rows.map((line) => ({ item_id: String(line.item_id ?? ''), lead_time_days: line.lead_time_days,
          unit_price_cents: line.unit_price_cents })),
        rfq_id: String(record.rfq_id ?? '') })
    }
    return JSON.stringify({ currency: String(record.currency ?? ''), item_id: String(record.item_id ?? ''),
      lead_time_days: record.lead_time_days, rfq_id: String(record.rfq_id ?? ''),
      unit_price_cents: record.unit_price_cents })
  }
  const prepSha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
  const prepBytes = (text) => Buffer.byteLength(String(text ?? ''), 'utf8')

  /** 字段规则表（**单一真源**：字段与上下界都由插件给，宿主只排版）。 */
  const prepRulesHtml = () => {
    const limits = prepare.limits()
    const rows = prepare.fields().map((field) => `<tr data-prep-field="${esc(field.name)}">`
      + `<td><code>${esc(field.name)}</code>${field.required ? ' <b>必填</b>' : ''}</td>`
      + `<td>${esc(field.label)}</td><td>${esc(field.rule)}</td></tr>`).join('')
    return `<table data-prep-fields="table"><tr><th>字段</th><th>名称</th><th>校验规则</th></tr>${rows}</table>`
      + `<p data-prep-limits="1">数值上下界：单价 <b>${esc(String(limits.unit_price_cents_min))}</b>..`
      + `<b>${esc(String(limits.unit_price_cents_max))}</b> 分（<code>money_unit=${esc(limits.money_unit)}</code>）；`
      + `交期 <b>${esc(String(limits.lead_time_days_min))}</b>..<b>${esc(String(limits.lead_time_days_max))}</b> 天；`
      + `备注 ≤ <b>${esc(String(limits.note_bytes_max))}</b> 字节。**越界一律拒、不夹取**`
      + `（夹取会合成一个你没报过的数）。校验失败会按字段给具体错误码，不吞成一句「参数错误」。</p>`
  }

  /** 行项目目录（**从本视角事实里读出来的真值**；读不出来就说读不出来，不编）。 */
  const prepCatalogueHtml = (run) => {
    const items = run.catalogue.items
    const table = items.length
      ? `<table data-prep-catalogue="table"><tr><th>行项目</th><th>参考单价（分）</th><th>来源</th></tr>`
        + items.map((item) => `<tr data-prep-item="${esc(item.item_id)}">`
          + `<td><code>${esc(item.item_id)}</code></td>`
          + `<td>${item.unit_price_cents === null ? '—' : esc(String(item.unit_price_cents))}</td>`
          + `<td><code>${esc(item.source || '—')}</code></td></tr>`).join('') + '</table>'
      : `<p data-prep-catalogue="empty"><b>不编行项目</b>：本视角的事实里读不到任何行项目`
        + `（<code>${esc(run.reason)}</code>）—— 先让 RFQ 事实进账本，再回来准备报价。</p>`
    const rfqIds = run.catalogue.rfq_ids
    const rfq = rfqIds.length
      ? rfqIds.map((id) => `<code data-prep-rfq="${esc(id)}">${esc(id)}</code>`).join(' ')
      : '<span data-prep-rfq-none="1">（本视角事实里还没有 RFQ 引用）</span>'
    return `<h3 id="catalogue">行项目目录与 RFQ 引用（本视角账本里的真值）</h3><p>RFQ 引用：${rfq}</p>${table}`
  }

  /** 草稿表（准备页 / 报价子视图 / 视角首页共用同一份排版）。 */
  const prepDraftTable = (run) => {
    if (!run.drafts.length) {
      return `<p data-prep-drafts="empty" data-prep-drafts-count="0">还没有报价草稿：本视角投影里没有 `
        + `<code>quote/drafted</code> 行。</p>`
    }
    const rows = run.drafts.map((draft) => `<tr data-prep-draft="${esc(draft.quote_draft_id)}"`
      + ` data-prep-draft-lines="${esc(String(draft.line_count ?? 1))}">`
      + `<td><code>${esc(draft.item_id)}</code>${(draft.line_count ?? 1) > 1
        ? ` <b data-prep-draft-multi="1">（共 ${esc(String(draft.line_count))} 行）</b>` : ''}</td>`
      + `<td>${draft.unit_price_cents === null ? '—' : esc(String(draft.unit_price_cents))}</td>`
      + `<td>${draft.lead_time_days === null ? '—' : esc(String(draft.lead_time_days))}</td>`
      + `<td>${esc(draft.status_text)}（<code>${esc(draft.status)}</code>）</td>`
      + `<td><code>${esc(draft.ref)}</code></td><td>${esc(draft.prepared_by)}</td>`
      + `<td>${esc(draft.supplier || '—')}</td><td><code>${esc(draft.ts || '—')}</code></td></tr>`).join('')
    return `<table data-prep-drafts="table" data-prep-drafts-count="${run.drafts.length}">`
      + `<tr><th>行项目</th><th>单价（分）</th><th>交期（天）</th><th>状态</th><th>引用（草稿 id）</th>`
      + `<th>发言人</th><th>供应商</th><th>事实 ts</th></tr>${rows}</table>`
  }

  /** 草稿的一句话（承包商侧必须能读到「供应商 X 已准备报价（待签署）」）。 */
  const prepDraftHeadline = (view, run) => {
    if (!run.drafts.length) return ''
    const suppliers = [...new Set(run.drafts.map((draft) => draft.supplier).filter((name) => name !== ''))]
      .sort()
    const names = suppliers.length ? suppliers.join(' / ') : '（账本没写 realm）'
    return view === 'contractor'
      ? `<p data-prep-headline="contractor">供应商 <b>${esc(names)}</b> 已准备报价（<b>待签署</b>）：`
        + `${run.drafts.length} 条草稿。**待签署 = 还没有对外义务**（草稿不是报价）。</p>`
      : `<p data-prep-headline="supplier">你已准备 ${run.drafts.length} 条报价草稿（**待签署**）：`
        + `签署前它们**还不是报价**；承包商侧看到的是「已准备报价（待签署）」。</p>`
  }

  /** 「下一步（签署）」区域：**指到 GUI 里那一个动作**（旧口径的「可复制的终端命令」已按 29 §2 删除）
   *  + **本 APP 不代签**（`data-signature-required="1"`）。 */
  const prepSignatureHtml = (view, run) => {
    const draft = run.drafts[0] ?? null
    const out = prepare.handoff({ view, draft })
    const params = draft
      ? `<p data-signature-params="1">这份草稿的真实参数：RFQ <code>${esc(out.rfq_id)}</code> / `
        + `行项目 <code>${esc(out.item_id)}</code> / 金额 <b>${esc(String(out.unit_price_cents ?? '—'))}</b> `
        + `<code>${esc(out.money_unit)}</code> / 草稿 <code>${esc(out.draft_id)}</code></p>`
      : '<p data-signature-params="0">还没有草稿：先在上面提交一份，下面那块里的草稿 id 会换成真值。</p>'
    const inApp = out.in_app
    const fill = Object.entries(inApp.input).map(([key, value]) =>
      `<code>${esc(key)}=${esc(String(value))}</code>`).join(' · ')
    return `<section id="sign" data-signature-required="${esc(out.data_signature_required)}"`
      + ` data-can-sign="${out.can_sign ? '1' : '0'}"><h3>下一步（签署）—— 本 APP 不代签</h3>`
      + `<p data-signature-why="1">${esc(out.why)}</p>${params}`
      + `<p data-signature-in-app="${esc(inApp.action)}" data-signature-permission="${esc(inApp.permission)}">`
      + `去点：${esc(inApp.where)}</p>`
      + `<p data-signature-input="1">填这几格即可：${fill}</p>`
      + `<p><small>${esc(out.page_note)}</small></p></section>`
  }

  /** 准备报价页（SSR；`<form method="post">` 指向**真的会处理写**的同一路径）。 */
  const prepPageHtml = (view, url) => {
    const run = prepRun(view)
    const submit = String(url.searchParams.get('submitted') ?? '') === '1'
    const input = (field) => (field.kind === 'textarea'
      ? `<p><label>${esc(field.label)}<br><textarea name="${esc(field.name)}" rows="3" cols="72"`
        + ` placeholder="${esc(field.placeholder)}"></textarea></label></p>`
      : `<p><label>${esc(field.label)} <input name="${esc(field.name)}" size="18"`
        + ` placeholder="${esc(field.placeholder)}"></label></p>`)
    const form = `<form method="post" action="${prefix}/${esc(view)}/quotes/prepare/">`
      + prepare.fields().map(input).join('')
      + `<p><button type="submit">提交草稿（只落待办件，不写账本）</button></p></form>`
    return subNav(prefix, view, 'quotes')
      + `<p><a href="${prefix}/${view}/quotes/">← 回报价与行项目</a></p>`
      + `<p data-prepare="page" data-money-unit="${esc(prepare.limits().money_unit)}">`
      + `<b>这一步做什么</b>：把「你想报的这份报价」结构化地交给系统（行项目 / 单价 / 交期 / 备注）。`
      + `提交后**只落一条 0600 待办件**（账本零新增）；真正落账本的是 Python 侧 `
      + `<code>tools/quote-draft.py</code>（落 <code>quote/drafted</code>，**不是签名动作**）。</p>`
      + `<p data-prepare-engine="1">${esc(prepare.meta().engine_note)}</p>`
      + (submit ? '<p data-prepare-submitted="1">上一次提交已受理（回 202）：见下方「草稿」表。</p>' : '')
      + prepCatalogueHtml(run)
      + `<h3 id="form">填这份草稿</h3>${form}`
      + `<h3 id="rules">字段与校验规则</h3>${prepRulesHtml()}`
      + `<h3 id="drafts">本视角已有的草稿</h3>${prepDraftHeadline(view, run)}${prepDraftTable(run)}`
      + prepSignatureHtml(view, run)
      + `<p><small>本页 **0 行脚本、0 内联事件**：表单是普通 POST，提交失败按字段回具体错误码。</small></p>`
  }

  /** 提交草稿：插件只产载荷与字段级错误，**宿主只落一条 0600 待办件**（账本零新增）。 */
  const submitDraft = (view, form) => {
    const out = prepare.validate({ view, form, payload: prepPayload(view) })
    if (!out.ok) return { ...out, file: '', next_action: '按 errors 里每个字段的 next_action 改后再提交（本次**什么都没落盘**）' }
    const supplier = realmOf(view)
    const record = { ...out.record, supplier, submitted_at: '' }
    record.note_sha256 = prepSha(record.note)
    record.lines_sha256 = prepSha(PREP_CANON(record))
    record.bytes = prepBytes(record.note)
    record.quote_draft_id = `qd-${view}-` + prepSha(
      [view, supplier, PREP_CANON(record), record.note, record.prepared_by].join('\n')).slice(0, 12)
    const shared = String(config.ui_shared ?? '').trim()
    if (shared === '') {
      return { ...out, ok: false, code: 'pending-write-failed', file: '',
        next_action: '宿主未配置 ui_shared：无法确定待办件目录，拒绝写任何地方' }
    }
    const dir = join(shared, 'quote-drafts')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const file = join(dir, `${record.quote_draft_id}.json`)
      const rel = `quote-drafts/${record.quote_draft_id}.json`
      if (existsSync(file)) {
        return { ...out, duplicate: true, id: record.quote_draft_id, file: rel, record,
          payload_sha256: record.lines_sha256,
          next_action: `待办件已存在（同一份草稿，幂等）：由宿主消费者 tools/quote-draft.py 落 quote/drafted（唯一落账本者）；`
            + `之后在 GUI 的「我的草稿」那一行点「人签提交报价」提交（动作 quote.submit，署名 == 会话身份）` }
      }
      const tmp = join(dir, `.${record.quote_draft_id}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(record, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)                      // 显式 chmod：不受 umask 影响（待办件必须**恰为** 0600）
      renameSync(tmp, file)
      return { ...out, duplicate: false, id: record.quote_draft_id, file: rel, record,
        payload_sha256: record.lines_sha256,
        next_action: `宿主消费者 tools/quote-draft.py --now <ISO8601> 落 quote/drafted（唯一落账本者）；`
          + `签名是**人的动作**：在 GUI 的「我的草稿」那一行点「人签提交报价」（动作 quote.submit，`
          + `署名 == 会话身份；本 APP 不代签、不写账本）` }
    } catch (err) {
      return { ...out, ok: false, code: 'pending-write-failed', file: '',
        next_action: `待办件写失败（${String(err && err.code ? err.code : err).slice(0, 40)}）：先修目录权限再重提` }
    }
  }

  /** 子视图数据源：**只读**现有服务/注入参数（不新增口径、不自己算业务数）。 */
  const subSource = (view, sub, publicRows) => {
    if (sub === 'events') {
      return { rows: ledgerRowsOf(view, publicRows), what: '本视角全部事件（公开投影后的行）',
        columns: (rules[view]?.fields ?? []).map((field) => ({ key: field, label: (LEDGER_COLUMNS.find(([k]) => k === field) ?? [field, field])[1] })) }
    }
    if (sub === 'quotes' || sub === 'clarifications') {
      const prefixOf = sub === 'quotes' ? 'quote/' : 'clarification/'
      const picked = publicRows.filter((row) => String(row.type).startsWith(prefixOf))
      // 报价子视图多一段「草稿（待签署）」：写闭环的**回读面**——员工提交草稿、Python 侧落账本之后，
      // 这里必须真的显示那份草稿（行项目 / 单价 / 状态 / 引用），**不是一句「提交成功」的自我表扬**。
      const extra = sub === 'quotes' ? (() => {
        const run = prepRun(view)
        return `<h3 id="drafts">报价草稿（待签署）</h3>`
          + prepDraftHeadline(view, run) + prepDraftTable(run)
          + (view === prepView()
            ? `<p><a href="${prefix}/${view}/quotes/prepare/" data-prepare-link="1">准备一份报价草稿 →</a></p>`
              + prepSignatureHtml(view, run)
            : `<p data-prepare-link="0" data-signature-required="1">签署是**供应商侧**的动作：`
              + `草稿在供应商页上「下一步（签署）」区域里签（本页不代签、也不给别人的签名入口）。</p>`)
      })() : undefined
      return { rows: ledgerRowsOf(view, picked), what: `本视角 ${prefixOf}* 事件（公开投影后的行）`,
        columns: (rules[view]?.fields ?? []).map((field) => ({ key: field, label: (LEDGER_COLUMNS.find(([k]) => k === field) ?? [field, field])[1] })),
        ...(extra === undefined ? {} : { extra }) }
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
    const projectionResult = projectionOf(view)          // **一次请求一次投影**（canary 采样不会翻倍）
    const rows = projectionResult.publicRows
    const inbox = projectionResult.deliveries            // 投递事实（只有消费它的视角才有：见 projection.deliveryViews）
    const suppressed = rows.filter((row) => row.suppressed).length
    let report = { ok: false, count: rows.length }
    try { report = ledgerOf(view).verify() } catch (err) { report = { ok: false, count: rows.length, reason: String(err).slice(0, 80) } }
    // P34：这一侧账本的**读数降级**（坏行/非普通文件/超大/不存在）——**照实说**，不拿空表顶替
    let ledgerHealth = null
    try { ledgerHealth = ledgerOf(view).health().degraded } catch (err) { ledgerHealth = null }
    const summary = evidence.summarize(rows)
    const pending = pendingApprovals(view)
    const digest = approvals.digest(pending)
    const oldest = approvals.oldest(pending)
    const scores = scorecard.bySupplier(ledgerOf(view).rows())
    const flags = scores.reduce((sum, item) => sum + (typeof item.deviation_count === 'number' ? item.deviation_count : 0), 0)
    const series = seriesView(view)
    const medians = series.map((item) => item.median).filter((value) => typeof value === 'number')
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

    /**
     * 发往本视角的 RFQ 包（**投递事实**，本批修复的核心：根因是 `rfq/*` 事实只落在发送方 realm 的账本里，
     * 供应商那本账本里一条都没有 ⇒ 供应商看不到要报的包）。本视角要看到「要报的包」只能走**投递信封**
     * （收件人作用域 + 字段白名单，见 `host/modules/projection.mjs` 的块注释与
     * `docs/design/21-rfq-delivery-visibility.md`）。
     *   · 页面 **0 行脚本 / 0 内联事件**：纯表格 + 文字，没有任何写动作；
     *   · `degraded` / `reason` / `omitted` / 计数都**照抄**投影插件的返回值（宿主不自己算、不自己编文案）；
     *   · `data-rfq-*` 是门的抓手（机检"谁看到了哪些包"），不是装饰。
     */
    const rfqInboxHtml = !inbox ? '' : `<section data-rfq="inbox" data-rfq-degraded="${inbox.degraded}"
data-rfq-reason="${esc(inbox.reason)}" data-rfq-count="${inbox.packages.length}" data-rfq-omitted="${inbox.omitted}"
data-rfq-identity="${esc(inbox.identity)}" data-rfq-visible="${inbox.counts.visible}">
<h3>发往本视角的 RFQ 包（投递事实）</h3>
${inbox.packages.length
      ? `<table data-rfq="packages"><tr><th>包</th><th>版本</th><th>报价截止</th><th>澄清截止</th><th>行项目</th><th>收到于</th></tr>${
        inbox.packages.map((pkg) => {
          // P32：`pkg.rfq.items` 是**投递信封 spec.items 投影出来的行数组** ⇒ 走唯一读数入口；
          // 坏行不扮成行、也不静默丢（`all` 是源长度，`bad` 在本行末尾如实报出）。
          const pkgItems = readRows(pkg?.rfq?.items)
          return `<tr data-rfq-package="${esc(pkg?.rfq?.package_id)}" data-rfq-rev="${esc(pkg?.rfq?.rev ?? '')}"`
            + ` data-rfq-items-dropped="${pkgItems.bad}">`
            + `<td><code>${esc(pkg?.rfq?.package_id)}</code></td><td>@rev${esc(pkg?.rfq?.rev ?? '—')}</td>`
            + `<td><code>${esc(pkg?.rfq?.quote_by ?? '—')}</code></td>`
            + `<td><code>${esc(pkg?.rfq?.clarify_by ?? '—')}</code></td>`
            + `<td>${pkgItems.all} 条（${esc(pkgItems.rows.map((item) => `${item?.item_id}×${item?.qty ?? '—'}${item?.unit}`).join('、') || '—')}）`
            + `${pkgItems.bad > 0 ? ` · 另有 ${pkgItems.bad} 条读不出来（形状异常：不是对象）` : ''}</td>`
            + `<td><code>${esc(pkg?.rfq?.delivered_at ?? '—')}</code></td></tr>`
        }).join('')}</table>`
      : `<p data-rfq="empty">还没有发往本视角的 RFQ 包（<code>reason=${esc(inbox.reason)}</code>）—— `
        + '这不是页面坏了：投递事实里没有任何一份把包发给本视角。</p>'}
<p data-rfq="basis">口径：只出**发给本视角**的包（投递信封的 <code>delivered_to</code> 命中本视角身份 `
      + `<code>${esc(inbox.identity)}</code>）；字段只出白名单 —— <code>package_id</code> / <code>rev</code> / `
      + `<code>quote_by</code> / <code>clarify_by</code> / <code>currency</code> / `
      + `<code>items[item_id,code,qty,unit]</code> / <code>recipient</code> / <code>delivered_at</code> / `
      + `<code>basis</code>${inbox.omitted > 0 ? `；另有 <b>${inbox.omitted}</b> 个包未展示（omitted）` : ''}。</p>
<p data-rfq="privacy">发放对象只出「本视角自己」这一个；其他供应商代号、比价基准、其他供应商的报价等私域键**读都不读**（带哨兵与不带哨兵输出**逐字节一致**）。</p>
</section>`

    const inProgressBlock = `<section data-block="in-progress">
<h2>进行中</h2>
<p>最新 RFQ 包：${lastRfq
      ? (lastRfq.rfq
        ? `<code>${esc(lastRfq.rfq.package_id)}@rev${esc(lastRfq.rfq.rev ?? '—')}</code> 报价截止 `
          + `<code>${esc(lastRfq.rfq.quote_by ?? '—')}</code>（发给本视角；投递事实）`
        : `<code>seq ${esc(lastRfq.seq)}</code> ${esc(lastRfq.summary || lastRfq.type)}`)
      : '—（本视角暂无 RFQ 事件）'}</p>
<p>报价 <b>${quoteCount}</b> 条 · 比价评估 ${lastCompare
      ? `<code>seq ${esc(lastCompare.seq)}（${esc(lastCompare.type)}）</code>` : '—（本视角不可见 compare/*）'}
· 偏差标记 <b>${flags}</b> 个 · 价格序列 <b>${series.length}</b> 组${medians.length
      ? `（跨组中位 ${Math.min(...medians)}–${Math.max(...medians)}，来自 price-history）` : ''}</p>
${sortForm('quotes', '看报价')}
<p><a href="${prefix}/${view}/quotes/">报价与行项目 →</a> ·
<a href="${prefix}/${view}/events/?type=quote/">只看 quote/* 事件 →</a></p>
${(() => { const run = prepRun(view)
  return `<h3 id="drafts">报价草稿（待签署）</h3>${prepDraftHeadline(view, run)}${prepDraftTable(run)}`
    + (view === prepView()
      ? `<p><a href="${prefix}/${view}/quotes/prepare/" data-prepare-link="1">准备一份报价草稿 →</a>`
        + `（行项目 / 单价 / 交期 / 备注；提交只落待办件，落账本归 Python 侧）</p>${prepSignatureHtml(view, run)}`
      : '') })()}
${rfqInboxHtml}
</section>`

    const healthBlock = `<section data-block="health">
<h2>异常与健康 · 账本证据面</h2>
<p>由自进化产出的插件 <code>evidence-summary</code> 计算：共 <b>${summary.rows}</b> 行 / <b>${summary.types}</b> 种类型 /
<b>${summary.correlations}</b> 个关联 / <b>${summary.rows_with_refs}</b> 行带引用；时间跨度
<code>${esc(summary.span.first ?? '—')}</code> → <code>${esc(summary.span.last ?? '—')}</code>；
链自洽 <b>${report.ok}</b>（${report.count} 条）</p>
${ledgerHealth ? `<p class="degraded" data-ledger-degraded="1" data-ledger-code="${esc(ledgerHealth.code)}"`
    + `${ledgerHealth.dropped ? ` data-ledger-dropped="${ledgerHealth.dropped}"` : ''}`
    + `${ledgerHealth.first_bad_line ? ` data-ledger-first-bad-line="${ledgerHealth.first_bad_line}"` : ''}>`
    + `<b>账本读数降级</b>（<code>${esc(ledgerHealth.code)}</code>）：${esc(ledgerHealth.reason)}`
    + (ledgerHealth.dropped
      ? `<br>好行照列（这一页的行都能用）、坏行**逐条计数不静默丢**：另有 <b>${ledgerHealth.dropped}</b> 行读不出来`
        + `，第一处在第 ${ledgerHealth.first_bad_line} 行（共 ${ledgerHealth.lines} 行）。`
      : '<br>这一侧的行**一条都没有**列出来 —— 这是"读不出来"，<b>不是</b>"没有数据"。')
    + `<br>下一步：${esc(ledgerHealth.next_action)}</p>` : ''}
<p>最后事件：${lastRow ? `<code>seq ${esc(lastRow.seq)} ${esc(lastRow.type)}</code>` : '—'} ·
本视角被抑制行 <b>${suppressed}</b> 行（宿主不读墙钟）</p>
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
      + scoreHtml + priceHtml + rawHtml + elevateHtml
      // 注入式 UI：本槽位上"别人注册的区块"（通用机制；本文件不知道它们是什么）
      + slotsHtmlOf(view).html, prefix)
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
    // P32：`creds.rows` / `audit.rows` 是**配置视图服务面给的快照行数组** ⇒ 走唯一读数入口
    const credsRead = readRows(creds.rows)
    const credRows = credsRead.rows.map((row) => `<tr data-credential="${esc(row?.name)}">`
      + `<td><code>${esc(row?.name)}</code></td><td><b>${row?.configured ? '已配置' : '未配置'}</b></td>`
      + `<td>${esc(row?.source)}</td><td>${esc(row?.required_mode)}</td>`
      + `<td>${esc(row?.fingerprint_first8 ?? '—')}</td><td>${esc(row?.env || '—')}</td>`
      + `<td>${esc(row?.file || '—')}${row?.file_mode ? `（${esc(row?.file_mode)}）` : ''}</td>`
      + `<td>${esc(row?.next_action)}</td>`
      + `<td><form method="post" action="${prefix}/admin/api/credentials/${encodeURIComponent(row?.name)}">`
      + `<input type="password" name="value" autocomplete="off" placeholder="只写不回显" size="12">`
      + `<button type="submit">提交</button></form></td></tr>`).join('')
    const auditRead = readRows(audit.rows)
    const auditRows = auditRead.rows.map((row) => `<tr data-audit="${esc(row?.seq)}"><td>${esc(row?.seq)}</td>`
      + `<td><code>${esc(row?.type)}</code></td><td>${esc(row?.ts ?? '')}</td><td>${esc(row?.actor ?? '')}</td>`
      + `<td>${esc(row?.layer ?? '')}</td><td><code>${esc(row?.target ?? '')}</code></td>`
      + `<td><code>${esc(row?.key_path ?? '')}</code></td>`
      + `<td>${esc(String(row?.old_digest ?? '—').slice(0, 18))}</td><td>${esc(String(row?.new_digest ?? '—').slice(0, 18))}</td>`
      + `<td>${esc(row?.approval_ref ?? '—')}</td><td>${esc(row?.fingerprint_first8 ?? '—')}</td></tr>`).join('')
    const degraded = data.degraded || creds.snapshot.available === false
    return anchorNav('admin', `${prefix}/admin/`, ADMIN_SECTIONS, [], [],
      [[`${prefix}/app/contractor/`, '授权区间（承包商 · GUI）'], [`${prefix}/app/supplier/`, '授权区间（供应商 · GUI）']])
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
      + droppedNote(credsRead, '凭据')
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
          + `</tr></thead><tbody>${auditRows}</tbody></table>`
          + droppedNote(auditRead, '审计'))
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

    // ---- 假成功围栏（本批，**在任何处理器之前**）：只应为 GET 的路由收到非 GET ⇒ 405 + `Allow: GET` ----
    // 绝不把 POST 当 GET 处理：实测过 `POST /quotagent/contractor/quotes/` 与 GET 返回**逐字节相同**的
    // 200 页面（bytes=3935、sha256 相同）—— 员工填了单价点提交，浏览器给一页正常页面，什么都没发生。
    // 位置：`send` 与 `json` 都已就绪（这里的 return 会走 `send` → `decorateHtml`，两者都必须在射程内）。
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && !isWriteRoute(path) && isGetOnlyRoute(path)) {
      return send(405, 'application/json; charset=utf-8',
        JSON.stringify({ ok: false, service: 'quotagent-webui', code: 'method-not-allowed',
          method, path, allow: 'GET',
          next_action: '本路由**只读**（GET）。要推进状态请用页面上**指向真写路由**的表单：'
            + `催办 ${prefix}/<view>/gates/nudge · 登记承诺 ${prefix}/<view>/deadlines/promise · `
            + `反馈 ${prefix}/<view>/feedback · 准备报价 ${prefix}/supplier/quotes/prepare/`
            + '（宿主只落 0600 待办件；落账本归 Python 侧）' }, null, 2) + '\n',
        { allow: 'GET' })
    }

    // ---- 动态路由（**路由注册面**，见 `host/lib/ui-route.mjs`）：精确匹配，命中即把响应权交给注册者 ----
    // 纪律：注册表里没有这条 ⇒ 落到下面既有的静态路由/404 语义（不通配、不猜）；注册者自己给有名
    // code + next_action，本文件**不替它编响应**；注册者抛错 ⇒ 500 + `handler-failed`（不静默吞）。
    const dynamicHit = uiRoutes.match(path, method)
    if (dynamicHit !== null) {
      const request = { req, res, url, prefix, path, method, json, send, readBody, route: dynamicHit.route }
      const failed = (err) => json(500, { ok: false, route: dynamicHit.route.path, code: 'handler-failed',
        reason: String(err && err.message ? err.message : err).slice(0, 240),
        next_action: '这是注册者的处理器抛错：修它的 handler（机制层不兜底、不编替代响应）' })
      try {
        const out = dynamicHit.handler(request)
        return out && typeof out.then === 'function' ? out.catch(failed) : out
      } catch (err) {
        return failed(err)
      }
    }

    // ---- ③ 路由级身份门槛（本批**追加**；判据在 `code/identity.mjs#gateBusinessRoute`）-----------------
    // 两侧的**静态业务路由**（`/contractor/**`、`/supplier/**`）不再"开哪个 URL 就是谁"：未登录一律拒。
    //   · 浏览器（Accept 含 text/html）⇒ 303 到 `${prefix}/identity/?next=<原地址>`，登录后回跳原地址；
    //   · API/JSON 客户端 ⇒ 401 `identity-required`（带同一个 `next`）；
    //   · 登录了但不是这一侧 ⇒ 403 `side-mismatch`（**不回落成"能看"**）。
    // 位置：动态注册路由**之后**（`/identity/**`、`/<side>/inbox/` 等自助面自己判身份，不受这里影响）、
    // 静态业务路由**之前**；公开入口（`/`、`/app/**`、`/assets/**`、`/api/health`、`/api/status`、
    // `/api/ui/**`、`/ops/**`、`/admin/**`）与本门槛无关。
    // 台账注：`/api/routes` 表里这些行的 `auth` 仍写 `'none'`（本批只允许**追加**门槛，未改那张表）。
    const businessSide = /^\/(contractor|supplier)(?:\/|$)/.exec(path)?.[1] ?? null
    if (businessSide !== null) {
      const nextPath = `${prefix}${path === '/' ? '/' : path}${url.search}`
      const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
      const verdict = identity.gateBusinessRoute(req, { side: businessSide, next: nextPath, wantsHtml })
      if (verdict !== null) {
        if (verdict.kind === 'redirect') {
          return send(verdict.status, 'text/plain; charset=utf-8', '', { location: verdict.location })
        }
        if (wantsHtml) {
          return send(verdict.status, 'text/html; charset=utf-8',
            '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
            + `<title>需要身份 · ${esc(verdict.code)}</title></head><body>`
            + `<h1>这一步需要身份：${esc(verdict.code)}</h1>`
            + `<p>${esc(verdict.reason)}</p>`
            + `<p>下一步：${esc(verdict.next_action)}</p>`
            + `<p><a href="${esc(verdict.login)}">去登录 / 换一个身份</a> · `
            + `<a href="${esc(prefix)}/">回工作台</a> · <a href="${esc(prefix)}/api/health">/api/health</a></p>`
            + '</body></html>')
        }
        return json(verdict.status, verdict)
      }
    }

    // ---- 退役的旧 SSR 页：旧地址**不 404**，303 到对应 GUI 视图 ------------------------------
    //   位置：身份门槛**之后**（未登录 ⇒ 401 / 303→登录；跨侧 ⇒ 403，语义与退役前逐字一致）、
    //   静态业务路由**之前** ⇒ 旧的 `/<view>/<sub>/` 与 `/<view>/api/<sub>/` 不再渲染任何内容。
    //   判据：sub ∈ RETIRED_SUBVIEWS（`advice` / `deadlines` / `gates` / `authority`）；其余子视图
    //   （events/quotes/approvals/evidence/clarifications/heuristics/changes）**一行未改**；
    //   只读方法围栏（POST ⇒ 405 + `Allow: GET`）在这一段**之前**，所以语义不变。
    //   目标位置的选择：四个功能都注册在**同一侧视图页** `${prefix}/app/<view>/` 上
    //   （`advice`/`deadlines` → `rfq.remind-board`；`gates` → `gate.queue`/`gate.decided`；
    //   `authority` → `authority.bands`），所以四个旧地址都 303 到那一页 —— 落到**能做同一件事**的
    //   GUI 位置，而不是失联。写面（`/<view>/gates/nudge`、`/<view>/deadlines/promise`）多一段路径，
    //   **不**匹配本正则，一行未改。
    const retiredMatch = /^\/([a-z]+)\/(?:api\/)?(advice|deadlines|gates|authority)\/?$/.exec(path)
    if (retiredMatch !== null && rules[retiredMatch[1]] !== undefined) {
      const view = retiredMatch[1]
      const sub = retiredMatch[2]
      const target = `${prefix}/app/${view}/`
      const why = RETIRED_SUBVIEWS[sub]
      if (String(req.headers.accept ?? '').includes('application/json')) {
        // JSON 客户端同样**不丢联系人**：303 + `Location`（正文里给出替代位置与下一步）
        return send(303, 'application/json; charset=utf-8',
          JSON.stringify({ ok: false, view, code: 'retired-page', subview: sub,
            reason: `旧 SSR 页 \`/${view}/${sub}/\` 已按 docs/design/29-webui-gui-app.md §2 退役（不留副本）`,
            replacement: why, next: target,
            next_action: `去 ${target} 用 GUI 做同一件事（本页不再返回内容）` }, null, 2) + '\n',
          { location: target })
      }
      return send(303, 'text/html; charset=utf-8',
        '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + `<title>已退役 · ${esc(view)}/${esc(sub)}</title></head>`
        + `<body data-retired-subview="${esc(sub)}" data-retired-view="${esc(view)}">`
        + `<h1>这一页已退役（303 → GUI）</h1>`
        + `<p>旧页 <code>${esc(prefix)}/${esc(view)}/${esc(sub)}/</code> 不提供内容了 —— 它只是把可复制的指令准备好，`
        + '而同一件事现在在图形界面里点得到。</p>'
        + `<p>它现在等于：<b>${esc(why)}</b></p>`
        + `<p>下一步：<a href="${esc(target)}">${esc(target)}</a>（本应自动跳转；若浏览器没跳，点这个链接）。</p>`
        + '</body></html>', { location: target })
    }

    // ---- GUI 应用外壳（**机制**；`docs/design/29-webui-gui-app.md`）--------------------------------
    // 外壳自有的路径族：`/`（工作台首屏）、`/app/<view>/[<panel>/]`（深链）、`/assets/**`（本服务自己的
    // 客户端资源）、`/api/ui/**`（注册面自述 + 面板数据 + 通知 + 状态 + 区块 HTML）、
    // `POST /api/action/<id>`（动作总线：交给插件自己的服务端一半）、`POST /api/ui/plugins/<id>/unload`
    // （撤销一个插件的全部贡献）。放在动态路由**之前**：这些路径族归外壳，插件不得抢占（其余路径照旧）。
    const appMatch = /^\/app(\/[A-Za-z0-9._-]+)*\/?$/.exec(path)
    if ((path === '/' || path === '' || appMatch) && (method === 'GET' || method === 'HEAD')) {
      // 首屏 = **「我今天要做什么」的工作台**（不是报告列表）：面板 + 待办动作 + 通知都由注册面给。
      // 地址形态：`/app/<view>/`（视图）与 `/app/<view>/<kind>/<id>/`（**对象深链**：刷新不丢、可分享）。
      const bits = path.split('/').filter(Boolean)          // ['app', view?, kind?, id?]
      if (bits.length > 4) {
        return json(404, { ok: false, code: 'deep-link-too-deep', path,
          next_action: `深链形如 ${prefix}/app/<view>/ 或 ${prefix}/app/<view>/<kind>/<id>/（多出来的段不猜）` })
      }
      const view = bits[1] ?? 'home'
      if (!['home', ...config.views].includes(view)) {
        return json(404, { ok: false, code: 'unknown-view', view,
          next_action: `可用视图：home / ${config.views.join(' / ')}` })
      }
      const kind = bits[2] ?? ''
      const id = bits[3] ?? ''
      if (kind !== '' && (id === '' || kind === 'panel')) {
        return json(404, { ok: false, code: 'deep-link-incomplete', view, kind,
          next_action: `对象深链要写全：${prefix}/app/${view}/<kind>/<id>/（只给 kind 无法定位到哪一个对象）；`
            + `要看这一类对象有哪些，先回 ${prefix}/app/${view}/` })
      }
      return send(200, 'text/html; charset=utf-8', shell.shellHtml({ view, kind, id, panel: '' }))
    }
    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length)
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        return json(404, { ok: false, code: 'asset-not-allowed', name, next_action: '资源名只允许 [A-Za-z0-9._-]' })
      }
      const found = shell.asset(name)
      if (!found.ok) return json(404, { ok: false, code: found.code, name, reason: found.reason })
      const type = name.endsWith('.css') ? 'text/css; charset=utf-8'
        : (name.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : (name.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8'
            : (name.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8')))
      return send(200, type, found.body,
        name.endsWith('.png') ? { 'cache-control': 'public, max-age=86400' } : {})
    }
    // ---- PWA（机制）：清单落在**前缀根**（模板里的相对 URL 因此指向本前缀），
    //      Service Worker 也落在**前缀根** —— 它的作用域才正好是整个应用（`${prefix}/`）。
    //      两者都只来自本服务（`code/assets/`），**没有任何外网 CDN**；详见 `assets/sw.js` 里的缓存策略。
    if (path === '/manifest.webmanifest' || path === '/sw.js') {
      const name = path === '/sw.js' ? 'sw.js' : 'manifest.webmanifest'
      const found = shell.asset(name)
      if (!found.ok) return json(404, { ok: false, code: found.code, name, reason: found.reason })
      return path === '/sw.js'
        // SW 总要走网络取最新的：`no-store` + 显式 `Service-Worker-Allowed`（作用域 = 前缀根）
        ? send(200, 'text/javascript; charset=utf-8', found.body,
          { 'cache-control': 'no-store', 'service-worker-allowed': `${prefix}/` })
        : send(200, 'application/manifest+json; charset=utf-8', found.body,
          { 'cache-control': 'no-cache' })
    }
    if (path === '/api/ui/surface') return json(200, shell.surfaceJson())
    // 面板/对象/通知/状态都要**会话身份**（`identity.whoOf`）：协作类贡献从 `ctx.identity` 才知道"同侧是谁"；
    // 不按身份过滤数据（业务投影仍按视角隔离），但**侧的判定只认会话**，不认请求体/表单。
    const whom = identity.whoOf(req)
    // **服务端窗口**（分页/筛选/排序/计数；本批）：请求里的 `w`/`pq`/`only`/`size/page/kw/sort/bucket` 由
    // 外壳的机制层解析（`app-shell.mjs#parseWindowRequest`）——**没带参数就整份下发**（兼容既有调用方），
    // 带了就只回窗口 + 在全集上算出来的数字。参数解析失败不抛错：坏值丢掉并如实记在回执的 `window.notes` 里。
    const windowSpec = shell.windowSpec(url.searchParams)
    /**
     * **渲染准入（背压）**（P13）：跑"重读"之前问一次外壳 —— 事件循环已经滞后到阈值以上时，
     * **这一条根本不开始跑**，直接回 429 + `Retry-After` + `code:'ui-busy'`（连带当场的滞后读数与
     * "多久后重试"）。为什么不是"排着等"：修前的实测是所有人一起排到 50 s 无响应（`tmp/p13-shots/`），
     * 拒绝 + 明确重试时间才能让客户端自己退避、让服务端把队列排空。
     * 不参与拒绝的：动作（走 `/api/action/*`，在下面）、身份、偏好读写、健康与静态资源。
     */
    const shedIfBusy = () => {
      const verdict = shell.admission()
      if (verdict.shed !== true) return false
      // 用 `send` 直发：要在响应头里带 `Retry-After`（`json()` 不带自定义头）
      send(429, 'application/json; charset=utf-8', JSON.stringify({ ok: false, code: 'ui-busy', route: path,
        ...verdict,
        mechanism: '外壳的渲染准入：事件循环滞后 ≥ 阈值 ⇒ 新到的重读请求当场被拒（没有开始读、没有占用队列），'
          + '并给出 Retry-After；客户端应等这么久再来（界面会照实说"服务端忙"，不是空列表）' }, null, 2) + '\n',
      { 'retry-after': String(verdict.retry_after_s) })
      return true
    }
    if (path === '/api/ui/panels') {
      if (shedIfBusy()) return undefined
      const view = String(url.searchParams.get('view') ?? 'home')
      if (!['home', ...config.views].includes(view)) {
        return json(400, { ok: false, code: 'unknown-view', view,
          next_action: `可用视图：home / ${config.views.join(' / ')}` })
      }
      // `kind`/`id` 非空 ⇒ **对象页**的面板（只出声明了该 object_kind 的面板；插件从 ctx.route 读对象身份）
      const kind = String(url.searchParams.get('kind') ?? '')
      const id = String(url.searchParams.get('id') ?? '')
      const panels = shell.panelsOf(view, { view, kind, id }, whom, windowSpec)
      if (windowSpec.only.length && panels.length === 0) {
        return json(404, { ok: false, code: 'panel-not-in-this-view', view, kind, id, asked: windowSpec.only,
          next_action: `\`only\` 里的面板 id 不在这个视图上（本视图的面板见 ${prefix}/api/ui/surface 的 panels）；`
            + '不带 `only` 就回这一页的全部面板' })
      }
      return json(200, { ok: true, view, kind, id, panels,
        window: { ...windowSpec.source, notes: windowSpec.notes, only: windowSpec.only },
        identity: whom.ok ? { human: whom.human, side: whom.side } : null,
        mechanism: '面板数据由插件自己的 data() 产出（通用形状：table/form/list/kv/metrics/html）；'
          + '外壳只按形状渲染，不解读语义。**行由服务端按窗口给**（`w=1`）：筛选/排序/分页与计数都在'
          + '服务端全量行集上算，客户端照抄（口径见 /api/ui/surface 的 io.window）' })
    }
    if (path === '/api/ui/object') {
      if (shedIfBusy()) return undefined
      const view = String(url.searchParams.get('view') ?? 'home')
      if (!['home', ...config.views].includes(view)) {
        return json(400, { ok: false, code: 'unknown-view', view,
          next_action: `可用视图：home / ${config.views.join(' / ')}` })
      }
      const kind = String(url.searchParams.get('kind') ?? '')
      const id = String(url.searchParams.get('id') ?? '')
      if (kind === '' || id === '') {
        return json(400, { ok: false, code: 'object-address-incomplete', view, kind, id,
          next_action: `对象地址要写全：${prefix}/app/<view>/<kind>/<id>/；JSON 侧同样要 kind 与 id` })
      }
      return json(200, shell.objectOf(view, kind, id, whom, windowSpec))
    }
    if (path === '/api/ui/plugins') return json(200, shell.pluginsJson())
    if (path === '/api/ui/notifications') {
      if (shedIfBusy()) return undefined
      // **通知窗口**（与面板同一套机制）：`w=1` + `pq.notify` ⇒ 只回这一页 + 在**全量**上算出来的
      // 计数（共/命中/页/未读/还剩多少没翻到）；不带窗口 ⇒ 旧口径（整份 + 上限 600，一字不变）。
      // "未读"由服务端按**会话身份**存的已读集合算（未登录 ⇒ `unread.known=false`，界面如实说）。
      const out = shell.notifications(whom, windowSpec, notifReadSetOf(req))
      return json(200, { ok: true, ...out,
        identity: whom.ok ? { human: whom.human, side: whom.side } : null,
        window: { ...windowSpec.source, notes: windowSpec.notes },
        next_action: out.query === null || out.query === undefined
          ? '要一页页翻（界面走的就是这条路）：带 `w=1&pq={"notify":{"size":25,"page":0}}`'
          : '' })
    }
    // 通知偏好/已读的**服务端化**（0600 落盘，按会话身份）：GET 读、POST 写；未登录 ⇒ 401（不落盘）
    if (path === '/api/ui/notif-state' && method === 'POST') {
      return readBody((body) => {
        let parsed = {}
        if (String(body ?? '').trim() !== '') {
          try { parsed = JSON.parse(body) } catch (err) {
            return json(400, { ok: false, code: 'invalid-json', detail: String(err).slice(0, 120),
              next_action: 'POST JSON：{"state":{"read":[…],"muted":[…],"min_level":"info"}}' })
          }
        }
        const out = notifSave(req, parsed)
        return json(out.status, out.body)
      })
    }
    if (path === '/api/ui/notif-state') {
      const out = notifStateOf(req)
      return json(out.status, out.body)
    }
    if (path === '/api/ui/status') {
      if (shedIfBusy()) return undefined
      return json(200, { ok: true, items: shell.statusItems(whom) })
    }
    // ---- **批量动作的进度与逐条结果**（P21，机制）--------------------------------------------------
    // 批量动作的服务端一半在 worker 线程里跑：界面在提交期间轮询这条只读路由显示"正在签哪一个/已经几份"，
    // 刷新或崩溃之后也靠它读回"这一批到哪了"（0600、按会话身份隔离、有界）。**只读**（POST 孪生 405）。
    if (path === '/api/ui/jobs') {
      if (method !== 'GET') {
        // 只读路径的 POST 孪生：405 + `Allow: GET`（与 `/api/ui/notif-state` 同一条纪律）
        return send(405, 'application/json; charset=utf-8',
          JSON.stringify({ ok: false, service: 'quotagent-webui', code: 'method-not-allowed', method,
            path, route: `${prefix}/api/ui/jobs`, allow: 'GET',
            next_action: '这条路由只读：批量进度用 GET；要**重试**就用动作总线 POST '
              + `${prefix}/api/action/<批量动作 id>（同一个唯一写者，界面不写账本）` }, null, 2) + '\n',
          { allow: 'GET' })
      }
      if (!whom.ok) {
        return json(401, { ok: false, code: whom.code, reason: whom.reason, next_action: whom.next_action,
          route: `${prefix}/api/ui/jobs` })
      }
      return json(200, { ok: true, ...shell.jobsOf(whom),
        identity: { human: whom.human, side: whom.side },
        next_action: '正在跑的那一批在 `running`（逐条进度在 `progress`/`last`）；没跑完的在 `recent` 里'
          + '（`status:"interrupted"` + `pending_ids`）—— 只重试 `pending_ids`/`refused_ids` 是安全的（幂等）；'
          + '`unfinished` = 与**后来的批次对账后**真还没做的份数（`superseded` = 已被后来的批次给出结论的那些）' })
    }
    // ---- **同侧协作**（指派/转交、关注、评论与 @同事、活动流、已读）-------------------------------------
    // 三条只读自述/查询路由：**侧一律取会话**（请求体/查询串改不动它）⇒ 一侧的身份读不到另一侧的协作数据
    // （结构性隔离：一侧一个 0600 文件）。协作数据**不进账本**（理由见 `code/collab.mjs` 文件头）。
    if (path === '/api/collab/store') {
      if (!whom.ok) return json(401, { ok: false, code: whom.code, reason: whom.reason,
        next_action: whom.next_action })
      return json(200, { ok: true, identity: { human: whom.human, side: whom.side }, collab: shell.collab.describe(),
        contributions: shell.collabSurface.contributions, object_panels: shell.collabSurface.objectPanels,
        next_action: `对象级协作读接口：${prefix}/api/collab/object?view=<view>&kind=<kind>&id=<id>` })
    }
    if (path === '/api/collab/object') {
      if (!whom.ok) {
        return json(401, { ok: false, code: whom.code, reason: whom.reason, next_action: whom.next_action,
          side_scoped: '协作按**会话所属侧**隔离：未登录时读不到任何一侧的指派与评论' })
      }
      const kind = String(url.searchParams.get('kind') ?? '')
      const id = String(url.searchParams.get('id') ?? '')
      const out = shell.collab.view({ side: whom.side, actor: whom.human, kind, id })
      return json(out.ok ? 200 : 400, { ...out, view: String(url.searchParams.get('view') ?? ''),
        identity: { human: whom.human, side: whom.side },
        note: '协作数据按侧隔离、不进账本；`view` 只做回显（数据归属只看会话所属侧）' })
    }
    if (path === '/api/collab/hub') {
      if (!whom.ok) {
        return json(401, { ok: false, code: whom.code, reason: whom.reason, next_action: whom.next_action })
      }
      const out = shell.collab.hub({ side: whom.side, actor: whom.human,
        bucket: String(url.searchParams.get('bucket') ?? '') })
      return json(out.ok ? 200 : 400, { ...out, identity: { human: whom.human, side: whom.side } })
    }
    // ---- **人员名册与角色**（同侧成员 / 角色 / 直属关系 / 按角色限动作）---------------------------------
    // 三条**只读**路由：`side` 一律取**会话身份**（请求串改不动它）⇒ 一侧的身份读不到另一侧的名册与额度。
    // 维护走动作总线（`POST /api/action/people.*`，见 `/api/ui/surface`）：名册是**配置**，不是账本事实。
    if (path === '/api/people/store') {
      if (!whom.ok) return json(401, { ok: false, code: whom.code, reason: whom.reason,
        next_action: whom.next_action })
      return json(200, { ok: true, identity: { human: whom.human, side: whom.side },
        people: shell.people.describe(), contributions: shell.peopleSurface.contributions,
        panels: shell.peopleSurface.panelCount,
        http: { suggest: `${prefix}/api/people/suggest`, roster: `${prefix}/api/people/roster` },
        next_action: `维护动作（加人/改角色/改直属/策略）走 ${prefix}/api/action/people.member-add 等` })
    }
    if (path === '/api/people/roster') {
      if (!whom.ok) return json(401, { ok: false, code: whom.code, reason: whom.reason,
        next_action: whom.next_action,
        side_scoped: '名册按**会话所属侧**隔离：未登录时读不到任何一侧的人与额度' })
      const includeInactive = String(url.searchParams.get('include_inactive') ?? '') === '1'
      return json(200, { ok: true, identity: { human: whom.human, side: whom.side },
        me: shell.people.memberOf(whom.human), my_role: shell.people.roleOf(whom.side, whom.human),
        members: shell.people.members(whom.side, { includeInactive }),
        roles: shell.people.roles(), policy: shell.people.policy(),
        store: shell.people.describe(), source: 'roster',
        note: '这是**名册**（0600 配置，按侧隔离）：@提及 / 指派 / 转交的取值与校验都从它来；'
          + '不是合同事实（不进账本、不进投影、不进模型输入）' })
    }
    if (path === '/api/people/suggest') {
      if (!whom.ok) return json(401, { ok: false, code: whom.code, reason: whom.reason,
        next_action: whom.next_action, items: [] })
      const scope = String(url.searchParams.get('scope') ?? '')
      if (scope === 'all') {
        // 「加人 / 改人」这类**维护**动作要能选到不在本侧名册里的名字（他还没进名册）：给出所有侧的已知成员
        const sides = shell.people.describe().sides
        const items = sides.flatMap((side) => shell.people.members(side)
          .map((member) => ({ value: member.name,
            label: `@${member.name}（${side} · ${member.role_label}${member.logged_in ? ' · 在线' : ''}）`,
            side, role: member.role, human: member.human })))
        return json(200, { ok: true, identity: { human: whom.human, side: whom.side }, scope: 'all',
          items, note: '维护动作用的全量名单（各侧已知成员）；**协作**类动作只用本侧名册' })
      }
      const out = shell.people.suggest(whom.side, whom.human)
      return json(out.ok ? 200 : 400, { ...out, scope: 'side',
        identity: { human: whom.human, side: whom.side },
        note: (out.note ?? '') + '；这是自动补全的**服务端一半**（只读、按会话侧）' })
    }
    if (path === '/api/ui/plugins/unload-all') {
      return json(400, { ok: false, code: 'explicit-plugin-required',
        next_action: `POST ${prefix}/api/ui/plugins/<plugin_id>/unload（plugin_id 形如 domain%2Fcompare）` })
    }
    const unloadMatch = /^\/api\/ui\/plugins\/([^/]+)\/unload\/?$/.exec(path)
    if (unloadMatch && method === 'POST') {
      const pluginId = decodeURIComponent(unloadMatch[1])
      return json(200, shell.unload(pluginId))
    }
    // **运行期装载面**（本批 P2）：改一个插件的 `code/ui.mjs` 后不重启进程即可生效。
    //   · `load`   = 磁盘上这个插件还没装载过 ⇒ 装载它（已经装载过 ⇒ `already-loaded` + 指向 reload）
    //   · `reload` = 先撤掉它的全部贡献，再按**磁盘当前内容**重新 import（`?v=<mtime>` 击穿模块缓存）并注册
    // 两者都返回「移除了几项 / 注册了几项 / 拒绝了几项」，装载失败**有名**且不静默吞。
    const loadMatch = /^\/api\/ui\/plugins\/([^/]+)\/(load|reload)\/?$/.exec(path)
    if (loadMatch && method === 'POST') {
      const pluginId = decodeURIComponent(loadMatch[1])
      const op = loadMatch[2]
      const promise = op === 'reload' ? shell.reloadPlugin(pluginId) : shell.loadPlugin(pluginId)
      promise.then((out) => json(out.ok ? 200 : 400, out))
        .catch((err) => json(500, { ok: false, code: 'plugin-load-failed', plugin_id: pluginId,
          reason: String(err).slice(0, 240),
          next_action: '看宿主日志（装载异常时如实报，不假装已装载）' }))
      return undefined
    }
    const actionMatch = /^\/api\/action\/([A-Za-z0-9._-]+)\/?$/.exec(path)
    if (actionMatch && method === 'POST') {
      // 动作总线收 JSON 请求体：有界 256 KB（超上限**如实拒** 413 + code，不截断成另一份正文）
      const MAX_ACTION_BYTES = 262144
      let data = ''
      let over = false
      req.on('data', (chunk) => {
        if (data.length + chunk.length > MAX_ACTION_BYTES) over = true
        else if (!over) data += chunk
      })
      req.on('end', () => {
        if (over) {
          return json(413, { ok: false, code: 'action-body-too-large',
            next_action: `动作请求体超过 ${MAX_ACTION_BYTES} 字节：宿主不截断（截断会合成另一份正文），请拆小后重提` })
        }
        let parsed = {}
        if (String(data ?? '').trim() !== '') {
          try { parsed = JSON.parse(data) } catch (err) {
            return json(400, { ok: false, code: 'invalid-json', detail: String(err).slice(0, 120),
              next_action: '动作总线收 JSON 请求体：{"view":"<视图>","input":{…}}' })
          }
        }
        // ---- 人签动作的**服务端身份门**（机制；`docs/design/29-webui-gui-app.md` §3 的「唯一写者不变」前提）----
        // 声明 `permission: 'human-signature'` 的动作：① 必须已登录（否则 401 `identity-required`）；
        // ② 入参里的 `signature` 必须**等于会话身份**（否则 403 `signer-mismatch`）。
        // 「署名取自会话」这条不因界面而放宽：界面与终端走**同一个**唯一写者，界面不代签、不写账本。
        const wanted = shell.surface.findAction(actionMatch[1])
        const who = identity.whoOf(req)
        if (wanted && wanted.permission === 'human-signature') {
          if (!who.ok) {
            return json(401, { ok: false, code: who.code, reason: who.reason, next_action: who.next_action,
              action: wanted.id, permission: wanted.permission })
          }
          const typed = String((parsed.input ?? {}).signature ?? '').trim()
          if (typed !== who.human) {
            return json(403, { ok: false, code: 'signer-mismatch', action: wanted.id,
              reason: `署名 ${typed || '(空)'} 与会话身份 ${who.human} 不一致`,
              next_action: `人签只能本人签：在 ${prefix}/identity/ 切换到该身份，或用 ${who.human} 署名`
                + '（账本零新增）' })
          }
        }
        const promise = shell.runAction(actionMatch[1], parsed, whom)
        promise.then((out) => json(out.ok ? 200 : 400, out))
          .catch((err) => {
            console.error(`[webui] 动作执行异常 ${actionMatch[1]}：${String(err).slice(0, 160)}`)
            json(500, { ok: false, code: 'action-failed', detail: String(err).slice(0, 160),
              next_action: '看宿主日志定位（动作的服务端一半抛错时如实报，不假装成功）' })
          })
        return undefined
      })
      req.on('error', () => json(400, { ok: false, code: 'action-body-unreadable',
        next_action: '重发一次（读体失败：本路由没有收到完整请求体）' }))
      return undefined
    }
    if (path === '/api/ui/blocks' && url.searchParams.get('slot')) {
      const slot = String(url.searchParams.get('slot'))
      const rendered = uiSlots.render(slot)
      return json(200, { ok: rendered.ok, slot, html: rendered.html, blocks: rendered.blocks,
        errors: rendered.errors, mechanism: '旧槽位注册面（ui-slot.mjs）：按 order 装配插件自己的区块 HTML' })
    }

    if (path === '/api/ui/blocks') {
      // 注册面自述（**只回执元数据**）：谁注册了什么槽位 —— 本文件只把注册表读出来，不解读内容。
      const described = uiSlots.describe()
      return json(200, {
        service: 'quotagent-webui', route_prefix: prefix, source: 'host/lib/ui-slot.mjs',
        mechanism: '注入式 UI 注册面：插件提交区块（槽位 + 排序 + 标题 + render），webui 只做机制、不懂业务语义',
        slots: described.slots, count: described.count, blocks: described.blocks,
        next_action: '插件侧注册见 docs/design/27-plugin-architecture.md §6 与各插件 docs/；'
          + '本表只列注册元数据，不含区块正文',
      })
    }

    if (path === '/api/routes') {
      // 路由表（**静态声明**，只列本模块真的在服务的路由；新增路由必须同步这里）
      return json(200, {
        service: 'quotagent-webui', route_prefix: prefix, source: 'host/modules/webui.mjs',
        views: config.views,
        routes: [
          { path: `${prefix}/`, method: 'GET', auth: 'none', what: '工作台首屏（GUI 外壳：多视图/导航/命令面板/通知/深链；`/app/<view>/` 同源）' },
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
          // 决策建议层：**旧 SSR 页已退役**（`RETIRED_SUBVIEWS`；29 §2「不留副本」）——
          //   旧地址不 404：303 → `/app/<view>/`（承接面板 rfq.remind-board / compare.ranking /
          //   gate.queue / mail.channel，动作 rfq.remind / gate.escalate / exchange.rev-amend）
          ...config.views.filter((v) => rules[v]).flatMap((v) => [
            { path: `${prefix}/${v}/advice/`, method: 'GET', auth: 'none',
              what: `**已退役**（旧口径：页面只把命令准备好让用户复制，与 29 §4「仅通过 GUI」冲突）：303 → ${prefix}/app/${v}/；决策建议的读数与动作在 GUI 面板里` },
            { path: `${prefix}/${v}/api/advice`, method: 'GET', auth: 'none',
              what: `**已退役**（同上，JSON 形态一并收口）：303 → ${prefix}/app/${v}/` },
          ]),
          // 审批与变更 / 变更单明细（`gate-timeline` 插件）：**旧 SSR 页/JSON 已退役**（`RETIRED_SUBVIEWS`）
          //   旧地址不 404：303 → `${prefix}/app/<view>/`（承接面板 gate.queue / gate.decided /
          //   gate.todo，动作 gate.grant / gate.deny / gate.nudge / gate.escalate）；**写面与明细面保留**
          ...config.views.filter((v) => rules[v]).flatMap((v) => [
            { path: `${prefix}/${v}/gates/`, method: 'GET', auth: 'none',
              what: `**已退役**（旧口径：页面只把可复制的命令准备好让用户自己拿去跑，与 29 §4「仅通过 GUI」冲突）：303 → ${prefix}/app/${v}/；审批队列读数与「批准 / 驳回」在 GUI 面板 gate.queue / gate.decided 里` },
            { path: `${prefix}/${v}/api/gates`, method: 'GET', auth: 'none',
              what: `**已退役**（同上，JSON 形态一并收口）：303 → ${prefix}/app/${v}/` },
            // 变更单**逐行明细**（同一插件的规则 ⑤）：原量×原价 → 新量×新价 → 差额，金额整数分
            { path: `${prefix}/${v}/changes/<id>/`, method: 'GET', auth: 'none',
              what: `${v} 道的变更单逐行明细页（money_unit=cents / rounding 口径写在页面上；缺依据的行明示「未纳入小计」；未知 id → 404 + next_action）` },
            { path: `${prefix}/${v}/api/changes/<id>`, method: 'GET', auth: 'none',
              what: `${v} 道的变更单逐行明细 JSON（同页同口径；lines/basis_missing/subtotal/counts/bounds；供应商侧不含任何私域列）` },
            { path: `${prefix}/${v}/gates/nudge`, method: 'POST', auth: 'none',
              what: `${v} 道的催办提交（**只落 0600 待办件**、账本零新增；202 + next_action；不改任何门的判定）` },
          ]),
          // 授权区间（`authority-band` 插件）：**旧 SSR 页/JSON 已退役**（`RETIRED_SUBVIEWS`）——
          //   旧地址不 404：303 → `${prefix}/app/<view>/`（承接面板 authority.bands，动作
          //   authority.check（只读）/ authority.escalate（人签，越界一键开人工门））
          ...config.views.filter((v) => rules[v]).flatMap((v) => [
            { path: `${prefix}/${v}/authority/`, method: 'GET', auth: 'none',
              what: `**已退役**（旧口径：页面只把可复制的命令准备好让用户自己拿去跑，与 29 §4「仅通过 GUI」冲突）：303 → ${prefix}/app/${v}/；「谁能批到多少 / 越界找谁」在 GUI 面板 authority.bands + 动作 authority.check` },
            { path: `${prefix}/${v}/api/authority`, method: 'GET', auth: 'none',
              what: `**已退役**（同上，JSON 形态一并收口）：303 → ${prefix}/app/${v}/` },
          ]),
          // RFQ 回文时限（`rfq-deadline` 插件）：**旧 SSR 页已退役**（`RETIRED_SUBVIEWS`）——
          //   旧地址不 404：303 → `/app/<view>/`（承接面板 rfq.remind-board，动作 rfq.remind /
          //   exchange.promise / exchange.inbox 认收）；**写面保留**（登记承诺只落 0600 待办件）
          ...config.views.filter((v) => rules[v]).flatMap((v) => [
            { path: `${prefix}/${v}/deadlines/`, method: 'GET', auth: 'none',
              what: `**已退役**（旧口径：页面只把命令准备好让用户复制，与 29 §4「仅通过 GUI」冲突）：303 → ${prefix}/app/${v}/；回文时限读数在 GUI 面板 rfq.remind-board` },
            { path: `${prefix}/${v}/api/deadlines`, method: 'GET', auth: 'none',
              what: `**已退役**（同上，JSON 形态一并收口）：303 → ${prefix}/app/${v}/` },
            { path: `${prefix}/${v}/deadlines/promise`, method: 'POST', auth: 'none',
              what: `${v} 道的登记承诺（承诺回文时限）：**只落 0600 待办件**、账本零新增；202 + next_action；登记不是发信；GUI 孪生动作 = exchange.promise` },
          ]),
          // 报价草稿（`quote-prepare` 插件，本批）：**不需要人类签名的写动作**必须在 APP 里真做成 ——
          //   准备（GET 表单 + 字段级校验规则）→ 落 0600 待办件（202）→ Python 侧落 `quote/drafted`
          //   （**非签名动作**）→ 两侧页面都能回读到那份草稿 → 「下一步（签署）」给可复制命令（不代签）。
          { path: `${prefix}/supplier/quotes/prepare/`, method: 'GET', auth: 'none',
            what: '供应商道的**报价草稿准备页**（行项目 / 单价整数分 / 交期 / 备注；字段级校验规则 + 行项目目录 + 已有草稿 + 「下一步（签署）」可复制命令；0 内联脚本）' },
          { path: `${prefix}/supplier/quotes/prepare/`, method: 'POST', auth: 'none',
            what: '提交报价草稿（**只落 0600 待办件**、账本零新增；202 + next_action；校验失败 400 + 字段级 errors）' },
          { path: `${prefix}/api/routes`, method: 'GET', auth: 'none', what: '本表' },
          // 注入式 UI 注册面（机制；`host/lib/ui-slot.mjs`）：只回执"谁注册了哪个槽位"，不解读区块内容
          { path: `${prefix}/api/ui/blocks`, method: 'GET', auth: 'none',
            what: '注入式 UI 注册面自述（槽位闭合集合 + 已注册区块的 plugin_id/slot/order/title；webui 不懂业务语义）'
              + '；带 `?slot=<槽位>` 时返回该槽位的**已装配 HTML**（外壳按槽位嵌进视图）' },
          // ---- GUI 应用外壳（机制；`docs/design/29-webui-gui-app.md`）：功能由插件注册面贡献 ----------
          { path: `${prefix}/`, method: 'GET', auth: 'none',
            what: 'GUI 应用外壳首屏 =「我今天要做什么」工作台（多视图导航/命令面板/通知中心/状态栏/深链/快捷键）' },
          { path: `${prefix}/app/<view>/`, method: 'GET', auth: 'none',
            what: 'GUI 视图地址（home / 各视图）；客户端按注册面渲染面板与动作，资源只来自本服务 `/assets/**`' },
          { path: `${prefix}/app/<view>/<kind>/<id>/`, method: 'GET', auth: 'none',
            what: '**对象深链**（PO / 报价 / 包 / 授标 / 变更…）：`kind` 由插件声明 `object_kind`，刷新不丢、可复制'
              + '分享；对方视角打开同一 id 只会在它自己的投影里找不到 ⇒ 如实渲染未命中态（不回落成"能看"）' },
          { path: `${prefix}/api/ui/object`, method: 'GET', auth: 'none',
            what: '对象页 JSON（view/kind/id）：谁负责这个对象类、页头（标题/摘要/事实/链接）、该对象类的动作、'
              + '本视图可用的对象类清单；未命中 ⇒ found:false + 有名 reason + 下一步' },
          { path: `${prefix}/api/ui/plugins`, method: 'GET', auth: 'none',
            what: '插件装载清单（谁在磁盘上 / 装载没装载 / mtime / 贡献与拒绝）：装载面是机制，外壳不懂业务' },
          { path: `${prefix}/api/ui/plugins/<plugin_id>/load`, method: 'POST', auth: 'none',
            what: '**运行期装载**一个插件的 UI 贡献（已装载 ⇒ 400 already-loaded + 指向 reload）' },
          { path: `${prefix}/api/ui/plugins/<plugin_id>/reload`, method: 'POST', auth: 'none',
            what: '**热重载**一个插件：撤掉它的全部贡献 → 按磁盘当前内容重新 import（?v=<mtime>）→ 重新注册；'
              + '改 `code/ui.mjs` 不必重启进程（其它插件的贡献一项未动）' },
          { path: `${prefix}/assets/app.js`, method: 'GET', auth: 'none',
            what: 'GUI 客户端脚本（**只来自本服务**：src/system/webui/code/assets/，无外网 CDN、无构建步骤）' },
          { path: `${prefix}/assets/app.css`, method: 'GET', auth: 'none', what: 'GUI 客户端样式（同上）' },
          { path: `${prefix}/manifest.webmanifest`, method: 'GET', auth: 'none',
            what: 'PWA 清单（**可安装**：`display:standalone` + 192/512 图标；清单里的 URL 一律**相对** ⇒ '
              + '任意路由前缀都对）。图标与清单都来自本服务 `code/assets/`：**没有外网 CDN**' },
          { path: `${prefix}/sw.js`, method: 'GET', auth: 'none',
            what: 'PWA 离线壳（Service Worker，**动过就别瞎缓存**）：只预缓存外壳资源 + 一份不含数据的壳 HTML；'
              + '`/api/**` 与身份/人签/邮件/运维/管理面**永不缓存**（离线=读不到，如实说），'
              + '写请求一律不拦截。策略原文在 `code/assets/sw.js`，机读副本在 `/api/ui/surface` 的 `pwa`' },
          { path: `${prefix}/api/ui/surface`, method: 'GET', auth: 'none',
            what: '注册面自述：视图 / 面板 / 动作与命令（含入参 schema、权限、确认策略）/ 快捷键 / 通知源 / 状态项'
              + ' + 逐插件的贡献清单（卸载演示与审计据此对照）' },
          { path: `${prefix}/api/ui/panels`, method: 'GET', auth: 'none',
            what: '面板数据（参数 view=home|<视图>）：通用形状 table/form/list/kv/metrics/html，由插件自己的 data() 产出；'
              + '带 `w=1` ⇒ 服务端窗口（筛选/排序/分页与计数都在全量行集上算，只回这一页）' },
          { path: `${prefix}/api/ui/notifications`, method: 'GET', auth: 'none',
            what: '通知中心（插件通知源 + 动作结果队列：进度 / 失败原因 / next_action / 待人工门）；'
              + '带 `w=1&pq={"notify":{size,page,kw,chip,tag,level,muted}}` ⇒ **通知窗口**：只回这一页，'
              + '并把在**全量产出**上算出来的数字一起给（共/命中/第 P/PP 页/未读/还剩多少没翻到）⇒ 全部通知都翻得到；'
              + '不带 `w` ⇒ 旧口径（整份 + 上限 600 条，并如实报 `dropped`）',
            auth_note: '本路由**不强制**身份：未登录也能调（返回匿名视图）；带会话时按会话身份过滤，'
              + '并且**未读**按该身份在服务端存的已读集合算（未登录 ⇒ `unread.known=false`，界面如实说）' },
          { path: `${prefix}/api/ui/notif-state`, method: 'GET', auth: 'identity',
            what: '通知偏好 / 已读 / **面板布局（顺序·折叠·隐藏）** / **筛选片**的**服务端状态**'
              + '（按会话身份；0600 文件 `<ui_shared>/webui/notif-state.json`）：换浏览器/换设备仍在；'
              + '未登录 ⇒ 401（那时只在本浏览器有效）' },
          { path: `${prefix}/api/ui/notif-state`, method: 'POST', auth: 'identity',
            what: '写通知偏好 / 已读 / 布局 / 筛选（整体替换：标已读/标未读、拖面板、切筛选都要生效；'
              + '有界 + 洗净，丢掉多少如实报 `dropped`；**只写 0600 偏好文件**，不写账本）' },
          { path: `${prefix}/api/ui/status`, method: 'GET', auth: 'none', what: '状态栏项（插件注册的状态读数）' },
          { path: `${prefix}/api/ui/jobs`, method: 'GET', auth: 'identity',
            what: '**批量动作的进度与逐条结果**（P21）：批量动作（注册面声明 `input.bulk=\'ids\'`）的服务端一半'
              + '在 **worker 线程**里跑（不再把主线程占满 N×~230ms）；这里回 `running`（正在跑的那一批：'
              + '逐条进度 `progress`/`last`/已处理几份）与 `recent`（含上一个进程留下的 `interrupted` + '
              + '`pending_ids`/`refused_ids`，只重试这些是幂等的）。0600 落 `<ui_shared>/webui/jobs.json`、'
              + '按会话身份隔离、有界；**只读**（POST 孪生 405 + Allow: GET）',
            auth_note: '按会话身份：未登录 401（这一批是谁的在记录里写着，别人的看不见）' },
          { path: `${prefix}/api/action/<id>`, method: 'POST', auth: 'none',
            what: '动作总线（JSON 入参）：校验 → 调用插件自己的**服务端一半**；`permission: human-signature` 的'
              + '动作**服务端校验署名 == 会话身份**（未登录 401 / 不一致 403 signer-mismatch）；'
              + '写动作只落 0600 待办件，落账本仍由 Python 侧唯一写者（GUI 不是第二条事实写路径）',
            auth_note: '**按动作分档**：普通动作不需要身份；声明 `permission: human-signature` 的动作必须有身份'
              + '会话且**署名 == 会话身份**（否则 401/403，账本零新增）' },
          // **同侧协作**（指派/转交、关注、评论与 @同事、活动流、已读）：侧一律取**会话身份**；
          // 数据落 `<ui_shared>/collab/<side>.json`（0600，按侧隔离）——不是合同事实，**不进账本**。
          { path: `${prefix}/api/collab/object`, method: 'GET', auth: 'identity',
            what: '一个对象上的协作面：当前指派/原因/截止、关注者名单、评论（含 @同事）、活动流、我的未读'
              + '（`?kind=&id=`；按**会话所属侧**读，对方侧读不到）' },
          { path: `${prefix}/api/collab/hub`, method: 'GET', auth: 'identity',
            what: '「我的 / 我指派的 / 全部」：指派给我的、@我的、我关注的、我指派出去的进展（工作台与通知中心用它筛选）' },
          { path: `${prefix}/api/collab/store`, method: 'GET', auth: 'identity',
            what: '协作存储自述（文件/0600/规模 + **为什么不能进账本**）；用来对账"它没进账本、没进投影"' },
          // **人员名册与角色**（同侧成员 / 角色 / 直属关系 / 按角色限动作）：`side` 一律取**会话身份**；
          // 数据落 `<ui_shared>/people/roster.json`（0600，按侧隔离）——组织与权限的**配置**，**不进账本**。
          { path: `${prefix}/api/people/roster`, method: 'GET', auth: 'identity',
            what: '本侧名册（成员 + 角色 + 直属关系 + 我的角色/额度）与策略读数（按**会话所属侧**读；'
              + '`?include_inactive=1` 连已停用的一起给）' },
          { path: `${prefix}/api/people/suggest`, method: 'GET', auth: 'identity',
            what: '**自动补全的服务端一半**：本侧名册里可 @ 的人（`value` 可直接填进动作入参）；'
              + '`?scope=all` 给各侧已知成员（维护动作用）' },
          { path: `${prefix}/api/people/store`, method: 'GET', auth: 'identity',
            what: '名册存储自述（文件/0600/有界/按侧隔离 + **为什么不能进账本**）与**策略读数**'
              + '（角色额度、越权转交角色、按角色限动作的规则表）' },
          { path: `${prefix}/api/ui/plugins/<plugin_id>/unload`, method: 'POST', auth: 'none',
            what: '撤销一个插件的**全部** UI 贡献（视图/面板/动作/快捷键/通知源/状态项/校验器 + 它注册的区块）；'
              + '页面其余部分不变（`AGENTS.md` 规则 1）' },
          // 动态路由（**路由注册面**，`host/lib/ui-route.mjs`）：注册者是插件，本表只登记元数据
          ...uiRoutes.list().map((row) => ({ path: `${prefix}${row.path}`, method: row.method,
            auth: row.auth, what: row.what, source: row.source })),
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
          { path: `${prefix}/admin/api/credentials/<name>`, method: 'POST', auth: 'admin-session', what: '提交/轮换凭据（只写不回显：响应只有 ok + next_action）' }]
          // **业务路由的 `auth` 取真实值**（不再写 `none`）：凡落在 `${prefix}/contractor|supplier/` 下的路由，
          // 一律 `identity-session` —— 与路由级身份门槛（`identity.mjs#gateBusinessRoute`）**同一判据**，
          // 按路径推导（新增业务路由不会漏标；`none` 只留给**真的公开**的入口）。
          .map((row) => (row.auth === 'none'
            && BUSINESS_SIDES.some((side) => String(row.path).startsWith(`${prefix}/${side}`))
            ? { ...row, auth: AUTH_BUSINESS, auth_note: '需要身份会话，且会话必须属于该路径那一侧' }
            : row)),
        auth_basis: {
          none: '公开入口：总览/上手/健康/自述 JSON/GUI 外壳资源与注册面/运维与系统管理页（它们自己判权限）',
          [AUTH_BUSINESS]: '业务路由：登录 + 会话必须属于该侧（未登录 401 identity-required / 浏览器 303 去登录；越侧 403 side-mismatch）',
          identity: '身份与自助面（identity.mjs 注册的动态路由，自己判身份）',
          'admin-session': '需要管理员会话（cookie 只对 admin 前缀生效）',
          token: '需要管理员 token（POST /admin/api/elevate 换会话）',
        },
        write_surface: { browser_writable: [`${prefix}/admin/**`, `${prefix}/<view>/gates/nudge`,
          `${prefix}/<view>/deadlines/promise`, `${prefix}/supplier/quotes/prepare/`,
          `${prefix}/api/action/<id>`, `${prefix}/api/ui/notif-state`, `${prefix}/mail/config/`],
          note: '浏览器能**发起**的写面都在这里（动作总线/待办件/自助面）：一律只落 0600 待办件或**委托**'
            + '既有唯一写者；`permission: human-signature` 的动作还要**服务端校验署名 == 会话身份**'
            + '（`/api/action/<id>`），界面不代签、不写账本' },
      })
    }
    // ---- 报价草稿（`quote-prepare` domain 插件，本批）：唯一写面 = POST **只落一条 0600 待办件** ----
    //   · `GET  /<prepare-view>/quotes/prepare/`：SSR 准备页（表单 + 字段校验规则 + 行项目目录 +
    //     已有草稿 + 「下一步（签署）」可复制命令；页面 **0 内联脚本**）；
    //   · `POST 同路径`：**字段级**校验 → 通过则只落 0600 待办件（**账本零新增**）→ **202** + `next_action`；
    //     校验失败 **400** + `errors[{field, code, message, next_action}]`（逐字段，不吞成一句「参数错误」）；
    //     **绝不**返回与 GET 相同的 200 页面（那是「假成功」，本批结构性禁止）。
    const preparePath = /^\/([a-z]+)\/quotes\/prepare\/?$/.exec(path)
    if (preparePath) {
      const view = preparePath[1]
      if (!rules[view] || view !== prepView()) {
        return json(404, { ok: false, code: 'prepare-route-not-found', view,
          next_action: `「准备报价」只有 ${prepView()} 道有这一步：${prefix}/${prepView()}/quotes/prepare/` })
      }
      if (String(req.method) !== 'POST') {
        return send(200, 'text/html; charset=utf-8',
          html(`${config.page_title} · ${rules[view].title} · 准备报价草稿`, prepPageHtml(view, url), prefix))
      }
      return readBody((body) => {
        const out = submitDraft(view, new URLSearchParams(body))
        if (!out.ok && out.code === 'validation-failed') {
          return json(400, { service: 'quote-prepare', view, ok: false, code: out.code,
            errors: out.errors, counts: { errors: out.errors.length }, next_action: out.next_action })
        }
        if (!out.ok) {
          return json(out.code === 'pending-write-failed' ? 500 : 400,
            { service: 'quote-prepare', view, ok: false, code: out.code ?? 'refused',
              next_action: out.next_action })
        }
        return json(202, { service: 'quote-prepare', view, ok: true, code: 'accepted', id: out.id,
          pending: out.file, duplicate: Boolean(out.duplicate), payload_sha256: out.payload_sha256,
          money_unit: prepare.limits().money_unit,
          fields: { rfq_id: out.record.rfq_id, item_id: out.record.item_id,
            unit_price_cents: out.record.unit_price_cents, lead_time_days: out.record.lead_time_days,
            currency: out.record.currency, prepared_by: out.record.prepared_by,
            note_sha256: out.record.note_sha256, lines_sha256: out.record.lines_sha256 },
          next_action: out.next_action })
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
        // P34：读数降级**只在真的降级时**加键（健康账本的响应逐字节不变，门 E11 的基线不动）
        const degraded = typeof ledger.health === 'function' ? ledger.health().degraded : null
        try {
          const report = ledger.verify()
          ledgers[view] = { path: ledger.path, count: report.count, healthy: report.ok, head: report.head }
        } catch (err) {
          ledgers[view] = { path: ledger.path, healthy: false, reason: String(err).slice(0, 80) }
        }
        if (degraded) {
          // 降级时**人话原因优先**（Python 侧的 `Command failed: ...` 是给日志看的，不是给办理人看的）
          ledgers[view] = { ...ledgers[view], healthy: false,
            reason: degraded.reason ?? ledgers[view].reason,
            degraded: { code: degraded.code, dropped: degraded.dropped, first_bad_line: degraded.first_bad_line,
              lines: degraded.lines, reason: degraded.reason, next_action: degraded.next_action } }
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
            [[`${prefix}/contractor/heuristics/`, '比价口径（承包商）'], [`${prefix}/supplier/heuristics/`, '比价口径（供应商）']],
            [[`${prefix}/app/contractor/`, '审批队列（承包商 · GUI）'], [`${prefix}/app/supplier/`, '审批队列（供应商 · GUI）']],
            [[`${prefix}/app/contractor/`, '授权区间（承包商 · GUI）'], [`${prefix}/app/supplier/`, '授权区间（供应商 · GUI）']])
          + `<p>JSON：<code>${prefix}/api/ops</code></p>`
          + `<h3 id="runtime">运行期</h3><p>${ops.summary({ rows: [] })}</p>`
          + `<table><tr><th>governor</th><th>breaker</th></tr>`
          + `<tr><td>admitted=${g.admitted ?? 0} refused=${g.refused ?? 0} timeouts=${g.timeouts ?? 0} failed=${g.failed ?? 0}</td>`
          + `<td>allowed=${b.allowed ?? 0} refused=${b.refused ?? 0} opened=${b.opened ?? 0} closed=${b.closed ?? 0}</td></tr></table>`
          + `<p><a href="${prefix}/ops/mail/">邮件域（SMTP/IMAP）专页</a>：队列计数 / 最近一次真尝试的结果与 reason / `
          + `available / next_action（数据来自 Python 侧快照；宿主只读，不联网不发信）。**未配置凭据时必须报不可用**`
          + `（配置后由 <code>services/mail_transport</code> 的真实状态派生）。</p>`
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
    if (/^\/api\/retention\/?$/.test(path)) {
      const plan = retentionPlanOf('contractor') ?? retentionPlanOf('supplier')
      const snap = retention.snapshot(plan)
      // P32：留存计划的 `items` 是**外部给的行数组**（Python 侧判定产物）⇒ 走唯一读数入口，
      // 坏行**逐条计数并如实报出**（不静默丢）。注：`/api/retention` 的**顶层键集被 webui 门 E12 冻结**
      // ⇒ 读数写进已有的 `note`，不加新键；`snap` 的形状也不动（它被 `retention-view` 门逐字对齐）。
      const planItems = Array.isArray(plan?.items) ? plan.items : []
      const itemsRead = readRows(planItems)
      return json(200, { source: 'retention-view（subagent 产出、经自进化流程晋升）+ services/retention.py（判定）',
        retention: snap, headline: retention.headline(plan),
        note: '留存计划是**判定**不是执行：账本行永不销毁；销毁只作用于派生副本且不可重建物须过人工门'
          + (itemsRead.bad > 0
            ? `（本次读数：条目 ${planItems.length} 条，读到 ${itemsRead.rows.length} 条，另有 ${itemsRead.bad} 条`
              + '读不出来（形状异常：不是对象）—— 好条照列，坏条已跳过并计数（不静默丢））'
            : '') })
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
    // 审批等多久 / 变更单谁卡着（gate-timeline 插件）：催办 POST **只落 0600 待办件**（账本零新增）
    const viewGatesNudge = path.match(/^\/([a-z]+)\/gates\/nudge\/?$/)
    if (viewGatesNudge && rules[viewGatesNudge[1]]) {
      const view = viewGatesNudge[1]
      if (String(req.method) !== 'POST') {
        return json(405, { service: 'gate-timeline', view, ok: false, code: 'method-not-allowed',
          next_action: '催办用 POST（页面上的表单就是 POST；本路由没有 GET 形态）' })
      }
      return readBody((body) => {
        const out = submitNudge(view, new URLSearchParams(body))
        const code = out.ok ? 202
          : (out.code === 'pending-write-failed' ? 500 : (out.code === 'gate-not-found' ? 404 : 400))
        return json(code, { service: 'gate-timeline', view, ...out })
      })
    }
    // 审批与变更（`gate-timeline` 插件）的**旧 SSR 页 / JSON 已退役**（`RETIRED_SUBVIEWS`）：
    //   `/<view>/gates/` 与 `/<view>/api/gates` 现为 **303 → `${prefix}/app/<view>/`**（不 404 让人失联），
    //   承接者 = GUI 面板 `gate.queue`（**行内「批准 / 驳回」，人签**：`gate.grant` / `gate.deny`）、
    //   `gate.decided`（已决定的门留痕）、`gate.todo`（工作台「要人决定的事」）。
    //   这里**只留写面**：`POST /<view>/gates/nudge`（催办，只落一条 0600 待办件，上面那段）。
    // 变更单**逐行明细**（gate-timeline 插件规则 ⑤）：两条只读路由（**账本零新增**、不取墙钟）；
    // 未知 id ⇒ 404 + `next_action`（页面与 JSON 都是 404，不静默返回空页）。
    const viewChangeDetailApi = path.match(/^\/([a-z]+)\/api\/changes\/([A-Za-z0-9_.:-]+)\/?$/)
    if (viewChangeDetailApi && rules[viewChangeDetailApi[1]]) {
      const out = changeDetailJson(viewChangeDetailApi[1], viewChangeDetailApi[2])
      return json(out.reason === 'change-not-found' ? 404 : 200, out)
    }
    const viewChangeDetailPage = path.match(/^\/([a-z]+)\/changes\/([A-Za-z0-9_.:-]+)\/?$/)
    if (viewChangeDetailPage && rules[viewChangeDetailPage[1]]) {
      const view = viewChangeDetailPage[1]
      const id = viewChangeDetailPage[2]
      const run = changeDetailRun(view, id)
      return send(run.reason === 'change-not-found' ? 404 : 200, 'text/html; charset=utf-8',
        html(`${config.page_title} · ${rules[view].title} · 变更单明细 ${id}`, changeDetailHtml(view, id, run), prefix))
    }
    const viewHeuristicsPage = path.match(/^\/([a-z]+)\/heuristics\/?$/)
    if (viewHeuristicsPage && rules[viewHeuristicsPage[1]]) {
      // 页面：SSR + `<form method=get>` 调权重（零内联脚本；改权重这件事本身也不产生任何写入）
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · ${rules[viewHeuristicsPage[1]].title} · 比价口径`,
          heuristicsHtml(viewHeuristicsPage[1], url), prefix))
    }
    // 授权区间（`authority-band` 插件）的**旧 SSR 页 / JSON 已退役**（`RETIRED_SUBVIEWS`）：
    //   `/<view>/authority/` 与 `/<view>/api/authority` 现为 **303 → `${prefix}/app/<view>/`**（不 404），
    //   承接者 = GUI 面板 `authority.bands`（同侧视图页上）与两个动作：
    //   `authority.check`（只读：这笔金额落在谁的区间里 / 越界多少 / 下一个能批的人是谁，**账本零新增**）
    //   与 `authority.escalate`（人签：越界**一键把这件事提成人工门**，门开出来后去审批队列批准/驳回）。
    //   两条旧路由此前只做「把命令准备好让用户复制」，正是 29 §2 要删的旧口径。
    // RFQ 回文时限（rfq-deadline 插件）：**旧 SSR 页已退役**（见 RETIRED_SUBVIEWS：`/<view>/deadlines/`
    // 与 `/<view>/api/deadlines` 现为 303 → `/app/<view>/`，页面面板 `rfq.remind-board` 承接同一件事）。
    //   本批只保留**写面**：`/<view>/deadlines/promise` 登记「承诺回文时限」（发言人 + 时限 + RFQ id +
    //   原话只留 sha256）—— 它只落 0600 待办件（账本零新增、不发信），唯一落账本者是 Python 侧。
    const viewDeadlinesPromise = path.match(/^\/([a-z]+)\/deadlines\/promise\/?$/)
    if (viewDeadlinesPromise && rules[viewDeadlinesPromise[1]]) {
      const view = viewDeadlinesPromise[1]
      if (String(req.method) !== 'POST') {
        return json(405, { service: 'rfq-deadline', view, ok: false, code: 'method-not-allowed',
          next_action: '登记承诺用 POST（GUI 里的孪生动作是 exchange.promise；本路由没有 GET 形态）' })
      }
      return readBody((body) => {
        const out = submitPromise(view, new URLSearchParams(body))
        const code = out.ok ? 202
          : (out.code === 'pending-write-failed' ? 500 : (out.code === 'rfq-not-found' ? 404 : 400))
        return json(code, { service: 'rfq-deadline', view, ...out })
      })
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
        [[`${prefix}/contractor/heuristics/`, '比价口径（承包商）'], [`${prefix}/supplier/heuristics/`, '比价口径（供应商）']],
        [[`${prefix}/app/contractor/`, '审批队列（承包商 · GUI）'], [`${prefix}/app/supplier/`, '审批队列（供应商 · GUI）']],
        [[`${prefix}/app/contractor/`, '授权区间（承包商 · GUI）'], [`${prefix}/app/supplier/`, '授权区间（供应商 · GUI）']])}`
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
    return json(404, { error: 'not-found', path, hint: `可用：${prefix}/ / ${prefix}/contractor/ / ${prefix}/supplier/ / ${prefix}/ops/ / ${prefix}/ops/mail/ / ${prefix}/app/<view>/ / ${prefix}/api/status / ${prefix}/api/obs / ${prefix}/api/ops / ${prefix}/api/retention / ${prefix}/api/mail / ${prefix}/api/ui/blocks / ${prefix}/<view>/api/history / ${prefix}/<view>/api/evidence / ${prefix}/<view>/api/scorecard / ${prefix}/<view>/api/approvals / / ${prefix}/<view>/heuristics/ / ${prefix}/<view>/api/heuristics / ${prefix}/<view>/changes/<id>/ / ${prefix}/<view>/api/changes/<id> / ${prefix}/admin/ / ${prefix}/admin/api/blocks / ${prefix}/admin/api/elevate / ${prefix}/admin/api/switch?to=<view>（**已退役**的 ${prefix}/<view>/{advice,deadlines,gates,authority}/ 与对应 /api/ 会 303 到 ${prefix}/app/<view>/；催办 / 登记承诺两条写面仍在）` })
  }

  // 零残留：server 是 fiber 的 effect，dispose 即关闭（端口释放）
  ctx.effect(() => () => new Promise((resolve) => server.close(resolve)))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.listen_host, () => {
      // port=0 → 由内核分配临时端口；实际端口**必须**从 server.address() 读（fixture 靠它做 HTTP 检查）
      const port = server.address().port
      ctx.provide('uiSlots', uiSlots)      // 注入式 UI 注册面（机制）：插件据此提交自己的区块
      ctx.provide('uiRoutes', uiRoutes)    // 路由注册面（机制）：插件据此注册自己的 HTTP 路由
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
