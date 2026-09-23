/**
 * `system/mail` 的 **GUI 贡献** —— 邮件通道（SMTP / IMAP）在**界面里**的入口。
 *
 * 为什么要这块（缺陷真源，逐字）：`docs/work/plans/webui-ui-defects.md` **DEF-025**
 * 「邮件通道只能看状态，改配置要跳到提权后的 admin 道」——运维在通道不可用时**当场修好**，
 * 而不是把它当成一条离线工单；P3 走查也如实登记「没有任何界面入口能把 SMTP 配好」。
 *
 * 本文件注册的东西（**机制上只有三样**，业务判定一律在既有服务端面上）：
 *   · 面板 `mail.channel`（工作台首屏，`view: 'home'`，kind `html`）：**通道状态 + 界内配置表单**。
 *     表单是**普通 HTML 表单**（`method=post`），提交到**既有**的 `/mail/config/`
 *     （`code/identity.mjs` 里那条：运维侧身份 + `signature` 必须等于会话身份 → `identity-mail-apply.py`
 *     → 唯一落盘者 `config-apply.py` 写 YAML）。本插件**不写文件、不落账本、不碰凭据**：
 *     它只把「入口」与「表单」摆到界面上（凭据值永不回显的口径不变）。
 *   · 状态栏项 `status.mail`：SMTP / IMAP 可用性一行读数（读 Python 侧快照 `<ui_shared>/mail.json`，
 *     读不到就**如实**说读不到，并指向 `${prefix}/ops/mail/`）。
 *   · 通知源 `notify.mail`：通道不可用（`available=false`）或最近一次尝试失败时，给一条带深链的通知。
 *
 * 纪律：不 import `node:fs`（读文件走外壳给的 `host.readJson`）、不起子进程、不写账本、不取墙钟、
 * 不发信；一切「能不能改」由服务端一半（身份页）判，本文件**不预判权限**（只如实说明）。
 */

export const plugin_id = 'system/mail'

/** 邮件摘要的**唯一落盘者/发信者**（Python 侧；本文件不读账本、不发信、不落盘）。 */
export const DIGEST_TOOL = 'src/system/mail/tools/mail-digest.py'
/** 摘要偏好与状态的落点（相对 `ui_shared`；目录 0700 / 文件 **0600**，由工具侧写）。 */
export const DIGEST_FILES = { prefs: 'mail/notify-prefs.json', state: 'mail/notify-state.json',
  journal: 'mail/notify-journal.jsonl' }
/** 待办件的 kind（落 `<ui_shared>/mail-notify/` 与 `<ui_shared>/mail-digest/`，0600）。 */
export const DIGEST_PENDING = { prefs: 'mail-notify', digest: 'mail-digest' }

/** 表单里可改的键（**与身份页的白名单同一集合**：其余键仍走 `/admin/api/config/**`）。 */
export const MAIL_FORM_KEYS = [
  { name: 'mail.smtp.host', label: 'SMTP 主机', kind: 'text', placeholder: 'smtp.example.com' },
  { name: 'mail.smtp.port', label: 'SMTP 端口', kind: 'text', placeholder: '587' },
  { name: 'mail.smtp.from', label: '发件人', kind: 'text', placeholder: 'quotes@example.com' },
  { name: 'mail.smtp.username', label: 'SMTP 账号', kind: 'text', placeholder: '（口令走凭据面，不在本页）' },
  { name: 'mail.imap.host', label: 'IMAP 主机', kind: 'text', placeholder: 'imap.example.com' },
  { name: 'mail.imap.port', label: 'IMAP 端口', kind: 'text', placeholder: '993' },
  { name: 'mail.imap.username', label: 'IMAP 账号', kind: 'text', placeholder: '' },
]

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 快照 → 一句话通道读数（**只读投影**：形状不对就说读不出来，不猜）。 */
export const summarize = (payload) => {
  if (!plain(payload)) {
    return { ok: false, reason: 'mail-snapshot-unavailable',
      text: '邮件通道状态读不到（快照文件缺失或不可读）',
      next_action: '先看运维专页（/mail/config/ 与 /ops/mail/）的读数与 reason（那一页走 Python 侧快照）' }
  }
  const transport = plain(payload.transport) ? payload.transport : null
  const one = (name) => {
    const row = transport && plain(transport[name]) ? transport[name] : null
    if (!row) return { name, configured: false, available: false, reason: 'mail-snapshot-shape-invalid' }
    return { name, configured: row.configured === true, available: row.available === true,
      reason: asText(row.reason) }
  }
  const smtp = one('smtp')
  const imap = one('imap')
  const last = transport && plain(transport.last_attempt) ? transport.last_attempt : null
  const text = `SMTP ${smtp.available ? '可用' : `不可用（${smtp.reason || '未配置'}）`}`
    + ` · IMAP ${imap.available ? '可用' : `不可用（${imap.reason || '未配置'}）`}`
    + (last ? ` · 最近一次 ${asText(last.kind)}/${asText(last.service)} ${last.ok === true ? '成功' : '失败'}`
      : ' · 还没有发送/收信记录')
  return { ok: true, smtp, imap, last, text, reason: '',
    next_action: smtp.available && imap.available ? '' : '在下面的表单里改 SMTP/IMAP 配置（或去 /mail/config/）' }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const prefix = asText(host.prefix) || ''
  const mailTarget = `${prefix}/mail/config/`
  const opsPage = `${prefix}/ops/mail/`

  /** 状态读数：读 Python 侧快照（`<ui_shared>/mail.json`）；读不到 ⇒ 如实降级，不猜。 */
  const readStatus = () => {
    const payload = host.readJson(host.sharedFile('mail.json'))
    return { payload, verdict: summarize(payload) }
  }

  // ---- 面板：通道状态 + **界内配置表单**（工作台首屏）------------------------------------------------
  out.push(surface.panel({ plugin_id: me, id: 'mail.channel', title: '邮件通道（SMTP / IMAP）：状态与配置入口',
    view: 'home', order: 40, kind: 'html',
    data: () => {
      const { verdict } = readStatus()
      const stateLine = verdict.ok
        ? `<p data-mail-channel="status" data-mail-smtp="${verdict.smtp.available ? 'up' : 'down'}"`
          + ` data-mail-imap="${verdict.imap.available ? 'up' : 'down'}"><b>${esc(verdict.text)}</b></p>`
        : `<p data-mail-channel="status" data-mail-degraded="1"><b>${esc(verdict.text)}</b>`
          + ` <code>${esc(verdict.reason)}</code> —— 不猜：状态读数只在运维专页上给。</p>`
      const fields = MAIL_FORM_KEYS.map((field) => `<label>${esc(field.label)} `
        + `<input name="${esc(field.name)}" size="24" placeholder="${esc(field.placeholder)}"></label>`).join('<br>')
      return { ok: true, kind: 'html', html:
        `<p data-mail-channel="mechanism">这一块是界面入口：邮件通道不可用时，有权限的人在这里当场改好，`
        + `不必跳 <code>/admin/config/</code>（也不用提权）。提交后由既有唯一落盘者 `
        + `<code>config-apply.py</code> 落 YAML；<b>凭据（口令）永不回显</b>，也永远不经本页传输。</p>`
        + stateLine
        + `<h3>改配置（SMTP / IMAP）</h3>`
        + `<p><small>字段名就是配置键名（<code>mail.smtp.*</code> / <code>mail.imap.*</code>）；`
        + `服务端会干跑（白名单 + 类型 + 人工门 + diff）后再落盘。</small></p>`
        + `<form method="post" action="${esc(mailTarget)}" data-mail-config-form="1">`
        + `${fields}<br>`
        + `<label>SMTP 握手 <select name="mail.smtp.security">`
        + `<option value="starttls">starttls</option><option value="ssl">ssl</option>`
        + `<option value="plain">plain</option></select></label><br>`
        + `<label><input type="checkbox" name="mail.smtp.require_auth" value="true"> SMTP 需要账号口令`
        + `（口令请写进凭据面：<code>${esc(`${prefix}/admin/api/credentials/mail_smtp`)}</code>，只写不回显）</label><br>`
        + `<label>署名（必须等于会话身份） <input name="signature" size="18" placeholder="human:<你的名字>" required></label> `
        + `<label>事实时刻 now <input name="now" size="22" value="2026-09-30T00:00:00Z" required></label> `
        + `<input type="hidden" name="next" value="${esc(`${prefix}/app/home/`)}">`
        + `<button type="submit">干跑 → 落盘</button></form>`
        + `<p><small><b>权限</b>：只有运维侧身份能改（<code>/mail/config/</code> 的服务端一半校验：side=ops + `
        + `署名 == 会话身份）；其他身份提交会被拒（<code>permission-denied</code> / <code>signer-mismatch</code>，`
        + `零落盘）。没登录就先 <a href="${esc(`${prefix}/identity/?next=${encodeURIComponent(mailTarget)}`)}">登录</a>。`
        + `状态读数与尝试记录全在 <a href="${esc(opsPage)}" data-mail-ops-link="1">运维专页</a>`
        + `（同一个入口也在 <a href="${esc(mailTarget)}" data-mail-config-link="1">${esc(mailTarget)}</a>，`
        + `那一页会把署名按会话预填好）。</small></p>`,
      }
    } }))

  // ---- 状态栏：一行通道读数（读快照；读不到如实说）--------------------------------------------------
  out.push(surface.statusItem({ plugin_id: me, id: 'status.mail', title: '邮件通道', order: 40, read: () => {
    const { verdict } = readStatus()
    if (!verdict.ok) {
      return { text: '邮件通道：状态读不到', level: 'warn',
        next_action: `去 ${opsPage} 看 Python 侧快照的 reason` }
    }
    const down = !verdict.smtp.available || !verdict.imap.available
    return { text: verdict.text, level: down ? 'warn' : 'ok',
      next_action: down ? `改配置：${mailTarget}（界面入口在工作台首屏的「邮件通道」面板）` : '' }
  } }))

  // ---- 通知源：通道不可用 / 最近一次尝试失败（带深链；不假装已发）-------------------------------------
  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.mail', title: '邮件通道', order: 40,
    poll: () => {
      const { verdict } = readStatus()
      const items = []
      if (!verdict.ok) {
        items.push({ id: 'mail:status:unavailable', level: 'warn', at: '',
          title: '邮件通道：状态读不到（快照缺失/不可读）',
          body: verdict.reason,
          next_action: `打开 ${opsPage} 看 reason；配好之后这一条会消失` })
        return items
      }
      const down = [verdict.smtp, verdict.imap].filter((row) => !row.available)
      if (down.length) {
        items.push({ id: 'mail:channel:down', level: 'warn', at: '',
          title: `邮件通道不可用：${down.map((row) => `${row.name}(${row.reason || '未配置'})`).join(' · ')}`,
          body: '通道不可用时通知不会真的发出（界面如实说没发出，不假装已发）',
          next_action: `在这个界面入口改配置：${mailTarget}` })
      }
      if (verdict.last && verdict.last.ok !== true) {
        items.push({ id: 'mail:attempt:failed', level: 'bad', at: '',
          title: `最近一次邮件尝试失败：${asText(verdict.last.kind)}/${asText(verdict.last.service)}`,
          body: asText(verdict.last.reason) || '(reason 未给出)',
          next_action: asText(verdict.last.next_action) || `去 ${opsPage} 看尝试记录` })
      }
      return items
    } }))

  // ---- 邮件摘要（**把人从浏览器里释放出来**：人不在页面时，「有事等你」会在收件箱里说一声）-------------
  // 本文件只做三件事：把**偏好**与**发一封**摆到界面上（两个动作 + 一块面板 + 一条状态）；
  // 判定与落盘全在 Python 侧唯一实现里（`tools/mail-digest.py`）：开关默认关、去重、节流、
  // 私域/凭据/对方正文扫描、发信走既有 SMTP 通道。**本文件不读账本、不发信、不写文件**。
  // 「谁在等我」这一份由外壳的机制面给（`host.digest()`：按**会话身份**聚合后的通知，只带
  // 标题/下一步/来源/深链/计数，**不带通知正文**）—— 谁的事实谁给。
  const prefsDoc = () => {
    const doc = host.readJson(host.sharedFile(DIGEST_FILES.prefs))
    return plain(doc) ? doc : {}
  }
  const digestStateDoc = () => {
    const doc = host.readJson(host.sharedFile(DIGEST_FILES.state))
    return plain(doc) ? doc : {}
  }
  const prefsEntryOf = (human) => {
    const row = plain(prefsDoc().identities) ? prefsDoc().identities[human] : null
    return plain(row) ? row : null
  }
  const digestStateOf = (human) => {
    const row = plain(digestStateDoc().identities) ? digestStateDoc().identities[human] : null
    return plain(row) ? row : null
  }
  const domainOf = (address) => (asText(address).includes('@') ? asText(address).split('@').pop() : '')
  const onOf = (value) => value === true || ['1', 'true', 'on', 'yes'].includes(asText(value).toLowerCase())
  const levelText = { bad: '只发最急（bad）', warn: '待办及以上（warn，默认）', info: '连知会也发（info）' }
  /** 工具回执 → 界面要的那几个数（**只搬白名单键**：工具回执里没有地址原文、没有正文）。 */
  const digestResult = (json, staged, receipt) => ({
    pending: staged.name, code: json.code ?? null,
    to_domain: json.to_domain ?? null, to_digest: json.to_digest ?? null,
    on: json.on ?? null, min_level: json.min_level ?? null, throttle_min: json.throttle_min ?? null,
    sent: json.sent === true, items: json.items ?? json.counts?.listed ?? 0, new_items: json.new_items ?? 0,
    duplicates: json.duplicates ?? 0, withheld: json.withheld ?? json.counts?.withheld ?? 0,
    message_id: json.message_id ?? null, server: json.server ?? null,
    last_sent_at: json.last_sent_at ?? null, next_allowed_at: json.next_allowed_at ?? null,
    counts: json.counts ?? null, files: DIGEST_FILES, ledger_added: json.ledger_added ?? 0,
    writer: receipt ? { rc: receipt.rc, ok: receipt.ok,
      applied: receipt.applied.map((entry) => (typeof entry === 'string' ? entry : (entry?.file ?? null))),
      refused: receipt.refused.map((entry) => (entry?.code ?? null)) } : null,
  })

  // ---- 面板：**我个人现在是什么状态**（开关 / 地址域名 / 上一次 / 文件在哪）-----------------------------
  out.push(surface.panel({ plugin_id: me, id: 'mail.notify', title: '邮件摘要：有事等你时发一封到你邮箱',
    view: 'home', order: 41, kind: 'table',
    actions: ['mail.notify.send'], hint: '行内「改摘要偏好」按这一行的值预填；「发一份摘要」立刻按当前条目发一封',
    data: (ctx) => {
      const who = ctx?.identity ?? null
      const human = who ? asText(who.human) : ''
      const row = human ? prefsEntryOf(human) : null
      const st = human ? digestStateOf(human) : null
      const on = Boolean(row && row.on === true)
      const stateText = !who
        ? '未登录：摘要偏好按身份存（登录后才知道是你的哪一条）'
        : (!row ? '关（默认关：还没有你这个身份的偏好记录）'
          : (on ? `开 → ${domainOf(row.to)}（地址只在发信那一刻使用）` : '关（有记录，开关是关的）'))
      const lastText = !st || !asText(st.last_code)
        ? '还没有尝试记录'
        : `${asText(st.last_code)} · ${asText(st.last_at) || '（无时刻）'} · 成功 ${Number(st.sends) || 0} 次`
          + (plain(st.refusals) && Object.keys(st.refusals).length
            ? ` · 未发送：${Object.entries(st.refusals).map(([code, n]) => `${code}×${n}`).join(' / ')}` : '')
      return {
        ok: true, kind: 'table',
        columns: [{ key: 'pref', label: '这一份' }, { key: 'state', label: '现在的开关' },
          { key: 'level', label: '发什么' }, { key: 'last', label: '上一次' }, { key: 'files', label: '落点（0600）' }],
        rows: [{
          pref: '邮件通知摘要（待办 / 未读发到邮箱）',
          state: stateText,
          level: `${levelText[asText(row?.min_level) || 'warn'] || '待办及以上'} · 节流 `
            + `${Number(row?.throttle_min ?? 15)} 分钟`,
          last: lastText,
          files: `${DIGEST_FILES.prefs} · ${DIGEST_FILES.state}`,
          // 行内动作按**同一行的字段名**预填（机制）：名字对不上就等于让人手抄一遍
          id: human || 'anonymous', on,
          to: row ? asText(row.to) : '', min_level: asText(row?.min_level) || 'warn',
          throttle_min: Number(row?.throttle_min ?? 15),
          // 两个入口都长在这一行上（机制：行内动作 = 按钮，字段按同名预填 ⇒ 不必手抄地址）
          row_actions: ['mail.notify.prefs', 'mail.notify.send'],
        }],
        note: '摘要只带标题 / 下一步 / 来源 / 深链 / 计数（通知正文、对方正文、私域字段与凭据都不进摘要）；'
          + '同一件事重复通知不重复发（键 = 条目 id + 级别），窗口内不发第二封（节流）；'
          + '它不写账本（发信回执里 `ledger_added: 0`）。开关与地址是你自己的偏好。',
        empty_reason: null,
        next_action: who ? '要改就点这一行的「改摘要偏好」；想立刻看一封就点「发一份摘要」'
          : `先登录（${prefix}/identity/）——偏好按身份存，没登录时不知道该读谁的`,
      }
    } }))

  // ---- 动作：改偏好（开关 / 地址 / 级别 / 节流）----------------------------------------------------
  out.push(surface.action({ plugin_id: me, id: 'mail.notify.prefs', title: '改摘要偏好（开关 / 收件地址）',
    views: ['home', 'contractor', 'supplier'], group: '邮件摘要', order: 45,
    placement: ['toolbar', 'inline', 'command'], confirm: { required: false },
    hint: '按会话身份存（0600、跨浏览器仍在）：默认关；打开时必须给合法收件地址',
    input: { fields: [
      { name: 'on', label: '打开邮件摘要', type: 'checkbox', help: '关掉后不再发（已经发出去的那几封不会撤回）' },
      { name: 'to', label: '收件地址', type: 'text',
        help: '例：wanglei@example.com；只在发信那一刻使用 —— 回执与日志里只留域名与指纹' },
      { name: 'min_level', label: '最低级别', type: 'select', options: ['warn', 'bad', 'info'], default: 'warn',
        help: 'warn = 待办及以上（默认）；bad = 只发最急的；info = 连知会也发' },
      { name: 'throttle_min', label: '节流窗口（分钟）', type: 'number', min: 0, max: 1440, default: 15,
        help: '窗口内不发第二封（0 = 关掉节流）；同一个条目不会重复发' },
    ] },
    server: async (ctx, input) => {
      const who = ctx?.identity ?? null
      if (!who) {
        return { ok: false, code: 'identity-required',
          reason: '摘要偏好按身份存：当前请求没有会话身份，这一次什么都没写',
          next_action: `先登录（${prefix}/identity/?next=${encodeURIComponent(`${prefix}/app/home/`)}）再点这个按钮` }
      }
      const record = { op: 'prefs-set', kind: DIGEST_PENDING.prefs, identity: who.human, side: who.side,
        on: onOf(input.on), to: asText(input.to), min_level: asText(input.min_level) || 'warn',
        throttle_min: Number.isFinite(Number(input.throttle_min)) ? Number(input.throttle_min) : 15,
        requested_at: host.now(),
        note: `摘要偏好（开关/地址/级别/节流）：${who.human} 在 ${who.side} 侧提交（工具侧校验后落 0600）` }
      const staged = host.stage(DIGEST_PENDING.prefs, record)
      if (!staged.ok) return staged
      const run = host.runPython(DIGEST_TOOL, ['--op', 'prefs-set', '--shared-dir', host.sharedDir,
        '--request', staged.path])
      const json = plain(run.json) ? run.json : {}
      const receipt = host.writerReceipt(run)
      const ok = run.ok === true && json.ok === true
      return { ok, code: json.code ?? receipt.code ?? (ok ? 'prefs-saved' : 'writer-failed'),
        reason: json.reason ?? receipt.reason ?? run.reason ?? '',
        next_action: ok
          ? (json.on === true ? '开关是开：有新的待办/未读时点「发一份摘要」（或在界面上点一下）就会到你的邮箱'
            : '开关是关：摘要不会发出去')
          : (json.next_action ?? receipt.next_action ?? '看服务日志里这一条工具的 stdout/stderr'),
        result: digestResult(json, staged, receipt) }
    } }))

  // ---- 动作：立刻发一份（走既有 SMTP 通道；去重/节流/扫描都在工具侧）-----------------------------------
  out.push(surface.action({ plugin_id: me, id: 'mail.notify.send', title: '发一份摘要（待办 / 未读）',
    views: ['home', 'contractor', 'supplier'], group: '邮件摘要', order: 46,
    placement: ['toolbar', 'inline', 'command'],
    confirm: { required: true, message: '这会给你的邮箱发一封信（按你自己的偏好与节流窗口）——确认发？' },
    hint: '条目来自按会话身份聚合后的通知（只带标题/下一步/来源/深链/计数）；开关关着、没有新条目、'
      + '或窗口内 ⇒ 不发并如实说明原因；它不写账本',
    input: { fields: [
      { name: 'min_level', label: '发到哪一级', type: 'select', options: ['warn', 'bad', 'info'], default: 'warn',
        help: 'warn = 待办及以上（默认）；info = 连知会也发' },
      { name: 'limit', label: '最多列几条', type: 'number', min: 1, max: 40, default: 20 },
      { name: 'force', label: '忽略节流与去重（仍然不绕过扫描）', type: 'checkbox',
        help: '想看一封"完整重发"时用；私域/凭据/正文扫描一律照旧' },
    ] },
    server: async (ctx, input) => {
      const who = ctx?.identity ?? null
      if (!who) {
        return { ok: false, code: 'identity-required',
          reason: '摘要按会话身份聚合（未登录时不知道"谁的事"），这一次什么都没写',
          next_action: `先登录（${prefix}/identity/）再点这个按钮` }
      }
      const minLevel = ['info', 'warn', 'bad'].includes(asText(input.min_level)) ? asText(input.min_level) : 'warn'
      const digest = host.digest({ min_level: minLevel, limit: Number(input.limit) || 20 })
      if (digest.ok !== true) {
        return { ok: false, code: digest.code ?? 'digest-failed', reason: digest.reason ?? '',
          next_action: digest.next_action ?? '看 reason 与上一步' }
      }
      const record = { op: 'digest', kind: DIGEST_PENDING.digest, identity: digest.identity, side: digest.side,
        prefix: digest.prefix, generated_at: digest.generated_at, limit: digest.limit, level: minLevel,
        counts: digest.counts, items: digest.items, withheld: digest.withheld,
        requested_at: host.now(),
        note: `待办/未读摘要：待办 ${digest.counts.todo} 件（急 ${digest.counts.bad} 件）· 列 ${digest.counts.listed} 条`
          + ` · 未读 ${digest.counts.unread_known ? digest.counts.unread : '（服务端不知道）'}` }
      const staged = host.stage(DIGEST_PENDING.digest, record)
      if (!staged.ok) return staged
      const args = ['--op', 'digest', '--shared-dir', host.sharedDir, '--request', staged.path,
        '--now', digest.generated_at]
      if (input.force === true) args.push('--force')
      const run = host.runPython(DIGEST_TOOL, args)
      const json = plain(run.json) ? run.json : {}
      const receipt = host.writerReceipt(run)
      const ok = run.ok === true && json.ok === true && json.sent === true
      return { ok, code: json.code ?? receipt.code ?? (ok ? 'digest-sent' : 'writer-failed'),
        reason: json.reason ?? receipt.reason ?? run.reason ?? '',
        next_action: ok
          ? `已投递（收件人 ${json.to_domain ?? '（见偏好）'}）；下一封最早 ${json.next_allowed_at || '随时'}`
            + `；回执里 ledger_added=${json.ledger_added ?? 0}（摘要不写账本）`
          : (json.next_action ?? receipt.next_action ?? '看服务日志里这一条工具的 stdout/stderr'),
        result: digestResult(json, staged, receipt) }
    } }))

  // ---- 状态栏：一行"我的摘要现在是什么状态"（未登录如实说不知道）----------------------------------------
  out.push(surface.statusItem({ plugin_id: me, id: 'status.mail-digest', title: '邮件摘要', order: 41,
    read: (ctx) => {
      const who = ctx?.identity ?? null
      if (!who) {
        return { text: '邮件摘要：按身份存（未登录 ⇒ 不知道读谁的那一条）', level: 'info',
          next_action: `登录后看你自己那条：${prefix}/identity/` }
      }
      const row = prefsEntryOf(asText(who.human))
      const st = digestStateOf(asText(who.human))
      if (!row || row.on !== true) {
        return { text: '邮件摘要：关（默认关）', level: 'info',
          next_action: '要打开：工作台「邮件摘要」面板行内「改摘要偏好」（开关 + 收件地址）' }
      }
      const last = asText(st?.last_sent_at)
      const failed = st && st.last_ok === false && asText(st.last_code) !== ''
      return { text: `邮件摘要：开 → ${domainOf(row.to)}`
          + (last ? ` · 上次 ${last}` : ' · 还没发过')
          + (failed ? ` · 上次尝试未发送（${asText(st.last_code)}）` : ''),
        level: failed ? 'warn' : 'ok',
        next_action: failed ? `看原因：工作台「邮件摘要」面板的「上一次」列` : '' }
    } }))

  return out
}

/** 纯函数样本（A5 确定性采样用；不读任何文件）。 */
export const fixture = {
  sampleOk: () => summarize({ transport: { smtp: { configured: true, available: true, reason: '' },
    imap: { configured: true, available: true, reason: '' },
    last_attempt: { kind: 'send', service: 'smtp', ok: true } } }),
  sampleDown: () => summarize({ transport: { smtp: { configured: false, available: false,
    reason: 'mail-smtp-unconfigured' }, imap: { configured: false, available: false,
    reason: 'mail-imap-unconfigured' }, last_attempt: null } }),
  sampleMissing: () => summarize(null),
}
