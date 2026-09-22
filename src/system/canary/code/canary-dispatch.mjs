/**
 * canary 的**真实入口接线**（`ADR-0017 §4` 的已知限制 → 本文件把它接上）。
 *
 * 分工：
 *   · `host/modules/canary.mjs` —— 分流与判定的**语义**（纯逻辑，可单测）；
 *   · 本文件 —— 把语义接到真实请求路径：**按 key 选实现 → 调用 → 记录样本 → 失败时回退**。
 *
 * 三条纪律：
 *   1) **候选实现失败不得把调用方拖下水**：候选抛错时记 `ok:false` 并**回退到 base**（`fallback_used: true`）；
 *      但 base 自己抛错必须**原样抛出**——否则真实故障会被"回退"掩盖（负控见 `host/canary-dispatch.mjs`）。
 *   2) **记录的是真实结果**：`ok` 由调用是否成功决定，`latency_ms`/`cost` 由调用方给或由计时得出；
 *      绝不由实现自报"我很好"（门信号纪律）。
 *   3) **默认零影响**：weight=0 时全部走 base，输出与未接线时**字节一致**（升级路径安全）。
 */

/** 计时用注入的 clock，便于测试确定性（默认 `() => 0`，生产传 `process.hrtime.bigint`）。 */
export const makeDispatcher = ({ canary, realm, name, clock = () => 0, cost = () => 0 }) => {
  if (!canary?.bucket) throw new Error('[dispatch-cannot-bucket] 需要 canary 服务（含 bucket()）')
  if (!canary?.record) throw new Error('[dispatch-cannot-record] 需要 canary 服务（含 record()）')
  let calls = 0
  let fallbacks = 0

  /**
   * 包一个实现对：`keyOf(input)` 决定分桶键，`base` 与 `candidate` 是**同形**实现（同入参、同出参）。
   * 返回的函数返回 `{lane, result, fallback_used}`——调用方必须显式看 lane，不得假设走了哪条道。
   */
  const wrap = ({ base, candidate, keyOf = (input) => input?.key ?? 'default' }) => {
    if (typeof base !== 'function') throw new Error('[dispatch-needs-base] 必须有 base 实现')
    if (typeof candidate !== 'function') throw new Error('[dispatch-needs-candidate] 必须有候选实现')
    return (input) => {
      const lane = canary.bucket({ realm, key: `${name}:${keyOf(input)}` })
      const impl = lane === 'canary' ? candidate : base
      const started = clock()
      let result
      let ok = true
      let fallbackUsed = false
      try {
        result = impl(input)
      } catch (err) {
        if (lane !== 'canary') {
          // base 抛错 = 真实故障：如实记录后**原样抛出**（不得静默回退，否则故障被掩盖）
          canary.record({ lane: 'base', ok: false, latency_ms: Number(clock() - started), cost: cost(input) })
          throw err
        }
        // 候选抛错 = canary 的问题：记录 + 回退 base（故障隔离）
        ok = false
        fallbackUsed = true
        fallbacks += 1
        canary.record({ lane: 'canary', ok: false, latency_ms: Number(clock() - started), cost: cost(input) })
        result = base(input)
      }
      if (fallbackUsed) {
        // 回退那一跑也算 base 的样本（它确实是 base 在提供服务）
        canary.record({ lane: 'base', ok: true, latency_ms: Number(clock() - started), cost: cost(input) })
      } else {
        canary.record({ lane, ok, latency_ms: Number(clock() - started), cost: cost(input) })
      }
      calls += 1
      return { lane, result, fallback_used: fallbackUsed }
    }
  }

  return { wrap, stats: () => ({ name, realm, calls, fallbacks }) }
}
