/**
 * 进树模块：`config-view` —— **配置与凭据的可视面 + 干跑 + 待处理项落盘**（P0 配置/凭据 UI 化的宿主侧）。
 *
 * 用户要求（2026-09-21）："每个功能都由插件提供"。本模块提供 `configView` 服务，负责：
 *   · 三层总览（项目 / 插件 / 凭据）：每键给 `source`(default|file|env|runtime)、`shadowed_by`、`editable`；
 *   · 干跑 `preview()`：白名单 + 类型 + 人工门 + diff，**零落盘零生效**；
 *   · 提交 `submit*()`：只落 0600 待处理项（真落盘由 Python 侧 `tools/config-apply.py` 做）；
 *   · 凭据视图 `credentials()`：`configured/source/required_mode/fingerprint_first8/next_action`，
 *     **永不回显值**（指纹来自 Python 侧状态快照；本模块从不读凭据值）；
 *   · 审计视图 `audit()`：只读账本里 `config/*` 与 `credential/*` 行，按键白名单投影（不出正文）。
 *
 * 硬边界（H1 + G1，每条都有门看着）：
 *   · **零账本**：本模块没有任何账本写入路径（只 `readFileSync` 读）；
 *   · **不取墙钟、不随机**：待处理项里没有时间戳（时间由 Python 侧按 `--now` 落账）；幂等键 = 内容摘要；
 *   · **唯一写面**：`config_inbox`（0700 目录 / 0600 文件 / `.tmp.<pid>` + rename）——照抄 webui 既有形状；
 *   · **凭据只写不回显**：本模块没有"把凭据值渲染出来"的路径（连日志都不打字段值）。
 *
 * 生效语义（页面必须写出来，不许让用户踩坑）：
 *   · 项目配置 = 同进程 cordis 配置（热加载会**重启该插件 fiber**：接受即重置该模块的运行期状态）；
 *   · 插件配置 = 重载实例（新 uid，**草稿丢失**）；凭据 = 落 0600 文件后再触发 re-apply。
 *
 * 契约：`provides: ['configView']`，`inject: []`（纯函数 + 有界只读 I/O），`builtin: []`（不使用事件）。
 */
import { readFileSync } from 'node:fs'
import { number, object, string } from '../lib/std-schema.mjs'
import {
  CREDENTIALS, NEXT_ACTION, PROJECT_KEYS, credentialsView, envNameFor, pendingSummary,
  pluginView, previewPatch, projectView, readConfigFile, submitReceipt, writePendingItem,
} from '../lib/config-ui.mjs'

export const name = 'config-view'

export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['configView']

export const Config = object({
  route_prefix: string().default('/quotagent'),
  // 受管配置文件的**绝对路径**（生产 cwd≠仓库根）。默认值就是上手页告诉用户的那个路径 —— 不许让那句话变假。
  config_file: string().default('/workspace/config.yaml'),
  // 待处理项目录（宿主写这里；只有 Python 侧消费）。'' = 未配置 → 提交一律 503（不假装成功）
  config_inbox: string().default(''),
  // Python 侧写的**凭据状态快照**（只含 configured/source/指纹前 8 位；**不含值**）。'' = 未配置 → 指纹降级
  config_status: string().default(''),
  // 审计视图的只读账本（`config/*` 与 `credential/*` 行）。'' = 未配置 → 降级
  config_ledger: string().default(''),
  // 运行期覆盖（JSON 字符串；`source: 'runtime'` 且优先级最高）。''/非法 JSON = 没有运行期层
  runtime_overrides: string().default(''),
  max_keys: number().default(200),
  max_audit_rows: number().default(50),
})

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}
const AUDIT_PREFIXES = ['config/', 'credential/']
/** 审计行**按键白名单**投影：账本里的配置事件不含值，这里再兜一层（只出这些键）。 */
const AUDIT_KEYS = ['seq', 'type', 'ts', 'actor', 'layer', 'target', 'key_path', 'reason', 'old_digest',
  'new_digest', 'approval_ref', 'fingerprint_first8', 'keys', 'schema']

export function apply(ctx, config) {
  const cfg = isPlain(config) ? config : {}
  const routePrefix = String(cfg.route_prefix ?? '/quotagent').replace(/\/$/, '')
  const configFile = String(cfg.config_file ?? '/workspace/config.yaml')
  const inbox = String(cfg.config_inbox ?? '')
  const statusFile = String(cfg.config_status ?? '')
  const ledgerFile = String(cfg.config_ledger ?? '')
  const maxKeys = clampInt(cfg.max_keys, 200, 1, 2000)
  const maxAuditRows = clampInt(cfg.max_audit_rows, 50, 1, 500)
  const runtime = (() => {
    const raw = String(cfg.runtime_overrides ?? '')
    if (raw.trim() === '') return { configured: false, reason: 'runtime-overrides-unconfigured', value: {} }
    try {
      const parsed = JSON.parse(raw)
      if (!isPlain(parsed)) return { configured: false, reason: 'runtime-overrides-not-an-object', value: {} }
      return { configured: true, reason: '', value: parsed }
    } catch (err) { return { configured: false, reason: 'runtime-overrides-unparsable', value: {} } }
  })()

  // 有界的提交留痕（**不含字段值**）：给 stats()/门用；落账本由 Python 侧做（H1）。
  const history = []
  const counters = { previews: 0, refused_previews: 0, submissions: 0, duplicates: 0, write_failures: 0 }

  const doc = () => readConfigFile(configFile)

  /** 环境变量面：只**登记表里声明过的**变量名（值只用来判"设没设"与参与层合入，不进任何日志）。 */
  const envOf = () => {
    const out = {}
    for (const key of Object.keys(PROJECT_KEYS)) {
      const name = envNameFor(key)
      if (typeof process.env[name] === 'string') out[name] = process.env[name]
    }
    for (const key of Object.keys(CREDENTIALS)) {
      const name = CREDENTIALS[key].env
      if (name && typeof process.env[name] === 'string') out[name] = process.env[name]
    }
    return out
  }

  /** 三层总览（每键 source / shadowed_by / editable）。文件读不到 → degraded（不冒充健康）。 */
  const overview = () => {
    const read = doc()
    const env = envOf()
    const project = projectView({ doc: read.value ?? {}, env, runtime: runtime.value, maxKeys })
    const plugins = pluginView({ doc: read.value ?? {}, env, maxKeys })
    const credentials = credentialsView({ status: statusFile, inbox, env })
    const pending = pendingSummary(inbox)
    return {
      service: 'config-view',
      config_file: configFile,
      layers: ['project', 'plugin', 'credential'],
      project: project.rows, plugin: plugins.rows, credentials: credentials.rows,
      counts: { project: project.rows.length, project_total: project.total, plugins: plugins.rows.length,
        credentials: credentials.rows.length, pending: pending.count },
      source_semantics: {
        default: '没有任何文件/环境/运行期覆盖 → 显示登记表里的默认值',
        file: '值来自受管 YAML 的 project./plugins. 段',
        env: '值来自环境变量（约定：QUOTAGENT_CONFIG_<键路径大写，点/横线 → __>）',
        runtime: '值来自运行期覆盖（最高优先级）',
        shadowed_by: '被本行压住的层（逗号分隔；null = 没有被压住的层）',
      },
      runtime: { configured: runtime.configured, reason: runtime.reason, keys: Object.keys(runtime.value).sort() },
      pending: { configured: pending.configured, count: pending.count, reason: pending.reason },
      credential_status: credentials.snapshot,
      degraded: !read.ok,
      reason: read.ok ? '' : read.reason,
      next_action: read.ok ? '' : '确认 /workspace/config.yaml 存在且是本子集支持的 YAML（支持：嵌套映射/标量/简单列表/内联 {}/[]；不支持：锚点/多文档/块标量）',
      write_surface: { browser_writable: [`${routePrefix}/admin/api/config/**`, `${routePrefix}/admin/api/credentials/**`],
        note: '宿主只落 0600 待处理项；真落盘由 Python 侧 tools/config-apply.py 做；宿主不写文件（除待处理项）、不写账本' },
      note: '三层配置一屏；`source` 是**生效值**的来源，`shadowed_by` 是被它压住的层；凭据永不回显值',
    }
  }

  /** 干跑：零落盘零生效。`patch` 可以是 JSON 型（fields 带类型）或表单型（字符串，按同一套规则强转）。 */
  const preview = (patch) => {
    counters.previews += 1
    const read = doc()
    const out = previewPatch({ doc: read.value ?? {}, env: envOf(), runtime: runtime.value, patch })
    if (!out.accepted) counters.refused_previews += 1
    if (history.length < 256) {
      history.push({ kind: 'config/preview', layer: out.patch.layer, target: out.patch.target,
        accepted: out.accepted, vetoed_by: out.vetoed_by, reasons: out.reasons.map((item) => item.code) })
    }
    return { ...out, config_file: configFile, config_file_readable: read.ok,
      config_file_reason: read.ok ? '' : read.reason }
  }

  /** 提交（只落待处理项）：成功 → 202 回执；**回执里没有字段值**。 */
  const submit = (layer, target, fields, nextAction = NEXT_ACTION) => {
    if (inbox === '') return { ok: false, code: 'inbox-unconfigured',
      next_action: '服务未配置 config_inbox（宿主侧待处理目录）：本层不落任何件，也不假装成功' }
    const out = writePendingItem(inbox, { layer, target, fields })
    if (!out.ok) {
      counters.write_failures += 1
      return { ok: false, code: out.code, detail: out.detail, next_action: '写待处理项失败：检查 config_inbox 目录权限（0700/可写）' }
    }
    counters.submissions += 1
    if (out.code === 'duplicate') counters.duplicates += 1
    if (history.length < 256) {
      history.push({ kind: 'config/submitted', layer, target, request_id: out.request_id,
        duplicate: out.code === 'duplicate' })
    }
    return { ...submitReceipt(out, nextAction), layer, target }
  }

  const submitProject = ({ fields = {}, human_approval_ref = '' } = {}) => {
    const verdict = previewPatch({ doc: doc().value ?? {}, env: envOf(), runtime: runtime.value,
      patch: { layer: 'project', target: 'project', fields, human_approval_ref } })
    if (!verdict.accepted) {
      return { ok: false, code: 'preview-refused', vetoed_by: verdict.vetoed_by, reasons: verdict.reasons,
        next_action: '先修掉 reasons 里的问题（权威判定在 Python 侧；被拒的提交不落件）' }
    }
    return submit('project', 'project', fields)
  }

  const submitPlugin = (target, { fields = {}, human_approval_ref = '' } = {}) => {
    const verdict = previewPatch({ doc: doc().value ?? {}, env: envOf(), runtime: runtime.value,
      patch: { layer: 'plugin', target, fields, human_approval_ref } })
    if (!verdict.accepted) {
      return { ok: false, code: 'preview-refused', vetoed_by: verdict.vetoed_by, reasons: verdict.reasons,
        next_action: '先修掉 reasons 里的问题（被拒的提交不落件）' }
    }
    return submit('plugin', target, fields,
      `等待 Python 侧消费后由插件**重载**生效（新实例，草稿丢失）：${NEXT_ACTION}`)
  }

  const submitCredential = (name, value) => {
    if (!Object.prototype.hasOwnProperty.call(CREDENTIALS, name)) {
      return { ok: false, code: 'unknown-credential',
        next_action: '凭据名不在登记表内（不猜）：见 /quotagent/admin/api/credentials' }
    }
    if (typeof value !== 'string' || value === '') {
      return { ok: false, code: 'empty-value', next_action: '凭据值必须是非空字符串；提交后不可回读' }
    }
    const out = submit('credential', name, { value },
      '等待 Python 侧消费：值将落 0600 凭据文件（或由服务注入 env），账本只记 sha256 与指纹前 8 位；'
      + '宿主不回显该值（连提交回执里也没有）')
    // 成功回执里**只有** ok/next_action 与摘要：不回显任何字段
    return out.ok
      ? { ok: true, code: out.code, request_id: out.request_id, payload_sha256: out.payload_sha256,
        bytes: out.bytes, next_action: out.next_action }
      : { ok: false, code: out.code, next_action: out.next_action }
  }

  /** 凭据视图（不出值）。 */
  const credentials = () => credentialsView({ status: statusFile, inbox, env: envOf() })

  /** 审计视图：只读账本，只留 `config/*` 与 `credential/*`，按键白名单投影。 */
  const audit = () => {
    if (ledgerFile === '') {
      return { degraded: true, reason: 'config-ledger-unconfigured',
        next_action: '给模块配 config_ledger（Python 侧写配置事件的账本路径）；宿主只读、不写账本',
        source: 'Python 侧账本（宿主只读）', rows: [], total: 0, omitted: 0, projection: AUDIT_KEYS }
    }
    let lines = []
    try {
      lines = readFileSync(ledgerFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
    } catch (err) {
      return { degraded: true, reason: `config-ledger-unreadable:${String(err.code ?? '')}`,
        next_action: '先让 Python 侧落一份配置事件账本，或检查路径权限（宿主只读）',
        source: 'Python 侧账本（宿主只读）', rows: [], total: 0, omitted: 0, projection: AUDIT_KEYS }
    }
    const rows = []
    let matched = 0
    for (const line of lines) {
      let row = null
      try { row = JSON.parse(line) } catch (err) { continue }
      if (!row || typeof row !== 'object') continue
      const type = String(row.type ?? '')
      if (!AUDIT_PREFIXES.some((prefix) => type.startsWith(prefix))) continue
      matched += 1
      const body = isPlain(row.body) ? row.body : {}
      const flat = { seq: row.seq, type, ts: row.ts, actor: row.actor, ...body }
      const projected = {}
      for (const key of AUDIT_KEYS) if (Object.prototype.hasOwnProperty.call(flat, key)) projected[key] = flat[key]
      rows.push(projected)
    }
    const shown = rows.slice(-maxAuditRows)
    return { degraded: false, reason: '', source: 'Python 侧账本（宿主只读；账本事件不含值）',
      rows: shown, total: matched, omitted: matched - shown.length, projection: AUDIT_KEYS,
      next_action: '被拒的变更也会落一行 config/refused（reason 只给原因码）；凭据轮换只落 sha256 与指纹前 8 位' }
  }

  const stats = () => ({
    config_file: configFile, config_inbox: inbox, config_status: statusFile, config_ledger: ledgerFile,
    route_prefix: routePrefix,
    runtime_overrides: { configured: runtime.configured, reason: runtime.reason, keys: Object.keys(runtime.value).sort() },
    counters: { ...counters }, events: history.length,
    limits: { max_keys: maxKeys, max_audit_rows: maxAuditRows },
    credentials: Object.keys(CREDENTIALS).sort(),
    note: '只读汇总：不含任何凭据值，也不含它的任何派生（指纹只经凭据视图、且来自 Python 侧快照）',
  })

  ctx.provide('configView', { config: stats, overview, preview, submitProject, submitPlugin,
    submitCredential, credentials, audit, stats })

  // 零残留：本模块不持有外部资源（无定时器、无 socket、无缓存），dispose 只清内存留痕
  ctx.effect(() => () => {
    const released = history.length + counters.submissions
    history.length = 0
    return released
  })
}

/**
 * fixture（A5 确定性采样）：**只调只读接口**（不碰 counters、不依赖本机任何配置）——
 * `config_file` 指向一个不存在的路径 → 视图给出 degraded + 有名 reason，正好把"降级不冒充健康"的形态也钉住。
 */
export const fixture = {
  sample: (handle) => {
    const overview = handle.overview()
    const credentials = handle.credentials()
    const audit = handle.audit()
    return JSON.stringify({
      degraded: overview.degraded, reason: overview.reason, counts: overview.counts,
      sources: overview.project.map((row) => row.source), layers: overview.layers,
      shadowed: overview.project.map((row) => row.shadowed_by), editable: overview.project.map((row) => row.editable),
      credentials: credentials.rows.map((row) => ({ name: row.name, configured: row.configured,
        source: row.source, required_mode: row.required_mode, fingerprint_first8: row.fingerprint_first8,
        next_action_nonempty: typeof row.next_action === 'string' && row.next_action.length > 0 })),
      audit: { degraded: audit.degraded, reason: audit.reason, total: audit.total },
    })
  },
}
