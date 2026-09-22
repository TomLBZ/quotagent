/**
 * host 侧配置层：**直接用 cordis 原生的 `fiber.update()` + `internal/update` 瀑布**（不重复造轮子）。
 *
 * 原生语义（读 node_modules/cordis/lib/index.js:1022 与 268-283 核对）：
 *   fiber.update(config) → `fiber.context.waterfall(fiber, 'internal/update', config, noSave, tail)`
 *   · 监听器签名 `(config, noSave, next)`；**不调 next() 即短路** → 链尾的
 *     `fiber.config = config; fiber.restart()` 不执行 →
 *     **配置不变、插件不重启**（这正是 FR-PLUGIN-004 要的"否决即不生效"）；
 *   · 走到链尾 → 配置生效并 `restart()`（以新配置重新 apply，激活代递增）。
 *
 * 本文件只提供：规范化摘要（用于机检"配置未变"）、gating 校验、以及把 state 暴露给 CLI 的插件壳。
 */
import { createHash } from 'node:crypto'
import { SCHEMA } from './schema.mjs'
import { validate } from '../lib/frozen.mjs'

export const UPDATE_EVENT = 'internal/update'

export const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

export const digestOf = (value) => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex')

export const flatten = (config, prefix = '') => {
  const out = {}
  for (const [key, value] of Object.entries(config || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flatten(value, path))
    else out[path] = value
  }
  return out
}

export const setPath = (target, path, value) => {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {})
  node[parts.at(-1)] = value
}

export const deletePath = (target, path) => {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) {
    if (!node?.[part]) return
    node = node[part]
  }
  delete node[parts.at(-1)]
}

/** 把 patch 合并进配置副本（提供 `null` 表示删除该键）。 */
export const mergePatch = (config, patch) => {
  const next = structuredClone(config)
  for (const [path, value] of Object.entries(flatten(patch))) {
    if (value === null) deletePath(next, path)
    else setPath(next, path, value)
  }
  return next
}

/**
 * 配置宿主插件：持有配置、注册可否决的更新守卫、把可观测状态写进 `state`。
 * @param {object} options
 * @param {object} options.state    调用方持有（CLI 用来读取结果）
 * @param {(config:object)=>boolean} [options.persist]
 * @param {string} [options.profile]
 */
export function makeConfigHostPlugin({ state, persist, profile }) {
  return {
    name: 'config-host',
    apply(ctx, config) {
      state.profile = profile
      state.epoch = (state.epoch ?? 0) + 1          // 每次 apply = 一次激活（restart 会 +1）
      state.uid = ctx.fiber.uid
      state.config = structuredClone(config)
      state.digest = digestOf(state.config)
      state.schema = state.schema ?? SCHEMA
      state.history = state.history ?? []

      // 可否决的更新守卫：违反冻结面/人工专属/白名单 → 不调 next()（短路）
      ctx.events.on(UPDATE_EVENT, (nextConfig, noSave, next) => {
        const verdict = validate(state.schema, nextConfig, state.pendingSource ?? 'unknown', state.config)
        state.lastVerdict = verdict
        if (verdict.reasons.length) {
          state.history.push({ accepted: false, source: state.pendingSource ?? 'unknown',
                               reasons: verdict.reasons, at_epoch: state.epoch })
          return verdict                              // ← 短路：配置不变、不 restart
        }
        state.history.push({ accepted: true, source: state.pendingSource ?? 'unknown', at_epoch: state.epoch })
        return next()                                 // ← 走到链尾：生效 + restart
      })

      // 一切注册可回退（ADR-0001 纪律 1）
      ctx.fiber.effect(() => {
        state.attached = true
        return () => { state.attached = false }
      })

      if (persist) persist(state.config)
    },
  }
}

/** 请求一次配置更新：返回机检友好的结果（含"是否重启/是否落盘"）。 */
export async function requestUpdate(fiber, state, patch, meta = {}) {
  const before = { digest: state.digest, epoch: state.epoch, config: structuredClone(state.config) }
  state.pendingSource = meta.source ?? 'unknown'
  state.pendingReason = meta.reason ?? ''
  state.lastVerdict = null
  const next = mergePatch(state.config, patch)
  await fiber.update(next)                            // cordis 原生入口
  const verdict = state.lastVerdict
  const vetoed = Boolean(verdict && verdict.reasons.length)
  return {
    accepted: !vetoed,
    vetoed_by: vetoed ? verdict.by : null,
    reasons: vetoed ? verdict.reasons : [],
    digest_before: before.digest,
    digest_after: state.digest,
    epoch_before: before.epoch,
    epoch_after: state.epoch,
    restarted: before.epoch !== state.epoch,
    config_file_written: !vetoed && state.persist_happened === true
      ? true
      : (!vetoed && Boolean(state.persistedDigest === state.digest)),
    file_written: !vetoed,
  }
}
