/**
 * canary 探针与自动回滚的**编排**（T-235）。
 *
 * 为什么独立成文件（而非塞进 `cli.mjs`）：`cli.mjs` 是一个巨大的 `main()`，本轮在同一处连续 4 次踩到
 * **声明顺序 / TDZ**（`node --check` 抓不到，只有真跑才暴露）。把编排抽出来、**参数显式传入、结果显式返回**，
 * 从结构上消灭这类错误，也让这段逻辑可以被单测（见 `host/bridge-canary.mjs`）。
 *
 * 方向性纪律（ADR-0017 / D-021）：
 *   · **进入 canary 需要人工 `approval_ref`**（扩大上线面）——缺失即拒绝；
 *   · **退出/回滚不需要**（缩小上线面）——退化时自动执行，这是"机器可以自动踩刹车"。
 */
export class CanaryApprovalRequired extends Error {
  constructor(message = '进入 canary 需要人工引用（--canary-approval ap-NNNN）：ADR-0017 规定扩大上线面要人批准') {
    super(message)
    this.name = 'CanaryApprovalRequired'
    this.code = 'canary-approval-required'
  }
}

/** 探针分桶键：按索引变化，才能一次性采样两侧（实测：固定键的探针永远只落一条道 → 判定永远样本不足）。 */
export const probeKey = (method, i) => `probe:${method}:${i}`

/**
 * 跑一轮 canary：进（需批准）→ 探针 → 判定 → 退化则**自动回滚**。
 *
 * @param {object} o
 * @param {object} o.canary     canary 服务（enterCanary/exitCanary/decide）
 * @param {object} o.dispatch   bridge-canary 的句柄（call(method, params, opts)）
 * @param {string} o.method     被测方法名
 * @param {object} [o.params]   基础参数
 * @param {number} [o.probeCount] 探针次数（>1 才会两侧都有样本）
 * @param {string} [o.approval_ref] 人工引用（进入 canary 必需）
 * @param {string} [o.proposal_id]
 * @returns {{decision: object|null, exited: object|null, samples: {rounds:number, fallbacks:number}}}
 */
export function runCanary({ canary, dispatch, method, params = {}, probeCount = 1, approval_ref, proposal_id = null }) {
  if (!canary || typeof canary.enterCanary !== 'function') throw new Error('[canary-run] 需要 canary 服务')
  if (!dispatch || typeof dispatch.call !== 'function') throw new Error('[canary-run] 需要 dispatch 句柄')
  if (!/^ap-\d{4,}$/.test(String(approval_ref ?? ''))) throw new CanaryApprovalRequired()

  canary.enterCanary({ proposal_id: proposal_id ?? `bridge:${method}`, approval_ref })
  const rounds = Math.max(1, Number(probeCount) || 1)
  let fallbacks = 0
  let lastResult = null
  let lastLane = null
  for (let i = 0; i < rounds; i++) {
    const routed = dispatch.call(method, rounds > 1 ? { ...params, probe: i } : params,
      rounds > 1 ? { key: probeKey(method, i) } : {})
    if (routed?.fallback_used) fallbacks += 1
    lastResult = routed?.result ?? null
    lastLane = routed?.lane ?? null
  }
  const decision = typeof canary.decide === 'function' ? canary.decide() : null
  let exited = null
  if (decision?.action === 'rollback') {
    const reasons = decision.verdict?.reasons ?? []
    exited = canary.exitCanary({ reason: `auto-rollback:${reasons[0] ?? 'degraded'}` })
  }
  return { decision, exited, samples: { rounds, fallbacks }, last_result: lastResult, last_lane: lastLane }
}
