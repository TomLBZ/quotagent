/**
 * 进树模块 2/3：`norm`（归一化口径：容差与单位换算的宿主侧条目）。
 *
 * 与 `kernel-bridge` 同样的 manifest 形状与 A1..A6 约束；这里额外体现"跨模块只经
 * provided service 与声明的事件"（A6：模块目录内不得出现指向别的模块目录的相对 import）。
 */
import { constant, number, object } from '../lib/std-schema.mjs'

export const name = 'norm'

export const inject = []          // 无外部依赖（`events` 是内建 mixin，不进 inject）

export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const provides = ['norm']

export const usedServices = []

export const Config = object({
  tolerance_bps: number().default(5),
  enforce_tolerance: constant(true),               // const 键：不得翻转（A3 负控）
})

/** 纯函数：可复算、无墙钟、无自增序号（A5）。 */
export function convert(qty, factor) {
  return { qty: Number(qty), factor: Number(factor), base: Number(qty) * Number(factor) }
}

export function apply(ctx, config) {
  ctx.effect(() => () => { /* 无外部资源：A2 要求 dispose 后计数差分全 0 */ })
  ctx.provide('norm', {
    config: () => ({ ...config }),
    /** 容差判定：越界必须显式拒绝（不静默通过）。 */
    check: (declared, offered) => {
      const delta = Math.abs(Number(offered) - Number(declared))
      const limit = Number(declared) * Number(config.tolerance_bps) / 10000
      if (delta > limit) {
        throw new Error(`[tolerance-exceeded] 声明 ${declared} / 报价 ${offered} 超出 ${config.tolerance_bps} bps`)
      }
      return true
    },
    convert,
  })
}

export function disposer() {
  return () => {}
}
