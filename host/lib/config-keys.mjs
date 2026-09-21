/**
 * 配置键登记表（**跨语言单一真源**）：项目配置键 + 凭据项。
 *
 * 为什么单独一个文件：`tools/config-apply.py`（Python 侧唯一落盘者）也要判"键在不在允许集内 / 类型对不对"。
 * 若两边各写一份，一定会漂移（这正是 `docs/work/plans/config-凭据UX规格.md.txt` §7-4 的未决项）。
 * 因此本文件用**严格规整的字面量写法**（一行一键、`type`/`default` 固定顺序），Python 侧按行解析同一份文件；
 * 门 `tools/check-config-route.py` 另有两条断言看着这件事：
 *   ① 两侧对同一份 YAML 夹具的解析结果必须逐字节一致；
 *   ② 本文件的 `default` 与 `host/profiles.mjs` 里同名键的字面量必须相等（默认值不许两处不同）。
 *
 * 纪律：
 *   · `default` 是**默认层**的值（source=default 时页面显示的就是它）；它必须与 profile 内联配置一致；
 *   · 本文件**不含任何凭据值**，凭据项只登记"放哪里"（env 名 / 文件路径 / 必须的权限）；
 *   · 没有登记键 = 不认识的键 = 一律拒（`unknown-key`），不猜、不默认。
 */

/** 项目配置键（`layer: 'project'`）：键 = 点分键路径，值 = 该键的类型与默认值。 */
export const PROJECT_KEYS = {
  'approval.queue.enabled': { type: 'boolean', default: true, note: '人工门队列开关（humanOnly：只能由人改）' },
  'approval.auto_approve': { type: 'boolean', default: false, note: '自动批准开关（humanOnly；默认关）' },
  'commitments.require_human': { type: 'boolean', default: true, note: '承诺类动作必须过人（humanOnly）' },
  'compare.weights.price': { type: 'number', default: 0.6, note: '比价权重：价格' },
  'compare.weights.delivery': { type: 'number', default: 0.15, note: '比价权重：交期' },
  'compare.weights.payment': { type: 'number', default: 0.1, note: '比价权重：付款条件' },
  'compare.weights.warranty': { type: 'number', default: 0.05, note: '比价权重：质保' },
  'compare.weights.deviation': { type: 'number', default: 0.1, note: '比价权重：偏差' },
  'pricing.markup_pct': { type: 'number', default: 12.0, note: '策略加价（可改）' },
  'pricing.authorized_band.min_unit_price': { type: 'number', default: 80.0, note: '授权区间下沿（humanOnly）' },
  'pricing.authorized_band.max_unit_price': { type: 'number', default: 100.0, note: '授权区间上沿（humanOnly）' },
  'guard.abnormal_low_ratio': { type: 'number', default: 0.6, note: '异常低价护栏阈值（humanOnly）' },
  'norm.tolerance_bps': { type: 'integer', default: 5, note: '归一化容差（bps）' },
  'transport.kind': { type: 'string', default: 'file-drop', note: '投递通道类型' },
  'transport.dir': { type: 'string', default: 'inbox', note: '投递目录（相对路径）' },
  // ── 邮件接入点（凭据就位时才真收发；真源实现 src/quotagent/services/mail_transport.py）──────────
  // 本文件**只登记键与默认层**，永不登记值；每个键的环境变量覆盖名由 envNameFor() 给出
  // （本服务还额外认 QUOTAGENT_MAIL_SMTP_HOST 这类好记的写法，env 优先于本文件的 project 段）。
  'mail.smtp.host': { type: 'string', default: '', note: 'SMTP 主机（env QUOTAGENT_MAIL_SMTP_HOST 优先）' },
  'mail.smtp.port': { type: 'integer', default: 587, note: 'SMTP 端口（starttls 587 / ssl 465 / 明文 25）' },
  'mail.smtp.from': { type: 'string', default: '', note: 'SMTP 信封发件人（必填：没有发件人不发信）' },
  'mail.smtp.username': { type: 'string', default: '', note: 'SMTP 账号（留空 = 不做认证）' },
  'mail.smtp.password': { type: 'string', default: '', note: 'SMTP 口令（**优先用 env QUOTAGENT_MAIL_SMTP_PASSWORD**；写进本文件即明文落盘）' },
  'mail.smtp.security': { type: 'string', default: 'starttls', note: '握手方式：starttls / ssl / plain' },
  'mail.imap.host': { type: 'string', default: '', note: 'IMAP 主机（env QUOTAGENT_MAIL_IMAP_HOST 优先）' },
  'mail.imap.port': { type: 'integer', default: 993, note: 'IMAP 端口（ssl 993 / 明文 143）' },
  'mail.imap.username': { type: 'string', default: '', note: 'IMAP 账号（留空 = 不做认证）' },
  'mail.imap.password': { type: 'string', default: '', note: 'IMAP 口令（**优先用 env QUOTAGENT_MAIL_IMAP_PASSWORD**）' },
  'mail.imap.mailbox': { type: 'string', default: 'INBOX', note: 'IMAP 邮箱名（SELECT/EXAMINE 的目标）' },
  'mail.imap.security': { type: 'string', default: 'ssl', note: '握手方式：ssl / plain' },
  'mail.timeout_seconds': { type: 'integer', default: 5, note: '邮件连接/交互超时（秒）' },
  'mail.max_messages': { type: 'integer', default: 20, note: '一次收信最多取回几封（上限 50）' },
}

/**
 * 凭据项登记表（`layer: 'credential'`）：**只登记放哪里与要求的权限**，永不登记值。
 * `file` 为空 = 该项没有默认落点（由 Python 侧按 `--cred-dir` 落 0600 文件，路径进状态快照）。
 */
export const CREDENTIALS = {
  admin_token: { env: 'QUOTAGENT_ADMIN_TOKEN', file: '/workspace/config/quotagent-admin-token', required_mode: '0600', note: '平台管理员 token（提权用）' },
  mail_smtp: { env: 'QUOTAGENT_MAIL_SMTP', file: '', required_mode: '0600', note: '邮件 SMTP 凭据（未配置 → 传输报不可用）' },
  mail_imap: { env: 'QUOTAGENT_MAIL_IMAP', file: '', required_mode: '0600', note: '邮件 IMAP 凭据（未配置 → 入站不可用）' },
}

/** 三级配置层名（低 → 高）。页面的 `source` 取值域就是这套字面量。 */
export const LAYERS = ['default', 'file', 'env', 'runtime']

/** 键路径 → 环境变量名（覆盖用；一条约定，不需要逐键登记）：`QUOTAGENT_CONFIG_PRICING__MARKUP_PCT`。 */
export const envNameFor = (key) => `QUOTAGENT_CONFIG_${String(key).toUpperCase().replace(/[.-]/g, '__')}`

/** 键路径 → SCHEMA 匹配（最长前缀优先；`*` 只匹配一个段）。匹配不到 = 未登记键。 */
export const matchSchemaPattern = (key, schema) => {
  const segments = String(key).split('.')
  let best = null
  for (const pattern of Object.keys(schema || {})) {
    const parts = pattern.split('.')
    if (parts.length !== segments.length) continue
    let ok = true
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index] === '*') continue
      if (parts[index] !== segments[index]) { ok = false; break }
    }
    if (!ok) continue
    const specificity = parts.filter((part) => part !== '*').length
    if (best === null || specificity > best.specificity) best = { pattern, specificity, rule: schema[pattern] }
  }
  return best
}
