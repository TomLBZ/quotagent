/**
 * 进树模块：`admin-guard` —— admin 道的**鉴权中间件插件**（token 提权 / 会话 / 有界冷却 / 统一拒绝）。
 *
 * 为什么是独立插件（而不是塞进 `webui.mjs`）：本仓纪律「项目的每个功能都由插件提供」（用户 2026-09-21）
 * 且「每个功能模块可分别独立演进」。鉴权是一条独立功能（谁能提权、会话活多久、失败怎么办），抽出来之后：
 *   · `webui` 只负责路由与 `Set-Cookie` 的落位（把本插件当**中间件**用，与 `webui.mjs` 里 `governor`
 *     包住 handler 的写法同形）；
 *   · 会话/冷却/统一拒绝的语义可以被独立围栅（`host/t271-admin-gate.mjs`），**不依赖 HTTP 也能跑**；
 *   · 会话表随 fiber 回收（零残留），不落任何文件、不写任何账本。
 *
 * 硬边界（复用既有纪律，不新开口子）：
 *   · **宿主不写账本（H1）**：本插件没有任何账本路径 —— 静态断言扫描源码里「追加/写文件/子进程/账本服务」
 *     这几类 API 名，一个都不许出现（见 `host/t271-admin-gate.mjs` 的静态负控）；
 *   · **统一拒绝**：缺 token / 错 token / 会话过期 / 未启用 / 冷却中 **五类同形** —— 同一个 HTTP 状态、
 *     同一个 `body` 字符串（逐字节相同）。`reason` 只给宿主日志与门，**不得进响应体**：区分原因就等于
 *     对外提供 oracle（「这个 token 差点对了」「这个道没配」都是可探测信息）；
 *   · **无暗门**：不存在「超时自动批准 / 等待即成功 / 冷却结束自动提权」的路径。冷却结束只回到
 *     「可以再次提交」，会话过期只**减权**（`authorized()` 一律回拒），没有任何时间驱动的增权分支；
 *     进入冷却是**减权**事件：已提权会话一并作废（作废后必须重新提交 token 才有会话）；
 *   · **token 四处不出现**：`stats()` / `config()` 只给计数与来源标签，连 `sha256(token)` 的摘要都不给
 *     （摘要也是可离线爆破的派生）。调用方不得把 `reason`、`session_id` 之外的任何东西写进响应体。
 *
 * token 校验（**先归一、再恒定时间比较**）：
 *   · 归一：`sha256(提交值)` → **定长 32 字节**；配置值同样先归一（比较的两个操作数长度恒等）；
 *   · 比较：`crypto.timingSafeEqual(a, b)` —— 因为两侧都是 32 字节摘要，既不存在「长度不同就早退」，
 *     也不存在「首字符位置」的可测差异（与 `docs/design/08-trust-and-security.md` §6 的密钥纪律同源：
 *     只比较不可逆摘要，不比较原文）；
 *   · 来源：环境变量（默认 `QUOTAGENT_ADMIN_TOKEN`）或 **0600 文件**（绝对路径）。两者都没有 = **未启用**；
 *     未启用仍然走同一拒绝体 —— 不给「这个道存在但没配」这种可探测差异。
 *
 * 契约（`provides: ['adminGuard']`，`inject: []`，纯内存、零事件）：
 *   `elevate(token)` → `{ok:true, session_id, expires_at, max_age_ms, cookie}` 或统一拒绝对象；
 *   `authorized(req)` → `{ok:true, session_id, expires_at, views}` 或统一拒绝对象；
 *   `switchAllowed(view)` → `{ok:true, to}` 或 `{ok:false, reason, allowed}`（**只做白名单**，不代取目标道内容）；
 *   `logout(req)` → 主动降权（会话作废，只减权）；
 *   `unauthorized()` → 固定拒绝三元组 `{status, body, headers}`（路由层照抄即可，避免第二份字面量）；
 *   `stats()` / `config()` → 只读；`setClock(fn)` → 注入假时钟（默认 `Date.now`，全文件只此一处读墙钟）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { array, number, object, string } from '../lib/std-schema.mjs'

export const name = 'admin-guard'
export const inject = []                 // 纯鉴权：不取任何服务，也不依赖 HTTP
export const builtin = []                // 不使用事件（声明即事实：源码里没有任何事件引用的双向断言）
export const usedServices = []
export const provides = ['adminGuard']

export const Config = object({
  token_env: string().default('QUOTAGENT_ADMIN_TOKEN'),
  token_file: string().default(''),          // 0600 文件的**绝对路径**；'' = 不使用文件来源
  cookie_name: string().default('qa_admin'),
  route_prefix: string().default('/quotagent'),
  session_ttl_ms: number().default(1800000), // 30 分钟（过期只减权）
  max_sessions: number().default(8),         // 会话表**有界**（超上限丢最早的，不是丢最新的）
  failure_threshold: number().default(5),    // 连续失败达阈值 → 进入冷却
  cooldown_ms: number().default(30000),
  max_cooldown_ms: number().default(300000), // 冷却**有界**：单次冷却时长不超过它
  views: array(string()).default(['contractor', 'supplier', 'ops', 'admin']),
})

/** 统一拒绝体：五类失败**逐字节相同**（固定 401 体，无区分字段）。路由层照抄，不要自己拼第二份。 */
export const UNAUTHORIZED_STATUS = 401
export const UNAUTHORIZED_BODY = '{"error":"unauthorized"}'
export const UNAUTHORIZED_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 拒绝原因码（闭合集合；**只给宿主日志与门**，不得进响应体 —— 它是 oracle 的形状）。 */
export const DENY_REASONS = ['not-enabled', 'token-missing', 'token-mismatch', 'session-missing',
  'session-expired', 'cooldown']

/** sha256 归一 → **定长 32 字节** Buffer（两侧长度恒等，故恒定时间比较不受长度影响）。 */
const digestOf = (value) => createHash('sha256')
  .update(typeof value === 'string' ? value : String(value ?? ''), 'utf8')
  .digest()

/** 恒定时间比较：两个操作数都是 sha256 摘要（恒 32 字节），不含任何长度或首字符位置的短路判断。 */
const sameDigest = (left, right) => timingSafeEqual(left, right)

/** 配置夹取：非有限数回落默认，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 从 0600 文件读 token（**严格**：模式不是 0600 就当不可用 → 仍走统一拒绝体）。 */
const readTokenFile = (path) => {
  if (!path) return { source: 'none', value: '' }
  if (!existsSync(path)) return { source: 'file-missing', value: '' }
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) return { source: 'file-insecure-mode', value: '' }
    const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    return value ? { source: 'file', value } : { source: 'file-empty', value: '' }
  } catch (err) {
    return { source: 'file-unreadable', value: '' }
  }
}

/** 取 Cookie 头里的一个值（只按 `名字=值` 拆，不做任何解码：会话 id 是 base64url，无需解码）。 */
const cookieValue = (req, cookieName) => {
  const header = String(req?.headers?.cookie ?? '')
  for (const raw of header.split(';')) {
    const pair = raw.split('=')
    if (pair.length !== 2) continue
    if (pair[0].trim() === cookieName) return pair[1].trim() || null
  }
  return null
}

export function apply(ctx, config) {
  const cfg = isPlain(config) ? config : {}
  const envName = String(cfg.token_env ?? 'QUOTAGENT_ADMIN_TOKEN')
  const tokenFile = String(cfg.token_file ?? '')
  const cookieName = String(cfg.cookie_name ?? 'qa_admin')
  const prefix = String(cfg.route_prefix ?? '/quotagent').replace(/\/$/, '')
  const adminPath = `${prefix}/admin`
  const ttl = clampInt(cfg.session_ttl_ms, 1800000, 1, 86400000)
  const maxSessions = clampInt(cfg.max_sessions, 8, 0, 256)
  const threshold = clampInt(cfg.failure_threshold, 5, 1, 1000)
  const cooldownWindow = Math.min(clampInt(cfg.cooldown_ms, 30000, 0, 86400000),
    clampInt(cfg.max_cooldown_ms, 300000, 0, 86400000))
  const views = Array.isArray(cfg.views)
    ? cfg.views.filter((item) => typeof item === 'string' && item !== '') : []

  // 配置值只在构造时解析一次：环境变量优先，其次 0600 文件；两者都没有 → 未启用（仍走统一拒绝体）
  const configured = (() => {
    const fromEnv = typeof process.env[envName] === 'string' ? process.env[envName] : ''
    if (fromEnv) return { source: 'env', value: fromEnv }
    return readTokenFile(tokenFile)
  })()
  const expected = configured.value ? digestOf(configured.value) : null
  const enabled = expected !== null

  let clock = () => Date.now()                  // 默认时钟（全文件唯一一处读墙钟；门里用 setClock 注入假时钟）
  const sessions = new Map()                    // 会话表在内存（有界、可过期、随 fiber 回收）
  let failures = 0
  let cooldownUntil = null
  const counters = { elevated: 0, refused: 0, cooldowns: 0, sessions_expired: 0, dropped_by_bound: 0,
    dropped_by_cooldown: 0 }

  const nowMs = () => Number(clock())
  const cooldownActive = () => cooldownUntil !== null && nowMs() < cooldownUntil

  const deny = (reason) => ({ ok: false, reason, status: UNAUTHORIZED_STATUS, body: UNAUTHORIZED_BODY,
    headers: { ...UNAUTHORIZED_HEADERS } })

  /** 丢弃已过期会话（只影响计数，不产生任何增权效果）。 */
  const prune = () => {
    for (const [id, session] of sessions) {
      if (nowMs() >= session.expires_at) {
        sessions.delete(id)
        counters.sessions_expired += 1
      }
    }
  }

  /** 记一次失败；达标即进入冷却（**有界**：时长 = min(cooldown_ms, max_cooldown_ms)）。 */
  const registerFailure = () => {
    counters.refused += 1
    failures += 1
    if (failures >= threshold) {
      failures = 0
      counters.cooldowns += 1
      cooldownUntil = nowMs() + cooldownWindow
      // 冷却是一个**减权**事件：连已提权会话一并作废。否则「冷却结束后旧会话又自动可用」＝
      // 时间驱动的增权（本仓纪律：过期只减权不增权）；作废后必须**重新提交** token 才有会话。
      const dropped = sessions.size
      sessions.clear()
      counters.dropped_by_cooldown += dropped
    }
  }

  /**
   * 提权：**只有提交了正确 token** 才会走到成功分支。冷却期内正确 token 也拒（且不延长冷却）。
   */
  const elevate = (submitted) => {
    if (!enabled) return deny('not-enabled')                      // 未配置 = 未启用
    if (cooldownActive()) return deny('cooldown')                 // 冷却中：正确 token 也拒（不计数、不延长）
    if (typeof submitted !== 'string' || submitted === '') {
      registerFailure()
      return deny('token-missing')
    }
    if (!sameDigest(digestOf(submitted), expected)) {
      registerFailure()
      return deny('token-mismatch')
    }
    // —— 成功分支：不读时间做任何授权判断，时间只用于会话寿命 ——
    failures = 0
    cooldownUntil = null
    const sessionId = randomBytes(24).toString('base64url')        // 192 bit 不透明 id，与 token 无派生关系
    const issued = nowMs()
    sessions.set(sessionId, { created_at: issued, expires_at: issued + ttl })
    counters.elevated += 1
    while (sessions.size > maxSessions) {                          // 有界：丢**最早创建**的，不丢刚发的
      let oldest = null
      for (const [id, session] of sessions) {
        if (oldest === null || session.created_at < oldest[1].created_at) oldest = [id, session]
      }
      sessions.delete(oldest[0])
      counters.dropped_by_bound += 1
    }
    return { ok: true, session_id: sessionId, expires_at: issued + ttl, max_age_ms: ttl,
      cookie: `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=${adminPath}` }
  }

  /**
   * 会话级准入（只读道：面板可见性与切道）。冷却期内**连已提权的会话也不通过**
   * ——「冷却不产生任何面板内容」（真要求：冷却只减权，不产生任何成功）。
   */
  const authorized = (req) => {
    if (!enabled) return deny('not-enabled')
    if (cooldownActive()) return deny('cooldown')
    const sessionId = cookieValue(req, cookieName)
    if (!sessionId) return deny('session-missing')
    const session = sessions.get(sessionId)
    if (!session || nowMs() >= session.expires_at) {
      if (session) {
        sessions.delete(sessionId)
        counters.sessions_expired += 1
        return deny('session-expired')
      }
      return deny('session-missing')
    }
    return { ok: true, session_id: sessionId, expires_at: session.expires_at, views: [...views] }
  }

  /** 主动降权：删掉会话（只减权）。 */
  const logout = (req) => {
    const sessionId = cookieValue(req, cookieName)
    if (sessionId && sessions.delete(sessionId)) return { ok: true }
    return { ok: false, reason: 'session-missing' }
  }

  /**
   * 切道白名单：**只判名字**，返回目标路径；不代取目标道内容（切换不可能成为越权读取的通道）。
   * 管理员身份不改变任何字段白名单（切过去看到的内容与未提权时逐字节一致）。
   */
  const switchAllowed = (view) => {
    const target = String(view ?? '')
    if (!views.includes(target)) return { ok: false, reason: 'view-not-allowed', allowed: [...views] }
    return { ok: true, to: `${prefix}/${target}/` }
  }

  /** 固定拒绝三元组（路由层照抄：避免第二份字面量、也就不会有第二份形状）。 */
  const unauthorized = () => ({ status: UNAUTHORIZED_STATUS, body: UNAUTHORIZED_BODY,
    headers: { ...UNAUTHORIZED_HEADERS } })

  /** 只读统计：**不含 token，也不含它的任何派生**（连摘要都不给）。 */
  const stats = () => {
    prune()
    return {
      enabled,
      token_source: configured.source,          // 只给来源标签（env / file / file-missing / none …）
      sessions: sessions.size,
      max_sessions: maxSessions,
      session_ttl_ms: ttl,
      elevated: counters.elevated,
      refused: counters.refused,
      failures_consecutive: failures,
      cooldown_active: cooldownActive(),
      cooldown_until: cooldownActive() ? cooldownUntil : null,
      cooldowns: counters.cooldowns,
      sessions_expired: counters.sessions_expired,
      dropped_by_bound: counters.dropped_by_bound,
      dropped_by_cooldown: counters.dropped_by_cooldown,
      views: [...views],
      note: '只读统计：不给 token，也不给它的任何派生（连 sha256 摘要都不给）',
    }
  }

  /** 只读配置（同样不给 token 与其派生）。 */
  const configView = () => ({
    token_env: envName, token_file: tokenFile, cookie_name: cookieName, route_prefix: prefix,
    admin_path: adminPath, session_ttl_ms: ttl, max_sessions: maxSessions, failure_threshold: threshold,
    cooldown_ms: cooldownWindow, max_cooldown_ms: clampInt(cfg.max_cooldown_ms, 300000, 0, 86400000),
    views: [...views],
  })

  // 零残留：会话表随 fiber 回收（dispose 后 captured handle 上的会话计数必须归零）
  ctx.effect(() => () => {
    const dropped = sessions.size
    sessions.clear()
    failures = 0
    cooldownUntil = null
    return dropped
  })

  ctx.provide('adminGuard', {
    elevate, authorized, logout, switchAllowed, unauthorized, stats, config: configView,
    setClock: (impl) => { clock = typeof impl === 'function' ? impl : () => Date.now() },
  })
}

/**
 * fixture（A5 确定性采样）：**只调用不改变计数的 API** —— 未启用时全部走 `not-enabled`，
 * 启用时也只回「原因不同、形状相同」的拒绝体；因此同输入两次采样字节一致（不读墙钟、不随机）。
 */
export const fixture = {
  sample: (handle) => ({
    config: handle.config(),
    unauthorized: handle.unauthorized(),
    switch_ok: handle.switchAllowed('supplier'),
    switch_denied: handle.switchAllowed('not-a-view'),
    elevate_missing: handle.elevate(undefined),
    elevate_wrong: handle.elevate('not-the-token'),
    authorized_blank: handle.authorized({ headers: {} }),
  }),
}
