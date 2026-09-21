/**
 * 进树模块 3/3：`compare`（消费者条目：取用 `norm` 与 `bridge` 两个 provided service）。
 *
 * 它演示**跨模块只经 provided service**：通过 `inject` 取 `norm`，绝不 `import` 别的模块目录（A6）。
 */
import { constant, number, object } from '../lib/std-schema.mjs'

export const name = 'compare'

export const inject = ['norm']   // 只经 provided service 跨模块（`events` 是内建 mixin）

export const builtin = ['events']

export const provides = ['compare']

export const usedServices = ['norm']

export const Config = object({
  weights: object({
    price: number().default(0.6),
    delivery: number().default(0.15),
    payment: number().default(0.1),
    warranty: number().default(0.05),
    deviation: number().default(0.1),
  }),
  deterministic: constant(true),                     // const 键：不得翻转（A3 负控）
})

export function apply(ctx, config) {
  let flagged = 0
  ctx.effect(() => () => { flagged = 0 })
  ctx.provide('compare', {
    config: () => ({ ...config }),
    /** 归一化 → 折算（用 `norm` 的服务，不用 import）。 */
    normalize: (rows) => rows.map((row) => ({
      ...ctx.norm.convert(row.qty, row.factor),
      item_id: row.item_id,
    })),
    /** 护栏：超容差即标 Flag（**只标注、不否决**）。 */
    flag: (declared, offered) => {
      try {
        ctx.norm.check(declared, offered)
        return { ok: true, flags: [] }
      } catch (err) {
        flagged += 1
        return { ok: false, flags: [{ kind: 'tolerance', detail: String(err.message), requires_human: true }] }
      }
    },
    flagCount: () => flagged,
  })
}

export function disposer() {
  return () => {}
}
