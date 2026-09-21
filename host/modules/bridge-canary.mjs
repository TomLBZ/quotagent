/**
 * 进树模块：`bridge-canary` —— 把 canary 分流接到**宿主→内核的真实调用路径**上。
 *
 * 与 `host/modules/kernel-bridge.mjs` 的分工：后者是**声明面**（暴露哪些方法、拒绝哪些方法）；
 * 本模块是**调用面的分流器**：宿主每一次真实的桥调用都可以按 canary 分桶决定"走 base 传输还是走候选实现"，
 * 并把真实结果（成功/失败、延迟、成本）回灌给 `canary` 的判定器。
 *
 * 为什么单独成模块、而不是塞进 kernel-bridge：
 *   · `kernel-bridge` 不该知道"上线策略"（单一职责，各自独立演进）；
 *   · canary 是可选的（生产可不挂），所以本模块 `inject: ['canary']` 只在确实要做 canary 的 profile 里装配。
 *
 * 失败隔离（与 `host/lib/canary-dispatch.mjs` 同一套语义，此处按调用面表达）：
 *   · 候选实现抛错 → 记 `ok:false` 并**回退 base**（调用方拿到正确答案，canary 拿到失败样本）；
 *   · base 抛错 → **原样抛出**（真实故障不得被"回退"掩盖）。
 *
 * **同形契约**：候选实现必须与 base 同签名、同返回结构。形不对不会在这里被抓住，而是在调用方炸出
 * TypeError（实测踩到：候选返回 `{jsonrpc,...}` 而 base 返回桥帧 `{n, p:{id,m,result}}` → 调用方读
 * `call.p.id` 直接崩）。因此接候选之前先用 `verify.sh bridge-canary` 的夹具验形状。
 */
import { array, object, string } from '../lib/std-schema.mjs'

export const name = 'bridge-canary'

export const inject = ['canary']

export const builtin = []

export const usedServices = ['canary']

export const provides = ['canary-dispatch']

export const Config = object({
  name: string().default('bridge-call'),          // 分桶键前缀（同一 profile 下可挂多个调用面）
  realm: string().default(''),                    // 分桶的 realm 维度
  methods: array(string()).default([]),           // 只对这些方法做分流；空 = 全部
})

export function apply(ctx, config) {
  const canary = ctx.canary
  const registry = { base: null, candidate: null, candidate_name: '' }
  const counters = { calls: 0, base: 0, canary: 0, fallbacks: 0, refused: 0 }

  const dispatched = (method) => config.methods.length === 0 || config.methods.includes(method)

  ctx.provide('canary-dispatch', {
    /** 注册 base 传输与（可选）候选实现。base 必须提供；候选缺失时全部走 base。 */
    register: ({ base, candidate, candidate_name = '' }) => {
      if (typeof base !== 'function') throw new Error('[dispatch-needs-base] 必须提供 base 传输函数')
      if (candidate !== undefined && candidate !== null && typeof candidate !== 'function') {
        throw new Error('[dispatch-needs-candidate] 候选实现必须是函数（或省略）')
      }
      registry.base = base
      registry.candidate = candidate ?? null
      registry.candidate_name = candidate_name
      return { has_candidate: Boolean(registry.candidate), candidate_name }
    },
    /**
     * 一次真实调用：分桶 → 调用 → 回灌样本。返回 `{lane, result, fallback_used}`。
     * 调用方**必须**看 `lane`（不得假设走了哪条道）。
     */
    call: (method, params) => {
      if (!registry.base) throw new Error('[dispatch-not-registered] 先 register({base})')
      if (!dispatched(method)) {
        counters.refused += 1
        counters.base += 1
        return { lane: 'base', result: registry.base(method, params), fallback_used: false, dispatched: false }
      }
      const lane = canary.bucket({ realm: config.realm, key: `${config.name}:${method}` })
      const impl = (lane === 'canary' && registry.candidate) ? registry.candidate : registry.base
      const actualLane = (lane === 'canary' && registry.candidate) ? 'canary' : 'base'
      let result
      let fallback = false
      try {
        result = impl(method, params)
      } catch (err) {
        if (actualLane === 'base') {
          canary.record({ lane: 'base', ok: false, latency_ms: 0, cost: 0 })
          throw err                                   // base 故障必须原样暴露
        }
        canary.record({ lane: 'canary', ok: false, latency_ms: 0, cost: 0 })
        counters.fallbacks += 1
        fallback = true
        result = registry.base(method, params)        // 候选故障：回退 base，调用方不受影响
        canary.record({ lane: 'base', ok: true, latency_ms: 0, cost: 0 })
      }
      if (!fallback) canary.record({ lane: actualLane, ok: true, latency_ms: 0, cost: 0 })
      counters.calls += 1
      counters[actualLane] += 1
      return { lane: actualLane, result, fallback_used: fallback, dispatched: true }
    },
    stats: () => ({ ...counters, name: config.name, realm: config.realm,
      has_candidate: Boolean(registry.candidate), candidate_name: registry.candidate_name }),
    methods: () => [...config.methods],
  })
}

/** A5 采样点：纯计数与配置，不含时间/随机（确定性）。 */
export const fixture = {
  sample: (handle) => ({ methods: handle.methods(), stats: { ...handle.stats(), calls: 0, base: 0, canary: 0 } }),
}
