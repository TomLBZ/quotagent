/**
 * 冻结面与人工专属配置的**校验**（host 强制不变量 H5 / H10；ADR-0015）。
 *
 * 纯函数：`validate(schema, nextConfig, source, currentConfig) -> {by, reasons[], violations[]}`
 * 由配置宿主插件在 `internal/update` 瀑布里调用；返回非空 reasons 即否决
 * （调用方不调 `next()` → cordis 不会改配置、不会重启）。
 *
 * 规则：
 *   R1 `frozen: true` 的键**永不接受**（内核命名空间不可自改，INV-010）；
 *   R2 `humanOnly: true` 的键只接受 `source` 以 `human:` 开头的更新；
 *   R3 白名单外的键一律拒绝（`unknown-key`，不给"随便写"的口子）；
 *   R4 `enum` 取值必须命中。
 */
export const FROZEN_BY = 'frozen'

/** 展开成 `a.b.c` 路径（数组按整体处理）。 */
export const flattenPaths = (value, prefix = '') => {
  const out = {}
  for (const [key, item] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(out, flattenPaths(item, path))
    else out[path] = item
  }
  return out
}

/** 支持 `pricing.authorized_band`、`compare.weights.*` 这类通配键（最长前缀优先）。 */
export function lookup(schema, path) {
  if (schema[path]) return schema[path]
  let best = null
  for (const key of Object.keys(schema)) {
    if (key.endsWith('.*') && path.startsWith(key.slice(0, -1))) best = schema[key]
  }
  return best
}

export function validate(schema, nextConfig, source = 'unknown', currentConfig = null) {
  const reasons = []
  const violations = []
  const human = String(source).startsWith('human:')
  const before = flattenPaths(currentConfig ?? {})
  for (const [path, value] of Object.entries(flattenPaths(nextConfig))) {
    if (path in before && JSON.stringify(before[path]) === JSON.stringify(value)) continue   // 未改动
    const rule = lookup(schema, path)
    if (!rule) {
      reasons.push(`unknown-key:${path}（白名单外的键不得写入；H10）`)
      violations.push({ path, rule: 'unknown-key' })
      continue
    }
    if (rule.frozen) {
      reasons.push(`frozen:${path}（内核命名空间不可自改；INV-010）`)
      violations.push({ path, rule: 'frozen' })
      continue
    }
    if (rule.humanOnly && !human) {
      reasons.push(`human-only:${path}（source=${source} 不是 human:*；该类配置只能由人改）`)
      violations.push({ path, rule: 'human-only' })
    }
    if (rule.enum && value !== null && !rule.enum.includes(value)) {
      reasons.push(`out-of-enum:${path}=${JSON.stringify(value)}（允许 ${JSON.stringify(rule.enum)}）`)
      violations.push({ path, rule: 'out-of-enum' })
    }
  }
  return { by: FROZEN_BY, reasons, violations, source }
}
