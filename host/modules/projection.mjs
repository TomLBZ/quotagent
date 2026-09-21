/**
 * 进树模块：`projection` —— **视角投影服务**（WebUI 与 canary 分流的共同入口）。
 *
 * 为什么要独立成插件（而不是留在 `webui.mjs` 里）：用户 2026-09-21 指令要求"每个功能都由插件提供"，
 * 且"每个功能模块可分别独立演进"。投影是**一条独立的业务功能**（谁看到什么字段），把它抽出来之后：
 *   · `webui` 只负责 HTTP 与路由，`inject: ['ledgerView', 'projection']`；
 *   · canary 分流可以作用在**这条真实请求路径**上（base=当前投影，候选=提案产出的投影），
 *     每次 UI 请求都会回灌样本给判定器（见 `host/lib/canary-dispatch.mjs`）。
 *
 * 私域纪律（`INV-008` / `AC-TRUST-001`）：投影是"私域不出 realm"的**视图**那一层；抑制行的原因
 * **对外必须通用**（键名只留服务端审计，实测过一次泄漏）。
 */
import { array, object, string } from '../lib/std-schema.mjs'

export const name = 'projection'

export const inject = []

export const builtin = []

export const usedServices = []

export const provides = ['projection']

export const Config = object({
  // 只有这些键能出现在对外视图里（字段白名单是**结构**，不是"记得别泄露"）
  fields: array(string()).default(['seq', 'type', 'correlation_id', 'actor', 'ts', 'summary']),
})

/** 视角规则：事件类型白名单 + 私域键拒收名单。 */
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

const summarize = (body) => {
  if (!body || typeof body !== 'object') return ''
  const keys = Object.keys(body).filter((key) => !key.toLowerCase().includes(PRIVATE_MARK))
  return keys.slice(0, 6).map((key) => {
    const value = body[key]
    // `typeof null === 'object'`：必须判空，否则 Object.keys(null) 抛错（实测：单个 null 字段曾让整个 UI 进程退出）
    const text = (value !== null && typeof value === 'object')
      ? `{${Object.keys(value).slice(0, 3).join(',')}}` : String(value)
    return `${key}=${text.slice(0, 40)}`
  }).join(' ')
}

/**
 * 投影 + **服务端审计**。抑制原因对外通用（`private-field-suppressed`）——把私域键名写进
 * 对方视角的响应里本身就是一次泄漏（实测踩到过：`reason: private:cost_floor`）。
 */
export function projectWithAudit(view, rows, { fields } = {}) {
  const rule = VIEW_RULES[view]
  if (!rule) throw new Error(`[unknown-view] ${view}`)
  const allow = fields ?? rule.fields
  const audit = []
  const publicRows = rows
    .filter((row) => rule.types.some((prefix) => String(row.type).startsWith(prefix)))
    .map((row) => {
      const out = {}
      for (const field of allow) {
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

export function project(view, rows, options) {
  return projectWithAudit(view, rows, options).publicRows
}

export function apply(ctx, config) {
  ctx.provide('projection', {
    rules: VIEW_RULES,
    fields: config.fields,
    project: (view, rows) => project(view, rows, { fields: config.fields }),
    projectWithAudit: (view, rows) => projectWithAudit(view, rows, { fields: config.fields }),
    summarize,
  })
}

/** A5 采样点：同一输入两次必须字节一致（纯函数投影）。 */
export const fixture = {
  sample: (handle) => ({
    contractor: handle.project('contractor', [
      { seq: 1, type: 'rfq/published', body: { package_id: 'pkg-1', cost_floor: 700 } },
      { seq: 2, type: 'quote/submitted', body: { quote_id: 'q-1' } },
    ]),
    supplier: handle.project('supplier', [
      { seq: 1, type: 'rfq/published', body: { package_id: 'pkg-1', cost_floor: 700 } },
      { seq: 2, type: 'quote/submitted', body: { quote_id: 'q-1' } },
    ]),
  }),
}
