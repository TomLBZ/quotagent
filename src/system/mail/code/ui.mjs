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
        `<p data-mail-channel="mechanism">这一块是**界面入口**：邮件通道不可用时，有权限的人在**这里**当场改好，`
        + `不必跳 <code>/admin/config/</code>（也不用提权）。提交后由既有唯一落盘者 `
        + `<code>config-apply.py</code> 落 YAML；<b>凭据（口令）永不回显</b>，也永远不经本页传输。</p>`
        + stateLine
        + `<h3>改配置（SMTP / IMAP）</h3>`
        + `<p><small>字段名就是配置键名（<code>mail.smtp.*</code> / <code>mail.imap.*</code>）；`
        + `服务端会**干跑**（白名单 + 类型 + 人工门 + diff）后再落盘。</small></p>`
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
        + `<p><small><b>权限</b>：只有**运维侧**身份能改（<code>/mail/config/</code> 的服务端一半校验：side=ops + `
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
